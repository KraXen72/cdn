# Timesheet converter

Converts a Simple Time Tracker CSV/XLSX export into the monthly Excel layout used
by Scenwise. The generated filename includes the employee name.

## Development

```sh
npm install
npm run dev
```

Run the logic tests with `npm test`.

GitHub Pages can serve this directory directly. Production uses SheetJS 0.20.3
from its official CDN, so a build step is not required.

## Conversion rules

- The period is inferred by comparing the export's first/last current-year dates
  with every calendar month's start/end. The closest month wins; the period can
  be overridden.
- Records outside the selected period are omitted and summarized in a warning.
- Exact tracked time is summed per day, then rounded to the nearest 15 minutes.
  An exact 7½-minute midpoint rounds up. Rounding happens once per day, so it
  does not compound across individual timer entries.
- Duplicate daily descriptions are removed case-insensitively and the retained
  descriptions are joined with `; `.
- Combined descriptions over 130 characters become findings. Each can be edited
  through checkboxes and explicitly resolved, even while still over the limit.
- The workbook contains one row for every calendar day and a `SUM` formula in the
  period-total cell.
