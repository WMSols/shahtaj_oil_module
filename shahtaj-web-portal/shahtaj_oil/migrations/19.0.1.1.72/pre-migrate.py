# -*- coding: utf-8 -*-
"""Drop old visit-task unique so multiple DMs can visit same shop/day (M2)."""


def migrate(cr, version):
    cr.execute(
        """
        ALTER TABLE shahtaj_visit_task
        DROP CONSTRAINT IF EXISTS shahtaj_visit_task_shop_date_booker_route_kind_unique
        """
    )
