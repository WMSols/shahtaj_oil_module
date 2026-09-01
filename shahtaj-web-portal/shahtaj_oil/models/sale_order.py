# -*- coding: utf-8 -*-
"""Link confirmed sales orders back to the shop visit and daily task."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    shahtaj_visit_id = fields.Many2one(
        'shahtaj.visit',
        string='Shop Visit',
        ondelete='set null',
        copy=False,
        index=True,
    )
    shahtaj_visit_task_id = fields.Many2one(
        'shahtaj.visit.task',
        string='Visit Task',
        ondelete='set null',
        copy=False,
        index=True,
    )
    shahtaj_order_booker_id = fields.Many2one(
        'res.users',
        string='Order Booker',
        related='shahtaj_visit_id.order_booker_id',
        store=True,
        readonly=True,
    )
    shahtaj_shop_id = fields.Many2one(
        'res.partner',
        string='Shop',
        related='partner_id',
        store=True,
        readonly=True,
    )
    shahtaj_delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man (booker link)',
        compute='_compute_shahtaj_delivery_man_id',
        store=True,
        index=True,
        help='Suggested DM from order booker assignment (auto). '
             'Manual dispatch uses the delivery job instead.',
    )
    shahtaj_dm_delivery_ids = fields.One2many(
        'shahtaj.dm.delivery',
        'sale_order_id',
        string='DM Delivery Jobs',
    )
    shahtaj_dm_delivery_count = fields.Integer(
        string='DM Jobs',
        compute='_compute_shahtaj_dm_delivery_count',
    )
    shahtaj_assigned_dm_id = fields.Many2one(
        'res.users',
        string='Assigned Delivery Man',
        compute='_compute_shahtaj_assigned_dm_id',
        help='Delivery man on the active DM job for this sales order.',
    )
    shahtaj_dm_scheduled_date = fields.Date(
        string='DM Delivery Day',
        compute='_compute_shahtaj_assigned_dm_id',
    )
    shahtaj_planned_delivery_date = fields.Date(
        string='Planned Delivery Date',
        compute='_compute_shahtaj_planned_delivery_date',
        inverse='_inverse_shahtaj_planned_delivery_date',
        help='Editable while no delivery stock has been picked. Updates open DM jobs.',
    )
    shahtaj_can_edit_delivery_plan = fields.Boolean(
        compute='_compute_shahtaj_can_edit_delivery_plan',
    )

    shahtaj_delivery_status = fields.Selection(
        [
            ('no_stock', 'No Stock Moves'),
            ('pending', 'To Deliver'),
            ('partial', 'Partially Delivered'),
            ('done', 'Fully Delivered'),
        ],
        string='Delivery Status',
        compute='_compute_shahtaj_delivery_status',
        store=True,
    )
    shahtaj_qty_to_deliver = fields.Float(
        string='Qty Still to Deliver',
        compute='_compute_shahtaj_delivery_status',
        digits='Product Unit of Measure',
        store=True,
    )
    shahtaj_approval_state = fields.Selection(
        [
            ('none', 'Standard'),
            ('to_approve', 'Verification Required'),
            ('approved', 'Verified'),
            ('rejected', 'Rejected'),
        ],
        string='Verification Status',
        default='none',
        index=True,
        tracking=True,
        copy=False,
    )
    shahtaj_approval_reason_discount = fields.Boolean(
        string='Needs Discount Approval',
        default=False,
        copy=False,
        index=True,
    )
    shahtaj_approval_reason_credit = fields.Boolean(
        string='Needs Credit Approval',
        default=False,
        copy=False,
        index=True,
    )
    shahtaj_approval_reasons_display = fields.Char(
        string='Verification Reasons',
        compute='_compute_shahtaj_approval_reasons_display',
        store=True,
    )
    shahtaj_has_discount = fields.Boolean(
        string='Has Discount',
        compute='_compute_shahtaj_discount_summary',
        store=True,
        index=True,
    )
    shahtaj_catalog_amount_total = fields.Monetary(
        string='Catalog Total',
        compute='_compute_shahtaj_discount_summary',
        currency_field='currency_id',
        store=True,
    )
    shahtaj_total_discount_amount = fields.Monetary(
        string='Total Discount Amount',
        compute='_compute_shahtaj_discount_summary',
        currency_field='currency_id',
        store=True,
    )
    shahtaj_discount_reasons = fields.Char(
        string='Discount Reasons',
        compute='_compute_shahtaj_discount_summary',
        store=True,
    )
    shahtaj_verified_by_id = fields.Many2one(
        'res.users',
        string='Verified By',
        readonly=True,
        copy=False,
    )
    shahtaj_verified_at = fields.Datetime(
        string='Verified At',
        readonly=True,
        copy=False,
    )
    shahtaj_rejection_reason = fields.Text(
        string='Rejection Reason',
        copy=False,
    )
    shahtaj_shop_category = fields.Selection(
        related='partner_id.shahtaj_shop_category',
        string='Shop Category',
        readonly=True,
    )
    shahtaj_shop_credit_limit = fields.Float(
        related='partner_id.credit_limit',
        string='Shop Credit Limit',
        readonly=True,
    )
    shahtaj_shop_outstanding = fields.Monetary(
        related='partner_id.outstanding_balance',
        string='Shop Posted Outstanding',
        currency_field='currency_id',
        readonly=True,
    )
    shahtaj_shop_pending_exposure = fields.Monetary(
        string='Shop Pending Orders',
        compute='_compute_shahtaj_shop_credit_snapshot',
        currency_field='currency_id',
    )
    shahtaj_shop_uninvoiced_exposure = fields.Monetary(
        string='Shop Confirmed (Not Invoiced)',
        compute='_compute_shahtaj_shop_credit_snapshot',
        currency_field='currency_id',
    )
    shahtaj_shop_effective_outstanding = fields.Monetary(
        string='Shop Effective Outstanding',
        compute='_compute_shahtaj_shop_credit_snapshot',
        currency_field='currency_id',
    )
    shahtaj_shop_credit_would_exceed = fields.Boolean(
        string='Credit Limit Exceeded',
        compute='_compute_shahtaj_shop_credit_snapshot',
    )
    shahtaj_shop_credit_shortfall = fields.Monetary(
        string='Over Credit Limit By',
        compute='_compute_shahtaj_shop_credit_snapshot',
        currency_field='currency_id',
    )
    shahtaj_shop_credit_remaining = fields.Monetary(
        string='Shop Credit Remaining',
        compute='_compute_shahtaj_shop_credit_snapshot',
        currency_field='currency_id',
    )
    shahtaj_shop_lifetime_sales = fields.Monetary(
        string='Shop Lifetime Sales',
        compute='_compute_shahtaj_shop_history',
        currency_field='currency_id',
    )
    shahtaj_shop_confirmed_order_count = fields.Integer(
        string='Shop Confirmed Orders',
        compute='_compute_shahtaj_shop_history',
    )
    shahtaj_shop_past_discount_total = fields.Monetary(
        string='Past Discounts Total',
        compute='_compute_shahtaj_shop_history',
        currency_field='currency_id',
    )
    shahtaj_shop_past_discount_count = fields.Integer(
        string='Past Discounted Orders',
        compute='_compute_shahtaj_shop_history',
    )
    shahtaj_shop_last_discount_date = fields.Datetime(
        string='Last Discount Date',
        compute='_compute_shahtaj_shop_history',
    )
    shahtaj_shop_last_discount_amount = fields.Monetary(
        string='Last Discount Amount',
        compute='_compute_shahtaj_shop_history',
        currency_field='currency_id',
    )

    @api.depends(
        'partner_id',
        'partner_id.credit_limit',
        'partner_id.outstanding_balance',
        'partner_id.shahtaj_shop_category',
        'partner_id.use_partner_credit_limit',
        'amount_total',
        'state',
        'invoice_status',
    )
    def _compute_shahtaj_shop_credit_snapshot(self):
        for order in self:
            partner = order.partner_id
            if not partner or not partner.is_shahtaj_shop:
                order.shahtaj_shop_pending_exposure = 0.0
                order.shahtaj_shop_uninvoiced_exposure = 0.0
                order.shahtaj_shop_effective_outstanding = 0.0
                order.shahtaj_shop_credit_remaining = 0.0
                order.shahtaj_shop_credit_would_exceed = False
                order.shahtaj_shop_credit_shortfall = 0.0
                continue
            snap = partner._shahtaj_get_credit_snapshot()
            order.shahtaj_shop_pending_exposure = snap['pending_order_exposure']
            order.shahtaj_shop_uninvoiced_exposure = snap['confirmed_uninvoiced_exposure']
            order.shahtaj_shop_effective_outstanding = snap['effective_outstanding']
            order.shahtaj_shop_credit_remaining = snap['credit_remaining']
            order.shahtaj_shop_credit_would_exceed = snap['would_exceed']
            order.shahtaj_shop_credit_shortfall = snap['shortfall']

    @api.depends('partner_id')
    def _compute_shahtaj_shop_history(self):
        orders = self.filtered('partner_id')
        stats_map = self._shahtaj_batch_shop_stats(
            orders.partner_id.ids,
            exclude_order_ids=orders.ids,
        )
        empty = {
            'lifetime_sales': 0.0,
            'confirmed_order_count': 0,
            'past_discount_total': 0.0,
            'past_discount_count': 0,
            'last_discount_date': False,
            'last_discount_amount': 0.0,
        }
        for order in self:
            stats = stats_map.get(order.partner_id.id, empty) if order.partner_id else empty
            order.shahtaj_shop_lifetime_sales = stats['lifetime_sales']
            order.shahtaj_shop_confirmed_order_count = stats['confirmed_order_count']
            order.shahtaj_shop_past_discount_total = stats['past_discount_total']
            order.shahtaj_shop_past_discount_count = stats['past_discount_count']
            order.shahtaj_shop_last_discount_date = stats['last_discount_date']
            order.shahtaj_shop_last_discount_amount = stats['last_discount_amount']

    @api.model
    def _shahtaj_batch_shop_stats(self, partner_ids, exclude_order_ids=None):
        """Aggregate shop sales/discount history for distributor decision screens."""
        if not partner_ids:
            return {}
        exclude_ids = set(exclude_order_ids or [])
        SaleOrder = self.sudo()
        confirmed_domain = [
            ('partner_id', 'in', partner_ids),
            ('state', 'in', ('sale', 'done')),
        ]
        if exclude_ids:
            confirmed_domain.append(('id', 'not in', list(exclude_ids)))

        default = {
            'lifetime_sales': 0.0,
            'confirmed_order_count': 0,
            'past_discount_total': 0.0,
            'past_discount_count': 0,
            'last_discount_date': False,
            'last_discount_amount': 0.0,
        }
        stats = {pid: dict(default) for pid in partner_ids}

        for row in SaleOrder.read_group(
            confirmed_domain,
            ['amount_total:sum'],
            ['partner_id'],
        ):
            partner = row.get('partner_id')
            if not partner:
                continue
            stats[partner[0]]['lifetime_sales'] = row.get('amount_total') or 0.0

        for row in SaleOrder.read_group(
            confirmed_domain,
            ['partner_id'],
            ['partner_id'],
        ):
            partner = row.get('partner_id')
            if not partner:
                continue
            stats[partner[0]]['confirmed_order_count'] = row.get('partner_id_count') or row.get('__count') or 0

        discount_domain = confirmed_domain + [('shahtaj_has_discount', '=', True)]
        for row in SaleOrder.read_group(
            discount_domain,
            ['shahtaj_total_discount_amount:sum'],
            ['partner_id'],
        ):
            partner = row.get('partner_id')
            if not partner:
                continue
            stats[partner[0]]['past_discount_total'] = row.get('shahtaj_total_discount_amount') or 0.0

        for row in SaleOrder.read_group(
            discount_domain,
            ['partner_id'],
            ['partner_id'],
        ):
            partner = row.get('partner_id')
            if not partner:
                continue
            stats[partner[0]]['past_discount_count'] = row.get('partner_id_count') or row.get('__count') or 0

        for order in SaleOrder.search(
            discount_domain,
            order='date_order desc, id desc',
        ):
            pid = order.partner_id.id
            if pid not in stats or stats[pid]['last_discount_date']:
                continue
            stats[pid]['last_discount_date'] = order.date_order
            stats[pid]['last_discount_amount'] = order.shahtaj_total_discount_amount or 0.0
            if all(
                stats[p]['last_discount_date'] or not stats[p]['past_discount_count']
                for p in partner_ids
            ):
                break

        return stats

    def action_shahtaj_open_shop(self):
        """Open native shop form for credit/account review."""
        self.ensure_one()
        if not self.partner_id:
            return False
        return {
            'type': 'ir.actions.act_window',
            'name': _('Shop — %s', self.partner_id.name),
            'res_model': 'res.partner',
            'res_id': self.partner_id.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_shop_form').id, 'form'),
            ],
        }

    def action_shahtaj_view_shop_orders(self):
        """Open confirmed sales history for this shop."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Shop Orders — %s', self.partner_id.display_name),
            'res_model': 'sale.order',
            'view_mode': 'list,form',
            'domain': [
                ('partner_id', '=', self.partner_id.id),
                ('state', 'in', ('sale', 'done')),
            ],
            'context': {'create': False},
        }

    def action_shahtaj_view_shop_discounted_orders(self):
        """Open past discounted orders for this shop."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Past Discounts — %s', self.partner_id.display_name),
            'res_model': 'sale.order',
            'view_mode': 'list,form',
            'domain': [
                ('partner_id', '=', self.partner_id.id),
                ('state', 'in', ('sale', 'done')),
                ('shahtaj_has_discount', '=', True),
            ],
            'context': {'create': False},
        }

    @api.depends('shahtaj_approval_reason_discount', 'shahtaj_approval_reason_credit')
    def _compute_shahtaj_approval_reasons_display(self):
        reason_labels = {
            'discount': _('Discount'),
            'credit': _('Credit Limit'),
        }
        for order in self:
            parts = [
                reason_labels[key]
                for key, enabled in (
                    ('discount', order.shahtaj_approval_reason_discount),
                    ('credit', order.shahtaj_approval_reason_credit),
                )
                if enabled
            ]
            order.shahtaj_approval_reasons_display = ', '.join(parts) if parts else False

    @api.model
    def _shahtaj_evaluate_field_order_approval(
        self,
        partner,
        order_amount,
        has_discount,
        exclude_order_ids=None,
    ):
        """Return approval flags for a field order (visit) before or after SO create."""
        needs_discount = bool(has_discount)
        needs_credit = False
        if partner and partner._shahtaj_credit_enforcement_applies():
            snap = partner._shahtaj_get_credit_snapshot(
                exclude_order_ids=exclude_order_ids,
                extra_order_amount=order_amount or 0.0,
            )
            needs_credit = snap['would_exceed']
        needs_approval = needs_discount or needs_credit
        reasons = []
        if needs_discount:
            reasons.append('discount')
        if needs_credit:
            reasons.append('credit')
        return {
            'needs_discount': needs_discount,
            'needs_credit': needs_credit,
            'needs_approval': needs_approval,
            'approval_state': 'to_approve' if needs_approval else 'none',
            'approval_reasons': reasons,
        }

    def _shahtaj_get_approval_reasons_list(self):
        self.ensure_one()
        reasons = []
        if self.shahtaj_approval_reason_discount:
            reasons.append('discount')
        if self.shahtaj_approval_reason_credit:
            reasons.append('credit')
        return reasons

    def _shahtaj_field_order_approval_vals(self):
        """Recompute verification flags for a draft field sales order."""
        self.ensure_one()
        lines = self.order_line.filtered(
            lambda l: not l.display_type and l.product_id
        )
        order_amount = self.amount_total or 0.0
        if lines:
            line_total = sum(lines.mapped('price_subtotal'))
            if line_total:
                order_amount = line_total
        has_discount = any(lines.mapped('shahtaj_has_discount'))
        req = self._shahtaj_evaluate_field_order_approval(
            self.partner_id,
            order_amount,
            has_discount,
            exclude_order_ids=self.ids,
        )
        return {
            'shahtaj_approval_reason_discount': req['needs_discount'],
            'shahtaj_approval_reason_credit': req['needs_credit'],
            'shahtaj_approval_state': req['approval_state'],
        }

    @api.depends(
        'order_line.shahtaj_total_discount',
        'order_line.shahtaj_has_discount',
        'order_line.shahtaj_catalog_price',
        'order_line.product_uom_qty',
        'order_line.shahtaj_discount_reason',
        'order_line.price_unit',
    )
    def _compute_shahtaj_discount_summary(self):
        for order in self:
            lines = order.order_line.filtered(lambda l: not l.display_type and l.product_id)
            has_disc = any(l.shahtaj_has_discount for l in lines)
            order.shahtaj_has_discount = has_disc
            order.shahtaj_total_discount_amount = sum(lines.mapped('shahtaj_total_discount'))
            order.shahtaj_catalog_amount_total = sum((l.shahtaj_catalog_price or l.price_unit) * l.product_uom_qty for l in lines)
            reasons = [l.shahtaj_discount_reason for l in lines if l.shahtaj_discount_reason]
            # Unique non-empty reasons preserved in order
            seen = set()
            unique_reasons = [r for r in reasons if not (r in seen or seen.add(r))]
            order.shahtaj_discount_reasons = ', '.join(unique_reasons) if unique_reasons else False

    def _shahtaj_user_is_distributor(self):
        user = self.env.user
        return user.has_group('shahtaj_oil.group_shahtaj_distributor') or user.has_group(
            'shahtaj_oil.group_shahtaj_distributor_financial'
        )

    def _shahtaj_action_open_credit_override_wizard(self, action_type):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Credit Limit Exceeded — %s', self.partner_id.display_name),
            'res_model': 'shahtaj.credit.override.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_sale_order_id': self.id,
                'default_action_type': action_type,
            },
        }

    def _shahtaj_do_approve_order(self):
        """Approve and confirm a discounted order (credit check must be done by caller)."""
        for order in self:
            if order.state not in ('draft', 'sent'):
                continue
            order.write({
                'shahtaj_approval_state': 'approved',
                'shahtaj_verified_by_id': self.env.user.id,
                'shahtaj_verified_at': fields.Datetime.now(),
            })
            order.with_context(shahtaj_skip_credit_check=True).action_confirm()
            order._shahtaj_recompute_visit_targets()
            self.env['shahtaj.activity.log'].log_business(
                operation='order.approved',
                name='Approve discounted order',
                related_record=order,
                message=_(
                    'Distributor %(user)s approved order %(order)s (Reasons: %(reasons)s, Discount: %(disc)s)',
                    user=self.env.user.name,
                    order=order.name,
                    reasons=order.shahtaj_approval_reasons_display or _('Standard'),
                    disc=order.shahtaj_total_discount_amount,
                ),
            )
        return True

    def action_shahtaj_approve_order(self):
        """Distributor approves a discounted order; credit warning if over limit."""
        for order in self:
            if order.state not in ('draft', 'sent'):
                continue
            if not self.env.context.get('shahtaj_skip_credit_check'):
                partner = order.partner_id
                if partner._shahtaj_credit_enforcement_applies():
                    snap = partner._shahtaj_get_credit_snapshot()
                    if snap['would_exceed']:
                        return order._shahtaj_action_open_credit_override_wizard('approve')
            order._shahtaj_do_approve_order()
        return True

    def action_shahtaj_reject_order(self, reason=None):
        """Distributor rejects a discounted or field order."""
        for order in self:
            order.write({
                'shahtaj_approval_state': 'rejected',
                'shahtaj_verified_by_id': self.env.user.id,
                'shahtaj_verified_at': fields.Datetime.now(),
                'shahtaj_rejection_reason': reason or order.shahtaj_rejection_reason or _('Rejected by distributor'),
            })
            if order.state not in ('cancel',):
                order._action_cancel()
            self.env['shahtaj.activity.log'].log_business(
                operation='order.rejected',
                name='Reject order',
                related_record=order,
                message=_(
                    'Distributor %(user)s rejected order %(order)s. Reason: %(reason)s',
                    user=self.env.user.name,
                    order=order.name,
                    reason=order.shahtaj_rejection_reason,
                ),
            )
        return True

    def action_shahtaj_open_reject_wizard(self):
        """Open wizard to enter rejection reason before cancelling."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Reject Order — %s', self.name),
            'res_model': 'shahtaj.order.reject.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_sale_order_id': self.id,
            },
        }

    @api.depends('shahtaj_order_booker_id')
    def _compute_shahtaj_delivery_man_id(self):
        Users = self.env['res.users'].sudo()
        booker_ids = self.mapped('shahtaj_order_booker_id').ids
        if not booker_ids:
            for order in self:
                order.shahtaj_delivery_man_id = False
            return
        delivery_men = Users.search([
            ('shahtaj_is_delivery_man', '=', True),
            ('shahtaj_assigned_booker_ids', 'in', booker_ids),
        ])
        booker_to_dm = {}
        for dm in delivery_men:
            for booker in dm.shahtaj_assigned_booker_ids:
                booker_to_dm.setdefault(booker.id, dm.id)
        for order in self:
            order.shahtaj_delivery_man_id = booker_to_dm.get(
                order.shahtaj_order_booker_id.id, False
            )

    @api.depends(
        'order_line.product_uom_qty',
        'order_line.qty_delivered',
        'order_line.product_id',
        'order_line.product_id.type',
        'state',
    )
    def _compute_shahtaj_delivery_status(self):
        # Intentionally do not depend on picking_ids: custom-portal distributors
        # lack stock.picking ACL, and qty_delivered already updates on validate.
        for order in self:
            storable_lines = order.order_line.filtered(
                lambda l: l.product_id and l.product_id.type == 'consu' and not l.display_type
            )
            if not storable_lines:
                order.shahtaj_delivery_status = 'no_stock'
                order.shahtaj_qty_to_deliver = 0.0
                continue
            ordered = sum(storable_lines.mapped('product_uom_qty'))
            delivered = sum(storable_lines.mapped('qty_delivered'))
            remaining = ordered - delivered
            order.shahtaj_qty_to_deliver = max(remaining, 0.0)
            if float_compare(delivered, 0.0, precision_digits=2) <= 0:
                order.shahtaj_delivery_status = 'pending'
            elif float_compare(remaining, 0.0, precision_digits=2) <= 0:
                order.shahtaj_delivery_status = 'done'
            else:
                order.shahtaj_delivery_status = 'partial'

    @api.depends('shahtaj_dm_delivery_ids')
    def _compute_shahtaj_dm_delivery_count(self):
        for order in self:
            order.shahtaj_dm_delivery_count = len(order.shahtaj_dm_delivery_ids)

    @api.depends(
        'shahtaj_dm_delivery_ids.delivery_man_id',
        'shahtaj_dm_delivery_ids.scheduled_date',
        'shahtaj_dm_delivery_ids.state',
    )
    def _compute_shahtaj_assigned_dm_id(self):
        for order in self:
            jobs = order.shahtaj_dm_delivery_ids.sorted('id')
            job = jobs[:1]
            order.shahtaj_assigned_dm_id = job.delivery_man_id if job else False
            order.shahtaj_dm_scheduled_date = job.scheduled_date if job else False

    @api.depends(
        'shahtaj_dm_delivery_ids.scheduled_date',
        'shahtaj_dm_delivery_ids.state',
        'state',
        'shahtaj_delivery_status',
    )
    def _compute_shahtaj_planned_delivery_date(self):
        for order in self:
            open_jobs = order.shahtaj_dm_delivery_ids.filtered(
                lambda j: j.state not in ('picked', 'partial', 'delivered', 'returned'),
            ).sorted('id')
            jobs = open_jobs or order.shahtaj_dm_delivery_ids.sorted('id')
            order.shahtaj_planned_delivery_date = jobs[:1].scheduled_date if jobs else False

    @api.depends(
        'state',
        'shahtaj_delivery_status',
        'shahtaj_dm_delivery_ids.state',
    )
    def _compute_shahtaj_can_edit_delivery_plan(self):
        for order in self:
            if order.state not in ('sale', 'done'):
                order.shahtaj_can_edit_delivery_plan = False
                continue
            open_jobs = order.shahtaj_dm_delivery_ids.filtered(
                lambda j: j.state not in ('picked', 'partial', 'delivered', 'returned'),
            )
            order.shahtaj_can_edit_delivery_plan = bool(open_jobs)

    def _inverse_shahtaj_planned_delivery_date(self):
        for order in self:
            if not order.shahtaj_can_edit_delivery_plan:
                raise UserError(_(
                    'Cannot change the planned delivery date for %(order)s — '
                    'confirm the order and assign delivery men first, or stock may '
                    'already be picked.',
                    order=order.display_name,
                ))
            open_jobs = order.shahtaj_dm_delivery_ids.filtered(
                lambda j: j.state not in ('picked', 'partial', 'delivered', 'returned'),
            )
            if not open_jobs:
                raise UserError(_(
                    'No open delivery jobs to reschedule for %(order)s.',
                    order=order.display_name,
                ))
            old_dates = ', '.join({
                str(d) for d in open_jobs.mapped('scheduled_date') if d
            }) or '—'
            open_jobs.with_context(shahtaj_skip_planning_log=True).write({
                'scheduled_date': order.shahtaj_planned_delivery_date,
            })
            self.env['shahtaj.activity.log'].log_business(
                operation='order.update',
                name='Order delivery date updated',
                related_record=order,
                message=(
                    f'{order.display_name}: Planned delivery '
                    f'{old_dates} → {order.shahtaj_planned_delivery_date or "—"}'
                ),
            )

    def action_shahtaj_assign_dm(self):
        """Open distributor wizard to assign or split this SO across DMs."""
        self.ensure_one()
        if self.state not in ('sale', 'done'):
            raise UserError(_(
                'Confirm the sales order before assigning a delivery man.'
            ))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Assign / Split Delivery — %s', self.name),
            'res_model': 'shahtaj.dm.assign.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'active_id': self.id,
                'active_ids': self.ids,
                'active_model': 'sale.order',
                'default_sale_order_id': self.id,
            },
        }

    def action_shahtaj_view_dm_deliveries(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('DM Jobs — %s', self.name),
            'res_model': 'shahtaj.dm.delivery',
            'view_mode': 'list,form',
            'domain': [('sale_order_id', '=', self.id)],
            'context': {'default_sale_order_id': self.id},
        }

    def action_shahtaj_mark_delivery(self):
        """Open wizard so distributor can validate full/partial delivery."""
        self.ensure_one()
        if self.state not in ('sale', 'done'):
            return False
        return {
            'type': 'ir.actions.act_window',
            'name': _('Mark Delivery — %s', self.name),
            'res_model': 'shahtaj.mark.delivery.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'active_id': self.id,
                'default_sale_order_id': self.id,
            },
        }

    def action_shahtaj_view_visit(self):
        self.ensure_one()
        if not self.shahtaj_visit_id:
            return False
        return {
            'type': 'ir.actions.act_window',
            'name': _('Shop Visit'),
            'res_model': 'shahtaj.visit',
            'res_id': self.shahtaj_visit_id.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def _shahtaj_recompute_visit_targets(self):
        self.env['shahtaj.visit.target']._recompute_for_orders(self)

    def _shahtaj_sync_approval_state_from_lines(self):
        """Keep verification status aligned with discounts and credit on draft field orders."""
        for order in self:
            if order.state not in ('draft', 'sent'):
                continue
            if not order.shahtaj_visit_id:
                continue
            if order.shahtaj_approval_state in ('approved', 'rejected'):
                continue
            vals = order._shahtaj_field_order_approval_vals()
            write_vals = {}
            for key, value in vals.items():
                if order[key] != value:
                    write_vals[key] = value
            if write_vals:
                order.write(write_vals)

    def action_confirm(self):
        pending_verification = self.filtered(
            lambda o: o.shahtaj_approval_state == 'to_approve'
            and o.state in ('draft', 'sent')
        )
        if pending_verification and not self.env.context.get('shahtaj_skip_credit_check'):
            raise UserError(_(
                'Order %(order)s requires distributor verification before it can be confirmed. '
                'Use "Approve Order" instead.',
                order=pending_verification[:1].display_name,
            ))
        if not self.env.context.get('shahtaj_skip_credit_check'):
            for order in self.filtered(lambda o: o.state in ('draft', 'sent')):
                partner = order.partner_id
                if not partner or not partner._shahtaj_credit_enforcement_applies():
                    continue
                snap = partner._shahtaj_get_credit_snapshot()
                if not snap['would_exceed']:
                    continue
                if order._shahtaj_user_is_distributor():
                    return order._shahtaj_action_open_credit_override_wizard('confirm')
                raise UserError(_(
                    'Credit limit exceeded for shop "%(shop)s". '
                    'Effective outstanding: %(effective).2f / Limit: %(limit).2f',
                    shop=partner.display_name,
                    effective=snap['effective_outstanding'],
                    limit=snap['credit_limit'],
                ))
        return super().action_confirm()

    @api.model_create_multi
    def create(self, vals_list):
        orders = super().create(vals_list)
        orders._shahtaj_recompute_visit_targets()
        return orders

    def write(self, vals):
        tracked_order_fields = {'date_order'}
        user = self.env.user
        is_distributor = (
            user.has_group('shahtaj_oil.group_shahtaj_distributor')
            and not user._is_public()
        )
        if tracked_order_fields.intersection(vals) and is_distributor:
            for order in self:
                if order.state not in ('draft', 'sent'):
                    raise UserError(_(
                        'Cannot change the order date on %(order)s after it is confirmed.',
                        order=order.display_name,
                    ))
            self.env['shahtaj.activity.log'].log_model_field_changes(
                self,
                operation='order.update',
                title='Sales order date updated',
                vals={k: vals[k] for k in tracked_order_fields if k in vals},
                field_labels={'date_order': 'Order Date'},
            )
        res = super().write(vals)
        if any(k in vals for k in (
            'state', 'date_order', 'create_uid', 'amount_total',
            'user_id', 'shahtaj_visit_id',
        )):
            self._shahtaj_recompute_visit_targets()
        return res

    def _shahtaj_distributor_needs_stock_sudo(self):
        """Custom-portal distributors lack stock.picking ACL used by delivery fields."""
        if self.env.su:
            return False
        user = self.env.user
        if user.has_group('stock.group_stock_user'):
            return False
        return user.has_group('shahtaj_oil.group_shahtaj_distributor')

    def _compute_delivery_status(self):
        if self._shahtaj_distributor_needs_stock_sudo():
            return super(SaleOrder, self.sudo())._compute_delivery_status()
        return super()._compute_delivery_status()

    def _compute_picking_ids(self):
        if self._shahtaj_distributor_needs_stock_sudo():
            return super(SaleOrder, self.sudo())._compute_picking_ids()
        return super()._compute_picking_ids()

    def _compute_effective_date(self):
        if self._shahtaj_distributor_needs_stock_sudo():
            return super(SaleOrder, self.sudo())._compute_effective_date()
        return super()._compute_effective_date()

    def unlink(self):
        booker_ids = set()
        for order in self:
            if order.shahtaj_order_booker_id:
                booker_ids.add(order.shahtaj_order_booker_id.id)
            if order.user_id:
                booker_ids.add(order.user_id.id)
            if order.create_uid:
                booker_ids.add(order.create_uid.id)
        dates = [
            fields.Date.to_date(order.date_order)
            for order in self if order.date_order
        ]
        res = super().unlink()
        if booker_ids and dates:
            targets = self.env['shahtaj.visit.target'].search([
                ('order_booker_id', 'in', list(booker_ids)),
                ('date_start', '<=', max(dates)),
                ('date_end', '>=', min(dates)),
                ('target_type', 'in', [
                    'collective_qty', 'collective_weight', 'product_bundle',
                ]),
            ])
            if targets:
                targets._force_recompute_progress()
        return res


