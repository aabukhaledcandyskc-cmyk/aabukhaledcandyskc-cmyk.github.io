// Cross-checks the imported data against independent sources: the control totals printed inside
// Daftra's own reports and the customer general ledger. One implementation for the app, the CLI and the tests.
import { reconcile } from './ledger.js';
import { fromCents } from './shared.js';

const sumOf = (xs, k) => xs.reduce((a, x) => a + x[k], 0);

// controls: { invoices: {grand, groups}, payments: {grand, groups} } as produced by the parsers.
// ledger: result of parseLedger/compactLedger, or null.
export function buildChecks({ sales, payments, controls = {}, ledger = null }) {
  const checks = [];
  const add = (group, label, file, system, tol = 0, note = '', count = false) =>
    checks.push({ group, label, file, system, diff: system - file, ok: Math.abs(system - file) <= tol, note, count });

  const ci = controls.invoices;
  if (ci?.grand) {
    const g = ci.grand;
    add('الفواتير', 'إجمالي المبيعات مقابل صف "الإجمالي الكلي" في الملف', g.total, sumOf(sales, 'total'));
    add('الفواتير', 'المدفوع مقابل صف الإجمالي الكلي', g.paid, sumOf(sales, 'paid'));
    add('الفواتير', 'غير المدفوع مقابل صف الإجمالي الكلي', g.unpaid, sumOf(sales, 'unpaid'));
    const lastCum = ci.groups.at(-1)?.returns;
    if (lastCum !== undefined) add('الفواتير', 'المرتجعات: مجموع العمود الخام مقابل آخر مجموع تراكمي', lastCum, sumOf(sales, 'returns'));
    if (g.returns !== sumOf(sales, 'returns')) {
      checks.push({ group: 'الفواتير', label: 'المرتجعات في صف الإجمالي الكلي (يجمع المجاميع التراكمية مرتين)', file: g.returns, system: sumOf(sales, 'returns'), diff: sumOf(sales, 'returns') - g.returns, ok: null, note: 'اختلاف متوقع: خلل في تقرير دفترة، ولا يؤثر على النظام' });
    }
  }
  let repRows = [];
  if (ci?.groups?.length) {
    const by = new Map();
    for (const s of sales) { const a = by.get(s.rep) ?? { total: 0, paid: 0, unpaid: 0 }; a.total += s.total; a.paid += s.paid; a.unpaid += s.unpaid; by.set(s.rep, a); }
    repRows = ci.groups.map((gr) => {
      const a = by.get(gr.rep) ?? { total: 0, paid: 0, unpaid: 0 };
      return { rep: gr.rep, file: [gr.total, gr.paid, gr.unpaid], system: [a.total, a.paid, a.unpaid], ok: a.total === gr.total && a.paid === gr.paid && a.unpaid === gr.unpaid };
    });
  }
  const cp = controls.payments;
  if (cp?.grand) add('المدفوعات', 'إجمالي المقبوضات مقابل صف الإجمالي الكلي', cp.grand.amount, sumOf(payments, 'amount'));

  let rec = null;
  if (ledger) {
    rec = reconcile(sales, payments, ledger);
    add('الأستاذ العام', 'فواتير الأستاذ الموجودة في ملف الفواتير', rec.invoices.inLedger, rec.invoices.matched, 0, '', true);
    add('الأستاذ العام', 'فروق مبالغ الفواتير بين الأستاذ والملف', 0, rec.invoices.amountMismatches.length, 0, '', true);
    add('الأستاذ العام', 'فواتير في الأستاذ وغير موجودة في ملف الفواتير', 0, rec.invoices.notInFile.length, 0, rec.invoices.notInFile.length ? 'قد يعني أن ملف الفواتير لا يغطي كل الفترة' : '', true);
    add('الأستاذ العام', 'الإشعارات الدائنة: الملف مقابل الأستاذ', rec.creditNotes.file, rec.creditNotes.ledger, 2);
    add('الأستاذ العام', 'الإشعارات المدينة: الملف مقابل الأستاذ', rec.debitNotes.file, rec.debitNotes.ledger, 2);
    add('الأستاذ العام', 'المقبوضات: الأستاذ + مبيعات نقدية خارج الأستاذ مقابل ملف السندات', rec.payments.file, rec.payments.ledgerNet + rec.payments.cashSalesPaid, 500,
      `${rec.invoices.notInLedger.count} فاتورة غير مرحَّلة إلى حساب العميل، ${rec.invoices.notInLedger.unpaid === 0 ? 'مدفوعة بالكامل' : 'بينها غير مدفوعة'}`);
    add('الأستاذ العام', 'رصيد الأستاذ مقابل (المبيعات − المقبوضات + القيود اليدوية)', rec.balance.expected, rec.balance.ledger, 5, `القيود اليدوية: ${fromCents(rec.balance.manualNet)}`);
  }
  return {
    checks, repRows, rec,
    stats: ledger ? { ledgerCustomers: ledger.customers, ledgerEntries: ledger.entries.length, manualEntries: ledger.entries.filter((e) => e.type === 'manual').length } : null,
  };
}

// Shrinks a parsed ledger to what reconcile() needs, so it can be stored in the browser.
export function compactLedger(l) {
  return {
    customers: l.customers, totals: l.totals,
    entries: l.entries.map((e) => ({ type: e.type, ref: e.ref, debit: e.debit, credit: e.credit })),
  };
}

// Compare against numbers typed from Daftra's own screens.
export function compareWithDaftra(kpis, official) {
  const rows = [['إجمالي المبيعات', 'sales'], ['المدفوع', 'paid'], ['غير المدفوع', 'unpaid'], ['المرتجعات', 'returns'], ['إجمالي المقبوضات', 'receipts']];
  return rows.filter(([, k]) => official[k] !== null && official[k] !== undefined).map(([label, k]) => ({
    label, official: official[k], system: kpis[k], diff: kpis[k] - official[k], ok: Math.abs(kpis[k] - official[k]) <= 2,
  }));
}
