# -*- coding: utf-8 -*-
"""Upgrade: remove deprecated order_booker_id column from route table."""

def migrate(cr, version):
    cr.execute("""
        ALTER TABLE shahtaj_route
        DROP COLUMN IF EXISTS order_booker_id
    """)
