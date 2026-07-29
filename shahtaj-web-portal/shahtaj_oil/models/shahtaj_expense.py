# -*- coding: utf-8 -*-
"""Distributor operating expenses (native UI).

Additive only: does not change visits, sales orders, invoices, shop payments,
tax ledger, or manufacturer summary. Posted expenses reduce Net Profit on the
P&L dashboard and create a misc cash/bank journal entry.
"""
from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError

EXPENSE_STATES = [
    ('draft', 'Draft'),
    ('posted', 'Posted'),
    ('cancelled', 'Cancelled'),
]


class ShahtajExpenseCategory(models.Model):
    _name = 'shahtaj.expense.category'
    _description = 'Expense Category'
    _order = 'sequence, name, id'

    name = fields.Char(required=True, translate=True)
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
    account_id = fields.Many2one(
        'account.account',
        string='Expense Account',
        domain="[('account_type', 'in', ('expense', 'expense_direct_cost', 'expense_depreciation'))]",
        help='Optional. If empty, the company default operating expense account is used.',
    )
    note = fields.Char(string='Notes')

    _name_uniq = models.Constraint(
        'unique(name)',
        'Expense category name must be unique.',
    )


class ShahtajExpense(models.Model):
    _name = 'shahtaj.expense'
    _description = 'Distributor Expense'
    _order = 'date desc, id desc'
    _inherit = ['mail.thread']

    name = fields.Char(
        string='Reference',
        required=True,
        copy=False,
        default=lambda self: _('New'),
        tracking=True,
    )
    date = fields.Date(
        string='Date',
        required=True,
        default=fields.Date.context_today,
        tracking=True,
        index=True,
    )
    category_id = fields.Many2one(
        'shahtaj.expense.category',
        string='Category',
        required=True,
        tracking=True,
        ondelete='restrict',
    )
    description = fields.Char(
        string='Description',
        required=True,
        tracking=True,
        help='Short label shown on the journal entry, e.g. Route A petrol.',
    )
    amount = fields.Monetary(
        string='Amount',
        required=True,
        currency_field='currency_id',
        tracking=True,
    )
    currency_id = fields.Many2one(
        'res.currency',
        string='Currency',
        required=True,
        default=lambda self: self.env.company.currency_id,
    )
    journal_id = fields.Many2one(
        'account.journal',
        string='Paid From',
        required=True,
        domain="[('type', 'in', ('cash', 'bank')), ('company_id', '=', company_id)]",
        tracking=True,
        help='Cash or bank journal the money left from.',
    )
    partner_id = fields.Many2one(
        'res.partner',
        string='Paid To',
        help='Optional vendor / person / pump name.',
    )
    notes = fields.Text(string='Notes')
    company_id = fields.Many2one(
        'res.company',
        required=True,
        default=lambda self: self.env.company,
        index=True,
    )
    state = fields.Selection(
        EXPENSE_STATES,
        string='Status',
        default='draft',
        required=True,
        copy=False,
        tracking=True,
        index=True,
    )
    move_id = fields.Many2one(
        'account.move',
        string='Journal Entry',
        copy=False,
        readonly=True,
        ondelete='set null',
    )
    move_name = fields.Char(
        related='move_id.name',
        string='Entry',
        readonly=True,
    )

    @api.constrains('amount')
    def _check_amount(self):
        for expense in self:
            if expense.amount <= 0:
                raise ValidationError(_('Expense amount must be greater than zero.'))

    @api.constrains('journal_id')
    def _check_journal(self):
        for expense in self:
            if expense.journal_id and expense.journal_id.type not in ('cash', 'bank'):
                raise ValidationError(_(
                    'Expenses must be paid from a Cash or Bank journal.'
                ))

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', _('New')) in (False, _('New'), 'New'):
                vals['name'] = self.env['ir.sequence'].next_by_code(
                    'shahtaj.expense'
                ) or _('EXP/%s', fields.Date.context_today(self))
        expenses = super().create(vals_list)
        Log = self.env['shahtaj.activity.log']
        for expense in expenses:
            Log.log_business(
                operation='expense.create',
                name='Expense created',
                related_record=expense,
                message=expense.display_name,
            )
        return expenses

    def write(self, vals):
        locked = self.filtered(lambda e: e.state == 'posted')
        if locked and not self.env.context.get('shahtaj_expense_system_write'):
            forbidden = set(vals) - {'notes'}
            if forbidden:
                raise UserError(_(
                    'Posted expenses cannot be edited. Cancel the expense first, '
                    'then create a corrected one.'
                ))
        cancelled = self.filtered(lambda e: e.state == 'cancelled')
        if cancelled and not self.env.context.get('shahtaj_expense_system_write'):
            raise UserError(_('Cancelled expenses cannot be edited.'))
        res = super().write(vals)
        if any(k in vals for k in (
            'date', 'category_id', 'description', 'amount', 'journal_id', 'state',
        )):
            Log = self.env['shahtaj.activity.log']
            for expense in self:
                Log.log_business(
                    operation='expense.update',
                    name='Expense updated',
                    related_record=expense,
                    message=expense.display_name,
                )
        return res

    def unlink(self):
        if any(e.state == 'posted' for e in self):
            raise UserError(_(
                'Cannot delete a posted expense. Cancel it first.'
            ))
        snapshot = [(e.id, e.display_name) for e in self]
        res = super().unlink()
        Log = self.env['shahtaj.activity.log']
        for _eid, label in snapshot:
            Log.log_business(
                operation='expense.delete',
                name='Expense deleted',
                message=label,
            )
        return res

    def action_post(self):
        """Post expense: create misc entry (expense debit / cash-bank credit)."""
        for expense in self:
            expense._shahtaj_post_expense()
        return True

    def action_cancel(self):
        """Cancel posted expense and reverse its journal entry."""
        for expense in self:
            expense._shahtaj_cancel_expense()
        return True

    def action_reset_draft(self):
        for expense in self:
            if expense.state != 'cancelled':
                raise UserError(_('Only cancelled expenses can be reset to draft.'))
            if expense.move_id:
                raise UserError(_(
                    'This expense still has a journal entry link. '
                    'Create a new expense instead.'
                ))
            expense.with_context(shahtaj_expense_system_write=True).write({
                'state': 'draft',
            })
        return True

    def action_open_move(self):
        self.ensure_one()
        if not self.move_id:
            raise UserError(_('No journal entry linked to this expense.'))
        return {
            'type': 'ir.actions.act_window',
            'name': _('Journal Entry'),
            'res_model': 'account.move',
            'res_id': self.move_id.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def _shahtaj_post_expense(self):
        self.ensure_one()
        if self.state == 'posted':
            raise UserError(_('This expense is already posted.'))
        if self.state == 'cancelled':
            raise UserError(_('Cancelled expenses cannot be posted. Reset to draft first.'))
        if self.amount <= 0:
            raise UserError(_('Expense amount must be greater than zero.'))
        if not self.journal_id:
            raise UserError(_('Select the Cash or Bank journal this was paid from.'))

        # Tight sudo: distributors may lack full account.move create rights.
        move = self._shahtaj_create_expense_move().sudo()
        move.action_post()
        self.with_context(shahtaj_expense_system_write=True).write({
            'state': 'posted',
            'move_id': move.id,
        })
        self.env['shahtaj.activity.log'].log_business(
            operation='expense.post',
            name='Expense posted',
            related_record=self,
            message=_('%(name)s · %(amount)s · %(journal)s',
                      name=self.display_name,
                      amount=self.amount,
                      journal=self.journal_id.display_name),
        )

    def _shahtaj_cancel_expense(self):
        self.ensure_one()
        if self.state != 'posted':
            if self.state == 'draft':
                self.with_context(shahtaj_expense_system_write=True).write({
                    'state': 'cancelled',
                })
                return
            raise UserError(_('Only draft or posted expenses can be cancelled.'))

        move = self.move_id.sudo()
        if move and move.state == 'posted':
            move._reverse_moves(default_values_list=[{
                'ref': _('Reversal of expense %s', self.name),
                'date': fields.Date.context_today(self),
            }], cancel=True)
        elif move and move.state == 'draft':
            move.button_cancel()

        self.with_context(shahtaj_expense_system_write=True).write({
            'state': 'cancelled',
        })
        self.env['shahtaj.activity.log'].log_business(
            operation='expense.cancel',
            name='Expense cancelled',
            related_record=self,
            message=self.display_name,
        )

    def _shahtaj_create_expense_move(self):
        """Build an unbalanced-checked misc entry on the cash/bank journal."""
        self.ensure_one()
        expense_account = self._shahtaj_get_expense_account()
        liquidity_account = self.journal_id.default_account_id
        if not liquidity_account:
            raise UserError(_(
                'Journal "%(journal)s" has no outstanding receipts account. '
                'Open Bank & Cash Journals and set the default account first.',
                journal=self.journal_id.display_name,
            ))

        label = self.description or self.category_id.display_name
        ref = _('%(ref)s — %(label)s', ref=self.name, label=label)
        line_name = _('%(cat)s: %(label)s',
                      cat=self.category_id.display_name, label=label)

        Move = self.env['account.move'].sudo()
        return Move.create({
            'move_type': 'entry',
            'journal_id': self.journal_id.id,
            'date': self.date,
            'ref': ref,
            'company_id': self.company_id.id,
            'partner_id': self.partner_id.id if self.partner_id else False,
            'line_ids': [
                (0, 0, {
                    'name': line_name,
                    'account_id': expense_account.id,
                    'partner_id': self.partner_id.id if self.partner_id else False,
                    'debit': self.amount,
                    'credit': 0.0,
                }),
                (0, 0, {
                    'name': line_name,
                    'account_id': liquidity_account.id,
                    'partner_id': self.partner_id.id if self.partner_id else False,
                    'debit': 0.0,
                    'credit': self.amount,
                }),
            ],
        })

    def _shahtaj_get_expense_account(self):
        """Category account if set, else company default operating expense account."""
        self.ensure_one()
        if self.category_id.account_id:
            return self.category_id.account_id
        return self.env.company._shahtaj_get_default_expense_account()

    @api.model
    def _shahtaj_posted_domain(self, date_from, date_to, company=None):
        company = company or self.env.company
        return [
            ('state', '=', 'posted'),
            ('company_id', '=', company.id),
            ('date', '>=', date_from),
            ('date', '<=', date_to),
        ]
