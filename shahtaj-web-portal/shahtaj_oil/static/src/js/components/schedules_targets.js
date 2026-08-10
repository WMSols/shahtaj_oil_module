/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class SchedulesTargets extends Component {
    static props = {
        requestedSubTab: { type: String, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        const ITEMS_PER_PAGE = 10;
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
                lines: [],
                expandedId: null,
            },

            // Real data
            schedules: [],
            targets: [],

            // Dropdown options loaded from DB
            routes: [],       
            products: [],     
            currencies: [],   
            // --- BACKEND PAGINATION ---
            itemsPerPage: ITEMS_PER_PAGE,
            isLoadingList: false,
            searchTimeout: null,
            tableBookers: [],
            pagination: {
                bookers: { page: 1, limit: ITEMS_PER_PAGE, total: 0 }
            },
            filters: {
                bookers: { search: '' }
            },
        });

        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab && nextProps.requestedSubTab !== this.state.activeMainTab) {
                this.setSubTab(nextProps.requestedSubTab);
            }
        });

       this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchBookers = this.debounceSearch(() => this.fetchBookersList(), 400);

        onWillStart(async () => {
            await this._loadDropdownOptions();
            await this.fetchBookersList();
        });
    }
    onSearchInput(ev) {
        this.state.filters.bookers.search = ev.target.value;
        this.state.pagination.bookers.page = 1; 
        this.debouncedFetchBookers();
    }

    changePage(direction) {
        const pag = this.state.pagination.bookers;
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchBookersList();
        }
    }

    async fetchBookersList() {
        this.state.isLoadingList = true;
        try {
            const pag = this.state.pagination.bookers;
            let domain = [['shahtaj_is_order_booker', '=', true]];
            
            if (this.state.filters.bookers.search) {
                domain.push('|', 
                    ['name', 'ilike', this.state.filters.bookers.search], 
                    ['shahtaj_employee_code', 'ilike', this.state.filters.bookers.search]
                );
            }

            const [total, users] = await Promise.all([
                this.orm.searchCount('res.users', domain),
                // Swapped zone/route for standard login and phone fields
                this.orm.searchRead('res.users', domain, ['id', 'name', 'shahtaj_employee_code', 'login', 'phone'], {
                    limit: pag.limit,
                    offset: (pag.page - 1) * pag.limit,
                    order: "name asc"
                })
            ]);

            this.state.pagination.bookers.total = total;
            this.state.tableBookers = users.map(u => ({
                id: u.id,
                name: u.name,
                employee_code: u.shahtaj_employee_code || '',
                login: u.login || 'No Login ID',
                phone: u.phone || 'No Phone Recorded',
            }));
        } catch (error) {
            this.notification.add("Failed to fetch bookers: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }

    async refreshData() {
        this.state.isRefreshing = true;
        try {
            await this._loadDropdownOptions();
            await this.fetchBookersList();
            
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



    async _loadDropdownOptions() {
        const [routes, zones, products, currencies] = await Promise.all([
            this.orm.searchRead('shahtaj.route', [['active', '=', true]], ['id', 'name', 'zone_id']),
            this.orm.searchRead('shahtaj.zone', [['active', '=', true]], ['id']),
            this.orm.searchRead('product.product', [
                ['sale_ok', '=', true],
                ['active', '=', true],
                ['product_tmpl_id.active', '=', true],
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
        // Include deactivated rows so distributors can reactivate/edit/delete
        // (unique is one row per booker/day including inactive).
        const records = await this.orm.searchRead(
            'shahtaj.weekly.schedule',
            [['order_booker_id', '=', bookerId]],
            [
                'id', 'name', 'day_of_week', 'route_id', 'zone_id',
                'active', 'shop_count', 'is_day_locked',
                'week_tasks_planned', 'week_tasks_completed', 'week_tasks_progress',
                'week_occurrence_date'
            ],
            {
                context: { active_test: false },
                order: 'day_of_week asc, active desc, id asc',
            },
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
            status: r.active ? 'Active' : 'Deactivated',
            isActive: !!r.active,
            shops: r.shop_count,
            isLocked: r.is_day_locked,
            planned: r.week_tasks_planned,
            done: r.week_tasks_completed,
            progress: r.week_tasks_progress ? `${r.week_tasks_progress.toFixed(0)}%` : '0%',
            occurrenceDate: r.week_occurrence_date || '',
        }));
    }

    async _loadBookerTargets(bookerId) {
        // Include deactivated targets so distributors can reactivate/edit/delete.
        const records = await this.orm.searchRead(
            'shahtaj.visit.target',
            [['order_booker_id', '=', bookerId]],
            [
                'id', 'name', 'date_start', 'date_end', 'target_type',
                'target_value', 'achieved_value', 'remaining_value', 'progress_percent',
                'product_id', 'currency_id', 'target_weight_uom', 'active'
            ],
            {
                context: { active_test: false },
                order: 'date_start desc, active desc, id desc',
            },
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
            progress: r.progress_percent || 0,
            progressPercentage: r.progress_percent ? `${r.progress_percent.toFixed(1)}%` : '0%',
            progressWidth: Math.max(0, Math.min(100, r.progress_percent || 0)),
            product_id_raw: r.product_id ? r.product_id[0] : '',
            product: r.product_id ? r.product_id[1] : null,
            currency_id_raw: r.currency_id ? r.currency_id[0] : '',
            currency: r.currency_id ? r.currency_id[1] : null,
            status: r.active ? 'Active' : 'Deactivated',
            isActive: !!r.active,
            lines: [],
            isExpandable: ['collective_qty', 'collective_weight', 'product_bundle'].includes(r.target_type),
            expanded: false,
        }));

        const multiIds = this.state.targets.filter(t => t.isExpandable).map(t => t.id);
        if (multiIds.length) {
            const lines = await this.orm.searchRead(
                'shahtaj.visit.target.line',
                [['target_id', 'in', multiIds]],
                [
                    'id', 'target_id', 'product_id', 'measure_type', 'target_value',
                    'target_weight_uom', 'achieved_value', 'remaining_value', 'progress_percent',
                ],
            );
            const byTarget = {};
            lines.forEach((line) => {
                const tid = line.target_id[0];
                if (!byTarget[tid]) {
                    byTarget[tid] = [];
                }
                byTarget[tid].push({
                    id: line.id,
                    product_id: line.product_id ? line.product_id[0] : '',
                    product_name: line.product_id ? line.product_id[1] : '',
                    measure_type: line.measure_type || 'qty',
                    target_value: line.target_value,
                    target_weight_uom: line.target_weight_uom || 'kg',
                    achieved_value: line.achieved_value,
                    remaining_value: line.remaining_value,
                    progress_percent: line.progress_percent || 0,
                    progressWidth: Math.max(0, Math.min(100, line.progress_percent || 0)),
                });
            });
            this.state.targets.forEach((t) => {
                t.lines = byTarget[t.id] || [];
            });
        }
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
            lines: [],
        };
    }

    // ─── Editing ─────────────────────────────────────────────────────────────────

    editSchedule(sched) {
        if (sched.isLocked) {
            const msg = `Cannot edit today's ${sched.day} schedule — visits are already in progress or completed. Finish or skip those visits first. You can change this weekday later for the next ${sched.day}.`;
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }
        this.state.errorMessage = '';
        this.state.scheduleForm = {
            day: sched.day_raw.toString(),
            route_id: sched.route_id,
            zone_name: sched.zone,
            is_active: sched.isActive !== false && sched.status !== 'Deactivated',
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
        // Use route_ids (multi-route membership), not legacy primary route_id.
        this.state.scheduleForm.operational_shop_count = await this.orm.searchCount('res.partner', [
            ['route_ids', 'in', [routeId]],
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
            is_active: tgt.isActive !== false && tgt.status !== 'Deactivated',
            lines: (tgt.lines || []).map((line) => ({
                product_id: line.product_id ? parseInt(line.product_id, 10) : '',
                product_name: line.product_name || '',
                measure_type: line.measure_type || 'qty',
                target_value: line.target_value || '',
                target_weight_uom: line.target_weight_uom || 'kg',
            })),
        };
        this.state.editingTargetId = tgt.id;
        this.state.showForm = true;
    }

    isMultiProductTargetType(type) {
        return ['collective_qty', 'collective_weight', 'product_bundle'].includes(type);
    }

    get targetProductsNotYetAddedCount() {
        const catalog = this.state.products || [];
        if (!catalog.length) {
            return 0;
        }
        const used = new Set(
            (this.state.targetForm.lines || [])
                .map((line) => parseInt(line.product_id, 10))
                .filter((id) => Number.isFinite(id) && id > 0),
        );
        return catalog.filter((p) => !used.has(p.id)).length;
    }

    _newTargetLine(productId = null) {
        const pid = productId != null && productId !== ''
            ? parseInt(productId, 10)
            : null;
        const product = Number.isFinite(pid)
            ? (this.state.products || []).find((p) => p.id === pid)
            : null;
        return {
            // Keep numeric id so <select t-model> matches t-att-value="p.id".
            product_id: Number.isFinite(pid) ? pid : '',
            product_name: product ? product.name : '',
            measure_type: 'qty',
            target_value: '',
            target_weight_uom: 'kg',
        };
    }

    addTargetLine() {
        this.state.targetForm.lines.push(this._newTargetLine());
    }

    onTargetLineProductChange(line, ev) {
        const raw = ev.target.value;
        if (raw === '' || raw === null || raw === undefined) {
            line.product_id = '';
            line.product_name = '';
            return;
        }
        const pid = parseInt(raw, 10);
        line.product_id = Number.isFinite(pid) ? pid : '';
        const product = (this.state.products || []).find((p) => p.id === line.product_id);
        line.product_name = product ? product.name : '';
    }

    addAllTargetProducts() {
        if (!this.isMultiProductTargetType(this.state.targetForm.type)) {
            return;
        }
        const catalog = [...(this.state.products || [])].sort((a, b) =>
            (a.name || '').localeCompare(b.name || ''),
        );
        if (!catalog.length) {
            this.notification.add('No sellable products in the catalog to add.', { type: 'warning' });
            return;
        }
        const used = new Set(
            (this.state.targetForm.lines || [])
                .map((line) => parseInt(line.product_id, 10))
                .filter((id) => Number.isFinite(id) && id > 0),
        );
        // Keep rows that already have a real product assigned.
        const kept = (this.state.targetForm.lines || []).filter((line) => {
            const id = parseInt(line.product_id, 10);
            return Number.isFinite(id) && id > 0;
        });
        const toAdd = catalog.filter((p) => !used.has(p.id));
        if (!toAdd.length) {
            this.notification.add('All catalog products are already on this list.', { type: 'info' });
            this.state.targetForm.lines = kept;
            return;
        }
        this.state.targetForm.lines = [
            ...kept,
            ...toAdd.map((p) => this._newTargetLine(p.id)),
        ];
        const hint = this.state.targetForm.type === 'product_bundle'
            ? ' Set each line’s target value before saving.'
            : ' Remove any products that should not count toward the collective goal.';
        this.notification.add(
            `Assigned ${toAdd.length} product(s) to the list.${hint}`,
            { type: 'success' },
        );
    }

    removeTargetLine(index) {
        this.state.targetForm.lines.splice(index, 1);
    }

    toggleTargetExpand(tgt) {
        tgt.expanded = !tgt.expanded;
    }

    progressBarWidth(value) {
        const n = parseFloat(value) || 0;
        return `${Math.max(0, Math.min(100, n))}%`;
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

    _scheduleDayLabel(dayCode) {
        const dayMap = {
            '0': 'Monday', '1': 'Tuesday', '2': 'Wednesday', '3': 'Thursday',
            '4': 'Friday', '5': 'Saturday', '6': 'Sunday',
        };
        return dayMap[String(dayCode)] || 'day';
    }

    _todayWeekdayCode() {
        // Match backend: Monday = 0 ... Sunday = 6
        const jsDay = new Date().getDay(); // Sunday = 0
        return String(jsDay === 0 ? 6 : jsDay - 1);
    }

    _buildScheduleSaveMessage(dayCode, { created = false } = {}) {
        const dayName = this._scheduleDayLabel(dayCode);
        if (created) {
            return `Schedule created. The order booker will see ${dayName} visits for this route from the next ${dayName} onward.`;
        }
        if (String(dayCode) === this._todayWeekdayCode()) {
            return `Today's ${dayName} schedule updated. Pending visits were refreshed for the new plan. Completed visits stay as they are.`;
        }
        return `Schedule updated. Completed visits for this week stay as they are. The order booker will get the new route from the next ${dayName}.`;
    }

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
                && s.isActive
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
                (s) => s.day_raw.toString() === form.day && !s.isActive
            );
            if (inactiveExisting) {
                editingScheduleId = inactiveExisting.id;
                this.notification.add(
                    `Reactivating the existing deactivated ${inactiveExisting.day} schedule.`,
                    { type: "info" }
                );
            }
        }

        const routeId = parseInt(form.route_id, 10);
        const operationalShopCount = await this.orm.searchCount('res.partner', [
            ['route_ids', 'in', [routeId]],
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
                this.notification.add(this._buildScheduleSaveMessage(form.day), { type: "success" });
            } else {
                await this.orm.create('shahtaj.weekly.schedule', [payload]);
                this.notification.add(
                    this._buildScheduleSaveMessage(form.day, { created: true }),
                    { type: "success" }
                );
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
        const multiTypes = ['collective_qty', 'collective_weight', 'product_bundle'];
        const isMulti = multiTypes.includes(form.type);

        if (!form.startDate || !form.endDate || !form.type) {
            const msg = 'Start Date, End Date, and Target Type are required.';
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

        if (!isMulti) {
            const msg = 'Choose Collective Quantity, Collective Weight, or Combined Product Targets.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }

        if (form.type === 'collective_weight' && !form.target_weight_uom) {
            const msg = 'Select kg or ton for the weight target.';
            this.state.errorMessage = msg;
            this.notification.add(msg, { type: "warning" });
            return;
        }

        if (isMulti) {
            const lines = (form.lines || []).filter((l) => l.product_id);
            if (!lines.length) {
                const msg = 'Add at least one product for this target type.';
                this.state.errorMessage = msg;
                this.notification.add(msg, { type: "warning" });
                return;
            }
            if (['collective_qty', 'collective_weight'].includes(form.type)) {
                if (!form.target_value || parseFloat(form.target_value) <= 0) {
                    const msg = 'Enter a shared target value greater than zero.';
                    this.state.errorMessage = msg;
                    this.notification.add(msg, { type: "warning" });
                    return;
                }
            }
            if (form.type === 'product_bundle') {
                for (const line of lines) {
                    if (!line.target_value || parseFloat(line.target_value) <= 0) {
                        const msg = 'Each product in a Combined target needs its own target value.';
                        this.state.errorMessage = msg;
                        this.notification.add(msg, { type: "warning" });
                        return;
                    }
                    if (line.measure_type === 'weight' && !line.target_weight_uom) {
                        const msg = 'Select kg or ton for each weight line.';
                        this.state.errorMessage = msg;
                        this.notification.add(msg, { type: "warning" });
                        return;
                    }
                }
            }
        }

        this.state.isLoading = true;
        this.state.errorMessage = '';

        try {
            const payload = {
                order_booker_id: this.state.selectedBooker.id,
                date_start: form.startDate,
                date_end: form.endDate,
                target_type: form.type,
                active: form.is_active,
                product_id: false,
                line_ids: [[5, 0, 0]],
            };

            if (form.type === 'product_bundle') {
                payload.target_value = 100.0;
            } else {
                payload.target_value = parseFloat(form.target_value);
            }

            if (form.type === 'collective_weight') {
                payload.target_weight_uom = form.target_weight_uom || 'kg';
            }

            if (isMulti) {
                const lines = (form.lines || []).filter((l) => l.product_id);
                payload.line_ids = [
                    [5, 0, 0],
                    ...lines.map((line) => [0, 0, {
                        product_id: parseInt(line.product_id, 10),
                        measure_type: form.type === 'product_bundle'
                            ? (line.measure_type || 'qty')
                            : (form.type === 'collective_weight' ? 'weight' : 'qty'),
                        target_value: form.type === 'product_bundle'
                            ? parseFloat(line.target_value)
                            : 0.0,
                        target_weight_uom: line.target_weight_uom || form.target_weight_uom || 'kg',
                    }]),
                ];
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
            const msg = `Cannot delete today's ${sched.day} schedule — visits are already in progress or completed. Finish or skip those visits first. You can change this weekday later for the next ${sched.day}.`;
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