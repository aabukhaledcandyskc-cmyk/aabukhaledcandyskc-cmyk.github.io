// Parses real Daftra exports and writes a compact JSON seed for the single-file build:
// real customer names (use --anon to replace them) + a verification report. Usage:
//   node scripts/make-demo-data.mjs <samples-dir> <out.json>
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../src/csv.js';
import { parseInvoices, parsePayments } from '../src/daftra.js';
import { parseLedger, reconcile } from '../src/ledger.js';
import { buildChecks, compactLedger } from '../src/verify.js';

const args = process.argv.slice(2);
const anon = args.includes('--anon');
const [dir, out] = args.filter((a) => !a.startsWith('--'));
const pick = (re) => path.join(dir, fs.readdirSync(dir).find((f) => re.test(f)));
const read = (re) => parseCsv(fs.readFileSync(pick(re), 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const inv = parseInvoices(read(/revenue_by_invoice/), { today });
const pay = parsePayments(read(/payments-payment/), { today });
const led = parseLedger(read(/48ce8132/));
const rec = reconcile(inv.sales, pay.payments, led);
const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);

const reps = [...new Set([...inv.sales, ...pay.payments].map((r) => r.rep))];
const custIds = new Map();
const cid = (name) => { if (!custIds.has(name)) custIds.set(name, custIds.size); return custIds.get(name); };
const FLAG = { overpaid: 1, discrepancy: 2, negative_total_with_payment: 4 };

const controls = { invoices: inv.controlTotals, payments: pay.controlTotals };
const ledger = compactLedger(led);
const ver = buildChecks({ sales: inv.sales, payments: pay.payments, controls, ledger });

const statuses = [...new Set(inv.sales.map((s) => s.status))];
const salesRows = inv.sales.map((s) => [s.key, s.number, s.date, reps.indexOf(s.rep), cid(s.customer), s.total, s.paid, s.unpaid, s.returns, s.flags.reduce((a, f) => a + (FLAG[f] ?? 0), 0), statuses.indexOf(s.status)]);
const payRows = pay.payments.map((p) => [p.key, p.number, p.invoice, p.date, reps.indexOf(p.rep), cid(p.customer), p.method, p.amount]);
const customers = [...custIds.keys()].map((n, i) => (anon ? `عميل ${i + 1}` : n));
fs.writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  reps,
  customers,
  sales: salesRows,
  payments: payRows,
  statuses,
  meta: { controls, ledger },
}));
console.log(`wrote ${out}: ${inv.sales.length} sales, ${pay.payments.length} payments, ${ver.checks.filter((c) => c.ok === false).length} failing checks`);
