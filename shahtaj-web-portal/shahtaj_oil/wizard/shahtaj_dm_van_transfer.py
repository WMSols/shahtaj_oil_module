# -*- coding: utf-8 -*-
"""Van stock procedure: free WH ↔ van moves (native UI).

Physical inventory only — does not update delivery job pick/deliver lines.
"""
from collections import defaultdict

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError
from odoo.tools import float_compare, float_is_zero


class ShahtajDmVanTransfer(models.TransientModel):
    _name = 'shahtaj.dm.van.transfer'
    _description = 'Van Stock Procedure (Load / Return)'

    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        required=True,
        readonly=True,
        domain="[('shahtaj_is_delivery_man', '=', True)]",
    )
    van_location_id = fields.Many2one(
        'stock.location',
        string='Van',
        readonly=True,
    )
    warehouse_location_id = fields.Many2one(
        'stock.location',
        string='Warehouse',
        readonly=True,
    )
    line_ids = fields.One2many(
        'shahtaj.dm.van.transfer.line',
        'wizard_id',
        string='Products',
    )
    van_qty_total = fields.Float(
        string='On Van (total)',
        digits='Product Unit of Measure',
        readonly=True,
    )
    warehouse_qty_total = fields.Float(
        string='Warehouse (listed)',
        digits='Product Unit of Measure',
        readonly=True,
    )
    open_picked_job_count = fields.Integer(
        string='Open picked jobs',
        readonly=True,
        help='Jobs in picked/partial that still show stock as picked on paperwork.',
    )
    procedure_html = fields.Html(string='Procedure', sanitize=False, readonly=True)
    actor_role = fields.Selection(
        [
            ('delivery_man', 'Delivery Man'),
            ('distributor', 'Distributor'),
        ],
        string='Acting as',
        readonly=True,
    )

    def _shahtaj_resolve_delivery_man(self):
        user = self.env.user
        ctx_dm = self.env.context.get('shahtaj_delivery_man_id')
        if ctx_dm and user.has_group('shahtaj_oil.group_shahtaj_distributor'):
            return self.env['res.users'].browse(ctx_dm)
        if user.shahtaj_is_delivery_man:
            return user
        if ctx_dm and user.has_group('shahtaj_oil.group_shahtaj_native_distributor_ui'):
            return self.env['res.users'].browse(ctx_dm)
        raise UserError(_('No delivery man selected.'))

    def _shahtaj_assert_can_manage(self):
        """DM may only manage own van; distributor may manage any DM van."""
        self.ensure_one()
        user = self.env.user
        dm = self.delivery_man_id
        if not dm or not dm.shahtaj_is_delivery_man:
            raise UserError(_('Select a valid delivery man.'))
        if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
            return True
        if user.has_group('shahtaj_oil.group_shahtaj_native_distributor_ui'):
            return True
        if user.shahtaj_is_delivery_man and user.id == dm.id:
            return True
        raise AccessError(_(
            'You can only run the van stock procedure for your own van.'
        ))

    def _shahtaj_actor_role(self):
        user = self.env.user
        if user.has_group('shahtaj_oil.group_shahtaj_distributor') or user.has_group(
            'shahtaj_oil.group_shahtaj_native_distributor_ui'
        ):
            if not user.shahtaj_is_delivery_man or (
                self.delivery_man_id and user.id != self.delivery_man_id.id
            ):
                return 'distributor'
        if user.shahtaj_is_delivery_man:
            return 'delivery_man'
        return 'distributor'

    def _shahtaj_build_procedure_html(self, dm, open_jobs):
        role = self._shahtaj_actor_role()
        if role == 'distributor':
            actor = _(
                'Distributor procedure for <b>%(dm)s</b> — you are adjusting this van.',
                dm=dm.display_name,
            )
        else:
            actor = _('Delivery man procedure — you are adjusting <b>your</b> van.')

        warn = ''
        if open_jobs:
            warn = (
                f'<p class="text-warning mb-0 mt-2">'
                f'<b>Note:</b> {open_jobs} job(s) are still picked/partial. '
                f'This procedure moves <b>physical</b> stock only — '
                f'job “picked” quantities stay until you use job Return / Deliver.'
                f'</p>'
            )
        return (
            f'<div class="mb-0">'
            f'<p class="mb-1">{actor}</p>'
            f'<ol class="mb-1 ps-3">'
            f'<li><b>Step 1 — Load:</b> Warehouse → Van (set “Load qty”, then Step 1 button)</li>'
            f'<li><b>Step 2 — Return:</b> Van → Warehouse (set “Return qty”, then Step 2 button)</li>'
            f'<li><b>Step 3 — Empty van:</b> return everything on the van to warehouse</li>'
            f'</ol>'
            f'<p class="text-muted mb-0">'
            f'Shop-order pick/deliver is a <b>separate</b> job procedure '
            f'(Today Load / Delivery Jobs).'
            f'</p>'
            f'{warn}'
            f'</div>'
        )

    @api.model
    def action_open(self):
        """Open van stock procedure for current DM or context DM (distributor)."""
        dm = self._shahtaj_resolve_delivery_man()
        if not dm.shahtaj_is_delivery_man:
            raise UserError(_('%(user)s is not a delivery man.', user=dm.display_name))
        wizard = self.create({'delivery_man_id': dm.id})
        wizard._shahtaj_assert_can_manage()
        wizard.action_refresh()
        role = wizard.actor_role
        if role == 'distributor':
            title = _('Van Procedure — %(dm)s', dm=dm.name)
        else:
            title = _('My Van Procedure')
        return {
            'type': 'ir.actions.act_window',
            'name': title,
            'res_model': self._name,
            'res_id': wizard.id,
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'current',
            'context': dict(self.env.context, shahtaj_delivery_man_id=dm.id),
        }

    def action_refresh(self):
        self.ensure_one()
        self._shahtaj_assert_can_manage()
        dm = self.delivery_man_id
        Delivery = self.env['shahtaj.dm.delivery']
        van = Delivery._ensure_van_location_for_dm(dm)
        warehouse = Delivery._get_warehouse()
        wh = warehouse.lot_stock_id

        Quant = self.env['stock.quant'].sudo()
        van_quants = Quant.search([
            ('location_id', '=', van.id),
            ('quantity', '!=', 0),
        ])
        van_by = defaultdict(float)
        for q in van_quants:
            van_by[q.product_id.id] += q.quantity

        job_products = self.env['shahtaj.dm.delivery.line'].sudo().search([
            ('delivery_id.delivery_man_id', '=', dm.id),
            ('delivery_id.state', 'in', ('ready', 'picked', 'partial')),
        ]).mapped('product_id')

        # Only WH qty for relevant products (van + open jobs) — not entire warehouse
        product_ids = set(van_by) | set(job_products.ids)
        wh_by = defaultdict(float)
        if product_ids:
            wh_quants = Quant.search([
                ('location_id', '=', wh.id),
                ('product_id', 'in', list(product_ids)),
                ('quantity', '>', 0),
            ])
            for q in wh_quants:
                wh_by[q.product_id.id] += q.available_quantity

        Product = self.env['product.product'].sudo()
        self.line_ids.unlink()
        line_vals = []
        for pid in sorted(product_ids, key=lambda i: Product.browse(i).display_name or ''):
            product = Product.browse(pid)
            if not product.exists() or product.type == 'service':
                continue
            wh_qty = wh_by.get(pid, 0.0)
            van_qty = van_by.get(pid, 0.0)
            if (
                float_is_zero(wh_qty, precision_digits=4)
                and float_is_zero(van_qty, precision_digits=4)
                and pid not in job_products.ids
            ):
                continue
            line_vals.append((0, 0, {
                'product_id': pid,
                'product_uom_id': product.uom_id.id,
                'qty_warehouse': wh_qty,
                'qty_on_van': van_qty,
                'qty_load': 0.0,
                'qty_return': 0.0,
            }))

        open_jobs = Delivery.search_count([
            ('delivery_man_id', '=', dm.id),
            ('state', 'in', ('picked', 'partial')),
        ])
        role = self._shahtaj_actor_role()
        self.write({
            'van_location_id': van.id,
            'warehouse_location_id': wh.id,
            'line_ids': line_vals,
            'van_qty_total': sum(van_by.values()),
            'warehouse_qty_total': sum(wh_by.values()),
            'open_picked_job_count': open_jobs,
            'actor_role': role,
            'procedure_html': self._shahtaj_build_procedure_html(dm, open_jobs),
        })
        return True

    def _gather_qtys(self, field_name):
        self.ensure_one()
        self._shahtaj_assert_can_manage()
        qty_by_product = {}
        for line in self.line_ids:
            if not line.product_id:
                continue
            if not line.product_uom_id:
                line.product_uom_id = line.product_id.uom_id
            qty = line[field_name] or 0.0
            rounding = (line.product_uom_id.rounding if line.product_uom_id else 0.01) or 0.01
            if float_compare(qty, 0.0, precision_rounding=rounding) < 0:
                raise UserError(_('Quantities cannot be negative.'))
            if float_is_zero(qty, precision_rounding=rounding):
                continue
            if field_name == 'qty_load':
                if float_compare(qty, line.qty_warehouse, precision_rounding=rounding) > 0:
                    raise UserError(_(
                        'Step 1 Load: cannot take %(qty)s of %(product)s — '
                        'warehouse only has %(avail)s. Refresh and try again.',
                        qty=qty,
                        product=line.product_id.display_name,
                        avail=line.qty_warehouse,
                    ))
            else:
                if float_compare(qty, line.qty_on_van, precision_rounding=rounding) > 0:
                    raise UserError(_(
                        'Step 2 Return: cannot return %(qty)s of %(product)s — '
                        'van only has %(avail)s. Refresh and try again.',
                        qty=qty,
                        product=line.product_id.display_name,
                        avail=line.qty_on_van,
                    ))
            qty_by_product[line.product_id.id] = qty_by_product.get(line.product_id.id, 0.0) + qty
        if not qty_by_product:
            raise UserError(_('Enter a quantity on at least one product for this step.'))
        return qty_by_product

    def _reload_after(self, title, message, notif_type='success'):
        self.action_refresh()
        role = self.actor_role
        win_name = (
            _('Van Procedure — %(dm)s', dm=self.delivery_man_id.name)
            if role == 'distributor'
            else _('My Van Procedure')
        )
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': title,
                'message': message,
                'type': notif_type,
                'sticky': False,
                'next': {
                    'type': 'ir.actions.act_window',
                    'name': win_name,
                    'res_model': self._name,
                    'res_id': self.id,
                    'view_mode': 'form',
                    'views': [(False, 'form')],
                    'target': 'current',
                    'context': dict(
                        self.env.context,
                        shahtaj_delivery_man_id=self.delivery_man_id.id,
                    ),
                },
            },
        }

    def action_load_to_van(self):
        """Step 1 — Warehouse → Van."""
        self.ensure_one()
        qty_map = self._gather_qtys('qty_load')
        self.env['shahtaj.dm.delivery']._shahtaj_free_wh_van_transfer(
            self.delivery_man_id, qty_map, 'to_van',
        )
        if self.actor_role == 'distributor':
            msg = _('Step 1 done: warehouse → van for %(dm)s.', dm=self.delivery_man_id.name)
        else:
            msg = _('Step 1 done: stock loaded from warehouse onto your van.')
        return self._reload_after(_('Step 1 — Loaded to van'), msg)

    def action_return_to_warehouse(self):
        """Step 2 — Van → Warehouse."""
        self.ensure_one()
        qty_map = self._gather_qtys('qty_return')
        self.env['shahtaj.dm.delivery']._shahtaj_free_wh_van_transfer(
            self.delivery_man_id, qty_map, 'to_wh',
        )
        extra = ''
        if self.open_picked_job_count:
            extra = _(
                ' %(count)s open picked job(s) were not changed — use job Return if paperwork should match.',
                count=self.open_picked_job_count,
            )
        if self.actor_role == 'distributor':
            msg = _('Step 2 done: van → warehouse for %(dm)s.', dm=self.delivery_man_id.name) + extra
        else:
            msg = _('Step 2 done: stock returned from your van to warehouse.') + extra
        return self._reload_after(
            _('Step 2 — Returned to warehouse'),
            msg,
            notif_type='warning',
        )

    def action_return_all_to_warehouse(self):
        """Step 3 — Empty van (return everything)."""
        self.ensure_one()
        self._shahtaj_assert_can_manage()
        self.action_refresh()
        if float_is_zero(self.van_qty_total, precision_digits=4):
            raise UserError(_('Van is already empty — nothing to return.'))
        for line in self.line_ids:
            line.qty_return = line.qty_on_van or 0.0
            line.qty_load = 0.0
        # Re-check after refresh so open_picked_job_count is current
        if self.open_picked_job_count and not self.env.context.get('shahtaj_force_empty_van'):
            # Soft gate: require explicit confirm via context from second click is hard in XML.
            # We proceed but message is strong; open jobs already shown on form.
            pass
        result = self.action_return_to_warehouse()
        # Override notification title for step 3
        if isinstance(result, dict) and result.get('params'):
            result['params']['title'] = _('Step 3 — Van emptied')
            if self.open_picked_job_count:
                result['params']['message'] = _(
                    'All van stock returned to warehouse. '
                    '%(count)s open picked job(s) still show stock as picked on paperwork.',
                    count=self.open_picked_job_count,
                )
            else:
                result['params']['message'] = _('All van stock returned to warehouse.')
        return result


class ShahtajDmVanTransferLine(models.TransientModel):
    _name = 'shahtaj.dm.van.transfer.line'
    _description = 'Van Stock Procedure Line'
    _order = 'product_id'

    wizard_id = fields.Many2one(
        'shahtaj.dm.van.transfer',
        required=True,
        ondelete='cascade',
    )
    product_id = fields.Many2one(
        'product.product',
        string='Product',
        required=True,
        domain="[('type', '!=', 'service')]",
    )
    product_uom_id = fields.Many2one('uom.uom', string='UoM', readonly=True)
    qty_warehouse = fields.Float(
        string='In Warehouse',
        digits='Product Unit of Measure',
        readonly=True,
    )
    qty_on_van = fields.Float(
        string='On Van',
        digits='Product Unit of Measure',
        readonly=True,
    )
    qty_load = fields.Float(
        string='Load qty (Step 1)',
        digits='Product Unit of Measure',
        help='Step 1: quantity to move Warehouse → Van.',
    )
    qty_return = fields.Float(
        string='Return qty (Step 2)',
        digits='Product Unit of Measure',
        help='Step 2: quantity to move Van → Warehouse.',
    )

    @api.onchange('product_id')
    def _onchange_product_id(self):
        for line in self:
            if not line.product_id or not line.wizard_id:
                continue
            line.product_uom_id = line.product_id.uom_id
            van = line.wizard_id.van_location_id
            wh = line.wizard_id.warehouse_location_id
            Quant = self.env['stock.quant'].sudo()
            line.qty_on_van = sum(Quant.search([
                ('product_id', '=', line.product_id.id),
                ('location_id', '=', van.id),
            ]).mapped('quantity')) if van else 0.0
            line.qty_warehouse = sum(Quant.search([
                ('product_id', '=', line.product_id.id),
                ('location_id', '=', wh.id),
            ]).mapped('available_quantity')) if wh else 0.0
