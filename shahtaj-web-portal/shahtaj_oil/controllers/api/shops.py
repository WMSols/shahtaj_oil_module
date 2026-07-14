# -*- coding: utf-8 -*-
"""Order booker API — shop registration."""
from odoo import _, http
from odoo.exceptions import AccessError, UserError
from odoo.http import request

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.api.image_utils import shop_photo_vals_from_kwargs
from odoo.addons.shahtaj_oil.controllers.api.base import API_ROUTE, api_success, ensure_order_booker


class ShahtajApiShops(http.Controller):

    def _shop_for_booker(self, shop_id):
        ensure_order_booker()
        partner = request.env['res.partner'].browse(int(shop_id))
        if not partner.exists() or not partner.is_shahtaj_shop:
            raise AccessError(_('Shop not found.'))
        if partner.registered_by_id != request.env.user:
            raise AccessError(_('You can only access shops you registered.'))
        return partner

    @http.route('/api/shahtaj/v1/shops/register', **API_ROUTE)
    def register_shop(self, **kwargs):
        ensure_order_booker()
        name = kwargs.get('name')
        owner_name = kwargs.get('owner_name')
        owner_phone = kwargs.get('owner_phone')
        latitude = kwargs.get('latitude')
        longitude = kwargs.get('longitude')
        if not all([name, owner_name, owner_phone, latitude, longitude]):
            raise UserError(_(
                'name, owner_name, owner_phone, latitude, and longitude are required.'
            ))
        # Explicit shop flags so create() always marks this as a pending Shahtaj shop
        # (visible in shops/mine and distributor pending-approval screens).
        vals = {
            'name': name,
            'owner_name': owner_name,
            'owner_phone': owner_phone,
            'owner_cnic_number': kwargs.get('owner_cnic_number') or False,
            'partner_latitude': float(latitude),
            'partner_longitude': float(longitude),
            'is_shahtaj_shop': True,
            'shop_approval_state': 'pending',
            'registered_by_id': request.env.user.id,
            'company_type': 'company',
            'customer_rank': 1,
        }
        shop_category = (
            kwargs.get('shop_category')
            or kwargs.get('shahtaj_shop_category')
            or 'credit'
        )
        if shop_category not in ('credit', 'cash'):
            raise UserError(_('shop_category must be "credit" or "cash".'))
        vals['shahtaj_shop_category'] = shop_category
        if kwargs.get('zone_id'):
            vals['zone_id'] = int(kwargs['zone_id'])
        if kwargs.get('route_id'):
            vals['route_id'] = int(kwargs['route_id'])
        if kwargs.get('credit_limit') is not None:
            vals['credit_limit'] = float(kwargs['credit_limit'])
        if kwargs.get('legacy_balance') is not None:
            vals['legacy_balance'] = float(kwargs['legacy_balance'])
        vals.update(shop_photo_vals_from_kwargs(kwargs))

        partner = request.env['res.partner'].with_context(
            shahtaj_shop_register=True,
        ).create(vals)
        return api_success({
            'shop': serializers.shop_detail(partner, include_photos=False),
            'message': _('Shop submitted for distributor approval.'),
        })

    @http.route('/api/shahtaj/v1/shops/mine', **API_ROUTE)
    def my_shops(self, **kwargs):
        ensure_order_booker()
        shops = request.env['res.partner'].search([
            ('is_shahtaj_shop', '=', True),
            ('registered_by_id', '=', request.env.user.id),
        ], order='create_date desc', limit=50)
        return api_success({
            'shops': [serializers.shop_brief(shop) for shop in shops],
        })

    @http.route('/api/shahtaj/v1/shops/get', **API_ROUTE)
    def get_shop(self, shop_id=None, include_photos=True, **kwargs):
        partner = self._shop_for_booker(shop_id)
        return api_success({
            'shop': serializers.shop_detail(
                partner,
                include_photos=bool(include_photos),
            ),
        })
