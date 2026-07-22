# -*- coding: utf-8 -*-
"""Enable financial access for existing distributors and sync security groups."""


def migrate(cr, version):
    cr.execute("""
        UPDATE res_users u
           SET shahtaj_distributor_financial_access = TRUE
          FROM res_groups_users_rel rel,
               ir_model_data imd
         WHERE rel.uid = u.id
           AND rel.gid = imd.res_id
           AND imd.module = 'shahtaj_oil'
           AND imd.name = 'group_shahtaj_distributor'
           AND (u.shahtaj_distributor_financial_access IS NULL
                OR u.shahtaj_distributor_financial_access = FALSE)
    """)

    from odoo import SUPERUSER_ID, api

    env = api.Environment(cr, SUPERUSER_ID, {})
    env['res.users']._sync_all_shahtaj_financial_groups()
    env['res.users']._sync_all_shahtaj_ui_groups()
