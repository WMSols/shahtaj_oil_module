/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps, onMounted, onWillUnmount } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ConfirmModal } from "./confirm_modal";
import { hasFinancialAccess, notifyPortalBusy } from "../shahtaj_access";

export class StaffManagement extends Component {
    static components = { ConfirmModal };
    static props = {
        requestedStaffRole: { type: String, optional: true },
    };
    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        const ITEMS_PER_PAGE = 50;
        const initialRole = this.props.requestedStaffRole === "delivery_man"
            ? "delivery_man"
            : "order_booker";
        this.state = useState({
            activeTab: initialRole,
            viewMode: "list",
            detailTab: "schedules",
            selectedStaff: null,
            showForm: false,
            isLoading: false,
            showPassword: false,
            editingStaffId: null,

            detailSchedules: [],
            detailTargets: [],
            detailJobs: [],
            detailBookers: [],
            vanSnapshot: {
                qtyOnHand: 0,
                skuCount: 0,
                onVanForShops: 0,
                pickedToday: 0,
                deliveredToday: 0,
            },

            loading: {
                fetch: false,
                save: false,
                toggle: false,
                wallet: false,
            },
            confirmModal: {
                isOpen: false,
                title: "",
                message: "",
                onConfirm: null,
            },
            formData: {
                name: "",
                employee_code: "",
                email: "",
                password: "",
                role: initialRole,
            },
            settleModal: {
                open: false,
                wizardId: null,
                walletBalance: 0,
                amount: 0,
                bankJournalId: "",
                journals: [],
                notes: "",
            },
            itemsPerPage: ITEMS_PER_PAGE,
            searchTimeout: null,
            tableStaff: [],
            archivedStaffTable: [],
            pagination: {
                staff: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                archive: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                detailJobs: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            filters: {
                staff: { search: "", status: "all" },
                archive: { search: "" },
            },
        });

        this.pollingInterval = null;

        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchStaffData = this.debounceSearch(() => this.fetchStaffData(), 400);

        onWillStart(async () => {
            await this.fetchStaffData();
        });

        onWillUpdateProps((nextProps) => {
            const role = nextProps.requestedStaffRole;
            if (role && role !== this.state.activeTab && this.state.viewMode === "list" && !this.state.showForm) {
                this.switchTab(role);
            }
        });

        onMounted(() => {
            this.pollingInterval = setInterval(() => {
                if (!this.state.loading.save && !this.state.loading.toggle && !this.state.showForm && this.state.viewMode !== "detail") {
                    this.fetchStaffData(true);
                }
            }, 15000);
        });

        onWillUnmount(() => {
            if (this.pollingInterval) clearInterval(this.pollingInterval);
        });
    }

    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    get isDeliveryManTab() {
        return this.state.activeTab === "delivery_man";
    }

    onSearchInput(ev, tabName) {
        this.state.filters[tabName].search = ev.target.value;
        this.state.pagination[tabName].page = 1;
        this.debouncedFetchStaffData();
    }

    onFilterChange(tabName) {
        this.state.pagination[tabName].page = 1;
        this.fetchStaffData();
    }

    changePage(tabName, direction) {
        const pag = this.state.pagination[tabName];
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            if (tabName === "detailJobs") {
                this.fetchDetailJobs();
            } else {
                this.fetchStaffData();
            }
        }
    }

    _roleDomain() {
        if (this.isDeliveryManTab) {
            return [["shahtaj_is_delivery_man", "=", true]];
        }
        return [["shahtaj_is_order_booker", "=", true]];
    }

    _listFields() {
        const fields = [
            "id", "name", "shahtaj_employee_code", "shahtaj_online_status",
            "shahtaj_last_seen_at", "active", "login",
        ];
        if (this.isDeliveryManTab) {
            fields.push(
                "shahtaj_dm_jobs_today_count",
                "shahtaj_pending_delivery_count",
                "shahtaj_van_qty_on_hand",
                "shahtaj_dm_wallet_balance",
                "shahtaj_dm_job_count",
            );
        } else {
            fields.push(
                "shahtaj_task_today_total",
                "shahtaj_task_today_pending",
                "shahtaj_task_today_done",
                "shahtaj_active_target_progress",
                "shahtaj_active_target_summary",
            );
        }
        return fields;
    }

    _mapStaffRow(u) {
        const role = this.isDeliveryManTab ? "Delivery Man" : "Order Booker";
        return {
            id: u.id,
            name: u.name,
            login: u.login,
            employee_code: u.shahtaj_employee_code,
            role,
            roleKey: this.state.activeTab,
            status: u.shahtaj_online_status,
            active: u.active,
            last_seen_at: u.shahtaj_last_seen_at || false,
            last_seen_label: this.formatLastSeen(u.shahtaj_last_seen_at),
            jobsToday: u.shahtaj_dm_jobs_today_count || 0,
            openJobs: u.shahtaj_pending_delivery_count || 0,
            jobCount: u.shahtaj_dm_job_count || 0,
            vanQty: u.shahtaj_van_qty_on_hand || 0,
            wallet: u.shahtaj_dm_wallet_balance || 0,
            metrics: {
                today: {
                    total: u.shahtaj_task_today_total || 0,
                    pending: u.shahtaj_task_today_pending || 0,
                    completed: u.shahtaj_task_today_done || 0,
                },
                activeTarget: {
                    summary: u.shahtaj_active_target_summary,
                    progress: u.shahtaj_active_target_progress,
                },
            },
        };
    }

    async fetchStaffData(isBackgroundPoll = false) {
        if (!isBackgroundPoll) {
            this.state.loading.fetch = true;
            notifyPortalBusy(true);
        }
        try {
            const tab = this.state.viewMode === "archive" ? "archive" : "staff";
            const pag = this.state.pagination[tab];
            const filters = this.state.filters[tab];
            const domain = this._roleDomain();

            if (tab === "archive") {
                domain.push(["active", "=", false]);
            } else {
                domain.push(["active", "=", true]);
                if (filters.status === "online") domain.push(["shahtaj_online_status", "=", "online"]);
            }

            if (filters.search) {
                domain.push("|", ["name", "ilike", filters.search], ["shahtaj_employee_code", "ilike", filters.search]);
            }

            const queryKwargs = {
                limit: pag.limit,
                offset: (pag.page - 1) * pag.limit,
                order: "name asc",
            };
            if (tab === "archive") {
                queryKwargs.context = { active_test: false };
            }
            const [total, users] = await Promise.all([
                this.orm.searchCount("res.users", domain, tab === "archive" ? { context: { active_test: false } } : {}),
                this.orm.searchRead(
                    "res.users",
                    domain,
                    this._listFields(),
                    queryKwargs,
                ),
            ]);

            this.state.pagination[tab].total = total;
            const mapped = users.map((u) => this._mapStaffRow(u));
            if (tab === "archive") this.state.archivedStaffTable = mapped;
            else this.state.tableStaff = mapped;
        } catch (error) {
            if (!isBackgroundPoll) {
                this.notification.add("Failed to fetch data: " + (error.data?.message || error.message), { type: "danger" });
            }
        } finally {
            if (!isBackgroundPoll) {
                this.state.loading.fetch = false;
                notifyPortalBusy(false);
            }
        }
    }

    showConfirm(title, message, onConfirmCallback) {
        this.state.confirmModal = {
            isOpen: true,
            title,
            message,
            onConfirm: async () => {
                this.state.confirmModal.isOpen = false;
                await onConfirmCallback();
            },
        };
    }

    closeConfirm() {
        this.state.confirmModal.isOpen = false;
    }

    openArchive() {
        this.state.viewMode = "archive";
        this.state.pagination.archive.page = 1;
        this.fetchStaffData();
    }

    formatLastSeen(value) {
        if (!value) {
            return "Never seen";
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return String(value);
        }
        return date.toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    formatMoney(value) {
        const amount = Number(value) || 0;
        return amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    async openDetails(staff) {
        this.state.selectedStaff = staff;
        this.state.viewMode = "detail";
        if (staff.roleKey === "delivery_man" || this.isDeliveryManTab) {
            this.state.detailTab = "jobs";
            this.state.pagination.detailJobs.page = 1;
            await Promise.all([
                this.fetchDetailJobs(),
                this.fetchVanSnapshot(staff.id),
            ]);
            return;
        }

        const schedules = await this.orm.searchRead(
            "shahtaj.weekly.schedule",
            [["order_booker_id", "=", staff.id]],
            ["id", "day_of_week", "route_id", "zone_id", "active"],
            {
                context: { active_test: false },
                order: "day_of_week asc, active desc, id asc",
            },
        );
        const dayMap = {
            0: "Monday", 1: "Tuesday", 2: "Wednesday",
            3: "Thursday", 4: "Friday", 5: "Saturday", 6: "Sunday",
        };
        this.state.detailSchedules = schedules.map((s) => ({
            ...s,
            day: dayMap[s.day_of_week] || s.day_of_week,
        }));
        this.state.detailTargets = await this.orm.searchRead(
            "shahtaj.visit.target",
            [["order_booker_id", "=", staff.id]],
            ["id", "date_start", "date_end", "target_type", "target_value", "achieved_value", "progress_percent", "active"],
            {
                context: { active_test: false },
                order: "date_start desc, active desc, id desc",
            },
        );
        this.state.detailTab = "schedules";
    }

    async fetchDetailJobs() {
        const staff = this.state.selectedStaff;
        if (!staff) return;
        const pag = this.state.pagination.detailJobs;
        const domain = [["delivery_man_id", "=", staff.id]];
        const [total, jobs] = await Promise.all([
            this.orm.searchCount("shahtaj.dm.delivery", domain),
            this.orm.searchRead(
                "shahtaj.dm.delivery",
                domain,
                ["id", "display_name", "partner_id", "sale_order_id", "scheduled_date", "state", "field_state"],
                { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "scheduled_date desc, id desc" },
            ),
        ]);
        this.state.pagination.detailJobs.total = total;
        this.state.detailJobs = jobs.map((j) => ({
            id: j.id,
            name: j.display_name || (j.sale_order_id ? j.sale_order_id[1] : `Job ${j.id}`),
            shop: j.partner_id ? j.partner_id[1] : "—",
            order: j.sale_order_id ? j.sale_order_id[1] : "—",
            date: j.scheduled_date || "—",
            state: j.state,
            fieldState: j.field_state,
        }));
    }

    async fetchVanSnapshot(userId) {
        const [rec] = await this.orm.read(
            "res.users",
            [userId],
            [
                "shahtaj_van_qty_on_hand",
                "shahtaj_van_sku_count",
                "shahtaj_dm_on_van_for_shops",
                "shahtaj_dm_picked_today",
                "shahtaj_dm_delivered_today",
                "shahtaj_dm_wallet_balance",
                "shahtaj_dm_jobs_today_count",
                "shahtaj_pending_delivery_count",
            ],
        );
        if (!rec) return;
        this.state.vanSnapshot = {
            qtyOnHand: rec.shahtaj_van_qty_on_hand || 0,
            skuCount: rec.shahtaj_van_sku_count || 0,
            onVanForShops: rec.shahtaj_dm_on_van_for_shops || 0,
            pickedToday: rec.shahtaj_dm_picked_today || 0,
            deliveredToday: rec.shahtaj_dm_delivered_today || 0,
        };
        if (this.state.selectedStaff) {
            this.state.selectedStaff.wallet = rec.shahtaj_dm_wallet_balance || 0;
            this.state.selectedStaff.jobsToday = rec.shahtaj_dm_jobs_today_count || 0;
            this.state.selectedStaff.openJobs = rec.shahtaj_pending_delivery_count || 0;
            this.state.selectedStaff.vanQty = rec.shahtaj_van_qty_on_hand || 0;
        }
    }

    switchTab(tabName) {
        this.state.activeTab = tabName;
        this.state.viewMode = "list";
        this.state.showForm = false;
        this.state.pagination.staff.page = 1;
        this.state.formData.role = tabName;
        this.fetchStaffData();
    }

    goBack() {
        this.state.selectedStaff = null;
        this.state.viewMode = "list";
        this.fetchStaffData();
    }

    openForm() {
        this.state.formData = {
            name: "",
            employee_code: "",
            email: "",
            password: "",
            role: this.state.activeTab,
        };
        this.state.editingStaffId = null;
        this.state.showForm = true;
    }

    cancelForm() {
        this.state.showForm = false;
        this.state.showPassword = false;
        this.state.editingStaffId = null;
        this.state.formData = {
            name: "",
            employee_code: "",
            email: "",
            password: "",
            role: this.state.activeTab,
        };
    }

    editStaff(staff) {
        this.state.formData = {
            name: staff.name,
            employee_code: staff.employee_code || "",
            email: staff.login || "",
            password: "",
            role: staff.roleKey || this.state.activeTab,
        };
        this.state.editingStaffId = staff.id;
        this.state.showForm = true;
    }

    async saveStaff() {
        this.state.loading.save = true;
        try {
            const role = this.state.formData.role || this.state.activeTab;
            if (this.state.editingStaffId) {
                const payload = {
                    name: this.state.formData.name,
                    login: this.state.formData.email,
                    shahtaj_employee_code: this.state.formData.employee_code,
                };
                if (this.state.formData.password) {
                    payload.password = this.state.formData.password;
                }
                await this.orm.write("res.users", [this.state.editingStaffId], payload);
            } else if (role === "delivery_man") {
                const wizardIds = await this.orm.create("shahtaj.create.delivery.man.wizard", [{
                    name: this.state.formData.name,
                    login: this.state.formData.email,
                    password: this.state.formData.password,
                    shahtaj_employee_code: this.state.formData.employee_code,
                }]);
                await this.orm.call("shahtaj.create.delivery.man.wizard", "action_create_delivery_man", [wizardIds]);
            } else {
                const wizardIds = await this.orm.create("shahtaj.create.order.booker.wizard", [{
                    name: this.state.formData.name,
                    login: this.state.formData.email,
                    password: this.state.formData.password,
                    shahtaj_employee_code: this.state.formData.employee_code,
                }]);
                await this.orm.call("shahtaj.create.order.booker.wizard", "action_create_booker", [wizardIds]);
            }
            this.cancelForm();
            await this.fetchStaffData();
        } catch (error) {
            console.error("Save failed:", error);
            const errorMessage = error.data?.message || error.message || "Unknown error occurred";
            this.notification.add(`Failed to save staff:\n\n${errorMessage}`, { type: "danger" });
        } finally {
            this.state.loading.save = false;
        }
    }

    toggleActiveStatus(staffId, currentStatus) {
        const newStatus = !currentStatus;
        const actionTitle = newStatus ? "Restore Account" : "Deactivate & Archive Account";
        const actionMessage = newStatus
            ? "Are you sure you want to restore this user? They will regain access to the mobile application."
            : "Are you sure you want to deactivate this user? They will be moved to the archive and immediately lose access to the system.";
        this.showConfirm(actionTitle, actionMessage, () => this.executeToggleStatus(staffId, newStatus));
    }

    async executeToggleStatus(staffId, newStatus) {
        this.state.loading.toggle = true;
        try {
            const isDm = this.isDeliveryManTab || this.state.selectedStaff?.roleKey === "delivery_man";
            const methodName = isDm
                ? (newStatus ? "action_shahtaj_activate_delivery_man" : "action_shahtaj_deactivate_delivery_man")
                : (newStatus ? "action_shahtaj_activate_booker" : "action_shahtaj_deactivate_booker");
            await this.orm.call("res.users", methodName, [[staffId]]);
            await this.fetchStaffData();
            if (this.state.selectedStaff && this.state.selectedStaff.id === staffId) {
                this.state.selectedStaff.active = newStatus;
            }
        } catch (error) {
            console.error("Failed to toggle status:", error);
            this.notification.add("An error occurred while updating the status.", { type: "danger" });
        } finally {
            this.state.loading.toggle = false;
        }
    }

    async openSettleModal() {
        if (!this.state.selectedStaff) return;
        this.state.loading.wallet = true;
        try {
            const wizardIds = await this.orm.create(
                "shahtaj.dm.wallet.settle",
                [{}],
                { context: { default_delivery_man_id: this.state.selectedStaff.id, active_model: "res.users", active_id: this.state.selectedStaff.id } },
            );
            const wizardId = Array.isArray(wizardIds) ? wizardIds[0] : wizardIds;
            const [wiz] = await this.orm.read(
                "shahtaj.dm.wallet.settle",
                [wizardId],
                ["wallet_balance", "amount", "bank_journal_id", "notes"],
            );
            const journals = await this.orm.searchRead(
                "account.journal",
                [["type", "in", ["bank", "cash"]], ["code", "!=", "DMCASH"]],
                ["id", "name"],
                { limit: 40, order: "name asc" },
            );
            this.state.settleModal = {
                open: true,
                wizardId,
                walletBalance: wiz.wallet_balance || 0,
                amount: wiz.amount || 0,
                bankJournalId: wiz.bank_journal_id ? String(wiz.bank_journal_id[0]) : "",
                journals,
                notes: wiz.notes || "",
            };
        } catch (error) {
            this.notification.add("Failed to open settle: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.loading.wallet = false;
        }
    }

    closeSettleModal() {
        this.state.settleModal.open = false;
        this.state.settleModal.wizardId = null;
    }

    async confirmSettle() {
        if (!this.state.settleModal.wizardId) return;
        this.state.loading.wallet = true;
        try {
            await this.orm.write("shahtaj.dm.wallet.settle", [this.state.settleModal.wizardId], {
                amount: Number(this.state.settleModal.amount) || 0,
                bank_journal_id: parseInt(this.state.settleModal.bankJournalId, 10),
                notes: this.state.settleModal.notes || "",
            });
            await this.orm.call("shahtaj.dm.wallet.settle", "action_confirm", [[this.state.settleModal.wizardId]]);
            this.notification.add("Wallet settled to bank.", { type: "success" });
            this.closeSettleModal();
            await this.fetchVanSnapshot(this.state.selectedStaff.id);
        } catch (error) {
            this.notification.add("Settle failed: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.loading.wallet = false;
        }
    }

    stockStateLabel(state) {
        const map = {
            not_ready: "Not ready",
            ready: "Ready",
            picked: "Picked",
            partial: "Partial",
            delivered: "Delivered",
            returned: "Returned",
        };
        return map[state] || state || "—";
    }

    stockStateBadgeClass(state) {
        const map = {
            not_ready: "bg-danger text-white",
            ready: "bg-info text-white",
            picked: "bg-warning text-dark",
            partial: "bg-warning text-dark",
            delivered: "bg-success text-white",
            returned: "bg-danger text-white",
        };
        return map[state] || "bg-secondary text-white";
    }

    fieldStateLabel(state) {
        const map = {
            pending: "Pending",
            in_transit: "In transit",
            done: "Done",
            not_attended: "Shop closed",
            failed: "Failed",
        };
        return map[state] || state || "—";
    }

    fieldStateBadgeClass(state) {
        const map = {
            pending: "bg-warning text-dark",
            in_transit: "bg-info text-white",
            not_attended: "bg-warning text-dark",
            failed: "bg-danger text-white",
            done: "bg-success text-white",
        };
        return map[state] || "bg-secondary text-white";
    }
}

StaffManagement.template = "shahtaj_oil.StaffManagement";
