# -*- coding: utf-8 -*-
from odoo.addons.shahtaj_oil.hooks import migrate_distributor_partner_rules


def migrate(cr, version):
    migrate_distributor_partner_rules(cr)
