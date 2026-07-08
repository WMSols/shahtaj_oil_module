/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class StaffManagement extends Component {
    setup() {
        this.orm = useService("orm");
        this.state = useState({
            activeTab: 'order_booker',
            viewMode: 'list', 
            detailTab: 'schedules', 
            selectedStaff: null,
            showForm: false,
            isLoading: false,
            
            editingStaffId: null, // Tracks if we are editing an existing record
            
            staffList: [],
            detailSchedules: [],
            detailTargets: [],
            
            formData: { 
                name: '', 
                employee_code: '', 
                email: '',
                password: '',
                role: 'order_booker'
            }
        });

        onWillStart(async () => {
            await this.fetchStaffData();
        });
    }

    async fetchStaffData() {
        // Included 'login' in the fields to pre-fill the email when editing
        const bookers = await this.orm.searchRead(
            "res.users",
            [["shahtaj_is_order_booker", "=", true], ["active", "in", [true, false]]],
            [
                "id", "name", "login", "shahtaj_employee_code", "shahtaj_online_status",
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
        this.state.editingStaffId = null;
        this.state.formData = { name: '', employee_code: '', email: '', password: '', role: 'order_booker' };
    }

    editStaff(staff) {
        this.state.formData = {
            name: staff.name,
            employee_code: staff.employee_code || '',
            email: staff.login || '',
            password: '', // Kept blank for security; only update if user types a new one
            role: 'order_booker'
        };
        this.state.editingStaffId = staff.id;
        this.state.showForm = true;
    }

    async saveStaff() {
        // Name and Email are always required
        if (!this.state.formData.name || !this.state.formData.email) {
            alert("Name and App Login Email are required.");
            return;
        }

        try {
            if (this.state.editingStaffId) {
                // --- UPDATE EXISTING STAFF ---
                const payload = {
                    name: this.state.formData.name,
                    login: this.state.formData.email,
                    shahtaj_employee_code: this.state.formData.employee_code,
                };
                
                // Only include the password in the update if they actually typed a new one
                if (this.state.formData.password) {
                    payload.password = this.state.formData.password;
                }

                await this.orm.write("res.users", [this.state.editingStaffId], payload);

            } else {
                // --- CREATE NEW STAFF ---
                if (!this.state.formData.password) {
                    alert("Password is required for new accounts.");
                    return;
                }

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
        }
    }

    async toggleActiveStatus(staffId, currentStatus) {
        const newStatus = !currentStatus;
        const actionWord = newStatus ? "activate" : "deactivate";
        
        if (!confirm(`Are you sure you want to ${actionWord} this order booker?`)) return;

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
        }
    }
}

StaffManagement.template = "shahtaj_oil.StaffManagement";