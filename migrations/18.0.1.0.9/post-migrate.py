# -*- coding: utf-8 -*-
"""Upgrade: fix distributor record rule domain for reading order booker users."""

def migrate(cr, version):
    domain = "['|', ('shahtaj_is_order_booker', '=', True), ('id', '=', user.id)]"
    cr.execute(
        """
        UPDATE ir_rule
           SET domain_force = %s
         WHERE id IN (
               SELECT res_id
                 FROM ir_model_data
                WHERE module = 'shahtaj_oil'
                  AND name = 'rule_shahtaj_distributor_read_bookers'
           )
        """,
        (domain,),
    )
