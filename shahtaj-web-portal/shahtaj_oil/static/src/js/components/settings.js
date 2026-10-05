/** @odoo-module **/

import { Component, useState, onWillStart, onWillUnmount } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { notifyPortalBusy } from "../shahtaj_access";
import { startConnectionProbe } from "./connection_probe";

export class PortalSettings extends Component {
    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            isLoading: false,
            isSavingGps: false,
            isSavingCompany: false,
            isSavingLogo: false,
            isSavingDmOverwrite: false,
            dmOverwriteButtons: false,
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
            appName: "Shahtaj Oil",
            appVersion: "",
            linkStatus: "checking",
            linkMs: null,
            serverMs: null,
        });

        onWillStart(async () => {
            await this.loadSettings();
        });
        this._stopConnectionProbe = startConnectionProbe((patch) => {
            Object.assign(this.state, patch);
        });
        onWillUnmount(() => {
            if (this._stopConnectionProbe) {
                this._stopConnectionProbe();
            }
        });
    }

    async onDmOverwriteToggle(ev) {
        const enabled = Boolean(ev.target.checked);
        const previous = this.state.dmOverwriteButtons;
        this.state.dmOverwriteButtons = enabled;
        this.state.isSavingDmOverwrite = true;
        try {
            const result = await this.orm.call(
                "res.company",
                "shahtaj_set_dm_overwrite_buttons",
                [],
                { enabled }
            );
            this.state.dmOverwriteButtons = Boolean(result?.enabled);
            this.notification.add(
                this.state.dmOverwriteButtons
                    ? "DM overwrite buttons enabled."
                    : "DM overwrite buttons disabled.",
                { type: "success" }
            );
        } catch (error) {
            this.state.dmOverwriteButtons = previous;
            ev.target.checked = previous;
            this.notification.add(
                error.data?.message || error.message || "Failed to save DM overwrite setting",
                { type: "danger" }
            );
        } finally {
            this.state.isSavingDmOverwrite = false;
        }
    }

    get currentYear() {
        return new Date().getFullYear();
    }

    get linkBars() {
        if (this.state.linkStatus !== "online" || this.state.linkMs == null) {
            return 0;
        }
        const ms = this.state.linkMs;
        if (ms > 800) {
            return 1;
        }
        if (ms > 300) {
            return 2;
        }
        if (ms > 100) {
            return 3;
        }
        return 4;
    }

    get linkQualityLabel() {
        if (this.state.linkStatus === "checking") {
            return "Checking";
        }
        if (this.state.linkStatus === "offline") {
            return "Offline";
        }
        return ["", "Poor", "Fair", "Good", "Strong"][this.linkBars] || "Poor";
    }

    get linkQualityClass() {
        if (this.state.linkStatus === "checking") {
            return "text-muted";
        }
        if (this.state.linkStatus === "offline" || this.linkBars <= 1) {
            return "text-danger";
        }
        if (this.linkBars === 2) {
            return "text-warning";
        }
        return "text-success";
    }

    formatDuration(ms) {
        if (ms == null || Number.isNaN(ms)) {
            return "—";
        }
        if (ms >= 1000) {
            return `${(ms / 1000).toFixed(1)} s`;
        }
        return `${Math.round(ms)} ms`;
    }

    linkBarStyle(level) {
        const heights = { 1: 6, 2: 10, 3: 14, 4: 18 };
        const active = level <= this.linkBars;
        const colors = { 1: "#dc2626", 2: "#d97706", 3: "#65a30d", 4: "#16a34a" };
        const color = active ? colors[this.linkBars] || "#16a34a" : "#e2e8f0";
        return `display:inline-block;width:4px;height:${heights[level]}px;border-radius:2px;background:${color};`;
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
        notifyPortalBusy(true);
        try {
            const [limits, profile, appInfo, dmOverwrite] = await Promise.all([
                this.orm.call("res.company", "shahtaj_get_shop_distance_limits", []),
                this.orm.call("res.company", "shahtaj_get_company_profile", []),
                this.orm.call("res.company", "shahtaj_get_app_info", []),
                this.orm.call("res.company", "shahtaj_get_dm_overwrite_buttons", []),
            ]);
            this.state.gpsForm.min_m = limits.min_m ?? 0;
            this.state.gpsForm.max_m = limits.max_m ?? 100;
            this.state.companyId = profile.id;
            this.state.companyForm.name = profile.name || "";
            this.state.companyForm.phone = profile.phone || "";
            this.state.companyForm.logo_preview = this._logoPreviewSrc(profile.logo);
            this.state.appName = appInfo.name || "Shahtaj Oil";
            this.state.appVersion = appInfo.version || "";
            this.state.dmOverwriteButtons = Boolean(dmOverwrite?.enabled);
        } catch (error) {
            this.notification.add(
                error.data?.message || error.message || "Failed to load settings",
                { type: "danger" }
            );
        } finally {
            this.state.isLoading = false;
            notifyPortalBusy(false);
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
