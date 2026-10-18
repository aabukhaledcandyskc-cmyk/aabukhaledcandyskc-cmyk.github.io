import { parseCsv } from './csv.js';
import { parseInvoices, parsePayments, detectKind } from './daftra.js';
import { browserStore } from './store.js';
import {
  computeKpis, repSummary, filterByPeriod, weeklyTrend, allowedReps, restrictToReps,
  monthsInRange, targetsByRep, targetKey, progressPct, agingByCustomer,
} from './kpi.js';
import { toCents, fromCents } from './shared.js';
import { parseLedger } from './ledger.js';
import { buildChecks, compactLedger, compareWithDaftra } from './verify.js';
import { rowsFromWorkbook, workbookFromRows } from './excel.js';
import { NEXUS_VERSION } from './config.js';

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n) => Number(n).toLocaleString('en-US');
const today = () => new Date().toISOString().slice(0, 10);
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const FLAG_LABEL = { overpaid: 'دفعة زائدة', discrepancy: 'تناقض', negative_total_with_payment: 'سالب مع دفعة' };
const SYSTEM_KEY = '__system';

const st = {
  sales: [], payments: [], meta: new Map(), targets: [], system: { name: 'NEXUS Dashboard', logo: '' },
  sel: { reps: new Set(), regions: new Set(), positions: new Set(), statuses: new Set() }, ledger: null, theme: null,
  tab: 'summary', invLimit: 300, payLimit: 300, pending: [], charts: {},
};

$('version').textContent = `الإصدار ${NEXUS_VERSION}`;

// ---------------------------------------------------------------- file import
async function readRows(file) {
  if (/\.csv$/i.test(file.name)) return parseCsv(await file.text());
  if (!window.XLSX) throw new Error('مكتبة Excel غير محمّلة؛ احفظ الملف بصيغة CSV وأعد المحاولة');
  return rowsFromWorkbook(window.XLSX, await file.arrayBuffer());
}

async function previewFiles(files) {
  st.pending = [];
  const out = [];
  for (const file of files) {
    try {
      const rows = await readRows(file);
      const kind = detectKind(rows);
      if (kind === 'ledger') {
        const led = parseLedger(rows);
        st.pending.push({ kind, file: file.name, ledger: led, recs: led.entries, rejected: [] });
        out.push(`<div class="file"><b>${escapeHtml(file.name)}</b> — الأستاذ العام للعملاء<div class="ok">${int(led.entries.length)} قيداً، ${int(led.customers)} حساب عميل</div><div class="muted">لا يُضاف إلى المبيعات؛ يُستخدم للمطابقة في تبويب «التحقق»</div></div>`);
        continue;
      }
      if (!kind) { out.push(`<div class="file"><b>${escapeHtml(file.name)}</b><div class="bad">لم يُعرف نوع الملف (ليس تقرير فواتير ولا مدفوعات ولا أستاذ من دفترة)</div></div>`); continue; }
      const res = kind === 'invoices' ? parseInvoices(rows, { today: today() }) : parsePayments(rows, { today: today() });
      const recs = kind === 'invoices' ? res.sales : res.payments;
      st.pending.push({ kind, file: file.name, recs, rejected: res.rejected });
      const fileChecks = buildChecks(kind === 'invoices'
        ? { sales: recs, payments: [], controls: { invoices: res.controlTotals } }
        : { sales: [], payments: recs, controls: { payments: res.controlTotals } });
      const failed = fileChecks.checks.filter((c) => c.ok === false).length + fileChecks.repRows.filter((r) => !r.ok).length;
      const verdict = fileChecks.checks.length ? (failed ? `<div class="bad">✗ ${failed} فحص لا يطابق صفوف المجاميع داخل الملف نفسه</div>` : `<div class="ok">✓ يطابق صف «الإجمالي الكلي» ومجاميع المناديب داخل الملف</div>`) : '';
      const dates = recs.map((r) => r.date).sort();
      const count = (f) => recs.filter((r) => r.flags?.includes(f)).length;
      const extra = kind === 'invoices'
        ? `<div>إجمالي المبيعات: <b>${money(recs.reduce((a, r) => a + r.total, 0))}</b></div>
           ${res.duplicateKeys.length ? `<div class="bad">مفاتيح مكررة: ${res.duplicateKeys.length}</div>` : ''}
           ${count('overpaid') ? `<div class="warn">دفعات زائدة (مقبولة بوسم): ${count('overpaid')}</div>` : ''}
           ${count('discrepancy') ? `<div class="warn">تناقض في الإجماليات: ${count('discrepancy')}</div>` : ''}`
        : `<div>إجمالي المقبوضات: <b>${money(recs.reduce((a, r) => a + r.amount, 0))}</b></div>
           ${res.duplicateKeys.length ? `<div class="bad">مفاتيح مكررة: ${res.duplicateKeys.length}</div>` : ''}`;
      out.push(`<div class="file"><b>${escapeHtml(file.name)}</b> — ${kind === 'invoices' ? 'فواتير' : 'مدفوعات'}
        <div class="ok">${int(recs.length)} صف صالح</div>${verdict}<div class="muted">من ${dates[0] ?? '—'} إلى ${dates.at(-1) ?? '—'}</div>${extra}
        ${res.rejected.length ? `<div class="bad">مرفوض: ${res.rejected.length} — ${escapeHtml(res.rejected.slice(0, 3).map((r) => `سطر ${r.line}: ${r.reason}`).join('، '))}</div>` : ''}</div>`);
    } catch (e) {
      out.push(`<div class="file"><b>${escapeHtml(file.name)}</b><div class="bad">${escapeHtml(e.message)}</div></div>`);
    }
  }
  $('preview').innerHTML = out.join('');
  $('saveBtn').disabled = !st.pending.some((p) => p.recs.length);
}

async function saveImport() {
  $('saveBtn').disabled = true;
  const results = [];
  for (const p of st.pending) {
    if (p.kind === 'ledger') {
      await browserStore.put('meta', { key: 'ledger', at: new Date().toISOString(), file: p.file, data: compactLedger(p.ledger) });
      await browserStore.log({ at: new Date().toISOString(), user: 'guest', kind: 'ledger', file: p.file, added: p.recs.length, updated: 0, rejected: 0 });
      results.push(`<div class="file"><b>${escapeHtml(p.file)}</b><div class="ok">حُفظ الأستاذ العام (${int(p.recs.length)} قيداً)</div></div>`);
      continue;
    }
    const r = await browserStore.upsert(p.kind === 'invoices' ? 'sales' : 'payments', p.recs);
    await browserStore.log({ at: new Date().toISOString(), user: 'guest', kind: p.kind, file: p.file, ...r, rejected: p.rejected.length });
    results.push(`<div class="file"><b>${escapeHtml(p.file)}</b><div class="ok">أُضيف ${int(r.added)} — حُدّث ${int(r.updated)} — مرفوض ${p.rejected.length}</div></div>`);
  }
  st.pending = [];
  await refresh(true);
  $('preview').innerHTML = results.join('');
}

// ---------------------------------------------------------------- filters
function msel(id, label, set, options) {
  const list = $(`${id}List`);
  list.innerHTML = `<label><input type="checkbox" data-all> الكل</label>` +
    options.map((n) => `<label><input type="checkbox" data-v="${escapeHtml(n)}" ${set.has(n) ? 'checked' : ''}> ${escapeHtml(n || 'غير محدد')}</label>`).join('');
  list.querySelector('[data-all]').checked = set.size === 0;
  $(`${id}SelLabel`).textContent = set.size ? `${label.sel} (${set.size})` : label.all;
}
const MSELS = [
  { id: 'rep', key: 'reps', label: { all: 'كل المناديب', sel: 'المناديب' }, opts: () => allRepNames() },
  { id: 'region', key: 'regions', label: { all: 'كل المناطق', sel: 'المناطق' }, opts: () => unique([...st.meta.values()].map((m) => m.region)) },
  { id: 'pos', key: 'positions', label: { all: 'كل المناصب', sel: 'المناصب' }, opts: () => unique([...st.meta.values()].map((m) => m.position)) },
  { id: 'status', key: 'statuses', label: { all: 'كل الحالات', sel: 'الحالات' }, opts: () => unique(st.sales.map((r) => r.status ?? '')) },
];
const unique = (xs) => [...new Set(xs)].sort((a, b) => a.localeCompare(b, 'ar'));
const allRepNames = () => unique([...st.sales, ...st.payments].map((r) => r.rep));
function renderMsels() {
  for (const m of MSELS) msel(m.id, m.label, st.sel[m.key], m.opts());
  $('statusSel').style.display = unique(st.sales.map((r) => r.status ?? '')).length > 1 ? '' : 'none'; // only useful with 2+ statuses
}
for (const m of MSELS) {
  $(`${m.id}List`).onchange = (e) => {
    const el = e.target, set = st.sel[m.key];
    if (el.dataset.all !== undefined) set.clear(); else if (el.checked) set.add(el.dataset.v); else set.delete(el.dataset.v);
    renderMsels(); render();
  };
}

function current() {
  const from = $('from').value, to = $('to').value;
  const allowed = allowedReps(allRepNames(), st.meta, st.sel);
  const stSel = st.sel.statuses;
  const s = restrictToReps(filterByPeriod(st.sales, { from, to }), allowed).filter((r) => !stSel.size || stSel.has(r.status ?? ''));
  const p = restrictToReps(filterByPeriod(st.payments, { from, to }), allowed);
  return { from, to, allowed, s, p };
}

// ---------------------------------------------------------------- rendering
const progress = (pct) => (pct === null ? '<span class="muted">—</span>'
  : `<div class="prog"><div class="track"><div class="fill ${pct > 100 ? 'over' : ''}" style="width:${Math.min(100, pct)}%"></div></div><span class="pct">${+pct.toFixed(1)}%</span></div>`);

function render() {
  const c = current();
  const k = computeKpis(c.s, c.p);
  const card = (l, v, sub = '') => `<div class="card"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  $('kpis').innerHTML = [
    card('إجمالي المبيعات', money(k.sales)),
    card('تحصيل فواتير الفترة', money(k.paid), `${k.paidPct.toFixed(1)}% من المبيعات`),
    card('إجمالي المقبوضات', money(k.receipts), 'يشمل فواتير فترات سابقة'),
    card('غير المدفوع', money(k.unpaid)),
    card('المرتجعات', money(k.returns)),
    card('عدد الفواتير', int(k.invoiceCount)),
    card('العملاء النشطون', int(k.activeCustomers)),
    card('متوسط الفاتورة', money(k.avgInvoice)),
  ].join('') + (k.discrepancies ? card('تناقضات', int(k.discrepancies), 'total ≠ paid+unpaid+returns') : '');

  const tmap = targetsByRep(st.targets, c.allowed, monthsInRange(c.from, c.to));
  const tSales = [...tmap.values()].reduce((a, t) => a + t.sales, 0), tColl = [...tmap.values()].reduce((a, t) => a + t.collection, 0);
  $('targetCards').innerHTML = (tSales || tColl) ? [
    ['هدف المبيعات', tSales, k.sales], ['هدف التحصيل (المقبوضات)', tColl, k.receipts],
  ].map(([l, t, a]) => `<div class="card"><div class="l">${l}</div><div class="s">المستهدف ${money(t)} — الفعلي ${money(a)}</div>${progress(progressPct(a, t))}</div>`).join('') : '';

  const reps = repSummary(c.s, c.p);
  $('reps').innerHTML = `<tr><th>المندوب</th><th>المنطقة</th><th>المنصب</th><th class="n">المبيعات</th><th class="n">التحصيل</th><th class="n">نسبة التحصيل</th><th class="n">المقبوضات</th><th class="n">غير المدفوع</th><th class="n">المرتجعات</th><th class="n">الفواتير</th><th>تحقيق هدف المبيعات</th><th>تحقيق هدف التحصيل</th></tr>` +
    (reps.map((r) => {
      const m = st.meta.get(r.rep) ?? {}, t = tmap.get(r.rep);
      return `<tr><td>${escapeHtml(r.rep)}</td><td>${escapeHtml(m.region ?? '')}</td><td>${escapeHtml(m.position ?? '')}</td><td class="n">${money(r.sales)}</td><td class="n">${money(r.paid)}</td><td class="n ${r.paidPct < 50 ? 'low' : ''}">${r.paidPct.toFixed(1)}%</td><td class="n">${money(r.receipts)}</td><td class="n">${money(r.unpaid)}</td><td class="n">${money(r.returns)}</td><td class="n">${int(r.invoices)}</td><td>${progress(t ? progressPct(r.sales, t.sales) : null)}</td><td>${progress(t ? progressPct(r.receipts, t.collection) : null)}</td></tr>`;
    }).join('') || '<tr><td colspan="12" class="muted">لا توجد بيانات — استورد ملفات دفترة أولاً</td></tr>');
  const low = reps.filter((r) => r.sales > 0 && r.paidPct < 50);
  $('alerts').innerHTML = low.length ? `<div class="notice">تنبيه: نسبة التحصيل أقل من 50% عند: ${low.map((r) => `${escapeHtml(r.rep)} (${r.paidPct.toFixed(1)}%)`).join('، ')}</div>` : '';
  renderCharts(reps, weeklyTrend(c.s, c.p));
  $('rangeInfo').textContent = st.sales.length ? `${int(c.s.length)} صف مبيعات، ${int(c.p.length)} سند ضمن الفلاتر` : '';
  $('printTitle').textContent = `${st.system.name} — الفترة من ${c.from} إلى ${c.to}`;
  renderPane(c);
}

function renderCharts(reps, trend) {
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const text = css.getPropertyValue('--text').trim(), grid = css.getPropertyValue('--line').trim(), accent = css.getPropertyValue('--accent').trim(), warn = css.getPropertyValue('--warn').trim();
  const fmt = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const common = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: text } } } };
  const axis = (ticks = {}) => ({ ticks: { color: text, ...ticks }, grid: { color: grid } });
  const top = reps.filter((r) => r.sales > 0);
  $('repBox').style.height = `${Math.max(260, top.length * 30 + 80)}px`;
  st.charts.rep?.destroy(); st.charts.trend?.destroy();
  st.charts.rep = new window.Chart($('repChart'), { type: 'bar', data: { labels: top.map((r) => r.rep), datasets: [
    { label: 'المبيعات', data: top.map((r) => r.sales / 100), backgroundColor: accent }, { label: 'التحصيل', data: top.map((r) => r.paid / 100), backgroundColor: warn }] },
  options: { ...common, indexAxis: 'y', scales: { x: axis({ callback: fmt }), y: axis() } } });
  st.charts.trend = new window.Chart($('trendChart'), { type: 'line', data: { labels: trend.map((w) => w.week), datasets: [
    { label: 'المبيعات', data: trend.map((w) => w.sales / 100), borderColor: accent, backgroundColor: accent, tension: .25, pointRadius: 0 },
    { label: 'المقبوضات', data: trend.map((w) => w.receipts / 100), borderColor: warn, backgroundColor: warn, tension: .25, pointRadius: 0 }] },
  options: { ...common, interaction: { mode: 'index', intersect: false }, scales: { x: axis(), y: axis({ callback: fmt }) } } });
}

// ---- tabs with raw lists
const like = (q, ...fields) => { const n = q.trim().toLowerCase(); return !n || fields.some((f) => String(f ?? '').toLowerCase().includes(n)); };
const view = {}; // current filtered lists, used by CSV export

function renderPane(c) {
  if (st.tab === 'verify') renderVerify(c);
  else if (st.tab === 'aging') {
    const asOf = c.to || today();
    const q = $('agingQ').value;
    view.aging = agingByCustomer(c.s, asOf).filter((x) => like(q, x.customer));
    $('agingNote').textContent = `الأعمار محسوبة حتى ${asOf}. الرصيد = مجموع «غير المدفوع» بعد الفلاتر، والأعمار تخص الفواتير ذات الرصيد الموجب فقط. العملاء ذوو الرصيد الدائن غير معروضين. (${int(view.aging.length)} عميلاً)`;
    $('agingTable').innerHTML = `<tr><th>#</th><th>العميل</th><th class="n">الرصيد الصافي</th><th class="n">0–30 يوماً</th><th class="n">31–60</th><th class="n">61–90</th><th class="n">أكثر من 90</th><th class="n">فواتير مفتوحة</th><th>آخر فاتورة</th></tr>` +
      view.aging.slice(0, 300).map((x, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(x.customer)}</td><td class="n"><b>${money(x.net)}</b></td><td class="n">${money(x.b0)}</td><td class="n">${money(x.b30)}</td><td class="n">${money(x.b60)}</td><td class="n ${x.b90 ? 'low' : ''}">${money(x.b90)}</td><td class="n">${x.open}</td><td>${x.last}</td></tr>`).join('');
  } else if (st.tab === 'invoices') {
    const q = $('invQ').value;
    view.invoices = c.s.filter((r) => like(q, r.number, r.customer, r.rep)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.number < b.number ? 1 : -1));
    $('invInfo').textContent = `يعرض ${int(Math.min(st.invLimit, view.invoices.length))} من ${int(view.invoices.length)}`;
    $('invTable').innerHTML = `<tr><th>التاريخ</th><th>الرقم</th><th>المندوب</th><th>العميل</th><th class="n">الإجمالي</th><th class="n">المدفوع</th><th class="n">غير المدفوع</th><th class="n">المرتجع</th><th>ملاحظات</th></tr>` +
      view.invoices.slice(0, st.invLimit).map((r) => `<tr><td>${r.date}</td><td>${escapeHtml(r.number)}</td><td>${escapeHtml(r.rep)}</td><td>${escapeHtml(r.customer)}</td><td class="n">${money(r.total)}</td><td class="n">${money(r.paid)}</td><td class="n">${money(r.unpaid)}</td><td class="n">${money(r.returns)}</td><td class="warn">${r.flags.map((f) => FLAG_LABEL[f] ?? f).join('، ')}</td></tr>`).join('');
    $('invMore').style.display = view.invoices.length > st.invLimit ? '' : 'none';
  } else if (st.tab === 'payments') {
    const q = $('payQ').value;
    view.payments = c.p.filter((r) => like(q, r.number, r.invoice, r.customer, r.rep)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    $('payInfo').textContent = `يعرض ${int(Math.min(st.payLimit, view.payments.length))} من ${int(view.payments.length)}`;
    $('payTable').innerHTML = `<tr><th>التاريخ</th><th>رقم السند</th><th>الفاتورة</th><th>المندوب</th><th>العميل</th><th>الطريقة</th><th class="n">المبلغ</th></tr>` +
      view.payments.slice(0, st.payLimit).map((r) => `<tr><td>${r.date}</td><td>${escapeHtml(r.number)}</td><td>${escapeHtml(r.invoice)}</td><td>${escapeHtml(r.rep)}</td><td>${escapeHtml(r.customer)}</td><td>${escapeHtml(r.method)}</td><td class="n ${r.amount < 0 ? 'bad' : ''}">${money(r.amount)}</td></tr>`).join('');
    $('payMore').style.display = view.payments.length > st.payLimit ? '' : 'none';
  }
}

function save(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function download(name, fmt, header, rows) {
  if (fmt === 'xlsx') {
    if (!window.XLSX) return alert('مكتبة Excel غير محمّلة');
    const wb = workbookFromRows(window.XLSX, header, rows, name);
    return save(new Blob([window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], { type: 'application/octet-stream' }), `${name}.xlsx`);
  }
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  save(new Blob(['\ufeff' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
}
const sar = (c) => fromCents(c);
const EXPORTS = {
  aging: (f) => download('aging', f, ['العميل', 'الرصيد الصافي', '0-30', '31-60', '61-90', '+90', 'فواتير مفتوحة', 'آخر فاتورة'], view.aging.map((x) => [x.customer, sar(x.net), sar(x.b0), sar(x.b30), sar(x.b60), sar(x.b90), x.open, x.last])),
  invoices: (f) => download('invoices', f, ['التاريخ', 'الرقم', 'المندوب', 'العميل', 'الإجمالي', 'المدفوع', 'غير المدفوع', 'المرتجع', 'ملاحظات'], view.invoices.map((r) => [r.date, r.number, r.rep, r.customer, sar(r.total), sar(r.paid), sar(r.unpaid), sar(r.returns), r.flags.map((x) => FLAG_LABEL[x] ?? x).join(' | ')])),
  payments: (f) => download('payments', f, ['التاريخ', 'رقم السند', 'الفاتورة', 'المندوب', 'العميل', 'الطريقة', 'المبلغ'], view.payments.map((r) => [r.date, r.number, r.invoice, r.rep, r.customer, r.method, sar(r.amount)])),
};

// ---------------------------------------------------------------- verification tab
function renderVerify(c) {
  const controls = st.controls && st.controls.nSales === st.sales.length && st.controls.nPayments === st.payments.length ? st.controls : null;
  const v = buildChecks({ sales: st.sales, payments: st.payments, controls: controls ?? {}, ledger: st.ledger });
  const fmtv = (ch, x) => (ch.count ? int(x) : money(x));
  const groups = [...new Set(v.checks.map((x) => x.group))];
  const mark = (ok) => (ok === true ? '<span class="ok">✓ مطابق</span>' : ok === false ? '<span class="bad">✗ فرق</span>' : '<span class="warn">⚠ مفسَّر</span>');
  let html = '';
  if (!st.sales.length) html = '<p class="muted">لا توجد بيانات بعد.</p>';
  else {
    html += `<p class="muted">تُقارن هذه الفحوص كل البيانات المحفوظة (دون فلاتر) بمصادر مستقلة: ${controls ? 'صفوف المجاميع داخل ملفات دفترة، و' : ''}الأستاذ العام للعملاء.${controls ? '' : ' مجاميع الملفات تُفحص لحظة الاستيراد في نافذة المعاينة.'}</p>`;
    if (!st.ledger) html += '<div class="notice">لم يُستورد الأستاذ العام بعد. اضغط «استيراد ملفات دفترة» واختر ملف «حساب الأستاذ العام للعملاء» لتفعيل المطابقة.</div>';
    html += groups.map((g) => `<h3>${escapeHtml(g)}</h3><div class="tablewrap"><table><tr><th>الفحص</th><th class="n">المرجع</th><th class="n">النظام</th><th class="n">الفرق</th><th>النتيجة</th></tr>${v.checks.filter((x) => x.group === g).map((x) => `<tr><td style="white-space:normal">${escapeHtml(x.label)}${x.note ? `<div class="muted">${escapeHtml(x.note)}</div>` : ''}</td><td class="n">${fmtv(x, x.file)}</td><td class="n">${fmtv(x, x.system)}</td><td class="n">${fmtv(x, x.diff)}</td><td>${mark(x.ok)}</td></tr>`).join('')}</table></div>`).join('');
    if (v.repRows.length) html += `<h3>مجاميع المناديب (${v.repRows.filter((r) => r.ok).length} من ${v.repRows.length} متطابقة مع ملف دفترة)</h3><div class="tablewrap" style="max-height:360px;overflow:auto"><table><tr><th>المندوب</th><th class="n">الإجمالي (ملف)</th><th class="n">(نظام)</th><th class="n">المدفوع (ملف)</th><th class="n">(نظام)</th><th class="n">غير المدفوع (ملف)</th><th class="n">(نظام)</th><th>النتيجة</th></tr>${v.repRows.map((r) => `<tr><td>${escapeHtml(r.rep)}</td>${[0, 1, 2].map((i) => `<td class="n">${money(r.file[i])}</td><td class="n">${money(r.system[i])}</td>`).join('')}<td>${r.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}</td></tr>`).join('')}</table></div>`;
  }
  $('verifyBody').innerHTML = html;
  const k = computeKpis(c.s, c.p);
  $('cmpNote').textContent = `تُقارَن الأرقام المدخلة بأرقام النظام للفلاتر الحالية: ${c.from || '—'} إلى ${c.to || '—'}.`;
  $('cmpBtn').onclick = () => {
    const val = (id) => (document.getElementById(id).value.trim() === '' ? null : toCents(document.getElementById(id).value));
    const res = compareWithDaftra(k, { sales: val('cmpSales'), paid: val('cmpPaid'), unpaid: val('cmpUnpaid'), returns: val('cmpReturns'), receipts: val('cmpReceipts') });
    $('cmpOut').innerHTML = res.length ? `<div class="tablewrap"><table><tr><th>البند</th><th class="n">دفترة</th><th class="n">النظام</th><th class="n">الفرق</th><th>النتيجة</th></tr>${res.map((x) => `<tr><td>${x.label}</td><td class="n">${money(x.official)}</td><td class="n">${money(x.system)}</td><td class="n">${money(x.diff)}</td><td>${x.ok ? '<span class="ok">✓ مطابق</span>' : '<span class="bad">✗ فرق</span>'}</td></tr>`).join('')}</table></div>` : '<span class="muted">أدخل رقماً واحداً على الأقل.</span>';
  };
}

// ---------------------------------------------------------------- targets dialog
function targetRows() {
  const reps = unique([...st.sales.filter((s) => s.total > 0).map((s) => s.rep), ...st.targets.map((t) => t.rep)]);
  const month = Number($('tMonth').value), year = Number($('tYear').value);
  $('tTable').innerHTML = `<tr><th>المندوب</th><th>هدف المبيعات (ر.س)</th><th>هدف التحصيل (ر.س)</th></tr>` + reps.map((r) => {
    const t = st.targets.find((x) => x.key === targetKey(r, month, year));
    return `<tr><td>${escapeHtml(r)}</td><td><input type="number" min="0" step="0.01" data-rep="${escapeHtml(r)}" data-f="s" value="${t ? fromCents(t.salesTarget) : ''}"></td><td><input type="number" min="0" step="0.01" data-rep="${escapeHtml(r)}" data-f="c" value="${t ? fromCents(t.collectionTarget) : ''}"></td></tr>`;
  }).join('');
}
async function saveTargets() {
  const month = Number($('tMonth').value), year = Number($('tYear').value);
  const vals = new Map();
  for (const inp of $('tTable').querySelectorAll('input')) {
    const v = vals.get(inp.dataset.rep) ?? { s: 0, c: 0 };
    v[inp.dataset.f] = inp.value === '' ? 0 : toCents(inp.value) ?? 0; vals.set(inp.dataset.rep, v);
  }
  for (const [rep, v] of vals) {
    const key = targetKey(rep, month, year);
    if (v.s === 0 && v.c === 0) await browserStore.remove('targets', key);
    else await browserStore.put('targets', { key, rep, month, year, salesTarget: v.s, collectionTarget: v.c });
  }
  st.targets = await browserStore.loadAll('targets');
  $('tMsg').textContent = `تم حفظ أهداف ${MONTHS[month - 1]} ${year}`;
  render();
}

// ---------------------------------------------------------------- settings dialog
function settingsRows() {
  const reps = unique([...allRepNames(), ...st.meta.keys()]);
  $('regionOpts').innerHTML = unique([...st.meta.values()].map((m) => m.region).filter(Boolean)).map((x) => `<option value="${escapeHtml(x)}">`).join('');
  $('posOpts').innerHTML = unique([...st.meta.values()].map((m) => m.position).filter(Boolean)).map((x) => `<option value="${escapeHtml(x)}">`).join('');
  $('sTable').innerHTML = `<tr><th>المندوب</th><th>المنطقة</th><th>المنصب</th></tr>` + reps.map((r) => {
    const m = st.meta.get(r) ?? {};
    return `<tr><td>${escapeHtml(r)}</td><td><input type="text" list="regionOpts" data-rep="${escapeHtml(r)}" data-f="region" value="${escapeHtml(m.region ?? '')}"></td><td><input type="text" list="posOpts" data-rep="${escapeHtml(r)}" data-f="position" value="${escapeHtml(m.position ?? '')}"></td></tr>`;
  }).join('');
  $('sName').value = st.system.name; $('sLogo').value = st.system.logo;
}
async function saveSettings() {
  const by = new Map();
  for (const inp of $('sTable').querySelectorAll('input')) {
    const o = by.get(inp.dataset.rep) ?? { key: inp.dataset.rep, rep: inp.dataset.rep, region: '', position: '' };
    o[inp.dataset.f] = inp.value.trim(); by.set(inp.dataset.rep, o);
  }
  for (const o of by.values()) await browserStore.put('repSettings', o);
  await browserStore.put('repSettings', { key: SYSTEM_KEY, name: $('sName').value.trim() || 'NEXUS Dashboard', logo: $('sLogo').value.trim() });
  await loadMeta(); applySystem(); renderMsels(); render();
  $('sMsg').textContent = 'تم حفظ الإعدادات';
}
function applySystem() {
  $('sysName').textContent = st.system.name; document.title = st.system.name;
  const old = document.getElementById('sysLogo'); old?.remove();
  if (st.system.logo) { const img = Object.assign(document.createElement('img'), { id: 'sysLogo', src: st.system.logo, alt: '', height: 28 }); img.style.cssText = 'vertical-align:middle;margin-inline-end:8px'; $('sysName').before(img); }
}
async function loadMeta() {
  const rows = await browserStore.loadAll('repSettings');
  st.meta = new Map(rows.filter((r) => r.key !== SYSTEM_KEY).map((r) => [r.rep, { region: r.region ?? '', position: r.position ?? '' }]));
  const sys = rows.find((r) => r.key === SYSTEM_KEY);
  if (sys) st.system = { name: sys.name, logo: sys.logo };
}

// ---- backup / restore
async function backup() {
  const data = { app: 'nexus', version: NEXUS_VERSION, at: new Date().toISOString() };
  for (const n of ['sales', 'payments', 'repSettings', 'targets']) data[n] = await browserStore.loadAll(n);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })), download: `nexus-backup-${today()}.json` });
  document.body.append(a); a.click(); a.remove();
}
async function restore(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'nexus') throw new Error('الملف ليس نسخة احتياطية من النظام');
  if (!confirm(`استرجاع ${int(data.sales.length)} فاتورة و${int(data.payments.length)} سنداً؟ سيتم تحديث السجلات المطابقة ولن يُحذف شيء.`)) return;
  await browserStore.upsert('sales', data.sales); await browserStore.upsert('payments', data.payments);
  for (const r of data.repSettings) await browserStore.put('repSettings', r);
  for (const t of data.targets) await browserStore.put('targets', t);
  await loadMeta(); await refresh(true);
}

// ---------------------------------------------------------------- boot
function decodeSeed(d) {
  const FLAGS = [[1, 'overpaid'], [2, 'discrepancy'], [4, 'negative_total_with_payment']];
  return {
    sales: d.sales.map((r) => ({ key: r[0], number: r[1], date: r[2], rep: d.reps[r[3]], customer: d.customers[r[4]], total: r[5], paid: r[6], unpaid: r[7], returns: r[8], flags: FLAGS.filter(([b]) => r[9] & b).map(([, n]) => n), status: d.statuses?.[r[10]] ?? '' })),
    payments: d.payments.map((r) => ({ key: r[0], number: r[1], invoice: r[2], date: r[3], rep: d.reps[r[4]], customer: d.customers[r[5]], method: r[6], amount: r[7] })),
  };
}

async function refresh(resetRange = false) {
  [st.sales, st.payments, st.targets] = await Promise.all([browserStore.loadAll('sales'), browserStore.loadAll('payments'), browserStore.loadAll('targets')]);
  await loadMeta(); applySystem();
  const metaRows = await browserStore.loadAll('meta');
  st.ledger = metaRows.find((m) => m.key === 'ledger')?.data ?? null;
  st.controls = metaRows.find((m) => m.key === 'controls')?.data ?? null;
  const dates = [...st.sales, ...st.payments].map((r) => r.date).sort();
  if (resetRange || (!$('from').value && dates.length)) { $('from').value = dates[0] ?? ''; $('to').value = dates.at(-1) ?? ''; }
  const logs = await browserStore.lastImports();
  $('log').innerHTML = `<tr><th>الوقت</th><th>المستخدم</th><th>الملف</th><th>النوع</th><th class="n">أُضيف</th><th class="n">حُدّث</th><th class="n">مرفوض</th></tr>` +
    (logs.map((l) => `<tr><td>${escapeHtml(l.at.replace('T', ' ').slice(0, 16))}</td><td>${escapeHtml(l.user)}</td><td>${escapeHtml(l.file)}</td><td>${l.kind === 'invoices' ? 'فواتير' : l.kind === 'ledger' ? 'الأستاذ' : 'مدفوعات'}</td><td class="n">${int(l.added)}</td><td class="n">${int(l.updated)}</td><td class="n">${l.rejected}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">لا توجد عمليات بعد</td></tr>');
  renderMsels(); render();
}

$('importBtn').onclick = () => { $('preview').innerHTML = ''; $('files').value = ''; $('saveBtn').disabled = true; st.pending = []; $('dlg').showModal(); };
$('cancelBtn').onclick = () => $('dlg').close();
$('files').onchange = (e) => previewFiles([...e.target.files]);
$('saveBtn').onclick = saveImport;
$('from').onchange = $('to').onchange = render;
$('allBtn').onclick = () => { const d = [...st.sales, ...st.payments].map((r) => r.date).sort(); $('from').value = d[0] ?? ''; $('to').value = d.at(-1) ?? ''; render(); };
$('clearBtn').onclick = async () => { if (confirm('حذف الفواتير والسندات المحفوظة في هذا المتصفح؟ (الأهداف والإعدادات تبقى). تأكد من أخذ نسخة احتياطية أولاً.')) { await browserStore.clear(); await refresh(true); } };
$('printBtn').onclick = () => window.print();
const THEME_KEY = 'nexus-theme';
const setTheme = (t) => { document.documentElement.dataset.theme = t; try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ } };
try { const t = localStorage.getItem(THEME_KEY); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
$('themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(dark ? 'light' : 'dark'); render();
};
$('tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  st.tab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach((x) => x.classList.toggle('on', x.id === `pane-${st.tab}`));
  render();
};
$('agingQ').oninput = $('invQ').oninput = $('payQ').oninput = () => { st.invLimit = st.payLimit = 300; render(); };
$('invMore').onclick = () => { st.invLimit += 500; render(); };
$('payMore').onclick = () => { st.payLimit += 500; render(); };
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]'); if (b) EXPORTS[b.dataset.export]?.(b.dataset.fmt || 'csv');
  document.querySelectorAll('details.msel[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
});

$('tMonth').innerHTML = MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
$('targetsBtn').onclick = () => {
  const to = $('to').value || today();
  $('tMonth').value = Number(to.slice(5, 7)); $('tYear').value = Number(to.slice(0, 4)); $('tMsg').textContent = '';
  targetRows(); $('targetsDlg').showModal();
};
$('tMonth').onchange = $('tYear').onchange = targetRows;
$('tSave').onclick = saveTargets; $('tClose').onclick = () => $('targetsDlg').close();
$('settingsBtn').onclick = () => { $('sMsg').textContent = ''; settingsRows(); $('settingsDlg').showModal(); };
$('sSave').onclick = saveSettings; $('sClose').onclick = () => $('settingsDlg').close();
$('backupBtn').onclick = backup;
$('restoreFile').onchange = async (e) => { try { await restore(e.target.files[0]); $('sMsg').textContent = 'تم الاسترجاع'; } catch (err) { $('sMsg').textContent = err.message; } e.target.value = ''; };

(async () => {
  const seedEl = document.getElementById('nexus-seed');
  if (seedEl && (await browserStore.loadAll('sales')).length === 0) {
    const seed = decodeSeed(JSON.parse(seedEl.textContent));
    await browserStore.upsert('sales', seed.sales); await browserStore.upsert('payments', seed.payments);
    const m = JSON.parse(seedEl.textContent).meta;
    if (m?.ledger) await browserStore.put('meta', { key: 'ledger', at: new Date().toISOString(), file: '(مضمَّن في الملف)', data: m.ledger });
    if (m?.controls) await browserStore.put('meta', { key: 'controls', data: { ...m.controls, nSales: seed.sales.length, nPayments: seed.payments.length } });
    $('notice').textContent = 'تم تحميل بياناتك الحقيقية مرة واحدة من الملف إلى هذا المتصفح. التعديلات (الأهداف والإعدادات) تُحفظ هنا.';
  }
  await refresh(true);
})();
