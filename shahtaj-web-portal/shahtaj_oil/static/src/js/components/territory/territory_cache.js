/** @odoo-module **/

let dashboard = null;
let dashboardPromise = null;

async function fetchDashboard(orm) {
    const includeArchivedDomain = ['|', ['active', '=', true], ['active', '=', false]];
    const [areas, routes, archivedShops, bookerGroups] = await Promise.all([
        orm.searchRead("shahtaj.zone", includeArchivedDomain, ["id", "name", "active", "route_count"]),
        orm.searchRead("shahtaj.route", includeArchivedDomain, ["id", "name", "zone_id", "shop_count", "active"]),
        orm.searchRead("res.partner", [["is_shahtaj_shop", "=", true], ["active", "=", false]], ["id", "name", "owner_name", "shahtaj_routes_display", "shahtaj_route_tag", "active"]),
        orm.call(
            "res.partner",
            "read_group",
            [
                [["is_shahtaj_shop", "=", true], ["registered_by_id", "!=", false]],
                ["registered_by_id"],
                ["registered_by_id"],
            ],
        ),
    ]);
    return {
        areas: areas || [],
        routes: routes || [],
        shops: archivedShops || [],
        bookers: (bookerGroups || []).map((g) => ({
            id: g.registered_by_id[0],
            name: g.registered_by_id[1],
        })),
    };
}

export async function getTerritoryDashboard(orm, { force = false } = {}) {
    if (force) {
        dashboard = null;
        dashboardPromise = null;
    }
    if (dashboard) {
        return dashboard;
    }
    if (!dashboardPromise) {
        dashboardPromise = fetchDashboard(orm).then((data) => {
            dashboard = data;
            dashboardPromise = null;
            return data;
        }).catch((error) => {
            dashboardPromise = null;
            throw error;
        });
    }
    return dashboardPromise;
}

export function applyTerritoryDashboardToState(state, data) {
    if (!data || !state) {
        return;
    }
    state.areas = data.areas || [];
    state.routes = data.routes || [];
    state.shops = data.shops || [];
    state.bookers = data.bookers || [];
}

export function invalidateTerritoryCache() {
    dashboard = null;
    dashboardPromise = null;
}

export function resolveTerritoryTab(requested) {
    const allowed = ["areas", "routes", "shops", "archive"];
    if (allowed.includes(requested)) {
        return requested;
    }
    return "areas";
}
