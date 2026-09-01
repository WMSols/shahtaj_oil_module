# -*- coding: utf-8 -*-
"""Backfill verification reason flags on existing field sales orders."""
from odoo import api, SUPERUSER_ID


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    orders = env['sale.order'].search([
        ('shahtaj_visit_id', '!=', False),
        ('shahtaj_approval_state', 'in', ('to_approve', 'approved', 'rejected')),
    ])
    SaleOrder = env['sale.order']
    for order in orders:
        lines = order.order_line.filtered(
            lambda line: not line.display_type and line.product_id
        )
        has_discount = any(lines.mapped('shahtaj_has_discount'))
        order_amount = order.amount_total or sum(lines.mapped('price_subtotal')) or 0.0
        req = SaleOrder._shahtaj_evaluate_field_order_approval(
            order.partner_id,
            order_amount,
            has_discount,
            exclude_order_ids=order.ids,
        )
        write_vals = {}
        for key, value in {
            'shahtaj_approval_reason_discount': req['needs_discount'],
            'shahtaj_approval_reason_credit': req['needs_credit'],
        }.items():
            if order[key] != value:
                write_vals[key] = value
        if write_vals:
            order.write(write_vals)
