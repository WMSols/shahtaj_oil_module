# -*- coding: utf-8 -*-
"""Distributor: checkbox picker to set which shops belong on a route."""
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
    # Real M2M table — many2many_checkboxes works reliably here.
    shop_ids = fields.Many2many(
        'res.partner',
        'shahtaj_assign_shops_route_rel',
        'wizard_id',
        'shop_id',
        string='Shops on this route',
        help='Checked shops stay/get assigned. Uncheck to remove from the route.',
    )
    candidate_shop_ids = fields.Many2many(
        'res.partner',
        compute='_compute_candidate_shop_ids',
        string='Candidates',
    )

    @api.depends('route_id')
    def _compute_candidate_shop_ids(self):
        Partner = self.env['res.partner']
        for wiz in self:
            if not wiz.route_id:
                wiz.candidate_shop_ids = Partner
                continue
            wiz.candidate_shop_ids = Partner.search(
                wiz.route_id._shahtaj_candidate_shop_domain(),
            )

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        ctx = self.env.context
        route = False
        if ctx.get('default_route_id'):
            route = self.env['shahtaj.route'].browse(ctx['default_route_id'])
        elif ctx.get('active_model') == 'shahtaj.route' and ctx.get('active_id'):
            route = self.env['shahtaj.route'].browse(ctx['active_id'])
            res.setdefault('route_id', route.id)
        if route and route.exists():
            # Pre-check shops already on the route.
            res['shop_ids'] = [(6, 0, route.shop_ids.filtered(
                lambda s: s.active and s.shop_approval_state == 'approved'
            ).ids)]
        elif ctx.get('active_model') == 'res.partner' and ctx.get('active_ids'):
            shops = self.env['res.partner'].browse(ctx['active_ids']).filtered(
                lambda p: p.is_shahtaj_shop and p.active,
            )
            if shops:
                res.setdefault('shop_ids', [(6, 0, shops.ids)])
        return res

    @api.onchange('route_id')
    def _onchange_route_id(self):
        if not self.route_id:
            return {'domain': {'shop_ids': [('id', '=', False)]}}
        # Keep current selection if still valid; otherwise load route shops.
        domain = self.route_id._shahtaj_candidate_shop_domain()
        if not self.shop_ids:
            self.shop_ids = self.route_id.shop_ids.filtered(
                lambda s: s.active and s.shop_approval_state == 'approved',
            )
        return {'domain': {'shop_ids': domain}}

    def action_assign(self):
        """Apply checkbox selection as the full shop set for the route."""
        self.ensure_one()
        if not self.route_id:
            raise UserError(_('Select a route.'))
        added, removed = self.route_id._shahtaj_sync_assigned_shops(self.shop_ids)
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Route shops updated'),
                'message': _(
                    '%(route)s: %(added)s added, %(removed)s removed. '
                    'Now %(total)s shop(s) on this route.',
                    route=self.route_id.display_name,
                    added=added,
                    removed=removed,
                    total=len(self.route_id.shop_ids),
                ),
                'type': 'success',
                'sticky': False,
                'next': {'type': 'ir.actions.act_window_close'},
            },
        }
