// Parses real Daftra exports and writes a compact JSON seed for the single-file build:
// real customer names (use --anon to replace them) + a verification report. Usage:
//   node scripts/make-demo-data.mjs <samples-dir> <out.json>
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../src/csv.js';
import { parseInvoices, parsePayments } from '../src/daftra.js';
import { parseLedger, reconcile } from '../src/ledger.js';
import { fromCents } from '../src/shared.js';

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

const checks = [];
const add = (group, label, file, system, tol = 0, note = '') =>
  checks.push({ group, label, file, system, diff: system - file, ok: Math.abs(system - file) <= tol, note });

const g = inv.controlTotals.grand;
add('الفواتير', 'إجمالي المبيعات مقابل صف "الإجمالي الكلي" في الملف', g.total, sum(inv.sales, 'total'));
add('الفواتير', 'المدفوع مقابل صف الإجمالي الكلي', g.paid, sum(inv.sales, 'paid'));
add('الفواتير', 'غير المدفوع مقابل صف الإجمالي الكلي', g.unpaid, sum(inv.sales, 'unpaid'));
const lastCum = inv.controlTotals.groups.at(-1).returns;
add('الفواتير', 'المرتجعات: مجموع العمود الخام مقابل آخر مجموع تراكمي', lastCum, sum(inv.sales, 'returns'));
checks.push({ group: 'الفواتير', label: 'المرتجعات في صف الإجمالي الكلي (يجمع المجاميع التراكمية مرتين)', file: g.returns, system: sum(inv.sales, 'returns'), diff: sum(inv.sales, 'returns') - g.returns, ok: null, note: 'اختلاف متوقع: خلل في تقرير دفترة، ولا يؤثر على النظام' });
const byRep = new Map();
for (const s of inv.sales) { const a = byRep.get(s.rep) ?? { total: 0, paid: 0, unpaid: 0 }; a.total += s.total; a.paid += s.paid; a.unpaid += s.unpaid; byRep.set(s.rep, a); }
const repRows = inv.controlTotals.groups.map((gr) => {
  const a = byRep.get(gr.rep) ?? { total: 0, paid: 0, unpaid: 0 };
  return { rep: gr.rep, file: [gr.total, gr.paid, gr.unpaid], system: [a.total, a.paid, a.unpaid], ok: a.total === gr.total && a.paid === gr.paid && a.unpaid === gr.unpaid };
});
add('المدفوعات', 'إجمالي المقبوضات مقابل صف الإجمالي الكلي', pay.controlTotals.grand.amount, sum(pay.payments, 'amount'));
add('الأستاذ العام', 'فواتير الأستاذ الموجودة في ملف الفواتير', rec.invoices.inLedger, rec.invoices.matched);
add('الأستاذ العام', 'فروق مبالغ الفواتير بين الأستاذ والملف', 0, rec.invoices.amountMismatches.length);
add('الأستاذ العام', 'الإشعارات الدائنة: الملف مقابل الأستاذ', rec.creditNotes.file, rec.creditNotes.ledger, 2);
add('الأستاذ العام', 'الإشعارات المدينة: الملف مقابل الأستاذ', rec.debitNotes.file, rec.debitNotes.ledger, 2);
add('الأستاذ العام', 'المقبوضات: الأستاذ + مبيعات نقدية خارج الأستاذ مقابل ملف السندات', rec.payments.file, rec.payments.ledgerNet + rec.payments.cashSalesPaid, 500, `${rec.invoices.notInLedger.count} فاتورة مدفوعة بالكامل لا تُرحَّل إلى حساب العميل`);
add('الأستاذ العام', 'رصيد الأستاذ مقابل (المبيعات − المقبوضات + القيود اليدوية)', rec.balance.expected, rec.balance.ledger, 5, `القيود اليدوية: ${fromCents(rec.balance.manualNet)}`);
add('الاستيراد', 'صفوف الفواتير المرفوضة', 0, inv.rejected.length);
add('الاستيراد', 'مفاتيح فواتير مكررة', 0, inv.duplicateKeys.length);
add('الاستيراد', 'مفاتيح سندات مكررة', 0, pay.duplicateKeys.length);

const salesRows = inv.sales.map((s) => [s.key, s.number, s.date, reps.indexOf(s.rep), cid(s.customer), s.total, s.paid, s.unpaid, s.returns, s.flags.reduce((a, f) => a + (FLAG[f] ?? 0), 0)]);
const payRows = pay.payments.map((p) => [p.key, p.number, p.invoice, p.date, reps.indexOf(p.rep), cid(p.customer), p.method, p.amount]);
const customers = [...custIds.keys()].map((n, i) => (anon ? `عميل ${i + 1}` : n));
fs.writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  reps,
  customers,
  sales: salesRows,
  payments: payRows,
  verification: { checks, repRows, stats: {
    invoiceRows: inv.sales.length, payments: pay.payments.length, zeroPayments: pay.zeroAmount,
    ledgerCustomers: led.customers, ledgerEntries: led.entries.length, manualEntries: led.entries.filter((e) => e.type === 'manual').length,
    overpaid: inv.sales.filter((s) => s.flags.includes('overpaid')).length,
  } },
}));
console.log(`wrote ${out}: ${inv.sales.length} sales, ${pay.payments.length} payments, ${checks.filter((c) => c.ok === false).length} failing checks`);
