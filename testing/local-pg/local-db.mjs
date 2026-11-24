// LOCAL TEST / DEMO DATABASE ONLY. Shared by the browser (pg-supabase.js) and Node (seed-check.mjs).
// Builds a real PostgreSQL (PGlite) from the project's SQL files in the planned production order and fills it
// with fictional data through the same business functions the screens use. Never connects to Supabase.

export const INSTALL_FILES = [
  "supabase-schema.sql",
  "supabase-reliability-migration.sql",
  "supabase-business-upgrade.sql",
  "supabase-sheets-and-order-numbers.sql",
  "supabase-orders-v3.sql",
  "supabase-sheets-v2.sql",
  "supabase-sheets-v2-enforce.sql",
  "supabase-business-upgrade-cutover.sql"
];
export const VERIFY_FILES = ["supabase-orders-v3-verify.sql", "supabase-sheets-v2-verify.sql"];

// Local accounts (they exist nowhere else).
export const ACCOUNTS = {
  "staff@local.test": { id: "00000000-0000-4000-8000-00000000a001", password: "test1234", name: "צוות מזכירות", approved: true },
  "second@local.test": { id: "00000000-0000-4000-8000-00000000a002", password: "test1234", name: "צוות מכירות", approved: true },
  "pending@local.test": { id: "00000000-0000-4000-8000-00000000b001", password: "test1234", name: "ממתין לאישור", approved: false }
};
// Simulates the cut-over day: the counter starts above the last Google Sheets number (22354 on 22/11/2026).
export const LOCAL_COUNTER = 22354;

const STAND_INS = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
  create publication supabase_realtime;`;

const identifier = /^[a-z_][a-z0-9_]*$/;
export const ident = (name) => {
  if (!identifier.test(String(name))) throw Object.assign(new Error(`invalid identifier ${name}`), { code: "PGRST100" });
  return `"${name}"`;
};
export const jsonValue = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

// One request = one transaction as the signed-in user (role authenticated + JWT claims), like PostgREST.
export async function asUser(pg, user, fn) {
  return pg.transaction(async (tx) => {
    if (user && user.id) {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true), set_config('role', 'authenticated', true)",
        [user.id, JSON.stringify({ sub: user.id, role: "authenticated", email: user.email, user_metadata: { full_name: user.name } })]);
    } else {
      await tx.query("select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{\"role\":\"anon\"}', true), set_config('role', 'anon', true)");
    }
    return fn(tx);
  });
}

// rpc(name, args): named arguments cast to the function's own parameter types; result shaped like PostgREST.
export async function rpcSql(tx, name, args = {}) {
  if (!identifier.test(name)) throw { __postgrest: { code: "PGRST202", message: `Could not find the function public.${name}`, details: null, hint: null } };
  const keys = Object.keys(args || {});
  const procs = (await tx.query(`
    select p.proretset as retset, p.prorettype = 'pg_catalog.void'::regtype as is_void, p.provolatile as volatile,
           coalesce(p.proargnames, '{}') as names,
           array(select pg_catalog.format_type(t, null) from unnest(p.proargtypes) as t) as types, p.pronargs as nargs, p.pronargdefaults as ndefaults
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1`, [name])).rows;
  const proc = procs.find((p) => keys.every((k) => p.names.includes(k)) && keys.length >= p.nargs - p.ndefaults && keys.length <= p.nargs);
  if (!proc) throw { __postgrest: { code: "PGRST202", message: `Could not find the function public.${name}(${keys.join(", ")}) in the schema cache`, details: null, hint: null } };
  const values = [];
  const list = keys.map((k) => {
    const type = proc.types[proc.names.indexOf(k)];
    let v = args[k];
    if (Array.isArray(v) && type.endsWith("[]")) v = `{${v.map((x) => (x === null ? "NULL" : `"${String(x).replace(/["\\]/g, "\\$&")}"`)).join(",")}}`;
    values.push(jsonValue(v));
    return `${ident(k)} => $${values.length}::${type}`;
  }).join(", ");
  const call = `public.${ident(name)}(${list})`;
  let data;
  if (proc.is_void) { await tx.query(`select ${call}`, values); data = null; }
  else if (proc.retset) data = (await tx.query(`select coalesce(json_agg(_f), '[]'::json) as j from ${call} as _f`, values)).rows[0].j;
  else data = (await tx.query(`select to_json(${call}) as j`, values)).rows[0].j;
  return { data, error: null, volatile: proc.volatile === "v" };
}

export const accountUser = (email) => ({ id: ACCOUNTS[email].id, email, name: ACCOUNTS[email].name });

// A business call as a staff account; throws the database's own message on failure.
export function caller(pg, email = "staff@local.test") {
  const user = accountUser(email);
  return async (name, args) => {
    try { return (await asUser(pg, user, (tx) => rpcSql(tx, name, args))).data; }
    catch (error) { throw new Error(`${name}: ${(error && error.__postgrest && error.__postgrest.message) || (error && error.message) || error}`); }
  };
}

// Installs everything and fills the chosen data set. readText(name) returns a project file's text.
export async function buildDatabase(pg, { readText, onPhase = () => {}, seed = "demo", clock = null }) {
  await pg.exec(STAND_INS);
  for (const [email, account] of Object.entries(ACCOUNTS)) {
    await pg.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [account.id, email, JSON.stringify({ full_name: account.name })]);
  }
  for (let i = 0; i < INSTALL_FILES.length; i += 1) {
    const name = INSTALL_FILES[i];
    onPhase(`מתקינים ${name} (${i + 1}/${INSTALL_FILES.length})…`);
    let sql = await readText(name);
    // Sheets v2 on an empty database: no sheet exists yet, so the keep-open list is empty (the file says how).
    if (name === "supabase-sheets-v2.sql") sql = sql.replace(/insert into sheets_v2_keep_open \(sheet_number\) values \('__REPLACE_WITH_THE_ACTIVE_SHEET__'\);/, "");
    try { await pg.exec(sql); }
    catch (error) { try { await pg.exec("rollback"); } catch { } throw new Error(`${name}: ${error.message}`); }
    if (name === "supabase-schema.sql") {
      for (const account of Object.values(ACCOUNTS)) if (account.approved) await pg.query("insert into private.approved_users (user_id) values ($1)", [account.id]);
    }
  }
  onPhase("בדיקות verify…");
  const failed = [];
  for (const name of VERIFY_FILES) {
    const rows = (await pg.exec(await readText(name))).flatMap((r) => r.rows || []);
    for (const row of rows) if (Object.values(row).some((v) => String(v).startsWith("FAIL"))) failed.push(`${name}: ${JSON.stringify(row)}`);
  }
  if (failed.length) throw new Error(`verify FAIL: ${failed.join("; ")}`);
  await pg.query("update private.order_number_counters set last_number = $1 where counter_name = 'orders'", [LOCAL_COUNTER]);
  if (seed === "demo") {
    onPhase("יוצרים נתוני הדגמה (כ-16 שבועות של פעילות)…");
    const { seedDemo } = await import("./demo-seed.mjs");
    await seedDemo(pg, { clock, onPhase });
  } else {
    onPhase("מזינים נתוני בדיקה…");
    await seedBasic(pg);
  }
}

const isoDay = (d) => d.toISOString().slice(0, 10);

// The small, fixed data set the end-to-end tests rely on.
export async function seedBasic(pg) {
  const call = caller(pg);
  await asUser(pg, accountUser("staff@local.test"), async (tx) => tx.exec(`
    insert into public.clients (id, name, phone, email) values
      ('c-local-1', 'מאפיית השכונה (בדיקה)', '050-0000001', null),
      ('c-local-2', 'סטודיו לעיצוב (בדיקה)', '050-0000002', null),
      ('c-local-3', 'חנות פרחים (בדיקה)', null, null),
      ('c-local-4', 'משרד עורכי דין (בדיקה)', null, null),
      ('c-local-5', 'מוסך אחים (בדיקה)', null, null);`));
  await pg.exec(`insert into public.product_catalog (name, dimensions, base_price_before_vat, credit_cost, is_active) values
      ('רבע עמוד', '12×8', 400, 1, true), ('חצי עמוד', '25×8', 750, 2, true), ('עמוד מלא', '25×33', 1400, 4, true);`);
  const today = new Date();
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7 || 7));
  const sheets = [];
  for (let i = 0; i < 6; i += 1) {
    const friday = new Date(d); friday.setUTCDate(friday.getUTCDate() - 2);
    sheets.push({ sheet_number: String(501 + i), publication_date: isoDay(d), closes_at_local: `${isoDay(friday)}T00:00`, description: "" });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  await call("create_sheets_batch", { p_sheets: sheets, p_idempotency_key: crypto.randomUUID() });
  const first = sheets[0].sheet_number, second = sheets[1].sheet_number;
  await call("create_orders_batch", { p_client_id: "c-local-1", p_orders: [
    { sheet_number: first, ad_description: "חצי עמוד צבעוני — מבצע חורף", cash_amount_before_vat: 750, payment_status: "pending" },
    { sheet_number: second, ad_description: "רבע עמוד — חלות לשבת", cash_amount_before_vat: 400, payment_status: "pending" }
  ], p_idempotency_key: crypto.randomUUID() });
  await call("create_orders_batch", { p_client_id: "c-local-2", p_orders: [
    { sheet_number: first, ad_description: "עמוד מלא — פתיחת סטודיו", cash_amount_before_vat: 1400, payment_status: "paid" }
  ], p_idempotency_key: crypto.randomUUID() });
  const tpl = (await pg.query("select id, total_price_before_vat::text as price, default_installment_count as n from public.package_catalog where is_active order by credits limit 1")).rows[0];
  const n = Math.max(1, Number(tpl.n) || 1);
  const cents = Math.round(Number(tpl.price) * 100);
  const each = Math.floor(cents / n);
  const installments = Array.from({ length: n }, (_, i) => ({ due_on: isoDay(new Date(Date.UTC(today.getFullYear(), today.getMonth() + i, 1))), amount_before_vat: (i === n - 1 ? cents - each * (n - 1) : each) / 100 }));
  await call("purchase_customer_package", { p_client_id: "c-local-3", p_package_id: tpl.id, p_custom_name: null, p_credits: null, p_term_months: null,
    p_price_before_vat: null, p_starts_on: isoDay(new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1))), p_ends_on: isoDay(new Date(Date.UTC(today.getFullYear(), today.getMonth() + 6, 0))),
    p_installments: installments, p_benefits: null, p_notes: "חבילת בדיקה", p_idempotency_key: crypto.randomUUID() });
  await call("create_orders_batch", { p_client_id: "c-local-3", p_orders: [{ sheet_number: first, ad_description: "רבע עמוד — זרי חורף", credits_used: 1 }], p_idempotency_key: crypto.randomUUID() });
}
