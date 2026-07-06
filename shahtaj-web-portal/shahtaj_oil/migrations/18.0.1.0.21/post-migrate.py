# -*- coding: utf-8 -*-
"""Upgrade: copy old many-to-many shop-route links into res_partner.route_id."""

def migrate(cr, version):
    """Move shop↔route links from M2M junction table to res_partner.route_id."""
    cr.execute(
        """
        SELECT EXISTS (
            SELECT 1
              FROM information_schema.tables
             WHERE table_schema = 'public'
               AND table_name = 'shahtaj_route_partner_rel'
        )
        """
    )
    if not cr.fetchone()[0]:
        return

    cr.execute(
        """
        UPDATE res_partner AS partner
           SET route_id = rel.route_id
          FROM (
                SELECT partner_id, MIN(route_id) AS route_id
                  FROM shahtaj_route_partner_rel
              GROUP BY partner_id
               ) AS rel
         WHERE partner.id = rel.partner_id
           AND partner.route_id IS DISTINCT FROM rel.route_id
        """
    )
    cr.execute("DROP TABLE IF EXISTS shahtaj_route_partner_rel CASCADE")
