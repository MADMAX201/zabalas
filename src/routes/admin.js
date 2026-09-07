const express = require('express');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const { db, settings, DATA_DIR } = require('../db');
const { requireAdmin, upload, csrfCheck } = require('../middleware');
const h = require('../helpers');

const r = express.Router();
r.use(requireAdmin);

const removeFile = (f) => { if (f) { try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', f)); } catch {} } };

// ---------- Dashboard ----------
r.get('/', (req, res) => {
  const now = h.nowLocalISO();
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n,
    events: db.prepare('SELECT COUNT(*) AS n FROM events WHERE COALESCE(ends_at, starts_at) >= ?').get(now).n,
    review: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'review'").get().n,
    pending: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get().n,
    paidTotal: db.prepare("SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE status = 'paid'").get().n,
  };
  const events = db.prepare(`SELECT e.*,
      (SELECT COUNT(*) FROM rsvps WHERE event_id = e.id AND status='yes') AS going,
      (SELECT COUNT(*) FROM orders WHERE event_id = e.id AND status IN ('review')) AS review,
      (SELECT COUNT(*) FROM orders WHERE event_id = e.id AND status IN ('paid')) AS paid
    FROM events e ORDER BY starts_at DESC`).all();
  const reviewOrders = db.prepare(`SELECT o.*, u.name AS user_name, e.title AS event_title FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
    WHERE o.status='review' ORDER BY o.id ASC LIMIT 10`).all();
  res.render('admin/dashboard', { title: 'Administración', stats, events, reviewOrders });
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
});
function genCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = '';
  for (let i = 0; i < 6; i++) c += abc[Math.floor(Math.random() * abc.length)];
  return c;
}

r.get('/eventos/nuevo', (req, res) => res.render('admin/event_form', { title: 'Nuevo evento', ev: { published: 1 }, error: null }));
r.post('/eventos/nuevo', upload.single('image'), csrfCheck, (req, res) => {
  const f = eventForm(req.body);
  if (!f.title || !f.starts_at) return res.status(400).render('admin/event_form', { title: 'Nuevo evento', ev: f, error: 'Título y fecha de inicio son obligatorios.' });
  const info = db.prepare(`INSERT INTO events (title, description, starts_at, ends_at, location, address, rsvp_deadline, published, access_code, image, created_by)
    VALUES (@title, @description, @starts_at, @ends_at, @location, @address, @rsvp_deadline, @published, @access_code, @image, @by)`)
    .run({ ...f, image: req.file ? req.file.filename : null, by: req.user.id });
  req.flash('ok', 'Evento creado.');
  res.redirect(`/admin/eventos/${info.lastInsertRowid}`);
});

function loadEvent(req, res, next) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).render('error', { title: 'No encontrado', message: 'Evento no encontrado.' });
  req.event = ev; next();
}

r.get('/eventos/:id', loadEvent, (req, res) => {
  const ev = req.event;
  const attendees = db.prepare(`SELECT u.name, u.email, u.phone, r.status, r.guests, r.note, r.updated_at FROM rsvps r JOIN users u ON u.id=r.user_id
    WHERE r.event_id = ? ORDER BY CASE r.status WHEN 'yes' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, u.name`).all(ev.id);
  const products = db.prepare('SELECT * FROM products WHERE event_id = ? ORDER BY id').all(ev.id).map(p => ({
    ...p,
    sold: db.prepare(`SELECT COALESCE(SUM(oi.qty),0) AS n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.status IN ('pending','review','paid')`).get(p.id).n,
    paidQty: db.prepare(`SELECT COALESCE(SUM(oi.qty),0) AS n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.status='paid'`).get(p.id).n,
  }));
  const orders = db.prepare(`SELECT o.*, u.name AS user_name, u.phone FROM orders o JOIN users u ON u.id=o.user_id WHERE o.event_id = ? ORDER BY
    CASE o.status WHEN 'review' THEN 0 WHEN 'pending' THEN 1 WHEN 'paid' THEN 2 ELSE 3 END, o.id DESC`).all(ev.id)
    .map(o => ({ ...o, items: db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?').all(o.id) }));
  const totals = {
    yes: attendees.filter(a => a.status === 'yes').length,
    guests: attendees.filter(a => a.status === 'yes').reduce((s, a) => s + a.guests, 0),
    maybe: attendees.filter(a => a.status === 'maybe').length,
    no: attendees.filter(a => a.status === 'no').length,
    paid: orders.filter(o => o.status === 'paid').reduce((s, o) => s + o.total, 0),
    outstanding: orders.filter(o => ['pending', 'review'].includes(o.status)).reduce((s, o) => s + o.total, 0),
  };
  // Resumen por producto/talla (solo pagados + en verificación)
  const sizeSummary = db.prepare(`SELECT p.name, oi.size, o.status, SUM(oi.qty) AS qty FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
    WHERE o.event_id = ? AND o.status IN ('paid','review','pending') GROUP BY p.name, oi.size, o.status ORDER BY p.name, oi.size`).all(ev.id);
  const admitted = ev.access_code ? db.prepare('SELECT u.name, a.granted_at FROM event_access a JOIN users u ON u.id=a.user_id WHERE a.event_id=? ORDER BY a.granted_at DESC').all(ev.id) : [];
  res.render('admin/event', { title: ev.title, ev, attendees, products, orders, totals, sizeSummary, admitted });
});

r.get('/eventos/:id/editar', loadEvent, (req, res) => res.render('admin/event_form', { title: 'Editar evento', ev: req.event, error: null }));
r.post('/eventos/:id/editar', loadEvent, upload.single('image'), csrfCheck, (req, res) => {
  const f = eventForm(req.body);
  if (!f.title || !f.starts_at) return res.status(400).render('admin/event_form', { title: 'Editar evento', ev: { ...req.event, ...f }, error: 'Título y fecha de inicio son obligatorios.' });
  let image = req.event.image;
  if (req.body.remove_image) { removeFile(image); image = null; }
  if (req.file) { removeFile(req.event.image); image = req.file.filename; }
  db.prepare(`UPDATE events SET title=@title, description=@description, starts_at=@starts_at, ends_at=@ends_at, location=@location, address=@address,
    rsvp_deadline=@rsvp_deadline, published=@published, access_code=@access_code, image=@image WHERE id=@id`).run({ ...f, image, id: req.event.id });
  req.flash('ok', 'Evento actualizado.');
  res.redirect(`/admin/eventos/${req.event.id}`);
});

r.post('/eventos/:id/eliminar', loadEvent, (req, res) => {
  const ev = req.event;
  const files = db.prepare('SELECT receipt FROM orders WHERE event_id = ?').all(ev.id).map(o => o.receipt)
    .concat(db.prepare('SELECT image FROM products WHERE event_id = ?').all(ev.id).map(p => p.image), [ev.image]);
  db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
  files.forEach(removeFile);
  req.flash('ok', 'Evento eliminado.');
  res.redirect('/admin');
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
r.get('/pedidos', (req, res) => {
  const status = ['pending', 'review', 'paid', 'rejected', 'cancelled'].includes(req.query.estado) ? req.query.estado : null;
  const orders = db.prepare(`SELECT o.*, u.name AS user_name, u.phone, e.title AS event_title FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
    ${status ? 'WHERE o.status = ?' : ''} ORDER BY CASE o.status WHEN 'review' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, o.id DESC LIMIT 300`).all(...(status ? [status] : []))
    .map(o => ({ ...o, items: db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?').all(o.id) }));
  res.render('admin/orders', { title: 'Pagos y pedidos', orders, status });
});

r.post('/pedidos/:id/estado', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).render('error', { title: 'No encontrado', message: 'Pedido no encontrado.' });
  const status = ['paid', 'rejected', 'pending', 'cancelled'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.redirect(req.body.back || '/admin/pedidos');
  db.prepare("UPDATE orders SET status = ?, admin_note = ?, paid_at = CASE WHEN ? = 'paid' THEN datetime('now','localtime') ELSE NULL END WHERE id = ?")
    .run(status, String(req.body.admin_note || '').trim().slice(0, 300) || null, status, o.id);
  req.flash('ok', `Pedido #${o.id}: ${h.ORDER_STATUS[status].label}.`);
  res.redirect(req.body.back || '/admin/pedidos');
});

// Eliminar pedido (solo sin pago: pendiente, rechazado o cancelado)
r.post('/pedidos/:id/eliminar', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).render('error', { title: 'No encontrado', message: 'Pedido no encontrado.' });
  if (!['pending', 'rejected', 'cancelled'].includes(o.status)) { req.flash('bad', 'Solo se pueden eliminar pedidos sin pago (pendientes, rechazados o cancelados).'); return res.redirect(req.body.back || '/admin/pedidos'); }
  db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
  removeFile(o.receipt);
  req.flash('ok', `Pedido #${o.id} eliminado.`);
  res.redirect(req.body.back || '/admin/pedidos');
});

// ---------- Usuarios ----------
r.get('/usuarios', (req, res) => {
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM orders WHERE user_id=u.id AND status='paid') AS paid_orders,
    (SELECT COUNT(*) FROM rsvps WHERE user_id=u.id AND status='yes') AS rsvps FROM users u ORDER BY u.name`).all();
  res.render('admin/users', { title: 'Integrantes', users });
});
r.post('/usuarios/:id', (req, res) => {
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
r.get('/ajustes', (req, res) => res.render('admin/settings', { title: 'Ajustes' }));
r.post('/ajustes', upload.single('nequi_qr'), csrfCheck, (req, res) => {
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
  ws1.columns = [
    { header: 'Nombre', key: 'name' }, { header: 'Correo', key: 'email' }, { header: 'Teléfono', key: 'phone' },
    { header: 'Respuesta', key: 'status' }, { header: 'Acompañantes', key: 'guests' }, { header: 'Nota', key: 'note' }, { header: 'Actualizado', key: 'updated_at' },
  ];
  for (const a of db.prepare('SELECT u.name, u.email, u.phone, r.status, r.guests, r.note, r.updated_at FROM rsvps r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY u.name').all(ev.id))
    ws1.addRow({ ...a, status: h.RSVP[a.status].label });
  header(ws1);

  const ws2 = wb.addWorksheet('Pedidos');
  ws2.columns = [
    { header: 'Pedido', key: 'id' }, { header: 'Integrante', key: 'user_name' }, { header: 'Teléfono', key: 'phone' }, { header: 'Producto', key: 'product' },
    { header: 'Para', key: 'for_name' }, { header: 'Talla', key: 'size' }, { header: 'Cant.', key: 'qty' }, { header: 'Precio', key: 'unit_price' },
    { header: 'Subtotal', key: 'subtotal' }, { header: 'Estado', key: 'status' }, { header: 'Ref. Nequi', key: 'receipt_ref' }, { header: 'Fecha pedido', key: 'created_at' }, { header: 'Fecha pago', key: 'paid_at' },
  ];
  const rows = db.prepare(`SELECT o.id, u.name AS user_name, u.phone, p.name AS product, oi.for_name, oi.size, oi.qty, oi.unit_price, o.status, o.receipt_ref, o.created_at, o.paid_at
    FROM orders o JOIN users u ON u.id=o.user_id JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.event_id=? ORDER BY o.id`).all(ev.id);
  for (const x of rows) ws2.addRow({ ...x, subtotal: x.qty * x.unit_price, status: h.ORDER_STATUS[x.status].label });
  ['unit_price', 'subtotal'].forEach(k => ws2.getColumn(k).numFmt = '"$"#,##0');
  header(ws2);

  const ws3 = wb.addWorksheet('Resumen tallas');
  ws3.columns = [{ header: 'Producto', key: 'name' }, { header: 'Talla', key: 'size' }, { header: 'Pagadas', key: 'paid' }, { header: 'En verificación', key: 'review' }, { header: 'Pendientes', key: 'pending' }];
  const sum = {};
  for (const x of db.prepare(`SELECT p.name, oi.size, o.status, SUM(oi.qty) AS qty FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
      WHERE o.event_id=? AND o.status IN ('paid','review','pending') GROUP BY p.name, oi.size, o.status`).all(ev.id)) {
    const k = `${x.name}|${x.size || ''}`; sum[k] = sum[k] || { name: x.name, size: x.size || '-', paid: 0, review: 0, pending: 0 }; sum[k][x.status] += x.qty;
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
