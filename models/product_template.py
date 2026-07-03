# -*- coding: utf-8 -*-
"""Simplified product defaults for Shahtaj distributors."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    shahtaj_qty_bookable = fields.Float(
        string='Available to Book',
        compute='_compute_shahtaj_qty_bookable',
        digits='Product Unit of Measure',
        help='Quantity order bookers can still place on visits.',
    )

    @api.depends('qty_available', 'product_variant_ids')
    def _compute_shahtaj_qty_bookable(self):
        for template in self:
            variant = template.product_variant_id
            if variant:
                bookable = variant._get_shahtaj_bookable_qty()
                template.shahtaj_qty_bookable = (
                    bookable if bookable is not None else template.qty_available
                )
            else:
                template.shahtaj_qty_bookable = 0.0

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        if self.env.context.get('shahtaj_simple_product'):
            defaults = self._shahtaj_product_vals({})
            for key in ('type', 'sale_ok', 'purchase_ok', 'is_storable', 'tracking', 'categ_id'):
                if key in fields_list and key not in res and defaults.get(key) is not None:
                    res[key] = defaults[key]
        return res

    @api.model
    def _get_shahtaj_default_category(self):
        category = self.env.ref(
            'shahtaj_oil.product_category_shahtaj',
            raise_if_not_found=False,
        )
        if category:
            return category
        return self.env['product.category'].search([
            ('name', '=', 'Shahtaj Products'),
        ], limit=1)

    @api.model
    def _get_shahtaj_default_sale_taxes(self):
        company = self.env.company
        if company.account_sale_tax_id:
            return company.account_sale_tax_id
        return self.env['account.tax'].search([
            ('type_tax_use', '=', 'sale'),
            ('company_id', 'parent_of', company.id),
        ], limit=1)

    @api.model
    def _ensure_shahtaj_category_accounts(self):
        """Link income account on the Shahtaj category once CoA exists."""
        category = self._get_shahtaj_default_category()
        if not category:
            return category
        if category.property_account_income_categ_id:
            return category
        income = self.env['account.account'].search([
            ('company_ids', 'in', self.env.company.id),
            ('account_type', '=', 'income'),
        ], limit=1)
        if income:
            category.property_account_income_categ_id = income
        return category

    @api.model
    def _shahtaj_setup_category_accounts(self):
        """Called from data on module install/upgrade."""
        self._ensure_shahtaj_category_accounts()

    @api.model
    def _shahtaj_product_vals(self, vals):
        """Merge Shahtaj defaults into product create values."""
        vals = dict(vals)
        category = self._ensure_shahtaj_category_accounts()
        tax = self._get_shahtaj_default_sale_taxes()
        vals.setdefault('type', 'consu')
        vals.setdefault('sale_ok', True)
        vals.setdefault('purchase_ok', False)
        vals.setdefault('is_storable', True)
        vals.setdefault('tracking', 'none')
        if category:
            vals.setdefault('categ_id', category.id)
        if tax:
            vals['taxes_id'] = [(6, 0, tax.ids)]
        return vals

    @api.model_create_multi
    def create(self, vals_list):
        if self.env.context.get('shahtaj_simple_product'):
            vals_list = [
                self._shahtaj_product_vals(vals) for vals in vals_list
            ]
        return super().create(vals_list)

    def action_shahtaj_set_on_hand_qty(self, quantity):
        """Set absolute on-hand quantity in the main warehouse."""
        self.ensure_one()
        if not self.is_storable:
            raise UserError(_('Enable inventory tracking before setting stock.'))
        warehouse = self.env['stock.warehouse'].search([
            ('company_id', '=', self.env.company.id),
        ], limit=1)
        if not warehouse:
            raise UserError(_(
                'No warehouse found for company "%(company)s".',
                company=self.env.company.display_name,
            ))
        variant = self.product_variant_id
        self.env['stock.quant'].with_context(
            inventory_mode=True,
            from_inverse_qty=True,
        ).create({
            'product_id': variant.id,
            'location_id': warehouse.lot_stock_id.id,
            'inventory_quantity': quantity,
        })._apply_inventory()

    def action_shahtaj_add_on_hand_qty(self, quantity):
        """Increase on-hand quantity."""
        self.ensure_one()
        if float_compare(quantity, 0.0, precision_rounding=self.uom_id.rounding) <= 0:
            raise UserError(_('Quantity to add must be greater than zero.'))
        self.action_shahtaj_set_on_hand_qty(self.qty_available + quantity)
