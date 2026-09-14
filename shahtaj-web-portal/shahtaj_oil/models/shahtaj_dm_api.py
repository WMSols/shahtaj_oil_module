# -*- coding: utf-8 -*-
"""Delivery Man API service helpers (lean payloads for Flutter)."""
from collections import defaultdict

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_round


class ShahtajDmApiService(models.AbstractModel):
    _name = 'shahtaj.dm.api.service'
    _description = 'Delivery Man API Service'

    @api.model
    def _today(self):
        return fields.Date.context_today(self)

    @api.model
    def _dm_user(self):
        return self.env.user

    @api.model
    def _jobs_domain(self, dm, day=None, open_only=True):
        day = day or self._today()
        domain = [
            ('delivery_man_id', '=', dm.id),
            '|', '|',
            ('scheduled_date', '=', day),
            ('scheduled_date', '=', False),
            ('scheduled_date', '<', day),
        ]
        if open_only:
            domain.append(('state', 'in', ('not_ready', 'ready', 'picked', 'partial')))
        return domain

    @api.model
    def _van_qty_map(self, dm, product_ids=None):
        van = dm._shahtaj_get_van_location()
        if not van:
            return {}
        domain = [
            ('location_id', '=', van.id),
            ('quantity', '!=', 0),
        ]
        if product_ids:
            domain.append(('product_id', 'in', list(product_ids)))
        totals = defaultdict(float)
        for quant in self.env['stock.quant'].sudo().search(domain):
            totals[quant.product_id.id] += quant.quantity
        return dict(totals)

    @api.model
    def _wh_free_qty_map(self, product_ids=None):
        warehouse = self.env['stock.warehouse'].search([
            ('company_id', '=', self.env.company.id),
        ], limit=1)
        if not warehouse or not warehouse.lot_stock_id:
            return {}
        domain = [
            ('location_id', '=', warehouse.lot_stock_id.id),
        ]
        if product_ids:
            domain.append(('product_id', 'in', list(product_ids)))
        totals = defaultdict(float)
        for quant in self.env['stock.quant'].sudo().search(domain):
            qty = quant.available_quantity
            if qty:
                totals[quant.product_id.id] += qty
        return dict(totals)

    @api.model
    def get_today_load(self, dm=None, day=None):
        """Office load screen: shops + products still to pick + van/WH snapshot."""
        dm = dm or self._dm_user()
        day = day or self._today()
        Delivery = self.env['shahtaj.dm.delivery']
        jobs = Delivery.search(self._jobs_domain(dm, day, open_only=True), order='id')
        for job in jobs:
            job.sudo()._sync_with_sale_order(ensure_visit_task=False)

        shops = []
        pick_needed = defaultdict(lambda: {
            'product_id': False,
            'name': '',
            'uom': '',
            'qty_still': 0.0,
            'qty_assigned': 0.0,
            'qty_picked': 0.0,
        })
        for job in jobs:
            shop = job.partner_id
            lines = []
            for line in job.line_ids:
                still = max(line.qty_assigned - line.qty_picked, 0.0)
                lines.append({
                    'line_id': line.id,
                    'product_id': line.product_id.id,
                    'name': line.product_id.display_name,
                    'qty_assigned': line.qty_assigned,
                    'qty_picked': line.qty_picked,
                    'qty_still': still,
                    'qty_delivered': line.qty_delivered,
                    'uom': line.product_uom_id.name if line.product_uom_id else '',
                })
                if still > 0 and line.product_id:
                    bucket = pick_needed[line.product_id.id]
                    bucket['product_id'] = line.product_id.id
                    bucket['name'] = line.product_id.display_name
                    bucket['uom'] = line.product_uom_id.name if line.product_uom_id else ''
                    bucket['qty_still'] += still
                    bucket['qty_assigned'] += line.qty_assigned
                    bucket['qty_picked'] += line.qty_picked
            shops.append({
                'job_id': job.id,
                'shop_id': shop.id if shop else False,
                'shop_name': shop.display_name if shop else '',
                'order_name': job.sale_order_id.name if job.sale_order_id else '',
                'state': job.state,
                'field_state': job.field_state,
                'scheduled_date': str(job.scheduled_date) if job.scheduled_date else False,
                'lines': lines,
            })

        product_ids = list(pick_needed.keys())
        van_map = self._van_qty_map(dm, product_ids or None)
        wh_map = self._wh_free_qty_map(product_ids or None)
        pick_lines = []
        for pid, row in pick_needed.items():
            pick_lines.append({
                **row,
                'qty_on_van': van_map.get(pid, 0.0),
                'qty_in_warehouse': wh_map.get(pid, 0.0),
                'qty_to_pick': row['qty_still'],
            })
        pick_lines.sort(key=lambda r: r['name'] or '')

        session = self.env['shahtaj.dm.day.session'].get_or_create_today(dm, day)
        return {
            'date': str(day),
            'session': {
                'id': session.id,
                'state': session.state,
                'departed_at': session.departed_at.isoformat(sep=' ') if session.departed_at else False,
                'ended_at': session.ended_at.isoformat(sep=' ') if session.ended_at else False,
            },
            'shops': shops,
            'pick_lines': pick_lines,
            'van_qty_total': sum(van_map.values()),
            'warehouse_qty_total': sum(wh_map.values()),
        }

    @api.model
    def pick_today_load(self, qty_by_product, dm=None, day=None):
        """Step 1: load stock for today's jobs (product_id → qty)."""
        dm = dm or self._dm_user()
        day = day or self._today()
        Delivery = self.env['shahtaj.dm.delivery']
        if not qty_by_product:
            raise UserError(_('Set a pick quantity on at least one product.'))

        cleaned = {}
        for pid, qty in qty_by_product.items():
            qty = float(qty or 0.0)
            if qty > 0:
                cleaned[int(pid)] = qty
        if not cleaned:
            raise UserError(_('Set a pick quantity on at least one product.'))

        deliveries = Delivery.search(
            self._jobs_domain(dm, day, open_only=True) + [
                ('state', 'in', ('ready', 'picked', 'partial')),
            ],
            order='id',
        )
        for delivery in deliveries:
            delivery.sudo()._sync_with_sale_order(ensure_visit_task=False)

        remaining = dict(cleaned)
        qty_by_delivery = defaultdict(dict)
        for delivery in deliveries:
            for line in delivery.line_ids:
                pid = line.product_id.id
                if pid not in remaining:
                    continue
                left = remaining[pid]
                if left <= 0:
                    continue
                still = max(line.qty_assigned - line.qty_picked, 0.0)
                if still <= 0:
                    continue
                rounding = line.product_uom_id.rounding or 0.01
                take = float_round(min(still, left), precision_rounding=rounding)
                if take <= 0:
                    continue
                qty_by_delivery[delivery.id][line.id] = take
                remaining[pid] = float_round(left - take, precision_rounding=rounding)

        for pid, left in remaining.items():
            product = self.env['product.product'].browse(pid)
            rounding = product.uom_id.rounding or 0.01
            if float_compare(left, 0.0, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Could not allocate %(qty)s of %(product)s across today\'s shops.',
                    qty=left,
                    product=product.display_name,
                ))
        if not qty_by_delivery:
            raise UserError(_('Nothing left to pick for today.'))

        picked = 0
        for delivery_id, qty_map in qty_by_delivery.items():
            Delivery.browse(delivery_id)._pick_stock_with_qtys(qty_map, reload_form=False)
            picked += 1
        return {
            'jobs_picked': picked,
            'load': self.get_today_load(dm, day),
        }

    @api.model
    def pick_job(self, job_id, lines, dm=None):
        """Pick one job: lines = [{line_id, qty}, ...]."""
        dm = dm or self._dm_user()
        job = self._job_for_dm(job_id, dm)
        qty_map = {}
        for row in lines or []:
            line_id = int(row.get('line_id') or 0)
            qty = float(row.get('qty') or 0.0)
            if line_id and qty > 0:
                qty_map[line_id] = qty
        if not qty_map:
            raise UserError(_('Enter a pick quantity on at least one line.'))
        job._pick_stock_with_qtys(qty_map, reload_form=False)
        return {'job': self.job_detail(job)}

    @api.model
    def free_van_transfer(self, direction, lines, dm=None):
        """Free WH↔van. lines = [{product_id, qty}, ...]. direction: to_van|to_wh."""
        dm = dm or self._dm_user()
        qty_map = {}
        for row in lines or []:
            pid = int(row.get('product_id') or 0)
            qty = float(row.get('qty') or 0.0)
            if pid and qty > 0:
                qty_map[pid] = qty
        if not qty_map:
            raise UserError(_('Set a quantity on at least one product.'))
        self.env['shahtaj.dm.delivery']._shahtaj_free_wh_van_transfer(
            dm, qty_map, direction,
        )
        return {'van': self.van_snapshot(dm)}

    @api.model
    def van_snapshot(self, dm=None):
        dm = dm or self._dm_user()
        van = dm._shahtaj_get_van_location()
        items = []
        van_map = self._van_qty_map(dm)
        Product = self.env['product.product'].sudo()
        for pid, qty in sorted(van_map.items(), key=lambda x: x[0]):
            product = Product.browse(pid)
            if not product.exists() or qty <= 0:
                continue
            items.append({
                'product_id': pid,
                'name': product.display_name,
                'qty': qty,
                'uom': product.uom_id.name if product.uom_id else '',
            })
        return {
            'van_location_id': van.id if van else False,
            'items': items,
            'qty_total': sum(i['qty'] for i in items),
        }

    @api.model
    def products_for_free_load(self, dm=None, limit=200):
        """Products with WH free qty and van qty (for optional free load UI)."""
        dm = dm or self._dm_user()
        Product = self.env['product.product'].sudo()
        products = Product.search([
            ('is_storable', '=', True),
            ('sale_ok', '=', True),
        ], limit=limit, order='name')
        pids = products.ids
        van_map = self._van_qty_map(dm, pids)
        wh_map = self._wh_free_qty_map(pids)
        rows = []
        for product in products:
            wh_qty = wh_map.get(product.id, 0.0)
            van_qty = van_map.get(product.id, 0.0)
            if wh_qty <= 0 and van_qty <= 0:
                continue
            rows.append({
                'product_id': product.id,
                'name': product.display_name,
                'qty_in_warehouse': wh_qty,
                'qty_on_van': van_qty,
                'uom': product.uom_id.name if product.uom_id else '',
            })
        return {'products': rows}

    @api.model
    def get_plan(self, dm=None, day=None):
        """Active visit/delivery plan for the day (refresh for live assigns)."""
        dm = dm or self._dm_user()
        day = day or self._today()
        Delivery = self.env['shahtaj.dm.delivery']
        jobs = Delivery.search(self._jobs_domain(dm, day, open_only=False), order='id')
        # Prefer open first in app sort
        open_jobs = jobs.filtered(lambda j: j.state in ('not_ready', 'ready', 'picked', 'partial'))
        done_jobs = jobs - open_jobs
        ordered = open_jobs + done_jobs
        session = self.env['shahtaj.dm.day.session'].get_or_create_today(dm, day)
        return {
            'date': str(day),
            'session': {
                'id': session.id,
                'state': session.state,
                'departed_at': session.departed_at.isoformat(sep=' ') if session.departed_at else False,
                'ended_at': session.ended_at.isoformat(sep=' ') if session.ended_at else False,
            },
            'jobs': [self.job_brief(j) for j in ordered],
        }

    @api.model
    def job_brief(self, job):
        shop = job.partner_id
        on_van = sum(max(l.qty_picked - l.qty_delivered, 0.0) for l in job.line_ids)
        return {
            'job_id': job.id,
            'shop_id': shop.id if shop else False,
            'shop_name': shop.display_name if shop else '',
            'shop_address': shop.contact_address if shop else '',
            'latitude': shop.partner_latitude if shop else 0.0,
            'longitude': shop.partner_longitude if shop else 0.0,
            'order_name': job.sale_order_id.name if job.sale_order_id else '',
            'state': job.state,
            'field_state': job.field_state,
            'scheduled_date': str(job.scheduled_date) if job.scheduled_date else False,
            'qty_on_van': on_van,
            'notes': job.notes or '',
            'gps_verified': bool(job.gps_verified),
            'picked_at': job.picked_at.isoformat(sep=' ') if job.picked_at else False,
            'delivered_at': job.delivered_at.isoformat(sep=' ') if job.delivered_at else False,
        }

    @api.model
    def job_detail(self, job):
        brief = self.job_brief(job)
        brief['lines'] = [{
            'line_id': line.id,
            'product_id': line.product_id.id,
            'name': line.product_id.display_name,
            'qty_assigned': line.qty_assigned,
            'qty_picked': line.qty_picked,
            'qty_delivered': line.qty_delivered,
            'qty_on_van': max(line.qty_picked - line.qty_delivered, 0.0),
            'uom': line.product_uom_id.name if line.product_uom_id else '',
        } for line in job.line_ids]
        return brief

    @api.model
    def _job_for_dm(self, job_id, dm=None):
        dm = dm or self._dm_user()
        job = self.env['shahtaj.dm.delivery'].browse(int(job_id))
        if not job.exists():
            raise UserError(_('Delivery job not found.'))
        if job.delivery_man_id.id != dm.id:
            raise UserError(_('This job belongs to another delivery man.'))
        return job

    @api.model
    def set_job_notes(self, job_id, notes, dm=None):
        job = self._job_for_dm(job_id, dm)
        job.write({'notes': notes or ''})
        return {'job': self.job_brief(job)}

    @api.model
    def mark_shop_closed(self, job_id, notes, dm=None):
        job = self._job_for_dm(job_id, dm)
        if notes is not None:
            job.write({'notes': notes})
        job.action_field_not_attended()
        return {'job': self.job_brief(job)}

    @api.model
    def mark_failed(self, job_id, notes, dm=None):
        job = self._job_for_dm(job_id, dm)
        if notes is not None:
            job.write({'notes': notes})
        job.action_field_failed()
        return {'job': self.job_brief(job)}

    @api.model
    def deliver_job(self, job_id, latitude, longitude, lines, notes=None, dm=None):
        """GPS deliver from van for an assigned job. lines=[{line_id, qty}]."""
        job = self._job_for_dm(job_id, dm)
        if notes:
            existing = (job.notes or '').strip()
            job.write({'notes': f'{existing}\n{notes}'.strip() if existing else notes})

        Visit = self.env['shahtaj.visit']
        distance = Visit._validate_check_in_coordinates(
            job.partner_id.sudo(),
            float(latitude) if latitude is not None else None,
            float(longitude) if longitude is not None else None,
            purpose='confirm delivery',
            log_purpose='deliver',
            dm_delivery=job,
        )
        qty_map = {}
        for row in lines or []:
            line_id = int(row.get('line_id') or 0)
            qty = float(row.get('qty') or 0.0)
            if line_id and qty > 0:
                qty_map[line_id] = qty
        if not qty_map:
            raise UserError(_('Enter a deliver quantity on at least one product.'))
        job._deliver_to_shop_with_qtys(
            qty_map,
            latitude=float(latitude),
            longitude=float(longitude),
            distance_m=distance,
            reload_form=False,
        )
        return {
            'distance_m': distance,
            'job': self.job_detail(job),
        }

    @api.model
    def return_job_undelivered(self, job_id, dm=None):
        job = self._job_for_dm(job_id, dm)
        job.action_return_to_warehouse()
        return {'job': self.job_detail(job)}

    @api.model
    def free_deliver(self, shop_id, latitude, longitude, lines, notes='', dm=None):
        """Deliver free van stock to a shop (no assigned job required) + notes."""
        dm = dm or self._dm_user()
        shop = self.env['res.partner'].sudo().browse(int(shop_id))
        if not shop.exists() or not shop.is_shahtaj_shop:
            raise UserError(_('Shop not found.'))

        Visit = self.env['shahtaj.visit']
        distance = Visit._validate_check_in_coordinates(
            shop,
            float(latitude) if latitude is not None else None,
            float(longitude) if longitude is not None else None,
            purpose='confirm free delivery',
            log_purpose='deliver',
        )

        qty_map = {}
        for row in lines or []:
            pid = int(row.get('product_id') or 0)
            qty = float(row.get('qty') or 0.0)
            if pid and qty > 0:
                qty_map[pid] = qty_map.get(pid, 0.0) + qty
        if not qty_map:
            raise UserError(_('Enter a deliver quantity on at least one product.'))

        Delivery = self.env['shahtaj.dm.delivery']
        van = Delivery._ensure_van_location_for_dm(dm)
        warehouse = Delivery._get_warehouse()
        customer_loc = shop.property_stock_customer
        if not customer_loc:
            customer_loc = self.env.ref('stock.stock_location_customers', raise_if_not_found=False)
        if not customer_loc:
            raise UserError(_('No customer stock location found.'))
        out_type = warehouse.out_type_id
        if not out_type:
            raise UserError(_('No delivery operation type on the warehouse.'))

        Product = self.env['product.product'].sudo()
        move_vals_list = []
        for pid, qty in qty_map.items():
            product = Product.browse(pid)
            if not product.exists():
                continue
            move_vals_list.append({
                'product_id': product.id,
                'product_uom_qty': qty,
                'product_uom': product.uom_id.id,
                'location_id': van.id,
                'location_dest_id': customer_loc.id,
            })
        if not move_vals_list:
            raise UserError(_('No products to deliver.'))

        # Availability check
        Quant = self.env['stock.quant'].sudo()
        for move in move_vals_list:
            quants = Quant.search([
                ('product_id', '=', move['product_id']),
                ('location_id', '=', van.id),
            ])
            available = sum(quants.mapped('quantity'))
            if available + 1e-6 < move['product_uom_qty']:
                product = Product.browse(move['product_id'])
                raise UserError(_(
                    'Not enough %(product)s on van (need %(need)s, have %(avail)s).',
                    product=product.display_name,
                    need=move['product_uom_qty'],
                    avail=available,
                ))

        picking = Delivery._create_stock_picking(
            picking_type=out_type,
            location_id=van,
            location_dest_id=customer_loc,
            origin=f'DM Free Deliver: {shop.display_name}',
            move_vals_list=move_vals_list,
            partner_id=shop.id,
        )
        picking.action_confirm()
        picking.action_assign()
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
        picking.with_context(skip_backorder=True, skip_sms=True).button_validate()

        return {
            'distance_m': distance,
            'shop_id': shop.id,
            'shop_name': shop.display_name,
            'notes': (notes or '').strip(),
            'van': self.van_snapshot(dm),
        }

    @api.model
    def shops_search(self, query='', limit=30):
        """Find Shahtaj shops for free deliver."""
        domain = [('is_shahtaj_shop', '=', True), ('shop_approval_state', '=', 'approved')]
        if query:
            domain = ['&'] + domain + [
                '|', '|',
                ('name', 'ilike', query),
                ('display_name', 'ilike', query),
                ('phone', 'ilike', query),
            ]
        shops = self.env['res.partner'].sudo().search(domain, limit=limit, order='name')
        return {
            'shops': [{
                'shop_id': s.id,
                'name': s.display_name,
                'address': s.contact_address or '',
                'latitude': s.partner_latitude or 0.0,
                'longitude': s.partner_longitude or 0.0,
            } for s in shops],
        }
