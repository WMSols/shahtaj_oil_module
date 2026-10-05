/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps, useEffect, useRef } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess, notifyPortalBusy } from "../../shahtaj_access";
import { ConfirmModal } from "../confirm_modal";
import {
    applyOperationsCatalogsToState,
    applyOperationsLookupsToState,
    getOperationsCatalogs,
    getOperationsLookups,
    getOperationsTaxCatalog,
} from "./operations_cache";

export class OperationsBase extends Component {
     static components = { ConfirmModal };
     static props = {
        requestedSubTab: { type: String, optional: true },
        requestedDeliveriesSubTab: { type: String, optional: true },
        requestedCheckinPurpose: { type: String, optional: true },
        requestedCheckinRole: { type: String, optional: true },
        requestedCheckinDate: { type: String, optional: true },
        refreshNonce: { type: Number, optional: true },
    };
    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this.checkinMapRef = useRef("checkinMapContainer");
        this.checkinMapInstance = null;
        const ITEMS_PER_PAGE = 50;
        const today = new Date();
        this.todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        this.state = useState({
            // Main Tab Navigation
            activeSubTab: this.props.requestedSubTab || 'orders', // 'checkins', 'orders', 'performance'
            
            selectedOrder: null,    
            selectedCheckin: null,  
            
            itemsPerPage: 5,
            
            
            selectedDelivery: null,
            deliveriesSubTab: this.props.requestedDeliveriesSubTab === 'manual' ? 'dispatch' : (this.props.requestedDeliveriesSubTab || 'dispatch'),
            selectedDmJob: null,
            selectedSettlement: null,
            selectedRecovery: null,
            imagePreview: { open: false, src: '', title: '' },
            tableDispatch: [],
            tableDmJobs: [],
            tableSessions: [],
            tableCollections: [],
            tableSettlements: [],
            lookupDeliveryMen: [],
            dmJobSections: { delivery: true, order: true, shop: false, gps: false, products: true },
            settleModal: {
                open: false,
                wizardId: null,
                walletBalance: 0,
                amount: 0,
                bankJournalId: '',
                journals: [],
                notes: '',
                dmId: '',
                saving: false,
            },
            assignModal: {
                open: false,
                readOnly: false,
                wizardId: null,
                orderName: '',
                shop: '',
                jobs: [],
                saving: false,
            },
            pickModal: {
                open: false,
                wizardId: null,
                lines: [],
                saving: false,
            },

            isCreatingInvoice: false,
            isConfirmingOrder: false,
            isCancellingOrder: false,
            confirmModal: { isOpen: false, title: '', message: '', onConfirm: null },
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
            lookupBookers: [], lookupFieldUsers: [], lookupTargetTypes: [],
            
            pagination: {
                deliveries: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                dispatch: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                dm_jobs: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                sessions: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                collections: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                settlements: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                                checkins: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                orders: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                verification: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                schedules: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                targets: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            filters: {
                deliveries: { search: '', status: '' },
                dispatch: { search: '' },
                dm_jobs: { search: '', dm: 'all', dateFrom: '', dateTo: '', state: 'all', field_state: 'all', assignment_mode: 'all' },
                sessions: { dm: 'all', dateFrom: '', dateTo: '' },
                collections: { search: '', dm: 'all', dateFrom: '', dateTo: '' },
                settlements: { search: '', dm: 'all', dateFrom: '', dateTo: '' },
                                checkins: { search: '', status: '', purpose: this.props.requestedCheckinPurpose || 'all', booker: 'all', date: this.props.requestedCheckinDate || '', role: this.props.requestedCheckinRole || 'all' },
                orders: { search: '', status: '', booker: 'all' },
                verification: { search: '', booker: 'all', reason: 'all' },
                schedules: { booker: 'all', date: '' },
                targets: { booker: 'all', type: 'all' },
            },
        });
         // ADD THIS NEW BLOCK RIGHT AFTER THE STATE CLOSING BRACKET:
        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab && nextProps.requestedSubTab !== this.props.requestedSubTab) {
                this.setSubTab(nextProps.requestedSubTab);
            }
            if (nextProps.requestedDeliveriesSubTab && nextProps.requestedDeliveriesSubTab !== this.props.requestedDeliveriesSubTab) {
                this.setDeliveriesSubTab(nextProps.requestedDeliveriesSubTab);
            }
            const purpose = nextProps.requestedCheckinPurpose || 'all';
            const role = nextProps.requestedCheckinRole || 'all';
            const date = nextProps.requestedCheckinDate || '';
            const prevPurpose = this.props.requestedCheckinPurpose || 'all';
            const prevRole = this.props.requestedCheckinRole || 'all';
            const prevDate = this.props.requestedCheckinDate || '';
            if (purpose !== prevPurpose || role !== prevRole || date !== prevDate) {
                this.state.filters.checkins.purpose = purpose;
                this.state.filters.checkins.role = role;
                this.state.filters.checkins.date = date;
                if (this.state.activeSubTab === 'checkins' || nextProps.requestedSubTab === 'checkins') {
                    this.state.pagination.checkins.page = 1;
                    this.fetchActiveList();
                }
            }
            if (nextProps.refreshNonce !== undefined && nextProps.refreshNonce !== this.props.refreshNonce) {
                this.reloadFromRefresh();
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
            qty_available: null,
            uom_name: '',
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
            second: '2-digit',
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

    _gpsListTagClass(result) {
        if (result === 'ok') return 'so-gps-tag-ok';
        if (result === 'blocked_too_far' || result === 'blocked_too_close') return 'so-gps-tag-far';
        return 'so-gps-tag-warn';
    }

    _gpsRoleLabel(role) {
        return ({ order_booker: 'Order Booker', delivery_man: 'Delivery Man', other: 'Other' })[role] || role || '—';
    }

    _gpsIsDeliveryCheckin(attempt) {
        return attempt.role === 'delivery_man' || attempt.purpose === 'deliver';
    }

    _formatTimeSpent(startedAt, endedAt, state, durationMinutes) {
        const start = this._parseOdooUtc(startedAt);
        const end = this._parseOdooUtc(endedAt);
        if (start && end) {
            const mins = Math.max(0, Math.round((end - start) / 60000));
            return `${mins} mins`;
        }
        if (state === 'in_progress' && start) {
            return 'Active Now';
        }
        if (durationMinutes && durationMinutes > 0) {
            return `${Math.round(durationMinutes)} mins`;
        }
        return '—';
    }

    _checkinTiming(visit, job) {
        const startedAt = (visit && visit.started_at) || (job && job.picked_at) || false;
        const endedAt = (visit && visit.ended_at) || (job && job.delivered_at) || false;
        const state = visit
            ? visit.state
            : (endedAt ? 'completed' : (startedAt ? 'in_progress' : ''));
        const durationMinutes = visit ? visit.duration_minutes : 0;
        return {
            duration: this._formatTimeSpent(startedAt, endedAt, state, durationMinutes),
            endTime: endedAt
                ? (this.formatUtcToPkt(endedAt) || '')
                : (state === 'in_progress' ? 'In Progress' : ''),
        };
    }

    _gpsCheckinOutcome(attempt, hasLinkedOrder = false) {
        if (this._gpsIsDeliveryCheckin(attempt)) {
            const hasDelivery = Boolean(this._m2oId(attempt.dm_delivery_id)) || Boolean(hasLinkedOrder);
            return {
                isDeliveryCheckin: true,
                hasOrder: hasDelivery,
                orderLabel: hasDelivery ? 'Delivered' : 'No Delivery',
            };
        }
        return {
            isDeliveryCheckin: false,
            hasOrder: Boolean(hasLinkedOrder),
            orderLabel: hasLinkedOrder ? 'Order Placed' : 'No Order',
        };
    }

    /**
     * Odoo weekday key for a Pakistan calendar date: '0' Monday … '6' Sunday.
     */
    _pktWeekdayForDate(dateStr) {
        const date = dateStr
            ? new Date(`${dateStr}T12:00:00+05:00`)
            : new Date();
        const weekday = date.toLocaleDateString('en-US', {
            timeZone: 'Asia/Karachi',
            weekday: 'short',
        }).slice(0, 3);
        const map = { Mon: '0', Tue: '1', Wed: '2', Thu: '3', Fri: '4', Sat: '5', Sun: '6' };
        return map[weekday] || '0';
    }

    /**
     * Odoo weekday key for today in Pakistan: '0' Monday … '6' Sunday.
     */
    _pktTodayWeekday() {
        return this._pktWeekdayForDate(this.todayStr);
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

    async _fetchDmJobsPinnedPage(domain, fields, pag) {
        // Picked stock, or field Pending → In Transit, first. No status filter applied.
        const pinClause = ['|', ['state', '=', 'picked'], ['field_state', '=', 'in_transit']];
        const pinDomain = [...domain, ...pinClause];
        const restDomain = [...domain, '!', ...pinClause];
        const [total, pinTotal] = await Promise.all([
            this.orm.searchCount('shahtaj.dm.delivery', domain),
            this.orm.searchCount('shahtaj.dm.delivery', pinDomain),
        ]);
        const offset = (pag.page - 1) * pag.limit;
        const records = [];
        if (offset < pinTotal) {
            const pinned = await this.orm.searchRead(
                'shahtaj.dm.delivery',
                pinDomain,
                fields,
                {
                    limit: Math.min(pag.limit, pinTotal - offset),
                    offset,
                    order: 'write_date desc, id desc',
                },
            );
            records.push(...pinned);
            const remain = pag.limit - records.length;
            if (remain > 0) {
                const rest = await this.orm.searchRead(
                    'shahtaj.dm.delivery',
                    restDomain,
                    fields,
                    { limit: remain, offset: 0, order: 'scheduled_date desc, id desc' },
                );
                records.push(...rest);
            }
        } else {
            const rest = await this.orm.searchRead(
                'shahtaj.dm.delivery',
                restDomain,
                fields,
                {
                    limit: pag.limit,
                    offset: Math.max(0, offset - pinTotal),
                    order: 'scheduled_date desc, id desc',
                },
            );
            records.push(...rest);
        }
        return { total, records };
    }

    async _loadScheduleProgressForDate(records, dateStr) {
        const stats = {};
        if (!records.length) {
            return stats;
        }
        const bookerIds = [...new Set(records.map((r) => this._m2oId(r.order_booker_id)).filter(Boolean))];
        const routeIds = [...new Set(records.map((r) => this._m2oId(r.route_id)).filter(Boolean))];
        const domain = [
            ['state', '!=', 'cancelled'],
        ];
        if (dateStr) {
            domain.push(['scheduled_date', '=', dateStr]);
        }
        if (bookerIds.length) {
            domain.push(['order_booker_id', 'in', bookerIds]);
        }
        if (routeIds.length) {
            domain.push(['route_id', 'in', routeIds]);
        }
        const tasks = await this.orm.searchRead(
            'shahtaj.visit.task',
            domain,
            ['order_booker_id', 'route_id', 'state'],
            { limit: 10000 },
        );
        for (const task of tasks) {
            const key = `${this._m2oId(task.order_booker_id) || 0}:${this._m2oId(task.route_id) || 0}`;
            if (!stats[key]) {
                stats[key] = { planned: 0, done: 0, skipped: 0 };
            }
            stats[key].planned += 1;
            if (task.state === 'completed') {
                stats[key].done += 1;
            } else if (task.state === 'skipped') {
                stats[key].skipped += 1;
            }
        }
        return stats;
    }

   async loadDropdownData() {
        const data = await getOperationsLookups(this.orm);
        applyOperationsLookupsToState(this.state, data);
    }

    async loadSaleOrderCatalog() {
        try {
            const data = await getOperationsCatalogs(this.orm);
            applyOperationsCatalogsToState(this.state, data);
        } catch (error) {
            this.notification.add("Failed to load shops/products for sales orders: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    _formatRs(value) {
        return `Rs. ${(parseFloat(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    _formatQty(value) {
        const n = parseFloat(value);
        if (Number.isNaN(n)) return '0';
        return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
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

    _dateRangeDomain(filters, field) {
        const domain = [];
        if (filters && filters.dateFrom) domain.push([field, ">=", filters.dateFrom]);
        if (filters && filters.dateTo) domain.push([field, "<=", filters.dateTo]);
        return domain;
    }

    _mapDmDeliveryRow(j) {
        return {
            id: j.id,
            name: j.display_name || (j.sale_order_id ? j.sale_order_id[1] : `Job ${j.id}`),
            dm: j.delivery_man_id ? j.delivery_man_id[1] : '—',
            dmId: j.delivery_man_id ? j.delivery_man_id[0] : false,
            shop: j.partner_id ? j.partner_id[1] : '—',
            shopId: j.partner_id ? j.partner_id[0] : false,
            order: j.sale_order_id ? j.sale_order_id[1] : '—',
            orderId: j.sale_order_id ? j.sale_order_id[0] : false,
            booker: j.order_booker_id ? j.order_booker_id[1] : '—',
            date: j.scheduled_date || '—',
            amount: j.amount_total || 0,
            shopDue: j.shop_outstanding_balance || 0,
            state: j.state,
            fieldState: j.field_state,
            assignmentMode: j.assignment_mode || '',
            gpsVerified: j.gps_verified,
            lines: [],
        };
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
        const dmIds = [...new Set(records.map((a) => this._m2oId(a.dm_delivery_id)).filter(Boolean))];
        const visitFields = [
            'notes', 'sale_order_id', 'outcome', 'state',
            'started_at', 'ended_at', 'duration_seconds', 'duration_minutes',
            'dm_delivery_id',
        ];
        const visitsById = {};
        const visitsByDmId = {};
        const tasksById = {};
        const jobsById = {};
        const rememberVisit = (v) => {
            visitsById[v.id] = v;
            const dmId = this._m2oId(v.dm_delivery_id);
            if (dmId) visitsByDmId[dmId] = v;
        };
        try {
            const jobs = [];
            if (visitIds.length) {
                jobs.push(
                    this.orm.read('shahtaj.visit', visitIds, visitFields).then((rows) => {
                        rows.forEach(rememberVisit);
                    }),
                );
            }
            if (taskIds.length) {
                jobs.push(
                    this.orm.read('shahtaj.visit.task', taskIds, ['notes']).then((rows) => {
                        rows.forEach((t) => { tasksById[t.id] = t; });
                    }),
                );
            }
            if (dmIds.length) {
                jobs.push(
                    this.orm.searchRead(
                        'shahtaj.visit',
                        [['dm_delivery_id', 'in', dmIds]],
                        visitFields,
                    ).then((rows) => {
                        rows.forEach(rememberVisit);
                    }),
                );
                jobs.push(
                    this.orm.read(
                        'shahtaj.dm.delivery',
                        dmIds,
                        ['picked_at', 'delivered_at'],
                    ).then((rows) => {
                        rows.forEach((j) => { jobsById[j.id] = j; });
                    }),
                );
            }
            await Promise.all(jobs);
        } catch (_error) {
            // List still renders GPS rows if visit/task notes cannot be read.
        }
        return { visitsById, visitsByDmId, tasksById, jobsById };
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

    async _ordersWithPostedInvoices(records) {
        const invoiceIds = [...new Set((records || []).flatMap((o) => o.invoice_ids || []))];
        if (!invoiceIds.length) return new Set();
        const posted = await this.orm.searchRead(
            "account.move",
            [["id", "in", invoiceIds], ["state", "=", "posted"], ["move_type", "=", "out_invoice"]],
            ["id"],
        );
        const postedIds = new Set(posted.map((m) => m.id));
        const orderIds = new Set();
        for (const order of records) {
            if ((order.invoice_ids || []).some((id) => postedIds.has(id))) {
                orderIds.add(order.id);
            }
        }
        return orderIds;
    }

    async _refreshPostedInvoiceFlag(row, orderId) {
        if (!row || !orderId) return;
        const [so] = await this.orm.read("sale.order", [orderId], ["invoice_ids", "invoice_status", "state"]);
        if (!so) return;
        row.invoiceIds = so.invoice_ids || [];
        row.invoice_status = so.invoice_status;
        row.orderState = so.state;
        const posted = await this._ordersWithPostedInvoices([so]);
        row.hasPostedInvoice = posted.has(orderId);
        if (so.invoice_status === "invoiced") {
            row.status = "Invoiced";
        } else if (so.state === "sale") {
            row.status = "To Invoice";
        }
    }

    canCreateInvoice(row) {
        if (!this.hasFinancialAccess || !row) return false;
        if (["Draft", "Needs Verification", "Rejected", "Cancelled"].includes(row.status)) return false;
        if (row.orderState === "cancel") return false;
        if (row.invoice_status === "invoiced") return false;
        return true;
    }

    canAssignDeliveryMan(row) {
        return !!(row && row.hasPostedInvoice && row.status !== "Cancelled" && row.orderState !== "cancel");
    }

    canCancelOrder(row) {
        if (!row) return false;
        if (["Cancelled", "Rejected", "Delivered", "Invoiced", "Needs Verification"].includes(row.status)) return false;
        if (row.hasPostedInvoice || row.is_fully_delivered) return false;
        if (["done", "cancel"].includes(row.orderState)) return false;
        return ["draft", "sent", "sale"].includes(row.orderState) || ["Draft", "To Invoice"].includes(row.status);
    }

    isConfirmedSaleOrder(row) {
        if (!row) return false;
        if (["sale", "done"].includes(row.orderState)) return true;
        return ["Confirmed", "To Invoice", "Invoiced", "Delivered"].includes(row.status);
    }

    canRemoveSaleOrderProduct(row, line) {
        if (line && String(line.id).startsWith("new_")) return true;
        return !this.isConfirmedSaleOrder(row);
    }

    async invoiceSaleOrder(orderId) {
        await this.orm.call("sale.order", "action_shahtaj_create_and_post_invoice", [[orderId]]);
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
            status: status,
            invoice_status: o.invoice_status,
            orderState: o.state,
            hasPostedInvoice: false,
            invoiceIds: o.invoice_ids || [],
            is_fully_delivered: totalOrd > 0 && totalDel >= totalOrd, line_ids: o.order_line, lines: []
        };
    }

    // --- THE MASTER DATA ENGINE ---
    async fetchActiveList() {
        let tab = this.state.activeSubTab;
        if (tab === 'performance') tab = this.state.perfSubTab;
        if (tab === 'orders' && this.state.ordersSubTab === 'verification') tab = 'verification';
        if (tab === 'deliveries') {
            if (this.state.deliveriesSubTab === 'jobs') tab = 'dm_jobs';
            else if (this.state.deliveriesSubTab === 'sessions') tab = 'sessions';
            else if (this.state.deliveriesSubTab === 'recovery') tab = 'collections';
            else if (this.state.deliveriesSubTab === 'settlements') tab = 'settlements';
            else tab = 'dispatch';
        }
        
        this.state.isLoadingList = true;
        notifyPortalBusy(true);
        try {
            const pag = this.state.pagination[tab];
            const filters = this.state.filters[tab] || {};
            if (!pag) {
                this.state.isLoadingList = false;
                notifyPortalBusy(false);
                return;
            }
            let domain = []; let model = ''; let fields = []; let targetState = '';

            // 1. DOMAIN MAPPINGS
            if (tab === 'deliveries' || tab === 'dispatch' || tab === 'orders' || tab === 'verification') {
                model = 'sale.order';
                targetState = tab === 'deliveries' ? 'tableDeliveries' : (tab === 'dispatch' ? 'tableDispatch' : (tab === 'verification' ? 'tableVerification' : 'tableOrders'));
                fields = ["name", "partner_id", "user_id", "date_order", "amount_total", "amount_tax", "amount_untaxed", "state", "order_line", "invoice_status", "invoice_ids"];
                if (tab === 'dispatch') {
                    fields.push("shahtaj_delivery_status", "shahtaj_qty_to_deliver", "shahtaj_dm_delivery_count");
                }
                if (tab !== 'deliveries' && tab !== 'dispatch') {
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
                if (tab === 'dispatch') {
                    domain.push(['state', 'in', ['sale', 'done']]);
                    domain.push(['shahtaj_delivery_status', 'in', ['pending', 'partial']]);
                }
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
                    else if (filters.status === 'Cancelled') domain.push(['state', '=', 'cancel']);
                }
            } 
            else if (tab === 'dm_jobs') {
                model = 'shahtaj.dm.delivery';
                targetState = 'tableDmJobs';
                fields = [
                    'id', 'display_name', 'delivery_man_id', 'partner_id', 'sale_order_id',
                    'order_booker_id', 'scheduled_date', 'state', 'field_state',
                    'amount_total', 'shop_outstanding_balance', 'assignment_mode', 'gps_verified',
                ];
                if (filters.search) {
                    domain.push('|', '|', '|',
                        ['display_name', 'ilike', filters.search],
                        ['partner_id.name', 'ilike', filters.search],
                        ['sale_order_id.name', 'ilike', filters.search],
                        ['delivery_man_id.name', 'ilike', filters.search],
                    );
                }
                if (filters.dm && filters.dm !== 'all') domain.push(['delivery_man_id', '=', parseInt(filters.dm)]);
                domain.push(...this._dateRangeDomain(filters, 'scheduled_date'));
                if (filters.state && filters.state !== 'all') domain.push(['state', '=', filters.state]);
                if (filters.field_state && filters.field_state !== 'all') domain.push(['field_state', '=', filters.field_state]);
                if (filters.assignment_mode && filters.assignment_mode !== 'all') domain.push(['assignment_mode', '=', filters.assignment_mode]);
            }
            else if (tab === 'sessions') {
                model = 'shahtaj.dm.day.session';
                targetState = 'tableSessions';
                fields = ['id', 'delivery_man_id', 'session_date', 'state', 'departed_at', 'ended_at'];
                if (filters.dm && filters.dm !== 'all') domain.push(['delivery_man_id', '=', parseInt(filters.dm)]);
                domain.push(...this._dateRangeDomain(filters, 'session_date'));
            }
            else if (tab === 'collections') {
                model = 'account.payment';
                targetState = 'tableCollections';
                fields = ['id', 'name', 'date', 'amount', 'partner_id', 'shahtaj_collected_by_dm_id', 'shahtaj_payment_channel', 'state'];
                domain.push(['shahtaj_is_dm_wallet_collection', '=', true]);
                if (filters.search) {
                    domain.push('|', '|',
                        ['name', 'ilike', filters.search],
                        ['partner_id.name', 'ilike', filters.search],
                        ['shahtaj_collected_by_dm_id.name', 'ilike', filters.search],
                    );
                }
                if (filters.dm && filters.dm !== 'all') domain.push(['shahtaj_collected_by_dm_id', '=', parseInt(filters.dm)]);
                domain.push(...this._dateRangeDomain(filters, 'date'));
            }
            else if (tab === 'settlements') {
                model = 'shahtaj.dm.wallet.settlement';
                targetState = 'tableSettlements';
                fields = ['id', 'name', 'delivery_man_id', 'amount', 'settlement_date', 'bank_journal_id', 'settled_by_id', 'move_id', 'state', 'notes'];
                if (filters.search) {
                    domain.push('|', '|',
                        ['name', 'ilike', filters.search],
                        ['delivery_man_id.name', 'ilike', filters.search],
                        ['move_id.name', 'ilike', filters.search],
                    );
                }
                if (filters.dm && filters.dm !== 'all') domain.push(['delivery_man_id', '=', parseInt(filters.dm)]);
                domain.push(...this._dateRangeDomain(filters, 'settlement_date'));
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
                if (filters.role && filters.role !== 'all') domain.push(['role', '=', filters.role]);
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
                fields = ['id', 'name', 'day_of_week', 'route_id', 'zone_id', 'active', 'shop_count', 'order_booker_id'];
                if (filters.booker !== 'all') domain.push(['order_booker_id', '=', parseInt(filters.booker)]);
                if (filters.date) domain.push(['day_of_week', '=', this._pktWeekdayForDate(filters.date)]);
            }
            else if (tab === 'targets') {
                model = 'shahtaj.visit.target'; targetState = 'tableTargets';
                fields = ['id', 'name', 'date_start', 'date_end', 'target_type', 'target_value', 'achieved_value', 'remaining_value', 'progress_percent', 'product_id', 'currency_id', 'target_weight_uom', 'active', 'order_booker_id'];
                if (filters.booker !== 'all') domain.push(['order_booker_id', '=', parseInt(filters.booker)]);
                if (filters.type !== 'all') domain.push(['target_type', '=', filters.type]);
            }

            if ((tab === 'collections' || tab === 'settlements') && !this.hasFinancialAccess) {
                this.state.isLoadingList = false;
                notifyPortalBusy(false);
                return;
            }
            // 2. EXECUTE QUERY
            if (!model) {
                this.state.isLoadingList = false;
                notifyPortalBusy(false);
                return;
            }
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
            if (tab === 'sessions') {
                queryKwargs.order = 'session_date desc, id desc';
            }
            if (tab === 'collections') {
                queryKwargs.order = 'date desc, id desc';
            }
            if (tab === 'settlements') {
                queryKwargs.order = 'settlement_date desc, id desc';
            }
            let total;
            let records;
            if (tab === 'schedules') {
                ({ total, records } = await this._fetchSchedulesSortedPage(domain, fields, pag));
            } else if (tab === 'dm_jobs') {
                ({ total, records } = await this._fetchDmJobsPinnedPage(domain, fields, pag));
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
            if (tab === 'deliveries' || tab === 'dispatch' || tab === 'orders' || tab === 'verification') {
                const orderIds = records.map(o => o.id);
                const [lines, postedOrderIds] = await Promise.all([
                    orderIds.length ? this.orm.searchRead("sale.order.line", [["order_id", "in", orderIds]], ["order_id", "product_uom_qty", "qty_delivered"]) : Promise.resolve([]),
                    this._ordersWithPostedInvoices(records),
                ]);
                this.state[targetState] = records.map(o => {
                    const row = this._mapSaleOrderRow(o, lines);
                    row.hasPostedInvoice = postedOrderIds.has(o.id);
                    if (tab === 'dispatch') {
                        row.deliveryStatus = o.shahtaj_delivery_status || '';
                        row.qtyToDeliver = o.shahtaj_qty_to_deliver || 0;
                        row.dmJobCount = o.shahtaj_dm_delivery_count || 0;
                    }
                    return row;
                });
            }
            else if (tab === 'dm_jobs') {
                this.state.tableDmJobs = records.map((j) => this._mapDmDeliveryRow(j));
            }
            else if (tab === 'sessions') {
                this.state.tableSessions = records.map((s) => ({
                    id: s.id,
                    dm: s.delivery_man_id ? s.delivery_man_id[1] : '—',
                    date: s.session_date || '—',
                    state: s.state,
                    departed: s.departed_at || '—',
                    ended: s.ended_at || '—',
                }));
            }
            else if (tab === 'collections') {
                this.state.tableCollections = records.map((p) => this._mapRecoveryRow(p));
            }
            else if (tab === 'settlements') {
                this.state.tableSettlements = records.map((s) => ({
                    id: s.id,
                    name: s.name,
                    dm: s.delivery_man_id ? s.delivery_man_id[1] : '—',
                    dmId: s.delivery_man_id ? s.delivery_man_id[0] : false,
                    amount: s.amount || 0,
                    date: s.settlement_date || '—',
                    journal: s.bank_journal_id ? s.bank_journal_id[1] : '—',
                    settledBy: s.settled_by_id ? s.settled_by_id[1] : '—',
                    move: s.move_id ? s.move_id[1] : '—',
                    state: s.state,
                    notes: s.notes || '',
                }));
            }
            else if (tab === 'checkins') {
                const { visitsById, visitsByDmId, tasksById, jobsById } = await this._enrichCheckinRows(records);
                this.state.tableCheckins = records.map(a => {
                    const isOk = a.result === 'ok';
                    const status = this._gpsResultLabel(a.result);
                    const purposeLabel = this._gpsPurposeLabel(a.purpose);
                    const distLabel = a.distance_m
                        ? `${Math.round(a.distance_m)} m`
                        : (isOk ? '—' : 'n/a');
                    const visit = visitsById[this._m2oId(a.visit_id)]
                        || visitsByDmId[this._m2oId(a.dm_delivery_id)]
                        || null;
                    const job = jobsById[this._m2oId(a.dm_delivery_id)] || null;
                    const task = tasksById[this._m2oId(a.visit_task_id)] || null;
                    const saleOrder = a.sale_order_id || (visit && visit.sale_order_id) || false;
                    const outcome = this._gpsCheckinOutcome(a, Boolean(this._m2oId(saleOrder)));
                    const notes = ((visit && visit.notes) || (task && task.notes) || '').trim();
                    const timing = this._checkinTiming(visit, job);
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
                        isDeliveryCheckin: outcome.isDeliveryCheckin,
                        hasOrder: outcome.hasOrder,
                        orderLabel: outcome.orderLabel,
                        notes,
                        endTime: timing.endTime,
                        duration: timing.duration,
                        outcome: purposeLabel,
                    };
                });
            }
            else if (tab === 'schedules') {
                const dateStr = filters.date || '';
                const stats = await this._loadScheduleProgressForDate(records, dateStr);
                const dayMap = { '0': 'Monday', '1': 'Tuesday', '2': 'Wednesday', '3': 'Thursday', '4': 'Friday', '5': 'Saturday', '6': 'Sunday' };
                const rows = records.map(r => {
                    const bookerId = r.order_booker_id ? r.order_booker_id[0] : null;
                    const routeId = r.route_id ? r.route_id[0] : null;
                    const rowStats = stats[`${bookerId || 0}:${routeId || 0}`] || { planned: 0, done: 0, skipped: 0 };
                    const progress = rowStats.planned ? (rowStats.done / rowStats.planned * 100) : 0;
                    return {
                        id: r.id, name: r.name, bookerId, bookerName: r.order_booker_id ? r.order_booker_id[1] : 'Unknown',
                        day_raw: r.day_of_week, day: dayMap[r.day_of_week] || r.day_of_week, route: r.route_id ? r.route_id[1] : 'Unassigned', zone: r.zone_id ? r.zone_id[1] : 'Unassigned',
                        shops: r.shop_count, active: r.active, planned: rowStats.planned, done: rowStats.done, skipped: rowStats.skipped,
                        progress, occurrenceDate: dateStr,
                    };
                });
                if (!dateStr) {
                    rows.sort((a, b) => this._compareSchedulesByToday(a, b, this._pktTodayWeekday()));
                }
                this.state.tableSchedules = rows;
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
            notifyPortalBusy(false);
        }
    }
    async refreshData() {
        this.state.isRefreshing = true;
        try {
            await this.reloadFromRefresh();
        } finally {
            this.state.isRefreshing = false;
        }
    }
    async reloadFromRefresh() {
        await this.loadDropdownData();
        await this.loadSaleOrderCatalog();
        if (hasFinancialAccess()) {
            await this.loadTaxAndProductData();
        }
        await this.fetchActiveList();
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
        this.state.shopSnapshotOpen = false;
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
        this.state.isCreatingInvoice = true;
        try {
            await this.invoiceSaleOrder(this.state.selectedDelivery.odoo_id);
            this.notification.add("Invoice created and posted. You can assign a delivery man.", { type: "success" });
            await this.viewDelivery(this.state.selectedDelivery);
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || "Failed to create invoice.", { type: "danger" });
        } finally {
            this.state.isCreatingInvoice = false;
        }
    }

    async createInvoiceFromDispatch(row) {
        if (!this.canCreateInvoice(row) || this.state.isCreatingInvoice) return;
        this.state.isCreatingInvoice = true;
        try {
            await this.invoiceSaleOrder(row.odoo_id);
            this.notification.add("Invoice created and posted. You can assign a delivery man.", { type: "success" });
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || "Failed to create invoice.", { type: "danger" });
        } finally {
            this.state.isCreatingInvoice = false;
        }
    }

   async loadTaxAndProductData() {
        if (!hasFinancialAccess()) {
            return;
        }
        try {
            const data = await getOperationsTaxCatalog(this.orm);
            this.state.saleTaxes = data.saleTaxes;
            this.state.allProducts = data.allProducts;
            this._catalogsLoaded = true;
        } catch (error) {
            this.notification.add("Failed to load product catalog: " + (error.data?.message || error.message), { type: "warning" });
        }
    }

    // 2. UPDATE THIS METHOD TO MAP TAX NAMES IN DELIVERIES
    async viewDelivery(dlv) {
        this.state.selectedDelivery = dlv;
        this.state.isEditingDelivery = false;
        this.state.shopSnapshotOpen = false;
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

            const orderData = await this.orm.read("sale.order", [dlv.odoo_id], [
                "amount_untaxed", "amount_tax", "amount_total", "invoice_status", "invoice_ids", "state",
                "shahtaj_shop_category", "shahtaj_shop_credit_limit", "shahtaj_shop_outstanding",
                "shahtaj_shop_pending_exposure", "shahtaj_shop_uninvoiced_exposure",
                "shahtaj_shop_effective_outstanding", "shahtaj_shop_credit_remaining",
                "shahtaj_shop_credit_would_exceed", "shahtaj_shop_credit_shortfall",
                "shahtaj_shop_lifetime_sales", "shahtaj_shop_confirmed_order_count",
                "shahtaj_shop_past_discount_total", "shahtaj_shop_past_discount_count",
                "shahtaj_shop_last_discount_date", "shahtaj_shop_last_discount_amount",
                "payment_term_id", "shahtaj_approval_state",
            ]);
            if (orderData.length > 0) {
                dlv.amount_untaxed = orderData[0].amount_untaxed;
                dlv.amount_tax = orderData[0].amount_tax;
                dlv.amount_total = orderData[0].amount_total;
                dlv.invoice_status = orderData[0].invoice_status;
                dlv.invoiceIds = orderData[0].invoice_ids || [];
                dlv.orderState = orderData[0].state;
                const posted = await this._ordersWithPostedInvoices(orderData);
                dlv.hasPostedInvoice = posted.has(dlv.odoo_id);
                this._applyShopSnapshot(orderData[0], dlv);
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
        const line = (this.state.selectedDelivery.full_lines || []).find((l) => l.id === lineId);
        if (!this.canRemoveSaleOrderProduct(this.state.selectedDelivery, line)) {
            this.notification.add("Products cannot be removed from a confirmed sales order.", { type: "warning" });
            return;
        }
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
        const rows = [...this.state.tableDispatch, ...this.state.tableDeliveries, ...this.state.tableOrders];
        const row = rows.find((r) => r.odoo_id === orderId) || this.state.selectedDelivery || this.state.selectedOrder;
        if (row && (row.status === "Cancelled" || row.orderState === "cancel")) {
            this.notification.add("Cancelled orders cannot be delivered.", { type: "warning" });
            return;
        }
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
                let updatedOrder = this.state.tableDispatch.find(o => o.odoo_id === this.state.selectedDelivery.odoo_id) ||
                                   this.state.tableDeliveries.find(o => o.odoo_id === this.state.selectedDelivery.odoo_id) ||
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

    setDeliveriesSubTab(tabName) {
        if (tabName === 'manual') tabName = 'dispatch';
        this.state.deliveriesSubTab = tabName;
        this.state.selectedDelivery = null;
        this.state.selectedDmJob = null;
        this.state.selectedSettlement = null;
        this.state.selectedRecovery = null;
        this.state.isEditingDelivery = false;
        this.fetchActiveList();
    }

    stockStateLabel(state) {
        const map = {
            not_ready: "Not ready", ready: "Ready", picked: "Picked",
            partial: "Partial", delivered: "Delivered", returned: "Returned",
        };
        return map[state] || state || "—";
    }

    stockStateBadgeClass(state) {
        const map = {
            not_ready: "bg-danger text-white",
            ready: "bg-info text-white",
            picked: "bg-warning text-dark",
            partial: "bg-warning text-dark",
            delivered: "bg-success text-white",
            returned: "bg-danger text-white",
        };
        return map[state] || "bg-secondary text-white";
    }

    fieldStateLabel(state) {
        const map = {
            pending: "Pending", in_transit: "In transit", done: "Done",
            not_attended: "Shop closed", failed: "Failed",
        };
        return map[state] || state || "—";
    }

    fieldStateBadgeClass(state) {
        const map = {
            pending: "bg-warning text-dark",
            in_transit: "bg-info text-white",
            not_attended: "bg-warning text-dark",
            failed: "bg-danger text-white",
            done: "bg-success text-white",
        };
        return map[state] || "bg-secondary text-white";
    }

    _formatAssignQty(value) {
        const n = Number(value) || 0;
        return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(6)));
    }

    get assignAllocationSummary() {
        const byLine = new Map();
        for (const job of this.state.assignModal.jobs || []) {
            for (const line of job.lines || []) {
                const key = line.saleOrderLineId || line.id;
                const current = byLine.get(key) || {
                    id: key,
                    product: line.product,
                    qtyOrdered: Number(line.qtyOrdered) || 0,
                    qtyAssigned: 0,
                };
                current.qtyAssigned += Number(line.qtyAssigned) || 0;
                current.qtyOrdered = Number(line.qtyOrdered) || current.qtyOrdered;
                byLine.set(key, current);
            }
        }
        const rows = [...byLine.values()].map((row) => {
            const left = row.qtyOrdered - row.qtyAssigned;
            let status = "ok";
            if (row.qtyAssigned > row.qtyOrdered + 1e-6) status = "over";
            else if (left > 1e-6) status = "left";
            return {
                ...row,
                left,
                status,
                qtyOrderedLabel: this._formatAssignQty(row.qtyOrdered),
                qtyAssignedLabel: this._formatAssignQty(row.qtyAssigned),
                leftLabel: this._formatAssignQty(left),
            };
        });
        const over = rows.some((row) => row.status === "over");
        const leftover = rows.some((row) => row.status === "left");
        let message = "Fully allocated.";
        let messageClass = "text-success";
        let messageStrong = true;
        if (over) {
            message = "Over-allocated — reduce quantities.";
            messageClass = "text-danger";
        } else if (leftover || !rows.length) {
            message = "Unassigned leftover stays on the sales order until you allocate it.";
            messageClass = "text-muted";
            messageStrong = false;
        }
        return { rows, message, messageClass, messageStrong };
    }

    optionId(id) {
        return id === false || id === null || id === undefined || id === "" ? "" : String(id);
    }

    isSelectedId(current, id) {
        return this.optionId(current) === this.optionId(id);
    }

    assignDmOptions(job) {
        const list = this.state.lookupDeliveryMen || [];
        const selected = this.optionId(job && job.deliveryManId);
        if (!selected || list.some((dm) => this.optionId(dm.id) === selected)) {
            return list;
        }
        return [{ id: selected, name: (job && job.deliveryManName) || "Delivery man" }, ...list];
    }

    setAssignDeliveryMan(job, value) {
        const id = this.optionId(value);
        job.deliveryManId = id;
        const match = (this.state.lookupDeliveryMen || []).find((dm) => this.optionId(dm.id) === id);
        job.deliveryManName = match ? match.name : (id ? job.deliveryManName : "");
    }

    async openAssignModal(orderId, readOnly = false) {
        const fromJob = !!readOnly || (this.state.selectedDmJob && this.state.selectedDmJob.orderId === orderId);
        const rows = [...this.state.tableDispatch, ...this.state.tableDeliveries, ...this.state.tableOrders];
        const row = rows.find((r) => r.odoo_id === orderId) || this.state.selectedDelivery;
        if (!fromJob && row && (row.status === "Cancelled" || row.orderState === "cancel")) {
            this.notification.add("Cancelled orders cannot be delivered.", { type: "warning" });
            return;
        }
        if (!fromJob && row && !this.canAssignDeliveryMan(row)) {
            this.notification.add("Invoice and post this order before assigning a delivery man.", { type: "warning" });
            return;
        }
        this.state.assignModal.saving = true;
        try {
            const wizardIds = await this.orm.create(
                "shahtaj.dm.assign.wizard",
                [{}],
                { context: { active_id: orderId, active_model: "sale.order" } },
            );
            const wizardId = Array.isArray(wizardIds) ? wizardIds[0] : wizardIds;
            await this._loadAssignWizard(wizardId);
            this.state.assignModal.readOnly = !!readOnly;
            this.state.assignModal.open = true;
        } catch (error) {
            this.notification.add("Failed to open assign: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.assignModal.saving = false;
        }
    }

    async _loadAssignWizard(wizardId) {
        const [wiz] = await this.orm.read(
            "shahtaj.dm.assign.wizard",
            [wizardId],
            ["sale_order_id", "partner_id", "job_ids"],
        );
        const jobs = wiz.job_ids?.length
            ? await this.orm.read(
                "shahtaj.dm.assign.wizard.job",
                wiz.job_ids,
                ["id", "delivery_man_id", "scheduled_date", "line_ids", "existing_job_id"],
            )
            : [];
        const allLineIds = jobs.flatMap((j) => j.line_ids || []);
        const lineRecs = allLineIds.length
            ? await this.orm.read(
                "shahtaj.dm.assign.wizard.line",
                allLineIds,
                ["id", "sale_order_line_id", "product_id", "qty_ordered", "qty_assigned"],
            )
            : [];
        const existingIds = jobs.map((j) => j.existing_job_id && j.existing_job_id[0]).filter(Boolean);
        const existingRecs = existingIds.length
            ? await this.orm.read("shahtaj.dm.delivery", existingIds, ["id", "state", "delivery_man_id"])
            : [];
        const existingById = Object.fromEntries(existingRecs.map((e) => [e.id, e]));
        const linesById = Object.fromEntries(lineRecs.map((l) => [l.id, l]));
        this.state.assignModal.wizardId = wizardId;
        this.state.assignModal.orderName = wiz.sale_order_id ? wiz.sale_order_id[1] : "";
        this.state.assignModal.shop = wiz.partner_id ? wiz.partner_id[1] : "";
        this.state.assignModal.jobs = jobs.map((j) => {
            const existingId = j.existing_job_id ? j.existing_job_id[0] : false;
            const existing = existingId ? existingById[existingId] : null;
            const dm = j.delivery_man_id || (existing && existing.delivery_man_id) || false;
            const lockedStates = ["picked", "partial", "delivered", "returned"];
            return {
                id: j.id,
                deliveryManId: dm ? String(Array.isArray(dm) ? dm[0] : dm) : "",
                deliveryManName: Array.isArray(dm) ? (dm[1] || "") : "",
                scheduledDate: j.scheduled_date || this.todayStr,
                canRemove: !existing || !lockedStates.includes(existing.state),
                lines: (j.line_ids || []).map((lid) => {
                    const l = linesById[lid] || {};
                    return {
                        id: lid,
                        saleOrderLineId: l.sale_order_line_id ? l.sale_order_line_id[0] : lid,
                        product: l.product_id ? l.product_id[1] : "Product",
                        qtyOrdered: l.qty_ordered || 0,
                        qtyAssigned: l.qty_assigned || 0,
                    };
                }),
            };
        });
    }

    closeAssignModal() {
        this.state.assignModal.open = false;
        this.state.assignModal.readOnly = false;
        this.state.assignModal.wizardId = null;
        this.state.assignModal.jobs = [];
    }

    async persistAssignEdits() {
        const jobs = this.state.assignModal.jobs;
        for (const job of jobs) {
            await this.orm.write("shahtaj.dm.assign.wizard.job", [job.id], {
                delivery_man_id: job.deliveryManId ? parseInt(job.deliveryManId, 10) : false,
                scheduled_date: job.scheduledDate || this.todayStr,
            });
            for (const line of job.lines) {
                await this.orm.write("shahtaj.dm.assign.wizard.line", [line.id], {
                    qty_assigned: Number(line.qtyAssigned) || 0,
                });
            }
        }
    }

    async addAssignDeliveryMan() {
        if (!this.state.assignModal.wizardId) return;
        this.state.assignModal.saving = true;
        try {
            await this.persistAssignEdits();
            await this.orm.call("shahtaj.dm.assign.wizard", "action_add_delivery_man", [[this.state.assignModal.wizardId]]);
            await this._loadAssignWizard(this.state.assignModal.wizardId);
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.assignModal.saving = false;
        }
    }

    async removeAssignDeliveryMan(jobId) {
        if (!this.state.assignModal.wizardId || !jobId) return;
        this.state.assignModal.saving = true;
        try {
            await this.persistAssignEdits();
            await this.orm.call(
                "shahtaj.dm.assign.wizard",
                "action_remove_delivery_man",
                [[this.state.assignModal.wizardId]],
                { job_id: jobId },
            );
            await this._loadAssignWizard(this.state.assignModal.wizardId);
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.assignModal.saving = false;
        }
    }

    async confirmAssign() {
        if (!this.state.assignModal.wizardId) return;
        this.state.assignModal.saving = true;
        try {
            await this.persistAssignEdits();
            await this.orm.call("shahtaj.dm.assign.wizard", "action_confirm_assign", [[this.state.assignModal.wizardId]]);
            this.notification.add("Delivery men assigned.", { type: "success" });
            const openJob = this.state.selectedDmJob;
            this.closeAssignModal();
            await this.fetchActiveList();
            if (openJob && openJob.id) {
                try {
                    await this.viewDmJob({ id: openJob.id, orderId: openJob.orderId });
                } catch (refreshError) {
                    this.state.selectedDmJob = null;
                }
            }
        } catch (error) {
            this.notification.add("Assign failed: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.assignModal.saving = false;
        }
    }

    async viewDmJob(job) {
        this.state.dmJobSections = { delivery: true, order: true, shop: false, gps: false, products: true };
        const [detail, lines] = await Promise.all([
            this.orm.read("shahtaj.dm.delivery", [job.id], [
                "display_name", "delivery_man_id", "scheduled_date", "scheduled_time",
                "picked_at", "delivered_at", "state", "field_state", "assignment_mode",
                "assigned_by_id", "amount_total", "qty_assigned_total", "invoice_status",
                "sale_order_id", "partner_id", "order_booker_id", "order_date", "notes",
                "shop_category", "shop_outstanding_balance", "shop_unpaid_invoice_amount",
                "shop_credit_limit", "shop_unpaid_invoice_count", "shop_invoice_count",
                "gps_verified", "check_in_distance_m", "receiver_name",
                "check_in_latitude", "check_in_longitude", "has_delivery_proof", "delivery_proof_image",
            ]),
            this.orm.searchRead(
                "shahtaj.dm.delivery.line",
                [["delivery_id", "=", job.id]],
                ["id", "product_id", "qty_ordered", "qty_assigned", "qty_to_pick", "qty_picked", "qty_delivered", "qty_remaining_on_van"],
            ),
        ]);
        const rec = detail[0] || {};
        this.state.selectedDmJob = {
            ...job,
            name: rec.display_name || job.name,
            dm: rec.delivery_man_id ? rec.delivery_man_id[1] : job.dm,
            shop: rec.partner_id ? rec.partner_id[1] : job.shop,
            order: rec.sale_order_id ? rec.sale_order_id[1] : job.order,
            orderId: rec.sale_order_id ? rec.sale_order_id[0] : (job.orderId || false),
            booker: rec.order_booker_id ? rec.order_booker_id[1] : (job.booker || "—"),
            date: rec.scheduled_date || job.date,
            scheduledTime: rec.scheduled_time || 0,
            pickedAt: rec.picked_at || "",
            deliveredAt: rec.delivered_at || "",
            state: rec.state || job.state,
            fieldState: rec.field_state || job.fieldState,
            assignmentMode: rec.assignment_mode || "",
            assignedBy: rec.assigned_by_id ? rec.assigned_by_id[1] : "—",
            amount: rec.amount_total || 0,
            qtyAssignedTotal: rec.qty_assigned_total || 0,
            invoiceStatus: rec.invoice_status || "",
            orderDate: rec.order_date || "",
            notes: rec.notes || "",
            shopCategory: rec.shop_category || "",
            shopDue: rec.shop_outstanding_balance || 0,
            shopUnpaidAmount: rec.shop_unpaid_invoice_amount || 0,
            shopCreditLimit: rec.shop_credit_limit || 0,
            shopUnpaidCount: rec.shop_unpaid_invoice_count || 0,
            shopInvoiceCount: rec.shop_invoice_count || 0,
            gpsVerified: !!rec.gps_verified,
            gpsDistance: rec.check_in_distance_m || 0,
            receiverName: rec.receiver_name || "",
            gpsLat: rec.check_in_latitude || 0,
            gpsLng: rec.check_in_longitude || 0,
            hasProof: !!rec.has_delivery_proof,
            proofImage: rec.delivery_proof_image || "",
            lines: lines.map((l) => ({
                id: l.id,
                product: l.product_id ? l.product_id[1] : "Product",
                qtyOrdered: l.qty_ordered || 0,
                qtyAssigned: l.qty_assigned || 0,
                qtyToPick: l.qty_to_pick || 0,
                qtyPicked: l.qty_picked || 0,
                qtyDelivered: l.qty_delivered || 0,
                qtyOnVan: l.qty_remaining_on_van || 0,
            })),
        };
    }

    toggleDmJobSection(key) {
        this.state.dmJobSections[key] = !this.state.dmJobSections[key];
    }

    showDmJobActions() {
        return this.state.activeSubTab === "deliveries" && this.state.deliveriesSubTab === "jobs";
    }

    closeDmJob() {
        this.state.selectedDmJob = null;
        this.closeImagePreview();
    }

    async resetDmJobField(jobId) {
        try {
            await this.orm.call("shahtaj.dm.delivery", "action_field_reset_pending", [[jobId]]);
            this.notification.add("Field status reset to pending.", { type: "success" });
            await this.fetchActiveList();
            if (this.state.selectedDmJob && this.state.selectedDmJob.id === jobId) {
                await this.viewDmJob({ id: jobId });
            }
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        }
    }

    async returnDmJobWarehouse(jobId) {
        try {
            await this.orm.call("shahtaj.dm.delivery", "action_return_to_warehouse", [[jobId]]);
            this.notification.add("Undelivered stock returned to warehouse.", { type: "success" });
            this.state.selectedDmJob = null;
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        }
    }

    async openPickModal(jobId) {
        this.state.pickModal.saving = true;
        try {
            const wizardIds = await this.orm.create(
                "shahtaj.dm.pick.wizard",
                [{}],
                { context: { active_id: jobId, active_model: "shahtaj.dm.delivery" } },
            );
            const wizardId = Array.isArray(wizardIds) ? wizardIds[0] : wizardIds;
            const [wiz] = await this.orm.read("shahtaj.dm.pick.wizard", [wizardId], ["line_ids"]);
            const lines = wiz.line_ids?.length
                ? await this.orm.read(
                    "shahtaj.dm.pick.wizard.line",
                    wiz.line_ids,
                    ["id", "product_id", "qty_assigned", "qty_required", "qty_already_picked", "qty_to_pick"],
                )
                : [];
            this.state.pickModal = {
                open: true,
                wizardId,
                lines: lines.map((l) => ({
                    id: l.id,
                    product: l.product_id ? l.product_id[1] : "Product",
                    qtyAssigned: l.qty_assigned || 0,
                    qtyRequired: l.qty_required || 0,
                    qtyPicked: l.qty_already_picked || 0,
                    qtyToPick: l.qty_to_pick || 0,
                })),
                saving: false,
            };
        } catch (error) {
            this.notification.add("Pick wizard failed: " + (error.data?.message || error.message), { type: "danger" });
            this.state.pickModal.saving = false;
        }
    }

    closePickModal() {
        this.state.pickModal.open = false;
        this.state.pickModal.wizardId = null;
        this.state.pickModal.lines = [];
    }

    async confirmPick() {
        if (!this.state.pickModal.wizardId) return;
        this.state.pickModal.saving = true;
        try {
            for (const line of this.state.pickModal.lines) {
                await this.orm.write("shahtaj.dm.pick.wizard.line", [line.id], {
                    qty_to_pick: Number(line.qtyToPick) || 0,
                });
            }
            await this.orm.call("shahtaj.dm.pick.wizard", "action_confirm_pick", [[this.state.pickModal.wizardId]]);
            this.notification.add("Stock picked to van.", { type: "success" });
            this.closePickModal();
            await this.fetchActiveList();
            if (this.state.selectedDmJob) {
                await this.viewDmJob({ id: this.state.selectedDmJob.id });
            }
        } catch (error) {
            this.notification.add("Pick failed: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.pickModal.saving = false;
        }
    }

    canResetField(job) {
        return job && ["in_transit", "not_attended", "failed"].includes(job.fieldState);
    }

    canReturnWarehouse(job) {
        return job && ["picked", "partial"].includes(job.state);
    }

    canPickJob(job) {
        if (!job || !["ready", "picked", "partial"].includes(job.state)) {
            return false;
        }
        const lines = job.lines || [];
        if (!lines.length) {
            return job.state === "ready";
        }
        return lines.some((line) => (Number(line.qtyAssigned) || 0) - (Number(line.qtyPicked) || 0) > 0.000001);
    }

    sessionLabel(state) {
        const map = { office: "Office", on_the_way: "On the way", ended: "Ended" };
        return map[state] || state || "—";
    }

    assignmentModeLabel(mode) {
        const map = { manual: "Manual", auto: "Auto" };
        return map[mode] || mode || "—";
    }

    formatMoney(value) {
        return (Number(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    proofImageSrc(b64) {
        if (!b64) return "";
        return String(b64).startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
    }

    openImagePreview(src, title = "Delivery proof") {
        if (!src) return;
        this.state.imagePreview = { open: true, src, title };
    }

    closeImagePreview() {
        this.state.imagePreview = { open: false, src: "", title: "" };
    }

    async resetSession(id) {
        try {
            await this.orm.call("shahtaj.dm.day.session", "action_reset_office", [[id]]);
            this.notification.add("Session reset to office.", { type: "success" });
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        }
    }

    _paymentChannelLabel(channel) {
        return ({
            cash: 'Cash',
            cheque: 'Cheque',
            online: 'Online Bank Transfer',
            card: 'Card / POS',
            other: 'Other Bank Payment',
        })[channel] || channel || '—';
    }

    _mapRecoveryRow(p) {
        return {
            id: p.id,
            name: p.name || '—',
            date: p.date || '—',
            amount: p.amount || 0,
            shop: p.partner_id ? p.partner_id[1] : '—',
            shopId: p.partner_id ? p.partner_id[0] : false,
            dm: p.shahtaj_collected_by_dm_id ? p.shahtaj_collected_by_dm_id[1] : '—',
            dmId: p.shahtaj_collected_by_dm_id ? p.shahtaj_collected_by_dm_id[0] : false,
            channel: p.shahtaj_payment_channel || '',
            channelLabel: this._paymentChannelLabel(p.shahtaj_payment_channel),
            state: p.state || '—',
        };
    }

    async viewRecovery(row) {
        this.state.selectedRecovery = { ...row };
        try {
            const recs = await this.orm.read("account.payment", [row.id], [
                "name", "date", "amount", "state", "partner_id",
                "shahtaj_collected_by_dm_id", "shahtaj_payment_channel",
                "journal_id", "move_id", "memo",
                "shahtaj_payment_notes", "shahtaj_instrument_reference",
                "shahtaj_payer_bank_name", "shahtaj_payer_account_number",
                "shahtaj_has_cheque_image", "shahtaj_cheque_image",
                "shahtaj_dm_delivery_id", "reconciled_invoice_ids",
            ]);
            if (!recs.length || !this.state.selectedRecovery || this.state.selectedRecovery.id !== row.id) {
                return;
            }
            const p = recs[0];
            const invoices = Array.isArray(p.reconciled_invoice_ids) ? p.reconciled_invoice_ids : [];
            const invoiceNames = invoices.map((inv) => Array.isArray(inv) ? inv[1] : String(inv)).filter(Boolean);
            this.state.selectedRecovery = {
                ...this._mapRecoveryRow(p),
                journal: p.journal_id ? p.journal_id[1] : '—',
                move: p.move_id ? p.move_id[1] : '—',
                reference: p.shahtaj_instrument_reference || p.memo || '',
                notes: p.shahtaj_payment_notes || '',
                bankName: p.shahtaj_payer_bank_name || '',
                accountNumber: p.shahtaj_payer_account_number || '',
                hasChequeImage: !!p.shahtaj_has_cheque_image,
                chequeImage: p.shahtaj_cheque_image || '',
                job: p.shahtaj_dm_delivery_id ? p.shahtaj_dm_delivery_id[1] : '',
                invoices: invoiceNames,
                invoiceLabel: invoiceNames.join(', '),
            };
        } catch (error) {
            this.notification.add("Could not load recovery: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    closeRecovery() {
        this.state.selectedRecovery = null;
    }

    openRecoverySettle() {
        const dmId = this.state.selectedRecovery && this.state.selectedRecovery.dmId;
        return this.openSettleModal(dmId || "");
    }

    viewSettlement(row) {
        this.state.selectedSettlement = row;
    }

    closeSettlement() {
        this.state.selectedSettlement = null;
    }

    async _ensureSettleJournals() {
        if (this.state.settleModal.journals.length) return this.state.settleModal.journals;
        const journals = await this.orm.searchRead(
            "account.journal",
            [["type", "in", ["bank", "cash"]], ["code", "!=", "DMCASH"]],
            ["id", "name"],
            { limit: 40, order: "name asc" },
        );
        this.state.settleModal.journals = journals;
        return journals;
    }

    async openSettleModal(dmId = "") {
        this.state.settleModal.saving = true;
        try {
            const journals = await this._ensureSettleJournals();
            this.state.settleModal.open = true;
            this.state.settleModal.wizardId = null;
            this.state.settleModal.dmId = dmId ? String(dmId) : "";
            this.state.settleModal.notes = "";
            this.state.settleModal.bankJournalId = journals[0] ? String(journals[0].id) : "";
            this.state.settleModal.walletBalance = 0;
            this.state.settleModal.amount = 0;
            if (this.state.settleModal.dmId) {
                await this.onSettleDmChange();
            }
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.settleModal.saving = false;
        }
    }

    async onSettleDmChange() {
        const dmId = parseInt(this.state.settleModal.dmId, 10);
        if (!dmId) {
            this.state.settleModal.walletBalance = 0;
            this.state.settleModal.amount = 0;
            return;
        }
        try {
            const [user] = await this.orm.read("res.users", [dmId], ["shahtaj_dm_wallet_balance"]);
            const balance = user?.shahtaj_dm_wallet_balance || 0;
            this.state.settleModal.walletBalance = balance;
            this.state.settleModal.amount = balance;
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        }
    }

    closeSettle() {
        this.state.settleModal.open = false;
        this.state.settleModal.wizardId = null;
    }

    async confirmSettle() {
        const dmId = parseInt(this.state.settleModal.dmId, 10);
        if (!dmId) {
            this.notification.add("Select a delivery man to settle.", { type: "warning" });
            return;
        }
        const journalId = parseInt(this.state.settleModal.bankJournalId, 10);
        if (!journalId) {
            this.notification.add("Select a deposit journal.", { type: "warning" });
            return;
        }
        this.state.settleModal.saving = true;
        try {
            const wizardIds = await this.orm.create(
                "shahtaj.dm.wallet.settle",
                [{}],
                { context: { default_delivery_man_id: dmId, active_model: "res.users", active_id: dmId } },
            );
            const wizardId = Array.isArray(wizardIds) ? wizardIds[0] : wizardIds;
            await this.orm.write("shahtaj.dm.wallet.settle", [wizardId], {
                delivery_man_id: dmId,
                amount: Number(this.state.settleModal.amount) || 0,
                bank_journal_id: journalId,
                notes: this.state.settleModal.notes || "",
            });
            await this.orm.call("shahtaj.dm.wallet.settle", "action_confirm", [[wizardId]]);
            this.notification.add("Wallet settled.", { type: "success" });
            this.closeSettle();
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || error.message, { type: "danger" });
        } finally {
            this.state.settleModal.saving = false;
        }
    }

    // --- NAVIGATION & FILTERS ---

    setSubTab(tabName) {
        if (tabName === 'all_deliveries') {
            tabName = 'deliveries';
            this.state.deliveriesSubTab = 'jobs';
        }
        this.state.activeSubTab = tabName;

        // If we are programmatically jumping to a record, protect the view from being cleared
        if (this._preserveDetailsOnSwitch) {
            this._preserveDetailsOnSwitch = false;
        } else {
            this.state.selectedOrder = null;
            this.state.selectedCheckin = null;
            this.state.selectedSchedule = null;
            this.state.selectedTarget = null;
            this.state.selectedDmJob = null;
            this.state.selectedSettlement = null;
            this.state.selectedRecovery = null;
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
            dispatch:   { search: '' },
            dm_jobs:    { search: '', dm: 'all', dateFrom: '', dateTo: '', state: 'all', field_state: 'all', assignment_mode: 'all' },
            sessions:   { dm: 'all', dateFrom: '', dateTo: '' },
            collections:{ search: '', dm: 'all', dateFrom: '', dateTo: '' },
            settlements:{ search: '', dm: 'all', dateFrom: '', dateTo: '' },
                        checkins:   { search: '', status: '', purpose: this.props.requestedCheckinPurpose || 'all', booker: 'all', date: this.props.requestedCheckinDate || '', role: this.props.requestedCheckinRole || 'all' },
            orders:     { search: '', status: '', booker: 'all' },
            verification: { search: '', booker: 'all', reason: 'all' },
            schedules:  { booker: 'all', date: '' },
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
        if (tabName === 'deliveries') {
            this.state.selectedDelivery = null;
            this.state.selectedDmJob = null;
            this.state.selectedSettlement = null;
            this.state.selectedRecovery = null;
            this.state.deliveriesSubTab = this.props.requestedDeliveriesSubTab === 'manual'
                ? 'dispatch'
                : (this.props.requestedDeliveriesSubTab || 'dispatch');
            this.state.filters.dispatch = { search: '' };
            this.state.filters.dm_jobs = { search: '', dm: 'all', dateFrom: '', dateTo: '', state: 'all', field_state: 'all', assignment_mode: 'all' };
            this.state.filters.sessions = { dm: 'all', dateFrom: '', dateTo: '' };
            this.state.filters.collections = { search: '', dm: 'all', dateFrom: '', dateTo: '' };
            this.state.filters.settlements = { search: '', dm: 'all', dateFrom: '', dateTo: '' };
            this.state.pagination.dispatch.page = 1;
            this.state.pagination.dm_jobs.page = 1;
            this.state.pagination.sessions.page = 1;
            this.state.pagination.collections.page = 1;
            this.state.pagination.settlements.page = 1;
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
        await this._refreshPostedInvoiceFlag(this.state.selectedOrder, order.odoo_id);
        
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
        await this.loadSaleOrderCatalog();
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
            line.qty_available = null;
            line.uom_name = '';
            return;
        }
        line.price = product.list_price || 0;
        line.tax_id = product.tax_id ? String(product.tax_id) : '';
        line.qty_available = product.qty_available || 0;
        line.uom_name = product.uom_name || '';
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
            const requestedByProduct = {};
            const orderLines = [];
            for (const line of form.lines) {
                if (!line.product_id) {
                    this.notification.add("Please select a product for every order line.", { type: "warning" });
                    this.state.isSavingSaleOrder = false;
                    return;
                }
                const product = this.state.saleProducts.find((p) => String(p.id) === String(line.product_id));
                const requested = parseFloat(line.qty) || 0;
                const productKey = String(line.product_id);
                requestedByProduct[productKey] = (requestedByProduct[productKey] || 0) + requested;
                const onHand = product?.qty_available;
                if (product && onHand != null && requestedByProduct[productKey] > onHand) {
                    this.notification.add(
                        `Not enough stock for "${product.name}". On hand: ${this._formatQty(onHand)} ${product.uom_name || 'Units'}, requested: ${this._formatQty(requestedByProduct[productKey])}.`,
                        { type: "danger" }
                    );
                    this.state.isSavingSaleOrder = false;
                    return;
                }
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

    showConfirm(title, message, onConfirmCallback) {
        this.state.confirmModal = {
            isOpen: true,
            title,
            message,
            onConfirm: async () => {
                this.state.confirmModal.isOpen = false;
                if (onConfirmCallback) await onConfirmCallback();
            },
        };
    }

    closeConfirm() {
        this.state.confirmModal.isOpen = false;
    }

    requestCancelOrder(row) {
        if (!this.canCancelOrder(row) || this.state.isCancellingOrder) return;
        this.showConfirm(
            "Cancel Order",
            `Cancel ${row.id}? Cancelled orders cannot be invoiced or delivered.`,
            () => this.cancelLiveOrder(row),
        );
    }

    async cancelLiveOrder(row) {
        if (!this.canCancelOrder(row) || this.state.isCancellingOrder) return;
        this.state.isCancellingOrder = true;
        try {
            await this.orm.call("sale.order", "action_shahtaj_cancel_order", [[row.odoo_id]]);
            this.notification.add("Order cancelled. It cannot be invoiced or delivered.", { type: "success" });
            if (this.state.selectedOrder && this.state.selectedOrder.odoo_id === row.odoo_id) {
                this.state.selectedOrder = null;
            }
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(error.data?.message || "Failed to cancel order.", { type: "danger" });
        } finally {
            this.state.isCancellingOrder = false;
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
            isDeliveryCheckin: !!log.isDeliveryCheckin,
            hasOrder: !!log.hasOrder,
            orderLabel: log.orderLabel || this._gpsCheckinOutcome(log, log.hasOrder).orderLabel,
            endTime: log.endTime || '',
            visitOutcome: log.orderLabel || '',
        };
        let visitId = this._m2oId(log.visit_id);
        const taskId = this._m2oId(log.visit_task_id);
        const dmId = this._m2oId(log.dm_delivery_id);
        const visitFields = [
            'started_at', 'ended_at', 'outcome', 'state', 'sale_order_id',
            'notes', 'duration_minutes', 'dm_delivery_id',
        ];
        try {
            if (!visitId && taskId) {
                const found = await this.orm.searchRead(
                    'shahtaj.visit',
                    [['visit_task_id', '=', taskId]],
                    visitFields,
                    { limit: 1, order: 'id desc' },
                );
                if (found.length) visitId = found[0].id;
            }
            if (!visitId && dmId) {
                const found = await this.orm.searchRead(
                    'shahtaj.visit',
                    [['dm_delivery_id', '=', dmId]],
                    visitFields,
                    { limit: 1, order: 'id desc' },
                );
                if (found.length) visitId = found[0].id;
            }
            let visit = null;
            if (visitId) {
                const visits = await this.orm.read('shahtaj.visit', [visitId], visitFields);
                visit = visits[0] || null;
            }
            let job = null;
            if (dmId) {
                const jobs = await this.orm.read(
                    'shahtaj.dm.delivery',
                    [dmId],
                    ['picked_at', 'delivered_at'],
                );
                job = jobs[0] || null;
            }
            if (this.state.selectedCheckin && this.state.selectedCheckin.id === log.id) {
                const timing = this._checkinTiming(visit, job);
                this.state.selectedCheckin.endTime = timing.endTime;
                this.state.selectedCheckin.duration = timing.duration;
            }
            if (visit && this.state.selectedCheckin && this.state.selectedCheckin.id === log.id) {
                const v = visit;
                let visitOutcome = v.outcome || '';
                const isDelivery = this._gpsIsDeliveryCheckin(log);
                if (v.state === 'in_progress') visitOutcome = 'In Progress';
                else if (v.state === 'completed' && v.outcome === 'incomplete') visitOutcome = 'Incomplete / Auto-Skipped';
                else if (v.state === 'completed') {
                    if (isDelivery) visitOutcome = v.outcome === 'order' ? 'Delivered' : 'No Delivery';
                    else visitOutcome = v.outcome === 'order' ? 'Order Placed' : 'No Order';
                }
                else if (v.state === 'cancelled') visitOutcome = 'Cancelled';

                const visitNotes = (v.notes || '').trim();
                if (visitNotes) this.state.selectedCheckin.notes = visitNotes;
                this.state.selectedCheckin.sale_order_id = v.sale_order_id || this.state.selectedCheckin.sale_order_id || false;
                const outcome = this._gpsCheckinOutcome(
                    this.state.selectedCheckin,
                    Boolean(this._m2oId(this.state.selectedCheckin.sale_order_id)),
                );
                this.state.selectedCheckin.isDeliveryCheckin = outcome.isDeliveryCheckin;
                this.state.selectedCheckin.hasOrder = outcome.hasOrder;
                this.state.selectedCheckin.orderLabel = outcome.orderLabel;
                this.state.selectedCheckin.visitOutcome = visitOutcome;
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
        if (!this.canCreateInvoice(this.state.selectedOrder)) {
            this.notification.add("Cancelled orders cannot be invoiced.", { type: "warning" });
            return;
        }
        this.state.isCreatingInvoice = true;
        
        try {
            await this.invoiceSaleOrder(this.state.selectedOrder.odoo_id);
            this.notification.add("Invoice created and posted. You can assign a delivery man.", {
                title: "Success",
                type: "success",
            });
            await this._refreshPostedInvoiceFlag(this.state.selectedOrder, this.state.selectedOrder.odoo_id);
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
