// ==UserScript==
// @name Auto-send for Perplexity
// @namespace https://docs.scriptcat.org/
// @version 0.8.0
// @description Configure model/thinking from URL and submit quickly.
// @author KraXen72
// @match https://www.perplexity.ai/*
// @icon https://www.google.com/s2/favicons?sz=64&domain=www.perplexity.ai
// @license AGPL-3.0-or-later
// @grant none
// @noframes
// ==/UserScript==

"use strict";

const params = new URLSearchParams(window.location.search);

const requestedQuery   = params.get("us_query") ?? "";
const requestedModel   = params.get("us_model") ?? "";
const hasRequestedQuery    = requestedQuery.trim() !== "";
const hasRequestedModel    = requestedModel.trim() !== "";
const hasRequestedThinking = params.has("thinking");
const requestedThinking    = parseBooleanParam(params.get("thinking"));

// examples: vivaldi custom search engines (preserve these comments verbatim!)
// Format: us_model=<family> or us_model=<family>_<version>
// Family aliases: gpt, claude_sonnet, claude_opus, gemini, kimi, nemotron, sonar, best
// Version suffix uses a dot: us_model=claude_sonnet_4.6  us_model=gpt_5.4
// thinking= true/false/on/off/0/1 (separate param, always)
// https://www.perplexity.ai/?us_query=%s&us_model=claude_sonnet&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=claude_sonnet&thinking=true
// https://www.perplexity.ai/?us_query=%s&us_model=gpt&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=gpt&thinking=true
// https://www.perplexity.ai/?us_query=%s&us_model=kimi
// https://ac.duckduckgo.com/ac/?q=%s&type=list

// Family definitions: map alias words -> the ordered word tokens that must appear in a menu label.
// The resolver reads live menu labels; nothing here is pinned to a specific version.
const MODEL_FAMILIES = {
  best:         ["best"],
  sonar:        ["sonar"],
  gpt:          ["gpt"],
  claude_sonnet:["claude", "sonnet"],
  claude_opus:  ["claude", "opus"],
  gemini:       ["gemini"],
  kimi:         ["kimi"],
  nemotron:     ["nemotron"],
};

const SEL = {
  composer:        "[data-ask-input-container]",
  editable:        '[contenteditable="true"]',
  submitButton:    'button[aria-label="Submit"]',
  menuTrigger:     'button[aria-haspopup="menu"]',
  menu:            '[role="menu"]',
  modelRadios:     '[role="menuitemradio"]',
  selectedRadio:   '[role="menuitemradio"][aria-checked="true"]',
  thinkingCheckbox:'[role="menuitemcheckbox"]',
};

// ── Boot / retry state ────────────────────────────────────────────────────────

// "idle"    – not yet started (or last attempt failed and can be retried)
// "running" – an attempt is currently in progress
// "done"    – succeeded; no further action needed
let bootState = "idle";

function hasWork() {
  return hasRequestedQuery || hasRequestedModel || hasRequestedThinking;
}

async function boot() {
  if (!hasWork() || bootState !== "idle") return;

  bootState = "running";
  try {
    await attempt();
    bootState = "done";
    hydrationObserver.disconnect();
  } catch (err) {
    bootState = "idle";
    console.warn("[Auto-send for Perplexity] retryable failure:", err.message);
  }
}

// Retry whenever the tab becomes visible or regains focus (covers the
// "typed URL, tabbed away, came back" scenario) and on bfcache restore.
document.addEventListener("visibilitychange", () => { if (!document.hidden) boot(); });
window.addEventListener("focus",    boot);
window.addEventListener("pageshow", boot);

// Long-tail fallback: retry on any significant DOM change until done.
const hydrationObserver = new MutationObserver(boot);
hydrationObserver.observe(document.documentElement, { childList: true, subtree: true });

boot();

// ── Core attempt ──────────────────────────────────────────────────────────────

async function attempt() {
  if (!hasWork()) {
    console.info("[Auto-send for Perplexity] nothing requested; exiting.");
    bootState = "done"; // nothing to do is a permanent terminal state
    return;
  }

  const composer = await waitForComposer(10_000);

  if (hasRequestedQuery) {
    await waitForElement(SEL.editable, composer, 10_000);
    setComposerQuery(composer, requestedQuery);
  }

  const target = resolveTarget(requestedModel, requestedThinking, hasRequestedModel, hasRequestedThinking);
  if (target) {
    const removeStyle = installSpeedStyle();
    try {
      const trigger = await waitForModelTrigger(composer, 8_000);
      if (!triggerMatchesTarget(trigger, target)) {
        const menu = await openModelMenu(trigger);
        await configureMenu(menu, trigger, target);
        await waitForTriggerLabel(trigger, target.triggerLabel, 3_000);
      }
    } finally {
      removeStyle();
    }
  } else if (hasRequestedModel || hasRequestedThinking) {
    console.warn("[Auto-send for Perplexity] unknown model alias; skipping model configuration.");
  }

  if (!hasRequestedQuery) {
    await refocusComposerInput(composer);
    console.log("[Auto-send for Perplexity] configured only; waiting for manual input and submit.");
    return;
  }

  const submitButton = await waitForElement(SEL.submitButton, composer, 5_000);
  submitButton.click();
  console.log("[Auto-send for Perplexity] submitted.");
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseBooleanParam(value) {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "false" && normalized !== "off" && normalized !== "0";
}

function normalizeKey(value) {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function normText(value) {
  return (value?.textContent ?? value ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Model param parsing ───────────────────────────────────────────────────────

// Parse "us_model" param into { familyKey, version: [major,minor] | null }.
// Accepted formats: gpt  claude_sonnet  claude_sonnet_4.6  gpt_5.4
// The last token is treated as a version ONLY if it looks like "N.N".
function parseModelParam(raw) {
  const tokens = raw.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "_").replace(/^_|_$/g, "").split("_");
  const last = tokens[tokens.length - 1];
  const versionMatch = /^(\d+)\.(\d+)$/.exec(last);
  const version = versionMatch ? [parseInt(versionMatch[1], 10), parseInt(versionMatch[2], 10)] : null;
  const familyTokens = version ? tokens.slice(0, -1) : tokens;
  return { familyKey: familyTokens.join("_"), version };
}

// Parse a visible menu label like "Claude Sonnet 4.6" into:
// { words: ["claude","sonnet"], version: [4,6] | null }
function parseMenuLabel(label) {
  const words = label.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim().split(/\s+/);
  const last = words[words.length - 1];
  const vm = /^(\d+)\.(\d+)$/.exec(last);
  const version = vm ? [parseInt(vm[1], 10), parseInt(vm[2], 10)] : null;
  const textWords = version ? words.slice(0, -1) : words;
  return { words: textWords, version };
}

// Compare two version tuples [major, minor]; returns negative/0/positive.
function compareVersions(a, b) {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

// Given live menu candidates and a parsed model param, return the best matching
// label string, or null.
function resolveLiveLabel(candidates, familyKey, requestedVersion) {
  const familyWords = MODEL_FAMILIES[familyKey];
  if (!familyWords) return null;

  // Every family word must appear in the candidate word list, in order.
  const matches = candidates.filter(({ parsed }) => {
    let searchFrom = 0;
    for (const fw of familyWords) {
      const idx = parsed.words.indexOf(fw, searchFrom);
      if (idx === -1) return false;
      searchFrom = idx + 1;
    }
    return true;
  });

  if (matches.length === 0) return null;

  if (requestedVersion !== null) {
    const exact = matches.find(({ parsed }) =>
      parsed.version !== null && compareVersions(parsed.version, requestedVersion) === 0
    );
    return exact?.label ?? null;
  }

  const withVersion = matches.filter(({ parsed }) => parsed.version !== null);
  if (withVersion.length > 0) {
    withVersion.sort((a, b) => compareVersions(b.parsed.version, a.parsed.version));
    return withVersion[0].label;
  }

  return matches[0].label;
}

function resolveTarget(modelParam, thinking, hasModel, hasThinking) {
  if (!hasModel) return null;

  const { familyKey, version } = parseModelParam(modelParam);
  if (!MODEL_FAMILIES[familyKey]) {
    console.warn(`[Auto-send for Perplexity] unknown family "${familyKey}" (parsed from "${modelParam}")`);
    return null;
  }

  return {
    familyKey,
    requestedVersion: version,
    thinking: hasThinking ? Boolean(thinking) : null,
    // baseLabel and triggerLabel are resolved live from the open menu.
    baseLabel: null,
    triggerLabel: null,
  };
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function waitForElement(selector, root = document, timeout = 5_000) {
  const query = () => (root === document ? document : root).querySelector(selector);

  return new Promise((resolve, reject) => {
    const initial = query();
    if (initial) { resolve(initial); return; }

    const observedRoot = root === document ? document.documentElement : root;
    const observer = new MutationObserver(() => {
      const found = query();
      if (!found) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(found);
    });

    observer.observe(observedRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "aria-expanded", "data-state", "aria-label"],
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for selector: ${selector}`));
    }, timeout);
  });
}

async function waitForComposer(timeout) {
  const pickComposer = () => {
    const composers = [...document.querySelectorAll(SEL.composer)];
    return composers.find((el) => el.querySelector(SEL.editable))
      ?? composers.find((el) => el.querySelector(SEL.submitButton))
      ?? composers[0]
      ?? null;
  };

  const existing = pickComposer();
  if (existing) return existing;

  await waitForElement(SEL.composer, document, timeout);

  const composer = pickComposer();
  if (!composer) throw new Error("No active composer found.");
  return composer;
}

// ── Model trigger ─────────────────────────────────────────────────────────────

const ALL_FAMILY_WORDS = [...new Set(Object.values(MODEL_FAMILIES).flat())];

function scoreTrigger(button) {
  const label = button.getAttribute("aria-label") ?? normText(button);
  if (!label) return 0;
  if (label === "Model" || label === "Orchestrator") return 2;
  if (label.endsWith(" Thinking")) return 4;
  if (ALL_FAMILY_WORDS.some((w) => label.toLowerCase().includes(w))) return 5;
  return 0;
}

function findModelTrigger(composer) {
  const ranked = [...composer.querySelectorAll(SEL.menuTrigger)]
    .filter((button) => !button.matches(SEL.submitButton))
    .map((button) => ({ button, score: scoreTrigger(button) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.button ?? null;
}

async function waitForModelTrigger(composer, timeout) {
  const existing = findModelTrigger(composer);
  if (existing) return existing;

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const trigger = findModelTrigger(composer);
      if (!trigger) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(trigger);
    });

    observer.observe(composer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-haspopup", "aria-expanded"],
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for selector: ${SEL.menuTrigger}`));
    }, timeout);
  });
}

function triggerMatchesTarget(trigger, target) {
  if (!target) return true;
  const label = trigger.getAttribute("aria-label") ?? normText(trigger);
  return label.trim() === target.triggerLabel;
}

// ── Model menu ────────────────────────────────────────────────────────────────

function isModelMenu(menu) {
  if (!menu?.isConnected) return false;
  return [...menu.querySelectorAll(SEL.modelRadios)].some((item) => {
    const label = getModelItemLabel(item).toLowerCase();
    return ALL_FAMILY_WORDS.some((w) => label.includes(w));
  });
}

function findOpenModelMenu() {
  return [...document.querySelectorAll(SEL.menu)].find(isModelMenu) ?? null;
}

function waitForModelMenu(timeout = 2_000) {
  const existing = findOpenModelMenu();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const menu = findOpenModelMenu();
      if (!menu) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(menu);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timeout waiting for selector: [role="menu"]'));
    }, timeout);
  });
}

async function openModelMenu(trigger) {
  const existing = findOpenModelMenu();
  if (existing) return existing;

  const attempts = [
    () => trigger.click(),
    () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    },
    () => {
      const rect = trigger.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
      trigger.dispatchEvent(new PointerEvent("pointerdown", options));
      trigger.dispatchEvent(new PointerEvent("pointerup",   options));
      trigger.dispatchEvent(new MouseEvent("click",         options));
    },
  ];

  for (const attempt of attempts) {
    attempt();
    try { return await waitForModelMenu(1_500); } catch { await sleep(80); }
  }
  throw new Error('Timeout waiting for selector: [role="menu"]');
}

function getModelItemLabel(item) {
  const explicitLabel = item.querySelector("[translate='no']");
  if (explicitLabel) return normText(explicitLabel);
  return normText(item);
}

function readMenuCandidates(menu) {
  return [...menu.querySelectorAll(SEL.modelRadios)].map((el) => {
    const label = getModelItemLabel(el);
    return { label, parsed: parseMenuLabel(label), element: el };
  });
}

function readMenuState(menu) {
  const selected = menu.querySelector(SEL.selectedRadio);
  const thinkingRow = [...menu.querySelectorAll(SEL.thinkingCheckbox)]
    .find((el) => normText(el).includes("Thinking"));
  const thinkingSwitch = thinkingRow?.querySelector('[role="switch"]') ?? null;

  return {
    selectedLabel: selected ? getModelItemLabel(selected) : "",
    thinking: thinkingSwitch ? thinkingSwitch.getAttribute("aria-checked") === "true" : null,
    thinkingSwitch,
  };
}

async function configureMenu(menu, trigger, target) {
  let currentMenu = menu;

  const candidates = readMenuCandidates(currentMenu);
  const resolvedLabel = resolveLiveLabel(candidates, target.familyKey, target.requestedVersion);
  if (!resolvedLabel) {
    const available = candidates.map((c) => c.label).join(", ");
    throw new Error(`No menu item matched family "${target.familyKey}" (version ${JSON.stringify(target.requestedVersion)}). Available: ${available}`);
  }

  target.baseLabel    = resolvedLabel;
  target.triggerLabel = target.thinking ? `${resolvedLabel} Thinking` : resolvedLabel;

  let state = readMenuState(currentMenu);

  if (state.selectedLabel !== target.baseLabel) {
    const item = candidates.find((c) => c.label === target.baseLabel)?.element ?? null;
    if (!item) throw new Error(`Model item "${target.baseLabel}" not found in menu.`);

    item.click();
    try {
      await waitForAttr(item, "aria-checked", "true", 1_500);
    } catch {
      currentMenu = await openModelMenu(trigger);
    }

    if (!currentMenu.isConnected) currentMenu = await openModelMenu(trigger);
    state = readMenuState(currentMenu);
  }

  if (target.thinking === null || state.thinking === target.thinking) return;

  const { thinkingSwitch } = state;
  if (!thinkingSwitch) throw new Error("Thinking switch not available for this model.");

  thinkingSwitch.click();
  await waitForAttr(thinkingSwitch, "aria-checked", String(target.thinking), 1_500);
}

function waitForAttr(element, attribute, expectedValue, timeout = 1_500) {
  return new Promise((resolve, reject) => {
    if (element.getAttribute(attribute) === expectedValue) { resolve(); return; }

    const observer = new MutationObserver(() => {
      if (element.getAttribute(attribute) !== expectedValue) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });

    observer.observe(element, { attributes: true, attributeFilter: [attribute] });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for ${attribute}=${expectedValue}`));
    }, timeout);
  });
}

function waitForTriggerLabel(trigger, expectedLabel, timeout = 3_000) {
  const hasExpectedLabel = () =>
    (trigger.getAttribute("aria-label") ?? normText(trigger)).trim() === expectedLabel;

  return new Promise((resolve) => {
    if (hasExpectedLabel()) { resolve(); return; }

    const observer = new MutationObserver(() => {
      if (!hasExpectedLabel()) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });

    observer.observe(trigger, { attributes: true, childList: true, subtree: true, attributeFilter: ["aria-label"] });

    const timer = setTimeout(() => {
      observer.disconnect();
      console.warn(`[Auto-send for Perplexity] trigger label did not reach "${expectedLabel}".`);
      resolve();
    }, timeout);
  });
}

// ── Composer helpers ──────────────────────────────────────────────────────────

function setComposerQuery(composer, query) {
  const editable = composer.querySelector(SEL.editable);
  if (!editable) throw new Error("contenteditable not found inside composer.");

  editable.focus();
  editable.textContent = query.trim();
  editable.dispatchEvent(new InputEvent("input", {
    bubbles: true, cancelable: true, inputType: "insertText", data: query.trim(),
  }));
}

async function refocusComposerInput(composer) {
  const editable = composer.querySelector(SEL.editable)
    ?? await waitForElement(SEL.editable, composer, 5_000);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    editable.focus();
    const selection = window.getSelection?.();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (document.activeElement === editable || editable.contains(document.activeElement)) return;
    await sleep(50);
  }
}

function installSpeedStyle() {
  const id = "pplx-auto-send-speed";
  document.getElementById(id)?.remove();

  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
[data-ask-input-container] button[aria-haspopup="menu"],
[role="menu"],
[role="menu"] *,
[role="switch"],
[role="menuitemcheckbox"] {
  transition-duration: 0ms !important;
  animation-duration:  0ms !important;
  animation-delay:     0ms !important;
}`;

  document.head.appendChild(style);
  return () => style.remove();
}
