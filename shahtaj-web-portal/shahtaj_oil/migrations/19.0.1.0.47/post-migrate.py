# -*- coding: utf-8 -*-
"""Repair booker API shop registrations missing is_shahtaj_shop / registered_by_id.

Before 19.0.1.0.47, /shops/register used context shahtaj_shop_register but
_prepare_shop_vals only keyed off shahtaj_shop_form / is_shahtaj_shop, so
partners were created without shop flags and never appeared in shops/mine or
distributor pending approvals.
"""


def migrate(cr, version):
    # Mark orphaned booker registrations as pending shops and link the booker.
    cr.execute("""
        UPDATE res_partner p
           SET is_shahtaj_shop = TRUE,
               registered_by_id = COALESCE(p.registered_by_id, p.create_uid),
               shop_approval_state = COALESCE(
                   NULLIF(p.shop_approval_state, ''),
                   'pending'
               ),
               customer_rank = CASE
                   WHEN COALESCE(p.customer_rank, 0) < 1 THEN 1
                   ELSE p.customer_rank
               END,
               company_type = CASE
                   WHEN COALESCE(p.company_type, '') = '' THEN 'company'
                   ELSE p.company_type
               END,
               shahtaj_shop_category = COALESCE(
                   NULLIF(p.shahtaj_shop_category, ''),
                   'credit'
               ),
               phone = COALESCE(NULLIF(p.phone, ''), p.owner_phone)
         WHERE COALESCE(p.is_shahtaj_shop, FALSE) = FALSE
           AND p.owner_name IS NOT NULL
           AND p.owner_phone IS NOT NULL
           AND p.partner_latitude IS NOT NULL
           AND p.partner_longitude IS NOT NULL
           AND p.create_uid IS NOT NULL
           AND EXISTS (
                SELECT 1
                  FROM res_groups_users_rel rel
                  JOIN ir_model_data imd
                    ON imd.res_id = rel.gid
                   AND imd.model = 'res.groups'
                   AND imd.module = 'shahtaj_oil'
                   AND imd.name = 'group_shahtaj_order_booker'
                 WHERE rel.uid = p.create_uid
           )
    """)

    # Ensure already-flagged shops still have registered_by when pending/rejected.
    cr.execute("""
        UPDATE res_partner
           SET registered_by_id = create_uid
         WHERE is_shahtaj_shop
           AND registered_by_id IS NULL
           AND shop_approval_state IN ('pending', 'rejected')
           AND create_uid IS NOT NULL
    """)
