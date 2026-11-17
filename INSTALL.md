# דרישות סביבת עבודה — מערכת ההזמנות של הפרסומון

אין שלב Build ואין חבילות להתקנה (אין `package.json` / `node_modules`). האתר הוא HTML/CSS/JavaScript סטטי שטוען את ספריית Supabase מ-CDN.

## תוכנות נדרשות

| תוכנה | למה | הערות |
|---|---|---|
| Git for Windows | Clone, Commit, Push | כולל Git Credential Manager להתחברות ל-GitHub. אין להדביק סיסמה/Token בקבצים. |
| דפדפן עדכני (Chrome מומלץ) | הרצת האתר ובדיקות הדפדפן | בדיקות ה-headless משתמשות ב-`chrome.exe`. |
| Windows PowerShell 5.1 (מובנה ב-Windows) | שרת מקומי `testing/browser/serve.ps1` | לחלופין: `python -m http.server 8000` אם Python מותקן. |
| Visual Studio Code | עריכה | לא חובה. |

לא נדרשים Node.js, Python, Docker או PostgreSQL מקומי.

## שירותים חיצוניים (לא נשמרים ב-Repository)

| שירות | מה צריך | הערות |
|---|---|---|
| GitHub | גישה ל-`11030520550/hapirsumon-orders` (פרטי) | |
| Supabase | גישה לפרויקט **orders** בלוח הבקרה | הנתונים, המשתמשים המאושרים והסכימה החיה נמצאים שם בלבד. כתובת הפרויקט והמפתח הציבורי (publishable) נמצאים ב-`supabase-config.js`; מפתח סודי לא נדרש ואסור בקוד. |
| Netlify | גישה לאתר `hapirsumon-orders` (\u200Fhttps://hapirsumon-orders.netlify.app/) | פרסום ידני בלבד, באישור. |

## הגדרות מקומיות שאינן ב-Git (ליצור מחדש רק אם נדרש)

- `testing/supabase-test-config.json` — רק לכלי הבדיקה של פרויקט Supabase נפרד (`SUPABASE-TESTING.md`). להעתיק מ-`testing/supabase-test-config.example.json` ולמלא מפתח publishable של פרויקט בדיקה בלבד.
- אין צורך ליצור מחדש את `reference/` — המחירון ותמונת החבילות נשמרים ב-Repository.

## הרצה מקומית

```powershell
powershell -ExecutionPolicy Bypass -File testing\browser\serve.ps1
```

- `http://127.0.0.1:8000` — האתר האמיתי (מתחבר ל-Supabase; נדרש משתמש מאושר).
- `http://127.0.0.1:8000/__test/runner-v3.html` — בדיקות דפדפן אוטומטיות מול Supabase מדומה (ללא רשת). התוצאה מוצגת בראש הדף (`RESULT OK`).
- `http://127.0.0.1:8000/__test/runner-client.html` — בדיקות התצוגה המקדימה.

הרצת הבדיקות ב-Chrome ללא חלון (PowerShell):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --user-data-dir="$env:TEMP\modaat-test-profile" --virtual-time-budget=180000 --dump-dom "http://127.0.0.1:8000/__test/runner-v3.html"
```

## הגדרות Git מומלצות

- `core.autocrlf=true` (ברירת המחדל של Git for Windows) — הקבצים נשמרים ב-Repository עם LF ומקומית עם CRLF.
- אין Git LFS, Submodules או Tags בפרויקט זה.
