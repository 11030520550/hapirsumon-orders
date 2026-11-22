-- =====================================================================================================
-- supabase-readonly-audit.sql — read-only data checks before installing supabase-orders-v3.sql / sheets v2.
--
-- READ ONLY. Every part runs inside "set transaction read only" and ends with rollback, so even a pasted
-- write statement would be refused by the database. No customer names, phones or e-mails are returned.
--
-- How to run (Supabase → SQL Editor):
--   1. Paste PART A alone and press Run. It returns one table: check | value. Copy it as text.
--   2. Run each query of PART B separately (select the block, Run). Copy the results.
--   3. Send the results. Hide the names in B7 (staff names) if you prefer.
-- Written for the schema of supabase-business-upgrade.sql (+ supabase-sheets-and-order-numbers.sql).
-- Objects that may be missing (sheets, sheet_overview, the renumber backup) are checked with to_regclass first.
-- =====================================================================================================

-- ===================== PART A — summary (one result table) =====================
begin;
set transaction read only;

with
installed as (
  select to_regclass('public.sheets') is not null as sheets_v1,
         to_regclass('public.sheet_overview') is not null as sheets_v2,
         to_regclass('backup_order_numbers.renumbered') is not null as renumber_ran,
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'orders' and column_name = 'ad_description') as orders_v3
),
damaged as (
  -- Same rule as hasEncodingDamage() in app.js: UTF-8 read as Windows-1255/Latin-1, or the replacement char.
  select count(*) filter (where section ~ '×[\u0080-¿]' or section like '%�%') as section_bad,
         count(*) filter (where product_name_snapshot ~ '×[\u0080-¿]' or product_name_snapshot like '%�%') as product_bad,
         count(*) filter (where notes ~ '×[\u0080-¿]' or notes like '%�%') as notes_bad
  from public.orders
),
o as (
  select count(*) as total,
         count(*) filter (where billing_mode = 'legacy') as legacy,
         count(*) filter (where billing_mode = 'cash') as cash,
         count(*) filter (where billing_mode = 'credits') as credits,
         count(*) filter (where order_number < 22000) as short_numbers,
         min(order_number) as min_number, max(order_number) as max_number,
         count(*) filter (where order_number >= 22000) as numbered_22000,
         count(*) filter (where sheet_number is null) as without_sheet,
         count(distinct sheet_number) as distinct_sheets,
         count(*) filter (where product_id is null and billing_mode <> 'legacy') as business_without_product,
         count(*) filter (where billing_mode = 'legacy'
                            and created_at > (select min(created_at) from public.orders where billing_mode <> 'legacy')) as legacy_after_upgrade
  from public.orders
),
t as (select * from public.business_financial_totals),
f as (
  select count(*) filter (where order_id is not null) as order_obligations,
         count(*) filter (where package_installment_id is not null) as installment_obligations,
         count(*) filter (where due_on is null and status = 'pending') as open_without_due_date
  from public.financial_obligations
),
partial as (
  select count(*) as inconsistent_receipts
  from (
    select f.id, f.status, f.amount_due, f.legacy_snapshot, coalesce(sum(e.amount), 0) as received
    from public.financial_obligations f
    left join public.business_payment_events e on e.obligation_id = f.id
    group by f.id
  ) x
  where (x.status = 'paid' and not x.legacy_snapshot and x.received <> x.amount_due)
     or (x.status = 'pending' and x.received <> 0)
),
credits as (
  select (select count(*) from public.business_client_credit_balances where credit_balance < 0) as negative_clients,
         (select count(*) from public.business_client_credit_balances where credit_balance > 0) as positive_clients,
         (select coalesce(sum(credit_balance), 0) from public.business_client_credit_balances) as total_balance,
         (select count(*) from public.orders o2 where o2.billing_mode = 'credits'
            and coalesce((select sum(l.delta) from public.credit_ledger l
                          where l.order_id = o2.id and l.entry_type = 'order_consumption'), 0) <> -o2.credits_used) as credit_orders_ledger_mismatch
),
packages as (
  select (select count(*) from public.customer_packages) as purchases,
         (select count(*) from (
            select p.id from public.customer_packages p
            left join public.package_installments i on i.customer_package_id = p.id
            group by p.id
            having count(i.id) <> p.installment_count
                or coalesce(sum(i.amount_before_vat), 0) <> p.price_before_vat) z) as schedule_mismatch,
         (select count(*) from public.customer_packages p
            where not exists (select 1 from public.credit_ledger l
                              where l.customer_package_id = p.id and l.entry_type = 'package_grant')) as without_grant
),
products as (
  select count(*) as total, count(*) filter (where is_active) as active,
         count(*) filter (where name like '%הדגמה%') as demo,
         count(*) filter (where name ~ '×[\u0080-¿]' or name like '%�%') as damaged
  from public.product_catalog
)
select 'install: sheets v1 table' as check_name, installed.sheets_v1::text as value from installed
union all select 'install: sheets v2 view', installed.sheets_v2::text from installed
union all select 'install: renumber script ran', installed.renumber_ran::text from installed
union all select 'install: orders v3 columns', installed.orders_v3::text from installed
union all select 'counter: last order number', (select last_number::text from private.order_number_counters where counter_name = 'orders')
union all select 'privileges: authenticated can INSERT orders directly', has_table_privilege('authenticated', 'public.orders', 'INSERT')::text
union all select 'privileges: authenticated can UPDATE orders directly', has_table_privilege('authenticated', 'public.orders', 'UPDATE')::text
union all select 'privileges: authenticated can DELETE orders directly', has_table_privilege('authenticated', 'public.orders', 'DELETE')::text
union all select 'privileges: authenticated can INSERT payments directly', has_table_privilege('authenticated', 'public.payments', 'INSERT')::text
union all select 'settings: VAT rate', (select vat_rate::text from public.business_settings)
union all select 'orders: total', o.total::text from o
union all select 'orders: legacy / cash / credits', o.legacy || ' / ' || o.cash || ' / ' || o.credits from o
union all select 'orders: number range', coalesce(o.min_number::text, '-') || ' – ' || coalesce(o.max_number::text, '-') from o
union all select 'orders: numbers below 22000', o.short_numbers::text from o
union all select 'orders: numbered 22000+', o.numbered_22000::text from o
union all select 'orders: without sheet number', o.without_sheet::text from o
union all select 'orders: distinct sheet numbers', o.distinct_sheets::text from o
union all select 'orders: business orders without product', o.business_without_product::text from o
union all select 'orders: legacy rows created after the business upgrade (JSON import / direct write)', o.legacy_after_upgrade::text from o
union all select 'text: damaged section / product / notes', damaged.section_bad || ' / ' || damaged.product_bad || ' / ' || damaged.notes_bad from damaged
union all select 'text: damaged client names', (select count(*)::text from public.clients where name ~ '×[\u0080-¿]' or name like '%�%')
union all select 'products: total / active / demo / damaged', products.total || ' / ' || products.active || ' / ' || products.demo || ' / ' || products.damaged from products
union all select 'money: billed / received / outstanding', t.total_cash_billed || ' / ' || t.total_cash_received || ' / ' || t.total_cash_outstanding from t
union all select 'money: overdue / without due date', t.total_overdue || ' / ' || t.total_without_due_date from t
union all select 'money: orders missing a charge', t.orders_missing_obligation::text from t
union all select 'money: payment status mismatches', t.payment_status_mismatches::text from t
union all select 'money: charges order / installment', f.order_obligations || ' / ' || f.installment_obligations from f
union all select 'money: open charges without due date', f.open_without_due_date::text from f
union all select 'money: charges whose receipts do not match their status', partial.inconsistent_receipts::text from partial
union all select 'money: rows in the original payments table', (select count(*)::text from public.payments)
union all select 'credits: clients negative / positive', credits.negative_clients || ' / ' || credits.positive_clients from credits
union all select 'credits: total balance of all clients', credits.total_balance::text from credits
union all select 'credits: credit orders whose ledger does not match', credits.credit_orders_ledger_mismatch::text from credits
union all select 'credits: credit-to-cash conversions', (select count(*)::text from public.credit_cash_conversions)
union all select 'packages: purchases', packages.purchases::text from packages
union all select 'packages: schedule does not match price or count', packages.schedule_mismatch::text from packages
union all select 'packages: purchases without credit grant', packages.without_grant::text from packages;

rollback;

-- ===================== PART B — details (run each block separately) =====================

-- B1. Orders with a short number (below 22000): what they are. No client names.
begin; set transaction read only;
select order_number, billing_mode, entered_at, sheet_number, amount, payment_status
from public.orders where order_number < 22000 order by order_number;
rollback;

-- B2. Order 8 in full: the order, its charge and its credit movements.
begin; set transaction read only;
select id, order_number, billing_mode, entered_at, publication_date, sheet_number, section, product_name_snapshot,
       amount, cash_amount_before_vat, credits_used, vat_rate_snapshot, payment_status
from public.orders where order_number = 8;
select f.amount_due, f.due_on, f.status, f.legacy_snapshot, f.paid_at
from public.financial_obligations f join public.orders o on o.id = f.order_id where o.order_number = 8;
select l.delta, l.entry_type, l.reason, l.created_at
from public.credit_ledger l join public.orders o on o.id = l.order_id where o.order_number = 8;
rollback;

-- B3. Sheet numbers that appear in orders (why the sheets screen shows only some sheets).
begin; set transaction read only;
select coalesce(sheet_number, '(ללא)') as sheet, count(*) as orders, min(entered_at), max(entered_at)
from public.orders group by 1 order by 1;
rollback;

-- B4. Rows of the sheets table (model v1).
begin; set transaction read only;
select sheet_number, status, closed_at, updated_at from public.sheets order by sheet_number;
rollback;

-- B5. The product catalog as it is in production.
begin; set transaction read only;
select name, dimensions, base_price_before_vat, credit_cost, is_active, name like '%הדגמה%' as demo
from public.product_catalog order by created_at;
rollback;

-- B6. Money rows the database itself marks as inconsistent.
begin; set transaction read only;
select item_type, order_number, billing_mode, cash_due, cash_received, payment_status,
       legacy_snapshot, missing_obligation, payment_status_mismatch
from public.business_financial_summary where missing_obligation or payment_status_mismatch;
rollback;

-- B7. Who entered orders (staff, not clients) and the VAT rates saved in orders.
begin; set transaction read only;
select coalesce(nullif(entered_by_name, ''), '(ריק)') as entered_by, count(*) from public.orders group by 1 order by 2 desc;
select vat_rate_snapshot, billing_mode, count(*) from public.orders group by 1, 2 order by 1, 2;
rollback;

-- B8. Gaps in the 22000+ numbering (only the count and the range; the order numbers themselves in B9).
begin; set transaction read only;
select count(*) as numbered, min(order_number), max(order_number),
       max(order_number) - min(order_number) + 1 - count(*) as missing_numbers
from public.orders where order_number >= 22000;
rollback;

-- B9. On the cut-over day only: every order number already in the database, to compare with Google Sheets.
begin; set transaction read only;
select order_number from public.orders order by order_number;
rollback;
