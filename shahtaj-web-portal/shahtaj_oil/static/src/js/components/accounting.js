/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { session } from "@web/session";
import { ConfirmModal } from "./confirm_modal";
import { hasFinancialAccess } from "../shahtaj_access";

const ITEMS_PER_PAGE = 10;

const JOURNAL_LIST_FIELDS = ["id", "name", "type", "code", "active", "default_account_id", "currency_id"];
const JOURNAL_FORM_FIELDS = [
    "id", "name", "type", "code", "active", "currency_id", "default_account_id",
    "suspense_account_id", "non_deductible_account_id", "profit_account_id", "loss_account_id",
    "refund_sequence", "payment_sequence", "restrict_mode_hash_table", "is_self_billing",
    "invoice_reference_type", "invoice_reference_model",
    "bank_account_id", "bank_acc_number", "bank_id", "bank_statements_source",
    "inbound_payment_method_line_ids", "outbound_payment_method_line_ids",
];
const ACCOUNT_LIST_FIELDS = [
    "id", "code", "placeholder_code", "name", "account_type", "reconcile",
    "active", "tax_ids", "tag_ids", "currency_id", "non_trade",
];
const ACCOUNT_FORM_FIELDS = [...ACCOUNT_LIST_FIELDS, "description"];

const ACCOUNT_TYPE_GROUPS = {
    receivable: ["asset_receivable"],
    payable: ["liability_payable"],
    assets: ["asset_receivable", "asset_cash", "asset_current", "asset_non_current", "asset_prepayments", "asset_fixed"],
    liability: ["liability_payable", "liability_credit_card", "liability_current", "liability_non_current"],
    equity: ["equity", "equity_unaffected"],
    income: ["income", "income_other"],
    expenses: ["expense", "expense_other", "expense_depreciation", "expense_direct_cost"],
    off_balance: ["off_balance"],
};

const FALLBACK_JOURNAL_TYPES = [
    ["sale", "Sales"],
    ["purchase", "Purchase"],
    ["cash", "Cash"],
    ["bank", "Bank"],
    ["credit", "Credit Card"],
    ["general", "Miscellaneous"],
];

const FALLBACK_ACCOUNT_TYPES = [
    ["asset_receivable", "Receivable"],
    ["asset_cash", "Bank and Cash"],
    ["asset_current", "Current Assets"],
    ["asset_non_current", "Non-current Assets"],
    ["asset_prepayments", "Prepayments"],
    ["asset_fixed", "Fixed Assets"],
    ["liability_payable", "Payable"],
    ["liability_credit_card", "Credit Card"],
    ["liability_current", "Current Liabilities"],
    ["liability_non_current", "Non-current Liabilities"],
    ["equity", "Equity"],
    ["equity_unaffected", "Current Year Earnings"],
    ["income", "Income"],
    ["income_other", "Other Income"],
    ["expense", "Expenses"],
    ["expense_other", "Other Expenses"],
    ["expense_depreciation", "Depreciation"],
    ["expense_direct_cost", "Cost of Revenue"],
    ["off_balance", "Off-Balance Sheet"],
];

export class Accounting extends Component {
    static props = {
        requestedSubTab: { type: String, optional: true },
    };
    static components = { ConfirmModal };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            activeSubTab: this._normalizeSubTab(this.props.requestedSubTab || "journals"),
            isLoadingList: false,
            isSaving: false,
            isLoadingLines: false,
            searchTimeout: null,
            showJournalForm: false,
            journalPanel: "list",
            showAccountForm: false,
            tableJournals: [],
            tableAccounts: [],
            tableEntries: [],
            selectedEntry: null,
            selectedEntryLines: [],
            entryCount: 0,
            pagination: {
                journals: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                accounts: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                entries: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            filters: {
                journals: { search: "", type: "all" },
                accounts: { search: "", typeGroup: "all", prefix: "", status: "active" },
                entries: { search: "" },
            },
            lookups: {
                accounts: [],
                currencies: [],
                banks: [],
                partnerBanks: [],
                taxes: [],
                tags: [],
                paymentMethods: [],
            },
            selections: {
                journalTypes: FALLBACK_JOURNAL_TYPES,
                accountTypes: FALLBACK_ACCOUNT_TYPES,
                statementSources: [["undefined", "Undefined Yet"]],
                invoiceReferenceTypes: [["invoice", "Based on Invoice"], ["partner", "Based on Customer"]],
                invoiceReferenceModels: [["odoo", "Odoo"], ["euro", "European"], ["number", "Numbers only"]],
            },
            journalForm: this._emptyJournalForm(),
            companyPartnerId: false,
            inboundLines: [],
            outboundLines: [],
            removedPaymentLines: [],
            accountForm: this._emptyAccountForm(),
            confirmModal: { isOpen: false, title: "", message: "", onConfirm: null },
        });

        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchActiveList = this.debounceSearch(() => this.fetchActiveList(), 400);

        onWillStart(async () => {
            if (!hasFinancialAccess()) {
                return;
            }
            await this.loadLookups();
            await this.fetchActiveList();
        });
        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab && nextProps.requestedSubTab !== this.state.activeSubTab) {
                this.setSubTab(nextProps.requestedSubTab);
            }
        });
    }

    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    get journalType() {
        return this.state.journalForm.type || "general";
    }

    get isSaleJournal() { return this.journalType === "sale"; }
    get isPurchaseJournal() { return this.journalType === "purchase"; }
    get isCashJournal() { return this.journalType === "cash"; }
    get isBankJournal() { return this.journalType === "bank"; }
    get isCreditJournal() { return this.journalType === "credit"; }
    get isGeneralJournal() { return this.journalType === "general"; }
    get isLiquidityJournal() { return ["bank", "cash", "credit"].includes(this.journalType); }
    get showsProfitLoss() { return ["bank", "cash"].includes(this.journalType); }
    get showsRefundSequence() { return ["sale", "purchase"].includes(this.journalType); }
    get showsSelfBilling() { return ["sale", "purchase"].includes(this.journalType); }
    get showsHashLock() { return ["sale", "purchase", "general"].includes(this.journalType); }

    get defaultAccountLabel() {
        const labels = {
            bank: "Bank Account",
            credit: "Journal Account",
            cash: "Cash Account",
            sale: "Default Income Account",
            purchase: "Default Expense Account",
            general: "Default Account",
        };
        return labels[this.journalType] || "Default Account";
    }

    get defaultAccountEmptyLabel() {
        return ["bank", "cash", "credit"].includes(this.journalType) ? "Create new account" : "— None —";
    }

    get showsBankInstitution() {
        return this.isBankJournal && Boolean(this.state.journalForm.bank_account_id || this.state.journalForm.bank_acc_number);
    }

    get filteredDefaultAccounts() {
        return this._accountsWithSelected(this._accountsForJournalField("default"), this.state.journalForm.default_account_id);
    }

    get suspenseAccounts() {
        return this._accountsWithSelected(
            this.state.lookups.accounts.filter((a) => a.account_type === "asset_current"),
            this.state.journalForm.suspense_account_id
        );
    }

    get profitAccounts() {
        return this._accountsWithSelected(
            this.state.lookups.accounts.filter((a) => ["income", "income_other"].includes(a.account_type)),
            this.state.journalForm.profit_account_id
        );
    }

    get lossAccounts() {
        return this._accountsWithSelected(
            this.state.lookups.accounts.filter((a) =>
                ["expense", "expense_other", "expense_depreciation", "expense_direct_cost"].includes(a.account_type)
            ),
            this.state.journalForm.loss_account_id || this.state.journalForm.non_deductible_account_id
        );
    }

    get inboundPaymentMethods() {
        return this.state.lookups.paymentMethods.filter((m) => m.payment_type === "inbound");
    }

    get outboundPaymentMethods() {
        return this.state.lookups.paymentMethods.filter((m) => m.payment_type === "outbound");
    }

    get accountPrefixes() {
        const prefixes = new Set();
        for (const acc of this.state.lookups.accounts) {
            const code = String(acc.code || "");
            if (code.length >= 2) {
                prefixes.add(code.slice(0, 2));
            }
        }
        return [...prefixes].sort();
    }

    get accountTypeLockedReconcile() {
        const type = this.state.accountForm.account_type;
        if (["asset_receivable", "liability_payable"].includes(type)) {
            return "on";
        }
        if (["asset_cash", "liability_credit_card", "off_balance"].includes(type)) {
            return "off";
        }
        return "free";
    }

    get showsNonTrade() {
        return ["asset_receivable", "liability_payable"].includes(this.state.accountForm.account_type);
    }

    get showsAccountTaxes() {
        return this.state.accountForm.account_type !== "off_balance";
    }

    _normalizeSubTab(tabName) {
        return tabName === "accounts" ? "accounts" : "journals";
    }

    _emptyJournalForm() {
        return {
            id: null,
            name: "",
            type: "bank",
            code: "",
            active: true,
            currency_id: "",
            default_account_id: "",
            suspense_account_id: "",
            non_deductible_account_id: "",
            profit_account_id: "",
            loss_account_id: "",
            refund_sequence: true,
            payment_sequence: true,
            restrict_mode_hash_table: false,
            is_self_billing: false,
            invoice_reference_type: "invoice",
            invoice_reference_model: "odoo",
            bank_account_id: "",
            bank_acc_number: "",
            bank_id: "",
            bank_statements_source: "undefined",
        };
    }

    _emptyAccountForm() {
        return {
            id: null,
            code: "",
            name: "",
            account_type: "asset_current",
            reconcile: false,
            tax_ids: [],
            tag_ids: [],
            currency_id: "",
            non_trade: false,
            description: "",
            active: true,
        };
    }

    _many2oneId(value) {
        if (!value) {
            return "";
        }
        return String(Array.isArray(value) ? value[0] : value);
    }

    _many2oneName(value) {
        if (!value) {
            return "—";
        }
        return Array.isArray(value) ? value[1] : String(value);
    }

    _intOrFalse(value) {
        if (value === "" || value === null || value === undefined || value === false) {
            return false;
        }
        const parsed = parseInt(value, 10);
        return Number.isNaN(parsed) ? false : parsed;
    }

    _currentCompanyId() {
        return session.user_companies?.current_company || false;
    }

    _accountsForJournalField(kind) {
        const accounts = this.state.lookups.accounts;
        const type = this.journalType;
        if (kind === "default") {
            const matchers = {
                bank: (a) => ["asset_cash", "liability_credit_card"].includes(a.account_type),
                credit: (a) => a.account_type === "liability_credit_card",
                cash: (a) => a.account_type === "asset_cash",
                sale: (a) => ["income", "income_other"].includes(a.account_type),
                purchase: (a) => ["expense", "expense_depreciation", "expense_direct_cost"].includes(a.account_type),
                general: () => true,
            };
            return accounts.filter(matchers[type] || (() => true));
        }
        return accounts;
    }

    _accountsWithSelected(list, selectedId) {
        if (!selectedId) {
            return list;
        }
        const selected = String(selectedId);
        if (list.some((item) => String(item.id) === selected)) {
            return list;
        }
        const extra = this.state.lookups.accounts.find((item) => String(item.id) === selected);
        return extra ? [extra, ...list] : list;
    }

    optionId(id) {
        return id === false || id === null || id === undefined || id === "" ? "" : String(id);
    }

    isSelectedId(current, id) {
        return this.optionId(current) === this.optionId(id);
    }

    setJournalFormField(field, value) {
        this.state.journalForm[field] = this.optionId(value);
    }

    _idsLabel(ids, lookup) {
        if (!ids || !ids.length) {
            return "—";
        }
        const names = ids.map((id) => {
            const rec = lookup.find((item) => item.id === id);
            return rec ? rec.name : null;
        }).filter(Boolean);
        return names.join(", ") || "—";
    }

    journalTypeLabel(type) {
        const match = this.state.selections.journalTypes.find((item) => item[0] === type);
        return match ? match[1] : type;
    }

    accountTypeLabel(type) {
        const match = this.state.selections.accountTypes.find((item) => item[0] === type);
        return match ? match[1] : type;
    }

    _accountLabel(id) {
        if (!id) {
            return "—";
        }
        const rec = this.state.lookups.accounts.find((item) => String(item.id) === String(id));
        return rec ? `${rec.code || ""} ${rec.name}`.trim() : "—";
    }

    _currencyLabel(id) {
        if (!id) {
            return "Company currency";
        }
        const rec = this.state.lookups.currencies.find((item) => String(item.id) === String(id));
        return rec ? rec.name : "—";
    }

    _bankLabel(id) {
        if (!id) {
            return "—";
        }
        const rec = this.state.lookups.banks.find((item) => String(item.id) === String(id));
        return rec ? rec.name : "—";
    }

    _paymentMethodLabel(id) {
        if (!id) {
            return "—";
        }
        const rec = this.state.lookups.paymentMethods.find((item) => String(item.id) === String(id));
        return rec ? rec.name : "—";
    }

    _selectionLabel(list, value) {
        const match = (list || []).find((item) => item[0] === value);
        return match ? match[1] : (value || "—");
    }

    formatMoney(amount) {
        return Number(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    paymentMethodDisplay(id) {
        return this._paymentMethodLabel(id);
    }

    accountDisplay(id) {
        return this._accountLabel(id);
    }

    paymentAccountDisplay(id) {
        return id ? this._accountLabel(id) : "Journal default";
    }

    moveStateLabel(state) {
        if (state === "posted") return "Posted";
        if (state === "cancel") return "Cancelled";
        return "Draft";
    }

    entryStateBadgeClass(state) {
        if (state === "posted") return "bg-success text-white";
        if (state === "cancel") return "bg-danger text-white";
        return "bg-secondary text-white";
    }

    get journalActiveBadgeClass() {
        return this.state.journalForm.active === false ? "bg-secondary text-white" : "bg-success text-white";
    }

    moveTypeLabel(type) {
        const map = {
            entry: "Journal Entry",
            out_invoice: "Customer Invoice",
            out_refund: "Credit Note",
            in_invoice: "Vendor Bill",
            in_refund: "Vendor Credit Note",
            out_receipt: "Sales Receipt",
            in_receipt: "Purchase Receipt",
        };
        return map[type] || type || "Entry";
    }

    get defaultAccountDisplay() { return this._accountLabel(this.state.journalForm.default_account_id); }
    get suspenseAccountDisplay() { return this._accountLabel(this.state.journalForm.suspense_account_id); }
    get profitAccountDisplay() { return this._accountLabel(this.state.journalForm.profit_account_id); }
    get lossAccountDisplay() { return this._accountLabel(this.state.journalForm.loss_account_id); }
    get privateShareDisplay() { return this._accountLabel(this.state.journalForm.non_deductible_account_id); }
    get currencyDisplay() { return this._currencyLabel(this.state.journalForm.currency_id); }
    get bankDisplay() { return this._bankLabel(this.state.journalForm.bank_id); }
    get statementSourceDisplay() {
        return this._selectionLabel(this.state.selections.statementSources, this.state.journalForm.bank_statements_source);
    }
    get linkedBankAccountDisplay() {
        const id = this.state.journalForm.bank_account_id;
        if (!id) {
            return "—";
        }
        const rec = this.state.lookups.partnerBanks.find((item) => String(item.id) === String(id));
        return rec ? rec.acc_number : "—";
    }
    get invoiceReferenceTypeDisplay() {
        return this._selectionLabel(this.state.selections.invoiceReferenceTypes, this.state.journalForm.invoice_reference_type);
    }
    get invoiceReferenceModelDisplay() {
        return this._selectionLabel(this.state.selections.invoiceReferenceModels, this.state.journalForm.invoice_reference_model);
    }
    get selectedEntryDebitTotal() {
        return this.state.selectedEntryLines.reduce((sum, line) => sum + (line.debit || 0), 0);
    }
    get selectedEntryCreditTotal() {
        return this.state.selectedEntryLines.reduce((sum, line) => sum + (line.credit || 0), 0);
    }
    get journalTypeDisplay() {
        return this.journalTypeLabel(this.state.journalForm.type);
    }

    setSubTab(tabName) {
        const next = this._normalizeSubTab(tabName);
        this.state.activeSubTab = next;
        this.state.showJournalForm = false;
        this.state.showAccountForm = false;
        this._resetJournalPanel();
        this.state.pagination[next].page = 1;
        this.fetchActiveList();
    }

    onSearchInput(ev, tabName) {
        this.state.filters[tabName].search = ev.target.value;
        this.state.pagination[tabName].page = 1;
        this.debouncedFetchActiveList();
    }

    onFilterChange(tabName) {
        this.state.pagination[tabName].page = 1;
        this.fetchActiveList();
    }

    setAccountPrefix(prefix) {
        this.state.filters.accounts.prefix = this.state.filters.accounts.prefix === prefix ? "" : prefix;
        this.state.pagination.accounts.page = 1;
        this.fetchActiveList();
    }

    changePage(tabName, direction) {
        const pag = this.state.pagination[tabName];
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            if (tabName === "entries") {
                this._fetchJournalEntries();
            } else {
                this.fetchActiveList();
            }
        }
    }

    showConfirm(title, message, onConfirmCallback) {
        this.state.confirmModal = {
            isOpen: true,
            title,
            message,
            onConfirm: async () => {
                this.state.confirmModal.isOpen = false;
                await onConfirmCallback();
            },
        };
    }

    closeConfirm() {
        this.state.confirmModal.isOpen = false;
    }

    async loadLookups() {
        const safeRead = async (model, domain, fields, extra = {}) => {
            try {
                return await this.orm.searchRead(model, domain, fields, extra) || [];
            } catch (_error) {
                return [];
            }
        };
        try {
            const typeDefaults = await this.orm.call("account.journal", "shahtaj_get_journal_form_defaults", ["bank"]).catch(() => ({}));
            this.state.companyPartnerId = typeDefaults.company_partner_id || false;
            const partnerBankDomain = this.state.companyPartnerId
                ? [["partner_id", "=", this.state.companyPartnerId]]
                : [["id", "=", 0]];
            const [accounts, currencies, banks, partnerBanks, taxes, tags, paymentMethods, journalMeta, accountMeta] = await Promise.all([
                safeRead("account.account", [["active", "=", true]], ["id", "code", "name", "account_type"], { limit: 2000, order: "code" }),
                safeRead("res.currency", [["active", "=", true]], ["id", "name", "symbol"]),
                safeRead("res.bank", [], ["id", "name"], { limit: 500, order: "name" }),
                safeRead("res.partner.bank", partnerBankDomain, ["id", "acc_number", "bank_id", "partner_id"], { limit: 500, order: "acc_number" }),
                safeRead("account.tax", [["active", "=", true]], ["id", "name", "type_tax_use"]),
                safeRead("account.account.tag", [], ["id", "name"], { limit: 500 }),
                safeRead("account.payment.method", [], ["id", "name", "code", "payment_type"]),
                this.orm.call("account.journal", "fields_get", [[
                    "type", "bank_statements_source", "invoice_reference_type", "invoice_reference_model",
                ]], { attributes: ["selection"] }).catch(() => ({})),
                this.orm.call("account.account", "fields_get", [["account_type"]], { attributes: ["selection"] }).catch(() => ({})),
            ]);
            this.state.lookups.accounts = accounts;
            this.state.lookups.currencies = currencies;
            this.state.lookups.banks = banks;
            this.state.lookups.partnerBanks = partnerBanks;
            this.state.lookups.taxes = taxes;
            this.state.lookups.tags = tags;
            this.state.lookups.paymentMethods = paymentMethods;
            if (journalMeta?.type?.selection?.length) {
                this.state.selections.journalTypes = journalMeta.type.selection;
            }
            if (journalMeta?.bank_statements_source?.selection?.length) {
                this.state.selections.statementSources = journalMeta.bank_statements_source.selection;
            }
            if (journalMeta?.invoice_reference_type?.selection?.length) {
                this.state.selections.invoiceReferenceTypes = journalMeta.invoice_reference_type.selection;
            }
            if (journalMeta?.invoice_reference_model?.selection?.length) {
                this.state.selections.invoiceReferenceModels = journalMeta.invoice_reference_model.selection;
            }
            if (accountMeta?.account_type?.selection?.length) {
                this.state.selections.accountTypes = accountMeta.account_type.selection;
            }
        } catch (error) {
            this.notification.add("Failed to load accounting lookups: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async fetchActiveList() {
        if (!hasFinancialAccess()) {
            return;
        }
        const tab = this.state.activeSubTab;
        this.state.isLoadingList = true;
        try {
            if (tab === "journals") {
                if (this.state.journalPanel === "entries") {
                    await this._fetchJournalEntries();
                } else {
                    await this._fetchJournals();
                }
            } else {
                await this._fetchAccounts();
            }
        } catch (error) {
            this.notification.add("Failed to fetch list: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }

    async _fetchJournals() {
        const pag = this.state.pagination.journals;
        const filters = this.state.filters.journals;
        const domain = [];
        if (filters.type === "archived") {
            domain.push(["active", "=", false]);
        } else {
            domain.push(["active", "=", true]);
            if (filters.type === "sale") domain.push(["type", "=", "sale"]);
            else if (filters.type === "purchase") domain.push(["type", "=", "purchase"]);
            else if (filters.type === "liquidity") domain.push(["type", "in", ["bank", "cash", "credit"]]);
            else if (filters.type === "miscellaneous") domain.push(["type", "=", "general"]);
        }
        if (filters.search) {
            domain.push("|", ["name", "ilike", filters.search], ["code", "ilike", filters.search]);
        }
        const [total, records] = await Promise.all([
            this.orm.searchCount("account.journal", domain),
            this.orm.searchRead("account.journal", domain, JOURNAL_LIST_FIELDS, {
                limit: pag.limit,
                offset: (pag.page - 1) * pag.limit,
                order: "id desc",
            }),
        ]);
        this.state.pagination.journals.total = total;
        this.state.tableJournals = records.map((rec) => ({
            ...rec,
            typeLabel: this.journalTypeLabel(rec.type),
            accountLabel: this._many2oneName(rec.default_account_id),
            currencyLabel: this._many2oneName(rec.currency_id),
        }));
    }

    async _fetchAccounts() {
        const pag = this.state.pagination.accounts;
        const filters = this.state.filters.accounts;
        const domain = [];
        if (filters.status === "active") domain.push(["active", "=", true]);
        else if (filters.status === "inactive") domain.push(["active", "=", false]);
        const typeIds = ACCOUNT_TYPE_GROUPS[filters.typeGroup];
        if (typeIds) {
            domain.push(["account_type", "in", typeIds]);
        }
        if (filters.prefix) {
            domain.push(["code", "=like", `${filters.prefix}%`]);
        }
        if (filters.search) {
            domain.push("|", ["code", "ilike", filters.search], ["name", "ilike", filters.search]);
        }
        let records;
        let total;
        const readOpts = { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "code" };
        try {
            [total, records] = await Promise.all([
                this.orm.searchCount("account.account", domain),
                this.orm.searchRead("account.account", domain, ACCOUNT_LIST_FIELDS, {
                    ...readOpts,
                    order: "code, placeholder_code",
                }),
            ]);
        } catch (_error) {
            [total, records] = await Promise.all([
                this.orm.searchCount("account.account", domain),
                this.orm.searchRead("account.account", domain, ACCOUNT_LIST_FIELDS, readOpts),
            ]);
        }
        this.state.pagination.accounts.total = total;
        this.state.tableAccounts = records.map((rec) => ({
            ...rec,
            displayCode: rec.code || rec.placeholder_code || "—",
            typeLabel: this.accountTypeLabel(rec.account_type),
            taxLabel: this._idsLabel(rec.tax_ids, this.state.lookups.taxes),
            currencyLabel: this._many2oneName(rec.currency_id),
        }));
    }

    openJournalForm(journal = null) {
        this.state.removedPaymentLines = [];
        this.state.inboundLines = [];
        this.state.outboundLines = [];
        if (journal) {
            this._loadJournalRecord(journal.id, "form");
        } else {
            this.state.journalForm = this._emptyJournalForm();
            this.state.entryCount = 0;
            this.state.showJournalForm = true;
            this.state.journalPanel = "form";
            this._applyJournalTypeDefaults();
        }
    }

    async onJournalTypeChange() {
        await this._applyJournalTypeDefaults();
    }

    async _applyJournalTypeDefaults() {
        const journalType = this.state.journalForm.type || "general";
        try {
            const defaults = await this.orm.call("account.journal", "shahtaj_get_journal_form_defaults", [journalType]);
            this.state.companyPartnerId = defaults.company_partner_id || this.state.companyPartnerId;
            this.state.journalForm = {
                ...this.state.journalForm,
                code: defaults.code || "",
                default_account_id: this.optionId(defaults.default_account_id),
                suspense_account_id: this.optionId(defaults.suspense_account_id),
                profit_account_id: this.optionId(defaults.profit_account_id),
                loss_account_id: this.optionId(defaults.loss_account_id),
                non_deductible_account_id: this.isPurchaseJournal ? this.state.journalForm.non_deductible_account_id : "",
            };
        } catch (error) {
            this.notification.add("Failed to load journal defaults: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    onBankAccountChange() {
        const selectedId = this.state.journalForm.bank_account_id;
        const rec = this.state.lookups.partnerBanks.find((item) => String(item.id) === String(selectedId));
        if (rec) {
            this.state.journalForm.bank_acc_number = rec.acc_number || "";
            this.state.journalForm.bank_id = this._many2oneId(rec.bank_id);
        } else {
            this.state.journalForm.bank_acc_number = "";
            this.state.journalForm.bank_id = "";
        }
    }

    openJournalDetail(journal) {
        if (!journal?.id) {
            return;
        }
        this._loadJournalRecord(journal.id, "detail");
    }

    closeJournalForm() {
        if (this.state.journalForm.id) {
            this._loadJournalRecord(this.state.journalForm.id, "detail");
            return;
        }
        this._resetJournalPanel();
    }

    closeJournalDetail() {
        this._resetJournalPanel();
        this.fetchActiveList();
    }

    _resetJournalPanel() {
        this.state.showJournalForm = false;
        this.state.journalPanel = "list";
        this.state.journalForm = this._emptyJournalForm();
        this.state.inboundLines = [];
        this.state.outboundLines = [];
        this.state.removedPaymentLines = [];
        this.state.tableEntries = [];
        this.state.selectedEntry = null;
        this.state.selectedEntryLines = [];
        this.state.entryCount = 0;
        this.state.pagination.entries.page = 1;
        this.state.filters.entries.search = "";
    }

    async _loadJournalRecord(journalId, panel) {
        this.state.isLoadingList = true;
        try {
            const records = await this.orm.searchRead("account.journal", [["id", "=", journalId]], JOURNAL_FORM_FIELDS);
            if (!records.length) {
                this.notification.add("Journal not found.", { type: "warning" });
                return;
            }
            const rec = records[0];
            this.state.journalForm = {
                id: rec.id,
                name: rec.name || "",
                type: rec.type || "general",
                code: rec.code || "",
                active: rec.active !== false,
                currency_id: this._many2oneId(rec.currency_id),
                default_account_id: this._many2oneId(rec.default_account_id),
                suspense_account_id: this._many2oneId(rec.suspense_account_id),
                non_deductible_account_id: this._many2oneId(rec.non_deductible_account_id),
                profit_account_id: this._many2oneId(rec.profit_account_id),
                loss_account_id: this._many2oneId(rec.loss_account_id),
                refund_sequence: Boolean(rec.refund_sequence),
                payment_sequence: Boolean(rec.payment_sequence),
                restrict_mode_hash_table: Boolean(rec.restrict_mode_hash_table),
                is_self_billing: Boolean(rec.is_self_billing),
                invoice_reference_type: rec.invoice_reference_type || "invoice",
                invoice_reference_model: rec.invoice_reference_model || "odoo",
                bank_account_id: this._many2oneId(rec.bank_account_id),
                bank_acc_number: rec.bank_acc_number || "",
                bank_id: this._many2oneId(rec.bank_id),
                bank_statements_source: rec.bank_statements_source || "undefined",
            };
            this.state.inboundLines = [];
            this.state.outboundLines = [];
            this.state.removedPaymentLines = [];
            this.state.selectedEntry = null;
            this.state.selectedEntryLines = [];
            this.state.tableEntries = [];
            this.state.filters.entries.search = "";
            this.state.pagination.entries.page = 1;
            const inboundIds = rec.inbound_payment_method_line_ids || [];
            const outboundIds = rec.outbound_payment_method_line_ids || [];
            const lineIds = [...inboundIds, ...outboundIds];
            if (lineIds.length) {
                const lines = await this.orm.searchRead(
                    "account.payment.method.line",
                    [["id", "in", lineIds]],
                    ["id", "name", "payment_method_id", "payment_account_id"]
                );
                const mapLine = (line) => ({
                    id: line.id,
                    payment_method_id: this._many2oneId(line.payment_method_id),
                    name: line.name || "",
                    payment_account_id: this._many2oneId(line.payment_account_id),
                });
                this.state.inboundLines = lines.filter((line) => inboundIds.includes(line.id)).map(mapLine);
                this.state.outboundLines = lines.filter((line) => outboundIds.includes(line.id)).map(mapLine);
            }
            this.state.entryCount = await this.orm.searchCount("account.move", [["journal_id", "=", journalId]]);
            this.state.showJournalForm = panel === "form";
            this.state.journalPanel = panel;
        } catch (error) {
            this.notification.add("Failed to open journal: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }

    async openJournalEntries() {
        if (!this.state.journalForm.id) {
            return;
        }
        this.state.selectedEntry = null;
        this.state.selectedEntryLines = [];
        this.state.pagination.entries.page = 1;
        this.state.journalPanel = "entries";
        await this._fetchJournalEntries();
    }

    closeJournalEntries() {
        this.state.selectedEntry = null;
        this.state.selectedEntryLines = [];
        this.state.journalPanel = "detail";
    }

    async _fetchJournalEntries() {
        const journalId = this.state.journalForm.id;
        if (!journalId) {
            return;
        }
        const pag = this.state.pagination.entries;
        const search = this.state.filters.entries.search;
        const domain = [["journal_id", "=", journalId]];
        if (search) {
            domain.push("|", "|", ["name", "ilike", search], ["ref", "ilike", search], ["partner_id", "ilike", search]);
        }
        this.state.isLoadingList = true;
        try {
            const [total, records] = await Promise.all([
                this.orm.searchCount("account.move", domain),
                this.orm.searchRead(
                    "account.move",
                    domain,
                    ["id", "name", "date", "ref", "partner_id", "amount_total", "state", "move_type"],
                    { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "date desc, id desc" }
                ),
            ]);
            this.state.pagination.entries.total = total;
            this.state.tableEntries = records.map((rec) => ({
                id: rec.id,
                name: rec.name && rec.name !== "/" ? rec.name : `Draft (${rec.id})`,
                date: rec.date || "—",
                ref: rec.ref || "—",
                partner: rec.partner_id ? rec.partner_id[1] : "—",
                amount: this.formatMoney(rec.amount_total),
                state: rec.state,
                stateLabel: this.moveStateLabel(rec.state),
                moveType: rec.move_type,
                typeLabel: this.moveTypeLabel(rec.move_type),
            }));
        } catch (error) {
            this.notification.add("Failed to load journal entries: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }

    async viewJournalEntry(entry) {
        this.state.selectedEntry = {
            id: entry.id,
            name: entry.name,
            date: entry.date,
            ref: entry.ref,
            partner: entry.partner,
            amount: entry.amount,
            state: entry.state,
            stateLabel: entry.stateLabel,
            typeLabel: entry.typeLabel,
        };
        this.state.selectedEntryLines = [];
        this.state.isLoadingLines = true;
        try {
            const moves = await this.orm.searchRead(
                "account.move",
                [["id", "=", entry.id]],
                ["id", "name", "date", "ref", "partner_id", "amount_total", "state", "move_type"]
            );
            if (!moves.length) {
                this.notification.add("Journal entry not found.", { type: "warning" });
                this.closeJournalEntry();
                return;
            }
            const rec = moves[0];
            const lines = await this.orm.searchRead(
                "account.move.line",
                [["move_id", "=", rec.id]],
                ["id", "account_id", "name", "debit", "credit", "partner_id", "display_type"]
            );
            const itemLines = lines.filter(
                (line) => (line.debit || line.credit) && !["line_section", "line_note"].includes(line.display_type)
            );
            this.state.selectedEntry = {
                id: rec.id,
                name: rec.name && rec.name !== "/" ? rec.name : `Draft (${rec.id})`,
                date: rec.date || "—",
                ref: rec.ref || "—",
                partner: rec.partner_id ? rec.partner_id[1] : "—",
                amount: this.formatMoney(rec.amount_total),
                state: rec.state,
                stateLabel: this.moveStateLabel(rec.state),
                typeLabel: this.moveTypeLabel(rec.move_type),
            };
            this.state.selectedEntryLines = itemLines.map((line) => ({
                id: line.id,
                account: line.account_id ? line.account_id[1] : "—",
                label: line.name || "—",
                partner: line.partner_id ? line.partner_id[1] : "",
                debit: line.debit || 0,
                credit: line.credit || 0,
            }));
        } catch (error) {
            this.notification.add("Failed to open journal entry: " + (error.data?.message || error.message), { type: "danger" });
            this.closeJournalEntry();
        } finally {
            this.state.isLoadingLines = false;
        }
    }

    closeJournalEntry() {
        this.state.selectedEntry = null;
        this.state.selectedEntryLines = [];
    }

    async _loadJournalForm(journalId) {
        await this._loadJournalRecord(journalId, "form");
    }

    addPaymentLine(kind) {
        const line = {
            id: `new_${Date.now()}`,
            payment_method_id: "",
            name: "",
            payment_account_id: "",
        };
        if (kind === "inbound") {
            this.state.inboundLines.push(line);
        } else {
            this.state.outboundLines.push(line);
        }
    }

    removePaymentLine(kind, lineId) {
        const key = kind === "inbound" ? "inboundLines" : "outboundLines";
        const line = this.state[key].find((item) => item.id === lineId);
        if (line && !String(line.id).startsWith("new_")) {
            this.state.removedPaymentLines.push({ id: line.id, field: kind });
        }
        this.state[key] = this.state[key].filter((item) => item.id !== lineId);
    }

    _paymentLineCommands(lines, field) {
        const commands = [];
        for (const line of lines) {
            const vals = {
                payment_method_id: this._intOrFalse(line.payment_method_id),
                name: line.name || false,
                payment_account_id: this._intOrFalse(line.payment_account_id),
            };
            if (!vals.payment_method_id) {
                continue;
            }
            if (String(line.id).startsWith("new_")) {
                commands.push([0, 0, vals]);
            } else {
                commands.push([1, line.id, vals]);
            }
        }
        for (const removed of this.state.removedPaymentLines.filter((item) => item.field === field)) {
            commands.push([2, removed.id]);
        }
        return commands;
    }

    _journalVals(isCreate) {
        const f = this.state.journalForm;
        const vals = {
            name: f.name,
            type: f.type,
            code: f.code,
            active: Boolean(f.active),
        };
        const optional = {
            currency_id: this._intOrFalse(f.currency_id),
            default_account_id: this._intOrFalse(f.default_account_id),
        };
        if (this.isLiquidityJournal) {
            optional.suspense_account_id = this._intOrFalse(f.suspense_account_id);
            optional.payment_sequence = Boolean(f.payment_sequence);
            optional.bank_statements_source = f.bank_statements_source || "undefined";
        }
        if (this.isBankJournal) {
            if (f.bank_account_id) {
                optional.bank_account_id = this._intOrFalse(f.bank_account_id);
            } else if (f.bank_acc_number) {
                optional.bank_acc_number = f.bank_acc_number;
                optional.bank_id = this._intOrFalse(f.bank_id);
            }
        }
        if (this.showsProfitLoss) {
            optional.profit_account_id = this._intOrFalse(f.profit_account_id);
            optional.loss_account_id = this._intOrFalse(f.loss_account_id);
        }
        if (this.isPurchaseJournal) {
            optional.non_deductible_account_id = this._intOrFalse(f.non_deductible_account_id);
        }
        if (this.showsRefundSequence) {
            optional.refund_sequence = Boolean(f.refund_sequence);
        }
        if (this.showsSelfBilling) {
            optional.is_self_billing = Boolean(f.is_self_billing);
        }
        if (this.isSaleJournal) {
            optional.invoice_reference_type = f.invoice_reference_type || "invoice";
            optional.invoice_reference_model = f.invoice_reference_model || "odoo";
        }
        if (this.showsHashLock) {
            optional.restrict_mode_hash_table = Boolean(f.restrict_mode_hash_table);
        }
        if (!isCreate && this.isLiquidityJournal) {
            const inbound = this._paymentLineCommands(this.state.inboundLines, "inbound");
            const outbound = this._paymentLineCommands(this.state.outboundLines, "outbound");
            if (inbound.length) {
                optional.inbound_payment_method_line_ids = inbound;
            }
            if (outbound.length) {
                optional.outbound_payment_method_line_ids = outbound;
            }
        }
        if (isCreate) {
            for (const [key, value] of Object.entries(optional)) {
                if (value !== false && value !== "" && value !== undefined) {
                    vals[key] = value;
                }
            }
            return vals;
        }
        return { ...vals, ...optional };
    }

    async saveJournal() {
        const f = this.state.journalForm;
        if (!f.id && !f.code) {
            await this._applyJournalTypeDefaults();
        }
        if (!f.name) {
            this.notification.add("Journal name is required.", { type: "danger" });
            return;
        }
        if (!f.code) {
            this.notification.add("Sequence prefix is required.", { type: "danger" });
            return;
        }
        this.state.isSaving = true;
        try {
            if (f.id) {
                await this.orm.write("account.journal", [f.id], this._journalVals(false));
                this.notification.add("Journal updated.", { type: "success" });
                await this.loadLookups();
                await this._loadJournalRecord(f.id, "detail");
            } else {
                const createdIds = await this.orm.create("account.journal", [this._journalVals(true)]);
                const newId = Array.isArray(createdIds) ? createdIds[0] : createdIds;
                this.notification.add("Journal created.", { type: "success" });
                await this.loadLookups();
                if (newId) {
                    await this._loadJournalRecord(newId, "detail");
                } else {
                    this._resetJournalPanel();
                    await this.fetchActiveList();
                }
            }
        } catch (error) {
            this.notification.add("Failed to save journal: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isSaving = false;
        }
    }

    archiveJournal(journal) {
        this.showConfirm(
            journal.active === false ? "Restore Journal" : "Archive Journal",
            journal.active === false
                ? "Restore this journal so it can be used again?"
                : "Archive this journal? It will be hidden from the active list.",
            async () => {
                try {
                    await this.orm.write("account.journal", [journal.id], { active: journal.active === false });
                    if (this.state.journalForm.id === journal.id && this.state.journalPanel !== "list") {
                        await this._loadJournalRecord(journal.id, "detail");
                    } else {
                        await this.fetchActiveList();
                    }
                } catch (error) {
                    this.notification.add("Failed to update journal: " + (error.data?.message || error.message), { type: "danger" });
                }
            }
        );
    }

    openAccountForm(account = null) {
        if (account) {
            this._loadAccountForm(account.id);
        } else {
            this.state.accountForm = this._emptyAccountForm();
            this.state.showAccountForm = true;
        }
    }

    closeAccountForm() {
        this.state.showAccountForm = false;
        this.state.accountForm = this._emptyAccountForm();
    }

    async _loadAccountForm(accountId) {
        try {
            const records = await this.orm.searchRead("account.account", [["id", "=", accountId]], ACCOUNT_FORM_FIELDS);
            if (!records.length) {
                this.notification.add("Account not found.", { type: "warning" });
                return;
            }
            const rec = records[0];
            this.state.accountForm = {
                id: rec.id,
                code: rec.code || rec.placeholder_code || "",
                name: rec.name || "",
                account_type: rec.account_type || "asset_current",
                reconcile: Boolean(rec.reconcile),
                tax_ids: rec.tax_ids || [],
                tag_ids: rec.tag_ids || [],
                currency_id: this._many2oneId(rec.currency_id),
                non_trade: Boolean(rec.non_trade),
                description: rec.description || "",
                active: rec.active !== false,
            };
            this.state.showAccountForm = true;
        } catch (error) {
            this.notification.add("Failed to open account: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    onAccountTypeChange() {
        const lock = this.accountTypeLockedReconcile;
        if (lock === "on") {
            this.state.accountForm.reconcile = true;
        } else if (lock === "off") {
            this.state.accountForm.reconcile = false;
        }
        if (!this.showsNonTrade) {
            this.state.accountForm.non_trade = false;
        }
        if (!this.showsAccountTaxes) {
            this.state.accountForm.tax_ids = [];
        }
    }

    isSelectedId(ids, id) {
        return (ids || []).includes(id);
    }

    toggleFormId(field, id) {
        const current = this.state.accountForm[field] || [];
        if (current.includes(id)) {
            this.state.accountForm[field] = current.filter((item) => item !== id);
        } else {
            this.state.accountForm[field] = [...current, id];
        }
    }

    _accountVals() {
        const f = this.state.accountForm;
        const lock = this.accountTypeLockedReconcile;
        const reconcile = lock === "on" ? true : lock === "off" ? false : Boolean(f.reconcile);
        const vals = {
            name: f.name,
            code: f.code,
            account_type: f.account_type,
            reconcile,
            active: Boolean(f.active),
            currency_id: this._intOrFalse(f.currency_id),
            description: f.description || false,
            tax_ids: [[6, 0, this.showsAccountTaxes ? (f.tax_ids || []) : []]],
            tag_ids: [[6, 0, f.tag_ids || []]],
        };
        if (this.showsNonTrade) {
            vals.non_trade = Boolean(f.non_trade);
        }
        const companyId = this._currentCompanyId();
        if (!f.id && companyId) {
            vals.company_ids = [[6, 0, [companyId]]];
        }
        return vals;
    }

    async saveAccount() {
        const f = this.state.accountForm;
        if (!f.name || !f.code) {
            this.notification.add("Account code and name are required.", { type: "danger" });
            return;
        }
        this.state.isSaving = true;
        try {
            if (f.id) {
                await this.orm.write("account.account", [f.id], this._accountVals());
                this.notification.add("Account updated.", { type: "success" });
            } else {
                await this.orm.create("account.account", [this._accountVals()]);
                this.notification.add("Account created.", { type: "success" });
            }
            this.closeAccountForm();
            await this.loadLookups();
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add("Failed to save account: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isSaving = false;
        }
    }

    archiveAccount(account) {
        this.showConfirm(
            account.active === false ? "Restore Account" : "Archive Account",
            account.active === false
                ? "Restore this account so it can be used again?"
                : "Archive this account? It will be hidden from the active chart.",
            async () => {
                try {
                    await this.orm.write("account.account", [account.id], { active: account.active === false });
                    await this.loadLookups();
                    await this.fetchActiveList();
                } catch (error) {
                    this.notification.add("Failed to update account: " + (error.data?.message || error.message), { type: "danger" });
                }
            }
        );
    }
}

Accounting.template = "shahtaj_oil.Accounting";
