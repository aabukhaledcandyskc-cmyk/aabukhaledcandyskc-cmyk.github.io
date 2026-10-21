import test from 'node:test';
import assert from 'node:assert/strict';
import { iso, ltr, previousPeriod, deltaPct, presetRange, topWithOthers, insights } from '../src/report.js';

test('previous period has the same length and ends the day before', () => {
  assert.deepEqual(previousPeriod('2026-09-01', '2026-09-30', '2025-07-14'), { from: '2026-08-02', to: '2026-08-31' });
  assert.deepEqual(previousPeriod('2026-03-01', '2026-03-01', '2025-07-14'), { from: '2026-02-28', to: '2026-02-28' });
  assert.deepEqual(previousPeriod('2026-01-01', '2026-01-31', '2025-07-14'), { from: '2025-12-01', to: '2025-12-31' });
});
test('no comparison when the previous period starts before the data', () => {
  assert.equal(previousPeriod('2025-07-14', '2026-10-17', '2025-07-14'), null);
  assert.equal(previousPeriod('2025-08-01', '2025-08-31', '2025-07-14'), null);
  assert.equal(previousPeriod('2026-02-01', '2026-01-01', '2025-07-14'), null);
});
test('delta percent', () => {
  assert.equal(deltaPct(150, 100), 50);
  assert.equal(deltaPct(50, 100), -50);
  assert.equal(deltaPct(10, 0), null);
  assert.equal(deltaPct(10, null), null);
  assert.equal(deltaPct(-50, -100), 50); // base is taken as absolute
});
test('presets are anchored on the newest data date and clipped to the data start', () => {
  const s = '2025-07-14', e = '2026-10-17';
  assert.deepEqual(presetRange('all', s, e), { from: s, to: e });
  assert.deepEqual(presetRange('month', s, e), { from: '2026-10-01', to: e });
  assert.deepEqual(presetRange('prevMonth', s, e), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(presetRange('last3', s, e), { from: '2026-08-01', to: e });
  assert.deepEqual(presetRange('last12', s, e), { from: '2025-11-01', to: e });
  assert.deepEqual(presetRange('ytd', s, e), { from: '2026-01-01', to: e });
  assert.deepEqual(presetRange('last12', '2026-03-05', e), { from: '2026-03-05', to: e }); // clipped
  assert.deepEqual(presetRange('prevMonth', s, '2026-01-20'), { from: '2025-12-01', to: '2025-12-31' }); // year boundary
  assert.equal(presetRange('bogus', s, e), null);
  assert.equal(presetRange('all', null, e), null);
});
test('top N folds the rest into one row without losing totals', () => {
  const reps = Array.from({ length: 12 }, (_, i) => ({ rep: `م${i}`, sales: 1200 - i * 100, paid: 10, receipts: 5, unpaid: 1, invoices: 2 }));
  const t = topWithOthers(reps, 8);
  assert.equal(t.length, 9);
  assert.equal(t.at(-1).rep, 'أخرى (4)');
  assert.equal(t.reduce((a, r) => a + r.sales, 0), reps.reduce((a, r) => a + r.sales, 0));
  assert.equal(topWithOthers(reps.slice(0, 3), 8).length, 3);
});
const fmt = { money: (c) => `${c / 100} ر.س`, pct: (p) => `${p.toFixed(1)}%`, month: (m) => m };
test('insights are derived from the numbers only', () => {
  const reps = [
    { rep: 'أ', sales: 60000, paidPct: 90 }, { rep: 'ب', sales: 30000, paidPct: 40 }, { rep: 'ج', sales: 500, paidPct: 10 },
  ];
  const r = insights({ reps, totals: { sales: 90500 }, prevTotals: { sales: 100000 }, monthly: [{ month: '2026-08', sales: 10 }, { month: '2026-09', sales: 30 }], debtors: [{ customer: 'ع', net: 7000 }], overpaid: 3 }, fmt);
  const text = r.map((x) => x.text).join('\n').replace(/[\u2066\u2068\u2069]/g, '');
  assert.match(text, /أ الأعلى مبيعاً/);
  assert.match(text, /أعلى نسبة تحصيل: أ/);
  assert.match(text, /أدنى نسبة تحصيل: ب/);              // ج is below the 3% materiality bar so it is not named
  assert.doesNotMatch(text, /أدنى نسبة تحصيل: ج/);
  assert.match(text, /انخفضت 9\.5%/);
  assert.match(text, /شهر الذروة: 2026-09/);
  assert.match(text, /أكبر رصيد مدين: ع/);
  assert.equal(r.length, 6); // capped so the page stays readable; the overpaid note is the lowest priority
  assert.equal(r.find((x) => /أدنى نسبة/.test(x.text)).kind, 'bad');
});
test('overpaid note appears when there is room for it', () => {
  const r = insights({ reps: [], totals: { sales: 0 }, prevTotals: null, monthly: [], debtors: [], overpaid: 3 }, fmt);
  assert.match(r[0].text.replace(/[\u2066\u2068\u2069]/g, ''), /3 فاتورة دفعتها/);
});
test('insights degrade gracefully with little data', () => {
  assert.deepEqual(insights({ reps: [], totals: { sales: 0 }, prevTotals: null, monthly: [], debtors: [], overpaid: 0 }, fmt), []);
  const one = insights({ reps: [{ rep: 'أ', sales: 100, paidPct: 50 }], totals: { sales: 100 }, prevTotals: null, monthly: [{ month: '2026-01', sales: 1 }], debtors: [], overpaid: 0 }, fmt);
  assert.equal(one.length, 1);
});
test('isolates wrap dynamic parts so an English name cannot reorder an Arabic sentence', () => {
  const r = insights({ reps: [{ rep: 'Ali', sales: 100, paidPct: 50 }], totals: { sales: 100 }, prevTotals: null, monthly: [], debtors: [], overpaid: 0 }, { money: (c) => `${c}`, pct: (p) => `${p}%`, month: (m) => m });
  assert.ok(r[0].text.startsWith(iso('Ali')));
  assert.equal(iso('x'), '\u2068x\u2069');
});
test('numbers use left-to-right isolates so % and thousands separators stay put', () => {
  const r = insights({ reps: [{ rep: 'أ', sales: 100, paidPct: 50 }], totals: { sales: 100 }, prevTotals: null, monthly: [], debtors: [], overpaid: 0 }, { money: (c) => `${c}`, pct: (p) => `${p}%`, month: (m) => m });
  assert.match(r[0].text, /\u2066100%\u2069/);
  assert.equal(ltr('1%'), '\u20661%\u2069');
});
