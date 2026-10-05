/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess, notifyPortalBusy } from "../../shahtaj_access";
import { invalidateFinancialStats } from "./financials_cache";

export class CreditControl extends Component {
    static props = {
        requestedCreditSubView: { type: String, optional: true },
        refreshNonce: { type: Number, optional: true },
        onStatsRefresh: { type: Function, optional: true },
    };

    setup() {
        this.notification = useService("notification");
        this.orm = useService("orm");
        const ITEMS_PER_PAGE = 50;
        this.state = useState({
            activeSubTab: "credit",
            creditSubView: this.props.requestedCreditSubView || "risk",
            selectedShopBalance: null,
            credits: [],
            filters: {
                credits: { search: "", status: "all", hasCreditLimit: false },
            },
            itemsPerPage: ITEMS_PER_PAGE,
            isLoadingList: false,
            searchTimeout: null,
            pagination: {
                credits: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
        });
        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchActiveList = this.debounceSearch(() => this.fetchActiveList(), 400);
        onWillUpdateProps(async (nextProps) => {
            if (nextProps.requestedCreditSubView && nextProps.requestedCreditSubView !== this.props.requestedCreditSubView) {
                this.setCreditSubView(nextProps.requestedCreditSubView);
            }
            if (nextProps.refreshNonce !== this.props.refreshNonce) {
                await this.fetchActiveList();
            }
        });
        onWillStart(async () => {
            if (!hasFinancialAccess()) {
                return;
            }
            await this.fetchActiveList();
        });
    }

    async refreshFinancialLists() {
        invalidateFinancialStats();
        if (this.props.onStatsRefresh) {
            await this.props.onStatsRefresh();
        }
        await this.fetchActiveList();
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
    get sortedShopBalances() {
        return [...(this.state.credits || [])].sort((a, b) => (b.rawOutstanding || 0) - (a.rawOutstanding || 0));
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

CreditControl.template = "shahtaj_oil.FinancialsCreditControl";
