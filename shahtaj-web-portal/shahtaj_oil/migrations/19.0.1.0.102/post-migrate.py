# -*- coding: utf-8 -*-
"""Mark shops with prior booker field sales as field-verified (Visited)."""


def migrate(cr, version):
    # Shops that already had a non-cancelled visit (safety re-run / missed rows).
    cr.execute("""
        UPDATE res_partner p
           SET shahtaj_field_verified = TRUE,
               shahtaj_field_verified_at = COALESCE(
                   shahtaj_field_verified_at,
                   (
                       SELECT MIN(v.started_at)
                         FROM shahtaj_visit v
                        WHERE v.shop_id = p.id
                          AND v.state != 'cancelled'
                   )
               )
         WHERE p.is_shahtaj_shop IS TRUE
           AND COALESCE(p.shahtaj_field_verified, FALSE) IS FALSE
           AND EXISTS (
               SELECT 1
                 FROM shahtaj_visit v
                WHERE v.shop_id = p.id
                  AND v.state != 'cancelled'
           )
    """)
    # Shops with confirmed/done field sales orders from an order booker visit.
    cr.execute("""
        UPDATE res_partner p
           SET shahtaj_field_verified = TRUE,
               shahtaj_field_verified_at = COALESCE(
                   shahtaj_field_verified_at,
                   (
                       SELECT MIN(so.date_order)
                         FROM sale_order so
                        WHERE so.partner_id = p.id
                          AND so.shahtaj_visit_id IS NOT NULL
                          AND so.state IN ('sale', 'done')
                   )
               )
         WHERE p.is_shahtaj_shop IS TRUE
           AND COALESCE(p.shahtaj_field_verified, FALSE) IS FALSE
           AND EXISTS (
               SELECT 1
                 FROM sale_order so
                WHERE so.partner_id = p.id
                  AND so.shahtaj_visit_id IS NOT NULL
                  AND so.state IN ('sale', 'done')
           )
    """)
    # Sync visit tag from verified flag.
    cr.execute("""
        UPDATE res_partner
           SET shahtaj_visit_tag = CASE
                 WHEN is_shahtaj_shop IS TRUE AND shahtaj_field_verified IS TRUE
                   THEN 'visited'
                 WHEN is_shahtaj_shop IS TRUE
                   THEN 'not_visited'
                 ELSE NULL
               END
         WHERE is_shahtaj_shop IS TRUE
            OR shahtaj_visit_tag IS NOT NULL
    """)
