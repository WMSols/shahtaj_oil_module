/** @odoo-module **/

/**
 * Cross-tab handoff for Dist custom portal (stay in SPA, do not open native forms).
 * Example: Stock Occupation -> Live Orders / DM Jobs.
 */

let pendingOrder = null;
let pendingDmJob = null;

export function queuePortalOrder(order) {
    pendingOrder = order || null;
}

export function takePortalOrder() {
    const order = pendingOrder;
    pendingOrder = null;
    return order;
}

export function queuePortalDmJob(job) {
    pendingDmJob = job || null;
}

export function takePortalDmJob() {
    const job = pendingDmJob;
    pendingDmJob = null;
    return job;
}

export function switchPortalTab(detail = {}) {
    window.dispatchEvent(new CustomEvent("shahtaj-dashboard-switch", { detail }));
}
