# -*- coding: utf-8 -*-
"""Accounting Setup & Self-Healing Checks.

Handles creation and verification of:
1. DM Wallet Account (101410) - Current Assets, Reconcile=True
2. Van Stock Transit Account (110200) - Current Assets, Reconcile=False
3. DM Cash Collections Journal (DMCASH) - Cash type, linked to 101410
4. Delivery Vans Transit Location Valuation Account linkage
5. Product Category Default Income Accounts
"""
import logging

_logger = logging.getLogger(__name__)


def ensure_dm_accounting(company_or_env):
    """Ensure dedicated DM Wallet and Van Stock accounts, journal & location exist.

    Accepts either an environment or a res.company record.
    """
    if hasattr(company_or_env, 'env'):
        env = company_or_env.env
        companies = company_or_env if company_or_env._name == 'res.company' else env['res.company'].sudo().search([])
    else:
        env = company_or_env
        companies = env['res.company'].sudo().search([])

    Account = env['account.account'].sudo()
    Journal = env['account.journal'].sudo()
    Location = env['stock.location'].sudo()

    results = {}
    for company in companies:
        c_account = Account.with_company(company)
        c_journal = Journal.with_company(company)
        c_location = Location.with_company(company)

        # 1. DM Wallet Account (101410)
        dm_wallet_acc = c_account.search([
            ('company_ids', 'in', [company.id]),
            ('code', '=', '101410'),
        ], limit=1)
        if not dm_wallet_acc:
            dm_wallet_acc = c_account.create({
                'name': 'Cash with Delivery Men (DM Wallet)',
                'code': '101410',
                'account_type': 'asset_current',
                'reconcile': True,
                'company_ids': [(4, company.id)],
            })
            _logger.info("Created DM Wallet Account 101410 for %s", company.name)
        elif not dm_wallet_acc.reconcile:
            dm_wallet_acc.write({'reconcile': True})

        # 2. Van Stock Transit Account (110200)
        van_stock_acc = c_account.search([
            ('company_ids', 'in', [company.id]),
            ('code', '=', '110200'),
        ], limit=1)
        if not van_stock_acc:
            van_stock_acc = c_account.create({
                'name': 'Van Stock (Goods in Transit)',
                'code': '110200',
                'account_type': 'asset_current',
                'reconcile': False,
                'company_ids': [(4, company.id)],
            })
            _logger.info("Created Van Stock Account 110200 for %s", company.name)

        # 3. DM Cash Collections Journal (DMCASH)
        dm_journal = c_journal.search([
            ('company_id', '=', company.id),
            ('code', '=', 'DMCASH'),
        ], limit=1)
        if not dm_journal:
            dm_journal = c_journal.create({
                'name': 'DM Cash Collections',
                'type': 'cash',
                'code': 'DMCASH',
                'company_id': company.id,
                'default_account_id': dm_wallet_acc.id,
            })
            _logger.info("Created DMCASH Journal for %s", company.name)
        elif dm_journal.default_account_id != dm_wallet_acc:
            dm_journal.write({'default_account_id': dm_wallet_acc.id})

        # Ensure Inbound and Outbound payment lines point to dm_wallet_acc
        for in_line in dm_journal.inbound_payment_method_line_ids:
            if in_line.payment_account_id != dm_wallet_acc:
                in_line.write({'payment_account_id': dm_wallet_acc.id})
        for out_line in dm_journal.outbound_payment_method_line_ids:
            if out_line.payment_account_id != dm_wallet_acc:
                out_line.write({'payment_account_id': dm_wallet_acc.id})

        # 4. Link Van Stock account to Transit Location Delivery Vans
        van_parent = env.ref('shahtaj_oil.stock_location_dm_vans', raise_if_not_found=False)
        if not van_parent:
            van_parent = c_location.search([
                ('company_id', '=', company.id),
                ('name', '=', 'Delivery Vans'),
                ('usage', '=', 'transit'),
            ], limit=1)
        if van_parent and hasattr(van_parent, 'valuation_account_id'):
            if van_parent.valuation_account_id != van_stock_acc:
                van_parent.write({'valuation_account_id': van_stock_acc.id})

        results[company.id] = {
            'dm_wallet_acc': dm_wallet_acc,
            'van_stock_acc': van_stock_acc,
            'dm_journal': dm_journal,
        }

    return results


def ensure_category_accounts(env):
    """Ensure product categories have a default income account assigned."""
    ProductTemplate = env['product.template'].sudo()
    if hasattr(ProductTemplate, '_ensure_shahtaj_category_accounts'):
        return ProductTemplate._ensure_shahtaj_category_accounts()
    return False
