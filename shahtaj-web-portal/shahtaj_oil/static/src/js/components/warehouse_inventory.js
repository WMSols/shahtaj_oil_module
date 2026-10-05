/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ConfirmModal } from "./confirm_modal";
import {
    canManageProducts,
    canMutate,
    canSee,
    firstAllowedSub,
    hasFinancialAccess,
    loadPortalAccess,
    notifyPortalBusy,
    showPrices,
} from "../shahtaj_access";
import { filterOptionValue, setFilterField } from "../shahtaj_filter_ui";

export class WarehouseInventory extends Component {
    static props = {
        requestedSubTab: { type: String, optional: true },
        requestedStockStatus: { type: String, optional: true },
    };
    static components = { ConfirmModal };
    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this._listFetchToken = 0;
        // Universal items per page shared across Inventory, Stock, and Taxes
        const ITEMS_PER_PAGE = 50;
        this.state = useState({
            activeSubTab: this._normalizeSubTab(this.props.requestedSubTab || 'inventory'),
            previousSubTab: 'inventory',
            
            showWarehouseForm: false,
            showProductAddForm: false,
            showProductDetails: false,
            
            // --- NEW: Tax Management States ---
            showTaxForm: false,
            editingTaxId: null,
            taxForm: { name: '', amount: 0.0, active: true },
            warehouseForm: { name: '', type: '', location: '', manager: '' },
            
            productForm: this.getEmptyProductForm(),
            currentProduct: null,
            saleTaxes: [],
            defaultTaxId: "", 
            allVendors: [],
            createdProductPrompt: null,
            confirmModal: { isOpen: false, title: '', message: '', onConfirm: null },
            isLoading: false,
            // --- NEW: Backend Pagination & Loading ---
            itemsPerPage: ITEMS_PER_PAGE,
            isLoadingList: false,
            searchTimeout: null,
            tableInventory: [],
            tableStock: [],
            tableTaxes: [],
            archivedProductsList: [],
            archivedTaxesList: [],
            pagination: {
                inventory: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                management: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                taxes: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            filters: {
                inventory: { search: '', sort: 'default' },
                management: { search: '', status: this.props.requestedStockStatus || 'all' },
                taxes: { search: '' }
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

        onWillStart(async () => {
            await loadPortalAccess();
            this.state.activeSubTab = this._normalizeSubTab(this.state.activeSubTab);
            const extras = [];
            if (canMutate() && hasFinancialAccess()) {
                extras.push(this.loadSaleTaxes());
            }
            if (canManageProducts()) {
                extras.push(this.loadVendors());
            }
            if (canMutate()) {
                extras.push(this.loadArchivedData());
            }
            await Promise.all(extras);
            await this.fetchActiveList();
        });
        onWillUpdateProps((nextProps) => {
            const status = nextProps.requestedStockStatus || 'all';
            const statusChanged = status !== (this.props.requestedStockStatus || 'all');
            if (statusChanged) {
                this.state.filters.management.status = status;
                this.state.pagination.management.page = 1;
            }
            const subChanged = nextProps.requestedSubTab && nextProps.requestedSubTab !== this.state.activeSubTab;
            if (subChanged) {
                this.setSubTab(nextProps.requestedSubTab);
            } else if (statusChanged && this.state.activeSubTab === 'management') {
                this.fetchActiveList();
            }
        });

    }
    // --- UNIVERSAL PAGINATION HANDLERS ---
    onSearchInput(ev, tabName) {
        this.state.filters[tabName].search = ev.target.value;
        this.state.pagination[tabName].page = 1; 
        this.debouncedFetchActiveList();
    }

    onFilterChange(tabName) {
        this.state.pagination[tabName].page = 1;
        this.fetchActiveList(); 
    }

    onFilterField(listKey, field, ev) {
        setFilterField(this.state, listKey, field, ev.target.value);
        this.onFilterChange(listKey);
    }

    onProductVendorChange(ev, formTarget) {
        const value = ev.target.value;
        if (formTarget === "edit" && this.state.currentProduct) {
            this.state.currentProduct.vendor_id = value;
        } else if (formTarget === "new") {
            this.state.productForm.vendor_id = value;
        }
    }

    filterOptionValue(id) {
        return filterOptionValue(id);
    }

    _ensureVendorInDropdown(vendorId, vendorName) {
        if (!vendorId) {
            return;
        }
        const id = parseInt(String(vendorId), 10);
        if (!id) {
            return;
        }
        if (!this.state.allVendors.some((v) => v.id === id)) {
            this.state.allVendors = [
                ...this.state.allVendors,
                { id, name: vendorName || `Vendor #${id}` },
            ];
        }
    }

    _vendorIdFromProduct(product) {
        const raw = product.shahtaj_vendor_id;
        if (Array.isArray(raw) && raw.length > 0) {
            return filterOptionValue(raw[0]);
        }
        if (typeof raw === "number") {
            return filterOptionValue(raw);
        }
        if (typeof raw === "string" && raw) {
            return raw;
        }
        return "";
    }

    clearFilters(listKey) {
        const defaults = {
            inventory: { search: "", sort: "default" },
            management: { search: "", status: "all" },
            taxes: { search: "" },
        };
        if (!defaults[listKey]) {
            return;
        }
        this.state.filters[listKey] = { ...defaults[listKey] };
        if (this.state.pagination[listKey]) {
            this.state.pagination[listKey].page = 1;
        }
        if (listKey === "inventory") {
            this.state.tableInventory = [];
        } else if (listKey === "management") {
            this.state.tableStock = [];
        } else if (listKey === "taxes") {
            this.state.tableTaxes = [];
        }
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

    // --- DATA FETCHERS ---
    async loadVendors() {
        try {
            this.state.allVendors = await this.orm.searchRead(
                "res.partner",
                [['supplier_rank', '>', 0], ['is_shahtaj_shop', '=', false]],
                ["id", "name"]
            );
        } catch (e) {
            console.error("Failed to load vendors for product dropdown:", e);
        }
    }

    async loadArchivedData() {
        const [products, taxes] = await Promise.all([
            this.orm.searchRead("product.template", [['sale_ok', '=', true], ['active', '=', false]], ["id", "name", "uom_name", "shahtaj_sale_uom"]),
            hasFinancialAccess() ? this.orm.searchRead("account.tax", [['type_tax_use', '=', 'sale'], ['active', '=', false]], ["id", "name", "amount"]) : Promise.resolve([])
        ]);
        this.state.archivedProductsList = products || [];
        this.state.archivedTaxesList = taxes || [];
    }

    get archivedProducts() { return this.state.archivedProductsList; }
    get archivedTaxes() { return this.state.archivedTaxesList; }

    async fetchActiveList() {
        const tab = this.state.activeSubTab;
        if (!['inventory', 'management', 'taxes'].includes(tab)) return;

        const fetchToken = ++this._listFetchToken;
        this.state.isLoadingList = true;
        notifyPortalBusy(true);
        try {
            const pag = this.state.pagination[tab];
            const filters = this.state.filters[tab];
            let domain = [];
            let model = '';
            let fields = [];
            let targetState = '';
            let order = 'id desc';

            if (tab === 'inventory' || tab === 'management') {
                model = 'product.template';
                fields = ["id", "name", "categ_id", "qty_available", "uom_name", "type", "is_storable", "list_price", "standard_price", "shahtaj_vendor_id", "shahtaj_vendor_name", "barcode", "weight", "volume", "invoice_policy", "image_1920", "shahtaj_qty_bookable", "shahtaj_qty_received", "shahtaj_qty_sold", "virtual_available", "shahtaj_sale_uom", "shahtaj_kg_per_unit", "taxes_id", "active"];
                domain = [['sale_ok', '=', true], ['default_code', '!=', 'SHAHTAJ-LEGACY'], ['active', '=', true]];
                
                if (filters.search) domain.push(['name', 'ilike', filters.search]);

                if (tab === 'inventory') {
                    targetState = 'tableInventory';
                    if (filters.sort === 'price_asc') order = 'list_price asc';
                    else if (filters.sort === 'price_desc') order = 'list_price desc';
                    // Note: qty_available sorting removed because Odoo cannot sort non-stored computed fields via SQL
                } else {
                    targetState = 'tableStock';
                    if (filters.status === 'in_stock') domain.push(['qty_available', '>', 0]);
                    else if (filters.status === 'out_of_stock') domain.push(['qty_available', '<=', 0]);
                }
            } else if (tab === 'taxes') {
                model = 'account.tax';
                fields = ["id", "name", "amount", "active"];
                targetState = 'tableTaxes';
                domain = [['type_tax_use', '=', 'sale'], ['active', '=', true]];
                if (filters.search) domain.push(['name', 'ilike', filters.search]);
            }

            const [total, records] = await Promise.all([
                this.orm.searchCount(model, domain),
                this.orm.searchRead(model, domain, fields, { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: order })
            ]);

            if (fetchToken !== this._listFetchToken) {
                return;
            }

            this.state.pagination[tab].total = total;
            
            if (tab === 'inventory' || tab === 'management') {
                this.state[targetState] = records.map(p => ({ ...p, tax_label: this.getTaxLabel(p.taxes_id || []) }));
            } else {
                this.state[targetState] = records;
            }
        } catch (error) {
            this.notification.add("Failed to fetch list: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            if (fetchToken === this._listFetchToken) {
                this.state.isLoadingList = false;
                notifyPortalBusy(false);
            }
        }
    }
    
    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    get canMutate() {
        return canMutate();
    }

    get showPrices() {
        return showPrices();
    }

    get canManageProducts() {
        return canManageProducts();
    }

    formatStockQty(value) {
        return (Number(value) || 0).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    get productListColspan() {
        let columns = 2;
        if (this.showPrices) {
            columns += 1;
        }
        if (this.canManageProducts) {
            columns += 1;
        }
        return columns;
    }

    _normalizeSubTab(tabName) {
        const tab = tabName || "management";
        if (canSee("warehouse", tab)) {
            return tab;
        }
        return firstAllowedSub("warehouse") || "management";
    }
   
    // --- Modal & Archive Handlers ---
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

    toggleArchive(model, id, makeActive) {
        if (model === "product.template" && !this.canManageProducts) {
            return;
        }
        if (makeActive) {
            this.executeToggleArchive(model, id, makeActive);
        } else {
            const itemType = model === 'product.template' ? 'product' : 'tax configuration';
            this.showConfirm(
                `Archive ${itemType}`,
                `Are you sure you want to move this ${itemType} to the archive?`,
                () => this.executeToggleArchive(model, id, makeActive)
            );
        }
    }

    async executeToggleArchive(model, id, makeActive) {
        try {
            await this.orm.write(model, [id], { active: makeActive });
            await Promise.all([
                this.loadArchivedData(),
                this.fetchActiveList()
            ]);
            if (model === 'account.tax') await this.loadSaleTaxes();
        } catch (error) {
            this.notification.add("Failed to update archive status: " + (error.data?.message || error.message), { type: "danger" });
        }
    }
    getEmptyProductForm() {
        return {
            name: '',
            vendor_id: '',
            track_inventory: true,
            invoice_policy: 'order',
            type: 'consu',
            shahtaj_sale_uom: 'piece',
            shahtaj_kg_per_unit: 1.0,
            // Start with no tax — user must opt in (do not auto-apply company default).
            tax_id: "",
            barcode: '',
            weight: 0.0,
            volume: 0.0,
            image_1920: false
        };
    }

    formatTaxLabel(tax) {
        if (tax.amount_type === 'percent') {
            return `${tax.name} (${tax.amount}%)`;
        }
        return tax.name;
    }

    async loadSaleTaxes() {
        const taxes = await this.orm.call(
            'product.template',
            'get_shahtaj_sale_tax_options',
            [],
        );
        this.state.saleTaxes = (taxes || []).map((tax) => ({
            ...tax,
            label: this.formatTaxLabel(tax),
        }));
        
        const defaultTax = this.state.saleTaxes.find((tax) => tax.is_default);
        if (defaultTax) {
            this.state.defaultTaxId = defaultTax.id.toString();
        }
        // Intentionally do not pre-select defaultTaxId on the create form.
    }

    getTaxLabel(taxIds) {
        if (!taxIds || !taxIds.length) {
            return 'No tax';
        }
        const primaryTaxId = taxIds[0];
        const tax = this.state.saleTaxes.find((t) => t.id === primaryTaxId);
        return tax ? tax.label : 'No tax';
    }
    onSaleUomChange(formTarget) {
        const defaults = { kg: 1.0, ton: 1000.0, litre: 1.0, piece: 1.0 };
        const form = formTarget === 'edit' ? this.state.currentProduct : this.state.productForm;
        if (form) {
            form.shahtaj_kg_per_unit = defaults[form.shahtaj_sale_uom] || 1.0;
        }
    }
   setSubTab(tabName) {
        tabName = this._normalizeSubTab(tabName);
        if (tabName === 'archive' && this.state.activeSubTab !== 'archive') {
            this.state.previousSubTab = this.state.activeSubTab;
        }
        this.state.activeSubTab = tabName;
        this.resetForms();

        // Trigger pagination when switching tabs
        if (['inventory', 'management', 'taxes'].includes(tabName)) {
            this.state.pagination[tabName].page = 1;
            this.fetchActiveList();
        }
    }

    async refreshData() {
        this.state.isLoading = true;
        try {
            const extras = [this.fetchActiveList()];
            if (canMutate() && hasFinancialAccess()) {
                extras.push(this.loadSaleTaxes());
            }
            if (this.canManageProducts) {
                extras.push(this.loadVendors());
            }
            if (canMutate()) {
                extras.push(this.loadArchivedData());
            }
            await Promise.all(extras);
        } finally {
            this.state.isLoading = false;
        }
    }

    resetForms() {
        this.state.showWarehouseForm = false;
        this.state.showProductAddForm = false;
        this.state.showProductDetails = false;
        this.state.showTaxForm = false;
        this.state.currentProduct = null;
        this.state.editingTaxId = null;
    }

    // --- NEW: Tax Management Handlers ---
    openTaxForm(tax = null) {
        if (tax) {
            this.state.taxForm = { name: tax.name, amount: tax.amount, active: tax.active };
            this.state.editingTaxId = tax.id;
        } else {
            this.state.taxForm = { name: '', amount: 0.0, active: true };
            this.state.editingTaxId = null;
        }
        this.state.showTaxForm = true;
    }

    cancelTaxForm() {
        this.state.showTaxForm = false;
        this.state.editingTaxId = null;
    }

    async saveTax() {
        if (!this.state.taxForm.name) {
            this.notification.add("Tax name is required.", { type: "danger" });
            return;
        }

        const vals = {
            name: this.state.taxForm.name,
            amount: parseFloat(this.state.taxForm.amount || 0),
            active: this.state.taxForm.active,
        };

        try {
            if (this.state.editingTaxId) {
                await this.orm.write("account.tax", [this.state.editingTaxId], vals);
            } else {
                vals.type_tax_use = 'sale';
                vals.amount_type = 'percent';
                await this.orm.create("account.tax", [vals]);
            }
            this.cancelTaxForm();
            
            // FIXED: Use the new universal fetcher instead of the deleted bulk loader
            await this.fetchActiveList(); 
            await this.loadSaleTaxes(); 
        } catch (error) {
            this.notification.add("Failed to save tax: " + (error.data?.message || error.message), { type: "danger" });
        }
    }

    onImageChange(ev, target) {
        const file = ev.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const base64Data = e.target.result.split(',')[1];
            if (target === 'new') {
                this.state.productForm.image_1920 = base64Data;
            } else if (target === 'edit') {
                this.state.currentProduct.image_1920 = base64Data;
            }
        };
        reader.readAsDataURL(file);
    }

    async saveProduct() {
        // Prevent empty product creation
        if (!this.state.productForm.name || this.state.productForm.name.trim() === '') {
            this.notification.add("Product name is required.", { type: "danger" });
            return;
        }

        this.state.isLoading = true;
        try {
            const vals = {
                name: this.state.productForm.name,
                type: this.state.productForm.type,
                list_price: 0.0,
                standard_price: 0.0,
                invoice_policy: 'order',
                barcode: this.state.productForm.barcode,
                weight: parseFloat(this.state.productForm.weight || 0),
                volume: parseFloat(this.state.productForm.volume || 0),
                is_storable: !!this.state.productForm.track_inventory,
                shahtaj_sale_uom: this.state.productForm.shahtaj_sale_uom,
                shahtaj_kg_per_unit: parseFloat(this.state.productForm.shahtaj_kg_per_unit || 1),
                taxes_id: this.state.productForm.tax_id ? [[6, 0, [parseInt(this.state.productForm.tax_id, 10)]]] : [[5, 0, 0]],
            };

            if (this.state.productForm.vendor_id) {
                vals.shahtaj_vendor_id = parseInt(this.state.productForm.vendor_id, 10);
            }

            if (this.state.productForm.image_1920) {
                vals.image_1920 = this.state.productForm.image_1920;
            }

            const res = await this.orm.create("product.template", [vals], { context: { shahtaj_simple_product: true } });
            const createdId = Array.isArray(res) ? res[0] : res;
            const createdName = this.state.productForm.name;
            const createdVendorId = this.state.productForm.vendor_id;
            let createdVariantId = createdId;
            try {
                const variants = await this.orm.searchRead(
                    "product.product",
                    [["product_tmpl_id", "=", createdId]],
                    ["id"],
                    { limit: 1 }
                );
                if (variants.length) {
                    createdVariantId = variants[0].id;
                }
            } catch (_error) {
                createdVariantId = createdId;
            }

            await this.fetchActiveList();
            await this.refreshData();
            this.state.showProductAddForm = false;
            this.state.productForm = this.getEmptyProductForm();
            
            // Set newly created product info for quick PO creation prompt
            this.state.createdProductPrompt = {
                id: createdVariantId,
                templateId: createdId,
                name: createdName,
                vendor_id: createdVendorId,
            };
            this.notification.add(`Product "${createdName}" registered successfully.`, { type: "success" });
        } catch (error) {
            this.notification.add("Failed to register product: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }

    createPoForCreatedProduct() {
        const prod = this.state.createdProductPrompt;
        this.state.createdProductPrompt = null;
        if (!prod) return;
        const vendorId = prod.vendor_id ? parseInt(prod.vendor_id, 10) : null;
        window.dispatchEvent(new CustomEvent('shahtaj-open-create-po', {
            detail: {
                vendorId: vendorId || null,
                productId: prod.id,
                productTmplId: prod.templateId || prod.id,
                productName: prod.name,
            }
        }));
        window.dispatchEvent(new CustomEvent('shahtaj-dashboard-switch', {
            detail: { tab: 'financials', subTab: 'purchase_orders' }
        }));
    }

    viewProductDetails(product) {
        if (!this.canManageProducts) {
            return;
        }
        let currentTaxId = "";
        if (product.taxes_id && product.taxes_id.length > 0) {
            currentTaxId = product.taxes_id[0].toString();
        }
        const currentVendorId = this._vendorIdFromProduct(product);
        this._ensureVendorInDropdown(currentVendorId, product.shahtaj_vendor_name);

        this.state.currentProduct = {
            ...product,
            tax_id: currentTaxId,
            vendor_id: currentVendorId,
        };
        this.state.showProductDetails = true;
        this.state.showProductAddForm = false;
    }

    async updateProduct() {
        // Prevent clearing the name to an empty string during edit
        if (!this.state.currentProduct.name || this.state.currentProduct.name.trim() === '') {
            this.notification.add("Product name cannot be empty.", { type: "danger" });
            return;
        }

        this.state.isLoading = true;
        try {
            // Note: standard_price (Cost Price) is intentionally excluded from manual edits
            // as it is computed automatically via Weighted Average Cost (AVCO) from POs / receipts.
            const vals = {
                name: this.state.currentProduct.name,
                list_price: parseFloat(this.state.currentProduct.list_price || 0),
                barcode: this.state.currentProduct.barcode || false,
                weight: parseFloat(this.state.currentProduct.weight || 0),
                volume: parseFloat(this.state.currentProduct.volume || 0),
                invoice_policy: 'order',
                type: this.state.currentProduct.type,
                is_storable: !!this.state.currentProduct.is_storable,
                shahtaj_sale_uom: this.state.currentProduct.shahtaj_sale_uom,
                shahtaj_kg_per_unit: parseFloat(this.state.currentProduct.shahtaj_kg_per_unit || 1),
                taxes_id: this.state.currentProduct.tax_id ? [[6, 0, [parseInt(this.state.currentProduct.tax_id, 10)]]] : [[5, 0, 0]],
            };

            if (this.state.currentProduct.vendor_id && parseInt(this.state.currentProduct.vendor_id, 10)) {
                vals.shahtaj_vendor_id = parseInt(this.state.currentProduct.vendor_id, 10);
            } else {
                vals.shahtaj_vendor_id = false;
            }

            if (this.state.currentProduct.image_1920) {
                vals.image_1920 = this.state.currentProduct.image_1920;
            }

            await this.orm.write("product.template", [this.state.currentProduct.id], vals);
            await this.refreshData();
            this.state.showProductDetails = false;
            this.state.currentProduct = null;
            this.notification.add("Product updated successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to update product: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }
}

WarehouseInventory.template = "shahtaj_oil.WarehouseInventory";