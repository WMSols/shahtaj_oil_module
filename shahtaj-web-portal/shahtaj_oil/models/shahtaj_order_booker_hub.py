# -*- coding: utf-8 -*-
"""Distributor landing page for order booker operations."""
from odoo import _, api, fields, models

from .shahtaj_visit_task import shahtaj_week_bounds


class ShahtajOrderBookerHub(models.TransientModel):
    _name = 'shahtaj.order.booker.hub'
    _description = 'Order Booker Operations Hub'

    order_booker_count = fields.Integer(
        string='Order Bookers',
        compute='_compute_counts',
    )
    schedule_line_count = fields.Integer(
        string='Active Schedule Lines',
        compute='_compute_counts',
    )
    visit_tasks_today_pending = fields.Integer(
        string='Tasks Pending Today',
        compute='_compute_counts',
    )
    visit_tasks_week_total = fields.Integer(
        string='Tasks This Week',
        compute='_compute_counts',
    )
    target_active_count = fields.Integer(
        string='Active Targets',
        compute='_compute_counts',
    )
    zone_count = fields.Integer(
        string='Zones',
        compute='_compute_counts',
    )
    route_count = fields.Integer(
        string='Routes',
        compute='_compute_counts',
    )
    shop_count = fields.Integer(
        string='Approved Shops',
        compute='_compute_counts',
    )
    shops_pending_count = fields.Integer(
        string='Shops Pending Approval',
        compute='_compute_counts',
    )
    visits_today_count = fields.Integer(
        string='Shop Visits Today',
        compute='_compute_counts',
    )
    orders_to_approve_count = fields.Integer(
        string='Orders Needing Verification',
        compute='_compute_counts',
    )

    @api.depends_context('uid')
    def _compute_counts(self):
        Users = self.env['res.users'].sudo()
        Schedule = self.env['shahtaj.weekly.schedule'].sudo()
        VisitTask = self.env['shahtaj.visit.task'].sudo()
        Target = self.env['shahtaj.visit.target'].sudo()
        Zone = self.env['shahtaj.zone'].sudo()
        Route = self.env['shahtaj.route'].sudo()
        Partner = self.env['res.partner'].sudo()
        Visit = self.env['shahtaj.visit'].sudo()
        SaleOrder = self.env['sale.order'].sudo()
        today = fields.Date.context_today(self)
        week_start, week_end = shahtaj_week_bounds(today)

        for hub in self:
            hub.order_booker_count = Users.search_count([
                ('shahtaj_is_order_booker', '=', True),
                ('active', '=', True),
            ])
            hub.schedule_line_count = Schedule.search_count([
                ('active', '=', True),
            ])
            hub.visit_tasks_today_pending = VisitTask.search_count([
                ('task_kind', '=', 'order_booker'),
                ('scheduled_date', '=', today),
                ('state', 'in', ('pending', 'in_progress')),
            ])
            hub.visit_tasks_week_total = VisitTask.search_count([
                ('task_kind', '=', 'order_booker'),
                ('scheduled_date', '>=', week_start),
                ('scheduled_date', '<=', week_end),
                ('state', 'not in', ('cancelled',)),
            ])
            hub.target_active_count = Target.search_count([
                ('active', '=', True),
            ])
            hub.zone_count = Zone.search_count([])
            hub.route_count = Route.search_count([])
            hub.shop_count = Partner.search_count([
                ('is_shahtaj_shop', '=', True),
                ('shop_approval_state', '=', 'approved'),
            ])
            hub.shops_pending_count = Partner.search_count([
                ('is_shahtaj_shop', '=', True),
                ('shop_approval_state', '=', 'pending'),
            ])
            hub.visits_today_count = Visit.search_count([
                ('started_at', '>=', fields.Datetime.to_datetime(today)),
                ('started_at', '<', fields.Datetime.to_datetime(
                    fields.Date.add(today, days=1),
                )),
            ])
            hub.orders_to_approve_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
                ('shahtaj_approval_state', '=', 'to_approve'),
                ('state', 'in', ('draft', 'sent')),
            ])

    @api.model
    def action_open_order_booker_hub(self):
        record = self.create({})
        return {
            'type': 'ir.actions.act_window',
            'name': _('Order Booker Operations'),
            'res_model': 'shahtaj.order.booker.hub',
            'res_id': record.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref(
                    'shahtaj_oil.view_shahtaj_order_booker_hub_form'
                ).id, 'form'),
            ],
        }

    def _open_action(self, xml_id):
        return self.env['ir.actions.act_window']._for_xml_id(xml_id)

    def action_open_order_bookers(self):
        return self._open_action(
            'shahtaj_oil.action_shahtaj_order_booker_management',
        )

    def action_open_create_order_booker(self):
        return self._open_action(
            'shahtaj_oil.action_shahtaj_create_order_booker_wizard',
        )

    def action_open_weekly_schedules(self):
        return self._open_action('shahtaj_oil.action_shahtaj_schedule_hub')

    def action_open_visit_tasks_progress(self):
        return self._open_action('shahtaj_oil.action_shahtaj_visit_hub_ob')

    def action_open_all_visit_tasks(self):
        return self._open_action('shahtaj_oil.action_shahtaj_visit_task')

    def action_open_shop_visits(self):
        return self._open_action('shahtaj_oil.action_shahtaj_visit')

    def action_open_targets(self):
        return self._open_action('shahtaj_oil.action_shahtaj_visit_target')

    def action_open_zones(self):
        return self._open_action('shahtaj_oil.action_shahtaj_zone')

    def action_open_routes(self):
        return self._open_action('shahtaj_oil.action_shahtaj_route')

    def action_open_shops(self):
        return self._open_action('shahtaj_oil.action_shahtaj_shop')

    def action_open_shops_pending(self):
        return self._open_action('shahtaj_oil.action_shahtaj_shop_pending')

    def action_open_shops_unassigned(self):
        return self._open_action('shahtaj_oil.action_shahtaj_shop_unassigned')

    def action_open_generate_tasks(self):
        return self._open_action(
            'shahtaj_oil.action_shahtaj_generate_tasks_wizard',
        )

    def action_open_orders_hub(self):
        return self.env['shahtaj.orders.hub'].action_open_orders_hub()

    def action_open_orders_needing_verification(self):
        return self._open_action(
            'shahtaj_oil.action_shahtaj_orders_needing_verification',
        )

    def action_open_field_sales_orders(self):
        return self._open_action(
            'shahtaj_oil.action_shahtaj_field_sales_orders',
        )

    def action_open_rejected_orders(self):
        return self._open_action('shahtaj_oil.action_shahtaj_orders_rejected')

    def action_open_orders_to_invoice(self):
        return self._open_action('shahtaj_oil.action_shahtaj_orders_to_invoice')
