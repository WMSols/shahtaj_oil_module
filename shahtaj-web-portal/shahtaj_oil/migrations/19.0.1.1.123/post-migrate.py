# -*- coding: utf-8 -*-
"""Backfill stored has_delivery_proof without loading image binaries."""


def migrate(cr, version):
    # Image fields are attachment-backed; flag rows that already have proof.
    cr.execute("""
        UPDATE shahtaj_dm_delivery AS d
           SET has_delivery_proof = TRUE
         WHERE COALESCE(d.has_delivery_proof, FALSE) IS DISTINCT FROM TRUE
           AND EXISTS (
                SELECT 1
                  FROM ir_attachment AS a
                 WHERE a.res_model = 'shahtaj.dm.delivery'
                   AND a.res_field = 'delivery_proof_image'
                   AND a.res_id = d.id
            )
    """)
    cr.execute("""
        UPDATE shahtaj_dm_delivery
           SET has_delivery_proof = FALSE
         WHERE has_delivery_proof IS NULL
    """)
