/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { StaffManagement } from "./staff_management";
import { OperationsTracking } from "./operations_tracking";
import { TerritoryRoutes } from "./territory_routes";
import { WarehouseInventory } from "./warehouse_inventory";
import { FinancialsInvoicing } from "./financials_invoicing";
import { PortalSettings } from "./settings"
import { SchedulesTargets } from "./schedules_targets";

export class ShahtajDashboard extends Component {
    static components = { StaffManagement, OperationsTracking, TerritoryRoutes, WarehouseInventory, FinancialsInvoicing, PortalSettings, SchedulesTargets }; 

    setup() {
        this.state = useState({
            activeTab: 'territory', // Default active tab
            isSidebarOpen: false, // NEW: State to control mobile sidebar
        });
    }

    switchTab(tabName) {
        this.state.activeTab = tabName;
        this.state.isSidebarOpen = false; // NEW: Auto-close sidebar on mobile after clicking a link
    }

    // NEW: Function to toggle sidebar visibility
    toggleSidebar() {
        this.state.isSidebarOpen = !this.state.isSidebarOpen;
    }
}

ShahtajDashboard.template = "shahtaj_oil.DashboardViewTemplate";
registry.category("actions").add("shahtaj_dashboard_tag", ShahtajDashboard);