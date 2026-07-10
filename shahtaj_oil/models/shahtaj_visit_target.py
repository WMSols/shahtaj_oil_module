# -*- coding: utf-8 -*-
"""Sales/visit targets per order booker for a date range.

Progress is computed from completed visits and confirmed sale orders.
"""
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

TARGET_TYPES = [
    ('visit_count', 'Visit Count'),
    ('order_count', 'Order Count'),
    ('sales_amount', 'Sales Amount'),
    ('product_qty', 'Product Quantity'),
    ('product_weight', 'Product Weight'),
]

TARGET_WEIGHT_UOMS = [
    ('kg', 'Kilogram (kg)'),
    ('ton', 'Ton'),
]

KG_PER_TON = 1000.0


class ShahtajVisitTarget(models.Model):
    _name = 'shahtaj.visit.target'
    _description = 'Order Booker Target'
    _order = 'date_start desc, order_booker_id'

    name = fields.Char(compute='_compute_name', store=True)
    order_booker_id = fields.Many2one(
        'res.users',
        string='Order Booker',
        required=True,
        index=True,
        ondelete='restrict',
    )
    date_start = fields.Date(string='Period Start', required=True)
    date_end = fields.Date(string='Period End', required=True)
    target_type = fields.Selection(
        TARGET_TYPES,
        string='Target Type',
        required=True,
        default='sales_amount',
    )
    target_value = fields.Float(string='Target Value', required=True)
    target_weight_uom = fields.Selection(
        TARGET_WEIGHT_UOMS,
        string='Weight Unit',
        default='kg',
        help='Whether the target is expressed in kilograms or tons.',
    )
    product_id = fields.Many2one(
        'product.product',
        string='Product',
        help='Required when target type is Product Quantity or Product Weight.',
    )
    currency_id = fields.Many2one(
        'res.currency',
        string='Currency',
        default=lambda self: self.env.company.currency_id,
    )
    achieved_value = fields.Float(
        string='Achieved',
        compute='_compute_progress',
        store=True,
    )
    remaining_value = fields.Float(
        string='Remaining',
        compute='_compute_progress',
        store=True,
    )
    progress_percent = fields.Float(
        string='Progress %',
        compute='_compute_progress',
        store=True,
    )
    active = fields.Boolean(default=True)

    @api.depends('order_booker_id', 'target_type', 'date_start', 'date_end', 'product_id')
    def _compute_name(self):
        type_labels = dict(TARGET_TYPES)
        for target in self:
            booker = target.order_booker_id.name or '?'
            ttype = type_labels.get(target.target_type, '?')
            if target.target_type in ('product_qty', 'product_weight') and target.product_id:
                target.name = f'{booker} — {ttype} ({target.product_id.display_name})'
            else:
                target.name = f'{booker} — {ttype}'

    @api.constrains(
        'date_start', 'date_end', 'target_value', 'target_type',
        'product_id', 'target_weight_uom',
    )
    def _check_target(self):
        for target in self:
            if target.date_end < target.date_start:
                raise ValidationError(_('Period end must be on or after period start.'))
            if target.target_value <= 0:
                raise ValidationError(_('Target value must be greater than zero.'))
            if target.target_type == 'product_qty' and not target.product_id:
                raise ValidationError(_(
                    'Select a product when target type is Product Quantity.'
                ))
            if target.target_type == 'product_weight':
                if not target.product_id:
                    raise ValidationError(_(
                        'Select a product when target type is Product Weight.'
                    ))
                if not target.target_weight_uom:
                    raise ValidationError(_(
                        'Select kg or ton for the weight target unit.'
                    ))

    @api.model
    def _weight_to_kg(self, value, weight_uom):
        if weight_uom == 'ton':
            return value * KG_PER_TON
        return value

    @api.model
    def _kg_to_weight(self, kg_value, weight_uom):
        if weight_uom == 'ton':
            return kg_value / KG_PER_TON
        return kg_value

    def _achieved_product_weight_kg(self):
        """Sum sold weight in kg for this target's product and period."""
        self.ensure_one()
        if not self.product_id:
            return 0.0
        lines = self.env['sale.order.line'].search([
            ('order_id.create_uid', '=', self.order_booker_id.id),
            ('order_id.date_order', '>=', self.date_start),
            ('order_id.date_order', '<=', self.date_end),
            ('order_id.state', '!=', 'cancel'),
            ('product_id', '=', self.product_id.id),
        ])
        achieved_kg = 0.0
        for line in lines:
            kg_per_unit = line.product_id._shahtaj_get_kg_per_unit()
            achieved_kg += line.product_uom_qty * kg_per_unit
        return achieved_kg

    @api.depends(
        'target_type', 'target_value', 'target_weight_uom',
        'date_start', 'date_end', 'order_booker_id', 'product_id',
    )
    def _compute_progress(self):
        """Count visits, orders, sales total, product qty, or weight in the period."""
        Task = self.env['shahtaj.visit.task']
        SaleOrder = self.env['sale.order']
        for target in self:
            achieved = 0.0
            remaining = 0.0
            if target.date_start and target.date_end and target.order_booker_id:
                if target.target_type == 'visit_count':
                    start_dt = fields.Datetime.to_datetime(target.date_start)
                    end_dt = fields.Datetime.to_datetime(target.date_end) + timedelta(days=1)
                    achieved = self.env['shahtaj.visit'].search_count([
                        ('order_booker_id', '=', target.order_booker_id.id),
                        ('state', '=', 'completed'),
                        ('started_at', '>=', start_dt),
                        ('started_at', '<', end_dt),
                    ])
                elif target.target_type == 'order_count':
                    achieved = SaleOrder.search_count([
                        ('create_uid', '=', target.order_booker_id.id),
                        ('date_order', '>=', target.date_start),
                        ('date_order', '<=', target.date_end),
                        ('state', '!=', 'cancel'),
                    ])
                elif target.target_type == 'sales_amount':
                    orders = SaleOrder.search([
                        ('create_uid', '=', target.order_booker_id.id),
                        ('date_order', '>=', target.date_start),
                        ('date_order', '<=', target.date_end),
                        ('state', '!=', 'cancel'),
                    ])
                    achieved = sum(orders.mapped('amount_total'))
                elif target.target_type == 'product_qty' and target.product_id:
                    lines = self.env['sale.order.line'].search([
                        ('order_id.create_uid', '=', target.order_booker_id.id),
                        ('order_id.date_order', '>=', target.date_start),
                        ('order_id.date_order', '<=', target.date_end),
                        ('order_id.state', '!=', 'cancel'),
                        ('product_id', '=', target.product_id.id),
                    ])
                    achieved = sum(lines.mapped('product_uom_qty'))
                elif target.target_type == 'product_weight' and target.product_id:
                    achieved_kg = target._achieved_product_weight_kg()
                    achieved = self._kg_to_weight(
                        achieved_kg, target.target_weight_uom,
                    )

            target.achieved_value = achieved
            if target.target_type == 'product_weight':
                remaining = max(0.0, target.target_value - achieved)
            elif target.target_value:
                remaining = max(0.0, target.target_value - achieved)
            target.remaining_value = remaining
            if target.target_value:
                target.progress_percent = min(100.0, (achieved / target.target_value) * 100.0)
            else:
                target.progress_percent = 0.0

    @api.model
    def _recompute_for_orders(self, orders):
        """Refresh stored progress when sale orders change."""
        if not orders:
            return
        booker_ids = set()
        dates = []
        for order in orders:
            if order.create_uid:
                booker_ids.add(order.create_uid.id)
            if order.date_order:
                dates.append(fields.Date.to_date(order.date_order))
        if not booker_ids or not dates:
            return
        targets = self.search([
            ('order_booker_id', 'in', list(booker_ids)),
            ('date_start', '<=', max(dates)),
            ('date_end', '>=', min(dates)),
            ('target_type', 'in', ('product_qty', 'product_weight', 'order_count', 'sales_amount')),
        ])
        if targets:
            targets._recompute_recordset()
