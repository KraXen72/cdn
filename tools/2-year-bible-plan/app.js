"use strict";

const STORE_KEY = "kraxen-bible-plan-progress-v1";
const APP_ID = "kraxen-2-year-bible-plan";
const partId = Number(document.body.dataset.part);
const total = Number(document.body.dataset.total);
const partEnds = document.body.dataset.partEnds.split(",").map(Number);
const root = document.getElementById("content");
const status = document.getElementById("save-status");
const fileInput = document.getElementById("import-file");
const toast = document.getElementById("toast");
const backupMenu = document.getElementById("backup-menu");
const readingInputs = [...root.querySelectorAll('[data-type="reading"]')];
const scopeInputs = [
  ...root.querySelectorAll('.check:not([data-type="reading"])'),
];
const idsOf = (input) => input.dataset.ids.split(",").map(Number);

let progress = new Set();
let previousProgress = null;
let toastTimer;

/** Validate both legacy local saves and portable backups against the built plan. */
function validProgress(value) {
  return (
    value?.version === 1 &&
    Array.isArray(value.completed) &&
    value.completed.every(
      (id) => Number.isInteger(id) && id >= 1 && id <= total,
    ) &&
    new Set(value.completed).size === value.completed.length
  );
}

function readLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return new Set();
    const value = JSON.parse(raw);
    if (!validProgress(value)) throw new Error("Invalid saved progress");
    return new Set(value.completed);
  } catch {
    status.textContent =
      "Uložený stav sa nepodarilo načítať. Skontroluj zálohu.";
    status.hidden = false;
    return new Set();
  }
}

function persist() {
  try {
    const completed = [...progress].sort((a, b) => a - b);
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, completed }));
    status.hidden = true;
    return true;
  } catch {
    status.textContent = "Chyba ukladania. Exportuj zálohu.";
    status.hidden = false;
    return false;
  }
}

function hideToast() {
  toast.hidden = true;
}

function showToast(message, undo = false) {
  const text = document.createElement("span");
  text.textContent = message;
  toast.replaceChildren(text);
  if (undo) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Späť";
    button.addEventListener("click", () => {
      if (!previousProgress) return;
      if (!replaceProgress(new Set(previousProgress))) return;
      previousProgress = null;
      hideToast();
    });
    toast.append(button);
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

/** Commit a change only when it can be saved, retaining one level of undo. */
function replaceProgress(next) {
  const before = progress;
  progress = next;
  if (!persist()) {
    progress = before;
    refresh();
    showToast("Zmeny sa nepodarilo uložiť");
    return false;
  }
  previousProgress = before;
  refresh();
  return true;
}

/** Restore reading and parent checkbox states, including partially read sections. */
function refresh() {
  document.getElementById("total-count").textContent =
    progress.size + " / " + total;
  for (const input of readingInputs) {
    input.checked = progress.has(Number(input.dataset.id));
  }
  for (const input of scopeInputs) {
    const ids = idsOf(input);
    const count = ids.filter((id) => progress.has(id)).length;
    input.checked = count === ids.length;
    input.indeterminate = count > 0 && count < ids.length;
    input.title = count + " / " + ids.length;
  }
}

function changeScope(input) {
  const ids = idsOf(input);
  const checked = input.checked;
  const name = input.getAttribute("aria-label");
  if (
    input.dataset.type === "part" &&
    !confirm(
      name +
        ": naozaj chceš " +
        (checked ? "označiť" : "odznačiť") +
        " všetky čítania?",
    )
  ) {
    refresh();
    return;
  }

  const next = new Set(progress);
  for (const id of ids) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  if (!replaceProgress(next)) return;
  if (ids.length > 1)
    showToast(name + (checked ? " označené" : " odznačené"), true);
  else hideToast();
}

function exportProgress() {
  const payload = {
    app: APP_ID,
    version: 1,
    exportedAt: new Date().toISOString(),
    completed: [...progress].sort((a, b) => a - b),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download =
    "bible-reading-progress-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  backupMenu.open = false;
}

async function importProgress(file) {
  if (!file) return;
  try {
    const value = JSON.parse(await file.text());
    if (value?.app !== APP_ID || !validProgress(value)) {
      throw new Error("Neplatný formát zálohy alebo ID čítania");
    }
    if (
      !confirm(
        "Import nahradí aktuálny postup (" +
          progress.size +
          " čítaní) zálohou (" +
          value.completed.length +
          " čítaní). Pokračovať?",
      )
    )
      return;
    if (replaceProgress(new Set(value.completed)))
      showToast("Záloha obnovená", true);
  } catch (error) {
    alert("Import zlyhal: " + error.message);
  } finally {
    fileInput.value = "";
    backupMenu.open = false;
  }
}

/** Enhance the static document; reading content never depends on JavaScript. */
function init() {
  progress = readLocal();
  if (partId === 0) {
    let next = 1;
    while (next <= total && progress.has(next)) next++;
    const partIndex = partEnds.findIndex((end) => next <= end);
    const part = partIndex === -1 ? partEnds.length : partIndex + 1;
    location.replace("./part-" + part + ".html");
    return;
  }

  refresh();
  for (const input of [...readingInputs, ...scopeInputs])
    input.disabled = false;
  document.querySelector(".progress-tools").hidden = false;
  document.body.addEventListener("change", (event) => {
    if (event.target.matches("input.check")) changeScope(event.target);
  });
  document.getElementById("export").addEventListener("click", exportProgress);
  document
    .getElementById("import")
    .addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () =>
    importProgress(fileInput.files?.[0]),
  );
  window.addEventListener("storage", (event) => {
    if (event.key !== STORE_KEY && event.key !== null) return;
    progress = readLocal();
    refresh();
  });
}
init();
