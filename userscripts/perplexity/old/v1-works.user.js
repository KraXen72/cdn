// ==UserScript==
// @name         Perplexity Auto-send
// @namespace    https://docs.scriptcat.org/
// @version      0.2.1
// @description  Prefill Perplexity from URL params, optionally choose a model by prefix, optionally toggle Thinking, then submit.
// @author       KraXen72
// @match        https://www.perplexity.ai/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=www.perplexity.ai
// @license      AGPL-3.0-or-later
// @grant        GM_notification
// @noframes
// @run-at       document-idle
// ==/UserScript==

const SCRIPT_NAME = 'Perplexity Auto-send';
const requestedParams = new URLSearchParams(location.search);
const requestedQuery = requestedParams.get('us_query');
const requestedModelPrefix = normalizeParam(requestedParams.get('us_model'));
const requestedThinking = parseOptionalBoolean(requestedParams.get('thinking'));

const SELECTORS = {
  askContainer: '[data-ask-input-container]',
  editor: [
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][aria-label]',
    '[contenteditable="true"]'
  ].join(', '),
  submit: 'button[aria-label="Submit"][type="button"]',
  menuTrigger: 'button[aria-haspopup="menu"][type="button"]',
  menu: '[role="menu"]',
  radio: '[role="menuitemradio"]',
  checkboxRow: '[role="menuitemcheckbox"]',
  switch: '[role="switch"]'
};

const TIMEOUT = {
  ui: 15000,
  menu: 2500,
  submit: 8000
};

const CONFIG_URL = '/rest/models/config?config_schema=v1&version=2.18&source=default';
const MODELISH = /\b(best|gpt|claude|gemini|sonar|kimi|grok|nemotron)\b/i;

if (requestedQuery) {
  void main().catch((error) => {
    console.error(`[${SCRIPT_NAME}]`, error);
    notify('Failed', error instanceof Error ? error.message : String(error), 'fatal');
  });
}

async function main() {
  const askContainer = await waitFor(findAskContainer, TIMEOUT.ui, 'Ask input container not found');
  const editor = await waitFor(() => findEditor(askContainer), TIMEOUT.ui, 'Ask editor not found');

  const fillOk = await fillEditor(editor, requestedQuery, askContainer);
  if (!fillOk) {
    notify('Could not prefill query', 'The input was found, but Perplexity did not accept the inserted text.', 'prefill-failed');
    return;
  }

  if (requestedModelPrefix || requestedThinking !== null) {
    const config = await fetchModelsConfig().catch(() => null);
    const configured = await configureModelAndThinking({
      askContainer,
      config,
      requestedModelPrefix,
      requestedThinking
    });

    if (!configured) return;
  }

  const submitButton = await waitFor(
    () => {
      const button = findSubmitButton(askContainer);
      return button && !button.disabled ? button : null;
    },
    TIMEOUT.submit,
    'Submit button did not become available'
  );

  submitButton.click();
}

async function configureModelAndThinking({ askContainer, config, requestedModelPrefix, requestedThinking }) {
  let menuState = await openModelMenu(askContainer);

  if (requestedModelPrefix) {
    const available = getAvailableModels(menuState.menu);
    const target = resolveRequestedModel({
      prefix: requestedModelPrefix,
      available,
      config
    });

    if (!target) {
      closeMenu();
      notify(
        'Model unavailable',
        [
          `Requested prefix "${requestedModelPrefix}" is not available.`,
          available.length ? `Available: ${available.map(x => x.label).join(', ')}` : 'Could not read available models.'
        ].join('\n'),
        'model-unavailable'
      );
      return false;
    }

    const selectedBefore = getSelectedModel(menuState.menu);
    if (!selectedBefore || normalizeLabel(selectedBefore.label) !== normalizeLabel(target.label)) {
      target.item.click();
      await waitForMenuToClose(menuState.menu);
      menuState = await openModelMenu(askContainer);

      const selectedAfter = getSelectedModel(menuState.menu);
      if (!selectedAfter || normalizeLabel(selectedAfter.label) !== normalizeLabel(target.label)) {
        closeMenu();
        notify('Model selection failed', `Tried to switch to "${target.label}", but the selection did not stick.`, 'model-failed');
        return false;
      }
    }
  }

  if (requestedThinking !== null) {
    const result = await setThinking(menuState.menu, requestedThinking);

    if (result === 'missing') {
      const selected = getSelectedModel(menuState.menu);
      if (requestedThinking) {
        notify(
          'Thinking unavailable',
          `Thinking is not available for ${selected?.label ?? 'the selected model'}. Sending without thinking.`,
          'thinking-missing'
        );
      }
    }

    if (result === 'toggle-failed') {
      closeMenu();
      notify('Thinking toggle failed', 'Could not confirm the requested Thinking state.', 'thinking-failed');
      return false;
    }
  }

  closeMenu();
  return true;
}

async function fetchModelsConfig() {
  const response = await fetch(CONFIG_URL, { credentials: 'include' });
  if (!response.ok) throw new Error(`Config fetch failed: ${response.status}`);
  const json = await response.json();

  return (Array.isArray(json?.config) ? json.config : [])
    .filter(entry => typeof entry?.label === 'string')
    .map(entry => ({
      label: entry.label,
      nonReasoningModel: entry.non_reasoning_model ?? null,
      reasoningModel: entry.reasoning_model ?? null,
      subscriptionTier: entry.subscription_tier ?? null
    }));
}

function resolveRequestedModel({ prefix, available, config }) {
  const normalizedPrefix = normalizeLabel(prefix);
  if (!normalizedPrefix) return null;

  if (config?.length) {
    for (const configEntry of config) {
      if (!normalizeLabel(configEntry.label).startsWith(normalizedPrefix)) continue;
      const found = available.find(item => normalizeLabel(item.label) === normalizeLabel(configEntry.label));
      if (found) return found;
    }
  }

  return available.find(item => normalizeLabel(item.label).startsWith(normalizedPrefix)) ?? null;
}

function findAskContainer() {
  return firstVisible(document.querySelectorAll(SELECTORS.askContainer));
}

function findEditor(container) {
  return firstVisible(
    Array.from(container.querySelectorAll(SELECTORS.editor)).filter(node =>
      isVisible(node) && !node.closest(SELECTORS.menu)
    )
  );
}

function findSubmitButton(container) {
  return firstVisible(container.querySelectorAll(SELECTORS.submit));
}

async function fillEditor(editor, text, askContainer) {
  focusEditor(editor);
  clearEditor(editor);

  const methods = [
    () => insertViaExecCommand(editor, text),
    () => insertViaNativeTextInput(editor, text),
    () => insertViaPaste(editor, text),
    () => insertViaDomAndEvents(editor, text)
  ];

  for (const method of methods) {
    await method();
    await sleep(150);

    if (isEditorAccepted(editor, askContainer, text)) return true;

    clearEditor(editor);
    await sleep(50);
  }

  return false;
}

function isEditorAccepted(editor, askContainer, expectedText) {
  const current = normalizeWhitespace(readEditorText(editor));
  const submit = findSubmitButton(askContainer);

  if (submit && !submit.disabled) return true;
  if (current.length > 0) return true;

  return current === normalizeWhitespace(expectedText);
}

function focusEditor(editor) {
  editor.focus();
}

function clearEditor(editor) {
  selectAll(editor);

  try {
    document.execCommand('delete', false);
  } catch {}

  editor.textContent = '';
  editor.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'deleteContentBackward',
    data: null
  }));
  editor.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: false,
    inputType: 'deleteContentBackward',
    data: null
  }));
}

async function insertViaExecCommand(editor, text) {
  focusEditor(editor);
  try {
    document.execCommand('insertText', false, text);
  } catch {}
}

async function insertViaNativeTextInput(editor, text) {
  focusEditor(editor);

  editor.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text
  }));

  try {
    document.execCommand('insertText', false, text);
  } catch {}

  editor.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: false,
    inputType: 'insertText',
    data: text
  }));
}

async function insertViaPaste(editor, text) {
  focusEditor(editor);

  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/plain', text);

  editor.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dataTransfer
  }));
}

async function insertViaDomAndEvents(editor, text) {
  focusEditor(editor);

  const target = editor.querySelector('p, div, span') || editor;
  target.textContent = text;

  editor.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text
  }));
  editor.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: false,
    inputType: 'insertText',
    data: text
  }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
}

function readEditorText(editor) {
  return (editor.textContent || '').replace(/\u200B/g, '').trim();
}

async function openModelMenu(container) {
  const trigger = await waitFor(() => findModelTrigger(container), TIMEOUT.ui, 'Could not find model picker');

  for (let attempt = 0; attempt < 3; attempt++) {
    closeMenu();
    await sleep(60);

    clickElement(trigger);

    const menu = await waitFor(
      () => {
        const open = firstVisible(document.querySelectorAll(SELECTORS.menu));
        return open && looksLikeModelMenu(open) ? open : null;
      },
      TIMEOUT.menu,
      'Model menu did not open'
    ).catch(() => null);

    if (menu) return { trigger, menu };

    await sleep(120);
  }

  throw new Error('Could not open model picker');
}

function findModelTrigger(container) {
  const submit = findSubmitButton(container);
  if (!submit) return null;

  const localScopeCandidates = collectNearbyModelTriggers(submit);
  if (localScopeCandidates.length) return localScopeCandidates[0];

  const containerCandidates = Array.from(container.querySelectorAll(SELECTORS.menuTrigger))
    .filter(isModelTriggerButton);

  if (containerCandidates.length) return containerCandidates[0];

  const globalCandidates = Array.from(document.querySelectorAll(SELECTORS.menuTrigger))
    .filter(isModelTriggerButton);

  return globalCandidates[0] ?? null;
}

function collectNearbyModelTriggers(submit) {
  const scopes = [];
  let current = submit.parentElement;
  let depth = 0;

  while (current && depth < 4) {
    scopes.push(current);
    current = current.parentElement;
    depth += 1;
  }

  for (const scope of scopes) {
    const found = Array.from(scope.querySelectorAll(SELECTORS.menuTrigger))
      .filter(button => button !== submit)
      .filter(isModelTriggerButton);

    if (found.length) return found;
  }

  return [];
}

function isModelTriggerButton(button) {
  if (!isVisible(button)) return false;
  if (button.getAttribute('aria-label') === 'Submit') return false;
  if (button.getAttribute('aria-label') === 'Dictation') return false;

  const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim();
  return MODELISH.test(label);
}

function clickElement(element) {
  element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.click();
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
}

function looksLikeModelMenu(menu) {
  const radios = Array.from(menu.querySelectorAll(SELECTORS.radio)).filter(isVisible);
  if (!radios.length) return false;
  return radios.some(item => MODELISH.test(getModelItemLabel(item)));
}

function getAvailableModels(menu) {
  return Array.from(menu.querySelectorAll(SELECTORS.radio))
    .filter(isVisible)
    .map(item => ({ item, label: getModelItemLabel(item) }))
    .filter(entry => entry.label);
}

function getSelectedModel(menu) {
  const selected = Array.from(menu.querySelectorAll(SELECTORS.radio))
    .find(item => item.getAttribute('aria-checked') === 'true');

  return selected ? { item: selected, label: getModelItemLabel(selected) } : null;
}

function getModelItemLabel(item) {
  const explicit = item.querySelector('[translate="no"]')?.textContent?.trim();
  if (explicit) return explicit;

  return (item.textContent || '')
    .replace(/\b(Max|New|Default|Internal)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function setThinking(menu, desired) {
  const row = Array.from(menu.querySelectorAll(SELECTORS.checkboxRow))
    .find(node => /thinking/i.test((node.textContent || '').trim()));

  const toggle = row?.querySelector(SELECTORS.switch) ?? null;
  if (!toggle || isDisabled(toggle)) return 'missing';

  const before = isSwitchChecked(toggle);
  if (before === desired) return 'ok';

  clickElement(toggle);
  await sleep(150);

  return isSwitchChecked(toggle) === desired ? 'ok' : 'toggle-failed';
}

function isSwitchChecked(toggle) {
  return toggle.getAttribute('aria-checked') === 'true' || toggle.getAttribute('data-state') === 'checked';
}

function isDisabled(node) {
  return !!(
    node.matches?.(':disabled') ||
    node.getAttribute?.('aria-disabled') === 'true' ||
    node.closest?.('[aria-disabled="true"]')
  );
}

async function waitForMenuToClose(menu) {
  await waitFor(() => !menu.isConnected || !isVisible(menu), TIMEOUT.menu, 'Menu did not close').catch(() => {});
}

function closeMenu() {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  });

  document.dispatchEvent(event);

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.dispatchEvent(event);
  }
}

function selectAll(node) {
  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function firstVisible(nodes) {
  return Array.from(nodes).find(isVisible) ?? null;
}

function isVisible(node) {
  if (!(node instanceof Element)) return false;
  if (!node.isConnected) return false;

  const style = getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden') return false;

  return node.getClientRects().length > 0;
}

async function waitFor(fn, timeout, message) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const value = fn();
    if (value) return value;
    await sleep(50);
  }

  throw new Error(message);
}

function parseOptionalBoolean(value) {
  if (value == null) return null;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;

  return null;
}

function normalizeParam(value) {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || null;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function notify(title, text, tag) {
  console.warn(`[${SCRIPT_NAME}] ${title}: ${text}`);

  if (typeof GM_notification === 'function') {
    GM_notification({
      title: `${SCRIPT_NAME}: ${title}`,
      text,
      tag: `pplx-auto-send:${tag}`,
      silent: false,
      zombieTimeout: 15000
    });
  }
}