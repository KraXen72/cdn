/**
 * extractor.js — shared PDF→Automaton extraction logic
 *
 * Works in both browser (ES module via Vite/script tag) and Node.js.
 * No browser-specific or Node-specific APIs.
 *
 * Handles pdfjs-dist ≥ 5.x where paths use constructPath (OPS 91) bundled op,
 * as well as older individual moveTo/lineTo/curveTo operators.
 */

// ═══════════════════════════════════════════════════════════════
// MATRIX HELPERS  (PDF CTM: [a,b,c,d,e,f])
// ═══════════════════════════════════════════════════════════════
export function mulMat(m1, m2) {
  return [
    m1[0]*m2[0] + m1[2]*m2[1],
    m1[1]*m2[0] + m1[3]*m2[1],
    m1[0]*m2[2] + m1[2]*m2[3],
    m1[1]*m2[2] + m1[3]*m2[3],
    m1[0]*m2[4] + m1[2]*m2[5] + m1[4],
    m1[1]*m2[4] + m1[3]*m2[5] + m1[5],
  ];
}
export function applyMat(m, x, y) {
  return { x: m[0]*x + m[2]*y + m[4], y: m[1]*x + m[3]*y + m[5] };
}

// ═══════════════════════════════════════════════════════════════
// constructPath sub-command codes (pdfjs-dist ≥ 5.x)
// ═══════════════════════════════════════════════════════════════
const CP_MOVETO    = 0;
const CP_LINETO    = 1;
const CP_CURVETO   = 2;
const CP_CLOSEPATH = 4;

/**
 * Decode a pdfjs-dist 5.x constructPath call.
 * @param {number} paintOp  - OPS code bundled in the constructPath call
 * @param {Float32Array[]} coordArrs - array of Float32Arrays with path commands
 * @param {number[]} ctm    - current transform matrix [a,b,c,d,e,f]
 * @returns {{ segments: object[], filled: boolean, stroked: boolean }[]}
 */
export function decodeConstructPath(paintOp, coordArrs, ctm, OPS) {
  const paths = [];
  const filled  = paintOp === OPS.fill       || paintOp === OPS.fillStroke    ||
                  paintOp === OPS.eoFill      || paintOp === OPS.eoFillStroke  ||
                  paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke;
  const stroked = paintOp === OPS.stroke      || paintOp === OPS.fillStroke    ||
                  paintOp === OPS.closeStroke  || paintOp === OPS.closeFillStroke;

  for (const coordArr of coordArrs) {
    if (!coordArr) continue;
    let segs = null;
    let i = 0;

    while (i < coordArr.length) {
      const cmd = coordArr[i++];
      if (cmd === CP_MOVETO) {
        if (segs && segs.length > 0) paths.push({ segments: [...segs], filled, stroked });
        segs = [];
        if (i + 1 < coordArr.length) {
          const p = applyMat(ctm, coordArr[i], coordArr[i+1]); i += 2;
          segs.push({ type: 'M', x: p.x, y: p.y });
        }
      } else if (cmd === CP_LINETO) {
        if (!segs) segs = [];
        if (i + 1 < coordArr.length) {
          const p = applyMat(ctm, coordArr[i], coordArr[i+1]); i += 2;
          segs.push({ type: 'L', x: p.x, y: p.y });
        }
      } else if (cmd === CP_CURVETO) {
        if (!segs) segs = [];
        if (i + 5 < coordArr.length) {
          const p1 = applyMat(ctm, coordArr[i],   coordArr[i+1]);
          const p2 = applyMat(ctm, coordArr[i+2], coordArr[i+3]);
          const p3 = applyMat(ctm, coordArr[i+4], coordArr[i+5]);
          i += 6;
          segs.push({ type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p3.x, y: p3.y });
        }
      } else if (cmd === CP_CLOSEPATH) {
        if (segs) segs.push({ type: 'Z' });
      }
      // else: unknown/padding — skip
    }
    if (segs && segs.length > 0) paths.push({ segments: [...segs], filled, stroked });
  }
  return paths;
}

// ═══════════════════════════════════════════════════════════════
// PATH EXTRACTOR
// Replays PDF operator list tracking CTM, emitting typed path objects.
// Handles both pdfjs-dist 3.x (individual ops) and 5.x (constructPath).
// ═══════════════════════════════════════════════════════════════
export class PathExtractor {
  /**
   * @param {object} OPS  - pdfjsLib.OPS map
   */
  constructor(OPS) {
    this.OPS = OPS;
  }

  extract(fnArray, argsArray) {
    const OPS = this.OPS;
    const paths = [];
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    let cur = { x: 0, y: 0 };
    let segs = null;

    const tp = (x, y) => applyMat(ctm, x, y);
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

        case OPS.constructPath: {
          // pdfjs-dist ≥ 5.x bundles path + paint into one call
          // a[0] = paint opcode,  a[1] = Array<Float32Array>
          const paintOp = a[0];
          const coordArrs = a[1];
          if (coordArrs) {
            const subpaths = decodeConstructPath(paintOp, coordArrs, ctm, OPS);
            for (const sp of subpaths) paths.push(sp);
          }
          break;
        }

        case OPS.moveTo: {
          if (!segs) segs = [];
          const p = tp(a[0], a[1]); cur = p;
          segs.push({ type: 'M', x: p.x, y: p.y }); break;
        }
        case OPS.lineTo: {
          if (!segs) segs = [];
          const p = tp(a[0], a[1]); cur = p;
          segs.push({ type: 'L', x: p.x, y: p.y }); break;
        }
        case OPS.curveTo: {
          if (!segs) segs = [];
          const p1 = tp(a[0],a[1]), p2 = tp(a[2],a[3]), p3 = tp(a[4],a[5]); cur = p3;
          segs.push({ type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p3.x, y: p3.y }); break;
        }
        case OPS.curveTo2: { // PDF 'v' — first control point = current point (BUG FIX: save prev)
          if (!segs) segs = [];
          const p2 = tp(a[0],a[1]), p3 = tp(a[2],a[3]);
          const prev = cur; cur = p3;
          segs.push({ type: 'C', x1: prev.x, y1: prev.y, x2: p2.x, y2: p2.y, x: p3.x, y: p3.y }); break;
        }
        case OPS.curveTo3: { // PDF 'y' — second control point = endpoint
          if (!segs) segs = [];
          const p1 = tp(a[0],a[1]), p3 = tp(a[2],a[3]); cur = p3;
          segs.push({ type: 'C', x1: p1.x, y1: p1.y, x2: p3.x, y2: p3.y, x: p3.x, y: p3.y }); break;
        }
        case OPS.closePath:
          if (segs) segs.push({ type: 'Z' }); break;
        case OPS.rectangle: {
          const [rx, ry, rw, rh] = a;
          const p1=tp(rx,ry), p2=tp(rx+rw,ry), p3=tp(rx+rw,ry+rh), p4=tp(rx,ry+rh);
          segs = [
            { type:'M', ...p1 }, { type:'L', ...p2 },
            { type:'L', ...p3 }, { type:'L', ...p4 }, { type:'Z' }
          ];
          break;
        }
        case OPS.stroke:           paint(false, true);  break;
        case OPS.closeStroke:
          if (segs) segs.push({ type: 'Z' }); paint(false, true); break;
        case OPS.fill:
        case OPS.eoFill:           paint(true, false);  break;
        case OPS.fillStroke:
        case OPS.eoFillStroke:     paint(true, true);   break;
        case OPS.closeFillStroke:
        case OPS.closeEOFillStroke:
          if (segs) segs.push({ type: 'Z' }); paint(true, true); break;
        case OPS.endPath: segs = null; break;
      }
    }
    return paths;
  }
}

// ═══════════════════════════════════════════════════════════════
// GEOMETRY HELPERS
// ═══════════════════════════════════════════════════════════════
function fitCircle(segs) {
  // Use only cubic endpoint coords — M is often a duplicate of the last C endpoint
  // (PDF circles drawn as M + 4C + optional-L + Z), so excluding M avoids skewing the centroid.
  const cubicPts = segs.filter(s => s.type==='C').map(s => ({ x: s.x, y: s.y }));
  if (cubicPts.length < 4) return null;

  // Use bounding-box center for robustness with slightly elliptical shapes
  const xs = cubicPts.map(p => p.x), ys = cubicPts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2;
  const ry = (maxY - minY) / 2;
  const r  = (rx + ry) / 2;
  if (r < 3) return null;

  // Reject if aspect ratio is too extreme (more than 1.15:1 → probably not a state circle)
  // Real automaton states are drawn as perfect circles or near-perfect (aspect≤1.01 in practice).
  // Aspect >1.15 means it's an ellipse, bounding arc, or page decoration.
  if (rx > 0 && ry > 0 && Math.max(rx, ry) / Math.min(rx, ry) > 1.15) return null;

  // Validate: check that the cubic endpoints are roughly at equal distance from center
  const radii  = cubicPts.map(p => Math.hypot(p.x - cx, p.y - cy));
  const meanR  = radii.reduce((a, b) => a + b, 0) / radii.length;
  const maxDev = Math.max(...radii.map(ri => Math.abs(ri - meanR)));
  if (maxDev / meanR > 0.50) return null; // 50% — looser to handle ellipses

  return { x: cx, y: cy, r };
}

function getBBox(pts) {
  if (!pts.length) return null;
  return {
    minX: Math.min(...pts.map(p=>p.x)), maxX: Math.max(...pts.map(p=>p.x)),
    minY: Math.min(...pts.map(p=>p.y)), maxY: Math.max(...pts.map(p=>p.y)),
  };
}
function centroid(pts) {
  return { x: pts.reduce((s,p)=>s+p.x, 0)/pts.length,
           y: pts.reduce((s,p)=>s+p.y, 0)/pts.length };
}
function keyPts(segs) {
  return segs.filter(s => s.type==='M' || s.type==='L').map(s => ({ x:s.x, y:s.y }));
}
function pathStart(segs) {
  const m = segs.find(s => s.type==='M');
  return m ? { x: m.x, y: m.y } : null;
}
function pathEnd(segs) {
  for (let i = segs.length-1; i >= 0; i--) {
    const s = segs[i];
    if (s.type==='L' || s.type==='C' || s.type==='M') return { x: s.x, y: s.y };
  }
  return null;
}

/** Evaluate a cubic Bézier at parameter t */
function evalBezier(p0, s, t) {
  const mt = 1 - t;
  return {
    x: mt*mt*mt*p0.x + 3*mt*mt*t*s.x1 + 3*mt*t*t*s.x2 + t*t*t*s.x,
    y: mt*mt*mt*p0.y + 3*mt*mt*t*s.y1 + 3*mt*t*t*s.y2 + t*t*t*s.y,
  };
}

/** Visual midpoint of a path (evaluates bezier at t=0.5) */
function pathMid(segs) {
  const drawable = segs.filter(s => s.type !== 'Z' && s.type !== 'M');
  if (!drawable.length) {
    const m = segs.find(s => s.type==='M');
    return m ? { x: m.x, y: m.y } : null;
  }
  const mid = drawable[Math.floor(drawable.length / 2)];
  if (mid.type === 'C') {
    const idx = segs.indexOf(mid);
    let prev = { x: mid.x, y: mid.y };
    for (let i = idx-1; i >= 0; i--) {
      if (segs[i].type !== 'Z') { prev = { x: segs[i].x, y: segs[i].y }; break; }
    }
    return evalBezier(prev, mid, 0.5);
  }
  return { x: mid.x, y: mid.y };
}

/** Min distance from point pt to any sample along a path's bezier curves (t=0.15..0.85) */
function minDistToPath(pt, segs) {
  let d = Infinity;
  let prevPt = null;
  for (const s of segs) {
    if (s.type === 'M') {
      prevPt = { x: s.x, y: s.y };
    } else if (s.type === 'L') {
      const mid = { x: (prevPt.x+s.x)/2, y: (prevPt.y+s.y)/2 };
      d = Math.min(d, Math.hypot(pt.x-mid.x, pt.y-mid.y));
      prevPt = { x: s.x, y: s.y };
    } else if (s.type === 'C' && prevPt) {
      // Sample t=0.15..0.85 to avoid matching endpoint areas (which are inside nodes)
      for (let t = 0.15; t <= 0.86; t += 0.1) {
        const bp = evalBezier(prevPt, s, t);
        d = Math.min(d, Math.hypot(pt.x-bp.x, pt.y-bp.y));
      }
      prevPt = { x: s.x, y: s.y };
    }
  }
  return d;
}

// ═══════════════════════════════════════════════════════════════
// GRAPH ANALYSIS
// ═══════════════════════════════════════════════════════════════
export function analyzeGraph(paths, textItems) {
  // ── Pass 1: detect circles (node outlines) ─────────────────
  const rawCircles = [];
  for (const p of paths) {
    const cubics = p.segments.filter(s => s.type==='C');
    const moves  = p.segments.filter(s => s.type==='M');
    const hasZ   = p.segments.some(s => s.type==='Z');
    if (cubics.length === 4 && moves.length === 1 && hasZ) {
      const c = fitCircle(p.segments);
      if (c) rawCircles.push(c);
    }
  }

  const sortedR = rawCircles.map(c => c.r).sort((a,b) => a-b);
  const medR = sortedR.length ? sortedR[Math.floor(sortedR.length/2)] : 20;

  // Filter out circles that are much larger than the median — these are decorative arcs,
  // page borders, or spurious large shapes, not automaton state circles.
  // Keep all if there are very few circles (≤2) to avoid discarding legitimate lone states.
  const MAX_RADIUS_RATIO = 3.0;
  rawCircles.splice(0, rawCircles.length,
    ...rawCircles.filter(c => c.r <= medR * MAX_RADIUS_RATIO || rawCircles.length <= 2));

  // ── Pass 2: arrowheads + edge paths ────────────────────────
  const arrowheads = [];
  const edgePaths  = [];

  for (const p of paths) {
    const { segments: segs, filled, stroked } = p;
    const cubics = segs.filter(s => s.type==='C');
    const moves  = segs.filter(s => s.type==='M');
    const hasZ   = segs.some(s => s.type==='Z');

    // Skip node circles
    if (cubics.length === 4 && moves.length === 1 && hasZ && fitCircle(segs)) continue;

    // Arrowhead: small filled polygon with no Béziers
    if (filled && !stroked && cubics.length === 0) {
      const pts = keyPts(segs);
      if (pts.length >= 3 && pts.length <= 8) {
        const bb = getBBox(pts);
        if (bb) {
          const maxDim = Math.max(bb.maxX-bb.minX, bb.maxY-bb.minY);
          if (maxDim > 1 && maxDim < medR * 0.6) { arrowheads.push(centroid(pts)); continue; }
        }
      }
    }

    // Bezier arrowhead: small filled shape made of cubics (no straight lines), common in
    // book-style PDFs where arrowheads are rendered as 4-cubic bezier outlines
    if (filled && !stroked && cubics.length >= 3 && cubics.length <= 8 && keyPts(segs).length <= 2) {
      const allPts = segs.filter(s => s.type==='M' || s.type==='C').map(s => ({ x: s.x, y: s.y }));
      if (allPts.length >= 3) {
        const bb = getBBox(allPts);
        if (bb) {
          const maxDim = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
          if (maxDim > 0.5 && maxDim < medR * 1.2) {
            arrowheads.push(centroid(allPts)); continue;
          }
        }
      }
    }

    // Small filled circles (bullet arrowheads in TikZ, 3-cubic closed paths)
    if (cubics.length >= 3 && moves.length === 1 && hasZ && cubics.length < 4) {
      const pts = segs.filter(s => s.type==='M' || s.type==='C').map(s => ({ x:s.x, y:s.y }));
      const cx = pts.reduce((s,p)=>s+p.x,0)/pts.length;
      const cy = pts.reduce((s,p)=>s+p.y,0)/pts.length;
      const r  = pts.map(p=>Math.hypot(p.x-cx,p.y-cy)).reduce((a,b)=>a+b,0)/pts.length;
      if (r > 0 && r < medR * 0.3) { arrowheads.push({ x:cx, y:cy }); continue; }
    }

    if (stroked) edgePaths.push(p);
  }

  // ── Merge concentric circles → nodes ───────────────────────
  rawCircles.sort((a,b) => b.r - a.r);
  const usedRaw = new Set();
  const nodes   = [];

  for (let i = 0; i < rawCircles.length; i++) {
    if (usedRaw.has(i)) continue;
    const ni = rawCircles[i];
    let accepting = false;

    for (let j = i+1; j < rawCircles.length; j++) {
      if (usedRaw.has(j)) continue;
      const nj = rawCircles[j];
      const dist = Math.hypot(ni.x-nj.x, ni.y-nj.y);
      // Two concentric circles → accepting state (double-circle).
      // Use medR-based absolute threshold so it works regardless of the outer ring's size.
      if (dist < Math.max(medR * 0.5, Math.min(ni.r, nj.r) * 0.35)) { accepting = true; usedRaw.add(j); }
    }
    nodes.push({ x: ni.x, y: ni.y, r: ni.r, accepting, label: '', id: `q${nodes.length}` });
  }

  const snapDist = medR * 2.2;
  const closestNode = pt => {
    let best = -1, bestD = snapDist;
    for (let i = 0; i < nodes.length; i++) {
      const d = Math.hypot(pt.x-nodes[i].x, pt.y-nodes[i].y);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  // ── Build edges ──────────────────────────────────────────────
  const edges = [];

  for (const p of edgePaths) {
    const segs = p.segments;
    // Skip degenerate paths (M-only, no actual draw commands)
    if (!segs.some(s => s.type==='L' || s.type==='C')) continue;

    let start = pathStart(segs);
    let end   = pathEnd(segs);
    if (!start || !end) continue;

    // Determine direction by finding which endpoint is closer to an arrowhead
    let nearStart = Infinity, nearEnd = Infinity;
    for (const ah of arrowheads) {
      nearStart = Math.min(nearStart, Math.hypot(ah.x-start.x, ah.y-start.y));
      nearEnd   = Math.min(nearEnd,   Math.hypot(ah.x-end.x,   ah.y-end.y));
    }
    // If arrowhead is clearly closer to the start, path was drawn target→source; flip it
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
      isSelf, mid, segments: segs, label: ''
    });
  }

  // ── Text grouping ────────────────────────────────────────────
  const texts = textItems
    .filter(t => t.str.trim() !== '')
    .map(t => ({ text: t.str.trim(), x: t.transform[4], y: t.transform[5] }))
    .sort((a,b) => b.y !== a.y ? b.y-a.y : a.x-b.x);

  const textGroups = [];
  const usedT = new Set();
  for (let i = 0; i < texts.length; i++) {
    if (usedT.has(i)) continue;
    const g = { text: texts[i].text, x: texts[i].x, y: texts[i].y, lastX: texts[i].x, assigned: false };
    usedT.add(i);
    // Multi-pass: keep joining chars on same baseline within gap
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < texts.length; j++) {
        if (usedT.has(j)) continue;
        const t = texts[j];
        // y-tolerance 2.5 (catches subscripts/superscripts), x-gap 20 (keeps label fragments together
        // without bridging to adjacent labels)
        if (Math.abs(t.y - g.y) < 2.5 && t.x - g.lastX < 20 && t.x > g.lastX - 2) {
          g.text += t.text;
          g.lastX = Math.max(g.lastX, t.x);
          usedT.add(j);
          changed = true;
        }
      }
    }
    textGroups.push(g);
  }

  // Post-process: split groups where a state name (q + alphanumeric) is immediately followed
  // by a transition label (containing →). E.g. "qsy→y,R" → split into "qs" and "y→y,R".
  // Pattern: starts with q + 1-3 alphanumeric chars, then the rest contains →
  // Match: state name = q + 1-3 alphanumeric chars, followed immediately by a transition "char→..."
  // We use non-greedy so the shortest valid state prefix is chosen before the "X→" transition start.
  // E.g. "qsy→y,R" → ["qs", "y→y,R"]; requires remainder to start with exactly one non-→ char then →
  // Greedy state-name match, backtracking to find the split where remainder is "char→..."
  // E.g. "qsy→y,R": q[a-z0-9]+ matches "qsy" but "→y,R" doesn't fit ".→.*"; backtracks to "qs"+"y→y,R" ✓
  const STATE_PREFIX_RE = /^(q[a-z0-9]+)(.→.*)/;
  for (let gi = textGroups.length - 1; gi >= 0; gi--) {
    const g = textGroups[gi];
    const m = STATE_PREFIX_RE.exec(g.text);
    if (m && m[2].includes('→')) {
      // Split: keep the state name part in place, push the remainder as a new group
      textGroups[gi] = { ...g, text: m[1] };
      textGroups.push({ text: m[2], x: g.x + m[1].length * 4, y: g.y, lastX: g.lastX, assigned: false });
    }
  }

  // ── Assign text to nodes ─────────────────────────────────────
  // Two-pass: first assign only non-transition-looking text (no →), then
  // fall back to any text if node still has no label. This prevents
  // transition labels (which always contain →) from being used as state names.
  const ARROW_RE = /→|->|,R|,L/;  // patterns found in TM transition labels
  // State labels are short (≤8 chars) and contain no spaces — longer text is body prose.
  const looksLikeStateLabel = t => t.length <= 8 && !/\s/.test(t);
  for (const g of textGroups) {
    if (ARROW_RE.test(g.text)) continue; // skip likely transition labels in pass 1
    if (!looksLikeStateLabel(g.text)) continue; // skip body text / prose
    let best = -1, bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = Math.hypot(g.x-nodes[i].x, g.y-nodes[i].y);
      if (d < nodes[i].r * 1.6 && d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { nodes[best].label = (nodes[best].label + g.text).trim(); g.assigned = true; }
  }
  // Pass 2: for nodes still unlabelled, allow any short text (including transition-like)
  for (const g of textGroups) {
    if (g.assigned) continue;
    if (!looksLikeStateLabel(g.text)) continue; // still skip long body text
    let best = -1, bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].label) continue; // already labelled
      const d = Math.hypot(g.x-nodes[i].x, g.y-nodes[i].y);
      if (d < nodes[i].r * 1.2 && d < bestD) { bestD = d; best = i; } // tighter radius for fallback
    }
    if (best >= 0) { nodes[best].label = (nodes[best].label + g.text).trim(); g.assigned = true; }
  }

  // ── Assign text to edges (greedy closest-first) ──────────────
  const diagramBounds = nodes.length ? {
    minX: Math.min(...nodes.map(n=>n.x)) - medR * 6,
    maxX: Math.max(...nodes.map(n=>n.x)) + medR * 6,
    minY: Math.min(...nodes.map(n=>n.y)) - medR * 6,
    maxY: Math.max(...nodes.map(n=>n.y)) + medR * 6,
  } : null;

  const maxEdgeLabelDist = medR * 4.0;
  const edgeLabelCandidates = [];

  for (let gi = 0; gi < textGroups.length; gi++) {
    const g = textGroups[gi];
    if (g.assigned) continue;
    if (diagramBounds && (g.x < diagramBounds.minX || g.x > diagramBounds.maxX ||
                          g.y < diagramBounds.minY || g.y > diagramBounds.maxY)) continue;

    // Find nearest node for directional bias
    let nearestNodeIdx = -1, nearestNodeDist = Infinity;
    for (let ni = 0; ni < nodes.length; ni++) {
      const nd = Math.hypot(g.x-nodes[ni].x, g.y-nodes[ni].y);
      if (nd < nearestNodeDist) { nearestNodeDist = nd; nearestNodeIdx = ni; }
    }

    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      if (e.isInitial) continue; // initial arrows don't carry labels
      const d = minDistToPath(g, e.segments);
      if (d < maxEdgeLabelDist) {
        // Prefer edges whose FROM node is nearest to this text (outgoing edge bias)
        const bias = (nearestNodeIdx >= 0 && e.from === nearestNodeIdx) ? -6 : 0;
        edgeLabelCandidates.push({ gi, ei, d: d + bias });
      }
    }
  }

  // Sort closest-first; assign one text per edge
  edgeLabelCandidates.sort((a,b) => a.d - b.d);
  const assignedTextIdx  = new Set();
  const assignedEdgeIdx  = new Set();
  for (const { gi, ei } of edgeLabelCandidates) {
    if (assignedTextIdx.has(gi) || assignedEdgeIdx.has(ei)) continue;
    textGroups[gi].assigned = true;
    edges[ei].label = (edges[ei].label + ' ' + textGroups[gi].text).trim();
    assignedTextIdx.add(gi);
    assignedEdgeIdx.add(ei);
  }

  // Fallback node labels
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].label) nodes[i].label = `q${i}`;
  }

  // Deduplicate edges with identical (from, to, label)
  const seenEdge = new Set();
  const finalEdges = edges.filter(e => {
    if (e.from < 0 && e.to < 0) return false; // both unresolved → spurious
    const k = `${e.from}→${e.to}|${e.label}`;
    if (seenEdge.has(k)) return false;
    seenEdge.add(k); return true;
  });

  const resolved = finalEdges.filter(e => e.to >= 0 && (e.from >= 0 || e.isInitial)).length;
  const confidence = finalEdges.length ? Math.round(100 * resolved / finalEdges.length) : 0;

  return {
    nodes, edges: finalEdges, arrowheads, rawCircles, textGroups, medR, confidence,
    diagramBounds,
    stats: {
      rawCircles: rawCircles.length, nodes: nodes.length,
      arrowheads: arrowheads.length, edgePaths: edgePaths.length,
      edges: finalEdges.length, textGroups: textGroups.length,
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// OUTPUT GENERATORS
// ═══════════════════════════════════════════════════════════════
export function generateDOT(result) {
  const { nodes, edges } = result;
  const L = ['digraph automaton {', '  rankdir=LR;', '  size="8,5";', '  node [fontname="Helvetica"];', ''];

  const hasInit = edges.some(e => e.isInitial);
  if (hasInit) L.push('  __init__ [shape=none label="" width=0 height=0];');

  const acc = nodes.filter(n => n.accepting);
  if (acc.length) L.push(`  node [shape=doublecircle]; ${acc.map(n=>`"${n.label}"`).join(' ')};`);

  L.push('  node [shape=circle];');
  for (const n of nodes) L.push(`  "${n.label}";`);
  L.push('');

  for (const e of edges) {
    const from = e.isInitial ? '__init__' : (e.from >= 0 ? `"${nodes[e.from].label}"` : '"?"');
    const to   = e.to >= 0 ? `"${nodes[e.to].label}"` : '"?"';
    const lbl  = e.label ? ` [label="${e.label}"]` : '';
    L.push(`  ${from} -> ${to}${lbl};`);
  }
  L.push('}');
  return L.join('\n');
}

export function generatePlain(result) {
  const { nodes, edges } = result;
  const L = ['AUTOMATON — EXTRACTED STRUCTURE', '═'.repeat(42), ''];
  L.push(`States (${nodes.length}):`);
  for (const n of nodes) {
    const tags = [];
    if (n.accepting) tags.push('accepting');
    if (edges.some(e => e.isInitial && e.to === nodes.indexOf(n))) tags.push('initial');
    L.push(`  • ${n.label}${tags.length ? '  [' + tags.join(', ') + ']' : ''}`);
  }
  L.push('');
  const realEdges = edges.filter(e => !e.isInitial);
  L.push(`Transitions (${realEdges.length}):`);
  for (const e of realEdges) {
    const from = e.from >= 0 ? nodes[e.from].label : '?';
    const to   = e.to   >= 0 ? nodes[e.to].label   : '?';
    L.push(`  ${from.padEnd(10)} ──[ ${e.label || 'ε'} ]──>  ${to}`);
  }
  const initials = edges.filter(e => e.isInitial);
  if (initials.length) {
    L.push('');
    L.push(`Initial state(s): ${initials.map(e => e.to>=0 ? nodes[e.to].label : '?').join(', ')}`);
  }
  L.push('');
  L.push(`Confidence: ${result.confidence}%  (edges with both endpoints resolved)`);
  L.push(`Median node radius: ${result.medR.toFixed(1)} PDF units`);
  return L.join('\n');
}

/**
 * generateAutomaton — outputs the automaton in the simple text format:
 *   #states / #initial / #accepting / #alphabet / #transitions
 * $ is used for epsilon (empty string) transitions.
 */
export function generateAutomaton(result) {
  const { nodes, edges } = result;
  const L = [];

  // #states
  L.push('#states');
  for (const n of nodes) L.push(n.label || '?');

  // #initial — states pointed to by isInitial edges
  L.push('#initial');
  const initialEdges = edges.filter(e => e.isInitial && e.to >= 0);
  for (const e of initialEdges) L.push(nodes[e.to].label || '?');

  // #accepting
  L.push('#accepting');
  for (const n of nodes.filter(n => n.accepting)) L.push(n.label || '?');

  // #alphabet — collect all unique non-epsilon symbols from edge labels
  L.push('#alphabet');
  const symbols = new Set();
  for (const e of edges) {
    if (e.isInitial) continue;
    const lbl = e.label ? e.label.trim() : '';
    if (!lbl) continue; // epsilon — no symbol
    // Labels may be comma-separated (e.g. "a,b")
    for (const sym of lbl.split(',').map(s => s.trim()).filter(Boolean)) {
      symbols.add(sym);
    }
  }
  for (const sym of [...symbols].sort()) L.push(sym);

  // #transitions
  L.push('#transitions');
  for (const e of edges) {
    if (e.isInitial) {
      // Initial arrow: from virtual start (qs-style) to target — skip, handled by #initial
      continue;
    }
    if (e.from < 0 || e.to < 0) continue;
    const from = nodes[e.from].label || '?';
    const to   = nodes[e.to].label   || '?';
    const lbl  = e.label ? e.label.trim() : '';
    if (!lbl) {
      // epsilon transition
      L.push(`${from}:$>${to}`);
    } else {
      // may be "a,b" style — keep as-is (comma-separated is the format)
      L.push(`${from}:${lbl}>${to}`);
    }
  }

  return L.join('\n');
}

/**
 * analyzeGraphs — detect multiple disconnected automata on one page.
 * Returns an array of result objects (one per connected component).
 * Falls back to [analyzeGraph(paths, textItems)] if only one cluster found.
 */
export function analyzeGraphs(paths, textItems) {
  const full = analyzeGraph(paths, textItems);
  if (full.nodes.length === 0) return [full];

  const threshold = full.medR * 5; // nodes closer than this are in the same graph
  const n = full.nodes.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i) {
    return parent[i] === i ? i : (parent[i] = find(parent[i]));
  }
  function union(a, b) {
    parent[find(a)] = find(b);
  }

  // Connect nodes linked by an edge (primary: handles all reachable pairs)
  for (const e of full.edges) {
    if (e.from >= 0 && e.to >= 0) union(e.from, e.to);
  }

  // Connect spatially close nodes (fallback for isolated nodes not reached by edges)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = full.nodes[i].x - full.nodes[j].x;
      const dy = full.nodes[i].y - full.nodes[j].y;
      if (Math.hypot(dx, dy) < threshold) union(i, j);
    }
  }

  // Second pass: merge components that have no cross-node edges (only self-loops or no edges),
  // using a larger radius. This handles diagrams where transitions are rasterized bitmaps
  // (not vector paths), so no inter-node edges exist to link components.
  // Only applies when current components have no edges connecting different nodes.
  const hasInterNodeEdge = new Set(); // component roots that have at least one cross-node edge
  for (const e of full.edges) {
    if (e.from >= 0 && e.to >= 0 && e.from !== e.to && !e.isInitial) {
      hasInterNodeEdge.add(find(e.from));
      hasInterNodeEdge.add(find(e.to));
    }
  }
  const longerThreshold = full.medR * 8;
  for (let i = 0; i < n; i++) {
    if (hasInterNodeEdge.has(find(i))) continue; // this component has real cross edges — don't force-merge
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = full.nodes[i].x - full.nodes[j].x;
      const dy = full.nodes[i].y - full.nodes[j].y;
      if (Math.hypot(dx, dy) < longerThreshold) union(i, j);
    }
  }

  // Group node indices by component root
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  if (groups.size <= 1) return [full];

  // Sort groups top-to-bottom, left-to-right (PDF y increases upward, so larger y = higher on page)
  const sorted = [...groups.values()].sort((a, b) => {
    const na = full.nodes[a[0]], nb = full.nodes[b[0]];
    const dyDiff = nb.y - na.y; // higher on page first
    return Math.abs(dyDiff) > full.medR * 3 ? dyDiff : na.x - nb.x; // else left-to-right
  });

  return sorted.map(nodeIdxs => {
    const idxSet = new Set(nodeIdxs);
    const oldToNew = new Map(nodeIdxs.map((old, ni) => [old, ni]));

    const subNodes = nodeIdxs.map(oldIdx => ({
      ...full.nodes[oldIdx],
      id: `q${oldToNew.get(oldIdx)}`,
    }));

    const subEdges = full.edges
      .filter(e => {
        if (e.isInitial && e.to >= 0) return idxSet.has(e.to);
        return (e.from >= 0 && idxSet.has(e.from)) || (e.to >= 0 && idxSet.has(e.to));
      })
      .map(e => ({
        ...e,
        from: e.from >= 0 ? (oldToNew.has(e.from) ? oldToNew.get(e.from) : -1) : e.from,
        to:   e.to   >= 0 ? (oldToNew.has(e.to)   ? oldToNew.get(e.to)   : -1) : e.to,
      }));

    const subStats = {
      ...full.stats,
      nodes: subNodes.length,
      edges: subEdges.length,
    };

    const resolvedEdges = subEdges.filter(e => (e.from >= 0 || e.isInitial) && e.to >= 0);
    const confidence = subEdges.length
      ? Math.round((resolvedEdges.length / subEdges.length) * 100)
      : 100;

    const subDiagramBounds = subNodes.length ? {
      minX: Math.min(...subNodes.map(n => n.x)) - full.medR * 6,
      maxX: Math.max(...subNodes.map(n => n.x)) + full.medR * 6,
      minY: Math.min(...subNodes.map(n => n.y)) - full.medR * 6,
      maxY: Math.max(...subNodes.map(n => n.y)) + full.medR * 6,
    } : null;

    return {
      ...full,
      nodes: subNodes,
      edges: subEdges,
      stats: subStats,
      confidence,
      diagramBounds: subDiagramBounds,
    };
  });
}

// ── Mermaid stateDiagram-v2 output ──────────────────────────────
export function generateMermaid(result) {
  const { nodes, edges, diagramBounds, medR } = result;
  const lines = [];

  // Emit %%{init}%% front-matter with elk layout for smoother edge routing
  // and padding proportional to the estimated diagram size
  const pad = Math.round((medR || 20) * 3);
  const initConfig = { theme: 'default', layout: 'elk' };
  lines.push(`%%{init: ${JSON.stringify(initConfig)}}%%`);
  lines.push('stateDiagram-v2');

  // Mermaid state IDs must be alphanumeric — map node index → safe ID
  // Use "state "display" as id" to show the real label
  const nodeId = (i) => `s${i}`;

  // Declare all states with their display labels
  for (let i = 0; i < nodes.length; i++) {
    const lbl = nodes[i].label || `q${i}`;
    // Escape double quotes in label
    const safeLbl = lbl.replace(/"/g, "'");
    lines.push(`  state "${safeLbl}" as ${nodeId(i)}`);
  }

  // Initial arrow
  const initEdge = edges.find(e => e.isInitial && e.to >= 0);
  if (initEdge) {
    lines.push(`  [*] --> ${nodeId(initEdge.to)}`);
  }

  // Regular transitions
  for (const e of edges) {
    if (e.isInitial) continue;
    if (e.from < 0 || e.to < 0) continue;
    // Escape colons (Mermaid uses : as label separator) and other special chars
    const lbl = e.label
      ? ` : ${e.label.replace(/:/g, '꞉').replace(/"/g, "'")}`
      : '';
    lines.push(`  ${nodeId(e.from)} --> ${nodeId(e.to)}${lbl}`);
  }

  // Accepting states → [*]
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].accepting) {
      lines.push(`  ${nodeId(i)} --> [*]`);
    }
  }

  return lines.join('\n');
}
