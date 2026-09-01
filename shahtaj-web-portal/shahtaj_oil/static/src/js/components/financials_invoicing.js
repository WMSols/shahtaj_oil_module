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
        const topLevelTabs = ['credit', 'pnl', 'money', 'cash', 'tax_ledger', 'expenses', 'po_management'];
        const poChildTabs = ['purchase_orders', 'receipts', 'vendor_bills', 'vendors'];
        const initActive = topLevelTabs.includes(target)
            ? target
            : (poChildTabs.includes(target) ? 'po_management' : 'invoices');
        const initInvoice = (target === 'credit' || target === 'pnl' || target === 'money' || target === 'cash' || target === 'tax_ledger' || target === 'invoices')
            ? 'all_orders'
            : target;
        const initPo = target === 'po_management'
            ? 'purchase_orders'
            : (poChildTabs.includes(target) ? target : 'purchase_orders');
        const ITEMS_PER_PAGE = 10;
        
        this.state = useState({
            activeSubTab: initActive,
            invoiceSubTab: initInvoice,
            poSubTab: initPo,
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
            refundForm: { date: '', reason: '', mode: 'full', lines: [] },
            returnForm: { lines: [] },
            removedPoLineIds: [],
            removedVendorBillLineIds: [],

            journals: [], 
            products: [], 
            removedLineIds: [], 
            availableTaxes: [],
            availablePurchaseTaxes: [],
            
            allOrders: [],
            orders: [],
            invoices: [],
            creditNotes: [], 
            payments: [],
            purchaseOrders: [],
            receipts: [],
            vendorBills: [],
            vendors: [],
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
                purchaseOrders: { search: '', status: 'all' },
                receipts: { search: '', status: 'all' },
                vendorBills: { search: '', status: 'all' },
                vendors: { search: '' },
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
                purchaseOrders: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                receipts: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                vendorBills: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                vendors: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
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
            poLookups: { vendors: [], products: [] },
            vendorViewMode: 'active', // 'active' | 'archived'
            archivedVendorsCount: 0,
            vendorForm: { id: null, name: '', phone: '', email: '', street: '', city: '' },
            selectedVendorProducts: [],
            isLoadingVendorProducts: false,
            associateProductId: '',
            allActiveProductsForVendor: [],
            purchaseOrderForm: {
                id: null,
                partner_id: '',
                date_order: formatDate(today),
                date_planned: formatDate(today),
                lines: [],
            },
        });
        // Global listener to open PO form directly when a product is registered
        window.addEventListener('shahtaj-open-create-po', (ev) => {
            const { vendorId, productId, productName } = ev.detail || {};
            this.openPurchaseOrderFormWithProduct({ vendorId, productId, productName });
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
                
                if (['credit', 'pnl', 'money', 'cash', 'tax_ledger', 'expenses', 'po_management'].includes(req)) {
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
                    if (req === 'po_management') this.setPoSubTab('purchase_orders');
                    this.fetchActiveList();
                } else if (['purchase_orders', 'receipts', 'vendor_bills', 'vendors'].includes(req)) {
                    this.state.activeSubTab = 'po_management';
                    this.setPoSubTab(req);
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

    setPoSubTab(subTabName) {
        this.state.poSubTab = subTabName;
        this.resetDetailViews();
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
            if (stateKey === 'credits') domain.push(["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]);

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

            // 4. FIRE DUAL QUERIES (Total Count + Paged Records)
            const queryContext = (stateKey === 'vendors' && this.state.vendorViewMode === 'archived') ? { active_test: false } : {};
            const [total, records] = await Promise.all([
                this.orm.searchCount(model, domain, { context: queryContext }),
                this.orm.searchRead(model, domain, fields, { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "id desc", context: queryContext })
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
            if (['credit', 'pnl', 'money', 'cash', 'tax_ledger', 'expenses', 'po_management'].includes(subTabName)) {
                this.setSubTab(subTabName);
            } else if (['purchase_orders', 'receipts', 'vendor_bills', 'vendors'].includes(subTabName)) {
                this.state.activeSubTab = 'po_management';
                this.setPoSubTab(subTabName);
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
            const productDomain = ["|", ["sale_ok", "=", true], ["purchase_ok", "=", true], ["active", "=", true], ["product_tmpl_id.active", "=", true]];
            const vendorDomain = [["supplier_rank", ">", 0], ["is_shahtaj_shop", "=", false]];
            const [taxesData, purchaseTaxesData, prodData, journalsData, vendorData, archivedVendorsTotal] = await Promise.all([
                this.orm.searchRead("account.tax", [["type_tax_use", "=", "sale"], ["active", "=", true]], ["id", "name", "amount"]),
                this.orm.searchRead("account.tax", [["type_tax_use", "=", "purchase"], ["active", "=", true]], ["id", "name", "amount"]),
                this.orm.searchRead("product.product", productDomain, ["id", "name", "display_name", "uom_id", "standard_price", "supplier_taxes_id", "product_tmpl_id", "shahtaj_vendor_id"]),
                this.orm.searchRead("account.journal", [["type", "in", ["bank", "cash"]]], ["name", "type"]),
                this.orm.searchRead("res.partner", vendorDomain, ["id", "name", "phone", "email", "street", "city", "active"]),
                this.orm.searchCount("res.partner", [["supplier_rank", ">", 0], ["is_shahtaj_shop", "=", false], ["active", "=", false]], { context: { active_test: false } }),
            ]);
            this.state.availableTaxes = taxesData || [];
            this.state.availablePurchaseTaxes = purchaseTaxesData || [];
            this.state.allProducts = prodData || [];
            this.state.archivedVendorsCount = archivedVendorsTotal || 0;
            this.state.products = (prodData || []).map((p) => {
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
            });
            this.state.journals = journalsData || [];
            this.state.poLookups.vendors = vendorData || [];
            this.state.poLookups.products = this.state.products;
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
        if (tabName === 'po_management') {
            this.state.poSubTab = this.state.poSubTab || 'purchase_orders';
            this.fetchActiveList();
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
                    const isAssociated = associated.some((p) => p.id == line.product_id);
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
            Draft: "bg-secondary text-white",
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
        const vendorId = this.state.selectedVendor.id;
        this.resetPurchaseOrderForm();
        this.state.purchaseOrderForm.partner_id = vendorId.toString();
        this.state.selectedVendor = null;
        this.state.activeSubTab = 'po_management';
        this.state.poSubTab = 'purchase_orders';
        this.state.showPurchaseOrderForm = true;
    }

    openPoForSpecificProduct(product, vendor = null) {
        const v = vendor || this.state.selectedVendor;
        const vendorId = v ? v.id : null;
        this.openPurchaseOrderFormWithProduct({
            vendorId: vendorId,
            productId: product.id,
            productName: product.name,
        });
    }

    async openPurchaseOrderFormWithProduct({ vendorId, productId, productName }) {
        this.resetPurchaseOrderForm();
        if (vendorId) {
            this.state.purchaseOrderForm.partner_id = vendorId.toString();
        }
        if (productId) {
            const line = this._emptyPurchaseOrderLine();
            line.product_id = productId.toString();
            line.product = productName || 'Product';
            this.state.purchaseOrderForm.lines = [line];
            // Resolve line details if possible
            await this.onPurchaseProductChange(line, vendorId);
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
}


FinancialsInvoicing.template = "shahtaj_oil.FinancialsInvoicing";