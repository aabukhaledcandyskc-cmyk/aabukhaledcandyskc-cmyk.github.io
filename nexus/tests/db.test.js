// Runs supabase/migrations/*.sql on a real Postgres (PGlite) with a stand-in for Supabase's auth schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { salesToRpc, paymentsToRpc } from '../src/rpc.js';
import { isSummaryRow } from '../src/shared.js';

const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const REP_A = '00000000-0000-0000-0000-0000000000b1';
const REP_B = '00000000-0000-0000-0000-0000000000b2';
const STRANGER = '00000000-0000-0000-0000-0000000000c1';

const prelude = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  insert into auth.users values ('${ADMIN}'), ('${REP_A}'), ('${REP_B}'), ('${STRANGER}');
`;
const migration = fs.readFileSync(new URL('../supabase/migrations/001_schema.sql', import.meta.url), 'utf8');

async function fresh() {
  const db = new PGlite();
  await db.exec(prelude);
  await db.exec(migration);
  await db.exec(`
    update system_settings set value = 'false' where key = 'open_guest_mode';
    insert into profiles values ('${ADMIN}', 'admin', null), ('${REP_A}', 'rep', 'مندوب أ'), ('${REP_B}', 'rep', 'مندوب ب');`);
  return db;
}
// Run a callback as a given signed-in user (role authenticated), always restoring the superuser afterwards.
async function as(db, uid, fn) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
const rpc = (db, fn, rows, file = 't.csv') => db.query(`select public.${fn}($1::jsonb, $2) as r`, [JSON.stringify(rows), file]).then((x) => x.rows[0].r);
const one = async (db, sql) => (await db.query(sql)).rows[0];

const S = (o) => ({ key: o.number, number: o.number, date: '2026-01-10', rep: 'مندوب أ', customer: 'ع', total: '100.00', paid: '40.00', unpaid: '60.00', returns: '0.00', ...o });

test('migration applies and seeds settings', async () => {
  const db = await fresh();
  assert.equal((await one(db, `select count(*)::int c from system_settings`)).c, 3);
});

test('import: add, update, no duplicates on re-import (spec test 1)', async () => {
  const db = await fresh();
  const rows = [S({ number: '1' }), S({ number: '2' }), S({ number: '3' })];
  const a = await as(db, ADMIN, () => rpc(db, 'import_sales', rows));
  assert.deepEqual([a.added, a.updated, a.validationRejected], [3, 0, 0]);
  const b = await as(db, ADMIN, () => rpc(db, 'import_sales', rows));
  assert.deepEqual([b.added, b.updated], [0, 3]);
  assert.equal((await one(db, `select count(*)::int c from sales`)).c, 3);
  assert.equal((await one(db, `select count(*)::int c from import_log`)).c, 2);
});

test('validation: exactly the rules of the spec', async () => {
  const db = await fresh();
  const rows = [
    S({ number: 'ok-partial-return', total: '100.00', paid: '50.00', unpaid: '40.00', returns: '10.00' }), // accepted
    S({ number: 'dd-13', date: '2026-08-13' }),                                                          // DD>12 accepted
    S({ number: 'bad-unpaid', unpaid: '60.03' }),                                                        // 0.03 off -> rejected
    S({ number: 'edge-unpaid', unpaid: '60.02' }),                                                       // exactly 0.02 -> accepted
    S({ number: 'over', paid: '120.00', unpaid: '-20.00' }),                                             // overpaid -> accepted + flag
    S({ number: 'credit-note', total: '-50.00', paid: '0.00', unpaid: '-50.00' }),                       // negative total accepted
    S({ number: 'future', date: '2099-01-01' }),
    S({ number: 'no-date', date: null }),
    S({ number: 'الإجمالي الكلي (SAR)' }),                                                              // phantom
    S({ number: 'المجموع' }),                                                                            // phantom
    S({ number: 'text-amount', total: 'abc' }),
  ];
  const r = await as(db, ADMIN, () => rpc(db, 'import_sales', rows));
  assert.equal(r.added, 5);
  assert.equal(r.phantomRejected, 2);
  assert.equal(r.validationRejected, 4);
  assert.deepEqual(r.rejectedDetails.map((d) => d.number).sort(), ['bad-unpaid', 'future', 'no-date', 'text-amount']);
  const over = await one(db, `select flags from sales where key = 'over'`);
  assert.deepEqual(over.flags, ['overpaid']);
  assert.equal((await one(db, `select count(*)::int c from sales where key like 'ال%'`)).c, 0);
});

test('summary-row pattern behaves identically in SQL and JS', async () => {
  const db = await fresh();
  const samples = ['المجموع', 'الإجمالي الكلي (SAR)', 'رقم', 'المعرف', 'رقم السند', 'رقم الفاتورة', 'Candy Smart Key Company',
    'الموظف / العميل', '000001', '000009 إشعار دائن', '000001 فاتورة مرتجعة', '  المجموع  ', 'رقم 5'];
  for (const t of samples) {
    const sql = (await db.query(`select public.is_summary_row($1) as v`, [t])).rows[0].v;
    assert.equal(sql, isSummaryRow(t), JSON.stringify(t));
  }
});

test('amounts keep exact 2-decimal precision', async () => {
  const db = await fresh();
  await as(db, ADMIN, () => rpc(db, 'import_sales', [S({ number: 'p1', total: '7933.51', paid: '7933.50', unpaid: '0.01' })]));
  assert.equal((await one(db, `select (total - paid)::text d from sales`)).d, '0.01');
});

test('payments: negatives kept, zeros skipped, same receipt no. for two reps, no duplicates', async () => {
  const db = await fresh();
  const P = (o) => ({ number: '124', invoice: '1', date: '2026-01-10', rep: 'مندوب أ', customer: 'ع', method: 'نقدي', amount: '55.20', ...o });
  const rows = [
    P({ key: '124|مندوب أ|1|2026-01-10' }),
    P({ key: '124|مندوب ب|247|2026-09-03', rep: 'مندوب ب', amount: '-162.00' }),
    P({ key: '125|مندوب أ|2|2026-01-10', number: '125', amount: '0.00' }),
    P({ key: 'x', number: 'المجموع' }),
  ];
  const a = await as(db, ADMIN, () => rpc(db, 'import_payments', rows));
  assert.deepEqual([a.added, a.updated, a.phantomRejected, a.skipped], [2, 0, 1, 2]);
  const b = await as(db, ADMIN, () => rpc(db, 'import_payments', rows));
  assert.deepEqual([b.added, b.updated], [0, 2]);
  assert.equal((await one(db, `select sum(amount)::text s from payments`)).s, '-106.80');
});

test('security: reps see only their own rows and cannot write', async () => {
  const db = await fresh();
  await as(db, ADMIN, () => rpc(db, 'import_sales', [S({ number: '1' }), S({ number: '2' }), S({ number: '3', rep: 'مندوب ب' })]));
  await as(db, ADMIN, () => rpc(db, 'import_payments', [{ key: 'k1', number: '9', invoice: '1', date: '2026-01-10', rep: 'مندوب ب', customer: '', method: '', amount: '10.00' }]));
  const count = (uid, t) => as(db, uid, async () => (await one(db, `select count(*)::int c from ${t}`)).c);
  assert.equal(await count(ADMIN, 'sales'), 3);
  assert.equal(await count(REP_A, 'sales'), 2);
  assert.equal(await count(REP_B, 'sales'), 1);
  assert.equal(await count(REP_A, 'payments'), 0);
  assert.equal(await count(REP_B, 'payments'), 1);
  assert.equal(await count(STRANGER, 'sales'), 0); // signed in, but no profile and guest mode off
  // direct writes are refused
  await assert.rejects(as(db, REP_A, () => db.exec(`insert into sales (key,number,sale_date,rep_name,total,paid,unpaid,returns) values ('h','h','2026-01-01','مندوب أ',1,0,1,0)`)), /permission denied/);
  await assert.rejects(as(db, ADMIN, () => db.exec(`delete from sales`)), /permission denied/);
  await assert.rejects(as(db, REP_A, () => db.exec(`update sales set total = 1`)), /permission denied/);
  // import is admin-only
  await assert.rejects(as(db, REP_A, () => rpc(db, 'import_sales', [S({ number: 'x' })])), /forbidden/);
  await assert.rejects(as(db, STRANGER, () => rpc(db, 'import_payments', [])), /forbidden/);
  // anonymous (not signed in) role sees nothing at all
  await db.exec(`set role anon`);
  await assert.rejects(db.query(`select * from sales`), /permission denied/);
  await db.exec(`reset role`);
  // reps cannot read the import log or promote themselves
  assert.equal(await count(REP_A, 'import_log'), 0);
  await as(db, REP_A, () => db.exec(`update profiles set role='admin' where user_id='${REP_A}'`)); // policy hides the row: 0 rows change
  assert.equal((await one(db, `select role from profiles where user_id='${REP_A}'`)).role, 'rep');
});

test('security: open guest mode is one switch, server-enforced', async () => {
  const db = await fresh();
  await db.exec(`update system_settings set value = 'true' where key = 'open_guest_mode'`);
  const r = await as(db, STRANGER, () => rpc(db, 'import_sales', [S({ number: 'g1' })]));
  assert.equal(r.added, 1);
  assert.equal(await as(db, STRANGER, async () => (await one(db, `select count(*)::int c from sales`)).c), 1);
  await db.exec(`update system_settings set value = 'false' where key = 'open_guest_mode'`);
  await assert.rejects(as(db, STRANGER, () => rpc(db, 'import_sales', [S({ number: 'g2' })])), /forbidden/);
  assert.equal(await as(db, STRANGER, async () => (await one(db, `select count(*)::int c from sales`)).c), 0);
});

test('targets: composite key keeps one row per rep+month+year (spec test 7); reps read only their own', async () => {
  const db = await fresh();
  const up = (sales, coll) => as(db, ADMIN, () => db.exec(`insert into targets values ('مندوب أ', 9, 2026, ${sales}, ${coll})
    on conflict (rep_name, month, year) do update set sales_target = excluded.sales_target, collection_target = excluded.collection_target`));
  await up(1000, 800); await up(1500, 900);
  await as(db, ADMIN, () => db.exec(`insert into targets values ('مندوب ب', 9, 2026, 5, 5)`));
  assert.deepEqual(await one(db, `select count(*)::int c, max(sales_target)::text m from targets where rep_name='مندوب أ'`), { c: 1, m: '1500.00' });
  assert.equal(await as(db, REP_A, async () => (await one(db, `select count(*)::int c from targets`)).c), 1);
  await assert.rejects(as(db, REP_A, () => db.exec(`insert into targets values ('مندوب أ', 10, 2026, 1, 1)`)), /row-level security|permission/);
  await assert.rejects(as(db, ADMIN, () => db.exec(`insert into targets values ('مندوب أ', 13, 2026, 1, 1)`)), /check/);
});

test('import registers reps in rep_settings so regions/positions can be filled', async () => {
  const db = await fresh();
  await as(db, ADMIN, () => rpc(db, 'import_sales', [S({ number: '1', rep: 'مندوب جديد' })]));
  assert.equal((await one(db, `select count(*)::int c from rep_settings where rep_name = 'مندوب جديد'`)).c, 1);
});

// ---- real files (gated) ----
const dir = process.env.NEXUS_SAMPLES_DIR;
test('REAL FILES in Postgres: totals equal the file control totals; re-import creates no duplicates; per-rep RLS', { skip: dir ? false : 'NEXUS_SAMPLES_DIR not set', timeout: 300000 }, async () => {
  const { parseCsv } = await import('../src/csv.js');
  const { parseInvoices, parsePayments } = await import('../src/daftra.js');
  const pick = (re) => path.join(dir, fs.readdirSync(dir).find((f) => re.test(f)));
  const today = new Date().toISOString().slice(0, 10);
  const inv = parseInvoices(parseCsv(fs.readFileSync(pick(/revenue_by_invoice/), 'utf8')), { today });
  const pay = parsePayments(parseCsv(fs.readFileSync(pick(/payments-payment/), 'utf8')), { today });
  const db = await fresh();
  const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  const run = async (fn, rows) => {
    const t = { added: 0, updated: 0, validationRejected: 0, phantomRejected: 0, skipped: 0 };
    for (const c of chunk(rows, 2000)) { const r = await as(db, ADMIN, () => rpc(db, fn, c)); for (const k of Object.keys(t)) t[k] += r[k]; }
    return t;
  };
  const a = await run('import_sales', salesToRpc(inv.sales));
  assert.deepEqual([a.added, a.updated, a.validationRejected], [inv.sales.length, 0, 0]);
  const p = await run('import_payments', paymentsToRpc(pay.payments));
  assert.deepEqual([p.added, p.updated, p.validationRejected], [pay.payments.length, 0, 0]);
  const g = inv.controlTotals.grand;
  const cents = (s) => Math.round(Number(s) * 100);
  const tot = await one(db, `select sum(total)::text t, sum(paid)::text p, sum(unpaid)::text u, sum(returns)::text r, count(*)::int n from sales`);
  assert.deepEqual([cents(tot.t), cents(tot.p), cents(tot.u)], [g.total, g.paid, g.unpaid]);
  assert.equal(tot.n, inv.sales.length);
  assert.equal(cents((await one(db, `select sum(amount)::text s from payments`)).s), pay.controlTotals.grand.amount);
  // idempotent re-import
  const again = await run('import_sales', salesToRpc(inv.sales));
  assert.deepEqual([again.added, again.updated], [0, inv.sales.length]);
  assert.equal((await one(db, `select count(*)::int c from sales`)).c, inv.sales.length);
  // a rep linked to a real rep name sees exactly that rep's subtotal row and nothing else
  const grp = inv.controlTotals.groups.find((x) => x.rep !== 'غير محدد' && x.total > 100000);
  await db.exec(`insert into profiles values ('${REP_A}', 'rep', '${grp.rep}') on conflict (user_id) do update set rep_name = excluded.rep_name`);
  const mine = await as(db, REP_A, async () => one(db, `select sum(total)::text t, sum(paid)::text p, sum(unpaid)::text u from sales`));
  assert.deepEqual([cents(mine.t), cents(mine.p), cents(mine.u)], [grp.total, grp.paid, grp.unpaid]);
  const others = await as(db, REP_A, async () => one(db, `select count(*)::int c from sales where rep_name <> '${grp.rep}'`));
  assert.equal(others.c, 0);
  console.log(JSON.stringify({ sales: tot.n, total: tot.t, paid: tot.p, unpaid: tot.u, returns: tot.r, repSees: cents(mine.t) / 100 }));
});
