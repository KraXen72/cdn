import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { buildMonthModel, normalizeRecords } from './core.js';
import { buildWorkbook, excelSerial, outputFileName, readTrackerRows } from './workbook.js';

test('generates the template structure with monthly rows and a formula total', () => {
  const model = buildMonthModel([
    { day: '2026-08-14', seconds: 11_760, description: 'Research' },
  ], '2026-08', 'AITCIM: ');
  const workbook = buildWorkbook(XLSX, {
    employee: 'First Family',
    company: 'Scenwise',
    period: '2026-08',
    model,
  });
  const sheet = workbook.Sheets.timesheet;

  assert.deepEqual(workbook.SheetNames, ['timesheet']);
  assert.equal(sheet.D2.v, 'First Family');
  assert.equal(sheet.D3.v, 'Scenwise');
  assert.equal(sheet.D4.v, excelSerial('2026-08-01'));
  assert.equal(sheet.A8.v, 'Week');
  assert.equal(sheet.E8.v, 'Task description');
  assert.equal(sheet.B10.v, excelSerial('2026-08-01'));
  assert.equal(sheet.B23.v, excelSerial('2026-08-14'));
  assert.equal(sheet.D23.v, 3.25);
  assert.equal(sheet.E23.v, 'AITCIM: Research');
  assert.equal(sheet.D42.f, 'SUM(D10:D40)');
  assert.equal(sheet.D42.v, 3.25);
  assert.equal(outputFileName('First / Family', '2026-08'), '2026-08 hours First - Family.xlsx');
});

test('survives an XLSX write/read round trip with formula and cached total', () => {
  const model = buildMonthModel([
    { day: '2026-09-01', seconds: 3600, description: 'Meeting' },
  ], '2026-09');
  const original = buildWorkbook(XLSX, {
    employee: 'Test Person',
    company: 'Scenwise',
    period: '2026-09',
    model,
  });
  const bytes = XLSX.write(original, { type: 'buffer', bookType: 'xlsx' });
  const roundTripped = XLSX.read(bytes, { type: 'buffer', cellDates: false, cellNF: true });
  const sheet = roundTripped.Sheets.timesheet;

  assert.equal(sheet.D2.v, 'Test Person');
  assert.equal(sheet.D4.v, excelSerial('2026-09-01'));
  assert.equal(sheet.B10.v, excelSerial('2026-09-01'));
  assert.equal(sheet.B39.v, excelSerial('2026-09-30'));
  assert.equal(sheet.D4.z, 'mmmm yyyy');
  assert.equal(sheet.B10.z, 'd mmmm');
  assert.equal(sheet.D10.v, 1);
  assert.equal(sheet.D41.f, 'SUM(D10:D39)');
  assert.equal(sheet.D41.v, 1);
});

test('converts CSV and XLSX overnight exports into separate monthly workbooks', () => {
  const input = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(input, XLSX.utils.aoa_to_sheet([
    ['time started', 'time ended', 'comment', 'duration minutes'],
    ['2026-09-30 23:30:00', '2026-10-01 01:00:00', 'Overnight work', 90],
  ]), 'export');

  for (const bookType of ['csv', 'xlsx']) {
    const content = XLSX.write(input, { type: bookType === 'csv' ? 'string' : 'buffer', bookType });
    const imported = XLSX.read(content, { type: bookType === 'csv' ? 'string' : 'buffer', raw: true, cellDates: true });
    const rows = XLSX.utils.sheet_to_json(imported.Sheets[imported.SheetNames[0]], { defval: '', raw: false });
    const records = normalizeRecords(rows);
    for (const [period, dayRow, hours, totalRow, lastDayRow] of [
      ['2026-09', 39, 0.5, 41, 39],
      ['2026-10', 10, 1, 42, 40],
    ]) {
      const model = buildMonthModel(records, period);
      const workbook = buildWorkbook(XLSX, { employee: 'Test Person', company: 'Scenwise', period, model });
      const output = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      const result = XLSX.read(output, { type: 'buffer' }).Sheets.timesheet;
      assert.equal(result[`D${dayRow}`].v, hours, `${bookType}, ${period}`);
      assert.equal(result[`E${dayRow}`].v, 'Overnight work');
      assert.equal(result[`D${totalRow}`].v, hours);
      assert.equal(result[`D${totalRow}`].f, `SUM(D10:D${lastDayRow})`);
    }
  }
});

test('preserves underlying minute values instead of rounding them through Excel display formats', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['time started', 'duration minutes'],
    ['2026-09-15 10:00:00', 11.49], ['2026-09-15 12:00:00', 11.49],
  ]);
  sheet.B2.z = sheet.B3.z = '0';
  const rows = readTrackerRows(XLSX, sheet);
  assert.equal(rows[0]['duration minutes'], 11.49);
  assert.equal(buildMonthModel(normalizeRecords(rows), '2026-09').days[14].roundedSeconds, 1800);
});

test('imports typed Excel dates and elapsed durations in both Excel date systems', () => {
  for (const date1904 of [false, true]) {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Time Started', 'Time Ended', 'duration'],
      [new Date('2026-09-15T23:52:30Z'), new Date('2026-09-16T00:07:30Z')],
      [new Date('2026-09-17T12:00:00Z'), null, 25.5 / 24],
    ], { UTC: true, date1904 });
    sheet.A2.z = sheet.B2.z = sheet.A3.z = 'm/d/yy h:mm';
    sheet.C3.z = '[h]:mm:ss';
    XLSX.utils.book_append_sheet(workbook, sheet, 'export');
    workbook.Workbook = { WBProps: { date1904 } };
    const parsed = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellDates: true });
    const records = normalizeRecords(readTrackerRows(XLSX, parsed.Sheets.export));
    assert.deepEqual(records.map(({ day, seconds }) => ({ day, seconds })), [
      { day: '2026-09-15', seconds: 450 }, { day: '2026-09-16', seconds: 450 },
      { day: '2026-09-17', seconds: 43200 }, { day: '2026-09-18', seconds: 48600 },
    ]);
  }
});

test('retains source row numbers when blank spreadsheet rows are omitted', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['time started', 'duration minutes'], [], ['2026-09-15 10:00:00', 60],
  ]);
  assert.equal(normalizeRecords(readTrackerRows(XLSX, sheet))[0].sourceRow, 3);
});
