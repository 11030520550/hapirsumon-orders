"use strict";
// LOCAL TEST VERSION ONLY. Never deployed (not one of the 11 publish files).
//
// A stand-in for supabase-js that runs the app against a REAL PostgreSQL 18 (PGlite, WebAssembly) inside this
// browser tab, stored in this browser's IndexedDB. No network, no Supabase, no production data: test data only.
//
// The database is built from the project's own SQL files, in the planned production order (see INSTALL_FILES).
// Every request runs in its own transaction as the role `authenticated` with the signed-in user's JWT claims,
// so RLS, grants, the cut-over and every RPC behave as in Supabase. Results are produced by PostgreSQL itself
// as JSON (json_agg / to_json), which is how PostgREST builds its responses: numbers, dates and timestamps come
// back in the same format the live site receives.
//
// URL options: ?db=<name> separate database (default "manual"); ?reset=1 rebuild from the SQL files.
(function () {
  const params = new URLSearchParams(location.search);
  const DB_NAME = `hapirsumon-local-${(params.get("db") || "manual").replace(/[^a-z0-9-]/gi, "")}`;
  const SESSION_KEY = `${DB_NAME}-session`;
  const PGLITE_URL = "/__local/package/dist/index.js";
  // Production history first (as it is live today), then the planned installation.
  const INSTALL_FILES = [
    "supabase-schema.sql",
    "supabase-reliability-migration.sql",
    "supabase-business-upgrade.sql",
    "supabase-sheets-and-order-numbers.sql",
    "supabase-orders-v3.sql",
    "supabase-sheets-v2.sql",
    "supabase-sheets-v2-enforce.sql",
    "supabase-business-upgrade-cutover.sql"
  ];
  const VERIFY_FILES = ["supabase-orders-v3-verify.sql", "supabase-sheets-v2-verify.sql"];
  // Test accounts (local only; they exist nowhere else).
  const ACCOUNTS = {
    "staff@local.test": { id: "00000000-0000-4000-8000-00000000a001", password: "test1234", name: "בודקת מקומית", approved: true },
    "second@local.test": { id: "00000000-0000-4000-8000-00000000a002", password: "test1234", name: "בודק שני", approved: true },
    "pending@local.test": { id: "00000000-0000-4000-8000-00000000b001", password: "test1234", name: "ממתין לאישור", approved: false }
  };
  // Simulates the cut-over day: the counter is set above the last Google Sheets number (22354 on 22/11).
  const LOCAL_COUNTER = 22354;

  const identifier = /^[a-z_][a-z0-9_]*$/;
  const ident = (name) => {
    if (!identifier.test(String(name))) throw Object.assign(new Error(`invalid identifier ${name}`), { code: "PGRST100" });
    return `"${name}"`;
  };
  const status = { phase: "starting", detail: "", version: "", reset: false };
  const listeners = [];
  const realtime = [];
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { session = null; }

  // ---------- the database ----------
  let dbPromise = null;
  const fileText = async (name) => {
    const response = await fetch(`/${name}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`missing ${name}`);
    return response.text();
  };
  async function sha256(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function deleteDatabase() {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(`/pglite/${DB_NAME}`);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
  function db() {
    if (!dbPromise) dbPromise = open();
    return dbPromise;
  }
  async function open() {
    const { PGlite } = await import(PGLITE_URL);
    if (params.get("reset") === "1") {
      status.reset = true;
      localStorage.removeItem(SESSION_KEY);
      session = null;
      await deleteDatabase();
    }
    setPhase("opening", "פותחים את מסד הבדיקה המקומי…");
    const sources = await Promise.all(INSTALL_FILES.map(fileText));
    const version = await sha256(sources.join("\n"));
    status.version = version;
    // Built and checked with every write on disk (durable mode)...
    let pg = await PGlite.create(`idb://${DB_NAME}`);
    const built = (await pg.query("select to_regclass('local_test.meta') is not null as ok")).rows[0].ok;
    const touched = (await pg.query("select to_regnamespace('auth') is not null as ok")).rows[0].ok;
    if (!built && touched) {
      // A build that stopped half way: start again from an empty database.
      await pg.close();
      await deleteDatabase();
      return open();
    }
    if (!built) {
      await build(pg, sources, version);
    } else {
      const stored = (await pg.query("select version from local_test.meta")).rows[0]?.version;
      status.stale = stored !== version;
    }
    await pg.close();
    // ...then used with relaxedDurability: reads no longer wait ~0.5 s each for IndexedDB; every write still
    // waits for its copy to disk (see flush()), so a confirmed save survives a reload.
    pg = await PGlite.create(`idb://${DB_NAME}`, { relaxedDurability: true });
    setPhase("ready", "");
    return pg;
  }

  async function build(pg, sources, version) {
    setPhase("building", "בונים מסד בדיקה מקומי מקובצי ה-SQL של הפרויקט (פעם אחת, כחצי דקה)…");
    const accounts = Object.entries(ACCOUNTS);
    await pg.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
      create publication supabase_realtime;`);
    for (const [email, account] of accounts) {
      await pg.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [account.id, email, JSON.stringify({ full_name: account.name })]);
    }
    for (let i = 0; i < INSTALL_FILES.length; i += 1) {
      const name = INSTALL_FILES[i];
      setPhase("building", `מתקינים ${name} (${i + 1}/${INSTALL_FILES.length})…`);
      let sql = sources[i];
      // Sheets v2 on an empty database: no sheet exists yet, so the keep-open list is empty (the file says how).
      if (name === "supabase-sheets-v2.sql") sql = sql.replace(/insert into sheets_v2_keep_open \(sheet_number\) values \('__REPLACE_WITH_THE_ACTIVE_SHEET__'\);/, "");
      try { await pg.exec(sql); }
      catch (error) { try { await pg.exec("rollback"); } catch { } throw new Error(`${name}: ${error.message}`); }
      if (name === "supabase-schema.sql") {
        for (const [, account] of accounts) if (account.approved) await pg.query("insert into private.approved_users (user_id) values ($1)", [account.id]);
      }
    }
    setPhase("building", "בדיקות verify…");
    const verify = [];
    for (const name of VERIFY_FILES) {
      const rows = (await pg.exec(await fileText(name))).flatMap((r) => r.rows || []);
      for (const row of rows) if (Object.values(row).some((v) => String(v).startsWith("FAIL"))) verify.push(`${name}: ${JSON.stringify(row)}`);
    }
    if (verify.length) throw new Error(`verify FAIL: ${verify.join("; ")}`);
    await pg.query("update private.order_number_counters set last_number = $1 where counter_name = 'orders'", [LOCAL_COUNTER]);
    setPhase("building", "מזינים נתוני בדיקה…");
    await seed(pg);
    // Marked as built only after everything succeeded (a failed build is rebuilt on the next load).
    await pg.exec(`create schema local_test; create table local_test.meta (version text not null, built_at timestamptz not null default now());`);
    await pg.query("insert into local_test.meta (version) values ($1)", [version]);
    await flush(pg);
  }

  // Test data, created through the same functions the screens use, as the test staff account.
  async function seed(pg) {
    await pg.exec(`
      insert into public.clients (id, name, phone, email) values
        ('c-local-1', 'מאפיית השכונה (בדיקה)', '050-0000001', null),
        ('c-local-2', 'סטודיו לעיצוב (בדיקה)', '050-0000002', null),
        ('c-local-3', 'חנות פרחים (בדיקה)', null, null),
        ('c-local-4', 'משרד עורכי דין (בדיקה)', null, null),
        ('c-local-5', 'מוסך אחים (בדיקה)', null, null);
      insert into public.product_catalog (name, dimensions, base_price_before_vat, credit_cost, is_active) values
        ('רבע עמוד', '12×8', 400, 1, true), ('חצי עמוד', '25×8', 750, 2, true), ('עמוד מלא', '25×33', 1400, 4, true);`);
    const staff = ACCOUNTS["staff@local.test"];
    const call = (name, args) => asUser(pg, staff.id, "staff@local.test", staff.name, (tx) => rpcSql(tx, name, args));
    // Sheets: the next six Sundays, closing Friday 00:00 Israel time (the default rule).
    const today = new Date();
    const sundays = [];
    const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
    d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7 || 7));
    for (let i = 0; i < 6; i += 1) { sundays.push(new Date(d)); d.setUTCDate(d.getUTCDate() + 7); }
    const iso = (x) => x.toISOString().slice(0, 10);
    const friday = (sunday) => { const f = new Date(sunday); f.setUTCDate(f.getUTCDate() - 2); return `${iso(f)}T00:00`; };
    const sheets = sundays.map((s, i) => ({ sheet_number: String(501 + i), publication_date: iso(s), closes_at_local: friday(s), description: "" }));
    await call("create_sheets_batch", { p_sheets: sheets, p_idempotency_key: crypto.randomUUID() });
    const first = sheets[0].sheet_number, second = sheets[1].sheet_number;
    await call("create_orders_batch", { p_client_id: "c-local-1", p_orders: [
      { sheet_number: first, ad_description: "חצי עמוד צבעוני — מבצע חורף", cash_amount_before_vat: 750, payment_status: "pending" },
      { sheet_number: second, ad_description: "רבע עמוד — חלות לשבת", cash_amount_before_vat: 400, payment_status: "pending" }
    ], p_idempotency_key: crypto.randomUUID() });
    await call("create_orders_batch", { p_client_id: "c-local-2", p_orders: [
      { sheet_number: first, ad_description: "עמוד מלא — פתיחת סטודיו", cash_amount_before_vat: 1400, payment_status: "paid" }
    ], p_idempotency_key: crypto.randomUUID() });
    // A package with credits and a flexible schedule for c-local-3, then a credits order from it.
    const tpl = (await pg.query("select id, total_price_before_vat::text as price, default_installment_count as n from public.package_catalog where is_active order by credits limit 1")).rows[0];
    if (tpl) {
      const n = Math.max(1, Number(tpl.n) || 1);
      const cents = Math.round(Number(tpl.price) * 100);
      const each = Math.floor(cents / n);
      const installments = Array.from({ length: n }, (_, i) => {
        const due = new Date(Date.UTC(today.getFullYear(), today.getMonth() + i, 1));
        return { due_on: iso(due), amount_before_vat: (i === n - 1 ? cents - each * (n - 1) : each) / 100 };
      });
      const start = iso(new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1)));
      const end = iso(new Date(Date.UTC(today.getFullYear(), today.getMonth() + 6, 0)));
      await call("purchase_customer_package", { p_client_id: "c-local-3", p_package_id: tpl.id, p_custom_name: null, p_credits: null, p_term_months: null,
        p_price_before_vat: null, p_starts_on: start, p_ends_on: end, p_installments: installments, p_benefits: null, p_notes: "חבילת בדיקה", p_idempotency_key: crypto.randomUUID() });
      await call("create_orders_batch", { p_client_id: "c-local-3", p_orders: [
        { sheet_number: first, ad_description: "רבע עמוד — זרי חורף", credits_used: 1 }
      ], p_idempotency_key: crypto.randomUUID() });
    }
  }

  // ---------- one request = one transaction as the signed-in user ----------
  async function asUser(pg, userId, email, name, fn) {
    return pg.transaction(async (tx) => {
      if (userId) {
        await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true), set_config('role', 'authenticated', true)",
          [userId, JSON.stringify({ sub: userId, role: "authenticated", email, user_metadata: { full_name: name } })]);
      } else {
        await tx.query("select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{\"role\":\"anon\"}', true), set_config('role', 'anon', true)");
      }
      return fn(tx);
    });
  }
  async function request(fn, { mutates = false } = {}) {
    try {
      const pg = await db();
      const user = session && session.user;
      const result = await asUser(pg, user && user.id, user && user.email, user && user.user_metadata && user.user_metadata.full_name, fn);
      if (mutates) { await flush(pg); notifyRealtime(); }
      return result;
    } catch (error) {
      return { data: null, error: pgError(error) };
    }
  }
  function pgError(error) {
    if (error && error.__postgrest) return error.__postgrest;
    return { message: String((error && error.message) || error), code: (error && error.code) || "", details: (error && error.detail) || null, hint: (error && error.hint) || null };
  }
  const value = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

  // ---------- from(table): select / insert / update / delete with eq, order, range, limit, single ----------
  function from(table) {
    const s = { table, action: "select", columns: "*", values: null, filters: [], orders: [], limit: null, offset: null, single: null, returning: false };
    const chain = {
      select(columns = "*") { if (s.action === "select") s.columns = columns; else { s.returning = true; s.columns = columns; } return chain; },
      insert(values) { s.action = "insert"; s.values = values; return chain; },
      update(values) { s.action = "update"; s.values = values; return chain; },
      delete() { s.action = "delete"; return chain; },
      eq(column, v) { s.filters.push([column, "=", v]); return chain; },
      neq(column, v) { s.filters.push([column, "<>", v]); return chain; },
      gt(column, v) { s.filters.push([column, ">", v]); return chain; },
      gte(column, v) { s.filters.push([column, ">=", v]); return chain; },
      lt(column, v) { s.filters.push([column, "<", v]); return chain; },
      lte(column, v) { s.filters.push([column, "<=", v]); return chain; },
      is(column, v) { s.filters.push([column, "is", v]); return chain; },
      in(column, list) { s.filters.push([column, "in", list]); return chain; },
      order(column, options = {}) { s.orders.push([column, options.ascending === false ? "desc" : "asc"]); return chain; },
      limit(n) { s.limit = Number(n); return chain; },
      range(a, b) { s.offset = Number(a); s.limit = Number(b) - Number(a) + 1; return chain; },
      single() { s.single = "one"; return chain; },
      maybeSingle() { s.single = "maybe"; return chain; },
      then(resolve, reject) { return run(s).then(resolve, reject); }
    };
    return chain;
  }
  function columnList(columns) {
    const list = String(columns).split(",").map((c) => c.trim()).filter(Boolean);
    if (list.length === 1 && list[0] === "*") return "*";
    return list.map(ident).join(", ");
  }
  function whereClause(s, args) {
    if (!s.filters.length) return "";
    return " where " + s.filters.map(([column, op, v]) => {
      if (op === "is") return `${ident(column)} is ${v === null ? "null" : v ? "true" : "false"}`;
      if (op === "in") { args.push(v.map(String)); return `${ident(column)}::text = any($${args.length}::text[])`; }
      args.push(value(v)); return `${ident(column)} ${op} $${args.length}`;
    }).join(" and ");
  }
  async function run(s) {
    return request(async (tx) => {
      const args = [];
      const target = `public.${ident(s.table)}`;
      let inner;
      if (s.action === "select") {
        inner = `select ${columnList(s.columns)} from ${target}${whereClause(s, args)}`;
        if (s.orders.length) inner += " order by " + s.orders.map(([c, dir]) => `${ident(c)} ${dir}`).join(", ");
        if (s.limit !== null) inner += ` limit ${Math.max(0, s.limit | 0)}`;
        if (s.offset !== null) inner += ` offset ${Math.max(0, s.offset | 0)}`;
      } else if (s.action === "insert") {
        const rows = Array.isArray(s.values) ? s.values : [s.values];
        const out = [];
        for (const row of rows) {
          const keys = Object.keys(row);
          const local = [];
          const sql = `insert into ${target} (${keys.map(ident).join(", ")}) values (${keys.map((k) => { local.push(value(row[k])); return `$${local.length}`; }).join(", ")}) returning ${s.returning ? columnList(s.columns) : "1 as ok"}`;
          const res = await tx.query(`with _r as (${sql}) select coalesce(json_agg(_r), '[]'::json) as j from _r`, local);
          out.push(...res.rows[0].j);
        }
        return shape(s, s.returning ? out : null);
      } else if (s.action === "update") {
        const sets = Object.keys(s.values).map((k) => { args.push(value(s.values[k])); return `${ident(k)} = $${args.length}`; });
        inner = `update ${target} set ${sets.join(", ")}${whereClause(s, args)} returning ${s.returning ? columnList(s.columns) : "1 as ok"}`;
      } else {
        inner = `delete from ${target}${whereClause(s, args)} returning ${s.returning ? columnList(s.columns) : "1 as ok"}`;
      }
      const sql = s.action === "select"
        ? `select coalesce(json_agg(_r), '[]'::json) as j from (${inner}) _r`
        : `with _r as (${inner}) select coalesce(json_agg(_r), '[]'::json) as j from _r`;
      const rows = (await tx.query(sql, args)).rows[0].j;
      return shape(s, s.action === "select" || s.returning ? rows : null);
    }, { mutates: s.action !== "select" });
  }
  function shape(s, rows) {
    if (rows === null) return { data: null, error: null };
    if (s.single === "one" && rows.length !== 1) throw { __postgrest: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows`, hint: null } };
    if (s.single === "maybe" && rows.length > 1) throw { __postgrest: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows`, hint: null } };
    return { data: s.single ? (rows[0] || null) : rows, error: null };
  }

  // ---------- rpc(name, args): named arguments, cast to the function's own parameter types ----------
  async function rpcSql(tx, name, args = {}) {
    if (!identifier.test(name)) throw { __postgrest: { code: "PGRST202", message: `Could not find the function public.${name}`, details: null, hint: null } };
    const keys = Object.keys(args || {});
    const procs = (await tx.query(`
      select p.oid, p.proretset as retset, p.prorettype = 'pg_catalog.void'::regtype as is_void, p.provolatile as volatile,
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
      values.push(value(v));
      return `${ident(k)} => $${values.length}::${type}`;
    }).join(", ");
    const call = `public.${ident(name)}(${list})`;
    let data;
    if (proc.is_void) { await tx.query(`select ${call}`, values); data = null; }
    else if (proc.retset) data = (await tx.query(`select coalesce(json_agg(_f), '[]'::json) as j from ${call} as _f`, values)).rows[0].j;
    else data = (await tx.query(`select to_json(${call}) as j`, values)).rows[0].j;
    return { data, error: null, volatile: proc.volatile === "v" };
  }
  async function rpc(name, args = {}) {
    let volatile = false;
    const result = await request(async (tx) => { const r = await rpcSql(tx, name, args); volatile = r.volatile; return { data: r.data, error: null }; });
    if (!result.error && volatile) { await flush(await db()); notifyRealtime(); }
    return result;
  }
  // A write is confirmed only once it is on disk (IndexedDB): reads stay fast (background copy), saves are durable.
  async function flush(pg) { try { await pg.syncToFs(false); } catch (error) { console.error("local test database: saving to IndexedDB failed", error); } }

  // ---------- auth (local test accounts) and realtime (changes made in this tab) ----------
  function emit(event, value) { for (const cb of listeners) setTimeout(() => cb(event, value), 0); }
  const auth = {
    async getSession() { await db().catch(() => null); return { data: { session }, error: null }; },
    async signInWithPassword({ email, password } = {}) {
      try { await db(); } catch (error) { return { data: { session: null }, error: { message: String(error.message || error) } }; }
      const account = ACCOUNTS[String(email || "").trim().toLowerCase()];
      if (!account || account.password !== password) {
        return { data: { session: null }, error: { name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" } };
      }
      session = { access_token: "local-test", token_type: "bearer", user: { id: account.id, email: String(email).trim().toLowerCase(), user_metadata: { full_name: account.name } } };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      emit("SIGNED_IN", session);
      return { data: { session, user: session.user }, error: null };
    },
    async signOut() { session = null; localStorage.removeItem(SESSION_KEY); emit("SIGNED_OUT", null); return { error: null }; },
    onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } } } }; }
  };
  function notifyRealtime() { for (const entry of realtime) for (const handler of entry.handlers) setTimeout(() => handler({ eventType: "*" }), 0); }
  function channel() {
    const entry = { handlers: [] };
    const ch = {
      on(_type, _filter, handler) { entry.handlers.push(handler); return ch; },
      subscribe(cb) { realtime.push(entry); db().then(() => cb && cb("SUBSCRIBED"), () => cb && cb("CHANNEL_ERROR")); return ch; },
      unsubscribe() { const i = realtime.indexOf(entry); if (i >= 0) realtime.splice(i, 1); }
    };
    entry.channel = ch;
    return ch;
  }
  const client = { auth, from, rpc, channel, removeChannel(ch) { ch && ch.unsubscribe && ch.unsubscribe(); } };

  // ---------- the visible notice and the test tools ----------
  function setPhase(phase, detail) { status.phase = phase; status.detail = detail; renderNotice(); }
  function renderNotice() {
    const bar = document.getElementById("local-test-notice");
    if (!bar) return;
    const text = bar.querySelector("span");
    if (status.phase === "error") text.textContent = `סביבת בדיקה מקומית — שגיאה בבניית המסד: ${status.detail}`;
    else if (status.phase !== "ready") text.textContent = `סביבת בדיקה מקומית — ${status.detail}`;
    else text.textContent = `סביבת בדיקה מקומית · PostgreSQL אמיתי בדפדפן · נתוני בדיקה בלבד, לא Supabase ולא הייצור · מסד "${DB_NAME.replace("hapirsumon-local-", "")}"${status.stale ? " · ⚠ קובצי ה-SQL השתנו מאז שנבנה המסד: לחצו 'איפוס'" : ""}`;
  }
  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.createElement("div");
    bar.id = "local-test-notice";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:99999;display:flex;gap:12px;align-items:center;justify-content:center;padding:6px 12px;background:#7a1f1f;color:#fff;font:13px/1.4 system-ui,sans-serif;direction:rtl";
    const span = document.createElement("span");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "איפוס נתוני הבדיקה";
    reset.style.cssText = "font:inherit;padding:2px 10px;border:1px solid #fff;background:transparent;color:#fff;cursor:pointer";
    reset.addEventListener("click", () => {
      if (!confirm("למחוק את מסד הבדיקה המקומי ולבנות אותו מחדש מקובצי ה-SQL? (נתוני בדיקה בלבד)")) return;
      const url = new URL(location.href); url.searchParams.set("reset", "1"); location.href = url.toString();
    });
    bar.append(span, reset);
    document.body.append(bar);
    renderNotice();
    if (params.get("reset") === "1") db().then(() => { const url = new URL(location.href); url.searchParams.delete("reset"); history.replaceState(null, "", url.toString()); }, () => {});
  });
  db().catch((error) => { status.phase = "error"; status.detail = String(error.message || error); renderNotice(); console.error("local test database:", error); });

  // Test-only handle (used by the end-to-end runner): read-only checks as the database owner.
  window.__localpg = {
    status,
    ready: () => db(),
    async sql(text, args = []) { const pg = await db(); return pg.transaction(async (tx) => { await tx.exec("set transaction read only"); return (await tx.query(text, args)).rows; }); },
    async setCounter(n) { const pg = await db(); await pg.query("update private.order_number_counters set last_number = $1 where counter_name = 'orders'", [n]); }
  };
  window.supabase = { createClient: () => client };
})();
