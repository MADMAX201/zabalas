require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Bogota';

const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const { db, settings, DATA_DIR } = require('./db');
const { csrfCheck } = require('./middleware');
const helpers = require('./helpers');

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), { maxAge: '7d' }));

app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 3600 * 1000 },
}));

// Usuario actual + mensajes flash + helpers en todas las vistas
app.use((req, res, next) => {
  req.user = null;
  if (req.session.userId) {
    req.user = db.prepare('SELECT id, name, email, phone, role, active FROM users WHERE id = ?').get(req.session.userId);
    if (!req.user || !req.user.active) { req.session.destroy(() => {}); req.user = null; }
  }
  res.locals.user = req.user;
  res.locals.site = settings.all();
  res.locals.h = helpers;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.path = req.path;
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  next();
});

// Protección CSRF sencilla basada en token de sesión
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = require('crypto').randomBytes(16).toString('hex');
  res.locals.csrf = req.session.csrf;
  // Los formularios multipart se verifican en su ruta, después de multer (ver middleware.csrfCheck)
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && !req.is('multipart/form-data')) return csrfCheck(req, res, next);
  next();
});

app.use(require('./routes/auth'));
app.use(require('./routes/events'));
app.use(require('./routes/orders'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'No encontrado', message: 'Esta página no existe.' }));
app.use((err, req, res, next) => {
  console.error(err);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo es demasiado grande (máx. 8 MB).' : (err.publicMessage || 'Ocurrió un error inesperado.');
  res.status(err.status || 500).render('error', { title: 'Error', message: msg });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`zabalas.online escuchando en http://localhost:${PORT}`));
