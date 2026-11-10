# -*- coding: utf-8 -*-
"""Repair Returned jobs with stale Stop / load cues."""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    # Stop must not stay Heading / Done / Shop Closed after Return WH.
    cr.execute(
        """
        UPDATE shahtaj_dm_delivery
           SET field_state = 'pending'
         WHERE state = 'returned'
           AND field_state IS DISTINCT FROM 'pending'
        """
    )
    fixed = cr.rowcount
    env = api.Environment(cr, SUPERUSER_ID, {})
    # Recompute load badges (Returned → not on van / still-to-pick 0).
    returned = env['shahtaj.dm.delivery'].sudo().search([('state', '=', 'returned')])
    if returned:
        returned._compute_shahtaj_load_status()
    _logger.info(
        'Shahtaj 19.0.1.1.215: fixed returned stop rows=%s, recomputed load for %s jobs',
        fixed, len(returned),
    )
