# -*- coding: utf-8 -*-
"""Clear distributor-only toggles on order bookers / non-distributors."""


def migrate(cr, version):
    from odoo import SUPERUSER_ID, api

    env = api.Environment(cr, SUPERUSER_ID, {})
    env['res.users']._clear_shahtaj_distributor_flags_on_non_distributors()
    # Keep distributors with financial access ON if they already had it; new
    # default is False — ensure existing distributors keep financial unless
    # explicitly turned off (only clear non-distributors above).
    env['res.users']._sync_all_shahtaj_ui_groups()
    env['res.users']._sync_all_shahtaj_financial_groups()
