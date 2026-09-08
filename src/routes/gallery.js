const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { db, DATA_DIR } = require('../db');
const { requireLogin, uploadMedia, csrfCheck } = require('../middleware');

const r = express.Router();
const GAL = path.join(DATA_DIR, 'uploads', 'galeria');
const removeFile = (f) => { if (f) { try { fs.unlinkSync(path.join(GAL, f)); } catch {} } };

// Eventos que el usuario puede ver (para etiquetar y filtrar)
function visibleEvents(user) {
  const vis = user.role === 'admin' ? '' : `AND (access_code IS NULL OR access_code = '' OR organizer_id = ${user.id} OR id IN (SELECT event_id FROM event_access WHERE user_id = ${user.id}))`;
  return db.prepare(`SELECT id, title, starts_at FROM events WHERE published = 1 AND status = 'approved' ${vis} ORDER BY starts_at DESC`).all();
}

const listQuery = (where) => `
  SELECT m.*, u.name AS user_name, e.title AS event_title FROM media m
  JOIN users u ON u.id = m.user_id LEFT JOIN events e ON e.id = m.event_id
  WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT 500`;

// Galería familiar
r.get('/galeria', requireLogin, (req, res) => {
  const eventId = parseInt(req.query.evento, 10) || null;
  const events = visibleEvents(req.user);
  const allowedEv = new Set(events.map(e => e.id));
  // Solo se muestran fotos compartidas; si están asociadas a un evento privado, solo a quien tenga acceso
  let items = db.prepare(listQuery(`m.visibility = 'family' ${eventId ? 'AND m.event_id = ' + eventId : ''}`)).all()
    .filter(m => !m.event_id || allowedEv.has(m.event_id) || m.user_id === req.user.id);
  const counts = { mine: db.prepare('SELECT COUNT(*) AS n FROM media WHERE user_id = ?').get(req.user.id).n };
  res.render('gallery', { title: 'Galería', items, events, eventId, counts, mine: false });
});

// Mis archivos (privados y compartidos)
r.get('/galeria/mia', requireLogin, (req, res) => {
  const items = db.prepare(listQuery('m.user_id = ?')).all(req.user.id);
  res.render('gallery', { title: 'Mi galería', items, events: visibleEvents(req.user), eventId: null, counts: { mine: items.length }, mine: true });
});

r.get('/galeria/subir', requireLogin, (req, res) => res.render('gallery_upload', { title: 'Subir a la galería', events: visibleEvents(req.user), eventId: parseInt(req.query.evento, 10) || null }));

r.post('/galeria/subir', requireLogin, uploadMedia.array('files', 10), csrfCheck, async (req, res) => {
  if (!req.files || !req.files.length) { req.flash('bad', 'Selecciona al menos una foto o video.'); return res.redirect('/galeria/subir'); }
  const eventId = parseInt(req.body.event_id, 10) || null;
  const visibility = req.body.visibility === 'private' ? 'private' : 'family';
  const caption = String(req.body.caption || '').trim().slice(0, 300) || null;
  const ins = db.prepare('INSERT INTO media (user_id, event_id, kind, file, thumb, caption, visibility, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const f of req.files) {
    const isVideo = f.mimetype.startsWith('video/');
    let thumb = null, file = f.filename;
    if (!isVideo) {
      try {
        // Normaliza la foto (rota según EXIF, máx. 2000px, JPEG) y genera miniatura
        const base = f.filename.replace(/\.[^.]+$/, '');
        const full = `${base}.jpg`, th = `${base}-th.jpg`;
        await sharp(f.path).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(path.join(GAL, full));
        await sharp(f.path).rotate().resize({ width: 480, height: 480, fit: 'cover' }).jpeg({ quality: 78 }).toFile(path.join(GAL, th));
        if (full !== f.filename) removeFile(f.filename);
        file = full; thumb = th;
      } catch (e) { console.error('sharp:', e.message); }
    }
    ins.run(req.user.id, eventId, isVideo ? 'video' : 'image', file, thumb, caption, visibility, f.size);
    n++;
  }
  req.flash('ok', `${n} archivo${n > 1 ? 's' : ''} subido${n > 1 ? 's' : ''} ${visibility === 'family' ? 'y compartido' + (n > 1 ? 's' : '') + ' con la familia' : 'en privado'}.`);
  res.redirect(visibility === 'family' ? '/galeria' : '/galeria/mia');
});

function loadMedia(req, res, next) {
  const m = db.prepare(listQuery('m.id = ?')).get(req.params.id);
  if (!m) return res.status(404).render('error', { title: 'No encontrado', message: 'Este archivo no existe.' });
  const owner = m.user_id === req.user.id || req.user.role === 'admin';
  if (!owner && m.visibility !== 'family') return res.status(404).render('error', { title: 'No encontrado', message: 'Este archivo no existe.' });
  req.media = m; req.isOwner = owner; next();
}

r.get('/galeria/:id', requireLogin, loadMedia, (req, res) => {
  const m = req.media;
  // navegación anterior/siguiente dentro del mismo contexto (familia o mía)
  const ctx = req.query.de === 'mia' ? 'm.user_id = ' + req.user.id : "m.visibility = 'family'";
  const prev = db.prepare(`SELECT id FROM media m WHERE ${ctx} AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?)) ORDER BY m.created_at ASC, m.id ASC LIMIT 1`).get(m.created_at, m.created_at, m.id);
  const next = db.prepare(`SELECT id FROM media m WHERE ${ctx} AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?)) ORDER BY m.created_at DESC, m.id DESC LIMIT 1`).get(m.created_at, m.created_at, m.id);
  res.render('gallery_item', { title: m.caption || 'Galería', m, isOwner: req.isOwner, prev, next, de: req.query.de || '', events: req.isOwner ? visibleEvents(req.user) : [] });
});

r.post('/galeria/:id/editar', requireLogin, loadMedia, (req, res) => {
  if (!req.isOwner) return res.status(403).render('error', { title: 'Sin permiso', message: 'Solo puedes editar tus archivos.' });
  const visibility = req.body.visibility === 'private' ? 'private' : 'family';
  const caption = String(req.body.caption || '').trim().slice(0, 300) || null;
  const eventId = parseInt(req.body.event_id, 10) || null;
  db.prepare('UPDATE media SET visibility = ?, caption = ?, event_id = ? WHERE id = ?').run(visibility, caption, eventId, req.media.id);
  req.flash('ok', 'Actualizado.');
  res.redirect(`/galeria/${req.media.id}${req.body.de ? '?de=' + req.body.de : ''}`);
});

r.post('/galeria/:id/eliminar', requireLogin, loadMedia, (req, res) => {
  if (!req.isOwner) return res.status(403).render('error', { title: 'Sin permiso', message: 'Solo puedes eliminar tus archivos.' });
  db.prepare('DELETE FROM media WHERE id = ?').run(req.media.id);
  removeFile(req.media.file); removeFile(req.media.thumb);
  req.flash('ok', 'Archivo eliminado.');
  res.redirect(req.body.de === 'mia' ? '/galeria/mia' : '/galeria');
});

// Los archivos privados solo los sirve a su dueño o al admin
r.get('/uploads/galeria/:file', requireLogin, (req, res) => {
  const f = path.basename(req.params.file);
  const m = db.prepare('SELECT user_id, visibility FROM media WHERE file = ? OR thumb = ?').get(f, f);
  if (!m) return res.status(404).end();
  if (m.visibility !== 'family' && m.user_id !== req.user.id && req.user.role !== 'admin') return res.status(404).end();
  res.sendFile(path.join(GAL, f), { maxAge: '7d' });
});

module.exports = r;
