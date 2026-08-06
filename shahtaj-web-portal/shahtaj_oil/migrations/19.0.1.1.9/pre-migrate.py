# -*- coding: utf-8 -*-
"""Drop old visit-task unique key before (shop, date, booker, route) replaces it."""


def migrate(cr, version):
    cr.execute(
        """
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'shahtaj_visit_task'::regclass
           AND contype = 'u'
           AND (
                conname ILIKE '%shop%date%booker%'
                OR conname ILIKE '%shop_date_booker%'
                OR pg_get_constraintdef(oid) ILIKE '%shop_id%scheduled_date%order_booker_id%'
           )
        """
    )
    for (conname,) in cr.fetchall():
        cr.execute(f'ALTER TABLE shahtaj_visit_task DROP CONSTRAINT IF EXISTS "{conname}"')
