# -*- coding: utf-8 -*-
"""DM wizards: editable pick qty and partial deliver with GPS check."""
from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_is_zero

from odoo.addons.shahtaj_oil.models.shahtaj_gps import (
    get_shop_distance_limits,
    shahtaj_distance_meters,
)


class ShahtajDmPickWizard(models.TransientModel):
    _name = 'shahtaj.dm.pick.wizard'
    _description = 'DM Pick Stock Wizard'

    delivery_id = fields.Many2one(
        'shahtaj.dm.delivery',
        string='Delivery',
        required=True,
        readonly=True,
    )
    partner_id = fields.Many2one(related='delivery_id.partner_id', readonly=True)
    line_ids = fields.One2many(
        'shahtaj.dm.pick.wizard.line',
        'wizard_id',
        string='Products',
    )

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        delivery = self.env['shahtaj.dm.delivery'].browse(
            self.env.context.get('active_id') or res.get('delivery_id')
        )
        if not delivery.exists():
            return res
        delivery.sudo()._sync_with_sale_order()
        res['delivery_id'] = delivery.id
        lines = []
        for line in delivery.line_ids:
            still_needed = max(line.qty_assigned - line.qty_picked, 0.0)
            if still_needed <= 0:
                continue
            qty_pick = line.qty_to_pick if line.qty_to_pick > 0 else still_needed
            qty_pick = min(qty_pick, still_needed)
            lines.append((0, 0, {
                'delivery_line_id': line.id,
                'product_id': line.product_id.id,
                'product_uom_id': line.product_uom_id.id,
                'qty_assigned': line.qty_assigned,
                'qty_required': still_needed,
                'qty_already_picked': line.qty_picked,
                'qty_to_pick': qty_pick,
            }))
        res['line_ids'] = lines
        return res

    def action_confirm_pick(self):
        self.ensure_one()
        qty_map = {}
        for line in self.line_ids:
            rounding = line.product_uom_id.rounding or 0.01
            if float_compare(line.qty_to_pick, 0.0, precision_rounding=rounding) < 0:
                raise UserError(_('Pick quantity cannot be negative.'))
            if float_compare(line.qty_to_pick, line.qty_required, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Cannot pick %(qty)s of %(product)s — only %(max)s still needed.',
                    qty=line.qty_to_pick,
                    product=line.product_id.display_name,
                    max=line.qty_required,
                ))
            if not float_is_zero(line.qty_to_pick, precision_rounding=rounding):
                qty_map[line.delivery_line_id.id] = line.qty_to_pick
        if not qty_map:
            raise UserError(_('Enter a pick quantity on at least one product.'))
        return self.delivery_id._pick_stock_with_qtys(qty_map)


class ShahtajDmPickWizardLine(models.TransientModel):
    _name = 'shahtaj.dm.pick.wizard.line'
    _description = 'DM Pick Stock Wizard Line'

    wizard_id = fields.Many2one(
        'shahtaj.dm.pick.wizard',
        required=True,
        ondelete='cascade',
    )
    delivery_line_id = fields.Many2one(
        'shahtaj.dm.delivery.line',
        required=True,
        ondelete='cascade',
    )
    product_id = fields.Many2one('product.product', readonly=True)
    product_uom_id = fields.Many2one('uom.uom', readonly=True)
    qty_assigned = fields.Float(
        string='My Assigned',
        digits='Product Unit of Measure',
        readonly=True,
    )
    qty_required = fields.Float(
        string='Still to Pick',
        digits='Product Unit of Measure',
        readonly=True,
    )
    qty_already_picked = fields.Float(
        string='Already on Van',
        digits='Product Unit of Measure',
        readonly=True,
    )
    qty_to_pick = fields.Float(
        string='Pick Now',
        digits='Product Unit of Measure',
    )


class ShahtajDmDeliverWizard(models.TransientModel):
    _name = 'shahtaj.dm.deliver.wizard'
    _description = 'DM Deliver to Shop Wizard'

    delivery_id = fields.Many2one(
        'shahtaj.dm.delivery',
        string='Delivery',
        required=True,
        readonly=True,
    )
    partner_id = fields.Many2one(related='delivery_id.partner_id', readonly=True)
    shop_latitude = fields.Float(
        string='Shop Latitude',
        digits=(10, 7),
        readonly=True,
    )
    shop_longitude = fields.Float(
        string='Shop Longitude',
        digits=(10, 7),
        readonly=True,
    )
    latitude = fields.Float(
        string='My Latitude',
        digits=(10, 7),
        help='Use “Use My GPS” (device location). Do not copy shop GPS.',
    )
    longitude = fields.Float(
        string='My Longitude',
        digits=(10, 7),
    )
    max_distance_m = fields.Float(
        string='Max Distance (m)',
        digits=(16, 2),
        readonly=True,
    )
    distance_m = fields.Float(
        string='Distance (m)',
        digits=(16, 2),
        compute='_compute_distance_m',
    )
    gps_ok = fields.Boolean(
        string='Within Range',
        compute='_compute_distance_m',
    )
    gps_hint = fields.Char(
        string='GPS Status',
        compute='_compute_distance_m',
    )
    line_ids = fields.One2many(
        'shahtaj.dm.deliver.wizard.line',
        'wizard_id',
        string='Products',
    )

    @api.depends('latitude', 'longitude', 'shop_latitude', 'shop_longitude', 'max_distance_m')
    def _compute_distance_m(self):
        for wiz in self:
            has_me = bool(wiz.latitude) and bool(wiz.longitude)
            has_shop = bool(wiz.shop_latitude) and bool(wiz.shop_longitude)
            if has_me and has_shop:
                dist = shahtaj_distance_meters(
                    wiz.latitude, wiz.longitude,
                    wiz.shop_latitude, wiz.shop_longitude,
                )
                wiz.distance_m = dist
                max_m = float(wiz.max_distance_m or 0.0)
                wiz.gps_ok = bool(max_m) and dist <= max_m
                if wiz.gps_ok:
                    wiz.gps_hint = _('OK — within %(max).0f m', max=max_m)
                else:
                    wiz.gps_hint = _(
                        'Too far — %(dist).0f m (max %(max).0f m)',
                        dist=dist,
                        max=max_m,
                    )
            else:
                wiz.distance_m = 0.0
                wiz.gps_ok = False
                if not has_shop:
                    wiz.gps_hint = _('Shop has no GPS — ask distributor to set it.')
                elif not has_me:
                    wiz.gps_hint = _('Tap “Use My GPS”, then confirm delivery.')
                else:
                    wiz.gps_hint = _('Waiting for location…')

    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        delivery = self.env['shahtaj.dm.delivery'].browse(
            self.env.context.get('active_id') or res.get('delivery_id')
        )
        if not delivery.exists():
            return res
        shop = delivery.partner_id.sudo()
        limits = get_shop_distance_limits(self.env)
        res['delivery_id'] = delivery.id
        res['shop_latitude'] = shop.partner_latitude or 0.0
        res['shop_longitude'] = shop.partner_longitude or 0.0
        res['max_distance_m'] = float(limits.get('max_m') or 0.0)
        # Never prefill DM location with shop GPS — device GPS (or typed coords) required.
        res['latitude'] = 0.0
        res['longitude'] = 0.0
        lines = []
        for line in delivery.line_ids:
            on_van = max(line.qty_picked - line.qty_delivered, 0.0)
            if on_van <= 0:
                continue
            lines.append((0, 0, {
                'delivery_line_id': line.id,
                'product_id': line.product_id.id,
                'product_uom_id': line.product_uom_id.id,
                'qty_on_van': on_van,
                'qty_already_delivered': line.qty_delivered,
                'qty_to_deliver': on_van,
            }))
        res['line_ids'] = lines
        return res

    def action_confirm_deliver(self):
        self.ensure_one()
        shop = self.partner_id.sudo()
        if not shop.partner_latitude or not shop.partner_longitude:
            raise UserError(_(
                'Shop "%(shop)s" has no GPS coordinates. '
                'Ask the distributor to set shop latitude/longitude before delivering.',
                shop=shop.display_name,
            ))
        if not self.latitude or not self.longitude:
            raise UserError(_(
                'Your GPS is missing. Tap “Use My GPS” (or enter your real latitude '
                'and longitude), then confirm.'
            ))
        if not (-90 <= self.latitude <= 90) or not (-180 <= self.longitude <= 180):
            raise UserError(_('Latitude/longitude values are out of range.'))

        # Reject silent “standing on shop pin” when coords are exactly the shop
        # only if that was our old test path — real DM may be at the door.
        # Exact match is allowed when GPS is genuine.

        limits = get_shop_distance_limits(self.env)
        max_m = float(limits.get('max_m') or 0.0)
        distance = shahtaj_distance_meters(
            self.latitude, self.longitude,
            shop.partner_latitude, shop.partner_longitude,
        )
        if distance > max_m:
            raise UserError(_(
                'You are %(dist).0f m from the shop (max allowed %(max).0f m). '
                'Move closer and tap “Use My GPS” again.',
                dist=distance,
                max=max_m,
            ))

        qty_map = {}
        for line in self.line_ids:
            rounding = line.product_uom_id.rounding or 0.01
            if float_compare(line.qty_to_deliver, 0.0, precision_rounding=rounding) < 0:
                raise UserError(_('Deliver quantity cannot be negative.'))
            if float_compare(line.qty_to_deliver, line.qty_on_van, precision_rounding=rounding) > 0:
                raise UserError(_(
                    'Cannot deliver %(qty)s of %(product)s — only %(max)s on van.',
                    qty=line.qty_to_deliver,
                    product=line.product_id.display_name,
                    max=line.qty_on_van,
                ))
            if not float_is_zero(line.qty_to_deliver, precision_rounding=rounding):
                qty_map[line.delivery_line_id.id] = line.qty_to_deliver
        if not qty_map:
            raise UserError(_('Enter a deliver quantity on at least one product.'))

        return self.delivery_id._deliver_to_shop_with_qtys(
            qty_map,
            latitude=self.latitude,
            longitude=self.longitude,
            distance_m=distance,
        )


class ShahtajDmDeliverWizardLine(models.TransientModel):
    _name = 'shahtaj.dm.deliver.wizard.line'
    _description = 'DM Deliver Wizard Line'

    wizard_id = fields.Many2one(
        'shahtaj.dm.deliver.wizard',
        required=True,
        ondelete='cascade',
    )
    delivery_line_id = fields.Many2one(
        'shahtaj.dm.delivery.line',
        required=True,
        ondelete='cascade',
    )
    product_id = fields.Many2one('product.product', readonly=True)
    product_uom_id = fields.Many2one('uom.uom', readonly=True)
    qty_on_van = fields.Float(
        string='On Van',
        digits='Product Unit of Measure',
        readonly=True,
    )
    qty_already_delivered = fields.Float(
        string='Already Delivered',
        digits='Product Unit of Measure',
        readonly=True,
    )
    qty_to_deliver = fields.Float(
        string='Deliver Now',
        digits='Product Unit of Measure',
    )
