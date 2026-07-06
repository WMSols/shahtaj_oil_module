# -*- coding: utf-8 -*-
"""Backfill shop category for existing shops (default: credit)."""


def migrate(cr, version):
    cr.execute("""
        UPDATE res_partner
           SET shahtaj_shop_category = 'credit'
         WHERE is_shahtaj_shop
           AND (shahtaj_shop_category IS NULL OR shahtaj_shop_category = '')
    """)
