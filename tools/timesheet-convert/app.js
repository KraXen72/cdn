import {
  DESCRIPTION_LIMIT,
  buildMonthModel,
  combineDescriptions,
  excelWeekNumber,
  formatDuration,
  inferPeriod,
  normalizeRecords,
} from './core.js';
import { buildWorkbook, outputFileName, periodLabel } from './workbook.js';

const $ = id => document.getElementById(id);
const state = { records: [], selections: new Map(), resolved: new Set(), loadVersion: 0 };
const dateFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });

function currentModel() {
  if (!state.records.length || !$('period').value) return null;
  return buildMonthModel(state.records, $('period').value, $('prefix').value, state.selections);
}

function displayDate(day) {
  const [year, month, date] = day.split('-').map(Number);
  return dateFormatter.format(new Date(Date.UTC(year, month - 1, date)));
}

function setStatus(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function resetReviews() {
  state.selections = new Map();
  state.resolved = new Set();
}

function renderOverflow(model) {
  const notice = $('overflow');
  notice.replaceChildren();
  notice.hidden = !model?.overflow.length;
  if (!model?.overflow.length) return;
  const strong = document.createElement('strong');
  strong.textContent = 'Records outside this period will be omitted. ';
  const details = model.overflow.map(group => {
    const label = periodLabel(group.month);
    return `${group.count} ${group.count === 1 ? 'record' : 'records'} (${formatDuration(group.seconds)}) in ${label}`;
  }).join('; ');
  notice.append(strong, document.createTextNode(`${details}. Re-export those records for their own month.`));
}

function renderFindings(model) {
  const host = $('findings');
  host.replaceChildren();
  const findings = model.days.filter(day => combineDescriptions(day.descriptions, $('prefix').value).length > DESCRIPTION_LIMIT);
  $('findings-section').hidden = !findings.length;

  for (const day of findings) {
    if (!state.selections.has(day.day)) state.selections.set(day.day, new Set(day.descriptions));
    const selected = state.selections.get(day.day);
    const article = document.createElement('article');
    article.className = 'finding';

    const head = document.createElement('div');
    head.className = 'finding-head';
    const title = document.createElement('h3');
    title.textContent = displayDate(day.day);
    const count = document.createElement('span');
    count.className = 'count';
    head.append(title, count);
    article.append(head);

    const options = document.createElement('div');
    for (const description of day.descriptions) {
      const label = document.createElement('label');
      label.className = 'choice';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(description);
      const text = document.createElement('span');
      text.textContent = description;
      checkbox.addEventListener('change', () => {
        checkbox.checked ? selected.add(description) : selected.delete(description);
        state.resolved.delete(day.day);
        render();
      });
      label.append(checkbox, text);
      options.append(label);
    }
    article.append(options);

    const actions = document.createElement('div');
    actions.className = 'finding-actions';
    const resolved = document.createElement('span');
    resolved.className = 'resolved';
    resolved.textContent = state.resolved.has(day.day) ? 'Resolved' : 'Review required';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = state.resolved.has(day.day) ? 'Reopen' : 'Mark resolved';
    button.addEventListener('click', () => {
      state.resolved.has(day.day) ? state.resolved.delete(day.day) : state.resolved.add(day.day);
      render();
    });
    actions.append(resolved, button);
    article.append(actions);

    const length = combineDescriptions(day.descriptions.filter(description => selected.has(description)), $('prefix').value).length;
    count.textContent = `${length} / ${DESCRIPTION_LIMIT} characters`;
    count.classList.add(length <= DESCRIPTION_LIMIT ? 'ok' : 'over');
    host.append(article);
  }
  return findings;
}

function renderPreview(model) {
  const body = $('preview');
  body.replaceChildren();
  if (!model) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 5;
    cell.className = 'empty';
    cell.textContent = 'No export loaded';
    $('preview-total').hidden = true;
    return;
  }
  for (const day of model.days) {
    const date = new Date(`${day.day}T12:00:00Z`);
    const row = body.insertRow();
    const values = [
      excelWeekNumber(day.day),
      displayDate(day.day),
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()],
      day.roundedSeconds ? (day.roundedSeconds / 3600).toFixed(2) : '',
      day.combined,
    ];
    for (const value of values) row.insertCell().textContent = value;
  }
  $('preview-total').hidden = false;
  $('total-hours').textContent = (model.totalSeconds / 3600).toFixed(2);
}

function render() {
  const model = currentModel();
  renderOverflow(model);
  const findings = model ? renderFindings(model) : [];
  renderPreview(model);
  const unresolved = findings.filter(day => !state.resolved.has(day.day)).length;
  const employeeMissing = !$('employee').value.trim();
  $('download').disabled = !model || !model.included.length || unresolved > 0 || employeeMissing;
  if (!model) {
    $('summary').textContent = 'The monthly timesheet will appear here.';
  } else {
    const hours = (model.totalSeconds / 3600).toFixed(2);
    $('summary').textContent = `${periodLabel($('period').value)} · ${model.included.length} records · ${hours} rounded hours${unresolved ? ` · ${unresolved} finding${unresolved === 1 ? '' : 's'} left` : ''}`;
  }
}

async function loadFile(file, version) {
  if (!window.XLSX) throw new Error('The spreadsheet library could not load. Check your connection and reload.');
  if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error('Choose a CSV or XLSX file.');
  if (!file.size) throw new Error('This file is empty.');
  const isCsv = /\.csv$/i.test(file.name);
  const content = isCsv ? await file.text() : await file.arrayBuffer();
  if (version !== state.loadVersion) return null;
  const workbook = window.XLSX.read(content, { type: isCsv ? 'string' : 'array', raw: true, cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const records = normalizeRecords(rows);
  if (!records.length) throw new Error('No rows with a valid start date and duration were found.');
  return records;
}

$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  const version = ++state.loadVersion;
  state.records = [];
  resetReviews();
  $('period').disabled = true;
  render();
  if (!file) { setStatus('Choose a file to begin.'); return; }
  setStatus('Reading your export…');
  try {
    const records = await loadFile(file, version);
    if (!records) return;
    state.records = records;
    $('period').value = inferPeriod(records);
    $('period').disabled = false;
    setStatus(`Loaded ${file.name}. Deduced ${periodLabel($('period').value)} from ${records.length} records.`);
    render();
  } catch (error) {
    state.records = [];
    setStatus(`Could not import the file. ${error.message}`, true);
    render();
  }
});

for (const id of ['employee', 'company']) $(id).addEventListener('input', render);
$('prefix').addEventListener('input', () => { state.resolved = new Set(); render(); });
$('period').addEventListener('input', () => { resetReviews(); render(); });

$('download').addEventListener('click', () => {
  try {
    const model = currentModel();
    if (!model) throw new Error('Import a tracker export first.');
    const workbook = buildWorkbook(window.XLSX, {
      employee: $('employee').value.trim(),
      company: $('company').value.trim(),
      period: $('period').value,
      model,
    });
    const filename = outputFileName($('employee').value, $('period').value);
    window.XLSX.writeFile(workbook, filename, { bookType: 'xlsx', compression: true, cellDates: true });
    setStatus(`Created ${filename}.`);
  } catch (error) {
    setStatus(`Could not create the workbook. ${error.message}`, true);
  }
});

render();
