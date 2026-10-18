import { UNKNOWN_REP } from './shared.js';

const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

export function filterByPeriod(rows, { from, to } = {}) {
  return rows.filter((r) => inRange(r.date, from, to));
}

// All amounts are integer halalas. Callers pass already-filtered rows.
export function computeKpis(sales, payments) {
  const real = sales.filter((s) => s.total > 0);
  const total = sum(sales, (s) => s.total);
  const paid = sum(sales, (s) => s.paid);
  return {
    sales: total,
    paid,
    paidPct: total > 0 ? (paid / total) * 100 : 0,
    receipts: sum(payments, (p) => p.amount),
    unpaid: sum(sales, (s) => s.unpaid),
    returns: sum(sales, (s) => s.returns),
    invoiceCount: real.length,
    activeCustomers: new Set(real.map((s) => s.customer)).size,
    avgInvoice: real.length ? Math.round(sum(real, (s) => s.total) / real.length) : 0,
    discrepancies: sales.filter((s) => s.flags?.includes('discrepancy')).length,
    overpaid: sales.filter((s) => s.flags?.includes('overpaid')).length,
  };
}

export function repSummary(sales, payments) {
  const by = new Map();
  const row = (rep) => { if (!by.has(rep)) by.set(rep, { rep, sales: 0, paid: 0, receipts: 0, unpaid: 0, returns: 0, invoices: 0 }); return by.get(rep); };
  for (const s of sales) { const r = row(s.rep); r.sales += s.total; r.paid += s.paid; r.unpaid += s.unpaid; r.returns += s.returns; if (s.total > 0) r.invoices++; }
  for (const p of payments) row(p.rep).receipts += p.amount;
  return [...by.values()]
    .filter((r) => !(r.rep === UNKNOWN_REP && r.sales === 0))
    .map((r) => ({ ...r, paidPct: r.sales > 0 ? (r.paid / r.sales) * 100 : 0 }))
    .sort((a, b) => b.sales - a.sales);
}

export const WEEK_START = 0; // 0 = Sunday, 6 = Saturday

export function weekStart(iso, start = WEEK_START) {
  const d = new Date(iso + 'T00:00:00Z');
  const back = (d.getUTCDay() - start + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function weeklyTrend(sales, payments, start = WEEK_START) {
  const by = new Map();
  const row = (w) => { if (!by.has(w)) by.set(w, { week: w, sales: 0, receipts: 0 }); return by.get(w); };
  for (const s of sales) row(weekStart(s.date, start)).sales += s.total;
  for (const p of payments) row(weekStart(p.date, start)).receipts += p.amount;
  return [...by.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

// Empty set = no restriction (all reps).
export function filterByReps(rows, reps) {
  return reps && reps.size ? rows.filter((r) => reps.has(r.rep)) : rows;
}
