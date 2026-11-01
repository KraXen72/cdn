# Two-year Bible reading plan

Static GitHub Pages site: https://kraxen72.github.io/cdn/tools/2-year-bible-plan/

The four files in `markdown/` are the content source. `build.py` uses
[markdown-it-py](https://github.com/executablebooks/markdown-it-py) to render them
into `part-1.html` through `part-4.html`, using `page.html.template` and
`style.css`. Content styles reproduce the shared Obsidian note's Inter font,
Flexoki colors, heading sizes, information callout, blockquotes, and task lists.
The font is hosted locally; its license is in `fonts/LICENSE.txt`.

`app.js` is the only script included by each page. It enhances the generated
checkboxes with section toggles, local progress saving, and JSON backups. All
reading content and part navigation work without JavaScript; checkboxes remain
disabled in that case. There are no runtime dependencies or content fetches.

## Rebuild

Install [uv](https://docs.astral.sh/uv/), then run from the repository root:

```sh
uv run tools/2-year-bible-plan/build.py
```

uv installs the pinned Markdown renderer in an isolated cache automatically.
To refresh the checked-in sources from the original Obsidian folder and rebuild:

```sh
uv run tools/2-year-bible-plan/build.py \
  --source '/mnt/c/Blackhole/10-19 personal/2-year bible reading plan'
```

Review and commit the Markdown and generated HTML together. GitHub Pages serves
the checked-in output directly; it needs no build step. A separate repo is not
needed for this small generator. To preview locally:

```sh
python -m http.server 8765
# http://localhost:8765/tools/2-year-bible-plan/part-1.html
```

## Progress compatibility

- All 518 reading IDs and the existing `kraxen-bible-plan-progress-v1` storage
  key are preserved, as is the version 1 JSON backup format.
- Each half-year, month, and week has a checkbox that toggles its readings.
  Partially read sections show a mixed state. Half-year changes ask for
  confirmation; bulk changes and imports offer undo.
- All four pages share progress. The index opens the part containing the first
  incomplete reading. Completing the whole plan opens Part 4.
- Imports validate the format and reading IDs, and ask before replacing progress.
  Failed saves roll back the visible change and display an error.
- IDs follow the original five-reading weekly order, ending with three readings
  in Week 104. The build rejects changed counts or order that would break this
  mapping. Preserve passage order when editing; moving passages requires an
  explicit progress migration.
- localStorage is per browser/device and can be cleared. Export backups before
  switching browsers or devices. No backend or account is required.

The Markdown preserves the original English headings and instructions, Slovak
passage names, and 104 Slovak editorial weekly notes. Organizational months use
4-4-5 weeks, starting Monday, 2 November 2026.

Reading assignments: [Blue Letter Bible Two-Year Canonical Five-Day Plan](https://www.blueletterbible.org/assets-v3/pdf/dbrp/2Yr_CanonicalFiveDayPlan.pdf).

## Browser verification

With the preview server running and `playwright-cli` installed, use a separate
browser session for the integration checks:

```sh
playwright-cli -s=bible-test open http://localhost:8765/tools/2-year-bible-plan/part-1.html
playwright-cli -s=bible-test run-code --filename=tools/2-year-bible-plan/test-browser.js
playwright-cli -s=bible-test close
```

The checks cover section toggles, mixed states, persistence, routing, backup
validation and roundtrips, undo, cross-tab sync, failed saves, mobile overflow,
and content without JavaScript. Temporary backups and screenshots go to `/tmp`.
