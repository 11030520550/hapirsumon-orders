"use strict";

(() => {
  const LOCAL_DATA_KEY = "modaat-newspaper-ads-v1";
  const numberFormat = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 });
  const dateFormat = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", year: "numeric" });
  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));

  let supabaseClient = null;
  let data = { clients: [], orders: [] };
  let toastTimer;
  let editingClientId = null;
  let editingClientVersion = null;
  let editingOrderId = null;
  let editingOrderVersion = null;
  let activeUserId = null;
  let loadingUserId = null;
  let importPlan = null;
  let localBackupDownloaded = false;
  let realtimeChannel = null;
  let realtimeConnected = false;
  let refreshTimer = null;
  let pollingTimer = null;
  let approvalTimer = null;
  let cloudFetchRequest = 0;
  let lastSyncError = "";

  function toLocalDateValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatCurrency(amount) {
    return `₪${numberFormat.format(amount)}`;
  }

  function displayDate(value) {
    if (!value) return "—";
    const parts = value.split("-").map(Number);
    return dateFormat.format(new Date(parts[0], parts[1] - 1, parts[2]));
  }

  function showToast(message, isError = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("toast-error", isError);
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 4000);
  }

  function friendlyError(error) {
    const code = error && error.code ? String(error.code) : "";
    const message = error && error.message ? String(error.message) : "";
    if (code === "NOT_APPROVED") return message;
    if (code === "SETUP_REQUIRED") return message;
    if (/row-level security|permission denied|not allowed/i.test(message) || code === "42501") {
      return "אין לחשבון זה הרשאה לבצע את הפעולה. ודאי שהמשתמש אושר ב-Supabase.";
    }
    if (/invalid login credentials/i.test(message) || code === "invalid_credentials") {
      return "כתובת הדוא״ל או הסיסמה שגויים.";
    }
    if (/email not confirmed/i.test(message)) {
      return "יש לאשר את כתובת הדוא״ל דרך הודעת האישור שנשלחה.";
    }
    if (code === "STALE_RECORD") {
      return "הרשומה השתנתה אצל משתמשת אחרת. הנתונים שלך לא נשמרו; רענני את הרשימה, בדקי את השינוי ונסי שוב.";
    }
    if (code === "VERSION_REQUIRED") {
      return "נדרשת התקנת עדכון מסד הנתונים למניעת דריסת שינויים מקבילים. יש להריץ את supabase-reliability-migration.sql.";
    }
    if (/duplicate key|already exists/i.test(message) || code === "23505") {
      return "רשומה עם אותו מזהה כבר קיימת. הנתונים לא נדרסו; בדקי כפילויות ונסי שוב.";
    }
    if (/foreign key|violates foreign key/i.test(message) || code === "23503") {
      return "לא ניתן לבצע את הפעולה כי קיימות רשומות קשורות. בדקי את הלקוחות וההזמנות.";
    }
    if (/failed to fetch|network|fetch/i.test(message)) {
      return "לא ניתן להגיע ל-Supabase. בדקי את החיבור לאינטרנט ואת כתובת הפרויקט.";
    }
    if (/schema cache|column .* does not exist|could not find the .* column/i.test(message) || code.startsWith("PGRST")) {
      return "מבנה הטבלאות ב-Supabase אינו תואם להגדרות האתר. בדקי את הסכימה וההרשאות.";
    }
    return message ? `הפעולה לא הושלמה מול Supabase: ${message}` : "הפעולה נכשלה. נסי שוב.";
  }

  function showAuth(message = "", sessionAvailable = false) {
    $("#app-shell").hidden = true;
    $("#auth-screen").hidden = false;
    $("#login-message").textContent = message;
    $("#auth-sign-out").hidden = !sessionAvailable;
    $("#auth-retry").hidden = !sessionAvailable;
  }

  function showApplication() {
    $("#auth-screen").hidden = true;
    $("#app-shell").hidden = false;
  }

  function mapClient(row) {
    return { id: row.id, name: row.name, phone: row.phone || "", email: row.email || "", updatedAt: row.updated_at };
  }

  function mapOrder(row) {
    return {
      id: row.id,
      clientId: row.client_id,
      date: row.publication_date,
      section: row.section,
      amount: Number(row.amount),
      paymentStatus: row.payment_status,
      notes: row.notes || "",
      updatedAt: row.updated_at
    };
  }

  async function checkApproval() {
    const { data: approved, error } = await supabaseClient.rpc("current_user_is_approved");
    if (error) {
      if (error.code === "PGRST202" || /current_user_is_approved/i.test(error.message || "")) {
        const setupError = new Error("בדיקת ההרשאות אינה זמינה. יש להוסיף את פונקציית current_user_is_approved לפי הוראות SUPABASE-SETUP.md.");
        setupError.code = "SETUP_REQUIRED";
        throw setupError;
      }
      throw error;
    }
    if (approved !== true) {
      const error = new Error("החשבון התחבר אך עדיין לא אושר לשימוש. בקשי ממנהלת המערכת להוסיף אותו לרשימת המשתמשים המורשים.");
      error.code = "NOT_APPROVED";
      throw error;
    }
  }

  async function fetchCloudData() {
    const requestId = ++cloudFetchRequest;
    const [clientsResult, ordersResult] = await Promise.all([
      supabaseClient.from("clients").select("id,name,phone,email,updated_at").order("name"),
      supabaseClient.from("orders")
        .select("id,client_id,publication_date,section,amount,payment_status,notes,updated_at")
        .order("publication_date", { ascending: false })
    ]);
    if (requestId !== cloudFetchRequest) return false;
    if (clientsResult.error) throw clientsResult.error;
    if (ordersResult.error) throw ordersResult.error;
    data = {
      clients: clientsResult.data.map(mapClient),
      orders: ordersResult.data.map(mapOrder)
    };
    render();
    return true;
  }

  function setSyncStatus(message) {
    $("#sync-status").textContent = message;
  }

  function staleRecordError() {
    const error = new Error("The record changed after it was loaded.");
    error.code = "STALE_RECORD";
    return error;
  }

  function versionRequiredError() {
    const error = new Error("The updated_at migration has not been applied.");
    error.code = "VERSION_REQUIRED";
    return error;
  }

  function startPollingSync() {
    if (pollingTimer || !activeUserId) return;
    pollingTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshCloudData(true);
    }, 15000);
  }

  function stopRealtimeSync() {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    if (pollingTimer) window.clearInterval(pollingTimer);
    if (approvalTimer) window.clearInterval(approvalTimer);
    refreshTimer = null;
    pollingTimer = null;
    approvalTimer = null;
    realtimeConnected = false;
    if (realtimeChannel) {
      supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
  }

  async function refreshCloudData(quiet = false) {
    if (!activeUserId) return;
    if (!navigator.onLine) {
      setSyncStatus("אין חיבור לרשת — השינויים לא יישמרו");
      return;
    }
    try {
      await checkApproval();
      const applied = await fetchCloudData();
      if (!applied || !activeUserId) return;
      lastSyncError = "";
      setSyncStatus(realtimeConnected ? "סנכרון חי פעיל" : "סנכרון אוטומטי פעיל");
    } catch (error) {
      console.error("סנכרון נתוני הענן נכשל:", error);
      if (error.code === "NOT_APPROVED" || error.code === "SETUP_REQUIRED") {
        activeUserId = null;
        stopRealtimeSync();
        cloudFetchRequest++;
        data = { clients: [], orders: [] };
        render();
        setSyncStatus("הגישה לנתונים נחסמה");
        showAuth(friendlyError(error), true);
        return;
      }
      setSyncStatus("שגיאת סנכרון — הנתונים לא עודכנו");
      if (!quiet && lastSyncError !== String(error.message || error)) {
        showToast(`הסנכרון נכשל: ${friendlyError(error)}`, true);
      }
      lastSyncError = String(error.message || error);
    }
  }

  function scheduleCloudRefresh() {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => refreshCloudData(true), 250);
  }

  function startRealtimeSync() {
    stopRealtimeSync();
    if (!activeUserId) return;
    approvalTimer = window.setInterval(async () => {
      try {
        await checkApproval();
      } catch (error) {
        if (error.code === "NOT_APPROVED" || error.code === "SETUP_REQUIRED") {
          activeUserId = null;
          stopRealtimeSync();
          cloudFetchRequest++;
          data = { clients: [], orders: [] };
          render();
          setSyncStatus("הגישה לנתונים נחסמה");
          showAuth(friendlyError(error), true);
        } else {
          console.error("בדיקת אישור תקופתית נכשלה:", error);
          setSyncStatus("לא ניתן לאמת כרגע את ההרשאות");
        }
      }
    }, 60000);
    if (!navigator.onLine) {
      setSyncStatus("אין חיבור לרשת — ממתינה לחיבור מחדש");
      startPollingSync();
      return;
    }
    try {
      realtimeChannel = supabaseClient.channel("approved-data-sync")
        .on("postgres_changes", { event: "*", schema: "public", table: "clients" }, scheduleCloudRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, scheduleCloudRefresh)
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            realtimeConnected = true;
            if (pollingTimer) window.clearInterval(pollingTimer);
            pollingTimer = null;
            setSyncStatus("סנכרון חי פעיל");
            scheduleCloudRefresh();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            realtimeConnected = false;
            setSyncStatus("סנכרון חי לא זמין — מופעלת בדיקה אוטומטית");
            startPollingSync();
          }
        });
    } catch (error) {
      console.error("הפעלת סנכרון חי נכשלה:", error);
      realtimeChannel = null;
      realtimeConnected = false;
      setSyncStatus("סנכרון חי לא זמין — מופעלת בדיקה אוטומטית");
      startPollingSync();
    }
  }

  async function activateSession(session) {
    if (!session || !session.user) {
      stopRealtimeSync();
      cloudFetchRequest++;
      activeUserId = null;
      loadingUserId = null;
      data = { clients: [], orders: [] };
      render();
      setSyncStatus("התחברות נדרשת");
      showAuth();
      return;
    }
    if (activeUserId === session.user.id && !$("#app-shell").hidden) return;
    if (loadingUserId === session.user.id) return;

    loadingUserId = session.user.id;
    showAuth("מתחברת למסד הנתונים ובודקת הרשאות…", true);
    try {
      await checkApproval();
      await fetchCloudData();
      activeUserId = session.user.id;
      showApplication();
      startRealtimeSync();
    } catch (error) {
      stopRealtimeSync();
      cloudFetchRequest++;
      activeUserId = null;
      data = { clients: [], orders: [] };
      render();
      console.error("טעינת נתוני Supabase נכשלה:", error);
      showAuth(friendlyError(error), true);
    } finally {
      loadingUserId = null;
    }
  }

  function renderStats() {
    const paidOrders = data.orders.filter((order) => order.paymentStatus === "paid");
    const pendingOrders = data.orders.filter((order) => order.paymentStatus !== "paid");
    $("#stat-orders").textContent = numberFormat.format(data.orders.length);
    $("#stat-paid").textContent = formatCurrency(paidOrders.reduce((sum, order) => sum + Number(order.amount), 0));
    $("#stat-pending").textContent = numberFormat.format(pendingOrders.length);
    $("#stat-balance").textContent = formatCurrency(pendingOrders.reduce((sum, order) => sum + Number(order.amount), 0));
  }

  function renderClients() {
    const select = $("#order-client");
    const selected = select.value;
    const options = data.clients.map((client) =>
      `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}</option>`
    ).join("");
    select.innerHTML = `<option value="">בחירת לקוח</option>${options}`;
    if (data.clients.some((client) => client.id === selected)) select.value = selected;
    renderClientTable();
  }

  function renderClientTable() {
    const query = $("#client-search-input").value.trim().toLocaleLowerCase("he");
    const clients = [...data.clients]
      .sort((left, right) => left.name.localeCompare(right.name, "he"))
      .filter((client) => `${client.name} ${client.phone || ""}`.toLocaleLowerCase("he").includes(query));

    $("#clients-body").innerHTML = clients.map((client) => `<tr>
      <td class="client-name">${escapeHtml(client.name)}</td>
      <td>${escapeHtml(client.phone || "—")}</td>
      <td>${escapeHtml(client.email || "—")}</td>
      <td class="client-actions">
        <button class="button button-outline client-action" type="button" data-client-view="${escapeHtml(client.id)}" aria-label="צפייה בפרטי ${escapeHtml(client.name)}">צפייה</button>
        <button class="button button-outline client-action" type="button" data-client-edit="${escapeHtml(client.id)}" aria-label="עריכת ${escapeHtml(client.name)}">עריכה</button>
      </td>
    </tr>`).join("");
    $("#clients-empty-state").hidden = clients.length !== 0;
    $("#clients-count").textContent = `${numberFormat.format(clients.length)} ${clients.length === 1 ? "לקוח" : "לקוחות"}`;
  }

  function renderOrders() {
    const query = $("#search-input").value.trim().toLocaleLowerCase("he");
    const filter = $("#payment-filter").value;
    const clientsById = new Map(data.clients.map((client) => [client.id, client]));
    const orders = [...data.orders]
      .sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id))
      .filter((order) => {
        const client = clientsById.get(order.clientId);
        const searchable = `${order.id} ${client ? client.name : ""} ${order.section}`.toLocaleLowerCase("he");
        return searchable.includes(query) && (filter === "all" || order.paymentStatus === filter);
      });

    $("#orders-body").innerHTML = orders.map((order) => {
      const client = clientsById.get(order.clientId);
      const paid = order.paymentStatus === "paid";
      const clientName = client ? client.name : "לקוח לא זמין";
      return `<tr>
        <td class="order-number">#${escapeHtml(order.id)}</td>
        <td class="client-name">${escapeHtml(clientName)}</td>
        <td>${escapeHtml(displayDate(order.date))}</td>
        <td>${escapeHtml(order.section)}</td>
        <td class="amount-cell">${escapeHtml(formatCurrency(Number(order.amount)))}</td>
        <td><select class="payment-select ${paid ? "paid" : "pending"}" data-order-id="${escapeHtml(order.id)}" aria-label="סטטוס תשלום להזמנה ${escapeHtml(order.id)}">
          <option value="paid" ${paid ? "selected" : ""}>שולם</option>
          <option value="pending" ${!paid ? "selected" : ""}>ממתין לתשלום</option>
        </select></td>
        <td class="client-actions">
          <button class="button button-outline client-action" type="button" data-order-edit="${escapeHtml(order.id)}" aria-label="עריכת הזמנה ${escapeHtml(order.id)}">עריכה</button>
          <button class="delete-order" type="button" data-delete-order="${escapeHtml(order.id)}" aria-label="מחיקת הזמנה ${escapeHtml(order.id)}" title="מחיקת הזמנה">×</button>
        </td>
      </tr>`;
    }).join("");
    $("#empty-state").hidden = orders.length !== 0;
    $("#orders-count").textContent = `${numberFormat.format(orders.length)} ${orders.length === 1 ? "הזמנה" : "הזמנות"}`;
  }

  function render() {
    renderStats();
    renderClients();
    renderOrders();
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (id === "client-modal") {
      editingClientId = null;
      editingClientVersion = null;
      $("#client-form").reset();
      $("#client-modal-title").textContent = "הוספת לקוח חדש";
      $("#client-submit-button").textContent = "שמירת לקוח";
      $("#client-message").textContent = "";
    }
    if (id === "order-modal") {
      editingOrderId = null;
      editingOrderVersion = null;
      $("#order-form").reset();
      $("#order-modal-title").textContent = "יצירת הזמנת פרסום";
      $("#order-message").textContent = "";
      renderClients();
      const dateField = $('#order-form [name="date"]');
      dateField.value = toLocalDateValue(new Date());
    }
    modal.showModal();
  }

  function openClientForm(clientId) {
    const client = data.clients.find((item) => item.id === clientId);
    if (!client) {
      showToast("הלקוח לא נמצא.", true);
      return;
    }
    editingClientId = client.id;
    editingClientVersion = client.updatedAt;
    const form = $("#client-form");
    form.elements.name.value = client.name;
    form.elements.phone.value = client.phone || "";
    form.elements.email.value = client.email || "";
    $("#client-modal-title").textContent = "עריכת פרטי לקוח";
    $("#client-submit-button").textContent = "שמירת שינויים";
    $("#client-message").textContent = "";
    $("#client-modal").showModal();
  }

  function openOrderForm(orderId) {
    const order = data.orders.find((item) => item.id === orderId);
    if (!order) {
      showToast("ההזמנה לא נמצאה.", true);
      return;
    }
    openModal("order-modal");
    editingOrderId = order.id;
    editingOrderVersion = order.updatedAt;
    const form = $("#order-form");
    form.elements.clientId.value = order.clientId;
    form.elements.date.value = order.date;
    form.elements.section.value = order.section;
    form.elements.amount.value = String(order.amount);
    form.elements.paymentStatus.value = order.paymentStatus;
    form.elements.notes.value = order.notes;
    $("#order-modal-title").textContent = "עריכת הזמנת פרסום";
    $("#order-message").textContent = "";
  }

  function showView(viewName, activeLink) {
    const clientsVisible = viewName === "clients";
    $("#dashboard-view").hidden = clientsVisible;
    $("#clients-view").hidden = !clientsVisible;
    document.querySelectorAll(".main-nav [data-view]").forEach((link) => {
      const active = link === activeLink;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    $(".breadcrumbs strong").textContent = clientsVisible ? "רשימת לקוחות" : "לוח בקרה";
  }

  function setImportPreview(message, tone = "") {
    const preview = $("#local-import-preview");
    preview.textContent = message;
    preview.className = `import-preview${tone ? ` ${tone}` : ""}`;
  }

  function openImportDialog() {
    localBackupDownloaded = false;
    importPlan = null;
    $("#local-import-file").value = "";
    $("#local-import-file").disabled = true;
    $("#confirm-external-backup").checked = false;
    $("#run-local-import").disabled = true;
    $("#local-import-message").textContent = "";
    setImportPreview("יש להוריד גיבוי עדכני מהענן או לאשר שנשמר גיבוי חיצוני לפני בחירת קובץ.");
    $("#local-import-modal").showModal();
  }

  function downloadLocalBackup() {
    let rawData;
    try {
      rawData = localStorage.getItem(LOCAL_DATA_KEY);
    } catch (error) {
      console.error("קריאת הגיבוי המקומי נכשלה:", error);
      if ($("#local-import-modal").open) $("#local-import-message").textContent = "לא ניתן לקרוא את האחסון המקומי בדפדפן הזה.";
      else $("#login-message").textContent = "לא ניתן לקרוא את האחסון המקומי בדפדפן הזה.";
      return;
    }
    if (!rawData) {
      const message = "לא נמצאו נתונים מקומיים לגיבוי בדפדפן הזה. אם הנתונים נשמרו ב-file:// או במחשב אחר, הורידי את הגיבוי מהמקור לפני המעבר.";
      if ($("#local-import-modal").open) $("#local-import-message").textContent = message;
      else $("#login-message").textContent = message;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch (error) {
      console.error("פענוח הנתונים המקומיים נכשל:", error);
      if ($("#local-import-modal").open) $("#local-import-message").textContent = "הנתונים המקומיים אינם JSON תקין. לא בוצע שינוי.";
      else $("#login-message").textContent = "הנתונים המקומיים אינם JSON תקין. לא בוצע שינוי.";
      return;
    }
    const backup = {
      format: "modaat-local-backup-v1",
      exportedAt: new Date().toISOString(),
      storageKey: LOCAL_DATA_KEY,
      data: parsed
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `modaat-local-backup-${toLocalDateValue(new Date())}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    localBackupDownloaded = true;
    if ($("#local-import-modal").open) {
      $("#local-import-file").disabled = false;
      $("#local-import-message").textContent = "";
      setImportPreview("הגיבוי הורד. כעת אפשר לבחור את קובץ הגיבוי לבדיקה.", "success");
    } else {
      showToast("הגיבוי המקומי הורד. שמרי אותו במקום בטוח לפני המעבר לענן.");
    }
  }

  async function downloadCloudBackup() {
    const button = $("#download-cloud-backup");
    button.disabled = true;
    try {
      if (!activeUserId) throw new Error("נדרשת התחברות כדי להוריד גיבוי מהענן.");
      await fetchCloudData();
      const backup = {
        format: "modaat-local-backup-v1",
        exportedAt: new Date().toISOString(),
        storageKey: LOCAL_DATA_KEY,
        data: {
          clients: data.clients.map(({ id, name, phone, email }) => ({ id, name, phone, email })),
          orders: data.orders.map(({ id, clientId, date, section, amount, paymentStatus, notes }) => ({
            id, clientId, date, section, amount, paymentStatus, notes
          }))
        }
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `modaat-cloud-backup-${toLocalDateValue(new Date())}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      localBackupDownloaded = true;
      $("#local-import-file").disabled = false;
      setImportPreview("הגיבוי העדכני מהענן הורד. אפשר לבחור קובץ JSON לבדיקה.", "success");
      showToast("גיבוי עדכני מהענן הורד כ-JSON בקידוד UTF-8.");
    } catch (error) {
      console.error("הורדת גיבוי מהענן נכשלה:", error);
      $("#local-import-message").textContent = friendlyError(error);
    } finally {
      button.disabled = false;
    }
  }

  function canImportAfterBackup() {
    return localBackupDownloaded || $("#confirm-external-backup").checked;
  }

  function hasInvalidTextControl(value) {
    return typeof value === "string" && /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(value);
  }

  function validateImportedData(value) {
    const candidate = value && value.format === "modaat-local-backup-v1" ? value.data : value;
    if (!candidate || !Array.isArray(candidate.clients) || !Array.isArray(candidate.orders)) {
      throw new Error("קובץ הגיבוי חייב לכלול מערכים של clients ו-orders.");
    }
    const clients = candidate.clients.map((client) => {
      if (!client || typeof client.id !== "string" || !client.id.trim() || typeof client.name !== "string" || !client.name.trim()) {
        throw new Error("נמצא לקוח ללא מזהה או שם תקין.");
      }
      if ((client.phone != null && typeof client.phone !== "string") ||
          (client.email != null && typeof client.email !== "string") ||
          String(client.phone || "").length > 30 || String(client.email || "").length > 100) {
        throw new Error(`פרטי הקשר של הלקוח ${client.id} אינם תקינים.`);
      }
      if (hasInvalidTextControl(client.name) || hasInvalidTextControl(client.phone) || hasInvalidTextControl(client.email)) {
        throw new Error("קובץ הגיבוי מכיל תווי בקרה חשודים בטקסט. ייתכן שהקידוד השתבש; השווי לגיבוי המקורי ואל תייבאי קובץ זה.");
      }
      return { id: client.id, name: client.name.trim(), phone: String(client.phone || ""), email: String(client.email || "") };
    });
    const orders = candidate.orders.map((order) => {
      const amount = Number(order && order.amount);
      if (!order || typeof order.id !== "string" || !order.id.trim() ||
          typeof order.clientId !== "string" || !order.clientId.trim() ||
          typeof order.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(order.date) ||
          typeof order.section !== "string" || !order.section.trim() || order.section.length > 60 ||
          !Number.isFinite(amount) || amount <= 0 || amount > 99999999 || Number(amount.toFixed(2)) !== amount ||
          !["paid", "pending"].includes(order.paymentStatus)) {
        throw new Error("נמצאה הזמנה עם שדות חסרים או לא תקינים.");
      }
      if (hasInvalidTextControl(order.section)) {
        throw new Error("קובץ הגיבוי מכיל תווי בקרה חשודים במדור הזמנה. ייתכן שהקידוד השתבש; השווי לגיבוי המקורי ואל תייבאי קובץ זה.");
      }
      const parsedDate = new Date(`${order.date}T00:00:00Z`);
      if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== order.date) {
        throw new Error(`תאריך הפרסום בהזמנה ${order.id} אינו תקין.`);
      }
      if (order.notes != null && (typeof order.notes !== "string" || order.notes.length > 300 || hasInvalidTextControl(order.notes))) {
        throw new Error(`ההערות בהזמנה ${order.id} אינן תקינות.`);
      }
      return {
        id: order.id,
        clientId: order.clientId,
        date: order.date,
        section: order.section.trim(),
        amount,
        paymentStatus: order.paymentStatus,
        notes: order.notes || ""
      };
    });
    if (new Set(clients.map((client) => client.id)).size !== clients.length) {
      throw new Error("קובץ הגיבוי מכיל מזהי לקוחות כפולים.");
    }
    if (new Set(orders.map((order) => order.id)).size !== orders.length) {
      throw new Error("קובץ הגיבוי מכיל מזהי הזמנות כפולים.");
    }
    return { clients, orders };
  }

  function clientDataMatches(localClient, cloudClient) {
    return localClient.id === cloudClient.id && localClient.name === cloudClient.name &&
      localClient.phone === (cloudClient.phone || "") && localClient.email === (cloudClient.email || "");
  }

  function orderDataMatches(localOrder, cloudOrder) {
    return localOrder.id === cloudOrder.id && localOrder.clientId === cloudOrder.client_id &&
      localOrder.date === cloudOrder.publication_date && localOrder.section === cloudOrder.section &&
      Number(localOrder.amount) === Number(cloudOrder.amount) && localOrder.paymentStatus === cloudOrder.payment_status &&
      localOrder.notes === (cloudOrder.notes || "");
  }

  async function prepareImport(value) {
    if (!canImportAfterBackup()) throw new Error("לפני בדיקת הקובץ יש להוריד גיבוי מקומי או לאשר שנשמר גיבוי נפרד ממקור הנתונים.");
    const imported = validateImportedData(value);
    const [clientsResult, ordersResult] = await Promise.all([
      supabaseClient.from("clients").select("id,name,phone,email"),
      supabaseClient.from("orders").select("id,client_id,publication_date,section,amount,payment_status,notes")
    ]);
    if (clientsResult.error) throw clientsResult.error;
    if (ordersResult.error) throw ordersResult.error;

    const existingClients = new Map(clientsResult.data.map((client) => [client.id, client]));
    const existingOrders = new Map(ordersResult.data.map((order) => [order.id, order]));
    const localClientIds = new Set(imported.clients.map((client) => client.id));
    const newClients = [];
    const identicalClients = [];
    const conflicts = [];
    for (const client of imported.clients) {
      const existing = existingClients.get(client.id);
      if (!existing) newClients.push(client);
      else if (clientDataMatches(client, existing)) identicalClients.push(client.id);
      else conflicts.push(`מזהה לקוח ${client.id} קיים עם פרטים שונים`);
    }
    const newOrders = [];
    const identicalOrders = [];
    for (const order of imported.orders) {
      if (!localClientIds.has(order.clientId) && !existingClients.has(order.clientId)) {
        conflicts.push(`הזמנה ${order.id} מפנה ללקוח חסר (${order.clientId})`);
        continue;
      }
      const existing = existingOrders.get(order.id);
      if (!existing) newOrders.push(order);
      else if (orderDataMatches(order, existing)) identicalOrders.push(order.id);
      else conflicts.push(`מזהה הזמנה ${order.id} קיים עם פרטים שונים`);
    }
    importPlan = { newClients, newOrders, identicalClients, identicalOrders, conflicts };
    return importPlan;
  }

  function describeImportPlan(plan) {
    const lines = [
      `לקוחות חדשים לייבוא: ${plan.newClients.length}`,
      `הזמנות חדשות לייבוא: ${plan.newOrders.length}`,
      `לקוחות זהים שכבר קיימים (ידולגו): ${plan.identicalClients.length}`,
      `הזמנות זהות שכבר קיימות (ידולגו): ${plan.identicalOrders.length}`
    ];
    if (plan.conflicts.length) lines.push(`התנגשויות: ${plan.conflicts.length}`, ...plan.conflicts.slice(0, 5));
    else if (!plan.newClients.length && !plan.newOrders.length) lines.push("כל הרשומות כבר קיימות; אין מה לייבא.");
    else lines.push("לא נמצאו התנגשויות. הייבוא יוסיף בלבד ולא יעדכן רשומות קיימות.");
    return lines.join("\n");
  }

  async function processSelectedImportFile(file) {
    $("#local-import-message").textContent = "";
    $("#run-local-import").disabled = true;
    importPlan = null;
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const plan = await prepareImport(parsed);
      const tone = plan.conflicts.length ? "error" : "success";
      setImportPreview(describeImportPlan(plan), tone);
      $("#run-local-import").disabled = plan.conflicts.length > 0 || (!plan.newClients.length && !plan.newOrders.length);
    } catch (error) {
      console.error("בדיקת קובץ הייבוא נכשלה:", error);
      setImportPreview(friendlyError(error), "error");
      $("#local-import-message").textContent = "לא ניתן לאשר את הקובץ לייבוא.";
      $("#local-import-file").value = "";
    }
  }

  async function executeLocalImport() {
    if (!canImportAfterBackup() || !importPlan || importPlan.conflicts.length) return;
    const button = $("#run-local-import");
    button.disabled = true;
    $("#local-import-message").textContent = "";
    try {
      if (importPlan.newClients.length) {
        const rows = importPlan.newClients.map((client) => ({
          id: client.id, name: client.name, phone: client.phone || null, email: client.email || null
        }));
        const { error } = await supabaseClient.from("clients").insert(rows);
        if (error) throw error;
      }
      if (importPlan.newOrders.length) {
        const rows = importPlan.newOrders.map((order) => ({
          id: order.id, client_id: order.clientId, publication_date: order.date,
          section: order.section, amount: order.amount, payment_status: order.paymentStatus, notes: order.notes
        }));
        const { error } = await supabaseClient.from("orders").insert(rows);
        if (error) throw error;
      }
      await fetchCloudData();
      showToast(`הייבוא הסתיים: ${importPlan.newClients.length} לקוחות ו-${importPlan.newOrders.length} הזמנות נוספו.`);
      $("#local-import-modal").close();
    } catch (error) {
      console.error("ייבוא רשומות מקומיות נכשל:", error);
      $("#local-import-message").textContent = `${friendlyError(error)} אם חלק מהלקוחות כבר נוספו, בחרי שוב את אותו הקובץ כדי לבדוק מחדש; רשומות קיימות לא יידרסו.`;
      importPlan = null;
      $("#local-import-file").value = "";
      button.disabled = true;
    }
  }

  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      event.preventDefault();
      showView(viewButton.dataset.view, viewButton);
      if (viewButton.dataset.scroll) {
        window.setTimeout(() => document.getElementById(viewButton.dataset.scroll).scrollIntoView({ behavior: "smooth" }), 0);
      }
    }
    const openButton = event.target.closest("[data-open-modal]");
    if (openButton) openModal(openButton.dataset.openModal);
    if (event.target.closest("[data-close-modal]")) event.target.closest("dialog").close();
    if (event.target.matches("dialog.modal")) event.target.close();

    const viewClientButton = event.target.closest("[data-client-view]");
    if (viewClientButton) {
      const client = data.clients.find((item) => item.id === viewClientButton.dataset.clientView);
      if (client) {
        $("#client-details-title").textContent = client.name;
        $("#client-details-phone").textContent = client.phone || "לא צוין";
        $("#client-details-email").textContent = client.email || "לא צוין";
        $("#client-details-edit").dataset.clientEdit = client.id;
        $("#client-details-modal").showModal();
      }
    }
    const editClientButton = event.target.closest("[data-client-edit]");
    if (editClientButton) {
      const detailsModal = $("#client-details-modal");
      if (detailsModal.open) detailsModal.close();
      openClientForm(editClientButton.dataset.clientEdit);
    }
    if (event.target.closest("#open-import")) openImportDialog();
    if (event.target.closest("#download-cloud-backup")) downloadCloudBackup();
    if (event.target.closest("#download-local-backup")) downloadLocalBackup();
    if (event.target.closest("#download-prelogin-backup")) downloadLocalBackup();
    if (event.target.closest("#run-local-import")) executeLocalImport();
    if (event.target.closest("#sign-out")) signOut();
    if (event.target.closest("#auth-sign-out")) signOut();
    if (event.target.closest("#auth-retry")) retrySession();

    const editOrderButton = event.target.closest("[data-order-edit]");
    if (editOrderButton) openOrderForm(editOrderButton.dataset.orderEdit);

    const deleteButton = event.target.closest("[data-delete-order]");
    if (deleteButton) {
      const order = data.orders.find((item) => item.id === deleteButton.dataset.deleteOrder);
      if (order && window.confirm(`למחוק את הזמנה ${order.id}?`)) deleteOrder(order.id);
    }
  });

  async function signOut() {
    if (!supabaseClient) return;
    try {
      const { error } = await supabaseClient.auth.signOut();
      if (error) throw error;
      stopRealtimeSync();
      cloudFetchRequest++;
      activeUserId = null;
      data = { clients: [], orders: [] };
      render();
      setSyncStatus("התחברות נדרשת");
      showAuth("התנתקת מהמערכת.");
    } catch (error) {
      console.error("התנתקות נכשלה:", error);
      showToast(`ההתנתקות נכשלה: ${friendlyError(error)}`, true);
    }
  }

  async function retrySession() {
    if (!supabaseClient) return;
    $("#login-message").textContent = "בודקת שוב את ההרשאות…";
    try {
      const { data: sessionData, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      activeUserId = null;
      await activateSession(sessionData.session);
    } catch (error) {
      console.error("בדיקת הרשאות חוזרת נכשלה:", error);
      $("#login-message").textContent = friendlyError(error);
    }
  }

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabaseClient) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const submit = $("#login-submit");
    submit.disabled = true;
    $("#login-message").textContent = "מתחברת…";
    const formData = new FormData(form);
    try {
      const { data: authData, error } = await supabaseClient.auth.signInWithPassword({
        email: String(formData.get("email")).trim(),
        password: String(formData.get("password"))
      });
      if (error) throw error;
      form.elements.password.value = "";
      await activateSession(authData.session);
    } catch (error) {
      console.error("התחברות נכשלה:", error);
      $("#login-message").textContent = friendlyError(error);
    } finally {
      submit.disabled = false;
    }
  });

  $("#client-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const formData = new FormData(form);
    const clientDetails = {
      name: String(formData.get("name")).trim(),
      phone: String(formData.get("phone")).trim(),
      email: String(formData.get("email")).trim()
    };
    if (!clientDetails.name) {
      $("#client-message").textContent = "יש להזין שם לקוח.";
      return;
    }
    const submit = $("#client-submit-button");
    submit.disabled = true;
    try {
      if (editingClientId) {
        if (!editingClientVersion) throw versionRequiredError();
        const { data: updatedRow, error } = await supabaseClient.from("clients")
          .update({ name: clientDetails.name, phone: clientDetails.phone || null, email: clientDetails.email || null })
          .eq("id", editingClientId).eq("updated_at", editingClientVersion)
          .select("id,name,phone,email,updated_at").maybeSingle();
        if (error) throw error;
        if (!updatedRow) throw staleRecordError();
        data.clients = data.clients.map((client) => client.id === editingClientId ? mapClient(updatedRow) : client);
        showToast("פרטי הלקוח עודכנו.");
      } else {
        const client = { id: `c-${crypto.randomUUID()}`, ...clientDetails };
        const { data: insertedRow, error } = await supabaseClient.from("clients")
          .insert({ id: client.id, name: client.name, phone: client.phone || null, email: client.email || null })
          .select("id,name,phone,email,updated_at").single();
        if (error) throw error;
        data.clients.push(mapClient(insertedRow));
        $("#client-search-input").value = "";
        showToast("הלקוח נוסף בהצלחה.");
      }
      render();
      form.reset();
      $("#client-modal").close();
      editingClientId = null;
      editingClientVersion = null;
    } catch (error) {
      console.error("שמירת לקוח נכשלה:", error);
      $("#client-message").textContent = friendlyError(error);
      if (error.code === "STALE_RECORD") {
        try { await fetchCloudData(); } catch (refreshError) {
          console.error("רענון לאחר התנגשות בעריכת לקוח נכשל:", refreshError);
        }
      }
    } finally {
      submit.disabled = false;
    }
  });

  $("#order-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const formData = new FormData(form);
    const amount = Number(formData.get("amount"));
    const clientId = String(formData.get("clientId"));
    if (!data.clients.some((client) => client.id === clientId)) {
      $("#order-message").textContent = "יש לבחור לקוח קיים.";
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      $("#order-message").textContent = "יש להזין סכום חיובי ותקין.";
      return;
    }
    const orderFields = {
      clientId,
      date: String(formData.get("date")),
      section: String(formData.get("section")).trim(),
      amount,
      paymentStatus: String(formData.get("paymentStatus")),
      notes: String(formData.get("notes")).trim()
    };
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const values = {
        client_id: orderFields.clientId,
        publication_date: orderFields.date,
        section: orderFields.section,
        amount: orderFields.amount,
        payment_status: orderFields.paymentStatus,
        notes: orderFields.notes
      };
      if (editingOrderId) {
        if (!editingOrderVersion) throw versionRequiredError();
        const { data: updatedRow, error } = await supabaseClient.from("orders")
          .update(values).eq("id", editingOrderId).eq("updated_at", editingOrderVersion)
          .select("id,client_id,publication_date,section,amount,payment_status,notes,updated_at").maybeSingle();
        if (error) throw error;
        if (!updatedRow) throw staleRecordError();
        data.orders = data.orders.map((item) => item.id === editingOrderId ? mapOrder(updatedRow) : item);
        showToast("פרטי ההזמנה עודכנו.");
      } else {
        const { data: insertedRow, error } = await supabaseClient.from("orders").insert({
          id: `o-${crypto.randomUUID()}`,
          ...values
        }).select("id,client_id,publication_date,section,amount,payment_status,notes,updated_at").single();
        if (error) throw error;
        data.orders.push(mapOrder(insertedRow));
        showToast("ההזמנה נוצרה בהצלחה.");
      }
      render();
      form.reset();
      $("#order-modal").close();
      editingOrderId = null;
      editingOrderVersion = null;
    } catch (error) {
      console.error("שמירת הזמנה נכשלה:", error);
      $("#order-message").textContent = friendlyError(error);
      if (error.code === "STALE_RECORD") {
        try { await fetchCloudData(); } catch (refreshError) {
          console.error("רענון לאחר התנגשות בעריכת הזמנה נכשל:", refreshError);
        }
      }
    } finally {
      submit.disabled = false;
    }
  });

  async function deleteOrder(orderId) {
    const order = data.orders.find((item) => item.id === orderId);
    if (!order) return;
    try {
      if (!order.updatedAt) throw versionRequiredError();
      const { data: deletedRows, error } = await supabaseClient.from("orders").delete()
        .eq("id", orderId).eq("updated_at", order.updatedAt).select("id");
      if (error) throw error;
      if (!deletedRows || deletedRows.length === 0) throw staleRecordError();
      data.orders = data.orders.filter((order) => order.id !== orderId);
      render();
      showToast("ההזמנה נמחקה.");
    } catch (error) {
      console.error("מחיקת הזמנה נכשלה:", error);
      showToast(friendlyError(error), true);
      if (error.code === "STALE_RECORD") await refreshCloudData(true);
    }
  }

  $("#orders-body").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-order-id]");
    if (!select) return;
    const order = data.orders.find((item) => item.id === select.dataset.orderId);
    if (!order) return;
    const previousStatus = order.paymentStatus;
    const requestedStatus = select.value;
    select.disabled = true;
    try {
      if (!order.updatedAt) throw versionRequiredError();
      const { data: updatedRow, error } = await supabaseClient.from("orders")
        .update({ payment_status: requestedStatus }).eq("id", order.id).eq("updated_at", order.updatedAt)
        .select("updated_at").maybeSingle();
      if (error) throw error;
      if (!updatedRow) throw staleRecordError();
      order.paymentStatus = requestedStatus;
      order.updatedAt = updatedRow.updated_at;
      render();
      showToast("סטטוס התשלום עודכן.");
    } catch (error) {
      console.error("עדכון סטטוס תשלום נכשל:", error);
      order.paymentStatus = previousStatus;
      render();
      showToast(friendlyError(error), true);
      if (error.code === "STALE_RECORD") await refreshCloudData(true);
    }
  });

  $("#search-input").addEventListener("input", renderOrders);
  $("#payment-filter").addEventListener("change", renderOrders);
  $("#client-search-input").addEventListener("input", renderClientTable);
  $("#local-import-file").addEventListener("change", (event) => processSelectedImportFile(event.target.files[0]));
  window.addEventListener("offline", () => {
    if (!activeUserId) return;
    setSyncStatus("אין חיבור לרשת — השינויים לא יישמרו");
    showToast("החיבור לרשת נותק. שינויים לא יישמרו עד לחיבור מחדש.", true);
  });
  window.addEventListener("online", () => {
    if (!activeUserId) return;
    setSyncStatus("החיבור חזר — מתחברת מחדש ומסנכרנת");
    startRealtimeSync();
    refreshCloudData();
  });
  window.addEventListener("focus", () => {
    if (activeUserId) refreshCloudData(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (activeUserId && document.visibilityState === "visible") refreshCloudData(true);
  });
  $("#confirm-external-backup").addEventListener("change", (event) => {
    $("#local-import-file").disabled = !localBackupDownloaded && !event.target.checked;
    $("#run-local-import").disabled = !canImportAfterBackup() || !importPlan ||
      importPlan.conflicts.length > 0 || (!importPlan.newClients.length && !importPlan.newOrders.length);
  });
  $("#today-label").textContent = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

  async function initialize() {
    const config = window.MODAAT_SUPABASE_CONFIG;
    const url = config && typeof config.url === "string" ? config.url.trim() : "";
    const publishableKey = config && typeof config.publishableKey === "string" ? config.publishableKey.trim() : "";
    const validUrl = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url);
    let validKey = publishableKey.startsWith("sb_publishable_");
    if (!validKey && /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(publishableKey)) {
      try {
        const encodedPayload = publishableKey.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(atob(encodedPayload.padEnd(Math.ceil(encodedPayload.length / 4) * 4, "=")));
        validKey = payload.role === "anon";
      } catch {
        validKey = false;
      }
    }
    if (!validUrl || !validKey) {
      showAuth("כדי להתחבר, הגדירי את Project URL ואת מפתח ה-publishable בקובץ supabase-config.js. לא נעשה שימוש בשמירה מקומית.");
      $("#login-submit").disabled = true;
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      showAuth("ספריית Supabase לא נטענה. בדקי את החיבור לאינטרנט ונסי לטעון מחדש.");
      $("#login-submit").disabled = true;
      return;
    }
    supabaseClient = window.supabase.createClient(url, publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    const { data: sessionData, error } = await supabaseClient.auth.getSession();
    if (error) {
      console.error("בדיקת הפעלת Supabase נכשלה:", error);
      showAuth(friendlyError(error));
      return;
    }
    await activateSession(sessionData.session);
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || event === "SIGNED_IN" || event === "USER_UPDATED") {
        window.setTimeout(() => activateSession(session), 0);
      }
    });
  }

  data = { clients: [], orders: [] };
  render();
  initialize().catch((error) => {
    console.error("אתחול Supabase נכשל:", error);
    showAuth(friendlyError(error));
  });
})();
