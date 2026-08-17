# -*- coding: utf-8 -*-
"""Distributor landing page for shop sales, invoicing, and payments."""
from odoo import _, api, fields, models


class ShahtajAccountingHub(models.TransientModel):
    _name = 'shahtaj.accounting.hub'
    _description = 'Shop Accounting Hub'

    field_order_count = fields.Integer(
        string='Field Orders',
        compute='_compute_counts',
    )
    orders_to_invoice_count = fields.Integer(
        string='To Invoice',
        compute='_compute_counts',
    )
    orders_to_deliver_count = fields.Integer(
        string='To Deliver',
        compute='_compute_counts',
    )
    open_invoice_count = fields.Integer(
        string='Open Invoices',
        compute='_compute_counts',
    )
    credit_note_count = fields.Integer(
        string='Credit Notes',
        compute='_compute_counts',
    )
    expense_invoice_count = fields.Integer(
        string='Expense Invoices',
        compute='_compute_counts',
        help='Draft + posted operating expense invoices.',
    )
    shop_count = fields.Integer(
        string='Approved Shops',
        compute='_compute_counts',
    )
    purchase_order_count = fields.Integer(
        string='Purchase Orders',
        compute='_compute_counts',
    )
    incoming_receipt_count = fields.Integer(
        string='Incoming Receipts',
        compute='_compute_counts',
    )
    vendor_bill_count = fields.Integer(
        string='Vendor Bills',
        compute='_compute_counts',
    )

    @api.depends_context('uid')
    def _compute_counts(self):
        SaleOrder = self.env['sale.order'].sudo()
        AccountMove = self.env['account.move'].sudo()
        Partner = self.env['res.partner'].sudo()
        for hub in self:
            hub.field_order_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
            ])
            hub.orders_to_invoice_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
                ('invoice_status', '=', 'to invoice'),
            ])
            hub.orders_to_deliver_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
                ('state', 'in', ('sale', 'done')),
                ('shahtaj_delivery_status', 'in', ('pending', 'partial')),
            ])
            hub.open_invoice_count = AccountMove.search_count([
                ('move_type', '=', 'out_invoice'),
                ('partner_id.is_shahtaj_shop', '=', True),
                ('state', '=', 'posted'),
                ('payment_state', 'in', ('not_paid', 'partial')),
            ])
            hub.credit_note_count = AccountMove.search_count([
                ('move_type', '=', 'out_refund'),
                ('partner_id.is_shahtaj_shop', '=', True),
                ('state', '=', 'posted'),
            ])
            hub.expense_invoice_count = self.env['shahtaj.expense'].sudo().search_count([
                ('state', 'in', ('draft', 'posted')),
            ])
            hub.shop_count = Partner.search_count([
                ('is_shahtaj_shop', '=', True),
                ('shop_approval_state', '=', 'approved'),
            ])
            if 'purchase.order' in self.env:
                hub.purchase_order_count = self.env['purchase.order'].sudo().search_count([
                    ('state', 'in', ('draft', 'sent', 'to approve', 'purchase')),
                ])
                hub.incoming_receipt_count = self.env['stock.picking'].sudo().search_count([
                    ('picking_type_code', '=', 'incoming'),
                    ('state', 'not in', ('done', 'cancel')),
                ])
                hub.vendor_bill_count = AccountMove.search_count([
                    ('move_type', 'in', ('in_invoice', 'in_refund')),
                    ('state', 'in', ('draft', 'posted')),
                ])
            else:
                hub.purchase_order_count = 0
                hub.incoming_receipt_count = 0
                hub.vendor_bill_count = 0

    @api.model
    def action_open_accounting_hub(self):
        """Open the distributor accounting dashboard."""
        record = self.create({})
        return {
            'type': 'ir.actions.act_window',
            'name': _('Shop Accounting'),
            'res_model': 'shahtaj.accounting.hub',
            'res_id': record.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref(
                    'shahtaj_oil.view_shahtaj_accounting_hub_form'
                ).id, 'form'),
            ],
        }

    def action_open_field_sales_orders(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_field_sales_orders',
        )

    def action_open_orders_to_invoice(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_orders_to_invoice',
        )

    def action_open_orders_to_deliver(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_orders_to_deliver',
        )

    def action_open_customer_invoices(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_customer_invoices',
        )

    def action_open_customer_payments(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_customer_payments',
        )

    def action_open_shop_balances(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_shop_balances',
        )

    def action_open_credit_notes(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_credit_notes',
        )

    def action_open_opening_balance_invoices(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_opening_balance_invoices',
        )

    def action_open_pnl_dashboard(self):
        return self.env['shahtaj.pnl.dashboard'].action_open_pnl_dashboard()

    def action_open_tax_ledger(self):
        return self.env['shahtaj.tax.ledger'].action_open_tax_ledger()

    def action_open_expenses(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_expense',
        )

    def action_open_expense_categories(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_expense_category',
        )

    def action_open_purchase_orders(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_purchase_orders',
        )

    def action_open_incoming_receipts(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_incoming_receipts',
        )

    def action_open_vendor_bills(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_vendor_bills',
        )

    def action_open_vendors(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_vendors',
        )
