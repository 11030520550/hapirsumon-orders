-- READ-ONLY consolidated preflight for supabase-business-upgrade.sql.
-- Paste the whole file into the Supabase SQL Editor and run it once.
-- Returns ONE table: one row per critical condition with PASS / FAIL / WARN / INFO.
-- Only counts and schema metadata are returned: no client names, IDs or amounts per row.
-- FAIL = the migration will stop or must not be run. WARN = review before running.
-- Data checks run through query_to_xml only when the needed tables/columns exist,
-- so a missing column is reported as FAIL instead of aborting the whole query.

with env as (
  select
    current_setting('server_version_num')::integer as version_num,
    current_setting('server_version') as version_text,
    pg_catalog.to_regclass('public.clients') is not null as has_clients,
    pg_catalog.to_regclass('public.orders') is not null as has_orders,
    pg_catalog.to_regclass('public.payments') is not null as has_payments,
    pg_catalog.to_regclass('private.approved_users') is not null as has_allowlist,
    pg_catalog.to_regprocedure('private.is_approved_user()') is not null as has_approval_fn,
    pg_catalog.to_regprocedure('public.current_user_is_approved()') is not null as has_approval_rpc,
    pg_catalog.to_regclass('public.credit_ledger') is not null as business_installed,
    exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') as has_realtime
),
expected_columns as (
  select expected.table_name, expected.column_name,
    case
      when columns.column_name is null then 'MISSING'
      when columns.data_type <> expected.data_type then 'TYPE_MISMATCH'
      when columns.is_nullable <> expected.is_nullable then 'NULLABILITY_MISMATCH'
      else 'OK'
    end as status
  from (values
    ('clients', 'id', 'text', 'NO'),
    ('clients', 'name', 'text', 'NO'),
    ('clients', 'created_at', 'timestamp with time zone', 'NO'),
    ('clients', 'updated_at', 'timestamp with time zone', 'NO'),
    ('orders', 'id', 'text', 'NO'),
    ('orders', 'client_id', 'text', 'NO'),
    ('orders', 'amount', 'numeric', 'NO'),
    ('orders', 'payment_status', 'text', 'NO'),
    ('orders', 'publication_date', 'date', 'NO'),
    ('orders', 'section', 'text', 'NO'),
    ('orders', 'created_at', 'timestamp with time zone', 'NO'),
    ('orders', 'updated_at', 'timestamp with time zone', 'NO'),
    ('payments', 'order_id', 'text', 'NO'),
    ('payments', 'amount', 'numeric', 'NO')
  ) as expected(table_name, column_name, data_type, is_nullable)
  left join information_schema.columns as columns
    on columns.table_schema = 'public'
   and columns.table_name = expected.table_name
   and columns.column_name = expected.column_name
),
column_state as (
  select
    count(*) filter (where status <> 'OK') as bad_columns,
    coalesce(string_agg(table_name || '.' || column_name || ' ' || status, ', ')
      filter (where status <> 'OK'), '') as bad_list,
    bool_and(status = 'OK') filter (where table_name in ('clients', 'orders')) as orders_ready,
    bool_and(status = 'OK') filter (where table_name in ('orders', 'payments')) as payments_ready
  from expected_columns
),
security_state as (
  select
    count(*) filter (where not relation.relrowsecurity) as tables_without_rls,
    count(*) filter (where has_table_privilege('anon', relation.oid, 'SELECT')) as anon_readable_tables
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as ns on ns.oid = relation.relnamespace
  where ns.nspname = 'public' and relation.relname in ('clients', 'orders', 'payments')
),
counts as (
  select
    case when env.has_allowlist then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from private.approved_users', false, true, '')))[1]::text::bigint end as approved_users,
    case when column_state.orders_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.clients', false, true, '')))[1]::text::bigint end as clients_count,
    case when column_state.orders_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.orders', false, true, '')))[1]::text::bigint end as orders_count,
    case when column_state.orders_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.orders o left join public.clients c on c.id = o.client_id where c.id is null',
      false, true, '')))[1]::text::bigint end as orphan_orders,
    case when column_state.orders_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.orders where amount is null or amount < 0 or amount > 99999999',
      false, true, '')))[1]::text::bigint end as bad_amount_orders,
    case when column_state.orders_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.orders where amount = 0', false, true, '')))[1]::text::bigint end as zero_amount_orders,
    case when column_state.orders_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.orders where payment_status is null or payment_status not in (''paid'', ''pending'')',
      false, true, '')))[1]::text::bigint end as bad_status_orders,
    case when column_state.orders_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from (
         select nullif(pg_catalog.to_jsonb(o) ->> ''order_number'', '''') as num,
                count(*) over (partition by nullif(pg_catalog.to_jsonb(o) ->> ''order_number'', '''')) as dup
         from public.orders o) x
       where num is not null and case when num !~ ''^[0-9]+$'' then true
                                      when num::numeric <= 0 then true
                                      else dup > 1 end',
      false, true, '')))[1]::text::bigint end as bad_order_numbers,
    case when column_state.payments_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.payments p left join public.orders o on o.id = p.order_id where o.id is null',
      false, true, '')))[1]::text::bigint end as orphan_payments,
    case when column_state.payments_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.payments where amount <= 0', false, true, '')))[1]::text::bigint end as non_positive_payments,
    case when column_state.payments_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(distinct o.id) as n from public.orders o join public.payments p on p.order_id = o.id where o.amount = 0',
      false, true, '')))[1]::text::bigint end as zero_orders_with_payments,
    case when column_state.payments_ready then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.orders o join (select order_id, sum(amount) s from public.payments group by order_id) p
         on p.order_id = o.id where p.s > o.amount or (o.payment_status = ''paid'' and p.s <> o.amount)',
      false, true, '')))[1]::text::bigint end as mismatched_payments
  from env, column_state
),
checks(sort_order, check_name, status, actual, requirement) as (
  select 1, 'PostgreSQL version',
    case when env.version_num >= 150000 then 'PASS' else 'FAIL' end, env.version_text, '15 or newer'
  from env
  union all select 2, 'Base tables clients/orders/payments',
    case when env.has_clients and env.has_orders and env.has_payments then 'PASS' else 'FAIL' end,
    concat_ws(' ', case when not env.has_clients then 'clients missing' end,
      case when not env.has_orders then 'orders missing' end,
      case when not env.has_payments then 'payments missing' end), 'all three exist'
  from env
  union all select 3, 'Approved-user allowlist + approval RPC',
    case when env.has_allowlist and env.has_approval_fn and env.has_approval_rpc then 'PASS' else 'FAIL' end,
    concat_ws(' ', case when not env.has_allowlist then 'allowlist missing' end,
      case when not env.has_approval_fn then 'is_approved_user missing' end,
      case when not env.has_approval_rpc then 'current_user_is_approved missing' end), 'installed'
  from env
  union all select 4, 'Approved users in allowlist',
    case when coalesce(counts.approved_users, 0) > 0 then 'PASS' else 'FAIL' end,
    coalesce(counts.approved_users::text, 'n/a'), 'at least 1'
  from counts
  union all select 5, 'Required columns/types (incl. updated_at)',
    case when column_state.bad_columns = 0 then 'PASS' else 'FAIL' end,
    nullif(column_state.bad_list, ''), 'all OK; missing updated_at -> run supabase-reliability-migration.sql first'
  from column_state
  union all select 6, 'RLS enabled on base tables',
    case when security_state.tables_without_rls = 0 then 'PASS' else 'FAIL' end,
    security_state.tables_without_rls::text || ' without RLS', '0'
  from security_state
  union all select 7, 'Anonymous role cannot read base tables',
    case when security_state.anon_readable_tables = 0 then 'PASS' else 'FAIL' end,
    security_state.anon_readable_tables::text || ' readable', '0'
  from security_state
  union all select 8, 'Supabase Realtime publication',
    case when env.has_realtime then 'PASS' else 'FAIL' end, env.has_realtime::text, 'supabase_realtime exists'
  from env
  union all select 9, 'Orders pointing to missing clients',
    case when counts.orphan_orders = 0 then 'PASS' else 'FAIL' end, coalesce(counts.orphan_orders::text, 'not checked'), '0'
  from counts
  union all select 10, 'Orders with null/negative/out-of-range amount',
    case when counts.bad_amount_orders = 0 then 'PASS' else 'FAIL' end, coalesce(counts.bad_amount_orders::text, 'not checked'), '0'
  from counts
  union all select 11, 'Orders with unknown payment_status',
    case when counts.bad_status_orders = 0 then 'PASS' else 'FAIL' end, coalesce(counts.bad_status_orders::text, 'not checked'), '0'
  from counts
  union all select 12, 'Malformed/non-positive/duplicate order numbers',
    case when counts.bad_order_numbers = 0 then 'PASS' else 'FAIL' end, coalesce(counts.bad_order_numbers::text, 'not checked'), '0'
  from counts
  union all select 13, 'Payments pointing to missing orders',
    case when counts.orphan_payments = 0 then 'PASS' else 'FAIL' end, coalesce(counts.orphan_payments::text, 'not checked'), '0'
  from counts
  union all select 14, 'Payments with amount <= 0',
    case when counts.non_positive_payments = 0 then 'PASS' else 'FAIL' end, coalesce(counts.non_positive_payments::text, 'not checked'), '0'
  from counts
  union all select 15, 'Zero-amount orders that have payments',
    case when counts.zero_orders_with_payments = 0 then 'PASS' else 'FAIL' end, coalesce(counts.zero_orders_with_payments::text, 'not checked'), '0'
  from counts
  union all select 16, 'Payments above order amount / paid with partial payments',
    case when coalesce(counts.mismatched_payments, 0) = 0 then 'PASS' else 'WARN' end, coalesce(counts.mismatched_payments::text, 'not checked'), '0 (otherwise reconcile manually)'
  from counts
  union all select 17, 'Zero-amount legacy orders',
    case when coalesce(counts.zero_amount_orders, 0) = 0 then 'PASS' else 'INFO' end, coalesce(counts.zero_amount_orders::text, 'not checked'), 'allowed; kept as non-financial orders'
  from counts
  union all select 18, 'Business schema already installed',
    case when env.business_installed then 'WARN' else 'PASS' end,
    case when env.business_installed then 'credit_ledger exists' else 'not installed' end,
    'not installed (re-running the migration is not supported)'
  from env
  union all select 19, 'Row counts (clients / orders)', 'INFO',
    coalesce(counts.clients_count::text, '?') || ' / ' || coalesce(counts.orders_count::text, '?'), 'for the backup check'
  from counts
)
select check_name, status, actual, requirement
from checks
order by case status when 'FAIL' then 0 when 'WARN' then 1 else 2 end, sort_order;
