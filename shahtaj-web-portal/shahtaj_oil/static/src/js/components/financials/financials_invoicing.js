/** @odoo-module **/

import { Component, useState, onMounted, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { canSee, hasFinancialAccess, loadPortalAccess } from "../../shahtaj_access";
import { MoneyOverview } from "./money_overview";
import { CashActivity } from "./cash_activity";
import { InvoiceManagement } from "./invoice_management";
import { PoManagement } from "./po_management";
import { CreditControl } from "./credit_control";
import { TaxLedger } from "./tax_ledger";
import { Expenses } from "./expenses";
import { Pnl } from "./pnl";
import {
    EMPTY_STATS,
    getFinancialStats,
    invalidateFinancialCache,
    resolveFinancialTab,
} from "./financials_cache";
import { takePendingCashDirection } from "./po_prefill";

export class FinancialsInvoicing extends Component {
    static components = {
        MoneyOverview,
        CashActivity,
        InvoiceManagement,
        PoManagement,
        CreditControl,
        TaxLedger,
        Expenses,
        Pnl,
    };
    static props = {
        requestedSubTab: { type: String, optional: true },
        requestedInvoiceStatus: { type: String, optional: true },
        requestedCashDirection: { type: String, optional: true },
        requestedCashDateFrom: { type: String, optional: true },
        requestedCashDateTo: { type: String, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        const resolved = resolveFinancialTab(this.props.requestedSubTab);
        const cash = this._cashNav(this.props);
        this.state = useState({
            activeSubTab: resolved.activeSubTab,
            invoiceSubTab: resolved.invoiceSubTab,
            poSubTab: resolved.poSubTab,
            creditSubView: resolved.creditSubView,
            cashDirection: cash.direction,
            cashDateFrom: cash.dateFrom,
            cashDateTo: cash.dateTo,
            invoiceStatus: this.props.requestedInvoiceStatus || "all",
            stats: { ...EMPTY_STATS },
            isLoadingStats: true,
            isRefreshing: false,
            refreshNonce: 0,
        });

        onWillUpdateProps((nextProps) => {
            const subChanged = nextProps.requestedSubTab && nextProps.requestedSubTab !== this.props.requestedSubTab;
            if (subChanged) {
                this.applyResolvedTab(resolveFinancialTab(nextProps.requestedSubTab));
            }
            const directionChanged = (nextProps.requestedCashDirection || "all") !== (this.props.requestedCashDirection || "all");
            const datesChanged = (nextProps.requestedCashDateFrom || "") !== (this.props.requestedCashDateFrom || "")
                || (nextProps.requestedCashDateTo || "") !== (this.props.requestedCashDateTo || "");
            const openingCash = subChanged && resolveFinancialTab(nextProps.requestedSubTab).activeSubTab === "cash";
            if (openingCash || directionChanged || datesChanged) {
                const cash = openingCash ? this._cashNav(nextProps) : {
                    direction: nextProps.requestedCashDirection || "all",
                    dateFrom: nextProps.requestedCashDateFrom || "",
                    dateTo: nextProps.requestedCashDateTo || "",
                };
                this.state.cashDirection = cash.direction;
                this.state.cashDateFrom = cash.dateFrom;
                this.state.cashDateTo = cash.dateTo;
            }
            this.state.invoiceStatus = nextProps.requestedInvoiceStatus || "all";
        });

        onMounted(() => {
            this._loadHeaderStats();
        });
    }

    async _loadHeaderStats() {
        await loadPortalAccess();
        if (!hasFinancialAccess() && !canSee("financials", "invoices")) {
            this.state.isLoadingStats = false;
            return;
        }
        try {
            this.state.stats = await getFinancialStats(this.orm);
        } catch (error) {
            console.error("Failed to load financial stats", error);
        } finally {
            this.state.isLoadingStats = false;
        }
    }

    _cashNav(props) {
        const pending = takePendingCashDirection();
        const propDirection = props.requestedCashDirection || "all";
        return {
            direction: pending && pending !== "all" ? pending : propDirection,
            dateFrom: props.requestedCashDateFrom || "",
            dateTo: props.requestedCashDateTo || "",
        };
    }

    applyResolvedTab(resolved) {
        this.state.activeSubTab = resolved.activeSubTab;
        this.state.invoiceSubTab = resolved.invoiceSubTab;
        this.state.poSubTab = resolved.poSubTab;
        this.state.creditSubView = resolved.creditSubView;
    }

    async onStatsRefresh() {
        try {
            this.state.stats = await getFinancialStats(this.orm, { force: true });
        } catch (error) {
            console.error("Failed to refresh financial stats", error);
        }
    }

    async refreshData() {
        this.state.isRefreshing = true;
        try {
            invalidateFinancialCache();
            try {
                this.state.stats = await getFinancialStats(this.orm, { force: true });
            } catch (error) {
                console.error("Failed to refresh financial stats", error);
            }
            this.state.refreshNonce += 1;
        } finally {
            this.state.isRefreshing = false;
        }
    }
}

FinancialsInvoicing.template = "shahtaj_oil.FinancialsInvoicing";
