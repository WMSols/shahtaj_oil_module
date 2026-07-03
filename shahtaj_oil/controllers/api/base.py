# -*- coding: utf-8 -*-
"""Base helpers for order booker HTTP API controllers."""
from odoo import _
from odoo.exceptions import AccessError
from odoo.http import request


BOOKER_GROUP = 'shahtaj_oil.group_shahtaj_order_booker'
DISTRIBUTOR_GROUP = 'shahtaj_oil.group_shahtaj_distributor'

# Shared route options for mobile / browser test clients.
API_ROUTE = {
    'type': 'json2',
    'auth': 'bearer',
    'methods': ['POST'],
    'csrf': False,
    'save_session': False,
    'cors': '*',
}


def api_success(data):
    return {'ok': True, 'data': data}


def ensure_order_booker():
    """Reject non-booker users (distributors, admins, public)."""
    user = request.env.user
    if not user or user._is_public():
        raise AccessError(_('Authentication required.'))
    if not user.has_group(BOOKER_GROUP):
        raise AccessError(_('This API is only for order bookers.'))
    if user.has_group(DISTRIBUTOR_GROUP):
        raise AccessError(_(
            'Distributor accounts must use the Odoo web app, not the booker API.'
        ))
    if user.has_group('base.group_system'):
        raise AccessError(_(
            'Administrator accounts cannot use the booker API. Log in as an order booker.'
        ))


def visit_for_booker(visit_id):
    ensure_order_booker()
    visit = request.env['shahtaj.visit'].browse(int(visit_id))
    if not visit.exists():
        raise AccessError(_('Visit not found.'))
    if visit.order_booker_id != request.env.user:
        raise AccessError(_('This visit belongs to another order booker.'))
    return visit


def task_for_booker(task_id):
    ensure_order_booker()
    task = request.env['shahtaj.visit.task'].browse(int(task_id))
    if not task.exists():
        raise AccessError(_('Visit task not found.'))
    if task.order_booker_id != request.env.user:
        raise AccessError(_('This task belongs to another order booker.'))
    return task
