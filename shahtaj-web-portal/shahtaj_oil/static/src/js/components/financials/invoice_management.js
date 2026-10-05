/** @odoo-module **/

import { Component, useState, onMounted, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { canMutate, canSee, hasFinancialAccess, loadPortalAccess, notifyPortalBusy, portalAccessState } from "../../shahtaj_access";
import { printFilter, printListPdf } from "../../shahtaj_list_export";
import { ConfirmModal } from "../confirm_modal";
import { ShopFilter } from "./shop_filter";
import {
    applyLookupsToState,
    getFinancialLookups,
    invalidateFinancialLookups,
    invalidateFinancialStats,
    requestFinancialTabSwitch,
} from "./financials_cache";

export class InvoiceManagement extends Component {
    static components = { ConfirmModal, ShopFilter };
    static props = {
        requestedInvoiceSubTab: { type: String, optional: true },
        requestedInvoiceStatus: { type: String, optional: true },
        refreshNonce: { type: Number, optional: true },
        onStatsRefresh: { type: Function, optional: true },
    };

    setup() {
        this.notification = useService("notification");
        this.orm = useService("orm");
        this.action = useService("action");
        this._listFetchToken = 0;
        const ITEMS_PER_PAGE = 50;
        this.state = useState({
            activeSubTab: "invoices",
            invoiceSubTab: this.props.requestedInvoiceSubTab || "all_orders",
            selectedOrder: null,
            selectedOrderLines: [],
            selectedInvoice: null,
            selectedInvoiceLines: [],
            isEditingInvoice: false,
            isSavingInvoice: false,
            isCreatingInvoice: false,
            isConfirming: false,
            isResetting: false,
            isCancelling: false,
            isPaying: false,
            isRefunding: false,
            isLoadingLines: false,
            selectedPayment: null,
            selectedShop: null,
            showPaymentModal: false,
            showRefundModal: false,
            showReturnModal: false,
            refundForm: { date: "", reason: "", mode: "full", lines: [] },
            removedLineIds: [],
            journals: [],
            products: [],
            allProducts: [],
            availableTaxes: [],
            availablePurchaseTaxes: [],
            allOrders: [],
            orders: [],
            invoices: [],
            creditNotes: [],
            payments: [],
            filters: {
                allOrders: { search: "", status: "all", shop: "all", shopName: "", dateFrom: "", dateTo: "" },
                orders: { search: "", shop: "all", shopName: "", dateFrom: "", dateTo: "" },
                invoices: { search: "", status: this.props.requestedInvoiceStatus || "all", shop: "all", shopName: "", dateFrom: "", dateTo: "", walkIn: false, legacyBalance: false },
                creditNotes: { search: "", status: "all", shop: "all", shopName: "", dateFrom: "", dateTo: "" },
                payments: { search: "", shop: "all", shopName: "", dateFrom: "", dateTo: "" },
            },
            paymentForm: {
                journal_id: "", amount: 0, date: "", invoice_id: null, invoice_name: "",
                method: "cash", bank_name: "", account_number: "", reference: "", notes: "",
            },
            confirmModal: { isOpen: false, title: "", message: "", onConfirm: null },
            collectModal: {
                open: false,
                deliveryManId: "",
                deliveryMen: [],
                shopId: "",
                shopSearch: "",
                shops: [],
                wizardId: null,
                walletBalance: 0,
                shopOutstanding: 0,
                lines: [],
                notes: "",
                loading: false,
            },
            itemsPerPage: ITEMS_PER_PAGE,
            isLoadingList: true,
            isPrintingList: false,
            searchTimeout: null,
            pagination: {
                allOrders: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                orders: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                invoices: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                creditNotes: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                payments: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
        });
        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchActiveList = this.debounceSearch(() => this.fetchActiveList(), 400);
        this._lookupsPromise = null;
        onWillUpdateProps((nextProps) => {
            const status = nextProps.requestedInvoiceStatus || "all";
            const statusChanged = status !== (this.props.requestedInvoiceStatus || "all");
            if (statusChanged) {
                this.state.filters.invoices.status = status;
                this.state.pagination.invoices.page = 1;
            }
            const subChanged = nextProps.requestedInvoiceSubTab && nextProps.requestedInvoiceSubTab !== this.props.requestedInvoiceSubTab;
            if (subChanged) {
                this.setInvoiceSubTab(nextProps.requestedInvoiceSubTab);
            } else if (statusChanged && this.state.invoiceSubTab === "customer_invoices") {
                this.fetchActiveList();
            }
            if (nextProps.refreshNonce !== this.props.refreshNonce) {
                this.reloadFromRefresh();
            }
        });
        onMounted(() => {
            this._bootInvoices();
        });
    }

    async _bootInvoices() {
        await loadPortalAccess();
        if (!hasFinancialAccess() && !canSee("financials", "invoices")) {
            this.state.isLoadingList = false;
            return;
        }
        if (canMutate()) {
            this._ensureLookups();
        }
        await this.fetchActiveList();
    }

    _ensureLookups() {
        if (!this._lookupsPromise) {
            this._lookupsPromise = this.loadLookups().catch((error) => {
                this._lookupsPromise = null;
                throw error;
            });
        }
        return this._lookupsPromise;
    }

    async loadLookups({ force = false } = {}) {
        const lookups = await getFinancialLookups(this.orm, { force });
        applyLookupsToState(this.state, lookups);
    }

    get canMutate() {
        return canMutate();
    }

    get isKpo() {
        return portalAccessState.role === "kpo";
    }

    async reloadFromRefresh() {
        if (canMutate()) {
            await this.loadLookups();
        }
        await this.fetchActiveList();
    }

    async fetchRealData(options = {}) {
        const includeLookups = options.includeLookups !== false;
        if (includeLookups) {
            invalidateFinancialLookups();
            await this.loadLookups({ force: true });
        }
        invalidateFinancialStats();
        if (this.props.onStatsRefresh) {
            await this.props.onStatsRefresh();
        }
    }

    requestTabSwitch(tabName, subTabName) {
        requestFinancialTabSwitch(tabName, subTabName);
    }

    closeReturnModal() {
        this.state.showReturnModal = false;
    }

    closeExpenseMoveModal() {
        this.state.showExpenseMoveModal = false;
        this.state.selectedExpenseMove = null;
    }

    onSearchInput(ev, listKey) {
        this.state.filters[listKey].search = ev.target.value;
        this.state.pagination[listKey].page = 1; // Reset to page 1 on new search
        this.debouncedFetchActiveList();
    }

    onFilterChange(listKey) {
        this.state.pagination[listKey].page = 1;
        this.fetchActiveList(); // Dropdowns don't need debouncing, fetch immediately
    }

    onShopFilterSelect(listKey, shopId, shopName) {
        const filters = this.state.filters[listKey];
        if (!filters) {
            return;
        }
        filters.shop = shopId || "all";
        filters.shopName = shopId && shopId !== "all" ? (shopName || "") : "";
        this.onFilterChange(listKey);
    }

    onInvoicesWalkInToggle(ev) {
        this.state.filters.invoices.walkIn = ev.target.checked;
        this.onFilterChange('invoices');
    }

    onInvoicesLegacyBalanceToggle(ev) {
        this.state.filters.invoices.legacyBalance = ev.target.checked;
        this.onFilterChange('invoices');
    }

    _defaultInvoiceFilters(key) {
        const defaults = {
            allOrders: { search: "", status: "all", shop: "all", shopName: "", dateFrom: "", dateTo: "" },
            orders: { search: "", shop: "all", shopName: "", dateFrom: "", dateTo: "" },
            invoices: { search: "", status: "all", shop: "all", shopName: "", dateFrom: "", dateTo: "", walkIn: false, legacyBalance: false },
            creditNotes: { search: "", status: "all", shop: "all", shopName: "", dateFrom: "", dateTo: "" },
            payments: { search: "", shop: "all", shopName: "", dateFrom: "", dateTo: "" },
        };
        return { ...(defaults[key] || {}) };
    }

    closeInvoiceDetail(listKey = "invoices") {
        this.state.selectedInvoice = null;
        this.state.selectedInvoiceLines = [];
        this.state.isEditingInvoice = false;
    }

    closeOrderDetail(listKey = "orders") {
        this.state.selectedOrder = null;
        this.state.selectedOrderLines = [];
    }

    closePaymentDetail() {
        this.state.selectedPayment = null;
    }

    clearFilters(listKey) {
        if (!this.state.filters[listKey]) {
            return;
        }
        this.state.filters[listKey] = this._defaultInvoiceFilters(listKey);
        if (this.state.pagination[listKey]) {
            this.state.pagination[listKey].page = 1;
        }
        if (Array.isArray(this.state[listKey])) {
            this.state[listKey] = [];
        }
        this.fetchActiveList();
    }

    _applyInvoiceListFilters(domain, stateKey, filters) {
        if (!filters) {
            return;
        }
        if (filters.shop && filters.shop !== "all") {
            const shopId = parseInt(filters.shop, 10);
            if (shopId) {
                domain.push(["partner_id", "=", shopId]);
            }
        }
        const dateFieldByKey = {
            allOrders: "date_order",
            orders: "date_order",
            invoices: "invoice_date",
            creditNotes: "invoice_date",
            payments: "date",
        };
        const dateField = dateFieldByKey[stateKey];
        if (!dateField) {
            return;
        }
        if (filters.dateFrom) {
            domain.push([dateField, ">=", filters.dateFrom]);
        }
        if (filters.dateTo) {
            const toValue = dateField === "date_order" ? `${filters.dateTo} 23:59:59` : filters.dateTo;
            domain.push([dateField, "<=", toValue]);
        }
    }

    onHasCreditLimitFilterChange(ev) {
        this.state.filters.credits.hasCreditLimit = Boolean(ev.target.checked);
        this.onFilterChange('credits');
    }

    changePage(listKey, direction) {
        const pag = this.state.pagination[listKey];
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchActiveList();
        }
    }

    setInvoiceSubTab(subTabName) { 
        this.state.invoiceSubTab = subTabName; 
        this.resetDetailViews(); 
        
        const stateKeyMap = {
            'all_orders': 'allOrders', 
            'orders': 'orders', 
            'customer_invoices': 'invoices',
            'credit_notes': 'creditNotes', 
            'payments': 'payments'
        };
        
        const key = stateKeyMap[subTabName];
        if (key && this.state.pagination[key]) {
            this.state.pagination[key].page = 1;
        }
        this.fetchActiveList(); 
    }

    _listDomain(stateKey, filters) {
        filters = filters || {};
        const domain = [];
        if (stateKey === "allOrders") domain.push(["shahtaj_visit_id", "!=", false]);
        if (stateKey === "orders") domain.push(["shahtaj_visit_id", "!=", false], ["invoice_status", "=", "to invoice"]);
        if (stateKey === "invoices") {
            domain.push(["move_type", "in", ["out_invoice"]]);
            if (filters.legacyBalance) {
                domain.push(["shahtaj_is_legacy_balance", "=", true]);
            } else if (filters.walkIn) {
                domain.push(["shahtaj_is_walk_in", "=", true]);
            } else {
                domain.push("|", ["partner_id.is_shahtaj_shop", "=", true], ["shahtaj_is_walk_in", "=", true]);
            }
        }
        if (stateKey === "creditNotes") domain.push(["move_type", "=", "out_refund"], ["partner_id.is_shahtaj_shop", "=", true]);
        if (stateKey === "payments") domain.push(["partner_id.is_shahtaj_shop", "=", true]);
        if (stateKey === "purchaseOrders") domain.push(["partner_id.supplier_rank", ">", 0]);
        if (stateKey === "receipts") domain.push(...this._receiptsListDomain());
        if (stateKey === "vendorBills") domain.push(["move_type", "in", ["in_invoice", "in_refund"]]);
        if (stateKey === "vendors") {
            domain.push(["supplier_rank", ">", 0], ["is_shahtaj_shop", "=", false]);
            if (this.state.vendorViewMode === "archived") {
                domain.push(["active", "=", false]);
            } else {
                domain.push(["active", "=", true]);
            }
        }
        if (stateKey === "credits") {
            domain.push(["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]);
            if (this.state.creditSubView === "risk") {
                domain.push(["shahtaj_shop_category", "=", "credit"]);
            }
            if (this.state.creditSubView === "balances" && this.state.filters.credits.hasCreditLimit) {
                domain.push(["credit_limit", ">", 0]);
            }
        }
        if (filters.search) {
            if (stateKey === "credits") {
                domain.push("|", ["name", "ilike", filters.search], ["owner_name", "ilike", filters.search]);
            } else if (stateKey === "vendors") {
                domain.push("|", "|", ["name", "ilike", filters.search], ["phone", "ilike", filters.search], ["email", "ilike", filters.search]);
            } else if (stateKey === "receipts") {
                domain.push("|", "|", ["name", "ilike", filters.search], ["origin", "ilike", filters.search], ["partner_id.name", "ilike", filters.search]);
            } else {
                domain.push("|", ["name", "ilike", filters.search], ["partner_id.name", "ilike", filters.search]);
            }
        }
        if (filters.status && filters.status !== "all") {
            if (stateKey === "invoices" || stateKey === "creditNotes") {
                if (filters.status === "Open") domain.push(["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]);
                if (filters.status === "Posted") domain.push(["state", "=", "posted"], ["payment_state", "in", ["not_paid"]]);
                if (filters.status === "Paid" || filters.status === "Paid/Reconciled") domain.push(["payment_state", "in", ["paid", "in_payment", "reversed"]]);
                if (filters.status === "Partial") domain.push(["payment_state", "=", "partial"]);
                if (filters.status === "Draft") domain.push(["state", "=", "draft"]);
                if (filters.status === "Cancelled") domain.push(["state", "=", "cancel"]);
            }
            if (stateKey === "allOrders") {
                if (filters.status === "Confirmed") domain.push(["state", "not in", ["draft", "cancel"]]);
                if (filters.status === "Draft") domain.push(["state", "=", "draft"]);
                if (filters.status === "Cancelled") domain.push(["state", "=", "cancel"]);
            }
            if (stateKey === "purchaseOrders") {
                if (filters.status === "Draft") domain.push(["state", "in", ["draft", "sent"]]);
                if (filters.status === "Confirmed") domain.push(["state", "=", "purchase"]);
                if (filters.status === "Cancelled") domain.push(["state", "=", "cancel"]);
                if (filters.status === "To Bill") domain.push(["invoice_status", "=", "to invoice"]);
            }
            if (stateKey === "receipts") {
                if (filters.status === "Ready") domain.push(["state", "in", ["assigned", "confirmed", "waiting"]]);
                if (filters.status === "Product Received") domain.push(["state", "=", "done"], ["picking_type_code", "=", "incoming"]);
                if (filters.status === "Returned") domain.push(["state", "=", "done"], ["picking_type_code", "=", "outgoing"]);
                if (filters.status === "Cancelled") domain.push(["state", "=", "cancel"]);
            }
            if (stateKey === "vendorBills") {
                if (filters.status === "Draft") domain.push(["state", "=", "draft"]);
                if (filters.status === "Posted") domain.push(["state", "=", "posted"], ["payment_state", "not in", ["paid", "in_payment", "reversed"]]);
                if (filters.status === "Paid") domain.push(["payment_state", "in", ["paid", "in_payment", "reversed"]]);
                if (filters.status === "Cancelled") domain.push(["state", "=", "cancel"]);
            }
        }
        this._applyInvoiceListFilters(domain, stateKey, filters);
        return domain;
    }

    async fetchActiveList() {
        if (!['invoices', 'expenses', 'credit', 'po_management'].includes(this.state.activeSubTab)) return;
        
        const tabMap = {
            'all_orders': { stateKey: 'allOrders', model: 'sale.order', fields: ["name", "partner_id", "date_order", "amount_total", "amount_untaxed", "state", "user_id", "payment_term_id", "pricelist_id", "shahtaj_visit_id", "invoice_status"] },
            'orders': { stateKey: 'orders', model: 'sale.order', fields: ["name", "partner_id", "date_order", "amount_total", "amount_untaxed", "state", "user_id", "payment_term_id", "pricelist_id", "shahtaj_visit_id", "invoice_status"] },
            'customer_invoices': { stateKey: 'invoices', model: 'account.move', fields: ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "journal_id", "shahtaj_is_walk_in", "shahtaj_is_legacy_balance"] },
            'credit_notes': { stateKey: 'creditNotes', model: 'account.move', fields: ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "journal_id"] },
            'payments': { stateKey: 'payments', model: 'account.payment', fields: ["name", "partner_id", "date", "amount", "journal_id", "memo", "state", "shahtaj_payment_channel", "shahtaj_payer_bank_name", "shahtaj_payer_account_number", "shahtaj_instrument_reference", "shahtaj_payment_notes"] },
            'purchase_orders': { stateKey: 'purchaseOrders', model: 'purchase.order', fields: ["name", "partner_id", "date_order", "date_planned", "amount_untaxed", "amount_tax", "amount_total", "state", "invoice_status", "currency_id"] },
            'receipts': { stateKey: 'receipts', model: 'stock.picking', fields: this._receiptFields() },
            'vendor_bills': { stateKey: 'vendorBills', model: 'account.move', fields: ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "invoice_origin", "move_type", "journal_id"] },
            'vendors': { stateKey: 'vendors', model: 'res.partner', fields: ["name", "phone", "email", "street", "city", "supplier_rank", "active"] },
            'credit': { stateKey: 'credits', model: 'res.partner', fields: ["name", "owner_name", "shahtaj_shop_category", "credit_limit", "outstanding_balance"] },
            'expenses': { stateKey: 'expenses', model: 'shahtaj.expense', fields: ['name', 'date', 'category_id', 'description', 'amount', 'journal_id', 'partner_id', 'state', 'move_name'] },
            'categories': { stateKey: 'expenseCategories', model: 'shahtaj.expense.category', fields: ['name', 'sequence', 'active', 'note'] }
        };

        const config = this.state.activeSubTab === 'credit' 
            ? tabMap['credit'] 
            : (this.state.activeSubTab === 'expenses' ? tabMap[this.state.expenseSubTab] : (this.state.activeSubTab === 'po_management' ? tabMap[this.state.poSubTab] : tabMap[this.state.invoiceSubTab]));
        if (!config) {
            this.state.isLoadingList = false;
            return;
        }

        const fetchToken = ++this._listFetchToken;
        this.state.isLoadingList = true;
        notifyPortalBusy(true);
        try {
            const { stateKey, model, fields } = config;
            const pag = this.state.pagination[stateKey];
            const filters = this.state.filters[stateKey];
            const domain = this._listDomain(stateKey, filters);

            // 4. FIRE DUAL QUERIES (Total Count + Paged Records)
            const queryContext = (stateKey === 'vendors' && this.state.vendorViewMode === 'archived') ? { active_test: false } : {};
            // outstanding_balance is computed/non-stored, so shop balances must be sorted in JS
            // (highest outstanding first) then sliced to keep pagination ranking correct.
            const sortShopBalances = stateKey === 'credits' && this.state.creditSubView === 'balances';
            let records;
            if (sortShopBalances) {
                const page = await this.orm.call(
                    "shahtaj.portal.read",
                    "shahtaj_credit_balance_page",
                    [{
                        search: (filters && filters.search) || "",
                        hasCreditLimit: Boolean(this.state.filters.credits && this.state.filters.credits.hasCreditLimit),
                        creditSubView: "balances",
                    }, pag.page, pag.limit],
                );
                if (fetchToken !== this._listFetchToken) {
                    return;
                }
                records = page.records || [];
                this.state.pagination[stateKey].total = page.total || 0;
            } else {
                const [total, fetchedRecords] = await Promise.all([
                    this.orm.searchCount(model, domain, { context: queryContext }),
                    this.orm.searchRead(model, domain, fields, {
                        limit: pag.limit,
                        offset: (pag.page - 1) * pag.limit,
                        order: "id desc",
                        context: queryContext,
                    }),
                ]);
                if (fetchToken !== this._listFetchToken) {
                    return;
                }
                records = fetchedRecords;
                this.state.pagination[stateKey].total = total;
            }
            // 5. MAP DATA TO UI
            if (stateKey === 'credits') {
                this.state.credits = records.map((shop) => {
                    const limit = shop.credit_limit || 0;
                    const utilized = shop.outstanding_balance || 0;
                    let status = "Healthy";
                    if (shop.shahtaj_shop_category === "cash") status = "Cash";
                    else if (limit > 0) {
                        if (utilized > limit) status = "Exceeded";
                        else if (utilized >= limit * 0.85) status = "Critical";
                    }
                    return {
                        id: shop.id, shopId: shop.id, shop: shop.name, owner: shop.owner_name || "N/A",
                        limit: shop.shahtaj_shop_category === "cash" ? "N/A" : limit.toLocaleString(),
                        rawLimit: limit, utilized: utilized.toLocaleString(), rawUtilized: utilized,
                        available: Math.max(0, limit - utilized).toLocaleString(), status,
                        outstanding: utilized.toLocaleString(), rawOutstanding: utilized,
                    };
                });
            }
            if (stateKey === 'invoices' || stateKey === 'creditNotes') {
                this.state[stateKey] = records.map((inv) => {
                    let status = "Draft";
                    if (inv.state === "cancel") status = "Cancelled";
                    else if (inv.state === "posted") {
                        if (["paid", "in_payment", "reversed"].includes(inv.payment_state)) status = stateKey === 'creditNotes' ? "Paid/Reconciled" : "Paid";
                        else if (inv.payment_state === "partial") status = "Partial";
                        else status = "Posted";
                    }
                    return {
                        id: inv.id, display_name: inv.name && inv.name !== "/" ? inv.name : `Draft Document (*${inv.id})`,
                        shop: inv.partner_id ? inv.partner_id[1] : "Unknown",
                        date: inv.invoice_date || "Not set", amount: (inv.amount_total || 0).toLocaleString(),
                        residual: (inv.amount_residual || 0).toLocaleString(), rawResidual: inv.amount_residual !== undefined ? inv.amount_residual : inv.amount_total,
                        status, journal_id: inv.journal_id ? inv.journal_id[0] : false,
                        isWalkIn: !!inv.shahtaj_is_walk_in,
                        isLegacyBalance: !!inv.shahtaj_is_legacy_balance,
                    };
                });
            }
            else if (stateKey === 'allOrders' || stateKey === 'orders') {
                this.state[stateKey] = records.map((o) => ({
                    id: o.id, display_name: o.name,
                    shop: o.partner_id ? o.partner_id[1] : "Unknown", shopId: o.partner_id ? o.partner_id[0] : false,
                    booker: o.user_id ? o.user_id[1] : "Unassigned", bookerId: o.user_id ? o.user_id[0] : false,
                    date: o.date_order ? o.date_order.split(" ")[0] : "N/A",
                    amount: (o.amount_total || 0).toLocaleString(), rawAmount: o.amount_total || 0,
                    untaxedAmount: (o.amount_untaxed || 0).toLocaleString(),
                    paymentTerms: o.payment_term_id ? o.payment_term_id[1] : "Immediate",
                    pricelist: o.pricelist_id ? o.pricelist_id[1] : "Default (PKR)",
                    visit: o.shahtaj_visit_id ? o.shahtaj_visit_id[1] : "N/A",
                    status: o.state === "cancel" ? "Cancelled" : (o.state === "draft" ? "Draft" : "Confirmed"),
                    invoice_status: o.invoice_status,
                }));
            }
            else if (stateKey === 'payments') {
                this.state.payments = records.map((pay) => ({
                    id: pay.id, display_name: pay.name ? pay.name : `Processing... (#${pay.id})`,
                    shop: pay.partner_id ? pay.partner_id[1] : "Unknown",
                    date: pay.date || "N/A", amount: (pay.amount || 0).toLocaleString(),
                    method: pay.journal_id ? pay.journal_id[1] : "Manual", ref: pay.memo || "N/A",
                    status: ["paid", "in_process", "posted", "reconciled"].includes(pay.state) ? "Paid" : (pay.state === "cancel" ? "Cancelled" : "Draft"),
                    channel: pay.shahtaj_payment_channel || "cash", bank: pay.shahtaj_payer_bank_name || "N/A",
                    account: pay.shahtaj_payer_account_number || "N/A", reference: pay.shahtaj_instrument_reference || "N/A",
                    notes: pay.shahtaj_payment_notes || "N/A",
                }));
            }
            else if (stateKey === 'purchaseOrders') {
                this.state.purchaseOrders = records.map((po) => this._mapPurchaseOrder(po));
            }
            else if (stateKey === 'receipts') {
                this.state.receipts = records.map((pick) => this._mapReceipt(pick));
            }
            else if (stateKey === 'vendorBills') {
                this.state.vendorBills = records.map((bill) => this._mapVendorBill(bill));
            }
            else if (stateKey === 'vendors') {
                this.state.vendors = records.map((vendor) => ({
                    id: vendor.id,
                    name: vendor.name,
                    phone: vendor.phone || 'N/A',
                    email: vendor.email || 'N/A',
                    address: [vendor.street, vendor.city].filter(Boolean).join(', ') || 'No address provided',
                    active: vendor.active !== false,
                }));
            }
            else if (stateKey === 'balances') {
                this.state.balances = records.map((shop) => ({
                    id: shop.id, shopId: shop.id, shop: shop.name, owner: shop.owner_name || "N/A",
                    category: shop.shahtaj_shop_category === "cash" ? "Cash" : "Credit",
                    limit: shop.shahtaj_shop_category === "cash" ? "N/A" : (shop.credit_limit || 0).toLocaleString(),
                    rawLimit: shop.credit_limit || 0, outstanding: (shop.outstanding_balance || 0).toLocaleString(),
                    rawOutstanding: shop.outstanding_balance || 0,
                }));
            }
            if (stateKey === 'expenses') {
                this.state.tableExpenses = records.map(e => ({
                    id: e.id, name: e.name, date: e.date,
                    category: e.category_id ? e.category_id[1] : 'Unknown',
                    description: e.description,
                    amount: (e.amount || 0).toLocaleString(undefined, {minimumFractionDigits: 2}),
                    journal: e.journal_id ? e.journal_id[1] : 'Unknown',
                    partner: e.partner_id ? e.partner_id[1] : 'None',
                    state: e.state, move_name: e.move_name || ''
                }));
            } else if (stateKey === 'expenseCategories') {
                this.state.tableExpenseCategories = records;
            }
        } catch (error) {
            if (fetchToken === this._listFetchToken) {
                this.notification.add("Failed to fetch list: " + (error.data?.message || error.message), { type: "danger" });
            }
        } finally {
            if (fetchToken === this._listFetchToken) {
                this.state.isLoadingList = false;
                notifyPortalBusy(false);
            }
        }
    }
    showConfirm(title, message, onConfirmCallback) {
        this.state.confirmModal = {
            isOpen: true,
            title: title,
            message: message,
            onConfirm: async () => {
                this.state.confirmModal.isOpen = false;
                if (onConfirmCallback) await onConfirmCallback();
            }
        };
    }

    closeConfirm() {
        this.state.confirmModal.isOpen = false;
    }
    async refreshFinancialLists() {
        await this.fetchRealData({ includeLookups: false, includePnl: this.state.activeSubTab === "pnl" });
        if (this.state.activeSubTab === "money") {
            await this.loadMoneyOverview();
        }
        // NEW: Instantly refresh the UI after confirming, drafting, or paying an invoice
        await this.fetchActiveList(); 
    }

    async loadMoneyOverview() {}

    async _refreshSelectedInvoiceState(invoiceId) {
        try {
            // Fetch the exact invoice from the database
            const records = await this.orm.searchRead(
                "account.move", 
                [["id", "=", invoiceId]], 
                ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "journal_id", "shahtaj_is_walk_in", "shahtaj_is_legacy_balance"]
            );
            
            if (records.length > 0) {
                const inv = records[0];
                let status = "Draft";
                if (inv.state === "cancel") status = "Cancelled";
                else if (inv.state === "posted") {
                    if (["paid", "in_payment", "reversed"].includes(inv.payment_state)) {
                        status = this.state.invoiceSubTab === 'credit_notes' ? "Paid/Reconciled" : "Paid";
                    }
                    else if (inv.payment_state === "partial") status = "Partial";
                    else status = "Posted";
                }
                
                // Build the master object (preserves header info)
                const mappedInv = {
                    id: inv.id, 
                    display_name: inv.name && inv.name !== "/" ? inv.name : `Draft Document (*${inv.id})`,
                    shop: inv.partner_id ? inv.partner_id[1] : "Unknown",
                    date: inv.invoice_date || "Not set", 
                    amount: (inv.amount_total || 0).toLocaleString(),
                    residual: (inv.amount_residual || 0).toLocaleString(), 
                    rawResidual: inv.amount_residual !== undefined ? inv.amount_residual : inv.amount_total,
                    status: status, 
                    journal_id: inv.journal_id ? inv.journal_id[0] : false,
                    isWalkIn: !!inv.shahtaj_is_walk_in,
                    isLegacyBalance: !!inv.shahtaj_is_legacy_balance,
                };
                
                // Automatically pipe it into viewInvoice to fetch the lines and restore the UI
                await this.viewInvoice(mappedInv);
            }
        } catch (error) {
            console.error("Failed to refresh invoice state:", error);
        }
    }
    resetDetailViews() {
        this.state.selectedInvoice = null;
        this.state.selectedInvoiceLines = [];
        this.state.isEditingInvoice = false;
        this.state.selectedOrder = null;
        this.state.selectedOrderLines = []; 
        this.state.selectedPayment = null;
        this.state.selectedShop = null;
        this.state.selectedExpense = null;
        this.state.selectedPurchaseOrder = null;
        this.state.selectedPurchaseOrderLines = [];
        this.state.selectedReceipt = null;
        this.state.selectedReceiptLines = [];
        this.state.selectedVendorBill = null;
        this.state.selectedVendorBillLines = [];
        this.state.selectedVendor = null;
        this.state.showVendorForm = false;
        this.state.showPurchaseOrderForm = false;
        this.state.isEditingPO = false;
        this.state.isEditingVendorBill = false;
        this.closePaymentModal();
        this.closeRefundModal();
        this.closeReturnModal();
        if (this.closeExpenseMoveModal) {
            this.closeExpenseMoveModal();
        }
    }
    async viewOrder(order) { 
        this.state.selectedOrder = order; 
        this.state.selectedOrderLines = []; 
        this.state.isLoadingLines = true; // Block UI while fetching

        try {
            const lines = await this.orm.searchRead(
                "sale.order.line",
                [["order_id", "=", order.odoo_id || order.id]],
                ["name", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "price_subtotal", "tax_ids"]
            );
            
            this.state.selectedOrderLines = lines.map(l => {
                const taxIds = l.tax_ids || [];
                const taxNames = taxIds.map(id => {
                    const tax = this.state.availableTaxes.find(t => t.id === id);
                    return tax ? tax.name : `Tax`;
                }).join(', ');

                return {
                    id: l.id,
                    product: l.name,
                    qty: l.product_uom_qty,
                    delivered: l.qty_delivered,
                    invoiced: l.qty_invoiced,
                    price: l.price_unit,
                    taxes: taxNames || 'None', 
                    subtotal: l.price_subtotal
                };
            });
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.isLoadingLines = false;
        }
    }
    
   async viewInvoice(invoice) {
        this.state.selectedInvoice = invoice;
        this.state.isEditingInvoice = false;
        this.state.isLoadingLines = true; 

        try {
            const invoiceDbId = invoice.odoo_id || invoice.id;

            const lines = await this.orm.searchRead(
                "account.move.line",
                [
                    ["move_id", "=", invoiceDbId],
                    ["display_type", "=", "product"] 
                ],
                ["id", "name", "product_id", "quantity", "price_unit", "tax_ids", "price_subtotal"]
            );

            const mappedLines = lines.map(l => {
                const taxIds = l.tax_ids || [];
                const taxNames = taxIds.map(id => {
                    const tax = this.state.availableTaxes.find(t => t.id === id);
                    return tax ? tax.name : `Tax`;
                }).join(', ');

                return {
                    id: l.id,
                    product_id: l.product_id ? l.product_id[0] : null, // Used by credit notes edit view
                    productId: l.product_id ? l.product_id[0] : null,   // Used by invoices edit view
                    product: l.name,
                    qty: l.quantity,
                    price: l.price_unit,
                    tax_id: taxIds.length > 0 ? taxIds[0] : "", 
                    taxes: taxNames || 'None',
                    subtotal: l.price_subtotal
                };
            });

            // FIX: Populate BOTH variables so whichever one your XML table looks at, it finds the data
            this.state.selectedInvoice.full_lines = mappedLines;
            this.state.selectedInvoiceLines = mappedLines;
            
            const moveData = await this.orm.read(
                "account.move", 
                [invoiceDbId], 
                ["amount_untaxed", "amount_tax", "amount_total"]
            );
            
            if (moveData.length > 0) {
                this.state.selectedInvoice.amount_untaxed = moveData[0].amount_untaxed;
                this.state.selectedInvoice.amount_tax = moveData[0].amount_tax;
                this.state.selectedInvoice.amount_total = moveData[0].amount_total;
            }
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.isLoadingLines = false; 
        }
    }
    viewPayment(payment) { this.state.selectedPayment = payment; }
    viewShop(shop) { this.state.selectedShop = { ...shop }; }

    async triggerCreateInvoice(order) {
        this.state.isCreatingInvoice = true;
        try {
            const invoiceIds = await this.orm.call("sale.order", "action_shahtaj_create_and_post_invoice", [[order.id]]);
            const invoiceId = Array.isArray(invoiceIds) ? invoiceIds[0] : invoiceIds;
            this.state.invoiceSubTab = 'customer_invoices';
            this.state.selectedOrder = null;
            this.state.selectedOrderLines = [];
            if (this.state.pagination.invoices) {
                this.state.pagination.invoices.page = 1;
            }
            await this.refreshFinancialLists();
            if (invoiceId) {
                await this._refreshSelectedInvoiceState(invoiceId);
            }
        } catch (error) { 
            this.notification.add(`Backend rejected the invoice creation:\n\n${error.data?.message || error.message}`, { type: "danger" });
        }
        this.state.isCreatingInvoice = false;
    }

    async actionConfirmInvoice(invoice) {
        this.state.isConfirming = true;
        try {
            await this.orm.call("account.move", "action_post", [[invoice.id]]);
            await this.refreshFinancialLists();
            await this._refreshSelectedInvoiceState(invoice.id); // ADDED AWAIT
        } catch (error) { this.notification.add(error.data?.message || error.message, { type: "danger" }); }
        this.state.isConfirming = false;
    }

    async actionResetToDraft(invoice) {
        this.state.isResetting = true;
        try {
            await this.orm.call("account.move", "button_draft", [[invoice.id]]);
            await this.refreshFinancialLists();
            await this._refreshSelectedInvoiceState(invoice.id);
        } catch (error) { this.notification.add(error.data?.message || error.message, { type: "danger" }); }
        this.state.isResetting = false;
    }

    actionCancelInvoice(invoice) {
        this.showConfirm("Cancel Document", "Are you sure you want to completely cancel this document? This action cannot be undone.", async () => {
            this.state.isCancelling = true;
            try {
                await this.orm.call("account.move", "button_cancel", [[invoice.id]]);
                await this.refreshFinancialLists();
                await this._refreshSelectedInvoiceState(invoice.id);
            } catch (error) { 
                this.notification.add("Failed to cancel invoice: " + (error.data?.message || error.message), { type: "danger" });
            }
            this.state.isCancelling = false;
        });
    }

    async toggleEditInvoice() {
        if (canMutate()) {
            try {
                await this._ensureLookups();
            } catch (error) {
                console.error("Failed to load invoice lookups", error);
            }
        }
        this.state.isEditingInvoice = true; 
        this.state.removedLineIds = [];
        
        // Populate editable array for credit notes
        if(this.state.invoiceSubTab === 'credit_notes') {
             this.state.selectedInvoiceLines = [...this.state.selectedInvoice.full_lines];
        }
    }
    
    cancelEditInvoice() { 
        this.state.isEditingInvoice = false; 
        this.viewInvoice(this.state.selectedInvoice); 
    }

    async addLine() {
        if (canMutate()) {
            try {
                await this._ensureLookups();
            } catch (error) {
                console.error("Failed to load invoice lookups", error);
            }
        }
        const newLine = {
            id: 'new_' + Date.now(),
            product_id: '',
            productId: '',
            product: '',
            qty: 1,
            price: 0,
            tax_id: "",
            taxes: 'None',
            subtotal: 0
        };
        
        if (this.state.invoiceSubTab === 'credit_notes') {
            this.state.selectedInvoiceLines.push(newLine);
        } else {
            this.state.selectedInvoice.full_lines.push(newLine);
        }
    }

    removeLine(lineIdOrIndex, lineObj) {
        const linesArray = this.state.invoiceSubTab === 'credit_notes' 
            ? this.state.selectedInvoiceLines 
            : this.state.selectedInvoice.full_lines;
            
        if (linesArray.length <= 1) {
            this.notification.add("An invoice must have at least one product line.", { type: "danger" });
            return;
        }

        const idToCheck = lineObj ? lineObj.id : lineIdOrIndex;
        
        if (idToCheck && !String(idToCheck).startsWith('new_')) {
            this.state.removedLineIds.push(idToCheck); 
        }

        if (this.state.invoiceSubTab === 'credit_notes') {
            this.state.selectedInvoiceLines = this.state.selectedInvoiceLines.filter(l => l.id !== idToCheck);
        } else {
            this.state.selectedInvoice.full_lines.splice(lineIdOrIndex, 1);
        }
    }

    async saveInvoiceEdits() {
        this.state.isSavingInvoice = true;
        try {
            const commands = [];
            for (const id of this.state.removedLineIds) {
                commands.push([2, id, false]);
            }
            
            const linesToSave = this.state.invoiceSubTab === 'credit_notes' 
                ? this.state.selectedInvoiceLines 
                : this.state.selectedInvoice.full_lines;

            for (const line of linesToSave) {
                const prodId = line.productId || line.product_id;
                if (!prodId) {
                    this.notification.add("Please select a product for all lines.", { type: "danger" });
                    this.state.isSavingInvoice = false;
                    return;
                }
                const vals = {
                    product_id: parseInt(prodId),
                    quantity: parseFloat(line.qty) || 1,
                    price_unit: parseFloat(line.price) || 0,
                    tax_ids: line.tax_id ? [[6, 0, [parseInt(line.tax_id)]]] : [[5, 0, 0]]
                };
                if (String(line.id).startsWith('new_')) {
                    commands.push([0, 0, vals]); 
                } else {
                    commands.push([1, line.id, vals]); 
                }
            }

            await this.orm.write("account.move", [this.state.selectedInvoice.id], {
                invoice_line_ids: commands
            });

            this.state.isEditingInvoice = false;
            await this.refreshFinancialLists();
            await this._refreshSelectedInvoiceState(this.state.selectedInvoice.id);
            await this.viewInvoice(this.state.selectedInvoice); 
        } catch (error) {
            this.notification.add("Failed to save invoice edits: " + (error.data?.message || error.message), { type: "danger" });
        }
        this.state.isSavingInvoice = false;
    }

    canIssueCreditNote(invoice) {
        return Boolean(
            invoice && ['Posted', 'Partial', 'Paid'].includes(invoice.status)
        );
    }

    getRefundEstimate() {
        const form = this.state.refundForm;
        if (!form) {
            return 0;
        }
        if (form.mode === 'full') {
            return this.state.selectedInvoice?.rawAmount || 0;
        }
        return (form.lines || []).reduce((sum, line) => {
            const qty = parseFloat(line.qty) || 0;
            const price = parseFloat(line.price) || 0;
            return sum + (qty * price);
        }, 0);
    }

    setRefundMode(mode) {
        this.state.refundForm.mode = mode;
        if (mode === 'partial' && this.state.refundForm.lines.length) {
            // Default return qty to full line qty; user reduces for partial returns.
            this.state.refundForm.lines = this.state.refundForm.lines.map((line) => ({
                ...line,
                qty: line.maxQty,
            }));
        }
    }

    async openRefundModal() {
        if (!this.state.selectedInvoice || !this.canIssueCreditNote(this.state.selectedInvoice)) {
            return;
        }
        const today = new Date().toISOString().split('T')[0];
        // Ensure product lines are loaded for partial mode.
        if (!this.state.selectedInvoice.full_lines?.length) {
            await this.viewInvoice(this.state.selectedInvoice);
        }
        const sourceLines = this.state.selectedInvoice.full_lines || [];
        this.state.refundForm = {
            date: today,
            reason: '',
            mode: 'full',
            lines: sourceLines.map((line) => ({
                sourceLineId: line.id,
                productId: line.productId || line.product_id || null,
                product: line.product || '',
                maxQty: parseFloat(line.qty) || 0,
                qty: parseFloat(line.qty) || 0,
                price: parseFloat(line.price) || 0,
                tax_id: line.tax_id || '',
            })),
        };
        this.state.showRefundModal = true;
    }

    closeRefundModal() {
        this.state.showRefundModal = false;
        this.state.refundForm = {
            date: '',
            reason: '',
            mode: 'full',
            lines: [],
        };
    }

    _validateRefundForm() {
        const form = this.state.refundForm;
        if (!form.date) {
            this.notification.add('Please select a refund date.', { type: "danger" });
            return false;
        }
        if (form.mode !== 'partial') {
            return true;
        }
        if (!form.lines.length) {
            this.notification.add('This invoice has no product lines to credit.', { type: "danger" });
            return false;
        }
        let hasReturn = false;
        for (const line of form.lines) {
            const qty = parseFloat(line.qty);
            if (Number.isNaN(qty) || qty < 0) {
                this.notification.add(`Invalid return quantity for "${line.product}".`, { type: "danger" });
                return false;
            }
            if (qty > line.maxQty) {
                this.notification.add(
                    `Return quantity for "${line.product}" cannot exceed invoiced qty (${line.maxQty}).`,
                    { type: "danger" }
                );
                return false;
            }
            if (qty > 0) {
                hasReturn = true;
            }
        }
        if (!hasReturn) {
            this.notification.add('Set at least one product return quantity greater than zero.', { type: "danger" });
            return false;
        }
        const isFullSelection = form.lines.every(
            (line) => (parseFloat(line.qty) || 0) === (parseFloat(line.maxQty) || 0)
        );
        if (isFullSelection) {
            // Treat as full credit note — no line surgery needed after reverse.
            form.mode = 'full';
        }
        return true;
    }

    async _applyPartialCreditNoteLines(creditNoteId) {
        const form = this.state.refundForm;
        const cnLines = await this.orm.searchRead(
            'account.move.line',
            [
                ['move_id', '=', creditNoteId],
                ['display_type', '=', 'product'],
            ],
            ['id', 'product_id', 'quantity', 'name']
        );
        cnLines.sort((a, b) => a.id - b.id);
        const sourceLines = form.lines || [];
        if (!cnLines.length || cnLines.length !== sourceLines.length) {
            return this._applyPartialCreditNoteLinesByProduct(creditNoteId, cnLines, sourceLines);
        }

        const commands = [];
        for (let i = 0; i < sourceLines.length; i++) {
            const src = sourceLines[i];
            const cnLine = cnLines[i];
            const qty = parseFloat(src.qty) || 0;
            if (qty <= 0) {
                commands.push([2, cnLine.id, false]);
            } else if (Math.abs(qty - (cnLine.quantity || 0)) > 1e-6) {
                commands.push([1, cnLine.id, { quantity: qty }]);
            }
        }
        if (!commands.length) {
            return;
        }
        await this.orm.write('account.move', [creditNoteId], {
            invoice_line_ids: commands,
        });
    }

    async _applyPartialCreditNoteLinesByProduct(creditNoteId, cnLines, sourceLines) {
        const pool = [...cnLines];
        const commands = [];
        for (const src of sourceLines) {
            const productId = src.productId ? parseInt(src.productId, 10) : null;
            const idx = pool.findIndex((line) => {
                const lineProductId = Array.isArray(line.product_id)
                    ? line.product_id[0]
                    : line.product_id;
                return productId && lineProductId === productId;
            });
            if (idx < 0) {
                continue;
            }
            const cnLine = pool.splice(idx, 1)[0];
            const qty = parseFloat(src.qty) || 0;
            if (qty <= 0) {
                commands.push([2, cnLine.id, false]);
            } else if (Math.abs(qty - (cnLine.quantity || 0)) > 1e-6) {
                commands.push([1, cnLine.id, { quantity: qty }]);
            }
        }
        for (const leftover of pool) {
            commands.push([2, leftover.id, false]);
        }
        if (!commands.length) {
            return;
        }
        await this.orm.write('account.move', [creditNoteId], {
            invoice_line_ids: commands,
        });
    }

    async processRefund() {
        if (!this._validateRefundForm()) {
            return;
        }
        this.state.isRefunding = true;
        const refundMode = this.state.refundForm.mode;
        try {
            const invoiceId = this.state.selectedInvoice.id;
            const context = { active_model: 'account.move', active_ids: [invoiceId] };
            const wizardIds = await this.orm.create('account.move.reversal', [{
                reason: this.state.refundForm.reason,
                date: this.state.refundForm.date,
                journal_id: this.state.selectedInvoice.journal_id,
            }], { context });
            
            const action = await this.orm.call('account.move.reversal', 'reverse_moves', [wizardIds], { context });
            const creditNoteId = action?.res_id;
            if (!creditNoteId) throw new Error('Credit note was created but could not be opened.');

            const [cnState] = await this.orm.read('account.move', [creditNoteId], ['state']);
            if (cnState?.state === 'posted' && refundMode === 'partial') {
                await this.orm.call('account.move', 'button_draft', [[creditNoteId]]);
            }

            if (refundMode === 'partial') await this._applyPartialCreditNoteLines(creditNoteId);

            this.closeRefundModal();
            
            // FIX: Change the tabs to Credit Notes BEFORE executing the refresh
            this.state.invoiceSubTab = 'credit_notes';
            this.state.activeSubTab = 'invoices';
            this.state.pagination.creditNotes.page = 1;

            await this.refreshFinancialLists();
            
            // Automatically open the detailed view using the newly generated Credit Note ID
            await this._refreshSelectedInvoiceState(creditNoteId);
            
            this.notification.add(
                refundMode === 'partial'
                    ? 'Partial credit note created as draft. Review lines, then Confirm Refund.'
                    : 'Credit note created as draft. Review and Confirm Refund when ready.',
                { type: 'success' }
            );
        } catch (error) {
            this.notification.add(`Refund failed:\n\n${error.data?.message || error.message}`, { type: "danger" });
        }
        this.state.isRefunding = false;
    }

    async actionPrintInvoice(invoiceId) {
        this.action.doAction({
            type: 'ir.actions.report',
            report_type: 'qweb-pdf',
            report_name: 'account.report_invoice_with_payments',
            report_file: 'account.report_invoice_with_payments',
            context: { active_ids: [invoiceId] },
        });
    }

    openPaymentModal() {
        const today = new Date().toISOString().split('T')[0];
        const doc = this.state.activeSubTab === 'po_management'
            ? this.state.selectedVendorBill
            : this.state.selectedInvoice;
        if (!doc) {
            return;
        }
        this.state.paymentForm = {
            journal_id: this.state.journals.length ? this.state.journals[0].id : '',
            amount: doc.rawResidual,
            date: today,
            invoice_id: doc.id,
            invoice_name: doc.display_name,
            method: 'cash',
            bank_name: '',
            account_number: '',
            reference: '',
            notes: ''
        };
        this.state.showPaymentModal = true;
    }

    closePaymentModal() { this.state.showPaymentModal = false; }

    formatMoney(value) {
        const amount = Number(value) || 0;
        return amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    _emptyCollectModal() {
        return {
            open: false,
            deliveryManId: "",
            deliveryMen: [],
            shopId: "",
            shopSearch: "",
            shops: [],
            wizardId: null,
            walletBalance: 0,
            shopOutstanding: 0,
            lines: [],
            notes: "",
            loading: false,
        };
    }

    async openCollectModal() {
        this.state.collectModal = {
            ...this._emptyCollectModal(),
            open: true,
        };
        await Promise.all([
            this.searchCollectShops(""),
            this.loadCollectDeliveryMen(),
        ]);
    }

    closeCollectModal() {
        this.state.collectModal.open = false;
        this.state.collectModal.wizardId = null;
        this.state.collectModal.lines = [];
    }

    async loadCollectDeliveryMen() {
        this.state.collectModal.deliveryMen = await this.orm.searchRead(
            "res.users",
            [["shahtaj_is_delivery_man", "=", true], ["active", "=", true]],
            ["id", "name"],
            { order: "name asc", limit: 200 },
        );
    }

    async searchCollectShops(query) {
        const domain = [
            ["is_shahtaj_shop", "=", true],
            ["shop_approval_state", "=", "approved"],
            ["active", "=", true],
        ];
        if (query) domain.push(["name", "ilike", query]);
        this.state.collectModal.shops = await this.orm.searchRead(
            "res.partner",
            domain,
            ["id", "name"],
            { limit: 30, order: "name asc" },
        );
    }

    onCollectShopSearch(ev) {
        this.state.collectModal.shopSearch = ev.target.value;
        clearTimeout(this.collectShopSearchTimeout);
        this.collectShopSearchTimeout = setTimeout(() => this.searchCollectShops(ev.target.value), 400);
    }

    async onCollectFieldChange() {
        await this.loadCollectWizard();
    }

    async loadCollectWizard() {
        const shopId = parseInt(this.state.collectModal.shopId, 10);
        const deliveryManId = parseInt(this.state.collectModal.deliveryManId, 10);
        if (!shopId || !deliveryManId) {
            this.state.collectModal.lines = [];
            this.state.collectModal.wizardId = null;
            this.state.collectModal.walletBalance = 0;
            this.state.collectModal.shopOutstanding = 0;
            return;
        }
        this.state.collectModal.loading = true;
        try {
            const wizardIds = await this.orm.create(
                "shahtaj.dm.collect.payment",
                [{}],
                { context: { default_delivery_man_id: deliveryManId, default_partner_id: shopId } },
            );
            const wizardId = Array.isArray(wizardIds) ? wizardIds[0] : wizardIds;
            const [wiz] = await this.orm.read(
                "shahtaj.dm.collect.payment",
                [wizardId],
                ["wallet_balance", "shop_outstanding", "line_ids", "notes"],
            );
            const lines = wiz.line_ids?.length
                ? await this.orm.read(
                    "shahtaj.dm.collect.payment.line",
                    wiz.line_ids,
                    ["id", "move_id", "amount_residual", "amount"],
                )
                : [];
            this.state.collectModal.wizardId = wizardId;
            this.state.collectModal.walletBalance = wiz.wallet_balance || 0;
            this.state.collectModal.shopOutstanding = wiz.shop_outstanding || 0;
            this.state.collectModal.lines = lines.map((l) => ({
                id: l.id,
                move: l.move_id ? l.move_id[1] : "Invoice",
                residual: l.amount_residual || 0,
                amount: l.amount || 0,
            }));
        } catch (error) {
            this.notification.add("Failed to load invoices: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.collectModal.loading = false;
        }
    }

    async fillCollectResiduals() {
        if (!this.state.collectModal.wizardId) return;
        this.state.collectModal.loading = true;
        try {
            await this.orm.call("shahtaj.dm.collect.payment", "action_fill_full_residuals", [[this.state.collectModal.wizardId]]);
            const lines = this.state.collectModal.lines;
            if (lines.length) {
                const refreshed = await this.orm.read(
                    "shahtaj.dm.collect.payment.line",
                    lines.map((l) => l.id),
                    ["id", "move_id", "amount_residual", "amount"],
                );
                this.state.collectModal.lines = refreshed.map((l) => ({
                    id: l.id,
                    move: l.move_id ? l.move_id[1] : "Invoice",
                    residual: l.amount_residual || 0,
                    amount: l.amount || 0,
                }));
            }
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.collectModal.loading = false;
        }
    }

    async confirmCollect() {
        if (!this.state.collectModal.wizardId) return;
        this.state.collectModal.loading = true;
        try {
            for (const line of this.state.collectModal.lines) {
                await this.orm.write("shahtaj.dm.collect.payment.line", [line.id], { amount: Number(line.amount) || 0 });
            }
            if (this.state.collectModal.notes) {
                await this.orm.write("shahtaj.dm.collect.payment", [this.state.collectModal.wizardId], {
                    notes: this.state.collectModal.notes,
                });
            }
            await this.orm.call("shahtaj.dm.collect.payment", "action_confirm", [[this.state.collectModal.wizardId]]);
            this.notification.add("Collected into DM wallet.", { type: "success" });
            this.closeCollectModal();
            await this.refreshFinancialLists();
        } catch (error) {
            this.notification.add("Collection failed: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.collectModal.loading = false;
        }
    }

    async processPayment() {
        this.state.isPaying = true;
        try {
            const form = this.state.paymentForm;
            const context = { active_model: 'account.move', active_ids: [form.invoice_id] };
            
            const wizardIds = await this.orm.create("account.payment.register", [{
                journal_id: parseInt(form.journal_id),
                amount: parseFloat(form.amount),
                payment_date: form.date,
                shahtaj_payment_channel: form.method,
                shahtaj_payer_bank_name: form.method === 'cheque' ? form.bank_name : false,
                shahtaj_payer_account_number: form.method === 'cheque' ? form.account_number : false,
                shahtaj_instrument_reference: form.method === 'cheque' ? form.reference : false,
                shahtaj_payment_notes: form.notes
            }], { context });
            
            await this.orm.call("account.payment.register", "action_create_payments", [wizardIds], { context });
            
            await this.refreshFinancialLists(); 
            this.closePaymentModal();
            if (this.state.activeSubTab === 'po_management') {
                await this._reloadVendorBill(form.invoice_id);
            } else {
                await this._refreshSelectedInvoiceState(form.invoice_id);
            }
            
        } catch (error) {
            this.notification.add(`Payment failed:\n\n${error.data?.message || error.message}`, { type: "danger" });
        }
        this.state.isPaying = false;
    }

    async saveShopBalance() {
        try {
            const shop = this.state.selectedShop;
            await this.orm.write("res.partner", [shop.id], { credit_limit: parseFloat(shop.rawLimit) });
            await this.refreshFinancialLists();
            this.state.selectedShop = null;
        } catch (error) { this.notification.add("Failed to save limit. Ensure you have distributor rights.", { type: "danger" }); }
    }

    _shopFilterName(filters) {
        if (!filters || !filters.shop || filters.shop === "all") {
            return "";
        }
        return filters.shopName || "";
    }

    _moveStatus(move, creditNote) {
        if (move.state === "cancel") return "Cancelled";
        if (move.state !== "posted") return "Draft";
        if (["paid", "in_payment", "reversed"].includes(move.payment_state)) {
            return creditNote ? "Paid/Reconciled" : "Paid";
        }
        if (move.payment_state === "partial") return "Partial";
        return "Posted";
    }

    async _loadPrintMoves(stateKey) {
        const fields = ["name", "partner_id", "invoice_date", "amount_total", "amount_residual", "payment_state", "state", "journal_id"];
        if (stateKey === "invoices") fields.push("shahtaj_is_walk_in", "shahtaj_is_legacy_balance");
        return this.orm.searchRead("account.move", this._listDomain(stateKey, this.state.filters[stateKey]), fields, { order: "id desc" });
    }

    async _openListPrint(title, filters, columns, rows) {
        if (!rows.length) {
            this.notification.add("No rows match the current filters.", { type: "warning" });
            return;
        }
        await printListPdf(this.orm, this.action, { title, filters, columns, rows });
    }

    async printCustomerInvoices() {
        if (this.state.isPrintingList) return;
        this.state.isPrintingList = true;
        try {
            const filters = this.state.filters.invoices;
            const statusLabels = {
                Open: "Open (unpaid or partial)",
                Posted: "Posted (Open)",
                Partial: "Partially Paid",
                Paid: "Paid",
                Draft: "Draft",
                Cancelled: "Cancelled",
            };
            const records = await this._loadPrintMoves("invoices");
            await this._openListPrint(
                "Customer Invoices",
                [
                    printFilter("Search", filters.search),
                    printFilter("Shop", this._shopFilterName(filters)),
                    printFilter("From", filters.dateFrom),
                    printFilter("To", filters.dateTo),
                    printFilter("Status", statusLabels[filters.status]),
                    printFilter("Walk In", filters.walkIn ? "Yes" : ""),
                    printFilter("Legacy Balance", filters.legacyBalance ? "Yes" : ""),
                ],
                ["Invoice #", "Walk-in", "Legacy Balance", "Billed Shop", "Date", "Total Amount", "Amount Due", "Billing Status"],
                records.map((inv) => [
                    inv.name && inv.name !== "/" ? inv.name : `Draft Document (*${inv.id})`,
                    inv.shahtaj_is_walk_in ? "Yes" : "",
                    inv.shahtaj_is_legacy_balance ? "Yes" : "",
                    inv.partner_id ? inv.partner_id[1] : "Unknown",
                    inv.invoice_date || "Not set",
                    `Rs. ${(inv.amount_total || 0).toLocaleString()}`,
                    `Rs. ${(inv.amount_residual !== undefined ? inv.amount_residual : inv.amount_total || 0).toLocaleString()}`,
                    this._moveStatus(inv, false),
                ]),
            );
        } catch (error) {
            this.notification.add(error?.data?.message || error?.message || "Print failed.", { type: "danger" });
        } finally {
            this.state.isPrintingList = false;
        }
    }

    async printCustomerPayments() {
        if (this.state.isPrintingList) return;
        this.state.isPrintingList = true;
        try {
            const filters = this.state.filters.payments;
            const records = await this.orm.searchRead(
                "account.payment",
                this._listDomain("payments", filters),
                ["name", "partner_id", "amount", "journal_id", "memo"],
                { order: "id desc" }
            );
            await this._openListPrint(
                "Customer Payments",
                [
                    printFilter("Search", filters.search),
                    printFilter("Shop", this._shopFilterName(filters)),
                    printFilter("From", filters.dateFrom),
                    printFilter("To", filters.dateTo),
                ],
                ["Receipt #", "Paid By Shop", "Journal / Bank", "Ref / Memo", "Received Amount"],
                records.map((pay) => [
                    pay.name ? pay.name : `Processing... (#${pay.id})`,
                    pay.partner_id ? pay.partner_id[1] : "Unknown",
                    pay.journal_id ? pay.journal_id[1] : "Manual",
                    pay.memo || "N/A",
                    `Rs. ${(pay.amount || 0).toLocaleString()}`,
                ]),
            );
        } catch (error) {
            this.notification.add(error?.data?.message || error?.message || "Print failed.", { type: "danger" });
        } finally {
            this.state.isPrintingList = false;
        }
    }

    async printCreditNotes() {
        if (this.state.isPrintingList) return;
        this.state.isPrintingList = true;
        try {
            const filters = this.state.filters.creditNotes;
            const records = await this._loadPrintMoves("creditNotes");
            await this._openListPrint(
                "Credit Notes",
                [
                    printFilter("Search", filters.search),
                    printFilter("Shop", this._shopFilterName(filters)),
                    printFilter("From", filters.dateFrom),
                    printFilter("To", filters.dateTo),
                    printFilter("Status", filters.status),
                ],
                ["Refund Ref #", "Customer Shop", "Date", "Refund Amount", "Status"],
                records.map((inv) => [
                    inv.name && inv.name !== "/" ? inv.name : `Draft Document (*${inv.id})`,
                    inv.partner_id ? inv.partner_id[1] : "Unknown",
                    inv.invoice_date || "Not set",
                    `Rs. ${(inv.amount_total || 0).toLocaleString()}`,
                    this._moveStatus(inv, true),
                ]),
            );
        } catch (error) {
            this.notification.add(error?.data?.message || error?.message || "Print failed.", { type: "danger" });
        } finally {
            this.state.isPrintingList = false;
        }
    }

    _receiptFields() {
        return ["name", "partner_id", "origin", "scheduled_date", "state", "purchase_id", "picking_type_code", "return_id"];
    }

    _receiptsListDomain() {
        return [];
    }

    _mapPurchaseOrder(po) { return po; }
    _mapReceipt(pick) { return pick; }
    _mapVendorBill(bill) { return bill; }

}

InvoiceManagement.template = "shahtaj_oil.FinancialsInvoiceManagement";
