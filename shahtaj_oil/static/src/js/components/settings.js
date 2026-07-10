/** @odoo-module **/

import { Component, useState, xml } from "@odoo/owl";

export class PortalSettings extends Component {
    setup() {
        this.state = useState({
            activeSubTab: 'general', // 'general' or 'users'
            showUserForm: false,
            
            // Mock Data: Native Company Settings mapping
            companyForm: {
                name: "Shahtaj Oil Distributor (Mianwali Branch)",
                phone: "0459-123456",
                logo_preview: false // In production, this will hold the base64 string
            },

            // Mock Data: User Provisioning mapping
            userForm: { name: '', email: '', password: '', role: '' },
            
            // Mock Data: Existing Users
            users: [
                { id: 1, name: "Sohaib Zaman", email: "admin@shahtaj.com", role: "Distributor (Super Admin)", status: "Active" },
                { id: 2, name: "Usman Tariq", email: "usman.area@shahtaj.com", role: "Area Manager", status: "Active" },
                { id: 3, name: "Ali Khan", email: "ali.kpo@shahtaj.com", role: "KPO (Key Punch Operator)", status: "Active" }
            ]
        });
    }

    setSubTab(tabName) {
        this.state.activeSubTab = tabName;
        this.state.showUserForm = false;
    }

    // --- Company Settings Actions ---
    triggerLogoUpload() {
        // In the real version, this will trigger a hidden <input type="file">
        alert("File picker will open here to select a new logo.");
    }

    saveCompanySettings() {
        // Mock save action
        alert(`Settings saved for: ${this.state.companyForm.name}`);
    }

    // --- User Management Actions ---
    openUserForm() {
        this.state.userForm = { name: '', email: '', password: '', role: '' };
        this.state.showUserForm = true;
    }

    saveUser() {
        if (!this.state.userForm.name || !this.state.userForm.role) return;
        
        this.state.users.push({
            id: this.state.users.length + 1,
            name: this.state.userForm.name,
            email: this.state.userForm.email || "Pending",
            role: this.state.userForm.role,
            status: "Active"
        });
        this.state.showUserForm = false;
    }
}

PortalSettings.template = "shahtaj_oil.PortalSettings"