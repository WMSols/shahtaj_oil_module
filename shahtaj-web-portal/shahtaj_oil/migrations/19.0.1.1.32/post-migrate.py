# -*- coding: utf-8 -*-
"""Bill PO receipts on received quantities, not ordered quantities."""


def migrate(cr, version):
    cr.execute(
        """
        UPDATE product_template
           SET purchase_method = 'receive'
         WHERE COALESCE(purchase_method, '') != 'receive'
           AND type != 'service'
           AND COALESCE(default_code, '') != 'SHAHTAJ-LEGACY'
        """
    )
