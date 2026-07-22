# -*- coding: utf-8 -*-
"""Admin-only support log for key Shahtaj operations and failures."""
from odoo import api, fields, models


class ShahtajActivityLog(models.Model):
    _name = 'shahtaj.activity.log'
    _description = 'Shahtaj Activity Log'
    _order = 'event_at desc, id desc'

    name = fields.Char(required=True, index=True)
    operation = fields.Char(required=True, index=True)
    source = fields.Selection(
        [
            ('order_booker_api', 'Order Booker API'),
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
            record.event_date = fields.Datetime.to_date(record.event_at)

    @api.model
    def _get_actor_role(self, user):
        if not user:
            return 'system'
        if user.has_group('base.group_system'):
            return 'admin'
        if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
            return 'distributor'
        if user.has_group('shahtaj_oil.group_shahtaj_order_booker'):
            return 'order_booker'
        return 'other'

    @api.model
    def _get_request_meta(self):
        try:
            from odoo.http import request
            httprequest = getattr(request, 'httprequest', None)
            if not httprequest:
                return {}
            return {
                'request_path': httprequest.path,
                'request_method': httprequest.method,
                'request_ip': httprequest.remote_addr,
            }
        except Exception:
            return {}

    @api.model
    def log_event(
        self,
        name,
        operation,
        source='system',
        status='success',
        user=None,
        related_record=None,
        message=None,
        error_details=None,
        event_timezone=None,
    ):
        user = user or self.env.user
        vals = {
            'name': name,
            'operation': operation,
            'source': source,
            'status': status,
            'actor_user_id': user.id if user and user.exists() else False,
            'actor_role': self._get_actor_role(user),
            'company_id': (
                user.company_id.id
                if user and user.exists() and user.company_id
                else self.env.company.id
            ),
            'event_timezone': (
                event_timezone
                or (user.tz if user and user.exists() and user.tz else None)
                or self.env.context.get('tz')
                or 'UTC'
            ),
            'message': message,
            'error_details': error_details,
        }
        if related_record and related_record.exists():
            vals.update({
                'related_model': related_record._name,
                'related_res_id': related_record.id,
                'related_name': related_record.display_name,
            })
        vals.update(self._get_request_meta())
        return self.sudo().create(vals)

    @api.model
    def log_exception(
        self,
        operation,
        name,
        exc,
        source='system',
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
