# -*- coding: utf-8 -*-
"""Base helpers for Delivery Man HTTP API."""
import functools

from odoo import _
from odoo.exceptions import AccessError
from odoo.http import request


DM_GROUP = 'shahtaj_oil.group_shahtaj_delivery_man'
DISTRIBUTOR_GROUP = 'shahtaj_oil.group_shahtaj_distributor'

DM_API_ROUTE = {
    'type': 'json2',
    'auth': 'bearer',
    'methods': ['POST'],
    'csrf': False,
    'save_session': False,
    'cors': '*',
}


def api_success(data):
    return {'ok': True, 'data': data}


def ensure_delivery_man():
    user = request.env.user
    if not user or user._is_public():
        raise AccessError(_('Authentication required.'))
    if not user.has_group(DM_GROUP):
        raise AccessError(_('This API is only for delivery men.'))
    if user.has_group(DISTRIBUTOR_GROUP):
        raise AccessError(_(
            'Distributor accounts must use the Odoo web app, not the delivery man API.'
        ))
    if user.has_group('base.group_system'):
        raise AccessError(_(
            'Administrator accounts cannot use the delivery man API.'
        ))
    if not user.shahtaj_is_delivery_man:
        raise AccessError(_('This account is not marked as a delivery man.'))


def dm_service():
    return request.env['shahtaj.dm.api.service']


def _activity_log():
    return request.env['shahtaj.activity.log']


def dm_api_activity(operation, name=None, log_success=True):
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            label = name or operation
            try:
                result = func(*args, **kwargs)
                if log_success:
                    try:
                        _activity_log().log_event(
                            name=label,
                            operation=operation,
                            source='delivery_man_api',
                            status='success',
                            message=label,
                        )
                    except Exception:
                        pass
                return result
            except Exception as exc:
                try:
                    _activity_log().log_exception(
                        operation=operation,
                        name=label,
                        exc=exc,
                        source='delivery_man_api',
                        message=label,
                    )
                except Exception:
                    pass
                raise
        return wrapper
    return decorator
