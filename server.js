'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';
const RETENTION_DAYS = Math.max(1, Number(process.env.PERSONAL_DATA_RETENTION_DAYS || 7));
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === 'true';
const dbPath = path.resolve(process.env.DATABASE_PATH || './data/jetonzone.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  service_key TEXT NOT NULL,
  service_label TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'AZN',
  tiktok_id TEXT,
  customer_contact TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  fulfillment_status TEXT NOT NULL DEFAULT 'blocked',
  provider_reference TEXT UNIQUE,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  fulfilled_at TEXT,
  personal_data_deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);
`);

const SERVICES = {
  jetons_1000: { label: '1.000 TikTok jetonu', amount: 1950 },
  lion_gift: { label: 'Lion hədiyyəsi', amount: 25500 },
  universe_gift: { label: 'Universe hədiyyəsi', amount: 42000 },
  vip_account: { label: 'Təsdiqlənmiş hesab V.I.P status', amount: null },
  follower_campaign: { label: 'İzləyici kampaniyası', amount: null },
  likes_views: { label: 'Bəyənmə və baxış kampaniyası', amount: null }
};
const now = () => new Date().toISOString();
const audit = db.prepare('INSERT INTO audit_events (order_id,event_type,detail,created_at) VALUES (?,?,?,?)');
const insertOrder = db.prepare(`INSERT INTO orders (id,service_key,service_label,amount_minor,currency,tiktok_id,customer_contact,payment_status,fulfillment_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: null } } }));
app.use(express.json({ limit: '16kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

function adminOnly(req, res, next) {
  if (!ADMIN_KEY || ADMIN_KEY.length < 32) return res.status(503).json({ error: 'Admin girişi konfiqurasiya edilməyib.' });
  const supplied = String(req.get('x-admin-key') || '');
  const a = Buffer.from(supplied); const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'İcazə yoxdur.' });
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: 'private-test', paymentsEnabled: PAYMENTS_ENABLED }));
app.get('/api/services', (_req, res) => res.json(Object.entries(SERVICES).map(([key, s]) => ({ key, label: s.label, price: s.amount === null ? null : (s.amount / 100).toFixed(2), currency: 'AZN' }))));

app.post('/api/orders', (req, res) => {
  const { serviceKey, tiktokId, contact } = req.body || {};
  const service = SERVICES[serviceKey];
  if (!service) return res.status(400).json({ error: 'Xidmət seçimi düzgün deyil.' });
  if (service.amount === null) return res.status(409).json({ error: 'Bu xidmətin qiyməti hələ müəyyən edilməyib və sifarişə açıq deyil.' });
  if (typeof tiktokId !== 'string' || !/^[A-Za-z0-9._]{2,40}$/.test(tiktokId.trim())) return res.status(400).json({ error: 'TikTok ID-ni düzgün daxil et.' });
  if (contact !== undefined && (typeof contact !== 'string' || contact.length > 120)) return res.status(400).json({ error: 'Əlaqə məlumatı uyğun deyil.' });
  const id = 'JZ-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  insertOrder.run(id, serviceKey, service.label, service.amount, 'AZN', tiktokId.trim(), (contact || '').trim() || null, 'pending', 'blocked', now());
  audit.run(id, 'order_created', 'Ödəniş gözlənilir; xidmət bloklanıb.', now());
  res.status(201).json({ id, service: service.label, amount: (service.amount / 100).toFixed(2), currency: 'AZN', paymentStatus: 'pending', fulfillmentStatus: 'blocked', message: 'Sifariş yaradıldı. Ödəniş təsdiqlənənədək xidmət göstərilməyəcək.' });
});

app.get('/api/orders/:id', (req, res) => {
  const row = db.prepare('SELECT id,service_label,amount_minor,currency,payment_status,fulfillment_status,created_at,paid_at,fulfilled_at,personal_data_deleted_at FROM orders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Sifariş tapılmadı.' });
  res.json({ ...row, amount: (row.amount_minor / 100).toFixed(2) });
});

// Provider-specific payment initiation is intentionally disabled until a real provider is selected/configured.
app.post('/api/payments/start', (req, res) => {
  const { orderId } = req.body || {};
  const order = db.prepare('SELECT id,payment_status FROM orders WHERE id=?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Sifariş tapılmadı.' });
  if (order.payment_status === 'paid') return res.status(409).json({ error: 'Bu sifariş artıq ödənilib.' });
  if (!PAYMENTS_ENABLED) return res.status(503).json({ error: 'Real ödəniş inteqrasiyası hələ qoşulmayıb. Sınaq rejimində heç bir ödəniş qəbul edilmir.' });
  return res.status(501).json({ error: 'Ödəniş provayderinin rəsmi adapteri quraşdırılmalıdır.' });
});

// Generic signed webhook shell. Implement the chosen provider's official signature scheme before enabling production payments.
app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '32kb' }), (req, res) => {
  if (!WEBHOOK_SECRET || !req.is('application/json')) return res.status(503).send('Webhook is not configured');
  const signature = String(req.get('x-jz-signature') || '');
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('hex');
  const sigBuf = Buffer.from(signature); const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return res.status(401).send('Invalid signature');
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Invalid JSON'); }
  if (event.type !== 'payment.succeeded' || typeof event.orderId !== 'string' || typeof event.providerReference !== 'string') return res.status(400).send('Unsupported event');
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(event.orderId);
  if (!order) return res.status(404).send('Order not found');
  if (Number(event.amountMinor) !== order.amount_minor || event.currency !== order.currency) return res.status(400).send('Amount mismatch');
  const update = db.prepare("UPDATE orders SET payment_status='paid',fulfillment_status='awaiting_manual_fulfillment',provider_reference=?,paid_at=? WHERE id=? AND payment_status='pending'");
  const result = update.run(event.providerReference, now(), order.id);
  if (result.changes) audit.run(order.id, 'payment_verified', 'Ödəniş imzalı server bildirişi ilə təsdiqləndi; xidmət hələ əl ilə icra gözləyir.', now());
  return res.json({ received: true });
});

app.get('/api/admin/orders', adminOnly, (_req, res) => {
  const rows = db.prepare('SELECT id,service_label,amount_minor,currency,tiktok_id,customer_contact,payment_status,fulfillment_status,created_at,paid_at,personal_data_deleted_at FROM orders ORDER BY created_at DESC LIMIT 250').all();
  res.json(rows.map(r => ({ ...r, amount: (r.amount_minor / 100).toFixed(2) })));
});
app.get('/api/admin/audit', adminOnly, (_req, res) => {
  res.json(db.prepare('SELECT id,order_id,event_type,detail,created_at FROM audit_events ORDER BY id DESC LIMIT 500').all());
});
app.post('/api/admin/orders/:id/fulfill', adminOnly, (req, res) => {
  const order = db.prepare('SELECT id,payment_status,fulfillment_status FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Sifariş tapılmadı.' });
  if (order.payment_status !== 'paid') return res.status(409).json({ error: 'Ödəniş təsdiqlənməyib. Xidmət qətiyyən icra edilə bilməz.' });
  if (order.fulfillment_status === 'fulfilled') return res.status(409).json({ error: 'Sifariş artıq icra olunub.' });
  db.prepare("UPDATE orders SET fulfillment_status='fulfilled',fulfilled_at=? WHERE id=?").run(now(), order.id);
  audit.run(order.id, 'fulfilled', 'Admin ödənişi təsdiqlənmiş sifarişi icra olunmuş kimi qeyd etdi.', now());
  res.json({ ok: true, id: order.id, fulfillmentStatus: 'fulfilled' });
});

// After retention window, erase customer-identifying fields; keep minimal transaction/status audit history.
function purgeExpiredPersonalData() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const rows = db.prepare('SELECT id FROM orders WHERE created_at < ? AND personal_data_deleted_at IS NULL AND (tiktok_id IS NOT NULL OR customer_contact IS NOT NULL)').all(cutoff);
  const tx = db.transaction(() => {
    for (const row of rows) {
      db.prepare('UPDATE orders SET tiktok_id=NULL,customer_contact=NULL,personal_data_deleted_at=? WHERE id=?').run(now(), row.id);
      audit.run(row.id, 'personal_data_purged', `TikTok ID və əlaqə məlumatları ${RETENTION_DAYS} günlük saxlanma müddətindən sonra silindi.`, now());
    }
  });
  tx();
}
purgeExpiredPersonalData();
setInterval(purgeExpiredPersonalData, 60 * 60 * 1000).unref();

app.use((err, _req, res, _next) => {
  console.error('Request error:', err.message);
  res.status(500).json({ error: 'Daxili xəta baş verdi.' });
});
app.listen(PORT, () => console.log(`JetonZone private test server listening on port ${PORT}`));
