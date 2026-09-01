# -*- coding: utf-8 -*-
"""Delivery Man workflow: pick WH→van, deliver van→shop, return van→WH."""
import logging

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_is_zero, float_round

_logger = logging.getLogger(__name__)

DM_PROCESSING_STATES = ('picked', 'partial', 'delivered', 'returned')
DM_DISTRIBUTOR_PLANNING_FIELDS = frozenset({
    'delivery_man_id', 'scheduled_date', 'scheduled_time', 'notes',
})
DM_PLANNING_FIELD_LABELS = {
    'delivery_man_id': 'Delivery Man',
    'scheduled_date': 'Delivery Day',
    'scheduled_time': 'Delivery Time',
    'notes': 'Notes',
}


class ShahtajDmDelivery(models.Model):
    _name = 'shahtaj.dm.delivery'
    _description = 'Delivery Man Delivery Order'
    _order = 'create_date desc'
    _rec_name = 'display_name'

    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        required=True,
        index=True,
        ondelete='cascade',
        domain="[('shahtaj_is_delivery_man', '=', True)]",
    )
    sale_order_id = fields.Many2one(
        'sale.order',
        string='Sale Order',
        required=True,
        index=True,
        ondelete='cascade',
    )
    partner_id = fields.Many2one(
        related='sale_order_id.partner_id',
        string='Shop',
        store=True,
        readonly=True,
    )
    order_booker_id = fields.Many2one(
        related='sale_order_id.shahtaj_order_booker_id',
        string='Order Booker',
        store=True,
        readonly=True,
    )
    order_date = fields.Datetime(
        related='sale_order_id.date_order',
        string='Order Date',
        store=True,
        readonly=True,
    )
    amount_total = fields.Monetary(
        related='sale_order_id.amount_total',
        string='Order Total',
        store=True,
        readonly=True,
    )
    currency_id = fields.Many2one(
        related='sale_order_id.currency_id',
        store=True,
        readonly=True,
    )
    invoice_status = fields.Selection(
        related='sale_order_id.invoice_status',
        string='Invoice Status',
        store=True,
        readonly=True,
    )
    state = fields.Selection(
        [
            ('not_ready', 'Waiting Invoice'),
            ('ready', 'Ready to Pick'),
            ('picked', 'Loaded on Van'),
            ('partial', 'Part Delivered'),
            ('delivered', 'Delivered'),
            ('returned', 'Returned to WH'),
        ],
        string='Stock',
        default='not_ready',
        required=True,
        index=True,
        help=(
            'Warehouse stock flow for this job.\n'
            'Waiting Invoice → Ready to Pick → Loaded on Van → '
            'Part Delivered / Delivered (or Returned to WH).'
        ),
    )
    field_state = fields.Selection(
        [
            ('pending', 'Not Started'),
            ('in_transit', 'On the Way'),
            ('not_attended', 'Shop Closed'),
            ('failed', 'Could Not Deliver'),
            ('done', 'Stop Done'),
        ],
        string='Stop',
        default='pending',
        required=True,
        index=True,
        help=(
            'Field stop story (separate from stock).\n'
            'Not Started → On the Way → Shop Closed / Could Not Deliver / Stop Done.\n'
            'Shop Closed and Could Not Deliver require a note.'
        ),
    )
    delivery_progress = fields.Selection(
        [
            ('pending', 'Pending'),
            ('partial', 'Partial'),
            ('done', 'Done'),
        ],
        string='Progress (internal)',
        compute='_compute_delivery_progress',
        store=True,
        index=True,
        help='Internal coarse summary derived from Status. Prefer Status in the UI.',
    )
    scheduled_date = fields.Date(
        string='Delivery Day',
        index=True,
        help='Day this delivery is planned for (My Deliveries / Today Load).',
    )
    scheduled_time = fields.Float(
        string='Delivery Time',
        help='Planned time of day (distributor assignment).',
    )
    assigned_by_id = fields.Many2one(
        'res.users',
        string='Assigned By',
        readonly=True,
        copy=False,
        help='Distributor who manually assigned this delivery job.',
    )
    assignment_mode = fields.Selection(
        [
            ('auto', 'Auto (booker link)'),
            ('manual', 'Manual (distributor)'),
        ],
        string='Assignment',
        default='auto',
        required=True,
        index=True,
        help='How this delivery job was created or last assigned.',
    )
    notes = fields.Text(
        string='Notes',
        help=(
            'Shared notes (same idea as order booker visit notes). '
            'Required when marking Shop Closed or Could Not Deliver.'
        ),
    )
    shahtaj_processing_locked = fields.Boolean(
        string='Processing Locked',
        compute='_compute_shahtaj_processing_locked',
    )

    @api.depends('state')
    def _compute_shahtaj_processing_locked(self):
        for rec in self:
            rec.shahtaj_processing_locked = rec._shahtaj_is_processing_locked()

    check_in_latitude = fields.Float(string='Last Deliver Latitude', digits=(10, 7))
    check_in_longitude = fields.Float(string='Last Deliver Longitude', digits=(10, 7))
    check_in_distance_m = fields.Float(string='Last Deliver Distance (m)', digits=(16, 2))
    gps_verified = fields.Boolean(
        string='GPS Verified',
        default=False,
        copy=False,
        help='Set when a delivery was confirmed within the shop GPS distance.',
    )
    pick_picking_id = fields.Many2one(
        'stock.picking',
        string='Pick Transfer',
        readonly=True,
        help='Warehouse → Van transfer.',
    )
    delivery_picking_id = fields.Many2one(
        'stock.picking',
        string='Delivery Transfer',
        readonly=True,
        help='Van → Shop transfer.',
    )
    return_picking_id = fields.Many2one(
        'stock.picking',
        string='Return Transfer',
        readonly=True,
        help='Van → Warehouse return of undelivered stock.',
    )
    van_location_id = fields.Many2one(
        'stock.location',
        string='Van Location',
        readonly=True,
    )
    van_stock_html = fields.Html(
        string='Van Stock After Pick',
        compute='_compute_van_stock_html',
        sanitize=False,
    )
    display_name = fields.Char(
        compute='_compute_display_name',
        store=True,
    )
    line_ids = fields.One2many(
        'shahtaj.dm.delivery.line',
        'delivery_id',
        string='Delivery Lines',
    )
    qty_assigned_total = fields.Float(
        string='Assigned Qty',
        compute='_compute_qty_assigned_total',
        digits='Product Unit of Measure',
    )
    is_split_share = fields.Boolean(
        string='Part of Split',
        compute='_compute_is_split_share',
        help='True when this sales order has more than one delivery job.',
    )
    visit_task_id = fields.Many2one(
        'shahtaj.visit.task',
        string='Visit Task',
        readonly=True,
        copy=False,
    )

    _sale_order_dm_unique = models.Constraint(
        'unique(sale_order_id, delivery_man_id)',
        'This sale order is already assigned to this delivery man.',
    )

    @api.depends('sale_order_id.name', 'partner_id.name', 'delivery_man_id.name', 'is_split_share')
    def _compute_display_name(self):
        for rec in self:
            base = f"{rec.sale_order_id.name or '?'} → {rec.partner_id.name or '?'}"
            if rec.is_split_share and rec.delivery_man_id:
                rec.display_name = f"{base} ({rec.delivery_man_id.name})"
            else:
                rec.display_name = base

    @api.depends('line_ids.qty_assigned')
    def _compute_qty_assigned_total(self):
        for rec in self:
            rec.qty_assigned_total = sum(rec.line_ids.mapped('qty_assigned'))

    @api.depends('sale_order_id.shahtaj_dm_delivery_ids')
    def _compute_is_split_share(self):
        for rec in self:
            rec.is_split_share = len(rec.sale_order_id.shahtaj_dm_delivery_ids) > 1

    @api.depends('state', 'line_ids.qty_picked', 'line_ids.qty_delivered')
    def _compute_delivery_progress(self):
        for rec in self:
            if rec.state in ('delivered',):
                rec.delivery_progress = 'done'
            elif rec.state in ('partial',):
                rec.delivery_progress = 'partial'
            elif rec.state == 'returned':
                # Returned leftover: done for the day if nothing left to deliver to shop
                remaining = sum(
                    max(l.qty_picked - l.qty_delivered, 0.0) for l in rec.line_ids
                )
                any_delivered = any(l.qty_delivered > 0 for l in rec.line_ids)
                if remaining <= 0 and any_delivered:
                    rec.delivery_progress = 'done'
                elif any_delivered:
                    rec.delivery_progress = 'partial'
                else:
                    rec.delivery_progress = 'pending'
            else:
                rec.delivery_progress = 'pending'

    @api.depends(
        'van_location_id',
        'line_ids.qty_ordered',
        'line_ids.qty_picked',
        'line_ids.qty_delivered',
        'line_ids.product_id',
        'state',
    )
    def _compute_van_stock_html(self):
        Quant = self.env['stock.quant'].sudo()
        for rec in self:
            if not rec.van_location_id:
                rec.van_stock_html = (
                    '<p class="text-muted">No van location yet. Use '
                    '<b>Pick Stock from Warehouse</b> first.</p>'
                )
                continue

            quants = Quant.search([
                ('location_id', '=', rec.van_location_id.id),
                ('quantity', '>', 0),
            ])
            van_rows = []
            van_total = 0.0
            for q in quants:
                van_total += q.quantity
                van_rows.append(
                    f'<tr><td>{q.product_id.display_name}</td>'
                    f'<td class="text-end">{q.quantity:g}</td>'
                    f'<td>{q.product_uom_id.name}</td></tr>'
                )

            shop_rows = []
            tot_ordered = tot_picked = tot_delivered = tot_left = 0.0
            for line in rec.line_ids:
                left = max(line.qty_picked - line.qty_delivered, 0.0)
                tot_ordered += line.qty_ordered
                tot_picked += line.qty_picked
                tot_delivered += line.qty_delivered
                tot_left += left
                if line.qty_picked <= 0 and line.qty_ordered <= 0:
                    continue
                shop_rows.append(
                    f'<tr>'
                    f'<td>{line.product_id.display_name}</td>'
                    f'<td class="text-end">{line.qty_ordered:g}</td>'
                    f'<td class="text-end">{line.qty_picked:g}</td>'
                    f'<td class="text-end">{line.qty_delivered:g}</td>'
                    f'<td class="text-end"><b>{left:g}</b></td>'
                    f'<td>{line.product_uom_id.name or ""}</td>'
                    f'</tr>'
                )

            empty_van = '<tr><td colspan="3" class="text-muted">Van location empty</td></tr>'
            empty_shop = '<tr><td colspan="6" class="text-muted">Nothing picked for this shop yet</td></tr>'
            van_body = ''.join(van_rows) or empty_van
            shop_body = ''.join(shop_rows) or empty_shop
            if shop_rows:
                shop_body += (
                    f'<tr class="table-light">'
                    f'<td><b>Total</b></td>'
                    f'<td class="text-end"><b>{tot_ordered:g}</b></td>'
                    f'<td class="text-end"><b>{tot_picked:g}</b></td>'
                    f'<td class="text-end"><b>{tot_delivered:g}</b></td>'
                    f'<td class="text-end"><b>{tot_left:g}</b></td>'
                    f'<td></td></tr>'
                )

            loc_name = rec.van_location_id.display_name
            note = (
                f'<p class="mb-2">Van location: <b>{loc_name}</b>. '
                'Pick moves stock WH → van. Deliver moves van → shop. '
                'Return moves leftover van → WH.</p>'
            )
            shop_table = (
                '<p class="mb-1"><b>This shop order</b></p>'
                '<table class="table table-sm table-bordered mb-3">'
                '<thead><tr>'
                '<th>Product</th><th>Ordered</th><th>Picked</th>'
                '<th>Delivered</th><th>Left on van</th><th>UoM</th>'
                '</tr></thead>'
                f'<tbody>{shop_body}</tbody></table>'
            )
            van_table = (
                f'<p class="mb-1"><b>Live stock on van</b> '
                f'(all shops on this van — total qty {van_total:g})</p>'
                '<table class="table table-sm table-bordered">'
                '<thead><tr><th>Product</th><th>Qty</th><th>UoM</th></tr></thead>'
                f'<tbody>{van_body}</tbody></table>'
            )
            rec.van_stock_html = note + shop_table + van_table

    def _get_delivery_sale_lines(self):
        self.ensure_one()
        return self.sale_order_id.order_line.filtered(
            lambda l: l.product_id and l.product_id.type == 'consu' and not l.display_type
        )

    def _shahtaj_is_processing_locked(self):
        """Stock already picked or delivery finished — planning fields are frozen."""
        self.ensure_one()
        return self.state in DM_PROCESSING_STATES

    def write(self, vals):
        planning_vals = DM_DISTRIBUTOR_PLANNING_FIELDS.intersection(vals)
        user = self.env.user
        is_distributor = (
            not self.env.context.get('shahtaj_system_visit_write')
            and not self.env.context.get('shahtaj_skip_planning_log')
            and user.has_group('shahtaj_oil.group_shahtaj_distributor')
            and not user._is_public()
        )
        if planning_vals and is_distributor:
            locked = self.filtered('_shahtaj_is_processing_locked')
            if locked:
                raise UserError(_(
                    'Cannot change delivery planning for %(names)s — '
                    'stock is already picked or delivery is finished.',
                    names=', '.join(locked.mapped('display_name')),
                ))
            self.env['shahtaj.activity.log'].log_model_field_changes(
                self,
                operation='delivery.update',
                title='Delivery job updated',
                vals={k: vals[k] for k in planning_vals},
                field_labels=DM_PLANNING_FIELD_LABELS,
            )
        res = super().write(vals)
        if planning_vals.intersection({'delivery_man_id', 'scheduled_date'}):
            self.filtered(
                lambda r: not r._shahtaj_is_processing_locked()
            )._ensure_visit_task()
        return res

    def _sync_lines_from_sale_order(self):
        """Refresh products from SO while preserving each job's qty_assigned share."""
        DeliveryLine = self.env['shahtaj.dm.delivery.line'].sudo()
        for rec in self:
            sale_lines = rec._get_delivery_sale_lines()
            sole_job = len(rec.sale_order_id.shahtaj_dm_delivery_ids) <= 1
            existing_by_sol = {
                line.sale_order_line_id.id: line
                for line in rec.line_ids
                if line.sale_order_line_id
            }
            seen_sol_ids = set()
            for sol in sale_lines:
                seen_sol_ids.add(sol.id)
                existing = existing_by_sol.get(sol.id)
                qty_ordered = sol.product_uom_qty
                if existing:
                    qty_assigned = existing.qty_assigned
                    # Legacy / sole-job backfill when share was never set.
                    if float_is_zero(qty_assigned, precision_digits=6) and sole_job:
                        qty_assigned = qty_ordered
                    qty_delivered = existing.qty_delivered
                    qty_picked = existing.qty_picked
                    vals = {
                        'delivery_id': rec.id,
                        'sale_order_line_id': sol.id,
                        'product_id': sol.product_id.id,
                        'product_uom_id': sol.product_uom_id.id,
                        'qty_ordered': qty_ordered,
                        'qty_assigned': qty_assigned,
                        'qty_to_deliver': max(qty_assigned - qty_delivered, 0.0),
                        'qty_to_pick': max(qty_assigned - qty_picked, 0.0),
                    }
                    existing.write(vals)
                else:
                    qty_assigned = qty_ordered if sole_job else 0.0
                    DeliveryLine.create({
                        'delivery_id': rec.id,
                        'sale_order_line_id': sol.id,
                        'product_id': sol.product_id.id,
                        'product_uom_id': sol.product_uom_id.id,
                        'qty_ordered': qty_ordered,
                        'qty_assigned': qty_assigned,
                        'qty_to_deliver': qty_assigned,
                        'qty_to_pick': qty_assigned,
                        'qty_picked': 0.0,
                        'qty_delivered': 0.0,
                    })

            stale_lines = rec.line_ids.filtered(
                lambda line: (
                    not line.sale_order_line_id
                    or line.sale_order_line_id.id not in seen_sol_ids
                )
            )
            if stale_lines:
                stale_lines.unlink()

    def _compute_dm_state(self):
        """Derive status from invoice + this job's assigned / pick / deliver qtys."""
        self.ensure_one()
        if self.state == 'returned':
            return 'returned'
        sale_lines = self._get_delivery_sale_lines()
        if not sale_lines:
            return 'not_ready'
        has_posted_invoice = bool(
            self.sale_order_id.invoice_ids.filtered(lambda inv: inv.state == 'posted')
        )
        if not has_posted_invoice:
            return 'not_ready'

        lines = self.line_ids
        if not lines:
            return 'ready'

        assigned_total = sum(lines.mapped('qty_assigned'))
        if float_is_zero(assigned_total, precision_digits=6):
            # Job exists but no share yet (waiting for split assign).
            return 'ready'

        any_picked = any(l.qty_picked > 0 for l in lines)
        any_delivered = any(l.qty_delivered > 0 for l in lines)
        on_van = sum(max(l.qty_picked - l.qty_delivered, 0.0) for l in lines)
        remaining_assigned = sum(
            max(l.qty_assigned - l.qty_delivered, 0.0) for l in lines
        )

        if float_is_zero(remaining_assigned, precision_digits=6) and any_delivered:
            return 'delivered'
        if any_delivered and (
            on_van > 0 or not float_is_zero(remaining_assigned, precision_digits=6)
        ):
            return 'partial'
        if any_picked:
            return 'picked'
        return 'ready'

    def _apply_line_assignments(self, line_qty_map):
        """Set qty_assigned on this job from {sale_order_line_id: qty}.

        Creates missing product lines. line_qty_map values are this job's share.
        """
        self.ensure_one()
        self._sync_lines_from_sale_order()
        DeliveryLine = self.env['shahtaj.dm.delivery.line'].sudo()
        by_sol = {
            line.sale_order_line_id.id: line
            for line in self.line_ids
            if line.sale_order_line_id
        }
        for sol_id, qty in line_qty_map.items():
            sol = self.env['sale.order.line'].sudo().browse(sol_id)
            if not sol.exists() or sol.order_id != self.sale_order_id:
                continue
            rounding = sol.product_uom_id.rounding or 0.01
            qty = float_round(max(qty or 0.0, 0.0), precision_rounding=rounding)
            line = by_sol.get(sol.id)
            if line:
                if float_compare(qty, line.qty_picked, precision_rounding=rounding) < 0:
                    raise UserError(_(
                        'Cannot set assigned qty %(qty)s of %(product)s below '
                        'already picked %(picked)s on %(dm)s.',
                        qty=qty,
                        product=sol.product_id.display_name,
                        picked=line.qty_picked,
                        dm=self.delivery_man_id.name,
                    ))
                line.write({
                    'qty_assigned': qty,
                    'qty_ordered': sol.product_uom_qty,
                    'qty_to_deliver': max(qty - line.qty_delivered, 0.0),
                    'qty_to_pick': max(qty - line.qty_picked, 0.0),
                })
            else:
                DeliveryLine.create({
                    'delivery_id': self.id,
                    'sale_order_line_id': sol.id,
                    'product_id': sol.product_id.id,
                    'product_uom_id': sol.product_uom_id.id,
                    'qty_ordered': sol.product_uom_qty,
                    'qty_assigned': qty,
                    'qty_to_deliver': qty,
                    'qty_to_pick': qty,
                    'qty_picked': 0.0,
                    'qty_delivered': 0.0,
                })
        # Zero out lines not listed when map is a full plan for this job
        for line in self.line_ids:
            if not line.sale_order_line_id:
                continue
            if line.sale_order_line_id.id in line_qty_map:
                continue
            rounding = line.product_uom_id.rounding or 0.01
            if float_compare(line.qty_picked, 0.0, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Cannot remove %(product)s from %(dm)s — already picked %(picked)s.',
                    product=line.product_id.display_name,
                    dm=self.delivery_man_id.name,
                    picked=line.qty_picked,
                ))
            line.write({
                'qty_assigned': 0.0,
                'qty_to_deliver': 0.0,
                'qty_to_pick': 0.0,
            })


    def _sync_with_sale_order(self, ensure_visit_task=True):
        today = fields.Date.context_today(self)
        for rec in self:
            rec.sudo()._sync_lines_from_sale_order()
            new_state = rec._compute_dm_state()
            vals = {}
            if rec.state != new_state and rec.state != 'returned':
                vals['state'] = new_state
            if not rec.scheduled_date and new_state != 'not_ready':
                vals['scheduled_date'] = today
            if new_state not in ('picked', 'partial', 'delivered', 'returned') and rec.pick_picking_id and rec.pick_picking_id.state != 'done':
                vals['pick_picking_id'] = False
            if vals:
                rec.sudo().write(vals)
            if ensure_visit_task:
                rec._ensure_visit_task()

    def _ensure_visit_task(self):
        """Create/update a delivery-man visit task so distributor Visit Tasks list is combined.

        Never block invoice post / pick / deliver: reuse the unique
        (shop, date, booker, route, delivery_man kind) row, and use a savepoint
        so a UniqueViolation cannot abort the caller transaction.
        """
        Task = self.env['shahtaj.visit.task'].sudo()
        today = fields.Date.context_today(self)
        for rec in self:
            if rec.state == 'not_ready' or not rec.partner_id or not rec.delivery_man_id:
                continue
            booker = rec.order_booker_id
            if not booker:
                continue
            shop = rec.partner_id
            shop_routes = shop.route_ids
            if shop.route_id:
                shop_routes |= shop.route_id
            route = False
            if shop.route_id and shop.route_id in shop_routes:
                route = shop.route_id
            elif shop.route_ids:
                route = shop.route_ids[:1]
            else:
                for sched in booker.shahtaj_schedule_ids:
                    if sched.route_id and sched.route_id in shop_routes:
                        route = sched.route_id
                        break
            if not route:
                # Legacy / unassigned shops: still deliver; no visit task row.
                continue

            day = rec.scheduled_date or today
            task = rec.visit_task_id
            if not task:
                task = Task.search([
                    ('task_kind', '=', 'delivery_man'),
                    ('dm_delivery_id', '=', rec.id),
                ], limit=1)

            vals = {
                'task_kind': 'delivery_man',
                'delivery_man_id': rec.delivery_man_id.id,
                'dm_delivery_id': rec.id,
                'order_booker_id': booker.id,
                'route_id': route.id,
                'shop_id': shop.id,
                'scheduled_date': day,
            }
            if rec.state == 'delivered':
                vals['state'] = 'completed'
            elif rec.state == 'returned':
                vals['state'] = 'cancelled'
            elif rec.state in ('ready', 'picked', 'partial'):
                vals['state'] = (
                    'pending'
                    if not task or task.state in ('cancelled', 'pending')
                    else task.state
                )

            try:
                # Savepoint: DB unique errors must not poison invoice post.
                with self.env.cr.savepoint():
                    if task:
                        task.with_context(shahtaj_system_visit_write=True).write(vals)
                    else:
                        task = Task.with_context(
                            shahtaj_system_visit_write=True
                        ).create(vals)
            except Exception:
                # Race / leftover unique row: attach to existing job task if present.
                task = Task.search([
                    ('task_kind', '=', 'delivery_man'),
                    ('dm_delivery_id', '=', rec.id),
                ], limit=1)
                if not task:
                    _logger.exception(
                        'Skipping DM visit task for delivery %s (shop=%s)',
                        rec.id, shop.display_name,
                    )
                    continue
                try:
                    with self.env.cr.savepoint():
                        task.with_context(shahtaj_system_visit_write=True).write(vals)
                except Exception:
                    _logger.exception(
                        'Skipping DM visit task update for delivery %s (shop=%s)',
                        rec.id, shop.display_name,
                    )
                    continue
            if task and rec.visit_task_id != task:
                rec.sudo().write({'visit_task_id': task.id})

    @api.model
    def _sync_for_sale_orders(self, sale_orders):
        """Sync DM jobs for confirmed SOs.

        Refreshes lines, quantities, and status ('ready', 'picked', 'partial', etc.)
        on all existing delivery jobs for the given sales orders.
        """
        sale_orders = sale_orders.sudo().filtered(
            lambda o: o.state in ('sale', 'done')
        )
        if not sale_orders:
            return self.browse()

        touched = self.browse()
        DmDelivery = self.sudo()
        for order in sale_orders:
            existing_all = DmDelivery.search([('sale_order_id', '=', order.id)])
            for existing in existing_all:
                existing._sync_with_sale_order()
            touched |= existing_all
        return touched

    @api.model
    def action_assign_to_delivery_man(
        self,
        sale_order,
        delivery_man,
        scheduled_date=None,
        scheduled_time=0.0,
        assigned_by=None,
        line_qty_map=None,
    ):
        """Create/update one DM job for a confirmed SO (full order or partial share).

        line_qty_map: optional {sale_order_line_id: qty_assigned}.
        If omitted and this is the only job, assigns full ordered qty per line.
        """
        sale_order = sale_order.sudo()
        delivery_man = delivery_man.sudo()
        if not sale_order or not sale_order.exists():
            raise UserError(_('Select a sales order to assign.'))
        if sale_order.state not in ('sale', 'done'):
            raise UserError(_(
                'Only confirmed sales orders can be assigned to a delivery man.'
            ))
        if not delivery_man or not delivery_man.shahtaj_is_delivery_man:
            raise UserError(_('Select a valid delivery man.'))

        day = scheduled_date or fields.Date.context_today(self)
        assigned_by = assigned_by or self.env.user
        DmDelivery = self.sudo()

        job = DmDelivery.search([
            ('sale_order_id', '=', sale_order.id),
            ('delivery_man_id', '=', delivery_man.id),
        ], limit=1)

        if job and job.state in ('picked', 'partial', 'delivered', 'returned'):
            # Allow qty increase / date change, but not DM swap on this record.
            pass

        if not job:
            job = DmDelivery.create({
                'delivery_man_id': delivery_man.id,
                'sale_order_id': sale_order.id,
                'scheduled_date': day,
                'scheduled_time': scheduled_time or 0.0,
                'assigned_by_id': assigned_by.id,
                'assignment_mode': 'manual',
                'state': 'not_ready',
            })
        else:
            if job.state in ('delivered',) and line_qty_map is None:
                raise UserError(_(
                    'Delivery job for %(order)s / %(dm)s is already fully delivered.',
                    order=sale_order.name,
                    dm=delivery_man.name,
                ))
            job.write({
                'scheduled_date': day,
                'scheduled_time': scheduled_time or 0.0,
                'assigned_by_id': assigned_by.id,
                'assignment_mode': 'manual',
            })

        job._sync_lines_from_sale_order()
        if line_qty_map is None:
            # Whole remaining share for this DM when map not provided.
            other_jobs = DmDelivery.search([
                ('sale_order_id', '=', sale_order.id),
                ('id', '!=', job.id),
            ])
            line_qty_map = {}
            for sol in job._get_delivery_sale_lines():
                taken = 0.0
                for other in other_jobs:
                    for ol in other.line_ids.filtered(
                        lambda l, sid=sol.id: l.sale_order_line_id.id == sid
                    ):
                        taken += ol.qty_assigned
                remaining = max(sol.product_uom_qty - taken, 0.0)
                # Keep already picked on this job
                existing = job.line_ids.filtered(
                    lambda l, sid=sol.id: l.sale_order_line_id.id == sid
                )[:1]
                if existing:
                    remaining = max(remaining, existing.qty_picked)
                line_qty_map[sol.id] = remaining
        job._apply_line_assignments(line_qty_map)
        job._sync_with_sale_order()
        return job

    @api.model
    def action_apply_split_plan(self, sale_order, assignments, assigned_by=None):
        """Apply a full split plan for one SO.

        assignments: list of dicts
          {
            'delivery_man_id': int,
            'scheduled_date': date,
            'scheduled_time': float,
            'lines': {sale_order_line_id: qty},
          }
        """
        sale_order = sale_order.sudo()
        if not sale_order or sale_order.state not in ('sale', 'done'):
            raise UserError(_('Only confirmed sales orders can be assigned.'))
        if not assignments:
            raise UserError(_('Add at least one delivery man assignment.'))

        assigned_by = assigned_by or self.env.user
        DmDelivery = self.sudo()
        sale_lines = sale_order.order_line.filtered(
            lambda l: l.product_id and l.product_id.type == 'consu' and not l.display_type
        )
        if not sale_lines:
            raise UserError(_('This sales order has no deliverable products.'))

        # Validate totals per SO line
        totals = {sol.id: 0.0 for sol in sale_lines}
        dm_seen = set()
        for block in assignments:
            dm_id = block.get('delivery_man_id')
            if not dm_id:
                raise UserError(_('Each assignment needs a delivery man.'))
            if dm_id in dm_seen:
                raise UserError(_(
                    'Each delivery man can appear only once on a split plan. '
                    'Combine quantities for the same person into one job.'
                ))
            dm_seen.add(dm_id)
            lines = block.get('lines') or {}
            for sol in sale_lines:
                qty = lines.get(sol.id, 0.0) or 0.0
                rounding = sol.product_uom_id.rounding or 0.01
                if float_compare(qty, 0.0, precision_rounding=rounding) < 0:
                    raise UserError(_('Assigned quantity cannot be negative.'))
                totals[sol.id] += qty

        for sol in sale_lines:
            rounding = sol.product_uom_id.rounding or 0.01
            planned = totals[sol.id]
            ordered = sol.product_uom_qty
            if float_compare(planned, ordered, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Assigned qty for %(product)s is %(planned)s but the order '
                    'only has %(ordered)s.',
                    product=sol.product_id.display_name,
                    planned=planned,
                    ordered=ordered,
                ))

        # Keep jobs that already have stock movement; forbid removing them
        existing_jobs = DmDelivery.search([('sale_order_id', '=', sale_order.id)])
        planned_dm_ids = set(dm_seen)
        for job in existing_jobs:
            if job.delivery_man_id.id in planned_dm_ids:
                continue
            if job.state in ('picked', 'partial', 'delivered', 'returned') or any(
                l.qty_picked > 0 for l in job.line_ids
            ):
                raise UserError(_(
                    'Cannot remove %(dm)s from %(order)s — stock was already '
                    'picked or delivered on that job.',
                    dm=job.delivery_man_id.name,
                    order=sale_order.name,
                ))
            job.unlink()

        touched = DmDelivery.browse()
        for block in assignments:
            lines = {
                sol.id: (block.get('lines') or {}).get(sol.id, 0.0) or 0.0
                for sol in sale_lines
            }
            # Skip empty jobs (all zero) unless they already exist with progress
            if all(float_is_zero(q, precision_digits=6) for q in lines.values()):
                continue
            job = self.action_assign_to_delivery_man(
                sale_order=sale_order,
                delivery_man=self.env['res.users'].browse(block['delivery_man_id']),
                scheduled_date=block.get('scheduled_date'),
                scheduled_time=block.get('scheduled_time') or 0.0,
                assigned_by=assigned_by,
                line_qty_map=lines,
            )
            touched |= job

        return touched

    @api.model
    def _refresh_for_delivery_man(self, delivery_man):
        """Sync all delivery jobs assigned to this delivery man."""
        if not delivery_man:
            return self.browse()
        jobs = self.sudo().search([
            ('delivery_man_id', '=', delivery_man.id),
        ])
        for job in jobs:
            job._sync_with_sale_order()
        return jobs

    @api.model
    def web_search_read(self, domain, specification, offset=0, limit=None, order=None, count_limit=None):
        if self.env.user.shahtaj_is_delivery_man and not self.env.context.get('shahtaj_dm_skip_refresh'):
            self._refresh_for_delivery_man(self.env.user)
        return super().web_search_read(
            domain, specification, offset=offset, limit=limit, order=order, count_limit=count_limit,
        )

    @api.model
    def action_refresh_for_current_user(self):
        user = self.env.user
        if user.shahtaj_is_delivery_man:
            self._refresh_for_delivery_man(user)
        return {'type': 'ir.actions.client', 'tag': 'reload'}

    def action_refresh_list(self):
        self.ensure_one()
        self._refresh_for_delivery_man(self.delivery_man_id)
        self.sudo()._sync_with_sale_order()

    def _get_warehouse(self):
        warehouse = self.env['stock.warehouse'].search([
            ('company_id', '=', self.env.company.id),
        ], limit=1)
        if not warehouse:
            raise UserError(_('No warehouse found.'))
        return warehouse

    def _ensure_van_location(self):
        dm = self.delivery_man_id
        company = self.env.company
        acc_info = company._shahtaj_ensure_dm_accounting()
        van_stock_acc = acc_info.get('van_stock_acc')

        Location = self.env['stock.location'].sudo()
        van_parent = self.env.ref(
            'shahtaj_oil.stock_location_dm_vans',
            raise_if_not_found=False,
        )
        warehouse = self._get_warehouse()
        if not van_parent:
            parent_vals = {
                'name': 'Delivery Vans',
                'usage': 'transit',
                'location_id': warehouse.view_location_id.id,
                'company_id': company.id,
            }
            if van_stock_acc and hasattr(Location, 'valuation_account_id'):
                parent_vals['valuation_account_id'] = van_stock_acc.id
            van_parent = Location.create(parent_vals)
        elif van_stock_acc and hasattr(van_parent, 'valuation_account_id') and van_parent.valuation_account_id != van_stock_acc:
            van_parent.write({'valuation_account_id': van_stock_acc.id})

        existing = Location.search([
            ('location_id', '=', van_parent.id),
            ('name', '=', f"Van - {dm.name} [{dm.id}]"),
        ], limit=1)
        if existing:
            if van_stock_acc and hasattr(existing, 'valuation_account_id') and existing.valuation_account_id != van_stock_acc:
                existing.write({'valuation_account_id': van_stock_acc.id})
            return existing

        child_vals = {
            'name': f"Van - {dm.name} [{dm.id}]",
            'usage': 'transit',
            'location_id': van_parent.id,
            'company_id': company.id,
        }
        if van_stock_acc and hasattr(Location, 'valuation_account_id'):
            child_vals['valuation_account_id'] = van_stock_acc.id
        return Location.create(child_vals)

    def _retarget_sale_outgoing_to_van(self, van_location):
        """Point open SO outgoing moves at the van so deliver uses van stock."""
        self.ensure_one()
        pickings = self.sale_order_id.sudo().picking_ids.filtered(
            lambda p: p.state not in ('done', 'cancel') and p.picking_type_code == 'outgoing'
        )
        for picking in pickings:
            if picking.state == 'draft':
                picking.action_confirm()
            for move in picking.move_ids.filtered(lambda m: m.state not in ('done', 'cancel')):
                move.location_id = van_location.id
            picking.location_id = van_location.id
            picking.action_assign()

    def _reload_form(self, title=None, message=None, notif_type='success'):
        """Re-open form so statusbar/buttons refresh after pick/deliver."""
        self.ensure_one()
        action = {
            'type': 'ir.actions.act_window',
            'name': self.display_name,
            'res_model': 'shahtaj.dm.delivery',
            'res_id': self.id,
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'current',
            'context': dict(self.env.context),
        }
        if title:
            action['context'] = dict(action['context'], shahtaj_dm_flash={
                'title': title,
                'message': message or '',
                'type': notif_type,
            })
        return action

    def action_pick_stock(self):
        """Open pick wizard (editable quantities)."""
        self.ensure_one()
        self.sudo()._sync_with_sale_order()
        if self.state not in ('ready', 'picked', 'partial'):
            raise UserError(_('This order is not available for stock pickup.'))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Pick Stock to Van'),
            'res_model': 'shahtaj.dm.pick.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'active_id': self.id,
                'default_delivery_id': self.id,
            },
        }

    def _create_stock_picking(self, *, picking_type, location_id, location_dest_id, origin, move_vals_list, partner_id=False, sale_id=False):
        """Create a picking, then create moves separately (Odoo 19: stock.move has no ``name``)."""
        Picking = self.env['stock.picking'].sudo().with_context(
            default_name=False,
            tracking_disable=True,
        )
        Move = self.env['stock.move'].sudo().with_context(
            default_name=False,
            tracking_disable=True,
        )
        picking_vals = {
            'picking_type_id': picking_type.id,
            'location_id': location_id.id,
            'location_dest_id': location_dest_id.id,
            'origin': origin,
        }
        if partner_id:
            picking_vals['partner_id'] = partner_id.id if hasattr(partner_id, 'id') else partner_id
        if sale_id:
            picking_vals['sale_id'] = sale_id.id if hasattr(sale_id, 'id') else sale_id
        picking = Picking.create(picking_vals)

        for move_vals in move_vals_list:
            allowed = set(Move._fields) - {'id'}
            clean = {k: v for k, v in move_vals.items() if k in allowed}
            clean.pop('name', None)
            clean['picking_id'] = picking.id
            clean.setdefault('location_id', location_id.id)
            clean.setdefault('location_dest_id', location_dest_id.id)
            Move.create(clean)
        return picking

    def _pick_stock_with_qtys(self, qty_by_line_id, reload_form=True):
        """Pick given quantities (line_id → qty) from WH onto van."""
        self.ensure_one()
        self.sudo()._sync_with_sale_order()
        if self.state in ('delivered', 'returned'):
            raise UserError(_('Cannot pick stock for a finished/returned delivery.'))
        if self.state == 'not_ready':
            raise UserError(_('This order is not ready for stock pickup.'))

        van_location = self._ensure_van_location()
        warehouse = self._get_warehouse()
        picking_type = warehouse.int_type_id
        if not picking_type:
            raise UserError(_('No internal transfer type found for the warehouse.'))

        move_vals_list = []
        pick_updates = []
        for line in self.line_ids:
            qty = float(qty_by_line_id.get(line.id) or 0.0)
            if qty <= 0:
                continue
            if not line.product_uom_id:
                raise UserError(_(
                    'Missing UoM on delivery line for %(product)s.',
                    product=line.product_id.display_name,
                ))
            still_needed = max(line.qty_assigned - line.qty_picked, 0.0)
            if qty > still_needed + 1e-6:
                raise UserError(_(
                    'Cannot pick %(qty)s of %(product)s — only %(max)s still assigned to pick.',
                    qty=qty,
                    product=line.product_id.display_name,
                    max=still_needed,
                ))
            move_vals_list.append({
                'product_id': line.product_id.id,
                'product_uom_qty': qty,
                'product_uom': line.product_uom_id.id,
                'location_id': warehouse.lot_stock_id.id,
                'location_dest_id': van_location.id,
            })
            pick_updates.append((line, qty))

        if not move_vals_list:
            raise UserError(_('No products to pick.'))

        picking = self._create_stock_picking(
            picking_type=picking_type,
            location_id=warehouse.lot_stock_id,
            location_dest_id=van_location,
            origin=f"DM Pick: {self.sale_order_id.name}",
            move_vals_list=move_vals_list,
        )
        picking.action_confirm()
        picking.action_assign()
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
        picking.with_context(skip_backorder=True, skip_sms=True).button_validate()

        for line, qty in pick_updates:
            line.qty_picked = line.qty_picked + qty
            line.qty_to_pick = max(line.qty_assigned - line.qty_picked, 0.0)
            line.qty_to_deliver = max(line.qty_assigned - line.qty_delivered, 0.0)

        self._retarget_sale_outgoing_to_van(van_location)
        today = fields.Date.context_today(self)
        self.write({
            'state': 'partial' if any(l.qty_delivered > 0 for l in self.line_ids) else 'picked',
            'pick_picking_id': picking.id,
            'van_location_id': van_location.id,
            'scheduled_date': self.scheduled_date or today,
        })
        self._ensure_visit_task()
        if not reload_form:
            return True
        return self._reload_form(
            title=_('Stock picked'),
            message=_(
                'Warehouse reduced. Stock for %(shop)s is now on the van.',
                shop=self.partner_id.display_name,
            ),
        )

    def action_bulk_pick_stock(self):
        """Open Today's Load dashboard (editable collective pick)."""
        return self.env['shahtaj.dm.today.load'].action_open()

    def _require_field_notes(self, purpose):
        self.ensure_one()
        if not (self.notes or '').strip():
            raise UserError(_(
                'Add a short note first (why %(purpose)s), then try again.',
                purpose=purpose,
            ))

    def _assert_can_update_field_state(self):
        self.ensure_one()
        if self.state not in ('picked', 'partial'):
            raise UserError(_(
                'Load stock onto the van first, then update the stop status.'
            ))
        if self.field_state == 'done':
            raise UserError(_('This stop is already done.'))

    def action_field_in_transit(self):
        """DM: mark stop as on the way to the shop."""
        self.ensure_one()
        self._assert_can_update_field_state()
        self.write({'field_state': 'in_transit'})
        return True

    def action_field_not_attended(self):
        """DM: shop closed / no one available — note required."""
        self.ensure_one()
        self._assert_can_update_field_state()
        self._require_field_notes(_('the shop was closed / not attended'))
        self.write({'field_state': 'not_attended'})
        return True

    def action_field_failed(self):
        """DM: could not deliver — stock stays on van; note required."""
        self.ensure_one()
        self._assert_can_update_field_state()
        self._require_field_notes(_('delivery failed'))
        self.write({'field_state': 'failed'})
        return True

    def action_field_reset_pending(self):
        """Distributor: clear a closed/failed stop so DM can try again."""
        self.ensure_one()
        if self.field_state not in ('not_attended', 'failed', 'in_transit'):
            raise UserError(_('Only On the Way / Shop Closed / Could Not Deliver can be reset.'))
        if self.state in ('delivered', 'returned'):
            raise UserError(_('Cannot reset stop on a finished stock job.'))
        self.write({'field_state': 'pending'})
        return True

    def action_deliver_to_shop(self):
        """Open deliver wizard (editable qty + GPS)."""
        self.ensure_one()
        self.sudo()._sync_with_sale_order()
        if self.state not in ('picked', 'partial'):
            raise UserError(_('Pick stock onto the van before delivering to the shop.'))
        if not self.van_location_id:
            raise UserError(_('Missing van location. Pick stock again.'))
        on_van = sum(max(l.qty_picked - l.qty_delivered, 0.0) for l in self.line_ids)
        if on_van <= 0:
            raise UserError(_('No stock on the van for this shop. Pick stock first.'))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Deliver to Shop'),
            'res_model': 'shahtaj.dm.deliver.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'active_id': self.id,
                'default_delivery_id': self.id,
            },
        }

    def _deliver_to_shop_with_qtys(
        self,
        qty_by_line_id,
        latitude=0.0,
        longitude=0.0,
        distance_m=0.0,
        reload_form=True,
    ):
        """Deliver given van qtys to shop; supports partial / multi-attempt."""
        self.ensure_one()
        if self.state not in ('picked', 'partial'):
            raise UserError(_('Pick stock onto the van before delivering.'))
        if not self.van_location_id:
            raise UserError(_('Missing van location.'))

        warehouse = self._get_warehouse()
        customer_loc = self.partner_id.property_stock_customer
        if not customer_loc:
            customer_loc = self.env.ref('stock.stock_location_customers', raise_if_not_found=False)
        if not customer_loc:
            raise UserError(_('No customer stock location found.'))
        out_type = warehouse.out_type_id
        if not out_type:
            raise UserError(_('No delivery operation type on the warehouse.'))

        move_vals_list = []
        deliver_updates = []
        for line in self.line_ids:
            qty = float(qty_by_line_id.get(line.id) or 0.0)
            if qty <= 0:
                continue
            on_van = max(line.qty_picked - line.qty_delivered, 0.0)
            if qty > on_van + 1e-6:
                raise UserError(_(
                    'Cannot deliver %(qty)s of %(product)s — only %(max)s on van.',
                    qty=qty,
                    product=line.product_id.display_name,
                    max=on_van,
                ))
            vals = {
                'product_id': line.product_id.id,
                'product_uom_qty': qty,
                'product_uom': line.product_uom_id.id,
                'location_id': self.van_location_id.id,
                'location_dest_id': customer_loc.id,
            }
            if line.sale_order_line_id:
                vals['sale_line_id'] = line.sale_order_line_id.id
            move_vals_list.append(vals)
            deliver_updates.append((line, qty))

        if not move_vals_list:
            raise UserError(_('No products to deliver.'))

        picking = self._create_stock_picking(
            picking_type=out_type,
            location_id=self.van_location_id,
            location_dest_id=customer_loc,
            origin=self.sale_order_id.name,
            move_vals_list=move_vals_list,
            partner_id=self.partner_id,
            sale_id=self.sale_order_id,
        )
        picking.action_confirm()
        picking.action_assign()
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            move.picked = True
        picking.with_context(skip_backorder=True, skip_sms=True).button_validate()

        for line, qty in deliver_updates:
            line.qty_delivered = line.qty_delivered + qty
            line.qty_to_deliver = max(line.qty_assigned - line.qty_delivered, 0.0)
            line.qty_to_pick = max(line.qty_assigned - line.qty_picked, 0.0)

        new_state = self._compute_dm_state()
        vals = {
            'state': new_state,
            'delivery_picking_id': picking.id,
            'check_in_latitude': latitude or 0.0,
            'check_in_longitude': longitude or 0.0,
            'check_in_distance_m': distance_m or 0.0,
            'gps_verified': True,
        }
        if new_state == 'delivered':
            vals['field_state'] = 'done'
        elif self.field_state in ('pending', 'not_attended', 'failed'):
            # Successful handoff at shop — treat remaining work as still on the route.
            vals['field_state'] = 'in_transit'
        self.write(vals)
        if new_state == 'delivered':
            self._ensure_dm_visit_completed()
        else:
            self._ensure_visit_task()
        if reload_form:
            return self._reload_form(
                title=_('Delivered'),
                message=_(
                    'Stock delivered to %(shop)s from the van.',
                    shop=self.partner_id.display_name,
                ),
            )
        return True

    def action_return_to_warehouse(self):
        """Return undelivered van stock for this shop order back to warehouse."""
        self.ensure_one()
        if self.state not in ('picked', 'partial'):
            raise UserError(_('Only picked/partial deliveries can return van stock to warehouse.'))
        if not self.van_location_id:
            raise UserError(_('No van location on this delivery.'))

        warehouse = self._get_warehouse()
        picking_type = warehouse.int_type_id
        move_vals_list = []
        for line in self.line_ids:
            return_qty = max(line.qty_picked - line.qty_delivered, 0.0)
            if return_qty <= 0:
                continue
            move_vals_list.append({
                'product_id': line.product_id.id,
                'product_uom_qty': return_qty,
                'product_uom': line.product_uom_id.id,
                'location_id': self.van_location_id.id,
                'location_dest_id': warehouse.lot_stock_id.id,
            })
            # Keep qty_delivered; reduce qty_picked to what was actually delivered
            line.qty_picked = line.qty_delivered
            line.qty_to_pick = max(line.qty_assigned - line.qty_picked, 0.0)
            line.qty_to_deliver = max(line.qty_assigned - line.qty_delivered, 0.0)
        if not move_vals_list:
            raise UserError(_('No undelivered van stock to return for this order.'))

        picking = self._create_stock_picking(
            picking_type=picking_type,
            location_id=self.van_location_id,
            location_dest_id=warehouse.lot_stock_id,
            origin=f"DM Return: {self.sale_order_id.name}",
            move_vals_list=move_vals_list,
        )
        picking.action_confirm()
        picking.action_assign()
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
        picking.with_context(skip_backorder=True, skip_sms=True).button_validate()

        self.write({
            'state': 'returned',
            'return_picking_id': picking.id,
        })
        self._ensure_visit_task()
        return self._reload_form(
            title=_('Returned to warehouse'),
            message=_(
                'Undelivered van stock for %(shop)s was returned to the warehouse.',
                shop=self.partner_id.display_name,
            ),
            notif_type='warning',
        )

    def _ensure_dm_visit_completed(self):
        """Log a completed delivery visit for combined Shop Visits list."""
        Visit = self.env['shahtaj.visit'].sudo()
        for rec in self:
            rec._ensure_visit_task()
            task = rec.visit_task_id
            if not task:
                continue
            visit = Visit.search([
                ('visit_kind', '=', 'delivery_man'),
                ('dm_delivery_id', '=', rec.id),
            ], limit=1)
            vals = {
                'visit_kind': 'delivery_man',
                'dm_delivery_id': rec.id,
                'delivery_man_id': rec.delivery_man_id.id,
                'visit_task_id': task.id,
                'order_booker_id': rec.order_booker_id.id,
                'shop_id': rec.partner_id.id,
                'shop_name': rec.partner_id.name or rec.partner_id.display_name,
                'route_id': task.route_id.id,
                'route_name': task.route_id.name or '',
                'state': 'completed',
                'outcome': 'order',
                'sale_order_id': rec.sale_order_id.id,
                'started_at': fields.Datetime.now(),
                'ended_at': fields.Datetime.now(),
            }
            if visit:
                visit.with_context(shahtaj_system_visit_write=True).write(vals)
            else:
                Visit.with_context(shahtaj_system_visit_write=True).create(vals)
            task.with_context(shahtaj_system_visit_write=True).write({'state': 'completed'})

    def action_view_sale_order(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': self.sale_order_id.name,
            'res_model': 'sale.order',
            'res_id': self.sale_order_id.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def action_print_invoice(self):
        self.ensure_one()
        invoices = self.sale_order_id.invoice_ids.filtered(lambda inv: inv.state == 'posted')
        if not invoices:
            raise UserError(_('No posted invoice found for this order.'))
        return self.env.ref('account.account_invoices').report_action(invoices[0])

    def _action_open_van_quants(self, van_location, title=None):
        """Open stock.quant for a van location (transit — must not use Internal filter)."""
        van_location.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': title or _('Van Stock'),
            'res_model': 'stock.quant',
            'view_mode': 'list,form',
            'domain': [
                ('location_id', '=', van_location.id),
                ('quantity', '!=', 0),
            ],
            'context': {
                # Do NOT set search_default_internal_loc — vans are transit locations
                # and that filter would hide every row.
                'default_location_id': van_location.id,
                'inventory_report_mode': True,
            },
        }

    def action_view_van_quants(self):
        self.ensure_one()
        if not self.van_location_id:
            raise UserError(_('Pick stock first to open van inventory.'))
        return self._action_open_van_quants(
            self.van_location_id,
            title=_('Van Stock — %(loc)s', loc=self.van_location_id.display_name),
        )

    @api.model
    def action_open_my_van_stock(self):
        """Menu action: show current delivery man's van inventory."""
        user = self.env.user
        van = self.env['stock.location'].sudo().browse()
        delivery = self.search([
            ('delivery_man_id', '=', user.id),
            ('van_location_id', '!=', False),
        ], order='write_date desc', limit=1)
        if delivery:
            van = delivery.van_location_id
        if not van:
            van_parent = self.env.ref(
                'shahtaj_oil.stock_location_dm_vans',
                raise_if_not_found=False,
            )
            domain = [('name', '=', f'Van - {user.name} [{user.id}]')]
            if van_parent:
                domain.append(('location_id', '=', van_parent.id))
            van = self.env['stock.location'].sudo().search(domain, limit=1)
        if not van:
            raise UserError(_(
                'No van stock yet. Open a delivery and use Pick Stock from Warehouse first.'
            ))
        return self._action_open_van_quants(van, title=_('My Van Stock'))


class ShahtajDmDeliveryLine(models.Model):
    _name = 'shahtaj.dm.delivery.line'
    _description = 'Delivery Man Delivery Line'

    delivery_id = fields.Many2one(
        'shahtaj.dm.delivery',
        string='Delivery',
        required=True,
        ondelete='cascade',
        index=True,
    )
    sale_order_line_id = fields.Many2one(
        'sale.order.line',
        string='Order Line',
        ondelete='set null',
    )
    product_id = fields.Many2one(
        'product.product',
        string='Product',
        required=True,
    )
    product_uom_id = fields.Many2one(
        'uom.uom',
        string='UoM',
    )
    qty_ordered = fields.Float(
        string='SO Ordered',
        digits='Product Unit of Measure',
        help='Quantity on the sales order line (shared across split jobs).',
    )
    qty_assigned = fields.Float(
        string='Assigned to DM',
        digits='Product Unit of Measure',
        help='This delivery man\'s share of the sales order line (M2 split).',
    )
    qty_to_deliver = fields.Float(
        string='Still on This Job',
        digits='Product Unit of Measure',
        help='Assigned minus already delivered on this job.',
    )
    qty_to_pick = fields.Float(
        string='To Pick',
        digits='Product Unit of Measure',
        help='Suggested / last planned pick qty (editable in pick wizard).',
    )
    qty_picked = fields.Float(
        string='Picked to Van',
        digits='Product Unit of Measure',
        help='Cumulative quantity moved from warehouse to van for this shop order.',
    )
    qty_delivered = fields.Float(
        string='Delivered to Shop',
        digits='Product Unit of Measure',
        help='Cumulative quantity delivered from van to shop.',
    )
    qty_remaining_on_van = fields.Float(
        string='Left on Van',
        compute='_compute_qty_remaining_on_van',
        digits='Product Unit of Measure',
    )

    @api.depends('qty_picked', 'qty_delivered')
    def _compute_qty_remaining_on_van(self):
        for line in self:
            line.qty_remaining_on_van = max(line.qty_picked - line.qty_delivered, 0.0)
