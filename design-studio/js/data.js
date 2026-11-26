/* Design Studio — fictional demo data only. No real customer appears here.
   Dates are computed from today's date, so the countdown and "next sheet" always look current. */
(function () {
  const DAY = 86400000;
  const today = new Date();
  const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // The paper is a weekly, published on Sunday. Orders close on the Thursday before, at 23:59.
  // Sheet 498 is published on Sunday 29/11/2026; the numbering follows the weeks from there.
  const anchor = new Date(2026, 10, 29);
  const nextSunday = (from) => { const d = atMidnight(from); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return d; };
  const closesFor = (sunday) => { const c = new Date(sunday); c.setDate(c.getDate() - 3); c.setHours(23, 59, 0, 0); return c; };
  let first = nextSunday(today);
  if (closesFor(first) < today) first = new Date(first.getTime() + 7 * DAY);
  const numberFor = (sunday) => 498 + Math.round((atMidnight(sunday) - anchor) / (7 * DAY));

  const clients = [
    "נגריית אלון", "מעדניית השוק", "סטודיו לורן לעיצוב פנים", "משרד עו״ד כהן־לוי", "אופטיקה רמות",
    "פרחי הגן", "קונדיטוריית אורנה", "מוסך הנשיא", "ספריית הכרמל", "גני אירועים אלמוג",
    "רהיטי שקד", "מכון הכושר תנופה", "קליניקה לפיזיותרפיה גל", "בית הקפה פינת רחוב",
  ];
  const sizes = ["עמוד שלם", "חצי עמוד", "רבע עמוד", "שמינית עמוד", "רצועה תחתונה", "מודעת שער"];

  // An advertisement's file moves: missing → review → ready (approved) → placed.
  const ad = (n, client, size, state, page, amount) => ({ n, client, size, state, page, amount });
  const stateNames = { missing: "קובץ טרם התקבל", review: "ממתין לאישור", ready: "אושר", placed: "שובץ בעמוד" };

  const sheets = [];
  for (let i = -2; i < 4; i++) {
    const sunday = new Date(first.getTime() + i * 7 * DAY);
    const closes = closesFor(sunday);
    const s = { number: numberFor(sunday), date: sunday, closes, manual: false, ads: [] };
    if (i < 0) s.status = "published";
    else if (i === 0) s.status = "open";
    else s.status = "open";
    sheets.push(s);
  }
  // The sheet after next closes early (changed by hand): Wednesday 20:00.
  sheets[3].closes = new Date(sheets[3].closes.getTime() - DAY); sheets[3].closes.setHours(20, 0, 0, 0); sheets[3].manual = true;

  sheets[0].ads = [
    ad(10412, clients[0], sizes[1], "placed", 3, 1520), ad(10415, clients[3], sizes[2], "placed", 5, 760),
    ad(10418, clients[6], sizes[3], "placed", 7, 410), ad(10420, clients[9], sizes[0], "placed", 2, 2890),
    ad(10421, clients[12], sizes[2], "placed", 6, 760),
  ];
  sheets[1].ads = [
    ad(10431, clients[1], sizes[1], "placed", 3, 1520), ad(10433, clients[4], sizes[3], "placed", 8, 410),
    ad(10436, clients[7], sizes[2], "placed", 5, 760), ad(10437, clients[10], sizes[5], "placed", 1, 3400),
    ad(10440, clients[13], sizes[4], "placed", 9, 980), ad(10441, clients[2], sizes[3], "placed", 7, 410),
  ];
  sheets[2].ads = [
    ad(10452, clients[0], sizes[0], "placed", 2, 2890), ad(10455, clients[5], sizes[2], "ready", null, 760),
    ad(10457, clients[8], sizes[3], "ready", null, 410), ad(10458, clients[11], sizes[1], "placed", 4, 1520),
    ad(10461, clients[2], sizes[4], "ready", null, 980), ad(10463, clients[6], sizes[3], "ready", null, 410),
    ad(10466, clients[13], sizes[2], "missing", null, 760),
  ];
  sheets[3].ads = [
    ad(10470, clients[3], sizes[1], "review", null, 1520), ad(10471, clients[1], sizes[3], "missing", null, 410),
    ad(10474, clients[10], sizes[5], "ready", null, 3400), ad(10476, clients[12], sizes[2], "missing", null, 760),
  ];
  sheets[4].ads = [ad(10480, clients[4], sizes[2], "missing", null, 760), ad(10482, clients[9], sizes[0], "review", null, 2890)];
  sheets[5].ads = [];

  const isReady = (a) => a.state === "ready" || a.state === "placed";
  const allOpenAds = sheets.filter((s) => s.status !== "published").flatMap((s) => s.ads.map((a) => ({ ...a, sheet: s.number })));

  window.STUDIO_DATA = {
    today, sheets, stateNames, isReady,
    next: sheets[2],
    money: [
      { key: "receipts", label: "תקבולים החודש", value: 8080.42, note: "12 תקבולים מ־9 לקוחות" },
      { key: "open", label: "חובות פתוחים", value: 30497.29, note: "ב־23 הזמנות" },
      { key: "overdue", label: "מתוכם באיחור", value: 4309.74, note: "6 לקוחות", tone: "attention" },
      { key: "income", label: "הכנסות החודש", value: 15579.75, note: "38 הזמנות, כולל מע״מ" },
    ],
    tasks: [
      { key: "missing", count: allOpenAds.filter((a) => a.state === "missing").length, title: "מודעות שטרם התקבלו", hint: "קבצים שהלקוח עוד לא שלח" },
      { key: "review", count: allOpenAds.filter((a) => a.state === "review").length, title: "מודעות שממתינות לאישור", hint: "התקבלו ועוד לא נבדקו" },
      { key: "unplaced", count: allOpenAds.filter((a) => a.state === "ready").length, title: "מודעות שטרם שובצו", hint: "אושרו ומחכות לעמוד" },
    ],
  };
})();
