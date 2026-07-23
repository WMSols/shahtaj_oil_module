# -*- coding: utf-8 -*-
"""Link confirmed sales orders back to the shop visit and daily task."""
from odoo import _, api, fields, models
from odoo.tools import float_compare


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
    shahtaj_delivery_status = fields.Selection(
        [
            ('no_stock', 'No Stock Moves'),
            ('pending', 'To Deliver'),
            ('partial', 'Partially Delivered'),
            ('done', 'Fully Delivered'),
        ],
        string='Delivery Status',
        compute='_compute_shahtaj_delivery_status',
        store=True,
    )
    shahtaj_qty_to_deliver = fields.Float(
        string='Qty Still to Deliver',
        compute='_compute_shahtaj_delivery_status',
        digits='Product Unit of Measure',
        store=True,
    )

    @api.depends(
        'order_line.product_uom_qty',
        'order_line.qty_delivered',
        'order_line.product_id',
        'order_line.product_id.is_storable',
        'state',
    )
    def _compute_shahtaj_delivery_status(self):
        # Intentionally do not depend on picking_ids: custom-portal distributors
        # lack stock.picking ACL, and qty_delivered already updates on validate.
        for order in self:
            storable_lines = order.order_line.filtered(
                lambda l: l.product_id and l.product_id.is_storable and not l.display_type
            )
            if not storable_lines:
                order.shahtaj_delivery_status = 'no_stock'
                order.shahtaj_qty_to_deliver = 0.0
                continue
            ordered = sum(storable_lines.mapped('product_uom_qty'))
            delivered = sum(storable_lines.mapped('qty_delivered'))
            remaining = ordered - delivered
            order.shahtaj_qty_to_deliver = max(remaining, 0.0)
            if float_compare(delivered, 0.0, precision_digits=2) <= 0:
                order.shahtaj_delivery_status = 'pending'
            elif float_compare(remaining, 0.0, precision_digits=2) <= 0:
                order.shahtaj_delivery_status = 'done'
            else:
                order.shahtaj_delivery_status = 'partial'

    def action_shahtaj_mark_delivery(self):
        """Open wizard so distributor can validate full/partial delivery."""
        self.ensure_one()
        if self.state not in ('sale', 'done'):
            return False
        return {
            'type': 'ir.actions.act_window',
            'name': _('Mark Delivery — %s', self.name),
            'res_model': 'shahtaj.mark.delivery.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'active_id': self.id,
                'default_sale_order_id': self.id,
            },
        }

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

    def _shahtaj_distributor_needs_stock_sudo(self):
        """Custom-portal distributors lack stock.picking ACL used by delivery fields."""
        if self.env.su:
            return False
        user = self.env.user
        if user.has_group('stock.group_stock_user'):
            return False
        return user.has_group('shahtaj_oil.group_shahtaj_distributor')

    def _compute_delivery_status(self):
        if self._shahtaj_distributor_needs_stock_sudo():
            return super(SaleOrder, self.sudo())._compute_delivery_status()
        return super()._compute_delivery_status()

    def _compute_picking_ids(self):
        if self._shahtaj_distributor_needs_stock_sudo():
            return super(SaleOrder, self.sudo())._compute_picking_ids()
        return super()._compute_picking_ids()

    def _compute_effective_date(self):
        if self._shahtaj_distributor_needs_stock_sudo():
            return super(SaleOrder, self.sudo())._compute_effective_date()
        return super()._compute_effective_date()

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
