# -*- coding: utf-8 -*-
"""Simplified product defaults for Shahtaj distributors."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools import float_compare

SHAHTAJ_SALE_UOMS = [
    ('kg', 'Kilogram (kg)'),
    ('ton', 'Ton'),
    ('litre', 'Litre'),
    ('piece', 'Piece'),
]

SHAHTAJ_UOM_XML_IDS = {
    'kg': 'uom.product_uom_kgm',
    'ton': 'uom.product_uom_ton',
    'litre': 'uom.product_uom_litre',
    'piece': 'uom.product_uom_unit',
}

SHAHTAJ_DEFAULT_KG_PER_UNIT = {
    'kg': 1.0,
    'ton': 1000.0,
    'litre': 1.0,
    'piece': 1.0,
}


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    shahtaj_sale_uom = fields.Selection(
        SHAHTAJ_SALE_UOMS,
        string='Selling Unit',
        default='piece',
        required=True,
        help='Unit order bookers use when booking this product (fixed per product).',
    )
    shahtaj_kg_per_unit = fields.Float(
        string='Kg per Unit',
        default=1.0,
        digits=(16, 4),
        help=(
            'Kilograms represented by one selling unit. '
            'Used for weight-based targets (e.g. 1 ton = 1000 kg, 1 piece = 0.5 kg).'
        ),
    )
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

    @api.constrains('shahtaj_kg_per_unit')
    def _check_shahtaj_kg_per_unit(self):
        for template in self:
            if float_compare(template.shahtaj_kg_per_unit, 0.0, precision_digits=4) <= 0:
                raise ValidationError(_(
                    'Kg per unit must be greater than zero for product "%(product)s".',
                    product=template.display_name,
                ))

    @api.onchange('shahtaj_sale_uom')
    def _onchange_shahtaj_sale_uom(self):
        if self.shahtaj_sale_uom:
            self.shahtaj_kg_per_unit = SHAHTAJ_DEFAULT_KG_PER_UNIT.get(
                self.shahtaj_sale_uom, 1.0,
            )

    @api.model
    def _shahtaj_uom_for_sale_uom(self, sale_uom):
        xml_id = SHAHTAJ_UOM_XML_IDS.get(sale_uom)
        if xml_id:
            uom = self.env.ref(xml_id, raise_if_not_found=False)
            if uom:
                return uom
        name_map = {
            'kg': 'kg',
            'ton': 't',
            'litre': 'L',
            'piece': 'Units',
        }
        return self.env['uom.uom'].search([
            ('name', 'ilike', name_map.get(sale_uom, sale_uom)),
        ], limit=1)

    def _shahtaj_get_kg_per_unit(self):
        """Return kg equivalent for one selling unit of this template."""
        self.ensure_one()
        return self.shahtaj_kg_per_unit or SHAHTAJ_DEFAULT_KG_PER_UNIT.get(
            self.shahtaj_sale_uom, 1.0,
        )

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        if self.env.context.get('shahtaj_simple_product'):
            defaults = self._shahtaj_product_vals({})
            for key in (
                'type', 'sale_ok', 'purchase_ok', 'is_storable', 'tracking',
                'categ_id', 'shahtaj_sale_uom', 'shahtaj_kg_per_unit', 'uom_id',
                'taxes_id',
            ):
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
            ('active', '=', True),
        ], limit=1)

    @api.model
    def get_shahtaj_default_tax_ids(self):
        """OWL/API helper: default customer tax ids for new products."""
        return self._get_shahtaj_default_sale_taxes().ids

    @api.model
    def get_shahtaj_sale_tax_options(self):
        """Sale tax choices for distributor product forms."""
        taxes = self.env['account.tax'].search([
            ('type_tax_use', '=', 'sale'),
            ('company_id', 'parent_of', self.env.company.id),
            ('active', '=', True),
        ], order='sequence, name')
        default_tax = self._get_shahtaj_default_sale_taxes()
        return [{
            'id': tax.id,
            'name': tax.name,
            'amount': tax.amount,
            'amount_type': tax.amount_type,
            'is_default': tax.id in default_tax.ids,
        } for tax in taxes]

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
        sale_uom = vals.get('shahtaj_sale_uom', 'piece')
        vals.setdefault('shahtaj_sale_uom', sale_uom)
        vals.setdefault(
            'shahtaj_kg_per_unit',
            SHAHTAJ_DEFAULT_KG_PER_UNIT.get(sale_uom, 1.0),
        )
        if 'uom_id' not in vals:
            uom = self._shahtaj_uom_for_sale_uom(sale_uom)
            if uom:
                vals['uom_id'] = uom.id
        if category:
            vals.setdefault('categ_id', category.id)
        if 'taxes_id' not in vals and tax:
            vals['taxes_id'] = [(6, 0, tax.ids)]
        return vals

    def write(self, vals):
        if 'shahtaj_sale_uom' in vals and 'shahtaj_kg_per_unit' not in vals:
            vals.setdefault(
                'shahtaj_kg_per_unit',
                SHAHTAJ_DEFAULT_KG_PER_UNIT.get(vals['shahtaj_sale_uom'], 1.0),
            )
        if 'shahtaj_sale_uom' in vals and 'uom_id' not in vals:
            uom = self._shahtaj_uom_for_sale_uom(vals['shahtaj_sale_uom'])
            if uom:
                vals['uom_id'] = uom.id
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        if self.env.context.get('shahtaj_simple_product'):
            vals_list = [
                self._shahtaj_product_vals(vals) for vals in vals_list
            ]
        else:
            vals_list = [dict(vals) for vals in vals_list]
            for vals in vals_list:
                if vals.get('shahtaj_sale_uom') and 'uom_id' not in vals:
                    uom = self._shahtaj_uom_for_sale_uom(vals['shahtaj_sale_uom'])
                    if uom:
                        vals['uom_id'] = uom.id
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
