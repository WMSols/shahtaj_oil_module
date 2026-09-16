# -*- coding: utf-8 -*-
"""Backfill shahtaj_has_cheque_image from cheque attachments."""


def migrate(cr, version):
    cr.execute("""
        UPDATE account_payment AS p
           SET shahtaj_has_cheque_image = TRUE
         WHERE COALESCE(p.shahtaj_has_cheque_image, FALSE) IS DISTINCT FROM TRUE
           AND EXISTS (
                SELECT 1
                  FROM ir_attachment AS a
                 WHERE a.res_model = 'account.payment'
                   AND a.res_field = 'shahtaj_cheque_image'
                   AND a.res_id = p.id
            )
    """)
    cr.execute("""
        UPDATE account_payment
           SET shahtaj_has_cheque_image = FALSE
         WHERE shahtaj_has_cheque_image IS NULL
    """)
