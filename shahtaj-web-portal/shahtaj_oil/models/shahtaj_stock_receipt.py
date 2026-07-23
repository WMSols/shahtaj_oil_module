# -*- coding: utf-8 -*-
"""Immutable log of stock received from manufacturer with frozen unit cost."""
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class ShahtajStockReceipt(models.Model):
    _name = 'shahtaj.stock.receipt'
    _description = 'Manufacturer Stock Receipt'
    _order = 'receipt_date desc, id desc'

    product_id = fields.Many2one(
        'product.product',
        string='Product',
        required=True,
        ondelete='restrict',
        index=True,
    )
    product_tmpl_id = fields.Many2one(
        'product.template',
        related='product_id.product_tmpl_id',
        store=True,
        readonly=True,
    )
    receipt_date = fields.Date(
        string='Receipt Date',
        required=True,
        default=fields.Date.context_today,
        index=True,
    )
    qty = fields.Float(
        string='Quantity',
        digits='Product Unit of Measure',
        required=True,
    )
    unit_cost = fields.Monetary(
        string='Unit Cost',
        currency_field='currency_id',
        required=True,
        help='Manufacturer cost per unit at the time stock was received.',
    )
    subtotal = fields.Monetary(
        string='Purchase Value',
        currency_field='currency_id',
        compute='_compute_subtotal',
        store=True,
    )
    source = fields.Selection(
        selection=[
            ('opening', 'Opening Stock'),
            ('add_stock', 'Stock Received'),
            ('adjustment', 'Inventory Adjustment'),
            ('backfill', 'Historical Backfill'),
        ],
        string='Source',
        required=True,
        default='add_stock',
    )
    company_id = fields.Many2one(
        'res.company',
        required=True,
        default=lambda self: self.env.company,
    )
    currency_id = fields.Many2one(
        related='company_id.currency_id',
        store=True,
    )

    @api.depends('qty', 'unit_cost')
    def _compute_subtotal(self):
        for receipt in self:
            receipt.subtotal = (receipt.qty or 0.0) * (receipt.unit_cost or 0.0)

    @api.model
    def _shahtaj_active_product_domain(self):
        """Receipts for archived products are excluded from stock summaries."""
        return [
            ('product_id.active', '=', True),
            ('product_tmpl_id.active', '=', True),
        ]

    @api.model
    def shahtaj_search_period_receipts(self, date_from, date_to):
        """Period receipts for active products only (archive hides them from P&L / summary)."""
        return self.search([
            ('receipt_date', '>=', date_from),
            ('receipt_date', '<=', date_to),
            *self._shahtaj_active_product_domain(),
        ])

    @api.constrains('qty', 'unit_cost')
    def _check_positive_values(self):
        for receipt in self:
            if receipt.qty <= 0:
                raise ValidationError(_('Receipt quantity must be greater than zero.'))
            if receipt.unit_cost < 0:
                raise ValidationError(_('Unit cost cannot be negative.'))
