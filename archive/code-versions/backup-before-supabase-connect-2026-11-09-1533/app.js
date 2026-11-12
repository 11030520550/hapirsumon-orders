"use strict";

(() => {
  const STORAGE_KEY = "modaat-newspaper-ads-v1";
  const numberFormat = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 });
  const dateFormat = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", year: "numeric" });
  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));

  function toLocalDateValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function makeDemoData() {
    const today = new Date();
    const dateAfter = (days) => {
      const date = new Date(today);
      date.setDate(date.getDate() + days);
      return toLocalDateValue(date);
    };
    return {
      clients: [
        { id: "c-1", name: "סטודיו נועה", phone: "050-1234567", email: "noa@example.com" },
        { id: "c-2", name: "אופק נדל״ן", phone: "052-7654321", email: "office@example.com" },
        { id: "c-3", name: "מאפיית שקד", phone: "03-5551234", email: "info@example.com" }
      ],
      orders: [
        { id: "o-1048", clientId: "c-1", date: dateAfter(2), section: "קהילה", amount: 1250, paymentStatus: "paid", notes: "" },
        { id: "o-1047", clientId: "c-2", date: dateAfter(5), section: "נדל״ן", amount: 2800, paymentStatus: "pending", notes: "" },
        { id: "o-1046", clientId: "c-3", date: dateAfter(8), section: "מקומי", amount: 950, paymentStatus: "pending", notes: "" },
        { id: "o-1045", clientId: "c-1", date: dateAfter(-3), section: "תרבות", amount: 1600, paymentStatus: "paid", notes: "" }
      ]
    };
  }

  function loadData() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === null) {
      const demoData = makeDemoData();
      saveData(demoData);
      return demoData;
    }
    try {
      const parsed = JSON.parse(saved);
      if (!parsed || !Array.isArray(parsed.clients) || !Array.isArray(parsed.orders)) {
        throw new Error("מבנה הנתונים השמורים אינו תקין.");
      }
      return parsed;
    } catch (error) {
      console.error("לא ניתן לטעון את הנתונים המקומיים:", error);
      window.alert("לא ניתן לטעון את הנתונים המקומיים. בדקו את הגדרות הדפדפן או נקו את נתוני האתר.");
      return { clients: [], orders: [] };
    }
  }

  function saveData(nextData) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextData));
    } catch (error) {
      console.error("לא ניתן לשמור את הנתונים המקומיים:", error);
      window.alert("שמירת הנתונים נכשלה. בדקו שיש מקום פנוי ושהאחסון המקומי בדפדפן זמין.");
      throw error;
    }
  }

  let data = loadData();
  let toastTimer;
  let editingClientId = null;

  function formatCurrency(amount) {
    return `₪${numberFormat.format(amount)}`;
  }

  function displayDate(value) {
    if (!value) return "—";
    const parts = value.split("-").map(Number);
    return dateFormat.format(new Date(parts[0], parts[1] - 1, parts[2]));
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2800);
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
        <td><button class="delete-order" type="button" data-delete-order="${escapeHtml(order.id)}" aria-label="מחיקת הזמנה ${escapeHtml(order.id)}" title="מחיקת הזמנה">×</button></td>
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

  function persistAndRender(message) {
    saveData(data);
    render();
    if (message) showToast(message);
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (id === "order-modal") {
      $("#order-message").textContent = "";
      renderClients();
      const dateField = $('#order-form [name="date"]');
      if (!dateField.value) dateField.value = toLocalDateValue(new Date());
    }
    if (id === "client-modal") {
      editingClientId = null;
      $("#client-form").reset();
      $("#client-modal-title").textContent = "הוספת לקוח חדש";
      $("#client-submit-button").textContent = "שמירת לקוח";
      $("#client-message").textContent = "";
    }
    modal.showModal();
  }

  function openClientForm(clientId) {
    const client = data.clients.find((item) => item.id === clientId);
    if (!client) {
      showToast("הלקוח לא נמצא.");
      return;
    }
    editingClientId = client.id;
    const form = $("#client-form");
    form.elements.name.value = client.name;
    form.elements.phone.value = client.phone || "";
    form.elements.email.value = client.email || "";
    $("#client-modal-title").textContent = "עריכת פרטי לקוח";
    $("#client-submit-button").textContent = "שמירת שינויים";
    $("#client-message").textContent = "";
    $("#client-modal").showModal();
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
    const deleteButton = event.target.closest("[data-delete-order]");
    if (deleteButton) {
      const order = data.orders.find((item) => item.id === deleteButton.dataset.deleteOrder);
      if (order && window.confirm(`למחוק את הזמנה ${order.id}?`)) {
        data.orders = data.orders.filter((item) => item.id !== order.id);
        persistAndRender("ההזמנה נמחקה.");
      }
    }
  });

  $("#client-form").addEventListener("submit", (event) => {
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
    if (editingClientId) {
      const clientIndex = data.clients.findIndex((client) => client.id === editingClientId);
      if (clientIndex === -1) {
        $("#client-message").textContent = "הלקוח לעריכה לא נמצא.";
        return;
      }
      data.clients[clientIndex] = { ...data.clients[clientIndex], ...clientDetails };
      persistAndRender("פרטי הלקוח עודכנו.");
    } else {
      data.clients.push({ id: `c-${Date.now()}`, ...clientDetails });
      $("#client-search-input").value = "";
      persistAndRender("הלקוח נוסף בהצלחה.");
    }
    form.reset();
    $("#client-modal").close();
    editingClientId = null;
  });

  $("#order-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const formData = new FormData(form);
    const amount = Number(formData.get("amount"));
    const order = {
      id: `o-${Date.now()}`,
      clientId: String(formData.get("clientId")),
      date: String(formData.get("date")),
      section: String(formData.get("section")).trim(),
      amount,
      paymentStatus: String(formData.get("paymentStatus")),
      notes: String(formData.get("notes")).trim()
    };
    if (!data.clients.some((client) => client.id === order.clientId)) {
      $("#order-message").textContent = "יש לבחור לקוח קיים.";
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      $("#order-message").textContent = "יש להזין סכום חיובי ותקין.";
      return;
    }
    data.orders.push(order);
    persistAndRender("ההזמנה נוצרה בהצלחה.");
    form.reset();
    $("#order-modal").close();
  });

  $("#orders-body").addEventListener("change", (event) => {
    const select = event.target.closest("[data-order-id]");
    if (!select) return;
    const order = data.orders.find((item) => item.id === select.dataset.orderId);
    if (!order) return;
    order.paymentStatus = select.value;
    persistAndRender("סטטוס התשלום עודכן.");
  });

  $("#search-input").addEventListener("input", renderOrders);
  $("#payment-filter").addEventListener("change", renderOrders);
  $("#client-search-input").addEventListener("input", renderClientTable);
  $("#today-label").textContent = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  render();
})();
