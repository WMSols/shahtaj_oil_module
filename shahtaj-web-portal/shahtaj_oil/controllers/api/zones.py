# -*- coding: utf-8 -*-
"""Order booker API — zone and route pickers for shop registration."""
from odoo import _, http
from odoo.exceptions import UserError
from odoo.http import request

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.controllers.api.base import API_ROUTE, api_success, ensure_order_booker


class ShahtajApiZones(http.Controller):

    @http.route('/api/shahtaj/v1/zones/list', **API_ROUTE)
    def list_zones(self, **kwargs):
        """Return active zones the booker may assign when registering a shop."""
        ensure_order_booker()
        zone_ids = request.env['res.partner']._get_allowed_zone_ids()
        zones = request.env['shahtaj.zone'].browse(zone_ids).filtered(
            'active',
        ).sorted('name')
        return api_success({
            'zones': [serializers.zone_brief(zone) for zone in zones],
        })

    @http.route('/api/shahtaj/v1/routes/list', **API_ROUTE)
    def list_routes(self, zone_id=None, **kwargs):
        """Return active routes, optionally filtered to one zone."""
        ensure_order_booker()
        zone_filter = int(zone_id) if zone_id else None
        if zone_filter:
            zone = request.env['shahtaj.zone'].browse(zone_filter)
            if not zone.exists() or not zone.active:
                raise UserError(_('Zone not found.'))
            allowed_zone_ids = request.env['res.partner']._get_allowed_zone_ids()
            if zone_filter not in allowed_zone_ids:
                raise UserError(_('Zone not found.'))
        route_ids = request.env['res.partner']._get_allowed_route_ids(
            zone_id=zone_filter,
        )
        routes = request.env['shahtaj.route'].browse(route_ids).filtered(
            'active',
        ).sorted('name')
        return api_success({
            'zone_id': zone_filter or False,
            'routes': [serializers.route_brief(route) for route in routes],
        })
