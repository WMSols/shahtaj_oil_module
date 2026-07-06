# -*- coding: utf-8 -*-
"""Popup: booker enters GPS coordinates to start a shop visit."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError


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

    @api.model
    def default_get(self, fields_list):
        # Pre-fill coords from shop when testing; browser GPS fills them in production.
        res = super().default_get(fields_list)
        task_id = self.env.context.get('default_visit_task_id')
        if task_id:
            task = self.env['shahtaj.visit.task'].browse(task_id)
            if task.shop_id.partner_latitude and task.shop_id.partner_longitude:
                res.setdefault('booker_latitude', task.shop_id.partner_latitude)
                res.setdefault('booker_longitude', task.shop_id.partner_longitude)
        return res

    def action_check_in(self):
        self.ensure_one()
        if not self.visit_task_id:
            raise UserError(_('No visit task selected.'))
        result = self.env['shahtaj.visit'].create_from_task_checkin(
            self.visit_task_id,
            self.booker_latitude,
            self.booker_longitude,
        )
        if isinstance(result, dict):
            return result
        visit = result
        return visit.action_open_booker_form()
