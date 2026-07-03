# -*- coding: utf-8 -*-
"""Backfill registered_by_id on booker-submitted shops missing the link."""


def migrate(cr, version):
    cr.execute("""
        UPDATE res_partner
           SET registered_by_id = create_uid
         WHERE is_shahtaj_shop
           AND registered_by_id IS NULL
           AND shop_approval_state IN ('pending', 'rejected')
           AND create_uid IS NOT NULL
    """)
