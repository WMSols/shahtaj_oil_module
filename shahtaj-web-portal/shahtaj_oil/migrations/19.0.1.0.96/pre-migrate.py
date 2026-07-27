# -*- coding: utf-8 -*-
"""Archive legacy target types; only collective + combined remain."""

ALLOWED = ('collective_qty', 'collective_weight', 'product_bundle')


def migrate(cr, version):
    # Force a valid selection key before the field definition shrinks.
    cr.execute(
        """
        UPDATE shahtaj_visit_target
           SET active = false,
               target_type = 'collective_qty'
         WHERE target_type IS NOT NULL
           AND target_type NOT IN %s
        """,
        (ALLOWED,),
    )
