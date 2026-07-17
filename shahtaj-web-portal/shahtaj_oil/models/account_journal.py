# -*- coding: utf-8 -*-
"""Safe distributor creation of bank/cash journals."""
from odoo import _, api, models
from odoo.exceptions import AccessError


class AccountJournal(models.Model):
    _inherit = 'account.journal'

    @api.model_create_multi
    def create(self, vals_list):
        """Let distributors create liquidity journals and generated accounts.

        Odoo creates the journal's ledger account as part of account.journal
        creation. Distributors intentionally do not have general account.account
        create rights, so elevate this one tightly-scoped operation only.
        """
        is_distributor = self.env.user.has_group(
            'shahtaj_oil.group_shahtaj_distributor',
        )
        is_account_manager = self.env.user.has_group(
            'account.group_account_manager',
        )
        if is_distributor and not is_account_manager:
            invalid_types = {
                vals.get('type', 'general')
                for vals in vals_list
                if vals.get('type', 'general') not in ('bank', 'cash')
            }
            if invalid_types:
                raise AccessError(_(
                    'Distributors can only create Bank or Cash journals.'
                ))
            return super(AccountJournal, self.sudo()).create(vals_list)
        return super().create(vals_list)
