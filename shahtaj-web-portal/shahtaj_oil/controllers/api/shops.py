# -*- coding: utf-8 -*-
"""Order booker API — shop registration."""
from odoo import _, http
from odoo.exceptions import AccessError, UserError
from odoo.http import request

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.api.image_utils import shop_photo_vals_from_kwargs
from odoo.addons.shahtaj_oil.controllers.api.base import (
    API_ROUTE,
    api_activity,
    api_success,
    ensure_order_booker,
    task_for_booker,
)


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
    @api_activity('shop.register', 'Register shop')
    def register_shop(self, **kwargs):
        ensure_order_booker()
        name = kwargs.get('name')
        owner_name = kwargs.get('owner_name')
        owner_phone = kwargs.get('owner_phone')
        latitude = kwargs.get('latitude')
        longitude = kwargs.get('longitude')
        owner_cnic_number = (kwargs.get('owner_cnic_number') or '').strip()
        photo_vals = shop_photo_vals_from_kwargs(kwargs)
        if not all([name, owner_name, owner_phone, latitude, longitude]):
            raise UserError(_(
                'name, owner_name, owner_phone, latitude, and longitude are required.'
            ))
        if not owner_cnic_number:
            raise UserError(_('owner_cnic_number is required for on-site shop registration.'))
        if not photo_vals.get('shop_exterior_photo'):
            raise UserError(_(
                'shop_exterior_photo is required for on-site shop registration.'
            ))
        # Explicit shop flags so create() always marks this as a pending Shahtaj shop
        # (visible in shops/mine and distributor pending-approval screens).
        vals = {
            'name': name,
            'owner_name': owner_name,
            'owner_phone': owner_phone,
            'owner_cnic_number': owner_cnic_number,
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
        if kwargs.get('zone_id'):
            zone = request.env['shahtaj.zone'].browse(int(kwargs['zone_id']))
            if not zone.exists() or not zone.active:
                raise UserError(_('Zone not found or archived.'))
        if kwargs.get('route_id'):
            route = request.env['shahtaj.route'].browse(int(kwargs['route_id']))
            if not route.exists() or not route._shahtaj_is_operational_for_booker():
                raise UserError(_('Route not found or archived.'))
        vals.update(photo_vals)

        partner = request.env['res.partner'].with_context(
            shahtaj_shop_register=True,
        ).create(vals)
        return api_success({
            'shop': serializers.shop_detail(partner, include_photos=False),
            'message': _('Shop submitted for distributor approval.'),
        })

    @http.route('/api/shahtaj/v1/shops/mine', **API_ROUTE)
    def my_shops(self, **kwargs):
        """Return all shops this booker registered (pending / approved / rejected).

        Each shop includes approval_state and is_operational so the app can show
        rejection or pending status. Only approved+operational shops are visitable.
        """
        ensure_order_booker()
        shops = request.env['res.partner'].search([
            ('is_shahtaj_shop', '=', True),
            ('registered_by_id', '=', request.env.user.id),
            ('active', '=', True),
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

    def _shop_task_for_verify(self, shop_id, task_id):
        """Booker may verify a shop they are scheduled to visit today."""
        ensure_order_booker()
        task = task_for_booker(task_id)
        shop = request.env['res.partner'].browse(int(shop_id)).exists()
        if not shop or not shop.is_shahtaj_shop:
            raise AccessError(_('Shop not found.'))
        if task.shop_id != shop:
            raise UserError(_(
                'This visit task does not belong to shop "%(shop)s".',
                shop=shop.display_name,
            ))
        return shop, task

    @http.route('/api/shahtaj/v1/shops/verify-on-site', **API_ROUTE)
    @api_activity('shop.field_verify', 'Verify shop on site')
    def verify_on_site(self, **kwargs):
        """First visit: save GPS + exterior photo + CNIC number (+ optional gaps).

        Required: shop_id, task_id, latitude, longitude, shop_exterior_photo,
                  owner_cnic_number (unless already on the shop)
        Optional: owner_photo, owner_cnic_front/back, owner_name, owner_phone,
                  shop_category
        """
        shop_id = kwargs.get('shop_id')
        task_id = kwargs.get('task_id')
        if not shop_id or not task_id:
            raise UserError(_('shop_id and task_id are required.'))
        shop, task = self._shop_task_for_verify(shop_id, task_id)

        if task.visit_id and task.visit_id.state == 'in_progress':
            return api_success({
                'needs_shop_setup': False,
                'shop': serializers.shop_brief(shop),
                'visit': serializers.visit_dict(task.visit_id),
                'resumed': True,
                'message': _('Visit already in progress.'),
            })

        if shop.shahtaj_field_verified:
            # Already verified — just normal check-in with provided GPS.
            latitude = kwargs.get('latitude')
            longitude = kwargs.get('longitude')
            if latitude is None or longitude is None:
                raise UserError(_('latitude and longitude are required.'))
            visit = request.env['shahtaj.visit'].create_from_task_checkin(
                task, float(latitude), float(longitude),
            )
            return api_success({
                'needs_shop_setup': False,
                'shop': serializers.shop_brief(shop),
                'visit': serializers.visit_dict(visit),
                'resumed': False,
                'message': _('Shop was already field-verified. Visit started.'),
            })

        photo_vals = shop_photo_vals_from_kwargs(kwargs)
        verify_vals = {
            'latitude': kwargs.get('latitude'),
            'longitude': kwargs.get('longitude'),
            **photo_vals,
        }
        if kwargs.get('owner_cnic_number'):
            verify_vals['owner_cnic_number'] = kwargs['owner_cnic_number']
        if kwargs.get('owner_name'):
            verify_vals['owner_name'] = kwargs['owner_name']
        if kwargs.get('owner_phone'):
            verify_vals['owner_phone'] = kwargs['owner_phone']
        if kwargs.get('shop_category') or kwargs.get('shahtaj_shop_category'):
            verify_vals['shop_category'] = (
                kwargs.get('shop_category')
                or kwargs.get('shahtaj_shop_category')
            )

        shop.action_shahtaj_apply_field_verification(
            verify_vals, verified_by=request.env.user,
        )
        visit = request.env['shahtaj.visit'].create_from_task_checkin(
            task,
            float(kwargs['latitude']),
            float(kwargs['longitude']),
        )
        return api_success({
            'needs_shop_setup': False,
            'field_verified': True,
            'visit_tag': 'visited',
            'shop': serializers.shop_brief(shop),
            'visit': serializers.visit_dict(visit),
            'resumed': False,
            'message': _('Shop verified on site. Visit started.'),
        })
