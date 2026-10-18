// ==UserScript==
// @name        Auto-send for ChatGPT
// @namespace   ScriptCat Scripts
// @version     1.2.0
// @description automatically change chatgpt go/plus/pro reasoning level based on URL parameters
// @author      KraXen72
// @match       https://chatgpt.com/*
// @match       https://chat.openai.com/*
// @grant       none
// @license     AGPL-3.0-or-later
// @noframes
// ==/UserScript==

// limitations:
// todo: fix: only works for english UI (instant/medium/high/pro)
// todo: investigate/fix: only works for chatgpt 5.6-style number-less thinking levels (might get done later)

// selectors
// const popupSel = "[data-radix-popper-content-wrapper]"
const composerSel = "[data-composer-body]";
const inputSel = `[contenteditable="true"]`
const thinkingEffortSliderSel = `[data-reasoning-slider="true"]`
const modelSelectSel = `[data-model-picker-view-toggle="true"], [aria-label="Select model"]`
const modelWrapperSel = `[data-model-picker-view="advanced"], .Menu-FcZccz`
const composerSubmitSel = `button[type="submit"][aria-label][class*="composer"]`

// other constants
const thinkingEffortButtonTexts = [
    "thinking",
"thinking effort",
"instant",
"medium",
"high",
"pro"
]
const thinkingEffortMap = new Map(Object.entries({
    "instant": 0,
    "medium": 1,
    "high": 2,
    "pro": 3
}))

// limit-testing. increase if unreliable
const keyboardDelayMS = 25;

// elements
let composer = null;
let inputEl = null;
let thinkingEffortButton = null;
let thinkingEffortSlider = null;
let modelSelectSlider = null;

// -1 = unchanged
// 0  = instant
// 1  = medium
// 2  = high
// 3  = pro
let requestedThinking = -1;
let promptSpecified = false;
let requestedModelPrefix = "";

async function main() {
    const url = new URL(window.location.href);
    const params = Object.fromEntries(url.searchParams);
    console.log(params)

    if (Object.hasOwn(params, "prompt") || Object.hasOwn(params, "q")) {
        promptSpecified = Boolean(params?.prompt?.trim() || params?.q?.trim());
    }

    const thinkingParam = params.thinking?.trim().toLowerCase();
    requestedModelPrefix = params.model?.trim().toLowerCase() ?? "";

    if (["off", "no", "disable", "disabled"].includes(thinkingParam)) {
        requestedThinking = 0;
    } else if (/^[0-3]$/.test(thinkingParam)) {
        requestedThinking = Number(thinkingParam);
    } else if (thinkingParam != null && thinkingParam !== "") {
        console.warn(`invalid thinking level: ${thinkingParam}`);
    }

    if (!promptSpecified && requestedThinking === -1 && !requestedModelPrefix) {
        console.log("neither prompt, thinking level, nor model was specified. no-op");
        return;
    }

    console.log("found prompt or thinking level!");
    console.log("requested thinking:", requestedThinking)
    console.log("requested model:", requestedModelPrefix)

    // composer = await waitForSelector(composerSel);
    // inputEl = await waitForSelector(inputSel, () => true, composer);

    inputEl = await waitForSelector(`${composerSel} ${inputSel}`);
    composer = inputEl.closest(composerSel);

    if (!composer) { throw new Error("Input found without composer"); }

    // console.log("container", composer, "input", inputEl);

    if (promptSpecified && requestedThinking === -1 && !requestedModelPrefix) {
        await sendPrompt();
        return;
    }

    // find thinking effort button
    thinkingEffortButton = await findThinkingEffortButton();

    // open the thinking effort & model pop-up
    const thinkingChangeNeeded = openThinkingEffortModelPopup(thinkingEffortButton, requestedThinking, requestedModelPrefix);
    if (promptSpecified && !thinkingChangeNeeded && !requestedModelPrefix) {
        await sendPrompt();
        return;
    }

    if (thinkingChangeNeeded || requestedModelPrefix) {

        if (requestedModelPrefix) {
            thinkingEffortSlider = await waitForSelector(thinkingEffortSliderSel);
            await setModelKeyboard(thinkingEffortSlider, requestedModelPrefix);
        }
        if (thinkingChangeNeeded) {
            thinkingEffortSlider = await waitForSelector(thinkingEffortSliderSel);
            await setThinkingEffortKeyboard(thinkingEffortSlider, requestedThinking);
        }
    }

    await sleep(50);
    inputEl = await waitForSelector(`${composerSel} ${inputSel}`);
    inputEl.focus();

    if (promptSpecified) await sendPrompt();
}

function findThinkingEffortButton() {
    return waitForSelector("button", button => {
        const composer = button.closest(composerSel);
        if (!composer?.querySelector(inputSel)) return false;

        const text = button.innerText?.trim().toLowerCase();
        if (!text) return false;

        return text === "thinking"
        || text === "thinking effort"
        || getThinkingLevel(text) != null;
    });
}

function getThinkingLevel(text) {
    const normalized = text?.trim().toLowerCase();
    if (!normalized) return null;

    const name = normalized.split(" ").at(-1);
    return thinkingEffortMap.get(name) ?? null;
}

function openThinkingEffortModelPopup(button, level, modelPrefix) {
    const currentThinkingText = button?.innerText?.trim()?.toLowerCase();

    const currentThinking = getThinkingLevel(currentThinkingText);

    if (!modelPrefix && currentThinking != null && currentThinking === level) {
        console.log("already at requested thinking level, no-op");
        return false;
    }

    console.log("opening thinking effort selector")
    fireKeybEvent(document.body, "keydown", { key: "m", ctrlKey: true, shiftKey: true });
    return true;
}

async function setModelKeyboard(slider, modelPrefix) {
    console.log("selecting model with prefix: ", modelPrefix);

    await fireKeybEventDelayed(slider, "keydown", { key: "ArrowUp" }); // focus slider
    await fireKeybEventDelayed(slider, "keydown", { key: "Tab" }); // focus the model
    await fireKeybEventDelayed(document.activeElement, "keydown", { key: "Enter" }); // go into model picker

    const wrapper = await waitForSelector(modelWrapperSel)
    const modelOptions = Array
    .from(wrapper.querySelectorAll(`[data-radix-collection-item]`))
    .map((el, i) => ({
        idx: i,
        model: el.textContent.trim(),
                     selected: el.getAttribute(`aria-checked`) === "true"
    }))
    .filter(pair => pair.model !== "")

    const selectedModels = modelOptions.filter(pair => pair.selected)
    const pairsMatchingPrefix = modelOptions.filter(pair => pair.model.toLowerCase().startsWith(modelPrefix))

    console.log(modelOptions, selectedModels, pairsMatchingPrefix)

    if (pairsMatchingPrefix.length === 0) throw new Error(`Could not find model with prefix: ${modelPrefix}`);
    if (selectedModels.length === 0) throw new Error("Could not determine currently selected model");

    const firstMatch = pairsMatchingPrefix[0];

    if (firstMatch.selected) {
        console.log("no-op: requested model already selected");
        await fireKeybEventDelayed(document.activeElement, "keydown", { key: "Enter" });
        return;
    }

    const firstSelected = selectedModels[0];
    const distance = firstMatch.idx - firstSelected.idx;
    const key = distance > 0 ? "ArrowDown" : "ArrowUp";

    for (let i = 0; i < Math.abs(distance); i++) {
        await fireKeybEventDelayed(document.activeElement, "keydown", { key });
    }

    await fireKeybEventDelayed(document.activeElement, "keydown", { key: "Enter" });
}

async function setThinkingEffortKeyboard(slider, level) {
    console.log("selecting thinking effort: ", level);

    const sliderValue = slider.querySelector('[role="slider"]');

    if (sliderValue) {
        const min = Number(sliderValue.getAttribute("aria-valuemin"));
        const max = Number(sliderValue.getAttribute("aria-valuemax"));

        if (Number.isFinite(min) && Number.isFinite(max) && (level < min || level > max)) {
            throw new Error(
                `Requested thinking level ${level}, but slider supports ${min}-${max}`
            );
        }
    }

    await fireKeybEventDelayed(slider, "keydown", { key: "ArrowUp" }); // focus slider
    // debugger;

    // then you can use left/right arrows to adjust the thinking effort
    // overshoot left to guarantee we're at the minimum.
    for (let i = 0; i < 4; i++) {
        await fireKeybEventDelayed(slider, "keydown", { key: "ArrowLeft" });
    }
    for (let i = 0; i < level; i++) {
        await fireKeybEventDelayed(slider, "keydown", { key: "ArrowRight" });
    }

    await sleep(keyboardDelayMS);
    await fireKeybEventDelayed(slider, "keydown", { key: "Escape" });
}

async function sendPrompt() {
    const submitBtn = await waitForSelector(
        composerSubmitSel,
        button =>
        button.isConnected
        && button.closest(composerSel)
        && !button.disabled
        && button.getAttribute("aria-disabled") !== "true",
                                            document,
                                            30_000,
                                            {
                                                childList: true,
                                                subtree: true,
                                                attributes: true,
                                                attributeFilter: ["disabled", "aria-disabled"]
                                            }
    );

    console.log("sending prompt!", submitBtn);

    if (!submitBtn.isConnected) {
        throw new Error("Submit button became detached before click");
    }

    submitBtn.click();
}

// -- utils --

function waitForSelector(
    selector,
    callback,
    root = document,
    timeout = 30_000,
    observerOptions = { childList: true, subtree: true }
) {
    console.log("waiting for: ", selector)
    return new Promise((resolve, reject) => {
        let observer, timer;

        const check = () => {
            for (const el of root.querySelectorAll(selector)) {
                const result = callback ? callback(el) : true;

                if (result) {
                    observer?.disconnect();
                    clearTimeout(timer);
                    resolve(result === true ? el : result);
                    return true;
                }
            }

            return false;
        };

        // Fast path: don't create an observer if it's already there.
        if (check()) return;

        observer = new MutationObserver(check);
        observer.observe(
            root === document ? document.documentElement : root,
            observerOptions
        );

        // Close the gap between the initial check and observe().
        if (check()) return;

        timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timed out waiting for ${selector}`));
        }, timeout);
    });
}

// from ultra-hotkeys (my other script) / other places
// Modified from http://stackoverflow.com/a/2706236
function fireMouseEvent(targetNode, event, opts = {}) {
    document.activeElement.blur()
    const eventObj = new Event(event, Object.assign({ bubbles: true, cancelable: false }, opts))
    targetNode.dispatchEvent(eventObj);
}

function click(targetNode) { fireMouseEvent(targetNode, 'click'); }

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function fireKeybEvent(targetNode, event, opts = {}) {
    const eventObj = new KeyboardEvent(event, Object.assign({ bubbles: true, cancelable: true }, opts))
    targetNode.dispatchEvent(eventObj);
    eventObj.preventDefault()
}

async function fireKeybEventDelayed(targetNode, event, opts = {}, delay = keyboardDelayMS) {
    const eventObj = new KeyboardEvent(event, Object.assign({ bubbles: true, cancelable: true }, opts));

    targetNode.dispatchEvent(eventObj);
    await sleep(delay);
}

// fireKeybEvent(document.body, 'keydown', { altKey: true, key: 'k', code: 'KeyK', which: 75 })

main().catch(error => {
    console.error("[Auto-send for ChatGPT]", error);
});
