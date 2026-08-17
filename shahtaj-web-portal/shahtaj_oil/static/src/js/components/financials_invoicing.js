/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess } from "../shahtaj_access";
import { ConfirmModal } from "./confirm_modal"; // FIXED: Missing import
import { BankTransactions } from "./bank_transactions";

export class FinancialsInvoicing extends Component {
    static components = { ConfirmModal, BankTransactions };
    static props = {
        requestedSubTab: { type: String, optional: true },
    };
    
    setup() {
        this.notification = useService("notification");
        this.orm = useService("orm");
        this.action = useService("action");
        // --- TIMEZONE SAFE DATE FORMATTING ---
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        
        // Manually build the string using local time to prevent UTC shift
        const formatDate = (d) => {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };
        this.todayStr = formatDate(today);
        // 2. SMART INITIALIZATION
        const target = this.props.requestedSubTab || 'invoices';
        const topLevelTabs = ['credit', 'pnl', 'money', 'cash', 'tax_ledger', 'expenses'];
        const initActive = topLevelTabs.includes(target) ? target : 'invoices';
        const initInvoice = (target === 'credit' || target === 'pnl' || target === 'money' || target === 'cash' || target === 'tax_ledger' || target === 'invoices')
            ? 'all_orders'
            : target;
        const ITEMS_PER_PAGE = 10;
        
        this.state = useState({
            activeSubTab: initActive,
            invoiceSubTab: initInvoice,
            cashDirection: 'all',
            
            // --- CREDIT & BALANCES MERGED STATE ---
            creditSubView: 'risk', // 'risk' | 'balances'
            selectedShopBalance: null, // For editing shop credit limit details
            
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
            refundForm: { date: '', reason: '', mode: 'full', lines: [] },

            journals: [], 
            products: [], 
            removedLineIds: [], 
            availableTaxes: [],
            
            allOrders: [],
            orders: [],
            invoices: [],
            creditNotes: [], 
            payments: [],
            credits: [], // Backed by backend pagination now
            
            pnl: {
                date_from: formatDate(firstDay),
                date_to: formatDate(today),
                stats: {},
                lines: [],
                isLoading: false,
                selectedProductLineId: '',
                page: 1, limit: 15
            },
            money: {
                date_from: formatDate(firstDay),
                date_to: formatDate(today),
                isLoading: false,
                collected: 0, paidOut: 0, netCash: 0, stillOwed: 0,
                openInvoiceAmount: 0, paymentCountIn: 0, paymentCountOut: 0,
            },
            
            stats: { totalOrders: 0, toInvoice: 0, openInvoices: 0, creditNotes: 0, approvedShops: 0 },

            filters: {
                allOrders: { search: '', status: 'all' },
                orders: { search: '' },
                invoices: { search: '', status: 'all' },
                creditNotes: { search: '', status: 'all' },
                payments: { search: '' },
                credits: { search: '', status: 'all' }, // Used for both risk monitor & balances
                expenses: { search: '', status: 'all' },
                expenseCategories: { search: '' },
            },
            
            paymentForm: { 
                journal_id: '', amount: 0, date: '', invoice_id: null, invoice_name: '',
                method: 'cash', bank_name: '', account_number: '', reference: '', notes: '' 
            },
            taxLedger: {
                date_from: formatDate(firstDay),
                date_to: formatDate(today),
                stats: { amount_tax_invoiced: 0, amount_tax_credited: 0, amount_tax_net: 0 },
                summaries: [], history: [], isLoading: false,
                page: 1, limit: 15
            },
            isRefreshing: false,
            confirmModal: { isOpen: false, title: '', message: '', onConfirm: null },
            
            itemsPerPage: ITEMS_PER_PAGE,
            isLoadingList: false,
            searchTimeout: null,
            pagination: {
                allOrders: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                orders: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                invoices: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                creditNotes: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                payments: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                credits: { page: 1, limit: ITEMS_PER_PAGE, total: 0 }, // Paginated Credit & Balances
                expenses: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                expenseCategories: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            
            expenseSubTab: 'expenses',
            showExpenseForm: false,
            showCategoryForm: false,
            tableExpenses: [],
            tableExpenseCategories: [],
            showExpenseMoveModal: false,
            selectedExpenseMove: null,
            
            expenseForm: { id: null, date: formatDate(today), category_id: '', description: '', amount: '', journal_id: '', partner_id: '', notes: '' },
            categoryForm: { id: null, name: '', sequence: 10, active: true, note: '' },
            expenseLookups: { categories: [], journals: [], partners: [] },
        });
        // Universal Debouncer to protect the server from rapid keystrokes
        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        // Bind the fetch method to the debouncer
        this.debouncedFetchActiveList = this.debounceSearch(() => this.fetchActiveList(), 400);
        
     // 3. SMART PROP LISTENER FOR 2-LEVEL TABS
        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab) {
                const req = nextProps.requestedSubTab;
                
                if (['credit', 'pnl', 'money', 'cash', 'tax_ledger', 'expenses'].includes(req)) {
                    this.state.activeSubTab = req;
                    if (req === 'credit') {
                        this.state.creditSubView = 'risk';
                        this.state.selectedShopBalance = null;
                    }
                    if (req === 'money') this.loadMoneyOverview();
                    if (req === 'cash') this.state.cashDirection = 'all';
                    if (req === 'pnl') this.fetchPnlData();
                    if (req === 'tax_ledger') this.fetchTaxLedgerData();
                    if (req === 'expenses') this.setExpenseSubTab('expenses');
                    this.fetchActiveList();
                } else {
                    this.state.activeSubTab = 'invoices';
                    const childTab = (req === 'invoices') ? 'all_orders' : req;
                    this.setInvoiceSubTab(childTab);
                }
            }
        });

        onWillStart(async () => {
            if (!hasFinancialAccess()) {
                return;
            }
            await this.fetchRealData();
            if (this.state.activeSubTab === 'money') {
                await this.loadMoneyOverview();
            }
            if (this.state.activeSubTab === 'tax_ledger') {
                await this.fetchTaxLedgerData();
            }
            if (this.state.activeSubTab === 'expenses') {
                await this.loadExpenseLookups();
            }
            await this.fetchActiveList();
        });
    }
    get paginatedPnlLines() {
        const lines = this.displayPnlLines; // Respects the product filter dropdown
        const start = (this.state.pnl.page - 1) * this.state.pnl.limit;
        return lines.slice(start, start + this.state.pnl.limit);
    }

    get paginatedTaxHistory() {
        const start = (this.state.taxLedger.page - 1) * this.state.taxLedger.limit;
        return this.state.taxLedger.history.slice(start, start + this.state.taxLedger.limit);
    }

    changeTransientPage(tab, direction) {
        const obj = this.state[tab];
        const total = tab === 'pnl' ? this.displayPnlLines.length : obj.history.length;
        const newPage = obj.page + direction;
        const maxPage = Math.max(1, Math.ceil(total / obj.limit));
        
        if (newPage >= 1 && newPage <= maxPage) {
            obj.page = newPage;
        }
    }
    // --- UNIVERSAL LIST HANDLERS ---
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

    async fetchActiveList() {
        if (!['invoices', 'expenses', 'credit'].includes(this.state.activeSubTab)) return;
        
        const tabMap = {
            'all_orders': { stateKey: 'allOrders', model: 'sale.order', fields: ["name", "partner_id", "date_order", "amount_total", "amount_untaxed", "state", "user_id", "payment_term_id", "pricelist_id", "shahtaj_visit_id", "invoice_status"] },
            'orders': { stateKey: 'orders', model: 'sale.order', fields: ["name", "partner_id", "date_order", "amount_total", "amount_untaxed", "state", "user_id", "payment_term_id", "pricelist_id", "shahtaj_visit_id", "invoice_status"] },
            'customer_invoices': { stateKey: 'invoices', model: 'account.move', fields: ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "journal_id"] },
            'credit_notes': { stateKey: 'creditNotes', model: 'account.move', fields: ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "journal_id"] },
            'payments': { stateKey: 'payments', model: 'account.payment', fields: ["name", "partner_id", "date", "amount", "journal_id", "memo", "state", "shahtaj_payment_channel", "shahtaj_payer_bank_name", "shahtaj_payer_account_number", "shahtaj_instrument_reference", "shahtaj_payment_notes"] },
            'credit': { stateKey: 'credits', model: 'res.partner', fields: ["name", "owner_name", "shahtaj_shop_category", "credit_limit", "outstanding_balance"] },
            'expenses': { stateKey: 'expenses', model: 'shahtaj.expense', fields: ['name', 'date', 'category_id', 'description', 'amount', 'journal_id', 'partner_id', 'state', 'move_name'] },
            'categories': { stateKey: 'expenseCategories', model: 'shahtaj.expense.category', fields: ['name', 'sequence', 'active', 'note'] }
        };

        const config = this.state.activeSubTab === 'credit' 
            ? tabMap['credit'] 
            : (this.state.activeSubTab === 'expenses' ? tabMap[this.state.expenseSubTab] : tabMap[this.state.invoiceSubTab]);
        if (!config) return;

        this.state.isLoadingList = true;
        try {
            const { stateKey, model, fields } = config;
            const pag = this.state.pagination[stateKey];
            const filters = this.state.filters[stateKey];
            let domain = [];
            
            if (stateKey === 'allOrders') domain.push(["shahtaj_visit_id", "!=", false]);
            if (stateKey === 'orders') domain.push(["shahtaj_visit_id", "!=", false], ["invoice_status", "=", "to invoice"]);
            if (stateKey === 'invoices') domain.push(["move_type", "in", ["out_invoice"]], ["partner_id.is_shahtaj_shop", "=", true]);
            if (stateKey === 'creditNotes') domain.push(["move_type", "=", "out_refund"], ["partner_id.is_shahtaj_shop", "=", true]);
            if (stateKey === 'payments') domain.push(["partner_id.is_shahtaj_shop", "=", true]);
            if (stateKey === 'credits') domain.push(["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]);

            if (filters.search) {
                if (stateKey === 'credits') {
                    domain.push('|', ['name', 'ilike', filters.search], ['owner_name', 'ilike', filters.search]);
                } else {
                    domain.push('|', ['name', 'ilike', filters.search], ['partner_id.name', 'ilike', filters.search]);
                }
            }

            if (filters.status && filters.status !== 'all') {
                if (stateKey === 'credits') {
                    if (filters.status === 'Cash') domain.push(['shahtaj_shop_category', '=', 'cash']);
                }
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
            }

            // 4. FIRE DUAL QUERIES (Total Count + Paged Records)
            const [total, records] = await Promise.all([
                this.orm.searchCount(model, domain),
                this.orm.searchRead(model, domain, fields, { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "id desc" })
            ]);
            this.state.pagination[stateKey].total = total;
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
        }
    }
    setCreditSubView(viewName) {
        this.state.creditSubView = viewName;
        this.state.selectedShopBalance = null;
        this.state.pagination.credits.page = 1;
        this.fetchActiveList();
    }

    viewShopBalance(bal) {
        this.state.selectedShopBalance = { ...bal };
    }

    async saveShopBalanceLimit() {
        try {
            const shop = this.state.selectedShopBalance;
            await this.orm.write("res.partner", [shop.id], { credit_limit: parseFloat(shop.rawLimit) });
            await this.refreshFinancialLists();
            this.state.selectedShopBalance = null;
            this.notification.add("Credit limit saved successfully.", { type: "success" });
        } catch (error) { 
            this.notification.add("Failed to save limit: " + (error.data?.message || error.message), { type: "danger" }); 
        }
    }
    //  NEW HELPER METHOD FOR GLOBAL SUBTAB SWITCHING ---
    requestTabSwitch(tabName, subTabName) {
        // Dispatch a global event so the parent Dashboard can update the sidebar highlight
        window.dispatchEvent(new CustomEvent('shahtaj-dashboard-switch', { 
            detail: { tab: tabName, subTab: subTabName } 
        }));
        
        // Also update local state instantly for a snappy UI transition
        if (tabName === 'financials') {
            if (['credit', 'pnl', 'money', 'cash', 'tax_ledger'].includes(subTabName)) {
                this.setSubTab(subTabName);
            } else {
                this.state.activeSubTab = 'invoices';
                this.setInvoiceSubTab(subTabName);
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
    async refreshData() {
        this.state.isRefreshing = true;
        try {
            await this.fetchRealData({ includeLookups: true, includePnl: this.state.activeSubTab === 'pnl' });
            if (this.state.activeSubTab === 'money') {
                await this.loadMoneyOverview();
            }
            // NEW: Instantly refresh the paginated data table
            await this.fetchActiveList(); 
        } finally {
            this.state.isRefreshing = false;
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

    // --- DYNAMIC FILTER GETTERS ---
    get filteredAllOrders() {
        const query = this.state.filters.allOrders.search.toLowerCase();
        const status = this.state.filters.allOrders.status;
        return this.state.allOrders.filter(o => {
            const matchesSearch = !query || o.display_name.toLowerCase().includes(query) || o.shop.toLowerCase().includes(query);
            const matchesStatus = status === 'all' || o.status === status;
            return matchesSearch && matchesStatus;
        });
    }

    get filteredOrders() {
        const query = this.state.filters.orders.search.toLowerCase();
        return this.state.orders.filter(o => !query || o.display_name.toLowerCase().includes(query) || o.shop.toLowerCase().includes(query));
    }

    get filteredInvoices() {
        const query = this.state.filters.invoices.search.toLowerCase();
        const status = this.state.filters.invoices.status;
        return this.state.invoices.filter(i => {
            const matchesSearch = !query || i.display_name.toLowerCase().includes(query) || i.shop.toLowerCase().includes(query);
            const matchesStatus = status === 'all' || i.status === status;
            return matchesSearch && matchesStatus;
        });
    }

    get filteredCreditNotes() {
        const query = this.state.filters.creditNotes.search.toLowerCase();
        const status = this.state.filters.creditNotes.status;
        return this.state.creditNotes.filter(c => {
            const matchesSearch = !query || c.display_name.toLowerCase().includes(query) || c.shop.toLowerCase().includes(query);
            const matchesStatus = status === 'all' || c.status === status;
            return matchesSearch && matchesStatus;
        });
    }

    get filteredPayments() {
        const query = this.state.filters.payments.search.toLowerCase();
        return this.state.payments.filter(p => !query || p.display_name.toLowerCase().includes(query) || p.shop.toLowerCase().includes(query));
    }

    get filteredBalances() {
        const query = this.state.filters.balances.search.toLowerCase();
        return this.state.balances.filter(b => !query || b.shop.toLowerCase().includes(query) || b.owner.toLowerCase().includes(query));
    }

    get filteredCredits() {
        const query = this.state.filters.credits.search.toLowerCase();
        const status = this.state.filters.credits.status;
        return this.state.credits.filter(c => {
            const matchesSearch = !query || c.shop.toLowerCase().includes(query);
            const matchesStatus = status === 'all' || c.status === status;
            return matchesSearch && matchesStatus;
        });
    }
    get displayPnlLines() {
        if (!this.state.pnl.selectedProductLineId) {
            return this.state.pnl.lines;
        }
        return this.state.pnl.lines.filter(l => String(l.id) === String(this.state.pnl.selectedProductLineId));
    }

   // --- GLOBAL DATA FETCHER (Stripped down for Performance) ---
    async fetchRealData(options = {}) {
        const includeLookups = options.includeLookups !== false;
        const includePnl = options.includePnl === true || (options.includePnl !== false && this.state.activeSubTab === 'pnl');

        // 1. Fetch only necessary Lookups for dropdowns
        if (includeLookups) {
            const productDomain = [["sale_ok", "=", true], ["active", "=", true], ["product_tmpl_id.active", "=", true]];
            const [taxesData, prodData, journalsData] = await Promise.all([
                this.orm.searchRead("account.tax", [["type_tax_use", "=", "sale"], ["active", "=", true]], ["id", "name", "amount"]),
                this.orm.searchRead("product.product", productDomain, ["id", "name", "display_name"]),
                this.orm.searchRead("account.journal", [["type", "in", ["bank", "cash"]]], ["name", "type"])
            ]);
            this.state.availableTaxes = taxesData || [];
            this.state.allProducts = prodData || [];
            this.state.products = (prodData || []).map((p) => ({ id: p.id, name: p.display_name || p.name }));
            this.state.journals = journalsData || [];
        }

        // 2. Fetch lightning-fast counts for the 5 KPI Cards
        const [totalOrders, toInvoice, openInvoices, creditNotes, approvedShops] = await Promise.all([
            this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false]]),
            this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["invoice_status", "=", "to invoice"]]),
            this.orm.searchCount("account.move", [["move_type", "in", ["out_invoice"]], ["partner_id.is_shahtaj_shop", "=", true], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]]),
            this.orm.searchCount("account.move", [["move_type", "=", "out_refund"], ["partner_id.is_shahtaj_shop", "=", true]]),
            this.orm.searchCount("res.partner", [["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]])
        ]);

        this.state.stats = { totalOrders, toInvoice, openInvoices, creditNotes, approvedShops };

        // 3. Temporarily fetch Credit Risk data (until we migrate this tab to pagination too)
        if (this.state.activeSubTab === 'credit' || !this.state.credits.length) {
            const shopsData = await this.orm.searchRead("res.partner", [["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]], ["name", "owner_name", "shahtaj_shop_category", "credit_limit", "outstanding_balance"]);
            this.state.credits = (shopsData || []).map((shop) => {
                const limit = shop.credit_limit || 0;
                const utilized = shop.outstanding_balance || 0;
                let status = "Healthy";
                if (shop.shahtaj_shop_category === "cash") status = "Cash";
                else if (limit > 0) {
                    if (utilized > limit) status = "Exceeded";
                    else if (utilized >= limit * 0.85) status = "Critical";
                }
                return {
                    id: shop.id, shopId: shop.id, shop: shop.name, limit: limit.toLocaleString(),
                    rawLimit: limit, utilized: utilized.toLocaleString(), rawUtilized: utilized,
                    available: Math.max(0, limit - utilized).toLocaleString(), status,
                };
            });
        }

        if (includePnl) {
        await this.fetchPnlData();
        }
    }

    /** After invoice/payment/CN mutations: refresh lists only (reuse taxes/products/journals). */
    async refreshFinancialLists() {
        await this.fetchRealData({ includeLookups: false, includePnl: this.state.activeSubTab === "pnl" });
        if (this.state.activeSubTab === "money") {
            await this.loadMoneyOverview();
        }
        // NEW: Instantly refresh the UI after confirming, drafting, or paying an invoice
        await this.fetchActiveList(); 
    }
  

    // Add this too if you don't already have a way to close the detailed view
    closeCreditNote() {
        this.state.selectedCreditNote = null;
        this.state.selectedCreditNoteLines = [];
    }
    // --- PROFIT & LOSS DASHBOARD FETCHER ---
    async fetchPnlData() {
        this.state.pnl.isLoading = true;
        try {
            // 1. Create a temporary backend P&L record with our chosen dates
            const pnlIds = await this.orm.create("shahtaj.pnl.dashboard", [{
                date_from: this.state.pnl.date_from,
                date_to: this.state.pnl.date_to
            }]);
            const pnlId = pnlIds[0];

            // 2. Trigger the Python _gather_stats() math
            await this.orm.call("shahtaj.pnl.dashboard", "action_refresh", [[pnlId]]);

            // 3. Read the freshly calculated totals
            const pnlData = await this.orm.read("shahtaj.pnl.dashboard", [pnlId], [
                "amount_invoiced", "amount_credit_notes", "amount_net_sales", 
                "amount_legacy_invoiced", "amount_cogs", "amount_gross_profit", 
                "amount_manufacturer_payable", "amount_payments_received", "amount_shop_outstanding",
                "amount_operating_expense", "amount_net_profit", "expense_count",
                "line_ids"
            ]);

            if (pnlData.length > 0) {
                this.state.pnl.stats = pnlData[0];
                
                // 4. Read the line-by-line product breakdown
                if (pnlData[0].line_ids && pnlData[0].line_ids.length > 0) {
                    const linesData = await this.orm.read("shahtaj.pnl.dashboard.line", pnlData[0].line_ids, [
                        "product_id", "qty_invoiced", "qty_credited", "amount_revenue", 
                        "amount_credit", "amount_net_sales", "amount_cogs", "amount_profit"
                    ]);
                    this.state.pnl.lines = linesData.map(l => ({
                        id: l.id,
                        product: l.product_id ? l.product_id[1] : 'Unknown',
                        productId: l.product_id ? l.product_id[0] : null,
                        qty_invoiced: l.qty_invoiced,
                        qty_credited: l.qty_credited,
                        net_sales: (l.amount_net_sales || 0).toLocaleString(),
                        cogs: (l.amount_cogs || 0).toLocaleString(),
                        profit: (l.amount_profit || 0).toLocaleString(),
                        rawProfit: l.amount_profit || 0
                    }));
                } else {
                    this.state.pnl.lines = [];
                }
            }
        } catch (error) {
            console.error("P&L Fetch Error:", error);
            this.notification.add("Failed to load Profit & Loss data.", { type: "danger" });
        }
        this.state.pnl.isLoading = false;
    }
    // --- MANUFACTURER SUMMARY PRINTING ---
    async printManufacturerSummary() {
        // Optional: Trigger your existing loading spinner so the UI doesn't freeze
        this.state.pnl.isLoading = true; 
        
        try {
            // 1. Create a Manufacturer Summary wizard record using your P&L dates
            const summaryIds = await this.orm.create("shahtaj.manufacturer.summary", [{
                date_from: this.state.pnl.date_from,
                date_to: this.state.pnl.date_to
            }]);
            const summaryId = summaryIds[0];

            // 2. Trigger the backend Python logic to calculate stats and populate the line items
            await this.orm.call("shahtaj.manufacturer.summary", "action_refresh", [[summaryId]]);

            // 3. Trigger Odoo's native PDF report, strictly passing the Summary ID (not Product IDs)
            this.action.doAction({
                type: 'ir.actions.report',
                report_type: 'qweb-pdf',
                report_name: 'shahtaj_oil.report_manufacturer_summary',
                report_file: 'shahtaj_oil.report_manufacturer_summary',
                context: { active_ids: [summaryId] },
            });
        } catch (error) {
            console.error("Print Error:", error);
            this.notification.add("Failed to print Manufacturer Summary.", { type: "danger" });
        } finally {
            this.state.pnl.isLoading = false;
        }
    }

    setSubTab(tabName) { this.state.activeSubTab = tabName; this.resetDetailViews(); }
    
    resetDetailViews() {
        this.state.selectedInvoice = null;
        this.state.selectedInvoiceLines = [];
        this.state.isEditingInvoice = false;
        this.state.selectedOrder = null;
        this.state.selectedOrderLines = []; 
        this.state.selectedPayment = null;
        this.state.selectedShop = null;
        this.state.selectedExpense = null; // NEW
        this.closePaymentModal();
        this.closeRefundModal();
        this.closeExpenseMoveModal();
    }
    async viewExpense(exp) {
        this.state.isLoadingLines = true;
        try {
            const data = await this.orm.read("shahtaj.expense", [exp.id], [
                "name", "date", "category_id", "description", "amount", 
                "journal_id", "partner_id", "state", "move_name", "notes", "move_id"
            ]);
            
            if (data.length > 0) {
                const e = data[0];
                this.state.selectedExpense = {
                    id: e.id,
                    name: e.name,
                    date: e.date,
                    category: e.category_id ? e.category_id[1] : 'Unknown',
                    description: e.description,
                    amount: (e.amount || 0).toLocaleString(undefined, {minimumFractionDigits: 2}),
                    journal: e.journal_id ? e.journal_id[1] : 'Unknown',
                    partner: e.partner_id ? e.partner_id[1] : 'None',
                    state: e.state,
                    notes: e.notes || 'No notes provided.',
                    move_name: e.move_name || '',
                    has_move: !!e.move_id
                };
            }
        } catch (error) {
            this.notification.add("Failed to load expense details.", { type: "danger" });
        } finally {
            this.state.isLoadingLines = false;
        }
    }

    async viewExpenseJournalEntry(expenseId) {
        this.state.isLoadingLines = true;
        try {
            // 1. Fetch the expense to get the exact Journal Entry ID
            const expData = await this.orm.read("shahtaj.expense", [expenseId], ["move_id"]);
            if (!expData[0].move_id) return;
            const moveId = expData[0].move_id[0];

            // 2. Fetch the Journal Entry details
            const moves = await this.orm.read("account.move", [moveId], ["name", "ref", "date", "journal_id", "state"]);
            const move = moves[0];

            // 3. Fetch the individual Journal Items (Debits & Credits)
            const lines = await this.orm.searchRead(
                "account.move.line", 
                [["move_id", "=", moveId]], 
                ["account_id", "name", "debit", "credit"]
            );

            // 4. Map it to the state for the modal
            this.state.selectedExpenseMove = {
                name: move.name,
                ref: move.ref,
                date: move.date,
                journal: move.journal_id ? move.journal_id[1] : '',
                state: move.state === 'posted' ? 'Posted' : 'Draft',
                lines: lines.map(l => ({
                    id: l.id,
                    account: l.account_id ? l.account_id[1] : '',
                    label: l.name,
                    debit: l.debit || 0,
                    credit: l.credit || 0
                }))
            };
            this.state.showExpenseMoveModal = true;
        } catch(error) {
            this.notification.add("Failed to load journal entry details.", {type: "danger"});
        } finally {
            this.state.isLoadingLines = false;
        }
    }

    closeExpenseMoveModal() {
        this.state.showExpenseMoveModal = false;
        this.state.selectedExpenseMove = null;
    }

    async _refreshSelectedInvoiceState(invoiceId) {
        try {
            // Fetch the exact invoice from the database
            const records = await this.orm.searchRead(
                "account.move", 
                [["id", "=", invoiceId]], 
                ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "journal_id"]
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
                };
                
                // Automatically pipe it into viewInvoice to fetch the lines and restore the UI
                await this.viewInvoice(mappedInv);
            }
        } catch (error) {
            console.error("Failed to refresh invoice state:", error);
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
            const context = { active_model: 'sale.order', active_ids: [order.id] };
            const wizardIds = await this.orm.create("sale.advance.payment.inv", [{ advance_payment_method: 'delivered' }], { context });
            await this.orm.call("sale.advance.payment.inv", "create_invoices", [wizardIds], { context });
            await this.refreshFinancialLists();
            this.setInvoiceSubTab('customer_invoices');
        } catch (error) { 
            this.notification.add(`Backend rejected the invoice creation:\n\n${error.data?.message || error.message}`, { type: "danger" });
        }
        this.state.isCreatingInvoice = false;
    }

    setSubTab(tabName) {
        this.state.activeSubTab = tabName;
        this.resetDetailViews();
        if (tabName === 'money') {
            this.loadMoneyOverview();
        }
        if (tabName === 'cash') {
            this.state.cashDirection = this.state.cashDirection || 'all';
        }
        if (tabName === 'pnl') {
            this.fetchPnlData();
        }
        if (tabName === 'tax_ledger') {
            this.fetchTaxLedgerData();
        }
    }

    // --- TAX LEDGER DATA FETCHER ---
    async fetchTaxLedgerData() {
        this.state.taxLedger.isLoading = true;
        try {
            // 1. Create a temporary backend Tax Ledger record with our chosen dates
            const ledgerIds = await this.orm.create("shahtaj.tax.ledger", [{
                date_from: this.state.taxLedger.date_from,
                date_to: this.state.taxLedger.date_to
            }]);
            const ledgerId = ledgerIds[0];

            // 2. Trigger the Python _gather_stats() math
            await this.orm.call("shahtaj.tax.ledger", "action_refresh", [[ledgerId]]);

            // 3. Read the freshly calculated totals
            const ledgerData = await this.orm.read("shahtaj.tax.ledger", [ledgerId], [
                "amount_tax_invoiced", "amount_tax_credited", "amount_tax_net", 
                "summary_ids", "history_ids"
            ]);

            if (ledgerData.length > 0) {
                this.state.taxLedger.stats = ledgerData[0];

                // 4. Read Summaries
                if (ledgerData[0].summary_ids && ledgerData[0].summary_ids.length > 0) {
                    this.state.taxLedger.summaries = await this.orm.read("shahtaj.tax.ledger.summary", ledgerData[0].summary_ids, [
                        "tax_name", "tax_rate", "base_invoiced", "tax_invoiced", 
                        "base_credited", "tax_credited", "tax_net", "line_count"
                    ]);
                } else {
                    this.state.taxLedger.summaries = [];
                }

                // 5. Read Detailed History
                if (ledgerData[0].history_ids && ledgerData[0].history_ids.length > 0) {
                    const history = await this.orm.read("shahtaj.tax.ledger.history", ledgerData[0].history_ids, [
                        "date", "document_type", "move_name", "partner_id", "tax_id", "base_amount", "tax_amount"
                    ]);
                    this.state.taxLedger.history = history.map(h => ({
                        ...h,
                        partner_name: h.partner_id ? h.partner_id[1] : 'Unknown Shop',
                        tax_name: h.tax_id ? h.tax_id[1] : 'Unknown Tax'
                    }));
                } else {
                    this.state.taxLedger.history = [];
                }
            }
        } catch (error) {
            console.error("Tax Ledger Fetch Error:", error);
            this.notification.add("Failed to load Tax Ledger data.", { type: "danger" });
        } finally {
            this.state.taxLedger.isLoading = false;
        }
    }
    async loadMoneyOverview() {
        this.state.money.isLoading = true;
        try {
            const from = this.state.money.date_from;
            const to = this.state.money.date_to;
            const payments = await this.orm.searchRead(
                "account.payment",
                [
                    ["journal_id.type", "in", ["bank", "cash"]],
                    ["date", ">=", from],
                    ["date", "<=", to],
                    ["state", "in", ["paid", "in_process", "posted", "reconciled"]],
                ],
                ["amount", "amount_signed", "payment_type"]
            );

            let collected = 0;
            let paidOut = 0;
            let paymentCountIn = 0;
            let paymentCountOut = 0;
            for (const payment of payments) {
                const amount = Math.abs(payment.amount_signed || payment.amount || 0);
                if (payment.payment_type === "outbound") {
                    paidOut += amount;
                    paymentCountOut += 1;
                } else {
                    collected += amount;
                    paymentCountIn += 1;
                }
            }

            const shopsData = await this.orm.searchRead(
                "res.partner", 
                [["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]], 
                ["outstanding_balance"]
            );
            const stillOwed = shopsData.reduce((sum, shop) => sum + (shop.outstanding_balance || 0), 0);

            const invoicesData = await this.orm.searchRead(
                "account.move", 
                [
                    ["move_type", "=", "out_invoice"], 
                    ["partner_id.is_shahtaj_shop", "=", true], 
                    ["state", "=", "posted"], 
                    ["payment_state", "in", ["not_paid", "partial"]]
                ], 
                ["amount_residual"]
            );
            const openInvoiceAmount = invoicesData.reduce((sum, inv) => sum + (inv.amount_residual || 0), 0);

            this.state.money.collected = collected;
            this.state.money.paidOut = paidOut;
            this.state.money.netCash = collected - paidOut;
            this.state.money.stillOwed = stillOwed;
            this.state.money.openInvoiceAmount = openInvoiceAmount;
            this.state.money.paymentCountIn = paymentCountIn;
            this.state.money.paymentCountOut = paymentCountOut;
        } catch (error) {
            console.error("Money Overview Fetch Error:", error);
            this.notification.add("Failed to load money overview: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.money.isLoading = false;
        }
    }

   openCashActivity(direction = "all") {
        this.state.cashDirection = direction || "all";
        this.requestTabSwitch('financials', 'cash');
    }

    openShopBalancesFromMoney() {
        this.requestTabSwitch('financials', 'balances');
    }

   openCreditNotesFromMoney() {
        this.requestTabSwitch('financials', 'credit_notes');
    }
    
    resetDetailViews() {
        this.state.selectedInvoice = null;
        this.state.selectedInvoiceLines = [];
        this.state.isEditingInvoice = false;
        this.state.selectedOrder = null;
        this.state.selectedOrderLines = []; 
        this.state.selectedPayment = null;
        this.state.selectedShop = null;
        this.closePaymentModal();
        this.closeRefundModal();
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
            const context = { active_model: 'sale.order', active_ids: [order.id] };
            const wizardIds = await this.orm.create("sale.advance.payment.inv", [{ advance_payment_method: 'delivered' }], { context });
            await this.orm.call("sale.advance.payment.inv", "create_invoices", [wizardIds], { context });
            await this.refreshFinancialLists();
            this.setInvoiceSubTab('customer_invoices');
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

    toggleEditInvoice() { 
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

    addLine() {
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
        this.state.paymentForm = {
            journal_id: this.state.journals.length ? this.state.journals[0].id : '',
            amount: this.state.selectedInvoice.rawResidual,
            date: today,
            invoice_id: this.state.selectedInvoice.id,
            invoice_name: this.state.selectedInvoice.display_name,
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
            await this._refreshSelectedInvoiceState(form.invoice_id);
            
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
    // --- EXPENSES LOGIC ---
    async setExpenseSubTab(subTabName) {
        this.state.expenseSubTab = subTabName;
        this.state.showExpenseForm = false;
        this.state.showCategoryForm = false;
        this.state.selectedExpense = null; // NEW
        
        const key = subTabName === 'categories' ? 'expenseCategories' : 'expenses';
        this.state.pagination[key].page = 1;
        
        if (subTabName === 'expenses' && this.state.expenseLookups.categories.length === 0) {
            await this.loadExpenseLookups();
        }
        this.fetchActiveList();
    }

    async loadExpenseLookups() {
        const [categories, journals, shops, bookers] = await Promise.all([
            this.orm.searchRead('shahtaj.expense.category', [['active', '=', true]], ['id', 'name']),
            this.orm.searchRead('account.journal', [['type', 'in', ['cash', 'bank']]], ['id', 'name']),
            this.orm.searchRead('res.partner', [['is_shahtaj_shop','=',true]], ['id', 'name']),
            this.orm.searchRead('res.users', [['shahtaj_is_order_booker','=',true]], ['partner_id', 'name'])
        ]);
        
        const combinedPartners = [
            ...shops.map(s => ({id: s.id, name: `Shop: ${s.name}`})), 
            ...bookers.filter(b => b.partner_id).map(b => ({id: b.partner_id[0], name: `Booker: ${b.name}`}))
        ];
        
        this.state.expenseLookups.categories = categories || [];
        this.state.expenseLookups.journals = journals || [];
        this.state.expenseLookups.partners = combinedPartners;
    }

    openExpenseForm() {
        const today = new Date().toISOString().split('T')[0];
        this.state.expenseForm = { id: null, date: today, category_id: '', description: '', amount: '', journal_id: '', partner_id: '', notes: '' };
        this.state.showExpenseForm = true;
    }

    async saveExpense() {
        try {
            const f = this.state.expenseForm;
            if (!f.category_id || !f.description || !f.amount || !f.journal_id) {
                this.notification.add("Category, Description, Amount, and Journal are required.", { type: "warning" });
                return;
            }
            const vals = {
                date: f.date, category_id: parseInt(f.category_id), description: f.description,
                amount: parseFloat(f.amount), journal_id: parseInt(f.journal_id),
                partner_id: f.partner_id ? parseInt(f.partner_id) : false, notes: f.notes
            };
            
            if (f.id) await this.orm.write("shahtaj.expense", [f.id], vals);
            else await this.orm.create("shahtaj.expense", [vals]);
            
            this.state.showExpenseForm = false;
            this.fetchActiveList();
            this.notification.add("Expense saved.", { type: "success" });
        } catch (error) { this.notification.add(error.data?.message || error.message, { type: "danger" }); }
    }

    async actionPostExpense(id) {
        try {
            await this.orm.call("shahtaj.expense", "action_post", [[id]]);
            if (this.state.selectedExpense && this.state.selectedExpense.id === id) {
                await this.viewExpense({ id }); // Refresh detail view
            }
            this.fetchActiveList();
            this.notification.add("Expense posted successfully to the ledger.", { type: "success" });
        } catch (error) { this.notification.add(error.data?.message || error.message, { type: "danger" }); }
    }

    async actionCancelExpense(id) {
        this.showConfirm("Cancel Expense", "Are you sure you want to cancel this expense? If posted, the journal entry will be reversed.", async () => {
            try {
                await this.orm.call("shahtaj.expense", "action_cancel", [[id]]);
                if (this.state.selectedExpense && this.state.selectedExpense.id === id) {
                    await this.viewExpense({ id }); // Refresh detail view
                }
                this.fetchActiveList();
            } catch (error) { this.notification.add(error.data?.message || error.message, { type: "danger" }); }
        });
    }

    // --- EXPENSE CATEGORIES LOGIC ---
    openCategoryForm(cat = null) {
        if (cat) this.state.categoryForm = { id: cat.id, name: cat.name, sequence: cat.sequence, active: cat.active, note: cat.note || '' };
        else this.state.categoryForm = { id: null, name: '', sequence: 10, active: true, note: '' };
        this.state.showCategoryForm = true;
    }

    async saveCategory() {
        try {
            const f = this.state.categoryForm;
            if (!f.name) { this.notification.add("Category name required.", { type: "warning" }); return; }
            const vals = { name: f.name, sequence: parseInt(f.sequence), active: f.active, note: f.note };
            
            if (f.id) await this.orm.write("shahtaj.expense.category", [f.id], vals);
            else await this.orm.create("shahtaj.expense.category", [vals]);
            
            this.state.showCategoryForm = false;
            // NEW: Instantly reload the dropdown options so the new category appears
            await this.loadExpenseLookups(); 
            this.fetchActiveList();
        } catch (error) { this.notification.add(error.data?.message || error.message, { type: "danger" }); }
    }
}


FinancialsInvoicing.template = "shahtaj_oil.FinancialsInvoicing";