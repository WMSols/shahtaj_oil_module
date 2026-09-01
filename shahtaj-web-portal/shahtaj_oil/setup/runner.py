# -*- coding: utf-8 -*-
"""Shahtaj Setup Runner — Master Execution Coordinator.

Executes all setup checks cleanly with logging and error isolation.
To disable any check, simply toggle its boolean flag below or remove the file.
"""
import logging
from . import accounting_setup
from . import access_rights_setup
from . import product_setup

_logger = logging.getLogger(__name__)

# Master Toggles for Setup Checks
ENABLE_ACCOUNTING_SETUP = True
ENABLE_ACCOUNTING_ACCESS_SYNC = True
ENABLE_SECURITY_RULES_SYNC = True
ENABLE_PRODUCT_SETUP = True


def run_all_setup_checks(env):
    """Run all active setup checks on module install/upgrade or manual invoke."""
    _logger.info("=== Starting Shahtaj Setup Checks ===")

    # 1. Base API parameter
    try:
        env['ir.config_parameter'].sudo().set_param('base.enable_programmatic_api_keys', '1')
    except Exception as e:
        _logger.warning("Shahtaj Setup: Could not set programmatic API keys param: %s", e)

    # 2. Accounting Accounts & Journals Setup (101410 DM Wallet, 110200 Van Stock, DMCASH Journal)
    if ENABLE_ACCOUNTING_SETUP:
        try:
            accounting_setup.ensure_dm_accounting(env)
            accounting_setup.ensure_category_accounts(env)
            _logger.info("Shahtaj Setup: Accounting configuration checks completed.")
        except Exception as e:
            _logger.error("Shahtaj Setup: Error during accounting configuration: %s", e)

    # 3. Security Rules & UI Sync
    if ENABLE_SECURITY_RULES_SYNC:
        try:
            access_rights_setup.sync_distributor_partner_rules(env)
            access_rights_setup.sync_distributor_booker_user_rule(env)
            access_rights_setup.recompute_shahtaj_order_booker_flags(env)
            access_rights_setup.sync_user_ui_and_financial_groups(env)
            _logger.info("Shahtaj Setup: Security and UI rules sync completed.")
        except Exception as e:
            _logger.error("Shahtaj Setup: Error during security rules sync: %s", e)

    # 4. Accounting Administrator & Full Accounting Features Auto-Assignment
    # Runs AFTER UI sync so its group assignments are final.
    if ENABLE_ACCOUNTING_ACCESS_SYNC:
        try:
            access_rights_setup.sync_accounting_access_rights(env)
            _logger.info("Shahtaj Setup: Accounting access rights sync completed.")
        except Exception as e:
            _logger.error("Shahtaj Setup: Error during accounting access rights sync: %s", e)

    # 5. Product Setup
    if ENABLE_PRODUCT_SETUP:
        try:
            product_setup.enable_purchase_ok_on_storable_products(env)
            product_setup.sync_existing_product_vendor_associations(env)
            _logger.info("Shahtaj Setup: Product setup checks completed.")
        except Exception as e:
            _logger.error("Shahtaj Setup: Error during product setup: %s", e)

    # 6. Clear template cache
    try:
        env.registry.clear_cache('templates')
    except Exception as e:
        _logger.debug("Shahtaj Setup: Clear template cache: %s", e)

    _logger.info("=== Finished Shahtaj Setup Checks ===")
