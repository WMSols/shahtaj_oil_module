# -*- coding: utf-8 -*-
"""Bookable quantity for order bookers: on-hand minus in-progress carts and confirmed orders."""
from odoo import _, api, models
from odoo.exceptions import UserError
from odoo.tools import float_compare


class ProductProduct(models.Model):
    _inherit = 'product.product'

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

    def _get_shahtaj_bookable_qty(self, exclude_visit_line_ids=None):
        """Qty order bookers may still book (None = no stock tracking on this product).

        Confirmed Shahtaj orders reduce Odoo qty_available via stock reservation.
        In-progress visit carts are subtracted here because they are not reserved yet.
        """
        self.ensure_one()
        if not self.is_storable:
            return None
        cart_map = self._get_shahtaj_cart_committed_qty(
            self.ids,
            exclude_visit_line_ids=exclude_visit_line_ids,
        )
        cart_committed = cart_map.get(self.id, 0.0)
        rounding = self.uom_id.rounding
        # Order bookers lack stock.move ACL; read on-hand qty with elevated rights.
        qty_on_hand = self.sudo().qty_available
        bookable = qty_on_hand - cart_committed
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
