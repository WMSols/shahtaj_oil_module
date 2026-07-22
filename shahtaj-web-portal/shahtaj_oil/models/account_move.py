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
        if self.env.su:
            return False
        user = self.env.user
        if user.has_group('account.group_account_invoice'):
            return False
        return user.has_group('shahtaj_oil.group_shahtaj_distributor_financial')

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
        """Lock product cost on invoice lines at posting (standard perpetual-inventory practice)."""
        for move in self.filtered(
            lambda m: m.move_type in ('out_invoice', 'out_refund')
        ):
            product_lines = move.invoice_line_ids.filtered(
                lambda line: line.display_type == 'product' and line.product_id
            )
            for line in product_lines:
                line.shahtaj_cost_unit = line.product_id.standard_price or 0.0
