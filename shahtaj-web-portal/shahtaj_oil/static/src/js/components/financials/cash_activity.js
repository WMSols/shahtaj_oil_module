/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { BankTransactions } from "../bank_transactions";
import { requestFinancialTabSwitch } from "./financials_cache";
import { takePendingCashDirection } from "./po_prefill";

export class CashActivity extends Component {
    static components = { BankTransactions };
    static props = {
        initialDirection: { type: String, optional: true },
        refreshNonce: { type: Number, optional: true },
    };

    setup() {
        const direction = this.props.initialDirection || takePendingCashDirection() || "all";
        this.state = useState({
            activeSubTab: "cash",
            cashDirection: direction,
        });
    }

    requestTabSwitch(tabName, subTabName) {
        requestFinancialTabSwitch(tabName, subTabName);
    }
}

CashActivity.template = "shahtaj_oil.FinancialsCashActivity";
