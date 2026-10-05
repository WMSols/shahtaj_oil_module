/** @odoo-module **/

import { Component, useState, onWillUpdateProps } from "@odoo/owl";
import { ShopCheckins } from "./shop_checkins";
import { DmOperations } from "./dm_operations";
import { LiveOrders } from "./live_orders";
import { BookersPerformance } from "./bookers_performance";
import { invalidateOperationsCache, resolveOperationsTab } from "./operations_cache";

export class OperationsTracking extends Component {
    static components = { ShopCheckins, DmOperations, LiveOrders, BookersPerformance };
    static props = {
        requestedSubTab: { type: String, optional: true },
        requestedDeliveriesSubTab: { type: String, optional: true },
        requestedCheckinPurpose: { type: String, optional: true },
        requestedCheckinRole: { type: String, optional: true },
        requestedCheckinDate: { type: String, optional: true },
    };

    setup() {
        const resolved = resolveOperationsTab(this.props.requestedSubTab, this.props.requestedDeliveriesSubTab);
        this.state = useState({
            activeSubTab: resolved.activeSubTab,
            deliveriesSubTab: resolved.deliveriesSubTab,
            isRefreshing: false,
            refreshNonce: 0,
        });
        onWillUpdateProps((nextProps) => {
            const nextResolved = resolveOperationsTab(nextProps.requestedSubTab, nextProps.requestedDeliveriesSubTab);
            if (
                nextResolved.activeSubTab !== this.state.activeSubTab
                || nextResolved.deliveriesSubTab !== this.state.deliveriesSubTab
            ) {
                this.state.activeSubTab = nextResolved.activeSubTab;
                this.state.deliveriesSubTab = nextResolved.deliveriesSubTab;
            }
        });
    }

    async refreshData() {
        this.state.isRefreshing = true;
        try {
            invalidateOperationsCache();
            this.state.refreshNonce += 1;
        } finally {
            this.state.isRefreshing = false;
        }
    }
}

OperationsTracking.template = "shahtaj_oil.OperationsTracking";
