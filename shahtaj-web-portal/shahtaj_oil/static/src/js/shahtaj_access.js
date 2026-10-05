/** @odoo-module **/

import { reactive } from "@odoo/owl";
import { session } from "@web/session";
import { user } from "@web/core/user";

/**
 * True when this user may see prices, amounts, and other financial fields
 * on screens they can already open.
 * KPO and Warehouse get this on their allowed tabs. Distributor still follows
 * the financial-access session flag.
 */
export function hasFinancialAccess() {
    const role = portalAccessState.role;
    if (role === "kpo" || role === "warehouse") {
        return true;
    }
    return Boolean(session.shahtaj_financial_access);
}

/**
 * Portal role map. Edit this object to change what a role can open.
 *
 * allowAll: every screen, then apply deny and the financial-access gate.
 * allow: only these screens. A shorter prefix allows every child under it.
 *   ["operations", "deliveries", "recovery"] is one DM Operations pill.
 *   ["financials", "invoices"] is the whole Invoice Management workspace.
 * deny: hide these screens from an otherwise full portal.
 * cards: overview cards to show. Omit to show every card except hideCards.
 * hideCards: overview cards to remove (the cash "Financials" card is "financials").
 * canMutate: false means view and print only.
 * KPO and Warehouse can mutate every tab they are allowed to open.
 * showPrices: false hides product and stock price columns.
 */
const ROLE_ACCESS = {
    distributor: {
        allowAll: true,
        canMutate: true,
    },
    manager: {
        allowAll: true,
        deny: [
            ["financials", "money"],
            ["financials", "cash"],
        ],
        hideCards: ["financials"],
        canMutate: true,
        showPrices: true,
    },
    kpo: {
        allow: [
            ["operations", "orders"],
            ["operations", "deliveries", "recovery"],
            ["operations", "deliveries", "settlements"],
            ["financials", "invoices"],
            ["financials", "credit"],
            ["financials", "po_management"],
            ["warehouse", "inventory"],
            ["warehouse", "archive"],
        ],
        cards: ["orders", "invoices"],
        canMutate: true,
        canSettleWallet: true,
        canManageProducts: true,
        canResetOrderToDraft: false,
        showPrices: true,
    },
    warehouse: {
        allow: [
            ["staff", "delivery_man"],
            ["operations", "deliveries", "dispatch"],
            ["operations", "deliveries", "jobs"],
            ["operations", "deliveries", "sessions"],
            ["warehouse", "inventory"],
            ["warehouse", "management"],
        ],
        cards: ["deliveryMen", "deliveryJobs", "warehouse"],
        canMutate: true,
        canDispatchOrders: true,
        canManageProducts: false,
        canResetOrderToDraft: false,
        canManageStaff: false,
        canEditDispatchDetails: false,
        showPrices: false,
    },
};

const INVOICE_SUBS = new Set([
    "invoices",
    "all_orders",
    "orders",
    "customer_invoices",
    "payments",
    "credit_notes",
]);
const PO_SUBS = new Set([
    "po_management",
    "purchase_orders",
    "receipts",
    "vendor_bills",
    "vendors",
]);
const CREDIT_SUBS = new Set(["credit", "balances"]);
const FINANCIAL_TABS = new Set(["financials", "transactions", "accounting"]);
const FINANCIAL_WAREHOUSE_SUBS = new Set(["inventory", "taxes", "archive"]);

const MENU_SUBS = {
    territory: ["areas", "routes", "shops"],
    warehouse: ["inventory", "management", "taxes"],
    operations: ["orders", "deliveries", "checkins", "performance", "dm_performance"],
    financials: ["invoices", "po_management", "credit", "money", "cash", "tax_ledger", "expenses", "pnl"],
    schedules: ["schedules", "targets"],
    accounting: ["journals", "accounts", "audit"],
    reports: ["field_reports"],
};

const DELIVERY_INNERS = ["dispatch", "jobs", "sessions", "recovery", "settlements"];

const DEFAULT_CARDS = [
    "territory",
    "checkins",
    "orders",
    "dispatch",
    "deliveryJobs",
    "staffBookers",
    "deliveryMen",
    "warehouse",
    "schedules",
    "financials",
    "invoices",
];

const PORTAL_TITLES = {
    distributor: "Distributor Portal",
    manager: "Manager Portal",
    kpo: "KPO Portal",
    warehouse: "Warehouse Incharge Portal",
};

export const portalAccessState = reactive({
    ready: false,
    role: "distributor",
});

export function portalTitle() {
    return PORTAL_TITLES[portalAccessState.role] || PORTAL_TITLES.distributor;
}

let loadPromise = null;

export function loadPortalAccess() {
    if (!loadPromise) {
        loadPromise = (async () => {
            const [isManager, isKpo, isWarehouse] = await Promise.all([
                user.hasGroup("shahtaj_oil.group_shahtaj_manager"),
                user.hasGroup("shahtaj_oil.group_shahtaj_kpo"),
                user.hasGroup("shahtaj_oil.group_shahtaj_warehouse"),
            ]);
            if (isKpo) {
                portalAccessState.role = "kpo";
            } else if (isWarehouse) {
                portalAccessState.role = "warehouse";
            } else if (isManager) {
                portalAccessState.role = "manager";
            } else {
                portalAccessState.role = "distributor";
            }
            portalAccessState.ready = true;
            return portalAccessState.role;
        })();
    }
    return loadPromise;
}

function currentConfig() {
    return ROLE_ACCESS[portalAccessState.role] || ROLE_ACCESS.distributor;
}

function canonical(tab, subTab = "", inner = "") {
    let sub = subTab || "";
    let inn = inner || "";
    if (tab === "financials" && INVOICE_SUBS.has(sub)) {
        sub = "invoices";
    } else if (tab === "financials" && PO_SUBS.has(sub)) {
        sub = "po_management";
    } else if (tab === "financials" && CREDIT_SUBS.has(sub)) {
        sub = "credit";
    }
    if (tab === "operations" && sub === "all_deliveries") {
        sub = "deliveries";
        inn = inn || "jobs";
    }
    return { tab: tab || "", sub, inner: inn };
}

function matchesEntry(entry, screen) {
    if (!entry || entry[0] !== screen.tab) {
        return false;
    }
    if (entry.length === 1) {
        return true;
    }
    if (!screen.sub) {
        return true;
    }
    if (entry[1] !== screen.sub) {
        return false;
    }
    if (entry.length === 2) {
        return true;
    }
    if (!screen.inner) {
        return true;
    }
    return entry[2] === screen.inner;
}

function isListed(entries, screen) {
    return (entries || []).some((entry) => matchesEntry(entry, screen));
}

function isDenied(config, screen) {
    return (config.deny || []).some((entry) => {
        if (entry[0] !== screen.tab) {
            return false;
        }
        if (entry.length === 1) {
            return true;
        }
        if (!screen.sub || entry[1] !== screen.sub) {
            return false;
        }
        if (entry.length === 2) {
            return true;
        }
        return Boolean(screen.inner) && entry[2] === screen.inner;
    });
}

function needsFinancial(screen) {
    if (FINANCIAL_TABS.has(screen.tab)) {
        return true;
    }
    return screen.tab === "warehouse" && FINANCIAL_WAREHOUSE_SUBS.has(screen.sub);
}

function explicitlyAllowed(config, screen) {
    return !config.allowAll && isListed(config.allow, screen);
}

/**
 * Whether the current role may open this portal screen.
 * Omit subTab to ask if any child of the menu is visible.
 */
export function canSee(tab, subTab = "", inner = "") {
    const config = currentConfig();
    const screen = canonical(tab, subTab, inner);
    if (!screen.tab || screen.tab === "overview") {
        return true;
    }
    if (!config.allowAll) {
        if (!screen.sub) {
            if (!(config.allow || []).some((entry) => entry[0] === screen.tab)) {
                return false;
            }
        } else if (!isListed(config.allow, screen)) {
            return false;
        }
    }
    if (isDenied(config, screen)) {
        return false;
    }
    if (needsFinancial(screen) && !hasFinancialAccess() && !explicitlyAllowed(config, screen)) {
        return false;
    }
    return true;
}

export function firstAllowedSub(tab) {
    const subs = MENU_SUBS[tab] || [];
    return subs.find((sub) => canSee(tab, sub)) || "";
}

export function defaultDeliveriesSub() {
    return DELIVERY_INNERS.find((inner) => canSee("operations", "deliveries", inner)) || "dispatch";
}

export function defaultStaffRole() {
    if (canSee("staff", "order_booker")) {
        return "order_booker";
    }
    if (canSee("staff", "delivery_man")) {
        return "delivery_man";
    }
    return "order_booker";
}

export function defaultHome() {
    return { tab: "overview", sub: "" };
}

export function canMutate() {
    return currentConfig().canMutate !== false;
}

export function canSettleWallet() {
    const config = currentConfig();
    if (config.canSettleWallet !== undefined) {
        return config.canSettleWallet;
    }
    return canMutate();
}

export function canDispatchOrders() {
    const config = currentConfig();
    if (config.canDispatchOrders !== undefined) {
        return config.canDispatchOrders;
    }
    return canMutate();
}

export function canEditDispatchDetails() {
    const config = currentConfig();
    if (config.canEditDispatchDetails !== undefined) {
        return config.canEditDispatchDetails;
    }
    return canMutate();
}

export function canManageStaff() {
    const config = currentConfig();
    if (config.canManageStaff !== undefined) {
        return config.canManageStaff;
    }
    return canMutate();
}

export function canManageProducts() {
    const config = currentConfig();
    if (config.canManageProducts !== undefined) {
        return config.canManageProducts;
    }
    return canMutate();
}

export function isDistributorPortal() {
    return portalAccessState.role === "distributor";
}

/** Draft editing stays available to distributor and manager. */
export function canResetOrderToDraft() {
    const config = currentConfig();
    if (config.canResetOrderToDraft === false) {
        return false;
    }
    const role = portalAccessState.role;
    return role === "distributor" || role === "manager";
}

export function showPrices() {
    const config = currentConfig();
    if (config.showPrices === false) {
        return false;
    }
    if (config.showPrices === true) {
        return true;
    }
    return hasFinancialAccess();
}

export function canSeeCard(card) {
    const config = currentConfig();
    if (config.cards) {
        return config.cards.includes(card);
    }
    if ((config.hideCards || []).includes(card)) {
        return false;
    }
    if (!DEFAULT_CARDS.includes(card)) {
        return false;
    }
    if ((card === "financials" || card === "invoices") && !hasFinancialAccess()) {
        return false;
    }
    return true;
}

let portalBusyCount = 0;

export function notifyPortalBusy(busy) {
    portalBusyCount = Math.max(0, portalBusyCount + (busy ? 1 : -1));
    window.dispatchEvent(new CustomEvent("shahtaj-portal-busy", {
        detail: { busy: portalBusyCount > 0 },
    }));
}

export function resetPortalBusy() {
    portalBusyCount = 0;
    window.dispatchEvent(new CustomEvent("shahtaj-portal-busy", {
        detail: { busy: false },
    }));
}
