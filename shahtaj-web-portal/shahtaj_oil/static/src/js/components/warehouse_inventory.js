/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class WarehouseInventory extends Component {
    setup() {
        this.orm = useService("orm");
        
        this.state = useState({
            activeSubTab: 'inventory',
            
            showWarehouseForm: false,
            showAdjustmentForm: false,
            showProductAddForm: false,
            showProductDetails: false,

            warehouseForm: { name: '', type: '', location: '', manager: '' },
            adjustmentForm: { product_id: '', qty: 0 },
            productForm: this.getEmptyProductForm(),
            currentProduct: null,
            saleTaxes: [],
            defaultTaxIds: [],

            warehouses: [
                { id: "WH-MAIN", name: "Central Hub - Lahore", type: "Main Warehouse", location: "Sundar Industrial Estate", manager: "Zafar Iqbal", status: "Active" },
                { id: "WH-SUB1", name: "North Hub - Mianwali", type: "Sub-Warehouse", location: "Main City Zone", manager: "Raza Ali", status: "Active" },
                { id: "WH-SUB2", name: "South Hub - Multan", type: "Sub-Warehouse", location: "Industrial Phase 2", manager: "Pending Allocation", status: "Maintenance" }
            ],

            inventory: []
        });

        onWillStart(async () => {
            await this.loadSaleTaxes();
            await this.loadInventory();
        });
    }

    get totalStockItems() {
        return this.state.inventory.reduce((sum, p) => sum + (p.qty_available || 0), 0);
    }

    getEmptyProductForm() {
        return {
            name: '', track_inventory: true, on_hand: 0,
            list_price: 0.0, standard_price: 0.0,
            invoice_policy: 'delivery', type: 'consu',
            shahtaj_sale_uom: 'piece', shahtaj_kg_per_unit: 1.0,
            tax_ids: [...this.state.defaultTaxIds],
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
        this.state.defaultTaxIds = this.state.saleTaxes
            .filter((tax) => tax.is_default)
            .map((tax) => tax.id);
        if (!this.state.productForm.tax_ids.length && this.state.defaultTaxIds.length) {
            this.state.productForm.tax_ids = [...this.state.defaultTaxIds];
        }
    }

    toggleProductTax(formTarget, taxId, checked) {
        const form = formTarget === 'edit' ? this.state.currentProduct : this.state.productForm;
        if (!form) {
            return;
        }
        const ids = new Set(form.tax_ids || []);
        if (checked) {
            ids.add(taxId);
        } else {
            ids.delete(taxId);
        }
        form.tax_ids = Array.from(ids);
    }

    isTaxSelected(formTarget, taxId) {
        const form = formTarget === 'edit' ? this.state.currentProduct : this.state.productForm;
        return (form?.tax_ids || []).includes(taxId);
    }

    getTaxLabel(taxIds) {
        if (!taxIds || !taxIds.length) {
            return 'No tax';
        }
        return taxIds
            .map((id) => this.state.saleTaxes.find((tax) => tax.id === id)?.label)
            .filter(Boolean)
            .join(', ');
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
            [['sale_ok', '=', true], ['default_code', '!=', 'SHAHTAJ-LEGACY']], 
            [
                "id", "name", "categ_id", "qty_available", "uom_name", "type",
                "list_price", "standard_price", "barcode", "weight", "volume",
                "invoice_policy", "image_1920", "shahtaj_qty_bookable", "virtual_available",
                "shahtaj_sale_uom", "shahtaj_kg_per_unit", "taxes_id",
            ]
        );
        this.state.inventory = products.map((product) => ({
            ...product,
            tax_ids: product.taxes_id || [],
            tax_label: this.getTaxLabel(product.taxes_id || []),
        }));
    }

    setSubTab(tabName) {
        this.state.activeSubTab = tabName;
        this.resetForms();
    }

    resetForms() {
        this.state.showWarehouseForm = false;
        this.state.showAdjustmentForm = false;
        this.state.showProductAddForm = false;
        this.state.showProductDetails = false;
        this.state.currentProduct = null;
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
            taxes_id: [[6, 0, (this.state.productForm.tax_ids || []).map((id) => parseInt(id, 10))]],
        };

        if (this.state.productForm.image_1920) {
            vals.image_1920 = this.state.productForm.image_1920;
        }

        const productIds = await this.orm.create("product.template", [vals], { context: { shahtaj_simple_product: true } });
        const newProductId = productIds[0];

        if (this.state.productForm.track_inventory && this.state.productForm.on_hand > 0) {
            await this.orm.call("product.template", "action_shahtaj_set_on_hand_qty", [newProductId, parseFloat(this.state.productForm.on_hand)]);
        }

        await this.loadInventory();
        this.state.showProductAddForm = false;
        this.state.productForm = this.getEmptyProductForm();
    }

    get selectedProductStock() {
        if (!this.state.adjustmentForm.product_id) return 0;
        const prod = this.state.inventory.find(p => p.id == this.state.adjustmentForm.product_id);
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
        this.state.currentProduct = {
            ...product,
            tax_ids: [...(product.tax_ids || product.taxes_id || [])],
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
            taxes_id: [[6, 0, (this.state.currentProduct.tax_ids || []).map((id) => parseInt(id, 10))]],
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
