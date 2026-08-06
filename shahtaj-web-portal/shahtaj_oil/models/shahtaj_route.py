# -*- coding: utf-8 -*-
"""Sales route inside a zone.

Shops link via many2many ``shahtaj_shop_route_rel`` (one shop → many routes,
including cross-zone). ``assign_shop_ids`` checklist stays UI sugar synced to
that membership.
"""
from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError


class ShahtajRoute(models.Model):
    _name = 'shahtaj.route'
    _description = 'Sales Route'
    _inherit = ['shahtaj.territory.sync.mixin']
    _order = 'name'

    name = fields.Char(required=True)
    zone_id = fields.Many2one('shahtaj.zone', string='Zone', required=True, ondelete='restrict')
    # Source of truth for shop membership (multi-route, cross-zone allowed).
    shop_ids = fields.Many2many(
        'res.partner',
        'shahtaj_shop_route_rel',
        'route_id',
        'shop_id',
        string='Shops',
        domain=[('is_shahtaj_shop', '=', True)],
    )
    # UI checklist (real M2M so many2many_checkboxes works). Kept aligned with shop_ids.
    assign_shop_ids = fields.Many2many(
        'res.partner',
        'shahtaj_route_checklist_rel',
        'route_id',
        'shop_id',
        string='Shop assignment',
        help='Checked = assigned to this route. Unchecked = not on this route '
             '(shop may still belong to other routes).',
    )
    shop_count = fields.Integer(compute='_compute_shop_count')
    unassigned_shop_count = fields.Integer(
        compute='_compute_unassigned_shop_count',
        string='Unassigned shops',
    )
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

    def _compute_unassigned_shop_count(self):
        Partner = self.env['res.partner']
        count = Partner.search_count([
            ('is_shahtaj_shop', '=', True),
            ('active', '=', True),
            ('shop_approval_state', '=', 'approved'),
            ('route_ids', '=', False),
        ])
        for route in self:
            route.unassigned_shop_count = count

    def _shahtaj_candidate_shop_domain(self):
        """Any approved active shop may be linked (multi-route allowed)."""
        self.ensure_one()
        return [
            ('is_shahtaj_shop', '=', True),
            ('active', '=', True),
            ('shop_approval_state', '=', 'approved'),
        ]

    def _shahtaj_align_checklist_to_shops(self):
        """Make checklist checked set match shops linked on this route."""
        for route in self:
            wanted_ids = set(route.shop_ids.filtered(
                lambda s: s.active and s.shop_approval_state == 'approved',
            ).ids)
            current_ids = set(route.assign_shop_ids.ids)
            if wanted_ids != current_ids:
                route.with_context(shahtaj_skip_shop_sync=True).write({
                    'assign_shop_ids': [(6, 0, list(wanted_ids))],
                })

    def _shahtaj_sync_assigned_shops(self, wanted_shops):
        """Set this route's shop links to exactly wanted_shops (add/remove).

        Does not remove the shop from other routes.
        """
        self.ensure_one()
        if not self.active or not self.zone_id.active:
            raise UserError(_(
                'Route "%(route)s" (or its zone) is archived. '
                'Restore it before assigning shops.',
                route=self.display_name,
            ))
        wanted = wanted_shops.filtered(lambda s: s.is_shahtaj_shop and s.active)
        current = self.shop_ids
        to_add = wanted - current
        to_remove = current - wanted

        pending = to_add.filtered(lambda s: s.shop_approval_state != 'approved')
        if pending:
            raise UserError(_(
                'Approve these shops before assigning to a route: %(shops)s.',
                shops=', '.join(pending.mapped('display_name')),
            ))
        if to_remove:
            blocked = to_remove._shahtaj_shops_with_open_visit()
            if blocked:
                raise UserError(_(
                    'Cannot remove shop(s) with an in-progress visit: %(shops)s. '
                    'Finish or cancel the visit first.',
                    shops=', '.join(blocked.mapped('display_name')),
                ))
            for shop in to_remove:
                shop.with_context(shahtaj_checklist_sync=True).write({
                    'route_ids': [(3, self.id)],
                })
        if to_add:
            for shop in to_add:
                shop.with_context(shahtaj_checklist_sync=True).write({
                    'route_ids': [(4, self.id)],
                })
        return len(to_add), len(to_remove)

    def read(self, fields=None, load='_classic_read'):
        if self and (
            fields is None
            or 'assign_shop_ids' in fields
            or not fields
        ):
            self._shahtaj_align_checklist_to_shops()
        return super().read(fields=fields, load=load)

    def web_read(self, specification):
        if self and (
            not specification
            or 'assign_shop_ids' in specification
        ):
            self._shahtaj_align_checklist_to_shops()
        return super().web_read(specification)

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
        inactive_schedules = self.weekly_schedule_ids.filtered(lambda s: not s.active)
        return {
            # Shops are no longer cascade-archived with the route.
            'archived_shop_count': 0,
            'inactive_schedule_count': len(inactive_schedules),
        }

    def _sync_after_territory_restore(self):
        """Re-activate schedules and regenerate visit tasks for this route."""
        Task = self.env['shahtaj.visit.task']
        for route in self:
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
        if (
            'assign_shop_ids' in vals
            and not self.env.context.get('shahtaj_skip_shop_sync')
        ):
            for route in self:
                route._shahtaj_sync_assigned_shops(route.assign_shop_ids)
        if archiving:
            today = fields.Date.context_today(self)
            for route in self:
                # Keep shops active; only this route stops scheduling.
                active_schedules = route.weekly_schedule_ids.filtered('active')
                if active_schedules:
                    active_schedules.write({'active': False})
                self._shahtaj_cancel_pending_tasks_for_routes(
                    route.ids,
                    date_from=today,
                )
        elif restoring:
            self._sync_after_territory_restore()
        if {'name', 'active', 'zone_id'}.intersection(vals):
            Log = self.env['shahtaj.activity.log']
            for route in self:
                op = 'route.archive' if archiving else 'route.update'
                Log.log_business(
                    operation=op,
                    name='Route archived' if archiving else 'Route updated',
                    related_record=route,
                    message=route.display_name,
                )
        return res

    @api.model_create_multi
    def create(self, vals_list):
        routes = super().create(vals_list)
        Log = self.env['shahtaj.activity.log']
        for route in routes:
            Log.log_business(
                operation='route.create',
                name='Route created',
                related_record=route,
                message=route.display_name,
            )
            if route.assign_shop_ids and not self.env.context.get(
                'shahtaj_skip_shop_sync'
            ):
                route._shahtaj_sync_assigned_shops(route.assign_shop_ids)
        return routes

    def action_open_assign_shops_wizard(self):
        """Optional popup checklist (same behavior as on-form checklist)."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Pick shops for %s') % self.display_name,
            'res_model': 'shahtaj.assign.shops.route.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_route_id': self.id,
                'active_model': 'shahtaj.route',
                'active_id': self.id,
                'active_ids': self.ids,
                'shahtaj_route_checklist': True,
            },
        }
