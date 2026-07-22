# -*- coding: utf-8 -*-
"""Refresh visit targets when order lines change."""
from odoo import api, models


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    def _shahtaj_distributor_needs_stock_sudo(self):
        """Custom-portal distributors lack stock.picking ACL; SOL edits touch pickings."""
        if self.env.su:
            return False
        user = self.env.user
        if user.has_group('stock.group_stock_user'):
            return False
        return user.has_group('shahtaj_oil.group_shahtaj_distributor')

    @api.model_create_multi
    def create(self, vals_list):
        if self._shahtaj_distributor_needs_stock_sudo():
            self.check_access('create')
            lines = super(SaleOrderLine, self.sudo()).create(vals_list)
        else:
            lines = super().create(vals_list)
        lines.order_id._shahtaj_recompute_visit_targets()
        return lines

    def write(self, vals):
        orders_before = self.order_id
        if self._shahtaj_distributor_needs_stock_sudo():
            self.check_access('write')
            res = super(SaleOrderLine, self.sudo()).write(vals)
        else:
            res = super().write(vals)
        if any(k in vals for k in ('product_id', 'product_uom_qty', 'order_id')):
            (orders_before | self.order_id)._shahtaj_recompute_visit_targets()
        return res

    def unlink(self):
        orders = self.order_id
        if self._shahtaj_distributor_needs_stock_sudo():
            self.check_access('unlink')
            res = super(SaleOrderLine, self.sudo()).unlink()
        else:
            res = super().unlink()
        orders._shahtaj_recompute_visit_targets()
        return res
