# -*- coding: utf-8 -*-
"""Refresh visit targets when order lines change."""
from odoo import api, models


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    @api.model_create_multi
    def create(self, vals_list):
        lines = super().create(vals_list)
        lines.order_id._shahtaj_recompute_visit_targets()
        return lines

    def write(self, vals):
        orders_before = self.order_id
        res = super().write(vals)
        if any(k in vals for k in ('product_id', 'product_uom_qty', 'order_id')):
            (orders_before | self.order_id)._shahtaj_recompute_visit_targets()
        return res

    def unlink(self):
        orders = self.order_id
        res = super().unlink()
        orders._shahtaj_recompute_visit_targets()
        return res
