# -*- coding: utf-8 -*-
"""Distributor wizard: create a new order booker login with the booker security group."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError


class ShahtajCreateOrderBookerWizard(models.TransientModel):
    _name = 'shahtaj.create.order.booker.wizard'
    _description = 'Create Order Booker User'

    name = fields.Char(string='Full Name', required=True)
    login = fields.Char(
        string='Login / Phone',
        required=True,
        help='Username for login (phone number or short name).',
    )
    password = fields.Char(string='Password', required=True)
    shahtaj_employee_code = fields.Char(string='Booker Code (optional)')

    @api.constrains('login')
    def _check_login_unique(self):
        for wizard in self:
            if self.env['res.users'].sudo().search_count([
                ('login', '=ilike', wizard.login),
            ]):
                raise UserError(_('Login "%s" is already used.', wizard.login))

    def action_create_booker(self):
        self.ensure_one()
        booker_group = self.env.ref('shahtaj_oil.group_shahtaj_order_booker')
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
            'group_ids': [(6, 0, [booker_group.id])],
        })
        return {
            'type': 'ir.actions.act_window',
            'name': _('Order Booker'),
            'res_model': 'res.users',
            'res_id': user.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_order_booker_form').id, 'form'),
            ],
        }
