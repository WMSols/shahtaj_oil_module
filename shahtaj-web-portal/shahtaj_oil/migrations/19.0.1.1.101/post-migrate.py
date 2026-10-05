# -*- coding: utf-8 -*-
"""Backfill check-in rows for shop orders that never had a field visit."""
from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    env['shahtaj.gps.attempt'].backfill_from_existing_visits()
