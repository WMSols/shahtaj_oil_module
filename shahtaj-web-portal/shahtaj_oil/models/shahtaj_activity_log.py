# -*- coding: utf-8 -*-
"""Admin-only support log for key Shahtaj operations and failures."""
import logging
from datetime import date, datetime, timedelta

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

RETENTION_DAYS = 2


def _as_date(value):
    """Convert datetime/date/string to date without relying on Datetime.to_date."""
    if not value:
        return False
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return fields.Date.to_date(value)
    except Exception:
        try:
            return fields.Datetime.to_datetime(value).date()
        except Exception:
            return False


class ShahtajActivityLog(models.Model):
    _name = 'shahtaj.activity.log'
    _description = 'Shahtaj Activity Log'
    _order = 'event_at desc, id desc'
    _rec_name = 'name'

    name = fields.Char(required=True, index=True)
    operation = fields.Char(required=True, index=True)
    source = fields.Selection(
        [
            ('order_booker_api', 'Order Booker API'),
            ('order_booker_ui', 'Order Booker UI'),
            ('distributor_ui', 'Distributor UI'),
            ('admin_ui', 'Admin UI'),
            ('system', 'System'),
            ('cron', 'Cron'),
        ],
        required=True,
        default='system',
        index=True,
    )
    status = fields.Selection(
        [('success', 'Success'), ('failed', 'Failed')],
        required=True,
        default='success',
        index=True,
    )
    event_at = fields.Datetime(
        string='Event Time',
        required=True,
        default=fields.Datetime.now,
        index=True,
    )
    event_date = fields.Date(
        string='Event Date',
        compute='_compute_event_date',
        store=True,
        index=True,
    )
    event_timezone = fields.Char(
        string='Timezone',
        default='UTC',
        index=True,
    )
    actor_user_id = fields.Many2one(
        'res.users',
        string='User',
        index=True,
        ondelete='set null',
    )
    actor_role = fields.Selection(
        [
            ('admin', 'Admin'),
            ('distributor', 'Distributor'),
            ('order_booker', 'Order Booker'),
            ('system', 'System'),
            ('other', 'Other User'),
        ],
        string='Role',
        index=True,
    )
    company_id = fields.Many2one(
        'res.company',
        string='Company',
        index=True,
        ondelete='set null',
    )
    related_model = fields.Char(string='Related Model', index=True)
    related_res_id = fields.Integer(string='Related ID', index=True)
    related_name = fields.Char(string='Related Record')
    request_path = fields.Char(string='Request Path')
    request_method = fields.Char(string='Request Method')
    request_ip = fields.Char(string='Client IP')
    message = fields.Text()
    error_details = fields.Text()

    @api.depends('event_at')
    def _compute_event_date(self):
        for record in self:
            try:
                record.event_date = _as_date(record.event_at)
            except Exception:
                record.event_date = False

    @api.model
    def _get_actor_role(self, user):
        try:
            if not user or not user.exists() or user._is_public():
                return 'system'
            if user.has_group('base.group_system'):
                return 'admin'
            if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
                return 'distributor'
            if user.has_group('shahtaj_oil.group_shahtaj_order_booker'):
                return 'order_booker'
        except Exception:
            return 'other'
        return 'other'

    @api.model
    def _get_request_meta(self):
        try:
            from odoo.http import request
            httprequest = getattr(request, 'httprequest', None)
            if not httprequest:
                return {}
            path = httprequest.path or ''
            method = httprequest.method or ''
            ip = httprequest.remote_addr or ''
            return {
                'request_path': path[:512],
                'request_method': method[:16],
                'request_ip': ip[:64],
            }
        except Exception:
            return {}

    @api.model
    def _detect_source(self):
        try:
            meta = self._get_request_meta()
            path = meta.get('request_path') or ''
            if '/api/shahtaj/' in path:
                return 'order_booker_api'
            user = self.env.user
            if not user or user._is_public():
                return 'system'
            if user.has_group('base.group_system'):
                return 'admin_ui'
            if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
                return 'distributor_ui'
            if user.has_group('shahtaj_oil.group_shahtaj_order_booker'):
                return 'order_booker_ui'
        except Exception:
            return 'system'
        return 'system'

    @api.model
    def _safe_text(self, value, limit=None):
        if value is None or value is False:
            return False
        text = str(value)
        if limit:
            return text[:limit]
        return text

    @api.model
    def log_event(
        self,
        name,
        operation,
        source=None,
        status='success',
        user=None,
        related_record=None,
        message=None,
        error_details=None,
        event_timezone=None,
    ):
        """Write one activity row.

        Isolated with a savepoint so a logging failure can never roll back
        the business transaction (zone create, visit, stock, etc.).
        """
        try:
            user = user if user is not None else self.env.user
            if user and (not getattr(user, 'id', None) or not user.exists() or user._is_public()):
                user = False

            event_at = fields.Datetime.now()
            source_value = source or self._detect_source()
            if source_value not in dict(self._fields['source'].selection):
                source_value = 'system'
            status_value = status if status in ('success', 'failed') else 'success'
            role = self._get_actor_role(user)
            if role not in dict(self._fields['actor_role'].selection):
                role = 'other'

            company_id = False
            try:
                if user and user.company_id:
                    company_id = user.company_id.id
                else:
                    company_id = self.env.company.id
            except Exception:
                company_id = False

            tz = 'UTC'
            try:
                tz = (
                    event_timezone
                    or (user.tz if user and user.tz else None)
                    or self.env.context.get('tz')
                    or 'UTC'
                )
            except Exception:
                tz = 'UTC'

            vals = {
                'name': self._safe_text(name or operation or 'Activity', 256),
                'operation': self._safe_text(operation or 'unknown', 128),
                'source': source_value,
                'status': status_value,
                'event_at': event_at,
                'actor_user_id': user.id if user else False,
                'actor_role': role,
                'company_id': company_id or False,
                'event_timezone': self._safe_text(tz, 64) or 'UTC',
                'message': self._safe_text(message),
                'error_details': self._safe_text(error_details),
            }
            if related_record is not None:
                try:
                    if related_record and related_record.exists():
                        vals.update({
                            'related_model': self._safe_text(related_record._name, 128),
                            'related_res_id': int(related_record.id),
                            'related_name': self._safe_text(
                                related_record.display_name, 256
                            ),
                        })
                except Exception:
                    pass
            vals.update(self._get_request_meta())

            # Savepoint: if create/compute/flush fails, only the log is undone.
            with self.env.cr.savepoint():
                record = self.sudo().create(vals)
                record.flush_recordset()
                return record
        except Exception:
            _logger.exception('shahtaj.activity.log write failed')
            return self.browse()

    @api.model
    def log_exception(
        self,
        operation,
        name,
        exc,
        source=None,
        user=None,
        related_record=None,
        message=None,
    ):
        return self.log_event(
            name=name,
            operation=operation,
            source=source,
            status='failed',
            user=user,
            related_record=related_record,
            message=message,
            error_details=str(exc),
        )

    @api.model
    def log_business(
        self,
        operation,
        name,
        related_record=None,
        message=None,
        status='success',
        error_details=None,
        skip_api=True,
    ):
        """Log distributor/native UI actions; skip when order-booker API logs separately."""
        try:
            source = self._detect_source()
            if skip_api and source == 'order_booker_api':
                return self.browse()
            return self.log_event(
                name=name,
                operation=operation,
                source=source,
                status=status,
                related_record=related_record,
                message=message,
                error_details=error_details,
            )
        except Exception:
            _logger.exception('shahtaj.activity.log log_business failed')
            return self.browse()

    @api.model
    def _cron_purge_old_logs(self):
        """Delete activity rows older than RETENTION_DAYS (cron; catches up in batches)."""
        cutoff = fields.Datetime.now() - timedelta(days=RETENTION_DAYS)
        Log = self.sudo()
        batch = Log.search(
            [('event_at', '<', cutoff)],
            limit=2000,
            order='event_at asc, id asc',
        )
        total = len(batch)
        if batch:
            batch.unlink()
            _logger.info(
                'Shahtaj activity log purged %s rows older than %s',
                total,
                cutoff,
            )
        return True

    @api.model
    def search_filtered(
        self,
        domain=None,
        limit=100,
        offset=0,
        order='event_at desc, id desc',
    ):
        """Admin HTML/JSON helper — capped, indexed-field friendly."""
        limit = min(max(int(limit or 100), 1), 500)
        offset = max(int(offset or 0), 0)
        domain = list(domain or [])
        Log = self.sudo()
        total = Log.search_count(domain)
        rows = Log.search(domain, limit=limit, offset=offset, order=order)
        return total, rows
