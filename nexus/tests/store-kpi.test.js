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

import { allowedReps, restrictToReps, monthsInRange, targetsByRep, progressPct, agingByCustomer } from '../src/kpi.js';
test('region/position filters combine with rep filter (all must match)', () => {
  const meta = new Map([['أ', { region: 'جدة', position: 'مندوب' }], ['ب', { region: 'مكة', position: 'مندوب' }], ['ج', { region: 'جدة', position: 'مشرف' }]]);
  const all = ['أ', 'ب', 'ج', 'د'];
  assert.deepEqual([...allowedReps(all, meta, {})].sort(), ['أ', 'ب', 'ج', 'د']);
  assert.deepEqual([...allowedReps(all, meta, { regions: new Set(['جدة']) })].sort(), ['أ', 'ج']);
  assert.deepEqual([...allowedReps(all, meta, { regions: new Set(['جدة']), positions: new Set(['مشرف']) })], ['ج']);
  assert.deepEqual([...allowedReps(all, meta, { regions: new Set(['جدة']), reps: new Set(['ب']) })], []);
  assert.deepEqual([...allowedReps(all, meta, { regions: new Set(['']) })], ['د']); // reps with no region
  assert.equal(restrictToReps(sales, new Set(['ب'])).length, 2);
});
test('months in range, across year boundary', () => {
  assert.deepEqual(monthsInRange('2025-11-20', '2026-01-02').map((m) => `${m.year}-${m.month}`), ['2025-11', '2025-12', '2026-1']);
  assert.deepEqual(monthsInRange('2026-05-01', '2026-05-31'), [{ month: 5, year: 2026 }]);
  assert.deepEqual(monthsInRange('2026-05-02', '2026-04-01'), []);
});
test('targets roll up to the filtered reps and months; progress may exceed 100', () => {
  const t = [
    { rep: 'أ', month: 1, year: 2026, salesTarget: 10000, collectionTarget: 8000 },
    { rep: 'أ', month: 2, year: 2026, salesTarget: 20000, collectionTarget: 15000 },
    { rep: 'ب', month: 1, year: 2026, salesTarget: 5000, collectionTarget: 5000 },
    { rep: 'أ', month: 3, year: 2026, salesTarget: 99999, collectionTarget: 99999 },
  ];
  const m = targetsByRep(t, new Set(['أ']), monthsInRange('2026-01-15', '2026-02-10'));
  assert.deepEqual([...m], [['أ', { sales: 30000, collection: 23000 }]]);
  const all = targetsByRep(t, null, monthsInRange('2026-01-01', '2026-01-31'));
  assert.equal([...all.values()].reduce((a, x) => a + x.sales, 0), 15000);
  assert.equal(progressPct(20250, 15000), 135);
  assert.equal(progressPct(5, 0), null);
});
test('aging buckets only positive open balances; customers with credit balance excluded', () => {
  const S = (customer, date, unpaid) => ({ customer, date, unpaid });
  const r = agingByCustomer([
    S('ع1', '2026-10-10', 1000), S('ع1', '2026-09-01', 500), S('ع1', '2026-08-10', 200), S('ع1', '2026-01-01', 100),
    S('ع2', '2026-10-01', 300), S('ع2', '2026-10-02', -500), S('ع3', '2026-10-17', 50)], '2026-10-18');
  assert.deepEqual(r.map((c) => c.customer), ['ع1', 'ع3']);
  assert.deepEqual([r[0].net, r[0].b0, r[0].b30, r[0].b60, r[0].b90, r[0].open], [1800, 1000, 500, 200, 100, 4]);
});

import { totalsRow, sortRows, monthlyBreakdown, withRates } from '../src/kpi.js';
test('return rate = returns / gross invoiced sales (credit notes excluded from the base)', () => {
  const r = repSummary(sales, pays).find((x) => x.rep === 'أ');
  assert.equal(r.gross, 15000);
  assert.equal(r.returnRate, (1000 / 15000) * 100);
  const none = withRates({ rep: 'x', sales: 0, gross: 0, paid: 0, receipts: 0, unpaid: 0, returns: 0, invoices: 0 });
  assert.equal(none.returnRate, null);
});
test('totals row equals the KPI cards for the same data', () => {
  const reps = repSummary(sales, pays);
  const t = totalsRow(reps);
  const k = computeKpis(sales, pays);
  assert.deepEqual([t.sales, t.paid, t.unpaid, t.returns, t.receipts, t.invoices], [k.sales, k.paid, k.unpaid, k.returns, k.receipts, k.invoiceCount]);
});
test('sorting: numeric both directions, Arabic text, nulls last', () => {
  const rows = [{ rep: 'ب', v: 2 }, { rep: 'أ', v: 10 }, { rep: 'ج', v: null }, { rep: 'د', v: 5 }];
  assert.deepEqual(sortRows(rows, 'v', 'desc').map((r) => r.rep), ['أ', 'د', 'ب', 'ج']);
  assert.deepEqual(sortRows(rows, 'v', 'asc').map((r) => r.rep), ['ب', 'د', 'أ', 'ج']);
  assert.deepEqual(sortRows(rows, 'rep', 'asc').map((r) => r.rep), ['أ', 'ب', 'ج', 'د']);
});
test('monthly breakdown groups by YYYY-MM and sorts ascending', () => {
  const m = monthlyBreakdown(sales, pays);
  assert.deepEqual(m.map((x) => x.month), ['2026-01', '2026-02']);
  assert.deepEqual([m[0].sales, m[0].receipts, m[0].invoices], [15000, 7000, 2]);
  assert.deepEqual([m[1].sales, m[1].receipts, m[1].invoices], [1000, -500, 1]);
});

import { firstInvoices, newCustomersByRep, newCustomersUnreliable } from '../src/kpi.js';
test('new customers: first real invoice decides, credited to the rep who issued it', () => {
  const S = (customer, date, rep, total = 100, number = date) => ({ customer, date, rep, total, number });
  const all = [
    S('ع1', '2026-01-05', 'أ'), S('ع1', '2026-02-10', 'ب'),            // ع1 first seen in Jan with أ, later buys from ب
    S('ع2', '2026-02-03', 'ب'), S('ع2', '2026-02-03', 'أ', 50, 'z'),   // same day: lowest number wins ('2026-02-03' < 'z')
    S('ع3', '2026-01-20', 'أ', -80),                                    // credit note does not make a customer
    S('ع3', '2026-03-01', 'ب'),
    S('', '2026-02-01', 'أ'),                                           // nameless rows ignored
  ];
  const first = firstInvoices(all);
  assert.deepEqual([...first.keys()].sort(), ['ع1', 'ع2', 'ع3']);
  assert.equal(first.get('ع3').date, '2026-03-01');
  assert.deepEqual([...newCustomersByRep(first, { from: '2026-02-01', to: '2026-02-28' }, null)], [['ب', 1]]);
  assert.deepEqual([...newCustomersByRep(first, { from: '2026-01-01', to: '2026-03-31' }, new Set(['أ']))], [['أ', 1]]);
  assert.deepEqual([...newCustomersByRep(first, {}, null)].sort(), [['أ', 1], ['ب', 2]]);
});
test('new-customer figure is flagged unreliable near the start of the data', () => {
  const all = [{ date: '2025-07-14' }, { date: '2026-01-01' }];
  assert.equal(newCustomersUnreliable(all, '2025-07-14'), true);
  assert.equal(newCustomersUnreliable(all, '2025-09-01'), true);   // 49 days in
  assert.equal(newCustomersUnreliable(all, '2025-11-01'), false);  // 110 days in
  assert.equal(newCustomersUnreliable([], '2025-11-01'), false);
});

import { topCustomers } from '../src/kpi.js';
test('top customers by net sales; credit-note-only customers and nameless rows excluded', () => {
  const S = (customer, total) => ({ customer, total });
  const r = topCustomers([S('أ', 100), S('أ', 50), S('ب', 200), S('ب', -250), S('ج', 10), S('', 999)], 2);
  assert.deepEqual(r.map((x) => [x.customer, x.sales, x.invoices]), [['أ', 150, 2], ['ج', 10, 1]]);
});
