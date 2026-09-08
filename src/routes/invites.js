// Invitaciones por WhatsApp: el organizador/admin elige a quién invitar; el sistema arma el mensaje con enlace
// personal y lo abre en el WhatsApp del organizador (wa.me). El enlace /i/:token da acceso al evento.
const express = require('express');
const crypto = require('crypto');
const { db, waPhone, household, canManage } = require('../db');
const { requireLogin, requireManager } = require('../middleware');
const h = require('../helpers');

const pub = express.Router();   // rutas públicas (/i/:token)
const mgr = express.Router();   // rutas de gestión (montadas en /admin)
mgr.use(requireManager);

const DEFAULT_MSG = 'Hola {nombre} 👋 Te invito a *{evento}* ({fecha}{lugar}). Confirma tu asistencia aquí: {enlace}';

function buildMessage(ev, inv, base) {
  const tpl = ev.invite_message || DEFAULT_MSG;
  return tpl.replace(/{nombre}/g, inv.name.split(' ')[0]).replace(/{evento}/g, ev.title)
    .replace(/{fecha}/g, h.fmtDateTime(ev.starts_at)).replace(/{lugar}/g, ev.location ? ', ' + ev.location : '')
    .replace(/{enlace}/g, `${base}/i/${inv.token}`).replace(/{codigo}/g, ev.access_code || '');
}

function loadEvent(req, res, next) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).render('error', { title: 'No encontrado', message: 'Evento no encontrado.' });
  req.event = ev; next();
}

// ---- Gestión ----
mgr.get('/eventos/:id/invitaciones', loadEvent, (req, res) => {
  const ev = req.event;
  const base = `${req.protocol}://${req.get('host')}`;
  const invitations = db.prepare('SELECT i.*, u.name AS user_name FROM invitations i LEFT JOIN users u ON u.id = i.user_id WHERE i.event_id = ? ORDER BY i.id DESC').all(ev.id)
    .map(i => ({ ...i, wa: waPhone(i.phone), message: buildMessage(ev, i, base), link: `${base}/i/${i.token}`,
      rsvp: i.user_id ? db.prepare('SELECT status FROM rsvps WHERE event_id = ? AND user_id = ?').get(ev.id, i.user_id) : null }));
  const invitedUsers = new Set(invitations.map(i => i.user_id).filter(Boolean));
  const invitedMembers = new Set(invitations.map(i => i.member_id).filter(Boolean));
  const users = db.prepare('SELECT id, name, phone FROM users WHERE active = 1 AND id != ? ORDER BY name').all(req.user.id).filter(u => !invitedUsers.has(u.id));
  // Personas de los núcleos familiares (de todos) que no tienen cuenta propia
  const members = db.prepare(`SELECT m.id, m.name, m.note, u.name AS owner, u.phone AS owner_phone FROM household_members m JOIN users u ON u.id = m.user_id
    WHERE m.alias_of IS NULL AND m.linked_user_id IS NULL ORDER BY m.name`).all().filter(m => !invitedMembers.has(m.id));
  res.render('admin/invitations', { title: 'Invitaciones · ' + ev.title, ev, invitations, users, members, defaultMsg: DEFAULT_MSG, base,
    stats: { total: invitations.length, sent: invitations.filter(i => i.sent_at).length, accepted: invitations.filter(i => i.accepted_at).length } });
});

mgr.post('/eventos/:id/invitaciones', loadEvent, (req, res) => {
  const ev = req.event;
  const arr = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const ins = db.prepare('INSERT INTO invitations (event_id, name, phone, user_id, member_id, token, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const tok = () => crypto.randomBytes(9).toString('base64url');
  let n = 0;
  db.transaction(() => {
    for (const uid of arr(req.body.user_ids).map(Number)) {
      const u = db.prepare('SELECT id, name, phone FROM users WHERE id = ?').get(uid); if (!u) continue;
      if (db.prepare('SELECT 1 FROM invitations WHERE event_id = ? AND user_id = ?').get(ev.id, u.id)) continue;
      ins.run(ev.id, u.name, u.phone, u.id, null, tok(), req.user.id); n++;
    }
    for (const mid of arr(req.body.member_ids).map(Number)) {
      const m = db.prepare('SELECT m.id, m.name, u.phone FROM household_members m JOIN users u ON u.id = m.user_id WHERE m.id = ?').get(mid); if (!m) continue;
      if (db.prepare('SELECT 1 FROM invitations WHERE event_id = ? AND member_id = ?').get(ev.id, m.id)) continue;
      ins.run(ev.id, m.name, String(req.body['member_phone_' + mid] || '').trim() || null, null, m.id, tok(), req.user.id); n++;
    }
    const names = arr(req.body.new_name), phones = arr(req.body.new_phone);
    for (let i = 0; i < names.length; i++) {
      const nm = String(names[i] || '').trim().slice(0, 80); if (nm.length < 2) continue;
      ins.run(ev.id, nm, String(phones[i] || '').trim().slice(0, 30) || null, null, null, tok(), req.user.id); n++;
    }
  })();
  req.flash('ok', n ? `${n} invitación${n > 1 ? 'es' : ''} creada${n > 1 ? 's' : ''}. Ahora envíalas por WhatsApp.` : 'No se agregó ninguna invitación.');
  res.redirect(`/admin/eventos/${ev.id}/invitaciones`);
});

mgr.post('/eventos/:id/invitaciones/mensaje', loadEvent, (req, res) => {
  const msg = String(req.body.invite_message || '').trim().slice(0, 600) || null;
  db.prepare('UPDATE events SET invite_message = ? WHERE id = ?').run(msg, req.event.id);
  req.flash('ok', 'Mensaje de invitación guardado.');
  res.redirect(`/admin/eventos/${req.event.id}/invitaciones`);
});

function loadInvite(req, res, next) {
  const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(req.params.iid);
  if (!inv) return res.status(404).end();
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(inv.event_id);
  if (!canManage(ev, req.user)) return res.status(403).end();
  req.invite = inv; req.event = ev; next();
}
// Marcar como enviada (lo llama el botón de WhatsApp) — respuesta JSON
mgr.post('/invitaciones/:iid/enviado', loadInvite, (req, res) => {
  db.prepare("UPDATE invitations SET sent_at = COALESCE(sent_at, datetime('now','localtime')) WHERE id = ?").run(req.invite.id);
  res.json({ ok: true });
});
mgr.post('/invitaciones/:iid/telefono', loadInvite, (req, res) => {
  db.prepare('UPDATE invitations SET phone = ? WHERE id = ?').run(String(req.body.phone || '').trim().slice(0, 30) || null, req.invite.id);
  res.redirect(`/admin/eventos/${req.event.id}/invitaciones`);
});
mgr.post('/invitaciones/:iid/eliminar', loadInvite, (req, res) => {
  db.prepare('DELETE FROM invitations WHERE id = ?').run(req.invite.id);
  req.flash('ok', 'Invitación eliminada.');
  res.redirect(`/admin/eventos/${req.event.id}/invitaciones`);
});

// ---- Enlace personal del invitado ----
pub.get('/i/:token', (req, res) => {
  const inv = db.prepare("SELECT i.*, e.title, e.starts_at, e.location, e.description, e.image, e.access_code FROM invitations i JOIN events e ON e.id = i.event_id WHERE i.token = ? AND e.status = 'approved' AND e.published = 1").get(req.params.token);
  if (!inv) return res.status(404).render('error', { title: 'Invitación no válida', message: 'Este enlace de invitación no existe o el evento ya no está disponible.' });
  db.prepare("UPDATE invitations SET opened_at = COALESCE(opened_at, datetime('now','localtime')) WHERE id = ?").run(inv.id);
  if (req.user) {
    // Con sesión: acceso directo al evento
    db.prepare('INSERT OR IGNORE INTO event_access (event_id, user_id) VALUES (?, ?)').run(inv.event_id, req.user.id);
    db.prepare("UPDATE invitations SET user_id = COALESCE(user_id, ?), accepted_at = COALESCE(accepted_at, datetime('now','localtime')) WHERE id = ?").run(req.user.id, inv.id);
    if (inv.member_id) db.prepare('UPDATE household_members SET linked_user_id = ? WHERE id = ? AND linked_user_id IS NULL').run(req.user.id, inv.member_id);
    req.flash('ok', `¡Bienvenido/a! Confirma tu asistencia a "${inv.title}".`);
    return res.redirect(`/eventos/${inv.event_id}#asistencia`);
  }
  req.session.returnTo = `/i/${inv.token}`;
  res.render('invite', { title: 'Invitación', inv });
});

module.exports = { pub, mgr };
