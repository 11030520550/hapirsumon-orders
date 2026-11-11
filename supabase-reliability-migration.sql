-- Non-destructive support for safe concurrent edits and Realtime refresh.
-- Run in the Supabase SQL Editor as the project owner before deploying app.js.
-- This does not update, delete, or import client/order records and does not
-- change table RLS policies or table grants.

begin;

alter table public.clients
  add column if not exists updated_at timestamptz not null default pg_catalog.now();

alter table public.orders
  add column if not exists updated_at timestamptz not null default pg_catalog.now();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

revoke all on function public.touch_updated_at() from public, anon, authenticated;

drop trigger if exists clients_touch_updated_at on public.clients;
create trigger clients_touch_updated_at
  before update on public.clients
  for each row execute function public.touch_updated_at();

drop trigger if exists orders_touch_updated_at on public.orders;
create trigger orders_touch_updated_at
  before update on public.orders
  for each row execute function public.touch_updated_at();

do $migration$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) then
    raise exception 'Supabase Realtime publication is unavailable; enable Realtime before running this migration.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'clients'
  ) then
    execute 'alter publication supabase_realtime add table public.clients';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    execute 'alter publication supabase_realtime add table public.orders';
  end if;
end;
$migration$;

commit;
