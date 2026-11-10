# -*- coding: utf-8 -*-
"""Delivery Man day session: Left Office / Out on Route (not a per-shop stop)."""
import logging
from datetime import datetime, time

from psycopg2 import Error as PsycopgError

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError

_logger = logging.getLogger(__name__)


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
            'Distributor Day Sessions list only shows real journeys (left office / ended).'
        ),
    )
    departed_at = fields.Datetime(string='Left Office At', readonly=True)
    ended_at = fields.Datetime(string='Day Ended At', readonly=True)
    end_source = fields.Selection(
        [
            ('dm', 'Delivery Man'),
            ('distributor', 'Distributor / Office'),
            ('system', 'System (auto)'),
        ],
        string='Ended By',
        readonly=True,
        copy=False,
        help=(
            'Who closed the day. System means the DM did not End Day and the '
            'nightly job closed a past On the way session.'
        ),
    )
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

    @api.depends('delivery_man_id', 'session_date', 'state', 'end_source')
    def _compute_display_name(self):
        labels = dict(self._fields['state'].selection)
        for rec in self:
            dm = rec.delivery_man_id.name if rec.delivery_man_id else '—'
            day = rec.session_date or '—'
            label = labels.get(rec.state, rec.state)
            if rec.state == 'ended' and rec.end_source == 'system':
                label = _('Day Ended (System)')
            rec.display_name = f'{dm} · {day} · {label}'

    @api.model
    def _assert_dm_access(self, dm):
        user = self.env.user
        if user.shahtaj_is_delivery_man and user.id != dm.id:
            if not user._shahtaj_can_manage_dm_ops():
                raise AccessError(_('You can only manage your own day session.'))
        if not dm.shahtaj_is_delivery_man:
            raise UserError(_('%(user)s is not a delivery man.', user=dm.display_name))

    @api.model
    def _shahtaj_session_search(self, dm, day, company=None):
        company = company or self.env.company
        return self.sudo().search([
            ('delivery_man_id', '=', dm.id),
            ('session_date', '=', day),
            ('company_id', '=', company.id),
        ], order='id desc', limit=1)

    @api.model
    def get_or_create_today(self, delivery_man=None, day=None):
        """Return today's session for the DM (create in office if missing).

        Race-safe: concurrent creates fall back to the surviving unique row.
        Dist list still hides Office-only rows until Leave Office.
        """
        dm = delivery_man or self.env.user
        self._assert_dm_access(dm)
        day = day or fields.Date.context_today(self)
        session = self._shahtaj_session_search(dm, day)
        if session:
            return session
        vals = {
            'delivery_man_id': dm.id,
            'session_date': day,
            'state': 'office',
            'company_id': self.env.company.id,
        }
        try:
            with self.env.cr.savepoint():
                return self.sudo().create(vals)
        except PsycopgError:
            session = self._shahtaj_session_search(dm, day)
            if session:
                return session
            raise

    def action_sync_on_route_stops(self, include_retry_stops=False):
        """While Left Office: stamp free van + Heading on today's loaded stops.

        Idempotent. Used after Dist mid-day assign/reschedule and when DM
        refreshes plan/load so existing APIs return live Stock/Stop without
        changing response shape. No-op unless session is on_the_way.

        By default only Stop=Not Started → Heading (safe for mid-day / refresh).
        First Leave Office passes include_retry_stops=True so Shop Closed /
        Could Not Deliver from an earlier attempt can be reopened as Heading
        (same rule as before).
        """
        Delivery = self.env['shahtaj.dm.delivery'].sudo()
        stop_states = (
            ('pending', 'not_attended', 'failed')
            if include_retry_stops else ('pending',)
        )
        for session in self:
            if session.state != 'on_the_way':
                continue
            Delivery._shahtaj_apply_free_van_for_day(
                session.delivery_man_id, session.session_date,
            )
            jobs = Delivery.search([
                ('delivery_man_id', '=', session.delivery_man_id.id),
                ('state', 'in', ('picked', 'partial')),
                ('field_state', 'in', stop_states),
                ('scheduled_date', '=', session.session_date),
            ])
            if jobs:
                jobs.write({'field_state': 'in_transit'})
        return True

    def action_depart(self):
        """Mark day as Left Office / Out on Route after loading.

        Also marks open loaded stops as Heading to Shop so the distributor
        job list reflects that the DM has left the office (same as app).
        If already Left Office, re-sync mid-day Dist assigns (pending only).
        """
        self.ensure_one()
        self._assert_dm_access(self.delivery_man_id)
        if self.state == 'ended':
            raise UserError(_('This day session already ended.'))
        first_depart = self.state != 'on_the_way'
        if first_depart:
            self.write({
                'state': 'on_the_way',
                'departed_at': fields.Datetime.now(),
                'ended_at': False,
                'end_source': False,
            })
        # First leave may reopen closed/failed; later sync only new pending stops.
        self.action_sync_on_route_stops(include_retry_stops=first_depart)
        return self

    def _shahtaj_resolve_end_source(self):
        """dm | distributor | system from context / caller role."""
        forced = self.env.context.get('shahtaj_day_end_source')
        if forced in ('dm', 'distributor', 'system'):
            return forced
        user = self.env.user
        self.ensure_one()
        if user._shahtaj_can_manage_dm_ops() and user.id != self.delivery_man_id.id:
            return 'distributor'
        return 'dm'

    def action_end_day(self):
        """Mark day finished (after returns / last stop). Records who ended it."""
        self.ensure_one()
        self._assert_dm_access(self.delivery_man_id)
        if self.state == 'ended':
            return self
        source = self._shahtaj_resolve_end_source()
        ended_at = self.env.context.get('shahtaj_day_ended_at') or fields.Datetime.now()
        vals = {
            'state': 'ended',
            'ended_at': ended_at,
            'end_source': source,
        }
        if source == 'system':
            stamp = _(
                'System auto-ended: DM did not End Day before the next calendar day.'
            )
            notes = (self.notes or '').strip()
            if stamp not in notes:
                vals['notes'] = f'{notes}\n{stamp}'.strip() if notes else stamp
        self.write(vals)
        return self

    def action_reset_office(self):
        """Back to loading (distributor/testing). Clears journey end metadata."""
        self.ensure_one()
        self._assert_dm_access(self.delivery_man_id)
        self.write({
            'state': 'office',
            'departed_at': False,
            'ended_at': False,
            'end_source': False,
        })
        return self

    @api.model
    def _shahtaj_portal_journey_domain(self):
        """Dist/WHI list: only real journeys (left office or ended)."""
        return [
            '|',
            ('departed_at', '!=', False),
            ('state', '=', 'ended'),
        ]

    @api.model
    def shahtaj_cleanup_duplicate_day_sessions(self):
        """Keep one session per DM/day/company; prefer real journeys."""
        self.env.cr.execute("""
            SELECT delivery_man_id, session_date, company_id
              FROM shahtaj_dm_day_session
             GROUP BY delivery_man_id, session_date, company_id
            HAVING COUNT(*) > 1
        """)
        groups = self.env.cr.fetchall()
        removed = 0
        state_rank = {'ended': 3, 'on_the_way': 2, 'office': 1}

        def _score(rec):
            return (
                state_rank.get(rec.state, 0),
                1 if rec.departed_at else 0,
                1 if rec.ended_at else 0,
                1 if rec.end_source else 0,
                rec.id,
            )

        for dm_id, day, company_id in groups:
            twins = self.sudo().search([
                ('delivery_man_id', '=', dm_id),
                ('session_date', '=', day),
                ('company_id', '=', company_id),
            ], order='id')
            if len(twins) < 2:
                continue
            keeper = max(twins, key=_score)
            victims = twins - keeper
            patch = {}
            if not keeper.end_source:
                donor = victims.filtered('end_source')[:1]
                if donor:
                    patch['end_source'] = donor.end_source
            if not keeper.departed_at:
                donor = victims.filtered('departed_at')[:1]
                if donor:
                    patch['departed_at'] = donor.departed_at
            if keeper.state != 'ended':
                better = victims.filtered(lambda r: r.state == 'ended')[:1]
                if better:
                    patch.update({
                        'state': 'ended',
                        'ended_at': better.ended_at or keeper.ended_at,
                        'end_source': better.end_source or patch.get('end_source') or 'dm',
                        'departed_at': (
                            patch.get('departed_at')
                            or keeper.departed_at
                            or better.departed_at
                        ),
                    })
            if patch:
                keeper.write(patch)
            removed += len(victims)
            victims.unlink()
        _logger.info(
            'Shahtaj day session duplicate cleanup: groups=%s removed=%s',
            len(groups), removed,
        )
        return {'groups': len(groups), 'removed': removed}

    @api.model
    def _cron_auto_end_stale_day_sessions(self):
        """End past On the way sessions so Dist sees System ended."""
        today = fields.Date.context_today(self)
        stale = self.sudo().search([
            ('session_date', '<', today),
            ('state', '=', 'on_the_way'),
        ])
        if not stale:
            return True
        for session in stale:
            ended_at = fields.Datetime.to_datetime(
                datetime.combine(session.session_date, time(23, 59, 59))
            )
            session.sudo().with_context(
                shahtaj_day_end_source='system',
                shahtaj_day_ended_at=ended_at,
            ).action_end_day()
        _logger.info(
            'Shahtaj auto-ended %s stale DM day session(s) before %s',
            len(stale), today,
        )
        return True
