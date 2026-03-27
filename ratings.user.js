
// ==UserScript==
// @name         TMDB Watchlist — OMDb Ratings
// @namespace    https://github.com/user/ratings-inject
// @version      1.0.0
// @description  Injects Rotten Tomatoes & Metacritic scores into TMDB watchlist cards, cached 3 months
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
// ─── Constants ────────────────────────────────────────────────────────────────
const OMDB_API_KEY  = '2deceaec';
const CACHE_TTL_MS  = 90 * 24 * 60 * 60 * 1000; // 3 months
const CACHE_VERSION = 6; // bumped: 3-month TTL + refresh button
const CARD_SEL      = 'div.card.v4';
const CONSENSUS_SEL = '.consensus.tight';
// ─── GM_xmlhttpRequest → Promise wrapper ──────────────────────────────────────
/**
 * Fetch a URL via GM_xmlhttpRequest and parse the JSON response.
 * Returns parsed object on success, or null on any error.
 * @param {string|URL} url
 * @returns {Promise<object|null>}
 */
function safeJSONRequest(url) {
  const urlStr = url.toString();
  console.log('[ratings-inject] GM_xmlhttpRequest →', urlStr);
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: urlStr,
      headers: { 'Accept': 'application/json' },
      onload(response) {
        console.log(`[ratings-inject] GM_xmlhttpRequest ← ${response.status} ${urlStr} | body[0:200]: ${response.responseText?.slice(0, 200)}`);
        if (response.status < 200 || response.status >= 300) {
          console.warn('[ratings-inject] HTTP error', response.status, urlStr);
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(response.responseText));
        } catch (e) {
          console.warn('[ratings-inject] JSON parse error', e, urlStr);
          resolve(null);
        }
      },
      onerror(err) {
        console.warn('[ratings-inject] Request error', err, urlStr);
        resolve(null);
      },
      ontimeout() {
        console.warn('[ratings-inject] Request timeout', urlStr);
        resolve(null);
      },
      timeout: 15000,
    });
  });
}
// ─── API wrappers ─────────────────────────────────────────────────────────────
const api = {
  omdb: {
    _base: 'https://www.omdbapi.com/',
    _params: { apikey: OMDB_API_KEY, r: 'json' },
    /**
     * Search OMDb by title + optional year.
     * Uses ?t= (exact title match) — most reliable for well-known titles.
     */
    async findByTitle(title, year, mediaType) {
      if (!title) return null;
      console.warn('[ratings-inject] [expensive] OMDb API call — max 1000/day');
      const url = new URL(this._base);
      const params = {
        ...this._params,
        t: title,
        type: mediaType === 'tv' ? 'series' : 'movie',
      };
      if (year) params.y = year;
      url.search = new URLSearchParams(params).toString();
      return safeJSONRequest(url);
    },
  },
};
// ─── Cache helpers ────────────────────────────────────────────────────────────
/** Cache key for OMDb results, keyed on stable TMDB ID. */
function cacheKey(type, tmdbId) {
  return `omdb_cache_v${CACHE_VERSION}_${type}_${tmdbId}`;
}
/** Read a GM cache entry. Returns parsed value or null if missing/expired. */
function readCache(type, tmdbId) {
  const key = cacheKey(type, tmdbId);
  const raw = GM_getValue(key, null);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw);
    if (Date.now() - entry.ts < CACHE_TTL_MS) return entry;
    return null; // expired
  } catch {
    return null;
  }
}
/** Write a GM cache entry. */
function writeCache(type, tmdbId, payload) {
  const key = cacheKey(type, tmdbId);
  const entry = { ts: Date.now(), ...payload };
  GM_setValue(key, JSON.stringify(entry));
  console.log(`[ratings-inject] cache WRITE ${key}`, entry);
}
// ─── Core data-fetch logic ────────────────────────────────────────────────────
/**
 * Return { rt, mc } for a card, using cache when available.
 * Looks up OMDb by title + year — no TMDB API key required.
 * @param {string} type  - 'movie' | 'tv'
 * @param {string} tmdbId - used only as stable cache key
 * @param {string} title  - extracted from card h2
 * @param {string|null} year  - extracted from card .release_date
 */
async function getCachedOrFetch(type, tmdbId, title, year) {
  const key = cacheKey(type, tmdbId);
  // 1. Cache hit?
  const cached = readCache(type, tmdbId);
  if (cached) {
    console.log(`[ratings-inject] cache HIT  ${key}`, cached);
    return cached;
  }
  console.log(`[ratings-inject] cache MISS ${key} — querying OMDb for "${title}" (${year ?? 'no year'})…`);
  // 2. Fetch OMDb by title+year (no TMDB API needed)
  // If year-constrained search misses, retry without year (common for foreign/alternate titles)
  let omdbData = await api.omdb.findByTitle(title, year, type);
  console.log(`[ratings-inject] OMDb raw response for "${title}" (year=${year ?? 'none'} type=${type}):`, omdbData);
  if (!omdbData || omdbData.Response === 'False') {
    if (year) {
      console.warn(`[ratings-inject] OMDb miss with year=${year}, retrying without year…`);
      omdbData = await api.omdb.findByTitle(title, null, type);
      console.log(`[ratings-inject] OMDb retry response for "${title}" (no year):`, omdbData);
    }
  }
  let rt = null;
  let mc = null;
  let imdb = null;
  if (omdbData && omdbData.Response !== 'False' && Array.isArray(omdbData.Ratings)) {
    console.log(`[ratings-inject] OMDb Ratings array:`, omdbData.Ratings);
    for (const rating of omdbData.Ratings) {
      if (rating.Source === 'Rotten Tomatoes')    rt = rating.Value;
      if (rating.Source === 'Metacritic')         mc = rating.Value;
      if (rating.Source === 'Internet Movie Database') imdb = rating.Value;
    }
    // Also pull from top-level imdbRating as fallback
    if (!imdb && omdbData.imdbRating && omdbData.imdbRating !== 'N/A') {
      imdb = `${omdbData.imdbRating}/10`;
    }
  } else {
    console.warn(`[ratings-inject] OMDb no match for "${title}" (Response=${omdbData?.Response})`);
  }
  const imdbID = (omdbData?.imdbID && omdbData.imdbID !== 'N/A') ? omdbData.imdbID : null;
  console.log(`[ratings-inject] Resolved for ${type}/${tmdbId} "${title}": IMDb=${imdb} RT=${rt} MC=${mc} imdbID=${imdbID}`);
  // 3. Only persist if we got real data — don't cache rate-limit/network failures
  if (imdb || rt || mc) {
    writeCache(type, tmdbId, { title, imdb, rt, mc, imdbID });
  } else {
    console.warn(`[ratings-inject] Not caching "${title}" — no ratings returned (rate limit or miss)`);
  }
  return { imdb, rt, mc, imdbID, title };
}
// ─── Badge rendering ──────────────────────────────────────────────────────────

const RING_R   = 14;
const RING_CX  = 17;
const RING_CY  = 17;
const RING_SW  = 3;
const RING_C   = 2 * Math.PI * RING_R; // ≈ 87.96 — full circumference

/**
 * Build a single rating pill with a circular SVG progress ring.
 *
 * @param {string} icon          - emoji or short text for the ring center
 * @param {string} scoreText     - display value, e.g. "6.2", "58%", "60"
 * @param {string} label         - sub-label, e.g. "IMDb", "RT", "MC"
 * @param {number} fraction      - 0..1 progress fill
 * @param {string} color         - brand hex for the progress arc
 * @returns {HTMLElement}
 */
function makePill(icon, scoreText, label, fraction, color, url) {
  const PILL_H    = 38;
  const CIRCLE_D  = 30; // outer diameter of the ring SVG
  const PAD       = 2;  // inset so circle sits inside pill height

  // ── SVG ring ──
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width',  CIRCLE_D);
  svg.setAttribute('height', CIRCLE_D);
  svg.setAttribute('viewBox', `0 0 ${RING_CX * 2} ${RING_CY * 2}`);
  svg.style.cssText = 'display:block;flex-shrink:0;';

  // track circle (full ring background)
  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('cx', RING_CX);
  track.setAttribute('cy', RING_CY);
  track.setAttribute('r',  RING_R);
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', '#333');
  track.setAttribute('stroke-width', RING_SW);
  svg.appendChild(track);

  // progress arc — starts at 12 o'clock (rotate -90°)
  const arc = document.createElementNS(svgNS, 'circle');
  arc.setAttribute('cx', RING_CX);
  arc.setAttribute('cy', RING_CY);
  arc.setAttribute('r',  RING_R);
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', color);
  arc.setAttribute('stroke-width', RING_SW);
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', RING_C);
  arc.setAttribute('stroke-dashoffset', RING_C * (1 - Math.max(0, Math.min(1, fraction))));
  arc.setAttribute('transform', `rotate(-90 ${RING_CX} ${RING_CY})`);
  svg.appendChild(arc);

  // center icon/text
  const iconEl = document.createElementNS(svgNS, 'text');
  iconEl.setAttribute('x', RING_CX);
  iconEl.setAttribute('y', '20');
  iconEl.setAttribute('text-anchor', 'middle');
  iconEl.setAttribute('font-size', '10');
  iconEl.setAttribute('fill', '#fff');
  iconEl.textContent = icon;
  svg.appendChild(iconEl);

  // ── Score + label text block ──
  const textBlock = document.createElement('div');
  textBlock.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'justify-content:center',
    'padding:0 8px 0 5px',
    'line-height:1.2',
    'min-width:0',
  ].join(';');

  const scoreEl = document.createElement('span');
  scoreEl.style.cssText = [
    'font-size:12px',
    'font-weight:700',
    'color:#fff',
    'white-space:nowrap',
    'font-family:system-ui,sans-serif',
  ].join(';');
  scoreEl.textContent = scoreText;

  const labelEl = document.createElement('span');
  labelEl.style.cssText = [
    'font-size:8px',
    'font-weight:500',
    'color:#999',
    'white-space:nowrap',
    'font-family:system-ui,sans-serif',
    'letter-spacing:0.03em',
    'text-transform:uppercase',
  ].join(';');
  labelEl.textContent = label;

  textBlock.appendChild(scoreEl);
  textBlock.appendChild(labelEl);

  // ── Pill wrapper (anchor for clickability) ──
  const pill = document.createElement('a');
  if (url) {
    pill.href   = url;
    pill.target = '_blank';
    pill.rel    = 'noopener noreferrer';
  }
  pill.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    `height:${PILL_H}px`,
    `padding:${PAD}px ${PAD}px ${PAD}px 5px`,
    'background:#1c1c1c',
    'border-radius:999px',
    'box-shadow:0 1px 3px rgba(0,0,0,0.5)',
    'overflow:hidden',
    'text-decoration:none',
    'cursor:pointer',
  ].join(';');

  pill.appendChild(svg);
  pill.appendChild(textBlock);
  return pill;
}

/**
 * Parse a rating value string into a 0..1 fraction.
 * Handles "6.2/10", "58%", "60/100".
 */
function toFraction(value) {
  if (!value || value === 'N/A') return 0;
  if (value.endsWith('%'))       return parseFloat(value) / 100;
  if (value.includes('/')) {
    const [num, den] = value.split('/').map(Number);
    return den ? num / den : 0;
  }
  return 0;
}

/**
 * Inject rating pills into a card.
 * @param {Element} card
 * @param {{ imdb: string|null, rt: string|null, mc: string|null, imdbID: string|null, title: string|null }} data
 * @param {string} type    - 'movie' | 'tv'
 * @param {string} tmdbId  - used for cache invalidation on refresh
 */
function renderBadges(card, { imdb, rt, mc, imdbID, title }, type, tmdbId) {
  console.log(`[ratings-inject] renderBadges — imdb=${imdb} rt=${rt} mc=${mc} imdbID=${imdbID}`);

  if (!imdb && !rt && !mc) {
    console.warn('[ratings-inject] renderBadges — no ratings to show, skipping');
    return;
  }

  const consensus      = card.querySelector(`.details ${CONSENSUS_SEL}`);
  const detailsWrapper = card.querySelector('.details .wrapper');
  const titleEl        = card.querySelector('.details .wrapper .title');
  console.log('[ratings-inject] renderBadges — consensus:', consensus, '| wrapper:', detailsWrapper, '| title:', titleEl);
  if (!detailsWrapper) {
    console.error('[ratings-inject] renderBadges — could not find .details .wrapper in card', card);
    return;
  }

  // ── Build the ratings row ──────────────────────────────────────────────────
  const row = document.createElement('div');
  row.className = 'omdb-ratings';
  row.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:6px',
    'margin:4px 0 0',
    'flex-wrap:nowrap',
  ].join(';');

  // Move TMDB consensus circle into the row as the first item
  if (consensus) {
    consensus.style.margin = '0';
    consensus.remove();
    row.appendChild(consensus);
  }

  const titleEncoded = encodeURIComponent(title ?? '');

  // IMDb: "6.2/10" → display "6.2"
  if (imdb && imdb !== 'N/A') {
    const imdbUrl = imdbID
      ? `https://www.imdb.com/title/${imdbID}/`
      : `https://www.imdb.com/find/?q=${titleEncoded}`;
    row.appendChild(makePill('⭐', imdb.replace('/10', ''), 'IMDb', toFraction(imdb), '#F5C518', imdbUrl));
  }

  // Rotten Tomatoes: "58%" → display "58%"
  if (rt && rt !== 'N/A') {
    const rtUrl = `https://www.rottentomatoes.com/search?search=${titleEncoded}`;
    row.appendChild(makePill('🍅', rt, 'Rotten', toFraction(rt), '#FA320A', rtUrl));
  }

  // Metacritic: "60/100" → display "60"
  if (mc && mc !== 'N/A') {
    const mcUrl = `https://www.metacritic.com/search/${titleEncoded}/`;
    row.appendChild(makePill('M', mc.replace('/100', ''), 'Metacritic', toFraction(mc), '#66cc33', mcUrl));
  }

  // ── Refresh button ─────────────────────────────────────────────────────────
  const refreshBtn = document.createElement('button');
  refreshBtn.title = 'Refresh ratings';
  refreshBtn.textContent = '↻';
  refreshBtn.style.cssText = [
    'width:38px',
    'height:38px',
    'border-radius:50%',
    'background:#1c1c1c',
    'border:1px solid #444',
    'color:#fff',
    'font-size:18px',
    'line-height:1',
    'cursor:pointer',
    'flex-shrink:0',
    'display:inline-flex',
    'align-items:center',
    'justify-content:center',
    'padding:0',
    'margin-left:2px',
    'transition:background 0.15s',
  ].join(';');
  refreshBtn.addEventListener('mouseenter', () => { refreshBtn.style.background = '#2e2e2e'; });
  refreshBtn.addEventListener('mouseleave', () => { refreshBtn.style.background = '#1c1c1c'; });
  refreshBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log(`[ratings-inject] Refresh clicked for ${type}/${tmdbId}`);
    // Invalidate cache
    const key = cacheKey(type, tmdbId);
    if (typeof GM_deleteValue === 'function') {
      GM_deleteValue(key);
    } else {
      GM_setValue(key, JSON.stringify({ ts: 0 }));
    }
    // Restore .consensus.tight to its original position (before .title)
    const existingConsensus = row.querySelector(CONSENSUS_SEL);
    if (existingConsensus && detailsWrapper) {
      detailsWrapper.prepend(existingConsensus);
    }
    // Remove the injected row
    row.remove();
    // Re-queue the card
    delete card.dataset.injected;
    enqueueCard(card);
  });
  row.appendChild(refreshBtn);

  // ── Restructure .details .wrapper: title first, then row ──────────────────
  // Move .title to top (first child), then append row after it
  if (titleEl) {
    detailsWrapper.prepend(titleEl);  // ensure title is first
    titleEl.insertAdjacentElement('afterend', row);
    console.log('[ratings-inject] renderBadges — restructured: title → row ✓');
  } else {
    // fallback: just append row
    detailsWrapper.appendChild(row);
    console.log('[ratings-inject] renderBadges — appended row to wrapper (no title found) ✓');
  }
}
// ─── Card processing ──────────────────────────────────────────────────────────
/**
 * Process a single watchlist card: extract IDs, fetch ratings, inject badges.
 * @param {Element} card
 */
async function processCard(card) {
  // Guard: skip already-processed cards
  if (card.dataset.injected) return;
  card.dataset.injected = '1';
  // Primary: parse type + numeric ID from the poster/title link href
  // e.g. href="/movie/83542-cloud-atlas" or "/tv/1396-breaking-bad"
  let tmdbId, mediaType;
  const linkEl = card.querySelector('a.result[href]');
  const href = linkEl?.getAttribute('href') ?? null;
  console.log('[ratings-inject] processCard — linkEl:', linkEl, '| href:', href);
  if (linkEl && href) {
    const match = href.match(/^\/(movie|tv)\/(\d+)/);
    if (match) {
      mediaType = match[1];
      tmdbId    = match[2];
      console.log(`[ratings-inject] processCard — parsed from href: type=${mediaType} id=${tmdbId}`);
    } else {
      console.warn('[ratings-inject] processCard — href did not match /movie|tv/id pattern:', href);
    }
  }
  // Fallback: data attributes (may be empty strings on some pages)
  if (!tmdbId || !mediaType) {
    mediaType = linkEl?.dataset.mediaType;
    tmdbId    = linkEl?.dataset.id;
    console.log(`[ratings-inject] processCard — fallback data attrs: type=${mediaType} id=${tmdbId}`);
  }
  if (!tmdbId || !mediaType) {
    console.warn('[ratings-inject] processCard — Could not extract ID/type from card', card);
    return;
  }
  // Extract title from h2 > span (the card's movie/show name)
  const title = card.querySelector('h2 span')?.textContent?.trim() ?? null;
  // Extract year from .release_date text, e.g. "November 22, 2012" or "2012" or "Sep 17, 2024"
  const releaseDateText = card.querySelector('.release_date')?.textContent?.trim() ?? '';
  const yearMatch = releaseDateText.match(/\b(\d{4})\b/);
  const year = yearMatch ? yearMatch[1] : null;

  console.log(`[ratings-inject] processCard — processing ${mediaType}/${tmdbId} title="${title}" year=${year}`, card);

  if (!title) {
    console.warn('[ratings-inject] processCard — could not extract title from card', card);
    return;
  }

  try {
    const ratings = await getCachedOrFetch(mediaType, tmdbId, title, year);
    renderBadges(card, ratings, mediaType, tmdbId);
  } catch (err) {
    console.error('[ratings-inject] processCard — unexpected error for', mediaType, tmdbId, err);
  }
}
// ─── Concurrency limiter ──────────────────────────────────────────────────────
// Prevents firing 50 simultaneous TMDB/OMDb requests which stall or rate-limit.
const CONCURRENCY = 3;
let _running = 0;
const _queue = [];

function enqueueCard(card) {
  _queue.push(card);
  _drain();
}

function _drain() {
  while (_running < CONCURRENCY && _queue.length > 0) {
    const card = _queue.shift();
    _running++;
    processCard(card).finally(() => {
      _running--;
      _drain();
    });
  }
}

/**
 * Find and process all unhandled cards currently in the DOM.
 */
function processAllCards() {
  const cards = document.querySelectorAll(`${CARD_SEL}:not([data-injected])`);
  console.log(`[ratings-inject] processAllCards — found ${cards.length} card(s) with selector "${CARD_SEL}"`, cards);
  for (const card of cards) {
    enqueueCard(card);
  }
}
// ─── MutationObserver (infinite scroll support) ───────────────────────────────
function setupObserver() {
  const root = document.querySelector('div.results') ?? document.querySelector('.page_wrapper') ?? document.body;
  console.log('[ratings-inject] MutationObserver — watching root:', root);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue; // element nodes only
        // The added node might itself be a card, or contain cards
        if (node.matches?.(CARD_SEL) && !node.dataset.injected) {
          console.log('[ratings-inject] MutationObserver — new card node detected (direct):', node);
          enqueueCard(node);
        }
        const nested = node.querySelectorAll?.(`${CARD_SEL}:not([data-injected])`);
        if (nested?.length) {
          console.log(`[ratings-inject] MutationObserver — ${nested.length} new nested card(s) detected in`, node);
          nested.forEach(enqueueCard);
        }
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
}
// ─── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  console.log('[ratings-inject] init — script loaded, URL:', location.href);
  console.log('[ratings-inject] init — scanning for cards…');
  processAllCards();
  setupObserver();
})();
