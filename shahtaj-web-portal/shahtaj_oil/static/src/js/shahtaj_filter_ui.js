/** @odoo-module **/

/**
 * Update a nested list filter field (avoids t-model on selects that remount with list toolbars).
 */
export function setFilterField(state, listKey, field, value) {
    if (!state.filters[listKey]) {
        state.filters[listKey] = {};
    }
    state.filters[listKey][field] = value;
}

export function setScalarFilter(state, fieldName, value) {
    state[fieldName] = value;
}

/** @returns {string} */
export function filterOptionValue(id) {
    if (id === undefined || id === null || id === false) {
        return "";
    }
    return String(id);
}
