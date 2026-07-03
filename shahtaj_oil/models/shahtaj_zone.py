# -*- coding: utf-8 -*-
"""Sales zone — top level of territory (managed by distributor)."""
from odoo import api, fields, models
from odoo.exceptions import ValidationError


class ShahtajZone(models.Model):
    _name = 'shahtaj.zone'
    _description = 'Sales Zone'
    _order = 'name'

    name = fields.Char(required=True)
    distributor_id = fields.Many2one(
        'res.users',
        string='Distributor',
        default=lambda self: self.env.user,
        required=True,
    )
    active = fields.Boolean(default=True)
    route_ids = fields.One2many('shahtaj.route', 'zone_id', string='Routes')
    route_count = fields.Integer(compute='_compute_route_count')

    def _compute_route_count(self):
        for zone in self:
            zone.route_count = len(zone.route_ids)

    @api.constrains('name')
    def _check_name(self):
        for zone in self:
            if not zone.name or not zone.name.strip():
                raise ValidationError('Zone name is required.')
