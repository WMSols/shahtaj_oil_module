# -*- coding: utf-8 -*-
"""DM recovery: collect shop cash into DM wallet (DMCASH / 101410)."""
from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError
from odoo.tools import float_compare


class ShahtajDmRecoveryService(models.AbstractModel):
    _name = 'shahtaj.dm.recovery.service'
    _description = 'Delivery Man Recovery Service'

    @api.model
    def _assert_can_collect(self, delivery_man):
        user = self.env.user
        if not delivery_man or not delivery_man.shahtaj_is_delivery_man:
            raise UserError(_('Select a valid delivery man.'))
        if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
            return
        if user.has_group('shahtaj_oil.group_shahtaj_native_distributor_ui'):
            return
        if user.shahtaj_is_delivery_man and user.id == delivery_man.id:
            return
        raise AccessError(_('You can only collect payments for your own wallet.'))

    @api.model
    def _assert_can_settle(self):
        user = self.env.user
        if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
            return
        if user.has_group('shahtaj_oil.group_shahtaj_native_distributor_ui'):
            return
        if user.has_group('shahtaj_oil.group_shahtaj_distributor_financial'):
            return
        raise AccessError(_('Only distributors can settle the DM wallet to bank.'))

    @api.model
    def _dmcash_journal(self, company=None):
        company = company or self.env.company
        company.sudo()._shahtaj_ensure_dm_accounting()
        journal = self.env['account.journal'].sudo().search([
            ('company_id', '=', company.id),
            ('code', '=', 'DMCASH'),
        ], limit=1)
        if not journal:
            raise UserError(_(
                'DM Cash Collections journal (DMCASH) is missing. '
                'Upgrade the Shahtaj Oil module or run accounting setup.'
            ))
        return journal

    @api.model
    def _wallet_account(self, company=None):
        company = company or self.env.company
        company.sudo()._shahtaj_ensure_dm_accounting()
        account = self.env['account.account'].sudo().search([
            ('code', '=', '101410'),
            ('company_ids', 'in', [company.id]),
        ], limit=1)
        if not account:
            raise UserError(_('DM Wallet account 101410 is missing.'))
        return account

    @api.model
    def _open_customer_invoices(self, shop, company=None):
        """Posted customer invoices/credit notes still due for a shop."""
        company = company or self.env.company
        if not shop:
            return self.env['account.move']
        commercial = shop.commercial_partner_id
        return self.env['account.move'].sudo().search([
            ('move_type', '=', 'out_invoice'),
            ('state', '=', 'posted'),
            ('payment_state', 'in', ('not_paid', 'partial', 'in_payment')),
            ('partner_id', 'child_of', commercial.id),
            ('company_id', '=', company.id),
            ('amount_residual', '>', 0),
        ], order='invoice_date asc, id asc')

    @api.model
    def wallet_balance(self, delivery_man, company=None):
        """Cash still held by this DM (collections − settlements)."""
        company = company or self.env.company
        Payment = self.env['account.payment'].sudo()
        Settlement = self.env['shahtaj.dm.wallet.settlement'].sudo()
        journal = self._dmcash_journal(company)
        collections = Payment.search([
            ('shahtaj_is_dm_wallet_collection', '=', True),
            ('shahtaj_collected_by_dm_id', '=', delivery_man.id),
            ('journal_id', '=', journal.id),
            ('company_id', '=', company.id),
            ('state', 'in', ('paid', 'in_process')),
            ('payment_type', '=', 'inbound'),
        ])
        collected = sum(collections.mapped('amount'))
        settled = sum(Settlement.search([
            ('delivery_man_id', '=', delivery_man.id),
            ('company_id', '=', company.id),
            ('state', '=', 'posted'),
        ]).mapped('amount'))
        return collected - settled

    @api.model
    def collect_payments(
        self,
        *,
        delivery_man,
        allocations,
        notes='',
        delivery=None,
        company=None,
    ):
        """Post inbound DMCASH payments for invoice→amount pairs.

        ``allocations``: list of ``(account.move, amount)`` or dicts with
        ``invoice`` / ``invoice_id`` and ``amount``.
        Returns the created ``account.payment`` recordset.
        """
        self._assert_can_collect(delivery_man)
        company = company or self.env.company
        journal = self._dmcash_journal(company)
        currency = company.currency_id
        Payment = self.env['account.payment'].sudo()
        Register = self.env['account.payment.register'].sudo()

        pairs = []
        for row in allocations or []:
            if isinstance(row, dict):
                inv = row.get('invoice') or self.env['account.move'].browse(
                    int(row.get('invoice_id') or 0)
                )
                amount = float(row.get('amount') or 0.0)
            else:
                inv, amount = row
                amount = float(amount or 0.0)
            if not inv or not inv.exists():
                continue
            if float_compare(amount, 0.0, precision_rounding=currency.rounding) <= 0:
                continue
            pairs.append((inv, amount))

        if not pairs:
            raise UserError(_('Enter a collection amount on at least one invoice.'))

        payments = Payment
        for invoice, amount in pairs:
            invoice = invoice.sudo()
            if invoice.state != 'posted' or invoice.move_type != 'out_invoice':
                raise UserError(_(
                    'Invoice %(name)s cannot be collected.',
                    name=invoice.display_name,
                ))
            residual = abs(invoice.amount_residual)
            if float_compare(amount, residual, precision_rounding=currency.rounding) > 0:
                raise UserError(_(
                    'Amount %(amount).2f exceeds remaining %(residual).2f on %(name)s.',
                    amount=amount,
                    residual=residual,
                    name=invoice.name,
                ))

            wizard = Register.with_context(
                active_model='account.move',
                active_ids=invoice.ids,
                dont_redirect_to_payments=True,
            ).create({
                'journal_id': journal.id,
                'payment_date': fields.Date.context_today(self),
                'amount': amount,
                'communication': notes or _('DM collection — %(shop)s', shop=invoice.partner_id.display_name),
                'shahtaj_payment_channel': 'cash',
                'shahtaj_payment_notes': notes or False,
            })
            if hasattr(wizard, 'custom_user_amount'):
                wizard.custom_user_amount = amount
                wizard.custom_user_currency_id = currency.id
            created = wizard._create_payments()
            if created:
                created.sudo().write({
                    'shahtaj_is_dm_wallet_collection': True,
                    'shahtaj_collected_by_dm_id': delivery_man.id,
                    'shahtaj_dm_delivery_id': delivery.id if delivery else False,
                    'shahtaj_payment_channel': 'cash',
                    'shahtaj_payment_notes': notes or created.shahtaj_payment_notes,
                })
                payments |= created.sudo()

        if not payments:
            raise UserError(_('Payment was created but could not be linked to the DM wallet.'))

        try:
            self.env['shahtaj.activity.log'].log_business(
                operation='dm.recovery.collect',
                name=_('DM wallet collection'),
                related_record=delivery or delivery_man,
                message=_(
                    '%(dm)s collected %(amount).2f from %(count)s invoice(s)',
                    dm=delivery_man.display_name,
                    amount=sum(payments.mapped('amount')),
                    count=len(payments),
                ),
            )
        except Exception:
            pass

        return payments

    @api.model
    def settle_wallet(
        self,
        *,
        delivery_man,
        amount,
        bank_journal,
        notes='',
        company=None,
    ):
        """Move cash from DM wallet (101410) into a bank/cash journal account."""
        self._assert_can_settle()
        company = company or self.env.company
        currency = company.currency_id
        amount = float(amount or 0.0)
        if float_compare(amount, 0.0, precision_rounding=currency.rounding) <= 0:
            raise UserError(_('Settlement amount must be greater than zero.'))

        balance = self.wallet_balance(delivery_man, company)
        if float_compare(amount, balance, precision_rounding=currency.rounding) > 0:
            raise UserError(_(
                'Cannot settle %(amount).2f — wallet only holds %(balance).2f.',
                amount=amount,
                balance=balance,
            ))

        if not bank_journal or bank_journal.type not in ('bank', 'cash'):
            raise UserError(_('Select a bank or cash journal for the deposit.'))
        if bank_journal.code == 'DMCASH':
            raise UserError(_('Choose a bank journal, not the DM wallet journal.'))

        bank_account = bank_journal.default_account_id
        if not bank_account:
            raise UserError(_(
                'Journal %(name)s has no default account.',
                name=bank_journal.display_name,
            ))
        wallet_account = self._wallet_account(company)

        move = self.env['account.move'].sudo().create({
            'move_type': 'entry',
            'journal_id': bank_journal.id,
            'date': fields.Date.context_today(self),
            'ref': _('DM wallet settle — %(dm)s', dm=delivery_man.display_name),
            'company_id': company.id,
            'line_ids': [
                (0, 0, {
                    'name': _('Deposit from %(dm)s wallet', dm=delivery_man.display_name),
                    'account_id': bank_account.id,
                    'debit': amount,
                    'credit': 0.0,
                }),
                (0, 0, {
                    'name': _('Clear %(dm)s DM wallet', dm=delivery_man.display_name),
                    'account_id': wallet_account.id,
                    'debit': 0.0,
                    'credit': amount,
                }),
            ],
        })
        move.action_post()

        settlement = self.env['shahtaj.dm.wallet.settlement'].sudo().create({
            'delivery_man_id': delivery_man.id,
            'amount': amount,
            'settlement_date': fields.Date.context_today(self),
            'bank_journal_id': bank_journal.id,
            'move_id': move.id,
            'notes': notes or False,
            'settled_by_id': self.env.user.id,
            'company_id': company.id,
            'state': 'posted',
        })

        try:
            self.env['shahtaj.activity.log'].log_business(
                operation='dm.recovery.settle',
                name=_('DM wallet settlement'),
                related_record=settlement,
                message=_(
                    'Settled %(amount).2f from %(dm)s wallet to %(journal)s',
                    amount=amount,
                    dm=delivery_man.display_name,
                    journal=bank_journal.display_name,
                ),
            )
        except Exception:
            pass

        return settlement


class ShahtajDmWalletSettlement(models.Model):
    _name = 'shahtaj.dm.wallet.settlement'
    _description = 'DM Wallet Settlement'
    _order = 'settlement_date desc, id desc'

    name = fields.Char(compute='_compute_name', store=True)
    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        required=True,
        index=True,
        ondelete='restrict',
        domain="[('shahtaj_is_delivery_man', '=', True)]",
    )
    amount = fields.Monetary(string='Amount', required=True, currency_field='currency_id')
    currency_id = fields.Many2one(
        related='company_id.currency_id',
        store=True,
        readonly=True,
    )
    settlement_date = fields.Date(
        string='Date',
        required=True,
        default=fields.Date.context_today,
        index=True,
    )
    bank_journal_id = fields.Many2one(
        'account.journal',
        string='Deposit Journal',
        required=True,
        domain="[('type', 'in', ('bank', 'cash')), ('code', '!=', 'DMCASH')]",
    )
    move_id = fields.Many2one('account.move', string='Journal Entry', readonly=True)
    notes = fields.Text(string='Notes')
    settled_by_id = fields.Many2one('res.users', string='Settled By', readonly=True)
    company_id = fields.Many2one(
        'res.company',
        required=True,
        default=lambda self: self.env.company,
        index=True,
    )
    state = fields.Selection(
        [('posted', 'Posted'), ('cancelled', 'Cancelled')],
        default='posted',
        required=True,
        index=True,
    )

    @api.depends('delivery_man_id', 'settlement_date', 'amount')
    def _compute_name(self):
        for rec in self:
            dm = rec.delivery_man_id.name if rec.delivery_man_id else '—'
            day = rec.settlement_date or '—'
            rec.name = f'Settle {dm} · {day} · {rec.amount:,.2f}'
