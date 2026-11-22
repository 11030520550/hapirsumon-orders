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
    customer_packages: [], package_installments: [], financial_obligations: [], credit_ledger: [], sheets: [],
    business_payment_events: [], payments: [], ops: new Map()
  };
  // ?orders=3: the orders model of supabase-orders-v3.sql (free description, workflow statuses, cancellation,
  // partial receipts, schedule edits). Without it the mock is the model that is live today (v2).
  const ordersV3 = business && params.get("orders") === "3";
  if (ordersV3) for (const o of db.orders) Object.assign(o, { ad_description: null, file_status: "unknown", placement_status: "unknown", cancelled_at: null, cancel_reason: null, entered_by_name: null });
  // Legacy cash orders get a legacy obligation, as the migration backfill does.
  db.financial_obligations = db.orders.map((o) => ({
    id: uuid(), order_id: o.id, package_installment_id: null, amount_due: String(o.amount), due_on: null,
    status: o.payment_status, legacy_snapshot: true, amount_before_vat: null, cancelled_at: null, cancel_reason: null,
    received_at_cancel: null, updated_at: now()
  }));
  let orderCounter = 22030;
  const V3_ORDER_COLUMNS = ["ad_description", "file_status", "placement_status", "cancelled_at", "cancel_reason"];

  // ----- money, as the financial views compute it -----
  function obligationReceived(ob) {
    const events = db.business_payment_events.filter((e) => e.obligation_id === ob.id);
    const legacyPayments = ob.order_id ? db.payments.filter((p) => p.order_id === ob.order_id) : [];
    if (!events.length && !legacyPayments.length && ob.legacy_snapshot) {
      if (ob.status === "paid") return Number(ob.amount_due);
      if (ob.status === "cancelled") return Number(ob.received_at_cancel || 0);
    }
    return r2([...events, ...legacyPayments].reduce((s, e) => s + Number(e.amount), 0));
  }
  function refreshObligation(ob) {
    if (ob.status === "cancelled") return "cancelled";
    const status = obligationReceived(ob) >= Number(ob.amount_due) ? "paid" : "pending";
    ob.status = status; ob.updated_at = now();
    const order = ob.order_id && db.orders.find((o) => o.id === ob.order_id);
    if (order && order.payment_status !== status) { order.payment_status = status; order.updated_at = now(); }
    return status;
  }
  function summaryRows() {
    const t = today();
    const money = (due, received, dueOn) => {
      const outstanding = Math.max(r2(due - received), 0);
      return { cash_due: String(due), cash_received: String(received), cash_outstanding: String(outstanding), due_on: dueOn,
        overdue_amount: String(outstanding > 0 && dueOn && dueOn < t ? outstanding : 0), future_amount: String(outstanding > 0 && dueOn && dueOn > t ? outstanding : 0),
        no_due_date_amount: String(outstanding > 0 && !dueOn ? outstanding : 0) };
    };
    const rows = db.orders.map((o) => {
      const ob = db.financial_obligations.find((f) => f.order_id === o.id);
      const cancelled = Boolean(o.cancelled_at) || ob?.status === "cancelled";
      const received = o.billing_mode === "credits" || !ob ? 0 : obligationReceived(ob);
      const full = o.billing_mode === "credits" ? 0 : Number(ob ? ob.amount_due : o.amount);
      return { item_type: "order", item_id: o.id, client_id: o.client_id, order_number: o.order_number, sheet_number: o.sheet_number, description: o.section,
        billing_mode: o.billing_mode, ...money(o.billing_mode === "credits" ? 0 : cancelled ? received : full, received, ob?.due_on ?? null),
        payment_status: cancelled ? "cancelled" : (ob?.status ?? o.payment_status), legacy_snapshot: Boolean(ob?.legacy_snapshot),
        ...(ordersV3 ? { obligation_id: ob?.id ?? null, is_cancelled: cancelled } : {}) };
    });
    for (const inst of db.package_installments) {
      const pkg = db.customer_packages.find((p) => p.id === inst.customer_package_id);
      const ob = db.financial_obligations.find((f) => f.package_installment_id === inst.id);
      if (!pkg || !ob) continue;
      const received = obligationReceived(ob);
      const cancelled = ob.status === "cancelled";
      rows.push({ item_type: "package_installment", item_id: inst.id, client_id: pkg.client_id, order_number: null, sheet_number: null,
        description: `${pkg.package_name_snapshot} - תשלום ${inst.installment_number}`, billing_mode: "package",
        ...money(cancelled ? received : Number(ob.amount_due), received, ob.due_on), payment_status: ob.status, legacy_snapshot: false,
        ...(ordersV3 ? { obligation_id: ob.id, is_cancelled: cancelled } : {}) });
    }
    return rows;
  }
  const staleV3 = (what) => { const e = new Error(`${what} עודכן אצל משתמש אחר. רענני את הנתונים ונסי שוב.`); e.code = "40001"; return e; };
  const needV3 = (name) => { if (!ordersV3) throw `Could not find the function public.${name}`; };

  // ===== Sheets model v2 (?sheets=2; mirrors supabase-sheets-v2.sql). ?enforce=1 adds stage B (closed-sheet guard).
  const sheetsV2 = params.get("sheets") === "2";
  const enforce = params.get("enforce") === "1";
  let clockOffset = 0; // __mock.setNow() moves the "server" clock (deadline tests)
  const serverMs = () => Date.now() + clockOffset;
  const serverIso = () => new Date(serverMs()).toISOString();
  // Israel wall time → UTC, with DST (same rule as  (local::timestamp) at time zone 'Asia/Jerusalem').
  const jerusalemParts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function jerusalemOffsetMs(utcMs) {
    const parts = Object.fromEntries(jerusalemParts.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - utcMs;
  }
  function jerusalemTime(local) {
    if (local == null || String(local).trim() === "") return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local).trim());
    if (!match) throw "מועד הסגירה אינו תקין.";
    const wall = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
    let utc = wall;
    for (let i = 0; i < 3; i += 1) utc = wall - jerusalemOffsetMs(utc);
    return new Date(utc).toISOString();
  }
  const addDays = (dateValue, days) => {
    const [y, m, d] = dateValue.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };
  const jerusalemToday = () => { const p = Object.fromEntries(jerusalemParts.formatToParts(new Date(serverMs())).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
  const endOfDayUtc = (dateValue) => jerusalemTime(`${addDays(dateValue, 1)}T00:00`);
  const sheetIsClosed = (row) => row.status === "closed" || (row.closes_at != null && Date.parse(row.closes_at) <= serverMs());
  function seedSheetsV2() {
    // Historical sheet 124 (has orders): closed by the migration backfill, no publication date.
    db.sheets.push({ sheet_number: "124", status: "closed", status_reason: "גיליון היסטורי — סומן כסגור במעבר למודל הגיליונות",
      closed_at: now(), publication_date: null, closes_at: null, description: "", created_at: now(), created_via: "backfill",
      reopened_at: null, updated_at: now() });
    // Planned sheets 125–128: the next four Sundays, closing Friday 00:00 Israel time.
    const today = jerusalemToday();
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    const firstSunday = addDays(today, weekday === 0 ? 7 : 7 - weekday);
    for (let i = 0; i < 4; i += 1) {
      const publication = addDays(firstSunday, i * 7);
      db.sheets.push({ sheet_number: String(125 + i), status: "open", status_reason: "", closed_at: null, publication_date: publication,
        closes_at: jerusalemTime(`${addDays(publication, -2)}T00:00`), description: i === 2 ? "גיליון חג" : "", created_at: now(),
        created_via: "planned", reopened_at: null, updated_at: now() });
    }
  }
  const overviewRows = () => db.sheets.map((row) => ({
    sheet_number: row.sheet_number, publication_date: row.publication_date ?? null, closes_at: row.closes_at ?? null,
    description: row.description ?? "", status: row.status, is_closed: sheetIsClosed(row),
    closed_by_kind: row.status === "closed" ? "manual" : (row.closes_at != null && Date.parse(row.closes_at) <= serverMs() ? "deadline" : null),
    closed_at: row.closed_at ?? null, status_reason: row.status_reason ?? "", reopened_at: row.reopened_at ?? null,
    created_at: row.created_at ?? null, created_via: row.created_via ?? "status", updated_at: row.updated_at, server_now: serverIso()
  }));
  function staleError(message) { const e = new Error(message); e.code = "40001"; return e; }
  function setSheetState(p) {
    const number = (p.p_sheet_number || "").trim();
    if (!number || p.p_is_closed == null) throw "יש לבחור גיליון וסטטוס.";
    let row = db.sheets.find((s) => s.sheet_number === number);
    if (row && (p.p_expected_updated_at == null || row.updated_at !== p.p_expected_updated_at)) throw staleError("סטטוס הגיליון השתנה אצל משתמשת אחרת. רענני ונסי שוב.");
    if (!row && !db.orders.some((o) => (o.sheet_number || "").trim() === number)) throw "הגיליון לא נמצא.";
    const closed = Boolean(row) && sheetIsClosed(row);
    const newCloses = jerusalemTime(p.p_reopen_closes_at_local);
    if (p.p_is_closed) {
      if (closed) throw "הגיליון כבר סגור.";
      if (!row) { row = { sheet_number: number, publication_date: null, closes_at: null, description: "", created_at: now(), created_via: "status", reopened_at: null }; db.sheets.push(row); }
      Object.assign(row, { status: "closed", status_reason: (p.p_reason || "").trim() || "סגירת גיליון", closed_at: serverIso(), updated_at: now() });
    } else {
      if (!closed) throw "הגיליון כבר פתוח.";
      if ((p.p_reason || "").trim().length < 3) throw "נדרש הסבר קצר לפתיחה מחדש של גיליון סגור.";
      if (!newCloses && row.closes_at && Date.parse(row.closes_at) <= serverMs()) throw "מועד הסגירה של הגיליון עבר. יש לבחור מועד סגירה חדש בעתיד.";
      if (newCloses && Date.parse(newCloses) <= serverMs()) throw "מועד הסגירה החדש חייב להיות בעתיד.";
      Object.assign(row, { status: "open", status_reason: p.p_reason.trim(), closed_at: null, closes_at: newCloses || row.closes_at,
        reopened_at: serverIso(), updated_at: now() });
    }
    return { sheet_number: row.sheet_number, status: row.status, closes_at: row.closes_at, is_closed: sheetIsClosed(row), updated_at: row.updated_at };
  }
  // Stage B guard (supabase-sheets-v2-enforce.sql): only for inserts and sheet changes.
  function enforceOpenSheet(sheetNumber) {
    if (!enforce || sheetNumber == null) return;
    const row = db.sheets.find((s) => s.sheet_number === sheetNumber);
    if (!row) { const e = new Error(`גיליון ${sheetNumber} אינו קיים במערכת. יש לבחור גיליון מהרשימה.`); e.code = "23503"; throw e; }
    if (sheetIsClosed(row)) { const e = new Error(`גיליון ${sheetNumber} סגור להזמנות. יש לבחור גיליון פתוח.`); e.code = "HPS01"; throw e; }
  }
  if (sheetsV2) seedSheetsV2();

  const user = { id: "00000000-0000-4000-8000-0000000000aa" };
  const state = { session: params.get("session") === "1" ? { user } : null, approvalDelay: Number(params.get("delay") || 0), listeners: [], failNext: null, failTables: {}, rpcCalls: [] };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const emit = (event, session) => state.listeners.forEach((cb) => cb(event, session));
  const err = (message, code = "P0001") => ({ data: null, error: { message, code } });

  function tableRows(table) {
    if (table === "business_financial_totals") {
      const rows = summaryRows();
      const sum = (col) => String(r2(rows.reduce((s, r) => s + Number(r[col]), 0)));
      return [{ total_cash_billed: sum("cash_due"), total_cash_received: sum("cash_received"),
        total_cash_outstanding: sum("cash_outstanding"), total_overdue: sum("overdue_amount") }];
    }
    if (table === "business_financial_summary") return summaryRows();
    if (table === "sheet_overview") return overviewRows();
    if (table === "business_client_credit_balances") {
      return db.clients.map((c) => ({ client_id: c.id, credit_balance: String(r2(db.credit_ledger.filter((l) => l.client_id === c.id).reduce((s, l) => s + Number(l.delta), 0))) }));
    }
    return db[table];
  }

  function query(table) {
    const businessTable = !["clients", "orders"].includes(table);
    const filters = [];
    const orderBy = []; let limit = null; let range = null; let patch = null; let single = false;
    let missingColumn = null;
    const chain = {
      // Like PostgREST: asking for a column that the installed model does not have is an error (42703).
      select(columns = "") {
        const asked = String(columns).split(",").map((c) => c.trim());
        if (table === "orders" && !ordersV3) missingColumn = asked.find((c) => V3_ORDER_COLUMNS.includes(c)) || null;
        if (table === "business_payment_events" && !ordersV3) missingColumn = asked.find((c) => ["received_on", "reverses_event_id"].includes(c)) || null;
        if (table === "financial_obligations" && !ordersV3) missingColumn = asked.find((c) => ["amount_before_vat", "cancelled_at", "cancel_reason"].includes(c)) || null;
        return chain;
      },
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
        if ((businessTable && !business) || (table === "sheets" && !["1", "2"].includes(params.get("sheets")))
          || (table === "sheet_overview" && !sheetsV2)) return Promise.resolve({ data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` } }).then(resolve, reject);
        if (missingColumn) return Promise.resolve({ data: null, error: { code: "42703", message: `column ${table}.${missingColumn} does not exist` } }).then(resolve, reject);
        if (state.failTables[table] > 0) { state.failTables[table] -= 1; return Promise.resolve({ data: null, error: { message: "Failed to fetch" } }).then(resolve, reject); }
        // ?bizdelay=ms: business data tables answer late (to test loading states). business_settings is exempt:
        // app.js reads it to detect the business schema before showing the app.
        if (businessTable && table !== "business_settings" && params.get("bizdelay") && !chain.delayed) {
          chain.delayed = true;
          return wait(Number(params.get("bizdelay"))).then(() => chain.then(resolve, reject));
        }
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
    create_sheets_batch(p) {
      if (!sheetsV2) throw "Could not find the function public.create_sheets_batch";
      const list = Array.isArray(p.p_sheets) ? p.p_sheets : [];
      if (list.length < 1 || list.length > 60) throw "יש ליצור בין גיליון אחד ל-60 גיליונות בפעולה אחת.";
      const numbers = [];
      const rows = list.map((item, index) => {
        const number = String(item.sheet_number ?? "").trim();
        if (!/^[1-9][0-9]{0,8}$/.test(number)) throw `מספר הגיליון בשורה ${index + 1} אינו תקין: ספרות בלבד, מספר חיובי, ללא אפס מוביל.`;
        if (numbers.includes(number)) throw `גיליון ${number} מופיע פעמיים ברשימה.`;
        numbers.push(number);
        if (!item.publication_date) throw `חסר תאריך פרסום לגיליון ${number}.`;
        const closes = jerusalemTime(item.closes_at_local);
        if (!closes) throw `חסר מועד סגירה לגיליון ${number}.`;
        if (Date.parse(closes) >= Date.parse(endOfDayUtc(item.publication_date))) throw `מועד הסגירה של גיליון ${number} חייב להיות לפני סוף יום הפרסום.`;
        if (Date.parse(closes) <= serverMs()) throw `מועד הסגירה של גיליון ${number} כבר עבר.`;
        if (String(item.description || "").length > 200) throw `התיאור של גיליון ${number} ארוך מ-200 תווים.`;
        return { sheet_number: number, status: "open", status_reason: "", closed_at: null, publication_date: item.publication_date,
          closes_at: closes, description: String(item.description || "").trim(), created_at: now(), created_via: "planned", reopened_at: null, updated_at: now() };
      });
      const existing = numbers.filter((n) => db.sheets.some((s) => s.sheet_number === n)).sort();
      if (existing.length) { const e = new Error(`הגיליונות הבאים כבר קיימים: ${existing.join(", ")}. לא נוצר אף גיליון.`); e.code = "23505"; throw e; }
      db.sheets.push(...rows);
      return { created: numbers, count: numbers.length };
    },
    update_sheet_details(p) {
      if (!sheetsV2) throw "Could not find the function public.update_sheet_details";
      const row = db.sheets.find((s) => s.sheet_number === (p.p_sheet_number || "").trim());
      if (!row) throw "הגיליון לא נמצא.";
      if (p.p_expected_updated_at == null || row.updated_at !== p.p_expected_updated_at) throw staleError("פרטי הגיליון השתנו אצל משתמשת אחרת. רענני ונסי שוב.");
      if (String(p.p_description || "").length > 200) throw "התיאור ארוך מ-200 תווים.";
      const closes = jerusalemTime(p.p_closes_at_local);
      if (!closes && row.closes_at) throw "מועד סגירה הוא שדה חובה לגיליון זה.";
      if (closes && !p.p_publication_date) throw "יש להזין תאריך פרסום.";
      if (closes && Date.parse(closes) >= Date.parse(endOfDayUtc(p.p_publication_date))) throw "מועד הסגירה חייב להיות לפני סוף יום הפרסום.";
      if (closes !== row.closes_at && row.status !== "closed") {
        if (row.closes_at && Date.parse(row.closes_at) <= serverMs()) throw "הגיליון נסגר במועד הסגירה. כדי לשנות את המועד יש לפתוח אותו מחדש (עם סיבה).";
        if (Date.parse(closes) <= serverMs()) throw "מועד הסגירה החדש כבר עבר. לסגירה מיידית יש להשתמש ב\"סגירת הגיליון\".";
      }
      Object.assign(row, { publication_date: p.p_publication_date || null, closes_at: closes, description: String(p.p_description || "").trim(), updated_at: now() });
      return { sheet_number: row.sheet_number, updated_at: row.updated_at };
    },
    set_sheet_state(p) {
      if (!sheetsV2) throw "Could not find the function public.set_sheet_state";
      return setSheetState(p);
    },
    set_sheet_status(p) {
      if (sheetsV2) return setSheetState({ ...p, p_reopen_closes_at_local: null });
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
      if (p.p_installments.length < 1 || p.p_installments.length > 60) throw "יש להגדיר בין תשלום אחד ל-60 תשלומים.";
      const pkgId = uuid();
      const installments = p.p_installments.map((i, idx) => ({ id: uuid(), customer_package_id: pkgId, installment_number: idx + 1, due_on: i.due_on,
        amount_before_vat: String(i.amount_before_vat), vat_rate_snapshot: String(vatRate()), amount_due: String(r2(Number(i.amount_before_vat) * (1 + vatRate()))) }));
      db.customer_packages.push({ id: pkgId, client_id: p.p_client_id, package_name_snapshot: name, credits_granted: String(credits), term_months: term, price_before_vat: String(price),
        vat_rate_snapshot: String(vatRate()), gross_total: String(r2(installments.reduce((s, i) => s + Number(i.amount_due), 0))), starts_on: p.p_starts_on, ends_on: p.p_ends_on,
        installment_count: installments.length, benefits_snapshot: p.p_benefits ?? (tpl ? tpl.benefits : []), status: "active", updated_at: now() });
      db.package_installments.push(...installments);
      for (const i of installments) db.financial_obligations.push({ id: uuid(), order_id: null, package_installment_id: i.id, amount_due: i.amount_due, amount_before_vat: null, due_on: i.due_on, status: "pending", legacy_snapshot: false, updated_at: now() });
      db.credit_ledger.push({ client_id: p.p_client_id, delta: String(credits), entry_type: "package_grant", customer_package_id: pkgId, reason: "הקצאת חבילה", created_at: now() });
      return { customer_package_id: pkgId, credit_balance: balance(p.p_client_id) };
    },
    adjust_client_credits(p) {
      if (!Number(p.p_delta) || !(p.p_reason || "").trim()) throw "תנועת תיקון קרדיטים מחייבת כמות שאינה אפס והסבר.";
      db.credit_ledger.push({ client_id: p.p_client_id, delta: String(p.p_delta), entry_type: "correction", reason: p.p_reason, created_at: now() });
      return balance(p.p_client_id);
    },
    create_orders_batch(p) {
      for (const row of p.p_orders) enforceOpenSheet(row.sheet_number); // whole batch rejected, nothing written
      // Validate the whole batch first: one bad row = nothing is written (as in the database transaction).
      const lines = p.p_orders.map((row, index) => {
        const product = row.product_id ? db.product_catalog.find((x) => x.id === row.product_id && x.is_active) : null;
        if (row.product_id && !product) throw `המוצר בשורה ${index + 1} אינו קיים או אינו פעיל.`;
        if (!ordersV3 && !product) throw `המוצר בשורה ${index + 1} אינו קיים או אינו פעיל.`;
        const description = ordersV3 ? (String(row.ad_description || "").trim() || product?.name || "") : product.name;
        if (!description || description.length > 500) throw `יש להזין פירוט הזמנה בשורה ${index + 1} (עד 500 תווים).`;
        if ((row.cash_amount_before_vat == null) === (row.credits_used == null)) throw 'בכל שורה יש למלא בדיוק ערך חיובי אחד: מחיר לפני מע"מ או קרדיטים.';
        if (!String(row.sheet_number || "").trim()) throw `יש להזין מספר גיליון תקין בשורה ${index + 1}.`;
        return { row, product, description };
      });
      return lines.map(({ row, product, description }) => {
        const credits = row.credits_used != null;
        const amount = credits ? 0 : r2(Number(row.cash_amount_before_vat) * (1 + vatRate()));
        const order = { id: `o-${uuid()}`, client_id: p.p_client_id, publication_date: row.publication_date || today(), section: description.slice(0, 120), created_at: new Date().toISOString(), entered_at: today(),
          product_name_snapshot: product?.name ?? null, product_dimensions_snapshot: product?.dimensions ?? null, amount, payment_status: credits ? "paid" : row.payment_status,
          notes: row.notes || "", updated_at: now(), order_number: ++orderCounter, billing_mode: credits ? "credits" : "cash", credits_used: credits ? String(row.credits_used) : null,
          cash_amount_before_vat: credits ? null : String(row.cash_amount_before_vat), sheet_number: row.sheet_number, entered_by_name: "בודקת מערכת",
          ...(ordersV3 ? { ad_description: description, file_status: "not_received", placement_status: "not_placed", cancelled_at: null, cancel_reason: null } : {}) };
        db.orders.push(order);
        if (credits) {
          db.credit_ledger.push({ client_id: p.p_client_id, delta: String(-row.credits_used), entry_type: "order_consumption", order_id: order.id, reason: `ניצול קרדיטים בהזמנה ${order.order_number}`, created_at: now() });
          return { id: order.id, order_number: order.order_number, billing_mode: "credits", credit_balance_after: balance(p.p_client_id) };
        }
        const ob = { id: uuid(), order_id: order.id, package_installment_id: null, amount_due: String(amount), amount_before_vat: String(row.cash_amount_before_vat), due_on: row.due_on || null,
          status: order.payment_status, legacy_snapshot: false, cancelled_at: null, cancel_reason: null, received_at_cancel: null, updated_at: now() };
        db.financial_obligations.push(ob);
        if (ob.status === "paid") db.business_payment_events.push({ id: uuid(), obligation_id: ob.id, event_type: "payment", amount: String(amount), event_at: now(), received_on: today(), notes: "סומן כשולם בעת יצירת ההזמנה", reverses_event_id: null });
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
      if (ob.status === "cancelled") throw "החיוב בוטל.";
      // As in the database: marking paid records the open balance as one receipt; reopening reverses the receipts.
      const received = obligationReceived(ob);
      if (p.p_is_paid && received < Number(ob.amount_due)) db.business_payment_events.push({ id: uuid(), obligation_id: ob.id, event_type: "payment", amount: String(r2(Number(ob.amount_due) - received)), event_at: now(), received_on: today(), notes: "סומן כשולם", reverses_event_id: null });
      if (!p.p_is_paid && received > 0) {
        if (ob.legacy_snapshot && !db.business_payment_events.some((e) => e.obligation_id === ob.id)) ob.legacy_snapshot = false;
        else db.business_payment_events.push({ id: uuid(), obligation_id: ob.id, event_type: "reversal", amount: String(-received), event_at: now(), received_on: today(), notes: p.p_reason, reverses_event_id: null });
      }
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
    },

    // ===== orders v3 (mirrors supabase-orders-v3.sql) =====
    update_order_details(p) {
      needV3("update_order_details");
      const order = db.orders.find((o) => o.id === p.p_order_id);
      if (!order) throw "ההזמנה לא נמצאה.";
      if (order.updated_at !== p.p_expected_updated_at) throw staleV3("ההזמנה");
      if (order.cancelled_at) throw "ההזמנה בוטלה ואינה ניתנת לעריכה.";
      const description = String(p.p_ad_description ?? "").trim() || null;
      const sheet = String(p.p_sheet_number ?? "").trim() || null;
      if (!description && order.ad_description) throw "פירוט ההזמנה הוא שדה חובה.";
      if (description && description.length > 500) throw "פירוט ההזמנה ארוך מ-500 תווים.";
      if (p.p_notes == null || p.p_notes.length > 5000) throw "ההערה אינה תקינה.";
      if (!sheet && order.sheet_number) throw "אי אפשר להסיר את הגיליון מהזמנה; אפשר להעביר אותה לגיליון אחר.";
      if (!["unknown", "not_received", "received", "approved"].includes(p.p_file_status) || !["unknown", "not_placed", "placed", "published"].includes(p.p_placement_status)) throw "הסטטוס שנבחר אינו תקין.";
      if ((p.p_file_status === "unknown" && order.file_status !== "unknown") || (p.p_placement_status === "unknown" && order.placement_status !== "unknown")) throw 'אי אפשר להחזיר סטטוס ל"לא ידוע".';
      enforceOpenSheet(sheet !== order.sheet_number ? sheet : null);
      Object.assign(order, { ad_description: description, notes: p.p_notes, sheet_number: sheet, file_status: p.p_file_status, placement_status: p.p_placement_status, updated_at: now() });
      return { id: order.id, order_number: order.order_number, updated_at: order.updated_at };
    },
    update_order_charge(p) {
      needV3("update_order_charge");
      const order = db.orders.find((o) => o.id === p.p_order_id);
      if (!order) throw "ההזמנה לא נמצאה.";
      if (order.updated_at !== p.p_expected_updated_at) throw staleV3("ההזמנה");
      if (order.cancelled_at) throw "ההזמנה בוטלה ואינה ניתנת לעריכה.";
      const valid = (v) => v != null && Number(v) > 0 && r2(Number(v)) === Number(v);
      if (order.billing_mode === "cash") {
        if (p.p_credits_used != null) throw "הזמנה כספית אינה יכולה לקבל קרדיטים. הזמנה היא כספית או בקרדיטים, לא שניהם.";
        if (!valid(p.p_cash_amount_before_vat)) throw 'המחיר לפני מע"מ חייב להיות חיובי, עם עד שתי ספרות אחרי הנקודה.';
        const ob = db.financial_obligations.find((f) => f.order_id === order.id);
        const amount = r2(Number(p.p_cash_amount_before_vat) * (1 + Number(order.vat_rate_snapshot ?? vatRate())));
        const received = obligationReceived(ob);
        if (amount < received) throw `הסכום החדש כולל מע"מ (${amount}) נמוך מהסכום שכבר התקבל (${received}). יש לבטל תקבול לפני הורדת המחיר.`;
        Object.assign(order, { cash_amount_before_vat: String(p.p_cash_amount_before_vat), amount, updated_at: now() });
        Object.assign(ob, { amount_due: String(amount), amount_before_vat: String(p.p_cash_amount_before_vat) });
        refreshObligation(ob);
      } else if (order.billing_mode === "credits") {
        if (p.p_cash_amount_before_vat != null) throw "הזמנת קרדיטים אינה יכולה לקבל מחיר. הזמנה היא כספית או בקרדיטים, לא שניהם.";
        if (!valid(p.p_credits_used)) throw "כמות הקרדיטים חייבת להיות חיובית, עם עד שתי ספרות אחרי הנקודה.";
        const delta = r2(Number(order.credits_used) - Number(p.p_credits_used));
        if (delta) {
          db.credit_ledger.push({ client_id: order.client_id, delta: String(delta), entry_type: "order_adjustment", order_id: order.id, reason: `עדכון קרדיטים בהזמנה ${order.order_number}`, created_at: now() });
          Object.assign(order, { credits_used: String(p.p_credits_used), updated_at: now() });
        }
      } else throw 'בהזמנה ישנה לא ידוע אם הסכום כולל מע"מ, ולכן אי אפשר לשנות את החיוב שלה כאן.';
      return { id: order.id, order_number: order.order_number, amount: order.amount, credits_used: order.credits_used, updated_at: order.updated_at };
    },
    cancel_business_order(p) {
      needV3("cancel_business_order");
      const reason = String(p.p_reason || "").trim();
      if (reason.length < 3 || reason.length > 500) throw "נדרשת סיבת ביטול (3 עד 500 תווים).";
      const order = db.orders.find((o) => o.id === p.p_order_id);
      if (!order) throw "ההזמנה לא נמצאה.";
      if (order.cancelled_at) return { id: order.id, order_number: order.order_number, already_cancelled: true, credits_returned: 0, cash_received_kept: 0, updated_at: order.updated_at };
      if (order.updated_at !== p.p_expected_updated_at) throw staleV3("ההזמנה");
      let returned = 0; let kept = 0;
      if (order.billing_mode === "credits") {
        const consumed = -r2(db.credit_ledger.filter((l) => l.order_id === order.id && ["order_consumption", "order_adjustment", "order_cancellation"].includes(l.entry_type)).reduce((s, l) => s + Number(l.delta), 0));
        if (db.credit_ledger.some((l) => l.order_id === order.id && l.entry_type === "order_cancellation")) { const e = new Error("duplicate key value violates unique constraint \"credit_ledger_one_cancellation_per_order_uidx\""); e.code = "23505"; throw e; }
        if (consumed > 0) { db.credit_ledger.push({ client_id: order.client_id, delta: String(consumed), entry_type: "order_cancellation", order_id: order.id, reason: `החזרת קרדיטים בביטול הזמנה ${order.order_number}: ${reason}`, created_at: now() }); returned = consumed; }
      } else {
        const ob = db.financial_obligations.find((f) => f.order_id === order.id);
        if (ob && ob.status !== "cancelled") { kept = obligationReceived(ob); Object.assign(ob, { status: "cancelled", cancelled_at: now(), cancel_reason: reason, received_at_cancel: String(kept), updated_at: now() }); }
      }
      Object.assign(order, { cancelled_at: now(), cancel_reason: reason, updated_at: now() });
      return { id: order.id, order_number: order.order_number, already_cancelled: false, credits_returned: returned, cash_received_kept: kept, updated_at: order.updated_at };
    },
    record_obligation_payment(p) {
      needV3("record_obligation_payment");
      const amount = Number(p.p_amount);
      if (!(amount > 0) || r2(amount) !== amount) throw "סכום התקבול חייב להיות חיובי, עם עד שתי ספרות אחרי הנקודה.";
      if (!p.p_received_on) throw "תאריך התקבול אינו תקין.";
      const ob = db.financial_obligations.find((f) => f.id === p.p_obligation_id);
      if (!ob) throw "החיוב לא נמצא.";
      if (ob.updated_at !== p.p_expected_updated_at) throw staleV3("החיוב");
      if (ob.status === "cancelled") throw "החיוב בוטל; אי אפשר לרשום עליו תקבול.";
      const outstanding = r2(Number(ob.amount_due) - obligationReceived(ob));
      if (outstanding <= 0) throw "החיוב כבר שולם במלואו.";
      if (amount > outstanding) throw `הסכום גבוה מהיתרה לתשלום (${outstanding} ש"ח). גבייה מעבר לחיוב אינה נרשמת כאן.`;
      db.business_payment_events.push({ id: uuid(), obligation_id: ob.id, event_type: "payment", amount: String(amount), event_at: now(), received_on: p.p_received_on, notes: String(p.p_notes || "").trim(), reverses_event_id: null });
      const status = refreshObligation(ob);
      const received = obligationReceived(ob);
      return { obligation_id: ob.id, status, received, outstanding: Math.max(r2(Number(ob.amount_due) - received), 0), updated_at: ob.updated_at };
    },
    reverse_obligation_payment(p) {
      needV3("reverse_obligation_payment");
      const reason = String(p.p_reason || "").trim();
      if (reason.length < 3) throw "נדרשת סיבה לביטול התקבול (3 עד 500 תווים).";
      const event = db.business_payment_events.find((e) => e.id === p.p_event_id && e.event_type === "payment");
      if (!event) throw "התקבול לא נמצא.";
      if (db.business_payment_events.some((e) => e.reverses_event_id === event.id)) throw "התקבול הזה כבר בוטל.";
      db.business_payment_events.push({ id: uuid(), obligation_id: event.obligation_id, event_type: "reversal", amount: String(-Number(event.amount)), event_at: now(), received_on: today(), notes: reason, reverses_event_id: event.id });
      const ob = db.financial_obligations.find((f) => f.id === event.obligation_id);
      const status = refreshObligation(ob); ob.updated_at = now();
      return { obligation_id: ob.id, status, received: obligationReceived(ob), updated_at: ob.updated_at };
    },
    update_installment_schedule(p) {
      needV3("update_installment_schedule");
      const pkg = db.customer_packages.find((x) => x.id === p.p_customer_package_id);
      if (!pkg) throw "החבילה לא נמצאה.";
      if (pkg.updated_at !== p.p_expected_updated_at) throw staleV3("החבילה");
      const reason = String(p.p_reason || "").trim();
      if (reason.length < 3) throw "נדרשת סיבה לשינוי לוח התשלומים (3 עד 500 תווים).";
      const items = Array.isArray(p.p_items) ? p.p_items : [];
      if (items.length < 1 || items.length > 60) throw "לוח התשלומים צריך לכלול בין תשלום אחד ל-60 תשלומים.";
      const vat = Number(pkg.vat_rate_snapshot ?? vatRate());
      const installments = db.package_installments.filter((i) => i.customer_package_id === pkg.id);
      const active = db.financial_obligations.filter((f) => installments.some((i) => i.id === f.package_installment_id) && f.status !== "cancelled");
      const netOf = (ob) => Number(ob.amount_before_vat ?? installments.find((i) => i.id === ob.package_installment_id).amount_before_vat);
      let sum = 0; const seen = new Set();
      items.forEach((item, index) => {
        const net = Number(item.amount_before_vat);
        if (!item.due_on || !(net > 0) || r2(net) !== net) throw `תשלום ${index + 1} אינו תקין: נדרשים מועד וסכום חיובי לפני מע"מ.`;
        if (item.obligation_id) { if (seen.has(item.obligation_id)) throw `תשלום ${index + 1} מופיע פעמיים.`; seen.add(item.obligation_id); if (!active.some((f) => f.id === item.obligation_id)) throw `תשלום ${index + 1} אינו שייך לחבילה הזו.`; }
        sum = r2(sum + net);
      });
      if (sum !== Number(pkg.price_before_vat)) throw `סכום התשלומים לפני מע"מ (${sum}) חייב להיות שווה למחיר החבילה (${Number(pkg.price_before_vat)}).`;
      for (const ob of active) {
        const received = obligationReceived(ob);
        const item = items.find((x) => x.obligation_id === ob.id);
        if (!item) { if (received > 0) throw `אי אפשר להסיר תשלום שכבר התקבל עליו כסף (${received} ש"ח).`; Object.assign(ob, { status: "cancelled", cancelled_at: now(), cancel_reason: `שינוי לוח תשלומים: ${reason}`, received_at_cancel: "0", updated_at: now() }); continue; }
        const net = Number(item.amount_before_vat); const grossAmount = r2(net * (1 + vat));
        if (ob.status === "paid") { if (net !== netOf(ob) || item.due_on !== ob.due_on) throw "תשלום שהתקבל במלואו אינו ניתן לשינוי."; continue; }
        if (grossAmount < received) throw `סכום התשלום כולל מע"מ (${grossAmount}) נמוך מהסכום שכבר התקבל עליו (${received}).`;
        if (net !== netOf(ob) || item.due_on !== ob.due_on) { Object.assign(ob, { amount_due: String(grossAmount), amount_before_vat: String(net), due_on: item.due_on, updated_at: now() }); refreshObligation(ob); }
      }
      let next = Math.max(0, ...installments.map((i) => i.installment_number));
      for (const item of items.filter((x) => !x.obligation_id)) {
        const net = Number(item.amount_before_vat);
        const inst = { id: uuid(), customer_package_id: pkg.id, installment_number: ++next, due_on: item.due_on, amount_before_vat: String(net), vat_rate_snapshot: String(vat), amount_due: String(r2(net * (1 + vat))) };
        db.package_installments.push(inst);
        db.financial_obligations.push({ id: uuid(), order_id: null, package_installment_id: inst.id, amount_due: inst.amount_due, amount_before_vat: String(net), due_on: item.due_on, status: "pending", legacy_snapshot: false, updated_at: now() });
      }
      const now_active = db.financial_obligations.filter((f) => db.package_installments.some((i) => i.customer_package_id === pkg.id && i.id === f.package_installment_id) && f.status !== "cancelled");
      Object.assign(pkg, { installment_count: now_active.length, gross_total: String(r2(now_active.reduce((s, f) => s + Number(f.amount_due), 0))), updated_at: now() });
      return { customer_package_id: pkg.id, installment_count: pkg.installment_count, gross_total: pkg.gross_total, updated_at: pkg.updated_at };
    }
  };

  // ?demo=1 (with sheets=2): a believable newspaper for the local preview only — published sheets with dates,
  // historical sheets without a date, the sheet of the week with several orders (one client with two), a future
  // sheet with orders and empty ones. Fake data only; the tests do not use it.
  if (sheetsV2 && params.get("demo") === "1") {
    db.product_catalog.push(
      { id: "55555555-5555-4555-8555-555555555555", name: "הדגמה — רבע עמוד", dimensions: "9.5×13 ס״מ", base_price_before_vat: "420.00", credit_cost: "2.00", is_active: true },
      { id: "66666666-6666-4666-8666-666666666666", name: "הדגמה — חצי עמוד", dimensions: "19.5×13 ס״מ", base_price_before_vat: "780.00", credit_cost: "4.00", is_active: true },
      { id: "77777777-7777-4777-8777-777777777777", name: "הדגמה — מודעת לוח", dimensions: "עד 4 שורות", base_price_before_vat: "90.00", credit_cost: "0.50", is_active: true });
    const firstSunday = db.sheets.find((s) => s.sheet_number === "125").publication_date;
    const published = (number, weeksAgo) => {
      const publication = addDays(firstSunday, -7 * weeksAgo);
      return { sheet_number: number, status: "open", status_reason: "", closed_at: null, publication_date: publication,
        closes_at: jerusalemTime(`${addDays(publication, -2)}T00:00`), description: "", created_at: now(), created_via: "planned", reopened_at: null, updated_at: now() };
    };
    const historical = (number) => ({ sheet_number: number, status: "closed", status_reason: "גיליון היסטורי — סומן כסגור במעבר למודל הגיליונות",
      closed_at: now(), publication_date: null, closes_at: null, description: "", created_at: now(), created_via: "backfill", reopened_at: null, updated_at: now() });
    Object.assign(db.sheets.find((s) => s.sheet_number === "124"), published("124", 1));
    db.sheets.push(published("123", 2), published("122", 3), historical("121"), historical("120"));
    const Q = "55555555-5555-4555-8555-555555555555", H = "66666666-6666-4666-8666-666666666666", L = "77777777-7777-4777-8777-777777777777";
    const line = (sheet, product, cash, credits, paid, notes = "") => ({ sheet_number: sheet, product_id: product,
      publication_date: db.sheets.find((s) => s.sheet_number === sheet).publication_date || "2026-10-01",
      cash_amount_before_vat: cash, credits_used: credits, payment_status: paid ? "paid" : "pending", due_on: null, notes });
    const seedOrders = [
      ["c-test-1", [line("125", Q, 420, null, true, "טקסט כמו בשבוע שעבר, תמונה חדשה"), line("125", L, 90, null, false, "מודעת דרושים — 3 שורות")]],
      ["c-test-2", [line("125", H, 780, null, false, "מבצע סוף עונה, לוגו מצורף במייל")]],
      ["c-test-4", [line("125", Q, null, 2, true)]],
      ["c-test-5", [line("125", Q, 420, null, true)]],
      ["c-test-7", [line("125", L, 90, null, false, "דירה להשכרה במרכז")]],
      ["c-test-8", [line("126", H, 780, null, false, "פרסום לקראת חנוכה")]],
      ["c-test-9", [line("126", Q, 420, null, true)]],
      ["c-test-3", [line("123", H, 780, null, true), line("122", Q, 420, null, true)]],
      ["c-test-6", [line("123", Q, 420, null, false, "התשלום יועבר בסוף החודש")]],
      ["c-test-10", [line("123", L, 90, null, true), line("122", L, 90, null, true)]],
      ["c-test-11", [line("121", Q, 420, null, true), line("120", H, 780, null, false)]]
    ];
    for (const [clientId, orders] of seedOrders) rpcs.create_orders_batch({ p_client_id: clientId, p_orders: orders });
  }

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
    // Server clock control for deadline tests (sheets v2). setNow(iso) / advance(ms).
    setNow(iso) { clockOffset = Date.parse(iso) - Date.now(); },
    advance(ms) { clockOffset += ms; },
    serverNow: () => serverIso(),
    jerusalemTime,
    // The next `times` reads of `table` fail like a dropped network request.
    failTable(table, times = 1) { state.failTables[table] = times; },
    get signInCalls() { return state.signInCalls || 0; }
  };
  window.supabase = { createClient: () => client };

  // ?bannerdraft=1 — local design review only: shows the owner's generated concept (a draft, not an approved asset,
  // kept git-ignored in design-references/inspiration/) in the sheets banner's photo area. Never part of the site.
  if (params.get("bannerdraft") === "1") {
    window.addEventListener("DOMContentLoaded", () => {
      const css = [...document.styleSheets].find((sheet) => (sheet.href || "").includes("styles.css"));
      css?.insertRule('.sheets-banner-photo { background-image: url("/design-references/inspiration/zip-2026-11-19/generated-concept/concept-newspapers.png"); }', css.cssRules.length);
    });
  }
})();
