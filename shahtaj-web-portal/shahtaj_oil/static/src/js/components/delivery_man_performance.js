/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { notifyPortalBusy } from "../shahtaj_access";

export class DeliveryManPerformance extends Component {
    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        const today = new Date();
        this.todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const ITEMS_PER_PAGE = 50;
        this.state = useState({
            dateFrom: "",
            dateTo: "",
            isLoading: false,
            rows: [],
            selectedDm: null,
            todayTasks: [],
            weekTasks: [],
            taskTab: "today",
            pagination: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            deliveryMen: [],
            filters: { search: "", dm: "all" },
            searchTimeout: null,
        });

        this.debouncedFetch = (...args) => {
            clearTimeout(this.state.searchTimeout);
            this.state.searchTimeout = setTimeout(() => this.fetchProgress(), 400);
        };

        onWillStart(async () => {
            await Promise.all([this.fetchDeliveryMen(), this.fetchProgress()]);
        });
    }

    _weekBounds() {
        const d = new Date(`${this.todayStr}T00:00:00`);
        const day = d.getDay();
        const mondayOffset = day === 0 ? -6 : 1 - day;
        const monday = new Date(d);
        monday.setDate(d.getDate() + mondayOffset);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        const fmt = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
        return [fmt(monday), fmt(sunday)];
    }

    dateDomain(field = "scheduled_date") {
        const domain = [];
        if (this.state.dateFrom) domain.push([field, ">=", this.state.dateFrom]);
        if (this.state.dateTo) domain.push([field, "<=", this.state.dateTo]);
        return domain;
    }

    get hasDateFilter() {
        return !!(this.state.dateFrom || this.state.dateTo);
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

    _countMap(groups) {
        const map = {};
        for (const g of groups || []) {
            const id = Array.isArray(g.delivery_man_id) ? g.delivery_man_id[0] : g.delivery_man_id;
            if (!id) continue;
            map[id] = g.delivery_man_id_count || g.__count || 0;
        }
        return map;
    }

    async fetchProgress() {
        this.state.isLoading = true;
        notifyPortalBusy(true);
        const pag = this.state.pagination;
        try {
            const domain = this._userDomain();
            const fields = [
                "id", "name", "shahtaj_employee_code", "shahtaj_online_status",
                "shahtaj_task_today_total", "shahtaj_task_today_done",
                "shahtaj_week_task_total", "shahtaj_week_task_done", "shahtaj_week_task_progress",
            ];
            const [total, users] = await Promise.all([
                this.orm.searchCount("res.users", domain),
                this.orm.searchRead("res.users", domain, fields, {
                    limit: pag.limit,
                    offset: (pag.page - 1) * pag.limit,
                    order: "name asc",
                }),
            ]);
            this.state.pagination.total = total;

            let rangeTotal = {};
            let rangeDone = {};
            if (this.hasDateFilter && users.length) {
                const ids = users.map((u) => u.id);
                const base = [
                    ["delivery_man_id", "in", ids],
                    ["task_kind", "=", "delivery_man"],
                    ["state", "!=", "cancelled"],
                    ...this.dateDomain("scheduled_date"),
                ];
                const [allGroups, doneGroups] = await Promise.all([
                    this.orm.call("shahtaj.visit.task", "read_group", [base, ["delivery_man_id"], ["delivery_man_id"]]),
                    this.orm.call("shahtaj.visit.task", "read_group", [base.concat([["state", "=", "completed"]]), ["delivery_man_id"], ["delivery_man_id"]]),
                ]);
                rangeTotal = this._countMap(allGroups);
                rangeDone = this._countMap(doneGroups);
            }

            this.state.rows = users.map((u) => {
                const weekTotal = this.hasDateFilter ? (rangeTotal[u.id] || 0) : (u.shahtaj_week_task_total || 0);
                const weekDone = this.hasDateFilter ? (rangeDone[u.id] || 0) : (u.shahtaj_week_task_done || 0);
                const weekPct = weekTotal ? (weekDone / weekTotal) * 100 : (u.shahtaj_week_task_progress || 0);
                return {
                    id: u.id,
                    name: u.name,
                    code: u.shahtaj_employee_code || "",
                    status: u.shahtaj_online_status || "offline",
                    todayTotal: u.shahtaj_task_today_total || 0,
                    todayDelivered: u.shahtaj_task_today_done || 0,
                    weekTotal,
                    weekDone,
                    weekPct,
                };
            });
        } catch (error) {
            this.notification.add("Failed to load visit progress: " + (error.data?.message || error.message), { type: "danger" });
            this.state.rows = [];
        } finally {
            this.state.isLoading = false;
            notifyPortalBusy(false);
        }
    }

    async openDm(row) {
        this.state.selectedDm = row;
        this.state.taskTab = "today";
        await this.fetchDmTasks();
    }

    closeDm() {
        this.state.selectedDm = null;
        this.state.todayTasks = [];
        this.state.weekTasks = [];
    }

    _mapTask(t) {
        return {
            id: t.id,
            date: t.scheduled_date || "—",
            shop: t.shop_id ? t.shop_id[1] : "—",
            route: t.route_id ? t.route_id[1] : "—",
            state: t.state,
        };
    }

    async fetchDmTasks() {
        if (!this.state.selectedDm) return;
        this.state.isLoading = true;
        try {
            const dmId = this.state.selectedDm.id;
            const base = [
                ["delivery_man_id", "=", dmId],
                ["task_kind", "=", "delivery_man"],
                ["state", "!=", "cancelled"],
            ];
            let todayDomain;
            let weekDomain;
            if (this.hasDateFilter) {
                const ranged = [...base, ...this.dateDomain("scheduled_date")];
                todayDomain = [...ranged, ["scheduled_date", "=", this.todayStr]];
                weekDomain = ranged;
            } else {
                const [weekStart, weekEnd] = this._weekBounds();
                todayDomain = [...base, ["scheduled_date", "=", this.todayStr]];
                weekDomain = [...base, ["scheduled_date", ">=", weekStart], ["scheduled_date", "<=", weekEnd]];
            }
            const fields = ["id", "scheduled_date", "shop_id", "route_id", "state"];
            const [todayTasks, weekTasks] = await Promise.all([
                this.orm.searchRead("shahtaj.visit.task", todayDomain, fields, { order: "scheduled_date desc, id desc", limit: 200 }),
                this.orm.searchRead("shahtaj.visit.task", weekDomain, fields, { order: "scheduled_date desc, id desc", limit: 200 }),
            ]);
            this.state.todayTasks = todayTasks.map((t) => this._mapTask(t));
            this.state.weekTasks = weekTasks.map((t) => this._mapTask(t));
        } catch (error) {
            this.notification.add("Failed to load tasks: " + (error.data?.message || error.message), { type: "danger" });
            this.state.todayTasks = [];
            this.state.weekTasks = [];
        } finally {
            this.state.isLoading = false;
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

    refreshActive() {
        this.state.pagination.page = 1;
        if (this.state.selectedDm) return this.fetchDmTasks();
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

    statusLabel(status) {
        const map = { online: "Online", away: "Away", offline: "Offline" };
        return map[status] || status || "—";
    }

    taskStateLabel(state) {
        const map = { pending: "Pending", in_progress: "In progress", completed: "Completed", skipped: "Skipped", cancelled: "Cancelled" };
        return map[state] || state || "—";
    }

    taskStateClass(state) {
        if (state === "completed") return "bg-success text-white";
        if (state === "in_progress") return "bg-info text-white";
        if (state === "pending") return "bg-warning text-dark";
        return "bg-light text-dark";
    }
}

DeliveryManPerformance.template = "shahtaj_oil.DeliveryManPerformance";
