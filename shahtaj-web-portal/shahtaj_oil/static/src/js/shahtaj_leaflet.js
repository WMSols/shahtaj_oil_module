/** @odoo-module **/

import { loadCSS, loadJS } from "@web/core/assets";

const LEAFLET_CSS = "/shahtaj_oil/static/src/lib/leaflet/leaflet.css";
const LEAFLET_JS = "/shahtaj_oil/static/src/lib/leaflet/leaflet.js";

let leafletPromise = null;

function leafletGlobal() {
    if (window.L && window.L.map) {
        return window.L;
    }
    if (window.leaflet && window.leaflet.map) {
        window.L = window.leaflet;
        return window.L;
    }
    return null;
}

/** Load Leaflet the first time a map opens. Other screens do not download it. */
export function ensureLeaflet() {
    const ready = leafletGlobal();
    if (ready) {
        return Promise.resolve(ready);
    }
    if (!leafletPromise) {
        leafletPromise = (async () => {
            const previousDefine = window.define;
            if (previousDefine && previousDefine.amd) {
                window.define = undefined;
            }
            try {
                await loadCSS(LEAFLET_CSS);
                await loadJS(LEAFLET_JS);
            } finally {
                if (previousDefine && previousDefine.amd) {
                    window.define = previousDefine;
                }
            }
            const lib = leafletGlobal();
            if (!lib) {
                throw new Error("Leaflet did not load");
            }
            return lib;
        })().catch((error) => {
            leafletPromise = null;
            throw error;
        });
    }
    return leafletPromise;
}
