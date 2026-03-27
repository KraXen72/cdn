// ==UserScript==
// @name         TMDB Watchlist — OMDb Ratings
// @namespace    https://github.com/user/ratings-inject
// @version      2.0.0
// @description  Injects IMDb, Rotten Tomatoes & Metacritic scores into TMDB watchlist cards, cached 3 months
// @author       user
// @match        https://www.themoviedb.org/u/*/watchlist*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      www.omdbapi.com
// @run-at       document-idle
// ==/UserScript==
'use strict';

const OMDB_API_KEY = '2deceaec';
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 3 months
const CACHE_VERSION = 6;
const CARD_SEL = 'div.card.v4';
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
			onerror() { resolve(null); },
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
			if (Source === 'Rotten Tomatoes') rt = Value;
			if (Source === 'Metacritic') mc = Value;
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

// Apply an object of CSS declarations (kebab-case keys) to an element's inline style.
function setStyles(el, styles) {
	for (const [prop, val] of Object.entries(styles)) el.style.setProperty(prop, val);
}

// ── SVG sprite ──────────────────────────────────────────────────────────────
// Injected once into <head>. Each symbol's viewBox is 0 0 100 100 so it
// scales uniformly. Icons are referenced via <use href="#ri-*"> inside the ring.

const SPRITE_ID = 'ratings-inject-sprite';

function injectSprite() {
	if (document.getElementById(SPRITE_ID)) return;

	// Each symbol is drawn in a 100×100 unit square, centered content.
	// IMDb: gold badge with black wordmark
	// MC: bold white "M" on transparent
	// RT-fresh: classic red tomato
	// RT-rotten: green splat

	const sprite = `<svg id="${SPRITE_ID}" xmlns="http://www.w3.org/2000/svg" style="display:none">

	<!-- IMDb: gold rounded rect + "IMDb" wordmark -->
	<symbol id="ri-imdb" viewBox="0 0 100 100">
		<rect x="5" y="32" width="90" height="36" rx="8" fill="#F5C518"/>
		<text x="50" y="60" text-anchor="middle" font-size="28" font-weight="900"
					font-family="Impact,Arial Black,sans-serif" fill="#000">IMDb</text>
	</symbol>

	<!-- Metacritic: bold white "m" -->
	<symbol id="ri-mc" viewBox="0 0 100 100">
		<text x="50" y="72" text-anchor="middle" font-size="72" font-weight="900"
					font-family="Impact,Arial Black,sans-serif" fill="#fff">m</text>
	</symbol>

	<!-- RT Tomato (fresh, ≥60%): red tomato body + green stem/leaves -->
	<symbol id="ri-rt-tomato" viewBox="-13.875 -14.125 166.5 169.5">
		<path fill="#FA320A" d="m20.154 40.829c-28.149 27.622-13.657 61.011-5.734 71.931 35.254 41.954 92.792 25.339 111.89-5.9071 4.7608-8.2027 22.554-53.467-23.976-78.009z"/>
		<path fill="#FA320A" d="m39.613 39.265 4.7778-8.8607 28.406-5.0384 11.119 9.2082z"/>
		<path fill="#02902e" d="m39.436 8.5696 8.9682-5.2826 6.7569 15.479c3.7925-6.3226 13.79-16.316 24.939-4.6684-4.7281 1.2636-7.5161 3.8553-7.7397 8.4768 15.145-4.1697 31.343 3.2127 33.539 9.0911-10.951-4.314-27.695 10.377-41.771 2.334 0.009 15.045-12.617 16.636-19.902 17.076 2.077-4.996 5.591-9.994 1.474-14.987-7.618 8.171-13.874 10.668-33.17 4.668 4.876-1.679 14.843-11.39 24.448-11.425-6.775-2.467-12.29-2.087-17.814-1.475 2.917-3.961 12.149-15.197 28.625-8.476z"/>
	</symbol>

	<!-- RT Splat (rotten, <60%): red splat -->
	<symbol id="ri-rt-splat" viewBox="-14.5 -14 174 168">
		<path fill="#FA320A" d="M47.4 35.342c-13.607-7.935-12.32-25.203 2.097-31.88 26.124-6.531 29.117 13.78 22.652 30.412-6.542 24.11 18.095 23.662 19.925 10.067 3.605-18.412 19.394-26.695 31.67-16.359 12.598 12.135 7.074 36.581-17.827 34.187-16.03-1.545-19.552 19.585.839 21.183 32.228 1.915 42.49 22.167 31.04 35.865-15.993 15.15-37.691-4.439-45.512-19.505-6.8-9.307-17.321.11-13.423 6.502 12.983 19.465 2.923 31.229-10.906 30.62-13.37-.85-20.96-9.06-13.214-29.15 3.897-12.481-8.595-15.386-16.57-5.45-11.707 19.61-28.865 13.68-33.976 4.19-3.243-7.621-2.921-25.846 24.119-23.696 16.688 4.137 11.776-12.561-.63-13.633-9.245-.443-30.501-7.304-22.86-24.54 7.34-11.056 24.958-11.768 33.348 6.293 3.037 4.232 8.361 11.042 18.037 5.033 3.51-5.197 1.21-13.9-8.809-20.135z"/>
	</symbol>

</svg>`;

	document.head.insertAdjacentHTML('beforeend', sprite);
}

// ── Ring + pill rendering ────────────────────────────────────────────────────

const svgNS = 'http://www.w3.org/2000/svg';
const RING_R = 14, RING_CX = 17, RING_CY = 17, RING_SW = 3;
const RING_C = 2 * Math.PI * RING_R; // full circumference ≈ 87.96

function svgEl(tag, attrs) {
	const el = document.createElementNS(svgNS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	return el;
}

// Build the ring SVG with a progress arc. centerSymbolId references a sprite symbol.
function makeRingSvg(fraction, color, centerSymbolId) {
	const size = RING_CX * 2; // 34
	const svg = svgEl('svg', { width: 30, height: 30, viewBox: `0 0 ${size} ${size}` });
	setStyles(svg, {
		'display': 'block',
		'flex-shrink': '0',
	});
	// track ring
	svg.appendChild(svgEl('circle', {
		cx: RING_CX, cy: RING_CY, r: RING_R,
		fill: 'none', stroke: '#333', 'stroke-width': RING_SW
	}));

	// progress arc, starting at 12 o'clock
	svg.appendChild(svgEl('circle', {
		cx: RING_CX, cy: RING_CY, r: RING_R,
		fill: 'none', stroke: color, 'stroke-width': RING_SW,
		'stroke-linecap': 'round',
		'stroke-dasharray': RING_C,
		'stroke-dashoffset': RING_C * (1 - Math.max(0, Math.min(1, fraction))),
		transform: `rotate(-90 ${RING_CX} ${RING_CY})`
	}));

	// center icon — <use> references sprite symbol, scaled to fit inside the ring
	const iconSize = (RING_R - RING_SW) * 2; // diameter of inner circle
	const iconOffset = RING_CX - iconSize / 2;
	const use = svgEl('use', {
		href: `#${centerSymbolId}`,
		x: iconOffset, y: iconOffset,
		width: iconSize, height: iconSize,
	});
	svg.appendChild(use);

	return svg;
}

// Build a rating pill: ring SVG + score text, wrapped in a clickable anchor.
function makePill(symbolId, scoreText, fraction, color, url, title = null) {
	const pill = document.createElement('a');
	if (title) Object.assign(pill, { title })
	if (url) Object.assign(pill, { href: url, target: '_blank', rel: 'noopener noreferrer' });
	setStyles(pill, {
		'display': 'inline-flex',
		'align-items': 'center',
		'height': '38px',
		'padding': '2px 8px 2px 4px',
		'background': '#1c1c1c',
		'border-radius': '999px',
		'box-shadow': '0 1px 3px rgba(0,0,0,0.5)',
		'overflow': 'hidden',
		'text-decoration': 'none',
		'cursor': 'pointer',
		'gap': '4px',
	});

	pill.appendChild(makeRingSvg(fraction, color, symbolId));

	const score = Object.assign(document.createElement('span'), { textContent: scoreText.replaceAll("%", "") });
	setStyles(score, {
		'font-size': '20px',
		'font-weight': '700',
		'color': '#fff',
		'white-space': 'nowrap',
		'font-family': 'system-ui,sans-serif',
	});
	pill.appendChild(score);
	return pill;
}

// Pick the correct RT symbol based on score fraction
function rtSymbolId(fraction) {
	return fraction >= 0.60 ? 'ri-rt-tomato' : 'ri-rt-splat';
}

function renderBadges(card, { imdb, rt, mc, imdbID, title }, type, tmdbId) {
	if (!imdb && !rt && !mc) return;

	const detailsWrapper = card.querySelector('.details .wrapper');
	if (!detailsWrapper) { console.error('[ratings-inject] .details .wrapper not found', card); return; }

	const consensus = card.querySelector(`.details ${CONSENSUS_SEL}`);
	const titleEl = card.querySelector('.details .wrapper .title');
	const isMobile = window.matchMedia('(max-width: 600px)').matches;

	const row = document.createElement('div');
	row.className = 'omdb-ratings';
	setStyles(row, {
		'display': 'flex',
		'align-items': 'center',
		'gap': '6px',
		'padding': isMobile ? '4px 12px 8px' : '0',
		'margin': isMobile ? '0' : '4px 0 0',
		'flex-wrap': 'wrap',
	});

	const q = encodeURIComponent(title ?? '');

	if (imdb && imdb !== 'N/A') {
		const url = imdbID ? `https://www.imdb.com/title/${imdbID}/` : `https://www.imdb.com/find/?q=${q}`;
		row.appendChild(makePill('ri-imdb', imdb.replace('/10', ''), toFraction(imdb), '#F5C518', url, "IMDb"));
	}
	if (rt && rt !== 'N/A') {
		const f = toFraction(rt);
		row.appendChild(makePill(rtSymbolId(f), rt, f, '#FA320A',
			`https://www.rottentomatoes.com/search?search=${q}`, "Rotten Tomatoes"));
	}
	if (mc && mc !== 'N/A') {
		row.appendChild(makePill('ri-mc', mc.replace('/100', ''), toFraction(mc), '#66cc33',
			`https://www.metacritic.com/search/${q}/`, "Metacritic"));
	}

	if (consensus) {
		setStyles(consensus, { 'margin': '0' }); 
		setStyles(consensus.querySelector('.outer_ring'), { 'box-shadow': '0 1px 3px rgba(0,0,0,0.5)' })
		Object.assign(consensus, { title: 'TMDB Community Rating' })
		row.appendChild(consensus);
	}

	const refreshBtn = document.createElement('button');
	refreshBtn.title = 'Refresh ratings';
	refreshBtn.textContent = '↻';
	setStyles(refreshBtn, {
		'width': '38px',
		'height': '38px',
		'border-radius': '50%',
		'background': '#1c1c1c',
		'border': '1px solid #444',
		'box-shadow': '0 1px 3px rgba(0,0,0,0.5)',
		'color': '#fff',
		'font-size': '18px',
		'line-height': '1',
		'cursor': 'pointer',
		'flex-shrink': '0',
		'display': 'inline-flex',
		'align-items': 'center',
		'justify-content': 'center',
		'padding': '0',
		'padding-top': '2px',
		'transition': 'background 0.15s',
	});
	refreshBtn.addEventListener('mouseenter', () => { setStyles(refreshBtn, { 'background': '#2e2e2e' }); });
	refreshBtn.addEventListener('mouseleave', () => { setStyles(refreshBtn, { 'background': '#1c1c1c' }); });
	refreshBtn.addEventListener('click', (e) => {
		e.preventDefault(); e.stopPropagation();
		if (typeof GM_deleteValue === 'function') GM_deleteValue(cacheKey(type, tmdbId));
		else GM_setValue(cacheKey(type, tmdbId), JSON.stringify({ ts: 0 }));
		const existingConsensus = row.querySelector(CONSENSUS_SEL);
		if (existingConsensus) detailsWrapper.prepend(existingConsensus);
		row.remove();
		delete card.dataset.injected;
		enqueueCard(card);
	});
	row.appendChild(refreshBtn);

	// On mobile: insert between poster+details and action_bar (full-width row)
	// On desktop: insert after .title inside .details .wrapper (original position)
	if (isMobile) {
		const actionBar = card.querySelector('.action_bar');
		if (actionBar) actionBar.insertAdjacentElement('beforebegin', row);
		else card.appendChild(row);
	} else {
		if (titleEl) titleEl.insertAdjacentElement('afterend', row);
		else detailsWrapper.appendChild(row);
	}
}

async function processCard(card) {
	if (card.dataset.injected) return;
	card.dataset.injected = '1';

	const linkEl = card.querySelector('a.result[href]');
	const href = linkEl?.getAttribute('href') ?? '';
	// Parse type + ID from href like /movie/83542-cloud-atlas or /tv/1396-breaking-bad
	const match = href.match(/^\/(movie|tv)\/(\d+)/);
	const mediaType = match?.[1] ?? linkEl?.dataset.mediaType;
	const tmdbId = match?.[2] ?? linkEl?.dataset.id;

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

injectSprite();

// Mobile: prevent the ratings row from overflowing the card's details column
GM_addStyle(`
@media (max-width: 600px) {
  .omdb-ratings { flex-wrap: wrap !important; }
  .omdb-ratings a, .omdb-ratings button { flex-shrink: 0; }
}`);

document.querySelectorAll(`${CARD_SEL}:not([data-injected])`).forEach(enqueueCard);
setupObserver();