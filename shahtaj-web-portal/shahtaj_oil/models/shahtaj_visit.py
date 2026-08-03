# -*- coding: utf-8 -*-
"""Shop visit: GPS check-in, timer, draft order lines, and place order.

One visit per visit task. Ends with a sales order or 'no order'.
Order bookers may only edit products and notes during an active visit.
"""
from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools import float_compare

from .shahtaj_gps import shahtaj_distance_meters, get_shop_distance_limits

VISIT_STATES = [
    ('in_progress', 'In Progress'),
    ('completed', 'Completed'),
    ('cancelled', 'Cancelled'),
]

VISIT_OUTCOMES = [
    ('none', 'In Progress'),
    ('order', 'Order Placed'),
    ('no_order', 'No Order'),
    ('incomplete', 'Incomplete'),
    ('undone', 'Undone by Distributor'),
]

# Fields a booker may change on their own during a visit (security in write()).
BOOKER_VISIT_WRITABLE_FIELDS = frozenset({'line_ids', 'notes'})


class ShahtajVisit(models.Model):
    _name = 'shahtaj.visit'
    _description = 'Shop Visit'
    _order = 'started_at desc, id desc'

    name = fields.Char(compute='_compute_name', store=True)
    visit_task_id = fields.Many2one(
        'shahtaj.visit.task',
        string='Visit Task',
        required=True,
        ondelete='restrict',
        index=True,
    )
    order_booker_id = fields.Many2one(
        'res.users',
        string='Order Booker',
        required=True,
        index=True,
        ondelete='restrict',
    )
    shop_id = fields.Many2one(
        'res.partner',
        string='Shop',
        required=True,
        ondelete='restrict',
    )
    shop_name = fields.Char(
        string='Shop Name',
        readonly=True,
        index=True,
        help='Copied at check-in so bookers can read visit history without shop ACL.',
    )
    route_id = fields.Many2one(
        'shahtaj.route',
        string='Route',
        required=True,
        ondelete='restrict',
    )
    route_name = fields.Char(
        string='Route Name',
        readonly=True,
        help='Copied at check-in for visit history display.',
    )
    state = fields.Selection(
        VISIT_STATES,
        string='Status',
        default='in_progress',
        required=True,
        index=True,
    )
    outcome = fields.Selection(
        VISIT_OUTCOMES,
        string='Outcome',
        default='none',
        required=True,
    )
    started_at = fields.Datetime(string='Check-in Time', required=True, index=True)
    ended_at = fields.Datetime(string='End Time', readonly=True)
    duration_seconds = fields.Integer(
        string='Visit Duration (sec)',
        readonly=True,
        help='Time from GPS check-in until order placed or visit ended.',
    )
    duration_minutes = fields.Float(
        string='Visit Duration (min)',
        compute='_compute_duration_minutes',
        store=True,
    )
    check_in_latitude = fields.Float(string='Check-in Latitude', digits=(10, 7))
    check_in_longitude = fields.Float(string='Check-in Longitude', digits=(10, 7))
    check_in_distance_m = fields.Float(
        string='Distance at Check-in (m)',
        digits=(16, 2),
        readonly=True,
    )
    place_order_latitude = fields.Float(
        string='Place-order Latitude',
        digits=(10, 7),
        copy=False,
    )
    place_order_longitude = fields.Float(
        string='Place-order Longitude',
        digits=(10, 7),
        copy=False,
    )
    place_order_distance_m = fields.Float(
        string='Distance at Place Order (m)',
        digits=(16, 2),
        readonly=True,
        copy=False,
    )
    sale_order_id = fields.Many2one(
        'sale.order',
        string='Sales Order',
        readonly=True,
        copy=False,
    )
    sale_order_name = fields.Char(
        string='Order Reference',
        related='sale_order_id.name',
        readonly=True,
    )
    order_amount = fields.Monetary(
        string='Order Total',
        related='sale_order_id.amount_total',
        currency_field='currency_id',
    )
    currency_id = fields.Many2one(
        'res.currency',
        related='shop_id.currency_id',
    )
    line_ids = fields.One2many(
        'shahtaj.visit.line',
        'visit_id',
        string='Order Lines',
    )
    notes = fields.Text()

    # One open (non-cancelled) visit per task — cancelled/undone visits stay for audit.
    @api.constrains('visit_task_id', 'state')
    def _check_one_open_visit_per_task(self):
        for visit in self:
            if visit.state == 'cancelled' or not visit.visit_task_id:
                continue
            conflict = self.search([
                ('visit_task_id', '=', visit.visit_task_id.id),
                ('state', '!=', 'cancelled'),
                ('id', '!=', visit.id),
            ], limit=1)
            if conflict:
                raise ValidationError(_(
                    'This visit task already has a shop visit record.'
                ))

    @api.depends('shop_name', 'shop_id', 'started_at', 'order_booker_id')
    def _compute_name(self):
        for visit in self:
            shop = visit.shop_name or visit.sudo().shop_id.name or '?'
            booker = visit.order_booker_id.name or '?'
            when = fields.Datetime.to_string(visit.started_at) if visit.started_at else ''
            visit.name = f'{shop} — {booker} — {when}'

    @api.model
    def _snapshot_visit_labels(self, shop, route):
        """Store shop/route names on the visit for booker history screens."""
        return {
            'shop_name': shop.sudo().name or shop.display_name,
            'route_name': route.sudo().name if route else '',
        }

    @api.model
    def action_open_my_visits(self):
        """History list for order bookers (read-only, no order entry)."""
        list_view = self.env.ref(
            'shahtaj_oil.view_shahtaj_visit_list_booker',
            raise_if_not_found=False,
        )
        form_view = self.env.ref(
            'shahtaj_oil.view_shahtaj_visit_form_booker_history',
            raise_if_not_found=False,
        )
        search_view = self.env.ref(
            'shahtaj_oil.view_shahtaj_visit_search_booker',
            raise_if_not_found=False,
        )
        views = []
        if list_view:
            views.append((list_view.id, 'list'))
        if form_view:
            views.append((form_view.id, 'form'))
        action = {
            'type': 'ir.actions.act_window',
            'name': _('My Shop Visits'),
            'res_model': 'shahtaj.visit',
            'view_mode': 'list,form',
            'domain': [('order_booker_id', '=', self.env.uid)],
            'context': {'create': False},
            'target': 'current',
        }
        if views:
            action['views'] = views
        if search_view:
            action['search_view_id'] = search_view.id
        return action

    @api.depends('duration_seconds', 'started_at', 'state')
    def _compute_duration_minutes(self):
        now = fields.Datetime.now()
        for visit in self:
            if visit.state == 'in_progress' and visit.started_at:
                visit.duration_minutes = (now - visit.started_at).total_seconds() / 60.0
            else:
                visit.duration_minutes = (visit.duration_seconds or 0) / 60.0

    def _is_booker_only_user(self):
        """True when user is a booker but not distributor or admin."""
        user = self.env.user
        return (
            user.has_group('shahtaj_oil.group_shahtaj_order_booker')
            and not user.has_group('shahtaj_oil.group_shahtaj_distributor')
            and not user.has_group('base.group_system')
        )

    def write(self, vals):
        # System code sets visit/task state via context shahtaj_system_visit_write.
        if (
            self._is_booker_only_user()
            and not self.env.context.get('shahtaj_system_visit_write')
        ):
            extra = set(vals) - BOOKER_VISIT_WRITABLE_FIELDS
            if extra:
                raise ValidationError(_(
                    'You can only add products and notes during an active visit.'
                ))
        return super().write(vals)

    @api.model
    def _get_active_visit_for_user(self, user=None):
        user = user or self.env.user
        # Drop leftover visits from previous days so they cannot block today.
        self._close_stale_in_progress_visits(order_booker=user)
        return self.search([
            ('order_booker_id', '=', user.id),
            ('state', '=', 'in_progress'),
        ], limit=1)

    @api.model
    def _close_stale_in_progress_visits(self, order_booker=None):
        """End visits still in progress after their check-in day has passed.

        Called by cron and before resolving the booker's active visit so
        yesterday's abandoned check-in cannot block today's work.
        """
        today = fields.Date.context_today(self)
        domain = [('state', '=', 'in_progress')]
        if order_booker:
            domain.append(('order_booker_id', '=', order_booker.id))
        stale = self.sudo().search(domain).filtered(
            lambda v: fields.Datetime.context_timestamp(v, v.started_at).date() < today
        )
        for visit in stale:
            visit._auto_close_incomplete()
        return stale

    def _auto_close_incomplete(self):
        """Mark an abandoned overnight visit incomplete and free the booker."""
        self.ensure_one()
        if self.state != 'in_progress':
            return
        note = _(
            'Auto-closed: visit was still in progress after the day ended '
            '(incomplete — no order placed).'
        )
        existing = (self.notes or '').strip()
        notes = f'{existing}\n{note}' if existing else note
        now = fields.Datetime.now()
        duration = int((now - self.started_at).total_seconds()) if self.started_at else 0
        self.with_context(shahtaj_system_visit_write=True).write({
            'state': 'completed',
            'outcome': 'incomplete',
            'ended_at': now,
            'duration_seconds': max(duration, 0),
            'notes': notes,
        })
        task = self.visit_task_id
        if task and task.state == 'in_progress':
            task_note = _('Skipped automatically: visit left incomplete overnight.')
            task_notes = (task.notes or '').strip()
            task.with_context(shahtaj_system_visit_write=True).write({
                'state': 'skipped',
                'notes': f'{task_notes}\n{task_note}' if task_notes else task_note,
            })

    @api.model
    def _cron_close_stale_visits(self):
        """Daily job: close leftover in-progress visits from previous days."""
        self._close_stale_in_progress_visits()

    def action_open_booker_form(self):
        """Open the order-booker visit form (continue active or review completed)."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Active Shop Visit'),
            'res_model': 'shahtaj.visit',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref(
                    'shahtaj_oil.view_shahtaj_visit_form_booker'
                ).id, 'form'),
            ],
        }

    @api.model
    def action_open_my_active_visit(self):
        """Menu action: jump to the booker's in-progress visit, if any."""
        active = self._get_active_visit_for_user()
        if active:
            return active.action_open_booker_form()
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_visit_task_today',
        )

    @api.model
    def _validate_check_in_coordinates(
        self, shop, latitude, longitude, purpose='start a visit',
    ):
        """Reject if booker is outside company min/max shop GPS distance."""
        if not shop.partner_latitude or not shop.partner_longitude:
            raise UserError(_(
                'Shop "%(shop)s" has no GPS coordinates. '
                'Complete first-visit verification (shops/verify-on-site) '
                'or ask the distributor to set latitude and longitude.',
                shop=shop.name,
            ))
        if latitude is None or longitude is None:
            raise UserError(_(
                'Your GPS coordinates are required to %(purpose)s.',
                purpose=purpose,
            ))
        if not (-90 <= latitude <= 90):
            raise ValidationError(_('GPS latitude must be between -90 and 90.'))
        if not (-180 <= longitude <= 180):
            raise ValidationError(_('GPS longitude must be between -180 and 180.'))
        limits = get_shop_distance_limits(self.env)
        min_m = limits['min_m']
        max_m = limits['max_m']
        distance = shahtaj_distance_meters(
            latitude, longitude,
            shop.partner_latitude, shop.partner_longitude,
        )
        if distance < min_m:
            raise UserError(_(
                'You are %(distance).0f m from shop "%(shop)s". '
                'You must be at least %(min).0f m away to %(purpose)s '
                '(current company setting).',
                distance=distance,
                shop=shop.name,
                min=min_m,
                purpose=purpose,
            ))
        if distance > max_m:
            raise UserError(_(
                'You are %(distance).0f m from shop "%(shop)s". '
                'You must be within %(max).0f m to %(purpose)s '
                '(current company setting).',
                distance=distance,
                shop=shop.name,
                max=max_m,
                purpose=purpose,
            ))
        return distance

    @api.model
    def create_from_task_checkin(self, task, latitude, longitude):
        """GPS check-in: create visit, start timer, mark task in progress."""
        task.ensure_one()
        if task.order_booker_id != self.env.user and not self.env.su:
            raise UserError(_('You can only check in to your own visit tasks.'))
        # sudo for shop flag reads: booker is authorized by owning the visit task;
        # partner record rules can lag when schedules change mid-day.
        shop = task.shop_id.sudo()
        if shop.shop_approval_state != 'approved':
            raise UserError(_(
                'Shop "%(shop)s" is not approved yet. '
                'You cannot visit until the distributor approves it.',
                shop=shop.name,
            ))
        if not shop.shahtaj_field_verified:
            raise UserError(_(
                'Shop "%(shop)s" is tagged Not Visited. '
                'Complete first-visit setup (exterior photo + GPS) via '
                'shops/verify-on-site before normal check-in.',
                shop=shop.name,
            ))
        if not task._shahtaj_is_operational_for_booker():
            raise UserError(_(
                'Shop "%(shop)s" is no longer active on an operational route/zone. '
                'Ask your distributor to review the territory setup.',
                shop=shop.name,
            ))
        if task.state in ('completed', 'cancelled', 'skipped'):
            raise UserError(_('This visit task is already closed.'))
        existing = self.search([
            ('visit_task_id', '=', task.id),
            ('state', '!=', 'cancelled'),
        ], limit=1)
        if existing:
            if existing.state == 'in_progress':
                return existing
            raise UserError(_('This task already has a completed visit.'))
        active = self._get_active_visit_for_user(task.order_booker_id)
        if active:
            if active.visit_task_id == task:
                return active
            raise UserError(_(
                'You have an active visit at "%(shop)s". '
                'Finish that visit before checking in here.',
                shop=active.sudo().shop_id.name,
            ))
        distance = self._validate_check_in_coordinates(shop, latitude, longitude)
        now = fields.Datetime.now()
        visit = self.create({
            'visit_task_id': task.id,
            'order_booker_id': task.order_booker_id.id,
            'shop_id': shop.id,
            'route_id': task.route_id.id,
            **self._snapshot_visit_labels(shop, task.route_id),
            'started_at': now,
            'check_in_latitude': latitude,
            'check_in_longitude': longitude,
            'check_in_distance_m': distance,
            'state': 'in_progress',
            'outcome': 'none',
        })
        task.with_context(shahtaj_system_visit_write=True).write({
            'state': 'in_progress',
            'visit_id': visit.id,
        })
        self.env['shahtaj.activity.log'].log_business(
            operation='visit.check_in',
            name='Check in to shop',
            related_record=visit,
            message=_('Checked in at %(shop)s', shop=shop.display_name),
        )
        return visit

    def action_open_sale_order(self):
        self.ensure_one()
        if not self.sale_order_id:
            raise UserError(_('No sales order linked to this visit.'))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Sales Order'),
            'res_model': 'sale.order',
            'res_id': self.sale_order_id.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def action_open_shop(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Shop'),
            'res_model': 'res.partner',
            'res_id': self.shop_id.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_shop_form').id, 'form'),
            ],
        }

    def _finish_visit(self, outcome):
        """Close visit and mark linked task completed (order or no_order)."""
        self.ensure_one()
        if self.state != 'in_progress':
            raise UserError(_('Only an in-progress visit can be ended.'))
        now = fields.Datetime.now()
        duration = int((now - self.started_at).total_seconds())
        self.with_context(shahtaj_system_visit_write=True).write({
            'state': 'completed',
            'outcome': outcome,
            'ended_at': now,
            'duration_seconds': max(duration, 0),
        })
        self.visit_task_id.with_context(shahtaj_system_visit_write=True).write({
            'state': 'completed',
        })

    def _check_credit_limit(self, order_total):
        self.ensure_one()
        shop = self.shop_id
        if shop.shahtaj_shop_category == 'cash':
            return
        if not shop.use_partner_credit_limit or not shop.credit_limit:
            return
        outstanding = shop.sudo().credit
        currency = shop.currency_id or self.env.company.currency_id
        if float_compare(
            outstanding + order_total,
            shop.credit_limit,
            precision_rounding=currency.rounding,
        ) > 0:
            raise UserError(_(
                'Credit limit exceeded for shop "%(shop)s". '
                'Outstanding: %(outstanding).2f, order: %(order).2f, limit: %(limit).2f.',
                shop=shop.name,
                outstanding=outstanding,
                order=order_total,
                limit=shop.credit_limit,
            ))

    def _check_visit_line_stock(self):
        """Ensure each product total in this visit does not exceed bookable qty."""
        for visit in self.filtered(lambda v: v.state == 'in_progress'):
            totals = {}
            for line in visit.line_ids:
                if not line.product_id:
                    continue
                totals.setdefault(line.product_id, 0.0)
                totals[line.product_id] += line.product_uom_qty
            exclude_lines = visit.line_ids.ids
            for product, total_qty in totals.items():
                product._check_shahtaj_bookable_qty(
                    total_qty,
                    exclude_visit_line_ids=exclude_lines,
                )

    def action_place_order(self, latitude=None, longitude=None):
        """Create and confirm sale order from visit lines; finish visit.

        Mobile/API place-order must pass GPS with context
        ``shahtaj_require_place_order_gps=True`` (same distance rule as check-in).

        Native Odoo "Place Order" on the visit form has no GPS capture UI, so it
        does not require coordinates (check-in already validated location).
        """
        self.ensure_one()
        if self.state != 'in_progress':
            raise UserError(_('This visit is not in progress.'))
        if not self.shop_id._shahtaj_is_operational_for_booker():
            raise UserError(_(
                'Shop "%(shop)s" is no longer active on an operational route/zone.',
                shop=self.shop_id.name,
            ))
        # API sets shahtaj_require_place_order_gps=True. Native form button does not.
        require_gps = bool(self.env.context.get('shahtaj_require_place_order_gps'))
        if require_gps or latitude is not None or longitude is not None:
            if latitude is None or longitude is None:
                raise UserError(_(
                    'Your GPS coordinates are required to place an order.'
                ))
            distance = self._validate_check_in_coordinates(
                self.shop_id,
                float(latitude),
                float(longitude),
                purpose='place an order',
            )
            self.with_context(shahtaj_system_visit_write=True).write({
                'place_order_latitude': float(latitude),
                'place_order_longitude': float(longitude),
                'place_order_distance_m': distance,
            })
        if not self.line_ids:
            raise UserError(_('Add at least one product before placing an order.'))
        self._check_visit_line_stock()
        order_lines = []
        order_total = 0.0
        for line in self.line_ids:
            if line.product_uom_qty <= 0:
                raise UserError(_('Quantity must be greater than zero for all lines.'))
            subtotal = line.product_uom_qty * line.price_unit
            order_total += subtotal
            order_lines.append((0, 0, {
                'product_id': line.product_id.id,
                'product_uom_qty': line.product_uom_qty,
                'price_unit': line.price_unit,
            }))
        self._check_credit_limit(order_total)
        # sudo: booker has no Sales app rights; order is linked to visit and booker.
        order = self.env['sale.order'].sudo().create({
            'partner_id': self.shop_id.id,
            'user_id': self.order_booker_id.id,
            'origin': _('Shop visit %s', self.display_name),
            'shahtaj_visit_id': self.id,
            'shahtaj_visit_task_id': self.visit_task_id.id,
            'order_line': order_lines,
        })
        order.sudo().action_confirm()
        self.with_context(shahtaj_system_visit_write=True).write({
            'sale_order_id': order.id,
        })
        self._finish_visit('order')
        self.env['shahtaj.activity.log'].log_business(
            operation='visit.place_order',
            name='Place order from visit',
            related_record=self,
            message=_('Order %(order)s for %(shop)s',
                      order=order.display_name,
                      shop=self.shop_id.display_name),
        )
        # Bookers see completed visit; distributors can open the sales order form.
        if self._is_booker_only_user():
            return {
                'type': 'ir.actions.act_window',
                'name': _('Shop Visit'),
                'res_model': 'shahtaj.visit',
                'res_id': self.id,
                'view_mode': 'form',
                'target': 'current',
                'views': [
                    (self.env.ref('shahtaj_oil.view_shahtaj_visit_form_booker').id, 'form'),
                ],
            }
        return {
            'type': 'ir.actions.act_window',
            'name': _('Sales Order'),
            'res_model': 'sale.order',
            'res_id': order.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def action_end_without_order(self):
        for visit in self:
            visit._finish_visit('no_order')
            self.env['shahtaj.activity.log'].log_business(
                operation='visit.end_without_order',
                name='End visit without order',
                related_record=visit,
                message=_('Ended without order at %(shop)s',
                          shop=visit.shop_id.display_name),
            )
        return True

    def action_shahtaj_undo_completed_visit(self):
        """Distributor: undo a completed visit so the booker can redo it.

        Allowed only right after visit completion (no invoice, no delivery).
        Cancels the linked sale order when present, marks the visit cancelled,
        resets the visit task to pending, and notifies the order booker.
        """
        if not (
            self.env.user.has_group('shahtaj_oil.group_shahtaj_distributor')
            or self.env.user.has_group('base.group_system')
        ):
            raise UserError(_('Only distributors can undo a completed shop visit.'))

        for visit in self:
            visit._shahtaj_undo_completed_visit()
        return True

    def _shahtaj_undo_completed_visit(self):
        self.ensure_one()
        if self.state != 'completed':
            raise UserError(_(
                'Only a completed visit can be undone. '
                'In-progress visits should be finished or left for the booker.'
            ))
        if self.outcome == 'undone' or self.state == 'cancelled':
            raise UserError(_('This visit was already undone.'))

        order = self.sale_order_id.sudo() if self.sale_order_id else self.env['sale.order']
        if order:
            invoices = order.invoice_ids.filtered(lambda m: m.state != 'cancel')
            if invoices:
                raise UserError(_(
                    'Cannot undo visit "%(visit)s": sales order %(order)s already has '
                    'invoice(s) %(invoices)s. Reverse or cancel those invoices first '
                    'is not supported from this shortcut — undo is only allowed before invoicing.',
                    visit=self.display_name,
                    order=order.display_name,
                    invoices=', '.join(invoices.mapped('name')),
                ))
            if order.invoice_status == 'invoiced':
                raise UserError(_(
                    'Cannot undo visit "%(visit)s": order %(order)s is already invoiced.',
                    visit=self.display_name,
                    order=order.display_name,
                ))
            delivered = order.order_line.filtered(
                lambda l: not l.display_type and l.qty_delivered > 0
            )
            if delivered:
                raise UserError(_(
                    'Cannot undo visit "%(visit)s": order %(order)s already has deliveries. '
                    'Undo is only allowed before stock is delivered.',
                    visit=self.display_name,
                    order=order.display_name,
                ))
            if order.state in ('sale', 'done'):
                order.with_context(disable_cancel_warning=True).action_cancel()
            elif order.state == 'draft':
                order.action_cancel()

        note = _(
            'Undone by %(user)s on %(when)s. Order booker must check in again.',
            user=self.env.user.display_name,
            when=fields.Datetime.to_string(fields.Datetime.now()),
        )
        existing = (self.notes or '').strip()
        notes = f'{existing}\n{note}' if existing else note

        task = self.visit_task_id
        self.with_context(shahtaj_system_visit_write=True).write({
            'state': 'cancelled',
            'outcome': 'undone',
            'notes': notes,
        })
        if task:
            task.with_context(shahtaj_system_visit_write=True).write({
                'state': 'pending',
                'visit_id': False,
            })
            self._shahtaj_notify_booker_redo(task)

        self.env['shahtaj.activity.log'].log_business(
            operation='visit.undo',
            name='Visit undone by distributor',
            related_record=self,
            message=_(
                'Undid visit at %(shop)s for %(booker)s',
                shop=self.shop_id.display_name,
                booker=self.order_booker_id.display_name,
            ),
        )
        return True

    def _shahtaj_notify_booker_redo(self, task):
        """Create a to-do activity so the order booker knows to redo the visit."""
        self.ensure_one()
        booker = self.order_booker_id
        if not booker:
            return
        try:
            activity_type = self.env.ref(
                'mail.mail_activity_data_todo',
                raise_if_not_found=False,
            )
            model = self.env['ir.model']._get('shahtaj.visit.task')
            if not activity_type or not model:
                return
            self.env['mail.activity'].sudo().create({
                'activity_type_id': activity_type.id,
                'res_model_id': model.id,
                'res_id': task.id,
                'user_id': booker.id,
                'summary': _('Redo shop visit: %s', self.shop_id.display_name),
                'note': _(
                    '<p>Distributor <b>%(user)s</b> undid your completed visit at '
                    '<b>%(shop)s</b>.</p>'
                    '<p>Please check in again and complete the visit.</p>',
                    user=self.env.user.display_name,
                    shop=self.shop_id.display_name,
                ),
                'date_deadline': fields.Date.context_today(self),
            })
        except Exception:
            # Notification must never block the undo itself.
            pass


class ShahtajVisitLine(models.Model):
    """Draft cart lines on a visit before Place Order creates the sale order."""
    _name = 'shahtaj.visit.line'
    _description = 'Shop Visit Order Line'
    _order = 'id'

    visit_id = fields.Many2one(
        'shahtaj.visit',
        string='Visit',
        required=True,
        ondelete='cascade',
    )
    product_id = fields.Many2one(
        'product.product',
        string='Product',
        required=True,
        domain=[
            ('active', '=', True),
            ('product_tmpl_id.active', '=', True),
            ('sale_ok', '=', True),
        ],
    )
    product_name = fields.Char(
        string='Product',
        readonly=True,
        help='Copied when the line is saved for visit history display.',
    )
    shahtaj_qty_bookable = fields.Float(
        string='Available to Book',
        compute='_compute_shahtaj_qty_bookable',
        digits='Product Unit of Measure',
    )
    shahtaj_qty_unlimited = fields.Boolean(
        compute='_compute_shahtaj_qty_bookable',
    )
    product_uom_qty = fields.Float(
        string='Quantity',
        default=1.0,
        required=True,
        digits='Product Unit of Measure',
    )
    price_unit = fields.Float(
        string='Unit Price',
        digits='Product Price',
    )
    subtotal = fields.Float(
        string='Subtotal',
        compute='_compute_subtotal',
    )

    @api.depends(
        'product_id',
        'product_uom_qty',
        'visit_id.state',
        'visit_id.line_ids.product_uom_qty',
        'visit_id.line_ids.product_id',
    )
    def _compute_shahtaj_qty_bookable(self):
        for line in self:
            if not line.product_id:
                line.shahtaj_qty_bookable = 0.0
                line.shahtaj_qty_unlimited = False
                continue
            exclude = line.visit_id.line_ids.ids if line.visit_id else line.ids
            bookable = line.product_id._get_shahtaj_bookable_qty(
                exclude_visit_line_ids=exclude,
            )
            if bookable is None:
                line.shahtaj_qty_unlimited = True
                line.shahtaj_qty_bookable = 0.0
            else:
                line.shahtaj_qty_unlimited = False
                line.shahtaj_qty_bookable = bookable

    @api.onchange('product_id')
    def _onchange_product_id(self):
        if self.product_id:
            self.price_unit = self.product_id.lst_price
            self.product_name = self.product_id.display_name

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('product_id'):
                product = self.env['product.product'].with_context(
                    active_test=False,
                ).browse(vals['product_id'])
                if (
                    not product.exists()
                    or not product.active
                    or not product.product_tmpl_id.active
                    or not product.sale_ok
                ):
                    raise UserError(_(
                        'Cannot add archived or unavailable product "%(product)s".',
                        product=product.display_name or vals['product_id'],
                    ))
                if not vals.get('product_name'):
                    vals['product_name'] = product.display_name
        return super().create(vals_list)

    def write(self, vals):
        if vals.get('product_id'):
            product = self.env['product.product'].with_context(
                active_test=False,
            ).browse(vals['product_id'])
            if (
                not product.exists()
                or not product.active
                or not product.product_tmpl_id.active
                or not product.sale_ok
            ):
                raise UserError(_(
                    'Cannot use archived or unavailable product "%(product)s".',
                    product=product.display_name or vals['product_id'],
                ))
            if not vals.get('product_name'):
                vals['product_name'] = product.display_name
        return super().write(vals)

    @api.constrains('product_uom_qty', 'product_id', 'visit_id')
    def _check_bookable_quantity(self):
        for visit in self.mapped('visit_id').filtered(lambda v: v.state == 'in_progress'):
            visit._check_visit_line_stock()

    @api.depends('product_uom_qty', 'price_unit')
    def _compute_subtotal(self):
        for line in self:
            line.subtotal = line.product_uom_qty * line.price_unit
