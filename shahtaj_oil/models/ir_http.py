# -*- coding: utf-8 -*-
"""On booker login: update last seen and ensure visit tasks exist for coming days."""
from odoo import fields, models
from odoo.http import request


class IrHttp(models.AbstractModel):
    _inherit = 'ir.http'

    def session_info(self):
        # Runs when Odoo web client loads session (each login / page load).
        if request.session.uid:
            user = request.env.user
            if user.has_group('shahtaj_oil.group_shahtaj_order_booker'):
                user.sudo().write({
                    'shahtaj_last_seen_at': fields.Datetime.now(),
                })
                request.env['shahtaj.visit.task'].sudo()._auto_generate_window(
                    order_booker=user,
                )
        result = super().session_info()
        if request.session.uid and request.env.user.shahtaj_custom_frontend:
            result['shahtaj_custom_frontend'] = True
        return result
