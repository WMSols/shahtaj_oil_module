/** @odoo-module **/

import { Component, useState, onWillUpdateProps } from "@odoo/owl";
import { BankTransactions } from "../bank_transactions";
import { requestFinancialTabSwitch } from "./financials_cache";
import { takePendingCashDirection } from "./po_prefill";

export class CashActivity extends Component {
    static components = { BankTransactions };
    static props = {
        initialDirection: { type: String, optional: true },
        initialDateFrom: { type: String, optional: true },
        initialDateTo: { type: String, optional: true },
        refreshNonce: { type: Number, optional: true },
    };

    setup() {
        const direction = this.props.initialDirection || takePendingCashDirection() || "all";
        this.state = useState({
            activeSubTab: "cash",
            cashDirection: direction,
            cashDateFrom: this.props.initialDateFrom || "",
            cashDateTo: this.props.initialDateTo || "",
        });
        onWillUpdateProps((nextProps) => {
            const direction = nextProps.initialDirection || "all";
            const dateFrom = nextProps.initialDateFrom || "";
            const dateTo = nextProps.initialDateTo || "";
            if (direction !== this.state.cashDirection) {
                this.state.cashDirection = direction;
            }
            if (dateFrom !== this.state.cashDateFrom) {
                this.state.cashDateFrom = dateFrom;
            }
            if (dateTo !== this.state.cashDateTo) {
                this.state.cashDateTo = dateTo;
            }
        });
    }

    requestTabSwitch(tabName, subTabName) {
        requestFinancialTabSwitch(tabName, subTabName);
    }
}

CashActivity.template = "shahtaj_oil.FinancialsCashActivity";
