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
  const LEDGER_TYPES = { package_grant: "הקצאת חבילה", order_consumption: "ניצול בהזמנה", correction: "התאמה ידנית", conversion_reversal: "החזרה בהמרה" };

  const state = {
    ready: false, loaded: false, vatRate: 0.18, catalog: [], allProducts: [], products: [],
    packages: [], installments: [], obligations: [], balances: new Map(),
    loadToken: 0, clientToken: 0, modalClientId: null, keys: {}, editingProductId: null
  };

  // ---------- helpers ----------
  function localDateValue(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function displayDate(value) {
    if (!value) return "—";
    const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
    return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", year: "numeric" }).format(new Date(year, month - 1, day));
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
    return `<span class="payment-select ${kind === "paid" ? "paid" : "pending"}">${escapeHtml(text)}</span>`;
  }
  function loadingRow(columns) {
    return `<tr><td colspan="${columns}" class="empty-cell">טוען נתונים מהמסד…</td></tr>`;
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

  async function loadBusinessData() {
    const token = ++state.loadToken;
    const [packages, installments, obligations, balances] = await Promise.all([
      q(sb().from("customer_packages").select("id,client_id,package_name_snapshot,credits_granted,term_months,price_before_vat,gross_total,starts_on,ends_on,installment_count,benefits_snapshot,status").order("starts_on", { ascending: false })),
      q(sb().from("package_installments").select("id,customer_package_id,installment_number,due_on,amount_due").order("due_on")),
      q(sb().from("financial_obligations").select("id,order_id,package_installment_id,amount_due,due_on,status,updated_at")),
      q(sb().from("business_client_credit_balances").select("client_id,credit_balance"))
    ]);
    if (token !== state.loadToken) return false;
    Object.assign(state, { packages, installments, obligations, loaded: true });
    state.balances = new Map(balances.map((row) => [row.client_id, Number(row.credit_balance)]));
    app().rerenderClients();
    return true;
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
    for (const obligation of state.obligations) {
      let row = null;
      if (obligation.order_id) {
        const order = orders.get(obligation.order_id);
        if (!order) continue;
        row = { clientId: order.clientId, label: `הזמנה #${order.orderNumber ?? order.id} · ${order.section}`, expected: order.updatedAt, sort: order.date };
      } else {
        const installment = installments.get(obligation.package_installment_id);
        const pkg = installment && packages.get(installment.customer_package_id);
        if (!pkg) continue;
        row = { clientId: pkg.client_id, label: `${pkg.package_name_snapshot} · תשלום ${installment.installment_number}/${pkg.installment_count}`, expected: obligation.updated_at, sort: installment.due_on };
      }
      const paid = obligation.status === "paid";
      const kind = paid ? "paid" : !obligation.due_on ? "undated" : obligation.due_on < today ? "overdue" : "future";
      rows.push({ ...row, id: obligation.id, dueOn: obligation.due_on, amount: Number(obligation.amount_due), paid, kind });
    }
    return rows.sort((left, right) => String(left.dueOn || left.sort).localeCompare(String(right.dueOn || right.sort)));
  }
  const KIND_TEXT = { paid: "שולם", overdue: "באיחור", undated: "ממתין · ללא מועד", future: "עתידי" };
  function payButton(row) {
    return `<button class="button button-outline client-action" type="button" data-biz-pay="${escapeHtml(row.id)}" data-biz-paid="${row.paid ? "0" : "1"}" data-expected="${escapeHtml(row.expected)}">${row.paid ? "ביטול תשלום" : "סימון כשולם"}</button>`;
  }
  function obligationTableRows(rows, withClient) {
    return rows.map((row) => `<tr>
      ${withClient ? `<td class="client-name"><button class="link-button" type="button" data-client-view="${escapeHtml(row.clientId)}">${escapeHtml(clientName(row.clientId))}</button></td>` : ""}
      <td>${escapeHtml(row.label)}</td>
      <td>${escapeHtml(row.dueOn ? displayDate(row.dueOn) : "ללא מועד")}</td>
      <td class="amount-cell">${escapeHtml(money.format(row.amount))}</td>
      <td>${pill(row.paid ? "paid" : "pending", KIND_TEXT[row.kind])}</td>
      <td>${payButton(row)}</td>
    </tr>`).join("");
  }

  // ---------- rendering by screen ----------
  function renderCurrent() {
    const route = app().route();
    if (route.name === "reports") renderReports();
    if (!state.ready) return;
    if (route.name === "client") renderClientPage(route.param);
    if (route.name === "new-order") prepareNewOrder(route.param);
    if (route.name === "packages") renderPackagesPage();
    if (route.name === "payments") renderPaymentsPage();
    if (route.name === "settings") renderSettings();
  }

  // Client file page: summary cards + packages / payments / details tabs (orders tab is rendered by app.js).
  async function renderClientPage(clientId) {
    const pkg = state.loaded ? activePackage(clientId) : null;
    $("#client-page-premium").hidden = !pkg;
    $("#client-kpi-package").textContent = !state.loaded ? "…" : pkg ? pkg.package_name_snapshot : "אין חבילה פעילה";
    $("#client-kpi-package-foot").textContent = pkg ? `בתוקף עד ${displayDate(pkg.ends_on)}` : "";
    const balance = state.balances.get(clientId) ?? 0;
    $("#client-kpi-credits").textContent = state.loaded ? number.format(balance) : "…";
    $("#client-kpi-credits-foot").textContent = balance < 0 ? "יתרה שלילית" : "קרדיטים זמינים";
    $("#client-kpi-credits").classList.toggle("negative", balance < 0);
    const rows = obligationRows().filter((row) => row.clientId === clientId);
    const overdue = rows.filter((row) => row.kind === "overdue");
    $("#client-kpi-overdue").textContent = money.format(overdue.reduce((sum, row) => sum + row.amount, 0));
    $("#client-kpi-overdue-foot").textContent = overdue.length ? `${overdue.length} חיובים באיחור` : "אין חוב בפיגור";
    $("#client-payments-body").innerHTML = state.loaded ? obligationTableRows(rows, false) : loadingRow(5);
    $("#client-payments-empty").hidden = !state.loaded || rows.length !== 0;
    const packages = state.packages.filter((item) => item.client_id === clientId);
    $("#client-packages").innerHTML = packages.length ? packages.map((item) => {
      const benefits = Array.isArray(item.benefits_snapshot) ? item.benefits_snapshot : [];
      const active = item === pkg;
      return `<section class="orders-section package-card">
        <div class="section-heading"><div><h2>${escapeHtml(item.package_name_snapshot)} ${active ? '<span class="premium-badge">פעילה</span>' : ""}</h2>
        <p>${escapeHtml(displayDate(item.starts_on))} – ${escapeHtml(displayDate(item.ends_on))}</p></div></div>
        <div class="kv-grid">
          <span>קרדיטים שהוקצו</span><strong>${escapeHtml(number.format(item.credits_granted))}</strong>
          <span>תקופה</span><strong>${escapeHtml(number.format(item.term_months))} חודשים</strong>
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
    const sum = (kind) => all.filter((row) => row.kind === kind).reduce((total, row) => total + row.amount, 0);
    $("#payments-overdue").textContent = money.format(sum("overdue"));
    $("#payments-undated").textContent = money.format(sum("undated"));
    $("#payments-future").textContent = money.format(sum("future"));
    $("#payments-paid").textContent = money.format(sum("paid"));
    const filter = $("#payments-filter").value;
    const query = $("#payments-search").value.trim().toLocaleLowerCase("he");
    const rows = all.filter((row) => (filter === "all" || (filter === "open" ? ["overdue", "undated"].includes(row.kind) : row.kind === filter))
      && `${clientName(row.clientId)} ${row.label}`.toLocaleLowerCase("he").includes(query));
    $("#payments-body").innerHTML = state.loaded ? obligationTableRows(rows, true) : loadingRow(6);
    $("#payments-empty").hidden = !state.loaded || rows.length !== 0;
    $("#payments-count").textContent = `${number.format(rows.length)} חיובים · ${money.format(rows.reduce((total, row) => total + row.amount, 0))}`;
  }

  async function renderReports() {
    const months = new Map();
    for (const order of app().orders()) {
      const key = order.date.slice(0, 7);
      const row = months.get(key) || { count: 0, cash: 0, paid: 0, pending: 0, credits: 0 };
      row.count += 1;
      if (order.billingMode === "credits") row.credits += Number(order.creditsUsed || 0);
      else {
        row.cash += Number(order.amount);
        row[order.paymentStatus === "paid" ? "paid" : "pending"] += Number(order.amount);
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
    if (!state.ready) return;
    try {
      const totals = (await q(sb().from("business_financial_totals").select("total_cash_billed,total_cash_received,total_cash_outstanding,total_overdue")))[0] || {};
      $("#report-billed").textContent = money.format(Number(totals.total_cash_billed || 0));
      $("#report-received").textContent = money.format(Number(totals.total_cash_received || 0));
      $("#report-outstanding").textContent = money.format(Number(totals.total_cash_outstanding || 0));
      $("#report-overdue").textContent = money.format(Number(totals.total_overdue || 0));
    } catch (error) {
      app().toast(`טעינת הסיכום הכספי נכשלה: ${errorText(error)}`, true);
    }
  }

  function renderSettings() {
    const vatField = $("#vat-form").elements.vat;
    if (document.activeElement !== vatField) vatField.value = roundMoney(state.vatRate * 100);
    $("#products-body").innerHTML = state.allProducts.map((product) => `<tr>
      <td class="client-name">${escapeHtml(product.name)}</td>
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
      renderCurrent();
      app().toast(message);
    } catch (error) {
      console.error("רענון לאחר שמירה נכשל:", error);
      app().toast(`${message} הרענון נכשל — רענני את הדף לצפייה בנתונים העדכניים.`, true);
    }
  }

  // ---------- payments ----------
  async function setObligationPaid(obligationId, expected, isPaid) {
    let reason = "סומן כשולם";
    if (!isPaid) {
      reason = (window.prompt("סיבת פתיחה מחדש של תשלום שסומן כשולם:") || "").trim();
      if (!reason) { app().toast("פתיחת התשלום בוטלה: נדרשת סיבה.", true); return false; }
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
    if (!values.valid) { $("#biz-package-summary").textContent = "לוח התשלומים יוצג כאן לאחר מילוי פרטי החבילה."; return; }
    const installments = buildInstallments(values.pkg.price, values.count, values.startsOn);
    const total = installments.reduce((sum, item) => sum + gross(item.amount_before_vat), 0);
    $("#biz-package-summary").textContent = [
      `${values.pkg.name} · ${number.format(values.pkg.credits)} קרדיטים יוקצו מיד`,
      `תוקף: ${displayDate(values.startsOn)} – ${displayDate(packageEndDate(values.startsOn, values.pkg.term))}`,
      `מחיר: ${money.format(values.pkg.price)} לפני מע"מ · ${money.format(total)} כולל מע"מ`,
      ...installments.map((item, index) => `  ${index + 1}. ${displayDate(item.due_on)} — ${money.format(gross(item.amount_before_vat))}`)
    ].join("\n");
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
        p_installments: buildInstallments(values.pkg.price, values.count, values.startsOn),
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
    return `<tr data-order-row>
      <td class="row-number"></td>
      <td><input name="sheet_number" maxlength="80" value="${escapeHtml(values.sheet_number || "")}" aria-label="מספר גיליון"></td>
      <td><select name="product_id" aria-label="מוצר">${productOptions(values.product_id)}</select></td>
      <td><input name="publication_date" type="date" value="${escapeHtml(values.publication_date || localDateValue())}" aria-label="תאריך פרסום"></td>
      <td><input name="cash_amount_before_vat" type="number" min="0.01" step="0.01" value="${escapeHtml(values.cash_amount_before_vat || "")}" aria-label="מחיר לפני מע״מ"></td>
      <td><input name="credits_used" type="number" min="0.01" step="0.01" value="${escapeHtml(values.credits_used || "")}" aria-label="קרדיטים"></td>
      <td><select name="payment_status" aria-label="סטטוס תשלום"><option value="pending">עדיין לא</option><option value="paid" ${values.payment_status === "paid" ? "selected" : ""}>שולם</option></select></td>
      <td><input name="due_on" type="date" value="${escapeHtml(values.due_on || "")}" aria-label="מועד פירעון"></td>
      <td><input name="notes" maxlength="300" value="${escapeHtml(values.notes || "")}" aria-label="הערות"></td>
      <td class="client-actions"><button class="button button-outline client-action" type="button" data-row-copy>שכפול</button><button class="delete-order" type="button" data-row-remove aria-label="הסרת שורה">×</button></td>
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
    if (!body.children.length || (clientId && $("#new-order-client").value !== clientId)) {
      $("#new-order-result").hidden = true;
      resetNewOrder(clientId);
    } else {
      // keep the rows being typed; refresh product lists in case the catalog changed
      for (const select of body.querySelectorAll('[name="product_id"]')) {
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
    const noProducts = "אין מוצרים פעילים בקטלוג. הוסיפו מוצר במסך \"הגדרות ומוצרים\".";
    $("#new-order-submit").disabled = state.products.length === 0;
    if (!state.products.length) $("#new-order-message").textContent = noProducts;
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
      if (!row.product_id) { message.textContent = `${line}יש לבחור מוצר.`; return; }
      if (!row.publication_date) { message.textContent = `${line}חסר תאריך פרסום.`; return; }
      const cash = row.cash_amount_before_vat; const credits = row.credits_used;
      if (Boolean(cash) === Boolean(credits)) { message.textContent = `${line}יש למלא מחיר או קרדיטים — בדיוק אחד מהם.`; return; }
      const amount = Number(cash || credits);
      if (!(amount > 0) || roundMoney(amount) !== amount) { message.textContent = `${line}הסכום חייב להיות חיובי ועד שתי ספרות אחרי הנקודה.`; return; }
      orders.push({
        sheet_number: row.sheet_number, product_id: row.product_id, publication_date: row.publication_date,
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
      $("#new-order-submit").disabled = state.products.length === 0;
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

  // ---------- wiring ----------
  let refreshTimer = null;
  document.addEventListener("modaat:session-ready", async (event) => {
    state.ready = Boolean(event.detail && event.detail.business);
    if (!state.ready) { renderCurrent(); return; }
    renderCurrent();
    try {
      await loadReference();
      await loadBusinessData();
      renderCurrent();
    } catch (error) {
      console.error("טעינת נתוני העסק נכשלה:", error);
      app().toast(`טעינת נתוני החבילות והתשלומים נכשלה: ${errorText(error)}`, true);
    }
  });
  document.addEventListener("modaat:data", () => {
    if (!state.ready) return;
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      loadBusinessData().then((applied) => { if (applied) renderCurrent(); })
        .catch((error) => console.error("רענון נתוני העסק נכשל:", error));
    }, 150);
  });
  document.addEventListener("modaat:view", () => renderCurrent());
  document.addEventListener("modaat:signed-out", () => {
    Object.assign(state, { ready: false, loaded: false, packages: [], installments: [], obligations: [], balances: new Map(), modalClientId: null });
    $("#new-order-rows").innerHTML = "";
    $("#new-order-result").hidden = true;
  });

  $("#biz-package-form").addEventListener("submit", submitPackage);
  $("#biz-package-select").addEventListener("change", () => updatePackageSummary(true));
  $("#biz-package-form").addEventListener("input", (event) => {
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

  document.addEventListener("click", (event) => {
    const route = app().route();
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

  window.ModaatBusiness = Object.freeze({
    isPremium: (clientId) => state.ready && Boolean(activePackage(clientId)),
    setOrderPaid, deleteOrder
  });
})();
