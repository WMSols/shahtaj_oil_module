# -*- coding: utf-8 -*-
"""Add res_users.shahtaj_is_delivery_man before ORM loads users (cron, HTTP)."""


def migrate(cr, version):
    from odoo.addons.shahtaj_oil.hooks import ensure_res_users_delivery_man_column
    ensure_res_users_delivery_man_column(cr)
