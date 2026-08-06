# -*- coding: utf-8 -*-
"""One schedule per booker per weekday: drop (booker,route,day) dups before unique(booker,day)."""


def migrate(cr, version):
    cr.execute(
        """
        SELECT 1
          FROM information_schema.tables
         WHERE table_name = 'shahtaj_weekly_schedule'
        """
    )
    if not cr.fetchone():
        return

    # Prefer active rows, then lowest id. Point tasks at the survivor, then drop extras.
    cr.execute(
        """
        CREATE TEMP TABLE shahtaj_schedule_keep AS
        SELECT DISTINCT ON (order_booker_id, day_of_week)
               id AS keep_id,
               order_booker_id,
               day_of_week
          FROM shahtaj_weekly_schedule
         ORDER BY order_booker_id, day_of_week, active DESC, id ASC
        """
    )
    cr.execute(
        """
        UPDATE shahtaj_visit_task AS t
           SET weekly_schedule_id = k.keep_id
          FROM shahtaj_weekly_schedule AS s
          JOIN shahtaj_schedule_keep AS k
            ON k.order_booker_id = s.order_booker_id
           AND k.day_of_week = s.day_of_week
         WHERE t.weekly_schedule_id = s.id
           AND s.id <> k.keep_id
        """
    )
    cr.execute(
        """
        DELETE FROM shahtaj_weekly_schedule AS s
         USING shahtaj_schedule_keep AS k
         WHERE s.order_booker_id = k.order_booker_id
           AND s.day_of_week = k.day_of_week
           AND s.id <> k.keep_id
        """
    )
    cr.execute("DROP TABLE IF EXISTS shahtaj_schedule_keep")

    # Drop legacy unique(order_booker_id, route_id, day_of_week) if still present.
    cr.execute(
        """
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'shahtaj_weekly_schedule'::regclass
           AND contype = 'u'
           AND pg_get_constraintdef(oid) ILIKE
               '%%order_booker_id%%route_id%%day_of_week%%'
        """
    )
    for (conname,) in cr.fetchall():
        cr.execute(
            'ALTER TABLE shahtaj_weekly_schedule DROP CONSTRAINT IF EXISTS "%s"'
            % conname.replace('"', '')
        )
