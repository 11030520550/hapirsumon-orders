-- READ-ONLY post-migration checks for supabase-business-upgrade.sql.
-- Run only after an approved migration. Results contain aggregate counts and
-- privilege metadata, not client names or identifiers. No database changes.

select
  (select count(*) from public.clients) as clients_count,
  (select count(*) from public.orders) as orders_count,
  (select count(*) from public.financial_obligations) as obligations_count,
  (select count(*) from public.orders where billing_mode = 'legacy') as legacy_orders_count,
  (select count(*) from public.orders
    where billing_mode = 'legacy'
      and not exists (
        select 1 from public.financial_obligations as obligations
        where obligations.order_id = orders.id
      )) as legacy_orders_missing_obligation,
  (select count(*) from public.orders where order_number is null) as orders_missing_number,
  (select count(*) from (
    select order_number from public.orders
    group by order_number having count(*) > 1
  ) as duplicate_numbers) as duplicate_order_numbers,
  (select count(*) from public.orders
    where not exists (select 1 from public.clients where clients.id = orders.client_id)
  ) as orders_without_client,
  (select count(*) from public.business_order_financial_summary
    where missing_obligation) as orders_missing_financial_record,
  (select count(*) from public.business_order_financial_summary
    where payment_status_mismatch) as payment_status_mismatches;

select
  relation.relname as table_name,
  relation.relrowsecurity as rls_enabled,
  relation.relforcerowsecurity as force_rls_enabled,
  has_table_privilege('anon', relation.oid, 'SELECT') as anon_can_select,
  has_table_privilege('authenticated', relation.oid, 'SELECT') as authenticated_can_select,
  has_table_privilege('authenticated', relation.oid, 'INSERT') as direct_insert_granted,
  has_table_privilege('authenticated', relation.oid, 'UPDATE') as direct_update_granted,
  has_table_privilege('authenticated', relation.oid, 'DELETE') as direct_delete_granted
from pg_catalog.pg_class as relation
join pg_catalog.pg_namespace as ns on ns.oid = relation.relnamespace
where ns.nspname = 'public'
  and relation.relname in ('clients', 'orders', 'payments',
    'financial_obligations', 'business_payment_events', 'credit_ledger')
order by relation.relname;

select
  has_column_privilege('authenticated', 'public.orders', 'payment_status', 'UPDATE')
    as direct_payment_status_update,
  has_column_privilege('authenticated', 'public.orders', 'amount', 'UPDATE')
    as direct_order_amount_update,
  has_table_privilege('authenticated', 'public.payments', 'INSERT')
    as direct_payment_insert,
  has_table_privilege('anon', 'public.orders', 'SELECT')
    as anon_order_read;

select
  view_name,
  coalesce('security_invoker=true' = any(view_options), false) as security_invoker
from (
  select relation.relname as view_name, relation.reloptions as view_options
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as ns on ns.oid = relation.relnamespace
  where ns.nspname = 'public'
    and relation.relname in (
      'business_order_financial_summary',
      'business_financial_summary',
      'business_financial_totals',
      'business_client_credit_balances'
    )
) as reporting_views
order by view_name;

select
  has_function_privilege(
    'authenticated',
    'public.update_business_order(text,timestamptz,text,date,text,text,text,numeric,numeric,integer,uuid,date,boolean,uuid)'::regprocedure,
    'EXECUTE'
  ) as authenticated_can_edit_orders,
  has_function_privilege(
    'anon',
    'public.update_business_order(text,timestamptz,text,date,text,text,text,numeric,numeric,integer,uuid,date,boolean,uuid)'::regprocedure,
    'EXECUTE'
  ) as anon_can_edit_orders,
  has_function_privilege(
    'authenticated',
    'public.set_obligation_paid(uuid,boolean,text,timestamptz,uuid)'::regprocedure,
    'EXECUTE'
  ) as authenticated_can_set_payment_status,
  has_function_privilege(
    'anon',
    'public.set_obligation_paid(uuid,boolean,text,timestamptz,uuid)'::regprocedure,
    'EXECUTE'
  ) as anon_can_set_payment_status;

select
  count(*) filter (where item_type = 'order') as reported_orders,
  count(*) filter (where item_type = 'package_installment') as reported_installments,
  coalesce(sum(cash_due), 0) as total_cash_due,
  coalesce(sum(cash_received), 0) as total_cash_received,
  coalesce(sum(overdue_amount), 0) as total_overdue,
  coalesce(sum(future_amount), 0) as total_future,
  coalesce(sum(no_due_date_amount), 0) as total_without_due_date
from public.business_financial_summary;
