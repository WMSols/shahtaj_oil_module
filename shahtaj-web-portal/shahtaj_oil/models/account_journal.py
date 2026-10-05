# -*- coding: utf-8 -*-
"""Distributor creation of journals, including auto-generated ledger accounts."""
from odoo import api, models


class AccountJournal(models.Model):
    _inherit = 'account.journal'

    @api.model
    def shahtaj_get_journal_form_defaults(self, journal_type):
        """Return the same type-based defaults native Odoo fills on the journal form."""
        company = self.env.company.sudo()
        defaults = {
            'code': self._get_next_journal_default_code(journal_type, company) or '',
            'default_account_id': False,
            'suspense_account_id': False,
            'profit_account_id': False,
            'loss_account_id': False,
            'company_partner_id': company.partner_id.id,
        }
        if journal_type in ('bank', 'cash', 'credit'):
            defaults['suspense_account_id'] = company.account_journal_suspense_account_id.id or False
        if journal_type in ('cash', 'bank'):
            profit = company.default_cash_difference_income_account_id
            loss = company.default_cash_difference_expense_account_id
            defaults['profit_account_id'] = profit.id if profit and profit.active else False
            defaults['loss_account_id'] = loss.id if loss and loss.active else False
        if journal_type == 'sale' and company.income_account_id.active:
            defaults['default_account_id'] = company.income_account_id.id
        elif journal_type == 'purchase' and company.expense_account_id.active:
            defaults['default_account_id'] = company.expense_account_id.id
        return defaults

    @api.model_create_multi
    def create(self, vals_list):
        """Let financial distributors create journals and generated accounts.

        Odoo creates the journal's ledger account as part of account.journal
        creation. Elevate this operation for distributors who already have
        journal create rights so sale/purchase/cash/bank/credit/general all
        work from the custom Accounting tab.
        """
        is_distributor = self.env.user.has_group(
            'shahtaj_oil.group_shahtaj_distributor',
        )
        is_financial = self.env.user.has_group(
            'shahtaj_oil.group_shahtaj_distributor_financial',
        )
        is_account_manager = self.env.user.has_group(
            'account.group_account_manager',
        )
        if is_distributor and is_financial and not is_account_manager:
            return super(AccountJournal, self.sudo()).create(vals_list)
        return super().create(vals_list)
