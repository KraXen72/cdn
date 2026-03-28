'use strict';

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
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

// Matrix helpers (PDF: [a,b,c,d,e,f] = [[a,c,e],[b,d,f],[0,0,1]])
function mulMat(m1, m2) {
  return [
    m1[0]*m2[0] + m1[2]*m2[1],
    m1[1]*m2[0] + m1[3]*m2[1],
    m1[0]*m2[2] + m1[2]*m2[3],
    m1[1]*m2[2] + m1[3]*m2[3],
    m1[0]*m2[4] + m1[2]*m2[5] + m1[4],
    m1[1]*m2[4] + m1[3]*m2[5] + m1[5],
  ];
}
function applyMat(m, x, y) {
  return { x: m[0]*x + m[2]*y + m[4], y: m[1]*x + m[3]*y + m[5] };
}

// ═══════════════════════════════════════════════════════════════
// PATH EXTRACTOR
// Replays PDF operator list, tracking CTM, emitting path objects.
// ═══════════════════════════════════════════════════════════════
class PathExtractor {
  constructor(OPS) { this.OPS = OPS; }

  extract(fnArray, argsArray) {
    const OPS = this.OPS;
    const paths = [];
    const stack = [];
    let ctm = [1,0,0,1,0,0];
    let cur = {x:0,y:0};
    let segs = null;

    const tp = (x,y) => applyMat(ctm, x, y);

    const paint = (filled, stroked) => {
      if (segs && segs.length > 0)
        paths.push({ segments: [...segs], filled, stroked });
      segs = null;
    };

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const a  = argsArray[i] || [];

      switch (fn) {
        case OPS.save:    stack.push([...ctm]); break;
        case OPS.restore: if (stack.length) ctm = stack.pop(); break;
        case OPS.transform: ctm = mulMat(ctm, a); break;

        case OPS.moveTo: {
          if (!segs) segs = [];
          const p = tp(a[0],a[1]); cur = p;
          segs.push({type:'M', x:p.x, y:p.y}); break;
        }
        case OPS.lineTo: {
          if (!segs) segs = [];
          const p = tp(a[0],a[1]); cur = p;
          segs.push({type:'L', x:p.x, y:p.y}); break;
        }
        case OPS.curveTo: {
          if (!segs) segs = [];
          const p1=tp(a[0],a[1]), p2=tp(a[2],a[3]), p3=tp(a[4],a[5]); cur=p3;
          segs.push({type:'C', x1:p1.x,y1:p1.y, x2:p2.x,y2:p2.y, x:p3.x,y:p3.y}); break;
        }
        case OPS.curveTo2: { // v — cp1 = current point (BUG FIX: save cur before overwriting)
          if (!segs) segs = [];
          const p2=tp(a[0],a[1]), p3=tp(a[2],a[3]);
          const prev = cur; cur = p3;
          segs.push({type:'C', x1:prev.x,y1:prev.y, x2:p2.x,y2:p2.y, x:p3.x,y:p3.y}); break;
        }
        case OPS.curveTo3: { // y — cp2 = endpoint
          if (!segs) segs = [];
          const p1=tp(a[0],a[1]), p3=tp(a[2],a[3]); cur=p3;
          segs.push({type:'C', x1:p1.x,y1:p1.y, x2:p3.x,y2:p3.y, x:p3.x,y:p3.y}); break;
        }
        case OPS.closePath:
          if (segs) segs.push({type:'Z'}); break;

        case OPS.rectangle: {
          const [rx,ry,rw,rh]=a;
          const p1=tp(rx,ry), p2=tp(rx+rw,ry), p3=tp(rx+rw,ry+rh), p4=tp(rx,ry+rh);
          segs=[{type:'M',...p1},{type:'L',...p2},{type:'L',...p3},{type:'L',...p4},{type:'Z'}];
          break;
        }

        case OPS.stroke:           paint(false,true);  break;
        case OPS.closeStroke:
          if(segs) segs.push({type:'Z'}); paint(false,true); break;
        case OPS.fill:
        case OPS.eoFill:           paint(true,false);  break;
        case OPS.fillStroke:
        case OPS.eoFillStroke:     paint(true,true);   break;
        case OPS.closeFillStroke:
        case OPS.closeEOFillStroke:
          if(segs) segs.push({type:'Z'}); paint(true,true); break;
        case OPS.endPath: segs=null; break;
      }
    }
    return paths;
  }
}

// ═══════════════════════════════════════════════════════════════
// GRAPH ANALYSIS
// ═══════════════════════════════════════════════════════════════

// Fit circle to 4-cubic Bézier path. Returns {x,y,r} or null.
function fitCircle(segs) {
  const pts = segs
    .filter(s => s.type==='M' || s.type==='C')
    .map(s => ({x:s.x, y:s.y}));
  if (pts.length < 4) return null;

  const cx = pts.reduce((s,p)=>s+p.x, 0) / pts.length;
  const cy = pts.reduce((s,p)=>s+p.y, 0) / pts.length;
  const radii = pts.map(p => Math.hypot(p.x-cx, p.y-cy));
  const r = radii.reduce((a,b)=>a+b,0) / radii.length;
  if (r < 3) return null;

  const maxDev = Math.max(...radii.map(ri => Math.abs(ri-r)));
  if (maxDev / r > 0.20) return null; // Not circular enough
  return {x:cx, y:cy, r};
}

function getBBox(pts) {
  if (!pts.length) return null;
  return {
    minX: Math.min(...pts.map(p=>p.x)), maxX: Math.max(...pts.map(p=>p.x)),
    minY: Math.min(...pts.map(p=>p.y)), maxY: Math.max(...pts.map(p=>p.y)),
  };
}

function centroid(pts) {
  return { x: pts.reduce((s,p)=>s+p.x,0)/pts.length,
           y: pts.reduce((s,p)=>s+p.y,0)/pts.length };
}

function keyPts(segs) {
  return segs.filter(s=>s.type==='M'||s.type==='L').map(s=>({x:s.x,y:s.y}));
}

function pathStart(segs) {
  const m = segs.find(s=>s.type==='M');
  return m ? {x:m.x, y:m.y} : null;
}
function pathEnd(segs) {
  for (let i=segs.length-1; i>=0; i--) {
    const s=segs[i];
    if (s.type==='L'||s.type==='C'||s.type==='M') return {x:s.x,y:s.y};
  }
  return null;
}
function pathMid(segs) {
  const pts = segs.filter(s=>s.type!=='Z').map(s=>({x:s.x,y:s.y}));
  return pts.length ? pts[Math.floor(pts.length/2)] : null;
}

function analyzeGraph(paths, textItems) {
  // ── PASS 1: detect circles ──────────────────────────────────
  const rawCircles = [];
  for (const p of paths) {
    const cubics = p.segments.filter(s=>s.type==='C');
    const moves  = p.segments.filter(s=>s.type==='M');
    const hasZ   = p.segments.some(s=>s.type==='Z');
    if (cubics.length===4 && moves.length===1 && hasZ) {
      const c = fitCircle(p.segments);
      if (c) { rawCircles.push(c); continue; }
    }
  }

  // Median radius → used to scale thresholds
  const sortedR = rawCircles.map(c=>c.r).sort((a,b)=>a-b);
  const medR = sortedR.length ? sortedR[Math.floor(sortedR.length/2)] : 20;

  // ── PASS 2: arrowheads + edges ──────────────────────────────
  const arrowheads = [];
  const edgePaths  = [];

  for (const p of paths) {
    const {segments:segs, filled, stroked} = p;
    const cubics = segs.filter(s=>s.type==='C');
    const moves  = segs.filter(s=>s.type==='M');
    const hasZ   = segs.some(s=>s.type==='Z');

    // Already handled as a circle?
    if (cubics.length===4 && moves.length===1 && hasZ && fitCircle(segs)) continue;

    // Arrowhead: small filled polygon, no Béziers
    if (filled && !stroked && cubics.length===0) {
      const pts = keyPts(segs);
      if (pts.length >= 3 && pts.length <= 8) {
        const bb = getBBox(pts);
        if (bb) {
          const maxDim = Math.max(bb.maxX-bb.minX, bb.maxY-bb.minY);
          // Arrowhead is much smaller than a node circle
          if (maxDim > 1 && maxDim < medR * 0.6) {
            arrowheads.push(centroid(pts));
            continue;
          }
        }
      }
    }

    if (stroked) edgePaths.push(p);
  }

  // ── Merge concentric circles → nodes ────────────────────────
  // (double circle = accepting state)
  rawCircles.sort((a,b)=>b.r-a.r);
  const usedRaw = new Set();
  const nodes   = [];

  for (let i=0; i<rawCircles.length; i++) {
    if (usedRaw.has(i)) continue;
    const ni = rawCircles[i];
    let accepting = false;

    for (let j=i+1; j<rawCircles.length; j++) {
      if (usedRaw.has(j)) continue;
      const nj = rawCircles[j];
      const dist  = Math.hypot(ni.x-nj.x, ni.y-nj.y);
      const rDiff = Math.abs(ni.r - nj.r);
      if (dist < Math.min(ni.r,nj.r)*0.35 && rDiff > 1.5) {
        accepting = true;
        usedRaw.add(j);
      }
    }
    nodes.push({ x:ni.x, y:ni.y, r:ni.r, accepting, label:'', id:`q${nodes.length}` });
  }

  const snapDist = medR * 2.2; // max distance from path endpoint to nearest node center

  // ── Find closest node index (returns -1 if none within threshold) ──
  const closestNode = pt => {
    let best=-1, bestD=snapDist;
    for (let i=0; i<nodes.length; i++) {
      const d = Math.hypot(pt.x-nodes[i].x, pt.y-nodes[i].y);
      if (d < bestD) { bestD=d; best=i; }
    }
    return best;
  };

  // ── Build edges ──────────────────────────────────────────────
  const edges = [];

  for (const p of edgePaths) {
    const segs = p.segments;
    let start  = pathStart(segs);
    let end    = pathEnd(segs);
    if (!start || !end) continue;

    // Determine direction: arrowhead nearest to which endpoint?
    let nearStart = Infinity, nearEnd = Infinity;
    for (const ah of arrowheads) {
      nearStart = Math.min(nearStart, Math.hypot(ah.x-start.x, ah.y-start.y));
      nearEnd   = Math.min(nearEnd,   Math.hypot(ah.x-end.x,   ah.y-end.y));
    }
    // If arrowhead is clearly closer to the start point, the path was drawn
    // from target→source (reversed TikZ drawing order). Flip it.
    if (arrowheads.length > 0 && nearStart < nearEnd && nearStart < medR * 0.8) {
      [start, end] = [end, start];
    }

    const fromIdx = closestNode(start);
    const toIdx   = closestNode(end);
    const mid     = pathMid(segs);
    const isSelf  = fromIdx >= 0 && fromIdx === toIdx;

    edges.push({
      from: fromIdx, to: toIdx,
      isInitial: fromIdx === -1 && toIdx >= 0,
      isSelf,
      mid, segments: segs, label: ''
    });
  }

  // ── Text label assignment ────────────────────────────────────
  const texts = textItems
    .filter(t => t.str.trim() !== '')
    .map(t => ({ text: t.str.trim(), x: t.transform[4], y: t.transform[5] }))
    .sort((a,b) => b.y !== a.y ? b.y-a.y : a.x-b.x); // top-to-bottom, left-to-right in PDF space

  // Group characters/tokens on the same baseline.
  // BUG FIX: track lastX per group so multi-character labels aren't fragmented.
  const textGroups = [];
  const used = new Set();
  for (let i=0; i<texts.length; i++) {
    if (used.has(i)) continue;
    const g = { text: texts[i].text, x: texts[i].x, y: texts[i].y, lastX: texts[i].x, assigned: false };
    used.add(i);
    // Keep sweeping until no more chars join (handles non-sorted glyphs)
    let changed = true;
    while (changed) {
      changed = false;
      for (let j=0; j<texts.length; j++) {
        if (used.has(j)) continue;
        const t = texts[j];
        // Same baseline (y within 3 units), within 50 units to the right of the group's rightmost char
        if (Math.abs(t.y - g.y) < 3 && t.x - g.lastX < 50 && t.x > g.lastX - 2) {
          g.text += t.text;
          g.lastX = Math.max(g.lastX, t.x);
          used.add(j);
          changed = true;
        }
      }
    }
    textGroups.push(g);
  }

  // Assign to nodes first (text overlapping/near node center)
  for (const g of textGroups) {
    let best=-1, bestD=Infinity;
    for (let i=0; i<nodes.length; i++) {
      const d = Math.hypot(g.x-nodes[i].x, g.y-nodes[i].y);
      if (d < nodes[i].r * 1.6 && d < bestD) { bestD=d; best=i; }
    }
    if (best >= 0) {
      nodes[best].label = (nodes[best].label + g.text).trim();
      g.assigned = true;
    }
  }

  // Assign remaining to edges (text near path midpoint)
  for (const g of textGroups) {
    if (g.assigned) continue;
    let best=-1, bestD=medR * 1.8;
    for (let i=0; i<edges.length; i++) {
      const mid = edges[i].mid;
      if (!mid) continue;
      const d = Math.hypot(g.x-mid.x, g.y-mid.y);
      if (d < bestD) { bestD=d; best=i; }
    }
    if (best >= 0) {
      edges[best].label = (edges[best].label + ' ' + g.text).trim();
      g.assigned = true;
    }
  }

  // Fallback node labels
  for (let i=0; i<nodes.length; i++) {
    if (!nodes[i].label) nodes[i].label = `q${i}`;
  }

  // Deduplicate edges with identical (from, to, label)
  const seen = new Set();
  const finalEdges = edges.filter(e => {
    const k = `${e.from}→${e.to}|${e.label}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // Confidence: % edges with both endpoints resolved
  const resolved = finalEdges.filter(e => e.to >= 0 && (e.from >= 0 || e.isInitial)).length;
  const confidence = finalEdges.length ? Math.round(100 * resolved / finalEdges.length) : 0;

  return {
    nodes, edges: finalEdges, arrowheads, rawCircles, textGroups, medR, confidence,
    stats: {
      rawCircles: rawCircles.length,
      nodes:      nodes.length,
      arrowheads: arrowheads.length,
      edgePaths:  edgePaths.length,
      edges:      finalEdges.length,
      textGroups: textGroups.length,
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// OUTPUT GENERATORS
// ═══════════════════════════════════════════════════════════════
function generateDOT(result) {
  const {nodes, edges} = result;
  const L = [];
  L.push('digraph automaton {');
  L.push('  rankdir=LR;');
  L.push('  size="8,5";');
  L.push('  node [fontname="Helvetica"];');
  L.push('');

  const hasInit = edges.some(e => e.isInitial);
  if (hasInit) L.push('  __init__ [shape=none label="" width=0 height=0];');

  const acc = nodes.filter(n=>n.accepting);
  if (acc.length) {
    L.push(`  node [shape=doublecircle]; ${acc.map(n=>`"${n.label}"`).join(' ')};`);
  }
  L.push('  node [shape=circle];');
  for (const n of nodes) L.push(`  "${n.label}";`);
  L.push('');

  for (const e of edges) {
    const from = e.isInitial ? '__init__' : (e.from>=0 ? `"${nodes[e.from].label}"` : '"?"');
    const to   = e.to>=0   ? `"${nodes[e.to].label}"` : '"?"';
    const lbl  = e.label   ? ` [label="${e.label}"]` : '';
    L.push(`  ${from} -> ${to}${lbl};`);
  }

  L.push('}');
  return L.join('\n');
}

function generatePlain(result) {
  const {nodes, edges} = result;
  const L = [];
  L.push('AUTOMATON — EXTRACTED STRUCTURE');
  L.push('═'.repeat(42));
  L.push('');
  L.push(`States (${nodes.length}):`);
  for (const n of nodes) {
    let tags = [];
    if (n.accepting) tags.push('accepting');
    const initEdge = edges.find(e=>e.isInitial && e.to===nodes.indexOf(n));
    if (initEdge) tags.push('initial');
    L.push(`  • ${n.label}${tags.length ? '  ['+tags.join(', ')+']' : ''}`);
  }
  L.push('');

  const realEdges = edges.filter(e=>!e.isInitial);
  L.push(`Transitions (${realEdges.length}):`);
  for (const e of realEdges) {
    const from = e.from>=0 ? nodes[e.from].label : '?';
    const to   = e.to>=0   ? nodes[e.to].label   : '?';
    const sym  = e.label || 'ε';
    L.push(`  ${from.padEnd(10)} ──[ ${sym} ]──>  ${to}`);
  }

  const initials = edges.filter(e=>e.isInitial);
  if (initials.length) {
    L.push('');
    L.push(`Initial state(s): ${initials.map(e=>e.to>=0?nodes[e.to].label:'?').join(', ')}`);
  }

  L.push('');
  L.push(`Confidence: ${result.confidence}%  (edges with both endpoints resolved)`);
  L.push(`Median node radius: ${result.medR.toFixed(1)} PDF units`);
  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// OVERLAY DRAWING
// ═══════════════════════════════════════════════════════════════
function drawOverlay(result, viewport) {
  const canvas = $('overlay-canvas');
  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const vp = ({x,y}) => viewport.convertToViewportPoint(x, y);

  // Edge paths (dashed overlay)
  for (const e of result.edges) {
    ctx.strokeStyle = e.isInitial ? 'rgba(168,230,207,0.75)' : 'rgba(78,205,196,0.55)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5,3]);
    ctx.beginPath();
    let started = false;
    for (const s of e.segments) {
      if (s.type==='M') {
        const [cx,cy] = vp({x:s.x,y:s.y}); ctx.moveTo(cx,cy); started=true;
      } else if (s.type==='L' && started) {
        const [cx,cy] = vp({x:s.x,y:s.y}); ctx.lineTo(cx,cy);
      } else if (s.type==='C' && started) {
        const [x1,y1]=vp({x:s.x1,y:s.y1}), [x2,y2]=vp({x:s.x2,y:s.y2}), [ex,ey]=vp({x:s.x,y:s.y});
        ctx.bezierCurveTo(x1,y1,x2,y2,ex,ey);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Edge label near midpoint
    if (e.mid && e.label) {
      const [mx,my] = vp(e.mid);
      ctx.fillStyle   = 'rgba(232,164,40,0.9)';
      ctx.font        = '10px IBM Plex Mono';
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      // Small pill background
      const tw = ctx.measureText(e.label).width;
      ctx.fillStyle = 'rgba(12,15,22,0.75)';
      ctx.fillRect(mx - tw/2 - 3, my - 8, tw + 6, 14);
      ctx.fillStyle = 'rgba(232,164,40,0.9)';
      ctx.fillText(e.label, mx, my);
    }
  }

  // Arrowhead markers
  for (const ah of result.arrowheads) {
    const [cx,cy] = vp(ah);
    ctx.fillStyle = 'rgba(255,107,107,0.85)';
    ctx.beginPath(); ctx.arc(cx,cy,3.5,0,Math.PI*2); ctx.fill();
  }

  // Nodes
  for (const n of result.nodes) {
    const [cx,cy] = vp({x:n.x,y:n.y});
    const r = n.r * viewport.scale;

    ctx.strokeStyle = n.accepting ? '#4ecdc4' : '#e8a428';
    ctx.lineWidth   = 2.5;
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();

    if (n.accepting) {
      ctx.beginPath(); ctx.arc(cx,cy,r*0.82,0,Math.PI*2); ctx.stroke();
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

// ═══════════════════════════════════════════════════════════════
// DEBUG PANEL
// ═══════════════════════════════════════════════════════════════
function renderDebug(result) {
  const {nodes,edges,stats,textGroups,confidence,medR} = result;

  const confColor = confidence>75?'var(--teal)':confidence>40?'var(--amber)':'var(--red)';

  const unassigned = textGroups.filter(g=>!g.assigned);

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
      <div class="dbg-row" style="margin-top:8px">Med. node radius: <b>${medR.toFixed(1)}</b> PDF units · snap threshold: <b>${(medR*2.2).toFixed(1)}</b></div>
    </div>

    <div class="dbg-section">
      <h3>Nodes (${nodes.length})</h3>
      ${nodes.map((n,i)=>`
        <div class="dbg-row">
          [${i}] <b>"${n.label}"</b> &nbsp;@ (${n.x.toFixed(1)}, ${n.y.toFixed(1)}) &nbsp;r=${n.r.toFixed(1)}
          ${n.accepting?'<span class="tag-acc">⊛ accepting</span>':''}
        </div>
      `).join('')||'<div class="dbg-row">No nodes detected</div>'}
    </div>

    <div class="dbg-section">
      <h3>Edges (${edges.length})</h3>
      ${edges.map((e,i)=>{
        const fl = e.isInitial ? '▶ [initial]' : (e.from>=0?`"${nodes[e.from]?.label}"`:'"-"');
        const tl = e.to>=0 ? `"${nodes[e.to]?.label}"` : '"?"';
        const warn = (e.from<0&&!e.isInitial)||e.to<0 ? '<span class="tag-warn">⚠ unresolved</span>' : '';
        const slf  = e.isSelf ? '<span class="tag-init">↺ self-loop</span>' : '';
        return `<div class="dbg-row">[${i}] ${fl} → ${tl}${e.label?` <b>"${e.label}"</b>`:''}${warn}${slf}</div>`;
      }).join('')||'<div class="dbg-row">No edges detected</div>'}
    </div>

    <div class="dbg-section">
      <h3>Unassigned Text (${unassigned.length})</h3>
      ${unassigned.map(g=>`
        <div class="dbg-row">"<b>${g.text}</b>" &nbsp;@ (${g.x.toFixed(1)}, ${g.y.toFixed(1)})</div>
      `).join('')||'<div class="dbg-row" style="color:var(--teal)">✓ All text groups assigned</div>'}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// GRAPHVIZ RENDERING
// ═══════════════════════════════════════════════════════════════
let _vizInstance = null;
async function getViz() {
  if (!_vizInstance) {
    if (typeof Viz === 'undefined') throw new Error('Viz.js not loaded');
    _vizInstance = await Viz.instance();
  }
  return _vizInstance;
}

async function renderGraphviz(dotString) {
  const preview = $('graph-preview');
  if (!preview) return;
  preview.innerHTML = '<span style="color:var(--dim);font-family:var(--mono);font-size:11px;padding:14px;display:block">Rendering…</span>';
  try {
    const viz = await getViz();
    const svgEl = viz.renderSVGElement(dotString, { engine: 'dot' });
    svgEl.style.maxWidth = '100%';
    svgEl.style.height = 'auto';
    svgEl.style.display = 'block';
    preview.innerHTML = '';
    preview.appendChild(svgEl);
  } catch(e) {
    preview.innerHTML = `<span style="color:var(--red);font-family:var(--mono);font-size:11px;padding:14px;display:block">Graphviz error: ${e.message}</span>`;
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN FLOW
// ═══════════════════════════════════════════════════════════════
let pdfDoc     = null;
let currentVP  = null;

async function loadPDF(file) {
  setStatus('Loading PDF…', 'busy');
  try {
    const data = await file.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;

    const sel = $('page-sel');
    sel.innerHTML = '';
    for (let i=1; i<=pdfDoc.numPages; i++) {
      const o = document.createElement('option');
      o.value = i; o.textContent = `Page ${i}`;
      sel.appendChild(o);
    }

    $('toolbar').classList.add('show');
    $('dropzone').classList.add('hidden');
    $('canvas-inner').style.display = 'block';

    setStatus(`PDF loaded — ${pdfDoc.numPages} page(s)`, 'ok');
    await analyzePage(1);
  } catch(e) {
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
    currentVP      = viewport;

    // Render PDF to canvas
    const pdfC = $('pdf-canvas'), ovC = $('overlay-canvas');
    const ci   = $('canvas-inner');
    pdfC.width  = ovC.width  = viewport.width;
    pdfC.height = ovC.height = viewport.height;
    ci.style.width  = viewport.width + 'px';
    ci.style.height = viewport.height + 'px';
    pdfC.style.display = ovC.style.display = 'block';

    const ctx = pdfC.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pdfC.width, pdfC.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    $('page-info').textContent = `${Math.round(viewport.width)} × ${Math.round(viewport.height)} px`;

    // Extract paths + text
    const opList  = await page.getOperatorList();
    const extractor = new PathExtractor(pdfjsLib.OPS);
    const paths   = extractor.extract(opList.fnArray, opList.argsArray);

    const textContent = await page.getTextContent();
    const result      = analyzeGraph(paths, textContent.items);

    // Overlay
    drawOverlay(result, viewport);
    $('legend').classList.add('show');

    // Outputs
    const dot   = generateDOT(result);
    const plain = generatePlain(result);

    showOutput('dot',   dot);
    showOutput('plain', plain);
    renderDebug(result);
    $('debug-content').style.display = 'block';
    $('debug-placeholder').style.display = 'none';

    // Graphviz rendering (async, non-blocking)
    renderGraphviz(dot);

    setStatus(
      `Page ${num}: ${result.stats.nodes} nodes · ${result.stats.edges} edges · ${result.confidence}% confidence`,
      'ok'
    );
  } catch(e) {
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

// Copy buttons
$('copy-dot').addEventListener('click', () => {
  const v = $('dot-out').value;
  if (!v) return;
  navigator.clipboard.writeText(v).then(() => {
    setStatus('DOT copied to clipboard ✓', 'ok');
    setTimeout(() => setStatus('Ready','ok'), 2000);
  });
});
$('copy-plain').addEventListener('click', () => {
  const v = $('plain-out').value;
  if (!v) return;
  navigator.clipboard.writeText(v).then(() => {
    setStatus('Text copied to clipboard ✓', 'ok');
    setTimeout(() => setStatus('Ready','ok'), 2000);
  });
});

// Page selector + analyze
$('page-sel').addEventListener('change', e => {
  analyzePage(+e.target.value);
});
$('analyze-btn').addEventListener('click', () => {
  analyzePage(+$('page-sel').value);
});
$('reload-btn').addEventListener('click', () => {
  pdfDoc = null;
  $('toolbar').classList.remove('show');
  $('legend').classList.remove('show');
  $('dropzone').classList.remove('hidden');
  $('pdf-canvas').style.display = $('overlay-canvas').style.display = 'none';
  $('canvas-inner').style.display = 'none';
  ['dot','plain'].forEach(t => {
    $(`${t}-placeholder`).style.display = '';
    $(`${t}-out`).style.display = 'none';
  });
  $('debug-placeholder').style.display = '';
  $('debug-content').style.display = 'none';
  const preview = $('graph-preview');
  if (preview) preview.innerHTML = '';
  setStatus('Ready — drop a TikZ-compiled PDF to begin', '');
});

// ── File drop + input ──────────────────────────────────────────
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
