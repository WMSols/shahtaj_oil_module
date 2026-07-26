# -*- coding: utf-8 -*-
"""Order booker API — authentication."""
from datetime import datetime, timedelta

import odoo
from odoo import _, http
from odoo.exceptions import AccessDenied, AccessError
from odoo.http import request
from odoo.modules.registry import Registry

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.controllers.api.base import (
    API_ROUTE,
    BOOKER_GROUP,
    DISTRIBUTOR_GROUP,
    api_success,
    ensure_order_booker,
)

API_KEY_DAYS = 90


class ShahtajApiAuth(http.Controller):

    @http.route(
        '/api/shahtaj/v1/auth/login',
        type='json2',
        auth='none',
        methods=['POST'],
        csrf=False,
        save_session=False,
        cors='*',
    )
    def login(self, database=None, login=None, password=None, **kwargs):
        """Exchange booker login + password for a Bearer API key."""
        def _log_login(env, user, status, message, error_details=None):
            try:
                env['shahtaj.activity.log'].log_event(
                    name='Order booker API login',
                    operation='auth.login',
                    source='order_booker_api',
                    status=status,
                    user=user,
                    message=message,
                    error_details=error_details,
                )
            except Exception:
                pass

        if not database or not login or not password:
            raise AccessError(_('database, login, and password are required.'))

        if not http.db_filter([database]):
            raise AccessDenied(_('Database not found.'))

        with Registry(database).cursor() as cr:
            env = odoo.api.Environment(cr, None, {})
            try:
                credential = {'login': login, 'password': password, 'type': 'password'}
                auth_info = request.session.authenticate(env, credential)
                uid = auth_info['uid']
                user_env = odoo.api.Environment(cr, uid, {})
                user = user_env.user

                if not user.has_group(BOOKER_GROUP):
                    _log_login(
                        user_env, user, 'failed',
                        _('Login rejected for %(login)s', login=login),
                        error_details='Not an order booker',
                    )
                    cr.commit()
                    raise AccessError(_('This API is only for order bookers.'))
                if user.has_group(DISTRIBUTOR_GROUP):
                    _log_login(
                        user_env, user, 'failed',
                        _('Login rejected for %(login)s', login=login),
                        error_details='Distributor account',
                    )
                    cr.commit()
                    raise AccessError(_('Distributor accounts cannot use the booker API.'))
                if user.has_group('base.group_system'):
                    _log_login(
                        user_env, user, 'failed',
                        _('Login rejected for %(login)s', login=login),
                        error_details='Administrator account',
                    )
                    cr.commit()
                    raise AccessError(_('Administrator accounts cannot use the booker API.'))

                expiration = datetime.now() + timedelta(days=API_KEY_DAYS)
                api_key = user_env['res.users.apikeys'].sudo()._generate(
                    scope='rpc',
                    name='Shahtaj Order Booker API',
                    expiration_date=expiration,
                )
                presence = user.action_shahtaj_touch_presence()
                # Ensure visit tasks exist for coming days (same as web session_info).
                user_env['shahtaj.visit.task'].sudo()._auto_generate_window(
                    order_booker=user,
                )
                _log_login(
                    user_env, user, 'success',
                    _('API login for %(login)s', login=login),
                )
                cr.commit()
                user_payload = serializers.user_brief(user)
            except (AccessError, AccessDenied):
                raise
            except Exception as exc:
                try:
                    env['shahtaj.activity.log'].log_event(
                        name='Order booker API login',
                        operation='auth.login',
                        source='order_booker_api',
                        status='failed',
                        message=_('API login failed for %(login)s', login=login),
                        error_details=str(exc),
                    )
                    cr.commit()
                except Exception:
                    pass
                raise

        return api_success({
            'database': database,
            'api_key': api_key,
            'expires_in_days': API_KEY_DAYS,
            'user': user_payload,
            'online_status': presence['online_status'],
            'last_seen_at': presence['last_seen_at'],
        })

    @http.route('/api/shahtaj/v1/auth/me', **API_ROUTE)
    def me(self, **kwargs):
        ensure_order_booker()
        user = request.env.user
        presence = user.action_shahtaj_touch_presence()
        return api_success({
            'user': serializers.user_brief(user),
            'online_status': presence['online_status'],
            'last_seen_at': presence['last_seen_at'],
        })
