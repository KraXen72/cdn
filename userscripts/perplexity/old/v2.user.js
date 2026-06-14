// ==UserScript==
// @name         Auto-send for Perplexity
// @namespace    https://docs.scriptcat.org/
// @version      0.2.0
// @description  Configure model/thinking from URL and submit quickly.
// @author       KraXen72
// @match        https://www.perplexity.ai/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=www.perplexity.ai
// @license      AGPL-3.0-or-later
// @grant        none
// @noframes
// ==/UserScript==
"use strict";

const params = new URLSearchParams(window.location.search);

const requestedQuery = params.get("us_query") ?? "";
const requestedModel = params.get("us_model") ?? "";
const requestedThinking = parseBooleanParam(params.get("thinking"));

// examples: vivaldi custom search engines: (preserve these comments verbatim!)
// https://www.perplexity.ai/search/i-have-this-script-for-claude-PKtS.2_oROC6fRIV930_kg

// https://www.perplexity.ai/?us_query=%s&us_model=claude&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=claude&thinking=true

// https://www.perplexity.ai/?us_query=%s&us_model=gpt&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=gpt&thinking=true

// https://www.perplexity.ai/?us_query=%s&us_model=kimi&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=kimi&thinking=true

// https://ac.duckduckgo.com/ac/?q=%s&type=list

// Keep this as the single source of truth for URL aliases.
// Keys are normalized incoming values; values are the UI label shown in the model menu.
const MODEL_LABELS = {
    gpt54: "GPT-5.4",
    gpt_54: "GPT-5.4",
    claude46sonnet: "Claude Sonnet 4.6",
    claude_46_sonnet: "Claude Sonnet 4.6",
    gemini31pro: "Gemini 3.1 Pro",
    gemini_31_pro: "Gemini 3.1 Pro",
    kimi_k26: "Kimi K2.6",
    kimik26: "Kimi K2.6",
    nemotron3ultra: "Nemotron 3 Ultra",
    nemotron_3_ultra: "Nemotron 3 Ultra",
    sonar2: "Sonar 2",
    best: "Best",
};

const SELECTORS = {
    composer: '[data-ask-input-container]',
    submitButton: 'button[aria-label="Submit"]',
    modelTrigger: 'button[aria-haspopup="menu"]',
    menu: '[role="menu"]',
    selectedRadio: '[role="menuitemradio"][aria-checked="true"]',
    modelItems: '[role="menuitemradio"]',
    thinkingSwitch: '[role="switch"]',
};

let runStarted = false;

main().catch((error) => {
    console.error("[Auto-send for Perplexity] fatal error", error);
});

/**
 * Main orchestration flow.
 *
 * The flow is intentionally linear:
 * 1. wait for the composer shell,
 * 2. fill the query if present,
 * 3. fast-path if the trigger already matches,
 * 4. otherwise open the menu and mutate only what is needed,
 * 5. submit once state is verified.
 */
async function main() {
    if (runStarted) return;
    runStarted = true;

    if (!requestedQuery.trim()) {
        console.info("[Auto-send for Perplexity] no us_query provided; exiting.");
        return;
    }

    const composer = await waitForSelector(SELECTORS.composer, { timeout: 8000 });
    const submitButton = await waitForSelector(SELECTORS.submitButton, { root: composer, timeout: 8000 });

    setComposerQuery(composer, requestedQuery);

    const target = resolveRequestedTarget(requestedModel, requestedThinking);
    if (!target) {
        console.warn("[Auto-send for Perplexity] requested model could not be resolved; submitting without model changes.");
        submitButton.click();
        return;
    }

    const removeAutomationStyle = installAutomationStyle();
    try {
        const trigger = await waitForModelTrigger(composer);

        if (triggerMatchesTarget(trigger, target)) {
            submitButton.click();
            return;
        }

        const menu = await openModelMenu(trigger);
        const current = readOpenMenuState(menu);

        if (!stateMatchesTarget(current, target)) {
            await configureMenuState(menu, target);
        }

        await waitForTriggerState(trigger, target, { timeout: 1200 });
        submitButton.click();
    } finally {
        removeAutomationStyle();
    }
}

/**
 * Converts common URL boolean spellings into a boolean.
 *
 * Missing values default to false so the caller can treat the
 * parameter as opt-in.
 */
function parseBooleanParam(value) {
    if (value == null) return false;
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "false" && normalized !== "off" && normalized !== "0";
}

/**
 * Normalizes the requested model and thinking flag into the label/state
 * that the UI should end up showing.
 */
function resolveRequestedTarget(modelParam, thinking) {
    const normalizedKey = normalizeKey(modelParam);
    const baseLabel = MODEL_LABELS[normalizedKey];
    if (!baseLabel) return null;

    return {
        baseLabel,
        thinking: Boolean(thinking),
        triggerLabel: thinking ? `${baseLabel} Thinking` : baseLabel,
    };
}

function normalizeKey(value) {
    return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Waits for the model trigger within the current composer.
 *
 * The query is scoped to the composer first to avoid scanning unrelated
 * parts of the page on every retry.
 */
async function waitForModelTrigger(composer) {
    return waitForSelector(SELECTORS.modelTrigger, {
        root: composer,
        timeout: 5000,
    });
}

/**
 * Waits for a selector using a MutationObserver rather than fixed sleeps.
 *
 * This resolves as soon as the target becomes observable in the DOM.
 * Attribute observation is enabled because the menu and switch state
 * are exposed through aria attributes.
 */
function waitForSelector(selector, options = {}) {
    const {
        root = document,
        timeout = 2000,
        attributeFilter = ["aria-checked", "aria-expanded", "data-state"],
    } = options;

    return new Promise((resolve, reject) => {
        const initial = root.querySelector(selector);
        if (initial) {
            resolve(initial);
            return;
        }

        const observedRoot = root === document ? document.documentElement : root;

        const observer = new MutationObserver(() => {
            const found = root.querySelector(selector);
            if (!found) return;

            observer.disconnect();
            clearTimeout(timer);
            resolve(found);
        });

        observer.observe(observedRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter,
        });

        const timer = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timeout waiting for selector: ${selector}`));
        }, timeout);
    });
}

/**
 * Sets the ask input contents in the most direct safe way available.
 *
 * Perplexity's composer is contenteditable-based, so we target the first
 * contenteditable element inside the composer and emit an input event to
 * let the app sync its internal state.
 */
function setComposerQuery(composer, query) {
    const editable = composer.querySelector('[contenteditable="true"]');
    if (!editable) {
        throw new Error("Could not find contenteditable ask input.");
    }

    editable.focus();

    const text = query.trim();
    editable.textContent = text;
    editable.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
    }));
}

/**
 * Fast-path check based on the trigger's exposed label/text.
 *
 * If the label already matches the requested end state, we skip opening
 * the menu entirely.
 */
function triggerMatchesTarget(trigger, target) {
    return readTriggerLabel(trigger) === target.triggerLabel;
}

function readTriggerLabel(trigger) {
    return (
        trigger?.getAttribute("aria-label") ||
        trigger?.textContent ||
        ""
    ).trim();
}

/**
 * Opens the model menu and resolves once the menu portal is present.
 */
async function openModelMenu(trigger) {
    if (trigger.getAttribute("aria-expanded") !== "true") {
        trigger.click();
    }

    return waitForSelector(SELECTORS.menu, {
        root: document,
        timeout: 1200,
        attributeFilter: ["aria-expanded", "data-state"],
    });
}

/**
 * Reads the currently selected model and Thinking state from the open menu.
 *
 * This lets the script mutate only the settings that are actually wrong.
 */
function readOpenMenuState(menu) {
    const selected = menu.querySelector(SELECTORS.selectedRadio);
    const thinkingSwitch = menu.querySelector(SELECTORS.thinkingSwitch);

    return {
        selectedLabel: normalizeText(selected?.textContent ?? ""),
        thinking: thinkingSwitch?.getAttribute("aria-checked") === "true",
    };
}

function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
}

function stateMatchesTarget(state, target) {
    return (
        normalizeText(state.selectedLabel) === target.baseLabel &&
        state.thinking === target.thinking
    );
}

/**
 * Applies the minimum required changes to the open menu.
 *
 * Model selection is done before Thinking because the available switch
 * state may depend on the selected base model.
 */
async function configureMenuState(menu, target) {
    const current = readOpenMenuState(menu);

    if (normalizeText(current.selectedLabel) !== target.baseLabel) {
        const item = findModelMenuItem(menu, target.baseLabel);
        if (!item) {
            throw new Error(`Could not find model menu item for "${target.baseLabel}"`);
        }

        item.click();

        await waitForAttributeValue(item, "aria-checked", "true", { timeout: 1000 });

        // Some menus close after selecting a radio item. Reopen if needed.
        if (!document.querySelector(SELECTORS.menu)) {
            const trigger = await waitForSelector(SELECTORS.modelTrigger, {
                root: document.querySelector(SELECTORS.composer) ?? document,
                timeout: 1000,
            });
            menu = await openModelMenu(trigger);
        }
    }

    const refreshedState = readOpenMenuState(menu);
    if (refreshedState.thinking !== target.thinking) {
        const switchEl = menu.querySelector(SELECTORS.thinkingSwitch);
        if (!switchEl) {
            throw new Error("Thinking switch is not available for the selected model.");
        }

        switchEl.click();
        await waitForAttributeValue(switchEl, "aria-checked", String(target.thinking), { timeout: 1000 });
    }
}

function findModelMenuItem(menu, label) {
    const items = [...menu.querySelectorAll(SELECTORS.modelItems)];
    return items.find((item) => normalizeText(item.textContent ?? "") === label) ?? null;
}

/**
 * Waits for a single element attribute to reach an expected value.
 */
function waitForAttributeValue(element, attribute, expectedValue, options = {}) {
    const { timeout = 1000 } = options;

    return new Promise((resolve, reject) => {
        if (element.getAttribute(attribute) === expectedValue) {
            resolve();
            return;
        }

        const observer = new MutationObserver(() => {
            if (element.getAttribute(attribute) !== expectedValue) return;

            observer.disconnect();
            clearTimeout(timer);
            resolve();
        });

        observer.observe(element, {
            attributes: true,
            attributeFilter: [attribute],
        });

        const timer = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timeout waiting for ${attribute}=${expectedValue}`));
        }, timeout);
    });
}

/**
 * Verifies the final trigger label before submit.
 *
 * This is the final guard that keeps the fast path honest.
 */
function waitForTriggerState(trigger, target, options = {}) {
    const { timeout = 1200 } = options;

    return new Promise((resolve, reject) => {
        if (triggerMatchesTarget(trigger, target)) {
            resolve();
            return;
        }

        const observer = new MutationObserver(() => {
            if (!triggerMatchesTarget(trigger, target)) return;

            observer.disconnect();
            clearTimeout(timer);
            resolve();
        });

        observer.observe(trigger, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ["aria-label", "aria-expanded"],
        });

        const timer = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Trigger did not reach requested state: ${target.triggerLabel}`));
        }, timeout);
    });
}

/**
 * Temporarily disables transitions in the small part of the UI that the
 * script manipulates.
 *
 * The style is removed in a finally block so it does not leak into the
 * rest of the session.
 */
function installAutomationStyle() {
    const existing = document.getElementById("pplx-auto-send-speed");
    if (existing) {
        return () => existing.remove();
    }

    const style = document.createElement("style");
    style.id = "pplx-auto-send-speed";
    style.textContent = `
      [data-ask-input-container] button[aria-haspopup="menu"],
      [role="menu"],
      [role="menu"] *,
      [role="switch"] {
        transition-duration: 0ms !important;
        animation-duration: 0ms !important;
        animation-delay: 0ms !important;
      }
    `;

    document.head.appendChild(style);
    return () => style.remove();
}
