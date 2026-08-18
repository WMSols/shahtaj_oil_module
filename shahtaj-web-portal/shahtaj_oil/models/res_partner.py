# -*- coding: utf-8 -*-
"""Extend contacts (res.partner) to store retail shops.

Shops belong to one zone and one route. Bookers can register shops (pending approval).
Distributors approve shops and may set legacy balance, which posts to Odoo accounting.
"""
import math

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools import float_is_zero

MAX_REGISTRATION_DISTANCE_M = 100.0

# Let distributor and booker edit credit fields without full Invoicing app rights.
_SHAHTAJ_CREDIT_GROUPS = (
    'account.group_account_invoice,account.group_account_readonly,'
    'shahtaj_oil.group_shahtaj_distributor,'
    'shahtaj_oil.group_shahtaj_order_booker'
)


class ResPartner(models.Model):
    _name = 'res.partner'
    _inherit = ['res.partner', 'shahtaj.territory.sync.mixin']

    def name_get(self):
        """Short labels in route shop checklists so long names do not hide checkboxes."""
        if self.env.context.get('shahtaj_route_checklist'):
            result = []
            for partner in self:
                label = partner.name or partner.display_name or ''
                if len(label) > 48:
                    label = label[:45].rstrip() + '...'
                result.append((partner.id, label))
            return result
        return super().name_get()

    def _check_access(self, operation):
        """Let distributors read company partners required by accounting screens."""
        result = super()._check_access(operation)
        if (
            result is not None
            and operation == 'read'
            and not self.env.su
            and self.env.user.has_group(
                'shahtaj_oil.group_shahtaj_distributor',
            )
        ):
            forbidden, make_error = result
            allowed_company_partners = (
                self.env.user.company_ids.partner_id
                | self.env.company.partner_id
            )
            forbidden = forbidden - allowed_company_partners
            if not forbidden:
                return None
            return forbidden, make_error
        return result

    # --- Shop identity and territory (one shop → one route) ---
    credit_limit = fields.Float(groups=_SHAHTAJ_CREDIT_GROUPS)
    use_partner_credit_limit = fields.Boolean(groups=_SHAHTAJ_CREDIT_GROUPS)
    shahtaj_shop_category = fields.Selection(
        [
            ('credit', 'Credit'),
            ('cash', 'Cash'),
        ],
        string='Shop Category',
        default='credit',
        required=True,
        help='Credit shops enforce the credit limit on field orders. '
             'Cash shops skip credit limit checks when placing orders.',
    )

    is_shahtaj_shop = fields.Boolean(string='Is Shop')
    shop_approval_state = fields.Selection(
        [
            ('pending', 'Pending'),
            ('approved', 'Approved'),
            ('rejected', 'Rejected'),
        ],
        string='Shop Approval',
        default='pending',
    )
    owner_name = fields.Char(string='Owner Name')
    owner_phone = fields.Char(string='Owner Phone')
    owner_cnic_number = fields.Char(string='Owner ID Card Number')
    shop_license_number = fields.Char(
        string='License Number',
        help='Shop trade / business license number (optional).',
    )
    zone_id = fields.Many2one(
        'shahtaj.zone',
        string='Zone',
        ondelete='set null',
        domain=lambda self: [('id', 'in', self._get_allowed_zone_ids())],
        help='Display / primary zone (from primary route). '
             'Shop↔route links are the source of truth.',
    )
    # Legacy single-route field kept in sync with route_ids for existing UI.
    route_id = fields.Many2one(
        'shahtaj.route',
        string='Route',
        ondelete='set null',
        domain="[('id', 'in', allowed_route_ids)]",
        index=True,
        help='Primary route for display. Full membership is in Routes.',
    )
    # Source of truth: shop may belong to many routes (cross-zone allowed).
    route_ids = fields.Many2many(
        'shahtaj.route',
        'shahtaj_shop_route_rel',
        'shop_id',
        'route_id',
        string='Routes',
        domain=[('active', '=', True)],
    )
    shahtaj_routes_display = fields.Char(
        string='Zones / Routes',
        compute='_compute_shahtaj_routes_display',
        help='Read-only summary of assigned zones and routes.',
    )
    registered_by_id = fields.Many2one(
        'res.users',
        string='Registered By User',
        readonly=True,
        copy=False,
    )
    # Inverse of visit tasks — used by booker partner record rules so assigned
    # shops stay readable even if the weekly schedule row was later removed.
    shahtaj_visit_task_ids = fields.One2many(
        'shahtaj.visit.task',
        'shop_id',
        string='Visit Tasks',
        copy=False,
    )
    registered_by_name = fields.Char(
        related='registered_by_id.name',
        string='Registered By',
        store=True,
        readonly=True,
    )
    registered_by_booker_id = fields.Integer(
        related='registered_by_id.id',
        string='Registered By Booker ID',
        store=True,
        readonly=True,
    )
    legacy_balance = fields.Monetary(
        string='Legacy Balance',
        currency_field='currency_id',
        help='Previous amount the shop already owed before this system. '
             'When the shop is approved, a customer invoice is created so you can '
             'collect payment against it (Register Payment).',
    )
    legacy_balance_move_id = fields.Many2one(
        'account.move',
        string='Legacy Balance Invoice',
        readonly=True,
        copy=False,
        ondelete='restrict',
    )
    outstanding_balance = fields.Monetary(
        string='Outstanding Balance',
        compute='_compute_outstanding_balance',
        currency_field='currency_id',
        help='Total receivable from accounting (includes legacy balance once posted).',
    )
    owner_cnic_front = fields.Image(string='Owner CNIC Front', max_width=1920, max_height=1920)
    owner_cnic_back = fields.Image(string='Owner CNIC Back', max_width=1920, max_height=1920)
    owner_photo = fields.Image(string='Owner Photo', max_width=1920, max_height=1920)
    shop_exterior_photo = fields.Image(string='Shop Exterior Photo', max_width=1920, max_height=1920)
    # First on-site visit by order booker locks GPS / field profile.
    shahtaj_field_verified = fields.Boolean(
        string='Field Verified',
        default=False,
        copy=False,
        index=True,
        help='False until an order booker completes first-visit setup '
             '(GPS + shop exterior photo) at the shop. Distributor-entered '
             'GPS alone does not verify the shop.',
    )
    shahtaj_field_verified_at = fields.Datetime(
        string='Field Verified At',
        readonly=True,
        copy=False,
    )
    shahtaj_field_verified_by_id = fields.Many2one(
        'res.users',
        string='Field Verified By',
        readonly=True,
        copy=False,
        ondelete='set null',
    )
    shahtaj_visit_tag = fields.Selection(
        [
            ('not_visited', 'Not Visited'),
            ('visited', 'Visited'),
        ],
        string='Visit Tag',
        compute='_compute_shahtaj_visit_tag',
        store=True,
        index=True,
    )
    shahtaj_route_tag = fields.Selection(
        [
            ('unassigned', 'Unassigned'),
            ('assigned', 'Assigned'),
        ],
        string='Route Tag',
        compute='_compute_shahtaj_route_tag',
        store=True,
        index=True,
        help='Unassigned = no route; Assigned = linked to a sales route.',
    )
    allowed_zone_ids = fields.Many2many(
        'shahtaj.zone',
        compute='_compute_allowed_zones_routes',
    )
    allowed_route_ids = fields.Many2many(
        'shahtaj.route',
        compute='_compute_allowed_zones_routes',
    )

    @api.depends('shahtaj_field_verified')
    def _compute_shahtaj_visit_tag(self):
        for partner in self:
            if partner.is_shahtaj_shop and partner.shahtaj_field_verified:
                partner.shahtaj_visit_tag = 'visited'
            elif partner.is_shahtaj_shop:
                partner.shahtaj_visit_tag = 'not_visited'
            else:
                partner.shahtaj_visit_tag = False

    @api.depends('is_shahtaj_shop', 'route_ids')
    def _compute_shahtaj_route_tag(self):
        for partner in self:
            if not partner.is_shahtaj_shop:
                partner.shahtaj_route_tag = False
            elif partner.route_ids:
                partner.shahtaj_route_tag = 'assigned'
            else:
                partner.shahtaj_route_tag = 'unassigned'

    @api.depends(
        'route_ids',
        'route_ids.name',
        'route_ids.zone_id',
        'route_ids.zone_id.name',
    )
    def _compute_shahtaj_routes_display(self):
        for partner in self:
            if not partner.route_ids:
                partner.shahtaj_routes_display = False
                continue
            parts = []
            for route in partner.route_ids.sorted(lambda r: (r.zone_id.name or '', r.name or '')):
                zone = route.zone_id.name or '?'
                parts.append(f'{zone} → {route.name}')
            partner.shahtaj_routes_display = ', '.join(parts)

    # --- Zone/route dropdowns on shop forms (all active records for bookers) ---
    @api.model
    def _get_allowed_zone_ids(self):
        return self.env['shahtaj.zone'].search([('active', '=', True)]).ids

    @api.model
    def _get_allowed_route_ids(self, zone_id=None):
        domain = [('active', '=', True)]
        if zone_id:
            domain.append(('zone_id', '=', zone_id))
            zone = self.env['shahtaj.zone'].browse(zone_id).exists()
            if not zone or not zone.active:
                return []
        return self.env['shahtaj.route'].search(domain).ids

    def _shahtaj_is_operational_for_booker(self):
        """Shop is usable when active, approved, and on at least one live route."""
        self.ensure_one()
        if not self.is_shahtaj_shop:
            return False
        partner = self.with_context(active_test=False)
        if not partner.active:
            return False
        if partner.shop_approval_state != 'approved':
            return False
        routes = partner.route_ids.with_context(active_test=False)
        return any(route._shahtaj_is_operational_for_booker() for route in routes)

    def get_archive_impact(self):
        self.ensure_one()
        if not self.is_shahtaj_shop:
            return {'pending_task_count': 0}
        pending_tasks = self.env['shahtaj.visit.task'].search_count([
            ('shop_id', '=', self.id),
            ('state', '=', 'pending'),
        ])
        return {'pending_task_count': pending_tasks}

    def _validate_operational_territory_assignment(self):
        for partner in self.filtered('is_shahtaj_shop'):
            for route in partner.route_ids:
                if not route._shahtaj_is_operational_for_booker():
                    raise ValidationError(_(
                        'Route "%(route)s" is archived or its zone is inactive.',
                        route=route.display_name,
                    ))
            if partner.zone_id and not partner.zone_id.active:
                raise ValidationError(_(
                    'Zone "%(zone)s" is archived.',
                    zone=partner.zone_id.display_name,
                ))

    def _sync_visit_tasks_after_territory_restore(self):
        Task = self.env['shahtaj.visit.task']
        for partner in self.filtered('is_shahtaj_shop'):
            if not partner._shahtaj_is_operational_for_booker():
                continue
            bookers = partner.route_ids.mapped('weekly_schedule_ids.order_booker_id')
            partner._reactivate_cancelled_visit_tasks(bookers=bookers)
            if bookers:
                for booker in bookers:
                    Task._auto_generate_window(order_booker=booker)
            else:
                Task._auto_generate_window()

    def _shahtaj_sync_primary_route_from_route_ids(self):
        """Keep route_id / zone_id aligned with route_ids for existing UI."""
        for partner in self.filtered('is_shahtaj_shop'):
            routes = partner.route_ids
            if partner.route_id in routes:
                primary = partner.route_id
            elif routes:
                primary = routes.sorted('id')[:1]
            else:
                primary = self.env['shahtaj.route']
            vals = {}
            primary_id = primary.id if primary else False
            if partner.route_id.id != primary_id:
                vals['route_id'] = primary_id
            if primary and partner.zone_id != primary.zone_id:
                vals['zone_id'] = primary.zone_id.id
            if vals:
                partner.with_context(shahtaj_skip_route_m2m_sync=True).write(vals)

    def _shahtaj_vals_mirror_route_id_to_route_ids(self, vals):
        """Legacy primary route_id write → add to route_ids (never wipe others).

        Clearing route_id alone does not clear M2M membership; primary is
        re-synced from remaining route_ids after write.
        """
        if self.env.context.get('shahtaj_skip_route_m2m_sync'):
            return vals
        if 'route_ids' in vals:
            return vals
        if 'route_id' not in vals:
            return vals
        vals = dict(vals)
        new_route_id = vals.get('route_id') or False
        if new_route_id:
            route = self.env['shahtaj.route'].browse(new_route_id).exists()
            if route:
                vals['zone_id'] = route.zone_id.id
            # Add only — do not (6,0,[…]) replace other route memberships.
            vals['route_ids'] = [(4, new_route_id)]
        return vals

    @api.depends('zone_id')
    @api.depends_context('uid')
    def _compute_allowed_zones_routes(self):
        zone_ids = self._get_allowed_zone_ids()
        zones = self.env['shahtaj.zone'].browse(zone_ids)
        for partner in self:
            partner.allowed_zone_ids = zones
            zone_id = partner.zone_id.id if partner.zone_id else None
            route_ids = self._get_allowed_route_ids(zone_id=zone_id)
            partner.allowed_route_ids = self.env['shahtaj.route'].browse(route_ids)

    @api.depends('legacy_balance_move_id')
    def _compute_outstanding_balance(self):
        # Standard Odoo receivable balance for this customer (shop).
        for partner in self:
            partner.outstanding_balance = partner.sudo().credit

    @api.onchange('zone_id')
    def _onchange_zone_id(self):
        if self.route_id and self.route_id.zone_id != self.zone_id:
            self.route_id = False
        route_ids = self._get_allowed_route_ids(
            zone_id=self.zone_id.id if self.zone_id else None,
        )
        return {'domain': {'route_id': [('id', 'in', route_ids)]}}

    @api.onchange('route_id')
    def _onchange_route_id(self):
        if self.route_id:
            self.zone_id = self.route_id.zone_id

    @api.onchange('owner_phone')
    def _onchange_owner_phone(self):
        if self.owner_phone:
            self.phone = self.owner_phone

    @api.onchange('shahtaj_shop_category')
    def _onchange_shahtaj_shop_category(self):
        if self.shahtaj_shop_category == 'cash':
            self.use_partner_credit_limit = False
        elif self.shahtaj_shop_category == 'credit' and self.credit_limit > 0:
            self.use_partner_credit_limit = True

    @api.onchange('credit_limit', 'shahtaj_shop_category')
    def _onchange_credit_limit_shop_category(self):
        if self.shahtaj_shop_category == 'credit' and self.credit_limit > 0:
            self.use_partner_credit_limit = True

    @api.model
    def _sync_shop_category_credit_flags(self, vals):
        """Keep Odoo credit-limit flag aligned with shop category."""
        vals = dict(vals)
        category = vals.get('shahtaj_shop_category')
        if category == 'cash':
            vals['use_partner_credit_limit'] = False
        elif category == 'credit' and vals.get('credit_limit', 0) > 0:
            vals['use_partner_credit_limit'] = True
        elif category == 'credit' and 'credit_limit' not in vals:
            pass
        elif vals.get('credit_limit', 0) > 0 and category != 'cash':
            vals['use_partner_credit_limit'] = True
        return vals

    @api.constrains('route_id', 'zone_id', 'is_shahtaj_shop')
    def _check_shop_route_zone(self):
        # Primary route_id must match display zone_id (route_ids may cross zones).
        for partner in self.filtered(lambda p: p.is_shahtaj_shop and p.route_id):
            if partner.zone_id and partner.route_id.zone_id != partner.zone_id:
                raise ValidationError(_(
                    'Route "%(route)s" does not belong to zone "%(zone)s".',
                    route=partner.route_id.name,
                    zone=partner.zone_id.name,
                ))

    @api.constrains('partner_latitude', 'partner_longitude')
    def _check_shop_gps_range(self):
        for partner in self.filtered('is_shahtaj_shop'):
            if partner.partner_latitude and not (-90 <= partner.partner_latitude <= 90):
                raise ValidationError(_('GPS latitude must be between -90 and 90.'))
            if partner.partner_longitude and not (-180 <= partner.partner_longitude <= 180):
                raise ValidationError(_('GPS longitude must be between -180 and 180.'))

    @api.model
    def _distance_meters(self, lat1, lon1, lat2, lon2):
        radius = 6371000.0
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlambda = math.radians(lon2 - lon1)
        a = (
            math.sin(dphi / 2) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
        )
        return 2 * radius * math.asin(math.sqrt(a))

    def _validate_shop_required_fields(self):
        """Shop name is the only create/write hard requirement.

        Owner name/phone/CNIC and GPS stay optional for distributors until
        first-visit verification (or booker on-site register) fills them in.
        """
        for partner in self.filtered('is_shahtaj_shop'):
            if not partner.name:
                raise ValidationError(_('Shop name is required.'))
            # GPS only mandatory once the shop is field-verified (or being verified).
            if partner.shahtaj_field_verified:
                if not partner.partner_latitude or not partner.partner_longitude:
                    raise ValidationError(_(
                        'Field-verified shops must have GPS latitude and longitude.'
                    ))
            elif partner.partner_latitude or partner.partner_longitude:
                # If one coordinate is set, both must be valid.
                if not partner.partner_latitude or not partner.partner_longitude:
                    raise ValidationError(_(
                        'Provide both GPS latitude and longitude, or leave both empty '
                        'until the order booker verifies the shop on site.'
                    ))

    def _prepare_shop_vals(self, vals):
        """Set defaults when creating a shop from distributor, portal, or booker API."""
        vals = dict(vals)
        if self.env.context.get('res_partner_search_mode') == 'supplier':
            vals['is_shahtaj_shop'] = False
            return vals
        is_shop_create = (
            vals.get('is_shahtaj_shop')
            or self.env.context.get('shahtaj_shop_form')
            or self.env.context.get('shahtaj_shop_register')
        )
        if is_shop_create:
            vals.setdefault('is_shahtaj_shop', True)
            vals.setdefault('shahtaj_shop_category', 'credit')
            vals.setdefault('company_type', 'company')
            vals.setdefault('customer_rank', 1)
            if vals.get('owner_phone'):
                vals.setdefault('phone', vals['owner_phone'])
            if self.env.context.get('shahtaj_shop_register') or (
                vals.get('shop_approval_state') == 'pending'
                and self.env.user.has_group(
                    'shahtaj_oil.group_shahtaj_order_booker',
                )
                and not self.env.user.has_group(
                    'shahtaj_oil.group_shahtaj_distributor',
                )
            ):
                vals.setdefault('shop_approval_state', 'pending')
                vals.setdefault('registered_by_id', self.env.user.id)
            elif self.env.context.get('default_shop_approval_state'):
                vals.setdefault(
                    'shop_approval_state',
                    self.env.context['default_shop_approval_state'],
                )
            vals = self._sync_shop_category_credit_flags(vals)
        # Mirror single route_id into route_ids on create (legacy UI / API).
        if vals.get('route_id') and 'route_ids' not in vals:
            rid = vals['route_id']
            vals['route_ids'] = [(6, 0, [rid])]
            route = self.env['shahtaj.route'].browse(rid).exists()
            if route:
                vals.setdefault('zone_id', route.zone_id.id)
        return vals

    def _get_shop_receivable_account(self, company):
        """Resolve receivable for a shop: partner property, then company defaults / CoA."""
        self.ensure_one()
        partner = self.with_company(company)
        receivable = partner.sudo().property_account_receivable_id
        if not receivable:
            receivable = self.env['res.partner']._fields[
                'property_account_receivable_id'
            ].get_company_dependent_fallback(partner.sudo())
        if not receivable:
            receivable = company.sudo().partner_id.with_company(
                company
            ).property_account_receivable_id
        if not receivable:
            receivable = self.env['account.account'].sudo().search([
                ('company_ids', 'in', company.id),
                ('account_type', '=', 'asset_receivable'),
                ('active', '=', True),
            ], limit=1)
        if receivable and not partner.property_account_receivable_id:
            partner.sudo().property_account_receivable_id = receivable
        return receivable

    def _get_legacy_balance_income_account(self, company):
        """Income account for opening-balance invoice lines (no product)."""
        self.ensure_one()
        Account = self.env['account.account'].sudo()
        category = self.env['product.template']._get_shahtaj_default_category()
        if category and category.property_account_income_categ_id:
            return category.property_account_income_categ_id
        income = Account.search([
            ('company_ids', 'in', company.id),
            ('account_type', '=', 'income'),
            ('active', '=', True),
        ], limit=1)
        if not income:
            raise UserError(_(
                'No income account found. Install the chart of accounts '
                'before setting legacy balance.'
            ))
        return income

    def _post_legacy_balance_entry(self):
        """Create and post a customer invoice for previous shop debt (no product).

        Line is description + amount on an income account so distributors can
        Register Payment without a confusing catalog product.
        """
        AccountMove = self.env['account.move'].sudo()
        AccountJournal = self.env['account.journal'].sudo()
        for partner in self.filtered(
            lambda p: p.is_shahtaj_shop
            and p.shop_approval_state == 'approved'
            and p.legacy_balance
            and not p.legacy_balance_move_id
        ):
            company = partner.company_id or self.env.company
            partner = partner.with_company(company)
            currency = partner.currency_id or company.currency_id
            if float_is_zero(
                partner.legacy_balance,
                precision_rounding=currency.rounding,
            ):
                continue
            partner._get_shop_receivable_account(company)
            journal = AccountJournal.search([
                ('type', '=', 'sale'),
                ('company_id', '=', company.id),
            ], limit=1)
            if not journal:
                raise UserError(_(
                    'No Sales journal found. Install accounting / chart of accounts '
                    'before setting legacy balance.'
                ))
            income_account = partner._get_legacy_balance_income_account(company)
            move = AccountMove.create({
                'move_type': 'out_invoice',
                'partner_id': partner.id,
                'journal_id': journal.id,
                'invoice_date': fields.Date.context_today(self),
                'invoice_origin': _('Legacy balance'),
                'ref': _('Legacy shop balance: %s', partner.name),
                'shahtaj_is_legacy_balance': True,
                'invoice_line_ids': [(0, 0, {
                    'name': _('Opening / Legacy Balance — %s', partner.name),
                    'quantity': 1.0,
                    'price_unit': partner.legacy_balance,
                    'tax_ids': [(5, 0, 0)],
                    'account_id': income_account.id,
                })],
            })
            move.action_post()
            partner.with_context(shahtaj_posting_legacy_move=True).write({
                'legacy_balance_move_id': move.id,
            })

    @api.model_create_multi
    def create(self, vals_list):
        prepared = [
            self._shahtaj_strip_distributor_exterior_photo(
                self._prepare_shop_vals(vals)
            )
            for vals in vals_list
        ]
        # Booker on-site registration: GPS + exterior + CNIC required → Visited.
        for vals in prepared:
            if vals.get('is_shahtaj_shop') and self.env.context.get('shahtaj_shop_register'):
                self._shahtaj_validate_booker_onsite_register_vals(vals)
                if (
                    vals.get('partner_latitude')
                    and vals.get('partner_longitude')
                    and not vals.get('shahtaj_field_verified')
                ):
                    vals['shahtaj_field_verified'] = True
                    vals['shahtaj_field_verified_at'] = fields.Datetime.now()
                    vals['shahtaj_field_verified_by_id'] = self.env.user.id
        partners = super().create(prepared)
        shop_partners = partners.filtered('is_shahtaj_shop')
        # Ensure primary route_id/zone_id match route_ids after create.
        need_primary = shop_partners.filtered(
            lambda p: p.route_ids and (
                not p.route_id or p.route_id not in p.route_ids
            )
        )
        if need_primary:
            need_primary._shahtaj_sync_primary_route_from_route_ids()
        shop_partners._validate_shop_required_fields()
        shop_partners._validate_operational_territory_assignment()
        shop_partners.filtered(
            lambda p: p.shop_approval_state == 'approved'
        )._post_legacy_balance_entry()
        Log = self.env['shahtaj.activity.log']
        for shop in shop_partners:
            Log.log_business(
                operation='shop.create',
                name='Shop created',
                related_record=shop,
                message=shop.display_name,
            )
        return partners

    def write(self, vals):
        if vals.get('active') is True:
            for partner in self.filtered('is_shahtaj_shop'):
                # Prefer any linked route; fall back to primary route_id.
                routes = partner.route_ids.with_context(active_test=False)
                if not routes and partner.route_id:
                    routes = partner.route_id.with_context(active_test=False)
                inactive = routes.filtered(
                    lambda r: not r.active or (
                        r.zone_id and not r.zone_id.with_context(active_test=False).active
                    ),
                )
                # Block restore only when every linked route/zone is archived
                # and at least one link exists.
                if routes and len(inactive) == len(routes):
                    bad = inactive[:1]
                    self._shahtaj_raise_restore_parent_error(
                        _('shop'),
                        bad.display_name,
                    )
        vals = self._sync_shop_category_credit_flags(vals)
        vals = self._shahtaj_strip_distributor_exterior_photo(vals)
        if vals.get('owner_phone'):
            vals.setdefault('phone', vals['owner_phone'])
        vals = self._shahtaj_vals_mirror_route_id_to_route_ids(vals)
        if 'route_ids' in vals and not self.env.context.get('shahtaj_skip_route_m2m_sync'):
            # Block membership changes while a visit is in progress.
            self._shahtaj_assert_can_change_route_membership(vals.get('route_ids'))
        elif 'route_id' in vals and not self.env.context.get('shahtaj_skip_route_m2m_sync'):
            self._shahtaj_assert_can_change_route(vals.get('route_id'))
        if vals.get('legacy_balance_move_id') and not self.env.context.get(
            'shahtaj_posting_legacy_move'
        ):
            raise UserError(_('Legacy balance invoice cannot be changed manually.'))
        old_routes_by_shop = {}
        if (
            'route_ids' in vals
            and not self.env.context.get('shahtaj_skip_route_m2m_sync')
        ):
            old_routes_by_shop = {
                p.id: set(p.route_ids.ids)
                for p in self.filtered('is_shahtaj_shop')
            }
        res = super().write(vals)
        if vals.get('active') is False:
            shops = self.filtered('is_shahtaj_shop')
            if shops:
                today = fields.Date.context_today(self)
                self._shahtaj_cancel_pending_tasks_for_shops(
                    shops.ids,
                    date_from=today,
                )
        if vals.get('active') is True:
            self.filtered('is_shahtaj_shop')._sync_visit_tasks_after_territory_restore()
        if (
            'route_ids' in vals
            and not self.env.context.get('shahtaj_skip_route_m2m_sync')
        ):
            shops = self.filtered('is_shahtaj_shop')
            shops._shahtaj_sync_primary_route_from_route_ids()
            shops._validate_operational_territory_assignment()
            removed_by_shop = {
                shop.id: (
                    old_routes_by_shop.get(shop.id, set()) - set(shop.route_ids.ids)
                )
                for shop in shops
            }
            shops._sync_visit_tasks_after_route_assignment(
                removed_route_ids_by_shop=removed_by_shop,
            )
        elif (
            any(k in vals for k in ('route_id', 'zone_id'))
            and not self.env.context.get('shahtaj_skip_route_m2m_sync')
        ):
            shops = self.filtered('is_shahtaj_shop')
            # Primary is display-only when cleared/changed without explicit M2M;
            # keep it aligned with remaining route_ids.
            if 'route_id' in vals:
                shops._shahtaj_sync_primary_route_from_route_ids()
            shops._validate_operational_territory_assignment()
        if 'shahtaj_shop_category' in vals:
            credit_shops = self.filtered(
                lambda p: p.is_shahtaj_shop
                and p.shahtaj_shop_category == 'credit'
                and p.credit_limit > 0
                and not p.use_partner_credit_limit
            )
            if credit_shops:
                super(ResPartner, credit_shops).write({
                    'use_partner_credit_limit': True,
                })
        if any(k in vals for k in (
            'is_shahtaj_shop', 'name', 'partner_latitude', 'partner_longitude',
            'shahtaj_field_verified',
        )):
            self.filtered('is_shahtaj_shop')._validate_shop_required_fields()
        if 'legacy_balance' in vals:
            self.filtered(
                lambda p: p.shop_approval_state == 'approved' and not p.legacy_balance_move_id
            )._post_legacy_balance_entry()
        if 'shop_approval_state' in vals:
            self.filtered('is_shahtaj_shop')._sync_visit_tasks_after_approval_change()
        shops = self.filtered('is_shahtaj_shop')
        if shops:
            Log = self.env['shahtaj.activity.log']
            tracked = {
                'active', 'name', 'route_id', 'route_ids', 'zone_id', 'credit_limit',
                'shahtaj_shop_category', 'owner_name', 'owner_phone',
                'owner_cnic_number', 'shop_license_number',
            }
            if tracked.intersection(vals) and not self.env.context.get(
                'shahtaj_posting_legacy_move'
            ):
                for shop in shops:
                    Log.log_business(
                        operation='shop.update',
                        name='Shop updated',
                        related_record=shop,
                        message=', '.join(sorted(tracked.intersection(vals))),
                    )
        return res

    def _sync_visit_tasks_after_route_assignment(self, removed_route_ids_by_shop=None):
        """Rebuild pending visit tasks after shops move to/from routes.

        When ``removed_route_ids_by_shop`` is provided, only pending tasks for
        those shop+route pairs are cancelled (sibling routes stay intact).
        """
        Task = self.env['shahtaj.visit.task']
        shops = self.filtered('is_shahtaj_shop')
        if not shops:
            return
        today = fields.Date.context_today(self)
        if removed_route_ids_by_shop is not None:
            for shop in shops:
                removed = list(removed_route_ids_by_shop.get(shop.id) or ())
                if removed:
                    self._shahtaj_cancel_pending_tasks_for_shop_routes(
                        [shop.id], removed, date_from=today,
                    )
        else:
            self._shahtaj_cancel_pending_tasks_for_shops(
                shops.ids, date_from=today,
            )
        bookers = self.env['res.users']
        for partner in shops:
            if not partner._shahtaj_is_operational_for_booker():
                continue
            bookers |= partner.route_ids.mapped('weekly_schedule_ids.order_booker_id')
        # Also regenerate for bookers of routes the shop left (orphan cleanup).
        if removed_route_ids_by_shop:
            removed_all = set()
            for ids in removed_route_ids_by_shop.values():
                removed_all.update(ids)
            if removed_all:
                bookers |= self.env['shahtaj.route'].browse(
                    list(removed_all),
                ).mapped('weekly_schedule_ids.order_booker_id')
        if bookers:
            for booker in bookers:
                Task._auto_generate_window(order_booker=booker)
        elif shops.filtered(lambda s: s._shahtaj_is_operational_for_booker()):
            Task._auto_generate_window()

    def action_shahtaj_open_assign_to_route(self):
        """List/form action: assign selected shops to a route."""
        shops = self.filtered(lambda p: p.is_shahtaj_shop and p.active)
        if not shops:
            raise UserError(_('Select one or more shops to assign.'))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Assign Shops to Route'),
            'res_model': 'shahtaj.assign.shops.route.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'active_model': 'res.partner',
                'active_ids': shops.ids,
                'active_id': shops[0].id,
                'default_shop_ids': [(6, 0, shops.ids)],
                'default_only_unassigned': False,
            },
        }

    def _shahtaj_shops_with_open_visit(self):
        """Shops that currently have an in-progress field visit."""
        shops = self.filtered('is_shahtaj_shop')
        if not shops:
            return shops
        return self.env['shahtaj.visit'].search([
            ('shop_id', 'in', shops.ids),
            ('state', '=', 'in_progress'),
        ]).mapped('shop_id')

    def _shahtaj_assert_can_change_route(self, new_route_id):
        """Block route changes while a visit is in progress on the shop."""
        shops = self.filtered('is_shahtaj_shop')
        if not shops:
            return
        changing = shops.filtered(
            lambda s: (s.route_id.id or False) != (new_route_id or False),
        )
        blocked = changing._shahtaj_shops_with_open_visit()
        if blocked:
            raise UserError(_(
                'Cannot change route for shop(s) with an in-progress visit: %(shops)s. '
                'Finish or cancel the visit first.',
                shops=', '.join(blocked.mapped('display_name')),
            ))

    def _shahtaj_assert_can_change_route_membership(self, commands):
        """Block route_ids changes while a visit is in progress."""
        shops = self.filtered('is_shahtaj_shop')
        blocked = shops._shahtaj_shops_with_open_visit()
        if blocked and commands is not None:
            raise UserError(_(
                'Cannot change routes for shop(s) with an in-progress visit: %(shops)s. '
                'Finish or cancel the visit first.',
                shops=', '.join(blocked.mapped('display_name')),
            ))

    def action_shahtaj_unassign_route(self):
        """Clear all route assignments (shop stays; no visit tasks until reassigned)."""
        shops = self.filtered(lambda p: p.is_shahtaj_shop and p.route_ids)
        if not shops:
            raise UserError(_('No route to remove on the selected shop(s).'))
        shops.write({'route_ids': [(5, 0, 0)]})
        return True

    def _sync_visit_tasks_after_approval_change(self):
        """Cancel tasks for unapproved shops; generate tasks when a shop is approved."""
        Task = self.env['shahtaj.visit.task']
        for partner in self:
            if partner.shop_approval_state != 'approved':
                Task._cancel_pending_tasks_for_unapproved_shops()
                continue
            bookers = partner.route_ids.mapped('weekly_schedule_ids.order_booker_id')
            partner._reactivate_cancelled_visit_tasks(bookers=bookers)
            if bookers:
                for booker in bookers:
                    Task._auto_generate_window(order_booker=booker)
            else:
                Task._auto_generate_window()

    def _reactivate_cancelled_visit_tasks(self, bookers=None):
        """Restore cancelled tasks after a shop is approved again."""
        self.ensure_one()
        if self.shop_approval_state != 'approved':
            return
        Task = self.env['shahtaj.visit.task']
        domain = [
            ('shop_id', '=', self.id),
            ('state', '=', 'cancelled'),
        ]
        if bookers:
            domain.append(('order_booker_id', 'in', bookers.ids))
        cancelled = Task.search(domain)
        if cancelled:
            cancelled.with_context(shahtaj_system_visit_write=True).write({
                'state': 'pending',
            })

    def action_approve_shop(self):
        """Distributor approves a pending shop; posts legacy balance if set."""
        pending = self.filtered(lambda p: p.shop_approval_state != 'approved')
        for partner in pending:
            company = partner.company_id or self.env.company
            if partner.legacy_balance and not float_is_zero(
                partner.legacy_balance,
                precision_rounding=(partner.currency_id or company.currency_id).rounding,
            ):
                partner._get_shop_receivable_account(company)
        pending.write({'shop_approval_state': 'approved', 'is_shahtaj_shop': True})
        pending._post_legacy_balance_entry()
        Log = self.env['shahtaj.activity.log']
        for shop in pending:
            Log.log_business(
                operation='shop.approve',
                name='Shop approved',
                related_record=shop,
                message=shop.display_name,
            )

    def action_reject_shop(self):
        self.write({'shop_approval_state': 'rejected'})
        Log = self.env['shahtaj.activity.log']
        for shop in self.filtered('is_shahtaj_shop'):
            Log.log_business(
                operation='shop.reject',
                name='Shop rejected',
                related_record=shop,
                message=shop.display_name,
            )

    def action_view_legacy_balance_move(self):
        self.ensure_one()
        if not self.legacy_balance_move_id:
            raise UserError(_('No legacy balance invoice exists for this shop.'))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Legacy Balance Invoice'),
            'res_model': 'account.move',
            'res_id': self.legacy_balance_move_id.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def action_shahtaj_view_sale_orders(self):
        """Open sales orders for this shop."""
        self.ensure_one()
        action = self.env['ir.actions.actions']._for_xml_id('sale.action_orders')
        action['domain'] = [('partner_id', 'child_of', self.ids)]
        action['context'] = {
            **self.env.context,
            'default_partner_id': self.id,
            'search_default_partner_id': self.id,
        }
        return action

    def action_shahtaj_view_customer_payments(self):
        """Open customer payments recorded for this shop."""
        self.ensure_one()
        action = self.env['ir.actions.actions']._for_xml_id(
            'account.action_account_payments'
        )
        children = self.with_context(active_test=False).search([
            ('id', 'child_of', self.ids),
        ])
        action['domain'] = [
            ('partner_id', 'in', children.ids),
            ('partner_type', '=', 'customer'),
        ]
        action['context'] = {
            **self.env.context,
            'default_partner_id': self.id,
            'default_partner_type': 'customer',
            'search_default_partner_id': self.id,
        }
        return action

    def action_shahtaj_view_receivable_entries(self):
        """Open posted receivable journal items for this shop."""
        self.ensure_one()
        action = self.env['ir.actions.actions']._for_xml_id(
            'account.action_account_moves_all_a'
        )
        children = self.with_context(active_test=False).search([
            ('id', 'child_of', self.ids),
        ])
        action['domain'] = [
            ('partner_id', 'in', children.ids),
            ('account_id.account_type', '=', 'asset_receivable'),
            ('parent_state', '=', 'posted'),
        ]
        action['context'] = {
            **self.env.context,
            'search_default_partner_id': self.id,
        }
        return action

    def _shahtaj_can_write_exterior_photo(self):
        """Exterior photo is booker-only (verify-on-site / on-site register)."""
        if self.env.su or self.env.context.get('shahtaj_bypass_exterior_lock'):
            return True
        if self.env.context.get('shahtaj_field_verifying'):
            return True
        if self.env.context.get('shahtaj_shop_register'):
            return True
        return False

    @api.model
    def _shahtaj_validate_booker_onsite_register_vals(self, vals):
        """Booker on-site register requires GPS + exterior photo + CNIC number."""
        lat = vals.get('partner_latitude')
        lng = vals.get('partner_longitude')
        if not lat or not lng:
            raise ValidationError(_(
                'GPS latitude and longitude are required when registering a shop on site.'
            ))
        cnic = (vals.get('owner_cnic_number') or '').strip() if isinstance(
            vals.get('owner_cnic_number'), str
        ) else vals.get('owner_cnic_number')
        if not cnic:
            raise ValidationError(_(
                'Owner ID card number is required when registering a shop on site.'
            ))
        if not vals.get('shop_exterior_photo'):
            raise ValidationError(_(
                'Shop exterior photo is required when registering a shop on site.'
            ))

    def _shahtaj_strip_distributor_exterior_photo(self, vals):
        """Drop exterior photo writes from distributor / non-booker contexts."""
        if 'shop_exterior_photo' not in vals:
            return vals
        if self._shahtaj_can_write_exterior_photo():
            return vals
        vals = dict(vals)
        vals.pop('shop_exterior_photo', None)
        return vals

    def _shahtaj_missing_first_visit_fields(self):
        """Fields the app should collect on first on-site verification.

        Required: GPS + shop exterior photo + owner CNIC number.
        Optional: license number, other images, and empty profile gaps.
        """
        self.ensure_one()
        missing = []
        # GPS always collected from device when exterior photo is taken.
        missing.append({
            'key': 'latitude',
            'label': 'GPS Latitude',
            'required': True,
            'type': 'float',
            'source': 'device_gps',
        })
        missing.append({
            'key': 'longitude',
            'label': 'GPS Longitude',
            'required': True,
            'type': 'float',
            'source': 'device_gps',
        })
        missing.append({
            'key': 'shop_exterior_photo',
            'label': 'Shop Exterior Photo',
            'required': True,
            'type': 'image',
            'source': 'camera',
        })
        if not (self.owner_cnic_number or '').strip():
            missing.append({
                'key': 'owner_cnic_number',
                'label': 'Owner ID Card Number',
                'required': True,
                'type': 'string',
                'source': 'form',
            })
        if not (self.shop_license_number or '').strip():
            missing.append({
                'key': 'shop_license_number',
                'label': 'License Number',
                'required': False,
                'type': 'string',
                'source': 'form',
            })
        if not self.owner_photo:
            missing.append({
                'key': 'owner_photo',
                'label': 'Owner Photo',
                'required': False,
                'type': 'image',
                'source': 'camera',
            })
        if not self.owner_cnic_front:
            missing.append({
                'key': 'owner_cnic_front',
                'label': 'Owner CNIC Front',
                'required': False,
                'type': 'image',
                'source': 'camera',
            })
        if not self.owner_cnic_back:
            missing.append({
                'key': 'owner_cnic_back',
                'label': 'Owner CNIC Back',
                'required': False,
                'type': 'image',
                'source': 'camera',
            })
        if not (self.owner_name or '').strip():
            missing.append({
                'key': 'owner_name',
                'label': 'Owner Name',
                'required': False,
                'type': 'string',
                'source': 'form',
            })
        if not (self.owner_phone or '').strip():
            missing.append({
                'key': 'owner_phone',
                'label': 'Owner Phone',
                'required': False,
                'type': 'string',
                'source': 'form',
            })
        if not self.shahtaj_shop_category:
            missing.append({
                'key': 'shop_category',
                'label': 'Shop Category (cash/credit)',
                'required': False,
                'type': 'string',
                'source': 'form',
            })
        # Opening / previous debt — only if distributor left it empty and nothing posted yet.
        currency = self.currency_id or self.env.company.currency_id
        if (
            not self.legacy_balance_move_id
            and float_is_zero(
                self.legacy_balance or 0.0,
                precision_rounding=currency.rounding,
            )
        ):
            missing.append({
                'key': 'legacy_balance',
                'label': 'Legacy / Opening Balance (Rs)',
                'required': False,
                'type': 'float',
                'source': 'form',
            })
        return missing

    def _shahtaj_first_visit_setup_payload(self):
        """Compact payload for check-in / task list when shop needs setup."""
        self.ensure_one()
        return {
            'field_verified': bool(self.shahtaj_field_verified),
            'visit_tag': self.shahtaj_visit_tag or 'not_visited',
            'needs_shop_setup': not bool(self.shahtaj_field_verified),
            'missing_fields': (
                self._shahtaj_missing_first_visit_fields()
                if not self.shahtaj_field_verified else []
            ),
        }

    def action_shahtaj_apply_field_verification(self, vals, verified_by=None):
        """Write first-visit GPS/photos/info and mark the shop field-verified."""
        self.ensure_one()
        if not self.is_shahtaj_shop:
            raise UserError(_('Only shops can be field-verified.'))
        if self.shop_approval_state != 'approved':
            raise UserError(_(
                'Shop "%(shop)s" is not approved yet.',
                shop=self.display_name,
            ))

        latitude = vals.get('latitude')
        longitude = vals.get('longitude')
        if latitude is None or longitude is None:
            raise UserError(_('GPS latitude and longitude are required.'))
        latitude = float(latitude)
        longitude = float(longitude)
        if not (-90 <= latitude <= 90):
            raise ValidationError(_('GPS latitude must be between -90 and 90.'))
        if not (-180 <= longitude <= 180):
            raise ValidationError(_('GPS longitude must be between -180 and 180.'))

        # Exterior must be captured now with GPS (booker-only; not distributor).
        exterior = vals.get('shop_exterior_photo')
        if not exterior:
            raise UserError(_(
                'Shop exterior photo is required for first-visit verification.'
            ))

        cnic = (
            vals.get('owner_cnic_number')
            or self.owner_cnic_number
            or ''
        )
        if isinstance(cnic, str):
            cnic = cnic.strip()
        if not cnic:
            raise UserError(_(
                'Owner ID card number is required for first-visit verification.'
            ))

        write_vals = {
            'partner_latitude': latitude,
            'partner_longitude': longitude,
            'shop_exterior_photo': exterior,
            'owner_cnic_number': cnic,
            'shahtaj_field_verified': True,
            'shahtaj_field_verified_at': fields.Datetime.now(),
            'shahtaj_field_verified_by_id': (verified_by or self.env.user).id,
        }
        for key in ('owner_photo', 'owner_cnic_front', 'owner_cnic_back',
                    'owner_name', 'owner_phone'):
            if vals.get(key):
                write_vals[key] = vals[key]
        license_number = vals.get('shop_license_number') or vals.get('license_number')
        if isinstance(license_number, str):
            license_number = license_number.strip()
        if license_number:
            write_vals['shop_license_number'] = license_number

        shop_category = vals.get('shop_category') or vals.get('shahtaj_shop_category')
        if shop_category:
            if shop_category not in ('credit', 'cash'):
                raise UserError(_('shop_category must be "credit" or "cash".'))
            write_vals['shahtaj_shop_category'] = shop_category

        # Optional opening balance from booker (only if never posted).
        if (
            'legacy_balance' in vals
            and vals.get('legacy_balance') is not None
            and not self.legacy_balance_move_id
        ):
            try:
                legacy_amount = float(vals['legacy_balance'])
            except (TypeError, ValueError) as err:
                raise UserError(_('legacy_balance must be a number.')) from err
            if legacy_amount < 0:
                raise UserError(_('Legacy balance cannot be negative.'))
            currency = self.currency_id or self.env.company.currency_id
            # Only write when distributor left it empty — do not overwrite a set amount.
            if float_is_zero(
                self.legacy_balance or 0.0,
                precision_rounding=currency.rounding,
            ):
                write_vals['legacy_balance'] = legacy_amount

        self.with_context(shahtaj_field_verifying=True).write(write_vals)
        self.env['shahtaj.activity.log'].log_business(
            operation='shop.field_verify',
            name='Shop field-verified on site',
            related_record=self,
            message=_('Verified by %(user)s at %(lat)s, %(lng)s',
                      user=(verified_by or self.env.user).display_name,
                      lat=latitude,
                      lng=longitude),
        )
        return True
