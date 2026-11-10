# -*- coding: utf-8 -*-
"""Day session hygiene: merge duplicates, auto-end past On the way journeys."""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    Session = env['shahtaj.dm.day.session']
    if hasattr(Session, 'shahtaj_cleanup_duplicate_day_sessions'):
        result = Session.shahtaj_cleanup_duplicate_day_sessions()
        _logger.info('Shahtaj 19.0.1.1.210 duplicate day session cleanup: %s', result)
    if hasattr(Session, '_cron_auto_end_stale_day_sessions'):
        Session._cron_auto_end_stale_day_sessions()
        _logger.info('Shahtaj 19.0.1.1.210 stale On the way sessions auto-ended.')
