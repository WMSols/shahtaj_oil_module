# -*- coding: utf-8 -*-
"""Shop credit limit: posted AR + pending drafts + confirmed uninvoiced exposure."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare


class ResPartner(models.Model):
    _inherit = 'res.partner'

    shahtaj_pending_order_exposure = fields.Monetary(
        string='Pending Order Exposure',
        compute='_compute_shahtaj_credit_display',
        currency_field='currency_id',
        help='Total of draft/sent sales orders not yet confirmed or cancelled.',
    )
    shahtaj_uninvoiced_order_exposure = fields.Monetary(
        string='Confirmed (Not Invoiced)',
        compute='_compute_shahtaj_credit_display',
        currency_field='currency_id',
        help='Confirmed sales orders not yet invoiced (not in posted receivable).',
    )
    shahtaj_effective_outstanding = fields.Monetary(
        string='Effective Outstanding',
        compute='_compute_shahtaj_credit_display',
        currency_field='currency_id',
        help='Posted receivable + pending orders + confirmed uninvoiced orders.',
    )
    shahtaj_credit_remaining_effective = fields.Monetary(
        string='Effective Credit Remaining',
        compute='_compute_shahtaj_credit_display',
        currency_field='currency_id',
    )

    @api.depends(
        'is_shahtaj_shop',
        'shahtaj_shop_category',
        'credit_limit',
        'use_partner_credit_limit',
        'credit',
    )
    def _compute_shahtaj_credit_display(self):
        for partner in self:
            if not partner.is_shahtaj_shop:
                partner.shahtaj_pending_order_exposure = 0.0
                partner.shahtaj_uninvoiced_order_exposure = 0.0
                partner.shahtaj_effective_outstanding = 0.0
                partner.shahtaj_credit_remaining_effective = 0.0
                continue
            snap = partner._shahtaj_get_credit_snapshot()
            partner.shahtaj_pending_order_exposure = snap['pending_order_exposure']
            partner.shahtaj_uninvoiced_order_exposure = snap['confirmed_uninvoiced_exposure']
            partner.shahtaj_effective_outstanding = snap['effective_outstanding']
            partner.shahtaj_credit_remaining_effective = snap['credit_remaining']

    def _shahtaj_credit_enforcement_applies(self):
        self.ensure_one()
        return bool(
            self.is_shahtaj_shop
            and self.shahtaj_shop_category == 'credit'
            and self.use_partner_credit_limit
            and self.credit_limit
        )

    @api.model
    def _shahtaj_pending_order_domain(self, partner_ids, exclude_order_ids=None):
        domain = [
            ('partner_id', 'in', partner_ids),
            ('state', 'in', ('draft', 'sent')),
        ]
        if exclude_order_ids:
            domain.append(('id', 'not in', list(exclude_order_ids)))
        return domain

    @api.model
    def _shahtaj_uninvoiced_order_domain(self, partner_ids, exclude_order_ids=None):
        domain = [
            ('partner_id', 'in', partner_ids),
            ('state', '=', 'sale'),
            ('invoice_status', 'in', ('to invoice', 'upselling')),
        ]
        if exclude_order_ids:
            domain.append(('id', 'not in', list(exclude_order_ids)))
        return domain

    @api.model
    def _shahtaj_sum_order_amounts_by_partner(self, domain):
        """Sum sale.order amount_total grouped by partner_id."""
        rows = self.env['sale.order'].sudo().read_group(
            domain,
            ['amount_total:sum'],
            ['partner_id'],
        )
        result = {}
        for row in rows:
            partner = row.get('partner_id')
            if not partner:
                continue
            result[partner[0]] = float(row.get('amount_total') or 0.0)
        return result

    @api.model
    def _shahtaj_sum_order_amounts(self, domain):
        rows = self.env['sale.order'].sudo().read_group(
            domain,
            ['amount_total:sum'],
            [],
        )
        if not rows:
            return 0.0
        return rows[0].get('amount_total') or 0.0

    def _shahtaj_get_credit_snapshot(self, exclude_order_ids=None, extra_order_amount=0.0):
        """Return credit exposure breakdown for distributor / field order decisions."""
        self.ensure_one()
        snaps = self._shahtaj_get_credit_snapshots(
            self,
            exclude_order_ids=exclude_order_ids,
            extra_order_amount_by_id={
                self.id: extra_order_amount or 0.0,
            } if extra_order_amount else None,
        )
        return snaps[self.id]

    @api.model
    def _shahtaj_get_credit_snapshots(
        self,
        partners,
        exclude_order_ids=None,
        extra_order_amount_by_id=None,
    ):
        """Batch credit snapshots keyed by partner id (same math as single)."""
        partners = partners.exists()
        empty = {
            'enforcement_applies': False,
            'posted_outstanding': 0.0,
            'pending_order_exposure': 0.0,
            'confirmed_uninvoiced_exposure': 0.0,
            'extra_order_amount': 0.0,
            'effective_outstanding': 0.0,
            'credit_limit': 0.0,
            'credit_remaining': 0.0,
            'would_exceed': False,
            'shortfall': 0.0,
            'currency': self.env.company.currency_id,
        }
        if not partners:
            return {}

        shop_partners = partners.filtered('is_shahtaj_shop')
        shop_ids = shop_partners.ids
        pending_map = {}
        uninvoiced_map = {}
        if shop_ids:
            pending_map = self._shahtaj_sum_order_amounts_by_partner(
                self._shahtaj_pending_order_domain(shop_ids, exclude_order_ids),
            )
            uninvoiced_map = self._shahtaj_sum_order_amounts_by_partner(
                self._shahtaj_uninvoiced_order_domain(shop_ids, exclude_order_ids),
            )

        # Warm credit field in one pass.
        partners.sudo().mapped('credit')
        extra_by_id = extra_order_amount_by_id or {}
        result = {}
        for partner in partners:
            currency = partner.currency_id or self.env.company.currency_id
            if not partner.is_shahtaj_shop:
                snap = dict(empty)
                snap['currency'] = currency
                result[partner.id] = snap
                continue
            posted = partner.sudo().credit or 0.0
            pending = pending_map.get(partner.id, 0.0)
            uninvoiced = uninvoiced_map.get(partner.id, 0.0)
            extra = float(extra_by_id.get(partner.id) or 0.0)
            effective = posted + pending + uninvoiced + extra
            limit = partner.credit_limit or 0.0
            applies = partner._shahtaj_credit_enforcement_applies()
            remaining = max(limit - effective, 0.0) if applies else 0.0
            would_exceed = bool(
                applies
                and float_compare(effective, limit, precision_rounding=currency.rounding) > 0
            )
            result[partner.id] = {
                'enforcement_applies': applies,
                'posted_outstanding': posted,
                'pending_order_exposure': pending,
                'confirmed_uninvoiced_exposure': uninvoiced,
                'extra_order_amount': extra,
                'effective_outstanding': effective,
                'credit_limit': limit,
                'credit_remaining': remaining,
                'would_exceed': would_exceed,
                'shortfall': max(effective - limit, 0.0) if would_exceed else 0.0,
                'currency': currency,
            }
        return result

    def _shahtaj_assert_credit_limit(self, order_amount, exclude_order_ids=None, hard_block=True):
        """Hard block for bookers; returns snapshot (raises if over limit and hard_block)."""
        self.ensure_one()
        snapshot = self._shahtaj_get_credit_snapshot(
            exclude_order_ids=exclude_order_ids,
            extra_order_amount=order_amount,
        )
        if snapshot['would_exceed'] and hard_block:
            raise UserError(_(
                'Credit limit exceeded for shop "%(shop)s".\n'
                'Posted outstanding: %(posted).2f\n'
                'Pending orders: %(pending).2f\n'
                'Confirmed (not invoiced): %(uninv).2f\n'
                'This order: %(order).2f\n'
                'Effective total: %(effective).2f / Limit: %(limit).2f',
                shop=self.display_name,
                posted=snapshot['posted_outstanding'],
                pending=snapshot['pending_order_exposure'],
                uninv=snapshot['confirmed_uninvoiced_exposure'],
                order=snapshot['extra_order_amount'],
                effective=snapshot['effective_outstanding'],
                limit=snapshot['credit_limit'],
            ))
        return snapshot

    @api.model
    def _shahtaj_credit_snapshots_for_api(self, partners):
        """Batch API credit dicts keyed by partner id."""
        partners = partners.sudo().exists()
        snaps = self._shahtaj_get_credit_snapshots(partners)
        result = {}
        for partner in partners:
            snap = snaps.get(partner.id) or {}
            category = partner.shahtaj_shop_category or 'credit'
            if category == 'cash' or not snap.get('enforcement_applies'):
                credit_remaining = False
            else:
                credit_remaining = snap.get('credit_remaining', 0.0)
            result[partner.id] = {
                'credit_limit': float(partner.credit_limit or 0.0),
                'outstanding_balance': snap.get('posted_outstanding', 0.0),
                'pending_order_exposure': snap.get('pending_order_exposure', 0.0),
                'confirmed_uninvoiced_exposure': snap.get('confirmed_uninvoiced_exposure', 0.0),
                'effective_outstanding': snap.get('effective_outstanding', 0.0),
                'credit_remaining': credit_remaining,
                'credit_would_exceed': snap.get('would_exceed', False),
            }
        return result

    def _shahtaj_credit_snapshot_for_api(self):
        """Lightweight dict for mobile shop payloads."""
        self.ensure_one()
        return self._shahtaj_credit_snapshots_for_api(self)[self.id]
