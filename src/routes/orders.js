const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('../db');
const { requireLogin, upload, csrfCheck } = require('../middleware');
const h = require('../helpers');
const { soldQty } = require('./events');

const r = express.Router();

// Crear pedido: recibe items[<productId>][size][qty]... desde el formulario del evento
r.post('/eventos/:id/pedido', requireLogin, (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND published = 1').get(req.params.id);
  if (!ev) return res.status(404).render('error', { title: 'No encontrado', message: 'Evento no encontrado.' });

  // El formulario envía filas: item_product[], item_size[], item_qty[], item_for[]
  const toArr = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const pids = toArr(req.body.item_product), sizes = toArr(req.body.item_size), qtys = toArr(req.body.item_qty), fors = toArr(req.body.item_for);

  const items = [];
  for (let i = 0; i < pids.length; i++) {
    const qty = parseInt(qtys[i], 10) || 0;
    if (qty <= 0) continue;
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND event_id = ? AND active = 1').get(pids[i], ev.id);
    if (!p) continue;
    if (p.order_deadline && h.isPast(p.order_deadline)) { req.flash('bad', `Ya cerró el plazo para pedir "${p.name}".`); return res.redirect(`/eventos/${ev.id}#tienda`); }
    const sizeList = (p.sizes || '').split(',').map(s => s.trim()).filter(Boolean);
    const size = sizeList.length ? String(sizes[i] || '').trim() : null;
    if (sizeList.length && !sizeList.includes(size)) { req.flash('bad', `Selecciona una talla válida para "${p.name}".`); return res.redirect(`/eventos/${ev.id}#tienda`); }
    if (p.stock !== null && soldQty(p.id) + qty > p.stock) { req.flash('bad', `No hay suficientes unidades de "${p.name}" (quedan ${Math.max(0, p.stock - soldQty(p.id))}).`); return res.redirect(`/eventos/${ev.id}#tienda`); }
    items.push({ product_id: p.id, size, qty: Math.min(qty, 50), unit_price: p.price, for_name: String(fors[i] || '').trim().slice(0, 80) || null });
  }
  if (!items.length) { req.flash('bad', 'Agrega al menos un producto con cantidad.'); return res.redirect(`/eventos/${ev.id}#tienda`); }

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
  const o = db.prepare('SELECT o.*, e.title AS event_title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = ?').get(req.params.id);
  if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).render('error', { title: 'No encontrado', message: 'Pedido no encontrado.' });
  o.items = db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id = ?').all(o.id);
  req.order = o; next();
}

r.get('/pedidos', requireLogin, (req, res) => {
  const orders = db.prepare('SELECT o.*, e.title AS event_title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = ? ORDER BY o.id DESC').all(req.user.id)
    .map(o => ({ ...o, items: db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id = ?').all(o.id) }));
  res.render('orders', { title: 'Mis pedidos', orders });
});

r.get('/pedidos/:id', requireLogin, loadOrder, (req, res) => res.render('order', { title: `Pedido #${req.order.id}`, o: req.order }));

// Subir comprobante
r.post('/pedidos/:id/comprobante', requireLogin, loadOrder, upload.single('receipt'), csrfCheck, (req, res) => {
  const o = req.order;
  if (!['pending', 'rejected'].includes(o.status)) { req.flash('bad', 'Este pedido ya no acepta comprobantes.'); return res.redirect(`/pedidos/${o.id}`); }
  if (!req.file) { req.flash('bad', 'Adjunta la captura del comprobante.'); return res.redirect(`/pedidos/${o.id}`); }
  if (o.receipt) { try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', o.receipt)); } catch {} }
  db.prepare("UPDATE orders SET receipt = ?, receipt_ref = ?, status = 'review', admin_note = NULL WHERE id = ?")
    .run(req.file.filename, String(req.body.receipt_ref || '').trim().slice(0, 60) || null, o.id);
  req.flash('ok', 'Comprobante recibido. Un administrador confirmará tu pago pronto.');
  res.redirect(`/pedidos/${o.id}`);
});

r.post('/pedidos/:id/cancelar', requireLogin, loadOrder, (req, res) => {
  const o = req.order;
  if (o.status !== 'pending') { req.flash('bad', 'Solo puedes cancelar pedidos pendientes de pago.'); return res.redirect(`/pedidos/${o.id}`); }
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
  req.flash('ok', 'Pedido cancelado.');
  res.redirect('/pedidos');
});

module.exports = r;
