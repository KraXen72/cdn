const THEME_KEY = 'gmdip-theme';
const REFERENCE_DEFINITION_REGEX = /^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))[^\r\n]*$/gm;
const REFERENCE_IMAGE_REGEX = /!\[([^\]\r\n]*)\]\[([^\]\r\n]*)\]/g;
const INLINE_IMAGE_REGEX = /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\r\n)]*\)))?\s*\)/g;
const MIME_EXTENSIONS = {
	'image/avif': 'avif',
	'image/bmp': 'bmp',
	'image/gif': 'gif',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/png': 'png',
	'image/svg+xml': 'svg',
	'image/webp': 'webp',
	'image/x-icon': 'ico',
	'image/vnd.microsoft.icon': 'ico',
};

const input = document.getElementById('input');
const output = document.getElementById('output');
const errorEl = document.getElementById('error');
const imagesSection = document.getElementById('images');
const imagesGrid = document.getElementById('images-grid');
const clearBtn = document.getElementById('clear');
const copyCleanedBtn = document.getElementById('copy-cleaned');
const downloadZipBtn = document.getElementById('download-zip');
const documentNameInput = document.getElementById('document-name');
const imageFolderInput = document.getElementById('image-folder');
const imageCount = document.getElementById('image-count');
const exportStatus = document.getElementById('export-status');
const locationInputs = Array.from(document.querySelectorAll('input[name="image-location"]'));
let previewUrls = [];
let inputTimer;

/** Applies the stored theme, or follows the operating-system preference when unset. */
function initializeTheme() {
	const doc = document.documentElement;
	const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');

	const applyPreference = (preference) => {
		const useLightTheme = preference === 'light' || (preference === 'system' && mediaQuery.matches);
		doc.classList.toggle('skin-theme-clientpref-day', useLightTheme);
	};

	const updateButton = () => {
		const stored = localStorage.getItem(THEME_KEY);
		const effective = stored || (mediaQuery.matches ? 'light' : 'dark');
		document.getElementById('theme-toggle').setAttribute('aria-pressed', String(effective === 'light'));
	};

	applyPreference(localStorage.getItem(THEME_KEY) || 'system');
	doc.classList.remove('theme-preload');
	doc.classList.add('theme-ready');

	mediaQuery.addEventListener?.('change', () => {
		if (!localStorage.getItem(THEME_KEY)) applyPreference('system');
		updateButton();
	});

	const button = document.getElementById('theme-toggle');
	button.addEventListener('click', () => {
		const stored = localStorage.getItem(THEME_KEY);
		const effective = stored || (mediaQuery.matches ? 'light' : 'dark');
		const next = effective === 'light' ? 'dark' : 'light';
		localStorage.setItem(THEME_KEY, next);
		applyPreference(next);
		updateButton();
	});
	button.addEventListener('contextmenu', (event) => {
		event.preventDefault();
		localStorage.removeItem(THEME_KEY);
		applyPreference('system');
		updateButton();
	});
	updateButton();
}

function showError(message) {
	errorEl.textContent = message;
	errorEl.hidden = false;
}

function hideError() {
	errorEl.hidden = true;
	errorEl.textContent = '';
}

function normalizeReferenceLabel(label) {
	return label.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** Parses a supported base64 image URL, including Google Docs' data:-less variant. */
function parseEncodedImage(value) {
	const trimmed = value.trim();
	const commaIndex = trimmed.indexOf(',');
	if (commaIndex === -1) return null;

	const header = trimmed.slice(0, commaIndex);
	const mimeMatch = header.match(/^(?:data:)?(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64$/i);
	if (!mimeMatch) return null;

	const base64Data = trimmed.slice(commaIndex + 1).replace(/\s+/g, '');
	if (!base64Data || !/^[a-z0-9+/_=-]+$/i.test(base64Data)) return null;
	return { mimeType: mimeMatch[1].toLowerCase(), base64Data };
}

function decodeImage(image) {
	try {
		let normalized = image.base64Data.replace(/-/g, '+').replace(/_/g, '/');
		normalized += '='.repeat((4 - normalized.length % 4) % 4);
		const binary = atob(normalized);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return new Blob([bytes], { type: image.mimeType });
	} catch {
		return null;
	}
}

/**
 * Builds a reusable model of encoded definitions and inline images in Markdown.
 * Reference definitions and inline images retain source offsets for exact rewriting.
 */
function parseMarkdown(markdown) {
	const images = [];
	const references = new Map();
	const definitionsByOffset = new Map();
	const inlineImagesByOffset = new Map();

	markdown.replace(REFERENCE_DEFINITION_REGEX, (fullMatch, label, angleTarget, bareTarget, offset) => {
		const encoded = parseEncodedImage(angleTarget || bareTarget);
		if (!encoded) return fullMatch;
		const image = { ...encoded, suggestedName: label.trim(), label: label.trim() };
		images.push(image);
		references.set(normalizeReferenceLabel(label), image);
		definitionsByOffset.set(offset, image);
		return fullMatch;
	});

	markdown.replace(INLINE_IMAGE_REGEX, (fullMatch, alt, angleTarget, bareTarget, offset) => {
		const encoded = parseEncodedImage(angleTarget || bareTarget);
		if (!encoded) return fullMatch;
		const image = {
			...encoded,
			suggestedName: alt.trim() || `image-${images.length + 1}`,
			label: alt.trim() || `image ${images.length + 1}`,
		};
		images.push(image);
		inlineImagesByOffset.set(offset, image);
		return fullMatch;
	});

	return { images, references, definitionsByOffset, inlineImagesByOffset };
}

function normalizeCleanedMarkdown(markdown) {
	return markdown.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Preserves the original tool's default mode: remove encoded images and their references. */
function createCleanedMarkdown(markdown, model) {
	let cleaned = markdown.replace(REFERENCE_DEFINITION_REGEX, (fullMatch, label, angleTarget, bareTarget, offset) => (
		model.definitionsByOffset.has(offset) ? '\n' : fullMatch
	));
	cleaned = cleaned.replace(REFERENCE_IMAGE_REGEX, '\n');
	cleaned = cleaned.replace(INLINE_IMAGE_REGEX, (fullMatch, alt, angleTarget, bareTarget) => (
		parseEncodedImage(angleTarget || bareTarget) ? '\n' : fullMatch
	));
	return normalizeCleanedMarkdown(cleaned);
}

function sanitizeFileStem(value, fallback) {
	let stem = value
		.normalize('NFKC')
		.replace(/\.[a-z0-9]{2,5}$/i, '')
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[.\s-]+|[.\s-]+$/g, '')
		.slice(0, 80);
	if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = fallback;
	return stem;
}

function extensionForMimeType(mimeType) {
	return MIME_EXTENSIONS[mimeType] || 'img';
}

function assignFileNames(images) {
	const usedNames = new Set();
	for (const [index, image] of images.entries()) {
		const extension = extensionForMimeType(image.mimeType);
		const base = sanitizeFileStem(image.suggestedName, `image-${index + 1}`);
		let fileName = `${base}.${extension}`;
		let suffix = 2;
		while (usedNames.has(fileName.toLocaleLowerCase())) {
			fileName = `${base}-${suffix}.${extension}`;
			suffix += 1;
		}
		usedNames.add(fileName.toLocaleLowerCase());
		image.fileName = fileName;
	}
}

function markdownPath(path) {
	return encodeURI(path).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function createExportMarkdown(markdown, model, imageDirectory) {
	// Rewrite inline images first because their source offsets refer to the original Markdown.
	let exported = markdown.replace(INLINE_IMAGE_REGEX, (fullMatch, alt, angleTarget, bareTarget, offset) => {
		const image = model.inlineImagesByOffset.get(offset);
		if (!image) return fullMatch;
		const path = imageDirectory ? `${imageDirectory}/${image.fileName}` : image.fileName;
		return `![${alt}](${markdownPath(path)})`;
	});

	exported = exported.replace(REFERENCE_IMAGE_REGEX, (fullMatch, alt, explicitLabel) => {
		const label = explicitLabel || alt;
		const image = model.references.get(normalizeReferenceLabel(label));
		if (!image) return fullMatch;
		const path = imageDirectory ? `${imageDirectory}/${image.fileName}` : image.fileName;
		return `![${alt}](${markdownPath(path)})`;
	});

	exported = exported.replace(REFERENCE_DEFINITION_REGEX, (fullMatch, label, angleTarget, bareTarget) => (
		parseEncodedImage(angleTarget || bareTarget) ? '' : fullMatch
	));
	return normalizeCleanedMarkdown(exported);
}

function selectedImageDirectory() {
	const location = locationInputs.find((radio) => radio.checked)?.value;
	if (location === 'same') return '';
	const folder = imageFolderInput.value.trim();
	if (!folder) throw new Error('Enter an image folder name, or choose “Same folder as Markdown”.');
	if (folder === '.' || folder === '..' || /[/\\<>:"|?*\u0000-\u001f]/.test(folder)) {
		throw new Error('The image folder must be one portable folder name without slashes or reserved characters.');
	}
	const portable = folder.replace(/[.\s]+$/g, '');
	if (!portable) throw new Error('Enter a valid image folder name, or choose “Same folder as Markdown”.');
	return portable;
}

function markdownFileName() {
	const requested = documentNameInput.value.trim() || 'index.md';
	const portable = requested
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
		.replace(/[.\s]+$/g, '');
	if (!portable) return 'index.md';
	return /\.md$/i.test(portable) ? portable : `${portable}.md`;
}

function zipFileName(markdownName) {
	const stem = markdownName.replace(/\.md$/i, '');
	return `${sanitizeFileStem(stem, 'markdown-images')}.zip`;
}

function revokePreviewUrls() {
	for (const url of previewUrls) URL.revokeObjectURL(url);
	previewUrls = [];
}

function renderImagePreviews(images) {
	revokePreviewUrls();
	imagesGrid.replaceChildren();
	let validImageCount = 0;

	for (const image of images) {
		const blob = decodeImage(image);
		if (!blob) continue;
		validImageCount += 1;
		const url = URL.createObjectURL(blob);
		previewUrls.push(url);

		const card = document.createElement('article');
		card.className = 'image-card';
		const label = document.createElement('div');
		label.className = 'image-label';
		label.textContent = image.label;
		const preview = document.createElement('div');
		preview.className = 'image-preview';
		const previewImage = document.createElement('img');
		previewImage.src = url;
		previewImage.alt = image.label;
		previewImage.addEventListener('error', () => {
			preview.textContent = 'Invalid image';
			preview.classList.add('placeholder');
		});
		preview.appendChild(previewImage);
		card.append(label, preview);
		imagesGrid.appendChild(card);
	}

	imagesSection.hidden = validImageCount === 0;
	imageCount.textContent = validImageCount === 1 ? '1 image found' : `${validImageCount} images found`;
	downloadZipBtn.disabled = validImageCount === 0;
	return validImageCount;
}

function processInput() {
	hideError();
	exportStatus.textContent = '';
	const markdown = input.value;
	if (!markdown.trim()) {
		output.textContent = '';
		imagesSection.hidden = true;
		imageCount.textContent = 'No images found';
		downloadZipBtn.disabled = true;
		revokePreviewUrls();
		return;
	}

	const model = parseMarkdown(markdown);
	const cleaned = createCleanedMarkdown(markdown, model);
	if (cleaned) {
		const pre = document.createElement('pre');
		pre.textContent = cleaned;
		output.replaceChildren(pre);
	} else {
		const placeholder = document.createElement('div');
		placeholder.className = 'placeholder';
		placeholder.textContent = 'No content';
		output.replaceChildren(placeholder);
	}
	renderImagePreviews(model.images);
}

/** Creates the rewritten Markdown and image files entirely in the browser. */
async function downloadZip() {
	hideError();
	exportStatus.textContent = '';
	if (typeof JSZip === 'undefined') {
		showError('The ZIP library could not be loaded. Check your connection and reload the page.');
		return;
	}

	const markdown = input.value;
	const model = parseMarkdown(markdown);
	const decodableImages = model.images.filter((image) => decodeImage(image));
	if (decodableImages.length !== model.images.length) {
		showError('At least one encoded image is invalid and could not be exported.');
		return;
	}
	if (decodableImages.length === 0) {
		showError('Paste Markdown containing at least one base64-encoded image first.');
		return;
	}

	try {
		const imageDirectory = selectedImageDirectory();
		const mdFileName = markdownFileName();
		assignFileNames(model.images);
		const rewrittenMarkdown = createExportMarkdown(markdown, model, imageDirectory);
		const zip = new JSZip();
		zip.file(mdFileName, rewrittenMarkdown);
		for (const image of model.images) {
			const path = imageDirectory ? `${imageDirectory}/${image.fileName}` : image.fileName;
			zip.file(path, decodeImage(image));
		}

		downloadZipBtn.disabled = true;
		downloadZipBtn.textContent = 'Building ZIP…';
		const archive = await zip.generateAsync({
			type: 'blob',
			compression: 'DEFLATE',
			compressionOptions: { level: 6 },
		});
		const url = URL.createObjectURL(archive);
		const link = document.createElement('a');
		link.href = url;
		link.download = zipFileName(mdFileName);
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		exportStatus.textContent = `Downloaded ${link.download} with ${model.images.length} image${model.images.length === 1 ? '' : 's'}.`;
	} catch (error) {
		showError(error instanceof Error ? error.message : 'Could not create the ZIP archive.');
	} finally {
		downloadZipBtn.disabled = false;
		downloadZipBtn.textContent = 'Download ZIP';
	}
}

initializeTheme();
processInput();

input.addEventListener('input', () => {
	clearTimeout(inputTimer);
	inputTimer = setTimeout(processInput, 120);
});
clearBtn.addEventListener('click', () => {
	input.value = '';
	processInput();
	input.focus();
});
copyCleanedBtn.addEventListener('click', async () => {
	try {
		await navigator.clipboard.writeText(output.textContent || '');
		const original = copyCleanedBtn.textContent;
		copyCleanedBtn.textContent = '✓ Copied!';
		setTimeout(() => { copyCleanedBtn.textContent = original; }, 2000);
	} catch {
		showError('Failed to copy the cleaned Markdown.');
	}
});
downloadZipBtn.addEventListener('click', downloadZip);
for (const radio of locationInputs) {
	radio.addEventListener('change', () => {
		imageFolderInput.disabled = radio.value === 'same' && radio.checked;
	});
}
