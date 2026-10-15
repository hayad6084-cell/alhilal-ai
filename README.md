# الهلال AI — النشر على Render

1. ارفع محتويات هذا المجلد على GitHub (في جذر المستودع مباشرة: `server.mjs` و`index.html` و`package.json` و`render.yaml`).
2. في Render: New ← Blueprint ← اختر المستودع. يقرأ `render.yaml` تلقائيًا.
3. أضف المتغيرات في Environment: `LTX_API_KEY`, `GEMINI_API_KEY`, `XKIRO_API_KEY`, `ADMIN_PHONE`, `ADMIN_INITIAL_PASSWORD`، ومتغيرات Firebase عند استخدام التخزين الدائم.
4. بعد النشر افتح `/api/health` وتأكد إنه يرجع `ok:true`.

## التعديلات
- لا توجد شاشة تسجيل دخول أو ربط برقم الهاتف؛ يتم إنشاء حساب تلقائي وربطه بمعرّف المتصفح.
- الحساب الجديد يبدأ بـ100 كوين.
- أداة المونتاج تنشئ 5 فيديوهات (كل واحد 10 ثوانٍ) أو 5 صور بالتوازي.
- المخرج الذكي وميزة إنشاء القصة تحتويان زرًا لتوليد القصة مشهدًا مشهدًا، مدة كل مشهد 10 ثوانٍ.

## ملاحظات
- ربط الحساب بالمتصفح يعتمد على بيانات المتصفح المخزنة محليًا. مسح بيانات الموقع أو استخدام متصفح/جهاز آخر قد ينشئ هوية متصفح جديدة؛ هذا ليس تحققًا من هوية الشخص.
- كل فيديو منفصل يخصم كوينًا واحدًا؛ إنشاء خمسة فيديوهات يحتاج 5 كوينز.
- بدون Firebase البيانات بتتحفظ في ملفات محلية وقد تضيع عند إعادة النشر؛ فعّل Firebase للتخزين الدائم.
- لا ترفع ملف `.env` إلى GitHub.
- لا تستخدم Vercel لهذا المشروع: السيرفر دائم التشغيل.


## Apiframe video provider
Add `APIFRAME_API_KEY` in the hosting provider's Environment settings (get the key from the Apiframe console). Never put the key in `index.html` or commit it to GitHub. The video generator now defaults to Apiframe and supports selecting a model. Requests use `https://api.apiframe.ai/v2/videos/generate` and poll `/v2/jobs/:id`.

## مزوّدو الفيديو الإضافيون
تستطيع إضافة متغيرات `MAGIC_HOUR_API_KEY` و`TAVUS_API_KEY` و`RUNWAY_API_KEY` و`WAN_API_KEY` في إعدادات Environment على Render. لوحة الإدارة تعرض هل المفتاح موجود فقط؛ هذا لا يعني أن التوليد موصول بعد بهذه الخدمات. لا تضع المفاتيح في الواجهة أو GitHub.

## صور المخرج الذكي
المخرج الذكي يولّد صورًا مرجعية للشخصيات والأماكن والأدوات والأسلحة، ثم يضمّن الصور المتاحة في عارض ملف العالم والإنتاج.
