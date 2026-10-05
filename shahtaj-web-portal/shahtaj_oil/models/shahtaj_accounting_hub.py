# -*- coding: utf-8 -*-
"""Distributor landing page for shop sales, invoicing, and payments."""
from odoo import _, api, fields, models
from odoo.osv import expression

AUDIT_MODELS = (
    'account.move',
    'account.account',
    'account.tax',
    'res.partner',
    'res.company',
)
AUDIT_MODEL_LABELS = {
    'account.move': 'Journal Entry',
    'account.account': 'Account',
    'account.tax': 'Tax',
    'res.partner': 'Partner',
    'res.company': 'Company',
}


class ShahtajAccountingHub(models.TransientModel):
    _name = 'shahtaj.accounting.hub'
    _description = 'Shop Accounting Hub'

    field_order_count = fields.Integer(
        string='Field Orders',
        compute='_compute_counts',
    )
    orders_to_invoice_count = fields.Integer(
        string='To Invoice',
        compute='_compute_counts',
    )
    orders_to_deliver_count = fields.Integer(
        string='To Deliver',
        compute='_compute_counts',
    )
    open_invoice_count = fields.Integer(
        string='Open Invoices',
        compute='_compute_counts',
    )
    credit_note_count = fields.Integer(
        string='Credit Notes',
        compute='_compute_counts',
    )
    expense_invoice_count = fields.Integer(
        string='Expense Invoices',
        compute='_compute_counts',
        help='Draft + posted operating expense invoices.',
    )
    shop_count = fields.Integer(
        string='Approved Shops',
        compute='_compute_counts',
    )
    purchase_order_count = fields.Integer(
        string='Purchase Orders',
        compute='_compute_counts',
    )
    incoming_receipt_count = fields.Integer(
        string='Incoming Receipts',
        compute='_compute_counts',
    )
    vendor_bill_count = fields.Integer(
        string='Vendor Bills',
        compute='_compute_counts',
    )

    @api.depends_context('uid')
    def _compute_counts(self):
        SaleOrder = self.env['sale.order'].sudo()
        AccountMove = self.env['account.move'].sudo()
        Partner = self.env['res.partner'].sudo()
        for hub in self:
            hub.field_order_count = SaleOrder.search_count([
                '|',
                ('shahtaj_visit_id', '!=', False),
                ('shahtaj_is_walk_in', '=', True),
            ])
            hub.orders_to_invoice_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
                ('invoice_status', '=', 'to invoice'),
            ])
            hub.orders_to_deliver_count = SaleOrder.search_count([
                ('shahtaj_visit_id', '!=', False),
                ('state', 'in', ('sale', 'done')),
                ('shahtaj_delivery_status', 'in', ('pending', 'partial')),
            ])
            hub.open_invoice_count = AccountMove.search_count([
                ('move_type', '=', 'out_invoice'),
                '|',
                ('partner_id.is_shahtaj_shop', '=', True),
                ('shahtaj_is_walk_in', '=', True),
                ('state', '=', 'posted'),
                ('payment_state', 'in', ('not_paid', 'partial')),
            ])
            hub.credit_note_count = AccountMove.search_count([
                ('move_type', '=', 'out_refund'),
                '|',
                ('partner_id.is_shahtaj_shop', '=', True),
                ('shahtaj_is_walk_in', '=', True),
                ('state', '=', 'posted'),
            ])
            hub.expense_invoice_count = self.env['shahtaj.expense'].sudo().search_count([
                ('state', 'in', ('draft', 'posted')),
            ])
            hub.shop_count = Partner.search_count([
                ('is_shahtaj_shop', '=', True),
                ('shop_approval_state', '=', 'approved'),
            ])
            if 'purchase.order' in self.env:
                hub.purchase_order_count = self.env['purchase.order'].sudo().search_count([
                    ('state', 'in', ('draft', 'sent', 'to approve', 'purchase')),
                ])
                hub.incoming_receipt_count = self.env['stock.picking'].sudo().search_count([
                    ('picking_type_code', '=', 'incoming'),
                    ('state', 'not in', ('done', 'cancel')),
                ])
                hub.vendor_bill_count = AccountMove.search_count([
                    ('move_type', 'in', ('in_invoice', 'in_refund')),
                    ('state', 'in', ('draft', 'posted')),
                ])
            else:
                hub.purchase_order_count = 0
                hub.incoming_receipt_count = 0
                hub.vendor_bill_count = 0

    @api.model
    def action_open_accounting_hub(self):
        """Open the distributor accounting dashboard."""
        record = self.create({})
        return {
            'type': 'ir.actions.act_window',
            'name': _('Shop Accounting'),
            'res_model': 'shahtaj.accounting.hub',
            'res_id': record.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [
                (self.env.ref(
                    'shahtaj_oil.view_shahtaj_accounting_hub_form'
                ).id, 'form'),
            ],
        }

    def action_open_field_sales_orders(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_field_sales_orders',
        )

    def action_open_orders_to_invoice(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_orders_to_invoice',
        )

    def action_open_orders_to_deliver(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_orders_to_deliver',
        )

    def action_open_customer_invoices(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_customer_invoices',
        )

    def action_open_customer_payments(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_customer_payments',
        )

    def action_open_walk_in_orders(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_walk_in_orders',
        )

    def action_open_walk_in_invoices(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_walk_in_invoices',
        )

    def action_open_walk_in_payments(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_walk_in_payments',
        )

    def action_open_shop_balances(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_shop_balances',
        )

    def action_open_credit_notes(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_credit_notes',
        )

    def action_open_opening_balance_invoices(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_opening_balance_invoices',
        )

    def action_open_pnl_dashboard(self):
        return self.env['shahtaj.pnl.dashboard'].action_open_pnl_dashboard()

    def action_open_trial_balance(self):
        return self.env['shahtaj.trial.balance'].action_open()

    def action_open_balance_sheet(self):
        return self.env['shahtaj.balance.sheet'].action_open()

    def action_open_tax_ledger(self):
        return self.env['shahtaj.tax.ledger'].action_open_tax_ledger()

    def action_open_expenses(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_expense',
        )

    def action_open_expense_categories(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_expense_category',
        )

    def action_open_purchase_orders(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_purchase_orders',
        )

    def action_open_incoming_receipts(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_incoming_receipts',
        )

    def action_open_vendor_bills(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_vendor_bills',
        )

    def action_open_vendors(self):
        return self.env['ir.actions.act_window']._for_xml_id(
            'shahtaj_oil.action_shahtaj_vendors',
        )

    @api.model
    def shahtaj_audit_trail(self, filters=None, limit=50, offset=0):
        """Company-scoped audit messages for the portal Accounting tab."""
        filters = filters or {}
        company = self.env.company
        requested = filters.get('model') or 'all'
        models = [requested] if requested in AUDIT_MODELS else list(AUDIT_MODELS)
        limit = max(1, min(int(limit or 50), 100))
        offset = max(0, int(offset or 0))

        domain = [
            ('message_type', '=', 'notification'),
            ('model', 'in', models),
        ]
        company_domain = self._shahtaj_audit_company_domain(company, models)
        if company_domain:
            domain = expression.AND([domain, company_domain])
        else:
            domain = expression.AND([domain, [('id', '=', 0)]])

        date_from = (filters.get('date_from') or '').strip()
        date_to = (filters.get('date_to') or '').strip()
        if date_from:
            domain.append(('date', '>=', f'{date_from} 00:00:00'))
        if date_to:
            domain.append(('date', '<=', f'{date_to} 23:59:59'))

        search = (filters.get('search') or '').strip()
        if search:
            domain = expression.AND([domain, [
                '|', '|', '|', '|', '|',
                ('author_id.name', 'ilike', search),
                ('subject', 'ilike', search),
                ('record_name', 'ilike', search),
                ('preview', 'ilike', search),
                ('tracking_value_ids.old_value_char', 'ilike', search),
                ('tracking_value_ids.new_value_char', 'ilike', search),
            ]])

        Message = self.env['mail.message'].sudo()
        total = Message.search_count(domain)
        messages = Message.search(domain, limit=limit, offset=offset, order='date desc, id desc')
        return {
            'total': total,
            'rows': [self._shahtaj_audit_row(message) for message in messages],
        }

    def _shahtaj_audit_company_domain(self, company, models):
        clauses = []
        if 'account.move' in models:
            clauses.append([
                '&', ('model', '=', 'account.move'),
                ('res_id', 'in', self.env['account.move'].sudo()._search([
                    ('company_id', '=', company.id),
                ])),
            ])
        if 'account.account' in models and 'company_ids' in self.env['account.account']._fields:
            clauses.append([
                '&', ('model', '=', 'account.account'),
                ('res_id', 'in', self.env['account.account'].sudo()._search([
                    ('company_ids', 'in', company.id),
                ])),
            ])
        elif 'account.account' in models:
            clauses.append([
                '&', ('model', '=', 'account.account'),
                ('res_id', 'in', self.env['account.account'].sudo()._search([
                    ('company_id', '=', company.id),
                ])),
            ])
        if 'account.tax' in models:
            clauses.append([
                '&', ('model', '=', 'account.tax'),
                ('res_id', 'in', self.env['account.tax'].sudo()._search([
                    ('company_id', '=', company.id),
                ])),
            ])
        if 'res.partner' in models:
            self.env.cr.execute(
                """
                SELECT DISTINCT partner_id
                  FROM account_move_line
                 WHERE company_id = %s
                   AND partner_id IS NOT NULL
                """,
                [company.id],
            )
            partner_ids = [row[0] for row in self.env.cr.fetchall()]
            partner_domain = [('company_id', '=', company.id)]
            if partner_ids:
                partner_domain = ['|', ('company_id', '=', company.id), ('id', 'in', partner_ids)]
            clauses.append([
                '&', ('model', '=', 'res.partner'),
                ('res_id', 'in', self.env['res.partner'].sudo()._search(partner_domain)),
            ])
        if 'res.company' in models:
            clauses.append([
                '&', ('model', '=', 'res.company'),
                ('res_id', '=', company.id),
            ])
        if not clauses:
            return []
        if len(clauses) == 1:
            return clauses[0]
        return expression.OR(clauses)

    def _shahtaj_audit_row(self, message):
        changes = self._shahtaj_audit_changes(message)
        record_name = message.record_name or ''
        journal_id = False
        if message.model and message.res_id and message.model in self.env:
            record = self.env[message.model].sudo().browse(message.res_id).exists()
            if record:
                record_name = record.display_name or record_name
                if message.model == 'account.move':
                    journal_id = record.journal_id.id
        summary = self._shahtaj_audit_summary(message, changes)
        return {
            'id': message.id,
            'date': fields.Datetime.to_string(message.date) if message.date else '',
            'author': message.author_id.display_name or message.email_from or '',
            'model': message.model or '',
            'model_label': AUDIT_MODEL_LABELS.get(message.model, message.model or ''),
            'res_id': message.res_id or 0,
            'record_name': record_name or '—',
            'journal_id': journal_id or 0,
            'summary': summary,
            'can_open': message.model in ('account.move', 'account.account') and bool(message.res_id),
            'changes': changes,
        }

    def _shahtaj_audit_changes(self, message):
        changes = []
        for tracking in message.tracking_value_ids:
            old = self._shahtaj_tracking_display(tracking, new=False)
            new = self._shahtaj_tracking_display(tracking, new=True)
            if not old and not new:
                continue
            field_name = ''
            if tracking.field_id:
                field_name = tracking.field_id.field_description or tracking.field_id.name
            changes.append({
                'field': field_name or 'Field',
                'old': old or '—',
                'new': new or '—',
            })
        return changes

    def _shahtaj_tracking_display(self, tracking, new=False):
        prefix = 'new' if new else 'old'
        for suffix in ('char', 'text', 'datetime', 'integer', 'float'):
            value = tracking[f'{prefix}_value_{suffix}']
            if value in (False, None, ''):
                continue
            if suffix == 'datetime':
                return fields.Datetime.to_string(value)
            if suffix == 'float':
                return f'{value:.2f}'
            return str(value)
        return ''

    def _shahtaj_audit_summary(self, message, changes):
        if changes:
            parts = [f"{item['field']}: {item['old']} → {item['new']}" for item in changes[:3]]
            extra = len(changes) - 3
            if extra > 0:
                parts.append(f'+{extra} more')
            return '; '.join(parts)
        return message.subject or message.preview or 'Created'
