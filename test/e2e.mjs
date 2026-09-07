// Prueba end-to-end con Playwright (no forma parte del despliegue)
import { chromium } from 'playwright';
import fs from 'fs';
const BASE = 'http://localhost:3000';
const shots = 'test/shots'; fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ok = (c, m) => { if (!c) throw new Error('FALLÓ: ' + m); console.log('✔', m); };

// --- Admin ---
const admin = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await admin.goto(BASE + '/login');
await admin.screenshot({ path: `${shots}/01-login.png` });
await admin.fill('#email', 'admin@test.com'); await admin.fill('#password', 'admin123'); await admin.click('button.btn');
ok(admin.url() === BASE + '/', 'login admin');
await admin.screenshot({ path: `${shots}/02-home-vacio.png` });

await admin.goto(BASE + '/admin/eventos/nuevo');
await admin.fill('[name=title]', 'Reunión familiar de fin de año');
await admin.fill('[name=description]', 'Nos vemos en la finca. Habrá sancocho y música.\nLleva ropa cómoda.');
await admin.fill('[name=starts_at]', '2026-12-19T11:00'); await admin.fill('[name=ends_at]', '2026-12-19T20:00');
await admin.fill('[name=location]', 'Finca La Esperanza'); await admin.fill('[name=address]', 'Km 5 vía Melgar');
await admin.click('button.btn');
ok(/\/admin\/eventos\/1$/.test(admin.url()), 'evento creado');

await admin.goto(BASE + '/admin/eventos/1/productos/nuevo');
await admin.fill('[name=name]', 'Camiseta oficial 2026'); await admin.fill('[name=price]', '45000');
await admin.fill('[name=sizes]', 'Niño 6, Niño 10, S, M, L, XL'); await admin.fill('[name=stock]', '50');
await admin.click('button.btn');
await admin.goto(BASE + '/admin/eventos/1/productos/nuevo');
await admin.fill('[name=name]', 'Boleta almuerzo'); await admin.fill('[name=price]', '25000'); await admin.fill('[name=sizes]', '');
await admin.click('button.btn');
ok((await admin.textContent('body')).includes('Boleta almuerzo'), 'productos creados');
await admin.screenshot({ path: `${shots}/03-admin-evento.png`, fullPage: true });

// --- Integrante ---
const m = await browser.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 });
await m.goto(BASE + '/registro');
await m.fill('#name', 'Laura Zabala'); await m.fill('#email', 'laura@test.com'); await m.fill('#phone', '3001234567');
await m.fill('#password', 'laura123'); await m.fill('#password2', 'laura123'); await m.fill('#code', 'zabala2026');
await m.click('button.btn');
ok(m.url() === BASE + '/', 'registro integrante');
await m.screenshot({ path: `${shots}/04-movil-home.png` });
await m.goto(BASE + '/eventos/1');
await m.screenshot({ path: `${shots}/05-movil-evento.png`, fullPage: true });
await m.click('label:has(input[value=yes]) span'); await m.fill('#guests', '2'); await m.click('#rsvpForm button.btn');
ok((await m.textContent('body')).includes('Asistencia confirmada'), 'rsvp guardado');
const ics = await m.request.get(BASE + '/eventos/1/calendario.ics'); ok((await ics.text()).includes('BEGIN:VEVENT'), 'ics generado');

// pedido: 2 camisetas + 1 boleta
await m.click('.product[data-product="1"] .add-line'); await m.selectOption('.product[data-product="1"] select', 'M');
await m.click('.product[data-product="1"] .add-line');
const sels = await m.$$('.product[data-product="1"] select'); await sels[1].selectOption('Niño 6');
const fors = await m.$$('.product[data-product="1"] [name=item_for]'); await fors[1].fill('Tomás');
await m.click('.product[data-product="2"] .add-line');
ok((await m.textContent('#orderTotal')).includes('115.000'), 'total calculado 115.000');
await m.screenshot({ path: `${shots}/06-movil-pedido.png`, fullPage: true });
await m.click('#orderBtn');
ok(/\/pedidos\/1$/.test(m.url()), 'pedido creado');
ok((await m.textContent('body')).includes('300 123 4567'), 'muestra número Nequi');
await m.screenshot({ path: `${shots}/07-movil-pago.png`, fullPage: true });
await m.setInputFiles('#receipt', 'public/img/logo.jpeg'); await m.fill('#ref', 'M98765');
await m.click('form[enctype] button.btn');
ok((await m.textContent('body')).includes('Comprobante recibido'), 'comprobante subido');
await m.screenshot({ path: `${shots}/08-movil-verificacion.png`, fullPage: true });

// --- Admin confirma pago ---
await admin.goto(BASE + '/admin');
ok((await admin.textContent('body')).includes('Pagos por verificar'), 'dashboard muestra por verificar');
await admin.screenshot({ path: `${shots}/09-admin-dashboard.png`, fullPage: true });
await admin.goto(BASE + '/admin/pedidos?estado=review');
await admin.click('button[value=paid]');
ok((await admin.textContent('body')).includes('Pagado'), 'pago confirmado');
await admin.screenshot({ path: `${shots}/10-admin-pedidos.png`, fullPage: true });
await m.reload(); ok((await m.textContent('body')).includes('Pago confirmado'), 'integrante ve pago confirmado');

// excel
const x = await admin.request.get(BASE + '/admin/eventos/1/exportar.xlsx');
ok(x.headers()['content-type'].includes('spreadsheetml'), 'excel exportado');
fs.writeFileSync('test/export.xlsx', await x.body());

// seguridad: integrante no entra a admin
const r = await m.goto(BASE + '/admin'); ok(r.status() === 403, 'integrante bloqueado en /admin');
// código erróneo
const p2 = await browser.newPage(); await p2.goto(BASE + '/registro');
await p2.fill('#name', 'Intruso'); await p2.fill('#email', 'x@test.com'); await p2.fill('#password', '123456'); await p2.fill('#password2', '123456'); await p2.fill('#code', 'MALO');
await p2.click('button.btn'); ok((await p2.textContent('body')).includes('código familiar no es correcto'), 'código familiar inválido rechazado');

await browser.close(); console.log('\nTODO OK');
