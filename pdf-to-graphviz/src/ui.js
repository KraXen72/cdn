/**
 * ui.js — Browser UI wiring for the PDF → Automaton extractor
 * Imports shared logic from extractor.js, wires DOM events, renders Graphviz SVG.
 */
import * as pdfjsLib from 'pdfjs-dist';
import { PathExtractor, analyzeGraph, analyzeGraphs, generateDOT, generatePlain, generateAutomaton, generateMermaid } from './extractor.js';
import svgPanZoom from 'svg-pan-zoom';

// pdfjs worker — Vite will copy the worker to the output
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ── DOM helpers ────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function setStatus(msg, state = '') {
  $('status-msg').textContent = msg;
  $('status-dot').className = state;
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${name}`));
}
document.querySelectorAll('.tab-btn').forEach(b =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ── Graphviz rendering ─────────────────────────────────────────
// @viz-js/viz is loaded via CDN script tag in index.html, exposes Viz global
let _vizInstance = null;
async function getViz() {
  if (!_vizInstance) {
    if (typeof Viz === 'undefined') throw new Error('Viz.js not loaded (CDN script missing)');
    _vizInstance = await Viz.instance();
  }
  return _vizInstance;
}

let _panZoomInstance = null;
let _panZoomRO = null;

async function renderGraphviz(dotString) {
  const preview = $('graph-preview');
  if (!preview) return;

  // Destroy previous pan-zoom instance before wiping the DOM
  if (_panZoomInstance) {
    try { _panZoomInstance.destroy(); } catch (_) {}
    _panZoomInstance = null;
  }
  if (_panZoomRO) { _panZoomRO.disconnect(); _panZoomRO = null; }

  preview.innerHTML = '<span class="gv-loading">Rendering graph…</span>';
  try {
    const viz    = await getViz();
    const engine = $('engine-sel')?.value ?? 'dot';
    const svgEl  = viz.renderSVGElement(dotString, { engine });
    // svg-pan-zoom needs explicit dimensions to fill the container
    svgEl.setAttribute('width',  '100%');
    svgEl.setAttribute('height', '100%');
    svgEl.style.display = 'block';
    preview.innerHTML = '';
    preview.appendChild(svgEl);

    _panZoomInstance = svgPanZoom(svgEl, {
      zoomEnabled:          true,
      panEnabled:           true,
      controlIconsEnabled:  true,
      fit:                  true,
      center:               true,
      minZoom:              0.1,
      maxZoom:              20,
      zoomScaleSensitivity: 0.3,
    });

    // Keep pan-zoom in sync when the split pane is resized
    _panZoomRO = new ResizeObserver(() => {
      try {
        if (_panZoomInstance) { _panZoomInstance.resize(); _panZoomInstance.fit(); _panZoomInstance.center(); }
      } catch (_) { /* SVGMatrix may be non-invertible if element is hidden/zero-size */ }
    });
    _panZoomRO.observe(preview);
  } catch (e) {
    preview.innerHTML = `<span class="gv-error">Graphviz error: ${e.message}</span>`;
  }
}

// ── Mermaid rendering ──────────────────────────────────────────
let _mermaidLib = null;
async function getMermaid() {
  if (!_mermaidLib) {
    const mod = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
    _mermaidLib = mod.default;
    _mermaidLib.initialize({ startOnLoad: false, theme: 'default' });
  }
  return _mermaidLib;
}

async function renderMermaid(result) {
  const mmd = generateMermaid(result);
  const out = $('mermaid-out');
  out.value = mmd;
  out.style.display = 'block';
  $('mermaid-placeholder').style.display = 'none';

  const preview = $('mermaid-preview');
  preview.innerHTML = '';

  try {
    const mermaid = await getMermaid();
    // mermaid.render() needs a scratch element in the DOM
    const scratch = document.createElement('div');
    scratch.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden';
    document.body.appendChild(scratch);
    const id = 'mermaid-render-' + Date.now();
    const { svg } = await mermaid.render(id, mmd, scratch);
    document.body.removeChild(scratch);
    preview.innerHTML = svg;
    // Make the SVG responsive
    const svgEl = preview.querySelector('svg');
    if (svgEl) { svgEl.style.maxWidth = '100%'; svgEl.style.height = 'auto'; }
  } catch (e) {
    preview.innerHTML = `<pre style="color:red;font-size:11px;white-space:pre-wrap;padding:8px">${e.message}</pre>`;
  }
}

// ── Overlay drawing ────────────────────────────────────────────
function drawOverlay(result, viewport) {
  const canvas = $('overlay-canvas');
  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const vp = ({x, y}) => viewport.convertToViewportPoint(x, y);

  // Edge paths (dashed overlay)
  for (const e of result.edges) {
    ctx.strokeStyle = e.isInitial ? 'rgba(168,230,207,0.75)' : 'rgba(78,205,196,0.55)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    let started = false;
    for (const s of e.segments) {
      if (s.type === 'M') {
        const [cx, cy] = vp({x:s.x, y:s.y}); ctx.moveTo(cx, cy); started = true;
      } else if (s.type === 'L' && started) {
        const [cx, cy] = vp({x:s.x, y:s.y}); ctx.lineTo(cx, cy);
      } else if (s.type === 'C' && started) {
        const [x1,y1] = vp({x:s.x1, y:s.y1}), [x2,y2] = vp({x:s.x2, y:s.y2}), [ex,ey] = vp({x:s.x, y:s.y});
        ctx.bezierCurveTo(x1, y1, x2, y2, ex, ey);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (e.mid && e.label) {
      const [mx, my] = vp(e.mid);
      const tw = ctx.measureText(e.label).width;
      ctx.font = '10px IBM Plex Mono';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(12,15,22,0.75)';
      ctx.fillRect(mx - tw/2 - 3, my - 8, tw + 6, 14);
      ctx.fillStyle = 'rgba(232,164,40,0.9)';
      ctx.fillText(e.label, mx, my);
    }
  }

  // Arrowhead markers
  for (const ah of result.arrowheads) {
    const [cx, cy] = vp(ah);
    ctx.fillStyle = 'rgba(255,107,107,0.85)';
    ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI*2); ctx.fill();
  }

  // Nodes
  for (const n of result.nodes) {
    const [cx, cy] = vp({x:n.x, y:n.y});
    const r = n.r * viewport.scale;
    const nodeColor = n.accepting ? '#4ecdc4' : '#e8a428';
    ctx.fillStyle   = nodeColor;
    ctx.strokeStyle = nodeColor;
    ctx.lineWidth   = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    if (n.accepting) {
      ctx.beginPath(); ctx.arc(cx, cy, r*0.82, 0, Math.PI*2); ctx.stroke();
    }
    if (n.label) {
      const fs = Math.max(9, Math.min(13, r * 0.65));
      ctx.font         = `bold ${fs}px IBM Plex Mono`;
      ctx.fillStyle    = '#0c0f16';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.label, cx, cy);
    }
  }
}

// ── Debug panel ────────────────────────────────────────────────
function renderDebug(result) {
  const { nodes, edges, stats, textGroups, confidence, medR } = result;
  const confColor = confidence>75 ? 'var(--teal)' : confidence>40 ? 'var(--amber)' : 'var(--red)';
  const unassigned = textGroups.filter(g => !g.assigned);

  $('debug-content').innerHTML = `
    <div class="dbg-section">
      <h3>Detection Summary</h3>
      <div class="stat-grid">
        <div class="stat-cell"><div class="stat-label">Nodes</div><div class="stat-value">${stats.nodes}</div></div>
        <div class="stat-cell"><div class="stat-label">Edges</div><div class="stat-value">${stats.edges}</div></div>
        <div class="stat-cell"><div class="stat-label">Arrowheads</div><div class="stat-value">${stats.arrowheads}</div></div>
        <div class="stat-cell"><div class="stat-label">Raw circles</div><div class="stat-value">${stats.rawCircles}</div></div>
      </div>
      <div class="confidence-bar-wrap">
        <div class="confidence-label">Endpoint resolution: ${confidence}%</div>
        <div class="confidence-bar">
          <div class="confidence-fill" style="width:${confidence}%;background:${confColor}"></div>
        </div>
      </div>
      <div class="dbg-row" style="margin-top:8px">
        Med. node radius: <b>${medR.toFixed(1)}</b> PDF units · snap: <b>${(medR*2.2).toFixed(1)}</b>
      </div>
    </div>
    <div class="dbg-section">
      <h3>Nodes (${nodes.length})</h3>
      ${nodes.map((n,i) => `
        <div class="dbg-row">[${i}] <b>"${n.label}"</b> @ (${n.x.toFixed(1)},${n.y.toFixed(1)}) r=${n.r.toFixed(1)}
          ${n.accepting ? '<span class="tag-acc">⊛ accepting</span>' : ''}
        </div>`).join('') || '<div class="dbg-row">No nodes detected</div>'}
    </div>
    <div class="dbg-section">
      <h3>Edges (${edges.length})</h3>
      ${edges.map((e,i) => {
        const fl = e.isInitial ? '▶ [initial]' : (e.from>=0 ? `"${nodes[e.from]?.label}"` : '"?"');
        const tl = e.to>=0 ? `"${nodes[e.to]?.label}"` : '"?"';
        const warn = (e.from<0&&!e.isInitial)||e.to<0 ? '<span class="tag-warn">⚠ unresolved</span>' : '';
        const slf  = e.isSelf ? '<span class="tag-init">↺ self-loop</span>' : '';
        return `<div class="dbg-row">[${i}] ${fl} → ${tl}${e.label ? ` <b>"${e.label}"</b>` : ''}${warn}${slf}</div>`;
      }).join('') || '<div class="dbg-row">No edges detected</div>'}
    </div>
    <div class="dbg-section">
      <h3>Unassigned Text (${unassigned.length})</h3>
      ${unassigned.map(g => `
        <div class="dbg-row">"<b>${g.text}</b>" @ (${g.x.toFixed(1)},${g.y.toFixed(1)})</div>
      `).join('') || '<div class="dbg-row" style="color:var(--teal)">✓ All text groups assigned</div>'}
    </div>`;
}

// ── Main flow ──────────────────────────────────────────────────
let pdfDoc = null;
const BASE_SCALE = 1.6;
let pdfZoom = 1.0;
let currentPage = null;
let currentResults = [];
let currentGraphIdx = 0;

async function renderAtZoom() {
  if (!currentPage || !currentResults.length) return;
  const result = currentResults[currentGraphIdx];
  const scale    = BASE_SCALE * pdfZoom;
  const viewport = currentPage.getViewport({ scale });

  const pdfC = $('pdf-canvas'), ovC = $('overlay-canvas'), ci = $('canvas-inner');
  pdfC.width = ovC.width = viewport.width;
  pdfC.height = ovC.height = viewport.height;
  ci.style.width  = viewport.width  + 'px';
  ci.style.height = viewport.height + 'px';
  pdfC.style.display = ovC.style.display = 'block';

  const ctx = pdfC.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, pdfC.width, pdfC.height);
  await currentPage.render({ canvasContext: ctx, viewport }).promise;

  $('page-info').textContent = `${Math.round(viewport.width)} × ${Math.round(viewport.height)} px`;
  $('zoom-label').textContent = Math.round(pdfZoom * 100) + '%';

  drawOverlay(result, viewport);
}

function buildGraphTabs(results) {
  const bar = $('graph-tabs-bar');
  const container = $('graph-tabs');
  container.innerHTML = '';
  if (results.length <= 1) {
    bar.classList.remove('show');
    return;
  }
  bar.classList.add('show');
  results.forEach((r, i) => {
    const btn = document.createElement('button');
    btn.className = 'graph-tab-btn' + (i === 0 ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    btn.textContent = `Graph ${i + 1}`;
    btn.title = `${r.nodes.length} nodes · ${r.edges.length} edges · ${r.confidence}% confidence`;
    btn.addEventListener('click', () => selectGraph(i));
    container.appendChild(btn);
  });
}

function selectGraph(idx) {
  currentGraphIdx = idx;
  // Update tab active state
  $('graph-tabs').querySelectorAll('.graph-tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === idx);
    btn.setAttribute('aria-selected', i === idx ? 'true' : 'false');
  });
  const result = currentResults[idx];
  const dot       = generateDOT(result);
  const plain     = generatePlain(result);
  const automaton = generateAutomaton(result);
  showOutput('dot',       dot);
  showOutput('plain',     plain);
  showOutput('automaton', automaton);
  renderDebug(result);
  renderGraphviz(dot);
  renderMermaid(result);
  // Redraw overlay
  if (currentPage) {
    const scale    = BASE_SCALE * pdfZoom;
    const viewport = currentPage.getViewport({ scale });
    drawOverlay(result, viewport);
  }
}

async function loadPDF(file) {
  setStatus('Loading PDF…', 'busy');
  try {
    const data = await file.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;

    const sel = $('page-sel');
    sel.innerHTML = '';
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const o = document.createElement('option');
      o.value = i; o.textContent = `Page ${i}`;
      sel.appendChild(o);
    }
    $('toolbar').classList.add('show');
    $('dropzone').classList.add('hidden');
    $('canvas-inner').style.display = 'block';
    setStatus(`PDF loaded — ${pdfDoc.numPages} page(s)`, 'ok');
    await analyzePage(1);
  } catch (e) {
    setStatus('Load error: ' + e.message, 'err');
    console.error(e);
  }
}

async function analyzePage(num) {
  if (!pdfDoc) return;
  setStatus(`Analyzing page ${num}…`, 'busy');
  try {
    const page = await pdfDoc.getPage(num);
    currentPage = page;
    currentGraphIdx = 0;

    // Run analysis at base scale (geometry is scale-independent)
    const viewport = page.getViewport({ scale: BASE_SCALE });

    const opList      = await page.getOperatorList();
    const extractor   = new PathExtractor(pdfjsLib.OPS);
    const paths       = extractor.extract(opList.fnArray, opList.argsArray);
    const textContent = await page.getTextContent();
    currentResults    = analyzeGraphs(paths, textContent.items);

    // Build graph tabs (hidden if only one graph)
    buildGraphTabs(currentResults);

    // Render canvas at current zoom
    await renderAtZoom();
    $('legend').classList.add('show');

    const result = currentResults[0];
    const dot       = generateDOT(result);
    const plain     = generatePlain(result);
    const automaton = generateAutomaton(result);
    showOutput('dot',       dot);
    showOutput('plain',     plain);
    showOutput('automaton', automaton);
    renderDebug(result);
    $('debug-content').style.display    = 'block';
    $('debug-placeholder').style.display = 'none';

    renderGraphviz(dot);

    const graphCount = currentResults.length;
    const totalNodes = currentResults.reduce((s, r) => s + r.stats.nodes, 0);
    const totalEdges = currentResults.reduce((s, r) => s + r.stats.edges, 0);
    setStatus(
      graphCount > 1
        ? `Page ${num}: ${graphCount} graphs · ${totalNodes} nodes · ${totalEdges} edges`
        : `Page ${num}: ${result.stats.nodes} nodes · ${result.stats.edges} edges · ${result.confidence}% confidence`,
      'ok'
    );
  } catch (e) {
    setStatus('Analysis error: ' + e.message, 'err');
    console.error(e);
  }
}

function showOutput(type, text) {
  $(`${type}-placeholder`).style.display = 'none';
  const ta = $(`${type}-out`);
  ta.style.display = 'block';
  ta.value = text;
}

// ── Event wiring ───────────────────────────────────────────────
$('copy-dot').addEventListener('click', () => {
  const v = $('dot-out').value;
  if (!v) return;
  navigator.clipboard.writeText(v).then(() => {
    setStatus('DOT copied ✓', 'ok');
    setTimeout(() => setStatus('Ready', 'ok'), 2000);
  });
});
$('copy-plain').addEventListener('click', () => {
  const v = $('plain-out').value;
  if (!v) return;
  navigator.clipboard.writeText(v).then(() => {
    setStatus('Text copied ✓', 'ok');
    setTimeout(() => setStatus('Ready', 'ok'), 2000);
  });
});
$('copy-automaton').addEventListener('click', () => {
  const v = $('automaton-out').value;
  if (!v) return;
  navigator.clipboard.writeText(v).then(() => {
    setStatus('Automaton copied ✓', 'ok');
    setTimeout(() => setStatus('Ready', 'ok'), 2000);
  });
});
$('copy-mermaid')?.addEventListener('click', () => {
  if ($('mermaid-out').value) navigator.clipboard.writeText($('mermaid-out').value);
});
$('page-sel').addEventListener('change', e => analyzePage(+e.target.value));
$('analyze-btn').addEventListener('click', () => analyzePage(+$('page-sel').value));
$('reload-btn').addEventListener('click', () => {
  pdfDoc = null;
  $('toolbar').classList.remove('show');
  $('legend').classList.remove('show');
  $('graph-tabs-bar').classList.remove('show');
  $('graph-tabs').innerHTML = '';
  currentResults = [];
  currentGraphIdx = 0;
  $('dropzone').classList.remove('hidden');
  $('pdf-canvas').style.display = $('overlay-canvas').style.display = 'none';
  $('canvas-inner').style.display = 'none';
  ['dot', 'plain', 'automaton'].forEach(t => {
    $(`${t}-placeholder`).style.display = '';
    $(`${t}-out`).style.display = 'none';
  });
  $('debug-placeholder').style.display = '';
  $('debug-content').style.display = 'none';
  const preview = $('graph-preview');
  if (preview) preview.innerHTML = '';
  setStatus('Ready — drop a TikZ-compiled PDF to begin', '');
});

$('file-input').addEventListener('change', e => {
  if (e.target.files[0]) loadPDF(e.target.files[0]);
});

const wrap = $('canvas-wrap');
wrap.addEventListener('dragover', e => { e.preventDefault(); $('dropzone').classList.add('dragover'); });
wrap.addEventListener('dragleave', () => $('dropzone').classList.remove('dragover'));
wrap.addEventListener('drop', e => {
  e.preventDefault();
  $('dropzone').classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f?.type === 'application/pdf' || f?.name?.endsWith('.pdf')) loadPDF(f);
  else setStatus('Please drop a PDF file', 'err');
});

// ── Overlay toggle ──────────────────────────────────────────────
$('toggle-overlay-btn').addEventListener('click', () => {
  const ovC = $('overlay-canvas');
  const btn = $('toggle-overlay-btn');
  const nowVisible = ovC.style.display !== 'none';
  ovC.style.display = nowVisible ? 'none' : 'block';
  btn.textContent   = nowVisible ? 'Overlay ✗' : 'Overlay ✓';
  btn.style.opacity = nowVisible ? '0.5' : '';
});

// ── Engine selector → re-render preview ────────────────────────
$('engine-sel').addEventListener('change', () => {
  const dot = $('dot-out').value;
  if (dot) renderGraphviz(dot);
});

// ── PDF canvas zoom ────────────────────────────────────────────
function stepZoom(delta) {
  pdfZoom = Math.min(5, Math.max(0.2, +(pdfZoom + delta).toFixed(2)));
  renderAtZoom();
}
$('zoom-in-btn').addEventListener('click',    () => stepZoom(+0.25));
$('zoom-out-btn').addEventListener('click',   () => stepZoom(-0.25));
$('zoom-reset-btn').addEventListener('click', () => { pdfZoom = 1.0; renderAtZoom(); });

$('canvas-wrap').addEventListener('wheel', e => {
  if (!currentPage) return;
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  stepZoom(e.deltaY < 0 ? +0.15 : -0.15);
}, { passive: false });

// ── Arrow key page navigation ──────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!pdfDoc) return;
  const sel = $('page-sel');
  const cur = +sel.value;
  if (e.key === 'ArrowRight' && cur < pdfDoc.numPages) {
    sel.value = cur + 1;
    analyzePage(cur + 1);
  } else if (e.key === 'ArrowLeft' && cur > 1) {
    sel.value = cur - 1;
    analyzePage(cur - 1);
  }
});

// ── Resizable sidebar ──────────────────────────────────────────
const resizeHandle = $('resize-handle');
let _resizing = false;

resizeHandle.addEventListener('mousedown', e => {
  _resizing = true;
  resizeHandle.classList.add('dragging');
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!_resizing) return;
  const mainEl = document.querySelector('main');
  const mainRect = mainEl.getBoundingClientRect();
  const newW = Math.max(200, Math.min(900, mainRect.right - e.clientX - 4));
  mainEl.style.setProperty('--sidebar-w', newW + 'px');
  if (_panZoomInstance) { _panZoomInstance.resize(); }
});
document.addEventListener('mouseup', () => {
  if (!_resizing) return;
  _resizing = false;
  resizeHandle.classList.remove('dragging');
});
