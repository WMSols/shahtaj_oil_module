# -*- coding: utf-8 -*-
"""Distributor tax ledger: tax types, collected totals, and posted tax history."""
from odoo import _, api, fields, models


class ShahtajTaxLedger(models.TransientModel):
    _name = 'shahtaj.tax.ledger'
    _description = 'Sales Tax Ledger'

    currency_id = fields.Many2one(
        'res.currency',
        default=lambda self: self.env.company.currency_id,
        required=True,
    )
    date_from = fields.Date(
        string='From',
        required=True,
        default=lambda self: fields.Date.context_today(self).replace(day=1),
    )
    date_to = fields.Date(
        string='To',
        required=True,
        default=lambda self: fields.Date.context_today(self),
    )

    amount_tax_invoiced = fields.Monetary(
        string='Tax on Invoices',
        currency_field='currency_id',
        help='Sales tax posted on customer invoices in the period.',
    )
    amount_tax_credited = fields.Monetary(
        string='Tax on Credit Notes',
        currency_field='currency_id',
        help='Sales tax reversed by posted credit notes in the period.',
    )
    amount_tax_net = fields.Monetary(
        string='Net Tax Collected',
        currency_field='currency_id',
        help='Tax on invoices minus tax on credit notes (net tax given / collected).',
    )
    invoice_tax_line_count = fields.Integer(string='Invoice Tax Lines')
    credit_tax_line_count = fields.Integer(string='Credit Note Tax Lines')
    tax_type_count = fields.Integer(string='Tax Types Used')

    summary_ids = fields.One2many(
        'shahtaj.tax.ledger.summary',
        'ledger_id',
        string='By Tax Type',
    )
    history_ids = fields.One2many(
        'shahtaj.tax.ledger.history',
        'ledger_id',
        string='Tax History',
    )

    @api.model
    def action_open_tax_ledger(self):
        record = self.create({})
        record.action_refresh()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Tax Ledger'),
            'res_model': 'shahtaj.tax.ledger',
            'res_id': record.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref('shahtaj_oil.view_shahtaj_tax_ledger_form').id,
                'form',
            )],
        }

    def action_refresh(self):
        self.ensure_one()
        self.summary_ids.unlink()
        self.history_ids.unlink()
        stats = self._gather_stats()
        summary_vals = [(0, 0, row) for row in stats.pop('summaries', [])]
        history_vals = [(0, 0, row) for row in stats.pop('history', [])]
        self.write({
            **stats,
            'summary_ids': summary_vals,
            'history_ids': history_vals,
        })
        return {
            'type': 'ir.actions.act_window',
            'name': _('Tax Ledger'),
            'res_model': 'shahtaj.tax.ledger',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref('shahtaj_oil.view_shahtaj_tax_ledger_form').id,
                'form',
            )],
        }

    def _tax_line_domain(self):
        """Posted shop customer invoice / credit-note tax journal items."""
        self.ensure_one()
        return [
            ('tax_line_id', '!=', False),
            ('parent_state', '=', 'posted'),
            ('move_id.move_type', 'in', ('out_invoice', 'out_refund')),
            ('move_id.partner_id.is_shahtaj_shop', '=', True),
            ('move_id.shahtaj_is_legacy_balance', '=', False),
            ('move_id.invoice_date', '>=', self.date_from),
            ('move_id.invoice_date', '<=', self.date_to),
            ('company_id', '=', self.env.company.id),
        ]

    def _gather_stats(self):
        self.ensure_one()
        MoveLine = self.env['account.move.line'].sudo()
        lines = MoveLine.search(
            self._tax_line_domain(),
            order='date desc, move_id desc, id desc',
        )

        by_tax = {}
        history = []
        amount_invoiced = 0.0
        amount_credited = 0.0
        invoice_count = 0
        credit_count = 0

        for line in lines:
            move = line.move_id
            tax = line.tax_line_id
            # Accounting: tax payable on invoices is typically credit (balance < 0).
            # Net tax collected = -balance for invoices and refunds.
            signed = -line.balance
            base = abs(line.tax_base_amount or 0.0)
            is_invoice = move.move_type == 'out_invoice'
            if is_invoice:
                collected = signed
                credited = 0.0
                amount_invoiced += signed
                invoice_count += 1
                doc_label = _('Invoice')
            else:
                # Credit note: signed is usually negative → tax returned.
                collected = 0.0
                credited = -signed
                amount_credited += -signed
                credit_count += 1
                doc_label = _('Credit Note')

            tax_key = tax.id
            data = by_tax.setdefault(tax_key, {
                'tax_id': tax.id,
                'tax_name': tax.display_name,
                'tax_amount': tax.amount,
                'amount_type': tax.amount_type,
                'base_invoiced': 0.0,
                'base_credited': 0.0,
                'tax_invoiced': 0.0,
                'tax_credited': 0.0,
                'line_count': 0,
            })
            data['line_count'] += 1
            if is_invoice:
                data['base_invoiced'] += base
                data['tax_invoiced'] += collected
            else:
                data['base_credited'] += base
                data['tax_credited'] += credited

            history.append({
                'date': move.invoice_date or line.date,
                'move_id': move.id,
                'move_name': move.name or move.display_name,
                'partner_id': move.partner_id.id,
                'tax_id': tax.id,
                'document_type': doc_label,
                'base_amount': base,
                'tax_amount': collected if is_invoice else -credited,
                'tax_amount_abs': collected if is_invoice else credited,
            })

        summaries = []
        for data in sorted(by_tax.values(), key=lambda d: d['tax_name'].lower()):
            summaries.append({
                'tax_id': data['tax_id'],
                'tax_name': data['tax_name'],
                'tax_rate': data['tax_amount'],
                'amount_type': data['amount_type'],
                'base_invoiced': data['base_invoiced'],
                'base_credited': data['base_credited'],
                'tax_invoiced': data['tax_invoiced'],
                'tax_credited': data['tax_credited'],
                'tax_net': data['tax_invoiced'] - data['tax_credited'],
                'line_count': data['line_count'],
            })

        return {
            'amount_tax_invoiced': amount_invoiced,
            'amount_tax_credited': amount_credited,
            'amount_tax_net': amount_invoiced - amount_credited,
            'invoice_tax_line_count': invoice_count,
            'credit_tax_line_count': credit_count,
            'tax_type_count': len(summaries),
            'summaries': summaries,
            'history': history,
        }

    def action_open_sale_taxes(self):
        """Open existing Sales Taxes list to create / edit tax definitions."""
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_sale_taxes',
        )

    def action_open_taxed_invoices(self):
        MoveLine = self.env['account.move.line'].sudo()
        lines = MoveLine.search(self._tax_line_domain())
        move_ids = lines.mapped('move_id').ids
        action = self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_customer_invoices',
        )
        action = dict(action)
        action['domain'] = [('id', 'in', move_ids)]
        action['name'] = _('Taxed Invoices & Credit Notes')
        return action


class ShahtajTaxLedgerSummary(models.TransientModel):
    _name = 'shahtaj.tax.ledger.summary'
    _description = 'Tax Ledger Summary Line'
    _order = 'tax_name'

    ledger_id = fields.Many2one(
        'shahtaj.tax.ledger',
        required=True,
        ondelete='cascade',
    )
    currency_id = fields.Many2one(
        related='ledger_id.currency_id',
    )
    tax_id = fields.Many2one('account.tax', string='Tax', readonly=True)
    tax_name = fields.Char(string='Tax Type', readonly=True)
    tax_rate = fields.Float(string='Rate', readonly=True)
    amount_type = fields.Selection(
        related='tax_id.amount_type',
        string='Rate Type',
        readonly=True,
    )
    base_invoiced = fields.Monetary(string='Taxable (Invoices)', currency_field='currency_id', readonly=True)
    base_credited = fields.Monetary(string='Taxable (Credit Notes)', currency_field='currency_id', readonly=True)
    tax_invoiced = fields.Monetary(string='Tax Invoiced', currency_field='currency_id', readonly=True)
    tax_credited = fields.Monetary(string='Tax Credited', currency_field='currency_id', readonly=True)
    tax_net = fields.Monetary(string='Net Tax', currency_field='currency_id', readonly=True)
    line_count = fields.Integer(string='Entries', readonly=True)


class ShahtajTaxLedgerHistory(models.TransientModel):
    _name = 'shahtaj.tax.ledger.history'
    _description = 'Tax Ledger History Line'
    _order = 'date desc, id desc'

    ledger_id = fields.Many2one(
        'shahtaj.tax.ledger',
        required=True,
        ondelete='cascade',
    )
    currency_id = fields.Many2one(
        related='ledger_id.currency_id',
    )
    date = fields.Date(string='Date', readonly=True)
    move_id = fields.Many2one('account.move', string='Document', readonly=True)
    move_name = fields.Char(string='Number', readonly=True)
    partner_id = fields.Many2one('res.partner', string='Shop', readonly=True)
    tax_id = fields.Many2one('account.tax', string='Tax', readonly=True)
    document_type = fields.Char(string='Type', readonly=True)
    base_amount = fields.Monetary(string='Taxable Base', currency_field='currency_id', readonly=True)
    tax_amount = fields.Monetary(
        string='Tax Signed',
        currency_field='currency_id',
        readonly=True,
        help='Positive = collected on invoice; negative = reversed on credit note.',
    )
    tax_amount_abs = fields.Monetary(
        string='Tax Amount',
        currency_field='currency_id',
        readonly=True,
    )
