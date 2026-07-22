# -*- coding: utf-8 -*-
"""Simplified product defaults for Shahtaj distributors."""
from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tools import float_compare, float_is_zero

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
    shahtaj_unit_margin = fields.Float(
        string='Unit Profit',
        compute='_compute_shahtaj_margin',
        digits='Product Price',
        help='Sales price minus cost price per unit.',
    )
    shahtaj_margin_percent = fields.Float(
        string='Margin %',
        compute='_compute_shahtaj_margin',
        digits=(16, 1),
    )
    shahtaj_qty_sold = fields.Float(
        string='Qty Delivered (Sold)',
        compute='_compute_shahtaj_stock_stats',
        digits='Product Unit of Measure',
        help='Quantity delivered to shops from confirmed sales orders.',
    )
    shahtaj_qty_received = fields.Float(
        string='Qty Received',
        compute='_compute_shahtaj_stock_stats',
        digits='Product Unit of Measure',
        help='Total stock received into your warehouse (from Add Stock and opening stock).',
    )
    shahtaj_payable_to_manufacturer = fields.Monetary(
        string='Stock Purchased Value',
        compute='_compute_shahtaj_stock_stats',
        currency_field='currency_id',
        help='Lifetime stock received at frozen receipt cost (purchase value, not cash paid).',
    )

    @api.depends('list_price', 'standard_price')
    def _compute_shahtaj_margin(self):
        for template in self:
            cost = template.standard_price or 0.0
            price = template.list_price or 0.0
            template.shahtaj_unit_margin = price - cost
            template.shahtaj_margin_percent = (
                ((price - cost) / price) * 100.0 if price else 0.0
            )

    @api.depends('product_variant_ids')
    def _compute_shahtaj_stock_stats(self):
        templates = self.filtered('id')
        for template in self - templates:
            template.shahtaj_qty_sold = 0.0
            template.shahtaj_qty_received = 0.0
            template.shahtaj_payable_to_manufacturer = 0.0
        if not templates:
            return

        variant_ids = templates.mapped('product_variant_ids').ids
        SaleLine = self.env['sale.order.line']
        sold_groups = SaleLine.read_group(
            domain=[
                ('product_id', 'in', variant_ids),
                ('order_id.state', 'in', ('sale', 'done')),
            ],
            fields=[ 'qty_delivered'],
            groupby=['product_id'],
            lazy=False,
        )
        sold_by_variant = {
            group['product_id'][0]: group['qty_delivered']
            for group in sold_groups if group.get('product_id')
        }

        Receipt = self.env['shahtaj.stock.receipt']
        received_groups = Receipt.read_group(
            [('product_id', 'in', variant_ids)],
            ['qty:sum', 'subtotal:sum'],
            ['product_id'],
            lazy=False,
        )
        received_qty_by_variant = {
            group['product_id'][0]: group['qty']
            for group in received_groups if group.get('product_id')
        }
        purchased_by_variant = {
            group['product_id'][0]: group['subtotal']
            for group in received_groups if group.get('product_id')
        }

        for template in templates:
            variants = template.product_variant_ids
            sold = sum(sold_by_variant.get(v.id, 0.0) for v in variants)
            received = sum(received_qty_by_variant.get(v.id, 0.0) for v in variants)
            purchased = sum(purchased_by_variant.get(v.id, 0.0) for v in variants)
            template.shahtaj_qty_sold = sold
            template.shahtaj_qty_received = received
            template.shahtaj_payable_to_manufacturer = purchased

    @api.depends('qty_available', 'product_variant_ids')
    def _compute_shahtaj_qty_bookable(self):
        for template in self:
            variant = template.product_variant_id
            if variant:
                bookable = variant._get_shahtaj_bookable_qty()
                if bookable is not None:
                    template.shahtaj_qty_bookable = bookable
                else:
                    # Non-storable: fall back to on-hand without stock.move ACL issues.
                    template.shahtaj_qty_bookable = template.sudo().qty_available
            else:
                template.shahtaj_qty_bookable = 0.0

    def _shahtaj_needs_stock_qty_sudo(self):
        """Custom-portal distributors / bookers lack stock.move ACL for qty fields."""
        if self.env.su:
            return False
        user = self.env.user
        if user.has_group('stock.group_stock_user'):
            return False
        return user.has_group('shahtaj_oil.group_shahtaj_distributor') or user.has_group(
            'shahtaj_oil.group_shahtaj_order_booker'
        )

    def _compute_quantities(self):
        # Template qty aggregates variant reads; those hit stock.move with compute_sudo=False.
        if self._shahtaj_needs_stock_qty_sudo():
            return super(ProductTemplate, self.sudo())._compute_quantities()
        return super()._compute_quantities()

    def _compute_nbr_moves(self):
        if self._shahtaj_needs_stock_qty_sudo():
            return super(ProductTemplate, self.sudo())._compute_nbr_moves()
        return super()._compute_nbr_moves()

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
            # Prefill UI defaults only — create() must not re-apply tax if user cleared it.
            defaults = self._shahtaj_product_vals({}, apply_tax_default=True)
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
    def _shahtaj_product_vals(self, vals, apply_tax_default=False):
        """Merge Shahtaj defaults into product create values.

        Tax defaults are only for form prefills (`default_get`). On create we must
        respect an empty Customer Taxes selection — re-injecting company tax when
        `taxes_id` is omitted is what made "clear tax" fail after save.
        """
        vals = dict(vals)
        category = self._ensure_shahtaj_category_accounts()
        vals.setdefault('type', 'consu')
        vals.setdefault('sale_ok', True)
        vals.setdefault('purchase_ok', False)
        vals.setdefault('is_storable', True)
        vals.setdefault('tracking', 'none')
        vals.setdefault('invoice_policy', 'delivery')
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
        if apply_tax_default and 'taxes_id' not in vals:
            tax = self._get_shahtaj_default_sale_taxes()
            if tax:
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
        # Custom-portal distributors have product write ACL but not stock.move /
        # orderpoint ACL. Archive/edit still touch those via stock/product hooks.
        needs_sudo = self._shahtaj_distributor_needs_stock_sudo()
        if needs_sudo:
            self.check_access('write')
            res = super(ProductTemplate, self.sudo()).write(vals)
        else:
            res = super().write(vals)
        # Core archives variants when template is archived, but does not restore
        # them when the template is unarchived — keep active flags in sync.
        if vals.get('active') is True:
            templates = self.sudo() if needs_sudo else self
            inactive_variants = templates.with_context(active_test=False).mapped(
                'product_variant_ids',
            ).filtered(lambda variant: not variant.active)
            if inactive_variants:
                inactive_variants.write({'active': True})
        return res

    @api.model_create_multi
    def create(self, vals_list):
        if self.env.context.get('shahtaj_simple_product'):
            vals_list = [
                self._shahtaj_product_vals(vals, apply_tax_default=False)
                for vals in vals_list
            ]
            # Prefill only for the form. On create, missing taxes_id usually means
            # the user cleared Customer Taxes (empty many2many is often omitted) —
            # write an explicit empty command so company/core defaults cannot reattach.
            for vals in vals_list:
                if 'taxes_id' not in vals:
                    vals['taxes_id'] = [(5, 0, 0)]
                else:
                    # Normalize empty set commands so [(6, 0, [])] stays empty.
                    commands = vals.get('taxes_id') or []
                    if (
                        isinstance(commands, (list, tuple))
                        and len(commands) == 1
                        and commands[0][:2] == (6, 0)
                        and not commands[0][2]
                    ):
                        vals['taxes_id'] = [(5, 0, 0)]
        else:
            vals_list = [dict(vals) for vals in vals_list]
            for vals in vals_list:
                if vals.get('shahtaj_sale_uom') and 'uom_id' not in vals:
                    uom = self._shahtaj_uom_for_sale_uom(vals['shahtaj_sale_uom'])
                    if uom:
                        vals['uom_id'] = uom.id
        products = super().create(vals_list)
        # Portal create passes opening qty in context so stock is set in the same
        # request (avoids a fragile follow-up RPC after create).
        initial_qty = self.env.context.get('shahtaj_initial_on_hand')
        if initial_qty is not None:
            try:
                initial_qty = float(initial_qty)
            except (TypeError, ValueError):
                initial_qty = 0.0
            if float_compare(initial_qty, 0.0, precision_digits=4) > 0:
                for product in products.filtered('is_storable'):
                    product.action_shahtaj_set_on_hand_qty(
                        initial_qty,
                        receipt_source='opening',
                    )
        return products

    def _shahtaj_log_stock_receipt(self, qty, unit_cost=None, source='add_stock'):
        """Record manufacturer stock receipt with frozen unit cost."""
        self.ensure_one()
        if float_compare(qty, 0.0, precision_rounding=self.uom_id.rounding) <= 0:
            return
        variant = self.product_variant_id
        # Receipt ACL is on the financial group; stock add is allowed for all
        # distributors via portal, so log with elevated rights only here.
        Receipt = self.env['shahtaj.stock.receipt']
        if self.env.user.has_group('shahtaj_oil.group_shahtaj_distributor'):
            Receipt = Receipt.sudo()
        Receipt.create({
            'product_id': variant.id,
            'qty': qty,
            'unit_cost': (
                unit_cost if unit_cost is not None else (self.standard_price or 0.0)
            ),
            'source': source,
            'receipt_date': fields.Date.context_today(self),
        })

    def _shahtaj_distributor_needs_stock_sudo(self):
        """Custom-portal distributors lack Inventory app groups but must adjust stock."""
        user = self.env.user
        if self.env.su:
            return False
        if user.has_group('stock.group_stock_user'):
            return False
        return user.has_group('shahtaj_oil.group_shahtaj_distributor')

    def _shahtaj_ensure_distributor_stock_access(self):
        """Only Shahtaj distributors (or real Inventory users) may use stock helpers."""
        user = self.env.user
        if self.env.su:
            return
        if user.has_group('stock.group_stock_user'):
            return
        if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
            return
        raise AccessError(_(
            'Only distributors can adjust Shahtaj warehouse stock from the portal.'
        ))

    def action_shahtaj_set_on_hand_qty(self, quantity, receipt_source=None):
        """Set absolute on-hand quantity in the main warehouse."""
        self.ensure_one()
        self._shahtaj_ensure_distributor_stock_access()
        if not self.is_storable:
            raise UserError(_('Enable inventory tracking before setting stock.'))

        # Elevate only the inventory apply: custom-portal users intentionally do not
        # have stock.move ACL (native Inventory menus stay hidden).
        stock_self = self.sudo() if self._shahtaj_distributor_needs_stock_sudo() else self
        warehouse = stock_self.env['stock.warehouse'].search([
            ('company_id', '=', self.env.company.id),
        ], limit=1)
        if not warehouse:
            raise UserError(_(
                'No warehouse found for company "%(company)s".',
                company=self.env.company.display_name,
            ))
        old_qty = stock_self.qty_available
        variant = stock_self.product_variant_id
        stock_self.env['stock.quant'].with_context(
            inventory_mode=True,
            from_inverse_qty=True,
        ).create({
            'product_id': variant.id,
            'location_id': warehouse.lot_stock_id.id,
            'inventory_quantity': quantity,
        })._apply_inventory()

        if not self.env.context.get('shahtaj_skip_receipt_log'):
            delta = quantity - old_qty
            if float_compare(delta, 0.0, precision_rounding=self.uom_id.rounding) > 0:
                source = receipt_source
                if source is None:
                    source = 'opening' if float_is_zero(
                        old_qty, precision_rounding=self.uom_id.rounding,
                    ) else 'adjustment'
                self._shahtaj_log_stock_receipt(delta, source=source)

    def action_shahtaj_add_on_hand_qty(self, quantity):
        """Increase on-hand quantity."""
        self.ensure_one()
        self._shahtaj_ensure_distributor_stock_access()
        if float_compare(quantity, 0.0, precision_rounding=self.uom_id.rounding) <= 0:
            raise UserError(_('Quantity to add must be greater than zero.'))
        # Read current qty with the same rights used for inventory apply.
        stock_self = self.sudo() if self._shahtaj_distributor_needs_stock_sudo() else self
        self._shahtaj_log_stock_receipt(quantity, source='add_stock')
        self.with_context(shahtaj_skip_receipt_log=True).action_shahtaj_set_on_hand_qty(
            stock_self.qty_available + quantity,
        )

    def _shahtaj_add_on_hand_qty(self, quantity):
        """Backward-compatible alias used by stock wizards."""
        return self.action_shahtaj_add_on_hand_qty(quantity)