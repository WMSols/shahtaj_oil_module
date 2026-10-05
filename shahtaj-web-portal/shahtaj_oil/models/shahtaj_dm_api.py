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
        rows = self.env['stock.quant'].sudo().read_group(
            domain,
            ['quantity:sum'],
            ['product_id'],
        )
        return {
            row['product_id'][0]: float(row.get('quantity') or 0.0)
            for row in rows
            if row.get('product_id')
        }

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
        # available_quantity = quantity - reserved_quantity (same as Quant.available_quantity).
        rows = self.env['stock.quant'].sudo().read_group(
            domain,
            ['quantity:sum', 'reserved_quantity:sum'],
            ['product_id'],
        )
        totals = {}
        for row in rows:
            product = row.get('product_id')
            if not product:
                continue
            qty = float(row.get('quantity') or 0.0) - float(row.get('reserved_quantity') or 0.0)
            if qty:
                totals[product[0]] = qty
        return totals

    @api.model
    def _prefetch_jobs(self, jobs):
        """Warm related records used by plan/load serializers (no behavior change)."""
        if not jobs:
            return jobs
        jobs.mapped('partner_id')
        jobs.mapped('sale_order_id')
        jobs.mapped('line_ids.product_id')
        jobs.mapped('line_ids.product_uom_id')
        return jobs


    @api.model
    def get_today_load(self, dm=None, day=None):
        """Office load screen: today's jobs + van-first pick suggestion."""
        dm = dm or self._dm_user()
        day = day or self._today()
        Delivery = self.env['shahtaj.dm.delivery']
        jobs = Delivery.search(
            Delivery._shahtaj_today_open_jobs_domain(dm, day),
            order='id',
        )
        for job in jobs:
            job.sudo()._sync_with_sale_order(ensure_visit_task=False)
        self._prefetch_jobs(jobs)

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
        free_van = (
            Delivery._shahtaj_unattributed_van_qty_map(dm, set(product_ids))
            if product_ids else {}
        )
        pick_lines = []
        for pid, row in pick_needed.items():
            still = row['qty_still']
            product = self.env['product.product'].browse(pid)
            rounding = product.uom_id.rounding or 0.01
            van_cover = float_round(
                min(still, free_van.get(pid, 0.0)),
                precision_rounding=rounding,
            )
            pick_lines.append({
                **row,
                'qty_on_van': van_map.get(pid, 0.0),
                'qty_in_warehouse': wh_map.get(pid, 0.0),
                'qty_van_cover': van_cover,
                'qty_to_pick': float_round(
                    max(0.0, still - van_cover),
                    precision_rounding=rounding,
                ),
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
        """Van-first load for today's jobs, then WH→van for remaining Pick Now."""
        dm = dm or self._dm_user()
        day = day or self._today()
        Delivery = self.env['shahtaj.dm.delivery']
        if qty_by_product is None:
            qty_by_product = {}

        cleaned = {}
        for pid, qty in (qty_by_product or {}).items():
            qty = float(qty or 0.0)
            if qty > 0:
                cleaned[int(pid)] = qty

        deliveries = Delivery.search(
            Delivery._shahtaj_today_open_jobs_domain(dm, day),
            order='id',
        )
        for delivery in deliveries:
            delivery.sudo()._sync_with_sale_order(ensure_visit_task=False)

        live_still = defaultdict(float)
        for delivery in deliveries:
            for line in delivery.line_ids:
                if line.product_id:
                    live_still[line.product_id.id] += max(
                        line.qty_assigned - line.qty_picked, 0.0,
                    )

        free_van = Delivery._shahtaj_unattributed_van_qty_map(
            dm, set(live_still) | set(cleaned),
        )
        van_apply = {}
        wh_move = {}
        for pid, still in live_still.items():
            if still <= 0:
                continue
            product = self.env['product.product'].browse(pid)
            rounding = product.uom_id.rounding or 0.01
            user_wh = float(cleaned.get(pid) or 0.0)
            if float_compare(user_wh, still, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Cannot pick %(qty)s of %(product)s — only %(max)s still needed today.',
                    qty=user_wh,
                    product=product.display_name,
                    max=still,
                ))
            wh = float_round(min(user_wh, still), precision_rounding=rounding)
            cover = float_round(
                min(free_van.get(pid, 0.0), max(0.0, still - wh)),
                precision_rounding=rounding,
            )
            if cover > 0:
                van_apply[pid] = cover
            if wh > 0:
                wh_move[pid] = wh

        if not van_apply and not wh_move:
            raise UserError(_(
                'Nothing to load for today. Free van stock may already cover jobs, '
                'or pick quantities are zero.'
            ))

        shops_touched = set()
        if van_apply:
            qty_by_delivery, remaining = Delivery._shahtaj_fifo_allocate_product_qtys(
                deliveries, van_apply,
            )
            for pid, left in remaining.items():
                product = self.env['product.product'].browse(pid)
                rounding = product.uom_id.rounding or 0.01
                if float_compare(left, 0.0, precision_rounding=rounding) > 0:
                    raise UserError(_(
                        'Could not apply %(qty)s of %(product)s from van to today’s shops.',
                        qty=left,
                        product=product.display_name,
                    ))
            for delivery_id, qty_map in qty_by_delivery.items():
                Delivery.browse(delivery_id)._attribute_van_stock_with_qtys(
                    qty_map, reload_form=False,
                )
                shops_touched.add(delivery_id)

        if wh_move:
            deliveries = Delivery.search(
                Delivery._shahtaj_today_open_jobs_domain(dm, day),
                order='id',
            )
            qty_by_delivery, remaining = Delivery._shahtaj_fifo_allocate_product_qtys(
                deliveries, wh_move,
            )
            for pid, left in remaining.items():
                product = self.env['product.product'].browse(pid)
                rounding = product.uom_id.rounding or 0.01
                if float_compare(left, 0.0, precision_rounding=rounding) > 0:
                    raise UserError(_(
                        'Could not allocate %(qty)s of %(product)s across today\'s shops.',
                        qty=left,
                        product=product.display_name,
                    ))
            for delivery_id, qty_map in qty_by_delivery.items():
                Delivery.browse(delivery_id)._pick_stock_with_qtys(
                    qty_map, reload_form=False,
                )
                shops_touched.add(delivery_id)

        return {
            'jobs_picked': len(shops_touched),
            'van_skus_applied': len(van_apply),
            'warehouse_skus_picked': len(wh_move),
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
        free_map = self.env['shahtaj.dm.delivery']._shahtaj_unattributed_van_qty_map(
            dm, set(van_map) if van_map else set(),
        )
        Product = self.env['product.product'].sudo()
        products = Product.browse(list(van_map.keys()))
        product_by_id = {product.id: product for product in products}
        for pid, qty in sorted(van_map.items(), key=lambda x: x[0]):
            product = product_by_id.get(pid)
            if not product or qty <= 0:
                continue
            items.append({
                'product_id': pid,
                'name': product.display_name,
                'qty': qty,
                'qty_free': free_map.get(pid, 0.0),
                'uom': product.uom_id.name if product.uom_id else '',
            })
        return {
            'van_location_id': van.id if van else False,
            'items': items,
            'qty_total': sum(i['qty'] for i in items),
            'qty_free_total': sum(i['qty_free'] for i in items),
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
        free_map = self.env['shahtaj.dm.delivery']._shahtaj_unattributed_van_qty_map(
            dm, set(pids),
        )
        rows = []
        for product in products:
            wh_qty = wh_map.get(product.id, 0.0)
            van_qty = van_map.get(product.id, 0.0)
            free_qty = free_map.get(product.id, 0.0)
            if wh_qty <= 0 and van_qty <= 0:
                continue
            rows.append({
                'product_id': product.id,
                'name': product.display_name,
                'qty_in_warehouse': wh_qty,
                'qty_on_van': van_qty,
                'qty_free_on_van': free_qty,
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
        self._prefetch_jobs(ordered)
        session = self.env['shahtaj.dm.day.session'].get_or_create_today(dm, day)
        limits = self.env['res.company'].shahtaj_get_shop_distance_limits()
        return {
            'date': str(day),
            'session': {
                'id': session.id,
                'state': session.state,
                'departed_at': session.departed_at.isoformat(sep=' ') if session.departed_at else False,
                'ended_at': session.ended_at.isoformat(sep=' ') if session.ended_at else False,
            },
            'jobs': [self.job_brief(j) for j in ordered],
            'gps_criteria': {
                'min_m': float(limits.get('min_m') or 0.0),
                'max_m': float(limits.get('max_m') or 0.0),
            },
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
            'receiver_name': job.receiver_name or '',
            'has_delivery_proof': bool(job.has_delivery_proof),
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
    def deliver_job(
        self,
        job_id,
        latitude,
        longitude,
        lines,
        notes=None,
        receiver_name=None,
        delivery_proof_image=None,
        dm=None,
    ):
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
            receiver_name=receiver_name,
            delivery_proof_image=delivery_proof_image,
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
    def _company_sale_pricelist(self, company=None):
        """Company default pricelist (walk-in never uses DM-entered prices).

        Creates a company pricelist automatically if the DB has none yet
        (common on fresh Shahtaj DBs). Empty rules → product list_price.
        """
        company = company or self.env.company
        Pricelist = self.env['product.pricelist'].sudo()
        partner = company.partner_id.with_company(company)
        pl = partner.property_product_pricelist
        if pl:
            return pl
        pl = Pricelist.search([
            '|', ('company_id', '=', False), ('company_id', '=', company.id),
        ], limit=1, order='sequence, id')
        if pl:
            return pl
        return Pricelist.create({
            'name': _('Company Pricelist'),
            'currency_id': company.currency_id.id,
            'company_id': company.id,
            'sequence': 1,
        })

    @api.model
    def _validate_walk_in_gps(self, latitude, longitude, partner=None):
        """Require valid GPS for walk-in (capture is the location of sale)."""
        Attempt = self.env['shahtaj.gps.attempt']
        if latitude is None or longitude is None:
            msg = _('Your GPS coordinates are required for walk-in delivery.')
            Attempt.log_attempt(
                purpose='walk_in',
                result='blocked_missing_user_gps',
                shop=partner,
                latitude=latitude,
                longitude=longitude,
                message=msg,
            )
            raise UserError(msg)
        lat = float(latitude)
        lng = float(longitude)
        if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
            msg = _('GPS latitude/longitude values are out of range.')
            Attempt.log_attempt(
                purpose='walk_in',
                result='blocked_invalid_coords',
                shop=partner,
                latitude=lat,
                longitude=lng,
                message=msg,
            )
            raise UserError(msg)
        return lat, lng

    @api.model
    def _ensure_walk_in_partner(self, customer_name, phone, latitude, longitude):
        """Create or reuse a minimal non-shop walk-in customer."""
        name = (customer_name or '').strip()
        if not name:
            raise UserError(_('customer_name is required.'))
        phone_clean = (phone or '').strip() or False
        Partner = self.env['res.partner'].sudo()
        partner = Partner.browse()
        if phone_clean:
            partner = Partner.search([
                ('shahtaj_is_walk_in', '=', True),
                ('is_shahtaj_shop', '=', False),
                ('phone', '=', phone_clean),
                ('company_id', 'in', [False, self.env.company.id]),
            ], limit=1)
        if partner:
            partner.write({
                'partner_latitude': latitude,
                'partner_longitude': longitude,
                'name': name,
            })
            return partner
        return Partner.with_context(
            tracking_disable=True,
            mail_create_nosubscribe=True,
            mail_notrack=True,
        ).create({
            'name': name,
            'phone': phone_clean,
            'customer_rank': 1,
            'company_type': 'person',
            'is_shahtaj_shop': False,
            'shahtaj_is_walk_in': True,
            'partner_latitude': latitude,
            'partner_longitude': longitude,
            'company_id': self.env.company.id,
            'comment': _('Created by DM walk-in delivery'),
        })

    @api.model
    def walk_in_deliver(
        self,
        customer_name,
        latitude,
        longitude,
        lines,
        receiver_name=None,
        delivery_proof_image=None,
        phone=None,
        notes='',
        payment_method='cash',
        cheque_number=None,
        cheque_image=None,
        dm=None,
    ):
        """Walk-in: minimal customer + SO (company pricelist) + van deliver + full DM wallet pay."""
        dm = dm or self._dm_user()
        company = self.env.company
        lat, lng = self._validate_walk_in_gps(latitude, longitude)

        Delivery = self.env['shahtaj.dm.delivery']
        proof_vals = Delivery._shahtaj_prepare_delivery_proof(
            receiver_name=receiver_name,
            delivery_proof_image=delivery_proof_image,
        )

        qty_map = {}
        for row in lines or []:
            pid = int(row.get('product_id') or 0)
            qty = float(row.get('qty') or 0.0)
            if pid and qty > 0:
                qty_map[pid] = qty_map.get(pid, 0.0) + qty
        if not qty_map:
            raise UserError(_('Enter a deliver quantity on at least one product.'))

        # Only surplus (unattributed) van stock — never drain reserved job stock.
        Delivery._shahtaj_assert_van_surplus(dm, qty_map, _('walk-in deliver'))

        van = Delivery._ensure_van_location_for_dm(dm)
        van_map = self._van_qty_map(dm, list(qty_map.keys()))
        Product = self.env['product.product'].sudo()
        for pid, qty in qty_map.items():
            available = van_map.get(pid, 0.0)
            if available + 1e-6 < qty:
                product = Product.browse(pid)
                raise UserError(_(
                    'Not enough %(product)s on van (need %(need)s, have %(avail)s).',
                    product=product.display_name if product.exists() else pid,
                    need=qty,
                    avail=available,
                ))

        partner = self._ensure_walk_in_partner(customer_name, phone, lat, lng)
        # Audit GPS against the walk-in customer record.
        self.env['shahtaj.gps.attempt'].log_attempt(
            purpose='walk_in',
            result='ok',
            shop=partner,
            latitude=lat,
            longitude=lng,
            distance_m=0.0,
            message=_('Walk-in delivery GPS captured'),
        )

        pricelist = self._company_sale_pricelist(company)
        # Always available after ensure/create above.
        Sale = self.env['sale.order'].sudo()
        order_lines = []
        for pid, qty in qty_map.items():
            product = Product.browse(pid)
            if not product.exists() or not product.sale_ok:
                raise UserError(_(
                    'Product %(name)s cannot be sold.',
                    name=product.display_name if product.exists() else pid,
                ))
            order_lines.append((0, 0, {
                'product_id': product.id,
                'product_uom_qty': qty,
                'product_uom_id': product.uom_id.id,
            }))

        order = Sale.with_context(
            shahtaj_skip_credit_check=True,
            tracking_disable=True,
        ).create({
            'partner_id': partner.id,
            'partner_invoice_id': partner.id,
            'partner_shipping_id': partner.id,
            'pricelist_id': pricelist.id,
            'company_id': company.id,
            'user_id': dm.id,
            'origin': _('DM Walk-in'),
            'client_order_ref': _('WALK-IN'),
            'note': (notes or '').strip() or False,
            'order_line': order_lines,
        })
        order.with_context(shahtaj_skip_credit_check=True).action_confirm()

        # Drop auto WH→customer pickings; stock leaves from the van instead.
        auto_pickings = order.picking_ids.filtered(
            lambda p: p.state not in ('done', 'cancel')
        )
        if auto_pickings:
            auto_pickings.action_cancel()

        warehouse = Delivery._get_warehouse()
        customer_loc = partner.property_stock_customer
        if not customer_loc:
            customer_loc = self.env.ref(
                'stock.stock_location_customers', raise_if_not_found=False,
            )
        if not customer_loc:
            raise UserError(_('No customer stock location found.'))
        out_type = warehouse.out_type_id
        if not out_type:
            raise UserError(_('No delivery operation type on the warehouse.'))

        sol_by_product = {
            line.product_id.id: line
            for line in order.order_line
            if line.product_id and not line.display_type
        }
        move_vals_list = []
        for pid, qty in qty_map.items():
            product = Product.browse(pid)
            sol = sol_by_product.get(pid)
            vals = {
                'product_id': product.id,
                'product_uom_qty': qty,
                'product_uom': product.uom_id.id,
                'location_id': van.id,
                'location_dest_id': customer_loc.id,
            }
            if sol:
                vals['sale_line_id'] = sol.id
            move_vals_list.append(vals)

        picking = Delivery._create_stock_picking(
            picking_type=out_type,
            location_id=van,
            location_dest_id=customer_loc,
            origin=_('DM Walk-in: %s', order.name),
            move_vals_list=move_vals_list,
            partner_id=partner.id,
            sale_id=order.id,
        )
        picking.write({
            'shahtaj_receiver_name': proof_vals['receiver_name'],
            'shahtaj_delivery_proof_image': proof_vals['delivery_proof_image'],
        })
        picking.action_confirm()
        picking.action_assign()
        for move in picking.move_ids:
            move.quantity = move.product_uom_qty
            if hasattr(move, 'picked'):
                move.picked = True
        picking.with_context(skip_backorder=True, skip_sms=True).button_validate()

        invoices = order._create_invoices()
        if not invoices:
            raise UserError(_('Could not create an invoice for the walk-in order.'))
        invoices.action_post()
        invoice = invoices[0]
        residual = abs(invoice.amount_residual)
        if float_compare(residual, 0.0, precision_rounding=company.currency_id.rounding) <= 0:
            raise UserError(_('Walk-in invoice has nothing to collect.'))

        Service = self._recovery_service()
        payments = Service.collect_payments(
            delivery_man=dm,
            allocations=[(invoice, residual)],
            notes=notes or _('Walk-in collection — %s', partner.display_name),
            company=company,
            payment_method=payment_method or 'cash',
            cheque_number=cheque_number,
            cheque_image=cheque_image,
        )
        payment = payments[:1]
        channel = payment.shahtaj_payment_channel if payment else (payment_method or 'cash')

        return {
            'partner_id': partner.id,
            'partner_name': partner.display_name,
            'phone': partner.phone or '',
            'latitude': lat,
            'longitude': lng,
            'sale_order_id': order.id,
            'sale_order_name': order.name,
            'invoice_id': invoice.id,
            'invoice_name': invoice.name,
            'amount_total': invoice.amount_total,
            'payment_id': payment.id if payment else False,
            'payment_ids': payments.ids,
            'payment_method': channel or 'cash',
            'cheque_number': (
                payment.shahtaj_instrument_reference or ''
            ) if payment and (channel or '') == 'cheque' else '',
            'picking_id': picking.id,
            'receiver_name': proof_vals['receiver_name'],
            'has_delivery_proof': True,
            'notes': (notes or '').strip(),
            'wallet': Service.wallet_summary(dm),
            'van': self.van_snapshot(dm),
            'lines': [{
                'product_id': line.product_id.id,
                'name': line.product_id.display_name,
                'qty': line.product_uom_qty,
                'price_unit': line.price_unit,
                'price_subtotal': line.price_subtotal,
            } for line in order.order_line if line.product_id and not line.display_type],
        }

    # ── Recovery / wallet (independent of check-in) ───────────────────

    @api.model
    def _recovery_service(self):
        return self.env['shahtaj.dm.recovery.service']

    @api.model
    def _resolve_recovery_shop(self, shop_id, dm=None):
        """Resolve shop by shop_id only. No GPS / delivery job required."""
        if not shop_id:
            raise UserError(_('shop_id is required.'))
        shop = self.env['res.partner'].sudo().browse(int(shop_id))
        if not shop.exists():
            raise UserError(_('Shop not found.'))
        return shop

    @api.model
    def recovery_shop(self, shop_id=None, dm=None):
        dm = dm or self._dm_user()
        shop = self._resolve_recovery_shop(shop_id, dm=dm)
        return self._recovery_service().shop_recovery_payload(
            shop, delivery_man=dm,
        )

    @api.model
    def recovery_collect(
        self,
        shop_id=None,
        allocations=None,
        notes='',
        payment_method='cash',
        cheque_number=None,
        cheque_image=None,
        dm=None,
    ):
        """Collect into DM wallet. Independent of check-in / delivery state.

        ``payment_method``: ``cash`` (default) or ``cheque`` (needs number + photo).
        Method is supporting metadata — journal stays DMCASH.
        """
        dm = dm or self._dm_user()
        shop = self._resolve_recovery_shop(shop_id, dm=dm)
        Service = self._recovery_service()
        open_invoices = Service._open_customer_invoices(shop)
        open_ids = set(open_invoices.ids)

        cleaned = []
        for row in allocations or []:
            if not isinstance(row, dict):
                continue
            inv_id = int(row.get('invoice_id') or 0)
            amount = float(row.get('amount') or 0.0)
            if not inv_id or amount <= 0:
                continue
            if inv_id not in open_ids:
                raise UserError(_(
                    'Invoice %(id)s is not an open receivable for this shop.',
                    id=inv_id,
                ))
            cleaned.append({'invoice_id': inv_id, 'amount': amount})

        payments = Service.collect_payments(
            delivery_man=dm,
            allocations=cleaned,
            notes=notes or '',
            delivery=None,
            payment_method=payment_method or 'cash',
            cheque_number=cheque_number,
            cheque_image=cheque_image,
        )
        channel = payments[:1].shahtaj_payment_channel if payments else (payment_method or 'cash')
        return {
            'shop_id': shop.id,
            'shop_name': shop.display_name,
            'collected_amount': sum(payments.mapped('amount')),
            'payment_method': channel or 'cash',
            'cheque_number': (
                payments[:1].shahtaj_instrument_reference or ''
            ) if channel == 'cheque' else '',
            'has_cheque_image': bool(payments[:1].shahtaj_has_cheque_image) if payments else False,
            'payment_ids': payments.ids,
            'payments': [{
                'payment_id': p.id,
                'name': p.name,
                'amount': p.amount,
                'date': str(p.date) if p.date else False,
                'payment_method': p.shahtaj_payment_channel or 'cash',
                'cheque_number': (
                    p.shahtaj_instrument_reference or ''
                ) if (p.shahtaj_payment_channel or '') == 'cheque' else '',
                'has_cheque_image': bool(p.shahtaj_has_cheque_image),
            } for p in payments],
            'wallet': Service.wallet_summary(dm),
            'shop': Service.shop_recovery_payload(shop, delivery_man=dm),
        }

    @api.model
    def wallet_get(self, dm=None):
        dm = dm or self._dm_user()
        return self._recovery_service().wallet_summary(dm)

    @api.model
    def wallet_collections(self, date_from=None, date_to=None, limit=50, dm=None):
        dm = dm or self._dm_user()
        return self._recovery_service().list_collections(
            dm,
            date_from=date_from or None,
            date_to=date_to or None,
            limit=limit,
        )
