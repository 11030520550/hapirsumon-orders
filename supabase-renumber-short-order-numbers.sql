-- OPTIONAL — REQUIRES EXPLICIT APPROVAL. Run only if existing order numbers are shorter than 5 digits
-- (the business migration numbered existing orders 1, 2, 3 ...) and you want them in the 22000+ range.
-- Run AFTER supabase-sheets-and-order-numbers.sql.
-- Changes only orders.order_number (the business-facing number). Technical IDs (orders.id) and all
-- relations are unchanged. Order is preserved (oldest first). The old numbers are kept in a backup table.
-- Note: earlier credit-ledger reasons mention the old number as plain text; they are history and stay as is.

begin;

create schema if not exists backup_order_numbers;
revoke all on schema backup_order_numbers from public, anon, authenticated;

create table backup_order_numbers.renumbered as
select orders.id as order_id, orders.order_number as old_number,
       (select greatest(coalesce(max(order_number) filter (where order_number >= 22000), 21999),
                        (select last_number from private.order_number_counters where counter_name = 'orders'))
        from public.orders)
       + row_number() over (order by orders.order_number, orders.id) as new_number
from public.orders as orders
where orders.order_number < 10000;

revoke all on all tables in schema backup_order_numbers from public, anon, authenticated;

update public.orders as orders
set order_number = renumbered.new_number
from backup_order_numbers.renumbered as renumbered
where orders.id = renumbered.order_id;

update private.order_number_counters
set last_number = greatest(last_number, (select max(order_number) from public.orders))
where counter_name = 'orders';

commit;

select order_id, old_number, new_number from backup_order_numbers.renumbered order by new_number;
