import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildChecks, compareWithDaftra, compactLedger } from '../src/verify.js';
import { parseLedger } from '../src/ledger.js';
import { rowsFromWorkbook, workbookFromRows } from '../src/excel.js';
import { parseInvoices } from '../src/daftra.js';
import { parseCsv } from '../src/csv.js';

// The vendored UMD file sits in an ESM package, so evaluate it with a CommonJS shim instead of require().
const XLSX = (() => {
  const mod = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(new URL('../vendor/xlsx.full.min.js', import.meta.url), 'utf8'))(mod, mod.exports);
  return mod.exports;
})();

const sale = (o) => ({ number: '1', total: 10000, paid: 4000, unpaid: 6000, returns: 0, rep: 'أ', ...o });
const controls = (g, groups = []) => ({ invoices: { grand: g, groups }, payments: { grand: { amount: 700 }, groups: [] } });

test('verification passes when data equals the control totals, fails loudly when it does not', () => {
  const sales = [sale({ number: '1' }), sale({ number: '2', total: 500, paid: 500, unpaid: 0 })];
  const ok = buildChecks({ sales, payments: [{ amount: 700 }], controls: controls({ total: 10500, paid: 4500, unpaid: 6000, returns: 0 }, [{ rep: 'أ', total: 10500, paid: 4500, unpaid: 6000, returns: 0 }]) });
  assert.ok(ok.checks.every((c) => c.ok !== false));
  assert.ok(ok.repRows.every((r) => r.ok));
  const bad = buildChecks({ sales, payments: [{ amount: 700 }], controls: controls({ total: 10501, paid: 4500, unpaid: 6000, returns: 0 }, [{ rep: 'أ', total: 10501, paid: 4500, unpaid: 6000, returns: 0 }]) });
  assert.equal(bad.checks.filter((c) => c.ok === false).length, 1);
  assert.equal(bad.repRows[0].ok, false);
});

test('ledger checks are skipped without a ledger and run with one', () => {
  const sales = [sale({ number: '000001', total: 10000 })];
  assert.equal(buildChecks({ sales, payments: [] }).checks.length, 0);
  const rows = [
    ['رقم', 'رقم القيد', '', 'التاريخ', 'موظف', 'الوصف', 'مدين', 'دائن', 'مدين', 'دائن'],
    ['عميل 1204', '', '', '', '', '', '', '', '', ''],
    ['1', '1', '1', '01/01/2026', 'x', 'فاتورة #000001', '100', '', '', ''],
  ];
  const r = buildChecks({ sales, payments: [], ledger: compactLedger(parseLedger(rows)) });
  assert.equal(r.checks.find((c) => /فروق مبالغ/.test(c.label)).ok, true);
  const wrong = buildChecks({ sales: [sale({ number: '000001', total: 12000 })], payments: [], ledger: compactLedger(parseLedger(rows)) });
  assert.equal(wrong.checks.find((c) => /فروق مبالغ/.test(c.label)).ok, false);
});

test('compare with Daftra: only entered figures are compared, 0.02 tolerance', () => {
  const k = { sales: 100000, paid: 40000, unpaid: 60000, returns: 0, receipts: 39000 };
  const r = compareWithDaftra(k, { sales: 100000, paid: 40002, unpaid: null, returns: undefined, receipts: 38000 });
  assert.deepEqual(r.map((x) => [x.label, x.ok]), [['إجمالي المبيعات', true], ['المدفوع', true], ['إجمالي المقبوضات', false]]);
});

const header = ['رقم', 'التاريخ', 'العميل', 'حالة الفاتورة الإلكترونية', 'مدفوعة (SAR)', 'غير مدفوعة (SAR)', 'مرتجع (SAR)', 'الإجمالي (SAR)'];
const body = [
  ['#8 المشرف / مندوب', '', '', '', '', '', '', ''],
  ['000010', '13/08/2026', 'عميل ب', 'لم ترسل', '50.00', '40.00', '10.00', '100.00'],
  ['000011', '05/08/2026', 'عميل ج', 'أرسلت', '100.00', '0.00', '0.00', '100.00'],
];
test('Excel import: text dates and real date cells both read as DD/MM', () => {
  const wb = workbookFromRows(XLSX, header, body);
  const a = parseInvoices(rowsFromWorkbook(XLSX, XLSX.write(wb, { type: 'array', bookType: 'xlsx' })), { today: '2026-10-18' });
  assert.equal(a.sales.length, 2);
  assert.deepEqual(a.sales.map((s) => s.date), ['2026-08-13', '2026-08-05']);
  assert.deepEqual(a.sales.map((s) => s.status), ['لم ترسل', 'أرسلت']);
  assert.equal(a.sales[0].returns, 1000);
  // same rows with genuine Excel date cells (dates >12 must not flip)
  const ws = XLSX.utils.aoa_to_sheet([header, ...body.map((r) => [...r])]);
  ws['B3'] = { t: 'd', v: new Date(Date.UTC(2026, 7, 13)), z: 'dd/mm/yyyy' };
  ws['B4'] = { t: 'd', v: new Date(Date.UTC(2026, 7, 5)), z: 'dd/mm/yyyy' };
  const wb2 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2, ws, 'S');
  const b = parseInvoices(rowsFromWorkbook(XLSX, XLSX.write(wb2, { type: 'array', bookType: 'xlsx', cellDates: true })), { today: '2026-10-18' });
  assert.deepEqual(b.sales.map((s) => s.date), ['2026-08-13', '2026-08-05']);
});
test('status column is optional', () => {
  const noStatus = parseCsv(['"رقم","التاريخ","العميل","مدفوعة","غير مدفوعة","مرتجع","الإجمالي"', '"1","01/01/2026","ع","10.00","0.00","0.00","10.00"'].join('\n'));
  assert.equal(parseInvoices(noStatus, { today: '2026-10-18' }).sales[0].status, '');
});
