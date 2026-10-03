# Timesheet converter

Converts a Simple Time Tracker CSV/XLSX export into the monthly Excel layout used
by Scenwise. The generated filename includes the employee name.

## Development

```sh
npm install
npm run dev
```

Run the logic/workbook tests with `npm test`. For browser regression tests,
install Chromium once with `npx playwright install chromium`, then run
`npm run test:browser`. Browser tests use the installed SheetJS library and
synthetic exports, so they do not depend on the CDN or private timesheets.

Run `npm run build` to produce a production bundle in `dist/`.

GitHub Pages can serve this directory directly. Production uses SheetJS 0.20.3
from its official CDN, so a build step is not required.

## Conversion rules

- The period is inferred by comparing the export's first/last current-year dates
  with every calendar month's start/end. The closest month wins; the period can
  be overridden.
- Records outside the selected period are omitted and summarized in a warning.
- Records crossing midnight are split between their calendar days, including
  across month/year boundaries. Each portion retains the description. With a
  start time but no usable end time, the duration determines the split; without
  a start time, the duration stays on the supplied date. Timestamps are treated
  as local clock values without timezone conversion. Supported text timestamps
  are `YYYY-MM-DD HH:mm[:ss[.SSS]]` (a `T` separator also works); Excel date cells
  retain their calendar values regardless of their display format or browser
  timezone. Numeric minute values retain their underlying precision.
- Rows without a valid start date/time and usable duration are skipped and
  counted in the import status. Explicit zero durations are valid.
- Exact tracked time is summed per day, then rounded to the nearest 15 minutes.
  An exact 7½-minute midpoint rounds up. Rounding happens once per day, so it
  does not compound across individual timer entries.
- Duplicate daily descriptions are removed case-insensitively and the retained
  descriptions are joined with `; `.
- Combined descriptions over 130 characters become findings. Each can be edited
  through checkboxes and explicitly resolved, even while still over the limit.
  Resolving collapses the finding to its date and character count. The arrow
  toggles inspection without changing its resolved status; the eye reopens it
  and expands the checkboxes for editing.
- The workbook contains one row for every calendar day and a `SUM` formula in the
  period-total cell.
