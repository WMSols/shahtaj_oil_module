# -*- coding: utf-8 -*-
"""DM Today's Load: shop progress + van-first collective pick for the day."""
from collections import defaultdict

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_is_zero, float_round


class ShahtajDmTodayLoad(models.TransientModel):
    _name = 'shahtaj.dm.today.load'
    _description = 'DM Today Load Dashboard'

    load_date = fields.Date(
        string='Day',
        required=True,
        default=lambda self: fields.Date.context_today(self),
    )
    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        required=True,
        default=lambda self: self.env.user,
        readonly=True,
    )
    shop_line_ids = fields.One2many(
        'shahtaj.dm.today.load.shop',
        'wizard_id',
        string='Shop Progress',
    )
    pick_line_ids = fields.One2many(
        'shahtaj.dm.today.load.pick',
        'wizard_id',
        string='Pick Totals',
    )
    summary_html = fields.Html(
        string='Summary',
        sanitize=False,
    )
    shop_count = fields.Integer(string='Shops', readonly=True)
    total_still_to_pick = fields.Float(
        string='Still to Pick (all products)',
        digits='Product Unit of Measure',
        readonly=True,
    )
    van_qty_on_hand = fields.Float(
        string='On Van',
        digits='Product Unit of Measure',
        readonly=True,
        help='Total units currently on this delivery man van.',
    )
    warehouse_qty_available = fields.Float(
        string='Warehouse Available',
        digits='Product Unit of Measure',
        readonly=True,
        help='Free qty in the company warehouse for products needed today (plus anything already on van).',
    )
    stock_summary_html = fields.Html(
        string='Stock Summary',
        sanitize=False,
        readonly=True,
    )

    def _shahtaj_resolve_delivery_man(self):
        """Current user for DM; context override when distributor opens for a DM."""
        user = self.env.user
        ctx_dm = self.env.context.get('shahtaj_delivery_man_id')
        if ctx_dm and user.has_group('shahtaj_oil.group_shahtaj_distributor'):
            return self.env['res.users'].browse(ctx_dm)
        if user.shahtaj_is_delivery_man:
            return user
        if ctx_dm:
            return self.env['res.users'].browse(ctx_dm)
        return user

    def _shahtaj_get_van_location_for_dm(self, dm):
        return dm._shahtaj_get_van_location()

    def _shahtaj_get_warehouse_stock_location(self):
        warehouse = self.env['stock.warehouse'].search([
            ('company_id', '=', self.env.company.id),
        ], limit=1)
        return warehouse.lot_stock_id if warehouse else self.env['stock.location']

    def _shahtaj_qty_by_product_at_location(self, location, product_ids=None, free_qty=False):
        """Sum stock.quant by product at one location. free_qty = qty − reserved."""
        if not location:
            return {}
        domain = [
            ('location_id', '=', location.id),
            ('quantity', '!=', 0),
        ]
        if product_ids is not None:
            pids = list(product_ids)
            if not pids:
                return {}
            domain.append(('product_id', 'in', pids))
        fields_agg = ['quantity:sum']
        if free_qty:
            fields_agg.append('reserved_quantity:sum')
        rows = self.env['stock.quant'].sudo().read_group(
            domain, fields_agg, ['product_id'],
        )
        totals = {}
        for row in rows:
            product = row.get('product_id')
            if not product:
                continue
            qty = float(row.get('quantity') or 0.0)
            if free_qty:
                qty -= float(row.get('reserved_quantity') or 0.0)
            if qty:
                totals[product[0]] = qty
        return totals

    def _shahtaj_build_stock_summary_html(self, van_by_product, wh_by_product):
        """Compact two-column summary: Warehouse vs Van."""
        product_ids = sorted(set(van_by_product) | set(wh_by_product))
        if not product_ids:
            return (
                '<p class="text-muted mb-0">'
                'No warehouse or van stock for today\'s products yet.'
                '</p>'
            )
        Product = self.env['product.product'].sudo()
        rows = []
        for pid in product_ids:
            product = Product.browse(pid)
            wh = wh_by_product.get(pid, 0.0)
            van = van_by_product.get(pid, 0.0)
            if not wh and not van:
                continue
            rows.append(
                f'<tr>'
                f'<td>{product.display_name}</td>'
                f'<td class="text-end">{wh:g}</td>'
                f'<td class="text-end">{van:g}</td>'
                f'<td>{product.uom_id.name}</td>'
                f'</tr>'
            )
        if not rows:
            return (
                '<p class="text-muted mb-0">'
                'No warehouse or van stock for today\'s products yet.'
                '</p>'
            )
        return (
            '<table class="table table-sm table-striped mb-0">'
            '<thead><tr>'
            '<th>Product</th>'
            '<th class="text-end">Warehouse</th>'
            '<th class="text-end">On Van</th>'
            '<th>UoM</th>'
            '</tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table>'
        )

    def _shahtaj_today_load_delivery_domain(self, dm, day):
        """Jobs on Today Load — same set for Refresh and Confirm Pick."""
        return self.env['shahtaj.dm.delivery']._shahtaj_today_open_jobs_domain(dm, day)

    @api.model
    def action_open(self):
        """Menu / list header: open Today's Load for the current user."""
        dm = self._shahtaj_resolve_delivery_man()
        wizard = self.create({'delivery_man_id': dm.id})
        wizard.action_refresh()
        title = _("Today's Load")
        if dm != self.env.user:
            title = _("Today's Load — %s", dm.name)
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
        Delivery = self.env['shahtaj.dm.delivery']
        day = self.load_date or fields.Date.context_today(self)
        dm = self.delivery_man_id or self._shahtaj_resolve_delivery_man()

        deliveries = Delivery.search(
            self._shahtaj_today_load_delivery_domain(dm, day),
            order='scheduled_date, partner_id, id',
        )

        for delivery in deliveries:
            delivery.sudo()._sync_with_sale_order(ensure_visit_task=False)

        self.shop_line_ids.unlink()
        self.pick_line_ids.unlink()

        shop_vals = []
        product_agg = {}

        for delivery in deliveries:
            qty_ordered = sum(delivery.line_ids.mapped('qty_assigned'))
            qty_picked = sum(delivery.line_ids.mapped('qty_picked'))
            qty_delivered = sum(delivery.line_ids.mapped('qty_delivered'))
            qty_left = sum(
                max(l.qty_picked - l.qty_delivered, 0.0) for l in delivery.line_ids
            )
            still_pick = sum(
                max(l.qty_assigned - l.qty_picked, 0.0) for l in delivery.line_ids
            )
            ratio = 0.0
            if qty_picked > 0:
                ratio = (qty_delivered / qty_picked) * 100.0
            shop_vals.append((0, 0, {
                'delivery_id': delivery.id,
                'partner_id': delivery.partner_id.id,
                'sale_order_id': delivery.sale_order_id.id,
                'qty_ordered': qty_ordered,
                'qty_picked': qty_picked,
                'qty_delivered': qty_delivered,
                'qty_left_on_van': qty_left,
                'qty_still_to_pick': still_pick,
                'delivered_ratio': ratio,
            }))

            for line in delivery.line_ids:
                still = max(line.qty_assigned - line.qty_picked, 0.0)
                pid = line.product_id.id
                if pid not in product_agg:
                    product_agg[pid] = {
                        'product_id': pid,
                        'product_uom_id': line.product_uom_id.id,
                        'qty_ordered': 0.0,
                        'qty_picked': 0.0,
                        'qty_delivered': 0.0,
                        'qty_still_needed': 0.0,
                    }
                agg = product_agg[pid]
                agg['qty_ordered'] += line.qty_assigned
                agg['qty_picked'] += line.qty_picked
                agg['qty_delivered'] += line.qty_delivered
                agg['qty_still_needed'] += still

        pick_vals = []
        total_still = 0.0
        product_ids = set(product_agg.keys())

        van_loc = self._shahtaj_get_van_location_for_dm(dm)
        wh_loc = self._shahtaj_get_warehouse_stock_location()
        van_by_product = self._shahtaj_qty_by_product_at_location(van_loc, free_qty=False)
        product_ids |= set(van_by_product.keys())
        wh_by_product = self._shahtaj_qty_by_product_at_location(
            wh_loc, product_ids=product_ids, free_qty=True,
        )
        free_van = Delivery._shahtaj_unattributed_van_qty_map(dm, product_ids)

        for pid in sorted(product_ids):
            agg = product_agg.get(pid) or {
                'product_id': pid,
                'product_uom_id': self.env['product.product'].browse(pid).uom_id.id,
                'qty_ordered': 0.0,
                'qty_picked': 0.0,
                'qty_delivered': 0.0,
                'qty_still_needed': 0.0,
            }
            still = agg['qty_still_needed']
            total_still += still
            if (
                still <= 0
                and agg['qty_picked'] <= 0
                and agg['qty_ordered'] <= 0
                and van_by_product.get(pid, 0.0) <= 0
            ):
                continue
            product = self.env['product.product'].browse(pid)
            rounding = product.uom_id.rounding or 0.01
            van_cover = float_round(
                min(still, free_van.get(pid, 0.0)),
                precision_rounding=rounding,
            )
            pick_now = float_round(
                max(0.0, still - van_cover),
                precision_rounding=rounding,
            )
            pick_vals.append((0, 0, {
                'product_id': agg['product_id'],
                'product_uom_id': agg['product_uom_id'],
                'qty_ordered': agg['qty_ordered'],
                'qty_already_picked': agg['qty_picked'],
                'qty_delivered': agg['qty_delivered'],
                'qty_still_needed': still,
                'qty_van_cover': van_cover,
                'qty_to_pick': pick_now,
                'qty_warehouse_available': wh_by_product.get(pid, 0.0),
                'qty_on_van': van_by_product.get(pid, 0.0),
            }))

        shops_done = len(deliveries.filtered(lambda d: d.delivery_progress == 'done'))
        shops_partial = len(deliveries.filtered(lambda d: d.delivery_progress == 'partial'))
        summary = (
            f'<p class="mb-0">'
            f'<b>{len(shop_vals)}</b> shops (today / overdue) · '
            f'<b>{shops_partial}</b> partial · '
            f'<b>{shops_done}</b> done'
            f'</p>'
        )

        van_total = sum(van_by_product.values())
        wh_total = sum(wh_by_product.get(pid, 0.0) for pid in product_ids)

        self.write({
            'shop_line_ids': shop_vals,
            'pick_line_ids': pick_vals,
            'shop_count': len(shop_vals),
            'total_still_to_pick': total_still,
            'summary_html': summary,
            'van_qty_on_hand': van_total,
            'warehouse_qty_available': wh_total,
            'stock_summary_html': self._shahtaj_build_stock_summary_html(
                van_by_product, wh_by_product,
            ),
        })
        return True

    def action_pick_today_load(self):
        """Apply free van stock to today's jobs, then WH→van for Pick Now."""
        self.ensure_one()
        Delivery = self.env['shahtaj.dm.delivery']
        day = self.load_date or fields.Date.context_today(self)
        dm = self.delivery_man_id or self._shahtaj_resolve_delivery_man()

        pick_by_product = {}
        for pline in self.pick_line_ids:
            rounding = pline.product_uom_id.rounding or 0.01
            still = pline.qty_still_needed or 0.0
            qty = pline.qty_to_pick or 0.0
            if float_compare(qty, 0.0, precision_rounding=rounding) < 0:
                raise UserError(_('Pick quantity cannot be negative.'))
            if float_compare(qty, still, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Cannot pick %(qty)s of %(product)s — only %(max)s still needed today.',
                    qty=qty,
                    product=pline.product_id.display_name,
                    max=still,
                ))
            if not float_is_zero(qty, precision_rounding=rounding):
                pick_by_product[pline.product_id.id] = qty

        deliveries = Delivery.search(
            self._shahtaj_today_load_delivery_domain(dm, day),
            order='id',
        )
        for delivery in deliveries:
            delivery.sudo()._sync_with_sale_order(ensure_visit_task=False)

        live_still = defaultdict(float)
        for delivery in deliveries:
            for line in delivery.line_ids:
                if line.product_id:
                    live_still[line.product_id.id] += max(
                        line.qty_assigned - line.qty_picked, 0.0,
                    )

        free_van = Delivery._shahtaj_unattributed_van_qty_map(
            dm, set(live_still) | set(pick_by_product),
        )
        van_apply = {}
        wh_move = {}
        for pid, still in live_still.items():
            if still <= 0:
                continue
            product = self.env['product.product'].browse(pid)
            rounding = product.uom_id.rounding or 0.01
            # Pick Now = WH→van. Free van covers the rest of today's Still Need.
            # Refresh defaults Pick Now to Still Need − Van Covers (van-first).
            user_wh = float(pick_by_product.get(pid) or 0.0)
            free = free_van.get(pid, 0.0)
            wh = float_round(min(user_wh, still), precision_rounding=rounding)
            cover = float_round(
                min(free, max(0.0, still - wh)),
                precision_rounding=rounding,
            )
            if cover > 0:
                van_apply[pid] = cover
            if wh > 0:
                wh_move[pid] = wh

        if not van_apply and not wh_move:
            raise UserError(_(
                'Nothing to load: today’s jobs are covered, or Pick Now is zero '
                'with no free van stock to apply. Refresh and check Shop Progress.'
            ))

        shops_touched = set()

        if van_apply:
            qty_by_delivery, remaining = Delivery._shahtaj_fifo_allocate_product_qtys(
                deliveries, van_apply,
            )
            for pid, left in remaining.items():
                product = self.env['product.product'].browse(pid)
                rounding = product.uom_id.rounding or 0.01
                if float_compare(left, 0.0, precision_rounding=rounding) > 0:
                    raise UserError(_(
                        'Could not apply %(qty)s of %(product)s from van to today’s shops. '
                        'Refresh and try again.',
                        qty=left,
                        product=product.display_name,
                    ))
            for delivery_id, qty_map in qty_by_delivery.items():
                Delivery.browse(delivery_id)._attribute_van_stock_with_qtys(
                    qty_map, reload_form=False,
                )
                shops_touched.add(delivery_id)

        if wh_move:
            deliveries = Delivery.search(
                self._shahtaj_today_load_delivery_domain(dm, day),
                order='id',
            )
            qty_by_delivery, remaining = Delivery._shahtaj_fifo_allocate_product_qtys(
                deliveries, wh_move,
            )
            for pid, left in remaining.items():
                product = self.env['product.product'].browse(pid)
                rounding = product.uom_id.rounding or 0.01
                if float_compare(left, 0.0, precision_rounding=rounding) > 0:
                    raise UserError(_(
                        'Could not allocate %(qty)s of %(product)s across today’s shops. '
                        'Refresh and try again.',
                        qty=left,
                        product=product.display_name,
                    ))
            for delivery_id, qty_map in qty_by_delivery.items():
                Delivery.browse(delivery_id)._pick_stock_with_qtys(
                    qty_map, reload_form=False,
                )
                shops_touched.add(delivery_id)

        self.action_refresh()
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Stock ready on van'),
                'message': _(
                    'Updated %(shops)s shop order(s). '
                    'Van cover on %(van)s SKU(s); warehouse pick on %(wh)s SKU(s).',
                    shops=len(shops_touched),
                    van=len(van_apply),
                    wh=len(wh_move),
                ),
                'type': 'success',
                'sticky': False,
                'next': {
                    'type': 'ir.actions.act_window',
                    'name': _("Today's Load"),
                    'res_model': self._name,
                    'res_id': self.id,
                    'view_mode': 'form',
                    'views': [(False, 'form')],
                    'target': 'current',
                },
            },
        }

    def action_open_my_deliveries(self):
        return {
            'type': 'ir.actions.act_window',
            'name': _('My Deliveries'),
            'res_model': 'shahtaj.dm.delivery',
            'view_mode': 'list,form',
            'domain': [
                ('delivery_man_id', '=', (self.delivery_man_id or self.env.user).id),
                ('scheduled_date', '=', self.load_date or fields.Date.context_today(self)),
                ('state', 'in', ('ready', 'picked', 'partial')),
            ],
            'target': 'current',
        }

    def action_open_van_transfer(self):
        """Open free WH ↔ van transfer for the same delivery man."""
        self.ensure_one()
        dm = self.delivery_man_id or self._shahtaj_resolve_delivery_man()
        return self.env['shahtaj.dm.van.transfer'].with_context(
            shahtaj_delivery_man_id=dm.id,
        ).action_open()


class ShahtajDmTodayLoadShop(models.TransientModel):
    _name = 'shahtaj.dm.today.load.shop'
    _description = 'DM Today Load Shop Progress'
    _order = 'partner_id, id'

    wizard_id = fields.Many2one(
        'shahtaj.dm.today.load',
        required=True,
        ondelete='cascade',
    )
    delivery_id = fields.Many2one('shahtaj.dm.delivery', readonly=True)
    partner_id = fields.Many2one('res.partner', string='Shop', readonly=True)
    sale_order_id = fields.Many2one('sale.order', string='Order', readonly=True)
    state = fields.Selection(
        related='delivery_id.state',
        string='Stock',
        readonly=True,
    )
    field_state = fields.Selection(
        related='delivery_id.field_state',
        string='Stop',
        readonly=True,
    )
    delivery_progress = fields.Selection(
        related='delivery_id.delivery_progress',
        string='Progress',
        readonly=True,
    )
    qty_ordered = fields.Float(string='Ordered', digits='Product Unit of Measure', readonly=True)
    qty_picked = fields.Float(string='Picked', digits='Product Unit of Measure', readonly=True)
    qty_delivered = fields.Float(string='Delivered', digits='Product Unit of Measure', readonly=True)
    qty_left_on_van = fields.Float(string='Left on Van', digits='Product Unit of Measure', readonly=True)
    qty_still_to_pick = fields.Float(string='Still to Pick', digits='Product Unit of Measure', readonly=True)
    delivered_ratio = fields.Float(
        string='Delivered % of Picked',
        digits=(16, 1),
        readonly=True,
        help='Delivered ÷ Picked × 100 for this shop (0 if nothing picked yet).',
    )

    def action_open_delivery(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': self.delivery_id.display_name,
            'res_model': 'shahtaj.dm.delivery',
            'res_id': self.delivery_id.id,
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'current',
        }

    def action_deliver_to_shop(self):
        """Open GPS deliver procedure for this shop job."""
        self.ensure_one()
        if not self.delivery_id:
            raise UserError(_('Missing delivery job.'))
        return self.delivery_id.action_deliver_to_shop()


class ShahtajDmTodayLoadPick(models.TransientModel):
    _name = 'shahtaj.dm.today.load.pick'
    _description = 'DM Today Load Pick Line'
    _order = 'product_id'

    wizard_id = fields.Many2one(
        'shahtaj.dm.today.load',
        required=True,
        ondelete='cascade',
    )
    product_id = fields.Many2one('product.product', string='Product', readonly=True)
    product_uom_id = fields.Many2one('uom.uom', string='UoM', readonly=True)
    qty_warehouse_available = fields.Float(
        string='Warehouse',
        digits='Product Unit of Measure',
        readonly=True,
        help='Free quantity available in the warehouse to pick onto the van.',
    )
    qty_on_van = fields.Float(
        string='On Van',
        digits='Product Unit of Measure',
        readonly=True,
        help='Physical quantity currently on this delivery man van.',
    )
    qty_van_cover = fields.Float(
        string='Van Covers',
        digits='Product Unit of Measure',
        readonly=True,
        help='Free van stock (not already tied to open jobs) that will cover today’s need.',
    )
    qty_ordered = fields.Float(string='Assigned', digits='Product Unit of Measure', readonly=True)
    qty_already_picked = fields.Float(string='Picked', digits='Product Unit of Measure', readonly=True)
    qty_delivered = fields.Float(string='Delivered', digits='Product Unit of Measure', readonly=True)
    qty_still_needed = fields.Float(
        string='Still Need',
        digits='Product Unit of Measure',
        readonly=True,
        help='Today’s open jobs: assigned − picked.',
    )
    qty_to_pick = fields.Float(
        string='Pick Now',
        digits='Product Unit of Measure',
        help='Warehouse → van for today. Defaults to Still Need minus Van Covers.',
    )
