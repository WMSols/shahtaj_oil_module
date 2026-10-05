/** @odoo-module **/

import { Component, useState, useRef, onWillUnmount } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

const QUICK_LIMIT = 8;
const PAGE_SIZE = 20;
const ROUTE_DOMAIN = [["active", "=", true]];

export class RouteFilter extends Component {
    static template = "shahtaj_oil.RouteFilter";
    static props = {
        routeId: { type: [String, Number] },
        routeName: { type: String, optional: true },
        onSelect: Function,
    };

    setup() {
        this.orm = useService("orm");
        this.rootRef = useRef("root");
        this.pageSize = PAGE_SIZE;
        this.state = useState({
            open: false,
            loadingQuick: false,
            quickRoutes: [],
            modalOpen: false,
            modalSearch: "",
            modalPage: 1,
            modalTotal: 0,
            modalRows: [],
            modalLoading: false,
        });
        this._searchTimer = null;
        this._onDocClick = (ev) => {
            if (!this.state.open || this.state.modalOpen) {
                return;
            }
            const root = this.rootRef.el;
            if (root && !root.contains(ev.target)) {
                this.state.open = false;
            }
        };
        document.addEventListener("mousedown", this._onDocClick);
        onWillUnmount(() => {
            document.removeEventListener("mousedown", this._onDocClick);
            clearTimeout(this._searchTimer);
        });
    }

    get label() {
        const id = this.props.routeId;
        if (!id || String(id) === "all") {
            return "All Routes";
        }
        if (String(id) === "unassigned") {
            return "Unassigned Only";
        }
        return this.props.routeName || "Route";
    }

    get modalPageCount() {
        return Math.max(1, Math.ceil((this.state.modalTotal || 0) / PAGE_SIZE));
    }

    get modalRangeStart() {
        if (!this.state.modalTotal) {
            return 0;
        }
        return (this.state.modalPage - 1) * PAGE_SIZE + 1;
    }

    get modalRangeEnd() {
        return Math.min(this.state.modalPage * PAGE_SIZE, this.state.modalTotal || 0);
    }

    async toggle() {
        this.state.open = !this.state.open;
        if (this.state.open) {
            await this.loadQuick();
        }
    }

    async loadQuick() {
        this.state.loadingQuick = true;
        try {
            this.state.quickRoutes = await this.orm.searchRead(
                "shahtaj.route",
                ROUTE_DOMAIN,
                ["id", "name"],
                { order: "name asc", limit: QUICK_LIMIT }
            ) || [];
        } catch (error) {
            this.state.quickRoutes = [];
        } finally {
            this.state.loadingQuick = false;
        }
    }

    chooseAll() {
        this.state.open = false;
        this.state.modalOpen = false;
        this.props.onSelect("all", "");
    }

    chooseUnassigned() {
        this.state.open = false;
        this.state.modalOpen = false;
        this.props.onSelect("unassigned", "Unassigned Only");
    }

    choose(route) {
        this.state.open = false;
        this.state.modalOpen = false;
        this.props.onSelect(String(route.id), route.name || "");
    }

    async openModal() {
        this.state.open = false;
        this.state.modalOpen = true;
        this.state.modalSearch = "";
        this.state.modalPage = 1;
        await this.loadModal();
    }

    closeModal() {
        this.state.modalOpen = false;
    }

    onModalSearch(ev) {
        this.state.modalSearch = ev.target.value;
        this.state.modalPage = 1;
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => this.loadModal(), 300);
    }

    _modalDomain() {
        const domain = ROUTE_DOMAIN.slice();
        const term = (this.state.modalSearch || "").trim();
        if (term) {
            domain.push(["name", "ilike", term]);
        }
        return domain;
    }

    async loadModal() {
        this.state.modalLoading = true;
        const domain = this._modalDomain();
        const page = this.state.modalPage;
        try {
            const [total, rows] = await Promise.all([
                this.orm.searchCount("shahtaj.route", domain),
                this.orm.searchRead("shahtaj.route", domain, ["id", "name"], {
                    order: "name asc",
                    limit: PAGE_SIZE,
                    offset: (page - 1) * PAGE_SIZE,
                }),
            ]);
            this.state.modalTotal = total || 0;
            this.state.modalRows = rows || [];
        } catch (error) {
            this.state.modalTotal = 0;
            this.state.modalRows = [];
        } finally {
            this.state.modalLoading = false;
        }
    }

    async changeModalPage(delta) {
        const next = this.state.modalPage + delta;
        if (next < 1 || next > this.modalPageCount) {
            return;
        }
        this.state.modalPage = next;
        await this.loadModal();
    }
}
