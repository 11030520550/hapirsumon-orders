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

## חומרים שלא נשמרו ב-GitHub (בכוונה)

| חומר | מיקום במחשב המקורי | סיבה | מה עושים |
|---|---|---|---|
| מחירון וחבילות של העיתון (`reference/`, PDF+PNG) | `orders/reference/` (ועותק זהה ב-`backup-business-upgrade-2026-11-10-1632/reference/`) | חומר עסקי של העיתון — צד שלישי. לא הועלה ללא אישור. | להעביר ידנית רק אם יש אישור; נדרש לבניית קטלוג המוצרים. |
| גיבויי JSON של לקוחות/הזמנות | `Desktop/modaat-*-backup-2026-11-11.json` | ייצוא נתונים; לא ניתן לוודא שכולם פיקטיביים; כללי הפרויקט אוסרים העלאה. | להחליט ידנית. הנתונים החיים נמצאים ב-Supabase. |

## כללי עבודה

ראו `AGENTS.md`: Commit+Push אחרי כל שינוי, ללא סודות/נתוני לקוחות, ללא הרצת SQL או פרסום ללא אישור.
