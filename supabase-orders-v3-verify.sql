-- =====================================================================================================
-- supabase-orders-v3-verify.sql — read-only checks right after supabase-orders-v3.sql. NOT RUN.
-- Returns one table: check | result (PASS / FAIL / INFO). Compare the INFO counts with PART A of
-- supabase-readonly-audit.sql taken just before the installation: they must be identical.
-- =====================================================================================================
begin;
set transaction read only;

with
cols as (
  select count(*) filter (where table_name = 'orders' and column_name in
           ('ad_description', 'file_status', 'placement_status', 'cancelled_at', 'cancelled_by', 'cancel_reason')) as orders_cols,
         count(*) filter (where table_name = 'financial_obligations' and column_name in
           ('amount_before_vat', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'received_at_cancel')) as obligation_cols,
         count(*) filter (where table_name = 'business_payment_events' and column_name in
           ('received_on', 'reverses_event_id')) as event_cols
  from information_schema.columns where table_schema = 'public'
),
funcs as (
  select count(*) as n from (values
    ('public.create_orders_batch(text, jsonb, uuid)'),
    ('public.update_order_details(text, timestamptz, text, text, text, text, text, uuid)'),
    ('public.update_order_charge(text, timestamptz, numeric, numeric, uuid)'),
    ('public.cancel_business_order(text, timestamptz, text, uuid)'),
    ('public.record_obligation_payment(uuid, numeric, date, text, timestamptz, uuid)'),
    ('public.reverse_obligation_payment(uuid, text, uuid)'),
    ('public.update_installment_schedule(uuid, timestamptz, jsonb, text, uuid)'),
    ('private.obligation_received(uuid)'),
    ('private.refresh_obligation_status(uuid)'),
    ('private.business_today()')
  ) as f(sig) where to_regprocedure(f.sig) is not null
),
grants as (
  select bool_and(has_function_privilege('authenticated', f.sig, 'execute')) as auth_ok,
         bool_and(not has_function_privilege('anon', f.sig, 'execute')) as anon_blocked
  from (values
    ('public.update_order_details(text, timestamptz, text, text, text, text, text, uuid)'),
    ('public.update_order_charge(text, timestamptz, numeric, numeric, uuid)'),
    ('public.cancel_business_order(text, timestamptz, text, uuid)'),
    ('public.record_obligation_payment(uuid, numeric, date, text, timestamptz, uuid)'),
    ('public.reverse_obligation_payment(uuid, text, uuid)'),
    ('public.update_installment_schedule(uuid, timestamptz, jsonb, text, uuid)')
  ) as f(sig)
),
o as (
  select count(*) as total,
         count(*) filter (where file_status = 'unknown' and placement_status = 'unknown') as unknown_statuses,
         count(*) filter (where cancelled_at is not null) as cancelled,
         count(*) filter (where ad_description is not null) as with_description
  from public.orders
),
t as (select * from public.business_financial_totals)
select 'columns: orders (6)' as check_name, case when cols.orders_cols = 6 then 'PASS' else 'FAIL ' || cols.orders_cols end as result from cols
union all select 'columns: financial_obligations (5)', case when cols.obligation_cols = 5 then 'PASS' else 'FAIL ' || cols.obligation_cols end from cols
union all select 'columns: business_payment_events (2)', case when cols.event_cols = 2 then 'PASS' else 'FAIL ' || cols.event_cols end from cols
union all select 'functions present (10)', case when funcs.n = 10 then 'PASS' else 'FAIL ' || funcs.n end from funcs
union all select 'order date = Israel date (entered_at default uses private.business_today)', case when (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'entered_at') like '%business_today%' then 'PASS' else 'FAIL' end
union all select 'functions: authenticated may execute', case when grants.auth_ok then 'PASS' else 'FAIL' end from grants
union all select 'functions: anon blocked', case when grants.anon_blocked then 'PASS' else 'FAIL' end from grants
union all select 'views readable', case when to_regclass('public.business_financial_summary') is not null
                                          and to_regclass('public.business_financial_totals') is not null then 'PASS' else 'FAIL' end
union all select 'existing orders: statuses = unknown (no inference)',
  case when o.unknown_statuses = o.total then 'PASS' else 'INFO ' || (o.total - o.unknown_statuses) || ' already set' end from o
union all select 'existing orders: none cancelled by the installation',
  case when o.cancelled = 0 then 'PASS' else 'INFO ' || o.cancelled end from o
union all select 'existing orders: no description invented',
  case when o.with_description = 0 then 'PASS' else 'INFO ' || o.with_description || ' (orders created after the installation)' end from o
union all select 'constraint: obligation status allows cancelled',
  case when exists (select 1 from pg_constraint where conname = 'financial_obligations_status_check'
                    and pg_get_constraintdef(oid) like '%cancelled%') then 'PASS' else 'FAIL' end
union all select 'index: one credit return per cancelled order',
  case when to_regclass('public.credit_ledger_one_cancellation_per_order_uidx') is not null then 'PASS' else 'FAIL' end
union all select 'index: one reversal per receipt',
  case when to_regclass('public.business_payment_events_one_reversal_uidx') is not null then 'PASS' else 'FAIL' end
union all select 'INFO orders total', o.total::text from o
union all select 'INFO money billed / received / outstanding', t.total_cash_billed || ' / ' || t.total_cash_received || ' / ' || t.total_cash_outstanding from t
union all select 'INFO orders missing a charge / status mismatches', t.orders_missing_obligation || ' / ' || t.payment_status_mismatches from t
union all select 'INFO credits total balance', (select coalesce(sum(credit_balance), 0)::text from public.business_client_credit_balances);

rollback;
