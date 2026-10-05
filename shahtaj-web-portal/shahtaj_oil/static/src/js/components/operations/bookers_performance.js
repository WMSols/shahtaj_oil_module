/** @odoo-module **/

import { OperationsBase } from "./operations_base";

const VISIT_STATE_LABELS = {
    completed: "Completed",
    in_progress: "In Progress",
    pending: "Pending",
    skipped: "Skipped",
    cancelled: "Cancelled",
};

const COMPLETION_FILTERS = [
    { key: "all", label: "All" },
    { key: "complete", label: "Complete" },
    { key: "incomplete", label: "Incomplete" },
];

const OUTCOME_FILTERS = [
    { key: "all", label: "All" },
    { key: "order", label: "Order" },
    { key: "no_order", label: "No Order" },
    { key: "shop_closed", label: "Shop Closed" },
    { key: "incomplete", label: "Incomplete" },
    { key: "not_visited", label: "Not Visited" },
    { key: "in_progress", label: "In Progress" },
    { key: "undone", label: "Undone" },
];

export class BookersPerformance extends OperationsBase {
    setup() {
        super.setup();
        this.state.scheduleVisits = [];
        this.state.scheduleVisitsLoading = false;
        this.state.scheduleVisitFilters = { completion: "all", outcome: "all" };
        this._scheduleVisitLoad = 0;
    }

    scheduleVisitCompletionFilters() {
        return COMPLETION_FILTERS;
    }

    scheduleVisitOutcomeFilters() {
        return OUTCOME_FILTERS;
    }

    viewSchedule(sched) {
        const visitDate = this._resolveScheduleVisitDate(sched);
        this.state.scheduleVisitFilters = { completion: "all", outcome: "all" };
        this.state.scheduleVisits = [];
        this.state.selectedSchedule = {
            ...sched,
            visitDate,
            visitDateIsInferred: !sched.occurrenceDate,
        };
        this.loadScheduleVisits(this.state.selectedSchedule);
    }

    closeSchedule() {
        this._scheduleVisitLoad += 1;
        this.state.selectedSchedule = null;
        this.state.scheduleVisits = [];
        this.state.scheduleVisitsLoading = false;
    }

    async printScheduleVisits() {
        if (this.state.isPrintingList || this.state.scheduleVisitsLoading) return;
        const sched = this.state.selectedSchedule;
        if (!sched) return;
        this.state.isPrintingList = true;
        try {
            const filters = this.state.scheduleVisitFilters;
            const completion = COMPLETION_FILTERS.find((f) => f.key === filters.completion);
            const outcome = OUTCOME_FILTERS.find((f) => f.key === filters.outcome);
            const rows = this.scheduleVisitRows();
            await this._openListPrint(
                "Booker Performance — Shop Visits",
                [
                    this._printFilter("Booker", sched.bookerName),
                    this._printFilter("Route", sched.route),
                    this._printFilter("Zone", sched.zone),
                    this._printFilter("Day", sched.day),
                    this._printFilter("Date", this.formatScheduleVisitDate(sched.visitDate)),
                    this._printFilter("Completion", completion && completion.key !== "all" ? completion.label : ""),
                    this._printFilter("Outcome", outcome && outcome.key !== "all" ? outcome.label : ""),
                ],
                ["Shop", "Order", "Check-in", "Status", "Outcome", "Duration", "Order Total", "Notes"],
                rows.map((row) => [
                    row.shop || "",
                    row.orderName || "",
                    row.checkIn || "",
                    row.statusLabel || "",
                    row.outcomeLabel || "",
                    row.durationLabel || "",
                    row.orderLabel || "",
                    row.notes || "",
                ]),
            );
        } catch (error) {
            this.notification.add(error?.data?.message || error?.message || "Print failed.", { type: "danger" });
        } finally {
            this.state.isPrintingList = false;
        }
    }

    setScheduleVisitFilter(group, value) {
        this.state.scheduleVisitFilters[group] = value;
    }

    scheduleVisitFilterClass(group, key) {
        const active = this.state.scheduleVisitFilters[group] === key;
        return active ? "btn btn-sm btn-dark fw-bold" : "btn btn-sm btn-light border fw-bold text-dark";
    }

    scheduleVisitCount(group, key) {
        const filters = this.state.scheduleVisitFilters;
        return this.state.scheduleVisits.filter((row) => {
            if (group === "completion") {
                if (filters.outcome !== "all" && row.outcomeKey !== filters.outcome) return false;
                return key === "all" || row.completion === key;
            }
            if (filters.completion !== "all" && row.completion !== filters.completion) return false;
            return key === "all" || row.outcomeKey === key;
        }).length;
    }

    scheduleVisitRows() {
        const filters = this.state.scheduleVisitFilters;
        return this.state.scheduleVisits.filter((row) => {
            if (filters.completion !== "all" && row.completion !== filters.completion) return false;
            if (filters.outcome !== "all" && row.outcomeKey !== filters.outcome) return false;
            return true;
        });
    }

    scheduleVisitOutcomeClass(key) {
        return ({
            order: "so-badge-order",
            no_order: "so-badge-no-order",
            shop_closed: "so-badge-closed",
            incomplete: "so-badge-incomplete",
            undone: "so-badge-undone",
            in_progress: "so-badge-progress",
            not_visited: "so-badge-pending",
        })[key] || "so-badge-pending";
    }

    scheduleVisitStatusClass(row) {
        if (row.outcomeKey === "in_progress" || row.statusState === "in_progress") {
            return "so-badge-progress";
        }
        if (row.completion === "complete") return "so-badge-complete";
        return "so-badge-incomplete";
    }

    formatScheduleVisitDate(dateStr) {
        if (!dateStr) return "";
        const date = new Date(`${dateStr}T12:00:00+05:00`);
        if (Number.isNaN(date.getTime())) return dateStr;
        return date.toLocaleDateString("en-GB", {
            timeZone: "Asia/Karachi",
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
        });
    }

    _resolveScheduleVisitDate(sched) {
        if (sched.occurrenceDate) return sched.occurrenceDate;
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
        const todayDow = parseInt(this._pktWeekdayForDate(today), 10);
        const target = parseInt(sched.day_raw, 10);
        if (Number.isNaN(target)) return today;
        const back = (todayDow - target + 7) % 7;
        if (!back) return today;
        const date = new Date(`${today}T12:00:00+05:00`);
        date.setTime(date.getTime() - back * 86400000);
        return date.toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
    }

    _shopClosedNotes(notes) {
        return /shop\s*closed/i.test(notes || "");
    }

    _classifyScheduleVisit(row) {
        const shopClosed = row.visitOutcome === "no_order" && this._shopClosedNotes(row.notes);
        let outcomeKey = "not_visited";
        let outcomeLabel = "Not Visited";
        if (row.visitOutcome === "order") {
            outcomeKey = "order";
            outcomeLabel = "Order";
        } else if (shopClosed) {
            outcomeKey = "shop_closed";
            outcomeLabel = "Shop Closed";
        } else if (row.visitOutcome === "no_order") {
            outcomeKey = "no_order";
            outcomeLabel = "No Order";
        } else if (row.visitOutcome === "incomplete") {
            outcomeKey = "incomplete";
            outcomeLabel = "Incomplete";
        } else if (row.visitOutcome === "undone") {
            outcomeKey = "undone";
            outcomeLabel = "Undone";
        } else if (row.visitState === "in_progress" || row.visitOutcome === "none" || row.taskState === "in_progress") {
            outcomeKey = "in_progress";
            outcomeLabel = "In Progress";
        }
        const completion = (outcomeKey === "order" || outcomeKey === "no_order" || outcomeKey === "shop_closed")
            ? "complete"
            : "incomplete";
        return { outcomeKey, outcomeLabel, completion };
    }

    async loadScheduleVisits(sched) {
        const token = ++this._scheduleVisitLoad;
        this.state.scheduleVisitsLoading = true;
        this.state.scheduleVisits = [];
        try {
            if (!sched || !sched.bookerId || !sched.routeId || !sched.visitDate) {
                return;
            }
            const tasks = await this.orm.searchRead(
                "shahtaj.visit.task",
                [
                    ["order_booker_id", "=", sched.bookerId],
                    ["route_id", "=", sched.routeId],
                    ["scheduled_date", "=", sched.visitDate],
                    ["task_kind", "=", "order_booker"],
                    ["state", "!=", "cancelled"],
                ],
                ["shop_id", "state", "visit_id", "notes", "scheduled_date"],
                { limit: 500, order: "shop_id" },
            );
            if (token !== this._scheduleVisitLoad) return;
            const visitIds = [...new Set(tasks.map((task) => this._m2oId(task.visit_id)).filter(Boolean))];
            const visitsById = {};
            if (visitIds.length) {
                const visits = await this.orm.read(
                    "shahtaj.visit",
                    visitIds,
                    [
                        "started_at", "ended_at", "state", "outcome", "duration_minutes",
                        "order_amount", "notes", "sale_order_id", "shop_name",
                    ],
                );
                visits.forEach((visit) => { visitsById[visit.id] = visit; });
            }
            if (token !== this._scheduleVisitLoad) return;
            if (!this.state.selectedSchedule || this.state.selectedSchedule.id !== sched.id) return;
            const rows = tasks.map((task) => {
                const visit = visitsById[this._m2oId(task.visit_id)] || null;
                const notes = ((visit && visit.notes) || task.notes || "").trim();
                const statusState = visit ? visit.state : task.state;
                const base = {
                    id: task.id,
                    shop: (visit && visit.shop_name) || (task.shop_id ? task.shop_id[1] : "Unknown shop"),
                    checkIn: visit && visit.started_at ? (this.formatUtcToPkt(visit.started_at) || "—") : "—",
                    checkInSort: visit && visit.started_at ? visit.started_at : "",
                    statusState,
                    statusLabel: VISIT_STATE_LABELS[statusState] || statusState || "—",
                    taskState: task.state,
                    visitId: visit ? visit.id : false,
                    visitState: visit ? visit.state : "",
                    visitOutcome: visit ? visit.outcome : "",
                    durationLabel: !visit
                        ? "—"
                        : (visit.state === "in_progress"
                            ? "Active"
                            : (visit.duration_minutes ? `${Number(visit.duration_minutes).toFixed(1)} min` : "—")),
                    orderAmount: visit ? (visit.order_amount || 0) : 0,
                    orderLabel: this._formatRs(visit ? (visit.order_amount || 0) : 0),
                    orderName: visit && visit.sale_order_id ? visit.sale_order_id[1] : "",
                    notes,
                };
                return { ...base, ...this._classifyScheduleVisit(base) };
            });
            rows.sort((a, b) => {
                if (a.checkInSort && b.checkInSort) return a.checkInSort < b.checkInSort ? 1 : -1;
                if (a.checkInSort) return -1;
                if (b.checkInSort) return 1;
                return a.shop.localeCompare(b.shop);
            });
            this.state.scheduleVisits = rows;
        } catch (error) {
            if (token !== this._scheduleVisitLoad) return;
            this.notification.add(
                "Failed to load shop visits: " + (error.data?.message || error.message),
                { type: "danger" },
            );
        } finally {
            if (token === this._scheduleVisitLoad) {
                this.state.scheduleVisitsLoading = false;
            }
        }
    }
}

BookersPerformance.template = "shahtaj_oil.OperationsBookersPerformance";
