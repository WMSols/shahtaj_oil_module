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
        """Roles without stock.user ACL still need on-hand qty on product lists."""
        if self.env.su:
            return False
        user = self.env.user
        if user.has_group('stock.group_stock_user'):
            return False
        return (
            user.has_group('shahtaj_oil.group_shahtaj_office_ops')
            or user.has_group('shahtaj_oil.group_shahtaj_order_booker')
            or user.has_group('shahtaj_oil.group_shahtaj_warehouse')
            or user.has_group('shahtaj_oil.group_shahtaj_warehouse_acl')
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
        return user.has_group('shahtaj_oil.group_shahtaj_office_ops')

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
        return self._get_shahtaj_bookable_qty_map(
            self,
            exclude_visit_line_ids=exclude_visit_line_ids,
        ).get(self.id)

    @api.model
    def _get_shahtaj_bookable_qty_map(self, products, exclude_visit_line_ids=None):
        """Batch bookable qty for many products (same formula as single).

        Returns ``{product_id: float|None}`` where ``None`` means non-storable /
        unlimited.
        """
        products = products.exists()
        if not products:
            return {}
        result = {p.id: None for p in products}
        storable = products.filtered('is_storable')
        if not storable:
            return result

        cart_map = self._get_shahtaj_cart_committed_qty(
            storable.ids,
            exclude_visit_line_ids=exclude_visit_line_ids,
        )
        so_map = self._get_shahtaj_so_committed_qty(storable.ids)
        # One qty_available compute pass for the page.
        storable.sudo().mapped('qty_available')
        for product in storable:
            rounding = product.uom_id.rounding
            qty_on_hand = product.sudo().qty_available
            bookable = (
                qty_on_hand
                - cart_map.get(product.id, 0.0)
                - so_map.get(product.id, 0.0)
            )
            if float_compare(bookable, 0.0, precision_rounding=rounding) < 0:
                bookable = 0.0
            result[product.id] = bookable
        return result

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

    def shahtaj_stock_occupation(self):
        """Read-only breakdown: where on-hand sits and what soft-holds bookable qty.

        Used by Dist Stock Overview “Occupation” screen to find ghost / misaligned stock.
        """
        self.ensure_one()
        product = self.sudo()
        uom = product.uom_id.name or ''
        on_hand = float(product.qty_available or 0.0)
        bookable = product._get_shahtaj_bookable_qty()
        if bookable is None:
            bookable = on_hand

        Delivery = self.env['shahtaj.dm.delivery'].sudo()
        warehouse = Delivery._get_warehouse()
        wh_loc = warehouse.lot_stock_id if warehouse else False

        wh_onhand = 0.0
        wh_free = 0.0
        wh_reserved = 0.0
        if wh_loc:
            onhand_map = Delivery._shahtaj_physical_wh_onhand_qty_map(wh_loc, {product.id})
            free_map = Delivery._shahtaj_physical_wh_qty_map(wh_loc, {product.id})
            wh_onhand = float(onhand_map.get(product.id, 0.0) or 0.0)
            wh_free = max(float(free_map.get(product.id, 0.0) or 0.0), 0.0)
            wh_reserved = max(wh_onhand - wh_free, 0.0)

        # Soft-held by confirmed undelivered SO lines (one row per order, product UOM).
        def _to_product_uom(qty, line_uom):
            qty = float(qty or 0.0)
            if not qty:
                return 0.0
            if line_uom and line_uom != product.uom_id:
                return line_uom._compute_quantity(
                    qty, product.uom_id, rounding_method='HALF-UP',
                )
            return qty

        SaleLine = self.env['sale.order.line'].sudo()
        solines = SaleLine.search([
            ('product_id', '=', product.id),
            ('order_id.state', 'in', ('sale', 'done')),
            ('display_type', '=', False),
        ], order='order_id desc, id desc')
        orders_by_id = {}
        held_orders = 0.0
        for line in solines:
            ordered = _to_product_uom(line.product_uom_qty, line.product_uom_id)
            delivered = _to_product_uom(line.qty_delivered, line.product_uom_id)
            remaining = ordered - delivered
            if float_compare(remaining, 0.0, precision_rounding=product.uom_id.rounding) <= 0:
                continue
            held_orders += remaining
            order = line.order_id
            row = orders_by_id.get(order.id)
            if row:
                row['qty_held'] += remaining
                row['qty_ordered'] += ordered
                row['qty_delivered'] += delivered
                continue
            partner = order.partner_id
            orders_by_id[order.id] = {
                'order_id': order.id,
                'order_name': order.name or '',
                'shop': partner.display_name if partner else '',
                'qty_held': remaining,
                'qty_ordered': ordered,
                'qty_delivered': delivered,
                'is_walk_in': bool(getattr(order, 'shahtaj_is_walk_in', False)),
                'state': order.state,
                'date_order': str(order.date_order.date()) if order.date_order else False,
            }
        orders = list(orders_by_id.values())

        # Open visit carts (no SO yet).
        VisitLine = self.env['shahtaj.visit.line'].sudo()
        cart_lines = VisitLine.search([
            ('product_id', '=', product.id),
            ('visit_id.state', '=', 'in_progress'),
            ('visit_id.sale_order_id', '=', False),
        ])
        carts = []
        held_carts = 0.0
        for line in cart_lines:
            qty = float(line.product_uom_qty or 0.0)
            if qty <= 0:
                continue
            held_carts += qty
            visit = line.visit_id
            carts.append({
                'visit_id': visit.id,
                'booker': visit.order_booker_id.name if visit.order_booker_id else '',
                'shop': visit.shop_id.display_name if visit.shop_id else '',
                'qty_held': qty,
            })

        # Open DM jobs + van physical / free surplus.
        jobs = Delivery.search([
            ('line_ids.product_id', '=', product.id),
            ('state', 'in', ('not_ready', 'ready', 'picked', 'partial')),
        ], order='scheduled_date desc, id desc')
        job_rows = []
        van_by_dm = {}
        for job in jobs:
            jlines = job.line_ids.filtered(lambda l: l.product_id.id == product.id)
            if not jlines:
                continue
            qty_assigned = sum(float(l.qty_assigned or 0.0) for l in jlines)
            qty_picked = sum(float(l.qty_picked or 0.0) for l in jlines)
            qty_delivered = sum(float(l.qty_delivered or 0.0) for l in jlines)
            on_van_paper = max(qty_picked - qty_delivered, 0.0)
            job_rows.append({
                'job_id': job.id,
                'job_name': job.display_name or '',
                'order_id': job.sale_order_id.id if job.sale_order_id else False,
                'order_name': job.sale_order_id.name if job.sale_order_id else '',
                'shop': job.partner_id.display_name if job.partner_id else '',
                'dm_id': job.delivery_man_id.id if job.delivery_man_id else False,
                'dm_name': job.delivery_man_id.name if job.delivery_man_id else '',
                'state': job.state,
                'field_state': job.field_state or '',
                'scheduled_date': str(job.scheduled_date) if job.scheduled_date else False,
                'qty_assigned': qty_assigned,
                'qty_picked': qty_picked,
                'qty_delivered': qty_delivered,
                'qty_on_van_paper': on_van_paper,
                'is_walk_in': bool(job.is_walk_in),
            })
            dm = job.delivery_man_id
            if dm and dm.id not in van_by_dm:
                van_by_dm[dm.id] = dm

        # Also include DMs with physical van stock for this product (no open job needed).
        Quant = self.env['stock.quant'].sudo()
        van_parent = self.env.ref(
            'shahtaj_oil.stock_location_dm_vans', raise_if_not_found=False,
        )
        orphan_van_locs = {}
        if van_parent:
            van_quants = Quant.search([
                ('product_id', '=', product.id),
                ('quantity', '!=', 0),
                ('location_id.location_id', '=', van_parent.id),
            ])
            for quant in van_quants:
                job = Delivery.search([
                    ('van_location_id', '=', quant.location_id.id),
                    ('delivery_man_id', '!=', False),
                ], limit=1, order='id desc')
                if job.delivery_man_id:
                    van_by_dm.setdefault(job.delivery_man_id.id, job.delivery_man_id)
                else:
                    orphan_van_locs[quant.location_id.id] = quant.location_id

        vans = []
        van_total = 0.0
        van_free_total = 0.0
        van_job_total = 0.0
        seen_van_locs = set()
        for dm in van_by_dm.values():
            van = dm._shahtaj_get_van_location()
            if not van or van.id in seen_van_locs:
                continue
            seen_van_locs.add(van.id)
            orphan_van_locs.pop(van.id, None)
            physical_map = Delivery._shahtaj_physical_van_qty_map(van, {product.id})
            physical = float(physical_map.get(product.id, 0.0) or 0.0)
            free_map = Delivery._shahtaj_unattributed_van_qty_map(dm, {product.id})
            free = max(float(free_map.get(product.id, 0.0) or 0.0), 0.0)
            for_jobs = max(physical - free, 0.0)
            if physical <= 0 and free <= 0:
                continue
            van_total += physical
            van_free_total += free
            van_job_total += for_jobs
            vans.append({
                'dm_id': dm.id,
                'dm_name': dm.name or '',
                'van_location': van.display_name or '',
                'qty_on_van': physical,
                'qty_for_jobs': for_jobs,
                'qty_free_extra': free,
            })
        for loc in orphan_van_locs.values():
            physical_map = Delivery._shahtaj_physical_van_qty_map(loc, {product.id})
            physical = float(physical_map.get(product.id, 0.0) or 0.0)
            if physical <= 0:
                continue
            van_total += physical
            van_free_total += physical
            vans.append({
                'dm_id': False,
                'dm_name': loc.name or _('Unknown van'),
                'van_location': loc.display_name or '',
                'qty_on_van': physical,
                'qty_for_jobs': 0.0,
                'qty_free_extra': physical,
            })
        vans.sort(key=lambda r: (-r['qty_on_van'], r['dm_name'] or ''))

        other_locations = max(on_hand - wh_onhand - van_total, 0.0)
        soft_held = held_orders + held_carts

        return {
            'product_id': product.id,
            'product_tmpl_id': product.product_tmpl_id.id,
            'product_name': product.display_name,
            'uom': uom,
            'summary': {
                'on_hand': on_hand,
                'available_to_book': float(bookable or 0.0),
                'soft_held': soft_held,
                'held_by_orders': held_orders,
                'held_by_carts': held_carts,
                'warehouse_on_hand': wh_onhand,
                'warehouse_free': wh_free,
                'warehouse_reserved': wh_reserved,
                'van_on_hand': van_total,
                'van_for_jobs': van_job_total,
                'van_free_extra': van_free_total,
                'other_locations': other_locations,
            },
            'orders': orders,
            'carts': carts,
            'jobs': job_rows,
            'vans': vans,
            'warehouse': {
                'name': warehouse.name if warehouse else '',
                'location': wh_loc.display_name if wh_loc else '',
                'on_hand': wh_onhand,
                'free': wh_free,
                'reserved': wh_reserved,
            },
        }
