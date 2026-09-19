import { excelWeekNumber } from './core.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function excelDate(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, 12);
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
    ['Period', null, null, new Date(year, month - 1, 1, 12)],
    [], [], [],
    ['Week', 'Date', '', 'hours', 'Task description'],
    [],
  ];

  for (const day of model.days) {
    const date = excelDate(day.day);
    rows.push([
      excelWeekNumber(day.day),
      date,
      DAYS[date.getDay()],
      day.roundedSeconds ? day.roundedSeconds / 3600 : null,
      day.combined,
    ]);
  }

  rows.push([]);
  const totalRow = rows.length + 1;
  const firstDayRow = 10;
  const lastDayRow = firstDayRow + model.days.length - 1;
  rows.push(['Period total', null, null, null, 'hour']);

  const sheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
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
  workbook.CalcPr = { fullCalcOnLoad: true, forceFullCalc: true, calcMode: 'auto' };
  return workbook;
}

export function outputFileName(employee, period) {
  return `${period} hours ${safeFileName(employee)}.xlsx`;
}

export function periodLabel(period) {
  const [year, month] = period.split('-').map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}
