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
        this.state = useState({
            // Main Tab Navigation
            activeSubTab: this.props.requestedSubTab || 'orders', // 'checkins', 'orders', 'performance'
            
            selectedOrder: null,    
            selectedCheckin: null,  
            
            itemsPerPage: 5,
            
            deliveryFilters: { search: '', status: '' },
            deliveryPage: 1,
            
            checkinFilters: { search: '', status: '' },
            checkinPage: 1,
            
            orderFilters: { search: '', status: '' },
            orderPage: 1,

            deliveries: [],
            selectedDelivery: null,

            checkins: [],
            orders: [],
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
            
            // Filters for Schedules
            schedFilterBooker: 'all',
            schedFilterDay: 'all',
            schedFilterDateFrom: '',
            schedFilterDateTo: '',
            
            // Filters for Targets
            targetFilterBooker: 'all',
            targetFilterType: 'all',
            
            bookers: [],
            schedules: [],
            targets: [],
            isRefreshing: false,
        });
         // ADD THIS NEW BLOCK RIGHT AFTER THE STATE CLOSING BRACKET:
        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab && nextProps.requestedSubTab !== this.state.activeSubTab) {
                this.setSubTab(nextProps.requestedSubTab);
            }
        })

        onWillStart(async () => {
            const tasks = [
                this.fetchLiveVisits(),
                this.fetchLiveOrders(),
                this.fetchPerformanceData(),
            ];
            if (hasFinancialAccess()) {
                tasks.push(this.loadTaxAndProductData());
            }
            await Promise.all(tasks);
        });
    }

    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    // --- NEW: Global Refresh Method ---
    async refreshData() {
        this.state.isRefreshing = true;
        try {
            const tasks = [
                this.fetchLiveVisits(),
                this.fetchLiveOrders(),
                this.fetchPerformanceData(),
            ];
            if (hasFinancialAccess()) {
                tasks.push(this.loadTaxAndProductData());
            }
            await Promise.all(tasks);
        } finally {
            this.state.isRefreshing = false;
        }
    }
    // --- DATA FETCHING (EXISTING) ---

   async fetchLiveVisits() {
        const visits = await this.orm.searchRead(
            "shahtaj.visit",
            [],
            ["id", "shop_id", "order_booker_id", "started_at", "ended_at", "state", "outcome", "visit_task_id", "sale_order_id", "notes"]
        );

        this.state.checkins = visits.map(v => {
            let durationStr = "Active Now";
            if (v.started_at && v.ended_at) {
                const start = new Date(v.started_at.replace(' ', 'T') + "Z");
                const end = new Date(v.ended_at.replace(' ', 'T') + "Z");
                const diffMs = end - start;
                const diffMins = Math.round(diffMs / 60000);
                durationStr = `${diffMins} mins`;
            }

            let displayStatus = 'Unknown';
            if (v.state === 'in_progress') displayStatus = 'Checked In';
            else if (v.state === 'completed') displayStatus = 'Checked Out';
            else if (v.state === 'cancelled') displayStatus = 'Cancelled';

            let displayOutcome = v.outcome;
            if (v.outcome === 'none') displayOutcome = 'In Progress';
            else if (v.outcome === 'order') displayOutcome = 'Order Placed';
            else if (v.outcome === 'no_order') displayOutcome = 'No Order';

            return {
                id: v.id,
                shop: v.shop_id ? v.shop_id[1] : 'Unknown Shop',
                shopId: v.shop_id ? v.shop_id[0] : false,
                booker: v.order_booker_id ? v.order_booker_id[1] : 'Unknown Booker',
                bookerId: v.order_booker_id ? v.order_booker_id[0] : false,
                time: v.started_at || 'Pending',
                endTime: v.ended_at || 'In Progress',
                status: displayStatus,
                duration: durationStr,
                outcome: displayOutcome,
                taskRef: v.visit_task_id ? v.visit_task_id[1] : 'Direct Visit',
                sale_order_id: v.sale_order_id ,
                notes: v.notes || ''
            };
        });
    }

    async fetchLiveOrders() {
        const orders = await this.orm.searchRead(
            "sale.order",
            [["shahtaj_visit_id", "!=", false]], 
            ["name", "partner_id", "user_id", "date_order", "amount_total", "state", "order_line", "invoice_status"] 
        );

        // Fetch exact line quantities to accurately determine Delivery Status
        const orderIds = orders.map(o => o.id);
        let lines = [];
        if (orderIds.length > 0) {
            lines = await this.orm.searchRead(
                "sale.order.line", 
                [["order_id", "in", orderIds]], 
                ["order_id", "product_uom_qty", "qty_delivered"]
            );
        }

        this.state.orders = orders.map(o => {
            // Calculate delivery math for this specific order
            const myLines = lines.filter(l => l.order_id[0] === o.id);
            const totalOrdered = myLines.reduce((sum, l) => sum + l.product_uom_qty, 0);
            const totalDelivered = myLines.reduce((sum, l) => sum + l.qty_delivered, 0);
            const is_fully_delivered = totalOrdered > 0 && totalDelivered >= totalOrdered;

            let status = 'Unknown';
            if (o.state === 'draft') {
                status = 'Draft';
            } else if (o.state === 'sale') {
                if (o.invoice_status === 'invoiced') status = 'Invoiced';
                else status = 'To Invoice'; // Default for live orders
            } else if (o.state === 'done') {
                status = 'Delivered'; 
            }

            return {
                odoo_id: o.id,
                id: o.name,
                shop: o.partner_id ? o.partner_id[1] : 'Unknown Shop',
                partner_id: o.partner_id,
                booker: o.user_id ? o.user_id[1] : 'Unknown Booker',
                address: "Loading...", 
                phone: "Loading...",
                email: "Loading...",
                date: o.date_order || 'Unknown',
                items: o.order_line.length,
                total: `Rs. ${o.amount_total.toLocaleString(undefined, {minimumFractionDigits: 2})}`,
                status: status, 
                invoice_status: o.invoice_status,
                is_fully_delivered: is_fully_delivered, // New property!
                line_ids: o.order_line,
                lines: [] 
            };
        });
        
        // Only show orders that are confirmed/to-invoice in the deliveries tab
        this.state.deliveries = this.state.orders.filter(o => o.status === 'To Invoice' || o.status === 'Delivered');
    }

    // --- NEW: PERFORMANCE DATA FETCHING ---
    async fetchPerformanceData() {
        const bookers = await this.orm.searchRead('res.users', [['shahtaj_is_order_booker', '=', true]], ['id', 'name']);
        this.state.bookers = bookers;

        const scheds = await this.orm.searchRead('shahtaj.weekly.schedule', [], [
            'id', 'name', 'day_of_week', 'route_id', 'zone_id', 'active', 'shop_count',
            'week_tasks_planned', 'week_tasks_completed', 'week_tasks_progress',
            'week_occurrence_date', 'order_booker_id'
        ]);
        const dayMap = { '0': 'Monday', '1': 'Tuesday', '2': 'Wednesday', '3': 'Thursday', '4': 'Friday', '5': 'Saturday', '6': 'Sunday' };
        this.state.schedules = scheds.map(r => ({
            id: r.id,
            name: r.name,
            bookerId: r.order_booker_id ? r.order_booker_id[0] : null,
            bookerName: r.order_booker_id ? r.order_booker_id[1] : 'Unknown Booker',
            day_raw: r.day_of_week,
            day: dayMap[r.day_of_week] || r.day_of_week,
            route: r.route_id ? r.route_id[1] : 'Unassigned',
            zone: r.zone_id ? r.zone_id[1] : 'Unassigned',
            shops: r.shop_count,
            active: r.active,
            planned: r.week_tasks_planned,
            done: r.week_tasks_completed,
            progress: r.week_tasks_progress || 0,
            occurrenceDate: r.week_occurrence_date || ''
        }));

        const tgts = await this.orm.searchRead('shahtaj.visit.target', [], [
            'id', 'name', 'date_start', 'date_end', 'target_type', 'target_value',
            'achieved_value', 'remaining_value', 'progress_percent', 'product_id',
            'currency_id', 'target_weight_uom', 'active', 'order_booker_id'
        ]);
        this.state.targets = tgts.map(r => ({
            id: r.id,
            name: r.name,
            bookerId: r.order_booker_id ? r.order_booker_id[0] : null,
            bookerName: r.order_booker_id ? r.order_booker_id[1] : 'Unknown Booker',
            startDate: r.date_start,
            endDate: r.date_end,
            type: r.target_type,
            displayType: r.target_type ? r.target_type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Unknown',
            targetValue: r.target_value,
            achievedValue: r.achieved_value,
            remainingValue: r.remaining_value,
            progress: r.progress_percent || 0,
            product: r.product_id ? r.product_id[1] : null,
            currency: r.currency_id ? r.currency_id[1] : null,
            weightUom: r.target_weight_uom || '',
            active: r.active
        }));
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
        // Fetch standard Odoo Sales Taxes
        const taxes = await this.orm.searchRead(
            "account.tax",
            [["type_tax_use", "=", "sale"], ["active", "=", true]],
            ["id", "name", "amount"]
        );
        this.state.saleTaxes = taxes;

        // Fetch Products (for the dropdown)
        const prods = await this.orm.searchRead("product.template", [
            ["sale_ok", "=", true],
            ["active", "=", true],
        ], ["id", "name"]);
        this.state.allProducts = prods;
    }

    // 2. UPDATE THIS METHOD TO MAP TAX NAMES IN DELIVERIES
    async viewDelivery(dlv) {
        this.state.selectedDelivery = dlv;
        this.state.isEditingDelivery = false; 
        
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
    // Custom delivery confirmation logic that writes back to Odoo and triggers the native validation
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
            await this.fetchLiveOrders();
            if (this.state.selectedDelivery) {
                const updatedOrder = this.state.orders.find(o => o.odoo_id === this.state.selectedDelivery.odoo_id);
                if (updatedOrder) {
                    // --- CHANGED: Forcefully update the status so the UI immediately reflects the delivery ---
                    updatedOrder.status = 'Delivered';
                    await this.viewDelivery(updatedOrder);
                }
            }
            
        } catch(error) {
            this.notification.add("Failed to confirm delivery: " + (error.data?.message || error.message), { type: "danger" });
        }
    }
    // --- NAVIGATION & FILTERS ---

    setSubTab(tabName) {
        this.state.activeSubTab = tabName;
        this.state.selectedOrder = null;
        this.state.selectedCheckin = null;
        this.state.selectedSchedule = null;
        this.state.selectedTarget = null;
    }

    setPerfSubTab(tabName) {
        this.state.perfSubTab = tabName;
        this.state.selectedSchedule = null;
        this.state.selectedTarget = null;
    }

    // Performance Getters
    get filteredSchedules() {
        return this.state.schedules.filter(s => {
            const matchBooker = this.state.schedFilterBooker === 'all' || s.bookerId == this.state.schedFilterBooker;
            const matchDay = this.state.schedFilterDay === 'all' || String(s.day_raw) === this.state.schedFilterDay;
            const matchDateFrom = !this.state.schedFilterDateFrom || s.occurrenceDate >= this.state.schedFilterDateFrom;
            const matchDateTo = !this.state.schedFilterDateTo || s.occurrenceDate <= this.state.schedFilterDateTo;
            return matchBooker && matchDay && matchDateFrom && matchDateTo;
        });
    }

    get filteredTargets() {
        return this.state.targets.filter(t => {
            const matchBooker = this.state.targetFilterBooker === 'all' || t.bookerId == this.state.targetFilterBooker;
            const matchType = this.state.targetFilterType === 'all' || t.type === this.state.targetFilterType;
            return matchBooker && matchType;
        });
    }

    get uniqueTargetTypes() {
        const types = new Set(this.state.targets.map(t => t.type));
        return Array.from(types).map(type => {
            return {
                value: type,
                label: type ? type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Unknown'
            };
        });
    }

    viewSchedule(sched) { this.state.selectedSchedule = sched; }
    closeSchedule() { this.state.selectedSchedule = null; }

    viewTarget(tgt) { this.state.selectedTarget = tgt; }
    closeTarget() { this.state.selectedTarget = null; }


    // --- ORDERS & CHECK-INS PAGINATION GETTERS (EXISTING) ---
    get filteredDeliveries() {
        return this.state.deliveries.filter(d => {
            const searchStr = this.state.deliveryFilters.search.toLowerCase();
            const matchSearch = d.shop.toLowerCase().includes(searchStr) || 
                                d.id.toLowerCase().includes(searchStr) ||
                                d.booker.toLowerCase().includes(searchStr);
            const matchStatus = this.state.deliveryFilters.status ? d.status === this.state.deliveryFilters.status : true;
            return matchSearch && matchStatus;
        });
    }
    get paginatedDeliveries() {
        const start = (this.state.deliveryPage - 1) * this.state.itemsPerPage;
        return this.filteredDeliveries.slice(start, start + this.state.itemsPerPage);
    }
    get deliveryTotalPages() { return Math.max(1, Math.ceil(this.filteredDeliveries.length / this.state.itemsPerPage)); }

    get filteredCheckins() {
        return this.state.checkins.filter(c => {
            const matchSearch = c.shop.toLowerCase().includes(this.state.checkinFilters.search.toLowerCase()) || 
                                c.booker.toLowerCase().includes(this.state.checkinFilters.search.toLowerCase()) ||
                                String(c.shopId || '').includes(this.state.checkinFilters.search) ||
                                String(c.bookerId || '').includes(this.state.checkinFilters.search);
            const matchStatus = this.state.checkinFilters.status ? c.status === this.state.checkinFilters.status : true;
            return matchSearch && matchStatus;
        });
    }
    get paginatedCheckins() {
        const start = (this.state.checkinPage - 1) * this.state.itemsPerPage;
        return this.filteredCheckins.slice(start, start + this.state.itemsPerPage);
    }
    get checkinTotalPages() { return Math.max(1, Math.ceil(this.filteredCheckins.length / this.state.itemsPerPage)); }

    get filteredOrders() {
        return this.state.orders.filter(o => {
            const matchSearch = o.shop.toLowerCase().includes(this.state.orderFilters.search.toLowerCase()) || 
                                o.id.toLowerCase().includes(this.state.orderFilters.search.toLowerCase()) ||
                                o.booker.toLowerCase().includes(this.state.orderFilters.search.toLowerCase()) ||
                                String(o.shopId || '').includes(this.state.orderFilters.search) ||
                                String(o.bookerId || '').includes(this.state.orderFilters.search);
            const matchStatus = this.state.orderFilters.status ? o.status === this.state.orderFilters.status : true;
            return matchSearch && matchStatus;
        });
    }
    get paginatedOrders() {
        const start = (this.state.orderPage - 1) * this.state.itemsPerPage;
        return this.filteredOrders.slice(start, start + this.state.itemsPerPage);
    }
    get orderTotalPages() { return Math.max(1, Math.ceil(this.filteredOrders.length / this.state.itemsPerPage)); }

    changePage(type, direction) {
        if (type === 'delivery') {
            const newPage = this.state.deliveryPage + direction;
            if (newPage >= 1 && newPage <= this.deliveryTotalPages) this.state.deliveryPage = newPage;
        } else if (type === 'checkin') {
            const newPage = this.state.checkinPage + direction;
            if (newPage >= 1 && newPage <= this.checkinTotalPages) this.state.checkinPage = newPage;
        } else if (type === 'order') {
            const newPage = this.state.orderPage + direction;
            if (newPage >= 1 && newPage <= this.orderTotalPages) this.state.orderPage = newPage;
        }
    }

    // --- ORDER ACTIONS (EXISTING) ---
    async viewOrder(order) { 
        this.state.selectedOrder = order; 
        
        if (order.line_ids && order.line_ids.length > 0 && order.lines.length === 0) {
            const lines = await this.orm.searchRead(
                "sale.order.line",
                [["id", "in", order.line_ids]],
                // Added "tax_ids" to the requested fields
                ["name", "product_uom_qty", "product_uom_id", "price_unit", "price_subtotal", "tax_ids"] 
            );
            
            order.lines = lines.map(l => {
                const taxIds = l.tax_ids || [];
                const taxNames = taxIds.map(id => {
                    const tax = this.state.saleTaxes.find(t => t.id === id);
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

        if (order.partner_id && order.phone === "Loading...") {
            const partners = await this.orm.searchRead(
                "res.partner",
                [["id", "=", order.partner_id[0]]],
                ["phone", "email", "street", "city"]
            );
            if (partners.length > 0) {
                const p = partners[0];
                order.phone = p.phone || 'N/A';
                order.email = p.email || 'N/A';
                order.address = [p.street, p.city].filter(Boolean).join(', ') || 'No address provided';
            }
        }
    }
    
    closeOrder() { this.state.selectedOrder = null; }

    viewCheckin(log) { this.state.selectedCheckin = log; }
    closeCheckin() { this.state.selectedCheckin = null; }

    async viewOrderFromCheckin(log) {
        if (log.sale_order_id) {
            let targetOrder = this.state.orders.find(o => o.odoo_id === log.sale_order_id[0]);
            
            if (!targetOrder) {
                await this.fetchLiveOrders();
                targetOrder = this.state.orders.find(o => o.odoo_id === log.sale_order_id[0]);
            }
            
            if (targetOrder) {
                this.setSubTab('orders');
                await this.viewOrder(targetOrder);
            }
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
            await this.fetchLiveOrders();

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
                await this.fetchLiveOrders();
            }
        });
    }
}

OperationsTracking.template = "shahtaj_oil.OperationsTracking";