# -*- coding: utf-8 -*-
"""Log every shop GPS check (success and blocked) for bookers and delivery men."""
import logging

from odoo import SUPERUSER_ID, api, fields, models
from odoo.modules.registry import Registry

_logger = logging.getLogger(__name__)


class ShahtajGpsAttempt(models.Model):
    _name = 'shahtaj.gps.attempt'
    _description = 'Shop GPS Attempt Log'
    _order = 'create_date desc, id desc'
    _rec_name = 'display_name'

    display_name = fields.Char(compute='_compute_display_name', store=True)

    user_id = fields.Many2one(
        'res.users',
        string='User',
        required=True,
        index=True,
        ondelete='cascade',
    )
    role = fields.Selection(
        [
            ('order_booker', 'Order Booker'),
            ('delivery_man', 'Delivery Man'),
            ('other', 'Other'),
        ],
        string='Role',
        required=True,
        default='other',
        index=True,
    )
    purpose = fields.Selection(
        [
            ('check_in', 'Check-in'),
            ('place_order', 'Place Order'),
            ('deliver', 'Deliver to Shop'),
            ('walk_in', 'Walk-in Delivery'),
        ],
        string='Purpose',
        required=True,
        index=True,
    )
    shop_id = fields.Many2one(
        'res.partner',
        string='Shop',
        index=True,
        ondelete='set null',
    )
    shop_latitude = fields.Float(string='Shop Latitude', digits=(10, 7))
    shop_longitude = fields.Float(string='Shop Longitude', digits=(10, 7))
    attempt_latitude = fields.Float(string='Attempt Latitude', digits=(10, 7))
    attempt_longitude = fields.Float(string='Attempt Longitude', digits=(10, 7))
    distance_m = fields.Float(string='Distance (m)', digits=(16, 2))
    min_distance_m = fields.Float(string='Min Allowed (m)', digits=(16, 2))
    max_distance_m = fields.Float(string='Max Allowed (m)', digits=(16, 2))
    result = fields.Selection(
        [
            ('ok', 'OK'),
            ('blocked_too_far', 'Blocked — Too Far'),
            ('blocked_too_close', 'Blocked — Too Close'),
            ('blocked_missing_shop_gps', 'Blocked — Shop GPS Missing'),
            ('blocked_missing_user_gps', 'Blocked — User GPS Missing'),
            ('blocked_invalid_coords', 'Blocked — Invalid Coordinates'),
        ],
        string='Result',
        required=True,
        index=True,
    )
    message = fields.Char(string='Detail')
    visit_task_id = fields.Many2one(
        'shahtaj.visit.task',
        string='Visit Task',
        ondelete='set null',
        index=True,
    )
    visit_id = fields.Many2one(
        'shahtaj.visit',
        string='Visit',
        ondelete='set null',
        index=True,
    )
    sale_order_id = fields.Many2one(
        'sale.order',
        string='Sales Order',
        ondelete='set null',
        index=True,
    )
    dm_delivery_id = fields.Many2one(
        'shahtaj.dm.delivery',
        string='Delivery Job',
        ondelete='set null',
        index=True,
    )
    company_id = fields.Many2one(
        'res.company',
        string='Company',
        required=True,
        default=lambda self: self.env.company,
        index=True,
    )

    @api.depends('shop_id', 'user_id', 'result', 'purpose', 'distance_m')
    def _compute_display_name(self):
        purpose_labels = dict(self._fields['purpose'].selection)
        result_labels = dict(self._fields['result'].selection)
        for rec in self:
            shop = rec.shop_id.display_name if rec.shop_id else '—'
            user = rec.user_id.display_name if rec.user_id else '—'
            purpose = purpose_labels.get(rec.purpose, rec.purpose or '')
            result = result_labels.get(rec.result, rec.result or '')
            dist = ''
            if rec.distance_m:
                dist = f' · {rec.distance_m:.0f} m'
            rec.display_name = f'{purpose}: {user} @ {shop} — {result}{dist}'

    @api.model
    def _shahtaj_resolve_role(self, user=None):
        user = user or self.env.user
        if getattr(user, 'shahtaj_is_delivery_man', False):
            return 'delivery_man'
        if getattr(user, 'shahtaj_is_order_booker', False):
            return 'order_booker'
        return 'other'

    @api.model
    def _prepare_attempt_vals(
        self,
        *,
        purpose,
        result,
        shop=None,
        latitude=None,
        longitude=None,
        distance_m=0.0,
        min_distance_m=0.0,
        max_distance_m=0.0,
        message='',
        user=None,
        visit_task=None,
        visit=None,
        sale_order=None,
        dm_delivery=None,
        role=None,
    ):
        user = user or self.env.user
        shop = shop.sudo() if shop else shop
        vals = {
            'user_id': user.id,
            'role': role or self._shahtaj_resolve_role(user),
            'purpose': purpose,
            'result': result,
            'distance_m': float(distance_m or 0.0),
            'min_distance_m': float(min_distance_m or 0.0),
            'max_distance_m': float(max_distance_m or 0.0),
            'message': str(message or '')[:512],
            'company_id': self.env.company.id,
        }
        if shop:
            vals['shop_id'] = shop.id
            vals['shop_latitude'] = shop.partner_latitude or 0.0
            vals['shop_longitude'] = shop.partner_longitude or 0.0
        if latitude is not None:
            vals['attempt_latitude'] = float(latitude)
        if longitude is not None:
            vals['attempt_longitude'] = float(longitude)
        if visit_task:
            vals['visit_task_id'] = visit_task.id
        if visit:
            vals['visit_id'] = visit.id
        if sale_order:
            vals['sale_order_id'] = sale_order.id
        if dm_delivery:
            vals['dm_delivery_id'] = dm_delivery.id
        return vals

    @api.model
    def log_attempt(
        self,
        *,
        purpose,
        result,
        shop=None,
        latitude=None,
        longitude=None,
        distance_m=0.0,
        min_distance_m=0.0,
        max_distance_m=0.0,
        message='',
        user=None,
        visit_task=None,
        visit=None,
        sale_order=None,
        dm_delivery=None,
        role=None,
    ):
        """Create a GPS attempt row. Never raises to callers.

        Blocked attempts are committed on a separate DB cursor so they survive
        the UserError rollback from native OB / API / DM GPS rejection.
        Successful attempts stay in the current transaction (with the visit).
        """
        try:
            vals = self._prepare_attempt_vals(
                purpose=purpose,
                result=result,
                shop=shop,
                latitude=latitude,
                longitude=longitude,
                distance_m=distance_m,
                min_distance_m=min_distance_m,
                max_distance_m=max_distance_m,
                message=message,
                user=user,
                visit_task=visit_task,
                visit=visit,
                sale_order=sale_order,
                dm_delivery=dm_delivery,
                role=role,
            )
            if result == 'ok':
                return self.sudo().create(vals)

            # Survive rollback of the failed check-in / deliver transaction.
            attempt_id = False
            with Registry(self.env.cr.dbname).cursor() as cr:
                env = api.Environment(cr, SUPERUSER_ID, dict(self.env.context))
                attempt_id = env['shahtaj.gps.attempt'].create(vals).id
            return self.browse(attempt_id)
        except Exception:  # noqa: BLE001 — logging must never block check-in/deliver
            _logger.exception(
                'Failed to persist shahtaj.gps.attempt (%s / %s)', purpose, result,
            )
            return self.browse()

    def _stamp_create_date(self, when):
        """Set create_date so historical backfill sorts with the original visit."""
        if not self or not when:
            return
        self.env.cr.execute(
            "UPDATE shahtaj_gps_attempt SET create_date = %s WHERE id IN %s",
            (when, tuple(self.ids)),
        )
        self.invalidate_recordset(['create_date'])

    @api.model
    def promote_checkin_to_place_order(self, visit, sale_order=None):
        """One successful GPS row per booker visit.

        Check-in creates the row with purpose ``check_in``. Placing the order
        updates that same row to ``place_order`` and drops any extra OK
        place-order row for the visit. Blocked attempts are left as-is.
        """
        visit = visit.sudo() if visit else visit
        if not visit or visit.visit_kind == 'delivery_man':
            return self.browse()
        order = sale_order or visit.sale_order_id
        checkins = self.sudo().search([
            ('visit_id', '=', visit.id),
            ('purpose', '=', 'check_in'),
            ('result', '=', 'ok'),
        ], order='id desc')
        place_rows = self.sudo().search([
            ('visit_id', '=', visit.id),
            ('purpose', '=', 'place_order'),
            ('result', '=', 'ok'),
        ], order='id desc')
        if not checkins and not place_rows:
            return self.browse()
        target = checkins[:1] or place_rows[:1]
        latest_place = place_rows[:1]
        vals = {'purpose': 'place_order'}
        if order:
            vals['sale_order_id'] = order.id
        if visit.place_order_latitude or visit.place_order_longitude:
            vals.update({
                'attempt_latitude': visit.place_order_latitude or 0.0,
                'attempt_longitude': visit.place_order_longitude or 0.0,
                'distance_m': visit.place_order_distance_m or 0.0,
            })
        elif latest_place and latest_place != target:
            vals.update({
                'attempt_latitude': latest_place.attempt_latitude,
                'attempt_longitude': latest_place.attempt_longitude,
                'distance_m': latest_place.distance_m,
                'message': latest_place.message,
            })
        target.write(vals)
        (checkins - target).unlink()
        (place_rows - target).unlink()
        return target

    @api.model
    def collapse_placed_order_checkins(self):
        """Merge existing Check-in + Place Order pairs into one Place Order row."""
        visits = self.sudo().search([
            ('result', '=', 'ok'),
            ('purpose', 'in', ('check_in', 'place_order')),
            ('visit_id', '!=', False),
            ('visit_id.visit_kind', '!=', 'delivery_man'),
        ]).mapped('visit_id')
        for visit in visits:
            has_place = self.sudo().search_count([
                ('visit_id', '=', visit.id),
                ('purpose', '=', 'place_order'),
                ('result', '=', 'ok'),
            ])
            if visit.sale_order_id or has_place:
                self.promote_checkin_to_place_order(visit, visit.sale_order_id)
        return True

    @api.model
    def backfill_from_existing_visits(self):
        """Create GPS log rows for visits that predate shahtaj.gps.attempt.

        Shop Check-ins only reads this model, so older successful check-ins
        would otherwise disappear after the GPS update.
        A booker visit that placed an order gets one Place Order row.
        Idempotent: an existing row for that visit is reused, not duplicated.
        """
        Visit = self.env['shahtaj.visit'].sudo()
        limits = {}
        try:
            from .shahtaj_gps import get_shop_distance_limits
            limits = get_shop_distance_limits(self.env) or {}
        except Exception:  # noqa: BLE001
            limits = {}
        min_m = float(limits.get('min_m') or 0.0)
        max_m = float(limits.get('max_m') or 0.0)

        logged_checkin = set(
            self.sudo().search([('purpose', '=', 'check_in'), ('visit_id', '!=', False)]).mapped('visit_id').ids
        )
        logged_place = set(
            self.sudo().search([('purpose', '=', 'place_order'), ('visit_id', '!=', False)]).mapped('visit_id').ids
        )
        visits = Visit.search([], order='id asc')
        created = self.browse()
        for visit in visits:
            try:
                created |= self._backfill_one_visit(
                    visit, logged_checkin, logged_place, min_m, max_m,
                )
            except Exception:  # noqa: BLE001 — one bad visit must not drop the rest
                _logger.exception('GPS backfill skipped visit %s', visit.id)

        created |= self._backfill_visitless_shop_orders(min_m, max_m)
        return created

    def _backfill_one_visit(self, visit, logged_checkin, logged_place, min_m, max_m):
        created = self.browse()
        shop = visit.shop_id.sudo()
        user = visit.order_booker_id
        role = 'order_booker'
        if visit.visit_kind == 'delivery_man' and visit.delivery_man_id:
            user = visit.delivery_man_id
            role = 'delivery_man'
        if not user:
            return created
        company_id = (
            shop.company_id.id
            or user.company_id.id
            or self.env.company.id
        )
        base_vals = {
            'user_id': user.id,
            'role': role,
            'shop_id': shop.id if shop else False,
            'shop_latitude': shop.partner_latitude or 0.0 if shop else 0.0,
            'shop_longitude': shop.partner_longitude or 0.0 if shop else 0.0,
            'min_distance_m': min_m,
            'max_distance_m': max_m,
            'visit_task_id': visit.visit_task_id.id if visit.visit_task_id else False,
            'visit_id': visit.id,
            'sale_order_id': visit.sale_order_id.id if visit.sale_order_id else False,
            'dm_delivery_id': visit.dm_delivery_id.id if visit.dm_delivery_id else False,
            'company_id': company_id,
        }
        booker_order = visit.visit_kind != 'delivery_man' and bool(
            visit.sale_order_id
            or visit.place_order_latitude
            or visit.place_order_longitude
            or visit.id in logged_place
        )
        if booker_order and (visit.id in logged_checkin or visit.id in logged_place):
            self.promote_checkin_to_place_order(visit, visit.sale_order_id)
            return created
        if booker_order:
            rec = self.sudo().create({
                **base_vals,
                'purpose': 'place_order',
                'result': 'ok',
                'attempt_latitude': visit.place_order_latitude or visit.check_in_latitude or 0.0,
                'attempt_longitude': visit.place_order_longitude or visit.check_in_longitude or 0.0,
                'distance_m': visit.place_order_distance_m or visit.check_in_distance_m or 0.0,
                'message': 'Historical place-order (logged before GPS attempt tracking).',
            })
            rec._stamp_create_date(visit.ended_at or visit.started_at)
            created |= rec
            return created
        if visit.id not in logged_checkin:
            rec = self.sudo().create({
                **base_vals,
                'purpose': 'check_in',
                'result': 'ok',
                'attempt_latitude': visit.check_in_latitude or 0.0,
                'attempt_longitude': visit.check_in_longitude or 0.0,
                'distance_m': visit.check_in_distance_m or 0.0,
                'message': 'Historical check-in (logged before GPS attempt tracking).',
            })
            rec._stamp_create_date(visit.started_at)
            created |= rec
        return created

    def _backfill_visitless_shop_orders(self, min_m, max_m):
        """Portal / native shop orders have no visit, so they never got a check-in row."""
        created = self.browse()
        already = set(
            self.sudo().search([('sale_order_id', '!=', False)]).mapped('sale_order_id').ids
        )
        orders = self.env['sale.order'].sudo().search([
            ('partner_id.is_shahtaj_shop', '=', True),
            ('shahtaj_visit_id', '=', False),
        ], order='id asc')
        for order in orders:
            if order.id in already:
                continue
            shop = order.partner_id.sudo()
            user = order.user_id or order.create_uid
            if not user:
                continue
            rec = self.sudo().create({
                'user_id': user.id,
                'role': self._shahtaj_resolve_role(user),
                'purpose': 'check_in',
                'result': 'ok',
                'shop_id': shop.id,
                'shop_latitude': shop.partner_latitude or 0.0,
                'shop_longitude': shop.partner_longitude or 0.0,
                'attempt_latitude': 0.0,
                'attempt_longitude': 0.0,
                'distance_m': 0.0,
                'min_distance_m': min_m,
                'max_distance_m': max_m,
                'sale_order_id': order.id,
                'company_id': order.company_id.id or self.env.company.id,
                'message': 'Order placed without a field check-in (distributor portal / backfill).',
            })
            rec._stamp_create_date(order.date_order or order.create_date)
            already.add(order.id)
            created |= rec
        return created
