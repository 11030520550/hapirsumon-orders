-- Backup snapshot inside the database, BEFORE supabase-business-upgrade.sql.
-- Requires explicit approval: it creates a new schema with copies of the current rows.
-- It does not change or delete any existing row. The schema is not exposed to the
-- website (anon/authenticated have no access), so the copies are not readable from the API.
-- Stops with an error if a backup with the same name already exists (no overwrite).

begin;

create schema backup_before_business_upgrade;
revoke all on schema backup_before_business_upgrade from public, anon, authenticated;

create table backup_before_business_upgrade.clients as table public.clients;
create table backup_before_business_upgrade.orders as table public.orders;
create table backup_before_business_upgrade.payments as table public.payments;
create table backup_before_business_upgrade.approved_users as table private.approved_users;

revoke all on all tables in schema backup_before_business_upgrade from public, anon, authenticated;

commit;

-- Verification: copied row counts must equal the live counts.
select 'clients' as table_name,
       (select count(*) from public.clients) as live_rows,
       (select count(*) from backup_before_business_upgrade.clients) as backup_rows
union all
select 'orders', (select count(*) from public.orders),
       (select count(*) from backup_before_business_upgrade.orders)
union all
select 'payments', (select count(*) from public.payments),
       (select count(*) from backup_before_business_upgrade.payments)
union all
select 'approved_users', (select count(*) from private.approved_users),
       (select count(*) from backup_before_business_upgrade.approved_users);
