/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";
import { Component, useState } from "@odoo/owl";

/**
 * Form widget: fill latitude/longitude from the browser geolocation API.
 * Used on DM deliver wizard so location is not shop-GPS prefilled.
 */
export class ShahtajGeolocateWidget extends Component {
    static template = "shahtaj_oil.ShahtajGeolocateButton";
    static props = {
        ...standardWidgetProps,
        latitudeField: { type: String, optional: true },
        longitudeField: { type: String, optional: true },
    };
    static defaultProps = {
        latitudeField: "latitude",
        longitudeField: "longitude",
    };

    setup() {
        this.notification = useService("notification");
        this.state = useState({ busy: false });
    }

    async onClick() {
        if (this.state.busy) {
            return;
        }
        if (!navigator.geolocation) {
            this.notification.add(_t("GPS is not available in this browser."), {
                type: "danger",
            });
            return;
        }
        this.state.busy = true;
        try {
            const position = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: true,
                    timeout: 20000,
                    maximumAge: 0,
                });
            });
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            await this.props.record.update({
                [this.props.latitudeField]: lat,
                [this.props.longitudeField]: lon,
            });
            this.notification.add(_t("Location captured."), { type: "success" });
        } catch (error) {
            const message =
                (error && error.message) ||
                _t("Could not get GPS. Allow location access and try again.");
            this.notification.add(message, { type: "danger" });
        } finally {
            this.state.busy = false;
        }
    }
}

export const shahtajGeolocateWidget = {
    component: ShahtajGeolocateWidget,
    extractProps: ({ attrs }) => ({
        latitudeField: attrs.latitude_field || "latitude",
        longitudeField: attrs.longitude_field || "longitude",
    }),
};

registry.category("view_widgets").add("shahtaj_geolocate", shahtajGeolocateWidget);
