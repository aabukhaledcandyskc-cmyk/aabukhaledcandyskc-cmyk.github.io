// Converts parsed records (integer halalas) into the JSON the import_* SQL functions expect (SAR strings).
import { fromCents } from './shared.js';

export const salesToRpc = (sales) => sales.map((s) => ({
  key: s.key, number: s.number, date: s.date, rep: s.rep, customer: s.customer, status: s.status ?? '',
  total: fromCents(s.total), paid: fromCents(s.paid), unpaid: fromCents(s.unpaid), returns: fromCents(s.returns),
}));

export const paymentsToRpc = (payments) => payments.map((p) => ({
  key: p.key, number: p.number, invoice: p.invoice, date: p.date, rep: p.rep,
  customer: p.customer, method: p.method, amount: fromCents(p.amount),
}));
