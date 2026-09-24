# -*- coding: utf-8 -*-
"""Native distributor Trial Balance & Balance Sheet (Community).

Built for financial-expert flow:
- Trial Balance: Opening | Period Debit | Period Credit | Closing (Dr/Cr)
- Balance Sheet: Assets = Liabilities + Equity (incl. Current Year Earnings)
- Posted journal items only; company-scoped; optimized read_group queries.
"""
from collections import defaultdict
from datetime import date
from dateutil.relativedelta import relativedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_compare, float_is_zero, float_round


# Odoo account.account account_type → Balance Sheet placement
_BS_ASSET_CURRENT = frozenset({
    'asset_receivable', 'asset_cash', 'asset_current', 'asset_prepayments',
})
_BS_ASSET_NONCURRENT = frozenset({
    'asset_non_current', 'asset_fixed',
})
_BS_LIABILITY_CURRENT = frozenset({
    'liability_payable', 'liability_credit_card', 'liability_current',
})
_BS_LIABILITY_NONCURRENT = frozenset({
    'liability_non_current',
})
# Permanent equity / capital / retained earnings (excludes current-year bridge)
_BS_EQUITY = frozenset({
    'equity',
})
# Odoo "Current Year Earnings" CoA type — kept separate from permanent equity
# so we never double-count with computed P&L Current Year Earnings.
_BS_EQUITY_UNAFFECTED = frozenset({
    'equity_unaffected',
})
_PNL_TYPES = frozenset({
    'income', 'income_other',
    'expense', 'expense_depreciation', 'expense_direct_cost',
})


class ShahtajGlBalanceMixin(models.AbstractModel):
    """Shared posted AML aggregation helpers (read_group, no N+1)."""

    _name = 'shahtaj.gl.balance.mixin'
    _description = 'Shahtaj GL Balance Helpers'

    @api.model
    def _shahtaj_aml_base_domain(self, company, date_from=None, date_to=None):
        domain = [
            ('parent_state', '=', 'posted'),
            ('company_id', '=', company.id),
            ('account_id', '!=', False),
        ]
        # Skip section/note rows on invoices when present
        if 'display_type' in self.env['account.move.line']._fields:
            domain += [
                '|',
                ('display_type', '=', False),
                ('display_type', 'not in', ('line_section', 'line_note')),
            ]
        if date_from:
            domain.append(('date', '>=', date_from))
        if date_to:
            domain.append(('date', '<=', date_to))
        return domain

    @api.model
    def _shahtaj_aml_grouped(self, company, date_from=None, date_to=None):
        """Return {account_id: {debit, credit, balance}} for posted lines."""
        MoveLine = self.env['account.move.line'].sudo()
        domain = self._shahtaj_aml_base_domain(company, date_from, date_to)
        rows = MoveLine.read_group(
            domain,
            ['debit:sum', 'credit:sum', 'balance:sum'],
            ['account_id'],
            lazy=False,
        )
        out = {}
        for row in rows:
            account = row.get('account_id')
            if not account:
                continue
            out[account[0]] = {
                'debit': float(row.get('debit') or 0.0),
                'credit': float(row.get('credit') or 0.0),
                'balance': float(row.get('balance') or 0.0),
            }
        return out

    @api.model
    def _shahtaj_fiscal_year_start(self, company, as_of):
        """First day of fiscal year containing as_of (fallback: 1 Jan)."""
        as_of = as_of or fields.Date.context_today(self)
        company = company or self.env.company
        if hasattr(company, 'compute_fiscalyear_dates'):
            try:
                bounds = company.compute_fiscalyear_dates(as_of)
                if bounds and bounds.get('date_from'):
                    return bounds['date_from']
            except Exception:  # noqa: BLE001 — fall back cleanly
                pass
        return date(as_of.year, 1, 1)

    @api.model
    def _shahtaj_split_dr_cr(self, balance, rounding=0.01):
        """Present a signed balance as debit or credit column (not both)."""
        bal = float_round(balance or 0.0, precision_rounding=rounding)
        if float_compare(bal, 0.0, precision_rounding=rounding) > 0:
            return bal, 0.0
        if float_compare(bal, 0.0, precision_rounding=rounding) < 0:
            return 0.0, abs(bal)
        return 0.0, 0.0


class ShahtajTrialBalance(models.TransientModel):
    _name = 'shahtaj.trial.balance'
    _inherit = ['shahtaj.gl.balance.mixin']
    _description = 'Trial Balance'

    company_id = fields.Many2one(
        'res.company',
        string='Company',
        required=True,
        default=lambda self: self.env.company,
    )
    currency_id = fields.Many2one(
        related='company_id.currency_id',
        readonly=True,
    )
    date_from = fields.Date(
        string='Period From',
        required=True,
        default=lambda self: fields.Date.context_today(self).replace(day=1),
        help='Start of the movement period. Opening = balance before this date.',
    )
    date_to = fields.Date(
        string='Period To / As of',
        required=True,
        default=lambda self: fields.Date.context_today(self),
        help='End of period and closing as-of date.',
    )
    hide_zero = fields.Boolean(
        string='Hide zero lines',
        default=True,
        help='Hide accounts with no opening, movement, or closing balance.',
    )
    target_moves = fields.Selection(
        [('posted', 'All Posted Entries')],
        string='Target Moves',
        default='posted',
        required=True,
        help='Financial statements use posted journal entries only.',
    )

    total_opening_debit = fields.Monetary(currency_field='currency_id', readonly=True)
    total_opening_credit = fields.Monetary(currency_field='currency_id', readonly=True)
    total_debit = fields.Monetary(
        string='Period Debit',
        currency_field='currency_id',
        readonly=True,
    )
    total_credit = fields.Monetary(
        string='Period Credit',
        currency_field='currency_id',
        readonly=True,
    )
    total_closing_debit = fields.Monetary(currency_field='currency_id', readonly=True)
    total_closing_credit = fields.Monetary(currency_field='currency_id', readonly=True)
    difference = fields.Monetary(
        string='Closing Difference (Dr − Cr)',
        currency_field='currency_id',
        readonly=True,
        help='Must be zero when books are balanced.',
    )
    is_balanced = fields.Boolean(string='Balanced', readonly=True)
    summary_html = fields.Html(sanitize=False, readonly=True)

    line_ids = fields.One2many(
        'shahtaj.trial.balance.line',
        'wizard_id',
        string='Accounts',
    )

    @api.model
    def action_open(self):
        record = self.create({})
        record.action_refresh()
        return record._shahtaj_reopen_action()

    def _shahtaj_reopen_action(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Trial Balance'),
            'res_model': self._name,
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref('shahtaj_oil.view_shahtaj_trial_balance_form').id,
                'form',
            )],
        }

    def action_set_this_month(self):
        self.ensure_one()
        today = fields.Date.context_today(self)
        self.write({
            'date_from': today.replace(day=1),
            'date_to': today,
        })
        return self.action_refresh()

    def action_set_last_month(self):
        self.ensure_one()
        today = fields.Date.context_today(self)
        first_this = today.replace(day=1)
        last_month_end = first_this - relativedelta(days=1)
        last_month_start = last_month_end.replace(day=1)
        self.write({
            'date_from': last_month_start,
            'date_to': last_month_end,
        })
        return self.action_refresh()

    def action_set_fiscal_year(self):
        self.ensure_one()
        today = fields.Date.context_today(self)
        fy_start = self._shahtaj_fiscal_year_start(self.company_id, today)
        self.write({
            'date_from': fy_start,
            'date_to': today,
        })
        return self.action_refresh()

    def action_refresh(self):
        self.ensure_one()
        if self.date_from > self.date_to:
            raise UserError(_('Period From must be on or before Period To.'))
        self.line_ids.unlink()
        company = self.company_id
        rounding = company.currency_id.rounding or 0.01
        date_from = self.date_from
        date_to = self.date_to

        # Opening = activity strictly before period start
        opening_map = self._shahtaj_aml_grouped(
            company, date_from=None, date_to=date_from - relativedelta(days=1),
        ) if date_from else {}
        # Period movements
        period_map = self._shahtaj_aml_grouped(
            company, date_from=date_from, date_to=date_to,
        )
        # Closing = all posted through date_to (authoritative)
        closing_map = self._shahtaj_aml_grouped(
            company, date_from=None, date_to=date_to,
        )

        account_ids = set(opening_map) | set(period_map) | set(closing_map)
        Account = self.env['account.account'].sudo().with_company(company)
        accounts = Account.browse(list(account_ids)).exists().sorted(
            key=lambda a: (a.code or '', a.name or '', a.id),
        )

        line_cmds = []
        tot_od = tot_oc = tot_pd = tot_pc = tot_cd = tot_cc = 0.0

        for account in accounts:
            aid = account.id
            open_bal = opening_map.get(aid, {}).get('balance', 0.0)
            per = period_map.get(aid, {})
            close_bal = closing_map.get(aid, {}).get('balance', 0.0)
            p_debit = per.get('debit', 0.0)
            p_credit = per.get('credit', 0.0)
            o_dr, o_cr = self._shahtaj_split_dr_cr(open_bal, rounding)
            c_dr, c_cr = self._shahtaj_split_dr_cr(close_bal, rounding)

            if self.hide_zero and all(
                float_is_zero(v, precision_rounding=rounding)
                for v in (o_dr, o_cr, p_debit, p_credit, c_dr, c_cr)
            ):
                continue

            line_cmds.append((0, 0, {
                'account_id': aid,
                'code': account.code or '',
                'name': account.name or '',
                'account_type': account.account_type,
                'opening_debit': o_dr,
                'opening_credit': o_cr,
                'debit': p_debit,
                'credit': p_credit,
                'closing_debit': c_dr,
                'closing_credit': c_cr,
            }))
            tot_od += o_dr
            tot_oc += o_cr
            tot_pd += p_debit
            tot_pc += p_credit
            tot_cd += c_dr
            tot_cc += c_cr

        diff = float_round(tot_cd - tot_cc, precision_rounding=rounding)
        balanced = float_is_zero(diff, precision_rounding=rounding)
        summary = (
            f'<div class="alert alert-{"success" if balanced else "danger"} mb-0" role="alert">'
            f'<b>{"Trial Balance is balanced." if balanced else "Trial Balance is OUT of balance."}</b> '
            f'Closing Debit <b>{tot_cd:,.2f}</b> vs Closing Credit <b>{tot_cc:,.2f}</b>'
            f'{"" if balanced else f" — difference {diff:,.2f}"}.'
            f'</div>'
        )
        self.write({
            'line_ids': line_cmds,
            'total_opening_debit': tot_od,
            'total_opening_credit': tot_oc,
            'total_debit': tot_pd,
            'total_credit': tot_pc,
            'total_closing_debit': tot_cd,
            'total_closing_credit': tot_cc,
            'difference': diff,
            'is_balanced': balanced,
            'summary_html': summary,
        })
        return self._shahtaj_reopen_action()

    def action_open_journal_items(self):
        """Drill to posted journal items in the selected period."""
        self.ensure_one()
        domain = self._shahtaj_aml_base_domain(
            self.company_id, self.date_from, self.date_to,
        )
        return {
            'type': 'ir.actions.act_window',
            'name': _('Journal Items — Trial Balance period'),
            'res_model': 'account.move.line',
            'view_mode': 'list,form',
            'domain': domain,
            'context': {'search_default_posted': 1},
        }

    def action_print(self):
        self.ensure_one()
        return self.env.ref(
            'shahtaj_oil.action_report_shahtaj_trial_balance'
        ).report_action(self)


class ShahtajTrialBalanceLine(models.TransientModel):
    _name = 'shahtaj.trial.balance.line'
    _description = 'Trial Balance Line'
    _order = 'code, id'

    wizard_id = fields.Many2one(
        'shahtaj.trial.balance',
        required=True,
        ondelete='cascade',
    )
    account_id = fields.Many2one('account.account', string='Account', readonly=True)
    code = fields.Char(string='Code', readonly=True)
    name = fields.Char(string='Account Name', readonly=True)
    account_type = fields.Selection(
        selection=lambda self: self.env['account.account']._fields['account_type'].selection,
        string='Type',
        readonly=True,
    )
    opening_debit = fields.Monetary(currency_field='currency_id', readonly=True)
    opening_credit = fields.Monetary(currency_field='currency_id', readonly=True)
    debit = fields.Monetary(string='Period Debit', currency_field='currency_id', readonly=True)
    credit = fields.Monetary(string='Period Credit', currency_field='currency_id', readonly=True)
    closing_debit = fields.Monetary(currency_field='currency_id', readonly=True)
    closing_credit = fields.Monetary(currency_field='currency_id', readonly=True)
    currency_id = fields.Many2one(related='wizard_id.currency_id', readonly=True)

    def action_open_account_moves(self):
        self.ensure_one()
        wiz = self.wizard_id
        domain = wiz._shahtaj_aml_base_domain(
            wiz.company_id, wiz.date_from, wiz.date_to,
        ) + [('account_id', '=', self.account_id.id)]
        return {
            'type': 'ir.actions.act_window',
            'name': _('Items — %s', self.display_name or self.code),
            'res_model': 'account.move.line',
            'view_mode': 'list,form',
            'domain': domain,
        }


class ShahtajBalanceSheet(models.TransientModel):
    _name = 'shahtaj.balance.sheet'
    _inherit = ['shahtaj.gl.balance.mixin']
    _description = 'Balance Sheet'

    company_id = fields.Many2one(
        'res.company',
        string='Company',
        required=True,
        default=lambda self: self.env.company,
    )
    currency_id = fields.Many2one(
        related='company_id.currency_id',
        readonly=True,
    )
    date_to = fields.Date(
        string='As of',
        required=True,
        default=lambda self: fields.Date.context_today(self),
        help='Balance Sheet is a point-in-time statement.',
    )
    fiscal_year_start = fields.Date(
        string='Fiscal Year Start',
        readonly=True,
        help='Used to compute Current Year Earnings (P&L from this date to As of).',
    )
    hide_zero = fields.Boolean(string='Hide zero lines', default=True)

    total_assets = fields.Monetary(currency_field='currency_id', readonly=True)
    total_liabilities = fields.Monetary(currency_field='currency_id', readonly=True)
    total_equity = fields.Monetary(
        string='Total Equity (incl. CY Earnings)',
        currency_field='currency_id',
        readonly=True,
    )
    total_liabilities_equity = fields.Monetary(
        string='Total Liabilities + Equity',
        currency_field='currency_id',
        readonly=True,
    )
    current_year_earnings = fields.Monetary(
        currency_field='currency_id',
        readonly=True,
        help='Net profit/(loss) from fiscal year start through As of date '
             '(income and expense accounts).',
    )
    difference = fields.Monetary(
        string='Assets − (Liabilities + Equity)',
        currency_field='currency_id',
        readonly=True,
        help='Must be zero when the Balance Sheet balances.',
    )
    is_balanced = fields.Boolean(readonly=True)
    summary_html = fields.Html(sanitize=False, readonly=True)

    line_ids = fields.One2many(
        'shahtaj.balance.sheet.line',
        'wizard_id',
        string='Lines',
    )

    @api.model
    def action_open(self):
        record = self.create({})
        record.action_refresh()
        return record._shahtaj_reopen_action()

    def _shahtaj_reopen_action(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Balance Sheet'),
            'res_model': self._name,
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'current',
            'views': [(
                self.env.ref('shahtaj_oil.view_shahtaj_balance_sheet_form').id,
                'form',
            )],
        }

    def action_set_today(self):
        self.ensure_one()
        self.date_to = fields.Date.context_today(self)
        return self.action_refresh()

    def action_set_month_end(self):
        self.ensure_one()
        today = fields.Date.context_today(self)
        first_next = (today.replace(day=1) + relativedelta(months=1))
        self.date_to = first_next - relativedelta(days=1)
        return self.action_refresh()

    def action_set_last_month_end(self):
        self.ensure_one()
        today = fields.Date.context_today(self)
        self.date_to = today.replace(day=1) - relativedelta(days=1)
        return self.action_refresh()

    def _bs_section_for_type(self, account_type):
        if account_type in _BS_ASSET_CURRENT:
            return 'asset_current'
        if account_type in _BS_ASSET_NONCURRENT:
            return 'asset_non_current'
        if account_type in _BS_LIABILITY_CURRENT:
            return 'liability_current'
        if account_type in _BS_LIABILITY_NONCURRENT:
            return 'liability_non_current'
        if account_type in _BS_EQUITY:
            return 'equity'
        if account_type in _BS_EQUITY_UNAFFECTED:
            return 'equity_unaffected'
        return False

    def _bs_report_amount(self, account_type, balance):
        """Liability/equity shown as positive credit balances; assets as debit."""
        if account_type in _BS_ASSET_CURRENT | _BS_ASSET_NONCURRENT:
            return balance  # debit-normal
        # credit-normal (liabilities, equity, equity_unaffected)
        return -balance

    def action_refresh(self):
        self.ensure_one()
        self.line_ids.unlink()
        company = self.company_id
        rounding = company.currency_id.rounding or 0.01
        as_of = self.date_to
        fy_start = self._shahtaj_fiscal_year_start(company, as_of)

        # One authoritative close through as-of (BS accounts + any open P&L)
        closing_map = self._shahtaj_aml_grouped(
            company, date_from=None, date_to=as_of,
        )
        # Current Year Earnings from income/expense in the fiscal year only
        pnl_map = self._shahtaj_aml_grouped(
            company, date_from=fy_start, date_to=as_of,
        )

        Account = self.env['account.account'].sudo().with_company(company)
        all_ids = set(closing_map) | set(pnl_map)
        accounts = Account.browse(list(all_ids)).exists()
        account_by_id = {a.id: a for a in accounts}

        buckets = defaultdict(list)  # section -> [(account, amount)]
        pnl_balance_sum = 0.0

        for aid, vals in closing_map.items():
            account = account_by_id.get(aid)
            if not account:
                continue
            atype = account.account_type
            if atype in _PNL_TYPES:
                continue  # rolled into CYE — never listed as BS detail
            section = self._bs_section_for_type(atype)
            if not section:
                continue
            amount = self._bs_report_amount(atype, vals.get('balance', 0.0))
            if self.hide_zero and float_is_zero(amount, precision_rounding=rounding):
                continue
            buckets[section].append((account, amount))

        for aid, vals in pnl_map.items():
            account = account_by_id.get(aid)
            if not account or account.account_type not in _PNL_TYPES:
                continue
            pnl_balance_sum += vals.get('balance', 0.0)

        # P&L balance sum = Expenses − Income → net earnings = −sum
        # After year-end close, P&L is ~0 and profit sits in equity_unaffected.
        cye = float_round(-pnl_balance_sum, precision_rounding=rounding)

        def _sorted_bucket(items):
            return sorted(items, key=lambda t: (t[0].code or '', t[0].name or '', t[0].id))

        seq = 10
        line_cmds = []
        section_totals = defaultdict(float)

        def add_header(label, section_key):
            nonlocal seq
            line_cmds.append((0, 0, {
                'sequence': seq,
                'line_type': 'section',
                'section': section_key,
                'name': label,
                'balance': 0.0,
            }))
            seq += 10

        def add_accounts(section_key):
            nonlocal seq
            for account, amount in _sorted_bucket(buckets.get(section_key, [])):
                line_cmds.append((0, 0, {
                    'sequence': seq,
                    'line_type': 'account',
                    'section': section_key,
                    'account_id': account.id,
                    'code': account.code or '',
                    'name': account.name or '',
                    'balance': amount,
                }))
                section_totals[section_key] += amount
                seq += 10

        def add_total(label, section_key, amount):
            nonlocal seq
            line_cmds.append((0, 0, {
                'sequence': seq,
                'line_type': 'total',
                'section': section_key,
                'name': label,
                'balance': amount,
            }))
            seq += 10

        # —— Assets ——
        add_header(_('ASSETS'), 'asset_current')
        add_header(_('Current Assets'), 'asset_current')
        add_accounts('asset_current')
        add_total(_('Total Current Assets'), 'asset_current', section_totals['asset_current'])

        add_header(_('Non-current Assets'), 'asset_non_current')
        add_accounts('asset_non_current')
        add_total(
            _('Total Non-current Assets'),
            'asset_non_current',
            section_totals['asset_non_current'],
        )
        total_assets = section_totals['asset_current'] + section_totals['asset_non_current']
        add_total(_('TOTAL ASSETS'), 'asset_total', total_assets)

        # —— Liabilities ——
        add_header(_('LIABILITIES'), 'liability_current')
        add_header(_('Current Liabilities'), 'liability_current')
        add_accounts('liability_current')
        add_total(
            _('Total Current Liabilities'),
            'liability_current',
            section_totals['liability_current'],
        )
        add_header(_('Non-current Liabilities'), 'liability_non_current')
        add_accounts('liability_non_current')
        add_total(
            _('Total Non-current Liabilities'),
            'liability_non_current',
            section_totals['liability_non_current'],
        )
        total_liab = (
            section_totals['liability_current'] + section_totals['liability_non_current']
        )
        add_total(_('TOTAL LIABILITIES'), 'liability_total', total_liab)

        # —— Equity ——
        add_header(_('EQUITY'), 'equity')
        add_accounts('equity')
        # Undistributed / CoA "Current Year Earnings" account (post year-end close)
        add_accounts('equity_unaffected')
        section_totals['equity'] += section_totals['equity_unaffected']
        # Computed CYE from open P&L (FY start → as of). Zero after full year-end close.
        line_cmds.append((0, 0, {
            'sequence': seq,
            'line_type': 'cye',
            'section': 'equity',
            'name': _('Current Year Earnings'),
            'balance': cye,
        }))
        seq += 10
        section_totals['equity'] += cye
        total_equity = section_totals['equity']
        add_total(_('TOTAL EQUITY'), 'equity_total', total_equity)

        total_le = total_liab + total_equity
        add_total(_('TOTAL LIABILITIES + EQUITY'), 'le_total', total_le)

        diff = float_round(total_assets - total_le, precision_rounding=rounding)
        balanced = float_is_zero(diff, precision_rounding=rounding)
        summary = (
            f'<div class="alert alert-{"success" if balanced else "danger"} mb-0" role="alert">'
            f'<b>{"Balance Sheet balances." if balanced else "Balance Sheet does NOT balance."}</b> '
            f'Assets <b>{total_assets:,.2f}</b> = Liabilities+Equity <b>{total_le:,.2f}</b>'
            f'{"" if balanced else f" — gap {diff:,.2f}"}.'
            f' Current Year Earnings ({fy_start} → {as_of}): <b>{cye:,.2f}</b>.'
            f'</div>'
        )

        self.write({
            'fiscal_year_start': fy_start,
            'line_ids': line_cmds,
            'total_assets': total_assets,
            'total_liabilities': total_liab,
            'total_equity': total_equity,
            'total_liabilities_equity': total_le,
            'current_year_earnings': cye,
            'difference': diff,
            'is_balanced': balanced,
            'summary_html': summary,
        })
        return self._shahtaj_reopen_action()

    def action_open_journal_items(self):
        self.ensure_one()
        domain = self._shahtaj_aml_base_domain(
            self.company_id, date_from=None, date_to=self.date_to,
        )
        return {
            'type': 'ir.actions.act_window',
            'name': _('Journal Items — as of %s', self.date_to),
            'res_model': 'account.move.line',
            'view_mode': 'list,form',
            'domain': domain,
        }

    def action_print(self):
        self.ensure_one()
        return self.env.ref(
            'shahtaj_oil.action_report_shahtaj_balance_sheet'
        ).report_action(self)


class ShahtajBalanceSheetLine(models.TransientModel):
    _name = 'shahtaj.balance.sheet.line'
    _description = 'Balance Sheet Line'
    _order = 'sequence, id'

    wizard_id = fields.Many2one(
        'shahtaj.balance.sheet',
        required=True,
        ondelete='cascade',
    )
    sequence = fields.Integer(default=10)
    line_type = fields.Selection(
        [
            ('section', 'Section'),
            ('account', 'Account'),
            ('cye', 'Current Year Earnings'),
            ('total', 'Total'),
        ],
        required=True,
        default='account',
    )
    section = fields.Selection(
        [
            ('asset_current', 'Current Assets'),
            ('asset_non_current', 'Non-current Assets'),
            ('asset_total', 'Total Assets'),
            ('liability_current', 'Current Liabilities'),
            ('liability_non_current', 'Non-current Liabilities'),
            ('liability_total', 'Total Liabilities'),
            ('equity', 'Equity'),
            ('equity_unaffected', 'Undistributed Earnings'),
            ('equity_total', 'Total Equity'),
            ('le_total', 'Liabilities + Equity'),
        ],
        string='Section',
    )
    account_id = fields.Many2one('account.account', readonly=True)
    code = fields.Char(readonly=True)
    name = fields.Char(required=True, readonly=True)
    balance = fields.Monetary(currency_field='currency_id', readonly=True)
    currency_id = fields.Many2one(related='wizard_id.currency_id', readonly=True)

    def action_open_account_moves(self):
        self.ensure_one()
        if not self.account_id:
            return True
        wiz = self.wizard_id
        domain = wiz._shahtaj_aml_base_domain(
            wiz.company_id, date_from=None, date_to=wiz.date_to,
        ) + [('account_id', '=', self.account_id.id)]
        return {
            'type': 'ir.actions.act_window',
            'name': _('Items — %s', self.name),
            'res_model': 'account.move.line',
            'view_mode': 'list,form',
            'domain': domain,
        }
