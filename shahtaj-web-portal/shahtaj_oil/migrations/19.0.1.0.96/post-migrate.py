# -*- coding: utf-8 -*-
"""Recompute target progress after date-window fix."""


def migrate(cr, version):
    from odoo import api, SUPERUSER_ID

    env = api.Environment(cr, SUPERUSER_ID, {})
    targets = env['shahtaj.visit.target'].with_context(active_test=False).search([])
    if targets:
        targets._recompute_recordset()
