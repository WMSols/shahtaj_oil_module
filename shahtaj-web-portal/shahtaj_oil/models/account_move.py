# -*- coding: utf-8 -*-
"""Mark opening-balance invoices created from shop legacy debt."""
from odoo import fields, models


class AccountMove(models.Model):
    _inherit = 'account.move'

    shahtaj_is_legacy_balance = fields.Boolean(
        string='Legacy Shop Balance Invoice',
        default=False,
        copy=False,
        index=True,
        help='Posted when a shop is approved with a previous outstanding amount. '
             'Distributor can collect payment against this invoice.',
    )
