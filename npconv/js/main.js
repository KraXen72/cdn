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
