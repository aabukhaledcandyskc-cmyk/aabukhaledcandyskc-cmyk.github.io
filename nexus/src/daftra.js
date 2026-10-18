// Parsers for Daftra exports (invoices-by-employee and payments-by-employee).
// Input is an array of rows (arrays of strings) from CSV or an Excel sheet.
import {
  UNKNOWN_REP, isSummaryRow, toCents, parseDmy, cleanRepName, cleanCustomerName, validateSale,
} from './shared.js';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function findColumnIndex(header, test) {
  return header.findIndex((h) => test(norm(h)));
}

function findHeader(rows, needles) {
  const i = rows.findIndex((r) => needles.every((n) => r.some((c) => norm(c).includes(n))));
  if (i < 0) throw new Error(`لم يتم العثور على صف العناوين (${needles.join('، ')})`);
  return i;
}

// A dateless row is either a rep header, the owner header, or a summary/blank row.
function repFromHeaderRow(first) {
  const text = norm(first);
  if (!text) return null;
  if (text.startsWith('#')) return cleanRepName(text);
  if (/Candy Smart Key/i.test(text)) return UNKNOWN_REP;
  if (isSummaryRow(text)) return null;
  if (/(المشرف|المندوب|الموظف)/.test(text)) return cleanRepName(text);
  return null;
}

function walk(rows, headerIdx, dateCol, onData, onTotal) {
  let rep = UNKNOWN_REP;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => norm(c) === '')) continue;
    const date = parseDmy(r[dateCol]);
    if (date) { onData(r, i + 1, date, rep); continue; }
    const first = norm(r[0]);
    if (/^(المجموع|الإجمالي)/.test(first)) { onTotal(r, rep, first); continue; }
    const next = repFromHeaderRow(first);
    if (next) rep = next;
  }
}

export function parseInvoices(rows, { today } = {}) {
  const hi = findHeader(rows, ['التاريخ', 'الإجمالي']);
  const h = rows[hi];
  const col = {
    number: findColumnIndex(h, (c) => c === 'رقم'),
    date: findColumnIndex(h, (c) => c === 'التاريخ'),
    customer: findColumnIndex(h, (c) => c === 'العميل'),
    paid: findColumnIndex(h, (c) => c.includes('مدفوعة') && !c.includes('غير')),
    unpaid: findColumnIndex(h, (c) => c.includes('غير مدفوعة')),
    returns: findColumnIndex(h, (c) => c.includes('مرتجع')),
    total: findColumnIndex(h, (c) => c.includes('الإجمالي') || c.includes('اجمالي')),
  };
  for (const [k, v] of Object.entries(col)) if (v < 0) throw new Error(`عمود مفقود: ${k}`);

  const sales = [], rejected = [], controlTotals = { groups: [], grand: null };
  let phantom = 0;
  walk(rows, hi, col.date,
    (r, line, date, rep) => {
      const number = norm(r[col.number]);
      if (isSummaryRow(number)) { phantom++; return; }
      const rec = {
        number, date, rep, customer: cleanCustomerName(r[col.customer]),
        total: toCents(r[col.total]), paid: toCents(r[col.paid]),
        unpaid: toCents(r[col.unpaid]), returns: toCents(r[col.returns]),
      };
      // Credit/debit notes reuse numbers (000005 appears twice), so their date joins the key.
      rec.key = /إشعار|اشعار/.test(number) ? `${number}|${date}` : number;
      const v = validateSale(rec, today);
      if (!v.ok) { rejected.push({ line, number, reason: v.reason }); return; }
      rec.flags = v.flags;
      sales.push(rec);
    },
    (r, rep, first) => {
      const t = { rep, paid: toCents(r[col.paid]), unpaid: toCents(r[col.unpaid]), returns: toCents(r[col.returns]), total: toCents(r[col.total]) };
      if (first.startsWith('الإجمالي')) controlTotals.grand = t; else controlTotals.groups.push(t);
    });
  const seen = new Set(), duplicateKeys = [];
  for (const s of sales) { if (seen.has(s.key)) duplicateKeys.push(s.key); seen.add(s.key); }
  return { sales, rejected, phantom, duplicateKeys, controlTotals };
}

export function parsePayments(rows, { today } = {}) {
  const hi = findHeader(rows, ['المعرف', 'رقم الفاتورة']);
  const h = rows[hi];
  const col = {
    id: findColumnIndex(h, (c) => c === 'المعرف'),
    invoice: findColumnIndex(h, (c) => c === 'رقم الفاتورة'),
    date: findColumnIndex(h, (c) => c === 'التاريخ'),
    customer: findColumnIndex(h, (c) => c === 'العميل'),
    method: findColumnIndex(h, (c) => c === 'الطريقة'),
    amount: findColumnIndex(h, (c) => c.includes('الإجمالي') || c.includes('اجمالي')),
  };
  for (const [k, v] of Object.entries(col)) if (v < 0) throw new Error(`عمود مفقود: ${k}`);

  const payments = [], rejected = [], controlTotals = { groups: [], grand: null };
  let phantom = 0, zeroAmount = 0;
  walk(rows, hi, col.date,
    (r, line, date, rep) => {
      const number = norm(r[col.id]);
      if (!number || isSummaryRow(number)) { phantom++; return; }
      const amount = toCents(r[col.amount]);
      if (amount === null) { rejected.push({ line, number, reason: 'مبلغ غير رقمي' }); return; }
      if (amount === 0) { zeroAmount++; return; }
      // Receipt numbers are numbered per employee, so they repeat across reps.
      const invoice = norm(r[col.invoice]);
      payments.push({
        key: `${number}|${rep}|${invoice}|${date}`, number, invoice, date, rep,
        customer: cleanCustomerName(r[col.customer]), method: norm(r[col.method]), amount,
      });
    },
    (r, rep, first) => {
      const t = { rep, amount: toCents(r[col.amount]) };
      if (first.startsWith('الإجمالي')) controlTotals.grand = t; else controlTotals.groups.push(t);
    });
  const seen = new Set(), duplicateKeys = [];
  for (const p of payments) { if (seen.has(p.key)) duplicateKeys.push(p.key); seen.add(p.key); }
  return { payments, rejected, phantom, zeroAmount, duplicateKeys, controlTotals };
}
