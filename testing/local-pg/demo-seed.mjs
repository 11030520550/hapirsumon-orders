// DEMO DATA ONLY: fictional businesses, fictional people, fictional numbers. No real customer is copied.
// About 16 weeks of activity are replayed as a timeline of business events. While an event runs, the database
// clock is set to that moment (PGlite reads JavaScript's Date.now), so every row gets the date it would really
// have: orders are entered before their sheet closes, receipts are dated when the money came in, installments
// fall due month by month, sheets are published on Sundays. Everything goes through the same business functions
// the screens use (create_orders_batch, record_obligation_payment, purchase_customer_package, ...), as the
// staff accounts, so all totals are consistent by construction. Products and prices follow the public price list
// (reference/מחירון 2.6.pdf). Credit amounts per ad are illustrative demo values: the business has not defined them.
import { caller } from "./local-db.mjs";

const CLIENTS = [
  ["מאפיית בית הלחם", "בית מאפה", "050-555-0101"], ["פרחי השדה", "חנות פרחים", "050-555-0102"],
  ["מוסך האחים לוי", "מוסך", "050-555-0103"], ["סטודיו נועם לעיצוב", "סטודיו לעיצוב", "050-555-0104"],
  ["משרד עו״ד כהן ושות׳", "משרד עורכי דין", "050-555-0105"], ["פיצה על האש", "פיצרייה", "050-555-0106"],
  ["אופטיקה מבט", "אופטיקה", "050-555-0107"], ["גני ילדים פרפר", "גן ילדים", "050-555-0108"],
  ["חומרי בניין הצפון", "חומרי בניין", "050-555-0109"], ["קליניקת שן בריאה", "מרפאת שיניים", "050-555-0110"],
  ["ספריית הדף", "חנות ספרים", "050-555-0111"], ["נדל״ן ביתא", "משרד תיווך", "050-555-0112"],
  ["קפה פינה", "בית קפה", "050-555-0113"], ["חשמלאי אור", "חשמלאי", "050-555-0114"],
  ["חוג דרמה במה", "חוג לילדים", "050-555-0115"], ["מכון כושר אנרגיה", "מכון כושר", "050-555-0116"],
  ["קצביית השוק", "קצבייה", "050-555-0117"], ["רהיטי עץ ואבן", "חנות רהיטים", "050-555-0118"],
  ["מתנות ופיצוחים", "חנות מתנות", "050-555-0119"], ["הסעות הגליל", "חברת הסעות", "050-555-0120"],
  ["רואה חשבון מספרים", "משרד רואה חשבון", "050-555-0121"], ["נגריית הכרמל", "נגרייה", "050-555-0122"],
  ["בית אבות נווה שלום", "בית אבות", "050-555-0123"], ["סלון יופי ורד", "סלון יופי", "050-555-0124"],
  ["אינסטלציה זרם", "אינסטלטור", "050-555-0125"], ["מרכול השכונה", "מכולת", "050-555-0126"],
  ["צילום רגעים", "סטודיו לצילום", "050-555-0127"], ["בית ספר לנהיגה ירוק", "בית ספר לנהיגה", "050-555-0128"],
  ["וטרינר חברים", "מרפאה וטרינרית", "050-555-0129"], ["עמותת יד לקהילה", "עמותה", "050-555-0130"]
].map(([name, kind, phone], i) => ({ id: `c-demo-${String(i + 1).padStart(2, "0")}`, name, kind, phone }));

// From the public price list (prices before VAT).
const PRODUCTS = [
  ["שער", "118×185 מ״מ", 590, 4], ["גב", "240×165 מ״מ", 590, 4], ["קובייה עליונה", "70×43 מ״מ", 179, 1],
  ["קובייה", "36×43 מ״מ", 85, 0.5], ["דאבל", "220×318 מ״מ", 790, 6], ["עמוד שלם", "220×153 מ״מ", 435, 3],
  ["עמוד 3", "220×153 מ״מ", 485, 3], ["חצי עמוד רוחב", "107×153 מ״מ", 249, 2], ["חצי עמוד אורך", "220×76 מ״מ", 249, 2],
  ["רבע עמוד", "100×77 מ״מ", 149, 1], ["רבע עמוד סטריפ", "53×153 מ״מ", 149, 1], ["שמינית עמוד", "100×35 מ״מ", 79, 0.5]
].map(([name, dimensions, price, credits]) => ({ name, dimensions, price, credits }));
const TOPICS = ["מבצע סוף עונה", "פתיחת סניף", "חג שמח ללקוחות", "מבצע השבוע", "הנחה לתושבי היישוב", "שעות פתיחה חדשות",
  "גיוס עובדים", "הרשמה לשנה החדשה", "מוצר חדש", "שבוע ללא מע״מ", "ערב לקוחות", "תודה ללקוחות"];

// Deterministic randomness: the same demo every time it is rebuilt.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// Wall time in Israel → UTC milliseconds (summer/winter time handled through Intl).
const jlmFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function jlmParts(ms) { const p = Object.fromEntries(jlmFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); }
function jlm(dateIso, hour = 9, minute = 0) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  let guess = wanted - 2 * 3600000;
  guess += wanted - jlmParts(guess);
  return guess;
}
const jlmDate = (ms) => new Date(jlmParts(ms)).toISOString().slice(0, 10);
const addDays = (dateIso, n) => iso(Date.parse(`${dateIso}T12:00:00Z`) + n * DAY);

export async function seedDemo(pg, { onPhase = () => {} } = {}) {
  const realNow = Date.now;
  const now = realNow();
  const r = rng(20261124);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const chance = (p) => r() < p;
  const between = (a, b) => a + r() * (b - a);
  let clock = now;
  Date.now = () => clock;
  const staff = caller(pg, "staff@local.test");
  const sales = caller(pg, "second@local.test");
  const sql = async (text, args = []) => (await pg.query(text, args)).rows;
  const version = async (table, id) => (await sql(`select updated_at::text as v from public.${table} where id = $1`, [id]))[0].v;
  const key = () => crypto.randomUUID();
  const stats = { orders: 0, cancelled: 0, payments: 0, reversals: 0, packages: 0, skipped: 0 };

  // ----- the event timeline -----
  const queue = [];
  const at = (ms, label, fn) => { if (ms <= now - 60000) queue.push({ ms, label, fn, seq: queue.length }); };
  try {
    // Clients and the product catalog exist from the start (set up before the period shown).
    clock = now - 140 * DAY;
    await pg.exec(`insert into public.product_catalog (name, dimensions, base_price_before_vat, credit_cost, is_active) values ${PRODUCTS.map((p) =>
      `('${p.name}', '${p.dimensions}', ${p.price}, ${p.credits}, true)`).join(", ")};`);
    // Same columns the client form writes; the join date is the day the client was entered (clock moved there).
    for (const c of CLIENTS) {
      clock = now - (140 + r() * 400) * DAY;
      await pg.transaction(async (tx) => {
        await tx.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true)");
        await tx.query("insert into public.clients (id, name, phone, email) values ($1, $2, $3, null)", [c.id, c.name, c.phone]);
      });
    }

    // Sheets: published every Sunday; closing for orders Friday 00:00 (the default rule). 16 weeks back, 6 ahead.
    const todayIso = jlmDate(now);
    const weekday = new Date(`${todayIso}T12:00:00Z`).getUTCDay();
    const thisSunday = addDays(todayIso, -weekday);
    const sheets = [];
    for (let w = -16; w <= 6; w += 1) {
      const publication = addDays(thisSunday, w * 7);
      sheets.push({ number: String(497 + w), publication, closes: jlm(addDays(publication, -2), 0, 0), pub: jlm(publication, 7, 0) });
    }
    const byNumber = new Map(sheets.map((s) => [s.number, s]));
    // Sheets are planned about four weeks ahead, in batches, as the office does.
    for (let i = 0; i < sheets.length; i += 4) {
      const batch = sheets.slice(i, i + 4);
      const when = Math.min(batch[0].closes - 26 * DAY, now - 3 * DAY);
      at(when, "plan sheets", async () => {
        await staff("create_sheets_batch", { p_sheets: batch.map((s) => ({ sheet_number: s.number, publication_date: s.publication,
          closes_at_local: `${addDays(s.publication, -2)}T00:00`, description: s.number === String(497 + 3) ? "גיליון חג" : "" })), p_idempotency_key: key() });
      });
    }
    // A holiday week without an edition: closed by hand ahead of time.
    const holiday = byNumber.get(String(497 + 5));
    at(now - 2 * DAY, "close holiday sheet", async () => {
      const v = (await sql("select updated_at::text as v from public.sheets where sheet_number = $1", [holiday.number]))[0].v;
      await staff("set_sheet_state", { p_sheet_number: holiday.number, p_is_closed: true, p_reason: "חופשת חג — אין גיליון השבוע", p_reopen_closes_at_local: null, p_expected_updated_at: v });
    });

    // Packages: separate purchases per client; credits at once; flexible installments.
    const templates = Object.fromEntries((await sql("select package_code, id, credits::float as credits, total_price_before_vat::float as price, default_installment_count as n from public.package_catalog where is_active")).map((t) => [t.package_code, t]));
    const PACKAGE_PLAN = [
      { client: "c-demo-01", code: "minimum-maximum", weeksAgo: 15, payer: "good" },
      { client: "c-demo-04", code: "leading-brand", weeksAgo: 14, payer: "good" },
      { client: "c-demo-07", code: "minimum-maximum", weeksAgo: 12, payer: "late" },
      { client: "c-demo-10", code: "winning-ad", weeksAgo: 11, payer: "good" },
      { client: "c-demo-12", code: "leading-brand", weeksAgo: 9, payer: "partial" },
      { client: "c-demo-16", code: "minimum-maximum", weeksAgo: 7, payer: "good" },
      { client: "c-demo-01", code: "custom", weeksAgo: 3, payer: "good" },
      { client: "c-demo-21", code: "custom-6", weeksAgo: 5, payer: "stopped" }
    ];
    const packageClients = new Set(PACKAGE_PLAN.map((p) => p.client));
    for (const plan of PACKAGE_PLAN) {
      const when = jlm(addDays(thisSunday, -plan.weeksAgo * 7 + 2), 11, 30);
      at(when, `package ${plan.client}`, async () => {
        const start = jlmDate(clock);
        const custom = plan.code.startsWith("custom");
        const tpl = templates[plan.code];
        const price = custom ? (plan.code === "custom-6" ? 1500 : 1200) : tpl.price;
        const count = custom ? (plan.code === "custom-6" ? 6 : 4) : tpl.n;
        const cents = Math.round(price * 100), each = Math.floor(cents / count);
        // Monthly from the purchase date; the first installment is a little larger when the client asked for it.
        const installments = Array.from({ length: count }, (_, i) => ({ due_on: addDays(start, i * 30), amount_before_vat: (i === count - 1 ? cents - each * (count - 1) : each) / 100 }));
        const term = custom ? (plan.code === "custom-6" ? 6 : 4) : null;
        const ends = addDays(start, (custom ? term : 12) * 30);
        const result = await sales("purchase_customer_package", { p_client_id: plan.client, p_package_id: custom ? null : tpl.id,
          p_custom_name: custom ? (plan.code === "custom-6" ? "חבילת פתיחה מותאמת" : "חבילת חגים") : null,
          p_credits: custom ? (plan.code === "custom-6" ? 24 : 20) : null, p_term_months: term, p_price_before_vat: custom ? price : null,
          p_starts_on: start, p_ends_on: ends, p_installments: installments, p_benefits: custom ? [] : null, p_notes: "", p_idempotency_key: key() });
        stats.packages += 1;
        const obligations = await sql(`select f.id, f.due_on::text as due, f.amount_due::float as due_amount from public.financial_obligations f
          join public.package_installments i on i.id = f.package_installment_id where i.customer_package_id = $1 order by f.due_on`, [result.customer_package_id || result.id]);
        obligations.forEach((ob, i) => {
          const due = jlm(ob.due, 10, 0);
          if (plan.payer === "good") at(due + between(-2, 4) * DAY, "installment", () => pay(ob.id, ob.due_amount));
          else if (plan.payer === "late") { if (i < 2) at(due + between(12, 20) * DAY, "late installment", () => pay(ob.id, ob.due_amount)); }
          else if (plan.payer === "partial") {
            if (i === 1) at(due + 3 * DAY, "partial installment", () => pay(ob.id, Math.round(ob.due_amount * 0.5)));
            else at(due + between(0, 5) * DAY, "installment", () => pay(ob.id, ob.due_amount));
          } else if (plan.payer === "stopped") { if (i === 0) at(due + DAY, "installment", () => pay(ob.id, ob.due_amount)); }
        });
        if (plan.client === "c-demo-10") {
          // The client asked to move the third installment by two weeks (schedule edit after purchase).
          at(clock + 20 * DAY, "schedule edit", async () => {
            const pkgId = result.customer_package_id || result.id;
            const rows = await sql(`select f.id as obligation_id, f.due_on::text as due_on, coalesce(f.amount_before_vat, i.amount_before_vat)::float as amount_before_vat, f.status
              from public.financial_obligations f join public.package_installments i on i.id = f.package_installment_id where i.customer_package_id = $1 and f.status <> 'cancelled' order by f.due_on`, [pkgId]);
            const items = rows.map((x, i) => ({ obligation_id: x.obligation_id, due_on: i === 2 ? addDays(x.due_on, 14) : x.due_on, amount_before_vat: x.amount_before_vat }));
            await staff("update_installment_schedule", { p_customer_package_id: pkgId, p_expected_updated_at: await version("customer_packages", pkgId), p_items: items, p_reason: "הלקוח ביקש לדחות תשלום אחד בשבועיים", p_idempotency_key: key() });
          });
        }
      });
    }

    async function pay(obligationId, amount, note = "") {
      const ob = (await sql("select updated_at::text as v, status, amount_due::float as due from public.financial_obligations where id = $1", [obligationId]))[0];
      if (!ob || ob.status !== "pending") return;
      const received = (await sql("select coalesce(sum(amount), 0)::float as r from public.business_payment_events where obligation_id = $1", [obligationId]))[0].r;
      const value = Math.min(amount, Math.round((ob.due - received) * 100) / 100);
      if (!(value > 0)) return;
      await staff("record_obligation_payment", { p_obligation_id: obligationId, p_amount: value, p_received_on: jlmDate(clock), p_notes: note, p_expected_updated_at: ob.v, p_idempotency_key: key() });
      stats.payments += 1;
    }

    // Orders: each sheet gets its ads entered during the two to three weeks before it closes.
    const weights = CLIENTS.map((c, i) => (packageClients.has(c.id) ? 3 : i % 5 === 0 ? 2.5 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    const pickClient = () => { let x = r() * total; for (let i = 0; i < CLIENTS.length; i += 1) { x -= weights[i]; if (x <= 0) return CLIENTS[i]; } return CLIENTS[0]; };
    const creditOnly = new Set(["c-demo-13", "c-demo-25"]); // clients who use credits without a package (negative balance)
    const cancelPlan = new Set();
    sheets.forEach((sheet, index) => {
      const count = 4 + Math.floor(r() * 4) + (index % 4 === 0 ? 2 : 0);
      for (let k = 0; k < count; k += 1) {
        const client = pickClient();
        const product = pick(PRODUCTS);
        const topic = pick(TOPICS);
        const daysBefore = between(1.5, 20);
        const day = jlmDate(sheet.closes - daysBefore * DAY);
        let when = jlm(day, 9 + Math.floor(r() * 8), Math.floor(r() * 60));
        if (when >= sheet.closes - 3600000) when = sheet.closes - 5 * 3600000;
        const credits = (packageClients.has(client.id) && chance(0.8)) || (creditOnly.has(client.id) && chance(0.7));
        const discount = !credits && chance(0.2) ? 0.9 : 1;
        const net = Math.round(product.price * discount * 100) / 100;
        const paidNow = !credits && chance(0.3);
        const terms = chance(0.15) ? null : chance(0.65) ? 30 : 14;
        const enteredBy = chance(0.65) ? staff : sales;
        const cancel = (index + k) % 23 === 7;
        at(when, `order ${sheet.number}`, async () => {
          if (Date.now() >= sheet.closes || (await sql("select is_closed from public.sheet_overview where sheet_number = $1", [sheet.number]))[0]?.is_closed) { stats.skipped += 1; return; }
          const orderDay = jlmDate(clock);
          const [row] = await enteredBy("create_orders_batch", { p_client_id: client.id, p_orders: [{
            sheet_number: sheet.number, ad_description: `${product.name} — ${topic}`,
            ...(credits ? { credits_used: product.credits } : { cash_amount_before_vat: net, payment_status: paidNow ? "paid" : "pending", due_on: terms ? addDays(orderDay, terms) : null }),
            notes: chance(0.12) ? pick(["הלקוח ישלח קובץ במייל", "לשים ליד מודעת הקהילה", "צבעוני", "לבדוק איות שם העסק"]) : ""
          }], p_idempotency_key: key() });
          stats.orders += 1;
          const orderId = row.id;
          // Production steps: file arrives, is approved, the ad is placed before closing and published on Sunday.
          const received = clock + between(0.1, 4) * DAY;
          const approved = received + between(0.1, 1.5) * DAY;
          const placed = sheet.closes - between(0.5, 1.5) * DAY;
          // A sheet already published went through every step; for the coming sheets some files are still missing.
          const published = sheet.pub <= now;
          if (published || chance(0.92)) at(received, "file received", () => setStatus(orderId, { file: "received" }));
          if (published || chance(0.88)) at(Math.max(approved, received + 3600000), "file approved", () => setStatus(orderId, { file: "approved" }));
          at(Math.max(placed, approved + 3600000), "placed", () => setStatus(orderId, { placement: "placed", needFile: "approved" }));
          at(sheet.pub + between(0, 3) * 3600000, "published", () => setStatus(orderId, { placement: "published", needPlacement: "placed" }));
          if (cancel) { cancelPlan.add(orderId); at(clock + between(0.5, 3) * DAY, "cancel", () => cancelOrder(orderId)); }
          if (!credits && !paidNow) {
            const due = terms ? jlm(addDays(orderDay, terms), 10, 0) : clock + 30 * DAY;
            const roll = r();
            if (roll < 0.55) at(clock + between(2, terms ? terms + 12 : 35) * DAY, "payment", () => payOrder(orderId, 1));
            else if (roll < 0.72) {
              at(clock + between(3, 12) * DAY, "partial payment", () => payOrder(orderId, 0.4 + r() * 0.2));
              if (chance(0.5)) at(due + between(5, 25) * DAY, "rest of payment", () => payOrder(orderId, 1));
            }
          }
        });
      }
    });

    async function setStatus(orderId, { file, placement, needFile, needPlacement }) {
      const o = (await sql("select updated_at::text as v, ad_description, notes, sheet_number, file_status, placement_status, cancelled_at from public.orders where id = $1", [orderId]))[0];
      if (!o || o.cancelled_at) return;
      if (needFile && o.file_status !== needFile) return;
      if (needPlacement && o.placement_status !== needPlacement) return;
      const nextFile = file || o.file_status;
      const nextPlacement = placement || o.placement_status;
      if (nextFile === o.file_status && nextPlacement === o.placement_status) return;
      await staff("update_order_details", { p_order_id: orderId, p_expected_updated_at: o.v, p_ad_description: o.ad_description, p_notes: o.notes,
        p_sheet_number: o.sheet_number, p_file_status: nextFile, p_placement_status: nextPlacement, p_idempotency_key: key() });
    }
    async function payOrder(orderId, share) {
      const ob = (await sql("select f.id, f.amount_due::float as due from public.financial_obligations f join public.orders o on o.id = f.order_id where o.id = $1 and o.cancelled_at is null", [orderId]))[0];
      if (!ob) return;
      await pay(ob.id, Math.round(ob.due * share * 100) / 100);
    }
    async function cancelOrder(orderId) {
      const o = (await sql("select updated_at::text as v, cancelled_at from public.orders where id = $1", [orderId]))[0];
      if (!o || o.cancelled_at) return;
      await staff("cancel_business_order", { p_order_id: orderId, p_expected_updated_at: o.v, p_reason: pick(["הלקוח ביטל את הפרסום", "כפילות בהזנה", "העסק נסגר לשיפוצים", "הלקוח עבר לגיליון אחר"]), p_idempotency_key: key() });
      stats.cancelled += 1;
    }

    // Manual credit movements, with reasons.
    at(now - 40 * DAY, "credit gift", () => staff("adjust_client_credits", { p_client_id: "c-demo-04", p_delta: 2, p_reason: "מתנה על חידוש החבילה", p_idempotency_key: key() }));
    at(now - 18 * DAY, "credit correction", () => staff("adjust_client_credits", { p_client_id: "c-demo-16", p_delta: -1, p_reason: "תיקון: מודעה נרשמה פעמיים", p_idempotency_key: key() }));

    // A bounced cheque: the receipt is reversed (documented), the client pays again later.
    at(now - 25 * DAY, "bounced cheque", async () => {
      const ev = (await sql(`select e.id, e.obligation_id from public.business_payment_events e join public.financial_obligations f on f.id = e.obligation_id
        where e.event_type = 'payment' and f.order_id is not null and e.amount > 300 and not exists (select 1 from public.business_payment_events x where x.reverses_event_id = e.id)
        order by e.event_at desc limit 1`))[0];
      if (!ev) return;
      await staff("reverse_obligation_payment", { p_event_id: ev.id, p_reason: "צ׳ק חזר מהבנק", p_idempotency_key: key() });
      stats.reversals += 1;
      at(clock + 9 * DAY, "paid again", async () => {
        const ob = (await sql("select amount_due::float as due from public.financial_obligations where id = $1", [ev.obligation_id]))[0];
        await pay(ev.obligation_id, ob.due, "הועבר בהעברה בנקאית אחרי הצ׳ק שחזר");
      });
    });

    // ----- run the timeline in time order -----
    const done = new Set();
    let processed = 0;
    for (;;) {
      queue.sort((a, b) => a.ms - b.ms || a.seq - b.seq);
      const next = queue.find((e) => !done.has(e));
      if (!next) break;
      done.add(next);
      clock = Math.max(next.ms, now - 150 * DAY);
      try { await next.fn(); } catch (error) { throw new Error(`demo event "${next.label}" at ${new Date(clock).toISOString()}: ${error.message}`); }
      processed += 1;
      if (processed % 40 === 0) onPhase(`יוצרים נתוני הדגמה… ${processed} פעולות`);
    }
    return stats;
  } finally {
    Date.now = realNow;
  }
}
