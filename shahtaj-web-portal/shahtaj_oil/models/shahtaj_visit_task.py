# -*- coding: utf-8 -*-
"""Daily visit tasks: one row per shop per booker per date.

Tasks are built from weekly schedules (cron, login, or manual wizard).
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


class ShahtajVisitTask(models.Model):
    _name = 'shahtaj.visit.task'
    _description = 'Visit Task'
    _order = 'scheduled_date desc, route_id, shop_id'

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

    _shop_date_booker_unique = models.Constraint(
        'unique(shop_id, scheduled_date, order_booker_id)',
        'A visit task for this shop, date, and order booker already exists.',
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
            if task.shop_id and task.shop_id.shop_approval_state != 'approved':
                raise ValidationError(_(
                    'Shop "%(shop)s" is not approved. '
                    'Only approved shops can be scheduled or visited.',
                    shop=task.shop_id.name,
                ))
            if task.shop_id and task.route_id:
                if task.shop_id.route_id != task.route_id:
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
            'name': _('Check in at Shop'),
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
        for task in self:
            if task.visit_id and task.visit_id.state == 'in_progress':
                raise ValidationError(_(
                    'End the active shop visit before skipping this task.'
                ))
        self.write({'state': 'skipped'})

    def action_cancel(self):
        self.write({'state': 'cancelled'})

    def action_reset_pending(self):
        self.write({'state': 'pending'})

    def _is_booker_only_user(self):
        user = self.env.user
        return (
            user.has_group('shahtaj_oil.group_shahtaj_order_booker')
            and not user.has_group('shahtaj_oil.group_shahtaj_distributor')
            and not user.has_group('base.group_system')
        )

    def write(self, vals):
        # Bookers cannot edit distributor-only fields on tasks.
        if self._is_booker_only_user() and not self.env.context.get('shahtaj_system_visit_write'):
            extra = set(vals) - BOOKER_WRITABLE_FIELDS
            if extra:
                raise ValidationError(_(
                    'You can only update visit status and notes on your tasks.'
                ))
        return super().write(vals)

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

    @api.model
    def _generate_from_schedules(self, date_from, date_to, order_booker=None):
        """For each day in range: match weekday schedules → one task per shop on route."""
        self._cancel_pending_tasks_for_unapproved_shops(date_from, date_to)

        Schedule = self.env['shahtaj.weekly.schedule']
        schedule_domain = [('active', '=', True)]
        if order_booker:
            schedule_domain.append(('order_booker_id', '=', order_booker.id))
        schedules = Schedule.search(schedule_domain)

        created = self.env['shahtaj.visit.task']
        skipped = 0
        day = date_from
        while day <= date_to:
            weekday = str(day.weekday())
            day_schedules = schedules.filtered(lambda s: s.day_of_week == weekday)
            for schedule in day_schedules:
                approved_shops = schedule.route_id.shop_ids.filtered(
                    lambda s: s.shop_approval_state == 'approved'
                )
                for shop in approved_shops:
                    existing = self.search([
                        ('shop_id', '=', shop.id),
                        ('scheduled_date', '=', day),
                        ('order_booker_id', '=', schedule.order_booker_id.id),
                    ], limit=1)
                    if existing:
                        if existing.state == 'cancelled':
                            existing.with_context(
                                shahtaj_system_visit_write=True,
                            ).write({'state': 'pending'})
                        else:
                            skipped += 1
                        continue
                    created |= self.create({
                        'order_booker_id': schedule.order_booker_id.id,
                        'route_id': schedule.route_id.id,
                        'shop_id': shop.id,
                        'scheduled_date': day,
                        'weekly_schedule_id': schedule.id,
                        'state': 'pending',
                    })
            day = fields.Date.add(day, days=1)

        return created, skipped

    @api.model
    def _cron_auto_generate_visit_tasks(self):
        """Called daily by scheduled action for all bookers."""
        # Close abandoned visits first so leftover check-ins cannot block today.
        self.env['shahtaj.visit']._cron_close_stale_visits()
        self._auto_generate_window()

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
