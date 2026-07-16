# -*- coding: utf-8 -*-
"""Order booker API — products."""
from odoo import http
from odoo.http import request

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.controllers.api.base import API_ROUTE, api_success, ensure_order_booker


class ShahtajApiProducts(http.Controller):

    @http.route('/api/shahtaj/v1/products/list', **API_ROUTE)
    def list_products(self, visit_id=None, limit=500, offset=0, **kwargs):
        """Return sellable products for the booker to pick during a visit."""
        ensure_order_booker()
        limit = min(int(limit or 500), 500)
        offset = max(int(offset or 0), 0)

        products = request.env['product.product'].search(
            [
                ('sale_ok', '=', True),
                ('default_code', '!=', 'SHAHTAJ-LEGACY'),
            ],
            limit=limit,
            offset=offset,
            order='name',
        )
        exclude_lines = []
        if visit_id:
            visit = request.env['shahtaj.visit'].browse(int(visit_id))
            if visit.exists() and visit.order_booker_id == request.env.user:
                exclude_lines = visit.line_ids.ids

        total = request.env['product.product'].search_count([
            ('sale_ok', '=', True),
            ('default_code', '!=', 'SHAHTAJ-LEGACY'),
        ])
        return api_success({
            'total': total,
            'offset': offset,
            'limit': limit,
            'products': [
                serializers.product_brief(
                    product,
                    visit_line_ids=exclude_lines,
                )
                for product in products
            ],
        })
