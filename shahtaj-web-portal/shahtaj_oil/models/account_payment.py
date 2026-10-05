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
    shahtaj_is_walk_in = fields.Boolean(
        string='Walk-in',
        related='partner_id.shahtaj_is_walk_in',
        store=True,
        index=True,
        readonly=True,
        help='Payment collected from a DM walk-in customer into the wallet.',
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
    shahtaj_cheque_image = fields.Image(
        string='Cheque Photo',
        max_width=1920,
        max_height=1920,
        copy=False,
        help='Supporting photo of the cheque (DM wallet collections).',
    )
    shahtaj_has_cheque_image = fields.Boolean(
        string='Has Cheque Photo',
        compute='_compute_shahtaj_has_cheque_image',
        store=True,
        index=True,
    )
    shahtaj_payment_notes = fields.Text(
        string='Payment Notes',
        copy=False,
        tracking=True,
    )
    shahtaj_is_dm_wallet_collection = fields.Boolean(
        string='DM Wallet Collection',
        default=False,
        copy=False,
        index=True,
        help='Cash collected by a delivery man into the DM wallet (DMCASH).',
    )
    shahtaj_collected_by_dm_id = fields.Many2one(
        'res.users',
        string='Collected By (DM)',
        copy=False,
        index=True,
        ondelete='set null',
        domain="[('shahtaj_is_delivery_man', '=', True)]",
    )
    shahtaj_dm_delivery_id = fields.Many2one(
        'shahtaj.dm.delivery',
        string='Delivery Job',
        copy=False,
        index=True,
        ondelete='set null',
    )
    # Ops-facing collection summary (Dist / KPO / Manager / DM wallet menus).
    # Hides Odoo payment-document "In Process" — shows invoice Paid / Partial instead.
    shahtaj_collection_status = fields.Selection(
        [
            ('collected', 'Collected'),
            ('not_paid', 'Not Paid'),
            ('partial', 'Partial'),
            ('in_payment', 'In Payment'),
            ('paid', 'Paid'),
            ('canceled', 'Cancelled'),
        ],
        string='Collection Status',
        compute='_compute_shahtaj_collection_invoice_info',
        help=(
            'Shop-facing status for DM wallet collections.\n'
            'Paid / Partial / Not Paid come from linked invoices.\n'
            'Collected = money in DM wallet with no invoice link yet.\n'
            'Not the same as Odoo payment State (In Process).'
        ),
    )
    shahtaj_invoice_names = fields.Char(
        string='Invoices',
        compute='_compute_shahtaj_collection_invoice_info',
        help='Invoice numbers linked to this collection.',
    )
    shahtaj_invoice_amount_total = fields.Monetary(
        string='Invoice Total',
        compute='_compute_shahtaj_collection_invoice_info',
        currency_field='currency_id',
        help='Sum of linked invoice totals.',
    )
    shahtaj_invoice_amount_residual = fields.Monetary(
        string='Invoice Remaining',
        compute='_compute_shahtaj_collection_invoice_info',
        currency_field='currency_id',
        help='Sum of linked invoice amounts still unpaid after collections.',
    )
    shahtaj_invoice_summary_html = fields.Html(
        string='Invoice Details',
        compute='_compute_shahtaj_collection_invoice_info',
        sanitize=True,
    )

    @api.depends('shahtaj_cheque_image')
    def _compute_shahtaj_has_cheque_image(self):
        for payment in self:
            payment.shahtaj_has_cheque_image = bool(payment.shahtaj_cheque_image)

    @api.depends(
        'state',
        'amount',
        'currency_id',
        'reconciled_invoice_ids',
        'reconciled_invoice_ids.name',
        'reconciled_invoice_ids.payment_state',
        'reconciled_invoice_ids.amount_total',
        'reconciled_invoice_ids.amount_residual',
        'reconciled_invoice_ids.move_type',
    )
    def _compute_shahtaj_collection_invoice_info(self):
        """Ops labels for DM wallet menus: invoice Paid/Partial + totals."""
        for pay in self:
            if pay.state == 'canceled':
                pay.shahtaj_collection_status = 'canceled'
                pay.shahtaj_invoice_names = False
                pay.shahtaj_invoice_amount_total = 0.0
                pay.shahtaj_invoice_amount_residual = 0.0
                pay.shahtaj_invoice_summary_html = (
                    '<p class="text-muted mb-0">Payment cancelled.</p>'
                )
                continue

            invoices = pay.sudo().reconciled_invoice_ids.filtered(
                lambda m: m.move_type in ('out_invoice', 'out_refund')
            )
            if not invoices:
                pay.shahtaj_collection_status = 'collected'
                pay.shahtaj_invoice_names = False
                pay.shahtaj_invoice_amount_total = 0.0
                pay.shahtaj_invoice_amount_residual = 0.0
                pay.shahtaj_invoice_summary_html = (
                    '<p class="text-muted mb-0">'
                    'No invoice linked to this collection.'
                    '</p>'
                )
                continue

            names = invoices.mapped('name')
            pay.shahtaj_invoice_names = ', '.join(n for n in names if n) or False
            pay.shahtaj_invoice_amount_total = sum(abs(i.amount_total) for i in invoices)
            pay.shahtaj_invoice_amount_residual = sum(
                abs(i.amount_residual) for i in invoices
            )

            states = set(invoices.mapped('payment_state'))
            if states <= {'paid'}:
                pay.shahtaj_collection_status = 'paid'
            elif states <= {'not_paid'}:
                pay.shahtaj_collection_status = 'not_paid'
            elif states <= {'in_payment'} or (
                'in_payment' in states and not (states & {'partial', 'not_paid', 'paid'})
            ):
                pay.shahtaj_collection_status = 'in_payment'
            else:
                # partial, or mix of paid + open → Partial for ops
                pay.shahtaj_collection_status = 'partial'

            rows = []
            for inv in invoices.sorted('id'):
                label = {
                    'not_paid': 'Not Paid',
                    'partial': 'Partial',
                    'in_payment': 'In Payment',
                    'paid': 'Paid',
                    'reversed': 'Reversed',
                }.get(inv.payment_state, inv.payment_state or '—')
                rows.append(
                    '<tr>'
                    f'<td>{inv.name or inv.display_name}</td>'
                    f'<td class="text-end">{abs(inv.amount_total):,.2f}</td>'
                    f'<td class="text-end">{abs(inv.amount_residual):,.2f}</td>'
                    f'<td>{label}</td>'
                    '</tr>'
                )
            pay.shahtaj_invoice_summary_html = (
                '<table class="table table-sm table-bordered mb-0">'
                '<thead><tr>'
                '<th>Invoice</th>'
                '<th class="text-end">Total</th>'
                '<th class="text-end">Remaining</th>'
                '<th>Status</th>'
                '</tr></thead>'
                f'<tbody>{"".join(rows)}</tbody></table>'
                f'<p class="mb-0 mt-1 text-muted">'
                f'This collection: {pay.amount:,.2f}'
                f'</p>'
            )

    @api.onchange('journal_id')
    def _onchange_shahtaj_journal_payment_details(self):
        for payment in self:
            if payment.journal_id.type == 'cash':
                payment.shahtaj_payment_channel = 'cash'
                payment.shahtaj_payer_bank_name = False
                payment.shahtaj_payer_account_number = False
                payment.shahtaj_instrument_reference = False
                payment.shahtaj_cheque_image = False
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
