/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps, onWillUnmount } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess, notifyPortalBusy } from "../../shahtaj_access";
import { ConfirmModal } from "../confirm_modal";
import {
    applyLookupsToState,
    formatDate,
    getFinancialLookups,
    invalidateFinancialLookups,
    invalidateFinancialStats,
    requestFinancialTabSwitch,
} from "./financials_cache";
import { consumePendingPoPrefill, storePendingPoPrefill } from "./po_prefill";

export class PoManagement extends Component {
    static components = { ConfirmModal };
    static props = {
        requestedPoSubTab: { type: String, optional: true },
        refreshNonce: { type: Number, optional: true },
        onStatsRefresh: { type: Function, optional: true },
    };

    setup() {
        this.notification = useService("notification");
        this.orm = useService("orm");
        this.action = useService("action");
        const today = new Date();
        this.todayStr = formatDate(today);
        const ITEMS_PER_PAGE = 50;
        this.state = useState({
            activeSubTab: "po_management",
            poSubTab: this.props.requestedPoSubTab || "purchase_orders",
            selectedPurchaseOrder: null,
            selectedPurchaseOrderLines: [],
            selectedReceipt: null,
            selectedReceiptLines: [],
            selectedVendorBill: null,
            selectedVendorBillLines: [],
            selectedVendor: null,
            showPaymentModal: false,
            showRefundModal: false,
            showReturnModal: false,
            showVendorForm: false,
            showPurchaseOrderForm: false,
            isEditingPO: false,
            isEditingVendorBill: false,
            isSavingPO: false,
            isSavingVendorBill: false,
            isReturning: false,
            isConfirming: false,
            isResetting: false,
            isCancelling: false,
            isPaying: false,
            isLoadingLines: false,
            refundForm: { date: "", reason: "", mode: "full", lines: [] },
            returnForm: { lines: [] },
            removedPoLineIds: [],
            removedVendorBillLineIds: [],
            journals: [],
            products: [],
            allProducts: [],
            availableTaxes: [],
            availablePurchaseTaxes: [],
            purchaseOrders: [],
            receipts: [],
            vendorBills: [],
            vendors: [],
            filters: {
                purchaseOrders: { search: "", status: "all" },
                receipts: { search: "", status: "all" },
                vendorBills: { search: "", status: "all" },
                vendors: { search: "" },
            },
            paymentForm: {
                journal_id: "", amount: 0, date: "", invoice_id: null, invoice_name: "",
                method: "cash", bank_name: "", account_number: "", reference: "", notes: "",
            },
            confirmModal: { isOpen: false, title: "", message: "", onConfirm: null },
            itemsPerPage: ITEMS_PER_PAGE,
            isLoadingList: false,
            searchTimeout: null,
            pagination: {
                purchaseOrders: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                receipts: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                vendorBills: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                vendors: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            poLookups: { vendors: [], products: [] },
            vendorViewMode: "active",
            archivedVendorsCount: 0,
            vendorForm: { id: null, name: "", phone: "", email: "", street: "", city: "" },
            selectedVendorProducts: [],
            isLoadingVendorProducts: false,
            associateProductId: "",
            allActiveProductsForVendor: [],
            purchaseOrderForm: {
                id: null,
                partner_id: "",
                date_order: this.todayStr,
                date_planned: this.todayStr,
                lines: [],
            },
        });
        this._onOpenCreatePo = (ev) => {
            storePendingPoPrefill(ev.detail || {});
            this._consumePendingPoPrefill();
        };
        window.addEventListener("shahtaj-open-create-po", this._onOpenCreatePo);
        onWillUnmount(() => {
            window.removeEventListener("shahtaj-open-create-po", this._onOpenCreatePo);
        });
        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchActiveList = this.debounceSearch(() => this.fetchActiveList(), 400);
        onWillUpdateProps(async (nextProps) => {
            if (nextProps.requestedPoSubTab && nextProps.requestedPoSubTab !== this.props.requestedPoSubTab) {
                this.setPoSubTab(nextProps.requestedPoSubTab);
            }
            if (nextProps.refreshNonce !== this.props.refreshNonce) {
                await this.reloadFromRefresh();
            }
            await this._consumePendingPoPrefill();
        });
        onWillStart(async () => {
            if (!hasFinancialAccess()) {
                return;
            }
            await this.loadLookups();
            await this.fetchActiveList();
            await this._consumePendingPoPrefill();
        });
    }

    async loadLookups({ force = false } = {}) {
        const lookups = await getFinancialLookups(this.orm, { force });
        applyLookupsToState(this.state, lookups);
    }

    async reloadFromRefresh() {
        await this.loadLookups();
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

    closeRefundModal() {
        this.state.showRefundModal = false;
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

    changePage(listKey, direction) {
        const pag = this.state.pagination[listKey];
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchActiveList();
        }
    }
    setPoSubTab(subTabName) {
        const preservePoForm = this._preservePoForm;
        this._preservePoForm = false;
        this.state.poSubTab = subTabName;
        if (!preservePoForm) {
            this.resetDetailViews();
        }
        const stateKeyMap = {
            purchase_orders: 'purchaseOrders',
            receipts: 'receipts',
            vendor_bills: 'vendorBills',
            vendors: 'vendors',
        };
        const key = stateKeyMap[subTabName];
        if (key && this.state.pagination[key]) {
            this.state.pagination[key].page = 1;
        }
        this.fetchActiveList();
    }
    async fetchActiveList() {
        if (!['invoices', 'expenses', 'credit', 'po_management'].includes(this.state.activeSubTab)) return;
        
        const tabMap = {
            'all_orders': { stateKey: 'allOrders', model: 'sale.order', fields: ["name", "partner_id", "date_order", "amount_total", "amount_untaxed", "state", "user_id", "payment_term_id", "pricelist_id", "shahtaj_visit_id", "invoice_status"] },
            'orders': { stateKey: 'orders', model: 'sale.order', fields: ["name", "partner_id", "date_order", "amount_total", "amount_untaxed", "state", "user_id", "payment_term_id", "pricelist_id", "shahtaj_visit_id", "invoice_status"] },
            'customer_invoices': { stateKey: 'invoices', model: 'account.move', fields: ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "journal_id"] },
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
        if (!config) return;

        this.state.isLoadingList = true;
        notifyPortalBusy(true);
        try {
            const { stateKey, model, fields } = config;
            const pag = this.state.pagination[stateKey];
            const filters = this.state.filters[stateKey];
            let domain = [];
            if (["allOrders", "orders", "invoices", "creditNotes", "payments"].includes(stateKey)) {
                await this.ensureInvoiceShopLookup();
            }
            
            if (stateKey === 'allOrders') domain.push(["shahtaj_visit_id", "!=", false]);
            if (stateKey === 'orders') domain.push(["shahtaj_visit_id", "!=", false], ["invoice_status", "=", "to invoice"]);
            if (stateKey === 'invoices') domain.push(["move_type", "in", ["out_invoice"]], ["partner_id.is_shahtaj_shop", "=", true]);
            if (stateKey === 'creditNotes') domain.push(["move_type", "=", "out_refund"], ["partner_id.is_shahtaj_shop", "=", true]);
            if (stateKey === 'payments') domain.push(["partner_id.is_shahtaj_shop", "=", true]);
            if (stateKey === 'purchaseOrders') domain.push(["partner_id.supplier_rank", ">", 0]);
            if (stateKey === 'receipts') domain.push(...this._receiptsListDomain());
            if (stateKey === 'vendorBills') domain.push(["move_type", "in", ["in_invoice", "in_refund"]]);
            if (stateKey === 'vendors') {
                domain.push(["supplier_rank", ">", 0], ["is_shahtaj_shop", "=", false]);
                if (this.state.vendorViewMode === 'archived') {
                    domain.push(["active", "=", false]);
                } else {
                    domain.push(["active", "=", true]);
                }
            }
            if (stateKey === 'credits') {
                domain.push(["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]);
                if (this.state.creditSubView === 'risk') {
                    domain.push(["shahtaj_shop_category", "=", "credit"]);
                }
                if (this.state.creditSubView === 'balances' && this.state.filters.credits.hasCreditLimit) {
                    domain.push(["credit_limit", ">", 0]);
                }
            }

            if (filters.search) {
                if (stateKey === 'credits') {
                    domain.push('|', ['name', 'ilike', filters.search], ['owner_name', 'ilike', filters.search]);
                } else if (stateKey === 'vendors') {
                    domain.push('|', '|', ['name', 'ilike', filters.search], ['phone', 'ilike', filters.search], ['email', 'ilike', filters.search]);
                } else if (stateKey === 'receipts') {
                    domain.push('|', '|', ['name', 'ilike', filters.search], ['origin', 'ilike', filters.search], ['partner_id.name', 'ilike', filters.search]);
                } else {
                    domain.push('|', ['name', 'ilike', filters.search], ['partner_id.name', 'ilike', filters.search]);
                }
            }

            if (filters.status && filters.status !== 'all') {
                if (stateKey === 'invoices' || stateKey === 'creditNotes') {
                    if (filters.status === 'Posted') domain.push(['state', '=', 'posted'], ['payment_state', 'in', ['not_paid']]);
                    if (filters.status === 'Paid' || filters.status === 'Paid/Reconciled') domain.push(['payment_state', 'in', ['paid', 'in_payment', 'reversed']]);
                    if (filters.status === 'Partial') domain.push(['payment_state', '=', 'partial']);
                    if (filters.status === 'Draft') domain.push(['state', '=', 'draft']);
                    if (filters.status === 'Cancelled') domain.push(['state', '=', 'cancel']);
                }
                if (stateKey === 'allOrders') {
                    if (filters.status === 'Confirmed') domain.push(['state', 'not in', ['draft', 'cancel']]);
                    if (filters.status === 'Draft') domain.push(['state', '=', 'draft']);
                    if (filters.status === 'Cancelled') domain.push(['state', '=', 'cancel']);
                }
                if (stateKey === 'purchaseOrders') {
                    if (filters.status === 'Draft') domain.push(['state', 'in', ['draft', 'sent']]);
                    if (filters.status === 'Confirmed') domain.push(['state', '=', 'purchase']);
                    if (filters.status === 'Cancelled') domain.push(['state', '=', 'cancel']);
                    if (filters.status === 'To Bill') domain.push(['invoice_status', '=', 'to invoice']);
                }
                if (stateKey === 'receipts') {
                    if (filters.status === 'Ready') domain.push(['state', 'in', ['assigned', 'confirmed', 'waiting']]);
                    if (filters.status === 'Product Received') domain.push(['state', '=', 'done'], ['picking_type_code', '=', 'incoming']);
                    if (filters.status === 'Returned') domain.push(['state', '=', 'done'], ['picking_type_code', '=', 'outgoing']);
                    if (filters.status === 'Cancelled') domain.push(['state', '=', 'cancel']);
                }
                if (stateKey === 'vendorBills') {
                    if (filters.status === 'Draft') domain.push(['state', '=', 'draft']);
                    if (filters.status === 'Posted') domain.push(['state', '=', 'posted'], ['payment_state', 'not in', ['paid', 'in_payment', 'reversed']]);
                    if (filters.status === 'Paid') domain.push(['payment_state', 'in', ['paid', 'in_payment', 'reversed']]);
                    if (filters.status === 'Cancelled') domain.push(['state', '=', 'cancel']);
                }
            }

            this._applyInvoiceListFilters(domain, stateKey, filters);

            // 4. FIRE DUAL QUERIES (Total Count + Paged Records)
            const queryContext = (stateKey === 'vendors' && this.state.vendorViewMode === 'archived') ? { active_test: false } : {};
            // outstanding_balance is computed/non-stored, so shop balances must be sorted in JS
            // (highest outstanding first) then sliced to keep pagination ranking correct.
            const sortShopBalances = stateKey === 'credits' && this.state.creditSubView === 'balances';
            const searchReadOptions = sortShopBalances
                ? { context: queryContext }
                : { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "id desc", context: queryContext };
            const [total, fetchedRecords] = await Promise.all([
                sortShopBalances ? Promise.resolve(0) : this.orm.searchCount(model, domain, { context: queryContext }),
                this.orm.searchRead(model, domain, fields, searchReadOptions)
            ]);
            let records = fetchedRecords;
            if (sortShopBalances) {
                records = [...fetchedRecords].sort((a, b) => (b.outstanding_balance || 0) - (a.outstanding_balance || 0));
                this.state.pagination[stateKey].total = records.length;
                const start = (pag.page - 1) * pag.limit;
                records = records.slice(start, start + pag.limit);
            } else {
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
            this.notification.add("Failed to fetch list: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
            notifyPortalBusy(false);
        }
    }
    requestTabSwitch(tabName, subTabName) {
        requestFinancialTabSwitch(tabName, subTabName);
        if (tabName === "financials" && ["purchase_orders", "receipts", "vendor_bills", "vendors"].includes(subTabName)) {
            this.setPoSubTab(subTabName);
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
    openVendorForm(vendor = null) {
        this.state.vendorForm = vendor
            ? {
                id: vendor.id,
                name: vendor.name || '',
                phone: vendor.phone === 'N/A' ? '' : (vendor.phone || ''),
                email: vendor.email === 'N/A' ? '' : (vendor.email || ''),
                street: vendor.street || '',
                city: vendor.city || '',
            }
            : { id: null, name: '', phone: '', email: '', street: '', city: '' };
        this.state.showVendorForm = true;
    }

    setVendorViewMode(mode) {
        this.state.vendorViewMode = mode;
        this.state.selectedVendor = null;
        this.state.pagination.vendors.page = 1;
        this.fetchActiveList();
    }

    async toggleArchiveVendor(vendor, makeActive) {
        const actionText = makeActive ? "restore" : "archive";
        const title = makeActive ? "Restore Vendor" : "Archive Vendor";
        const message = makeActive
            ? `Are you sure you want to restore "${vendor.name}" to active vendors?`
            : `Are you sure you want to archive "${vendor.name}"? They will be moved to the Archived vendors list and hidden from active purchase order creation.`;

        this.showConfirm(title, message, async () => {
            try {
                await this.orm.call("res.partner", "action_shahtaj_toggle_archive_vendor", [], {
                    vendor_id: vendor.id,
                    active: makeActive,
                });
                this.notification.add(`Vendor "${vendor.name}" ${makeActive ? 'restored' : 'archived'} successfully.`, { type: "success" });
                this.state.selectedVendor = null;
                await this.fetchRealData({ includeLookups: true });
                await this.fetchActiveList();
            } catch (error) {
                this.notification.add(`Failed to ${actionText} vendor: ` + (error.data?.message || error.message), { type: "danger" });
            }
        });
    }

    async deleteVendor(vendor) {
        this.showConfirm(
            "Delete Vendor",
            `Are you sure you want to permanently delete vendor "${vendor.name}"?\n\nNote: If this vendor has existing purchase orders or invoices, they cannot be deleted and should be archived instead.`,
            async () => {
                try {
                    await this.orm.call("res.partner", "action_shahtaj_delete_vendor", [], {
                        vendor_id: vendor.id,
                    });
                    this.notification.add(`Vendor "${vendor.name}" deleted successfully.`, { type: "success" });
                    this.state.selectedVendor = null;
                    await this.fetchRealData({ includeLookups: true });
                    await this.fetchActiveList();
                } catch (error) {
                    this.notification.add("Failed to delete vendor: " + (error.data?.message || error.message), { type: "danger" });
                }
            }
        );
    }

    resetPurchaseOrderForm() {
        this.state.purchaseOrderForm = {
            id: null,
            partner_id: '',
            date_order: this.todayStr,
            date_planned: this.todayStr,
            lines: [this._emptyPurchaseOrderLine()],
        };
    }

    _emptyPurchaseOrderLine() {
        return {
            id: `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            product_id: '',
            qty: 1,
            price_unit: 0,
            tax_id: "",
            uom_po_id: false,
        };
    }

    get poSelectedVendorId() {
        return this.state.purchaseOrderForm.partner_id ? parseInt(this.state.purchaseOrderForm.partner_id, 10) : null;
    }

    get poAssociatedProducts() {
        const vendorId = this.poSelectedVendorId;
        if (!vendorId) return [];
        return (this.state.products || []).filter((p) => p.vendor_id === vendorId);
    }

    get poOtherProducts() {
        const vendorId = this.poSelectedVendorId;
        if (!vendorId) return this.state.products || [];
        return (this.state.products || []).filter((p) => p.vendor_id !== vendorId);
    }

    get poAvailableProducts() {
        const vendorId = this.poSelectedVendorId;
        if (!vendorId) {
            return this.state.products || [];
        }
        const associated = this.poAssociatedProducts;
        return associated.length > 0 ? associated : (this.state.products || []);
    }

    onPoVendorChange() {
        const vendorId = this.poSelectedVendorId;
        if (!vendorId) return;
        const associated = this.poAssociatedProducts;
        for (const line of this.state.purchaseOrderForm.lines) {
            if (line.product_id) {
                if (associated.length > 0) {
                    const isAssociated = associated.some((p) =>
                        String(p.id) === String(line.product_id) || String(p.product_tmpl_id) === String(line.product_id)
                    );
                    if (!isAssociated) {
                        line.product_id = '';
                        line.price_unit = 0;
                        line.product = '';
                    } else {
                        this.onPurchaseProductChange(line, vendorId);
                    }
                } else {
                    this.onPurchaseProductChange(line, vendorId);
                }
            }
        }
    }

    openPurchaseOrderForm() {
        this.resetPurchaseOrderForm();
        this.state.showPurchaseOrderForm = true;
    }

    addPurchaseOrderLine() {
        this.state.purchaseOrderForm.lines.push(this._emptyPurchaseOrderLine());
    }

    removePurchaseOrderLine(lineId) {
        if (this.state.purchaseOrderForm.lines.length <= 1) {
            this.notification.add("A purchase order must have at least one line.", { type: "warning" });
            return;
        }
        this.state.purchaseOrderForm.lines = this.state.purchaseOrderForm.lines.filter((line) => line.id !== lineId);
    }

    statusBadgeClass(status) {
        const map = {
            Draft: "bg-secondary text-dark",
            Confirmed: "bg-primary text-white",
            "To Approve": "bg-warning text-dark",
            Ready: "bg-info text-white",
            Waiting: "bg-warning text-dark",
            "Product Received": "bg-success text-white",
            Returned: "bg-warning text-dark",
            Posted: "bg-info text-white",
            Partial: "bg-warning text-dark",
            Paid: "bg-success text-white",
            Cancelled: "bg-danger text-white",
        };
        return map[status] || "bg-light border text-dark";
    }

    statusBorderClass(status) {
        const map = {
            Draft: "border-secondary",
            Confirmed: "border-primary",
            "To Approve": "border-warning",
            Ready: "border-info",
            Waiting: "border-warning",
            "Product Received": "border-success",
            Returned: "border-warning",
            Posted: "border-info",
            Partial: "border-warning",
            Paid: "border-success",
            Cancelled: "border-danger",
        };
        return map[status] || "border-secondary";
    }

    _taxLabel(taxIds) {
        const taxes = [...(this.state.availablePurchaseTaxes || []), ...(this.state.availableTaxes || [])];
        const names = (taxIds || []).map((id) => {
            const tax = taxes.find((t) => t.id === id);
            return tax ? tax.name : "Tax";
        }).filter(Boolean);
        return names.join(", ") || "None";
    }

    async onPurchaseProductChange(line, vendorHint) {
        const product = this.state.products.find((p) => p.id == line.product_id);
        if (!product) {
            return;
        }
        line.uom_po_id = product.uom_po_id || false;
        line.price_unit = product.standard_price || 0;
        line.price = product.standard_price || 0;
        line.tax_id = product.supplier_tax_id || "";
        line.product = product.name;
        const vendorId = parseInt(
            vendorHint || this.state.purchaseOrderForm.partner_id || this.state.selectedPurchaseOrder?.vendorId,
            10
        );
        const productId = parseInt(line.product_id, 10);
        if (!vendorId || !productId) {
            return;
        }
        try {
            const domain = [
                ["partner_id", "=", vendorId],
                "|",
                ["product_id", "=", productId],
                "&",
                ["product_id", "=", false],
                ["product_tmpl_id", "=", product.product_tmpl_id || 0],
            ];
            const sellers = await this.orm.searchRead("product.supplierinfo", domain, ["price"], { limit: 1, order: "min_qty asc" });
            if (sellers.length && sellers[0].price) {
                line.price_unit = sellers[0].price;
                line.price = sellers[0].price;
            }
        } catch (_error) {
            // Keep product cost / purchase tax defaults when vendor pricelist is unavailable.
        }
    }

    async saveVendor() {
        const form = this.state.vendorForm;
        if (!(form.name || '').trim()) {
            this.notification.add("Vendor name is required.", { type: "warning" });
            return;
        }
        try {
            const vals = {
                name: form.name.trim(),
                phone: (form.phone || '').trim() || false,
                email: (form.email || '').trim() || false,
                street: (form.street || '').trim() || false,
                city: (form.city || '').trim() || false,
                supplier_rank: 1,
                customer_rank: 0,
                is_shahtaj_shop: false,
                company_type: 'company',
            };
            let vendorId = form.id;
            if (vendorId) {
                await this.orm.write("res.partner", [vendorId], vals);
            } else {
                const ids = await this.orm.create("res.partner", [vals], { context: { res_partner_search_mode: 'supplier' } });
                vendorId = ids[0];
            }
            await this.fetchRealData({ includeLookups: true, includePnl: false });
            await this.fetchActiveList();
            this.state.showVendorForm = false;
            if (this.state.selectedVendor && this.state.selectedVendor.id === vendorId) {
                this.state.selectedVendor = {
                    ...this.state.selectedVendor,
                    ...vals,
                    phone: vals.phone || 'N/A',
                    email: vals.email || 'N/A',
                    address: [vals.street, vals.city].filter(Boolean).join(', ') || 'No address provided',
                };
            }
            this.notification.add("Vendor saved successfully.", { type: "success" });
            if (!form.id) {
                this.state.purchaseOrderForm.partner_id = vendorId.toString();
            }
        } catch (error) {
            this.notification.add("Failed to save vendor: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async savePurchaseOrder() {
        const form = this.state.purchaseOrderForm;
        if (!form.partner_id) {
            this.notification.add("Please select a vendor.", { type: "warning" });
            return;
        }
        if (!form.lines.length) {
            this.notification.add("Please add at least one product line.", { type: "warning" });
            return;
        }
        try {
            const orderLines = [];
            for (const line of form.lines) {
                if (!line.product_id) {
                    this.notification.add("Please select a product for every PO line.", { type: "warning" });
                    return;
                }
                const product = this.state.products.find((p) => p.id == line.product_id);
                const lineVals = {
                    product_id: parseInt(line.product_id, 10),
                    product_qty: parseFloat(line.qty) || 1,
                    price_unit: parseFloat(line.price_unit) || 0,
                    date_planned: form.date_planned,
                    name: product?.name || 'Product',
                    tax_ids: line.tax_id ? [[6, 0, [parseInt(line.tax_id, 10)]]] : [],
                };
                const uomId = line.uom_po_id || product?.uom_po_id;
                if (uomId) {
                    lineVals.product_uom_id = parseInt(uomId, 10);
                }
                orderLines.push([0, 0, lineVals]);
            }
            const vals = {
                partner_id: parseInt(form.partner_id, 10),
                date_order: form.date_order,
                date_planned: form.date_planned,
                order_line: orderLines,
            };
            await this.orm.create("purchase.order", [vals], {
                context: {
                    res_partner_search_mode: 'supplier',
                    default_supplier_rank: 1,
                    default_is_shahtaj_shop: false,
                    default_receipt_reminder_email: false,
                },
            });
            this.state.showPurchaseOrderForm = false;
            this.resetPurchaseOrderForm();
            this.state.poSubTab = 'purchase_orders';
            await this.fetchActiveList();
            this.notification.add("Purchase order created successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to create purchase order: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    _mapPurchaseOrder(po) {
        return {
            id: po.id,
            display_name: po.name,
            vendor: po.partner_id ? po.partner_id[1] : "Unknown",
            vendorId: po.partner_id ? po.partner_id[0] : false,
            date: po.date_order ? po.date_order.split(" ")[0] : "N/A",
            expectedDate: po.date_planned ? po.date_planned.split(" ")[0] : "N/A",
            amount: (po.amount_total || 0).toLocaleString(),
            rawAmount: po.amount_total || 0,
            amount_untaxed: po.amount_untaxed || 0,
            amount_tax: po.amount_tax || 0,
            status: po.state === 'cancel' ? 'Cancelled' : (po.state === 'purchase' ? 'Confirmed' : (po.state === 'to approve' ? 'To Approve' : 'Draft')),
            invoice_status: po.invoice_status || 'no',
            state: po.state,
        };
    }

    async _reloadPurchaseOrder(poId) {
        const records = await this.orm.searchRead(
            "purchase.order",
            [["id", "=", poId]],
            ["name", "partner_id", "date_order", "date_planned", "amount_untaxed", "amount_tax", "amount_total", "state", "invoice_status", "currency_id"]
        );
        if (!records.length) {
            return;
        }
        await this.viewPurchaseOrder(this._mapPurchaseOrder(records[0]));
    }

    _mapVendorBill(bill) {
        let status = "Draft";
        if (bill.state === "cancel") status = "Cancelled";
        else if (bill.state === "posted") {
            if (["paid", "in_payment", "reversed"].includes(bill.payment_state)) status = "Paid";
            else if (bill.payment_state === "partial") status = "Partial";
            else status = "Posted";
        }
        return {
            id: bill.id,
            display_name: bill.name && bill.name !== "/" ? bill.name : `Draft Bill (*${bill.id})`,
            vendor: bill.partner_id ? bill.partner_id[1] : "Unknown",
            shop: bill.partner_id ? bill.partner_id[1] : "Unknown",
            date: bill.invoice_date || "N/A",
            origin: bill.invoice_origin || "N/A",
            amount: (bill.amount_total || 0).toLocaleString(),
            residual: (bill.amount_residual || 0).toLocaleString(),
            rawAmount: bill.amount_total || 0,
            amount_untaxed: bill.amount_untaxed || 0,
            amount_tax: bill.amount_tax || 0,
            invoiceDate: bill.invoice_date || "",
            rawResidual: bill.amount_residual !== undefined ? bill.amount_residual : bill.amount_total,
            journal_id: bill.journal_id ? bill.journal_id[0] : false,
            move_type: bill.move_type,
            status,
        };
    }

    async _reloadVendorBill(billId) {
        const records = await this.orm.searchRead(
            "account.move",
            [["id", "=", billId]],
            ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "invoice_origin", "move_type", "journal_id"]
        );
        if (!records.length) {
            return;
        }
        await this.viewVendorBill(this._mapVendorBill(records[0]));
    }

    _receiptsListDomain() {
        // Match native Receipts & Returns: incoming WH/IN plus vendor returns (WH/OUT to supplier).
        return [
            "|",
            ["picking_type_code", "=", "incoming"],
            "&",
            ["location_dest_id.usage", "=", "supplier"],
            "|",
            ["purchase_id", "!=", false],
            ["return_id", "!=", false],
        ];
    }

    _receiptFields() {
        return ["name", "partner_id", "origin", "scheduled_date", "state", "purchase_id", "picking_type_code", "return_id"];
    }

    _mapReceipt(pick) {
        const state = pick.state || 'draft';
        const pickingType = pick.picking_type_code || 'incoming';
        const isReturn = pickingType === 'outgoing';
        let status = 'Waiting';
        if (state === 'done') status = isReturn ? 'Returned' : 'Product Received';
        else if (state === 'cancel') status = 'Cancelled';
        else if (state === 'draft') status = 'Draft';
        else if (state === 'assigned') status = 'Ready';
        return {
            id: pick.id,
            display_name: pick.name,
            vendor: pick.partner_id ? pick.partner_id[1] : 'Unknown',
            origin: pick.origin || 'N/A',
            scheduledDate: pick.scheduled_date ? pick.scheduled_date.split(" ")[0] : 'N/A',
            status,
            state,
            pickingType,
            isReturn,
            typeLabel: isReturn ? 'Return' : 'Receipt',
            purchaseId: pick.purchase_id ? pick.purchase_id[0] : false,
        };
    }

    async _reloadReceipt(receiptId) {
        const records = await this.orm.searchRead(
            "stock.picking",
            [["id", "=", receiptId]],
            this._receiptFields()
        );
        if (!records.length) {
            return;
        }
        await this.viewReceipt(this._mapReceipt(records[0]));
    }

    async viewPurchaseOrder(po) {
        this.state.selectedPurchaseOrder = po;
        this.state.selectedPurchaseOrderLines = [];
        this.state.isEditingPO = false;
        this.state.removedPoLineIds = [];
        this.state.isLoadingLines = true;
        try {
            const lines = await this.orm.searchRead(
                "purchase.order.line",
                [["order_id", "=", po.id]],
                ["name", "product_id", "product_qty", "qty_received", "qty_invoiced", "price_unit", "price_subtotal", "price_tax", "tax_ids", "product_uom_id"]
            );
            this.state.selectedPurchaseOrderLines = lines.map((line) => {
                const taxIds = line.tax_ids || [];
                return {
                    id: line.id,
                    product: line.name,
                    product_id: line.product_id ? line.product_id[0] : "",
                    qty: line.product_qty,
                    received: line.qty_received,
                    billed: line.qty_invoiced,
                    price: line.price_unit,
                    tax_id: taxIds.length ? taxIds[0] : "",
                    taxes: this._taxLabel(taxIds),
                    taxAmount: line.price_tax || 0,
                    subtotal: line.price_subtotal,
                    uom_po_id: line.product_uom_id ? line.product_uom_id[0] : false,
                };
            });
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.isLoadingLines = false;
        }
    }

    async viewReceipt(receipt) {
        this.state.selectedReceipt = receipt;
        this.state.selectedReceiptLines = [];
        this.state.isLoadingLines = true;
        try {
            const lines = await this.orm.searchRead(
                "stock.move",
                [["picking_id", "=", receipt.id]],
                ["product_id", "description_picking", "product_uom_qty", "quantity", "state"]
            );
            this.state.selectedReceiptLines = lines.map((line) => ({
                id: line.id,
                productId: line.product_id ? line.product_id[0] : false,
                product: line.product_id ? line.product_id[1] : (line.description_picking || "Product"),
                ordered: line.product_uom_qty ?? 0,
                done: line.quantity ?? 0,
            }));
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.isLoadingLines = false;
        }
    }

    async viewVendorBill(bill) {
        this.state.selectedVendorBill = bill;
        this.state.selectedVendorBillLines = [];
        this.state.isEditingVendorBill = false;
        this.state.removedVendorBillLineIds = [];
        this.state.isLoadingLines = true;
        try {
            const lines = await this.orm.searchRead(
                "account.move.line",
                [["move_id", "=", bill.id], ["display_type", "=", "product"]],
                ["name", "product_id", "quantity", "price_unit", "price_subtotal", "tax_ids"]
            );
            this.state.selectedVendorBillLines = lines.map((line) => {
                const taxIds = line.tax_ids || [];
                return {
                    id: line.id,
                    product: line.name,
                    product_id: line.product_id ? line.product_id[0] : "",
                    qty: line.quantity,
                    price: line.price_unit,
                    tax_id: taxIds.length ? taxIds[0] : "",
                    taxes: this._taxLabel(taxIds),
                    subtotal: line.price_subtotal,
                };
            });
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.isLoadingLines = false;
        }
    }

    async viewVendor(vendor) {
        this.state.selectedVendor = vendor;
        this.state.selectedVendorProducts = [];
        this.state.associateProductId = '';
        this.state.isLoadingVendorProducts = true;
        try {
            const [products, allProducts] = await Promise.all([
                this.orm.searchRead(
                    "product.template",
                    [["shahtaj_vendor_id", "=", vendor.id], ["active", "=", true]],
                    ["id", "name", "qty_available", "shahtaj_sale_uom", "uom_name", "standard_price", "list_price"]
                ),
                this.orm.searchRead(
                    "product.template",
                    [["sale_ok", "=", true], ["active", "=", true], ["default_code", "!=", "SHAHTAJ-LEGACY"]],
                    ["id", "name", "shahtaj_vendor_id"]
                ),
            ]);
            this.state.selectedVendorProducts = products || [];
            this.state.allActiveProductsForVendor = allProducts || [];
        } catch (e) {
            console.error("Failed to load vendor products:", e);
        } finally {
            this.state.isLoadingVendorProducts = false;
        }
    }

    openPoForSelectedVendor() {
        if (!this.state.selectedVendor) return;
        const vendor = this.state.selectedVendor;
        this.openPurchaseOrderFormWithProduct({
            vendorId: vendor.id,
            vendorName: vendor.name,
        });
    }

    openPoForSpecificProduct(product, vendor = null) {
        const v = vendor || this.state.selectedVendor;
        this.openPurchaseOrderFormWithProduct({
            vendorId: v ? v.id : null,
            vendorName: v ? v.name : '',
            productId: product.id,
            productTmplId: product.product_tmpl_id || product.id,
            productName: product.name,
        });
    }

    _findPoProduct(productId, productTmplId) {
        const products = this.state.products || [];
        const variantId = productId ? parseInt(productId, 10) : null;
        const tmplId = productTmplId ? parseInt(productTmplId, 10) : null;
        if (variantId) {
            const byVariant = products.find((p) => p.id === variantId);
            if (byVariant) return byVariant;
            const byTmplFromVariant = products.find((p) => p.product_tmpl_id === variantId);
            if (byTmplFromVariant) return byTmplFromVariant;
        }
        if (tmplId) {
            return products.find((p) => p.product_tmpl_id === tmplId || p.id === tmplId) || null;
        }
        return null;
    }

    _mapFetchedPoProduct(p) {
        let vendorId = false;
        if (p.shahtaj_vendor_id) {
            vendorId = Array.isArray(p.shahtaj_vendor_id) ? p.shahtaj_vendor_id[0] : p.shahtaj_vendor_id;
        }
        return {
            id: p.id,
            name: p.display_name || p.name,
            uom_po_id: p.uom_id ? p.uom_id[0] : false,
            standard_price: p.standard_price || 0,
            supplier_tax_id: (p.supplier_taxes_id && p.supplier_taxes_id[0]) || '',
            product_tmpl_id: p.product_tmpl_id ? p.product_tmpl_id[0] : false,
            vendor_id: vendorId,
        };
    }

    async _ensurePoProduct(productId, productTmplId) {
        let product = this._findPoProduct(productId, productTmplId);
        if (product) return product;
        const domain = [];
        if (productId) {
            domain.push("|", ["id", "=", parseInt(productId, 10)], ["product_tmpl_id", "=", parseInt(productId, 10)]);
        } else if (productTmplId) {
            domain.push(["product_tmpl_id", "=", parseInt(productTmplId, 10)]);
        } else {
            return null;
        }
        try {
            const recs = await this.orm.searchRead(
                "product.product",
                domain,
                ["id", "name", "display_name", "uom_id", "standard_price", "supplier_taxes_id", "product_tmpl_id", "shahtaj_vendor_id"],
                { limit: 1 }
            );
            if (!recs.length) return null;
            product = this._mapFetchedPoProduct(recs[0]);
            this.state.products = [...(this.state.products || []), product];
            this.state.poLookups.products = this.state.products;
            return product;
        } catch (_error) {
            return null;
        }
    }

    _ensurePoVendor(vendorId, vendorName) {
        if (!vendorId) return;
        const id = parseInt(vendorId, 10);
        const vendors = this.state.poLookups.vendors || [];
        if (!vendors.some((v) => v.id === id)) {
            this.state.poLookups.vendors = [...vendors, { id, name: vendorName || `Vendor #${id}` }];
        }
    }

    async _consumePendingPoPrefill() {
        const pending = consumePendingPoPrefill();
        if (!pending) return;
        await this.openPurchaseOrderFormWithProduct(pending);
    }

    async openPurchaseOrderFormWithProduct({ vendorId, productId, productTmplId, productName, vendorName } = {}) {
        this.resetPurchaseOrderForm();
        const parsedVendorId = vendorId ? parseInt(vendorId, 10) : null;
        if (parsedVendorId) {
            this._ensurePoVendor(parsedVendorId, vendorName);
            this.state.purchaseOrderForm.partner_id = String(parsedVendorId);
        }
        const product = await this._ensurePoProduct(productId, productTmplId);
        if (product) {
            const line = this._emptyPurchaseOrderLine();
            line.product_id = String(product.id);
            line.product = product.name || productName || 'Product';
            this.state.purchaseOrderForm.lines = [line];
            await this.onPurchaseProductChange(line, parsedVendorId);
        } else if (productId || productTmplId) {
            const line = this._emptyPurchaseOrderLine();
            line.product_id = String(productId || productTmplId);
            line.product = productName || 'Product';
            this.state.purchaseOrderForm.lines = [line];
        }
        this.state.selectedVendor = null;
        this.state.activeSubTab = 'po_management';
        this.state.poSubTab = 'purchase_orders';
        this.state.showPurchaseOrderForm = true;
    }

    async associateProductToSelectedVendor() {
        const prodId = parseInt(this.state.associateProductId, 10);
        const vendorId = this.state.selectedVendor ? this.state.selectedVendor.id : null;
        if (!prodId || !vendorId) {
            this.notification.add("Please select a product to associate.", { type: "warning" });
            return;
        }
        try {
            await this.orm.write("product.template", [prodId], { shahtaj_vendor_id: vendorId });
            this.notification.add("Product associated with vendor successfully.", { type: "success" });
            this.state.associateProductId = '';
            await this.fetchRealData({ includeLookups: true });
            if (this.state.selectedVendor) {
                await this.viewVendor(this.state.selectedVendor);
            }
        } catch (error) {
            this.notification.add("Failed to associate product: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async removeProductFromVendor(productId) {
        if (!productId) return;
        try {
            await this.orm.write("product.template", [productId], { shahtaj_vendor_id: false });
            this.notification.add("Product association removed.", { type: "info" });
            await this.fetchRealData({ includeLookups: true });
            if (this.state.selectedVendor) {
                await this.viewVendor(this.state.selectedVendor);
            }
        } catch (error) {
            this.notification.add("Failed to remove product association: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async actionConfirmPurchaseOrder(po) {
        try {
            await this.orm.call("purchase.order", "button_confirm", [[po.id]]);
            await this.fetchActiveList();
            await this._reloadPurchaseOrder(po.id);
            this.notification.add("Purchase order confirmed successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to confirm purchase order: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async actionCreateVendorBill(po) {
        try {
            await this.orm.call("purchase.order", "action_create_invoice", [[po.id]]);
            await this.fetchActiveList();
            this.requestTabSwitch('financials', 'vendor_bills');
            this.notification.add("Vendor bill created successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to create vendor bill: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async actionOpenReceiptFromPurchaseOrder(po) {
        try {
            const receipts = await this.orm.searchRead(
                "stock.picking",
                ["|", ["purchase_id", "=", po.id], ["origin", "=", po.display_name], ["picking_type_code", "=", "incoming"]],
                this._receiptFields(),
                { limit: 1, order: "id desc" }
            );
            if (!receipts.length) {
                this.notification.add("No incoming receipt exists yet for this purchase order.", { type: "warning" });
                return;
            }
            this.state.activeSubTab = 'po_management';
            this.state.poSubTab = 'receipts';
            await this.fetchActiveList();
            await this.viewReceipt(this._mapReceipt(receipts[0]));
        } catch (error) {
            this.notification.add("Failed to open receipt: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async actionConfirmReceipt(receipt) {
        try {
            await this.orm.call("stock.picking", "action_confirm", [[receipt.id]]);
            await this.fetchActiveList();
            await this._reloadReceipt(receipt.id);
            this.notification.add((receipt.isReturn ? "Return" : "Receipt") + " confirmed.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to confirm receipt: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async actionCheckReceiptAvailability(receipt) {
        try {
            await this.orm.call("stock.picking", "action_assign", [[receipt.id]]);
            await this.fetchActiveList();
            await this._reloadReceipt(receipt.id);
            this.notification.add("Availability checked.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to check availability: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async actionValidateReceipt(receipt) {
        try {
            await this.orm.call(
                "stock.picking",
                "button_validate",
                [[receipt.id]],
                { context: { skip_backorder: true, skip_sms: true } }
            );
            await this.fetchRealData({ includeLookups: true, includePnl: false });
            await this.fetchActiveList();
            await this._reloadReceipt(receipt.id);
            this.notification.add((receipt.isReturn ? "Return" : "Receipt") + " validated successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to validate receipt: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    actionCancelReceipt(receipt) {
        const label = receipt.isReturn ? "Return" : "Receipt";
        this.showConfirm(`Cancel ${label}`, `Are you sure you want to cancel this ${label.toLowerCase()}?`, async () => {
            try {
                await this.orm.call("stock.picking", "action_cancel", [[receipt.id]]);
                await this.fetchActiveList();
                await this._reloadReceipt(receipt.id);
                this.notification.add(`${label} cancelled.`, { type: "success" });
            } catch (error) {
                this.notification.add(`Failed to cancel ${label.toLowerCase()}: ` + (error.data?.message || error.message), { type: "danger" });
            }
        });
    }

    async actionPrintReceipt(receipt) {
        try {
            if (receipt.state === "done") {
                this.action.doAction({
                    type: "ir.actions.report",
                    report_type: "qweb-pdf",
                    report_name: "stock.report_deliveryslip",
                    report_file: "stock.report_deliveryslip",
                    context: { active_ids: [receipt.id] },
                });
                return;
            }
            const action = await this.orm.call("stock.picking", "do_print_picking", [[receipt.id]]);
            if (action) {
                this.action.doAction(action);
            }
        } catch (error) {
            this.notification.add("Failed to print receipt: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    openReturnModal() {
        const receipt = this.state.selectedReceipt;
        if (!receipt || receipt.state !== "done" || receipt.isReturn) {
            return;
        }
        if (!this.state.selectedReceiptLines.length) {
            this.notification.add("No received products are available to return.", { type: "warning" });
            return;
        }
        this.state.returnForm = {
            lines: this.state.selectedReceiptLines.map((line) => ({
                move_id: line.id,
                product_id: line.productId,
                product: line.product,
                maxQty: line.done || 0,
                qty: 0,
            })),
        };
        this.state.showReturnModal = true;
    }

    closeReturnModal() {
        this.state.showReturnModal = false;
        this.state.isReturning = false;
    }

    returnAllReceiptQty() {
        this.state.returnForm.lines = this.state.returnForm.lines.map((line) => ({
            ...line,
            qty: line.maxQty,
        }));
    }

    async submitReturnReceipt() {
        const receipt = this.state.selectedReceipt;
        const linesToReturn = (this.state.returnForm.lines || []).filter((line) => parseFloat(line.qty) > 0);
        if (!linesToReturn.length) {
            this.notification.add("Enter a quantity to return, or click Return All.", { type: "warning" });
            return;
        }
        const overQty = linesToReturn.find((line) => parseFloat(line.qty) > (line.maxQty || 0));
        if (overQty) {
            this.notification.add(`Return qty for ${overQty.product} cannot exceed ${overQty.maxQty}.`, { type: "warning" });
            return;
        }
        this.state.isReturning = true;
        try {
            const context = {
                active_model: "stock.picking",
                active_id: receipt.id,
                active_ids: [receipt.id],
            };
            const wizardIds = await this.orm.create("stock.return.picking", [{ picking_id: receipt.id }], { context });
            const wizardId = wizardIds[0];
            const wizardLines = await this.orm.searchRead(
                "stock.return.picking.line",
                [["wizard_id", "=", wizardId]],
                ["id", "move_id", "quantity"]
            );
            const qtyByMove = Object.fromEntries(linesToReturn.map((line) => [String(line.move_id), parseFloat(line.qty)]));
            if (wizardLines.length) {
                for (const wizardLine of wizardLines) {
                    const moveId = Array.isArray(wizardLine.move_id) ? wizardLine.move_id[0] : wizardLine.move_id;
                    await this.orm.write("stock.return.picking.line", [wizardLine.id], {
                        quantity: qtyByMove[String(moveId)] || 0,
                    });
                }
            } else {
                await this.orm.write("stock.return.picking", [wizardId], {
                    product_return_moves: linesToReturn.map((line) => [0, 0, {
                        move_id: line.move_id,
                        product_id: line.product_id,
                        quantity: parseFloat(line.qty),
                    }]),
                });
            }
            const action = await this.orm.call("stock.return.picking", "action_create_returns", [wizardIds], { context });
            this.closeReturnModal();
            await this.fetchActiveList();
            if (action?.res_id) {
                await this._reloadReceipt(action.res_id);
            } else {
                await this._reloadReceipt(receipt.id);
            }
            this.notification.add("Return receipt created.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to create return: " + (error.data?.message || error.message), { type: "danger" });
        }
        this.state.isReturning = false;
    }

    toggleEditPurchaseOrder() {
        this.state.isEditingPO = true;
        this.state.removedPoLineIds = [];
    }

    cancelEditPurchaseOrder() {
        this.state.isEditingPO = false;
        this._reloadPurchaseOrder(this.state.selectedPurchaseOrder.id);
    }

    addPurchaseOrderEditLine() {
        this.state.selectedPurchaseOrderLines.push({
            id: `new_${Date.now()}`,
            product: "",
            product_id: "",
            qty: 1,
            received: 0,
            billed: 0,
            price: 0,
            tax_id: "",
            taxes: "None",
            taxAmount: 0,
            subtotal: 0,
            uom_po_id: false,
        });
    }

    removePurchaseOrderEditLine(lineId) {
        if (this.state.selectedPurchaseOrderLines.length <= 1) {
            this.notification.add("A purchase order must have at least one line.", { type: "warning" });
            return;
        }
        if (lineId && !String(lineId).startsWith("new_")) {
            this.state.removedPoLineIds.push(lineId);
        }
        this.state.selectedPurchaseOrderLines = this.state.selectedPurchaseOrderLines.filter((line) => line.id !== lineId);
    }

    async savePurchaseOrderEdits() {
        const po = this.state.selectedPurchaseOrder;
        this.state.isSavingPO = true;
        try {
            const commands = this.state.removedPoLineIds.map((id) => [2, id, false]);
            for (const line of this.state.selectedPurchaseOrderLines) {
                if (!line.product_id) {
                    this.notification.add("Please select a product for every PO line.", { type: "warning" });
                    this.state.isSavingPO = false;
                    return;
                }
                const product = this.state.products.find((p) => p.id == line.product_id);
                const vals = {
                    product_id: parseInt(line.product_id, 10),
                    product_qty: parseFloat(line.qty) || 1,
                    price_unit: parseFloat(line.price) || 0,
                    name: product?.name || line.product || "Product",
                    tax_ids: line.tax_id ? [[6, 0, [parseInt(line.tax_id, 10)]]] : [[5, 0, 0]],
                };
                const uomId = line.uom_po_id || product?.uom_po_id;
                if (uomId) {
                    vals.product_uom_id = parseInt(uomId, 10);
                }
                if (String(line.id).startsWith("new_")) {
                    commands.push([0, 0, vals]);
                } else {
                    commands.push([1, line.id, vals]);
                }
            }
            await this.orm.write("purchase.order", [po.id], { order_line: commands });
            this.state.isEditingPO = false;
            await this.fetchActiveList();
            await this._reloadPurchaseOrder(po.id);
            this.notification.add("Purchase order updated.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to save purchase order: " + (error.data?.message || error.message), { type: "danger" });
        }
        this.state.isSavingPO = false;
    }

    toggleEditVendorBill() {
        this.state.isEditingVendorBill = true;
        this.state.removedVendorBillLineIds = [];
    }

    cancelEditVendorBill() {
        this.state.isEditingVendorBill = false;
        this._reloadVendorBill(this.state.selectedVendorBill.id);
    }

    addVendorBillEditLine() {
        this.state.selectedVendorBillLines.push({
            id: `new_${Date.now()}`,
            product: "",
            product_id: "",
            qty: 1,
            price: 0,
            tax_id: "",
            taxes: "None",
            subtotal: 0,
        });
    }

    removeVendorBillEditLine(lineId) {
        if (this.state.selectedVendorBillLines.length <= 1) {
            this.notification.add("A vendor bill must have at least one line.", { type: "warning" });
            return;
        }
        if (lineId && !String(lineId).startsWith("new_")) {
            this.state.removedVendorBillLineIds.push(lineId);
        }
        this.state.selectedVendorBillLines = this.state.selectedVendorBillLines.filter((line) => line.id !== lineId);
    }

    async onVendorBillProductChange(line) {
        const product = this.state.products.find((p) => p.id == line.product_id);
        if (!product) {
            return;
        }
        line.product = product.name;
        line.price = product.standard_price || 0;
        line.tax_id = product.supplier_tax_id || "";
    }

    async saveVendorBillEdits() {
        const bill = this.state.selectedVendorBill;
        this.state.isSavingVendorBill = true;
        try {
            const commands = this.state.removedVendorBillLineIds.map((id) => [2, id, false]);
            for (const line of this.state.selectedVendorBillLines) {
                if (!line.product_id) {
                    this.notification.add("Please select a product for every bill line.", { type: "warning" });
                    this.state.isSavingVendorBill = false;
                    return;
                }
                const vals = {
                    product_id: parseInt(line.product_id, 10),
                    quantity: parseFloat(line.qty) || 1,
                    price_unit: parseFloat(line.price) || 0,
                    tax_ids: line.tax_id ? [[6, 0, [parseInt(line.tax_id, 10)]]] : [[5, 0, 0]],
                };
                if (String(line.id).startsWith("new_")) {
                    commands.push([0, 0, vals]);
                } else {
                    commands.push([1, line.id, vals]);
                }
            }
            const writeVals = { invoice_line_ids: commands };
            if (bill.invoiceDate) {
                writeVals.invoice_date = bill.invoiceDate;
                writeVals.date = bill.invoiceDate;
            }
            await this.orm.write("account.move", [bill.id], writeVals);
            this.state.isEditingVendorBill = false;
            await this.fetchActiveList();
            await this._reloadVendorBill(bill.id);
            this.notification.add("Vendor bill updated.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to save vendor bill: " + (error.data?.message || error.message), { type: "danger" });
        }
        this.state.isSavingVendorBill = false;
    }

    async actionConfirmVendorBill(bill) {
        this.state.isConfirming = true;
        try {
            if (!bill.invoiceDate) {
                this.notification.add("Please select a bill date before confirming.", { type: "warning" });
                this.state.isConfirming = false;
                return;
            }
            await this.orm.write("account.move", [bill.id], {
                invoice_date: bill.invoiceDate,
                date: bill.invoiceDate,
            });
            await this.orm.call("account.move", "action_post", [[bill.id]]);
            await this.fetchActiveList();
            await this._reloadVendorBill(bill.id);
            this.notification.add("Vendor bill confirmed.", { type: "success" });
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        }
        this.state.isConfirming = false;
    }

    async actionResetVendorBill(bill) {
        this.state.isResetting = true;
        try {
            await this.orm.call("account.move", "button_draft", [[bill.id]]);
            await this.fetchActiveList();
            await this._reloadVendorBill(bill.id);
            this.notification.add("Vendor bill reset to draft.", { type: "success" });
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        }
        this.state.isResetting = false;
    }

    actionCancelVendorBill(bill) {
        this.showConfirm("Cancel Vendor Bill", "Are you sure you want to cancel this vendor bill?", async () => {
            this.state.isCancelling = true;
            try {
                await this.orm.call("account.move", "button_cancel", [[bill.id]]);
                await this.fetchActiveList();
                await this._reloadVendorBill(bill.id);
            } catch (error) {
                this.notification.add("Failed to cancel vendor bill: " + (error.data?.message || error.message), { type: "danger" });
            }
            this.state.isCancelling = false;
        });
    }

    canIssueVendorCreditNote(bill) {
        return Boolean(
            bill
            && bill.move_type !== "in_refund"
            && ["Posted", "Partial", "Paid"].includes(bill.status)
        );
    }

    actionVendorBillCreditNote(bill) {
        if (!this.canIssueVendorCreditNote(bill)) {
            return;
        }
        this.showConfirm("Create Credit Note", "This will create a vendor credit note reversing this bill. Continue?", async () => {
            try {
                const today = new Date().toISOString().split("T")[0];
                const context = { active_model: "account.move", active_ids: [bill.id] };
                const wizardIds = await this.orm.create("account.move.reversal", [{
                    reason: "Vendor bill credit note",
                    date: today,
                    journal_id: bill.journal_id,
                }], { context });
                const action = await this.orm.call("account.move.reversal", "reverse_moves", [wizardIds], { context });
                await this.fetchActiveList();
                const creditNoteId = action?.res_id;
                if (creditNoteId) {
                    await this._reloadVendorBill(creditNoteId);
                } else {
                    await this._reloadVendorBill(bill.id);
                }
                this.notification.add("Credit note created.", { type: "success" });
            } catch (error) {
                this.notification.add("Failed to create credit note: " + (error.data?.message || error.message), { type: "danger" });
            }
        });
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

}

PoManagement.template = "shahtaj_oil.FinancialsPoManagement";
