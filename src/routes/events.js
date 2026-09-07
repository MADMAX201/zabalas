const express = require('express');
const { db, settings } = require('../db');
const { requireLogin } = require('../middleware');
const h = require('../helpers');

const r = express.Router();

const eventStats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM rsvps WHERE event_id = e.id AND status = 'yes') AS going,
    (SELECT COALESCE(SUM(guests),0) FROM rsvps WHERE event_id = e.id AND status = 'yes') AS guests,
    (SELECT COUNT(*) FROM rsvps WHERE event_id = e.id AND status = 'maybe') AS maybe,
    (SELECT COUNT(*) FROM products WHERE event_id = e.id AND active = 1) AS products
  FROM events e WHERE e.id = ?`);

// Inicio: próximos eventos + pasados
r.get('/', requireLogin, (req, res) => {
  const now = h.nowLocalISO();
  // Eventos privados: solo se listan si el integrante ya ingresó el código (o es admin)
  const vis = req.user.role === 'admin' ? '' : `AND (access_code IS NULL OR access_code = '' OR id IN (SELECT event_id FROM event_access WHERE user_id = ${req.user.id}))`;
  const upcoming = db.prepare(`SELECT * FROM events WHERE published = 1 ${vis} AND COALESCE(ends_at, starts_at) >= ? ORDER BY starts_at ASC`).all(now);
  const past = db.prepare(`SELECT * FROM events WHERE published = 1 ${vis} AND COALESCE(ends_at, starts_at) < ? ORDER BY starts_at DESC LIMIT 12`).all(now);
  const myRsvps = {};
  for (const x of db.prepare('SELECT event_id, status FROM rsvps WHERE user_id = ?').all(req.user.id)) myRsvps[x.event_id] = x.status;
  const pendingOrders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'pending'").get(req.user.id).n;
  const withStats = (list) => list.map(e => ({ ...e, stats: eventStats.get(e.id) }));
  res.render('home', { title: 'Eventos', upcoming: withStats(upcoming), past: withStats(past), myRsvps, pendingOrders });
});

function hasAccess(ev, user) {
  if (!ev.access_code || user.role === 'admin') return true;
  return !!db.prepare('SELECT 1 FROM event_access WHERE event_id = ? AND user_id = ?').get(ev.id, user.id);
}
function loadEvent(req, res, next) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev || (!ev.published && req.user.role !== 'admin')) return res.status(404).render('error', { title: 'No encontrado', message: 'Este evento no existe.' });
  if (!hasAccess(ev, req.user)) return res.status(403).render('event_locked', { title: 'Evento privado', ev, error: null });
  req.event = ev; next();
}

// Ingresar código de un evento privado
r.post('/eventos/:id/codigo', requireLogin, (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND published = 1').get(req.params.id);
  if (!ev) return res.status(404).render('error', { title: 'No encontrado', message: 'Este evento no existe.' });
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!ev.access_code || code !== ev.access_code.toUpperCase()) {
    return res.status(403).render('event_locked', { title: 'Evento privado', ev, error: 'El código no es correcto. Pídeselo a quien te invitó.' });
  }
  db.prepare('INSERT OR IGNORE INTO event_access (event_id, user_id) VALUES (?, ?)').run(ev.id, req.user.id);
  req.flash('ok', `¡Bienvenido/a a "${ev.title}"!`);
  res.redirect(`/eventos/${ev.id}`);
});

// Buscar evento privado por código (desde el inicio)
r.post('/eventos/codigo', requireLogin, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const ev = code ? db.prepare('SELECT * FROM events WHERE published = 1 AND UPPER(access_code) = ?').get(code) : null;
  if (!ev) { req.flash('bad', 'No hay ningún evento con ese código.'); return res.redirect('/'); }
  db.prepare('INSERT OR IGNORE INTO event_access (event_id, user_id) VALUES (?, ?)').run(ev.id, req.user.id);
  req.flash('ok', `¡Bienvenido/a a "${ev.title}"!`);
  res.redirect(`/eventos/${ev.id}`);
});

r.get('/eventos/:id', requireLogin, loadEvent, (req, res) => {
  const ev = req.event;
  const stats = eventStats.get(ev.id);
  const myRsvp = db.prepare('SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id);
  const attendees = db.prepare(`SELECT u.name, r.status, r.guests, r.note FROM rsvps r JOIN users u ON u.id = r.user_id
    WHERE r.event_id = ? ORDER BY CASE r.status WHEN 'yes' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, u.name`).all(ev.id);
  const products = db.prepare('SELECT * FROM products WHERE event_id = ? AND active = 1 ORDER BY id').all(ev.id)
    .map(p => ({ ...p, sizeList: (p.sizes || '').split(',').map(s => s.trim()).filter(Boolean), sold: soldQty(p.id) }));
  const myOrders = db.prepare('SELECT * FROM orders WHERE event_id = ? AND user_id = ? ORDER BY id DESC').all(ev.id, req.user.id)
    .map(o => ({ ...o, items: db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id = ?').all(o.id) }));
  const base = `${req.protocol}://${req.get('host')}`;
  const rsvpClosed = ev.rsvp_deadline ? h.isPast(ev.rsvp_deadline) : h.isPast(ev.ends_at || ev.starts_at);
  res.render('event', { title: ev.title, ev, stats, myRsvp, attendees, products, myOrders, rsvpClosed,
    gcal: h.googleCalUrl(ev, `${base}/eventos/${ev.id}`) });
});

function soldQty(productId) {
  return db.prepare(`SELECT COALESCE(SUM(oi.qty),0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = ? AND o.status IN ('pending','review','paid')`).get(productId).n;
}

r.post('/eventos/:id/asistencia', requireLogin, loadEvent, (req, res) => {
  const ev = req.event;
  const status = ['yes', 'no', 'maybe'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.redirect(`/eventos/${ev.id}`);
  const closed = ev.rsvp_deadline ? h.isPast(ev.rsvp_deadline) : h.isPast(ev.ends_at || ev.starts_at);
  if (closed) { req.flash('bad', 'Ya cerró el plazo para confirmar asistencia.'); return res.redirect(`/eventos/${ev.id}`); }
  const guests = Math.max(0, Math.min(20, parseInt(req.body.guests || '0', 10) || 0));
  db.prepare(`INSERT INTO rsvps (event_id, user_id, status, guests, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, guests = excluded.guests, note = excluded.note, updated_at = datetime('now','localtime')`)
    .run(ev.id, req.user.id, status, status === 'yes' ? guests : 0, String(req.body.note || '').trim().slice(0, 300) || null);
  req.flash('ok', status === 'yes' ? '¡Asistencia confirmada! Puedes agregar el evento a tu calendario.' : 'Respuesta guardada.');
  res.redirect(`/eventos/${ev.id}#asistencia`);
});

// Archivo .ics para agendar
r.get('/eventos/:id/calendario.ics', requireLogin, loadEvent, (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="evento-${req.event.id}.ics"`);
  res.send(h.buildICS(req.event, settings.get('site_name'), `${base}/eventos/${req.event.id}`));
});

module.exports = r;
module.exports.soldQty = soldQty;
