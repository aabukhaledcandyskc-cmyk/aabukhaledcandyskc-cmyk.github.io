// Rules shared by the browser import screen and the server-side validation.
// Any change to SUMMARY_ROW_PATTERN must be mirrored on both sides.

export const EPSILON_CENTS = 2; // 0.02 SAR
export const MAX_FUTURE_DAYS = 7;
export const ALLOW_OVERPAID = true; // overpayments are flagged, not rejected (Daftra keeps them)
export const UNKNOWN_REP = 'غير محدد';

export const SUMMARY_ROW_PATTERN =
  /مجموع|إجمالي|^رقم$|^المعرف$|^رقم السند$|^رقم الفاتورة$|Candy Smart Key|الموظف\s*\/\s*العميل/i;

export function isSummaryRow(text) {
  return SUMMARY_ROW_PATTERN.test(String(text ?? '').trim());
}

// "55.20" / "<span dir=\"ltr\">-0.01</span>" / "1,234.5" -> integer halalas, or null.
export function toCents(raw) {
  const s = String(raw ?? '').replace(/<[^>]*>/g, '').replace(/ر\.\s?س|SAR/g, '').replace(/[,\s]/g, '');
  if (s === '') return 0;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(3, '0');
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1; // half away from zero
  return m[1] === '-' ? -cents : cents;
}

export function fromCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// DD/MM/YYYY -> YYYY-MM-DD. Never goes through Date parsing (that reads MM/DD).
export function parseDmy(raw) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(raw ?? ''));
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysBetween(isoA, isoB) {
  return Math.round((Date.parse(isoA + 'T00:00:00Z') - Date.parse(isoB + 'T00:00:00Z')) / 86400000);
}

// "#8 المشرف / اسم" -> "اسم"; "#000002 اسم " -> "اسم"
export function cleanRepName(raw) {
  const name = String(raw ?? '')
    .replace(/^\s*#\d+\s*/, '')
    .replace(/^(المشرف|المندوب|الموظف)\s*[:\-/]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return name || UNKNOWN_REP;
}

// Drop the tax-id / commercial-register suffix Daftra appends to customer names.
export function cleanCustomerName(raw) {
  return String(raw ?? '')
    .split(/\s-\s*(?:الرقم الضريبي|سجل تجاري)/)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns { ok, reason?, flags[] }. Amounts are integer halalas.
export function validateSale(s, todayIso) {
  const flags = [];
  if (!s.number || isSummaryRow(s.number)) return { ok: false, reason: 'رقم الفاتورة فارغ أو صف مجموع', flags };
  if (!s.date) return { ok: false, reason: 'تاريخ غير صالح', flags };
  if (todayIso && daysBetween(s.date, todayIso) > MAX_FUTURE_DAYS) return { ok: false, reason: 'تاريخ في المستقبل', flags };
  for (const k of ['total', 'paid', 'unpaid', 'returns']) {
    if (s[k] === null || Number.isNaN(s[k])) return { ok: false, reason: `قيمة غير رقمية في ${k}`, flags };
  }
  if (s.total >= 0) {
    if (Math.abs(s.unpaid - (s.total - s.paid - s.returns)) > EPSILON_CENTS) {
      return { ok: false, reason: 'غير المدفوع لا يساوي الإجمالي - المدفوع - المرتجع', flags };
    }
    if (s.paid > s.total + EPSILON_CENTS) {
      if (!ALLOW_OVERPAID) return { ok: false, reason: 'المدفوع أكبر من الإجمالي', flags };
      flags.push('overpaid');
    }
  } else if (s.paid !== 0) flags.push('negative_total_with_payment');
  if (Math.abs(s.total - (s.paid + s.unpaid + s.returns)) > EPSILON_CENTS) flags.push('discrepancy');
  return { ok: true, flags };
}
