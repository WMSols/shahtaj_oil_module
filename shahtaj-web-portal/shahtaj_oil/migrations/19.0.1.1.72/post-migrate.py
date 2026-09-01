# -*- coding: utf-8 -*-
"""Partial unique indexes for visit tasks after M2 multi-DM support."""


def migrate(cr, version):
    cr.execute(
        """
        ALTER TABLE shahtaj_visit_task
        DROP CONSTRAINT IF EXISTS shahtaj_visit_task_shop_date_booker_route_kind_unique
        """
    )
    cr.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS shahtaj_visit_task_ob_shop_day_unique
        ON shahtaj_visit_task (shop_id, scheduled_date, order_booker_id, route_id)
        WHERE task_kind = 'order_booker'
        """
    )
    cr.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS shahtaj_visit_task_dm_delivery_unique
        ON shahtaj_visit_task (dm_delivery_id)
        WHERE dm_delivery_id IS NOT NULL
        """
    )
