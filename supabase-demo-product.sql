-- DEMO ONLY: one sample product so orders can be created in the demo project.
-- Run only AFTER supabase-business-upgrade.sql, and only in a project that holds demo data.
-- The price and credit cost are illustrative values, NOT the newspaper's price list.
-- Safe to run twice: it does not create a second copy.

insert into public.product_catalog (name, dimensions, base_price_before_vat, credit_cost, is_active)
select 'מוצר הדגמה — לא מחירון', 'הדגמה', 500.00, 2.50, true
where not exists (
  select 1 from public.product_catalog where name = 'מוצר הדגמה — לא מחירון'
);

select id, name, base_price_before_vat, credit_cost, is_active
from public.product_catalog
order by created_at;
