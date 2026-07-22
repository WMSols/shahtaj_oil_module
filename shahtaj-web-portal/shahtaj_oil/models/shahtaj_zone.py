# -*- coding: utf-8 -*-
"""Sales zone — top level of territory (managed by distributor)."""
from odoo import api, fields, models
from odoo.exceptions import ValidationError


class ShahtajZone(models.Model):
    _name = 'shahtaj.zone'
    _description = 'Sales Zone'
    _inherit = ['shahtaj.territory.sync.mixin']
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

    def _shahtaj_is_operational_for_booker(self):
        self.ensure_one()
        return bool(self.active)

    def get_archive_impact(self):
        """Return counts shown in the distributor portal before archiving."""
        self.ensure_one()
        active_routes = self.route_ids.filtered('active')
        active_shops = active_routes.shop_ids.filtered(
            lambda s: s.is_shahtaj_shop and s.active,
        )
        active_schedules = self.env['shahtaj.weekly.schedule'].search_count([
            ('route_id', 'in', active_routes.ids),
            ('active', '=', True),
        ])
        return {
            'active_route_count': len(active_routes),
            'active_shop_count': len(active_shops),
            'active_schedule_count': active_schedules,
        }

    def write(self, vals):
        if vals.get('active') is False:
            today = fields.Date.context_today(self)
            for zone in self:
                active_routes = zone.route_ids.filtered('active')
                if active_routes:
                    active_routes.with_context(
                        shahtaj_territory_cascade=True,
                    ).write({'active': False})
                self._shahtaj_cancel_pending_tasks_for_zones(
                    zone.ids,
                    date_from=today,
                )
        res = super().write(vals)
        return res
