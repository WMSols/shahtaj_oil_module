# -*- coding: utf-8 -*-
"""Copy partner.route_id into shop↔route M2M; refresh booker shop ACL domain."""


def migrate(cr, version):
    cr.execute(
        """
        CREATE TABLE IF NOT EXISTS shahtaj_shop_route_rel (
            shop_id INTEGER NOT NULL REFERENCES res_partner(id) ON DELETE CASCADE,
            route_id INTEGER NOT NULL REFERENCES shahtaj_route(id) ON DELETE CASCADE,
            PRIMARY KEY (shop_id, route_id)
        )
        """
    )
    cr.execute(
        """
        INSERT INTO shahtaj_shop_route_rel (shop_id, route_id)
        SELECT p.id, p.route_id
          FROM res_partner p
         WHERE p.is_shahtaj_shop IS TRUE
           AND p.route_id IS NOT NULL
        ON CONFLICT DO NOTHING
        """
    )
    # Refresh stored route tag from the new membership table.
    cr.execute(
        """
        UPDATE res_partner AS p
           SET shahtaj_route_tag = CASE
                WHEN EXISTS (
                    SELECT 1 FROM shahtaj_shop_route_rel AS r
                     WHERE r.shop_id = p.id
                ) THEN 'assigned'
                ELSE 'unassigned'
           END
         WHERE p.is_shahtaj_shop IS TRUE
        """
    )
    # Booker shop rule: allow via any assigned route (noupdate XML won't refresh).
    domain = (
        "[\n"
        "                '|', '|', '|',\n"
        "                ('is_shahtaj_shop', '=', False),\n"
        "                ('registered_by_id', '=', user.id),\n"
        "                ('route_ids.weekly_schedule_ids.order_booker_id', '=', user.id),\n"
        "                ('shahtaj_visit_task_ids.order_booker_id', '=', user.id),\n"
        "            ]"
    )
    cr.execute(
        """
        UPDATE ir_rule AS r
           SET domain_force = %s
          FROM ir_model_data d
         WHERE d.module = 'shahtaj_oil'
           AND d.name = 'rule_shahtaj_shop_booker_own'
           AND d.model = 'ir.rule'
           AND d.res_id = r.id
        """,
        (domain,),
    )
