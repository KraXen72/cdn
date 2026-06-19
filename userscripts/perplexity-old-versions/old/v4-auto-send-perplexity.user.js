// ==UserScript==
// @name         Auto-send for Perplexity
// @namespace    https://docs.scriptcat.org/
// @version      0.5.0
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

const requestedQuery    = params.get("us_query")   ?? "";
const requestedModel    = params.get("us_model")   ?? "";
const requestedThinking = parseBooleanParam(params.get("thinking"));

// examples: vivaldi custom search engines (preserve these comments verbatim!)
// https://www.perplexity.ai/?us_query=%s&us_model=claude&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=claude&thinking=true
// https://www.perplexity.ai/?us_query=%s&us_model=gpt&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=gpt&thinking=true
// https://www.perplexity.ai/?us_query=%s&us_model=kimi&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=kimi&thinking=true
// https://ac.duckduckgo.com/ac/?q=%s&type=list

// Single source of truth for URL aliases.
// Keys are normalized incoming values; values are the UI label in the model menu.
const MODEL_LABELS = {
  gpt:               "GPT-5.4",
  gpt54:             "GPT-5.4",
  gpt_54:            "GPT-5.4",

  claude:            "Claude Sonnet 4.6",
  claude46sonnet:    "Claude Sonnet 4.6",
  claude_46_sonnet:  "Claude Sonnet 4.6",

  gemini:            "Gemini 3.1 Pro",
  gemini31pro:       "Gemini 3.1 Pro",
  gemini_31_pro:     "Gemini 3.1 Pro",

  kimi:              "Kimi K2.6",
  kimi_k26:          "Kimi K2.6",
  kimik26:           "Kimi K2.6",

  nemotron:          "Nemotron 3 Ultra",
  nemotron3ultra:    "Nemotron 3 Ultra",
  nemotron_3_ultra:  "Nemotron 3 Ultra",

  sonar:             "Sonar 2",
  sonar2:            "Sonar 2",

  best:              "Best",
};

const KNOWN_MODEL_LABELS = [...new Set(Object.values(MODEL_LABELS))];

// ─── Selectors ────────────────────────────────────────────────────────────────
// The model-picker trigger lives INSIDE [data-ask-input-container].
// The [role="menu"] portal is rendered at document.body level by Radix — NOT inside the composer.
// The Thinking item is role="menuitemcheckbox"; the actual toggle switch sits inside it.
const SEL = {
  composer:         '[data-ask-input-container]',
  editable:         '[contenteditable="true"]',
  submitButton:     'button[aria-label="Submit"]',
  // The model trigger: a menu-trigger button inside the composer that is NOT the submit button
  menuTrigger:      'button[aria-haspopup="menu"]',
  // Menu portal — queried on document, not composer
  menu:             '[role="menu"]',
  modelRadios:      '[role="menuitemradio"]',
  selectedRadio:    '[role="menuitemradio"][aria-checked="true"]',
  // Thinking row: menuitemcheckbox contains the label "Thinking" and a role="switch" inside
  thinkingCheckbox: '[role="menuitemcheckbox"]',
  thinkingSwitch:   '[role="menuitemcheckbox"] [role="switch"]',
};

// ─── Entry point ──────────────────────────────────────────────────────────────
let runStarted = false;
main().catch((err) => console.error("[Auto-send for Perplexity] fatal error", err));

async function main() {
  if (runStarted) return;
  runStarted = true;

  if (!requestedQuery.trim()) {
    console.info("[Auto-send for Perplexity] no us_query — exiting.");
    return;
  }

  // 1. Wait for the composer shell
  const composer = await waitForComposer(10_000);

  // 2. Fill the query
  await waitForElement(SEL.editable, composer, 10_000);
  setComposerQuery(composer, requestedQuery);

  // 3. Resolve target model
  const target = resolveTarget(requestedModel, requestedThinking);
  if (!target) {
    console.warn("[Auto-send for Perplexity] unknown model alias — submitting without model change.");
    const btn = await waitForElement(SEL.submitButton, composer, 8_000);
    btn.click();
    return;
  }

  const removeStyle = installSpeedStyle();
  try {
    // 4. Find the model trigger (scoped to composer)
    const trigger = await waitForModelTrigger(composer, 8_000);

    if (!triggerMatchesTarget(trigger, target)) {
      // 5. Open the menu (portal lives on document.body, not inside composer)
      const menu = await openModelMenu(trigger, target);

      // 6. Configure model + thinking
      await configureMenu(menu, trigger, target);

      // 7. Wait for trigger label to reflect new state
      await waitForTriggerLabel(trigger, target.triggerLabel, 3_000);
    }

    // 8. Submit
    const submitBtn = await waitForElement(SEL.submitButton, composer, 5_000);
    submitBtn.click();
    console.log("[Auto-send for Perplexity] submitted with", target.triggerLabel);
  } finally {
    removeStyle();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseBooleanParam(value) {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "false" && v !== "off" && v !== "0";
}

function resolveTarget(modelParam, thinking) {
  const key = normalizeKey(modelParam);
  const baseLabel = MODEL_LABELS[key];
  if (!baseLabel) return null;
  return {
    baseLabel,
    thinking: Boolean(thinking),
    triggerLabel: thinking ? `${baseLabel} Thinking` : baseLabel,
  };
}

function normalizeKey(v) {
  return (v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function normText(el) {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── DOM waiting ──────────────────────────────────────────────────────────────

/** Wait for a selector relative to `root`. Root defaults to document. */
function waitForElement(selector, root = document, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const initial = (root === document ? document : root).querySelector(selector);
    if (initial) return resolve(initial);

    const observeRoot = root === document ? document.documentElement : root;
    const obs = new MutationObserver(() => {
      const el = (root === document ? document : root).querySelector(selector);
      if (!el) return;
      obs.disconnect();
      clearTimeout(timer);
      resolve(el);
    });
    obs.observe(observeRoot, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["aria-checked", "aria-expanded", "data-state"] });

    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error(`Timeout waiting for selector: ${selector}`));
    }, timeout);
  });
}

/** Wait for the composer; returns the first one with a contenteditable or submit button. */
async function waitForComposer(timeout) {
  const pick = () => {
    const all = [...document.querySelectorAll(SEL.composer)];
    return (
      all.find((el) => el.querySelector(SEL.editable)) ??
      all.find((el) => el.querySelector(SEL.submitButton)) ??
      all[0] ?? null
    );
  };

  const fast = pick();
  if (fast) return fast;

  await waitForElement(SEL.composer, document, timeout);
  const found = pick();
  if (!found) throw new Error("No active composer found.");
  return found;
}

/**
 * Find the model trigger button inside the composer.
 * It is a button[aria-haspopup="menu"] that is NOT the submit button and
 * whose label looks like a known model (or "Model" / "Orchestrator").
 */
function findModelTrigger(composer) {
  const buttons = [...composer.querySelectorAll(SEL.menuTrigger)];
  for (const btn of buttons) {
    if (btn.matches(SEL.submitButton)) continue;
    const label = btn.getAttribute("aria-label") ?? normText(btn);
    if (!label) continue;
    // Accept if it matches a known label, ends with "Thinking", or is a generic placeholder
    if (
      KNOWN_MODEL_LABELS.includes(label) ||
      KNOWN_MODEL_LABELS.some((l) => label.includes(l)) ||
      label.endsWith(" Thinking") ||
      label === "Model" ||
      label === "Orchestrator"
    ) {
      return btn;
    }
  }
  return null;
}

async function waitForModelTrigger(composer, timeout) {
  const fast = findModelTrigger(composer);
  if (fast) return fast;

  // Poll + observe within the composer
  return new Promise((resolve, reject) => {
    const obs = new MutationObserver(() => {
      const el = findModelTrigger(composer);
      if (!el) return;
      obs.disconnect();
      clearTimeout(timer);
      resolve(el);
    });
    obs.observe(composer, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["aria-label", "aria-haspopup"] });

    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error(`Timeout waiting for selector: ${SEL.menuTrigger}`));
    }, timeout);
  });
}

function triggerMatchesTarget(trigger, target) {
  const label = trigger.getAttribute("aria-label") ?? normText(trigger);
  return label.trim() === target.triggerLabel;
}

// ─── Menu handling ────────────────────────────────────────────────────────────

/**
 * The Radix menu portal is appended to document.body, NOT inside the composer.
 * We confirm it's the model menu by checking for menuitemradio children with known labels.
 */
function isModelMenu(menuEl) {
  if (!menuEl?.isConnected) return false;
  const items = [...menuEl.querySelectorAll(SEL.modelRadios)];
  return items.some((item) => {
    const span = item.querySelector("[translate='no']");
    const label = normText(span ?? item);
    return KNOWN_MODEL_LABELS.some((l) => label.includes(l));
  });
}

function findOpenModelMenu() {
  return [...document.querySelectorAll(SEL.menu)].find(isModelMenu) ?? null;
}

async function waitForModelMenu(timeout = 2000) {
  const fast = findOpenModelMenu();
  if (fast) return fast;

  return new Promise((resolve, reject) => {
    const obs = new MutationObserver(() => {
      const m = findOpenModelMenu();
      if (!m) return;
      obs.disconnect();
      clearTimeout(timer);
      resolve(m);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error("Timeout waiting for selector: [role=\"menu\"]"));
    }, timeout);
  });
}

async function openModelMenu(trigger, target) {
  const existing = findOpenModelMenu();
  if (existing) return existing;

  const strategies = [
    () => trigger.click(),
    () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown",
        { key: "Enter", bubbles: true, cancelable: true }));
    },
    () => {
      const r = trigger.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
      trigger.dispatchEvent(new PointerEvent("pointerdown", opts));
      trigger.dispatchEvent(new PointerEvent("pointerup", opts));
      trigger.dispatchEvent(new MouseEvent("click", opts));
    },
  ];

  for (const go of strategies) {
    go();
    try { return await waitForModelMenu(1_500); } catch { /* try next */ }
    await sleep(80);
  }

  throw new Error('Timeout waiting for selector: [role="menu"]');
}

// ─── Menu state read/write ────────────────────────────────────────────────────

function getModelItemLabel(item) {
  // Labels are inside <span translate="no"> per the HTML dump
  const span = item.querySelector("[translate='no']");
  if (span) return normText(span);
  // Fall back to first matching known label in full text
  const full = normText(item);
  return KNOWN_MODEL_LABELS.find((l) => full.includes(l)) ?? full;
}

function readMenuState(menu) {
  const selected = menu.querySelector(SEL.selectedRadio);
  // Thinking: menuitemcheckbox with aria-checked="true" whose text includes "Thinking"
  const thinkingRow = [...menu.querySelectorAll(SEL.thinkingCheckbox)]
    .find((el) => normText(el).includes("Thinking"));
  const thinkingSwitch = thinkingRow?.querySelector('[role="switch"]') ?? null;

  return {
    selectedLabel: selected ? getModelItemLabel(selected) : "",
    thinking: thinkingSwitch?.getAttribute("aria-checked") === "true",
    thinkingSwitch,
  };
}

async function configureMenu(menu, trigger, target) {
  let m = menu;
  const state = readMenuState(m);

  // ── Step 1: select the right base model if needed ──
  if (state.selectedLabel !== target.baseLabel) {
    const items = [...m.querySelectorAll(SEL.modelRadios)];
    const item = items.find((el) => getModelItemLabel(el) === target.baseLabel);
    if (!item) throw new Error(`Model item "${target.baseLabel}" not found in menu.`);

    item.click();

    // The menu might close after selection; wait for aria-checked or re-open
    try {
      await waitForAttr(item, "aria-checked", "true", 1_500);
    } catch {
      // menu closed — re-open
      m = await openModelMenu(trigger, target);
    }

    // If menu closed and we needed to re-open, also re-read state for thinking
    if (!m.isConnected) m = await openModelMenu(trigger, target);
  }

  // ── Step 2: set thinking toggle if needed ──
  const refreshed = readMenuState(m);
  if (refreshed.thinking !== target.thinking) {
    const sw = refreshed.thinkingSwitch;
    if (!sw) {
      if (target.thinking) throw new Error("Thinking switch not available for this model.");
      return; // thinking=false and no switch = already off
    }
    sw.click();
    await waitForAttr(sw, "aria-checked", String(target.thinking), 1_500);
  }
}

function waitForAttr(el, attr, expected, timeout = 1500) {
  return new Promise((resolve, reject) => {
    if (el.getAttribute(attr) === expected) return resolve();
    const obs = new MutationObserver(() => {
      if (el.getAttribute(attr) !== expected) return;
      obs.disconnect();
      clearTimeout(timer);
      resolve();
    });
    obs.observe(el, { attributes: true, attributeFilter: [attr] });
    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error(`Timeout waiting for ${attr}=${expected}`));
    }, timeout);
  });
}

function waitForTriggerLabel(trigger, expectedLabel, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const check = () => (trigger.getAttribute("aria-label") ?? normText(trigger)).trim() === expectedLabel;
    if (check()) return resolve();
    const obs = new MutationObserver(() => {
      if (!check()) return;
      obs.disconnect();
      clearTimeout(timer);
      resolve();
    });
    obs.observe(trigger, { attributes: true, subtree: true, childList: true,
      attributeFilter: ["aria-label"] });
    const timer = setTimeout(() => {
      obs.disconnect();
      // Non-fatal: trigger may not update immediately in all cases
      console.warn(`[Auto-send for Perplexity] trigger label did not reach "${expectedLabel}" — submitting anyway.`);
      resolve();
    }, timeout);
  });
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

function setComposerQuery(composer, query) {
  const el = composer.querySelector(SEL.editable);
  if (!el) throw new Error("contenteditable not found inside composer.");
  el.focus();
  el.textContent = query.trim();
  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true,
    inputType: "insertText", data: query.trim() }));
}

function installSpeedStyle() {
  const id = "pplx-auto-send-speed";
  document.getElementById(id)?.remove();
  const s = document.createElement("style");
  s.id = id;
  s.textContent = `
[data-ask-input-container] button[aria-haspopup="menu"],
[role="menu"], [role="menu"] *, [role="switch"], [role="menuitemcheckbox"] {
  transition-duration: 0ms !important;
  animation-duration: 0ms !important;
  animation-delay: 0ms !important;
}`;
  document.head.appendChild(s);
  return () => s.remove();
}
