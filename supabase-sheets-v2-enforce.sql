-- Sheets model v2 — STAGE B: ENFORCEMENT. REQUIRES THE OWNER'S EXPLICIT APPROVAL.
-- Run ONLY after supabase-sheets-v2.sql AND after the new UI (sheet chosen from a list) is published:
-- from this point an order can only be placed in an existing, open sheet. The current (old) UI would get
-- an error when typing a sheet number that does not exist.
--
-- 1. Every order's sheet_number must exist in public.sheets (foreign key; free text is no longer possible).
-- 2. Trigger orders_enforce_open_sheet: a new order, or moving an order to another sheet, is rejected when the
--    target sheet is closed (status = 'closed' or closes_at <= now()). It applies to EVERY write path: the RPCs
--    (create_orders_batch, update_business_order), direct API writes and imports. Payment status, price, notes
--    and credits of existing orders are not affected (the trigger runs only on insert or a sheet_number change).
-- 3. The sheet row is locked (FOR SHARE) while the order is written, so a simultaneous "close now" is
--    serialised: the order is either accepted before the close or rejected after it.
-- Time rule: the check uses the transaction start time (now()). An order submitted before the deadline but
-- committed a fraction of a second after it is accepted. This is intended and documented.
-- Safe to run twice.

begin;

do $preflight$
declare
  v_orphans text;
  v_spaces bigint;
begin
  if not exists (select 1 from pg_catalog.pg_attribute
                 where attrelid = 'public.sheets'::regclass and attname = 'closes_at' and not attisdropped) then
    raise exception 'Run supabase-sheets-v2.sql first.';
  end if;

  select count(*) into v_spaces from public.orders
  where sheet_number is not null and (sheet_number <> pg_catalog.btrim(sheet_number) or pg_catalog.btrim(sheet_number) = '');
  if v_spaces > 0 then
    raise exception '% orders have a sheet number with surrounding spaces or an empty value. They need a separate, approved normalisation first. Nothing was changed.', v_spaces;
  end if;

  select string_agg(distinct o.sheet_number, ', ') into v_orphans
  from public.orders as o
  where o.sheet_number is not null
    and not exists (select 1 from public.sheets as s where s.sheet_number = o.sheet_number);
  if v_orphans is not null then
    raise exception 'Orders use sheet numbers that have no sheet row: %. Decide their status (open/closed) and create them before enforcing. Nothing was changed.', v_orphans;
  end if;
end
$preflight$;

-- 1. Foreign key (validated after creation; the preflight guarantees it passes)
do $fk$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                 where conrelid = 'public.orders'::regclass and conname = 'orders_sheet_number_fkey') then
    alter table public.orders
      add constraint orders_sheet_number_fkey foreign key (sheet_number)
      references public.sheets (sheet_number) on update restrict on delete restrict not valid;
  end if;
end
$fk$;
alter table public.orders validate constraint orders_sheet_number_fkey;

-- 2. Closed-sheet guard
create or replace function private.enforce_open_sheet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text;
  v_closes timestamptz;
begin
  if new.sheet_number is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.sheet_number is not distinct from old.sheet_number then
    return new;
  end if;

  select status, closes_at into v_status, v_closes
  from public.sheets
  where sheet_number = new.sheet_number
  for share;
  if not found then
    raise exception using errcode = '23503',
      message = pg_catalog.format('גיליון %s אינו קיים במערכת. יש לבחור גיליון מהרשימה.', new.sheet_number);
  end if;
  if v_status = 'closed' or (v_closes is not null and v_closes <= pg_catalog.now()) then
    raise exception using errcode = 'HPS01',
      message = pg_catalog.format('גיליון %s סגור להזמנות. יש לבחור גיליון פתוח.', new.sheet_number);
  end if;
  return new;
end;
$function$;

revoke all on function private.enforce_open_sheet() from public, anon, authenticated;

drop trigger if exists orders_enforce_open_sheet on public.orders;
create trigger orders_enforce_open_sheet
  before insert or update of sheet_number on public.orders
  for each row execute function private.enforce_open_sheet();

commit;

-- Verification (read only)
select
  exists (select 1 from pg_catalog.pg_constraint
          where conrelid = 'public.orders'::regclass and conname = 'orders_sheet_number_fkey' and convalidated) as fk_validated,
  exists (select 1 from pg_catalog.pg_trigger
          where tgrelid = 'public.orders'::regclass and tgname = 'orders_enforce_open_sheet' and not tgisinternal) as trigger_installed;
