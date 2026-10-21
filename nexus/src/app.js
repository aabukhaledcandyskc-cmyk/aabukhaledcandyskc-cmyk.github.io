import { parseCsv } from './csv.js';
import { parseInvoices, parsePayments, detectKind } from './daftra.js';
import { browserStore } from './store.js';
import {
  computeKpis, repSummary, totalsRow, sortRows, monthlyBreakdown, filterByPeriod, weeklyTrend, allowedReps, restrictToReps,
  monthsInRange, targetsByRep, targetKey, progressPct, agingByCustomer,
  firstInvoices, newCustomersByRep, newCustomersUnreliable, topCustomers,
} from './kpi.js';
import { toCents, fromCents } from './shared.js';
import { parseLedger } from './ledger.js';
import { buildChecks, compactLedger, compareWithDaftra } from './verify.js';
import { rowsFromWorkbook, workbookFromRows } from './excel.js';
import { previousPeriod, deltaPct, presetRange, topWithOthers, insights, repInsights, reportMode } from './report.js';
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
  sel: { reps: new Set(), regions: new Set(), positions: new Set(), statuses: new Set() }, ledger: null, theme: null, first: new Map(), badge: null,
  tab: 'report', view: 'auto', repSort: { key: 'sales', dir: 'desc' }, invLimit: 300, payLimit: 300, pending: [], charts: {},
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

function sliceRows(from, to, allowed) {
  const stSel = st.sel.statuses;
  return {
    s: restrictToReps(filterByPeriod(st.sales, { from, to }), allowed).filter((r) => !stSel.size || stSel.has(r.status ?? '')),
    p: restrictToReps(filterByPeriod(st.payments, { from, to }), allowed),
  };
}
function current() {
  const from = $('from').value, to = $('to').value;
  const allowed = allowedReps(allRepNames(), st.meta, st.sel);
  return { from, to, allowed, ...sliceRows(from, to, allowed) };
}
const dataRange = () => {
  const d = [...st.sales, ...st.payments].map((r) => r.date).sort();
  return { start: d[0] ?? '', end: d.at(-1) ?? '' };
};

// ---------------------------------------------------------------- rendering
const progress = (pct) => (pct === null ? '<span class="muted">—</span>'
  : `<div class="prog"><div class="track"><div class="fill ${pct > 100 ? 'over' : ''}" style="width:${Math.min(100, pct)}%"></div></div><span class="pct">${+pct.toFixed(1)}%</span></div>`);

function render() {
  document.body.dataset.tab = st.tab; // lets the print stylesheet know which tab is on paper
  markPreset();
  document.querySelectorAll('#viewMode [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === st.view));
  const c = current();
  const k = computeKpis(c.s, c.p);
  const newBy = newCustomersByRep(st.first, { from: c.from, to: c.to }, c.allowed);
  const totalNew = [...newBy.values()].reduce((a, x) => a + x, 0);
  const newUnreliable = newCustomersUnreliable(st.sales, c.from);
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
    card('عملاء جدد', int(totalNew), newUnreliable ? '⚠ الفترة قريبة من بداية بياناتك، فيُحسب أغلب العملاء جدداً' : 'أول فاتورة للعميل ضمن الفترة'),
  ].join('') + (k.discrepancies ? card('تناقضات', int(k.discrepancies), 'total ≠ paid+unpaid+returns') : '');

  const tmap = targetsByRep(st.targets, c.allowed, monthsInRange(c.from, c.to));
  const tSales = [...tmap.values()].reduce((a, t) => a + t.sales, 0), tColl = [...tmap.values()].reduce((a, t) => a + t.collection, 0);
  $('targetCards').innerHTML = (tSales || tColl) ? [
    ['هدف المبيعات', tSales, k.sales], ['هدف التحصيل (المقبوضات)', tColl, k.receipts],
  ].map(([l, t, a]) => `<div class="card"><div class="l">${l}</div><div class="s">المستهدف ${money(t)} — الفعلي ${money(a)}</div>${progress(progressPct(a, t))}</div>`).join('') : '';

  const reps = repSummary(c.s, c.p);
  renderRepTable(reps, tmap, newBy);
  const low = reps.filter((r) => r.sales > 0 && r.paidPct < 50);
  $('alerts').innerHTML = low.length ? `<div class="notice">تنبيه: نسبة التحصيل أقل من 50% عند: ${low.map((r) => `${escapeHtml(r.rep)} (${r.paidPct.toFixed(1)}%)`).join('، ')}</div>` : '';
  if (st.tab === 'summary') renderCharts(reps, weeklyTrend(c.s, c.p));
  $('rangeInfo').textContent = st.sales.length ? `${int(c.s.length)} صف مبيعات، ${int(c.p.length)} سند ضمن الفلاتر` : '';
  renderPrintHead(c);
  renderPane(c);
}

const pctText = (v) => (v === null ? '<span class="muted">—</span>' : `${v.toFixed(1)}%`);
// Table layout follows Daftra's employee report: a two-level header where «المبيعات» splits into paid / unpaid.
const REP_COLS = [
  { key: 'sales', label: 'الإجمالي' }, { key: 'paid', label: 'مدفوعة' }, { key: 'unpaid', label: 'غير مدفوعة' },
];
function sortTh(key, label, extra = '') {
  const on = st.repSort.key === key;
  const arrow = on ? (st.repSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return `<th class="sortable ${extra}" data-sort="${key}" tabindex="0" role="columnheader" aria-sort="${on ? (st.repSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${label}${arrow}</th>`;
}
function renderRepTable(reps, tmap, newBy) {
  const rows = sortRows(reps.map((r) => ({ ...r, newCust: newBy.get(r.rep) ?? 0, ...(st.meta.get(r.rep) ?? {}), tSales: progressPct(r.sales, tmap.get(r.rep)?.sales ?? 0), tColl: progressPct(r.receipts, tmap.get(r.rep)?.collection ?? 0) })), st.repSort.key, st.repSort.dir);
  const tot = { ...totalsRow(reps), newCust: [...newBy.values()].reduce((a, x) => a + x, 0) };
  const hasTargets = tmap.size > 0;
  const line = (r, isTotal) => `<tr class="${isTotal ? 'total' : ''}"><td>${isTotal ? '<b>الإجمالي</b>' : `<button class="link" data-rep="${escapeHtml(r.rep)}" aria-label="بطاقة ${escapeHtml(r.rep)}">${escapeHtml(r.rep)}</button>`}</td>
    <td class="n">${money(r.sales)}</td><td class="n">${money(r.paid)}</td><td class="n">${money(r.unpaid)}</td><td class="n">${money(r.receipts)}</td>
    <td class="n ${!isTotal && r.paidPct < 50 ? 'low' : ''}">${r.paidPct.toFixed(1)}%</td><td class="n">${int(r.invoices)}</td><td class="n">${int(r.newCust)}</td><td class="n">${pctText(r.returnRate)}</td>
    <td>${isTotal ? '' : escapeHtml(r.region ?? '')}</td><td>${isTotal ? '' : escapeHtml(r.position ?? '')}</td>
    <td>${isTotal ? '' : progress(hasTargets ? r.tSales : null)}</td><td>${isTotal ? '' : progress(hasTargets ? r.tColl : null)}</td></tr>`;
  $('reps').innerHTML = `<thead>
    <tr><th rowspan="2" class="sortable" data-sort="rep" tabindex="0" aria-sort="${st.repSort.key === 'rep' ? (st.repSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">الموظف / المندوب <span class="muted">(اضغط لعرض البطاقة)</span>${st.repSort.key === 'rep' ? (st.repSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>
      <th colspan="3" class="grp">المبيعات</th>
      ${sortTh('receipts', 'التحصيلات المسجلة', 'n').replace('<th ', '<th rowspan="2" ')}
      ${sortTh('paidPct', 'نسبة التحصيل', 'n').replace('<th ', '<th rowspan="2" title="المدفوع من فواتير الفترة ÷ إجمالي المبيعات. التحصيلات المسجلة تشمل سندات فواتير فترات سابقة، لذلك قد تختلف عنه." ')}
      ${sortTh('invoices', 'عدد الفواتير', 'n').replace('<th ', '<th rowspan="2" ')}
      ${sortTh('newCust', 'عملاء جدد', 'n').replace('<th ', '<th rowspan="2" title="عملاء كانت أول فاتورة لهم ضمن الفترة، وتُنسب للمندوب الذي أصدرها. تعتمد على الفواتير المستوردة فقط." ')}
      ${sortTh('returnRate', 'معدل المرتجعات', 'n').replace('<th ', '<th rowspan="2" title="المرتجعات (مجموع عمود المرتجع الخام) ÷ مبيعات الفواتير الموجبة. قد يظهر سالباً إذا سُجّلت فاتورة المرتجع عند مندوب أو في فترة غير فاتورتها الأصلية." ')}
      <th colspan="4" class="grp">التصنيف والأهداف</th></tr>
    <tr>${REP_COLS.map((c) => sortTh(c.key, c.label, 'n sub')).join('')}
      ${sortTh('region', 'المنطقة', 'sub')}${sortTh('position', 'المنصب', 'sub')}${sortTh('tSales', 'هدف المبيعات', 'sub')}${sortTh('tColl', 'هدف التحصيل', 'sub')}</tr></thead>
    <tbody>${rows.map((r) => line(r, false)).join('') || '<tr><td colspan="13" class="muted">لا توجد بيانات — استورد ملفات دفترة أولاً</td></tr>'}</tbody>
    ${rows.length ? `<tfoot>${line(tot, true)}</tfoot>` : ''}`;
}

function openRepCard(rep) {
  const c = current();
  const s = c.s.filter((r) => r.rep === rep), p = c.p.filter((r) => r.rep === rep);
  const k = computeKpis(s, p), m = st.meta.get(rep) ?? {};
  const gross = s.filter((x) => x.total > 0).reduce((a, x) => a + x.total, 0);
  const aging = agingByCustomer(s, c.to || today()).slice(0, 10);
  const recent = [...s].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 15);
  const card = (l, v, sub = '') => `<div class="card"><div class="l">${l}</div><div class="v" style="font-size:18px">${v}</div><div class="s">${sub}</div></div>`;
  $('repCardTitle').textContent = rep;
  $('repCardMeta').textContent = [m.region, m.position].filter(Boolean).join(' — ') + ` — الفترة ${c.from || '—'} إلى ${c.to || '—'}`;
  $('repCardBody').innerHTML = `<div class="grid">${[
    card('إجمالي المبيعات', money(k.sales)), card('مدفوعة', money(k.paid), `${k.paidPct.toFixed(1)}%`), card('غير مدفوعة', money(k.unpaid)),
    card('التحصيلات المسجلة', money(k.receipts)), card('عدد الفواتير', int(k.invoiceCount)), card('العملاء النشطون', int(k.activeCustomers)),
    card('عملاء جدد', int(newCustomersByRep(st.first, { from: c.from, to: c.to }, new Set([rep])).get(rep) ?? 0), 'أول فاتورة ضمن الفترة'),
    card('معدل المرتجعات', gross > 0 ? `${((k.returns / gross) * 100).toFixed(1)}%` : '—', `المرتجعات ${money(k.returns)}`),
  ].join('')}</div>
  <h3>الأداء الشهري</h3><div class="tablewrap" style="max-height:240px;overflow:auto"><table><tr><th>الشهر</th><th class="n">المبيعات</th><th class="n">مدفوعة</th><th class="n">غير مدفوعة</th><th class="n">المقبوضات</th><th class="n">الفواتير</th></tr>${monthlyBreakdown(s, p).map((x) => `<tr><td>${x.month}</td><td class="n">${money(x.sales)}</td><td class="n">${money(x.paid)}</td><td class="n">${money(x.unpaid)}</td><td class="n">${money(x.receipts)}</td><td class="n">${int(x.invoices)}</td></tr>`).join('')}</table></div>
  <h3>أعلى 10 عملاء مدينية</h3><div class="tablewrap"><table><tr><th>العميل</th><th class="n">الرصيد</th><th class="n">أكثر من 90 يوماً</th></tr>${aging.map((x) => `<tr><td>${escapeHtml(x.customer)}</td><td class="n">${money(x.net)}</td><td class="n ${x.b90 ? 'low' : ''}">${money(x.b90)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">لا أرصدة مدينة</td></tr>'}</table></div>
  <h3>آخر 15 فاتورة</h3><div class="tablewrap"><table><tr><th>التاريخ</th><th>الرقم</th><th>العميل</th><th class="n">الإجمالي</th><th class="n">غير المدفوع</th></tr>${recent.map((x) => `<tr><td>${x.date}</td><td>${escapeHtml(x.number)}</td><td>${escapeHtml(x.customer)}</td><td class="n">${money(x.total)}</td><td class="n">${money(x.unpaid)}</td></tr>`).join('')}</table></div>`;
  $('repCard').showModal();
}

const fmtMonth = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function chip(cur, prev, goodWhenUp = true, points = false) {
  if (prev === null || prev === undefined) return '<span class="dchip none">&nbsp;</span>'; // no previous period: stay quiet, the footer explains
  if (!points && (cur < 0 || prev < 0)) return '<span class="dchip flat">—</span>'; // % change of a negative balance is meaningless
  const d = points ? cur - prev : deltaPct(cur, prev);
  if (d === null) return '<span class="dchip flat">—</span>';
  if (Math.abs(d) < 0.05) return '<span class="dchip flat">بلا تغيّر</span>';
  const good = (d > 0) === goodWhenUp;
  return `<span class="dchip ${good ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}${points ? ' نقطة' : '%'}</span>`;
}

// The report's panels are moved between pages: three pages for the company view, one dense page for a few reps.
const PANEL_IDS = ['pInsights', 'pRepChart', 'pTrend', 'pTable', 'pDebt', 'pTop', 'rFoot'];
const PANEL = Object.fromEntries(PANEL_IDS.map((id) => [id, document.getElementById(id)]));
const put = (id, ...els) => document.getElementById(id).replaceChildren(...els);
function applyLayout(compact, nReps) {
  $('report').classList.toggle('compact', compact);
  if (compact) {
    put('colsA', PANEL.pInsights, PANEL.pTrend);
    put('slotTrend', PANEL.pRepChart);                       // parked on the hidden page
    if (nReps > 1) { put('slotTable1', PANEL.pTable); put('slotTable'); } else { put('slotTable1'); put('slotTable', PANEL.pTable); }
    put('colsB', PANEL.pDebt, PANEL.pTop); put('colsC');
    put('footSlot1', PANEL.rFoot); put('footSlot3');
  } else {
    put('colsA', PANEL.pInsights, PANEL.pRepChart);
    put('slotTrend', PANEL.pTrend); put('slotTable', PANEL.pTable); put('slotTable1');
    put('colsB'); put('colsC', PANEL.pDebt, PANEL.pTop);
    put('footSlot1'); put('footSlot3', PANEL.rFoot);
  }
}

function renderReport(c) {
  const k = computeKpis(c.s, c.p);
  const reps = repSummary(c.s, c.p);
  const nReps = reps.filter((r) => r.sales !== 0 || r.receipts !== 0 || r.invoices > 0).length;
  const compact = reportMode(st.view, nReps) === 'compact';
  applyLayout(compact, nReps);
  const single = compact && nReps === 1;
  const { start, end } = dataRange();
  const prev = previousPeriod(c.from, c.to, start);
  const pk = prev ? computeKpis(...Object.values(sliceRows(prev.from, prev.to, c.allowed))) : null;
  const f = (set) => (set.size ? [...set].map((x) => x || 'غير محدد').join('، ') : 'الكل');
  const sub = `الفترة: من <bdi dir="ltr">${c.from || '—'}</bdi> إلى <bdi dir="ltr">${c.to || '—'}</bdi> · المناديب: ${escapeHtml(f(st.sel.reps))} · المناطق: ${escapeHtml(f(st.sel.regions))} · المناصب: ${escapeHtml(f(st.sel.positions))}`;
  $('rTitle').textContent = single ? `${st.system.name} — تقرير المندوب: ${reps.find((r) => r.sales !== 0 || r.receipts !== 0 || r.invoices > 0).rep}` : `${st.system.name} — تقرير أداء المبيعات والتحصيل`;
  for (const id of ['rSub', 'rSub2', 'rSub3']) $(id).innerHTML = sub;
  const stamp = new Date().toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
  const b = st.badge;
  $('rMeta').innerHTML = `طُبع <bdi dir="ltr">${stamp}</bdi><br>${b ? `<span class="${b.ok ? 'vok' : 'vbad'}">${b.ok ? '✓' : '⚠'} ${escapeHtml(b.text)}</span>` : ''}`;

  const tile = (l, v, d) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div>${d}</div>`;
  $('rHero').innerHTML = [
    tile('إجمالي المبيعات', money(k.sales), chip(k.sales, pk?.sales)),
    tile('إجمالي المقبوضات', money(k.receipts), chip(k.receipts, pk?.receipts)),
    tile('نسبة التحصيل', `${k.paidPct.toFixed(1)}%`, chip(k.paidPct, pk ? pk.paidPct : null, true, true)),
    tile('غير المدفوع', money(k.unpaid), chip(k.unpaid, pk?.unpaid, false)),
    tile('عدد الفواتير', int(k.invoiceCount), chip(k.invoiceCount, pk?.invoiceCount)),
  ].join('');

  const newBy = newCustomersByRep(st.first, { from: c.from, to: c.to }, c.allowed);
  const totalNew = [...newBy.values()].reduce((a, x) => a + x, 0);
  const unreliable = newCustomersUnreliable(st.sales, c.from);
  const tmap = targetsByRep(st.targets, c.allowed, monthsInRange(c.from, c.to));
  const tSales = [...tmap.values()].reduce((a, t) => a + t.sales, 0);
  const mini = (l, v, sub = '') => `<div class="mini"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  $('rMinis').innerHTML = [
    mini('العملاء النشطون', int(k.activeCustomers)),
    mini('متوسط الفاتورة', money(k.avgInvoice)),
    mini('المرتجعات', money(k.returns), 'مجموع عمود المرتجع'),
    unreliable ? mini('عملاء جدد', '—', 'الفترة تلامس بداية البيانات') : mini('عملاء جدد', int(totalNew), 'أول فاتورة ضمن الفترة'),
    ...(tSales > 0 ? [mini('تحقيق هدف المبيعات', `${+progressPct(k.sales, tSales).toFixed(1)}%`, `من ${money(tSales)}`)] : []),
  ].join('');

  const total = totalsRow(reps);
  const monthly = monthlyBreakdown(c.s, c.p);
  const debtors = agingByCustomer(c.s, c.to || today());
  const fmtI = { money, pct: (p) => `${p.toFixed(1)}%`, month: fmtMonth };
  let list;
  if (single) {
    const co = sliceRows(c.from, c.to, null), coK = computeKpis(co.s, co.p), coReps = repSummary(co.s, co.p).filter((r) => r.sales > 0);
    const me = reps.find((r) => r.sales !== 0 || r.receipts !== 0 || r.invoices > 0).rep;
    list = repInsights({ rep: me, k, pk, company: { sales: coK.sales, paidPct: coK.paidPct }, rank: Math.max(1, coReps.findIndex((r) => r.rep === me) + 1), repCount: coReps.length, newCust: totalNew, monthly, debtors, overpaid: k.overpaid }, fmtI);
  } else list = insights({ reps, totals: k, prevTotals: pk, monthly, debtors, overpaid: k.overpaid }, fmtI);
  $('rInsights').innerHTML = list
    .map((i) => `<li class="${i.kind}">${escapeHtml(i.text)}</li>`).join('') || '<li class="muted">لا توجد بيانات كافية.</li>';
  const nList = compact ? 7 : 10;
  $('rDebtTitle').textContent = `أكبر ${nList} عملاء مدينية`; $('rTopTitle').textContent = `أكبر ${nList} عملاء مبيعاً`;

  // table: top 14 + folded rest + total
  const rows = topWithOthers(reps, compact ? (nReps <= 3 ? 3 : 6) : 14);
  const share = (r) => (total.sales > 0 ? `${((r.sales / total.sales) * 100).toFixed(1)}%` : '—');
  const line = (r, tot) => `<tr class="${tot ? 'total' : ''}"><td>${escapeHtml(r.rep)}</td><td class="n">${money(r.sales)}</td><td class="n">${money(r.paid)}</td><td>${progress(r.sales > 0 ? (r.paid / r.sales) * 100 : null)}</td><td class="n">${money(r.unpaid)}</td><td class="n">${money(r.receipts)}</td><td class="n">${int(r.invoices)}</td><td class="n">${tot ? '100%' : share(r)}</td></tr>`;
  $('rTable').innerHTML = `<tr><th>المندوب</th><th class="n">المبيعات</th><th class="n">المحصَّل من الفواتير</th><th>نسبة التحصيل</th><th class="n">غير المدفوع</th><th class="n">المقبوضات</th><th class="n">الفواتير</th><th class="n">حصته</th></tr>${rows.map((r) => line(r, false)).join('')}${line({ ...total, rep: 'الإجمالي' }, true)}`;

  $('rDebt').innerHTML = `<tr><th>#</th><th>العميل</th><th class="n">الرصيد</th><th class="n">أكثر من 90 يوماً</th></tr>${debtors.slice(0, nList).map((x, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(x.customer)}</td><td class="n"><b>${money(x.net)}</b></td><td class="n ${x.b90 ? 'low' : ''}">${money(x.b90)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا أرصدة مدينة</td></tr>'}`;
  $('rDebtNote').textContent = `الأعمار حتى ${c.to || today()}. عدد العملاء المدينين: ${int(debtors.length)}.`;
  $('rTop').innerHTML = `<tr><th>#</th><th>العميل</th><th class="n">المبيعات</th><th class="n">الفواتير</th></tr>${topCustomers(c.s, nList).map((x, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(x.customer)}</td><td class="n"><b>${money(x.sales)}</b></td><td class="n">${int(x.invoices)}</td></tr>`).join('')}`;
  $('rFoot').innerHTML = `المصدر: تقارير دفترة المستوردة (${int(st.sales.length)} صف مبيعات، ${int(st.payments.length)} سند). التحصيل = المدفوع ÷ المبيعات، والمقبوضات تشمل سندات فواتير فترات سابقة. ${prev ? `المقارنة مع الفترة السابقة <bdi dir="ltr">${prev.from}</bdi> إلى <bdi dir="ltr">${prev.to}</bdi>.` : 'لا مقارنة: لا توجد بيانات للفترة السابقة.'}`;

  renderReportCharts(reps, monthly, weeklyTrend(c.s, c.p), compact);
}

function renderReportCharts(reps, monthly, trend, onePage) {
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const pick = (v, fallback) => (st.printing ? fallback : css.getPropertyValue(v).trim());
  const text = pick('--text', '#111'), grid = pick('--line', '#d5d9e0'), accent = pick('--accent', '#0f766e'), warn = pick('--warn', '#b45309');
  const size = st.printing ? 10 : document.body.classList.contains('presenting') ? 16 : 13;
  // only pass a tick callback when there is one: an explicit `undefined` would replace the category labels
  const axis = (cb) => ({ ticks: { color: text, font: { size }, ...(cb ? { callback: cb } : {}) }, grid: { color: grid } });
  const base = { responsive: true, maintainAspectRatio: false, animation: st.printing ? false : undefined, plugins: { legend: { labels: { color: text, font: { size }, boxWidth: 14 } } } };
  st.charts.rRep?.destroy(); st.charts.rMonth?.destroy();
  const top = topWithOthers(reps, 8);
  if (!onePage) st.charts.rRep = new window.Chart($('rRepChart'), { type: 'bar', data: { labels: top.map((r) => r.rep), datasets: [
    { label: 'المبيعات', data: top.map((r) => r.sales / 100), backgroundColor: accent, borderRadius: 3 },
    { label: 'المحصَّل', data: top.map((r) => r.paid / 100), backgroundColor: warn, borderRadius: 3 }] },
  options: { ...base, indexAxis: 'y', scales: { x: axis((v) => compact.format(v)), y: { ...axis(), grid: { display: false } } } } });
  // a "monthly" chart with 1-2 months is just a couple of fat bars: switch to weeks for short periods
  const weekly = monthly.length < 3;
  const series = weekly ? trend.map((w) => ({ label: w.week, sales: w.sales, receipts: w.receipts })) : monthly.map((m) => ({ label: fmtMonth(m.month), sales: m.sales, receipts: m.receipts }));
  $('rTrendTitle').textContent = weekly ? 'الاتجاه الأسبوعي: المبيعات والمقبوضات (بداية الأسبوع)' : 'الاتجاه الشهري: المبيعات والمقبوضات';
  st.charts.rMonth = new window.Chart($('rMonthChart'), { type: 'bar', data: { labels: series.map((m) => m.label), datasets: [
    { label: 'المبيعات', data: series.map((m) => m.sales / 100), backgroundColor: accent, borderRadius: 3 },
    { label: 'المقبوضات', data: series.map((m) => m.receipts / 100), backgroundColor: warn, borderRadius: 3 }] },
  options: { ...base, scales: { x: { ...axis(), grid: { display: false } }, y: axis((v) => compact.format(v)) } } });
}

const TAB_TITLE = { report: 'التقرير', summary: 'تحليل تفصيلي', aging: 'أكبر العملاء مدينية', invoices: 'الفواتير', payments: 'السندات', verify: 'التحقق من الأرقام' };
// Report header shown only on paper: who/what/when, and which filters produced the numbers.
function renderPrintHead(c) {
  const f = (set, all) => (set.size ? [...set].map((x) => x || 'غير محدد').join('، ') : all);
  const logo = st.system.logo ? `<img src="${escapeHtml(st.system.logo)}" alt="" height="30" style="vertical-align:middle;margin-inline-end:8px">` : '';
  $('printHead').innerHTML = `<div class="t">${logo}${escapeHtml(st.system.name)} — ${TAB_TITLE[st.tab]}</div>
    <div class="m">الفترة: من <bdi dir="ltr">${c.from || '—'}</bdi> إلى <bdi dir="ltr">${c.to || '—'}</bdi> &nbsp;|&nbsp; المناديب: ${escapeHtml(f(st.sel.reps, 'الكل'))} &nbsp;|&nbsp; المناطق: ${escapeHtml(f(st.sel.regions, 'الكل'))} &nbsp;|&nbsp; المناصب: ${escapeHtml(f(st.sel.positions, 'الكل'))}</div>
    <div class="m">طُبع في <bdi dir="ltr">${new Date().toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</bdi> &nbsp;|&nbsp; الإصدار ${NEXUS_VERSION}</div>`;
}

function renderCharts(reps, trend) {
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const light = st.printing; // paper is always white, so draw the charts with the light palette
  const text = light ? '#111' : css.getPropertyValue('--text').trim(), grid = light ? '#d5d9e0' : css.getPropertyValue('--line').trim();
  const accent = light ? '#0f766e' : css.getPropertyValue('--accent').trim(), warn = light ? '#b45309' : css.getPropertyValue('--warn').trim();
  const fmt = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const common = { responsive: true, maintainAspectRatio: false, animation: light ? false : undefined, plugins: { legend: { labels: { color: text } } } };
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
  if (st.tab === 'report') renderReport(c);
  else if (st.tab === 'verify') renderVerify(c);
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

function computeBadge() {
  if (!st.sales.length) return null;
  const controls = st.controls && st.controls.nSales === st.sales.length && st.controls.nPayments === st.payments.length ? st.controls : null;
  if (!controls && !st.ledger) return null;
  const v = buildChecks({ sales: st.sales, payments: st.payments, controls: controls ?? {}, ledger: st.ledger });
  const failed = v.checks.filter((x) => x.ok === false).length + v.repRows.filter((r) => !r.ok).length;
  const n = v.checks.filter((x) => x.ok !== null).length + v.repRows.length;
  return failed ? { ok: false, text: `${failed} فحص لا يطابق مصادر دفترة` } : { ok: true, text: `الأرقام مطابقة لملفات دفترة (${n} فحصاً)` };
}

async function refresh(resetRange = false) {
  [st.sales, st.payments, st.targets] = await Promise.all([browserStore.loadAll('sales'), browserStore.loadAll('payments'), browserStore.loadAll('targets')]);
  await loadMeta(); applySystem();
  st.first = firstInvoices(st.sales);
  const metaRows = await browserStore.loadAll('meta');
  st.ledger = metaRows.find((m) => m.key === 'ledger')?.data ?? null;
  st.controls = metaRows.find((m) => m.key === 'controls')?.data ?? null;
  st.badge = computeBadge();
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
$('viewMode').onclick = (e) => { const b = e.target.closest('[data-view]'); if (b) { st.view = b.dataset.view; render(); } };
$('presets').onclick = (e) => {
  const b = e.target.closest('[data-preset]'); if (!b) return;
  const { start, end } = dataRange();
  const r = presetRange(b.dataset.preset, start, end);
  if (r) { $('from').value = r.from; $('to').value = r.to; render(); }
};
function markPreset() {
  const { start, end } = dataRange();
  document.querySelectorAll('#presets [data-preset]').forEach((b) => {
    const r = presetRange(b.dataset.preset, start, end);
    b.classList.toggle('on', !!r && r.from === $('from').value && r.to === $('to').value);
  });
}
// presentation mode: browser full screen, only the three report pages, arrow keys / Space to move between them
function setPresenting(on) {
  document.body.classList.toggle('presenting', on); document.documentElement.classList.toggle('presenting', on);
  if (on && st.tab !== 'report') document.querySelector('#tabs [data-tab=report]').click();
  setTimeout(render, 50);
}
$('presentBtn').onclick = async () => {
  setPresenting(true);
  try { await document.documentElement.requestFullscreen(); } catch { /* still works as a full-window view */ }
};
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setPresenting(false); });
document.addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('presenting')) return;
  if (e.key === 'Escape') { setPresenting(false); if (document.fullscreenElement) document.exitFullscreen(); return; }
  const pages = [...document.querySelectorAll('.report .page')];
  const i = pages.findIndex((p) => p.getBoundingClientRect().top > -window.innerHeight / 2);
  const go = (n) => pages[Math.max(0, Math.min(pages.length - 1, n))].scrollIntoView({ behavior: 'smooth' });
  if (['ArrowLeft', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(i + 1); }
  if (['ArrowRight', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); go(i - 1); }
});
$('clearBtn').onclick = async () => { if (confirm('حذف الفواتير والسندات المحفوظة في هذا المتصفح؟ (الأهداف والإعدادات تبقى). تأكد من أخذ نسخة احتياطية أولاً.')) { await browserStore.clear(); await refresh(true); } };
$('printBtn').onclick = () => window.print();
// beforeprint also fires for Ctrl+P, so both routes get the white-paper charts and an up-to-date header.
window.addEventListener('beforeprint', () => { st.printing = true; document.body.classList.add('printing'); render(); });
window.addEventListener('afterprint', () => { st.printing = false; document.body.classList.remove('printing'); render(); });
function toggleSort(th) {
  const key = th?.dataset.sort; if (!key) return;
  const textual = ['rep', 'region', 'position'].includes(key);
  st.repSort = st.repSort.key === key ? { key, dir: st.repSort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: textual ? 'asc' : 'desc' };
  render();
}
$('reps').onclick = (e) => { const b = e.target.closest('[data-rep]'); if (b) return openRepCard(b.dataset.rep); toggleSort(e.target.closest('th[data-sort]')); };
$('reps').onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('th[data-sort]')) { e.preventDefault(); toggleSort(e.target); } };
$('repCardClose').onclick = () => $('repCard').close();
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
    setTimeout(() => { $('notice').style.display = 'none'; }, 9000);
  }
  await refresh(true);
})();
