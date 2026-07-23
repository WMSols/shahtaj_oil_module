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

    def _shahtaj_needs_invoice_sudo(self):
        """Custom-portal financial distributors lack Accounting/Invoicing group."""
        from .account_payment import _shahtaj_needs_financial_sudo
        return _shahtaj_needs_financial_sudo(self.env)

    def write(self, vals):
        # Invoice line edits write journal items; elevate only when needed.
        if self._shahtaj_needs_invoice_sudo() and (
            'invoice_line_ids' in vals or 'line_ids' in vals
        ):
            self.check_access('write')
            return super(AccountMove, self.sudo()).write(vals)
        return super().write(vals)

    def _post(self, soft=True):
        self._shahtaj_snapshot_invoice_costs()
        # Core _post requires account.group_account_invoice; financial portal users
        # get ACL via shahtaj financial group instead of native Accounting menus.
        if self._shahtaj_needs_invoice_sudo():
            self.check_access('write')
            return super(AccountMove, self.sudo())._post(soft=soft)
        return super()._post(soft=soft)

    def button_draft(self):
        if self._shahtaj_needs_invoice_sudo():
            self.check_access('write')
            return super(AccountMove, self.sudo()).button_draft()
        return super().button_draft()

    def button_cancel(self):
        if self._shahtaj_needs_invoice_sudo():
            self.check_access('write')
            return super(AccountMove, self.sudo()).button_cancel()
        return super().button_cancel()

    def _shahtaj_snapshot_invoice_costs(self):
        """Lock product cost on invoice / credit-note lines at posting.

        Invoices: freeze current product standard cost.
        Credit notes from a reversal: reuse the original invoice line's frozen
        cost so P&L COGS matches the sale being refunded (not today's cost).
        """
        for move in self.filtered(
            lambda m: m.move_type in ('out_invoice', 'out_refund')
        ):
            product_lines = move.invoice_line_ids.filtered(
                lambda line: line.display_type == 'product' and line.product_id
            )
            origin_pool = []
            if move.move_type == 'out_refund' and move.reversed_entry_id:
                origin_lines = move.reversed_entry_id.invoice_line_ids.filtered(
                    lambda line: line.display_type == 'product' and line.product_id
                )
                origin_pool = [
                    (
                        line.product_id.id,
                        line.shahtaj_cost_unit
                        if line.shahtaj_cost_unit
                        else (line.product_id.standard_price or 0.0),
                    )
                    for line in origin_lines
                ]

            for line in product_lines:
                if move.move_type == 'out_refund' and origin_pool:
                    matched_cost = None
                    for idx, (product_id, unit_cost) in enumerate(origin_pool):
                        if product_id == line.product_id.id:
                            matched_cost = unit_cost
                            origin_pool.pop(idx)
                            break
                    line.shahtaj_cost_unit = (
                        matched_cost
                        if matched_cost is not None
                        else (line.product_id.standard_price or 0.0)
                    )
                else:
                    line.shahtaj_cost_unit = line.product_id.standard_price or 0.0
