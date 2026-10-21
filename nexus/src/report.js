// Pure logic behind the report page: comparison period, headline insights, period presets.
import { daysBetween } from './shared.js';

const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const lastOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m is 1-based
const pad = (n) => String(n).padStart(2, '0');

// The period of equal length immediately before [from, to]; null when it would start before the data does.
export function previousPeriod(from, to, dataStart) {
  if (!from || !to || from > to) return null;
  const len = daysBetween(to, from) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(len - 1));
  return !dataStart || prevFrom < dataStart ? null : { from: prevFrom, to: prevTo };
}

// Relative change in percent; null when there is no meaningful base.
export const deltaPct = (cur, prev) => (prev === null || prev === undefined || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100);

// Shortcuts for the date range, anchored on the newest date in the data (not on "today").
export function presetRange(kind, dataStart, dataEnd) {
  if (!dataStart || !dataEnd) return null;
  const y = Number(dataEnd.slice(0, 4)), m = Number(dataEnd.slice(5, 7));
  const monthsBack = (n) => { const t = y * 12 + (m - 1) - n; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; };
  let r;
  if (kind === 'all') r = { from: dataStart, to: dataEnd };
  else if (kind === 'month') r = { from: `${y}-${pad(m)}-01`, to: dataEnd };
  else if (kind === 'prevMonth') { const p = monthsBack(1); r = { from: `${p.y}-${pad(p.m)}-01`, to: lastOfMonth(p.y, p.m) }; }
  else if (kind === 'last3') { const p = monthsBack(2); r = { from: `${p.y}-${pad(p.m)}-01`, to: dataEnd }; }
  else if (kind === 'last12') { const p = monthsBack(11); r = { from: `${p.y}-${pad(p.m)}-01`, to: dataEnd }; }
  else if (kind === 'ytd') r = { from: `${y}-01-01`, to: dataEnd };
  else return null;
  return { from: r.from < dataStart ? dataStart : r.from, to: r.to };
}

// Top N rows by sales, with everything else folded into one "others" row so charts stay readable.
export function topWithOthers(reps, n, othersLabel = 'أخرى') {
  const rows = reps.filter((r) => r.sales > 0);
  if (rows.length <= n) return rows;
  const rest = rows.slice(n);
  const sum = (k) => rest.reduce((a, r) => a + r[k], 0);
  return [...rows.slice(0, n), { rep: `${othersLabel} (${rest.length})`, sales: sum('sales'), paid: sum('paid'), receipts: sum('receipts'), unpaid: sum('unpaid'), invoices: sum('invoices') }];
}

// Wraps a dynamic value so Latin names/numbers cannot reorder the Arabic sentence around them.
export const iso = (x) => `\u2068${x}\u2069`; // names: direction follows their own letters
export const ltr = (x) => `\u2066${x}\u2069`; // numbers, amounts, percents: always left-to-right

// Facts only: every sentence is derived from the numbers, nothing is guessed.
// fmt = { money(cents) -> string, pct(number) -> string, month(YYYY-MM) -> string }
export function insights({ reps, totals, prevTotals, monthly, debtors, overpaid }, fmt) {
  const out = [];
  const active = reps.filter((r) => r.sales > 0);
  if (active.length && totals.sales > 0) {
    const t = active[0];
    out.push({ kind: 'good', text: `${iso(t.rep)} الأعلى مبيعاً بـ ${ltr(fmt.money(t.sales))} (${ltr(fmt.pct((t.sales / totals.sales) * 100))} من الإجمالي).` });
  }
  const material = active.filter((r) => r.sales >= totals.sales * 0.03);
  if (material.length >= 2) {
    const byPct = [...material].sort((a, b) => b.paidPct - a.paidPct);
    const hi = byPct[0], lo = byPct.at(-1);
    if (hi.rep !== lo.rep) {
      out.push({ kind: 'good', text: `أعلى نسبة تحصيل: ${iso(hi.rep)} (${ltr(fmt.pct(hi.paidPct))}).` });
      out.push({ kind: lo.paidPct < 50 ? 'bad' : 'warn', text: `أدنى نسبة تحصيل: ${iso(lo.rep)} (${ltr(fmt.pct(lo.paidPct))}) على مبيعات ${ltr(fmt.money(lo.sales))}.` });
    }
  }
  const g = prevTotals ? deltaPct(totals.sales, prevTotals.sales) : null;
  if (g !== null) out.push({ kind: g >= 0 ? 'good' : 'bad', text: `المبيعات ${g >= 0 ? 'ارتفعت' : 'انخفضت'} ${ltr(fmt.pct(Math.abs(g)))} عن الفترة السابقة (${ltr(fmt.money(prevTotals.sales))}).` });
  if (monthly.length >= 2) {
    const peak = monthly.reduce((a, b) => (b.sales > a.sales ? b : a));
    out.push({ kind: 'info', text: `شهر الذروة: ${iso(fmt.month(peak.month))} بمبيعات ${ltr(fmt.money(peak.sales))}.` });
  }
  if (debtors.length) out.push({ kind: 'warn', text: `أكبر رصيد مدين: ${iso(debtors[0].customer)} بـ ${ltr(fmt.money(debtors[0].net))}.` });
  if (overpaid > 0) out.push({ kind: 'info', text: `${ltr(overpaid)} فاتورة دفعتها أكبر من إجماليها؛ تُحتسب كما هي في دفترة وتُخفض غير المدفوع.` });
  return out.slice(0, 6);
}
