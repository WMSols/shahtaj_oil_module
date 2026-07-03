# -*- coding: utf-8 -*-
"""Distributor wizard: add stock to an existing product."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare


class ShahtajAddStockWizard(models.TransientModel):
    _name = 'shahtaj.add.stock.wizard'
    _description = 'Add Stock'

    product_id = fields.Many2one(
        'product.template',
        string='Product',
        required=True,
        domain=[('sale_ok', '=', True), ('is_storable', '=', True)],
    )
    qty_on_hand = fields.Float(
        related='product_id.qty_available',
        string='Current On Hand',
        digits='Product Unit of Measure',
    )
    qty_to_add = fields.Float(
        string='Quantity to Add',
        required=True,
        default=1.0,
        digits='Product Unit of Measure',
    )

    @api.constrains('qty_to_add')
    def _check_qty_to_add(self):
        for wizard in self:
            if float_compare(wizard.qty_to_add, 0.0, precision_digits=2) <= 0:
                raise UserError(_('Quantity to add must be greater than zero.'))

    def action_add_stock(self):
        self.ensure_one()
        self.product_id._shahtaj_add_on_hand_qty(self.qty_to_add)
        return {
            'type': 'ir.actions.act_window',
            'name': _('Stock Overview'),
            'res_model': 'product.template',
            'view_mode': 'list,form',
            'target': 'current',
            'domain': [('id', '=', self.product_id.id)],
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_product_stock_list').id, 'list'),
                (self.env.ref('shahtaj_oil.view_shahtaj_product_form').id, 'form'),
            ],
        }
