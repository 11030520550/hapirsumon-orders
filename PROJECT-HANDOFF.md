# מצב הפרויקט והמשך פיתוח — מערכת ההזמנות של הפרסומון

עדכון: 12/11/2026. מסמך פנימי; אינו עולה ל-Netlify.

## מה קיים בקוד (מגובה במלואו ב-GitHub)

- **ממשק:** `index.html`, `styles.css`, `app.js` (התחברות, סנכרון, ניתוב מסכים, מצב legacy), `business-app.js` (מסכים עסקיים מול RPC), `business-preview.js` (תצוגה מקדימה עם נתוני דוגמה).
- **מסכים:** לוח בקרה · הזמנות (כולל "הזמנה חדשה" מרובת שורות) · גיליונות · לקוחות ותיק לקוח · חבילות וקרדיטים · תשלומים וחובות · דוחות · הגדרות ומוצרים.
- **SQL (לא הורץ ע"י הקוד; מריצים ידנית ב-SQL Editor באישור):** סכימה בסיסית, Reliability, Business upgrade + preflight/verify/cutover, גיליונות ומספרי הזמנה, תיקון עברית (preview/fix), גיבוי snapshot, מוצר הדגמה. סדר הפעלה: `INSTALL-BUSINESS.md`.
- **בדיקות:** `testing/browser/` (Supabase מדומה + ~90 בדיקות דפדפן), `testing/` (כלי RPC לפרויקט Supabase נפרד).

## מה לא ידוע מתוך ה-Repository

- אילו קובצי SQL כבר הורצו בפרויקט Supabase **orders** (הורצה לפחות `supabase-business-upgrade.sql` בניסיון אחד שנכשל ותוקן; יש לבדוק עם `supabase-business-upgrade-preflight-summary.sql`).
- איזו גרסה מפורסמת כרגע ב-Netlify.

## משימות פתוחות

1. להריץ (באישור) את `supabase-sheets-and-order-numbers.sql`, ולפי הצורך את `supabase-renumber-short-order-numbers.sql`.
2. להריץ `supabase-hebrew-encoding-preview.sql`, לבדוק, ואז (באישור) `supabase-hebrew-encoding-fix.sql`.
3. עריכת הזמנות עסקיות (RPC `update_business_order`) — עדיין לא מחוברת לממשק.
4. בדיקה מול Supabase אמיתי, ואז פרסום ידני ל-Netlify ו-cutover.
5. קטלוג מוצרים אמיתי — דורש מחירון קריא (ראו להלן).

## חומרים נוספים ב-Repository

- `reference/` — מחירון וחבילות (מקור לקטלוג המוצרים).
- `archive/data-exports-2026-11-11/` — שני גיבויי JSON (נתוני דמה) מ-11/11/2026.

שניהם נשמרו באישור מפורש של בעלת הפרויקט (12/11/2026). פירוט: `ARCHIVE-INDEX.md`. הנתונים החיים עדיין נמצאים ב-Supabase בלבד.

## כללי עבודה

ראו `AGENTS.md`: Commit+Push אחרי כל שינוי, ללא סודות/נתוני לקוחות, ללא הרצת SQL או פרסום ללא אישור.
