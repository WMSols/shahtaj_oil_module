# -*- coding: utf-8 -*-
"""Ensure day-session end_source column exists and backfill ended rows."""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    cr.execute(
        """
        ALTER TABLE shahtaj_dm_day_session
            ADD COLUMN IF NOT EXISTS end_source VARCHAR
        """
    )
    cr.execute(
        """
        UPDATE shahtaj_dm_day_session
           SET end_source = 'dm'
         WHERE state = 'ended'
           AND ended_at IS NOT NULL
           AND (end_source IS NULL OR end_source = '')
        """
    )
    backfilled = cr.rowcount
    env = api.Environment(cr, SUPERUSER_ID, {})
    Session = env['shahtaj.dm.day.session']
    if hasattr(Session, 'shahtaj_cleanup_duplicate_day_sessions'):
        result = Session.shahtaj_cleanup_duplicate_day_sessions()
        _logger.info(
            'Shahtaj 19.0.1.1.213 end_source ready (backfilled=%s); cleanup=%s',
            backfilled, result,
        )
    else:
        _logger.info(
            'Shahtaj 19.0.1.1.213 end_source ready (backfilled=%s)',
            backfilled,
        )
