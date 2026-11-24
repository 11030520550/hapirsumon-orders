# נכסי תמונה — V4 Editorial Blue & Honey

## מה כבר משולב
- **מסך ההתחברות:** `assets/login-photo.jpg`. התמונה בבעלות הפרויקט: כורסה, עיתון "הפרסומון" ואור חם. הגוונים החמים שלה מתאימים לדבש ולאגוז.
- **סמל הלוגו:** `assets/logo-emblem.png`, בבעלות הפרויקט. מופיע עכשיו גם בתפריט הצד.
- **גופנים מקומיים:**
  - Heebo ו-Frank Ruhl Libre נמצאים ב-`assets/fonts/`, ברישיון SIL Open Font License. קובצי הרישיון שמורים לצידם.
  - אין יותר תלות ב-Google Fonts.

## מה חסר, ולמה
לכל מסך מרכזי יש מקום לתמונה (`.page-photo`):
- **רצועה קומפקטית בכותרת המסך.**
- **במסך הבית:** חלק מאזור הפתיחה.

**איך המקום נראה כרגע:** לוחית מערכתית בכחול עמוק, עם השם "הפרסומון" בין שני קווי דבש. זה עיצוב גמור, לא שטח ריק.

**למה אין עדיין תמונות:** בסבב הזה לא היה כלי ליצירת תמונות ולא מקור תמונות מורשה. 21 תמונות הרפרנס ב-`design-references/` הן **ללא רישיון ידוע**, ולכן לא שולבו.

## איך מוסיפים תמונה (בלי שינוי קוד)
1. שומרים את הקובץ ב-`assets/photos/`, בשם מהטבלה. הפורמט: WebP, באיכות 80–85.
2. רושמים את המקור ואת הרישיון ב-`assets/CREDITS.md`.
3. ב-`assets/photos/photos.css` מסירים את סימני ההערה מהשורה של אותו מסך.

**הפריסה לא משתנה:** המקום שמור בגודל קבוע, ולכן אין קפיצה של התוכן. התמונה מוצגת ב-`cover`, מעל הלוחית.

## השפה הצילומית (לכל הסדרה)
Analog film photography, natural cinematic light, soft golden morning sun, palette of smoky deep blue (#233E50, #54788E), honey and caramel (#C18B49), walnut wood (#795239), warm ivory paper (#F8F5EF), natural shallow depth of field, soft shadows, authentic textures (paper grain, wood grain, linen), calm, creative and professional, no people, no screens, no logos, no text, no brand marks, not glossy, not stock-photo, no AI sheen, subtle Kodak Portra 400 grain.

## התמונות הדרושות

| קובץ | מסך | גודל לייצוא (יחס) | נקודת חיתוך |
|---|---|---|---|
| `home.webp` | מסך הבית, אזור הפתיחה (צד שמאל) | 1200×900 (4:3) | מרכז; הנושא בשליש הימני |
| `orders.webp` | הזמנות, רצועת כותרת | 1200×300 (4:1) | מרכז אופקי |
| `clients.webp` | לקוחות | 1200×300 (4:1) | מרכז |
| `client.webp` | תיק לקוח (פרט קטן) | 800×300 (8:3) | מרכז |
| `sheets.webp` | גיליונות | 1200×260 (≈4.6:1) | מרכז |
| `packages.webp` | חבילות | 1200×300 (4:1) | מרכז |
| `payments.webp` | גבייה | 1200×300 (4:1) | מרכז |
| `reports.webp` | דוחות | 1200×300 (4:1) | מרכז |
| `settings.webp` | הגדרות | 1200×300 (4:1) | מרכז |
| `login-photo.jpg` (החלפה אופציונלית) | התחברות | 1536×1024 (3:2) | מרכז-שמאל |

**משקל רצוי:** עד כ-180KB לרצועה ועד כ-350KB לתמונת הבית.

### פרומפטים (באנגלית, לכלי יצירה או לצלם)
Every prompt below ends with the shared style paragraph above.

- **home.webp** — "A sunlit editor's desk at the start of the working day: a folded newspaper on warm walnut wood, a ceramic cup of black coffee with a thin trail of steam, a few sheets of ivory paper, a sprig of dried pale flowers in a small glass, low golden window light from the left raking across the paper, deep smoky-blue wall softly out of focus in the background. Wide composition with calm negative space on the left half. 4:3."
- **orders.webp** — "Close, low-angle still life on a walnut desk: a deep blue cloth-bound notebook lying open with neat handwritten lines (illegible), a fine brass-and-black fountain pen across it, a small stack of order slips on ivory paper, soft golden side light, shallow depth of field. Very wide panoramic strip 4:1, subject in the centre, quiet edges."
- **clients.webp** — "Ivory envelopes and cream index cards fanned on dark walnut wood, a brass letter opener, a small bundle of dried lavender tied with linen thread, warm afternoon light, gentle shadows, personal and professional mood. Panoramic 4:1."
- **client.webp** — "Macro detail: a cream business card resting on the corner of a deep blue leather folder, a brass paper clip, a single dried flower stem, honey-coloured light. 8:3, centred."
- **sheets.webp** — "Freshly printed broadsheet newspapers folded and stacked on a wooden press table, printer's proofs with registration marks, a metal type composing stick, soft window light, ink and paper texture, production atmosphere. Very wide strip, newspapers in the centre. No readable headlines."
- **packages.webp** — "Neatly arranged planning materials: honey-coloured hardcover notebook, two deep blue document folders tied with cotton string, a calendar page (no readable dates), a pencil, on walnut, warm morning light. Panoramic 4:1."
- **payments.webp** — "A vintage account ledger open on a walnut desk, columns ruled in faded blue ink (illegible figures), a brass fountain pen, a few receipts on ivory paper, a small honey-amber glass paperweight, warm soft light, editorial and calm, nothing that looks like cash or a bank card. Panoramic 4:1."
- **reports.webp** — "Printed reports and typeset proof sheets overlapping on a desk, a magnifying loupe on the paper, a deep blue notebook, a typographic detail of large serif letters out of focus, golden side light, analytical and precise. Panoramic 4:1."
- **settings.webp** — "Minimal, orderly workspace: a precise brass ruler, a mechanical pencil and a fine pen aligned on ivory paper over walnut, a lot of quiet space, soft even daylight. Panoramic 4:1."
- **login-photo.jpg (replacement, optional)** — "Cinematic analog photograph of a small publishing studio corner: a walnut desk with an open newspaper, a deep blue notebook, a cup of coffee, a vase of dried flowers, tall window with warm golden sunlight and soft smoky-blue shadows, inviting and premium. 3:2."

## רישיון
כל תמונה שתיכנס חייבת לעמוד באחד משני התנאים:
- רישיון שמתיר שימוש מסחרי.
- יצירה עצמית, או יצירה בכלי שמעניק זכויות שימוש מסחרי.

המקור והרישיון נרשמים ב-`assets/CREDITS.md` לפני שמסירים את סימני ההערה מהשורה ב-`photos.css`.
