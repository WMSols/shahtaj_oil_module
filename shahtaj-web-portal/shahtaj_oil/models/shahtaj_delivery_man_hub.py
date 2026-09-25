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
    dm_jobs_overdue_count = fields.Integer(
        string='Overdue / Not Done',
        compute='_compute_counts',
        help='Open jobs with a past delivery day or no day — reschedule from Delivery Jobs.',
    )
    dm_tasks_today_pending = fields.Integer(
        string='Deliveries Pending Today',
        compute='_compute_counts',
        help='Today-scheduled delivery jobs not yet delivered or returned.',
    )
    dm_out_on_route_count = fields.Integer(
        string='DMs Left Office Today',
        compute='_compute_counts',
        help='Day sessions with status Left Office / Out on Route (whole DM, not one shop).',
    )
    dm_deliveries_in_transit = fields.Integer(
        string='Stops Heading to Shop',
        compute='_compute_counts',
        help='Delivery jobs whose Stop field is Heading to Shop (per shop, not day status).',
    )
    walk_in_order_count = fields.Integer(
        string='Walk-in Orders',
        compute='_compute_counts',
        help='Cash-and-carry van sales to non-shop walk-in customers.',
    )

    @api.depends_context('uid')
    def _compute_counts(self):
        Users = self.env['res.users'].sudo()
        DmDelivery = self.env['shahtaj.dm.delivery'].sudo()
        SaleOrder = self.env['sale.order'].sudo()
        DaySession = self.env['shahtaj.dm.day.session'].sudo()
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
                ('partner_id.shahtaj_is_walk_in', '!=', True),
            ])
            hub.dm_tasks_today_pending = DmDelivery.search_count([
                ('scheduled_date', '=', today),
                ('state', 'not in', ('delivered', 'returned')),
            ])
            hub.dm_jobs_overdue_count = DmDelivery.search_count(
                DmDelivery._shahtaj_overdue_open_jobs_domain(today),
            )
            hub.dm_out_on_route_count = DaySession.search_count([
                ('session_date', '=', today),
                ('state', '=', 'on_the_way'),
            ])
            hub.dm_deliveries_in_transit = DmDelivery.search_count([
                ('field_state', '=', 'in_transit'),
            ])
            hub.walk_in_order_count = SaleOrder.search_count([
                ('partner_id.shahtaj_is_walk_in', '=', True),
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

    def action_open_overdue_jobs(self):
        return self._open_action('shahtaj_oil.action_shahtaj_dm_overdue_jobs')

    def action_open_all_deliveries(self):
        return self._open_action('shahtaj_oil.action_shahtaj_dm_delivery_all')

    def action_open_visit_tasks_progress(self):
        return self._open_action('shahtaj_oil.action_shahtaj_visit_hub_dm')

    def action_open_orders_hub(self):
        return self.env['shahtaj.orders.hub'].action_open_orders_hub()

    def action_open_walk_in_orders(self):
        return self._open_action('shahtaj_oil.action_shahtaj_walk_in_orders')

    def action_open_walk_in_invoices(self):
        return self._open_action('shahtaj_oil.action_shahtaj_walk_in_invoices')

    def action_open_walk_in_payments(self):
        return self._open_action('shahtaj_oil.action_shahtaj_walk_in_payments')
