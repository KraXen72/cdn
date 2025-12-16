import { initSQL } from './sqlHelper.js';
import { log } from './logger.js';
import { convertToNewPipe } from './converters/toNewPipe.js';
import { convertToLibreTube } from './converters/toLibreTube.js';

let SQL;

// --- Initialization ---
window.onload = async () => {
	log("Initializing SQL.js...");
	try {
		SQL = await initSQL();
		log("SQL.js ready.");
	} catch (e) {
		log("Error loading SQL.js: " + (e.message || e.toString()), "err");
	}
	updateUI();
	setupDropZones();
};

// --- UI Logic ---
function updateUI() {
	const mode = document.querySelector('input[name="mode"]:checked').value;
	const btnNP = document.getElementById('btn-to-newpipe');
	const btnLT = document.getElementById('btn-to-libretube');
	const fileNP = document.getElementById('file-newpipe');
	const fileLT = document.getElementById('file-libretube');

	if (mode === 'merge') {
		btnNP.textContent = "Merge into NewPipe";
		btnLT.textContent = "Merge into LibreTube";
		fileNP.disabled = false;
		fileLT.disabled = false;
	} else {
		btnNP.textContent = "Convert LibreTube -> NewPipe";
		btnLT.textContent = "Convert NewPipe -> LibreTube";
	}
}

async function processBackup(direction) {
	const mode = document.querySelector('input[name="mode"]:checked').value;
	const npFile = document.getElementById('file-newpipe').files[0];
	const ltFile = document.getElementById('file-libretube').files[0];

	if (mode === 'merge' && (!npFile || !ltFile)) {
		return log("Merge mode requires BOTH files.", "err");
	}
	if (mode === 'convert') {
		if (direction === 'to_newpipe' && !ltFile) return log("Missing LibreTube source file.", "err");
		if (direction === 'to_libretube' && !npFile) return log("Missing NewPipe source file.", "err");
	}

	try {
		document.querySelectorAll('.controls button').forEach(btn => btn.disabled = true);
		if (direction === 'to_newpipe') {
			await convertToNewPipe(npFile, ltFile, mode, SQL);
		} else {
			await convertToLibreTube(npFile, ltFile, mode, SQL);
		}
	} catch (e) {
		log(`FATAL ERROR: ${e.message || e.toString() || 'An unknown error occurred'}`, "err");
		if (e.stack) log(`Stack Trace: ${e.stack}`, "err");
		else log(`Error Object: ${e.toString()}`, "err");
		console.error(e);
	} finally {
		document.querySelectorAll('.controls button').forEach(btn => btn.disabled = false);
	}
}

// Expose to global for HTML bindings
window.processBackup = processBackup;
window.updateUI = updateUI;

// Setup clickable + drag-and-drop behavior for .drop-zone elements
function setupDropZones() {
	document.querySelectorAll('.drop-zone').forEach(zone => {
		const input = zone.querySelector('input[type="file"]');
		const nameEl = zone.querySelector('.file-name');
		if (!input) return;

		// Click anywhere in zone to open file picker
		zone.addEventListener('click', (e) => {
			// allow native file input clicks to pass through
			if (e.target === input) return;
			input.click();
		});

		// Keyboard accessible (Enter / Space)
		zone.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				input.click();
			}
		});

		// Drag & Drop
		zone.addEventListener('dragover', (e) => {
			e.preventDefault();
			zone.classList.add('active');
		});
		zone.addEventListener('dragleave', () => {
			zone.classList.remove('active');
		});
		zone.addEventListener('drop', (e) => {
			e.preventDefault();
			zone.classList.remove('active');
			const files = e.dataTransfer && e.dataTransfer.files;
			if (files && files.length) {
				// Use DataTransfer to assign files to input.files
				try {
					const dt = new DataTransfer();
					for (let i = 0; i < files.length; i++) dt.items.add(files[i]);
					input.files = dt.files;
					input.dispatchEvent(new Event('change', { bubbles: true }));
				} catch (err) {
					// fallback: if unable to set files, call handlers directly or inform user
					console.warn('Could not set input.files programmatically', err);
				}
			}
		});

		// Reflect selected filename in UI
		input.addEventListener('change', () => {
			const f = input.files && input.files[0];
			if (nameEl) nameEl.textContent = f ? f.name : '';
		});
	});
}
