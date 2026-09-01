# -*- coding: utf-8 -*-
"""Switch Shahtaj sale products to invoice on ordered quantities."""


def migrate(cr, version):
    cr.execute("""
        UPDATE product_template
           SET invoice_policy = 'order'
         WHERE sale_ok IS TRUE
           AND type = 'consu'
           AND invoice_policy IS DISTINCT FROM 'order'
    """)
