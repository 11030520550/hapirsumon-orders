-- =====================================================================================================
-- supabase-orders-v3.sql — orders, payments and packages: the working model of the newspaper.
--
-- NOT RUN. Requires the owner's explicit approval, a verified backup and a dry run on a separate test
-- project first (see INSTALL-ORDERS-V3.md). Run AFTER supabase-business-upgrade.sql and
-- supabase-sheets-and-order-numbers.sql. Independent of the sheets v2 files (may run before or after them).
--
-- What it adds (nothing is deleted, no existing amount, number, status or balance is rewritten):
--   orders                : ad_description (free text, required for new orders), file_status, placement_status
--                           ('unknown' for every existing order), documented cancellation (cancelled_at/by/reason).
--   financial_obligations : status 'cancelled' + cancellation fields, amount_before_vat (new rows only),
--                           received_at_cancel (keeps "money received" of a cancelled legacy paid order).
--   business_payment_events: received_on (receipt date) and reverses_event_id (one documented reversal per receipt).
--   credit_ledger         : entry types 'order_cancellation' (returned once per order, unique index) and
--                           'order_adjustment' (a documented change of the credits of an order).
--   functions             : create_orders_batch (new version: free description, product optional; old callers
--                           keep working), update_order_details, update_order_charge, cancel_business_order,
--                           record_obligation_payment (partial payments), reverse_obligation_payment,
--                           update_installment_schedule (edit unpaid installments after the purchase).
--   views                 : business_order_financial_summary / business_financial_summary / business_financial_totals
--                           are recreated with the same columns (+ new ones at the end): cancelled charges are no
--                           longer open debt, partial receipts are counted, history is kept.
--
-- Compatibility: the site that is live today (orders model v2) keeps working after this file: the old function
-- signatures are unchanged, set_obligation_paid / delete_business_order / update_business_order are untouched.
-- Payment methods are intentionally NOT added (owner decision; a future invoicing integration will add references).
-- Order numbering is untouched: no counter change, no renumbering.
-- One transaction: if anything fails, nothing is changed. Safe to run twice.
-- =====================================================================================================

begin;

-- ---------- 0. Preconditions ----------
do $preflight$
begin
  if to_regclass('public.financial_obligations') is null
     or to_regclass('public.business_payment_events') is null
     or to_regclass('public.credit_ledger') is null
     or to_regprocedure('public.create_orders_batch(text, jsonb, uuid)') is null
     or to_regprocedure('private.claim_business_operation(uuid, text, text)') is null
     or to_regprocedure('private.is_approved_user()') is null then
    raise exception 'The business schema is missing. Run supabase-business-upgrade.sql first.';
  end if;
end;
$preflight$;

-- ---------- 1. Orders: free description, workflow statuses, documented cancellation ----------
alter table public.orders
  add column if not exists ad_description text,
  add column if not exists file_status text not null default 'unknown',
  add column if not exists placement_status text not null default 'unknown',
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users (id) on delete set null,
  add column if not exists cancel_reason text;

alter table public.orders
  drop constraint if exists orders_ad_description_check,
  drop constraint if exists orders_file_status_check,
  drop constraint if exists orders_placement_status_check,
  drop constraint if exists orders_cancellation_check,
  add constraint orders_ad_description_check
    check (ad_description is null or length(btrim(ad_description)) between 1 and 500),
  -- 'unknown' = an order from before this model; never inferred from other data.
  add constraint orders_file_status_check
    check (file_status in ('unknown', 'not_received', 'received', 'approved')),
  add constraint orders_placement_status_check
    check (placement_status in ('unknown', 'not_placed', 'placed', 'published')),
  add constraint orders_cancellation_check
    check ((cancelled_at is null and cancel_reason is null)
           or (cancelled_at is not null and length(btrim(coalesce(cancel_reason, ''))) >= 3));

create index if not exists orders_active_entered_idx
  on public.orders (entered_at desc) where cancelled_at is null;

-- ---------- 2. Financial obligations: cancellation, planned amount before VAT ----------
alter table public.financial_obligations
  add column if not exists amount_before_vat numeric(12, 2),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users (id) on delete set null,
  add column if not exists cancel_reason text,
  add column if not exists received_at_cancel numeric(12, 2);

-- The status check of the base migration is an unnamed column check; drop it by its definition.
do $obligation_checks$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_catalog.pg_constraint
    where conrelid = 'public.financial_obligations'::regclass and contype = 'c'
      and (pg_catalog.pg_get_constraintdef(oid) like '%''pending''%''paid''%'
           and pg_catalog.pg_get_constraintdef(oid) not like '%paid_at%'
           and pg_catalog.pg_get_constraintdef(oid) not like '%cancelled%')
  loop
    execute pg_catalog.format('alter table public.financial_obligations drop constraint %I', v_name);
  end loop;
end;
$obligation_checks$;

alter table public.financial_obligations
  drop constraint if exists financial_obligations_status_check,
  drop constraint if exists financial_obligations_paid_timestamp_check,
  drop constraint if exists financial_obligations_cancellation_check,
  drop constraint if exists financial_obligations_amount_before_vat_check,
  add constraint financial_obligations_status_check
    check (status in ('pending', 'paid', 'cancelled')),
  add constraint financial_obligations_paid_timestamp_check
    check (
      (status = 'pending' and paid_at is null and paid_by is null)
      or (status = 'paid' and (
        (paid_at is not null and paid_by is not null)
        or (legacy_snapshot and paid_at is null and paid_by is null)
      ))
      or (status = 'cancelled')
    ),
  add constraint financial_obligations_cancellation_check
    check ((status = 'cancelled') = (cancelled_at is not null)
           and (status <> 'cancelled' or length(btrim(coalesce(cancel_reason, ''))) >= 3)),
  add constraint financial_obligations_amount_before_vat_check
    check (amount_before_vat is null or (amount_before_vat > 0 and amount_before_vat = round(amount_before_vat, 2)));

-- ---------- 3. Payment events: receipt date and a single documented reversal per receipt ----------
alter table public.business_payment_events
  add column if not exists received_on date,
  add column if not exists reverses_event_id uuid references public.business_payment_events (id) on delete restrict;

create unique index if not exists business_payment_events_one_reversal_uidx
  on public.business_payment_events (reverses_event_id) where reverses_event_id is not null;

-- ---------- 4. Credit ledger: cancellation (once per order) and documented adjustment of an order ----------
do $ledger_checks$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_catalog.pg_constraint
    where conrelid = 'public.credit_ledger'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%package_grant%'
  loop
    execute pg_catalog.format('alter table public.credit_ledger drop constraint %I', v_name);
  end loop;
end;
$ledger_checks$;

alter table public.credit_ledger
  add constraint credit_ledger_entry_type_check check (
    entry_type in ('package_grant', 'order_consumption', 'correction', 'conversion_reversal',
                   'order_cancellation', 'order_adjustment')
  ),
  add constraint credit_ledger_entry_shape_check check (
    (entry_type = 'package_grant' and customer_package_id is not null and order_id is null and delta > 0)
    or (entry_type = 'order_consumption' and order_id is not null and customer_package_id is null and delta < 0)
    or (entry_type = 'correction' and customer_package_id is null)
    or (entry_type = 'conversion_reversal' and order_id is null and customer_package_id is null)
    or (entry_type = 'order_cancellation' and order_id is not null and customer_package_id is null and delta > 0)
    or (entry_type = 'order_adjustment' and order_id is not null and customer_package_id is null)
  );

create unique index if not exists credit_ledger_one_cancellation_per_order_uidx
  on public.credit_ledger (order_id) where entry_type = 'order_cancellation';

-- ---------- 5. Private helpers ----------
-- Money received for one obligation: business receipts + receipts of the original payments table, or the
-- recorded legacy "paid" flag when there is no receipt record at all (same rule as the financial views).
create or replace function private.obligation_received(p_obligation_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $function$
  select case
           when coalesce(e.n, 0) + coalesce(p.n, 0) = 0 and f.legacy_snapshot and f.status = 'paid'
             then f.amount_due
           when coalesce(e.n, 0) + coalesce(p.n, 0) = 0 and f.legacy_snapshot and f.status = 'cancelled'
             then coalesce(f.received_at_cancel, 0)
           else coalesce(e.s, 0) + coalesce(p.s, 0)
         end::numeric(12, 2)
  from public.financial_obligations as f
  left join lateral (
    select sum(events.amount) as s, count(*) as n
    from public.business_payment_events as events where events.obligation_id = f.id
  ) as e on true
  left join lateral (
    select sum(payments.amount) as s, count(*) as n
    from public.payments as payments where f.order_id is not null and payments.order_id = f.order_id
  ) as p on true
  where f.id = p_obligation_id;
$function$;

-- Paid in full = received >= amount due. Keeps orders.payment_status in step (paid / pending).
create or replace function private.refresh_obligation_status(p_obligation_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_obligation public.financial_obligations%rowtype;
  v_received numeric(12, 2);
  v_status text;
begin
  select * into v_obligation from public.financial_obligations where id = p_obligation_id for update;
  if not found then
    raise exception 'החיוב לא נמצא.';
  end if;
  if v_obligation.status = 'cancelled' then
    return 'cancelled';
  end if;
  v_received := private.obligation_received(p_obligation_id);
  v_status := case when v_received >= v_obligation.amount_due then 'paid' else 'pending' end;
  if v_status <> v_obligation.status then
    update public.financial_obligations
    set status = v_status,
        paid_at = case when v_status = 'paid' then pg_catalog.now() else null end,
        paid_by = case when v_status = 'paid' then auth.uid() else null end
    where id = p_obligation_id;
  end if;
  if v_obligation.order_id is not null then
    update public.orders set payment_status = v_status
    where id = v_obligation.order_id and payment_status <> v_status;
  end if;
  return v_status;
end;
$function$;

create or replace function private.require_approved_user()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or not private.is_approved_user() then
    raise exception 'החשבון אינו מורשה לבצע פעולה זו.';
  end if;
end;
$function$;

revoke all on function private.obligation_received(uuid) from public, anon, authenticated;
revoke all on function private.refresh_obligation_status(uuid) from public, anon, authenticated;
revoke all on function private.require_approved_user() from public, anon, authenticated;

-- The business day is the date in Israel. Supabase runs in UTC, so current_date is still "yesterday" between
-- 00:00 and 02:00/03:00 Israel time: an order entered then would get yesterday's date, and a charge due today
-- would not yet count as due. Every date decision in this file uses this function instead of current_date.
create or replace function private.business_today()
returns date
language sql
stable
set search_path = ''
as $function$
  select (pg_catalog.now() at time zone 'Asia/Jerusalem')::date
$function$;
revoke all on function private.business_today() from public, anon;
-- The financial views run with the caller's rights (security_invoker), so signed-in users may call it.
grant execute on function private.business_today() to authenticated;

-- Direct inserts (clients from the UI; orders only until the cut-over) get the Israel date too.
alter table public.orders alter column entered_at set default private.business_today();
alter table public.clients alter column joined_at set default private.business_today();

-- ---------- 6. create_orders_batch: free description, product optional ----------
-- Same signature and result as before. New rule: every row needs ad_description (1–500 characters).
-- Backward compatible: a row that names an active product but no description (the current live site) still
-- works; the product name becomes its description. New orders start as "file not received / not placed".
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
  v_has_product boolean;
  v_client public.clients%rowtype;
  v_vat numeric(5, 4);
  v_cash numeric;
  v_credits numeric;
  v_amount numeric(12, 2);
  v_status text;
  v_id text;
  v_order_number bigint;
  v_obligation_id uuid;
  v_result jsonb := '[]'::jsonb;
  v_actor_label text;
  v_balance numeric;
  v_count integer := 0;
  v_sheet text;
  v_publication_date date;
  v_due_on date;
  v_description text;
begin
  perform private.require_approved_user();
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

  select * into v_client from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'הלקוח לא נמצא.';
  end if;

  select vat_rate into v_vat from public.business_settings where singleton;
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
    if v_cash is not null
       and (v_cash <= 0 or v_cash > 99999999 or round(v_cash, 2) <> v_cash) then
      raise exception 'המחיר בשורה % חייב להיות חיובי, עד 99,999,999 ש"ח, ובדיוק שתי ספרות אחרי הנקודה.', v_count;
    end if;
    v_credits := nullif(v_row ->> 'credits_used', '')::numeric;
    if (v_credits is not null and (v_credits <= 0 or round(v_credits, 2) <> v_credits))
       or ((v_cash is null) = (v_credits is null)) then
      raise exception 'בכל שורה יש למלא בדיוק ערך חיובי אחד: מחיר לפני מע"מ או קרדיטים.';
    end if;

    v_sheet := nullif(btrim(v_row ->> 'sheet_number'), '');
    if v_sheet is null or length(v_sheet) > 80 then
      raise exception 'יש להזין מספר גיליון תקין בשורה %.', v_count;
    end if;
    -- The legacy column is still NOT NULL; the newspaper has no per-order publication date, so the order
    -- date is used when none is sent.
    v_publication_date := coalesce(nullif(v_row ->> 'publication_date', '')::date, private.business_today());
    v_status := coalesce(v_row ->> 'payment_status', 'pending');
    if v_status not in ('paid', 'pending') then
      raise exception 'סטטוס התשלום בשורה % אינו תקין.', v_count;
    end if;
    v_due_on := nullif(v_row ->> 'due_on', '')::date;

    v_has_product := nullif(v_row ->> 'product_id', '') is not null;
    if v_has_product then
      select * into v_product
      from public.product_catalog
      where id = (v_row ->> 'product_id')::uuid and is_active
      for share;
      if not found then
        raise exception 'המוצר בשורה % אינו קיים או אינו פעיל.', v_count;
      end if;
    end if;

    v_description := nullif(btrim(coalesce(v_row ->> 'ad_description', '')), '');
    if v_description is null and v_has_product then
      v_description := v_product.name;
    end if;
    if v_description is null or length(v_description) > 500 then
      raise exception 'יש להזין פירוט הזמנה בשורה % (עד 500 תווים).', v_count;
    end if;
    if length(coalesce(v_row ->> 'notes', '')) > 5000 then
      raise exception 'ההערה בשורה % ארוכה מדי.', v_count;
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
      cash_amount_before_vat, credits_used, vat_rate_snapshot,
      ad_description, file_status, placement_status
    )
    values (
      'o-' || gen_random_uuid()::text,
      p_client_id,
      v_publication_date,
      left(v_description, 120),
      v_amount,
      v_status,
      coalesce(v_row ->> 'notes', ''),
      private.business_today(),
      auth.uid(),
      v_actor_label,
      v_sheet,
      case when v_has_product then v_product.id else null end,
      case when v_has_product then v_product.name else null end,
      case when v_has_product then v_product.dimensions else null end,
      case when v_has_product then v_product.base_price_before_vat else null end,
      case when v_has_product then v_product.credit_cost else null end,
      case when v_cash is not null then 'cash' else 'credits' end,
      v_cash,
      v_credits,
      case when v_cash is not null then v_vat else null end,
      v_description,
      'not_received',
      'not_placed'
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
      select coalesce(sum(delta), 0) into v_balance from public.credit_ledger where client_id = p_client_id;
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'id', v_id, 'order_number', v_order_number,
        'billing_mode', 'credits', 'credit_balance_after', v_balance
      ));
    else
      insert into public.financial_obligations (
        order_id, amount_due, amount_before_vat, due_on, status, paid_at, paid_by, created_by
      )
      values (
        v_id, v_amount, v_cash, v_due_on, v_status,
        case when v_status = 'paid' then pg_catalog.now() else null end,
        case when v_status = 'paid' then auth.uid() else null end,
        auth.uid()
      )
      returning id into v_obligation_id;

      if v_status = 'paid' then
        insert into public.business_payment_events (
          obligation_id, event_type, amount, notes, received_on, idempotency_key, created_by
        )
        values (
          v_obligation_id, 'payment', v_amount, 'סומן כשולם בעת יצירת ההזמנה',
          private.business_today(), gen_random_uuid(), auth.uid()
        );
      end if;
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'id', v_id, 'order_number', v_order_number,
        'billing_mode', 'cash', 'gross_amount', v_amount,
        'obligation_id', v_obligation_id
      ));
    end if;
  end loop;

  update private.business_operations set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

-- ---------- 7. update_order_details: non-financial fields (double-click editing) ----------
-- All fields are sent (the current value for an untouched field). An existing description cannot be
-- cleared; a legacy order may stay without one until someone writes it.
create or replace function public.update_order_details(
  p_order_id text,
  p_expected_updated_at timestamptz,
  p_ad_description text,
  p_notes text,
  p_sheet_number text,
  p_file_status text,
  p_placement_status text,
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
  v_description text := nullif(btrim(coalesce(p_ad_description, '')), '');
  v_sheet text := nullif(btrim(coalesce(p_sheet_number, '')), '');
  v_result jsonb;
begin
  perform private.require_approved_user();
  if p_order_id is null or p_expected_updated_at is null then
    raise exception 'חסר מזהה הגרסה של ההזמנה. יש לרענן את הנתונים.';
  end if;
  v_cached := private.claim_business_operation(
    p_idempotency_key, 'update_order_details',
    pg_catalog.md5(pg_catalog.jsonb_build_array(p_order_id, p_expected_updated_at, p_ad_description, p_notes,
      p_sheet_number, p_file_status, p_placement_status)::text)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ההזמנה לא נמצאה.';
  end if;
  if v_order.updated_at <> p_expected_updated_at then
    raise exception using errcode = '40001',
      message = 'ההזמנה עודכנה אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'ההזמנה בוטלה ואינה ניתנת לעריכה.';
  end if;
  if v_description is null and v_order.ad_description is not null then
    raise exception 'פירוט ההזמנה הוא שדה חובה.';
  end if;
  if v_description is not null and length(v_description) > 500 then
    raise exception 'פירוט ההזמנה ארוך מ-500 תווים.';
  end if;
  if p_notes is null or length(p_notes) > 5000 then
    raise exception 'ההערה אינה תקינה.';
  end if;
  if v_sheet is not null and length(v_sheet) > 80 then
    raise exception 'מספר הגיליון אינו תקין.';
  end if;
  if v_sheet is null and v_order.sheet_number is not null then
    raise exception 'אי אפשר להסיר את הגיליון מהזמנה; אפשר להעביר אותה לגיליון אחר.';
  end if;
  if p_file_status not in ('unknown', 'not_received', 'received', 'approved')
     or p_placement_status not in ('unknown', 'not_placed', 'placed', 'published') then
    raise exception 'הסטטוס שנבחר אינו תקין.';
  end if;
  -- "unknown" is the state of an order from before this model; it is never chosen again once set.
  if (p_file_status = 'unknown' and v_order.file_status <> 'unknown')
     or (p_placement_status = 'unknown' and v_order.placement_status <> 'unknown') then
    raise exception 'אי אפשר להחזיר סטטוס ל"לא ידוע".';
  end if;

  update public.orders
  set ad_description = v_description,
      notes = p_notes,
      sheet_number = v_sheet,
      file_status = p_file_status,
      placement_status = p_placement_status
  where id = p_order_id
  returning * into v_order;

  v_result := pg_catalog.jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number,
    'updated_at', v_order.updated_at);
  update private.business_operations set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

-- ---------- 8. update_order_charge: price before VAT of a cash order, or credits of a credits order ----------
-- Cash: the VAT rate saved in the order is kept; the charge may not drop below what was already received.
-- Credits: the difference is written as one 'order_adjustment' ledger entry (history is never rewritten).
-- Legacy orders (amount of unknown VAT basis) and cancelled orders are not changed here.
create or replace function public.update_order_charge(
  p_order_id text,
  p_expected_updated_at timestamptz,
  p_cash_amount_before_vat numeric,
  p_credits_used numeric,
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
  v_amount numeric(12, 2);
  v_received numeric(12, 2);
  v_delta numeric;
  v_result jsonb;
begin
  perform private.require_approved_user();
  if p_order_id is null or p_expected_updated_at is null then
    raise exception 'חסר מזהה הגרסה של ההזמנה. יש לרענן את הנתונים.';
  end if;
  v_cached := private.claim_business_operation(
    p_idempotency_key, 'update_order_charge',
    pg_catalog.md5(pg_catalog.jsonb_build_array(p_order_id, p_expected_updated_at, p_cash_amount_before_vat,
      p_credits_used)::text)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ההזמנה לא נמצאה.';
  end if;
  if v_order.updated_at <> p_expected_updated_at then
    raise exception using errcode = '40001',
      message = 'ההזמנה עודכנה אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'ההזמנה בוטלה ואינה ניתנת לעריכה.';
  end if;

  if v_order.billing_mode = 'cash' then
    if p_credits_used is not null then
      raise exception 'הזמנה כספית אינה יכולה לקבל קרדיטים. הזמנה היא כספית או בקרדיטים, לא שניהם.';
    end if;
    if p_cash_amount_before_vat is null or p_cash_amount_before_vat <= 0 or p_cash_amount_before_vat > 99999999
       or round(p_cash_amount_before_vat, 2) <> p_cash_amount_before_vat then
      raise exception 'המחיר לפני מע"מ חייב להיות חיובי, עם עד שתי ספרות אחרי הנקודה.';
    end if;
    v_amount := round(p_cash_amount_before_vat * (1 + v_order.vat_rate_snapshot), 2);
    select * into v_obligation from public.financial_obligations where order_id = p_order_id for update;
    if not found then
      raise exception 'חסר חיוב להזמנה; נדרשת בדיקת נתונים לפני עריכה.';
    end if;
    v_received := private.obligation_received(v_obligation.id);
    if v_amount < v_received then
      raise exception 'הסכום החדש כולל מע"מ (%) נמוך מהסכום שכבר התקבל (%). יש לבטל תקבול לפני הורדת המחיר.',
        v_amount, v_received;
    end if;
    update public.orders set cash_amount_before_vat = p_cash_amount_before_vat, amount = v_amount
    where id = p_order_id;
    update public.financial_obligations set amount_due = v_amount, amount_before_vat = p_cash_amount_before_vat
    where id = v_obligation.id;
    perform private.refresh_obligation_status(v_obligation.id);
  elsif v_order.billing_mode = 'credits' then
    if p_cash_amount_before_vat is not null then
      raise exception 'הזמנת קרדיטים אינה יכולה לקבל מחיר. הזמנה היא כספית או בקרדיטים, לא שניהם.';
    end if;
    if p_credits_used is null or p_credits_used <= 0 or round(p_credits_used, 2) <> p_credits_used then
      raise exception 'כמות הקרדיטים חייבת להיות חיובית, עם עד שתי ספרות אחרי הנקודה.';
    end if;
    v_delta := v_order.credits_used - p_credits_used;
    if v_delta <> 0 then
      update public.orders set credits_used = p_credits_used where id = p_order_id;
      insert into public.credit_ledger (client_id, delta, entry_type, order_id, reason, idempotency_key, created_by)
      values (v_order.client_id, v_delta, 'order_adjustment', p_order_id,
        'עדכון קרדיטים בהזמנה ' || v_order.order_number || ': ' || v_order.credits_used || ' → ' || p_credits_used,
        gen_random_uuid(), auth.uid());
    end if;
  else
    raise exception 'בהזמנה ישנה לא ידוע אם הסכום כולל מע"מ, ולכן אי אפשר לשנות את החיוב שלה כאן.';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  v_result := pg_catalog.jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number,
    'amount', v_order.amount, 'credits_used', v_order.credits_used, 'updated_at', v_order.updated_at);
  update private.business_operations set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

-- ---------- 9. cancel_business_order: documented cancellation instead of deletion ----------
-- The order stays in the database. Credits used are returned once (unique index); an open charge is cancelled;
-- money already received is kept and shown as such (a refund is recorded separately with
-- reverse_obligation_payment). Cancelling an order that is already cancelled changes nothing.
create or replace function public.cancel_business_order(
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
  v_obligation public.financial_obligations%rowtype;
  v_consumed numeric := 0;
  v_received numeric(12, 2) := 0;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_result jsonb;
begin
  perform private.require_approved_user();
  if p_order_id is null then
    raise exception 'ההזמנה לא נמצאה.';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'נדרשת סיבת ביטול (3 עד 500 תווים).';
  end if;
  v_cached := private.claim_business_operation(
    p_idempotency_key, 'cancel_business_order',
    pg_catalog.md5(pg_catalog.jsonb_build_array(p_order_id, p_expected_updated_at, v_reason)::text)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ההזמנה לא נמצאה.';
  end if;

  if v_order.cancelled_at is not null then
    v_result := pg_catalog.jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number,
      'already_cancelled', true, 'credits_returned', 0, 'cash_received_kept', 0, 'updated_at', v_order.updated_at);
    update private.business_operations set response = v_result where idempotency_key = p_idempotency_key;
    return v_result;
  end if;
  if p_expected_updated_at is null or v_order.updated_at <> p_expected_updated_at then
    raise exception using errcode = '40001',
      message = 'ההזמנה עודכנה אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
  end if;

  if v_order.billing_mode = 'credits' then
    select -coalesce(sum(delta), 0) into v_consumed
    from public.credit_ledger
    where order_id = p_order_id and entry_type in ('order_consumption', 'order_adjustment', 'order_cancellation');
    if v_consumed > 0 then
      insert into public.credit_ledger (client_id, delta, entry_type, order_id, reason, idempotency_key, created_by)
      values (v_order.client_id, v_consumed, 'order_cancellation', p_order_id,
        'החזרת קרדיטים בביטול הזמנה ' || v_order.order_number || ': ' || v_reason,
        gen_random_uuid(), auth.uid());
    end if;
  else
    select * into v_obligation from public.financial_obligations where order_id = p_order_id for update;
    if found and v_obligation.status <> 'cancelled' then
      v_received := private.obligation_received(v_obligation.id);
      update public.financial_obligations
      set status = 'cancelled', cancelled_at = pg_catalog.now(), cancelled_by = auth.uid(),
          cancel_reason = v_reason, received_at_cancel = v_received
      where id = v_obligation.id;
    end if;
  end if;

  update public.orders
  set cancelled_at = pg_catalog.now(), cancelled_by = auth.uid(), cancel_reason = v_reason
  where id = p_order_id
  returning * into v_order;

  v_result := pg_catalog.jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number,
    'already_cancelled', false, 'credits_returned', greatest(v_consumed, 0),
    'cash_received_kept', v_received, 'updated_at', v_order.updated_at);
  update private.business_operations set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

-- ---------- 10. record_obligation_payment: a receipt (full or partial) ----------
-- Each receipt is a separate event; nothing is overwritten. More than the open balance is refused.
create or replace function public.record_obligation_payment(
  p_obligation_id uuid,
  p_amount numeric,
  p_received_on date,
  p_notes text,
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
  v_received numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_status text;
  v_result jsonb;
begin
  perform private.require_approved_user();
  if p_obligation_id is null or p_expected_updated_at is null then
    raise exception 'חסר מזהה הגרסה של החיוב. יש לרענן את הנתונים.';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 99999999 or round(p_amount, 2) <> p_amount then
    raise exception 'סכום התקבול חייב להיות חיובי, עם עד שתי ספרות אחרי הנקודה.';
  end if;
  if p_received_on is null or p_received_on > private.business_today() + 1 then
    raise exception 'תאריך התקבול אינו תקין.';
  end if;
  if length(coalesce(p_notes, '')) > 500 then
    raise exception 'ההערה ארוכה מ-500 תווים.';
  end if;
  v_cached := private.claim_business_operation(
    p_idempotency_key, 'record_obligation_payment',
    pg_catalog.md5(pg_catalog.jsonb_build_array(p_obligation_id, p_amount, p_received_on, p_notes,
      p_expected_updated_at)::text)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select * into v_obligation from public.financial_obligations where id = p_obligation_id for update;
  if not found then
    raise exception 'החיוב לא נמצא.';
  end if;
  if v_obligation.updated_at <> p_expected_updated_at then
    raise exception using errcode = '40001',
      message = 'החיוב עודכן אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
  end if;
  if v_obligation.status = 'cancelled' then
    raise exception 'החיוב בוטל; אי אפשר לרשום עליו תקבול.';
  end if;
  v_received := private.obligation_received(p_obligation_id);
  v_outstanding := v_obligation.amount_due - v_received;
  if v_outstanding <= 0 then
    raise exception 'החיוב כבר שולם במלואו.';
  end if;
  if p_amount > v_outstanding then
    raise exception 'הסכום גבוה מהיתרה לתשלום (% ש"ח). גבייה מעבר לחיוב אינה נרשמת כאן.', v_outstanding;
  end if;

  insert into public.business_payment_events (
    obligation_id, event_type, amount, event_at, received_on, notes, idempotency_key, created_by
  )
  values (
    p_obligation_id, 'payment', p_amount,
    (p_received_on::timestamp + interval '12 hours') at time zone 'Asia/Jerusalem',
    p_received_on, btrim(coalesce(p_notes, '')), gen_random_uuid(), auth.uid()
  );
  v_status := private.refresh_obligation_status(p_obligation_id);
  -- Make the new version visible to optimistic-concurrency checks even when the status did not change.
  update public.financial_obligations set updated_at = pg_catalog.now()
  where id = p_obligation_id returning * into v_obligation;

  v_received := private.obligation_received(p_obligation_id);
  v_result := pg_catalog.jsonb_build_object('obligation_id', p_obligation_id, 'status', v_status,
    'received', v_received, 'outstanding', greatest(v_obligation.amount_due - v_received, 0),
    'updated_at', v_obligation.updated_at);
  update private.business_operations set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

-- ---------- 11. reverse_obligation_payment: documented reversal / refund of one receipt ----------
create or replace function public.reverse_obligation_payment(
  p_event_id uuid,
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
  v_event public.business_payment_events%rowtype;
  v_obligation public.financial_obligations%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_status text;
  v_received numeric(12, 2);
  v_result jsonb;
begin
  perform private.require_approved_user();
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'נדרשת סיבה לביטול התקבול (3 עד 500 תווים).';
  end if;
  v_cached := private.claim_business_operation(
    p_idempotency_key, 'reverse_obligation_payment',
    pg_catalog.md5(pg_catalog.jsonb_build_array(p_event_id, v_reason)::text)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select * into v_event from public.business_payment_events where id = p_event_id;
  if not found or v_event.event_type <> 'payment' then
    raise exception 'התקבול לא נמצא.';
  end if;
  select * into v_obligation from public.financial_obligations where id = v_event.obligation_id for update;
  if exists (select 1 from public.business_payment_events where reverses_event_id = p_event_id) then
    raise exception 'התקבול הזה כבר בוטל.';
  end if;

  insert into public.business_payment_events (
    obligation_id, event_type, amount, received_on, notes, reverses_event_id, idempotency_key, created_by
  )
  values (
    v_event.obligation_id, 'reversal', -v_event.amount, private.business_today(), v_reason, p_event_id,
    gen_random_uuid(), auth.uid()
  );
  v_status := private.refresh_obligation_status(v_event.obligation_id);
  update public.financial_obligations set updated_at = pg_catalog.now()
  where id = v_event.obligation_id returning * into v_obligation;
  v_received := private.obligation_received(v_event.obligation_id);

  v_result := pg_catalog.jsonb_build_object('obligation_id', v_event.obligation_id, 'status', v_status,
    'received', v_received, 'updated_at', v_obligation.updated_at);
  update private.business_operations set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

-- ---------- 12. update_installment_schedule: change unpaid installments after the purchase ----------
-- p_items = the complete new schedule: [{ "obligation_id": uuid|null, "due_on": date, "amount_before_vat": n }].
--   * A fully paid installment must appear unchanged (its receipts are history).
--   * A partly paid installment may change, but not below what was received.
--   * An unpaid installment that is left out is cancelled (kept as history), never deleted.
--   * A new row (no obligation_id) adds an installment.
--   * The amounts before VAT of all active installments must equal the package price.
-- package_installments is append-only, so the current amount and date live on the obligation.
create or replace function public.update_installment_schedule(
  p_customer_package_id uuid,
  p_expected_updated_at timestamptz,
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
  v_package public.customer_packages%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_item jsonb;
  v_current record;
  v_id uuid;
  v_due date;
  v_net numeric;
  v_gross numeric(12, 2);
  v_received numeric(12, 2);
  v_seen uuid[] := '{}';
  v_sum_net numeric := 0;
  v_next_number integer;
  v_installment_id uuid;
  v_count integer := 0;
  v_result jsonb;
begin
  perform private.require_approved_user();
  if p_customer_package_id is null or p_expected_updated_at is null then
    raise exception 'חסר מזהה הגרסה של החבילה. יש לרענן את הנתונים.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 60 then
    raise exception 'לוח התשלומים צריך לכלול בין תשלום אחד ל-60 תשלומים.';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'נדרשת סיבה לשינוי לוח התשלומים (3 עד 500 תווים).';
  end if;
  v_cached := private.claim_business_operation(
    p_idempotency_key, 'update_installment_schedule',
    pg_catalog.md5(pg_catalog.jsonb_build_array(p_customer_package_id, p_expected_updated_at, p_items, v_reason)::text)
  );
  if v_cached is not null then
    return v_cached;
  end if;

  select * into v_package from public.customer_packages where id = p_customer_package_id for update;
  if not found then
    raise exception 'החבילה לא נמצאה.';
  end if;
  if v_package.updated_at <> p_expected_updated_at then
    raise exception using errcode = '40001',
      message = 'החבילה עודכנה אצל משתמש אחר. רענני את הנתונים ונסי שוב.';
  end if;
  if v_package.status = 'cancelled' then
    raise exception 'החבילה בוטלה; אי אפשר לשנות את לוח התשלומים שלה.';
  end if;

  -- Validate every item first.
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_due := nullif(v_item ->> 'due_on', '')::date;
    v_net := nullif(v_item ->> 'amount_before_vat', '')::numeric;
    if v_due is null or v_net is null or v_net <= 0 or v_net > 99999999 or round(v_net, 2) <> v_net then
      raise exception 'תשלום % אינו תקין: נדרשים מועד וסכום חיובי לפני מע"מ.', v_count;
    end if;
    v_id := nullif(v_item ->> 'obligation_id', '')::uuid;
    if v_id is not null then
      if v_id = any (v_seen) then
        raise exception 'תשלום % מופיע פעמיים.', v_count;
      end if;
      v_seen := v_seen || v_id;
      perform 1
      from public.financial_obligations as f
      join public.package_installments as i on i.id = f.package_installment_id
      where f.id = v_id and i.customer_package_id = p_customer_package_id and f.status <> 'cancelled';
      if not found then
        raise exception 'תשלום % אינו שייך לחבילה הזו.', v_count;
      end if;
    end if;
    v_sum_net := v_sum_net + v_net;
  end loop;
  if v_sum_net <> v_package.price_before_vat then
    raise exception 'סכום התשלומים לפני מע"מ (%) חייב להיות שווה למחיר החבילה (%).', v_sum_net, v_package.price_before_vat;
  end if;

  -- Existing active installments: unchanged if paid, updated if listed, cancelled if left out.
  for v_current in
    select f.id, f.status, f.amount_due, f.due_on,
           coalesce(f.amount_before_vat, i.amount_before_vat) as net
    from public.financial_obligations as f
    join public.package_installments as i on i.id = f.package_installment_id
    where i.customer_package_id = p_customer_package_id and f.status <> 'cancelled'
    for update of f
  loop
    v_received := private.obligation_received(v_current.id);
    v_item := null; -- SELECT INTO keeps the old value when nothing matches
    select value into v_item from jsonb_array_elements(p_items) as e(value)
    where nullif(value ->> 'obligation_id', '')::uuid = v_current.id;
    if v_item is null then
      if v_received > 0 then
        raise exception 'אי אפשר להסיר תשלום שכבר התקבל עליו כסף (% ש"ח).', v_received;
      end if;
      update public.financial_obligations
      set status = 'cancelled', cancelled_at = pg_catalog.now(), cancelled_by = auth.uid(),
          cancel_reason = 'שינוי לוח תשלומים: ' || v_reason, received_at_cancel = 0
      where id = v_current.id;
    else
      v_due := (v_item ->> 'due_on')::date;
      v_net := (v_item ->> 'amount_before_vat')::numeric;
      v_gross := round(v_net * (1 + v_package.vat_rate_snapshot), 2);
      if v_current.status = 'paid' then
        if v_net <> v_current.net or v_due <> v_current.due_on then
          raise exception 'תשלום שהתקבל במלואו אינו ניתן לשינוי.';
        end if;
      else
        if v_gross < v_received then
          raise exception 'סכום התשלום כולל מע"מ (%) נמוך מהסכום שכבר התקבל עליו (%).', v_gross, v_received;
        end if;
        if v_net <> v_current.net or v_due is distinct from v_current.due_on then
          update public.financial_obligations
          set amount_due = v_gross, amount_before_vat = v_net, due_on = v_due
          where id = v_current.id;
          perform private.refresh_obligation_status(v_current.id);
        end if;
      end if;
    end if;
    v_item := null;
  end loop;

  -- New installments.
  select coalesce(max(installment_number), 0) into v_next_number
  from public.package_installments where customer_package_id = p_customer_package_id;
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if nullif(v_item ->> 'obligation_id', '') is null then
      v_next_number := v_next_number + 1;
      v_due := (v_item ->> 'due_on')::date;
      v_net := (v_item ->> 'amount_before_vat')::numeric;
      v_gross := round(v_net * (1 + v_package.vat_rate_snapshot), 2);
      insert into public.package_installments (
        customer_package_id, installment_number, due_on, amount_before_vat, vat_rate_snapshot, amount_due
      )
      values (p_customer_package_id, v_next_number, v_due, v_net, v_package.vat_rate_snapshot, v_gross)
      returning id into v_installment_id;
      insert into public.financial_obligations (
        package_installment_id, amount_due, amount_before_vat, due_on, status, created_by
      )
      values (v_installment_id, v_gross, v_net, v_due, 'pending', auth.uid());
    end if;
  end loop;

  update public.customer_packages as p
  set installment_count = s.n, gross_total = s.gross
  from (
    select count(*)::integer as n, sum(f.amount_due) as gross
    from public.financial_obligations as f
    join public.package_installments as i on i.id = f.package_installment_id
    where i.customer_package_id = p_customer_package_id and f.status <> 'cancelled'
  ) as s
  where p.id = p_customer_package_id
  returning p.* into v_package;

  v_result := pg_catalog.jsonb_build_object('customer_package_id', p_customer_package_id,
    'installment_count', v_package.installment_count, 'gross_total', v_package.gross_total,
    'updated_at', v_package.updated_at);
  update private.business_operations set response = v_result where idempotency_key = p_idempotency_key;
  return v_result;
end;
$function$;

-- ---------- 13. Financial views: one source for every money figure on every screen ----------
-- Same columns as before (in the same order) plus new ones at the end. A cancelled charge is no longer open
-- debt: its "due" equals the money actually kept, so outstanding is 0 and history stays visible.
drop view if exists public.business_financial_totals;
drop view if exists public.business_financial_summary;
drop view if exists public.business_order_financial_summary;

create view public.business_order_financial_summary
with (security_invoker = true)
as
select
  b.order_id,
  b.client_id,
  b.order_number,
  b.publication_date,
  b.section,
  b.sheet_number,
  b.billing_mode,
  (case when b.billing_mode = 'credits' then 0
        when b.is_cancelled then b.received
        else b.due_full end)::numeric as cash_due,
  b.received::numeric as cash_received,
  b.due_on,
  (case when b.is_cancelled then 'cancelled' else b.status end)::text as payment_status,
  b.legacy_snapshot,
  b.receipt_basis,
  b.has_payment_history,
  b.missing_obligation,
  (not b.is_cancelled and (
     (b.status = 'paid' and b.due_full > b.received)
     or (b.status = 'pending' and b.due_full > 0 and b.received >= b.due_full)
  )) as payment_status_mismatch,
  b.obligation_id,
  b.is_cancelled,
  b.ad_description,
  b.obligation_updated_at
from (
  select
    orders.id as order_id,
    orders.client_id,
    orders.order_number,
    orders.publication_date,
    orders.section,
    orders.sheet_number,
    orders.billing_mode,
    orders.ad_description,
    obligations.id as obligation_id,
    obligations.updated_at as obligation_updated_at,
    (orders.cancelled_at is not null or obligations.status = 'cancelled') as is_cancelled,
    case when orders.billing_mode = 'credits' then 0::numeric
         else coalesce(obligations.amount_due, orders.amount)::numeric end as due_full,
    case
      when orders.billing_mode = 'legacy' and orders.amount = 0 then 0::numeric
      when orders.billing_mode = 'credits' then 0::numeric
      when payments.payment_count + events.event_count = 0 and obligations.legacy_snapshot
           and obligations.status = 'paid' then obligations.amount_due::numeric
      when payments.payment_count + events.event_count = 0 and obligations.legacy_snapshot
           and obligations.status = 'cancelled' then coalesce(obligations.received_at_cancel, 0)::numeric
      else (payments.received + events.received)::numeric
    end as received,
    obligations.due_on,
    coalesce(obligations.status, orders.payment_status) as status,
    coalesce(obligations.legacy_snapshot, orders.billing_mode = 'legacy') as legacy_snapshot,
    case
      when orders.billing_mode = 'legacy' and orders.amount = 0 then 'non_cash_order'
      when payments.payment_count > 0 and events.event_count > 0 then 'combined_records'
      when payments.payment_count > 0 then 'public_payments'
      when events.event_count > 0 then 'business_payment_events'
      when obligations.legacy_snapshot and obligations.status in ('paid', 'cancelled')
        then 'legacy_paid_status_without_receipt_date'
      else 'no_receipt_record'
    end as receipt_basis,
    payments.payment_count > 0 or events.event_count > 0 as has_payment_history,
    obligations.id is null
      and orders.billing_mode <> 'credits'
      and not (orders.billing_mode = 'legacy' and orders.amount = 0) as missing_obligation
  from public.orders as orders
  left join public.financial_obligations as obligations on obligations.order_id = orders.id
  left join lateral (
    select coalesce(sum(payments.amount), 0)::numeric(12, 2) as received, count(*)::integer as payment_count
    from public.payments as payments where payments.order_id = orders.id
  ) as payments on true
  left join lateral (
    select coalesce(sum(events.amount), 0)::numeric(12, 2) as received, count(*)::integer as event_count
    from public.business_payment_events as events where events.obligation_id = obligations.id
  ) as events on true
) as b;

create view public.business_financial_summary
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
  case when greatest(orders.cash_due - orders.cash_received, 0) > 0 and orders.due_on < private.business_today()
       then greatest(orders.cash_due - orders.cash_received, 0) else 0::numeric end::numeric(12, 2) as overdue_amount,
  case when greatest(orders.cash_due - orders.cash_received, 0) > 0 and orders.due_on > private.business_today()
       then greatest(orders.cash_due - orders.cash_received, 0) else 0::numeric end::numeric(12, 2) as future_amount,
  case when greatest(orders.cash_due - orders.cash_received, 0) > 0 and orders.due_on = private.business_today()
       then greatest(orders.cash_due - orders.cash_received, 0) else 0::numeric end::numeric(12, 2) as due_today_amount,
  case when greatest(orders.cash_due - orders.cash_received, 0) > 0 and orders.due_on is null
       then greatest(orders.cash_due - orders.cash_received, 0) else 0::numeric end::numeric(12, 2) as no_due_date_amount,
  orders.legacy_snapshot,
  orders.receipt_basis,
  orders.has_payment_history,
  orders.missing_obligation,
  orders.payment_status_mismatch,
  orders.obligation_id,
  orders.is_cancelled,
  null::uuid as customer_package_id,
  orders.obligation_updated_at
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
  x.cash_due,
  x.received,
  greatest(x.cash_due - x.received, 0)::numeric(12, 2),
  obligations.due_on,
  (case when x.is_cancelled then 'cancelled' else obligations.status end)::text,
  case when greatest(x.cash_due - x.received, 0) > 0 and obligations.due_on < private.business_today()
       then greatest(x.cash_due - x.received, 0) else 0::numeric end::numeric(12, 2),
  case when greatest(x.cash_due - x.received, 0) > 0 and obligations.due_on > private.business_today()
       then greatest(x.cash_due - x.received, 0) else 0::numeric end::numeric(12, 2),
  case when greatest(x.cash_due - x.received, 0) > 0 and obligations.due_on = private.business_today()
       then greatest(x.cash_due - x.received, 0) else 0::numeric end::numeric(12, 2),
  0::numeric(12, 2),
  false,
  case when events.event_count > 0 then 'business_payment_events' else 'no_receipt_record' end,
  events.event_count > 0,
  false,
  false,
  obligations.id,
  x.is_cancelled,
  packages.id,
  obligations.updated_at
from public.package_installments as installments
join public.customer_packages as packages on packages.id = installments.customer_package_id
join public.financial_obligations as obligations on obligations.package_installment_id = installments.id
left join lateral (
  select coalesce(sum(events.amount), 0)::numeric(12, 2) as received, count(*)::integer as event_count
  from public.business_payment_events as events where events.obligation_id = obligations.id
) as events on true
cross join lateral (
  select obligations.status = 'cancelled' as is_cancelled,
         events.received::numeric as received,
         (case when obligations.status = 'cancelled' then events.received
               else obligations.amount_due end)::numeric as cash_due
) as x;

create view public.business_financial_totals
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

revoke all on public.business_order_financial_summary, public.business_financial_summary,
  public.business_financial_totals from public, anon;
grant select on public.business_order_financial_summary, public.business_financial_summary,
  public.business_financial_totals to authenticated;

-- ---------- 14. Function permissions ----------
revoke all on function public.create_orders_batch(text, jsonb, uuid) from public, anon;
grant execute on function public.create_orders_batch(text, jsonb, uuid) to authenticated;
revoke all on function public.update_order_details(text, timestamptz, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.update_order_details(text, timestamptz, text, text, text, text, text, uuid) to authenticated;
revoke all on function public.update_order_charge(text, timestamptz, numeric, numeric, uuid) from public, anon;
grant execute on function public.update_order_charge(text, timestamptz, numeric, numeric, uuid) to authenticated;
revoke all on function public.cancel_business_order(text, timestamptz, text, uuid) from public, anon;
grant execute on function public.cancel_business_order(text, timestamptz, text, uuid) to authenticated;
revoke all on function public.record_obligation_payment(uuid, numeric, date, text, timestamptz, uuid) from public, anon;
grant execute on function public.record_obligation_payment(uuid, numeric, date, text, timestamptz, uuid) to authenticated;
revoke all on function public.reverse_obligation_payment(uuid, text, uuid) from public, anon;
grant execute on function public.reverse_obligation_payment(uuid, text, uuid) to authenticated;
revoke all on function public.update_installment_schedule(uuid, timestamptz, jsonb, text, uuid) from public, anon;
grant execute on function public.update_installment_schedule(uuid, timestamptz, jsonb, text, uuid) to authenticated;

-- ---------- 15. Final check inside the transaction ----------
do $final$
begin
  if exists (select 1 from public.orders where file_status is null or placement_status is null) then
    raise exception 'Workflow status backfill failed.';
  end if;
  perform 1 from public.business_financial_totals;
end;
$final$;

commit;
