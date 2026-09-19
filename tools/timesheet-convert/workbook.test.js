import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { buildMonthModel } from './core.js';
import { buildWorkbook, outputFileName } from './workbook.js';

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
  assert.equal(sheet.A8.v, 'Week');
  assert.equal(sheet.E8.v, 'Task description');
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
  const bytes = XLSX.write(original, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  const roundTripped = XLSX.read(bytes, { type: 'buffer', cellDates: true });
  const sheet = roundTripped.Sheets.timesheet;

  assert.equal(sheet.D2.v, 'Test Person');
  assert.equal(sheet.D10.v, 1);
  assert.equal(sheet.D41.f, 'SUM(D10:D39)');
  assert.equal(sheet.D41.v, 1);
});
