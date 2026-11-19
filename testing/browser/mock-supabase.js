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
      const t = today();
      const open = db.financial_obligations.filter((o) => o.status !== "paid");
      const sum = (rows) => r2(rows.reduce((s, o) => s + Number(o.amount_due), 0));
      return [{ total_cash_billed: sum(db.financial_obligations), total_cash_received: sum(db.financial_obligations.filter((o) => o.status === "paid")),
        total_cash_outstanding: sum(open), total_overdue: sum(open.filter((o) => o.due_on && o.due_on < t)) }];
    }
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
        if ((businessTable && !business) || (table === "sheets" && !["1", "2"].includes(params.get("sheets")))
          || (table === "sheet_overview" && !sheetsV2)) return Promise.resolve({ data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` } }).then(resolve, reject);
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
      for (const row of p.p_orders) enforceOpenSheet(row.sheet_number); // whole batch rejected, nothing written
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
