/** @odoo-module **/

import { Component, useState, onWillStart, onMounted, onWillUnmount, useRef, useEffect } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { registry } from "@web/core/registry";
import { loadBundle, loadJS } from "@web/core/assets";
import {
    canMutate,
    canSee,
    canSeeCard,
    defaultDeliveriesSub,
    defaultHome,
    defaultStaffRole,
    firstAllowedSub,
    hasFinancialAccess,
    loadPortalAccess,
    portalTitle,
    resetPortalBusy,
    showPrices,
} from "../shahtaj_access";
import { cachedRead } from "../shahtaj_read_cache";
import { StaffManagement } from "./staff_management";
import { OperationsTracking } from "./operations/operations_tracking";
import { DeliveryManPerformance } from "./delivery_man_performance";
import { TerritoryRoutes } from "./territory/territory_routes";
import { WarehouseInventory } from "./warehouse_inventory";
import { FinancialsInvoicing } from "./financials/financials_invoicing";
import { PortalSettings } from "./settings"
import { SchedulesTargets } from "./schedules_targets";
import { BankTransactions } from "./bank_transactions";
import { Accounting } from "./accounting";
import { FieldReports } from "./field_reports";
import { ConfirmModal } from "./confirm_modal";

export class ShahtajDashboard extends Component {
    static components = { StaffManagement, OperationsTracking, DeliveryManPerformance, TerritoryRoutes, WarehouseInventory, FinancialsInvoicing, PortalSettings, SchedulesTargets, BankTransactions, Accounting, FieldReports, ConfirmModal }; 

    setup() {
        this.orm = useService("orm");
        this.cashChartRef = useRef("cashChart");
        this.cashChart = null;
        this._cashChartToken = 0;
        this._kpiLoadToken = 0;
        this._navToken = 0;
        const today = new Date();
        this.todayStr = this._formatDate(today);

        this.state = useState({
            activeTab: 'overview', // Default to the new Master Overview
            activeSubTab: '',
            renderedTab: 'overview',
            renderedSubTab: '',
            staffRole: 'order_booker',
            deliveriesSubTab: '',
            checkinPurpose: 'all',
            checkinRole: 'all',
            checkinDate: '',
            shopStatus: 'all',
            shopRegisteredOn: '',
            shopRegistrar: 'all',
            staffStatus: 'all',
            stockStatus: 'all',
            orderDate: '',
            dispatchDate: '',
            dmDate: '',
            dmFieldState: 'all',
            dmState: 'all',
            invoiceStatus: 'all',
            cashDirection: 'all',
            cashDateFrom: '',
            cashDateTo: '', 
            isSidebarOpen: false, 
            isSwitchingTab: false,
            isSidebarLocked: false,
            isLoadingKpis: false,
            isLoadingOps: false,
            isLoadingCash: false,
            cashRangeDays: 30,
            shopRegDate: this.todayStr,
            opsDate: this.todayStr,
            // Master KPI State
            kpis: {
                totalZones: 0,
                totalRoutes: 0,
                totalShops: 0,
                pendingShops: 0,
                shopsRegisteredByOb: 0,
                totalBookers: 0,
                onlineBookers: 0,
                todayCheckins: 0,
                todayOrders: 0,
                todayDeliveries: 0,
                todayInTransit: 0,
                pendingDeliveries: 0,
                totalDeliveryMen: 0,
                onlineDeliveryMen: 0,
                dmJobsToday: 0,
                dmJobsActive: 0,
                dmInTransit: 0,
                ordersToDispatch: 0,
                totalProducts: 0,
                outOfStockProducts: 0,
                activeSchedules: 0,
                activeTargets: 0,
                totalOrders: 0,
                toInvoice: 0,
                openInvoices: 0,
                creditNotes: 0,
                vendorBills: 0,
                cashIn: 0,
                cashOut: 0,
                netCash: 0,
                stillOwed: 0,
                cashTrend: { labels: [], cashIn: [], cashOut: [] },
            },
            // Tracks which accordion menus are currently expanded
            expandedMenus: {
                territory: false,
                warehouse: false,
                operations: false,
                financials: false,
                schedules: false,
                reports: false,
                accounting: false,
            }
        });
        // Global Event listnere to sync child component tab switches with the main dashboard state
        window.addEventListener('shahtaj-dashboard-switch', (ev) => {
            if (ev.detail.staffRole) {
                this.state.staffRole = ev.detail.staffRole;
            }
            if (ev.detail.deliveriesSubTab) {
                this.state.deliveriesSubTab = ev.detail.deliveriesSubTab;
            }
            const filters = {};
            if (ev.detail.checkinPurpose || ev.detail.checkinRole || ev.detail.checkinDate) {
                filters.checkinPurpose = ev.detail.checkinPurpose || 'all';
                filters.checkinRole = ev.detail.checkinRole || 'all';
                filters.checkinDate = ev.detail.checkinDate || '';
            }
            this.switchTab(ev.detail.tab, ev.detail.subTab, { filters });
        });
        onWillStart(async () => {
            await loadPortalAccess();
            this.state.staffRole = defaultStaffRole();
            this.state.deliveriesSubTab = defaultDeliveriesSub();
        });
        onMounted(() => {
            if (this.canSeeCard("financials")) {
                this.ensureChartJs();
            }
            this.fetchMasterKPIs();
        });
        useEffect(
            () => {
                this.renderCashChart();
            },
            () => [
                this.state.activeTab,
                this.state.isSwitchingTab,
                this._cashTrendKey(),
            ]
        );
        this._cursorX = null;
        this._cursorY = null;
        this._cursorHold = null;
        this._cursorReleaseArmed = false;
        this._sawPortalBusy = false;
        this._onCursorPointerMove = (ev) => {
            this._cursorX = ev.clientX;
            this._cursorY = ev.clientY;
            if (this._cursorHold && ev.target !== this._cursorHold) {
                this._cursorHold.style.removeProperty("cursor");
                this._cursorHold = null;
            }
            if (!this._cursorReleaseArmed || this.portalWaitCursor) {
                return;
            }
            this._cursorReleaseArmed = false;
            const style = document.getElementById("so-portal-cursor");
            if (style) {
                style.textContent = "";
            }
        };
        window.addEventListener("pointermove", this._onCursorPointerMove, true);
        useEffect(
            () => {
                if (this.portalWaitCursor) {
                    this._sawPortalBusy = true;
                    this._applyPortalCursor(true);
                    return;
                }
                if (!this._sawPortalBusy) {
                    return;
                }
                this._applyPortalCursor(false);
                const frame = requestAnimationFrame(() => {
                    if (!this.portalWaitCursor) {
                        this._cursorReleaseArmed = true;
                    }
                });
                return () => cancelAnimationFrame(frame);
            },
            () => [this.portalWaitCursor]
        );
        this._onPortalBusy = (ev) => {
            this.state.isSidebarLocked = Boolean(ev.detail?.busy);
        };
        window.addEventListener("shahtaj-portal-busy", this._onPortalBusy);
        onWillUnmount(() => {
            window.removeEventListener("shahtaj-portal-busy", this._onPortalBusy);
            window.removeEventListener("pointermove", this._onCursorPointerMove, true);
            if (this._cursorHold) {
                this._cursorHold.style.removeProperty("cursor");
                this._cursorHold = null;
            }
            document.getElementById("so-portal-cursor")?.remove();
            resetPortalBusy();
            this.destroyCashChart();
        });
        
    }

    _formatDate(d) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    _getCashDateRange() {
        const days = this.state.cashRangeDays || 30;
        const to = new Date();
        const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (days - 1));
        return { from: this._formatDate(from), to: this._formatDate(to) };
    }

    _cashTrendKey() {
        const trend = this.state.kpis.cashTrend || {};
        return [
            (trend.labels || []).join("\u001f"),
            (trend.cashIn || []).join("\u001f"),
            (trend.cashOut || []).join("\u001f"),
        ].join("\u001e");
    }

    formatMoney(value) {
        const amount = Number(value) || 0;
        const abs = Math.abs(amount).toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
        });
        return amount < 0 ? `Rs. -${abs}` : `Rs. ${abs}`;
    }
    
    async fetchMasterKPIs(options = {}) {
        const force = Boolean(options && options.force);
        const token = ++this._kpiLoadToken;
        const opsDate = this.state.opsDate;
        const shopRegDate = this.state.shopRegDate;
        const cashRangeDays = this.state.cashRangeDays;
        this.state.isLoadingKpis = true;
        const key = ["overview", opsDate, shopRegDate, cashRangeDays].join("|");
        try {
            const next = await cachedRead(key, () => this.orm.call(
                "shahtaj.portal.read",
                "shahtaj_portal_overview",
                [opsDate, shopRegDate, cashRangeDays],
            ), { force });
            if (token !== this._kpiLoadToken) {
                return;
            }
            const payload = Object.assign({}, next);
            if (opsDate !== this.state.opsDate) {
                delete payload.todayCheckins;
                delete payload.todayOrders;
                delete payload.todayDeliveries;
                delete payload.dmJobsToday;
                delete payload.todayInTransit;
            }
            if (shopRegDate !== this.state.shopRegDate) {
                delete payload.shopsRegisteredByOb;
            }
            if (cashRangeDays !== this.state.cashRangeDays) {
                delete payload.cashIn;
                delete payload.cashOut;
                delete payload.netCash;
                delete payload.stillOwed;
                delete payload.cashTrend;
            }
            Object.assign(this.state.kpis, payload);
        } catch (error) {
            console.error("Failed to fetch Master KPIs", error);
        } finally {
            if (token === this._kpiLoadToken) {
                this.state.isLoadingKpis = false;
            }
        }
    }

    async onOpsDateChange(ev) {
        const dateStr = ev.target.value;
        if (!dateStr || dateStr === this.state.opsDate) {
            return;
        }
        this.state.opsDate = dateStr;
        this.state.isLoadingOps = true;
        try {
            await this.fetchMasterKPIs();
        } finally {
            this.state.isLoadingOps = false;
        }
    }

    async onShopRegDateChange(ev) {
        const dateStr = ev.target.value;
        if (!dateStr || dateStr === this.state.shopRegDate) {
            return;
        }
        this.state.shopRegDate = dateStr;
        try {
            await this.fetchMasterKPIs();
        } catch (error) {
            console.error("Failed to fetch shop registration count", error);
        }
    }

    async setCashRangeDays(days) {
        if (this.state.cashRangeDays === days) {
            return;
        }
        this.state.cashRangeDays = days;
        this.state.isLoadingCash = true;
        try {
            await this.fetchMasterKPIs();
        } finally {
            this.state.isLoadingCash = false;
        }
    }

    async ensureChartJs() {
        if (window.Chart) {
            return window.Chart.default || window.Chart;
        }
        try {
            await loadBundle("web.chartjs_lib");
        } catch (_error) {
            await loadJS("/web/static/lib/Chart/Chart.js");
        }
        return window.Chart?.default || window.Chart;
    }

    destroyCashChart() {
        if (this.cashChart) {
            this.cashChart.destroy();
            this.cashChart = null;
        }
    }

    _applyCashTrend(chart, trend) {
        chart.data.labels = (trend.labels || []).slice();
        chart.data.datasets[0].data = (trend.cashIn || []).slice();
        chart.data.datasets[1].data = (trend.cashOut || []).slice();
        chart.update();
    }

    async renderCashChart() {
        if (!this.canSeeCard("financials") || this.state.activeTab !== "overview" || this.state.isSwitchingTab) {
            this.destroyCashChart();
            return;
        }
        const canvas = this.cashChartRef.el;
        if (!canvas) {
            return;
        }
        const trend = this.state.kpis.cashTrend || { labels: [], cashIn: [], cashOut: [] };
        if (this.cashChart && this.cashChart.canvas === canvas) {
            this._cashChartToken += 1;
            this._applyCashTrend(this.cashChart, trend);
            return;
        }
        this._cashChartToken += 1;
        const token = this._cashChartToken;
        const ChartLib = await this.ensureChartJs();
        if (!ChartLib || token !== this._cashChartToken || this.cashChartRef.el !== canvas) {
            return;
        }
        this.destroyCashChart();
        this.cashChart = new ChartLib(canvas, {
            type: "bar",
            data: {
                labels: trend.labels,
                datasets: [
                    {
                        label: "Cash in",
                        data: trend.cashIn,
                        backgroundColor: "rgba(250, 204, 21, 0.95)",
                        borderRadius: 4,
                        maxBarThickness: 18,
                    },
                    {
                        label: "Cash out",
                        data: trend.cashOut,
                        backgroundColor: "rgba(29, 78, 216, 0.88)",
                        borderRadius: 4,
                        maxBarThickness: 18,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    legend: {
                        labels: {
                            color: "#1e3a8a",
                            boxWidth: 12,
                            font: { weight: "600" },
                        },
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => `${context.dataset.label}: ${this.formatMoney(context.parsed.y)}`,
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: "#1e40af", maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
                        grid: { display: false },
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: "#1e40af",
                            callback: (value) => this.formatMoney(value),
                        },
                        grid: { color: "rgba(30, 64, 175, 0.12)" },
                    },
                },
            },
        });
    }
    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    get canMutate() {
        return canMutate();
    }

    get showPrices() {
        return showPrices();
    }

    get portalTitle() {
        return portalTitle();
    }

    canSee(tab, subTab = "", inner = "") {
        return canSee(tab, subTab, inner);
    }

    canSeeMenu(tab) {
        return canSee(tab);
    }

    canSeeCard(card) {
        return canSeeCard(card);
    }

    get contentReady() {
        return this.state.renderedTab === this.state.activeTab
            && (this.state.renderedSubTab || "") === (this.state.activeSubTab || "");
    }

    get portalWaitCursor() {
        if (this.state.isSwitchingTab || this.state.isSidebarLocked) {
            return true;
        }
        if (!this.contentReady || this.state.renderedTab !== "overview") {
            return false;
        }
        return this.state.isLoadingKpis
            || this.state.isLoadingOps
            || this.state.isLoadingCash;
    }

    _applyPortalCursor(wait) {
        let style = document.getElementById("so-portal-cursor");
        if (!style) {
            style = document.createElement("style");
            style.id = "so-portal-cursor";
            document.head.appendChild(style);
        }
        this._cursorReleaseArmed = false;
        if (this._cursorHold) {
            this._cursorHold.style.removeProperty("cursor");
            this._cursorHold = null;
        }
        if (wait) {
            style.textContent = "html, html * { cursor: wait !important; }";
            return;
        }
        style.textContent = "html, html * { cursor: default !important; }";
        if (this._cursorX == null) {
            return;
        }
        const hit = document.elementFromPoint(this._cursorX, this._cursorY);
        if (!hit) {
            return;
        }
        hit.style.setProperty("cursor", "default", "important");
        this._cursorHold = hit;
    }

    get showFieldCard() {
        return this.canSeeCard("checkins")
            || this.canSeeCard("orders")
            || this.canSeeCard("dispatch")
            || this.canSeeCard("deliveryJobs");
    }

    get showStaffCard() {
        return this.canSeeCard("staffBookers") || this.canSeeCard("deliveryMen");
    }

    get showMidRow() {
        return this.showStaffCard || this.canSeeCard("warehouse") || this.canSeeCard("schedules");
    }

    get showFinanceRow() {
        return this.canSeeCard("financials") || this.canSeeCard("invoices");
    }

    get overviewSpans() {
        const has = (card) => this.canSeeCard(card);
        const spans = {};
        if (has("territory") && this.showFieldCard) {
            spans.territory = 7;
            spans.field = 5;
        } else if (has("territory")) {
            spans.territory = 12;
        }

        const mid = ["staff", "warehouse", "schedules"].filter((card) => {
            if (card === "staff") return this.showStaffCard;
            return has(card);
        });
        if (mid.length === 3) {
            mid.forEach((card) => { spans[card] = 4; });
        } else if (mid.length === 2) {
            mid.forEach((card) => { spans[card] = 6; });
        } else if (mid.length === 1) {
            spans[mid[0]] = 12;
        }

        if (has("financials") && has("invoices")) {
            spans.financials = 8;
            spans.invoices = 4;
        } else if (has("financials")) {
            spans.financials = 12;
        } else if (has("invoices")) {
            spans.invoices = 12;
        }

        if (this.showFieldCard && !spans.field) {
            const row = ["field"];
            if (mid.length && mid.length < 3) {
                row.push(...mid);
            } else if (!mid.length && has("invoices") && !has("financials")) {
                row.push("invoices");
            }
            const span = Math.floor(12 / row.length);
            const remainder = 12 - span * row.length;
            row.forEach((card, index) => {
                spans[card] = span + (index === row.length - 1 ? remainder : 0);
            });
        }
        return spans;
    }

    overviewSpanClass(card) {
        return `so-ov-span-${this.overviewSpans[card] || 12}`;
    }

    get obMetricColClass() {
        const count = (this.canSeeCard("checkins") ? 1 : 0) + (this.canSeeCard("orders") ? 1 : 0);
        return count <= 1 ? "col-12" : "col-6";
    }

    get dmMetricColClass() {
        const count = (this.canSeeCard("dispatch") ? 1 : 0) + (this.canSeeCard("deliveryJobs") ? 2 : 0);
        if (count <= 1) return "col-12";
        if (count === 2) return "col-6";
        return "col-6 col-sm-4";
    }

    get invoiceMetricColClass() {
        return (this.overviewSpans.invoices || 12) >= 12 ? "col-6 col-xl-3" : "col-6";
    }

    get overviewDateLabel() {
        return new Date().toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
        });
    }

    get isOpsDateToday() {
        return (this.state.opsDate || this.todayStr) === this.todayStr;
    }

    get opsDateLabel() {
        if (this.isOpsDateToday) {
            return "today";
        }
        const date = new Date(`${this.state.opsDate}T00:00:00`);
        return date.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
        });
    }

    get onlineBookerPct() {
        const total = this.state.kpis.totalBookers;
        if (!total) {
            return 0;
        }
        return Math.round((this.state.kpis.onlineBookers / total) * 100);
    }

    get onlineFieldPct() {
        const total = this.state.kpis.totalBookers + this.state.kpis.totalDeliveryMen;
        if (!total) {
            return 0;
        }
        return Math.round(((this.state.kpis.onlineBookers + this.state.kpis.onlineDeliveryMen) / total) * 100);
    }

    get inStockProducts() {
        return Math.max(0, this.state.kpis.totalProducts - this.state.kpis.outOfStockProducts);
    }

    get hasAttentionItems() {
        if (this.state.isLoadingKpis) {
            return false;
        }
        const kpis = this.state.kpis;
        return (this.canSeeCard("territory") && kpis.pendingShops > 0)
            || (this.canSeeCard("deliveryJobs") && kpis.pendingDeliveries > 0)
            || (this.canSeeCard("dispatch") && kpis.ordersToDispatch > 0)
            || (this.canSeeCard("deliveryJobs") && kpis.dmInTransit > 0)
            || (this.canSeeCard("warehouse") && kpis.outOfStockProducts > 0)
            || (this.canSeeCard("invoices") && kpis.toInvoice > 0);
    }

    _applyNavFilters(filters = {}) {
        const next = filters || {};
        this.state.shopStatus = next.shopStatus || 'all';
        this.state.shopRegisteredOn = next.shopRegisteredOn || '';
        this.state.shopRegistrar = next.shopRegistrar || 'all';
        this.state.staffStatus = next.staffStatus || 'all';
        this.state.stockStatus = next.stockStatus || 'all';
        this.state.orderDate = next.orderDate || '';
        this.state.dispatchDate = next.dispatchDate || '';
        this.state.dmDate = next.dmDate || '';
        this.state.dmFieldState = next.dmFieldState || 'all';
        this.state.dmState = next.dmState || 'all';
        this.state.invoiceStatus = next.invoiceStatus || 'all';
        this.state.cashDirection = next.cashDirection || 'all';
        this.state.cashDateFrom = next.cashDateFrom || '';
        this.state.cashDateTo = next.cashDateTo || '';
        this.state.checkinPurpose = next.checkinPurpose || 'all';
        this.state.checkinRole = next.checkinRole || 'all';
        this.state.checkinDate = next.checkinDate || '';
    }

    _opsDay() {
        return this.state.opsDate || this.todayStr;
    }

    openStaff(role = 'order_booker', status = 'all') {
        this.state.staffRole = role;
        this.switchTab('staff', '', { filters: { staffStatus: status } });
    }

    openShops(filters = {}) {
        this.switchTab('territory', 'shops', { filters });
    }

    openRegisteredShops() {
        this.openShops({
            shopRegisteredOn: this.state.shopRegDate || this.todayStr,
            shopRegistrar: 'order_booker',
        });
    }

    openStock(status = 'all') {
        this.switchTab('warehouse', 'management', { filters: { stockStatus: status } });
    }

    openLiveOrders() {
        this.switchTab('operations', 'orders', { filters: { orderDate: this._opsDay() } });
    }

    openDeliveries(subTab = 'dispatch', filters = {}) {
        const forceBusy = this.state.activeTab === 'operations'
            && this.state.activeSubTab === 'deliveries'
            && this.state.deliveriesSubTab !== subTab;
        this.state.deliveriesSubTab = subTab;
        this.switchTab('operations', 'deliveries', { forceBusy, filters });
    }

    openDmOperations() {
        const inner = canSee("operations", "deliveries", "dispatch")
            ? "dispatch"
            : defaultDeliveriesSub();
        this.openDeliveries(inner);
    }

    openToDispatch() {
        this.openDeliveries('dispatch', { dispatchDate: this._opsDay() });
    }

    openDmJobs(extra = {}) {
        this.openDeliveries('jobs', { dmDate: this._opsDay(), ...extra });
    }

    openCheckins() {
        this.switchTab('operations', 'checkins');
    }

    openTodayCheckins() {
        this.switchTab('operations', 'checkins', {
            filters: {
                checkinPurpose: 'check_in',
                checkinRole: 'all',
                checkinDate: this._opsDay(),
            },
        });
    }

    openCash(direction) {
        const { from, to } = this._getCashDateRange();
        this.switchTab('financials', 'cash', {
            filters: {
                cashDirection: direction,
                cashDateFrom: from,
                cashDateTo: to,
            },
        });
    }

    openCustomerInvoices(status = 'all') {
        this.switchTab('financials', 'customer_invoices', { filters: { invoiceStatus: status } });
    }

    toggleMenu(menuName, defaultSubTab = '') {
        const isCurrentlyOpen = this.state.expandedMenus[menuName];
        for (let key in this.state.expandedMenus) {
            this.state.expandedMenus[key] = false;
        }
        this.state.expandedMenus[menuName] = !isCurrentlyOpen;
        if (!this.state.expandedMenus[menuName]) {
            return;
        }
        const sub = (defaultSubTab && canSee(menuName, defaultSubTab))
            ? defaultSubTab
            : firstAllowedSub(menuName);
        this.switchTab(menuName, sub);
    }

    _selectMenu(tabName) {
        for (let key in this.state.expandedMenus) {
            this.state.expandedMenus[key] = false;
        }
        if (this.state.expandedMenus[tabName] !== undefined) {
            this.state.expandedMenus[tabName] = true;
        }
        this.state.isSidebarOpen = false;
    }
    _guardNavigation(tabName, subTabName) {
        if (tabName === 'staff') {
            const role = canSee('staff', this.state.staffRole) ? this.state.staffRole : defaultStaffRole();
            this.state.staffRole = role || defaultStaffRole();
        }
        if (tabName === 'operations' && subTabName === 'all_deliveries') {
            subTabName = 'deliveries';
            this.state.deliveriesSubTab = 'jobs';
        }
        if (tabName === 'operations' && subTabName === 'deliveries') {
            const inner = this.state.deliveriesSubTab || defaultDeliveriesSub();
            this.state.deliveriesSubTab = canSee('operations', 'deliveries', inner)
                ? inner
                : defaultDeliveriesSub();
        }
        const inner = tabName === 'operations' && subTabName === 'deliveries'
            ? this.state.deliveriesSubTab
            : '';
        if (!canSee(tabName, subTabName, inner)) {
            const home = defaultHome();
            return { tabName: home.tab, subTabName: home.sub || '' };
        }
        return { tabName, subTabName };
    }
    _paintSidebarNav(tabName, subTabName = "") {
        const root = this.el;
        if (!root) {
            return;
        }
        const menuStyleActive = "background-color: #0f172a; color: #ffffff;";
        const menuStyleIdle = "color: #4b5563; background-color: transparent;";
        const subStyleActive = "color: #0f172a; background-color: #e2e8f0; font-weight: 700;";
        const subStyleIdle = "color: #6b7280; background-color: transparent;";
        root.querySelectorAll("[data-shahtaj-nav]").forEach((el) => {
            const nav = el.getAttribute("data-shahtaj-nav") || "";
            const isMenu = el.hasAttribute("data-shahtaj-menu");
            const sub = el.getAttribute("data-shahtaj-sub") || "";
            const group = (el.getAttribute("data-shahtaj-sub-group") || "")
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean);
            let active = false;
            if (isMenu) {
                active = nav === tabName;
                el.style.cssText = active ? menuStyleActive : menuStyleIdle;
            } else if (group.length) {
                active = nav === tabName && group.includes(subTabName || "");
                el.style.cssText = active ? subStyleActive : subStyleIdle;
            } else {
                active = nav === tabName && sub === (subTabName || "");
                el.style.cssText = active ? subStyleActive : subStyleIdle;
            }
        });
        // Expand the active menu accordion immediately (before Owl flush).
        root.querySelectorAll(".smooth-accordion").forEach((acc) => {
            const menuBtn = acc.previousElementSibling;
            const nav = menuBtn && menuBtn.getAttribute("data-shahtaj-nav");
            if (nav && nav === tabName) {
                acc.classList.add("open");
            } else if (menuBtn && menuBtn.hasAttribute("data-shahtaj-menu")) {
                acc.classList.remove("open");
            }
        });
    }

    async switchTab(tabName, subTabName = '', options = {}) {
        if (tabName === 'staff' && !this.state.staffRole) {
            this.state.staffRole = defaultStaffRole();
        }
        const guarded = this._guardNavigation(tabName, subTabName);
        tabName = guarded.tabName;
        subTabName = guarded.subTabName || '';

        this._applyNavFilters(options.filters);

        const sameTab = this.state.activeTab === tabName;
        const sameSub = sameTab && (this.state.activeSubTab || '') === subTabName;
        this._selectMenu(tabName);
        if (sameSub && !options.forceBusy) {
            this._paintSidebarNav(tabName, subTabName);
            return;
        }

        this.state.activeTab = tabName;
        this.state.activeSubTab = subTabName;
        this.state.isSwitchingTab = this.state.renderedTab !== tabName
            || (this.state.renderedSubTab || '') !== subTabName;

        // Paint sidebar synchronously before any await / content mount / RPC.
        this._paintSidebarNav(tabName, subTabName);

        const token = ++this._navToken;
        try {
            // Double rAF: first schedules paint, second runs after the browser has painted.
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (token !== this._navToken) {
                return;
            }
            this.state.renderedTab = tabName;
            this.state.renderedSubTab = subTabName;
            if (tabName === 'overview') {
                this.fetchMasterKPIs();
            }
        } finally {
            if (token === this._navToken) {
                this.state.isSwitchingTab = false;
            }
        }
    }
    toggleSidebar() {
        this.state.isSidebarOpen = !this.state.isSidebarOpen;
    }
}

ShahtajDashboard.template = "shahtaj_oil.DashboardViewTemplate";
registry.category("actions").add("shahtaj_dashboard_tag", ShahtajDashboard);
