-- Modaat business upgrade: additive schema and transactional operations.
-- REVIEW BEFORE RUNNING. This file was not executed in Supabase.
-- Expected baseline: supabase-schema.sql plus updated_at columns/triggers from
-- supabase-reliability-migration.sql. Run only after a read-only preflight and
-- backup of the live database. No client/order rows are deleted or re-imported.

begin;

do $preflight$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'This migration requires PostgreSQL 15 or newer for security-invoker reporting views.';
  end if;
  if pg_catalog.to_regclass('public.clients') is null
     or pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.payments') is null then
    raise exception 'Expected public.clients, public.orders, and public.payments. Stop and review the live schema before migration.';
  end if;
  if pg_catalog.to_regclass('private.approved_users') is null
     or pg_catalog.to_regprocedure('private.is_approved_user()') is null
     or pg_catalog.to_regprocedure('public.current_user_is_approved()') is null then
    raise exception 'The approved-user allowlist/RPC is missing. Install and verify the existing Auth/RLS setup first.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.clients'::regclass
      and attname = 'created_at' and not attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.orders'::regclass
      and attname = 'created_at' and not attisdropped
  ) then
    raise exception 'The existing created_at columns are missing. Stop and adapt this migration to the live schema.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.orders'::regclass
      and attname = 'amount' and not attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.orders'::regclass
    and attname = 'payment_status' and not attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.orders'::regclass
    and attname = 'client_id' and not attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.orders'::regclass
    and attname = 'publication_date' and not attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.orders'::regclass
    and attname = 'section' and not attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.payments'::regclass
    and attname = 'order_id' and not attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.payments'::regclass
    and attname = 'amount' and not attisdropped
  ) then
    raise exception 'Required legacy order/payment columns are missing. Stop and adapt this migration.';
  end if;
  if exists (
    select 1
    from (values
      ('public.clients'::regclass, 'id', 'text'::regtype),
      ('public.orders'::regclass, 'id', 'text'::regtype),
      ('public.orders'::regclass, 'client_id', 'text'::regtype),
      ('public.orders'::regclass, 'payment_status', 'text'::regtype),
      ('public.payments'::regclass, 'order_id', 'text'::regtype),
      ('public.orders'::regclass, 'amount', 'numeric'::regtype),
      ('public.payments'::regclass, 'amount', 'numeric'::regtype),
      ('public.orders'::regclass, 'publication_date', 'date'::regtype)
    ) as expected_columns(relation_id, column_name, data_type)
    where not exists (
      select 1
      from pg_catalog.pg_attribute as actual
      where actual.attrelid = expected_columns.relation_id
        and actual.attname = expected_columns.column_name
        and actual.atttypid = expected_columns.data_type
        and not actual.attisdropped
    )
  ) then
    raise exception 'Legacy table column types differ from the expected text/numeric/date schema. Review before migration.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_amount_check'
      and contype = 'c'
  ) then
    raise exception 'Expected the original positive-amount constraint orders_amount_check. Inspect constraints before migration.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.clients'::regclass
      and attname = 'updated_at' and not attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.orders'::regclass
      and attname = 'updated_at' and not attisdropped
  ) then
    raise exception 'Run and verify supabase-reliability-migration.sql first; updated_at is required for conflict protection.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'public.clients'::regclass
      and relrowsecurity and relforcerowsecurity
  ) or not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'public.orders'::regclass
      and relrowsecurity and relforcerowsecurity
  ) or not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'public.payments'::regclass
      and relrowsecurity and relforcerowsecurity
  ) then
    raise exception 'RLS and FORCE ROW LEVEL SECURITY must already be enabled on clients, orders, and payments.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'clients'
      and 'authenticated' = any(roles)
      and coalesce(qual, '') like '%is_approved_user%'
  ) or not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'orders'
      and 'authenticated' = any(roles)
      and coalesce(qual, '') like '%is_approved_user%'
  ) or not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'payments'
      and 'authenticated' = any(roles)
      and coalesce(qual, '') like '%is_approved_user%'
  ) then
    raise exception 'Approved-user RLS policies are missing on clients, orders, or payments.';
  end if;
  if has_table_privilege('anon', 'public.clients', 'SELECT')
     or has_table_privilege('anon', 'public.orders', 'SELECT')
     or has_table_privilege('anon', 'public.payments', 'SELECT') then
    raise exception 'The anon role has direct table access; review grants before migration.';
  end if;
  if exists (
    select 1 from public.orders
    where payment_status not in ('paid', 'pending')
  ) then
    raise exception 'Legacy orders contain an unknown payment_status. Review them before migration.';
  end if;
end;
$preflight$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

alter table public.clients
  add column if not exists internal_notes text not null default '',
  add column if not exists joined_at date;

update public.clients
set joined_at = created_at::date
where joined_at is null;

alter table public.clients
  alter column joined_at set default current_date,
  alter column joined_at set not null;

alter table public.orders
  add column if not exists order_number bigint,
  add column if not exists entered_at date,
  add column if not exists entered_by uuid references auth.users (id) on delete set null,
  add column if not exists entered_by_name text,
  add column if not exists sheet_number text,
  add column if not exists product_id uuid,
  add column if not exists product_name_snapshot text,
  add column if not exists product_dimensions_snapshot text,
  add column if not exists product_price_snapshot numeric(12, 2),
  add column if not exists product_credit_cost_snapshot integer,
  add column if not exists billing_mode text not null default 'legacy',
  add column if not exists cash_amount_before_vat numeric(12, 2),
  add column if not exists credits_used integer,
  add column if not exists vat_rate_snapshot numeric(5, 4);

update public.orders
set entered_at = created_at::date
where entered_at is null;

alter table public.orders
  alter column entered_at set default current_date,
  alter column entered_at set not null;

with numbered_orders as (
  select id,
         row_number() over (order by created_at, id) as assigned_number
  from public.orders
  where order_number is null
)
update public.orders as existing
set order_number = numbered_orders.assigned_number
from numbered_orders
where existing.id = numbered_orders.id;

create table if not exists private.order_number_counters (
  counter_name text primary key,
  last_number bigint not null check (last_number >= 0)
);

insert into private.order_number_counters (counter_name, last_number)
select 'orders', coalesce(max(order_number), 0)
from public.orders
on conflict (counter_name) do update
  set last_number = greatest(
    private.order_number_counters.last_number,
    excluded.last_number
  );

alter table private.order_number_counters enable row level security;
alter table private.order_number_counters force row level security;
revoke all on table private.order_number_counters from public, anon, authenticated;

create or replace function private.assign_business_order_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.order_number is null then
    update private.order_number_counters
    set last_number = last_number + 1
    where counter_name = 'orders'
    returning last_number into new.order_number;

    if new.order_number is null then
      raise exception 'Order number counter is unavailable.';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.assign_business_order_number() from public, anon, authenticated;

drop trigger if exists orders_assign_business_order_number on public.orders;
create trigger orders_assign_business_order_number
  before insert on public.orders
  for each row execute function private.assign_business_order_number();

alter table public.orders
  alter column order_number set not null;

create unique index if not exists orders_order_number_uidx
  on public.orders (order_number);

create index if not exists orders_sheet_publication_date_idx
  on public.orders (sheet_number, publication_date desc)
  where sheet_number is not null;

create index if not exists orders_product_id_idx
  on public.orders (product_id)
  where product_id is not null;

-- The baseline schema has the autogenerated orders_amount_check (> 0).
-- Credit-funded rows store zero cash in the legacy amount column.
alter table public.orders
  drop constraint if exists orders_amount_check,
  drop constraint if exists orders_amount_nonnegative_check,
  drop constraint if exists orders_business_billing_check,
  drop constraint if exists orders_business_billing_mode_check,
  add constraint orders_amount_nonnegative_check
    check (amount >= 0 and amount <= 99999999),
  add constraint orders_business_billing_mode_check
    check (billing_mode in ('legacy', 'cash', 'credits')),
  add constraint orders_business_billing_check
    check (
      (billing_mode = 'legacy'
        and cash_amount_before_vat is null
        and credits_used is null)
      or
      (billing_mode = 'cash'
        and cash_amount_before_vat > 0
        and credits_used is null
        and vat_rate_snapshot between 0 and 1
        and amount > 0)
      or
      (billing_mode = 'credits'
        and cash_amount_before_vat is null
        and credits_used > 0
        and amount = 0)
    );

create table if not exists public.business_settings (
  singleton boolean primary key default true check (singleton),
  vat_rate numeric(5, 4) not null check (vat_rate between 0 and 1),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references auth.users (id) on delete set null
);

insert into public.business_settings (singleton, vat_rate)
values (true, 0.18)
on conflict (singleton) do nothing;

create table if not exists public.product_catalog (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  dimensions text not null default '',
  base_price_before_vat numeric(12, 2)
    check (base_price_before_vat is null or base_price_before_vat > 0),
  credit_cost integer
    check (credit_cost is null or credit_cost > 0),
  is_active boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references auth.users (id) on delete set null
);

do $order_product_fk$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_product_id_fkey'
  ) then
    alter table public.orders
      add constraint orders_product_id_fkey
      foreign key (product_id)
      references public.product_catalog (id)
      on update cascade on delete restrict;
  end if;
end;
$order_product_fk$;

create table if not exists public.package_catalog (
  id uuid primary key default gen_random_uuid(),
  package_code text not null unique,
  name text not null check (length(btrim(name)) between 1 and 120),
  credits integer not null check (credits > 0),
  term_months integer not null check (term_months > 0),
  total_price_before_vat numeric(12, 2) not null
    check (total_price_before_vat > 0),
  default_installment_count integer not null
    check (default_installment_count between 1 and 60),
  default_installment_before_vat numeric(12, 2) not null
    check (default_installment_before_vat > 0),
  benefits jsonb not null default '[]'::jsonb
    check (jsonb_typeof(benefits) = 'array'),
  is_active boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references auth.users (id) on delete set null
);

-- These are the only catalog seed values read directly from the supplied
-- package image. Prices are before VAT. Existing admin edits are never replaced.
insert into public.package_catalog (
  package_code, name, credits, term_months, total_price_before_vat,
  default_installment_count, default_installment_before_vat, benefits
)
values
  (
    'minimum-maximum', 'מינימום מקסימום', 30, 6, 2148, 12, 179,
    jsonb_build_array(
      jsonb_build_object('key', 'map_months', 'label', 'מיקום על המפה', 'quantity', 6, 'unit', 'חודשים')
    )
  ),
  (
    'leading-brand', 'מותג מוביל', 60, 12, 4188, 12, 349,
    jsonb_build_array(
      jsonb_build_object('key', 'strategic_consulting', 'label', 'שיחת ייעוץ אסטרטגית', 'quantity', 1, 'unit', 'שיחות'),
      jsonb_build_object('key', 'map_months', 'label', 'מיקום על המפה', 'quantity', 12, 'unit', 'חודשים'),
      jsonb_build_object('key', 'content_articles', 'label', 'כתבת תוכן', 'quantity', 1, 'unit', 'כתבות'),
      jsonb_build_object('key', 'left_page_priority', 'label', 'זכות קדימה לעמוד שמאל', 'quantity', 1, 'unit', 'זכות'),
      jsonb_build_object('key', 'yearbook_discount_percent', 'label', 'הנחה לרכישה בלוח שנה', 'quantity', 10, 'unit', 'אחוזים')
    )
  ),
  (
    'winning-ad', 'פרסום מנצח', 120, 12, 8028, 12, 669,
    jsonb_build_array(
      jsonb_build_object('key', 'strategic_consulting', 'label', 'שיחת ייעוץ אסטרטגית', 'quantity', 2, 'unit', 'שיחות'),
      jsonb_build_object('key', 'map_months', 'label', 'מיקום על המפה', 'quantity', 12, 'unit', 'חודשים'),
      jsonb_build_object('key', 'content_articles', 'label', 'כתבת תוכן', 'quantity', 2, 'unit', 'כתבות'),
      jsonb_build_object('key', 'left_page_priority', 'label', 'זכות קדימה לעמוד שמאל', 'quantity', 1, 'unit', 'זכות'),
      jsonb_build_object('key', 'yearbook_monthly_square_back', 'label', 'קובייה חודשית + גב בלוח שנה', 'quantity', 1, 'unit', 'הטבה'),
      jsonb_build_object('key', 'yearbook_discount_percent', 'label', 'הנחה לרכישה בלוח שנה', 'quantity', 15, 'unit', 'אחוזים')
    )
  )
on conflict (package_code) do nothing;

create table if not exists public.customer_packages (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.clients (id) on update cascade on delete restrict,
  package_id uuid references public.package_catalog (id) on delete set null,
  package_name_snapshot text not null check (length(btrim(package_name_snapshot)) > 0),
  credits_granted integer not null check (credits_granted > 0),
  term_months integer not null check (term_months > 0),
  price_before_vat numeric(12, 2) not null check (price_before_vat > 0),
  vat_rate_snapshot numeric(5, 4) not null check (vat_rate_snapshot between 0 and 1),
  gross_total numeric(12, 2) not null check (gross_total > 0),
  starts_on date not null,
  ends_on date not null,
  installment_count integer not null check (installment_count between 1 and 60),
  benefits_snapshot jsonb not null default '[]'::jsonb
    check (jsonb_typeof(benefits_snapshot) = 'array'),
  status text not null default 'active'
    check (status in ('active', 'ended', 'cancelled')),
  notes text not null default '',
  idempotency_key uuid not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now(),
  check (ends_on >= starts_on)
);

create index if not exists customer_packages_client_dates_idx
  on public.customer_packages (client_id, starts_on desc, ends_on);

create table if not exists public.package_installments (
  id uuid primary key default gen_random_uuid(),
  customer_package_id uuid not null
    references public.customer_packages (id) on update cascade on delete restrict,
  installment_number integer not null check (installment_number > 0),
  due_on date not null,
  amount_before_vat numeric(12, 2) not null check (amount_before_vat > 0),
  vat_rate_snapshot numeric(5, 4) not null check (vat_rate_snapshot between 0 and 1),
  amount_due numeric(12, 2) not null check (amount_due > 0),
  created_at timestamptz not null default pg_catalog.now(),
  unique (customer_package_id, installment_number)
);

create table if not exists public.financial_obligations (
  id uuid primary key default gen_random_uuid(),
  order_id text unique references public.orders (id) on update cascade on delete restrict,
  package_installment_id uuid unique
    references public.package_installments (id) on update cascade on delete restrict,
  amount_due numeric(12, 2) not null check (amount_due > 0),
  due_on date,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  legacy_snapshot boolean not null default false,
  paid_at timestamptz,
  paid_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid references auth.users (id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint financial_obligations_single_source_check
    check (num_nonnulls(order_id, package_installment_id) = 1),
  constraint financial_obligations_paid_timestamp_check
    check (
      (status = 'pending' and paid_at is null and paid_by is null)
      or (status = 'paid' and (
        (paid_at is not null and paid_by is not null)
        or (legacy_snapshot and paid_at is null and paid_by is null)
      ))
    )
);

alter table public.financial_obligations
  add column if not exists legacy_snapshot boolean not null default false;

alter table public.financial_obligations
  alter column created_by drop not null;

do $legacy_paid_check$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'public.financial_obligations'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%paid_at%'
  loop
    execute pg_catalog.format(
      'alter table public.financial_obligations drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$legacy_paid_check$;

alter table public.financial_obligations
  add constraint financial_obligations_paid_timestamp_check
  check (
    (status = 'pending' and paid_at is null and paid_by is null)
    or (status = 'paid' and (
      (paid_at is not null and paid_by is not null)
      or (legacy_snapshot and paid_at is null and paid_by is null)
    ))
  );

create index if not exists financial_obligations_due_status_idx
  on public.financial_obligations (status, due_on);

-- Preserve each existing order's amount and paid/pending flag without
-- inventing a due date, payment timestamp, or payment event.
insert into public.financial_obligations (
  order_id, amount_due, due_on, status, legacy_snapshot,
  paid_at, paid_by, created_by
)
select orders.id, orders.amount, null, orders.payment_status, true,
       null, null, null
from public.orders as orders
where orders.billing_mode = 'legacy'
on conflict (order_id) do nothing;

create table if not exists public.business_payment_events (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null
    references public.financial_obligations (id) on update cascade on delete restrict,
  event_type text not null
    check (event_type in ('payment', 'reversal', 'status_correction')),
  amount numeric(12, 2) not null,
  event_at timestamptz not null default pg_catalog.now(),
  notes text not null default '',
  idempotency_key uuid not null unique,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  check (
    (event_type = 'payment' and amount > 0)
    or (event_type = 'reversal' and amount < 0)
    or (event_type = 'status_correction' and amount = 0)
  )
);

create index if not exists business_payment_events_obligation_idx
  on public.business_payment_events (obligation_id, event_at);

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.clients (id) on update cascade on delete restrict,
  delta integer not null check (delta <> 0),
  entry_type text not null check (
    entry_type in ('package_grant', 'order_consumption', 'correction', 'conversion_reversal')
  ),
  order_id text references public.orders (id) on update cascade on delete restrict,
  customer_package_id uuid
    references public.customer_packages (id) on update cascade on delete restrict,
  reason text not null check (length(btrim(reason)) > 0),
  idempotency_key uuid not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid not null references auth.users (id) on delete restrict,
  check (
    (entry_type = 'package_grant' and customer_package_id is not null and order_id is null and delta > 0)
    or
    (entry_type = 'order_consumption' and order_id is not null and customer_package_id is null and delta < 0)
    or (entry_type = 'correction' and customer_package_id is null)
    or (entry_type = 'conversion_reversal'
        and order_id is null and customer_package_id is null)
  )
);

create unique index if not exists credit_ledger_order_consumption_uidx
  on public.credit_ledger (order_id)
  where entry_type = 'order_consumption';

create index if not exists credit_ledger_order_id_idx
  on public.credit_ledger (order_id)
  where order_id is not null;

create index if not exists credit_ledger_client_created_idx
  on public.credit_ledger (client_id, created_at desc);

create table if not exists public.package_benefit_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_package_id uuid not null
    references public.customer_packages (id) on update cascade on delete restrict,
  benefit_key text not null,
  label_snapshot text not null,
  quantity_delta numeric(12, 2) not null check (quantity_delta <> 0),
  unit_snapshot text not null,
  reason text not null check (length(btrim(reason)) > 0),
  idempotency_key uuid not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid not null references auth.users (id) on delete restrict
);

create index if not exists package_benefit_ledger_package_idx
  on public.package_benefit_ledger (customer_package_id, benefit_key, created_at);

create table if not exists public.credit_cash_conversions (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique
    references public.orders (id) on update cascade on delete restrict,
  original_credits integer not null check (original_credits > 0),
  approved_price_before_vat numeric(12, 2) not null
    check (approved_price_before_vat > 0),
  vat_rate_snapshot numeric(5, 4) not null check (vat_rate_snapshot between 0 and 1),
  gross_amount numeric(12, 2) not null check (gross_amount > 0),
  due_on date,
  reason text not null check (length(btrim(reason)) > 0),
  idempotency_key uuid not null,
  converted_at timestamptz not null default pg_catalog.now(),
  converted_by uuid not null references auth.users (id) on delete restrict
);

create index if not exists credit_cash_conversions_created_idx
  on public.credit_cash_conversions (converted_at desc);

create table if not exists public.business_audit_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_key text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_values jsonb,
  new_values jsonb,
  actor_id uuid references auth.users (id) on delete set null,
  actor_label text not null default '',
  happened_at timestamptz not null default pg_catalog.now()
);

create index if not exists business_audit_log_record_idx
  on public.business_audit_log (table_name, record_key, happened_at desc);

create table if not exists private.business_operations (
  idempotency_key uuid primary key,
  operation_type text not null,
  actor_id uuid not null references auth.users (id) on delete restrict,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default pg_catalog.now()
);

alter table private.business_operations enable row level security;
alter table private.business_operations force row level security;
revoke all on table private.business_operations from public, anon, authenticated;

create or replace function private.claim_business_operation(
  p_key uuid,
  p_operation_type text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_inserted integer;
  v_existing private.business_operations%rowtype;
begin
  if v_actor is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_key is null or p_operation_type is null or p_request_hash is null then
    raise exception 'נדרש מפתח פעולה ייחודי.';
  end if;

  insert into private.business_operations (
    idempotency_key, operation_type, actor_id, request_hash
  )
  values (p_key, p_operation_type, v_actor, p_request_hash)
  on conflict (idempotency_key) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return null;
  end if;

  select * into v_existing
  from private.business_operations
  where idempotency_key = p_key
  for update;

  if v_existing.actor_id <> v_actor
     or v_existing.operation_type <> p_operation_type
     or v_existing.request_hash <> p_request_hash then
    raise exception 'מפתח הפעולה כבר שויך לבקשה אחרת.';
  end if;
  if v_existing.response is null then
    raise exception 'הפעולה הקודמת עדיין בעיבוד; יש לבדוק מצב לפני ניסיון חוזר.';
  end if;
  return v_existing.response;
end;
$function$;

revoke all on function private.claim_business_operation(uuid, text, text)
  from public, anon, authenticated;

create or replace function private.write_business_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_actor_label text;
begin
  if tg_op <> 'INSERT' then
    v_old := to_jsonb(old);
  end if;
  if tg_op <> 'DELETE' then
    v_new := to_jsonb(new);
  end if;
  v_key := coalesce(v_new ->> 'id', v_old ->> 'id',
                    v_new ->> 'order_id', v_old ->> 'order_id', '');
  v_actor_label := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''),
    nullif(auth.jwt() ->> 'email', ''),
    ''
  );

  insert into public.business_audit_log (
    table_name, record_key, action, old_values, new_values, actor_id, actor_label
  )
  values (tg_table_name, v_key, tg_op, v_old, v_new, auth.uid(), v_actor_label);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function private.write_business_audit() from public, anon, authenticated;

create or replace function private.touch_business_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

revoke all on function private.touch_business_updated_at() from public, anon, authenticated;

create or replace function private.protect_append_only_business_row()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'רשומת היסטוריה אינה ניתנת לעריכה או למחיקה; יש ליצור תנועת תיקון מתועדת.';
end;
$function$;

revoke all on function private.protect_append_only_business_row()
  from public, anon, authenticated;

drop trigger if exists clients_touch_updated_at on public.clients;
drop trigger if exists orders_touch_updated_at on public.orders;
drop trigger if exists clients_business_touch_updated_at on public.clients;
create trigger clients_business_touch_updated_at
  before update on public.clients
  for each row execute function private.touch_business_updated_at();

drop trigger if exists orders_business_touch_updated_at on public.orders;
create trigger orders_business_touch_updated_at
  before update on public.orders
  for each row execute function private.touch_business_updated_at();

create or replace function private.touch_order_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

revoke all on function private.touch_order_updated_at() from public, anon, authenticated;

drop trigger if exists orders_business_touch_updated_at on public.orders;
create trigger orders_business_touch_updated_at
  before update on public.orders
  for each row execute function private.touch_order_updated_at();

do $triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'business_settings', 'product_catalog', 'package_catalog',
    'customer_packages', 'financial_obligations'
  ]
  loop
    execute pg_catalog.format(
      'drop trigger if exists %I on public.%I',
      v_table || '_business_touch_updated_at', v_table
    );
    execute pg_catalog.format(
      'create trigger %I before update on public.%I for each row execute function private.touch_business_updated_at()',
      v_table || '_business_touch_updated_at', v_table
    );

    execute pg_catalog.format(
      'drop trigger if exists %I on public.%I',
      v_table || '_business_audit', v_table
    );
    execute pg_catalog.format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function private.write_business_audit()',
      v_table || '_business_audit', v_table
    );
  end loop;

  foreach v_table in array array[
    'clients', 'orders', 'package_installments', 'business_payment_events',
    'credit_ledger', 'package_benefit_ledger', 'credit_cash_conversions'
  ]
  loop
    execute pg_catalog.format(
      'drop trigger if exists %I on public.%I',
      v_table || '_business_audit', v_table
    );
    execute pg_catalog.format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function private.write_business_audit()',
      v_table || '_business_audit', v_table
    );
  end loop;

  foreach v_table in array array[
    'business_payment_events', 'credit_ledger', 'package_benefit_ledger',
    'credit_cash_conversions', 'business_audit_log', 'package_installments'
  ]
  loop
    execute pg_catalog.format(
      'drop trigger if exists %I on public.%I',
      v_table || '_append_only', v_table
    );
    execute pg_catalog.format(
      'create trigger %I before update or delete on public.%I for each row execute function private.protect_append_only_business_row()',
      v_table || '_append_only', v_table
    );
  end loop;
end;
$triggers$;

create or replace function public.save_product_catalog_item(
  p_product_id uuid,
  p_name text,
  p_dimensions text,
  p_base_price_before_vat numeric,
  p_credit_cost integer,
  p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120 then
    raise exception 'יש להזין שם מוצר תקין.';
  end if;
  if p_is_active and (p_base_price_before_vat is null or p_credit_cost is null) then
    raise exception 'אי אפשר להפעיל מוצר לפני שמחירו ועלות הקרדיטים שלו הוזנו ממקור מאומת.';
  end if;
  if p_base_price_before_vat is not null and p_base_price_before_vat <= 0 then
    raise exception 'מחיר הבסיס חייב להיות חיובי.';
  end if;
  if p_credit_cost is not null and p_credit_cost <= 0 then
    raise exception 'עלות הקרדיטים חייבת להיות חיובית.';
  end if;

  if p_product_id is null then
    insert into public.product_catalog (
      name, dimensions, base_price_before_vat, credit_cost,
      is_active, created_by, updated_by
    )
    values (
      btrim(p_name), coalesce(p_dimensions, ''), p_base_price_before_vat,
      p_credit_cost, coalesce(p_is_active, false), auth.uid(), auth.uid()
    )
    returning id into v_id;
  else
    update public.product_catalog
    set name = btrim(p_name),
        dimensions = coalesce(p_dimensions, ''),
        base_price_before_vat = p_base_price_before_vat,
        credit_cost = p_credit_cost,
        is_active = coalesce(p_is_active, false),
        updated_by = auth.uid()
    where id = p_product_id
    returning id into v_id;
    if v_id is null then
      raise exception 'המוצר לא נמצא.';
    end if;
  end if;
  return v_id;
end;
$function$;

revoke all on function public.save_product_catalog_item(uuid, text, text, numeric, integer, boolean)
  from public, anon;
grant execute on function public.save_product_catalog_item(uuid, text, text, numeric, integer, boolean)
  to authenticated;

create or replace function public.save_package_catalog_item(
  p_package_id uuid,
  p_package_code text,
  p_name text,
  p_credits integer,
  p_term_months integer,
  p_total_price_before_vat numeric,
  p_installment_count integer,
  p_installment_before_vat numeric,
  p_benefits jsonb,
  p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120
     or p_credits is null or p_credits <= 0
     or p_term_months is null or p_term_months <= 0
     or p_total_price_before_vat is null or p_total_price_before_vat <= 0
     or p_installment_count not between 1 and 60
     or p_installment_before_vat is null or p_installment_before_vat <= 0
     or p_benefits is null or jsonb_typeof(p_benefits) <> 'array' then
    raise exception 'פרטי החבילה אינם תקינים.';
  end if;
  if p_package_id is null and (p_package_code is null or length(btrim(p_package_code)) = 0) then
    raise exception 'נדרש קוד חבילה ייחודי.';
  end if;

  if p_package_id is null then
    insert into public.package_catalog (
      package_code, name, credits, term_months, total_price_before_vat,
      default_installment_count, default_installment_before_vat,
      benefits, is_active, created_by, updated_by
    )
    values (
      btrim(p_package_code), btrim(p_name), p_credits, p_term_months,
      p_total_price_before_vat, p_installment_count, p_installment_before_vat,
      p_benefits, coalesce(p_is_active, false), auth.uid(), auth.uid()
    )
    returning id into v_id;
  else
    update public.package_catalog
    set name = btrim(p_name),
        credits = p_credits,
        term_months = p_term_months,
        total_price_before_vat = p_total_price_before_vat,
        default_installment_count = p_installment_count,
        default_installment_before_vat = p_installment_before_vat,
        benefits = p_benefits,
        is_active = coalesce(p_is_active, false),
        updated_by = auth.uid()
    where id = p_package_id
    returning id into v_id;
    if v_id is null then
      raise exception 'החבילה לא נמצאה.';
    end if;
  end if;
  return v_id;
end;
$function$;

revoke all on function public.save_package_catalog_item(uuid, text, text, integer, integer, numeric, integer, numeric, jsonb, boolean)
  from public, anon;
grant execute on function public.save_package_catalog_item(uuid, text, text, integer, integer, numeric, integer, numeric, jsonb, boolean)
  to authenticated;

create or replace function public.set_business_vat_rate(p_vat_rate numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_vat_rate is null or p_vat_rate < 0 or p_vat_rate > 1 then
    raise exception 'שיעור המע"מ חייב להיות בין 0% ל-100%.';
  end if;
  update public.business_settings
  set vat_rate = p_vat_rate, updated_by = auth.uid()
  where singleton;
end;
$function$;

revoke all on function public.set_business_vat_rate(numeric) from public, anon;
grant execute on function public.set_business_vat_rate(numeric) to authenticated;

create or replace function public.create_orders_batch(
  p_client_id text,
  p_orders jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_row jsonb;
  v_product public.product_catalog%rowtype;
  v_client public.clients%rowtype;
  v_vat numeric(5, 4);
  v_cash numeric(12, 2);
  v_credits integer;
  v_amount numeric(12, 2);
  v_status text;
  v_id text;
  v_order_number bigint;
  v_obligation_id uuid;
  v_result jsonb := '[]'::jsonb;
  v_actor_label text;
  v_balance bigint;
  v_count integer := 0;
  v_sheet text;
  v_publication_date date;
  v_due_on date;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_client_id is null or p_orders is null
     or jsonb_typeof(p_orders) <> 'array'
     or jsonb_array_length(p_orders) = 0
     or jsonb_array_length(p_orders) > 250 then
    raise exception 'יש לבחור לקוח ולהוסיף בין הזמנה אחת ל-250 הזמנות.';
  end if;

  v_cached := private.claim_business_operation(
    p_idempotency_key, 'create_orders_batch',
    pg_catalog.md5(p_client_id || ':' || p_orders::text)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select * into v_client
  from public.clients
  where id = p_client_id
  for update;
  if not found then
    raise exception 'הלקוח לא נמצא.';
  end if;

  select vat_rate into v_vat
  from public.business_settings
  where singleton;
  if v_vat is null then
    raise exception 'הגדרת המע"מ חסרה.';
  end if;

  v_actor_label := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''),
    nullif(auth.jwt() ->> 'email', ''),
    'משתמשת'
  );

  for v_row in select value from jsonb_array_elements(p_orders)
  loop
    v_count := v_count + 1;
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'שורת הזמנה % אינה תקינה.', v_count;
    end if;

    v_cash := nullif(v_row ->> 'cash_amount_before_vat', '')::numeric;
    v_credits := nullif(v_row ->> 'credits_used', '')::integer;
    if (v_cash is not null and v_cash <= 0)
       or (v_credits is not null and v_credits <= 0)
       or ((v_cash is null) = (v_credits is null)) then
      raise exception 'בכל שורה יש למלא בדיוק ערך חיובי אחד: מחיר לפני מע"מ או קרדיטים.';
    end if;

    v_sheet := nullif(btrim(v_row ->> 'sheet_number'), '');
    if v_sheet is null or length(v_sheet) > 80 then
      raise exception 'יש להזין מספר גיליון תקין בשורה %.', v_count;
    end if;
    if nullif(v_row ->> 'publication_date', '') is null then
      raise exception 'יש להזין תאריך פרסום בשורה %.', v_count;
    end if;
    v_publication_date := (v_row ->> 'publication_date')::date;
    v_status := coalesce(v_row ->> 'payment_status', 'pending');
    if v_status not in ('paid', 'pending') then
      raise exception 'סטטוס התשלום בשורה % אינו תקין.', v_count;
    end if;
    v_due_on := nullif(v_row ->> 'due_on', '')::date;

    select * into v_product
    from public.product_catalog
    where id = (v_row ->> 'product_id')::uuid
      and is_active
    for share;
    if not found then
      raise exception 'המוצר בשורה % אינו קיים או אינו פעיל.', v_count;
    end if;
    if v_product.base_price_before_vat is null or v_product.credit_cost is null then
      raise exception 'המוצר בשורה % חסר מחיר או עלות קרדיטים ממקור מאומת.', v_count;
    end if;
    if v_cash is not null then
      v_amount := round(v_cash * (1 + v_vat), 2);
    else
      v_amount := 0;
      v_status := 'paid';
    end if;

    insert into public.orders (
      id, client_id, publication_date, section, amount, payment_status, notes,
      entered_at, entered_by, entered_by_name, sheet_number, product_id,
      product_name_snapshot, product_dimensions_snapshot,
      product_price_snapshot, product_credit_cost_snapshot, billing_mode,
      cash_amount_before_vat, credits_used, vat_rate_snapshot
    )
    values (
      'o-' || gen_random_uuid()::text,
      p_client_id,
      v_publication_date,
      v_product.name,
      v_amount,
      v_status,
      coalesce(v_row ->> 'notes', ''),
      current_date,
      auth.uid(),
      v_actor_label,
      v_sheet,
      v_product.id,
      v_product.name,
      v_product.dimensions,
      v_product.base_price_before_vat,
      v_product.credit_cost,
      case when v_cash is not null then 'cash' else 'credits' end,
      v_cash,
      v_credits,
      case when v_cash is not null then v_vat else null end
    )
    returning id, order_number into v_id, v_order_number;

    if v_credits is not null then
      insert into public.credit_ledger (
        client_id, delta, entry_type, order_id, reason, idempotency_key, created_by
      )
      values (
        p_client_id, -v_credits, 'order_consumption', v_id,
        'ניצול קרדיטים בהזמנה ' || v_order_number,
        gen_random_uuid(), auth.uid()
      );
      select coalesce(sum(delta), 0) into v_balance
      from public.credit_ledger
      where client_id = p_client_id;
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'id', v_id, 'order_number', v_order_number,
        'billing_mode', 'credits', 'credit_balance_after', v_balance
      ));
    else
      insert into public.financial_obligations (
        order_id, amount_due, due_on, status, paid_at, paid_by, created_by
      )
      values (
        v_id, v_amount, v_due_on, v_status,
        case when v_status = 'paid' then pg_catalog.now() else null end,
        case when v_status = 'paid' then auth.uid() else null end,
        auth.uid()
      )
      returning id into v_obligation_id;

      if v_status = 'paid' then
        insert into public.business_payment_events (
          obligation_id, event_type, amount, notes, idempotency_key, created_by
        )
        values (
          v_obligation_id, 'payment', v_amount,
          'סומן כשולם בעת יצירת ההזמנה',
          gen_random_uuid(), auth.uid()
        );
      end if;
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'id', v_id, 'order_number', v_order_number,
        'billing_mode', 'cash', 'gross_amount', v_amount,
        'obligation_id', v_obligation_id
      ));
    end if;
  end loop;

  update private.business_operations
  set response = v_result
  where idempotency_key = p_idempotency_key;

  return v_result;
end;
$function$;

revoke all on function public.create_orders_batch(text, jsonb, uuid) from public, anon;
grant execute on function public.create_orders_batch(text, jsonb, uuid) to authenticated;

create or replace function public.purchase_customer_package(
  p_client_id text,
  p_package_id uuid,
  p_custom_name text,
  p_credits integer,
  p_term_months integer,
  p_price_before_vat numeric,
  p_starts_on date,
  p_ends_on date,
  p_installments jsonb,
  p_benefits jsonb,
  p_notes text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_client public.clients%rowtype;
  v_template public.package_catalog%rowtype;
  v_package_name text;
  v_credits integer;
  v_term integer;
  v_price numeric(12, 2);
  v_benefits jsonb;
  v_vat numeric(5, 4);
  v_count integer;
  v_sum numeric(12, 2);
  v_gross numeric(12, 2);
  v_package_id uuid;
  v_item jsonb;
  v_installment_id uuid;
  v_obligation_id uuid;
  v_index integer := 0;
  v_result jsonb := '[]'::jsonb;
  v_actor_label text;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_installments is null
     or jsonb_typeof(p_installments) <> 'array'
     or jsonb_array_length(p_installments) < 1
     or jsonb_array_length(p_installments) > 60 then
    raise exception 'יש להגדיר בין תשלום אחד ל-60 תשלומים.';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    raise exception 'טווח תאריכי החבילה אינו תקין.';
  end if;

  v_cached := private.claim_business_operation(
    p_idempotency_key, 'purchase_customer_package',
    pg_catalog.md5(concat_ws(':', p_client_id, p_package_id, p_custom_name,
      p_credits, p_term_months, p_price_before_vat, p_starts_on, p_ends_on,
      p_installments::text, p_benefits::text, p_notes))
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select * into v_client from public.clients
  where id = p_client_id for update;
  if not found then
    raise exception 'הלקוח לא נמצא.';
  end if;

  select vat_rate into v_vat
  from public.business_settings where singleton;
  if v_vat is null then
    raise exception 'הגדרת המע"מ חסרה.';
  end if;

  if p_package_id is not null then
    select * into v_template from public.package_catalog
    where id = p_package_id and is_active for share;
    if not found then
      raise exception 'החבילה אינה קיימת או אינה פעילה.';
    end if;
    v_package_name := v_template.name;
    v_credits := coalesce(p_credits, v_template.credits);
    v_term := coalesce(p_term_months, v_template.term_months);
    v_price := coalesce(p_price_before_vat, v_template.total_price_before_vat);
    v_benefits := coalesce(p_benefits, v_template.benefits);
  else
    v_package_name := nullif(btrim(p_custom_name), '');
    v_credits := p_credits;
    v_term := p_term_months;
    v_price := p_price_before_vat;
    v_benefits := p_benefits;
  end if;

  if v_package_name is null or v_credits is null or v_credits <= 0
     or v_term is null or v_term <= 0 or v_price is null or v_price <= 0
     or v_benefits is null or jsonb_typeof(v_benefits) <> 'array' then
    raise exception 'פרטי החבילה או ההסכם האישי אינם תקינים.';
  end if;

  select count(*), coalesce(sum((item ->> 'amount_before_vat')::numeric), 0),
         coalesce(sum(round((item ->> 'amount_before_vat')::numeric * (1 + v_vat), 2)), 0)
  into v_count, v_sum, v_gross
  from jsonb_array_elements(p_installments) as installment(item);
  if v_count <> jsonb_array_length(p_installments)
     or abs(v_sum - v_price) > 0.01 then
    raise exception 'סכום התשלומים לפני מע"מ חייב להיות שווה למחיר החבילה.';
  end if;

  v_actor_label := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''),
    nullif(auth.jwt() ->> 'email', ''),
    'משתמשת'
  );

  insert into public.customer_packages (
    client_id, package_id, package_name_snapshot, credits_granted,
    term_months, price_before_vat, vat_rate_snapshot, gross_total,
    starts_on, ends_on, installment_count, benefits_snapshot, notes,
    idempotency_key, created_by
  )
  values (
    p_client_id, p_package_id, v_package_name, v_credits, v_term,
    v_price, v_vat, v_gross, p_starts_on, p_ends_on,
    v_count, v_benefits, coalesce(p_notes, ''),
    p_idempotency_key, auth.uid()
  )
  returning id into v_package_id;

  insert into public.credit_ledger (
    client_id, delta, entry_type, customer_package_id, reason,
    idempotency_key, created_by
  )
  values (
    p_client_id, v_credits, 'package_grant', v_package_id,
    'הקצאת קרדיטים ברכישת ' || v_package_name,
    gen_random_uuid(), auth.uid()
  );

  for v_item in select value from jsonb_array_elements(p_installments)
  loop
    v_index := v_index + 1;
    if nullif(v_item ->> 'due_on', '') is null
       or (v_item ->> 'amount_before_vat')::numeric <= 0 then
      raise exception 'פרטי התשלום % אינם תקינים.', v_index;
    end if;

    insert into public.package_installments (
      customer_package_id, installment_number, due_on,
      amount_before_vat, vat_rate_snapshot, amount_due
    )
    values (
      v_package_id, v_index, (v_item ->> 'due_on')::date,
      (v_item ->> 'amount_before_vat')::numeric,
      v_vat,
      round((v_item ->> 'amount_before_vat')::numeric * (1 + v_vat), 2)
    )
    returning id into v_installment_id;

    insert into public.financial_obligations (
      package_installment_id, amount_due, due_on, status, created_by
    )
    select v_installment_id, installment.amount_due,
           installment.due_on, 'pending', auth.uid()
    from public.package_installments as installment
    where installment.id = v_installment_id
    returning id into v_obligation_id;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'installment_id', v_installment_id,
      'obligation_id', v_obligation_id,
      'due_on', v_item ->> 'due_on'
    ));
  end loop;

  for v_item in select value from jsonb_array_elements(v_benefits)
  loop
    if nullif(v_item ->> 'key', '') is null
       or nullif(v_item ->> 'label', '') is null
       or nullif(v_item ->> 'unit', '') is null
       or (v_item ->> 'quantity')::numeric <= 0 then
      raise exception 'הטבה בחבילה אינה תקינה.';
    end if;
    insert into public.package_benefit_ledger (
      customer_package_id, benefit_key, label_snapshot,
      quantity_delta, unit_snapshot, reason, idempotency_key, created_by
    )
    values (
      v_package_id, v_item ->> 'key', v_item ->> 'label',
      (v_item ->> 'quantity')::numeric, v_item ->> 'unit',
      'הקצאת הטבה בחבילת ' || v_package_name,
      gen_random_uuid(), auth.uid()
    );
  end loop;

  v_result := jsonb_build_object(
    'customer_package_id', v_package_id,
    'credits_granted', v_credits,
    'credit_balance_after', (
      select coalesce(sum(delta), 0)
      from public.credit_ledger
      where client_id = p_client_id
    ),
    'gross_total', v_gross,
    'installments', v_result
  );
  update private.business_operations
  set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

revoke all on function public.purchase_customer_package(text, uuid, text, integer, integer, numeric, date, date, jsonb, jsonb, text, uuid)
  from public, anon;
grant execute on function public.purchase_customer_package(text, uuid, text, integer, integer, numeric, date, date, jsonb, jsonb, text, uuid)
  to authenticated;

create or replace function public.adjust_package_benefit(
  p_customer_package_id uuid,
  p_benefit_key text,
  p_label text,
  p_quantity_delta numeric,
  p_unit text,
  p_reason text,
  p_idempotency_key uuid
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_package public.customer_packages%rowtype;
  v_balance numeric(12, 2);
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_benefit_key is null or length(btrim(p_benefit_key)) = 0
     or p_label is null or length(btrim(p_label)) = 0
     or p_unit is null or length(btrim(p_unit)) = 0
     or p_quantity_delta is null or p_quantity_delta = 0
     or p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'פרטי תנועת ההטבה אינם תקינים.';
  end if;

  v_cached := private.claim_business_operation(
    p_idempotency_key, 'adjust_package_benefit',
    pg_catalog.md5(concat_ws(':', p_customer_package_id, p_benefit_key,
      p_label, p_quantity_delta, p_unit, p_reason))
  );
  if v_cached is not null then
    return (v_cached ->> 'benefit_balance')::numeric;
  end if;

  select * into v_package from public.customer_packages
  where id = p_customer_package_id for update;
  if not found then
    raise exception 'החבילה של הלקוח לא נמצאה.';
  end if;

  select coalesce(sum(quantity_delta), 0) into v_balance
  from public.package_benefit_ledger
  where customer_package_id = p_customer_package_id
    and benefit_key = p_benefit_key;
  if v_balance + p_quantity_delta < 0 then
    raise exception 'אין די הטבות זמינות לביצוע הפעולה.';
  end if;

  insert into public.package_benefit_ledger (
    customer_package_id, benefit_key, label_snapshot,
    quantity_delta, unit_snapshot, reason, idempotency_key, created_by
  )
  values (
    p_customer_package_id, btrim(p_benefit_key), btrim(p_label),
    p_quantity_delta, btrim(p_unit), btrim(p_reason),
    p_idempotency_key, auth.uid()
  );

  v_balance := v_balance + p_quantity_delta;
  update private.business_operations
  set response = jsonb_build_object('benefit_balance', v_balance)
  where idempotency_key = p_idempotency_key;
  return v_balance;
end;
$function$;

revoke all on function public.adjust_package_benefit(uuid, text, text, numeric, text, text, uuid)
  from public, anon;
grant execute on function public.adjust_package_benefit(uuid, text, text, numeric, text, text, uuid)
  to authenticated;

create or replace function public.update_business_order(
  p_order_id text,
  p_expected_updated_at timestamptz,
  p_client_id text,
  p_publication_date date,
  p_section text,
  p_notes text,
  p_sheet_number text,
  p_legacy_amount numeric,
  p_cash_amount_before_vat numeric,
  p_credits_used integer,
  p_product_id uuid,
  p_due_on date,
  p_update_due_on boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_order public.orders%rowtype;
  v_obligation public.financial_obligations%rowtype;
  v_product public.product_catalog%rowtype;
  v_original_client_id text;
  v_legacy_amount numeric(12, 2);
  v_cash_amount numeric(12, 2);
  v_credits integer;
  v_gross_amount numeric(12, 2);
  v_credit_delta integer;
  v_updated_at timestamptz;
  v_result jsonb;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_order_id is null or p_expected_updated_at is null
     or p_client_id is null or p_publication_date is null
     or p_section is null or length(btrim(p_section)) = 0
     or length(btrim(p_section)) > 120
     or p_notes is null or length(p_notes) > 5000
     or (p_sheet_number is not null and length(btrim(p_sheet_number)) > 80)
     or p_update_due_on is null then
    raise exception 'פרטי ההזמנה אינם תקינים.';
  end if;
  if p_legacy_amount is not null
     and (p_legacy_amount <= 0 or p_legacy_amount > 99999999
       or round(p_legacy_amount, 2) <> p_legacy_amount) then
    raise exception 'הסכום הכספי אינו תקין.';
  end if;
  if p_cash_amount_before_vat is not null
     and (p_cash_amount_before_vat <= 0
       or p_cash_amount_before_vat > 99999999
       or round(p_cash_amount_before_vat, 2) <> p_cash_amount_before_vat) then
    raise exception 'המחיר לפני מע"מ אינו תקין.';
  end if;
  if p_credits_used is not null and p_credits_used <= 0 then
    raise exception 'כמות הקרדיטים חייבת להיות חיובית.';
  end if;

  v_cached := private.claim_business_operation(
    p_idempotency_key,
    'update_business_order',
    pg_catalog.md5(jsonb_build_object(
      'order_id', p_order_id,
      'expected_updated_at', p_expected_updated_at,
      'client_id', p_client_id,
      'publication_date', p_publication_date,
      'section', p_section,
      'notes', p_notes,
      'sheet_number', p_sheet_number,
      'legacy_amount', p_legacy_amount,
      'cash_amount_before_vat', p_cash_amount_before_vat,
      'credits_used', p_credits_used,
      'product_id', p_product_id,
      'due_on', p_due_on,
      'update_due_on', p_update_due_on
    )::text)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select client_id into v_original_client_id
  from public.orders
  where id = p_order_id;
  if not found then
    raise exception 'ההזמנה לא נמצאה.';
  end if;

  perform clients.id
  from public.clients as clients
  where clients.id in (v_original_client_id, p_client_id)
  order by clients.id
  for update;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then
    raise exception 'ההזמנה לא נמצאה.';
  end if;
  if v_order.updated_at is distinct from p_expected_updated_at then
    raise exception using
      errcode = '40001',
      message = 'ההזמנה השתנתה אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
  end if;
  if v_order.client_id is distinct from v_original_client_id then
    raise exception using
      errcode = '40001',
      message = 'ההזמנה השתנתה אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'הלקוח שנבחר אינו קיים.';
  end if;
  if p_product_id is not null then
    if v_order.billing_mode = 'legacy' then
      raise exception 'אי אפשר לשייך מוצר להזמנה היסטורית ללא המרה מפורשת.';
    end if;
    select * into v_product
    from public.product_catalog
    where id = p_product_id and is_active
    for share;
    if not found or v_product.credit_cost is null
       or v_product.base_price_before_vat is null then
      raise exception 'המוצר אינו פעיל או שחסרים לו ערכי מחיר מאומתים.';
    end if;
  end if;

  if v_order.billing_mode = 'legacy' then
    if p_cash_amount_before_vat is not null or p_credits_used is not null
       or p_product_id is not null then
      raise exception 'אי אפשר לשנות חיוב או מוצר של הזמנה היסטורית ללא המרתה המפורשת.';
    end if;
    if (p_legacy_amount is not null and p_legacy_amount <> v_order.amount)
       or p_update_due_on then
      select * into v_obligation
      from public.financial_obligations
      where order_id = v_order.id
      for update;
      if not found then
        raise exception 'חסר חיוב להזמנה ההיסטורית; נדרשת בדיקת נתונים לפני עריכה.';
      end if;
      if p_legacy_amount is not null
         and p_legacy_amount <> v_order.amount
         and v_obligation.status <> 'pending' then
        raise exception 'אי אפשר לשנות סכום של הזמנה שסומנה כשולמה.';
      end if;
      if p_legacy_amount is not null and p_legacy_amount <> v_order.amount then
        if exists (select 1 from public.payments where order_id = v_order.id)
           or exists (
             select 1
             from public.business_payment_events as events
             where events.obligation_id = v_obligation.id
           ) then
          raise exception 'אי אפשר לשנות סכום לאחר שנרשמה היסטוריית תשלום; יש לבצע פעולת התאמה מתועדת.';
        end if;
        v_legacy_amount := p_legacy_amount;
        update public.financial_obligations
        set amount_due = v_legacy_amount
        where id = v_obligation.id;
      end if;
      if p_update_due_on then
        update public.financial_obligations
        set due_on = p_due_on
        where id = v_obligation.id;
      end if;
    end if;
  elsif v_order.billing_mode = 'cash' then
    if p_legacy_amount is not null or p_credits_used is not null then
      raise exception 'סוג החיוב של הזמנה קיימת אינו ניתן להחלפה בעריכה רגילה.';
    end if;
    if p_cash_amount_before_vat is not null or p_product_id is not null
       or p_update_due_on then
      select * into v_obligation
      from public.financial_obligations
      where order_id = v_order.id
      for update;
      if not found then
        raise exception 'חסר חיוב להזמנה; נדרשת בדיקת נתונים לפני עריכה.';
      end if;
      if v_obligation.status <> 'pending'
         and (p_cash_amount_before_vat is not null or p_product_id is not null) then
        raise exception 'אי אפשר לשנות מחיר או מוצר של הזמנה שסומנה כשולמה.';
      end if;
      if (p_cash_amount_before_vat is not null or p_product_id is not null)
         and (
           exists (select 1 from public.payments where order_id = v_order.id)
           or exists (
             select 1 from public.business_payment_events as events
             where events.obligation_id = v_obligation.id
           )
         ) then
        raise exception 'אי אפשר לשנות מחיר או מוצר לאחר שנרשמה היסטוריית תשלום.';
      end if;
      if p_cash_amount_before_vat is not null then
        if v_order.vat_rate_snapshot is null then
          raise exception 'חסר צילום שיעור מע"מ להזמנה.';
        end if;
        v_cash_amount := p_cash_amount_before_vat;
        v_gross_amount := round(v_cash_amount * (1 + v_order.vat_rate_snapshot), 2);
        if v_gross_amount <= 0 or v_gross_amount > 99999999 then
          raise exception 'הסכום הכולל לאחר מע"מ אינו תקין.';
        end if;
        update public.financial_obligations
        set amount_due = v_gross_amount
        where id = v_obligation.id;
      end if;
      if p_update_due_on then
        update public.financial_obligations
        set due_on = p_due_on
        where id = v_obligation.id;
      end if;
    end if;
  elsif v_order.billing_mode = 'credits' then
    if p_legacy_amount is not null or p_cash_amount_before_vat is not null
       or p_update_due_on then
      raise exception 'הזמנת קרדיטים אינה כוללת חיוב כספי או מועד פירעון.';
    end if;
    v_credits := coalesce(p_credits_used, v_order.credits_used);
    if v_credits is null or v_credits <= 0 then
      raise exception 'כמות הקרדיטים בהזמנה אינה תקינה.';
    end if;

    if v_order.client_id <> p_client_id
       or v_credits <> v_order.credits_used then
      if v_order.client_id = p_client_id then
        v_credit_delta := v_order.credits_used - v_credits;
        if v_credit_delta <> 0 then
          insert into public.credit_ledger (
            client_id, delta, entry_type, order_id, reason,
            idempotency_key, created_by
          )
          values (
            p_client_id, v_credit_delta, 'correction', v_order.id,
            'תיקון ניצול קרדיטים בעקבות עריכת הזמנה ' || v_order.order_number,
            gen_random_uuid(), auth.uid()
          );
        end if;
      else
        if v_order.credits_used <> 0 then
          insert into public.credit_ledger (
            client_id, delta, entry_type, order_id, reason,
            idempotency_key, created_by
          )
          values (
            v_order.client_id, v_order.credits_used, 'correction', v_order.id,
            'העברת שיוך לקוח בהזמנה ' || v_order.order_number,
            gen_random_uuid(), auth.uid()
          );
        end if;
        if v_credits <> 0 then
          insert into public.credit_ledger (
            client_id, delta, entry_type, order_id, reason,
            idempotency_key, created_by
          )
          values (
            p_client_id, -v_credits, 'correction', v_order.id,
            'העברת שיוך לקוח בהזמנה ' || v_order.order_number,
            gen_random_uuid(), auth.uid()
          );
        end if;
      end if;
    end if;
  else
    raise exception 'סוג החיוב של ההזמנה אינו מוכר.';
  end if;

  update public.orders
  set client_id = p_client_id,
      publication_date = p_publication_date,
      section = btrim(p_section),
      notes = p_notes,
      sheet_number = nullif(btrim(coalesce(p_sheet_number, '')), ''),
      amount = case
        when v_order.billing_mode = 'legacy' and p_legacy_amount is not null
          then p_legacy_amount
        when v_order.billing_mode = 'cash' and p_cash_amount_before_vat is not null
          then v_gross_amount
        else amount
      end,
      cash_amount_before_vat = case
        when v_order.billing_mode = 'cash' and p_cash_amount_before_vat is not null
          then p_cash_amount_before_vat
        else cash_amount_before_vat
      end,
      credits_used = case
        when v_order.billing_mode = 'credits' then v_credits
        else credits_used
      end,
      product_id = case when p_product_id is not null then p_product_id else product_id end,
      product_name_snapshot = case
        when p_product_id is not null then v_product.name
        else product_name_snapshot
      end,
      product_dimensions_snapshot = case
        when p_product_id is not null then v_product.dimensions
        else product_dimensions_snapshot
      end,
      product_price_snapshot = case
        when p_product_id is not null then v_product.base_price_before_vat
        else product_price_snapshot
      end,
      product_credit_cost_snapshot = case
        when p_product_id is not null then v_product.credit_cost
        else product_credit_cost_snapshot
      end
  where id = v_order.id
  returning updated_at into v_updated_at;

  v_result := jsonb_build_object(
    'id', v_order.id,
    'updated_at', v_updated_at,
    'billing_mode', v_order.billing_mode,
    'amount', case
      when v_order.billing_mode = 'legacy' then coalesce(p_legacy_amount, v_order.amount)
      when v_order.billing_mode = 'cash' then coalesce(v_gross_amount, v_order.amount)
      else 0
    end,
    'credits_used', case
      when v_order.billing_mode = 'credits' then v_credits
      else null
    end
  );
  update private.business_operations
  set response = v_result
  where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

revoke all on function public.update_business_order(
  text, timestamptz, text, date, text, text, text, numeric, numeric,
  integer, uuid, date, boolean, uuid
) from public, anon;
grant execute on function public.update_business_order(
  text, timestamptz, text, date, text, text, text, numeric, numeric,
  integer, uuid, date, boolean, uuid
) to authenticated;

create or replace function public.delete_business_order(
  p_order_id text,
  p_expected_updated_at timestamptz,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_order public.orders%rowtype;
  v_obligation_id uuid;
  v_result jsonb;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_order_id is null or p_expected_updated_at is null
     or p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'נדרש מזהה גרסה והסבר למחיקת הזמנה.';
  end if;

  v_cached := private.claim_business_operation(
    p_idempotency_key,
    'delete_business_order',
    pg_catalog.md5(jsonb_build_object(
      'order_id', p_order_id,
      'expected_updated_at', p_expected_updated_at,
      'reason', p_reason
    )::text)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then
    raise exception 'ההזמנה לא נמצאה.';
  end if;
  if v_order.updated_at is distinct from p_expected_updated_at then
    raise exception using
      errcode = '40001',
      message = 'ההזמנה השתנתה אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
  end if;
  if v_order.billing_mode <> 'legacy' or v_order.payment_status <> 'pending' then
    raise exception 'אפשר למחוק רק הזמנה היסטורית שלא סומנה כשולמה; הזמנות עסקיות נשמרות לצורכי תיעוד.';
  end if;
  if exists (select 1 from public.payments where order_id = v_order.id)
     or exists (select 1 from public.business_payment_events as events
       join public.financial_obligations as obligations
         on obligations.id = events.obligation_id
       where obligations.order_id = v_order.id)
     or exists (select 1 from public.credit_ledger where order_id = v_order.id)
     or exists (select 1 from public.credit_cash_conversions where order_id = v_order.id) then
    raise exception 'להזמנה יש היסטוריית תשלומים או קרדיטים; לא ניתן למחוק אותה.';
  end if;

  select id into v_obligation_id
  from public.financial_obligations
  where order_id = v_order.id
  for update;
  if not found then
    raise exception 'חסר חיוב להזמנה; נדרשת בדיקת נתונים לפני מחיקה.';
  end if;

  delete from public.financial_obligations where id = v_obligation_id;
  delete from public.orders where id = v_order.id;

  v_result := jsonb_build_object('id', v_order.id, 'deleted', true);
  update private.business_operations
  set response = v_result
  where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

revoke all on function public.delete_business_order(text, timestamptz, text, uuid)
  from public, anon;
grant execute on function public.delete_business_order(text, timestamptz, text, uuid)
  to authenticated;

create or replace function public.set_obligation_paid(
  p_obligation_id uuid,
  p_is_paid boolean,
  p_reason text,
  p_expected_updated_at timestamptz,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_obligation public.financial_obligations%rowtype;
  v_order_id text;
  v_order_updated_at timestamptz;
  v_event_type text;
  v_event_amount numeric(12, 2);
  v_recorded_payments numeric(12, 2);
  v_recorded_business_events numeric(12, 2);
  v_recorded_total numeric(12, 2);
  v_result jsonb;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_is_paid is null then
    raise exception 'יש לבחור סטטוס תשלום.';
  end if;
  if p_expected_updated_at is null then
    raise exception 'חסר מזהה הגרסה של החיוב. יש לרענן את הנתונים.';
  end if;
  if not p_is_paid and (p_reason is null or length(btrim(p_reason)) < 3) then
    raise exception 'נדרש הסבר קצר לפתיחה מחדש של תשלום שסומן כשולם.';
  end if;

  v_cached := private.claim_business_operation(
    p_idempotency_key, 'set_obligation_paid',
    pg_catalog.md5(concat_ws(':', p_obligation_id, p_is_paid, p_reason, p_expected_updated_at))
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select order_id into v_order_id
  from public.financial_obligations
  where id = p_obligation_id;
  if not found then
    raise exception 'החיוב לא נמצא.';
  end if;

  if v_order_id is not null then
    select updated_at into v_order_updated_at
    from public.orders
    where id = v_order_id
    for update;
    if not found then
      raise exception 'ההזמנה המשויכת לחיוב אינה קיימת.';
    end if;
    if v_order_updated_at is distinct from p_expected_updated_at then
      raise exception using
        errcode = '40001',
        message = 'ההזמנה השתנתה אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
    end if;
  end if;

  select * into v_obligation from public.financial_obligations
  where id = p_obligation_id for update;
  if not found then
    raise exception 'החיוב אינו קיים עוד.';
  end if;
  if v_obligation.order_id is null
     and v_obligation.updated_at is distinct from p_expected_updated_at then
    raise exception using
      errcode = '40001',
      message = 'החיוב השתנה אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
  end if;

  select coalesce(sum(payments.amount), 0) into v_recorded_payments
  from public.payments as payments
  where payments.order_id = v_obligation.order_id;
  select coalesce(sum(events.amount), 0) into v_recorded_business_events
  from public.business_payment_events as events
  where events.obligation_id = p_obligation_id;
  v_recorded_total := v_recorded_payments + v_recorded_business_events;

  if (v_obligation.status = 'paid') = p_is_paid then
    v_result := jsonb_build_object(
      'obligation_id', p_obligation_id,
      'status', v_obligation.status,
      'changed', false
    );
  else
    if p_is_paid then
      if v_recorded_total < 0 or v_recorded_total > v_obligation.amount_due then
        raise exception 'תנועות התשלום הקיימות אינן תואמות לסכום החיוב. נדרשת התאמה ידנית לפני עדכון.';
      end if;
      if v_recorded_total > 0 and v_recorded_total < v_obligation.amount_due then
        raise exception 'נמצאו תשלומים קודמים חלקיים. מנגנון זה אינו תומך בתשלומים חלקיים; נדרשת התאמה ידנית.';
      end if;
      update public.financial_obligations
      set status = 'paid', legacy_snapshot = false,
          paid_at = pg_catalog.now(), paid_by = auth.uid()
      where id = p_obligation_id;
      if v_recorded_total = 0 then
        v_event_type := 'payment';
        v_event_amount := v_obligation.amount_due;
      else
        v_event_type := null;
      end if;
    else
      if v_recorded_total < 0 or v_recorded_total > v_obligation.amount_due then
        raise exception 'תנועות התשלום הקיימות אינן תואמות לסכום החיוב. נדרשת התאמה ידנית לפני עדכון.';
      end if;
      update public.financial_obligations
      set status = 'pending', legacy_snapshot = false,
          paid_at = null, paid_by = null
      where id = p_obligation_id;
      if v_recorded_total > 0 then
        if v_recorded_total <> v_obligation.amount_due then
          raise exception 'נמצאו תשלומים חלקיים. נדרשת התאמה ידנית לפני פתיחת החיוב מחדש.';
        end if;
        v_event_type := 'reversal';
        v_event_amount := -v_recorded_total;
      elsif v_obligation.legacy_snapshot and v_obligation.status = 'paid' then
        v_event_type := 'status_correction';
        v_event_amount := 0;
      else
        raise exception 'חסר אירוע תשלום לחיוב שסומן כשולם. נדרשת בדיקת היסטוריה לפני שינוי הסטטוס.';
      end if;
    end if;

    if v_event_type is not null then
      insert into public.business_payment_events (
        obligation_id, event_type, amount, notes, idempotency_key, created_by
      )
      values (
        p_obligation_id, v_event_type, v_event_amount,
        coalesce(nullif(btrim(p_reason), ''), 'עדכון סטטוס תשלום'),
        p_idempotency_key, auth.uid()
      );
    end if;

    v_result := jsonb_build_object(
      'obligation_id', p_obligation_id,
      'status', case when p_is_paid then 'paid' else 'pending' end,
      'changed', true
    );
  end if;

  if v_obligation.order_id is not null then
    update public.orders
    set payment_status = case when p_is_paid then 'paid' else 'pending' end
    where id = v_obligation.order_id
      and payment_status is distinct from case when p_is_paid then 'paid' else 'pending' end
    returning updated_at into v_order_updated_at;
    if not found then
      select updated_at into v_order_updated_at
      from public.orders
      where id = v_obligation.order_id;
    end if;
  else
    select updated_at into v_order_updated_at
    from public.financial_obligations
    where id = p_obligation_id;
  end if;
  v_result := v_result || jsonb_build_object('updated_at', v_order_updated_at);

  update private.business_operations
  set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

revoke all on function public.set_obligation_paid(uuid, boolean, text, timestamptz, uuid)
  from public, anon;
grant execute on function public.set_obligation_paid(uuid, boolean, text, timestamptz, uuid)
  to authenticated;

create or replace function public.adjust_client_credits(
  p_client_id text,
  p_delta integer,
  p_reason text,
  p_idempotency_key uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_client public.clients%rowtype;
  v_balance bigint;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_delta is null or p_delta = 0 or p_reason is null
     or length(btrim(p_reason)) < 3 then
    raise exception 'תנועת תיקון קרדיטים מחייבת כמות שאינה אפס והסבר.';
  end if;

  v_cached := private.claim_business_operation(
    p_idempotency_key, 'adjust_client_credits',
    pg_catalog.md5(concat_ws(':', p_client_id, p_delta, p_reason))
  );
  if v_cached is not null then
    return (v_cached ->> 'credit_balance')::bigint;
  end if;

  select * into v_client from public.clients
  where id = p_client_id for update;
  if not found then
    raise exception 'הלקוח לא נמצא.';
  end if;

  insert into public.credit_ledger (
    client_id, delta, entry_type, reason, idempotency_key, created_by
  )
  values (p_client_id, p_delta, 'correction', btrim(p_reason), p_idempotency_key, auth.uid());

  select coalesce(sum(delta), 0) into v_balance
  from public.credit_ledger where client_id = p_client_id;
  update private.business_operations
  set response = jsonb_build_object('credit_balance', v_balance)
  where idempotency_key = p_idempotency_key;
  return v_balance;
end;
$function$;

revoke all on function public.adjust_client_credits(text, integer, text, uuid) from public, anon;
grant execute on function public.adjust_client_credits(text, integer, text, uuid) to authenticated;

create or replace function public.convert_credit_orders_to_cash(
  p_items jsonb,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_item jsonb;
  v_order public.orders%rowtype;
  v_vat numeric(5, 4);
  v_cash numeric(12, 2);
  v_gross numeric(12, 2);
  v_due_on date;
  v_obligation uuid;
  v_result jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 250
     or p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'נדרשות הזמנות והסבר תקין להמרה.';
  end if;

  v_cached := private.claim_business_operation(
    p_idempotency_key, 'convert_credit_orders_to_cash',
    pg_catalog.md5(p_items::text || ':' || p_reason)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  if (
    select count(*) <> count(distinct item ->> 'order_id')
    from jsonb_array_elements(p_items) as source(item)
  ) then
    raise exception 'הבקשה מכילה הזמנה כפולה.';
  end if;

  perform clients.id
  from public.clients as clients
  where clients.id in (
    select orders.client_id
    from public.orders as orders
    join jsonb_array_elements(p_items) as source(item)
      on orders.id = source.item ->> 'order_id'
  )
  order by clients.id
  for update;

  select vat_rate into v_vat from public.business_settings where singleton;
  if v_vat is null then
    raise exception 'הגדרת המע"מ חסרה.';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    select * into v_order from public.orders
    where id = v_item ->> 'order_id'
    for update;
    if not found or v_order.billing_mode <> 'credits'
       or v_order.credits_used is null or v_order.credits_used <= 0 then
      raise exception 'הזמנה % אינה הזמנת קרדיטים שניתנת להמרה.', v_count;
    end if;
    v_cash := nullif(v_item ->> 'cash_amount_before_vat', '')::numeric;
    if v_cash is null or v_cash <= 0 then
      raise exception 'לכל הזמנה יש להזין מחיר שאושר בפועל; לא חושב מחיר המרה אוטומטי.';
    end if;
    v_due_on := nullif(v_item ->> 'due_on', '')::date;
    v_gross := round(v_cash * (1 + v_vat), 2);

    insert into public.credit_cash_conversions (
      order_id, original_credits, approved_price_before_vat,
      vat_rate_snapshot, gross_amount, due_on, reason,
      idempotency_key, converted_by
    )
    values (
      v_order.id, v_order.credits_used, v_cash,
      v_vat, v_gross, v_due_on, btrim(p_reason),
      p_idempotency_key, auth.uid()
    );

    insert into public.credit_ledger (
      client_id, delta, entry_type, reason, idempotency_key, created_by
    )
    values (
      v_order.client_id, v_order.credits_used, 'conversion_reversal',
      'החזרת קרדיטים בהמרת הזמנה ' || v_order.order_number || ': ' || btrim(p_reason),
      gen_random_uuid(), auth.uid()
    );

    update public.orders
    set billing_mode = 'cash',
        cash_amount_before_vat = v_cash,
        credits_used = null,
        vat_rate_snapshot = v_vat,
        amount = v_gross,
        payment_status = 'pending'
    where id = v_order.id;

    insert into public.financial_obligations (
      order_id, amount_due, due_on, status, created_by
    )
    values (v_order.id, v_gross, v_due_on, 'pending', auth.uid())
    returning id into v_obligation;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'order_id', v_order.id, 'order_number', v_order.order_number,
      'credits_returned', v_order.credits_used,
      'gross_amount', v_gross, 'obligation_id', v_obligation
    ));
  end loop;

  update private.business_operations
  set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

revoke all on function public.convert_credit_orders_to_cash(jsonb, text, uuid)
  from public, anon;
grant execute on function public.convert_credit_orders_to_cash(jsonb, text, uuid)
  to authenticated;

-- Read access for approved users only; all writes to new ledgers/obligations
-- are performed by the security-definer RPCs above.
do $policies$
declare
  v_table text;
begin
  foreach v_table in array array[
    'business_settings', 'product_catalog', 'package_catalog',
    'customer_packages', 'package_installments', 'financial_obligations',
    'business_payment_events', 'credit_ledger', 'package_benefit_ledger',
    'credit_cash_conversions', 'business_audit_log'
  ]
  loop
    execute pg_catalog.format(
      'alter table public.%I enable row level security', v_table
    );
    execute pg_catalog.format(
      'alter table public.%I force row level security', v_table
    );
    execute pg_catalog.format(
      'revoke all on table public.%I from public, anon, authenticated', v_table
    );
    execute pg_catalog.format(
      'grant select on table public.%I to authenticated', v_table
    );
    execute pg_catalog.format(
      'drop policy if exists %I on public.%I',
      'approved_read_' || v_table, v_table
    );
    execute pg_catalog.format(
      'create policy %I on public.%I for select to authenticated using ((select private.is_approved_user()))',
      'approved_read_' || v_table, v_table
    );
  end loop;
end;
$policies$;

-- Keep reads behind the existing approved-user policies. All order writes,
-- including payment status, are restricted to reviewed RPCs.
alter table public.clients enable row level security;
alter table public.clients force row level security;
alter table public.orders enable row level security;
alter table public.orders force row level security;
alter table public.payments enable row level security;
alter table public.payments force row level security;

revoke all on table public.clients, public.orders, public.payments
  from public, anon, authenticated;
grant select on table public.clients, public.orders, public.payments
  to authenticated;
grant insert (id, name, phone, email) on table public.clients to authenticated;
grant update (name, phone, email, internal_notes)
  on table public.clients to authenticated;

drop policy if exists "approved users only clients" on public.clients;
create policy "approved users only clients"
  on public.clients as restrictive
  for all to authenticated
  using ((select private.is_approved_user()))
  with check ((select private.is_approved_user()));

drop policy if exists "approved users only orders" on public.orders;
create policy "approved users only orders"
  on public.orders as restrictive
  for all to authenticated
  using ((select private.is_approved_user()))
  with check ((select private.is_approved_user()));

drop policy if exists "approved users only payments" on public.payments;
create policy "approved users only payments"
  on public.payments as restrictive
  for all to authenticated
  using ((select private.is_approved_user()))
  with check ((select private.is_approved_user()));

-- Shared audit history for legacy CRUD as well as future RPCs.
drop trigger if exists clients_business_audit on public.clients;
create trigger clients_business_audit
  after insert or update or delete on public.clients
  for each row execute function private.write_business_audit();

drop trigger if exists orders_business_audit on public.orders;
create trigger orders_business_audit
  after insert or update or delete on public.orders
  for each row execute function private.write_business_audit();

create or replace view public.business_order_financial_summary
with (security_invoker = true)
as
select
  orders.id as order_id,
  orders.client_id,
  orders.order_number,
  orders.publication_date,
  orders.section,
  orders.sheet_number,
  orders.billing_mode,
  case when orders.billing_mode = 'credits' then 0::numeric
       else coalesce(obligations.amount_due, orders.amount)::numeric end as cash_due,
  case
    when orders.billing_mode = 'credits' then 0::numeric
    when payments.payment_count + events.event_count = 0
      and obligations.legacy_snapshot
      and obligations.status = 'paid'
      then obligations.amount_due
    else payments.received + events.received
  end as cash_received,
  coalesce(obligations.due_on, null::date) as due_on,
  coalesce(obligations.status, orders.payment_status) as payment_status,
  coalesce(obligations.legacy_snapshot, orders.billing_mode = 'legacy') as legacy_snapshot,
  case
    when payments.payment_count > 0 and events.event_count > 0 then 'combined_records'
    when payments.payment_count > 0 then 'public_payments'
    when events.event_count > 0 then 'business_payment_events'
    when obligations.legacy_snapshot and obligations.status = 'paid'
      then 'legacy_paid_status_without_receipt_date'
    else 'no_receipt_record'
  end as receipt_basis,
  payments.payment_count > 0 or events.event_count > 0 as has_payment_history,
  obligations.id is null and orders.billing_mode <> 'credits' as missing_obligation,
  (
    (coalesce(obligations.status, orders.payment_status) = 'paid'
      and case when orders.billing_mode = 'credits' then 0::numeric
               else coalesce(obligations.amount_due, orders.amount)::numeric end >
          case
            when orders.billing_mode = 'credits' then 0::numeric
            when payments.payment_count + events.event_count = 0
              and obligations.legacy_snapshot and obligations.status = 'paid'
              then obligations.amount_due
            else payments.received + events.received
          end)
    or
    (coalesce(obligations.status, orders.payment_status) = 'pending'
      and case when orders.billing_mode = 'credits' then 0::numeric
               else coalesce(obligations.amount_due, orders.amount)::numeric end > 0
      and case
            when orders.billing_mode = 'credits' then 0::numeric
            when payments.payment_count + events.event_count = 0
              and obligations.legacy_snapshot and obligations.status = 'paid'
              then obligations.amount_due
            else payments.received + events.received
          end >= coalesce(obligations.amount_due, orders.amount))
  ) as payment_status_mismatch
from public.orders as orders
left join public.financial_obligations as obligations
  on obligations.order_id = orders.id
left join lateral (
  select coalesce(sum(payments.amount), 0)::numeric(12, 2) as received,
         count(*)::integer as payment_count
  from public.payments as payments
  where payments.order_id = orders.id
) as payments on true
left join lateral (
  select coalesce(sum(events.amount), 0)::numeric(12, 2) as received,
         count(*)::integer as event_count
  from public.business_payment_events as events
  where events.obligation_id = obligations.id
) as events on true;

create or replace view public.business_financial_summary
with (security_invoker = true)
as
select
  'order'::text as item_type,
  orders.order_id as item_id,
  orders.client_id,
  orders.order_number,
  orders.sheet_number,
  orders.section as description,
  orders.publication_date as item_date,
  orders.billing_mode,
  orders.cash_due,
  orders.cash_received,
  greatest(orders.cash_due - orders.cash_received, 0)::numeric(12, 2) as cash_outstanding,
  orders.due_on,
  orders.payment_status,
  case when greatest(orders.cash_due - orders.cash_received, 0) > 0
            and orders.due_on < current_date
       then greatest(orders.cash_due - orders.cash_received, 0)
       else 0::numeric end::numeric(12, 2) as overdue_amount,
  case when greatest(orders.cash_due - orders.cash_received, 0) > 0
            and orders.due_on > current_date
       then greatest(orders.cash_due - orders.cash_received, 0)
       else 0::numeric end::numeric(12, 2) as future_amount,
  case when greatest(orders.cash_due - orders.cash_received, 0) > 0
            and orders.due_on = current_date
       then greatest(orders.cash_due - orders.cash_received, 0)
       else 0::numeric end::numeric(12, 2) as due_today_amount,
  case when greatest(orders.cash_due - orders.cash_received, 0) > 0
            and orders.due_on is null
       then greatest(orders.cash_due - orders.cash_received, 0)
       else 0::numeric end::numeric(12, 2) as no_due_date_amount,
  orders.legacy_snapshot,
  orders.receipt_basis,
  orders.has_payment_history,
  orders.missing_obligation,
  orders.payment_status_mismatch
from public.business_order_financial_summary as orders
union all
select
  'package_installment'::text,
  installments.id::text,
  packages.client_id,
  null::bigint,
  null::text,
  packages.package_name_snapshot || ' - תשלום ' || installments.installment_number::text,
  installments.due_on,
  'package'::text,
  obligations.amount_due,
  events.received,
  greatest(obligations.amount_due - events.received, 0)::numeric(12, 2),
  obligations.due_on,
  obligations.status,
  case when greatest(obligations.amount_due - events.received, 0) > 0
            and obligations.due_on < current_date
       then greatest(obligations.amount_due - events.received, 0)
       else 0::numeric end::numeric(12, 2),
  case when greatest(obligations.amount_due - events.received, 0) > 0
            and obligations.due_on > current_date
       then greatest(obligations.amount_due - events.received, 0)
       else 0::numeric end::numeric(12, 2),
  case when greatest(obligations.amount_due - events.received, 0) > 0
            and obligations.due_on = current_date
       then greatest(obligations.amount_due - events.received, 0)
       else 0::numeric end::numeric(12, 2),
  0::numeric(12, 2),
  false,
  case when events.event_count > 0 then 'business_payment_events' else 'no_receipt_record' end,
  events.event_count > 0,
  false,
  false
from public.package_installments as installments
join public.customer_packages as packages
  on packages.id = installments.customer_package_id
join public.financial_obligations as obligations
  on obligations.package_installment_id = installments.id
left join lateral (
  select coalesce(sum(events.amount), 0)::numeric(12, 2) as received,
         count(*)::integer as event_count
  from public.business_payment_events as events
  where events.obligation_id = obligations.id
) as events on true;

create or replace view public.business_financial_totals
with (security_invoker = true)
as
select
  count(*) filter (where item_type = 'order')::bigint as order_count,
  count(*) filter (where item_type = 'package_installment')::bigint as installment_count,
  coalesce(sum(cash_due), 0)::numeric(14, 2) as total_cash_billed,
  coalesce(sum(cash_received), 0)::numeric(14, 2) as total_cash_received,
  coalesce(sum(cash_outstanding), 0)::numeric(14, 2) as total_cash_outstanding,
  coalesce(sum(overdue_amount), 0)::numeric(14, 2) as total_overdue,
  coalesce(sum(future_amount), 0)::numeric(14, 2) as total_future,
  coalesce(sum(due_today_amount), 0)::numeric(14, 2) as total_due_today,
  coalesce(sum(no_due_date_amount), 0)::numeric(14, 2) as total_without_due_date,
  count(*) filter (where legacy_snapshot)::bigint as legacy_order_count,
  count(*) filter (where missing_obligation)::bigint as orders_missing_obligation,
  count(*) filter (where payment_status_mismatch)::bigint as payment_status_mismatches
from public.business_financial_summary;

create or replace view public.business_client_credit_balances
with (security_invoker = true)
as
select clients.id as client_id,
       coalesce(sum(ledger.delta), 0)::bigint as credit_balance
from public.clients as clients
left join public.credit_ledger as ledger
  on ledger.client_id = clients.id
group by clients.id;

grant select on public.business_order_financial_summary,
  public.business_financial_summary, public.business_financial_totals,
  public.business_client_credit_balances to authenticated;
revoke all on public.business_order_financial_summary,
  public.business_financial_summary, public.business_financial_totals,
  public.business_client_credit_balances from public, anon;

-- Make all new table changes visible through Supabase Realtime.
do $realtime$
declare
  v_table text;
begin
  if not exists (
    select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'Supabase Realtime publication is unavailable; enable it before running this migration.';
  end if;

  foreach v_table in array array[
    'clients', 'orders', 'business_settings', 'product_catalog',
    'package_catalog', 'customer_packages', 'package_installments',
    'financial_obligations', 'business_payment_events', 'credit_ledger',
    'package_benefit_ledger', 'credit_cash_conversions', 'business_audit_log'
  ]
  loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute pg_catalog.format(
        'alter publication supabase_realtime add table public.%I', v_table
      );
    end if;
  end loop;
end;
$realtime$;

comment on table public.product_catalog is
  'Editable advertising product catalog. Prices/credit costs must be copied from verified business price sources.';
comment on table public.credit_ledger is
  'Append-only credit balance ledger. Negative balances are allowed; corrections are new entries.';
comment on table public.financial_obligations is
  'One obligation per cash order or package installment. Unpaid obligations without due dates are not classified as overdue.';
comment on table public.business_payment_events is
  'Append-only manual payment/reversal history. No partial payments.';
comment on table public.business_audit_log is
  'Append-only audit records for meaningful client, order, package, catalog, credit, and payment changes.';

commit;
