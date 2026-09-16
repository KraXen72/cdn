// ==UserScript==
// @name        Auto-send for ChatGPT
// @namespace   ScriptCat Scripts
// @version     1.0.1
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
const composerSel = "[data-composer-body]";
const inputSel = `[contenteditable="true"]`
const popupSel = "[data-radix-popper-content-wrapper]"

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

// -1 = unchanged
// 0  = instant
// 1  = medium
// 2  = high
// 3  = pro
let requestedThinking = -1;
let promptSpecified = false;

async function main() {
    const url = new URL(window.location.href);
    const params = Object.fromEntries(url.searchParams);
    console.log(params)

    if (Object.hasOwn(params, "prompt") || Object.hasOwn(params, "q")) {
        promptSpecified = (params?.prompt?.trim() || params?.q?.trim()) !== ""
    }

    const thinkingParam = params.thinking?.trim().toLowerCase();

    if (["off", "no", "disable", "disabled"].includes(thinkingParam)) {
        requestedThinking = 0;
    } else if (/^[0-3]$/.test(thinkingParam)) {
        requestedThinking = Number(thinkingParam);
    }
    if (!promptSpecified && requestedThinking === -1) {
        console.log("neither prompt, nor thinking level was specified. no-op");
        return;
    }

    console.log("found prompt or thinking level!");
    console.log(requestedThinking)

    composer = await waitForSelector(composerSel);
    inputEl = await waitForSelector(inputSel, () => true, composer);
    // console.log("container", composer, "input", inputEl);

    if (promptSpecified && requestedThinking === -1) {
        await sendPrompt();
        return;
    }

    // find thinking effort button
    thinkingEffortButton = await waitForSelector(
        "button",
        button => {
            const text = button?.innerText?.trim()?.toLowerCase();
            return (text && thinkingEffortButtonTexts.some(t => text.includes(t)));
        },
        composer
    );

    // open it
    const thinkingChangeNeeded = openThinkingEffortPopup(thinkingEffortButton, requestedThinking);
    if (promptSpecified && !thinkingChangeNeeded) {
        await sendPrompt();
        return;
    }

    // for each possible popup wrapper element, check if it has a tickrail.
    // that is the slider upon which to do the keybaord events
    thinkingEffortSlider = await waitForSelector(
        popupSel,
        popupWrapper => {
            return Array.from(popupWrapper.querySelectorAll("div"))
                .find(div =>
                    Array.from(div.classList).some(c =>
                        c.toLowerCase().endsWith("tickrail")
                    )
                );
        }
    );

    // await sleep(100);
    await setThinkingEffortKeyboard(thinkingEffortSlider, requestedThinking);

    if (inputEl) inputEl.focus();
    if (promptSpecified) await sendPrompt();
}

function openThinkingEffortPopup(button, level) {
    const currentThinkingText = button?.innerText?.trim()?.toLowerCase();

    const currentThinking = Array.from(thinkingEffortMap.entries())
        .find(([text, number]) =>
            currentThinkingText === text || currentThinkingText?.endsWith(` ${text}`)
        )
        .at(1);

    if (currentThinking != null && currentThinking === level) {
        console.log("already at requested thinking level, no-op");
        return false;
    }

    console.log("opening thinking effort selector")
    fireKeybEvent(document.body, "keydown", { key: "m", ctrlKey: true, shiftKey: true });
    return true;
}

async function setThinkingEffortKeyboard(slider, level) {
    // for some reason, arrow up and tab focuses the model dropdown. tab itself doesn't cut it.
    await fireKeybEventDelayed(slider, "keydown", { key: "ArrowUp" });
    await fireKeybEventDelayed(slider, "keydown", { key: "Tab" }); // focus the model
    await fireKeybEventDelayed(slider, "keydown", { key: "Tab" }); // focus the slider

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
        "button#composer-submit-button",
        button =>
            !button.disabled
            && button.getAttribute("aria-disabled") !== "true",
        composer,
        30_000,
        {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["disabled", "aria-disabled"]
        }
    );
    console.log("sending prompt!", submitBtn)
    // click(submitBtn);
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
  const eventObj = new KeyboardEvent(event, Object.assign({ bubbles: true, cancelable: false }, opts))
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