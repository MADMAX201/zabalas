const express = require('express');
const bcrypt = require('bcryptjs');
const { db, settings } = require('../db');
const { requireLogin } = require('../middleware');

const r = express.Router();

// Límite básico de intentos de login por IP
const attempts = new Map();
function tooMany(ip) {
  const a = attempts.get(ip); if (!a) return false;
  if (Date.now() - a.first > 15 * 60 * 1000) { attempts.delete(ip); return false; }
  return a.count >= 10;
}
function bump(ip) {
  const a = attempts.get(ip) || { first: Date.now(), count: 0 };
  a.count++; attempts.set(ip, a);
}

r.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Ingresar', error: null, email: '' });
});

r.post('/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).render('login', { title: 'Ingresar', error: 'Demasiados intentos. Espera 15 minutos.', email: req.body.email });
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    bump(ip);
    return res.status(401).render('login', { title: 'Ingresar', error: 'Correo o contraseña incorrectos.', email });
  }
  if (!u.active) return res.status(403).render('login', { title: 'Ingresar', error: 'Tu cuenta está desactivada. Habla con un administrador.', email });
  attempts.delete(ip);
  req.session.regenerate(() => {
    req.session.userId = u.id;
    const to = req.session.returnTo || '/'; delete req.session.returnTo;
    res.redirect(to);
  });
});

r.get('/registro', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Crear cuenta', error: null, form: {} });
});

r.post('/registro', (req, res) => {
  const form = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    phone: String(req.body.phone || '').trim(),
    code: String(req.body.code || '').trim(),
  };
  const pw = String(req.body.password || '');
  const fail = (error) => res.status(400).render('register', { title: 'Crear cuenta', error, form });

  if (form.name.length < 2) return fail('Escribe tu nombre completo.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) return fail('Correo inválido.');
  if (pw.length < 6) return fail('La contraseña debe tener al menos 6 caracteres.');
  if (pw !== String(req.body.password2 || '')) return fail('Las contraseñas no coinciden.');
  if (form.code.toUpperCase() !== String(settings.get('family_code') || '').toUpperCase()) return fail('El código familiar no es correcto. Pídeselo a quien te invitó.');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(form.email)) return fail('Ya existe una cuenta con ese correo. Intenta ingresar.');

  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const info = db.prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(form.name, form.email, form.phone || null, bcrypt.hashSync(pw, 10), isFirst ? 'admin' : 'member');
  req.session.regenerate(() => {
    req.session.userId = info.lastInsertRowid;
    req.flash('ok', `¡Bienvenido/a, ${form.name.split(' ')[0]}!`);
    res.redirect('/');
  });
});

r.post('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// Perfil
r.get('/perfil', requireLogin, (req, res) => res.render('profile', { title: 'Mi perfil', error: null }));
r.post('/perfil', requireLogin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (name.length < 2) return res.status(400).render('profile', { title: 'Mi perfil', error: 'Escribe tu nombre.' });
  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone || null, req.user.id);
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).render('profile', { title: 'Mi perfil', error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(req.body.password), 10), req.user.id);
  }
  req.flash('ok', 'Perfil actualizado.');
  res.redirect('/perfil');
});

module.exports = r;
