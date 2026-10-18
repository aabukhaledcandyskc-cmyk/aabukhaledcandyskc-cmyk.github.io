import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.js';
import { parseInvoices, parsePayments } from '../src/daftra.js';

const H = '"رقم","التاريخ","العميل","حالة الفاتورة الإلكترونية","مدفوعة (SAR)","غير مدفوعة (SAR)","مرتجع (SAR)","الإجمالي (SAR)"';
const csv = [
  H, '"","","","","","","",""',
  '"شركة كاندي سمارت كي - Candy Smart Key Company (المالك)","","","","","","",""',
  '"000001","14/07/2025","عميل أ - الرقم الضريبي: 3","لم ترسل","55.20","0.00","0.00","55.20"',
  '"المجموع","","","","55.20","0.00","0.00","55.20"',
  '"#8 المشرف / مندوب ب","","","","","","",""',
  '"000010","13/08/2026","عميل ب","لم ترسل","50.00","40.00","10.00","100.00"', // partial return, DD>12
  '"000011","05/08/2026","عميل ج","لم ترسل","150.00","<span dir=""ltr"">-50.00</span>","0.00","100.00"', // overpaid
  '"000012","06/08/2026","عميل د","لم ترسل","90.00","0.00","0.00","100.00"', // inconsistent -> rejected
  '"000005 إشعار دائن","01/07/2026","عميل ب","لم ترسل","0.00","-488.75","0.00","-488.75"',
  '"000005 إشعار دائن","14/06/2026","عميل ب","لم ترسل","0.00","-5935.73","0.00","-5935.73"',
  '"الإجمالي الكلي (SAR)","","","","1","1","1","1"',
].join('\n');

test('invoice parsing end to end', () => {
  const r = parseInvoices(parseCsv(csv), { today: '2026-10-18' });
  assert.equal(r.sales.length, 5);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /غير المدفوع/);
  assert.deepEqual(r.sales.map((s) => s.rep), ['غير محدد', 'مندوب ب', 'مندوب ب', 'مندوب ب', 'مندوب ب']);
  assert.equal(r.sales[0].customer, 'عميل أ');
  assert.equal(r.sales[1].date, '2026-08-13');
  assert.deepEqual(r.sales[2].flags, ['overpaid']);
  assert.equal(new Set(r.sales.map((s) => s.key)).size, 5); // credit notes keep distinct keys
  assert.equal(r.duplicateKeys.length, 0);
  assert.equal(r.controlTotals.grand.total, 100);
  assert.equal(r.controlTotals.groups.length, 1);
});
test('the grand-total row is never counted as an invoice', () => {
  const r = parseInvoices(parseCsv(csv), { today: '2026-10-18' });
  assert.ok(!r.sales.some((s) => /الإجمالي|المجموع/.test(s.number)));
});
test('column positions are found by name when an extra column shifts them', () => {
  const noStatus = csv.split('\n').map((l) => l.replace(/,"لم ترسل"/, '').replace('"حالة الفاتورة الإلكترونية",', '')).join('\n');
  const a = parseInvoices(parseCsv(csv), { today: '2026-10-18' });
  const b = parseInvoices(parseCsv(noStatus), { today: '2026-10-18' });
  const dropStatus = (r) => r.sales.map(({ status, ...rest }) => rest); // the shifted file has no status column
  assert.deepEqual(dropStatus(b), dropStatus(a));
});
test('re-parsing the same file gives identical keys (idempotent upsert input)', () => {
  const a = parseInvoices(parseCsv(csv)).sales.map((s) => s.key);
  const b = parseInvoices(parseCsv(csv)).sales.map((s) => s.key);
  assert.deepEqual(a, b);
});

const PH = '"المعرف","رقم الفاتورة","التاريخ","العميل","الطريقة","رقم معرف","الإجمالي (SAR)"';
const pcsv = [
  PH, '"[شركة كاندي سمارت كي - Candy Smart Key Company]","","","","","",""',
  '"المجموع","","","","","","0"',
  '"شركة كاندي سمارت كي - Candy Smart Key Company (المالك)","","","","","",""',
  '"000124","000001","14/07/2025","عميل أ","نقدي","","55.2"',
  '"000006","000002","26/07/2025","عميل ب","نقدي","","-219.07"', // negative adjustment kept
  '"المجموع","","","","","","-163.87"',
  '"#000003 مندوب و","","","","","","",""',
  '"000124","000247","03/09/2026","عميل ب","نقدي","","-162"', // same receipt no., other rep
  '"000125","000248","03/09/2026","عميل ب","نقدي","","0"', // zero -> skipped
].join('\n');

test('payments: per-rep receipt numbers do not collide, negatives kept, zeros skipped', () => {
  const r = parsePayments(parseCsv(pcsv), { today: '2026-10-18' });
  assert.equal(r.payments.length, 3);
  assert.equal(r.zeroAmount, 1);
  assert.equal(r.duplicateKeys.length, 0);
  assert.equal(r.payments[1].amount, -21907);
  assert.equal(r.payments[2].rep, 'مندوب و');
});
