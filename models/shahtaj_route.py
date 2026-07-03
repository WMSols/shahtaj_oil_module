# -*- coding: utf-8 -*-
"""Sales route inside a zone. Shops link via res.partner.route_id (one route per shop)."""
from odoo import api, fields, models
from odoo.exceptions import ValidationError


class ShahtajRoute(models.Model):
    _name = 'shahtaj.route'
    _description = 'Sales Route'
    _order = 'name'

    name = fields.Char(required=True)
    zone_id = fields.Many2one('shahtaj.zone', string='Zone', required=True, ondelete='restrict')
    # Shops on this route (inverse of res.partner.route_id).
    shop_ids = fields.One2many(
        'res.partner',
        'route_id',
        string='Shops',
        domain=[('is_shahtaj_shop', '=', True)],
    )
    shop_count = fields.Integer(compute='_compute_shop_count')
    active = fields.Boolean(default=True)
    weekly_schedule_ids = fields.One2many(
        'shahtaj.weekly.schedule',
        'route_id',
        string='Weekly Schedules',
    )

    def _compute_shop_count(self):
        for route in self:
            route.shop_count = len(route.shop_ids.filtered(
                lambda s: s.shop_approval_state == 'approved'
            ))

    @api.constrains('name', 'zone_id')
    def _check_required_fields(self):
        for route in self:
            if not route.name or not route.name.strip():
                raise ValidationError('Route name is required.')
            if not route.zone_id:
                raise ValidationError('Zone is required for every route.')
