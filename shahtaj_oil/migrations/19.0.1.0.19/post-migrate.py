# -*- coding: utf-8 -*-
"""Backfill visit display names for booker history screens."""


def migrate(cr, version):
    cr.execute("""
        UPDATE shahtaj_visit v
           SET shop_name = p.name
          FROM res_partner p
         WHERE v.shop_id = p.id
           AND (v.shop_name IS NULL OR v.shop_name = '')
    """)
    cr.execute("""
        UPDATE shahtaj_visit v
           SET route_name = r.name
          FROM shahtaj_route r
         WHERE v.route_id = r.id
           AND (v.route_name IS NULL OR v.route_name = '')
    """)
    cr.execute("""
        UPDATE shahtaj_visit_line l
           SET product_name = t.name
          FROM product_product pp
          JOIN product_template t ON t.id = pp.product_tmpl_id
         WHERE l.product_id = pp.id
           AND (l.product_name IS NULL OR l.product_name = '')
    """)
