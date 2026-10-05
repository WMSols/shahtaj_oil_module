/** @odoo-module **/

let lookups = null;
let lookupsPromise = null;
let stats = null;
let statsPromise = null;

function mapProducts(prodData) {
    return (prodData || []).map((p) => {
        let vendorId = false;
        if (p.shahtaj_vendor_id) {
            vendorId = Array.isArray(p.shahtaj_vendor_id) ? p.shahtaj_vendor_id[0] : p.shahtaj_vendor_id;
        }
        return {
            id: p.id,
            name: p.display_name || p.name,
            uom_po_id: p.uom_id ? p.uom_id[0] : false,
            standard_price: p.standard_price || 0,
            supplier_tax_id: (p.supplier_taxes_id && p.supplier_taxes_id[0]) || '',
            product_tmpl_id: p.product_tmpl_id ? p.product_tmpl_id[0] : false,
            vendor_id: vendorId,
        };
    });
}

async function fetchLookups(orm) {
    const productDomain = ["|", ["sale_ok", "=", true], ["purchase_ok", "=", true], ["active", "=", true], ["product_tmpl_id.active", "=", true]];
    const vendorDomain = [["supplier_rank", ">", 0], ["is_shahtaj_shop", "=", false]];
    const [taxesData, purchaseTaxesData, prodData, journalsData, vendorData, archivedVendorsTotal] = await Promise.all([
        orm.searchRead("account.tax", [["type_tax_use", "=", "sale"], ["active", "=", true]], ["id", "name", "amount"]),
        orm.searchRead("account.tax", [["type_tax_use", "=", "purchase"], ["active", "=", true]], ["id", "name", "amount"]),
        orm.searchRead("product.product", productDomain, ["id", "name", "display_name", "uom_id", "standard_price", "supplier_taxes_id", "product_tmpl_id", "shahtaj_vendor_id"]),
        orm.searchRead("account.journal", [["type", "in", ["bank", "cash"]]], ["name", "type"]),
        orm.searchRead("res.partner", vendorDomain, ["id", "name", "phone", "email", "street", "city", "active"]),
        orm.searchCount("res.partner", [["supplier_rank", ">", 0], ["is_shahtaj_shop", "=", false], ["active", "=", false]], { context: { active_test: false } }),
    ]);
    const products = mapProducts(prodData);
    return {
        availableTaxes: taxesData || [],
        availablePurchaseTaxes: purchaseTaxesData || [],
        allProducts: prodData || [],
        archivedVendorsCount: archivedVendorsTotal || 0,
        products,
        journals: journalsData || [],
        vendors: vendorData || [],
    };
}

async function fetchStats(orm) {
    const [totalOrders, toInvoice, openInvoices, creditNotes, approvedShops] = await Promise.all([
        orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false]]),
        orm.searchCount("sale.order", [["shahtaj_visit_id", "!=", false], ["invoice_status", "=", "to invoice"]]),
        orm.searchCount("account.move", [["move_type", "in", ["out_invoice"]], ["partner_id.is_shahtaj_shop", "=", true], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]]),
        orm.searchCount("account.move", [["move_type", "=", "out_refund"], ["partner_id.is_shahtaj_shop", "=", true]]),
        orm.searchCount("res.partner", [["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]]),
    ]);
    return { totalOrders, toInvoice, openInvoices, creditNotes, approvedShops };
}

export async function getFinancialLookups(orm, { force = false } = {}) {
    if (!force && lookups) {
        return lookups;
    }
    if (!force && lookupsPromise) {
        return lookupsPromise;
    }
    lookupsPromise = fetchLookups(orm).then((data) => {
        lookups = data;
        lookupsPromise = null;
        return data;
    }).catch((error) => {
        lookupsPromise = null;
        throw error;
    });
    return lookupsPromise;
}

export async function getFinancialStats(orm, { force = false } = {}) {
    if (!force && stats) {
        return stats;
    }
    if (!force && statsPromise) {
        return statsPromise;
    }
    statsPromise = fetchStats(orm).then((data) => {
        stats = data;
        statsPromise = null;
        return data;
    }).catch((error) => {
        statsPromise = null;
        throw error;
    });
    return statsPromise;
}

export function applyLookupsToState(state, data) {
    if (!data || !state) {
        return;
    }
    state.availableTaxes = data.availableTaxes || [];
    state.availablePurchaseTaxes = data.availablePurchaseTaxes || [];
    state.allProducts = data.allProducts || [];
    state.archivedVendorsCount = data.archivedVendorsCount || 0;
    state.products = data.products || [];
    state.journals = data.journals || [];
    state.poLookups = {
        vendors: data.vendors || [],
        products: data.products || [],
    };
}

export function invalidateFinancialLookups() {
    lookups = null;
    lookupsPromise = null;
}

export function invalidateFinancialStats() {
    stats = null;
    statsPromise = null;
}

export function invalidateFinancialCache() {
    invalidateFinancialLookups();
    invalidateFinancialStats();
}

export function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function requestFinancialTabSwitch(tabName, subTabName) {
    window.dispatchEvent(new CustomEvent('shahtaj-dashboard-switch', {
        detail: { tab: tabName, subTab: subTabName },
    }));
}

export const EMPTY_STATS = { totalOrders: 0, toInvoice: 0, openInvoices: 0, creditNotes: 0, approvedShops: 0 };

export const TOP_LEVEL_TABS = ['credit', 'pnl', 'money', 'cash', 'tax_ledger', 'expenses', 'po_management'];
export const PO_CHILD_TABS = ['purchase_orders', 'receipts', 'vendor_bills', 'vendors'];
export const CREDIT_CHILD_TABS = ['balances'];
export const INVOICE_CHILD_TABS = ['all_orders', 'orders', 'customer_invoices', 'payments', 'credit_notes'];

export function resolveFinancialTab(requested) {
    const target = requested || 'invoices';
    if (target === 'balances') {
        return { activeSubTab: 'credit', creditSubView: 'balances', invoiceSubTab: 'all_orders', poSubTab: 'purchase_orders' };
    }
    if (TOP_LEVEL_TABS.includes(target)) {
        return {
            activeSubTab: target,
            creditSubView: target === 'credit' ? 'risk' : 'risk',
            invoiceSubTab: 'all_orders',
            poSubTab: 'purchase_orders',
        };
    }
    if (PO_CHILD_TABS.includes(target)) {
        return { activeSubTab: 'po_management', poSubTab: target, invoiceSubTab: 'all_orders', creditSubView: 'risk' };
    }
    if (target === 'invoices') {
        return { activeSubTab: 'invoices', invoiceSubTab: 'all_orders', poSubTab: 'purchase_orders', creditSubView: 'risk' };
    }
    if (INVOICE_CHILD_TABS.includes(target)) {
        return { activeSubTab: 'invoices', invoiceSubTab: target, poSubTab: 'purchase_orders', creditSubView: 'risk' };
    }
    return { activeSubTab: 'invoices', invoiceSubTab: 'all_orders', poSubTab: 'purchase_orders', creditSubView: 'risk' };
}
