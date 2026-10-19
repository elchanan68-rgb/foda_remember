# סבתא פודה — משפחת סמינה

אלבום זיכרונות משפחתי בעברית. האתר פועל במצב מקומי עד שמגדירים Supabase; לאחר ההגדרה, סיפורים ותמונות משותפים לכל בני המשפחה, וסיפורים חדשים ממתינים לאישור לפני פרסום.

## מה כבר מוכן

- מסד נתונים לסיפורים וסטטוס אישור (`pending`, `approved`, `rejected`).
- Edge Function שמקבלת סיפורים ותמונות, בודקת את הקלט, מאמתת Cloudflare Turnstile, ומגבילה שליחות לפי כתובת IP מגובבת.
- תמונות נשמרות ב־Storage פרטי. האתר מקבל קישורי צפייה זמניים רק לתמונות של סיפורים מאושרים.
- אין מפתח Supabase סודי, `service_role` או Turnstile secret בקוד הדפדפן.
- כל עוד לא הוגדר endpoint, האתר ממשיך לשמור זיכרונות מקומית בדפדפן הנוכחי בלבד.

## חיבור הפרויקט ל־Supabase

1. יוצרים פרויקט Supabase וחשבון Cloudflare Turnstile, ומגדירים ב־Turnstile את הדומיין שבו האתר יתארח.
2. מתקינים את Supabase CLI, נכנסים לחשבון ומקשרים את התיקייה לפרויקט:

   ```sh
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   npx supabase functions deploy family-memories
   ```

   קובץ `supabase/config.toml` מגדיר את פונקציית השליחה כ־public כדי שנכדים יוכלו לשלוח בלי חשבון. לכן ה־POST דורש Turnstile, אימות שרת, הגבלת קצב ואישור ידני לפני הצגת תוכן.

3. ב־Supabase Dashboard פותחים **Edge Functions → Secrets** ומגדירים:

   - `TURNSTILE_SECRET_KEY` — המפתח הסודי של Turnstile.
   - `ALLOWED_ORIGINS` — כתובות מלאות ומדויקות, מופרדות בפסיקים, למשל `https://family.example`.

   Supabase מספקת לפונקציה את `SUPABASE_URL` ואת מפתח השרת שלה בסביבת הריצה. אין להעתיק את מפתח השרת לקובץ אתר, ל־`public-config.js`, או למאגר Git.

4. מעדכנים ב־`public-config.js` את `apiUrl` לכתובת הפונקציה, למשל `https://YOUR_PROJECT_REF.supabase.co/functions/v1/family-memories`, ואת `turnstileSiteKey` למפתח האתר הציבורי של Turnstile. כתובת הפונקציה ומפתח האתר הציבורי גלויים בדפדפן בכוונה; הם אינם מפתחות סודיים.

5. מפרסמים מחדש את קובצי האתר. ב־Supabase Dashboard פותחים את הטבלה `family_memories`, בודקים סיפורים חדשים שמצבם `pending`, ומשנים למצב `approved` כדי לפרסם אותם. בחירה ב־`rejected` משאירה אותם מוסתרים.

## הרצת פונקציה מקומית

מעתיקים את `supabase/functions/.env.example` אל `supabase/functions/.env`, ממלאים ערכים מקומיים בלבד ומריצים את Supabase המקומי. קובץ `.env` מוחרג מ־Git. ב־`ALLOWED_ORIGINS` מוסיפים את כתובת שרת הפיתוח המקומי. אין לשמור מפתחות אמיתיים ב־`.env.example` או בקובצי האתר.

## הגבלות ופרטיות

- מתקבלים סיפורים באורך של עד 2,500 תווים ותמונות JPG, PNG או WebP עד 8MB.
- כל תמונה נבדקת לפי תוכן הקובץ ולא רק לפי הסיומת או הכותרת שהדפדפן שולח.
- הסיפורים ציבוריים רק אחרי אישור. תמונות נשארות ב־bucket פרטי ומוצגות באמצעות קישור חתום שפג אחרי 30 דקות.
- מונה ההגבלה שומר גיבוב SHA-256 של כתובת IP, לא את הכתובת עצמה, ומנקה רשומות ישנות.
- שמירת כתובת IP תלויה בכותרות שה־proxy של Supabase מעביר. Turnstile ואישור ידני נשארים שכבות ההגנה גם אם כותרת ה־IP אינה זמינה.
- בלי פרטי פרויקט ופריסה בפועל, האתר נשאר במצב מקומי ואינו משתף תוכן בין מכשירים.
