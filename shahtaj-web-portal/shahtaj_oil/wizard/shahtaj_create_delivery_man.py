# -*- coding: utf-8 -*-
"""Distributor wizard: create a new delivery man login with the delivery man security group."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError


class ShahtajCreateDeliveryManWizard(models.TransientModel):
    _name = 'shahtaj.create.delivery.man.wizard'
    _description = 'Create Delivery Man User'

    name = fields.Char(string='Full Name', required=True)
    login = fields.Char(
        string='Login / Phone',
        required=True,
        help='Username for login (phone number or short name).',
    )
    password = fields.Char(string='Password', required=True)
    shahtaj_employee_code = fields.Char(string='Delivery Man Code (optional)')

    @api.constrains('login')
    def _check_login_unique(self):
        for wizard in self:
            if self.env['res.users'].sudo().search_count([
                ('login', '=ilike', wizard.login),
            ]):
                raise UserError(_('Login "%s" is already used.', wizard.login))

    def action_create_delivery_man(self):
        self.ensure_one()
        dm_group = self.env.ref('shahtaj_oil.group_shahtaj_delivery_man')
        existing = self.env['res.users'].sudo().search([
            ('login', '=ilike', self.login),
        ], limit=1)
        if existing:
            raise UserError(_('Login "%s" is already used.', self.login))

        user = self.env['res.users'].sudo().create({
            'name': self.name,
            'login': self.login,
            'password': self.password,
            'shahtaj_employee_code': self.shahtaj_employee_code,
            'group_ids': [(6, 0, [dm_group.id])],
            'shahtaj_custom_frontend': False,
            'shahtaj_distributor_financial_access': False,
            'tz': 'Asia/Karachi',
            'country_id': self.env.ref('base.pk').id,
        })
        self.env['shahtaj.activity.log'].log_business(
            operation='delivery_man.create',
            name='Delivery man created',
            related_record=user,
            message=_('Created delivery man %(login)s', login=user.login),
        )
        return {
            'type': 'ir.actions.act_window',
            'name': _('Delivery Man'),
            'res_model': 'res.users',
            'res_id': user.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_delivery_man_form').id, 'form'),
            ],
        }
