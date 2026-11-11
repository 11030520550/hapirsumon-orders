(function () {
  "use strict";

  const productionProjectRef = "sndaeogseawtwzwxiqst";
  const environmentStatus = document.getElementById("environment-status");
  const loginSection = document.getElementById("login-section");
  const testSection = document.getElementById("test-section");
  const loginForm = document.getElementById("login-form");
  const loginButton = document.getElementById("login-button");
  const testButton = document.getElementById("run-tests");
  const signOutButton = document.getElementById("sign-out");
  const testStatus = document.getElementById("test-status");
  const results = document.getElementById("results");
  let config = null;
  let client = null;
  let testRunActive = false;

  function setStatus(element, message, kind) {
    element.textContent = message;
    element.className = "status" + (kind ? " " + kind : "");
  }

  function publishableKeyIsSafe(key) {
    if (typeof key !== "string" || key.length < 20 || /secret|service_role/i.test(key)) {
      return false;
    }
    if (key.startsWith("sb_publishable_")) return true;

    const parts = key.split(".");
    if (parts.length !== 3) return false;
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.role === "anon";
    } catch (error) {
      return false;
    }
  }

  function validateConfig() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      return "ספריית Supabase לא נטענה. בדקו את החיבור לרשת ורעננו.";
    }
    if (!config || config.environment !== "test") {
      return "קובץ ההגדרות אינו מסומן כסביבת בדיקה. בדקו את supabase-test-config.json.";
    }
    if (!config.url || !config.projectRef || !publishableKeyIsSafe(config.publishableKey)) {
      return "ההגדרות אינן תקינות. נדרשים URL, מזהה פרויקט ומפתח publishable/anon בלבד.";
    }

    let url;
    try {
      url = new URL(config.url);
    } catch (error) {
      return "כתובת פרויקט הבדיקה אינה תקינה.";
    }

    if (
      url.protocol !== "https:" ||
      url.hostname !== config.projectRef + ".supabase.co" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      config.projectRef === productionProjectRef ||
      !/^[a-z0-9]{20}$/.test(config.projectRef)
    ) {
      return "הכתובת ומזהה הפרויקט אינם תואמים לפרויקט Supabase מבודד, או שמדובר בפרויקט הייצור. החיבור נחסם.";
    }

    return null;
  }

  async function initialize() {
    let response;
    try {
      response = await fetch("supabase-test-config.json", { cache: "no-store" });
    } catch (error) {
      setStatus(environmentStatus, "לא ניתן לקרוא הגדרות מקומיות. בדקו שהשרת המקומי פעיל.", "error");
      return;
    }
    if (response.status === 404) {
      setStatus(
        environmentStatus,
        "חסרות הגדרות מקומיות. העתיקו את קובץ הדוגמה ל-supabase-test-config.json ומלאו פרטי פרויקט בדיקה בלבד."
      );
      return;
    }
    if (!response.ok) {
      setStatus(environmentStatus, "קריאת הגדרות הבדיקה נכשלה (HTTP " + response.status + ").", "error");
      return;
    }
    try {
      config = await response.json();
    } catch (error) {
      setStatus(environmentStatus, "קובץ הגדרות הבדיקה אינו JSON תקין.", "error");
      return;
    }

    const problem = validateConfig();
    if (problem) {
      setStatus(environmentStatus, problem, "error");
      return;
    }

    client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
    setStatus(
      environmentStatus,
      "פרויקט בדיקה בלבד: " + config.projectRef + ". המפתח הציבורי לא נשמר, והתחברות תתאפשר רק לאחר אישור מפורש.",
      "success"
    );
    loginSection.hidden = false;
  }

  function fail(message) {
    throw new Error(message);
  }

  function assert(condition, message) {
    if (!condition) fail(message);
  }

  function assertNear(actual, expected, message) {
    assert(
      typeof actual === "number" && Math.abs(actual - expected) < 0.011,
      message + " (התקבל " + actual + ", ציפינו ל-" + expected + ")."
    );
  }

  function renderResult(name, passed, detail) {
    const item = document.createElement("li");
    item.className = passed ? "pass" : "fail";
    item.textContent = (passed ? "עבר: " : "נכשל: ") + name + (detail ? " — " + detail : "");
    results.appendChild(item);
  }

  async function runCheck(name, callback) {
    try {
      const detail = await callback();
      renderResult(name, true, detail || "");
    } catch (error) {
      renderResult(name, false, error.message || "שגיאה לא צפויה");
      throw error;
    }
  }

  async function rpc(name, args) {
    const response = await client.rpc(name, args);
    if (response.error) throw new Error(response.error.message);
    return response.data;
  }

  async function one(table, columns, filters) {
    const request = filters(client.from(table).select(columns));
    const response = await request.single();
    if (response.error) throw new Error(response.error.message);
    return response.data;
  }

  async function insertClients(tag) {
    const clients = [
      { id: "test-" + tag + "-cash", name: "לקוח בדיקה כספית " + tag },
      { id: "test-" + tag + "-credits", name: "לקוח בדיקה קרדיטים " + tag },
      { id: "test-" + tag + "-batch", name: "לקוח בדיקה מרובה " + tag }
    ];
    const response = await client.from("clients").insert(clients);
    if (response.error) throw new Error(response.error.message);
    return clients;
  }

  function isoDateOffset(days) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function idempotencyKey() {
    return window.crypto.randomUUID();
  }

  async function runSuite() {
    const tag = Date.now().toString(36) + "-" + window.crypto.randomUUID().slice(0, 8);
    const clients = await insertClients(tag);
    const clientByPurpose = {
      cash: clients[0].id,
      credits: clients[1].id,
      batch: clients[2].id
    };

    const productId = await rpc("save_product_catalog_item", {
      p_product_id: null,
      p_name: "TEST ONLY — מוצר בדיקה " + tag,
      p_dimensions: "TEST ONLY",
      p_base_price_before_vat: 100,
      p_credit_cost: 2.5,
      p_is_active: true
    });

    await runCheck("המשתמש מאושר, נתוני הדגמה נוצרו", async function () {
      const approval = await rpc("current_user_is_approved", {});
      assert(approval === true, "משתמש הבדיקה אינו מאושר.");
      const visibleClient = await one("clients", "id,name", function (request) {
        return request.eq("id", clientByPurpose.cash);
      });
      assert(visibleClient.id === clientByPurpose.cash, "הלקוח שיצרנו אינו קריא למשתמש המאושר.");
      return "נוצרו 3 לקוחות בדיקה ומוצר סינתטי בלבד";
    });

    await runCheck("RLS חוסם קריאת לקוחות כאורח", async function () {
      const anonymousClient = window.supabase.createClient(config.url, config.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
      const response = await anonymousClient.from("clients").select("id").limit(1);
      if (response.error) {
        assert(response.error.code === "42501", "קריאת אורח נכשלה מסיבה שאינה הרשאה.");
      } else {
        assert(Array.isArray(response.data) && response.data.length === 0, "אורח הצליח לקרוא לקוחות.");
      }
      return "לא נחשפו לקוחות";
    });

    const cashOrderInput = [{
      publication_date: isoDateOffset(1),
      sheet_number: "TEST-" + tag + "-CASH",
      product_id: productId,
      cash_amount_before_vat: 100,
      credits_used: null,
      payment_status: "pending",
      due_on: null,
      notes: "TEST ONLY " + tag + " cash"
    }];
    const cashIdempotencyKey = idempotencyKey();
    const cashOrderResult = await rpc("create_orders_batch", {
      p_client_id: clientByPurpose.cash,
      p_orders: cashOrderInput,
      p_idempotency_key: cashIdempotencyKey
    });
    const cashOrderId = cashOrderResult && cashOrderResult[0] && cashOrderResult[0].id;
    assert(cashOrderId, "יצירת הזמנה כספית לא החזירה מזהה הזמנה.");

    await runCheck("חישוב מע״מ 18% ושמירת הזמנה כספית", async function () {
      const summary = await one("business_order_financial_summary", "order_id,cash_due,cash_received,payment_status", function (request) {
        return request.eq("order_id", cashOrderId);
      });
      assertNear(Number(summary.cash_due), 118, "החיוב הכולל לא חושב כ-100 ש״ח ועוד 18% מע״מ");
      assertNear(Number(summary.cash_received), 0, "הזמנה ממתינה נספרה כתקבול");
      assert(summary.payment_status === "pending", "סטטוס ההזמנה אינו ממתין.");
      return "הסכום לפני מע״מ 100 ש״ח; חיוב 118 ש״ח; תקבול 0";
    });

    await runCheck("שמירה חוזרת עם אותו מפתח idempotency", async function () {
      const repeated = await rpc("create_orders_batch", {
        p_client_id: clientByPurpose.cash,
        p_orders: cashOrderInput,
        p_idempotency_key: cashIdempotencyKey
      });
      assert(repeated.length === 1 && repeated[0].id === cashOrderId, "הבקשה החוזרת לא החזירה את אותה הזמנה.");
      const visibleOrder = await one("orders", "id", function (request) {
        return request.eq("id", cashOrderId);
      });
      assert(visibleOrder.id === cashOrderId, "הזמנה חסרה לאחר ניסיון חוזר.");
      const orderCount = await client
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientByPurpose.cash)
        .eq("notes", "TEST ONLY " + tag + " cash");
      if (orderCount.error) throw new Error(orderCount.error.message);
      assert(orderCount.count === 1, "ניסיון חוזר יצר יותר מהזמנה אחת.");
      return "נשארה הזמנה אחת ולא נוצרה כפילות";
    });

    const currentCashOrder = await one("orders", "id,updated_at", function (request) {
      return request.eq("id", cashOrderId);
    });
    const staleCashOrderVersion = currentCashOrder.updated_at;
    await rpc("update_business_order", {
      p_order_id: cashOrderId,
      p_expected_updated_at: currentCashOrder.updated_at,
      p_client_id: clientByPurpose.cash,
      p_publication_date: isoDateOffset(1),
      p_section: "TEST ONLY",
      p_notes: "TEST ONLY " + tag + " edited",
      p_sheet_number: "TEST-" + tag + "-CASH",
      p_legacy_amount: null,
      p_cash_amount_before_vat: 110,
      p_credits_used: null,
      p_product_id: productId,
      p_due_on: null,
      p_update_due_on: false,
      p_idempotency_key: idempotencyKey()
    });

    await runCheck("עריכה מעדכנת סכום ומונעת דריסת גרסה", async function () {
      const summary = await one("business_order_financial_summary", "order_id,cash_due,cash_received", function (request) {
        return request.eq("order_id", cashOrderId);
      });
      assertNear(Number(summary.cash_due), 129.8, "עריכת הסכום לא עדכנה את החיוב כולל מע״מ");
      assertNear(Number(summary.cash_received), 0, "עריכת הזמנה ממתינה יצרה תקבול");
      return "הסכום עודכן ל-110 ש״ח לפני מע״מ; החיוב 129.80 ש״ח";
    });

    await runCheck("עדכון עם גרסת הזמנה ישנה נדחה", async function () {
      const staleUpdate = await client.rpc("update_business_order", {
        p_order_id: cashOrderId,
        p_expected_updated_at: staleCashOrderVersion,
        p_client_id: clientByPurpose.cash,
        p_publication_date: isoDateOffset(1),
        p_section: "TEST ONLY",
        p_notes: "TEST ONLY stale update " + tag,
        p_sheet_number: "TEST-" + tag + "-CASH",
        p_legacy_amount: null,
        p_cash_amount_before_vat: 120,
        p_credits_used: null,
        p_product_id: productId,
        p_due_on: null,
        p_update_due_on: false,
        p_idempotency_key: idempotencyKey()
      });
      assert(staleUpdate.error && staleUpdate.error.code === "40001", "עריכה ישנה לא נדחתה בקוד התנגשות צפוי.");
      const unchanged = await one("business_order_financial_summary", "cash_due", function (request) {
        return request.eq("order_id", cashOrderId);
      });
      assertNear(Number(unchanged.cash_due), 129.8, "העריכה הישנה שינתה את סכום ההזמנה");
      return "עריכה מקבילה נדחתה ולא דרסה את ההזמנה";
    });

    let cashOrder = await one("orders", "id,updated_at,payment_status", function (request) {
      return request.eq("id", cashOrderId);
    });
    const obligation = await one("financial_obligations", "id,amount_due,status", function (request) {
      return request.eq("order_id", cashOrderId);
    });
    await rpc("set_obligation_paid", {
      p_obligation_id: obligation.id,
      p_is_paid: true,
      p_reason: "TEST ONLY " + tag,
      p_expected_updated_at: cashOrder.updated_at,
      p_idempotency_key: idempotencyKey()
    });

    await runCheck("סימון כשולם רושם תקבול יחיד", async function () {
      const summary = await one("business_order_financial_summary", "cash_due,cash_received,payment_status,has_payment_history", function (request) {
        return request.eq("order_id", cashOrderId);
      });
      assertNear(Number(summary.cash_received), 129.8, "התקבול אינו תואם לחיוב");
      assert(summary.payment_status === "paid" && summary.has_payment_history, "סטטוס או היסטוריית התשלום לא עודכנו.");
      return "התקבול נרשם פעם אחת דרך RPC";
    });

    cashOrder = await one("orders", "id,updated_at", function (request) {
      return request.eq("id", cashOrderId);
    });
    await rpc("set_obligation_paid", {
      p_obligation_id: obligation.id,
      p_is_paid: false,
      p_reason: "TEST ONLY reversal " + tag,
      p_expected_updated_at: cashOrder.updated_at,
      p_idempotency_key: idempotencyKey()
    });

    await runCheck("פתיחה מחדש מתעדת היפוך ולא מוחקת היסטוריה", async function () {
      const summary = await one("business_order_financial_summary", "cash_received,payment_status,has_payment_history,receipt_basis", function (request) {
        return request.eq("order_id", cashOrderId);
      });
      assertNear(Number(summary.cash_received), 0, "תנועת ההיפוך לא קיזזה את התקבול");
      assert(summary.payment_status === "pending" && summary.has_payment_history, "החיוב לא נפתח מחדש או שההיסטוריה נעלמה.");
      return "התקבול נטו 0, וההיסטוריה נשמרה";
    });

    const creditOrderResult = await rpc("create_orders_batch", {
      p_client_id: clientByPurpose.credits,
      p_orders: [{
        publication_date: isoDateOffset(1),
        sheet_number: "TEST-" + tag + "-CREDIT",
        product_id: productId,
        cash_amount_before_vat: null,
        credits_used: 5.5,
        payment_status: "pending",
        due_on: null,
        notes: "TEST ONLY " + tag + " credit"
      }],
      p_idempotency_key: idempotencyKey()
    });
    assert(creditOrderResult && creditOrderResult[0] && creditOrderResult[0].id, "יצירת הזמנת קרדיטים נכשלה.");

    await runCheck("ניצול קרדיטים תומך ביתרה שלילית", async function () {
      const balance = await one("business_client_credit_balances", "client_id,credit_balance", function (request) {
        return request.eq("client_id", clientByPurpose.credits);
      });
      assertNear(Number(balance.credit_balance), -5.5, "היתרה השלילית לא חושבה נכון");
      return "יתרה של ‎-5.5 קרדיטים";
    });

    const packageId = await rpc("save_package_catalog_item", {
      p_package_id: null,
      p_package_code: "test-" + tag,
      p_name: "TEST ONLY — חבילת בדיקה " + tag,
      p_credits: 8.5,
      p_term_months: 1,
      p_total_price_before_vat: 20,
      p_installment_count: 2,
      p_installment_before_vat: 10,
      p_benefits: [],
      p_is_active: true
    });
    const packageStart = isoDateOffset(0);
    const packageEnd = isoDateOffset(45);
    await rpc("purchase_customer_package", {
      p_client_id: clientByPurpose.credits,
      p_package_id: packageId,
      p_custom_name: null,
      p_credits: null,
      p_term_months: null,
      p_price_before_vat: null,
      p_starts_on: packageStart,
      p_ends_on: packageEnd,
      p_installments: [
        { due_on: isoDateOffset(-2), amount_before_vat: 10 },
        { due_on: isoDateOffset(2), amount_before_vat: 10 }
      ],
      p_benefits: null,
      p_notes: "TEST ONLY " + tag,
      p_idempotency_key: idempotencyKey()
    });

    await runCheck("קרדיטים מוקצים מיד ומקזזים יתרה שלילית", async function () {
      const balance = await one("business_client_credit_balances", "client_id,credit_balance", function (request) {
        return request.eq("client_id", clientByPurpose.credits);
      });
      assertNear(Number(balance.credit_balance), 3, "רכישת החבילה לא קיזזה את המינוס מיד");
      return "יתרה לאחר ניצול 5.5 והקצאת 8.5: 3 קרדיטים";
    });

    await runCheck("תשלומי חבילה בפיגור ובעתיד מחושבים בנפרד", async function () {
      const response = await client
        .from("business_financial_summary")
        .select("cash_due,cash_received,cash_outstanding,overdue_amount,future_amount,due_on,payment_status")
        .eq("client_id", clientByPurpose.credits)
        .eq("item_type", "package_installment");
      if (response.error) throw new Error(response.error.message);
      assert(response.data.length === 2, "לא נמצאו שני תשלומים מתוזמנים.");
      const overdue = response.data.find(function (item) { return item.due_on < isoDateOffset(0); });
      const future = response.data.find(function (item) { return item.due_on > isoDateOffset(0); });
      assert(overdue && future, "תאריכי החיוב אינם מייצגים תשלום אחד בפיגור ואחד בעתיד.");
      assertNear(Number(overdue.overdue_amount), 11.8, "חוב בפיגור אינו כולל מע״מ או חושב מוקדם מדי");
      assertNear(Number(future.future_amount), 11.8, "התשלום העתידי אינו מוצג בנפרד");
      assertNear(Number(future.cash_received), 0, "תשלום עתידי נספר כתקבול");
      assert(overdue.payment_status === "pending" && future.payment_status === "pending", "תשלום מתוזמן סומן כשולם ללא אישור.");
      return "11.80 ש״ח בפיגור ו-11.80 ש״ח בעתיד; תקבולים 0";
    });

    const batchInput = [
      {
        publication_date: isoDateOffset(1),
        sheet_number: "TEST-" + tag + "-BATCH-1",
        product_id: productId,
        cash_amount_before_vat: 50,
        credits_used: null,
        payment_status: "pending",
        due_on: null,
        notes: "TEST ONLY " + tag + " batch cash"
      },
      {
        publication_date: isoDateOffset(1),
        sheet_number: "TEST-" + tag + "-BATCH-2",
        product_id: productId,
        cash_amount_before_vat: null,
        credits_used: 2.5,
        payment_status: "pending",
        due_on: null,
        notes: "TEST ONLY " + tag + " batch credits"
      }
    ];
    const batchKey = idempotencyKey();
    const batchResult = await rpc("create_orders_batch", {
      p_client_id: clientByPurpose.batch,
      p_orders: batchInput,
      p_idempotency_key: batchKey
    });
    assert(Array.isArray(batchResult) && batchResult.length === 2, "שמירת batch לא החזירה שתי הזמנות.");

    await runCheck("הזמנות מרובות נשמרות כפעולה אחת ו-idempotent", async function () {
      const repeated = await rpc("create_orders_batch", {
        p_client_id: clientByPurpose.batch,
        p_orders: batchInput,
        p_idempotency_key: batchKey
      });
      assert(repeated.length === 2, "ניסיון חוזר לא החזיר שתי תוצאות.");
      assert(
        repeated[0].id === batchResult[0].id && repeated[1].id === batchResult[1].id,
        "ניסיון חוזר יצר או החזיר הזמנות שונות."
      );
      const response = await client.from("orders").select("id").in("id", batchResult.map(function (item) { return item.id; }));
      if (response.error) throw new Error(response.error.message);
      assert(response.data.length === 2, "מספר ההזמנות שנשמרו אינו שתיים.");
      const balance = await one("business_client_credit_balances", "credit_balance", function (request) {
        return request.eq("client_id", clientByPurpose.batch);
      });
      assertNear(Number(balance.credit_balance), -2.5, "שורת הקרדיטים ב-batch לא נרשמה");
      return "נשמרו שתי שורות; ניסיון חוזר לא יצר כפילויות";
    });

    await runCheck("כשל בשורה שנייה אינו משאיר שמירה חלקית", async function () {
      const marker = "TEST ONLY " + tag + " atomic-failure";
      const invalid = await client.rpc("create_orders_batch", {
        p_client_id: clientByPurpose.batch,
        p_orders: [
          {
            publication_date: isoDateOffset(1),
            sheet_number: "TEST-" + tag + "-FAIL-1",
            product_id: productId,
            cash_amount_before_vat: 40,
            credits_used: null,
            payment_status: "pending",
            due_on: null,
            notes: marker
          },
          {
            publication_date: isoDateOffset(1),
            sheet_number: "TEST-" + tag + "-FAIL-2",
            product_id: productId,
            cash_amount_before_vat: null,
            credits_used: null,
            payment_status: "pending",
            due_on: null,
            notes: marker
          }
        ],
        p_idempotency_key: idempotencyKey()
      });
      assert(invalid.error, "batch לא תקין נשמר ללא שגיאה.");
      assert(
        invalid.error.message.includes("בכל שורה יש למלא בדיוק ערך חיובי אחד"),
        "ה-batch נכשל מסיבה לא צפויה, לא עקב שורת חיוב לא תקינה."
      );
      const response = await client
        .from("orders")
        .select("id")
        .eq("client_id", clientByPurpose.batch)
        .eq("notes", marker);
      if (response.error) throw new Error(response.error.message);
      assert(response.data.length === 0, "נשארה הזמנה חלקית לאחר כשל batch.");
      return "התקבלה שגיאת ולידציה ולא נשמרה אף שורה";
    });
  }

  loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!document.getElementById("confirm-test-project").checked) return;
    loginButton.disabled = true;
    setStatus(testStatus, "מתחבר לחשבון הבדיקה…", "");
    try {
      const response = await client.auth.signInWithPassword({
        email: document.getElementById("email").value.trim(),
        password: document.getElementById("password").value
      });
      document.getElementById("password").value = "";
      if (response.error) throw new Error(response.error.message);
      const approved = await client.rpc("current_user_is_approved");
      if (approved.error || approved.data !== true) {
        await client.auth.signOut();
        throw new Error("משתמש הבדיקה אינו מאושר ב-private.approved_users.");
      }
      loginSection.hidden = true;
      testSection.hidden = false;
      setStatus(testStatus, "התחברת לפרויקט הבדיקה. ההרצה תיצור נתוני TEST ONLY קבועים.", "success");
    } catch (error) {
      setStatus(testStatus, "ההתחברות נכשלה: " + (error.message || "שגיאה לא צפויה"), "error");
    } finally {
      loginButton.disabled = false;
    }
  });

  testButton.addEventListener("click", async function () {
    if (testRunActive) return;
    testRunActive = true;
    testButton.disabled = true;
    results.replaceChildren();
    setStatus(testStatus, "מריץ בדיקות. אין לסגור את החלון עד לסיום.", "");
    try {
      await runSuite();
      setStatus(testStatus, "כל הבדיקות הסתיימו בהצלחה. נתוני TEST ONLY נשארו בפרויקט הבדיקה.", "success");
    } catch (error) {
      setStatus(
        testStatus,
        "הבדיקות נעצרו: " + (error.message || "שגיאה לא צפויה") + ". בדקו את התוצאה האחרונה ואת לוגי Supabase בפרויקט הבדיקה.",
        "error"
      );
    } finally {
      testRunActive = false;
      testButton.disabled = false;
    }
  });

  signOutButton.addEventListener("click", async function () {
    signOutButton.disabled = true;
    try {
      const response = await client.auth.signOut();
      if (response.error) throw new Error(response.error.message);
      testSection.hidden = true;
      loginSection.hidden = false;
      setStatus(testStatus, "התנתקת. אסימון ההתחברות לא נשמר בדפדפן.", "success");
    } catch (error) {
      setStatus(testStatus, "ההתנתקות נכשלה: " + (error.message || "שגיאה לא צפויה"), "error");
    } finally {
      signOutButton.disabled = false;
    }
  });

  initialize();
}());
