# -*- coding: utf-8 -*-
"""Mark shops with prior visit activity as field-verified."""


def migrate(cr, version):
    # Shops that already had a non-cancelled visit are treated as field-verified.
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
    # Sync visit tag from verified flag (also for shops that stay unverified).
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
