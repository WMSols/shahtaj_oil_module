# -*- coding: utf-8 -*-
"""Realign stale Stop Done / completed DM visit tasks after delivery undo."""


def migrate(cr, version):
    # Stock Ready/Picked with no delivered qty must not keep Stop Done.
    cr.execute(
        """
        UPDATE shahtaj_dm_delivery d
           SET field_state = CASE
                WHEN d.state IN ('picked', 'partial') THEN 'in_transit'
                ELSE 'pending'
           END
         WHERE d.field_state = 'done'
           AND d.state IN ('ready', 'picked', 'not_ready')
           AND NOT EXISTS (
                SELECT 1
                  FROM shahtaj_dm_delivery_line l
                 WHERE l.delivery_id = d.id
                   AND COALESCE(l.qty_delivered, 0) > 0
           )
        """
    )
    # Re-open visit tasks stuck on completed while job stock is not delivered.
    cr.execute(
        """
        UPDATE shahtaj_visit_task t
           SET state = CASE
                WHEN d.state = 'partial' THEN 'in_progress'
                ELSE 'pending'
           END
          FROM shahtaj_dm_delivery d
         WHERE t.dm_delivery_id = d.id
           AND t.task_kind = 'delivery_man'
           AND t.state = 'completed'
           AND d.state IN ('ready', 'picked', 'partial', 'not_ready')
           AND NOT EXISTS (
                SELECT 1
                  FROM shahtaj_dm_delivery_line l
                 WHERE l.delivery_id = d.id
                   AND COALESCE(l.qty_delivered, 0) > 0
           )
        """
    )
