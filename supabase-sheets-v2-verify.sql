-- Sheets model v2 — VERIFY (READ ONLY). Changes nothing. Running it still requires the owner's approval.
-- Run after supabase-sheets-v2.sql (and again after supabase-sheets-v2-enforce.sql). Every row should be PASS
-- (or INFO). A FAIL means: stop and report before continuing.

with checks as (
  select 1 as n, 'Columns publication_date / closes_at / description / created_via' as check_name,
    case when (select count(*) from pg_catalog.pg_attribute
               where attrelid = 'public.sheets'::regclass and not attisdropped
                 and attname in ('publication_date', 'closes_at', 'description', 'created_at', 'created_by',
                                 'created_via', 'reopened_at', 'reopened_by')) = 8 then 'PASS' else 'FAIL' end as result,
    '' as detail
  union all
  select 2, 'RPCs installed',
    case when pg_catalog.to_regprocedure('public.create_sheets_batch(jsonb, uuid)') is not null
          and pg_catalog.to_regprocedure('public.update_sheet_details(text, date, text, text, timestamp with time zone)') is not null
          and pg_catalog.to_regprocedure('public.set_sheet_state(text, boolean, text, text, timestamp with time zone)') is not null
          and pg_catalog.to_regprocedure('public.set_sheet_status(text, boolean, text, timestamp with time zone)') is not null
      then 'PASS' else 'FAIL' end, ''
  union all
  select 3, 'anon cannot execute the sheet RPCs',
    case when not has_function_privilege('anon', 'public.create_sheets_batch(jsonb, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.update_sheet_details(text, date, text, text, timestamp with time zone)', 'execute')
          and not has_function_privilege('anon', 'public.set_sheet_state(text, boolean, text, text, timestamp with time zone)', 'execute')
      then 'PASS' else 'FAIL' end, ''
  union all
  select 4, 'anon cannot read sheets / sheet_overview',
    case when not has_table_privilege('anon', 'public.sheets', 'select')
          and not has_table_privilege('anon', 'public.sheet_overview', 'select') then 'PASS' else 'FAIL' end, ''
  union all
  select 5, 'authenticated cannot write public.sheets directly',
    case when not has_table_privilege('authenticated', 'public.sheets', 'insert')
          and not has_table_privilege('authenticated', 'public.sheets', 'update')
          and not has_table_privilege('authenticated', 'public.sheets', 'delete') then 'PASS' else 'FAIL' end, ''
  union all
  select 6, 'sheet_overview runs with the caller''s rights (RLS applies)',
    case when exists (select 1 from pg_catalog.pg_class
                      where oid = 'public.sheet_overview'::regclass
                        and coalesce(reloptions, '{}') @> array['security_invoker=true']) then 'PASS' else 'FAIL' end, ''
  union all
  select 7, 'Every sheet number used in orders has a sheet row',
    case when not exists (select 1 from public.orders o
                          where pg_catalog.btrim(coalesce(o.sheet_number, '')) <> ''
                            and not exists (select 1 from public.sheets s where s.sheet_number = pg_catalog.btrim(o.sheet_number)))
      then 'PASS' else 'INFO' end,
    coalesce((select string_agg(distinct pg_catalog.btrim(o.sheet_number), ', ') from public.orders o
              where pg_catalog.btrim(coalesce(o.sheet_number, '')) <> ''
                and not exists (select 1 from public.sheets s where s.sheet_number = pg_catalog.btrim(o.sheet_number))), '')
  union all
  select 8, 'Open sheets (check: the active sheet is open, old ones are not)', 'INFO',
    coalesce((select string_agg(sheet_number || coalesce(' (closes ' || to_char(closes_at at time zone 'Asia/Jerusalem', 'DD/MM HH24:MI') || ')', ' (no closing time)'), ', ' order by sheet_number)
              from public.sheet_overview where not is_closed), 'none')
  union all
  select 9, 'Open sheets without a closing time (they never close automatically)',
    case when exists (select 1 from public.sheets where status = 'open' and closes_at is null) then 'INFO' else 'PASS' end,
    coalesce((select string_agg(sheet_number, ', ') from public.sheets where status = 'open' and closes_at is null), '')
  union all
  select 10, 'Enforcement (stage B) installed',
    case when exists (select 1 from pg_catalog.pg_trigger
                      where tgrelid = 'public.orders'::regclass and tgname = 'orders_enforce_open_sheet' and not tgisinternal)
      then 'PASS' else 'INFO' end,
    'INFO = not installed yet (expected before supabase-sheets-v2-enforce.sql)'
)
select n, check_name, result, detail from checks order by n;
