import { excelWeekNumber } from './core.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Read tracker rows without letting Excel's date display format or local timezone change timestamps. */
export function readTrackerRows(XLSX, sheet) {
  const formatted = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true, UTC: true });
  return raw.map((row, index) => {
    for (const [key, value] of Object.entries(row)) {
      // Duration cells need their elapsed-time format, rather than a calendar date.
      if (key.trim().toLowerCase() === 'duration') {
        row[key] = formatted[index][key];
      } else if (value instanceof Date) {
        row[key] = value.toISOString().slice(0, -1);
      }
    }
    return row;
  });
}

export function excelSerial(day) {
  const [year, month, date] = day.split('-').map(Number);
  return (Date.UTC(year, month - 1, date) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

function weekday(day) {
  const [year, month, date] = day.split('-').map(Number);
  return DAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()];
}

export function safeFileName(value) {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ');
}

export function buildWorkbook(XLSX, { employee, company, period, model }) {
  const [year, month] = period.split('-').map(Number);
  const rows = [
    [],
    ['Name Employee', null, null, employee],
    ['Company', null, null, company],
    ['Period', null, null, excelSerial(`${year}-${String(month).padStart(2, '0')}-01`)],
    [], [], [],
    ['Week', 'Date', '', 'hours', 'Task description'],
    [],
  ];

  for (const day of model.days) {
    rows.push([
      excelWeekNumber(day.day),
      excelSerial(day.day),
      weekday(day.day),
      day.roundedSeconds ? day.roundedSeconds / 3600 : null,
      day.combined,
    ]);
  }

  rows.push([]);
  const totalRow = rows.length + 1;
  const firstDayRow = 10;
  const lastDayRow = firstDayRow + model.days.length - 1;
  rows.push(['Period total', null, null, null, 'hour']);

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet.D4.z = 'mmmm yyyy';
  for (let row = firstDayRow; row <= lastDayRow; row += 1) {
    sheet[`B${row}`].z = 'd mmmm';
    if (sheet[`D${row}`]) sheet[`D${row}`].z = '0.00';
  }
  sheet[`D${totalRow}`] = { t: 'n', f: `SUM(D${firstDayRow}:D${lastDayRow})`, v: model.totalSeconds / 3600, z: '0.00' };
  sheet['!cols'] = [{ wch: 9 }, { wch: 15 }, { wch: 7 }, { wch: 10 }, { wch: 82 }];
  sheet['!autofilter'] = { ref: `A8:E${lastDayRow}` };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'timesheet');
  return workbook;
}

export function outputFileName(employee, period) {
  return `${period} hours ${safeFileName(employee)}.xlsx`;
}

export function periodLabel(period) {
  const [year, month] = period.split('-').map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}
