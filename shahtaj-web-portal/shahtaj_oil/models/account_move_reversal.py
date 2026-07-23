# -*- coding: utf-8 -*-
"""Credit-note reversal for custom-portal financial distributors."""
from odoo import models

from .account_payment import _shahtaj_needs_financial_sudo


class AccountMoveReversal(models.TransientModel):
    _inherit = 'account.move.reversal'

    def reverse_moves(self, is_modify=False):
        if _shahtaj_needs_financial_sudo(self.env):
            self.check_access('write')
            return super(AccountMoveReversal, self.sudo()).reverse_moves(
                is_modify=is_modify,
            )
        return super().reverse_moves(is_modify=is_modify)
