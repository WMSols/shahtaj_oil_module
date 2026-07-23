/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class PortalSettings extends Component {
    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            isLoading: false,
            isSavingGps: false,
            isSavingCompany: false,
            isSavingLogo: false,
            companyId: null,
            companyForm: {
                name: "",
                phone: "",
                logo_preview: false,
            },
            gpsForm: {
                min_m: 0,
                max_m: 100,
            },
        });

        onWillStart(async () => {
            await this.loadSettings();
        });
    }

    _logoPreviewSrc(logoBase64) {
        if (!logoBase64) {
            return false;
        }
        if (String(logoBase64).startsWith("data:")) {
            return logoBase64;
        }
        return `data:image/png;base64,${logoBase64}`;
    }

    async loadSettings() {
        this.state.isLoading = true;
        try {
            const [limits, profile] = await Promise.all([
                this.orm.call("res.company", "shahtaj_get_shop_distance_limits", []),
                this.orm.call("res.company", "shahtaj_get_company_profile", []),
            ]);
            this.state.gpsForm.min_m = limits.min_m ?? 0;
            this.state.gpsForm.max_m = limits.max_m ?? 100;
            this.state.companyId = profile.id;
            this.state.companyForm.name = profile.name || "";
            this.state.companyForm.phone = profile.phone || "";
            this.state.companyForm.logo_preview = this._logoPreviewSrc(profile.logo);
        } catch (error) {
            this.notification.add(
                error.data?.message || error.message || "Failed to load settings",
                { type: "danger" }
            );
        } finally {
            this.state.isLoading = false;
        }
    }

    async saveGpsSettings() {
        const minM = parseFloat(this.state.gpsForm.min_m);
        const maxM = parseFloat(this.state.gpsForm.max_m);
        if (Number.isNaN(minM) || Number.isNaN(maxM)) {
            this.notification.add("Enter valid min and max distances in metres.", { type: "warning" });
            return;
        }
        if (minM < 0) {
            this.notification.add("Minimum distance cannot be negative.", { type: "warning" });
            return;
        }
        if (maxM < 10) {
            this.notification.add("Maximum distance must be at least 10 metres.", { type: "warning" });
            return;
        }
        if (minM > maxM) {
            this.notification.add("Minimum cannot be greater than maximum.", { type: "warning" });
            return;
        }
        this.state.isSavingGps = true;
        try {
            const limits = await this.orm.call(
                "res.company",
                "shahtaj_set_shop_distance_limits",
                [],
                { min_m: minM, max_m: maxM }
            );
            this.state.gpsForm.min_m = limits.min_m;
            this.state.gpsForm.max_m = limits.max_m;
            this.notification.add(
                `GPS range saved: ${limits.min_m}–${limits.max_m} m. Applies on the next check-in / place-order.`,
                { type: "success" }
            );
        } catch (error) {
            this.notification.add(
                error.data?.message || error.message || "Failed to save GPS settings",
                { type: "danger" }
            );
        } finally {
            this.state.isSavingGps = false;
        }
    }

    async saveCompanySettings() {
        const name = (this.state.companyForm.name || "").trim();
        if (!name) {
            this.notification.add("Company name is required.", { type: "warning" });
            return;
        }
        this.state.isSavingCompany = true;
        try {
            const profile = await this.orm.call(
                "res.company",
                "shahtaj_set_company_profile",
                [],
                {
                    name,
                    phone: this.state.companyForm.phone || "",
                }
            );
            this.state.companyForm.name = profile.name || "";
            this.state.companyForm.phone = profile.phone || "";
            this.notification.add("Company profile saved.", { type: "success" });
        } catch (error) {
            this.notification.add(
                error.data?.message || error.message || "Failed to save company profile",
                { type: "danger" }
            );
        } finally {
            this.state.isSavingCompany = false;
        }
    }

    onLogoSelected(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) {
            return;
        }
        if (!["image/png", "image/jpeg", "image/jpg"].includes(file.type)) {
            this.notification.add("Please upload a PNG or JPG image.", { type: "warning" });
            ev.target.value = "";
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            this.notification.add("Logo must be 2 MB or smaller.", { type: "warning" });
            ev.target.value = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = async (e) => {
            const dataUrl = e.target.result;
            const base64 = String(dataUrl).split(",")[1];
            this.state.isSavingLogo = true;
            try {
                const profile = await this.orm.call(
                    "res.company",
                    "shahtaj_set_company_profile",
                    [],
                    { logo: base64 }
                );
                this.state.companyForm.logo_preview = this._logoPreviewSrc(profile.logo) || dataUrl;
                this.notification.add("Company logo updated.", { type: "success" });
            } catch (error) {
                this.notification.add(
                    error.data?.message || error.message || "Failed to upload logo",
                    { type: "danger" }
                );
            } finally {
                this.state.isSavingLogo = false;
                ev.target.value = "";
            }
        };
        reader.readAsDataURL(file);
    }

    async removeLogo() {
        this.state.isSavingLogo = true;
        try {
            await this.orm.call(
                "res.company",
                "shahtaj_set_company_profile",
                [],
                { logo: false }
            );
            this.state.companyForm.logo_preview = false;
            this.notification.add("Company logo removed.", { type: "success" });
        } catch (error) {
            this.notification.add(
                error.data?.message || error.message || "Failed to remove logo",
                { type: "danger" }
            );
        } finally {
            this.state.isSavingLogo = false;
        }
    }
}

PortalSettings.template = "shahtaj_oil.PortalSettings";
