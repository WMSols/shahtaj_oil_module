# -*- coding: utf-8 -*-
"""Audit past Delivery Day locks after load-badge / lock-rule release.

Delivery Day lock is compute-only (not stored). Past scheduled_date jobs are
already unlocked by rule. This one-shot audit confirms no unexpected locks.
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    Delivery = env['shahtaj.dm.delivery']
    if not hasattr(Delivery, 'shahtaj_audit_past_delivery_day_locks'):
        _logger.info(
            'Shahtaj 19.0.1.1.208: audit helper missing; skip past lock check.'
        )
        return
    result = Delivery.shahtaj_audit_past_delivery_day_locks()
    _logger.info(
        'Shahtaj 19.0.1.1.208 past Delivery Day lock audit: %s',
        result,
    )
