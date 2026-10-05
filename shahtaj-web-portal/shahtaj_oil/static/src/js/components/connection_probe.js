/** @odoo-module **/

const PROBE_URL = "/shahtaj_oil/static/src/link_probe.txt";
const PROBE_MS = 12000;
const TIMEOUT_MS = 8000;
const SERVER_WINDOW_MS = 20000;

function isPortalRequest(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl, window.location.origin);
    } catch (error) {
        return false;
    }
    if (url.origin !== window.location.origin) {
        return false;
    }
    const path = url.pathname;
    if (path.includes("link_probe")) {
        return false;
    }
    return (
        path.includes("/web/dataset/") ||
        path.includes("/jsonrpc") ||
        path.startsWith("/mail/")
    );
}

/**
 * Link time is a tiny uncached fetch to this server.
 * Server time is the slowest portal request in the last few seconds.
 */
export function startConnectionProbe(onUpdate) {
    let stopped = false;
    const recent = [];

    const emit = (patch) => {
        if (!stopped) {
            onUpdate(patch);
        }
    };

    async function probe() {
        if (stopped || document.hidden) {
            return;
        }
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            emit({ linkStatus: "offline", linkMs: null });
            return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const started = performance.now();
        try {
            const response = await fetch(`${PROBE_URL}?t=${Date.now()}`, {
                method: "GET",
                cache: "no-store",
                credentials: "same-origin",
                signal: controller.signal,
            });
            const ms = performance.now() - started;
            if (!response.ok) {
                emit({ linkStatus: "offline", linkMs: null });
            } else {
                emit({ linkStatus: "online", linkMs: ms });
            }
        } catch (error) {
            if (error && error.name === "AbortError") {
                emit({ linkStatus: "online", linkMs: TIMEOUT_MS });
            } else {
                emit({ linkStatus: "offline", linkMs: null });
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    function noteServerEntry(entry) {
        if (!entry || !isPortalRequest(entry.name)) {
            return;
        }
        const ms = entry.duration;
        if (!ms || ms < 0) {
            return;
        }
        const now = performance.now();
        recent.push({ now, ms });
        while (recent.length && now - recent[0].now > SERVER_WINDOW_MS) {
            recent.shift();
        }
        if (!recent.length) {
            return;
        }
        emit({ serverMs: Math.max(...recent.map((row) => row.ms)) });
    }

    let observer = null;
    if (typeof PerformanceObserver !== "undefined") {
        try {
            observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    noteServerEntry(entry);
                }
            });
            observer.observe({ type: "resource", buffered: false });
        } catch (error) {
            observer = null;
        }
    }

    const onOnline = () => probe();
    const onOffline = () => emit({ linkStatus: "offline", linkMs: null });
    const onVisible = () => {
        if (!document.hidden) {
            probe();
        }
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    probe();
    const timer = window.setInterval(probe, PROBE_MS);

    return () => {
        stopped = true;
        window.clearInterval(timer);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
        document.removeEventListener("visibilitychange", onVisible);
        if (observer) {
            observer.disconnect();
        }
    };
}
