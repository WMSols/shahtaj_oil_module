# -*- coding: utf-8 -*-
"""Sync distributor order-booker user rule and recompute booker flags."""

from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    from odoo.addons.shahtaj_oil.hooks import (
        _recompute_shahtaj_order_booker_flags,
        _sync_distributor_booker_user_rule,
    )
    _sync_distributor_booker_user_rule(env)
    _recompute_shahtaj_order_booker_flags(env)
