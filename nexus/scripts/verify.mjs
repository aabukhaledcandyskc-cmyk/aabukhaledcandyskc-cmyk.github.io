// One command that re-checks real Daftra exports against their own totals and the ledger.
//   node scripts/verify.mjs <samples-dir>      (exit code 1 if any check fails)
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../src/csv.js';
import { parseInvoices, parsePayments } from '../src/daftra.js';
import { parseLedger } from '../src/ledger.js';
import { buildChecks, compactLedger } from '../src/verify.js';
import { fromCents } from '../src/shared.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/verify.mjs <samples-dir>'); process.exit(2); }
const find = (re) => { const f = fs.readdirSync(dir).find((x) => re.test(x)); return f ? path.join(dir, f) : null; };
const read = (re) => { const f = find(re); return f ? parseCsv(fs.readFileSync(f, 'utf8')) : null; };
const today = new Date().toISOString().slice(0, 10);

const inv = parseInvoices(read(/revenue_by_invoice/), { today });
const pay = parsePayments(read(/payments-payment/), { today });
const ledRows = read(/48ce8132|ledger|الاستاذ/i);
const led = ledRows ? compactLedger(parseLedger(ledRows)) : null;
const { checks, repRows } = buildChecks({ sales: inv.sales, payments: pay.payments, controls: { invoices: inv.controlTotals, payments: pay.controlTotals }, ledger: led });

const fmt = (c, v) => (c.count ? String(v) : fromCents(v));
let failed = 0;
for (const c of checks) {
  const mark = c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'NOTE';
  if (c.ok === false) failed++;
  console.log(`${mark}  [${c.group}] ${c.label}\n      ملف=${fmt(c, c.file)}  نظام=${fmt(c, c.system)}  فرق=${fmt(c, c.diff)}${c.note ? `  (${c.note})` : ''}`);
}
const bad = repRows.filter((r) => !r.ok);
failed += bad.length;
console.log(`${bad.length ? 'FAIL' : 'PASS'}  مجاميع المناديب: ${repRows.length - bad.length} من ${repRows.length} متطابقة`);
console.log(`\nصفوف الفواتير ${inv.sales.length} (مرفوض ${inv.rejected.length}) | سندات ${pay.payments.length} | ${failed ? `${failed} فحص فاشل` : 'كل الفحوص ناجحة'}`);
process.exit(failed ? 1 : 0);
