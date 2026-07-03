/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class FinancialsInvoicing extends Component {
    setup() {
        this.orm = useService("orm");
        this.action = useService("action");

        this.state = useState({
            activeSubTab: 'invoices',
            invoiceSubTab: 'orders',
            
            // Detail Views
            selectedOrder: null, 
            selectedOrderLines: [], // NEW: Stores the fetched products for the selected order
            selectedInvoice: null,
            selectedPayment: null,
            selectedShop: null,
            
            // Payment Modal
            showPaymentModal: false,
            paymentForm: { journal_id: '', amount: 0, date: '', invoice_id: null, invoice_name: '' },
            journals: [], 
            
            // Data Arrays
            orders: [],
            invoices: [],
            payments: [],
            balances: [],
            credits: [] 
        });

        onWillStart(async () => {
            await this.fetchRealData();
        });
    }

    // ==========================================
    // DATA FETCHING
    // ==========================================
    async fetchRealData() {
        // 1. Orders to Invoice (UPGRADED with new fields)
        try {
            const ordersData = await this.orm.searchRead(
                "sale.order",
                [["invoice_status", "=", "to invoice"], ["shahtaj_visit_id", "!=", false]],
                [
                    "name", "partner_id", "date_order", "amount_total", "amount_untaxed", 
                    "state", "user_id", "payment_term_id", "pricelist_id", "shahtaj_visit_id"
                ]
            );
            this.state.orders = ordersData.map(o => ({
                id: o.id,
                display_name: o.name,
                shop: o.partner_id ? o.partner_id[1] : 'Unknown',
                booker: o.user_id ? o.user_id[1] : 'Unassigned', // Added Order Booker
                date: o.date_order ? o.date_order.split(' ')[0] : 'N/A', 
                amount: (o.amount_total || 0).toLocaleString(),
                rawAmount: o.amount_total || 0,
                untaxedAmount: (o.amount_untaxed || 0).toLocaleString(),
                paymentTerms: o.payment_term_id ? o.payment_term_id[1] : 'Immediate',
                pricelist: o.pricelist_id ? o.pricelist_id[1] : 'Default (PKR)',
                visit: o.shahtaj_visit_id ? o.shahtaj_visit_id[1] : 'N/A',
            }));
        } catch (error) { console.error("Orders Fetch Error:", error); }

        // 2. Customer Invoices
        try {
            const invoicesData = await this.orm.searchRead(
                "account.move",
                [["move_type", "in", ["out_invoice"]], ["partner_id.is_shahtaj_shop", "=", true]],
                ["name", "partner_id", "invoice_date", "amount_total", "payment_state", "state"]
            );
            this.state.invoices = invoicesData.map(inv => ({
                id: inv.id,
                display_name: inv.name,
                shop: inv.partner_id ? inv.partner_id[1] : 'Unknown',
                date: inv.invoice_date || 'Draft',
                amount: (inv.amount_total || 0).toLocaleString(),
                rawAmount: inv.amount_total || 0,
                status: inv.state === 'draft' ? 'Draft' : (inv.payment_state === 'paid' || inv.payment_state === 'in_payment' ? 'Paid' : 'Posted')
            }));
        } catch (error) { console.error("Invoices Fetch Error:", error); }

        // Fetch Bank/Cash Journals for Payment Wizard
        try {
            this.state.journals = await this.orm.searchRead("account.journal", [["type", "in", ["bank", "cash"]]], ["name", "type"]);
        } catch (error) { console.error("Journals Fetch Error:", error); }

        // 3. Customer Payments
        try {
            const paymentsData = await this.orm.searchRead(
                "account.payment",
                [["partner_id.is_shahtaj_shop", "=", true]], 
                ["name", "partner_id", "date", "amount", "journal_id", "memo", "state"]
            );
            this.state.payments = paymentsData.map(pay => ({
                id: pay.id,
                display_name: pay.name || 'Draft Payment',
                shop: pay.partner_id ? pay.partner_id[1] : 'Unknown',
                date: pay.date || 'N/A',
                amount: (pay.amount || 0).toLocaleString(),
                method: pay.journal_id ? pay.journal_id[1] : 'Manual',
                ref: pay.memo || 'N/A', 
                status: pay.state === 'posted' ? 'Posted' : 'Draft'
            }));
        } catch (error) { console.error("Payments Fetch Error:", error); }

        // 4. Shop Balances & Credit Risk Monitoring
        try {
            const shopsData = await this.orm.searchRead(
                "res.partner",
                [["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]],
                ["name", "owner_name", "route_id", "credit_limit", "credit"] 
            );
            
            this.state.balances = shopsData.map(shop => ({
                id: shop.id,
                shop: shop.name,
                owner: shop.owner_name || 'N/A',
                route: shop.route_id ? shop.route_id[1] : 'Unassigned',
                limit: (shop.credit_limit || 0).toLocaleString(),
                rawLimit: shop.credit_limit || 0,
                outstanding: (shop.credit || 0).toLocaleString(), 
            }));

            this.state.credits = shopsData.map(shop => {
                const limit = shop.credit_limit || 0;
                const utilized = shop.credit || 0;
                let status = "Healthy";
                
                if (limit > 0) {
                    if (utilized > limit) status = "Exceeded";
                    else if (utilized >= limit * 0.85) status = "Critical";
                }
                
                return {
                    id: shop.id,
                    shop: shop.name,
                    limit: limit.toLocaleString(),
                    rawLimit: limit,
                    utilized: utilized.toLocaleString(),
                    rawUtilized: utilized,
                    available: Math.max(0, limit - utilized).toLocaleString(),
                    status: status
                };
            });
        } catch (error) { console.error("Shop Balances Fetch Error:", error); }
    }

    // ==========================================
    // UI NAVIGATION
    // ==========================================
    setSubTab(tabName) { this.state.activeSubTab = tabName; this.resetDetailViews(); }
    setInvoiceSubTab(subTabName) { this.state.invoiceSubTab = subTabName; this.resetDetailViews(); }
    
    resetDetailViews() {
        this.state.selectedInvoice = null;
        this.state.selectedOrder = null;
        this.state.selectedOrderLines = []; // Clear lines on reset
        this.state.selectedPayment = null;
        this.state.selectedShop = null;
        this.closePaymentModal();
    }

    // NEW: Async method to fetch order lines when clicking an order
    async viewOrder(order) { 
        this.state.selectedOrder = order; 
        this.state.selectedOrderLines = []; // Reset lines while loading
        try {
            const linesData = await this.orm.searchRead(
                "sale.order.line",
                // 'display_type = false' ensures we only get actual products, not section notes/headers
                [["order_id", "=", order.id], ["display_type", "=", false]], 
                ["product_id", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "price_subtotal"]
            );
            this.state.selectedOrderLines = linesData.map(l => ({
                id: l.id,
                product: l.product_id ? l.product_id[1] : 'Unknown Product',
                qty: l.product_uom_qty,
                delivered: l.qty_delivered,
                invoiced: l.qty_invoiced,
                price: (l.price_unit || 0).toLocaleString(),
                subtotal: (l.price_subtotal || 0).toLocaleString()
            }));
        } catch (error) { console.error("Lines Fetch Error:", error); }
    }
    
    viewInvoice(invoice) { this.state.selectedInvoice = invoice; }
    viewPayment(payment) { this.state.selectedPayment = payment; }
    viewShop(shop) { this.state.selectedShop = { ...shop }; }

    // FEATURE 1: CREATE INVOICE
    // ==========================================
    async triggerCreateInvoice(order) {
        try {
            const context = {
                active_model: 'sale.order',
                active_ids: [order.id],
            };
            
            // wizardIds is returned as an array, e.g., [42]
            const wizardIds = await this.orm.create("sale.advance.payment.inv", [{
                advance_payment_method: 'delivered' 
            }], { context });
            
            // FIXED: Pass [wizardIds] so Python receives [[42]] instead of [[[42]]]
            await this.orm.call("sale.advance.payment.inv", "create_invoices", [wizardIds], { context });
            
            await this.fetchRealData();
            this.setInvoiceSubTab('customer_invoices');
            
        } catch (error) { 
            const pythonError = error.data?.message || error.message;
            const pythonTrace = error.data?.debug || "No traceback available";
            
            console.error("🔥 INVOICE CREATION CRASH EXACT REASON:", pythonError);
            console.error("🔥 PYTHON TRACEBACK:\n", pythonTrace);
            
            alert(`Backend rejected the invoice creation:\n\n${pythonError}\n\nCheck the browser console for details!`);
        }
    }

    async actionConfirmInvoice(invoice) {
        try {
            await this.orm.call("account.move", "action_post", [[invoice.id]]);
            await this.fetchRealData();
            this.state.selectedInvoice.status = 'Posted'; 
        } catch (error) { console.error("Failed to confirm", error); }
    }

    async actionResetToDraft(invoice) {
        try {
            await this.orm.call("account.move", "button_draft", [[invoice.id]]);
            await this.fetchRealData();
            this.state.selectedInvoice.status = 'Draft';
        } catch (error) { console.error("Failed to reset", error); }
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
            amount: this.state.selectedInvoice.rawAmount,
            date: today,
            invoice_id: this.state.selectedInvoice.id,
            invoice_name: this.state.selectedInvoice.display_name
        };
        this.state.showPaymentModal = true;
    }

    closePaymentModal() { this.state.showPaymentModal = false; }

    // ==========================================
    // FEATURE 3: PAYMENT WIZARD
    // ==========================================
    async processPayment() {
        try {
            const form = this.state.paymentForm;
            const context = {
                active_model: 'account.move',
                active_ids: [form.invoice_id],
            };
            
            // wizardIds is returned as an array
            const wizardIds = await this.orm.create("account.payment.register", [{
                journal_id: parseInt(form.journal_id),
                amount: parseFloat(form.amount),
                payment_date: form.date,
            }], { context });
            
            // FIXED: Pass [wizardIds] to avoid the unhashable list error
            await this.orm.call("account.payment.register", "action_create_payments", [wizardIds], { context });
            
            await this.fetchRealData(); 
            this.closePaymentModal();
            this.state.selectedInvoice.status = 'Paid';
            
        } catch (error) {
            const pythonError = error.data?.message || error.message;
            const pythonTrace = error.data?.debug || "No traceback available";
            
            console.error(" PAYMENT CRASH EXACT REASON:", pythonError);
            console.error(" PYTHON TRACEBACK:\n", pythonTrace);
            
            alert(`Payment failed:\n\n${pythonError}\n\nCheck the browser console for details!`);
        }
    }

    async saveShopBalance() {
        try {
            const shop = this.state.selectedShop;
            await this.orm.write("res.partner", [shop.id], {
                credit_limit: parseFloat(shop.rawLimit)
            });
            await this.fetchRealData();
            this.state.selectedShop = null;
        } catch (error) { 
            console.error("Failed to update credit limit", error); 
            alert("Failed to save limit. Ensure you have distributor rights.");
        }
    }
}

FinancialsInvoicing.template = "shahtaj_oil.FinancialsInvoicing";