# -*- coding: utf-8 -*-
"""One-shot: existing order bookers → Asia/Karachi + Pakistan."""


def migrate(cr, version):
    from odoo import SUPERUSER_ID, api

    env = api.Environment(cr, SUPERUSER_ID, {})
    booker_group = env.ref(
        'shahtaj_oil.group_shahtaj_order_booker',
        raise_if_not_found=False,
    )
    if not booker_group:
        return
    pakistan = env.ref('base.pk', raise_if_not_found=False)
    bookers = env['res.users'].with_context(active_test=False).search([
        ('group_ids', 'in', booker_group.ids),
    ])
    if not bookers:
        return
    vals = {'tz': 'Asia/Karachi'}
    if pakistan:
        vals['country_id'] = pakistan.id
    bookers.write(vals)
