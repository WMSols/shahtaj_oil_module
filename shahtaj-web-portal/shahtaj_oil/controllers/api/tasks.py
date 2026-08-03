# -*- coding: utf-8 -*-
"""Order booker API — visit tasks."""
from odoo import _, fields, http
from odoo.exceptions import UserError
from odoo.http import request

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.controllers.api.base import (
    API_ROUTE,
    api_activity,
    api_success,
    ensure_order_booker,
    task_for_booker,
)


class ShahtajApiTasks(http.Controller):

    @http.route('/api/shahtaj/v1/tasks/today', **API_ROUTE)
    def tasks_today(self, **kwargs):
        ensure_order_booker()
        Task = request.env['shahtaj.visit.task']
        # Sync rolling window + cancel orphan pending (routes not on plan).
        Task.sudo()._auto_generate_window(order_booker=request.env.user)
        today = fields.Date.context_today(Task)
        tasks = Task.search([
            ('order_booker_id', '=', request.env.user.id),
            ('scheduled_date', '=', today),
            ('state', 'not in', ['cancelled']),
        ], order='route_id, shop_id')
        tasks = tasks.filtered(lambda t: t._shahtaj_belongs_on_booker_day_list())
        return api_success({
            'date': str(today),
            'tasks': [serializers.task_dict(task) for task in tasks],
        })

    @http.route('/api/shahtaj/v1/tasks/check-in', **API_ROUTE)
    @api_activity('visit.check_in', 'Check in to shop')
    def check_in(self, task_id=None, latitude=None, longitude=None, **kwargs):
        task = task_for_booker(task_id)
        if task.visit_id and task.visit_id.state == 'in_progress':
            return api_success({
                'visit': serializers.visit_dict(task.visit_id),
                'resumed': True,
                'needs_shop_setup': False,
            })
        shop = task.shop_id.sudo()
        if not shop.shahtaj_field_verified:
            setup = shop._shahtaj_first_visit_setup_payload()
            return api_success({
                'needs_shop_setup': True,
                'field_verified': False,
                'visit_tag': setup['visit_tag'],
                'missing_fields': setup['missing_fields'],
                'shop': serializers.shop_brief(shop),
                'task': serializers.task_dict(task),
                'visit': None,
                'message': _(
                    'Shop has not been field-verified yet. '
                    'Capture shop exterior photo and GPS, then call '
                    '/api/shahtaj/v1/shops/verify-on-site.'
                ),
            })
        visit = request.env['shahtaj.visit'].create_from_task_checkin(
            task,
            float(latitude),
            float(longitude),
        )
        if not hasattr(visit, 'id'):
            raise UserError(_('Check-in failed. Finish your active visit first.'))
        return api_success({
            'visit': serializers.visit_dict(visit),
            'resumed': False,
            'needs_shop_setup': False,
        })

    @http.route('/api/shahtaj/v1/tasks/skip', **API_ROUTE)
    @api_activity('task.skip', 'Skip visit task')
    def skip_task(self, task_id=None, **kwargs):
        task = task_for_booker(task_id)
        task.action_skip()
        return api_success({'task': serializers.task_dict(task)})

    @http.route('/api/shahtaj/v1/tasks/notes', **API_ROUTE)
    def update_task_notes(self, task_id=None, notes=None, **kwargs):
        task = task_for_booker(task_id)
        task.write({'notes': notes or ''})
        return api_success({'task': serializers.task_dict(task)})
