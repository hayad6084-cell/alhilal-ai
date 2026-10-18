import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const scrypt = promisify(crypto.scrypt);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ───────────────────────── .env ───────────────────────── */
function loadDotEnv(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]]) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v.replace(/\\n/g, '\n');
    }
  } catch { /* no .env */ }
}
loadDotEnv(path.join(__dirname, '.env'));

/* ───────────────────────── helpers ───────────────────────── */
// يدعم الأرقام العربية والفارسية و +20 / 0020 / 20
function normalizePhone(v) {
  let s = String(v || '')
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[^\d+]/g, '');
  if (/^(\+20|0020|20)1\d{9}$/.test(s)) s = '0' + s.replace(/^(\+20|0020|20)/, '');
  return s.replace(/\+/g, '');
}
// Egyptian numbers keep their legacy local format so existing account IDs continue to work.
function normalizeAuthPhone(raw, countryCode = '+20') {
  let input = String(raw || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).trim();
  const cc = String(countryCode || '+20').replace(/\D/g, '');
  if (cc === '20') return normalizePhone(input);
  let digits = input.replace(/\D/g, '');
  if (!digits) return '';
  // If the user pasted an international number, preserve it instead of prefixing twice.
  if ((input.startsWith('+') || input.startsWith('00')) && digits.length >= 8 && digits.length <= 15) return '+' + digits.replace(/^00/, '');
  digits = digits.replace(/^0+/, '');
  const full = cc + digits;
  if (full.length < 8 || full.length > 15) return '';
  return '+' + full;
}

const PORT = Number(process.env.PORT || 8787);
const FIREBASE_WEB_API_KEY = (process.env.FIREBASE_WEB_API_KEY || '').trim();
const FIREBASE_AUTH_DOMAIN = (process.env.FIREBASE_AUTH_DOMAIN || '').trim();
const FIREBASE_APP_ID = (process.env.FIREBASE_APP_ID || '').trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const LTX_API_KEY = process.env.LTX_API_KEY || '';
const XKIRO_API_KEY = process.env.XKIRO_API_KEY || '';
const APIFRAME_API_KEY = (process.env.APIFRAME_API_KEY || '').trim();
// Additional video providers: keys are server-only and never sent to the browser.
const MAGIC_HOUR_API_KEY = (process.env.MAGIC_HOUR_API_KEY || '').trim();
const TAVUS_API_KEY = (process.env.TAVUS_API_KEY || '').trim();
const RUNWAY_API_KEY = (process.env.RUNWAY_API_KEY || '').trim();
const WAN_API_KEY = (process.env.WAN_API_KEY || '').trim();
const JSON2VIDEO_API_KEY = (process.env.JSON2VIDEO_API_KEY || '').trim();
const JSON2VIDEO_TEMPLATE_ID = (process.env.JSON2VIDEO_TEMPLATE_ID || '').trim();
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || '01035089566');
const ADMIN_INITIAL_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || '';


/* ───────────────────────── storage ───────────────────────── */
function firebaseReady() {
  return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}
if (firebaseReady() && !getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}
const db = firebaseReady() ? getFirestore() : null;
if (!db) console.warn('⚠️ Firebase غير مضبوط: البيانات تُحفظ محليًا وقد لا تستمر على الاستضافات عديمة الحالة مثل Vercel.');

const fallbackDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : (process.env.VERCEL === '1' ? path.join('/tmp', 'alhilal-ai-data') : path.join(__dirname, 'data'));
try { fs.mkdirSync(fallbackDir, { recursive: true }); } catch (e) { console.warn('⚠️ تعذر إنشاء مجلد البيانات:', e.message); }
const fallback = name => path.join(fallbackDir, name);
// استخدم سرًا ثابتًا عبر إعادة التشغيل؛ الأفضل ضبط SESSION_SECRET في إعدادات الاستضافة.
// كحل احتياطي، يُحفظ السر في DATA_DIR حتى لا تتغير جلسات الدخول عند إعادة تشغيل الخادم.
const sessionSecretFile = path.join(fallbackDir, 'session-secret.key');
let persistedSessionSecret = '';
try { persistedSessionSecret = fs.readFileSync(sessionSecretFile, 'utf8').trim(); } catch {}
if (!process.env.SESSION_SECRET && !persistedSessionSecret) {
  persistedSessionSecret = crypto.randomBytes(64).toString('hex');
  try { fs.writeFileSync(sessionSecretFile, persistedSessionSecret, { mode: 0o600 }); } catch (e) { console.warn('تعذر حفظ سر الجلسة في DATA_DIR:', e.message); }
}
const SESSION_SECRET = (process.env.SESSION_SECRET || persistedSessionSecret || crypto.randomBytes(64).toString('hex')).trim();
if (process.env.VERCEL === '1' && !process.env.SESSION_SECRET) console.error('CONFIGURATION REQUIRED: Set a stable SESSION_SECRET in Vercel Environment Variables or sessions may expire between function instances.');
if (SESSION_SECRET.length < 64) console.warn('⚠️ SESSION_SECRET قصير؛ استخدم قيمة عشوائية بطول 128 خانة hex أو أكثر.');
function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }
function writeJson(file, data) {
  // Vercel's project filesystem is read-only/ephemeral. Firestore-backed paths persist via db below.
  if (process.env.VERCEL === '1') return;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ───────────────────────── http utils ───────────────────────── */
function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }

function send(res, status, body, type = 'application/json', extra = {}) {
  const headers = {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
  if (CORS_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization';
    headers['Access-Control-Allow-Methods'] = 'GET,POST,DELETE,OPTIONS';
  }
  res.writeHead(status, headers);
  if (status === 204) return res.end();
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// قراءة الجسم كـ Buffer ثم تحويله مرة واحدة (إصلاح تلف الحروف العربية عند تقسيم الـ chunks)
async function body(req, limit = 8 * 1024 * 1024) {
  // Vercel may pre-parse JSON bodies; use that value when available.
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > limit) throw httpError('حجم الطلب كبير جدًا.', 413);
      try { return JSON.parse(req.body.toString('utf8') || '{}'); } catch { return {}; }
    }
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > limit) throw httpError('حجم الطلب كبير جدًا.', 413);
      try { return JSON.parse(req.body || '{}'); } catch { return {}; }
    }
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError('حجم الطلب كبير جدًا.', 413);
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  if (++h.n > max) throw httpError('محاولات كثيرة. حاول مرة أخرى بعد قليل.', 429);
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60_000).unref();
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'ip';

// قفل بسيط لكل مفتاح لمنع تعارض عمليات الرصيد المتزامنة
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/* ───────────────────────── auth ───────────────────────── */
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = (await scrypt(String(password), salt, 64)).toString('hex');
  return { salt, hash };
}
async function verifyPassword(password, salt, hash) {
  try {
    const actual = Buffer.from((await scrypt(String(password), salt, 64)).toString('hex'), 'hex');
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function makeToken(uid) {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function readToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const good = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(good);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!d.uid || d.exp < Date.now()) return null;
    return d;
  } catch { return null; }
}
// لا نُرجع الهاش والـ salt للمتصفح أبدًا
function publicUser(u) {
  if (!u) return u;
  const { passwordHash, passwordSalt, ...rest } = u;
  return rest;
}
const isAdminUser = u =>
  !!(u && (u.admin ||
    (ADMIN_EMAIL && String(u.email || '').toLowerCase() === ADMIN_EMAIL) ||
    (ADMIN_PHONE && normalizePhone(u.phone) === ADMIN_PHONE)));

async function getUser(uid) {
  // Read Firebase first, but keep compatibility with accounts stored by earlier
  // deployments in the local JSON store. When found, migrate them to Firestore.
  if (db) {
    const snap = await db.collection('users').doc(uid).get();
    if (snap.exists) return snap.data();
    const legacy = readJson(fallback('users.json'), {})[uid] || null;
    if (legacy) {
      try { await db.collection('users').doc(uid).set(legacy, { merge: true }); }
      catch (e) { console.warn('تعذرت ترحيل الحساب القديم إلى Firestore:', e.message); }
      return legacy;
    }
    return null;
  }
  return readJson(fallback('users.json'), {})[uid] || null;
}
async function saveUser(u) {
  if (db) { await db.collection('users').doc(u.uid).set(u, { merge: true }); return; }
  const f = fallback('users.json'), all = readJson(f, {});
  all[u.uid] = u;
  writeJson(f, all);
}
async function userFromReq(req) {
  const h = req.headers.authorization || '';
  const d = readToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!d) throw httpError('سجّل الدخول أولًا للمتابعة.', 401);
  const u = await getUser(d.uid);
  if (!u) throw httpError('الحساب غير موجود.', 401);
  return { uid: u.uid, phone: u.phone || '', name: u.name || 'عضو الهلال AI', email: u.email || '', admin: isAdminUser(u) };
}
async function requireAdmin(req) {
  const d = await userFromReq(req);
  if (!d.admin) throw httpError('غير مصرح.', 403);
  return d;
}

async function bindBrowser(browserId, uid) {
  browserId = String(browserId || '').trim();
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(browserId)) throw httpError('معرّف المتصفح غير صالح. حدّث الصفحة وحاول مرة أخرى.', 400);
  const conflict = httpError('هذا المتصفح مرتبط بحساب آخر. لا يمكن استخدام أكثر من حساب في المتصفح نفسه.', 409);
  if (db) {
    const ref = db.collection('browserBindings').doc(browserId);
    const snap = await ref.get();
    if (snap.exists && snap.data().uid !== uid) throw conflict;
    await ref.set({ uid, updatedAt: new Date().toISOString() }, { merge: true });
  } else {
    const f = fallback('browser-bindings.json');
    const bindings = readJson(f, {});
    if (bindings[browserId] && bindings[browserId] !== uid) throw conflict;
    bindings[browserId] = uid;
    writeJson(f, bindings);
  }
}

/* ───────────────────────── coins ───────────────────────── */
// كل تعديل رصيد يقرأ المستخدم من جديد داخل القفل → لا رصيد سالب ولا تجاوز بالطلبات المتزامنة
function adjustPoints(uid, delta, reason) {
  return withLock('u:' + uid, async () => {
    const u = await getUser(uid);
    if (!u) throw httpError('الحساب غير موجود.', 404);
    const cur = Number(u.points) || 0;
    if (delta < 0 && cur < -delta) throw httpError(`رصيدك غير كافٍ. تحتاج ${-delta} كوين.`, 402);
    u.points = cur + delta;
    if (reason) {
      u.used = u.used || {};
      u.used[reason] = Math.max(0, (Number(u.used[reason]) || 0) - delta);
    }
    await saveUser(u);
    return u;
  });
}
const charge = async (uid, amount, reason) => { const u=await getUser(uid); if(u && (isAdminUser(u) || Number(u.unlimitedUntil||0)>Date.now())) return u; return adjustPoints(uid,-amount,reason); };
const refund = async (uid, amount, reason) => { const u=await getUser(uid); if(u && (isAdminUser(u) || Number(u.unlimitedUntil||0)>Date.now())) return u; return adjustPoints(uid,amount,reason); };

/* ───────────────────────── projects ───────────────────────── */
const safeId = (v, prefix = 'p_') => String(v || '').replace(/[^\w-]/g, '').slice(0, 80) || prefix + crypto.randomUUID();

async function listProjects(uid) {
  if (db) {
    const s = await db.collection('users').doc(uid).collection('projects').orderBy('createdAt', 'desc').limit(200).get();
    return s.docs.map(d => d.data());
  }
  return readJson(fallback('projects.json'), {})[uid] || [];
}
async function saveProject(uid, p) {
  if (JSON.stringify(p).length > 900_000) throw httpError('المشروع كبير جدًا للحفظ.', 413);
  if (db) {
    await db.collection('users').doc(uid).collection('projects').doc(p.id).set(p, { merge: true });
    return p;
  }
  const f = fallback('projects.json'), all = readJson(f, {});
  const list = (all[uid] || []).filter(x => x.id !== p.id);
  list.unshift(p);
  all[uid] = list.slice(0, 200);
  writeJson(f, all);
  return p;
}
async function deleteProjectStore(uid, id) {
  if (db) { await db.collection('users').doc(uid).collection('projects').doc(id).delete(); return; }
  const f = fallback('projects.json'), all = readJson(f, {});
  all[uid] = (all[uid] || []).filter(p => p.id !== id);
  writeJson(f, all);
}

/* ───────────────────────── payments ───────────────────────── */
const PACKS = { p_100:{coins:100,price:10},p_500:{coins:500,price:35},p_1000:{coins:1000,price:60},p_2500:{coins:2500,price:120},p_5000:{coins:5000,price:220},p_10000:{coins:10000,price:390},p_15000:{coins:15000,price:550},p_25000:{coins:25000,price:850},p_40000:{coins:40000,price:1250},p_60000:{coins:60000,price:1700},p_100000:{coins:100000,price:2500},p_150000:{coins:150000,price:3400},p_250000:{coins:250000,price:5100},p_400000:{coins:400000,price:7200},p_600000:{coins:600000,price:9800},p_1000000:{coins:1000000,price:14500},p_daily:{coins:0,price:125,unlimitedMs:86400000},p_weekly:{coins:0,price:750,unlimitedMs:7*86400000},p_monthly:{coins:0,price:3750,unlimitedMs:30*86400000},p_yearly:{coins:0,price:7500,unlimitedMs:365*86400000} };

async function listPayments() {
  if (db) {
    const s = await db.collection('payments').orderBy('createdAt', 'desc').limit(500).get();
    return s.docs.map(d => d.data());
  }
  return readJson(fallback('payments.json'), []);
}
async function listPaymentsByUid(uid) {
  if (db) {
    const s = await db.collection('payments').where('uid', '==', uid).get();
    return s.docs.map(d => d.data()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50);
  }
  return readJson(fallback('payments.json'), []).filter(x => x.uid === uid).slice(0, 50);
}
async function getPayment(id) {
  if (db) { const s = await db.collection('payments').doc(id).get(); return s.exists ? s.data() : null; }
  return readJson(fallback('payments.json'), []).find(x => x.id === id) || null;
}
async function findPaymentByRef(ref) {
  if (db) {
    const s = await db.collection('payments').where('transactionRef', '==', ref).get();
    return s.docs.map(d => d.data()).find(x => x.status !== 'rejected') || null;
  }
  return readJson(fallback('payments.json'), []).find(x => x.transactionRef === ref && x.status !== 'rejected') || null;
}
async function updatePayment(rec) {
  if (db) { await db.collection('payments').doc(rec.id).set(rec, { merge: true }); return; }
  const f = fallback('payments.json'), a = readJson(f, []), i = a.findIndex(x => x.id === rec.id);
  if (i >= 0) a[i] = rec;
  writeJson(f, a);
}
async function createPayment(uid, email, p) {
  const pack = PACKS[p.packageId];
  if (!pack) throw httpError('الباقة غير صحيحة.', 400);
  const transactionRef = String(p.transactionRef || '').trim().replace(/\s+/g, '');
  if (!transactionRef) throw httpError('رقم العملية مطلوب.', 400);
  if (!/^[A-Za-z0-9\-_.]{6,40}$/.test(transactionRef)) throw httpError('رقم العملية غير صالح (6 إلى 40 حرفًا/رقمًا).', 400);
  rateLimit('pay:' + uid, 10, 60 * 60_000);
  return withLock('payref:' + transactionRef, async () => {
    if (await findPaymentByRef(transactionRef)) throw httpError('رقم العملية هذا مُسجّل بالفعل.', 409);
    const rec = {
      id: 'pay_' + crypto.randomUUID(), uid, email: email || '', packageId: p.packageId,
      coins: pack.coins, price: pack.price, unlimitedMs: pack.unlimitedMs || 0, transactionRef, status: 'pending', createdAt: new Date().toISOString(),
    };
    if (db) await db.collection('payments').doc(rec.id).set(rec);
    else { const f = fallback('payments.json'), a = readJson(f, []); a.unshift(rec); writeJson(f, a); }
    return rec;
  });
}
function reviewPayment(id, approve, reviewer) {
  return withLock('payment:' + id, async () => {
    const rec = await getPayment(id);
    if (!rec) throw httpError('الطلب غير موجود.', 404);
    if (rec.status !== 'pending') throw httpError('الطلب تمت معالجته بالفعل.', 400);
    if (approve) {
      if (!(await getUser(rec.uid))) throw httpError('المستخدم غير موجود.', 404);
      rec.status = 'approved'; rec.reviewedAt = new Date().toISOString(); rec.reviewedBy = reviewer;
      await updatePayment(rec);
      try { if(rec.unlimitedMs){ const u=await getUser(rec.uid); u.unlimitedUntil=Math.max(Date.now(),Number(u.unlimitedUntil)||0)+rec.unlimitedMs; await saveUser(u); } else if(rec.coins>0) await adjustPoints(rec.uid, rec.coins); }
      catch (e) { rec.status = 'pending'; delete rec.reviewedAt; delete rec.reviewedBy; await updatePayment(rec); throw e; }
    } else {
      rec.status = 'rejected'; rec.reviewedAt = new Date().toISOString(); rec.reviewedBy = reviewer;
      await updatePayment(rec);
    }
    return rec;
  });
}

/* ───────────────────────── redeem codes ───────────────────────── */
// أصفر = 100 ، أخضر = 1,000 ، أحمر = 10,000
// الأصفر والأخضر: مرة واحدة على مستوى النظام.
// الأحمر: كان قابلًا للاستخدام بلا حد (أي شخص يكرره ويجمع كوينز بلا نهاية) → الآن مرة واحدة لكل حساب.
const REDEEM_CODES = Object.freeze({
  A123: 10000, B456: 10000, C789: 10000, D321: 10000, E654: 10000, F987: 10000, G111: 10000, H222: 10000, I333: 10000, J444: 10000,
  K555: 100, L666: 100, M777: 100, N888: 100, O999: 100, P102: 100, Q304: 100, R506: 100, S708: 100, T901: 100, U234: 100, V567: 100, W890: 100, X135: 100, Y246: 100, Z357: 100, A468: 100, B579: 100, C680: 100, D791: 100,
  E802: 1000, F913: 1000, G024: 1000, H135: 1000, I246: 1000, J357: 1000, K468: 1000, L579: 1000, M680: 1000, N791: 1000, O112: 1000, P223: 1000, Q334: 1000, R445: 1000, S556: 1000, T667: 1000, U778: 1000, V889: 1000, W990: 1000, X147: 1000,
});
const REDEEM_GLOBAL_ONCE = new Set(Object.keys(REDEEM_CODES).filter(c => REDEEM_CODES[c] !== 10000));

async function claimGlobalCode(code, uid, amount) {
  const rec = { code, uid, coins: amount, redeemedAt: new Date().toISOString() };
  if (db) {
    try { await db.collection('redeemed_codes').doc(code).create(rec); }
    catch (e) { if (e?.code === 6 || /already exists/i.test(e?.message || '')) throw httpError('هذا الكود تم استخدامه بالفعل.', 409); throw e; }
    return;
  }
  const f = fallback('redeemed-codes.json'), all = readJson(f, {});
  if (all[code]) throw httpError('هذا الكود تم استخدامه بالفعل.', 409);
  all[code] = rec;
  writeJson(f, all);
}
async function releaseGlobalCode(code) {
  try {
    if (db) await db.collection('redeemed_codes').doc(code).delete();
    else { const f = fallback('redeemed-codes.json'), all = readJson(f, {}); delete all[code]; writeJson(f, all); }
  } catch { /* ignore */ }
}
async function redeemCode(uid, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const amount = REDEEM_CODES[code];
  if (!amount) throw httpError('الكود غير صحيح أو غير موجود.', 400);
  return withLock('u:' + uid, async () => {
    const u = await getUser(uid);
    if (!u) throw httpError('الحساب غير موجود.', 404);
    if (u.redeemLog && u.redeemLog[code]) throw httpError('سبق أن استخدمت هذا الكود على حسابك.', 409);
    const once = REDEEM_GLOBAL_ONCE.has(code);
    if (once) await claimGlobalCode(code, uid, amount);
    try {
      u.points = (Number(u.points) || 0) + amount;
      u.redeemLog = { ...(u.redeemLog || {}), [code]: new Date().toISOString() };
      await saveUser(u);
    } catch (e) { if (once) await releaseGlobalCode(code); throw e; }
    return { code, coins: amount, points: u.points, reusable: false };
  });
}

/* ───────────────────────── AI providers ───────────────────────── */
function extractAudio(data) {
  for (const step of [...(data?.steps || [])].reverse())
    for (const c of [...(step?.content || [])].reverse())
      if (c?.type === 'audio' && c?.data) return { audioBase64: c.data, mimeType: c.mime_type || c.mimeType || 'audio/wav' };
  if (data?.output_audio?.data) return { audioBase64: data.output_audio.data, mimeType: data.output_audio.mime_type || 'audio/wav' };
  return null;
}
async function geminiText(prompt, model = 'gemini-3.8-flash') {
  if (!GEMINI_API_KEY) throw new Error('Gemini غير مضبوط على الخادم.');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Gemini (${r.status})`);
  return d?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
}
async function xkiroText(prompt, model = 'qwen/qwen3.8-omni-flash:free') {
  if (!XKIRO_API_KEY) throw new Error('xKiro غير مضبوط على الخادم.');
  const r = await fetch('https://api.xkiro.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XKIRO_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 8000 }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `xKiro (${r.status})`);
  return d?.choices?.[0]?.message?.content || d?.choices?.[0]?.text || '';
}
async function xkiroImage(prompt, size = '1024x1024') {
  if (!XKIRO_API_KEY) throw new Error('xKiro غير مضبوط على الخادم.');
  const r = await fetch('https://api.xkiro.com/v1/images/generations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XKIRO_API_KEY}` },
    body: JSON.stringify({ model: 'sensenova/sensenova-u1.5-lite', prompt, n: 1, size }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `xKiro image (${r.status})`);
  if (d?.data?.[0]?.url) return d.data[0].url;
  if (d?.id) {
    for (let i = 0; i < 30; i++) {
      await new Promise(res => setTimeout(res, 2000));
      const p = await fetch(`https://api.xkiro.com/v1/images/generations/${encodeURIComponent(d.id)}`, { headers: { Authorization: `Bearer ${XKIRO_API_KEY}` } });
      const q = await p.json().catch(() => ({}));
      if (q?.status === 'succeeded' && q.data?.[0]?.url) return q.data[0].url;
      if (q?.status === 'failed' || q?.status === 'blocked') throw new Error(typeof q?.error === 'string' ? q.error : q?.error?.message || 'فشل توليد الصورة');
    }
  }
  throw new Error('xKiro لم يُرجع صورة.');
}
async function geminiImage(prompt) {
  if (!GEMINI_API_KEY) throw new Error('Gemini غير مضبوط على الخادم.');
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Gemini image (${r.status})`);
  const part = d?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data || p.inline_data?.data);
  if (part) { const x = part.inlineData || part.inline_data; return `data:${x.mimeType || x.mime_type || 'image/jpeg'};base64,${x.data}`; }
  throw new Error('Gemini لم يُرجع صورة.');
}

const ltxJobs = new Map();
const apiframeJobs = new Map();
const json2videoJobs = new Map();
setInterval(() => { const old = Date.now() - 24 * 3600_000; for (const [k, j] of ltxJobs) if (j.ts < old) ltxJobs.delete(k); }, 3600_000).unref();
const ltxMsg = (data, r, label) => (typeof data?.error === 'string' ? data.error : data?.error?.message) || data?.message || `${label} (${r.status})`;

/* ───────────────────────── config ───────────────────────── */
function publicConfig() {
  const googleReady = !!(firebaseReady() && FIREBASE_WEB_API_KEY && FIREBASE_AUTH_DOMAIN && FIREBASE_APP_ID);
  return {
    phonePasswordReady: true,
    persistentStorage: !!db,
    googleReady,
    ...(googleReady ? { firebase: { apiKey: FIREBASE_WEB_API_KEY, authDomain: FIREBASE_AUTH_DOMAIN, projectId: process.env.FIREBASE_PROJECT_ID, appId: FIREBASE_APP_ID } } : {}),
  };
}

/* ───────────────────────── routes ───────────────────────── */
const INDEX_FILE = path.join(__dirname, 'index.html');

const redVideoDir = path.join(fallbackDir,'red-videos');
try { fs.mkdirSync(redVideoDir,{recursive:true}); } catch {}
function redVideoIndex(){return readJson(fallback('red-videos.json'),[])}
function saveRedVideoIndex(a){writeJson(fallback('red-videos.json'),a)}
async function readSiteSettings(){
  if(db){try{const snap=await db.collection('siteSettings').doc('main').get();if(snap.exists)return snap.data()||{}}catch(e){console.warn('site settings read',e.message)}}
  return readJson(fallback('site-settings.json'), { whatsapp: String(process.env.ADMIN_WHATSAPP || '201035089566').replace(/\D/g,'') });
}
async function writeSiteSettings(value){
  writeJson(fallback('site-settings.json'),value);
  if(db)await db.collection('siteSettings').doc('main').set(value,{merge:true});
}
async function readStoreProducts(){
  if(db){try{const snap=await db.collection('shopProducts').get();return snap.docs.map(d=>({...d.data(),id:d.id})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))}catch(e){console.warn('shop products read',e.message)}}
  return readJson(fallback('shop-products.json'), []);
}
async function writeStoreProduct(product){
  const products=readJson(fallback('shop-products.json'),[]),idx=products.findIndex(x=>x.id===product.id);
  if(idx<0)products.unshift(product);else products[idx]=product;
  writeJson(fallback('shop-products.json'),products);
  if(db)await db.collection('shopProducts').doc(product.id).set(product,{merge:true});
}
async function removeStoreProduct(id){
  writeJson(fallback('shop-products.json'),readJson(fallback('shop-products.json'),[]).filter(x=>x.id!==id));
  if(db)await db.collection('shopProducts').doc(id).delete();
}
export async function handleRequest(req, res) {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const M = req.method;

    if (M === 'GET' && p === '/api/config') return send(res, 200, publicConfig());

    if (M === 'GET' && p === '/api/health') {
      let admin = false;
      try { admin = (await userFromReq(req)).admin; } catch { /* anonymous */ }
      return send(res, 200, {
        ok: true, googleReady: publicConfig().googleReady, persistentStorage: !!db,
        ...(admin ? { geminiConfigured: !!GEMINI_API_KEY, ltxConfigured: !!LTX_API_KEY, xkiroConfigured: !!XKIRO_API_KEY, apiframeConfigured: !!APIFRAME_API_KEY, magicHourConfigured: !!MAGIC_HOUR_API_KEY, tavusConfigured: !!TAVUS_API_KEY, runwayConfigured: !!RUNWAY_API_KEY, wanConfigured: !!WAN_API_KEY, json2videoConfigured: !!JSON2VIDEO_API_KEY, json2videoTemplateConfigured: !!JSON2VIDEO_TEMPLATE_ID } : {}),
      });
    }

    /* ----- automatic browser-only identity ----- */
    if (M === 'POST' && p === '/api/auth/browser') {
      const b = await body(req);
      const browserId = String(b.browserId || '').trim();
      if (!/^[a-zA-Z0-9_-]{16,100}$/.test(browserId)) return send(res, 400, { error: 'معرّف المتصفح غير صالح. حدّث الصفحة وحاول مرة أخرى.' });
      let uid = null;
      if (db) {
        const snap = await db.collection('browserBindings').doc(browserId).get();
        if (snap.exists) uid = String(snap.data().uid || '');
      } else {
        const bindings = readJson(fallback('browser-bindings.json'), {});
        uid = bindings[browserId] || null;
      }
      if (uid) {
        let u = await getUser(uid);
        if (u) return send(res, 200, { token: makeToken(uid), user: publicUser(u) });
      }
      uid = 'browser_' + browserId;
      let u = await getUser(uid);
      if (!u) {
        u = { uid, phone: '', email: '', name: 'عضو المتصفح', points: 0, createdAt: new Date().toISOString(), used: { video: 0, voice: 0 }, admin: false };
        await saveUser(u);
      }
      await bindBrowser(browserId, uid);
      return send(res, 200, { token: makeToken(uid), user: publicUser(u) });
    }

    /* ----- auth ----- */
    if (M === 'POST' && p === '/api/auth/register') {
      rateLimit('reg:' + clientIp(req), 10, 60 * 60_000);
      const b = await body(req);
      const phone = normalizeAuthPhone(b.phone, b.countryCode || '+20'), password = String(b.password || '');
      const name = String(b.name || 'عضو الهلال AI').trim().slice(0, 80) || 'عضو الهلال AI';
      if (ADMIN_PHONE && phone === ADMIN_PHONE) return send(res, 403, { error: 'رقم المالك مخصص لحساب الإدارة. اضبط ADMIN_INITIAL_PASSWORD على السيرفر ثم سجّل الدخول.' });
      if (!(/^01[0125]\d{8}$/.test(phone) || /^\+[1-9]\d{7,14}$/.test(phone))) return send(res, 400, { error: 'أدخل رقم هاتف صحيحًا مع اختيار مفتاح الدولة.' });
      if (password.length < 6) return send(res, 400, { error: 'كلمة المرور يجب أن تكون 6 أحرف أو أكثر.' });
      if (password.length > 200) return send(res, 400, { error: 'كلمة المرور طويلة جدًا.' });
      const uid = 'phone_' + phone;
      if (await getUser(uid)) return send(res, 409, { error: 'هذا الرقم مسجل بالفعل. سجّل الدخول بدلًا من إنشاء حساب جديد.' });
      const ph = await hashPassword(password);
      const u = {
        uid, phone, email: phone + '@phone.local', name, points: 0, createdAt: new Date().toISOString(),
        used: { video: 0, voice: 0 }, passwordHash: ph.hash, passwordSalt: ph.salt, admin: false,
      };
      await saveUser(u);
      return send(res, 200, { token: makeToken(uid), user: publicUser(u) });
    }

    if (M === 'POST' && p === '/api/auth/google') {
      rateLimit('google:' + clientIp(req), 30, 15 * 60_000);
      const b = await body(req);
      const idToken = String(b.idToken || '').trim();
      if (!idToken) return send(res, 400, { error: 'لم يصل رمز Google.' });
      if (!db || !firebaseReady()) return send(res, 503, { error: 'Google غير مفعّل على السيرفر. أضف إعدادات Firebase Admin أولًا.' });
      let decoded;
      try { decoded = await getAuth().verifyIdToken(idToken); }
      catch (e) { return send(res, 401, { error: 'تعذر التحقق من حساب Google: ' + (e?.message || 'رمز غير صالح') }); }
      const uid = decoded.uid, email = String(decoded.email || '').trim().toLowerCase();
      const name = String(decoded.name || decoded.email || 'عضو الهلال AI').slice(0, 80);
      let u = await getUser(uid);
      const adminByEmail = !!(ADMIN_EMAIL && email === ADMIN_EMAIL && decoded.email_verified);
      if (!u) {
        u = { uid, email, name, phone: decoded.phone_number || '', points: 0, createdAt: new Date().toISOString(), used: { video: 0, voice: 0 }, admin: adminByEmail };
      } else {
        u.email = email || u.email || '';
        u.name = name || u.name || 'عضو الهلال AI';
        if (adminByEmail) u.admin = true;
      }
      await saveUser(u);
      return send(res, 200, { token: makeToken(uid), user: publicUser(u) });
    }

    if (M === 'POST' && p === '/api/auth/login') {
      const ip = clientIp(req);
      rateLimit('login-ip:' + ip, 30, 15 * 60_000);
      const b = await body(req);
      const phone = normalizeAuthPhone(b.phone, b.countryCode || '+20'), password = String(b.password || '');
      rateLimit('login-phone:' + phone, 10, 15 * 60_000);
      const uid = 'phone_' + phone;
      let u = await getUser(uid);
      const isOwner = ADMIN_PHONE && phone === ADMIN_PHONE;
      if (!u && isOwner && ADMIN_INITIAL_PASSWORD && safeEqual(password, ADMIN_INITIAL_PASSWORD)) {
        const ph = await hashPassword(password);
        u = {
          uid, phone, email: phone + '@phone.local', name: 'مالك هلال AI', points: 100000, createdAt: new Date().toISOString(),
          used: { video: 0, voice: 0 }, passwordHash: ph.hash, passwordSalt: ph.salt, admin: true,
        };
        await saveUser(u);
      }
      if (!u || !u.passwordHash || !(await verifyPassword(password, u.passwordSalt, u.passwordHash)))
        return send(res, 401, { error: 'رقم الهاتف أو كلمة المرور غير صحيحة.' });
      if (isOwner && !u.admin) { u.admin = true; u.points = Math.max(Number(u.points) || 0, 100000); await saveUser(u); }
      return send(res, 200, { token: makeToken(u.uid), user: publicUser(u) });
    }

    if (M === 'GET' && p === '/api/me') {
      const d = await userFromReq(req);
      const u = await getUser(d.uid);
      return send(res, 200, { user: { ...publicUser(u), admin: d.admin } });
    }

    /* ----- projects ----- */
    if (M === 'GET' && p === '/api/projects') {
      const d = await userFromReq(req);
      return send(res, 200, { projects: await listProjects(d.uid) });
    }
    if (M === 'POST' && p === '/api/projects') {
      const d = await userFromReq(req);
      const b = await body(req);
      const rec = {
        id: safeId(b.id),
        type: String(b.type || 'chat').slice(0, 30),
        name: String(b.name || 'مشروع الهلال AI').slice(0, 200),
        desc: String(b.desc || '').slice(0, 1000),
        icon: String(b.icon || '📁').slice(0, 8),
        data: b.data ?? null,
        createdAt: String(b.createdAt || new Date().toISOString()),
        date: String(b.date || new Date().toLocaleString('ar-EG')),
      };
      return send(res, 200, { project: await saveProject(d.uid, rec) });
    }
    if (M === 'DELETE' && p.startsWith('/api/projects/')) {
      const d = await userFromReq(req);
      await deleteProjectStore(d.uid, safeId(decodeURIComponent(p.split('/').pop())));
      return send(res, 200, { ok: true });
    }

    /* ----- user video submissions and red points ----- */
    if (M === 'POST' && p === '/api/red-videos/upload') {
      if (process.env.VERCEL === '1') throw httpError('رفع الفيديوهات يحتاج ربط تخزين دائم (Firebase Storage) قبل تفعيله على Vercel. لم يتم حفظ الملف؛ استخدم إرسال الفيديو عبر واتساب مؤقتًا.', 503);
      const d = await userFromReq(req);
      const q = new URL(req.url, 'http://localhost').searchParams;
      const mime = String(q.get('mimeType') || req.headers['content-type'] || '');
      if (!mime.startsWith('video/')) throw httpError('الملف يجب أن يكون فيديو.', 400);
      const maxBytes = 1024 * 1024 * 1024;
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > maxBytes) throw httpError('حجم الفيديو يتجاوز 1 جيجابايت.', 413);
      const id = 'rv_' + crypto.randomUUID();
      const ext = ({ 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' })[mime] || '.video';
      const fileName = id + ext, target = path.join(redVideoDir, fileName);
      let size = 0;
      const out = fs.createWriteStream(target, { flags: 'wx' });
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxBytes) { out.destroy(); try { fs.unlinkSync(target); } catch {} throw httpError('حجم الفيديو يتجاوز 1 جيجابايت.', 413); }
          if (!out.write(chunk)) await new Promise((resolve, reject) => { out.once('drain', resolve); out.once('error', reject); });
        }
        await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
      } catch (e) { out.destroy(); try { fs.unlinkSync(target); } catch {} throw e; }
      if (!size) { try { fs.unlinkSync(target); } catch {} throw httpError('ملف الفيديو فارغ.', 400); }
      const rec = { id, uid: d.uid, phone: String(q.get('phone') || d.phone || '').slice(0,40), name: String(q.get('name') || 'video').slice(0,180), note: String(q.get('note') || '').slice(0,1000), mimeType: mime, size, fileName, status: 'pending', awarded: 0, createdAt: new Date().toISOString() };
      const all = redVideoIndex(); all.unshift(rec); saveRedVideoIndex(all);
      return send(res, 200, { ok: true, id, size });
    }
    if (M === 'POST' && p === '/api/red-videos') {
      const d=await userFromReq(req), b=await body(req,8*1024*1024);
      const mime=String(b.mimeType||''); if(!mime.startsWith('video/')) throw httpError('الملف يجب أن يكون فيديو.',400);
      const raw=Buffer.from(String(b.data||''),'base64'); if(!raw.length||raw.length>5*1024*1024) throw httpError('حجم الفيديو يجب ألا يتجاوز 5MB.',413);
      const id='rv_'+crypto.randomUUID(), ext=({ 'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov' })[mime]||'.video';
      fs.writeFileSync(path.join(redVideoDir,id+ext),raw);
      const rec={id,uid:d.uid,phone:d.phone||'',name:String(b.name||'video').slice(0,180),note:String(b.note||'').slice(0,1000),mimeType:mime,size:raw.length,fileName:id+ext,status:'pending',awarded:0,createdAt:new Date().toISOString()};
      const all=redVideoIndex();all.unshift(rec);saveRedVideoIndex(all);return send(res,200,{ok:true,id});
    }
    if (M === 'GET' && p === '/api/admin/red-videos') { await requireAdmin(req); return send(res,200,{requests:redVideoIndex().slice(0,100)}); }
    if (M === 'GET' && p.startsWith('/api/admin/red-videos/') && p.endsWith('/file')) {
      await requireAdmin(req); const id=decodeURIComponent(p.split('/')[4]||''); const rec=redVideoIndex().find(x=>x.id===id); if(!rec)throw httpError('الفيديو غير موجود.',404);
      const file=path.join(redVideoDir,rec.fileName); if(!fs.existsSync(file))throw httpError('ملف الفيديو غير متاح على الخادم.',404);
      res.writeHead(200,{'Content-Type':rec.mimeType||'video/mp4','Cache-Control':'no-store','Content-Length':fs.statSync(file).size}); return fs.createReadStream(file).pipe(res);
    }
    if (M === 'POST' && p === '/api/admin/red-videos/review') {
      const admin=await requireAdmin(req), b=await body(req); const all=redVideoIndex(),rec=all.find(x=>x.id===String(b.id||'')); if(!rec)throw httpError('الطلب غير موجود.',404); if(rec.status!=='pending')throw httpError('تمت مراجعة الطلب بالفعل.',409);
      if(b.approve){const award=Math.floor(Number(b.award)||0);if(award<1||award>1000000)throw httpError('عدد النقاط غير صالح.',400);const u=await getUser(rec.uid);if(!u)throw httpError('الحساب غير موجود.',404);u.redPoints=(Number(u.redPoints)||0)+award;await saveUser(u);rec.status='approved';rec.awarded=award;}else rec.status='rejected';rec.reviewedAt=new Date().toISOString();rec.reviewedBy=admin.phone;saveRedVideoIndex(all);return send(res,200,{ok:true,status:rec.status,awarded:rec.awarded});
    }
    if (M === 'POST' && p === '/api/red-points/purchase') {
      const d=await userFromReq(req),b=await body(req);const amount=Math.floor(Number(b.amount)||0);if(amount<1||amount>100000)throw httpError('عدد النقاط غير صالح.',400);
      const rec={id:'rp_'+crypto.randomUUID(),uid:d.uid,phone:d.phone,amount,price:amount,status:'pending',createdAt:new Date().toISOString()};const all=readJson(fallback('red-point-purchases.json'),[]);all.unshift(rec);writeJson(fallback('red-point-purchases.json'),all);return send(res,200,{ok:true,id:rec.id,price:amount});
    }
    if (M === 'POST' && p === '/api/red-points/request') {
      const d=await userFromReq(req),b=await body(req),type=String(b.type||'get'),amount=Math.floor(Number(b.amount)||0),phone=String(b.phone||'').trim();
      if(!['get','sell'].includes(type))throw httpError('نوع الطلب غير صالح.',400);
      if(!phone||phone.length>40)throw httpError('أدخل رقم تواصل صحيحًا.',400);
      if(amount<1||amount>100000)throw httpError('عدد النقاط غير صالح.',400);
      if(type==='sell'){const u=await getUser(d.uid);if(!u||amount>(Number(u.redPoints)||0))throw httpError('رصيد النقاط الحمراء غير كافٍ.',400);}
      const rec={id:'rpr_'+crypto.randomUUID(),uid:d.uid,phone,amount,type,status:'pending',createdAt:new Date().toISOString()};const all=readJson(fallback('red-point-requests.json'),[]);all.unshift(rec);writeJson(fallback('red-point-requests.json'),all);return send(res,200,{ok:true,id:rec.id});
    }
    if (M === 'GET' && p === '/api/admin/red-points/requests') { await requireAdmin(req); return send(res,200,{requests:readJson(fallback('red-point-requests.json'),[]).slice(0,200)}); }
    if (M === 'POST' && p === '/api/admin/red-points/review') {
      const admin=await requireAdmin(req),b=await body(req),all=readJson(fallback('red-point-requests.json'),[]),rec=all.find(x=>x.id===String(b.id||''));
      if(!rec)throw httpError('الطلب غير موجود.',404);if(rec.status!=='pending')throw httpError('تمت مراجعة الطلب بالفعل.',409);
      if(b.approve){const u=await getUser(rec.uid);if(!u)throw httpError('الحساب غير موجود.',404);
        if(rec.type==='sell'){if((Number(u.redPoints)||0)<rec.amount)throw httpError('رصيد المستخدم لم يعد كافيًا.',409);u.redPoints=Number(u.redPoints||0)-rec.amount;rec.awarded=0;}
        else {const award=Math.floor(Number(b.award)||0);if(award<1||award>1000000)throw httpError('حدد عدد النقاط الممنوحة.',400);u.redPoints=(Number(u.redPoints)||0)+award;rec.awarded=award;}
        await saveUser(u);rec.status='approved';
      }else rec.status='rejected';rec.reviewedAt=new Date().toISOString();rec.reviewedBy=admin.phone;writeJson(fallback('red-point-requests.json'),all);return send(res,200,{ok:true,status:rec.status,awarded:rec.awarded});
    }

    /* ----- payments / coins ----- */
    if (M === 'POST' && p === '/api/payments/vodafone') {
      const d = await userFromReq(req), b = await body(req);
      return send(res, 200, { payment: await createPayment(d.uid, d.email, b) });
    }
    if (M === 'GET' && p === '/api/payments/mine') {
      const d = await userFromReq(req);
      return send(res, 200, { payments: await listPaymentsByUid(d.uid) });
    }
    if (M === 'POST' && p === '/api/redeem-code') {
      const d = await userFromReq(req), b = await body(req);
      rateLimit('redeem-user:' + d.uid, 15, 10 * 60_000);
      rateLimit('redeem-ip:' + clientIp(req), 40, 60 * 60_000);
      return send(res, 200, { ok: true, ...(await redeemCode(d.uid, b.code)) });
    }
    if (M === 'GET' && p === '/api/admin/payments') {
      await requireAdmin(req);
      return send(res, 200, { payments: await listPayments() });
    }
    if (M === 'POST' && p === '/api/admin/payments/approve') {
      const d = await requireAdmin(req), b = await body(req);
      const rec = await reviewPayment(String(b.id || ''), !!b.approve, d.email || d.phone);
      return send(res, 200, { ok: true, status: rec.status });
    }

    /* ----- AI ----- */
    if (M === 'POST' && p === '/api/ai/chat') {
      const d = await userFromReq(req);
      rateLimit('chat:' + d.uid, 30, 60_000);
      const b = await body(req);
      const prompt = String(b.prompt || '').trim();
      if (!prompt) return send(res, 400, { error: 'اكتب رسالة أولًا.' });
      if (prompt.length > 80_000) return send(res, 413, { error: 'النص طويل جدًا.' });
      const model = String(b.model || 'xkiro:qwen/qwen3.8-omni-flash:free');
      let reply;
      if (model.startsWith('gemini:')) {
        const m = model.slice(7);
        if (!/^[\w.\-]{1,80}$/.test(m)) return send(res, 400, { error: 'اسم النموذج غير صالح.' });
        reply = await geminiText(prompt, m);
      } else {
        const m = model.startsWith('xkiro:') ? model.slice(6) : model;
        if (!/^[\w.\-/:]{1,120}$/.test(m)) return send(res, 400, { error: 'اسم النموذج غير صالح.' });
        reply = await xkiroText(prompt, m);
      }
      return send(res, 200, { reply });
    }

    if (M === 'POST' && p === '/api/image/generate') {
      const d = await userFromReq(req);
      rateLimit('img:' + d.uid, 20, 60_000);
      const b = await body(req);
      const prompt = String(b.prompt || '').trim().slice(0, 4000);
      if (!prompt) return send(res, 400, { error: 'اكتب وصف الصورة أولًا.' });
      const size = /^\d{3,4}x\d{3,4}$/.test(String(b.size || '')) ? b.size : '1024x1024';
      let url, firstErr;
      if (XKIRO_API_KEY) { try { url = await xkiroImage(prompt, size); } catch (e) { firstErr = e; } }
      if (!url) {
        try { url = await geminiImage(prompt); }
        catch (e) { throw new Error(firstErr ? `${firstErr.message} | ${e.message}` : e.message); }
      }
      return send(res, 200, { url });
    }

    if (M === 'POST' && p === '/api/tts') {
      const d = await userFromReq(req);
      const b = await body(req);
      if (!GEMINI_API_KEY) return send(res, 503, { error: 'Gemini TTS غير مضبوط على الخادم.' });
      if (!b.input) return send(res, 400, { error: 'لا يوجد نص.' });
      const payload = {
        model: /^gemini-[\w.\-]*tts[\w.\-]*$/.test(String(b.model || '')) ? b.model : 'gemini-3.8-flash-tts',
        input: b.input,
        response_format: b.response_format || { type: 'audio' },
        ...(b.generation_config ? { generation_config: b.generation_config } : {}),
      };
      const u = await charge(d.uid, 1, 'voice');
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }, body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error?.message || 'Gemini TTS error');
        const audio = extractAudio(data);
        if (!audio) throw new Error('Gemini لم يرجع ملفًا صوتيًا.');
        return send(res, 200, { ...audio, points: u.points });
      } catch (e) {
        const back = await refund(d.uid, 1, 'voice').catch(() => u);
        return send(res, 500, { error: e.message, refunded: true, points: back.points });
      }
    }

    if (M === 'POST' && p === '/api/json2video/render') {
      const d = await userFromReq(req);
      const b = await body(req);
      if (!JSON2VIDEO_API_KEY) return send(res, 503, { error: 'JSON2VIDEO_API_KEY غير مضبوط على الخادم. أضفه في Environment ثم أعد النشر.' });
      const title = String(b.title || 'Hilal AI montage').trim().slice(0, 120);
      const prompt = String(b.prompt || '').trim().slice(0, 4000);
      const ratio = ['16:9','9:16','1:1'].includes(String(b.aspect_ratio)) ? String(b.aspect_ratio) : '16:9';
      const resolution = ratio === '9:16' ? 'vertical' : ratio === '1:1' ? 'square' : 'full-hd';
      const scenesIn = Array.isArray(b.scenes) ? b.scenes.slice(0, 20) : [];
      const cleanScenes = scenesIn.map((sc, i) => {
        const duration = Math.min(10, Math.max(1, Number(sc.duration) || 10));
        const elements = [];
        const src = String(sc.src || '').trim();
        const type = String(sc.mediaType || 'image');
        if (src && /^https:\/\//i.test(src)) elements.push(type === 'video' ? { type: 'video', src, duration } : { type: 'image', src, duration });
        const txt = String(sc.text || '').trim().slice(0, 1500);
        if (txt) elements.push({ type: 'text', text: txt, duration, style: '003', 'font-size': 48, 'font-color': '#ffffff', 'background-color': '#00000080' });
        if (!elements.length) elements.push({ type: 'text', text: prompt || `مشهد ${i+1}`, duration, style: '003', 'font-size': 42, 'font-color': '#ffffff' });
        return { comment: String(sc.title || `Scene ${i+1}`).slice(0,100), duration, elements };
      });
      const movie = { resolution, quality: 'high', scenes: cleanScenes.length ? cleanScenes : [{ comment: title, duration: 10, elements: [{ type: 'text', text: prompt || title, duration: 10, style: '003', 'font-size': 48, 'font-color': '#ffffff' }] }] };
      const payload = JSON2VIDEO_TEMPLATE_ID && b.useTemplate === true ? { template: JSON2VIDEO_TEMPLATE_ID, variables: { title, prompt } } : movie;
      const u = await charge(d.uid, 1, 'video');
      try {
        const r = await fetch('https://api.json2video.com/v2/movies', { method: 'POST', headers: { 'x-api-key': JSON2VIDEO_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.success === false) throw new Error(data?.message || data?.error || `JSON2Video رفض الطلب (${r.status})`);
        const project = String(data.project || data.projectId || '');
        if (!project) throw new Error('JSON2Video لم يُرجع رقم المشروع.');
        json2videoJobs.set(project, { uid: d.uid, refunded: false, ts: Date.now() });
        return send(res, 200, { id: project, project, status: 'processing', points: u.points, provider: 'json2video' });
      } catch (e) {
        const back = await refund(d.uid, 1, 'video').catch(() => u);
        return send(res, 502, { error: e.message, refunded: true, points: back.points });
      }
    }

    if (M === 'POST' && p === '/api/json2video/status') {
      const d = await userFromReq(req);
      const b = await body(req);
      const project = String(b.project || b.jobId || '').trim();
      if (!/^[\w-]{4,100}$/.test(project)) return send(res, 400, { error: 'رقم مشروع JSON2Video غير صالح.' });
      if (!JSON2VIDEO_API_KEY) return send(res, 503, { error: 'JSON2VIDEO_API_KEY غير مضبوط على الخادم.' });
      const tracked = json2videoJobs.get(project);
      if (!tracked || tracked.uid !== d.uid) return send(res, 403, { error: 'هذا المشروع غير مرتبط بحسابك.' });
      const r = await fetch(`https://api.json2video.com/v2/movies?project=${encodeURIComponent(project)}`, { headers: { 'x-api-key': JSON2VIDEO_API_KEY } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: data?.message || data?.error || `خطأ JSON2Video (${r.status})` });
      const movieData = data.movie || data;
      const raw = String(movieData.status || data.status || '').toLowerCase();
      const url = String(movieData.url || movieData.video_url || '');
      const failed = ['failed','error','cancelled'].includes(raw) || movieData.success === false;
      const completed = ['done','completed','success','succeeded'].includes(raw) || (!!url && !raw);
      if (failed && !tracked.refunded) {
        tracked.refunded = true;
        const u = await refund(d.uid, 1, 'video').catch(() => null);
        return send(res, 200, { status: 'failed', error: movieData.message || movieData.error || 'فشل تركيب الفيديو.', refunded: true, points: u?.points });
      }
      return send(res, 200, { status: completed && url ? 'completed' : (failed ? 'failed' : 'processing'), result: url ? { video_url: url } : {}, message: movieData.message || '', points: (await getUser(d.uid))?.points });
    }

    if (M === 'POST' && p === '/api/apiframe/video') {
      const d = await userFromReq(req);
      const b = await body(req);
      const prompt = String(b.prompt || '').trim().slice(0, 4000);
      if (!prompt) return send(res, 400, { error: 'اكتب وصف الفيديو أولًا.' });
      if (!APIFRAME_API_KEY) return send(res, 503, { error: 'APIFRAME_API_KEY غير مضبوط على الخادم. أضفه في Environment ثم أعد النشر.' });
      const allowed = new Set(['kling-3.0','kling-2.6','seedance-1-pro-fast','seedance-1-lite','veo-3.1-fast','wan-2.5-fast','sora-2']);
      const model = allowed.has(String(b.model || '')) ? String(b.model) : 'kling-3.0';
      const duration = Math.min(10, Math.max(3, Number(b.duration) || 10));
      const ratio = ['16:9','9:16','1:1'].includes(String(b.aspect_ratio)) ? String(b.aspect_ratio) : '16:9';
      const mode = ['720p','standard'].includes(String(b.resolution)) ? 'standard' : 'pro';
      const u = await charge(d.uid, 1, 'video');
      try {
        const payload = { model, prompt };
        if (model.startsWith('kling-')) payload.klingParams = { duration, mode, aspect_ratio: ratio, generate_audio: true };
        else if (model.startsWith('seedance-')) payload.seedanceParams = { duration, resolution: mode === 'pro' ? '1080p' : '720p', aspect_ratio: ratio, generate_audio: true };
        else if (model.startsWith('veo-')) payload.veoParams = { duration, aspect_ratio: ratio, resolution: mode === 'pro' ? '1080p' : '720p' };
        else if (model.startsWith('wan-')) payload.wanParams = { duration, resolution: mode === 'pro' ? '1080p' : '720p', aspect_ratio: ratio };
        else if (model === 'sora-2') payload.soraParams = { duration, aspect_ratio: ratio, resolution: mode === 'pro' ? '1080p' : '720p' };
        const r = await fetch('https://api.apiframe.ai/v2/videos/generate', { method: 'POST', headers: { 'X-API-Key': APIFRAME_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error || data?.message || `Apiframe رفض الطلب (${r.status})${r.status === 402 ? ' — رصيد Apiframe غير كافٍ' : ''}`);
        const jobId = String(data.jobId || data.id || '');
        if (!jobId) throw new Error('Apiframe لم يُرجع رقم مهمة.');
        apiframeJobs.set(jobId, { uid: d.uid, refunded: false, ts: Date.now() });
        return send(res, 200, { id: jobId, jobId, status: String(data.status || 'QUEUED').toLowerCase(), points: u.points, provider: 'apiframe', model });
      } catch (e) {
        const back = await refund(d.uid, 1, 'video').catch(() => u);
        return send(res, 502, { error: e.message, refunded: true, points: back.points });
      }
    }

    if (M === 'POST' && p === '/api/apiframe/job') {
      const d = await userFromReq(req);
      const b = await body(req);
      const jobId = String(b.jobId || '');
      if (!/^[\w-]{4,100}$/.test(jobId)) return send(res, 400, { error: 'رقم المهمة غير صالح.' });
      if (!APIFRAME_API_KEY) return send(res, 503, { error: 'APIFRAME_API_KEY غير مضبوط على الخادم.' });
      const tracked = apiframeJobs.get(jobId);
      if (!tracked || tracked.uid !== d.uid) return send(res, 403, { error: 'هذه المهمة غير مرتبطة بحسابك.' });
      const r = await fetch(`https://api.apiframe.ai/v2/jobs/${encodeURIComponent(jobId)}`, { headers: { 'X-API-Key': APIFRAME_API_KEY } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: data?.error || `خطأ Apiframe (${r.status})` });
      const rawStatus = String(data.status || '').toUpperCase();
      const failed = ['FAILED','ERROR','CANCELLED'].includes(rawStatus);
      const completed = ['COMPLETED','SUCCEEDED','SUCCESS','DONE'].includes(rawStatus);
      const result = data.result || {};
      const videoUrl = result.videoUrl || result.video_url || data.videoUrl || data.video_url || (Array.isArray(result.videos) ? result.videos[0] : '') || (Array.isArray(data.videos) ? data.videos[0] : '');
      if (failed && !tracked.refunded) {
        tracked.refunded = true;
        try { const u = await refund(d.uid, 1, 'video'); return send(res, 200, { status: 'failed', error: data.error || data.message || 'فشل توليد الفيديو عبر Apiframe.', refunded: true, points: u.points }); }
        catch { tracked.refunded = false; }
      }
      return send(res, 200, { status: completed && videoUrl ? 'completed' : (failed ? 'failed' : 'processing'), result: videoUrl ? { video_url: videoUrl } : result, error: data.error || data.message, points: (await getUser(d.uid))?.points });
    }

    if (M === 'POST' && p === '/api/ltx/video') {
      const d = await userFromReq(req);
      const b = await body(req);
      const prompt = String(b.prompt || '').trim().slice(0, 6000);
      if (!prompt) return send(res, 400, { error: 'اكتب وصف الفيديو أولًا.' });
      if (!LTX_API_KEY) return send(res, 503, { error: 'LTX_API_KEY غير مضبوط على الخادم.' });
      const model = /^ltx-[\w.\-]+$/.test(String(b.model || '')) ? b.model : 'ltx-2-5-pro';
      const resolution = /^\d{3,4}x\d{3,4}$/.test(String(b.resolution || '')) ? b.resolution : '1280x720';
      const duration = Math.min(10, Math.max(1, Number(b.duration) || 10));
      const u = await charge(d.uid, 1, 'video');
      try {
        const r = await fetch('https://api.ltx.io/v2/text-to-video', {
          method: 'POST', headers: { Authorization: `Bearer ${LTX_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, model, duration, resolution }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(ltxMsg(data, r, 'LTX'));
        if (data?.id) ltxJobs.set(String(data.id), { uid: d.uid, refunded: false, ts: Date.now() });
        return send(res, 200, { ...data, points: u.points });
      } catch (e) {
        const back = await refund(d.uid, 1, 'video').catch(() => u);
        return send(res, 500, { error: e.message, refunded: true, points: back.points });
      }
    }

    if (M === 'POST' && p === '/api/ltx/job') {
      const d = await userFromReq(req);
      const b = await body(req);
      const jobId = String(b.jobId || '');
      if (!/^[\w\-]{4,100}$/.test(jobId)) return send(res, 400, { error: 'رقم المهمة غير صالح.' });
      if (!LTX_API_KEY) return send(res, 503, { error: 'LTX_API_KEY غير مضبوط على الخادم.' });
      const r = await fetch(`https://api.ltx.io/v2/text-to-video/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${LTX_API_KEY}` } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: ltxMsg(data, r, 'LTX job') });
      if (data?.status === 'failed') {
        const j = ltxJobs.get(jobId);
        if (j && j.uid === d.uid && !j.refunded) {
          j.refunded = true;
          try { const u = await refund(d.uid, 1, 'video'); data.refunded = true; data.points = u.points; } catch { j.refunded = false; }
        }
      }
      return send(res, 200, data);
    }

    /* ----- storefront and editable admin contact settings ----- */
    if (M === 'GET' && p === '/api/site-settings') {
      const settings = await readSiteSettings();
      let whatsapp = String(settings.whatsapp || '201035089566').replace(/\D/g, '');
      if (whatsapp.startsWith('0')) whatsapp = '20' + whatsapp.slice(1);
      return send(res, 200, { settings: { whatsapp } });
    }
    if (M === 'POST' && p === '/api/admin/site-settings') {
      await requireAdmin(req);
      const b = await body(req); let whatsapp = String(b.whatsapp || '').replace(/\D/g, '');
      if (whatsapp.startsWith('0')) whatsapp = '20' + whatsapp.slice(1);
      if (whatsapp.length < 10 || whatsapp.length > 15) throw httpError('أدخل رقم واتساب بصيغة دولية صحيحة مثل 201035089566.', 400);
      const current = await readSiteSettings();
      await writeSiteSettings({ ...current, whatsapp, updatedAt: new Date().toISOString() });
      return send(res, 200, { ok: true, whatsapp });
    }
    if (M === 'GET' && p === '/api/shop/products') {
      const products = (await readStoreProducts()).filter(x => x.active !== false).slice(0, 500);
      return send(res, 200, { products });
    }
    if (M === 'POST' && p === '/api/admin/shop/products') {
      await requireAdmin(req); const b = await body(req);
      const name = String(b.name || '').trim().slice(0, 160), category = String(b.category || 'منتجات أخرى').slice(0, 50);
      const price = Number(b.price);
      if (!name || !Number.isFinite(price) || price < 0) throw httpError('اسم المنتج والسعر مطلوبان.', 400);
      const rec = { id: 'prd_' + crypto.randomUUID(), name, category, price, image: String(b.image || '').slice(0, 720000), description: String(b.description || '').slice(0, 2000), active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await writeStoreProduct(rec);
      return send(res, 200, { ok: true, product: rec });
    }
    if (M === 'PUT' && p.startsWith('/api/admin/shop/products/')) {
      await requireAdmin(req); const id = decodeURIComponent(p.split('/').pop()), b = await body(req);
      const products = await readStoreProducts(), old = products.find(x => x.id === id);
      if (!old) throw httpError('المنتج غير موجود.', 404);
      const price = Number(b.price); if (!String(b.name || '').trim() || !Number.isFinite(price) || price < 0) throw httpError('اسم المنتج والسعر مطلوبان.', 400);
      const rec = { ...old, name: String(b.name).trim().slice(0,160), category: String(b.category || 'منتجات أخرى').slice(0,50), price, image: String(b.image || '').slice(0,720000), description: String(b.description || '').slice(0,2000), updatedAt: new Date().toISOString() };
      await writeStoreProduct(rec); return send(res, 200, { ok: true, product: rec });
    }
    if (M === 'DELETE' && p.startsWith('/api/admin/shop/products/')) {
      await requireAdmin(req); const id = decodeURIComponent(p.split('/').pop()), products = await readStoreProducts();
      if (!products.some(x => x.id === id)) throw httpError('المنتج غير موجود.', 404);
      await removeStoreProduct(id); return send(res, 200, { ok: true });
    }

    /* ----- password change requests: admin approval required ----- */
    if (M === 'POST' && p === '/api/password-change/request') {
      const d = await userFromReq(req), b = await body(req);
      const newPassword = String(b.newPassword || '');
      if (newPassword.length < 6 || newPassword.length > 200) throw httpError('كلمة المرور يجب أن تكون بين 6 و200 حرف.', 400);
      const all = readJson(fallback('password-change-requests.json'), []);
      if (all.some(x => x.uid === d.uid && x.status === 'pending')) throw httpError('لديك طلب تغيير كلمة مرور قيد المراجعة بالفعل.', 409);
      const ph = await hashPassword(newPassword);
      const rec = { id: 'pwc_' + crypto.randomUUID(), uid: d.uid, phone: d.phone, name: d.name, passwordHash: ph.hash, passwordSalt: ph.salt, status: 'pending', createdAt: new Date().toISOString() };
      all.unshift(rec); writeJson(fallback('password-change-requests.json'), all);
      return send(res, 200, { ok: true, id: rec.id });
    }
    if (M === 'GET' && p === '/api/admin/password-change/requests') {
      await requireAdmin(req);
      const requests = readJson(fallback('password-change-requests.json'), []).map(({passwordHash,passwordSalt,...x})=>x).slice(0,200);
      return send(res, 200, { requests });
    }
    if (M === 'POST' && p === '/api/admin/password-change/review') {
      const admin = await requireAdmin(req), b = await body(req), all = readJson(fallback('password-change-requests.json'), []);
      const rec = all.find(x => x.id === String(b.id || ''));
      if (!rec) throw httpError('طلب تغيير كلمة المرور غير موجود.', 404);
      if (rec.status !== 'pending') throw httpError('تمت مراجعة الطلب بالفعل.', 409);
      if (b.approve) {
        const u = await getUser(rec.uid); if (!u) throw httpError('الحساب غير موجود.', 404);
        u.passwordHash = rec.passwordHash; u.passwordSalt = rec.passwordSalt; await saveUser(u); rec.status = 'approved';
      } else rec.status = 'rejected';
      rec.reviewedAt = new Date().toISOString(); rec.reviewedBy = admin.phone; writeJson(fallback('password-change-requests.json'), all);
      return send(res, 200, { ok: true, status: rec.status });
    }

    /* ----- static ----- */
    if (p.startsWith('/api/')) return send(res, 404, { error: 'المسار غير موجود.' });
    if ((M === 'GET' || M === 'HEAD') && p === '/favicon.ico') return send(res, 204, {});
    if (M === 'GET' || M === 'HEAD') {
      if (!fs.existsSync(INDEX_FILE)) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (M === 'HEAD') return res.end();
      return fs.createReadStream(INDEX_FILE).pipe(res);
    }
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || String(e) });
    else res.end();
  }
}

// Run as a traditional Node server on Render/local; Vercel imports handleRequest.
if (process.env.VERCEL !== '1') {
  const server = http.createServer(handleRequest);
  server.listen(PORT, '0.0.0.0', () => console.log(`الهلال AI running on port ${PORT}`));
}
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
