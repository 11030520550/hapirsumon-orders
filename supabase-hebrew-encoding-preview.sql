-- READ-ONLY diagnosis of garbled Hebrew (mojibake) in clients, orders and the product catalog.
-- Run the whole file in the Supabase SQL Editor. Nothing is written to the database:
-- the helper functions live in pg_temp and disappear when the session ends.
-- The result shows, for every damaged text value: table, row id, column, current text,
-- the proposed repair (only when the damage is mathematically reversible) and the method.
--
-- Damage types detected:
--   utf8-read-as-cp1252  : UTF-8 Hebrew decoded as Windows-1252 (looks like "×©×¨×”"). Reversible, high confidence.
--   win1255-read-as-latin: Windows-1255 Hebrew decoded as Latin-1 (looks like "ùøä"). Reversible, needs review.
--   replacement-char     : contains "�" (U+FFFD). The original letters are LOST; re-enter from a verified source.
-- Rows are listed only if they contain one of these patterns. No name is guessed.

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

with text_values as (
  select 'clients'::text as table_name, clients.id as row_id, field.key as column_name, field.value as current_text
  from public.clients as clients
  cross join lateral jsonb_each_text(to_jsonb(clients)) as field
  where field.key not in ('id', 'created_at', 'updated_at', 'joined_at')
  union all
  select 'orders', orders.id, field.key, field.value
  from public.orders as orders
  cross join lateral jsonb_each_text(to_jsonb(orders)) as field
  where field.key in ('section', 'notes', 'sheet_number', 'product_name_snapshot', 'product_dimensions_snapshot', 'entered_by_name')
  union all
  -- Product catalog (exists after supabase-business-upgrade.sql; this preview runs at install step 4b).
  select 'product_catalog', products.id::text, field.key, field.value
  from public.product_catalog as products
  cross join lateral jsonb_each_text(to_jsonb(products)) as field
  where field.key in ('name', 'dimensions')
)
select text_values.table_name, text_values.row_id, text_values.column_name,
       text_values.current_text, diagnosis.proposed as proposed_text,
       diagnosis.method, diagnosis.confidence
from text_values
cross join lateral pg_temp.diagnose_hebrew(text_values.current_text) as diagnosis
order by diagnosis.confidence, text_values.table_name, text_values.column_name, text_values.row_id;
