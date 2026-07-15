# -*- coding: utf-8 -*-
"""Switch Shahtaj storable products to invoice on delivered qty."""


def migrate(cr, version):
    cr.execute("""
        UPDATE product_template
           SET invoice_policy = 'delivery'
         WHERE sale_ok IS TRUE
           AND COALESCE(is_storable, FALSE) IS TRUE
           AND invoice_policy IS DISTINCT FROM 'delivery'
    """)
