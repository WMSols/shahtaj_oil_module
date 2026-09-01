# -*- coding: utf-8 -*-
"""Security & Access Rights Setup Checks.

Handles auto-sync of:
1. Full Accounting Features & Administrator Rights for Admin and Native Distributors
2. Distributor Partner Record Rules
3. Distributor Order Booker Access Rules
4. Order Booker flag recomputations
5. User UI & Financial group synchronization
"""
import logging

_logger = logging.getLogger(__name__)

# Accounting security groups to auto-grant to Admin and Native Distributors
ACCOUNTING_FULL_GROUPS = [
    'account.group_account_manager',   # Accounting: Administrator
    'account.group_account_user',      # Show Full Accounting Features
    'account.group_account_readonly',  # Show Accounting Features - Readonly
]

# Keep in sync with security/shahtaj_partner_access_upgrade.xml
_DISTRIBUTOR_PARTNER_READ_DOMAIN = """[
    '|', '|', '|', '|', '|', '|', '|', '|',
    ('is_shahtaj_shop', '=', True),
    ('parent_id.is_shahtaj_shop', '=', True),
    ('commercial_partner_id.is_shahtaj_shop', '=', True),
    ('partner_share', '=', False),
    ('id', '=', user.partner_id.id),
    ('id', '=', user.company_id.partner_id.id),
    ('customer_rank', '>', 0),
    ('user_ids.shahtaj_is_order_booker', '=', True),
    ('supplier_rank', '>', 0),
]"""


def sync_accounting_access_rights(env):
    """Ensure Administrator and Native Distributors have Full Accounting & Readonly features enabled."""
    groups = []
    for xml_id in ACCOUNTING_FULL_GROUPS:
        group = env.ref(xml_id, raise_if_not_found=False)
        if group:
            groups.append(group)

    if not groups:
        _logger.warning("Shahtaj Setup: Accounting groups not found in registry.")
        return

    # Find Administrator (id=1 / admin / root) and native distributor users
    users = env['res.users'].sudo().search([
        '|',
        ('id', '=', 1),
        '|',
        ('login', '=', 'admin'),
        ('shahtaj_is_distributor', '=', True),
    ])

    for user in users:
        user_group_ids = user.group_ids.ids if hasattr(user, 'group_ids') else user.groups_id.ids
        missing_groups = [g for g in groups if g.id not in user_group_ids]
        if missing_groups:
            field_name = 'group_ids' if hasattr(user, 'group_ids') else 'groups_id'
            user.sudo().write({
                field_name: [(4, g.id) for g in missing_groups]
            })
            _logger.info(
                "Shahtaj Setup: Granted accounting rights %s to user %s (%s)",
                [g.name for g in missing_groups], user.name, user.login
            )


def sync_distributor_partner_rules(env):
    """Ensure distributor partner record rules match accounting requirements."""
    shops_rule = env.ref('shahtaj_oil.rule_shahtaj_distributor_shops', raise_if_not_found=False)
    if shops_rule:
        shops_rule.unlink()

    read_rule = env.ref('shahtaj_oil.rule_shahtaj_distributor_partner_read', raise_if_not_found=False)
    distributor_group = env.ref('shahtaj_oil.group_shahtaj_distributor', raise_if_not_found=False)
    if read_rule and distributor_group:
        read_rule.write({
            'name': 'Distributor: read shops and staff contacts',
            'domain_force': _DISTRIBUTOR_PARTNER_READ_DOMAIN,
            'groups': [(6, 0, [distributor_group.id])],
            'perm_read': True,
            'perm_write': False,
            'perm_create': False,
            'perm_unlink': False,
            'active': True,
        })

    vendor_rule = env.ref('shahtaj_oil.rule_shahtaj_distributor_vendor_read', raise_if_not_found=False)
    if vendor_rule and distributor_group:
        vendor_rule.write({
            'name': 'Distributor: read vendor contacts',
            'domain_force': "[('supplier_rank', '>', 0)]",
            'groups': [(6, 0, [distributor_group.id])],
            'perm_read': True,
            'perm_write': False,
            'perm_create': False,
            'perm_unlink': False,
            'active': True,
        })


def sync_distributor_booker_user_rule(env):
    """Use group membership for res.users access."""
    rule = env.ref('shahtaj_oil.rule_shahtaj_distributor_read_bookers', raise_if_not_found=False)
    if not rule:
        return
    booker_group = env.ref('shahtaj_oil.group_shahtaj_order_booker', raise_if_not_found=False)
    distributor_group = env.ref('shahtaj_oil.group_shahtaj_distributor', raise_if_not_found=False)
    if booker_group and distributor_group:
        rule.write({
            'domain_force': f"""[
                '|', '|',
                ('group_ids', 'in', [{booker_group.id}]),
                ('shahtaj_is_order_booker', '=', True),
                ('id', '=', user.id),
            ]""",
            'groups': [(6, 0, [distributor_group.id])],
            'perm_read': True,
            'perm_write': True,
            'perm_create': False,
            'perm_unlink': False,
            'active': True,
        })


def recompute_shahtaj_order_booker_flags(env):
    """Keep shahtaj_is_order_booker aligned with group membership."""
    Users = env['res.users'].with_context(active_test=False)
    booker_group = env.ref('shahtaj_oil.group_shahtaj_order_booker', raise_if_not_found=False)
    if not booker_group:
        return
    candidates = Users.search([
        '|',
        ('group_ids', 'in', booker_group.ids),
        ('shahtaj_is_order_booker', '=', True),
    ])
    if candidates:
        candidates._recompute_recordset()


def sync_user_ui_and_financial_groups(env):
    """Synchronize distributor UI and financial groups."""
    Users = env['res.users'].sudo()
    if hasattr(Users, '_shahtaj_fix_financial_group_privilege'):
        Users._shahtaj_fix_financial_group_privilege()
    if hasattr(Users, '_sync_all_shahtaj_ui_groups'):
        Users._sync_all_shahtaj_ui_groups()
    if hasattr(Users, '_clear_shahtaj_distributor_flags_on_non_distributors'):
        Users._clear_shahtaj_distributor_flags_on_non_distributors()
    if hasattr(Users, '_sync_all_shahtaj_financial_groups'):
        Users._sync_all_shahtaj_financial_groups()
