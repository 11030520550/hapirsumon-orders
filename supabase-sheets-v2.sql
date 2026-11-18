-- Sheets model v2 — STAGE A (additive). REQUIRES THE OWNER'S EXPLICIT APPROVAL. Do not run without it.
-- Run order: supabase-sheets-v2-preflight.sql (read only) → THIS FILE → supabase-sheets-v2-verify.sql.
-- Enforcement (FK + closed-sheet trigger) is a separate later file: supabase-sheets-v2-enforce.sql.
--
-- What this file does
--   1. public.sheets becomes the official list of sheets: publication date, closing time (closes_at),
--      description, creation info and reopen info. A sheet can exist with zero orders.
--   2. Backfill: every sheet number already used in orders gets a row.
--      Historical sheets are CLOSED (they were published). Publication date stays EMPTY (never invented).
--      Sheets listed in the keep-open list below are created OPEN. Existing rows are never changed.
--   3. Effective state: a sheet is closed when status = 'closed' (manual) OR closes_at <= now() (deadline,
--      Friday 00:00 Asia/Jerusalem by default). No scheduler is needed; the server clock decides.
--   4. RPCs: create_sheets_batch (all-or-nothing), update_sheet_details, set_sheet_state (close / reopen with a
--      reason and a new future closing time). The old set_sheet_status keeps working for the current UI.
--   5. View public.sheet_overview (read only, RLS of public.sheets applies) with is_closed and the server time.
--
-- What this file does NOT do
--   - No change to orders, payments, obligations, credits or packages.
--   - No blocking of orders yet (that is supabase-sheets-v2-enforce.sql, after the new UI is published).
--   - No renaming or normalising of existing sheet numbers.
--
-- Safe to run twice (a second run adds nothing).

begin;

-- =====================================================================
-- 0. OWNER INPUT — REVIEW BEFORE RUNNING
-- =====================================================================
-- Sheets that must stay OPEN after the migration: the active sheet for orders, and any future sheet that
-- already has orders. Take them from the preflight result (column recent_activity / last_order_date).
-- Replace the placeholder with real numbers, e.g.:  values ('142'), ('143');
-- To keep NO sheet open, delete the whole insert statement (the recent-activity guard below still applies).
create temporary table sheets_v2_keep_open (sheet_number text primary key) on commit drop;
insert into sheets_v2_keep_open (sheet_number) values ('__REPLACE_WITH_THE_ACTIVE_SHEET__');

-- Safety net: the migration stops if it would close a sheet that had orders entered in the last
-- 14 days and is not in the keep-open list. Set to true ONLY after checking that list on purpose.
create temporary table sheets_v2_settings (confirm_close_recent boolean not null) on commit drop;
insert into sheets_v2_settings (confirm_close_recent) values (false);

-- =====================================================================
-- Preflight checks (stop before any change)
-- =====================================================================
do $preflight$
declare
  v_missing text;
  v_recent text;
begin
  if pg_catalog.to_regclass('public.sheets') is null
     or pg_catalog.to_regprocedure('public.set_sheet_status(text, boolean, text, timestamp with time zone)') is null then
    raise exception 'Run supabase-sheets-and-order-numbers.sql first (public.sheets is missing).';
  end if;
  if pg_catalog.to_regprocedure('private.is_approved_user()') is null
     or pg_catalog.to_regprocedure('private.claim_business_operation(uuid, text, text)') is null then
    raise exception 'Run supabase-business-upgrade.sql first.';
  end if;
  if exists (select 1 from sheets_v2_keep_open where sheet_number like '\_\_%') then
    raise exception 'Edit the keep-open list at the top of this file (placeholder still present). Nothing was changed.';
  end if;

  select string_agg(keep.sheet_number, ', ') into v_missing
  from sheets_v2_keep_open as keep
  where not exists (select 1 from public.orders where pg_catalog.btrim(orders.sheet_number) = keep.sheet_number)
    and not exists (select 1 from public.sheets where sheets.sheet_number = keep.sheet_number);
  if v_missing is not null then
    raise exception 'Keep-open sheet(s) not found in orders or sheets: %. Check for typos. Nothing was changed.', v_missing;
  end if;

  if not (select confirm_close_recent from sheets_v2_settings) then
    select string_agg(recent.sheet_number, ', ' order by recent.sheet_number) into v_recent
    from (
      select pg_catalog.btrim(orders.sheet_number) as sheet_number
      from public.orders
      where pg_catalog.btrim(coalesce(orders.sheet_number, '')) <> ''
        and coalesce(orders.entered_at, (orders.created_at at time zone 'Asia/Jerusalem')::date)
            >= (pg_catalog.now() at time zone 'Asia/Jerusalem')::date - 14
      group by 1
    ) as recent
    where not exists (select 1 from sheets_v2_keep_open as keep where keep.sheet_number = recent.sheet_number)
      and not exists (select 1 from public.sheets where sheets.sheet_number = recent.sheet_number);
    if v_recent is not null then
      raise exception 'These sheets had orders in the last 14 days and would be CLOSED: %. Add the active one(s) to the keep-open list, or set confirm_close_recent = true on purpose. Nothing was changed.', v_recent;
    end if;
  end if;
end
$preflight$;

-- =====================================================================
-- 1. Columns
-- =====================================================================
alter table public.sheets
  add column if not exists publication_date date,
  add column if not exists closes_at timestamptz,
  add column if not exists description text not null default '',
  add column if not exists created_at timestamptz not null default pg_catalog.now(),
  add column if not exists created_by uuid references auth.users (id) on delete set null,
  -- status: rows created by the old set_sheet_status; backfill: created by this migration; planned: "הוספת גיליונות".
  add column if not exists created_via text not null default 'status',
  add column if not exists reopened_at timestamptz,
  add column if not exists reopened_by uuid references auth.users (id) on delete set null;

do $constraints$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                 where conrelid = 'public.sheets'::regclass and conname = 'sheets_description_length') then
    alter table public.sheets add constraint sheets_description_length check (pg_catalog.length(description) <= 200);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                 where conrelid = 'public.sheets'::regclass and conname = 'sheets_created_via_check') then
    alter table public.sheets add constraint sheets_created_via_check check (created_via in ('status', 'backfill', 'planned'));
  end if;
end
$constraints$;

create index if not exists sheets_publication_date_idx on public.sheets (publication_date);

comment on column public.sheets.closes_at is
  'Automatic closing time (default: Friday 00:00 Asia/Jerusalem before a Sunday publication). The sheet is closed for orders from this moment, without any scheduler.';
comment on column public.sheets.status is
  'Manual state. closed = closed by a user. Effective state: closed when status = closed OR closes_at <= now() (see public.sheet_overview).';

-- =====================================================================
-- 2. Backfill (only missing rows; existing rows are left exactly as they are)
-- =====================================================================
insert into public.sheets (sheet_number, status, status_reason, closed_at, created_via)
select
  used.sheet_number,
  case when keep.sheet_number is null then 'closed' else 'open' end,
  case when keep.sheet_number is null
    then 'גיליון היסטורי — סומן כסגור במעבר למודל הגיליונות'
    else 'גיליון פעיל — נשאר פתוח במעבר למודל הגיליונות' end,
  case when keep.sheet_number is null then pg_catalog.now() end,
  'backfill'
from (
  select distinct pg_catalog.btrim(orders.sheet_number) as sheet_number
  from public.orders
  where pg_catalog.btrim(coalesce(orders.sheet_number, '')) <> ''
) as used
left join sheets_v2_keep_open as keep on keep.sheet_number = used.sheet_number
where not exists (select 1 from public.sheets where sheets.sheet_number = used.sheet_number);

-- =====================================================================
-- 3. Read model
-- =====================================================================
create or replace view public.sheet_overview
with (security_invoker = true)
as
select
  sheets.sheet_number,
  sheets.publication_date,
  sheets.closes_at,
  sheets.description,
  sheets.status,
  (sheets.status = 'closed' or (sheets.closes_at is not null and sheets.closes_at <= pg_catalog.now())) as is_closed,
  case
    when sheets.status = 'closed' then 'manual'
    when sheets.closes_at is not null and sheets.closes_at <= pg_catalog.now() then 'deadline'
  end as closed_by_kind,
  sheets.closed_at,
  sheets.status_reason,
  sheets.reopened_at,
  sheets.created_at,
  sheets.created_via,
  sheets.updated_at,
  pg_catalog.now() as server_now
from public.sheets as sheets;

revoke all on public.sheet_overview from public, anon;
grant select on public.sheet_overview to authenticated;

-- Local wall time ('YYYY-MM-DDTHH:MM' in Israel) → timestamptz. DST is handled by the time zone rules.
create or replace function private.jerusalem_time(p_local text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $function$
begin
  if p_local is null or pg_catalog.btrim(p_local) = '' then
    return null;
  end if;
  return (p_local::timestamp) at time zone 'Asia/Jerusalem';
exception when others then
  raise exception 'מועד הסגירה אינו תקין.';
end;
$function$;

revoke all on function private.jerusalem_time(text) from public, anon, authenticated;

-- =====================================================================
-- 4. create_sheets_batch — "הוספת גיליונות" (all or nothing)
-- p_sheets: [{ "sheet_number": "141", "publication_date": "2026-11-29",
--              "closes_at_local": "2026-11-27T00:00", "description": "" }, ...]
-- =====================================================================
create or replace function public.create_sheets_batch(p_sheets jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cached jsonb;
  v_row jsonb;
  v_index integer := 0;
  v_number text;
  v_numbers text[] := array[]::text[];
  v_publication date;
  v_closes timestamptz;
  v_description text;
  v_existing text;
  v_result jsonb;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if p_sheets is null or pg_catalog.jsonb_typeof(p_sheets) <> 'array'
     or pg_catalog.jsonb_array_length(p_sheets) not between 1 and 60 then
    raise exception 'יש ליצור בין גיליון אחד ל-60 גיליונות בפעולה אחת.';
  end if;

  v_cached := private.claim_business_operation(p_idempotency_key, 'create_sheets_batch', pg_catalog.md5(p_sheets::text));
  if v_cached is not null then
    return v_cached;
  end if;

  -- Validate everything first; nothing is written if any row is invalid.
  for v_row in select value from pg_catalog.jsonb_array_elements(p_sheets) loop
    v_index := v_index + 1;
    v_number := pg_catalog.btrim(coalesce(v_row ->> 'sheet_number', ''));
    if v_number !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'מספר הגיליון בשורה % אינו תקין: ספרות בלבד, מספר חיובי, ללא אפס מוביל.', v_index;
    end if;
    if v_number = any(v_numbers) then
      raise exception 'גיליון % מופיע פעמיים ברשימה.', v_number;
    end if;
    v_numbers := v_numbers || v_number;
    if nullif(v_row ->> 'publication_date', '') is null then
      raise exception 'חסר תאריך פרסום לגיליון %.', v_number;
    end if;
    v_publication := (v_row ->> 'publication_date')::date;
    v_closes := private.jerusalem_time(v_row ->> 'closes_at_local');
    if v_closes is null then
      raise exception 'חסר מועד סגירה לגיליון %.', v_number;
    end if;
    if v_closes >= ((v_publication + 1)::timestamp at time zone 'Asia/Jerusalem') then
      raise exception 'מועד הסגירה של גיליון % חייב להיות לפני סוף יום הפרסום.', v_number;
    end if;
    if v_closes <= pg_catalog.now() then
      raise exception 'מועד הסגירה של גיליון % כבר עבר.', v_number;
    end if;
    if pg_catalog.length(coalesce(v_row ->> 'description', '')) > 200 then
      raise exception 'התיאור של גיליון % ארוך מ-200 תווים.', v_number;
    end if;
  end loop;

  select string_agg(sheets.sheet_number, ', ' order by sheets.sheet_number) into v_existing
  from public.sheets where sheets.sheet_number = any(v_numbers);
  if v_existing is not null then
    raise exception using errcode = '23505',
      message = pg_catalog.format('הגיליונות הבאים כבר קיימים: %s. לא נוצר אף גיליון.', v_existing);
  end if;

  begin
    insert into public.sheets (sheet_number, status, status_reason, publication_date, closes_at, description,
                               created_by, created_via, updated_by)
    select pg_catalog.btrim(item ->> 'sheet_number'), 'open', '', (item ->> 'publication_date')::date,
           private.jerusalem_time(item ->> 'closes_at_local'), pg_catalog.btrim(coalesce(item ->> 'description', '')),
           auth.uid(), 'planned', auth.uid()
    from pg_catalog.jsonb_array_elements(p_sheets) as item;
  exception when unique_violation then
    -- Another user created one of these numbers at the same moment: the whole batch is rolled back.
    raise exception using errcode = '23505',
      message = 'אחד הגיליונות נוצר במקביל על ידי משתמשת אחרת. לא נוצר אף גיליון; יש לרענן ולנסות שוב.';
  end;

  v_result := pg_catalog.jsonb_build_object('created', pg_catalog.to_jsonb(v_numbers), 'count', pg_catalog.cardinality(v_numbers));
  update private.business_operations set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

revoke all on function public.create_sheets_batch(jsonb, uuid) from public, anon;
grant execute on function public.create_sheets_batch(jsonb, uuid) to authenticated;

-- =====================================================================
-- 5. update_sheet_details — publication date, closing time, description
-- A sheet closed by its deadline cannot be reopened by moving the deadline: that is set_sheet_state (reason).
-- =====================================================================
create or replace function public.update_sheet_details(
  p_sheet_number text,
  p_publication_date date,
  p_closes_at_local text,
  p_description text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sheet public.sheets%rowtype;
  v_closes timestamptz := private.jerusalem_time(p_closes_at_local);
  v_row public.sheets%rowtype;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  select * into v_sheet from public.sheets where sheet_number = pg_catalog.btrim(p_sheet_number) for update;
  if not found then
    raise exception 'הגיליון לא נמצא.';
  end if;
  if p_expected_updated_at is null or v_sheet.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '40001', message = 'פרטי הגיליון השתנו אצל משתמשת אחרת. רענני ונסי שוב.';
  end if;
  if pg_catalog.length(coalesce(p_description, '')) > 200 then
    raise exception 'התיאור ארוך מ-200 תווים.';
  end if;
  if v_closes is null and v_sheet.closes_at is not null then
    raise exception 'מועד סגירה הוא שדה חובה לגיליון זה.';
  end if;
  if v_closes is not null and p_publication_date is null then
    raise exception 'יש להזין תאריך פרסום.';
  end if;
  if v_closes is not null and v_closes >= ((p_publication_date + 1)::timestamp at time zone 'Asia/Jerusalem') then
    raise exception 'מועד הסגירה חייב להיות לפני סוף יום הפרסום.';
  end if;
  if v_closes is distinct from v_sheet.closes_at and v_sheet.status <> 'closed' then
    if v_sheet.closes_at is not null and v_sheet.closes_at <= pg_catalog.now() then
      raise exception 'הגיליון נסגר במועד הסגירה. כדי לשנות את המועד יש לפתוח אותו מחדש (עם סיבה).';
    end if;
    if v_closes <= pg_catalog.now() then
      raise exception 'מועד הסגירה החדש כבר עבר. לסגירה מיידית יש להשתמש ב"סגירת הגיליון".';
    end if;
  end if;

  update public.sheets
  set publication_date = p_publication_date,
      closes_at = v_closes,
      description = pg_catalog.btrim(coalesce(p_description, '')),
      updated_by = auth.uid()
  where sheet_number = v_sheet.sheet_number
  returning * into v_row;

  return pg_catalog.jsonb_build_object('sheet_number', v_row.sheet_number, 'updated_at', v_row.updated_at);
end;
$function$;

revoke all on function public.update_sheet_details(text, date, text, text, timestamptz) from public, anon;
grant execute on function public.update_sheet_details(text, date, text, text, timestamptz) to authenticated;

-- =====================================================================
-- 6. set_sheet_state — close now / reopen (reason ≥ 3 characters + a new future closing time when the
--    previous one has passed, so a reopened sheet is not closed again immediately).
-- =====================================================================
create or replace function public.set_sheet_state(
  p_sheet_number text,
  p_is_closed boolean,
  p_reason text,
  p_reopen_closes_at_local text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_number text := nullif(pg_catalog.btrim(p_sheet_number), '');
  v_sheet public.sheets%rowtype;
  v_found boolean;
  v_closed boolean;
  v_new_closes timestamptz := private.jerusalem_time(p_reopen_closes_at_local);
  v_row public.sheets%rowtype;
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
  if v_number is null or p_is_closed is null then
    raise exception 'יש לבחור גיליון וסטטוס.';
  end if;

  select * into v_sheet from public.sheets where sheet_number = v_number for update;
  v_found := found;
  if v_found and (p_expected_updated_at is null or v_sheet.updated_at is distinct from p_expected_updated_at) then
    raise exception using errcode = '40001', message = 'סטטוס הגיליון השתנה אצל משתמשת אחרת. רענני ונסי שוב.';
  end if;
  if not v_found and not exists (select 1 from public.orders where pg_catalog.btrim(sheet_number) = v_number) then
    raise exception 'הגיליון לא נמצא.';
  end if;
  v_closed := v_found and (v_sheet.status = 'closed' or (v_sheet.closes_at is not null and v_sheet.closes_at <= pg_catalog.now()));

  if p_is_closed then
    if v_closed then
      raise exception 'הגיליון כבר סגור.';
    end if;
    insert into public.sheets (sheet_number, status, status_reason, closed_at, closed_by, updated_by, created_by, created_via)
    values (v_number, 'closed', coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'סגירת גיליון'), pg_catalog.now(), auth.uid(),
            auth.uid(), auth.uid(), 'status')
    on conflict (sheet_number) do update
      set status = 'closed', status_reason = excluded.status_reason, closed_at = excluded.closed_at,
          closed_by = excluded.closed_by, updated_by = excluded.updated_by
    returning * into v_row;
  else
    if not v_closed then
      raise exception 'הגיליון כבר פתוח.';
    end if;
    if p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason)) < 3 then
      raise exception 'נדרש הסבר קצר לפתיחה מחדש של גיליון סגור.';
    end if;
    if v_new_closes is null and v_sheet.closes_at is not null and v_sheet.closes_at <= pg_catalog.now() then
      raise exception 'מועד הסגירה של הגיליון עבר. יש לבחור מועד סגירה חדש בעתיד.';
    end if;
    if v_new_closes is not null and v_new_closes <= pg_catalog.now() then
      raise exception 'מועד הסגירה החדש חייב להיות בעתיד.';
    end if;
    update public.sheets
    set status = 'open', status_reason = pg_catalog.btrim(p_reason), closed_at = null, closed_by = null,
        closes_at = coalesce(v_new_closes, closes_at), reopened_at = pg_catalog.now(), reopened_by = auth.uid(),
        updated_by = auth.uid()
    where sheet_number = v_number
    returning * into v_row;
  end if;

  return pg_catalog.jsonb_build_object(
    'sheet_number', v_row.sheet_number, 'status', v_row.status, 'closes_at', v_row.closes_at,
    'is_closed', v_row.status = 'closed' or (v_row.closes_at is not null and v_row.closes_at <= pg_catalog.now()),
    'updated_at', v_row.updated_at);
end;
$function$;

revoke all on function public.set_sheet_state(text, boolean, text, text, timestamptz) from public, anon;
grant execute on function public.set_sheet_state(text, boolean, text, text, timestamptz) to authenticated;

-- The current UI keeps calling set_sheet_status; it now uses the same rules (no reopen past the deadline
-- without a new closing time, which the current UI cannot send: it gets a clear error instead).
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
begin
  return public.set_sheet_state(p_sheet_number, p_is_closed, p_reason, null, p_expected_updated_at);
end;
$function$;

revoke all on function public.set_sheet_status(text, boolean, text, timestamptz) from public, anon;
grant execute on function public.set_sheet_status(text, boolean, text, timestamptz) to authenticated;

commit;

-- Verification (read only)
select
  (select count(*) from public.sheets) as sheets_total,
  (select count(*) from public.sheets where created_via = 'backfill' and status = 'closed') as backfilled_closed,
  (select count(*) from public.sheets where created_via = 'backfill' and status = 'open') as backfilled_open,
  (select string_agg(sheet_number, ', ') from public.sheets where status = 'open') as open_sheets,
  (select count(*) from public.orders o
    where pg_catalog.btrim(coalesce(o.sheet_number, '')) <> ''
      and not exists (select 1 from public.sheets s where s.sheet_number = pg_catalog.btrim(o.sheet_number))) as orders_without_sheet_row;
