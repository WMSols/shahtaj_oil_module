# -*- coding: utf-8 -*-
"""Collapse Check-in + Place Order GPS pairs into one Place Order row."""
from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    env['shahtaj.gps.attempt'].collapse_placed_order_checkins()
