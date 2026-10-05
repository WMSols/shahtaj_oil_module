/** @odoo-module **/

import { Component, useState, onMounted, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess, notifyPortalBusy } from "../../shahtaj_access";
import { cachedRead } from "../../shahtaj_read_cache";
import { formatDate, requestFinancialTabSwitch } from "./financials_cache";
import { setPendingCashDirection } from "./po_prefill";

export class MoneyOverview extends Component {
    static props = {
        refreshNonce: { type: Number, optional: true },
    };

    setup() {
        this.notification = useService("notification");
        this.orm = useService("orm");
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        this.state = useState({
            activeSubTab: "money",
            money: {
                date_from: formatDate(firstDay),
                date_to: formatDate(today),
                isLoading: true,
                collected: 0, paidOut: 0, netCash: 0, stillOwed: 0,
                openInvoiceAmount: 0, paymentCountIn: 0, paymentCountOut: 0,
            },
        });
        onWillUpdateProps((nextProps) => {
            if (nextProps.refreshNonce !== this.props.refreshNonce) {
                this.loadMoneyOverview({ force: true });
            }
        });
        this._moneyLoadToken = 0;
        onMounted(() => {
            if (!hasFinancialAccess()) {
                this.state.money.isLoading = false;
                return;
            }
            this.loadMoneyOverview();
        });
    }

    requestTabSwitch(tabName, subTabName) {
        requestFinancialTabSwitch(tabName, subTabName);
    }

    openCashActivity(direction = "all") {
        setPendingCashDirection(direction || "all");
        this.requestTabSwitch("financials", "cash");
    }

    openShopBalancesFromMoney() {
        this.requestTabSwitch("financials", "balances");
    }

    openCreditNotesFromMoney() {
        this.requestTabSwitch("financials", "credit_notes");
    }

    async loadMoneyOverview(options = {}) {
        const force = Boolean(options && options.force);
        const token = ++this._moneyLoadToken;
        const from = this.state.money.date_from;
        const to = this.state.money.date_to;
        this.state.money.isLoading = true;
        notifyPortalBusy(true);
        const key = ["money", from, to].join("|");
        try {
            const summary = await cachedRead(key, () => this.orm.call(
                "shahtaj.portal.read",
                "shahtaj_cash_summary",
                [from, to],
            ), { force }) || {};
            if (token !== this._moneyLoadToken || from !== this.state.money.date_from || to !== this.state.money.date_to) {
                return;
            }
            this.state.money.collected = summary.collected || 0;
            this.state.money.paidOut = summary.paidOut || 0;
            this.state.money.netCash = summary.netCash || 0;
            this.state.money.stillOwed = summary.stillOwed || 0;
            this.state.money.openInvoiceAmount = summary.openInvoiceAmount || 0;
            this.state.money.paymentCountIn = summary.paymentCountIn || 0;
            this.state.money.paymentCountOut = summary.paymentCountOut || 0;
        } catch (error) {
            console.error("Money Overview Fetch Error:", error);
            this.notification.add("Failed to load money overview: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            if (token === this._moneyLoadToken) {
                this.state.money.isLoading = false;
            }
            notifyPortalBusy(false);
        }
    }
}

MoneyOverview.template = "shahtaj_oil.FinancialsMoneyOverview";
