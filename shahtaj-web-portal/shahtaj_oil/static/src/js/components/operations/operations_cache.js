/** @odoo-module **/

import { hasFinancialAccess } from "../../shahtaj_access";

let lookups = null;
let lookupsPromise = null;
let catalogs = null;
let catalogsPromise = null;
let taxCatalog = null;
let taxCatalogPromise = null;

async function fetchLookups(orm) {
    let bookers = [];
    let deliveryMen = [];
    try {
        bookers = await orm.searchRead(
            "res.users",
            [["shahtaj_is_order_booker", "=", true]],
            ["id", "name"],
        );
    } catch (error) {
        bookers = [];
    }
    try {
        deliveryMen = await orm.searchRead(
            "res.users",
            [["shahtaj_is_delivery_man", "=", true]],
            ["id", "name"],
        );
    } catch (error) {
        deliveryMen = [];
    }
    const byId = new Map();
    for (const user of [...bookers, ...deliveryMen]) {
        byId.set(user.id, user);
    }
    let lookupTargetTypes = [];
    try {
        const types = await orm.call("shahtaj.visit.target", "read_group", [[], ["target_type"], ["target_type"]]);
        lookupTargetTypes = types.map((t) => ({
            value: t.target_type,
            label: t.target_type ? t.target_type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()) : "Unknown",
        })).filter((t) => t.value);
    } catch (error) {
        lookupTargetTypes = [];
    }
    return {
        lookupBookers: bookers.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")),
        lookupDeliveryMen: deliveryMen.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")),
        lookupFieldUsers: [...byId.values()].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
        lookupTargetTypes,
    };
}

async function fetchCatalogs(orm) {
    const [shops, products, taxes] = await Promise.all([
        orm.searchRead(
            "res.partner",
            [["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"], ["active", "=", true]],
            ["id", "name", "phone", "email"],
        ),
        orm.searchRead(
            "product.product",
            [["sale_ok", "=", true], ["active", "=", true], ["product_tmpl_id.active", "=", true], ["default_code", "!=", "SHAHTAJ-LEGACY"]],
            ["id", "name", "display_name", "list_price", "taxes_id", "uom_id", "qty_available"],
        ),
        hasFinancialAccess()
            ? orm.searchRead("account.tax", [["type_tax_use", "=", "sale"], ["active", "=", true]], ["id", "name", "amount"])
            : Promise.resolve([]),
    ]);
    return {
        lookupShops: shops || [],
        saleProducts: (products || []).map((p) => ({
            id: p.id,
            name: p.display_name || p.name,
            list_price: p.list_price || 0,
            tax_id: (p.taxes_id && p.taxes_id[0]) || "",
            uom_id: p.uom_id ? p.uom_id[0] : false,
            uom_name: p.uom_id ? p.uom_id[1] : "",
            qty_available: p.qty_available || 0,
        })),
        saleTaxes: taxes || [],
    };
}

async function fetchTaxCatalog(orm) {
    const [taxes, prods] = await Promise.all([
        orm.searchRead(
            "account.tax",
            [["type_tax_use", "=", "sale"], ["active", "=", true]],
            ["id", "name", "amount"],
        ),
        orm.searchRead("product.template", [
            ["sale_ok", "=", true],
            ["active", "=", true],
            ["default_code", "!=", "SHAHTAJ-LEGACY"],
        ], ["id", "name"]),
    ]);
    return { saleTaxes: taxes, allProducts: prods };
}

export async function getOperationsLookups(orm, { force = false } = {}) {
    if (force) {
        lookups = null;
        lookupsPromise = null;
    }
    if (lookups) {
        return lookups;
    }
    if (!lookupsPromise) {
        lookupsPromise = fetchLookups(orm).then((data) => {
            lookups = data;
            return data;
        });
    }
    return lookupsPromise;
}

export async function getOperationsCatalogs(orm, { force = false } = {}) {
    if (force) {
        catalogs = null;
        catalogsPromise = null;
    }
    if (catalogs) {
        return catalogs;
    }
    if (!catalogsPromise) {
        catalogsPromise = fetchCatalogs(orm).then((data) => {
            catalogs = data;
            return data;
        });
    }
    return catalogsPromise;
}

export async function getOperationsTaxCatalog(orm, { force = false } = {}) {
    if (force) {
        taxCatalog = null;
        taxCatalogPromise = null;
    }
    if (taxCatalog) {
        return taxCatalog;
    }
    if (!taxCatalogPromise) {
        taxCatalogPromise = fetchTaxCatalog(orm).then((data) => {
            taxCatalog = data;
            return data;
        });
    }
    return taxCatalogPromise;
}

export function applyOperationsLookupsToState(state, data) {
    state.lookupBookers = data.lookupBookers || [];
    state.lookupDeliveryMen = data.lookupDeliveryMen || [];
    state.lookupFieldUsers = data.lookupFieldUsers || [];
    state.lookupTargetTypes = data.lookupTargetTypes || [];
}

export function applyOperationsCatalogsToState(state, data) {
    state.lookupShops = data.lookupShops || [];
    state.saleProducts = data.saleProducts || [];
    if (data.saleTaxes && data.saleTaxes.length) {
        state.saleTaxes = data.saleTaxes;
    }
}

export function invalidateOperationsCache() {
    lookups = null;
    lookupsPromise = null;
    catalogs = null;
    catalogsPromise = null;
    taxCatalog = null;
    taxCatalogPromise = null;
}

export function resolveOperationsTab(requested, deliveriesSubTab) {
    if (requested === "all_deliveries") {
        return { activeSubTab: "deliveries", deliveriesSubTab: "jobs" };
    }
    if (requested === "deliveries") {
        return {
            activeSubTab: "deliveries",
            deliveriesSubTab: deliveriesSubTab === "manual" ? "dispatch" : (deliveriesSubTab || "dispatch"),
        };
    }
    const allowed = ["checkins", "orders", "performance"];
    if (allowed.includes(requested)) {
        return { activeSubTab: requested, deliveriesSubTab: deliveriesSubTab || "dispatch" };
    }
    return { activeSubTab: requested || "orders", deliveriesSubTab: deliveriesSubTab || "dispatch" };
}
