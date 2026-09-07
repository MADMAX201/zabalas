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

module.exports = { db, settings, DATA_DIR };
