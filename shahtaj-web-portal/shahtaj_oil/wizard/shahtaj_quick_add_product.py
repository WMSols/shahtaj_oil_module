# -*- coding: utf-8 -*-
"""Distributor wizard: create a product with Shahtaj defaults and optional opening stock."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare


class ShahtajQuickAddProductWizard(models.TransientModel):
    _name = 'shahtaj.quick.add.product.wizard'
    _description = 'Quick Add Product'

    name = fields.Char(string='Product Name', required=True)
    standard_price = fields.Float(
        string='Cost Price',
        digits='Product Price',
        default=0.0,
        help='What you pay the manufacturer per unit.',
    )
    list_price = fields.Float(
        string='Sales Price',
        required=True,
        default=1.0,
        digits='Product Price',
    )
    opening_qty = fields.Float(
        string='Opening Stock',
        default=0.0,
        digits='Product Unit of Measure',
        help='Initial quantity in your warehouse (leave 0 if none yet).',
    )
    track_inventory = fields.Boolean(
        string='Track Inventory',
        default=True,
        help='Required for order bookers to see available quantity.',
    )
    shahtaj_sale_uom = fields.Selection(
        selection=[
            ('kg', 'Kilogram (kg)'),
            ('ton', 'Ton'),
            ('litre', 'Litre'),
            ('piece', 'Piece'),
        ],
        string='Selling Unit',
        default='piece',
        required=True,
    )
    shahtaj_kg_per_unit = fields.Float(
        string='Kg per Unit',
        default=1.0,
        digits=(16, 4),
        help='Kilograms per one selling unit (for litre/piece products).',
    )
    tax_ids = fields.Many2many(
        'account.tax',
        string='Customer Taxes',
        domain="[('type_tax_use', '=', 'sale'), ('active', '=', True)]",
        help='Taxes applied when this product is sold.',
    )

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        if 'tax_ids' in fields_list and not res.get('tax_ids'):
            default_tax = self.env['product.template']._get_shahtaj_default_sale_taxes()
            if default_tax:
                res['tax_ids'] = [(6, 0, default_tax.ids)]
        return res

    @api.onchange('shahtaj_sale_uom')
    def _onchange_shahtaj_sale_uom(self):
        defaults = {
            'kg': 1.0,
            'ton': 1000.0,
            'litre': 1.0,
            'piece': 1.0,
        }
        if self.shahtaj_sale_uom:
            self.shahtaj_kg_per_unit = defaults.get(self.shahtaj_sale_uom, 1.0)

    @api.constrains('list_price', 'opening_qty', 'standard_price')
    def _check_values(self):
        for wizard in self:
            if float_compare(wizard.standard_price, 0.0, precision_digits=2) < 0:
                raise UserError(_('Cost price cannot be negative.'))
            if float_compare(wizard.list_price, 0.0, precision_digits=2) < 0:
                raise UserError(_('Sales price cannot be negative.'))
            if float_compare(wizard.opening_qty, 0.0, precision_digits=2) < 0:
                raise UserError(_('Opening stock cannot be negative.'))

    def action_create_product(self):
        self.ensure_one()
        Product = self.env['product.template'].with_context(shahtaj_simple_product=True)
        product = Product.create({
            'name': self.name.strip(),
            'standard_price': self.standard_price,
            'list_price': self.list_price,
            'is_storable': self.track_inventory,
            'shahtaj_sale_uom': self.shahtaj_sale_uom,
            'shahtaj_kg_per_unit': self.shahtaj_kg_per_unit,
            'taxes_id': [(6, 0, self.tax_ids.ids)],
        })
        if self.track_inventory and self.opening_qty > 0:
            product._shahtaj_set_on_hand_qty(self.opening_qty)
        return {
            'type': 'ir.actions.act_window',
            'name': _('Product'),
            'res_model': 'product.template',
            'res_id': product.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_product_form').id, 'form'),
            ],
        }
