import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fromCents, parseDmy, cleanRepName, cleanCustomerName, isSummaryRow, validateSale } from '../src/shared.js';

test('toCents is exact, handles span wrappers and negatives', () => {
  assert.equal(toCents('7933.51') - toCents('7933.50'), 1); // float gives 0.0100000000002
  assert.equal(toCents('<span dir="ltr">-0.01</span>'), -1);
});
test('toCents rounding detail', () => {
  assert.equal(toCents('219.075'), 21908);
  assert.equal(toCents('-219.075'), -21908);
  assert.equal(toCents('55.2'), 5520);
  assert.equal(toCents(''), 0);
  assert.equal(toCents('2,833,255.99 ر.س'), 283325599);
  assert.equal(toCents('abc'), null);
  assert.equal(toCents('12 كرتون'), null);
  assert.equal(fromCents(-1), '-0.01');
  assert.equal(fromCents(17363183), '173631.83');
});
test('dates are DD/MM and never read as MM/DD', () => {
  assert.equal(parseDmy('13/08/2026'), '2026-08-13');
  assert.equal(parseDmy('09/08/2026'), '2026-08-09');
  assert.equal(parseDmy('31/02/2026'), null);
  assert.equal(parseDmy('2026-08-13'), null);
});
test('rep and customer name cleaning', () => {
  assert.equal(cleanRepName('#8 المشرف / مندوب ب'), 'مندوب ب');
  assert.equal(cleanRepName('#15 المشرف / مندوب ج '), 'مندوب ج');
  assert.equal(cleanRepName('#000002 مندوب د '), 'مندوب د');
  assert.equal(cleanRepName('#11 الموظف مندوب هـ'), 'مندوب هـ');
  assert.equal(cleanCustomerName('مؤسسة نموذج - الرقم الضريبي: 300000000000003 - سجل تجاري: 1000000000'), 'مؤسسة نموذج');
});
test('summary-row pattern', () => {
  for (const t of ['المجموع', 'الإجمالي الكلي (SAR)', 'رقم', 'المعرف', 'Candy Smart Key Company', 'الموظف / العميل']) assert.ok(isSummaryRow(t), t);
  for (const t of ['000001', '000009 إشعار دائن', '000001 فاتورة مرتجعة']) assert.ok(!isSummaryRow(t), t);
});
const base = { number: '1', date: '2026-01-01', total: 10000, paid: 4000, unpaid: 6000, returns: 0 };
test('validation rules', () => {
  assert.ok(validateSale(base, '2026-02-01').ok);
  assert.ok(validateSale({ ...base, paid: 4000, unpaid: 5000, returns: 1000 }, '2026-02-01').ok); // partial return
  assert.equal(validateSale({ ...base, unpaid: 6003 }, '2026-02-01').ok, false); // beyond 0.02
  assert.ok(validateSale({ ...base, unpaid: 6002 }, '2026-02-01').ok); // exactly 0.02
  const over = validateSale({ ...base, paid: 12000, unpaid: -2000 }, '2026-02-01');
  assert.ok(over.ok && over.flags.includes('overpaid'));
  assert.equal(validateSale({ ...base, paid: 12000, unpaid: 6000 }, '2026-02-01').ok, false);
  assert.ok(validateSale({ ...base, total: -500, paid: 0, unpaid: -500 }, '2026-02-01').ok); // credit note
  assert.equal(validateSale({ ...base, date: '2026-03-01' }, '2026-02-01').ok, false); // future
  assert.equal(validateSale({ ...base, date: null }, '2026-02-01').ok, false);
  assert.equal(validateSale({ ...base, number: 'المجموع' }, '2026-02-01').ok, false);
});
