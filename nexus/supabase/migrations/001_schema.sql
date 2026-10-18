-- NEXUS Dashboard: schema, row-level security and import functions.
-- Paste this whole file into Supabase > SQL Editor > Run. It is safe to run once on a new project.
--
-- Rules that MUST stay identical to nexus/src/shared.js:
--   * summary-row pattern (is_summary_row)
--   * EPSILON = 0.02, future-date limit = 7 days, overpaid rows are accepted and flagged.

-- ---------- settings ----------
create table public.system_settings (
  key   text primary key,
  value text not null default ''
);
insert into public.system_settings (key, value) values
  ('open_guest_mode', 'true'),   -- TEST PHASE ONLY: any signed-in (even anonymous) user acts as admin.
  ('system_name',     'NEXUS Dashboard'),
  ('logo_url',        '');
-- To turn guest mode off before production, run:
--   update public.system_settings set value = 'false' where key = 'open_guest_mode';

-- ---------- users ----------
create table public.profiles (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  role     text not null check (role in ('admin', 'rep')),
  rep_name text,
  constraint rep_needs_name check (role <> 'rep' or rep_name is not null)
);

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    coalesce((select p.role = 'admin' from public.profiles p where p.user_id = auth.uid()), false)
    or coalesce((select s.value = 'true' from public.system_settings s where s.key = 'open_guest_mode'), false)
  );
$$;

create function public.current_rep() returns text
language sql stable security definer set search_path = public as $$
  select p.rep_name from public.profiles p where p.user_id = auth.uid() and p.role = 'rep';
$$;

-- ---------- data ----------
create table public.sales (
  key        text primary key,                       -- invoice number (+ date for credit/debit notes)
  number     text not null,
  sale_date  date not null,
  rep_name   text not null,
  customer   text not null default '',
  total      numeric(14,2) not null,
  paid       numeric(14,2) not null,
  unpaid     numeric(14,2) not null,
  returns    numeric(14,2) not null,
  flags      text[] not null default '{}',
  updated_at timestamptz not null default now()
);
create index sales_date_idx on public.sales (sale_date);
create index sales_rep_idx  on public.sales (rep_name);

create table public.payments (
  key        text primary key,                       -- receipt no | rep | invoice | date
  number     text not null,
  invoice    text not null default '',
  pay_date   date not null,
  rep_name   text not null,
  customer   text not null default '',
  method     text not null default '',
  amount     numeric(14,2) not null check (amount <> 0),
  updated_at timestamptz not null default now()
);
create index payments_date_idx on public.payments (pay_date);
create index payments_rep_idx  on public.payments (rep_name);

create table public.rep_settings (
  rep_name text primary key,
  region   text not null default '',
  position text not null default ''
);

create table public.targets (
  rep_name          text not null,
  month             smallint not null check (month between 1 and 12),
  year              smallint not null check (year between 2000 and 2100),
  sales_target      numeric(14,2) not null default 0 check (sales_target >= 0),
  collection_target numeric(14,2) not null default 0 check (collection_target >= 0),
  primary key (rep_name, month, year)
);

create table public.import_log (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  user_id   uuid,
  kind      text not null,
  file_name text,
  added     int not null default 0,
  updated   int not null default 0,
  skipped   int not null default 0,
  rejected  int not null default 0,
  details   jsonb
);

-- ---------- row-level security ----------
alter table public.system_settings enable row level security;
alter table public.profiles        enable row level security;
alter table public.sales           enable row level security;
alter table public.payments        enable row level security;
alter table public.rep_settings    enable row level security;
alter table public.targets         enable row level security;
alter table public.import_log      enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.sales, public.payments, public.import_log to authenticated;
grant select, insert, update, delete on public.system_settings, public.profiles, public.rep_settings, public.targets to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Reps see only their own rows; admins see everything. Nobody writes sales/payments directly: only import_* below.
create policy sales_read    on public.sales    for select to authenticated using (public.is_admin() or rep_name = public.current_rep());
create policy payments_read on public.payments for select to authenticated using (public.is_admin() or rep_name = public.current_rep());
create policy log_read      on public.import_log for select to authenticated using (public.is_admin());

create policy targets_read  on public.targets for select to authenticated using (public.is_admin() or rep_name = public.current_rep());
create policy targets_write on public.targets for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy repset_read   on public.rep_settings for select to authenticated using (true);
create policy repset_write  on public.rep_settings for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy settings_read  on public.system_settings for select to authenticated using (true);
create policy settings_write on public.system_settings for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy profiles_read  on public.profiles for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy profiles_write on public.profiles for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- shared rules ----------
create function public.is_summary_row(t text) returns boolean
language sql immutable as $$
  select btrim(coalesce(t, '')) ~* 'مجموع|إجمالي|^رقم$|^المعرف$|^رقم السند$|^رقم الفاتورة$|Candy Smart Key|الموظف\s*/\s*العميل';
$$;

-- ---------- import: sales ----------
-- p_rows: [{key, number, date:'YYYY-MM-DD', rep, customer, total, paid, unpaid, returns}] (amounts in SAR)
create function public.import_sales(p_rows jsonb, p_file text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  eps constant numeric := 0.02;
  r jsonb;
  v_key text; v_number text; v_date date; v_rep text; v_customer text;
  v_total numeric; v_paid numeric; v_unpaid numeric; v_returns numeric;
  v_flags text[]; v_inserted boolean;
  added int := 0; updated int := 0; phantom int := 0; rejected int := 0;
  details jsonb := '[]'::jsonb;
  reject_reason text;
begin
  if not public.is_admin() then
    raise exception 'forbidden: import is restricted to administrators' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    reject_reason := null; v_flags := '{}';
    v_number := btrim(coalesce(r->>'number', ''));
    v_key    := btrim(coalesce(nullif(r->>'key', ''), v_number));
    if v_number = '' or public.is_summary_row(v_number) then
      phantom := phantom + 1; continue;
    end if;
    begin
      v_date := (r->>'date')::date;
      v_total := (r->>'total')::numeric;   v_paid := (r->>'paid')::numeric;
      v_unpaid := (r->>'unpaid')::numeric; v_returns := (r->>'returns')::numeric;
      if v_total is null or v_paid is null or v_unpaid is null or v_returns is null then
        reject_reason := 'قيمة غير رقمية';
      end if;
    exception when others then
      reject_reason := 'قيمة غير صالحة (تاريخ أو رقم)';
    end;
    v_rep := btrim(coalesce(nullif(r->>'rep', ''), 'غير محدد'));
    v_customer := btrim(coalesce(r->>'customer', ''));

    if reject_reason is null then
      if v_date is null then reject_reason := 'تاريخ غير صالح';
      elsif v_date > current_date + 7 then reject_reason := 'تاريخ في المستقبل';
      elsif v_total >= 0 and abs(v_unpaid - (v_total - v_paid - v_returns)) > eps then
        reject_reason := 'غير المدفوع لا يساوي الإجمالي - المدفوع - المرتجع';
      end if;
    end if;

    if reject_reason is not null then
      rejected := rejected + 1;
      if jsonb_array_length(details) < 200 then
        details := details || jsonb_build_object('number', v_number, 'reason', reject_reason);
      end if;
      continue;
    end if;

    if v_total >= 0 and v_paid > v_total + eps then v_flags := array_append(v_flags, 'overpaid'); end if;
    if v_total < 0 and v_paid <> 0 then v_flags := array_append(v_flags, 'negative_total_with_payment'); end if;
    if abs(v_total - (v_paid + v_unpaid + v_returns)) > eps then v_flags := array_append(v_flags, 'discrepancy'); end if;

    insert into public.sales as s (key, number, sale_date, rep_name, customer, total, paid, unpaid, returns, flags)
    values (v_key, v_number, v_date, v_rep, v_customer, v_total, v_paid, v_unpaid, v_returns, v_flags)
    on conflict (key) do update set
      number = excluded.number, sale_date = excluded.sale_date, rep_name = excluded.rep_name, customer = excluded.customer,
      total = excluded.total, paid = excluded.paid, unpaid = excluded.unpaid, returns = excluded.returns,
      flags = excluded.flags, updated_at = now()
    returning (xmax = 0) into v_inserted;
    if v_inserted then added := added + 1; else updated := updated + 1; end if;
  end loop;

  insert into public.rep_settings (rep_name)
    select distinct rep_name from public.sales on conflict do nothing;
  insert into public.import_log (user_id, kind, file_name, added, updated, skipped, rejected, details)
    values (auth.uid(), 'invoices', p_file, added, updated, phantom, rejected, details);

  return jsonb_build_object('success', true, 'added', added, 'updated', updated, 'skipped', phantom,
    'phantomRejected', phantom, 'validationRejected', rejected, 'rejectedDetails', details);
end $$;

-- ---------- import: payments ----------
-- p_rows: [{key, number, invoice, date, rep, customer, method, amount}]
create function public.import_payments(p_rows jsonb, p_file text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  v_key text; v_number text; v_date date; v_amount numeric; v_rep text;
  v_inserted boolean;
  added int := 0; updated int := 0; phantom int := 0; zero int := 0; rejected int := 0;
  details jsonb := '[]'::jsonb;
  reject_reason text;
begin
  if not public.is_admin() then
    raise exception 'forbidden: import is restricted to administrators' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    reject_reason := null;
    v_number := btrim(coalesce(r->>'number', ''));
    v_key    := btrim(coalesce(nullif(r->>'key', ''), v_number));
    if v_number = '' or public.is_summary_row(v_number) then
      phantom := phantom + 1; continue;
    end if;
    begin
      v_date := (r->>'date')::date; v_amount := (r->>'amount')::numeric;
      if v_amount is null then reject_reason := 'مبلغ غير رقمي'; end if;
    exception when others then
      reject_reason := 'قيمة غير صالحة (تاريخ أو مبلغ)';
    end;
    if reject_reason is null then
      if v_date is null then reject_reason := 'تاريخ غير صالح';
      elsif v_date > current_date + 7 then reject_reason := 'تاريخ في المستقبل';
      elsif v_amount = 0 then zero := zero + 1; continue;   -- zero receipts are ignored, not errors
      end if;
    end if;
    if reject_reason is not null then
      rejected := rejected + 1;
      if jsonb_array_length(details) < 200 then
        details := details || jsonb_build_object('number', v_number, 'reason', reject_reason);
      end if;
      continue;
    end if;
    v_rep := btrim(coalesce(nullif(r->>'rep', ''), 'غير محدد'));

    insert into public.payments as p (key, number, invoice, pay_date, rep_name, customer, method, amount)
    values (v_key, v_number, btrim(coalesce(r->>'invoice', '')), v_date, v_rep,
            btrim(coalesce(r->>'customer', '')), btrim(coalesce(r->>'method', '')), v_amount)
    on conflict (key) do update set
      number = excluded.number, invoice = excluded.invoice, pay_date = excluded.pay_date, rep_name = excluded.rep_name,
      customer = excluded.customer, method = excluded.method, amount = excluded.amount, updated_at = now()
    returning (xmax = 0) into v_inserted;
    if v_inserted then added := added + 1; else updated := updated + 1; end if;
  end loop;

  insert into public.rep_settings (rep_name)
    select distinct rep_name from public.payments on conflict do nothing;
  insert into public.import_log (user_id, kind, file_name, added, updated, skipped, rejected, details)
    values (auth.uid(), 'payments', p_file, added, updated, phantom + zero, rejected, details);

  return jsonb_build_object('success', true, 'added', added, 'updated', updated, 'skipped', phantom + zero,
    'phantomRejected', phantom, 'validationRejected', rejected, 'rejectedDetails', details);
end $$;

revoke all on function public.import_sales(jsonb, text), public.import_payments(jsonb, text) from public, anon;
grant execute on function public.import_sales(jsonb, text), public.import_payments(jsonb, text) to authenticated;
