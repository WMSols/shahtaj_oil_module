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
    def _collection_domain(self, delivery_man, company=None, extra=None):
        company = company or self.env.company
        journal = self._dmcash_journal(company)
        domain = [
            ('shahtaj_is_dm_wallet_collection', '=', True),
            ('shahtaj_collected_by_dm_id', '=', delivery_man.id),
            ('journal_id', '=', journal.id),
            ('company_id', '=', company.id),
            ('state', 'in', ('paid', 'in_process')),
            ('payment_type', '=', 'inbound'),
        ]
        if extra:
            domain.extend(extra)
        return domain

    @api.model
    def _sum_amount(self, model_name, domain, field='amount'):
        rows = self.env[model_name].sudo().read_group(domain, [f'{field}:sum'], [])
        if not rows:
            return 0.0
        return float(rows[0].get(f'{field}') or 0.0)

    @api.model
    def wallet_balance(self, delivery_man, company=None):
        """Cash still held by this DM (collections − settlements)."""
        company = company or self.env.company
        collected = self._sum_amount(
            'account.payment',
            self._collection_domain(delivery_man, company),
        )
        settled = self._sum_amount(
            'shahtaj.dm.wallet.settlement',
            [
                ('delivery_man_id', '=', delivery_man.id),
                ('company_id', '=', company.id),
                ('state', '=', 'posted'),
            ],
        )
        return collected - settled

    @api.model
    def wallet_summary(self, delivery_man, company=None):
        """Balance + collected today + lifetime collected/settled (one-pass aggregates)."""
        company = company or self.env.company
        today = fields.Date.context_today(self)
        collected_total = self._sum_amount(
            'account.payment',
            self._collection_domain(delivery_man, company),
        )
        collected_today = self._sum_amount(
            'account.payment',
            self._collection_domain(delivery_man, company, extra=[
                ('date', '=', today),
            ]),
        )
        settled_total = self._sum_amount(
            'shahtaj.dm.wallet.settlement',
            [
                ('delivery_man_id', '=', delivery_man.id),
                ('company_id', '=', company.id),
                ('state', '=', 'posted'),
            ],
        )
        balance = collected_total - settled_total
        return {
            'delivery_man_id': delivery_man.id,
            'currency': company.currency_id.name,
            'balance': balance,
            'collected_today': collected_today,
            'collected_total': collected_total,
            'settled_total': settled_total,
            'as_of': str(today),
        }

    @api.model
    def shop_recovery_payload(self, shop, delivery_man=None, company=None):
        """Open invoices + outstanding for Recovery screen (no check-in required)."""
        company = company or self.env.company
        if not shop or not shop.exists():
            raise UserError(_('Shop not found.'))
        if not shop.is_shahtaj_shop:
            raise UserError(_('Recovery is only available for Shahtaj shops.'))

        invoices = self._open_customer_invoices(shop, company)
        invoice_rows = [{
            'invoice_id': inv.id,
            'name': inv.name,
            'invoice_date': str(inv.invoice_date) if inv.invoice_date else False,
            'amount_total': inv.amount_total,
            'amount_residual': abs(inv.amount_residual),
            'payment_state': inv.payment_state,
            'is_legacy_balance': bool(getattr(inv, 'shahtaj_is_legacy_balance', False)),
        } for inv in invoices]
        outstanding = sum(row['amount_residual'] for row in invoice_rows)

        snap = {}
        if hasattr(shop, '_shahtaj_get_credit_snapshot'):
            snap = shop._shahtaj_get_credit_snapshot()

        payload = {
            'shop_id': shop.id,
            'shop_name': shop.display_name,
            'shop_category': shop.shahtaj_shop_category or False,
            'outstanding': outstanding,
            'posted_receivable': float(snap.get('posted_outstanding', shop.sudo().credit or 0.0)),
            'effective_outstanding': float(snap.get('effective_outstanding', outstanding)),
            'credit_limit': float(snap.get('credit_limit', shop.credit_limit or 0.0)),
            'credit_remaining': float(snap.get('credit_remaining', 0.0)),
            'invoices': invoice_rows,
            'invoice_count': len(invoice_rows),
        }
        if delivery_man:
            payload['wallet_balance'] = self.wallet_balance(delivery_man, company)
        return payload

    @api.model
    def list_collections(
        self,
        delivery_man,
        date_from=None,
        date_to=None,
        limit=50,
        company=None,
    ):
        """DM wallet collection history for Flutter wallet screen."""
        company = company or self.env.company
        limit = max(1, min(int(limit or 50), 200))
        extra = []
        if date_from:
            extra.append(('date', '>=', date_from))
        if date_to:
            extra.append(('date', '<=', date_to))
        payments = self.env['account.payment'].sudo().search(
            self._collection_domain(delivery_man, company, extra=extra),
            order='date desc, id desc',
            limit=limit,
        )
        rows = []
        for pay in payments:
            invoice_names = pay.reconciled_invoice_ids.mapped('name')
            channel = pay.shahtaj_payment_channel or 'cash'
            rows.append({
                'payment_id': pay.id,
                'name': pay.name,
                'date': str(pay.date) if pay.date else False,
                'amount': pay.amount,
                'shop_id': pay.partner_id.id if pay.partner_id else False,
                'shop_name': pay.partner_id.display_name if pay.partner_id else '',
                'invoices': invoice_names,
                'notes': pay.shahtaj_payment_notes or '',
                'payment_method': channel,
                'cheque_number': (
                    pay.shahtaj_instrument_reference or ''
                ) if channel == 'cheque' else '',
                'has_cheque_image': bool(pay.shahtaj_has_cheque_image),
            })
        return {
            'collections': rows,
            'count': len(rows),
            'wallet_balance': self.wallet_balance(delivery_man, company),
        }

    @api.model
    def _prepare_collection_method_vals(
        self,
        payment_method='cash',
        cheque_number=None,
        cheque_image=None,
    ):
        """Validate + normalize supporting payment-method vals (cash/cheque).

        Accounting journal stays DMCASH; method is metadata for audit / app.
        """
        method = (payment_method or 'cash').strip().lower()
        if method not in ('cash', 'cheque'):
            raise UserError(_(
                'payment_method must be "cash" or "cheque".'
            ))
        if method == 'cash':
            return {
                'shahtaj_payment_channel': 'cash',
                'shahtaj_instrument_reference': False,
                'shahtaj_cheque_image': False,
            }

        number = (cheque_number or '').strip()
        if not number:
            raise UserError(_('Cheque number is required for cheque collections.'))
        if not cheque_image:
            raise UserError(_('Cheque photo is required for cheque collections.'))
        from odoo.addons.shahtaj_oil.api.image_utils import normalize_image_b64
        image = normalize_image_b64(cheque_image) if isinstance(
            cheque_image, str
        ) else cheque_image
        if not image:
            raise UserError(_('Cheque photo is required for cheque collections.'))
        return {
            'shahtaj_payment_channel': 'cheque',
            'shahtaj_instrument_reference': number,
            'shahtaj_cheque_image': image,
        }

    @api.model
    def collect_payments(
        self,
        *,
        delivery_man,
        allocations,
        notes='',
        delivery=None,
        company=None,
        payment_method='cash',
        cheque_number=None,
        cheque_image=None,
    ):
        """Post inbound DMCASH payments for invoice→amount pairs.

        ``allocations``: list of ``(account.move, amount)`` or dicts with
        ``invoice`` / ``invoice_id`` and ``amount``.
        ``payment_method``: ``cash`` (default) or ``cheque`` (requires number + photo).
        Returns the created ``account.payment`` recordset.
        """
        self._assert_can_collect(delivery_man)
        company = company or self.env.company
        journal = self._dmcash_journal(company)
        currency = company.currency_id
        Payment = self.env['account.payment'].sudo()
        Register = self.env['account.payment.register'].sudo()
        method_vals = self._prepare_collection_method_vals(
            payment_method=payment_method,
            cheque_number=cheque_number,
            cheque_image=cheque_image,
        )

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
                'shahtaj_payment_channel': method_vals['shahtaj_payment_channel'],
                'shahtaj_instrument_reference': method_vals.get('shahtaj_instrument_reference') or False,
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
                    'shahtaj_payment_channel': method_vals['shahtaj_payment_channel'],
                    'shahtaj_instrument_reference': method_vals.get('shahtaj_instrument_reference') or False,
                    'shahtaj_cheque_image': method_vals.get('shahtaj_cheque_image') or False,
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
                    '%(dm)s collected %(amount).2f (%(method)s) from %(count)s invoice(s)',
                    dm=delivery_man.display_name,
                    amount=sum(payments.mapped('amount')),
                    method=method_vals['shahtaj_payment_channel'],
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
