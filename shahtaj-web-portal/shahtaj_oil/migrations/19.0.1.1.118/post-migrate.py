# -*- coding: utf-8 -*-
"""Backfill shahtaj_is_delivery_man from the Delivery Man security group."""
from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    from odoo.addons.shahtaj_oil.hooks import (
        _recompute_shahtaj_delivery_man_flags,
        ensure_res_users_delivery_man_column,
    )
    ensure_res_users_delivery_man_column(cr)
    env = api.Environment(cr, SUPERUSER_ID, {})
    _recompute_shahtaj_delivery_man_flags(env)
