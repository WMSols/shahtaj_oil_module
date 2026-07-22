/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { hasFinancialAccess } from "../shahtaj_access";
import { StaffManagement } from "./staff_management";
import { OperationsTracking } from "./operations_tracking";
import { TerritoryRoutes } from "./territory_routes";
import { WarehouseInventory } from "./warehouse_inventory";
import { FinancialsInvoicing } from "./financials_invoicing";
import { PortalSettings } from "./settings"
import { SchedulesTargets } from "./schedules_targets";
import { BankTransactions } from "./bank_transactions";
import { ConfirmModal } from "./confirm_modal";

export class ShahtajDashboard extends Component {
    static components = { StaffManagement, OperationsTracking, TerritoryRoutes, WarehouseInventory, FinancialsInvoicing, PortalSettings, SchedulesTargets, BankTransactions, ConfirmModal }; 

    setup() {
        this.state = useState({
            activeTab: 'territory', 
            activeSubTab: 'areas', 
            isSidebarOpen: false, 
            
            // Tracks which accordion menus are currently expanded
            expandedMenus: {
                territory: true, // Open by default
                warehouse: false,
                operations: false,
                financials: false,
                schedules: false
            }
        });
    }

    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    toggleMenu(menuName, defaultSubTab = '') {
        const isCurrentlyOpen = this.state.expandedMenus[menuName];
        
        // 1. Close ALL menus first (Exclusive Accordion Logic)
        for (let key in this.state.expandedMenus) {
            this.state.expandedMenus[key] = false;
        }
        
        // 2. Toggle the specific menu that was clicked
        this.state.expandedMenus[menuName] = !isCurrentlyOpen;
        
        // 3. Auto-switch the main view if we are opening it
        if (this.state.expandedMenus[menuName]) {
            this.switchTab(menuName, defaultSubTab); 
        }
    }

    switchTab(tabName, subTabName = '') {
        if (!this.hasFinancialAccess && (tabName === 'financials' || tabName === 'transactions')) {
            tabName = 'operations';
            subTabName = 'checkins';
        }
        if (!this.hasFinancialAccess && tabName === 'warehouse' && ['inventory', 'taxes'].includes(subTabName)) {
            subTabName = 'management';
        }
        this.state.activeTab = tabName;
        this.state.activeSubTab = subTabName;
        
        // Close all menus
        for (let key in this.state.expandedMenus) {
            this.state.expandedMenus[key] = false;
        }
        // Ensure the parent menu of the clicked tab stays open
        if (this.state.expandedMenus[tabName] !== undefined) {
            this.state.expandedMenus[tabName] = true;
        }

        // Auto-close sidebar on mobile after navigating
        this.state.isSidebarOpen = false;
    }

    toggleSidebar() {
        this.state.isSidebarOpen = !this.state.isSidebarOpen;
    }
}

ShahtajDashboard.template = "shahtaj_oil.DashboardViewTemplate";
registry.category("actions").add("shahtaj_dashboard_tag", ShahtajDashboard);