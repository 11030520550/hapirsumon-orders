"use strict";

// Business screens for the live app. Active only when supabase-business-upgrade.sql is installed
// (app.js detects it). Every write goes through the approved RPCs; success is shown only after the
// RPC returns and the data is reloaded from Supabase. Nothing is stored locally.
(() => {
  const app = () => window.ModaatApp;
  const sb = () => app().client();
  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
  const number = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 });
  const ORDER_COLUMNS = "id,client_id,publication_date,section,amount,payment_status,notes,updated_at,order_number,billing_mode,credits_used,cash_amount_before_vat,sheet_number";

  const state = {
    ready: false, vatRate: null, catalog: [], products: [], premium: new Set(),
    clientId: null, clientLoad: 0, obligations: new Map(), keys: {}
  };

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

  function setBusy(button, busy, idleText) {
    button.disabled = busy;
    button.textContent = busy ? "שומרת…" : idleText;
  }

  async function loadReference() {
    const [settings, catalog, products] = await Promise.all([
      q(sb().from("business_settings").select("vat_rate").limit(1)),
      q(sb().from("package_catalog").select("id,name,credits,term_months,total_price_before_vat,default_installment_count,default_installment_before_vat,benefits").eq("is_active", true).order("credits")),
      q(sb().from("product_catalog").select("id,name,dimensions,base_price_before_vat,credit_cost").eq("is_active", true).order("name"))
    ]);
    state.vatRate = Number(settings[0]?.vat_rate ?? 0.18);
    state.catalog = catalog;
    state.products = products;
  }

  async function loadPremium() {
    const today = localDateValue();
    const rows = await q(sb().from("customer_packages").select("client_id")
      .eq("status", "active").lte("starts_on", today).gte("ends_on", today));
    state.premium = new Set(rows.map((row) => row.client_id));
    app().rerenderClients();
  }

  // ---------- Client file ----------
  async function loadClientFile(clientId) {
    const [clientRows, packages, orders, ledger] = await Promise.all([
      q(sb().from("clients").select("id,name,phone,email,joined_at,internal_notes").eq("id", clientId)),
      q(sb().from("customer_packages").select("id,package_name_snapshot,credits_granted,term_months,price_before_vat,gross_total,starts_on,ends_on,installment_count,benefits_snapshot,status").eq("client_id", clientId).order("starts_on", { ascending: false })),
      q(sb().from("orders").select(ORDER_COLUMNS).eq("client_id", clientId).order("publication_date", { ascending: false })),
      q(sb().from("credit_ledger").select("delta,entry_type,reason,created_at").eq("client_id", clientId).order("created_at"))
    ]);
    const packageIds = packages.map((item) => item.id);
    const installments = packageIds.length
      ? await q(sb().from("package_installments").select("id,customer_package_id,installment_number,due_on,amount_due").in("customer_package_id", packageIds).order("due_on"))
      : [];
    const obligationColumns = "id,order_id,package_installment_id,amount_due,due_on,status,updated_at";
    const [orderObligations, installmentObligations] = await Promise.all([
      orders.length ? q(sb().from("financial_obligations").select(obligationColumns).in("order_id", orders.map((item) => item.id))) : [],
      installments.length ? q(sb().from("financial_obligations").select(obligationColumns).in("package_installment_id", installments.map((item) => item.id))) : []
    ]);
    return { client: clientRows[0] || null, packages, orders, ledger, installments, orderObligations, installmentObligations };
  }

  function summaryGrid(pairs) {
    return pairs.map(([label, value]) => `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`).join("");
  }
  function payButton(obligationId, paid) {
    return `<button class="button button-outline client-action" type="button" data-biz-pay="${escapeHtml(obligationId)}" data-biz-paid="${paid ? "0" : "1"}">${paid ? "ביטול תשלום" : "סימון כשולם"}</button>`;
  }

  function renderClientFile(file) {
    const today = localDateValue();
    const { client } = file;
    if (!client) throw new Error("הלקוח לא נמצא או שאין הרשאה לצפות בו.");
    const active = file.packages.find((item) => item.status === "active" && item.starts_on <= today && today <= item.ends_on) || null;
    $("#biz-client-title").textContent = client.name;
    $("#biz-client-premium").hidden = !active;
    $("#biz-detail-phone").textContent = client.phone || "לא צוין";
    $("#biz-detail-email").textContent = client.email || "לא צוין";
    $("#biz-detail-joined").textContent = displayDate(client.joined_at);
    $("#biz-detail-notes").textContent = client.internal_notes || "אין הערות.";

    if (active) {
      $("#biz-detail-package").textContent = active.package_name_snapshot;
      $("#biz-detail-package-grid").innerHTML = summaryGrid([
        ["קרדיטים בחבילה", number.format(active.credits_granted)],
        ["תקופה", `${number.format(active.term_months)} חודשים`],
        ["תוקף", `${displayDate(active.starts_on)} – ${displayDate(active.ends_on)}`],
        ["מחיר לפני מע\"מ", money.format(active.price_before_vat)],
        ["מחיר כולל מע\"מ", money.format(active.gross_total)]
      ]);
      const benefits = Array.isArray(active.benefits_snapshot) ? active.benefits_snapshot : [];
      $("#biz-detail-benefits").textContent = benefits.length
        ? `הטבות: ${benefits.map((item) => `${item.label} (${number.format(item.quantity)} ${item.unit})`).join(" · ")}` : "";
    } else {
      const last = file.packages[0];
      $("#biz-detail-package").textContent = last
        ? `אין חבילה פעילה. חבילה אחרונה: ${last.package_name_snapshot} (${displayDate(last.starts_on)} – ${displayDate(last.ends_on)}).`
        : "אין חבילה פעילה ללקוח זה.";
      $("#biz-detail-package-grid").innerHTML = "";
      $("#biz-detail-benefits").textContent = "";
    }

    const granted = file.ledger.filter((row) => Number(row.delta) > 0).reduce((sum, row) => sum + Number(row.delta), 0);
    const used = file.ledger.filter((row) => Number(row.delta) < 0).reduce((sum, row) => sum - Number(row.delta), 0);
    const balance = roundMoney(granted - used);
    $("#biz-detail-credits").innerHTML = `יתרה נוכחית: <strong dir="ltr">${escapeHtml(number.format(balance))}</strong> קרדיטים`
      + (balance < 0 ? ' <span class="payment-select pending">יתרה שלילית</span>' : "");
    $("#biz-detail-credit-grid").innerHTML = summaryGrid([["הוקצו", number.format(roundMoney(granted))], ["נוצלו", number.format(roundMoney(used))]]);

    state.obligations.clear();
    const packageById = new Map(file.packages.map((item) => [item.id, item]));
    const obligationByInstallment = new Map(file.installmentObligations.map((item) => [item.package_installment_id, item]));
    const installmentRows = file.installments.map((installment) => {
      const pkg = packageById.get(installment.customer_package_id);
      const obligation = obligationByInstallment.get(installment.id);
      const paid = obligation?.status === "paid";
      const overdue = !paid && installment.due_on < today;
      if (obligation) state.obligations.set(obligation.id, { expected: obligation.updated_at, paid });
      return `<tr>
        <td>${escapeHtml(`${pkg ? pkg.package_name_snapshot : "חבילה"} ${installment.installment_number}/${pkg ? pkg.installment_count : "?"}`)}</td>
        <td>${escapeHtml(displayDate(installment.due_on))}</td>
        <td class="amount-cell">${escapeHtml(money.format(installment.amount_due))}</td>
        <td><span class="payment-select ${paid ? "paid" : "pending"}">${paid ? "שולם" : "עדיין לא"}${overdue ? " · באיחור" : ""}</span></td>
        <td>${obligation ? payButton(obligation.id, paid) : ""}</td>
      </tr>`;
    });
    $("#biz-installments").innerHTML = installmentRows.join("");
    $("#biz-installments-wrap").hidden = installmentRows.length === 0;
    $("#biz-installments-empty").hidden = installmentRows.length !== 0;

    const orderById = new Map(file.orders.map((item) => [item.id, item]));
    const debts = [];
    for (const obligation of file.orderObligations) {
      const order = orderById.get(obligation.order_id);
      if (order) state.obligations.set(obligation.id, { expected: order.updated_at, paid: obligation.status === "paid" });
      if (obligation.status === "paid" || !order) continue;
      debts.push({ id: obligation.id, label: `הזמנה #${order.order_number ?? order.id}`, amount: Number(obligation.amount_due), dueOn: obligation.due_on });
    }
    for (const installment of file.installments) {
      const obligation = obligationByInstallment.get(installment.id);
      const pkg = packageById.get(installment.customer_package_id);
      if (obligation && obligation.status !== "paid" && installment.due_on < today) {
        debts.push({ id: obligation.id, label: `${pkg ? pkg.package_name_snapshot : "חבילה"} · תשלום ${installment.installment_number}`, amount: Number(obligation.amount_due), dueOn: installment.due_on });
      }
    }
    const future = file.installments.filter((item) => {
      const obligation = obligationByInstallment.get(item.id);
      return obligation && obligation.status !== "paid" && item.due_on >= today;
    }).reduce((sum, item) => sum + Number(item.amount_due), 0);
    const overdueTotal = debts.filter((item) => item.dueOn && item.dueOn < today).reduce((sum, item) => sum + item.amount, 0);
    const undatedTotal = debts.filter((item) => !item.dueOn).reduce((sum, item) => sum + item.amount, 0);
    $("#biz-detail-debts").innerHTML = `<div class="preview-summary-grid">${summaryGrid([
      ["באיחור", money.format(overdueTotal)],
      ["ללא מועד פירעון (לא בפיגור)", money.format(undatedTotal)],
      ["תשלומים עתידיים (אינם חוב)", money.format(future)]
    ])}</div>` + (debts.length ? debts.map((item) => `<div class="preview-history-row">
        <strong>${escapeHtml(item.label)}</strong>
        <span>${escapeHtml(money.format(item.amount))} · ${item.dueOn ? `מועד ${escapeHtml(displayDate(item.dueOn))}${item.dueOn < today ? " · באיחור" : ""}` : "ללא מועד פירעון"}</span>
        <span>${payButton(item.id, false)}</span>
      </div>`).join("") : '<p class="preview-inline-note">אין חובות פתוחים.</p>');

    $("#biz-detail-orders").innerHTML = file.orders.length ? file.orders.map((order) => {
      const charge = order.billing_mode === "credits"
        ? `${number.format(order.credits_used)} קרדיטים`
        : `${money.format(order.amount)}${order.billing_mode === "cash" ? " כולל מע\"מ" : ""}`;
      const status = order.billing_mode === "credits" ? "קרדיטים" : order.payment_status === "paid" ? "שולם" : "עדיין לא";
      return `<div class="preview-history-row">
        <strong>הזמנה #${escapeHtml(order.order_number ?? order.id)}</strong>
        <span>${order.sheet_number ? `גיליון ${escapeHtml(order.sheet_number)} · ` : ""}${escapeHtml(order.section)}</span>
        <span>${escapeHtml(displayDate(order.publication_date))} · ${escapeHtml(charge)} · ${status}</span>
      </div>`;
    }).join("") : '<p class="preview-inline-note">אין הזמנות ללקוח זה.</p>';
  }

  async function refreshClientFile(quiet = false) {
    const clientId = state.clientId;
    if (!clientId) return;
    const token = ++state.clientLoad;
    const status = $("#biz-client-status");
    if (!quiet) { status.hidden = false; status.className = "import-preview"; status.textContent = "טוען את תיק הלקוח מהמסד…"; }
    try {
      const file = await loadClientFile(clientId);
      if (token !== state.clientLoad || clientId !== state.clientId) return;
      renderClientFile(file);
      status.hidden = true;
    } catch (error) {
      if (token !== state.clientLoad) return;
      console.error("טעינת תיק הלקוח נכשלה:", error);
      status.hidden = false;
      status.className = "import-preview error";
      status.textContent = `לא ניתן לטעון את תיק הלקוח: ${errorText(error)}`;
    }
  }

  function openClient(clientId) {
    state.clientId = clientId;
    const client = app().clients().find((item) => item.id === clientId);
    $("#biz-client-title").textContent = client ? client.name : "";
    for (const id of ["#biz-detail-package-grid", "#biz-installments", "#biz-detail-debts", "#biz-detail-orders"]) $(id).innerHTML = "";
    $("#biz-client-modal").showModal();
    refreshClientFile();
  }

  async function afterSave(message) {
    try {
      await app().refresh();
      await Promise.all([refreshClientFile(true), loadPremium()]);
      app().toast(message);
    } catch (error) {
      console.error("רענון לאחר שמירה נכשל:", error);
      app().toast(`${message} הרענון נכשל — רענני את הדף לצפייה בנתונים העדכניים.`, true);
    }
  }

  // ---------- Payments ----------
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
    try {
      const rows = await q(sb().from("financial_obligations").select("id").eq("order_id", order.id));
      if (!rows.length) {
        app().toast("להזמנה זו אין רשומת חיוב במערכת העסקית, ולכן לא ניתן לעדכן את התשלום כאן.", true);
        return false;
      }
      return await setObligationPaid(rows[0].id, order.updatedAt, isPaid);
    } catch (error) {
      app().toast(errorText(error), true);
      return false;
    }
  }

  async function deleteOrder(order) {
    try {
      await q(sb().rpc("delete_business_order", {
        p_order_id: order.id, p_expected_updated_at: order.updatedAt,
        p_reason: "מחיקה מלוח הבקרה", p_idempotency_key: crypto.randomUUID()
      }));
      await afterSave("ההזמנה נמחקה.");
    } catch (error) {
      console.error("מחיקת הזמנה נכשלה:", error);
      app().toast(errorText(error), true);
    }
  }

  // ---------- Package purchase ----------
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
    const valid = (template || custom) && pkg.name && pkg.credits > 0 && roundMoney(pkg.credits) === pkg.credits
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

  function openPackage() {
    const client = app().clients().find((item) => item.id === state.clientId);
    if (!client) return;
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
        p_client_id: state.clientId,
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

  // ---------- Credits ----------
  function openCredits() {
    const client = app().clients().find((item) => item.id === state.clientId);
    if (!client) return;
    $("#biz-credit-form").reset();
    $("#biz-credit-client").textContent = `לקוח: ${client.name}`;
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
    if (!delta || roundMoney(delta) !== delta || !reason) { message.textContent = "יש להזין כמות שאינה אפס (עד שתי ספרות אחרי הנקודה) וסיבה."; return; }
    const button = $("#biz-credit-submit");
    setBusy(button, true, "שמירת תנועה");
    message.textContent = "";
    try {
      const balance = await q(sb().rpc("adjust_client_credits", {
        p_client_id: state.clientId, p_delta: delta, p_reason: reason, p_idempotency_key: state.keys.credits
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

  // ---------- Orders ----------
  async function showClientCredits(clientId) {
    const note = $("#biz-order-credit-note");
    note.textContent = "";
    if (!clientId) return;
    try {
      const rows = await q(sb().from("business_client_credit_balances").select("credit_balance").eq("client_id", clientId));
      if ($("#biz-order-client").value === clientId) note.textContent = `יתרת קרדיטים נוכחית: ${number.format(Number(rows[0]?.credit_balance ?? 0))}`;
    } catch (error) {
      note.textContent = `לא ניתן לטעון את יתרת הקרדיטים: ${errorText(error)}`;
    }
  }

  function updateOrderCharge() {
    const form = $("#biz-order-form");
    const cash = Number(form.elements.cash_amount_before_vat.value);
    const credits = Number(form.elements.credits_used.value);
    const status = form.elements.payment_status;
    status.disabled = credits > 0;
    if (credits > 0) status.value = "paid";
    const product = state.products.find((item) => item.id === form.elements.product_id.value);
    const list = product ? `מחירון המוצר: ${money.format(product.base_price_before_vat)} לפני מע"מ · ${number.format(product.credit_cost)} קרדיטים. ` : "";
    $("#biz-order-vat-note").textContent = list + (cash > 0
      ? `סכום כולל מע"מ (${number.format(state.vatRate * 100)}%): ${money.format(gross(cash))}`
      : credits > 0 ? "הזמנה בקרדיטים: הקרדיטים ינוכו מהיתרה, ללא חיוב כספי." : "");
  }

  function openOrder(clientId = "") {
    const form = $("#biz-order-form");
    form.reset();
    const clients = [...app().clients()].sort((a, b) => a.name.localeCompare(b.name, "he"));
    $("#biz-order-client").innerHTML = `<option value="">בחירת לקוח</option>${clients.map((client) =>
      `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}</option>`).join("")}`;
    $("#biz-order-client").value = clientId;
    $("#biz-order-product").innerHTML = `<option value="">בחירת מוצר</option>${state.products.map((product) =>
      `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join("")}`;
    form.elements.publication_date.value = localDateValue();
    const noProducts = state.products.length === 0;
    $("#biz-order-submit").disabled = noProducts;
    $("#biz-order-message").textContent = noProducts
      ? "אין מוצרים פעילים בקטלוג, ולכן אי אפשר לשמור הזמנה. יש להוסיף מוצר (לסביבת הדגמה: supabase-demo-product.sql)." : "";
    newKey("order");
    updateOrderCharge();
    showClientCredits(clientId);
    $("#biz-order-modal").showModal();
  }

  async function submitOrder(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $("#biz-order-message");
    if (!form.reportValidity()) return;
    const cashText = form.elements.cash_amount_before_vat.value.trim();
    const creditText = form.elements.credits_used.value.trim();
    if (Boolean(cashText) === Boolean(creditText)) { message.textContent = "יש למלא מחיר או קרדיטים — בדיוק אחד מהם."; return; }
    const clientId = form.elements.clientId.value;
    const row = {
      sheet_number: form.elements.sheet_number.value.trim(),
      product_id: form.elements.product_id.value,
      publication_date: form.elements.publication_date.value,
      cash_amount_before_vat: cashText ? Number(cashText) : null,
      credits_used: creditText ? Number(creditText) : null,
      payment_status: creditText ? "paid" : form.elements.payment_status.value,
      due_on: form.elements.due_on.value || null,
      notes: form.elements.notes.value.trim()
    };
    const button = $("#biz-order-submit");
    setBusy(button, true, "שמירת הזמנה");
    message.textContent = "";
    try {
      const result = await q(sb().rpc("create_orders_batch", {
        p_client_id: clientId, p_orders: [row], p_idempotency_key: state.keys.order
      }));
      const saved = Array.isArray(result) ? result[0] : null;
      $("#biz-order-modal").close();
      newKey("order");
      const extra = saved && saved.billing_mode === "credits" ? ` יתרת קרדיטים: ${number.format(Number(saved.credit_balance_after))}.` : "";
      await afterSave(`הזמנה #${saved ? saved.order_number : ""} נשמרה.${extra}`);
    } catch (error) {
      console.error("שמירת הזמנה נכשלה:", error);
      message.textContent = errorText(error);
    } finally {
      setBusy(button, false, "שמירת הזמנה");
    }
  }

  // ---------- Wiring ----------
  document.addEventListener("modaat:session-ready", async (event) => {
    state.ready = Boolean(event.detail && event.detail.business);
    if (!state.ready) return;
    try {
      await loadReference();
      await loadPremium();
    } catch (error) {
      console.error("טעינת נתוני העסק נכשלה:", error);
      app().toast(`טעינת נתוני החבילות והמוצרים נכשלה: ${errorText(error)}`, true);
    }
  });
  document.addEventListener("modaat:data", () => {
    if (!state.ready) return;
    loadPremium().catch((error) => console.error("טעינת סטטוס פרימיום נכשלה:", error));
    if ($("#biz-client-modal").open) refreshClientFile(true);
  });
  document.addEventListener("modaat:signed-out", () => {
    state.ready = false;
    state.clientId = null;
    state.premium = new Set();
    state.obligations.clear();
  });

  $("#biz-package-form").addEventListener("submit", submitPackage);
  $("#biz-package-select").addEventListener("change", () => updatePackageSummary(true));
  $("#biz-package-form").addEventListener("input", (event) => {
    if (event.target.id !== "biz-package-select") updatePackageSummary(false);
  });
  $("#biz-credit-form").addEventListener("submit", submitCredits);
  $("#biz-order-form").addEventListener("submit", submitOrder);
  $("#biz-order-form").addEventListener("input", updateOrderCharge);
  $("#biz-order-client").addEventListener("change", (event) => showClientCredits(event.target.value));

  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-biz-action]");
    if (action) {
      if (action.dataset.bizAction === "package") openPackage();
      if (action.dataset.bizAction === "credits") openCredits();
      if (action.dataset.bizAction === "order") openOrder(state.clientId || "");
    }
    const pay = event.target.closest("[data-biz-pay]");
    if (pay) {
      const obligation = state.obligations.get(pay.dataset.bizPay);
      if (!obligation) return;
      pay.disabled = true;
      setObligationPaid(pay.dataset.bizPay, obligation.expected, pay.dataset.bizPaid === "1")
        .finally(() => { pay.disabled = false; });
    }
  });

  window.ModaatBusiness = Object.freeze({
    isPremium: (clientId) => state.ready && state.premium.has(clientId),
    openClient, openOrder, setOrderPaid, deleteOrder
  });
})();
