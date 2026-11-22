-- =====================================================================================================
-- supabase-orders-v3-rollback.sql — undo supabase-orders-v3.sql. NOT RUN. Requires explicit approval.
--
-- PART 1 restores the previous functions, views and constraints. It is safe only while the new model has not
-- been used for real: it stops (and changes nothing) if any order was cancelled, any partial/reversed receipt
-- or schedule change exists, or any order was created without a product. In that case do NOT roll back the
-- database: deploy the previous site version only (it still works with the new database) and ask for help.
-- PART 2 (optional, separate) drops the new columns. Only after PART 1, and only if they hold no data.
-- The original definitions below are copied verbatim from supabase-business-upgrade.sql.
-- =====================================================================================================

-- ===================== PART 1 =====================
begin;

do $guard$
begin
  if exists (select 1 from public.orders where cancelled_at is not null)
     or exists (select 1 from public.financial_obligations where status = 'cancelled')
     or exists (select 1 from public.credit_ledger where entry_type in ('order_cancellation', 'order_adjustment'))
     or exists (select 1 from public.business_payment_events where reverses_event_id is not null)
     or exists (select 1 from public.orders where billing_mode <> 'legacy' and product_id is null) then
    raise exception 'The new model is already in use (cancellations, schedule changes or orders without a product). Rollback stopped; nothing was changed.';
  end if;
  if exists (
    select 1 from (
      select f.id, f.amount_due, coalesce(sum(e.amount), 0) as received
      from public.financial_obligations f
      join public.business_payment_events e on e.obligation_id = f.id
      group by f.id
    ) x where x.received <> 0 and x.received <> x.amount_due
  ) then
    raise exception 'Partial receipts exist; the previous model cannot represent them. Rollback stopped; nothing was changed.';
  end if;
end;
$guard$;

drop function if exists public.update_order_details(text, timestamptz, text, text, text, text, text, uuid);
drop function if exists public.update_order_charge(text, timestamptz, numeric, numeric, uuid);
drop function if exists public.cancel_business_order(text, timestamptz, text, uuid);
drop function if exists public.record_obligation_payment(uuid, numeric, date, text, timestamptz, uuid);
drop function if exists public.reverse_obligation_payment(uuid, text, uuid);
drop function if exists public.update_installment_schedule(uuid, timestamptz, jsonb, text, uuid);

-- Original create_orders_batch (product required).
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
    if v_cash is not null
       and (v_cash <= 0 or v_cash > 99999999 or round(v_cash, 2) <> v_cash) then
      raise exception 'המחיר בשורה % חייב להיות חיובי, עד 99,999,999 ש"ח, ובדיוק שתי ספרות אחרי הנקודה.', v_count;
    end if;
    v_credits := nullif(v_row ->> 'credits_used', '')::numeric;
    if (v_cash is not null and v_cash <= 0)
       or (v_credits is not null and
         (v_credits <= 0 or round(v_credits, 2) <> v_credits))
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

-- Original financial views.
drop view if exists public.business_financial_totals;
drop view if exists public.business_financial_summary;
drop view if exists public.business_order_financial_summary;

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
    when orders.billing_mode = 'legacy' and orders.amount = 0 then 0::numeric
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
    when orders.billing_mode = 'legacy' and orders.amount = 0 then 'non_cash_order'
    when payments.payment_count > 0 and events.event_count > 0 then 'combined_records'
    when payments.payment_count > 0 then 'public_payments'
    when events.event_count > 0 then 'business_payment_events'
    when obligations.legacy_snapshot and obligations.status = 'paid'
      then 'legacy_paid_status_without_receipt_date'
    else 'no_receipt_record'
  end as receipt_basis,
  payments.payment_count > 0 or events.event_count > 0 as has_payment_history,
  obligations.id is null
    and orders.billing_mode <> 'credits'
    and not (orders.billing_mode = 'legacy' and orders.amount = 0)
    as missing_obligation,
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

grant select on public.business_order_financial_summary,
  public.business_financial_summary, public.business_financial_totals to authenticated;
revoke all on public.business_order_financial_summary,
  public.business_financial_summary, public.business_financial_totals from public, anon;

-- Original constraints.
alter table public.financial_obligations
  drop constraint if exists financial_obligations_status_check,
  drop constraint if exists financial_obligations_paid_timestamp_check,
  drop constraint if exists financial_obligations_cancellation_check,
  drop constraint if exists financial_obligations_amount_before_vat_check,
  add constraint financial_obligations_status_check check (status in ('pending', 'paid')),
  add constraint financial_obligations_paid_timestamp_check
    check (
      (status = 'pending' and paid_at is null and paid_by is null)
      or (status = 'paid' and (
        (paid_at is not null and paid_by is not null)
        or (legacy_snapshot and paid_at is null and paid_by is null)
      ))
    );

alter table public.credit_ledger
  drop constraint if exists credit_ledger_entry_type_check,
  drop constraint if exists credit_ledger_entry_shape_check,
  add constraint credit_ledger_entry_type_check check (
    entry_type in ('package_grant', 'order_consumption', 'correction', 'conversion_reversal')
  ),
  add constraint credit_ledger_entry_shape_check check (
    (entry_type = 'package_grant' and customer_package_id is not null and order_id is null and delta > 0)
    or (entry_type = 'order_consumption' and order_id is not null and customer_package_id is null and delta < 0)
    or (entry_type = 'correction' and customer_package_id is null)
    or (entry_type = 'conversion_reversal' and order_id is null and customer_package_id is null)
  );
drop index if exists public.credit_ledger_one_cancellation_per_order_uidx;
drop index if exists public.business_payment_events_one_reversal_uidx;

alter table public.orders
  drop constraint if exists orders_cancellation_check;

drop function if exists private.refresh_obligation_status(uuid);
drop function if exists private.obligation_received(uuid);
drop function if exists private.require_approved_user();

commit;

-- ===================== PART 2 (optional; separate approval) =====================
-- Drops the new columns. Only after PART 1. The values in them (descriptions, file/placement statuses) are lost,
-- so export them first if they were filled in.
-- begin;
-- alter table public.orders
--   drop constraint if exists orders_ad_description_check,
--   drop constraint if exists orders_file_status_check,
--   drop constraint if exists orders_placement_status_check,
--   drop column if exists ad_description, drop column if exists file_status, drop column if exists placement_status,
--   drop column if exists cancelled_at, drop column if exists cancelled_by, drop column if exists cancel_reason;
-- drop index if exists public.orders_active_entered_idx;
-- alter table public.financial_obligations
--   drop column if exists amount_before_vat, drop column if exists cancelled_at, drop column if exists cancelled_by,
--   drop column if exists cancel_reason, drop column if exists received_at_cancel;
-- alter table public.business_payment_events drop column if exists received_on, drop column if exists reverses_event_id;
-- commit;
