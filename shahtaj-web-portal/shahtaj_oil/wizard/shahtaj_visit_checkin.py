# -*- coding: utf-8 -*-
"""Popup: booker GPS check-in, or first-visit verify (photo + CNIC + GPS)."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_is_zero


class ShahtajVisitCheckinWizard(models.TransientModel):
    _name = 'shahtaj.visit.checkin.wizard'
    _description = 'GPS Check-in at Shop'

    visit_task_id = fields.Many2one(
        'shahtaj.visit.task',
        string='Visit Task',
        required=True,
        readonly=True,
    )
    shop_id = fields.Many2one(
        related='visit_task_id.shop_id',
        readonly=True,
    )
    shop_latitude = fields.Float(
        related='visit_task_id.shop_id.partner_latitude',
        readonly=True,
    )
    shop_longitude = fields.Float(
        related='visit_task_id.shop_id.partner_longitude',
        readonly=True,
    )
    needs_shop_setup = fields.Boolean(
        string='Needs First-Visit Setup',
        compute='_compute_needs_shop_setup',
    )
    show_legacy_balance = fields.Boolean(
        string='Show Legacy Balance',
        compute='_compute_show_legacy_balance',
    )
    visit_tag = fields.Selection(
        related='visit_task_id.shop_id.shahtaj_visit_tag',
        readonly=True,
    )
    currency_id = fields.Many2one(
        related='visit_task_id.shop_id.currency_id',
        readonly=True,
    )
    booker_latitude = fields.Float(
        string='Your Latitude',
        required=True,
        digits=(10, 7),
    )
    booker_longitude = fields.Float(
        string='Your Longitude',
        required=True,
        digits=(10, 7),
    )
    owner_cnic_number = fields.Char(string='Owner ID Card Number')
    shop_exterior_photo = fields.Image(
        string='Shop Exterior Photo',
        max_width=1920,
        max_height=1920,
    )
    owner_photo = fields.Image(
        string='Owner Photo (optional)',
        max_width=1920,
        max_height=1920,
    )
    owner_cnic_front = fields.Image(
        string='CNIC Front (optional)',
        max_width=1920,
        max_height=1920,
    )
    owner_cnic_back = fields.Image(
        string='CNIC Back (optional)',
        max_width=1920,
        max_height=1920,
    )
    legacy_balance = fields.Monetary(
        string='Legacy / Opening Balance (optional)',
        currency_field='currency_id',
    )

    @api.depends('shop_id', 'shop_id.shahtaj_field_verified')
    def _compute_needs_shop_setup(self):
        for wiz in self:
            shop = wiz.shop_id
            wiz.needs_shop_setup = bool(
                shop and shop.is_shahtaj_shop and not shop.shahtaj_field_verified
            )

    @api.depends(
        'shop_id',
        'shop_id.legacy_balance',
        'shop_id.legacy_balance_move_id',
        'shop_id.currency_id',
        'needs_shop_setup',
    )
    def _compute_show_legacy_balance(self):
        for wiz in self:
            shop = wiz.shop_id
            if not wiz.needs_shop_setup or not shop:
                wiz.show_legacy_balance = False
                continue
            currency = shop.currency_id or wiz.env.company.currency_id
            wiz.show_legacy_balance = (
                not shop.legacy_balance_move_id
                and float_is_zero(
                    shop.legacy_balance or 0.0,
                    precision_rounding=currency.rounding,
                )
            )

    @api.model
    def default_get(self, fields_list):
        # Pre-fill coords from shop when testing; browser GPS fills them in production.
        res = super().default_get(fields_list)
        task_id = self.env.context.get('default_visit_task_id')
        if task_id:
            task = self.env['shahtaj.visit.task'].browse(task_id)
            shop = task.shop_id
            if shop.partner_latitude and shop.partner_longitude:
                res.setdefault('booker_latitude', shop.partner_latitude)
                res.setdefault('booker_longitude', shop.partner_longitude)
            if shop.owner_cnic_number:
                res.setdefault('owner_cnic_number', shop.owner_cnic_number)
        return res

    def action_check_in(self):
        self.ensure_one()
        if not self.visit_task_id:
            raise UserError(_('No visit task selected.'))
        shop = self.shop_id
        if shop and not shop.shahtaj_field_verified:
            if not self.shop_exterior_photo:
                raise UserError(_(
                    'Shop exterior photo is required for first-visit verification.'
                ))
            cnic = (self.owner_cnic_number or '').strip()
            if not cnic:
                raise UserError(_(
                    'Owner ID card number is required for first-visit verification.'
                ))
            verify_vals = {
                'latitude': self.booker_latitude,
                'longitude': self.booker_longitude,
                'shop_exterior_photo': self.shop_exterior_photo,
                'owner_cnic_number': cnic,
            }
            if self.owner_photo:
                verify_vals['owner_photo'] = self.owner_photo
            if self.owner_cnic_front:
                verify_vals['owner_cnic_front'] = self.owner_cnic_front
            if self.owner_cnic_back:
                verify_vals['owner_cnic_back'] = self.owner_cnic_back
            currency = shop.currency_id or self.env.company.currency_id
            if (
                self.show_legacy_balance
                and not float_is_zero(
                    self.legacy_balance or 0.0,
                    precision_rounding=currency.rounding,
                )
            ):
                verify_vals['legacy_balance'] = self.legacy_balance
            shop.action_shahtaj_apply_field_verification(
                verify_vals, verified_by=self.env.user,
            )
        result = self.env['shahtaj.visit'].create_from_task_checkin(
            self.visit_task_id,
            self.booker_latitude,
            self.booker_longitude,
        )
        if isinstance(result, dict):
            return result
        visit = result
        return visit.action_open_booker_form()
