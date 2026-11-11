"use strict";

(() => {
  const vatRate = 0.18;
  const maxBatchRows = 250;
  const clients = [
    {
      id: "demo-client-001",
      name: "נועה לדוגמה",
      phone: "050-000-0001",
      email: "noa@example.invalid",
      joinedAt: "2025-03-12",
      internalNotes: "העדפה לקבלת סקיצה לפני סגירת הזמנה. (הערת הדגמה)",
      premium: true,
      packageName: "מינימום מקסימום",
      packageCredits: 30,
      creditBalance: 5.5
    },
    {
      id: "demo-client-002",
      name: "סטודיו לדוגמה",
      phone: "050-000-0002",
      email: "studio@example.invalid",
      joinedAt: "2025-07-04",
      internalNotes: "לקוח לדוגמה; אין פרטים אמיתיים.",
      premium: false,
      packageName: "",
      packageCredits: null,
      creditBalance: 0
    },
    {
      id: "demo-client-003",
      name: "משפחת ישראלי לדוגמה",
      phone: "050-000-0003",
      email: "family@example.invalid",
      joinedAt: "2024-11-20",
      internalNotes: "מבקשים לוודא את מספר הגיליון לפני פרסום. (הערת הדגמה)",
      premium: true,
      packageName: "מותג מוביל",
      packageCredits: 60,
      creditBalance: -2.5
    },
    {
      id: "demo-client-004",
      name: "עסק מקומי לדוגמה",
      phone: "050-000-0004",
      email: "",
      joinedAt: "2026-01-15",
      internalNotes: "",
      premium: false,
      packageName: "",
      packageCredits: null,
      creditBalance: 0
    }
  ];
  const products = [
    { id: "00000000-0000-4000-8000-000000000001", name: "מוצר הדגמה — קטלוג לא מחובר" }
  ];
  const orders = [
    {
      id: "demo-order-001", orderNumber: "דוגמה-001", clientId: clients[0].id,
      sheetNumber: "125", productName: "מוצר הדגמה", date: "2026-11-02",
      cashBeforeVat: 500, creditsUsed: null, paymentStatus: "pending",
      notes: "הזמנה לדוגמה"
    },
    {
      id: "demo-order-002", orderNumber: "דוגמה-002", clientId: clients[2].id,
      sheetNumber: "125", productName: "מוצר הדגמה", date: "2026-10-19",
      cashBeforeVat: null, creditsUsed: 2.5, paymentStatus: "paid",
      notes: "ניצול קרדיטים לדוגמה"
    },
    {
      id: "demo-order-003", orderNumber: "דוגמה-003", clientId: clients[1].id,
      sheetNumber: "124", productName: "מוצר הדגמה", date: "2026-09-11",
      cashBeforeVat: 250, creditsUsed: null, paymentStatus: "paid",
      notes: ""
    }
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
  const number = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 });
  const state = { previewPayload: null };

  function localDateValue() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function displayDate(value) {
    if (!value) return "—";
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", year: "numeric" })
      .format(new Date(year, month - 1, day));
  }

  function showNotice(message, isError = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("toast-error", isError);
    toast.classList.add("visible");
    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => toast.classList.remove("visible"), 4500);
  }

  function clientById(clientId) {
    return clients.find((client) => client.id === clientId);
  }

  function productOptions() {
    return `<option value="">בחירת מוצר</option>${products.map((product) =>
      `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`
    ).join("")}`;
  }

  function clientOptions(query = "") {
    const normalized = query.trim().toLocaleLowerCase("he");
    const matches = clients.filter((client) =>
      `${client.name} ${client.phone}`.toLocaleLowerCase("he").includes(normalized)
    );
    return `<option value="">בחירת לקוח</option>${matches.map((client) =>
      `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}</option>`
    ).join("")}`;
  }

  function renderClients() {
    const query = $("#preview-client-search").value.trim().toLocaleLowerCase("he");
    const filtered = clients.filter((client) =>
      `${client.name} ${client.phone}`.toLocaleLowerCase("he").includes(query)
    );
    $("#preview-clients-body").innerHTML = filtered.map((client) => `<tr>
      <td class="client-name">${escapeHtml(client.name)}</td>
      <td>${escapeHtml(client.phone || "—")}</td>
      <td>${escapeHtml(client.email || "—")}</td>
      <td>${client.premium ? '<span class="premium-badge">פרימיום</span>' : ""}</td>
      <td class="client-actions">
        <button class="button button-outline client-action" type="button" data-preview-client-view="${escapeHtml(client.id)}">כרטיס לקוח</button>
        <button class="button button-outline client-action" type="button" data-preview-action="client-save-blocked">עריכה</button>
      </td>
    </tr>`).join("");
    $("#preview-clients-empty").hidden = filtered.length !== 0;
    $("#preview-clients-count").textContent = `${number.format(filtered.length)} ${filtered.length === 1 ? "לקוח" : "לקוחות"}`;
  }

  function amountForOrder(order) {
    return order.cashBeforeVat == null ? "קרדיטים" : money.format(order.cashBeforeVat * (1 + vatRate));
  }

  function renderOrders() {
    const query = $("#preview-order-search").value.trim().toLocaleLowerCase("he");
    const status = $("#preview-payment-filter").value;
    const filtered = orders.filter((order) => {
      const client = clientById(order.clientId);
      const searchable = `${order.orderNumber} ${client?.name || ""} ${order.sheetNumber} ${order.productName}`.toLocaleLowerCase("he");
      return searchable.includes(query)
        && (status === "all" || order.paymentStatus === status);
    });
    $("#preview-orders-body").innerHTML = filtered.map((order) => {
      const client = clientById(order.clientId);
      const charge = order.cashBeforeVat == null
        ? `${number.format(order.creditsUsed)} קרדיטים`
        : `${money.format(order.cashBeforeVat)} לפני מע"מ`;
      return `<tr>
        <td class="order-number">#${escapeHtml(order.orderNumber)}</td>
        <td class="client-name">${escapeHtml(client?.name || "לקוח לדוגמה")}</td>
        <td>${escapeHtml(order.sheetNumber)}</td>
        <td>${escapeHtml(order.productName)}</td>
        <td class="amount-cell">${escapeHtml(charge)}</td>
        <td><span class="payment-select ${order.paymentStatus === "paid" ? "paid" : "pending"}">${order.paymentStatus === "paid" ? "שולם" : "עדיין לא"}</span></td>
      </tr>`;
    }).join("");
    $("#preview-orders-empty").hidden = filtered.length !== 0;
    $("#preview-orders-count").textContent = `${number.format(filtered.length)} ${filtered.length === 1 ? "הזמנה" : "הזמנות"}`;
  }

  function openClientCard(clientId) {
    const client = clientById(clientId);
    if (!client) return;
    const history = orders.filter((order) => order.clientId === clientId);
    $("#preview-client-title").textContent = client.name;
    $("#preview-client-premium").hidden = !client.premium;
    $("#preview-detail-phone").textContent = client.phone || "לא צוין";
    $("#preview-detail-email").textContent = client.email || "לא צוין";
    $("#preview-detail-joined").textContent = displayDate(client.joinedAt);
    $("#preview-detail-notes").textContent = client.internalNotes || "אין הערות בדוגמה.";
    $("#preview-detail-package").textContent = client.premium
      ? `${client.packageName} — ${number.format(client.packageCredits)} קרדיטים (חבילת הדגמה)`
      : "אין חבילה לדוגמה משויכת.";
    $("#preview-detail-credits").textContent = `יתרת קרדיטים לדוגמה: ${number.format(client.creditBalance)}`;
    $("#preview-detail-orders").innerHTML = history.length
      ? history.map((order) => `<div class="preview-history-row">
          <strong>הזמנה #${escapeHtml(order.orderNumber)}</strong>
          <span>גיליון ${escapeHtml(order.sheetNumber)} · ${escapeHtml(order.productName)}</span>
          <span>${escapeHtml(displayDate(order.date))} · ${escapeHtml(amountForOrder(order))} · ${order.paymentStatus === "paid" ? "שולם" : "עדיין לא"}</span>
        </div>`).join("")
      : '<p class="preview-inline-note">אין הזמנות בדוגמה זו.</p>';
    $("#preview-client-details").showModal();
  }

  function switchPreviewView(viewName, activeButton) {
    const clientsView = viewName === "clients";
    $("#preview-clients-view").hidden = !clientsView;
    $("#preview-orders-view").hidden = clientsView;
    $$("[data-preview-view]").forEach((button) => {
      const active = button === activeButton;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    const title = clientsView ? "לקוחות" : "הזמנות";
    $("#preview-breadcrumb").textContent = title;
    document.title = `${title} — תצוגה מקדימה | מודעת`;
  }

  function populateClientSelect(select, searchInput, selectedId = "") {
    const query = searchInput.value;
    select.innerHTML = clientOptions(query);
    if ([...select.options].some((option) => option.value === selectedId)) select.value = selectedId;
  }

  function updatePremiumBadge(select, badge) {
    const client = clientById(select.value);
    badge.hidden = !client?.premium;
  }

  function setOrderPaymentControl(row) {
    const cash = row.querySelector('[name="cash_amount_before_vat"]');
    const credits = row.querySelector('[name="credits_used"]');
    const status = row.querySelector('[name="payment_status"]');
    const creditMode = Number(credits.value) > 0;
    if (creditMode) {
      if (!status.disabled) status.dataset.cashStatus = status.value;
      status.disabled = true;
      status.value = "paid";
    } else {
      if (status.disabled) status.value = status.dataset.cashStatus || "pending";
      status.disabled = false;
    }
    status.setAttribute("aria-description", creditMode ? "סטטוס תשלום אינו חל על שימוש בקרדיטים" : "");
    row.querySelector(".preview-vat-note").textContent = Number(cash.value) > 0
      ? `סכום כולל מע"מ (18%): ${money.format(Number(cash.value) * (1 + vatRate))}`
      : "הזמנה בקרדיטים אינה יוצרת חיוב כספי נוסף.";
  }

  function clearSingleValidation(form) {
    form.elements.cash_amount_before_vat.setCustomValidity("");
    form.elements.credits_used.setCustomValidity("");
  }

  function validateChargeFields(cashField, creditField) {
    const cashFilled = cashField.value.trim() !== "";
    const creditsFilled = creditField.value.trim() !== "";
    if (cashFilled === creditsFilled) {
      const message = cashFilled
        ? "יש למלא מחיר או קרדיטים — לא את שניהם."
        : "יש למלא ערך חיובי במחיר או בקרדיטים.";
      cashField.setCustomValidity(message);
      creditField.setCustomValidity(message);
      cashField.reportValidity();
      cashField.setCustomValidity("");
      creditField.setCustomValidity("");
      return false;
    }
    const amount = Number(cashFilled ? cashField.value : creditField.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      const field = cashFilled ? cashField : creditField;
      field.setCustomValidity("יש להזין ערך חיובי ותקין.");
      field.reportValidity();
      field.setCustomValidity("");
      return false;
    }
    const activeField = cashFilled ? cashField : creditField;
    if (!activeField.checkValidity()) {
      activeField.reportValidity();
      return false;
    }
    return true;
  }

  function buildRpcPayload(clientId, rows) {
    return {
      p_client_id: clientId,
      p_orders: rows.map((row) => ({
        sheet_number: row.sheetNumber,
        product_id: row.productId,
        publication_date: row.publicationDate,
        cash_amount_before_vat: row.cashBeforeVat,
        credits_used: row.creditsUsed,
        payment_status: row.creditsUsed == null ? row.paymentStatus : "paid",
        notes: row.notes
      })),
      p_idempotency_key: crypto.randomUUID()
    };
  }

  function readSingleOrder() {
    const form = $("#preview-single-order-form");
    clearSingleValidation(form);
    if (!form.reportValidity()) return null;
    const values = new FormData(form);
    const cashField = form.elements.cash_amount_before_vat;
    const creditsField = form.elements.credits_used;
    if (!validateChargeFields(cashField, creditsField)) {
      $("#preview-single-message").textContent = cashField.value.trim() && creditsField.value.trim()
        ? "יש למלא מחיר או קרדיטים — לא את שניהם."
        : "יש למלא ערך חיובי במחיר או בקרדיטים.";
      return null;
    }
    const clientId = String(values.get("clientId"));
    if (!clientById(clientId)) {
      $("#preview-single-message").textContent = "בחרו לקוח מהרשימה.";
      return null;
    }
    $("#preview-single-message").textContent = "";
    return {
      clientId,
      row: {
        sheetNumber: String(values.get("sheet_number")).trim(),
        productId: String(values.get("product_id")),
        publicationDate: String(values.get("publication_date")),
        cashBeforeVat: cashField.value.trim() ? Number(cashField.value) : null,
        creditsUsed: creditsField.value.trim() ? Number(creditsField.value) : null,
        paymentStatus: String(values.get("payment_status")),
        notes: String(values.get("notes") || "").trim()
      }
    };
  }

  function openSingleOrder() {
    const form = $("#preview-single-order-form");
    form.reset();
    form.elements.publication_date.value = localDateValue();
    $("#preview-single-message").textContent = "";
    $("#preview-single-summary").textContent = "בדיקת ההזמנה תציג סיכום בלבד; היא לא תשמור נתונים.";
    $("#preview-single-client-search").value = "";
    populateClientSelect($("#preview-single-client"), $("#preview-single-client-search"));
    $("#preview-single-client").value = "";
    $("#preview-single-premium").hidden = true;
    $(".preview-product-select", form).innerHTML = productOptions();
    $("#preview-single-order-modal").showModal();
  }

  function checkSingleOrder() {
    const result = readSingleOrder();
    if (!result) return;
    const { clientId, row } = result;
    const client = clientById(clientId);
    state.previewPayload = buildRpcPayload(clientId, [row]);
    const charge = row.cashBeforeVat == null
      ? `${number.format(row.creditsUsed)} קרדיטים — ללא חיוב כספי נוסף`
      : `${money.format(row.cashBeforeVat)} לפני מע"מ · ${money.format(row.cashBeforeVat * (1 + vatRate))} כולל מע"מ`;
    $("#preview-single-message").textContent = "";
    $("#preview-single-summary").textContent = [
      `לקוח: ${client.name}${client.premium ? " · פרימיום" : ""}`,
      `גיליון ${row.sheetNumber} · ${products.find((product) => product.id === row.productId).name}`,
      `תאריך פרסום: ${displayDate(row.publicationDate)}`,
      `חיוב: ${charge}`,
      row.creditsUsed == null ? `סטטוס: ${row.paymentStatus === "paid" ? "שולם" : "עדיין לא"}` : "סטטוס תשלום: לא חל על הזמנה בקרדיטים",
      "הסיכום נבדק בלבד. לא נשלחה בקשת RPC ולא נשמר דבר."
    ].join("\n");
  }

  function batchRowMarkup(index) {
    return `<article class="preview-batch-row" data-batch-row>
      <div class="preview-batch-row-heading">
        <strong>שורה ${index + 1}</strong>
        <div>
          <button class="button button-outline client-action" type="button" data-batch-clone>שכפול שורה</button>
          <button class="button button-outline client-action" type="button" data-batch-remove>הסרת שורה</button>
        </div>
      </div>
      <div class="form-grid">
        <label class="field-label">מספר גיליון <span>*</span><input name="sheet_number" required maxlength="80" placeholder="לדוגמה: 125"></label>
        <label class="field-label">מוצר <span>*</span><select name="product_id" required>${productOptions()}</select></label>
      </div>
      <label class="field-label">תאריך פרסום <span>*</span><input name="publication_date" type="date" required value="${localDateValue()}"></label>
      <div class="preview-charge-fields">
        <label class="field-label">מחיר כספי לפני מע"מ (₪)<input name="cash_amount_before_vat" type="number" min="0.01" max="99999999" step="0.01" placeholder="השאירו ריק לשימוש בקרדיטים"></label>
        <label class="field-label">ניצול קרדיטים<input name="credits_used" type="number" min="0.01" max="999999999" step="0.01" placeholder="השאירו ריק לחיוב כספי"></label>
      </div>
      <p class="preview-inline-note">יש למלא ערך חיובי בדיוק באחד משני השדות.</p>
      <label class="field-label">סטטוס תשלום
        <select name="payment_status"><option value="pending">עדיין לא</option><option value="paid">שולם</option></select>
      </label>
      <label class="field-label">הערות<textarea name="notes" rows="2" maxlength="300" placeholder="הערות פנימיות לשורה"></textarea></label>
      <div class="preview-vat-note"></div>
    </article>`;
  }

  function renumberBatchRows() {
    const rows = $$("#preview-batch-rows [data-batch-row]");
    rows.forEach((row, index) => {
      row.querySelector(".preview-batch-row-heading strong").textContent = `שורה ${index + 1}`;
      row.querySelector("[data-batch-remove]").disabled = rows.length === 1;
    });
    $("#preview-batch-row-count").textContent = `${number.format(rows.length)} מתוך ${number.format(maxBatchRows)}`;
  }

  function resetBatchRows() {
    $("#preview-batch-rows").innerHTML = batchRowMarkup(0);
    renumberBatchRows();
    state.previewPayload = null;
    $("#preview-batch-message").textContent = "";
    $("#preview-batch-summary").innerHTML = "<strong>סיכום לפני שמירה</strong><p>מלאו את השורות ובחרו ״בדיקת סיכום״.</p>";
  }

  function openBatchOrder() {
    $("#preview-batch-client-search").value = "";
    populateClientSelect($("#preview-batch-client"), $("#preview-batch-client-search"));
    $("#preview-batch-client").value = "";
    $("#preview-batch-premium").hidden = true;
    $("#preview-sequence-start").value = "";
    resetBatchRows();
    $("#preview-batch-order-modal").showModal();
  }

  function readBatchOrders() {
    const clientId = $("#preview-batch-client").value;
    if (!clientById(clientId)) {
      $("#preview-batch-message").textContent = "בחרו לקוח אחד עבור כל ההזמנות.";
      return null;
    }
    const rows = $$("#preview-batch-rows [data-batch-row]");
    const result = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const cashField = row.querySelector('[name="cash_amount_before_vat"]');
      const creditField = row.querySelector('[name="credits_used"]');
      cashField.setCustomValidity("");
      creditField.setCustomValidity("");
      const requiredFields = [...row.querySelectorAll("[required]")];
      const invalid = requiredFields.find((field) => !field.reportValidity());
      if (invalid) {
        $("#preview-batch-message").textContent = `בדקו את הפרטים בשורה ${index + 1}.`;
        return null;
      }
      if (!validateChargeFields(cashField, creditField)) {
        $("#preview-batch-message").textContent = `בשורה ${index + 1} יש למלא מחיר או קרדיטים — בדיוק אחד.`;
        return null;
      }
      result.push({
        sheetNumber: row.querySelector('[name="sheet_number"]').value.trim(),
        productId: row.querySelector('[name="product_id"]').value,
        publicationDate: row.querySelector('[name="publication_date"]').value,
        cashBeforeVat: cashField.value.trim() ? Number(cashField.value) : null,
        creditsUsed: creditField.value.trim() ? Number(creditField.value) : null,
        paymentStatus: row.querySelector('[name="payment_status"]').value,
        notes: row.querySelector('[name="notes"]').value.trim()
      });
    }
    $("#preview-batch-message").textContent = "";
    return { clientId, rows: result };
  }

  function checkBatchOrders() {
    const batch = readBatchOrders();
    if (!batch) return;
    state.previewPayload = buildRpcPayload(batch.clientId, batch.rows);
    const cashRows = batch.rows.filter((row) => row.cashBeforeVat != null);
    const creditRows = batch.rows.filter((row) => row.creditsUsed != null);
    const cashBeforeVat = cashRows.reduce((sum, row) => sum + row.cashBeforeVat, 0);
    const grossFor = (row) => Math.round((row.cashBeforeVat * (1 + vatRate) + Number.EPSILON) * 100) / 100;
    const cashIncludingVat = cashRows.reduce((sum, row) => sum + grossFor(row), 0);
    const creditsTotal = creditRows.reduce((sum, row) => sum + row.creditsUsed, 0);
    const pendingGross = cashRows
      .filter((row) => row.paymentStatus === "pending")
      .reduce((sum, row) => sum + grossFor(row), 0);
    const duplicateGroups = new Map();
    for (const row of batch.rows) {
      const key = `${row.sheetNumber.toLocaleLowerCase("he")}::${row.productId}`;
      duplicateGroups.set(key, (duplicateGroups.get(key) || 0) + 1);
    }
    const duplicates = [...duplicateGroups.values()].filter((count) => count > 1).length;
    const warning = duplicates
      ? `<p class="batch-duplicate-warning" role="alert">נמצאו ${number.format(duplicates)} צירופי גיליון ומוצר שחוזרים. בדקו שאין הזמנות כפולות.</p>`
      : '<p class="preview-batch-ok">לא נמצאו צירופי גיליון ומוצר כפולים.</p>';
    $("#preview-batch-summary").innerHTML = `<strong>סיכום לפני שמירה</strong>
      <div class="preview-summary-grid">
        <span>מספר הזמנות</span><strong>${number.format(batch.rows.length)}</strong>
        <span>סך קרדיטים</span><strong>${number.format(creditsTotal)}</strong>
        <span>חיובים כספיים לפני מע"מ</span><strong>${money.format(cashBeforeVat)}</strong>
        <span>חיובים כספיים כולל מע"מ (18%)</span><strong>${money.format(cashIncludingVat)}</strong>
        <span>מתוכם עדיין לא שולמו</span><strong>${money.format(pendingGross)}</strong>
      </div>
      ${warning}
      <p class="preview-inline-note">הסיכום נבדק בלבד. נבנה מבנה תואם create_orders_batch; לא נשלחה בקשת RPC ולא נשמר דבר.</p>`;
    $("#preview-batch-summary").classList.add("has-result");
  }

  function addBatchRow(sourceRow = null) {
    const container = $("#preview-batch-rows");
    const rows = $$("#preview-batch-rows [data-batch-row]");
    if (rows.length >= maxBatchRows) {
      showNotice("הגעתם למגבלת 250 שורות בבקשת הזמנה אחת.", true);
      return;
    }
    container.insertAdjacentHTML("beforeend", batchRowMarkup(rows.length));
    const newRow = container.lastElementChild;
    if (sourceRow) {
      for (const field of newRow.querySelectorAll("input, select, textarea")) {
        const oldField = sourceRow.querySelector(`[name="${field.name}"]`);
        if (oldField) field.value = oldField.value;
      }
    }
    renumberBatchRows();
    state.previewPayload = null;
  }

  function applySheetSequence() {
    const start = Number($("#preview-sequence-start").value);
    const rowCount = $$("#preview-batch-rows [data-batch-row]").length;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(start + rowCount - 1)) {
      $("#preview-sequence-start").setCustomValidity("יש להזין מספר גיליון ראשון חיובי ושלם, בטווח הנתמך.");
      $("#preview-sequence-start").reportValidity();
      $("#preview-sequence-start").setCustomValidity("");
      return;
    }
    const rows = $$("#preview-batch-rows [data-batch-row]");
    rows.forEach((row, index) => {
      row.querySelector('[name="sheet_number"]').value = String(start + index);
    });
    $("#preview-batch-summary").innerHTML = "<strong>הרצף הוחל</strong><p>בדקו את מספרי הגיליונות, מלאו את השורות והפיקו סיכום לפני שמירה.</p>";
    $("#preview-batch-summary").classList.remove("has-result");
    state.previewPayload = null;
  }

  function openPreview() {
    $("#auth-screen").hidden = true;
    $("#app-shell").hidden = true;
    $("#business-preview-shell").hidden = false;
    renderClients();
    renderOrders();
    switchPreviewView("clients", $('[data-preview-view="clients"]'));
    $("#preview-today").textContent = new Intl.DateTimeFormat("he-IL", {
      weekday: "long", day: "numeric", month: "long"
    }).format(new Date());
  }

  function closePreview() {
    $("#business-preview-shell").hidden = true;
    document.title = "מודעת — ניהול הזמנות פרסום";
    // app.js decides which screen to show (login or app), in case a login finished meanwhile.
    document.dispatchEvent(new CustomEvent("modaat:preview-closed"));
    if ($("#auth-screen").hidden && $("#app-shell").hidden) $("#auth-screen").hidden = false;
  }

  $("#open-business-preview").addEventListener("click", openPreview);
  $("#exit-business-preview").addEventListener("click", closePreview);
  $('[data-preview-view="clients"]').addEventListener("click", (event) => switchPreviewView("clients", event.currentTarget));
  $('[data-preview-view="orders"]').addEventListener("click", (event) => switchPreviewView("orders", event.currentTarget));
  $("#preview-client-search").addEventListener("input", renderClients);
  $("#preview-order-search").addEventListener("input", renderOrders);
  $("#preview-payment-filter").addEventListener("change", renderOrders);
  $("#preview-single-client-search").addEventListener("input", (event) => {
    const select = $("#preview-single-client");
    const selected = select.value;
    populateClientSelect(select, event.currentTarget, selected);
    updatePremiumBadge(select, $("#preview-single-premium"));
  });
  $("#preview-batch-client-search").addEventListener("input", (event) => {
    const select = $("#preview-batch-client");
    const selected = select.value;
    populateClientSelect(select, event.currentTarget, selected);
    updatePremiumBadge(select, $("#preview-batch-premium"));
  });
  $("#preview-single-client").addEventListener("change", (event) => updatePremiumBadge(event.currentTarget, $("#preview-single-premium")));
  $("#preview-batch-client").addEventListener("change", (event) => updatePremiumBadge(event.currentTarget, $("#preview-batch-premium")));
  $("#preview-single-order-form").addEventListener("input", (event) => {
    const row = event.currentTarget;
    state.previewPayload = null;
    if (event.target.name === "cash_amount_before_vat" || event.target.name === "credits_used") {
      setOrderPaymentControl(row);
    }
  });
  $("#preview-single-order-form").addEventListener("change", (event) => {
    if (event.target.name === "payment_status" && !event.target.disabled) {
      event.target.dataset.cashStatus = event.target.value;
    }
  });
  $("#preview-single-order-form").addEventListener("submit", (event) => event.preventDefault());
  $("#preview-single-check").addEventListener("click", checkSingleOrder);
  $("#preview-batch-rows").addEventListener("input", (event) => {
    state.previewPayload = null;
    const row = event.target.closest("[data-batch-row]");
    if (row && ["cash_amount_before_vat", "credits_used"].includes(event.target.name)) {
      setOrderPaymentControl(row);
    }
    $("#preview-batch-summary").classList.remove("has-result");
  });
  $("#preview-batch-rows").addEventListener("change", (event) => {
    if (event.target.name === "payment_status" && !event.target.disabled) {
      event.target.dataset.cashStatus = event.target.value;
    }
  });
  $("#preview-batch-rows").addEventListener("click", (event) => {
    const row = event.target.closest("[data-batch-row]");
    if (event.target.closest("[data-batch-clone]")) addBatchRow(row);
    if (event.target.closest("[data-batch-remove]")) {
      if ($$("#preview-batch-rows [data-batch-row]").length > 1) row.remove();
      renumberBatchRows();
      state.previewPayload = null;
      $("#preview-batch-summary").classList.remove("has-result");
    }
  });
  $("#preview-add-batch-row").addEventListener("click", () => addBatchRow());
  $("#preview-apply-sequence").addEventListener("click", applySheetSequence);
  $("#preview-check-batch").addEventListener("click", checkBatchOrders);

  document.addEventListener("click", (event) => {
    const viewClient = event.target.closest("[data-preview-client-view]");
    if (viewClient) openClientCard(viewClient.dataset.previewClientView);

    const previewAction = event.target.closest("[data-preview-action]");
    if (previewAction) {
      if (previewAction.dataset.previewAction === "open-single") openSingleOrder();
      else if (previewAction.dataset.previewAction === "open-batch") openBatchOrder();
      else showNotice("שמירה או עריכת נתוני לקוחות חסומות עד התקנת הגירת העסק וחיבור RPC מאובטח.", true);
    }
    if (event.target.closest("[data-preview-close]")) event.target.closest("dialog").close();
    if (event.target.matches("dialog.modal")) event.target.close();
  });

  $("#preview-today").textContent = "";
  renderClients();
  renderOrders();
})();
