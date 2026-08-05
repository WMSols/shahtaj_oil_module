# -*- coding: utf-8 -*-
"""Sales/visit targets per order booker for a date range.

Progress is computed from completed visits and confirmed sale orders.
"""
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

# Only these three target modes are offered to distributors / API.
TARGET_TYPES = [
    ('collective_qty', 'Collective Quantity (multi-product)'),
    ('collective_weight', 'Collective Weight (multi-product)'),
    ('product_bundle', 'Combined Product Targets'),
]

LINE_MEASURE_TYPES = [
    ('qty', 'Quantity'),
    ('weight', 'Weight'),
]

TARGET_WEIGHT_UOMS = [
    ('kg', 'Kilogram (kg)'),
    ('ton', 'Ton'),
]

KG_PER_TON = 1000.0

# Confirmed shop orders only — progress follows booked qty, not delivery.
ORDER_STATES_FOR_TARGET = ('sale', 'done')

PRODUCT_DOMAIN = (
    "[('sale_ok', '=', True), ('active', '=', True), "
    "('product_tmpl_id.active', '=', True), "
    "('default_code', '!=', 'SHAHTAJ-LEGACY')]"
)

COLLECTIVE_TYPES = ('collective_qty', 'collective_weight')
MULTI_PRODUCT_TYPES = ('collective_qty', 'collective_weight', 'product_bundle')
ORDER_BASED_TYPES = MULTI_PRODUCT_TYPES


class ShahtajVisitTarget(models.Model):
    _name = 'shahtaj.visit.target'
    _description = 'Order Booker Target'
    _order = 'date_start desc, order_booker_id'

    name = fields.Char(compute='_compute_name', store=True)
    order_booker_id = fields.Many2one(
        'res.users',
        string='Order Booker',
        required=True,
        index=True,
        ondelete='restrict',
    )
    date_start = fields.Date(string='Period Start', required=True)
    date_end = fields.Date(string='Period End', required=True)
    target_type = fields.Selection(
        TARGET_TYPES,
        string='Target Type',
        required=True,
        default='collective_qty',
    )
    target_value = fields.Float(
        string='Target Value',
        help='Shared goal for Collective Quantity/Weight. For Combined Product Targets '
             'this is treated as 100 (completion) and progress is the average of line %.',
    )
    target_weight_uom = fields.Selection(
        TARGET_WEIGHT_UOMS,
        string='Weight Unit',
        default='kg',
        help='Whether the collective weight goal is expressed in kilograms or tons.',
    )
    product_id = fields.Many2one(
        'product.product',
        string='Product',
        domain=PRODUCT_DOMAIN,
        help='Legacy single-product field (unused). Prefer Products lines.',
    )
    line_ids = fields.One2many(
        'shahtaj.visit.target.line',
        'target_id',
        string='Products',
        copy=True,
    )
    currency_id = fields.Many2one(
        'res.currency',
        string='Currency',
        default=lambda self: self.env.company.currency_id,
    )
    achieved_value = fields.Float(
        string='Achieved',
        compute='_compute_progress',
        store=True,
    )
    remaining_value = fields.Float(
        string='Remaining',
        compute='_compute_progress',
        store=True,
    )
    progress_percent = fields.Float(
        string='Progress %',
        compute='_compute_progress',
        store=True,
        help='0–100. For Combined targets this is the average of individual line percentages.',
    )
    active = fields.Boolean(default=True)

    @api.depends(
        'order_booker_id', 'target_type', 'date_start', 'date_end',
        'product_id', 'line_ids.product_id',
    )
    def _compute_name(self):
        type_labels = dict(TARGET_TYPES)
        for target in self:
            booker = target.order_booker_id.name or '?'
            ttype = type_labels.get(target.target_type, target.target_type or '?')
            if target.target_type in MULTI_PRODUCT_TYPES:
                count = len(target.line_ids)
                target.name = f'{booker} — {ttype} ({count} products)'
            else:
                target.name = f'{booker} — {ttype}'

    @api.constrains(
        'date_start', 'date_end', 'target_value', 'target_type',
        'product_id', 'target_weight_uom', 'line_ids',
    )
    def _check_target(self):
        for target in self:
            if target.date_end < target.date_start:
                raise ValidationError(_('Period end must be on or after period start.'))
            if target.target_type not in MULTI_PRODUCT_TYPES:
                raise ValidationError(_(
                    'Target type must be Collective Quantity, Collective Weight, '
                    'or Combined Product Targets.'
                ))
            if target.target_type == 'product_bundle':
                if not target.line_ids:
                    raise ValidationError(_(
                        'Add at least one product line for Combined Product Targets.'
                    ))
                continue
            if target.target_type in COLLECTIVE_TYPES:
                if not target.line_ids:
                    raise ValidationError(_(
                        'Select at least one product for a collective target.'
                    ))
                if not target.target_value or target.target_value <= 0:
                    raise ValidationError(_('Target value must be greater than zero.'))
                if target.target_type == 'collective_weight' and not target.target_weight_uom:
                    raise ValidationError(_(
                        'Select kg or ton for the collective weight target.'
                    ))

    @api.constrains('product_id', 'target_type')
    def _check_target_product(self):
        # Legacy single-product field is unused; no extra checks.
        return

    @api.model
    def _period_datetime_bounds(self, date_start, date_end):
        """Inclusive calendar dates → datetime window for date_order filters.

        Odoo 19 end-of-day expansion for Date values is skipped on dotted fields
        like order_id.date_order, so we always use an explicit [start, end+1day).
        """
        start_dt = fields.Datetime.to_datetime(date_start)
        end_dt = fields.Datetime.to_datetime(date_end) + timedelta(days=1)
        return start_dt, end_dt

    @api.model
    def _booker_order_domain(self, booker, date_start, date_end):
        """Orders credited to this booker in the period.

        Prefer visit booker / salesperson (`shahtaj_order_booker_id`, `user_id`)
        over `create_uid` (visit place-order often creates via sudo).
        """
        start_dt, end_dt = self._period_datetime_bounds(date_start, date_end)
        return [
            '|',
            ('shahtaj_order_booker_id', '=', booker.id),
            ('user_id', '=', booker.id),
            ('date_order', '>=', start_dt),
            ('date_order', '<', end_dt),
            ('state', 'in', ORDER_STATES_FOR_TARGET),
        ]

    @api.model
    def _sale_order_domain_for_target(self, booker, date_start, date_end):
        return self._booker_order_domain(booker, date_start, date_end)

    @api.model
    def _sale_order_line_domain_for_target(
        self, booker, date_start, date_end, product=None, product_ids=None,
    ):
        """Order lines counted toward product qty/weight targets (ordered, not delivered)."""
        start_dt, end_dt = self._period_datetime_bounds(date_start, date_end)
        domain = [
            '|',
            ('order_id.shahtaj_order_booker_id', '=', booker.id),
            ('order_id.user_id', '=', booker.id),
            ('order_id.date_order', '>=', start_dt),
            ('order_id.date_order', '<', end_dt),
            ('order_id.state', 'in', ORDER_STATES_FOR_TARGET),
            ('display_type', '=', False),
            ('product_id', '!=', False),
            ('product_id.default_code', '!=', 'SHAHTAJ-LEGACY'),
        ]
        if product:
            domain.append(('product_id', '=', product.id))
        elif product_ids is not None:
            domain.append(('product_id', 'in', list(product_ids)))
        return domain

    @api.model
    def _weight_to_kg(self, value, weight_uom):
        if weight_uom == 'ton':
            return value * KG_PER_TON
        return value

    @api.model
    def _kg_to_weight(self, kg_value, weight_uom):
        if weight_uom == 'ton':
            return kg_value / KG_PER_TON
        return kg_value

    def _lines_qty_map(self, product_ids):
        """Return {product_id: ordered_qty} for this target's booker/period."""
        self.ensure_one()
        if not product_ids:
            return {}
        lines = self.env['sale.order.line'].search(
            self._sale_order_line_domain_for_target(
                self.order_booker_id,
                self.date_start,
                self.date_end,
                product_ids=product_ids,
            )
        )
        qty_map = {pid: 0.0 for pid in product_ids}
        for line in lines:
            qty_map[line.product_id.id] = qty_map.get(line.product_id.id, 0.0) + line.product_uom_qty
        return qty_map

    def _lines_weight_kg_map(self, product_ids):
        """Return {product_id: ordered_weight_kg} for this target's booker/period."""
        self.ensure_one()
        if not product_ids:
            return {}
        lines = self.env['sale.order.line'].search(
            self._sale_order_line_domain_for_target(
                self.order_booker_id,
                self.date_start,
                self.date_end,
                product_ids=product_ids,
            )
        )
        kg_map = {pid: 0.0 for pid in product_ids}
        for line in lines:
            kg_per_unit = line.product_id._shahtaj_get_kg_per_unit()
            kg_map[line.product_id.id] = (
                kg_map.get(line.product_id.id, 0.0)
                + line.product_uom_qty * kg_per_unit
            )
        return kg_map

    def _achieved_product_weight_kg(self):
        """Sum ordered weight in kg for this target's single product and period."""
        self.ensure_one()
        if not self.product_id:
            return 0.0
        kg_map = self._lines_weight_kg_map([self.product_id.id])
        return kg_map.get(self.product_id.id, 0.0)

    def _cap_percent(self, value):
        return max(0.0, min(100.0, value))

    @api.depends(
        'target_type', 'target_value', 'target_weight_uom',
        'date_start', 'date_end', 'order_booker_id', 'product_id',
        'line_ids', 'line_ids.product_id', 'line_ids.measure_type',
        'line_ids.target_value', 'line_ids.target_weight_uom',
    )
    def _compute_progress(self):
        """Collective qty/weight shared goal, or Combined average of line %."""
        for target in self:
            achieved = 0.0
            remaining = 0.0
            progress = 0.0
            goal = target.target_value or 0.0

            if target.date_start and target.date_end and target.order_booker_id:
                if target.target_type == 'collective_qty' and target.line_ids:
                    product_ids = target.line_ids.mapped('product_id').ids
                    qty_map = target._lines_qty_map(product_ids)
                    achieved = sum(qty_map.values())
                elif target.target_type == 'collective_weight' and target.line_ids:
                    product_ids = target.line_ids.mapped('product_id').ids
                    kg_map = target._lines_weight_kg_map(product_ids)
                    achieved_kg = sum(kg_map.values())
                    achieved = self._kg_to_weight(
                        achieved_kg, target.target_weight_uom,
                    )
                elif target.target_type == 'product_bundle' and target.line_ids:
                    target.line_ids._compute_line_progress()
                    percents = target.line_ids.mapped('progress_percent')
                    progress = (
                        self._cap_percent(sum(percents) / len(percents))
                        if percents else 0.0
                    )
                    goal = 100.0
                    achieved = progress
                    remaining = max(0.0, 100.0 - progress)
                    target.achieved_value = achieved
                    target.remaining_value = remaining
                    target.progress_percent = progress
                    continue

            target.achieved_value = achieved
            if goal:
                remaining = max(0.0, goal - achieved)
                progress = self._cap_percent((achieved / goal) * 100.0)
            target.remaining_value = remaining
            target.progress_percent = progress

            if target.target_type in MULTI_PRODUCT_TYPES and target.line_ids:
                target.line_ids._compute_line_progress()

    def _force_recompute_progress(self):
        """Force stored progress fields to refresh from current sale orders.

        Progress depends on sale.order / sale.order.line data that is outside
        ``@api.depends``. Calling ``_recompute_recordset()`` alone is a no-op
        unless records are already in ``tocompute`` — so we mark + flush.
        """
        targets = self.exists()
        if not targets:
            return
        fnames = ['achieved_value', 'remaining_value', 'progress_percent']
        lines = targets.mapped('line_ids')
        targets.invalidate_recordset(fnames, flush=False)
        if lines:
            lines.invalidate_recordset(fnames, flush=False)
            for fname in fnames:
                self.env.add_to_compute(lines._fields[fname], lines)
            # Lines first so Combined (product_bundle) parent reads fresh %.
            lines.flush_recordset(fnames)
        for fname in fnames:
            self.env.add_to_compute(targets._fields[fname], targets)
        targets.flush_recordset(fnames)

    @api.model
    def _recompute_for_orders(self, orders):
        """Refresh stored progress when sale orders change."""
        if not orders:
            return
        booker_ids = set()
        dates = []
        for order in orders:
            if order.shahtaj_order_booker_id:
                booker_ids.add(order.shahtaj_order_booker_id.id)
            if order.user_id:
                booker_ids.add(order.user_id.id)
            if order.create_uid:
                booker_ids.add(order.create_uid.id)
            if order.date_order:
                dates.append(fields.Date.to_date(order.date_order))
        if not booker_ids or not dates:
            return
        targets = self.search([
            ('order_booker_id', 'in', list(booker_ids)),
            ('date_start', '<=', max(dates)),
            ('date_end', '>=', min(dates)),
            ('target_type', 'in', ORDER_BASED_TYPES),
        ])
        if targets:
            targets._force_recompute_progress()

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('target_type') == 'product_bundle' and not vals.get('target_value'):
                vals['target_value'] = 100.0
        targets = super().create(vals_list)
        Log = self.env['shahtaj.activity.log']
        for target in targets:
            Log.log_business(
                operation='target.create',
                name='Target created',
                related_record=target,
                message=target.display_name,
            )
        return targets

    def write(self, vals):
        if vals.get('target_type') == 'product_bundle' and not vals.get('target_value'):
            vals = dict(vals, target_value=100.0)
        res = super().write(vals)
        tracked = {
            'order_booker_id', 'date_start', 'date_end', 'target_type',
            'target_value', 'product_id', 'active', 'target_weight_uom',
            'line_ids',
        }
        if tracked.intersection(vals):
            Log = self.env['shahtaj.activity.log']
            for target in self:
                Log.log_business(
                    operation='target.update',
                    name='Target updated',
                    related_record=target,
                    message=', '.join(sorted(tracked.intersection(vals))),
                )
        return res

    def unlink(self):
        snapshot = [(t.id, t.display_name) for t in self]
        res = super().unlink()
        Log = self.env['shahtaj.activity.log']
        for _tid, name in snapshot:
            Log.log_business(
                operation='target.delete',
                name='Target deleted',
                message=name,
            )
        return res


class ShahtajVisitTargetLine(models.Model):
    _name = 'shahtaj.visit.target.line'
    _description = 'Order Booker Target Product Line'
    _order = 'id'

    target_id = fields.Many2one(
        'shahtaj.visit.target',
        string='Target',
        required=True,
        ondelete='cascade',
        index=True,
    )
    product_id = fields.Many2one(
        'product.product',
        string='Product',
        required=True,
        domain=PRODUCT_DOMAIN,
        ondelete='restrict',
    )
    measure_type = fields.Selection(
        LINE_MEASURE_TYPES,
        string='Measure',
        default='qty',
        help='Used for Combined Product Targets. Collective targets ignore this '
             'and use the parent target type.',
    )
    target_value = fields.Float(
        string='Target Value',
        help='Per-product goal for Combined targets. Not used for collective targets.',
    )
    target_weight_uom = fields.Selection(
        TARGET_WEIGHT_UOMS,
        string='Weight Unit',
        default='kg',
    )
    achieved_value = fields.Float(
        string='Achieved',
        compute='_compute_line_progress',
        store=True,
    )
    remaining_value = fields.Float(
        string='Remaining',
        compute='_compute_line_progress',
        store=True,
    )
    progress_percent = fields.Float(
        string='Progress %',
        compute='_compute_line_progress',
        store=True,
    )

    @api.constrains('product_id', 'measure_type', 'target_value', 'target_weight_uom', 'target_id')
    def _check_line(self):
        for line in self:
            product = line.product_id
            if product and (product.default_code == 'SHAHTAJ-LEGACY' or not product.sale_ok):
                raise ValidationError(_(
                    'Select a normal sellable product for target lines.'
                ))
            parent = line.target_id
            if not parent:
                continue
            if parent.target_type == 'product_bundle':
                if not line.measure_type:
                    raise ValidationError(_('Select quantity or weight for each product line.'))
                if not line.target_value or line.target_value <= 0:
                    raise ValidationError(_(
                        'Each product in a Combined target needs a target value greater than zero.'
                    ))
                if line.measure_type == 'weight' and not line.target_weight_uom:
                    raise ValidationError(_(
                        'Select kg or ton for weight lines in a Combined target.'
                    ))
            siblings = parent.line_ids.filtered(
                lambda l: l.product_id == line.product_id and l.id != line.id
            )
            if siblings:
                raise ValidationError(_(
                    'Product "%(product)s" is already on this target.',
                    product=line.product_id.display_name,
                ))

    @api.depends(
        'target_id', 'target_id.target_type', 'target_id.target_value',
        'target_id.target_weight_uom', 'target_id.date_start', 'target_id.date_end',
        'target_id.order_booker_id',
        'product_id', 'measure_type', 'target_value', 'target_weight_uom',
    )
    def _compute_line_progress(self):
        Target = self.env['shahtaj.visit.target']
        # Group by parent to batch SO line searches.
        by_parent = {}
        for line in self:
            by_parent.setdefault(line.target_id, self.env['shahtaj.visit.target.line'])
            by_parent[line.target_id] |= line

        for parent, lines in by_parent.items():
            if not parent or not parent.order_booker_id or not parent.date_start or not parent.date_end:
                for line in lines:
                    line.achieved_value = 0.0
                    line.remaining_value = 0.0
                    line.progress_percent = 0.0
                continue

            product_ids = lines.mapped('product_id').ids
            qty_map = parent._lines_qty_map(product_ids)
            kg_map = parent._lines_weight_kg_map(product_ids)

            for line in lines:
                achieved = 0.0
                goal = 0.0
                if parent.target_type == 'collective_qty':
                    achieved = qty_map.get(line.product_id.id, 0.0)
                    # Informational share only — parent holds the real goal.
                    goal = parent.target_value or 0.0
                elif parent.target_type == 'collective_weight':
                    achieved_kg = kg_map.get(line.product_id.id, 0.0)
                    achieved = Target._kg_to_weight(
                        achieved_kg, parent.target_weight_uom,
                    )
                    goal = parent.target_value or 0.0
                elif parent.target_type == 'product_bundle':
                    goal = line.target_value or 0.0
                    if line.measure_type == 'qty':
                        achieved = qty_map.get(line.product_id.id, 0.0)
                    else:
                        achieved_kg = kg_map.get(line.product_id.id, 0.0)
                        achieved = Target._kg_to_weight(
                            achieved_kg, line.target_weight_uom,
                        )
                else:
                    # Single-product targets normally have no lines.
                    achieved = 0.0
                    goal = 0.0

                line.achieved_value = achieved
                if goal:
                    line.remaining_value = max(0.0, goal - achieved)
                    # Line % always capped 0–100 (contribution share for collective;
                    # completion for bundle lines).
                    line.progress_percent = max(
                        0.0, min(100.0, (achieved / goal) * 100.0),
                    )
                else:
                    line.remaining_value = 0.0
                    line.progress_percent = 0.0
