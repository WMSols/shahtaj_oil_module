# -*- coding: utf-8 -*-
"""Order booker API — shop visits and cart lines."""
from datetime import datetime, time

from odoo import _, fields, http
from odoo.exceptions import UserError
from odoo.http import request

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.controllers.api.base import (
    API_ROUTE,
    api_success,
    ensure_order_booker,
    visit_for_booker,
)


class ShahtajApiVisits(http.Controller):

    def _parse_visit_history_date(self, value, end_of_day=False):
        """Parse YYYY-MM-DD for visits/mine date filters."""
        if not value:
            return None
        try:
            day = fields.Date.to_date(value)
        except (TypeError, ValueError):
            raise UserError(_('Dates must use YYYY-MM-DD format.'))
        if end_of_day:
            return datetime.combine(day, time.max)
        return datetime.combine(day, time.min)

    @http.route('/api/shahtaj/v1/visits/mine', **API_ROUTE)
    def my_visits(self, limit=50, offset=0, date_from=None, date_to=None, **kwargs):
        ensure_order_booker()
        limit = min(int(limit or 50), 100)
        offset = max(int(offset or 0), 0)
        domain = [('order_booker_id', '=', request.env.user.id)]
        start_dt = self._parse_visit_history_date(date_from)
        end_dt = self._parse_visit_history_date(date_to, end_of_day=True)
        if start_dt:
            domain.append(('started_at', '>=', start_dt))
        if end_dt:
            domain.append(('started_at', '<=', end_dt))
        Visit = request.env['shahtaj.visit']
        visits = Visit.search(domain, order='started_at desc', limit=limit, offset=offset)
        return api_success({
            'total': Visit.search_count(domain),
            'offset': offset,
            'limit': limit,
            'visits': [
                serializers.visit_dict(visit, include_lines=False)
                for visit in visits
            ],
        })

    @http.route('/api/shahtaj/v1/visits/active', **API_ROUTE)
    def active_visit(self, **kwargs):
        ensure_order_booker()
        visit = request.env['shahtaj.visit']._get_active_visit_for_user()
        if not visit:
            return api_success({'visit': None})
        return api_success({'visit': serializers.visit_dict(visit)})

    @http.route('/api/shahtaj/v1/visits/get', **API_ROUTE)
    def get_visit(self, visit_id=None, **kwargs):
        visit = visit_for_booker(visit_id)
        return api_success({'visit': serializers.visit_dict(visit)})

    @http.route('/api/shahtaj/v1/visits/line/add', **API_ROUTE)
    def add_line(self, visit_id=None, product_id=None, quantity=1.0, **kwargs):
        visit = visit_for_booker(visit_id)
        if visit.state != 'in_progress':
            raise UserError(_('This visit is not in progress.'))
        product = request.env['product.product'].browse(int(product_id))
        if (
            not product.exists()
            or not product.active
            or not product.product_tmpl_id.active
            or not product.sale_ok
        ):
            raise UserError(_('Product not found, archived, or not for sale.'))
        qty = float(quantity)
        if qty <= 0:
            raise UserError(_('Quantity must be greater than zero.'))
        line = request.env['shahtaj.visit.line'].create({
            'visit_id': visit.id,
            'product_id': product.id,
            'product_uom_qty': qty,
            'price_unit': product.lst_price,
        })
        return api_success({
            'visit': serializers.visit_dict(visit),
            'line': serializers.visit_line_dict(line),
        })

    @http.route('/api/shahtaj/v1/visits/line/update', **API_ROUTE)
    def update_line(self, line_id=None, quantity=None, price_unit=None, **kwargs):
        ensure_order_booker()
        line = request.env['shahtaj.visit.line'].browse(int(line_id))
        if not line.exists():
            raise UserError(_('Line not found.'))
        visit_for_booker(line.visit_id.id)
        if line.visit_id.state != 'in_progress':
            raise UserError(_('This visit is not in progress.'))
        vals = {}
        if quantity is not None:
            qty = float(quantity)
            if qty <= 0:
                raise UserError(_('Quantity must be greater than zero.'))
            vals['product_uom_qty'] = qty
        if price_unit is not None:
            vals['price_unit'] = float(price_unit)
        if vals:
            line.write(vals)
        return api_success({
            'visit': serializers.visit_dict(line.visit_id),
            'line': serializers.visit_line_dict(line),
        })

    @http.route('/api/shahtaj/v1/visits/line/remove', **API_ROUTE)
    def remove_line(self, line_id=None, **kwargs):
        ensure_order_booker()
        line = request.env['shahtaj.visit.line'].browse(int(line_id))
        if not line.exists():
            raise UserError(_('Line not found.'))
        visit = visit_for_booker(line.visit_id.id)
        if visit.state != 'in_progress':
            raise UserError(_('This visit is not in progress.'))
        line.unlink()
        return api_success({'visit': serializers.visit_dict(visit)})

    @http.route('/api/shahtaj/v1/visits/place-order', **API_ROUTE)
    def place_order(self, visit_id=None, **kwargs):
        visit = visit_for_booker(visit_id)
        visit.action_place_order()
        return api_success({'visit': serializers.visit_dict(visit)})

    @http.route('/api/shahtaj/v1/visits/end-without-order', **API_ROUTE)
    def end_without_order(self, visit_id=None, notes=None, **kwargs):
        visit = visit_for_booker(visit_id)
        if visit.state != 'in_progress':
            raise UserError(_('This visit is not in progress.'))
        reason = (notes or '').strip()
        if not reason:
            raise UserError(_(
                'Please provide a reason (notes) before ending without an order.'
            ))
        visit.write({'notes': reason})
        visit.action_end_without_order()
        return api_success({'visit': serializers.visit_dict(visit)})

    @http.route('/api/shahtaj/v1/visits/notes', **API_ROUTE)
    def update_notes(self, visit_id=None, notes=None, **kwargs):
        visit = visit_for_booker(visit_id)
        if visit.state == 'in_progress':
            visit.write({'notes': notes or ''})
        return api_success({'visit': serializers.visit_dict(visit)})
