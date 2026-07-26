# -*- coding: utf-8 -*-
"""Admin-only activity log HTML page and filtered JSON API."""
from datetime import datetime, time, timedelta

from odoo import _, fields, http
from odoo.exceptions import AccessError
from odoo.http import request
from odoo.tools.misc import file_path


class ShahtajActivityLogController(http.Controller):

    def _ensure_admin(self):
        user = request.env.user
        if not user or user._is_public() or not user.has_group('base.group_system'):
            raise AccessError(_('Only administrators can view Shahtaj activity logs.'))
        return user

    @http.route(
        '/shahtaj/activity-logs',
        type='http',
        auth='user',
        methods=['GET'],
        csrf=False,
    )
    def activity_log_index(self, **kwargs):
        self._ensure_admin()
        try:
            path = file_path('shahtaj_oil/static/src/activity_log/index.html')
        except (FileNotFoundError, ValueError):
            return request.make_response(
                'Activity log page missing.',
                headers=[('Content-Type', 'text/plain')],
                status=404,
            )
        with open(path, 'r', encoding='utf-8') as handle:
            html = handle.read()
        return request.make_response(
            html,
            headers=[
                ('Content-Type', 'text/html; charset=utf-8'),
                ('Cache-Control', 'no-store'),
            ],
        )

    @http.route(
        '/shahtaj/activity-logs/meta',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def activity_log_meta(self, **kwargs):
        """Filter dropdown options (users / operations seen in last 2 days)."""
        self._ensure_admin()
        Log = request.env['shahtaj.activity.log'].sudo()
        since = fields.Datetime.now() - timedelta(days=2)
        rows = Log.search_read(
            [('event_at', '>=', since)],
            ['actor_user_id', 'operation'],
            limit=2000,
            order='event_at desc',
        )
        users = {}
        operations = set()
        for row in rows:
            if row.get('actor_user_id'):
                users[row['actor_user_id'][0]] = row['actor_user_id'][1]
            if row.get('operation'):
                operations.add(row['operation'])
        return {
            'users': [
                {'id': uid, 'name': name}
                for uid, name in sorted(users.items(), key=lambda item: item[1].lower())
            ],
            'operations': sorted(operations),
            'sources': [
                {'id': 'order_booker_api', 'name': 'Order Booker API'},
                {'id': 'order_booker_ui', 'name': 'Order Booker UI'},
                {'id': 'distributor_ui', 'name': 'Distributor UI'},
                {'id': 'admin_ui', 'name': 'Admin UI'},
                {'id': 'system', 'name': 'System'},
                {'id': 'cron', 'name': 'Cron'},
            ],
            'roles': [
                {'id': 'admin', 'name': 'Admin'},
                {'id': 'distributor', 'name': 'Distributor'},
                {'id': 'order_booker', 'name': 'Order Booker'},
                {'id': 'system', 'name': 'System'},
                {'id': 'other', 'name': 'Other'},
            ],
            'statuses': [
                {'id': 'success', 'name': 'Success'},
                {'id': 'failed', 'name': 'Failed'},
            ],
            'retention_days': 2,
        }

    def _parse_dt(self, value, end_of_day=False):
        if not value:
            return None
        text = str(value).strip()
        try:
            if len(text) <= 10:
                day = fields.Date.to_date(text)
                if end_of_day:
                    return datetime.combine(day, time.max)
                return datetime.combine(day, time.min)
            return fields.Datetime.to_datetime(text)
        except Exception:
            return None

    @http.route(
        '/shahtaj/activity-logs/data',
        type='json',
        auth='user',
        methods=['POST'],
        csrf=False,
    )
    def activity_log_data(
        self,
        q=None,
        user_id=None,
        role=None,
        source=None,
        status=None,
        operation=None,
        date_from=None,
        date_to=None,
        limit=100,
        offset=0,
        **kwargs,
    ):
        self._ensure_admin()
        domain = []
        if q:
            needle = str(q).strip()
            domain += [
                '|', '|', '|', '|',
                ('name', 'ilike', needle),
                ('operation', 'ilike', needle),
                ('message', 'ilike', needle),
                ('related_name', 'ilike', needle),
                ('error_details', 'ilike', needle),
            ]
        if user_id:
            domain.append(('actor_user_id', '=', int(user_id)))
        if role:
            domain.append(('actor_role', '=', role))
        if source:
            domain.append(('source', '=', source))
        if status:
            domain.append(('status', '=', status))
        if operation:
            domain.append(('operation', '=', operation))
        start = self._parse_dt(date_from)
        end = self._parse_dt(date_to, end_of_day=True)
        if start:
            domain.append(('event_at', '>=', start))
        if end:
            domain.append(('event_at', '<=', end))

        Log = request.env['shahtaj.activity.log']
        total, rows = Log.search_filtered(domain=domain, limit=limit, offset=offset)
        payload = []
        for row in rows:
            payload.append({
                'id': row.id,
                'event_at': fields.Datetime.to_string(row.event_at) if row.event_at else '',
                'status': row.status,
                'source': row.source,
                'operation': row.operation,
                'name': row.name,
                'actor': row.actor_user_id.display_name if row.actor_user_id else '',
                'actor_id': row.actor_user_id.id if row.actor_user_id else False,
                'role': row.actor_role or '',
                'related': row.related_name or '',
                'message': row.message or '',
                'error_details': row.error_details or '',
                'request_path': row.request_path or '',
                'request_ip': row.request_ip or '',
                'timezone': row.event_timezone or 'UTC',
            })
        return {
            'total': total,
            'offset': max(int(offset or 0), 0),
            'limit': min(max(int(limit or 100), 1), 500),
            'rows': payload,
        }
