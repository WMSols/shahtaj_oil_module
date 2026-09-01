# -*- coding: utf-8 -*-
"""Daily visit tasks: one row per shop per booker per date.

Tasks are built from weekly schedules (cron, login, API today, or schedule sync).
A pending task is valid only while an active weekly schedule covers the same
order booker + route + weekday. Orphan pending tasks are cancelled on generate.
Completed / in_progress / skipped are never auto-cancelled (history).
Bookers check in via GPS; distributors can skip or cancel tasks.
"""
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError

# How many days ahead to auto-create tasks (today + this many days).
AUTO_GENERATE_DAYS_AHEAD = 13


def shahtaj_week_bounds(day):
    """Return Monday–Sunday bounds for the week containing *day*."""
    start = day - timedelta(days=day.weekday())
    return start, start + timedelta(days=6)

TASK_STATES = [
    ('pending', 'Pending'),
    ('in_progress', 'In Progress'),
    ('completed', 'Completed'),
    ('skipped', 'Skipped'),
    ('cancelled', 'Cancelled'),
]

# Fields order bookers may edit on their own tasks (see write()).
BOOKER_WRITABLE_FIELDS = frozenset({'state', 'notes', 'visit_id'})
DISTRIBUTOR_PLANNING_FIELDS = frozenset({
    'scheduled_date', 'route_id', 'shop_id', 'order_booker_id',
    'delivery_man_id', 'task_kind', 'notes',
})
TASK_PLANNING_FIELD_LABELS = {
    'scheduled_date': 'Scheduled Date',
    'route_id': 'Route',
    'shop_id': 'Shop',
    'order_booker_id': 'Order Booker',
    'delivery_man_id': 'Delivery Man',
    'task_kind': 'Task Type',
    'notes': 'Notes',
}


class ShahtajVisitTask(models.Model):
    _name = 'shahtaj.visit.task'
    _description = 'Visit Task'
    _order = 'scheduled_date desc, route_id, shop_id'

    name = fields.Char(compute='_compute_name', store=True)
    task_kind = fields.Selection(
        [
            ('order_booker', 'Order Booker'),
            ('delivery_man', 'Delivery Man'),
        ],
        string='Staff Type',
        default='order_booker',
        required=True,
        index=True,
    )
    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        index=True,
        ondelete='restrict',
    )
    dm_delivery_id = fields.Many2one(
        'shahtaj.dm.delivery',
        string='DM Delivery',
        index=True,
        ondelete='cascade',
        copy=False,
    )
    order_booker_id = fields.Many2one(
        'res.users',
        string='Order Booker',
        required=True,
        index=True,
        ondelete='restrict',
    )
    route_id = fields.Many2one(
        'shahtaj.route',
        string='Route',
        required=True,
        ondelete='restrict',
    )
    zone_id = fields.Many2one(
        'shahtaj.zone',
        related='route_id.zone_id',
        store=True,
        readonly=True,
    )
    shop_id = fields.Many2one(
        'res.partner',
        string='Shop',
        required=True,
        domain=[
            ('is_shahtaj_shop', '=', True),
            ('shop_approval_state', '=', 'approved'),
        ],
        ondelete='restrict',
    )
    shop_visit_tag = fields.Selection(
        related='shop_id.shahtaj_visit_tag',
        string='Shop Visit',
        readonly=True,
    )
    scheduled_date = fields.Date(
        string='Scheduled Date',
        required=True,
        index=True,
    )
    state = fields.Selection(
        TASK_STATES,
        string='Status',
        default='pending',
        required=True,
    )
    weekly_schedule_id = fields.Many2one(
        'shahtaj.weekly.schedule',
        string='Weekly Schedule',
        ondelete='set null',
    )
    visit_id = fields.Many2one(
        'shahtaj.visit',
        string='Shop Visit',
        readonly=True,
        copy=False,
    )
    shahtaj_has_active_visit_elsewhere = fields.Boolean(
        string='Active Visit Elsewhere',
        compute='_compute_shahtaj_has_active_visit_elsewhere',
    )

    @api.depends('visit_id', 'state')
    @api.depends_context('uid')
    def _compute_shahtaj_has_active_visit_elsewhere(self):
        active = self.env['shahtaj.visit']._get_active_visit_for_user()
        for task in self:
            task.shahtaj_has_active_visit_elsewhere = bool(
                active
                and (not task.visit_id or active.visit_task_id != task)
                and active.state == 'in_progress'
            )
    visit_duration_minutes = fields.Float(
        related='visit_id.duration_minutes',
        string='Visit Time (min)',
    )
    notes = fields.Text()
    shahtaj_planning_locked = fields.Boolean(
        string='Planning Locked',
        compute='_compute_shahtaj_planning_locked',
    )

    @api.depends(
        'state', 'visit_id', 'visit_id.state',
        'dm_delivery_id', 'dm_delivery_id.state',
    )
    def _compute_shahtaj_planning_locked(self):
        for task in self:
            task.shahtaj_planning_locked = task._shahtaj_is_planning_locked()

    # Uniqueness for OB / DM tasks is enforced by partial SQL indexes
    # (see migrations/19.0.1.1.72). Models.Constraint cannot express
    # "only when task_kind = order_booker" cleanly with nullable DM.
    _dm_delivery_task_unique = models.Constraint(
        'unique(dm_delivery_id)',
        'A visit task already exists for this delivery job.',
    )

    @api.depends('shop_id', 'scheduled_date', 'route_id')
    def _compute_name(self):
        for task in self:
            shop = task.shop_id.name or '?'
            date = task.scheduled_date or ''
            route = task.route_id.name or ''
            task.name = f'{date} — {route} — {shop}'

    @api.constrains('shop_id', 'route_id')
    def _check_shop_on_route(self):
        for task in self:
            # DM tasks are driven by invoiced SOs, not OB route assignment.
            if task.task_kind == 'delivery_man':
                continue
            if task.shop_id and task.shop_id.shop_approval_state != 'approved':
                raise ValidationError(_(
                    'Shop "%(shop)s" is not approved. '
                    'Only approved shops can be scheduled or visited.',
                    shop=task.shop_id.name,
                ))
            if task.shop_id and task.route_id:
                shop_routes = task.shop_id.route_ids
                if task.shop_id.route_id:
                    shop_routes |= task.shop_id.route_id
                if task.route_id not in shop_routes:
                    raise ValidationError(_(
                        'Shop "%(shop)s" is not on route "%(route)s". '
                        'Assign the shop to this route first.',
                        shop=task.shop_id.name,
                        route=task.route_id.name,
                    ))

    def action_start(self):
        """Legacy — prefer GPS check-in via action_check_in_at_shop."""
        self.write({'state': 'in_progress'})

    def action_check_in_at_shop(self):
        """Open GPS wizard, or reopen visit if already checked in."""
        self.ensure_one()
        if self.shop_id.shop_approval_state != 'approved':
            raise UserError(_(
                'Shop "%(shop)s" is not approved yet. '
                'You cannot visit until the distributor approves it.',
                shop=self.shop_id.name,
            ))
        active = self.env['shahtaj.visit']._get_active_visit_for_user()
        if active:
            if active.visit_task_id == self:
                return self.action_open_visit()
            return active.action_open_booker_form()
        if self.visit_id and self.visit_id.state == 'in_progress':
            return self.action_open_visit()
        return {
            'type': 'ir.actions.act_window',
            'name': (
                _('First-Visit Verify & Check-in')
                if not self.shop_id.shahtaj_field_verified
                else _('Check in at Shop')
            ),
            'res_model': 'shahtaj.visit.checkin.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_visit_task_id': self.id,
            },
        }

    def action_open_visit(self):
        self.ensure_one()
        if not self.visit_id:
            raise ValidationError(_('No shop visit started for this task yet.'))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Shop Visit'),
            'res_model': 'shahtaj.visit',
            'res_id': self.visit_id.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_visit_form_booker').id, 'form'),
            ],
        }

    def action_open_active_visit_from_task(self):
        """Jump to another in-progress visit when this task has not started yet."""
        active = self.env['shahtaj.visit']._get_active_visit_for_user()
        if not active:
            raise UserError(_(
                'You do not have an active shop visit. Tap "I\'m at Shop" to start one.'
            ))
        return active.action_open_booker_form()

    def action_complete(self):
        self.write({'state': 'completed'})

    def action_skip(self):
        Log = self.env['shahtaj.activity.log']
        try:
            for task in self:
                if task.visit_id and task.visit_id.state == 'in_progress':
                    raise ValidationError(_(
                        'End the active shop visit before skipping this task.'
                    ))
            self.write({'state': 'skipped'})
            for task in self:
                Log.log_business(
                    operation='task.skip',
                    name='Skip visit task',
                    related_record=task,
                    message=task.display_name,
                    status='success',
                )
        except Exception as exc:
            Log.log_exception(
                operation='task.skip',
                name='Skip visit task failed',
                exc=exc,
                message=', '.join(self.mapped('display_name')),
            )
            raise

    def action_cancel(self):
        Log = self.env['shahtaj.activity.log']
        try:
            self.write({'state': 'cancelled'})
            for task in self:
                Log.log_business(
                    operation='task.cancel',
                    name='Cancel visit task',
                    related_record=task,
                    message=task.display_name,
                    status='success',
                )
        except Exception as exc:
            Log.log_exception(
                operation='task.cancel',
                name='Cancel visit task failed',
                exc=exc,
                message=', '.join(self.mapped('display_name')),
            )
            raise

    def action_reset_pending(self):
        Log = self.env['shahtaj.activity.log']
        try:
            self.write({'state': 'pending'})
            for task in self:
                Log.log_business(
                    operation='task.reset_pending',
                    name='Reset visit task to pending',
                    related_record=task,
                    message=task.display_name,
                    status='success',
                )
        except Exception as exc:
            Log.log_exception(
                operation='task.reset_pending',
                name='Reset visit task failed',
                exc=exc,
                message=', '.join(self.mapped('display_name')),
            )
            raise

    def _is_booker_only_user(self):
        user = self.env.user
        return (
            user.has_group('shahtaj_oil.group_shahtaj_order_booker')
            and not user.has_group('shahtaj_oil.group_shahtaj_distributor')
            and not user.has_group('base.group_system')
        )

    def _shahtaj_is_planning_locked(self):
        """Completed/cancelled visits or in-progress shop work cannot be rescheduled."""
        self.ensure_one()
        if self.state in ('completed', 'cancelled'):
            return True
        if self.state == 'in_progress':
            return True
        if self.visit_id and self.visit_id.state == 'in_progress':
            return True
        if self.dm_delivery_id and self.dm_delivery_id._shahtaj_is_processing_locked():
            return True
        return False

    def write(self, vals):
        # Bookers cannot edit distributor-only fields on tasks.
        if self._is_booker_only_user() and not self.env.context.get('shahtaj_system_visit_write'):
            extra = set(vals) - BOOKER_WRITABLE_FIELDS
            if extra:
                raise ValidationError(_(
                    'You can only update visit status and notes on your tasks.'
                ))
        planning_vals = DISTRIBUTOR_PLANNING_FIELDS.intersection(vals)
        user = self.env.user
        is_distributor = (
            not self.env.context.get('shahtaj_system_visit_write')
            and user.has_group('shahtaj_oil.group_shahtaj_distributor')
            and not user._is_public()
        )
        if planning_vals and is_distributor:
            locked = self.filtered('_shahtaj_is_planning_locked')
            if locked:
                raise ValidationError(_(
                    'Cannot reschedule %(names)s — the visit is completed, in progress, '
                    'or delivery stock has already been picked.',
                    names=', '.join(locked.mapped('display_name')),
                ))
            self.env['shahtaj.activity.log'].log_model_field_changes(
                self,
                operation='task.update',
                title='Visit task updated',
                vals={k: vals[k] for k in planning_vals},
                field_labels=TASK_PLANNING_FIELD_LABELS,
            )
        return super().write(vals)

    @api.model
    def _shahtaj_log_cancelled_tasks(self, operation, name, tasks, extra_message=None):
        """One success row summarizing a batch cancel (avoid N logs per task)."""
        if not tasks:
            return
        sample = ', '.join(tasks[:8].mapped('display_name'))
        if len(tasks) > 8:
            sample = f'{sample}, …'
        message = f'cancelled={len(tasks)}'
        if extra_message:
            message = f'{message}; {extra_message}'
        message = f'{message}; {sample}'
        self.env['shahtaj.activity.log'].log_system(
            operation=operation,
            name=name,
            message=message,
            status='success',
            related_record=tasks[:1],
        )

    @api.model
    def _cancel_pending_tasks_for_unapproved_shops(self, date_from=None, date_to=None):
        """Remove pending visit tasks for shops that are not approved."""
        domain = [
            ('state', '=', 'pending'),
            ('shop_id.shop_approval_state', '!=', 'approved'),
        ]
        if date_from:
            domain.append(('scheduled_date', '>=', date_from))
        if date_to:
            domain.append(('scheduled_date', '<=', date_to))
        pending = self.search(domain)
        if pending:
            pending.with_context(shahtaj_system_visit_write=True).write({'state': 'cancelled'})
            self._shahtaj_log_cancelled_tasks(
                'task.cancel_unapproved',
                'Cancel pending tasks (unapproved shops)',
                pending,
            )
        return pending

    @api.model
    def _cancel_pending_tasks_for_non_operational(self, date_from=None, date_to=None):
        """Cancel pending tasks tied to archived or inactive territory."""
        domain = [('state', '=', 'pending')]
        if date_from:
            domain.append(('scheduled_date', '>=', date_from))
        if date_to:
            domain.append(('scheduled_date', '<=', date_to))
        pending = self.search(domain)
        invalid = pending.filtered(
            lambda t: not t._shahtaj_is_operational_for_booker(),
        )
        if invalid:
            invalid.with_context(shahtaj_system_visit_write=True).write({
                'state': 'cancelled',
            })
            self._shahtaj_log_cancelled_tasks(
                'task.cancel_non_operational',
                'Cancel pending tasks (non-operational territory)',
                invalid,
            )
        return invalid

    def _shahtaj_is_operational_for_booker(self):
        """True when this task's route is active and the shop is still on it.

        Shop/route flags are read with sudo so booker partner ACL edge-cases
        (e.g. schedule removed while today's task still exists) do not raise
        AccessError. Callers must already scope tasks to the current booker.
        """
        self.ensure_one()
        route = self.route_id.sudo()
        shop = self.shop_id.sudo().with_context(active_test=False)
        if not route or not shop:
            return False
        if not route._shahtaj_is_operational_for_booker():
            return False
        if not shop.active or shop.shop_approval_state != 'approved':
            return False
        # Multi-route: shop may be operational via another route; this task
        # only counts if the shop is still linked to *this* route.
        return route in shop.route_ids.with_context(active_test=False)

    def _shahtaj_matches_active_weekly_schedule(self):
        """True when an active weekly schedule covers this task's booker/route/weekday.

        Pending work is only valid while such a schedule exists. Multiple routes
        on the same weekday are allowed (unique is booker+route+day).
        """
        self.ensure_one()
        if not self.scheduled_date or not self.order_booker_id or not self.route_id:
            return False
        weekday = str(self.scheduled_date.weekday())
        Schedule = self.env['shahtaj.weekly.schedule'].sudo()
        schedule = Schedule.search([
            ('active', '=', True),
            ('order_booker_id', '=', self.order_booker_id.id),
            ('route_id', '=', self.route_id.id),
            ('day_of_week', '=', weekday),
        ], limit=1)
        return bool(
            schedule
            and schedule.route_id._shahtaj_is_operational_for_booker()
        )

    def _shahtaj_belongs_on_booker_day_list(self):
        """Whether this task should appear on My Tasks Today / tasks/today.

        - Cancelled: never
        - Territory must be operational
        - Pending: must still match an active weekly schedule for that weekday
        - Completed / in_progress / skipped: keep (history of work that day)
        """
        self.ensure_one()
        if self.task_kind == 'delivery_man':
            return False
        if self.state == 'cancelled':
            return False
        if not self._shahtaj_is_operational_for_booker():
            return False
        if self.state == 'pending':
            return self._shahtaj_matches_active_weekly_schedule()
        return True

    @api.model
    def _cancel_orphan_pending_tasks(
        self, date_from=None, date_to=None, order_booker=None,
    ):
        """Cancel pending tasks that no longer match any active weekly schedule.

        Does not touch completed, in_progress, or skipped tasks.
        Does not touch Delivery Man tasks (managed from DM deliveries).
        """
        domain = [
            ('state', '=', 'pending'),
            ('task_kind', '=', 'order_booker'),
        ]
        if order_booker:
            domain.append(('order_booker_id', '=', order_booker.id))
        if date_from:
            domain.append(('scheduled_date', '>=', date_from))
        if date_to:
            domain.append(('scheduled_date', '<=', date_to))
        pending = self.search(domain)
        if not pending:
            return self.browse()

        Schedule = self.env['shahtaj.weekly.schedule']
        schedule_domain = [
            ('active', '=', True),
            ('order_booker_id', 'in', pending.mapped('order_booker_id').ids),
        ]
        schedules = Schedule.search(schedule_domain).filtered(
            lambda s: s.route_id._shahtaj_is_operational_for_booker(),
        )
        valid_keys = {
            (s.order_booker_id.id, s.route_id.id, s.day_of_week)
            for s in schedules
        }
        orphans = pending.filtered(
            lambda t: (
                t.order_booker_id.id,
                t.route_id.id,
                str(t.scheduled_date.weekday()) if t.scheduled_date else None,
            ) not in valid_keys
        )
        if orphans:
            orphans.with_context(shahtaj_system_visit_write=True).write({
                'state': 'cancelled',
            })
            booker_msg = (
                f'booker={order_booker.display_name}'
                if order_booker else 'booker=all'
            )
            self._shahtaj_log_cancelled_tasks(
                'task.cancel_orphan',
                'Cancel orphan pending tasks (no matching schedule)',
                orphans,
                extra_message=booker_msg,
            )
        return orphans

    @api.model
    def _generate_from_schedules(self, date_from, date_to, order_booker=None):
        """For each day in range: match weekday schedules → one task per shop on route."""
        Log = self.env['shahtaj.activity.log']
        booker_label = order_booker.display_name if order_booker else 'all bookers'
        try:
            unapproved = self._cancel_pending_tasks_for_unapproved_shops(
                date_from, date_to,
            )
            non_op = self._cancel_pending_tasks_for_non_operational(
                date_from, date_to,
            )
            # Drop pending leftovers for routes/days no longer on the booker's plan
            # (e.g. schedule deleted earlier without a clean cancel).
            orphans = self._cancel_orphan_pending_tasks(
                date_from, date_to, order_booker=order_booker,
            )

            Schedule = self.env['shahtaj.weekly.schedule']
            schedule_domain = [('active', '=', True)]
            if order_booker:
                schedule_domain.append(('order_booker_id', '=', order_booker.id))
            schedules = Schedule.search(schedule_domain).filtered(
                lambda s: s.route_id._shahtaj_is_operational_for_booker(),
            )

            created = self.env['shahtaj.visit.task']
            reactivated = self.env['shahtaj.visit.task']
            skipped = 0
            day = date_from
            while day <= date_to:
                weekday = str(day.weekday())
                day_schedules = schedules.filtered(lambda s: s.day_of_week == weekday)
                for schedule in day_schedules:
                    approved_shops = schedule.route_id.shop_ids.filtered(
                        lambda s: s._shahtaj_is_operational_for_booker(),
                    )
                    for shop in approved_shops:
                        existing = self.search([
                            ('shop_id', '=', shop.id),
                            ('scheduled_date', '=', day),
                            ('order_booker_id', '=', schedule.order_booker_id.id),
                            ('route_id', '=', schedule.route_id.id),
                            ('task_kind', '=', 'order_booker'),
                        ], limit=1)
                        if existing:
                            if (
                                existing.state == 'cancelled'
                                and shop._shahtaj_is_operational_for_booker()
                            ):
                                existing.with_context(
                                    shahtaj_system_visit_write=True,
                                ).write({
                                    'state': 'pending',
                                    'route_id': schedule.route_id.id,
                                    'weekly_schedule_id': schedule.id,
                                })
                                reactivated |= existing
                            else:
                                skipped += 1
                            continue
                        created |= self.create({
                            'task_kind': 'order_booker',
                            'order_booker_id': schedule.order_booker_id.id,
                            'route_id': schedule.route_id.id,
                            'shop_id': shop.id,
                            'scheduled_date': day,
                            'weekly_schedule_id': schedule.id,
                            'state': 'pending',
                        })
                day = fields.Date.add(day, days=1)

            changed = bool(
                created or reactivated or unapproved or non_op or orphans
            )
            if changed or self.env.context.get('shahtaj_force_task_generate_log'):
                Log.log_system(
                    operation='task.generate',
                    name='Generate visit tasks',
                    message=(
                        f'{booker_label}; {date_from}→{date_to}; '
                        f'created={len(created)} reactivated={len(reactivated)} '
                        f'skipped={skipped}; '
                        f'cancelled_unapproved={len(unapproved)} '
                        f'cancelled_non_op={len(non_op)} '
                        f'cancelled_orphan={len(orphans)}'
                    ),
                    status='success',
                    related_record=(created[:1] or reactivated[:1] or None),
                )
            return created, skipped
        except Exception as exc:
            Log.log_exception(
                operation='task.generate',
                name='Generate visit tasks failed',
                exc=exc,
                message=f'{booker_label}; {date_from}→{date_to}',
                source=(
                    'cron' if self.env.context.get('shahtaj_cron') else None
                ),
            )
            raise

    @api.model
    def _cron_auto_generate_visit_tasks(self):
        """Called daily by scheduled action for all bookers."""
        # Close abandoned visits first so leftover check-ins cannot block today.
        self = self.with_context(
            shahtaj_cron=True,
            shahtaj_force_task_generate_log=True,
        )
        try:
            self.env['shahtaj.visit']._cron_close_stale_visits()
            self._auto_generate_window()
        except Exception as exc:
            self.env['shahtaj.activity.log'].log_exception(
                operation='task.generate',
                name='Cron visit task generate failed',
                exc=exc,
                source='cron',
            )
            raise

    @api.model
    def _auto_generate_window(self, order_booker=None):
        """Generate visit tasks for today through the rolling window."""
        # Also expire leftover visits for this booker (or all) before new day work.
        self.env['shahtaj.visit']._close_stale_in_progress_visits(
            order_booker=order_booker,
        )
        today = fields.Date.context_today(self)
        end = fields.Date.add(today, days=AUTO_GENERATE_DAYS_AHEAD)
        return self._generate_from_schedules(today, end, order_booker=order_booker)

    @api.model
    def action_shahtaj_open_my_tasks_today(self):
        """Booker menu: refresh plan, drop orphan pending, then open today's list."""
        user = self.env.user
        self.sudo()._auto_generate_window(order_booker=user)
        return {
            'type': 'ir.actions.act_window',
            'name': _('My Tasks Today'),
            'res_model': 'shahtaj.visit.task',
            'view_mode': 'list,form',
            'search_view_id': self.env.ref(
                'shahtaj_oil.view_shahtaj_visit_task_search'
            ).id,
            'domain': [
                ('order_booker_id', '=', user.id),
                ('task_kind', '=', 'order_booker'),
                ('state', 'not in', ['cancelled']),
            ],
            'context': {
                'search_default_today': 1,
                'search_default_group_route': 1,
            },
            'views': [
                (
                    self.env.ref(
                        'shahtaj_oil.view_shahtaj_visit_task_list_booker'
                    ).id,
                    'list',
                ),
                (
                    self.env.ref(
                        'shahtaj_oil.view_shahtaj_visit_task_form_booker'
                    ).id,
                    'form',
                ),
            ],
        }
