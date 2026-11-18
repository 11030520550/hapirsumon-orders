# HANDOFF — מערכת ההזמנות של הפרסומון (hapirsumon-orders)

עדכון: 17/11/2026, במצב Commit `ff0bed5` (ראו סעיף 7: ייתכן שקומיט זה, שמוסיף את המסמך, הוא האחרון). מסמך פנימי; **אינו עולה ל-Netlify**.
נכתב לשיחת עבודה חדשה: לקרוא אותו ואת `AGENTS.md` לפני כל פעולה.

---

## 0. כללים מחייבים (לא לעקוף)

- **אין להריץ SQL, לשנות נתונים, הרשאות, RLS או פונקציות ב-Supabase** ללא אישור מפורש של בעלת הפרויקט לאותה פעולה.
- **אין לפרסם ל-Netlify** ללא אישור מפורש. אין להגדיר פרסום אוטומטי. הפרסום ידני ומתבצע ע״י בעלת הפרויקט.
- **אין לשנות עיצוב שאושר** — במיוחד מסך ההתחברות (סעיף 4).
- **בדיקות Mock אינן הוכחה שהמערכת האמיתית תקינה.** בדיווח יש להפריד תמיד בין Mock לבין בדיקה מול Supabase האמיתי / האתר החי.
- אחרי **כל** שינוי בקובץ בפרויקט: `git status` + diff → בדיקות → Commit ייעודי → Push ל-`main` → אימות סנכרון. בלי force-push. דיווח: Commit, הצלחת Push, מזהה, שינויים שלא נדחפו (פירוט ב-`AGENTS.md`).
- אין להכניס ל-Git נתוני לקוחות, גיבויים/ייצואי JSON, סודות או מפתח `service_role`/secret. חריגים מאושרים בלבד: `ARCHIVE-INDEX.md`.
- לא לבקש סיסמה או Token בצ׳אט. אין חשבון בדיקה מאושר זמין לסוכן — בדיקות אחרי התחברות דורשות את בעלת הפרויקט.
- ממשק בעברית RTL; Supabase הוא מקור הנתונים היחיד (אין fallback מקומי לנתוני לקוחות/הזמנות).

---

## 1. מטרת המערכת, ארכיטקטורה וקבצים

מערכת פנימית לעיתון "הפרסומון": לקוחות, הזמנות פרסום, גיליונות, חבילות וקרדיטים, חובות ותשלומים, דוחות.

- **אתר סטטי** HTML/CSS/JS ללא Build וללא `package.json`. Backend: **Supabase** (Postgres + Auth + RLS + RPC + Realtime).
- **מצבי פעולה ב-`app.js`:** אם סכימת העסק מותקנת (`businessSchema`) — המסכים העסקיים ב-`business-app.js` פועלים מול RPC; אחרת מצב legacy (כתיבה ישירה לטבלאות). **בייצור הסכימה העסקית מותקנת.**

| קובץ | תפקיד |
|---|---|
| `index.html` | כל המסכים (התחברות + אפליקציה), sprite של SVG (`.svg-defs`) |
| `styles.css` | כל העיצוב (גרסת cache בענף הפיתוח: `?v=20261118-1`; ב-`main`: `?v=20261117-4`) |
| `app.js` | התחברות/סשן, ניתוב מסכים (`#/...`), סנכרון Realtime + בדיקה תקופתית, לקוחות, הזמנות legacy, גיבוי/ייבוא JSON, `friendlyError`, `safeErrorDetails` |
| `business-app.js` | מסכים עסקיים מול RPC (הזמנה חדשה מרובת שורות, גיליונות, חבילות, תשלומים, מוצרים, מע״מ) |
| `business-preview.js` | תצוגה מקדימה עם נתוני דוגמה בקוד (ללא Supabase) |
| `supabase-config.js` | Project URL + מפתח **publishable** בלבד |
| `vendor/supabase-js-2.119.0.js` | ספריית Supabase מקובעת, נטענת עם SRI (sha384) מ-`index.html`; `vendor/**` מוגדר `-text` ב-`.gitattributes` כדי שה-hash לא ישתנה |
| `_headers` | כותרות אבטחה של Netlify (CSP וכו׳) — חייב להיות בשורש תיקיית הפרסום |
| `assets/login-photo.jpg`, `assets/logo-emblem.png` | תמונת מסך ההתחברות והלוגו (`logo-emblem-source.png` ו-`CREDITS.md` אינם נפרסים) |
| `supabase-*.sql` | הגירות/בדיקות — **מורצות ידנית בלבד ובאישור** (סדר: `INSTALL-BUSINESS.md`) |
| `testing/browser/` | שרת בדיקה `serve.ps1`, Supabase מדומה `mock-supabase.js`, `runner-v3.html`, `runner-client.html`, `csp-recorder.js` |
| `testing/index.html`, `test-harness.js` | כלי RPC לפרויקט Supabase נפרד (`SUPABASE-TESTING.md`) |
| מסמכים | `README.md`, `INSTALL.md`, `INSTALL-BUSINESS.md`, `SUPABASE-SETUP.md`, `SUPABASE-TESTING.md`, `UPGRADE-PLAN.md`, `ARCHIVE-INDEX.md`, `AGENTS.md` |
| `archive/`, `reference/` | גרסאות קודמות, צילומים, מחירון (באישור; ראו `ARCHIVE-INDEX.md`) |

קבצי פרסום (בדיוק 11): `_headers`, `index.html`, `styles.css`, `app.js`, `business-app.js`, `business-preview.js`, `supabase-config.js`, `assets/login-photo.jpg`, `assets/logo-emblem.png`, `vendor/supabase-js-2.119.0.js`, `vendor/LICENSE-supabase-js.txt`.

---

## 2. Supabase — חיבור, הזדהות, הרשאות ופעולות עסקיות

- **פרויקט:** `orders`, כתובת `https://sndaeogseawtwzwxiqst.supabase.co` (ציבורית, מופיעה גם ב-CSP). בקוד רק מפתח publishable; **אין** ואסור מפתח secret/`service_role`.
- **הזדהות:** אימייל + סיסמה (`signInWithPassword`), `persistSession` + `autoRefreshToken`. **הרשמה ציבורית כבויה** (אומת). אחרי התחברות נבדק `rpc("current_user_is_approved")` — רק משתמשים ברשימת `private.approved_users` נכנסים; הבדיקה חוזרת תקופתית ומנתקת משתמש שאישורו בוטל.
- **אירועי סשן** (`onAuthStateChange`): SIGNED_IN / SIGNED_OUT / USER_UPDATED; פקיעת סשן מחזירה למסך התחברות **בלי** הודעת הצלחה. הודעת "ההתנתקות בוצעה בהצלחה." מוצגת רק אחרי התנתקות יזומה (`signOutNoticePending`).
- **שגיאות:** `friendlyError` מחזיר עברית בלבד — פרטים שגויים (הודעה כללית, ללא חשיפת קיום חשבון), הגבלת קצב (429 / `over_*_rate_limit`), ושגיאה כללית לכל תקלה לא צפויה. בהתחברות, ב-console נרשם רק `safeErrorDetails` (name/code/status/message מקוצר), ללא סיסמה או טוקן.
- **הרשאות (אומת מול השרת האמיתי כ-anon, 17/11):** כל 19 הטבלאות/views מחזירות 401/42501; PATCH/DELETE/POST ל-clients/orders/payments נחסמים; 6 ה-RPC נחסמים ל-anon; GraphQL ללא שדות; Storage ללא buckets.
- **RPC שהממשק קורא (בקוד בפועל):** `current_user_is_approved`, `create_orders_batch`, `delete_business_order`, `set_obligation_paid`, `set_sheet_status`, `purchase_customer_package`, `adjust_client_credits`, `save_product_catalog_item`, `set_business_vat_rate`. קיים במסד גם `update_business_order` (עם `p_expected_updated_at`, תמיכה בסכום legacy ועדכון חוב) — **עדיין לא מחובר לממשק**.
- **כתיבות ישירות שעדיין בקוד** (`app.js`):
  - בכל מצב: עדכון/הוספת לקוח (`clients`, שורות 1245, 1255) — לא מושפע מה-Cutover.
  - **במצב עסקי, יישברו אחרי Cutover:** עריכת הזמנה ישנה דרך `#order-form` (`orders.update`, שורה 1321) וייבוא הזמנות מגיבוי JSON (`orders.insert`, שורה 1063; גם אינו יוצר חוב כספי להזמנות המיובאות).
  - מצב legacy בלבד: הוספת הזמנה (1328), מחיקה (1360), שינוי סטטוס תשלום (1395). במצב עסקי התשלום עובר דרך `set_obligation_paid`.
- **Cutover** (`supabase-business-upgrade-cutover.sql`) — **לא הורץ.** הוא מבטל הרשאות INSERT/UPDATE/DELETE ישירות על `orders` ו-INSERT על `payments` (כולל הרשאות עמודה), משאיר SELECT, בודק תנאים מקדימים ומאמת בסוף, בטרנזקציה. החזרה לאחור: `grant` מחדש (מוכן בתוכנית, לא הורץ). `supabase-business-upgrade-verify.sql` — קריאה בלבד.

---

## 3. מצב נוכחי — מה בוצע ואושר

- ניווט מסכים, איפוס חיפושים, ממשק עסקי מול RPC, גיליונות, מספרי הזמנה בני 5 ספרות, תיקון קידוד עברית בקוד — בוצעו בשלבים קודמים.
- **סכימת העסק מותקנת בייצור** וטבלת `sheets` קיימת (נצפה). מצב ההרצה המדויק של שאר קובצי ה-SQL (תיקון עברית, מספור מחדש) **לא ידוע מתוך ה-Repository** — לבדוק (באישור) עם `supabase-business-upgrade-preflight-summary.sql`.
- **מסך התחברות חדש אושר** (קומיטים 12505d0 → 704a80a) ופורסם בעבר בהצלחה.
- **תיקוני אבטחה** (cb03581 + תיעוד 98bb1e0): הודעת התנתקות קבועה, הודעות שגיאה בטוחות, supabase-js 2.119.0 מקומי עם SRI, `_headers` עם CSP / X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy. לצורך ה-CSP הועבר ה-style היחיד מ-HTML ל-`.svg-defs` ב-CSS (ללא שינוי חזותי); אין סקריפטים inline, אין `unsafe-inline`.
- **ff0bed5:** README — לגרור את התיקייה עצמה ולא ZIP של `Compress-Archive` (ראו סעיף 8).
- **תוכנית (ניתוח בלבד, לא בוצעה)** לשתי הפעולות התלויות בכתיבה ישירה:
  1. עריכת הזמנה ישנה → להעביר ל-`update_business_order` (שינוי קוד בלבד, ללא SQL). להחליט אם הזמנה ישנה נשארת "סכום בלבד" (מומלץ).
  2. ייבוא הזמנות מ-JSON → מומלץ RPC חדש אטומי (לקוחות + הזמנות legacy + חובות, הוספה בלבד) — דורש הגירה באישור; חלופה זמנית: לחסום ייבוא הזמנות אחרי Cutover ולהשאיר ייבוא לקוחות.
  סדר: קוד + בדיקות → פרסום באישור → Cutover בחלון ללא עריכות (גיבוי לפני, verify אחרי) → בדיקה ידנית חיה → RPC ייבוא.

---

## 4. החלטות עיצוב מחייבות — מסך ההתחברות (אסור לשנות)

- פריסה מפוצלת: תמונה (`assets/login-photo.jpg`) בצד שמאל במחשב, מוצגת **במלואה** (`.auth-photo`) על רקע מטושטש של אותה תמונה (`.auth-photo-ambient`); בטלפון התמונה למעלה (390×150 ב-390px) והרקע המטושטש מוסתר. אין לשנות מיקום, גודל או חיתוך.
- צד ימין: לוגו עגול `assets/logo-emblem.png` (`.auth-mark`, 56px; 48px בטלפון), שם "הפרסומון", סלוגן **"ניהול חכם. פרסום מדויק."**, כותרת **"ברוכים השבים"**, טקסט **"הכניסה למערכת מיועדת לחשבונות שהוזמנו ואושרו מראש."**
- טופס בתוך מסגרת **ריבועית**: `.auth-body` עם `border: 1px solid #23272A`, `border-radius: 0`, רקע `#FFFDF8`, רוחב `min(480px, 100%)`; שדות, כפתור, הודעות ומתג העין — כולם `radius 0`. אין קו נחושת ואין `h1::before`.
- מתג עין לסיסמה (`#password-toggle`): שומר פוקוס ומיקום סמן, `aria-label` "הצגת הסיסמה" / "הסתרת הסיסמה".
- עיצוב autofill והודעות סטטוס (info/error/success) כפי שהם בקוד.
- אין תווית BETA בממשק. שאר הממשק: עברית RTL כפי שקיים.
- צילומי השוואה אחרונים: מחשב/נייד/טאבלט זהים פיקסל לפיקסל לגרסה המאושרת; טלפון — 0 פיקסלים שונים (הפרש של 73 פיקסלים מופיע גם בין שתי צילומים של אותה גרסה = אי-דטרמיניזם של הצילום).

---

## 5. תוצאות בדיקות (17/11/2026)

**Mock (Supabase מדומה, ללא רשת) — אינו מוכיח תקינות המערכת האמיתית:**
- `runner-v3.html`: **82/82 עברו**, תחת ה-CSP של `_headers`, גם מהריפו וגם מתיקיית הפרסום לבדה. כולל A12–A17 (הגבלת קצב, שגיאה כללית, אין סיסמה ב-console, הודעת התנתקות נשארת/מוחלפת, פקיעת סשן), C1–C3 (אפס חסימות CSP, כותרות בדף `/`, סקריפט vendor עם SRI).
- `runner-client.html`: נכשל ב-17/11 (חיפש את כפתור התצוגה המקדימה שהוסר). **תוקן בענף `feature/sheets-module`** — ראו סעיף 9א.

**מול Supabase האמיתי (ללא חשבון; ניסיון התחברות שגוי אחד בלבד עם כתובת `example.invalid`):**
- דף ההתחברות האמיתי עם הספרייה המקומית תחת CSP: R1–R4, R5b–R10 עברו — הספרייה נטענת עם SRI, אפס חסימות CSP, לחיצה משולשת = בקשה אחת, הודעה כללית, אין טוקן/סיסמה באחסון או ב-console.
- R5a (מצב "שולח" של הכפתור) — לא ניתן למדידה בבדיקה מול השרת האמיתי (virtual time); נבדק רק ב-Mock (A4).
- תמונות (מתיקיית הפרסום, תחת CSP): מחשב 1440px ו-טלפון 390px — הלוגו והתמונה נטענים (200), אפס חסימות CSP.
- בדיקת הרשאות anon — ראו סעיף 2.

**לא נבדק מול המערכת האמיתית** (דורש חשבון מאושר — בעלת הפרויקט): מסכים אחרי התחברות, Realtime (`wss`) תחת ה-CSP, כתיבה/עריכה, התנתקות אמיתית.

הרצה: `powershell -ExecutionPolicy Bypass -File testing\browser\serve.ps1 -HeadersFile _headers` ואז Chrome headless על `http://127.0.0.1:8000/__test/runner-v3.html` (פקודה מלאה ב-`INSTALL.md`). `-Root <תיקייה>` מאפשר להריץ מול תיקיית הפרסום.

---

## 6. בעיות ידועות, סיכונים ונושאים פתוחים

- **האתר החי שבור כרגע** (סעיף 8): התמונות מחזירות 404 ותיקוני האבטחה אינם באוויר.
- **Cutover לא בוצע:** משתמש מחובר ומאושר עדיין יכול לכתוב ישירות ל-`orders`/`payments` (RLS מגביל למשתמשים מאושרים בלבד, אך עוקף את חוקי ה-RPC). דורש קודם את שני תיקוני הקוד שבסעיף 3.
- ייבוא JSON של הזמנות אינו יוצר חובות כספיים (פער קיים גם היום).
- `console.error` בפעולות שאינן התחברות (שמירת לקוח/הזמנה, ייבוא) עדיין רושם את אובייקט השגיאה המלא של Supabase (ללא סיסמאות; ייתכנו פרטי רשומה טכניים).
- Realtime תחת ה-CSP לא נבדק בפועל (`connect-src` כולל `wss://` של הפרויקט).
- `runner-client.html` נכשל (בדיקה מיושנת).
- בסביבת המחשב הזה מסנן "אתרוג" מזריק `/jsQuilting/server/etAddOn.js` לדפים — בעיית רשת מקומית, לא של האתר; עלול להופיע כחסימת CSP בדפדפן המקומי.
- מספרי השורות בסעיף 2 נכונים ל-`ff0bed5`; לאמת מחדש לפני שינוי.

---

## 7. GitHub

- Repository פרטי: `https://github.com/11030520550/hapirsumon-orders`, ענף `main`, remote `origin`.
- **Commit אחרון לפני מסמך זה: `ff0bed5`**; מסונכרן עם `origin/main`, ללא שינויים מקומיים. מסמך זה נשמר בקומיט נפרד מיד אחריו — לבדוק `git log -1`.
- רצף אחרון: `704a80a` (מסך התחברות מאושר) → `26d9481` (כתובת Netlify) → `cb03581` (אבטחה) → `98bb1e0` (תיעוד) → `ff0bed5` (אזהרת ZIP).

---

## 8. Netlify

- אתר: **hapirsumon-orders** — https://hapirsumon-orders.netlify.app/ (השם "cute-macaron-aede92" שגוי). פרסום ידני דרך Deploys, באישור בלבד.
- **מצב חי (נבדק 17/11/2026):** מוגש תוכן הגרסה הקודמת (704a80a, ספרייה מ-CDN `@2`, ללא `_headers` → אין CSP, רק HSTS של Netlify).
  - **סיבת התמונות השבורות:** הועלה `orders-netlify-ready-2026-11-17.zip` שנוצר ב-`Compress-Archive` של PowerShell 5.1, שנתיביו עם `\`. Netlify יצר קבצים בשם `assets\login-photo.jpg` בשורש, ולכן `/assets/login-photo.jpg` ו-`/assets/logo-emblem.png` מחזירים 404. הקוד וה-CSP תקינים.
  - ה-ZIP השבור שונה שמו ל-`orders-netlify-ready-2026-11-17-BROKEN-do-not-upload.zip` (שולחן העבודה).

## 9. תיקיית הפרסום הממתינה

- **`C:\Users\USER\Desktop\orders-netlify-ready-2026-11-17-images-fix`** — 11 הקבצים מסעיף 1, נבנתה ב-`git archive` מ-`ff0bed5`, `_headers` בשורש, SRI תואם, זהה בייט לבייט לתיקייה שנבדקה. ZIP תקין (נתיבים עם `/`): `...-images-fix.zip`.
- העלאה: Netlify → hapirsumon-orders → Deploys → **לגרור את התיקייה עצמה**.
- אחרי הפרסום לבדוק: `/assets/login-photo.jpg`, `/assets/logo-emblem.png`, `/vendor/supabase-js-2.119.0.js` → 200; כותרות CSP / X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy בדף `/`; אין שגיאות CSP; התחברות והתנתקות (בעלת הפרויקט).
- תיקיות ישנות בשולחן העבודה (`orders-netlify-ready`, `orders-netlify-ready-2026-11-17`, `...-security`) — לא להעלות.

---

## 9א. פיתוח מודול גיליונות וקובצי מודעות — ענף `feature/sheets-module`

**העבודה על המודול מתבצעת בענף `feature/sheets-module` ולא ב-`main`** (הנחיית בעלת הפרויקט, 18/11/2026). כל שלב יציב נשמר ב-Commit ו-Push לענף זה. אין Merge ל-`main`, אין Deploy, ואין פעולה על Supabase האמיתי ללא אישור מפורש.

המשך עבודה מהמחשב השני:
```powershell
git fetch origin
git switch feature/sheets-module      # בפעם הראשונה: git switch -c feature/sheets-module --track origin/feature/sheets-module
git pull --ff-only
```

תוכנית השלבים (מאושרת לפיתוח מקומי): 1 סביבה ו-Git · 2 תשתית ממשק · 3 מודל גיליונות + קובצי Migration/Verify/Rollback (ללא הרצה) · 4 Mock ובדיקות · 5 רשימת גיליונות + הוספת גיליונות · 6 בחירת גיליון בהזמנה · 7 גיליון בודד · 8 עריכת הזמנה ושינוי גיליון · 9 סגירה ואכיפה בסביבת בדיקות מאושרת · 10–13 קובצי מודעות, מודעה קבועה, גיבוי ו-ZIP · 14 פרסום במספר גיליונות · 15 אינטגרציה ופרסום מבוקר.

### שלב 2 — תשתית ממשק (בוצע)
- **כשל רענון גלוי:** `reportSyncIssue(source, message)` ב-`app.js` — שורת המצב בתפריט הצד הופכת לאדומה ("שגיאת סנכרון — חלק מהנתונים לא עודכנו") עד שהרענון מצליח; הודעה קופצת פעם אחת בלבד לכל תקלה. `business-app.js` מדווח על כשל בטעינה הראשונית, ברענון ברקע וברענון אחרי שמירה.
- **חלון אישור של המערכת** (`ModaatApp.ask`, `#app-confirm-modal`) במקום `window.confirm` / `window.prompt`: סגירה ופתיחה מחדש של גיליון (סיבה ≥ 3 תווים), ביטול סימון תשלום (סיבה חובה), מחיקת הזמנה (כפתור אדום; המיקוד מתחיל על "ביטול").
- **מצבי טעינה:** רשימת הגיליונות ודף הגיליון מציגים "טוען נתונים…" (או הודעת כשל) עד שהסטטוסים נטענו, במקום "אין גיליונות" או "פתוח" משוער.
- **בדיקות:** `runner-v3.html` 93/93 (נוספו I1–I11; R12–R16 עודכנו לחלון החדש). `runner-client.html` 26/26 — תוקן דרך דף בדיקה `/__test/app-preview.html` ב-`serve.ps1` שמוסיף כפתור כניסה נסתר לתצוגה המקדימה (מסך ההתחברות עצמו לא שונה). ב-Mock: `failTable(table)` ו-`?bizdelay=ms`.
- **מסך ההתחברות:** השוואת פיקסלים מול `main` — 0 פיקסלים שונים ב-1440, 1024 ו-390.
- **צילומי טלפון:** Chrome headless לא מצייר מתחת ל-~500px רוחב; לצילום 390px יש לטעון את האפליקציה בתוך iframe ברוחב 390 בחלון רחב יותר.

### שלב 3 — מודל גיליונות: קובצי SQL (נכתבו; **לא הורצו**)
החלטות בעלת הפרויקט (18/11): גיליונות היסטוריים נוצרים **סגורים**, בלי תאריך פרסום (לא ממציאים תאריך); לפני כל שינוי אמיתי מזהים בנפרד את הגיליון הפעיל; מספר גיליון חדש — ספרות בלבד, חיובי, בלי אפס מוביל; פתיחה מחדש — סיבה + מועד סגירה חדש בעתיד (ברירת מחדל בממשק: +שעתיים).
- `supabase-sheets-v2-preflight.sql` (קריאה) · `supabase-sheets-v2.sql` (שלב A) · `supabase-sheets-v2-verify.sql` (קריאה) · `supabase-sheets-v2-enforce.sql` (שלב B) · `supabase-sheets-v2-rollback.sql`. סדר והסבר: `INSTALL-BUSINESS.md` סעיף 4ב.
- מצב אפקטיבי: סגור אם `status='closed'` או `closes_at <= now()` — בלי משימה מתוזמנת. View `sheet_overview` (security_invoker) מחזיר `is_closed` ו-`server_now`.
- RPC: `create_sheets_batch` (הכול או כלום, מפתח חד-פעמי, בדיקת פורמט, אין דריסה, טיפול ביצירה מקבילה), `update_sheet_details` (לא מאפשר "לפתוח" גיליון שנסגר במועד ע"י הזזת המועד), `set_sheet_state` (סגירה / פתיחה מחדש), `set_sheet_status` הישנה מפנה אליה (תאימות לממשק הנוכחי).
- שלב B: מפתח זר `orders.sheet_number → sheets` + טריגר `orders_enforce_open_sheet` (נעילת FOR SHARE, קוד שגיאה `HPS01`). נעצר אם יש מספרי גיליון עם רווחים או בלי שורת גיליון.
- **לא נבדקו מול Postgres**: אין מסד מקומי. הבדיקה הראשונה תהיה בפרויקט הבדיקות הנפרד (`SUPABASE-TESTING.md`) — באישור.

### שלב 4 — Mock של מודל v2 ובדיקות חוזה (בוצע)
- `mock-supabase.js`: `?sheets=2` = מודל v2 (גיליון היסטורי 124 סגור בלי תאריך; גיליונות מתוכננים 125–128 בארבעת ימי ראשון הבאים, סגירה בשישי 00:00 שעון ישראל); `sheet_overview`; `create_sheets_batch`, `update_sheet_details`, `set_sheet_state`, `set_sheet_status` לפי אותם כללים כמו ה-SQL. `?enforce=1` = שלב B (דחיית הזמנה לגיליון סגור / לא קיים; כל האצווה נדחית). שעון שרת ניתן להזזה: `__mock.setNow(iso)`, `__mock.advance(ms)`; המרת שעון ישראל: `__mock.jerusalemTime(local)`.
- `runner-v3.html`: V1–V20 (סגירה במועד, שעון חורף/קיץ ויום המעבר, יצירה אטומית ובלי כפילויות, לחיצה כפולה, פורמט מספר, סגירה ידנית, פתיחה מחדש עם סיבה ומועד עתידי, אי-אפשרות "לפתוח" ע"י הזזת מועד, גרסה ישנה, אכיפה, תאימות לממשק הנוכחי). סה"כ 113/113, שלוש הרצות רצופות; `runner-client.html` 26/26. `answerDialog` ממתין לחלון בסקירה (נמנעה תלות בתזמון).
- המשמעות: ה-Mock הוא החוזה שעליו נבנה הממשק בשלבים 5–8. התאמתו ל-SQL האמיתי תיבדק רק בפרויקט הבדיקות (באישור).

## 10. משימות להמשך (לפי עדיפות)

1. **[ממתין לבעלת הפרויקט]** פרסום התיקייה `orders-netlify-ready-2026-11-17-images-fix`, ואז אימות חי (סעיף 9) כולל בדיקה מחוברת ו-Realtime.
2. ~~תיקון `runner-client.html`~~ — בוצע בענף `feature/sheets-module` (סעיף 9א). מודול הגיליונות: לפי תוכנית השלבים בסעיף 9א.
3. עריכת הזמנה ישנה דרך `update_business_order` (קוד בלבד, + בדיקות Mock) — לפי התוכנית בסעיף 3.
4. חסימת ייבוא הזמנות (או חלופה) לקראת Cutover; ייבוא לקוחות נשאר.
5. **[דורש אישור SQL]** בדיקת מצב ההגירות ב-`orders` עם `supabase-business-upgrade-preflight-summary.sql`; לפי הצורך תיקון עברית / מספור.
6. **[דורש אישור]** Cutover בחלון ללא עריכות: גיבוי → cutover → verify → בדיקה ידנית.
7. **[דורש אישור SQL]** RPC ייבוא אטומי (לקוחות + הזמנות + חובות).
8. צמצום פרטי שגיאה ב-`console.error` גם בפעולות שאינן התחברות (`safeErrorDetails`).
9. קטלוג מוצרים אמיתי מהמחירון שב-`reference/` (דורש אימות מחירים מול בעלת הפרויקט).
