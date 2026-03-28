/**
 * ui.js — Browser UI wiring for the PDF → Automaton extractor
 * Imports shared logic from extractor.js, wires DOM events, renders Graphviz SVG.
 */
import * as pdfjsLib from 'pdfjs-dist';
import { PathExtractor, analyzeGraph, generateDOT, generatePlain } from './extractor.js';
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
      if (_panZoomInstance) { _panZoomInstance.resize(); _panZoomInstance.fit(); _panZoomInstance.center(); }
    });
    _panZoomRO.observe(preview);
  } catch (e) {
    preview.innerHTML = `<span class="gv-error">Graphviz error: ${e.message}</span>`;
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
    ctx.strokeStyle = n.accepting ? '#4ecdc4' : '#e8a428';
    ctx.lineWidth   = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();
    if (n.accepting) {
      ctx.beginPath(); ctx.arc(cx, cy, r*0.82, 0, Math.PI*2); ctx.stroke();
    }
    if (n.label) {
      const fs = Math.max(9, Math.min(13, r * 0.65));
      ctx.font         = `bold ${fs}px IBM Plex Mono`;
      ctx.fillStyle    = n.accepting ? '#4ecdc4' : '#e8a428';
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
    const page     = await pdfDoc.getPage(num);
    const scale    = 1.6;
    const viewport = page.getViewport({ scale });

    const pdfC = $('pdf-canvas'), ovC = $('overlay-canvas'), ci = $('canvas-inner');
    pdfC.width = ovC.width = viewport.width;
    pdfC.height = ovC.height = viewport.height;
    ci.style.width  = viewport.width  + 'px';
    ci.style.height = viewport.height + 'px';
    pdfC.style.display = ovC.style.display = 'block';

    const ctx = pdfC.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pdfC.width, pdfC.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    $('page-info').textContent = `${Math.round(viewport.width)} × ${Math.round(viewport.height)} px`;

    const opList      = await page.getOperatorList();
    const extractor   = new PathExtractor(pdfjsLib.OPS);
    const paths       = extractor.extract(opList.fnArray, opList.argsArray);
    const textContent = await page.getTextContent();
    const result      = analyzeGraph(paths, textContent.items);

    drawOverlay(result, viewport);
    $('legend').classList.add('show');

    const dot   = generateDOT(result);
    const plain = generatePlain(result);
    showOutput('dot',   dot);
    showOutput('plain', plain);
    renderDebug(result);
    $('debug-content').style.display   = 'block';
    $('debug-placeholder').style.display = 'none';

    // Render graph (non-blocking)
    renderGraphviz(dot);

    setStatus(
      `Page ${num}: ${result.stats.nodes} nodes · ${result.stats.edges} edges · ${result.confidence}% confidence`,
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
$('page-sel').addEventListener('change', e => analyzePage(+e.target.value));
$('analyze-btn').addEventListener('click', () => analyzePage(+$('page-sel').value));
$('reload-btn').addEventListener('click', () => {
  pdfDoc = null;
  $('toolbar').classList.remove('show');
  $('legend').classList.remove('show');
  $('dropzone').classList.remove('hidden');
  $('pdf-canvas').style.display = $('overlay-canvas').style.display = 'none';
  $('canvas-inner').style.display = 'none';
  ['dot', 'plain'].forEach(t => {
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
