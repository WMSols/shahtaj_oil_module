# -*- coding: utf-8 -*-
"""Weekly plan: which order booker works which route on which weekday.

Changing schedules refreshes visit tasks for the next ~2 weeks.
Today's schedule lines are locked so visit stats are not broken mid-day.
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
        help='Schedule lines for today cannot be edited — protects visit statistics.',
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

    @api.depends('day_of_week')
    def _compute_is_day_locked(self):
        today_weekday = str(fields.Date.context_today(self).weekday())
        for schedule in self:
            schedule.is_day_locked = bool(
                schedule.id and schedule.day_of_week == today_weekday
            )

    def _today_weekday(self):
        return str(fields.Date.context_today(self).weekday())

    def _day_label(self, day_code):
        return dict(DAY_SELECTION).get(day_code, day_code)

    def _raise_day_locked_error(self):
        day_name = self._day_label(self._today_weekday())
        raise ValidationError(_(
            'Cannot change %(day)s schedules on %(day)s — '
            'today\'s visit statistics are already in progress. '
            'You can add new lines for other weekdays.',
            day=day_name,
        ))

    def _check_day_not_locked_for_write(self, vals):
        # Prevent changing today's route assignment after visits may have started.
        locked_fields = {'route_id', 'day_of_week', 'active', 'order_booker_id'}
        if not locked_fields.intersection(vals):
            return
        for schedule in self.filtered('is_day_locked'):
            schedule._raise_day_locked_error()

    def _sync_future_tasks(self):
        """After schedule create/write, regenerate tasks for this booker (today + 13 days)."""
        today = fields.Date.context_today(self)
        end = fields.Date.add(today, days=13)
        Task = self.env['shahtaj.visit.task']
        for booker in self.mapped('order_booker_id'):
            Task._generate_from_schedules(today, end, order_booker=booker)

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        records._sync_future_tasks()
        return records

    def write(self, vals):
        self._check_day_not_locked_for_write(vals)
        res = super().write(vals)
        self._sync_future_tasks()
        return res

    def unlink(self):
        locked = self.filtered('is_day_locked')
        if locked:
            locked[0]._raise_day_locked_error()
        return super().unlink()
