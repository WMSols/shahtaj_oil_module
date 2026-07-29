# -*- coding: utf-8 -*-
"""Company-level Shahtaj GPS / field-ops settings."""
from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from .shahtaj_gps import DEFAULT_MAX_SHOP_DISTANCE_M, DEFAULT_MIN_SHOP_DISTANCE_M


class ResCompany(models.Model):
    _inherit = 'res.company'

    shahtaj_min_shop_distance_m = fields.Float(
        string='Min Shop GPS Distance (m)',
        default=DEFAULT_MIN_SHOP_DISTANCE_M,
        help='Booker must be at least this many metres from the shop GPS. '
             'Use 0 to disable the minimum (recommended).',
    )
    shahtaj_max_shop_distance_m = fields.Float(
        string='Max Shop GPS Distance (m)',
        default=DEFAULT_MAX_SHOP_DISTANCE_M,
        help='Booker must be within this many metres of the shop GPS for '
             'check-in and place-order. Takes effect immediately on save.',
    )

    @api.constrains('shahtaj_min_shop_distance_m', 'shahtaj_max_shop_distance_m')
    def _check_shahtaj_shop_distance_limits(self):
        for company in self:
            min_m = company.shahtaj_min_shop_distance_m or 0.0
            max_m = company.shahtaj_max_shop_distance_m or 0.0
            if min_m < 0:
                raise ValidationError(_('Minimum shop GPS distance cannot be negative.'))
            if max_m < 10:
                raise ValidationError(_(
                    'Maximum shop GPS distance must be at least 10 metres.'
                ))
            if min_m > max_m:
                raise ValidationError(_(
                    'Minimum shop GPS distance cannot be greater than the maximum.'
                ))

    @api.model
    def _shahtaj_can_edit_company_settings(self):
        user = self.env.user
        return (
            user.has_group('base.group_system')
            or user.has_group('shahtaj_oil.group_shahtaj_distributor')
        )

    @api.model
    def shahtaj_get_shop_distance_limits(self):
        """Return current company min/max metres (read live — no cache)."""
        company = self.env.company
        return {
            'min_m': company.shahtaj_min_shop_distance_m or 0.0,
            'max_m': (
                company.shahtaj_max_shop_distance_m
                or DEFAULT_MAX_SHOP_DISTANCE_M
            ),
        }

    @api.model
    def shahtaj_set_shop_distance_limits(self, min_m=None, max_m=None):
        """Portal/admin save — distributors and settings admins only."""
        if not self._shahtaj_can_edit_company_settings():
            raise AccessError(_(
                'Only distributors or administrators can change GPS distance settings.'
            ))
        company = self.env.company.sudo()
        vals = {}
        if min_m is not None:
            vals['shahtaj_min_shop_distance_m'] = float(min_m)
        if max_m is not None:
            vals['shahtaj_max_shop_distance_m'] = float(max_m)
        if vals:
            company.write(vals)
            self.env['shahtaj.activity.log'].log_business(
                operation='settings.gps_distance',
                name='GPS distance settings updated',
                related_record=company,
                message=_('min=%(min)s m, max=%(max)s m',
                          min=company.shahtaj_min_shop_distance_m,
                          max=company.shahtaj_max_shop_distance_m),
            )
        return self.shahtaj_get_shop_distance_limits()

    def _shahtaj_get_default_expense_account(self):
        """Pick any active Expense account for operating expense posts."""
        self.ensure_one()
        Account = self.env['account.account'].with_company(self).sudo()
        account = Account.search([
            ('account_type', '=', 'expense'),
            ('company_ids', 'in', [self.id]),
        ], limit=1)
        if not account:
            account = Account.search([
                ('account_type', '=', 'expense'),
            ], limit=1)
        if not account:
            raise UserError(_(
                'No expense account found for %(company)s. '
                'Create an account with type Expense, or set an expense account '
                'on the expense category.',
                company=self.display_name,
            ))
        return account

    @api.model
    def shahtaj_get_company_profile(self):
        """Portal: company name, phone, and logo preview."""
        company = self.env.company
        logo = company.logo or False
        if logo and isinstance(logo, bytes):
            logo = logo.decode()
        return {
            'id': company.id,
            'name': company.name or '',
            'phone': company.phone or '',
            'logo': logo,
        }

    @api.model
    def shahtaj_set_company_profile(self, name=None, phone=None, logo=None):
        """Portal save for company profile / logo (distributors + admins)."""
        if not self._shahtaj_can_edit_company_settings():
            raise AccessError(_(
                'Only distributors or administrators can change company settings.'
            ))
        company = self.env.company.sudo()
        vals = {}
        if name is not None:
            clean_name = (name or '').strip()
            if not clean_name:
                raise ValidationError(_('Company name is required.'))
            vals['name'] = clean_name
        if phone is not None:
            vals['phone'] = (phone or '').strip() or False
        if logo is not None:
            vals['logo'] = logo or False
        if vals:
            company.write(vals)
        return self.shahtaj_get_company_profile()
