"use strict";
// Test double for supabase-js. No network access. Fake data only.
// ?business=1 simulates an installed business schema with simplified RPC semantics.
(() => {
  const params = new URLSearchParams(location.search);
  const business = params.get("business") === "1";
  const now = () => new Date(Date.now() + (now.tick = (now.tick || 0) + 1)).toISOString();
  const uuid = () => crypto.randomUUID();
  const vatRate = () => Number(db.business_settings[0].vat_rate);
  const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

  const db = {
    clients: Array.from({ length: 30 }, (_, i) => ({
      id: `c-test-${i}`, name: `לקוח בדיקה ${i + 1}`, phone: `050-000-${String(i).padStart(4, "0")}`,
      email: `test${i}@example.invalid`, updated_at: "2026-01-01T00:00:00Z", joined_at: "2026-01-01", internal_notes: ""
    })),
    orders: Array.from({ length: 30 }, (_, i) => ({
      id: `o-test-${i}`, client_id: `c-test-${i % 30}`, publication_date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
      section: i % 2 ? "נדל״ן" : "רכב", amount: 100 + i, payment_status: i % 3 ? "pending" : "paid", notes: "",
      updated_at: "2026-01-01T00:00:00Z", order_number: 22001 + i, billing_mode: "legacy", credits_used: null, created_at: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T09:00:00Z`, entered_at: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, product_name_snapshot: null, product_dimensions_snapshot: null,
      cash_amount_before_vat: null, sheet_number: business && i % 3 === 0 ? "124" : null
    })),
    business_settings: [{ vat_rate: "0.1800" }],
    package_catalog: [
      { id: "11111111-1111-4111-8111-111111111111", name: "מינימום מקסימום", credits: "30.00", term_months: 6, total_price_before_vat: "2148.00", default_installment_count: 12, default_installment_before_vat: "179.00", benefits: [{ label: "מיקום על המפה", quantity: 6, unit: "חודשים" }], is_active: true },
      { id: "22222222-2222-4222-8222-222222222222", name: "מותג מוביל", credits: "60.00", term_months: 12, total_price_before_vat: "4188.00", default_installment_count: 12, default_installment_before_vat: "349.00", benefits: [], is_active: true },
      { id: "33333333-3333-4333-8333-333333333333", name: "פרסום מנצח", credits: "120.00", term_months: 12, total_price_before_vat: "8028.00", default_installment_count: 12, default_installment_before_vat: "669.00", benefits: [], is_active: true }
    ],
    product_catalog: params.get("noproducts") === "1" ? [] : [
      { id: "44444444-4444-4444-8444-444444444444", name: "מוצר הדגמה — לא מחירון", dimensions: "הדגמה", base_price_before_vat: "500.00", credit_cost: "2.50", is_active: true }
    ],
    customer_packages: [], package_installments: [], financial_obligations: [], credit_ledger: [], sheets: [], ops: new Map()
  };
  // Legacy cash orders get a legacy obligation, as the migration backfill does.
  db.financial_obligations = db.orders.map((o) => ({
    id: uuid(), order_id: o.id, package_installment_id: null, amount_due: o.amount, due_on: null,
    status: o.payment_status, updated_at: now()
  }));
  let orderCounter = 22030;

  const user = { id: "00000000-0000-4000-8000-0000000000aa" };
  const state = { session: params.get("session") === "1" ? { user } : null, approvalDelay: Number(params.get("delay") || 0), listeners: [], failNext: null, rpcCalls: [] };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const emit = (event, session) => state.listeners.forEach((cb) => cb(event, session));
  const err = (message, code = "P0001") => ({ data: null, error: { message, code } });

  function tableRows(table) {
    if (table === "business_financial_totals") {
      const t = today();
      const open = db.financial_obligations.filter((o) => o.status !== "paid");
      const sum = (rows) => r2(rows.reduce((s, o) => s + Number(o.amount_due), 0));
      return [{ total_cash_billed: sum(db.financial_obligations), total_cash_received: sum(db.financial_obligations.filter((o) => o.status === "paid")),
        total_cash_outstanding: sum(open), total_overdue: sum(open.filter((o) => o.due_on && o.due_on < t)) }];
    }
    if (table === "business_client_credit_balances") {
      return db.clients.map((c) => ({ client_id: c.id, credit_balance: String(r2(db.credit_ledger.filter((l) => l.client_id === c.id).reduce((s, l) => s + Number(l.delta), 0))) }));
    }
    return db[table];
  }

  function query(table) {
    const businessTable = !["clients", "orders"].includes(table);
    const filters = [];
    const orderBy = []; let limit = null; let range = null; let patch = null; let single = false;
    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push((r) => String(r[col]) === String(val)); return chain; },
      lte(col, val) { filters.push((r) => r[col] <= val); return chain; },
      gte(col, val) { filters.push((r) => r[col] >= val); return chain; },
      in(col, vals) { filters.push((r) => vals.map(String).includes(String(r[col]))); return chain; },
      order(col, opts = {}) { orderBy.push({ col, asc: opts.ascending !== false }); return chain; },
      limit(n) { limit = n; return chain; },
      range(from, to) { range = [from, to]; return chain; },
      update(values) { patch = values; return chain; },
      maybeSingle() { single = true; return chain; },
      then(resolve, reject) {
        if ((businessTable && !business) || (table === "sheets" && params.get("sheets") !== "1")) return Promise.resolve({ data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` } }).then(resolve, reject);
        if (patch) {
          const hit = tableRows(table).filter((r) => filters.every((f) => f(r)));
          hit.forEach((r) => Object.assign(r, patch, { updated_at: now() }));
          const copies = hit.map((r) => ({ ...r }));
          return Promise.resolve({ data: single ? (copies[0] || null) : copies, error: null }).then(resolve, reject);
        }
        let rows = tableRows(table).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
        rows.sort((a, b) => { for (const o of orderBy) { const c = (a[o.col] > b[o.col] ? 1 : a[o.col] < b[o.col] ? -1 : 0) * (o.asc ? 1 : -1); if (c) return c; } return 0; });
        if (range) rows = rows.slice(range[0], Math.min(range[1] + 1, Number(params.get("maxrows") || 1000) + range[0]));
        else if (params.get("maxrows")) rows = rows.slice(0, Number(params.get("maxrows")));
        if (limit != null) rows = rows.slice(0, limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      }
    };
    return chain;
  }

  function balance(clientId) { return r2(db.credit_ledger.filter((l) => l.client_id === clientId).reduce((s, l) => s + Number(l.delta), 0)); }

  const rpcs = {
    current_user_is_approved: () => true,
    set_business_vat_rate(p) {
      if (!(p.p_vat_rate >= 0 && p.p_vat_rate <= 1)) throw 'שיעור המע"מ חייב להיות בין 0%% ל-100%%.';
      db.business_settings[0].vat_rate = String(p.p_vat_rate); return null;
    },
    save_product_catalog_item(p) {
      if (!(p.p_name || "").trim()) throw "יש להזין שם מוצר תקין.";
      if (p.p_is_active && (p.p_base_price_before_vat == null || p.p_credit_cost == null)) throw "אי אפשר להפעיל מוצר לפני שמחירו ועלות הקרדיטים שלו הוזנו ממקור מאומת.";
      const row = { name: p.p_name.trim(), dimensions: p.p_dimensions || "", base_price_before_vat: p.p_base_price_before_vat == null ? null : String(p.p_base_price_before_vat),
        credit_cost: p.p_credit_cost == null ? null : String(p.p_credit_cost), is_active: Boolean(p.p_is_active), updated_at: now() };
      if (p.p_product_id) { const existing = db.product_catalog.find((x) => x.id === p.p_product_id); if (!existing) throw "המוצר לא נמצא."; Object.assign(existing, row); return existing.id; }
      const id = uuid(); db.product_catalog.push({ id, ...row }); return id;
    },
    set_sheet_status(p) {
      const sheet = (p.p_sheet_number || "").trim();
      if (!db.orders.some((o) => (o.sheet_number || "").trim() === sheet)) throw "לגיליון זה אין הזמנות במערכת.";
      if (!p.p_is_closed && (p.p_reason || "").trim().length < 3) throw "נדרש הסבר קצר לפתיחה מחדש של גיליון סגור.";
      let row = db.sheets.find((s) => s.sheet_number === sheet);
      if (row && p.p_expected_updated_at && row.updated_at !== p.p_expected_updated_at) { const e = new Error("סטטוס הגיליון השתנה"); e.code = "40001"; throw e; }
      if (!row) { row = { sheet_number: sheet }; db.sheets.push(row); }
      Object.assign(row, { status: p.p_is_closed ? "closed" : "open", status_reason: p.p_reason || "", closed_at: p.p_is_closed ? now() : null, updated_at: now() });
      return { sheet_number: sheet, status: row.status, updated_at: row.updated_at };
    },
    purchase_customer_package(p) {
      const tpl = p.p_package_id ? db.package_catalog.find((x) => x.id === p.p_package_id) : null;
      if (p.p_package_id && !tpl) throw "החבילה אינה קיימת או אינה פעילה.";
      const name = tpl ? tpl.name : (p.p_custom_name || "").trim();
      const credits = tpl ? Number(p.p_credits ?? tpl.credits) : Number(p.p_credits);
      const price = tpl ? Number(p.p_price_before_vat ?? tpl.total_price_before_vat) : Number(p.p_price_before_vat);
      const term = tpl ? Number(p.p_term_months ?? tpl.term_months) : Number(p.p_term_months);
      if (!name || !(credits > 0) || !(price > 0) || !(term > 0)) throw "פרטי החבילה או ההסכם האישי אינם תקינים.";
      const sum = r2(p.p_installments.reduce((s, i) => s + Number(i.amount_before_vat), 0));
      if (Math.abs(sum - price) > 0.01) throw 'סכום התשלומים לפני מע"מ חייב להיות שווה למחיר החבילה.';
      const pkgId = uuid();
      const installments = p.p_installments.map((i, idx) => ({ id: uuid(), customer_package_id: pkgId, installment_number: idx + 1, due_on: i.due_on, amount_due: String(r2(Number(i.amount_before_vat) * (1 + vatRate()))) }));
      db.customer_packages.push({ id: pkgId, client_id: p.p_client_id, package_name_snapshot: name, credits_granted: String(credits), term_months: term, price_before_vat: String(price),
        gross_total: String(r2(installments.reduce((s, i) => s + Number(i.amount_due), 0))), starts_on: p.p_starts_on, ends_on: p.p_ends_on, installment_count: installments.length,
        benefits_snapshot: p.p_benefits ?? (tpl ? tpl.benefits : []), status: "active" });
      db.package_installments.push(...installments);
      for (const i of installments) db.financial_obligations.push({ id: uuid(), order_id: null, package_installment_id: i.id, amount_due: i.amount_due, due_on: i.due_on, status: "pending", updated_at: now() });
      db.credit_ledger.push({ client_id: p.p_client_id, delta: String(credits), entry_type: "package_grant", reason: "הקצאת חבילה", created_at: now() });
      return { customer_package_id: pkgId, credit_balance: balance(p.p_client_id) };
    },
    adjust_client_credits(p) {
      if (!Number(p.p_delta) || !(p.p_reason || "").trim()) throw "תנועת תיקון קרדיטים מחייבת כמות שאינה אפס והסבר.";
      db.credit_ledger.push({ client_id: p.p_client_id, delta: String(p.p_delta), entry_type: "correction", reason: p.p_reason, created_at: now() });
      return balance(p.p_client_id);
    },
    create_orders_batch(p) {
      return p.p_orders.map((row) => {
        const product = db.product_catalog.find((x) => x.id === row.product_id && x.is_active);
        if (!product) throw "המוצר בשורה 1 אינו קיים או אינו פעיל.";
        if ((row.cash_amount_before_vat == null) === (row.credits_used == null)) throw 'בכל שורה יש למלא בדיוק ערך חיובי אחד: מחיר לפני מע"מ או קרדיטים.';
        const credits = row.credits_used != null;
        const amount = credits ? 0 : r2(Number(row.cash_amount_before_vat) * (1 + vatRate()));
        const order = { id: `o-${uuid()}`, client_id: p.p_client_id, publication_date: row.publication_date, section: product.name, created_at: new Date().toISOString(), entered_at: today(), product_name_snapshot: product.name, product_dimensions_snapshot: product.dimensions, amount, payment_status: credits ? "paid" : row.payment_status,
          notes: row.notes || "", updated_at: now(), order_number: ++orderCounter, billing_mode: credits ? "credits" : "cash", credits_used: credits ? String(row.credits_used) : null,
          cash_amount_before_vat: credits ? null : String(row.cash_amount_before_vat), sheet_number: row.sheet_number };
        db.orders.push(order);
        if (credits) {
          db.credit_ledger.push({ client_id: p.p_client_id, delta: String(-row.credits_used), entry_type: "order_consumption", reason: `ניצול קרדיטים בהזמנה ${order.order_number}`, created_at: now() });
          return { id: order.id, order_number: order.order_number, billing_mode: "credits", credit_balance_after: balance(p.p_client_id) };
        }
        const ob = { id: uuid(), order_id: order.id, package_installment_id: null, amount_due: String(amount), due_on: row.due_on, status: order.payment_status, updated_at: now() };
        db.financial_obligations.push(ob);
        return { id: order.id, order_number: order.order_number, billing_mode: "cash", gross_amount: amount, obligation_id: ob.id };
      });
    },
    set_obligation_paid(p) {
      const ob = db.financial_obligations.find((x) => x.id === p.p_obligation_id);
      if (!ob) throw "החיוב לא נמצא.";
      const order = ob.order_id ? db.orders.find((o) => o.id === ob.order_id) : null;
      const expected = order ? order.updated_at : ob.updated_at;
      if (expected !== p.p_expected_updated_at) { const e = new Error("החיוב השתנה אצל משתמש אחר. רענני את הנתונים ונסי שוב."); e.code = "40001"; throw e; }
      if (!p.p_is_paid && !(p.p_reason || "").trim()) throw "נדרש הסבר קצר לפתיחה מחדש של תשלום שסומן כשולם.";
      ob.status = p.p_is_paid ? "paid" : "pending"; ob.updated_at = now();
      if (order) { order.payment_status = ob.status; order.updated_at = now(); }
      return { obligation_id: ob.id, status: ob.status, updated_at: order ? order.updated_at : ob.updated_at };
    },
    delete_business_order(p) {
      const idx = db.orders.findIndex((o) => o.id === p.p_order_id);
      if (idx < 0) throw "ההזמנה לא נמצאה.";
      if (db.orders[idx].updated_at !== p.p_expected_updated_at) { const e = new Error("stale"); e.code = "40001"; throw e; }
      if (db.orders[idx].payment_status === "paid") throw "לא ניתן למחוק הזמנה עם תשלום או קרדיטים.";
      db.financial_obligations = db.financial_obligations.filter((o) => o.order_id !== p.p_order_id);
      db.orders.splice(idx, 1);
      return { deleted: true };
    }
  };

  const client = {
    auth: {
      async getSession() { return { data: { session: state.session }, error: null }; },
      async signInWithPassword(credentials = {}) {
        state.signInCalls = (state.signInCalls || 0) + 1;
        if (params.get("signindelay")) await wait(Number(params.get("signindelay")));
        if (credentials.password === "wrong") return { data: { session: null }, error: { code: "invalid_credentials", message: "Invalid login credentials" } };
        if (credentials.password === "offline") return { data: { session: null }, error: { message: "Failed to fetch" } };
        if (credentials.password === "ratelimit") return { data: { session: null }, error: { name: "AuthApiError", status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" } };
        if (credentials.password === "unexpected") return { data: { session: null }, error: { name: "AuthApiError", status: 500, code: "unexpected_failure", message: "Database error querying schema (internal detail XYZ)" } };
        state.session = { user }; setTimeout(() => emit("SIGNED_IN", state.session), 0); return { data: { session: state.session }, error: null };
      },
      async signOut() { state.session = null; setTimeout(() => emit("SIGNED_OUT", null), 0); return { error: null }; },
      onAuthStateChange(cb) { state.listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; }
    },
    async rpc(name, args = {}) {
      if (state.approvalDelay && name === "current_user_is_approved") await wait(state.approvalDelay);
      await wait(20);
      if (!rpcs[name] || (!business && name !== "current_user_is_approved")) return err(`Could not find the function public.${name}`, "PGRST202");
      state.rpcCalls.push(name);
      const key = args.p_idempotency_key;
      const hash = JSON.stringify({ ...args, p_idempotency_key: undefined });
      if (key && db.ops.has(key)) {
        const op = db.ops.get(key);
        if (op.hash !== hash) return err("מפתח הפעולה כבר שויך לבקשה אחרת.");
        return { data: op.result, error: null };
      }
      if (state.failNext === "before") { state.failNext = null; return { data: null, error: { message: "Failed to fetch" } }; }
      try {
        const result = rpcs[name](args);
        if (key) db.ops.set(key, { hash, result });
        if (state.failNext === "after") { state.failNext = null; return { data: null, error: { message: "Failed to fetch" } }; }
        return { data: result, error: null };
      } catch (e) {
        return err(typeof e === "string" ? e : e.message, e.code || "P0001");
      }
    },
    from: query,
    channel() { const channel = { on() { return channel; }, subscribe(cb) { setTimeout(() => cb("SUBSCRIBED"), 0); return channel; } }; return channel; },
    removeChannel() {}
  };

  window.__mock = {
    db, state,
    expireSession() { state.session = null; emit("SIGNED_OUT", null); },
    failNext(mode) { state.failNext = mode; },
    get signInCalls() { return state.signInCalls || 0; }
  };
  window.supabase = { createClient: () => client };
})();
