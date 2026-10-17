# Pipeline explorer

Open `index.html` in a browser. It is self-contained and works offline.

- **Stages** shows stage entry points, transfer models and actual in-memory payload handoffs.
- **Major functions** adds public operations and context methods, grouped by stage. Private helpers and small utilities are omitted.
- Click a block to inspect its role, fields/signature and Python source. Incoming arrows turn teal; outgoing arrows turn purple; unrelated arrows fade.
- Click an arrow to inspect the handoff. Click a connection in the inspector to follow it.
- Drag to pan, scroll to zoom, or click the minimap. Stage buttons jump to a stage; search also finds blocks available only in the detailed view.
- `F` fits the whole map, `R` switches to a readable size, `/` focuses search, and `Escape` clears the selection. A double-click centers a block.

The map follows the current `run_pipeline.run_stages()` implementation, its exports, and the additional correction path in `demo_den_haag_hs`. It does not depict the proposed CorrectionsInput/CorrectionsOutput contracts as existing code. The inspector explains ignored/unused return values and separates graph QA from correction QA.

Model fields, function signatures, source snippets and source locations are extracted from Python source when generating the page. The conceptual map and arrow descriptions are authored in `build.py`; update them when the pipeline changes. The page records its source commit and does not update itself.

Regenerate from the repository root (requires the project's Python and Graphviz `dot`):

```bash
.venv/bin/python output/pipeline-explorer/build.py
```

`template.html` contains the browser interface; `style.css` is embedded during generation. The dark palette and controls follow `/home/nex/coding/webdev/_cdn/artifacts/edit-stage-v2-demo.html`, with larger labels and stronger arrows. `stages.dot` / `functions.dot` are editable Graphviz sources; their corresponding `.svg` files are static exports.
