# -*- coding: utf-8 -*-
"""One-time repair: clear negative DM van quants caused by over-return to WH.

For each negative van quant (qty = -X):
  1) Set van on-hand to 0 (+X on van)
  2) Reduce main warehouse on-hand by X (remove false inbound from return)

Runs only when upgrading to this module version (Odoo migration registry).
Does not touch jobs, partners, invoices, or positive van stock.
"""
import logging

from odoo import SUPERUSER_ID, api
from odoo.tools import float_compare

_logger = logging.getLogger(__name__)


def _apply_absolute_qty(env, product, location, target_qty):
    """Set absolute on-hand at location via inventory mode (superuser)."""
    env['stock.quant'].with_user(SUPERUSER_ID).with_context(
        inventory_mode=True,
        from_inverse_qty=True,
    ).create({
        'product_id': product.id,
        'location_id': location.id,
        'inventory_quantity': target_qty,
    })._apply_inventory()


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    Quant = env['stock.quant'].sudo()
    Location = env['stock.location'].sudo()
    Warehouse = env['stock.warehouse'].sudo()

    van_parent = env.ref(
        'shahtaj_oil.stock_location_dm_vans',
        raise_if_not_found=False,
    )
    if not van_parent:
        _logger.info(
            'Shahtaj 19.0.1.1.221: no DM vans parent location — skip van-negative repair'
        )
        return

    van_locations = Location.search([
        ('id', 'child_of', van_parent.id),
        ('usage', '=', 'transit'),
    ])
    if not van_locations:
        _logger.info('Shahtaj 19.0.1.1.221: no van child locations — skip')
        return

    negatives = Quant.search([
        ('location_id', 'in', van_locations.ids),
        ('quantity', '<', 0),
    ])
    if not negatives:
        _logger.info('Shahtaj 19.0.1.1.221: no negative van quants — nothing to repair')
        return

    # Aggregate by (company, van_location, product) in case of split quants.
    buckets = {}
    for quant in negatives:
        company = quant.company_id or quant.location_id.company_id or env.company
        key = (company.id, quant.location_id.id, quant.product_id.id)
        buckets.setdefault(key, {
            'company': company,
            'van_location': quant.location_id,
            'product': quant.product_id,
            'qty': 0.0,
        })
        buckets[key]['qty'] += float(quant.quantity or 0.0)

    warehouse_by_company = {}
    fixed = 0
    skipped = 0

    for bucket in buckets.values():
        company = bucket['company']
        van_location = bucket['van_location']
        product = bucket['product']
        van_qty = bucket['qty']
        rounding = (product.uom_id.rounding if product.uom_id else None) or 0.01

        if float_compare(van_qty, 0.0, precision_rounding=rounding) >= 0:
            continue

        fix_qty = -van_qty  # positive amount to restore

        if company.id not in warehouse_by_company:
            warehouse_by_company[company.id] = Warehouse.search([
                ('company_id', '=', company.id),
            ], limit=1)
        warehouse = warehouse_by_company[company.id]
        if not warehouse or not warehouse.lot_stock_id:
            skipped += 1
            _logger.warning(
                'Shahtaj 19.0.1.1.221: skip product=%s van=%s — no warehouse for company %s',
                product.display_name,
                van_location.display_name,
                company.display_name,
            )
            continue

        wh_location = warehouse.lot_stock_id
        wh_quants = Quant.search([
            ('product_id', '=', product.id),
            ('location_id', '=', wh_location.id),
        ])
        wh_qty = sum(float(q.quantity or 0.0) for q in wh_quants)

        # 1) Clear van negative → absolute 0 at this van location for product.
        _apply_absolute_qty(env, product, van_location, 0.0)

        # 2) Remove the same false inbound from main warehouse.
        _apply_absolute_qty(env, product, wh_location, wh_qty - fix_qty)

        fixed += 1
        _logger.info(
            'Shahtaj 19.0.1.1.221: repaired product=%s van=%s '
            'van_qty=%s -> 0; WH %s: %s -> %s (removed false inbound %s)',
            product.display_name,
            van_location.display_name,
            van_qty,
            wh_location.display_name,
            wh_qty,
            wh_qty - fix_qty,
            fix_qty,
        )

    _logger.info(
        'Shahtaj 19.0.1.1.221: van-negative repair done (fixed=%s, skipped=%s)',
        fixed,
        skipped,
    )
