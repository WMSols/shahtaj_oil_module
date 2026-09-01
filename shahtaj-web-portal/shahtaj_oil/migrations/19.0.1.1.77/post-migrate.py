# -*- coding: utf-8 -*-
"""M4: seed field_state from existing stock state; M5 gps_verified defaults."""


def migrate(cr, version):
    cr.execute(
        """
        UPDATE shahtaj_dm_delivery
           SET field_state = CASE
                WHEN state = 'delivered' THEN 'done'
                ELSE COALESCE(field_state, 'pending')
           END
         WHERE field_state IS NULL
            OR (state = 'delivered' AND field_state != 'done')
        """
    )
    cr.execute(
        """
        UPDATE shahtaj_dm_delivery
           SET gps_verified = TRUE
         WHERE gps_verified IS DISTINCT FROM TRUE
           AND check_in_distance_m IS NOT NULL
           AND check_in_distance_m > 0
           AND state IN ('partial', 'delivered')
        """
    )
