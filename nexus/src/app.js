import { parseCsv } from './csv.js';
import { parseInvoices, parsePayments, detectKind } from './daftra.js';
import { browserStore } from './store.js';
import { computeKpis, repSummary, filterByPeriod, filterByReps, weeklyTrend } from './kpi.js';
import { fromCents } from './shared.js';
import { NEXUS_VERSION } from './config.js';

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

let sales = [], payments = [], pending = [];
const selectedReps = new Set(); // empty = all
let repChart = null, trendChart = null;

$('version').textContent = `الإصدار ${NEXUS_VERSION}`;

async function readRows(file) {
  if (/\.csv$/i.test(file.name)) return parseCsv(await file.text());
  // SheetJS is loaded only when an Excel file is chosen.
  if (!window.XLSX) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = res; s.onerror = () => rej(new Error('تعذر تحميل مكتبة Excel'));
      document.head.append(s);
    });
  }
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
}

async function previewFiles(files) {
  pending = [];
  const out = [];
  for (const file of files) {
    try {
      const rows = await readRows(file);
      const kind = detectKind(rows);
      if (!kind && /الرصيد/.test(rows.slice(0, 3).flat().join(' '))) { out.push(`<div class="file"><b>${escapeHtml(file.name)}</b><div class="warn">الأستاذ العام للعملاء: غير مستورد في هذه المرحلة، وسيُستخدم لمطابقة الأرصدة لاحقاً</div></div>`); continue; }
      if (!kind) { out.push(`<div class="file"><b>${escapeHtml(file.name)}</b><div class="bad">لم يُعرف نوع الملف (ليس تقرير فواتير ولا مدفوعات من دفترة)</div></div>`); continue; }
      const res = kind === 'invoices' ? parseInvoices(rows, { today: today() }) : parsePayments(rows, { today: today() });
      const recs = kind === 'invoices' ? res.sales : res.payments;
      pending.push({ kind, file: file.name, recs, rejected: res.rejected });
      const dates = recs.map((r) => r.date).sort();
      const extra = kind === 'invoices'
        ? `<div>إجمالي المبيعات: <b>${money(recs.reduce((a, r) => a + r.total, 0))}</b></div>
           ${res.duplicateKeys.length ? `<div class="bad">مفاتيح مكررة: ${res.duplicateKeys.length} (لن تُحفظ بشكل صحيح)</div>` : ''}
           ${recs.some((r) => r.flags.includes('overpaid')) ? `<div class="warn">دفعات زائدة (مقبولة بوسم): ${recs.filter((r) => r.flags.includes('overpaid')).length}</div>` : ''}
           ${recs.some((r) => r.flags.includes('discrepancy')) ? `<div class="warn">تناقض في الإجماليات: ${recs.filter((r) => r.flags.includes('discrepancy')).length}</div>` : ''}`
        : `<div>إجمالي المقبوضات: <b>${money(recs.reduce((a, r) => a + r.amount, 0))}</b></div>
           ${res.duplicateKeys.length ? `<div class="bad">مفاتيح مكررة: ${res.duplicateKeys.length}</div>` : ''}`;
      out.push(`<div class="file"><b>${escapeHtml(file.name)}</b> — ${kind === 'invoices' ? 'فواتير' : 'مدفوعات'}
        <div class="ok">${recs.length} صف صالح</div>
        <div class="muted">من ${dates[0] ?? '—'} إلى ${dates.at(-1) ?? '—'}</div>${extra}
        ${res.rejected.length ? `<div class="bad">مرفوض: ${res.rejected.length} — ${escapeHtml(res.rejected.slice(0, 3).map((r) => `سطر ${r.line}: ${r.reason}`).join('، '))}</div>` : ''}</div>`);
    } catch (e) {
      out.push(`<div class="file"><b>${escapeHtml(file.name)}</b><div class="bad">${escapeHtml(e.message)}</div></div>`);
    }
  }
  $('preview').innerHTML = out.join('');
  $('saveBtn').disabled = !pending.some((p) => p.recs.length);
}

async function save() {
  $('saveBtn').disabled = true;
  const results = [];
  for (const p of pending) {
    const r = await browserStore.upsert(p.kind === 'invoices' ? 'sales' : 'payments', p.recs);
    await browserStore.log({ at: new Date().toISOString(), user: 'guest', kind: p.kind, file: p.file, ...r, rejected: p.rejected.length });
    results.push(`<div class="file"><b>${escapeHtml(p.file)}</b><div class="ok">أُضيف ${r.added} — حُدّث ${r.updated} — مرفوض ${p.rejected.length}</div></div>`);
  }
  pending = [];
  await refresh(true);
  $('preview').innerHTML = results.join('');
}

function render() {
  const f = $('from').value, t = $('to').value;
  const s = filterByReps(filterByPeriod(sales, { from: f, to: t }), selectedReps);
  const p = filterByReps(filterByPeriod(payments, { from: f, to: t }), selectedReps);
  const k = computeKpis(s, p);
  const card = (l, v, sub = '') => `<div class="card"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  $('kpis').innerHTML = [
    card('إجمالي المبيعات', money(k.sales)),
    card('تحصيل فواتير الفترة', money(k.paid), `${k.paidPct.toFixed(1)}% من المبيعات`),
    card('إجمالي المقبوضات', money(k.receipts), 'يشمل فواتير فترات سابقة'),
    card('غير المدفوع', money(k.unpaid)),
    card('المرتجعات', money(k.returns)),
    card('عدد الفواتير', k.invoiceCount.toLocaleString('en-US')),
    card('العملاء النشطون', k.activeCustomers.toLocaleString('en-US')),
    card('متوسط الفاتورة', money(k.avgInvoice)),
  ].join('') + (k.discrepancies ? card('تناقضات', k.discrepancies, 'total ≠ paid+unpaid+returns') : '');
  const reps = repSummary(s, p);
  $('reps').innerHTML = `<tr><th>المندوب</th><th class="n">المبيعات</th><th class="n">التحصيل</th><th class="n">نسبة التحصيل</th><th class="n">المقبوضات</th><th class="n">غير المدفوع</th><th class="n">المرتجعات</th><th class="n">الفواتير</th></tr>` +
    (reps.map((r) => `<tr><td>${escapeHtml(r.rep)}</td><td class="n">${money(r.sales)}</td><td class="n">${money(r.paid)}</td><td class="n ${r.paidPct < 50 ? 'low' : ''}">${r.paidPct.toFixed(1)}%</td><td class="n">${money(r.receipts)}</td><td class="n">${money(r.unpaid)}</td><td class="n">${money(r.returns)}</td><td class="n">${r.invoices}</td></tr>`).join('') ||
      '<tr><td colspan="8" class="muted">لا توجد بيانات — استورد ملفات دفترة أولاً</td></tr>');
  renderCharts(reps, weeklyTrend(s, p));
  $('rangeInfo').textContent = sales.length ? `${s.length.toLocaleString('en-US')} صف مبيعات، ${p.length.toLocaleString('en-US')} سند ضمن الفترة` : '';
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
  repChart?.destroy(); trendChart?.destroy();
  repChart = new window.Chart($('repChart'), {
    type: 'bar',
    data: { labels: top.map((r) => r.rep), datasets: [
      { label: 'المبيعات', data: top.map((r) => r.sales / 100), backgroundColor: accent },
      { label: 'التحصيل', data: top.map((r) => r.paid / 100), backgroundColor: warn }] },
    options: { ...common, indexAxis: 'y', scales: { x: axis({ callback: fmt }), y: axis() } },
  });
  trendChart = new window.Chart($('trendChart'), {
    type: 'line',
    data: { labels: trend.map((w) => w.week), datasets: [
      { label: 'المبيعات', data: trend.map((w) => w.sales / 100), borderColor: accent, backgroundColor: accent, tension: .25, pointRadius: 0 },
      { label: 'المقبوضات', data: trend.map((w) => w.receipts / 100), borderColor: warn, backgroundColor: warn, tension: .25, pointRadius: 0 }] },
    options: { ...common, interaction: { mode: 'index', intersect: false }, scales: { x: axis(), y: axis({ callback: fmt }) } },
  });
}

function renderRepList() {
  const names = [...new Set(sales.map((r) => r.rep))].sort((a, b) => a.localeCompare(b, 'ar'));
  $('repList').innerHTML = `<label><input type="checkbox" id="repAll"> كل المناديب</label>` +
    names.map((n) => `<label><input type="checkbox" data-rep="${escapeHtml(n)}" ${selectedReps.has(n) ? 'checked' : ''}> ${escapeHtml(n)}</label>`).join('');
  $('repAll').checked = selectedReps.size === 0;
  $('repSelLabel').textContent = selectedReps.size ? `المناديب (${selectedReps.size})` : 'كل المناديب';
}

async function refresh(resetRange = false) {
  [sales, payments] = await Promise.all([browserStore.loadAll('sales'), browserStore.loadAll('payments')]);
  const dates = [...sales, ...payments].map((r) => r.date).sort();
  if (resetRange || (!$('from').value && dates.length)) { $('from').value = dates[0] ?? ''; $('to').value = dates.at(-1) ?? ''; }
  const logs = await browserStore.lastImports();
  $('log').innerHTML = `<tr><th>الوقت</th><th>المستخدم</th><th>الملف</th><th>النوع</th><th class="n">أُضيف</th><th class="n">حُدّث</th><th class="n">مرفوض</th></tr>` +
    (logs.map((l) => `<tr><td>${escapeHtml(l.at.replace('T', ' ').slice(0, 16))}</td><td>${escapeHtml(l.user)}</td><td>${escapeHtml(l.file)}</td><td>${l.kind === 'invoices' ? 'فواتير' : 'مدفوعات'}</td><td class="n">${l.added}</td><td class="n">${l.updated}</td><td class="n">${l.rejected}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">لا توجد عمليات بعد</td></tr>');
  renderRepList();
  render();
}

$('importBtn').onclick = () => { $('preview').innerHTML = ''; $('files').value = ''; $('saveBtn').disabled = true; pending = []; $('dlg').showModal(); };
$('cancelBtn').onclick = () => $('dlg').close();
$('files').onchange = (e) => previewFiles([...e.target.files]);
$('saveBtn').onclick = save;
$('from').onchange = $('to').onchange = render;
$('repList').onchange = (e) => {
  const el = e.target;
  if (el.id === 'repAll') selectedReps.clear();
  else if (el.dataset.rep !== undefined) { el.checked ? selectedReps.add(el.dataset.rep) : selectedReps.delete(el.dataset.rep); }
  renderRepList(); render();
};
$('allBtn').onclick = () => { const d = [...sales, ...payments].map((r) => r.date).sort(); $('from').value = d[0] ?? ''; $('to').value = d.at(-1) ?? ''; render(); };
$('clearBtn').onclick = async () => { if (confirm('حذف كل البيانات المحفوظة في هذا المتصفح؟ لا يمكن التراجع.')) { await browserStore.clear(); await refresh(true); } };
refresh();
