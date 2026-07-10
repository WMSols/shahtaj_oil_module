/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class SchedulesTargets extends Component {
    setup() {
        this.orm = useService("orm");
        this.state = useState({
            activeMainTab: 'schedules',
            viewMode: 'list',
            selectedBooker: null,
            showForm: false,
            errorMessage: '',
            isLoading: false,

            // Edit Tracking
            editingScheduleId: null,
            editingTargetId: null,

            // Form Data
            scheduleForm: { day: '', route_id: '', zone_name: '', is_active: true },
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

        onWillStart(async () => {
            await this._loadDropdownOptions();
            await this._loadBookers();
        });
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
        const [routes, products, currencies] = await Promise.all([
            this.orm.searchRead(
                'shahtaj.route',
                [['active', '=', true]],
                ['id', 'name', 'zone_id']
            ),
            this.orm.searchRead(
                'product.product',
                [],
                ['id', 'name']
            ),
            this.orm.searchRead(
                'res.currency',
                [['active', '=', true]],
                ['id', 'name']
            ),
        ]);

        this.state.routes = routes.map(r => ({
            id: r.id,
            name: r.name,
            zone_name: r.zone_id ? r.zone_id[1] : '',
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
        this.state.scheduleForm = { day: '', route_id: '', zone_name: '', is_active: true };
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
            is_active: sched.status === 'Active'
        };
        this.state.editingScheduleId = sched.id;
        this.state.showForm = true;
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

    // ─── Save: Schedule ──────────────────────────────────────────────────────────

    async saveSchedule() {
        const form = this.state.scheduleForm;

        if (!form.day || !form.route_id) {
            this.state.errorMessage = 'Day and Route are required.';
            return;
        }

        // Only check for duplicate days if creating new, OR if updating and day changed
        const dayExists = this.currentBookerSchedules.some(s => s.day_raw.toString() === form.day && s.id !== this.state.editingScheduleId);
        if (dayExists) {
            this.state.errorMessage = `A schedule for this day already exists for this Order Booker.`;
            return;
        }

        this.state.isLoading = true;
        this.state.errorMessage = '';

        try {
            const payload = {
                order_booker_id: this.state.selectedBooker.id,
                day_of_week: form.day,
                route_id: parseInt(form.route_id),
                active: form.is_active,
            };

            if (this.state.editingScheduleId) {
                await this.orm.write('shahtaj.weekly.schedule', [this.state.editingScheduleId], payload);
            } else {
                await this.orm.create('shahtaj.weekly.schedule', [payload]);
            }

            this.state.showForm = false;
            await this._loadBookerSchedules(this.state.selectedBooker.id);
        } catch (error) {
            this.state.errorMessage = error.data?.message || error.message || 'Failed to save schedule.';
        } finally {
            this.state.isLoading = false;
        }
    }

    // ─── Save: Target ────────────────────────────────────────────────────────────

    async saveTarget() {
        const form = this.state.targetForm;

        if (!form.startDate || !form.endDate || !form.type || !form.target_value) {
            this.state.errorMessage = 'Start Date, End Date, Target Type, and Target Value are required.';
            return;
        }

        if (new Date(form.endDate) < new Date(form.startDate)) {
            this.state.errorMessage = 'End Date cannot be earlier than Start Date.';
            return;
        }

        if (form.type === 'product_qty' && !form.product_id) {
            this.state.errorMessage = 'A product is required for Product Quantity targets.';
            return;
        }

        if (form.type === 'product_weight' && !form.product_id) {
            this.state.errorMessage = 'A product is required for Product Weight targets.';
            return;
        }

        if (form.type === 'product_weight' && !form.target_weight_uom) {
            this.state.errorMessage = 'Select kg or ton for the weight target.';
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

            // Fix: Parse Int for IDs to prevent Odoo validation crashes
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
            } else {
                await this.orm.create('shahtaj.visit.target', [payload]);
            }

            this.state.showForm = false;
            await this._loadBookerTargets(this.state.selectedBooker.id);
        } catch (error) {
            this.state.errorMessage = error.data?.message || error.message || 'Failed to save target.';
        } finally {
            this.state.isLoading = false;
        }
    }

    // ─── Delete ──────────────────────────────────────────────────────────────────

    async deleteSchedule(scheduleId) {
        if (!confirm("Are you sure you want to delete this schedule?")) return;
        const schedule = this.state.schedules.find(s => s.id === scheduleId);
        if (schedule?.isLocked) {
            this.state.errorMessage = "Cannot delete today's schedule — visits are already in progress.";
            return;
        }
        try {
            await this.orm.unlink('shahtaj.weekly.schedule', [scheduleId]);
            await this._loadBookerSchedules(this.state.selectedBooker.id);
        } catch (error) {
            this.state.errorMessage = error.data?.message || error.message;
        }
    }

    async deleteTarget(targetId) {
        if (!confirm("Are you sure you want to delete this target?")) return;
        try {
            await this.orm.unlink('shahtaj.visit.target', [targetId]);
            await this._loadBookerTargets(this.state.selectedBooker.id);
        } catch (error) {
            this.state.errorMessage = error.data?.message || error.message;
        }
    }
}

SchedulesTargets.template = "shahtaj_oil.SchedulesTargets";