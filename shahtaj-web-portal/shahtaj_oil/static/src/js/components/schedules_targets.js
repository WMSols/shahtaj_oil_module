/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class SchedulesTargets extends Component {
    static props = {
        requestedSubTab: { type: String, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");

        this.state = useState({
            activeMainTab: this.props.requestedSubTab || 'schedules',
            viewMode: 'list',
            selectedBooker: null,
            showForm: false,
            errorMessage: '',
            isLoading: false,
            isRefreshing: false,

            // Edit Tracking
            editingScheduleId: null,
            editingTargetId: null,

            // --- Custom Delete Modal States ---
            showDeleteModal: false,
            deleteType: null, // 'schedule' or 'target'
            deleteId: null,
            deleteTitle: '',

            // Form Data
            scheduleForm: {
                day: '', route_id: '', zone_name: '', is_active: true, operational_shop_count: null,
            },
            targetForm: {
                startDate: '', endDate: '', is_active: true,
                type: '', target_value: '', product_id: '', currency_id: '',
                target_weight_uom: 'kg',
            },

            // Real data
            bookers: [],
            schedules: [],
            targets: [],

            // Dropdown options loaded from DB
            routes: [],       
            products: [],     
            currencies: [],   
        });

        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab && nextProps.requestedSubTab !== this.state.activeMainTab) {
                this.setSubTab(nextProps.requestedSubTab);
            }
        });

        onWillStart(async () => {
            await this._loadDropdownOptions();
            await this._loadBookers();
        });
    }

    async refreshData() {
        this.state.isRefreshing = true;
        try {
            await this._loadDropdownOptions();
            await this._loadBookers();
            
            if (this.state.viewMode === 'detail' && this.state.selectedBooker) {
                await Promise.all([
                    this._loadBookerSchedules(this.state.selectedBooker.id),
                    this._loadBookerTargets(this.state.selectedBooker.id)
                ]);
            }
            this.notification.add("Data refreshed successfully.", { type: "info" });
        } catch (error) {
            this.notification.add("Failed to refresh data: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isRefreshing = false;
        }
    }

    setSubTab(tabName) {
        this.state.activeMainTab = tabName;
        this.state.viewMode = 'list';
        this.state.showForm = false;
        this.state.errorMessage = '';
        this.state.editingScheduleId = null;
        this.state.editingTargetId = null;
    }

    // ─── Loaders ────────────────────────────────────────────────────────────────

    async _loadBookers() {
        const users = await this.orm.searchRead(
            'res.users',
            [['shahtaj_is_order_booker', '=', true]],
            ['id', 'name', 'shahtaj_employee_code', 'zone_id', 'route_id']
        );
        this.state.bookers = users.map(u => ({
            id: u.id,
            name: u.name,
            employee_code: u.shahtaj_employee_code || '',
            zone: u.zone_id ? u.zone_id[1] : 'Unassigned',
            route: u.route_id ? u.route_id[1] : 'Unassigned',
        }));
    }

    async _loadDropdownOptions() {
        const [routes, zones, products, currencies] = await Promise.all([
            this.orm.searchRead('shahtaj.route', [['active', '=', true]], ['id', 'name', 'zone_id']),
            this.orm.searchRead('shahtaj.zone', [['active', '=', true]], ['id']),
            this.orm.searchRead('product.product', [
                ['sale_ok', '=', true],
                ['active', '=', true],
                ['default_code', '!=', 'SHAHTAJ-LEGACY'],
            ], ['id', 'name']),
            this.orm.searchRead('res.currency', [['active', '=', true]], ['id', 'name']),
        ]);
        const activeZoneIds = new Set(zones.map((zone) => zone.id));

        this.state.routes = routes
            .filter((route) => route.zone_id && activeZoneIds.has(route.zone_id[0]))
            .map((route) => ({
                id: route.id,
                name: route.name,
                zone_name: route.zone_id ? route.zone_id[1] : '',
            }));
        this.state.products = products.map(p => ({ id: p.id, name: p.name }));
        this.state.currencies = currencies.map(c => ({ id: c.id, name: c.name }));
    }

    async _loadBookerSchedules(bookerId) {
        const records = await this.orm.searchRead(
            'shahtaj.weekly.schedule',
            [['order_booker_id', '=', bookerId]],
            [
                'id', 'name', 'day_of_week', 'route_id', 'zone_id',
                'active', 'shop_count', 'is_day_locked',
                'week_tasks_planned', 'week_tasks_completed', 'week_tasks_progress',
                'week_occurrence_date'
            ]
        );
        
        const dayMap = {
            '0': 'Monday', '1': 'Tuesday', '2': 'Wednesday', '3': 'Thursday',
            '4': 'Friday', '5': 'Saturday', '6': 'Sunday'
        };

        this.state.schedules = records.map(r => ({
            id: r.id,
            bookerId: bookerId,
            name: r.name,
            day_raw: r.day_of_week, 
            day: dayMap[r.day_of_week] || r.day_of_week,
            route_id: r.route_id ? r.route_id[0] : '',
            route: r.route_id ? r.route_id[1] : '',
            zone: r.zone_id ? r.zone_id[1] : '',    
            status: r.active ? 'Active' : 'Inactive',
            shops: r.shop_count,
            isLocked: r.is_day_locked,
            planned: r.week_tasks_planned,
            done: r.week_tasks_completed,
            progress: r.week_tasks_progress ? `${r.week_tasks_progress.toFixed(0)}%` : '0%',
            occurrenceDate: r.week_occurrence_date || '',
        }));
    }

    async _loadBookerTargets(bookerId) {
        const records = await this.orm.searchRead(
            'shahtaj.visit.target',
            [['order_booker_id', '=', bookerId]],
            [
                'id', 'name', 'date_start', 'date_end', 'target_type',
                'target_value', 'achieved_value', 'remaining_value', 'progress_percent',
                'product_id', 'currency_id', 'target_weight_uom', 'active'
            ]
        );
        this.state.targets = records.map(r => ({
            id: r.id,
            bookerId: bookerId,
            name: r.name,
            startDate: r.date_start,
            endDate: r.date_end,
            type: r.target_type,
            amount: r.target_value,
            achievedAmount: r.achieved_value,
            remainingAmount: r.remaining_value,
            weightUom: r.target_weight_uom || null,
            progressPercentage: r.progress_percent ? `${r.progress_percent.toFixed(1)}%` : '0%',
            product_id_raw: r.product_id ? r.product_id[0] : '',
            product: r.product_id ? r.product_id[1] : null,
            currency_id_raw: r.currency_id ? r.currency_id[0] : '',
            currency: r.currency_id ? r.currency_id[1] : null,
            status: r.active ? 'Active' : 'Inactive',
        }));
    }

    // ─── Navigation ─────────────────────────────────────────────────────────────

    switchMainTab(tab) {
        this.state.activeMainTab = tab;
        this.state.viewMode = 'list';
        this.state.selectedBooker = null;
        this.state.showForm = false;
        this.state.errorMessage = '';
        this.state.editingScheduleId = null;
        this.state.editingTargetId = null;
        this.state.schedules = [];
        this.state.targets = [];
    }

    async openBookerDetails(booker) {
        this.state.selectedBooker = booker;
        this.state.viewMode = 'detail';
        this.state.showForm = false;
        this.state.errorMessage = '';
        this.state.editingScheduleId = null;
        this.state.editingTargetId = null;
        this.state.isLoading = true;

        await Promise.all([
            this._loadBookerSchedules(booker.id),
            this._loadBookerTargets(booker.id),
        ]);

        this.state.isLoading = false;
    }

    goBackToList() {
        this.state.viewMode = 'list';
        this.state.selectedBooker = null;
        this.state.showForm = false;
        this.state.errorMessage = '';
        this.state.editingScheduleId = null;
        this.state.editingTargetId = null;
        this.state.schedules = [];
        this.state.targets = [];
    }

    openForm() {
        this.state.showForm = true;
        this.state.errorMessage = '';
        this.state.editingScheduleId = null;
        this.state.editingTargetId = null;
        this.state.scheduleForm = {
            day: '', route_id: '', zone_name: '', is_active: true, operational_shop_count: null,
        };
        this.state.targetForm = {
            startDate: '', endDate: '', is_active: true,
            type: '', target_value: '', product_id: '', currency_id: '',
            target_weight_uom: 'kg',
        };
    }

    // ─── Editing ─────────────────────────────────────────────────────────────────

    editSchedule(sched) {
        this.state.errorMessage = '';
        this.state.scheduleForm = {
            day: sched.day_raw.toString(),
            route_id: sched.route_id,
            zone_name: sched.zone,
            is_active: sched.status === 'Active',
            operational_shop_count: sched.shops,
        };
        this.state.editingScheduleId = sched.id;
        this.state.showForm = true;
        if (sched.route_id) {
            this.refreshScheduleRouteShopCount(parseInt(sched.route_id));
        }
    }

    async refreshScheduleRouteShopCount(routeId) {
        if (!routeId) {
            this.state.scheduleForm.operational_shop_count = null;
            return;
        }
        this.state.scheduleForm.operational_shop_count = await this.orm.searchCount('res.partner', [
            ['route_id', '=', routeId],
            ['is_shahtaj_shop', '=', true],
            ['active', '=', true],
            ['shop_approval_state', '=', 'approved'],
        ]);
    }

    onScheduleRouteChange(ev) {
        const routeId = parseInt(ev.target.value, 10);
        this.refreshScheduleRouteShopCount(Number.isNaN(routeId) ? null : routeId);
    }

    editTarget(tgt) {
        this.state.errorMessage = '';
        this.state.targetForm = {
            startDate: tgt.startDate,
            endDate: tgt.endDate,
            type: tgt.type,
            target_value: tgt.amount,
            product_id: tgt.product_id_raw,
            currency_id: tgt.currency_id_raw,
            target_weight_uom: tgt.weightUom || 'kg',
            is_active: tgt.status === 'Active'
        };
        this.state.editingTargetId = tgt.id;
        this.state.showForm = true;
    }

    // ─── Getters ─────────────────────────────────────────────────────────────────

    get currentBookerSchedules() {
        return this.state.schedules.filter(s => s.bookerId === this.state.selectedBooker?.id);
    }

    get currentBookerTargets() {
        return this.state.targets.filter(t => t.bookerId === this.state.selectedBooker?.id);
    }
    
    get uniqueZones() {
        const seen = new Set();
        return this.state.routes
            .map(r => r.zone_name)
            .filter(z => z && !seen.has(z) && seen.add(z));
    }

    get filteredRoutes() {
        const zone = this.state.scheduleForm.zone_name;
        if (!zone) return this.state.routes;
        return this.state.routes.filter(r => r.zone_name === zone);
    }

    // ─── Save Handlers ──────────────────────────────────────────────────────────

    async saveSchedule() {
        const form = this.state.scheduleForm;

        if (!form.day || !form.route_id) {
            const msg = 'Day and Route are required.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }

        const activeDayConflict = this.currentBookerSchedules.some(
            (s) => s.day_raw.toString() === form.day
                && s.status === 'Active'
                && s.id !== this.state.editingScheduleId
        );
        if (activeDayConflict) {
            const msg = 'An active schedule for this day already exists. Edit that row or deactivate it first.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }

        let editingScheduleId = this.state.editingScheduleId;
        if (!editingScheduleId) {
            const inactiveExisting = this.currentBookerSchedules.find(
                (s) => s.day_raw.toString() === form.day && s.status === 'Inactive'
            );
            if (inactiveExisting) {
                editingScheduleId = inactiveExisting.id;
                this.notification.add(
                    `Reactivating the existing inactive ${inactiveExisting.day} schedule.`,
                    { type: "info" }
                );
            }
        }

        const routeId = parseInt(form.route_id, 10);
        const operationalShopCount = await this.orm.searchCount('res.partner', [
            ['route_id', '=', routeId],
            ['is_shahtaj_shop', '=', true],
            ['active', '=', true],
            ['shop_approval_state', '=', 'approved'],
        ]);

        if (form.is_active && operationalShopCount === 0) {
            this.notification.add(
                'This route has no active approved shops. The order booker will not see visits until shops are assigned and active.',
                { type: "warning" }
            );
        }

        this.state.isLoading = true;
        this.state.errorMessage = '';

        try {
            const payload = {
                order_booker_id: this.state.selectedBooker.id,
                day_of_week: form.day,
                route_id: routeId,
                active: form.is_active,
            };

            if (editingScheduleId) {
                await this.orm.write('shahtaj.weekly.schedule', [editingScheduleId], payload);
                this.notification.add("Schedule updated successfully.", { type: "success" });
            } else {
                await this.orm.create('shahtaj.weekly.schedule', [payload]);
                this.notification.add("Schedule created successfully.", { type: "success" });
            }

            this.state.showForm = false;
            await this._loadBookerSchedules(this.state.selectedBooker.id);
        } catch (error) {
            const msg = error.data?.message || error.message || 'Failed to save schedule.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }

    async saveTarget() {
        const form = this.state.targetForm;

        if (!form.startDate || !form.endDate || !form.type || !form.target_value) {
            const msg = 'Start Date, End Date, Target Type, and Target Value are required.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }

        if (new Date(form.endDate) < new Date(form.startDate)) {
            const msg = 'End Date cannot be earlier than Start Date.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }

        if (form.type === 'product_qty' && !form.product_id) {
            const msg = 'A product is required for Product Quantity targets.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }

        if (form.type === 'product_weight' && !form.product_id) {
            const msg = 'A product is required for Product Weight targets.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }

        if (form.type === 'product_weight' && !form.target_weight_uom) {
            const msg = 'Select kg or ton for the weight target.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }

        this.state.isLoading = true;
        this.state.errorMessage = '';

        try {
            const payload = {
                order_booker_id: this.state.selectedBooker.id,
                date_start: form.startDate,
                date_end: form.endDate,
                target_type: form.type,
                target_value: parseFloat(form.target_value),
                active: form.is_active,
            };

            if (['product_qty', 'product_weight'].includes(form.type) && form.product_id) {
                payload.product_id = parseInt(form.product_id);
            }
            if (form.type === 'product_weight') {
                payload.target_weight_uom = form.target_weight_uom || 'kg';
            }
            if (form.type === 'sales_amount' && form.currency_id) {
                payload.currency_id = parseInt(form.currency_id);
            }

            if (this.state.editingTargetId) {
                await this.orm.write('shahtaj.visit.target', [this.state.editingTargetId], payload);
                this.notification.add("Target updated successfully.", { type: "success" });
            } else {
                await this.orm.create('shahtaj.visit.target', [payload]);
                this.notification.add("Target created successfully.", { type: "success" });
            }

            this.state.showForm = false;
            await this._loadBookerTargets(this.state.selectedBooker.id);
        } catch (error) {
            const msg = error.data?.message || error.message || 'Failed to save target.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }

    // ─── Custom Delete Modal Handlers ───────────────────────────────────────────

    promptDeleteSchedule(sched) {
        if (sched.isLocked) {
            const msg = "Cannot delete today's schedule — visits are already in progress.";
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }
        this.state.deleteType = 'schedule';
        this.state.deleteId = sched.id;
        this.state.deleteTitle = `${sched.day} schedule (${sched.route})`;
        this.state.showDeleteModal = true;
    }

    promptDeleteTarget(tgt) {
        const typeDisplay = tgt.type ? tgt.type.replace('_', ' ') : 'Target';
        this.state.deleteType = 'target';
        this.state.deleteId = tgt.id;
        this.state.deleteTitle = `${typeDisplay} (${tgt.amount} ${tgt.weightUom || ''})`;
        this.state.showDeleteModal = true;
    }

    closeDeleteModal() {
        this.state.showDeleteModal = false;
        this.state.deleteType = null;
        this.state.deleteId = null;
        this.state.deleteTitle = '';
    }

    async confirmDelete() {
        if (!this.state.deleteId || !this.state.deleteType) return;
        this.state.isLoading = true;

        try {
            if (this.state.deleteType === 'schedule') {
                await this.orm.unlink('shahtaj.weekly.schedule', [this.state.deleteId]);
                this.notification.add("Schedule deleted successfully.", { type: "success" });
                await this._loadBookerSchedules(this.state.selectedBooker.id);
            } else if (this.state.deleteType === 'target') {
                await this.orm.unlink('shahtaj.visit.target', [this.state.deleteId]);
                this.notification.add("Target deleted successfully.", { type: "success" });
                await this._loadBookerTargets(this.state.selectedBooker.id);
            }
        } catch (error) {
            const msg = error.data?.message || error.message || "Deletion failed.";
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "danger" });
        } finally {
            this.state.isLoading = false;
            this.closeDeleteModal();
        }
    }
}

SchedulesTargets.template = "shahtaj_oil.SchedulesTargets";