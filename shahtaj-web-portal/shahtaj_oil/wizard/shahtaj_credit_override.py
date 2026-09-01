# -*- coding: utf-8 -*-
"""Distributor wizard to approve/confirm orders that exceed shop credit limit."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError


class ShahtajCreditOverrideWizard(models.TransientModel):
    _name = 'shahtaj.credit.override.wizard'
    _description = 'Credit Limit Override Wizard'

    sale_order_id = fields.Many2one(
        'sale.order',
        string='Sales Order',
        required=True,
        readonly=True,
    )
    partner_id = fields.Many2one(
        'res.partner',
        related='sale_order_id.partner_id',
        readonly=True,
    )
    action_type = fields.Selection(
        [
            ('approve', 'Approve Discounted Order'),
            ('confirm', 'Confirm Sales Order'),
        ],
        required=True,
        readonly=True,
    )
    currency_id = fields.Many2one(
        related='sale_order_id.currency_id',
    )
    order_amount = fields.Monetary(
        related='sale_order_id.amount_total',
        readonly=True,
    )
    posted_outstanding = fields.Monetary(
        string='Posted Outstanding',
        readonly=True,
    )
    pending_order_exposure = fields.Monetary(
        string='Pending Orders',
        readonly=True,
    )
    confirmed_uninvoiced_exposure = fields.Monetary(
        string='Confirmed (Not Invoiced)',
        readonly=True,
    )
    effective_outstanding = fields.Monetary(
        string='Effective Outstanding',
        readonly=True,
    )
    credit_limit = fields.Float(
        string='Credit Limit',
        readonly=True,
    )
    shortfall = fields.Monetary(
        string='Over Limit By',
        readonly=True,
    )
    new_credit_limit = fields.Float(
        string='New Credit Limit (optional)',
        help='Increase the shop credit limit before proceeding.',
    )
    override_note = fields.Text(
        string='Override Note',
        help='Optional reason for approving above the credit limit.',
    )

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        order = self.env['sale.order'].browse(
            res.get('sale_order_id') or self.env.context.get('default_sale_order_id')
        )
        if order and order.partner_id:
            snap = order.partner_id._shahtaj_get_credit_snapshot()
            res.update({
                'posted_outstanding': snap['posted_outstanding'],
                'pending_order_exposure': snap['pending_order_exposure'],
                'confirmed_uninvoiced_exposure': snap['confirmed_uninvoiced_exposure'],
                'effective_outstanding': snap['effective_outstanding'],
                'credit_limit': snap['credit_limit'],
                'shortfall': snap['shortfall'],
            })
        return res

    def _apply_credit_limit_increase(self):
        self.ensure_one()
        if not self.new_credit_limit:
            return
        if self.new_credit_limit < self.credit_limit:
            raise UserError(_('New credit limit must be greater than or equal to the current limit.'))
        self.partner_id.sudo().write({
            'credit_limit': self.new_credit_limit,
            'use_partner_credit_limit': True,
            'shahtaj_shop_category': 'credit',
        })

    def _log_override(self):
        self.ensure_one()
        note = (self.override_note or '').strip() or _('No note provided.')
        self.env['shahtaj.activity.log'].log_business(
            operation='credit.override',
            name='Credit limit override',
            related_record=self.sale_order_id,
            message=_(
                'Distributor %(user)s overrode credit limit for %(shop)s on order %(order)s. '
                'Effective outstanding: %(effective).2f / Limit: %(limit).2f. Note: %(note)s',
                user=self.env.user.name,
                shop=self.partner_id.display_name,
                order=self.sale_order_id.name,
                effective=self.effective_outstanding,
                limit=self.new_credit_limit or self.credit_limit,
                note=note,
            ),
        )

    def action_proceed(self):
        self.ensure_one()
        if not self.sale_order_id:
            raise UserError(_('No sales order selected.'))
        self._apply_credit_limit_increase()
        if self.new_credit_limit:
            snap = self.partner_id._shahtaj_get_credit_snapshot()
            if snap['would_exceed']:
                raise UserError(_(
                    'The new credit limit is still not enough for this order. '
                    'Set a higher limit or reduce the order amount.'
                ))
        self._log_override()
        order = self.sale_order_id
        ctx = dict(self.env.context, shahtaj_skip_credit_check=True)
        if self.action_type == 'approve' or order.shahtaj_approval_state == 'to_approve':
            order.with_context(**ctx)._shahtaj_do_approve_order()
        else:
            order.with_context(**ctx).action_confirm()
        return {'type': 'ir.actions.act_window_close'}
