import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecords } from '../src/store.js';
import { computeKpis, repSummary, filterByPeriod, weekStart, weeklyTrend, filterByReps } from '../src/kpi.js';
import { detectKind } from '../src/daftra.js';
import { parseCsv } from '../src/csv.js';

test('import twice -> no duplicates (added 0, updated N)', () => {
  const recs = [{ key: 'a', v: 1 }, { key: 'b', v: 2 }];
  const first = mergeRecords([], recs);
  assert.deepEqual([first.added, first.updated, first.records.length], [2, 0, 2]);
  const second = mergeRecords(first.records, recs);
  assert.deepEqual([second.added, second.updated, second.records.length], [0, 2, 2]);
  const changed = mergeRecords(second.records, [{ key: 'a', v: 9 }, { key: 'c', v: 3 }]);
  assert.deepEqual([changed.added, changed.updated, changed.records.length], [1, 1, 3]);
  assert.equal(changed.records.find((r) => r.key === 'a').v, 9);
});

const sales = [
  { date: '2026-01-05', rep: 'أ', customer: 'ع1', total: 10000, paid: 4000, unpaid: 5000, returns: 1000, flags: [] },
  { date: '2026-01-20', rep: 'أ', customer: 'ع1', total: 5000, paid: 5000, unpaid: 0, returns: 0, flags: [] },
  { date: '2026-02-02', rep: 'ب', customer: 'ع2', total: -2000, paid: 0, unpaid: -2000, returns: 0, flags: [] },
  { date: '2026-02-03', rep: 'ب', customer: 'ع3', total: 3000, paid: 4000, unpaid: -1000, returns: 0, flags: ['overpaid'] },
];
const pays = [{ date: '2026-01-10', rep: 'أ', amount: 7000 }, { date: '2026-02-04', rep: 'ب', amount: -500 }];

test('KPIs follow the spec formulas', () => {
  const k = computeKpis(sales, pays);
  assert.equal(k.sales, 16000);
  assert.equal(k.paid, 13000);
  assert.equal(k.unpaid, 2000);
  assert.equal(k.returns, 1000);
  assert.equal(k.receipts, 6500);
  assert.equal(k.invoiceCount, 3); // credit note excluded
  assert.equal(k.activeCustomers, 2); // credit-note customer not counted
  assert.equal(k.avgInvoice, 6000); // 18000 / 3, real invoices only
  assert.equal(k.overpaid, 1);
});
test('period filter is inclusive and applied before KPIs', () => {
  const jan = filterByPeriod(sales, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(jan.length, 2);
  assert.equal(computeKpis(jan, filterByPeriod(pays, { from: '2026-01-01', to: '2026-01-31' })).sales, 15000);
  assert.equal(filterByPeriod(sales, { from: '2026-02-03', to: '2026-02-03' }).length, 1);
});
test('rep summary sorted by sales; unknown rep without sales hidden', () => {
  const r = repSummary(sales, [...pays, { date: '2026-01-10', rep: 'غير محدد', amount: 100 }]);
  assert.deepEqual(r.map((x) => x.rep), ['أ', 'ب']);
  assert.equal(r[0].paidPct, 60);
});
test('file kind detection', () => {
  assert.equal(detectKind(parseCsv('"رقم","التاريخ","العميل","الإجمالي (SAR)"')), 'invoices');
  assert.equal(detectKind(parseCsv('"المعرف","رقم الفاتورة","التاريخ","الإجمالي (SAR)"')), 'payments');
  assert.equal(detectKind(parseCsv('a,b')), null);
});

test('weeks start on Sunday by default and Saturday when configured', () => {
  assert.equal(weekStart('2026-10-18'), '2026-10-18'); // a Sunday
  assert.equal(weekStart('2026-10-17'), '2026-10-11'); // Saturday belongs to the previous Sunday week
  assert.equal(weekStart('2026-10-17', 6), '2026-10-17');
  assert.equal(weekStart('2026-10-23'), '2026-10-18');
  assert.equal(weekStart('2026-01-01'), '2025-12-28'); // crosses a year boundary
});
test('weekly trend groups sales and receipts and sorts by week', () => {
  const t = weeklyTrend(
    [{ date: '2026-10-19', total: 100 }, { date: '2026-10-11', total: 50 }, { date: '2026-10-20', total: 25 }],
    [{ date: '2026-10-21', amount: 70 }, { date: '2026-10-05', amount: 5 }]);
  assert.deepEqual(t.map((x) => x.week), ['2026-10-04', '2026-10-11', '2026-10-18']);
  assert.deepEqual(t.map((x) => [x.sales, x.receipts]), [[0, 5], [50, 0], [125, 70]]);
});
test('rep filter: empty selection means all, otherwise only chosen reps', () => {
  assert.equal(filterByReps(sales, new Set()).length, 4);
  assert.equal(filterByReps(sales, new Set(['أ'])).length, 2);
  assert.equal(computeKpis(filterByReps(sales, new Set(['ب'])), filterByReps(pays, new Set(['ب']))).receipts, -500);
});
