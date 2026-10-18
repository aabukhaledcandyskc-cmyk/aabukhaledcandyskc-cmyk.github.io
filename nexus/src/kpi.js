import { UNKNOWN_REP, daysBetween } from './shared.js';

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

// ---- region / position filters (rep -> meta lookup) ----
export function allowedReps(allReps, meta, { reps, regions, positions }) {
  return new Set(allReps.filter((r) =>
    (!reps?.size || reps.has(r)) &&
    (!regions?.size || regions.has(meta.get(r)?.region || '')) &&
    (!positions?.size || positions.has(meta.get(r)?.position || ''))));
}
export const restrictToReps = (rows, allowed) => (allowed ? rows.filter((r) => allowed.has(r.rep)) : rows);

// ---- monthly targets ----
export function monthsInRange(from, to) {
  if (!from || !to || from > to) return [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ye, me] = to.slice(0, 7).split('-').map(Number);
  const out = [];
  while (y < ye || (y === ye && m <= me)) { out.push({ month: m, year: y }); if (++m > 12) { m = 1; y++; } }
  return out;
}
export const targetKey = (rep, month, year) => `${rep}|${month}|${year}`;

// targets: [{rep, month, year, salesTarget, collectionTarget}] (halalas). Returns Map rep -> sums over the months.
export function targetsByRep(targets, allowed, months) {
  const inMonths = new Set(months.map((x) => `${x.year}-${x.month}`));
  const out = new Map();
  for (const t of targets) {
    if (!inMonths.has(`${t.year}-${t.month}`) || (allowed && !allowed.has(t.rep))) continue;
    const a = out.get(t.rep) ?? { sales: 0, collection: 0 };
    a.sales += t.salesTarget; a.collection += t.collectionTarget; out.set(t.rep, a);
  }
  return out;
}
export const progressPct = (actual, target) => (target > 0 ? (actual / target) * 100 : null);

// ---- customer aging: net unpaid + open balances bucketed by invoice age at asOf ----
export function agingByCustomer(sales, asOf) {
  const by = new Map();
  for (const s of sales) {
    const c = by.get(s.customer) ?? { customer: s.customer, net: 0, b0: 0, b30: 0, b60: 0, b90: 0, open: 0, last: '' };
    c.net += s.unpaid;
    if (s.unpaid > 0) {
      const age = daysBetween(asOf, s.date);
      if (age <= 30) c.b0 += s.unpaid; else if (age <= 60) c.b30 += s.unpaid; else if (age <= 90) c.b60 += s.unpaid; else c.b90 += s.unpaid;
      c.open++;
    }
    if (s.date > c.last) c.last = s.date;
    by.set(s.customer, c);
  }
  return [...by.values()].filter((c) => c.net > 0).sort((a, b) => b.net - a.net);
}
