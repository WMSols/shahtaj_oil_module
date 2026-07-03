# -*- coding: utf-8 -*-
"""Order booker API — targets."""
from odoo import http
from odoo.http import request

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.controllers.api.base import API_ROUTE, api_success, ensure_order_booker


class ShahtajApiTargets(http.Controller):

    @http.route('/api/shahtaj/v1/targets/mine', **API_ROUTE)
    def my_targets(self, **kwargs):
        ensure_order_booker()
        targets = request.env['shahtaj.visit.target'].search([
            ('order_booker_id', '=', request.env.user.id),
            ('active', '=', True),
        ], order='date_start desc')
        return api_success({
            'targets': [serializers.target_dict(target) for target in targets],
        })
