# -*- coding: utf-8 -*-
"""Recalculate target progress after stricter order filters."""
from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    targets = env['shahtaj.visit.target'].sudo().search([])
    if targets:
        targets._recompute_recordset()
