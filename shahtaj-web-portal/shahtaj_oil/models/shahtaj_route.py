# -*- coding: utf-8 -*-
"""Sales route inside a zone. Shops link via res.partner.route_id (one route per shop)."""
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class ShahtajRoute(models.Model):
    _name = 'shahtaj.route'
    _description = 'Sales Route'
    _inherit = ['shahtaj.territory.sync.mixin']
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

    def _shahtaj_is_operational_for_booker(self):
        self.ensure_one()
        zone = self.zone_id.with_context(active_test=False)
        return bool(self.active and zone and zone.active)

    def get_archive_impact(self):
        self.ensure_one()
        active_shops = self.shop_ids.filtered(
            lambda s: s.is_shahtaj_shop and s.active,
        )
        return {
            'active_shop_count': len(active_shops),
            'active_schedule_count': len(self.weekly_schedule_ids.filtered('active')),
        }

    def get_restore_impact(self):
        """Counts shown before restoring an archived route."""
        self.ensure_one()
        archived_shops = self.shop_ids.filtered(
            lambda s: s.is_shahtaj_shop
            and not s.active
            and s.shop_approval_state == 'approved',
        )
        inactive_schedules = self.weekly_schedule_ids.filtered(lambda s: not s.active)
        return {
            'archived_shop_count': len(archived_shops),
            'inactive_schedule_count': len(inactive_schedules),
        }

    def _sync_after_territory_restore(self):
        """Restore cascade-archived shops/schedules and regenerate visit tasks."""
        Task = self.env['shahtaj.visit.task']
        for route in self:
            archived_shops = route.shop_ids.filtered(
                lambda s: s.is_shahtaj_shop
                and not s.active
                and s.shop_approval_state == 'approved',
            )
            if archived_shops:
                archived_shops.with_context(
                    shahtaj_territory_cascade=True,
                ).write({'active': True})
            inactive_schedules = route.weekly_schedule_ids.filtered(
                lambda s: not s.active,
            )
            if inactive_schedules:
                inactive_schedules.write({'active': True})
            bookers = route.mapped('weekly_schedule_ids.order_booker_id')
            for booker in bookers:
                Task._auto_generate_window(order_booker=booker)

    def write(self, vals):
        restoring = vals.get('active') is True
        archiving = vals.get('active') is False
        if restoring:
            for route in self:
                zone = route.zone_id.with_context(active_test=False)
                if zone and not zone.active:
                    self._shahtaj_raise_restore_parent_error(
                        _('route'),
                        zone.display_name,
                    )
        res = super().write(vals)
        if archiving:
            today = fields.Date.context_today(self)
            for route in self:
                active_shops = route.shop_ids.filtered(
                    lambda s: s.is_shahtaj_shop and s.active,
                )
                if active_shops:
                    active_shops.with_context(
                        shahtaj_territory_cascade=True,
                    ).write({'active': False})
                active_schedules = route.weekly_schedule_ids.filtered('active')
                if active_schedules:
                    active_schedules.write({'active': False})
                self._shahtaj_cancel_pending_tasks_for_routes(
                    route.ids,
                    date_from=today,
                )
        elif restoring:
            self._sync_after_territory_restore()
        return res
