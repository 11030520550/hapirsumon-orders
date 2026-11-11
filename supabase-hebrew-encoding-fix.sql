-- FIX garbled Hebrew — REQUIRES EXPLICIT APPROVAL. Changes data.
-- Run supabase-hebrew-encoding-preview.sql first and review its result.
-- What this file does, in one transaction:
--   1. Copies every row it will change into backup_hebrew_fix.changes (old value, new value, method).
--   2. Updates ONLY values whose damage is reversible with high confidence (utf8-read-as-cp1252).
--      "review" and "manual" rows are NOT changed: verify them against the original source and fix by hand.
--   3. Shows a before/after table of the changes.
--   4. Blocks new client names/contacts containing "�" (U+FFFD) with a NOT VALID check constraint
--      (existing rows are not re-checked, so nothing fails on rows that still need manual repair).
-- Undo: the backup table holds every previous value (see the restore query at the end).

create or replace function pg_temp.cp1252_byte(p_char text)
returns integer language sql immutable as $$
  select case
    when ascii(p_char) < 256 then ascii(p_char)
    else (select mapped.byte_value from (values
      (8364,128),(8218,130),(402,131),(8222,132),(8230,133),(8224,134),(8225,135),(710,136),
      (8240,137),(352,138),(8249,139),(338,140),(381,142),(8216,145),(8217,146),(8220,147),
      (8221,148),(8226,149),(8211,150),(8212,151),(732,152),(8482,153),(353,154),(8250,155),
      (339,156),(382,158),(376,159)
    ) as mapped(code_point, byte_value) where mapped.code_point = ascii(p_char))
  end
$$;

create or replace function pg_temp.as_single_bytes(p_text text)
returns bytea language plpgsql immutable as $$
declare
  v_result bytea := ''::bytea;
  v_char text;
  v_byte integer;
begin
  foreach v_char in array regexp_split_to_array(p_text, '') loop
    v_byte := pg_temp.cp1252_byte(v_char);
    if v_byte is null then
      return null;
    end if;
    v_result := v_result || set_byte('\x00'::bytea, 0, v_byte);
  end loop;
  return v_result;
end
$$;

create or replace function pg_temp.try_decode(p_bytes bytea, p_encoding text)
returns text language plpgsql as $$
begin
  return convert_from(p_bytes, p_encoding);
exception when others then
  return null;
end
$$;

create or replace function pg_temp.diagnose_hebrew(p_text text)
returns table(proposed text, method text, confidence text) language plpgsql as $$
declare
  v_bytes bytea;
  v_candidate text;
begin
  if p_text is null or p_text = '' then
    return;
  end if;
  if position(chr(65533) in p_text) > 0 then
    proposed := null; method := 'replacement-char'; confidence := 'manual'; return next; return;
  end if;
  v_bytes := pg_temp.as_single_bytes(p_text);
  if v_bytes is null then
    return; -- contains real Hebrew or other characters outside one byte: not this kind of damage
  end if;
  v_candidate := pg_temp.try_decode(v_bytes, 'UTF8');
  if v_candidate is not null and v_candidate <> p_text and v_candidate ~ '[א-ת]' then
    proposed := v_candidate; method := 'utf8-read-as-cp1252'; confidence := 'high'; return next; return;
  end if;
  -- Windows-1255 read as Latin-1: only when the text has no plain Latin letters (avoids names like "Renée").
  if p_text !~ '[A-Za-z]' and length(regexp_replace(p_text, '[^à-ú]', '', 'g')) >= 2 then
    v_candidate := pg_temp.try_decode(v_bytes, 'WIN1255');
    if v_candidate is not null and v_candidate <> p_text and v_candidate ~ '[א-ת]' then
      proposed := v_candidate; method := 'win1255-read-as-latin'; confidence := 'review'; return next; return;
    end if;
  end if;
end
$$;

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
