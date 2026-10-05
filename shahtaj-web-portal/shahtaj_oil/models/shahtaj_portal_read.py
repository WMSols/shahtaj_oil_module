# -*- coding: utf-8 -*-
"""Read-only portal queries. Existing models are unchanged."""
from datetime import datetime, timedelta

from odoo import api, models

PAID_STATES = ('paid', 'in_process', 'posted', 'reconciled')
MONTHS = (
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
)
ALL_CARDS = (
    'territory', 'checkins', 'orders', 'dispatch', 'deliveryJobs',
    'staffBookers', 'deliveryMen', 'warehouse', 'schedules',
    'financials', 'invoices',
)


class ShahtajPortalRead(models.AbstractModel):
    _name = 'shahtaj.portal.read'
    _description = 'Shahtaj portal read API'

    def _portal_role(self):
        user = self.env.user
        if user.has_group('shahtaj_oil.group_shahtaj_kpo'):
            return 'kpo'
        if user.has_group('shahtaj_oil.group_shahtaj_warehouse'):
            return 'warehouse'
        if user.has_group('shahtaj_oil.group_shahtaj_manager'):
            return 'manager'
        return 'distributor'

    def _financial_access(self):
        role = self._portal_role()
        if role in ('kpo', 'warehouse'):
            return True
        return self.env.user.has_group('shahtaj_oil.group_shahtaj_distributor_financial')

    def _allowed_cards(self):
        role = self._portal_role()
        if role == 'kpo':
            cards = {'orders', 'invoices'}
        elif role == 'warehouse':
            cards = {'deliveryMen', 'deliveryJobs', 'warehouse'}
        else:
            cards = set(ALL_CARDS)
            if role == 'manager':
                cards.discard('financials')
        if not self._financial_access():
            cards.discard('financials')
            cards.discard('invoices')
        return cards

    def _pkt_today(self):
        return (datetime.utcnow() + timedelta(hours=5)).date()

    def _pkt_bounds(self, date_str):
        day = datetime.strptime(date_str, '%Y-%m-%d')
        start = day - timedelta(hours=5)
        end = day + timedelta(hours=18, minutes=59, seconds=59)
        return (
            start.strftime('%Y-%m-%d %H:%M:%S'),
            end.strftime('%Y-%m-%d %H:%M:%S'),
        )

    def _pkt_weekday(self, date_str=None):
        if date_str:
            moment = datetime.strptime(date_str, '%Y-%m-%d') + timedelta(hours=7)
        else:
            moment = datetime.utcnow() + timedelta(hours=5)
        # Monday = 0, matching the portal.
        return str(moment.weekday())

    def _count(self, model, domain, context=None):
        return self.env[model].with_context(context or {}).search_count(domain)

    def _page(self, page, limit):
        page = max(int(page or 1), 1)
        limit = max(int(limit or 50), 1)
        return page, limit, (page - 1) * limit

    def _cash_range(self, days):
        days = max(int(days or 30), 1)
        end = self._pkt_today()
        start = end - timedelta(days=days - 1)
        return start.isoformat(), end.isoformat()

    def _day_keys(self, date_from, date_to):
        start = datetime.strptime(date_from, '%Y-%m-%d').date()
        end = datetime.strptime(date_to, '%Y-%m-%d').date()
        keys = []
        cursor = start
        while cursor <= end:
            keys.append(cursor.isoformat())
            cursor += timedelta(days=1)
        return keys

    def _day_label(self, day_key):
        day = datetime.strptime(day_key, '%Y-%m-%d')
        return '%s %s' % (day.day, MONTHS[day.month - 1])

    def _payment_domain(self, date_from, date_to):
        return [
            ('journal_id.type', 'in', ['bank', 'cash']),
            ('date', '>=', date_from),
            ('date', '<=', date_to),
            ('state', 'in', list(PAID_STATES)),
        ]

    def _cash_math(self, date_from, date_to, with_chart=False):
        domain = self._payment_domain(date_from, date_to)
        groups = self.env['account.payment'].read_group(
            domain, ['amount:sum'], ['payment_type'],
        )
        cash_in = 0.0
        cash_out = 0.0
        count_in = 0
        count_out = 0
        for group in groups:
            amount = group.get('amount') or 0.0
            count = group.get('__count') or group.get('payment_type_count') or 0
            if group.get('payment_type') == 'outbound':
                cash_out += amount
                count_out += count
            else:
                cash_in += amount
                count_in += count
        shops = self.env['res.partner'].search([
            ('is_shahtaj_shop', '=', True),
            ('shop_approval_state', '=', 'approved'),
        ])
        still_owed = sum(shops.mapped('outstanding_balance'))
        invoice_rows = self.env['account.move'].read_group(
            [
                ('move_type', '=', 'out_invoice'),
                ('partner_id.is_shahtaj_shop', '=', True),
                ('state', '=', 'posted'),
                ('payment_state', 'in', ['not_paid', 'partial']),
            ],
            ['amount_residual:sum'],
            [],
        )
        open_invoice_amount = float(invoice_rows[0].get('amount_residual') or 0.0) if invoice_rows else 0.0
        result = {
            'cashIn': cash_in,
            'cashOut': cash_out,
            'netCash': cash_in - cash_out,
            'collected': cash_in,
            'paidOut': cash_out,
            'stillOwed': still_owed,
            'openInvoiceAmount': open_invoice_amount,
            'paymentCountIn': count_in,
            'paymentCountOut': count_out,
        }
        if with_chart:
            by_day = {key: {'cashIn': 0.0, 'cashOut': 0.0} for key in self._day_keys(date_from, date_to)}
            for payment_type, bucket_key in (('inbound', 'cashIn'), ('outbound', 'cashOut')):
                daily = self.env['account.payment'].read_group(
                    domain + [('payment_type', '=', payment_type)],
                    ['amount:sum'],
                    ['date:day'],
                )
                for group in daily:
                    bounds = (group.get('__range') or {}).get('date:day') or {}
                    day = str(bounds.get('from') or group.get('date:day') or '')[:10]
                    bucket = by_day.get(day)
                    if bucket:
                        bucket[bucket_key] += group.get('amount') or 0.0
            keys = list(by_day)
            result['cashTrend'] = {
                'labels': [self._day_label(key) for key in keys],
                'cashIn': [by_day[key]['cashIn'] for key in keys],
                'cashOut': [by_day[key]['cashOut'] for key in keys],
            }
        return result

    def _stock_counts(self):
        domain = [
            ('sale_ok', '=', True),
            ('default_code', '!=', 'SHAHTAJ-LEGACY'),
            ('active', '=', True),
        ]
        templates = self.env['product.template'].search(domain)
        total = len(templates)
        if not templates:
            return 0, 0
        self.env.cr.execute(
            """
            SELECT pp.product_tmpl_id,
                   COALESCE(SUM(
                       CASE
                           WHEN loc.usage = 'internal'
                           THEN q.quantity - COALESCE(q.reserved_quantity, 0)
                           ELSE 0
                       END
                   ), 0)
            FROM product_product pp
            LEFT JOIN stock_quant q ON q.product_id = pp.id
            LEFT JOIN stock_location loc ON loc.id = q.location_id
            WHERE pp.product_tmpl_id IN %s
            GROUP BY pp.product_tmpl_id
            """,
            [tuple(templates.ids)],
        )
        qty_by_template = {row[0]: row[1] for row in self.env.cr.fetchall()}
        out_of_stock = sum(
            1 for template_id in templates.ids
            if qty_by_template.get(template_id, 0) <= 0
        )
        return total, out_of_stock

    @api.model
    def shahtaj_portal_overview(self, ops_date, shop_reg_date, cash_range_days):
        cards = self._allowed_cards()
        ops_date = ops_date or self._pkt_today().isoformat()
        shop_reg_date = shop_reg_date or ops_date
        ops_start, ops_end = self._pkt_bounds(ops_date)
        reg_start, reg_end = self._pkt_bounds(shop_reg_date)
        result = {}
        if 'territory' in cards:
            result.update({
                'totalZones': self._count('shahtaj.zone', [('active', '=', True)]),
                'totalRoutes': self._count('shahtaj.route', [('active', '=', True)]),
                'totalShops': self._count('res.partner', [
                    ('is_shahtaj_shop', '=', True), ('active', '=', True),
                ]),
                'pendingShops': self._count('res.partner', [
                    ('is_shahtaj_shop', '=', True),
                    ('active', '=', True),
                    ('shop_approval_state', '=', 'pending'),
                ]),
                'shopsRegisteredByOb': self._count('res.partner', [
                    ('is_shahtaj_shop', '=', True),
                    ('registered_by_id', '!=', False),
                    ('registered_by_id.shahtaj_is_order_booker', '=', True),
                    ('create_date', '>=', reg_start),
                    ('create_date', '<=', reg_end),
                ]),
            })
        if 'staffBookers' in cards:
            booker_domain = [('shahtaj_is_order_booker', '=', True), ('active', '=', True)]
            result.update({
                'totalBookers': self._count('res.users', booker_domain),
                'onlineBookers': self._count('res.users', booker_domain + [
                    ('shahtaj_online_status', '=', 'online'),
                ]),
            })
        if 'checkins' in cards:
            result['todayCheckins'] = self._count('shahtaj.gps.attempt', [
                ('purpose', '=', 'check_in'),
                ('create_date', '>=', ops_start),
                ('create_date', '<=', ops_end),
            ])
        if 'orders' in cards:
            result['todayOrders'] = self._count('sale.order', [
                ('shahtaj_visit_id', '!=', False),
                ('date_order', '>=', ops_start),
                ('date_order', '<=', ops_end),
            ])
        if 'dispatch' in cards:
            result['todayDeliveries'] = self._count('sale.order', [
                '|',
                ('shahtaj_visit_id', '!=', False),
                ('partner_id.is_shahtaj_shop', '=', True),
                ('state', 'in', ['sale', 'done']),
                ('shahtaj_delivery_status', 'in', ['pending', 'partial']),
                ('shahtaj_qty_to_deliver', '>', 0),
                ('date_order', '>=', ops_start),
                ('date_order', '<=', ops_end),
            ])
            result['ordersToDispatch'] = self._count('sale.order', [
                ('state', 'in', ['sale', 'done']),
                ('shahtaj_delivery_status', 'in', ['pending', 'partial']),
                ('shahtaj_qty_to_deliver', '>', 0),
                ('shahtaj_dm_delivery_ids', '=', False),
            ])
        if 'warehouse' in cards:
            total_products, out_of_stock = self._stock_counts()
            result.update({
                'totalProducts': total_products,
                'outOfStockProducts': out_of_stock,
            })
        if 'schedules' in cards:
            result.update({
                'activeSchedules': self._count('shahtaj.weekly.schedule', [('active', '=', True)]),
                'activeTargets': self._count('shahtaj.visit.target', [('active', '=', True)]),
            })
        if 'deliveryMen' in cards:
            dm_domain = [('shahtaj_is_delivery_man', '=', True), ('active', '=', True)]
            result.update({
                'totalDeliveryMen': self._count('res.users', dm_domain),
                'onlineDeliveryMen': self._count('res.users', dm_domain + [
                    ('shahtaj_online_status', '=', 'online'),
                ]),
            })
        if 'deliveryJobs' in cards:
            result.update({
                'dmJobsToday': self._count('shahtaj.dm.delivery', [
                    ('scheduled_date', '=', ops_date),
                    ('state', '!=', 'not_ready'),
                ]),
                'todayInTransit': self._count('shahtaj.dm.delivery', [
                    ('scheduled_date', '=', ops_date),
                    ('field_state', '=', 'in_transit'),
                ]),
                'pendingDeliveries': self._count('shahtaj.dm.delivery', [
                    ('field_state', '=', 'pending'),
                ]),
                'dmJobsActive': self._count('shahtaj.dm.delivery', [
                    ('state', 'in', ['ready', 'picked', 'partial']),
                ]),
                'dmInTransit': self._count('shahtaj.dm.delivery', [
                    ('field_state', '=', 'in_transit'),
                ]),
            })
        if 'invoices' in cards:
            result.update({
                'totalOrders': self._count('sale.order', [('shahtaj_visit_id', '!=', False)]),
                'toInvoice': self._count('sale.order', [
                    ('shahtaj_visit_id', '!=', False),
                    ('invoice_status', '=', 'to invoice'),
                ]),
                'openInvoices': self._count('account.move', [
                    ('move_type', 'in', ['out_invoice']),
                    ('partner_id.is_shahtaj_shop', '=', True),
                    ('state', '=', 'posted'),
                    ('payment_state', 'in', ['not_paid', 'partial']),
                ]),
                'creditNotes': self._count('account.move', [
                    ('move_type', '=', 'out_refund'),
                    ('partner_id.is_shahtaj_shop', '=', True),
                ]),
                'vendorBills': self._count('account.move', [
                    ('move_type', 'in', ['in_invoice', 'in_refund']),
                    ('state', 'in', ['draft', 'posted']),
                ]) if self._portal_role() in ('distributor', 'manager') else 0,
            })
        if 'financials' in cards:
            date_from, date_to = self._cash_range(cash_range_days)
            result.update(self._cash_math(date_from, date_to, with_chart=True))
        return result

    @api.model
    def shahtaj_cash_summary(self, date_from, date_to):
        if not self._financial_access() or self._portal_role() == 'manager':
            return {}
        summary = self._cash_math(date_from, date_to, with_chart=False)
        return {
            'collected': summary['collected'],
            'paidOut': summary['paidOut'],
            'netCash': summary['netCash'],
            'stillOwed': summary['stillOwed'],
            'openInvoiceAmount': summary['openInvoiceAmount'],
            'paymentCountIn': summary['paymentCountIn'],
            'paymentCountOut': summary['paymentCountOut'],
        }

    def _m2o_name(self, value, fallback):
        if isinstance(value, (list, tuple)) and len(value) > 1:
            return value[1]
        return fallback

    def _activity_rows(self, filters):
        filters = filters or {}
        pay_domain = [('journal_id.type', 'in', ['bank', 'cash'])]
        exp_domain = [('journal_id.type', 'in', ['bank', 'cash'])]
        search = filters.get('search') or ''
        if search:
            pay_domain = [
                '|', '|',
                ('partner_id.name', 'ilike', search),
                ('name', 'ilike', search),
                ('shahtaj_instrument_reference', 'ilike', search),
            ] + pay_domain
            exp_domain = [
                '|', '|',
                ('partner_id.name', 'ilike', search),
                ('name', 'ilike', search),
                ('description', 'ilike', search),
            ] + exp_domain
        journal = filters.get('journal') or 'all'
        if journal != 'all':
            journal_id = int(journal)
            pay_domain.append(('journal_id', '=', journal_id))
            exp_domain.append(('journal_id', '=', journal_id))
        if filters.get('dateFrom'):
            pay_domain.append(('date', '>=', filters['dateFrom']))
            exp_domain.append(('date', '>=', filters['dateFrom']))
        if filters.get('dateTo'):
            pay_domain.append(('date', '<=', filters['dateTo']))
            exp_domain.append(('date', '<=', filters['dateTo']))
        direction = filters.get('direction') or 'all'
        rows = []
        if direction != 'expense':
            payments = self.env['account.payment'].search_read(pay_domain, [
                'id', 'name', 'date', 'journal_id', 'partner_id', 'amount', 'amount_signed',
                'state', 'payment_type', 'shahtaj_payment_channel',
                'shahtaj_payer_bank_name', 'shahtaj_payer_account_number',
                'shahtaj_instrument_reference', 'shahtaj_payment_notes',
                'shahtaj_is_dm_wallet_collection', 'shahtaj_collected_by_dm_id',
            ])
            for payment in payments:
                if direction == 'outbound' and payment.get('payment_type') != 'outbound':
                    continue
                if direction == 'inbound' and payment.get('payment_type') != 'inbound':
                    continue
                display = abs(payment.get('amount_signed') or payment.get('amount') or 0)
                rows.append({
                    '_model': 'account.payment',
                    'id': 'account.payment:%s' % payment['id'],
                    'name': payment.get('name'),
                    'date': payment.get('date'),
                    'journal_name': self._m2o_name(payment.get('journal_id'), 'Unknown'),
                    'partner_name': self._m2o_name(payment.get('partner_id'), 'Unknown'),
                    'dm_name': self._m2o_name(payment.get('shahtaj_collected_by_dm_id'), ''),
                    'is_dm_collection': bool(payment.get('shahtaj_is_dm_wallet_collection')),
                    'method_or_desc': payment.get('shahtaj_payment_channel') or 'System',
                    'display_amount': display,
                    'payment_type': payment.get('payment_type'),
                    'flow_label': 'Paid Out' if payment.get('payment_type') == 'outbound' else 'Collected',
                    'state': payment.get('state'),
                    'raw': payment,
                })
        if direction not in ('inbound', 'outbound'):
            expenses = self.env['shahtaj.expense'].search_read(exp_domain, [
                'id', 'name', 'date', 'journal_id', 'partner_id', 'amount',
                'state', 'description', 'category_id', 'notes',
            ])
            for expense in expenses:
                rows.append({
                    '_model': 'shahtaj.expense',
                    'id': 'shahtaj.expense:%s' % expense['id'],
                    'name': expense.get('name'),
                    'date': expense.get('date'),
                    'journal_name': self._m2o_name(expense.get('journal_id'), 'Unknown'),
                    'partner_name': self._m2o_name(
                        expense.get('partner_id'),
                        self._m2o_name(expense.get('category_id'), 'Expense'),
                    ),
                    'dm_name': '',
                    'method_or_desc': expense.get('description') or 'Operating Expense',
                    'display_amount': expense.get('amount') or 0,
                    'payment_type': 'outbound',
                    'flow_label': 'Expense',
                    'state': expense.get('state'),
                    'raw': expense,
                })
        money_in = 0.0
        money_out = 0.0
        for row in rows:
            if row['state'] in PAID_STATES:
                if row['payment_type'] == 'outbound':
                    money_out += row['display_amount']
                else:
                    money_in += row['display_amount']
        sort_by = filters.get('sortBy') or 'date_desc'

        def sort_date(row):
            value = row.get('date') or ''
            if hasattr(value, 'isoformat'):
                return value.isoformat()
            return str(value)

        if sort_by == 'amount_asc':
            rows.sort(key=lambda row: row['display_amount'])
        elif sort_by == 'amount_desc':
            rows.sort(key=lambda row: row['display_amount'], reverse=True)
        else:
            rows.sort(key=sort_date, reverse=True)
        return rows, money_in, money_out

    @api.model
    def shahtaj_cash_activity_page(self, filters, page, limit):
        if not self._financial_access() or self._portal_role() == 'manager':
            return {'rows': [], 'total': 0, 'moneyIn': 0, 'moneyOut': 0, 'net': 0}
        rows, money_in, money_out = self._activity_rows(filters)
        _page, limit, start = self._page(page, limit)
        return {
            'rows': rows[start:start + limit],
            'total': len(rows),
            'moneyIn': money_in,
            'moneyOut': money_out,
            'net': money_in - money_out,
        }

    @api.model
    def shahtaj_credit_balance_page(self, filters, page, limit):
        filters = filters or {}
        domain = [
            ('is_shahtaj_shop', '=', True),
            ('shop_approval_state', '=', 'approved'),
        ]
        if filters.get('creditSubView') == 'risk':
            domain.append(('shahtaj_shop_category', '=', 'credit'))
        if filters.get('hasCreditLimit'):
            domain.append(('credit_limit', '>', 0))
        search = filters.get('search') or ''
        if search:
            domain = [
                '|', ('name', 'ilike', search), ('owner_name', 'ilike', search),
            ] + domain
        records = self.env['res.partner'].search_read(domain, [
            'name', 'owner_name', 'shahtaj_shop_category', 'credit_limit', 'outstanding_balance',
        ])
        records.sort(key=lambda shop: shop.get('outstanding_balance') or 0, reverse=True)
        _page, limit, start = self._page(page, limit)
        return {'total': len(records), 'records': records[start:start + limit]}

    def _attempt_id(self, value):
        if isinstance(value, (list, tuple)):
            return value[0] if value else False
        return value or False

    def _checkin_key(self, row):
        task_id = self._attempt_id(row.get('visit_task_id'))
        if (
            row.get('role') == 'order_booker'
            and row.get('purpose') in ('check_in', 'place_order')
            and task_id
        ):
            marker = 'ok' if row.get('result') == 'ok' else 'blocked'
            return 'task:%s:%s' % (task_id, marker)
        return 'row:%s' % row['id']

    def _checkin_status_matches(self, result, status):
        if not status:
            return True
        if status == 'ok':
            return result == 'ok'
        if status == 'blocked':
            return result != 'ok'
        if status == 'blocked_too_far':
            return result == 'blocked_too_far'
        if status == 'blocked_too_close':
            return result == 'blocked_too_close'
        if status == 'blocked_missing':
            return result in (
                'blocked_missing_shop_gps',
                'blocked_missing_user_gps',
                'blocked_invalid_coords',
            )
        return True

    def _visit_index(self, attempts):
        visit_ids = {self._attempt_id(row.get('visit_id')) for row in attempts}
        dm_ids = {self._attempt_id(row.get('dm_delivery_id')) for row in attempts}
        visit_ids.discard(False)
        dm_ids.discard(False)
        by_id = {}
        by_dm = {}
        Visit = self.env['shahtaj.visit']
        if visit_ids:
            for visit in Visit.browse(list(visit_ids)):
                by_id[visit.id] = visit
        if dm_ids:
            for visit in Visit.search([('dm_delivery_id', 'in', list(dm_ids))]):
                if visit.dm_delivery_id:
                    by_dm[visit.dm_delivery_id.id] = visit
        return by_id, by_dm

    def _session_visit(self, headline, by_id, by_dm):
        visit = by_id.get(self._attempt_id(headline.get('visit_id')))
        if not visit:
            visit = by_dm.get(self._attempt_id(headline.get('dm_delivery_id')))
        return visit

    @api.model
    def shahtaj_checkin_session_page(self, filters, page, limit):
        filters = filters or {}
        domain = []
        search = filters.get('search') or ''
        if search:
            domain = [
                '|', '|',
                ('shop_id.name', 'ilike', search),
                ('user_id.name', 'ilike', search),
                ('message', 'ilike', search),
            ]
        booker = filters.get('booker') or 'all'
        if booker != 'all':
            domain.append(('user_id', '=', int(booker)))
        if filters.get('date'):
            start, end = self._pkt_bounds(filters['date'])
            domain += [('create_date', '>=', start), ('create_date', '<=', end)]
        role = filters.get('role') or 'all'
        if role != 'all':
            domain.append(('role', '=', role))
        fields = [
            'id', 'create_date', 'user_id', 'role', 'purpose', 'result', 'message',
            'shop_id', 'shop_latitude', 'shop_longitude',
            'attempt_latitude', 'attempt_longitude',
            'distance_m', 'min_distance_m', 'max_distance_m',
            'visit_task_id', 'visit_id', 'dm_delivery_id', 'sale_order_id',
        ]
        attempts = self.env['shahtaj.gps.attempt'].search_read(
            domain, fields, order='create_date desc, id desc',
        )
        groups = {}
        for attempt in attempts:
            groups.setdefault(self._checkin_key(attempt), []).append(attempt)
        by_id, by_dm = self._visit_index(attempts)
        sessions = []
        for members in groups.values():
            blocked = all(row.get('result') != 'ok' for row in members)
            if blocked:
                headline = sorted(members, key=lambda row: (row.get('create_date') or '', row['id']))[0]
            else:
                def newest(rows):
                    return sorted(rows, key=lambda row: (row.get('create_date') or '', row['id']), reverse=True)[0]
                place_ok = [row for row in members if row.get('result') == 'ok' and row.get('purpose') == 'place_order']
                check_ok = [row for row in members if row.get('result') == 'ok' and row.get('purpose') == 'check_in']
                headline = newest(place_ok or check_ok or members)
            latest = max((row.get('create_date') or '') for row in members)
            visit = self._session_visit(headline, by_id, by_dm)
            sessions.append({
                'headline': headline,
                'members': members,
                'latest': latest,
                'visit_state': visit.state if visit else '',
                'visit_outcome': visit.outcome if visit else '',
            })
        purpose = filters.get('purpose') or 'all'
        status = filters.get('status') or ''
        outcome = filters.get('outcome') or 'all'
        kept = []
        for session in sessions:
            headline = session['headline']
            if purpose and purpose != 'all':
                if headline.get('result') == 'ok':
                    purposes = [headline.get('purpose')]
                else:
                    purposes = [row.get('purpose') for row in session['members']]
                if purpose not in purposes:
                    continue
            if status:
                if headline.get('result') == 'ok':
                    results = [headline.get('result')]
                else:
                    results = [headline.get('result')] + [row.get('result') for row in session['members']]
                if not any(self._checkin_status_matches(result, status) for result in results):
                    continue
            if outcome and outcome != 'all':
                state = session['visit_state']
                key = session['visit_outcome']
                if outcome == 'in_progress' and state != 'in_progress':
                    continue
                if outcome == 'order' and key != 'order':
                    continue
                if outcome == 'no_order' and key != 'no_order':
                    continue
                if outcome == 'incomplete' and key != 'incomplete':
                    continue
                if outcome == 'undone' and key != 'undone':
                    continue
                if outcome == 'cancelled' and not (state == 'cancelled' and key != 'undone'):
                    continue
            kept.append(session)
        kept.sort(key=lambda session: (session['latest'], session['headline']['id']), reverse=True)
        _page, limit, start = self._page(page, limit)
        page_sessions = kept[start:start + limit]
        task_ids = set()
        for session in page_sessions:
            task_id = self._attempt_id(session['headline'].get('visit_task_id'))
            if task_id and str(self._checkin_key(session['headline'])).startswith('task:'):
                task_ids.add(task_id)
        attempt_ids = []
        seen = set()
        # Page sessions, plus every attempt on the same visit task, so the
        # screen can still share checkpoints across a visit.
        for session in sessions:
            task_id = self._attempt_id(session['headline'].get('visit_task_id'))
            if session not in page_sessions and task_id not in task_ids:
                continue
            for member in session['members']:
                if member['id'] not in seen:
                    seen.add(member['id'])
                    attempt_ids.append(member['id'])
        by_attempt = {row['id']: row for row in attempts}
        return {
            'total': len(kept),
            'headlineIds': [session['headline']['id'] for session in page_sessions],
            'attempts': [by_attempt[attempt_id] for attempt_id in attempt_ids if attempt_id in by_attempt],
        }

    @api.model
    def shahtaj_schedule_page(self, filters, page, limit):
        filters = filters or {}
        domain = []
        booker = filters.get('booker') or 'all'
        if booker != 'all':
            domain.append(('order_booker_id', '=', int(booker)))
        if filters.get('date'):
            domain.append(('day_of_week', '=', self._pkt_weekday(filters['date'])))
        schedule = self.env['shahtaj.weekly.schedule'].with_context(active_test=False)
        rows = schedule.search_read(domain, ['id', 'day_of_week', 'active'])
        today = int(self._pkt_weekday())

        def sort_key(row):
            try:
                day = int(row.get('day_of_week'))
                offset = (day - today + 7) % 7
            except (TypeError, ValueError):
                offset = 99
            return (offset, 0 if row.get('active') else 1, -(row.get('id') or 0))

        rows.sort(key=sort_key)
        _page, limit, start = self._page(page, limit)
        page_ids = [row['id'] for row in rows[start:start + limit]]
        if not page_ids:
            return {'total': len(rows), 'records': []}
        fields = [
            'id', 'name', 'day_of_week', 'route_id', 'zone_id',
            'active', 'shop_count', 'order_booker_id',
        ]
        records = schedule.browse(page_ids).read(fields)
        by_id = {record['id']: record for record in records}
        return {
            'total': len(rows),
            'records': [by_id[schedule_id] for schedule_id in page_ids if schedule_id in by_id],
        }
