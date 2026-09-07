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

function csrfCheck(req, res, next) {
  const token = req.body && req.body._csrf;
  if (!token || token !== req.session.csrf) return res.status(403).render('error', { title: 'Sesión inválida', message: 'El formulario expiró. Vuelve a intentarlo.' });
  next();
}

module.exports = { requireLogin, requireAdmin, upload, csrfCheck };
