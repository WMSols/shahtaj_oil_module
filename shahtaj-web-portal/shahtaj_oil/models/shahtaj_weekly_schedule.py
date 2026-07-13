# -*- coding: utf-8 -*-
"""Weekly plan: which order booker works which route on which weekday.

Changing schedules refreshes visit tasks for the next ~2 weeks.
Today's schedule lines are locked only while visits are in progress or completed.
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
    is_day_locked = fields.Boolean(
        string='Locked (Today)',
        compute='_compute_is_day_locked',
        help='Locked when today\'s visits for this route are in progress or completed.',
    )

    _booker_route_day_unique = models.Constraint(
        'unique(order_booker_id, route_id, day_of_week)',
        'This order booker already has this route on the selected day.',
    )

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
        return self._get_occurrence_tasks().filtered(
            lambda t: t.state in ('in_progress', 'completed'),
        )

    def _cancel_pending_occurrence_tasks(self):
        pending = self._get_occurrence_tasks().filtered(lambda t: t.state == 'pending')
        if pending:
            pending.with_context(shahtaj_system_visit_write=True).write({
                'state': 'cancelled',
            })

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
        day_name = self._day_label(self._today_weekday())
        raise ValidationError(_(
            'Cannot change this %(day)s route — visits are already in progress '
            'or completed for today. Finish or skip those visits first.',
            day=day_name,
        ))

    def _check_blocking_tasks_for_write(self, vals):
        locked_fields = {'route_id', 'day_of_week', 'active', 'order_booker_id'}
        if not locked_fields.intersection(vals):
            return
        for schedule in self:
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
        return records

    def write(self, vals):
        self._check_blocking_tasks_for_write(vals)
        reschedule_fields = {'route_id', 'day_of_week', 'order_booker_id', 'active'}
        if reschedule_fields.intersection(vals):
            self._cancel_pending_occurrence_tasks()
        res = super().write(vals)
        self._sync_future_tasks()
        return res

    def unlink(self):
        bookers = self.mapped('order_booker_id')
        for schedule in self:
            if schedule._get_blocking_tasks():
                schedule._raise_blocking_tasks_error()
            schedule._cancel_pending_occurrence_tasks()
        res = super().unlink()
        self.env['shahtaj.weekly.schedule']._sync_future_tasks(bookers=bookers)
        return res
