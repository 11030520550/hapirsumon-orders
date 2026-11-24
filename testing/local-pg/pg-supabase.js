"use strict";
// LOCAL TEST / DEMO VERSION ONLY. Never deployed (not one of the publish files).
//
// A stand-in for supabase-js that runs the app against a REAL PostgreSQL 18 (PGlite, WebAssembly) inside this
// browser tab, stored in this browser's IndexedDB. No network, no Supabase, no production data: fictional data only.
// The database is built by local-db.mjs from the project's own SQL files, in the planned production order.
// Every request runs in its own transaction as the role `authenticated` with the signed-in user's JWT claims,
// so RLS, grants, the cut-over and every RPC behave as in Supabase. Results are produced by PostgreSQL itself
// as JSON (json_agg / to_json), the way PostgREST builds its responses.
//
// URL options: ?db=<name> separate database (default "demo"); ?seed=demo|basic data set when the database is
// built (default demo: ~16 weeks of fictional activity; basic: the small set the end-to-end tests use);
// ?reset=1 delete this database and build it again.
(function () {
  const params = new URLSearchParams(location.search);
  const DB_LABEL = (params.get("db") || "demo").replace(/[^a-z0-9-]/gi, "") || "demo";
  const DB_NAME = `hapirsumon-local-${DB_LABEL}`;
  const SEED = params.get("seed") === "basic" ? "basic" : "demo";
  const SESSION_KEY = `${DB_NAME}-session`;
  const PGLITE_URL = "/__local/package/dist/index.js";
  const status = { phase: "starting", detail: "", version: "", reset: false, seed: SEED };
  const listeners = [];
  const realtime = [];
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { session = null; }
  const localDb = import("/__local/local-db.mjs");

  // ---------- the database ----------
  let dbPromise = null;
  const fileText = async (name) => {
    const response = await fetch(name.startsWith("/") ? name : `/${name}`, { cache: "no-store" });
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
    const [{ PGlite }, mod] = await Promise.all([import(PGLITE_URL), localDb]);
    if (params.get("reset") === "1" && !status.reset) {
      status.reset = true;
      localStorage.removeItem(SESSION_KEY);
      session = null;
      await deleteDatabase();
    }
    setPhase("opening", "פותחים את המסד המקומי…");
    // The SQL files and the data scripts: when they change, the notice offers a rebuild.
    const sources = await Promise.all([...mod.INSTALL_FILES, "/__local/local-db.mjs", "/__local/demo-seed.mjs"].map(fileText));
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
      // Built in memory (hundreds of business operations in seconds), then copied to IndexedDB in one piece.
      await pg.close();
      await deleteDatabase();
      setPhase("building", SEED === "demo" ? "בונים את גרסת ההדגמה (פעם אחת, כ-15 שניות)…" : "בונים מסד בדיקה מקומי…");
      const memory = await PGlite.create();
      await mod.buildDatabase(memory, { readText: fileText, seed: SEED, onPhase: (text) => setPhase("building", text) });
      // Marked as built only after everything succeeded (a failed build is rebuilt on the next load).
      await memory.exec("create schema local_test; create table local_test.meta (version text not null, seed text not null, built_at timestamptz not null default now());");
      await memory.query("insert into local_test.meta (version, seed) values ($1, $2)", [version, SEED]);
      setPhase("building", "שומרים את המסד בדפדפן…");
      const dump = await memory.dumpDataDir("none");
      await memory.close();
      pg = await PGlite.create(`idb://${DB_NAME}`, { loadDataDir: dump });
      await flush(pg);
    } else {
      const meta = (await pg.query("select version, seed from local_test.meta")).rows[0] || {};
      status.stale = meta.version !== version;
      status.seed = meta.seed || SEED;
    }
    await pg.close();
    // ...then used with relaxedDurability: reads no longer wait ~0.5 s each for IndexedDB; every write still
    // waits for its copy to disk (see flush()), so a confirmed save survives a reload.
    pg = await PGlite.create(`idb://${DB_NAME}`, { relaxedDurability: true });
    setPhase("ready", "");
    return pg;
  }

  async function request(fn, { mutates = false } = {}) {
    try {
      const [pg, mod] = await Promise.all([db(), localDb]);
      const user = session && session.user;
      const result = await mod.asUser(pg, user ? { id: user.id, email: user.email, name: user.user_metadata && user.user_metadata.full_name } : null, fn);
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
  async function run(s) {
    const { ident, jsonValue } = await localDb;
    const columnList = (columns) => {
      const list = String(columns).split(",").map((c) => c.trim()).filter(Boolean);
      return list.length === 1 && list[0] === "*" ? "*" : list.map(ident).join(", ");
    };
    const whereClause = (args) => (!s.filters.length ? "" : " where " + s.filters.map(([column, op, v]) => {
      if (op === "is") return `${ident(column)} is ${v === null ? "null" : v ? "true" : "false"}`;
      if (op === "in") { args.push(v.map(String)); return `${ident(column)}::text = any($${args.length}::text[])`; }
      args.push(jsonValue(v)); return `${ident(column)} ${op} $${args.length}`;
    }).join(" and "));
    return request(async (tx) => {
      const args = [];
      const target = `public.${ident(s.table)}`;
      let inner;
      if (s.action === "select") {
        inner = `select ${columnList(s.columns)} from ${target}${whereClause(args)}`;
        if (s.orders.length) inner += " order by " + s.orders.map(([c, dir]) => `${ident(c)} ${dir}`).join(", ");
        if (s.limit !== null) inner += ` limit ${Math.max(0, s.limit | 0)}`;
        if (s.offset !== null) inner += ` offset ${Math.max(0, s.offset | 0)}`;
      } else if (s.action === "insert") {
        const rows = Array.isArray(s.values) ? s.values : [s.values];
        const out = [];
        for (const row of rows) {
          const keys = Object.keys(row);
          const local = [];
          const sql = `insert into ${target} (${keys.map(ident).join(", ")}) values (${keys.map((k) => { local.push(jsonValue(row[k])); return `$${local.length}`; }).join(", ")}) returning ${s.returning ? columnList(s.columns) : "1 as ok"}`;
          const res = await tx.query(`with _r as (${sql}) select coalesce(json_agg(_r), '[]'::json) as j from _r`, local);
          out.push(...res.rows[0].j);
        }
        return shape(s, s.returning ? out : null);
      } else if (s.action === "update") {
        const sets = Object.keys(s.values).map((k) => { args.push(jsonValue(s.values[k])); return `${ident(k)} = $${args.length}`; });
        inner = `update ${target} set ${sets.join(", ")}${whereClause(args)} returning ${s.returning ? columnList(s.columns) : "1 as ok"}`;
      } else {
        inner = `delete from ${target}${whereClause(args)} returning ${s.returning ? columnList(s.columns) : "1 as ok"}`;
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

  async function rpc(name, args = {}) {
    const { rpcSql } = await localDb;
    let volatile = false;
    const result = await request(async (tx) => { const r = await rpcSql(tx, name, args); volatile = r.volatile; return { data: r.data, error: null }; });
    if (!result.error && volatile) { await flush(await db()); notifyRealtime(); }
    return result;
  }
  // A write is confirmed only once it is on disk (IndexedDB): reads stay fast (background copy), saves are durable.
  async function flush(pg) { try { await pg.syncToFs(false); } catch (error) { console.error("local database: saving to IndexedDB failed", error); } }

  // ---------- auth (local accounts) and realtime (changes made in this tab) ----------
  function emit(event, value) { for (const cb of listeners) setTimeout(() => cb(event, value), 0); }
  const auth = {
    async getSession() { await db().catch(() => null); return { data: { session }, error: null }; },
    async signInWithPassword({ email, password } = {}) {
      let accounts;
      try { await db(); accounts = (await localDb).ACCOUNTS; } catch (error) { return { data: { session: null }, error: { message: String(error.message || error) } }; }
      const address = String(email || "").trim().toLowerCase();
      const account = accounts[address];
      if (!account || account.password !== password) {
        return { data: { session: null }, error: { name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" } };
      }
      session = { access_token: "local-test", token_type: "bearer", user: { id: account.id, email: address, user_metadata: { full_name: account.name } } };
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
    return ch;
  }
  const client = { auth, from, rpc, channel, removeChannel(ch) { ch && ch.unsubscribe && ch.unsubscribe(); } };

  // ---------- the visible notice ----------
  function setPhase(phase, detail) { status.phase = phase; status.detail = detail; renderNotice(); }
  function renderNotice() {
    const bar = document.getElementById("local-test-notice");
    if (!bar) return;
    const text = bar.querySelector("span");
    const kind = status.seed === "demo" ? "גרסת הדגמה" : "סביבת בדיקה מקומית";
    if (status.phase === "error") text.textContent = `${kind} — שגיאה בבניית המסד: ${status.detail}`;
    else if (status.phase !== "ready") text.textContent = `${kind} — ${status.detail}`;
    else text.textContent = `${kind} · נתונים פיקטיביים בלבד · PostgreSQL מקומי בדפדפן, לא Supabase ולא הייצור${status.stale ? " · ⚠ הקבצים עודכנו מאז שנבנה המסד: לחצו 'איפוס'" : ""}`;
  }
  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.createElement("div");
    bar.id = "local-test-notice";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:99999;display:flex;gap:12px;align-items:center;justify-content:center;padding:5px 12px;background:#7a1f1f;color:#fff;font:13px/1.4 system-ui,sans-serif;direction:rtl";
    const span = document.createElement("span");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "איפוס הנתונים";
    reset.style.cssText = "font:inherit;padding:1px 10px;border:1px solid #fff;background:transparent;color:#fff;cursor:pointer";
    reset.addEventListener("click", () => {
      if (!confirm("למחוק את המסד המקומי ולבנות אותו מחדש מההתחלה? (נתונים פיקטיביים בלבד; שום דבר לא נשלח לשרת)")) return;
      const url = new URL(location.href); url.searchParams.set("reset", "1"); url.searchParams.set("seed", status.seed); location.href = url.toString();
    });
    bar.append(span, reset);
    document.body.append(bar);
    document.body.style.paddingBottom = "30px";
    renderNotice();
    if (params.get("reset") === "1") db().then(() => { const url = new URL(location.href); url.searchParams.delete("reset"); history.replaceState(null, "", url.toString()); }, () => {});
  });
  db().catch((error) => { status.phase = "error"; status.detail = String(error.message || error); renderNotice(); console.error("local database:", error); });

  // Test-only handle (used by the end-to-end runner): read-only checks as the database owner.
  window.__localpg = {
    status,
    ready: () => db(),
    async sql(text, args = []) { const pg = await db(); return pg.transaction(async (tx) => { await tx.exec("set transaction read only"); return (await tx.query(text, args)).rows; }); }
  };
  window.supabase = { createClient: () => client };
})();
