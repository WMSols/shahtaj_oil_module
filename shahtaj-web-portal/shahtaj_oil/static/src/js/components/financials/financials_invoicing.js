/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess } from "../../shahtaj_access";
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
    };

    setup() {
        this.orm = useService("orm");
        const resolved = resolveFinancialTab(this.props.requestedSubTab);
        this.state = useState({
            activeSubTab: resolved.activeSubTab,
            invoiceSubTab: resolved.invoiceSubTab,
            poSubTab: resolved.poSubTab,
            creditSubView: resolved.creditSubView,
            cashDirection: takePendingCashDirection(),
            stats: { ...EMPTY_STATS },
            isRefreshing: false,
            refreshNonce: 0,
        });

        onWillUpdateProps((nextProps) => {
            if (!nextProps.requestedSubTab || nextProps.requestedSubTab === this.props.requestedSubTab) {
                return;
            }
            this.applyResolvedTab(resolveFinancialTab(nextProps.requestedSubTab));
        });

        onWillStart(async () => {
            if (!hasFinancialAccess()) {
                return;
            }
            this.state.stats = await getFinancialStats(this.orm);
        });
    }

    applyResolvedTab(resolved) {
        this.state.activeSubTab = resolved.activeSubTab;
        this.state.invoiceSubTab = resolved.invoiceSubTab;
        this.state.poSubTab = resolved.poSubTab;
        this.state.creditSubView = resolved.creditSubView;
        if (resolved.activeSubTab === "cash") {
            this.state.cashDirection = takePendingCashDirection();
        }
    }

    async onStatsRefresh() {
        this.state.stats = await getFinancialStats(this.orm, { force: true });
    }

    async refreshData() {
        this.state.isRefreshing = true;
        try {
            invalidateFinancialCache();
            this.state.stats = await getFinancialStats(this.orm, { force: true });
            this.state.refreshNonce += 1;
        } finally {
            this.state.isRefreshing = false;
        }
    }
}

FinancialsInvoicing.template = "shahtaj_oil.FinancialsInvoicing";
