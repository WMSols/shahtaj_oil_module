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
            isSwitchingTab: false,
            // Tracks which accordion menus are currently expanded
            expandedMenus: {
                territory: true, // Open by default
                warehouse: false,
                operations: false,
                financials: false,
                schedules: false
            }
        });
        // Global Event listnere to sync child component tab switches with the main dashboard state
        window.addEventListener('shahtaj-dashboard-switch', (ev) => {
            this.switchTab(ev.detail.tab, ev.detail.subTab);
        });
    }

    // NEW: Async switchTab with loading delay
   
    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    async toggleMenu(menuName, defaultSubTab = '') {
        const isCurrentlyOpen = this.state.expandedMenus[menuName];
        
        // 1. Close ALL menus first (Exclusive Accordion Logic)
        for (let key in this.state.expandedMenus) {
            this.state.expandedMenus[key] = false;
        }
        
        // 2. Toggle the specific menu that was clicked
        this.state.expandedMenus[menuName] = !isCurrentlyOpen;
        
        // 3. If opening, yield to the browser instantly so the accordion animation starts, THEN switch tabs
        if (this.state.expandedMenus[menuName]) {
            await new Promise(resolve => setTimeout(resolve, 10));
            await this.switchTab(menuName, defaultSubTab); 
        }
    }
    async switchTab(tabName, subTabName = '') {
        if (!this.hasFinancialAccess && (tabName === 'financials' || tabName === 'transactions')) {
            tabName = 'operations';
            subTabName = 'checkins';
        }
        if (!this.hasFinancialAccess && tabName === 'warehouse' && ['inventory', 'taxes'].includes(subTabName)) {
            subTabName = 'management';
        }

        // SMART FIX: If we are already on this main tab, don't unmount! Just change the sub-tab gracefully.
        if (this.state.activeTab === tabName) {
            this.state.activeSubTab = subTabName;
            
            // Manage accordion highlighting
            for (let key in this.state.expandedMenus) {
                this.state.expandedMenus[key] = false;
            }
            if (this.state.expandedMenus[tabName] !== undefined) {
                this.state.expandedMenus[tabName] = true;
            }
            this.state.isSidebarOpen = false;
            return; // Exit early, no unmounting needed!
        }

        // 1. Unmount the heavy components and show the loading screen
        this.state.isSwitchingTab = true;

        // 2. Force the browser to paint the UI before locking the thread
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 10)));

        try {
            this.state.activeTab = tabName;
            this.state.activeSubTab = subTabName;
            
            for (let key in this.state.expandedMenus) {
                this.state.expandedMenus[key] = false;
            }
            if (this.state.expandedMenus[tabName] !== undefined) {
                this.state.expandedMenus[tabName] = true;
            }
            this.state.isSidebarOpen = false;

            // 3. Yield once more so Owl can begin mounting the new component
            await new Promise(resolve => setTimeout(resolve, 10));
        } finally {
            // 4. Remove the loading screen
            this.state.isSwitchingTab = false;
        }
    }
    toggleSidebar() {
        this.state.isSidebarOpen = !this.state.isSidebarOpen;
    }
}

ShahtajDashboard.template = "shahtaj_oil.DashboardViewTemplate";
registry.category("actions").add("shahtaj_dashboard_tag", ShahtajDashboard);