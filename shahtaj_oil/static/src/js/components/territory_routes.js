/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class TerritoryRoutes extends Component {
    setup() {
        this.orm = useService("orm");

        this.state = useState({
            activeSubTab: 'routes', 
            
            showAreaForm: false,
            showRouteForm: false,
            showShopForm: false,
            selectedShopDetails: null,

            // Form Data States
            areaForm: { name: '', is_active: true },
            routeForm: { name: '', zone_id: '', is_active: true }, 
            shopForm: { 
                name: '', owner_name: '', owner_phone: '', address: '',
                zone_id: '', route_id: '', lat: '', lng: '', 
                creditLimit: '', legacyBalance: '', outstandingBalance: '',
                owner_cnic_front: null, owner_cnic_back: null, 
                owner_photo: null, shop_exterior_photo: null,
                preview_owner_cnic_front: null, preview_owner_cnic_back: null, 
                preview_owner_photo: null, preview_shop_exterior_photo: null
            },

            // Real Data Arrays
            areas: [],
            routes: [],
            shops: []
        });

        onWillStart(async () => {
            await this.fetchDashboardData();
        });
    }

    // --- Data Fetching Logic ---
    async fetchDashboardData() {
        this.state.areas = await this.orm.searchRead(
            "shahtaj.zone",
            [], 
            ["id", "name", "active", "route_count"]
        );

        this.state.routes = await this.orm.searchRead(
            "shahtaj.route",
            [],
            ["id", "name", "zone_id", "shop_count", "active"]
        );

        this.state.shops = await this.orm.searchRead(
            "res.partner",
            [["is_shahtaj_shop", "=", true]], 
            ["id", "name", "owner_name", "phone", "route_id", "shop_approval_state"]
        );
    }

    // --- UI Toggles & Handlers ---
    setSubTab(tabName) {
        this.state.activeSubTab = tabName;
        this.state.showAreaForm = false;
        this.state.showRouteForm = false;
        this.state.showShopForm = false;
        this.state.selectedShopDetails = null;
    }

    onZoneChange() {
        this.state.shopForm.route_id = '';
    }

    get filteredRoutes() {
        if (!this.state.shopForm.zone_id) return [];
        const selectedZoneId = parseInt(this.state.shopForm.zone_id);
        return this.state.routes.filter(r => r.zone_id && r.zone_id[0] === selectedZoneId);
    }

    onFileChange(ev, fieldName) {
        const file = ev.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            const base64Data = dataUrl.split(',')[1];
            
            this.state.shopForm[fieldName] = base64Data;
            this.state.shopForm[`preview_${fieldName}`] = dataUrl;
        };
        reader.readAsDataURL(file);
    }

    async viewShopDetails(shopId) {
        const details = await this.orm.read(
            "res.partner",
            [shopId],
            [
                "id", "name", "owner_name", "phone", "partner_latitude", "partner_longitude",
                "credit_limit", "legacy_balance", "outstanding_balance", "route_id", "zone_id",
                "owner_cnic_front", "owner_cnic_back", "owner_photo", "shop_exterior_photo", 
                "shop_approval_state"
            ]
        );
        if (details.length > 0) {
            this.state.selectedShopDetails = details[0];
        }
    }

    closeShopDetails() {
        this.state.selectedShopDetails = null;
    }

    // --- Approval Actions ---
    async approveShop(shopId) {
        try {
            await this.orm.call("res.partner", "action_approve_shop", [[shopId]]);
            await this.fetchDashboardData();
        } catch (error) {
            alert("Failed to approve shop: " + (error.data?.message || error.message));
        }
    }

    async rejectShop(shopId) {
        try {
            await this.orm.call("res.partner", "action_reject_shop", [[shopId]]);
            await this.fetchDashboardData();
        } catch (error) {
            alert("Failed to reject shop: " + (error.data?.message || error.message));
        }
    }

    // --- Database Write Logic ---
    async saveArea() {
        if (!this.state.areaForm.name) return;

        await this.orm.create("shahtaj.zone", [{
            name: this.state.areaForm.name,
            active: this.state.areaForm.is_active
        }]);

        this.state.showAreaForm = false;
        this.state.areaForm = { name: '', is_active: true };
        await this.fetchDashboardData(); 
    }

    async saveRoute() {
        if (!this.state.routeForm.name || !this.state.routeForm.zone_id) {
            alert("Route Name and Parent Zone are required.");
            return;
        }

        await this.orm.create("shahtaj.route", [{
            name: this.state.routeForm.name,
            zone_id: parseInt(this.state.routeForm.zone_id),
            active: this.state.routeForm.is_active
        }]);

        this.state.showRouteForm = false;
        this.state.routeForm = { name: '', zone_id: '', is_active: true };
        await this.fetchDashboardData();
    }

    async saveShop() {
        const lat = parseFloat(this.state.shopForm.lat);
        const lng = parseFloat(this.state.shopForm.lng);

        if (!this.state.shopForm.name || !this.state.shopForm.owner_name || isNaN(lat) || isNaN(lng)) {
            alert("Please fill all required fields including valid GPS coordinates.");
            return;
        }

        await this.orm.create("res.partner", [{
            is_shahtaj_shop: true,
            company_type: 'company',
            shop_approval_state: 'pending', // Keeps shop pending for new entries
            name: this.state.shopForm.name,
            owner_name: this.state.shopForm.owner_name,
            owner_phone: this.state.shopForm.owner_phone,
            phone: this.state.shopForm.owner_phone, 
            zone_id: this.state.shopForm.zone_id ? parseInt(this.state.shopForm.zone_id) : false,
            route_id: this.state.shopForm.route_id ? parseInt(this.state.shopForm.route_id) : false,
            partner_latitude: lat,
            partner_longitude: lng,
            credit_limit: parseFloat(this.state.shopForm.creditLimit) || 0.0,
            legacy_balance: parseFloat(this.state.shopForm.legacyBalance) || 0.0,
            owner_cnic_front: this.state.shopForm.owner_cnic_front,
            owner_cnic_back: this.state.shopForm.owner_cnic_back,
            owner_photo: this.state.shopForm.owner_photo,
            shop_exterior_photo: this.state.shopForm.shop_exterior_photo
        }]);

        this.state.showShopForm = false;
        this.state.shopForm = { 
            name: '', owner_name: '', owner_phone: '', address: '',
            zone_id: '', route_id: '', lat: '', lng: '', 
            creditLimit: '', legacyBalance: '', outstandingBalance: '',
            owner_cnic_front: null, owner_cnic_back: null, 
            owner_photo: null, shop_exterior_photo: null,
            preview_owner_cnic_front: null, preview_owner_cnic_back: null, 
            preview_owner_photo: null, preview_shop_exterior_photo: null
        };
        await this.fetchDashboardData();
    }
}

TerritoryRoutes.template = "shahtaj_oil.TerritoryRoutes";