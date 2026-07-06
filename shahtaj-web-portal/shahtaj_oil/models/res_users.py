# -*- coding: utf-8 -*-
"""Extend users with booker profile, online status, and dashboard stats.

Distributor hubs read these computed fields for tasks, schedules, and targets.
"""
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from .shahtaj_visit_task import shahtaj_week_bounds

# Treat booker as online if seen within this many minutes.
ONLINE_THRESHOLD_MINUTES = 5


class ResUsers(models.Model):
    _inherit = 'res.users'

    shahtaj_employee_code = fields.Char(string='Booker Code')
    shahtaj_last_seen_at = fields.Datetime(string='Last Seen', readonly=True)
    shahtaj_is_order_booker = fields.Boolean(
        string='Is Order Booker',
        compute='_compute_shahtaj_is_order_booker',
        store=True,
        index=True,
    )
    shahtaj_online_status = fields.Selection(
        [
            ('online', 'Online'),
            ('away', 'Away'),
            ('offline', 'Offline'),
        ],
        string='Online Status',
        compute='_compute_shahtaj_online_status',
        store=True,
    )
    shahtaj_im_status = fields.Char(
        related='partner_id.im_status',
        string='Odoo Presence',
        readonly=True,
    )
    shahtaj_schedule_ids = fields.One2many(
        'shahtaj.weekly.schedule',
        'order_booker_id',
        string='Weekly Schedules',
    )
    shahtaj_visit_task_ids = fields.One2many(
        'shahtaj.visit.task',
        'order_booker_id',
        string='Visit Tasks',
    )
    shahtaj_task_today_ids = fields.One2many(
        'shahtaj.visit.task',
        compute='_compute_task_subsets',
        string='Tasks Today',
    )
    shahtaj_task_week_ids = fields.One2many(
        'shahtaj.visit.task',
        compute='_compute_task_subsets',
        string='Tasks This Week',
    )
    shahtaj_task_history_ids = fields.One2many(
        'shahtaj.visit.task',
        compute='_compute_task_subsets',
        string='Task History',
    )
    shahtaj_schedule_count = fields.Integer(compute='_compute_shahtaj_stats')
    shahtaj_target_ids = fields.One2many(
        'shahtaj.visit.target',
        'order_booker_id',
        string='Targets',
    )
    shahtaj_target_count = fields.Integer(compute='_compute_shahtaj_stats')
    shahtaj_task_today_total = fields.Integer(compute='_compute_shahtaj_stats')
    shahtaj_task_today_pending = fields.Integer(compute='_compute_shahtaj_stats')
    shahtaj_task_today_done = fields.Integer(compute='_compute_shahtaj_stats')
    shahtaj_week_task_total = fields.Integer(compute='_compute_shahtaj_stats')
    shahtaj_week_task_done = fields.Integer(compute='_compute_shahtaj_stats')
    shahtaj_week_task_progress = fields.Float(
        string='Week Progress %',
        compute='_compute_shahtaj_stats',
    )
    shahtaj_active_target_progress = fields.Float(
        string='Target Progress %',
        compute='_compute_shahtaj_stats',
    )
    shahtaj_active_target_summary = fields.Char(
        string='Active Target',
        compute='_compute_shahtaj_stats',
    )
    shahtaj_custom_frontend = fields.Boolean(
        string='Use Custom Distributor Portal',
        default=False,
        help=(
            'When enabled, this distributor logs into the Shahtaj OWL portal only '
            '(no standard Odoo apps or native Shahtaj menus). When disabled, only '
            'the standard Odoo / Shahtaj backend is available.'
        ),
    )
    shahtaj_is_distributor = fields.Boolean(
        string='Is Distributor',
        compute='_compute_shahtaj_is_distributor',
        store=True,
        index=True,
    )

    # Same pattern as sale_stock.property_warehouse_id: res.users form fields must be
    # listed here or the web client can receive arch without field metadata.
    @property
    def SELF_READABLE_FIELDS(self):
        return super().SELF_READABLE_FIELDS + [
            'shahtaj_custom_frontend',
            'shahtaj_is_distributor',
        ]

    @property
    def SELF_WRITEABLE_FIELDS(self):
        return super().SELF_WRITEABLE_FIELDS + [
            'shahtaj_custom_frontend',
        ]

    @api.depends('group_ids')
    def _compute_shahtaj_is_distributor(self):
        for user in self:
            user.shahtaj_is_distributor = user.has_group(
                'shahtaj_oil.group_shahtaj_distributor'
            )

    _SHAHTAJ_USER_FORM_FIELDS = ('shahtaj_custom_frontend', 'shahtaj_is_distributor')

    @api.model
    def get_views(self, views, options=None):
        """Ensure Shahtaj user-form fields are always in models.fields metadata."""
        result = super().get_views(views, options)
        if not any(view_type == 'form' for _view_id, view_type in views):
            return result
        field_defs = (
            result.setdefault('models', {})
            .setdefault('res.users', {})
            .setdefault('fields', {})
        )
        for fname in self._SHAHTAJ_USER_FORM_FIELDS:
            if fname in field_defs or fname not in self._fields:
                continue
            meta = self.fields_get([fname]).get(fname)
            if not meta:
                field = self._fields[fname]
                meta = {
                    'name': fname,
                    'type': field.type,
                    'string': field.string,
                    'help': field.help or '',
                    'readonly': bool(field.readonly),
                    'required': bool(field.required),
                    'searchable': True,
                    'sortable': bool(field.store),
                    'store': bool(field.store),
                    'groupable': bool(field.store),
                    'change_default': False,
                }
            field_defs[fname] = meta
        return result


    @api.constrains('shahtaj_custom_frontend', 'group_ids')
    def _check_shahtaj_custom_frontend_role(self):
        dist_group = self.env.ref(
            'shahtaj_oil.group_shahtaj_distributor',
            raise_if_not_found=False,
        )
        if not dist_group:
            return
        for user in self:
            if user.shahtaj_custom_frontend and dist_group not in user.group_ids:
                raise ValidationError(_(
                    'Custom Distributor Portal can only be enabled for users '
                    'with the Distributor role.'
                ))

    @api.model_create_multi
    def create(self, vals_list):
        users = super().create(vals_list)
        users._sync_shahtaj_ui_groups()
        return users

    def write(self, vals):
        if self.env.context.get('shahtaj_skip_ui_sync'):
            return super().write(vals)
        res = super().write(vals)
        if {'shahtaj_custom_frontend', 'group_ids'} & set(vals):
            self._sync_shahtaj_ui_groups()
        return res

    def _sync_shahtaj_ui_groups(self):
        """Assign technical UI groups from shahtaj_custom_frontend + distributor role."""
        custom_group = self.env.ref(
            'shahtaj_oil.group_shahtaj_custom_portal_user',
            raise_if_not_found=False,
        )
        native_ui_group = self.env.ref(
            'shahtaj_oil.group_shahtaj_native_distributor_ui',
            raise_if_not_found=False,
        )
        native_apps_group = self.env.ref(
            'shahtaj_oil.group_shahtaj_distributor_native_apps',
            raise_if_not_found=False,
        )
        dist_group = self.env.ref(
            'shahtaj_oil.group_shahtaj_distributor',
            raise_if_not_found=False,
        )
        if not all([custom_group, native_ui_group, native_apps_group, dist_group]):
            return

        for user in self.sudo():
            is_distributor = dist_group in user.group_ids
            commands = []
            if is_distributor and user.shahtaj_custom_frontend:
                commands = [
                    (4, custom_group.id),
                    (3, native_ui_group.id),
                    (3, native_apps_group.id),
                ]
            elif is_distributor:
                commands = [
                    (3, custom_group.id),
                    (4, native_ui_group.id),
                    (4, native_apps_group.id),
                ]
            else:
                if user.shahtaj_custom_frontend:
                    user.with_context(shahtaj_skip_ui_sync=True).write({
                        'shahtaj_custom_frontend': False,
                    })
                commands = [
                    (3, custom_group.id),
                    (3, native_ui_group.id),
                    (3, native_apps_group.id),
                ]

            group_ids = set(user.group_ids.ids)
            desired = set(group_ids)
            for cmd in commands:
                if cmd[0] == 4:
                    desired.add(cmd[1])
                elif cmd[0] == 3:
                    desired.discard(cmd[1])
            if desired != group_ids:
                user.with_context(shahtaj_skip_ui_sync=True).write({
                    'group_ids': [(6, 0, list(desired))],
                })

    @api.model
    def _sync_all_shahtaj_ui_groups(self):
        users = self.search([
            '|',
            ('shahtaj_is_distributor', '=', True),
            ('shahtaj_custom_frontend', '=', True),
        ])
        users._sync_shahtaj_ui_groups()

    @api.depends('group_ids')
    def _compute_shahtaj_is_order_booker(self):
        """Stored flag used in domains and distributor booker management."""
        for user in self:
            user.shahtaj_is_order_booker = user.has_group(
                'shahtaj_oil.group_shahtaj_order_booker'
            )

    @api.depends('shahtaj_last_seen_at', 'partner_id.im_status', 'shahtaj_is_order_booker')
    def _compute_shahtaj_online_status(self):
        now = fields.Datetime.now()
        threshold = now - timedelta(minutes=ONLINE_THRESHOLD_MINUTES)
        for user in self:
            if not user.shahtaj_is_order_booker:
                user.shahtaj_online_status = False
                continue
            im = user.partner_id.im_status
            if im == 'online':
                user.shahtaj_online_status = 'online'
            elif im == 'away':
                user.shahtaj_online_status = 'away'
            elif user.shahtaj_last_seen_at and user.shahtaj_last_seen_at >= threshold:
                user.shahtaj_online_status = 'online'
            else:
                user.shahtaj_online_status = 'offline'

    def _compute_task_subsets(self):
        """Split visit tasks into today / this week / older for booker hub views."""
        Task = self.env['shahtaj.visit.task']
        today = fields.Date.context_today(self)
        week_start, week_end = shahtaj_week_bounds(today)
        empty = Task.browse()
        for user in self:
            if not user.shahtaj_is_order_booker:
                user.shahtaj_task_today_ids = empty
                user.shahtaj_task_week_ids = empty
                user.shahtaj_task_history_ids = empty
                continue
            tasks = Task.search([
                ('order_booker_id', '=', user.id),
                ('state', '!=', 'cancelled'),
            ], order='scheduled_date desc, route_id, shop_id')
            user.shahtaj_task_today_ids = tasks.filtered(
                lambda t: t.scheduled_date == today
            )
            user.shahtaj_task_week_ids = tasks.filtered(
                lambda t: week_start <= t.scheduled_date <= week_end
            )
            user.shahtaj_task_history_ids = tasks.filtered(
                lambda t: t.scheduled_date < week_start
            )

    @api.depends(
        'shahtaj_is_order_booker',
        'shahtaj_schedule_ids',
        'shahtaj_target_ids',
        'shahtaj_target_ids.progress_percent',
        'shahtaj_last_seen_at',
        'partner_id.im_status',
    )
    def _compute_shahtaj_stats(self):
        """Counts for distributor order booker form and visit hub."""
        Task = self.env['shahtaj.visit.task']
        today = fields.Date.context_today(self)
        week_start, week_end = shahtaj_week_bounds(today)
        for user in self.filtered('shahtaj_is_order_booker'):
            user.shahtaj_schedule_count = len(user.shahtaj_schedule_ids.filtered('active'))
            active_targets = user.shahtaj_target_ids.filtered(
                lambda t: t.active
                and t.date_start <= today <= t.date_end
            )
            user.shahtaj_target_count = len(user.shahtaj_target_ids)
            if active_targets:
                best = active_targets.sorted('progress_percent', reverse=True)[0]
                user.shahtaj_active_target_progress = best.progress_percent
                user.shahtaj_active_target_summary = (
                    f'{best.target_type}: {best.achieved_value:.0f} / {best.target_value:.0f}'
                )
            else:
                user.shahtaj_active_target_progress = 0.0
                user.shahtaj_active_target_summary = 'No active target'

            today_tasks = Task.search([
                ('order_booker_id', '=', user.id),
                ('scheduled_date', '=', today),
                ('state', '!=', 'cancelled'),
            ])
            user.shahtaj_task_today_total = len(today_tasks)
            user.shahtaj_task_today_pending = len(
                today_tasks.filtered(lambda t: t.state in ('pending', 'in_progress'))
            )
            user.shahtaj_task_today_done = len(
                today_tasks.filtered(lambda t: t.state == 'completed')
            )

            week_tasks = Task.search([
                ('order_booker_id', '=', user.id),
                ('scheduled_date', '>=', week_start),
                ('scheduled_date', '<=', week_end),
                ('state', '!=', 'cancelled'),
            ])
            user.shahtaj_week_task_total = len(week_tasks)
            user.shahtaj_week_task_done = len(
                week_tasks.filtered(lambda t: t.state == 'completed')
            )
            user.shahtaj_week_task_progress = (
                user.shahtaj_week_task_done / user.shahtaj_week_task_total * 100.0
                if user.shahtaj_week_task_total else 0.0
            )
        for user in self - self.filtered('shahtaj_is_order_booker'):
            user.shahtaj_schedule_count = 0
            user.shahtaj_target_count = 0
            user.shahtaj_task_today_total = 0
            user.shahtaj_task_today_pending = 0
            user.shahtaj_task_today_done = 0
            user.shahtaj_week_task_total = 0
            user.shahtaj_week_task_done = 0
            user.shahtaj_week_task_progress = 0.0
            user.shahtaj_active_target_progress = 0.0
            user.shahtaj_active_target_summary = ''

    def action_shahtaj_deactivate_booker(self):
        self.ensure_one()
        self.sudo().write({'active': False})

    def action_shahtaj_activate_booker(self):
        self.ensure_one()
        self.sudo().write({'active': True})

    def action_shahtaj_view_tasks_today(self):
        self.ensure_one()
        today = fields.Date.context_today(self)
        return {
            'type': 'ir.actions.act_window',
            'name': 'Tasks Today',
            'res_model': 'shahtaj.visit.task',
            'view_mode': 'list,form',
            'domain': [
                ('order_booker_id', '=', self.id),
                ('scheduled_date', '=', today),
            ],
        }

    def action_shahtaj_view_schedules(self):
        return self.action_shahtaj_manage_schedules()

    def action_shahtaj_manage_schedules(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Weekly Routes — %s', self.name),
            'res_model': 'shahtaj.weekly.schedule',
            'view_mode': 'list,form',
            'domain': [('order_booker_id', '=', self.id)],
            'context': {
                'default_order_booker_id': self.id,
                'shahtaj_schedule_planner': True,
            },
            'views': [
                (
                    self.env.ref(
                        'shahtaj_oil.view_shahtaj_weekly_schedule_list_planner'
                    ).id,
                    'list',
                ),
                (
                    self.env.ref(
                        'shahtaj_oil.view_shahtaj_weekly_schedule_form_planner'
                    ).id,
                    'form',
                ),
            ],
            'target': 'current',
        }

    def action_shahtaj_view_targets(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Targets',
            'res_model': 'shahtaj.visit.target',
            'view_mode': 'list,form',
            'domain': [('order_booker_id', '=', self.id)],
        }

    def action_shahtaj_open_schedule_hub(self):
        return self.action_shahtaj_manage_schedules()

    def action_shahtaj_open_visit_hub(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Visit Tasks',
            'res_model': 'res.users',
            'view_mode': 'form',
            'res_id': self.id,
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_visit_hub_form').id, 'form'),
            ],
            'target': 'current',
        }
