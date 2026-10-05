# -*- coding: utf-8 -*-
"""Backfill GPS attempt rows from visits that predate the GPS log."""
from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    env['shahtaj.gps.attempt'].backfill_from_existing_visits()
