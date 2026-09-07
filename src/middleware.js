const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { DATA_DIR } = require('./db');

function requireLogin(req, res, next) {
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Sin permiso', message: 'Esta sección es solo para administradores.' });
  next();
}

const storage = multer.diskStorage({
  destination: path.join(DATA_DIR, 'uploads'),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const imageFilter = (req, file, cb) => {
  const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) || file.mimetype === 'application/pdf';
  if (!ok) { const e = new Error('Formato no permitido'); e.publicMessage = 'Solo se permiten imágenes (JPG, PNG, WEBP) o PDF.'; e.status = 400; return cb(e); }
  cb(null, true);
};
const upload = multer({ storage, fileFilter: imageFilter, limits: { fileSize: 8 * 1024 * 1024 } });

// Galería: fotos y videos hasta 200 MB
const galleryStorage = multer.diskStorage({
  destination: path.join(DATA_DIR, 'uploads', 'galeria'),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase() || (file.mimetype.startsWith('video/') ? '.mp4' : '.jpg');
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const mediaFilter = (req, file, cb) => {
  const ok = /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.mimetype) || /^video\/(mp4|quicktime|webm|x-m4v)$/.test(file.mimetype);
  if (!ok) { const e = new Error('Formato no permitido'); e.publicMessage = 'Solo fotos (JPG, PNG, WEBP, HEIC) o videos (MP4, MOV, WEBM).'; e.status = 400; return cb(e); }
  cb(null, true);
};
const uploadMedia = multer({ storage: galleryStorage, fileFilter: mediaFilter, limits: { fileSize: 200 * 1024 * 1024, files: 10 } });

// Admin, o el organizador del evento al que pertenece la ruta (evento, producto, fecha o pedido)
function requireManager(req, res, next) {
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  if (req.user.role === 'admin') return next();
  const { db } = require('./db');
  const p = req.path; let eventId = null; let mt;
  if ((mt = p.match(/^\/eventos\/(\d+)(\/|$)/))) eventId = Number(mt[1]);
  else if ((mt = p.match(/^\/productos\/(\d+)\//))) eventId = (db.prepare('SELECT event_id FROM products WHERE id = ?').get(mt[1]) || {}).event_id;
  else if ((mt = p.match(/^\/fechas\/(\d+)\//))) eventId = (db.prepare('SELECT event_id FROM event_dates WHERE id = ?').get(mt[1]) || {}).event_id;
  else if ((mt = p.match(/^\/pedidos\/(\d+)\/(estado|eliminar)$/))) eventId = (db.prepare('SELECT event_id FROM orders WHERE id = ?').get(mt[1]) || {}).event_id;
  const ev = eventId ? db.prepare('SELECT id, organizer_id FROM events WHERE id = ?').get(eventId) : null;
  if (ev && ev.organizer_id === req.user.id) { req.isOrganizer = true; res.locals.isOrganizer = true; return next(); }
  return res.status(403).render('error', { title: 'Sin permiso', message: 'Esta sección es solo para administradores o el organizador del evento.' });
}

function csrfCheck(req, res, next) {
  const token = req.body && req.body._csrf;
  if (!token || token !== req.session.csrf) return res.status(403).render('error', { title: 'Sesión inválida', message: 'El formulario expiró. Vuelve a intentarlo.' });
  next();
}

module.exports = { requireLogin, requireAdmin, requireManager, upload, uploadMedia, csrfCheck };
