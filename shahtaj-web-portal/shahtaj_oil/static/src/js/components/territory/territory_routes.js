/** @odoo-module **/

import { Component, useState, onWillUpdateProps, onWillUnmount } from "@odoo/owl";
import { TerritoryZones } from "./zones";
import { TerritoryRouteList } from "./route_list";
import { TerritoryShops } from "./shops";
import { TerritoryArchive } from "./archive";
import { invalidateTerritoryCache, resolveTerritoryTab } from "./territory_cache";

export class TerritoryRoutes extends Component {
    static components = { TerritoryZones, TerritoryRouteList, TerritoryShops, TerritoryArchive };
    static props = {
        requestedSubTab: { type: String, optional: true },
        requestedShopStatus: { type: String, optional: true },
        requestedShopRegisteredOn: { type: String, optional: true },
        requestedShopRegistrar: { type: String, optional: true },
    };

    setup() {
        this._alive = true;
        this._resolveRefresh = null;
        onWillUnmount(() => {
            this._alive = false;
            this.onRefreshSettled();
        });
        this.state = useState({
            activeSubTab: resolveTerritoryTab(this.props.requestedSubTab),
            previousSubTab: "areas",
            isRefreshing: false,
            refreshNonce: 0,
        });
        onWillUpdateProps((nextProps) => {
            const nextTab = resolveTerritoryTab(nextProps.requestedSubTab);
            if (nextTab !== this.state.activeSubTab) {
                if (nextTab === "archive" && this.state.activeSubTab !== "archive") {
                    this.state.previousSubTab = this.state.activeSubTab;
                }
                this.state.activeSubTab = nextTab;
            }
        });
    }

    openArchive() {
        if (this.state.activeSubTab !== "archive") {
            this.state.previousSubTab = this.state.activeSubTab;
        }
        this.state.activeSubTab = "archive";
    }

    closeArchive() {
        this.state.activeSubTab = this.state.previousSubTab || "areas";
    }

    async refreshData() {
        if (this.state.isRefreshing) {
            return;
        }
        this.state.isRefreshing = true;
        // Let the spinner paint before the child reload starts. The flag used
        // to flip off in the same tick, so OWL never rendered fa-spin.
        await new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
        if (!this._alive) {
            return;
        }
        invalidateTerritoryCache();
        const settled = new Promise((resolve) => {
            this._resolveRefresh = resolve;
        });
        this.state.refreshNonce += 1;
        await settled;
        if (this._alive) {
            this.state.isRefreshing = false;
        }
    }

    onRefreshSettled() {
        const resolve = this._resolveRefresh;
        this._resolveRefresh = null;
        if (resolve) {
            resolve();
        }
    }
}

TerritoryRoutes.template = "shahtaj_oil.TerritoryRoutes";
