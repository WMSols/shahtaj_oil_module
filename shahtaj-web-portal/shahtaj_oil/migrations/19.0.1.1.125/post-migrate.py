# -*- coding: utf-8 -*-
"""Recompute invoiceable qty after switching products to ordered invoicing."""


def migrate(cr, version):
    from odoo import api, SUPERUSER_ID

    env = api.Environment(cr, SUPERUSER_ID, {})
    products = env['product.template'].with_context(active_test=False).search([
        ('sale_ok', '=', True),
    ])
    if products:
        products.write({'invoice_policy': 'order'})
    lines = env['sale.order.line'].search([
        ('state', 'in', ('sale', 'done')),
        ('display_type', '=', False),
    ])
    if lines and hasattr(lines, '_compute_qty_to_invoice'):
        lines._compute_qty_to_invoice()
"""Backfill shahtaj_has_cheque_image from cheque attachments."""


def migrate(cr, version):
    cr.execute("""
        UPDATE account_payment AS p
           SET shahtaj_has_cheque_image = TRUE
         WHERE COALESCE(p.shahtaj_has_cheque_image, FALSE) IS DISTINCT FROM TRUE
           AND EXISTS (
                SELECT 1
                  FROM ir_attachment AS a
                 WHERE a.res_model = 'account.payment'
                   AND a.res_field = 'shahtaj_cheque_image'
                   AND a.res_id = p.id
            )
    """)
    cr.execute("""
        UPDATE account_payment
           SET shahtaj_has_cheque_image = FALSE
         WHERE shahtaj_has_cheque_image IS NULL
    """)
