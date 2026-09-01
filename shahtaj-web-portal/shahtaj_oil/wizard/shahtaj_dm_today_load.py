# -*- coding: utf-8 -*-
"""DM Today's Load: shop progress + editable collective pick for the day."""
from collections import defaultdict

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_is_zero, float_round


class ShahtajDmTodayLoad(models.TransientModel):
    _name = 'shahtaj.dm.today.load'
    _description = 'DM Today Load Dashboard'

    load_date = fields.Date(
        string='Day',
        required=True,
        default=lambda self: fields.Date.context_today(self),
    )
    delivery_man_id = fields.Many2one(
        'res.users',
        string='Delivery Man',
        required=True,
        default=lambda self: self.env.user,
        readonly=True,
    )
    shop_line_ids = fields.One2many(
        'shahtaj.dm.today.load.shop',
        'wizard_id',
        string='Shop Progress',
    )
    pick_line_ids = fields.One2many(
        'shahtaj.dm.today.load.pick',
        'wizard_id',
        string='Pick Totals',
    )
    summary_html = fields.Html(
        string='Summary',
        sanitize=False,
    )
    shop_count = fields.Integer(string='Shops', readonly=True)
    total_still_to_pick = fields.Float(
        string='Still to Pick (all products)',
        digits='Product Unit of Measure',
        readonly=True,
    )

    @api.model
    def action_open(self):
        """Menu / list header: open Today's Load for the current user."""
        wizard = self.create({})
        wizard.action_refresh()
        return {
            'type': 'ir.actions.act_window',
            'name': _("Today's Load"),
            'res_model': self._name,
            'res_id': wizard.id,
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'current',
        }

    def action_refresh(self):
        self.ensure_one()
        Delivery = self.env['shahtaj.dm.delivery']
        day = self.load_date or fields.Date.context_today(self)
        dm = self.delivery_man_id or self.env.user

        deliveries = Delivery.search([
            ('delivery_man_id', '=', dm.id),
            ('state', '!=', 'not_ready'),
            '|',
            ('scheduled_date', '=', day),
            ('scheduled_date', '=', False),
        ], order='partner_id, id')

        for delivery in deliveries:
            delivery.sudo()._sync_with_sale_order(ensure_visit_task=False)

        self.shop_line_ids.unlink()
        self.pick_line_ids.unlink()

        shop_vals = []
        product_agg = {}

        for delivery in deliveries:
            qty_ordered = sum(delivery.line_ids.mapped('qty_assigned'))
            qty_picked = sum(delivery.line_ids.mapped('qty_picked'))
            qty_delivered = sum(delivery.line_ids.mapped('qty_delivered'))
            qty_left = sum(
                max(l.qty_picked - l.qty_delivered, 0.0) for l in delivery.line_ids
            )
            still_pick = sum(
                max(l.qty_assigned - l.qty_picked, 0.0) for l in delivery.line_ids
            )
            ratio = 0.0
            if qty_picked > 0:
                ratio = (qty_delivered / qty_picked) * 100.0
            shop_vals.append((0, 0, {
                'delivery_id': delivery.id,
                'partner_id': delivery.partner_id.id,
                'sale_order_id': delivery.sale_order_id.id,
                'qty_ordered': qty_ordered,
                'qty_picked': qty_picked,
                'qty_delivered': qty_delivered,
                'qty_left_on_van': qty_left,
                'qty_still_to_pick': still_pick,
                'delivered_ratio': ratio,
            }))

            for line in delivery.line_ids:
                still = max(line.qty_assigned - line.qty_picked, 0.0)
                pid = line.product_id.id
                if pid not in product_agg:
                    product_agg[pid] = {
                        'product_id': pid,
                        'product_uom_id': line.product_uom_id.id,
                        'qty_ordered': 0.0,
                        'qty_picked': 0.0,
                        'qty_delivered': 0.0,
                        'qty_still_needed': 0.0,
                    }
                agg = product_agg[pid]
                agg['qty_ordered'] += line.qty_assigned
                agg['qty_picked'] += line.qty_picked
                agg['qty_delivered'] += line.qty_delivered
                agg['qty_still_needed'] += still

        pick_vals = []
        total_still = 0.0
        for pid, agg in product_agg.items():
            still = agg['qty_still_needed']
            total_still += still
            if still <= 0 and agg['qty_picked'] <= 0 and agg['qty_ordered'] <= 0:
                continue
            pick_vals.append((0, 0, {
                'product_id': agg['product_id'],
                'product_uom_id': agg['product_uom_id'],
                'qty_ordered': agg['qty_ordered'],
                'qty_already_picked': agg['qty_picked'],
                'qty_delivered': agg['qty_delivered'],
                'qty_still_needed': still,
                'qty_to_pick': still,
            }))

        shops_done = len(deliveries.filtered(lambda d: d.delivery_progress == 'done'))
        shops_partial = len(deliveries.filtered(lambda d: d.delivery_progress == 'partial'))
        summary = (
            f'<p class="mb-0">'
            f'<b>{len(shop_vals)}</b> shop(s) today · '
            f'<b>{shops_partial}</b> partial · '
            f'<b>{shops_done}</b> done · '
            f'still to pick (sum of lines): <b>{total_still:g}</b>'
            f'</p>'
        )

        self.write({
            'shop_line_ids': shop_vals,
            'pick_line_ids': pick_vals,
            'shop_count': len(shop_vals),
            'total_still_to_pick': total_still,
            'summary_html': summary,
        })
        return True

    def action_pick_today_load(self):
        """Confirm editable collective pick for today's deliveries."""
        self.ensure_one()
        Delivery = self.env['shahtaj.dm.delivery']
        day = self.load_date or fields.Date.context_today(self)
        dm = self.delivery_man_id or self.env.user

        # Snapshot edited pick qty before any sync that might confuse UI
        pick_by_product = {}
        for pline in self.pick_line_ids:
            rounding = pline.product_uom_id.rounding or 0.01
            qty = pline.qty_to_pick or 0.0
            if float_compare(qty, 0.0, precision_rounding=rounding) < 0:
                raise UserError(_('Pick quantity cannot be negative.'))
            if float_compare(qty, pline.qty_still_needed, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Cannot pick %(qty)s of %(product)s — only %(max)s still needed today.',
                    qty=qty,
                    product=pline.product_id.display_name,
                    max=pline.qty_still_needed,
                ))
            if not float_is_zero(qty, precision_rounding=rounding):
                pick_by_product[pline.product_id.id] = qty

        if not pick_by_product:
            raise UserError(_('Set Pick Now on at least one product (or leave totals as suggested).'))

        deliveries = Delivery.search([
            ('delivery_man_id', '=', dm.id),
            ('state', 'in', ('ready', 'picked', 'partial')),
            '|',
            ('scheduled_date', '=', day),
            ('scheduled_date', '=', False),
        ], order='id')

        for delivery in deliveries:
            delivery.sudo()._sync_with_sale_order(ensure_visit_task=False)

        # FIFO allocate product totals onto delivery lines
        remaining = dict(pick_by_product)
        qty_by_delivery = defaultdict(dict)  # delivery_id -> {line_id: qty}

        for delivery in deliveries:
            for line in delivery.line_ids:
                pid = line.product_id.id
                if pid not in remaining:
                    continue
                left = remaining[pid]
                if left <= 0:
                    continue
                still = max(line.qty_assigned - line.qty_picked, 0.0)
                if still <= 0:
                    continue
                rounding = line.product_uom_id.rounding or 0.01
                take = float_round(min(still, left), precision_rounding=rounding)
                if take <= 0:
                    continue
                qty_by_delivery[delivery.id][line.id] = take
                remaining[pid] = float_round(left - take, precision_rounding=rounding)

        # Any leftover means data drifted (lines changed); ignore tiny float dust
        for pid, left in remaining.items():
            product = self.env['product.product'].browse(pid)
            rounding = product.uom_id.rounding or 0.01
            if float_compare(left, 0.0, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Could not allocate %(qty)s of %(product)s across today\'s shops. '
                    'Refresh and try again.',
                    qty=left,
                    product=product.display_name,
                ))

        if not qty_by_delivery:
            raise UserError(_('Nothing left to pick for today.'))

        picked_shops = 0
        for delivery_id, qty_map in qty_by_delivery.items():
            delivery = Delivery.browse(delivery_id)
            delivery._pick_stock_with_qtys(qty_map, reload_form=False)
            picked_shops += 1

        self.action_refresh()
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Stock loaded to van'),
                'message': _(
                    'Picked for %(count)s shop order(s). Check Shop Progress and continue delivering.',
                    count=picked_shops,
                ),
                'type': 'success',
                'sticky': False,
                'next': {
                    'type': 'ir.actions.act_window',
                    'name': _("Today's Load"),
                    'res_model': self._name,
                    'res_id': self.id,
                    'view_mode': 'form',
                    'views': [(False, 'form')],
                    'target': 'current',
                },
            },
        }

    def action_open_van_stock(self):
        self.ensure_one()
        return self.env['shahtaj.dm.delivery'].action_open_my_van_stock()

    def action_open_my_deliveries(self):
        return {
            'type': 'ir.actions.act_window',
            'name': _('My Deliveries'),
            'res_model': 'shahtaj.dm.delivery',
            'view_mode': 'list,form',
            'domain': [
                ('delivery_man_id', '=', (self.delivery_man_id or self.env.user).id),
                ('scheduled_date', '=', self.load_date or fields.Date.context_today(self)),
                ('state', '!=', 'not_ready'),
            ],
            'target': 'current',
        }


class ShahtajDmTodayLoadShop(models.TransientModel):
    _name = 'shahtaj.dm.today.load.shop'
    _description = 'DM Today Load Shop Progress'
    _order = 'partner_id, id'

    wizard_id = fields.Many2one(
        'shahtaj.dm.today.load',
        required=True,
        ondelete='cascade',
    )
    delivery_id = fields.Many2one('shahtaj.dm.delivery', readonly=True)
    partner_id = fields.Many2one('res.partner', string='Shop', readonly=True)
    sale_order_id = fields.Many2one('sale.order', string='Order', readonly=True)
    state = fields.Selection(
        related='delivery_id.state',
        string='Stock',
        readonly=True,
    )
    field_state = fields.Selection(
        related='delivery_id.field_state',
        string='Stop',
        readonly=True,
    )
    delivery_progress = fields.Selection(
        related='delivery_id.delivery_progress',
        string='Progress',
        readonly=True,
    )
    qty_ordered = fields.Float(string='Ordered', digits='Product Unit of Measure', readonly=True)
    qty_picked = fields.Float(string='Picked', digits='Product Unit of Measure', readonly=True)
    qty_delivered = fields.Float(string='Delivered', digits='Product Unit of Measure', readonly=True)
    qty_left_on_van = fields.Float(string='Left on Van', digits='Product Unit of Measure', readonly=True)
    qty_still_to_pick = fields.Float(string='Still to Pick', digits='Product Unit of Measure', readonly=True)
    delivered_ratio = fields.Float(
        string='Delivered % of Picked',
        digits=(16, 1),
        readonly=True,
        help='Delivered ÷ Picked × 100 for this shop (0 if nothing picked yet).',
    )

    def action_open_delivery(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': self.delivery_id.display_name,
            'res_model': 'shahtaj.dm.delivery',
            'res_id': self.delivery_id.id,
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'current',
        }


class ShahtajDmTodayLoadPick(models.TransientModel):
    _name = 'shahtaj.dm.today.load.pick'
    _description = 'DM Today Load Pick Line'
    _order = 'product_id'

    wizard_id = fields.Many2one(
        'shahtaj.dm.today.load',
        required=True,
        ondelete='cascade',
    )
    product_id = fields.Many2one('product.product', string='Product', readonly=True)
    product_uom_id = fields.Many2one('uom.uom', string='UoM', readonly=True)
    qty_ordered = fields.Float(string='Ordered Today', digits='Product Unit of Measure', readonly=True)
    qty_already_picked = fields.Float(string='Already Picked', digits='Product Unit of Measure', readonly=True)
    qty_delivered = fields.Float(string='Delivered', digits='Product Unit of Measure', readonly=True)
    qty_still_needed = fields.Float(string='Still Needed', digits='Product Unit of Measure', readonly=True)
    qty_to_pick = fields.Float(string='Pick Now', digits='Product Unit of Measure')
