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

    def _post(self, soft=True):
        self._shahtaj_snapshot_invoice_costs()
        return super()._post(soft=soft)

    def _shahtaj_snapshot_invoice_costs(self):
        """Lock product cost on invoice lines at posting (standard perpetual-inventory practice)."""
        for move in self.filtered(
            lambda m: m.move_type in ('out_invoice', 'out_refund')
        ):
            product_lines = move.invoice_line_ids.filtered(
                lambda line: line.display_type == 'product' and line.product_id
            )
            for line in product_lines:
                line.shahtaj_cost_unit = line.product_id.standard_price or 0.0
