
// ==UserScript==
// @name         TMDB Watchlist — OMDb Ratings
// @namespace    https://github.com/user/ratings-inject
// @version      1.0.0
// @description  Injects IMDb, Rotten Tomatoes & Metacritic scores into TMDB watchlist cards, cached 3 months
// @author       user
// @match        https://www.themoviedb.org/u/*/watchlist*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      www.omdbapi.com
// @run-at       document-idle
// ==/UserScript==
'use strict';

const OMDB_API_KEY  = '2deceaec';
const CACHE_TTL_MS  = 90 * 24 * 60 * 60 * 1000; // 3 months
const CACHE_VERSION = 6;
const CARD_SEL      = 'div.card.v4';
const CONSENSUS_SEL = '.consensus.tight';

// Fetch URL via GM_xmlhttpRequest, parse JSON. Returns null on any error.
function safeJSONRequest(url) {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET', url: url.toString(),
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
      onload(r) {
        if (r.status < 200 || r.status >= 300) { resolve(null); return; }
        try { resolve(JSON.parse(r.responseText)); } catch { resolve(null); }
      },
      onerror()   { resolve(null); },
      ontimeout() { resolve(null); },
    });
  });
}

// Query OMDb by title + optional year. Retries without year if first attempt misses.
async function fetchFromOmdb(title, year, type) {
  if (!title) return null;
  console.warn('[ratings-inject] OMDb API call — max 1000/day');
  const query = (y) => {
    const url = new URL('https://www.omdbapi.com/');
    url.search = new URLSearchParams({
      apikey: OMDB_API_KEY, r: 'json',
      t: title, type: type === 'tv' ? 'series' : 'movie',
      ...(y ? { y } : {}),
    }).toString();
    return safeJSONRequest(url);
  };
  const data = await query(year);
  if ((!data || data.Response === 'False') && year) {
    console.warn(`[ratings-inject] OMDb miss with year=${year}, retrying without…`);
    return query(null);
  }
  return data;
}

function cacheKey(type, tmdbId) {
  return `omdb_cache_v${CACHE_VERSION}_${type}_${tmdbId}`;
}

function readCache(type, tmdbId) {
  try {
    const entry = JSON.parse(GM_getValue(cacheKey(type, tmdbId), 'null'));
    return entry && Date.now() - entry.ts < CACHE_TTL_MS ? entry : null;
  } catch { return null; }
}

function writeCache(type, tmdbId, payload) {
  GM_setValue(cacheKey(type, tmdbId), JSON.stringify({ ts: Date.now(), ...payload }));
}

async function getCachedOrFetch(type, tmdbId, title, year) {
  const cached = readCache(type, tmdbId);
  if (cached) return cached;

  const data = await fetchFromOmdb(title, year, type);
  console.log(`[ratings-inject] OMDb response for "${title}":`, data);

  let rt = null, mc = null, imdb = null;
  if (data?.Response !== 'False' && Array.isArray(data?.Ratings)) {
    for (const { Source, Value } of data.Ratings) {
      if (Source === 'Rotten Tomatoes')         rt   = Value;
      if (Source === 'Metacritic')              mc   = Value;
      if (Source === 'Internet Movie Database') imdb = Value;
    }
    // top-level imdbRating as fallback
    if (!imdb && data.imdbRating && data.imdbRating !== 'N/A') imdb = `${data.imdbRating}/10`;
  }

  const imdbID = (data?.imdbID && data.imdbID !== 'N/A') ? data.imdbID : null;

  if (imdb || rt || mc) writeCache(type, tmdbId, { title, imdb, rt, mc, imdbID });
  else console.warn(`[ratings-inject] No ratings for "${title}" — not caching`);

  return { imdb, rt, mc, imdbID, title };
}

// Parse "6.2/10", "58%", "60/100" → 0..1
function toFraction(value) {
  if (!value || value === 'N/A') return 0;
  if (value.endsWith('%')) return parseFloat(value) / 100;
  const [num, den] = value.split('/').map(Number);
  return den ? num / den : 0;
}

const svgNS = 'http://www.w3.org/2000/svg';
const RING_R = 14, RING_CX = 17, RING_CY = 17, RING_SW = 3;
const RING_C = 2 * Math.PI * RING_R; // full circumference ≈ 87.96

function svgEl(tag, attrs) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Build the ring SVG with a progress arc. centerNode is an SVG element placed at the center.
function makeRingSvg(fraction, color, centerNode) {
  const svg = svgEl('svg', { width: 30, height: 30, viewBox: `0 0 ${RING_CX*2} ${RING_CY*2}` });
  svg.style.cssText = 'display:block;flex-shrink:0;';
  // track ring
  svg.appendChild(svgEl('circle', { cx: RING_CX, cy: RING_CY, r: RING_R,
    fill: 'none', stroke: '#333', 'stroke-width': RING_SW }));
  // progress arc, starting at 12 o'clock
  svg.appendChild(svgEl('circle', { cx: RING_CX, cy: RING_CY, r: RING_R,
    fill: 'none', stroke: color, 'stroke-width': RING_SW,
    'stroke-linecap': 'round',
    'stroke-dasharray': RING_C,
    'stroke-dashoffset': RING_C * (1 - Math.max(0, Math.min(1, fraction))),
    transform: `rotate(-90 ${RING_CX} ${RING_CY})` }));
  svg.appendChild(centerNode);
  return svg;
}

// Emoji/text icon centered in the ring
function makeTextIcon(text) {
  return Object.assign(
    svgEl('text', { x: RING_CX, y: 20, 'text-anchor': 'middle', 'font-size': 10, fill: '#fff' }),
    { textContent: text }
  );
}

// IMDb badge icon: gold rounded rect with black "IMDb" wordmark
function makeImdbIcon() {
  const W = 18, H = 9, x = RING_CX - W/2, y = RING_CY - H/2;
  const g = svgEl('g', {});
  g.appendChild(svgEl('rect', { x, y, width: W, height: H, rx: 1.5, fill: '#F5C518' }));
  g.appendChild(Object.assign(
    svgEl('text', { x: RING_CX, y: y + H * 0.78, 'text-anchor': 'middle',
      'font-size': 6.5, 'font-weight': 900, 'font-family': 'Impact,Arial Black,sans-serif', fill: '#000' }),
    { textContent: 'IMDb' }
  ));
  return g;
}

// Build a rating pill: ring SVG + score/label text, wrapped in a clickable anchor.
function makePill(centerIcon, scoreText, label, fraction, color, url) {
  const pill = document.createElement('a');
  if (url) Object.assign(pill, { href: url, target: '_blank', rel: 'noopener noreferrer' });
  pill.style.cssText = 'display:inline-flex;align-items:center;height:38px;padding:2px 2px 2px 5px;' +
    'background:#1c1c1c;border-radius:999px;box-shadow:0 1px 3px rgba(0,0,0,0.5);' +
    'overflow:hidden;text-decoration:none;cursor:pointer;';

  pill.appendChild(makeRingSvg(fraction, color, centerIcon));

  const block = document.createElement('div');
  block.style.cssText = 'display:flex;flex-direction:column;justify-content:center;' +
    'padding:0 8px 0 5px;line-height:1.2;min-width:0;';

  const score = Object.assign(document.createElement('span'), { textContent: scoreText });
  score.style.cssText = 'font-size:12px;font-weight:700;color:#fff;white-space:nowrap;font-family:system-ui,sans-serif;';

  const lbl = Object.assign(document.createElement('span'), { textContent: label });
  lbl.style.cssText = 'font-size:8px;font-weight:500;color:#999;white-space:nowrap;' +
    'font-family:system-ui,sans-serif;letter-spacing:0.03em;text-transform:uppercase;';

  block.append(score, lbl);
  pill.appendChild(block);
  return pill;
}

function renderBadges(card, { imdb, rt, mc, imdbID, title }, type, tmdbId) {
  if (!imdb && !rt && !mc) return;

  const detailsWrapper = card.querySelector('.details .wrapper');
  if (!detailsWrapper) { console.error('[ratings-inject] .details .wrapper not found', card); return; }

  const consensus = card.querySelector(`.details ${CONSENSUS_SEL}`);
  const titleEl   = card.querySelector('.details .wrapper .title');

  const row = document.createElement('div');
  row.className = 'omdb-ratings';
  row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0 0;flex-wrap:nowrap;';

  // Move TMDB consensus circle into the row as the first item
  if (consensus) { consensus.style.margin = '0'; row.appendChild(consensus); }

  const q = encodeURIComponent(title ?? '');

  if (imdb && imdb !== 'N/A') {
    const url = imdbID ? `https://www.imdb.com/title/${imdbID}/` : `https://www.imdb.com/find/?q=${q}`;
    row.appendChild(makePill(makeImdbIcon(), imdb.replace('/10', ''), 'IMDb', toFraction(imdb), '#F5C518', url));
  }
  if (rt && rt !== 'N/A') {
    row.appendChild(makePill(makeTextIcon('🍅'), rt, 'Rotten', toFraction(rt), '#FA320A',
      `https://www.rottentomatoes.com/search?search=${q}`));
  }
  if (mc && mc !== 'N/A') {
    row.appendChild(makePill(makeTextIcon('M'), mc.replace('/100', ''), 'Metacritic', toFraction(mc), '#66cc33',
      `https://www.metacritic.com/search/${q}/`));
  }

  const refreshBtn = document.createElement('button');
  refreshBtn.title = 'Refresh ratings';
  refreshBtn.textContent = '↻';
  refreshBtn.style.cssText = 'width:38px;height:38px;border-radius:50%;background:#1c1c1c;border:1px solid #444;' +
    'color:#fff;font-size:18px;line-height:1;cursor:pointer;flex-shrink:0;' +
    'display:inline-flex;align-items:center;justify-content:center;padding:0;margin-left:2px;transition:background 0.15s;';
  refreshBtn.addEventListener('mouseenter', () => { refreshBtn.style.background = '#2e2e2e'; });
  refreshBtn.addEventListener('mouseleave', () => { refreshBtn.style.background = '#1c1c1c'; });
  refreshBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    // Invalidate cache
    if (typeof GM_deleteValue === 'function') GM_deleteValue(cacheKey(type, tmdbId));
    else GM_setValue(cacheKey(type, tmdbId), JSON.stringify({ ts: 0 }));
    // Restore consensus to its original position, then re-queue the card
    const existingConsensus = row.querySelector(CONSENSUS_SEL);
    if (existingConsensus) detailsWrapper.prepend(existingConsensus);
    row.remove();
    delete card.dataset.injected;
    enqueueCard(card);
  });
  row.appendChild(refreshBtn);

  // Insert row after .title (or append as fallback)
  if (titleEl) { detailsWrapper.prepend(titleEl); titleEl.insertAdjacentElement('afterend', row); }
  else detailsWrapper.appendChild(row);
}

async function processCard(card) {
  if (card.dataset.injected) return;
  card.dataset.injected = '1';

  const linkEl = card.querySelector('a.result[href]');
  const href   = linkEl?.getAttribute('href') ?? '';
  // Parse type + ID from href like /movie/83542-cloud-atlas or /tv/1396-breaking-bad
  const match     = href.match(/^\/(movie|tv)\/(\d+)/);
  const mediaType = match?.[1] ?? linkEl?.dataset.mediaType;
  const tmdbId    = match?.[2] ?? linkEl?.dataset.id;

  if (!tmdbId || !mediaType) { console.warn('[ratings-inject] Could not extract ID/type', card); return; }

  const title = card.querySelector('h2 span')?.textContent?.trim() ?? null;
  if (!title) { console.warn('[ratings-inject] Could not extract title', card); return; }

  // Extract 4-digit year from release date text, e.g. "November 22, 2012"
  const year = card.querySelector('.release_date')?.textContent?.match(/\b(\d{4})\b/)?.[1] ?? null;

  try {
    renderBadges(card, await getCachedOrFetch(mediaType, tmdbId, title, year), mediaType, tmdbId);
  } catch (err) {
    console.error('[ratings-inject] Error processing card', mediaType, tmdbId, err);
  }
}

// Concurrency limiter — prevents hammering OMDb with too many simultaneous requests
const CONCURRENCY = 3;
let _running = 0;
const _queue = [];

function enqueueCard(card) { _queue.push(card); _drain(); }

function _drain() {
  while (_running < CONCURRENCY && _queue.length) {
    _running++;
    processCard(_queue.shift()).finally(() => { _running--; _drain(); });
  }
}

function setupObserver() {
  const root = document.querySelector('div.results, .page_wrapper') ?? document.body;
  new MutationObserver((mutations) => {
    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(CARD_SEL) && !node.dataset.injected) enqueueCard(node);
        node.querySelectorAll?.(`${CARD_SEL}:not([data-injected])`).forEach(enqueueCard);
      }
    }
  }).observe(root, { childList: true, subtree: true });
}

document.querySelectorAll(`${CARD_SEL}:not([data-injected])`).forEach(enqueueCard);
setupObserver();
