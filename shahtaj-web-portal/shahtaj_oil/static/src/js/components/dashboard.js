/** @odoo-module **/

import { Component, useState, onWillStart, onWillUnmount, useRef, useEffect } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { registry } from "@web/core/registry";
import { loadBundle, loadJS } from "@web/core/assets";
import { hasFinancialAccess, notifyPortalBusy, resetPortalBusy } from "../shahtaj_access";
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
        const today = new Date();
        this.todayStr = this._formatDate(today);

        this.state = useState({
            activeTab: 'overview', // Default to the new Master Overview
            activeSubTab: '',
            staffRole: 'order_booker',
            deliveriesSubTab: '',
            checkinPurpose: 'all',
            checkinRole: 'all',
            checkinDate: '', 
            isSidebarOpen: false, 
            isSwitchingTab: false,
            isSidebarLocked: false,
            isLoadingKpis: false,
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
            this.state.checkinPurpose = ev.detail.checkinPurpose || 'all';
            this.state.checkinRole = ev.detail.checkinRole || 'all';
            this.state.checkinDate = ev.detail.checkinDate || '';
            this.switchTab(ev.detail.tab, ev.detail.subTab);
        });
        onWillStart(async () => {
            const chartPromise = this.hasFinancialAccess ? this.ensureChartJs() : Promise.resolve();
            await Promise.all([this.fetchMasterKPIs(), chartPromise]);
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
        this._onPortalBusy = (ev) => {
            this.state.isSidebarLocked = Boolean(ev.detail?.busy);
        };
        window.addEventListener("shahtaj-portal-busy", this._onPortalBusy);
        onWillUnmount(() => {
            window.removeEventListener("shahtaj-portal-busy", this._onPortalBusy);
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

    /**
     * Convert a Pakistan calendar date (YYYY-MM-DD) to Odoo UTC naive bounds.
     * PKT day 2026-08-19 is 2026-08-18 19:00:00 UTC through 2026-08-19 18:59:59 UTC.
     */
    _pktDateToUtcBounds(dateStr) {
        const start = new Date(`${dateStr}T00:00:00+05:00`);
        const end = new Date(`${dateStr}T23:59:59+05:00`);
        const toOdooUtc = (d) => d.toISOString().slice(0, 19).replace("T", " ");
        return { start: toOdooUtc(start), end: toOdooUtc(end) };
    }

    _shopRegDomain(dateStr) {
        const bounds = this._pktDateToUtcBounds(dateStr || this.todayStr);
        return [
            ["is_shahtaj_shop", "=", true],
            ["registered_by_id", "!=", false],
            ["registered_by_id.shahtaj_is_order_booker", "=", true],
            ["create_date", ">=", bounds.start],
            ["create_date", "<=", bounds.end],
        ];
    }

    _parseDayKey(value) {
        if (!value) {
            return "";
        }
        return String(value).slice(0, 10);
    }

    _buildDayKeys(fromStr, toStr) {
        const keys = [];
        const cursor = new Date(`${fromStr}T00:00:00`);
        const end = new Date(`${toStr}T00:00:00`);
        while (cursor <= end) {
            keys.push(this._formatDate(cursor));
            cursor.setDate(cursor.getDate() + 1);
        }
        return keys;
    }

    _getCashDateRange() {
        const days = this.state.cashRangeDays || 30;
        const to = new Date();
        const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (days - 1));
        return { from: this._formatDate(from), to: this._formatDate(to) };
    }

    _labelForDay(dayKey) {
        const date = new Date(`${dayKey}T00:00:00`);
        return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
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
    
    async fetchMasterKPIs() {
        this.state.isLoadingKpis = true;
        notifyPortalBusy(true);
        const opsBounds = this._pktDateToUtcBounds(this.state.opsDate || this.todayStr);
        const productBaseDomain = [
            ["sale_ok", "=", true],
            ["default_code", "!=", "SHAHTAJ-LEGACY"],
            ["active", "=", true],
        ];

        try {
            const coreCountsPromise = Promise.all([
                this.orm.searchCount("shahtaj.zone", [["active", "=", true]]),
                this.orm.searchCount("shahtaj.route", [["active", "=", true]]),
                this.orm.searchCount("res.partner", [["is_shahtaj_shop", "=", true], ["active", "=", true]]),
                this.orm.searchCount("res.partner", [["is_shahtaj_shop", "=", true], ["active", "=", true], ["shop_approval_state", "=", "pending"]]),
                this.orm.searchCount("res.partner", this._shopRegDomain(this.state.shopRegDate)),
                this.orm.searchCount("res.users", [["shahtaj_is_order_booker", "=", true], ["active", "=", true]]),
                this.orm.searchCount("res.users", [["shahtaj_is_order_booker", "=", true], ["active", "=", true], ["shahtaj_online_status", "=", "online"]]),
                this.orm.searchCount("shahtaj.gps.attempt", [
                    ["purpose", "=", "check_in"],
                    ["create_date", ">=", opsBounds.start],
                    ["create_date", "<=", opsBounds.end],
                ]),
                this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["date_order", ">=", opsBounds.start], ["date_order", "<=", opsBounds.end]]),
                this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["state", "=", "sale"], ["date_order", ">=", opsBounds.start], ["date_order", "<=", opsBounds.end]]),
                this.orm.searchCount("product.template", productBaseDomain),
                this.orm.searchCount("product.template", [...productBaseDomain, ["qty_available", "<=", 0]]),
                this.orm.searchCount("shahtaj.weekly.schedule", [["active", "=", true]]),
                this.orm.searchCount("shahtaj.visit.target", [["active", "=", true]]),
                this.orm.searchCount("res.users", [["shahtaj_is_delivery_man", "=", true], ["active", "=", true]]),
                this.orm.searchCount("res.users", [["shahtaj_is_delivery_man", "=", true], ["active", "=", true], ["shahtaj_online_status", "=", "online"]]),
                this.orm.searchCount("shahtaj.dm.delivery", [["scheduled_date", "=", this.state.opsDate], ["state", "!=", "not_ready"]]),
                this.orm.searchCount("shahtaj.dm.delivery", [["scheduled_date", "=", this.state.opsDate], ["field_state", "=", "in_transit"]]),
                this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["state", "=", "sale"]]),
                this.orm.searchCount("shahtaj.dm.delivery", [["state", "in", ["ready", "picked", "partial"]]]),
                this.orm.searchCount("shahtaj.dm.delivery", [["field_state", "=", "in_transit"]]),
                this.orm.searchCount("sale.order", [["state", "in", ["sale", "done"]], ["shahtaj_delivery_status", "in", ["pending", "partial"]]]),
            ]);

            const financialPromise = this.hasFinancialAccess
                ? this.fetchFinancialOverview()
                : Promise.resolve({
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
                });

            const [coreCounts, financial] = await Promise.all([coreCountsPromise, financialPromise]);

            const [
                zones, routes, shops, pendingShops, shopsRegisteredByOb,
                totalBookers, onlineBookers,
                todayCheckins, todayOrders, todayDeliveries,
                totalProducts, outOfStockProducts,
                activeSchedules, activeTargets,
                totalDeliveryMen, onlineDeliveryMen,
                dmJobsToday, todayInTransit,
                pendingDeliveries, dmJobsActive, dmInTransit, ordersToDispatch,
            ] = coreCounts;

            Object.assign(this.state.kpis, {
                totalZones: zones,
                totalRoutes: routes,
                totalShops: shops,
                pendingShops: pendingShops,
                shopsRegisteredByOb,
                totalBookers,
                onlineBookers,
                todayCheckins,
                todayOrders,
                todayDeliveries,
                todayInTransit,
                pendingDeliveries,
                totalProducts,
                outOfStockProducts,
                activeSchedules,
                activeTargets,
                totalDeliveryMen,
                onlineDeliveryMen,
                dmJobsToday,
                dmJobsActive,
                dmInTransit,
                ordersToDispatch,
                ...financial,
            });
        } catch (error) {
            console.error("Failed to fetch Master KPIs", error);
        } finally {
            this.state.isLoadingKpis = false;
            notifyPortalBusy(false);
        }
    }

    async fetchFinancialOverview() {
        const { from, to } = this._getCashDateRange();
        const dayKeys = this._buildDayKeys(from, to);
        const byDay = {};
        for (const key of dayKeys) {
            byDay[key] = { cashIn: 0, cashOut: 0 };
        }

        const paymentDomain = [
            ["journal_id.type", "in", ["bank", "cash"]],
            ["date", ">=", from],
            ["date", "<=", to],
            ["state", "in", ["paid", "in_process", "posted", "reconciled"]],
        ];

        const [
            totalOrders,
            toInvoice,
            openInvoices,
            creditNotes,
            vendorBills,
            payments,
            shopsData,
        ] = await Promise.all([
            this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false]]),
            this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["invoice_status", "=", "to invoice"]]),
            this.orm.searchCount("account.move", [["move_type", "in", ["out_invoice"]], ["partner_id.is_shahtaj_shop", "=", true], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]]),
            this.orm.searchCount("account.move", [["move_type", "=", "out_refund"], ["partner_id.is_shahtaj_shop", "=", true]]),
            this.orm.searchCount("account.move", [["move_type", "in", ["in_invoice", "in_refund"]], ["state", "in", ["draft", "posted"]]]),
            this.orm.searchRead("account.payment", paymentDomain, ["date", "amount", "amount_signed", "payment_type"], { limit: 10000 }),
            this.orm.searchRead("res.partner", [["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]], ["outstanding_balance"], { limit: 10000 }),
        ]);

        let cashIn = 0;
        let cashOut = 0;
        for (const payment of payments || []) {
            const amount = Math.abs(payment.amount_signed || payment.amount || 0);
            const day = this._parseDayKey(payment.date);
            if (payment.payment_type === "outbound") {
                cashOut += amount;
                if (byDay[day]) {
                    byDay[day].cashOut += amount;
                }
            } else {
                cashIn += amount;
                if (byDay[day]) {
                    byDay[day].cashIn += amount;
                }
            }
        }

        const stillOwed = (shopsData || []).reduce((sum, shop) => sum + (shop.outstanding_balance || 0), 0);

        return {
            totalOrders,
            toInvoice,
            openInvoices,
            creditNotes,
            vendorBills,
            cashIn,
            cashOut,
            netCash: cashIn - cashOut,
            stillOwed,
            cashTrend: {
                labels: dayKeys.map((key) => this._labelForDay(key)),
                cashIn: dayKeys.map((key) => byDay[key].cashIn),
                cashOut: dayKeys.map((key) => byDay[key].cashOut),
            },
        };
    }

    async onOpsDateChange(ev) {
        const dateStr = ev.target.value;
        if (!dateStr || dateStr === this.state.opsDate) {
            return;
        }
        this.state.opsDate = dateStr;
        const opsBounds = this._pktDateToUtcBounds(dateStr);
        try {
            const [todayCheckins, todayOrders, todayDeliveries, dmJobsToday, todayInTransit] = await Promise.all([
                this.orm.searchCount("shahtaj.gps.attempt", [
                    ["purpose", "=", "check_in"],
                    ["create_date", ">=", opsBounds.start],
                    ["create_date", "<=", opsBounds.end],
                ]),
                this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["date_order", ">=", opsBounds.start], ["date_order", "<=", opsBounds.end]]),
                this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["state", "=", "sale"], ["date_order", ">=", opsBounds.start], ["date_order", "<=", opsBounds.end]]),
                this.orm.searchCount("shahtaj.dm.delivery", [["scheduled_date", "=", dateStr], ["state", "!=", "not_ready"]]),
                this.orm.searchCount("shahtaj.dm.delivery", [["scheduled_date", "=", dateStr], ["field_state", "=", "in_transit"]]),
            ]);
            Object.assign(this.state.kpis, {
                todayCheckins,
                todayOrders,
                todayDeliveries,
                dmJobsToday,
                todayInTransit,
            });
        } catch (error) {
            console.error("Failed to fetch field activity counts", error);
        }
    }

    async onShopRegDateChange(ev) {
        const dateStr = ev.target.value;
        if (!dateStr || dateStr === this.state.shopRegDate) {
            return;
        }
        this.state.shopRegDate = dateStr;
        try {
            this.state.kpis.shopsRegisteredByOb = await this.orm.searchCount(
                "res.partner",
                this._shopRegDomain(dateStr),
            );
        } catch (error) {
            console.error("Failed to fetch shop registration count", error);
        }
    }

    async setCashRangeDays(days) {
        if (this.state.cashRangeDays === days) {
            return;
        }
        this.state.cashRangeDays = days;
        await this.fetchMasterKPIs();
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
        if (!this.hasFinancialAccess || this.state.activeTab !== "overview" || this.state.isSwitchingTab) {
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
        const kpis = this.state.kpis;
        return kpis.pendingShops > 0
            || kpis.pendingDeliveries > 0
            || kpis.ordersToDispatch > 0
            || kpis.dmInTransit > 0
            || kpis.outOfStockProducts > 0
            || (this.hasFinancialAccess && kpis.toInvoice > 0);
    }

    openStaff(role = 'order_booker') {
        this.state.staffRole = role;
        this.switchTab('staff');
    }

    openDeliveries(subTab = 'dispatch') {
        const forceBusy = this.state.activeTab === 'operations'
            && this.state.activeSubTab === 'deliveries'
            && this.state.deliveriesSubTab !== subTab;
        this.state.deliveriesSubTab = subTab;
        this.switchTab('operations', 'deliveries', { forceBusy });
    }

    openCheckins() {
        this.state.checkinPurpose = 'all';
        this.state.checkinRole = 'all';
        this.state.checkinDate = '';
        this.switchTab('operations', 'checkins');
    }

    openTodayCheckins() {
        this.state.checkinPurpose = 'check_in';
        this.state.checkinRole = 'all';
        this.state.checkinDate = this.state.opsDate || this.todayStr;
        this.switchTab('operations', 'checkins');
    }

    async toggleMenu(menuName, defaultSubTab = '') {
        if (this.state.isSwitchingTab) {
            return;
        }
        const isCurrentlyOpen = this.state.expandedMenus[menuName];
        
        // 1. Close ALL menus first (Exclusive Accordion Logic)
        for (let key in this.state.expandedMenus) {
            this.state.expandedMenus[key] = false;
        }
        
        // 2. Toggle the specific menu that was clicked
        this.state.expandedMenus[menuName] = !isCurrentlyOpen;
        
        // 3. If opening, yield to the browser instantly so the accordion animation starts, THEN switch tabs
        if (this.state.expandedMenus[menuName]) {
            await new Promise(resolve => setTimeout(resolve, 10));
            await this.switchTab(menuName, defaultSubTab); 
        }
    }
    async switchTab(tabName, subTabName = '', options = {}) {
        if (this.state.isSwitchingTab) {
            return;
        }
        if (tabName === 'staff' && !this.state.staffRole) {
            this.state.staffRole = 'order_booker';
        }
        if (tabName === 'operations' && subTabName === 'all_deliveries') {
            subTabName = 'deliveries';
            this.state.deliveriesSubTab = 'jobs';
        }
        if (tabName === 'operations' && subTabName === 'deliveries' && !this.state.deliveriesSubTab) {
            this.state.deliveriesSubTab = 'dispatch';
        }
        if (!this.hasFinancialAccess && (tabName === 'financials' || tabName === 'transactions' || tabName === 'accounting')) {
            tabName = 'operations';
            subTabName = 'checkins';
        }
        if (!this.hasFinancialAccess && tabName === 'warehouse' && ['inventory', 'taxes'].includes(subTabName)) {
            subTabName = 'management';
        }

        const sameTab = this.state.activeTab === tabName;
        const sameSub = sameTab && (this.state.activeSubTab || '') === (subTabName || '');
        if (sameSub && !options.forceBusy) {
            for (let key in this.state.expandedMenus) {
                this.state.expandedMenus[key] = false;
            }
            if (this.state.expandedMenus[tabName] !== undefined) {
                this.state.expandedMenus[tabName] = true;
            }
            this.state.isSidebarOpen = false;
            return;
        }

        notifyPortalBusy(true);
        try {
            if (sameTab) {
                this.state.activeSubTab = subTabName;
                for (let key in this.state.expandedMenus) {
                    this.state.expandedMenus[key] = false;
                }
                if (this.state.expandedMenus[tabName] !== undefined) {
                    this.state.expandedMenus[tabName] = true;
                }
                this.state.isSidebarOpen = false;
                await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 10)));
                return;
            }

            this.state.isSwitchingTab = true;
            await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 10)));

            this.state.activeTab = tabName;
            this.state.activeSubTab = subTabName;

            for (let key in this.state.expandedMenus) {
                this.state.expandedMenus[key] = false;
            }
            if (this.state.expandedMenus[tabName] !== undefined) {
                this.state.expandedMenus[tabName] = true;
            }
            this.state.isSidebarOpen = false;

            await new Promise((resolve) => setTimeout(resolve, 10));

            if (tabName === 'overview') {
                await this.fetchMasterKPIs();
            }
        } finally {
            this.state.isSwitchingTab = false;
            resetPortalBusy();
        }
    }
    toggleSidebar() {
        if (this.state.isSwitchingTab) {
            return;
        }
        this.state.isSidebarOpen = !this.state.isSidebarOpen;
    }
}

ShahtajDashboard.template = "shahtaj_oil.DashboardViewTemplate";
registry.category("actions").add("shahtaj_dashboard_tag", ShahtajDashboard);
