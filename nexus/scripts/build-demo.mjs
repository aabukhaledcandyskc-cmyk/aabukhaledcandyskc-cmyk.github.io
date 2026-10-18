// Bundles the app (same code as index.html) into ONE self-contained html file.
//   node scripts/build-demo.mjs <out.html>                      -> empty app, import your own files
//   node scripts/build-demo.mjs <out.html> <seed.json>          -> app preloaded with your data + verification tab
import fs from 'node:fs';
import { fromCents } from '../src/shared.js';

const [outFile, dataFile] = process.argv.slice(2);
const root = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(root + p, 'utf8');
const data = dataFile ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : null;

const strip = (src) => src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\n/gm, '')
  .replace(/^export\s+(async\s+)?(function|const|class)/gm, '$1$2');
const modules = ['src/csv.js', 'src/shared.js', 'src/daftra.js', 'src/store.js', 'src/kpi.js', 'src/config.js'].map((f) => strip(read(f))).join('\n');
const app = strip(read('src/app.js'));


const n = (v) => (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isCount = (c) => Number.isInteger(c.file) && Math.abs(c.file) < 100000 && c.group !== 'الفواتير' && c.group !== 'المدفوعات' && !/الإشعارات|المقبوضات|رصيد/.test(c.label);
const fmt = (c, v) => (isCount(c) ? String(v) : n(v));
const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
const v = data?.verification;
const groups = v ? [...new Set(v.checks.map((c) => c.group))] : [];
const checkTables = !v ? '' : groups.map((g) => `<h3>${esc(g)}</h3><table>
<tr><th>الفحص</th><th class="n">القيمة المرجعية</th><th class="n">النظام</th><th class="n">الفرق</th><th>النتيجة</th></tr>
${v.checks.filter((c) => c.group === g).map((c) => `<tr><td>${esc(c.label)}${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}</td>
<td class="n">${fmt(c, c.file)}</td><td class="n">${fmt(c, c.system)}</td><td class="n">${fmt(c, c.diff)}</td>
<td>${c.ok === true ? '<span class="ok">✓ مطابق</span>' : c.ok === false ? '<span class="bad">✗ فرق</span>' : '<span class="warn">⚠ مفسَّر</span>'}</td></tr>`).join('')}</table>`).join('');
const repTable = !v ? '' : `<h3>صفوف "المجموع" لكل مندوب في ملف دفترة (${v.repRows.filter((r) => r.ok).length} من ${v.repRows.length} متطابقة)</h3><table>
<tr><th>المندوب</th><th class="n">الإجمالي (ملف)</th><th class="n">الإجمالي (نظام)</th><th class="n">المدفوع (ملف)</th><th class="n">المدفوع (نظام)</th><th class="n">غير المدفوع (ملف)</th><th class="n">غير المدفوع (نظام)</th><th>النتيجة</th></tr>
${v.repRows.map((r) => `<tr><td>${esc(r.rep)}</td>${[0, 1, 2].map((i) => `<td class="n">${n(r.file[i])}</td><td class="n">${n(r.system[i])}</td>`).join('')}<td>${r.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}</td></tr>`).join('')}</table>`;
const stt = v?.stats;
const verifyDialog = !v ? '' : `<dialog id="vdlg" style="width:min(1000px,96vw)"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">دليل التحقق من الأرقام</h2><button class="ghost" id="vclose">إغلاق</button></div>
<p class="muted">كل سطر أدناه حسبه النظام من ملفاتك الأصلية ثم قارنه بمصدر مستقل: صفوف المجاميع داخل ملفات دفترة نفسها، أو الأستاذ العام للعملاء. شملت المراجعة ${stt.invoiceRows.toLocaleString('en-US')} صف مبيعات و${stt.payments.toLocaleString('en-US')} سنداً و${stt.ledgerEntries.toLocaleString('en-US')} قيداً في الأستاذ (${stt.ledgerCustomers.toLocaleString('en-US')} حساب عميل، منها ${stt.manualEntries} قيد يدوي).</p>
${checkTables}${repTable}</dialog>`;

let html = read('index.html');
const seed = data ? `<script type="application/json" id="nexus-seed">${JSON.stringify({ reps: data.reps, customers: data.customers, sales: data.sales, payments: data.payments }).replaceAll('<', '\\u003c')}</script>\n` : '';
html = html.replace('<script src="vendor/chart.umd.js"></script>', `<script>${read('vendor/chart.umd.js').replaceAll('</script', '<\\/script')}</script>`);
html = html.replace('<script type="module" src="src/app.js"></script>',
  `${seed}<script>(() => {\n${modules}\n${app}\n${v ? "document.getElementById('vopen').onclick = () => document.getElementById('vdlg').showModal();\n document.getElementById('vclose').onclick = () => document.getElementById('vdlg').close();" : ''}\n})();</script>`);
if (v) {
  html = html.replace('<button class="ghost" id="clearBtn"', '<button class="ghost" id="vopen">دليل التحقق ✓</button>\n    <button class="ghost" id="clearBtn"');
  html = html.replace('</main>', `</main>\n${verifyDialog}`);
}
fs.writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} KB)${v ? ' with data' : ' empty'}`);
