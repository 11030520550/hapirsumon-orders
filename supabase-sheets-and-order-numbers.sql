-- Sheets (גיליונות) status + business order-number range. REQUIRES APPROVAL. Run after supabase-business-upgrade.sql.
-- 1. Order numbers: new orders continue from the highest existing order_number, and never below 22000.
--    Existing order_number values and all technical IDs/relations are left unchanged.
-- 2. public.sheets: open/closed status per sheet number. Closing a sheet does NOT delete orders and does
--    NOT change any payment status: "closed" (editorial) and "paid" (financial) are independent.
--    A sheet with no row in this table is considered open. Rows are written only by set_sheet_status().
-- Safe to run twice.

begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.credit_ledger') is null
     or pg_catalog.to_regclass('private.order_number_counters') is null then
    raise exception 'Run supabase-business-upgrade.sql first.';
  end if;
end
$preflight$;

-- 1. Order-number range (counter only; no existing row is renumbered)
update private.order_number_counters
set last_number = greatest(
  last_number,
  (select coalesce(max(order_number), 0) from public.orders),
  21999
)
where counter_name = 'orders';

-- 2. Sheet status
create table if not exists public.sheets (
  sheet_number text primary key check (length(btrim(sheet_number)) between 1 and 80),
  status text not null default 'open' check (status in ('open', 'closed')),
  status_reason text not null default '',
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references auth.users (id) on delete set null,
  check ((status = 'closed') = (closed_at is not null))
);

alter table public.sheets enable row level security;
alter table public.sheets force row level security;
revoke all on table public.sheets from public, anon, authenticated;
grant select on table public.sheets to authenticated;
drop policy if exists approved_read_sheets on public.sheets;
create policy approved_read_sheets on public.sheets
  for select to authenticated using ((select private.is_approved_user()));

drop trigger if exists sheets_business_touch_updated_at on public.sheets;
create trigger sheets_business_touch_updated_at
  before update on public.sheets
  for each row execute function private.touch_business_updated_at();
drop trigger if exists sheets_business_audit on public.sheets;
create trigger sheets_business_audit
  after insert or update or delete on public.sheets
  for each row execute function private.write_business_audit();

create or replace function public.set_sheet_status(
  p_sheet_number text,
  p_is_closed boolean,
  p_reason text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sheet text := nullif(btrim(p_sheet_number), '');
  v_existing public.sheets%rowtype;
  v_row public.sheets%rowtype;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if v_sheet is null or p_is_closed is null then
    raise exception 'יש לבחור גיליון וסטטוס.';
  end if;
  if not exists (select 1 from public.orders where btrim(sheet_number) = v_sheet) then
    raise exception 'לגיליון זה אין הזמנות במערכת.';
  end if;
  if not p_is_closed and (p_reason is null or length(btrim(p_reason)) < 3) then
    raise exception 'נדרש הסבר קצר לפתיחה מחדש של גיליון סגור.';
  end if;

  select * into v_existing from public.sheets where sheet_number = v_sheet for update;
  if found and p_expected_updated_at is not null
     and v_existing.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '40001',
      message = 'סטטוס הגיליון השתנה אצל משתמשת אחרת. רענני ונסי שוב.';
  end if;

  insert into public.sheets (sheet_number, status, status_reason, closed_at, closed_by, updated_by)
  values (
    v_sheet,
    case when p_is_closed then 'closed' else 'open' end,
    coalesce(btrim(p_reason), ''),
    case when p_is_closed then pg_catalog.now() else null end,
    case when p_is_closed then auth.uid() else null end,
    auth.uid()
  )
  on conflict (sheet_number) do update
    set status = excluded.status,
        status_reason = excluded.status_reason,
        closed_at = excluded.closed_at,
        closed_by = excluded.closed_by,
        updated_by = excluded.updated_by
  returning * into v_row;

  return jsonb_build_object('sheet_number', v_row.sheet_number, 'status', v_row.status, 'updated_at', v_row.updated_at);
end;
$function$;

revoke all on function public.set_sheet_status(text, boolean, text, timestamptz) from public, anon;
grant execute on function public.set_sheet_status(text, boolean, text, timestamptz) to authenticated;

do $realtime$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sheets'
     ) then
    execute 'alter publication supabase_realtime add table public.sheets';
  end if;
end
$realtime$;

commit;

-- Verification
select (select last_number from private.order_number_counters where counter_name = 'orders') as last_order_number,
       (select max(order_number) from public.orders) as highest_existing_order_number,
       pg_catalog.to_regclass('public.sheets') is not null as sheets_table_installed;
