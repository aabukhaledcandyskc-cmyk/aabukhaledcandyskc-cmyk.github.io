import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEntry, parseLedger, reconcile } from '../src/ledger.js';

test('ledger entry classification (Arabic and English labels)', () => {
  assert.deepEqual(classifyEntry('فاتورة #000001'), { type: 'invoice', ref: '000001' });
  assert.deepEqual(classifyEntry('Invoice #000026'), { type: 'invoice', ref: '000026' });
  assert.equal(classifyEntry('فاتورة مرتجعة #000001').type, 'return_invoice');
  assert.equal(classifyEntry('مدفوعات العميل #000124 عميل، فاتورة #000001').type, 'payment');
  assert.equal(classifyEntry('Client Payment #000028 X , Invoice #000026').type, 'payment');
  assert.equal(classifyEntry('مرتجع نقدي #000004 عميل').type, 'cash_refund');
  assert.equal(classifyEntry('إشعار دائن').type, 'credit_note');
  assert.equal(classifyEntry('اثبات سداد المستحق شهر مارس').type, 'manual');
});

const hdr = [['رقم', 'رقم القيد', '', 'التاريخ', 'موظف', 'الوصف', 'مدين', 'دائن', 'مدين', 'دائن']];
const E = (date, desc, d, c) => ['1', '1', '1', date, 'x', desc, d, c, '0', '0'];
const ledgerRows = [...hdr,
  ['عميل أ 1204', '', '', '', '', '', '', '', '', ''],
  ['الرصيد قبل', '', '', '', '', '', '', '', '0', '0'],
  E('01/01/2026', 'فاتورة #000001', '100.005', ''),
  E('02/01/2026', 'مدفوعات العميل #000009 عميل أ، فاتورة #000001', '', '60'),
  E('03/01/2026', 'تسوية يدوية', '', '10'),
  ['المجموع', '', '', '', '', '', '100.005', '70', '', ''],
];
test('ledger parser keeps unrounded amounts and groups by customer', () => {
  const l = parseLedger(ledgerRows);
  assert.equal(l.entries.length, 3);
  assert.equal(l.customers, 1);
  assert.equal(l.entries[0].debit, 100005000);
  assert.equal(l.totals.manualNet, -10000000);
});
test('reconciliation: cash sale missing from ledger is explained by its payment', () => {
  const l = parseLedger(ledgerRows);
  const sales = [
    { number: '000001', total: 10001, paid: 6000, unpaid: 4001 },
    { number: '000002', total: 5000, paid: 5000, unpaid: 0 }, // cash sale, not in ledger
  ];
  const payments = [{ amount: 6000 }, { amount: 5000 }];
  const r = reconcile(sales, payments, l);
  assert.equal(r.invoices.amountMismatches.length, 0);
  assert.deepEqual(r.invoices.notInLedger, { count: 1, total: 5000, paid: 5000, unpaid: 0 });
  assert.equal(r.payments.diff, 0);
  assert.equal(r.balance.diff, 0);
});
