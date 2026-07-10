# -*- coding: utf-8 -*-
"""Link confirmed sales orders back to the shop visit and daily task."""
from odoo import _, api, fields, models


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    shahtaj_visit_id = fields.Many2one(
        'shahtaj.visit',
        string='Shop Visit',
        ondelete='set null',
        copy=False,
        index=True,
    )
    shahtaj_visit_task_id = fields.Many2one(
        'shahtaj.visit.task',
        string='Visit Task',
        ondelete='set null',
        copy=False,
        index=True,
    )
    shahtaj_order_booker_id = fields.Many2one(
        'res.users',
        string='Order Booker',
        related='shahtaj_visit_id.order_booker_id',
        store=True,
        readonly=True,
    )
    shahtaj_shop_id = fields.Many2one(
        'res.partner',
        string='Shop',
        related='partner_id',
        store=True,
        readonly=True,
    )

    def action_shahtaj_view_visit(self):
        self.ensure_one()
        if not self.shahtaj_visit_id:
            return False
        return {
            'type': 'ir.actions.act_window',
            'name': _('Shop Visit'),
            'res_model': 'shahtaj.visit',
            'res_id': self.shahtaj_visit_id.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def _shahtaj_recompute_visit_targets(self):
        self.env['shahtaj.visit.target']._recompute_for_orders(self)

    @api.model_create_multi
    def create(self, vals_list):
        orders = super().create(vals_list)
        orders._shahtaj_recompute_visit_targets()
        return orders

    def write(self, vals):
        res = super().write(vals)
        if any(k in vals for k in ('state', 'date_order', 'create_uid', 'amount_total')):
            self._shahtaj_recompute_visit_targets()
        return res

    def unlink(self):
        bookers = self.mapped('create_uid')
        dates = [
            fields.Date.to_date(order.date_order)
            for order in self if order.date_order
        ]
        res = super().unlink()
        if bookers and dates:
            targets = self.env['shahtaj.visit.target'].search([
                ('order_booker_id', 'in', bookers.ids),
                ('date_start', '<=', max(dates)),
                ('date_end', '>=', min(dates)),
            ])
            if targets:
                targets._recompute_recordset()
        return res
