const express = require('express');
const { db, settings, eventDates, household, companionsFor, addHouseholdMember, uniqueCompanions, isFullName, syncEventRange, canManage } = require('../db');
const { upload, csrfCheck } = require('../middleware');
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
  const vis = req.user.role === 'admin' ? '' : `AND (access_code IS NULL OR access_code = '' OR organizer_id = ${req.user.id} OR id IN (SELECT event_id FROM event_access WHERE user_id = ${req.user.id}))`;
  const upcoming = db.prepare(`SELECT * FROM events WHERE published = 1 AND status = 'approved' ${vis} AND COALESCE(ends_at, starts_at) >= ? ORDER BY starts_at ASC`).all(now);
  const past = db.prepare(`SELECT * FROM events WHERE published = 1 AND status = 'approved' ${vis} AND COALESCE(ends_at, starts_at) < ? ORDER BY starts_at DESC LIMIT 12`).all(now);
  const myEvents = db.prepare('SELECT * FROM events WHERE organizer_id = ? ORDER BY created_at DESC').all(req.user.id);
  const myRsvps = {};
  for (const x of db.prepare('SELECT event_id, status FROM rsvps WHERE user_id = ?').all(req.user.id)) myRsvps[x.event_id] = x.status;
  const pendingOrders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'pending'").get(req.user.id).n;
  const withStats = (list) => list.map(e => {
    const dates = eventDates(e.id);
    const nextDate = dates.find(d => !h.isPast(d.ends_at || d.starts_at)) || dates[dates.length - 1] || null;
    return { ...e, stats: eventStats.get(e.id), dates, nextDate };
  });
  res.render('home', { title: 'Eventos', upcoming: withStats(upcoming), past: withStats(past), myRsvps, pendingOrders, myEvents });
});

function hasAccess(ev, user) {
  if (!ev.access_code || canManage(ev, user)) return true;
  return !!db.prepare('SELECT 1 FROM event_access WHERE event_id = ? AND user_id = ?').get(ev.id, user.id);
}
function loadEvent(req, res, next) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  // Sin publicar o sin aprobar: solo admin y organizador
  if (!ev || ((!ev.published || ev.status !== 'approved') && !canManage(ev, req.user))) return res.status(404).render('error', { title: 'No encontrado', message: 'Este evento no existe.' });
  if (!hasAccess(ev, req.user)) return res.status(403).render('event_locked', { title: 'Evento privado', ev, error: null });
  req.event = ev; next();
}

// Ingresar código de un evento privado
r.post('/eventos/:id/codigo', requireLogin, (req, res) => {
  const ev = db.prepare("SELECT * FROM events WHERE id = ? AND published = 1 AND status = 'approved'").get(req.params.id);
  if (!ev) return res.status(404).render('error', { title: 'No encontrado', message: 'Este evento no existe.' });
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!ev.access_code || code !== ev.access_code.toUpperCase()) {
    return res.status(403).render('event_locked', { title: 'Evento privado', ev, error: 'El código no es correcto. Pídeselo a quien te invitó.' });
  }
  db.prepare('INSERT OR IGNORE INTO event_access (event_id, user_id) VALUES (?, ?)').run(ev.id, req.user.id);
  req.flash('ok', `¡Bienvenido/a a "${ev.title}"!`);
  res.redirect(`/eventos/${ev.id}`);
});

// ---- Proponer un evento (integrantes) ----
r.get('/eventos/organizar', requireLogin, (req, res) => res.render('event_propose', { title: 'Organizar un evento', ev: {}, error: null }));
r.post('/eventos/organizar', requireLogin, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'pay_qr', maxCount: 1 }]), csrfCheck, (req, res) => {
  const b = req.body, files = req.files || {};
  const f = {
    title: String(b.title || '').trim().slice(0, 120), description: String(b.description || '').trim() || null,
    starts_at: String(b.starts_at || '').trim(), ends_at: String(b.ends_at || '').trim() || null,
    location: String(b.location || '').trim() || null, address: String(b.address || '').trim() || null,
    rsvp_deadline: String(b.rsvp_deadline || '').trim() || null,
    is_private: !!b.is_private,
    pay_method: ['nequi', 'breb'].includes(b.pay_method) ? b.pay_method : 'nequi',
    pay_number: String(b.pay_number || '').trim().slice(0, 80) || null, pay_holder: String(b.pay_holder || '').trim().slice(0, 80) || null,
  };
  if (!f.title || !f.starts_at) return res.status(400).render('event_propose', { title: 'Organizar un evento', ev: f, error: 'Título y fecha de inicio son obligatorios.' });
  if (b.sells && !f.pay_number) return res.status(400).render('event_propose', { title: 'Organizar un evento', ev: f, error: 'Si vas a vender algo, indica el Nequi o la llave Bre-B donde recibirás el dinero.' });
  if (!b.sells) { f.pay_number = null; f.pay_holder = null; }
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = ''; for (let i = 0; i < 6; i++) code += abc[Math.floor(Math.random() * abc.length)];
  const info = db.prepare(`INSERT INTO events (title, description, starts_at, ends_at, location, address, rsvp_deadline, published, access_code, image, created_by, organizer_id, status, pay_method, pay_number, pay_holder, pay_qr)
    VALUES (@title, @description, @starts_at, @ends_at, @location, @address, @rsvp_deadline, 1, @access_code, @image, @by, @by, 'pending', @pay_method, @pay_number, @pay_holder, @pay_qr)`)
    .run({ ...f, access_code: f.is_private ? code : null, image: files.image ? files.image[0].filename : null, pay_qr: files.pay_qr ? files.pay_qr[0].filename : null, by: req.user.id });
  db.prepare('INSERT INTO event_dates (event_id, starts_at, ends_at, location, address) VALUES (?, ?, ?, ?, ?)').run(info.lastInsertRowid, f.starts_at, f.ends_at, f.location, f.address);
  req.flash('ok', 'Tu evento quedó pendiente de aprobación. Un administrador lo revisará; mientras tanto puedes completar fechas y productos.');
  res.redirect(`/admin/eventos/${info.lastInsertRowid}`);
});

// Mis eventos (organizador)
r.get('/mis-eventos', requireLogin, (req, res) => {
  const list = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM rsvps WHERE event_id = e.id AND status = 'yes') AS going,
      (SELECT COUNT(*) FROM orders WHERE event_id = e.id AND status = 'review') AS review,
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE event_id = e.id AND status = 'paid') AS paid
    FROM events e WHERE organizer_id = ? ORDER BY created_at DESC`).all(req.user.id);
  res.render('my_events', { title: 'Mis eventos', list });
});

// Buscar evento privado por código (desde el inicio)
r.post('/eventos/codigo', requireLogin, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const ev = code ? db.prepare("SELECT * FROM events WHERE published = 1 AND status = 'approved' AND UPPER(access_code) = ?").get(code) : null;
  if (!ev) { req.flash('bad', 'No hay ningún evento con ese código.'); return res.redirect('/'); }
  db.prepare('INSERT OR IGNORE INTO event_access (event_id, user_id) VALUES (?, ?)').run(ev.id, req.user.id);
  req.flash('ok', `¡Bienvenido/a a "${ev.title}"!`);
  res.redirect(`/eventos/${ev.id}`);
});

r.get('/eventos/:id', requireLogin, loadEvent, (req, res) => {
  const ev = req.event;
  const stats = eventStats.get(ev.id);
  const uc = uniqueCompanions(ev.id);
  // guests = acompañantes únicos + extras sin nombre
  stats.guests = uc.unique + db.prepare("SELECT r.user_id, r.guests FROM rsvps r WHERE r.event_id = ? AND r.status = 'yes'").all(ev.id)
    .reduce((s, r) => s + Math.max(0, r.guests - companionsFor(ev.id, r.user_id).length), 0);
  const myRsvp = db.prepare('SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id);
  const attendees = db.prepare(`SELECT u.id AS user_id, u.name, r.status, r.guests, r.note FROM rsvps r JOIN users u ON u.id = r.user_id
    WHERE r.event_id = ? ORDER BY CASE r.status WHEN 'yes' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, u.name`).all(ev.id)
    .map(a => ({ ...a, companions: companionsFor(ev.id, a.user_id).map(c => c.name) }));
  const products = db.prepare('SELECT * FROM products WHERE event_id = ? AND active = 1 ORDER BY id').all(ev.id)
    .map(p => ({ ...p, sizeList: (p.sizes || '').split(',').map(s => s.trim()).filter(Boolean), sold: soldQty(p.id) }));
  const myOrders = db.prepare('SELECT * FROM orders WHERE event_id = ? AND user_id = ? ORDER BY id DESC').all(ev.id, req.user.id)
    .map(o => ({ ...o, items: db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id = ?').all(o.id) }));
  const base = `${req.protocol}://${req.get('host')}`;
  const url = `${base}/eventos/${ev.id}`;
  const rsvpClosed = ev.rsvp_deadline ? h.isPast(ev.rsvp_deadline) : h.isPast(ev.ends_at || ev.starts_at);
  const dates = eventDates(ev.id).map(d => ({
    ...d,
    going: db.prepare('SELECT COUNT(*) AS n FROM date_rsvps WHERE date_id = ?').get(d.id).n,
    names: db.prepare('SELECT u.name FROM date_rsvps dr JOIN users u ON u.id = dr.user_id WHERE dr.date_id = ? ORDER BY u.name').all(d.id).map(x => x.name),
    gcal: h.googleCalUrl(ev, url, d),
  }));
  const myDates = new Set(db.prepare('SELECT dr.date_id FROM date_rsvps dr JOIN event_dates d ON d.id = dr.date_id WHERE d.event_id = ? AND dr.user_id = ?').all(ev.id, req.user.id).map(x => x.date_id));
  const members = household(req.user.id);
  const myCompanions = new Set(companionsFor(ev.id, req.user.id).map(c => c.id));
  res.locals.canManage = canManage(ev, req.user);
  res.render('event', { title: ev.title, ev, stats, myRsvp, attendees, products, myOrders, rsvpClosed, dates, myDates, members, myCompanions,
    gcal: h.googleCalUrl(ev, url) });
});

function soldQty(productId) {
  return db.prepare(`SELECT COALESCE(SUM(oi.qty),0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = ? AND o.status IN ('pending','partial','review','paid')`).get(productId).n;
}

r.post('/eventos/:id/asistencia', requireLogin, loadEvent, (req, res) => {
  const ev = req.event;
  const status = ['yes', 'no', 'maybe'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.redirect(`/eventos/${ev.id}`);
  const closed = ev.rsvp_deadline ? h.isPast(ev.rsvp_deadline) : h.isPast(ev.ends_at || ev.starts_at);
  if (closed) { req.flash('bad', 'Ya cerró el plazo para confirmar asistencia.'); return res.redirect(`/eventos/${ev.id}`); }
  const extra = Math.max(0, Math.min(20, parseInt(req.body.guests || '0', 10) || 0));
  // Acompañantes del núcleo familiar (member_ids[])
  const arr = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const rawM = arr(req.body.member_ids);
  // Personas nuevas agregadas desde el formulario: se guardan en el núcleo y quedan marcadas
  const newNames = arr(req.body.new_name), newNotes = arr(req.body.new_note), newAlias = arr(req.body.new_alias);
  const created = [];
  if (status === 'yes') for (let i = 0; i < newNames.length; i++) {
    const nm = String(newNames[i] || '').trim(); if (!nm) continue;
    if (!isFullName(nm)) { req.flash('bad', `Escribe nombre y apellido para "${nm}" (por ejemplo, Tomás Zabala).`); return res.redirect(`/eventos/${ev.id}#asistencia`); }
    const m = addHouseholdMember(req.user.id, nm, String(newNotes[i] || '').trim().slice(0, 60) || null, parseInt(newAlias[i], 10) || null);
    if (m) created.push(m.id);
  }
  const mine = new Set(household(req.user.id).map(m => m.id));
  const companions = status === 'yes' ? [...new Set([...rawM.map(Number), ...created])].filter(id => mine.has(id)) : [];
  const guests = status === 'yes' ? companions.length + extra : 0;
  db.prepare(`INSERT INTO rsvps (event_id, user_id, status, guests, extra_guests, note) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, guests = excluded.guests, extra_guests = excluded.extra_guests, note = excluded.note, updated_at = datetime('now','localtime')`)
    .run(ev.id, req.user.id, status, guests, status === 'yes' ? extra : 0, String(req.body.note || '').trim().slice(0, 300) || null);
  db.transaction(() => {
    db.prepare('DELETE FROM rsvp_companions WHERE event_id = ? AND user_id = ?').run(ev.id, req.user.id);
    for (const id of companions) db.prepare('INSERT OR IGNORE INTO rsvp_companions (event_id, user_id, member_id) VALUES (?, ?, ?)').run(ev.id, req.user.id, id);
  })();
  // Fechas seleccionadas (checkboxes date_ids[]); en eventos de una sola fecha, "Sí" = esa fecha
  const dates = eventDates(ev.id);
  const valid = new Set(dates.map(d => d.id));
  let chosen = [];
  if (status === 'yes') {
    const raw = req.body.date_ids === undefined ? [] : (Array.isArray(req.body.date_ids) ? req.body.date_ids : [req.body.date_ids]);
    chosen = raw.map(Number).filter(id => valid.has(id));
    if (dates.length === 1) chosen = [dates[0].id];
    if (!chosen.length) { req.flash('bad', 'Marca al menos una fecha a la que vas a asistir.'); return res.redirect(`/eventos/${ev.id}#asistencia`); }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM date_rsvps WHERE user_id = ? AND date_id IN (SELECT id FROM event_dates WHERE event_id = ?)').run(req.user.id, ev.id);
    for (const id of chosen) db.prepare('INSERT OR IGNORE INTO date_rsvps (date_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  })();
  req.flash('ok', status === 'yes' ? (dates.length > 1 ? `¡Listo! Confirmaste ${chosen.length} de ${dates.length} fechas.` : '¡Asistencia confirmada! Puedes agregar el evento a tu calendario.') : 'Respuesta guardada.');
  res.redirect(`/eventos/${ev.id}#asistencia`);
});

// Archivo .ics para agendar
r.get('/eventos/:id/calendario.ics', requireLogin, loadEvent, (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  let dates = eventDates(req.event.id);
  if (req.query.fecha) dates = dates.filter(d => d.id === Number(req.query.fecha));
  if (req.query.mias) { const mine = new Set(db.prepare('SELECT date_id FROM date_rsvps WHERE user_id = ?').all(req.user.id).map(x => x.date_id)); dates = dates.filter(d => mine.has(d.id)); }
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="evento-${req.event.id}.ics"`);
  res.send(h.buildICS(req.event, settings.get('site_name'), `${base}/eventos/${req.event.id}`, dates));
});

module.exports = r;
module.exports.soldQty = soldQty;
