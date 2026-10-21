// Bundles the app (same code as index.html) into ONE self-contained html file.
//   node scripts/build-demo.mjs <out.html>                 -> empty app, import your own files
//   node scripts/build-demo.mjs <out.html> <seed.json>     -> app preloaded with your data (see make-demo-data.mjs)
import fs from 'node:fs';

const [outFile, dataFile] = process.argv.slice(2);
if (!outFile) { console.error('usage: node scripts/build-demo.mjs <out.html> [seed.json]'); process.exit(2); }
const root = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(root + p, 'utf8');
const data = dataFile ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : null;

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const strip = (src) => src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\n/gm, '')
  .replace(/^export\s+(async\s+)?(function|const|class)/gm, '$1$2');
const modules = ['csv', 'shared', 'daftra', 'ledger', 'store', 'kpi', 'verify', 'excel', 'report', 'config', 'app']
  .map((f) => strip(read(`src/${f}.js`))).join('\n').replace("const NEXUS_BUILD = 'dev'", `const NEXUS_BUILD = '${stamp}'`);
const inline = (file) => `<script>${read(file).replaceAll('</script', '<\\/script')}</script>`;

let html = read('index.html');
// Function replacers insert the text literally; a string replacement would interpret `$'` / `$&` inside the libraries.
html = html.replace('<script src="vendor/chart.umd.js"></script>', () => inline('vendor/chart.umd.js'));
html = html.replace('<script src="vendor/xlsx.full.min.js"></script>', () => inline('vendor/xlsx.full.min.js'));
const seed = data
  ? `<script type="application/json" id="nexus-seed">${JSON.stringify({ reps: data.reps, customers: data.customers, statuses: data.statuses, sales: data.sales, payments: data.payments, meta: data.meta }).replaceAll('<', '\\u003c')}</script>\n`
  : '';
html = html.replace('<script type="module" src="src/app.js"></script>', () => `${seed}<script>(() => {\n${modules}\n})();</script>`);
fs.writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} KB)${data ? ' with data' : ' empty'}`);
