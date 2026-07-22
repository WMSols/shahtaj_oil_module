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
            taxesList: [],

            // --- Search & Filter States ---
            productSearchQuery: '',
            productSortFilter: 'default', // 'price_asc', 'price_desc', 'qty_asc', 'qty_desc'

            stockSearchQuery: '',
            stockFilterStatus: 'all', // 'in_stock', 'out_of_stock'

            warehouseForm: { name: '', type: '', location: '', manager: '' },
            adjustmentForm: { product_id: '', qty: 0 },
            
            productForm: this.getEmptyProductForm(),
            currentProduct: null,
            saleTaxes: [],
            defaultTaxId: "", 
            confirmModal: { isOpen: false, title: '', message: '', onConfirm: null },
            isLoading: false,

            warehouses: [
                { id: "WH-MAIN", name: "Central Hub - Lahore", type: "Main Warehouse", location: "Sundar Industrial Estate", manager: "Zafar Iqbal", status: "Active" },
                { id: "WH-SUB1", name: "North Hub - Mianwali", type: "Sub-Warehouse", location: "Main City Zone", manager: "Raza Ali", status: "Active" },
                { id: "WH-SUB2", name: "South Hub - Multan", type: "Sub-Warehouse", location: "Industrial Phase 2", manager: "Pending Allocation", status: "Maintenance" }
            ],

            inventory: []
        });
        onWillUpdateProps((nextProps) => {
            if (nextProps.requestedSubTab && nextProps.requestedSubTab !== this.state.activeSubTab) {
                this.setSubTab(nextProps.requestedSubTab);
            }
        });

        onWillStart(async () => {
            this.state.activeSubTab = this._normalizeSubTab(this.state.activeSubTab);
            if (!hasFinancialAccess()) {
                await this.loadInventory();
            } else {
                await this.loadSaleTaxes();
                await this.loadInventory();
                await this.loadTaxesList();
            }
        });
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
    // NEW Refresh Method
    async refreshData() {
        this.state.isLoading = true;
        try {
            await Promise.all([
                this.loadInventory(),
                this.loadTaxesList()
            ]);
        } finally {
            this.state.isLoading = false;
        }
    }
   // --- Dynamic Search, Filter, and Sort Getters ---
    get displayProducts() {
        let filtered = this.state.inventory.filter(product =>
            product.active && product.name.toLowerCase().includes(this.state.productSearchQuery.toLowerCase())
        );

        if (this.state.productSortFilter === 'price_asc') {
            filtered.sort((a, b) => (a.list_price || 0) - (b.list_price || 0));
        } else if (this.state.productSortFilter === 'price_desc') {
            filtered.sort((a, b) => (b.list_price || 0) - (a.list_price || 0));
        } else if (this.state.productSortFilter === 'qty_asc') {
            filtered.sort((a, b) => (a.qty_available || 0) - (b.qty_available || 0));
        } else if (this.state.productSortFilter === 'qty_desc') {
            filtered.sort((a, b) => (b.qty_available || 0) - (a.qty_available || 0));
        }

        return filtered;
    }

    get displayStock() {
        let filtered = this.state.inventory.filter(product =>
            product.active && product.name.toLowerCase().includes(this.state.stockSearchQuery.toLowerCase())
        );

        if (this.state.stockFilterStatus === 'in_stock') {
            filtered = filtered.filter(p => p.qty_available > 0);
        } else if (this.state.stockFilterStatus === 'out_of_stock') {
            filtered = filtered.filter(p => p.qty_available <= 0);
        }

        return filtered;
    }

    get activeTaxes() { return this.state.taxesList.filter(t => t.active); }
    get archivedTaxes() { return this.state.taxesList.filter(t => !t.active); }
    get archivedProducts() { return this.state.inventory.filter(p => !p.active); }

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
            if (model === 'product.template') {
                await this.loadInventory();
            } else if (model === 'account.tax') {
                await this.loadTaxesList();
                await this.loadSaleTaxes();
            }
        } catch (error) {
            alert("Failed to update archive status: " + (error.data?.message || error.message));
        }
    }
    // --- Data Fetching Logic ---
    get totalStockItems() {
        return this.state.inventory.reduce((sum, p) => sum + (p.qty_available || 0), 0);
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

    async loadTaxesList() {
        const taxes = await this.orm.searchRead(
            "account.tax",
            [["type_tax_use", "=", "sale"], ["active", "in", [true, false]]],
            ["id", "name", "amount", "active"]
        );
        this.state.taxesList = taxes;
    }

    onSaleUomChange(formTarget) {
        const defaults = { kg: 1.0, ton: 1000.0, litre: 1.0, piece: 1.0 };
        const form = formTarget === 'edit' ? this.state.currentProduct : this.state.productForm;
        if (form) {
            form.shahtaj_kg_per_unit = defaults[form.shahtaj_sale_uom] || 1.0;
        }
    }

    async loadInventory() {
        const products = await this.orm.searchRead(
            "product.template",
            [
                ['sale_ok', '=', true], 
                ['default_code', '!=', 'SHAHTAJ-LEGACY'],
                ['active', 'in', [true, false]] // Fetch both active and archived
            ], 
            [
                "id", "name", "categ_id", "qty_available", "uom_name", "type",
                "list_price", "standard_price", "barcode", "weight", "volume",
                "invoice_policy", "image_1920", "shahtaj_qty_bookable", "virtual_available",
                "shahtaj_sale_uom", "shahtaj_kg_per_unit", "taxes_id", "active" // Add 'active'
            ]
        );
        this.state.inventory = products.map((product) => ({
            ...product,
            tax_label: this.getTaxLabel(product.taxes_id || []),
        }));
    }

   setSubTab(tabName) {
        tabName = this._normalizeSubTab(tabName);
        // Save the current tab if we are navigating to the archive
        if (tabName === 'archive' && this.state.activeSubTab !== 'archive') {
            this.state.previousSubTab = this.state.activeSubTab;
        }
        
        this.state.activeSubTab = tabName;
        this.resetForms();
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
            alert("Tax name is required.");
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
            await this.loadTaxesList(); // Refresh the grid
            await this.loadSaleTaxes(); // Refresh the product creation dropdown
        } catch (error) {
            alert("Failed to save tax: " + (error.data?.message || error.message));
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

        await this.loadInventory();
        this.state.showProductAddForm = false;
        this.state.productForm = this.getEmptyProductForm();
    }

    get activeInventory() {
        return this.state.inventory.filter((product) => product.active);
    }

    get selectedProductStock() {
        if (!this.state.adjustmentForm.product_id) return 0;
        const prod = this.activeInventory.find(p => p.id == this.state.adjustmentForm.product_id);
        return prod ? prod.qty_available : 0;
    }

    async saveAdjustment() {
        const pid = parseInt(this.state.adjustmentForm.product_id);
        const qty = parseFloat(this.state.adjustmentForm.qty);
        
        if (pid && qty > 0) {
            await this.orm.call("product.template", "action_shahtaj_add_on_hand_qty", [pid, qty]);
            await this.loadInventory();
        }
        
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
        await this.loadInventory();
        this.state.showProductDetails = false;
        this.state.currentProduct = null;
    }
}

WarehouseInventory.template = "shahtaj_oil.WarehouseInventory";