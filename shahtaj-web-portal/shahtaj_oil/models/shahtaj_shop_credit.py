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
        currency = self.currency_id or self.env.company.currency_id
        posted = self.sudo().credit or 0.0
        pending = 0.0
        uninvoiced = 0.0
        if self.is_shahtaj_shop:
            pending = self._shahtaj_sum_order_amounts(
                self._shahtaj_pending_order_domain([self.id], exclude_order_ids),
            )
            uninvoiced = self._shahtaj_sum_order_amounts(
                self._shahtaj_uninvoiced_order_domain([self.id], exclude_order_ids),
            )
        effective = posted + pending + uninvoiced + (extra_order_amount or 0.0)
        limit = self.credit_limit or 0.0
        applies = self._shahtaj_credit_enforcement_applies()
        remaining = max(limit - effective, 0.0) if applies else 0.0
        would_exceed = bool(
            applies
            and float_compare(effective, limit, precision_rounding=currency.rounding) > 0
        )
        shortfall = max(effective - limit, 0.0) if would_exceed else 0.0
        return {
            'enforcement_applies': applies,
            'posted_outstanding': posted,
            'pending_order_exposure': pending,
            'confirmed_uninvoiced_exposure': uninvoiced,
            'extra_order_amount': extra_order_amount or 0.0,
            'effective_outstanding': effective,
            'credit_limit': limit,
            'credit_remaining': remaining,
            'would_exceed': would_exceed,
            'shortfall': shortfall,
            'currency': currency,
        }

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

    def _shahtaj_credit_snapshot_for_api(self):
        """Lightweight dict for mobile shop payloads."""
        self.ensure_one()
        snap = self._shahtaj_get_credit_snapshot()
        category = self.shahtaj_shop_category or 'credit'
        if category == 'cash' or not snap['enforcement_applies']:
            credit_remaining = False
        else:
            credit_remaining = snap['credit_remaining']
        return {
            'credit_limit': float(self.credit_limit or 0.0),
            'outstanding_balance': snap['posted_outstanding'],
            'pending_order_exposure': snap['pending_order_exposure'],
            'confirmed_uninvoiced_exposure': snap['confirmed_uninvoiced_exposure'],
            'effective_outstanding': snap['effective_outstanding'],
            'credit_remaining': credit_remaining,
            'credit_would_exceed': snap['would_exceed'],
        }
