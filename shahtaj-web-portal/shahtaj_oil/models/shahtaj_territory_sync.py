# -*- coding: utf-8 -*-
"""Shared territory archive / operational helpers for zones, routes, and shops."""
from odoo import _, api, models
from odoo.exceptions import UserError


class ShahtajTerritorySyncMixin(models.AbstractModel):
    _name = 'shahtaj.territory.sync.mixin'
    _description = 'Shahtaj Territory Sync Helpers'

    @api.model
    def _shahtaj_cancel_pending_tasks_for_shops(self, shop_ids, date_from=None):
        if not shop_ids:
            return
        Task = self.env['shahtaj.visit.task']
        domain = [
            ('shop_id', 'in', list(shop_ids)),
            ('state', '=', 'pending'),
        ]
        if date_from:
            domain.append(('scheduled_date', '>=', date_from))
        pending = Task.search(domain)
        if pending:
            pending.with_context(shahtaj_system_visit_write=True).write({
                'state': 'cancelled',
            })

    @api.model
    def _shahtaj_cancel_pending_tasks_for_routes(self, route_ids, date_from=None):
        if not route_ids:
            return
        Route = self.env['shahtaj.route'].with_context(active_test=False)
        shop_ids = Route.browse(route_ids).mapped('shop_ids').ids
        self._shahtaj_cancel_pending_tasks_for_shops(shop_ids, date_from=date_from)

    @api.model
    def _shahtaj_cancel_pending_tasks_for_zones(self, zone_ids, date_from=None):
        if not zone_ids:
            return
        Zone = self.env['shahtaj.zone'].with_context(active_test=False)
        route_ids = Zone.browse(zone_ids).mapped('route_ids').ids
        self._shahtaj_cancel_pending_tasks_for_routes(route_ids, date_from=date_from)

    @api.model
    def _shahtaj_raise_restore_parent_error(self, label, parent_name):
        raise UserError(_(
            'Restore %(parent)s before restoring this %(label)s.',
            parent=parent_name,
            label=label,
        ))
