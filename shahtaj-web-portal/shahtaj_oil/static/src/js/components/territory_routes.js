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
            shopFilterVerified: 'all',
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
                shopCategory: 'cash',
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
            showAddShopModal: false,
            addShopSearchQuery: '',
            tableAddShopCandidates: [],
            addShopSelectedIds: {},
            isLoadingAddShops: false,
            isAddingShops: false,
            shopRouteSearchQuery: '',
            showAddRouteModal: false,
            addRouteSearchQuery: '',
            tableAddRouteCandidates: [],
            addRouteSelectedIds: {},
            isLoadingAddRoutes: false,
            isAddingRoutes: false,
            returnToShopDetailsAfterEdit: null,
            pagination: {
                areas: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                routes: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                shops: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                routeChecklist: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                addShops: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                addRoutes: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                shopRoutes: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
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
        this.debouncedFetchRouteChecklist = this.debounceSearch(() => this.fetchRouteChecklist(), 400);
        this.debouncedFetchAddShopCandidates = this.debounceSearch(() => this.fetchAddShopCandidates(), 400);
        this.debouncedFetchAddRouteCandidates = this.debounceSearch(() => this.fetchAddRouteCandidates(), 400);

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
                if (this.state.shopFilterVerified !== 'all') {
                    if (this.state.shopFilterVerified === 'verified') {
                        domain.push(['shahtaj_visit_tag', '=', 'visited']);
                    } else {
                        domain.push(['shahtaj_visit_tag', '!=', 'visited']);
                    }
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
            const verifiedMatch = this.state.shopFilterVerified !== 'all'
                ? (this.state.shopFilterVerified === 'verified' ? shop.shahtaj_visit_tag === 'visited' : shop.shahtaj_visit_tag !== 'visited')
                : true;

            return searchMatch && categoryMatch && statusMatch && verifiedMatch;
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
            const verifiedMatch = this.state.shopFilterVerified !== 'all'
                ? (this.state.shopFilterVerified === 'verified' ? shop.shahtaj_visit_tag === 'visited' : shop.shahtaj_visit_tag !== 'visited')
                : true;

            return searchMatch && categoryMatch && statusMatch && verifiedMatch;
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
        this.closeAddShopModal();
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
            const routeId = this.state.selectedRouteDetails.id;
            // Assigned shops on this route only.
            let domain = [
                ['is_shahtaj_shop', '=', true],
                ['active', '=', true],
                ['shop_approval_state', '=', 'approved'],
                ['route_ids', 'in', [routeId]],
            ];

            if (this.state.routeChecklistSearchQuery) {
                domain.push('|', ['name', 'ilike', this.state.routeChecklistSearchQuery], ['owner_name', 'ilike', this.state.routeChecklistSearchQuery]);
            }

            const [total, records] = await Promise.all([
                this.orm.searchCount('res.partner', domain),
                this.orm.searchRead(
                    'res.partner',
                    domain,
                    ["id", "name", "owner_name"],
                    { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "name asc" },
                ),
            ]);

            this.state.pagination.routeChecklist.total = total;
            this.state.tableRouteChecklist = records;

            const routeData = await this.orm.read('shahtaj.route', [routeId], ['shop_count', 'unassigned_shop_count']);
            if (routeData.length) {
                this.state.selectedRouteDetails.shop_count = routeData[0].shop_count;
                this.state.selectedRouteDetails.unassigned_shop_count = routeData[0].unassigned_shop_count;
            }
        } catch (error) {
            this.notification.add("Failed to fetch assigned shops: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }

    get addShopSelectedCount() {
        return Object.keys(this.state.addShopSelectedIds || {}).filter(
            (id) => this.state.addShopSelectedIds[id],
        ).length;
    }

    get isAllAddShopPageSelected() {
        const rows = this.state.tableAddShopCandidates || [];
        if (!rows.length) {
            return false;
        }
        return rows.every((s) => this.state.addShopSelectedIds[s.id]);
    }

    openAddShopModal() {
        if (!this.state.selectedRouteDetails) {
            return;
        }
        this.state.showAddShopModal = true;
        this.state.addShopSearchQuery = '';
        this.state.addShopSelectedIds = {};
        this.state.pagination.addShops.page = 1;
        this.fetchAddShopCandidates();
    }

    closeAddShopModal() {
        this.state.showAddShopModal = false;
        this.state.addShopSearchQuery = '';
        this.state.tableAddShopCandidates = [];
        this.state.addShopSelectedIds = {};
        this.state.isLoadingAddShops = false;
        this.state.isAddingShops = false;
        this.state.pagination.addShops.page = 1;
        this.state.pagination.addShops.total = 0;
    }

    onAddShopSearchInput() {
        this.state.pagination.addShops.page = 1;
        this.debouncedFetchAddShopCandidates();
    }

    changeAddShopPage(direction) {
        const pag = this.state.pagination.addShops;
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchAddShopCandidates();
        }
    }

    async fetchAddShopCandidates() {
        if (!this.state.selectedRouteDetails || !this.state.showAddShopModal) {
            return;
        }
        this.state.isLoadingAddShops = true;
        try {
            const pag = this.state.pagination.addShops;
            const routeId = this.state.selectedRouteDetails.id;
            let domain = [
                ['is_shahtaj_shop', '=', true],
                ['active', '=', true],
                ['shop_approval_state', '=', 'approved'],
                ['route_ids', 'not in', [routeId]],
            ];
            if (this.state.addShopSearchQuery) {
                domain.push(
                    '|',
                    ['name', 'ilike', this.state.addShopSearchQuery],
                    ['owner_name', 'ilike', this.state.addShopSearchQuery],
                );
            }
            const [total, records] = await Promise.all([
                this.orm.searchCount('res.partner', domain),
                this.orm.searchRead(
                    'res.partner',
                    domain,
                    ['id', 'name', 'owner_name'],
                    { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: 'name asc' },
                ),
            ]);
            this.state.pagination.addShops.total = total;
            this.state.tableAddShopCandidates = records;
        } catch (error) {
            this.notification.add(
                "Failed to load shops: " + (error.data?.message || error.message),
                { type: "danger" },
            );
        } finally {
            this.state.isLoadingAddShops = false;
        }
    }

    toggleAddShopSelection(shopId) {
        const next = { ...this.state.addShopSelectedIds };
        if (next[shopId]) {
            delete next[shopId];
        } else {
            next[shopId] = true;
        }
        this.state.addShopSelectedIds = next;
    }

    toggleSelectAllAddShopPage(ev) {
        const selectAll = ev.target.checked;
        const next = { ...this.state.addShopSelectedIds };
        for (const shop of this.state.tableAddShopCandidates) {
            if (selectAll) {
                next[shop.id] = true;
            } else {
                delete next[shop.id];
            }
        }
        this.state.addShopSelectedIds = next;
    }

    async confirmAddSelectedShops() {
        const routeId = this.state.selectedRouteDetails && this.state.selectedRouteDetails.id;
        const shopIds = Object.keys(this.state.addShopSelectedIds)
            .filter((id) => this.state.addShopSelectedIds[id])
            .map((id) => parseInt(id, 10));
        if (!routeId || !shopIds.length) {
            this.notification.add("Select at least one shop to add.", { type: "warning" });
            return;
        }
        this.state.isAddingShops = true;
        try {
            await Promise.all(
                shopIds.map((shopId) => this.orm.write('res.partner', [shopId], {
                    route_ids: [[4, routeId]],
                })),
            );
            this.notification.add(
                `${shopIds.length} shop(s) added to this route.`,
                { type: "success" },
            );
            this.closeAddShopModal();
            await this.fetchRouteChecklist();
            await this.fetchActiveList();
        } catch (error) {
            this.notification.add(
                "Failed to add shops: " + (error.data?.message || error.message),
                { type: "danger" },
            );
        } finally {
            this.state.isAddingShops = false;
        }
    }

    removeShopFromRoute(shop) {
        if (!shop || !this.state.selectedRouteDetails) {
            return;
        }
        const routeId = this.state.selectedRouteDetails.id;
        const routeName = this.state.selectedRouteDetails.name || 'this route';
        this.state.confirmModal = {
            isOpen: true,
            title: 'Remove shop from route',
            message: `Remove "${shop.name}" from ${routeName}? The shop stays on any other routes.`,
            onConfirm: async () => {
                this.closeConfirm();
                try {
                    await this.orm.write('res.partner', [shop.id], {
                        route_ids: [[3, routeId]],
                    });
                    this.notification.add("Shop removed from this route.", { type: "success" });
                    await this.fetchRouteChecklist();
                    await this.fetchActiveList();
                } catch (error) {
                    this.notification.add(
                        "Failed to remove shop: " + (error.data?.message || error.message),
                        { type: "danger" },
                    );
                }
            },
        };
    }

    get filteredShopRouteLines() {
        const lines = (this.state.selectedShopDetails && this.state.selectedShopDetails.route_lines) || [];
        const q = (this.state.shopRouteSearchQuery || '').trim().toLowerCase();
        if (!q) {
            return lines;
        }
        return lines.filter(
            (line) =>
                (line.route_name || '').toLowerCase().includes(q) ||
                (line.zone_name || '').toLowerCase().includes(q),
        );
    }

    get paginatedShopRouteLines() {
        const lines = this.filteredShopRouteLines;
        const pag = this.state.pagination.shopRoutes;
        const start = (pag.page - 1) * pag.limit;
        return lines.slice(start, start + pag.limit);
    }

    get addRouteSelectedCount() {
        return Object.keys(this.state.addRouteSelectedIds || {}).filter(
            (id) => this.state.addRouteSelectedIds[id],
        ).length;
    }

    get isAllAddRoutePageSelected() {
        const rows = this.state.tableAddRouteCandidates || [];
        if (!rows.length) {
            return false;
        }
        return rows.every((r) => this.state.addRouteSelectedIds[r.id]);
    }

    onShopRouteSearchInput() {
        this.state.pagination.shopRoutes.page = 1;
        this._syncShopRoutesPagination();
    }

    changeShopRoutePage(direction) {
        this._syncShopRoutesPagination();
        const pag = this.state.pagination.shopRoutes;
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit) || 1);
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
        }
    }

    _syncShopRoutesPagination() {
        const total = this.filteredShopRouteLines.length;
        const pag = this.state.pagination.shopRoutes;
        pag.total = total;
        const maxPage = Math.max(1, Math.ceil(total / pag.limit) || 1);
        if (pag.page > maxPage) {
            pag.page = maxPage;
        }
        if (pag.page < 1) {
            pag.page = 1;
        }
    }

    openAddRouteModal() {
        if (!this.state.selectedShopDetails) {
            return;
        }
        this.state.showAddRouteModal = true;
        this.state.addRouteSearchQuery = '';
        this.state.addRouteSelectedIds = {};
        this.state.pagination.addRoutes.page = 1;
        this.fetchAddRouteCandidates();
    }

    closeAddRouteModal() {
        this.state.showAddRouteModal = false;
        this.state.addRouteSearchQuery = '';
        this.state.tableAddRouteCandidates = [];
        this.state.addRouteSelectedIds = {};
        this.state.isLoadingAddRoutes = false;
        this.state.isAddingRoutes = false;
        this.state.pagination.addRoutes.page = 1;
        this.state.pagination.addRoutes.total = 0;
    }

    onAddRouteSearchInput() {
        this.state.pagination.addRoutes.page = 1;
        this.debouncedFetchAddRouteCandidates();
    }

    changeAddRoutePage(direction) {
        const pag = this.state.pagination.addRoutes;
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchAddRouteCandidates();
        }
    }

    async fetchAddRouteCandidates() {
        if (!this.state.selectedShopDetails || !this.state.showAddRouteModal) {
            return;
        }
        this.state.isLoadingAddRoutes = true;
        try {
            const pag = this.state.pagination.addRoutes;
            const assigned = this.state.selectedShopDetails.route_ids || [];
            let domain = [['active', '=', true]];
            if (assigned.length) {
                domain.push(['id', 'not in', assigned]);
            }
            if (this.state.addRouteSearchQuery) {
                domain.push(
                    '|',
                    ['name', 'ilike', this.state.addRouteSearchQuery],
                    ['zone_id.name', 'ilike', this.state.addRouteSearchQuery],
                );
            }
            const [total, records] = await Promise.all([
                this.orm.searchCount('shahtaj.route', domain),
                this.orm.searchRead(
                    'shahtaj.route',
                    domain,
                    ['id', 'name', 'zone_id'],
                    { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: 'name asc' },
                ),
            ]);
            this.state.pagination.addRoutes.total = total;
            this.state.tableAddRouteCandidates = records;
        } catch (error) {
            this.notification.add(
                "Failed to load routes: " + (error.data?.message || error.message),
                { type: "danger" },
            );
        } finally {
            this.state.isLoadingAddRoutes = false;
        }
    }

    toggleAddRouteSelection(routeId) {
        const next = { ...this.state.addRouteSelectedIds };
        if (next[routeId]) {
            delete next[routeId];
        } else {
            next[routeId] = true;
        }
        this.state.addRouteSelectedIds = next;
    }

    toggleSelectAllAddRoutePage(ev) {
        const selectAll = ev.target.checked;
        const next = { ...this.state.addRouteSelectedIds };
        for (const route of this.state.tableAddRouteCandidates) {
            if (selectAll) {
                next[route.id] = true;
            } else {
                delete next[route.id];
            }
        }
        this.state.addRouteSelectedIds = next;
    }

    async refreshShopRouteMembership() {
        const shop = this.state.selectedShopDetails;
        if (!shop) {
            return;
        }
        const [updated] = await this.orm.read(
            'res.partner',
            [shop.id],
            ['route_ids', 'shahtaj_routes_display', 'shahtaj_route_tag'],
        );
        if (!updated) {
            return;
        }
        shop.route_ids = updated.route_ids;
        shop.shahtaj_routes_display = updated.shahtaj_routes_display;
        shop.shahtaj_route_tag = updated.shahtaj_route_tag;
        shop.route_lines = await this._loadShopRouteLines(shop.route_ids || []);
        this._syncShopRoutesPagination();
        await this.fetchDashboardData();
        await this.fetchActiveList();
    }

    async confirmAddSelectedRoutes() {
        const shop = this.state.selectedShopDetails;
        const routeIds = Object.keys(this.state.addRouteSelectedIds)
            .filter((id) => this.state.addRouteSelectedIds[id])
            .map((id) => parseInt(id, 10));
        if (!shop || !routeIds.length) {
            this.notification.add("Select at least one route to add.", { type: "warning" });
            return;
        }
        this.state.isAddingRoutes = true;
        try {
            await this.orm.write('res.partner', [shop.id], {
                route_ids: routeIds.map((routeId) => [4, routeId]),
            });
            this.notification.add(
                `${routeIds.length} route(s) assigned to this shop.`,
                { type: "success" },
            );
            this.closeAddRouteModal();
            await this.refreshShopRouteMembership();
        } catch (error) {
            this.notification.add(
                "Failed to add routes: " + (error.data?.message || error.message),
                { type: "danger" },
            );
        } finally {
            this.state.isAddingRoutes = false;
        }
    }

    removeRouteFromShop(line) {
        const shop = this.state.selectedShopDetails;
        if (!shop || !line) {
            return;
        }
        this.state.confirmModal = {
            isOpen: true,
            title: 'Remove shop from route',
            message: `Remove this shop from "${line.route_name}"? The shop stays on any other routes.`,
            onConfirm: async () => {
                this.closeConfirm();
                try {
                    await this.orm.write('res.partner', [shop.id], {
                        route_ids: [[3, line.route_id]],
                    });
                    this.notification.add("Shop removed from this route.", { type: "success" });
                    await this.refreshShopRouteMembership();
                } catch (error) {
                    this.notification.add(
                        "Failed to remove route: " + (error.data?.message || error.message),
                        { type: "danger" },
                    );
                }
            },
        };
    }

    async editShopFromDetails() {
        const shop = this.state.selectedShopDetails;
        if (!shop) {
            return;
        }
        const shopId = shop.id;
        this.closeAddRouteModal();
        this.state.returnToShopDetailsAfterEdit = shopId;
        this.closeShopDetails();
        await this.editShop({ id: shopId });
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
        const reopenShopId = this.state.returnToShopDetailsAfterEdit;
        this.state.returnToShopDetailsAfterEdit = null;

        this.state.showAreaForm = false;
        this.state.showRouteForm = false;
        this.state.showShopForm = false;
        
        this.state.editingAreaId = null;
        this.state.editingRouteId = null;
        this.state.editingShopId = null;
        this.closeShopActionMenu();

        this.resetForms();

        if (reopenShopId) {
            this.viewShopDetails(reopenShopId);
        }
    }

    resetForms() {
        this.state.areaForm = { name: '', is_active: true };
        this.state.routeForm = { name: '', zone_id: '', is_active: true };
        this.state.shopForm = { 
            name: '', owner_name: '', owner_phone: '', owner_cnic_number: '', address: '',
            shopCategory: 'cash',
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

    async viewShopDetails(shopId) {
        this.closeShopActionMenu();
        const details = await this.orm.read(
            "res.partner",
            [shopId],
            [
                "id", "name", "owner_name", "phone", "owner_cnic_number", "shop_license_number", "partner_latitude", "partner_longitude",
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
            this.state.shopRouteSearchQuery = '';
            this.state.pagination.shopRoutes.page = 1;
            this._syncShopRoutesPagination();
        }
    }

    closeShopDetails() {
        this.closeAddRouteModal();
        this.state.selectedShopDetails = null;
        this.state.shopCategoryEdit = 'credit';
        this.state.shopRouteSearchQuery = '';
        this.state.pagination.shopRoutes.page = 1;
        this.state.pagination.shopRoutes.total = 0;
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
            "name", "owner_name", "phone", "owner_cnic_number", "shop_license_number",
            "shahtaj_shop_category", "credit_limit", "legacy_balance"
        ]);

        if (details.length > 0) {
            const d = details[0];
            this.state.shopForm = {
                name: d.name || '',
                owner_name: d.owner_name || '',
                owner_phone: d.phone || '',
                owner_cnic_number: d.owner_cnic_number || '',
                shop_license_number: d.shop_license_number || '',
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
                shahtaj_shop_category: this.state.shopForm.shopCategory || 'cash',
                name: this.state.shopForm.name,
                owner_name: this.state.shopForm.owner_name || false,
                owner_phone: phone || false,
                phone: phone || false,
                owner_cnic_number: cnic || false,
                shop_license_number: this.state.shopForm.shop_license_number || false,
                credit_limit: this.state.shopForm.shopCategory === 'credit'
                    ? (parseFloat(this.state.shopForm.creditLimit) || 0.0)
                    : 0.0,
                legacy_balance: parseFloat(this.state.shopForm.legacyBalance) || 0.0,
            };

            if (this.state.shopForm.owner_cnic_front) payload.owner_cnic_front = this.state.shopForm.owner_cnic_front;
            if (this.state.shopForm.owner_cnic_back) payload.owner_cnic_back = this.state.shopForm.owner_cnic_back;
            if (this.state.shopForm.owner_photo) payload.owner_photo = this.state.shopForm.owner_photo;

            const reopenShopId = this.state.returnToShopDetailsAfterEdit
                || (this.state.editingShopId || null);
            const cameFromDetails = !!this.state.returnToShopDetailsAfterEdit;

            if (this.state.editingShopId) {
                await this.orm.write("res.partner", [this.state.editingShopId], payload);
                this.notification.add("Shop updated successfully.", { type: "success" });
            } else {
                payload.shop_approval_state = 'pending';
                await this.orm.create("res.partner", [payload]);
                this.notification.add("Shop registered and pending approval.", { type: "success" });
            }

            // Avoid cancelForms auto-reopening before lists refresh; reopen after.
            this.state.returnToShopDetailsAfterEdit = null;
            this.cancelForms();
            await this.fetchDashboardData();
            await this.fetchActiveList();
            if (cameFromDetails && reopenShopId) {
                await this.viewShopDetails(reopenShopId);
            }
        } catch (error) {
            this.notification.add("Failed to save shop: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }
}

TerritoryRoutes.template = "shahtaj_oil.TerritoryRoutes";