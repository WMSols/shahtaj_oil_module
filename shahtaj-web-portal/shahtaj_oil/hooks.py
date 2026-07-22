# -*- coding: utf-8 -*-
"""Module install hooks."""

from odoo import SUPERUSER_ID, api

# Keep in sync with security/shahtaj_partner_access_upgrade.xml
_DISTRIBUTOR_PARTNER_READ_DOMAIN = """[
    '|', '|', '|', '|', '|', '|', '|',
    ('is_shahtaj_shop', '=', True),
    ('parent_id.is_shahtaj_shop', '=', True),
    ('commercial_partner_id.is_shahtaj_shop', '=', True),
    ('partner_share', '=', False),
    ('id', '=', user.partner_id.id),
    ('id', '=', user.company_id.partner_id.id),
    ('customer_rank', '>', 0),
    ('user_ids.shahtaj_is_order_booker', '=', True),
]"""


def _distributor_booker_user_domain(booker_group_id):
    """Domain text: distributors may read/write their own user and order bookers."""
    return f"""[
    '|', '|',
    ('group_ids', 'in', [{booker_group_id}]),
    ('shahtaj_is_order_booker', '=', True),
    ('id', '=', user.id),
]"""


def _sync_distributor_booker_user_rule(env):
    """Use group membership (not stored flags) for res.users access."""
    rule = env.ref(
        'shahtaj_oil.rule_shahtaj_distributor_read_bookers',
        raise_if_not_found=False,
    )
    if not rule:
        return
    booker_group = env.ref('shahtaj_oil.group_shahtaj_order_booker')
    distributor_group = env.ref('shahtaj_oil.group_shahtaj_distributor')
    rule.write({
        'domain_force': _distributor_booker_user_domain(booker_group.id),
        'groups': [(6, 0, [distributor_group.id])],
        'perm_read': True,
        'perm_write': True,
        'perm_create': False,
        'perm_unlink': False,
        'active': True,
    })


def _recompute_shahtaj_order_booker_flags(env):
    """Keep shahtaj_is_order_booker aligned with group membership."""
    Users = env['res.users'].with_context(active_test=False)
    booker_group = env.ref('shahtaj_oil.group_shahtaj_order_booker')
    candidates = Users.search([
        '|',
        ('group_ids', 'in', booker_group.ids),
        ('shahtaj_is_order_booker', '=', True),
    ])
    if candidates:
        candidates._recompute_recordset()


def _sync_distributor_partner_rules(env):
    """Ensure distributor partner record rules match accounting requirements."""
    shops_rule = env.ref(
        'shahtaj_oil.rule_shahtaj_distributor_shops',
        raise_if_not_found=False,
    )
    if shops_rule:
        shops_rule.unlink()

    read_rule = env.ref(
        'shahtaj_oil.rule_shahtaj_distributor_partner_read',
        raise_if_not_found=False,
    )
    if not read_rule:
        return

    distributor_group = env.ref('shahtaj_oil.group_shahtaj_distributor')
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


def post_init_hook(env):
    env['ir.config_parameter'].sudo().set_param(
        'base.enable_programmatic_api_keys', '1'
    )
    _sync_distributor_partner_rules(env)
    _sync_distributor_booker_user_rule(env)
    _recompute_shahtaj_order_booker_flags(env)
    env['res.users']._sync_all_shahtaj_ui_groups()
    env['res.users']._sync_all_shahtaj_financial_groups()
    env.registry.clear_cache('templates')


def migrate_distributor_partner_rules(cr):
    env = api.Environment(cr, SUPERUSER_ID, {})
    _sync_distributor_partner_rules(env)
