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
import { PathExtractor, analyzeGraphs, generateDOT, generatePlain, generateMermaid } from './src/extractor.js';

const PAGE_NUM = parseInt(process.argv[2] || '2', 10);
const PDF_PATH = join(__dirname, 'test_pdf', 'w4a - vragen2.pdf');

const data = readFileSync(PDF_PATH);
const pdf  = await pdfjsLib.getDocument({ data: new Uint8Array(data.buffer) }).promise;

console.error(`PDF loaded: ${pdf.numPages} pages. Analyzing page ${PAGE_NUM}...`);

const page        = await pdf.getPage(PAGE_NUM);
const opList      = await page.getOperatorList();
const extractor   = new PathExtractor(pdfjsLib.OPS);
const paths       = extractor.extract(opList.fnArray, opList.argsArray);
const textContent = await page.getTextContent();
const results     = analyzeGraphs(paths, textContent.items);

console.error(`\nFound ${results.length} graph(s) on page ${PAGE_NUM}\n`);

results.forEach((result, gi) => {
  console.error(`=== Graph ${gi + 1} ===`);
  console.error(`Stats: ${JSON.stringify(result.stats)}`);
  console.error(`medR: ${result.medR.toFixed(2)}, confidence: ${result.confidence}%`);
  console.error('Nodes:');
  for (const nd of result.nodes) {
    console.error(`  [${nd.id}] label="${nd.label}" pos=(${nd.x.toFixed(1)},${nd.y.toFixed(1)}) r=${nd.r.toFixed(1)}${nd.accepting ? ' [accepting]' : ''}`);
  }
  console.error('Edges:');
  for (const e of result.edges) {
    const from = e.isInitial ? '→' : (e.from >= 0 ? result.nodes[e.from]?.label || '?' : '?');
    const to   = e.to >= 0 ? result.nodes[e.to]?.label || '?' : '?';
    console.error(`  ${from} --[${e.label || 'ε'}]--> ${to}${e.isSelf ? ' (self)' : ''}${e.isInitial ? ' (initial)' : ''}`);
  }
  console.error('');
});

// DOT output for all graphs to stdout (separated by comments)
results.forEach((result, gi) => {
  console.log(`// === Graph ${gi + 1} — DOT ===`);
  console.log(generateDOT(result));
  console.log('');
});

// Mermaid output for all graphs to stdout
results.forEach((result, gi) => {
  console.log(`// === Graph ${gi + 1} — Mermaid ===`);
  console.log(generateMermaid(result));
  console.log('');
});
