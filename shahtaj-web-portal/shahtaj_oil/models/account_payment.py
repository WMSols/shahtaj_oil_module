# -*- coding: utf-8 -*-
"""Structured payment details for Shahtaj shop collections."""
from odoo import api, fields, models


SHAHTAJ_PAYMENT_CHANNELS = [
    ('cash', 'Cash'),
    ('cheque', 'Cheque'),
    ('online', 'Online Bank Transfer'),
    ('card', 'Card / POS'),
    ('other', 'Other Bank Payment'),
]


def _shahtaj_needs_financial_sudo(env):
    """Custom-portal financial distributors lack Accounting/Invoicing group."""
    if env.su:
        return False
    user = env.user
    if user.has_group('account.group_account_invoice'):
        return False
    return user.has_group('shahtaj_oil.group_shahtaj_distributor_financial')


class AccountPayment(models.Model):
    _inherit = 'account.payment'

    shahtaj_journal_type = fields.Selection(
        related='journal_id.type',
        string='Journal Type',
        readonly=True,
    )
    shahtaj_payment_channel = fields.Selection(
        SHAHTAJ_PAYMENT_CHANNELS,
        string='Payment Method',
        copy=False,
        tracking=True,
        help='How the shop/customer paid or received a refund.',
    )
    shahtaj_payer_bank_name = fields.Char(
        string='Customer Bank',
        copy=False,
        tracking=True,
    )
    shahtaj_payer_account_number = fields.Char(
        string='Customer Account Number',
        copy=False,
        tracking=True,
        help='Shop/customer account used to send payment or receive a refund.',
    )
    shahtaj_instrument_reference = fields.Char(
        string='Cheque / Transaction Reference',
        copy=False,
        tracking=True,
        help='Cheque number, online transaction ID, deposit slip, or other reference.',
    )
    shahtaj_payment_notes = fields.Text(
        string='Payment Notes',
        copy=False,
        tracking=True,
    )

    @api.onchange('journal_id')
    def _onchange_shahtaj_journal_payment_details(self):
        for payment in self:
            if payment.journal_id.type == 'cash':
                payment.shahtaj_payment_channel = 'cash'
                payment.shahtaj_payer_bank_name = False
                payment.shahtaj_payer_account_number = False
                payment.shahtaj_instrument_reference = False
            elif (
                payment.journal_id.type in ('bank', 'credit')
                and payment.shahtaj_payment_channel == 'cash'
            ):
                payment.shahtaj_payment_channel = False

    def action_post(self):
        # Posting creates/reconciles move lines; elevate only for portal financial users.
        if _shahtaj_needs_financial_sudo(self.env):
            self.check_access('write')
            return super(AccountPayment, self.sudo()).action_post()
        return super().action_post()


class AccountPaymentRegister(models.TransientModel):
    _inherit = 'account.payment.register'

    shahtaj_journal_type = fields.Selection(
        related='journal_id.type',
        string='Journal Type',
        readonly=True,
    )
    shahtaj_payment_channel = fields.Selection(
        SHAHTAJ_PAYMENT_CHANNELS,
        string='Payment Method',
    )
    shahtaj_payer_bank_name = fields.Char(string='Customer Bank')
    shahtaj_payer_account_number = fields.Char(
        string='Customer Account Number',
        help='Shop/customer account used to send payment or receive a refund.',
    )
    shahtaj_instrument_reference = fields.Char(
        string='Cheque / Transaction Reference',
        help='Cheque number, online transaction ID, deposit slip, or other reference.',
    )
    shahtaj_payment_notes = fields.Text(string='Payment Notes')

    @api.onchange('journal_id')
    def _onchange_shahtaj_journal_payment_details(self):
        for wizard in self:
            if wizard.journal_id.type == 'cash':
                wizard.shahtaj_payment_channel = 'cash'
                wizard.shahtaj_payer_bank_name = False
                wizard.shahtaj_payer_account_number = False
                wizard.shahtaj_instrument_reference = False
            elif (
                wizard.journal_id.type in ('bank', 'credit')
                and wizard.shahtaj_payment_channel == 'cash'
            ):
                wizard.shahtaj_payment_channel = False

    def _shahtaj_payment_detail_vals(self):
        self.ensure_one()
        if self.journal_id.type == 'cash':
            return {
                'shahtaj_payment_channel': 'cash',
                'shahtaj_payer_bank_name': False,
                'shahtaj_payer_account_number': False,
                'shahtaj_instrument_reference': False,
                'shahtaj_payment_notes': self.shahtaj_payment_notes,
            }
        return {
            'shahtaj_payment_channel': self.shahtaj_payment_channel,
            'shahtaj_payer_bank_name': self.shahtaj_payer_bank_name,
            'shahtaj_payer_account_number': self.shahtaj_payer_account_number,
            'shahtaj_instrument_reference': self.shahtaj_instrument_reference,
            'shahtaj_payment_notes': self.shahtaj_payment_notes,
        }

    def _create_payment_vals_from_wizard(self, batch_result):
        vals = super()._create_payment_vals_from_wizard(batch_result)
        vals.update(self._shahtaj_payment_detail_vals())
        return vals

    def _create_payment_vals_from_batch(self, batch_result):
        vals = super()._create_payment_vals_from_batch(batch_result)
        vals.update(self._shahtaj_payment_detail_vals())
        return vals

    def action_create_payments(self):
        # Register payment posts + reconciles; portal financial users lack
        # native Accounting/Invoicing and need elevated execution after ACL check.
        if _shahtaj_needs_financial_sudo(self.env):
            self.check_access('write')
            return super(AccountPaymentRegister, self.sudo()).action_create_payments()
        return super().action_create_payments()
