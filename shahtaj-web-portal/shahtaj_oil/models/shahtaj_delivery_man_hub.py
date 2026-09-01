# -*- coding: utf-8 -*-
"""Distributor landing page for delivery man operations."""
from odoo import _, api, fields, models


class ShahtajDeliveryManHub(models.TransientModel):
    _name = 'shahtaj.delivery.man.hub'
    _description = 'Delivery Man Operations Hub'

    delivery_man_count = fields.Integer(
        string='Delivery Men',
        compute='_compute_counts',
    )
    dm_jobs_today_count = fields.Integer(
        string='Jobs Today',
        compute='_compute_counts',
    )
    dm_jobs_active_count = fields.Integer(
        string='Active Jobs',
        compute='_compute_counts',
    )
    dispatch_orders_count = fields.Integer(
        string='Orders to Dispatch',
        compute='_compute_counts',
    )
    dm_tasks_today_pending = fields.Integer(
        string='DM Stops Pending Today',
        compute='_compute_counts',
    )
    dm_deliveries_in_transit = fields.Integer(
        string='In Transit / On the Way',
        compute='_compute_counts',
    )

    @api.depends_context('uid')
    def _compute_counts(self):
        Users = self.env['res.users'].sudo()
        DmDelivery = self.env['shahtaj.dm.delivery'].sudo()
        SaleOrder = self.env['sale.order'].sudo()
        VisitTask = self.env['shahtaj.visit.task'].sudo()
        today = fields.Date.context_today(self)

        for hub in self:
            hub.delivery_man_count = Users.search_count([
                ('shahtaj_is_delivery_man', '=', True),
                ('active', '=', True),
            ])
            hub.dm_jobs_today_count = DmDelivery.search_count([
                ('scheduled_date', '=', today),
                ('state', '!=', 'not_ready'),
            ])
            hub.dm_jobs_active_count = DmDelivery.search_count([
                ('state', 'in', ('ready', 'picked', 'partial')),
            ])
            hub.dispatch_orders_count = SaleOrder.search_count([
                ('state', 'in', ('sale', 'done')),
                ('shahtaj_delivery_status', 'in', ('pending', 'partial')),
            ])
            hub.dm_tasks_today_pending = VisitTask.search_count([
                ('task_kind', '=', 'delivery_man'),
                ('scheduled_date', '=', today),
                ('state', 'in', ('pending', 'in_progress')),
            ])
            hub.dm_deliveries_in_transit = DmDelivery.search_count([
                ('field_state', '=', 'in_transit'),
            ])

    @api.model
    def action_open_delivery_man_hub(self):
        record = self.create({})
        return {
            'type': 'ir.actions.act_window',
            'name': _('Delivery Man Operations'),
            'res_model': 'shahtaj.delivery.man.hub',
            'res_id': record.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref(
                    'shahtaj_oil.view_shahtaj_delivery_man_hub_form'
                ).id, 'form'),
            ],
        }

    def _open_action(self, xml_id):
        return self.env['ir.actions.act_window']._for_xml_id(xml_id)

    def action_open_delivery_men(self):
        return self._open_action(
            'shahtaj_oil.action_shahtaj_delivery_man_management',
        )

    def action_open_create_delivery_man(self):
        return self._open_action(
            'shahtaj_oil.action_shahtaj_create_delivery_man_wizard',
        )

    def action_open_dispatch_orders(self):
        return self._open_action(
            'shahtaj_oil.action_shahtaj_dm_dispatch_orders',
        )

    def action_open_dispatch_jobs(self):
        return self._open_action('shahtaj_oil.action_shahtaj_dm_dispatch_jobs')

    def action_open_all_deliveries(self):
        return self._open_action('shahtaj_oil.action_shahtaj_dm_delivery_all')

    def action_open_visit_tasks_progress(self):
        return self._open_action('shahtaj_oil.action_shahtaj_visit_hub_dm')

    def action_open_orders_hub(self):
        return self.env['shahtaj.orders.hub'].action_open_orders_hub()
