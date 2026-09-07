// Utilidades compartidas (formato, fechas, calendario)
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const DIAS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

function parseLocal(iso) {
  // "2026-12-24T19:00" -> Date (interpretado como hora local del servidor, TZ=America/Bogota)
  if (!iso) return null;
  const [d, t = '00:00'] = iso.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return new Date(y, m - 1, day, hh, mm);
}

function fmtDate(iso) {
  const dt = parseLocal(iso); if (!dt) return '';
  return `${DIAS[dt.getDay()]} ${dt.getDate()} de ${MESES[dt.getMonth()]} de ${dt.getFullYear()}`;
}
function fmtTime(iso) {
  const dt = parseLocal(iso); if (!dt) return '';
  let h = dt.getHours(); const m = String(dt.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'p. m.' : 'a. m.'; h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}
function fmtDateTime(iso) { return iso ? `${fmtDate(iso)}, ${fmtTime(iso)}` : ''; }
function fmtShort(iso) {
  const dt = parseLocal(iso); if (!dt) return '';
  return `${dt.getDate()} ${MESES[dt.getMonth()].slice(0,3)} ${dt.getFullYear()}`;
}
function fmtCOP(n) { return '$' + Number(n || 0).toLocaleString('es-CO'); }
function isPast(iso) { const dt = parseLocal(iso); return dt ? dt < new Date() : false; }
function nowLocalISO() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Fecha en formato ICS (UTC)
function icsUTC(iso) {
  const dt = parseLocal(iso); if (!dt) return '';
  return dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }

function buildICS(ev, siteName, url) {
  const start = icsUTC(ev.starts_at);
  const end = icsUTC(ev.ends_at) || icsUTC(addHours(ev.starts_at, 3));
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${icsEscape(siteName)}//ES`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${ev.id}@zabalas.online`,
    `DTSTAMP:${icsUTC(nowLocalISO())}`,
    `DTSTART:${start}`, `DTEND:${end}`,
    `SUMMARY:${icsEscape(ev.title)}`,
    `DESCRIPTION:${icsEscape((ev.description || '') + (url ? '\n' + url : ''))}`,
    `LOCATION:${icsEscape([ev.location, ev.address].filter(Boolean).join(', '))}`,
    url ? `URL:${url}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}
function addHours(iso, h) {
  const dt = parseLocal(iso); if (!dt) return null;
  dt.setHours(dt.getHours() + h);
  const p = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
function googleCalUrl(ev, url) {
  const start = icsUTC(ev.starts_at);
  const end = icsUTC(ev.ends_at) || icsUTC(addHours(ev.starts_at, 3));
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: ev.title, dates: `${start}/${end}`,
    details: (ev.description || '') + (url ? '\n' + url : ''),
    location: [ev.location, ev.address].filter(Boolean).join(', '),
  });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}

const ORDER_STATUS = {
  pending: { label: 'Pendiente de pago', cls: 'warn' },
  review: { label: 'En verificación', cls: 'info' },
  paid: { label: 'Pagado', cls: 'ok' },
  rejected: { label: 'Rechazado', cls: 'bad' },
  cancelled: { label: 'Cancelado', cls: 'muted' },
};
const RSVP = {
  yes: { label: 'Asistiré', cls: 'ok' },
  maybe: { label: 'Tal vez', cls: 'warn' },
  no: { label: 'No asistiré', cls: 'muted' },
};

module.exports = { fmtDate, fmtTime, fmtDateTime, fmtShort, fmtCOP, isPast, nowLocalISO, buildICS, googleCalUrl, ORDER_STATUS, RSVP, parseLocal };
