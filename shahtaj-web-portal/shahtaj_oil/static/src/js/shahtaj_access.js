/** @odoo-module **/

import { session } from "@web/session";

/**
 * True when the logged-in distributor may view financials, pricing, and invoices.
 */
export function hasFinancialAccess() {
    return Boolean(session.shahtaj_financial_access);
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
