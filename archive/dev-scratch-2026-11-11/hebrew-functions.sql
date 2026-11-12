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

