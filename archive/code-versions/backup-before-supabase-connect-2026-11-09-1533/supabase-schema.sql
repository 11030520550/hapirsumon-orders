-- Modaat shared order-management database
-- Run in the Supabase SQL Editor for the new project.
-- No credentials, API keys, or user approvals are included in this file.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- Only project owners/operators using the SQL Editor may manage this allowlist.
-- Never grant this table to anon or authenticated application users.
create table if not exists private.approved_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  approved_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null
);

alter table private.approved_users enable row level security;
alter table private.approved_users force row level security;
revoke all on table private.approved_users from public, anon, authenticated;

-- A fixed search_path and schema-qualified table reference prevent object-shadowing.
create or replace function private.is_approved_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    (select auth.uid()) is not null
    and exists (
      select 1
      from private.approved_users as allowed
      where allowed.user_id = (select auth.uid())
    );
$function$;

revoke all on function private.is_approved_user() from public, anon;
grant execute on function private.is_approved_user() to authenticated;

create table if not exists public.clients (
  id text primary key,
  name text not null check (length(btrim(name)) > 0),
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id text primary key,
  client_id text not null
    references public.clients (id) on update cascade on delete restrict,
  publication_date date not null,
  section text not null check (length(btrim(section)) > 0),
  amount numeric(10, 2) not null check (amount > 0 and amount <= 99999999),
  payment_status text not null default 'pending'
    check (payment_status in ('paid', 'pending')),
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- This table is an append-only ledger for actual payments recorded in the future.
-- Existing local orders have a status, but no payment-event history; do not
-- fabricate payment records when importing them.
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id text not null
    references public.orders (id) on update cascade on delete restrict,
  amount numeric(10, 2) not null check (amount > 0 and amount <= 99999999),
  paid_at timestamptz not null default now(),
  payment_method text,
  reference text,
  notes text not null default '',
  created_by uuid not null default auth.uid()
    references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists orders_client_id_idx on public.orders (client_id);
create index if not exists orders_publication_date_idx on public.orders (publication_date);
create index if not exists orders_payment_status_idx on public.orders (payment_status);
create index if not exists payments_order_id_paid_at_idx on public.payments (order_id, paid_at);

grant usage on schema public to authenticated;

alter table public.clients enable row level security;
alter table public.clients force row level security;
alter table public.orders enable row level security;
alter table public.orders force row level security;
alter table public.payments enable row level security;
alter table public.payments force row level security;

revoke all on table public.clients, public.orders, public.payments
  from public, anon, authenticated;
grant select, insert, update, delete on table public.clients, public.orders
  to authenticated;
grant select, insert on table public.payments to authenticated;

drop policy if exists "approved users can manage clients" on public.clients;
create policy "approved users can manage clients"
  on public.clients
  for all
  to authenticated
  using ((select private.is_approved_user()))
  with check ((select private.is_approved_user()));

drop policy if exists "approved users can manage orders" on public.orders;
create policy "approved users can manage orders"
  on public.orders
  for all
  to authenticated
  using ((select private.is_approved_user()))
  with check ((select private.is_approved_user()));

drop policy if exists "approved users can read payments" on public.payments;
create policy "approved users can read payments"
  on public.payments
  for select
  to authenticated
  using ((select private.is_approved_user()));

drop policy if exists "approved users can record payments" on public.payments;
create policy "approved users can record payments"
  on public.payments
  for insert
  to authenticated
  with check (
    (select private.is_approved_user())
    and created_by = (select auth.uid())
  );

comment on table private.approved_users is
  'Manually managed allowlist. Add only invited, explicitly authorized auth.users IDs.';
comment on table public.clients is
  'Clients shared with every explicitly approved application user.';
comment on table public.orders is
  'Orders retain the current application payment_status and legacy text IDs.';
comment on table public.payments is
  'Append-only payment-event ledger; updates and deletes are intentionally denied.';
