/** @odoo-module **/

const TTL_MS = 60 * 1000;
const entries = new Map();

/**
 * Remember a read for one minute. Refresh and Apply pass force and skip the hit.
 * In-flight calls with the same key share one promise.
 */
export function cachedRead(key, loader, { force = false } = {}) {
    const now = Date.now();
    const current = entries.get(key);
    if (!force && current) {
        if (current.value !== undefined && current.expires > now) {
            return Promise.resolve(current.value);
        }
        if (current.promise) {
            return current.promise;
        }
    }
    const promise = Promise.resolve()
        .then(loader)
        .then((value) => {
            entries.set(key, { value, expires: Date.now() + TTL_MS });
            return value;
        })
        .catch((error) => {
            const stored = entries.get(key);
            if (stored && stored.promise === promise) {
                entries.delete(key);
            }
            throw error;
        });
    entries.set(key, { promise, expires: 0 });
    return promise;
}
