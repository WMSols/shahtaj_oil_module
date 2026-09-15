# -*- coding: utf-8 -*-
"""Distributor day-wise visit progress by date range (from existing visit tasks)."""
from calendar import monthrange
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError

from .shahtaj_visit_task import shahtaj_week_bounds


class ShahtajVisitDayProgress(models.TransientModel):
    _name = 'shahtaj.visit.day.progress'
    _description = 'Visit Day Progress'

    staff_user_id = fields.Many2one(
        'res.users',
        string='Staff',
        required=True,
        ondelete='cascade',
    )
    staff_name = fields.Char(related='staff_user_id.name', readonly=True)
    is_order_booker = fields.Boolean(
        related='staff_user_id.shahtaj_is_order_booker',
        readonly=True,
    )
    is_delivery_man = fields.Boolean(
        related='staff_user_id.shahtaj_is_delivery_man',
        readonly=True,
    )
    date_from = fields.Date(string='From', required=True)
    date_to = fields.Date(string='To', required=True)
    line_ids = fields.One2many(
        'shahtaj.visit.day.progress.line',
        'progress_id',
        string='Days',
    )
    planned_total = fields.Integer(string='Planned', readonly=True)
    done_total = fields.Integer(string='Done', readonly=True)
    skipped_total = fields.Integer(string='Skipped', readonly=True)
    pending_total = fields.Integer(string='Pending', readonly=True)
    in_progress_total = fields.Integer(string='In Progress', readonly=True)
    progress_percent = fields.Float(string='Progress %', readonly=True)

    @api.model
    def _default_week_range(self):
        today = fields.Date.context_today(self)
        week_start, week_end = shahtaj_week_bounds(today)
        return week_start, min(week_end, today)

    @api.model
    def action_open_for_user(self, staff_user, date_from=None, date_to=None):
        """Open day progress for one order booker / delivery man."""
        staff_user.ensure_one()
        if not (staff_user.shahtaj_is_order_booker or staff_user.shahtaj_is_delivery_man):
            raise UserError(_('Select an order booker or delivery man.'))
        if not date_from or not date_to:
            date_from, date_to = self._default_week_range()
        record = self.create({
            'staff_user_id': staff_user.id,
            'date_from': date_from,
            'date_to': date_to,
        })
        record.action_refresh()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Day Progress — %s') % staff_user.name,
            'res_model': 'shahtaj.visit.day.progress',
            'res_id': record.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref('shahtaj_oil.view_shahtaj_visit_day_progress_form').id,
                'form',
            )],
        }

    def action_preset_this_week(self):
        self.ensure_one()
        date_from, date_to = self._default_week_range()
        self.write({'date_from': date_from, 'date_to': date_to})
        return self.action_refresh()

    def action_preset_this_month(self):
        self.ensure_one()
        today = fields.Date.context_today(self)
        date_from = today.replace(day=1)
        last_day = monthrange(today.year, today.month)[1]
        date_to = today.replace(day=last_day)
        self.write({'date_from': date_from, 'date_to': min(date_to, today)})
        return self.action_refresh()

    def action_preset_last_7_days(self):
        self.ensure_one()
        today = fields.Date.context_today(self)
        self.write({
            'date_from': today - timedelta(days=6),
            'date_to': today,
        })
        return self.action_refresh()

    def action_refresh(self):
        self.ensure_one()
        if self.date_from > self.date_to:
            raise UserError(_('From date must be on or before To date.'))
        self.line_ids.unlink()

        tasks = self._search_tasks()
        buckets = {}
        for task in tasks:
            day = task.scheduled_date
            bucket = buckets.setdefault(day, {
                'planned': 0,
                'done': 0,
                'skipped': 0,
                'pending': 0,
                'in_progress': 0,
            })
            bucket['planned'] += 1
            if task.state == 'completed':
                bucket['done'] += 1
            elif task.state == 'skipped':
                bucket['skipped'] += 1
            elif task.state == 'pending':
                bucket['pending'] += 1
            elif task.state == 'in_progress':
                bucket['in_progress'] += 1

        line_vals = []
        for day in sorted(buckets.keys(), reverse=True):
            bucket = buckets[day]
            planned = bucket['planned']
            done = bucket['done']
            progress = (done * 100.0 / planned) if planned else 0.0
            line_vals.append((0, 0, {
                'day_date': day,
                'weekday_label': day.strftime('%a'),
                'planned': planned,
                'done': done,
                'skipped': bucket['skipped'],
                'pending': bucket['pending'],
                'in_progress': bucket['in_progress'],
                'progress_percent': progress,
            }))

        planned_total = sum(b['planned'] for b in buckets.values())
        done_total = sum(b['done'] for b in buckets.values())
        self.write({
            'line_ids': line_vals,
            'planned_total': planned_total,
            'done_total': done_total,
            'skipped_total': sum(b['skipped'] for b in buckets.values()),
            'pending_total': sum(b['pending'] for b in buckets.values()),
            'in_progress_total': sum(b['in_progress'] for b in buckets.values()),
            'progress_percent': (done_total * 100.0 / planned_total) if planned_total else 0.0,
        })
        return {
            'type': 'ir.actions.act_window',
            'name': _('Day Progress — %s') % self.staff_user_id.name,
            'res_model': 'shahtaj.visit.day.progress',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref('shahtaj_oil.view_shahtaj_visit_day_progress_form').id,
                'form',
            )],
        }

    def _search_tasks(self):
        self.ensure_one()
        Task = self.env['shahtaj.visit.task']
        user = self.staff_user_id
        domain = [
            ('scheduled_date', '>=', self.date_from),
            ('scheduled_date', '<=', self.date_to),
            ('state', '!=', 'cancelled'),
        ]
        if user.shahtaj_is_order_booker:
            domain += [
                ('order_booker_id', '=', user.id),
                ('task_kind', '=', 'order_booker'),
            ]
        elif user.shahtaj_is_delivery_man:
            domain += [
                ('delivery_man_id', '=', user.id),
                ('task_kind', '=', 'delivery_man'),
            ]
        else:
            return Task.browse()
        return Task.search(domain, order='scheduled_date desc, route_id, shop_id')

    def action_open_all_tasks(self):
        self.ensure_one()
        return self._action_open_tasks(self.date_from, self.date_to)

    def _action_open_tasks(self, date_from, date_to):
        self.ensure_one()
        user = self.staff_user_id
        domain = [
            ('scheduled_date', '>=', date_from),
            ('scheduled_date', '<=', date_to),
            ('state', '!=', 'cancelled'),
        ]
        if user.shahtaj_is_order_booker:
            domain += [
                ('order_booker_id', '=', user.id),
                ('task_kind', '=', 'order_booker'),
            ]
        elif user.shahtaj_is_delivery_man:
            domain += [
                ('delivery_man_id', '=', user.id),
                ('task_kind', '=', 'delivery_man'),
            ]
        return {
            'type': 'ir.actions.act_window',
            'name': _('Visit Tasks (%s → %s)') % (date_from, date_to),
            'res_model': 'shahtaj.visit.task',
            'view_mode': 'list,form',
            'domain': domain,
            'target': 'current',
            'context': {'create': False},
        }

    def action_back_to_visit_hub(self):
        self.ensure_one()
        return self.staff_user_id.action_shahtaj_open_visit_hub()


class ShahtajVisitDayProgressLine(models.TransientModel):
    _name = 'shahtaj.visit.day.progress.line'
    _description = 'Visit Day Progress Line'
    _order = 'day_date desc'

    progress_id = fields.Many2one(
        'shahtaj.visit.day.progress',
        required=True,
        ondelete='cascade',
    )
    day_date = fields.Date(string='Date', required=True)
    weekday_label = fields.Char(string='Day')
    planned = fields.Integer(string='Planned')
    done = fields.Integer(string='Done')
    skipped = fields.Integer(string='Skipped')
    pending = fields.Integer(string='Pending')
    in_progress = fields.Integer(string='In Progress')
    progress_percent = fields.Float(string='Progress %')

    def action_open_day_tasks(self):
        self.ensure_one()
        return self.progress_id._action_open_tasks(self.day_date, self.day_date)
