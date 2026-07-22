# -*- coding: utf-8 -*-
"""Distributor profit & loss dashboard from invoiced sales vs product cost."""
from odoo import _, api, fields, models


class ShahtajPnlDashboard(models.TransientModel):
    _name = 'shahtaj.pnl.dashboard'
    _description = 'Distributor Profit & Loss Dashboard'

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

    # Shop billing
    amount_invoiced = fields.Monetary(
        string='Invoiced Sales (products)',
        currency_field='currency_id',
        help='Posted customer invoices for shops — untaxed product lines '
             '(excludes opening/legacy balance invoices).',
    )
    amount_credit_notes = fields.Monetary(
        string='Credit Notes',
        currency_field='currency_id',
        help='Posted credit notes — returns / corrections (untaxed product lines).',
    )
    amount_net_sales = fields.Monetary(
        string='Net Sales',
        currency_field='currency_id',
        help='Invoiced sales minus credit notes.',
    )
    amount_legacy_invoiced = fields.Monetary(
        string='Opening Balance Invoices',
        currency_field='currency_id',
        help='Legacy / previous shop debts invoiced (not product trading).',
    )
    amount_cogs = fields.Monetary(
        string='Cost of Goods (invoiced)',
        currency_field='currency_id',
        help='Invoiced qty × frozen cost at invoice post, net of credit-note qty.',
    )
    amount_gross_profit = fields.Monetary(
        string='Gross Profit',
        currency_field='currency_id',
        help='Net sales − cost of goods.',
    )
    amount_manufacturer_payable = fields.Monetary(
        string='Stock Purchased (period)',
        currency_field='currency_id',
        help='Stock received in the selected period at frozen receipt cost '
             '(purchase value, not cash paid to manufacturer).',
    )
    amount_payments_received = fields.Monetary(
        string='Payments Collected',
        currency_field='currency_id',
        help='Posted inbound payments from shops in the selected period.',
    )
    amount_shop_outstanding = fields.Monetary(
        string='Shop Outstanding (AR)',
        currency_field='currency_id',
        help='Total amount shops still owe (all open receivables).',
    )

    invoice_count = fields.Integer(string='Product Invoices')
    credit_note_count = fields.Integer(string='Credit Notes Count')
    legacy_invoice_count = fields.Integer(string='Opening Invoices')

    line_ids = fields.One2many(
        'shahtaj.pnl.dashboard.line',
        'dashboard_id',
        string='By Product',
    )

    @api.model
    def action_open_pnl_dashboard(self):
        record = self.create({})
        record.action_refresh()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Profit & Loss'),
            'res_model': 'shahtaj.pnl.dashboard',
            'res_id': record.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref('shahtaj_oil.view_shahtaj_pnl_dashboard_form').id,
                'form',
            )],
        }

    def action_refresh(self):
        self.ensure_one()
        self.line_ids.unlink()
        stats = self._gather_stats()
        lines_vals = [
            (0, 0, line) for line in stats.pop('lines', [])
        ]
        self.write({**stats, 'line_ids': lines_vals})
        return {
            'type': 'ir.actions.act_window',
            'name': _('Profit & Loss'),
            'res_model': 'shahtaj.pnl.dashboard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref('shahtaj_oil.view_shahtaj_pnl_dashboard_form').id,
                'form',
            )],
        }

    def _gather_stats(self):
        self.ensure_one()
        Move = self.env['account.move'].sudo()
        MoveLine = self.env['account.move.line'].sudo()
        Payment = self.env['account.payment'].sudo()
        Partner = self.env['res.partner'].sudo()

        date_from = self.date_from
        date_to = self.date_to

        shop_domain = [('partner_id.is_shahtaj_shop', '=', True)]
        invoice_domain = shop_domain + [
            ('move_type', '=', 'out_invoice'),
            ('state', '=', 'posted'),
            ('invoice_date', '>=', date_from),
            ('invoice_date', '<=', date_to),
        ]
        credit_domain = shop_domain + [
            ('move_type', '=', 'out_refund'),
            ('state', '=', 'posted'),
            ('invoice_date', '>=', date_from),
            ('invoice_date', '<=', date_to),
        ]

        product_invoices = Move.search(
            invoice_domain + [('shahtaj_is_legacy_balance', '=', False)]
        )
        legacy_invoices = Move.search(
            invoice_domain + [('shahtaj_is_legacy_balance', '=', True)]
        )
        # Also include older misc-style links? Only invoices flagged.
        credit_notes = Move.search(credit_domain)

        # Aggregate by product_id: qty, revenue (untaxed), cost
        by_product = {}

        def _add_lines(moves, sign):
            """sign +1 for invoice, -1 for credit note."""
            lines = MoveLine.search([
                ('move_id', 'in', moves.ids),
                ('display_type', '=', 'product'),
                ('product_id', '!=', False),
            ])
            for line in lines:
                product = line.product_id
                # Skip pure legacy opening product from trading P&L
                if product.default_code == 'SHAHTAJ-LEGACY':
                    continue
                data = by_product.setdefault(product.id, {
                    'product_id': product.id,
                    'qty_invoiced': 0.0,
                    'qty_credited': 0.0,
                    'amount_revenue': 0.0,
                    'amount_credit': 0.0,
                    'amount_cogs': 0.0,
                })
                qty = line.quantity
                untaxed = line.price_subtotal
                cost_unit = line.shahtaj_cost_unit or product.standard_price or 0.0
                if sign > 0:
                    data['qty_invoiced'] += qty
                    data['amount_revenue'] += untaxed
                    data['amount_cogs'] += qty * cost_unit
                else:
                    data['qty_credited'] += qty
                    data['amount_credit'] += untaxed
                    data['amount_cogs'] -= qty * cost_unit

        _add_lines(product_invoices, 1)
        _add_lines(credit_notes, -1)

        amount_invoiced = sum(d['amount_revenue'] for d in by_product.values())
        amount_credit = sum(d['amount_credit'] for d in by_product.values())
        amount_cogs = sum(d['amount_cogs'] for d in by_product.values())
        amount_net = amount_invoiced - amount_credit
        amount_profit = amount_net - amount_cogs

        amount_legacy = sum(legacy_invoices.mapped('amount_untaxed'))

        Receipt = self.env['shahtaj.stock.receipt'].sudo()
        period_receipts = Receipt.search([
            ('receipt_date', '>=', date_from),
            ('receipt_date', '<=', date_to),
        ])
        amount_mfr = sum(period_receipts.mapped('subtotal'))

        payments = Payment.search([
            ('partner_type', '=', 'customer'),
            ('state', 'in', ('paid', 'in_process')),
            ('payment_type', '=', 'inbound'),
            ('date', '>=', date_from),
            ('date', '<=', date_to),
            '|', '|',
            ('partner_id.is_shahtaj_shop', '=', True),
            ('partner_id.parent_id.is_shahtaj_shop', '=', True),
            ('partner_id.commercial_partner_id.is_shahtaj_shop', '=', True),
        ])
        amount_payments = sum(payments.mapped('amount'))

        shops = Partner.search([
            ('is_shahtaj_shop', '=', True),
            ('shop_approval_state', '=', 'approved'),
        ])
        amount_outstanding = sum(shops.mapped('credit'))

        lines = []
        for product_id, data in by_product.items():
            net_rev = data['amount_revenue'] - data['amount_credit']
            profit = net_rev - data['amount_cogs']
            lines.append({
                'product_id': product_id,
                'qty_invoiced': data['qty_invoiced'],
                'qty_credited': data['qty_credited'],
                'amount_revenue': data['amount_revenue'],
                'amount_credit': data['amount_credit'],
                'amount_net_sales': net_rev,
                'amount_cogs': data['amount_cogs'],
                'amount_profit': profit,
            })
        lines.sort(key=lambda l: l['amount_profit'], reverse=True)

        return {
            'amount_invoiced': amount_invoiced,
            'amount_credit_notes': amount_credit,
            'amount_net_sales': amount_net,
            'amount_legacy_invoiced': amount_legacy,
            'amount_cogs': amount_cogs,
            'amount_gross_profit': amount_profit,
            'amount_manufacturer_payable': amount_mfr,
            'amount_payments_received': amount_payments,
            'amount_shop_outstanding': amount_outstanding,
            'invoice_count': len(product_invoices),
            'credit_note_count': len(credit_notes),
            'legacy_invoice_count': len(legacy_invoices),
            'lines': lines,
        }

    def action_open_product_invoices(self):
        return {
            'type': 'ir.actions.act_window',
            'name': _('Product Invoices'),
            'res_model': 'account.move',
            'view_mode': 'list,form',
            'domain': [
                ('move_type', '=', 'out_invoice'),
                ('state', '=', 'posted'),
                ('partner_id.is_shahtaj_shop', '=', True),
                ('shahtaj_is_legacy_balance', '=', False),
                ('invoice_date', '>=', self.date_from),
                ('invoice_date', '<=', self.date_to),
            ],
        }

    def action_open_credit_notes(self):
        return {
            'type': 'ir.actions.act_window',
            'name': _('Credit Notes'),
            'res_model': 'account.move',
            'view_mode': 'list,form',
            'domain': [
                ('move_type', '=', 'out_refund'),
                ('state', '=', 'posted'),
                ('partner_id.is_shahtaj_shop', '=', True),
                ('invoice_date', '>=', self.date_from),
                ('invoice_date', '<=', self.date_to),
            ],
        }

    def action_open_legacy_invoices(self):
        return {
            'type': 'ir.actions.act_window',
            'name': _('Opening Balance Invoices'),
            'res_model': 'account.move',
            'view_mode': 'list,form',
            'domain': [
                ('move_type', '=', 'out_invoice'),
                ('partner_id.is_shahtaj_shop', '=', True),
                ('shahtaj_is_legacy_balance', '=', True),
            ],
            'context': {'default_move_type': 'out_invoice'},
        }

    def action_open_manufacturer_summary(self):
        summary = self.env['shahtaj.manufacturer.summary'].create({
            'date_from': self.date_from,
            'date_to': self.date_to,
        })
        return summary.action_refresh()


class ShahtajPnlDashboardLine(models.TransientModel):
    _name = 'shahtaj.pnl.dashboard.line'
    _description = 'P&L Dashboard Product Line'
    _order = 'amount_profit desc'

    dashboard_id = fields.Many2one(
        'shahtaj.pnl.dashboard',
        required=True,
        ondelete='cascade',
    )
    currency_id = fields.Many2one(
        related='dashboard_id.currency_id',
    )
    product_id = fields.Many2one('product.product', string='Product', required=True)
    qty_invoiced = fields.Float(string='Qty Invoiced', digits='Product Unit of Measure')
    qty_credited = fields.Float(string='Qty Credited', digits='Product Unit of Measure')
    amount_revenue = fields.Monetary(string='Sales', currency_field='currency_id')
    amount_credit = fields.Monetary(string='Credits', currency_field='currency_id')
    amount_net_sales = fields.Monetary(string='Net Sales', currency_field='currency_id')
    amount_cogs = fields.Monetary(string='Cost', currency_field='currency_id')
    amount_profit = fields.Monetary(string='Profit', currency_field='currency_id')
