export const DESCRIPTION_LIMIT = 130;

const MS_PER_DAY = 86_400_000;

/** Extract a valid calendar date from a date or timestamp string. */
export function dateKey(value) {
  const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function timestampMs(value) {
  const match = String(value ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) return null;
  const [, day, hour, minute, second = '0', fraction = '0'] = match;
  if (!dateKey(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return utcDay(day) + Number(hour) * 3_600_000 + Number(minute) * 60_000 + Number(second) * 1000 + Number(fraction.padEnd(3, '0'));
}

function durationSeconds(row, started, ended) {
  if (started !== null && ended !== null && ended >= started) return (ended - started) / 1000;
  const parts = String(row.duration ?? '').trim().match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (parts && Number(parts[2]) < 60 && Number(parts[3]) < 60) {
    const seconds = Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]);
    if (Number.isSafeInteger(seconds * 1000)) return seconds;
  }
  const rawMinutes = row['duration minutes'];
  if (!['string', 'number'].includes(typeof rawMinutes) || String(rawMinutes).trim() === '') return null;
  const minutes = Number(rawMinutes);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const milliseconds = Math.round(minutes * 60_000);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : null;
}

function firstNonempty(...values) {
  return values.map(value => String(value ?? '').trim()).find(Boolean) ?? '';
}

/** Split tracker records into calendar days, preserving exact time before daily rounding. */
export function normalizeRecords(rows) {
  return rows.flatMap((source, index) => {
    const row = Object.fromEntries(Object.entries(source).map(([key, value]) => [key.trim().toLowerCase(), value]));
    const startValue = firstNonempty(row['time started'], row.date, row.day);
    const day = dateKey(startValue);
    const started = timestampMs(startValue);
    const ended = timestampMs(row['time ended']);
    const seconds = durationSeconds(row, started, ended);
    if (!day || (started === null && startValue !== day) || seconds === null) return [];
    const description = firstNonempty(row.comment, row.description, row['task description']).replace(/\s+/g, ' ');
    // SheetJS retains the zero-based source row even when it omits blank rows.
    const record = { day, seconds, description, sourceRow: (source.__rowNum__ ?? index + 1) + 1 };
    if (started === null || seconds === 0) return [record];

    // Export timestamps are local clock values. UTC arithmetic preserves their
    // calendar dates independently of the browser's timezone.
    const end = started + seconds * 1000;
    // Reject unrepresentable dates before splitting, so malformed durations
    // cannot drive an unbounded loop or produce unsupported year strings.
    if (!Number.isSafeInteger(end) || end > Date.UTC(10000, 0, 1)) return [];
    const entries = [];
    for (let cursor = started; cursor < end;) {
      const nextMidnight = (Math.floor(cursor / MS_PER_DAY) + 1) * MS_PER_DAY;
      const segmentEnd = Math.min(nextMidnight, end);
      entries.push({
        ...record,
        day: new Date(cursor).toISOString().slice(0, 10),
        seconds: (segmentEnd - cursor) / 1000,
      });
      cursor = segmentEnd;
    }
    return entries;
  });
}

function utcDay(key) {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function inferPeriod(records, currentYear = new Date().getFullYear()) {
  const dated = records.filter(({ day }) => Number(day.slice(0, 4)) === currentYear).sort((a, b) => a.day.localeCompare(b.day));
  if (!dated.length) throw new Error(`No records dated ${currentYear} were found.`);
  const first = dated[0].day;
  const last = dated.at(-1).day;
  const candidates = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const start = `${currentYear}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(Date.UTC(currentYear, month, 0));
    const end = `${currentYear}-${String(month).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
    const score = Math.abs(utcDay(first) - utcDay(start)) / MS_PER_DAY + Math.abs(utcDay(last) - utcDay(end)) / MS_PER_DAY;
    const inside = dated.filter(record => record.day.startsWith(start.slice(0, 7))).length;
    return { key: start.slice(0, 7), score, inside };
  });
  candidates.sort((a, b) => a.score - b.score || b.inside - a.inside || a.key.localeCompare(b.key));
  return candidates[0].key;
}

export function roundDailySeconds(seconds) {
  return Math.floor(seconds / 900 + 0.5) * 900;
}

export function uniqueDescriptions(records) {
  const seen = new Set();
  const result = [];
  for (const { description } of records) {
    if (!description) continue;
    const key = description.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(description);
  }
  return result;
}

export function daysInPeriod(period) {
  const [year, month] = period.split('-').map(Number);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${period}-${String(index + 1).padStart(2, '0')}`);
}

export function groupPeriod(records, period) {
  const included = records.filter(record => record.day.startsWith(period));
  const byDay = new Map(daysInPeriod(period).map(day => [day, []]));
  for (const record of included) byDay.get(record.day)?.push(record);
  return { included, byDay };
}

export function describeOverflow(records, period) {
  const groups = new Map();
  for (const record of records) {
    const month = record.day.slice(0, 7);
    if (month === period) continue;
    const group = groups.get(month) ?? { month, count: 0, seconds: 0 };
    group.count += 1;
    group.seconds += record.seconds;
    groups.set(month, group);
  }
  return [...groups.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function combineDescriptions(descriptions, prefix = '') {
  if (!descriptions.length) return '';
  return `${prefix}${descriptions.join('; ')}`;
}

export function buildMonthModel(records, period, prefix = '', selections = new Map()) {
  const { included, byDay } = groupPeriod(records, period);
  const days = [...byDay].map(([day, entries]) => {
    const descriptions = uniqueDescriptions(entries);
    const selected = selections.get(day) ?? new Set(descriptions);
    const chosen = descriptions.filter(description => selected.has(description));
    const exactSeconds = entries.reduce((sum, record) => sum + record.seconds, 0);
    return {
      day,
      exactSeconds,
      roundedSeconds: exactSeconds ? roundDailySeconds(exactSeconds) : 0,
      descriptions,
      selected: chosen,
      combined: combineDescriptions(chosen, prefix),
    };
  });
  return {
    days,
    included,
    totalSeconds: days.reduce((sum, day) => sum + day.roundedSeconds, 0),
    overflow: describeOverflow(records, period),
  };
}

export function excelWeekNumber(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const dayOfYear = Math.floor((date - yearStart) / MS_PER_DAY);
  return Math.floor((dayOfYear + yearStart.getUTCDay()) / 7) + 1;
}

export function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours ? `${hours}h ` : ''}${remainder}m`.trim() || '0m';
}
