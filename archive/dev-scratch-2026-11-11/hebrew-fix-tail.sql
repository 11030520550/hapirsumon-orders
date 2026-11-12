begin;

create schema if not exists backup_hebrew_fix;
revoke all on schema backup_hebrew_fix from public, anon, authenticated;

create table backup_hebrew_fix.changes as
with text_values as (
  select 'clients'::text as table_name, clients.id as row_id, field.key as column_name, field.value as old_text
  from public.clients as clients
  cross join lateral jsonb_each_text(to_jsonb(clients)) as field
  where field.key in ('name', 'phone', 'email', 'internal_notes')
  union all
  select 'orders', orders.id, field.key, field.value
  from public.orders as orders
  cross join lateral jsonb_each_text(to_jsonb(orders)) as field
  where field.key in ('section', 'notes', 'sheet_number', 'product_name_snapshot', 'product_dimensions_snapshot')
)
select text_values.table_name, text_values.row_id, text_values.column_name,
       text_values.old_text, diagnosis.proposed as new_text, diagnosis.method,
       pg_catalog.now() as fixed_at
from text_values
cross join lateral pg_temp.diagnose_hebrew(text_values.old_text) as diagnosis
where diagnosis.confidence = 'high' and diagnosis.proposed is not null;

revoke all on all tables in schema backup_hebrew_fix from public, anon, authenticated;

do $apply$
declare
  v_change record;
begin
  for v_change in select * from backup_hebrew_fix.changes loop
    execute pg_catalog.format('update public.%I set %I = $1 where id = $2 and %I = $3',
      v_change.table_name, v_change.column_name, v_change.column_name)
    using v_change.new_text, v_change.row_id, v_change.old_text;
  end loop;
end
$apply$;

alter table public.clients drop constraint if exists clients_no_replacement_char_check;
alter table public.clients add constraint clients_no_replacement_char_check
  check (position(chr(65533) in name || coalesce(phone, '') || coalesce(email, '')) = 0) not valid;

commit;

-- Before / after
select table_name, row_id, column_name, old_text as before_text, new_text as after_text, method
from backup_hebrew_fix.changes
order by table_name, column_name, row_id;

-- Restore (only if needed, run separately):
-- update public.clients c set name = b.old_text from backup_hebrew_fix.changes b
--   where b.table_name = 'clients' and b.column_name = 'name' and c.id = b.row_id;
-- (repeat per column: phone, email, internal_notes; and for public.orders columns)
