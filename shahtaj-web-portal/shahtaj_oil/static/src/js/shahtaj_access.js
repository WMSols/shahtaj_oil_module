/** @odoo-module **/

import { session } from "@web/session";

/**
 * True when the logged-in distributor may view financials, pricing, and invoices.
 */
export function hasFinancialAccess() {
    return Boolean(session.shahtaj_financial_access);
}
