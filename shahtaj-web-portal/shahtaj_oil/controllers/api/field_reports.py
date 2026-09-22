# -*- coding: utf-8 -*-
"""Field / app report APIs for Order Booker and Delivery Man.

Isolated endpoints — do not alter visit, delivery, recovery, or wallet flows.
"""
from odoo import _, http
from odoo.exceptions import UserError
from odoo.http import request

from odoo.addons.shahtaj_oil.controllers.api.base import (
    API_ROUTE,
    api_success,
    ensure_order_booker,
)
from odoo.addons.shahtaj_oil.controllers.api.dm_base import (
    DM_API_ROUTE,
    ensure_delivery_man,
)


def _reports():
    return request.env['shahtaj.field.report']


def _create_kwargs(kwargs):
    return {
        'subject': kwargs.get('subject'),
        'description': kwargs.get('description'),
        'tag_ids': kwargs.get('tag_ids'),
        'tag_codes': kwargs.get('tag_codes'),
        'screenshot': kwargs.get('screenshot'),
        'latitude': kwargs.get('latitude'),
        'longitude': kwargs.get('longitude'),
        'device_info': kwargs.get('device_info') or '',
    }


class ShahtajApiFieldReports(http.Controller):
    """Order Booker report endpoints."""

    @http.route('/api/shahtaj/v1/reports/tags', **API_ROUTE)
    def report_tags(self, **kwargs):
        ensure_order_booker()
        return api_success(_reports().shahtaj_api_list_tags())

    @http.route('/api/shahtaj/v1/reports/create', **API_ROUTE)
    def report_create(self, **kwargs):
        ensure_order_booker()
        return api_success(_reports().shahtaj_api_create_report(**_create_kwargs(kwargs)))

    @http.route('/api/shahtaj/v1/reports/list', **API_ROUTE)
    def report_list(self, state=None, limit=50, offset=0, **kwargs):
        ensure_order_booker()
        return api_success(_reports().shahtaj_api_list_my_reports(
            state=state, limit=limit, offset=offset,
        ))

    @http.route('/api/shahtaj/v1/reports/get', **API_ROUTE)
    def report_get(self, report_id=None, include_screenshot=False, **kwargs):
        ensure_order_booker()
        if not report_id:
            raise UserError(_('report_id is required.'))
        return api_success(_reports().shahtaj_api_get_report(
            report_id, include_screenshot=include_screenshot,
        ))

    @http.route('/api/shahtaj/v1/reports/reply', **API_ROUTE)
    def report_reply(self, report_id=None, body='', screenshot=None, **kwargs):
        ensure_order_booker()
        if not report_id:
            raise UserError(_('report_id is required.'))
        report = _reports().browse(int(report_id))
        if not report.exists():
            raise UserError(_('Report not found.'))
        return api_success(report.shahtaj_api_reply(body=body, screenshot=screenshot))


class ShahtajDmApiFieldReports(http.Controller):
    """Delivery Man report endpoints (same payload shape as booker)."""

    @http.route('/api/shahtaj/v1/dm/reports/tags', **DM_API_ROUTE)
    def report_tags(self, **kwargs):
        ensure_delivery_man()
        return api_success(_reports().shahtaj_api_list_tags())

    @http.route('/api/shahtaj/v1/dm/reports/create', **DM_API_ROUTE)
    def report_create(self, **kwargs):
        ensure_delivery_man()
        return api_success(_reports().shahtaj_api_create_report(**_create_kwargs(kwargs)))

    @http.route('/api/shahtaj/v1/dm/reports/list', **DM_API_ROUTE)
    def report_list(self, state=None, limit=50, offset=0, **kwargs):
        ensure_delivery_man()
        return api_success(_reports().shahtaj_api_list_my_reports(
            state=state, limit=limit, offset=offset,
        ))

    @http.route('/api/shahtaj/v1/dm/reports/get', **DM_API_ROUTE)
    def report_get(self, report_id=None, include_screenshot=False, **kwargs):
        ensure_delivery_man()
        if not report_id:
            raise UserError(_('report_id is required.'))
        return api_success(_reports().shahtaj_api_get_report(
            report_id, include_screenshot=include_screenshot,
        ))

    @http.route('/api/shahtaj/v1/dm/reports/reply', **DM_API_ROUTE)
    def report_reply(self, report_id=None, body='', screenshot=None, **kwargs):
        ensure_delivery_man()
        if not report_id:
            raise UserError(_('report_id is required.'))
        report = _reports().browse(int(report_id))
        if not report.exists():
            raise UserError(_('Report not found.'))
        return api_success(report.shahtaj_api_reply(body=body, screenshot=screenshot))
