/* Theme initialization: use system by default, persist user's choice in localStorage.
			 Prevent flash by keeping `html.theme-preload` until the theme is applied,
			 then add `theme-ready` to fade in the main content. */
// Using jsDelivr ESM build; will dynamically import and patch it below.

(function () {
	const THEME_KEY = 'gmdip-theme';
	const doc = document.documentElement;
	const mq = window.matchMedia('(prefers-color-scheme: light)');

	function applyPref(pref) {
		if (pref === 'light') doc.classList.add('skin-theme-clientpref-day');
		else if (pref === 'dark') doc.classList.remove('skin-theme-clientpref-day');
		else {
			if (mq.matches) doc.classList.add('skin-theme-clientpref-day');
			else doc.classList.remove('skin-theme-clientpref-day');
		}
	}

	// React to system changes only when no explicit preference is stored
	if (mq.addEventListener) {
		mq.addEventListener('change', () => {
			if (!localStorage.getItem(THEME_KEY)) applyPref('system');
		});
	} else {
		mq.addListener(() => { if (!localStorage.getItem(THEME_KEY)) applyPref('system'); });
	}

	let stored = localStorage.getItem(THEME_KEY) || 'system';
	applyPref(stored);

	// Reveal and fade-in
	doc.classList.remove('theme-preload');
	void document.body.offsetWidth; // force reflow
	doc.classList.add('theme-ready');

	// Toggle button wiring
	const btn = document.getElementById('theme-toggle');
	if (btn) {
		const updateButton = () => {
			const s = localStorage.getItem(THEME_KEY);
			const effective = s || (mq.matches ? 'light' : 'dark');
			btn.setAttribute('aria-pressed', effective === 'light');
		};

		btn.addEventListener('click', () => {
			const s = localStorage.getItem(THEME_KEY);
			const effective = s || (mq.matches ? 'light' : 'dark');
			const newPref = effective === 'light' ? 'dark' : 'light';
			localStorage.setItem(THEME_KEY, newPref);
			applyPref(newPref);
			updateButton();
		});

		// Right-click resets to system preference (convenience)
		btn.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			localStorage.removeItem(THEME_KEY);
			applyPref('system');
			updateButton();
		});

		updateButton();
	}
})();

const input = document.getElementById('input');
const output = document.getElementById('output');
const errorEl = document.getElementById('error');
const imagesSection = document.getElementById('images');
const imagesGrid = document.getElementById('images-grid');
const clearBtn = document.getElementById('clear');
const copyCleanedBtn = document.getElementById('copy-cleaned');
const formatCleanedBtn = document.getElementById('format-cleaned');

// Initial state for format button
if (formatCleanedBtn) formatCleanedBtn.disabled = true;

// Hongdown formatting configuration (hardcoded per user request)
const hongdownOptions = {
	lineWidth: 9999,
	setextH1: false,
	setextH2: false,
	fenceChar: "`",
	minFenceLength: 3,
	spaceAfterFence: false,
	thematicBreakStyle: "-----",
	thematicBreakLeadingSpaces: 0,
	indentWidth: 4,
	curlyDoubleQuotes: false,
	curlySingleQuotes: false,
	curlyApostrophes: false,
	ellipsis: false,
	enDash: false,
	emDash: false,
};

// Load hongdown from jsDelivr ESM and patch its `#wasm-loader` import so the
// module can find the .wasm file on the CDN. We call `formatWithWarnings`
// directly from the imported module.
let hongdownModule = null;
let hongdownInitPromise = null;

async function initHongdownModule() {
	if (hongdownInitPromise) return hongdownInitPromise;
	hongdownInitPromise = (async () => {
		const moduleUrl = 'https://cdn.jsdelivr.net/npm/@hongdown/wasm@0.2.1/dist/index.mjs';
		const wasmUrl = 'https://cdn.jsdelivr.net/npm/@hongdown/wasm@0.2.1/dist/hongdown_bg.wasm';
		const res = await fetch(moduleUrl);
		if (!res.ok) throw new Error('Failed to fetch hongdown module');
		let code = await res.text();

		// Replace the special import of the wasm loader with a function that
		// returns the CDN wasm URL.
		code = code.replace(/import\s+\{\s*loadWasmBuffer\s*\}\s+from\s+['"][^'\"]*#wasm-loader[^'\"]*['"];?/, `const loadWasmBuffer = async () => '${wasmUrl}';`);

		const blob = new Blob([code], { type: 'application/javascript' });
		const blobUrl = URL.createObjectURL(blob);
		const mod = await import(blobUrl);
		hongdownModule = mod;
		return mod;
	})();
	return hongdownInitPromise;
}

// Module will be loaded on-demand when the user clicks Format.

function showError(msg) {
	errorEl.textContent = msg;
	errorEl.style.display = 'block';
}

function hideError() {
	errorEl.style.display = 'none';
}

function extractImages(markdown) {
	const images = [];
	let cleaned = markdown;

	// Remove reference definitions: [label]: <...base64...>
	const refDefRegex = /\[([^\]]+)\]:\s*<[^>]*base64,[^>]+>/g;
	let match;
	while ((match = refDefRegex.exec(markdown)) !== null) {
		const [fullMatch, label] = match;
		// Extract base64 data
		const base64Match = fullMatch.match(/base64,([A-Za-z0-9+/=]+)/);
		if (base64Match) {
			images.push({ label, base64Data: base64Match[1] });
		}
		// Replace the whole reference definition with a single newline to preserve paragraph breaks
		cleaned = cleaned.replace(fullMatch, '\n');
	}

	// Remove inline image references: ![][label] and ![alt][label]
	const inlineRefRegex = /!\[[^\]]*\]\[[^\]]*\]/g;
	// Replace inline image refs with a newline so surrounding text doesn't get concatenated
	cleaned = cleaned.replace(inlineRefRegex, '\n');

	// Trim only leading/trailing whitespace but preserve internal blank lines
	return { images, cleaned: cleaned.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
}

function createImageBlob(base64Data) {
	try {
		const cleanBase64 = base64Data.replace(/\s+/g, '');
		const binaryString = atob(cleanBase64);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		// Auto-detect image type
		let mimeType = 'image/png';
		if (cleanBase64.startsWith('/9j/')) mimeType = 'image/jpeg';
		else if (cleanBase64.startsWith('R0lGOD')) mimeType = 'image/gif';
		return new Blob([bytes], { type: mimeType });
	} catch (e) {
		return null;
	}
}

async function processInput() {
	hideError();
	const text = input.value.trim();
	if (!text) {
		output.innerHTML = '';
		if (formatCleanedBtn) formatCleanedBtn.disabled = true;
		imagesSection.style.display = 'none';
		return;
	}

	const { images, cleaned } = extractImages(text);
	output.innerHTML = cleaned ? `<pre>${cleaned}</pre>` : '<div class="placeholder">No content</div>';
	if (formatCleanedBtn) formatCleanedBtn.disabled = !cleaned;

	if (images.length === 0) {
		imagesSection.style.display = 'none';
		return;
	}

	imagesGrid.innerHTML = '';
	imagesSection.style.display = 'block';

	for (const img of images) {
		const blob = createImageBlob(img.base64Data);
		if (!blob) continue;

		const url = URL.createObjectURL(blob);
		const card = document.createElement('div');
		card.className = 'image-card';
		card.innerHTML = `
          <div class="image-label">${img.label}</div>
          <div class="image-preview">
            <img src="${url}" alt="${img.label}">
          </div>
        `;
		// Add error handling for image loading
		card.querySelector('img').onerror = function () {
			this.parentElement.innerHTML = '<div class="placeholder">Invalid image</div>';
		};
		imagesGrid.appendChild(card);
	}
}

input.addEventListener('paste', () => {
	setTimeout(processInput, 10);
});

input.addEventListener('input', () => {
	if (!input.value.trim()) {
		output.innerHTML = '';
		imagesSection.style.display = 'none';
		if (formatCleanedBtn) formatCleanedBtn.disabled = true;
	}
});

clearBtn.addEventListener('click', () => {
	input.value = '';
	output.innerHTML = '';
	imagesSection.style.display = 'none';
	hideError();
	if (formatCleanedBtn) formatCleanedBtn.disabled = true;
});

copyCleanedBtn.addEventListener('click', async () => {
	try {
		const text = output.textContent || output.innerText;
		await navigator.clipboard.writeText(text);
		const original = copyCleanedBtn.innerHTML;
		copyCleanedBtn.innerHTML = '✓ Copied!';
		setTimeout(() => copyCleanedBtn.innerHTML = original, 2000);
	} catch (e) {
		showError('Failed to copy');
	}
});

// Format handler
if (formatCleanedBtn) {
	formatCleanedBtn.addEventListener('click', async () => {
		try {
			const text = output.textContent || output.innerText || '';
			if (!text.trim()) {
				alert('No output to format');
				return;
			}
			formatCleanedBtn.disabled = true;
			const original = formatCleanedBtn.innerHTML;
			formatCleanedBtn.innerHTML = 'Formatting...';

			// Ensure module is loaded, then call formatter directly
			await initHongdownModule();
			if (!hongdownModule || !hongdownModule.formatWithWarnings) {
				throw new Error('hongdown module not available');
			}
			const result = await hongdownModule.formatWithWarnings(text, hongdownOptions);
			output.innerHTML = '';
			const pre = document.createElement('pre');
			pre.textContent = result.output;
			output.appendChild(pre);
			if (result.warnings && result.warnings.length) console.warn('Hongdown warnings:', result.warnings);
			formatCleanedBtn.innerHTML = '✓ Formatted!';
			setTimeout(() => { if (formatCleanedBtn) formatCleanedBtn.innerHTML = original; }, 2000);
		} catch (err) {
			alert('Formatting failed — see console for details');
			console.error(err);
		} finally {
			if (formatCleanedBtn) formatCleanedBtn.disabled = false;
		}
	});
}