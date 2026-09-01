# -*- coding: utf-8 -*-
"""Product & Inventory Setup Checks.

Handles:
1. Enabling purchase_ok on storable warehouse products (excluding legacy opening balance products).
"""
import logging

_logger = logging.getLogger(__name__)


def enable_purchase_ok_on_storable_products(env):
    """Allow existing warehouse products on native purchase orders.

    SHAHTAJ-LEGACY stays non-purchasable (service / opening-balance product).
    """
    templates = env['product.template'].sudo().with_context(active_test=False).search([
        ('purchase_ok', '=', False),
        ('is_storable', '=', True),
        '|',
        ('default_code', '=', False),
        ('default_code', '!=', 'SHAHTAJ-LEGACY'),
    ])
    if templates:
        templates.write({'purchase_ok': True})
        _logger.info("Shahtaj Setup: Enabled purchase_ok on %d storable product templates", len(templates))


def sync_existing_product_vendor_associations(env):
    """Ensure all product templates and variants have their shahtaj_vendor_id synced with supplierinfo."""
    Template = env['product.template'].sudo().with_context(active_test=False)

    # 1. If template has seller_ids but shahtaj_vendor_id is empty
    templates_without_vendor = Template.search([('shahtaj_vendor_id', '=', False)])
    for tmpl in templates_without_vendor:
        if tmpl.seller_ids:
            tmpl.write({'shahtaj_vendor_id': tmpl.seller_ids[0].partner_id.id})

    # 2. If template has shahtaj_vendor_id, ensure supplierinfo is synced
    templates_with_vendor = Template.search([('shahtaj_vendor_id', '!=', False)])
    for tmpl in templates_with_vendor:
        tmpl._sync_shahtaj_supplierinfo()

