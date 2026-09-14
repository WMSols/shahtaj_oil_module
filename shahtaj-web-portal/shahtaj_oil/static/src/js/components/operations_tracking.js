/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps, useEffect, useRef } from "@odoo/owl";
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
        this.checkinMapRef = useRef("checkinMapContainer");
        this.checkinMapInstance = null;
        const ITEMS_PER_PAGE = 10;
        const today = new Date();
        this.todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        this.state = useState({
            // Main Tab Navigation
            activeSubTab: this.props.requestedSubTab || 'orders', // 'checkins', 'orders', 'performance'
            
            selectedOrder: null,    
            selectedCheckin: null,  
            
            itemsPerPage: 5,
            
            
            selectedDelivery: null,

            isCreatingInvoice: false,
            isConfirmingOrder: false,
            isSavingSaleOrder: false,
            isEditingDelivery: false,
            allProducts: [], // To list all products in a dropdown
            saleTaxes: [],   // To list all taxes in a dropdown
            lookupShops: [],
            saleProducts: [],
            showSaleOrderForm: false,
            saleOrderForm: this._emptySaleOrderForm(),
            ordersSubTab: 'live', // 'live' | 'verification'
            shopSnapshotOpen: false,
            verificationCount: 0,
            isApprovingOrder: false,
            isProcessingOverride: false,
            isRejectingOrder: false,
            showRejectModal: false,
            rejectReason: '',
            showCreditOverride: false,
            creditOverride: {
                orderId: null,
                shop: '',
                orderAmount: 0,
                creditLimit: 0,
                outstanding: 0,
                effective: 0,
                shortfall: 0,
                newLimit: '',
                note: '',
                actionType: 'approve',
            },
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
            
            tableDeliveries: [], tableCheckins: [], tableOrders: [], tableVerification: [], tableSchedules: [], tableTargets: [],
            lookupBookers: [], lookupTargetTypes: [],
            
            pagination: {
                deliveries: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                checkins: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                orders: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                verification: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                schedules: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                targets: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            filters: {
                deliveries: { search: '', status: '' },
                checkins: { search: '', status: '', purpose: 'all', booker: 'all', date: '' },
                orders: { search: '', status: '', booker: 'all' },
                verification: { search: '', booker: 'all', reason: 'all' },
                schedules: { booker: 'all', day: 'all' },
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
            // Catalogs are large on production; do not block Live Orders on them.
            await Promise.all([
                this.loadDropdownData(),
                this.fetchActiveList(),
            ]);
            this.loadSaleOrderCatalog();
            if (hasFinancialAccess()) this.loadTaxAndProductData();
        });

        useEffect(() => {
            if (this.checkinMapInstance) {
                this.checkinMapInstance.remove();
                this.checkinMapInstance = null;
            }

            const mapEl = this.checkinMapRef.el;
            const log = this.state.selectedCheckin;
            if (!mapEl || !log) {
                return () => {};
            }

            const shopLat = log.shop_latitude;
            const shopLng = log.shop_longitude;
            const attLat = log.attempt_latitude;
            const attLng = log.attempt_longitude;
            const hasShop = shopLat && shopLng;
            const hasAttempt = attLat && attLng;

            if (!hasShop && !hasAttempt) {
                return () => {};
            }

            if (typeof L === 'undefined') {
                console.warn("Leaflet library is missing! Check your __manifest__.py assets.");
                return () => {};
            }

            const center = hasShop ? [shopLat, shopLng] : [attLat, attLng];
            this.checkinMapInstance = L.map(mapEl).setView(center, 16);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap',
            }).addTo(this.checkinMapInstance);

            const bounds = [];
            if (hasShop) {
                L.circleMarker([shopLat, shopLng], {
                    radius: 9,
                    color: '#0d6efd',
                    fillColor: '#0d6efd',
                    fillOpacity: 0.95,
                    weight: 2,
                }).addTo(this.checkinMapInstance).bindPopup(`<b>${log.shop}</b><br/>Shop location`);
                bounds.push([shopLat, shopLng]);
                if (log.max_distance_m > 0) {
                    L.circle([shopLat, shopLng], {
                        radius: log.max_distance_m,
                        color: '#0d6efd',
                        fillColor: '#0d6efd',
                        fillOpacity: 0.08,
                        weight: 1,
                        dashArray: '4 4',
                    }).addTo(this.checkinMapInstance);
                }
            }
            if (hasAttempt) {
                const ok = log.isOk;
                L.circleMarker([attLat, attLng], {
                    radius: 9,
                    color: ok ? '#198754' : '#dc3545',
                    fillColor: ok ? '#198754' : '#dc3545',
                    fillOpacity: 0.95,
                    weight: 2,
                }).addTo(this.checkinMapInstance).bindPopup(
                    `<b>${ok ? 'GPS OK' : 'Blocked attempt'}</b><br/>${log.userLabel || log.booker}`
                );
                bounds.push([attLat, attLng]);
            }
            if (bounds.length > 1) {
                this.checkinMapInstance.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 });
            }

            return () => {
                if (this.checkinMapInstance) {
                    this.checkinMapInstance.remove();
                    this.checkinMapInstance = null;
                }
            };
        }, () => [this.checkinMapRef.el, this.state.selectedCheckin]);
    }

    _emptySaleOrderLine() {
        return {
            id: `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            product_id: '',
            qty: 1,
            price: 0,
            tax_id: '',
        };
    }

    _emptySaleOrderForm() {
        return {
            partner_id: '',
            date_order: this.todayStr,
            lines: [this._emptySaleOrderLine()],
        };
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

    /**
     * Parse an Odoo Datetime (naive UTC, e.g. "2026-08-19 14:36:00") as a Date.
     */
    _parseOdooUtc(value) {
        if (!value) {
            return null;
        }
        const date = new Date(String(value).replace(' ', 'T') + 'Z');
        return Number.isNaN(date.getTime()) ? null : date;
    }

    /**
     * Convert an Odoo UTC datetime string to Pakistan Standard Time for display.
     * PKT is UTC+5 year-round (Asia/Karachi, no DST).
     */
    formatUtcToPkt(value) {
        if (!value || value === 'Pending' || value === 'In Progress') {
            return value;
        }
        const date = this._parseOdooUtc(value);
        if (!date) {
            return value;
        }
        const formatted = date.toLocaleString('en-GB', {
            timeZone: 'Asia/Karachi',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        });
        return `${formatted} PKT`;
    }

    /**
     * Convert a Pakistan calendar date (YYYY-MM-DD) to Odoo UTC naive bounds.
     * PKT day 2026-08-19 is 2026-08-18 19:00:00 UTC through 2026-08-19 18:59:59 UTC.
     */
    _pktDateToUtcBounds(dateStr) {
        const start = new Date(`${dateStr}T00:00:00+05:00`);
        const end = new Date(`${dateStr}T23:59:59+05:00`);
        const toOdooUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
        return { start: toOdooUtc(start), end: toOdooUtc(end) };
    }

    _gpsPurposeLabel(purpose) {
        return ({ check_in: 'Check-in', place_order: 'Place Order', deliver: 'Deliver to Shop' })[purpose] || purpose || '—';
    }

    _gpsResultLabel(result) {
        return ({
            ok: 'GPS OK',
            blocked_too_far: 'Blocked — Too Far',
            blocked_too_close: 'Blocked — Too Close',
            blocked_missing_shop_gps: 'Blocked — Shop GPS Missing',
            blocked_missing_user_gps: 'Blocked — User GPS Missing',
            blocked_invalid_coords: 'Blocked — Invalid Coordinates',
        })[result] || result || 'Unknown';
    }

    _gpsStatusBadgeClass(result) {
        if (result === 'ok') return 'bg-success text-white shadow-sm';
        if (result === 'blocked_too_far' || result === 'blocked_too_close') return 'bg-danger text-white shadow-sm';
        return 'bg-warning text-dark shadow-sm';
    }

    _gpsRoleLabel(role) {
        return ({ order_booker: 'Order Booker', delivery_man: 'Delivery Man', other: 'Other' })[role] || role || '—';
    }

    /**
     * Odoo weekday key for today in Pakistan: '0' Monday … '6' Sunday.
     */
    _pktTodayWeekday() {
        const weekday = new Date().toLocaleDateString('en-US', {
            timeZone: 'Asia/Karachi',
            weekday: 'short',
        }).slice(0, 3);
        const map = { Mon: '0', Tue: '1', Wed: '2', Thu: '3', Fri: '4', Sat: '5', Sun: '6' };
        return map[weekday] || '0';
    }

    /**
     * Distance from today along the week (0 = today, 1 = tomorrow, … 6 = yesterday).
     */
    _weekdayOffsetFromToday(dayRaw, todayDow = this._pktTodayWeekday()) {
        const today = parseInt(todayDow, 10);
        const day = parseInt(dayRaw, 10);
        if (Number.isNaN(day) || Number.isNaN(today)) {
            return 99;
        }
        return (day - today + 7) % 7;
    }

    _compareSchedulesByToday(a, b, todayDow = this._pktTodayWeekday()) {
        const aOff = this._weekdayOffsetFromToday(a.day_of_week ?? a.day_raw, todayDow);
        const bOff = this._weekdayOffsetFromToday(b.day_of_week ?? b.day_raw, todayDow);
        if (aOff !== bOff) {
            return aOff - bOff;
        }
        if (Boolean(a.active) !== Boolean(b.active)) {
            return a.active ? -1 : 1;
        }
        return (b.id || 0) - (a.id || 0);
    }

    /**
     * Page schedules with today (PKT weekday) first so pagination and the table agree.
     */
    async _fetchSchedulesSortedPage(domain, fields, pag) {
        const context = { active_test: false };
        const slim = await this.orm.searchRead(
            'shahtaj.weekly.schedule',
            domain,
            ['id', 'day_of_week', 'active'],
            { context, order: 'id desc', limit: 2000 },
        );
        const todayDow = this._pktTodayWeekday();
        slim.sort((a, b) => this._compareSchedulesByToday(a, b, todayDow));
        const total = slim.length;
        const offset = (pag.page - 1) * pag.limit;
        const pageIds = slim.slice(offset, offset + pag.limit).map((r) => r.id);
        if (!pageIds.length) {
            return { total, records: [] };
        }
        const records = await this.orm.read(
            'shahtaj.weekly.schedule',
            pageIds,
            fields,
            { context },
        );
        const byId = Object.fromEntries(records.map((r) => [r.id, r]));
        return { total, records: pageIds.map((id) => byId[id]).filter(Boolean) };
    }

   async loadDropdownData() {
        try {
            const bookers = await this.orm.searchRead(
                'res.users',
                [['shahtaj_is_order_booker', '=', true]],
                ['id', 'name'],
            );
            let deliveryMen = [];
            try {
                deliveryMen = await this.orm.searchRead(
                    'res.users',
                    [['shahtaj_is_delivery_man', '=', true]],
                    ['id', 'name'],
                );
            } catch (error) {
                // GPS/DM filter is optional; Live Orders must still load.
            }
            const byId = new Map();
            for (const user of [...bookers, ...deliveryMen]) {
                byId.set(user.id, user);
            }
            this.state.lookupBookers = [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        } catch (error) {
            this.state.lookupBookers = [];
        }

        try {
            const types = await this.orm.call('shahtaj.visit.target', 'read_group', [[], ['target_type'], ['target_type']]);
            this.state.lookupTargetTypes = types.map(t => ({
                value: t.target_type, 
                label: t.target_type ? t.target_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Unknown'
            })).filter(t => t.value);
        } catch (error) {
            this.state.lookupTargetTypes = [];
        }
    }

    async loadSaleOrderCatalog() {
        try {
            const [shops, products, taxes] = await Promise.all([
                this.orm.searchRead(
                    'res.partner',
                    [['is_shahtaj_shop', '=', true], ['shop_approval_state', '=', 'approved'], ['active', '=', true]],
                    ['id', 'name', 'phone', 'email']
                ),
                this.orm.searchRead(
                    'product.product',
                    [['sale_ok', '=', true], ['active', '=', true], ['product_tmpl_id.active', '=', true], ['default_code', '!=', 'SHAHTAJ-LEGACY']],
                    ['id', 'name', 'display_name', 'list_price', 'taxes_id', 'uom_id']
                ),
                hasFinancialAccess()
                    ? this.orm.searchRead('account.tax', [['type_tax_use', '=', 'sale'], ['active', '=', true]], ['id', 'name', 'amount'])
                    : Promise.resolve(this.state.saleTaxes || []),
            ]);
            this.state.lookupShops = shops || [];
            this.state.saleProducts = (products || []).map((p) => ({
                id: p.id,
                name: p.display_name || p.name,
                list_price: p.list_price || 0,
                tax_id: (p.taxes_id && p.taxes_id[0]) || '',
                uom_id: p.uom_id ? p.uom_id[0] : false,
            }));
            if (taxes && taxes.length) {
                this.state.saleTaxes = taxes;
            }
        } catch (error) {
            this.notification.add("Failed to load shops/products for sales orders: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    _formatRs(value) {
        return `Rs. ${(parseFloat(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    _formatSnapshotDate(value) {
        if (!value) return '';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return value;
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    _verificationLabel(state) {
        return ({
            none: 'Standard',
            to_approve: 'Verification Required',
            approved: 'Verified',
            rejected: 'Rejected',
        })[state] || 'Standard';
    }

    _m2oId(value) {
        if (!value) return false;
        return Array.isArray(value) ? value[0] : value;
    }

    _applyShopSnapshot(snap, target = null) {
        const record = target || this.state.selectedOrder;
        if (!record || !snap) return;
        record.shopCategory = snap.shahtaj_shop_category || '';
        record.creditLimit = snap.shahtaj_shop_credit_limit || 0;
        record.outstanding = snap.shahtaj_shop_outstanding || 0;
        record.pendingExposure = snap.shahtaj_shop_pending_exposure || 0;
        record.uninvoicedExposure = snap.shahtaj_shop_uninvoiced_exposure || 0;
        record.effectiveOutstanding = snap.shahtaj_shop_effective_outstanding || 0;
        record.creditRemaining = snap.shahtaj_shop_credit_remaining || 0;
        record.creditWouldExceed = !!snap.shahtaj_shop_credit_would_exceed;
        record.creditShortfall = snap.shahtaj_shop_credit_shortfall || 0;
        record.lifetimeSales = snap.shahtaj_shop_lifetime_sales || 0;
        record.confirmedOrderCount = snap.shahtaj_shop_confirmed_order_count || 0;
        record.pastDiscountTotal = snap.shahtaj_shop_past_discount_total || 0;
        record.pastDiscountCount = snap.shahtaj_shop_past_discount_count || 0;
        record.lastDiscountDate = this._formatSnapshotDate(snap.shahtaj_shop_last_discount_date);
        record.lastDiscountAmount = snap.shahtaj_shop_last_discount_amount || 0;
        record.paymentTerms = snap.payment_term_id ? snap.payment_term_id[1] : 'Immediate';
        record.approvalState = snap.shahtaj_approval_state || record.approvalState || 'none';
        record.verificationLabel = this._verificationLabel(record.approvalState);
    }

    async _enrichCheckinRows(records) {
        const visitIds = [...new Set(records.map((a) => this._m2oId(a.visit_id)).filter(Boolean))];
        const taskIds = [...new Set(records.map((a) => this._m2oId(a.visit_task_id)).filter(Boolean))];
        const visitsById = {};
        const tasksById = {};
        try {
            if (visitIds.length) {
                const visits = await this.orm.read(
                    'shahtaj.visit',
                    visitIds,
                    ['notes', 'sale_order_id', 'outcome', 'state'],
                );
                visits.forEach((v) => { visitsById[v.id] = v; });
            }
            if (taskIds.length) {
                const tasks = await this.orm.read('shahtaj.visit.task', taskIds, ['notes']);
                tasks.forEach((t) => { tasksById[t.id] = t; });
            }
        } catch (_error) {
            // List still renders GPS rows if visit/task notes cannot be read.
        }
        return { visitsById, tasksById };
    }

    async _loadCheckinShopSnapshot(checkin) {
        if (!checkin) return;
        const orderId = this._m2oId(checkin.sale_order_id);
        if (orderId) {
            try {
                const snaps = await this.orm.read(
                    'sale.order',
                    [orderId],
                    [
                        'shahtaj_shop_category', 'shahtaj_shop_credit_limit', 'shahtaj_shop_outstanding',
                        'shahtaj_shop_pending_exposure', 'shahtaj_shop_uninvoiced_exposure',
                        'shahtaj_shop_effective_outstanding', 'shahtaj_shop_credit_remaining',
                        'shahtaj_shop_credit_would_exceed', 'shahtaj_shop_credit_shortfall',
                        'shahtaj_shop_lifetime_sales', 'shahtaj_shop_confirmed_order_count',
                        'shahtaj_shop_past_discount_total', 'shahtaj_shop_past_discount_count',
                        'shahtaj_shop_last_discount_date', 'shahtaj_shop_last_discount_amount',
                        'payment_term_id', 'shahtaj_approval_state',
                    ],
                );
                if (snaps.length) {
                    this._applyShopSnapshot(snaps[0], this.state.selectedCheckin);
                    return;
                }
            } catch (error) {
                this.notification.add("Could not load shop snapshot: " + (error.data?.message || error.message), { type: "warning" });
            }
        }
        if (!checkin.shopId) return;
        try {
            const partners = await this.orm.read(
                'res.partner',
                [checkin.shopId],
                ['shahtaj_shop_category', 'credit_limit', 'outstanding_balance', 'property_payment_term_id', 'shop_approval_state'],
            );
            if (!partners.length) return;
            const p = partners[0];
            this._applyShopSnapshot({
                shahtaj_shop_category: p.shahtaj_shop_category,
                shahtaj_shop_credit_limit: p.credit_limit,
                shahtaj_shop_outstanding: p.outstanding_balance,
                shahtaj_shop_pending_exposure: 0,
                shahtaj_shop_uninvoiced_exposure: 0,
                shahtaj_shop_effective_outstanding: p.outstanding_balance,
                shahtaj_shop_credit_remaining: Math.max((p.credit_limit || 0) - (p.outstanding_balance || 0), 0),
                shahtaj_shop_credit_would_exceed: false,
                shahtaj_shop_credit_shortfall: 0,
                shahtaj_shop_lifetime_sales: 0,
                shahtaj_shop_confirmed_order_count: 0,
                shahtaj_shop_past_discount_total: 0,
                shahtaj_shop_past_discount_count: 0,
                shahtaj_shop_last_discount_date: false,
                shahtaj_shop_last_discount_amount: 0,
                payment_term_id: p.property_payment_term_id,
                shahtaj_approval_state: p.shop_approval_state === 'approved' ? 'approved' : 'none',
            }, this.state.selectedCheckin);
        } catch (error) {
            this.notification.add("Could not load shop snapshot: " + (error.data?.message || error.message), { type: "warning" });
        }
    }

    _mapSaleOrderRow(o, lines) {
        const myLines = (lines || []).filter(l => l.order_id && l.order_id[0] === o.id);
        const totalOrd = myLines.reduce((sum, l) => sum + l.product_uom_qty, 0);
        const totalDel = myLines.reduce((sum, l) => sum + l.qty_delivered, 0);
        let status = 'Draft';
        if (o.shahtaj_approval_state === 'to_approve') status = 'Needs Verification';
        else if (o.shahtaj_approval_state === 'rejected') status = 'Rejected';
        else if (o.state === 'sale') status = o.invoice_status === 'invoiced' ? 'Invoiced' : 'To Invoice';
        else if (o.state === 'done') status = 'Delivered';
        else if (o.state === 'cancel') status = 'Cancelled';
        return {
            odoo_id: o.id, id: o.name, shop: o.partner_id ? o.partner_id[1] : 'Unknown', partner_id: o.partner_id,
            shopId: o.partner_id ? o.partner_id[0] : false,
            booker: o.user_id ? o.user_id[1] : 'Unknown', bookerId: o.user_id ? o.user_id[0] : false,
            date: o.date_order ? String(o.date_order).split(" ")[0] : 'Unknown', items: (o.order_line || []).length,
            total: this._formatRs(o.amount_total),
            tax: this._formatRs(o.amount_tax),
            rawAmount: o.amount_total || 0,
            catalogTotal: this._formatRs(o.shahtaj_catalog_amount_total),
            rawCatalogTotal: o.shahtaj_catalog_amount_total || 0,
            discountAmount: this._formatRs(o.shahtaj_total_discount_amount),
            rawDiscountAmount: o.shahtaj_total_discount_amount || 0,
            discountReasons: o.shahtaj_discount_reasons || '',
            approvalState: o.shahtaj_approval_state || 'none',
            verificationLabel: this._verificationLabel(o.shahtaj_approval_state || 'none'),
            needsDiscount: !!o.shahtaj_approval_reason_discount,
            needsCredit: !!o.shahtaj_approval_reason_credit,
            approvalReasons: o.shahtaj_approval_reasons_display || '',
            shopCategory: o.shahtaj_shop_category || '',
            creditLimit: o.shahtaj_shop_credit_limit || 0,
            outstanding: o.shahtaj_shop_outstanding || 0,
            creditRemaining: o.shahtaj_shop_credit_remaining || 0,
            creditShortfall: o.shahtaj_shop_credit_shortfall || 0,
            effectiveOutstanding: o.shahtaj_shop_effective_outstanding || 0,
            pastDiscountCount: o.shahtaj_shop_past_discount_count || 0,
            status: status, invoice_status: o.invoice_status,
            is_fully_delivered: totalOrd > 0 && totalDel >= totalOrd, line_ids: o.order_line, lines: []
        };
    }

    // --- THE MASTER DATA ENGINE ---
    async fetchActiveList() {
        let tab = this.state.activeSubTab;
        if (tab === 'performance') tab = this.state.perfSubTab;
        if (tab === 'orders' && this.state.ordersSubTab === 'verification') tab = 'verification';
        
        this.state.isLoadingList = true;
        try {
            const pag = this.state.pagination[tab];
            const filters = this.state.filters[tab];
            let domain = []; let model = ''; let fields = []; let targetState = '';

            // 1. DOMAIN MAPPINGS
            if (tab === 'deliveries' || tab === 'orders' || tab === 'verification') {
                model = 'sale.order';
                targetState = tab === 'deliveries' ? 'tableDeliveries' : (tab === 'verification' ? 'tableVerification' : 'tableOrders');
                fields = ["name", "partner_id", "user_id", "date_order", "amount_total", "amount_tax", "amount_untaxed", "state", "order_line", "invoice_status"];
                if (tab !== 'deliveries') {
                    // Stored fields only. Credit/history snapshot fields are computed
                    // and stall this list on a production database — load them in viewOrder.
                    fields.push(
                        "shahtaj_approval_state", "shahtaj_approval_reason_discount", "shahtaj_approval_reason_credit",
                        "shahtaj_approval_reasons_display", "shahtaj_catalog_amount_total", "shahtaj_total_discount_amount",
                        "shahtaj_discount_reasons",
                    );
                }
                domain.push('|', ['shahtaj_visit_id', '!=', false], ['partner_id.is_shahtaj_shop', '=', true]);
                
                if (tab === 'deliveries') domain.push(['state', 'in', ['sale', 'done']]);
                if (tab === 'verification') {
                    domain.push(['shahtaj_approval_state', '=', 'to_approve']);
                    domain.push(['state', 'in', ['draft', 'sent']]);
                }
                if (tab === 'orders') {
                    domain.push(['shahtaj_approval_state', '!=', 'to_approve']);
                }
                if (filters.search) domain.push('|', '|', ['name', 'ilike', filters.search], ['partner_id.name', 'ilike', filters.search], ['user_id.name', 'ilike', filters.search]);
                if ((tab === 'orders' || tab === 'verification') && filters.booker && filters.booker !== 'all') domain.push(['user_id', '=', parseInt(filters.booker)]);
                if (tab === 'verification' && filters.reason && filters.reason !== 'all') {
                    if (filters.reason === 'discount') domain.push(['shahtaj_approval_reason_discount', '=', true]);
                    if (filters.reason === 'credit') domain.push(['shahtaj_approval_reason_credit', '=', true]);
                    if (filters.reason === 'both') {
                        domain.push(['shahtaj_approval_reason_discount', '=', true]);
                        domain.push(['shahtaj_approval_reason_credit', '=', true]);
                    }
                }
                if (tab === 'orders' && filters.status) {
                    if (filters.status === 'Draft') domain.push(['state', '=', 'draft']);
                    else if (filters.status === 'Delivered') domain.push(['state', '=', 'done']);
                    else if (filters.status === 'To Invoice') domain.push(['state', '=', 'sale'], ['invoice_status', '!=', 'invoiced']);
                    else if (filters.status === 'Invoiced') domain.push(['invoice_status', '=', 'invoiced']);
                }
            } 
            else if (tab === 'checkins') {
                model = 'shahtaj.gps.attempt'; targetState = 'tableCheckins';
                fields = [
                    'id', 'create_date', 'user_id', 'role', 'purpose', 'result', 'message',
                    'shop_id', 'shop_latitude', 'shop_longitude',
                    'attempt_latitude', 'attempt_longitude',
                    'distance_m', 'min_distance_m', 'max_distance_m',
                    'visit_task_id', 'visit_id', 'dm_delivery_id', 'sale_order_id',
                ];
                if (filters.search) {
                    domain.push('|', '|',
                        ['shop_id.name', 'ilike', filters.search],
                        ['user_id.name', 'ilike', filters.search],
                        ['message', 'ilike', filters.search],
                    );
                }
                if (filters.booker && filters.booker !== 'all') domain.push(['user_id', '=', parseInt(filters.booker)]);
                if (filters.date) {
                    const bounds = this._pktDateToUtcBounds(filters.date);
                    domain.push(['create_date', '>=', bounds.start]);
                    domain.push(['create_date', '<=', bounds.end]);
                }
                if (filters.purpose && filters.purpose !== 'all') domain.push(['purpose', '=', filters.purpose]);
                if (filters.status === 'ok') domain.push(['result', '=', 'ok']);
                else if (filters.status === 'blocked') domain.push(['result', '!=', 'ok']);
                else if (filters.status === 'blocked_too_far') domain.push(['result', '=', 'blocked_too_far']);
                else if (filters.status === 'blocked_too_close') domain.push(['result', '=', 'blocked_too_close']);
                else if (filters.status === 'blocked_missing') {
                    domain.push(['result', 'in', ['blocked_missing_shop_gps', 'blocked_missing_user_gps', 'blocked_invalid_coords']]);
                }
            }
            else if (tab === 'schedules') {
                model = 'shahtaj.weekly.schedule'; targetState = 'tableSchedules';
                fields = ['id', 'name', 'day_of_week', 'route_id', 'zone_id', 'active', 'shop_count', 'week_tasks_planned', 'week_tasks_completed', 'week_tasks_skipped', 'week_tasks_progress', 'week_occurrence_date', 'order_booker_id'];
                if (filters.booker !== 'all') domain.push(['order_booker_id', '=', parseInt(filters.booker)]);
                if (filters.day !== 'all') domain.push(['day_of_week', '=', filters.day]);
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
            if (tab === 'checkins') {
                queryKwargs.order = 'create_date desc, id desc';
            }
            let total;
            let records;
            if (tab === 'schedules') {
                ({ total, records } = await this._fetchSchedulesSortedPage(domain, fields, pag));
            } else {
                [total, records] = await Promise.all([
                    this.orm.searchCount(
                        model,
                        domain,
                        tab === 'targets' ? { context: { active_test: false } } : {},
                    ),
                    this.orm.searchRead(model, domain, fields, queryKwargs),
                ]);
            }

            this.state.pagination[tab].total = total;

            // 3. MAP RESULTS
            if (tab === 'deliveries' || tab === 'orders' || tab === 'verification') {
                const orderIds = records.map(o => o.id);
                const lines = orderIds.length ? await this.orm.searchRead("sale.order.line", [["order_id", "in", orderIds]], ["order_id", "product_uom_qty", "qty_delivered"]) : [];
                this.state[targetState] = records.map(o => this._mapSaleOrderRow(o, lines));
            }
            else if (tab === 'checkins') {
                const { visitsById, tasksById } = await this._enrichCheckinRows(records);
                this.state.tableCheckins = records.map(a => {
                    const isOk = a.result === 'ok';
                    const status = this._gpsResultLabel(a.result);
                    const purposeLabel = this._gpsPurposeLabel(a.purpose);
                    const distLabel = a.distance_m
                        ? `${Math.round(a.distance_m)} m`
                        : (isOk ? '—' : 'n/a');
                    const visit = visitsById[this._m2oId(a.visit_id)] || null;
                    const task = tasksById[this._m2oId(a.visit_task_id)] || null;
                    const saleOrder = a.sale_order_id || (visit && visit.sale_order_id) || false;
                    const hasOrder = Boolean(this._m2oId(saleOrder));
                    const notes = ((visit && visit.notes) || (task && task.notes) || '').trim();
                    return {
                        id: a.id,
                        shop: a.shop_id ? a.shop_id[1] : 'Unknown shop',
                        shopId: a.shop_id ? a.shop_id[0] : false,
                        booker: a.user_id ? a.user_id[1] : 'Unknown',
                        bookerId: a.user_id ? a.user_id[0] : false,
                        userLabel: a.user_id ? a.user_id[1] : 'Unknown',
                        role: a.role,
                        roleLabel: this._gpsRoleLabel(a.role),
                        purpose: a.purpose,
                        purposeLabel,
                        result: a.result,
                        isOk,
                        status,
                        time: this.formatUtcToPkt(a.create_date) || '—',
                        distance_m: a.distance_m || 0,
                        min_distance_m: a.min_distance_m || 0,
                        max_distance_m: a.max_distance_m || 0,
                        distLabel,
                        message: a.message || '',
                        shop_latitude: a.shop_latitude || 0,
                        shop_longitude: a.shop_longitude || 0,
                        attempt_latitude: a.attempt_latitude || 0,
                        attempt_longitude: a.attempt_longitude || 0,
                        taskRef: a.visit_task_id ? a.visit_task_id[1] : (a.dm_delivery_id ? a.dm_delivery_id[1] : (saleOrder ? saleOrder[1] : '—')),
                        visit_id: a.visit_id || false,
                        visit_task_id: a.visit_task_id || false,
                        dm_delivery_id: a.dm_delivery_id || false,
                        sale_order_id: saleOrder,
                        hasOrder,
                        orderLabel: hasOrder ? 'Order Placed' : 'No Order',
                        notes,
                        endTime: '',
                        duration: distLabel,
                        outcome: purposeLabel,
                    };
                });
            }
            else if (tab === 'schedules') {
                const dayMap = { '0': 'Monday', '1': 'Tuesday', '2': 'Wednesday', '3': 'Thursday', '4': 'Friday', '5': 'Saturday', '6': 'Sunday' };
                this.state.tableSchedules = records.map(r => ({
                    id: r.id, name: r.name, bookerId: r.order_booker_id ? r.order_booker_id[0] : null, bookerName: r.order_booker_id ? r.order_booker_id[1] : 'Unknown',
                    day_raw: r.day_of_week, day: dayMap[r.day_of_week] || r.day_of_week, route: r.route_id ? r.route_id[1] : 'Unassigned', zone: r.zone_id ? r.zone_id[1] : 'Unassigned',
                    shops: r.shop_count, active: r.active, planned: r.week_tasks_planned, done: r.week_tasks_completed, skipped: r.week_tasks_skipped || 0,
                    progress: r.week_tasks_progress || 0, occurrenceDate: r.week_occurrence_date || ''
                })).sort((a, b) => this._compareSchedulesByToday(a, b, this._pktTodayWeekday()));
            }
            else if (tab === 'targets') {
                this.state.tableTargets = records.map(r => ({
                    id: r.id, name: r.name, bookerId: r.order_booker_id ? r.order_booker_id[0] : null, bookerName: r.order_booker_id ? r.order_booker_id[1] : 'Unknown',
                    startDate: r.date_start, endDate: r.date_end, type: r.target_type, displayType: r.target_type ? r.target_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Unknown',
                    targetValue: r.target_value, achievedValue: r.achieved_value, remainingValue: r.remaining_value, progress: r.progress_percent || 0,
                    product: r.product_id ? r.product_id[1] : null, currency: r.currency_id ? r.currency_id[1] : null, weightUom: r.target_weight_uom || '', active: r.active
                }));
            }
            if (this.state.activeSubTab === 'orders') {
                if (tab === 'verification') {
                    this.state.verificationCount = total;
                } else {
                    try {
                        this.state.verificationCount = await this.orm.searchCount('sale.order', [
                            '|', ['shahtaj_visit_id', '!=', false], ['partner_id.is_shahtaj_shop', '=', true],
                            ['shahtaj_approval_state', '=', 'to_approve'],
                            ['state', 'in', ['draft', 'sent']],
                        ]);
                    } catch (error) {
                        this.state.verificationCount = 0;
                    }
                }
            }
        } catch (error) {
            this.notification.add("Failed to fetch data: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }
    async refreshData() {
        this.state.isRefreshing = true;
        try {
            await this.loadDropdownData();
            await this.loadSaleOrderCatalog();
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
        try {
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
        } catch (error) {
            this.notification.add("Failed to load product catalog: " + (error.data?.message || error.message), { type: "warning" });
        }
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
            this._preserveDetailsOnSwitch = false;
        } else {
            this.state.selectedOrder = null;
            this.state.selectedCheckin = null;
            this.state.selectedSchedule = null;
            this.state.selectedTarget = null;
            this.state.showSaleOrderForm = false;
            this.state.showRejectModal = false;
            this.state.showCreditOverride = false;
            this.state.isProcessingOverride = false;
            // Reset filters and pagination for the tab being entered so the UI
            // and the backend query are always in sync after a tab switch.
            this._resetTabFilters(tabName);
        }

        this.fetchActiveList();
    }
    setPerfSubTab(tabName) {
        this.state.perfSubTab = tabName;
        this.state.selectedSchedule = null;
        this.state.selectedTarget = null;
        // Reset filters for the performance sub-tab being entered.
        this._resetTabFilters(tabName);
        this.fetchActiveList();
    }
    _resetTabFilters(tabName) {
        const defaultFilters = {
            deliveries: { search: '', status: '' },
            checkins:   { search: '', status: '', purpose: 'all', booker: 'all', date: '' },
            orders:     { search: '', status: '', booker: 'all' },
            verification: { search: '', booker: 'all', reason: 'all' },
            schedules:  { booker: 'all', day: 'all' },
            targets:    { booker: 'all', type: 'all' },
        };
        if (defaultFilters[tabName]) {
            this.state.filters[tabName] = { ...defaultFilters[tabName] };
            this.state.pagination[tabName].page = 1;
        }
        // When entering the performance tab, reset both its sub-tabs
        // so filters don't bleed across navigation.
        if (tabName === 'performance') {
            this.state.filters.schedules = { ...defaultFilters.schedules };
            this.state.filters.targets   = { ...defaultFilters.targets };
            this.state.pagination.schedules.page = 1;
            this.state.pagination.targets.page   = 1;
            this.state.perfSubTab = 'schedules';
        }
        if (tabName === 'orders') {
            this.state.ordersSubTab = 'live';
            this.state.filters.verification = { search: '', booker: 'all', reason: 'all' };
            this.state.pagination.verification.page = 1;
        }
    }

    setOrdersSubTab(tabName) {
        this.state.ordersSubTab = tabName;
        this.state.selectedOrder = null;
        this.state.shopSnapshotOpen = false;
        this.state.showSaleOrderForm = false;
        this.state.showRejectModal = false;
        this.state.showCreditOverride = false;
        this.state.isProcessingOverride = false;
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
        this.state.shopSnapshotOpen = false;
        
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
                ["name", "product_uom_qty", "product_uom_id", "price_unit", "price_subtotal", "tax_ids", "shahtaj_catalog_price", "shahtaj_has_discount", "shahtaj_unit_discount", "shahtaj_total_discount", "shahtaj_discount_reason"] 
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
                    catalogPrice: (l.shahtaj_catalog_price || l.price_unit).toLocaleString(undefined, {minimumFractionDigits: 2}),
                    hasDiscount: !!l.shahtaj_has_discount,
                    unitDiscount: (l.shahtaj_unit_discount || 0).toLocaleString(undefined, {minimumFractionDigits: 2}),
                    totalDiscount: (l.shahtaj_total_discount || 0).toLocaleString(undefined, {minimumFractionDigits: 2}),
                    discountReason: l.shahtaj_discount_reason || '',
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

        if (this.state.selectedOrder.odoo_id) {
            try {
                const snaps = await this.orm.read(
                    "sale.order",
                    [this.state.selectedOrder.odoo_id],
                    [
                        "shahtaj_shop_category", "shahtaj_shop_credit_limit", "shahtaj_shop_outstanding",
                        "shahtaj_shop_pending_exposure", "shahtaj_shop_uninvoiced_exposure",
                        "shahtaj_shop_effective_outstanding", "shahtaj_shop_credit_remaining",
                        "shahtaj_shop_credit_would_exceed", "shahtaj_shop_credit_shortfall",
                        "shahtaj_shop_lifetime_sales", "shahtaj_shop_confirmed_order_count",
                        "shahtaj_shop_past_discount_total", "shahtaj_shop_past_discount_count",
                        "shahtaj_shop_last_discount_date", "shahtaj_shop_last_discount_amount",
                        "payment_term_id", "shahtaj_approval_state",
                    ]
                );
                if (snaps && snaps.length) {
                    this._applyShopSnapshot(snaps[0]);
                }
            } catch (error) {
                this.notification.add("Could not load shop snapshot: " + (error.data?.message || error.message), { type: "warning" });
            }
        }
    }

    toggleShopSnapshot() {
        this.state.shopSnapshotOpen = !this.state.shopSnapshotOpen;
    }
    
    closeOrder() {
        this.state.selectedOrder = null;
        this.state.shopSnapshotOpen = false;
    }

    async openSaleOrderForm() {
        this.state.selectedOrder = null;
        this.state.saleOrderForm = this._emptySaleOrderForm();
        this.state.showSaleOrderForm = true;
        if (!this.state.lookupShops.length || !this.state.saleProducts.length) {
            await this.loadSaleOrderCatalog();
        }
    }

    closeSaleOrderForm() {
        this.state.showSaleOrderForm = false;
        this.state.saleOrderForm = this._emptySaleOrderForm();
    }

    addSaleOrderLine() {
        this.state.saleOrderForm.lines.push(this._emptySaleOrderLine());
    }

    removeSaleOrderLine(lineId) {
        if (this.state.saleOrderForm.lines.length <= 1) {
            this.notification.add("A sales order must have at least one product line.", { type: "warning" });
            return;
        }
        this.state.saleOrderForm.lines = this.state.saleOrderForm.lines.filter((line) => line.id !== lineId);
    }

    onSaleOrderProductChange(line) {
        const product = this.state.saleProducts.find((p) => String(p.id) === String(line.product_id));
        if (!product) {
            line.price = 0;
            line.tax_id = '';
            return;
        }
        line.price = product.list_price || 0;
        line.tax_id = product.tax_id ? String(product.tax_id) : '';
    }

    async saveSaleOrder() {
        const form = this.state.saleOrderForm;
        if (!form.partner_id) {
            this.notification.add("Please select a shop.", { type: "warning" });
            return;
        }
        if (!form.lines.length) {
            this.notification.add("Please add at least one product line.", { type: "warning" });
            return;
        }
        this.state.isSavingSaleOrder = true;
        try {
            const orderLines = [];
            for (const line of form.lines) {
                if (!line.product_id) {
                    this.notification.add("Please select a product for every order line.", { type: "warning" });
                    this.state.isSavingSaleOrder = false;
                    return;
                }
                const product = this.state.saleProducts.find((p) => String(p.id) === String(line.product_id));
                const lineVals = {
                    product_id: parseInt(line.product_id, 10),
                    product_uom_qty: parseFloat(line.qty) || 1,
                    name: product?.name || 'Product',
                };
                if (hasFinancialAccess()) {
                    lineVals.price_unit = parseFloat(line.price) || 0;
                    lineVals.tax_ids = line.tax_id ? [[6, 0, [parseInt(line.tax_id, 10)]]] : [[5, 0, 0]];
                }
                orderLines.push([0, 0, lineVals]);
            }
            await this.orm.create("sale.order", [{
                partner_id: parseInt(form.partner_id, 10),
                date_order: form.date_order,
                origin: "Distributor Portal",
                order_line: orderLines,
            }]);
            this.closeSaleOrderForm();
            await this.fetchActiveList();
            this.notification.add("Sales order created successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to create sales order: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isSavingSaleOrder = false;
        }
    }

    async confirmSelectedOrder() {
        if (!this.state.selectedOrder || this.state.isConfirmingOrder) return;
        this.state.isConfirmingOrder = true;
        try {
            const result = await this.orm.call("sale.order", "action_confirm", [[this.state.selectedOrder.odoo_id]]);
            if (result && result.type === "ir.actions.act_window") {
                this._openCreditOverride(this.state.selectedOrder, 'confirm');
                return;
            }
            this.state.selectedOrder.status = "To Invoice";
            this.notification.add("Sales order confirmed.", { type: "success" });
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || "Failed to confirm sales order.", { type: "danger" });
        } finally {
            this.state.isConfirmingOrder = false;
        }
    }

    openRejectModal() {
        if (!this.state.selectedOrder) return;
        this.state.rejectReason = '';
        this.state.showRejectModal = true;
    }

    closeRejectModal() {
        this.state.showRejectModal = false;
        this.state.rejectReason = '';
    }

    closeCreditOverride() {
        this.state.showCreditOverride = false;
        this.state.isApprovingOrder = false;
        this.state.isProcessingOverride = false;
    }

    _openCreditOverride(order, actionType = 'approve') {
        this.state.isApprovingOrder = false;
        this.state.isProcessingOverride = false;
        this.state.creditOverride = {
            orderId: order.odoo_id,
            shop: order.shop,
            orderAmount: order.rawAmount || 0,
            creditLimit: order.creditLimit || 0,
            outstanding: order.outstanding || 0,
            effective: order.effectiveOutstanding || 0,
            shortfall: order.creditShortfall || 0,
            newLimit: '',
            note: '',
            actionType,
        };
        this.state.showCreditOverride = true;
    }

    async approveSelectedOrder() {
        if (!this.state.selectedOrder || this.state.isApprovingOrder) return;
        this.state.isApprovingOrder = true;
        try {
            const result = await this.orm.call("sale.order", "action_shahtaj_approve_order", [[this.state.selectedOrder.odoo_id]]);
            if (result && result.type === "ir.actions.act_window") {
                this._openCreditOverride(this.state.selectedOrder);
                return;
            }
            this.notification.add("Order approved and confirmed.", { type: "success" });
            this.state.selectedOrder = null;
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || "Failed to approve order.", { type: "danger" });
        } finally {
            this.state.isApprovingOrder = false;
        }
    }

    async proceedCreditOverride() {
        const form = this.state.creditOverride;
        if (!form.orderId || this.state.isProcessingOverride) return;
        this.state.isProcessingOverride = true;
        try {
            const vals = {
                sale_order_id: form.orderId,
                action_type: form.actionType || 'approve',
                override_note: (form.note || '').trim() || false,
            };
            if (form.newLimit && parseFloat(form.newLimit) > 0) {
                vals.new_credit_limit = parseFloat(form.newLimit);
            }
            const ids = await this.orm.create("shahtaj.credit.override.wizard", [vals], {
                context: { default_sale_order_id: form.orderId, default_action_type: form.actionType || 'approve' },
            });
            const wizardId = Array.isArray(ids) ? ids[0] : ids;
            await this.orm.call("shahtaj.credit.override.wizard", "action_proceed", [[wizardId]]);
            this.state.showCreditOverride = false;
            this.notification.add("Order approved with credit override.", { type: "success" });
            this.state.selectedOrder = null;
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || "Failed to complete credit override.", { type: "danger" });
        } finally {
            this.state.isProcessingOverride = false;
        }
    }

    async rejectSelectedOrder() {
        if (!this.state.selectedOrder || this.state.isRejectingOrder) return;
        const reason = (this.state.rejectReason || '').trim();
        if (!reason) {
            this.notification.add("Please enter a rejection reason.", { type: "warning" });
            return;
        }
        this.state.isRejectingOrder = true;
        try {
            await this.orm.call("sale.order", "action_shahtaj_reject_order", [[this.state.selectedOrder.odoo_id]], { reason });
            this.closeRejectModal();
            this.notification.add("Order rejected.", { type: "info" });
            this.state.selectedOrder = null;
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || "Failed to reject order.", { type: "danger" });
        } finally {
            this.state.isRejectingOrder = false;
        }
    }

    async viewCheckin(log) {
        this.state.shopSnapshotOpen = false;
        this.state.selectedCheckin = {
            ...log,
            notes: log.notes || '',
            sale_order_id: log.sale_order_id || false,
            hasOrder: !!log.hasOrder,
            orderLabel: log.orderLabel || (log.hasOrder ? 'Order Placed' : 'No Order'),
            endTime: log.endTime || '',
            visitOutcome: log.orderLabel || '',
        };
        let visitId = this._m2oId(log.visit_id);
        const taskId = this._m2oId(log.visit_task_id);
        try {
            if (!visitId && taskId) {
                const found = await this.orm.searchRead(
                    'shahtaj.visit',
                    [['visit_task_id', '=', taskId]],
                    ['started_at', 'ended_at', 'outcome', 'state', 'sale_order_id', 'notes'],
                    { limit: 1, order: 'id desc' },
                );
                if (found.length) visitId = found[0].id;
            }
            if (visitId) {
                const visits = await this.orm.read(
                    'shahtaj.visit',
                    [visitId],
                    ['started_at', 'ended_at', 'outcome', 'state', 'sale_order_id', 'notes'],
                );
                if (visits.length && this.state.selectedCheckin && this.state.selectedCheckin.id === log.id) {
                    const v = visits[0];
                    let visitOutcome = v.outcome || '';
                    if (v.state === 'in_progress') visitOutcome = 'In Progress';
                    else if (v.state === 'completed' && v.outcome === 'incomplete') visitOutcome = 'Incomplete / Auto-Skipped';
                    else if (v.state === 'completed') visitOutcome = v.outcome === 'order' ? 'Order Placed' : 'No Order';
                    else if (v.state === 'cancelled') visitOutcome = 'Cancelled';

                    let durationStr = '';
                    if (v.started_at && v.ended_at) {
                        durationStr = `${Math.round((new Date(v.ended_at.replace(' ', 'T') + 'Z') - new Date(v.started_at.replace(' ', 'T') + 'Z')) / 60000)} mins`;
                    }

                    const visitNotes = (v.notes || '').trim();
                    if (visitNotes) this.state.selectedCheckin.notes = visitNotes;
                    this.state.selectedCheckin.sale_order_id = v.sale_order_id || this.state.selectedCheckin.sale_order_id || false;
                    this.state.selectedCheckin.hasOrder = Boolean(this._m2oId(this.state.selectedCheckin.sale_order_id));
                    this.state.selectedCheckin.orderLabel = this.state.selectedCheckin.hasOrder ? 'Order Placed' : 'No Order';
                    this.state.selectedCheckin.endTime = this.formatUtcToPkt(v.ended_at) || '';
                    this.state.selectedCheckin.visitOutcome = visitOutcome;
                    if (durationStr) {
                        this.state.selectedCheckin.duration = durationStr;
                    }
                }
            }
            if (!(this.state.selectedCheckin.notes || '').trim() && taskId) {
                const tasks = await this.orm.read('shahtaj.visit.task', [taskId], ['notes']);
                if (tasks.length && (tasks[0].notes || '').trim()) {
                    this.state.selectedCheckin.notes = tasks[0].notes.trim();
                }
            }
        } catch (error) {
            // GPS detail still useful without visit enrichment.
        }
        await this._loadCheckinShopSnapshot(this.state.selectedCheckin);
    }
    closeCheckin() {
        this.state.selectedCheckin = null;
        this.state.shopSnapshotOpen = false;
    }

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
                    booker: o.user_id ? o.user_id[1] : 'Unknown', date: o.date_order ? String(o.date_order).split(" ")[0] : 'Unknown', items: o.order_line.length,
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