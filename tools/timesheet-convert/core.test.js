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

test('does not invent time from blank, malformed, or overflowing durations', () => {
  for (const duration of ['', ' ', '0:99:99', '1:60:00', '1:00:60', `${'9'.repeat(310)}:00:00`]) {
    assert.deepEqual(normalizeRecords([{ date: '2026-09-15', duration, 'duration minutes': '' }]), [], duration);
  }
  for (const minutes of ['', ' ', null, false, -1, -0.000001, 'NaN', Infinity, '1e308']) {
    assert.deepEqual(normalizeRecords([{ date: '2026-09-15', 'duration minutes': minutes }]), [], String(minutes));
  }
  assert.equal(normalizeRecords([{ date: '2026-09-15', 'duration minutes': '0' }])[0].seconds, 0);
  assert.equal(normalizeRecords([{ date: '2026-09-15', 'duration minutes': '7.5' }])[0].seconds, 450);
  assert.deepEqual(normalizeRecords([{
    'time started': '2026-09-15 23:30:00', duration: `${'9'.repeat(310)}:00:00`,
  }]), []);
  assert.deepEqual(normalizeRecords([{
    'time started': '2026-09-15 23:30:00', 'duration minutes': '1e308',
  }]), []);
});

test('rejects invalid calendar dates and clock values instead of rolling them forward', () => {
  for (const start of ['2026-09-15 25:00:00', '2026-09-15 12:60:00', '2026-09-15 12:00:60', '2026-02-29 10:00:00', '2026-09-15 10:00:00junk']) {
    assert.deepEqual(normalizeRecords([{ 'time started': start, duration: '1:00:00' }]), [], start);
  }
  assert.deepEqual(normalizeRecords([{
    'time started': '2026-09-30 23:30:00', 'time ended': '2026-09-31 01:00:00',
  }]), []);
  assert.deepEqual(normalizeRecords([{
    'time started': '2026-09-30 23:30:00', 'time ended': '2026-09-31 01:00:00', duration: '0:15:00',
  }]), [{ day: '2026-09-30', seconds: 900, description: '', sourceRow: 2 }]);
});

test('uses nonempty fallback columns for dates and descriptions', () => {
  assert.deepEqual(normalizeRecords([{
    'Time Started': ' ', Date: '2026-09-15', duration: '1:00:00', comment: '', description: ' Research ',
  }, {
    date: '', day: '2026-09-16', duration: '1:00:00', comment: null, description: ' ', 'task description': 'Meeting',
  }]), [
    { day: '2026-09-15', seconds: 3600, description: 'Research', sourceRow: 2 },
    { day: '2026-09-16', seconds: 3600, description: 'Meeting', sourceRow: 3 },
  ]);
});

test('preserves fractional seconds on both sides of midnight', () => {
  assert.deepEqual(normalizeRecords([{
    'time started': '2026-09-15T23:59:59.500', 'time ended': '2026-09-16T00:00:00.500',
  }]), [
    { day: '2026-09-15', seconds: 0.5, description: '', sourceRow: 2 },
    { day: '2026-09-16', seconds: 0.5, description: '', sourceRow: 2 },
  ]);
});

test('splits overnight and multi-day records while preserving descriptions and exact seconds', () => {
  const cases = [
    ['2026-09-15 23:30:00', '2026-09-16 01:00:00', [['2026-09-15', 1800], ['2026-09-16', 3600]]],
    ['2026-09-30 23:30:00', '2026-10-01 01:00:00', [['2026-09-30', 1800], ['2026-10-01', 3600]]],
    ['2026-12-31 23:30:00', '2027-01-01 01:00:00', [['2026-12-31', 1800], ['2027-01-01', 3600]]],
    ['2028-02-28 23:30:00', '2028-03-01 01:00:00', [['2028-02-28', 1800], ['2028-02-29', 86400], ['2028-03-01', 3600]]],
    ['2026-09-15 23:59:40', '2026-09-16 00:00:15', [['2026-09-15', 20], ['2026-09-16', 15]]],
    ['2026-09-15 23:30:00', '2026-09-16 00:00:00', [['2026-09-15', 1800]]],
    ['2026-09-16 00:00:00', '2026-09-16 01:00:00', [['2026-09-16', 3600]]],
    ['2026-09-16 00:00:00', '2026-09-16 00:00:00', [['2026-09-16', 0]]],
  ];
  for (const [start, end, expected] of cases) {
    const records = normalizeRecords([{
      'time started': start, 'time ended': end, comment: '  Overnight   work ',
      'duration minutes': '1',
    }]);
    assert.deepEqual(records, expected.map(([day, seconds]) => ({
      day, seconds, description: 'Overnight work', sourceRow: 2,
    })), `${start} → ${end}`);
  }
});

test('splits fallback durations when a start time is available', () => {
  for (const fallback of [
    { duration: '1:30:00' },
    { 'duration minutes': '90' },
    { 'time ended': '2026-09-15 22:00:00', duration: '1:30:00' },
  ]) {
    assert.deepEqual(normalizeRecords([{ 'time started': '2026-09-15 23:30:00', ...fallback }]), [
      { day: '2026-09-15', seconds: 1800, description: '', sourceRow: 2 },
      { day: '2026-09-16', seconds: 3600, description: '', sourceRow: 2 },
    ]);
  }
  assert.deepEqual(normalizeRecords([{ date: '2026-09-15', duration: '25:00:00' }]), [
    { day: '2026-09-15', seconds: 90000, description: '', sourceRow: 2 },
  ]);
});

test('combines overnight portions with other entries before rounding each day', () => {
  const records = normalizeRecords([
    { 'time started': '2026-09-15 23:52:30', 'time ended': '2026-09-16 00:07:29', comment: 'Work' },
    { 'time started': '2026-09-15 12:00:00', duration: '0:07:29', comment: 'work' },
    { 'time started': '2026-09-16 12:00:00', duration: '0:00:01', comment: 'Other' },
  ]);
  const model = buildMonthModel(records, '2026-09');
  assert.equal(model.days[14].exactSeconds, 899);
  assert.equal(model.days[14].roundedSeconds, 900);
  assert.equal(model.days[14].combined, 'Work');
  assert.equal(model.days[15].exactSeconds, 450);
  assert.equal(model.days[15].roundedSeconds, 900);
  assert.equal(model.days[15].combined, 'Work; Other');
  assert.equal(model.totalSeconds, 1800);
});

test('filters only the portions outside the selected month, including year boundaries', () => {
  for (const [start, end, firstPeriod, secondPeriod] of [
    ['2026-09-30 23:30:00', '2026-10-01 01:00:00', '2026-09', '2026-10'],
    ['2026-12-31 23:30:00', '2027-01-01 01:00:00', '2026-12', '2027-01'],
  ]) {
    const records = normalizeRecords([{ 'time started': start, 'time ended': end, comment: 'Work' }]);
    const first = buildMonthModel(records, firstPeriod);
    const second = buildMonthModel(records, secondPeriod);
    assert.equal(first.days.at(-1).exactSeconds, 1800);
    assert.equal(first.days.at(-1).combined, 'Work');
    assert.equal(second.days[0].exactSeconds, 3600);
    assert.equal(second.days[0].combined, 'Work');
    assert.equal(first.totalSeconds + second.totalSeconds, 5400);
    assert.deepEqual(first.overflow, [{ month: secondPeriod, count: 1, seconds: 3600 }]);
    assert.deepEqual(second.overflow, [{ month: firstPeriod, count: 1, seconds: 1800 }]);
  }
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

const keepOvernight = { keepOvernightOnStartDay: true };
const tracked = (start, end, comment = 'Work') => ({ 'time started': start, 'time ended': end, comment });

test('option keeps exact overnight time and descriptions in the starting month or year', () => {
  for (const [start, end, day] of [
    ['2026-09-30 21:00:00', '2026-10-01 01:00:00', '2026-09-30'],
    ['2026-12-31 21:00:00', '2027-01-01 01:00:00', '2026-12-31'],
    ['2026-09-15 23:59:59.500', '2026-09-16 00:00:00.500', '2026-09-15'],
  ]) {
    const rows = [tracked(start, end)];
    const split = normalizeRecords(rows);
    const kept = normalizeRecords(rows, keepOvernight);
    assert.deepEqual(kept, [{ day, seconds: split.reduce((sum, record) => sum + record.seconds, 0), description: 'Work', sourceRow: 2 }]);
    assert.deepEqual(buildMonthModel(kept, day.slice(0, 7)).overflow, []);
    assert.deepEqual(normalizeRecords(rows, { keepOvernightOnStartDay: false }), split);
  }
});

test('cap includes other rows regardless of export order, accepts exactly 16 hours and rejects one second over', () => {
  for (const duration of ['12:00:00', '12:00:01']) {
    const overnight = tracked('2026-09-30 21:00:00', '2026-10-01 01:00:00');
    const daytime = { date: '2026-09-30', duration, comment: 'Other' };
    for (const rows of [[overnight, daytime], [daytime, overnight]]) {
      const records = normalizeRecords(rows, keepOvernight);
      const model = buildMonthModel(records, '2026-09');
      if (duration === '12:00:00') {
        assert.equal(model.days.at(-1).exactSeconds, 16 * 3600);
        assert.deepEqual(model.overflow, []);
      } else {
        assert.deepEqual(records, normalizeRecords(rows));
        assert.equal(model.days.at(-1).exactSeconds, 15 * 3600 + 1);
        assert.equal(model.overflow[0].seconds, 3600);
      }
    }
  }
});

test('multiple overnight records share the daily cap without losing time or source descriptions', () => {
  const rows = [
    { date: '2026-09-15', duration: '12:00:00', comment: 'Day work' },
    tracked('2026-09-15 23:00:00', '2026-09-16 01:00:00', 'First'),
    tracked('2026-09-15 23:00:00', '2026-09-16 02:00:00', 'Second'),
  ];
  const records = normalizeRecords(rows, keepOvernight);
  assert.deepEqual(records.map(({ day, seconds }) => [day, seconds]), [
    ['2026-09-15', 12 * 3600], ['2026-09-15', 2 * 3600],
    ['2026-09-15', 3600], ['2026-09-16', 2 * 3600],
  ]);
  assert.equal(records.reduce((sum, record) => sum + record.seconds, 0), 17 * 3600);
  assert.equal(buildMonthModel(records, '2026-09').days[14].combined, 'Day work; First; Second');
});

test('chronological moves free later daily capacity while preserving source order', () => {
  const records = normalizeRecords([
    tracked('2026-09-16 21:00:00', '2026-09-17 01:00:00', 'Later'),
    tracked('2026-09-15 23:00:00', '2026-09-16 01:00:00', 'Earlier'),
    { date: '2026-09-16', duration: '12:00:00' },
  ], keepOvernight);
  assert.deepEqual(records.map(({ day, seconds }) => [day, seconds]), [
    ['2026-09-16', 4 * 3600], ['2026-09-15', 2 * 3600], ['2026-09-16', 12 * 3600],
  ]);
});

test('fallback overnight durations follow the option; multi-day and over-cap days retain their time', () => {
  assert.equal(normalizeRecords([{ 'time started': '2026-09-30 21:00:00', duration: '4:00:00' }], keepOvernight)[0].seconds, 4 * 3600);
  for (const rows of [
    [tracked('2026-09-15 23:00:00', '2026-09-17 01:00:00')],
    [{ date: '2026-09-15', duration: '17:00:00' }, tracked('2026-09-15 23:00:00', '2026-09-16 01:00:00')],
    [tracked('2026-09-15 21:00:00', '2026-09-16 00:00:00')],
  ]) assert.deepEqual(normalizeRecords(rows, keepOvernight), normalizeRecords(rows));
});
