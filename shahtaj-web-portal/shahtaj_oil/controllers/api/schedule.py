# -*- coding: utf-8 -*-
"""Order booker API — weekly schedule."""
from odoo import http
from odoo.http import request

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.controllers.api.base import API_ROUTE, api_success, ensure_order_booker


class ShahtajApiSchedule(http.Controller):

    @http.route('/api/shahtaj/v1/schedule/weekly', **API_ROUTE)
    def weekly_schedule(self, **kwargs):
        ensure_order_booker()
        schedules = request.env['shahtaj.weekly.schedule'].search([
            ('order_booker_id', '=', request.env.user.id),
            ('active', '=', True),
        ], order='day_of_week, route_id')
        schedules = schedules.filtered(
            lambda s: s.route_id._shahtaj_is_operational_for_booker(),
        )
        return api_success({
            'schedules': [serializers.schedule_dict(schedule) for schedule in schedules],
        })
