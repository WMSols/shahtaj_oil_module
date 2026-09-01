# -*- coding: utf-8 -*-
"""Bookable quantity for order bookers: on-hand minus open carts and undelivered SOs."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare


class ProductProduct(models.Model):
    _inherit = 'product.product'

    shahtaj_vendor_id = fields.Many2one(
        'res.partner',
        string='Primary Vendor',
        related='product_tmpl_id.shahtaj_vendor_id',
        readonly=True,
        store=True,
        index=True,
    )
    shahtaj_vendor_name = fields.Char(
        string='Vendor',
        related='product_tmpl_id.shahtaj_vendor_name',
        readonly=True,
    )

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
        # stock.qty_* use compute_sudo=False and read stock.move — elevate for portal users.
        if self._shahtaj_needs_stock_qty_sudo():
            return super(ProductProduct, self.sudo())._compute_quantities()
        return super()._compute_quantities()

    def _compute_nbr_moves(self):
        if self._shahtaj_needs_stock_qty_sudo():
            return super(ProductProduct, self.sudo())._compute_nbr_moves()
        return super()._compute_nbr_moves()

    def _shahtaj_distributor_needs_stock_sudo(self):
        """Custom-portal distributors lack Inventory groups but may edit products."""
        if self.env.su:
            return False
        user = self.env.user
        if user.has_group('stock.group_stock_user'):
            return False
        return user.has_group('shahtaj_oil.group_shahtaj_distributor')

    def write(self, vals):
        # Archive syncs orderpoint_ids; UoM/price edits can read stock.move.
        if self._shahtaj_distributor_needs_stock_sudo():
            self.check_access('write')
            return super(ProductProduct, self.sudo()).write(vals)
        return super().write(vals)

    def _shahtaj_get_kg_per_unit(self):
        """Return kg equivalent for one selling unit of this variant."""
        self.ensure_one()
        return self.product_tmpl_id._shahtaj_get_kg_per_unit()

    @api.model
    def _get_shahtaj_cart_committed_qty(self, product_ids, exclude_visit_line_ids=None):
        """Qty in active visit carts (not yet turned into a sales order)."""
        if not product_ids:
            return {}
        exclude_visit_line_ids = set(exclude_visit_line_ids or [])
        committed = {pid: 0.0 for pid in product_ids}

        VisitLine = self.env['shahtaj.visit.line']
        cart_lines = VisitLine.search([
            ('product_id', 'in', product_ids),
            ('visit_id.state', '=', 'in_progress'),
            ('visit_id.sale_order_id', '=', False),
        ])
        for line in cart_lines:
            if line.id in exclude_visit_line_ids:
                continue
            committed[line.product_id.id] += line.product_uom_qty

        return committed

    @api.model
    def _get_shahtaj_so_committed_qty(self, product_ids):
        """Undelivered qty on confirmed sales orders (held until deliver or cancel).

        Counts ``product_uom_qty - qty_delivered`` for storable lines on orders in
        ``sale`` / ``done``. Cancelled and draft/sent quotes do not hold stock.
        """
        if not product_ids:
            return {}
        committed = {pid: 0.0 for pid in product_ids}
        # sudo: bookers/distributors may lack sale.order.line ACL while booking.
        SaleLine = self.env['sale.order.line'].sudo()
        lines = SaleLine.search([
            ('product_id', 'in', product_ids),
            ('order_id.state', 'in', ('sale', 'done')),
            ('display_type', '=', False),
        ])
        for line in lines:
            product = line.product_id
            if not product or not product.is_storable:
                continue
            remaining = line.product_uom_qty - line.qty_delivered
            if float_compare(remaining, 0.0, precision_rounding=product.uom_id.rounding) <= 0:
                continue
            # Convert line UoM → product UoM when they differ.
            line_uom = line.product_uom_id
            if line_uom and line_uom != product.uom_id:
                remaining = line_uom._compute_quantity(
                    remaining,
                    product.uom_id,
                    rounding_method='HALF-UP',
                )
            committed[product.id] = committed.get(product.id, 0.0) + remaining
        return committed

    def _get_shahtaj_bookable_qty(self, exclude_visit_line_ids=None):
        """Qty order bookers may still book (None = no stock tracking on this product).

        Formula:
          on-hand
          − qty soft-held in in-progress visit carts (no SO yet)
          − undelivered qty on confirmed sales orders (until delivered or cancelled)
        """
        self.ensure_one()
        if not self.is_storable:
            return None
        cart_map = self._get_shahtaj_cart_committed_qty(
            self.ids,
            exclude_visit_line_ids=exclude_visit_line_ids,
        )
        so_map = self._get_shahtaj_so_committed_qty(self.ids)
        cart_committed = cart_map.get(self.id, 0.0)
        so_committed = so_map.get(self.id, 0.0)
        rounding = self.uom_id.rounding
        # Order bookers / portal distributors lack stock.move ACL; elevate qty read.
        qty_on_hand = self.sudo().qty_available
        bookable = qty_on_hand - cart_committed - so_committed
        if float_compare(bookable, 0.0, precision_rounding=rounding) < 0:
            return 0.0
        return bookable

    def _check_shahtaj_bookable_qty(self, qty, exclude_visit_line_ids=None):
        """Raise UserError if qty exceeds bookable stock for storable products."""
        self.ensure_one()
        bookable = self._get_shahtaj_bookable_qty(
            exclude_visit_line_ids=exclude_visit_line_ids,
        )
        if bookable is None:
            return
        rounding = self.uom_id.rounding
        if float_compare(qty, bookable, precision_rounding=rounding) > 0:
            raise UserError(_(
                'Not enough stock for "%(product)s". '
                'Available to book: %(available).2f %(uom)s, requested: %(requested).2f %(uom)s.',
                product=self.display_name,
                available=bookable,
                requested=qty,
                uom=self.uom_id.name,
            ))
