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
    _inherit = 'res.partner'

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
    zone_id = fields.Many2one(
        'shahtaj.zone',
        string='Zone',
        ondelete='set null',
        domain=lambda self: [('id', 'in', self._get_allowed_zone_ids())],
    )
    route_id = fields.Many2one(
        'shahtaj.route',
        string='Route',
        ondelete='set null',
        domain="[('id', 'in', allowed_route_ids)]",
        index=True,
    )
    registered_by_id = fields.Many2one(
        'res.users',
        string='Registered By User',
        readonly=True,
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
    allowed_zone_ids = fields.Many2many(
        'shahtaj.zone',
        compute='_compute_allowed_zones_routes',
    )
    allowed_route_ids = fields.Many2many(
        'shahtaj.route',
        compute='_compute_allowed_zones_routes',
    )

    # --- Zone/route dropdowns on shop forms (all active records for bookers) ---
    @api.model
    def _get_allowed_zone_ids(self):
        return self.env['shahtaj.zone'].search([('active', '=', True)]).ids

    @api.model
    def _get_allowed_route_ids(self, zone_id=None):
        domain = [('active', '=', True)]
        if zone_id:
            domain.append(('zone_id', '=', zone_id))
        return self.env['shahtaj.route'].search(domain).ids

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
        for partner in self.filtered('is_shahtaj_shop'):
            if not partner.name:
                raise ValidationError(_('Shop name is required.'))
            if not partner.owner_name:
                raise ValidationError(_('Owner name is required.'))
            if not partner.owner_phone:
                raise ValidationError(_('Owner phone is required.'))
            if not partner.partner_latitude or not partner.partner_longitude:
                raise ValidationError(_('Shop GPS latitude and longitude are required.'))

    def _prepare_shop_vals(self, vals):
        """Set defaults when creating a shop from distributor, portal, or booker API."""
        vals = dict(vals)
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
        prepared = [self._prepare_shop_vals(vals) for vals in vals_list]
        partners = super().create(prepared)
        shop_partners = partners.filtered('is_shahtaj_shop')
        shop_partners._validate_shop_required_fields()
        shop_partners.filtered(
            lambda p: p.shop_approval_state == 'approved'
        )._post_legacy_balance_entry()
        return partners

    def write(self, vals):
        vals = self._sync_shop_category_credit_flags(vals)
        if vals.get('owner_phone'):
            vals.setdefault('phone', vals['owner_phone'])
        if vals.get('legacy_balance_move_id') and not self.env.context.get(
            'shahtaj_posting_legacy_move'
        ):
            raise UserError(_('Legacy balance invoice cannot be changed manually.'))
        res = super().write(vals)
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
        if any(k in vals for k in ('is_shahtaj_shop', 'name', 'owner_name', 'owner_phone',
                                    'partner_latitude', 'partner_longitude')):
            self.filtered('is_shahtaj_shop')._validate_shop_required_fields()
        if 'legacy_balance' in vals:
            self.filtered(
                lambda p: p.shop_approval_state == 'approved' and not p.legacy_balance_move_id
            )._post_legacy_balance_entry()
        if 'shop_approval_state' in vals:
            self.filtered('is_shahtaj_shop')._sync_visit_tasks_after_approval_change()
        return res

    def _sync_visit_tasks_after_approval_change(self):
        """Cancel tasks for unapproved shops; generate tasks when a shop is approved."""
        Task = self.env['shahtaj.visit.task']
        for partner in self:
            if partner.shop_approval_state != 'approved':
                Task._cancel_pending_tasks_for_unapproved_shops()
                continue
            bookers = partner.route_id.mapped('weekly_schedule_ids.order_booker_id')
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

    def action_reject_shop(self):
        self.write({'shop_approval_state': 'rejected'})

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
