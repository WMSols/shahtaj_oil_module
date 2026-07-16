# -*- coding: utf-8 -*-
"""Order booker API — visit tasks."""
from odoo import _, fields, http
from odoo.exceptions import UserError
from odoo.http import request

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.controllers.api.base import (
    API_ROUTE,
    api_success,
    ensure_order_booker,
    task_for_booker,
)


class ShahtajApiTasks(http.Controller):

    @http.route('/api/shahtaj/v1/tasks/today', **API_ROUTE)
    def tasks_today(self, **kwargs):
        ensure_order_booker()
        # Expire leftover visits from previous days before listing today's work.
        request.env['shahtaj.visit']._close_stale_in_progress_visits(
            order_booker=request.env.user,
        )
        today = fields.Date.context_today(request.env['shahtaj.visit.task'])
        tasks = request.env['shahtaj.visit.task'].search([
            ('order_booker_id', '=', request.env.user.id),
            ('scheduled_date', '=', today),
            ('state', 'not in', ['cancelled']),
        ], order='route_id, shop_id')
        return api_success({
            'date': str(today),
            'tasks': [serializers.task_dict(task) for task in tasks],
        })

    @http.route('/api/shahtaj/v1/tasks/check-in', **API_ROUTE)
    def check_in(self, task_id=None, latitude=None, longitude=None, **kwargs):
        task = task_for_booker(task_id)
        if task.visit_id and task.visit_id.state == 'in_progress':
            return api_success({
                'visit': serializers.visit_dict(task.visit_id),
                'resumed': True,
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
        })

    @http.route('/api/shahtaj/v1/tasks/skip', **API_ROUTE)
    def skip_task(self, task_id=None, **kwargs):
        task = task_for_booker(task_id)
        task.action_skip()
        return api_success({'task': serializers.task_dict(task)})

    @http.route('/api/shahtaj/v1/tasks/notes', **API_ROUTE)
    def update_task_notes(self, task_id=None, notes=None, **kwargs):
        task = task_for_booker(task_id)
        task.write({'notes': notes or ''})
        return api_success({'task': serializers.task_dict(task)})
