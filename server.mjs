import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

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
function normalizePhone(v) {
  let s = String(v || '')
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[^\d+]/g, '');
  if (/^(\+20|0020|20)1\d{9}$/.test(s)) s = '0' + s.replace(/^(\+20|0020|20)/, '');
  return s.replace(/\+/g, '');
}

const PORT = Number(process.env.PORT || 8787);
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL غير مضبوط في متغيرات البيئة!');
}
const sql = neon(DATABASE_URL);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const LTX_API_KEY = process.env.LTX_API_KEY || '';
const XKIRO_API_KEY = process.env.XKIRO_API_KEY || '';
const APIFRAME_API_KEY = (process.env.APIFRAME_API_KEY || '').trim();
const MAGIC_HOUR_API_KEY = (process.env.MAGIC_HOUR_API_KEY || '').trim();
const TAVUS_API_KEY = (process.env.TAVUS_API_KEY || '').trim();
const RUNWAY_API_KEY = (process.env.RUNWAY_API_KEY || '').trim();
const WAN_API_KEY = (process.env.WAN_API_KEY || '').trim();
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || '01035089566');
const ADMIN_INITIAL_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || '';
const SESSION_SECRET = (process.env.SESSION_SECRET || 'default-session-secret-change-me-in-production-128-chars').trim();

/* ───────────────────────── Neon Database Migration ───────────────────────── */
async function initDb() {
  if (!DATABASE_URL) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        uid VARCHAR(255) PRIMARY KEY,
        phone VARCHAR(100),
        email VARCHAR(255),
        name VARCHAR(255),
        points INT DEFAULT 0,
        red_points INT DEFAULT 0,
        used JSONB DEFAULT '{}'::jsonb,
        password_hash TEXT,
        password_salt TEXT,
        admin BOOLEAN DEFAULT FALSE,
        unlimited_until BIGINT DEFAULT 0,
        redeem_log JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS browser_bindings (
        browser_id VARCHAR(255) PRIMARY KEY,
        uid VARCHAR(255) REFERENCES users(uid) ON DELETE CASCADE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(255) PRIMARY KEY,
        uid VARCHAR(255) REFERENCES users(uid) ON DELETE CASCADE,
        type VARCHAR(50),
        name VARCHAR(255),
        description TEXT,
        icon VARCHAR(10),
        data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        date_str VARCHAR(100)
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS payments (
        id VARCHAR(255) PRIMARY KEY,
        uid VARCHAR(255) REFERENCES users(uid) ON DELETE CASCADE,
        email VARCHAR(255),
        package_id VARCHAR(100),
        coins INT,
        price NUMERIC,
        unlimited_ms BIGINT DEFAULT 0,
        transaction_ref VARCHAR(255) UNIQUE,
        status VARCHAR(50) DEFAULT 'pending',
        reviewed_at TIMESTAMPTZ,
        reviewed_by VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS redeemed_codes (
        code VARCHAR(100) PRIMARY KEY,
        uid VARCHAR(255) REFERENCES users(uid) ON DELETE CASCADE,
        coins INT,
        redeemed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS red_videos (
        id VARCHAR(255) PRIMARY KEY,
        uid VARCHAR(255) REFERENCES users(uid) ON DELETE CASCADE,
        phone VARCHAR(100),
        name VARCHAR(255),
        note TEXT,
        mime_type VARCHAR(100),
        size BIGINT,
        file_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        awarded INT DEFAULT 0,
        reviewed_at TIMESTAMPTZ,
        reviewed_by VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS red_point_requests (
        id VARCHAR(255) PRIMARY KEY,
        uid VARCHAR(255) REFERENCES users(uid) ON DELETE CASCADE,
        phone VARCHAR(100),
        amount INT,
        type VARCHAR(50),
        status VARCHAR(50) DEFAULT 'pending',
        awarded INT DEFAULT 0,
        reviewed_at TIMESTAMPTZ,
        reviewed_by VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS password_change_requests (
        id VARCHAR(255) PRIMARY KEY,
        uid VARCHAR(255) REFERENCES users(uid) ON DELETE CASCADE,
        phone VARCHAR(100),
        name VARCHAR(255),
        password_hash TEXT,
        password_salt TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        reviewed_at TIMESTAMPTZ,
        reviewed_by VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    console.log('✅ Neon Postgres database initialized successfully.');
  } catch (err) {
    console.error('❌ Failed to initialize Neon Postgres database:', err);
  }
}
initDb();

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

async function body(req, limit = 8 * 1024 * 1024) {
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

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/* ───────────────────────── auth & database access ───────────────────────── */
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
function publicUser(u) {
  if (!u) return u;
  const { passwordHash, passwordSalt, ...rest } = u;
  return rest;
}
const isAdminUser = u =>
  !!(u && (u.admin ||
    (ADMIN_EMAIL && String(u.email || '').toLowerCase() === ADMIN_EMAIL) ||
    (ADMIN_PHONE && normalizePhone(u.phone) === ADMIN_PHONE)));

function mapUserFromDb(row) {
  if (!row) return null;
  return {
    uid: row.uid,
    phone: row.phone || '',
    email: row.email || '',
    name: row.name || 'عضو الهلال AI',
    points: Number(row.points) || 0,
    redPoints: Number(row.red_points) || 0,
    used: row.used || { video: 0, voice: 0 },
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    admin: !!row.admin,
    unlimitedUntil: Number(row.unlimited_until) || 0,
    redeemLog: row.redeem_log || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
  };
}

async function getUser(uid) {
  const rows = await sql`SELECT * FROM users WHERE uid = ${uid}`;
  return mapUserFromDb(rows[0]);
}

async function saveUser(u) {
  await sql`
    INSERT INTO users (
      uid, phone, email, name, points, red_points, used,
      password_hash, password_salt, admin, unlimited_until, redeem_log, created_at
    ) VALUES (
      ${u.uid}, ${u.phone || ''}, ${u.email || ''}, ${u.name || ''},
      ${Number(u.points) || 0}, ${Number(u.redPoints) || 0}, ${JSON.stringify(u.used || {})},
      ${u.passwordHash || null}, ${u.passwordSalt || null}, ${!!u.admin},
      ${Number(u.unlimitedUntil) || 0}, ${JSON.stringify(u.redeemLog || {})},
      ${u.createdAt ? new Date(u.createdAt) : new Date()}
    )
    ON CONFLICT (uid) DO UPDATE SET
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      points = EXCLUDED.points,
      red_points = EXCLUDED.red_points,
      used = EXCLUDED.used,
      password_hash = EXCLUDED.password_hash,
      password_salt = EXCLUDED.password_salt,
      admin = EXCLUDED.admin,
      unlimited_until = EXCLUDED.unlimited_until,
      redeem_log = EXCLUDED.redeem_log;
  `;
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
  
  const existing = await sql`SELECT uid FROM browser_bindings WHERE browser_id = ${browserId}`;
  if (existing.length > 0 && existing[0].uid !== uid) throw conflict;

  await sql`
    INSERT INTO browser_bindings (browser_id, uid, updated_at)
    VALUES (${browserId}, ${uid}, NOW())
    ON CONFLICT (browser_id) DO UPDATE SET uid = EXCLUDED.uid, updated_at = NOW();
  `;
}

/* ───────────────────────── coins ───────────────────────── */
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
  const rows = await sql`SELECT * FROM projects WHERE uid = ${uid} ORDER BY created_at DESC LIMIT 200`;
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    name: r.name,
    desc: r.description,
    icon: r.icon,
    data: r.data,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    date: r.date_str
  }));
}

async function saveProject(uid, p) {
  if (JSON.stringify(p).length > 900_000) throw httpError('المشروع كبير جدًا للحفظ.', 413);
  await sql`
    INSERT INTO projects (id, uid, type, name, description, icon, data, created_at, date_str)
    VALUES (
      ${p.id}, ${uid}, ${p.type || 'chat'}, ${p.name || ''}, ${p.desc || ''},
      ${p.icon || '📁'}, ${JSON.stringify(p.data ?? null)},
      ${p.createdAt ? new Date(p.createdAt) : new Date()}, ${p.date || ''}
    )
    ON CONFLICT (id) DO UPDATE SET
      type = EXCLUDED.type,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      icon = EXCLUDED.icon,
      data = EXCLUDED.data,
      date_str = EXCLUDED.date_str;
  `;
  return p;
}

async function deleteProjectStore(uid, id) {
  await sql`DELETE FROM projects WHERE id = ${id} AND uid = ${uid}`;
}

/* ───────────────────────── payments ───────────────────────── */
const PACKS = { p_100:{coins:100,price:10},p_500:{coins:500,price:35},p_1000:{coins:1000,price:60},p_2500:{coins:2500,price:120},p_5000:{coins:5000,price:220},p_10000:{coins:10000,price:390},p_15000:{coins:15000,price:550},p_25000:{coins:25000,price:850},p_40000:{coins:40000,price:1250},p_60000:{coins:60000,price:1700},p_100000:{coins:100000,price:2500},p_150000:{coins:150000,price:3400},p_250000:{coins:250000,price:5100},p_400000:{coins:400000,price:7200},p_600000:{coins:600000,price:9800},p_1000000:{coins:1000000,price:14500},p_daily:{coins:0,price:125,unlimitedMs:86400000},p_weekly:{coins:0,price:750,unlimitedMs:7*86400000},p_monthly:{coins:0,price:3750,unlimitedMs:30*86400000},p_yearly:{coins:0,price:7500,unlimitedMs:365*86400000} };

function mapPaymentFromDb(r) {
  if (!r) return null;
  return {
    id: r.id,
    uid: r.uid,
    email: r.email,
    packageId: r.package_id,
    coins: Number(r.coins),
    price: Number(r.price),
    unlimitedMs: Number(r.unlimited_ms),
    transactionRef: r.transaction_ref,
    status: r.status,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    reviewedBy: r.reviewed_by,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
  };
}

async function listPayments() {
  const rows = await sql`SELECT * FROM payments ORDER BY created_at DESC LIMIT 500`;
  return rows.map(mapPaymentFromDb);
}

async function listPaymentsByUid(uid) {
  const rows = await sql`SELECT * FROM payments WHERE uid = ${uid} ORDER BY created_at DESC LIMIT 50`;
  return rows.map(mapPaymentFromDb);
}

async function getPayment(id) {
  const rows = await sql`SELECT * FROM payments WHERE id = ${id}`;
  return mapPaymentFromDb(rows[0]);
}

async function findPaymentByRef(ref) {
  const rows = await sql`SELECT * FROM payments WHERE transaction_ref = ${ref} AND status != 'rejected'`;
  return mapPaymentFromDb(rows[0]);
}

async function updatePayment(rec) {
  await sql`
    UPDATE payments SET
      status = ${rec.status},
      reviewed_at = ${rec.reviewedAt ? new Date(rec.reviewedAt) : null},
      reviewed_by = ${rec.reviewedBy || null}
    WHERE id = ${rec.id}
  `;
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
    await sql`
      INSERT INTO payments (id, uid, email, package_id, coins, price, unlimited_ms, transaction_ref, status, created_at)
      VALUES (
        ${rec.id}, ${rec.uid}, ${rec.email}, ${rec.packageId}, ${rec.coins},
        ${rec.price}, ${rec.unlimitedMs}, ${rec.transactionRef}, ${rec.status}, ${new Date(rec.createdAt)}
      )
    `;
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
const REDEEM_CODES = Object.freeze({
  A123: 10000, B456: 10000, C789: 10000, D321: 10000, E654: 10000, F987: 10000, G111: 10000, H222: 10000, I333: 10000, J444: 10000,
  K555: 100, L666: 100, M777: 100, N888: 100, O999: 100, P102: 100, Q304: 100, R506: 100, S708: 100, T901: 100, U234: 100, V567: 100, W890: 100, X135: 100, Y246: 100, Z357: 100, A468: 100, B579: 100, C680: 100, D791: 100,
  E802: 1000, F913: 1000, G024: 1000, H135: 1000, I246: 1000, J357: 1000, K468: 1000, L579: 1000, M680: 1000, N791: 1000, O112: 1000, P223: 1000, Q334: 1000, R445: 1000, S556: 1000, T667: 1000, U778: 1000, V889: 1000, W990: 1000, X147: 1000,
});
const REDEEM_GLOBAL_ONCE = new Set(Object.keys(REDEEM_CODES).filter(c => REDEEM_CODES[c] !== 10000));

async function claimGlobalCode(code, uid, amount) {
  try {
    await sql`
      INSERT INTO redeemed_codes (code, uid, coins, redeemed_at)
      VALUES (${code}, ${uid}, ${amount}, NOW())
    `;
  } catch (e) {
    if (e?.code === '23505' || /unique|already exists/i.test(e?.message || '')) {
      throw httpError('هذا الكود تم استخدامه بالفعل.', 409);
    }
    throw e;
  }
}

async function releaseGlobalCode(code) {
  try {
    await sql`DELETE FROM redeemed_codes WHERE code = ${code}`;
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
setInterval(() => { const old = Date.now() - 24 * 3600_000; for (const [k, j] of ltxJobs) if (j.ts < old) ltxJobs.delete(k); }, 3600_000).unref();
const ltxMsg = (data, r, label) => (typeof data?.error === 'string' ? data.error : data?.error?.message) || data?.message || `${label} (${r.status})`;

/* ───────────────────────── config ───────────────────────── */
function publicConfig() {
  return {
    phonePasswordReady: true,
    persistentStorage: true,
    googleReady: false,
  };
}

/* ───────────────────────── routes ───────────────────────── */
const INDEX_FILE = path.join(__dirname, 'index.html');
const redVideoDir = path.join(__dirname, 'data', 'red-videos');
try { fs.mkdirSync(redVideoDir, { recursive: true }); } catch {}

function mapRedVideoFromDb(r) {
  if (!r) return null;
  return {
    id: r.id,
    uid: r.uid,
    phone: r.phone,
    name: r.name,
    note: r.note,
    mimeType: r.mime_type,
    size: Number(r.size),
    fileName: r.file_name,
    status: r.status,
    awarded: Number(r.awarded),
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    reviewedBy: r.reviewed_by,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
  };
}

const server = http.createServer(async (req, res) => {
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
        ok: true, googleReady: false, persistentStorage: true,
        ...(admin ? { geminiConfigured: !!GEMINI_API_KEY, ltxConfigured: !!LTX_API_KEY, xkiroConfigured: !!XKIRO_API_KEY, apiframeConfigured: !!APIFRAME_API_KEY, magicHourConfigured: !!MAGIC_HOUR_API_KEY, tavusConfigured: !!TAVUS_API_KEY, runwayConfigured: !!RUNWAY_API_KEY, wanConfigured: !!WAN_API_KEY } : {}),
      });
    }

    /* ----- automatic browser-only identity ----- */
    if (M === 'POST' && p === '/api/auth/browser') {
      const b = await body(req);
      const browserId = String(b.browserId || '').trim();
      if (!/^[a-zA-Z0-9_-]{16,100}$/.test(browserId)) return send(res, 400, { error: 'معرّف المتصفح غير صالح. حدّث الصفحة وحاول مرة أخرى.' });
      
      const bindings = await sql`SELECT uid FROM browser_bindings WHERE browser_id = ${browserId}`;
      let uid = bindings[0]?.uid || null;

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
      const phone = normalizePhone(b.phone), password = String(b.password || '');
      const name = String(b.name || 'عضو الهلال AI').trim().slice(0, 80) || 'عضو الهلال AI';
      if (ADMIN_PHONE && phone === ADMIN_PHONE) return send(res, 403, { error: 'رقم المالك مخصص لحساب الإدارة. اضبط ADMIN_INITIAL_PASSWORD على السيرفر ثم سجّل الدخول.' });
      if (!/^01[0125]\d{8}$/.test(phone)) return send(res, 400, { error: 'أدخل رقم هاتف مصري صحيح.' });
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

    if (M === 'POST' && p === '/api/auth/login') {
      const ip = clientIp(req);
      rateLimit('login-ip:' + ip, 30, 15 * 60_000);
      const b = await body(req);
      const phone = normalizePhone(b.phone), password = String(b.password || '');
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
      await sql`
        INSERT INTO red_videos (id, uid, phone, name, note, mime_type, size, file_name, status, awarded, created_at)
        VALUES (${rec.id}, ${rec.uid}, ${rec.phone}, ${rec.name}, ${rec.note}, ${rec.mimeType}, ${rec.size}, ${rec.fileName}, ${rec.status}, ${rec.awarded}, NOW())
      `;
      return send(res, 200, { ok: true, id, size });
    }
    if (M === 'POST' && p === '/api/red-videos') {
      const d=await userFromReq(req), b=await body(req,8*1024*1024);
      const mime=String(b.mimeType||''); if(!mime.startsWith('video/')) throw httpError('الملف يجب أن يكون فيديو.',400);
      const raw=Buffer.from(String(b.data||''),'base64'); if(!raw.length||raw.length>5*1024*1024) throw httpError('حجم الفيديو يجب ألا يتجاوز 5MB.',413);
      const id='rv_'+crypto.randomUUID(), ext=({ 'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov' })[mime]||'.video';
      fs.writeFileSync(path.join(redVideoDir,id+ext),raw);
      const rec={id,uid:d.uid,phone:d.phone||'',name:String(b.name||'video').slice(0,180),note:String(b.note||'').slice(0,1000),mimeType:mime,size:raw.length,fileName:id+ext,status:'pending',awarded:0,createdAt:new Date().toISOString()};
      await sql`
        INSERT INTO red_videos (id, uid, phone, name, note, mime_type, size, file_name, status, awarded, created_at)
        VALUES (${rec.id}, ${rec.uid}, ${rec.phone}, ${rec.name}, ${rec.note}, ${rec.mimeType}, ${rec.size}, ${rec.fileName}, ${rec.status}, ${rec.awarded}, NOW())
      `;
      return send(res,200,{ok:true,id});
    }
    if (M === 'GET' && p === '/api/admin/red-videos') {
      await requireAdmin(req);
      const rows = await sql`SELECT * FROM red_videos ORDER BY created_at DESC LIMIT 100`;
      return send(res,200,{requests: rows.map(mapRedVideoFromDb)});
    }
    if (M === 'GET' && p.startsWith('/api/admin/red-videos/') && p.endsWith('/file')) {
      await requireAdmin(req); const id=decodeURIComponent(p.split('/')[4]||'');
      const rows = await sql`SELECT * FROM red_videos WHERE id = ${id}`;
      const rec = mapRedVideoFromDb(rows[0]);
      if(!rec)throw httpError('الفيديو غير موجود.',404);
      const file=path.join(redVideoDir,rec.fileName); if(!fs.existsSync(file))throw httpError('ملف الفيديو غير متاح على الخادم.',404);
      res.writeHead(200,{'Content-Type':rec.mimeType||'video/mp4','Cache-Control':'no-store','Content-Length':fs.statSync(file).size}); return fs.createReadStream(file).pipe(res);
    }
    if (M === 'POST' && p === '/api/admin/red-videos/review') {
      const admin=await requireAdmin(req), b=await body(req);
      const rows = await sql`SELECT * FROM red_videos WHERE id = ${String(b.id||'')}`;
      const rec = mapRedVideoFromDb(rows[0]);
      if(!rec)throw httpError('الطلب غير موجود.',404); if(rec.status!=='pending')throw httpError('تمت مراجعة الطلب بالفعل.',409);
      if(b.approve){
        const award=Math.floor(Number(b.award)||0);if(award<1||award>1000000)throw httpError('عدد النقاط غير صالح.',400);
        const u=await getUser(rec.uid);if(!u)throw httpError('الحساب غير موجود.',404);
        u.redPoints=(Number(u.redPoints)||0)+award;await saveUser(u);
        rec.status='approved';rec.awarded=award;
      }else rec.status='rejected';
      
      await sql`
        UPDATE red_videos SET
          status = ${rec.status},
          awarded = ${rec.awarded},
          reviewed_at = NOW(),
          reviewed_by = ${admin.phone}
        WHERE id = ${rec.id}
      `;
      return send(res,200,{ok:true,status:rec.status,awarded:rec.awarded});
    }
    if (M === 'POST' && p === '/api/red-points/request') {
      const d=await userFromReq(req),b=await body(req),type=String(b.type||'get'),amount=Math.floor(Number(b.amount)||0),phone=String(b.phone||'').trim();
      if(!['get','sell'].includes(type))throw httpError('نوع الطلب غير صالح.',400);
      if(!phone||phone.length>40)throw httpError('أدخل رقم تواصل صحيحًا.',400);
      if(amount<1||amount>100000)throw httpError('عدد النقاط غير صالح.',400);
      if(type==='sell'){const u=await getUser(d.uid);if(!u||amount>(Number(u.redPoints)||0))throw httpError('رصيد النقاط الحمراء غير كافٍ.',400);}
      const rec={id:'rpr_'+crypto.randomUUID(),uid:d.uid,phone,amount,type,status:'pending',createdAt:new Date().toISOString()};
      await sql`
        INSERT INTO red_point_requests (id, uid, phone, amount, type, status, created_at)
        VALUES (${rec.id}, ${rec.uid}, ${rec.phone}, ${rec.amount}, ${rec.type}, ${rec.status}, NOW())
      `;
      return send(res,200,{ok:true,id:rec.id});
    }
    if (M === 'GET' && p === '/api/admin/red-points/requests') {
      await requireAdmin(req);
      const rows = await sql`SELECT * FROM red_point_requests ORDER BY created_at DESC LIMIT 200`;
      return send(res,200,{requests: rows.map(r => ({
        id: r.id, uid: r.uid, phone: r.phone, amount: Number(r.amount), type: r.type, status: r.status, awarded: Number(r.awarded),
        reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null, reviewedBy: r.reviewed_by, createdAt: new Date(r.created_at).toISOString()
      }))});
    }
    if (M === 'POST' && p === '/api/admin/red-points/review') {
      const admin=await requireAdmin(req),b=await body(req);
      const rows = await sql`SELECT * FROM red_point_requests WHERE id = ${String(b.id||'')}`;
      const rec = rows[0];
      if(!rec)throw httpError('الطلب غير موجود.',404);if(rec.status!=='pending')throw httpError('تمت مراجعة الطلب بالفعل.',409);
      let awarded = 0;
      let status = 'rejected';
      if(b.approve){
        const u=await getUser(rec.uid);if(!u)throw httpError('الحساب غير موجود.',404);
        if(rec.type==='sell'){
          if((Number(u.redPoints)||0)<rec.amount)throw httpError('رصيد المستخدم لم يعد كافيًا.',409);
          u.redPoints=Number(u.redPoints||0)-rec.amount;
        } else {
          const award=Math.floor(Number(b.award)||0);if(award<1||award>1000000)throw httpError('حدد عدد النقاط الممنوحة.',400);
          u.redPoints=(Number(u.redPoints)||0)+award;awarded=award;
        }
        await saveUser(u);status='approved';
      }
      await sql`
        UPDATE red_point_requests SET
          status = ${status},
          awarded = ${awarded},
          reviewed_at = NOW(),
          reviewed_by = ${admin.phone}
        WHERE id = ${rec.id}
      `;
      return send(res,200,{ok:true,status,awarded});
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

    /* ----- password change requests ----- */
    if (M === 'POST' && p === '/api/password-change/request') {
      const d = await userFromReq(req), b = await body(req);
      const newPassword = String(b.newPassword || '');
      if (newPassword.length < 6 || newPassword.length > 200) throw httpError('كلمة المرور يجب أن تكون بين 6 و200 حرف.', 400);
      
      const pending = await sql`SELECT id FROM password_change_requests WHERE uid = ${d.uid} AND status = 'pending'`;
      if (pending.length > 0) throw httpError('لديك طلب تغيير كلمة مرور قيد المراجعة بالفعل.', 409);

      const ph = await hashPassword(newPassword);
      const rec = { id: 'pwc_' + crypto.randomUUID(), uid: d.uid, phone: d.phone, name: d.name, passwordHash: ph.hash, passwordSalt: ph.salt, status: 'pending', createdAt: new Date().toISOString() };
      
      await sql`
        INSERT INTO password_change_requests (id, uid, phone, name, password_hash, password_salt, status, created_at)
        VALUES (${rec.id}, ${rec.uid}, ${rec.phone}, ${rec.name}, ${rec.passwordHash}, ${rec.passwordSalt}, ${rec.status}, NOW())
      `;
      return send(res, 200, { ok: true, id: rec.id });
    }
    if (M === 'GET' && p === '/api/admin/password-change/requests') {
      await requireAdmin(req);
      const rows = await sql`SELECT id, uid, phone, name, status, reviewed_at, reviewed_by, created_at FROM password_change_requests ORDER BY created_at DESC LIMIT 200`;
      return send(res, 200, { requests: rows.map(r => ({
        id: r.id, uid: r.uid, phone: r.phone, name: r.name, status: r.status,
        reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null, reviewedBy: r.reviewed_by, createdAt: new Date(r.created_at).toISOString()
      })) });
    }
    if (M === 'POST' && p === '/api/admin/password-change/review') {
      const admin = await requireAdmin(req), b = await body(req);
      const rows = await sql`SELECT * FROM password_change_requests WHERE id = ${String(b.id || '')}`;
      const rec = rows[0];
      if (!rec) throw httpError('طلب تغيير كلمة المرور غير موجود.', 404);
      if (rec.status !== 'pending') throw httpError('تمت مراجعة الطلب بالفعل.', 409);
      
      let status = 'rejected';
      if (b.approve) {
        const u = await getUser(rec.uid); if (!u) throw httpError('الحساب غير موجود.', 404);
        u.passwordHash = rec.password_hash; u.passwordSalt = rec.password_salt; await saveUser(u);
        status = 'approved';
      }
      await sql`
        UPDATE password_change_requests SET
          status = ${status},
          reviewed_at = NOW(),
          reviewed_by = ${admin.phone}
        WHERE id = ${rec.id}
      `;
      return send(res, 200, { ok: true, status });
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
});

process.on('unhandledRejection', e => console.error('unhandledRejection', e));
server.listen(PORT, '0.0.0.0', () => console.log(`الهلال AI running on port ${PORT}`));
