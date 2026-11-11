-- READ-ONLY preflight for supabase-business-upgrade.sql.
-- Run in the Supabase SQL Editor before the migration. It returns aggregate
-- counts and schema metadata only; it does not read client names or identifiers
-- and does not change database state.

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
  (select count(*) from public.orders where payment_status = 'paid') as marked_paid_orders,
  (select count(*) from public.orders where payment_status = 'pending') as marked_pending_orders,
  (select count(*) from public.orders
    where payment_status not in ('paid', 'pending')) as unknown_status_orders,
  (select coalesce(sum(amount), 0) from public.orders) as stored_order_amount_total;

select
  count(*) as payment_rows,
  count(distinct payments.order_id) as orders_with_payment_rows,
  count(*) filter (where orders.id is null) as orphan_payment_rows,
  coalesce(sum(payments.amount), 0) as payment_amount_total
from public.payments as payments
left join public.orders as orders on orders.id = payments.order_id;

select
  count(*) filter (
    where orders.payment_status = 'paid'
      and coalesce(payments.recorded_amount, 0) > 0
      and coalesce(payments.recorded_amount, 0) <> orders.amount
  ) as paid_with_partial_payment_records,
  count(*) filter (
    where orders.payment_status = 'paid'
      and coalesce(payments.recorded_amount, 0) = 0
  ) as paid_status_without_receipt_rows,
  count(*) filter (
    where orders.payment_status = 'pending'
      and coalesce(payments.recorded_amount, 0) > 0
  ) as pending_with_recorded_payments,
  count(*) filter (
    where coalesce(payments.recorded_amount, 0) > orders.amount
  ) as orders_with_payments_above_order_amount
from public.orders as orders
left join (
  select order_id, sum(amount) as recorded_amount
  from public.payments
  group by order_id
) as payments on payments.order_id = orders.id;

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
