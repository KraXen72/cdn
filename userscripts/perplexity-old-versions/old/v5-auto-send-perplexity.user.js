// ==UserScript==
// @name         Auto-send for Perplexity
// @namespace    https://docs.scriptcat.org/
// @version      0.6.0
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
const hasRequestedQuery = requestedQuery.trim() !== "";
const hasRequestedModel = requestedModel.trim() !== "";
const hasRequestedThinking = params.has("thinking");
const requestedThinking = parseBooleanParam(params.get("thinking"));

// examples: vivaldi custom search engines (preserve these comments verbatim!)
// https://www.perplexity.ai/?us_query=%s&us_model=claude&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=claude&thinking=true
// https://www.perplexity.ai/?us_query=%s&us_model=gpt&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=gpt&thinking=true
// https://www.perplexity.ai/?us_query=%s&us_model=kimi&thinking=false
// https://www.perplexity.ai/?us_query=%s&us_model=kimi&thinking=true
// https://ac.duckduckgo.com/ac/?q=%s&type=list

const MODEL_LABELS = {
  gpt: "GPT-5.4",
  gpt54: "GPT-5.4",
  gpt_54: "GPT-5.4",
  claude: "Claude Sonnet 4.6",
  claude46sonnet: "Claude Sonnet 4.6",
  claude_46_sonnet: "Claude Sonnet 4.6",
  gemini: "Gemini 3.1 Pro",
  gemini31pro: "Gemini 3.1 Pro",
  gemini_31_pro: "Gemini 3.1 Pro",
  kimi: "Kimi K2.6",
  kimi_k26: "Kimi K2.6",
  kimik26: "Kimi K2.6",
  nemotron: "Nemotron 3 Ultra",
  nemotron3ultra: "Nemotron 3 Ultra",
  nemotron_3_ultra: "Nemotron 3 Ultra",
  sonar: "Sonar 2",
  sonar2: "Sonar 2",
  best: "Best",
};

const KNOWN_MODEL_LABELS = [...new Set(Object.values(MODEL_LABELS))];

const SEL = {
  composer: '[data-ask-input-container]',
  editable: '[contenteditable="true"]',
  submitButton: 'button[aria-label="Submit"]',
  menuTrigger: 'button[aria-haspopup="menu"]',
  menu: '[role="menu"]',
  modelRadios: '[role="menuitemradio"]',
  selectedRadio: '[role="menuitemradio"][aria-checked="true"]',
  thinkingCheckbox: '[role="menuitemcheckbox"]',
};

let runStarted = false;
main().catch((error) => console.error("[Auto-send for Perplexity] fatal error", error));

async function main() {
  if (runStarted) return;
  runStarted = true;

  if (!hasRequestedQuery && !hasRequestedModel && !hasRequestedThinking) {
    console.info("[Auto-send for Perplexity] nothing requested; exiting.");
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
    console.log("[Auto-send for Perplexity] configured only; waiting for manual input and submit.");
    return;
  }

  const submitButton = await waitForElement(SEL.submitButton, composer, 5_000);
  submitButton.click();
  console.log("[Auto-send for Perplexity] submitted.");
}

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

function resolveTarget(modelParam, thinking, hasModel, hasThinking) {
  if (!hasModel) return null;

  const baseLabel = MODEL_LABELS[normalizeKey(modelParam)];
  if (!baseLabel) return null;

  return {
    baseLabel,
    thinking: hasThinking ? Boolean(thinking) : null,
    triggerLabel: hasThinking && thinking ? `${baseLabel} Thinking` : baseLabel,
  };
}

function waitForElement(selector, root = document, timeout = 5_000) {
  const query = () => (root === document ? document : root).querySelector(selector);

  return new Promise((resolve, reject) => {
    const initial = query();
    if (initial) {
      resolve(initial);
      return;
    }

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
    return composers.find((element) => element.querySelector(SEL.editable))
      ?? composers.find((element) => element.querySelector(SEL.submitButton))
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

function findModelTrigger(composer) {
  const buttons = [...composer.querySelectorAll(SEL.menuTrigger)];
  const ranked = buttons
    .filter((button) => !button.matches(SEL.submitButton))
    .map((button) => ({ button, score: scoreTrigger(button) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.button ?? null;
}

function scoreTrigger(button) {
  const label = button.getAttribute("aria-label") ?? normText(button);
  if (!label) return 0;
  if (label === "Model" || label === "Orchestrator") return 2;
  if (label.endsWith(" Thinking")) return 4;
  if (KNOWN_MODEL_LABELS.includes(label)) return 5;
  if (KNOWN_MODEL_LABELS.some((known) => label.includes(known))) return 3;
  return 0;
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

function isModelMenu(menu) {
  if (!menu?.isConnected) return false;
  return [...menu.querySelectorAll(SEL.modelRadios)].some((item) => {
    const label = getModelItemLabel(item);
    return KNOWN_MODEL_LABELS.includes(label);
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
      const options = {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      trigger.dispatchEvent(new PointerEvent("pointerdown", options));
      trigger.dispatchEvent(new PointerEvent("pointerup", options));
      trigger.dispatchEvent(new MouseEvent("click", options));
    },
  ];

  for (const attempt of attempts) {
    attempt();
    try {
      return await waitForModelMenu(1_500);
    } catch {
      await sleep(80);
    }
  }

  throw new Error('Timeout waiting for selector: [role="menu"]');
}

function getModelItemLabel(item) {
  const explicitLabel = item.querySelector("[translate='no']");
  if (explicitLabel) return normText(explicitLabel);

  const fullText = normText(item);
  return KNOWN_MODEL_LABELS.find((label) => fullText.includes(label)) ?? fullText;
}

function readMenuState(menu) {
  const selected = menu.querySelector(SEL.selectedRadio);
  const thinkingRow = [...menu.querySelectorAll(SEL.thinkingCheckbox)]
    .find((element) => normText(element).includes("Thinking"));
  const thinkingSwitch = thinkingRow?.querySelector('[role="switch"]') ?? null;

  return {
    selectedLabel: selected ? getModelItemLabel(selected) : "",
    thinking: thinkingSwitch ? thinkingSwitch.getAttribute("aria-checked") === "true" : null,
    thinkingSwitch,
  };
}

async function configureMenu(menu, trigger, target) {
  let currentMenu = menu;
  let state = readMenuState(currentMenu);

  if (state.selectedLabel !== target.baseLabel) {
    const item = [...currentMenu.querySelectorAll(SEL.modelRadios)]
      .find((element) => getModelItemLabel(element) === target.baseLabel);

    if (!item) throw new Error(`Model item "${target.baseLabel}" not found in menu.`);

    item.click();

    try {
      await waitForAttr(item, "aria-checked", "true", 1_500);
    } catch {
      currentMenu = await openModelMenu(trigger);
    }

    if (!currentMenu.isConnected) {
      currentMenu = await openModelMenu(trigger);
    }

    state = readMenuState(currentMenu);
  }

  if (target.thinking === null || state.thinking === target.thinking) return;

  const thinkingSwitch = state.thinkingSwitch;
  if (!thinkingSwitch) {
    throw new Error("Thinking switch not available for this model.");
  }

  thinkingSwitch.click();
  await waitForAttr(thinkingSwitch, "aria-checked", String(target.thinking), 1_500);
}

function waitForAttr(element, attribute, expectedValue, timeout = 1_500) {
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

    observer.observe(element, { attributes: true, attributeFilter: [attribute] });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for ${attribute}=${expectedValue}`));
    }, timeout);
  });
}

function waitForTriggerLabel(trigger, expectedLabel, timeout = 3_000) {
  const hasExpectedLabel = () => (trigger.getAttribute("aria-label") ?? normText(trigger)).trim() === expectedLabel;

  return new Promise((resolve) => {
    if (hasExpectedLabel()) {
      resolve();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!hasExpectedLabel()) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });

    observer.observe(trigger, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["aria-label"],
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      console.warn(`[Auto-send for Perplexity] trigger label did not reach "${expectedLabel}".`);
      resolve();
    }, timeout);
  });
}

function setComposerQuery(composer, query) {
  const editable = composer.querySelector(SEL.editable);
  if (!editable) throw new Error("contenteditable not found inside composer.");

  editable.focus();
  editable.textContent = query.trim();
  editable.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    cancelable: true,
    inputType: "insertText",
    data: query.trim(),
  }));
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
  animation-duration: 0ms !important;
  animation-delay: 0ms !important;
}`;

  document.head.appendChild(style);
  return () => style.remove();
}
