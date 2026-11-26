/* =====================================================================
   HAPIRSUMON — Design Studio
   Router, screens and interactions. Plain JavaScript, no dependencies.
   ===================================================================== */
(function () {
  "use strict";
  const D = window.STUDIO_DATA;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const params = new URLSearchParams(location.search);
  const bare = params.get("bare") === "1";
  if (bare) document.documentElement.classList.add("is-bare");

  /* ---------- Icons: drawn on a 20px grid, 1.4 stroke, square ends ---------- */
  const PATHS = {
    search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.5 12.5L17 17"/>',
    arrow: '<path d="M16 10H4M9 5l-5 5 5 5"/>',
    chevron: '<path d="M5 7.5l5 5 5-5"/>',
    close: '<path d="M5 5l10 10M15 5L5 15"/>',
    check: '<path d="M4 10.5l4 4 8-9"/>',
    plus: '<path d="M10 4v12M4 10h12"/>',
    menu: '<path d="M3 6h14M3 10h14M3 14h14"/>',
    out: '<path d="M8 4H4v12h4M12 6l-4 4 4 4M8 10h9"/>',
    eye: '<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.4"/>',
    eyeOff: '<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><path d="M3.5 16.5l13-13"/>',
    info: '<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.2v.1"/>',
    alert: '<path d="M10 2.8l8 14.2H2z"/><path d="M10 8v4.2M10 14.4v.1"/>',
    file: '<path d="M5 2.5h6.5l3.5 3.5v11.5H5z"/><path d="M11.5 2.5V6H15"/>',
    calendar: '<path d="M3 4.5h14v12.5H3zM3 8.5h14M7 2.5v4M13 2.5v4"/>',
    sort: '<path d="M10 4v12M6 12l4 4 4-4"/>',
    more: '<path d="M4.5 10h.1M10 10h.1M15.5 10h.1"/>',
    image: '<path d="M2.5 4h15v12h-15z"/><path d="M2.5 13l4.5-4 3.5 3 2.5-2 4.5 4"/><circle cx="13" cy="7.5" r="1.2"/>',
    copy: '<path d="M7 7h10v10H7z"/><path d="M13 7V3H3v10h4"/>',
  };
  const icon = (n, cls = "") => `<svg class="icon ${cls}" viewBox="0 0 20 20" aria-hidden="true">${PATHS[n]}</svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- Formatting ---------- */
  const fmtInt = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });
  const he = (o) => new Intl.DateTimeFormat("he-IL", o);
  const dayName = (d) => he({ weekday: "long" }).format(d);
  const shortDate = (d) => `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  const dm = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
  const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const longDate = (d) => he({ day: "numeric", month: "long", year: "numeric" }).format(d);
  // Hebrew calendar date in Hebrew letters (ט״ז בכסלו תשפ״ז), from Intl's numeric parts.
  const gematria = (n) => {
    const L = [[400, "ת"], [300, "ש"], [200, "ר"], [100, "ק"], [90, "צ"], [80, "פ"], [70, "ע"], [60, "ס"], [50, "נ"], [40, "מ"], [30, "ל"], [20, "כ"], [10, "י"], [9, "ט"], [8, "ח"], [7, "ז"], [6, "ו"], [5, "ה"], [4, "ד"], [3, "ג"], [2, "ב"], [1, "א"]];
    let out = ""; n %= 1000;
    while (n >= 400) { out += "ת"; n -= 400; }
    if (n === 15 || n === 16) return out + (n === 15 ? "טו" : "טז");
    for (const [v, ch] of L) { if (v < 400 && n >= v) { out += ch; n -= v; } }
    return out;
  };
  const mark = (s) => s.length === 1 ? s + "׳" : s.slice(0, -1) + "״" + s.slice(-1);
  const hebrewDate = (d) => {
    try {
      const parts = new Intl.DateTimeFormat("he-IL-u-ca-hebrew", { day: "numeric", month: "long", year: "numeric" }).formatToParts(d);
      const get = (t) => (parts.find((p) => p.type === t) || {}).value;
      const day = Number(get("day")), year = Number(get("year")), month = get("month");
      if (!day || !year || !month) return "";
      return `${mark(gematria(day))} ב${month.replace(/^ב/, "")} ${mark(gematria(year))}`;
    } catch { return ""; }
  };
  const moneyParts = (v) => { const whole = Math.floor(v); const dec = Math.round((v - whole) * 100); return { int: fmtInt.format(whole), dec: String(dec).padStart(2, "0") }; };
  const money = (v, cls = "") => { const p = moneyParts(v); return `<span class="money ${cls}"><span class="cur">₪</span><span class="int">${p.int}</span><span class="dec">.${p.dec}</span></span>`; };
  const greeting = (d = new Date()) => { const h = d.getHours(); return h >= 5 && h < 12 ? "בוקר טוב" : h < 17 && h >= 12 ? "צהריים טובים" : h >= 17 && h < 22 ? "ערב טוב" : "לילה טוב"; };

  /* ---------- Count-up: the real value holds the space; a counting copy sits on top ---------- */
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  function countFigure(el) {
    if (reduced.matches || el.dataset.counting === "1") return;
    const goal = Number(el.dataset.value);
    const live = $(".count-live", el);
    if (!live) return;
    el.dataset.counting = "1"; el.classList.add("is-counting");
    const start = performance.now();
    const dur = 1350;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const v = goal * easeOut(t);
      const p = moneyParts(v);
      live.innerHTML = el.dataset.kind === "int" ? fmtInt.format(Math.round(v)) : `<span class="cur">₪</span><span class="int">${p.int}</span><span class="dec">.${p.dec}</span>`;
      if (t < 1) requestAnimationFrame(frame);
      else { el.classList.remove("is-counting"); el.dataset.counting = ""; el.dataset.ended = String(performance.now()); }
    };
    requestAnimationFrame(frame);
  }
  const countable = (v, kind = "money") => kind === "int"
    ? `<span class="count num" data-value="${v}" data-kind="int"><span class="count-final">${fmtInt.format(v)}</span><span class="count-live" aria-hidden="true"></span></span>`
    : `<span class="count" data-value="${v}"><span class="count-final">${money(v)}</span><span class="count-live money" aria-hidden="true"></span></span>`;
  function playCounts(root) { $$(".count", root).forEach(countFigure); }
  document.addEventListener("mouseover", (e) => {
    const host = e.target.closest("[data-replay]");
    if (!host || (e.relatedTarget && host.contains(e.relatedTarget))) return;
    $$(".count", host).forEach((el) => { if (performance.now() - Number(el.dataset.ended || 0) > 1500) countFigure(el); });
  });

  /* ---------- Toasts, tooltip, dialog, menus ---------- */
  function toast(text, opts = {}) {
    const host = $("#toasts");
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `${icon(opts.icon || "check")}<span>${esc(text)}</span>${opts.undo ? '<button type="button">ביטול</button>' : ""}`;
    host.appendChild(t);
    const leave = () => { t.classList.add("is-leaving"); setTimeout(() => t.remove(), 260); };
    const timer = setTimeout(leave, opts.ms || 3600);
    const b = $("button", t); if (b) b.addEventListener("click", () => { clearTimeout(timer); leave(); toast("הפעולה בוטלה", { icon: "info" }); });
  }
  const tip = $("#tooltip");
  function showTip(el) {
    tip.innerHTML = el.dataset.tip; tip.hidden = false;
    const r = el.getBoundingClientRect(); const w = tip.offsetWidth; const h = tip.offsetHeight;
    let x = r.left + r.width / 2 - w / 2; x = Math.max(8, Math.min(x, innerWidth - w - 8));
    let y = r.top - h - 10; if (y < 8) y = r.bottom + 10;
    tip.style.left = x + "px"; tip.style.top = y + "px";
    requestAnimationFrame(() => tip.classList.add("is-on"));
  }
  function hideTip() { tip.classList.remove("is-on"); tip.hidden = true; }
  document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el); });
  document.addEventListener("mouseout", (e) => { const el = e.target.closest("[data-tip]"); if (el && !el.contains(e.relatedTarget)) hideTip(); });
  document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el); });
  document.addEventListener("focusout", (e) => { if (e.target.closest("[data-tip]")) hideTip(); });

  let lastFocus = null;
  function openDialog({ title, body, confirm = "אישור", tone = "primary", onConfirm }) {
    lastFocus = document.activeElement;
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <div class="dialog-head"><h2 id="dlg-title">${title}</h2><button type="button" class="dialog-close" data-close aria-label="סגירה">${icon("close")}</button></div>
      <div class="dialog-body">${body}</div>
      <div class="dialog-foot"><button type="button" class="btn ${tone === "danger" ? "btn-danger" : "btn-primary"}" data-confirm><span class="btn-label">${confirm}</span></button><button type="button" class="btn" data-close>חזרה</button></div></div>`;
    document.body.appendChild(scrim);
    requestAnimationFrame(() => scrim.classList.add("is-open"));
    const close = () => { scrim.classList.remove("is-open"); setTimeout(() => scrim.remove(), 240); document.removeEventListener("keydown", onKey); if (lastFocus) lastFocus.focus(); };
    const onKey = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") { const f = $$("button, input, select, textarea, a[href]", scrim); const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    };
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", (e) => { if (e.target === scrim || e.target.closest("[data-close]")) close(); });
    $("[data-confirm]", scrim).addEventListener("click", () => { close(); if (onConfirm) onConfirm(); });
    setTimeout(() => $("[data-confirm]", scrim).focus(), 50);
  }

  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-menu]");
    $$(".menu.is-open").forEach((m) => { if (!opener || m !== opener.nextElementSibling) { m.classList.remove("is-open"); const o = m.previousElementSibling; if (o) o.setAttribute("aria-expanded", "false"); } });
    if (opener) { const m = opener.nextElementSibling; const open = m.classList.toggle("is-open"); opener.setAttribute("aria-expanded", String(open)); if (open) { const f = $("button", m); if (f) f.focus(); } }
    const item = e.target.closest(".menu button");
    if (item) { item.closest(".menu").classList.remove("is-open"); toast(item.dataset.say || item.textContent.trim(), { icon: item.classList.contains("is-danger") ? "alert" : "check" }); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $$(".menu.is-open").forEach((m) => m.classList.remove("is-open")); });

  /* Save button: idle → busy → done, and back */
  function saveButton(btn, ms = 900) {
    if (btn.classList.contains("is-busy")) return;
    btn.classList.add("is-busy");
    setTimeout(() => { btn.classList.remove("is-busy"); btn.classList.add("is-done"); setTimeout(() => btn.classList.remove("is-done"), 1600); }, reduced.matches ? 300 : ms);
  }

  /* ---------- The product's navigation (shared by home and sheets) ---------- */
  const NAV = [["home", "בית"], ["orders", "הזמנות"], ["clients", "לקוחות"], ["sheets", "גיליונות"], ["packages", "חבילות"], ["payments", "גבייה"], ["reports", "דוחות"], ["settings", "הגדרות"]];
  function shell(active, content) {
    return `<div class="app">
      <aside class="sidenav" aria-label="ניווט ראשי">
        <div class="sidenav-head">
          <a class="brand" href="#/home"><img src="../assets/logo-emblem.png" alt="" width="44" height="44"><span><b>הפרסומון</b><small>ניהול חכם. פרסום מדויק.</small></span></a>
          <button type="button" class="sidenav-toggle" aria-expanded="false" aria-controls="sidenav-body">${icon("menu")}<span>תפריט</span></button>
        </div>
        <div class="sidenav-body" id="sidenav-body">
          <nav><ol class="nav-list">${NAV.map(([k, label], i) => `<li><a href="#/${k}" class="nav-item${k === active ? " is-active" : ""}"${k === active ? ' aria-current="page"' : ""} data-nav="${k}"><span>${label}</span><small class="num">${String(i + 1).padStart(2, "0")}</small></a></li>`).join("")}</ol></nav>
          <button type="button" class="nav-new" data-say="טופס הזמנה חדשה ייפתח כאן">${icon("plus", "icon-s")}הזמנה חדשה</button>
          <div class="sidenav-foot">
            <p class="sync"><i></i>מסונכרן · עודכן לפני דקה</p>
            <div class="user"><span class="monogram">ה</span><span><b>צוות הפרסומון</b><small>מחובר כעורך</small></span></div>
            <button type="button" class="nav-out" data-say="יציאה מהמערכת">${icon("out", "icon-s")}יציאה מהמערכת</button>
          </div>
        </div>
      </aside>
      <main class="main" id="main">${content}</main>
    </div>`;
  }

  /* ---------- Screen: Login ---------- */
  function viewLogin() {
    return `<div class="login">
      <section class="login-side">
        <a class="login-brand" href="#/login"><img src="../assets/logo-emblem.png" alt="" width="58" height="58"><span><b>הפרסומון</b><small>ניהול חכם. פרסום מדויק.</small></span></a>
        <form class="login-form" id="login-form" novalidate>
          <h1>כניסה למערכת</h1>
          <p class="login-lede">כניסה לחשבון מאושר במערכת הפרסומון.</p>
          <div class="notice" data-tone="danger" id="login-error" hidden>${icon("alert")}<div><strong>הכניסה לא הצליחה</strong><p>כתובת הדוא״ל או הסיסמה שגויות. אפשר לנסות שוב.</p></div><span></span></div>
          <label class="field"><span class="field-label">דוא״ל</span><input class="input input-ltr" type="email" name="email" autocomplete="username" placeholder="name@example.com" value="editor@hapirsumon.example"></label>
          <label class="field"><span class="field-label">סיסמה</span><span class="input-with-icon"><input class="input input-ltr" type="password" name="password" autocomplete="current-password" id="login-pass"><button type="button" class="input-end btn-icon" id="pass-eye" aria-label="הצגת הסיסמה" aria-pressed="false">${icon("eye")}</button></span></label>
          <button class="btn btn-primary btn-block login-submit" type="submit"><span class="btn-label">כניסה למערכת</span><span class="btn-done">${icon("check", "icon-s")}מחובר</span></button>
        </form>
        <p class="login-hint studio-annotation">בסטודיו: סיסמה ריקה מציגה את מצב השגיאה, וכל סיסמה אחרת מדגימה כניסה מוצלחת.</p>
        <p class="login-foot">© הפרסומון · מערכת ניהול הזמנות</p>
      </section>
      <figure class="login-photo"><img src="../assets/photos/login.jpg" alt="כורסה, שמיכה ועיתון הפרסומון פתוח, באור חמים" width="1536" height="1024"></figure>
    </div>`;
  }
  function bindLogin(root) {
    const form = $("#login-form", root); const pass = $("#login-pass", root); const eye = $("#pass-eye", root);
    eye.addEventListener("click", () => { const show = pass.type === "password"; pass.type = show ? "text" : "password"; eye.setAttribute("aria-pressed", String(show)); eye.setAttribute("aria-label", show ? "הסתרת הסיסמה" : "הצגת הסיסמה"); eye.innerHTML = icon(show ? "eyeOff" : "eye"); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = $(".login-submit", form); const err = $("#login-error", form);
      err.hidden = true; pass.removeAttribute("aria-invalid");
      btn.classList.add("is-busy");
      setTimeout(() => {
        btn.classList.remove("is-busy");
        if (!pass.value) { err.hidden = false; pass.setAttribute("aria-invalid", "true"); pass.focus(); return; }
        btn.classList.add("is-done");
        setTimeout(() => { location.hash = "#/home"; }, 700);
      }, reduced.matches ? 200 : 800);
    });
  }

  /* ---------- Screen: Home ---------- */
  function sheetReadiness(s) {
    const total = s.ads.length; const ready = s.ads.filter(D.isReady).length;
    return { total, ready, pct: total ? Math.round((ready / total) * 100) : 0 };
  }
  function countdownParts(to) {
    let ms = Math.max(0, to - new Date());
    const d = Math.floor(ms / 86400000); ms -= d * 86400000;
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000);
    return { d, h, m, over: to <= new Date() };
  }
  function countdownHTML(s) {
    const c = countdownParts(s.closes);
    if (c.over) return `<p class="cd-closed">ההזמנות לגיליון נסגרו</p>`;
    const cell = (n, u) => `<span class="cd-cell"><b class="num">${String(n).padStart(2, "0")}</b><small>${u}</small></span>`;
    return `<div class="cd" role="timer" aria-label="נותרו ${c.d ? c.d + " ימים, " : ""}${c.h} שעות ו־${c.m} דקות">${c.d ? cell(c.d, c.d === 1 ? "יום" : "ימים") : ""}${cell(c.h, "שעות")}${cell(c.m, "דקות")}</div>`;
  }
  function segmentsHTML(s) {
    return `<div class="segments" role="img" aria-label="${sheetReadiness(s).ready} מתוך ${s.ads.length} מודעות מוכנות">${s.ads.map((a) =>
      `<span data-state="${a.state}" tabindex="0" data-tip="<b>${esc(a.client)}</b><br><span>${esc(a.size)} · ${D.stateNames[a.state]}</span>"></span>`).join("")}</div>`;
  }
  function viewHome() {
    const now = new Date(); const s = D.next; const r = sheetReadiness(s);
    const notReady = r.total - r.ready;
    const closeWhen = (() => { const c = countdownParts(s.closes); const sameDay = s.closes.toDateString() === now.toDateString(); return sameDay ? `הערב ב־${hm(s.closes)}` : `ב${dayName(s.closes)} ב־${hm(s.closes)}`; })();
    return shell("home", `<div class="page home">
      <header class="home-hero">
        <div class="hero-text">
          <p class="dateline"><span>${dayName(now)}, ${longDate(now)}</span><span class="dot"></span><span>${hebrewDate(now)}</span></p>
          <h1 class="t-display" id="greeting">${greeting(now)}</h1>
          <p class="hero-lede">גיליון ${s.number} נסגר להזמנות ${closeWhen}.<br>${r.ready} מתוך ${r.total} המודעות בו כבר מוכנות${notReady ? `, ועוד ${notReady === 1 ? "אחת ממתינה" : notReady + " ממתינות"}` : ""}.</p>
        </div>
        <figure class="hero-photo"><img src="../assets/photos/home.webp" alt="ערימת עיתונים ואגרטל פרחים באור בוקר" width="1000" height="236"><figcaption>בוקר בחדר העריכה</figcaption></figure>
      </header>

      <section class="ledger" aria-labelledby="ledger-title" data-replay>
        <h2 class="folio" id="ledger-title"><b>01</b><span>כספי החודש</span></h2>
        <dl class="ledger-row">${D.money.map((m) => `<div class="ledger-item${m.tone ? " is-" + m.tone : ""}"><dt>${m.label}</dt><dd class="ledger-figure">${countable(m.value)}</dd><dd class="ledger-note">${m.note}</dd></div>`).join("")}</dl>
      </section>

      <div class="home-desk">
        <section class="feature" aria-labelledby="feature-title">
          <h2 class="folio" id="feature-title"><b>02</b><span>הגיליון הקרוב לפרסום</span></h2>
          <div class="feature-body">
            <div class="feature-id">
              <p class="feature-kicker">גיליון</p>
              <p class="feature-number num">${s.number}</p>
              <p class="feature-date">${dayName(s.date)} · ${shortDate(s.date)}</p>
            </div>
              <div class="feature-ready">
                <p class="feature-label"><b class="num">${r.ready}</b> מתוך <b class="num">${r.total}</b> מודעות מוכנות</p>
                ${segmentsHTML(s)}
                <p class="legend"><span data-state="placed">שובצה</span><span data-state="ready">אושרה</span><span data-state="review">ממתינה לאישור</span><span data-state="missing">קובץ חסר</span></p>
              </div>
              <div class="feature-close">
                <p class="feature-label">ההזמנות נסגרות בעוד</p>
                <div id="countdown">${countdownHTML(s)}</div>
                <p class="feature-when">${dayName(s.closes)} ${dm(s.closes)}, ${hm(s.closes)}</p>
              </div>
              <div class="feature-go"><a class="btn btn-primary btn-arrow feature-enter" href="#/sheets"><span class="btn-label">כניסה לגיליון</span>${icon("arrow", "icon-s")}</a></div>
          </div>
        </section>

        <section class="tasks" aria-labelledby="tasks-title">
          <h2 class="folio" id="tasks-title"><b>03</b><span>משימות לטיפול</span></h2>
          <ul class="task-list">${D.tasks.map((t) => `<li><a class="task${t.count ? "" : " is-clear"}" href="#/sheets" data-say="נפתחת רשימת ההזמנות המסוננת: ${t.title}">
            <span class="task-count num">${t.count}</span><span class="task-text"><b>${t.title}</b><small>${t.count ? t.hint : "אין כרגע"}</small></span>${icon("arrow", "icon-s task-go")}</a></li>`).join("")}</ul>
          <a class="link-quiet" href="#/sheets">כל ההזמנות ${icon("arrow", "icon-s")}</a>
        </section>
      </div>
    </div>`);
  }
  let countdownTimer = null;
  function bindHome(root) {
    setTimeout(() => playCounts(root), 120);
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => { const el = $("#countdown", root); if (el && el.isConnected) el.innerHTML = countdownHTML(D.next); else clearInterval(countdownTimer); }, 30000);
    $$(".task", root).forEach((a) => a.addEventListener("click", () => toast(a.dataset.say, { icon: "info" })));
  }

  /* ---------- Screen: Sheets ---------- */
  function sheetStatus(s) {
    if (s.status === "published") return { tone: "published", text: "פורסם" };
    const c = countdownParts(s.closes);
    if (c.over) return { tone: "closed", text: "נסגר להזמנות" };
    const hours = (s.closes - new Date()) / 3600000;
    if (hours < 48) return { tone: "closing", text: hours < 24 ? `נסגר בעוד ${Math.max(1, Math.round(hours))} שעות` : "נסגר מחר" };
    return { tone: "open", text: "פתוח להזמנות" };
  }
  function adRows(s) {
    if (!s.ads.length) return `<div class="state state-inline"><div class="state-mark">${icon("file")}</div><h3>עוד אין הזמנות לגיליון ${s.number}</h3><p>הזמנה שתשויך לגיליון תופיע כאן, עם מצב הקובץ שלה.</p><button class="btn btn-small" type="button" data-say="טופס הזמנה חדשה לגיליון ${s.number}">${icon("plus", "icon-s")}הזמנה לגיליון</button></div>`;
    const tone = { missing: "missing", review: "review", ready: "ready", placed: "placed" };
    return `<table class="table ads-table"><thead><tr><th>הזמנה</th><th>לקוח</th><th>גודל</th><th>קובץ</th><th class="col-num">עמוד</th><th class="col-num">סכום</th></tr></thead><tbody>
      ${s.ads.map((a) => `<tr><td class="num muted">${a.n}</td><td>${esc(a.client)}</td><td class="muted">${a.size}</td><td><span class="status" data-tone="${tone[a.state]}">${D.stateNames[a.state]}</span></td><td class="col-num">${a.page || "—"}</td><td class="col-num">${money(a.amount, "money-s")}</td></tr>`).join("")}
    </tbody></table>
    <div class="ads-foot"><span class="t-small">סה״כ ${s.ads.length} מודעות · ${money(s.ads.reduce((x, a) => x + a.amount, 0), "money-s")}</span><span class="ads-actions"><button class="btn btn-small" type="button" data-say="דף גיליון ${s.number} נפתח">פתיחת דף הגיליון</button>
      <span class="menu-anchor"><button class="btn btn-small btn-quiet" type="button" data-menu aria-haspopup="true" aria-expanded="false" aria-label="פעולות נוספות">${icon("more")}</button>
      <span class="menu" role="menu"><button role="menuitem" type="button" data-say="מועד הסגירה נפתח לעריכה">שינוי מועד הסגירה</button><button role="menuitem" type="button" data-say="רשימת המודעות הודפסה">הדפסת רשימת המודעות</button><hr><button role="menuitem" type="button" class="is-danger" data-say="הגיליון נסגר ידנית">סגירה ידנית להזמנות</button></span></span></span></div>`;
  }
  function sheetRow(s, open) {
    const st = sheetStatus(s); const r = sheetReadiness(s);
    const closeText = s.status === "published" ? `<span class="muted">—</span>` : `${dayName(s.closes).replace("יום ", "")} ${dm(s.closes)}, ${hm(s.closes)}${s.manual ? ` <span class="mark-manual" data-tip="מועד הסגירה שונה ידנית.<br><span>במקור: חמישי ${dm(new Date(s.closes.getTime() + 86400000))}, 23:59</span>" tabindex="0">שונה ידנית</span>` : ""}`;
    return `<tr class="is-row${open ? " is-open" : ""}" data-sheet="${s.number}" tabindex="0" aria-expanded="${open}">
        <td><span class="sheet-no num">${s.number}</span></td>
        <td>${dayName(s.date)} <span class="muted num">${shortDate(s.date)}</span></td>
        <td>${closeText}</td>
        <td class="col-num num">${r.total || "—"}</td>
        <td class="col-ready">${r.total ? `<span class="ready-mini"><span class="progress"><i style="--p:${r.pct}"></i></span><span><span class="num">${r.ready}</span> מתוך <span class="num">${r.total}</span></span></span>` : `<span class="muted">—</span>`}</td>
        <td><span class="status" data-tone="${st.tone}">${st.text}</span></td>
        <td class="col-toggle">${icon("chevron", "chevron")}</td>
      </tr>
      <tr class="row-detail"><td colspan="7"><div class="disclose${open ? " is-open" : ""}"><div><div class="disclose-inner detail-inner">${adRows(s)}</div></div></div></td></tr>`;
  }
  function viewSheets() {
    const counts = { open: D.sheets.filter((s) => s.status !== "published").length, published: D.sheets.filter((s) => s.status === "published").length, all: D.sheets.length };
    return shell("sheets", `<div class="page sheets">
      <header class="page-head">
        <div class="page-title">
          <h1 class="t-h1">גיליונות</h1>
          <p class="t-small">שבועון · יוצא לאור בימי ראשון · ההזמנות נסגרות ביום חמישי ב־23:59</p>
        </div>
        <figure class="photo-slot" data-slot="sheets"><span>${icon("image")}צילום מתוכנן: ערימת גיליונות באור בוקר · 4:1</span></figure>
      </header>
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="סינון גיליונות">
          <button type="button" data-filter="open" aria-pressed="true">פתוחים <span class="count">${counts.open}</span></button>
          <button type="button" data-filter="published" aria-pressed="false">פורסמו <span class="count">${counts.published}</span></button>
          <button type="button" data-filter="all" aria-pressed="false">הכול <span class="count">${counts.all}</span></button>
        </div>
        <label class="search">${icon("search")}<input type="search" id="sheet-search" placeholder="חיפוש לפי מספר גיליון או לקוח" aria-label="חיפוש גיליונות"><kbd>/</kbd></label>
      </div>
      <div class="sheets-table" id="sheets-table"></div>
    </div>`);
  }
  function bindSheets(root) {
    let filter = "open"; let query = ""; const open = new Set([D.next.number]);
    const host = $("#sheets-table", root);
    const draw = () => {
      const q = query.trim();
      const list = D.sheets.filter((s) => (filter === "all" || (filter === "published" ? s.status === "published" : s.status !== "published")) &&
        (!q || String(s.number).includes(q) || s.ads.some((a) => a.client.includes(q))));
      if (!list.length) { host.innerHTML = `<div class="state"><div class="state-mark">${icon("search")}</div><h3>לא נמצאו גיליונות</h3><p>אין גיליון או לקוח שתואמים ל״${esc(q)}״ בתצוגה הזו.</p><button class="btn btn-small" type="button" id="clear-search">ניקוי החיפוש</button></div>`; $("#clear-search", host).addEventListener("click", () => { const i = $("#sheet-search", root); i.value = ""; query = ""; draw(); i.focus(); }); return; }
      host.innerHTML = `<table class="table sheets-list"><thead><tr><th>גיליון</th><th>יום פרסום</th><th>סגירת הזמנות</th><th class="col-num">מודעות</th><th>מוכנות</th><th>מצב</th><th class="col-toggle"><span class="visually-hidden">פירוט</span></th></tr></thead><tbody>${list.map((s) => sheetRow(s, open.has(s.number))).join("")}</tbody></table>`;
    };
    draw();
    host.addEventListener("click", (e) => {
      if (e.target.closest(".detail-inner, [data-tip]")) return;
      const row = e.target.closest("tr.is-row"); if (!row) return;
      const n = Number(row.dataset.sheet); const isOpen = !open.has(n);
      isOpen ? open.add(n) : open.delete(n);
      row.classList.toggle("is-open", isOpen); row.setAttribute("aria-expanded", String(isOpen));
      $(".disclose", row.nextElementSibling).classList.toggle("is-open", isOpen);
    });
    host.addEventListener("keydown", (e) => { const row = e.target.closest("tr.is-row"); if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); } });
    $$("[data-filter]", root).forEach((b) => b.addEventListener("click", () => { filter = b.dataset.filter; $$("[data-filter]", root).forEach((x) => x.setAttribute("aria-pressed", String(x === b))); draw(); }));
    const search = $("#sheet-search", root);
    search.addEventListener("input", () => { query = search.value; draw(); });
    document.addEventListener("keydown", function slash(e) { if (!search.isConnected) { document.removeEventListener("keydown", slash); return; } if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); search.focus(); } });
  }

  /* ---------- Screen: Design system ---------- */
  const SWATCHES = [
    ["כחול עמוק", "#36586C", "--deep-blue", "ניווט, כותרות, מספרים גדולים", "light"],
    ["כחול מעושן", "#527A92", "--smoky-blue", "פעולה ראשית, פריט פעיל, התקדמות", "light"],
    ["כחול בהיר", "#8EAFC0", "--soft-blue", "קווים וטקסט משני על כחול", ""],
    ["דבש", "#D6B384", "--honey", "קו חם אחד בכל אזור. לא לטקסט", ""],
    ["קרמל", "#B78350", "--caramel", "תשומת לב: מועדים, ממתין", "light"],
    ["אגוז", "#795239", "--walnut", "טקסט חם קטן: תאריכים, כיתובים", "light"],
    ["דיו", "#1F303B", "--ink", "טקסט רץ", "light"],
    ["פשתן", "#F4EEE5", "--linen", "בלוק טונאלי אחד במסך לכל היותר", ""],
    ["שמנת", "#FBF8F3", "--cream", "רקע שקט: שורה פתוחה, תחתית חלון", ""],
    ["לבן", "#FFFFFF", "--white", "המשטח העיקרי", ""],
  ];
  function viewSystem() {
    const sec = (n, id, title, lede, body) => `<section class="ds-section" id="ds-${id}"><header class="ds-head"><p class="folio"><b>${n}</b><span>${title}</span></p>${lede ? `<p class="ds-lede">${lede}</p>` : ""}</header>${body}</section>`;
    const toc = [["color", "צבע"], ["type", "טיפוגרפיה"], ["space", "מרווחים וקווים"], ["buttons", "כפתורים"], ["fields", "שדות קלט"], ["choice", "בחירה וסינון"], ["table", "טבלה"], ["status", "סטטוסים והתקדמות"], ["messages", "הודעות"], ["overlays", "חלונות, תפריטים ורמזים"], ["states", "טעינה, ריק ושגיאה"], ["rules", "עקרונות"]];
    return `<div class="ds">
      <aside class="ds-toc"><p class="ds-toc-title">מערכת העיצוב</p><ol>${toc.map(([id, t], i) => `<li><a href="#ds-${id}" data-jump="ds-${id}"><small class="num">${String(i + 1).padStart(2, "0")}</small>${t}</a></li>`).join("")}</ol><p class="ds-toc-note">טוקנים<br><code>css/tokens.css</code><br>רכיבים<br><code>css/components.css</code></p></aside>
      <div class="ds-main">
        <header class="ds-intro"><p class="t-caption">Premium Editorial · גרסה 1 · ${shortDate(new Date())}</p><h1 class="t-display">מערכת העיצוב</h1><p class="t-lede">שפה אחת לכל המסכים: נייר לבן, דיו כחולה, קו חם אחד. כותרות דקות, מספרים גדולים, פינות חדות. הצבע מסמן משמעות, לא קישוט.</p></header>

        ${sec("01", "color", "צבע", "שבעה חומרי גלם ושני גווני נייר. בכל מסך משתמשים במעט מהם, בהיררכיה קבועה: לבן ← דיו ← כחול עמוק ← כחול מעושן ← נגיעה חמה.", `
          <div class="swatches">${SWATCHES.map(([n, hex, v, use, light]) => `<button type="button" class="swatch" data-copy="${v}" data-tip="העתקת <b>var(${v})</b>"><span class="swatch-chip${light ? " is-dark" : ""}" data-hex="${hex}"></span><span class="swatch-text"><b>${n}</b><span class="num latin">${hex}</span><small>${use}</small></span></button>`).join("")}</div>
          <div class="ratio"><span class="r-white" style="flex:62"><b>62%</b> לבן ונייר</span><span class="r-ink" style="flex:14"><b>14%</b> דיו</span><span class="r-deep" style="flex:12"><b>12%</b> כחול עמוק</span><span class="r-smoke" style="flex:7"><b>7%</b></span><span class="r-warm" style="flex:5"><b>5%</b></span></div>
          <p class="t-small ds-note">היחס המשוער במסך עבודה טיפוסי. החם תמיד בכמות קטנה: קו, תאריך, סימון.</p>
          <table class="table contrast"><thead><tr><th>צירוף</th><th>דוגמה</th><th class="col-num">ניגודיות</th><th>שימוש מותר</th></tr></thead><tbody>
            <tr><td>דיו על לבן</td><td><span class="cx" data-c="ink">אבג 123</span></td><td class="col-num num">13.6:1</td><td>כל טקסט</td></tr>
            <tr><td>כחול עמוק על לבן</td><td><span class="cx" data-c="deep">אבג 123</span></td><td class="col-num num">7.3:1</td><td>כותרות, מספרים, קישורים</td></tr>
            <tr><td>לבן על כחול מעושן</td><td><span class="cx" data-c="on-smoke">אבג 123</span></td><td class="col-num num">4.6:1</td><td>כפתור ראשי, פריט פעיל</td></tr>
            <tr><td>אגוז על לבן</td><td><span class="cx" data-c="walnut">אבג 123</span></td><td class="col-num num">7.0:1</td><td>טקסט חם קטן</td></tr>
            <tr><td>קרמל על לבן</td><td><span class="cx" data-c="caramel">אבג 123</span></td><td class="col-num num">3.3:1</td><td>סימנים וטקסט מ־18px. לטקסט קטן: <span class="num latin">#8A5A2B</span></td></tr>
            <tr><td>דבש על לבן</td><td><span class="cx" data-c="honey">אבג 123</span></td><td class="col-num num">1.9:1</td><td>קווים בלבד</td></tr>
          </tbody></table>`)}

        ${sec("02", "type", "טיפוגרפיה", "Rubik בשלושה משקלים. 300 לכותרות ולמספרים, 400 לקריאה, 500 לכפתורים ולתוויות. הגודל יוצר היררכיה, לא העובי.", `
          <div class="type-scale">
            <div class="ts"><span class="ts-meta">Display · 64 / 300</span><p class="t-display">צהריים טובים</p></div>
            <div class="ts"><span class="ts-meta">H1 · 40 / 300</span><p class="t-h1">גיליונות</p></div>
            <div class="ts"><span class="ts-meta">H2 · 28 / 300</span><p class="t-h2">הגיליון הקרוב לפרסום</p></div>
            <div class="ts"><span class="ts-meta">H3 · 20 / 400</span><p class="t-h3">פרטי ההזמנה</p></div>
            <div class="ts"><span class="ts-meta">Lede · 19 / 300</span><p class="t-lede">גיליון 498 נסגר להזמנות הערב ב־23:59. שש מתוך שבע המודעות בו כבר מוכנות.</p></div>
            <div class="ts"><span class="ts-meta">Body · 15.5 / 400 / 1.62</span><p class="t-body">המודעה תשובץ בעמוד 5, בחצי העליון. הלקוח ביקש לשמור על הצבעים מהקמפיין הקודם ולהוסיף את מספר הטלפון החדש.</p></div>
            <div class="ts"><span class="ts-meta">Small · 14 / 400</span><p class="t-small">עודכן לפני 4 דקות על ידי צוות הפרסומון</p></div>
            <div class="ts"><span class="ts-meta">Label · 13 / 500</span><p class="t-label">סגירת הזמנות</p></div>
            <div class="ts"><span class="ts-meta">Caption · 12 / 400 · אגוז</span><p class="t-caption">בוקר בחדר העריכה</p></div>
          </div>
          <div class="figures">
            <div><span class="ts-meta">מספר מוביל · 112 / 300</span><p class="fig-xl num">498</p></div>
            <div><span class="ts-meta">סכום · 46 / 300, אגורות ו־₪ שקטים</span><p class="fig-l">${money(30497.29)}</p></div>
            <div><span class="ts-meta">ספרות טבלה · tabular</span><p class="fig-tab num">1,520.00<br>760.00<br>12,410.50</p></div>
          </div>`)}

        ${sec("03", "space", "מרווחים וקווים", "סולם של 4 עם קפיצות עריכתיות. קו אחד בעובי פיקסל. פינות חדות בכל מקום.", `
          <div class="space-scale">${[4, 8, 12, 16, 24, 32, 48, 64, 96].map((n, i) => `<div class="sp"><span class="sp-bar" data-w="${n}"></span><span class="num">${n}</span><small>--s-${i + 1}</small></div>`).join("")}</div>
          <div class="lines">
            <div class="ln"><span class="ln-demo" data-l="line"></span><b>קו רגיל</b><small>מפריד שורות ואזורים · <span class="latin num">#E6E0D6</span></small></div>
            <div class="ln"><span class="ln-demo" data-l="ink"></span><b>קו דיו</b><small>ראש טבלה, פתיחת אזור מרכזי</small></div>
            <div class="ln"><span class="ln-demo" data-l="honey"></span><b>קו דבש</b><small>פעם אחת במסך: סימן עריכתי ליד מספר האזור</small></div>
            <div class="ln"><span class="ln-demo" data-l="frame"></span><b>מסגרת</b><small>רק לשדות, לכפתורים משניים ולטופס הכניסה</small></div>
          </div>`)}

        ${sec("04", "buttons", "כפתורים", "כפתור ראשי אחד בכל אזור. השאר משניים או שקטים. הכיתוב אומר מה יקרה.", `
          <div class="demo-grid">
            <div class="demo"><span class="demo-label">ראשי</span><div class="row"><button class="btn btn-primary" type="button"><span class="btn-label">שמירת ההזמנה</span></button><button class="btn btn-primary is-hover" type="button"><span class="btn-label">Hover</span></button><button class="btn btn-primary" type="button" disabled><span class="btn-label">לא זמין</span></button></div></div>
            <div class="demo"><span class="demo-label">משני</span><div class="row"><button class="btn" type="button">ביטול</button><button class="btn is-hover" type="button">Hover</button><button class="btn btn-small" type="button">קטן</button></div></div>
            <div class="demo"><span class="demo-label">שקט וקישור</span><div class="row"><button class="btn btn-quiet" type="button">${icon("plus", "icon-s")}הוספת שורה</button><a class="link-quiet" href="#ds-buttons">כל ההזמנות ${icon("arrow", "icon-s")}</a></div></div>
            <div class="demo"><span class="demo-label">מסוכן</span><div class="row"><button class="btn btn-danger" type="button" data-demo="danger">ביטול ההזמנה</button></div></div>
            <div class="demo demo-wide"><span class="demo-label">משוב אחרי שמירה · לחצו</span><div class="row"><button class="btn btn-primary" type="button" data-demo="save"><span class="btn-label">שמירת השינויים</span><span class="btn-done">${icon("check", "icon-s")}נשמר</span></button><button class="btn btn-primary is-busy" type="button"><span class="btn-label">שומר</span></button><button class="btn btn-primary is-done" type="button"><span class="btn-label">נשמר</span><span class="btn-done">${icon("check", "icon-s")}נשמר</span></button></div></div>
          </div>`)}

        ${sec("05", "fields", "שדות קלט", "תווית מעל השדה, תמיד. שגיאה מתחת לשדה, במילים שמסבירות מה לתקן.", `
          <div class="demo-grid fields-grid">
            <label class="field"><span class="field-label">שם העסק</span><input class="input" value="נגריית אלון"></label>
            <label class="field"><span class="field-label">טלפון</span><input class="input input-ltr" placeholder="050-0000000"><span class="field-hint">יוצג במודעה כפי שנכתב כאן</span></label>
            <label class="field has-error"><span class="field-label">סכום</span><input class="input input-ltr" value="12,0O0" aria-invalid="true"><span class="field-error">${icon("alert", "icon-s")}הסכום יכול לכלול ספרות ונקודה עשרונית בלבד</span></label>
            <label class="field"><span class="field-label">שדה נעול</span><input class="input" value="הזמנה 10452" disabled></label>
            <label class="field"><span class="field-label">גודל המודעה</span><select class="select"><option>חצי עמוד</option><option>רבע עמוד</option><option>שמינית עמוד</option><option>עמוד שלם</option></select></label>
            <label class="field"><span class="field-label">תאריך פרסום</span><span class="input-with-icon">${icon("calendar")}<input class="input" value="יום ראשון, 29.11.2026"></span></label>
            <label class="field field-wide"><span class="field-label">הערה לעימוד</span><textarea class="textarea" placeholder="למשל: בחצי העליון של העמוד, ליד הטור"></textarea></label>
            <div class="field field-wide"><span class="field-label">חיפוש</span><label class="search">${icon("search")}<input type="search" placeholder="חיפוש לקוח, הזמנה או טלפון"><kbd>/</kbd></label></div>
          </div>`)}

        ${sec("06", "choice", "בחירה וסינון", "סינון הוא שורה אחת של מילים עם מספרים. מסנן פעיל מופיע כתווית שאפשר להסיר.", `
          <div class="demo-grid">
            <div class="demo"><span class="demo-label">סינון</span><div class="segmented" role="group" data-segmented><button type="button" aria-pressed="true">הכול <span class="count">38</span></button><button type="button" aria-pressed="false">פתוחות <span class="count">23</span></button><button type="button" aria-pressed="false">באיחור <span class="count">6</span></button><button type="button" aria-pressed="false">שולמו <span class="count">9</span></button></div></div>
            <div class="demo"><span class="demo-label">מסננים פעילים</span><div class="row"><span class="chip">קובץ: טרם התקבל<button type="button" aria-label="הסרת המסנן" data-chip>${icon("close", "icon-s")}</button></span><span class="chip">גיליון 498<button type="button" aria-label="הסרת המסנן" data-chip>${icon("close", "icon-s")}</button></span></div></div>
            <div class="demo"><span class="demo-label">תיבות ובחירה</span><div class="row"><label class="check"><input type="checkbox" checked> כולל מע״מ</label><label class="check"><input type="checkbox"> לשלוח קבלה</label><label class="check"><input type="radio" name="pay" checked> מזומן</label><label class="check"><input type="radio" name="pay"> העברה</label></div></div>
            <div class="demo"><span class="demo-label">מתג</span><div class="row"><label class="switch"><input type="checkbox" checked> סנכרון חי</label><label class="switch"><input type="checkbox"> הצגת מבוטלות</label></div></div>
            <div class="demo demo-wide"><span class="demo-label">לשוניות</span><div class="tabs" role="tablist" data-tabs><button role="tab" type="button" aria-selected="true">פרטים</button><button role="tab" type="button" aria-selected="false">הזמנות <span class="num">12</span></button><button role="tab" type="button" aria-selected="false">תשלומים</button><button role="tab" type="button" aria-selected="false">חבילות</button></div></div>
          </div>`)}

        ${sec("07", "table", "טבלה", "קו דיו מתחת לכותרות, קו רגיל בין שורות, בלי רקע מתחלף. ספרות מיושרות לקצה. ריחוף מסמן שורה שאפשר לפתוח.", `
          <div class="table-wrap"><table class="table"><thead><tr><th class="is-sortable" aria-sort="descending">הזמנה ${icon("sort")}</th><th>לקוח</th><th>גיליון</th><th>קובץ</th><th class="col-num">סכום</th><th class="col-num">יתרה</th></tr></thead><tbody>
            <tr class="is-row"><td class="num muted">10466</td><td>בית הקפה פינת רחוב</td><td class="num">498</td><td><span class="status" data-tone="missing">קובץ טרם התקבל</span></td><td class="col-num">${money(760, "money-s")}</td><td class="col-num">${money(760, "money-s")}</td></tr>
            <tr class="is-row"><td class="num muted">10463</td><td>קונדיטוריית אורנה</td><td class="num">498</td><td><span class="status" data-tone="ready">אושר</span></td><td class="col-num">${money(410, "money-s")}</td><td class="col-num muted">—</td></tr>
            <tr class="is-row"><td class="num muted">10461</td><td>סטודיו לורן לעיצוב פנים</td><td class="num">498</td><td><span class="status" data-tone="ready">אושר</span></td><td class="col-num">${money(980, "money-s")}</td><td class="col-num">${money(490, "money-s")}</td></tr>
            <tr class="is-row"><td class="num muted">10458</td><td>מכון הכושר תנופה</td><td class="num">498</td><td><span class="status" data-tone="placed">שובץ בעמוד 4</span></td><td class="col-num">${money(1520, "money-s")}</td><td class="col-num muted">—</td></tr>
          </tbody></table></div>`)}

        ${sec("08", "status", "סטטוסים והתקדמות", "סימן קטן ומילה. בלי תגיות צבעוניות. הצורה של הסימן מבדילה גם בלי צבע.", `
          <div class="demo-grid">
            <div class="demo"><span class="demo-label">גיליון</span><div class="stack"><span class="status" data-tone="open">פתוח להזמנות</span><span class="status" data-tone="closing">נסגר בעוד 8 שעות</span><span class="status" data-tone="closed">נסגר להזמנות</span><span class="status" data-tone="published">פורסם</span></div></div>
            <div class="demo"><span class="demo-label">קובץ המודעה</span><div class="stack"><span class="status" data-tone="missing">קובץ טרם התקבל</span><span class="status" data-tone="review">ממתין לאישור</span><span class="status" data-tone="ready">אושר</span><span class="status" data-tone="placed">שובץ בעמוד</span></div></div>
            <div class="demo"><span class="demo-label">תשלום</span><div class="stack"><span class="status" data-tone="ready">שולם</span><span class="status" data-tone="review">שולם חלקית</span><span class="status" data-tone="danger">באיחור של 12 ימים</span></div></div>
            <div class="demo"><span class="demo-label">התקדמות: פס, ומקטע לכל מודעה (רחפו)</span><div class="stack stack-wide"><div class="progress"><i style="--p:64"></i></div>${segmentsHTML(D.next)}</div></div>
          </div>`)}

        ${sec("09", "messages", "הודעות", "הודעה בתוך המסך כשצריך לקרוא אותה. הודעה צפה כשרק מאשרים שמשהו קרה.", `
          <div class="demo-grid">
            <div class="notice">${icon("info")}<div><strong>הגיליון ייסגר הערב ב־23:59</strong><p>הזמנות שיתקבלו אחרי המועד ישויכו לגיליון הבא.</p></div><span></span></div>
            <div class="notice" data-tone="success">${icon("check")}<div><strong>התשלום נרשם</strong><p>קבלה 2231 נשלחה אל נגריית אלון.</p></div><span></span></div>
            <div class="notice" data-tone="attention">${icon("alert")}<div><strong>חסרים 2 קבצים לגיליון 498</strong><p>בית הקפה פינת רחוב, מעדניית השוק.</p></div><span></span></div>
            <div class="notice" data-tone="danger">${icon("alert")}<div><strong>השמירה לא הצליחה</strong><p>החיבור לשרת נקטע. השינויים נשמרו במכשיר וישלחו כשהחיבור יחזור.</p></div><button class="btn btn-small" type="button" data-say="מנסה שוב…">ניסיון נוסף</button></div>
            <div class="demo demo-wide"><span class="demo-label">הודעה צפה</span><div class="row"><button class="btn" type="button" data-demo="toast">הצגת הודעת שמירה</button><button class="btn" type="button" data-demo="toast-undo">הודעה עם ביטול</button></div></div>
          </div>`)}

        ${sec("10", "overlays", "חלונות, תפריטים ורמזים", "חלון רק לאישור פעולה שאי אפשר לבטל, או לטופס קצר. תפריט לפעולות משניות. רמז רק למידע שלא חייב להופיע בשורה.", `
          <div class="demo-grid">
            <div class="demo"><span class="demo-label">חלון אישור</span><div class="row"><button class="btn" type="button" data-demo="dialog">פתיחת חלון</button><button class="btn btn-danger" type="button" data-demo="danger">חלון מסוכן</button></div></div>
            <div class="demo"><span class="demo-label">תפריט</span><div class="row"><span class="menu-anchor"><button class="btn" type="button" data-menu aria-haspopup="true" aria-expanded="false">פעולות ${icon("chevron", "icon-s chevron")}</button><span class="menu" role="menu"><button role="menuitem" type="button">שכפול ההזמנה</button><button role="menuitem" type="button">שליחת אישור ללקוח</button><button role="menuitem" type="button">הדפסה</button><hr><button role="menuitem" type="button" class="is-danger">ביטול ההזמנה</button></span></span></div></div>
            <div class="demo"><span class="demo-label">רמז</span><div class="row"><span class="mark-manual" tabindex="0" data-tip="מועד הסגירה שונה ידנית.<br><span>במקור: חמישי 10/12, 23:59</span>">שונה ידנית</span><button class="btn btn-quiet" type="button" data-tip="<b>הדפסה</b><br><span>רשימת המודעות של הגיליון</span>">הדפסה</button></div></div>
          </div>`)}

        ${sec("11", "states", "טעינה, ריק ושגיאה", "טעינה מראה את צורת התוכן שמגיע. מסך ריק מסביר מה יופיע ומציע צעד אחד. שגיאה אומרת מה קרה ומה אפשר לעשות.", `
          <div class="demo-grid states-grid">
            <div class="demo"><span class="demo-label">טעינת טבלה</span><div class="loader-line"></div><div class="sk-rows">${[70, 52, 64].map((w) => `<div class="sk-row"><span class="skeleton sk-a"></span><span class="skeleton sk-b" data-w="${w}"></span><span class="skeleton sk-c"></span></div>`).join("")}</div></div>
            <div class="demo"><span class="demo-label">ריק</span><div class="state"><div class="state-mark">${icon("file")}</div><h3>אין הזמנות ממתינות</h3><p>כל הקבצים לגיליון 498 התקבלו. הזמנות חדשות יופיעו כאן.</p></div></div>
            <div class="demo"><span class="demo-label">שגיאה</span><div class="state" data-tone="danger"><div class="state-mark">${icon("alert")}</div><h3>לא הצלחנו לטעון את הגיליונות</h3><p>ייתכן שהחיבור לאינטרנט נקטע. הנתונים לא נמחקו.</p><button class="btn btn-small" type="button" data-say="טוען מחדש…">טעינה מחדש</button></div></div>
          </div>`)}

        ${sec("12", "rules", "עקרונות", "", `
          <ol class="rules">
            <li><b>מסך אחד, מטרה אחת.</b> כל מה שלא משרת את הפעולה הנוכחית נפתח לפי בקשה.</li>
            <li><b>הגודל מוביל, לא העובי.</b> כותרות דקות וגדולות. הדגשה רק בתוויות ובכפתורים.</li>
            <li><b>לא כל דבר צריך מסגרת.</b> אזורים מופרדים ברווח ובקו. בלוק טונאלי אחד במסך לכל היותר.</li>
            <li><b>הצבע אומר משהו.</b> כחול מעושן הוא פעולה. קרמל הוא מועד או המתנה. לבנה היא שגיאה.</li>
            <li><b>הצילום הוא חלון, לא קישוט.</b> צילום אחד גדול במסך פתיחה. במסכי עבודה הטבלה היא הגיבורה.</li>
            <li><b>תנועה רק כשהיא מסבירה.</b> מספרים שנספרים, שורה שנפתחת, אישור ששמירה הצליחה.</li>
          </ol>`)}
      </div>
    </div>`;
  }
  function bindSystem(root) {
    $$(".swatch-chip", root).forEach((c) => { c.style.background = c.dataset.hex; });
    $$(".sp-bar", root).forEach((b) => { b.style.width = b.style.height = b.dataset.w + "px"; });
    $$(".sk-b", root).forEach((b) => { b.style.width = b.dataset.w + "%"; });
    $$("[data-copy]", root).forEach((b) => b.addEventListener("click", () => { const v = `var(${b.dataset.copy})`; (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).catch(() => {}); toast(`הועתק: ${v}`, { icon: "copy" }); }));
    bindDemos(root);
    const links = $$("[data-jump]", root);
    links.forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); const t = document.getElementById(a.dataset.jump); t.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" }); }));
    const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) links.forEach((a) => a.classList.toggle("is-here", a.dataset.jump === en.target.id)); }), { rootMargin: "-30% 0px -60% 0px" });
    $$(".ds-section", root).forEach((s) => io.observe(s));
  }
  function bindDemos(root) {
    root.addEventListener("click", (e) => {
      const d = e.target.closest("[data-demo]");
      const say = e.target.closest("[data-say]:not(.menu button)");
      if (say && !d) toast(say.dataset.say, { icon: "info" });
      if (e.target.closest("[data-chip]")) { const c = e.target.closest(".chip"); c.classList.add("is-leaving"); c.remove(); toast("המסנן הוסר", { icon: "check" }); }
      const seg = e.target.closest("[data-segmented] button"); if (seg) $$("button", seg.parentElement).forEach((b) => b.setAttribute("aria-pressed", String(b === seg)));
      const tab = e.target.closest("[data-tabs] button"); if (tab) $$("button", tab.parentElement).forEach((b) => b.setAttribute("aria-selected", String(b === tab)));
      if (!d) return;
      const k = d.dataset.demo;
      if (k === "save") saveButton(d);
      if (k === "toast") toast("ההזמנה נשמרה");
      if (k === "toast-undo") toast("המודעה הועברה לגיליון 499", { undo: true, ms: 5200 });
      if (k === "dialog") openDialog({ title: "שיוך ההזמנה לגיליון 499", body: "<p>הגיליון 498 נסגר להזמנות. ההזמנה של קונדיטוריית אורנה תפורסם ביום ראשון 6.12.</p>", confirm: "שיוך לגיליון 499", onConfirm: () => toast("ההזמנה שויכה לגיליון 499") });
      if (k === "danger") openDialog({ title: "לבטל את הזמנה 10466?", body: "<p>ההזמנה תוסר מגיליון 498 והחיוב יבוטל. אפשר לראות הזמנות מבוטלות דרך הסינון.</p>", confirm: "ביטול ההזמנה", tone: "danger", onConfirm: () => toast("ההזמנה בוטלה", { icon: "check", undo: true }) });
      if (k === "count") playCounts(d.closest(".demo"));
      if (k === "disclose") { const box = d.closest(".demo").querySelector(".disclose"); const open = box.classList.toggle("is-open"); d.setAttribute("aria-expanded", String(open)); }
      if (k === "skeleton") { const box = d.closest(".demo").querySelector(".load-demo"); box.classList.add("is-loading"); setTimeout(() => box.classList.remove("is-loading"), 1400); }
      if (k === "page") { const box = d.closest(".demo").querySelector(".page-demo"); box.classList.remove("is-in"); void box.offsetWidth; box.classList.add("is-in"); }
    });
  }

  /* ---------- Screen: Photography ---------- */
  const PHOTOS_HAVE = [
    { file: "login.jpg", screen: "התחברות", what: "כורסה, שמיכה ועיתון ״הפרסומון״ פתוח, חדר ירוק עמוק ואור מנורה חם", size: "1536×1024 · JPEG", fit: "טוב. חד בכל גודל עד 1920.", gap: "בפיגמה מתוכננת כורסה כחולה באור יום. החדר הירוק והאור הערבי חמים מהפלטה." },
    { file: "home.webp", screen: "בית", what: "ערימת עיתונים ואגרטל קרמי כחול עם פרחים לבנים, באור בוקר", size: "1000×236 · WebP", fit: "מתאים בצבע ובאור. ברזולוציה נמוכה: מוגדל עד פי 1.2 ברוחב 1440.", gap: "צריך מקור ברוחב 2400 לפחות." },
    { file: "orders.webp", screen: "הזמנות", what: "מחברת פתוחה ועט עץ על בד פשתן, אור חלון", size: "383×218 · WebP", fit: "השפה נכונה. קטן מאוד: מתאים רק לרצועה צרה.", gap: "צריך מקור ברוחב 2000." },
    { file: "clients.webp", screen: "לקוחות", what: "חדר עבודה עם שולחן אגוז, מדפים ירוקים ומנורת פליז", size: "556×462 · WebP", fit: "חומרים נכונים (אגוז). גוון הקירות ירוק ולא כחול.", gap: "צריך גרסה כחלחלה וברזולוציה גבוהה." },
  ];
  const PHOTOS_NEED = [
    ["login", "התחברות", "חצי המסך השמאלי, גובה מלא", "4:5 · 2400×3000", "כורסה מרופדת בפשתן כחול מעושן בשליש הימני, עיתון מקופל על המשענת, שולחן צד מאגוז. אור חלון רך משמאל. רקע קיר שמנת. החצי הימני של הצילום שקט, כי הוא פונה לטופס.", "Editorial interior photograph, an armchair upholstered in smoky-blue linen (#527A92) in the right third, a folded newspaper resting on its arm, a small walnut side table, soft natural window light from the left, warm cream plaster wall, shallow depth of field, calm and quiet, 35mm, natural colour, no people, no readable text, no logos, magazine quality, portrait 4:5"],
    ["home", "בית", "פתיחת המסך, משמאל לברכה, עד שולי המסך", "16:7 · 2800×1225", "פינת קריאה: שולחן אגוז ליד חלון, ערימת עיתונים מקופלים, אגרטל זכוכית עם פרחים יבשים בגוני דבש, שמיכת פשתן כחולה על כיסא. המוקד בשליש השמאלי; הימין נמוג לאור.", "Wide editorial photograph of a reading corner, walnut table by a tall window, a neat stack of folded newspapers, a clear glass vase with dried flowers in honey tones (#D6B384), a smoky-blue linen throw over a chair, soft morning sunlight with long shadows, shallow depth of field, subject in the left third and calm light on the right, natural colour, cinematic, no people, no readable text, 16:7"],
    ["orders", "הזמנות", "רצועת כותרת צרה מעל הטבלה", "4:1 · 2400×600", "מבט מלמעלה בזווית: מחברת פתוחה, עט נובע, דף הזמנה, כוס מים על שולחן אגוז. הרבה אוויר בצד ימין.", "Top-down angled editorial still life on a walnut desk, an open notebook with a fountain pen, a sheet of paper, a glass of water, soft daylight, gentle shadows, natural colour, generous negative space on the right, no readable writing, no people, 4:1 banner"],
    ["clients", "לקוחות", "רצועת כותרת", "4:1 · 2400×600", "מעטפות נייר עבה בגוני שמנת, חותמת שעווה בצבע קרמל, מכתב מקופל, חוט פשתן כחול. תחושה של קשר אישי.", "Editorial still life of cream envelopes and a folded letter, a caramel-coloured wax seal (#B78350), a length of smoky-blue linen twine, on a linen tablecloth, soft window light, shallow depth of field, natural colour, no readable text, no people, 4:1 banner"],
    ["sheets", "גיליונות", "רצועת כותרת", "4:1 · 2400×600", "ערימת גיליונות מודפסים טריים, קצוות נייר באור בוקר, עומק שדה רדוד. בלי כותרות קריאות. בלי פרחים ובלי ספל.", "Editorial photograph of a stack of freshly printed newspapers, crisp paper edges catching low morning sunlight, shallow depth of field, warm white and soft grey tones, a walnut surface, quiet and precise, no readable headlines, no flowers, no cups, no people, 4:1 banner"],
    ["packages", "חבילות", "רצועת כותרת", "4:1 · 2400×600", "חומרי דפוס מסודרים: גלילי נייר, דוגמאות נייר בגוונים, סרגל פליז, אטבים. קומפוזיציה של שכבות.", "Editorial flat-lay of print materials, paper rolls, colour paper swatches in cream, honey and smoky blue, a brass ruler, binder clips, arranged in calm layers on a linen surface, soft daylight, natural colour, no readable text, 4:1 banner"],
    ["payments", "גבייה", "רצועת כותרת", "4:1 · 2400×600", "פנקס קבלות בכריכת בד כחולה, עט, מחשבון פליז ישן, שולחן אגוז מסודר. מוקפד ושקט.", "Editorial still life, a cloth-bound receipt book in smoky blue, a pen, a vintage brass desk calculator, on a tidy walnut desk, soft side light, precise and calm, natural colour, no readable numbers, no people, 4:1 banner"],
    ["reports", "דוחות", "רצועת כותרת", "4:1 · 2400×600", "תיקיות נייר מסודרות, דפים מודפסים עם טבלאות מטושטשות, משקפי קריאה, מנורת שולחן כבויה. מקצועי ומסודר.", "Editorial photograph of neatly stacked paper folders and printed pages with softly blurred tables, reading glasses, a walnut desk, a desk lamp switched off, daylight, orderly and professional, natural colour, no readable text, 4:1 banner"],
  ];
  function viewPhotos() {
    return `<div class="photos">
      <header class="photos-intro">
        <p class="folio"><b>—</b><span>ספריית הצילום</span></p>
        <h1 class="t-display">חדר אחד, אור אחד</h1>
        <p class="t-lede">כל הצילומים במערכת צריכים להיראות כאילו צולמו באותו חדר, באותו בוקר, על ידי אותו צלם: אור חלון רך, אגוז, פשתן כחול מעושן, נייר, ופרחים יבשים בגוני דבש.</p>
        <ul class="photo-rules"><li><b>אור</b>טבעי, נמוך, מצד אחד. צללים ארוכים ורכים.</li><li><b>חומרים</b>אגוז, פשתן, נייר עבה, זכוכית, פליז מט.</li><li><b>צבע</b>כחול מעושן, דבש, שמנת. בלי ירוק עמוק ובלי זהב.</li><li><b>אסור</b>אנשים, מסכים, לוגו, טקסט קריא, ברק של מאגר.</li></ul>
      </header>

      <section class="photo-have">
        <h2 class="folio"><b>01</b><span>צילומים קיימים ומורשים</span></h2>
        <div class="have-grid">${PHOTOS_HAVE.map((p) => `<figure class="have"><div class="have-img"><img src="../assets/photos/${p.file}" alt="${esc(p.what)}" loading="lazy"></div><figcaption><p class="have-screen">${p.screen}<span class="latin num">${p.file}</span></p><p class="have-what">${p.what}</p><dl><dt>גודל</dt><dd><span class="latin num">${p.size}</span></dd><dt>התאמה</dt><dd>${p.fit}</dd><dt>פער</dt><dd>${p.gap}</dd><dt>רישיון</dt><dd>בבעלות הפרויקט · <span class="latin">assets/CREDITS.md</span></dd></dl></figcaption></figure>`).join("")}</div>
        <div class="notice" data-tone="attention">${icon("alert")}<div><strong>מה לא נכנס, ולמה</strong><p>21 תמונות ההשראה ב־<span class="latin">design-references/</span> אינן מורשות לשימוש, ולכן לא שולבו. גם <span class="latin">sheet-newspaper.png</span> ממתינה לאימות רישיון. לא הוספתי תמונות מאגר או תמונות שנוצרו, כדי לא לשבור את האחידות.</p></div><span></span></div>
      </section>

      <section class="photo-need">
        <h2 class="folio"><b>02</b><span>צילומים להפקה · 8 צילומים</span></h2>
        <p class="t-small need-lede">לכל צילום: איפה הוא יופיע, באיזה יחס, מה בקומפוזיציה, ופרומפט באנגלית ליצירה או לבריף לצלם. שם הקובץ כבר מחכה בקוד.</p>
        <ol class="need-list">${PHOTOS_NEED.map(([key, screen, where, ratio, comp, prompt], i) => `<li class="need">
          <div class="need-plate" data-ratio="${ratio.split(" ")[0]}"><span>${icon("image")}<b>${screen}</b><small class="num latin">${ratio.split(" · ")[0]}</small></span></div>
          <div class="need-body"><p class="need-title"><span class="num">${String(i + 1).padStart(2, "0")}</span>${screen}<code class="latin">assets/photos/${key}.webp</code></p>
            <dl class="need-spec"><dt>מיקום</dt><dd>${where}</dd><dt>יחס וגודל</dt><dd><span class="latin num">${ratio}</span></dd><dt>קומפוזיציה</dt><dd>${comp}</dd></dl>
            <div class="prompt"><p class="prompt-text latin">${esc(prompt)}</p><button class="btn btn-small btn-quiet" type="button" data-prompt="${i}">${icon("copy", "icon-s")}העתקת הפרומפט</button></div></div></li>`).join("")}</ol>
      </section>
    </div>`;
  }
  function bindPhotos(root) {
    $$(".need-plate", root).forEach((p) => { const [w, h] = p.dataset.ratio.split(":").map(Number); p.style.aspectRatio = `${w} / ${h}`; });
    $$("[data-prompt]", root).forEach((b) => b.addEventListener("click", () => { const t = PHOTOS_NEED[Number(b.dataset.prompt)][5]; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).catch(() => {}); toast("הפרומפט הועתק", { icon: "copy" }); }));
  }

  /* ---------- Screen: Motion ---------- */
  function viewMotion() {
    const spec = [["ספירת סכומים", "1350ms", "ease-out (cubic)", "כניסה למסך הבית; שוב בריחוף, לא בתוך 1.5 שניות"], ["פתיחת פירוט", "380ms", "ease-in-out", "גובה נפתח, התוכן מופיע 80ms אחריו"], ["ריחוף בשורה וכפתור", "140ms", "ease-out", "צבע רקע וקו בלבד"], ["לחיצה", "140ms", "ease-out", "הכפתור יורד בפיקסל"], ["אישור שמירה", "220ms", "ease-out", "קו מסתובב ← סימן ״נשמר״ ל־1.6 שניות"], ["הודעה צפה", "380ms / 220ms", "ease-out", "עולה 12px ונעלמת אחרי 3.6 שניות"], ["מעבר בין מסכים", "380ms", "ease-out", "התוכן עולה 8px ומתבהר. הניווט לא זז"], ["טעינה", "1250ms", "ease-in-out, בלולאה", "קו דק בראש האזור ושלד בצורת התוכן"]];
    return `<div class="motion">
      <header class="photos-intro"><p class="folio"><b>—</b><span>תנועה ומשוב</span></p><h1 class="t-display">תנועה שמסבירה</h1><p class="t-lede">כל תנועה עונה על שאלה: מה השתנה, מה נשמר, מאיפה הגיע המידע. שום דבר לא זז רק כדי לזוז. מי שביקש מהמערכת להפחית תנועה רואה את המצב הסופי מיד.</p></header>
      <div class="demo-grid motion-grid">
        <div class="demo"><span class="demo-label">ספירת סכום</span><p class="fig-l motion-figure" data-replay>${countable(8080.42)}</p><button class="btn btn-small" type="button" data-demo="count">הפעלה</button><small class="t-small">גם בריחוף על הסכום</small></div>
        <div class="demo"><span class="demo-label">פתיחת פירוט</span><button class="disclose-trigger" type="button" data-demo="disclose" aria-expanded="false"><span>גיליון 498 · 7 מודעות</span>${icon("chevron", "chevron")}</button><div class="disclose"><div><div class="disclose-inner"><ul class="mini-list"><li><span class="status" data-tone="placed">נגריית אלון</span><span class="t-small">עמוד 2</span></li><li><span class="status" data-tone="ready">פרחי הגן</span><span class="t-small">אושר</span></li><li><span class="status" data-tone="missing">בית הקפה פינת רחוב</span><span class="t-small">קובץ חסר</span></li></ul></div></div></div></div>
        <div class="demo"><span class="demo-label">שמירה</span><button class="btn btn-primary" type="button" data-demo="save"><span class="btn-label">שמירת השינויים</span><span class="btn-done">${icon("check", "icon-s")}נשמר</span></button><button class="btn" type="button" data-demo="toast">הודעה צפה</button></div>
        <div class="demo"><span class="demo-label">טעינה</span><div class="load-demo"><div class="loader-line"></div><div class="ld-real"><p class="t-h3">גיליון 499</p><p class="t-small">יום ראשון 06.12.2026 · 4 מודעות</p></div><div class="ld-sk"><span class="skeleton"></span><span class="skeleton"></span></div></div><button class="btn btn-small" type="button" data-demo="skeleton">טעינה מחדש</button></div>
        <div class="demo"><span class="demo-label">מעבר בין מסכים</span><div class="page-demo is-in"><p class="t-h3">הזמנות</p><span class="skeleton pd-a"></span><span class="skeleton pd-b"></span></div><button class="btn btn-small" type="button" data-demo="page">הדגמה</button></div>
        <div class="demo"><span class="demo-label">ריחוף ומיקוד</span><div class="hover-demo"><a class="task" href="#/motion" onclick="return false"><span class="task-count num">4</span><span class="task-text"><b>מודעות שטרם התקבלו</b><small>קבצים שהלקוח עוד לא שלח</small></span>${icon("arrow", "icon-s task-go")}</a></div><small class="t-small">החץ זז, הרקע מתחמם. מקש Tab מראה מסגרת מיקוד.</small></div>
      </div>
      <section class="motion-spec"><h2 class="folio"><b>—</b><span>מפרט זמנים</span></h2>
        <table class="table"><thead><tr><th>אינטראקציה</th><th>משך</th><th>עקומה</th><th>מה קורה</th></tr></thead><tbody>${spec.map((r) => `<tr><td>${r[0]}</td><td class="num latin">${r[1]}</td><td class="latin">${r[2]}</td><td class="muted">${r[3]}</td></tr>`).join("")}</tbody></table>
        <p class="t-small ds-note">כל הזמנים הם טוקנים (<span class="latin">--t-fast, --t-base, --t-slow, --t-count</span>). ב־<span class="latin">prefers-reduced-motion</span> הם מתאפסים.</p>
      </section>
    </div>`;
  }

  /* ---------- Router ---------- */
  const VIEWS = { system: [viewSystem, bindSystem], photos: [viewPhotos, bindPhotos], login: [viewLogin, bindLogin], home: [viewHome, bindHome], sheets: [viewSheets, bindSheets], motion: [viewMotion, (r) => bindDemos(r)] };
  const stage = $("#stage");
  let current = null;
  function route() {
    const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || "home";
    if (!VIEWS[name]) { if (NAV.some(([k]) => k === name)) { toast("המסך הזה עוד לא עוצב בסטודיו. הבא בתור לפי אותה שפה.", { icon: "info" }); history.replaceState(null, "", `#/${current || "home"}`); } return; }
    const keepScroll = name === current;
    current = name;
    document.body.dataset.view = name;
    $$(".studio-tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.view === name ? "page" : "false"));
    stage.innerHTML = `<div class="view is-entering" data-view="${name}">${VIEWS[name][0]()}</div>`;
    const root = stage.firstElementChild;
    requestAnimationFrame(() => root.classList.remove("is-entering"));
    VIEWS[name][1](root);
    bindShell(root);
    if (!keepScroll) window.scrollTo(0, 0);
    syncPhone();
  }
  function bindShell(root) {
    const t = $(".sidenav-toggle", root); const body = $(".sidenav-body", root);
    if (t) t.addEventListener("click", () => { const open = !body.classList.contains("is-open"); body.classList.toggle("is-open", open); t.setAttribute("aria-expanded", String(open)); });
    $$(".nav-new, .nav-out", root).forEach((b) => b.addEventListener("click", () => toast(b.dataset.say, { icon: "info" })));
    if (!root.dataset.demos && root.dataset.view !== "system" && root.dataset.view !== "motion") { root.dataset.demos = "1"; root.addEventListener("click", (e) => { const say = e.target.closest(".ads-foot [data-say], .state [data-say]"); if (say) toast(say.dataset.say, { icon: "info" }); }); }
  }

  /* ---------- Studio tools: device preview and photo slots ---------- */
  const phone = $("#phone"); const frame = $("#phone-frame");
  let device = "desktop";
  function syncPhone() {
    if (device !== "mobile") return;
    const url = `index.html?bare=1${document.body.classList.contains("show-slots") ? "&slots=1" : ""}${location.hash}`;
    if (frame.dataset.src !== url) { frame.dataset.src = url; frame.src = url; }
  }
  $$("[data-device]").forEach((b) => b.addEventListener("click", () => {
    device = b.dataset.device;
    $$("[data-device]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    document.body.classList.toggle("is-phone", device === "mobile");
    phone.hidden = device !== "mobile"; stage.hidden = device === "mobile";
    syncPhone();
  }));
  const slots = $("#toggle-slots");
  if (params.get("slots") === "1") { slots.checked = true; document.body.classList.add("show-slots"); }
  slots.addEventListener("change", () => { document.body.classList.toggle("show-slots", slots.checked); frame.dataset.src = ""; syncPhone(); });
  if (params.get("device") === "mobile") $('[data-device="mobile"]').click();

  window.addEventListener("hashchange", route);
  route();
  window.Studio = { route, toast, playCounts };
})();
