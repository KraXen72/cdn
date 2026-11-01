# Two-year Bible reading plan

Static GitHub Pages app at https://kraxen72.github.io/cdn/tools/2-year-bible-plan/

- Four half-year pages share `app.js`, `style.css`, and `plan.json`.
- 518 independently stored reading checkboxes from the Blue Letter Bible Two-Year Canonical Five-Day Plan.
- 104 Slovak editorial weekly notes and Slovak Ecumenical Translation book names.
- Calendar weeks are Monday through Sunday, starting 2 November 2026.
- Parent checkboxes toggle all readings in a week, month (organizational 4-4-5 grouping), or half-year. Mixed states appear indeterminate.
- Progress saves on every change using `localStorage` key `kraxen-bible-plan-progress-v1`.
- Backup menu supports full JSON export/import with validation, explicit replacement confirmation, and undo.
- The top-level URL forwards to the part containing the first incomplete reading.
- No backend, authentication, build tooling, analytics, or third-party scripts.

**Important:** localStorage is per browser/device and can be cleared. Export a JSON backup occasionally, especially before switching phones or browsers.

Source: https://www.blueletterbible.org/assets-v3/pdf/dbrp/2Yr_CanonicalFiveDayPlan.pdf

