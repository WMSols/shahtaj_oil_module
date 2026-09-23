# -*- coding: utf-8 -*-
"""Delivery Man day session: Left Office / Out on Route (not a per-shop stop)."""
from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError


class ShahtajDmDaySession(models.Model):
    _name = 'shahtaj.dm.day.session'
    _description = 'Delivery Man Day Session'
    _order = 'session_date desc, id desc'
    _rec_name = 'display_name'

    display_name = fields.Char(compute='_compute_display_name', store=True)
    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        required=True,
        index=True,
        ondelete='cascade',
        domain="[('shahtaj_is_delivery_man', '=', True)]",
    )
    session_date = fields.Date(
        string='Day',
        required=True,
        index=True,
        default=lambda self: fields.Date.context_today(self),
    )
    state = fields.Selection(
        [
            ('office', 'At Office / Loading'),
            ('on_the_way', 'Left Office / Out on Route'),
            ('ended', 'Day Ended'),
        ],
        string='Day Status',
        default='office',
        required=True,
        index=True,
        help=(
            'Whole-day status for this delivery man (not one shop).\n'
            'At Office → load stock → Left Office / Out on Route → deliver stops → Day Ended.\n'
            'Per-shop progress uses the delivery Stop field (Heading to Shop / Closed / Done).'
        ),
    )
    departed_at = fields.Datetime(string='Left Office At', readonly=True)
    ended_at = fields.Datetime(string='Day Ended At', readonly=True)
    company_id = fields.Many2one(
        'res.company',
        string='Company',
        required=True,
        default=lambda self: self.env.company,
        index=True,
    )
    notes = fields.Text(string='Notes')
    gps_min_distance_m = fields.Float(
        string='GPS Min (m)',
        compute='_compute_gps_criteria',
        help='Company minimum shop distance — same as mobile gps_criteria.min_m.',
    )
    gps_max_distance_m = fields.Float(
        string='GPS Max (m)',
        compute='_compute_gps_criteria',
        help='Company maximum shop distance — same as mobile gps_criteria.max_m.',
    )

    _sql_constraints = [
        (
            'shahtaj_dm_day_session_uniq',
            'unique(delivery_man_id, session_date, company_id)',
            'A delivery man can have only one session per day.',
        ),
    ]

    @api.depends('company_id')
    def _compute_gps_criteria(self):
        limits = self.env['res.company'].shahtaj_get_shop_distance_limits()
        for rec in self:
            rec.gps_min_distance_m = float(limits.get('min_m') or 0.0)
            rec.gps_max_distance_m = float(limits.get('max_m') or 0.0)

    @api.depends('delivery_man_id', 'session_date', 'state')
    def _compute_display_name(self):
        labels = dict(self._fields['state'].selection)
        for rec in self:
            dm = rec.delivery_man_id.name if rec.delivery_man_id else '—'
            day = rec.session_date or '—'
            rec.display_name = f'{dm} · {day} · {labels.get(rec.state, rec.state)}'

    @api.model
    def _assert_dm_access(self, dm):
        user = self.env.user
        if user.shahtaj_is_delivery_man and user.id != dm.id:
            if not (
                user.has_group('shahtaj_oil.group_shahtaj_distributor')
                or user.has_group('shahtaj_oil.group_shahtaj_native_distributor_ui')
            ):
                raise AccessError(_('You can only manage your own day session.'))
        if not dm.shahtaj_is_delivery_man:
            raise UserError(_('%(user)s is not a delivery man.', user=dm.display_name))

    @api.model
    def get_or_create_today(self, delivery_man=None, day=None):
        """Return today's session for the DM (create in office if missing)."""
        dm = delivery_man or self.env.user
        self._assert_dm_access(dm)
        day = day or fields.Date.context_today(self)
        session = self.sudo().search([
            ('delivery_man_id', '=', dm.id),
            ('session_date', '=', day),
            ('company_id', '=', self.env.company.id),
        ], limit=1)
        if session:
            return session
        return self.sudo().create({
            'delivery_man_id': dm.id,
            'session_date': day,
            'state': 'office',
            'company_id': self.env.company.id,
        })

    def action_depart(self):
        """Mark day as Left Office / Out on Route after loading.

        Also marks open loaded stops as Heading to Shop so the distributor
        job list reflects that the DM has left the office (same as app).
        """
        self.ensure_one()
        self._assert_dm_access(self.delivery_man_id)
        if self.state == 'ended':
            raise UserError(_('This day session already ended.'))
        if self.state == 'on_the_way':
            return self
        self.write({
            'state': 'on_the_way',
            'departed_at': fields.Datetime.now(),
        })
        # Open loaded stops → Heading to Shop (job-level Stop, not Day Status).
        Delivery = self.env['shahtaj.dm.delivery'].sudo()
        jobs = Delivery.search([
            ('delivery_man_id', '=', self.delivery_man_id.id),
            ('state', 'in', ('picked', 'partial')),
            ('field_state', 'in', ('pending', 'not_attended', 'failed')),
            '|', '|',
            ('scheduled_date', '=', self.session_date),
            ('scheduled_date', '=', False),
            ('scheduled_date', '<', self.session_date),
        ])
        if jobs:
            jobs.write({'field_state': 'in_transit'})
        return self

    def action_end_day(self):
        """Optional: mark day finished (after returns / last stop)."""
        self.ensure_one()
        self._assert_dm_access(self.delivery_man_id)
        if self.state == 'ended':
            return self
        self.write({
            'state': 'ended',
            'ended_at': fields.Datetime.now(),
        })
        return self

    def action_reset_office(self):
        """Back to loading (distributor/testing)."""
        self.ensure_one()
        self._assert_dm_access(self.delivery_man_id)
        self.write({
            'state': 'office',
            'departed_at': False,
            'ended_at': False,
        })
        return self
