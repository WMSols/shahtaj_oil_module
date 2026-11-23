# -*- coding: utf-8 -*-
"""Native Settings: Shahtaj field GPS distance limits + legacy invoices."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    shahtaj_min_shop_distance_m = fields.Float(
        related='company_id.shahtaj_min_shop_distance_m',
        readonly=False,
    )
    shahtaj_max_shop_distance_m = fields.Float(
        related='company_id.shahtaj_max_shop_distance_m',
        readonly=False,
    )
    shahtaj_legacy_invoice_auto = fields.Boolean(
        related='company_id.shahtaj_legacy_invoice_auto',
        readonly=False,
    )
    shahtaj_legacy_invoice_batch_size = fields.Integer(
        related='company_id.shahtaj_legacy_invoice_batch_size',
        readonly=False,
    )
    shahtaj_legacy_invoice_pending_count = fields.Integer(
        string='Legacy Invoices Pending',
        compute='_compute_shahtaj_legacy_invoice_stats',
    )
    shahtaj_legacy_invoice_created_count = fields.Integer(
        string='Legacy Invoices Created',
        compute='_compute_shahtaj_legacy_invoice_stats',
    )

    @api.depends('company_id', 'shahtaj_legacy_invoice_auto')
    def _compute_shahtaj_legacy_invoice_stats(self):
        Company = self.env['res.company']
        for wizard in self:
            stats = Company.shahtaj_get_legacy_invoice_settings()
            wizard.shahtaj_legacy_invoice_pending_count = stats['pending_count']
            wizard.shahtaj_legacy_invoice_created_count = stats['created_count']

    def action_shahtaj_run_legacy_invoice_batch(self):
        """Settings form Start button — process one batch then reload stats."""
        self.ensure_one()
        if not self.shahtaj_legacy_invoice_auto:
            raise UserError(_(
                'Turn on Auto Legacy Balance Invoices before generating invoices.'
            ))
        if not self.shahtaj_legacy_invoice_pending_count:
            raise UserError(_('No pending legacy balance invoices to create.'))
        stats = self.env['res.company'].shahtaj_run_legacy_invoice_batch(
            limit=self.shahtaj_legacy_invoice_batch_size or 100,
        )
        # Refresh computed counters on this transient record.
        self._compute_shahtaj_legacy_invoice_stats()
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Legacy Invoices'),
                'message': _(
                    'Created %(posted)s invoice(s) this batch. '
                    '%(pending)s still pending.',
                    posted=stats.get('batch_posted', 0),
                    pending=stats.get('pending_count', 0),
                ),
                'type': 'success',
                'sticky': False,
            },
        }
