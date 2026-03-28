/**
 * run-pdf.mjs — Node.js CLI wrapper for testing the extractor
 * Usage:  node run-pdf.mjs [pageNum]
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pdfjsLib = await import('./node_modules/pdfjs-dist/legacy/build/pdf.mjs');
const workerUrl = new URL('./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl.href;

// Import shared logic
import { PathExtractor, analyzeGraph, generateDOT, generatePlain } from './src/extractor.js';

const PAGE_NUM = parseInt(process.argv[2] || '3', 10);
const PDF_PATH = join(__dirname, 'practicum-a-4-exercises8.pdf');

const data = readFileSync(PDF_PATH);
const pdf  = await pdfjsLib.getDocument({ data: new Uint8Array(data.buffer) }).promise;

console.error(`PDF loaded: ${pdf.numPages} pages. Analyzing page ${PAGE_NUM}...`);

const page        = await pdf.getPage(PAGE_NUM);
const opList      = await page.getOperatorList();
const extractor   = new PathExtractor(pdfjsLib.OPS);
const paths       = extractor.extract(opList.fnArray, opList.argsArray);
const textContent = await page.getTextContent();
const result      = analyzeGraph(paths, textContent.items);

// Debug output to stderr
console.error(`\nStats: ${JSON.stringify(result.stats)}`);
console.error(`medR: ${result.medR.toFixed(2)}, confidence: ${result.confidence}%`);
console.error('\nNodes:');
for (const n of result.nodes) {
  console.error(`  [${n.id}] label="${n.label}" pos=(${n.x.toFixed(1)},${n.y.toFixed(1)}) r=${n.r.toFixed(1)}${n.accepting ? ' [accepting]' : ''}`);
}
console.error('\nEdges:');
for (const e of result.edges) {
  const from = e.isInitial ? '→' : (e.from >= 0 ? result.nodes[e.from].label : '?');
  const to   = e.to >= 0 ? result.nodes[e.to].label : '?';
  console.error(`  ${from} --[${e.label || 'ε'}]--> ${to}${e.isSelf ? ' (self)' : ''}${e.isInitial ? ' (initial)' : ''}`);
}
console.error('\nUnassigned text:');
for (const g of result.textGroups.filter(g => !g.assigned)) {
  console.error(`  "${g.text}" @ (${g.x.toFixed(1)},${g.y.toFixed(1)})`);
}

// DOT to stdout
console.log(generateDOT(result));
