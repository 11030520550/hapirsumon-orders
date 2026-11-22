# בדיקות SQL מול PostgreSQL אמיתי (PGlite, מבודד, בזיכרון)

`pg-runner.html` מריץ את קובצי ה-SQL של הפרויקט על PostgreSQL אמיתי. זו PGlite: גרסת PostgreSQL 18 שמהודרת ל-WebAssembly.

**מה זה בפועל:**
- הבדיקה רצה בתוך Chrome, בזיכרון בלבד. אין חיבור לרשת ול-Supabase.
- כל הנתונים מזויפים.
- **אין לזה שום קשר ל-PRODUCTION.**

## הקמה, פעם אחת בכל מחשב
1. מורידים את החבילה `@electric-sql/pglite` מ-npm. בגרסה שנבדקה (0.5.17) נבדקה גם החתימה (integrity) של הקובץ מול npm.
2. מחלצים אותה לתיקייה `testing/postgres/package/`. התוצאה הנדרשת היא שהקובץ `testing/postgres/package/dist/index.js` קיים.
3. התיקייה מוחרגת מ-Git ב-`.gitignore`.

```powershell
$meta = Invoke-RestMethod https://registry.npmjs.org/@electric-sql/pglite/latest
Invoke-WebRequest -UseBasicParsing $meta.dist.tarball -OutFile $env:TEMP\pglite.tgz
tar -xzf $env:TEMP\pglite.tgz -C testing\postgres
```

## הרצה
```powershell
powershell -ExecutionPolicy Bypass -File testing\postgres\serve-pg.ps1 -Root . -TestDir testing\postgres -Port 8007
```

אחר כך פותחים ב-Chrome את `http://127.0.0.1:8007/__test/pg-runner.html`.

`serve-pg.ps1` הוא העתק של `testing/browser/serve.ps1`. ההבדל היחיד: הוא מגיש גם קבצים מסוג `.wasm`, `.data` ו-`.sql`.

## מה הקובץ בודק
1. **התקנה כמו בייצור.** מתקין את הקבצים לפי הסדר: schema ← reliability ← business-upgrade ← sheets-and-order-numbers.
2. **נתונים שמשקפים את הייצור,** כפי שעלה מבדיקת הקריאה:
   - 8 הזמנות, ממוספרות 1–8: שבע מסוג legacy ואחת בקרדיטים.
   - המונה עומד על 21999.
   - חבילה אחת עם 12 תשלומים.
3. **מודל v3.** מתקין את `supabase-orders-v3.sql` ואת `-verify`, ומתקין שוב כדי לבדוק שהתקנה כפולה לא מזיקה.
4. **תרחישים עסקיים,** כמשתמשת מאושרת: הזמנה כספית, הזמנה בקרדיטים, תשלום חלקי, ביטול, עריכה ולוח תשלומים.
5. **הרשאות:** משתמש שאינו מאושר, משתמש anon, ומצב לפני ה-cutover ואחריו.
6. **חזרה לאחור:** מנגנון ההגנה של קובץ ה-rollback.
7. **מודל הגיליונות v2.**
8. **התאמה לממשק:** כל קריאה ל-RPC ממשק המשתמש תואמת לפונקציה במסד ולשמות הפרמטרים שלה, וכל עמודה שהממשק קורא קיימת במסד.
