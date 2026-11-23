# -*- coding: utf-8 -*-
"""Ask whether to create legacy balance invoice(s) when approving shop(s)."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError


class ShahtajLegacyInvoiceApproveWizard(models.TransientModel):
    _name = 'shahtaj.legacy.invoice.approve.wizard'
    _description = 'Approve Shop — Legacy Invoice Decision'

    partner_ids = fields.Many2many(
        'res.partner',
        string='Shops',
        required=True,
        readonly=True,
    )
    shop_count = fields.Integer(
        string='Shops',
        compute='_compute_summary',
    )
    legacy_total = fields.Monetary(
        string='Legacy Balance Total',
        compute='_compute_summary',
        currency_field='currency_id',
    )
    currency_id = fields.Many2one(
        'res.currency',
        compute='_compute_summary',
    )
    note = fields.Text(
        string='Note',
        compute='_compute_summary',
    )

    @api.depends('partner_ids', 'partner_ids.legacy_balance')
    def _compute_summary(self):
        for wizard in self:
            partners = wizard.partner_ids
            wizard.shop_count = len(partners)
            company = self.env.company
            wizard.currency_id = company.currency_id
            candidates = partners._shahtaj_filter_legacy_invoice_candidates()
            wizard.legacy_total = sum(candidates.mapped('legacy_balance'))
            wizard.note = _(
                'These shop(s) have a non-zero legacy balance. '
                'Create the opening invoice now, or approve without invoicing '
                '(you can generate invoices later from Settings in batches).'
            )

    def action_approve_with_invoice(self):
        self.ensure_one()
        if not self.partner_ids:
            raise UserError(_('No shops selected.'))
        return self.partner_ids.with_context(
            shahtaj_legacy_invoice_decision='yes',
            shahtaj_legacy_invoice_silent=True,
        ).action_approve_shop()

    def action_approve_without_invoice(self):
        self.ensure_one()
        if not self.partner_ids:
            raise UserError(_('No shops selected.'))
        return self.partner_ids.with_context(
            shahtaj_legacy_invoice_decision='no',
            shahtaj_legacy_invoice_silent=True,
        ).action_approve_shop()
