# -*- coding: utf-8 -*-
"""Weekly plan: which order booker works which route on which weekday.

Changing schedules refreshes visit tasks for the next ~2 weeks.
A schedule day is locked only while it is *today* and visits are already
in progress or completed. Past weekdays can be edited for upcoming weeks.
"""
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

DAY_SELECTION = [
    ('0', 'Monday'),
    ('1', 'Tuesday'),
    ('2', 'Wednesday'),
    ('3', 'Thursday'),
    ('4', 'Friday'),
    ('5', 'Saturday'),
    ('6', 'Sunday'),
]


class ShahtajWeeklySchedule(models.Model):
    _name = 'shahtaj.weekly.schedule'
    _description = 'Weekly Route Schedule'
    _order = 'order_booker_id, day_of_week, route_id'

    name = fields.Char(compute='_compute_name', store=True)
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
    day_of_week = fields.Selection(
        DAY_SELECTION,
        string='Day of Week',
        required=True,
    )
    active = fields.Boolean(default=True)
    shop_count = fields.Integer(
        related='route_id.shop_count',
        string='Shops on Route',
    )
    week_occurrence_date = fields.Date(
        string='This Week',
        compute='_compute_week_progress',
    )
    week_tasks_planned = fields.Integer(
        string='Visits Planned',
        compute='_compute_week_progress',
    )
    week_tasks_completed = fields.Integer(
        string='Visits Done',
        compute='_compute_week_progress',
    )
    week_tasks_progress = fields.Float(
        string='Day Progress %',
        compute='_compute_week_progress',
    )
    week_tasks_skipped = fields.Integer(
        string='Tasks Skipped',
        compute='_compute_week_progress',
        store=True,
    )
    is_day_locked = fields.Boolean(
        string='Locked (Today)',
        compute='_compute_is_day_locked',
        help='Locked only when this schedule day is today and visits are '
             'already in progress or completed. Past weekdays stay editable '
             'so distributors can plan the next occurrence.',
    )

    @api.constrains('route_id', 'active')
    def _check_route_operational(self):
        for schedule in self.filtered('active'):
            if schedule.route_id and not schedule.route_id._shahtaj_is_operational_for_booker():
                raise ValidationError(_(
                    'Weekly schedule route "%(route)s" is archived or its zone is inactive.',
                    route=schedule.route_id.display_name,
                ))

    _booker_day_unique = models.Constraint(
        'unique(order_booker_id, day_of_week)',
        'This order booker already has a schedule on the selected day '
        '(one route per weekday).',
    )

    @api.constrains('order_booker_id', 'day_of_week', 'active')
    def _check_one_schedule_per_booker_day(self):
        """Match portal: one schedule line per booker per weekday."""
        for schedule in self:
            if not schedule.order_booker_id or schedule.day_of_week is False:
                continue
            siblings = self.search([
                ('id', '!=', schedule.id),
                ('order_booker_id', '=', schedule.order_booker_id.id),
                ('day_of_week', '=', schedule.day_of_week),
            ], limit=1)
            if siblings:
                day_labels = dict(DAY_SELECTION)
                raise ValidationError(_(
                    'Order booker "%(booker)s" already has a schedule on '
                    '%(day)s. One route per day only — edit or deactivate '
                    'the existing line first.',
                    booker=schedule.order_booker_id.display_name,
                    day=day_labels.get(schedule.day_of_week, schedule.day_of_week),
                ))

    @api.depends('order_booker_id', 'route_id', 'day_of_week')
    def _compute_name(self):
        day_labels = dict(DAY_SELECTION)
        for schedule in self:
            booker = schedule.order_booker_id.name or '?'
            route = schedule.route_id.name or '?'
            day = day_labels.get(schedule.day_of_week, '?')
            schedule.name = f'{booker} — {day} — {route}'

    @api.depends('order_booker_id', 'route_id', 'day_of_week', 'active')
    def _compute_week_progress(self):
        Task = self.env['shahtaj.visit.task']
        today = fields.Date.context_today(self)
        week_start = today - timedelta(days=today.weekday())
        for schedule in self:
            if not schedule.active or not schedule.order_booker_id:
                schedule.week_occurrence_date = False
                schedule.week_tasks_planned = 0
                schedule.week_tasks_completed = 0
                schedule.week_tasks_progress = 0.0
                continue
            occurrence = week_start + timedelta(days=int(schedule.day_of_week))
            schedule.week_occurrence_date = occurrence
            tasks = Task.search([
                ('order_booker_id', '=', schedule.order_booker_id.id),
                ('route_id', '=', schedule.route_id.id),
                ('scheduled_date', '=', occurrence),
                ('state', '!=', 'cancelled'),
            ])
            planned = len(tasks)
            completed = len(tasks.filtered(lambda t: t.state == 'completed'))
            schedule.week_tasks_planned = planned
            schedule.week_tasks_completed = completed
            schedule.week_tasks_progress = (
                (completed / planned * 100.0) if planned else 0.0
            )
            skipped_count = self.env['shahtaj.visit.task'].search_count([
            ('weekly_schedule_id', '=', schedule.id),
            ('state', 'in', ('skipped', 'cancelled'))
           ])
            schedule.week_tasks_skipped = skipped_count

    def _today_weekday(self):
        return str(fields.Date.context_today(self).weekday())

    def _occurrence_date(self):
        self.ensure_one()
        today = fields.Date.context_today(self)
        week_start = today - timedelta(days=today.weekday())
        return week_start + timedelta(days=int(self.day_of_week))

    def _is_today_occurrence(self):
        self.ensure_one()
        return self.day_of_week == self._today_weekday()

    def _get_occurrence_tasks(self):
        """Visit tasks for this schedule line on its occurrence date this week."""
        Task = self.env['shahtaj.visit.task']
        tasks = Task.browse()
        for schedule in self:
            if not schedule.order_booker_id or not schedule.route_id:
                continue
            tasks |= Task.search([
                ('order_booker_id', '=', schedule.order_booker_id.id),
                ('route_id', '=', schedule.route_id.id),
                ('scheduled_date', '=', schedule._occurrence_date()),
                ('state', '!=', 'cancelled'),
            ])
        return tasks

    def _get_blocking_tasks(self):
        """Blocking only applies when the schedule day is today."""
        tasks = self.env['shahtaj.visit.task']
        for schedule in self:
            if not schedule._is_today_occurrence():
                continue
            tasks |= schedule._get_occurrence_tasks().filtered(
                lambda t: t.state in ('in_progress', 'completed'),
            )
        return tasks

    def _cancel_pending_occurrence_tasks(self):
        pending = self._get_occurrence_tasks().filtered(lambda t: t.state == 'pending')
        if pending:
            pending.with_context(shahtaj_system_visit_write=True).write({
                'state': 'cancelled',
            })
            self.env['shahtaj.visit.task']._shahtaj_log_cancelled_tasks(
                'task.cancel_forward',
                'Cancel pending tasks (schedule occurrence)',
                pending,
            )

    def _cancel_pending_forward_tasks(self):
        """Cancel pending tasks from today forward for this weekday/route/schedule.

        Completed and in-progress visits are never cancelled. Used before a
        route/day/booker change so regeneration can create clean next-week tasks.
        """
        Task = self.env['shahtaj.visit.task']
        today = fields.Date.context_today(self)
        cancelled = Task.browse()
        for schedule in self:
            if not schedule.order_booker_id or not schedule.route_id:
                continue
            pending = Task.search([
                ('order_booker_id', '=', schedule.order_booker_id.id),
                ('state', '=', 'pending'),
                ('scheduled_date', '>=', today),
                '|',
                ('weekly_schedule_id', '=', schedule.id),
                ('route_id', '=', schedule.route_id.id),
            ])
            weekday = schedule.day_of_week
            to_cancel = pending.filtered(
                lambda t, sched_id=schedule.id, route_id=schedule.route_id.id, wd=weekday:
                    t.weekly_schedule_id.id == sched_id
                    or (
                        t.route_id.id == route_id
                        and t.scheduled_date
                        and str(t.scheduled_date.weekday()) == wd
                    )
            )
            if to_cancel:
                to_cancel.with_context(shahtaj_system_visit_write=True).write({
                    'state': 'cancelled',
                })
                cancelled |= to_cancel
        if cancelled:
            Task._shahtaj_log_cancelled_tasks(
                'task.cancel_forward',
                'Cancel pending tasks (schedule change)',
                cancelled,
            )
        return cancelled

    @api.depends('order_booker_id', 'route_id', 'day_of_week')
    def _compute_is_day_locked(self):
        for schedule in self:
            if not schedule.id or not schedule._is_today_occurrence():
                schedule.is_day_locked = False
                continue
            schedule.is_day_locked = bool(schedule._get_blocking_tasks())

    def _day_label(self, day_code):
        return dict(DAY_SELECTION).get(day_code, day_code)

    def _raise_blocking_tasks_error(self):
        self.ensure_one()
        day_name = self._day_label(self.day_of_week or self._today_weekday())
        raise ValidationError(_(
            'Cannot change today\'s %(day)s schedule — visits are already in '
            'progress or completed. Finish or skip those visits first. '
            'You can still change this weekday later for the next %(day)s.',
            day=day_name,
        ))

    def _check_blocking_tasks_for_write(self, vals):
        locked_fields = {'route_id', 'day_of_week', 'active', 'order_booker_id'}
        if not locked_fields.intersection(vals):
            return
        for schedule in self:
            # Past weekdays are editable so next-week planning stays available.
            if not schedule._is_today_occurrence():
                continue
            if schedule._get_blocking_tasks():
                schedule._raise_blocking_tasks_error()

    def _sync_future_tasks(self, bookers=None):
        """After schedule create/write/unlink, regenerate tasks for bookers."""
        today = fields.Date.context_today(self)
        end = fields.Date.add(today, days=13)
        Task = self.env['shahtaj.visit.task']
        bookers = bookers or self.mapped('order_booker_id')
        for booker in bookers:
            Task._generate_from_schedules(today, end, order_booker=booker)

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        records._sync_future_tasks()
        Log = self.env['shahtaj.activity.log']
        for schedule in records:
            Log.log_business(
                operation='schedule.create',
                name='Weekly schedule created',
                related_record=schedule,
                message=schedule.display_name,
            )
        return records

    def write(self, vals):
        self._check_blocking_tasks_for_write(vals)
        reschedule_fields = {'route_id', 'day_of_week', 'order_booker_id', 'active'}
        if reschedule_fields.intersection(vals):
            # Cancel pending from today forward (old route/weekday) before changing.
            self._cancel_pending_forward_tasks()
        res = super().write(vals)
        self._sync_future_tasks()
        if reschedule_fields.intersection(vals):
            Log = self.env['shahtaj.activity.log']
            for schedule in self:
                Log.log_business(
                    operation='schedule.update',
                    name='Weekly schedule updated',
                    related_record=schedule,
                    message=', '.join(sorted(reschedule_fields.intersection(vals))),
                )
        return res

    def unlink(self):
        bookers = self.mapped('order_booker_id')
        snapshot = [(s.id, s.display_name) for s in self]
        for schedule in self:
            if schedule._is_today_occurrence() and schedule._get_blocking_tasks():
                schedule._raise_blocking_tasks_error()
            schedule._cancel_pending_forward_tasks()
        res = super().unlink()
        self.env['shahtaj.weekly.schedule']._sync_future_tasks(bookers=bookers)
        Log = self.env['shahtaj.activity.log']
        for _sid, name in snapshot:
            Log.log_business(
                operation='schedule.delete',
                name='Weekly schedule deleted',
                message=name,
            )
        return res
