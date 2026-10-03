import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';

const headers = ['time started', 'time ended', 'comment', 'duration minutes'];
const overnight = ['2026-09-30 23:30:00', '2026-10-01 01:00:00', 'Overnight work', 90];

/** Build a synthetic tracker export using the same columns for CSV and XLSX. */
function exportFile(rows, format = 'csv', name = `export.${format}`) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'export');
  return { name, mimeType: format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(workbook, { type: 'buffer', bookType: format }) };
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-04T12:00:00Z'));
  // Keep browser tests independent of the CDN while using the production library version.
  await page.route('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', route =>
    route.fulfill({ path: new URL('../node_modules/xlsx/dist/xlsx.full.min.js', import.meta.url).pathname,
      contentType: 'application/javascript' }));
  await page.goto('/');
  await page.locator('#employee').fill('Test Person');
});

for (const format of ['csv', 'xlsx']) {
  test(`${format} overnight import retains dates, hours, descriptions and workbook totals`, async ({ page }) => {
    await page.locator('#file').setInputFiles(exportFile([overnight], format));
    await expect(page.locator('#period')).toBeEnabled();
    for (const [period, previewRow, dayRow, date, hours, totalRow, lastDayRow] of [
      ['2026-09', 29, 39, '30 September', 0.5, 41, 39],
      ['2026-10', 0, 10, '1 October', 1, 42, 40],
    ]) {
      await page.locator('#period').fill(period);
      const cells = page.locator('#preview tr').nth(previewRow).locator('td');
      await expect(cells.nth(1)).toHaveText(date);
      await expect(cells.nth(3)).toHaveText(hours.toFixed(2));
      await expect(cells.nth(4)).toHaveText('AITCIM: Overnight work');
      await expect(page.locator('#total-hours')).toHaveText(hours.toFixed(2));
      const pending = page.waitForEvent('download');
      await page.locator('#download').click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe(`${period} hours Test Person.xlsx`);
      const workbook = XLSX.read(await readFile(await download.path()), { type: 'buffer' });
      const sheet = workbook.Sheets.timesheet;
      expect(sheet[`D${dayRow}`].v).toBe(hours);
      expect(sheet[`E${dayRow}`].v).toBe('AITCIM: Overnight work');
      expect(sheet[`D${totalRow}`].v).toBe(hours);
      expect(sheet[`D${totalRow}`].f).toBe(`SUM(D10:D${lastDayRow})`);
    }
  });
}

test('clears review findings when the period is cleared or a new import fails', async ({ page }) => {
  const file = exportFile([['2026-09-15 10:00:00', '2026-09-15 11:00:00', 'Long description '.repeat(12)]]);
  await page.locator('#file').setInputFiles(file);
  await expect(page.locator('#findings-section')).toBeVisible();
  await page.locator('#period').fill('');
  await expect(page.locator('#findings-section')).toBeHidden();
  await page.locator('#period').fill('2026-09');
  await expect(page.locator('#findings-section')).toBeVisible();
  await page.locator('#file').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
  await expect(page.locator('#status')).toContainText('Could not import');
  await expect(page.locator('#findings-section')).toBeHidden();
  await expect(page.locator('#download')).toBeDisabled();
});

for (const outcome of ['resolve', 'reject']) {
  test(`an older upload cannot replace a newer upload when it ${outcome}s`, async ({ page }) => {
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function () {
        if (this.name === 'old.csv') return new Promise((resolve, reject) => {
          window.finishOldUpload = { resolve, reject };
        });
        return original.call(this);
      };
    });
    await page.locator('#file').setInputFiles(exportFile([['2026-09-10 10:00:00', '2026-09-10 11:00:00', 'Old work']], 'csv', 'old.csv'));
    await page.waitForFunction(() => Boolean(window.finishOldUpload));
    await page.locator('#file').setInputFiles(exportFile([overnight], 'xlsx', 'new.xlsx'));
    await expect(page.locator('#status')).toContainText('Loaded new.xlsx');
    await page.evaluate(outcome => {
      if (outcome === 'reject') window.finishOldUpload.reject(new Error('Old upload failed'));
      else window.finishOldUpload.resolve('time started,time ended,comment\n2026-09-10 10:00:00,2026-09-10 11:00:00,Old work\n');
    }, outcome);
    await expect(page.locator('#status')).toContainText('Loaded new.xlsx');
    await expect(page.locator('#preview tr')).toHaveCount(30);
    await expect(page.locator('#total-hours')).toHaveText('0.50');
    await expect(page.locator('#download')).toBeEnabled();
  });
}

test('reports skipped malformed rows without inventing zero-hour records', async ({ page }) => {
  await page.locator('#file').setInputFiles(exportFile([
    overnight,
    ['2026-09-15 10:00:00', '', 'Missing duration', ''],
    ['2026-09-15 25:00:00', '', 'Invalid clock', 60],
  ]));
  await expect(page.locator('#status')).toContainText('Skipped 2 rows');
  await expect(page.locator('#preview tr').nth(14).locator('td').nth(4)).toHaveText('');
  await expect(page.locator('#total-hours')).toHaveText('0.50');
});

test('imports Excel date cells independently of their display format and browser timezone', async ({ page }) => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    [new Date('2026-09-30T23:30:00Z'), new Date('2026-10-01T01:00:00Z'), 'Date cells', 90],
    [new Date('2026-09-15T12:00:00Z'), null, 'Duration cell', null, 1.5 / 24],
  ], { UTC: true });
  sheet.E1 = { t: 's', v: 'duration' };
  sheet.A2.z = sheet.B2.z = sheet.A3.z = 'm/d/yy h:mm';
  sheet.E3.z = '[h]:mm:ss';
  XLSX.utils.book_append_sheet(workbook, sheet, 'export');
  await page.locator('#file').setInputFiles({ name: 'date-cells.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) });
  await expect(page.locator('#period')).toBeEnabled();
  await page.locator('#period').fill('2026-09');
  await expect(page.locator('#preview tr').nth(29).locator('td').nth(3)).toHaveText('0.50');
  await expect(page.locator('#preview tr').nth(14).locator('td').nth(3)).toHaveText('1.50');
  await expect(page.locator('#total-hours')).toHaveText('2.00');
});

test('reviews overnight descriptions independently for each day and resets review state on import', async ({ page }) => {
  const description = 'Long description '.repeat(12).trim();
  await page.locator('#file').setInputFiles(exportFile([
    ['2026-09-15 23:30:00', '2026-09-16 01:00:00', description],
  ]));
  await expect(page.locator('.finding')).toHaveCount(2);
  await expect(page.locator('#download')).toBeDisabled();
  await page.getByRole('button', { name: 'Mark resolved' }).first().click();
  await expect(page.locator('#download')).toBeDisabled();
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.locator('#download')).toBeEnabled();
  await page.getByRole('button', { name: 'Inspect 15 September' }).click();
  await expect(page.locator('.finding').first().getByRole('checkbox')).toBeDisabled();
  await expect(page.locator('#download')).toBeEnabled();
  await page.getByRole('button', { name: 'Reopen 15 September' }).click();
  await expect(page.locator('#download')).toBeDisabled();
  await page.locator('.finding').first().getByRole('checkbox').uncheck();
  await expect(page.locator('#preview tr').nth(14).locator('td').nth(4)).toHaveText('');
  await expect(page.locator('#preview tr').nth(15).locator('td').nth(4)).toHaveText(`AITCIM: ${description}`);
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.locator('#download')).toBeEnabled();
  await page.locator('#file').setInputFiles(exportFile([overnight], 'xlsx'));
  await expect(page.locator('#findings-section')).toBeHidden();
  await expect(page.locator('#download')).toBeEnabled();
});
