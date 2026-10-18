// Runs the parsers on real Daftra exports. Files are never stored in the repo:
//   NEXUS_SAMPLES_DIR=/path/to/exports npm test
// Expected values come from the control totals printed inside the files themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../src/csv.js';
import { parseInvoices, parsePayments } from '../src/daftra.js';

const dir = process.env.NEXUS_SAMPLES_DIR;
const skip = dir ? false : 'NEXUS_SAMPLES_DIR not set';
const pick = (re) => path.join(dir, fs.readdirSync(dir).find((f) => re.test(f)));
const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
const TODAY = process.env.NEXUS_TODAY || new Date().toISOString().slice(0, 10);

let inv, pay;
test('load', { skip }, () => {
  inv = parseInvoices(parseCsv(fs.readFileSync(pick(/revenue_by_invoice/), 'utf8')), { today: TODAY });
  pay = parsePayments(parseCsv(fs.readFileSync(pick(/payments-payment/), 'utf8')), { today: TODAY });
});

test('invoices: nothing rejected, keys unique, no summary row leaked', { skip }, () => {
  assert.equal(inv.rejected.length, 0, JSON.stringify(inv.rejected.slice(0, 5)));
  assert.deepEqual(inv.duplicateKeys, []);
  assert.ok(!inv.sales.some((s) => /مجموع|إجمالي/.test(s.number)));
});
test('invoices: totals equal the file grand-total row (total, paid, unpaid)', { skip }, () => {
  const g = inv.controlTotals.grand;
  assert.equal(sum(inv.sales, 'total'), g.total);
  assert.equal(sum(inv.sales, 'paid'), g.paid);
  assert.equal(sum(inv.sales, 'unpaid'), g.unpaid);
});
test('invoices: per-rep sums equal each rep subtotal row', { skip }, () => {
  const by = new Map();
  for (const s of inv.sales) {
    const a = by.get(s.rep) ?? { total: 0, paid: 0, unpaid: 0 };
    a.total += s.total; a.paid += s.paid; a.unpaid += s.unpaid; by.set(s.rep, a);
  }
  const groups = inv.controlTotals.groups;
  assert.equal(groups.length, new Set(groups.map((x) => x.rep)).size);
  for (const gr of groups) {
    const a = by.get(gr.rep);
    assert.ok(a, `no rows for ${gr.rep}`);
    assert.deepEqual([a.total, a.paid, a.unpaid], [gr.total, gr.paid, gr.unpaid], gr.rep);
  }
});
test('invoices: Daftra returns subtotals are running totals; raw column sum equals the last one', { skip }, () => {
  const groups = inv.controlTotals.groups;
  assert.equal(sum(inv.sales, 'returns'), groups[groups.length - 1].returns);
  assert.notEqual(inv.controlTotals.grand.returns, sum(inv.sales, 'returns')); // the grand row double counts
});
test('payments: unique keys, group subtotals match, zero rows only skipped', { skip }, () => {
  assert.deepEqual(pay.duplicateKeys, []);
  assert.equal(pay.rejected.length, 0);
  assert.equal(sum(pay.payments, 'amount'), pay.controlTotals.grand.amount);
  const by = new Map();
  for (const p of pay.payments) by.set(p.rep, (by.get(p.rep) ?? 0) + p.amount);
  for (const gr of pay.controlTotals.groups) if (gr.amount !== 0) assert.equal(by.get(gr.rep), gr.amount, gr.rep);
});
test('payments: every receiving rep also exists in the invoice file', { skip }, () => {
  const reps = new Set(inv.sales.map((s) => s.rep));
  for (const p of pay.payments) assert.ok(reps.has(p.rep), p.rep);
});
test('summary printout', { skip }, () => {
  const real = inv.sales.filter((s) => s.total > 0);
  console.log(JSON.stringify({
    invoiceRows: inv.sales.length, realInvoices: real.length, phantomSkipped: inv.phantom,
    overpaidFlagged: inv.sales.filter((s) => s.flags.includes('overpaid')).length,
    discrepancies: inv.sales.filter((s) => s.flags.includes('discrepancy')).length,
    activeCustomers: new Set(real.map((s) => s.customer)).size,
    payments: pay.payments.length, zeroSkipped: pay.zeroAmount,
    reps: new Set(inv.sales.map((s) => s.rep)).size,
  }));
});

// ---- ledger reconciliation (the strongest independent check) ----
import { parseLedger, reconcile } from '../src/ledger.js';
let rec;
test('ledger: load and reconcile', { skip }, () => {
  const led = parseLedger(parseCsv(fs.readFileSync(pick(/48ce8132/), 'utf8')));
  rec = reconcile(inv.sales, pay.payments, led);
  console.log(JSON.stringify({ ...rec, invoices: { ...rec.invoices, notInFile: rec.invoices.notInFile.length, amountMismatches: rec.invoices.amountMismatches.length } }));
});
test('ledger: every ledger invoice exists in the invoice file with the same amount', { skip }, () => {
  assert.equal(rec.invoices.notInFile.length, 0);
  assert.equal(rec.invoices.amountMismatches.length, 0);
});
test('ledger: invoices absent from it are fully paid cash sales', { skip }, () => {
  assert.equal(rec.invoices.notInLedger.unpaid, 0);
  assert.equal(rec.invoices.notInLedger.paid, rec.invoices.notInLedger.total);
});
test('ledger: credit and debit notes match to the halala (±0.02)', { skip }, () => {
  assert.ok(Math.abs(rec.creditNotes.file - rec.creditNotes.ledger) <= 2, JSON.stringify(rec.creditNotes));
  assert.ok(Math.abs(rec.debitNotes.file - rec.debitNotes.ledger) <= 2, JSON.stringify(rec.debitNotes));
});
test('ledger: payments reconcile within 5 SAR over ~9,000 receipts', { skip }, () => {
  assert.ok(Math.abs(rec.payments.diff) <= 500, JSON.stringify(rec.payments));
});
test('ledger: closing balance reconciles within 0.05 SAR', { skip }, () => {
  assert.ok(Math.abs(rec.balance.diff) <= 5, JSON.stringify(rec.balance));
});
