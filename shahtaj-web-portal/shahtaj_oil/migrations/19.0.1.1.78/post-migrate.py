# -*- coding: utf-8 -*-
"""Ensure all setup checks & accounting configurations run on upgrade."""
from odoo import api, SUPERUSER_ID
from odoo.addons.shahtaj_oil.setup import run_all_setup_checks


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    run_all_setup_checks(env)
