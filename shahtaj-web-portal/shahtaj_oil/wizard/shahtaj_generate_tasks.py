# -*- coding: utf-8 -*-
"""Distributor tool: manually generate visit tasks for a date range."""
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError


class ShahtajGenerateTasksWizard(models.TransientModel):
    _name = 'shahtaj.generate.tasks.wizard'
    _description = 'Generate Visit Tasks from Weekly Schedules'

    date_from = fields.Date(
        string='From Date',
        required=True,
        default=fields.Date.context_today,
    )
    date_to = fields.Date(
        string='To Date',
        required=True,
        default=lambda self: fields.Date.context_today(self) + timedelta(days=27),
    )
    order_booker_id = fields.Many2one(
        'res.users',
        string='Order Booker',
        help='Leave empty to generate for all order bookers with schedules.',
    )

    @api.constrains('date_from', 'date_to')
    def _check_dates(self):
        for wizard in self:
            if wizard.date_to < wizard.date_from:
                raise UserError(_('End date must be on or after start date.'))

    def action_generate(self):
        self.ensure_one()
        Task = self.env['shahtaj.visit.task']
        created, skipped = Task._generate_from_schedules(
            self.date_from,
            self.date_to,
            order_booker=self.order_booker_id or None,
        )
        if not created and not skipped:
            raise UserError(_(
                'No tasks were created. Add weekly schedules first and ensure '
                'routes have shops assigned.'
            ))
        message = _(
            'Created %(created)s visit task(s). Skipped %(skipped)s duplicate(s).',
            created=len(created),
            skipped=skipped,
        )
        return {
            'type': 'ir.actions.act_window',
            'name': _('Visit Tasks'),
            'res_model': 'shahtaj.visit.task',
            'view_mode': 'list,form',
            'domain': [('id', 'in', created.ids)],
            'context': {
                'default_order_booker_id': self.order_booker_id.id if self.order_booker_id else False,
            },
            'target': 'current',
            'views': [
                (self.env.ref('shahtaj_oil.view_shahtaj_visit_task_list').id, 'list'),
                (self.env.ref('shahtaj_oil.view_shahtaj_visit_task_form').id, 'form'),
            ],
        }
