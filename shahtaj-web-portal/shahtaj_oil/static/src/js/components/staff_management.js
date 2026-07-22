/** @odoo-module **/

import { Component, useState, onWillStart, onMounted, onWillUnmount } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ConfirmModal } from "./confirm_modal";
export class StaffManagement extends Component {
    static components = { ConfirmModal };
    setup() {
        this.orm = useService("orm");
        this.state = useState({
            activeTab: 'order_booker',
            viewMode: 'list',
            detailTab: 'schedules',
            selectedStaff: null,
            showForm: false,
            isLoading: false,
            showPassword: false,
            editingStaffId: null,

            staffList: [],
            detailSchedules: [],
            detailTargets: [],

            // New state properties for Search and Filter
            searchQuery: '',
            filterStatus: 'all', // 'all', 'online', 'active', 'suspended'
            loading: {
                fetch: false,
                save: false,
                toggle: false
            },
            confirmModal: {
                isOpen: false,
                title: '',
                message: '',
                onConfirm: null
            },
            formData: {
                name: '',
                employee_code: '',
                email: '',
                password: '',
                role: 'order_booker'
            }
        });

        // 2. Variable to hold our interval ID
        this.pollingInterval = null;

        onWillStart(async () => {
            await this.fetchStaffData();
        });

        // 3. Start polling when the component loads
        onMounted(() => {
            // Fetch fresh data every 15 seconds (15000 ms)
            this.pollingInterval = setInterval(() => {
                if (!this.state.loading.save && !this.state.loading.toggle) {
                    this.fetchStaffData();
                }
                this.fetchStaffData();
            }, 15000);
        });

        // 4. Clean up the interval if the user navigates away
        onWillUnmount(() => {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
            }
        });
    }
    // --- Modal Controllers ---
    showConfirm(title, message, onConfirmCallback) {
        this.state.confirmModal = {
            isOpen: true,
            title: title,
            message: message,
            onConfirm: async () => {
                this.state.confirmModal.isOpen = false;
                await onConfirmCallback();
            }
        };
    }

    closeConfirm() {
        this.state.confirmModal.isOpen = false;
    }
    // New Getter to handle dynamic searching and filtering
    get filteredStaffList() {
        return this.state.staffList.filter(staff => {
            // Exclude inactive staff from the main list view
            if (!staff.active) return false;

            // 1. Search Logic
            const searchLower = this.state.searchQuery.toLowerCase();
            const nameMatch = staff.name.toLowerCase().includes(searchLower);
            const codeMatch = staff.employee_code && staff.employee_code.toLowerCase().includes(searchLower);
            const matchesSearch = nameMatch || codeMatch;

            // 2. Filter Logic
            let matchesFilter = true;
            if (this.state.filterStatus === 'online') {
                matchesFilter = staff.status === 'online';
            } else if (this.state.filterStatus === 'active') {
                matchesFilter = staff.active === true;
            }

            return matchesSearch && matchesFilter;
        });
    }
    // --- Archive Logic ---
    get archivedStaff() {
        return this.state.staffList.filter(staff => !staff.active);
    }

    openArchive() {
        this.state.viewMode = 'archive';
    }

    // --- Data Fetching (Wrapped with loading state) ---
    async fetchStaffData() {
        this.state.loading.fetch = true;
        try {
            const bookers = await this.orm.searchRead(
                "res.users",
                [["shahtaj_is_order_booker", "=", true], ["active", "in", [true, false]]],
                [
                    "id", "name", "shahtaj_employee_code", "shahtaj_online_status",
                    "shahtaj_last_seen_at",
                    "shahtaj_task_today_total", "shahtaj_task_today_pending", "shahtaj_task_today_done",
                    "shahtaj_active_target_progress", "shahtaj_active_target_summary", "active"
                ]
            );
            
            this.state.staffList = bookers.map(u => ({
                id: u.id,
                name: u.name,
                login: u.login,
                employee_code: u.shahtaj_employee_code,
                role: "Order Booker",
                status: u.shahtaj_online_status,
                active: u.active,
                last_seen_at: u.shahtaj_last_seen_at || false,
                last_seen_label: this.formatLastSeen(u.shahtaj_last_seen_at),
                metrics: {
                    today: { 
                        total: u.shahtaj_task_today_total, 
                        pending: u.shahtaj_task_today_pending, 
                        completed: u.shahtaj_task_today_done 
                    },
                    activeTarget: { 
                        summary: u.shahtaj_active_target_summary, 
                        progress: u.shahtaj_active_target_progress 
                    }
                }
            }));
        } finally {
            this.state.loading.fetch = false;
        }
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

    async openDetails(staff) {
        this.state.selectedStaff = staff;

        const schedules = await this.orm.searchRead(
            "shahtaj.weekly.schedule",
            [["order_booker_id", "=", staff.id]],
            ["id", "day_of_week", "route_id", "zone_id", "active"]
        );

        const dayMap = {
            '0': 'Monday', '1': 'Tuesday', '2': 'Wednesday',
            '3': 'Thursday', '4': 'Friday', '5': 'Saturday', '6': 'Sunday'
        };

        this.state.detailSchedules = schedules.map(s => ({
            ...s,
            day: dayMap[s.day_of_week] || s.day_of_week
        }));

        this.state.detailTargets = await this.orm.searchRead(
            "shahtaj.visit.target",
            [["order_booker_id", "=", staff.id]],
            ["id", "date_start", "date_end", "target_type", "target_value", "achieved_value", "progress_percent", "active"]
        );

        this.state.viewMode = 'detail';
        this.state.detailTab = 'schedules';
    }

    switchTab(tabName) {
        this.state.activeTab = tabName;
        this.state.viewMode = 'list';
        this.fetchStaffData();
    }

    goBack() {
        this.state.selectedStaff = null;
        this.state.viewMode = 'list';
        this.fetchStaffData();
    }

    openForm() {
        this.state.formData = { name: '', employee_code: '', email: '', password: '', role: 'order_booker' };
        this.state.editingStaffId = null;
        this.state.showForm = true;
    }

    cancelForm() {
        this.state.showForm = false;
        this.state.showPassword = false;
        this.state.editingStaffId = null;
        this.state.formData = { name: '', employee_code: '', email: '', password: '', role: 'order_booker' };
    }

    editStaff(staff) {
        this.state.formData = {
            name: staff.name,
            employee_code: staff.employee_code || '',
            email: staff.login || '',
            password: '',
            role: 'order_booker'
        };
        this.state.editingStaffId = staff.id;
        this.state.showForm = true;
    }

   // --- Save Staff (Wrapped with loading state) ---
    async saveStaff() {
    //    Removed alert for missing password during edit, because using HTML required attribute for validation
        this.state.loading.save = true;
        try {
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
            alert(`Failed to save order booker:\n\n${errorMessage}`);
        } finally {
            this.state.loading.save = false;
        }
    }

  // --- Refactored Status Toggler (Using Custom Modal) ---
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
            const methodName = newStatus ? "action_shahtaj_activate_booker" : "action_shahtaj_deactivate_booker";
            await this.orm.call("res.users", methodName, [[staffId]]);
            
            await this.fetchStaffData();
            if (this.state.selectedStaff && this.state.selectedStaff.id === staffId) {
                this.state.selectedStaff.active = newStatus;
            }
        } catch (error) {
            console.error("Failed to toggle status:", error);
            alert("An error occurred while updating the status.");
        } finally {
            this.state.loading.toggle = false;
        }
    }
}

StaffManagement.template = "shahtaj_oil.StaffManagement";