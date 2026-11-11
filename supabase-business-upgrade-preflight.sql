-- READ-ONLY preflight for supabase-business-upgrade.sql.
-- Run in the Supabase SQL Editor before the migration. It returns aggregate
-- counts and schema metadata only; it does not read client names or identifiers
-- and does not change database state.
-- Stop if any required column is missing/wrongly typed, any order number is
-- duplicated/non-positive, or any payment anomaly needs reconciliation.

select current_setting('server_version') as postgresql_version,
       current_setting('server_version_num') as postgresql_version_num;

select
  pg_catalog.to_regclass('public.clients') as clients_table,
  pg_catalog.to_regclass('public.orders') as orders_table,
  pg_catalog.to_regclass('public.payments') as payments_table,
  pg_catalog.to_regclass('private.approved_users') as approved_users_table,
  pg_catalog.to_regprocedure('private.is_approved_user()') as approval_function,
  pg_catalog.to_regprocedure('public.current_user_is_approved()') as approval_rpc;

select
  relation.relname as table_name,
  relation.relrowsecurity as rls_enabled,
  relation.relforcerowsecurity as force_rls_enabled,
  has_table_privilege('anon', relation.oid, 'SELECT') as anon_can_select
from pg_catalog.pg_class as relation
join pg_catalog.pg_namespace as ns
  on ns.oid = relation.relnamespace
where ns.nspname = 'public'
  and relation.relname in ('clients', 'orders', 'payments')
order by relation.relname;

select
  columns.table_name,
  columns.column_name,
  columns.data_type,
  columns.is_nullable
from information_schema.columns as columns
where columns.table_schema = 'public'
  and columns.table_name in ('clients', 'orders', 'payments')
order by columns.table_name, columns.ordinal_position;

select
  expected.table_name,
  expected.column_name,
  expected.data_type as expected_data_type,
  columns.data_type as actual_data_type,
  expected.is_nullable as expected_is_nullable,
  columns.is_nullable as actual_is_nullable,
  case
    when columns.column_name is null then 'MISSING'
    when columns.data_type <> expected.data_type then 'TYPE_MISMATCH'
    when columns.is_nullable <> expected.is_nullable then 'NULLABILITY_MISMATCH'
    else 'OK'
  end as compatibility
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
order by expected.table_name, expected.column_name;

select
  namespace.nspname as schema_name,
  relation.relname as table_name,
  constraints.conname,
  constraints.contype as constraint_type,
  pg_catalog.pg_get_constraintdef(constraints.oid) as constraint_definition
from pg_catalog.pg_constraint as constraints
join pg_catalog.pg_class as relation
  on relation.oid = constraints.conrelid
join pg_catalog.pg_namespace as namespace
  on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname in ('clients', 'orders', 'payments')
  and constraints.contype in ('c', 'f', 'p', 'u')
order by relation.relname, constraints.conname;

select
  policies.tablename,
  policies.policyname,
  policies.permissive,
  policies.roles,
  policies.cmd,
  policies.qual,
  policies.with_check
from pg_catalog.pg_policies as policies
where policies.schemaname = 'public'
  and policies.tablename in ('clients', 'orders', 'payments')
order by policies.tablename, policies.policyname;

select
  (select count(*) from public.clients) as clients_count,
  (select count(*) from public.orders) as orders_count,
  (select count(*) from public.orders as orders
    left join public.clients as clients on clients.id = orders.client_id
    where clients.id is null) as orphan_order_rows,
  (select count(*) from public.orders where amount = 0) as zero_amount_orders,
  (select count(*) from public.orders where amount < 0) as negative_amount_orders,
  (select count(*) from public.orders where payment_status = 'paid') as marked_paid_orders,
  (select count(*) from public.orders where payment_status = 'pending') as marked_pending_orders,
  (select count(*) from public.orders
    where payment_status is null
       or payment_status not in ('paid', 'pending')) as unknown_status_orders,
  (select count(*) from public.orders
    where amount is null or amount < 0 or amount > 99999999)
    as null_or_out_of_range_amount_orders,
  (select coalesce(sum(amount), 0) from public.orders) as stored_order_amount_total;

select
  count(*) filter (where order_number is not null) as existing_numbered_orders,
  count(*) filter (where order_number is null) as orders_to_number,
  count(*) filter (where order_number is not null
                     and order_number !~ '^-?[0-9]+$')
    as malformed_order_numbers,
  count(*) filter (where order_number ~ '^-?[0-9]+$'
                     and order_number::numeric <= 0)
    as non_positive_order_numbers,
  count(*) filter (
    where order_number is not null and duplicate_number
  ) as rows_with_duplicate_order_numbers
from (
  select order_number,
         count(*) over (partition by order_number) > 1 as duplicate_number
  from (
    select nullif(pg_catalog.to_jsonb(orders) ->> 'order_number', '')
      as order_number
    from public.orders as orders
  ) as order_numbers
) as numbered;

select
  count(*) as payment_rows,
  count(distinct payments.order_id) as orders_with_payment_rows,
  count(*) filter (where orders.id is null) as orphan_payment_rows,
  coalesce(sum(payments.amount), 0) as payment_amount_total
from public.payments as payments
left join public.orders as orders on orders.id = payments.order_id;

select
  (select count(*) from public.payments where amount <= 0)
    as non_positive_payment_rows,
  count(*) filter (where orders.id is null) as orphan_payment_rows,
  count(*) filter (
    where orders.amount = 0 and payments.order_count > 0
  ) as zero_amount_orders_with_payments,
  count(*) filter (
    where orders.payment_status = 'paid'
      and payments.recorded_amount > 0
      and payments.recorded_amount <> orders.amount
  ) as paid_orders_with_partial_or_mismatched_payments,
  count(*) filter (
    where orders.payment_status = 'pending'
      and payments.recorded_amount > 0
  ) as pending_orders_with_payment_records,
  count(*) filter (
    where orders.payment_status = 'paid'
      and orders.amount > 0
      and coalesce(payments.recorded_amount, 0) = 0
  ) as paid_status_without_receipt_rows,
  count(*) filter (
    where payments.recorded_amount > orders.amount
  ) as orders_with_payments_above_amount
from public.orders as orders
full join (
  select order_id, sum(amount) as recorded_amount, count(*) as order_count
  from public.payments
  group by order_id
) as payments on payments.order_id = orders.id;

select
  relation.relname as table_name,
  has_table_privilege('authenticated', relation.oid, 'INSERT') as direct_insert,
  has_table_privilege('authenticated', relation.oid, 'UPDATE') as direct_update,
  has_table_privilege('authenticated', relation.oid, 'DELETE') as direct_delete,
  coalesce(bool_or(
    has_column_privilege('authenticated', relation.oid, attribute.attname, 'INSERT')
    or has_column_privilege('authenticated', relation.oid, attribute.attname, 'UPDATE')
  ), false) as direct_column_write
from pg_catalog.pg_class as relation
join pg_catalog.pg_namespace as namespace
  on namespace.oid = relation.relnamespace
left join pg_catalog.pg_attribute as attribute
  on attribute.attrelid = relation.oid
 and attribute.attnum > 0
 and not attribute.attisdropped
where namespace.nspname = 'public'
  and relation.relname in ('orders', 'payments')
group by relation.relname, relation.oid
order by relation.relname;

select
  publication.pubname,
  publication_tables.schemaname,
  publication_tables.tablename
from pg_catalog.pg_publication as publication
left join pg_catalog.pg_publication_tables as publication_tables
  on publication_tables.pubname = publication.pubname
 and publication_tables.schemaname = 'public'
 and publication_tables.tablename in ('clients', 'orders', 'payments')
where publication.pubname = 'supabase_realtime'
order by publication_tables.tablename;
