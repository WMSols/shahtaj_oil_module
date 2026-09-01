# -*- coding: utf-8 -*-
"""Distributor Orders Hub — Central command center for verifying and dispatching orders."""
from odoo import _, api, fields, models


class ShahtajOrdersHub(models.TransientModel):
    _name = 'shahtaj.orders.hub'
    _description = 'Field Orders & Dispatch Hub'

    orders_to_approve_count = fields.Integer(
        string='Needing Verification',
        compute='_compute_counts',
    )
    orders_to_deliver_count = fields.Integer(
        string='To Deliver / Dispatch',
        compute='_compute_counts',
    )
    orders_to_invoice_count = fields.Integer(
        string='To Invoice',
        compute='_compute_counts',
    )
    orders_confirmed_today_count = fields.Integer(
        string='Confirmed Today',
        compute='_compute_counts',
    )
    orders_rejected_count = fields.Integer(
        string='Rejected Orders',
        compute='_compute_counts',
    )
    field_order_total_count = fields.Integer(
        string='All Field Orders',
        compute='_compute_counts',
    )
    dm_jobs_active_count = fields.Integer(
        string='Active DM Jobs',
        compute='_compute_counts',
    )

    @api.depends_context('uid')
    def _compute_counts(self):
        SaleOrder = self.env['sale.order'].sudo()
        DmDelivery = self.env['shahtaj.dm.delivery'].sudo()
        today = fields.Date.context_today(self)

        for hub in self:
            hub.orders_to_approve_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
                ('shahtaj_approval_state', '=', 'to_approve'),
                ('state', 'in', ('draft', 'sent')),
            ])
            hub.orders_to_deliver_count = SaleOrder.search_count([
                ('state', 'in', ('sale', 'done')),
                ('shahtaj_delivery_status', 'in', ('pending', 'partial')),
            ])
            hub.orders_to_invoice_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
                ('invoice_status', '=', 'to invoice'),
            ])
            hub.orders_confirmed_today_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
                ('state', 'in', ('sale', 'done')),
                ('date_order', '>=', today),
            ])
            hub.orders_rejected_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
                ('shahtaj_approval_state', '=', 'rejected'),
            ])
            hub.field_order_total_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
            ])
            hub.dm_jobs_active_count = DmDelivery.search_count([
                ('state', 'in', ('draft', 'assigned', 'loading', 'on_the_way')),
            ])

    @api.model
    def action_open_orders_hub(self):
        """Open the distributor Orders & Dispatch dashboard."""
        record = self.create({})
        return {
            'type': 'ir.actions.act_window',
            'name': _('Orders & Dispatch Hub'),
            'res_model': 'shahtaj.orders.hub',
            'res_id': record.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref(
                    'shahtaj_oil.view_shahtaj_orders_hub_form'
                ).id, 'form'),
            ],
        }

    def action_open_orders_needing_verification(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_orders_needing_verification',
        )

    def action_open_dispatch_orders(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_dm_dispatch_orders',
        )

    def action_open_orders_to_invoice(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_orders_to_invoice',
        )

    def action_open_field_sales_orders(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_field_sales_orders',
        )

    def action_open_rejected_orders(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_orders_rejected',
        )

    def action_open_dm_dispatch_jobs(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_dm_dispatch_jobs',
        )
