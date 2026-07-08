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
            shopCategoryEdit: 'credit',

            // Edit Tracking States
            editingAreaId: null,
            editingRouteId: null,
            editingShopId: null,

            // Form Data States
            areaForm: { name: '', is_active: true },
            routeForm: { name: '', zone_id: '', is_active: true }, 
            shopForm: { 
                name: '', owner_name: '', owner_phone: '', owner_cnic_number: '', address: '',
                zone_id: '', route_id: '', lat: '', lng: '', 
                shopCategory: 'credit',
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
            ["id", "name", "owner_name", "phone", "route_id", "shop_approval_state", "shahtaj_shop_category", "registered_by_id"]
        );
    }

    // --- UI Toggles & Handlers ---
    setSubTab(tabName) {
        this.state.activeSubTab = tabName;
        this.cancelForms();
        this.state.selectedShopDetails = null;
    }

    cancelForms() {
        this.state.showAreaForm = false;
        this.state.showRouteForm = false;
        this.state.showShopForm = false;
        
        this.state.editingAreaId = null;
        this.state.editingRouteId = null;
        this.state.editingShopId = null;

        this.resetForms();
    }

    resetForms() {
        this.state.areaForm = { name: '', is_active: true };
        this.state.routeForm = { name: '', zone_id: '', is_active: true };
        this.state.shopForm = { 
            name: '', owner_name: '', owner_phone: '', owner_cnic_number: '', address: '',
            zone_id: '', route_id: '', lat: '', lng: '', 
            shopCategory: 'credit',
            creditLimit: '', legacyBalance: '', outstandingBalance: '',
            owner_cnic_front: null, owner_cnic_back: null, 
            owner_photo: null, shop_exterior_photo: null,
            preview_owner_cnic_front: null, preview_owner_cnic_back: null, 
            preview_owner_photo: null, preview_shop_exterior_photo: null
        };
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

    // --- Detail Views & Approvals ---
    async viewShopDetails(shopId) {
        const details = await this.orm.read(
            "res.partner",
            [shopId],
            [
                "id", "name", "owner_name", "phone", "owner_cnic_number", "partner_latitude", "partner_longitude",
                "shahtaj_shop_category", "credit_limit", "legacy_balance", "outstanding_balance",
                "route_id", "zone_id", "registered_by_id",
                "owner_cnic_front", "owner_cnic_back", "owner_photo", "shop_exterior_photo", 
                "shop_approval_state"
            ]
        );
        if (details.length > 0) {
            this.state.selectedShopDetails = details[0];
            this.state.shopCategoryEdit = details[0].shahtaj_shop_category || 'credit';
        }
    }

    closeShopDetails() {
        this.state.selectedShopDetails = null;
        this.state.shopCategoryEdit = 'credit';
    }

    async saveShopCategory() {
        if (!this.state.selectedShopDetails) return;
        const shopId = this.state.selectedShopDetails.id;
        try {
            await this.orm.write("res.partner", [shopId], {
                shahtaj_shop_category: this.state.shopCategoryEdit,
            });
            await this.viewShopDetails(shopId);
            await this.fetchDashboardData();
        } catch (error) {
            alert("Failed to update shop category: " + (error.data?.message || error.message));
        }
    }

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

    // --- Edit Handlers ---
    editArea(area) {
        this.state.areaForm = { name: area.name, is_active: area.active };
        this.state.editingAreaId = area.id;
        this.state.showAreaForm = true;
    }

    editRoute(route) {
        this.state.routeForm = { 
            name: route.name, 
            zone_id: route.zone_id ? route.zone_id[0] : '', 
            is_active: route.active 
        };
        this.state.editingRouteId = route.id;
        this.state.showRouteForm = true;
    }

    async editShop(shop) {
        // Fetch full shop details for editing
        const details = await this.orm.read("res.partner", [shop.id], [
            "name", "owner_name", "phone", "owner_cnic_number", "zone_id", "route_id",
            "partner_latitude", "partner_longitude", "shahtaj_shop_category", "credit_limit", "legacy_balance"
        ]);

        if (details.length > 0) {
            const d = details[0];
            this.state.shopForm = {
                name: d.name || '',
                owner_name: d.owner_name || '',
                owner_phone: d.phone || '',
                owner_cnic_number: d.owner_cnic_number || '',
                zone_id: d.zone_id ? d.zone_id[0] : '',
                route_id: d.route_id ? d.route_id[0] : '',
                lat: d.partner_latitude || '',
                lng: d.partner_longitude || '',
                shopCategory: d.shahtaj_shop_category || 'credit',
                creditLimit: d.credit_limit || '',
                legacyBalance: d.legacy_balance || '',
                // Keep image state clear unless user decides to upload new ones during edit
                owner_cnic_front: null, owner_cnic_back: null, 
                owner_photo: null, shop_exterior_photo: null,
                preview_owner_cnic_front: null, preview_owner_cnic_back: null, 
                preview_owner_photo: null, preview_shop_exterior_photo: null
            };
            this.state.editingShopId = shop.id;
            this.state.showShopForm = true;
        }
    }

    // --- Database Write Logic ---
    async saveArea() {
        if (!this.state.areaForm.name) return;

        const payload = {
            name: this.state.areaForm.name,
            active: this.state.areaForm.is_active
        };

        if (this.state.editingAreaId) {
            await this.orm.write("shahtaj.zone", [this.state.editingAreaId], payload);
        } else {
            await this.orm.create("shahtaj.zone", [payload]);
        }

        this.cancelForms();
        await this.fetchDashboardData(); 
    }

    async saveRoute() {
        if (!this.state.routeForm.name || !this.state.routeForm.zone_id) {
            alert("Route Name and Parent Zone are required.");
            return;
        }

        const payload = {
            name: this.state.routeForm.name,
            zone_id: parseInt(this.state.routeForm.zone_id),
            active: this.state.routeForm.is_active
        };

        if (this.state.editingRouteId) {
            await this.orm.write("shahtaj.route", [this.state.editingRouteId], payload);
        } else {
            await this.orm.create("shahtaj.route", [payload]);
        }

        this.cancelForms();
        await this.fetchDashboardData();
    }

    async saveShop() {
        const lat = parseFloat(this.state.shopForm.lat);
        const lng = parseFloat(this.state.shopForm.lng);

        if (!this.state.shopForm.name || !this.state.shopForm.owner_name || isNaN(lat) || isNaN(lng)) {
            alert("Please fill all required fields including valid GPS coordinates.");
            return;
        }

        const payload = {
            is_shahtaj_shop: true,
            company_type: 'company',
            shahtaj_shop_category: this.state.shopForm.shopCategory || 'credit',
            name: this.state.shopForm.name,
            owner_name: this.state.shopForm.owner_name,
            owner_phone: this.state.shopForm.owner_phone, // Custom field if it exists
            phone: this.state.shopForm.owner_phone,       // Standard Odoo field
            owner_cnic_number: this.state.shopForm.owner_cnic_number || false,
            zone_id: this.state.shopForm.zone_id ? parseInt(this.state.shopForm.zone_id) : false,
            route_id: this.state.shopForm.route_id ? parseInt(this.state.shopForm.route_id) : false,
            partner_latitude: lat,
            partner_longitude: lng,
            credit_limit: this.state.shopForm.shopCategory === 'credit'
                ? (parseFloat(this.state.shopForm.creditLimit) || 0.0)
                : 0.0,
            legacy_balance: parseFloat(this.state.shopForm.legacyBalance) || 0.0,
        };

        // Only update photos if a new one was uploaded during edit, or if creating new
        if (this.state.shopForm.owner_cnic_front) payload.owner_cnic_front = this.state.shopForm.owner_cnic_front;
        if (this.state.shopForm.owner_cnic_back) payload.owner_cnic_back = this.state.shopForm.owner_cnic_back;
        if (this.state.shopForm.owner_photo) payload.owner_photo = this.state.shopForm.owner_photo;
        if (this.state.shopForm.shop_exterior_photo) payload.shop_exterior_photo = this.state.shopForm.shop_exterior_photo;

        if (this.state.editingShopId) {
            await this.orm.write("res.partner", [this.state.editingShopId], payload);
        } else {
            payload.shop_approval_state = 'pending'; // Reset state on new creation
            await this.orm.create("res.partner", [payload]);
        }

        this.cancelForms();
        await this.fetchDashboardData();
    }
}

TerritoryRoutes.template = "shahtaj_oil.TerritoryRoutes";