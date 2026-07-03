# -*- coding: utf-8 -*-
"""Link confirmed sales orders back to the shop visit and daily task."""
from odoo import _, fields, models


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
