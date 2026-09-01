/** @odoo-module **/

import { Component, useState, onWillStart, onWillUnmount, useRef, useEffect } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { registry } from "@web/core/registry";
import { loadBundle, loadJS } from "@web/core/assets";
import { hasFinancialAccess } from "../shahtaj_access";
import { StaffManagement } from "./staff_management";
import { OperationsTracking } from "./operations_tracking";
import { TerritoryRoutes } from "./territory_routes";
import { WarehouseInventory } from "./warehouse_inventory";
import { FinancialsInvoicing } from "./financials_invoicing";
import { PortalSettings } from "./settings"
import { SchedulesTargets } from "./schedules_targets";
import { BankTransactions } from "./bank_transactions";
import { Accounting } from "./accounting";
import { ConfirmModal } from "./confirm_modal";

export class ShahtajDashboard extends Component {
    static components = { StaffManagement, OperationsTracking, TerritoryRoutes, WarehouseInventory, FinancialsInvoicing, PortalSettings, SchedulesTargets, BankTransactions, Accounting, ConfirmModal }; 

    setup() {
        this.orm = useService("orm");
        this.cashChartRef = useRef("cashChart");
        this.cashChart = null;
        this._cashChartToken = 0;
        const today = new Date();
        const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
        this.todayStr = this._formatDate(today);
        this.tomorrowStr = this._formatDate(tomorrow);

        this.state = useState({
            activeTab: 'overview', // Default to the new Master Overview
            activeSubTab: '', 
            isSidebarOpen: false, 
            isSwitchingTab: false,
            isLoadingKpis: false,
            cashRangeDays: 30,
            // Master KPI State
            kpis: {
                totalZones: 0,
                totalRoutes: 0,
                totalShops: 0,
                pendingShops: 0,
                totalBookers: 0,
                onlineBookers: 0,
                todayCheckins: 0,
                todayOrders: 0,
                pendingDeliveries: 0,
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
                accounting: false,
            }
        });
        // Global Event listnere to sync child component tab switches with the main dashboard state
        window.addEventListener('shahtaj-dashboard-switch', (ev) => {
            this.switchTab(ev.detail.tab, ev.detail.subTab);
        });
        onWillStart(async () => {
            const chartPromise = this.hasFinancialAccess ? this.ensureChartJs() : Promise.resolve();
            await Promise.all([this.fetchMasterKPIs(), chartPromise]);
        });
        useEffect(
            () => {
                this.renderCashChart();
                return () => this.destroyCashChart();
            },
            () => [
                this.state.activeTab,
                this.state.isSwitchingTab,
                this.state.cashRangeDays,
                this.state.kpis.cashIn,
                this.state.kpis.cashOut,
                this.state.kpis.cashTrend.labels.join("|"),
            ]
        );
        onWillUnmount(() => this.destroyCashChart());
        
    }

    _formatDate(d) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
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
        const todayStart = `${this.todayStr} 00:00:00`;
        const tomorrowStart = `${this.tomorrowStr} 00:00:00`;
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
                this.orm.searchCount("res.users", [["shahtaj_is_order_booker", "=", true], ["active", "=", true]]),
                this.orm.searchCount("res.users", [["shahtaj_is_order_booker", "=", true], ["active", "=", true], ["shahtaj_online_status", "=", "online"]]),
                this.orm.searchCount("shahtaj.visit", [["started_at", ">=", todayStart], ["started_at", "<", tomorrowStart]]),
                this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["date_order", ">=", todayStart], ["date_order", "<", tomorrowStart]]),
                this.orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["state", "=", "sale"]]),
                this.orm.searchCount("product.template", productBaseDomain),
                this.orm.searchCount("product.template", [...productBaseDomain, ["qty_available", "<=", 0]]),
                this.orm.searchCount("shahtaj.weekly.schedule", [["active", "=", true]]),
                this.orm.searchCount("shahtaj.visit.target", [["active", "=", true]]),
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
                zones, routes, shops, pendingShops,
                totalBookers, onlineBookers,
                todayCheckins, todayOrders, pendingDeliveries,
                totalProducts, outOfStockProducts,
                activeSchedules, activeTargets,
            ] = coreCounts;

            Object.assign(this.state.kpis, {
                totalZones: zones,
                totalRoutes: routes,
                totalShops: shops,
                pendingShops: pendingShops,
                totalBookers,
                onlineBookers,
                todayCheckins,
                todayOrders,
                pendingDeliveries,
                totalProducts,
                outOfStockProducts,
                activeSchedules,
                activeTargets,
                ...financial,
            });
        } catch (error) {
            console.error("Failed to fetch Master KPIs", error);
        } finally {
            this.state.isLoadingKpis = false;
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

    async renderCashChart() {
        if (!this.hasFinancialAccess || this.state.activeTab !== "overview" || this.state.isSwitchingTab) {
            this.destroyCashChart();
            return;
        }
        const canvas = this.cashChartRef.el;
        if (!canvas) {
            return;
        }
        this._cashChartToken += 1;
        const token = this._cashChartToken;
        const ChartLib = await this.ensureChartJs();
        if (!ChartLib || token !== this._cashChartToken) {
            return;
        }
        this.destroyCashChart();
        const trend = this.state.kpis.cashTrend || { labels: [], cashIn: [], cashOut: [] };
        this.cashChart = new ChartLib(canvas, {
            type: "bar",
            data: {
                labels: trend.labels,
                datasets: [
                    {
                        label: "Cash in",
                        data: trend.cashIn,
                        backgroundColor: "rgba(52, 211, 153, 0.88)",
                        borderRadius: 4,
                        maxBarThickness: 18,
                    },
                    {
                        label: "Cash out",
                        data: trend.cashOut,
                        backgroundColor: "rgba(251, 146, 60, 0.92)",
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
                            color: "#e2e8f0",
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
                        ticks: { color: "#94a3b8", maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
                        grid: { display: false },
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: "#94a3b8",
                            callback: (value) => this.formatMoney(value),
                        },
                        grid: { color: "rgba(255, 255, 255, 0.08)" },
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

    get onlineBookerPct() {
        const total = this.state.kpis.totalBookers;
        if (!total) {
            return 0;
        }
        return Math.round((this.state.kpis.onlineBookers / total) * 100);
    }

    get inStockProducts() {
        return Math.max(0, this.state.kpis.totalProducts - this.state.kpis.outOfStockProducts);
    }

    get hasAttentionItems() {
        const kpis = this.state.kpis;
        return kpis.pendingShops > 0
            || kpis.pendingDeliveries > 0
            || kpis.outOfStockProducts > 0
            || (this.hasFinancialAccess && kpis.toInvoice > 0);
    }

    async toggleMenu(menuName, defaultSubTab = '') {
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
    async switchTab(tabName, subTabName = '') {
        if (!this.hasFinancialAccess && (tabName === 'financials' || tabName === 'transactions' || tabName === 'accounting')) {
            tabName = 'operations';
            subTabName = 'checkins';
        }
        if (!this.hasFinancialAccess && tabName === 'warehouse' && ['inventory', 'taxes'].includes(subTabName)) {
            subTabName = 'management';
        }

        // SMART FIX: If we are already on this main tab, don't unmount! Just change the sub-tab gracefully.
        if (this.state.activeTab === tabName) {
            this.state.activeSubTab = subTabName;
            
            // Manage accordion highlighting
            for (let key in this.state.expandedMenus) {
                this.state.expandedMenus[key] = false;
            }
            if (this.state.expandedMenus[tabName] !== undefined) {
                this.state.expandedMenus[tabName] = true;
            }
            this.state.isSidebarOpen = false;
            return; // Exit early, no unmounting needed!
        }

        // 1. Unmount the heavy components and show the loading screen
        this.state.isSwitchingTab = true;

        // 2. Force the browser to paint the UI before locking the thread
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 10)));

        try {
            this.state.activeTab = tabName;
            this.state.activeSubTab = subTabName;
            
            for (let key in this.state.expandedMenus) {
                this.state.expandedMenus[key] = false;
            }
            if (this.state.expandedMenus[tabName] !== undefined) {
                this.state.expandedMenus[tabName] = true;
            }
            this.state.isSidebarOpen = false;

            // 3. Yield once more so Owl can begin mounting the new component
            await new Promise(resolve => setTimeout(resolve, 10));

            if (tabName === 'overview') {
                await this.fetchMasterKPIs();
            }
        } finally {
            // 4. Remove the loading screen
            this.state.isSwitchingTab = false;
        }
    }
    toggleSidebar() {
        this.state.isSidebarOpen = !this.state.isSidebarOpen;
    }
}

ShahtajDashboard.template = "shahtaj_oil.DashboardViewTemplate";
registry.category("actions").add("shahtaj_dashboard_tag", ShahtajDashboard);
