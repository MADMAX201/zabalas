const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR, household, paymentFor, paidAmount, refreshOrderStatus, orderPayments } = require('../db');
const { requireLogin, upload, csrfCheck } = require('../middleware');
const h = require('../helpers');
const { soldQty } = require('./events');

const r = express.Router();

// Valida las líneas del formulario (item_product[], item_size[], item_qty[], item_for[]).
// excludeOrderId: al editar, las unidades del propio pedido no cuentan contra el stock.
function parseItems(body, ev, excludeOrderId = null) {
  const toArr = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const pids = toArr(body.item_product), sizes = toArr(body.item_size), qtys = toArr(body.item_qty), fors = toArr(body.item_for);
  const items = [];
  for (let i = 0; i < pids.length; i++) {
    const qty = parseInt(qtys[i], 10) || 0;
    if (qty <= 0) continue;
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND event_id = ? AND active = 1').get(pids[i], ev.id);
    if (!p) continue;
    if (p.order_deadline && h.isPast(p.order_deadline)) throw new Error(`Ya cerró el plazo para pedir "${p.name}".`);
    const sizeList = (p.sizes || '').split(',').map(s => s.trim()).filter(Boolean);
    const size = sizeList.length ? String(sizes[i] || '').trim() : null;
    if (sizeList.length && !sizeList.includes(size)) throw new Error(`Selecciona una talla válida para "${p.name}".`);
    items.push({ product_id: p.id, size, qty: Math.min(qty, 50), unit_price: p.price, for_name: String(fors[i] || '').trim().slice(0, 80) || null, _p: p });
  }
  if (!items.length) throw new Error('Agrega al menos un producto con cantidad.');
  // Stock: suma por producto de este pedido + lo ya vendido (sin el propio pedido)
  const byProduct = {};
  for (const it of items) byProduct[it.product_id] = (byProduct[it.product_id] || 0) + it.qty;
  for (const [pid, qty] of Object.entries(byProduct)) {
    const p = items.find(i => i.product_id == pid)._p;
    if (p.stock === null) continue;
    const own = excludeOrderId ? db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM order_items WHERE order_id = ? AND product_id = ?').get(excludeOrderId, p.id).n : 0;
    const left = p.stock - (soldQty(p.id) - own);
    if (qty > left) throw new Error(`No hay suficientes unidades de "${p.name}" (quedan ${Math.max(0, left)}).`);
  }
  return items.map(({ _p, ...it }) => it);
}

// Crear pedido
r.post('/eventos/:id/pedido', requireLogin, (req, res) => {
  const ev = db.prepare("SELECT * FROM events WHERE id = ? AND published = 1 AND status = 'approved'").get(req.params.id);
  if (!ev) return res.status(404).render('error', { title: 'No encontrado', message: 'Evento no encontrado.' });
  if (ev.access_code && req.user.role !== 'admin' && !db.prepare('SELECT 1 FROM event_access WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id))
    return res.status(403).render('error', { title: 'Evento privado', message: 'Necesitas el código del evento para hacer pedidos.' });
  let items;
  try { items = parseItems(req.body, ev); } catch (e) { req.flash('bad', e.message); return res.redirect(`/eventos/${ev.id}#tienda`); }
  const total = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const orderId = db.transaction(() => {
    const info = db.prepare('INSERT INTO orders (user_id, event_id, total) VALUES (?, ?, ?)').run(req.user.id, ev.id, total);
    const ins = db.prepare('INSERT INTO order_items (order_id, product_id, for_name, size, qty, unit_price) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of items) ins.run(info.lastInsertRowid, it.product_id, it.for_name, it.size, it.qty, it.unit_price);
    return info.lastInsertRowid;
  })();
  res.redirect(`/pedidos/${orderId}`);
});

function loadOrder(req, res, next) {
  const o = db.prepare('SELECT o.*, e.title AS event_title, e.organizer_id FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = ?').get(req.params.id);
  if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin' && o.organizer_id !== req.user.id)) return res.status(404).render('error', { title: 'No encontrado', message: 'Pedido no encontrado.' });
  o.pay = paymentFor(db.prepare('SELECT * FROM events WHERE id = ?').get(o.event_id));
  o.payments = orderPayments(o.id); o.paid = paidAmount(o.id); o.balance = Math.max(0, o.total - o.paid);
  o.inReview = o.payments.filter(p => p.status === 'review').reduce((s, p) => s + p.amount, 0);
  o.items = db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id = ?').all(o.id);
  req.order = o; next();
}

r.get('/pedidos', requireLogin, (req, res) => {
  const orders = db.prepare('SELECT o.*, e.title AS event_title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = ? ORDER BY o.id DESC').all(req.user.id)
    .map(o => ({ ...o, paid: paidAmount(o.id), items: db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id = ?').all(o.id) }));
  res.render('orders', { title: 'Mis pedidos', orders });
});

r.get('/pedidos/:id', requireLogin, loadOrder, (req, res) => res.render('order', { title: `Pedido #${req.order.id}`, o: req.order }));

// Editar pedido pendiente (cambiar tallas / cantidades)
function loadProducts(eventId) {
  return db.prepare('SELECT * FROM products WHERE event_id = ? AND active = 1 ORDER BY id').all(eventId)
    .map(p => ({ ...p, sizeList: (p.sizes || '').split(',').map(s => s.trim()).filter(Boolean), sold: soldQty(p.id) }));
}
r.get('/pedidos/:id/editar', requireLogin, loadOrder, (req, res) => {
  const o = req.order;
  if (o.status !== 'pending' || o.payments.length) { req.flash('bad', 'Solo se pueden editar pedidos sin abonos.'); return res.redirect(`/pedidos/${o.id}`); }
  // Al editar, el stock disponible debe incluir lo que este pedido ya tiene reservado
  const products = loadProducts(o.event_id).map(p => {
    const own = o.items.filter(i => i.product_id === p.id).reduce((s, i) => s + i.qty, 0);
    return { ...p, sold: p.sold - own };
  });
  res.render('order_edit', { title: `Editar pedido #${o.id}`, o, products, members: household(req.user.id) });
});
r.post('/pedidos/:id/editar', requireLogin, loadOrder, (req, res) => {
  const o = req.order;
  if (o.status !== 'pending' || o.payments.length) { req.flash('bad', 'Solo se pueden editar pedidos sin abonos.'); return res.redirect(`/pedidos/${o.id}`); }
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(o.event_id);
  let items;
  try { items = parseItems(req.body, ev, o.id); } catch (e) { req.flash('bad', e.message); return res.redirect(`/pedidos/${o.id}/editar`); }
  const total = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  db.transaction(() => {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(o.id);
    const ins = db.prepare('INSERT INTO order_items (order_id, product_id, for_name, size, qty, unit_price) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of items) ins.run(o.id, it.product_id, it.for_name, it.size, it.qty, it.unit_price);
    db.prepare('UPDATE orders SET total = ? WHERE id = ?').run(total, o.id);
  })();
  req.flash('ok', `Pedido actualizado. Nuevo total: ${h.fmtCOP(total)}.`);
  res.redirect(`/pedidos/${o.id}`);
});

// Subir un abono (comprobante + monto). Puede ser el total o una parte.
r.post('/pedidos/:id/comprobante', requireLogin, loadOrder, upload.single('receipt'), csrfCheck, (req, res) => {
  const o = req.order;
  if (['paid', 'cancelled'].includes(o.status)) { req.flash('bad', 'Este pedido ya no acepta abonos.'); return res.redirect(`/pedidos/${o.id}`); }
  if (!req.file) { req.flash('bad', 'Adjunta la captura del comprobante.'); return res.redirect(`/pedidos/${o.id}`); }
  let amount = parseInt(String(req.body.amount || '').replace(/[^\d]/g, ''), 10) || 0;
  const maxAmt = o.total - o.paid - o.inReview;
  if (amount <= 0) { fs.unlink(req.file.path, () => {}); req.flash('bad', 'Indica el valor del abono.'); return res.redirect(`/pedidos/${o.id}`); }
  if (amount > maxAmt) amount = maxAmt;
  if (amount <= 0) { fs.unlink(req.file.path, () => {}); req.flash('bad', 'Ya tienes abonos en verificación por el total del pedido.'); return res.redirect(`/pedidos/${o.id}`); }
  db.prepare("INSERT INTO payments (order_id, amount, receipt, receipt_ref, status) VALUES (?, ?, ?, ?, 'review')")
    .run(o.id, amount, req.file.filename, String(req.body.receipt_ref || '').trim().slice(0, 60) || null);
  db.prepare('UPDATE orders SET receipt = ?, receipt_ref = ? WHERE id = ?').run(req.file.filename, String(req.body.receipt_ref || '').trim().slice(0, 60) || null, o.id);
  refreshOrderStatus(o.id);
  req.flash('ok', `Abono de ${h.fmtCOP(amount)} recibido. Un administrador lo confirmará pronto.`);
  res.redirect(`/pedidos/${o.id}`);
});

r.post('/pedidos/:id/cancelar', requireLogin, loadOrder, (req, res) => {
  const o = req.order;
  if (o.status !== 'pending' || o.payments.some(p => p.status !== 'rejected')) { req.flash('bad', 'Solo puedes cancelar pedidos sin abonos.'); return res.redirect(`/pedidos/${o.id}`); }
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
  req.flash('ok', 'Pedido cancelado.');
  res.redirect('/pedidos');
});

module.exports = r;
