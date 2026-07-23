# -*- coding: utf-8 -*-
"""Dated manufacturer stock summary with frozen receipt costs."""
from datetime import datetime, time

from odoo import _, api, fields, models


class ShahtajManufacturerSummary(models.TransientModel):
    _name = 'shahtaj.manufacturer.summary'
    _description = 'Manufacturer Stock Summary'

    currency_id = fields.Many2one(
        'res.currency',
        default=lambda self: self.env.company.currency_id,
        required=True,
    )
    date_from = fields.Date(
        string='From',
        required=True,
        default=lambda self: fields.Date.context_today(self).replace(day=1),
    )
    date_to = fields.Date(
        string='To',
        required=True,
        default=fields.Date.context_today,
    )
    total_received_qty = fields.Float(
        string='Received (period)',
        digits='Product Unit of Measure',
    )
    total_delivered_qty = fields.Float(
        string='Delivered (period)',
        digits='Product Unit of Measure',
    )
    total_purchase_value_period = fields.Monetary(
        string='Purchased Value (period)',
        currency_field='currency_id',
        help='Stock received in the selected period at frozen receipt cost.',
    )
    total_purchase_value_lifetime = fields.Monetary(
        string='Purchased Value (lifetime)',
        currency_field='currency_id',
        help='All stock ever received at frozen receipt cost (not cash paid).',
    )
    total_on_hand_qty = fields.Float(
        string='On Hand (today)',
        digits='Product Unit of Measure',
    )
    total_stock_value_on_hand = fields.Monetary(
        string='Stock Value On Hand',
        currency_field='currency_id',
        help='Current on-hand quantity valued at weighted average receipt cost.',
    )
    line_ids = fields.One2many(
        'shahtaj.manufacturer.summary.line',
        'summary_id',
        string='Products',
    )

    @api.model
    def action_open_manufacturer_summary(self):
        record = self.create({})
        record.action_refresh()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Manufacturer Summary'),
            'res_model': 'shahtaj.manufacturer.summary',
            'res_id': record.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref(
                    'shahtaj_oil.view_shahtaj_manufacturer_summary_form'
                ).id,
                'form',
            )],
        }

    def action_refresh(self):
        self.ensure_one()
        self.line_ids.unlink()
        stats = self._gather_stats()
        lines_vals = [
            (0, 0, line) for line in stats.pop('lines', [])
        ]
        self.write({**stats, 'line_ids': lines_vals})
        return {
            'type': 'ir.actions.act_window',
            'name': _('Manufacturer Summary'),
            'res_model': 'shahtaj.manufacturer.summary',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref(
                    'shahtaj_oil.view_shahtaj_manufacturer_summary_form'
                ).id,
                'form',
            )],
        }

    def action_print_summary(self):
        self.ensure_one()
        return self.env.ref(
            'shahtaj_oil.action_report_shahtaj_manufacturer_summary'
        ).report_action(self)

    def _gather_stats(self):
        self.ensure_one()
        Receipt = self.env['shahtaj.stock.receipt'].sudo()
        Move = self.env['stock.move'].sudo()
        Template = self.env['product.template'].sudo()

        date_from = self.date_from
        date_to = self.date_to
        # Active products only — archiving a product hides it from this summary;
        # unarchiving brings its receipt history back into the totals.
        templates = Template.with_context(active_test=True).search([
            ('sale_ok', '=', True),
            ('is_storable', '=', True),
            ('active', '=', True),
        ])

        total_received_qty = 0.0
        total_delivered_qty = 0.0
        total_purchase_value_period = 0.0
        total_purchase_value_lifetime = 0.0
        total_on_hand_qty = 0.0
        total_stock_value_on_hand = 0.0
        lines = []

        for template in templates:
            variants = template.product_variant_ids
            if not variants:
                continue
            variant_ids = variants.ids

            period_receipts = Receipt.search([
                ('product_id', 'in', variant_ids),
                ('receipt_date', '>=', date_from),
                ('receipt_date', '<=', date_to),
                *Receipt._shahtaj_active_product_domain(),
            ])
            lifetime_receipts = Receipt.search([
                ('product_id', 'in', variant_ids),
                *Receipt._shahtaj_active_product_domain(),
            ])

            qty_received = sum(period_receipts.mapped('qty'))
            purchase_value_period = sum(period_receipts.mapped('subtotal'))
            purchase_value_lifetime = sum(lifetime_receipts.mapped('subtotal'))
            lifetime_qty = sum(lifetime_receipts.mapped('qty'))
            avg_cost = (
                purchase_value_lifetime / lifetime_qty
                if lifetime_qty else template.standard_price
            )

            delivered_moves = Move.search([
                ('product_id', 'in', variant_ids),
                ('state', '=', 'done'),
                ('location_dest_id.usage', '=', 'customer'),
                ('date', '>=', fields.Datetime.to_datetime(date_from)),
                ('date', '<=', datetime.combine(date_to, time(23, 59, 59))),
            ])
            qty_delivered = sum(delivered_moves.mapped('product_uom_qty'))

            on_hand = template.qty_available
            stock_value = on_hand * avg_cost

            if not any([
                qty_received, qty_delivered, on_hand, purchase_value_lifetime,
            ]):
                continue

            lines.append({
                'product_id': template.id,
                'avg_unit_cost': avg_cost,
                'qty_received': qty_received,
                'purchase_value_period': purchase_value_period,
                'purchase_value_lifetime': purchase_value_lifetime,
                'qty_delivered': qty_delivered,
                'qty_on_hand': on_hand,
                'stock_value_on_hand': stock_value,
            })

            total_received_qty += qty_received
            total_delivered_qty += qty_delivered
            total_purchase_value_period += purchase_value_period
            total_purchase_value_lifetime += purchase_value_lifetime
            total_on_hand_qty += on_hand
            total_stock_value_on_hand += stock_value

        lines.sort(key=lambda line: line['purchase_value_period'], reverse=True)

        return {
            'total_received_qty': total_received_qty,
            'total_delivered_qty': total_delivered_qty,
            'total_purchase_value_period': total_purchase_value_period,
            'total_purchase_value_lifetime': total_purchase_value_lifetime,
            'total_on_hand_qty': total_on_hand_qty,
            'total_stock_value_on_hand': total_stock_value_on_hand,
            'lines': lines,
        }


class ShahtajManufacturerSummaryLine(models.TransientModel):
    _name = 'shahtaj.manufacturer.summary.line'
    _description = 'Manufacturer Summary Product Line'
    _order = 'purchase_value_period desc'

    summary_id = fields.Many2one(
        'shahtaj.manufacturer.summary',
        required=True,
        ondelete='cascade',
    )
    currency_id = fields.Many2one(
        related='summary_id.currency_id',
    )
    product_id = fields.Many2one(
        'product.template',
        string='Product',
        required=True,
    )
    avg_unit_cost = fields.Monetary(
        string='Avg Cost / Unit',
        currency_field='currency_id',
    )
    qty_received = fields.Float(
        string='Received',
        digits='Product Unit of Measure',
    )
    purchase_value_period = fields.Monetary(
        string='Purchased (period)',
        currency_field='currency_id',
    )
    purchase_value_lifetime = fields.Monetary(
        string='Purchased (lifetime)',
        currency_field='currency_id',
    )
    qty_delivered = fields.Float(
        string='Delivered',
        digits='Product Unit of Measure',
    )
    qty_on_hand = fields.Float(
        string='On Hand',
        digits='Product Unit of Measure',
    )
    stock_value_on_hand = fields.Monetary(
        string='Stock Value',
        currency_field='currency_id',
    )
