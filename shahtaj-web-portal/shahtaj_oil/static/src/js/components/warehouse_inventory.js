/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ConfirmModal } from "./confirm_modal";
import { hasFinancialAccess } from "../shahtaj_access";

export class WarehouseInventory extends Component {
    static props = {
        requestedSubTab: { type: String, optional: true },
    };
    static components = { ConfirmModal };
    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        // Universal items per page shared across Inventory, Stock, and Taxes
        const ITEMS_PER_PAGE = 10;
        this.state = useState({
            activeSubTab: this._normalizeSubTab(this.props.requestedSubTab || 'inventory'),
            previousSubTab: 'inventory',
            
            showWarehouseForm: false,
            showAdjustmentForm: false,
            showProductAddForm: false,
            showProductDetails: false,
            
            // --- NEW: Tax Management States ---
            showTaxForm: false,
            editingTaxId: null,
            taxForm: { name: '', amount: 0.0, active: true },
            warehouseForm: { name: '', type: '', location: '', manager: '' },
            adjustmentForm: { product_id: '', qty: 0 },
            
            productForm: this.getEmptyProductForm(),
            currentProduct: null,
            saleTaxes: [],
            defaultTaxId: "", 
            confirmModal: { isOpen: false, title: '', message: '', onConfirm: null },
            isLoading: false,
            // --- NEW: Backend Pagination & Loading ---
            itemsPerPage: ITEMS_PER_PAGE,
            isLoadingList: false,
            searchTimeout: null,
            tableInventory: [],
            tableStock: [],
            tableTaxes: [],
            allActiveProducts: [], // Used strictly for the "Update Stock" dropdown
            archivedProductsList: [],
            archivedTaxesList: [],
            pagination: {
                inventory: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                management: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                taxes: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            filters: {
                inventory: { search: '', sort: 'default' },
                management: { search: '', status: 'all' },
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
            this.state.activeSubTab = this._normalizeSubTab(this.state.activeSubTab);
            if (hasFinancialAccess()) {
                await this.loadSaleTaxes();
            }
            await this.loadDropdownData();
            await this.loadArchivedData();
            await this.fetchActiveList();
        });
        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab && nextProps.requestedSubTab !== this.state.activeSubTab) {
                this.setSubTab(nextProps.requestedSubTab);
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
    async loadDropdownData() {
        // Lightweight lookup specifically for the "Add Stock" modal dropdown
        this.state.allActiveProducts = await this.orm.searchRead(
            "product.template", 
            [['sale_ok', '=', true], ['active', '=', true], ['default_code', '!=', 'SHAHTAJ-LEGACY']], 
            ["id", "name", "qty_available"]
        );
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
    get activeInventory() { return this.state.allActiveProducts; }

    async fetchActiveList() {
        const tab = this.state.activeSubTab;
        if (!['inventory', 'management', 'taxes'].includes(tab)) return;

        this.state.isLoadingList = true;
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
                fields = ["id", "name", "categ_id", "qty_available", "uom_name", "type", "list_price", "standard_price", "barcode", "weight", "volume", "invoice_policy", "image_1920", "shahtaj_qty_bookable", "virtual_available", "shahtaj_sale_uom", "shahtaj_kg_per_unit", "taxes_id", "active"];
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

            this.state.pagination[tab].total = total;
            
            if (tab === 'inventory' || tab === 'management') {
                this.state[targetState] = records.map(p => ({ ...p, tax_label: this.getTaxLabel(p.taxes_id || []) }));
            } else {
                this.state[targetState] = records;
            }
        } catch (error) {
            this.notification.add("Failed to fetch list: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoadingList = false;
        }
    }
    
    get hasFinancialAccess() {
        return hasFinancialAccess();
    }

    _normalizeSubTab(tabName) {
        if (!hasFinancialAccess() && ['inventory', 'taxes', 'archive'].includes(tabName)) {
            return 'management';
        }
        return tabName || 'management';
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
                this.loadDropdownData(),
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
            name: '', track_inventory: true, on_hand: 0,
            list_price: 0.0, standard_price: 0.0,
            invoice_policy: 'delivery', type: 'consu',
            shahtaj_sale_uom: 'piece', shahtaj_kg_per_unit: 1.0,
            // Start with no tax — user must opt in (do not auto-apply company default).
            tax_id: "",
            barcode: '', weight: 0.0, volume: 0.0,
            income_account: 'static_inc', expense_account: 'static_exp',
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
            if (hasFinancialAccess()) await this.loadSaleTaxes();
            await Promise.all([
                this.loadDropdownData(),
                this.loadArchivedData(),
                this.fetchActiveList()
            ]);
        } finally {
            this.state.isLoading = false;
        }
    }

    resetForms() {
        this.state.showWarehouseForm = false;
        this.state.showAdjustmentForm = false;
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
            const initialOnHand = parseFloat(this.state.productForm.on_hand || 0);
            const vals = {
                name: this.state.productForm.name,
                type: this.state.productForm.type,
                list_price: parseFloat(this.state.productForm.list_price || 0),
                standard_price: parseFloat(this.state.productForm.standard_price || 0),
                invoice_policy: this.state.productForm.invoice_policy,
                barcode: this.state.productForm.barcode,
                weight: parseFloat(this.state.productForm.weight || 0),
                volume: parseFloat(this.state.productForm.volume || 0),
                is_storable: this.state.productForm.track_inventory,
                shahtaj_sale_uom: this.state.productForm.shahtaj_sale_uom,
                shahtaj_kg_per_unit: parseFloat(this.state.productForm.shahtaj_kg_per_unit || 1),
                taxes_id: this.state.productForm.tax_id ? [[6, 0, [parseInt(this.state.productForm.tax_id, 10)]]] : [[5, 0, 0]],
            };

            if (this.state.productForm.image_1920) {
                vals.image_1920 = this.state.productForm.image_1920;
            }

            const createContext = { shahtaj_simple_product: true };
            if (this.state.productForm.track_inventory && initialOnHand > 0) {
                createContext.shahtaj_initial_on_hand = initialOnHand;
            }

            await this.orm.create("product.template", [vals], { context: createContext });
            // UPDATED: Use the new fetchers instead of loadInventory()
            await this.loadDropdownData();
            await this.fetchActiveList();
            await this.refreshData();
            this.state.showProductAddForm = false;
            this.state.productForm = this.getEmptyProductForm();
            this.notification.add("Product created successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to create product: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }


    get selectedProductStock() {
        if (!this.state.adjustmentForm.product_id) return 0;
        // FIXED: Point this to the new lightweight dropdown array
        const prod = this.state.allActiveProducts.find(p => p.id == this.state.adjustmentForm.product_id);
        return prod ? prod.qty_available : 0;
    }
    // Stock Update Logic
    async saveAdjustment() {
        const pid = parseInt(this.state.adjustmentForm.product_id);
        const qty = parseFloat(this.state.adjustmentForm.qty);
        
        if (pid && qty > 0) {
            await this.orm.call("product.template", "action_shahtaj_add_on_hand_qty", [[pid], qty]);
            // ADDED: Refresh dropdown and table
            await this.loadDropdownData();
            await this.fetchActiveList();
        }
        this.notification.add(`Successfully added ${qty} units to the product stock.`, { type: "success" });
        
        this.state.showAdjustmentForm = false;
        this.state.adjustmentForm = { product_id: '', qty: 0 };
    }

    viewProductDetails(product) {
        let currentTaxId = "";
        if (product.taxes_id && product.taxes_id.length > 0) {
            currentTaxId = product.taxes_id[0].toString();
        }
        
        this.state.currentProduct = {
            ...product,
            tax_id: currentTaxId,
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
            const vals = {
                name: this.state.currentProduct.name,
                list_price: parseFloat(this.state.currentProduct.list_price || 0),
                standard_price: parseFloat(this.state.currentProduct.standard_price || 0),
                barcode: this.state.currentProduct.barcode,
                weight: parseFloat(this.state.currentProduct.weight || 0),
                volume: parseFloat(this.state.currentProduct.volume || 0),
                invoice_policy: this.state.currentProduct.invoice_policy,
                type: this.state.currentProduct.type,
                shahtaj_sale_uom: this.state.currentProduct.shahtaj_sale_uom,
                shahtaj_kg_per_unit: parseFloat(this.state.currentProduct.shahtaj_kg_per_unit || 1),
                taxes_id: this.state.currentProduct.tax_id ? [[6, 0, [parseInt(this.state.currentProduct.tax_id, 10)]]] : [[5, 0, 0]],
            };

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