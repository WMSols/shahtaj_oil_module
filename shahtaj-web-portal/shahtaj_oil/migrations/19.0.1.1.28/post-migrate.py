# -*- coding: utf-8 -*-
"""Enable Purchase on warehouse products so native POs can select them."""


def migrate(cr, version):
    cr.execute(
        """
        UPDATE product_template
           SET purchase_ok = TRUE
         WHERE purchase_ok IS FALSE
           AND is_storable IS TRUE
           AND COALESCE(default_code, '') != 'SHAHTAJ-LEGACY'
        """
    )
