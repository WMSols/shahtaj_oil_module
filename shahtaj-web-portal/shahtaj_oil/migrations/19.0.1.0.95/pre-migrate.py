# -*- coding: utf-8 -*-
"""Drop unique(visit_task_id) so undone visits can keep history while OB redoes."""


def migrate(cr, version):
    cr.execute("""
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'shahtaj_visit'::regclass
           AND contype = 'u'
           AND pg_get_constraintdef(oid) ILIKE '%visit_task_id%'
    """)
    for (conname,) in cr.fetchall():
        cr.execute(f'ALTER TABLE shahtaj_visit DROP CONSTRAINT IF EXISTS "{conname}"')
