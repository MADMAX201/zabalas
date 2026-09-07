const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'zabalas.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',       -- member | admin
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  starts_at TEXT NOT NULL,                    -- ISO local: 2026-12-24T19:00
  ends_at TEXT,
  location TEXT,
  address TEXT,
  image TEXT,
  rsvp_deadline TEXT,
  published INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                       -- yes | no | maybe
  guests INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(event_id, user_id)
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,                     -- COP, sin decimales
  sizes TEXT,                                 -- "S,M,L,XL" o vacío si no aplica
  stock INTEGER,                              -- NULL = ilimitado
  image TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  order_deadline TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | review | paid | rejected | cancelled
  receipt TEXT,                               -- archivo del comprobante
  receipt_ref TEXT,                           -- referencia / nº de transacción Nequi
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  for_name TEXT,                              -- para quién es (opcional)
  size TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL
);
`);

// ---- Migraciones incrementales ----
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!cols('events').includes('access_code')) db.exec('ALTER TABLE events ADD COLUMN access_code TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS event_access (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                         -- image | video
  file TEXT NOT NULL,                         -- nombre en uploads/galeria
  thumb TEXT,                                 -- miniatura (imágenes)
  caption TEXT,
  visibility TEXT NOT NULL DEFAULT 'family',  -- family | private
  size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_media_vis ON media(visibility, created_at);
`);
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'galeria'), { recursive: true });

// Fechas múltiples por evento (sesiones). events.starts_at/ends_at se mantienen como rango total (min/max) para ordenar.
db.exec(`
CREATE TABLE IF NOT EXISTS event_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT,                                 -- "Ensayo 1", "Final", opcional
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  location TEXT,
  address TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_dates_ev ON event_dates(event_id, starts_at);
CREATE TABLE IF NOT EXISTS date_rsvps (
  date_id INTEGER NOT NULL REFERENCES event_dates(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (date_id, user_id)
);
`);
// Migración: cada evento existente sin fechas recibe una a partir de su fecha original
for (const ev of db.prepare('SELECT * FROM events WHERE id NOT IN (SELECT DISTINCT event_id FROM event_dates)').all()) {
  db.prepare('INSERT INTO event_dates (event_id, starts_at, ends_at, location, address) VALUES (?, ?, ?, ?, ?)').run(ev.id, ev.starts_at, ev.ends_at, ev.location, ev.address);
  // Quien ya había confirmado asistencia queda marcado en esa única fecha
  const d = db.prepare('SELECT id FROM event_dates WHERE event_id = ?').get(ev.id);
  for (const r of db.prepare("SELECT user_id FROM rsvps WHERE event_id = ? AND status = 'yes'").all(ev.id))
    db.prepare('INSERT OR IGNORE INTO date_rsvps (date_id, user_id) VALUES (?, ?)').run(d.id, r.user_id);
}

// ---- Ajustes por defecto ----
const defaults = {
  family_code: process.env.FAMILY_CODE || 'ZABALA2026',
  site_name: 'Familia Zabala Suárez',
  nequi_number: process.env.NEQUI_NUMBER || '',
  nequi_holder: process.env.NEQUI_HOLDER || '',
  nequi_qr: '',
  payment_instructions: 'Haz la transferencia desde tu app Nequi al número indicado, toma captura del comprobante y súbela aquí. Un administrador confirmará tu pago.',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

// ---- Admin inicial ----
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(process.env.ADMIN_EMAIL.toLowerCase());
  if (!exists) {
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(process.env.ADMIN_NAME || 'Administrador', process.env.ADMIN_EMAIL.toLowerCase(),
        bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), 'admin');
    console.log(`Admin inicial creado: ${process.env.ADMIN_EMAIL}`);
  }
}

// ---- Helpers ----
const settings = {
  get(key) { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; },
  all() { const o = {}; for (const r of db.prepare('SELECT key, value FROM settings').all()) o[r.key] = r.value; return o; },
  set(key, value) { db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); },
};

// Núcleo familiar de cada integrante y acompañantes por evento
db.exec(`
CREATE TABLE IF NOT EXISTS household_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  note TEXT,                                  -- "hija", "esposo", talla... opcional
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS rsvp_companions (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id, member_id)
);
`);
if (!cols('rsvps').includes('extra_guests')) db.exec('ALTER TABLE rsvps ADD COLUMN extra_guests INTEGER NOT NULL DEFAULT 0');
if (!cols('household_members').includes('alias_of')) db.exec('ALTER TABLE household_members ADD COLUMN alias_of INTEGER REFERENCES household_members(id) ON DELETE SET NULL');
if (!cols('household_members').includes('norm')) db.exec('ALTER TABLE household_members ADD COLUMN norm TEXT');
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
for (const m of db.prepare('SELECT id, name FROM household_members WHERE norm IS NULL').all()) db.prepare('UPDATE household_members SET norm = ? WHERE id = ?').run(normName(m.name), m.id);
function household(userId) { return db.prepare('SELECT * FROM household_members WHERE user_id = ? ORDER BY id').all(userId); }
// Coincidencias de nombre en núcleos de OTROS titulares y en cuentas registradas
function findSimilar(name, excludeUserId) {
  const n = normName(name); if (!n) return { members: [], users: [] };
  const members = db.prepare(`SELECT m.id, m.name, m.note, u.name AS owner FROM household_members m JOIN users u ON u.id = m.user_id
    WHERE m.norm = ? AND m.user_id != ? AND m.alias_of IS NULL ORDER BY m.id`).all(n, excludeUserId);
  const users = db.prepare('SELECT id, name FROM users WHERE active = 1 AND id != ?').all(excludeUserId).filter(u => normName(u.name) === n);
  return { members, users };
}
// Crea (o reutiliza) una persona del núcleo; alias_of vincula con la misma persona en otro núcleo
const isFullName = (name) => normName(name).split(' ').filter(w => w.length >= 2).length >= 2;
function addHouseholdMember(userId, name, note, aliasOf) {
  const n = normName(name); if (!n || !isFullName(name)) return null;
  const existing = db.prepare('SELECT * FROM household_members WHERE user_id = ? AND norm = ?').get(userId, n);
  if (existing) return existing;
  let alias = null;
  if (aliasOf) { const o = db.prepare('SELECT id, alias_of FROM household_members WHERE id = ? AND user_id != ?').get(aliasOf, userId); if (o) alias = o.alias_of || o.id; }
  const info = db.prepare('INSERT INTO household_members (user_id, name, note, alias_of, norm) VALUES (?, ?, ?, ?, ?)').run(userId, String(name).trim().slice(0, 80), note || null, alias, n);
  return db.prepare('SELECT * FROM household_members WHERE id = ?').get(info.lastInsertRowid);
}
const canonicalId = (m) => m.alias_of || m.id;
function companionsFor(eventId, userId) {
  return db.prepare('SELECT m.id, m.name, m.alias_of FROM rsvp_companions c JOIN household_members m ON m.id = c.member_id WHERE c.event_id = ? AND c.user_id = ? ORDER BY m.id').all(eventId, userId);
}
// Acompañantes de un evento contados una sola vez aunque los marquen varios titulares
function uniqueCompanions(eventId) {
  const rows = db.prepare(`SELECT c.user_id, u.name AS owner, m.id, m.name, m.alias_of FROM rsvp_companions c JOIN household_members m ON m.id = c.member_id JOIN users u ON u.id = c.user_id
    WHERE c.event_id = ?`).all(eventId);
  const seen = new Map(); const dups = [];
  for (const r of rows) { const k = canonicalId(r); if (seen.has(k)) dups.push({ name: r.name, owners: [seen.get(k).owner, r.owner] }); else seen.set(k, r); }
  return { unique: seen.size, dups };
}

// Recalcula el rango del evento a partir de sus fechas
function syncEventRange(eventId) {
  const r = db.prepare('SELECT MIN(starts_at) AS s, MAX(COALESCE(ends_at, starts_at)) AS e FROM event_dates WHERE event_id = ?').get(eventId);
  if (r && r.s) db.prepare('UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?').run(r.s, r.e === r.s ? null : r.e, eventId);
}
function eventDates(eventId) {
  return db.prepare('SELECT * FROM event_dates WHERE event_id = ? ORDER BY starts_at').all(eventId);
}

module.exports = { db, settings, DATA_DIR, syncEventRange, eventDates, household, companionsFor, findSimilar, addHouseholdMember, uniqueCompanions, normName, isFullName };
