/** @odoo-module **/

import { Component, useState, onWillStart, useEffect, useRef,onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ConfirmModal } from "./confirm_modal";
import { hasFinancialAccess } from "../shahtaj_access"; 

export class TerritoryRoutes extends Component {
    static props = {
        requestedSubTab: { type: String, optional: true },
    };
    static components = { ConfirmModal };
    
    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.mapRef = useRef("mapContainer");
        this.mapInstance = null; 
        // Universal items per page shared across Zones, Routes, and Shops
        const ITEMS_PER_PAGE = 10;
        this.state = useState({
           activeSubTab: this.props.requestedSubTab || 'areas', 
           previousSubTab: 'areas',
            
            showAreaForm: false,
            showRouteForm: false,
            showShopForm: false,
            selectedShopDetails: null,
            shopCategoryEdit: 'credit',
            shopActionMenuId: null,

            editingAreaId: null,
            editingRouteId: null,
            editingShopId: null,

            // --- Search & Filter States ---
            areaSearchQuery: '',
            areaFilterStatus: 'all',

            routeSearchQuery: '',
            routeFilterStatus: 'all',

            shopSearchQuery: '',
            shopFilterCategory: 'all',
            shopFilterStatus: 'all',
            shopFilterBooker: 'all', 
            shopFilterRoute: 'all',
            routeFilterZone: 'all',  
            bookers: [],
            // Custom Modal State
            confirmModal: { isOpen: false, title: '', message: '', onConfirm: null },
            isLoading: false,

            areaForm: { name: '', is_active: true },
            routeForm: { name: '', zone_id: '', is_active: true }, 
            shopForm: { 
                name: '', owner_name: '', owner_phone: '', owner_cnic_number: '', address: '',
                shopCategory: 'credit',
                creditLimit: '', legacyBalance: '', outstandingBalance: '',
                owner_cnic_front: null, owner_cnic_back: null, 
                owner_photo: null, shop_exterior_photo: null,
                preview_owner_cnic_front: null, preview_owner_cnic_back: null, 
                preview_owner_photo: null, preview_shop_exterior_photo: null
            },

            areas: [],
            routes: [],
            shops: [],
            // --- NEW: Backend Pagination & Loading ---
            itemsPerPage: ITEMS_PER_PAGE,
            isLoadingList: false,
            searchTimeout: null,
            tableAreas: [],
            tableRoutes: [],
            tableShops: [],
            selectedRouteDetails: null,
            routeChecklistSearchQuery: '',
            tableRouteChecklist: [],
            pagination: {
                areas: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                routes: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                shops: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                routeChecklist: { page: 1, limit: ITEMS_PER_PAGE, total: 0 }, // Checklist pagination
            },
            
        });
        // Universal Debouncer
        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchActiveList = this.debounceSearch(() => this.fetchActiveList(), 400);
        this.debouncedFetchRouteChecklist = this.debounceSearch(() => this.fetchRouteChecklist(), 400)

        onWillStart(async () => {
            await this.fetchDashboardData();
            await this.fetchActiveList(); // Force the paginator to run on initial load
        });
        // ADD THIS NEW BLOCK RIGHT AFTER THE STATE CLOSING BRACKET:
        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab && nextProps.requestedSubTab !== this.state.activeSubTab) {
                this.setSubTab(nextProps.requestedSubTab);
            }
        });

        useEffect(() => {
            if (this.mapInstance) {
                this.mapInstance.remove();
                this.mapInstance = null;
            }

            const mapEl = this.mapRef.el;
            const shop = this.state.selectedShopDetails;

            if (mapEl && shop && shop.partner_latitude && shop.partner_longitude) {
                if (typeof L !== 'undefined') {
                    this.mapInstance = L.map(mapEl).setView([shop.partner_latitude, shop.partner_longitude], 16);
                    
                    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                        maxZoom: 19,
                        attribution: '© OpenStreetMap'
                    }).addTo(this.mapInstance);

                    L.marker([shop.partner_latitude, shop.partner_longitude])
                        .addTo(this.mapInstance)
                        .bindPopup(`<b>${shop.name}</b><br/>${shop.owner_name}`)
                        .openPopup();
                } else {
                    console.warn("Leaflet library is missing! Check your __manifest__.py assets.");
                }
            }
            
            return () => {
                if (this.mapInstance) {
                    this.mapInstance.remove();
                    this.mapInstance = null;
                }
            };
        }, () => [this.mapRef.el, this.state.selectedShopDetails]);
    }
    // --- UNIVERSAL PAGINATION HANDLERS ---
    onSearchInput(tabName) {
        this.state.pagination[tabName].page = 1; 
        this.debouncedFetchActiveList();
    }

    onFilterChange(tabName) {
        this.state.pagination[tabName].page = 1;
        this.fetchActiveList(); 
    }

    changePage(tabName, direction) {
        const pag = this.state.pagination[tabName];
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchActiveList();
        }
    }

    // --- THE BACKEND DATA ENGINE ---
    async fetchActiveList() {
        const tab = this.state.activeSubTab;
        if (!['areas', 'routes', 'shops'].includes(tab)) return;

        this.state.isLoadingList = true;
        try {
            const pag = this.state.pagination[tab];
            let domain = [];
            let model = '';
            let fields = [];
            let targetState = '';

            if (tab === 'areas') {
                model = 'shahtaj.zone';
                fields = ["id", "name", "active", "route_count"];
                targetState = 'tableAreas';
                domain = [['active', '=', true]]; // FIX: Only fetch active
                if (this.state.areaSearchQuery) domain.push(['name', 'ilike', this.state.areaSearchQuery]);
            } 
            else if (tab === 'routes') {
                model = 'shahtaj.route';
                fields = ["id", "name", "zone_id", "shop_count", "unassigned_shop_count", "active"];
                targetState = 'tableRoutes';
                domain = [['active', '=', true]];
                if (this.state.routeSearchQuery) domain.push(['name', 'ilike', this.state.routeSearchQuery]);
                if (this.state.routeFilterZone !== 'all') domain.push(['zone_id', '=', parseInt(this.state.routeFilterZone)]);
            } 
            else if (tab === 'shops') {
                model = 'res.partner';
                fields = ["id", "name", "owner_name", "phone", "route_ids", "shahtaj_route_tag", "shop_approval_state", "shahtaj_shop_category", "registered_by_id", "active", "shahtaj_visit_tag"];
                targetState = 'tableShops';
                domain = [['is_shahtaj_shop', '=', true], ['active', '=', true]]; 
                
                if (this.state.shopSearchQuery) {
                    domain.push('|', ['name', 'ilike', this.state.shopSearchQuery], ['owner_name', 'ilike', this.state.shopSearchQuery]);
                }
                if (this.state.shopFilterCategory !== 'all') {
                    domain.push(['shahtaj_shop_category', '=', this.state.shopFilterCategory]);
                }
                if (this.state.shopFilterStatus !== 'all') {
                    domain.push(['shop_approval_state', '=', this.state.shopFilterStatus]);
                }
                if (this.state.shopFilterBooker !== 'all') {
                    domain.push(['registered_by_id', '=', parseInt(this.state.shopFilterBooker)]);
                }
                if (this.state.shopFilterRoute !== 'all') {
                    if (this.state.shopFilterRoute === 'unassigned') {
                        domain.push(['route_ids', '=', false]);
                    } else {
                        domain.push(['route_ids', 'in', [parseInt(this.state.shopFilterRoute)]]);
                    }
                }
            }

            const [total, records] = await Promise.all([
                this.orm.searchCount(model, domain),
                this.orm.searchRead(model, domain, fields, { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "id desc" })
            ]);

            this.state.pagination[tab].total = total;
            this.state[targetState] = records;

        } catch (error) {
            this.notification.add("Failed to fetch data: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }
    // NEW Refresh Method
    async refreshData() {
        this.state.isLoading = true;
        try {
            await this.fetchDashboardData();
            await this.fetchActiveList();
        } finally {
            this.state.isLoading = false;
        }
    }
    // Custom Modal Controller
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

    // --- Dynamic Search & Filter Getters ---
  get displayAreas() {
        return this.state.areas.filter(area => area.active && area.name.toLowerCase().includes(this.state.areaSearchQuery.toLowerCase()));
    }

    get displayRoutes() {
        return this.state.routes.filter(route => route.active && route.name.toLowerCase().includes(this.state.routeSearchQuery.toLowerCase()));
    }

    get displayShops() {
        return this.state.shops.filter(shop => {
            if (!shop.active) return false;
            
            const query = this.state.shopSearchQuery.toLowerCase();
            const searchMatch = shop.name.toLowerCase().includes(query) || (shop.owner_name || '').toLowerCase().includes(query);
            const categoryMatch = this.state.shopFilterCategory !== 'all' ? shop.shahtaj_shop_category === this.state.shopFilterCategory : true;
            const statusMatch = this.state.shopFilterStatus !== 'all' ? shop.shop_approval_state === this.state.shopFilterStatus : true;

            return searchMatch && categoryMatch && statusMatch;
        });
    }

    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    // Custom Modal Controller
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

    // --- Dynamic Search & Filter Getters ---
  get displayAreas() {
        return this.state.areas.filter(area => area.active && area.name.toLowerCase().includes(this.state.areaSearchQuery.toLowerCase()));
    }

    get displayRoutes() {
        return this.state.routes.filter(route => route.active && route.name.toLowerCase().includes(this.state.routeSearchQuery.toLowerCase()));
    }

    get displayShops() {
        return this.state.shops.filter(shop => {
            if (!shop.active) return false;
            
            const query = this.state.shopSearchQuery.toLowerCase();
            const searchMatch = shop.name.toLowerCase().includes(query) || (shop.owner_name || '').toLowerCase().includes(query);
            const categoryMatch = this.state.shopFilterCategory !== 'all' ? shop.shahtaj_shop_category === this.state.shopFilterCategory : true;
            const statusMatch = this.state.shopFilterStatus !== 'all' ? shop.shop_approval_state === this.state.shopFilterStatus : true;

            return searchMatch && categoryMatch && statusMatch;
        });
    }

    // --- Data Fetching Logic (areas/routes/shops in parallel) ---
    async fetchDashboardData() {
        const includeArchivedDomain = ['|', ['active', '=', true], ['active', '=', false]];
        const [areas, routes, archivedShops, bookerGroups] = await Promise.all([
            this.orm.searchRead("shahtaj.zone", includeArchivedDomain, ["id", "name", "active", "route_count"]),
            this.orm.searchRead("shahtaj.route", includeArchivedDomain, ["id", "name", "zone_id", "shop_count", "active"]),
            // ONLY fetch inactive shops to keep the Archive tab working without loading thousands of active shops!
            this.orm.searchRead("res.partner", [["is_shahtaj_shop", "=", true], ["active", "=", false]], ["id", "name", "owner_name", "shahtaj_routes_display", "shahtaj_route_tag", "active"]),
            
            // FIX: Replaced this.orm.readGroup with this.orm.call
            this.orm.call(
                "res.partner", 
                "read_group", 
                [
                    [["is_shahtaj_shop", "=", true], ["registered_by_id", "!=", false]], // domain
                    ["registered_by_id"], // fields
                    ["registered_by_id"]  // groupby
                ]
            )
        ]);

        this.state.areas = areas;
        this.state.routes = routes;
        this.state.shops = archivedShops;
        
        // Map the results to format the bookers list
        this.state.bookers = bookerGroups.map(g => ({ 
            id: g.registered_by_id[0], 
            name: g.registered_by_id[1] 
        }));
    }
    setSubTab(tabName) {
        if (tabName === 'archive' && this.state.activeSubTab !== 'archive') {
            this.state.previousSubTab = this.state.activeSubTab;
        }
        
        this.state.activeSubTab = tabName;
        this.cancelForms();
        this.state.selectedShopDetails = null;
        this.closeRouteDetails();
        this.closeShopActionMenu();

        // Trigger the paginator when swapping tabs
        if (['areas', 'routes', 'shops'].includes(tabName)) {
            this.state.pagination[tabName].page = 1;
            this.fetchActiveList();
        }
    }
    // --- ROUTE DETAIL & CHECKLIST LOGIC ---
    async viewRouteDetails(route) {
        this.state.selectedRouteDetails = { 
            ...route, 
            edit_zone_id: route.zone_id ? route.zone_id[0] : '' 
        };
        this.state.pagination.routeChecklist.page = 1;
        this.state.routeChecklistSearchQuery = '';
        await this.fetchRouteChecklist();
    }
    
    closeRouteDetails() {
        this.state.selectedRouteDetails = null;
    }

    async saveRouteZone() {
        const zoneId = parseInt(this.state.selectedRouteDetails.edit_zone_id, 10);
        const zone = this.state.areas.find((a) => a.id === zoneId);
        if (!zone || !zone.active) {
            this.notification.add(
                "Select an active zone. Archived zones cannot be used.",
                { type: "warning" },
            );
            return;
        }
        try {
            await this.orm.write("shahtaj.route", [this.state.selectedRouteDetails.id], {
                zone_id: zoneId
            });
            this.notification.add("Route zone updated.", { type: "success" });
            await this.fetchActiveList(); // Refresh lists
            
            // Update local state for immediate UI reflection
            this.state.selectedRouteDetails.zone_id = [zone.id, zone.name];
        } catch (error) {
            this.notification.add("Failed to update route: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async fetchRouteChecklist() {
        if (!this.state.selectedRouteDetails) return;
        this.state.isLoadingList = true;
        try {
            const pag = this.state.pagination.routeChecklist;
            // All approved shops — checked = on this route (multi-route allowed).
            let domain = [
                ['is_shahtaj_shop', '=', true],
                ['active', '=', true],
                ['shop_approval_state', '=', 'approved'],
            ];
            
            if (this.state.routeChecklistSearchQuery) {
                domain.push('|', ['name', 'ilike', this.state.routeChecklistSearchQuery], ['owner_name', 'ilike', this.state.routeChecklistSearchQuery]);
            }
            
            const [total, records] = await Promise.all([
                this.orm.searchCount('res.partner', domain),
                this.orm.searchRead(
                    'res.partner',
                    domain,
                    ["id", "name", "owner_name", "route_ids", "shahtaj_routes_display", "shahtaj_route_tag"],
                    { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "name asc" },
                ),
            ]);
            
            this.state.pagination.routeChecklist.total = total;
            this.state.tableRouteChecklist = records;
            
            // Live-refresh the route counts
            const routeData = await this.orm.read('shahtaj.route', [this.state.selectedRouteDetails.id], ['shop_count', 'unassigned_shop_count']);
            if (routeData.length) {
                this.state.selectedRouteDetails.shop_count = routeData[0].shop_count;
                this.state.selectedRouteDetails.unassigned_shop_count = routeData[0].unassigned_shop_count;
            }
        } catch (error) {
            this.notification.add("Failed to fetch checklist: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }

    isShopOnSelectedRoute(shop) {
        const routeId = this.state.selectedRouteDetails && this.state.selectedRouteDetails.id;
        if (!routeId || !shop) {
            return false;
        }
        return (shop.route_ids || []).includes(routeId);
    }

    formatShopRoutes(shop) {
        if (!shop) {
            return 'Unassigned';
        }
        if (shop.shahtaj_routes_display) {
            return shop.shahtaj_routes_display;
        }
        if (shop.shahtaj_route_tag === 'unassigned') {
            return 'Unassigned';
        }
        return 'Unassigned';
    }

    async _loadShopRouteLines(routeIds) {
        if (!routeIds || !routeIds.length) {
            return [];
        }
        const routes = await this.orm.read(
            'shahtaj.route',
            routeIds,
            ['id', 'name', 'zone_id'],
        );
        return routes
            .slice()
            .sort((a, b) => {
                const az = (a.zone_id && a.zone_id[1]) || '';
                const bz = (b.zone_id && b.zone_id[1]) || '';
                if (az !== bz) {
                    return az.localeCompare(bz);
                }
                return (a.name || '').localeCompare(b.name || '');
            })
            .map((route) => ({
                route_id: route.id,
                route_name: route.name || '—',
                zone_name: (route.zone_id && route.zone_id[1]) || '—',
            }));
    }

    async toggleShopRouteAssignment(shopId, ev) {
        const isAssigned = ev.target.checked;
        const routeId = this.state.selectedRouteDetails.id;
        try {
            // Add/remove this route only — do not clear other route links.
            const payload = isAssigned
                ? { route_ids: [[4, routeId]] }
                : { route_ids: [[3, routeId]] };
                
            await this.orm.write('res.partner', [shopId], payload);
            await this.fetchRouteChecklist();
            await this.fetchActiveList(); // Update main tab numbers quietly
        } catch (error) {
            this.notification.add("Failed to update shop assignment: " + (error.data?.message || error.message), { type: "danger" });
            ev.target.checked = !isAssigned; // Revert checkbox on fail
        }
    }

    // Checklist specific pagination handlers
    onChecklistSearchInput() {
        this.state.pagination.routeChecklist.page = 1;
        this.debouncedFetchRouteChecklist();
    }
    changeChecklistPage(direction) {
        const pag = this.state.pagination.routeChecklist;
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchRouteChecklist();
        }
    }
    cancelForms() {
        this.state.showAreaForm = false;
        this.state.showRouteForm = false;
        this.state.showShopForm = false;
        
        this.state.editingAreaId = null;
        this.state.editingRouteId = null;
        this.state.editingShopId = null;
        this.closeShopActionMenu();

        this.resetForms();
    }

    resetForms() {
        this.state.areaForm = { name: '', is_active: true };
        this.state.routeForm = { name: '', zone_id: '', is_active: true };
        this.state.shopForm = { 
            name: '', owner_name: '', owner_phone: '', owner_cnic_number: '', address: '',
            shopCategory: 'credit',
            creditLimit: '', legacyBalance: '', outstandingBalance: '',
            owner_cnic_front: null, owner_cnic_back: null, 
            owner_photo: null, shop_exterior_photo: null,
            preview_owner_cnic_front: null, preview_owner_cnic_back: null, 
            preview_owner_photo: null, preview_shop_exterior_photo: null
        };
    }
    // --- Archive Logic & Getters ---
    async toggleArchive(model, id, makeActive) {
        if (makeActive) {
            if (model === 'shahtaj.route') {
                try {
                    const impact = await this.orm.call('shahtaj.route', 'get_restore_impact', [[id]]);
                    const message = this.buildRestoreMessage(model, impact);
                    this.showConfirm("Restore Route", message, () => this.executeToggleArchive(model, id, makeActive));
                } catch (error) {
                    this.notification.add("Could not load restore impact: " + (error.data?.message || error.message), { type: "danger" });
                }
                return;
            }
            this.executeToggleArchive(model, id, makeActive);
            return;
        }
        try {
            const impact = await this.getArchiveImpact(model, id);
            const message = this.buildArchiveMessage(model, impact);
            this.showConfirm("Archive Territory Item", message, () => this.executeToggleArchive(model, id, makeActive));
        } catch (error) {
            this.notification.add("Could not load archive impact: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async getArchiveImpact(model, id) {
        if (model === 'shahtaj.zone') {
            return this.orm.call('shahtaj.zone', 'get_archive_impact', [[id]]);
        }
        if (model === 'shahtaj.route') {
            return this.orm.call('shahtaj.route', 'get_archive_impact', [[id]]);
        }
        if (model === 'res.partner') {
            return this.orm.call('res.partner', 'get_archive_impact', [[id]]);
        }
        return {};
    }

    buildRestoreMessage(model, impact) {
        if (model === 'shahtaj.route') {
            return `Restoring this route will reactivate ${impact.inactive_schedule_count || 0} weekly schedule(s) and regenerate visit tasks for bookers on this route. Shops are not cascade-archived with the route. Continue?`;
        }
        return "Restore this item?";
    }

    buildArchiveMessage(model, impact) {
        if (model === 'shahtaj.zone') {
            return `This will archive the zone and ${impact.active_route_count || 0} active route(s), and deactivate ${impact.active_schedule_count || 0} weekly schedule(s). Shops stay active; pending visit tasks on those routes will be cancelled. Continue?`;
        }
        if (model === 'shahtaj.route') {
            return `This will archive the route and deactivate ${impact.active_schedule_count || 0} weekly schedule(s). ${impact.active_shop_count || 0} linked shop(s) stay active and keep any other routes; pending tasks on this route will be cancelled. Continue?`;
        }
        if (model === 'res.partner') {
            return `This will archive the shop and cancel ${impact.pending_task_count || 0} pending visit task(s). Continue?`;
        }
        return "Are you sure you want to move this item to the archive?";
    }

 async executeToggleArchive(model, id, makeActive) {
        try {
            await this.orm.write(model, [id], { active: makeActive });
            await this.fetchDashboardData();
            await this.fetchActiveList(); 
            if (this.state.selectedShopDetails && this.state.selectedShopDetails.id === id) {
                this.closeShopDetails();
            }
            this.notification.add(`Item successfully ${makeActive ? 'restored' : 'archived'}.`, { type: "success" });
        } catch (error) {
            this.notification.add("Failed to update archive status: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    get archivedZones() { return this.state.areas.filter(a => !a.active); }
    get archivedRoutes() { return this.state.routes.filter(r => !r.active); }
    get archivedShops() { return this.state.shops.filter(s => !s.active); }

    onZoneChange() {
        this.state.shopForm.route_id = '';
    }

    get filteredRoutes() {
        if (!this.state.shopForm.zone_id) return [];
        const selectedZoneId = parseInt(this.state.shopForm.zone_id);
        const zone = this.state.areas.find((area) => area.id === selectedZoneId);
        if (!zone || !zone.active) return [];
        return this.state.routes.filter(
            (route) => route.active
                && route.zone_id
                && route.zone_id[0] === selectedZoneId,
        );
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

    toggleShopActionMenu(shopId, ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        this.state.shopActionMenuId = this.state.shopActionMenuId === shopId ? null : shopId;
    }

    closeShopActionMenu() {
        this.state.shopActionMenuId = null;
    }

    onShopMenuEdit(shop) {
        this.closeShopActionMenu();
        this.editShop(shop);
    }

    onShopMenuArchive(shop) {
        this.closeShopActionMenu();
        this.toggleArchive('res.partner', shop.id, false);
    }

    async viewShopDetails(shopId) {
        this.closeShopActionMenu();
        const details = await this.orm.read(
            "res.partner",
            [shopId],
            [
                "id", "name", "owner_name", "phone", "owner_cnic_number", "partner_latitude", "partner_longitude",
                "shahtaj_shop_category", "credit_limit", "legacy_balance", "outstanding_balance",
                "route_ids", "shahtaj_routes_display", "shahtaj_route_tag", "registered_by_id",
                "owner_cnic_front", "owner_cnic_back", "owner_photo", "shop_exterior_photo",
                "shop_approval_state"
            ]
        );
        if (details.length > 0) {
            const shop = details[0];
            shop.route_lines = await this._loadShopRouteLines(shop.route_ids || []);
            this.state.selectedShopDetails = shop;
            this.state.shopCategoryEdit = shop.shahtaj_shop_category || 'credit';
        }
    }

    closeShopDetails() {
        this.state.selectedShopDetails = null;
        this.state.shopCategoryEdit = 'credit';
        this.closeShopActionMenu();
    }

    async saveShopCategory() {
        if (!this.state.selectedShopDetails) return;
        const shopId = this.state.selectedShopDetails.id;
        try {
            await this.orm.write("res.partner", [shopId], { shahtaj_shop_category: this.state.shopCategoryEdit });
            await this.viewShopDetails(shopId);
            await this.fetchDashboardData();
            this.notification.add("Shop category updated.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to update shop category: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

   async approveShop(shopId) {
        this.state.isApprovingShop = true;
        try {
            await this.orm.call("res.partner", "action_approve_shop", [[shopId]]);
            await this.fetchDashboardData();
            if (this.state.selectedShopDetails && this.state.selectedShopDetails.id === shopId) {
                await this.viewShopDetails(shopId);
            }
            await this.fetchActiveList();
            this.notification.add("Shop approved successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to approve shop: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isApprovingShop = false;
        }
    }

    async rejectShop(shopId) {
        this.state.isRejectingShop = true;
        try {
            await this.orm.call("res.partner", "action_reject_shop", [[shopId]]);
            await this.fetchDashboardData();
            if (this.state.selectedShopDetails && this.state.selectedShopDetails.id === shopId) {
                await this.viewShopDetails(shopId);
            }
            await this.fetchActiveList();
            this.notification.add("Shop application rejected.", { type: "info" });
        } catch (error) {
            this.notification.add("Failed to reject shop: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isRejectingShop = false;
        }
    }

    confirmRejectShop(shopId) {
        this.showConfirm(
            "Reject Shop Application",
            "Reject this shop registration? The order booker can update and resubmit if needed.",
            () => this.rejectShop(shopId),
        );
    }

    approveSelectedShop() {
        if (!this.state.selectedShopDetails) return;
        this.approveShop(this.state.selectedShopDetails.id);
    }

    rejectSelectedShop() {
        if (!this.state.selectedShopDetails) return;
        this.confirmRejectShop(this.state.selectedShopDetails.id);
    }

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
        const details = await this.orm.read("res.partner", [shop.id], [
            "name", "owner_name", "phone", "owner_cnic_number",
            "shahtaj_shop_category", "credit_limit", "legacy_balance"
        ]);

        if (details.length > 0) {
            const d = details[0];
            this.state.shopForm = {
                name: d.name || '',
                owner_name: d.owner_name || '',
                owner_phone: d.phone || '',
                owner_cnic_number: d.owner_cnic_number || '',
                shopCategory: d.shahtaj_shop_category || 'credit',
                creditLimit: d.credit_limit || '',
                legacyBalance: d.legacy_balance || '',
                owner_cnic_front: null, owner_cnic_back: null, 
                owner_photo: null, shop_exterior_photo: null,
                preview_owner_cnic_front: null, preview_owner_cnic_back: null, 
                preview_owner_photo: null, preview_shop_exterior_photo: null
            };
            this.state.editingShopId = shop.id;
            this.state.showShopForm = true;
        }
    }

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
        await this.fetchActiveList(); // FIX: Refresh table immediately
    }

   async saveRoute() {
        if (!this.state.routeForm.name || !this.state.routeForm.zone_id) {
            this.notification.add("Route Name and Parent Zone are required.", { type: "warning" });
            return;
        }
        const zoneId = parseInt(this.state.routeForm.zone_id, 10);
        const zone = this.state.areas.find((a) => a.id === zoneId);
        if (!zone || !zone.active) {
            this.notification.add(
                "Select an active zone. Archived zones cannot be used for routes.",
                { type: "warning" },
            );
            return;
        }

        const payload = {
            name: this.state.routeForm.name,
            zone_id: zoneId,
            active: this.state.routeForm.is_active
        };

        try {
            if (this.state.editingRouteId) {
                await this.orm.write("shahtaj.route", [this.state.editingRouteId], payload);
            } else {
                await this.orm.create("shahtaj.route", [payload]);
            }
            this.cancelForms();
            await this.fetchDashboardData();
            await this.fetchActiveList(); // FIX: Refresh table immediately
        } catch (error) {
            this.notification.add("Failed to save route: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    async saveShop() {
        const phone = this.state.shopForm.owner_phone;
        const cnic = this.state.shopForm.owner_cnic_number;

        if (!(this.state.shopForm.name || '').trim()) {
            this.notification.add("Shop name is required.", { type: "warning" });
            return;
        }

        this.state.isLoading = true;
        
        try {
            const payload = {
                is_shahtaj_shop: true,
                company_type: 'company',
                shahtaj_shop_category: this.state.shopForm.shopCategory || 'credit',
                name: this.state.shopForm.name,
                owner_name: this.state.shopForm.owner_name || false,
                owner_phone: phone || false,
                phone: phone || false,
                owner_cnic_number: cnic || false,
                credit_limit: this.state.shopForm.shopCategory === 'credit'
                    ? (parseFloat(this.state.shopForm.creditLimit) || 0.0)
                    : 0.0,
                legacy_balance: parseFloat(this.state.shopForm.legacyBalance) || 0.0,
            };

            if (this.state.shopForm.owner_cnic_front) payload.owner_cnic_front = this.state.shopForm.owner_cnic_front;
            if (this.state.shopForm.owner_cnic_back) payload.owner_cnic_back = this.state.shopForm.owner_cnic_back;
            if (this.state.shopForm.owner_photo) payload.owner_photo = this.state.shopForm.owner_photo;

            if (this.state.editingShopId) {
                await this.orm.write("res.partner", [this.state.editingShopId], payload);
                this.notification.add("Shop updated successfully.", { type: "success" });
            } else {
                payload.shop_approval_state = 'pending';
                await this.orm.create("res.partner", [payload]);
                this.notification.add("Shop registered and pending approval.", { type: "success" });
            }

            this.cancelForms();
            await this.fetchDashboardData();
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add("Failed to save shop: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }
}

TerritoryRoutes.template = "shahtaj_oil.TerritoryRoutes";