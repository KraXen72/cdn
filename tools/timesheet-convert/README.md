# Timesheet Prefixer

Open `index.html` in a browser or serve this repository with `python3 -m http.server`.
No build or backend is needed. SheetJS 0.20.3 loads from its official CDN.

Import a Simple Time Tracker CSV or XLSX export, choose a worksheet and column,
and edit the prefix (default `AITCIM: `). Description is preferred, then Comment.
The first populated row is the header. Entirely empty rows are left untouched;
empty cells in populated data rows receive the prefix. Multiline prefixing and
skipping existing prefixes are enabled by default and can be switched off.
The original/output toggle only changes the preview, not the download.

CSV values remain literal text to preserve leading zeros and prevent formula
interpretation. XLSX cells outside the chosen column retain their values,
formulas and number formats. The chosen column becomes text when a nonempty
prefix is applied. Other worksheets are retained. Advanced Excel objects and
styling are not guaranteed to survive a SheetJS round trip. This tool is intended
for plain timesheet exports, not complex Excel templates.

The scrollable preview shows the first 500 data rows; export includes all rows.
Local CSV and XLSX files in this directory are gitignored because they may
contain private timesheet data. The Pages workflow publishes tracked files only.

## Verification

Check both export formats: import, inspect the selected Comment column, download,
and reopen the XLSX. Verify descriptions have the prefix while dates, durations,
and other fields retain their original values and XLSX number formats. Also check
multiline descriptions, existing prefixes, blank cells, an empty prefix, switching
columns/worksheets, invalid input, and a narrow viewport. All transformation runs
in the browser; loading a file does not issue an upload request.
