const express = require('express');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const { db, settings, DATA_DIR, syncEventRange, eventDates, companionsFor, uniqueCompanions, paymentFor, paidAmount, refreshOrderStatus, orderPayments } = require('../db');
const { requireAdmin, requireManager, upload, csrfCheck } = require('../middleware');
const h = require('../helpers');

const r = express.Router();
r.use(requireManager);

const removeFile = (f) => { if (f) { try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', f)); } catch {} } };

// ---------- Dashboard ----------
r.get('/', requireAdmin, (req, res) => {
  const now = h.nowLocalISO();
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n,
    events: db.prepare('SELECT COUNT(*) AS n FROM events WHERE COALESCE(ends_at, starts_at) >= ?').get(now).n,
    review: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'review'").get().n,
    pending: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get().n,
    paidTotal: db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE status = 'confirmed'").get().n,
  };
  const events = db.prepare(`SELECT e.*,
      (SELECT COUNT(*) FROM rsvps WHERE event_id = e.id AND status='yes') AS going,
      (SELECT COUNT(*) FROM orders WHERE event_id = e.id AND status IN ('review')) AS review,
      (SELECT COUNT(*) FROM orders WHERE event_id = e.id AND status IN ('paid')) AS paid,
      (SELECT name FROM users WHERE id = e.organizer_id) AS organizer_name
    FROM events e ORDER BY starts_at DESC`).all();
  const reviewOrders = db.prepare(`SELECT o.*, u.name AS user_name, e.title AS event_title FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
    WHERE o.status='review' ORDER BY o.id ASC LIMIT 10`).all();
  const pendingEvents = db.prepare(`SELECT e.*, u.name AS organizer_name FROM events e LEFT JOIN users u ON u.id = e.organizer_id WHERE e.status = 'pending' ORDER BY e.created_at`).all();
  res.render('admin/dashboard', { title: 'Administración', stats, events, reviewOrders, pendingEvents });
});

// ---------- Eventos ----------
const eventForm = (body) => ({
  title: String(body.title || '').trim(),
  description: String(body.description || '').trim() || null,
  starts_at: String(body.starts_at || '').trim(),
  ends_at: String(body.ends_at || '').trim() || null,
  location: String(body.location || '').trim() || null,
  address: String(body.address || '').trim() || null,
  rsvp_deadline: String(body.rsvp_deadline || '').trim() || null,
  published: body.published ? 1 : 0,
  access_code: body.is_private ? (String(body.access_code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || genCode()) : null,
  pay_method: ['nequi', 'breb'].includes(body.pay_method) ? body.pay_method : 'nequi',
  pay_number: String(body.pay_number || '').trim().slice(0, 80) || null,
  pay_holder: String(body.pay_holder || '').trim().slice(0, 80) || null,
});
function genCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = '';
  for (let i = 0; i < 6; i++) c += abc[Math.floor(Math.random() * abc.length)];
  return c;
}

r.get('/eventos/nuevo', requireAdmin, (req, res) => res.render('admin/event_form', { title: 'Nuevo evento', ev: { published: 1 }, error: null }));
r.post('/eventos/nuevo', requireAdmin, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'pay_qr', maxCount: 1 }]), csrfCheck, (req, res) => {
  const f = eventForm(req.body);
  if (!f.title || !f.starts_at) return res.status(400).render('admin/event_form', { title: 'Nuevo evento', ev: f, error: 'Título y fecha de inicio son obligatorios.' });
  const files = req.files || {};
  const info = db.prepare(`INSERT INTO events (title, description, starts_at, ends_at, location, address, rsvp_deadline, published, access_code, image, created_by, pay_method, pay_number, pay_holder, pay_qr, status)
    VALUES (@title, @description, @starts_at, @ends_at, @location, @address, @rsvp_deadline, @published, @access_code, @image, @by, @pay_method, @pay_number, @pay_holder, @pay_qr, 'approved')`)
    .run({ ...f, image: files.image ? files.image[0].filename : null, pay_qr: files.pay_qr ? files.pay_qr[0].filename : null, by: req.user.id });
  db.prepare('INSERT INTO event_dates (event_id, starts_at, ends_at, location, address) VALUES (?, ?, ?, ?, ?)').run(info.lastInsertRowid, f.starts_at, f.ends_at, f.location, f.address);
  req.flash('ok', 'Evento creado. Puedes agregar más fechas abajo si tiene varias sesiones.');
  res.redirect(`/admin/eventos/${info.lastInsertRowid}`);
});

function loadEvent(req, res, next) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).render('error', { title: 'No encontrado', message: 'Evento no encontrado.' });
  req.event = ev; next();
}

r.get('/eventos/:id', loadEvent, (req, res) => {
  const ev = req.event;
  const attendees = db.prepare(`SELECT u.id AS user_id, u.name, u.email, u.phone, r.status, r.guests, r.extra_guests, r.note, r.updated_at FROM rsvps r JOIN users u ON u.id=r.user_id
    WHERE r.event_id = ? ORDER BY CASE r.status WHEN 'yes' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, u.name`).all(ev.id)
    .map(a => ({ ...a, companions: companionsFor(ev.id, a.user_id).map(c => c.name) }));
  const products = db.prepare('SELECT * FROM products WHERE event_id = ? ORDER BY id').all(ev.id).map(p => ({
    ...p,
    sold: db.prepare(`SELECT COALESCE(SUM(oi.qty),0) AS n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.status IN ('pending','partial','review','paid')`).get(p.id).n,
    paidQty: db.prepare(`SELECT COALESCE(SUM(oi.qty),0) AS n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.status='paid'`).get(p.id).n,
  }));
  const orders = db.prepare(`SELECT o.*, u.name AS user_name, u.phone FROM orders o JOIN users u ON u.id=o.user_id WHERE o.event_id = ? ORDER BY
    CASE o.status WHEN 'review' THEN 0 WHEN 'pending' THEN 1 WHEN 'partial' THEN 2 WHEN 'paid' THEN 3 ELSE 4 END, o.id DESC`).all(ev.id)
    .map(o => ({ ...o, paid: paidAmount(o.id), payments: orderPayments(o.id), items: db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?').all(o.id) }));
  const totals = {
    yes: attendees.filter(a => a.status === 'yes').length,
    guests: uniqueCompanions(ev.id).unique + attendees.filter(a => a.status === 'yes').reduce((s, a) => s + Math.max(0, a.guests - a.companions.length), 0),
    dups: uniqueCompanions(ev.id).dups,
    self: uniqueCompanions(ev.id).self,
    maybe: attendees.filter(a => a.status === 'maybe').length,
    no: attendees.filter(a => a.status === 'no').length,
    paid: orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.paid, 0),
    outstanding: orders.filter(o => !['cancelled', 'paid'].includes(o.status)).reduce((s, o) => s + (o.total - o.paid), 0),
  };
  // Resumen por producto/talla (solo pagados + en verificación)
  const sizeSummary = db.prepare(`SELECT p.name, oi.size, o.status, SUM(oi.qty) AS qty FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
    WHERE o.event_id = ? AND o.status IN ('paid','partial','review','pending') GROUP BY p.name, oi.size, o.status ORDER BY p.name, oi.size`).all(ev.id);
  const dates = eventDates(ev.id).map(d => ({ ...d, going: db.prepare('SELECT COUNT(*) AS n FROM date_rsvps WHERE date_id = ?').get(d.id).n }));
  const dateRsvps = {};
  for (const x of db.prepare('SELECT dr.user_id, dr.date_id FROM date_rsvps dr JOIN event_dates d ON d.id = dr.date_id WHERE d.event_id = ?').all(ev.id)) (dateRsvps[x.user_id] = dateRsvps[x.user_id] || new Set()).add(x.date_id);
  const admitted = ev.access_code ? db.prepare('SELECT u.name, a.granted_at FROM event_access a JOIN users u ON u.id=a.user_id WHERE a.event_id=? ORDER BY a.granted_at DESC').all(ev.id) : [];
  const organizer = ev.organizer_id ? db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(ev.organizer_id) : null;
  res.render('admin/event', { title: ev.title, ev, attendees, products, orders, totals, sizeSummary, admitted, dates, dateRsvps, organizer, pay: paymentFor(ev) });
});

r.get('/eventos/:id/editar', loadEvent, (req, res) => res.render('admin/event_form', { title: 'Editar evento', ev: req.event, error: null }));
r.post('/eventos/:id/editar', loadEvent, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'pay_qr', maxCount: 1 }]), csrfCheck, (req, res) => {
  const f = eventForm(req.body);
  if (!f.title || !f.starts_at) return res.status(400).render('admin/event_form', { title: 'Editar evento', ev: { ...req.event, ...f }, error: 'Título y fecha de inicio son obligatorios.' });
  const files = req.files || {};
  let image = req.event.image;
  if (req.body.remove_image) { removeFile(image); image = null; }
  if (files.image) { removeFile(req.event.image); image = files.image[0].filename; }
  let pay_qr = req.event.pay_qr;
  if (req.body.remove_pay_qr) { removeFile(pay_qr); pay_qr = null; }
  if (files.pay_qr) { removeFile(req.event.pay_qr); pay_qr = files.pay_qr[0].filename; }
  // El organizador no puede cambiar publicado/privado de un evento ya aprobado (eso es del admin)
  if (req.isOrganizer && req.event.status === 'approved') { f.published = req.event.published; f.access_code = req.event.access_code; }
  db.prepare(`UPDATE events SET title=@title, description=@description, starts_at=@starts_at, ends_at=@ends_at, location=@location, address=@address,
    rsvp_deadline=@rsvp_deadline, published=@published, access_code=@access_code, image=@image, pay_method=@pay_method, pay_number=@pay_number, pay_holder=@pay_holder, pay_qr=@pay_qr WHERE id=@id`)
    .run({ ...f, image, pay_qr, id: req.event.id });
  // La fecha del formulario es la primera fecha del evento
  const first = eventDates(req.event.id)[0];
  if (first) db.prepare('UPDATE event_dates SET starts_at = ?, ends_at = ?, location = COALESCE(?, location), address = COALESCE(?, address) WHERE id = ?').run(f.starts_at, f.ends_at, f.location, f.address, first.id);
  else db.prepare('INSERT INTO event_dates (event_id, starts_at, ends_at, location, address) VALUES (?, ?, ?, ?, ?)').run(req.event.id, f.starts_at, f.ends_at, f.location, f.address);
  syncEventRange(req.event.id);
  req.flash('ok', 'Evento actualizado.');
  res.redirect(`/admin/eventos/${req.event.id}`);
});

r.post('/eventos/:id/eliminar', loadEvent, (req, res) => {
  const ev = req.event;
  if (req.isOrganizer && ev.status === 'approved') { req.flash('bad', 'Un evento aprobado solo lo elimina un administrador.'); return res.redirect(`/admin/eventos/${ev.id}`); }
  const files = db.prepare('SELECT receipt FROM orders WHERE event_id = ?').all(ev.id).map(o => o.receipt)
    .concat(db.prepare('SELECT image FROM products WHERE event_id = ?').all(ev.id).map(p => p.image), [ev.image]);
  db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
  files.forEach(removeFile); removeFile(ev.pay_qr);
  req.flash('ok', 'Evento eliminado.');
  res.redirect(req.isOrganizer ? '/mis-eventos' : '/admin');
});

// ---------- Aprobación de eventos propuestos ----------
r.post('/eventos/:id/aprobar', requireAdmin, loadEvent, (req, res) => {
  const code = req.event.access_code ? req.event.access_code : null;
  db.prepare("UPDATE events SET status = 'approved', reject_reason = NULL, published = 1 WHERE id = ?").run(req.event.id);
  req.flash('ok', `Evento aprobado y publicado${code ? ` (código de invitación ${code})` : ''}.`);
  res.redirect(`/admin/eventos/${req.event.id}`);
});
r.post('/eventos/:id/rechazar', requireAdmin, loadEvent, (req, res) => {
  db.prepare("UPDATE events SET status = 'rejected', reject_reason = ? WHERE id = ?").run(String(req.body.reason || '').trim().slice(0, 300) || null, req.event.id);
  req.flash('ok', 'Evento rechazado. El organizador verá el motivo.');
  res.redirect('/admin');
});

// ---------- Fechas del evento ----------
r.post('/eventos/:id/fechas', loadEvent, (req, res) => {
  const starts_at = String(req.body.starts_at || '').trim();
  if (!starts_at) { req.flash('bad', 'La fecha de inicio es obligatoria.'); return res.redirect(`/admin/eventos/${req.event.id}#fechas`); }
  db.prepare('INSERT INTO event_dates (event_id, label, starts_at, ends_at, location, address) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.event.id, String(req.body.label || '').trim().slice(0, 60) || null, starts_at, String(req.body.ends_at || '').trim() || null,
      String(req.body.location || '').trim() || null, String(req.body.address || '').trim() || null);
  syncEventRange(req.event.id);
  req.flash('ok', 'Fecha agregada.');
  res.redirect(`/admin/eventos/${req.event.id}#fechas`);
});
r.post('/fechas/:did/editar', (req, res) => {
  const d = db.prepare('SELECT * FROM event_dates WHERE id = ?').get(req.params.did);
  if (!d) return res.redirect('/admin');
  const starts_at = String(req.body.starts_at || '').trim() || d.starts_at;
  db.prepare('UPDATE event_dates SET label = ?, starts_at = ?, ends_at = ?, location = ?, address = ? WHERE id = ?')
    .run(String(req.body.label || '').trim().slice(0, 60) || null, starts_at, String(req.body.ends_at || '').trim() || null,
      String(req.body.location || '').trim() || null, String(req.body.address || '').trim() || null, d.id);
  syncEventRange(d.event_id);
  req.flash('ok', 'Fecha actualizada.');
  res.redirect(`/admin/eventos/${d.event_id}#fechas`);
});
r.post('/fechas/:did/eliminar', (req, res) => {
  const d = db.prepare('SELECT * FROM event_dates WHERE id = ?').get(req.params.did);
  if (!d) return res.redirect('/admin');
  if (db.prepare('SELECT COUNT(*) AS n FROM event_dates WHERE event_id = ?').get(d.event_id).n <= 1) { req.flash('bad', 'El evento debe tener al menos una fecha.'); return res.redirect(`/admin/eventos/${d.event_id}#fechas`); }
  db.prepare('DELETE FROM event_dates WHERE id = ?').run(d.id);
  syncEventRange(d.event_id);
  req.flash('ok', 'Fecha eliminada.');
  res.redirect(`/admin/eventos/${d.event_id}#fechas`);
});

// ---------- Productos ----------
const productForm = (body) => ({
  name: String(body.name || '').trim(),
  description: String(body.description || '').trim() || null,
  price: Math.max(0, parseInt(String(body.price || '0').replace(/[^\d]/g, ''), 10) || 0),
  sizes: String(body.sizes || '').split(',').map(s => s.trim()).filter(Boolean).join(','),
  stock: body.stock === '' || body.stock === undefined ? null : Math.max(0, parseInt(body.stock, 10) || 0),
  order_deadline: String(body.order_deadline || '').trim() || null,
  active: body.active ? 1 : 0,
});

r.get('/eventos/:id/productos/nuevo', loadEvent, (req, res) =>
  res.render('admin/product_form', { title: 'Nuevo producto', ev: req.event, p: { active: 1, sizes: 'XS,S,M,L,XL,XXL' }, error: null }));
r.post('/eventos/:id/productos/nuevo', loadEvent, upload.single('image'), csrfCheck, (req, res) => {
  const f = productForm(req.body);
  if (!f.name || !f.price) return res.status(400).render('admin/product_form', { title: 'Nuevo producto', ev: req.event, p: f, error: 'Nombre y precio son obligatorios.' });
  db.prepare(`INSERT INTO products (event_id, name, description, price, sizes, stock, order_deadline, active, image)
    VALUES (@event_id, @name, @description, @price, @sizes, @stock, @order_deadline, @active, @image)`)
    .run({ ...f, event_id: req.event.id, image: req.file ? req.file.filename : null });
  req.flash('ok', 'Producto creado.');
  res.redirect(`/admin/eventos/${req.event.id}#productos`);
});

function loadProduct(req, res, next) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.pid);
  if (!p) return res.status(404).render('error', { title: 'No encontrado', message: 'Producto no encontrado.' });
  req.product = p; req.event = db.prepare('SELECT * FROM events WHERE id = ?').get(p.event_id); next();
}
r.get('/productos/:pid/editar', loadProduct, (req, res) => res.render('admin/product_form', { title: 'Editar producto', ev: req.event, p: req.product, error: null }));
r.post('/productos/:pid/editar', loadProduct, upload.single('image'), csrfCheck, (req, res) => {
  const f = productForm(req.body);
  if (!f.name || !f.price) return res.status(400).render('admin/product_form', { title: 'Editar producto', ev: req.event, p: { ...req.product, ...f }, error: 'Nombre y precio son obligatorios.' });
  let image = req.product.image;
  if (req.body.remove_image) { removeFile(image); image = null; }
  if (req.file) { removeFile(req.product.image); image = req.file.filename; }
  db.prepare(`UPDATE products SET name=@name, description=@description, price=@price, sizes=@sizes, stock=@stock, order_deadline=@order_deadline, active=@active, image=@image WHERE id=@id`)
    .run({ ...f, image, id: req.product.id });
  req.flash('ok', 'Producto actualizado.');
  res.redirect(`/admin/eventos/${req.event.id}#productos`);
});
r.post('/productos/:pid/eliminar', loadProduct, (req, res) => {
  const used = db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?').get(req.product.id).n;
  if (used) {
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.product.id);
    req.flash('ok', 'El producto tiene pedidos, así que se desactivó en vez de eliminarse.');
  } else {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.product.id);
    removeFile(req.product.image);
    req.flash('ok', 'Producto eliminado.');
  }
  res.redirect(`/admin/eventos/${req.event.id}#productos`);
});

// ---------- Pagos / pedidos ----------
r.get('/pedidos', requireAdmin, (req, res) => {
  const status = ['pending', 'partial', 'review', 'paid', 'rejected', 'cancelled'].includes(req.query.estado) ? req.query.estado : null;
  const orders = db.prepare(`SELECT o.*, u.name AS user_name, u.phone, e.title AS event_title FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
    ${status ? 'WHERE o.status = ?' : ''} ORDER BY CASE o.status WHEN 'review' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, o.id DESC LIMIT 300`).all(...(status ? [status] : []))
    .map(o => ({ ...o, paid: paidAmount(o.id), payments: orderPayments(o.id), items: db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?').all(o.id) }));
  res.render('admin/orders', { title: 'Pagos y pedidos', orders, status });
});

// Confirmar / rechazar un abono
r.post('/abonos/:pid/estado', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.pid);
  if (!p) return res.status(404).render('error', { title: 'No encontrado', message: 'Abono no encontrado.' });
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(p.order_id);
  if (req.isOrganizer) { const ev = db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(o.event_id); if (!ev || ev.organizer_id !== req.user.id) return res.status(403).render('error', { title: 'Sin permiso', message: 'No puedes gestionar pedidos de otros eventos.' }); }
  const status = ['confirmed', 'rejected', 'review'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.redirect(req.body.back || '/admin/pedidos');
  let amount = parseInt(String(req.body.amount || '').replace(/[^\d]/g, ''), 10) || p.amount;
  if (amount <= 0) amount = p.amount;
  db.prepare("UPDATE payments SET status = ?, amount = ?, note = ?, confirmed_at = CASE WHEN ? = 'confirmed' THEN datetime('now','localtime') ELSE NULL END WHERE id = ?")
    .run(status, amount, String(req.body.note || '').trim().slice(0, 300) || null, status, p.id);
  const upd = refreshOrderStatus(o.id);
  req.flash('ok', `Abono #${p.id} ${h.PAY_STATUS[status].label.toLowerCase()}. Pedido #${o.id}: ${h.ORDER_STATUS[upd.status].label} (${h.fmtCOP(paidAmount(o.id))} de ${h.fmtCOP(o.total)}).`);
  res.redirect(req.body.back || '/admin/pedidos');
});
// Registrar un abono manual (recibido por fuera) o marcar pagado
r.post('/pedidos/:id/abono', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).render('error', { title: 'No encontrado', message: 'Pedido no encontrado.' });
  if (req.isOrganizer) { const ev = db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(o.event_id); if (!ev || ev.organizer_id !== req.user.id) return res.status(403).render('error', { title: 'Sin permiso', message: 'No puedes gestionar pedidos de otros eventos.' }); }
  if (req.body.action === 'cancel') { db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id); req.flash('ok', `Pedido #${o.id} cancelado.`); return res.redirect(req.body.back || '/admin/pedidos'); }
  if (req.body.action === 'reopen') { db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(o.id); refreshOrderStatus(o.id); req.flash('ok', `Pedido #${o.id} reabierto.`); return res.redirect(req.body.back || '/admin/pedidos'); }
  const remaining = o.total - paidAmount(o.id);
  let amount = req.body.action === 'full' ? remaining : (parseInt(String(req.body.amount || '').replace(/[^\d]/g, ''), 10) || 0);
  if (amount <= 0 || remaining <= 0) { req.flash('bad', 'Indica un valor válido.'); return res.redirect(req.body.back || '/admin/pedidos'); }
  if (amount > remaining) amount = remaining;
  const method = ['cash', 'transfer', 'other'].includes(req.body.method) ? req.body.method : 'cash';
  db.prepare("INSERT INTO payments (order_id, amount, status, method, note, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, datetime('now','localtime'))")
    .run(o.id, amount, method, (String(req.body.note || '').trim().slice(0, 260) || 'Abono registrado por ' + req.user.name.split(' ')[0]));
  const upd = refreshOrderStatus(o.id);
  req.flash('ok', `Abono de ${h.fmtCOP(amount)} registrado. Pedido #${o.id}: ${h.ORDER_STATUS[upd.status].label}.`);
  res.redirect(req.body.back || '/admin/pedidos');
});

// Eliminar pedido (solo sin pago: pendiente, rechazado o cancelado)
r.post('/pedidos/:id/eliminar', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).render('error', { title: 'No encontrado', message: 'Pedido no encontrado.' });
  if (!['pending', 'cancelled'].includes(o.status) || paidAmount(o.id) > 0) { req.flash('bad', 'Solo se pueden eliminar pedidos sin abonos confirmados (pendientes o cancelados).'); return res.redirect(req.body.back || '/admin/pedidos'); }
  if (req.isOrganizer) { const ev = db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(o.event_id); if (!ev || ev.organizer_id !== req.user.id) return res.status(403).render('error', { title: 'Sin permiso', message: 'No puedes gestionar pedidos de otros eventos.' }); }
  orderPayments(o.id).forEach(p => removeFile(p.receipt));
  db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
  req.flash('ok', `Pedido #${o.id} eliminado.`);
  res.redirect(req.body.back || '/admin/pedidos');
});

// ---------- Usuarios ----------
r.get('/usuarios', requireAdmin, (req, res) => {
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM orders WHERE user_id=u.id AND status='paid') AS paid_orders,
    (SELECT COUNT(*) FROM rsvps WHERE user_id=u.id AND status='yes') AS rsvps FROM users u ORDER BY u.name`).all();
  res.render('admin/users', { title: 'Integrantes', users });
});
r.post('/usuarios/:id', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.redirect('/admin/usuarios');
  const action = req.body.action;
  if (u.id === req.user.id && ['deactivate', 'demote'].includes(action)) { req.flash('bad', 'No puedes quitarte permisos a ti mismo.'); return res.redirect('/admin/usuarios'); }
  if (action === 'deactivate') db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
  if (action === 'activate') db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(u.id);
  if (action === 'promote') db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
  if (action === 'demote') db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(u.id);
  if (action === 'reset') {
    const tmp = Math.random().toString(36).slice(2, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(tmp, 10), u.id);
    req.flash('ok', `Contraseña temporal para ${u.name}: ${tmp} (pídele que la cambie en su perfil).`);
    return res.redirect('/admin/usuarios');
  }
  req.flash('ok', 'Usuario actualizado.');
  res.redirect('/admin/usuarios');
});

// ---------- Ajustes ----------
r.get('/ajustes', requireAdmin, (req, res) => res.render('admin/settings', { title: 'Ajustes' }));
r.post('/ajustes', requireAdmin, upload.single('nequi_qr'), csrfCheck, (req, res) => {
  for (const k of ['site_name', 'family_code', 'nequi_number', 'nequi_holder', 'payment_instructions']) {
    if (req.body[k] !== undefined) settings.set(k, String(req.body[k]).trim());
  }
  if (req.body.remove_qr) { removeFile(settings.get('nequi_qr')); settings.set('nequi_qr', ''); }
  if (req.file) { removeFile(settings.get('nequi_qr')); settings.set('nequi_qr', req.file.filename); }
  req.flash('ok', 'Ajustes guardados.');
  res.redirect('/admin/ajustes');
});

// ---------- Exportar Excel ----------
r.get('/eventos/:id/exportar.xlsx', loadEvent, async (req, res) => {
  const ev = req.event;
  const wb = new ExcelJS.Workbook();
  const header = (ws) => { ws.getRow(1).font = { bold: true }; ws.columns.forEach(c => { c.width = Math.max(14, (c.header || '').length + 4); }); };

  const ws1 = wb.addWorksheet('Asistencia');
  const dates = eventDates(ev.id);
  ws1.columns = [
    { header: 'Nombre', key: 'name' }, { header: 'Correo', key: 'email' }, { header: 'Teléfono', key: 'phone' },
    { header: 'Respuesta', key: 'status' }, { header: 'Acompañantes', key: 'guests' }, { header: 'Quiénes', key: 'companions' },
    ...(dates.length > 1 ? dates.map(d => ({ header: (d.label ? d.label + ' ' : '') + h.fmtDayShort(d.starts_at), key: 'd' + d.id })) : []),
    { header: 'Nota', key: 'note' }, { header: 'Actualizado', key: 'updated_at' },
  ];
  for (const a of db.prepare('SELECT u.id AS uid, u.name, u.email, u.phone, r.status, r.guests, r.note, r.updated_at FROM rsvps r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY u.name').all(ev.id)) {
    const row = { ...a, status: h.RSVP[a.status].label, companions: companionsFor(ev.id, a.uid).map(c => c.name).join(', ') };
    if (dates.length > 1) for (const d of dates) row['d' + d.id] = db.prepare('SELECT 1 FROM date_rsvps WHERE date_id = ? AND user_id = ?').get(d.id, a.uid) ? 'Sí' : '';
    ws1.addRow(row);
  }
  if (dates.length > 1) { const tot = { name: 'TOTAL' }; for (const d of dates) tot['d' + d.id] = db.prepare('SELECT COUNT(*) AS n FROM date_rsvps WHERE date_id = ?').get(d.id).n; ws1.addRow(tot).font = { bold: true }; }
  header(ws1);

  const ws2 = wb.addWorksheet('Pedidos');
  ws2.columns = [
    { header: 'Pedido', key: 'id' }, { header: 'Integrante', key: 'user_name' }, { header: 'Teléfono', key: 'phone' }, { header: 'Producto', key: 'product' },
    { header: 'Para', key: 'for_name' }, { header: 'Talla', key: 'size' }, { header: 'Cant.', key: 'qty' }, { header: 'Precio', key: 'unit_price' },
    { header: 'Subtotal', key: 'subtotal' }, { header: 'Estado', key: 'status' }, { header: 'Total pedido', key: 'total' }, { header: 'Abonado', key: 'paid' }, { header: 'Saldo', key: 'balance' }, { header: 'Fecha pedido', key: 'created_at' }, { header: 'Fecha pago', key: 'paid_at' },
  ];
  const rows = db.prepare(`SELECT o.id, u.name AS user_name, u.phone, p.name AS product, oi.for_name, oi.size, oi.qty, oi.unit_price, o.status, o.total, o.created_at, o.paid_at
    FROM orders o JOIN users u ON u.id=o.user_id JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.event_id=? ORDER BY o.id`).all(ev.id);
  for (const x of rows) { const paid = paidAmount(x.id); ws2.addRow({ ...x, subtotal: x.qty * x.unit_price, status: h.ORDER_STATUS[x.status].label, paid, balance: Math.max(0, x.total - paid) }); }
  ['unit_price', 'subtotal', 'total', 'paid', 'balance'].forEach(k => ws2.getColumn(k).numFmt = '"$"#,##0');
  // Hoja de saldos por persona
  const ws4 = wb.addWorksheet('Saldos');
  ws4.columns = [{ header: 'Integrante', key: 'name' }, { header: 'Teléfono', key: 'phone' }, { header: 'Pedidos', key: 'n' }, { header: 'Total', key: 'total' }, { header: 'Abonado', key: 'paid' }, { header: 'Saldo', key: 'balance' }];
  const per = {};
  for (const o of db.prepare("SELECT o.id, o.total, u.name, u.phone FROM orders o JOIN users u ON u.id=o.user_id WHERE o.event_id=? AND o.status != 'cancelled'").all(ev.id)) {
    per[o.name] = per[o.name] || { name: o.name, phone: o.phone, n: 0, total: 0, paid: 0 }; per[o.name].n++; per[o.name].total += o.total; per[o.name].paid += paidAmount(o.id);
  }
  Object.values(per).forEach(p => ws4.addRow({ ...p, balance: Math.max(0, p.total - p.paid) }));
  ['total', 'paid', 'balance'].forEach(k => ws4.getColumn(k).numFmt = '"$"#,##0');
  header(ws4);
  header(ws2);

  const ws3 = wb.addWorksheet('Resumen tallas');
  ws3.columns = [{ header: 'Producto', key: 'name' }, { header: 'Talla', key: 'size' }, { header: 'Pagadas', key: 'paid' }, { header: 'En verificación', key: 'review' }, { header: 'Pendientes', key: 'pending' }];
  const sum = {};
  for (const x of db.prepare(`SELECT p.name, oi.size, o.status, SUM(oi.qty) AS qty FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
      WHERE o.event_id=? AND o.status IN ('paid','partial','review','pending') GROUP BY p.name, oi.size, o.status`).all(ev.id)) {
    const k = `${x.name}|${x.size || ''}`; sum[k] = sum[k] || { name: x.name, size: x.size || '-', paid: 0, review: 0, pending: 0 }; sum[k][x.status === 'partial' ? 'pending' : x.status] += x.qty;
  }
  Object.values(sum).forEach(r => ws3.addRow(r));
  header(ws3);

  const safe = ev.title.replace(/[^\wáéíóúñÁÉÍÓÚÑ ]+/g, '').trim().replace(/\s+/g, '_') || 'evento';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

module.exports = r;
