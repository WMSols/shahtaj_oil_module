/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { notifyPortalBusy } from "../shahtaj_access";
import { printListPdf } from "../shahtaj_list_export";

const DONE_STATES = ["delivered", "returned"];

export class DeliveryManPerformance extends Component {
    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this._listFetchToken = 0;
        const today = new Date();
        this.todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const ITEMS_PER_PAGE = 50;
        this.state = useState({
            date: this.todayStr,
            isLoading: false,
            rows: [],
            selectedDm: null,
            jobs: [],
            recentActivity: [],
            pagination: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            deliveryMen: [],
            filters: { search: "", dm: "all" },
            isPrinting: false,
            searchTimeout: null,
        });

        this.debouncedFetch = () => {
            clearTimeout(this.state.searchTimeout);
            this.state.searchTimeout = setTimeout(() => this.fetchProgress(), 400);
        };

        onWillStart(async () => {
            await Promise.all([this.fetchDeliveryMen(), this.fetchProgress()]);
        });
    }

    dateDomain(field = "scheduled_date") {
        return [[field, "=", this.state.date || this.todayStr]];
    }

    _userDomain() {
        const domain = [["shahtaj_is_delivery_man", "=", true], ["active", "=", true]];
        const search = (this.state.filters.search || "").trim();
        if (search) {
            domain.push("|", ["name", "ilike", search], ["shahtaj_employee_code", "ilike", search]);
        }
        if (this.state.filters.dm && this.state.filters.dm !== "all") {
            domain.push(["id", "=", parseInt(this.state.filters.dm, 10)]);
        }
        return domain;
    }

    async fetchDeliveryMen() {
        try {
            this.state.deliveryMen = await this.orm.searchRead(
                "res.users",
                [["shahtaj_is_delivery_man", "=", true], ["active", "=", true]],
                ["id", "name"],
                { order: "name asc" },
            );
        } catch (error) {
            this.state.deliveryMen = [];
        }
    }

    _countByDm(groups) {
        const map = {};
        for (const group of groups || []) {
            const id = Array.isArray(group.delivery_man_id) ? group.delivery_man_id[0] : group.delivery_man_id;
            if (!id) continue;
            map[id] = (map[id] || 0) + (group.__count || group.delivery_man_id_count || 0);
        }
        return map;
    }

    async _jobStats(userIds) {
        const stats = {};
        if (!userIds.length) return stats;
        const domain = [
            ["delivery_man_id", "in", userIds],
            ...this.dateDomain("scheduled_date"),
        ];
        const groupBy = ["delivery_man_id"];
        const [assignedGroups, doneGroups] = await Promise.all([
            this.orm.call("shahtaj.dm.delivery", "read_group", [domain, ["delivery_man_id"], groupBy]),
            this.orm.call("shahtaj.dm.delivery", "read_group", [
                domain.concat([["state", "in", DONE_STATES]]),
                ["delivery_man_id"],
                groupBy,
            ]),
        ]);
        const assigned = this._countByDm(assignedGroups);
        const done = this._countByDm(doneGroups);
        for (const id of userIds) {
            stats[id] = {
                assigned: assigned[id] || 0,
                done: done[id] || 0,
            };
        }
        return stats;
    }

    async fetchProgress() {
        const fetchToken = ++this._listFetchToken;
        this.state.isLoading = true;
        notifyPortalBusy(true);
        const pag = this.state.pagination;
        try {
            const domain = this._userDomain();
            const fields = [
                "id", "name", "shahtaj_employee_code", "shahtaj_online_status",
            ];
            const [total, users] = await Promise.all([
                this.orm.searchCount("res.users", domain),
                this.orm.searchRead("res.users", domain, fields, {
                    limit: pag.limit,
                    offset: (pag.page - 1) * pag.limit,
                    order: "name asc",
                }),
            ]);
            if (fetchToken !== this._listFetchToken) {
                return;
            }
            this.state.pagination.total = total;
            const stats = await this._jobStats(users.map((user) => user.id));
            if (fetchToken !== this._listFetchToken) {
                return;
            }
            this.state.rows = users.map((user) => {
                const bucket = stats[user.id] || { assigned: 0, done: 0 };
                const pending = Math.max(bucket.assigned - bucket.done, 0);
                const progress = bucket.assigned ? (bucket.done / bucket.assigned) * 100 : 0;
                return {
                    id: user.id,
                    name: user.name,
                    code: user.shahtaj_employee_code || "",
                    status: user.shahtaj_online_status || "offline",
                    assigned: bucket.assigned,
                    done: bucket.done,
                    pending,
                    progress,
                };
            });
        } catch (error) {
            this.notification.add("Failed to load delivery progress: " + (error.data?.message || error.message), { type: "danger" });
            if (fetchToken === this._listFetchToken) {
                this.state.rows = [];
            }
        } finally {
            if (fetchToken === this._listFetchToken) {
                this.state.isLoading = false;
                notifyPortalBusy(false);
            }
        }
    }

    async openDm(row) {
        this.state.selectedDm = row;
        this.state.jobs = [];
        this.state.recentActivity = [];
        await this.fetchDmJobs();
    }

    closeDm() {
        this.state.selectedDm = null;
        this.state.jobs = [];
        this.state.recentActivity = [];
    }

    formatQty(value) {
        const amount = Number(value) || 0;
        return String(parseFloat(amount.toFixed(6)));
    }

    formatUpdated(value) {
        if (!value) return "—";
        return String(value).replace("T", " ").slice(0, 16);
    }

    async fetchDmJobs() {
        if (!this.state.selectedDm) return;
        this.state.isLoading = true;
        try {
            const jobs = await this.orm.searchRead(
                "shahtaj.dm.delivery",
                [
                    ["delivery_man_id", "=", this.state.selectedDm.id],
                    ...this.dateDomain("scheduled_date"),
                ],
                ["id", "sale_order_id", "partner_id", "scheduled_date", "state", "field_state", "is_walk_in"],
                { order: "scheduled_date desc, id desc", limit: 200 },
            );
            this.state.jobs = jobs.map((job) => ({
                id: job.id,
                order: job.sale_order_id ? job.sale_order_id[1] : "—",
                shop: job.partner_id ? job.partner_id[1] : "—",
                date: job.scheduled_date || "—",
                state: job.state || "",
                fieldState: job.field_state || "",
                isWalkIn: !!job.is_walk_in,
            }));
            await this.fetchRecentActivity();
        } catch (error) {
            this.notification.add("Failed to load deliveries: " + (error.data?.message || error.message), { type: "danger" });
            this.state.jobs = [];
        } finally {
            this.state.isLoading = false;
        }
    }

    async fetchRecentActivity() {
        if (!this.state.selectedDm) return;
        try {
            const jobs = await this.orm.searchRead(
                "shahtaj.dm.delivery",
                [["delivery_man_id", "=", this.state.selectedDm.id]],
                ["id", "write_date", "sale_order_id", "partner_id", "state"],
                { order: "write_date desc, id desc", limit: 30 },
            );
            if (!jobs.length) {
                this.state.recentActivity = [];
                return;
            }
            const lines = await this.orm.searchRead(
                "shahtaj.dm.delivery.line",
                [["delivery_id", "in", jobs.map((job) => job.id)]],
                ["delivery_id", "qty_picked", "qty_delivered"],
                { limit: 5000 },
            );
            const totals = {};
            for (const line of lines) {
                const jobId = Array.isArray(line.delivery_id) ? line.delivery_id[0] : line.delivery_id;
                if (!totals[jobId]) totals[jobId] = { picked: 0, delivered: 0 };
                totals[jobId].picked += line.qty_picked || 0;
                totals[jobId].delivered += line.qty_delivered || 0;
            }
            const rows = [];
            for (const job of jobs) {
                const bucket = totals[job.id] || { picked: 0, delivered: 0 };
                if (bucket.picked <= 0 && bucket.delivered <= 0) continue;
                rows.push({
                    id: job.id,
                    updated: this.formatUpdated(job.write_date),
                    order: job.sale_order_id ? job.sale_order_id[1] : "—",
                    shop: job.partner_id ? job.partner_id[1] : "—",
                    picked: bucket.picked,
                    delivered: bucket.delivered,
                    onVan: Math.max(bucket.picked - bucket.delivered, 0),
                    state: job.state || "",
                });
                if (rows.length >= 12) break;
            }
            this.state.recentActivity = rows;
        } catch (error) {
            console.error("Failed to load recent pick and deliver", error);
            this.state.recentActivity = [];
        }
    }

    onSearchInput(ev) {
        this.state.filters.search = ev.target.value;
        this.state.pagination.page = 1;
        this.debouncedFetch();
    }

    isDmSelected(id) {
        return String(id) === String(this.state.filters.dm);
    }

    onDmFilterChange(ev) {
        this.state.filters.dm = ev.target.value || "all";
        this.onFilterChange();
    }

    onFilterChange() {
        this.state.pagination.page = 1;
        this.fetchProgress();
    }

    clearFilters(listKey = "performance") {
        this.state.filters = { search: "", dm: "all" };
        this.state.date = this.todayStr;
        this.state.pagination.page = 1;
        this.state.rows = [];
        this.fetchProgress();
    }

    refreshActive() {
        if (!this.state.date) this.state.date = this.todayStr;
        this.state.pagination.page = 1;
        if (this.state.selectedDm) return this.fetchDmJobs();
        return this.fetchProgress();
    }

    changePage(direction) {
        const pag = this.state.pagination;
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        if (newPage < 1 || newPage > maxPage) return;
        pag.page = newPage;
        this.fetchProgress();
    }

    async printSummary() {
        if (this.state.isPrinting || this.state.selectedDm) return;
        this.state.isPrinting = true;
        try {
            const domain = this._userDomain();
            const users = await this.orm.searchRead(
                "res.users",
                domain,
                ["id", "name", "shahtaj_employee_code", "shahtaj_online_status"],
                { order: "name asc" },
            );
            const stats = await this._jobStats(users.map((user) => user.id));
            const rows = users.map((user) => {
                const bucket = stats[user.id] || { assigned: 0, done: 0 };
                const pending = Math.max(bucket.assigned - bucket.done, 0);
                const progress = bucket.assigned ? (bucket.done / bucket.assigned) * 100 : 0;
                return [
                    user.name || "",
                    user.shahtaj_employee_code || "",
                    `${Math.round(progress)}%`,
                    String(bucket.done),
                    String(pending),
                    String(bucket.assigned),
                    this.statusLabel(user.shahtaj_online_status || "offline"),
                ];
            });
            if (!rows.length) {
                this.notification.add("No rows match the current filters.", { type: "warning" });
                return;
            }
            const dmName = this.state.filters.dm !== "all"
                ? (this.state.deliveryMen.find((dm) => String(dm.id) === String(this.state.filters.dm)) || {}).name
                : "";
            await printListPdf(this.orm, this.action, {
                title: "DM Performance",
                filters: [
                    this.state.filters.search ? `Search: ${this.state.filters.search}` : "",
                    this.state.date ? `Date: ${this.state.date}` : "",
                    dmName ? `Delivery man: ${dmName}` : "",
                ],
                columns: ["Delivery Man", "Code", "Progress %", "Done", "Pending", "Assigned", "Online"],
                rows,
            });
        } catch (error) {
            this.notification.add(error?.data?.message || error?.message || "Print failed.", { type: "danger" });
        } finally {
            this.state.isPrinting = false;
        }
    }

    async printDayActivity() {
        if (this.state.isPrinting || !this.state.selectedDm) return;
        this.state.isPrinting = true;
        try {
            const day = this.state.date || this.todayStr;
            const dm = this.state.selectedDm;
            const jobs = this.state.jobs || [];
            if (!jobs.length) {
                this.notification.add("No day activity rows to print.", { type: "warning" });
                return;
            }
            await printListPdf(this.orm, this.action, {
                title: "DM Performance — Day Activity",
                filters: [
                    dm.name ? `Delivery man: ${dm.name}` : "",
                    day ? `Date: ${day}` : "",
                    `Done: ${dm.done} / ${dm.assigned}`,
                    `Progress: ${Math.round(dm.progress)}%`,
                ].filter(Boolean),
                columns: ["Date", "Order", "Shop", "Walk-in", "Stock", "Stop"],
                rows: jobs.map((job) => [
                    job.date || "",
                    job.order || "",
                    job.shop || "",
                    job.isWalkIn ? "Yes" : "",
                    this.stockLabel(job.state),
                    this.stopLabel(job.fieldState),
                ]),
            });
        } catch (error) {
            this.notification.add(error?.data?.message || error?.message || "Print failed.", { type: "danger" });
        } finally {
            this.state.isPrinting = false;
        }
    }

    statusLabel(status) {
        const map = { online: "Online", away: "Away", offline: "Offline" };
        return map[status] || status || "—";
    }

    statusClass(status) {
        if (status === "online") return "bg-success text-white";
        if (status === "away") return "bg-warning text-dark";
        return "bg-secondary text-white";
    }

    stockLabel(state) {
        return ({
            not_ready: "Waiting Invoice",
            ready: "Ready to Pick",
            picked: "Loaded on Van",
            partial: "Part Delivered",
            delivered: "Delivered",
            returned: "Returned to WH",
        })[state] || state || "—";
    }

    stockClass(state) {
        if (state === "delivered") return "bg-success text-white";
        if (state === "returned") return "bg-danger text-white";
        if (state === "picked" || state === "partial") return "bg-warning text-dark";
        if (state === "ready") return "bg-info text-white";
        return "bg-light text-dark";
    }

    stopLabel(state) {
        return ({
            pending: "Not Started",
            in_transit: "Heading to Shop",
            not_attended: "Shop Closed",
            failed: "Could Not Deliver",
            done: "Stop Done",
        })[state] || state || "—";
    }

    stopClass(state) {
        if (state === "done") return "bg-success text-white";
        if (state === "in_transit") return "bg-info text-white";
        if (state === "not_attended" || state === "failed") return "bg-warning text-dark";
        return "bg-light text-dark";
    }
}

DeliveryManPerformance.template = "shahtaj_oil.DeliveryManPerformance";
