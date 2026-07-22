# -*- coding: utf-8 -*-
"""Frozen unit cost on customer invoice lines (standard cost at posting time)."""
from odoo import fields, models


class AccountMoveLine(models.Model):
    _inherit = 'account.move.line'

    shahtaj_cost_unit = fields.Float(
        string='Frozen Unit Cost',
        digits='Product Price',
        copy=False,
        help='Product cost per unit locked when the invoice or credit note was posted. '
             'Used for stable gross margin in the distributor P&L.',
    )
