/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess } from "../../shahtaj_access";
import { formatDate } from "./financials_cache";

export class Pnl extends Component {
    static props = {
        refreshNonce: { type: Number, optional: true },
    };

    setup() {
        this.notification = useService("notification");
        this.orm = useService("orm");
        this.action = useService("action");
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        this.state = useState({
            activeSubTab: "pnl",
            pnl: {
                date_from: formatDate(firstDay),
                date_to: formatDate(today),
                stats: {},
                lines: [],
                isLoading: false,
                selectedProductLineId: "",
                page: 1, limit: 50,
            },
        });
        onWillUpdateProps(async (nextProps) => {
            if (nextProps.refreshNonce !== this.props.refreshNonce) {
                await this.fetchPnlData();
            }
        });
        onWillStart(async () => {
            if (!hasFinancialAccess()) {
                return;
            }
            await this.fetchPnlData();
        });
    }

    get displayPnlLines() {
        if (!this.state.pnl.selectedProductLineId) {
            return this.state.pnl.lines;
        }
        return this.state.pnl.lines.filter((l) => String(l.id) === String(this.state.pnl.selectedProductLineId));
    }

    get paginatedPnlLines() {
        const lines = this.displayPnlLines;
        const start = (this.state.pnl.page - 1) * this.state.pnl.limit;
        return lines.slice(start, start + this.state.pnl.limit);
    }

    changeTransientPage(tab, direction) {
        const obj = this.state[tab];
        const total = tab === "pnl" ? this.displayPnlLines.length : obj.history.length;
        const newPage = obj.page + direction;
        const maxPage = Math.max(1, Math.ceil(total / obj.limit));
        if (newPage >= 1 && newPage <= maxPage) {
            obj.page = newPage;
        }
    }

    async fetchPnlData() {
        this.state.pnl.isLoading = true;
        try {
            const pnlIds = await this.orm.create("shahtaj.pnl.dashboard", [{
                date_from: this.state.pnl.date_from,
                date_to: this.state.pnl.date_to,
            }]);
            const pnlId = pnlIds[0];
            await this.orm.call("shahtaj.pnl.dashboard", "action_refresh", [[pnlId]]);
            const pnlData = await this.orm.read("shahtaj.pnl.dashboard", [pnlId], [
                "amount_invoiced", "amount_credit_notes", "amount_net_sales",
                "amount_legacy_invoiced", "amount_cogs", "amount_gross_profit",
                "amount_manufacturer_payable", "amount_payments_received", "amount_shop_outstanding",
                "amount_operating_expense", "amount_net_profit", "expense_count",
                "line_ids",
            ]);

            if (pnlData.length > 0) {
                this.state.pnl.stats = pnlData[0];
                if (pnlData[0].line_ids && pnlData[0].line_ids.length > 0) {
                    const linesData = await this.orm.read("shahtaj.pnl.dashboard.line", pnlData[0].line_ids, [
                        "product_id", "qty_invoiced", "qty_credited", "amount_revenue",
                        "amount_credit", "amount_net_sales", "amount_cogs", "amount_profit",
                    ]);
                    this.state.pnl.lines = linesData.map((l) => ({
                        id: l.id,
                        product: l.product_id ? l.product_id[1] : "Unknown",
                        productId: l.product_id ? l.product_id[0] : null,
                        qty_invoiced: l.qty_invoiced,
                        qty_credited: l.qty_credited,
                        net_sales: (l.amount_net_sales || 0).toLocaleString(),
                        cogs: (l.amount_cogs || 0).toLocaleString(),
                        profit: (l.amount_profit || 0).toLocaleString(),
                        rawProfit: l.amount_profit || 0,
                    }));
                } else {
                    this.state.pnl.lines = [];
                }
            }
        } catch (error) {
            console.error("P&L Fetch Error:", error);
            this.notification.add("Failed to load Profit & Loss data.", { type: "danger" });
        }
        this.state.pnl.isLoading = false;
    }

    async printManufacturerSummary() {
        this.state.pnl.isLoading = true;
        try {
            const summaryIds = await this.orm.create("shahtaj.manufacturer.summary", [{
                date_from: this.state.pnl.date_from,
                date_to: this.state.pnl.date_to,
            }]);
            const summaryId = summaryIds[0];
            await this.orm.call("shahtaj.manufacturer.summary", "action_refresh", [[summaryId]]);
            this.action.doAction({
                type: "ir.actions.report",
                report_type: "qweb-pdf",
                report_name: "shahtaj_oil.report_manufacturer_summary",
                report_file: "shahtaj_oil.report_manufacturer_summary",
                context: { active_ids: [summaryId] },
            });
        } catch (error) {
            console.error("Print Error:", error);
            this.notification.add("Failed to print Manufacturer Summary.", { type: "danger" });
        } finally {
            this.state.pnl.isLoading = false;
        }
    }
}

Pnl.template = "shahtaj_oil.FinancialsPnl";
