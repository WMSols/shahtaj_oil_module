/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess } from "../../shahtaj_access";
import { formatDate, requestFinancialTabSwitch } from "./financials_cache";

export class TaxLedger extends Component {
    static props = {
        refreshNonce: { type: Number, optional: true },
    };

    setup() {
        this.notification = useService("notification");
        this.orm = useService("orm");
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        this.state = useState({
            activeSubTab: "tax_ledger",
            taxLedger: {
                date_from: formatDate(firstDay),
                date_to: formatDate(today),
                stats: { amount_tax_invoiced: 0, amount_tax_credited: 0, amount_tax_net: 0 },
                summaries: [], history: [], isLoading: false,
                page: 1, limit: 50,
            },
        });
        onWillUpdateProps(async (nextProps) => {
            if (nextProps.refreshNonce !== this.props.refreshNonce) {
                await this.fetchTaxLedgerData();
            }
        });
        onWillStart(async () => {
            if (!hasFinancialAccess()) {
                return;
            }
            await this.fetchTaxLedgerData();
        });
    }

    requestTabSwitch(tabName, subTabName) {
        requestFinancialTabSwitch(tabName, subTabName);
    }

    get paginatedTaxHistory() {
        const start = (this.state.taxLedger.page - 1) * this.state.taxLedger.limit;
        return this.state.taxLedger.history.slice(start, start + this.state.taxLedger.limit);
    }

    changeTransientPage(tab, direction) {
        const obj = this.state[tab];
        const total = obj.history.length;
        const newPage = obj.page + direction;
        const maxPage = Math.max(1, Math.ceil(total / obj.limit));
        if (newPage >= 1 && newPage <= maxPage) {
            obj.page = newPage;
        }
    }

    async fetchTaxLedgerData() {
        this.state.taxLedger.isLoading = true;
        try {
            const ledgerIds = await this.orm.create("shahtaj.tax.ledger", [{
                date_from: this.state.taxLedger.date_from,
                date_to: this.state.taxLedger.date_to,
            }]);
            const ledgerId = ledgerIds[0];
            await this.orm.call("shahtaj.tax.ledger", "action_refresh", [[ledgerId]]);
            const ledgerData = await this.orm.read("shahtaj.tax.ledger", [ledgerId], [
                "amount_tax_invoiced", "amount_tax_credited", "amount_tax_net",
                "summary_ids", "history_ids",
            ]);

            if (ledgerData.length > 0) {
                this.state.taxLedger.stats = ledgerData[0];
                if (ledgerData[0].summary_ids && ledgerData[0].summary_ids.length > 0) {
                    this.state.taxLedger.summaries = await this.orm.read("shahtaj.tax.ledger.summary", ledgerData[0].summary_ids, [
                        "tax_name", "tax_rate", "base_invoiced", "tax_invoiced",
                        "base_credited", "tax_credited", "tax_net", "line_count",
                    ]);
                } else {
                    this.state.taxLedger.summaries = [];
                }
                if (ledgerData[0].history_ids && ledgerData[0].history_ids.length > 0) {
                    const history = await this.orm.read("shahtaj.tax.ledger.history", ledgerData[0].history_ids, [
                        "date", "document_type", "move_name", "partner_id", "tax_id", "base_amount", "tax_amount",
                    ]);
                    this.state.taxLedger.history = history.map((h) => ({
                        ...h,
                        partner_name: h.partner_id ? h.partner_id[1] : "Unknown Shop",
                        tax_name: h.tax_id ? h.tax_id[1] : "Unknown Tax",
                    }));
                } else {
                    this.state.taxLedger.history = [];
                }
            }
        } catch (error) {
            console.error("Tax Ledger Fetch Error:", error);
            this.notification.add("Failed to load Tax Ledger data.", { type: "danger" });
        } finally {
            this.state.taxLedger.isLoading = false;
        }
    }
}

TaxLedger.template = "shahtaj_oil.FinancialsTaxLedger";
