# -*- coding: utf-8 -*-
"""Refresh visit targets and handle line pricing/discounts when order lines change."""
from odoo import api, fields, models
from odoo.tools import float_compare


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    shahtaj_catalog_price = fields.Float(
        string='Catalog Price',
        compute='_compute_shahtaj_catalog_price',
        digits='Product Price',
        store=True,
        readonly=False,
    )
    shahtaj_has_discount = fields.Boolean(
        string='Discounted',
        compute='_compute_shahtaj_line_discounts',
        store=True,
    )
    shahtaj_unit_discount = fields.Float(
        string='Unit Discount',
        compute='_compute_shahtaj_line_discounts',
        digits='Product Price',
        store=True,
    )
    shahtaj_total_discount = fields.Monetary(
        string='Total Discount',
        compute='_compute_shahtaj_line_discounts',
        currency_field='currency_id',
        store=True,
    )
    shahtaj_discount_reason = fields.Char(
        string='Discount Reason',
    )

    @api.depends('product_id', 'product_id.lst_price')
    def _compute_shahtaj_catalog_price(self):
        for line in self:
            if line.product_id:
                line.shahtaj_catalog_price = line.product_id.lst_price
            else:
                line.shahtaj_catalog_price = 0.0

    @api.depends('price_unit', 'product_id', 'product_uom_qty', 'shahtaj_catalog_price')
    def _compute_shahtaj_line_discounts(self):
        for line in self:
            catalog = line.shahtaj_catalog_price or (line.product_id.lst_price if line.product_id else 0.0)
            price = line.price_unit or 0.0
            if line.product_id and float_compare(price, catalog, precision_rounding=0.01) < 0:
                unit_disc = max(0.0, catalog - price)
                line.shahtaj_has_discount = True
                line.shahtaj_unit_discount = unit_disc
                line.shahtaj_total_discount = unit_disc * line.product_uom_qty
                # Auto-fill discount percentage if not already filled
                if not line.discount and catalog > 0:
                    line.discount = ((catalog - price) / catalog) * 100.0
            else:
                line.shahtaj_has_discount = False
                line.shahtaj_unit_discount = 0.0
                line.shahtaj_total_discount = 0.0

    def _shahtaj_distributor_needs_stock_sudo(self):
        """Custom-portal distributors lack stock.picking ACL; SOL edits touch pickings."""
        if self.env.su:
            return False
        user = self.env.user
        if user.has_group('stock.group_stock_user'):
            return False
        return user.has_group('shahtaj_oil.group_shahtaj_distributor')

    _SHAHTAJ_DISCOUNT_LINE_FIELDS = frozenset({
        'price_unit', 'product_id', 'product_uom_qty', 'discount',
    })

    @api.model_create_multi
    def create(self, vals_list):
        if self._shahtaj_distributor_needs_stock_sudo():
            self.check_access('create')
            lines = super(SaleOrderLine, self.sudo()).create(vals_list)
        else:
            lines = super().create(vals_list)
        lines.order_id._shahtaj_recompute_visit_targets()
        if not self.env.context.get('shahtaj_skip_approval_sync'):
            lines.order_id._shahtaj_sync_approval_state_from_lines()
        return lines

    def write(self, vals):
        orders_before = self.order_id
        if self._shahtaj_distributor_needs_stock_sudo():
            self.check_access('write')
            res = super(SaleOrderLine, self.sudo()).write(vals)
        else:
            res = super().write(vals)
        orders = orders_before | self.order_id
        if any(k in vals for k in ('product_id', 'product_uom_qty', 'order_id')):
            orders._shahtaj_recompute_visit_targets()
        if self._SHAHTAJ_DISCOUNT_LINE_FIELDS.intersection(vals):
            orders._shahtaj_sync_approval_state_from_lines()
        return res

    def unlink(self):
        orders = self.order_id
        if self._shahtaj_distributor_needs_stock_sudo():
            self.check_access('unlink')
            res = super(SaleOrderLine, self.sudo()).unlink()
        else:
            res = super().unlink()
        orders._shahtaj_recompute_visit_targets()
        orders._shahtaj_sync_approval_state_from_lines()
        return res

