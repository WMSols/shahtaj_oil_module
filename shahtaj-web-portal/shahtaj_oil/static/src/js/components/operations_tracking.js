/** @odoo-module **/

import { Component, useState, onWillStart,onWillUpdateProps  } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess } from "../shahtaj_access";

export class OperationsTracking extends Component {
     static props = {
        requestedSubTab: { type: String, optional: true },
    };
    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        const ITEMS_PER_PAGE = 10;
        this.state = useState({
            // Main Tab Navigation
            activeSubTab: this.props.requestedSubTab || 'orders', // 'checkins', 'orders', 'performance'
            
            selectedOrder: null,    
            selectedCheckin: null,  
            
            itemsPerPage: 5,
            

            selectedDelivery: null,

            isCreatingInvoice: false,
            isEditingDelivery: false,
            allProducts: [], // To list all products in a dropdown
            saleTaxes: [],   // To list all taxes in a dropdown
            // --- NEW: Custom Delivery Modal States ---
            showDeliveryModal: false,
            deliveryWizardId: null,
            deliveryLines: [],
            // --- NEW: PERFORMANCE TRACKING STATES ---
            perfSubTab: 'schedules', // 'schedules', 'targets'
            selectedSchedule: null,
            selectedTarget: null,
            isRefreshing: false,
            // --- BACKEND PAGINATION & FILTERS ---
            itemsPerPage: ITEMS_PER_PAGE,
            isLoadingList: false,
            searchTimeout: null,
            
            tableDeliveries: [], tableCheckins: [], tableOrders: [], tableSchedules: [], tableTargets: [],
            lookupBookers: [], lookupTargetTypes: [],
            
            pagination: {
                deliveries: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                checkins: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                orders: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                schedules: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                targets: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            filters: {
                deliveries: { search: '', status: '' },
                checkins: { search: '', status: '' },
                orders: { search: '', status: '' },
                schedules: { booker: 'all', day: 'all', dateFrom: '', dateTo: '' },
                targets: { booker: 'all', type: 'all' },
            },
        });
         // ADD THIS NEW BLOCK RIGHT AFTER THE STATE CLOSING BRACKET:
        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab && nextProps.requestedSubTab !== this.state.activeSubTab) {
                this.setSubTab(nextProps.requestedSubTab);
            }
        })

        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchActiveList = this.debounceSearch(() => this.fetchActiveList(), 400);

        onWillStart(async () => {
            await this.loadDropdownData();
            if (hasFinancialAccess()) await this.loadTaxAndProductData();
            await this.fetchActiveList();
        });
    }
    // --- UNIVERSAL PAGINATION HANDLERS ---
    onSearchInput(ev, tabName) {
        this.state.filters[tabName].search = ev.target.value;
        this.state.pagination[tabName].page = 1; 
        this.debouncedFetchActiveList();
    }

    onFilterChange(tabName) {
        this.state.pagination[tabName].page = 1;
        this.fetchActiveList(); 
    }

    changePage(tabName, direction) {
        const pag = this.state.pagination[tabName];
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchActiveList();
        }
    }

   async loadDropdownData() {
        this.state.lookupBookers = await this.orm.searchRead('res.users', [['shahtaj_is_order_booker', '=', true]], ['id', 'name']);
        
        // FIXED: Using .call() to safely execute read_group
        const types = await this.orm.call('shahtaj.visit.target', 'read_group', [[], ['target_type'], ['target_type']]);
        this.state.lookupTargetTypes = types.map(t => ({
            value: t.target_type, 
            label: t.target_type ? t.target_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Unknown'
        })).filter(t => t.value);
    }

    // --- THE MASTER DATA ENGINE ---
    async fetchActiveList() {
        let tab = this.state.activeSubTab;
        if (tab === 'performance') tab = this.state.perfSubTab;
        
        this.state.isLoadingList = true;
        try {
            const pag = this.state.pagination[tab];
            const filters = this.state.filters[tab];
            let domain = []; let model = ''; let fields = []; let targetState = '';

            // 1. DOMAIN MAPPINGS
            if (tab === 'deliveries' || tab === 'orders') {
                model = 'sale.order'; targetState = tab === 'deliveries' ? 'tableDeliveries' : 'tableOrders';
                fields = ["name", "partner_id", "user_id", "date_order", "amount_total","amount_tax", "state", "order_line", "invoice_status"];
                domain.push(['shahtaj_visit_id', '!=', false]);
                
                if (tab === 'deliveries') domain.push(['state', 'in', ['sale', 'done']]);
                if (filters.search) domain.push('|', '|', ['name', 'ilike', filters.search], ['partner_id.name', 'ilike', filters.search], ['user_id.name', 'ilike', filters.search]);
                if (filters.status) {
                    if (filters.status === 'Draft') domain.push(['state', '=', 'draft']);
                    else if (filters.status === 'Delivered') domain.push(['state', '=', 'done']);
                    else if (filters.status === 'To Invoice') domain.push(['state', '=', 'sale'], ['invoice_status', '!=', 'invoiced']);
                    else if (filters.status === 'Invoiced') domain.push(['invoice_status', '=', 'invoiced']);
                }
            } 
            else if (tab === 'checkins') {
                model = 'shahtaj.visit'; targetState = 'tableCheckins';
                fields = ["id", "shop_id", "order_booker_id", "started_at", "ended_at", "state", "outcome", "visit_task_id", "sale_order_id", "notes"];
                if (filters.search) domain.push('|', ['shop_id.name', 'ilike', filters.search], ['order_booker_id.name', 'ilike', filters.search]);
                if (filters.status === 'Checked In') domain.push(['state', '=', 'in_progress']);
                if (filters.status === 'Checked Out') domain.push(['state', '=', 'completed'], ['outcome', '!=', 'incomplete']);
                if (filters.status === 'Skipped') domain.push(['outcome', '=', 'incomplete']);
                if (filters.status === 'Cancelled') domain.push(['state', '=', 'cancelled']);
            }
            else if (tab === 'schedules') {
                model = 'shahtaj.weekly.schedule'; targetState = 'tableSchedules';
                fields = ['id', 'name', 'day_of_week', 'route_id', 'zone_id', 'active', 'shop_count', 'week_tasks_planned', 'week_tasks_completed', 'week_tasks_skipped', 'week_tasks_progress', 'week_occurrence_date', 'order_booker_id'];
                if (filters.booker !== 'all') domain.push(['order_booker_id', '=', parseInt(filters.booker)]);
                if (filters.day !== 'all') domain.push(['day_of_week', '=', filters.day]);
                if (filters.dateFrom) domain.push(['week_occurrence_date', '>=', filters.dateFrom]);
                if (filters.dateTo) domain.push(['week_occurrence_date', '<=', filters.dateTo]);
            }
            else if (tab === 'targets') {
                model = 'shahtaj.visit.target'; targetState = 'tableTargets';
                fields = ['id', 'name', 'date_start', 'date_end', 'target_type', 'target_value', 'achieved_value', 'remaining_value', 'progress_percent', 'product_id', 'currency_id', 'target_weight_uom', 'active', 'order_booker_id'];
                if (filters.booker !== 'all') domain.push(['order_booker_id', '=', parseInt(filters.booker)]);
                if (filters.type !== 'all') domain.push(['target_type', '=', filters.type]);
            }

            // 2. EXECUTE QUERY
            const queryKwargs = {
                limit: pag.limit,
                offset: (pag.page - 1) * pag.limit,
                order: "id desc",
            };
            // Schedules/targets: include deactivated rows for distributor visibility.
            if (tab === 'schedules' || tab === 'targets') {
                queryKwargs.context = { active_test: false };
            }
            if (tab === 'schedules') {
                queryKwargs.order = 'day_of_week asc, active desc, id desc';
            }
            const [total, records] = await Promise.all([
                this.orm.searchCount(
                    model,
                    domain,
                    (tab === 'schedules' || tab === 'targets') ? { context: { active_test: false } } : {},
                ),
                this.orm.searchRead(model, domain, fields, queryKwargs),
            ]);

            this.state.pagination[tab].total = total;

            // 3. MAP RESULTS
            if (tab === 'deliveries' || tab === 'orders') {
                const orderIds = records.map(o => o.id);
                const lines = orderIds.length ? await this.orm.searchRead("sale.order.line", [["order_id", "in", orderIds]], ["order_id", "product_uom_qty", "qty_delivered"]) : [];
                this.state[targetState] = records.map(o => {
                    const myLines = lines.filter(l => l.order_id[0] === o.id);
                    const totalOrd = myLines.reduce((sum, l) => sum + l.product_uom_qty, 0);
                    const totalDel = myLines.reduce((sum, l) => sum + l.qty_delivered, 0);
                    let status = 'Draft';
                    if (o.state === 'sale') status = o.invoice_status === 'invoiced' ? 'Invoiced' : 'To Invoice';
                    else if (o.state === 'done') status = 'Delivered';
                    return {
                        odoo_id: o.id, id: o.name, shop: o.partner_id ? o.partner_id[1] : 'Unknown', partner_id: o.partner_id,
                        booker: o.user_id ? o.user_id[1] : 'Unknown', date: o.date_order || 'Unknown', items: o.order_line.length,
                        total: `Rs. ${o.amount_total.toLocaleString(undefined, {minimumFractionDigits: 2})}`,
                        tax: `Rs. ${(o.amount_tax || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}`,
                        status: status, invoice_status: o.invoice_status,
                        is_fully_delivered: totalOrd > 0 && totalDel >= totalOrd, line_ids: o.order_line, lines: [] 
                    };
                });
            }
            else if (tab === 'checkins') {
                this.state.tableCheckins = records.map(v => {
                    let durationStr = "Active Now";
                    if (v.started_at && v.ended_at) durationStr = `${Math.round((new Date(v.ended_at.replace(' ', 'T') + "Z") - new Date(v.started_at.replace(' ', 'T') + "Z")) / 60000)} mins`;
                    let status = 'Unknown'; let outcome = v.outcome;
                    if (v.state === 'in_progress') { status = 'Checked In'; outcome = 'In Progress'; }
                    else if (v.state === 'completed' && v.outcome === 'incomplete') { status = 'Skipped'; outcome = 'Incomplete / Auto-Skipped'; }
                    else if (v.state === 'completed') { status = 'Checked Out'; outcome = outcome === 'order' ? 'Order Placed' : 'No Order'; }
                    else if (v.state === 'cancelled') { status = 'Cancelled'; }
                    return { id: v.id, shop: v.shop_id ? v.shop_id[1] : 'Unknown', shopId: v.shop_id ? v.shop_id[0] : false, booker: v.order_booker_id ? v.order_booker_id[1] : 'Unknown', bookerId: v.order_booker_id ? v.order_booker_id[0] : false, time: v.started_at || 'Pending', endTime: v.ended_at || 'In Progress', status, duration: durationStr, outcome, taskRef: v.visit_task_id ? v.visit_task_id[1] : 'Direct Visit', sale_order_id: v.sale_order_id, notes: v.notes || '' };
                });
            }
            else if (tab === 'schedules') {
                const dayMap = { '0': 'Monday', '1': 'Tuesday', '2': 'Wednesday', '3': 'Thursday', '4': 'Friday', '5': 'Saturday', '6': 'Sunday' };
                this.state.tableSchedules = records.map(r => ({
                    id: r.id, name: r.name, bookerId: r.order_booker_id ? r.order_booker_id[0] : null, bookerName: r.order_booker_id ? r.order_booker_id[1] : 'Unknown',
                    day_raw: r.day_of_week, day: dayMap[r.day_of_week] || r.day_of_week, route: r.route_id ? r.route_id[1] : 'Unassigned', zone: r.zone_id ? r.zone_id[1] : 'Unassigned',
                    shops: r.shop_count, active: r.active, planned: r.week_tasks_planned, done: r.week_tasks_completed, skipped: r.week_tasks_skipped || 0,
                    progress: r.week_tasks_progress || 0, occurrenceDate: r.week_occurrence_date || ''
                }));
            }
            else if (tab === 'targets') {
                this.state.tableTargets = records.map(r => ({
                    id: r.id, name: r.name, bookerId: r.order_booker_id ? r.order_booker_id[0] : null, bookerName: r.order_booker_id ? r.order_booker_id[1] : 'Unknown',
                    startDate: r.date_start, endDate: r.date_end, type: r.target_type, displayType: r.target_type ? r.target_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Unknown',
                    targetValue: r.target_value, achievedValue: r.achieved_value, remainingValue: r.remaining_value, progress: r.progress_percent || 0,
                    product: r.product_id ? r.product_id[1] : null, currency: r.currency_id ? r.currency_id[1] : null, weightUom: r.target_weight_uom || '', active: r.active
                }));
            }
        } catch (error) {
            this.notification.add("Failed to fetch data: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }
    setSubTab(tabName) {
        this.state.activeSubTab = tabName;
        this.state.selectedOrder = null;
        this.state.selectedCheckin = null;
        this.state.selectedSchedule = null;
        this.state.selectedTarget = null;
        this.fetchActiveList(); // Trigger fetch on switch
    }
    setPerfSubTab(tabName) {
        this.state.perfSubTab = tabName;
        this.state.selectedSchedule = null;
        this.state.selectedTarget = null;
        this.fetchActiveList(); // Trigger fetch on switch
    }
   async refreshData() {
        this.state.isRefreshing = true;
        try {
            await this.loadDropdownData();
            await this.fetchActiveList();
        } finally {
            this.state.isRefreshing = false;
        }
    }
    // --- DATA FETCHING (EXISTING) ---

    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    /**
     * Load datasets for one Operations sub-tab.
     * Domains, fields, and mapping stay identical; we only skip work for tabs not open yet.
     */

    /** Taxes/products are only needed for delivery line tax labels and edit dropdowns. */
    async ensureCatalogData({ force = false } = {}) {
        if (!hasFinancialAccess()) {
            return;
        }
        if (force || !this._catalogsLoaded) {
            await this.loadTaxAndProductData();
            this._catalogsLoaded = true;
        }
    }

    
    closeDelivery() { 
        this.state.selectedDelivery = null; 
    }

    toggleEditDelivery() {
        if (!hasFinancialAccess()) {
            return;
        }
        if (this.state.isEditingDelivery) {
            // If discarding changes, re-fetch to restore original data
            this.viewDelivery(this.state.selectedDelivery);
        } else {
            this.state.isEditingDelivery = true;
        }
    }

    recalcDeliveryLine(line) {
        // Auto-update the line subtotal locally
        line.subtotal = (parseFloat(line.qty) || 0) * (parseFloat(line.price) || 0);
        
        // Auto-update the order untaxed total locally
        let untaxed = 0;
        this.state.selectedDelivery.full_lines.forEach(l => {
            untaxed += l.subtotal;
        });
        
        this.state.selectedDelivery.amount_untaxed = untaxed;
        this.state.selectedDelivery.amount_total = untaxed + this.state.selectedDelivery.amount_tax;
    }

   async saveDeliveryChanges() {
        try {
            if (this.state.linesToDelete) {
                await this.orm.unlink("sale.order.line", this.state.linesToDelete);
                this.state.linesToDelete = [];
            }

            for (const line of this.state.selectedDelivery.full_lines) {
                const vals = {
                    order_id: this.state.selectedDelivery.odoo_id,
                    product_id: parseInt(line.productId),
                    product_uom_qty: parseFloat(line.qty),
                    price_unit: parseFloat(line.price),
                    // Write back the Many2many relation using the (6, 0, [ids]) tuple
                    tax_id: line.tax_id ? [[6, 0, [parseInt(line.tax_id)]]] : [[5, 0, 0]]
                };

                if (line.id) {
                    await this.orm.write("sale.order.line", [line.id], vals);
                } else {
                    await this.orm.create("sale.order.line", [vals]);
                }
            }
            
            await this.viewDelivery(this.state.selectedDelivery);
            this.state.isEditingDelivery = false;
            this.notification.add("Order saved successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to save: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async createInvoiceFromDelivery() {
        if (!hasFinancialAccess()) {
            return;
        }
        if (!this.state.selectedDelivery || this.state.isCreatingInvoice) return;
        
        // Temporarily hijack the selectedOrder state so we can reuse your existing createInvoice function
        this.state.selectedOrder = this.state.selectedDelivery;
        await this.createInvoice();
        
        // Refresh the delivery view to hide the invoice button
        await this.viewDelivery(this.state.selectedDelivery);
        this.state.selectedOrder = null; // Clean up
    }

   async loadTaxAndProductData() {
        if (!hasFinancialAccess()) {
            return;
        }
        const [taxes, prods] = await Promise.all([
            this.orm.searchRead(
                "account.tax",
                [["type_tax_use", "=", "sale"], ["active", "=", true]],
                ["id", "name", "amount"]
            ),
            this.orm.searchRead("product.template", [
                ["sale_ok", "=", true],
                ["active", "=", true],
                ["default_code", "!=", "SHAHTAJ-LEGACY"],
            ], ["id", "name"]),
        ]);
        this.state.saleTaxes = taxes;
        this.state.allProducts = prods;
        this._catalogsLoaded = true;
    }

    // 2. UPDATE THIS METHOD TO MAP TAX NAMES IN DELIVERIES
    async viewDelivery(dlv) {
        this.state.selectedDelivery = dlv;
        this.state.isEditingDelivery = false;
        // Need tax catalog so line tax labels resolve the same as before.
        await this.ensureCatalogData();
        
        try {
            // Reverted back to plural 'tax_ids'
            const lines = await this.orm.searchRead(
                "sale.order.line",
                [["order_id", "=", dlv.odoo_id]],
                ["id", "name", "product_id", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "tax_ids", "price_subtotal"]
            );

            dlv.full_lines = lines.map(l => {
                // Must read from l.tax_ids here as well
                const taxIds = l.tax_ids || [];
                const taxNames = taxIds.map(id => {
                    const tax = this.state.saleTaxes.find(t => t.id === id);
                    return tax ? tax.name : `Tax`;
                }).join(', ');

                return {
                    id: l.id,
                    // Maps the product ID so the dropdown auto-selects the existing product
                    productId: l.product_id ? l.product_id[0] : "", 
                    product: l.name,
                    qty: l.product_uom_qty,
                    delivered: l.qty_delivered,
                    invoiced: l.qty_invoiced,
                    price: l.price_unit,
                    tax_id: taxIds.length > 0 ? taxIds[0] : "", // Internal state reference
                    taxes: taxNames || 'None',
                    subtotal: l.price_subtotal
                };
            });

            const orderData = await this.orm.read("sale.order", [dlv.odoo_id], ["amount_untaxed", "amount_tax", "amount_total", "invoice_status"]);
            if (orderData.length > 0) {
                dlv.amount_untaxed = orderData[0].amount_untaxed;
                dlv.amount_tax = orderData[0].amount_tax;
                dlv.amount_total = orderData[0].amount_total;
                dlv.invoice_status = orderData[0].invoice_status;
            }
        } catch (error) {
             this.notification.add(error.data?.message || error.message, { type: "danger" });
        }
    }
    // --- New: Row Management ---
   addDeliveryLine() {
        this.state.selectedDelivery.full_lines.push({
            id: 'new_' + Date.now(), // Generate temporary ID
            productId: '',
            product: '',
            qty: 1,
            delivered: 0,
            invoiced: 0,
            price: 0,
            tax_ids: "",
            taxes: 'None',
            subtotal: 0
        });
    }

    removeDeliveryLine(lineId) {
        if (this.state.selectedDelivery.full_lines.length <= 1) {
            this.notification.add("An order must have at least one product line.", { type: "warning" });
            return;
        }
        if (!String(lineId).startsWith('new_')) {
            this.state.linesToDelete = this.state.linesToDelete || [];
            this.state.linesToDelete.push(lineId);
        }
        this.state.selectedDelivery.full_lines = this.state.selectedDelivery.full_lines.filter(l => l.id !== lineId);
    }

   async saveDeliveryChanges() {
        if (!hasFinancialAccess()) {
            return;
        }
        try {
            if (this.state.linesToDelete && this.state.linesToDelete.length > 0) {
                await this.orm.unlink("sale.order.line", this.state.linesToDelete);
                this.state.linesToDelete = [];
            }

            for (const line of this.state.selectedDelivery.full_lines) {
                if (!line.productId) {
                    this.notification.add("Please select a product for all lines.", { type: "warning" });
                    return;
                }
                
                const vals = {
                    order_id: this.state.selectedDelivery.odoo_id,
                    product_id: parseInt(line.productId),
                    product_uom_qty: parseFloat(line.qty) || 0,
                    price_unit: parseFloat(line.price) || 0,
                    // FIXED: Reverted payload key to plural 'tax_ids'
                    tax_ids: line.tax_id ? [[6, 0, [parseInt(line.tax_id)]]] : [[5, 0, 0]]
                };

                if (String(line.id).startsWith('new_')) {
                    await this.orm.create("sale.order.line", [vals]);
                } else {
                    await this.orm.write("sale.order.line", [line.id], vals);
                }
            }
            
            await this.viewDelivery(this.state.selectedDelivery);
            this.state.isEditingDelivery = false;
            this.notification.add("Order saved successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to save: " + (error.data?.message || error.message), { type: "danger" });
        }
    }
    // --- CUSTOM DELIVERY MODAL LOGIC ---
    async openDeliveryCustom(orderId) {
        try {
            const wizardIds = await this.orm.create("shahtaj.mark.delivery.wizard", [{}], {
                context: { active_id: orderId }
            });
            this.state.deliveryWizardId = wizardIds[0];
            
            const wizard = await this.orm.read("shahtaj.mark.delivery.wizard", [this.state.deliveryWizardId], ["line_ids"]);
            
            if (wizard[0].line_ids && wizard[0].line_ids.length > 0) {
                const linesData = await this.orm.read("shahtaj.mark.delivery.wizard.line", wizard[0].line_ids, [
                    "product_id", "qty_ordered", "qty_already_delivered", "qty_to_deliver"
                ]);
                
                this.state.deliveryLines = linesData.map(l => ({
                    id: l.id,
                    product: l.product_id ? l.product_id[1] : 'Unknown',
                    ordered: l.qty_ordered,
                    delivered: l.qty_already_delivered,
                    toDeliver: l.qty_to_deliver 
                }));
                this.state.showDeliveryModal = true;
            } else {
                this.notification.add("No pending deliveries found. The order may be fully delivered or lacks storable products.", { type: "info" });
            }
        } catch(error) {
            const msg = error.data?.message || error.message;
            // Catch Odoo's cryptic empty stock error
            if (msg.includes("Nothing to check") || msg.includes("empty")) {
                this.notification.add("This order is already 100% delivered! There is no pending stock left to process.", { type: "warning" });
            } else {
                this.notification.add("Failed to initialize delivery: " + msg, { type: "danger" });
            }
        }
    }

    closeDeliveryModal() {
        this.state.showDeliveryModal = false;
        this.state.deliveryWizardId = null;
        this.state.deliveryLines = [];
    }

    deliverAllRemaining() {
        // Helper button: Auto-fills the inputs to deliver 100% of remaining stock
        this.state.deliveryLines.forEach(line => {
            line.toDeliver = Math.max(0, line.ordered - line.delivered);
        });
    }
   async confirmDeliveryCustom() {
        try {
            // 1. Write the user's updated quantities back to the hidden Odoo wizard
            const lineUpdates = this.state.deliveryLines.map(line => {
                return this.orm.write("shahtaj.mark.delivery.wizard.line", [line.id], {
                    qty_to_deliver: parseFloat(line.toDeliver) || 0
                });
            });
            await Promise.all(lineUpdates);
            
            // 2. Trigger Odoo's native validation & backorder creation
            await this.orm.call("shahtaj.mark.delivery.wizard", "action_confirm_delivery", [this.state.deliveryWizardId]);
            
            this.notification.add("Delivery logged successfully.", { type: "success" });
            this.closeDeliveryModal();
            
            // 3. Refresh the UI
            await this.fetchActiveList();
            if (this.state.selectedDelivery) {
                // FIX: Look in the new paginated arrays instead of the deleted 'orders' array
                let updatedOrder = this.state.tableDeliveries.find(o => o.odoo_id === this.state.selectedDelivery.odoo_id) || 
                                   this.state.tableOrders.find(o => o.odoo_id === this.state.selectedDelivery.odoo_id);
                
                if (!updatedOrder) {
                    updatedOrder = this.state.selectedDelivery; // Fallback
                }
                
                // Forcefully update the status so the UI immediately reflects the delivery
                updatedOrder.status = 'Delivered';
                await this.viewDelivery(updatedOrder);
            }
            
        } catch(error) {
            this.notification.add("Failed to confirm delivery: " + (error.data?.message || error.message), { type: "danger" });
        }
    }
    // --- NAVIGATION & FILTERS ---

  setSubTab(tabName) {
        this.state.activeSubTab = tabName;
        
        // If we are programmatically jumping to a record, protect the view from being cleared
        if (this._preserveDetailsOnSwitch) {
            this._preserveDetailsOnSwitch = false; // Consume the flag
        } else {
            // Otherwise, clear the views normally (standard sidebar click)
            this.state.selectedOrder = null;
            this.state.selectedCheckin = null;
            this.state.selectedSchedule = null;
            this.state.selectedTarget = null;
        }
        
        this.fetchActiveList(); 
    }
    setPerfSubTab(tabName) {
        this.state.perfSubTab = tabName;
        this.state.selectedSchedule = null;
        this.state.selectedTarget = null;
        this.fetchActiveList(); 
    }

    viewSchedule(sched) { this.state.selectedSchedule = sched; }
    closeSchedule() { this.state.selectedSchedule = null; }

    viewTarget(tgt) { this.state.selectedTarget = tgt; }
    closeTarget() { this.state.selectedTarget = null; }

    // --- ORDER ACTIONS (EXISTING) ---
    async viewOrder(order) { 
        // 1. Assign to state FIRST to wrap it in Owl's reactive proxy
        this.state.selectedOrder = order; 
        
        // FIX: Initialize the contact fields so the "Loading..." check triggers the DB fetch
        if (!this.state.selectedOrder.phone) {
            this.state.selectedOrder.phone = "Loading...";
            this.state.selectedOrder.email = "Loading...";
            this.state.selectedOrder.address = "Loading...";
        }
        
        if (this.state.selectedOrder.line_ids && this.state.selectedOrder.line_ids.length > 0 && this.state.selectedOrder.lines.length === 0) {
            const lines = await this.orm.searchRead(
                "sale.order.line",
                [["id", "in", this.state.selectedOrder.line_ids]],
                ["name", "product_uom_qty", "product_uom_id", "price_unit", "price_subtotal", "tax_ids"] 
            );
            
            // 2. Assign strictly to the reactive proxy so the UI repaints instantly
            this.state.selectedOrder.lines = lines.map(l => {
                const taxIds = l.tax_ids || [];
                const taxNames = taxIds.map(id => {
                    const tax = this.state.saleTaxes ? this.state.saleTaxes.find(t => t.id === id) : null;
                    return tax ? tax.name : `Tax`;
                }).join(', ');
                return {
                    product: l.name,
                    qty: l.product_uom_qty,
                    unit: l.product_uom_id ? l.product_uom_id[1] : 'Units',
                    price: l.price_unit.toLocaleString(undefined, {minimumFractionDigits: 2}),
                    taxes: taxNames || 'None',
                    subtotal: l.price_subtotal.toLocaleString(undefined, {minimumFractionDigits: 2})
                };
            });
        }

        if (this.state.selectedOrder.partner_id && this.state.selectedOrder.phone === "Loading...") {
            const partners = await this.orm.searchRead(
                "res.partner",
                [["id", "=", this.state.selectedOrder.partner_id[0]]],
                ["phone", "email", "street", "city"]
            );
            if (partners.length > 0) {
                const p = partners[0];
                // 3. Assign strictly to the reactive proxy
                this.state.selectedOrder.phone = p.phone || 'N/A';
                this.state.selectedOrder.email = p.email || 'N/A';
                this.state.selectedOrder.address = [p.street, p.city].filter(Boolean).join(', ') || 'No address provided';
            }
        }
    }
    
    closeOrder() { this.state.selectedOrder = null; }

    viewCheckin(log) { this.state.selectedCheckin = log; }
    closeCheckin() { this.state.selectedCheckin = null; }

  async viewOrderFromCheckin(log) {
        if (!log.sale_order_id) return;
        
        try {
            const orders = await this.orm.searchRead(
                "sale.order",
                [["id", "=", log.sale_order_id[0]]],
                ["name", "partner_id", "user_id", "date_order", "amount_total","amount_tax", "state", "order_line", "invoice_status"]
            );

            if (orders.length > 0) {
                const o = orders[0];
                const lines = o.order_line.length ? await this.orm.searchRead("sale.order.line", [["order_id", "=", o.id]], ["product_uom_qty", "qty_delivered"]) : [];
                const totalOrd = lines.reduce((sum, l) => sum + l.product_uom_qty, 0);
                const totalDel = lines.reduce((sum, l) => sum + l.qty_delivered, 0);
                
                let status = 'Draft';
                if (o.state === 'sale') status = o.invoice_status === 'invoiced' ? 'Invoiced' : 'To Invoice';
                else if (o.state === 'done') status = 'Delivered';

                const targetOrder = {
                    odoo_id: o.id, id: o.name, shop: o.partner_id ? o.partner_id[1] : 'Unknown', partner_id: o.partner_id,
                    booker: o.user_id ? o.user_id[1] : 'Unknown', date: o.date_order || 'Unknown', items: o.order_line.length,
                    total: `Rs. ${o.amount_total.toLocaleString(undefined, {minimumFractionDigits: 2})}`,
                    tax: `Rs. ${(o.amount_tax || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}`,
                    status: status, invoice_status: o.invoice_status,
                    is_fully_delivered: totalOrd > 0 && totalDel >= totalOrd, line_ids: o.order_line, lines: [] 
                };

                // 1. Activate the protection flag so data isn't wiped by the incoming sub-tab change
                this._preserveDetailsOnSwitch = true;

                // 2. Dispatch event to update parent sidebar smoothly
                window.dispatchEvent(new CustomEvent('shahtaj-dashboard-switch', {
                    detail: { tab: 'operations', subTab: 'orders' }
                }));

                // 3. Open the specific order details directly
                await this.viewOrder(targetOrder);
            }
        } catch (error) {
            this.notification.add("Failed to load order: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

   async createInvoice() {
        if (!hasFinancialAccess()) {
            return;
        }
        if (!this.state.selectedOrder || this.state.isCreatingInvoice) return;
        this.state.isCreatingInvoice = true;
        
        try {
            // Use Odoo's native invoice generation wizard
            const context = { active_model: 'sale.order', active_ids: [this.state.selectedOrder.odoo_id] };
            const wizardIds = await this.orm.create("sale.advance.payment.inv", [{ advance_payment_method: 'delivered' }], { context });
            await this.orm.call("sale.advance.payment.inv", "create_invoices", [wizardIds], { context });
            
            this.notification.add(`Draft invoice generated successfully.`, {
                title: "Success",
                type: "success",
            });

            // Update local state to reflect the new status
            this.state.selectedOrder.invoice_status = 'invoiced';
            this.state.selectedOrder.status = 'Invoiced'; 
            
            // Refresh the background data
            await this.fetchActiveList();

        } catch (error) {
            this.notification.add(error.data?.message || "Failed to create invoice.", {
                title: "Action Failed",
                type: "danger",
            });
        } finally {
            this.state.isCreatingInvoice = false;
        }
    }
    openDeliveryWizard(orderId) {
        this.action.doAction("shahtaj_oil.action_shahtaj_mark_delivery_wizard", {
            additionalContext: { active_id: orderId },
            onClose: async () => {
                // Refresh the lists when the wizard closes
                await this.fetchActiveList();
            }
        });
    }
}

OperationsTracking.template = "shahtaj_oil.OperationsTracking";