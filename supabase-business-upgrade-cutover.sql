-- PHASE 2: revoke direct business-table writes after the RPC-based UI is
-- deployed and tested. Run only during a short write-freeze.
-- This file is transactional. It does not modify customer/order data.

begin;

do $cutover_preflight$
begin
  if pg_catalog.to_regprocedure(
       'public.create_orders_batch(text,jsonb,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.update_business_order(text,timestamptz,text,date,text,text,text,numeric,numeric,numeric,uuid,date,boolean,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.delete_business_order(text,timestamptz,text,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.set_obligation_paid(uuid,boolean,text,timestamptz,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.purchase_customer_package(text,uuid,text,numeric,integer,numeric,date,date,jsonb,jsonb,text,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.adjust_client_credits(text,numeric,text,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.convert_credit_orders_to_cash(jsonb,text,uuid)'
     ) is null then
    raise exception 'Required business RPCs are missing. Do not cut over writes.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'orders'
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ) or not exists (
    select 1 from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'payments'
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ) then
    raise exception 'RLS and FORCE RLS are required before the write cutover.';
  end if;
end;
$cutover_preflight$;

revoke all on table public.orders, public.payments
  from public, anon, authenticated;
grant select on table public.orders, public.payments to authenticated;

-- Table-level REVOKE does not clear separately granted column privileges.
do $column_privileges$
declare
  v_table text;
  v_column text;
begin
  foreach v_table in array array['orders', 'payments']
  loop
    for v_column in
      select attribute.attname
      from pg_catalog.pg_attribute as attribute
      where attribute.attrelid =
        pg_catalog.to_regclass('public.' || v_table)
        and attribute.attnum > 0
        and not attribute.attisdropped
    loop
      execute pg_catalog.format(
        'revoke insert (%I) on table public.%I from public, anon, authenticated',
        v_column, v_table
      );
      execute pg_catalog.format(
        'revoke update (%I) on table public.%I from public, anon, authenticated',
        v_column, v_table
      );
      execute pg_catalog.format(
        'revoke references (%I) on table public.%I from public, anon, authenticated',
        v_column, v_table
      );
    end loop;
  end loop;
end;
$column_privileges$;

do $verify_cutover$
begin
  if has_table_privilege('anon', 'public.orders', 'SELECT')
     or has_table_privilege('anon', 'public.payments', 'SELECT')
     or has_table_privilege('authenticated', 'public.orders', 'INSERT')
     or has_table_privilege('authenticated', 'public.orders', 'UPDATE')
     or has_table_privilege('authenticated', 'public.orders', 'DELETE')
     or has_table_privilege('authenticated', 'public.orders', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.payments', 'INSERT')
     or has_table_privilege('authenticated', 'public.payments', 'UPDATE')
     or has_table_privilege('authenticated', 'public.payments', 'DELETE')
     or has_table_privilege('authenticated', 'public.payments', 'TRUNCATE')
     or exists (
       select 1
       from pg_catalog.pg_attribute as attribute
       where attribute.attrelid in (
         'public.orders'::regclass, 'public.payments'::regclass
       )
         and attribute.attnum > 0
         and not attribute.attisdropped
         and (
           has_column_privilege(
             'authenticated', attribute.attrelid, attribute.attname, 'INSERT'
           )
           or has_column_privilege(
             'authenticated', attribute.attrelid, attribute.attname, 'UPDATE'
           )
         )
     ) then
    raise exception 'Direct table or column write privileges remain after cutover.';
  end if;
end;
$verify_cutover$;

commit;
