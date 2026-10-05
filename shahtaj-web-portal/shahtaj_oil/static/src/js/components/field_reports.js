/** @odoo-module **/

import { Component, useState, onWillStart, useRef } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { rpc } from "@web/core/network/rpc";

const ODOO_COLORS = [
    "#E2E8F0",
    "#F06050",
    "#F4A460",
    "#F7CD1F",
    "#6CC1ED",
    "#814968",
    "#EB7E7F",
    "#2C8397",
    "#475577",
    "#D6145F",
    "#30C381",
    "#9365B8",
];

const STATE_LABELS = {
    new: "New",
    in_progress: "In Progress",
    done: "Done",
    cancelled: "Cancelled",
};

const ROLE_LABELS = {
    order_booker: "Order Booker",
    delivery_man: "Delivery Man",
    other: "Other",
};

const STATUS_STEPS = [
    { key: "new", label: "New" },
    { key: "in_progress", label: "In Progress" },
    { key: "done", label: "Done" },
];

function htmlSource(value) {
    if (Array.isArray(value) && value[0] === "markup") {
        return value[1] || "";
    }
    if (value && typeof value === "object" && "value" in value) {
        return htmlSource(value.value);
    }
    return value == null ? "" : String(value);
}

function plainText(value) {
    const node = document.createElement("div");
    node.innerHTML = htmlSource(value);
    return (node.textContent || "").replace(/\s+/g, " ").trim();
}

function relationId(value) {
    if (!value) {
        return false;
    }
    if (Array.isArray(value)) {
        return value[0];
    }
    if (typeof value === "object") {
        return value.id;
    }
    return value;
}

function slugCode(name) {
    const code = (name || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return code || "tag";
}

export class FieldReports extends Component {
    static template = "shahtaj_oil.FieldReports";
    static props = {
        requestedSubTab: { type: String, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.threadRef = useRef("thread");
        this.state = useState({
            pill: "reports",
            mode: "list",
            reports: [],
            tags: [],
            selected: null,
            thread: [],
            draft: "",
            closingRemark: "",
            screenshotName: "",
            filters: { search: "", state: "all", role: "all" },
            form: this._emptyForm(),
            tagForm: this._emptyTagForm(),
            editingTagId: null,
            isLoading: false,
            isSaving: false,
            isSending: false,
            page: 1,
            pageSize: 50,
            total: 0,
        });
        onWillStart(async () => {
            await Promise.all([this.loadTags(), this.loadReports()]);
        });
    }

    _emptyForm() {
        return {
            subject: "",
            description: "",
            tagIds: [],
            screenshot: "",
        };
    }

    _emptyTagForm() {
        return {
            name: "",
            kind: "field_activity",
            color: 1,
        };
    }

    tagColor(tag) {
        const index = Number(tag && tag.color) || 0;
        return ODOO_COLORS[index] || ODOO_COLORS[0];
    }

    tagStyle(tag) {
        const hex = this.tagColor(tag);
        const light = hex === "#F7CD1F" || hex === "#E2E8F0" || hex === "#6CC1ED";
        return `background:${hex};color:${light ? "#1e293b" : "#fff"};`;
    }

    tagsFor(report) {
        const ids = report.tag_ids || [];
        return ids.map((id) => this.state.tags.find((tag) => tag.id === id)).filter(Boolean);
    }

    roleLabel(role) {
        return ROLE_LABELS[role] || role || "";
    }

    stateLabel(state) {
        return STATE_LABELS[state] || state || "";
    }

    stateClass(state) {
        if (state === "new") {
            return "bg-info text-white";
        }
        if (state === "in_progress") {
            return "bg-warning text-dark";
        }
        if (state === "done") {
            return "bg-success text-white";
        }
        return "bg-secondary text-white";
    }

    formatWhen(value) {
        if (!value) {
            return "";
        }
        const date = new Date(String(value).replace(" ", "T") + "Z");
        if (Number.isNaN(date.getTime())) {
            return value;
        }
        return date.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        });
    }

    screenshotSrc(value) {
        if (!value) {
            return "";
        }
        return String(value).startsWith("data:") ? value : `data:image/png;base64,${value}`;
    }

    authorInitial(name) {
        return ((name || "?").trim()[0] || "?").toUpperCase();
    }

    async refreshReports() {
        await this.loadTags();
        if (this.state.mode === "detail" && this.state.selected) {
            await this.openReport(this.state.selected.id);
            return;
        }
        if (this.state.mode === "list") {
            await this.loadReports();
        }
    }

    setPill(pill) {
        this.state.pill = pill;
        this.state.mode = "list";
        this.state.selected = null;
    }

    async loadTags() {
        this.state.tags = await this.orm.searchRead(
            "shahtaj.field.report.tag",
            [["active", "=", true]],
            ["name", "code", "kind", "color", "sequence"],
            { order: "kind, sequence, name, id" }
        );
    }

    async loadReports() {
        this.state.isLoading = true;
        try {
            const domain = [];
            const search = (this.state.filters.search || "").trim();
            if (search) {
                domain.push("|", "|",
                    ["name", "ilike", search],
                    ["subject", "ilike", search],
                    ["user_id", "ilike", search]
                );
            }
            if (this.state.filters.state !== "all") {
                domain.push(["state", "=", this.state.filters.state]);
            }
            if (this.state.filters.role !== "all") {
                domain.push(["reporter_role", "=", this.state.filters.role]);
            }
            const offset = (this.state.page - 1) * this.state.pageSize;
            const [total, rows] = await Promise.all([
                this.orm.searchCount("shahtaj.field.report", domain),
                this.orm.searchRead(
                    "shahtaj.field.report",
                    domain,
                    ["name", "subject", "tag_ids", "user_id", "reporter_role", "state", "create_date"],
                    { limit: this.state.pageSize, offset, order: "create_date desc, id desc" }
                ),
            ]);
            this.state.total = total;
            this.state.reports = rows;
        } catch (error) {
            this.notification.add(error.data?.message || error.message || "Could not load reports.", { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }

    onSearch(ev) {
        this.state.filters.search = ev.target.value;
        this.state.page = 1;
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => this.loadReports(), 350);
    }

    onFilter(key, ev) {
        this.state.filters[key] = ev.target.value;
        this.state.page = 1;
        this.loadReports();
    }

    async changePage(delta) {
        const pages = Math.max(1, Math.ceil(this.state.total / this.state.pageSize));
        const next = Math.min(pages, Math.max(1, this.state.page + delta));
        if (next === this.state.page) {
            return;
        }
        this.state.page = next;
        await this.loadReports();
    }

    openCreate() {
        this.state.form = this._emptyForm();
        this.state.screenshotName = "";
        this.state.mode = "create";
        this.state.selected = null;
    }

    backToList() {
        this.state.mode = "list";
        this.state.selected = null;
        this.state.thread = [];
        this.state.draft = "";
        this.state.closingRemark = "";
        this.loadReports();
    }

    toggleTag(tagId) {
        const ids = this.state.form.tagIds;
        const index = ids.indexOf(tagId);
        if (index === -1) {
            ids.push(tagId);
        } else {
            ids.splice(index, 1);
        }
    }

    onScreenshot(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) {
            this.state.form.screenshot = "";
            this.state.screenshotName = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            this.state.form.screenshot = result.includes(",") ? result.split(",")[1] : result;
            this.state.screenshotName = file.name;
        };
        reader.readAsDataURL(file);
    }

    async saveReport() {
        const form = this.state.form;
        if (!form.subject.trim() || !form.description.trim() || !form.tagIds.length) {
            this.notification.add("Subject, details, and at least one tag are required.", { type: "warning" });
            return;
        }
        const vals = {
            subject: form.subject.trim(),
            description: form.description.trim(),
            tag_ids: [[6, 0, form.tagIds.slice()]],
        };
        if (form.screenshot) {
            vals.screenshot = form.screenshot;
        }
        this.state.isSaving = true;
        try {
            const ids = await this.orm.create("shahtaj.field.report", [vals]);
            const id = Array.isArray(ids) ? ids[0] : ids;
            await this.openReport(id);
            this.notification.add("Report created.", { type: "success" });
        } catch (error) {
            this.notification.add(error.data?.message || error.message || "Could not create the report.", { type: "danger" });
        } finally {
            this.state.isSaving = false;
        }
    }

    async openReport(id) {
        this.state.isLoading = true;
        try {
            const [report] = await this.orm.read(
                "shahtaj.field.report",
                [id],
                [
                    "name", "subject", "description", "state", "tag_ids", "user_id",
                    "reporter_role", "create_date", "device_info",
                    "screenshot", "closed_at", "closed_by_id", "closing_remark",
                ]
            );
            this.state.selected = report;
            this.state.mode = "detail";
            this.state.draft = "";
            this.state.closingRemark = report.closing_remark || "";
            await this.loadThread();
        } catch (error) {
            this.notification.add(error.data?.message || error.message || "Could not open the report.", { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }

    async loadThread() {
        const report = this.state.selected;
        if (!report) {
            return;
        }
        let payload;
        try {
            payload = await rpc("/mail/thread/messages", {
                thread_model: "shahtaj.field.report",
                thread_id: report.id,
                fetch_params: { limit: 80 },
            });
        } catch (error) {
            this.state.thread = [];
            this.notification.add(error.data?.message || error.message || "Messages could not be loaded.", { type: "warning" });
            return;
        }
        const data = payload.data || {};
        const partners = {};
        (data["res.partner"] || []).forEach((partner) => {
            partners[partner.id] = partner.name || "";
        });
        const messages = [...(data["mail.message"] || [])].reverse();
        this.state.thread = messages.map((message) => {
            const tracking = (message.trackingValues || [])
                .filter((value) => value.oldValue || value.newValue)
                .map((value) => ({
                    field: value.fieldInfo?.changedField || "Status",
                    old: plainText(value.oldValue),
                    next: plainText(value.newValue),
                }));
            const body = plainText(message.body);
            const authorId = relationId(message.author_id);
            let kind = "system";
            if (tracking.length) {
                kind = "tracking";
            } else if (message.message_type === "comment") {
                kind = "message";
            }
            return {
                id: message.id,
                kind,
                author: partners[authorId] || "",
                date: message.date,
                body,
                tracking,
            };
        }).filter((row) => row.kind === "tracking" || row.body);
        requestAnimationFrame(() => {
            const node = this.threadRef.el;
            if (node) {
                node.scrollTop = node.scrollHeight;
            }
        });
    }

    isClosed(report) {
        const state = report && report.state;
        return state === "done" || state === "cancelled";
    }

    async runAction(method) {
        const report = this.state.selected;
        if (!report || this.state.isSaving) {
            return;
        }
        const closing = method === "action_mark_done" || method === "action_mark_cancelled";
        const remark = (this.state.closingRemark || "").trim();
        if (closing && !remark) {
            this.notification.add(
                method === "action_mark_done"
                    ? "Enter a Closing Remark on the report form, then click Mark Done."
                    : "Enter a Closing Remark on the report form, then click Cancel.",
                { type: "warning" }
            );
            return;
        }
        this.state.isSaving = true;
        try {
            if (closing) {
                await this.orm.write("shahtaj.field.report", [report.id], {
                    closing_remark: remark,
                });
            }
            await this.orm.call("shahtaj.field.report", method, [[report.id]]);
            await this.openReport(report.id);
        } catch (error) {
            this.notification.add(error.data?.message || error.message || "Could not update the status.", { type: "danger" });
        } finally {
            this.state.isSaving = false;
        }
    }

    async sendMessage() {
        const report = this.state.selected;
        const body = (this.state.draft || "").trim();
        if (!report || !body || this.state.isSending) {
            return;
        }
        this.state.isSending = true;
        try {
            await this.orm.call("shahtaj.field.report", "message_post", [[report.id]], {
                body,
                message_type: "comment",
                subtype_xmlid: "mail.mt_comment",
            });
            this.state.draft = "";
            await this.loadThread();
        } catch (error) {
            this.notification.add(error.data?.message || error.message || "Could not send the message.", { type: "danger" });
        } finally {
            this.state.isSending = false;
        }
    }

    onDraftKeydown(ev) {
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            this.sendMessage();
        }
    }

    startTag() {
        this.state.editingTagId = null;
        this.state.tagForm = this._emptyTagForm();
        this.state.mode = "tag-form";
    }

    editTag(tag) {
        this.state.editingTagId = tag.id;
        this.state.tagForm = {
            name: tag.name,
            kind: tag.kind || "field_activity",
            color: Number(tag.color) || 0,
        };
        this.state.mode = "tag-form";
    }

    async uniqueCode(name, ignoreId) {
        const base = slugCode(name);
        let code = base;
        let suffix = 2;
        while (true) {
            const domain = [["code", "=", code]];
            if (ignoreId) {
                domain.push(["id", "!=", ignoreId]);
            }
            const count = await this.orm.searchCount("shahtaj.field.report.tag", domain);
            if (!count) {
                return code;
            }
            code = `${base}_${suffix}`;
            suffix += 1;
        }
    }

    async saveTag() {
        const form = this.state.tagForm;
        const name = (form.name || "").trim();
        if (!name) {
            this.notification.add("Tag name is required.", { type: "warning" });
            return;
        }
        this.state.isSaving = true;
        try {
            if (this.state.editingTagId) {
                await this.orm.write("shahtaj.field.report.tag", [this.state.editingTagId], {
                    name,
                    kind: form.kind,
                    color: Number(form.color) || 0,
                });
            } else {
                const code = await this.uniqueCode(name);
                await this.orm.create("shahtaj.field.report.tag", [{
                    name,
                    code,
                    kind: form.kind,
                    color: Number(form.color) || 0,
                }]);
            }
            await this.loadTags();
            this.state.mode = "list";
            this.state.editingTagId = null;
            this.notification.add("Tag saved.", { type: "success" });
        } catch (error) {
            this.notification.add(error.data?.message || error.message || "Could not save the tag.", { type: "danger" });
        } finally {
            this.state.isSaving = false;
        }
    }

    async deleteTag(tag) {
        this.state.isSaving = true;
        try {
            await this.orm.unlink("shahtaj.field.report.tag", [tag.id]);
            await this.loadTags();
        } catch (error) {
            this.notification.add(error.data?.message || error.message || "Could not delete the tag.", { type: "danger" });
        } finally {
            this.state.isSaving = false;
        }
    }

    get pageLabel() {
        const pages = Math.max(1, Math.ceil(this.state.total / this.state.pageSize));
        return `${this.state.page} / ${pages}`;
    }

    get statusSteps() {
        return STATUS_STEPS;
    }

    get colorOptions() {
        return ODOO_COLORS.map((hex, index) => ({ index, hex }));
    }

    stepClass(step) {
        const current = this.state.selected && this.state.selected.state;
        if (current === "cancelled") {
            return "bg-light text-muted border";
        }
        const order = { new: 0, in_progress: 1, done: 2 };
        if (step.key === current) {
            return "bg-dark text-white";
        }
        if ((order[step.key] || 0) < (order[current] || 0)) {
            return "bg-white text-dark border";
        }
        return "bg-light text-muted border";
    }
}
