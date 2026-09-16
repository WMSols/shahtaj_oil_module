# -*- coding: utf-8 -*-
"""Delivery Man API — authentication."""
from datetime import datetime, timedelta

import odoo
from odoo import _, http
from odoo.exceptions import AccessDenied, AccessError
from odoo.http import request
from odoo.modules.registry import Registry

from odoo.addons.shahtaj_oil.api import serializers
from odoo.addons.shahtaj_oil.controllers.api.dm_base import (
    DM_API_ROUTE,
    DM_GROUP,
    DISTRIBUTOR_GROUP,
    api_success,
    ensure_delivery_man,
)

API_KEY_DAYS = 90


def _dm_user_brief(user):
    last_seen = user.shahtaj_last_seen_at
    return {
        'id': user.id,
        'delivery_man_id': user.id,
        'name': user.name,
        'login': user.login,
        'employee_code': user.shahtaj_employee_code or False,
        'online_status': user.shahtaj_online_status or False,
        'last_seen_at': last_seen.isoformat(sep=' ') if last_seen else False,
    }


class ShahtajDmApiAuth(http.Controller):

    @http.route(
        '/api/shahtaj/v1/dm/auth/login',
        type='json2',
        auth='none',
        methods=['POST'],
        csrf=False,
        save_session=False,
        cors='*',
    )
    def login(self, database=None, login=None, password=None, **kwargs):
        """Exchange delivery man login + password for a Bearer API key."""
        def _log_login(env, user, status, message, error_details=None):
            try:
                env['shahtaj.activity.log'].log_event(
                    name='Delivery man API login',
                    operation='dm.auth.login',
                    source='delivery_man_api',
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

                if not user.has_group(DM_GROUP):
                    _log_login(
                        user_env, user, 'failed',
                        _('Login rejected for %(login)s', login=login),
                        error_details='Not a delivery man',
                    )
                    cr.commit()
                    raise AccessError(_('This API is only for delivery men.'))
                if user.has_group(DISTRIBUTOR_GROUP):
                    _log_login(
                        user_env, user, 'failed',
                        _('Login rejected for %(login)s', login=login),
                        error_details='Distributor account',
                    )
                    cr.commit()
                    raise AccessError(_('Distributor accounts cannot use the delivery man API.'))
                if user.has_group('base.group_system'):
                    _log_login(
                        user_env, user, 'failed',
                        _('Login rejected for %(login)s', login=login),
                        error_details='Administrator account',
                    )
                    cr.commit()
                    raise AccessError(_('Administrator accounts cannot use the delivery man API.'))

                expiration = datetime.now() + timedelta(days=API_KEY_DAYS)
                api_key = user_env['res.users.apikeys'].sudo()._generate(
                    scope='rpc',
                    name='Shahtaj Delivery Man API',
                    expiration_date=expiration,
                )
                presence = user.action_shahtaj_touch_presence()
                session = user_env['shahtaj.dm.day.session'].get_or_create_today(user)
                _log_login(
                    user_env, user, 'success',
                    _('DM API login for %(login)s', login=login),
                )
                cr.commit()
                user_payload = _dm_user_brief(user)
                session_payload = {
                    'id': session.id,
                    'state': session.state,
                    'date': str(session.session_date),
                    'departed_at': session.departed_at.isoformat(sep=' ') if session.departed_at else False,
                    'ended_at': session.ended_at.isoformat(sep=' ') if session.ended_at else False,
                }
                gps_criteria_payload = serializers.gps_criteria(user_env)
            except (AccessError, AccessDenied):
                raise
            except Exception as exc:
                try:
                    env['shahtaj.activity.log'].log_event(
                        name='Delivery man API login',
                        operation='dm.auth.login',
                        source='delivery_man_api',
                        status='failed',
                        message=_('DM API login failed for %(login)s', login=login),
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
            'session': session_payload,
            'online_status': presence['online_status'],
            'last_seen_at': presence['last_seen_at'],
            'gps_criteria': gps_criteria_payload,
        })

    @http.route('/api/shahtaj/v1/dm/auth/me', **DM_API_ROUTE)
    def me(self, **kwargs):
        ensure_delivery_man()
        user = request.env.user
        presence = user.action_shahtaj_touch_presence()
        session = request.env['shahtaj.dm.day.session'].get_or_create_today(user)
        return api_success({
            'user': _dm_user_brief(user),
            'session': {
                'id': session.id,
                'state': session.state,
                'date': str(session.session_date),
                'departed_at': session.departed_at.isoformat(sep=' ') if session.departed_at else False,
                'ended_at': session.ended_at.isoformat(sep=' ') if session.ended_at else False,
            },
            'online_status': presence['online_status'],
            'last_seen_at': presence['last_seen_at'],
        })

    @http.route('/api/shahtaj/v1/dm/presence/heartbeat', **DM_API_ROUTE)
    def heartbeat(self, **kwargs):
        ensure_delivery_man()
        presence = request.env.user.action_shahtaj_touch_presence()
        return api_success(presence)
