// ==UserScript==
// @name         DeepSeek File Drop Helper
// @namespace    http://tampermonkey.net/
// @version      0.16
// @description  Renames unsupported text files on drop and adds expert-mode file injection
// @author       KraXen72
// @match        https://chat.deepseek.com/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

const COLORS = {
    bgDark: '#1C1C1D',
    bgMedium: '#212122',
    bgLight: '#38393B',
    border: '#45474B'
};

const INPUT_SELECTOR = 'textarea[placeholder="Message DeepSeek"][name="search"]';

const EXPERT_MODE_ACTIVE_SELECTOR = 'div[data-model-type="expert"][role="radio"][aria-checked="true"]';
const MODE_TOGGLE_SELECTOR = 'div[data-model-type="expert"][role="radio"], div[data-model-type="default"][role="radio"]';
const ONGOING_CHAT_MODE_SELECTOR = '.the-header'
const MESSAGE_SELECTOR = '.ds-message:not(:has(> .ds-assistant-message-main-content)):not(:has(> .ds-think-content)) > div[class]'

const UPLOAD_OVERLAY_SELECTOR = 'div.c760857e._45872ba';
const MAX_MESSAGE_LENGTH_BEFORE_COLLAPSE = 300;
const FILES_BLOCK_REGEX = /<files>([\s\S]*?)<\/files>/
const FILES_BLOCK_REGEX_GLOBAL = /<files>([\s\S]*?)<\/files>/g

/** @type {{ name: string, hash: string }[]} */
const currentlyInjectedBatch = [];

const prefix = "userscript-styles-deepseek"
GM_addStyle(`
    #${prefix}-expert-file-ui {
        position: fixed;
        top: 10px;
        right: 10px;
        zIndex: 9999;
        background: ${COLORS.bgDark};
        color: #e0e0e0;
        border-radius: 12px;
        padding: 10px;
        font-family: sans-serif;
        font-size: 14px;
        max-width: 340px;
        box-whadow: 0 4px 12px rgba(0,0,0,0.5);
        border: 1px solid ${COLORS.border};
        margin-bottom: 8px; 
        padding-bottom: 8px;
        border-bottom:1px solid ${COLORS.border};

        display: none;
    }
    #${prefix}-file-list {
        list-style: none;
        padding: 0;
        margin: 8px 0;
    }

    .${prefix}-button {
        flex:1; 
        padding:6px 0; 
        border:1px solid ${COLORS.border};
        border-radius:8px; 
        background: ${COLORS.bgLight};
        color:#e0e0e0; 
        cursor:pointer; 
        font-size:13px;
        transition: background 0.15s;
    }
    .${prefix}-button:hover {
        background-color: ${COLORS.border};
    }

    .${prefix}-x-button {
        color:#f44;
        width: 26px;
        height: 26px;
        border: 1px solid ${COLORS.border};
        border-radius: 50px; 
        background:${COLORS.bgLight};
        display: flex;
        justify-content: center;
        align-items: center;
        cursor:pointer; 
        font-size: 20px;
        transition: background 0.15s;
    }
    .${prefix}-x-button:hover {
        background-color: ${COLORS.border};
    }

    [data-${prefix}-collapsed="true"],
    [data-${prefix}-collapsed="false"] {
        border: 2px solid transparent;
        transition: border-color 200ms;
    }

    [data-${prefix}-collapsed="true"]:hover,
    [data-${prefix}-collapsed="false"]:hover {
        border: 2px solid ${COLORS.border};
    }

    [data-${prefix}-collapsed="true"] {
        max-height: 300px;
        overflow: hidden;
        mask-image: linear-gradient(to bottom, black 80%, transparent 100%);
    }
    
`)

async function getContentHash(text) {
    const msgUint8 = new TextEncoder().encode(text);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function notify(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            new Notification(title, { body });
        }
    }
}

async function parseInjectedFilesFromTextarea() {
    const input = getInputElement();
    if (!input) return [];
    const content = input.value;
    const filesBlockMatch = content.match(FILES_BLOCK_REGEX);
    if (!filesBlockMatch) return [];

    const block = filesBlockMatch[1];
    const fileTagRegex = /<([a-zA-Z0-9._-]+)(?:\s+version="([^"]+)")?>([\s\S]*?)<\/\1>/g;
    const parsed = [];
    let match;
    while ((match = fileTagRegex.exec(block)) !== null) {
        const tagName = match[1];
        const version = match[2] || null;
        const fileContent = match[3];
        const hash = await getContentHash(fileContent);
        // Extract original name (strip version suffix if present in tag name)
        let originalName = tagName;
        if (version) {
            // version attribute present, tag name is the original name
            originalName = tagName;
        } else {
            // try to detect if tag name contains a timestamp suffix (from previous versioning)
            const suffixMatch = tagName.match(/^(.*)-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})$/);
            if (suffixMatch) {
                originalName = suffixMatch[1];
            }
        }
        parsed.push({ name: originalName, hash, content: fileContent, version });
    }
    return parsed;
}

const ALLOWED_EXTS = new Set([
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif',
    'txt', 'md', 'py', 'ts', 'js'
]);

let attachedFiles = [];

const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
).set;

function isExpertModeActive() {
    if (document.querySelector(MODE_TOGGLE_SELECTOR) != null) {
        // chat start screen
        return !!document.querySelector(EXPERT_MODE_ACTIVE_SELECTOR);
    } else {
        // ongoing chat
        const header = document.querySelector(ONGOING_CHAT_MODE_SELECTOR);
        if (header == null) {
            console.warn("[deepseek-dnd-intercept]: can't find either expert mode selector!");
            return false;
        }
        return header
            .innerText
            .trim()
            .toLowerCase()
            .split("\n")
            .some(chunk => chunk.trim() === "expert");
    }
}

function isTextFile(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            const bytes = new Uint8Array(reader.result);
            resolve(bytes.every(b => b !== 0));
        };
        reader.onerror = () => resolve(false);
        reader.readAsArrayBuffer(file.slice(0, 4096));
    });
}

function getInputElement() {
    return document.querySelector(INPUT_SELECTOR);
}

function setTextareaValue(element, value) {
    nativeTextAreaValueSetter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
}

function removeFilesBlock(text) {
    return text.replace(FILES_BLOCK_REGEX_GLOBAL, '');
}

function injectFiles() {
    const input = getInputElement();
    if (!input || attachedFiles.length === 0) return;

    let block = '<files>\n';
    for (const { name, content } of attachedFiles) {
        block += `<${name}>\n${content}\n</${name}>\n`;
    }
    block += '</files>';

    const remaining = removeFilesBlock(input.value);
    setTextareaValue(input, block + remaining);
}

function clearFilesBlock() {
    const input = getInputElement();
    if (!input) return;
    setTextareaValue(input, removeFilesBlock(input.value));
}

function getUIContainer() {
    return document.getElementById(`${prefix}-expert-file-ui`);
}

function ensureUIContainer() {
    if (getUIContainer()) return; // already exists, do not recreate

    const container = document.createElement('div');
    container.id = `${prefix}-expert-file-ui`;
    const header = document.createElement('div');
    header.textContent = 'Attached Files';
    header.style.fontWeight = "bold";
    container.appendChild(header);

    const list = document.createElement('ul');
    list.id = `${prefix}-file-list`;
    container.appendChild(list);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px';

    const makeButton = (text, onClick) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.addEventListener('click', onClick);
        btn.classList.add(`${prefix}-button`)
        return btn;
    };

    btnRow.appendChild(makeButton('Inject', injectFiles));
    btnRow.appendChild(makeButton('Clear', clearFilesBlock));

    container.appendChild(btnRow);
    document.body.appendChild(container);
}

function refreshUI() {
    const expert = isExpertModeActive();
    ensureUIContainer();
    const container = getUIContainer();
    if (!container) return;
    container.style.display = expert ? 'block' : 'none';
    if (!expert) attachedFiles = [];

    const list = document.getElementById(`${prefix}-file-list`);
    if (!list) return;
    list.innerHTML = '';

    attachedFiles.forEach((file, index) => {
        const li = document.createElement('li');
        li.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px;align-items:center';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = file.name;
        nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px';

        const removeBtn = document.createElement('button');
        removeBtn.innerHTML = '&times;';
        removeBtn.classList.add(`${prefix}-x-button`);
        removeBtn.addEventListener('click', () => {
            attachedFiles.splice(index, 1);
            refreshUI();
        });

        li.appendChild(nameSpan);
        li.appendChild(removeBtn);
        list.appendChild(li);
    });
}

const collapsed_attr_name = `data-${prefix}-collapsed`

/**
 * @param {HTMLElement} node 
 */
function injectCollapsed(node) {
    if (node.hasAttribute(collapsed_attr_name)) return;

    const isLong = node.textContent.length > MAX_MESSAGE_LENGTH_BEFORE_COLLAPSE;
    node.setAttribute(collapsed_attr_name, isLong ? "true" : "false");
    node.setAttribute("title", "Double-click to toggle collapsed/expanded")

    node.addEventListener("dblclick", () => {
        const isCollapsed = node.getAttribute(collapsed_attr_name) === "true";
        node.setAttribute(collapsed_attr_name, isCollapsed ? "false" : "true");
    });
}

function setupModeDetection() {
    new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;

                // mode change observing
                if (node.matches?.(MODE_TOGGLE_SELECTOR)) {
                    observeModeElement(node);
                } else if (node.querySelectorAll) {
                    for (const cand of node.querySelectorAll(MODE_TOGGLE_SELECTOR)) {
                        observeModeElement(cand);
                    }
                }

                // ds-message collapse injection
                if (node.matches?.(MESSAGE_SELECTOR)) {
                    injectCollapsed(nodel);
                } else if (node.querySelector(MESSAGE_SELECTOR) != null) {
                    node.querySelectorAll(MESSAGE_SELECTOR)
                        .forEach(n => injectCollapsed(n));
                }

            }
            for (const node of m.removedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.matches?.(MODE_TOGGLE_SELECTOR)) {
                    refreshUI();
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    const existing = document.querySelector(MODE_TOGGLE_SELECTOR);
    if (existing) observeModeElement(existing);
}

let modeElement = null;
let attributeObserver = null;

function observeModeElement(el) {
    if (modeElement === el) return;
    stopObservingModeElement();
    modeElement = el;
    attributeObserver = new MutationObserver((mutations) => {
        if (mutations.some(m => m.type === 'attributes' && m.attributeName === 'aria-checked')) {
            refreshUI();
        }
    });
    attributeObserver.observe(el, { attributes: true, attributeFilter: ['aria-checked'] });
    refreshUI();
}

function stopObservingModeElement() {
    if (attributeObserver) {
        attributeObserver.disconnect();
        attributeObserver = null;
    }
    modeElement = null;
}

document.addEventListener('dragover', (e) => {
    if (!isExpertModeActive()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.dataTransfer.dropEffect = 'copy';
}, true);

document.addEventListener('drop', async (e) => {
    if (e._dsHandled) return;
    if (isExpertModeActive()) {
        e.preventDefault();
        e.stopImmediatePropagation();

        const files = [...e.dataTransfer.files];
        for (const file of files) {
            const content = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsText(file);
            });
            attachedFiles.push({ name: file.name, ext: file.name.split('.').pop(), content });
        }
        refreshUI();
        return;
    }

    // Instant mode: rename unsupported text files, then forward
    e.preventDefault();
    e.stopPropagation();
    const files = [...e.dataTransfer.files];
    const processed = await Promise.all(files.map(renameFileIfNeeded));
    forwardDrop(e, processed);
}, true);

async function renameFileIfNeeded(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ALLOWED_EXTS.has(ext)) return file;
    if (!(await isTextFile(file))) return file;
    const base = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
    return new File([file], `${base}-${ext}.txt`, { type: 'text/plain', lastModified: file.lastModified });
}

function forwardDrop(originalEvent, processedFiles) {
    const dt = new DataTransfer();
    processedFiles.forEach(f => dt.items.add(f));
    const newEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    Object.defineProperty(newEvent, '_dsHandled', { value: true });
    originalEvent.target.dispatchEvent(newEvent);
}

// Hide the “Expert Mode doesn’t support file uploads” overlay via CSS
const style = document.createElement('style');
style.textContent = `${UPLOAD_OVERLAY_SELECTOR} { display: none !important; }`;
document.head.appendChild(style);

function onReady() {
    ensureUIContainer();
    setupModeDetection();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
} else {
    onReady();
}
