# -*- coding: utf-8 -*-
"""Close leftover in-progress visits from previous days."""


def migrate(cr, version):
    # Selection value 'incomplete' is registered by the ORM on upgrade;
    # close stale rows immediately so Flutter/API unblock without waiting for cron.
    cr.execute(
        """
        SELECT id FROM shahtaj_visit
         WHERE state = 'in_progress'
           AND started_at::date < CURRENT_DATE
        """
    )
    visit_ids = [row[0] for row in cr.fetchall()]
    if not visit_ids:
        return
    # Defer to ORM so notes / task skip logic run with the new methods.
    # post-migrate receives cr only — use env via odoo registry after module load.
    # Store ids for a follow-up call from the module's post_init is awkward;
    # do a direct SQL close that mirrors _auto_close_incomplete.
    cr.execute(
        """
        UPDATE shahtaj_visit
           SET state = 'completed',
               outcome = 'incomplete',
               ended_at = NOW() AT TIME ZONE 'UTC',
               duration_seconds = GREATEST(
                   EXTRACT(EPOCH FROM (
                       (NOW() AT TIME ZONE 'UTC') - started_at
                   ))::integer,
                   0
               ),
               notes = CASE
                   WHEN notes IS NULL OR BTRIM(notes) = '' THEN
                       'Auto-closed: visit was still in progress after the day ended (incomplete — no order placed).'
                   ELSE notes || E'\\n'
                        || 'Auto-closed: visit was still in progress after the day ended (incomplete — no order placed).'
               END,
               write_date = NOW() AT TIME ZONE 'UTC'
         WHERE id = ANY(%s)
        """,
        [visit_ids],
    )
    cr.execute(
        """
        UPDATE shahtaj_visit_task t
           SET state = 'skipped',
               notes = CASE
                   WHEN t.notes IS NULL OR BTRIM(t.notes) = '' THEN
                       'Skipped automatically: visit left incomplete overnight.'
                   ELSE t.notes || E'\\n'
                        || 'Skipped automatically: visit left incomplete overnight.'
               END,
               write_date = NOW() AT TIME ZONE 'UTC'
          FROM shahtaj_visit v
         WHERE v.visit_task_id = t.id
           AND v.id = ANY(%s)
           AND t.state = 'in_progress'
        """,
        [visit_ids],
    )
