-- Sheets model v2 — PREFLIGHT (READ ONLY). Changes nothing. Running it still requires the owner's approval.
-- Run before supabase-sheets-v2.sql, and use the result to fill that file's keep-open list
-- (the sheet(s) that must stay open: the active sheet for orders, and any future sheet that already has orders).
--
-- Result 1: installation state.
-- Result 2: one row per sheet number used in orders (newest numbers first), with:
--   orders, first/last order date, whether the value is valid for the new model,
--   the existing status row (if any), what the migration would do by default,
--   and a "recent_activity" flag for sheets with orders entered in the last 14 days (likely active: review!).

select
  pg_catalog.to_regclass('public.sheets') is not null as sheets_table_installed,
  exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = pg_catalog.to_regclass('public.sheets') and attname = 'closes_at' and not attisdropped
  ) as sheets_v2_installed,
  (select count(*) from public.orders where sheet_number is not null) as orders_with_sheet,
  (select count(*) from public.orders where sheet_number is null or pg_catalog.btrim(sheet_number) = '') as orders_without_sheet,
  (select count(*) from public.orders
    where sheet_number is not null and sheet_number <> pg_catalog.btrim(sheet_number)) as orders_with_spaces_around_sheet,
  (select count(*) from public.sheets) as existing_sheet_rows;

with used as (
  select
    pg_catalog.btrim(orders.sheet_number) as sheet_number,
    count(*) as orders,
    count(distinct orders.client_id) as clients,
    min(coalesce(orders.entered_at, (orders.created_at at time zone 'Asia/Jerusalem')::date)) as first_order_date,
    max(coalesce(orders.entered_at, (orders.created_at at time zone 'Asia/Jerusalem')::date)) as last_order_date,
    bool_or(orders.sheet_number <> pg_catalog.btrim(orders.sheet_number)) as has_spaces
  from public.orders
  where pg_catalog.btrim(coalesce(orders.sheet_number, '')) <> ''
  group by pg_catalog.btrim(orders.sheet_number)
)
select
  used.sheet_number,
  used.orders,
  used.clients,
  used.first_order_date,
  used.last_order_date,
  used.last_order_date >= (pg_catalog.now() at time zone 'Asia/Jerusalem')::date - 14 as recent_activity,
  used.sheet_number ~ '^[1-9][0-9]{0,8}$' as valid_new_format,
  used.has_spaces,
  sheets.status as existing_status,
  case
    when sheets.sheet_number is not null then 'unchanged (row exists)'
    else 'closed as historical (unless listed as keep-open)'
  end as migration_default
from used
left join public.sheets as sheets on sheets.sheet_number = used.sheet_number
order by
  case when used.sheet_number ~ '^[0-9]{1,9}$' then used.sheet_number::bigint end desc nulls last,
  used.sheet_number desc;
