/** @odoo-module **/

import { Component, useState, onWillUpdateProps, onWillUnmount } from "@odoo/owl";
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
        requestedOrderDate: { type: String, optional: true },
        requestedDispatchDate: { type: String, optional: true },
        requestedDmDate: { type: String, optional: true },
        requestedDmFieldState: { type: String, optional: true },
        requestedDmState: { type: String, optional: true },
    };

    setup() {
        this._alive = true;
        this._resolveRefresh = null;
        onWillUnmount(() => {
            this._alive = false;
            this.onRefreshSettled();
        });
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
        invalidateOperationsCache();
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

OperationsTracking.template = "shahtaj_oil.OperationsTracking";
