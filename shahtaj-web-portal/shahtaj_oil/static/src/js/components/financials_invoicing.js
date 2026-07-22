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
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        const formatDate = (d) => d.toISOString().split('T')[0];
        // 2. SMART INITIALIZATION
        const target = this.props.requestedSubTab || 'invoices';
        const topLevelTabs = ['credit', 'pnl', 'money', 'cash'];
        const initActive = topLevelTabs.includes(target) ? target : 'invoices';
        const initInvoice = (target === 'credit' || target === 'pnl' || target === 'money' || target === 'cash' || target === 'invoices')
            ? 'all_orders'
            : target;
        this.state = useState({
            activeSubTab: initActive,
            invoiceSubTab: initInvoice,
            cashDirection: 'all',
            
            selectedOrder: null, 
            selectedOrderLines: [], 
            selectedInvoice: null,
            selectedInvoiceLines: [],
            isEditingInvoice: false,
            
            // --- Loading States ---
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
            refundForm: { date: '', reason: '' },

            journals: [], 
            products: [], // Loaded for the edit dropdown
            removedLineIds: [], // Tracks deleted invoice lines during edit
            availableTaxes: [],
            
            allOrders: [],
            orders: [],
            invoices: [],
            creditNotes: [], 
            payments: [],
            balances: [],
            credits: [],
            //  NEW: Profit & Loss Dashboard State
            pnl: {
                date_from: formatDate(firstDay), // Defaults to 1st of current month
                date_to: formatDate(today),      // Defaults to today
                stats: {},
                lines: [],
                isLoading: false,
                selectedProductLineId: ''
            },
            money: {
                date_from: formatDate(firstDay),
                date_to: formatDate(today),
                isLoading: false,
                collected: 0,
                paidOut: 0,
                netCash: 0,
                stillOwed: 0,
                openInvoiceAmount: 0,
                paymentCountIn: 0,
                paymentCountOut: 0,
            },
            
            stats: { totalOrders: 0, toInvoice: 0, openInvoices: 0, creditNotes: 0, approvedShops: 0 },

            filters: {
                allOrders: { search: '', status: 'all' },
                orders: { search: '' },
                invoices: { search: '', status: 'all' },
                creditNotes: { search: '', status: 'all' },
                payments: { search: '' },
                balances: { search: '' },
                credits: { search: '', status: 'all' }
            },
            // --- Payment Form Fields ---
            paymentForm: { 
                journal_id: '', 
                amount: 0, 
                date: '', 
                invoice_id: null, 
                invoice_name: '',
                method: 'cash',
                bank_name: '',
                account_number: '',
                reference: '',
                notes: '' 
            },
            isRefreshing: false,
            confirmModal: { isOpen: false, title: '', message: '', onConfirm: null },
        });
     // 3. SMART PROP LISTENER FOR 2-LEVEL TABS
        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab) {
                const req = nextProps.requestedSubTab;
                
                if (['credit', 'pnl', 'money', 'cash'].includes(req)) {
                    this.state.activeSubTab = req;
                    if (req === 'money') {
                        this.loadMoneyOverview();
                    }
                    if (req === 'cash') {
                        this.state.cashDirection = 'all';
                    }
                } 
                // Everything else belongs inside the Invoice Management parent
                else {
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
        });
    }
    // --- NEW: Core Methods ---
    async refreshData() {
        this.state.isRefreshing = true;
        try {
            await this.fetchRealData();
            if (this.state.activeSubTab === 'money') {
                await this.loadMoneyOverview();
            }
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

    // --- GLOBAL DATA FETCHER ---
    async fetchRealData() {
        try {
            const allOrdersData = await this.orm.searchRead(
                "sale.order",
                [["shahtaj_visit_id", "!=", false]],
                ["name", "partner_id", "date_order", "amount_total", "amount_untaxed", "state", "user_id", "payment_term_id", "pricelist_id", "shahtaj_visit_id", "invoice_status"]
            );
            this.state.allOrders = allOrdersData.map(o => ({
                id: o.id, display_name: o.name, shop: o.partner_id ? o.partner_id[1] : 'Unknown', shopId: o.partner_id ? o.partner_id[0] : false,
                booker: o.user_id ? o.user_id[1] : 'Unassigned', bookerId: o.user_id ? o.user_id[0] : false, date: o.date_order ? o.date_order.split(' ')[0] : 'N/A', 
                amount: (o.amount_total || 0).toLocaleString(), rawAmount: o.amount_total || 0, untaxedAmount: (o.amount_untaxed || 0).toLocaleString(),
                paymentTerms: o.payment_term_id ? o.payment_term_id[1] : 'Immediate', pricelist: o.pricelist_id ? o.pricelist_id[1] : 'Default (PKR)',
                visit: o.shahtaj_visit_id ? o.shahtaj_visit_id[1] : 'N/A', status: o.state === 'cancel' ? 'Cancelled' : (o.state === 'draft' ? 'Draft' : 'Confirmed'),
                invoice_status: o.invoice_status
            }));
        } catch (error) { console.error("All Orders Fetch Error:", error); }

        this.state.orders = this.state.allOrders.filter(o => o.invoice_status === 'to invoice');

        try {
            const invoicesData = await this.orm.searchRead(
                "account.move",
                [["move_type", "in", ["out_invoice"]], ["partner_id.is_shahtaj_shop", "=", true]],
                ["name", "partner_id", "invoice_date","amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state","journal_id"]
            );
            this.state.invoices = invoicesData.map(inv => {
                let status = 'Draft';
                if (inv.state === 'cancel') status = 'Cancelled';
                else if (inv.state === 'posted') {
                    if (['paid', 'in_payment', 'reversed'].includes(inv.payment_state)) status = 'Paid';
                    else if (inv.payment_state === 'partial') status = 'Partial';
                    else status = 'Posted'; 
                }
                return {
                    id: inv.id, display_name: (inv.name && inv.name !== '/') ? inv.name : `Draft Invoice (*${inv.id})`, shop: inv.partner_id ? inv.partner_id[1] : 'Unknown',
                    untaxedAmount: (inv.amount_untaxed || 0).toLocaleString(),
                    taxAmount: (inv.amount_tax || 0).toLocaleString(),
                    date: inv.invoice_date || 'Not set', amount: (inv.amount_total || 0).toLocaleString(), rawAmount: inv.amount_total || 0,
                    residual: (inv.amount_residual || 0).toLocaleString(), rawResidual: inv.amount_residual !== undefined ? inv.amount_residual : inv.amount_total, status: status,
                    journal_id: inv.journal_id ? inv.journal_id[0] : false
                };
            });
        } catch (error) { console.error("Invoices Fetch Error:", error); }
        
        const taxes = await this.orm.searchRead(
            "account.tax",
            [["type_tax_use", "=", "sale"], ["active", "=", true]],
            ["id", "name", "amount"]
        );
        this.state.availableTaxes = taxes;
        const prods = await this.orm.searchRead("product.product", [["sale_ok", "=", true]], ["id", "name"]);
        this.state.allProducts = prods;
        
        try {
            const creditNotesData = await this.orm.searchRead(
                "account.move",
                [["move_type", "=", "out_refund"], ["partner_id.is_shahtaj_shop", "=", true]],
                ["name", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "payment_state", "state", "journal_id"]
            );
            this.state.creditNotes = creditNotesData.map(cn => {
                let status = 'Draft';
                if (cn.state === 'cancel') status = 'Cancelled';
                else if (cn.state === 'posted') {
                    if (['paid', 'in_payment', 'reversed'].includes(cn.payment_state)) status = 'Paid/Reconciled';
                    else if (cn.payment_state === 'partial') status = 'Partial';
                    else status = 'Posted'; 
                }
                return {
                    id: cn.id, display_name: (cn.name && cn.name !== '/') ? cn.name : `Draft Refund (*${cn.id})`, shop: cn.partner_id ? cn.partner_id[1] : 'Unknown',
                    untaxedAmount: (cn.amount_untaxed || 0).toLocaleString(),
                    taxAmount: (cn.amount_tax || 0).toLocaleString(),
                    date: cn.invoice_date || 'Not set', amount: (cn.amount_total || 0).toLocaleString(), rawAmount: cn.amount_total || 0,
                    residual: (cn.amount_residual || 0).toLocaleString(), rawResidual: cn.amount_residual !== undefined ? cn.amount_residual : cn.amount_total,
                    status: status, journal_id: cn.journal_id ? cn.journal_id[0] : false 
                };
            });
        } catch (error) { console.error("Credit Notes Fetch Error:", error); }

        try { this.state.journals = await this.orm.searchRead("account.journal", [["type", "in", ["bank", "cash"]]], ["name", "type"]); } catch (error) {}

        try {
            const prodData = await this.orm.searchRead("product.product", [["sale_ok", "=", true]], ["id", "display_name"]);
            this.state.products = prodData.map(p => ({ id: p.id, name: p.display_name }));
        } catch (error) {}

        try {
           const paymentsData = await this.orm.searchRead(
                "account.payment",
                [["partner_id.is_shahtaj_shop", "=", true]], 
                [
                    "name", "partner_id", "date", "amount", "journal_id", "memo", "state", 
                    "shahtaj_payment_channel", "shahtaj_payer_bank_name", "shahtaj_payer_account_number", 
                    "shahtaj_instrument_reference", "shahtaj_payment_notes"
                ]
            ); 
            this.state.payments = paymentsData.map(pay => ({
                id: pay.id, display_name: pay.name ? pay.name : `Processing... (#${pay.id})`, shop: pay.partner_id ? pay.partner_id[1] : 'Unknown',
                date: pay.date || 'N/A', amount: (pay.amount || 0).toLocaleString(), method: pay.journal_id ? pay.journal_id[1] : 'Manual',
                ref: pay.memo || 'N/A', status: (pay.state === 'posted' || pay.state === 'reconciled') ? 'Posted' : (pay.state === 'cancel' ? 'Cancelled' : 'Draft'),
                status: ['paid', 'in_process', 'posted', 'reconciled'].includes(pay.state) ? 'Paid' : (pay.state === 'cancel' ? 'Cancelled' : 'Draft'),
                channel: pay.shahtaj_payment_channel || 'cash',
                bank: pay.shahtaj_payer_bank_name || 'N/A',
                account: pay.shahtaj_payer_account_number || 'N/A',
                reference: pay.shahtaj_instrument_reference || 'N/A',
                notes: pay.shahtaj_payment_notes || 'N/A'
            }));
        } catch (error) { console.error("Payments Fetch Error:", error); }

        try {
            const shopsData = await this.orm.searchRead(
                "res.partner", [["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]],
                ["name", "owner_name", "route_id", "shahtaj_shop_category", "credit_limit", "credit"] 
            );
            this.state.balances = shopsData.map(shop => ({
                id: shop.id, shopId: shop.id, shop: shop.name, owner: shop.owner_name || 'N/A', route: shop.route_id ? shop.route_id[1] : 'Unassigned',
                category: shop.shahtaj_shop_category === 'cash' ? 'Cash' : 'Credit', limit: shop.shahtaj_shop_category === 'cash' ? 'N/A' : (shop.credit_limit || 0).toLocaleString(),
                rawLimit: shop.credit_limit || 0, outstanding: (shop.credit || 0).toLocaleString(),
                rawOutstanding: shop.credit || 0, 
            }));

            this.state.credits = shopsData.map(shop => {
                const limit = shop.credit_limit || 0;
                const utilized = shop.credit || 0;
                let status = "Healthy";
                if (shop.shahtaj_shop_category === 'cash') status = "Cash";
                else if (limit > 0) {
                    if (utilized > limit) status = "Exceeded";
                    else if (utilized >= limit * 0.85) status = "Critical";
                }
                return {
                    id: shop.id, shopId: shop.id, shop: shop.name, limit: limit.toLocaleString(), rawLimit: limit,
                    utilized: utilized.toLocaleString(), rawUtilized: utilized, available: Math.max(0, limit - utilized).toLocaleString(), status: status
                };
            });
        } catch (error) { console.error("Shop Balances Fetch Error:", error); }

        this.state.stats = {
            totalOrders: this.state.allOrders.length, toInvoice: this.state.orders.length,
            openInvoices: this.state.invoices.filter(i => i.status === 'Posted' || i.status === 'Partial').length,
            creditNotes: this.state.creditNotes.length, approvedShops: this.state.balances.length
        };
        // NEW: Load initial P&L data
        await this.fetchPnlData();
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
            alert("Failed to load Profit & Loss data.");
        }
        this.state.pnl.isLoading = false;
    }
    // --- MANUFACTURER SUMMARY PRINTING ---
    async printManufacturerSummary() {
        try {
            const [summaryId] = await this.orm.create("shahtaj.manufacturer.summary", [{
                date_from: this.state.pnl.date_from,
                date_to: this.state.pnl.date_to,
            }]);
            await this.orm.call(
                "shahtaj.manufacturer.summary",
                "action_refresh",
                [[summaryId]],
            );

            this.action.doAction({
                type: 'ir.actions.report',
                report_type: 'qweb-pdf',
                report_name: 'shahtaj_oil.report_manufacturer_summary',
                report_file: 'shahtaj_oil.report_manufacturer_summary',
                context: { active_ids: [summaryId] },
            });
        } catch (error) {
            console.error("Print Error:", error);
            alert("Failed to print Manufacturer Summary.");
        }
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
    }
    setInvoiceSubTab(subTabName) { this.state.invoiceSubTab = subTabName; this.resetDetailViews(); }

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

            const stillOwed = this.state.balances.reduce(
                (sum, shop) => sum + (shop.rawOutstanding || 0),
                0
            );
            const openInvoiceAmount = this.state.invoices
                .filter((inv) => inv.status === "Posted" || inv.status === "Partial")
                .reduce((sum, inv) => sum + (inv.rawResidual || 0), 0);

            this.state.money.collected = collected;
            this.state.money.paidOut = paidOut;
            this.state.money.netCash = collected - paidOut;
            this.state.money.stillOwed = stillOwed;
            this.state.money.openInvoiceAmount = openInvoiceAmount;
            this.state.money.paymentCountIn = paymentCountIn;
            this.state.money.paymentCountOut = paymentCountOut;
        } catch (error) {
            console.error("Money Overview Fetch Error:", error);
            alert("Failed to load money overview: " + (error.data?.message || error.message));
        } finally {
            this.state.money.isLoading = false;
        }
    }

    openCashActivity(direction = "all") {
        this.state.cashDirection = direction || "all";
        this.setSubTab("cash");
    }

    openShopBalancesFromMoney() {
        this.state.activeSubTab = "invoices";
        this.setInvoiceSubTab("balances");
    }

    openCreditNotesFromMoney() {
        this.state.activeSubTab = "invoices";
        this.setInvoiceSubTab("credit_notes");
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

    _refreshSelectedInvoiceState(invoiceId) {
        let updatedInv = this.state.invoices.find(i => i.id === invoiceId);
        if (!updatedInv) updatedInv = this.state.creditNotes.find(i => i.id === invoiceId);
        if (updatedInv) this.state.selectedInvoice = updatedInv;
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
            await this.fetchRealData();
            this.setInvoiceSubTab('customer_invoices');
        } catch (error) { 
            alert(`Backend rejected the invoice creation:\n\n${error.data?.message || error.message}`);
        }
        this.state.isCreatingInvoice = false;
    }

    async actionConfirmInvoice(invoice) {
        this.state.isConfirming = true;
        try {
            await this.orm.call("account.move", "action_post", [[invoice.id]]);
            await this.fetchRealData();
            this._refreshSelectedInvoiceState(invoice.id);
        } catch (error) { alert(error.data?.message || error.message); }
        this.state.isConfirming = false;
    }

    async actionResetToDraft(invoice) {
        this.state.isResetting = true;
        try {
            await this.orm.call("account.move", "button_draft", [[invoice.id]]);
            await this.fetchRealData();
            this._refreshSelectedInvoiceState(invoice.id);
        } catch (error) { alert(error.data?.message || error.message); }
        this.state.isResetting = false;
    }

    actionCancelInvoice(invoice) {
        this.showConfirm("Cancel Document", "Are you sure you want to completely cancel this document? This action cannot be undone.", async () => {
            this.state.isCancelling = true;
            try {
                await this.orm.call("account.move", "button_cancel", [[invoice.id]]);
                await this.refreshData();
                this._refreshSelectedInvoiceState(invoice.id);
            } catch (error) { 
                alert("Failed to cancel invoice: " + (error.data?.message || error.message));
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
            alert("An invoice must have at least one product line.");
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
                    alert("Please select a product for all lines.");
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
            await this.fetchRealData();
            this._refreshSelectedInvoiceState(this.state.selectedInvoice.id);
            await this.viewInvoice(this.state.selectedInvoice); 
        } catch (error) {
            alert("Failed to save invoice edits: " + (error.data?.message || error.message));
        }
        this.state.isSavingInvoice = false;
    }

    openRefundModal() {
        const today = new Date().toISOString().split('T')[0];
        this.state.refundForm = { date: today, reason: '' };
        this.state.showRefundModal = true;
    }

    closeRefundModal() { this.state.showRefundModal = false; }

    async processRefund() {
        this.state.isRefunding = true;
        try {
            const context = { active_model: 'account.move', active_ids: [this.state.selectedInvoice.id] };
            const wizardIds = await this.orm.create("account.move.reversal", [{
                reason: this.state.refundForm.reason, date: this.state.refundForm.date,
                journal_id: this.state.selectedInvoice.journal_id
            }], { context });
            
            await this.orm.call("account.move.reversal", "reverse_moves", [wizardIds], { context });
            await this.fetchRealData(); 
            this.closeRefundModal();
            this.state.selectedInvoice = null; 
        } catch (error) { alert(`Refund failed:\n\n${error.data?.message || error.message}`); }
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
            
            await this.fetchRealData(); 
            this.closePaymentModal();
            this._refreshSelectedInvoiceState(form.invoice_id);
            
        } catch (error) {
            alert(`Payment failed:\n\n${error.data?.message || error.message}`);
        }
        this.state.isPaying = false;
    }

    async saveShopBalance() {
        try {
            const shop = this.state.selectedShop;
            await this.orm.write("res.partner", [shop.id], { credit_limit: parseFloat(shop.rawLimit) });
            await this.fetchRealData();
            this.state.selectedShop = null;
        } catch (error) { alert("Failed to save limit. Ensure you have distributor rights."); }
    }
}

FinancialsInvoicing.template = "shahtaj_oil.FinancialsInvoicing";