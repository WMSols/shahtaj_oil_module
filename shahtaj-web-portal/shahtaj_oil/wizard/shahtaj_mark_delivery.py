# -*- coding: utf-8 -*-
"""Distributor wizard: mark full or partial delivery on a field sales order."""
from collections import defaultdict

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_is_zero


class ShahtajMarkDeliveryWizard(models.TransientModel):
    _name = 'shahtaj.mark.delivery.wizard'
    _description = 'Mark Shop Delivery'

    sale_order_id = fields.Many2one(
        'sale.order',
        string='Sales Order',
        required=True,
        readonly=True,
    )
    partner_id = fields.Many2one(
        related='sale_order_id.partner_id',
        string='Shop',
    )
    delivery_source = fields.Selection(
        [
            ('warehouse', 'Warehouse stock'),
            ('van', 'DM van stock'),
        ],
        string='Stock Source',
        required=True,
        default='warehouse',
        help=(
            'Warehouse: ship from WH to shop (van leftover stays as free surplus). '
            'Van: ship from the DM van for an active / today job.'
        ),
    )
    line_ids = fields.One2many(
        'shahtaj.mark.delivery.wizard.line',
        'wizard_id',
        string='Products to Deliver',
    )

    @api.model
    def shahtaj_mark_delivery_options(self, order_id):
        """Portal helper: active/today jobs + whether van or WH can supply.

        Returns a JSON-serializable dict for the source-choice UI.
        """
        order = self.env['sale.order'].browse(order_id)
        if not order.exists():
            return {
                'ok': False,
                'message': _('Sales order not found.'),
            }
        order._shahtaj_assert_not_cancelled()
        Delivery = self.env['shahtaj.dm.delivery']
        warehouse = Delivery._get_warehouse()
        wh_loc = warehouse.lot_stock_id
        today = fields.Date.context_today(self)

        # Remaining qty by product on the SO.
        remaining_by_product = defaultdict(float)
        product_names = {}
        for sol in order.order_line.filtered(
            lambda l: l.product_id and not l.display_type
            and l.product_id.type == 'consu' and l.product_id.is_storable
        ):
            left = max((sol.product_uom_qty or 0.0) - (sol.qty_delivered or 0.0), 0.0)
            if left <= 0:
                continue
            remaining_by_product[sol.product_id.id] += left
            product_names[sol.product_id.id] = sol.product_id.display_name

        if not remaining_by_product:
            return {
                'ok': False,
                'message': _('Nothing left to deliver on this order.'),
                'needs_choice': False,
                'warehouse_ok': False,
                'van_ok': False,
            }

        # Free WH + qty already reserved for this same order (usable for Mark Delivery).
        wh_map = Delivery._shahtaj_wh_usable_for_sale_order_map(
            order, wh_loc, set(remaining_by_product),
        )
        wh_short = []
        wh_has_any = False
        warehouse_covers_all = True
        for pid, need in remaining_by_product.items():
            product = self.env['product.product'].browse(pid)
            rounding = (product.uom_id.rounding if product.exists() else None) or 0.01
            avail = max(wh_map.get(pid, 0.0), 0.0)
            if float_compare(avail, 0.0, precision_rounding=rounding) > 0:
                wh_has_any = True
            if float_compare(need, avail, precision_rounding=rounding) > 0:
                warehouse_covers_all = False
                wh_short.append({
                    'product': product_names.get(pid, pid),
                    'need': need,
                    'available': avail,
                })
        # WH path OK when this order's usable WH stock covers remaining lines,
        # or at least some usable stock exists (partial deliver in wizard).
        warehouse_ok = warehouse_covers_all or wh_has_any

        jobs = Delivery.search([
            ('sale_order_id', '=', order.id),
            ('state', 'in', ('ready', 'picked', 'partial')),
        ], order='id asc')

        active_jobs = []
        van_ok = False
        for job in jobs:
            is_today = bool(job.scheduled_date and job.scheduled_date == today)
            # Active / today: already on van, or scheduled for today.
            if job.state not in ('picked', 'partial') and not is_today:
                continue

            van_stock = []
            job_van_has_any = False
            physical = {}
            if job.van_location_id:
                physical = Delivery._shahtaj_physical_van_qty_map(
                    job.van_location_id, set(remaining_by_product),
                )
            for pid, need in remaining_by_product.items():
                product = self.env['product.product'].browse(pid)
                rounding = (product.uom_id.rounding if product.exists() else None) or 0.01
                avail = max(physical.get(pid, 0.0), 0.0)
                van_stock.append({
                    'product': product_names.get(pid, pid),
                    'need': need,
                    'available': avail,
                })
                if float_compare(avail, 0.0, precision_rounding=rounding) > 0:
                    job_van_has_any = True

            can_use_van = bool(
                job.van_location_id
                and job.state in ('picked', 'partial')
                and job_van_has_any
            )
            if can_use_van:
                van_ok = True

            active_jobs.append({
                'id': job.id,
                'name': job.display_name,
                'dm_id': job.delivery_man_id.id if job.delivery_man_id else False,
                'dm_name': job.delivery_man_id.name if job.delivery_man_id else '',
                'state': job.state,
                'scheduled_date': str(job.scheduled_date) if job.scheduled_date else False,
                'is_today': is_today,
                'van_location': (
                    job.van_location_id.display_name if job.van_location_id else ''
                ),
                'van_stock': van_stock,
                'van_ok': can_use_van,
            })

        needs_choice = bool(active_jobs)
        default_source = 'van' if van_ok else 'warehouse'
        block_message = False
        if not warehouse_ok and not van_ok:
            block_message = self._shahtaj_mark_delivery_block_message(
                order, wh_loc, remaining_by_product, product_names, jobs,
            )
        return {
            'ok': True,
            'order_id': order.id,
            'order_name': order.display_name,
            'needs_choice': needs_choice,
            'default_source': default_source,
            'warehouse_ok': warehouse_ok,
            'warehouse_short': wh_short,
            'van_ok': van_ok,
            'active_jobs': active_jobs,
            'message': block_message,
            'wh_stock': [
                {
                    'product': product_names.get(pid, pid),
                    'need': need,
                    'available': max(wh_map.get(pid, 0.0), 0.0),
                }
                for pid, need in remaining_by_product.items()
            ],
        }

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        order_id = self.env.context.get('active_id') or res.get('sale_order_id')
        order = self.env['sale.order'].browse(order_id)
        if not order.exists():
            return res
        res['sale_order_id'] = order.id
        source = self.env.context.get('shahtaj_delivery_source') or res.get('delivery_source')
        if source in ('warehouse', 'van'):
            res['delivery_source'] = source
        else:
            res['delivery_source'] = 'warehouse'

        # Custom-portal distributors lack stock.move / picking ACL; elevate only
        # this delivery preparation path (confirm path already uses sudo on moves).
        pickings = order.sudo().picking_ids.filtered(
            lambda p: p.state not in ('done', 'cancel')
            and p.picking_type_code == 'outgoing'
        )
        draft = pickings.filtered(lambda p: p.state == 'draft')
        if draft:
            draft.action_confirm()
        pickings.action_assign()

        lines = []
        moves = pickings.move_ids.filtered(lambda m: m.state not in ('done', 'cancel'))
        for move in moves:
            sol = move.sale_line_id
            ordered = sol.product_uom_qty if sol else move.product_uom_qty
            already = sol.qty_delivered if sol else 0.0
            remaining = max(ordered - already, 0.0)
            if float_is_zero(remaining, precision_rounding=move.product_uom.rounding):
                continue
            lines.append((0, 0, {
                'move_id': move.id,
                'sale_line_id': sol.id if sol else False,
                'qty_ordered': ordered,
                'qty_already_delivered': already,
                'qty_to_deliver': remaining,
            }))
        res['line_ids'] = lines
        return res

    def _shahtaj_source_location(self):
        """Resolve WH or van location for the chosen delivery_source."""
        self.ensure_one()
        Delivery = self.env['shahtaj.dm.delivery']
        warehouse = Delivery._get_warehouse()
        if self.delivery_source == 'warehouse':
            return warehouse.lot_stock_id, None

        today = fields.Date.context_today(self)
        jobs = Delivery.search([
            ('sale_order_id', '=', self.sale_order_id.id),
            ('state', 'in', ('picked', 'partial')),
            ('van_location_id', '!=', False),
        ], order='id asc')
        # Prefer today's job, else first with van leftover.
        job = jobs.filtered(lambda j: j.scheduled_date == today)[:1] or jobs[:1]
        if not job:
            raise UserError(_(
                'This order is not loaded on a delivery van. '
                'Choose warehouse, or load the van first.'
            ))
        return job.van_location_id, job

    def _shahtaj_retarget_outgoing_to(self, location):
        """Point open SO outgoing moves at WH or van before validate."""
        self.ensure_one()
        if not location:
            raise UserError(_('Missing stock location for Mark Delivery.'))
        pickings = self.sale_order_id.sudo().picking_ids.filtered(
            lambda p: p.state not in ('done', 'cancel') and p.picking_type_code == 'outgoing'
        )
        for picking in pickings:
            if picking.state == 'draft':
                picking.action_confirm()
            for move in picking.move_ids.filtered(lambda m: m.state not in ('done', 'cancel')):
                move.location_id = location.id
            picking.location_id = location.id
            picking.action_assign()

    @api.model
    def _shahtaj_mark_delivery_block_message(
        self, order, wh_loc, remaining_by_product, product_names, jobs=None,
    ):
        """Plain-language reason when neither WH nor van can supply."""
        Delivery = self.env['shahtaj.dm.delivery']
        Product = self.env['product.product'].sudo()
        onhand = Delivery._shahtaj_physical_wh_onhand_qty_map(
            wh_loc, set(remaining_by_product),
        )
        jobs = jobs if jobs is not None else Delivery.search([
            ('sale_order_id', '=', order.id),
            ('state', 'in', ('ready', 'picked', 'partial')),
        ])
        parts = []
        for pid, need in remaining_by_product.items():
            product = Product.browse(pid)
            rounding = (product.uom_id.rounding if product.exists() else None) or 0.01
            name = product_names.get(pid) or (
                product.display_name if product.exists() else str(pid)
            )
            wh_qty = max(onhand.get(pid, 0.0), 0.0)
            van_qty = 0.0
            dm_name = ''
            for job in jobs:
                if not job.van_location_id:
                    continue
                van_map = Delivery._shahtaj_physical_van_qty_map(
                    job.van_location_id, {pid},
                )
                got = max(van_map.get(pid, 0.0), 0.0)
                if got > van_qty:
                    van_qty = got
                    dm_name = job.delivery_man_id.name if job.delivery_man_id else ''
            if float_compare(van_qty, 0.0, precision_rounding=rounding) > 0:
                if dm_name:
                    parts.append(_(
                        '%(product)s is with delivery man %(dm)s (on the van). '
                        'Choose “From DM van”, or ask them to return it to the warehouse.',
                        product=name,
                        dm=dm_name,
                    ))
                else:
                    parts.append(_(
                        '%(product)s is already on a delivery van. '
                        'Choose “From DM van”, or return it to the warehouse first.',
                        product=name,
                    ))
            elif float_compare(wh_qty, need, precision_rounding=rounding) < 0:
                parts.append(_(
                    'Not enough %(product)s in the warehouse '
                    '(need %(need)s, warehouse has %(have)s).',
                    product=name,
                    need=need,
                    have=wh_qty,
                ))
            else:
                parts.append(_(
                    '%(product)s in the warehouse is held for another order. '
                    'Wait until that stock is free, or deliver from the van if loaded.',
                    product=name,
                ))
        return '\n'.join(parts) if parts else _(
            'No warehouse or van stock is available to mark this delivery.'
        )

    def _shahtaj_assert_source_stock(self):
        """Block confirm when chosen source cannot cover Deliver Now qtys."""
        self.ensure_one()
        need = defaultdict(float)
        for line in self.line_ids:
            rounding = line.product_uom_id.rounding or 0.01
            if float_is_zero(line.qty_to_deliver, precision_rounding=rounding):
                continue
            if line.product_id:
                need[line.product_id.id] += float(line.qty_to_deliver or 0.0)
        if not need:
            return
        location, job = self._shahtaj_source_location()
        Delivery = self.env['shahtaj.dm.delivery']
        if self.delivery_source == 'van':
            try:
                Delivery._shahtaj_assert_physical_van_qty(
                    location, need, _('deliver from van'),
                )
            except UserError:
                dm_name = (
                    job.delivery_man_id.name
                    if job and job.delivery_man_id else _('the delivery man')
                )
                raise UserError(_(
                    'Not enough stock on the van for this order. '
                    'Ask %(dm)s to load the van first, or deliver from the warehouse.',
                    dm=dm_name,
                )) from None
            return

        # Warehouse: free stock + qty already reserved for THIS sale order.
        usable = Delivery._shahtaj_wh_usable_for_sale_order_map(
            self.sale_order_id, location, set(need),
        )
        Product = self.env['product.product'].sudo()
        short = []
        for pid, qty in need.items():
            product = Product.browse(pid)
            rounding = (product.uom_id.rounding if product.exists() else None) or 0.01
            avail = max(usable.get(pid, 0.0), 0.0)
            if float_compare(qty, avail, precision_rounding=rounding) > 0:
                short.append((product, qty, avail))
        if not short:
            return

        jobs = Delivery.search([
            ('sale_order_id', '=', self.sale_order_id.id),
            ('state', 'in', ('ready', 'picked', 'partial')),
        ])
        names = {}
        remaining = {}
        for product, qty, _avail in short:
            pid = product.id
            names[pid] = product.display_name if product.exists() else str(pid)
            remaining[pid] = qty
        raise UserError(self._shahtaj_mark_delivery_block_message(
            self.sale_order_id, location, remaining, names, jobs,
        ))

    def action_deliver_all_remaining(self):
        self.ensure_one()
        for line in self.line_ids:
            line.qty_to_deliver = max(line.qty_ordered - line.qty_already_delivered, 0.0)
        return self.action_confirm_delivery()

    def action_confirm_delivery(self):
        self.ensure_one()
        self.sale_order_id._shahtaj_assert_not_cancelled()
        if not self.line_ids:
            raise UserError(_(
                'No open delivery for this order. '
                'Stock may already be fully delivered, or the product is not tracked in inventory.'
            ))
        if self.delivery_source not in ('warehouse', 'van'):
            raise UserError(_('Choose Warehouse or DM van as the stock source.'))

        pickings = self.env['stock.picking']
        any_qty = False
        for line in self.line_ids:
            rounding = line.product_uom_id.rounding or 0.01
            remaining = line.qty_ordered - line.qty_already_delivered
            if float_compare(line.qty_to_deliver, 0.0, precision_rounding=rounding) < 0:
                raise UserError(_('Delivered quantity cannot be negative.'))
            if float_compare(line.qty_to_deliver, remaining, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Cannot deliver %(done)s of %(product)s — only %(left)s remaining.',
                    done=line.qty_to_deliver,
                    product=line.product_id.display_name,
                    left=remaining,
                ))
            move = line.move_id.sudo()
            if move.state in ('done', 'cancel'):
                continue
            if float_is_zero(line.qty_to_deliver, precision_rounding=rounding):
                move.quantity = 0.0
            else:
                any_qty = True
            pickings |= move.picking_id

        if not any_qty:
            raise UserError(_('Enter a quantity to deliver on at least one product.'))

        # Point outgoing at chosen source, assert stock, then set done qtys.
        location, _job = self._shahtaj_source_location()
        self._shahtaj_retarget_outgoing_to(location)
        self._shahtaj_assert_source_stock()

        pickings = pickings.sudo().filtered(lambda p: p.state not in ('done', 'cancel'))
        pickings.filtered(lambda p: p.state == 'draft').action_confirm()
        pickings.action_assign()
        for line in self.line_ids:
            move = line.move_id.sudo()
            if move.state in ('done', 'cancel'):
                continue
            rounding = line.product_uom_id.rounding or 0.01
            if float_is_zero(line.qty_to_deliver, precision_rounding=rounding):
                move.quantity = 0.0
            else:
                move._set_quantity_done(line.qty_to_deliver)
                move.picked = True

        result = pickings.with_context(skip_backorder=True, skip_sms=True).button_validate()
        # With skip_backorder, partial qty creates a backorder automatically.
        # Keep a fallback if another wizard still appears.
        if isinstance(result, dict) and result.get('res_model') == 'stock.backorder.confirmation':
            ctx = dict(result.get('context') or {})
            wiz = self.env['stock.backorder.confirmation'].with_context(ctx).create({
                'pick_ids': [(6, 0, pickings.ids)],
                'backorder_confirmation_line_ids': [
                    (0, 0, {'to_backorder': True, 'picking_id': pid})
                    for pid in pickings.ids
                ],
            })
            wiz.process()

        # Sync DM jobs (partial or full) so DM cannot re-deliver the same qty.
        order = self.sale_order_id.sudo()
        order.invalidate_recordset(['shahtaj_delivery_status', 'shahtaj_qty_to_deliver'])
        self.env['shahtaj.dm.delivery']._shahtaj_align_dm_jobs_to_sale_delivery(order)

        return {
            'type': 'ir.actions.act_window',
            'name': _('Sales Order'),
            'res_model': 'sale.order',
            'res_id': self.sale_order_id.id,
            'view_mode': 'form',
            'target': 'current',
        }


class ShahtajMarkDeliveryWizardLine(models.TransientModel):
    _name = 'shahtaj.mark.delivery.wizard.line'
    _description = 'Mark Delivery Line'

    wizard_id = fields.Many2one(
        'shahtaj.mark.delivery.wizard',
        required=True,
        ondelete='cascade',
    )
    move_id = fields.Many2one('stock.move', string='Stock Move', required=True)
    sale_line_id = fields.Many2one('sale.order.line', string='Order Line')
    # Related so the web client can omit readonly product_id on save.
    product_id = fields.Many2one(
        related='move_id.product_id',
        string='Product',
        readonly=True,
    )
    product_uom_id = fields.Many2one(
        related='move_id.product_uom',
        string='Unit',
        readonly=True,
    )
    qty_ordered = fields.Float(string='Ordered', digits='Product Unit of Measure')
    qty_already_delivered = fields.Float(
        string='Already Delivered',
        digits='Product Unit of Measure',
    )
    qty_to_deliver = fields.Float(
        string='Deliver Now',
        digits='Product Unit of Measure',
        required=True,
    )

    @api.model_create_multi
    def create(self, vals_list):
        """Fill product/qty context from the move when readonly fields are dropped."""
        Move = self.env['stock.move']
        if self.env.user._shahtaj_can_manage_dm_ops():
            Move = Move.sudo()
        for vals in vals_list:
            move = Move.browse(vals.get('move_id')) if vals.get('move_id') else Move
            if move and not vals.get('sale_line_id') and move.sale_line_id:
                vals['sale_line_id'] = move.sale_line_id.id
            if move and 'qty_ordered' not in vals:
                sol = move.sale_line_id
                vals['qty_ordered'] = sol.product_uom_qty if sol else move.product_uom_qty
            if move and 'qty_already_delivered' not in vals:
                vals['qty_already_delivered'] = (
                    move.sale_line_id.qty_delivered if move.sale_line_id else 0.0
                )
        return super().create(vals_list)
