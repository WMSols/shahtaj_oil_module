# -*- coding: utf-8 -*-
"""Force sale products to invoice on ordered quantities (DM invoices before delivery)."""


def migrate(cr, version):
    cr.execute("""
        UPDATE product_template
           SET invoice_policy = 'order'
         WHERE sale_ok IS TRUE
           AND invoice_policy IS DISTINCT FROM 'order'
    """)
