# -*- coding: utf-8 -*-
"""Hide legacy-balance system product; invoices no longer use it."""


def migrate(cr, version):
    cr.execute("""
        UPDATE product_template
           SET sale_ok = FALSE,
               active = FALSE,
               purchase_ok = FALSE
         WHERE default_code = 'SHAHTAJ-LEGACY'
    """)
