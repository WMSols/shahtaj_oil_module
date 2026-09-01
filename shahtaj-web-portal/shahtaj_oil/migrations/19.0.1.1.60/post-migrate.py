# -*- coding: utf-8 -*-
"""Drop stale stock.move defaults that still reference removed ``name`` field."""


def migrate(cr, version):
    cr.execute(
        """
        DELETE FROM ir_default
         WHERE field_id IN (
            SELECT f.id
              FROM ir_model_fields f
              JOIN ir_model m ON m.id = f.model_id
             WHERE m.model = 'stock.move'
               AND f.name = 'name'
         )
        """
    )
    # Orphan field metadata if any leftover from older Odoo stock.move.name
    cr.execute(
        """
        DELETE FROM ir_model_fields
         WHERE name = 'name'
           AND model = 'stock.move'
        """
    )
