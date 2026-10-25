// ==UserScript==
// @name         SearXNG Preference Syncer
// @namespace    http://tampermonkey.net
// @version      3.0
// @description  Sync SearXNG preferences between instances
// @author       KraXen72
// @match        https://searx.tiekoetter.com/preferences*
// @match        https://search.rhscz.eu/preferences*
// @match        https://searx.rhscz.eu/preferences*
// @match        https://searx.oloke.xyz/preferences*
// @match        https://searxng.website/searxng/preferences*
// @match        https://paulgo.io/preferences*
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/js-cookie@3.0.8/dist/js.cookie.min.js
// @license      AGPL-3.0-or-later
// ==/UserScript==

const lprefix = "[SearXNG Preference Syncer]:";

// Keep these names for compatibility with storage exported by v2.x.
const gm_cookiesPrefKey = "searxCookies";
const gm_enabledEnginesPrefKey = "searxCookies_enabledEngines";
const gm_disabledEnginesPrefKey = "searxCookies_disabledEngines";

const pendingImportKey = "searxng-syncer-pending-engine-import-v3";
const cookies_enabledEnginesKey = "enabled_engines";
const cookies_disabledEnginesKey = "disabled_engines";

// Only copy SearXNG preferences, never challenge/authentication cookies.
const preferenceCookieKeys = new Set([
    "categories", "language", "locale", "safesearch", "theme",
    "results_on_new_tab", "doi_resolver", "center_alignment",
    "query_in_title", "search_on_category_select", "hotkeys",
    "url_formatting", "disabled_plugins", "autocomplete",
    "enabled_plugins", "favicon_resolver", "simple_style",
    "image_proxy", cookies_enabledEnginesKey, cookies_disabledEnginesKey
]);

let cookies;

function initCookies() {
    if (cookies != null) return;

    cookies = Cookies.withConverter({
        read(value, name) {
            const decodedValue = Cookies.converter.read(value, name);
            return decodedValue.replace(/\\054/g, ",");
        },
        write(value) {
            // SearXNG expects comma-separated, unescaped engine names.
            return decodeURIComponent(value);
        }
    });
}

function engineKeyFromInputName(name) {
    if (!name.startsWith("engine_")) return null;
    const raw = name.slice("engine_".length);
    const divider = raw.lastIndexOf("__");
    if (divider < 0) return null;

    return raw.slice(0, divider).replaceAll("_", " ") + raw.slice(divider);
}

function getEngineCheckboxes() {
    return Array.from(document.querySelectorAll(
        'section#tab-content-engines input[type="checkbox"][name^="engine_"]'
    ));
}

function getCurrentEngineConfig() {
    return getEngineCheckboxes()
    .map(checkbox => ({
        engine: engineKeyFromInputName(checkbox.name),
                      // The SearXNG form submits CHECKED checkboxes as disabled engines.
                      enabled: !checkbox.checked
    }))
    .filter(item => item.engine != null);
}

function getExportCookies() {
    initCookies();
    return Object.fromEntries(
        Object.entries(cookies.get())
        .filter(([key]) => preferenceCookieKeys.has(key))
    );
}

function parseStoredJson(key) {
    const raw = GM_getValue(key, null);
    if (raw == null) throw new Error(`No saved value for ${key}. Export first.`);
    return JSON.parse(raw);
}

function readSavedCookies() {
    const saved = parseStoredJson(gm_cookiesPrefKey);
    if (saved === null || typeof saved !== "object" || Array.isArray(saved)) {
        throw new Error("Saved cookies are not an object.");
    }

    return Object.fromEntries(
        Object.entries(saved)
        .filter(([key, value]) => preferenceCookieKeys.has(key) && typeof value === "string")
    );
}

function readSavedEngineStates() {
    const enabled = parseStoredJson(gm_enabledEnginesPrefKey);
    const disabled = parseStoredJson(gm_disabledEnginesPrefKey);

    if (!Array.isArray(enabled) || !Array.isArray(disabled)) {
        throw new Error("Saved engine preferences are not arrays.");
    }

    const states = new Map();
    for (const item of [...enabled, ...disabled]) {
        if (typeof item?.engine !== "string" || typeof item.enabled !== "boolean") {
            throw new Error("Invalid saved engine entry.");
        }
        if (states.has(item.engine) && states.get(item.engine) !== item.enabled) {
            throw new Error(`Conflicting saved states for ${item.engine}.`);
        }
        states.set(item.engine, item.enabled);
    }

    if (states.size === 0) throw new Error("No engine preferences were saved.");
    return Array.from(states, ([engine, enabled]) => ({ engine, enabled }));
}

function readSavedEngineOverrides(savedCookies) {
    const states = new Map();
    for (const engine of (savedCookies[cookies_disabledEnginesKey] || "").split(",")) {
        if (engine) states.set(engine, false);
    }
    for (const engine of (savedCookies[cookies_enabledEnginesKey] || "").split(",")) {
        if (engine) states.set(engine, true);
    }
    return Array.from(states, ([engine, enabled]) => ({ engine, enabled }));
}

function exportPreferences() {
    const engineConfig = getCurrentEngineConfig();
    if (engineConfig.length === 0) {
        throw new Error("Could not find SearXNG's engine checkboxes.");
    }

    GM_setValue(gm_cookiesPrefKey, JSON.stringify(getExportCookies()));
    GM_setValue(gm_enabledEnginesPrefKey, JSON.stringify(engineConfig.filter(e => e.enabled)));
    GM_setValue(gm_disabledEnginesPrefKey, JSON.stringify(engineConfig.filter(e => !e.enabled)));

    console.info(`${lprefix} Exported ${engineConfig.length} engine states.`);
    window.alert(`Exported preferences and ${engineConfig.length} engine states.\n\nMake sure you saved your settings on this instance before exporting.`);
}

function writeCookies(savedCookies) {
    initCookies();
    const failures = [];

    for (const [key, value] of Object.entries(savedCookies)) {
        if (key === cookies_enabledEnginesKey || key === cookies_disabledEnginesKey) {
            continue;
        }

        try {
            const size = new TextEncoder().encode(`${key}=${value}`).byteLength;
            if (size > 4000) throw new Error(`Cookie is too large (${size} bytes).`);

            cookies.set(key, value, { path: "/", sameSite: "Lax" });
            if (cookies.get(key) !== value) {
                throw new Error("Browser did not retain the requested cookie value.");
            }
        } catch (error) {
            failures.push(`${key}: ${error.message}`);
        }
    }

    return failures;
}

function importPreferences(full) {
    const savedCookies = readSavedCookies();
    const savedEngines = full ? readSavedEngineStates() : readSavedEngineOverrides(savedCookies);
    const failures = writeCookies(savedCookies);

    if (failures.length > 0) {
        console.error(`${lprefix} Import failed:`, failures);
        throw new Error(`Some cookies could not be imported:\n${failures.join("\n")}`);
    }

    if (savedEngines.length > 0) {
        // Reload first so the form reflects the imported non-engine settings.
        // Then submit the real SearXNG engine form, letting each instance
        // calculate its own default-relative engine cookies.
        sessionStorage.setItem(pendingImportKey, JSON.stringify(savedEngines));
    }

    window.location.reload();
}

function resumeEngineImport() {
    const pending = sessionStorage.getItem(pendingImportKey);
    if (pending == null) return;
    sessionStorage.removeItem(pendingImportKey);

    try {
        const states = new Map(JSON.parse(pending).map(e => [e.engine, e.enabled]));
        const checkboxes = getEngineCheckboxes();
        const form = document.querySelector('form#search_form');
        if (checkboxes.length === 0 || form == null) {
            throw new Error("Could not find the engine checkboxes or preferences form.");
        }

        let changed = 0;
        let matched = 0;
        for (const checkbox of checkboxes) {
            const engine = engineKeyFromInputName(checkbox.name);
            if (!states.has(engine)) continue;

            matched++;
            const checked = !states.get(engine);
            if (checkbox.checked !== checked) changed++;
            checkbox.checked = checked;
        }

        if (matched === 0) throw new Error("No saved engines exist on this instance.");
        console.info(`${lprefix} Applying ${matched} engine states (${changed} changed); submitting SearXNG's preferences form.`);
        form.requestSubmit();
    } catch (error) {
        console.error(`${lprefix} Engine import failed:`, error);
        window.alert(`Engine import failed: ${error.message}`);
    }
}

function runMenuAction(action) {
    try {
        action();
    } catch (error) {
        console.error(`${lprefix}`, error);
        window.alert(`${lprefix} ${error.message}`);
    }
}

GM_registerMenuCommand("📤 Export Preferences", () => runMenuAction(exportPreferences));
GM_registerMenuCommand("📥 Import Preferences", () => runMenuAction(() => importPreferences(false)));
GM_registerMenuCommand("📥 Import Preferences (full)", () => runMenuAction(() => importPreferences(true)));
GM_registerMenuCommand("Print current engine configuration", () => console.log(getCurrentEngineConfig()));

resumeEngineImport();
