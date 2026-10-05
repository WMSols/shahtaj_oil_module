/** @odoo-module **/

import { TerritoryBase } from "./territory_base";

export class TerritoryArchive extends TerritoryBase {
    setup() {
        super.setup();
        if (this.props.previousSubTab) {
            this.state.previousSubTab = this.props.previousSubTab;
        }
    }

    setSubTab(tabName) {
        if (tabName !== "archive" && this.props.onBack) {
            this.props.onBack();
            return;
        }
        super.setSubTab(tabName);
    }
}
TerritoryArchive.template = "shahtaj_oil.TerritoryArchive";
