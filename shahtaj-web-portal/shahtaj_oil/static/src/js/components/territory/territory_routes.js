/** @odoo-module **/

import { Component, useState, onWillUpdateProps } from "@odoo/owl";
import { TerritoryZones } from "./zones";
import { TerritoryRouteList } from "./route_list";
import { TerritoryShops } from "./shops";
import { TerritoryArchive } from "./archive";
import { invalidateTerritoryCache, resolveTerritoryTab } from "./territory_cache";

export class TerritoryRoutes extends Component {
    static components = { TerritoryZones, TerritoryRouteList, TerritoryShops, TerritoryArchive };
    static props = {
        requestedSubTab: { type: String, optional: true },
    };

    setup() {
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
        this.state.isRefreshing = true;
        try {
            invalidateTerritoryCache();
            this.state.refreshNonce += 1;
        } finally {
            this.state.isRefreshing = false;
        }
    }
}

TerritoryRoutes.template = "shahtaj_oil.TerritoryRoutes";
