// Customer general-ledger export from Daftra. Used only to verify invoices and payments.
// Ledger amounts are unrounded (219.075), so they are kept in micro-riyals (1e-6).
import { parseDmy } from './shared.js';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const toMicro = (raw) => {
  const s = String(raw ?? '').replace(/,/g, '').trim();
  if (s === '') return 0;
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error(`مبلغ غير رقمي في الأستاذ: ${s}`);
  return Math.round(v * 1e6);
};

export function classifyEntry(desc) {
  const d = norm(desc);
  let m;
  if (/^(فاتورة مرتجعة|Credit Note)/.test(d)) return { type: 'return_invoice' };
  if ((m = /^(?:فاتورة|Invoice)\s*#(\d+)$/.exec(d))) return { type: 'invoice', ref: m[1] };
  if (/^(مدفوعات العميل|Client Payment)/.test(d)) return { type: 'payment' };
  if (/^(مرتجع نقدي|Client Refund)/.test(d)) return { type: 'cash_refund' };
  if (/^Refund Receipt/.test(d)) return { type: 'refund_receipt' };
  if (/^إشعار دائن/.test(d)) return { type: 'credit_note' };
  if (/^اشعار مدين/.test(d)) return { type: 'debit_note' };
  return { type: 'manual' };
}

export function parseLedger(rows) {
  const entries = [];
  let customer = null;
  for (const r of rows) {
    if (!r || r.length < 8) continue;
    const first = norm(r[0]);
    const date = parseDmy(r[3]);
    if (date) {
      const c = classifyEntry(r[5]);
      entries.push({ customer, date, desc: norm(r[5]), debit: toMicro(r[6]), credit: toMicro(r[7]), ...c });
    } else if (first && !norm(r[1]) && !norm(r[3]) && !/^(المجموع|الرصيد|الإجمالي|رقم$)/.test(first)) {
      customer = first;
    }
  }
  const sum = (type, side) => entries.filter((e) => e.type === type).reduce((a, e) => a + e[side], 0);
  return {
    entries,
    customers: new Set(entries.map((e) => e.customer)).size,
    totals: {
      debit: entries.reduce((a, e) => a + e.debit, 0),
      credit: entries.reduce((a, e) => a + e.credit, 0),
      payments: sum('payment', 'credit'),
      cashRefunds: sum('cash_refund', 'debit'),
      manualNet: sum('manual', 'debit') - sum('manual', 'credit'),
    },
  };
}

// Everything returned in halalas (integers) except the raw ledger object.
export function reconcile(sales, payments, ledger) {
  const micro = (c) => c * 10000;
  const toC = (m) => Math.round(m / 10000);
  const fileInv = new Map(sales.filter((s) => /^\d+$/.test(s.number)).map((s) => [s.number, s]));
  const ledInv = new Map(ledger.entries.filter((e) => e.type === 'invoice').map((e) => [e.ref, e]));

  const amountMismatches = [];
  for (const [ref, e] of ledInv) {
    const f = fileInv.get(ref);
    if (f && Math.abs(toC(e.debit) - f.total) > 2) amountMismatches.push({ ref, ledger: toC(e.debit), file: f.total });
  }
  const notInLedger = [...fileInv.values()].filter((s) => !ledInv.has(s.number));
  const notInFile = [...ledInv.keys()].filter((ref) => !fileInv.has(ref));
  const agg = (xs, k) => xs.reduce((a, x) => a + x[k], 0);

  const noteTotal = (re) => agg(sales.filter((s) => re.test(s.number)), 'total');
  const creditNotes = { file: noteTotal(/إشعار دائن/), ledger: -toC(ledger.entries.filter((e) => e.type === 'credit_note').reduce((a, e) => a + e.credit, 0)) };
  const debitNotes = { file: noteTotal(/اشعار مدين/), ledger: toC(ledger.entries.filter((e) => e.type === 'debit_note').reduce((a, e) => a + e.debit, 0)) };

  const cashSalesPaid = agg(notInLedger, 'paid');
  const ledgerNetPayments = toC(ledger.totals.payments - ledger.totals.cashRefunds);
  const filePayments = agg(payments, 'amount');
  const fileSales = agg(sales, 'total');
  const expectedBalance = fileSales - filePayments + toC(ledger.totals.manualNet);
  const ledgerBalance = toC(ledger.totals.debit - ledger.totals.credit);

  return {
    invoices: {
      inLedger: ledInv.size, matched: ledInv.size - notInFile.length - amountMismatches.length,
      amountMismatches, notInFile,
      notInLedger: { count: notInLedger.length, total: agg(notInLedger, 'total'), paid: cashSalesPaid, unpaid: agg(notInLedger, 'unpaid') },
    },
    creditNotes, debitNotes,
    payments: { ledgerNet: ledgerNetPayments, cashSalesPaid, file: filePayments, diff: filePayments - (ledgerNetPayments + cashSalesPaid) },
    balance: { ledger: ledgerBalance, expected: expectedBalance, diff: ledgerBalance - expectedBalance, manualNet: toC(ledger.totals.manualNet) },
  };
}
