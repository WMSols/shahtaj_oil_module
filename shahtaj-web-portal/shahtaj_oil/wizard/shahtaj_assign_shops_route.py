# -*- coding: utf-8 -*-
"""Distributor: assign existing shops to a route (or move between routes)."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError


class ShahtajAssignShopsRouteWizard(models.TransientModel):
    _name = 'shahtaj.assign.shops.route.wizard'
    _description = 'Assign Shops to Route'

    route_id = fields.Many2one(
        'shahtaj.route',
        string='Route',
        required=True,
        domain=[('active', '=', True)],
    )
    zone_id = fields.Many2one(
        related='route_id.zone_id',
        string='Zone',
        readonly=True,
    )
    shop_ids = fields.Many2many(
        'res.partner',
        'shahtaj_assign_shops_route_rel',
        'wizard_id',
        'shop_id',
        string='Shops',
        required=True,
        domain=[
            ('is_shahtaj_shop', '=', True),
            ('active', '=', True),
        ],
    )
    only_unassigned = fields.Boolean(
        string='Show unassigned shops only',
        default=True,
        help='When enabled, the shop picker prefers shops with no route yet.',
    )

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        ctx = self.env.context
        active_model = ctx.get('active_model')
        active_ids = ctx.get('active_ids') or (
            [ctx['active_id']] if ctx.get('active_id') else []
        )
        if active_model == 'shahtaj.route' and active_ids:
            res.setdefault('route_id', active_ids[0])
        if active_model == 'res.partner' and active_ids:
            shops = self.env['res.partner'].browse(active_ids).filtered(
                lambda p: p.is_shahtaj_shop and p.active,
            )
            if shops:
                res.setdefault('shop_ids', [(6, 0, shops.ids)])
                res['only_unassigned'] = False
        return res

    @api.onchange('only_unassigned', 'route_id')
    def _onchange_only_unassigned(self):
        domain = [
            ('is_shahtaj_shop', '=', True),
            ('active', '=', True),
        ]
        if self.only_unassigned:
            domain.append(('route_id', '=', False))
        return {'domain': {'shop_ids': domain}}

    def action_assign(self):
        self.ensure_one()
        if not self.route_id:
            raise UserError(_('Select a route.'))
        if not self.shop_ids:
            raise UserError(_('Select at least one shop.'))
        if not self.route_id.active or not self.route_id.zone_id.active:
            raise UserError(_(
                'Route "%(route)s" (or its zone) is archived.',
                route=self.route_id.display_name,
            ))
        shops = self.shop_ids.filtered('is_shahtaj_shop')
        shops.write({
            'route_id': self.route_id.id,
            'zone_id': self.route_id.zone_id.id,
        })
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Shops assigned'),
                'message': _(
                    '%(count)s shop(s) assigned to %(route)s.',
                    count=len(shops),
                    route=self.route_id.display_name,
                ),
                'type': 'success',
                'sticky': False,
                'next': {'type': 'ir.actions.act_window_close'},
            },
        }
