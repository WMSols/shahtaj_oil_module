# -*- coding: utf-8 -*-
"""Delivery Man workflow: pick WH→van, deliver van→shop, return van→WH."""
import logging
from collections import defaultdict

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError
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
            ('in_transit', 'Heading to Shop'),
            ('not_attended', 'Shop Closed'),
            ('failed', 'Could Not Deliver'),
            ('done', 'Stop Done'),
        ],
        string='Stop',
        default='pending',
        required=True,
        index=True,
        help=(
            'This shop stop only (not the DM day status).\n'
            'Not Started → Heading to Shop → Shop Closed / Could Not Deliver / Stop Done.\n'
            'Day-level “Left Office” is on My Day Session, not this field.\n'
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
        string='Planned Delivery Time',
        help='Planned time of day (distributor assignment).',
    )
    picked_at = fields.Datetime(
        string='Picked At',
        readonly=True,
        copy=False,
        help='When stock was first loaded onto the van for this job.',
    )
    delivered_at = fields.Datetime(
        string='Delivered At',
        readonly=True,
        copy=False,
        help='When stock was last delivered to the shop (updated on each successful deliver).',
    )
    receiver_name = fields.Char(
        string='Receiver Name',
        copy=False,
        help='Person who received the stock at the shop (required on deliver).',
    )
    delivery_proof_image = fields.Image(
        string='Delivery Proof Photo',
        max_width=1920,
        max_height=1920,
        copy=False,
        help='Photo of delivered stock / handoff (required on deliver).',
    )
    has_delivery_proof = fields.Boolean(
        string='Has Delivery Proof',
        compute='_compute_has_delivery_proof',
        store=True,
        index=True,
        help='Stored flag so plan/list APIs avoid loading the proof image binary.',
    )

    @api.depends('delivery_proof_image')
    def _compute_has_delivery_proof(self):
        for rec in self:
            rec.has_delivery_proof = bool(rec.delivery_proof_image)

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
    # ── Shop balance (share with shopkeeper at the stop) ──────────────
    shop_outstanding_balance = fields.Monetary(
        string='Shop Outstanding',
        compute='_compute_shop_balance_info',
        currency_field='currency_id',
        help='Posted receivable the shop currently owes (AR).',
    )
    shop_unpaid_invoice_amount = fields.Monetary(
        string='Unpaid / Partial Invoices',
        compute='_compute_shop_balance_info',
        currency_field='currency_id',
        help='Sum of remaining amounts on unpaid and partially paid invoices.',
    )
    shop_invoice_count = fields.Integer(
        string='Shop Invoices',
        compute='_compute_shop_balance_info',
    )
    shop_unpaid_invoice_count = fields.Integer(
        string='Open Invoices',
        compute='_compute_shop_balance_info',
    )
    shop_credit_limit = fields.Monetary(
        string='Shop Credit Limit',
        compute='_compute_shop_balance_info',
        currency_field='currency_id',
    )
    shop_category = fields.Selection(
        related='partner_id.shahtaj_shop_category',
        string='Shop Category',
        readonly=True,
    )
    shop_invoice_ids = fields.Many2many(
        'account.move',
        string='Shop Invoices',
        compute='_compute_shop_balance_info',
        help='Posted customer invoices / credit notes for this shop.',
    )
    shop_invoices_html = fields.Html(
        string='Shop Invoice Summary',
        compute='_compute_shop_balance_info',
        sanitize=False,
    )
    shop_paid_invoices_html = fields.Html(
        string='Recently Paid Invoices',
        compute='_compute_shop_balance_info',
        sanitize=False,
        help='Last 10 fully paid invoices with who collected / method.',
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

    @api.depends('partner_id', 'sale_order_id.company_id')
    def _compute_shop_balance_info(self):
        """Shop AR + invoice payment status for field sharing (DM / distributor)."""
        Move = self.env['account.move'].sudo()
        payment_labels = {
            'not_paid': _('Unpaid'),
            'partial': _('Partial'),
            'in_payment': _('In Payment'),
            'paid': _('Fully Paid'),
            'reversed': _('Reversed'),
            'invoicing_legacy': _('Legacy'),
        }
        type_labels = {
            'out_invoice': _('Invoice'),
            'out_refund': _('Credit Note'),
        }
        for rec in self:
            shop = rec.partner_id
            if not shop:
                rec.shop_outstanding_balance = 0.0
                rec.shop_unpaid_invoice_amount = 0.0
                rec.shop_invoice_count = 0
                rec.shop_unpaid_invoice_count = 0
                rec.shop_credit_limit = 0.0
                rec.shop_invoice_ids = False
                rec.shop_invoices_html = (
                    '<p class="text-muted mb-0">No shop linked to this delivery.</p>'
                )
                rec.shop_paid_invoices_html = (
                    '<p class="text-muted mb-0">No shop linked to this delivery.</p>'
                )
                continue

            shop_sudo = shop.sudo()
            company = rec.sale_order_id.company_id or self.env.company
            commercial = shop_sudo.commercial_partner_id
            invoices = Move.search([
                ('move_type', 'in', ('out_invoice', 'out_refund')),
                ('state', '=', 'posted'),
                ('partner_id', 'child_of', commercial.id),
                ('company_id', '=', company.id),
            ], order='invoice_date desc, name desc', limit=100)

            # Unpaid / partial first, then paid, keep date order within groups.
            rank = {
                'not_paid': 0,
                'partial': 1,
                'in_payment': 2,
                'paid': 3,
                'reversed': 4,
                'invoicing_legacy': 5,
            }
            invoices = invoices.sorted(
                key=lambda m: (
                    rank.get(m.payment_state, 9),
                    -(m.invoice_date.toordinal() if m.invoice_date else 0),
                    -m.id,
                ),
            )

            unpaid = invoices.filtered(
                lambda m: m.payment_state in ('not_paid', 'partial', 'in_payment')
            )
            # Residual: invoices positive, credit notes reduce owed display carefully.
            unpaid_amount = 0.0
            for inv in unpaid:
                residual = abs(inv.amount_residual)
                if inv.move_type == 'out_refund':
                    unpaid_amount -= residual
                else:
                    unpaid_amount += residual

            rec.shop_outstanding_balance = shop_sudo.credit or 0.0
            rec.shop_credit_limit = (
                shop_sudo.credit_limit
                if shop_sudo.use_partner_credit_limit
                else 0.0
            )
            rec.shop_invoice_ids = invoices
            rec.shop_invoice_count = len(invoices)
            rec.shop_unpaid_invoice_count = len(unpaid)
            rec.shop_unpaid_invoice_amount = unpaid_amount

            if not invoices:
                rec.shop_invoices_html = (
                    '<p class="text-muted mb-0">No posted invoices for this shop yet.</p>'
                )
            else:
                rows = []
                for inv in invoices:
                    state = inv.payment_state or ''
                    label = payment_labels.get(state, state or '—')
                    badge = {
                        'not_paid': '#dc3545',
                        'partial': '#fd7e14',
                        'in_payment': '#0d6efd',
                        'paid': '#198754',
                        'reversed': '#6c757d',
                    }.get(state, '#6c757d')
                    inv_date = inv.invoice_date.isoformat() if inv.invoice_date else '—'
                    due = inv.invoice_date_due.isoformat() if inv.invoice_date_due else '—'
                    rows.append(
                        '<tr>'
                        f'<td>{inv.name or "—"}</td>'
                        f'<td>{type_labels.get(inv.move_type, inv.move_type)}</td>'
                        f'<td>{inv_date}</td>'
                        f'<td>{due}</td>'
                        f'<td style="text-align:right;">{inv.amount_total:,.2f}</td>'
                        f'<td style="text-align:right;">{inv.amount_residual:,.2f}</td>'
                        f'<td><span style="background:{badge};color:#fff;padding:2px 8px;'
                        f'border-radius:4px;font-size:12px;">{label}</span></td>'
                        '</tr>'
                    )
                rec.shop_invoices_html = (
                    '<div class="table-responsive">'
                    '<table class="table table-sm table-striped mb-0">'
                    '<thead><tr>'
                    '<th>Number</th><th>Type</th><th>Date</th><th>Due</th>'
                    '<th style="text-align:right;">Total</th>'
                    '<th style="text-align:right;">Remaining</th>'
                    '<th>Payment</th>'
                    '</tr></thead>'
                    f'<tbody>{"".join(rows)}</tbody></table></div>'
                )

            # Last 10 paid + collector (same data as recovery/shop API).
            Service = self.env['shahtaj.dm.recovery.service']
            paid_rows = Service._paid_invoice_rows(
                Service._paid_customer_invoices(shop, company, limit=10),
            )
            if not paid_rows:
                rec.shop_paid_invoices_html = (
                    '<p class="text-muted mb-0">No fully paid invoices yet for this shop.</p>'
                )
            else:
                paid_html_rows = []
                for row in paid_rows:
                    parts = []
                    for pay in row.get('payments') or []:
                        who = pay.get('collected_by_dm_name') or 'Office / other'
                        method = pay.get('payment_method') or '—'
                        date = pay.get('payment_date') or '—'
                        amount = float(pay.get('amount') or 0.0)
                        cheque = pay.get('cheque_number') or ''
                        bit = f'{who} · {method} · {date} · {amount:,.2f}'
                        if cheque:
                            bit = f'{bit} · #{cheque}'
                        parts.append(bit)
                    info = '<br/>'.join(parts) if parts else '—'
                    paid_html_rows.append(
                        '<tr>'
                        f'<td>{row.get("name") or "—"}</td>'
                        f'<td>{row.get("invoice_date") or "—"}</td>'
                        f'<td>{row.get("paid_date") or "—"}</td>'
                        f'<td style="text-align:right;">{float(row.get("amount_total") or 0):,.2f}</td>'
                        f'<td>{info}</td>'
                        '</tr>'
                    )
                rec.shop_paid_invoices_html = (
                    '<div class="table-responsive">'
                    '<table class="table table-sm table-striped mb-0">'
                    '<thead><tr>'
                    '<th>Number</th><th>Invoice Date</th><th>Paid Date</th>'
                    '<th style="text-align:right;">Total</th>'
                    '<th>Collected by / method</th>'
                    '</tr></thead>'
                    f'<tbody>{"".join(paid_html_rows)}</tbody></table></div>'
                )

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

    def _shahtaj_planning_field_changed(self, field_name, new_value):
        """True when a distributor planning field would actually change."""
        self.ensure_one()
        old = self[field_name]
        if field_name == 'delivery_man_id':
            old_id = old.id if old else False
            if isinstance(new_value, models.BaseModel):
                new_id = new_value.id if new_value else False
            else:
                new_id = new_value or False
            return old_id != new_id
        if field_name == 'scheduled_date':
            old_d = fields.Date.to_date(old) if old else False
            new_d = fields.Date.to_date(new_value) if new_value else False
            return old_d != new_d
        if field_name == 'scheduled_time':
            return float_compare(old or 0.0, new_value or 0.0, precision_digits=6) != 0
        if field_name == 'notes':
            return (old or '') != (new_value or '')
        return old != new_value

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
            changing = self.filtered(
                lambda rec: any(
                    rec._shahtaj_planning_field_changed(key, vals[key])
                    for key in planning_vals
                )
            )
            locked = changing.filtered(lambda rec: rec._shahtaj_is_processing_locked())
            if locked:
                raise UserError(_(
                    'Cannot change delivery planning for %(names)s — '
                    'stock is already picked or delivery is finished.',
                    names=', '.join(locked.mapped('display_name')),
                ))
            if changing:
                self.env['shahtaj.activity.log'].log_model_field_changes(
                    changing,
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
                    # Do NOT re-inflate intentional zeros on an existing sole job
                    # (legacy backfill only for brand-new lines below).
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
                    # New product line on a sole job → default to full ordered share.
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
                if float_compare(qty, line.qty_delivered, precision_rounding=rounding) < 0:
                    raise UserError(_(
                        'Cannot set assigned qty %(qty)s of %(product)s below '
                        'already delivered %(delivered)s on %(dm)s. '
                        'Use Undo Delivery to Shop first if you need to change the plan.',
                        qty=qty,
                        product=sol.product_id.display_name,
                        delivered=line.qty_delivered,
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
            # Keep Stop aligned: don't leave Stop Done when Stock is Ready/Picked.
            stop = rec._shahtaj_stop_for_stock_state(new_state)
            if stop and rec.field_state != stop:
                vals['field_state'] = stop
            if vals:
                rec.sudo().with_context(shahtaj_skip_planning_log=True).write(vals)
            if ensure_visit_task:
                rec._ensure_visit_task()

    def _shahtaj_stop_for_stock_state(self, stock_state):
        """Target Stop after stock sync/undo. Only clears stale ``done``.

        Returns field_state value to write, or False to leave Stop unchanged
        (Shop Closed / Could Not Deliver stay as set by the DM).
        """
        self.ensure_one()
        any_delivered = any((l.qty_delivered or 0.0) > 0 for l in self.line_ids)
        if stock_state == 'delivered':
            return 'done'
        if stock_state == 'returned':
            return False
        if self.field_state == 'done' and not any_delivered:
            if stock_state in ('picked', 'partial'):
                return 'in_transit'
            return 'pending'
        return False

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
            elif rec.state == 'partial':
                # Still open — never keep a stale completed task after undo.
                vals['state'] = 'in_progress'
            elif rec.state in ('ready', 'picked'):
                # Re-open after undo / re-invoice so DM dashboard matches Stock.
                vals['state'] = 'pending'

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
                rec.sudo().with_context(shahtaj_skip_planning_log=True).write({
                    'visit_task_id': task.id,
                })

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
        sale_order._shahtaj_assert_not_cancelled()
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
            write_vals = {
                'assigned_by_id': assigned_by.id,
                'assignment_mode': 'manual',
            }
            # Picked / partial / delivered jobs keep delivery man and day frozen.
            # Remaining qty can still be assigned (same DM or an extra DM).
            if not job._shahtaj_is_processing_locked():
                write_vals['scheduled_date'] = day
                write_vals['scheduled_time'] = scheduled_time or 0.0
            job.write(write_vals)

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
        sale_order._shahtaj_assert_not_cancelled()
        sale_order._shahtaj_require_posted_invoice_for_dm()
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
            dm_user = self.env['res.users'].browse(block['delivery_man_id'])
            all_zero = all(float_is_zero(q, precision_digits=6) for q in lines.values())
            if all_zero:
                # Clear stale shares: never leave old qty_assigned when wizard shows 0.
                existing = DmDelivery.search([
                    ('sale_order_id', '=', sale_order.id),
                    ('delivery_man_id', '=', dm_user.id),
                ], limit=1)
                if not existing:
                    continue
                has_progress = (
                    existing.state in ('picked', 'partial', 'delivered', 'returned')
                    or any(
                        not float_is_zero(l.qty_picked, precision_digits=6)
                        or not float_is_zero(l.qty_delivered, precision_digits=6)
                        for l in existing.line_ids
                    )
                )
                if has_progress:
                    # Apply zeros → raises if below picked/delivered (correct guard).
                    existing._apply_line_assignments(lines)
                    existing._sync_with_sale_order()
                    touched |= existing
                else:
                    existing.unlink()
                continue

            job = self.action_assign_to_delivery_man(
                sale_order=sale_order,
                delivery_man=dm_user,
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

    @api.model
    def _ensure_van_location_for_dm(self, dm):
        """Create/find the transit van location for a delivery man (no job required)."""
        dm.ensure_one()
        if not dm.shahtaj_is_delivery_man:
            raise UserError(_('%(user)s is not a delivery man.', user=dm.display_name))
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

    def _ensure_van_location(self):
        self.ensure_one()
        return self._ensure_van_location_for_dm(self.delivery_man_id)

    @api.model
    def _shahtaj_free_wh_van_transfer(self, dm, qty_by_product, direction):
        """Free WH ↔ van internal transfer (does not update delivery job lines).

        :param dm: res.users delivery man
        :param qty_by_product: {product_id: qty}
        :param direction: 'to_van' (WH→van) or 'to_wh' (van→WH)
        """
        dm.ensure_one()
        user = self.env.user
        if not dm.shahtaj_is_delivery_man:
            raise UserError(_('%(user)s is not a delivery man.', user=dm.display_name))
        if user.shahtaj_is_delivery_man and user.id != dm.id:
            if not (
                user.has_group('shahtaj_oil.group_shahtaj_distributor')
                or user.has_group('shahtaj_oil.group_shahtaj_native_distributor_ui')
            ):
                raise AccessError(_('You can only move stock on your own van.'))
        if direction not in ('to_van', 'to_wh'):
            raise UserError(_('Invalid transfer direction.'))

        warehouse = self._get_warehouse()
        picking_type = warehouse.int_type_id
        if not picking_type:
            raise UserError(_('No internal transfer type found for the warehouse.'))

        van = self._ensure_van_location_for_dm(dm)
        wh = warehouse.lot_stock_id
        if direction == 'to_van':
            location_id, location_dest_id = wh, van
            origin = f'DM Free Load: {dm.name}'
        else:
            location_id, location_dest_id = van, wh
            origin = f'DM Free Return: {dm.name}'

        Product = self.env['product.product'].sudo()
        move_vals_list = []
        for product_id, qty in qty_by_product.items():
            qty = float(qty or 0.0)
            if qty <= 0:
                continue
            product = Product.browse(product_id)
            if not product.exists():
                continue
            move_vals_list.append({
                'product_id': product.id,
                'product_uom_qty': qty,
                'product_uom': product.uom_id.id,
                'location_id': location_id.id,
                'location_dest_id': location_dest_id.id,
            })
        if not move_vals_list:
            raise UserError(_('Set a quantity on at least one product.'))

        # Van→WH free return may only use surplus (not stock reserved for open jobs).
        if direction == 'to_wh':
            self._shahtaj_assert_van_surplus(
                dm,
                {m['product_id']: m['product_uom_qty'] for m in move_vals_list},
                _('return to warehouse'),
            )

        # Validate stock availability before moving
        Quant = self.env['stock.quant'].sudo()
        for move in move_vals_list:
            quants = Quant.search([
                ('product_id', '=', move['product_id']),
                ('location_id', '=', move['location_id']),
            ])
            if direction == 'to_wh':
                available = sum(quants.mapped('quantity'))
            else:
                available = sum(quants.mapped('available_quantity'))
            if available + 1e-6 < move['product_uom_qty']:
                product = Product.browse(move['product_id'])
                place = _('van') if direction == 'to_wh' else _('warehouse')
                raise UserError(_(
                    'Not enough stock of %(product)s on the %(place)s '
                    '(need %(need)s, available %(avail)s).',
                    product=product.display_name,
                    place=place,
                    need=move['product_uom_qty'],
                    avail=available,
                ))

        picking = self._create_stock_picking(
            picking_type=picking_type,
            location_id=location_id,
            location_dest_id=location_dest_id,
            origin=origin,
            move_vals_list=move_vals_list,
        )
        picking.action_confirm()
        picking.action_assign()
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
        picking.with_context(skip_backorder=True, skip_sms=True).button_validate()
        return picking

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
        self.sale_order_id._shahtaj_assert_not_cancelled()
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

    @api.model
    def _shahtaj_today_open_jobs_domain(self, dm, day=None):
        """Open jobs for Today Load: today, unscheduled, or overdue only.

        Excludes future-dated jobs so Still Need matches Confirm Pick.
        """
        day = day or fields.Date.context_today(self)
        return [
            ('delivery_man_id', '=', dm.id),
            ('state', 'in', ('ready', 'picked', 'partial')),
            '|', '|',
            ('scheduled_date', '=', day),
            ('scheduled_date', '=', False),
            ('scheduled_date', '<', day),
        ]

    @api.model
    def _shahtaj_unattributed_van_qty_map(self, dm, product_ids=None):
        """Physical van qty not already tied to open job lines (picked − delivered).

        Leftover from prior days / free van loads can cover today's Still Need
        without another warehouse pick. Also the only stock allowed for walk-in
        / free van→WH return while jobs are still open.
        """
        dm.ensure_one()
        van = dm._shahtaj_get_van_location()
        if not van:
            return {}
        pid_filter = set(product_ids) if product_ids is not None else None
        Quant = self.env['stock.quant'].sudo()
        qdomain = [
            ('location_id', '=', van.id),
            ('quantity', '!=', 0),
        ]
        if pid_filter is not None:
            if not pid_filter:
                return {}
            qdomain.append(('product_id', 'in', list(pid_filter)))
        physical = {
            row['product_id'][0]: float(row.get('quantity') or 0.0)
            for row in Quant.read_group(qdomain, ['quantity:sum'], ['product_id'])
            if row.get('product_id')
        }
        attributed = defaultdict(float)
        open_jobs = self.search([
            ('delivery_man_id', '=', dm.id),
            ('state', 'in', ('ready', 'picked', 'partial')),
        ])
        for line in open_jobs.mapped('line_ids'):
            if not line.product_id:
                continue
            pid = line.product_id.id
            if pid_filter is not None and pid not in pid_filter:
                continue
            left = line.qty_picked - line.qty_delivered
            if left > 0:
                attributed[pid] += left
        pids = set(physical) | set(attributed)
        if pid_filter is not None:
            pids &= pid_filter
        return {
            pid: max(0.0, physical.get(pid, 0.0) - attributed.get(pid, 0.0))
            for pid in pids
        }

    @api.model
    def _shahtaj_assert_van_surplus(self, dm, qty_by_product, purpose):
        """Block consuming van stock that is still reserved for open shop jobs.

        Allows surplus only: physical − (picked − delivered on open jobs).
        """
        dm.ensure_one()
        need = {
            int(pid): float(qty or 0.0)
            for pid, qty in (qty_by_product or {}).items()
            if float(qty or 0.0) > 0
        }
        if not need:
            return
        free = self._shahtaj_unattributed_van_qty_map(dm, set(need))
        Product = self.env['product.product'].sudo()
        for pid, qty in need.items():
            product = Product.browse(pid)
            rounding = (product.uom_id.rounding if product.exists() else None) or 0.01
            available = free.get(pid, 0.0)
            if float_compare(qty, available, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Cannot %(purpose)s %(qty)s of %(product)s — only %(free)s is free on the van. '
                    'The rest is reserved for open shop deliveries (picked, not yet delivered). '
                    'Finish those stops, or return undelivered stock to the warehouse first.',
                    purpose=purpose,
                    qty=qty,
                    product=product.display_name if product.exists() else pid,
                    free=available,
                ))

    @api.model
    def _shahtaj_align_dm_jobs_to_sale_delivery(self, sale_order):
        """When the SO is fully delivered, align open DM jobs to delivered.

        SO truth = sum of order line qty_delivered (any path: DM GPS, Mark Delivery).
        Multi-DM shares are each marked complete for their assigned qty so jobs
        do not stay 'picked' with qty_delivered=0 after the SO is done.
        """
        sale_order = sale_order.sudo()
        if not sale_order or not sale_order.exists():
            return self.browse()
        storable = sale_order.order_line.filtered(
            lambda l: l.product_id and l.product_id.type == 'consu' and not l.display_type
        )
        if not storable:
            return self.browse()
        ordered = sum(storable.mapped('product_uom_qty'))
        delivered = sum(storable.mapped('qty_delivered'))
        if float_compare(delivered, ordered, precision_digits=2) < 0:
            return self.browse()

        jobs = self.search([
            ('sale_order_id', '=', sale_order.id),
            ('state', 'in', ('not_ready', 'ready', 'picked', 'partial')),
        ])
        if not jobs:
            return jobs

        now = fields.Datetime.now()
        for job in jobs:
            for line in job.line_ids:
                target = line.qty_assigned or 0.0
                new_picked = max(line.qty_picked or 0.0, target)
                line.write({
                    'qty_picked': new_picked,
                    'qty_delivered': target,
                    'qty_to_pick': 0.0,
                    'qty_to_deliver': 0.0,
                })
            job.with_context(shahtaj_skip_planning_log=True).write({
                'state': 'delivered',
                'field_state': 'done',
                'delivered_at': job.delivered_at or now,
            })
            job._ensure_dm_visit_completed()
        return jobs

    @api.model
    def _shahtaj_fifo_allocate_product_qtys(self, deliveries, qty_by_product):
        """Distribute product totals onto job lines (assigned − picked).

        Returns (qty_by_delivery_id, remaining_by_product).
        """
        remaining = {int(pid): float(qty) for pid, qty in (qty_by_product or {}).items() if float(qty or 0.0) > 0}
        qty_by_delivery = defaultdict(dict)
        for delivery in deliveries:
            for line in delivery.line_ids:
                pid = line.product_id.id
                if pid not in remaining:
                    continue
                left = remaining[pid]
                if left <= 0:
                    continue
                still = max(line.qty_assigned - line.qty_picked, 0.0)
                if still <= 0:
                    continue
                rounding = line.product_uom_id.rounding or 0.01
                take = float_round(min(still, left), precision_rounding=rounding)
                if take <= 0:
                    continue
                qty_by_delivery[delivery.id][line.id] = (
                    qty_by_delivery[delivery.id].get(line.id, 0.0) + take
                )
                remaining[pid] = float_round(left - take, precision_rounding=rounding)
        return qty_by_delivery, remaining

    def _attribute_van_stock_with_qtys(self, qty_by_line_id, reload_form=False):
        """Mark job lines as picked using stock already on the van (no WH move)."""
        self.ensure_one()
        self.sudo()._sync_with_sale_order()
        if self.state in ('delivered', 'returned'):
            raise UserError(_('Cannot load stock for a finished/returned delivery.'))
        if self.state == 'not_ready':
            raise UserError(_('This order is not ready for stock pickup.'))

        van_location = self._ensure_van_location()
        updates = []
        for line in self.line_ids:
            qty = float(qty_by_line_id.get(line.id) or 0.0)
            if qty <= 0:
                continue
            still_needed = max(line.qty_assigned - line.qty_picked, 0.0)
            if qty > still_needed + 1e-6:
                raise UserError(_(
                    'Cannot assign %(qty)s of %(product)s from van — only %(max)s still needed.',
                    qty=qty,
                    product=line.product_id.display_name,
                    max=still_needed,
                ))
            updates.append((line, qty))
        if not updates:
            return True

        for line, qty in updates:
            line.qty_picked = line.qty_picked + qty
            line.qty_to_pick = max(line.qty_assigned - line.qty_picked, 0.0)
            line.qty_to_deliver = max(line.qty_assigned - line.qty_delivered, 0.0)

        self._retarget_sale_outgoing_to_van(van_location)
        today = fields.Date.context_today(self)
        now = fields.Datetime.now()
        pick_vals = {
            'state': 'partial' if any(l.qty_delivered > 0 for l in self.line_ids) else 'picked',
            'van_location_id': van_location.id,
            'scheduled_date': self.scheduled_date or today,
        }
        if not self.picked_at:
            pick_vals['picked_at'] = now
        self.write(pick_vals)
        self._ensure_visit_task()
        if not reload_form:
            return True
        return self._reload_form(
            title=_('Van stock applied'),
            message=_(
                'Existing van stock assigned to %(shop)s (no warehouse pick).',
                shop=self.partner_id.display_name,
            ),
        )

    def _pick_stock_with_qtys(self, qty_by_line_id, reload_form=True):
        """Pick given quantities (line_id → qty) from WH onto van."""
        self.ensure_one()
        self.sale_order_id._shahtaj_assert_not_cancelled()
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
        now = fields.Datetime.now()
        pick_vals = {
            'state': 'partial' if any(l.qty_delivered > 0 for l in self.line_ids) else 'picked',
            'pick_picking_id': picking.id,
            'van_location_id': van_location.id,
            'scheduled_date': self.scheduled_date or today,
        }
        # Keep the first load timestamp; later top-ups do not overwrite.
        if not self.picked_at:
            pick_vals['picked_at'] = now
        self.write(pick_vals)
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
        """DM: mark this shop stop as Heading to Shop (not day Left Office)."""
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
        """Distributor: clear a closed/failed/stale-done stop so DM can try again."""
        self.ensure_one()
        if self.field_state not in ('not_attended', 'failed', 'in_transit', 'done'):
            raise UserError(_(
                'Only Heading to Shop / Shop Closed / Could Not Deliver / Stop Done can be reset.'
            ))
        if self.state in ('delivered', 'returned'):
            raise UserError(_('Cannot reset stop on a finished stock job.'))
        if self.field_state == 'done' and any(
            (l.qty_delivered or 0.0) > 0 for l in self.line_ids
        ):
            raise UserError(_(
                'Stop Done with delivered qty — use Undo Delivery to Shop first '
                '(before invoicing).'
            ))
        self.with_context(shahtaj_skip_planning_log=True).write({'field_state': 'pending'})
        self._ensure_visit_task()
        return True

    def action_refresh_delivery_status(self):
        """Recompute Stock/Stop/visit task from invoice + line qtys (safe anytime)."""
        self.ensure_one()
        self.sudo()._sync_with_sale_order(ensure_visit_task=True)
        # Also clear completed DM visits if stock is no longer delivered.
        if not any((l.qty_delivered or 0.0) > 0 for l in self.line_ids):
            self._shahtaj_reopen_dm_visit_after_undo()
            self._ensure_visit_task()
        return self._reload_form(
            title=_('Status refreshed'),
            message=_(
                'Stock, Stop, and visit task realigned for %(shop)s.',
                shop=self.partner_id.display_name,
            ),
        )

    def action_deliver_to_shop(self):
        """Open deliver wizard (editable qty + GPS)."""
        self.ensure_one()
        self.sale_order_id._shahtaj_assert_not_cancelled()
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
            'name': _('Deliver to Shop Procedure'),
            'res_model': 'shahtaj.dm.deliver.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'active_id': self.id,
                'default_delivery_id': self.id,
            },
        }

    @api.model
    def _shahtaj_prepare_delivery_proof(self, receiver_name=None, delivery_proof_image=None):
        """Validate receiver + proof image for a deliver handoff.

        Returns vals to write on the delivery job (and usable on stock.picking).
        Does not change stock flow — call only at successful deliver time.
        """
        name = (receiver_name or '').strip()
        if not name:
            raise UserError(_('Receiver name is required when delivering stock.'))
        if not delivery_proof_image:
            raise UserError(_('Delivery proof photo is required when delivering stock.'))
        # Accept raw base64 or data-URL from mobile clients.
        from odoo.addons.shahtaj_oil.api.image_utils import normalize_image_b64
        image = normalize_image_b64(delivery_proof_image) if isinstance(
            delivery_proof_image, str
        ) else delivery_proof_image
        if not image:
            raise UserError(_('Delivery proof photo is required when delivering stock.'))
        return {
            'receiver_name': name,
            'delivery_proof_image': image,
        }

    def _deliver_to_shop_with_qtys(
        self,
        qty_by_line_id,
        latitude=0.0,
        longitude=0.0,
        distance_m=0.0,
        reload_form=True,
        receiver_name=None,
        delivery_proof_image=None,
    ):
        """Deliver given van qtys to shop; supports partial / multi-attempt."""
        self.ensure_one()
        self.sale_order_id._shahtaj_assert_not_cancelled()
        proof_vals = self._shahtaj_prepare_delivery_proof(
            receiver_name=receiver_name,
            delivery_proof_image=delivery_proof_image,
        )
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
        # Keep proof also on the stock move for free-audit of this handoff.
        picking.sudo().write({
            'shahtaj_receiver_name': proof_vals['receiver_name'],
            'shahtaj_delivery_proof_image': proof_vals['delivery_proof_image'],
        })

        for line, qty in deliver_updates:
            line.qty_delivered = line.qty_delivered + qty
            line.qty_to_deliver = max(line.qty_assigned - line.qty_delivered, 0.0)
            line.qty_to_pick = max(line.qty_assigned - line.qty_picked, 0.0)

        new_state = self._compute_dm_state()
        now = fields.Datetime.now()
        vals = {
            'state': new_state,
            'delivery_picking_id': picking.id,
            'check_in_latitude': latitude or 0.0,
            'check_in_longitude': longitude or 0.0,
            'check_in_distance_m': distance_m or 0.0,
            'gps_verified': True,
            'delivered_at': now,
            **proof_vals,
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
        # If this handoff completed the whole SO (all DMs), close any lagging jobs.
        self._shahtaj_align_dm_jobs_to_sale_delivery(self.sale_order_id)
        if reload_form:
            return self._reload_form(
                title=_('Deliver to Shop — done'),
                message=_(
                    'GPS verified (%(dist).0f m). Stock delivered to %(shop)s from the van.',
                    dist=distance_m or 0.0,
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

    def _shahtaj_can_undo_shop_delivery(self):
        """True when distributor may reverse shop handoff safely."""
        self.ensure_one()
        if self.state == 'returned':
            return False
        any_delivered = any((l.qty_delivered or 0.0) > 0 for l in self.line_ids)
        # Normal undo, or repair stale Stop Done / completed visit after a half-undo.
        if self.state not in ('partial', 'delivered', 'ready', 'picked'):
            return False
        if self.state in ('ready', 'picked') and self.field_state != 'done' and not any_delivered:
            return False
        if self.state in ('partial', 'delivered') and not any_delivered and self.field_state != 'done':
            # May still need status repair (stock already cleared).
            pass
        if not self.van_location_id and any_delivered:
            return False
        order = self.sale_order_id
        if order:
            invoices = order.invoice_ids.filtered(lambda m: m.state != 'cancel')
            if invoices:
                return False
            if order.invoice_status == 'invoiced':
                return False
        return True

    def action_undo_delivery_to_shop(self):
        """Distributor: reverse shop handoff — stock back to van, clear delivered qty.

        Does not touch allocation / pick qty. Blocked after invoicing.
        """
        if not (
            self.env.user.has_group('shahtaj_oil.group_shahtaj_distributor')
            or self.env.user.has_group('base.group_system')
        ):
            raise UserError(_('Only distributors can undo a shop delivery.'))

        for job in self:
            job._shahtaj_undo_delivery_to_shop()
        return self[:1]._reload_form(
            title=_('Delivery undone'),
            message=_(
                'Shop handoff reversed for %(shop)s. Stock is back on the van; '
                'Delivered qty cleared. DM can deliver again.',
                shop=self[:1].partner_id.display_name,
            ),
            notif_type='warning',
        )

    def _shahtaj_undo_delivery_to_shop(self):
        self.ensure_one()
        if self.state == 'returned':
            raise UserError(_(
                'Cannot undo delivery on a job that already returned stock to the warehouse.'
            ))

        order = self.sale_order_id
        if order:
            invoices = order.invoice_ids.filtered(lambda m: m.state != 'cancel')
            if invoices:
                raise UserError(_(
                    'Cannot undo delivery for %(shop)s: sales order %(order)s already has '
                    'invoice(s) %(invoices)s. Reverse those invoices first, then try again.',
                    shop=self.partner_id.display_name,
                    order=order.display_name,
                    invoices=', '.join(invoices.mapped('name')),
                ))
            if order.invoice_status == 'invoiced':
                raise UserError(_(
                    'Cannot undo delivery: order %(order)s is already invoiced.',
                    order=order.display_name,
                ))

        has_delivered = any((l.qty_delivered or 0.0) > 0 for l in self.line_ids)

        # Repair: Stock already Ready/Picked but Stop still Done (or visit still completed).
        if not has_delivered:
            if self.state not in ('partial', 'delivered', 'ready', 'picked'):
                raise UserError(_('Nothing delivered on this job to undo.'))
            new_state = self._compute_dm_state()
            if new_state in ('partial', 'delivered') and has_delivered:
                raise UserError(_('Nothing delivered on this job to undo.'))
            # Prefer live computed stock state when qty already cleared.
            self._shahtaj_write_after_undo_delivery(
                new_state if new_state not in ('partial', 'delivered') else (
                    'picked' if any((l.qty_picked or 0.0) > 0 for l in self.line_ids) else 'ready'
                )
            )
            return True

        if self.state not in ('partial', 'delivered'):
            raise UserError(_(
                'Only Part Delivered or Delivered jobs can undo shop handoff.'
            ))
        if not self.van_location_id:
            raise UserError(_('Missing van location — cannot return stock to the van.'))

        customer_loc = self.partner_id.property_stock_customer
        if not customer_loc:
            customer_loc = self.env.ref(
                'stock.stock_location_customers', raise_if_not_found=False,
            )
        if not customer_loc:
            raise UserError(_('No customer stock location found.'))

        warehouse = self._get_warehouse()
        picking_type = warehouse.int_type_id or warehouse.in_type_id
        if not picking_type:
            raise UserError(_('No internal/receipt operation type on the warehouse.'))

        move_vals_list = []
        for line in self.line_ids:
            qty = line.qty_delivered or 0.0
            if qty <= 0:
                continue
            rounding = line.product_uom_id.rounding or 0.01
            qty = float_round(qty, precision_rounding=rounding)
            vals = {
                'product_id': line.product_id.id,
                'product_uom_qty': qty,
                'product_uom': line.product_uom_id.id,
                'location_id': customer_loc.id,
                'location_dest_id': self.van_location_id.id,
            }
            if line.sale_order_line_id:
                vals['sale_line_id'] = line.sale_order_line_id.id
            move_vals_list.append(vals)

        if not move_vals_list:
            raise UserError(_('Nothing delivered on this job to undo.'))

        picking = self._create_stock_picking(
            picking_type=picking_type,
            location_id=customer_loc,
            location_dest_id=self.van_location_id,
            origin=f"DM Undo Deliver: {self.sale_order_id.name}",
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

        for line in self.line_ids:
            if line.qty_delivered:
                line.qty_delivered = 0.0
                line.qty_to_deliver = max(line.qty_assigned - line.qty_delivered, 0.0)
                line.qty_to_pick = max(line.qty_assigned - line.qty_picked, 0.0)

        new_state = self._compute_dm_state()
        self._shahtaj_write_after_undo_delivery(new_state)
        return True

    def _shahtaj_write_after_undo_delivery(self, new_state):
        """Update job after undo without hitting distributor planning lock on notes."""
        self.ensure_one()
        note = (self.notes or '').strip()
        undo_note = _(
            'Undo delivery by %(user)s on %(when)s — stock returned to van.',
            user=self.env.user.name,
            when=fields.Datetime.now(),
        )
        stop = self._shahtaj_stop_for_stock_state(new_state) or (
            'in_transit' if new_state in ('picked', 'partial') else 'pending'
        )
        vals = {
            'state': new_state,
            'field_state': stop,
            'delivered_at': False,
            'gps_verified': False,
            'notes': f'{note}\n{undo_note}'.strip() if note else undo_note,
        }
        self.with_context(shahtaj_skip_planning_log=True).write(vals)
        self._shahtaj_reopen_dm_visit_after_undo()
        self._ensure_visit_task()
        self.env['shahtaj.activity.log'].log_business(
            operation='dm.job.undo_deliver',
            name='Undo DM shop delivery',
            related_record=self,
            message=_(
                'Undid shop delivery for %(shop)s / %(order)s — stock back on van.',
                shop=self.partner_id.display_name,
                order=self.sale_order_id.display_name,
            ),
        )

    def _shahtaj_reopen_dm_visit_after_undo(self):
        """Mark completed DM visit rows undone so dashboards match Stock again."""
        self.ensure_one()
        Visit = self.env['shahtaj.visit'].sudo()
        visits = Visit.search([
            ('visit_kind', '=', 'delivery_man'),
            ('dm_delivery_id', '=', self.id),
            ('state', '=', 'completed'),
        ])
        if not visits:
            return
        now = fields.Datetime.now()
        for visit in visits:
            visit.with_context(shahtaj_system_visit_write=True).write({
                'state': 'cancelled',
                'outcome': 'undone',
                'ended_at': now,
                'notes': (
                    ((visit.notes or '').strip() + '\n') if visit.notes else ''
                ) + _(
                    'Undone with shop delivery undo by %(user)s.',
                    user=self.env.user.name,
                ),
            })

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
            started = rec.picked_at or rec.delivered_at or fields.Datetime.now()
            ended = rec.delivered_at or fields.Datetime.now()
            duration = 0
            if started and ended:
                duration = max(int((ended - started).total_seconds()), 0)
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
                'started_at': started,
                'ended_at': ended,
                'duration_seconds': duration,
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

    def action_view_shop_invoices(self):
        """Open all posted shop invoices (unpaid / partial / paid) for field sharing."""
        self.ensure_one()
        if not self.partner_id:
            raise UserError(_('No shop linked to this delivery.'))
        commercial = self.partner_id.commercial_partner_id
        company = self.sale_order_id.company_id or self.env.company
        return {
            'type': 'ir.actions.act_window',
            'name': _('Shop Invoices — %s', self.partner_id.display_name),
            'res_model': 'account.move',
            'view_mode': 'list,form',
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_dm_shop_invoice_list').id, 'list'),
                (False, 'form'),
            ],
            'search_view_id': self.env.ref('shahtaj_oil.view_shahtaj_dm_shop_invoice_search').id,
            'domain': [
                ('move_type', 'in', ('out_invoice', 'out_refund')),
                ('state', '=', 'posted'),
                ('partner_id', 'child_of', commercial.id),
                ('company_id', '=', company.id),
            ],
            'context': {
                'create': False,
                'edit': False,
                'delete': False,
            },
            'target': 'current',
        }

    def action_collect_shop_payment(self):
        """Open recovery wizard for this stop's shop → DM wallet."""
        self.ensure_one()
        if not self.partner_id:
            raise UserError(_('No shop linked to this delivery.'))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Collect Payment — %s', self.partner_id.display_name),
            'res_model': 'shahtaj.dm.collect.payment',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_delivery_id': self.id,
                'default_partner_id': self.partner_id.id,
                'default_delivery_man_id': self.delivery_man_id.id,
                'lock_delivery_man': True,
            },
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
                # Do NOT use inventory_report_mode — that shows counted qty, not on-hand.
                'default_location_id': van_location.id,
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
