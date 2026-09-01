# -*- coding: utf-8 -*-
"""Distributor wizard to reject a field sales order with a reason."""
from odoo import _, fields, models
from odoo.exceptions import UserError


class ShahtajOrderRejectWizard(models.TransientModel):
    _name = 'shahtaj.order.reject.wizard'
    _description = 'Reject Order Wizard'

    sale_order_id = fields.Many2one(
        'sale.order',
        string='Order',
        required=True,
        readonly=True,
    )
    partner_id = fields.Many2one(
        'res.partner',
        string='Shop',
        related='sale_order_id.partner_id',
        readonly=True,
    )
    order_booker_id = fields.Many2one(
        'res.users',
        string='Order Booker',
        related='sale_order_id.shahtaj_order_booker_id',
        readonly=True,
    )
    catalog_amount = fields.Monetary(
        string='Catalog Total',
        related='sale_order_id.shahtaj_catalog_amount_total',
        currency_field='currency_id',
        readonly=True,
    )
    discount_amount = fields.Monetary(
        string='Discount Requested',
        related='sale_order_id.shahtaj_total_discount_amount',
        currency_field='currency_id',
        readonly=True,
    )
    discount_reasons = fields.Char(
        string='Discount Reasons',
        related='sale_order_id.shahtaj_discount_reasons',
        readonly=True,
    )
    amount_total = fields.Monetary(
        string='Net Order Total',
        related='sale_order_id.amount_total',
        currency_field='currency_id',
        readonly=True,
    )
    currency_id = fields.Many2one(
        'res.currency',
        related='sale_order_id.currency_id',
    )
    shop_category = fields.Selection(
        related='sale_order_id.shahtaj_shop_category',
        string='Shop Category',
        readonly=True,
    )
    shop_outstanding = fields.Monetary(
        related='sale_order_id.shahtaj_shop_outstanding',
        string='Shop Outstanding',
        currency_field='currency_id',
        readonly=True,
    )
    shop_credit_remaining = fields.Monetary(
        related='sale_order_id.shahtaj_shop_credit_remaining',
        string='Credit Remaining',
        currency_field='currency_id',
        readonly=True,
    )
    shop_lifetime_sales = fields.Monetary(
        related='sale_order_id.shahtaj_shop_lifetime_sales',
        string='Lifetime Sales',
        currency_field='currency_id',
        readonly=True,
    )
    shop_past_discount_total = fields.Monetary(
        related='sale_order_id.shahtaj_shop_past_discount_total',
        string='Past Discounts Total',
        currency_field='currency_id',
        readonly=True,
    )
    shop_past_discount_count = fields.Integer(
        related='sale_order_id.shahtaj_shop_past_discount_count',
        string='Past Discounted Orders',
        readonly=True,
    )
    rejection_reason = fields.Text(
        string='Rejection Reason',
        required=True,
    )

    def action_reject(self):
        self.ensure_one()
        if not self.sale_order_id:
            raise UserError(_('No sales order selected.'))
        self.sale_order_id.action_shahtaj_reject_order(reason=self.rejection_reason)
        return {'type': 'ir.actions.act_window_close'}
