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
]


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
    product_id = fields.Many2one(
        'product.product',
        string='Product',
        help='Required when target type is Product Quantity.',
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
    progress_percent = fields.Float(
        string='Progress %',
        compute='_compute_progress',
        store=True,
    )
    active = fields.Boolean(default=True)

    @api.depends('order_booker_id', 'target_type', 'date_start', 'date_end')
    def _compute_name(self):
        type_labels = dict(TARGET_TYPES)
        for target in self:
            booker = target.order_booker_id.name or '?'
            ttype = type_labels.get(target.target_type, '?')
            target.name = f'{booker} — {ttype}'

    @api.constrains('date_start', 'date_end', 'target_value', 'target_type', 'product_id')
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

    @api.depends(
        'target_type', 'target_value', 'date_start', 'date_end',
        'order_booker_id', 'product_id',
    )
    def _compute_progress(self):
        """Count visits, orders, sales total, or product qty in the target period."""
        Task = self.env['shahtaj.visit.task']
        SaleOrder = self.env['sale.order']
        for target in self:
            achieved = 0.0
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

            target.achieved_value = achieved
            if target.target_value:
                target.progress_percent = min(100.0, (achieved / target.target_value) * 100.0)
            else:
                target.progress_percent = 0.0
