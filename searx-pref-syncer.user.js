// ==UserScript==
// @name         SearXNG Preference Syncer
// @namespace    http://tampermonkey.net
// @version      2.3
// @description  Sync SearXNG preferences between instances
// @author       You
// @match        https://searx.tiekoetter.com/preferences
// @match        https://search.rhscz.eu/preferences
// @match        https://searx.rhscz.eu/preferences
// @match        https://searx.oloke.xyz/preferences
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/js-cookie@3.0.8/dist/js.cookie.min.js
// ==/UserScript==

const blacklist = [
    "method",
    "captcha_token",
    "tokens"
]
const resetCookiesMessage = "Have you reset all the preferences to default? It's necessary for a full import to do so. Otherwise, do the normal import.";

const gm_cookiesPrefKey = "searxCookies"
const gm_enabledEnginesPrefKey = "searxCookies_enabledEngines"
const gm_enabledEnginesPrefKeyCookie = "searxCookies_enabledEngines_cookie"

const gm_disabledEnginesPrefKey = "searxCookies_disabledEngines"
const gm_disabledEnginesPrefKeyCookie = "searxCookies_disabledEngines_cookie"

const cookies_enabledEnginesKey = "enabled_engines";
const cookies_disabledEnginesKey = "disabled_engines";

const lprefix = "[SearXNG Preference Syncer]:"

const checkSelectMap = new Map(Object.entries({
    "favicon_resolver": `select[name="favicon_resolver"]`
}));

/** js-cookie library global object, created by initCookies() */
let cookies;

/** set up the 'cookies' global object for cookie manipulation */
function initCookies() {
    if (cookies != null) return;
    cookies = Cookies.withConverter({
        read: function (value, name) {
            const decodedValue = Cookies.converter.read(value, name);
            return decodedValue.replace(/\\054/g, ',');
        },
        write: function (value, name) {
            // Decodes URL-encoded parts back to raw characters (like spaces and commas)
            return decodeURIComponent(value);
        }
    });
}

/**
 * check, whether a given select element has a particular string in one of it's options
 * e.g. if the favicon_resolver on this instance has the option "google"
 * @param {string} selector
 * @param {string} query
 */
function checkSelectHasOption(selector, query) {
    const sel = document.querySelector(selector);
    if (sel == null) return false;
    if (sel?.options == null || sel.options.length === 0) return false;
    const stringOptions = Array.from(sel?.options)
        .map(opt => opt.textContent.trim().toLowerCase());
    
    return stringOptions.some(opt => opt.trim() === query.trim())
}

/**
 * use DOM traversal to get all the curren engine options (~300) as { engine: string, enabled: boolean }
 * engine names have to be "fixed"/normalized to match the cookie names: replace _ for spaces, keep the final __ category divider
 */
function getCurrentEngineConfig() {
    const tabs = document.querySelector(".tabs");
    const section = tabs.querySelector("section#tab-content-engines")
    const tables = Array.from(section.querySelectorAll(`table.table_engines`))

    const items = tables
        .map(t => Array.from(t.querySelectorAll(`tr:has(input[type="checkbox"])`))).flat()
        .map(row => {
            const label = row.querySelector(`label[for^="engine_"]`)
            const engine = label != null ? (label.getAttribute("for") || "").replace("engine_", "") : null;

            const checkbox = row.querySelector(`input[type="checkbox"]`);

            // for some reason, _enabled_ engines have an _unchecked_ checkbox...
            const enabled = checkbox != null && !checkbox.checked;

            return { engine, enabled }
        })
        .filter(item => item.engine);

    return items;
}

/** @typedef {{ engine: string, enabled: boolean }} EnginePair */

/**
 * create a {
 *  enabledEngines: { engine: string, enabled: boolean }[],
 *  disabledEngines: { engine: string, enabled: boolean }[]
 * }
 * normalizes engine names to match the cookie keys
 */
function constructEnginePrefs() {
    const currentState = getCurrentEngineConfig();
    console.log(currentState);

    const enabledEngines = currentState
        .filter(engine => engine.enabled)
        .map(convertLabelForsToCookieKeys)

    const disabledEngines = currentState
        .filter(engine => !engine.enabled)
        .map(convertLabelForsToCookieKeys)

    return {
        disabledEngines,
        enabledEngines
    };
}

/** split, but from the right. e.g. for some__value__last -> some__value, last (split on "__") */
const splitRight = (str, sep, i = str.lastIndexOf(sep)) =>
    i === -1 ? [str] : [str.slice(0, i), str.slice(i + sep.length)];

function convertLabelForsToCookieKeys(obj) {
    const parts = splitRight(obj.engine, "__");
    if (parts.length < 2) return obj; // no __ found, return as-is

    const newName = parts[0].replaceAll("_", " ");
    return {
        engine: newName + "__" + parts[1],
        enabled: obj.enabled
    };
}

/**
 * calculate the delta, what needs changing from default settings to apply our preferences.
 * @param {EnginePair[]} inputEngineList
 * @param {EnginePair[]} currentEngineList
 * @returns {{ enabledEngines: EnginePair[], disabledEngines: EnginePair[], enabledEnginesCookie: string, disabledEnginesCookie: string }}
 */
function cookieDelta(inputEngineList, currentEngineList) {
    let delta = new Map();
    console.log(`${lprefix} diffing`, inputEngineList, currentEngineList);

    for (const enginePair of inputEngineList) {
        if (delta.has(enginePair.engine)) {
            console.warn(`${lprefix} duplicate engine in input list, skipping: "${enginePair.engine}"`);
            continue;
        }
        delta.set(enginePair.engine, enginePair.enabled);
    }

    for (const enginePair of currentEngineList) {
        if (delta.has(enginePair.engine) && delta.get(enginePair.engine) === enginePair.enabled) {
            delta.delete(enginePair.engine);
        }
    }
    let resultObj = {
        enabledEngines: [],
        disabledEngines: []
    }
    for (const [key, value] of delta) {
        if (value) {
            resultObj.enabledEngines.push({ engine: key, enabled: value });
        } else {
            resultObj.disabledEngines.push({ engine: key, enabled: value });
        }
    }

    console.log(delta, resultObj);
    resultObj = {
        ...resultObj,
        disabledEnginesCookie: resultObj.disabledEngines.map(e => e.engine).join(","),
        enabledEnginesCookie: resultObj.enabledEngines.map(e => e.engine).join(",")
    }

    return resultObj;   
}

/** 
 * takes the base cookie key-val store and possible, 
 * swaps the enabled__engines and disabled__engines for the minimal delta between
 * (this instance's defaults) <-> (our stored preferences)
*/
function enrichCookieList(base) {
    const _enabledRaw = GM_getValue(gm_enabledEnginesPrefKey, null);
    const _disabledRaw = GM_getValue(gm_disabledEnginesPrefKey, null);
    if (_enabledRaw == null || _disabledRaw == null) return base;
    let _enabled, _disabled;
    try {
        _enabled = JSON.parse(_enabledRaw);
        _disabled = JSON.parse(_disabledRaw);
    } catch (e) {
        console.error(`${lprefix} couldn't parse the enabled/disabled JSON values from script storage`);
        console.error(`${lprefix}`, _enabledRaw, _disabledRaw);
        return base;
    }

    const currentState = constructEnginePrefs();

    // get back a new object with the deltas & cookie strings, which can be assigned to the cookie key-val dict.
    const delta = cookieDelta([
        ..._enabled,
        ..._disabled
    ], [
        ...currentState.enabledEngines,
        ...currentState.disabledEngines
    ])

    const enriched = structuredClone(base);
    if (delta.enabledEnginesCookie) {
        enriched[cookies_enabledEnginesKey] = delta.enabledEnginesCookie;
    }
    if (delta.disabledEnginesCookie) {
        enriched[cookies_disabledEnginesKey] = delta.disabledEnginesCookie;
    }

    return enriched;
}

/** make sure to call initCookies()! */
function setCookieWithWarning(key, value) {
    const cookieStr = `${key}=${value}`;
    if (new TextEncoder().encode(cookieStr).byteLength > 4093) {
        console.warn(`${lprefix} cookie too large to set: ${cookieStr.length} chars`);
    }
    cookies.set(key, value);
}

/**
 * imports cookies into this searx instance.
 * @param {boolean} useFullEngineLists does diffing to correctly set engine preferences. only works if instance's cookies were reset to default & if we have the full exhaustive data.
 */
function importCookies(useFullEngineLists) {
    initCookies();

    const rawStorageData = GM_getValue(gm_cookiesPrefKey, void 0);
    if (!rawStorageData) {
        console.error(`${lprefix} no cookies in storage!`);
        return;
    }
    let cookiesFromStorage;
    try {
        cookiesFromStorage = JSON.parse(rawStorageData)
    } catch (e) {
        console.error(`${lprefix} couldn't parse cookies from storage!`);
        return;
    }

    console.log("retrieved cookies from localstorage, ready to import:")
    console.log(cookiesFromStorage);

    const enrichedCookies = useFullEngineLists && window.confirm(resetCookiesMessage)
        ? enrichCookieList(cookiesFromStorage) 
        : cookiesFromStorage;

    for (const [key, value] of Object.entries(enrichedCookies)) {
        if (checkSelectMap.has(key)) {
            if (checkSelectHasOption(checkSelectMap.get(key), value)) {
                setCookieWithWarning(key, value);
                console.log(`set ${key} to ${value}`);
            } else {
                console.warn(`can't set ${key} to ${value}, no such option in select`);
            }
        } else {
            setCookieWithWarning(key, value);
            console.log(`set ${key} to ${value}`);
        }
    }
}

GM_registerMenuCommand('📤 Export Preferences', () => {
    initCookies();

    const gottenCookies = cookies.get();
    const filteredCookies = Object.fromEntries(
        Object.entries(gottenCookies)
            .filter((e) => !blacklist.includes(e[0]))
    )

    GM_setValue(gm_cookiesPrefKey, JSON.stringify(filteredCookies));
    console.log(`${lprefix} exported (saved to script storage)`, filteredCookies)

    const currentEngineConfig = constructEnginePrefs();
    console.log("current exhaustive engine config:", currentEngineConfig);

    GM_setValue(gm_enabledEnginesPrefKey, JSON.stringify(currentEngineConfig.enabledEngines));
    // GM_setValue(enabledEnginesPrefKeyCookie, currentEngineConfig.enabledEnginesCookie);

    GM_setValue(gm_disabledEnginesPrefKey, JSON.stringify(currentEngineConfig.disabledEngines));
    // GM_setValue(disabledEnginesPrefKeyCookie, currentEngineConfig.disabledEnginesCookie);
});

GM_registerMenuCommand('📥 Import Preferences', () => {
    importCookies(false)
});

GM_registerMenuCommand('📥 Import Preferences (full)', () => {
    importCookies(true)
});

GM_registerMenuCommand("Print current engine configuration", () => {
    console.log(constructEnginePrefs());
})