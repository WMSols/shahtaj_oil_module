/** @odoo-module **/

/** Survives FinancialsInvoicing unmount when jumping here from Warehouse. */
let pendingPoPrefill = null;
let pendingCashDirection = 'all';

export function storePendingPoPrefill(detail) {
    if (!detail) {
        pendingPoPrefill = null;
        return;
    }
    const vendorId = detail.vendorId ? parseInt(detail.vendorId, 10) : null;
    const productId = detail.productId ? parseInt(detail.productId, 10) : null;
    const productTmplId = detail.productTmplId ? parseInt(detail.productTmplId, 10) : null;
    if (!vendorId && !productId && !productTmplId) {
        pendingPoPrefill = null;
        return;
    }
    pendingPoPrefill = {
        vendorId: vendorId || null,
        productId: productId || null,
        productTmplId: productTmplId || null,
        productName: detail.productName || '',
        vendorName: detail.vendorName || '',
    };
}

export function consumePendingPoPrefill() {
    const pending = pendingPoPrefill;
    pendingPoPrefill = null;
    return pending;
}

export function peekPendingPoPrefill() {
    return pendingPoPrefill;
}

export function setPendingCashDirection(direction) {
    pendingCashDirection = direction || 'all';
}

export function takePendingCashDirection() {
    const direction = pendingCashDirection || 'all';
    pendingCashDirection = 'all';
    return direction;
}

if (typeof window !== "undefined" && !window.__shahtajPoPrefillBound) {
    window.__shahtajPoPrefillBound = true;
    window.addEventListener("shahtaj-open-create-po", (ev) => {
        storePendingPoPrefill(ev.detail || {});
    });
}
