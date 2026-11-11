-- READ-ONLY checks after supabase-business-upgrade.sql and the approved
-- supabase-business-upgrade-cutover.sql have both been applied.
-- Run only after an approved migration. Results contain aggregate counts and
-- privilege metadata, not client names or identifiers. No database changes.

select
  (select count(*) from public.clients) as clients_count,
  (select count(*) from public.orders) as orders_count,
  (select count(*) from public.financial_obligations) as obligations_count,
  (select count(*) from public.orders where billing_mode = 'legacy') as legacy_orders_count,
  (select count(*) from public.orders
    where billing_mode = 'legacy' and amount = 0) as legacy_zero_amount_orders,
  (select count(*) from public.orders
    where billing_mode = 'legacy' and amount = 0
      and exists (
        select 1 from public.financial_obligations as obligations
        where obligations.order_id = orders.id
      )) as zero_amount_legacy_orders_with_obligations,
  (select count(*) from public.orders
    where billing_mode = 'legacy'
      and amount > 0
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
    where payment_status_mismatch) as payment_status_mismatches,
  (select count(*) from public.business_order_financial_summary
    where billing_mode = 'legacy' and cash_due = 0 and cash_received <> 0)
    as zero_amount_legacy_cash_mismatches;

select
  (select count(*) from public.credit_ledger
    where delta <> trunc(delta)) as fractional_credit_ledger_rows,
  (select count(*) from public.business_client_credit_balances
    where credit_balance < 0) as clients_with_negative_credit_balance,
  (select count(*) from public.product_catalog
    where credit_cost <> trunc(credit_cost)) as fractional_product_credit_costs,
  (select count(*) from public.package_catalog
    where credits <> trunc(credits)) as fractional_package_credit_amounts;

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
    'public.update_business_order(text,timestamptz,text,date,text,text,text,numeric,numeric,numeric,uuid,date,boolean,uuid)'::regprocedure,
    'EXECUTE'
  ) as authenticated_can_edit_orders,
  has_function_privilege(
    'anon',
    'public.update_business_order(text,timestamptz,text,date,text,text,text,numeric,numeric,numeric,uuid,date,boolean,uuid)'::regprocedure,
    'EXECUTE'
  ) as anon_can_edit_orders,
  has_function_privilege(
    'authenticated',
    'public.adjust_client_credits(text,numeric,text,uuid)'::regprocedure,
    'EXECUTE'
  ) as authenticated_can_adjust_credits,
  has_function_privilege(
    'anon',
    'public.adjust_client_credits(text,numeric,text,uuid)'::regprocedure,
    'EXECUTE'
  ) as anon_can_adjust_credits,
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

select
  count(*) filter (where obligations.status = 'paid') as paid_installments,
  count(*) filter (where obligations.status = 'pending') as pending_installments,
  coalesce(sum(case when obligations.status = 'paid'
                    then obligations.amount_due else 0 end), 0) as paid_installment_amount,
  coalesce(sum(case when obligations.status = 'pending'
                    and obligations.due_on > current_date
                    then obligations.amount_due else 0 end), 0) as future_installment_amount,
  coalesce(sum(case when obligations.status = 'pending'
                    and obligations.due_on < current_date
                    then obligations.amount_due else 0 end), 0) as overdue_installment_amount
from public.package_installments as installments
join public.financial_obligations as obligations
  on obligations.package_installment_id = installments.id;
