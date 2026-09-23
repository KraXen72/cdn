import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonthModel,
  combineDescriptions,
  describeOverflow,
  excelWeekNumber,
  inferPeriod,
  normalizeRecords,
  roundDailySeconds,
  uniqueDescriptions,
} from './core.js';

test('normalizes tracker rows and prefers exact timestamps over truncated minutes', () => {
  const records = normalizeRecords([{
    'time started': '2026-08-28 11:23:40',
    'time ended': '2026-08-28 13:14:55',
    comment: '  technical   document  ',
    duration: '1:51:15',
    'duration minutes': '111',
  }]);
  assert.deepEqual(records, [{ day: '2026-08-28', seconds: 6675, description: 'technical document', sourceRow: 2 }]);
});

test('infers September when records run from 2 September through 3 October', () => {
  const records = [
    { day: '2026-09-02', seconds: 900, description: '' },
    { day: '2026-10-03', seconds: 900, description: '' },
  ];
  assert.equal(inferPeriod(records, 2026), '2026-09');
});

test('infers August for the supplied export span', () => {
  const records = [
    { day: '2026-08-14', seconds: 900, description: '' },
    { day: '2026-09-08', seconds: 900, description: '' },
  ];
  assert.equal(inferPeriod(records, 2026), '2026-08');
});

test('rounds the combined daily total to the nearest quarter hour, midpoint up', () => {
  assert.equal(roundDailySeconds(7 * 60 + 29), 0);
  assert.equal(roundDailySeconds(7 * 60 + 30), 900);
  assert.equal(roundDailySeconds(22 * 60 + 29), 900);
  assert.equal(roundDailySeconds(22 * 60 + 30), 1800);
});

test('deduplicates descriptions case-insensitively while retaining first spelling', () => {
  assert.deepEqual(uniqueDescriptions([
    { description: 'Research' },
    { description: 'research' },
    { description: 'Meeting' },
  ]), ['Research', 'Meeting']);
});

test('joins selected descriptions with a single prefix', () => {
  assert.equal(combineDescriptions(['Research', 'Meeting'], 'AITCIM: '), 'AITCIM: Research; Meeting');
  assert.equal(combineDescriptions([], 'AITCIM: '), '');
});

test('builds all calendar days, applies selections, and totals rounded day values', () => {
  const records = [
    { day: '2026-08-01', seconds: 901, description: 'A' },
    { day: '2026-08-01', seconds: 899, description: 'B' },
    { day: '2026-08-02', seconds: 8 * 60, description: 'C' },
  ];
  const selections = new Map([['2026-08-01', new Set(['B'])]]);
  const model = buildMonthModel(records, '2026-08', 'P: ', selections);
  assert.equal(model.days.length, 31);
  assert.equal(model.days[0].roundedSeconds, 1800);
  assert.equal(model.days[0].combined, 'P: B');
  assert.equal(model.totalSeconds, 2700);
});

test('summarizes omitted records by month', () => {
  assert.deepEqual(describeOverflow([
    { day: '2026-09-30', seconds: 900 },
    { day: '2026-10-01', seconds: 1800 },
    { day: '2026-10-03', seconds: 900 },
  ], '2026-09'), [{ month: '2026-10', count: 2, seconds: 2700 }]);
});

test('matches Excel WEEKNUM return type 1 used by the template', () => {
  assert.equal(excelWeekNumber('2026-08-01'), 31);
  assert.equal(excelWeekNumber('2026-08-03'), 32);
});
