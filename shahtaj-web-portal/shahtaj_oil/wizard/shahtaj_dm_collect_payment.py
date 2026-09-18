# -*- coding: utf-8 -*-
"""Native wizards: collect shop payment into DM wallet + settle wallet to bank."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare


class ShahtajDmCollectPayment(models.TransientModel):
    _name = 'shahtaj.dm.collect.payment'
    _description = 'Collect Shop Payment into DM Wallet'

    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        required=True,
        domain="[('shahtaj_is_delivery_man', '=', True)]",
    )
    partner_id = fields.Many2one(
        'res.partner',
        string='Shop',
        required=True,
        domain="[('is_shahtaj_shop', '=', True), ('shop_approval_state', '=', 'approved')]",
    )
    delivery_id = fields.Many2one('shahtaj.dm.delivery', string='Delivery Job')
    currency_id = fields.Many2one(
        'res.currency',
        default=lambda self: self.env.company.currency_id,
        required=True,
    )
    shop_outstanding = fields.Monetary(
        string='Shop Outstanding',
        currency_field='currency_id',
        readonly=True,
    )
    wallet_balance = fields.Monetary(
        string='My Wallet (before)',
        currency_field='currency_id',
        readonly=True,
    )
    amount_total = fields.Monetary(
        string='Collect Total',
        compute='_compute_amount_total',
        currency_field='currency_id',
    )
    notes = fields.Text(string='Notes')
    payment_method = fields.Selection(
        [
            ('cash', 'Cash'),
            ('cheque', 'Cheque'),
        ],
        string='Payment Method',
        default='cash',
        required=True,
        help='Supporting detail only — both methods still post into the DM wallet.',
    )
    cheque_number = fields.Char(
        string='Cheque Number',
        help='Required when payment method is Cheque.',
    )
    cheque_image = fields.Image(
        string='Cheque Photo',
        max_width=1920,
        max_height=1920,
        help='Required when payment method is Cheque.',
    )
    line_ids = fields.One2many(
        'shahtaj.dm.collect.payment.line',
        'wizard_id',
        string='Invoices',
    )
    paid_line_ids = fields.One2many(
        'shahtaj.dm.collect.payment.paid.line',
        'wizard_id',
        string='Recently Paid',
        readonly=True,
    )

    @api.onchange('payment_method')
    def _onchange_payment_method(self):
        if self.payment_method == 'cash':
            self.cheque_number = False
            self.cheque_image = False

    def _paid_line_commands_for_partner(self, partner):
        """Build readonly paid-history lines (last 10) for the collect wizard."""
        if not partner:
            return [(5, 0, 0)]
        Service = self.env['shahtaj.dm.recovery.service']
        paid = Service._paid_customer_invoices(partner, limit=10)
        rows = Service._paid_invoice_rows(paid)
        commands = [(5, 0, 0)]
        for row in rows:
            parts = []
            for pay in row.get('payments') or []:
                who = pay.get('collected_by_dm_name') or _('Office / other')
                method = pay.get('payment_method') or '—'
                date = pay.get('payment_date') or '—'
                amount = float(pay.get('amount') or 0.0)
                cheque = pay.get('cheque_number') or ''
                bit = f'{who} · {method} · {date} · {amount:.2f}'
                if cheque:
                    bit = f'{bit} · #{cheque}'
                parts.append(bit)
            commands.append((0, 0, {
                'move_id': row['invoice_id'],
                'invoice_name': row.get('name') or '',
                'invoice_date': row.get('invoice_date') or False,
                'paid_date': row.get('paid_date') or False,
                'amount_total': row.get('amount_total') or 0.0,
                'payment_info': '\n'.join(parts) if parts else _('No payment details'),
            }))
        return commands


    @api.depends('line_ids.amount')
    def _compute_amount_total(self):
        for wiz in self:
            wiz.amount_total = sum(wiz.line_ids.mapped('amount'))

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        user = self.env.user
        ctx = self.env.context
        Service = self.env['shahtaj.dm.recovery.service']

        delivery = False
        if ctx.get('default_delivery_id'):
            delivery = self.env['shahtaj.dm.delivery'].browse(ctx['default_delivery_id'])
        elif ctx.get('active_model') == 'shahtaj.dm.delivery' and ctx.get('active_id'):
            delivery = self.env['shahtaj.dm.delivery'].browse(ctx['active_id'])

        if delivery and delivery.exists():
            res['delivery_id'] = delivery.id
            res['partner_id'] = delivery.partner_id.id
            res['delivery_man_id'] = delivery.delivery_man_id.id
        else:
            if user.shahtaj_is_delivery_man and not user.has_group(
                'shahtaj_oil.group_shahtaj_distributor'
            ):
                res['delivery_man_id'] = user.id
            if ctx.get('default_partner_id'):
                res['partner_id'] = ctx['default_partner_id']
            if ctx.get('default_delivery_man_id'):
                res['delivery_man_id'] = ctx['default_delivery_man_id']

        dm_id = res.get('delivery_man_id')
        partner_id = res.get('partner_id')
        if dm_id:
            dm = self.env['res.users'].browse(dm_id)
            res['wallet_balance'] = Service.wallet_balance(dm)
        if partner_id:
            partner = self.env['res.partner'].browse(partner_id)
            res['shop_outstanding'] = partner.sudo().credit or 0.0
            res['line_ids'] = [
                (0, 0, {
                    'move_id': inv.id,
                    'amount_residual': abs(inv.amount_residual),
                    'amount': 0.0,
                })
                for inv in Service._open_customer_invoices(partner)
            ]
            res['paid_line_ids'] = self._paid_line_commands_for_partner(partner)
        return res

    @api.onchange('partner_id')
    def _onchange_partner_id(self):
        Service = self.env['shahtaj.dm.recovery.service']
        self.line_ids = [(5, 0, 0)]
        self.paid_line_ids = [(5, 0, 0)]
        if not self.partner_id:
            self.shop_outstanding = 0.0
            return
        self.shop_outstanding = self.partner_id.sudo().credit or 0.0
        lines = []
        for inv in Service._open_customer_invoices(self.partner_id):
            lines.append((0, 0, {
                'move_id': inv.id,
                'amount_residual': abs(inv.amount_residual),
                'amount': 0.0,
            }))
        self.line_ids = lines
        self.paid_line_ids = self._paid_line_commands_for_partner(self.partner_id)

    @api.onchange('delivery_man_id')
    def _onchange_delivery_man_id(self):
        if self.delivery_man_id:
            self.wallet_balance = self.env['shahtaj.dm.recovery.service'].wallet_balance(
                self.delivery_man_id,
            )
        else:
            self.wallet_balance = 0.0

    def action_fill_full_residuals(self):
        """Set Collect Now = remaining on each line (stay on same wizard)."""
        self.ensure_one()
        for line in self.line_ids:
            if line.move_id:
                line.amount = line.amount_residual or abs(line.move_id.amount_residual)
        return True

    def action_confirm(self):
        self.ensure_one()
        # Drop any blank lines the UI may have staged without an invoice.
        bad_lines = self.line_ids.filtered(lambda l: not l.move_id)
        if bad_lines:
            bad_lines.unlink()
        Service = self.env['shahtaj.dm.recovery.service']
        allocations = [
            {'invoice': line.move_id, 'amount': line.amount}
            for line in self.line_ids
            if line.move_id and float_compare(
                line.amount, 0.0,
                precision_rounding=self.currency_id.rounding,
            ) > 0
        ]
        if not allocations:
            raise UserError(_('Enter a collection amount on at least one invoice.'))
        payments = Service.collect_payments(
            delivery_man=self.delivery_man_id,
            allocations=allocations,
            notes=self.notes or '',
            delivery=self.delivery_id,
            payment_method=self.payment_method or 'cash',
            cheque_number=self.cheque_number,
            cheque_image=self.cheque_image,
        )
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Collected to DM Wallet'),
                'message': _(
                    'Recorded %(amount).2f (%(method)s) into %(dm)s wallet (%(count)s payment(s)).',
                    amount=sum(payments.mapped('amount')),
                    method=dict(self._fields['payment_method'].selection).get(
                        self.payment_method, self.payment_method,
                    ),
                    dm=self.delivery_man_id.display_name,
                    count=len(payments),
                ),
                'type': 'success',
                'sticky': False,
                'next': {'type': 'ir.actions.act_window_close'},
            },
        }


class ShahtajDmCollectPaymentLine(models.TransientModel):
    _name = 'shahtaj.dm.collect.payment.line'
    _description = 'DM Collect Payment Line'

    wizard_id = fields.Many2one(
        'shahtaj.dm.collect.payment',
        required=True,
        ondelete='cascade',
    )
    move_id = fields.Many2one(
        'account.move',
        string='Invoice',
        required=True,
        # Not readonly on the field: Odoo web omits readonly values on save.
        # View keeps it readonly with force_save="1".
    )
    invoice_date = fields.Date(related='move_id.invoice_date', readonly=True)
    payment_state = fields.Selection(related='move_id.payment_state', readonly=True)
    currency_id = fields.Many2one(related='wizard_id.currency_id', readonly=True)
    amount_residual = fields.Monetary(
        string='Remaining',
        currency_field='currency_id',
    )
    amount = fields.Monetary(
        string='Collect Now',
        currency_field='currency_id',
    )


class ShahtajDmCollectPaymentPaidLine(models.TransientModel):
    _name = 'shahtaj.dm.collect.payment.paid.line'
    _description = 'DM Collect Payment — Recently Paid Invoice'

    wizard_id = fields.Many2one(
        'shahtaj.dm.collect.payment',
        required=True,
        ondelete='cascade',
    )
    move_id = fields.Many2one('account.move', string='Invoice', readonly=True)
    invoice_name = fields.Char(string='Number', readonly=True)
    invoice_date = fields.Date(string='Invoice Date', readonly=True)
    paid_date = fields.Date(string='Paid Date', readonly=True)
    currency_id = fields.Many2one(related='wizard_id.currency_id', readonly=True)
    amount_total = fields.Monetary(
        string='Total',
        currency_field='currency_id',
        readonly=True,
    )
    payment_info = fields.Text(
        string='Collected By / Method',
        readonly=True,
        help='Who collected, payment method, date, and amount.',
    )


class ShahtajDmWalletSettle(models.TransientModel):
    _name = 'shahtaj.dm.wallet.settle'
    _description = 'Settle DM Wallet to Bank'

    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        required=True,
        domain="[('shahtaj_is_delivery_man', '=', True)]",
    )
    currency_id = fields.Many2one(
        'res.currency',
        default=lambda self: self.env.company.currency_id,
        required=True,
    )
    wallet_balance = fields.Monetary(
        string='Wallet Balance',
        currency_field='currency_id',
        readonly=True,
    )
    amount = fields.Monetary(
        string='Settle Amount',
        currency_field='currency_id',
        required=True,
    )
    bank_journal_id = fields.Many2one(
        'account.journal',
        string='Deposit To',
        required=True,
        domain="[('type', 'in', ('bank', 'cash')), ('code', '!=', 'DMCASH')]",
    )
    notes = fields.Text(string='Notes')

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        ctx = self.env.context
        dm_id = ctx.get('default_delivery_man_id') or ctx.get('active_id')
        if ctx.get('active_model') == 'res.users' and ctx.get('active_id'):
            dm_id = ctx['active_id']
        if dm_id:
            dm = self.env['res.users'].browse(dm_id)
            if dm.shahtaj_is_delivery_man:
                res['delivery_man_id'] = dm.id
                balance = self.env['shahtaj.dm.recovery.service'].wallet_balance(dm)
                res['wallet_balance'] = balance
                res['amount'] = balance
        bank = self.env['account.journal'].search([
            ('company_id', '=', self.env.company.id),
            ('type', '=', 'bank'),
        ], limit=1)
        if bank:
            res['bank_journal_id'] = bank.id
        return res

    @api.onchange('delivery_man_id')
    def _onchange_delivery_man_id(self):
        if self.delivery_man_id:
            bal = self.env['shahtaj.dm.recovery.service'].wallet_balance(
                self.delivery_man_id,
            )
            self.wallet_balance = bal
            self.amount = bal
        else:
            self.wallet_balance = 0.0
            self.amount = 0.0

    def action_confirm(self):
        self.ensure_one()
        settlement = self.env['shahtaj.dm.recovery.service'].settle_wallet(
            delivery_man=self.delivery_man_id,
            amount=self.amount,
            bank_journal=self.bank_journal_id,
            notes=self.notes or '',
        )
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Wallet Settled'),
                'message': _(
                    'Deposited %(amount).2f from %(dm)s wallet.',
                    amount=settlement.amount,
                    dm=self.delivery_man_id.display_name,
                ),
                'type': 'success',
                'sticky': False,
                'next': {'type': 'ir.actions.act_window_close'},
            },
        }
