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
  const row = (rep) => { if (!by.has(rep)) by.set(rep, { rep, sales: 0, gross: 0, paid: 0, receipts: 0, unpaid: 0, returns: 0, invoices: 0 }); return by.get(rep); };
  for (const s of sales) {
    const r = row(s.rep);
    r.sales += s.total; r.paid += s.paid; r.unpaid += s.unpaid; r.returns += s.returns;
    if (s.total > 0) { r.invoices++; r.gross += s.total; } // gross = real invoices only, so credit notes do not shrink the denominator
  }
  for (const p of payments) row(p.rep).receipts += p.amount;
  return [...by.values()]
    .filter((r) => !(r.rep === UNKNOWN_REP && r.sales === 0))
    .map((r) => withRates(r))
    .sort((a, b) => b.sales - a.sales);
}

// paidPct = paid / total sales; returnRate = returns / gross invoiced sales (null when nothing was invoiced).
export const withRates = (r) => ({
  ...r,
  paidPct: r.sales > 0 ? (r.paid / r.sales) * 100 : 0,
  returnRate: r.gross > 0 ? (r.returns / r.gross) * 100 : null,
});

export function totalsRow(reps) {
  const t = reps.reduce((a, r) => ({ sales: a.sales + r.sales, gross: a.gross + r.gross, paid: a.paid + r.paid, receipts: a.receipts + r.receipts, unpaid: a.unpaid + r.unpaid, returns: a.returns + r.returns, invoices: a.invoices + r.invoices }),
    { sales: 0, gross: 0, paid: 0, receipts: 0, unpaid: 0, returns: 0, invoices: 0 });
  return withRates({ rep: 'الإجمالي', ...t });
}

// Stable sort for the summary table; text sorts in Arabic collation, nulls always last.
export function sortRows(rows, key, dir = 'desc') {
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === null || x === undefined) return (y === null || y === undefined) ? 0 : 1;
    if (y === null || y === undefined) return -1;
    return (typeof x === 'string' ? x.localeCompare(y, 'ar') : x - y) * mul;
  });
}

export function monthlyBreakdown(sales, payments) {
  const by = new Map();
  const row = (m) => { if (!by.has(m)) by.set(m, { month: m, sales: 0, paid: 0, receipts: 0, unpaid: 0, invoices: 0 }); return by.get(m); };
  for (const s of sales) { const r = row(s.date.slice(0, 7)); r.sales += s.total; r.paid += s.paid; r.unpaid += s.unpaid; if (s.total > 0) r.invoices++; }
  for (const p of payments) row(p.date.slice(0, 7)).receipts += p.amount;
  return [...by.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
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

// ---- new customers: a customer is "new" in the period if its first real invoice (total > 0) in ALL imported
// data falls inside it. It is credited to the rep who issued that first invoice. Based on invoices only, so it is
// an approximation until a customer master with creation dates is imported.
export function firstInvoices(allSales) {
  const first = new Map();
  for (const s of allSales) {
    if (s.total <= 0 || !s.customer) continue;
    const f = first.get(s.customer);
    if (!f || s.date < f.date || (s.date === f.date && s.number < f.number)) first.set(s.customer, { date: s.date, rep: s.rep, number: s.number });
  }
  return first;
}

export function newCustomersByRep(first, { from, to }, allowed) {
  const out = new Map();
  for (const f of first.values()) {
    if ((from && f.date < from) || (to && f.date > to)) continue;
    if (allowed && !allowed.has(f.rep)) continue;
    out.set(f.rep, (out.get(f.rep) ?? 0) + 1);
  }
  return out;
}

// True when the period starts so close to the first imported invoice that "first invoice" cannot mean "new".
export function newCustomersUnreliable(allSales, from, graceDays = 90) {
  if (!allSales.length || !from) return false;
  const start = allSales.reduce((m, s) => (s.date < m ? s.date : m), allSales[0].date);
  return daysBetween(from, start) < graceDays;
}

export function topCustomers(sales, n) {
  const m = new Map();
  for (const s of sales) {
    if (!s.customer) continue;
    const c = m.get(s.customer) ?? { customer: s.customer, sales: 0, invoices: 0 };
    c.sales += s.total; if (s.total > 0) c.invoices++; m.set(s.customer, c);
  }
  return [...m.values()].filter((c) => c.sales > 0).sort((a, b) => b.sales - a.sales).slice(0, n);
}
