-- Sheets model v2 — ROLLBACK. REQUIRES THE OWNER'S EXPLICIT APPROVAL (it changes data and permissions).
-- Part 1 undoes STAGE B (enforcement). Part 2 undoes STAGE A (model). Run part 1 alone if only enforcement
-- has to be removed. Orders, payments, obligations and credits are never touched.
--
-- After part 2 the system behaves as before v2: a sheet without a status row counts as OPEN.
--   - Rows created by the backfill (created_via = 'backfill') are deleted, so historical sheets return to
--     their previous state (no row). Rows created by the old set_sheet_status are kept.
--   - Sheets created with "הוספת גיליונות" (created_via = 'planned') that have no orders are deleted; the old
--     UI cannot show a sheet without orders. Planned sheets that already have orders are kept as status rows.
--   - The new columns are kept (harmless to the old UI, and they keep the dates for a later retry). The
--     commented block at the end drops them; that loses the publication dates, closing times and descriptions.
-- Review the counts printed at the end.

-- ============================== Part 1: undo enforcement (stage B) ==============================
begin;
drop trigger if exists orders_enforce_open_sheet on public.orders;
drop function if exists private.enforce_open_sheet();
alter table public.orders drop constraint if exists orders_sheet_number_fkey;
commit;

-- ============================== Part 2: undo the model (stage A) ==============================
begin;

-- The original set_sheet_status (from supabase-sheets-and-order-numbers.sql), restored unchanged.
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

drop function if exists public.set_sheet_state(text, boolean, text, text, timestamptz);
drop function if exists public.update_sheet_details(text, date, text, text, timestamptz);
drop function if exists public.create_sheets_batch(jsonb, uuid);
drop view if exists public.sheet_overview;
drop function if exists private.jerusalem_time(text);

create temporary table sheets_v2_rollback_counts on commit drop as
select
  (select count(*) from public.sheets where created_via = 'backfill') as backfill_rows_deleted,
  (select count(*) from public.sheets s where created_via = 'planned'
     and not exists (select 1 from public.orders o where pg_catalog.btrim(o.sheet_number) = s.sheet_number)) as empty_planned_rows_deleted;

delete from public.sheets where created_via = 'backfill';
delete from public.sheets s
where s.created_via = 'planned'
  and not exists (select 1 from public.orders o where pg_catalog.btrim(o.sheet_number) = s.sheet_number);

select * from sheets_v2_rollback_counts;
commit;

-- Optional, destructive (loses publication dates, closing times and descriptions). Only with explicit approval:
-- begin;
-- alter table public.sheets drop constraint if exists sheets_description_length;
-- alter table public.sheets drop constraint if exists sheets_created_via_check;
-- drop index if exists public.sheets_publication_date_idx;
-- alter table public.sheets drop column if exists publication_date, drop column if exists closes_at,
--   drop column if exists description, drop column if exists created_at, drop column if exists created_by,
--   drop column if exists created_via, drop column if exists reopened_at, drop column if exists reopened_by;
-- commit;
