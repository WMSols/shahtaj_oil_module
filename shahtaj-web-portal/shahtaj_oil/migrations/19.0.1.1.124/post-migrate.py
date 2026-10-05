# -*- coding: utf-8 -*-
"""Keep sale products on ordered-qty invoicing so SOs invoice before DM assign."""


def migrate(cr, version):
    cr.execute("""
        UPDATE product_template
           SET invoice_policy = 'order'
         WHERE sale_ok IS TRUE
           AND invoice_policy IS DISTINCT FROM 'order'
    """)
