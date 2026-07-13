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
    open_invoice_count = fields.Integer(
        string='Open Invoices',
        compute='_compute_counts',
    )
    credit_note_count = fields.Integer(
        string='Credit Notes',
        compute='_compute_counts',
    )
    shop_count = fields.Integer(
        string='Approved Shops',
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
            hub.shop_count = Partner.search_count([
                ('is_shahtaj_shop', '=', True),
                ('shop_approval_state', '=', 'approved'),
            ])

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
