"use strict";

// Business screens for the live app. Active only when supabase-business-upgrade.sql is installed
// (app.js detects it). Every write goes through the approved RPCs; success is shown only after the
// RPC returns and the data is reloaded from Supabase. Nothing is stored locally.
(() => {
  const app = () => window.ModaatApp;
  const sb = () => app().client();
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
  const number = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 });
  const MAX_ROWS = 250;
  const LEDGER_TYPES = { package_grant: "הקצאת חבילה", order_consumption: "ניצול בהזמנה", correction: "התאמה ידנית", conversion_reversal: "החזרה בהמרה",
    order_cancellation: "החזרה בביטול הזמנה", order_adjustment: "עדכון קרדיטים בהזמנה" };
  // Workflow statuses of an order (model v3). "unknown" = an order from before the model; never inferred.
  const FILE_STATUS = { unknown: "לא ידוע", not_received: "לא התקבל", received: "התקבל", approved: "אושר" };
  const PLACEMENT_STATUS = { unknown: "לא ידוע", not_placed: "לא שובץ", placed: "שובץ", published: "פורסם" };

  const BUSINESS_SYNC_ERROR = "שגיאת סנכרון — חלק מהנתונים לא עודכנו";
  const state = {
    ready: false, loaded: false, loadFailed: false, vatRate: 0.18, catalog: [], allProducts: [], products: [],
    packages: [], installments: [], obligations: [], balances: new Map(),
    loadToken: 0, clientToken: 0, modalClientId: null, keys: {}, editingProductId: null,
    sheetStatus: new Map(), sheetsInstalled: false, presetSheet: "",
    // Sheets model: "v2" (public.sheet_overview: dates, deadlines), "v1" (public.sheets: open/closed only) or null.
    sheetModel: null, serverOffset: 0,
    // Money: one row per charge from the view business_financial_summary (item_id = order id / installment id).
    summary: new Map(), events: [],
    orderSort: { key: "date", dir: "desc" }, editing: null, payObligationId: null, scheduleRows: [], scheduleContext: null
  };
  const v3 = () => Boolean(app().isOrdersV3 && app().isOrdersV3());

  // ---------- helpers ----------
  function localDateValue(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  // One date format across the system: DD/MM/YYYY (same as the orders list).
  function displayDate(value) {
    return value ? app().formatOrderDate(value) : "—";
  }
  const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  const gross = (beforeVat) => roundMoney(beforeVat * (1 + state.vatRate));
  function addMonths(dateValue, months) {
    const [year, month, day] = dateValue.split("-").map(Number);
    const target = new Date(year, month - 1 + months, 1);
    target.setDate(Math.min(day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
    return localDateValue(target);
  }
  function packageEndDate(startsOn, termMonths) {
    const [year, month, day] = addMonths(startsOn, termMonths).split("-").map(Number);
    return localDateValue(new Date(year, month - 1, day - 1));
  }
  // Sum before VAT must equal the package price (purchase_customer_package rejects otherwise).
  function buildInstallments(price, count, startsOn) {
    const base = Math.floor((price / count) * 100) / 100;
    return Array.from({ length: count }, (_, index) => ({
      due_on: addMonths(startsOn, index),
      amount_before_vat: index === count - 1 ? roundMoney(price - base * (count - 1)) : base
    }));
  }
  async function q(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }
  const newKey = (name) => { state.keys[name] = crypto.randomUUID(); };
  const errorText = (error) => app().friendlyError(error);
  const clientName = (clientId) => app().clients().find((item) => item.id === clientId)?.name || "לקוח לא זמין";
  function setBusy(button, busy, idleText) {
    button.disabled = busy;
    button.textContent = busy ? "שומרת…" : idleText;
  }
  function pill(kind, text) {
    const tone = ["paid", "neutral", "open"].includes(kind) ? kind : "pending";
    return `<span class="payment-select ${tone}">${escapeHtml(text)}</span>`;
  }
  function loadingRow(columns) {
    const text = state.loadFailed ? "טעינת הנתונים נכשלה. יש לרענן את הדף או לנסות שוב בעוד רגע." : "טוען נתונים מהמסד…";
    return `<tr><td colspan="${columns}" class="empty-cell">${text}</td></tr>`;
  }

  // ---------- data ----------
  async function loadReference() {
    const [settings, catalog, products] = await Promise.all([
      q(sb().from("business_settings").select("vat_rate").limit(1)),
      q(sb().from("package_catalog").select("id,name,credits,term_months,total_price_before_vat,default_installment_count,default_installment_before_vat,benefits").eq("is_active", true).order("credits")),
      q(sb().from("product_catalog").select("id,name,dimensions,base_price_before_vat,credit_cost,is_active,updated_at").order("name"))
    ]);
    state.vatRate = Number(settings[0]?.vat_rate ?? 0.18);
    state.catalog = catalog;
    state.allProducts = products;
    state.products = products.filter((item) => item.is_active && item.base_price_before_vat != null && item.credit_cost != null);
  }

  // A newer load supersedes an older one; the older caller (for example afterSave) then waits for the newer load,
  // so it never renders or edits with the versions from before its own save. Tokens only grow: no self-wait.
  let latestBusinessLoad = { token: 0, promise: null };
  function loadBusinessData() {
    const token = state.loadToken + 1; // loadBusinessDataOnce takes exactly this token before its first await
    const promise = loadBusinessDataOnce();
    latestBusinessLoad = { token, promise };
    return promise;
  }
  async function loadBusinessDataOnce() {
    const token = ++state.loadToken;
    // Every list is read page by page (fetchAllRows) so nothing is silently cut at the API row limit.
    const all = (build) => q(app().fetchAllRows(build));
    const modelV3 = v3();
    const [packages, installments, obligations, balances, summary, events] = await Promise.all([
      all(() => sb().from("customer_packages").select("id,client_id,package_name_snapshot,credits_granted,term_months,price_before_vat,vat_rate_snapshot,gross_total,starts_on,ends_on,installment_count,benefits_snapshot,status,updated_at").order("starts_on", { ascending: false }).order("id")),
      all(() => sb().from("package_installments").select("id,customer_package_id,installment_number,due_on,amount_before_vat,amount_due").order("due_on").order("id")),
      all(() => sb().from("financial_obligations").select(`id,order_id,package_installment_id,amount_due,due_on,status,updated_at${modelV3 ? ",amount_before_vat,cancelled_at,cancel_reason" : ""}`).order("id")),
      all(() => sb().from("business_client_credit_balances").select("client_id,credit_balance").order("client_id")),
      // The single source of every money figure (same columns before and after supabase-orders-v3.sql).
      all(() => sb().from("business_financial_summary").select("item_type,item_id,client_id,cash_due,cash_received,cash_outstanding,due_on,payment_status").order("item_id")),
      all(() => sb().from("business_payment_events").select(`id,obligation_id,event_type,amount,event_at,notes${modelV3 ? ",received_on,reverses_event_id" : ""}`).order("event_at").order("id"))
    ]);
    const sheets = await loadSheetStatus();
    if (token !== state.loadToken) return latestBusinessLoad.token > token ? latestBusinessLoad.promise : false;
    Object.assign(state, { packages, installments, obligations, events, loaded: true, loadFailed: false });
    state.summary = new Map(summary.map((row) => [row.item_id, row]));
    state.sheetModel = sheets.model;
    state.sheetsInstalled = sheets.model !== null;
    state.sheetStatus = new Map(sheets.rows.map((row) => [row.sheet_number, row]));
    // Deadlines are judged by the server clock (sheet_overview.server_now), not by this computer's clock.
    if (sheets.serverNow) state.serverOffset = Date.parse(sheets.serverNow) - Date.now();
    state.balances = new Map(balances.map((row) => [row.client_id, Number(row.credit_balance)]));
    app().rerenderClients();
    return true;
  }

  // Sheets, newest model first:
  //   v2: public.sheet_overview (supabase-sheets-v2.sql) — publication date, closing time, description, server time.
  //   v1: public.sheets (supabase-sheets-and-order-numbers.sql) — open/closed status only.
  //   none: every sheet is shown as open.
  const missingTable = (error) => ["PGRST205", "42P01"].includes(String(error.code || ""))
    || /schema cache|does not exist/i.test(error.message || "");
  async function loadSheetStatus() {
    const read = (table, columns) => app().fetchAllRows(() => sb().from(table).select(columns).order("sheet_number"));
    const v2 = await read("sheet_overview", "sheet_number,publication_date,closes_at,description,status,is_closed,closed_by_kind,closed_at,status_reason,reopened_at,created_via,updated_at,server_now");
    if (!v2.error) return { model: "v2", rows: v2.data, serverNow: v2.data[0]?.server_now ?? null };
    if (!missingTable(v2.error)) throw v2.error;
    const v1 = await read("sheets", "sheet_number,status,status_reason,closed_at,updated_at");
    if (!v1.error) return { model: "v1", rows: v1.data, serverNow: null };
    if (!missingTable(v1.error)) throw v1.error;
    return { model: null, rows: [], serverNow: null };
  }

  // Effective state (same rule as sheet_overview.is_closed): closed by hand, or its closing time has passed.
  // Re-evaluated on every render, so a sheet closes on screen at its deadline without a reload.
  const serverMs = () => Date.now() + state.serverOffset;
  function sheetRowClosed(row) {
    if (!row) return false;
    return row.status === "closed" || (Boolean(row.closes_at) && Date.parse(row.closes_at) <= serverMs());
  }
  function sheetClosed(sheetNumber) {
    return sheetRowClosed(state.sheetStatus.get(sheetNumber));
  }

  function compareSheets(left, right) {
    const a = Number(left); const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return b - a;
    return String(right).localeCompare(String(left), "he", { numeric: true });
  }

  // Groups the loaded orders by sheet number (only orders that have one).
  // Money of one order from the financial view: due (incl. VAT), received and still open. A cancelled order owes
  // nothing; credits orders have no money. Falls back to the order row only while the view has not loaded.
  function orderMoney(order) {
    const row = state.summary.get(order.id);
    if (order.billingMode === "credits") return { due: 0, received: 0, outstanding: 0, cancelled: Boolean(order.cancelledAt) };
    if (row) return { due: Number(row.cash_due), received: Number(row.cash_received), outstanding: Number(row.cash_outstanding), cancelled: row.payment_status === "cancelled" || Boolean(order.cancelledAt) };
    const paid = order.paymentStatus === "paid";
    return { due: Number(order.amount), received: paid ? Number(order.amount) : 0, outstanding: paid ? 0 : Number(order.amount), cancelled: Boolean(order.cancelledAt) };
  }
  // Payment state of an order: credits / cancelled / paid / partial / pending (no money owed: "none").
  function orderPayState(order) {
    if (order.cancelledAt) return "cancelled";
    if (order.billingMode === "credits") return "credits";
    const m = orderMoney(order);
    if (m.due <= 0) return "none";
    if (m.outstanding <= 0) return "paid";
    return m.received > 0 ? "partial" : "pending";
  }
  const PAY_TEXT = { credits: "קרדיטים", cancelled: "בוטלה", paid: "שולם", partial: "שולם חלקית", pending: "לא שולם", none: "" };
  const PAY_TONE = { credits: "neutral", cancelled: "neutral", paid: "paid", partial: "pending", pending: "pending", none: "neutral" };

  function sheetGroups() {
    const groups = new Map();
    for (const order of app().orders()) {
      if (!order.sheetNumber || order.cancelledAt) continue;
      const group = groups.get(order.sheetNumber) || { sheet: order.sheetNumber, orders: [], clients: new Set(), billed: 0, paid: 0, pending: 0, credits: 0 };
      group.orders.push(order);
      group.clients.add(order.clientId);
      if (order.billingMode === "credits") group.credits += Number(order.creditsUsed || 0);
      else {
        const m = orderMoney(order);
        group.billed = roundMoney(group.billed + m.due);
        group.paid = roundMoney(group.paid + m.received);
        group.pending = roundMoney(group.pending + m.outstanding);
      }
      groups.set(order.sheetNumber, group);
    }
    return [...groups.values()].sort((left, right) => compareSheets(left.sheet, right.sheet));
  }

  function activePackage(clientId, today = localDateValue()) {
    return state.packages.find((item) => item.client_id === clientId && item.status === "active"
      && item.starts_on <= today && today <= item.ends_on) || null;
  }

  // One row per financial obligation (cash order or package installment), joined in the browser.
  function obligationRows() {
    const today = localDateValue();
    const orders = new Map(app().orders().map((order) => [order.id, order]));
    const installments = new Map(state.installments.map((item) => [item.id, item]));
    const packages = new Map(state.packages.map((item) => [item.id, item]));
    const rows = [];
    // Installment numbers follow the current schedule (due-date order of the active installments of each package).
    const position = new Map();
    for (const pkg of state.packages) {
      const active = state.obligations.filter((ob) => ob.package_installment_id && ob.status !== "cancelled"
        && installments.get(ob.package_installment_id)?.customer_package_id === pkg.id)
        .sort((a, b) => String(a.due_on).localeCompare(String(b.due_on)) || installments.get(a.package_installment_id).installment_number - installments.get(b.package_installment_id).installment_number);
      active.forEach((ob, index) => position.set(ob.id, `${index + 1}/${active.length}`));
    }
    for (const obligation of state.obligations) {
      let row = null;
      if (obligation.order_id) {
        const order = orders.get(obligation.order_id);
        if (!order) continue;
        row = { clientId: order.clientId, orderId: order.id, label: `הזמנה ${order.orderNumber ?? ""}${order.sheetNumber ? ` · גיליון ${order.sheetNumber}` : ""}`,
          // set_obligation_paid (model v2) checks the order version; the v3 receipt functions check the charge itself.
          expected: v3() ? obligation.updated_at : order.updatedAt, sort: order.orderDate };
      } else {
        const installment = installments.get(obligation.package_installment_id);
        const pkg = installment && packages.get(installment.customer_package_id);
        if (!pkg) continue;
        const place = position.get(obligation.id);
        row = { clientId: pkg.client_id, packageId: pkg.id, label: `${pkg.package_name_snapshot} · ${place ? `תשלום ${place}` : "תשלום שבוטל"}`, expected: obligation.updated_at, sort: installment.due_on };
      }
      const view = state.summary.get(obligation.order_id || obligation.package_installment_id);
      const cancelled = obligation.status === "cancelled" || view?.payment_status === "cancelled";
      const amount = view ? Number(view.cash_due) : Number(obligation.amount_due);
      const received = view ? Number(view.cash_received) : (obligation.status === "paid" ? amount : 0);
      const outstanding = view ? Number(view.cash_outstanding) : Math.max(roundMoney(amount - received), 0);
      const paid = !cancelled && outstanding <= 0;
      const kind = cancelled ? "cancelled" : paid ? "paid" : !obligation.due_on ? "undated" : obligation.due_on < today ? "overdue" : "future";
      rows.push({ ...row, id: obligation.id, dueOn: obligation.due_on, amount, received, outstanding, paid, cancelled,
        partial: !cancelled && received > 0 && outstanding > 0, kind });
    }
    return rows.sort((left, right) => String(left.dueOn || left.sort).localeCompare(String(right.dueOn || right.sort)));
  }
  const KIND_TEXT = { paid: "שולם", overdue: "באיחור", undated: "ממתין · ללא מועד", future: "עתידי", cancelled: "בוטל" };
  function chargeStatusText(row) {
    if (row.partial) return row.kind === "overdue" ? "שולם חלקית · באיחור" : "שולם חלקית";
    return KIND_TEXT[row.kind];
  }
  function payButton(row) {
    // Model v3: every receipt is recorded on its own (also partial); model v2: the charge is marked paid / reopened.
    if (v3()) {
      if (row.cancelled && row.received <= 0) return "";
      const label = row.cancelled || row.paid ? "תקבולים" : "רישום תקבול";
      return `<button class="button button-outline client-action" type="button" data-biz-pay-open="${escapeHtml(row.id)}">${label}</button>`;
    }
    return `<button class="button button-outline client-action" type="button" data-biz-pay="${escapeHtml(row.id)}" data-biz-paid="${row.paid ? "0" : "1"}" data-expected="${escapeHtml(row.expected)}">${row.paid ? "ביטול תשלום" : "סימון כשולם"}</button>`;
  }
  const blankMoney = (value) => (value > 0 ? escapeHtml(money.format(value)) : "");
  function obligationTableRows(rows, withClient) {
    return rows.map((row) => `<tr class="${row.cancelled ? "is-cancelled" : ""}">
      ${withClient ? `<td class="client-name"><button class="link-button" type="button" data-client-view="${escapeHtml(row.clientId)}">${escapeHtml(clientName(row.clientId))}</button></td>` : ""}
      <td>${escapeHtml(row.label)}</td>
      <td>${escapeHtml(row.dueOn ? displayDate(row.dueOn) : "ללא מועד")}</td>
      <td class="amount-cell">${row.cancelled ? "" : escapeHtml(money.format(row.amount))}</td>
      <td class="amount-cell">${blankMoney(row.received)}</td>
      <td class="amount-cell">${blankMoney(row.outstanding)}</td>
      <td>${pill(row.cancelled ? "neutral" : row.paid ? "paid" : "pending", chargeStatusText(row))}</td>
      <td>${payButton(row)}</td>
    </tr>`).join("");
  }

  // ---------- dashboard: the daily desk ----------
  // Presentation only. Reuses the rows of the payments screen (obligationRows), the sheet groups of the
  // sheets screen and the loaded credit balances; it adds no financial calculation of its own.
  const deskFilter = { view: "", select: "", value: "" };

  function deskItem({ count, title, hint, meta = "", tone = "warn", attrs = "" }) {
    const level = count > 0 ? tone : "calm";
    return `<li><button class="desk-item is-${level}" type="button" ${attrs}>
      <span class="desk-count">${escapeHtml(number.format(count))}</span>
      <span class="desk-text"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(hint)}</small></span>
      <span class="desk-meta">${escapeHtml(count > 0 ? meta : "אין כרגע")}</span>
    </button></li>`;
  }

  function deskLink(view, select = "", value = "") {
    return `data-desk-go="${escapeHtml(view)}" data-desk-select="${escapeHtml(select)}" data-desk-value="${escapeHtml(value)}"`;
  }

  // The money strip of the dashboard: the same rows and sums as the payments screen and the reports.
  function renderMoneyStrip(rows) {
    const active = app().orders().filter((order) => !order.cancelledAt).length;
    const open = rows.filter((row) => !row.cancelled && row.outstanding > 0);
    $("#stat-orders").textContent = number.format(active);
    $("#stat-paid").textContent = money.format(roundMoney(rows.reduce((total, row) => total + row.received, 0)));
    $("#stat-pending").textContent = number.format(open.length);
    $("#stat-balance").textContent = money.format(roundMoney(open.reduce((total, row) => total + row.outstanding, 0)));
  }

  function renderDashboard() {
    const attention = $("#desk-attention");
    const sheetsList = $("#desk-sheets");
    if (!attention || !sheetsList) return;
    const attentionNote = $("#desk-attention-note");
    const sheetsNote = $("#desk-sheets-note");
    const sum = (rows) => money.format(roundMoney(rows.reduce((total, row) => total + row.outstanding, 0)));

    if (!state.ready) {
      // Without the business schema only the order status is known.
      const pending = app().orders().filter((order) => order.billingMode !== "credits" && order.paymentStatus !== "paid");
      $("#desk-attention-source").textContent = "לפי סטטוס ההזמנות";
      attention.innerHTML = deskItem({
        count: pending.length, title: "הזמנות שטרם שולמו", hint: "סטטוס התשלום בהזמנה הוא \"ממתין לתשלום\"",
        meta: "לרשימה", attrs: deskLink("orders", "#payment-filter", "pending")
      });
      attentionNote.hidden = false;
      attentionNote.textContent = "מעקב מועדי פירעון וחובות בפיגור זמין לאחר התקנת הסכימה העסקית.";
      sheetsList.innerHTML = '<li class="desk-empty">מספרי גיליון נשמרים בהזמנות לאחר התקנת הסכימה העסקית.</li>';
      sheetsNote.hidden = true;
      return;
    }
    if (!state.loaded) {
      attention.innerHTML = '<li class="desk-empty">טוען נתונים מהמסד…</li>';
      sheetsList.innerHTML = '<li class="desk-empty">טוען נתונים מהמסד…</li>';
      return;
    }

    const rows = obligationRows();
    const weekAhead = localDateValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const overdue = rows.filter((row) => row.kind === "overdue");
    const dueSoon = rows.filter((row) => row.kind === "future" && row.dueOn <= weekAhead);
    const undated = rows.filter((row) => row.kind === "undated");
    const negative = app().clients().filter((client) => (state.balances.get(client.id) ?? 0) < 0);
    $("#desk-attention-source").textContent = "לפי החיובים במסך התשלומים";
    attention.innerHTML = [
      deskItem({ count: overdue.length, title: "תשלומים באיחור", hint: "מועד הפירעון עבר והחיוב עדיין פתוח", meta: sum(overdue), tone: "alert", attrs: deskLink("payments", "#payments-filter", "overdue") }),
      deskItem({ count: dueSoon.length, title: "לפירעון בשבוע הקרוב", hint: "חיובים שמועד הפירעון שלהם בשבעת הימים הקרובים", meta: sum(dueSoon), attrs: deskLink("payments", "#payments-filter", "future") }),
      deskItem({ count: undated.length, title: "חיובים פתוחים ללא מועד פירעון", hint: "לא ייחשבו באיחור עד שייקבע להם מועד", meta: sum(undated), attrs: deskLink("payments", "#payments-filter", "undated") }),
      deskItem({ count: negative.length, title: "לקוחות ביתרת קרדיטים שלילית", hint: "ניצלו יותר קרדיטים ממה שהוקצה להם", meta: "לבדיקה", attrs: deskLink("packages") })
    ].join("");
    attentionNote.hidden = true;
    renderMoneyStrip(rows);

    const open = sheetGroups().filter((group) => !sheetClosed(group.sheet));
    // Masthead "edition": the newest open sheet that actually has orders (no invented issue data).
    const edition = $("#masthead-edition");
    if (edition) {
      edition.hidden = open.length === 0;
      edition.textContent = open.length ? `הגיליון הפתוח האחרון · ${open[0].sheet}` : "";
    }
    sheetsList.innerHTML = open.length ? open.slice(0, 5).map((group) => `<li><button class="desk-item sheet-item" type="button" data-sheet-view="${escapeHtml(group.sheet)}">
      <span class="desk-count">${escapeHtml(group.sheet)}</span>
      <span class="desk-text"><strong>גיליון ${escapeHtml(group.sheet)}</strong><small>${escapeHtml(`${number.format(group.orders.length)} הזמנות · ${number.format(group.clients.size)} לקוחות`)}</small></span>
      <span class="desk-meta">${pill("open", "פתוח")}</span>
    </button></li>`).join("") : '<li class="desk-empty">אין גיליונות פתוחים עם הזמנות.</li>';
    const notes = [];
    if (open.length > 5) notes.push(`ועוד ${number.format(open.length - 5)} גיליונות פתוחים.`);
    if (!state.sheetsInstalled) notes.push("סגירת גיליונות עדיין לא הופעלה במסד הנתונים, ולכן כל הגיליונות מוצגים כפתוחים.");
    sheetsNote.hidden = notes.length === 0;
    sheetsNote.textContent = notes.join(" ");
  }

  // ---------- rendering by screen ----------
  function renderCurrent() {
    const route = app().route();
    if (route.name === "dashboard") renderDashboard();
    if (route.name === "reports") renderReports();
    if (!state.ready) return;
    if (route.name === "orders") renderOrdersPage();
    if (route.name === "client") renderClientPage(route.param);
    if (route.name === "new-order") prepareNewOrder(route.param);
    if (route.name === "packages") renderPackagesPage();
    if (route.name === "payments") renderPaymentsPage();
    if (route.name === "settings") renderSettings();
    if (route.name === "sheets") renderSheetsPage();
    if (route.name === "sheet") renderSheetPage(route.param);
  }

  // Client file page: summary cards + packages / payments / details tabs (orders tab is rendered by app.js).
  async function renderClientPage(clientId) {
    const pkg = state.loaded ? activePackage(clientId) : null;
    $("#client-page-premium").hidden = !pkg;
    $("#client-kpi-package").textContent = !state.loaded ? "…" : pkg ? pkg.package_name_snapshot : "אין חבילה פעילה";
    $("#client-kpi-package-foot").textContent = pkg ? `תקופת ההטבות עד ${displayDate(pkg.ends_on)}` : "";
    const balance = state.balances.get(clientId) ?? 0;
    $("#client-kpi-credits").textContent = state.loaded ? number.format(balance) : "…";
    // Credits never expire. A negative balance is allowed; it only suggests a new package.
    $("#client-kpi-credits-foot").innerHTML = balance < 0
      ? `יתרה שלילית · <button class="link-button" type="button" data-biz-package="${escapeHtml(clientId)}">רכישת חבילה</button>`
      : "קרדיטים זמינים, ללא תאריך תפוגה";
    $("#client-kpi-credits").classList.toggle("negative", balance < 0);
    const rows = obligationRows().filter((row) => row.clientId === clientId);
    const overdue = rows.filter((row) => row.kind === "overdue");
    $("#client-kpi-overdue").textContent = money.format(roundMoney(overdue.reduce((sum, row) => sum + row.outstanding, 0)));
    $("#client-kpi-overdue-foot").textContent = overdue.length ? `${overdue.length} חיובים באיחור` : "אין חוב בפיגור";
    $("#client-payments-body").innerHTML = state.loaded ? obligationTableRows(rows, false) : loadingRow(7);
    $("#client-payments-empty").hidden = !state.loaded || rows.length !== 0;
    const packages = state.packages.filter((item) => item.client_id === clientId);
    $("#client-packages").innerHTML = packages.length ? packages.map((item) => {
      const benefits = Array.isArray(item.benefits_snapshot) ? item.benefits_snapshot : [];
      const active = item === pkg;
      const editSchedule = v3() && item.status !== "cancelled"
        ? `<button class="button button-outline client-action" type="button" data-biz-schedule="${escapeHtml(item.id)}">עריכת לוח התשלומים</button>` : "";
      return `<section class="orders-section package-card">
        <div class="section-heading"><div><h2>${escapeHtml(item.package_name_snapshot)} ${active ? '<span class="premium-badge">פעילה</span>' : ""}</h2>
        <p>נרכשה ב-${escapeHtml(displayDate(item.starts_on))} · תקופת ההטבות עד ${escapeHtml(displayDate(item.ends_on))} · הקרדיטים אינם פוקעים</p></div>${editSchedule}</div>
        <div class="kv-grid">
          <span>קרדיטים שהוקצו</span><strong>${escapeHtml(number.format(item.credits_granted))}</strong>
          <span>תקופת הטבות</span><strong>${escapeHtml(number.format(item.term_months))} חודשים</strong>
          <span>מחיר לפני מע"מ</span><strong>${escapeHtml(money.format(item.price_before_vat))}</strong>
          <span>מחיר כולל מע"מ</span><strong>${escapeHtml(money.format(item.gross_total))}</strong>
          <span>מספר תשלומים</span><strong>${escapeHtml(number.format(item.installment_count))}</strong>
        </div>
        ${benefits.length ? `<p class="field-hint package-benefits">הטבות: ${escapeHtml(benefits.map((benefit) => `${benefit.label} (${number.format(benefit.quantity)} ${benefit.unit})`).join(" · "))}</p>` : ""}
      </section>`;
    }).join("") : '<div class="empty-panel">ללקוח אין חבילות. לרכישה: "רכישת חבילה" בראש העמוד.</div>';

    const token = ++state.clientToken;
    const status = $("#client-page-status");
    try {
      const [details, ledger] = await Promise.all([
        q(sb().from("clients").select("joined_at,internal_notes").eq("id", clientId)),
        q(sb().from("credit_ledger").select("delta,entry_type,reason,created_at").eq("client_id", clientId).order("created_at", { ascending: false }))
      ]);
      if (token !== state.clientToken) return;
      status.hidden = true;
      $("#client-detail-joined").textContent = displayDate(details[0]?.joined_at);
      $("#client-detail-notes").textContent = details[0]?.internal_notes || "אין הערות.";
      $("#client-ledger-body").innerHTML = ledger.map((row) => `<tr>
        <td>${escapeHtml(displayDate(String(row.created_at).slice(0, 10)))}</td>
        <td class="amount-cell ${Number(row.delta) < 0 ? "negative" : ""}" dir="ltr">${Number(row.delta) > 0 ? "+" : ""}${escapeHtml(number.format(Number(row.delta)))}</td>
        <td>${escapeHtml(LEDGER_TYPES[row.entry_type] || row.entry_type)}</td>
        <td>${escapeHtml(row.reason)}</td>
      </tr>`).join("");
      $("#client-ledger-empty").hidden = ledger.length !== 0;
    } catch (error) {
      if (token !== state.clientToken) return;
      status.hidden = false;
      status.className = "import-preview error";
      status.textContent = `חלק מנתוני התיק לא נטענו: ${errorText(error)}`;
    }
  }

  function renderPackagesPage() {
    const query = $("#packages-search").value.trim().toLocaleLowerCase("he");
    const clients = [...app().clients()].sort((a, b) => a.name.localeCompare(b.name, "he"))
      .filter((client) => `${client.name} ${client.phone}`.toLocaleLowerCase("he").includes(query));
    $("#packages-clients-body").innerHTML = !state.loaded ? loadingRow(5) : clients.map((client) => {
      const pkg = activePackage(client.id);
      const balance = state.balances.get(client.id) ?? 0;
      return `<tr>
        <td class="client-name"><button class="link-button" type="button" data-client-view="${escapeHtml(client.id)}">${escapeHtml(client.name)}</button></td>
        <td>${pkg ? `${escapeHtml(pkg.package_name_snapshot)} <span class="premium-badge">פרימיום</span>` : '<span class="muted">אין</span>'}</td>
        <td>${escapeHtml(pkg ? displayDate(pkg.ends_on) : "—")}</td>
        <td class="amount-cell ${balance < 0 ? "negative" : ""}" dir="ltr">${escapeHtml(number.format(balance))}</td>
        <td class="client-actions">
          <button class="button button-outline client-action" type="button" data-biz-package="${escapeHtml(client.id)}">רכישת חבילה</button>
          <button class="button button-outline client-action" type="button" data-biz-credits="${escapeHtml(client.id)}">התאמת קרדיטים</button>
        </td>
      </tr>`;
    }).join("");
    $("#package-catalog-body").innerHTML = state.catalog.map((item) => `<tr>
      <td class="client-name">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(number.format(item.credits))}</td>
      <td>${escapeHtml(number.format(item.term_months))} חודשים</td>
      <td class="amount-cell">${escapeHtml(money.format(item.total_price_before_vat))}</td>
      <td>${escapeHtml(`${number.format(item.default_installment_count)} × ${money.format(item.default_installment_before_vat)}`)}</td>
    </tr>`).join("");
  }

  function renderPaymentsPage() {
    const all = obligationRows();
    const open = (kind) => roundMoney(all.filter((row) => row.kind === kind).reduce((total, row) => total + row.outstanding, 0));
    $("#payments-overdue").textContent = money.format(open("overdue"));
    $("#payments-undated").textContent = money.format(open("undated"));
    $("#payments-future").textContent = money.format(open("future"));
    $("#payments-paid").textContent = money.format(roundMoney(all.reduce((total, row) => total + row.received, 0)));
    const filter = $("#payments-filter").value;
    const query = $("#payments-search").value.trim().toLocaleLowerCase("he");
    const matchesFilter = (row) => filter === "all" || (filter === "open" ? ["overdue", "undated"].includes(row.kind)
      : filter === "partial" ? row.partial : row.kind === filter);
    const rows = all.filter((row) => matchesFilter(row) && `${clientName(row.clientId)} ${row.label}`.toLocaleLowerCase("he").includes(query));
    $("#payments-body").innerHTML = state.loaded ? obligationTableRows(rows, true) : loadingRow(8);
    $("#payments-empty").hidden = !state.loaded || rows.length !== 0;
    $("#payments-count").textContent = `${number.format(rows.length)} חיובים · יתרה לתשלום ${money.format(roundMoney(rows.reduce((total, row) => total + row.outstanding, 0)))}`;
  }

  // ---------- sheets board ----------
  // Dates are shown and entered in Israel time, whatever the computer's time zone is.
  const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const jerusalemFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  function jerusalemLocal(ms) {
    const p = Object.fromEntries(jerusalemFormat.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    return { date, time: `${p.hour}:${p.minute}`, local: `${date}T${p.hour}:${p.minute}` };
  }
  const weekdayOf = (dateValue) => new Date(`${dateValue}T12:00:00Z`).getUTCDay();
  function shiftDate(dateValue, days) {
    const [year, month, day] = dateValue.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  }
  const dayMonth = (dateValue) => `${dateValue.slice(8, 10)}/${dateValue.slice(5, 7)}`;
  function untilText(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return `בעוד ${number.format(minutes)} דק׳`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours === 1 ? "בעוד שעה" : `בעוד ${number.format(hours)} שעות`;
    const days = Math.round(hours / 24);
    return days === 1 ? "מחר" : `בעוד ${number.format(days)} ימים`;
  }
  const compareSheetNumbers = (left, right) => -compareSheets(left, right);

  // One row per sheet: every sheet in the sheets table (also empty ones) plus any sheet number used in orders.
  function sheetBoard() {
    const groups = new Map(sheetGroups().map((group) => [group.sheet, group]));
    const today = jerusalemLocal(serverMs()).date;
    const numbers = new Set([...state.sheetStatus.keys(), ...groups.keys()]);
    return [...numbers].map((sheetNumber) => {
      const row = state.sheetStatus.get(sheetNumber) || null;
      const group = groups.get(sheetNumber);
      const closed = sheetRowClosed(row);
      const publication = row?.publication_date || null;
      // Closed for orders is not the same as published: the next sheet is closed from Friday until it comes out on Sunday.
      const phase = !closed ? "open" : !publication ? (row?.created_via === "backfill" ? "historical" : "closed")
        : publication < today ? "published" : publication === today ? "today" : "awaiting";
      return {
        number: sheetNumber, row, publication, closesAt: row?.closes_at || null, description: row?.description || "",
        closed, phase, closedKind: !closed ? null : row.status === "closed" ? "manual" : "deadline",
        // Not yet published: a future publication date, or (no date at all) still open.
        upcoming: publication ? publication >= today : !closed,
        orders: group ? group.orders.length : 0, clients: group ? group.clients : new Set(),
        billed: group ? group.billed : 0, paid: group ? group.paid : 0, pending: group ? group.pending : 0, credits: group ? group.credits : 0
      };
    });
  }

  // "Next to publish" and "nearest open for orders" are two different sheets between Friday's closing and Sunday.
  function sheetHighlights(board) {
    const today = jerusalemLocal(serverMs()).date;
    const dated = board.filter((sheet) => sheet.publication && sheet.publication >= today)
      .sort((left, right) => left.publication.localeCompare(right.publication) || compareSheetNumbers(left.number, right.number));
    const open = board.filter((sheet) => !sheet.closed && sheet.closesAt)
      .sort((left, right) => Date.parse(left.closesAt) - Date.parse(right.closesAt) || compareSheetNumbers(left.number, right.number));
    return { next: dated[0] || null, openNext: open[0] || null, planned: dated, horizon: dated.length ? dated[dated.length - 1] : null };
  }

  // Status of a sheet. Closed for orders is not "published": the sheet of the week stays the current sheet from
  // its closing until it comes out. A historical sheet (closed when the sheets model was installed, no publication
  // date) is shown as such, never as if its date or file were known.
  const SHEET_PHASES = {
    open: { tone: "open", label: "פתוח להזמנות" },
    awaiting: { tone: "neutral", label: "סגור להזמנות" },
    today: { tone: "neutral", label: "מתפרסם היום" },
    published: { tone: "paid", label: "פורסם" },
    historical: { tone: "neutral", label: "היסטורי" },
    closed: { tone: "neutral", label: "סגור" }
  };
  function nullsLast(left, right, compare) {
    if (left == null || right == null) return left == null && right == null ? 0 : left == null ? 1 : -1;
    return compare(left, right);
  }

  // current  — the sheet of the week: the nearest sheet that is not yet published (open or already closed for orders);
  // next     — the sheet after it in publication order. Without dated sheets (model v1 / none) there is neither.
  function sheetSections(board) {
    const marks = sheetHighlights(board);
    const v2 = state.sheetModel === "v2";
    return { ...marks, current: v2 ? marks.next : null, following: v2 ? marks.planned[1] || null : null };
  }

  // "שישי 27/11 · 00:00" and, for 00:00, the plain-language meaning (midnight between Thursday and Friday).
  function closingWords(closesAt) {
    const local = jerusalemLocal(Date.parse(closesAt));
    const day = weekdayOf(local.date);
    const label = `${WEEKDAYS[day]} ${dayMonth(local.date)} · ${local.time}`;
    return { label, title: local.time === "00:00" ? `${label} — חצות שבין יום ${WEEKDAYS[(day + 6) % 7]} ליום ${WEEKDAYS[day]}` : label };
  }
  // The closing moment stored in the model is unchanged (default: Friday 00:00, Israel time). People read it as the
  // last minute in which an order is still accepted: "Thursday 23:59". Only the wording changes, never the moment.
  function orderDeadline(closesAt) {
    const local = jerusalemLocal(Date.parse(closesAt));
    const midnight = local.time === "00:00";
    const day = midnight ? shiftDate(local.date, -1) : local.date;
    const label = `יום ${WEEKDAYS[weekdayOf(day)]} ${dayMonth(day)}, ${midnight ? "23:59" : local.time}`;
    return { label, title: `הזמנות מתקבלות עד ${label}. מועד הסגירה במערכת: ${closingWords(closesAt).title} (שעון ישראל).` };
  }
  // Sheets screens: "יום ראשון · 22.11.2026" (the owner's editorial format; search also accepts 22/11).
  const dotDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  const weekdayDate = (publication) => `יום ${WEEKDAYS[weekdayOf(publication)]} · ${dotDate(publication)}`;

  // One short line under the status: what happens next for this sheet (text is plain; callers escape it).
  function sheetNote(sheet) {
    if (!state.sheetsInstalled) return { text: "", title: "" };
    const manual = sheet.closedKind === "manual" && sheet.phase !== "historical"
      ? `נסגר ידנית${sheet.row?.status_reason ? `: ${sheet.row.status_reason}` : ""}` : "";
    if (sheet.phase === "open") {
      if (!sheet.closesAt) return { text: "", title: "פתוח להזמנות" };
      const left = Date.parse(sheet.closesAt) - serverMs();
      const deadline = orderDeadline(sheet.closesAt);
      return { text: `הזמנות עד ${deadline.label}`, until: untilText(left), title: deadline.title, soon: left < 86400000 };
    }
    if (sheet.phase === "awaiting") return { text: `יוצא לאור ביום ${WEEKDAYS[weekdayOf(sheet.publication)]}`, title: manual || "נסגר להזמנות במועד הסגירה" };
    if (sheet.phase === "today") return { text: "יוצא לאור היום", title: manual };
    if (sheet.phase === "published") return { text: `יצא לאור ב-${displayDate(sheet.publication)}`, title: "" };
    if (sheet.phase === "historical") return { text: "מידע חלקי", title: HISTORICAL_NOTE };
    return { text: manual, title: manual || "סגור" };
  }
  const HISTORICAL_NOTE = "גיליון מלפני מעבר המערכת לניהול גיליונות: תאריך הפרסום וקובץ העיתון לא תועדו. ההזמנות והסכומים מחושבים מההזמנות השמורות.";
  const plural = (count, one, many) => `${number.format(count)} ${count === 1 ? one : many}`;

  // Two separate facts per sheet, never mixed:
  //   place  — where the sheet stands on the publication timeline (current / next / future / published);
  //   intake — whether it accepts orders right now (open / closed for orders), from the existing closing rule.
  function sheetPlace(sheet, sections) {
    const today = jerusalemLocal(serverMs()).date;
    if (sheet === sections.current) return { key: "current", label: "הגיליון הנוכחי", note: sheet.publication === today ? "מתפרסם היום" : "" };
    if (sheet === sections.following) return { key: "next", label: "הגיליון הבא", note: "" };
    if (sheet.publication) {
      if (sheet.publication >= today) return { key: "future", label: "עתידי", note: "" };
      return sheet.closed ? { key: "published", label: "פורסם", note: "" } : { key: "past", label: "מועד הפרסום עבר", note: "עדיין פתוח להזמנות" };
    }
    if (sheet.phase === "historical") return { key: "historical", label: "היסטורי", note: "מידע חלקי", title: HISTORICAL_NOTE };
    return state.sheetModel === "v2" ? { key: "undated", label: "ללא תאריך", note: "" } : { key: "none", label: "", note: "" };
  }
  function sheetIntake(sheet) {
    if (!state.sheetsInstalled) return { key: "none", label: "", note: "", title: "" };
    if (!sheet.closed) {
      const note = sheetNote(sheet);
      const deadline = sheet.closesAt ? orderDeadline(sheet.closesAt) : null;
      return { key: "open", label: "פתוח להזמנות", note: deadline ? `עד ${deadline.label}` : "", title: note.title, soon: note.soon };
    }
    const manual = sheet.closedKind === "manual" && sheet.phase !== "historical";
    return { key: "closed", label: "סגור להזמנות", note: manual ? "נסגר ידנית" : "", title: manual && sheet.row?.status_reason ? `נסגר ידנית: ${sheet.row.status_reason}` : "" };
  }

  // The banner names the current sheet; only "גיליון N" is a link (the rest of the banner is not clickable).
  function renderSheetsBanner(sections) {
    const line = $("#sheets-banner-current");
    line.hidden = !state.loaded || state.sheetModel !== "v2";
    if (line.hidden) { line.innerHTML = ""; return; }
    const { current } = sections;
    // Three lines: the kicker, the link (the only clickable words), the publication day and date.
    line.innerHTML = current
      ? `<span class="sheets-banner-kicker">הגיליון הנוכחי</span>`
        + `<button class="sheets-banner-link" type="button" data-sheet-view="${escapeHtml(current.number)}">גיליון ${escapeHtml(current.number)}</button>`
        + `<span class="sheets-banner-date">${escapeHtml(weekdayDate(current.publication))}</span>`
      : '<span class="sheets-banner-kicker">הגיליון הנוכחי</span><span class="sheets-banner-none">אין גיליון מתוכנן לפרסום הקרוב</span>';
  }

  // The working order of the list (one list, no sub-headings), from the timeline rather than the number:
  // current → next → other future sheets (nearest first) → published (newest first) → historical → the rest.
  // A sheet whose date passed while still open sits after the future ones. Without dates (v1): newest number first.
  const PLACE_ORDER = { current: 0, next: 1, future: 2, past: 3, published: 4, historical: 5, undated: 6, none: 6 };
  function sortSheetRows(list, sections) {
    return list.map((sheet) => ({ sheet, place: sheetPlace(sheet, sections).key })).sort((a, b) => {
      const byPlace = PLACE_ORDER[a.place] - PLACE_ORDER[b.place];
      if (byPlace) return byPlace;
      const pa = a.sheet.publication, pb = b.sheet.publication;
      const byDate = pa && pb ? (a.place === "future" ? pa.localeCompare(pb) : pb.localeCompare(pa)) : 0;
      return byDate || compareSheets(a.sheet.number, b.sheet.number);
    }).map((item) => item.sheet);
  }

  // One row per sheet: number, publication date, place on the timeline, order intake. No money in the list.
  function sheetRowMarkup(sheet, sections) {
    const n = escapeHtml(sheet.number);
    const place = sheetPlace(sheet, sections);
    const intake = sheetIntake(sheet);
    const date = sheet.publication
      ? escapeHtml(weekdayDate(sheet.publication))
      : `<span class="is-quiet">${state.sheetModel === "v2" ? (sheet.phase === "historical" ? "תאריך לא תועד" : "ללא תאריך") : "—"}</span>`;
    const left = intake.key === "open" && sheet.closesAt ? untilText(Date.parse(sheet.closesAt) - serverMs()) : "";
    return `<tr class="sheet-row is-${place.key}" data-sheet="${n}" data-sheet-view="${n}">
      <th class="sheet-row-id" scope="row"><button class="sheet-row-link" type="button" data-sheet-view="${n}">גיליון <span class="sheet-row-no">${n}</span></button>${sheet.description ? `<span class="sheet-row-desc" title="${escapeHtml(sheet.description)}">${escapeHtml(sheet.description)}</span>` : ""}</th>
      <td class="sheet-row-date">${date}</td>
      <td class="sheet-row-place sheet-col-place"${place.title ? ` title="${escapeHtml(place.title)}"` : ""}>${place.label ? `<span class="sheet-place is-${place.key}">${escapeHtml(place.label)}</span>` : ""}${place.note ? `<span class="sheet-row-note">${escapeHtml(place.note)}</span>` : ""}</td>
      <td class="sheet-row-intake"${intake.title ? ` title="${escapeHtml(intake.title)}"` : ""}>${intake.label ? `<span class="sheet-intake is-${intake.key}">${escapeHtml(intake.label)}</span>` : ""}${intake.note ? `<span class="sheet-row-note${intake.soon ? " is-soon" : ""}">${escapeHtml(intake.note)}${left ? ` · ${escapeHtml(left)}` : ""}</span>` : ""}</td>
      <td class="sheet-row-go" aria-hidden="true">‹</td>
    </tr>`;
  }

  function renderSheetsPage() {
    const v2 = state.sheetModel === "v2";
    $("#sheets-status-note").hidden = !state.loaded || state.sheetsInstalled;
    $("#sheets-add").hidden = !(state.loaded && v2);
    const table = $("#sheets-table");
    const body = $("#sheets-body");
    const emptyBox = $("#sheets-empty");
    // Until the sheet statuses are loaded, any "current" or "published" would be a guess.
    if (!state.loaded) {
      renderSheetsBanner({ current: null });
      table.hidden = false;
      body.innerHTML = loadingRow(5);
      emptyBox.hidden = true;
      return;
    }
    const board = sheetBoard();
    const sections = sheetSections(board);
    renderSheetsBanner(sections);
    // The timeline column means something only with dated sheets (model v2).
    table.classList.toggle("no-places", !v2);
    const query = $("#sheets-search").value.trim().toLocaleLowerCase("he");
    const matches = (sheet) => !query || sheet.number.includes(query) || sheet.description.toLocaleLowerCase("he").includes(query)
      || (sheet.publication && `${displayDate(sheet.publication)} ${dotDate(sheet.publication)} ${WEEKDAYS[weekdayOf(sheet.publication)]}`.includes(query));
    const rows = sortSheetRows(board.filter(matches), sections);
    body.innerHTML = rows.map((sheet) => sheetRowMarkup(sheet, sections)).join("");
    table.hidden = rows.length === 0;
    emptyBox.hidden = rows.length !== 0;
    if (!rows.length) {
      $("#sheets-empty-title").textContent = board.length ? "לא נמצאו גיליונות" : "עדיין אין גיליונות";
      $("#sheets-empty-text").textContent = board.length ? "אין גיליון שמתאים לחיפוש. נסו מספר או תאריך אחר."
        : v2 ? "אפשר ליצור את הגיליונות הקרובים מראש בלחיצה על \"הוספת גיליונות\"." : "גיליון מופיע כאן כשיש בו לפחות הזמנה אחת.";
    }
  }

  // ---------- "הוספת גיליונות" (plan sheets ahead) ----------
  // Rows are generated from the settings (consecutive numbers, weekly publication, closing rule). A field edited in a
  // row is kept per row position; changing the first date or the closing rule recomputes dates but keeps descriptions.
  // The checks here only guide the user: create_sheets_batch re-validates everything and creates all or nothing.
  const MAX_NEW_SHEETS = 60;
  const addSheets = { overrides: [], key: null, keyHash: "" };
  const closingFor = (publication, closeDay, closeTime) => `${shiftDate(publication, -((weekdayOf(publication) - closeDay + 7) % 7))}T${closeTime}`;

  function addSheetsDefaults() {
    const board = sheetBoard();
    const numeric = board.map((sheet) => Number(sheet.number)).filter((value) => Number.isSafeInteger(value) && value > 0);
    const now = jerusalemLocal(serverMs());
    const lastDated = board.map((sheet) => sheet.publication).filter(Boolean).sort().pop();
    // Continue the weekly rhythm after the last planned sheet; otherwise start from the coming Sunday.
    let first = lastDated && lastDated >= now.date ? shiftDate(lastDated, 7) : shiftDate(now.date, (7 - weekdayOf(now.date)) % 7 || 7);
    while (closingFor(first, 5, "00:00") <= now.local) first = shiftDate(first, 7);
    return { start: numeric.length ? Math.max(...numeric) + 1 : 1, first };
  }

  function addSheetsSettings() {
    const fields = $("#sheets-add-form").elements;
    return { start: fields.start.value.trim(), count: fields.count.value.trim(), first: fields.first.value,
      closeDay: Number(fields.close_day.value), closeTime: fields.close_time.value };
  }

  // Returns the rows to create and every problem found, per row and for the settings.
  function addSheetsPlan() {
    const settings = addSheetsSettings();
    const problems = [];
    const start = Number(settings.start);
    const count = Number(settings.count);
    if (!/^[1-9][0-9]{0,8}$/.test(settings.start)) problems.push("מספר הגיליון הראשון: ספרות בלבד, מספר חיובי, ללא אפס מוביל.");
    if (!Number.isInteger(count) || count < 1 || count > MAX_NEW_SHEETS) problems.push(`כמות הגיליונות: בין 1 ל-${MAX_NEW_SHEETS}.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.first)) problems.push("יש לבחור תאריך פרסום ראשון.");
    if (!/^\d{2}:\d{2}$/.test(settings.closeTime)) problems.push("יש לבחור שעת סגירה.");
    if (problems.length) return { settings, rows: [], problems };
    if (start + count - 1 > 999999999) return { settings, rows: [], problems: ["מספרי הגיליונות חורגים מהטווח."] };

    const now = jerusalemLocal(serverMs()).local;
    const existing = new Set(sheetBoard().map((sheet) => sheet.number));
    const existingDates = new Map(sheetBoard().filter((sheet) => sheet.publication).map((sheet) => [sheet.publication, sheet.number]));
    const rows = Array.from({ length: count }, (_, index) => {
      const publication = shiftDate(settings.first, 7 * index);
      const row = { index, number: String(start + index), publication, closes: closingFor(publication, settings.closeDay, settings.closeTime), description: "", ...(addSheets.overrides[index] || {}) };
      row.errors = [];
      row.notes = [];
      if (existing.has(row.number)) row.errors.push(`גיליון ${row.number} כבר קיים`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.publication)) row.errors.push("חסר תאריך פרסום");
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(row.closes)) row.errors.push("חסר מועד סגירה");
      if (!row.errors.length) {
        if (row.closes >= `${shiftDate(row.publication, 1)}T00:00`) row.errors.push("הסגירה אחרי יום הפרסום");
        else if (row.closes <= now) row.errors.push("מועד הסגירה כבר עבר");
      }
      if (row.description.length > 200) row.errors.push("תיאור ארוך מ-200 תווים");
      if (row.publication && existingDates.has(row.publication)) row.notes.push(`באותו תאריך כמו גיליון ${existingDates.get(row.publication)}`);
      return row;
    });
    const seenDates = new Map();
    for (const row of rows) {
      if (seenDates.has(row.publication)) row.notes.push(`באותו תאריך כמו גיליון ${seenDates.get(row.publication)}`);
      else seenDates.set(row.publication, row.number);
    }
    return { settings, rows, problems };
  }

  function addRowStatus(row) {
    if (row.errors.length) return `<span class="add-check is-error">${escapeHtml(row.errors.join(" · "))}</span>`;
    if (row.notes.length) return `<span class="add-check is-note">${escapeHtml(row.notes.join(" · "))}</span>`;
    return '<span class="add-check is-ok" aria-label="תקין">✓</span>';
  }

  // full: rebuild the inputs (settings changed). Otherwise only the checks are refreshed, so typing keeps focus.
  function renderAddSheets(full) {
    const plan = addSheetsPlan();
    const { settings, rows, problems } = plan;
    const body = $("#sheets-add-rows");
    if (full) {
      body.innerHTML = rows.map((row) => `<tr data-add-row="${row.index}">
        <td class="add-no" data-label="גיליון">${escapeHtml(row.number)}</td>
        <td class="add-publication" data-label="תאריך פרסום"><input type="date" data-field="publication" value="${escapeHtml(row.publication)}" aria-label="תאריך פרסום לגיליון ${escapeHtml(row.number)}"><span class="add-weekday"></span></td>
        <td class="add-closes" data-label="סגירה להזמנות"><input type="datetime-local" step="60" data-field="closes" value="${escapeHtml(row.closes)}" aria-label="מועד סגירה לגיליון ${escapeHtml(row.number)}"></td>
        <td class="add-description" data-label="תיאור"><input data-field="description" maxlength="200" value="${escapeHtml(row.description)}"${row.index === 0 ? ' placeholder="לדוגמה: גיליון חג"' : ""} aria-label="תיאור לגיליון ${escapeHtml(row.number)}"></td>
        <td class="add-status"></td>
      </tr>`).join("");
    }
    for (const row of rows) {
      const line = body.querySelector(`[data-add-row="${row.index}"]`);
      if (!line) continue;
      line.classList.toggle("has-error", row.errors.length > 0);
      line.querySelector(".add-weekday").textContent = /^\d{4}-\d{2}-\d{2}$/.test(row.publication) ? `יום ${WEEKDAYS[weekdayOf(row.publication)]}` : "";
      line.querySelector(".add-status").innerHTML = addRowStatus(row);
    }
    const ruleDay = /^\d{4}-\d{2}-\d{2}$/.test(settings.first) ? WEEKDAYS[weekdayOf(settings.first)] : "";
    // 00:00 belongs to the day it starts: "Friday 00:00" is the midnight between Thursday and Friday.
    const midnight = settings.closeTime === "00:00"
      ? `, כלומר בחצות שבין יום ${WEEKDAYS[(settings.closeDay + 6) % 7]} ליום ${WEEKDAYS[settings.closeDay]}` : "";
    $("#sheets-add-rule").textContent = ruleDay
      ? `פרסום כל יום ${ruleDay}, אחת לשבוע · סגירה להזמנות ביום ${WEEKDAYS[settings.closeDay]} בשעה ${settings.closeTime || "—"}${midnight}, לפני כל פרסום (שעון ישראל).`
      : "";
    const errorRows = rows.filter((row) => row.errors.length);
    const summary = $("#sheets-add-summary");
    if (problems.length) summary.textContent = problems[0];
    else if (errorRows.length) summary.textContent = `${number.format(errorRows.length)} ${errorRows.length === 1 ? "שורה דורשת" : "שורות דורשות"} תיקון לפני השמירה.`;
    else summary.textContent = `ייווצרו ${number.format(rows.length)} גיליונות: ${rows[0].number}${rows.length > 1 ? `–${rows[rows.length - 1].number}` : ""} · פרסום ${displayDate(rows[0].publication)}${rows.length > 1 ? ` עד ${displayDate(rows[rows.length - 1].publication)}` : ""}.`;
    summary.classList.toggle("is-error", problems.length > 0 || errorRows.length > 0);
    const submit = $("#sheets-add-submit");
    if (submit.textContent !== "שומרת…") {
      submit.disabled = problems.length > 0 || errorRows.length > 0;
      submit.textContent = rows.length && !problems.length ? `יצירת ${number.format(rows.length)} גיליונות` : "יצירת הגיליונות";
    }
    return plan;
  }

  function openAddSheets() {
    if (state.sheetModel !== "v2") return;
    const form = $("#sheets-add-form");
    form.reset();
    const defaults = addSheetsDefaults();
    form.elements.close_day.innerHTML = WEEKDAYS.map((day, index) => `<option value="${index}">יום ${day}</option>`).join("");
    form.elements.start.value = String(defaults.start);
    form.elements.count.value = "10";
    form.elements.first.value = defaults.first;
    form.elements.close_day.value = "5"; // Friday
    form.elements.close_time.value = "00:00";
    Object.assign(addSheets, { overrides: [], key: null, keyHash: "" });
    $("#sheets-add-message").textContent = "";
    const submit = $("#sheets-add-submit");
    submit.disabled = false;
    submit.textContent = "יצירת הגיליונות";
    renderAddSheets(true);
    $("#sheets-add-modal").showModal();
    form.elements.count.focus();
    form.elements.count.select();
  }

  function onAddSheetsInput(event) {
    const field = event.target.dataset.field;
    if (field) {
      const index = Number(event.target.closest("[data-add-row]").dataset.addRow);
      addSheets.overrides[index] = { ...(addSheets.overrides[index] || {}), [field]: event.target.value };
      renderAddSheets(false);
      return;
    }
    // A new first date or closing rule recomputes the dates (edited descriptions stay).
    if (["first", "close_day", "close_time"].includes(event.target.name)) {
      addSheets.overrides = addSheets.overrides.map((item) => (item && item.description != null ? { description: item.description } : undefined));
    }
    renderAddSheets(true);
  }

  async function submitAddSheets(event) {
    event.preventDefault();
    const message = $("#sheets-add-message");
    const submit = $("#sheets-add-submit");
    if (submit.disabled) return;
    const plan = renderAddSheets(false);
    if (plan.problems.length || plan.rows.some((row) => row.errors.length)) {
      message.textContent = "יש לתקן את השורות המסומנות לפני השמירה.";
      return;
    }
    const payload = plan.rows.map((row) => ({ sheet_number: row.number, publication_date: row.publication,
      closes_at_local: row.closes, description: row.description.trim() }));
    // One key per exact request: a repeated click re-sends the same key (the server answers once);
    // a changed request gets a new key.
    const hash = JSON.stringify(payload);
    if (!addSheets.key || addSheets.keyHash !== hash) Object.assign(addSheets, { key: crypto.randomUUID(), keyHash: hash });
    message.textContent = "";
    setBusy(submit, true, "");
    let created = false;
    try {
      const result = await q(sb().rpc("create_sheets_batch", { p_sheets: payload, p_idempotency_key: addSheets.key }));
      created = true;
      $("#sheets-add-modal").close();
      Object.assign(addSheets, { key: null, keyHash: "" });
      const numbers = Array.isArray(result?.created) ? result.created : payload.map((row) => row.sheet_number);
      await afterSave(`נוצרו ${number.format(numbers.length)} גיליונות: ${numbers[0]}${numbers.length > 1 ? `–${numbers[numbers.length - 1]}` : ""}.`);
    } catch (error) {
      console.error("יצירת גיליונות נכשלה:", { code: error?.code || "", message: String(error?.message || "").slice(0, 300) });
      const code = String(error?.code || "");
      if (!code) {
        // No answer from the server: the batch may or may not have been saved. The same key makes a retry safe.
        message.textContent = `${errorText(error)} לא ידוע אם הגיליונות נשמרו. לחיצה חוזרת על השמירה בטוחה: היא לא תיצור כפילויות.`;
      } else {
        // The server's own Hebrew message (e.g. which sheets already exist) is the clearest explanation.
        const text = code === "23505" && /[֐-׿]/.test(error.message || "") ? error.message : errorText(error);
        message.textContent = /לא נוצר/.test(text) ? text : `${text} לא נוצר אף גיליון.`;
      }
      if (code === "23505") {
        try { await loadBusinessData(); } catch { /* the message above is enough */ }
      }
    } finally {
      setBusy(submit, false, "יצירת הגיליונות");
      if (!created) renderAddSheets(false);
    }
  }

  // ---------- single sheet: summary banner, then every order of the sheet ----------
  // Columns follow the owner's order list and appear only when they have a real source in the sheet's orders.
  // Not in the data model yet (documented in PROJECT-HANDOFF.md): who entered the order, ad-file status, placement.
  function sheetOrderColumns(orders) {
    const cash = orders.some((order) => order.billingMode !== "credits");
    return [
      { key: "number", head: "מס׳ הזמנה" },
      { key: "date", head: "תאריך הזמנה" },
      { key: "client", head: "לקוח" },
      { key: "description", head: "תיאור פרסום" },
      orders.some((order) => order.billingMode === "credits") && { key: "credits", head: "קרדיטים" },
      orders.some((order) => order.cashBeforeVat != null) && { key: "net", head: "מחיר לפני מע״מ" },
      cash && { key: "price", head: "מחיר כולל מע״מ" },
      { key: "status", head: "סטטוס תשלום" },
      orders.some((order) => order.notes) && { key: "notes", head: "הערות" }
    ].filter(Boolean);
  }
  function sheetOrderCell(order, key) {
    const credits = order.billingMode === "credits";
    const due = !credits && order.paymentStatus !== "paid";
    switch (key) {
      case "number": return `<td class="order-number">${escapeHtml(order.orderNumber ?? "—")}</td>`;
      case "date": return `<td>${order.orderDate ? escapeHtml(displayDate(String(order.orderDate).slice(0, 10))) : "—"}</td>`;
      case "client": return `<td><button class="link-button sheet-order-client" type="button" data-client-view="${escapeHtml(order.clientId)}">${escapeHtml(clientName(order.clientId))}</button></td>`;
      case "description": return `<td class="sheet-order-desc">${escapeHtml(order.product || "—")}${order.dimensions ? ` <span class="muted">· ${escapeHtml(order.dimensions)}</span>` : ""}</td>`;
      case "credits": return `<td class="amount-cell">${credits ? escapeHtml(number.format(order.creditsUsed)) : "—"}</td>`;
      case "net": return `<td class="amount-cell">${!credits && order.cashBeforeVat != null ? escapeHtml(money.format(order.cashBeforeVat)) : "—"}</td>`;
      case "price": return `<td class="amount-cell${due ? " is-due" : ""}">${credits ? "—" : escapeHtml(money.format(order.amount))}</td>`;
      case "status": return `<td>${credits ? pill("neutral", "קרדיטים") : pill(due ? "pending" : "paid", due ? "ממתין לתשלום" : "שולם")}</td>`;
      case "notes": return `<td class="sheet-order-notes">${escapeHtml(order.notes || "")}</td>`;
      default: return "<td></td>";
    }
  }

  function renderSheetPage(sheetNumber) {
    const board = state.loaded ? sheetBoard() : [];
    const sheet = board.find((item) => item.number === sheetNumber) || null;
    const group = sheetGroups().find((item) => item.sheet === sheetNumber);
    const closed = sheetClosed(sheetNumber);
    $("#sheet-page-number").textContent = sheetNumber;
    const phase = sheet && state.sheetsInstalled ? sheet.phase : "open";
    const note = sheet ? sheetNote(sheet) : { text: "", title: "" };
    $("#sheet-page-status").innerHTML = state.loaded ? pill(SHEET_PHASES[phase].tone, SHEET_PHASES[phase].label) : "";
    // Where the sheet stands on the timeline (current / next), next to its order status.
    const place = sheet && state.loaded ? sheetPlace(sheet, sheetSections(board)) : null;
    $("#sheet-page-place").textContent = place && ["current", "next"].includes(place.key) ? place.label : "";
    const noteBox = $("#sheet-page-note");
    noteBox.textContent = state.loaded && note.text ? `${note.text}${note.until ? ` · ${note.until}` : ""}` : "";
    noteBox.title = note.title || "";
    noteBox.classList.toggle("is-soon", Boolean(note.soon));
    const dateBox = $("#sheet-page-date");
    dateBox.textContent = sheet?.publication ? weekdayDate(sheet.publication) : state.sheetModel === "v2" && state.loaded ? "תאריך הפרסום לא תועד" : "";
    dateBox.classList.toggle("is-quiet", !sheet?.publication);
    $("#sheet-page-desc").textContent = sheet?.description || "";
    // Why it is closed (by hand, with the reason), or why its information is partial (historical).
    const statusRow = state.sheetStatus.get(sheetNumber);
    let subtitle = "";
    if (phase === "historical") subtitle = HISTORICAL_NOTE;
    else if (closed && sheet?.closedKind === "manual" && statusRow?.closed_at) {
      subtitle = `נסגר ידנית ב-${displayDate(String(statusRow.closed_at).slice(0, 10))}${statusRow.status_reason ? `: ${statusRow.status_reason}` : ""}.`;
    }
    $("#sheet-page-subtitle").textContent = subtitle;
    $("#sheet-page-subtitle").hidden = !subtitle;

    const toggle = $("#sheet-toggle-status");
    // A sheet that exists in the database can be closed or reopened even before it has orders (sheets v2 creates
    // future sheets empty, e.g. a holiday week without an edition).
    toggle.hidden = !state.sheetsInstalled || !(group || state.sheetStatus.has(sheetNumber));
    toggle.textContent = closed ? "פתיחה מחדש של הגיליון" : "סגירת הגיליון";
    toggle.dataset.closed = closed ? "1" : "0";
    // New orders only for a sheet that is open for orders.
    $("#sheet-new-order").hidden = !state.loaded || closed;
    // The publication archive belongs to sheets that are closed for orders.
    $("#sheet-archive").hidden = !state.loaded || !state.sheetsInstalled || !closed;

    // Summary (the existing per-order figures; charges are charges, not profit).
    const orders = group ? group.orders : [];
    $("#sheet-count").textContent = number.format(orders.length);
    $("#sheet-clients").textContent = number.format(group ? group.clients.size : 0);
    $("#sheet-billed").textContent = money.format(group ? group.billed : 0);
    $("#sheet-paid").textContent = money.format(group ? group.paid : 0);
    $("#sheet-pending").textContent = money.format(group ? group.pending : 0);
    $("#sheet-pending").closest(".sheet-sum").classList.toggle("is-due", Boolean(group && group.pending > 0));
    $("#sheet-credits").textContent = number.format(group ? group.credits : 0);
    // Credits used are shown only when the sheet has any.
    $("#sheet-credits").closest(".sheet-sum").hidden = !(group && group.credits > 0);
    const table = $("#sheet-orders-table");
    const body = $("#sheet-orders-body");
    if (!state.loaded) {
      toggle.hidden = true;
      $("#sheet-orders-head").innerHTML = "";
      $("#sheet-orders-meta").textContent = "";
      body.innerHTML = loadingRow(8);
      table.hidden = false;
      $("#sheet-orders-empty").hidden = true;
      return;
    }
    // Every order of the sheet, one row each. Sorted by client name, so a client's orders stay next to each other.
    const name = new Map(orders.map((order) => [order.clientId, clientName(order.clientId)]));
    const sorted = [...orders].sort((left, right) => name.get(left.clientId).localeCompare(name.get(right.clientId), "he")
      || (Number(left.orderNumber) || 0) - (Number(right.orderNumber) || 0));
    const columns = sheetOrderColumns(orders);
    $("#sheet-orders-head").innerHTML = orders.length ? `<tr>${columns.map((column) => `<th scope="col">${escapeHtml(column.head)}</th>`).join("")}</tr>` : "";
    $("#sheet-orders-meta").textContent = orders.length ? `${plural(name.size, "לקוח", "לקוחות")} · ${plural(orders.length, "הזמנה", "הזמנות")}` : "";
    body.innerHTML = sorted.map((order) => `<tr class="sheet-order" data-order="${escapeHtml(order.id)}" data-client="${escapeHtml(order.clientId)}">${columns.map((column) => sheetOrderCell(order, column.key)).join("")}</tr>`).join("");
    table.hidden = orders.length === 0;
    $("#sheet-orders-empty").hidden = orders.length !== 0;
  }

  // Closing/reopening changes only the sheet status row; orders and payments are untouched.
  async function toggleSheetStatus() {
    const sheetNumber = app().route().param;
    const closing = $("#sheet-toggle-status").dataset.closed !== "1";
    let reason = "";
    if (closing) {
      const answer = await app().ask({ kicker: "סגירת גיליון", title: `לסגור את גיליון ${sheetNumber}?`,
        message: "ההזמנות, התשלומים והקרדיטים לא ישתנו.", confirmText: "סגירת הגיליון" });
      if (!answer) return;
      reason = "סגירת גיליון";
    } else {
      const answer = await app().ask({ kicker: "פתיחה מחדש", title: `לפתוח מחדש את גיליון ${sheetNumber}?`,
        confirmText: "פתיחה מחדש", reason: { label: "סיבת הפתיחה מחדש", min: 3, placeholder: "לדוגמה: תיקון מודעה של לקוח" } });
      if (!answer) return;
      reason = answer.reason;
    }
    const button = $("#sheet-toggle-status");
    button.disabled = true;
    try {
      await q(sb().rpc("set_sheet_status", {
        p_sheet_number: sheetNumber, p_is_closed: closing, p_reason: reason,
        p_expected_updated_at: state.sheetStatus.get(sheetNumber)?.updated_at ?? null
      }));
      await afterSave(closing ? `גיליון ${sheetNumber} נסגר.` : `גיליון ${sheetNumber} נפתח מחדש.`);
    } catch (error) {
      console.error("עדכון סטטוס גיליון נכשל:", error);
      app().toast(errorText(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function renderReports() {
    const months = new Map();
    for (const order of app().orders()) {
      if (order.cancelledAt) continue;
      const key = String(order.orderDate).slice(0, 7);
      const row = months.get(key) || { count: 0, cash: 0, paid: 0, pending: 0, credits: 0 };
      row.count += 1;
      if (order.billingMode === "credits") row.credits += Number(order.creditsUsed || 0);
      else {
        const m = orderMoney(order);
        row.cash = roundMoney(row.cash + m.due);
        row.paid = roundMoney(row.paid + m.received);
        row.pending = roundMoney(row.pending + m.outstanding);
      }
      months.set(key, row);
    }
    const monthName = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" });
    $("#report-monthly-body").innerHTML = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, row]) => {
      const [year, month] = key.split("-").map(Number);
      return `<tr><td class="client-name">${escapeHtml(monthName.format(new Date(year, month - 1, 1)))}</td>
        <td>${escapeHtml(number.format(row.count))}</td><td class="amount-cell">${escapeHtml(money.format(row.cash))}</td>
        <td class="amount-cell">${escapeHtml(money.format(row.paid))}</td><td class="amount-cell">${escapeHtml(money.format(row.pending))}</td>
        <td>${escapeHtml(number.format(row.credits))}</td></tr>`;
    }).join("") || '<tr><td colspan="6" class="empty-cell">אין הזמנות.</td></tr>';
    if (!state.ready || !state.loaded) return;
    // Totals from the same rows as the payments screen and the dashboard (orders + package installments).
    const rows = obligationRows();
    const total = (pick) => money.format(roundMoney(rows.reduce((sum, row) => sum + pick(row), 0)));
    $("#report-billed").textContent = total((row) => (row.cancelled ? row.received : row.amount));
    $("#report-received").textContent = total((row) => row.received);
    $("#report-outstanding").textContent = total((row) => row.outstanding);
    $("#report-overdue").textContent = total((row) => (row.kind === "overdue" ? row.outstanding : 0));
  }

  function renderSettings() {
    const vatField = $("#vat-form").elements.vat;
    if (document.activeElement !== vatField) vatField.value = roundMoney(state.vatRate * 100);
    $("#products-body").innerHTML = state.allProducts.map((product) => `<tr>
      <td class="client-name">${escapeHtml(product.name)}${app().hasEncodingDamage(product.name) ? ` ${pill("pending", "קידוד שגוי")}` : ""}</td>
      <td>${escapeHtml(product.dimensions || "—")}</td>
      <td class="amount-cell">${escapeHtml(product.base_price_before_vat != null ? money.format(product.base_price_before_vat) : "—")}</td>
      <td>${escapeHtml(product.credit_cost != null ? number.format(product.credit_cost) : "—")}</td>
      <td>${pill(product.is_active ? "paid" : "pending", product.is_active ? "פעיל" : "לא פעיל")}</td>
      <td><button class="button button-outline client-action" type="button" data-product-edit="${escapeHtml(product.id)}">עריכה</button></td>
    </tr>`).join("");
    $("#products-empty").hidden = state.allProducts.length !== 0;
  }

  // ---------- after a successful write ----------
  async function afterSave(message) {
    try {
      await app().refresh();
      await loadBusinessData();
      app().reportSyncIssue("business", null);
      renderCurrent();
      app().toast(message);
    } catch (error) {
      console.error("רענון לאחר שמירה נכשל:", error);
      app().reportSyncIssue("business", BUSINESS_SYNC_ERROR);
      app().toast(`${message} הרענון נכשל — רענני את הדף לצפייה בנתונים העדכניים.`, true);
    }
  }

  // ---------- payments ----------
  async function setObligationPaid(obligationId, expected, isPaid) {
    let reason = "סומן כשולם";
    if (!isPaid) {
      const answer = await app().ask({ kicker: "ביטול סימון תשלום", title: "להחזיר את החיוב למצב ממתין?",
        message: "החיוב יופיע שוב כממתין לתשלום.", confirmText: "ביטול הסימון", reason: { label: "סיבה", min: 1 } });
      if (!answer) return false;
      reason = answer.reason;
    }
    try {
      await q(sb().rpc("set_obligation_paid", {
        p_obligation_id: obligationId, p_is_paid: isPaid, p_reason: reason,
        p_expected_updated_at: expected, p_idempotency_key: crypto.randomUUID()
      }));
    } catch (error) {
      console.error("עדכון תשלום נכשל:", error);
      app().toast(errorText(error), true);
      return false;
    }
    await afterSave(isPaid ? "התשלום סומן כשולם ונשמר." : "התשלום נפתח מחדש ונשמר.");
    return true;
  }

  async function setOrderPaid(order, isPaid) {
    const obligation = state.obligations.find((item) => item.order_id === order.id);
    if (!obligation) {
      app().toast("להזמנה זו אין רשומת חיוב במערכת העסקית, ולכן לא ניתן לעדכן את התשלום כאן.", true);
      return false;
    }
    return setObligationPaid(obligation.id, order.updatedAt, isPaid);
  }

  async function deleteOrder(order) {
    try {
      await q(sb().rpc("delete_business_order", {
        p_order_id: order.id, p_expected_updated_at: order.updatedAt,
        p_reason: "מחיקה מרשימת ההזמנות", p_idempotency_key: crypto.randomUUID()
      }));
      await afterSave("ההזמנה נמחקה.");
    } catch (error) {
      console.error("מחיקת הזמנה נכשלה:", error);
      app().toast(errorText(error), true);
    }
  }

  // ---------- package purchase (dialog) ----------
  function packageFormValues() {
    const form = $("#biz-package-form");
    const choice = $("#biz-package-select").value;
    const template = state.catalog.find((item) => item.id === choice) || null;
    const custom = choice === "custom";
    const pkg = template
      ? { name: template.name, credits: Number(template.credits), term: Number(template.term_months), price: Number(template.total_price_before_vat) }
      : { name: form.elements.custom_name.value.trim(), credits: Number(form.elements.custom_credits.value), term: Number(form.elements.custom_term.value), price: Number(form.elements.custom_price.value) };
    const count = Number(form.elements.installment_count.value);
    const startsOn = form.elements.starts_on.value;
    const valid = Boolean(template || custom) && Boolean(pkg.name) && pkg.credits > 0 && roundMoney(pkg.credits) === pkg.credits
      && Number.isInteger(pkg.term) && pkg.term > 0 && pkg.price > 0 && roundMoney(pkg.price) === pkg.price
      && Number.isInteger(count) && count >= 1 && count <= 60 && pkg.price / count >= 0.01 && /^\d{4}-\d{2}-\d{2}$/.test(startsOn);
    return { template, custom, pkg, count, startsOn, valid };
  }

  function updatePackageSummary(resetCount = false) {
    const form = $("#biz-package-form");
    const choice = $("#biz-package-select").value;
    const template = state.catalog.find((item) => item.id === choice) || null;
    const custom = choice === "custom";
    $("#biz-custom-package-fields").hidden = !custom;
    for (const name of ["custom_name", "custom_credits", "custom_term", "custom_price"]) form.elements[name].required = custom;
    if (resetCount) form.elements.installment_count.value = template ? template.default_installment_count : 1;
    $("#biz-package-details").textContent = template
      ? `${template.name}: ${number.format(template.credits)} קרדיטים · ${number.format(template.term_months)} חודשים · ${money.format(template.total_price_before_vat)} לפני מע"מ`
      : custom ? "חבילה מותאמת אישית: הזינו קרדיטים, תקופה ומחיר לפני מע\"מ." : "בחרו חבילה.";
    const values = packageFormValues();
    $("#biz-package-schedule-toggle").hidden = !values.valid;
    if (!values.valid) { $("#biz-package-summary").textContent = "לוח התשלומים יוצג כאן לאחר מילוי פרטי החבילה."; return; }
    // A change of package, price, count or start date rebuilds the automatic schedule (manual edits start over).
    const shape = JSON.stringify([values.pkg.price, values.count, values.startsOn]);
    if (purchaseSchedule.shape !== shape) { purchaseSchedule.shape = shape; purchaseSchedule.touched = false; }
    refreshPurchaseSchedule(values);
    renderPurchaseSummary(values);
  }
  // Compact by default: package, credits, price and one line about the payments.
  function renderPurchaseSummary(values) {
    const rows = purchaseSchedule.rows;
    const total = roundMoney(rows.reduce((sum, row) => sum + (Number(row.net) > 0 ? gross(row.net) : 0), 0));
    const first = rows[0]; const last = rows[rows.length - 1];
    const equal = rows.length > 1 && rows.slice(0, -1).every((row) => row.net === rows[0].net);
    const payments = rows.length === 1 ? `תשלום אחד ב-${displayDate(first.due)}`
      : `${number.format(rows.length)} תשלומים${equal ? ` של ${money.format(gross(rows[0].net))}` : ""} · ${displayDate(first.due)} עד ${displayDate(last.due)}`;
    $("#biz-package-summary").textContent = `${number.format(values.pkg.credits)} קרדיטים יתווספו מיד ואינם פוקעים · ${money.format(values.pkg.price)} לפני מע״מ · ${money.format(total)} כולל מע״מ · ${payments}${purchaseSchedule.touched ? " · לוח מותאם" : ""}`;
  }

  function openPackage(clientId) {
    const client = app().clients().find((item) => item.id === clientId);
    if (!client) return;
    state.modalClientId = clientId;
    const form = $("#biz-package-form");
    form.reset();
    $("#biz-package-select").innerHTML = `<option value="">בחירת חבילה</option>${state.catalog.map((item) =>
      `<option value="${escapeHtml(item.id)}">${escapeHtml(`${item.name} — ${number.format(item.credits)} קרדיטים`)}</option>`).join("")}<option value="custom">חבילה מותאמת אישית</option>`;
    form.elements.starts_on.value = localDateValue();
    $("#biz-package-client").textContent = `לקוח: ${client.name}`;
    $("#biz-package-message").textContent = "";
    newKey("package");
    Object.assign(purchaseSchedule, { rows: [], touched: false, shape: "" });
    $("#biz-package-schedule").hidden = true;
    $("#biz-package-schedule-toggle").setAttribute("aria-expanded", "false");
    $("#biz-package-schedule-toggle").textContent = "עריכת מועדים וסכומים";
    updatePackageSummary(true);
    $("#biz-package-modal").showModal();
  }

  async function submitPackage(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $("#biz-package-message");
    if (!form.reportValidity()) return;
    const values = packageFormValues();
    if (!values.valid) { message.textContent = "פרטי החבילה אינם תקינים. בדקו קרדיטים, תקופה, מחיר ומספר תשלומים (1–60)."; return; }
    const problems = scheduleProblems(purchaseSchedule);
    if (problems.length) {
      message.textContent = `לוח התשלומים אינו תקין: ${problems.join(" ")}`;
      $("#biz-package-schedule").hidden = false;
      renderScheduleEditor($("#biz-package-schedule"), purchaseSchedule);
      return;
    }
    const button = $("#biz-package-submit");
    setBusy(button, true, "שמירת רכישה");
    message.textContent = "";
    try {
      await q(sb().rpc("purchase_customer_package", {
        p_client_id: state.modalClientId,
        p_package_id: values.template ? values.template.id : null,
        p_custom_name: values.custom ? values.pkg.name : null,
        p_credits: values.custom ? values.pkg.credits : null,
        p_term_months: values.custom ? values.pkg.term : null,
        p_price_before_vat: values.custom ? values.pkg.price : null,
        p_starts_on: values.startsOn,
        p_ends_on: packageEndDate(values.startsOn, values.pkg.term),
        p_installments: purchaseSchedule.rows.map((row) => ({ due_on: row.due, amount_before_vat: row.net })),
        p_benefits: values.custom ? [] : null,
        p_notes: form.elements.notes.value.trim(),
        p_idempotency_key: state.keys.package
      }));
      $("#biz-package-modal").close();
      newKey("package");
      await afterSave(`החבילה "${values.pkg.name}" נשמרה: ${number.format(values.pkg.credits)} קרדיטים הוקצו.`);
    } catch (error) {
      console.error("רכישת חבילה נכשלה:", error);
      message.textContent = errorText(error);
    } finally {
      setBusy(button, false, "שמירת רכישה");
    }
  }

  // ---------- credit adjustment (dialog) ----------
  function openCredits(clientId) {
    const client = app().clients().find((item) => item.id === clientId);
    if (!client) return;
    state.modalClientId = clientId;
    $("#biz-credit-form").reset();
    $("#biz-credit-client").textContent = `לקוח: ${client.name} · יתרה נוכחית: ${number.format(state.balances.get(clientId) ?? 0)}`;
    $("#biz-credit-message").textContent = "";
    newKey("credits");
    $("#biz-credit-modal").showModal();
  }

  async function submitCredits(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const delta = Number(form.elements.delta.value);
    const reason = form.elements.reason.value.trim();
    const message = $("#biz-credit-message");
    if (!delta || roundMoney(delta) !== delta || reason.length < 3) { message.textContent = "יש להזין כמות שאינה אפס (עד שתי ספרות אחרי הנקודה) וסיבה של 3 תווים לפחות."; return; }
    const button = $("#biz-credit-submit");
    setBusy(button, true, "שמירת תנועה");
    message.textContent = "";
    try {
      const balance = await q(sb().rpc("adjust_client_credits", {
        p_client_id: state.modalClientId, p_delta: delta, p_reason: reason, p_idempotency_key: state.keys.credits
      }));
      $("#biz-credit-modal").close();
      newKey("credits");
      await afterSave(`תנועת הקרדיטים נשמרה. יתרה חדשה: ${number.format(Number(balance))}.`);
    } catch (error) {
      console.error("התאמת קרדיטים נכשלה:", error);
      message.textContent = errorText(error);
    } finally {
      setBusy(button, false, "שמירת תנועה");
    }
  }

  // ---------- new order page (multi-row, one atomic batch) ----------
  function productOptions(selected = "") {
    return `<option value="">בחירת מוצר</option>${state.products.map((product) =>
      `<option value="${escapeHtml(product.id)}" ${product.id === selected ? "selected" : ""}>${escapeHtml(product.name)}</option>`).join("")}`;
  }

  function rowMarkup(values = {}) {
    // Each order line is laid out as a two-line card (see .entry-table in styles.css), so all fields fit
    // without horizontal scrolling; data-label shows the field name above each input.
    return `<tr data-order-row>
      <td class="row-number"></td>
      <td class="cell-sheet" data-label="גיליון *"><input name="sheet_number" maxlength="80" list="sheet-options" inputmode="numeric" value="${escapeHtml(values.sheet_number || "")}" aria-label="מספר גיליון"></td>
      ${v3()
        ? `<td class="cell-product" data-label="פירוט הזמנה *"><input name="ad_description" maxlength="500" value="${escapeHtml(values.ad_description || "")}" aria-label="פירוט הזמנה" placeholder="מה מפרסמים, גודל, מיקום"></td>`
        : `<td class="cell-product" data-label="מוצר *"><select name="product_id" aria-label="מוצר">${productOptions(values.product_id)}</select></td>`}
      <td class="cell-price" data-label="מחיר לפני מע״מ"><input name="cash_amount_before_vat" type="number" min="0.01" step="0.01" value="${escapeHtml(values.cash_amount_before_vat || "")}" aria-label="מחיר לפני מע״מ"></td>
      <td class="cell-credits" data-label="או קרדיטים"><input name="credits_used" type="number" min="0.01" step="0.01" value="${escapeHtml(values.credits_used || "")}" aria-label="קרדיטים"></td>
      <td class="cell-status" data-label="סטטוס תשלום"><select name="payment_status" aria-label="סטטוס תשלום"><option value="pending">עדיין לא</option><option value="paid" ${values.payment_status === "paid" ? "selected" : ""}>שולם</option></select></td>
      <td class="cell-due" data-label="מועד פירעון"><input name="due_on" type="date" value="${escapeHtml(values.due_on || "")}" aria-label="מועד פירעון"></td>
      <td class="cell-notes" data-label="הערות"><input name="notes" maxlength="300" value="${escapeHtml(values.notes || "")}" aria-label="הערות"></td>
      <td class="client-actions cell-actions"><button class="button button-outline client-action" type="button" data-row-copy>שכפול</button><button class="delete-order" type="button" data-row-remove aria-label="הסרת שורה">×</button></td>
    </tr>`;
  }

  function rowValues(row) {
    const values = {};
    for (const field of row.querySelectorAll("input, select")) values[field.name] = field.value.trim();
    return values;
  }

  function addOrderRow(values) {
    const body = $("#new-order-rows");
    if (body.children.length >= MAX_ROWS) { app().toast(`אפשר עד ${MAX_ROWS} שורות בהזמנה אחת.`, true); return; }
    body.insertAdjacentHTML("beforeend", rowMarkup(values));
    updateNewOrder();
  }

  function populateClientSelect(selected) {
    const query = $("#new-order-client-search").value.trim().toLocaleLowerCase("he");
    const clients = [...app().clients()].sort((a, b) => a.name.localeCompare(b.name, "he"))
      .filter((client) => client.id === selected || `${client.name} ${client.phone}`.toLocaleLowerCase("he").includes(query));
    $("#new-order-client").innerHTML = `<option value="">בחירת לקוח</option>${clients.map((client) =>
      `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}</option>`).join("")}`;
    $("#new-order-client").value = selected || "";
  }

  function resetNewOrder(clientId = "") {
    $("#new-order-form").reset();
    $("#new-order-rows").innerHTML = "";
    $("#new-order-message").textContent = "";
    newKey("order");
    populateClientSelect(clientId);
    addOrderRow();
  }

  function prepareNewOrder(clientId) {
    const body = $("#new-order-rows");
    // Every sheet that is open for orders, also an empty planned sheet (sheets model v2).
    $("#sheet-options").innerHTML = (state.loaded ? sheetBoard().filter((sheet) => !sheet.closed).map((sheet) => sheet.number).sort(compareSheets).reverse() : [])
      .map((sheet) => `<option value="${escapeHtml(sheet)}"></option>`).join("");
    if (state.presetSheet) {
      const sheet = state.presetSheet;
      state.presetSheet = "";
      $("#new-order-result").hidden = true;
      resetNewOrder(clientId);
      body.querySelector('[name="sheet_number"]').value = sheet;
    } else if (!body.children.length || (clientId && $("#new-order-client").value !== clientId)) {
      $("#new-order-result").hidden = true;
      resetNewOrder(clientId);
    } else {
      // keep the rows being typed; refresh product lists in case the catalog changed (model v2)
      for (const select of body.querySelectorAll('select[name="product_id"]')) {
        const value = select.value; select.innerHTML = productOptions(value);
      }
      populateClientSelect($("#new-order-client").value);
    }
    updateNewOrder();
  }

  function updateNewOrder() {
    const rows = $$("#new-order-rows [data-order-row]");
    rows.forEach((row, index) => {
      row.querySelector(".row-number").textContent = String(index + 1);
      const credits = Number(row.querySelector('[name="credits_used"]').value) > 0;
      const status = row.querySelector('[name="payment_status"]');
      // Credit rows are always "paid"; when the row switches back to cash, return to an explicit "not yet".
      if (credits) status.value = "paid";
      else if (status.disabled) status.value = "pending";
      status.disabled = credits;
      row.querySelector('[name="due_on"]').disabled = credits;
    });
    $("#new-order-row-count").textContent = `${number.format(rows.length)} שורות`;
    const values = rows.map(rowValues);
    const closedSheets = [...new Set(values.map((row) => row.sheet_number).filter((sheet) => sheet && sheetClosed(sheet)))];
    $("#new-order-sheet-warning").hidden = closedSheets.length === 0;
    $("#new-order-sheet-warning").textContent = closedSheets.length
      ? `שימי לב: גיליון ${closedSheets.join(", ")} מסומן כסגור. אפשר לשמור, אבל ודאי שזו הכוונה.` : "";
    const cash = values.filter((row) => Number(row.cash_amount_before_vat) > 0).reduce((sum, row) => sum + Number(row.cash_amount_before_vat), 0);
    const cashGross = values.filter((row) => Number(row.cash_amount_before_vat) > 0).reduce((sum, row) => sum + gross(Number(row.cash_amount_before_vat)), 0);
    const credits = values.reduce((sum, row) => sum + (Number(row.credits_used) || 0), 0);
    const clientId = $("#new-order-client").value;
    const balance = state.balances.get(clientId) ?? 0;
    $("#new-order-credit-note").textContent = clientId ? `יתרת קרדיטים נוכחית: ${number.format(balance)}${activePackage(clientId) ? " · לקוח פרימיום" : ""}` : "";
    $("#new-order-summary").innerHTML = `
      <div><span>הזמנות</span><strong>${escapeHtml(number.format(rows.length))}</strong></div>
      <div><span>לפני מע"מ</span><strong>${escapeHtml(money.format(cash))}</strong></div>
      <div><span>כולל מע"מ (${escapeHtml(number.format(state.vatRate * 100))}%)</span><strong>${escapeHtml(money.format(cashGross))}</strong></div>
      <div><span>קרדיטים</span><strong>${escapeHtml(number.format(credits))}</strong></div>
      <div><span>יתרה אחרי השמירה</span><strong class="${balance - credits < 0 ? "negative" : ""}" dir="ltr">${escapeHtml(number.format(roundMoney(balance - credits)))}</strong></div>`;
    // A negative balance is allowed (credits never expire); it only gets a gentle note and a way to a new package.
    const after = roundMoney(balance - credits);
    const alert = $("#new-order-credit-alert");
    alert.hidden = !(clientId && credits > 0 && after < 0);
    if (!alert.hidden) {
      alert.innerHTML = `לאחר השמירה יתרת הקרדיטים תהיה <strong dir="ltr">${escapeHtml(number.format(after))}</strong>. אפשר לשמור גם ביתרה שלילית. <button class="link-button" type="button" data-biz-package="${escapeHtml(clientId)}">רכישת חבילה ללקוח</button>`;
    }
    $("#new-order-item-head").textContent = v3() ? "פירוט הזמנה *" : "מוצר *";
    // Model v2 needs an active product per row; model v3 has a free description instead.
    const needsProducts = !v3();
    const noProducts = "אין מוצרים פעילים בקטלוג. הוסיפו מוצר במסך \"הגדרות ומוצרים\".";
    $("#new-order-submit").disabled = needsProducts && state.products.length === 0;
    if (needsProducts && !state.products.length) $("#new-order-message").textContent = noProducts;
    else if ($("#new-order-message").textContent === noProducts) $("#new-order-message").textContent = "";
  }

  function applySequence() {
    const start = Number($("#new-order-sequence").value);
    if (!Number.isSafeInteger(start) || start < 1) { app().toast("יש להזין מספר גיליון ראשון חיובי ושלם.", true); return; }
    $$("#new-order-rows [data-order-row]").forEach((row, index) => { row.querySelector('[name="sheet_number"]').value = String(start + index); });
  }

  async function submitNewOrder(event) {
    event.preventDefault();
    const message = $("#new-order-message");
    const clientId = $("#new-order-client").value;
    if (!clientId) { message.textContent = "יש לבחור לקוח."; $("#new-order-client").focus(); return; }
    const rows = $$("#new-order-rows [data-order-row]");
    if (!rows.length) { message.textContent = "יש להוסיף לפחות שורה אחת."; return; }
    const orders = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rowValues(rows[index]);
      const line = `בשורה ${index + 1}: `;
      if (!row.sheet_number) { message.textContent = `${line}חסר מספר גיליון.`; return; }
      if (v3()) {
        if (!row.ad_description) { message.textContent = `${line}חסר פירוט הזמנה.`; return; }
        if (app().hasEncodingDamage(row.ad_description)) { message.textContent = `${line}הפירוט נראה משובש (בעיית קידוד עברית). הקלידי אותו מחדש.`; return; }
      } else if (!row.product_id) { message.textContent = `${line}יש לבחור מוצר.`; return; }
      if (app().hasEncodingDamage(row.notes)) { message.textContent = `${line}ההערה נראית משובשת (בעיית קידוד עברית). הקלידי אותה מחדש.`; return; }
      const cash = row.cash_amount_before_vat; const credits = row.credits_used;
      if (Boolean(cash) === Boolean(credits)) { message.textContent = `${line}יש למלא מחיר או קרדיטים — בדיוק אחד מהם.`; return; }
      const amount = Number(cash || credits);
      if (!(amount > 0) || roundMoney(amount) !== amount) { message.textContent = `${line}הסכום חייב להיות חיובי ועד שתי ספרות אחרי הנקודה.`; return; }
      orders.push({
        // No publication dates at the newspaper: the RPC still requires the legacy column, so the order date is sent.
        sheet_number: row.sheet_number, publication_date: localDateValue(),
        ...(v3() ? { ad_description: row.ad_description } : { product_id: row.product_id }),
        cash_amount_before_vat: cash ? Number(cash) : null, credits_used: credits ? Number(credits) : null,
        payment_status: credits ? "paid" : row.payment_status, due_on: credits ? null : (row.due_on || null), notes: row.notes
      });
    }
    const button = $("#new-order-submit");
    setBusy(button, true, "שמירת ההזמנות");
    message.textContent = "";
    try {
      const result = await q(sb().rpc("create_orders_batch", { p_client_id: clientId, p_orders: orders, p_idempotency_key: state.keys.order }));
      const saved = Array.isArray(result) ? result : [];
      const lastCredit = [...saved].reverse().find((item) => item.billing_mode === "credits");
      const resultBox = $("#new-order-result");
      resultBox.hidden = false;
      resultBox.innerHTML = `נשמרו ${escapeHtml(number.format(saved.length))} הזמנות ל${escapeHtml(clientName(clientId))}: ${saved.map((item) => `#${escapeHtml(item.order_number)}`).join(", ")}.`
        + (lastCredit ? ` יתרת קרדיטים: ${escapeHtml(number.format(Number(lastCredit.credit_balance_after)))}.` : "")
        + ` <button class="link-button" type="button" data-client-view="${escapeHtml(clientId)}">לתיק הלקוח</button>`;
      resetNewOrder(clientId);
      await afterSave(`נשמרו ${number.format(saved.length)} הזמנות.`);
    } catch (error) {
      console.error("שמירת הזמנות נכשלה:", error);
      message.textContent = `${errorText(error)} שום הזמנה לא נשמרה; אפשר לתקן ולנסות שוב.`;
    } finally {
      setBusy(button, false, "שמירת ההזמנות");
      $("#new-order-submit").disabled = !v3() && state.products.length === 0;
    }
  }

  // ---------- settings: VAT + products ----------
  async function submitVat(event) {
    event.preventDefault();
    const value = Number(event.currentTarget.elements.vat.value);
    const message = $("#vat-message");
    if (!(value >= 0 && value <= 100)) { message.textContent = "שיעור המע\"מ חייב להיות בין 0 ל-100."; return; }
    const button = $("#vat-submit");
    setBusy(button, true, "שמירת שיעור");
    message.textContent = "";
    try {
      await q(sb().rpc("set_business_vat_rate", { p_vat_rate: roundMoney(value) / 100 }));
      await loadReference();
      renderSettings();
      app().toast(`שיעור המע"מ נשמר: ${number.format(value)}%.`);
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      setBusy(button, false, "שמירת שיעור");
    }
  }

  function openProduct(productId = null) {
    const product = state.allProducts.find((item) => item.id === productId) || null;
    state.editingProductId = product ? product.id : null;
    const form = $("#biz-product-form");
    form.reset();
    $("#biz-product-title").textContent = product ? "עריכת מוצר" : "מוצר חדש";
    if (product) {
      form.elements.name.value = product.name;
      form.elements.dimensions.value = product.dimensions || "";
      form.elements.price.value = product.base_price_before_vat ?? "";
      form.elements.credits.value = product.credit_cost ?? "";
      form.elements.active.checked = product.is_active;
    }
    $("#biz-product-message").textContent = "";
    $("#biz-product-modal").showModal();
  }

  async function submitProduct(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const price = form.elements.price.value ? Number(form.elements.price.value) : null;
    const credits = form.elements.credits.value ? Number(form.elements.credits.value) : null;
    const active = form.elements.active.checked;
    const message = $("#biz-product-message");
    if (active && (price == null || credits == null)) { message.textContent = "מוצר פעיל חייב מחיר ועלות בקרדיטים."; return; }
    if ([form.elements.name.value, form.elements.dimensions.value].some(app().hasEncodingDamage)) {
      message.textContent = "הטקסט נראה משובש (בעיית קידוד עברית). הקלידו את שם המוצר מחדש בעברית; אל תדביקו טקסט משובש.";
      return;
    }
    const button = $("#biz-product-submit");
    setBusy(button, true, "שמירת מוצר");
    message.textContent = "";
    try {
      await q(sb().rpc("save_product_catalog_item", {
        p_product_id: state.editingProductId, p_name: form.elements.name.value.trim(), p_dimensions: form.elements.dimensions.value.trim(),
        p_base_price_before_vat: price, p_credit_cost: credits, p_is_active: active
      }));
      $("#biz-product-modal").close();
      await loadReference();
      renderSettings();
      app().toast("המוצר נשמר.");
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      setBusy(button, false, "שמירת מוצר");
    }
  }

  // ---------- orders table: 13 columns, filters, sorting, double-click editing, cancellation ----------
  // Text cells sort with Hebrew collation, numbers numerically. Editing (model v3 only) goes through the RPCs:
  // update_order_details (description, sheet, statuses, notes) and update_order_charge (price / credits).
  const ORDER_COLUMNS = [
    { key: "number", head: "מס׳ הזמנה", sort: (o) => Number(o.orderNumber) || 0 },
    { key: "date", head: "תאריך הזמנה", sort: (o) => `${o.orderDate}|${String(o.orderNumber ?? "").padStart(12, "0")}` },
    { key: "enteredBy", head: "מכניס הזמנה", sort: (o) => o.enteredBy, text: true },
    { key: "client", head: "לקוח", sort: (o) => clientName(o.clientId), text: true },
    { key: "description", head: "פירוט הזמנה", edit: "details" },
    { key: "sheet", head: "גיליון", sort: (o) => Number(o.sheetNumber) || 0, edit: "details" },
    { key: "credits", head: "קרדיטים", sort: (o) => Number(o.creditsUsed) || 0, edit: "charge" },
    { key: "net", head: "מחיר לפני מע״מ", sort: (o) => Number(o.cashBeforeVat) || 0, edit: "charge" },
    { key: "gross", head: "מחיר כולל מע״מ", sort: (o) => (o.billingMode === "credits" ? 0 : Number(o.amount)) },
    { key: "pay", head: "סטטוס תשלום", sort: (o) => orderPayState(o), text: true },
    { key: "file", head: "סטטוס קובץ", sort: (o) => o.fileStatus, text: true, edit: "details" },
    { key: "placement", head: "סטטוס שיבוץ", sort: (o) => o.placementStatus, text: true, edit: "details" },
    { key: "notes", head: "הערות", edit: "details" }
  ];
  const orderById = (orderId) => app().orders().find((order) => order.id === orderId) || null;
  // May this cell be edited? Credits only on a credits order, price only on a cash order; never on legacy charges.
  function canEdit(order, key) {
    if (!v3() || !state.loaded || !order || order.cancelledAt) return false;
    const column = ORDER_COLUMNS.find((item) => item.key === key);
    if (!column || !column.edit) return false;
    if (key === "credits") return order.billingMode === "credits";
    if (key === "net") return order.billingMode === "cash";
    return true;
  }

  function orderCell(order, key) {
    const editable = canEdit(order, key);
    const attrs = editable ? ` data-edit="${key}" tabindex="0" title="לחיצה כפולה או Enter לעריכה"` : "";
    const cell = (html, cls = "") => `<td class="${cls}${editable ? " is-editable" : ""}"${attrs}>${html}</td>`;
    const legacy = order.billingMode === "legacy";
    switch (key) {
      case "number": return cell(`${escapeHtml(order.orderNumber ?? "")}${legacy ? ' <span class="tag-legacy" title="הזמנה מלפני המערכת העסקית. הסכום מוצג כפי שנשמר; לא ידוע אם הוא כולל מע״מ.">ישנה</span>' : ""}`, "order-number");
      case "date": return cell(escapeHtml(app().formatOrderDate(order.orderDate)), "cell-date");
      case "enteredBy": return cell(escapeHtml(order.enteredBy), "cell-muted");
      case "client": return cell(`<button class="link-button" type="button" data-client-view="${escapeHtml(order.clientId)}">${escapeHtml(clientName(order.clientId))}</button>`, "client-name");
      case "description": {
        if (order.description) return cell(escapeHtml(order.description), "cell-description");
        // Older orders: the product / section that was saved, shown as earlier information, not as a description.
        const earlier = order.product ? `<span class="earlier-info" title="מידע שנשמר לפני שדה הפירוט (מוצר או מדור). אינו פירוט שהוזן.">${escapeHtml(order.product)}${order.dimensions ? ` · ${escapeHtml(order.dimensions)}` : ""}</span>` : "";
        return cell(earlier, "cell-description");
      }
      case "sheet": return cell(order.sheetNumber && !editable
        ? `<button class="link-button" type="button" data-sheet-view="${escapeHtml(order.sheetNumber)}">${escapeHtml(order.sheetNumber)}</button>` : escapeHtml(order.sheetNumber), "cell-sheet");
      case "credits": return cell(order.billingMode === "credits" ? escapeHtml(number.format(order.creditsUsed)) : "", "amount-cell");
      case "net": return cell(order.billingMode === "cash" && order.cashBeforeVat != null ? escapeHtml(money.format(order.cashBeforeVat)) : "", "amount-cell");
      case "gross": {
        if (order.billingMode === "credits") return cell("", "amount-cell");
        if (legacy && !(Number(order.amount) > 0)) return cell("", "amount-cell");
        return cell(escapeHtml(money.format(order.amount)), `amount-cell${legacy ? " is-legacy" : ""}`);
      }
      case "pay": {
        const payState = orderPayState(order);
        // Model v2 (live today): the charge is marked paid / pending here, as before.
        if (!v3() && (payState === "paid" || payState === "pending")) {
          const paid = payState === "paid";
          return cell(`<select class="payment-select ${paid ? "paid" : "pending"}" data-order-id="${escapeHtml(order.id)}" aria-label="סטטוס תשלום להזמנה ${escapeHtml(order.orderNumber ?? "")}">
            <option value="paid" ${paid ? "selected" : ""}>שולם</option><option value="pending" ${!paid ? "selected" : ""}>לא שולם</option></select>`);
        }
        if (!PAY_TEXT[payState]) return cell("");
        const obligation = state.obligations.find((item) => item.order_id === order.id);
        const opens = v3() && obligation && !(payState === "cancelled" && orderMoney(order).received <= 0);
        const label = escapeHtml(PAY_TEXT[payState]);
        return cell(opens
          ? `<button class="pay-state ${PAY_TONE[payState]}" type="button" data-biz-pay-open="${escapeHtml(obligation.id)}" title="תקבולים ורישום תשלום">${label}</button>`
          : pill(PAY_TONE[payState], PAY_TEXT[payState]));
      }
      case "file": return cell(v3() && order.fileStatus ? `<span class="wf wf-${escapeHtml(order.fileStatus)}">${escapeHtml(FILE_STATUS[order.fileStatus] || "")}</span>` : "");
      case "placement": return cell(v3() && order.placementStatus ? `<span class="wf wf-${escapeHtml(order.placementStatus)}">${escapeHtml(PLACEMENT_STATUS[order.placementStatus] || "")}</span>` : "");
      case "notes": return cell(escapeHtml(order.notes), "cell-notes");
      default: return "<td></td>";
    }
  }

  function filteredOrders() {
    const query = $("#search-input").value.trim().toLocaleLowerCase("he");
    const sheet = $("#orders-sheet-filter").value;
    const pay = $("#payment-filter").value;
    const file = v3() ? $("#orders-file-filter").value : "";
    const placement = v3() ? $("#orders-placement-filter").value : "";
    const withCancelled = v3() && $("#orders-show-cancelled").checked;
    return app().orders().filter((order) => {
      if (order.cancelledAt && !withCancelled) return false;
      if (sheet && order.sheetNumber !== sheet) return false;
      if (pay !== "all" && orderPayState(order) !== pay) return false;
      if (file && order.fileStatus !== file) return false;
      if (placement && order.placementStatus !== placement) return false;
      if (!query) return true;
      // An order number is matched from its start (22105 ← "221"), text anywhere.
      if (String(order.orderNumber ?? "").startsWith(query)) return true;
      return `${clientName(order.clientId)} ${order.description} ${order.product}`.toLocaleLowerCase("he").includes(query);
    });
  }

  function sortOrders(list) {
    const { key, dir } = state.orderSort;
    const column = ORDER_COLUMNS.find((item) => item.key === key) || ORDER_COLUMNS[1];
    const sign = dir === "asc" ? 1 : -1;
    return [...list].sort((left, right) => {
      const a = column.sort(left); const b = column.sort(right);
      const result = column.text ? String(a || "").localeCompare(String(b || ""), "he", { numeric: true })
        : (a > b ? 1 : a < b ? -1 : 0);
      return sign * result || (Number(right.orderNumber) || 0) - (Number(left.orderNumber) || 0);
    });
  }

  function populateSheetFilter() {
    const select = $("#orders-sheet-filter");
    const current = select.value;
    const sheets = [...new Set([...app().orders().map((order) => order.sheetNumber).filter(Boolean), ...state.sheetStatus.keys()])]
      .sort((left, right) => compareSheets(left, right));
    const html = `<option value="">כל הגיליונות</option>${sheets.map((sheet) => `<option value="${escapeHtml(sheet)}">גיליון ${escapeHtml(sheet)}</option>`).join("")}`;
    if (select.dataset.options !== html) { select.innerHTML = html; select.dataset.options = html; }
    select.value = sheets.includes(current) ? current : "";
  }

  function renderOrdersPage() {
    if (state.editing) return; // a cell is being edited: do not replace it under the user's hands
    const modelV3 = v3();
    $$(".orders-v3-only").forEach((element) => { element.hidden = !modelV3; });
    $("#orders-v2-note").hidden = modelV3 || !state.ready;
    populateSheetFilter();
    $("#orders-head").innerHTML = `<tr>${ORDER_COLUMNS.map((column) => {
      const active = state.orderSort.key === column.key;
      const sortAttr = active ? ` aria-sort="${state.orderSort.dir === "asc" ? "ascending" : "descending"}"` : "";
      return column.sort ? `<th scope="col"${sortAttr}><button class="sort-button${active ? " is-active" : ""}" type="button" data-order-sort="${column.key}">${escapeHtml(column.head)}<span class="sort-mark" aria-hidden="true">${active ? (state.orderSort.dir === "asc" ? "▲" : "▼") : ""}</span></button></th>`
        : `<th scope="col">${escapeHtml(column.head)}</th>`;
    }).join("")}<th scope="col"><span class="sr-only">פעולות</span></th></tr>`;
    const body = $("#orders-body");
    if (state.ready && !state.loaded) {
      body.innerHTML = loadingRow(ORDER_COLUMNS.length + 1);
      $("#empty-state").hidden = true;
      $("#orders-count").textContent = "";
      return;
    }
    const orders = sortOrders(filteredOrders());
    body.innerHTML = orders.map((order) => `<tr class="${order.cancelledAt ? "is-cancelled" : ""}" data-order-row-id="${escapeHtml(order.id)}">
      ${ORDER_COLUMNS.map((column) => orderCell(order, column.key)).join("")}
      <td class="row-actions">${modelV3 && !order.cancelledAt
        ? `<button class="link-button order-cancel" type="button" data-order-cancel="${escapeHtml(order.id)}" aria-label="ביטול הזמנה ${escapeHtml(order.orderNumber ?? "")}">ביטול</button>`
        : order.cancelledAt ? `<span class="cell-muted" title="${escapeHtml(order.cancelReason)}">בוטלה</span>` : ""}</td>
    </tr>`).join("");
    $("#empty-state").hidden = orders.length !== 0;
    const hidden = modelV3 && !$("#orders-show-cancelled").checked ? app().orders().filter((order) => order.cancelledAt).length : 0;
    $("#orders-count").textContent = `${number.format(orders.length)} ${orders.length === 1 ? "הזמנה" : "הזמנות"}${hidden ? ` · ${number.format(hidden)} מבוטלות מוסתרות` : ""}`;
  }

  // ----- double-click editing -----
  function editorMarkup(order, key) {
    const input = (value, extra = "") => `<input class="cell-input" data-edit-input value="${escapeHtml(value ?? "")}" ${extra}>`;
    const options = (map, selected) => Object.entries(map)
      .filter(([value]) => value !== "unknown" || selected === "unknown") // "unknown" cannot be chosen again
      .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
    let field;
    if (key === "description") field = input(order.description, 'maxlength="500" aria-label="פירוט הזמנה"');
    else if (key === "sheet") field = input(order.sheetNumber, 'maxlength="80" inputmode="numeric" list="sheet-options" aria-label="מספר גיליון"');
    else if (key === "notes") field = input(order.notes, 'maxlength="5000" aria-label="הערות"');
    else if (key === "credits") field = input(order.creditsUsed, 'type="number" min="0.01" step="0.01" aria-label="קרדיטים"');
    else if (key === "net") field = input(order.cashBeforeVat, 'type="number" min="0.01" step="0.01" aria-label="מחיר לפני מע״מ"');
    else if (key === "file") field = `<select class="cell-input" data-edit-input aria-label="סטטוס קובץ">${options(FILE_STATUS, order.fileStatus)}</select>`;
    else field = `<select class="cell-input" data-edit-input aria-label="סטטוס שיבוץ">${options(PLACEMENT_STATUS, order.placementStatus)}</select>`;
    const hint = key === "net" ? `<span class="cell-hint" data-edit-hint></span>` : "";
    return `<div class="cell-editor">${field}<span class="cell-editor-actions"><button class="cell-save" type="button" data-edit-save title="שמירה (Enter)">שמירה</button><button class="cell-cancel" type="button" data-edit-cancel title="ביטול (Esc)">ביטול</button></span>${hint}<span class="cell-error" data-edit-error role="alert"></span></div>`;
  }
  function startEdit(td) {
    const row = td.closest("[data-order-row-id]");
    const order = orderById(row?.dataset.orderRowId);
    const key = td.dataset.edit;
    if (!canEdit(order, key) || state.editing) return;
    state.editing = { orderId: order.id, key };
    td.classList.add("is-editing");
    td.innerHTML = editorMarkup(order, key);
    const field = $("[data-edit-input]", td);
    field.focus();
    if (field.select && field.tagName === "INPUT") field.select();
    if (key === "net") updateNetHint(td, order);
  }
  function updateNetHint(td, order) {
    const value = Number($("[data-edit-input]", td).value);
    const hint = $("[data-edit-hint]", td);
    if (hint) hint.textContent = value > 0 ? `כולל מע״מ: ${money.format(roundMoney(value * (1 + Number(order.vatRate ?? state.vatRate))))}` : "";
  }
  // Leaving the editor after a conflict reloads the data (as the message promises), so the next edit uses the
  // current version instead of failing again.
  function endEdit() {
    const stale = Boolean(state.editing?.stale);
    state.editing = null;
    renderOrdersPage();
    if (stale) {
      app().refresh().then(() => loadBusinessData()).then(() => renderCurrent()).catch((error) => {
        console.error("רענון אחרי התנגשות נכשל:", error);
        app().toast(`רענון הנתונים נכשל: ${errorText(error)}`, true);
      });
    }
  }
  async function saveEdit(td) {
    const editing = state.editing;
    const order = editing && orderById(editing.orderId);
    if (!order) { endEdit(); return; }
    const raw = $("[data-edit-input]", td).value;
    const value = typeof raw === "string" ? raw.trim() : raw;
    const errorBox = $("[data-edit-error]", td);
    const fail = (message) => { errorBox.textContent = message; $("[data-edit-input]", td).focus(); };
    const key = editing.key;
    try {
      if (key === "credits" || key === "net") {
        const amount = Number(value);
        if (!(amount > 0) || roundMoney(amount) !== amount) { fail("יש להזין מספר חיובי, עד שתי ספרות אחרי הנקודה."); return; }
        if (amount === Number(key === "net" ? order.cashBeforeVat : order.creditsUsed)) { endEdit(); return; }
        td.classList.add("is-saving");
        await q(sb().rpc("update_order_charge", {
          p_order_id: order.id, p_expected_updated_at: order.updatedAt,
          p_cash_amount_before_vat: key === "net" ? amount : null, p_credits_used: key === "credits" ? amount : null,
          p_idempotency_key: crypto.randomUUID()
        }));
      } else {
        if (key === "description" && !value && order.description) { fail("פירוט ההזמנה הוא שדה חובה."); return; }
        if (key === "description" && app().hasEncodingDamage(value)) { fail("הטקסט נראה משובש (בעיית קידוד עברית). הקלידי אותו מחדש."); return; }
        if (key === "sheet" && !value && order.sheetNumber) { fail("אי אפשר להסיר גיליון; אפשר להעביר לגיליון אחר."); return; }
        const next = {
          description: order.description || null, notes: order.notes || "", sheet: order.sheetNumber || null,
          file: order.fileStatus, placement: order.placementStatus
        };
        const before = JSON.stringify(next);
        next[key] = key === "notes" ? value : (value || null);
        if (JSON.stringify(next) === before) { endEdit(); return; }
        td.classList.add("is-saving");
        await q(sb().rpc("update_order_details", {
          p_order_id: order.id, p_expected_updated_at: order.updatedAt,
          p_ad_description: next.description, p_notes: next.notes, p_sheet_number: next.sheet,
          p_file_status: next.file, p_placement_status: next.placement, p_idempotency_key: crypto.randomUUID()
        }));
      }
      state.editing = null;
      await afterSave(`הזמנה ${order.orderNumber} עודכנה.`);
    } catch (error) {
      td.classList.remove("is-saving");
      console.error("עדכון הזמנה נכשל:", error);
      const stale = String(error.code || "") === "40001";
      if (stale && state.editing) state.editing.stale = true;
      fail(stale ? "ההזמנה עודכנה בינתיים במקום אחר. ביטול העריכה יטען את הנתונים העדכניים." : errorText(error));
    }
  }

  // ----- documented cancellation (instead of deletion) -----
  async function cancelOrder(orderId) {
    const order = orderById(orderId);
    if (!order || order.cancelledAt || !v3()) return;
    let consequence;
    if (order.billingMode === "credits") consequence = `${number.format(order.creditsUsed)} קרדיטים יוחזרו ליתרת הלקוח, פעם אחת בלבד.`;
    else {
      const m = orderMoney(order);
      consequence = m.received > 0
        ? `כבר התקבלו ${money.format(m.received)}. הסכום נשאר רשום; החזר כספי, אם יינתן, נרשם בנפרד ב"תקבולים".`
        : m.due > 0 ? `החיוב הפתוח (${money.format(m.due)}) יבוטל ולא ייחשב חוב.` : "";
    }
    const answer = await app().ask({ kicker: "ביטול הזמנה", title: `לבטל את הזמנה ${order.orderNumber}?`,
      message: `ההזמנה לא תימחק: היא תישאר בהיסטוריה ותסומן כמבוטלת. ${consequence}`, confirmText: "אישור הביטול", danger: true,
      reason: { label: "סיבת הביטול", min: 3, placeholder: "לדוגמה: הלקוח ביטל את הפרסום" } });
    if (!answer) return;
    try {
      const result = await q(sb().rpc("cancel_business_order", {
        p_order_id: order.id, p_expected_updated_at: order.updatedAt, p_reason: answer.reason, p_idempotency_key: crypto.randomUUID()
      }));
      const returned = Number(result?.credits_returned || 0);
      await afterSave(result?.already_cancelled ? `הזמנה ${order.orderNumber} כבר בוטלה קודם; לא בוצע שינוי.`
        : `הזמנה ${order.orderNumber} בוטלה.${returned > 0 ? ` הוחזרו ${number.format(returned)} קרדיטים.` : ""}`);
    } catch (error) {
      console.error("ביטול הזמנה נכשל:", error);
      app().toast(errorText(error), true);
    }
  }

  // ----- receipts of one charge (model v3): full or partial, each one separate; documented reversal -----
  function openPayDialog(obligationId) {
    const row = obligationRows().find((item) => item.id === obligationId);
    if (!row) { app().toast("החיוב לא נמצא. רענני את הדף.", true); return; }
    state.payObligationId = obligationId;
    newKey("pay");
    const form = $("#biz-pay-form");
    form.reset();
    $("#biz-pay-label").textContent = `${clientName(row.clientId)} · ${row.label}${row.dueOn ? ` · מועד ${displayDate(row.dueOn)}` : ""}`;
    $("#biz-pay-figures").innerHTML = [
      ["סכום החיוב", row.cancelled ? "בוטל" : money.format(row.amount)], ["התקבל", money.format(row.received)], ["יתרה לתשלום", money.format(row.outstanding)]
    ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    const open = !row.cancelled && row.outstanding > 0;
    $("#biz-pay-fields").hidden = !open;
    $("#biz-pay-notes-wrap").hidden = !open;
    $("#biz-pay-submit").hidden = !open;
    form.elements.amount.value = open ? String(row.outstanding) : "";
    form.elements.amount.max = open ? String(row.outstanding) : "";
    form.elements.received_on.value = localDateValue();
    form.elements.received_on.max = localDateValue();
    const reversed = new Set(state.events.filter((event) => event.reverses_event_id).map((event) => event.reverses_event_id));
    const events = state.events.filter((event) => event.obligation_id === obligationId);
    const lines = events.map((event) => {
      const date = displayDate(event.received_on || String(event.event_at).slice(0, 10));
      const amount = money.format(Number(event.amount));
      if (event.event_type === "payment") {
        const undo = reversed.has(event.id) ? '<span class="cell-muted">בוטל</span>'
          : `<button class="link-button" type="button" data-receipt-reverse="${escapeHtml(event.id)}">ביטול תקבול</button>`;
        return `<li><span>${escapeHtml(date)}</span><strong>${escapeHtml(amount)}</strong><span class="cell-muted">${escapeHtml(event.notes || "")}</span>${undo}</li>`;
      }
      const kind = event.event_type === "reversal" ? "ביטול / החזר" : "תיקון סטטוס";
      return `<li class="is-reversal"><span>${escapeHtml(date)}</span><strong>${escapeHtml(amount)}</strong><span class="cell-muted">${escapeHtml(`${kind}${event.notes ? `: ${event.notes}` : ""}`)}</span><span></span></li>`;
    });
    if (!events.length && row.received > 0) lines.push('<li><span>—</span><strong></strong><span class="cell-muted">סומן כשולם לפני המערכת העסקית, ללא רישום תקבול נפרד.</span><span></span></li>');
    $("#biz-pay-receipts").innerHTML = lines.length ? `<h3>תקבולים</h3><ul class="receipt-list">${lines.join("")}</ul>` : '<p class="cell-muted">עדיין לא נרשמו תקבולים לחיוב הזה.</p>';
    $("#biz-pay-message").textContent = "";
    $("#biz-pay-modal").showModal();
    if (open) form.elements.amount.focus();
  }
  async function submitPay(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const row = obligationRows().find((item) => item.id === state.payObligationId);
    const obligation = state.obligations.find((item) => item.id === state.payObligationId);
    const message = $("#biz-pay-message");
    if (!row || !obligation) { message.textContent = "החיוב לא נמצא. רענני את הדף."; return; }
    const amount = Number(form.elements.amount.value);
    const receivedOn = form.elements.received_on.value;
    if (!(amount > 0) || roundMoney(amount) !== amount) { message.textContent = "יש להזין סכום חיובי, עד שתי ספרות אחרי הנקודה."; return; }
    if (amount > row.outstanding) { message.textContent = `הסכום גבוה מהיתרה לתשלום (${money.format(row.outstanding)}).`; return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) { message.textContent = "יש לבחור תאריך תקבול."; return; }
    // The server refuses receipts dated in the future (record_obligation_payment); say so before sending.
    if (receivedOn > localDateValue()) { message.textContent = "תאריך התקבול לא יכול להיות בעתיד."; return; }
    const button = $("#biz-pay-submit");
    setBusy(button, true, "רישום התקבול");
    message.textContent = "";
    try {
      const result = await q(sb().rpc("record_obligation_payment", {
        p_obligation_id: obligation.id, p_amount: amount, p_received_on: receivedOn, p_notes: form.elements.notes.value.trim(),
        p_expected_updated_at: obligation.updated_at, p_idempotency_key: state.keys.pay
      }));
      $("#biz-pay-modal").close();
      const left = Number(result?.outstanding ?? 0);
      await afterSave(left > 0 ? `התקבול נרשם. נותרה יתרה של ${money.format(left)}.` : "התקבול נרשם. החיוב שולם במלואו.");
    } catch (error) {
      console.error("רישום תקבול נכשל:", error);
      message.textContent = String(error.code || "") === "40001" ? "החיוב עודכן בינתיים במקום אחר. סגרי את החלון ופתחי אותו מחדש." : errorText(error);
    } finally {
      setBusy(button, false, "רישום התקבול");
    }
  }
  async function reverseReceipt(eventId) {
    const receipt = state.events.find((event) => event.id === eventId);
    if (!receipt) return;
    $("#biz-pay-modal").close();
    const answer = await app().ask({ kicker: "ביטול תקבול", title: `לבטל תקבול של ${money.format(Number(receipt.amount))}?`,
      message: "התקבול המקורי נשאר בהיסטוריה, ונרשמת לצידו תנועת ביטול. משמש גם לתיעוד החזר כספי.",
      confirmText: "ביטול התקבול", danger: true, reason: { label: "סיבה", min: 3, placeholder: "לדוגמה: הצ׳ק חזר / הוחזר ללקוח" } });
    if (!answer) return;
    try {
      await q(sb().rpc("reverse_obligation_payment", { p_event_id: eventId, p_reason: answer.reason, p_idempotency_key: crypto.randomUUID() }));
      await afterSave("התקבול בוטל ונרשם בהיסטוריה.");
    } catch (error) {
      console.error("ביטול תקבול נכשל:", error);
      app().toast(errorText(error), true);
    }
  }

  // ----- payment schedule editor (purchase and later changes) -----
  // rows: { obligationId, due, net, received (incl. VAT), paid }. A fully paid row is locked; a partly paid row
  // cannot go below what was received. The rows before VAT must add up to the package price.
  function scheduleProblems(ctx) {
    const problems = [];
    if (!ctx.rows.length) problems.push("נדרש לפחות תשלום אחד.");
    if (ctx.rows.length > 60) problems.push("עד 60 תשלומים.");
    ctx.rows.forEach((row, index) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.due)) problems.push(`תשלום ${index + 1}: חסר מועד.`);
      if (!(row.net > 0) || roundMoney(row.net) !== row.net) problems.push(`תשלום ${index + 1}: סכום לא תקין.`);
      else if (row.received > 0 && roundMoney(row.net * (1 + ctx.vat)) < row.received) problems.push(`תשלום ${index + 1}: נמוך מהסכום שכבר התקבל (${money.format(row.received)}).`);
    });
    const sum = roundMoney(ctx.rows.reduce((total, row) => total + (Number(row.net) || 0), 0));
    if (sum !== ctx.price) problems.push(`סך התשלומים לפני מע״מ ${money.format(sum)}; מחיר החבילה ${money.format(ctx.price)} (${sum > ctx.price ? "עודף" : "חסר"} ${money.format(Math.abs(roundMoney(ctx.price - sum)))}).`);
    return problems;
  }
  function renderScheduleEditor(container, ctx) {
    const rows = ctx.rows.map((row, index) => `<tr${row.paid ? ' class="is-locked"' : ""}>
      <td class="row-number">${index + 1}</td>
      <td><input type="date" value="${escapeHtml(row.due)}" data-sched="due" data-index="${index}" aria-label="מועד תשלום ${index + 1}" ${row.paid ? "disabled" : ""}></td>
      <td><input type="number" min="0.01" step="0.01" value="${escapeHtml(row.net)}" data-sched="net" data-index="${index}" aria-label="סכום לפני מע״מ, תשלום ${index + 1}" ${row.paid ? "disabled" : ""}></td>
      <td class="amount-cell">${Number(row.net) > 0 ? escapeHtml(money.format(roundMoney(row.net * (1 + ctx.vat)))) : ""}</td>
      <td class="amount-cell">${row.received > 0 ? escapeHtml(money.format(row.received)) : ""}</td>
      <td>${row.paid ? '<span class="cell-muted">שולם</span>' : row.received > 0 ? "" : `<button class="delete-order" type="button" data-sched-remove="${index}" aria-label="הסרת תשלום ${index + 1}">×</button>`}</td>
    </tr>`).join("");
    const problems = scheduleProblems(ctx);
    container.innerHTML = `<table class="schedule-table"><thead><tr><th>#</th><th>מועד</th><th>לפני מע״מ</th><th>כולל מע״מ</th><th>התקבל</th><th><span class="sr-only">הסרה</span></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="schedule-actions"><button class="button button-outline client-action" type="button" data-sched-add>הוספת תשלום</button>
      <button class="button button-outline client-action" type="button" data-sched-split>חלוקה שווה של היתרה</button></div>
      <p class="schedule-check ${problems.length ? "is-error" : "is-ok"}" role="status">${escapeHtml(problems.length ? problems.join(" ") : `סך הכול ${money.format(ctx.price)} לפני מע״מ · ${ctx.rows.length} תשלומים`)}</p>`;
  }
  function scheduleInput(container, ctx, event) {
    const field = event.target.closest("[data-sched]");
    if (!field) return;
    const row = ctx.rows[Number(field.dataset.index)];
    if (field.dataset.sched === "due") row.due = field.value;
    else row.net = field.value === "" ? NaN : Number(field.value);
    ctx.touched = true;
    // Re-render only the derived parts, keeping the focused input.
    const tr = field.closest("tr");
    tr.children[3].textContent = Number(row.net) > 0 ? money.format(roundMoney(row.net * (1 + ctx.vat))) : "";
    const problems = scheduleProblems(ctx);
    const check = $(".schedule-check", container);
    check.className = `schedule-check ${problems.length ? "is-error" : "is-ok"}`;
    check.textContent = problems.length ? problems.join(" ") : `סך הכול ${money.format(ctx.price)} לפני מע״מ · ${ctx.rows.length} תשלומים`;
    ctx.onChange?.();
  }
  function scheduleClick(container, ctx, event) {
    const remove = event.target.closest("[data-sched-remove]");
    if (remove) { ctx.rows.splice(Number(remove.dataset.schedRemove), 1); }
    else if (event.target.closest("[data-sched-add]")) {
      const last = ctx.rows[ctx.rows.length - 1];
      ctx.rows.push({ obligationId: null, due: last?.due ? addMonths(last.due, 1) : localDateValue(), net: NaN, received: 0, paid: false });
    } else if (event.target.closest("[data-sched-split]")) {
      // Spread what is left after the locked (paid) rows equally over the open rows; the last absorbs rounding.
      const open = ctx.rows.filter((row) => !row.paid);
      const fixed = roundMoney(ctx.rows.filter((row) => row.paid).reduce((total, row) => total + row.net, 0));
      if (open.length) {
        const rest = roundMoney(ctx.price - fixed);
        const base = Math.floor((rest / open.length) * 100) / 100;
        open.forEach((row, index) => { row.net = index === open.length - 1 ? roundMoney(rest - base * (open.length - 1)) : base; });
      }
    } else return;
    ctx.touched = true;
    renderScheduleEditor(container, ctx);
    ctx.onChange?.();
  }

  // Purchase: the editor starts from the automatic schedule and is shown only on request.
  const purchaseSchedule = { rows: [], price: 0, vat: 0, touched: false, onChange: null };
  function refreshPurchaseSchedule(values) {
    purchaseSchedule.price = values.pkg.price;
    purchaseSchedule.vat = state.vatRate;
    if (!purchaseSchedule.touched) {
      purchaseSchedule.rows = buildInstallments(values.pkg.price, values.count, values.startsOn)
        .map((item) => ({ obligationId: null, due: item.due_on, net: item.amount_before_vat, received: 0, paid: false }));
    }
    if (!$("#biz-package-schedule").hidden) renderScheduleEditor($("#biz-package-schedule"), purchaseSchedule);
  }

  // After the purchase (model v3): edit the unpaid installments of one package.
  const editSchedule = { rows: [], price: 0, vat: 0, packageId: null, expected: null, touched: false };
  function openSchedule(packageId) {
    const pkg = state.packages.find((item) => item.id === packageId);
    if (!pkg || !v3()) return;
    const installments = new Map(state.installments.map((item) => [item.id, item]));
    const rows = state.obligations
      .filter((ob) => ob.status !== "cancelled" && installments.get(ob.package_installment_id)?.customer_package_id === packageId)
      .map((ob) => {
        const view = state.summary.get(ob.package_installment_id);
        const received = view ? Number(view.cash_received) : 0;
        const outstanding = view ? Number(view.cash_outstanding) : Number(ob.amount_due);
        return { obligationId: ob.id, due: ob.due_on, net: Number(ob.amount_before_vat ?? installments.get(ob.package_installment_id).amount_before_vat),
          received, paid: outstanding <= 0 };
      })
      .sort((a, b) => String(a.due).localeCompare(String(b.due)));
    Object.assign(editSchedule, { rows, price: Number(pkg.price_before_vat), vat: Number(pkg.vat_rate_snapshot ?? state.vatRate),
      packageId, expected: pkg.updated_at, touched: false });
    newKey("schedule");
    $("#biz-schedule-form").reset();
    $("#biz-schedule-label").textContent = `${clientName(pkg.client_id)} · ${pkg.package_name_snapshot} · מחיר ${money.format(editSchedule.price)} לפני מע״מ. תשלום ששולם במלואו נעול; תקבולים לא נמחקים.`;
    $("#biz-schedule-message").textContent = "";
    renderScheduleEditor($("#biz-schedule-editor"), editSchedule);
    $("#biz-schedule-modal").showModal();
  }
  async function submitSchedule(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $("#biz-schedule-message");
    const problems = scheduleProblems(editSchedule);
    const reason = form.elements.reason.value.trim();
    if (problems.length) { message.textContent = problems.join(" "); return; }
    if (reason.length < 3) { message.textContent = "נדרשת סיבה לשינוי (3 תווים לפחות)."; form.elements.reason.focus(); return; }
    const button = $("#biz-schedule-submit");
    setBusy(button, true, "שמירת לוח התשלומים");
    message.textContent = "";
    try {
      await q(sb().rpc("update_installment_schedule", {
        p_customer_package_id: editSchedule.packageId, p_expected_updated_at: editSchedule.expected,
        p_items: editSchedule.rows.map((row) => ({ obligation_id: row.obligationId, due_on: row.due, amount_before_vat: row.net })),
        p_reason: reason, p_idempotency_key: state.keys.schedule
      }));
      $("#biz-schedule-modal").close();
      await afterSave("לוח התשלומים עודכן.");
    } catch (error) {
      console.error("עדכון לוח תשלומים נכשל:", error);
      message.textContent = String(error.code || "") === "40001" ? "החבילה עודכנה בינתיים במקום אחר. סגרי ופתחי מחדש." : errorText(error);
    } finally {
      setBusy(button, false, "שמירת לוח התשלומים");
    }
  }

  // ---------- wiring ----------
  let refreshTimer = null;
  document.addEventListener("modaat:session-ready", async (event) => {
    state.ready = Boolean(event.detail && event.detail.business);
    if (!state.ready) { renderCurrent(); return; }
    renderCurrent();
    try {
      await loadReference();
      await loadBusinessData();
      app().reportSyncIssue("business", null);
      renderCurrent();
    } catch (error) {
      console.error("טעינת נתוני העסק נכשלה:", error);
      state.loadFailed = true;
      app().reportSyncIssue("business", BUSINESS_SYNC_ERROR);
      renderCurrent();
      app().toast(`טעינת נתוני החבילות והתשלומים נכשלה: ${errorText(error)}`, true);
    }
  });
  document.addEventListener("modaat:data", () => {
    if (!state.ready) {
      if (app().route().name === "dashboard") renderDashboard();
      return;
    }
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      Promise.all([loadReference(), loadBusinessData()]).then(([, applied]) => {
        if (!applied) return;
        app().reportSyncIssue("business", null);
        renderCurrent();
      }).catch((error) => {
        // A background refresh failure must be visible: the screens may show outdated packages, payments or sheets.
        console.error("רענון נתוני העסק נכשל:", error);
        state.loadFailed = !state.loaded;
        if (app().reportSyncIssue("business", BUSINESS_SYNC_ERROR)) {
          app().toast(`רענון נתוני התשלומים, החבילות והגיליונות נכשל: ${errorText(error)}`, true);
        }
        renderCurrent();
      });
    }, 150);
  });
  document.addEventListener("modaat:view", (event) => {
    renderCurrent();
    // A dashboard shortcut may open a list with a preset filter (applied after the screen reset its filters).
    if (deskFilter.view && event.detail && event.detail.name === deskFilter.view) {
      const select = deskFilter.select && $(deskFilter.select);
      if (select && [...select.options].some((option) => option.value === deskFilter.value)) {
        select.value = deskFilter.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      deskFilter.view = "";
    }
  });
  document.addEventListener("modaat:signed-out", () => {
    Object.assign(state, { ready: false, loaded: false, packages: [], installments: [], obligations: [], balances: new Map(), modalClientId: null,
      sheetStatus: new Map(), sheetsInstalled: false, sheetModel: null, serverOffset: 0, summary: new Map(), events: [], editing: null });
    $("#new-order-rows").innerHTML = "";
    $("#new-order-result").hidden = true;
  });

  $("#biz-package-form").addEventListener("submit", submitPackage);
  $("#biz-package-select").addEventListener("change", () => updatePackageSummary(true));
  $("#biz-package-form").addEventListener("input", (event) => {
    // Typing in the schedule editor is handled by the editor itself (it must keep the focused field).
    if (event.target.closest("#biz-package-schedule")) return;
    if (event.target.id !== "biz-package-select") updatePackageSummary(false);
  });
  $("#biz-credit-form").addEventListener("submit", submitCredits);
  $("#biz-product-form").addEventListener("submit", submitProduct);
  $("#vat-form").addEventListener("submit", submitVat);
  $("#new-order-form").addEventListener("submit", submitNewOrder);
  $("#new-order-form").addEventListener("input", (event) => {
    if (event.target.id === "new-order-client-search") populateClientSelect($("#new-order-client").value);
    updateNewOrder();
  });
  $("#new-order-client").addEventListener("change", updateNewOrder);
  $("#new-order-add-row").addEventListener("click", () => addOrderRow());
  $("#new-order-apply-sequence").addEventListener("click", applySequence);
  $("#new-order-reset").addEventListener("click", () => { $("#new-order-result").hidden = true; resetNewOrder(); });
  $("#new-order-rows").addEventListener("click", (event) => {
    const row = event.target.closest("[data-order-row]");
    if (event.target.closest("[data-row-copy]")) addOrderRow(rowValues(row));
    if (event.target.closest("[data-row-remove]")) {
      if ($$("#new-order-rows [data-order-row]").length > 1) row.remove();
      updateNewOrder();
    }
  });
  $("#packages-search").addEventListener("input", renderPackagesPage);
  $("#payments-search").addEventListener("input", renderPaymentsPage);
  $("#payments-filter").addEventListener("change", renderPaymentsPage);
  $("#product-new").addEventListener("click", () => openProduct());
  $("#sheets-search").addEventListener("input", renderSheetsPage);
  $("#sheets-add").addEventListener("click", openAddSheets);
  $("#sheets-add-form").addEventListener("input", onAddSheetsInput);
  $("#sheets-add-form").addEventListener("submit", submitAddSheets);
  // Closing times pass while the screen is open: re-evaluate once a minute (no server call).
  window.setInterval(() => {
    if (!state.loaded || document.visibilityState !== "visible") return;
    const route = app().route().name;
    if (route === "sheets") renderSheetsPage();
    if (route === "sheet") renderSheetPage(app().route().param);
  }, 60000);
  $("#sheet-toggle-status").addEventListener("click", toggleSheetStatus);
  $("#sheet-new-order").addEventListener("click", () => {
    state.presetSheet = app().route().param;
    app().navigate("new-order");
  });

  document.addEventListener("click", (event) => {
    const route = app().route();
    const desk = event.target.closest("[data-desk-go]");
    if (desk) {
      Object.assign(deskFilter, { view: desk.dataset.deskGo, select: desk.dataset.deskSelect, value: desk.dataset.deskValue });
      app().navigate(desk.dataset.deskGo);
    }
    const action = event.target.closest("[data-client-page-action]");
    if (action && route.name === "client") {
      if (action.dataset.clientPageAction === "package") openPackage(route.param);
      if (action.dataset.clientPageAction === "credits") openCredits(route.param);
      if (action.dataset.clientPageAction === "order") app().navigate("new-order", route.param);
    }
    const packageButton = event.target.closest("[data-biz-package]");
    if (packageButton) openPackage(packageButton.dataset.bizPackage);
    const creditsButton = event.target.closest("[data-biz-credits]");
    if (creditsButton) openCredits(creditsButton.dataset.bizCredits);
    const productButton = event.target.closest("[data-product-edit]");
    if (productButton) openProduct(productButton.dataset.productEdit);
    const pay = event.target.closest("[data-biz-pay]");
    if (pay) {
      pay.disabled = true;
      setObligationPaid(pay.dataset.bizPay, pay.dataset.expected, pay.dataset.bizPaid === "1")
        .finally(() => { pay.disabled = false; });
    }
  });

  // ----- orders table -----
  for (const id of ["#orders-sheet-filter", "#orders-file-filter", "#orders-placement-filter", "#orders-show-cancelled"]) {
    $(id).addEventListener("change", renderOrdersPage);
  }
  $("#orders-head").addEventListener("click", (event) => {
    const button = event.target.closest("[data-order-sort]");
    if (!button) return;
    const key = button.dataset.orderSort;
    state.orderSort = { key, dir: state.orderSort.key === key && state.orderSort.dir === "desc" ? "asc" : "desc" };
    renderOrdersPage();
  });
  const ordersBody = $("#orders-body");
  ordersBody.addEventListener("dblclick", (event) => {
    if (event.target.closest(".cell-editor, button, select")) return;
    const td = event.target.closest("td[data-edit]");
    if (td) startEdit(td);
  });
  ordersBody.addEventListener("keydown", (event) => {
    const editor = event.target.closest(".cell-editor");
    if (editor) {
      const td = editor.closest("td");
      if (event.key === "Escape") { event.preventDefault(); endEdit(); }
      if (event.key === "Enter" && event.target.matches("[data-edit-input]")) { event.preventDefault(); saveEdit(td); }
      return;
    }
    if (event.key === "Enter" && event.target.matches("td[data-edit]")) { event.preventDefault(); startEdit(event.target); }
  });
  ordersBody.addEventListener("input", (event) => {
    const td = event.target.closest("td.is-editing");
    if (td && state.editing?.key === "net") updateNetHint(td, orderById(state.editing.orderId));
  });
  ordersBody.addEventListener("click", (event) => {
    const td = event.target.closest("td.is-editing");
    if (td && event.target.closest("[data-edit-save]")) saveEdit(td);
    if (td && event.target.closest("[data-edit-cancel]")) endEdit();
    const cancel = event.target.closest("[data-order-cancel]");
    if (cancel) cancelOrder(cancel.dataset.orderCancel);
  });
  document.addEventListener("modaat:view", (event) => {
    if (event.detail?.name === "orders") return;
    state.editing = null;
    for (const id of ["#orders-sheet-filter", "#orders-file-filter", "#orders-placement-filter"]) $(id).value = "";
    $("#orders-show-cancelled").checked = false;
  });

  // ----- receipts and payment schedules -----
  $("#biz-pay-form").addEventListener("submit", submitPay);
  $("#biz-schedule-form").addEventListener("submit", submitSchedule);
  $("#biz-schedule-editor").addEventListener("input", (event) => scheduleInput($("#biz-schedule-editor"), editSchedule, event));
  $("#biz-schedule-editor").addEventListener("click", (event) => scheduleClick($("#biz-schedule-editor"), editSchedule, event));
  purchaseSchedule.onChange = () => { const values = packageFormValues(); if (values.valid) renderPurchaseSummary(values); };
  $("#biz-package-schedule").addEventListener("input", (event) => scheduleInput($("#biz-package-schedule"), purchaseSchedule, event));
  $("#biz-package-schedule").addEventListener("click", (event) => scheduleClick($("#biz-package-schedule"), purchaseSchedule, event));
  $("#biz-package-schedule-toggle").addEventListener("click", () => {
    const box = $("#biz-package-schedule");
    box.hidden = !box.hidden;
    $("#biz-package-schedule-toggle").setAttribute("aria-expanded", String(!box.hidden));
    $("#biz-package-schedule-toggle").textContent = box.hidden ? "עריכת מועדים וסכומים" : "הסתרת פירוט התשלומים";
    if (!box.hidden) renderScheduleEditor(box, purchaseSchedule);
  });
  document.addEventListener("click", (event) => {
    const payOpen = event.target.closest("[data-biz-pay-open]");
    if (payOpen) openPayDialog(payOpen.dataset.bizPayOpen);
    const reverse = event.target.closest("[data-receipt-reverse]");
    if (reverse) reverseReceipt(reverse.dataset.receiptReverse);
    const schedule = event.target.closest("[data-biz-schedule]");
    if (schedule) openSchedule(schedule.dataset.bizSchedule);
  });

  window.ModaatBusiness = Object.freeze({
    isPremium: (clientId) => state.ready && Boolean(activePackage(clientId)),
    setOrderPaid, deleteOrder, renderOrdersPage
  });
})();
