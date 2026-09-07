// Prueba end-to-end con Playwright (no forma parte del despliegue)
import { chromium } from 'playwright';
import fs from 'fs';
const BASE = 'http://localhost:3000';
const shots = 'test/shots'; fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
import Database from 'better-sqlite3';
const db_last_media = () => new Database('data/zabalas.db', { readonly: true }).prepare('SELECT MAX(id) AS id FROM media').get().id;
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
await m.click('label:has(input[value=yes]) span'); await m.fill('#guests', '2'); await m.click('#rsvpSubmit');
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

// --- Editar pedido pendiente: quitar la boleta, cambiar talla M -> L, cantidad 2
await m.goto(BASE + '/eventos/1');
ok((await m.textContent('body')).includes('pedido #1</b> sin pagar') || (await m.textContent('body')).includes('sin pagar'), 'evento avisa pedido sin pagar');
await m.click('a[href="/pedidos/1/editar"]');
ok(/\/pedidos\/1\/editar$/.test(m.url()), 'abre edición');
ok((await m.$$('.line-item')).length === 3, 'precarga 3 líneas');
const editSels = await m.$$('.product[data-product="1"] select'); await editSels[0].selectOption('L');
const editQty = await m.$$('.product[data-product="1"] [name=item_qty]'); await editQty[0].fill('2');
await m.click('.product[data-product="2"] .rm');
ok((await m.textContent('#orderTotal')).includes('135.000'), 'total editado 135.000');
await m.screenshot({ path: `${shots}/07b-movil-editar.png`, fullPage: true });
await m.click('#orderBtn');
ok(/\/pedidos\/1$/.test(m.url()) && (await m.textContent('body')).includes('135.000'), 'pedido actualizado a 135.000');
ok((await m.textContent('body')).includes('talla L'), 'talla cambiada a L');
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

// admin elimina un pedido pendiente (y no puede eliminar uno pagado)
await m.goto(BASE + '/eventos/1'); await m.click('.product[data-product="2"] .add-line'); await m.click('#orderBtn');
ok(/\/pedidos\/2$/.test(m.url()), 'segundo pedido pendiente creado');
await admin.goto(BASE + '/admin/pedidos?estado=pending');
ok((await admin.$$('form[action="/admin/pedidos/2/eliminar"]')).length === 1, 'admin ve botón eliminar en pendiente');
admin.once('dialog', d => d.accept());
await admin.click('form[action="/admin/pedidos/2/eliminar"] button');
ok((await admin.textContent('body')).includes('Pedido #2 eliminado'), 'pedido pendiente eliminado');
await admin.goto(BASE + '/admin/pedidos?estado=paid');
ok((await admin.$$('form[action="/admin/pedidos/1/eliminar"]')).length === 0, 'pagado no muestra eliminar');
const del = await admin.request.post(BASE + '/admin/pedidos/1/eliminar', { form: { _csrf: await admin.evaluate(() => document.querySelector('[name=_csrf]').value) } });
await admin.goto(BASE + '/admin/pedidos?estado=paid');
ok((await admin.textContent('body')).includes('#1'), 'pagado sigue existiendo tras intento de borrado');

// --- Evento privado con código ---
await admin.goto(BASE + '/admin/eventos/nuevo');
await admin.fill('[name=title]', 'Cumpleaños sorpresa de la abuela'); await admin.fill('[name=starts_at]', '2026-11-10T18:00');
await admin.check('#isPrivate'); await admin.fill('[name=access_code]', 'abuela80'); await admin.click('button.btn');
ok(/\/admin\/eventos\/2$/.test(admin.url()) && (await admin.textContent('body')).includes('ABUELA80'), 'evento privado creado con código');
await m.goto(BASE + '/');
ok(!(await m.textContent('body')).includes('Cumpleaños sorpresa'), 'integrante no ve el evento privado en la lista');
let rl = await m.goto(BASE + '/eventos/2'); ok(rl.status() === 403 && (await m.textContent('body')).includes('Evento privado'), 'acceso directo pide código');
await m.fill('#code', 'MALO'); await m.click('button.btn'); ok((await m.textContent('body')).includes('no es correcto'), 'código erróneo rechazado');
await m.fill('#code', 'abuela80'); await m.click('button.btn');
ok(/\/eventos\/2$/.test(m.url()) && (await m.textContent('body')).includes('Cumpleaños sorpresa'), 'código correcto da acceso');
await m.goto(BASE + '/'); ok((await m.textContent('body')).includes('Cumpleaños sorpresa'), 'ahora sí aparece en su lista');
await m.screenshot({ path: `${shots}/12-evento-privado.png` });

// --- Núcleo familiar y acompañantes ---
await m.goto(BASE + '/perfil');
await m.fill('form[action="/perfil/familia"] [name=name]', 'Tomás Zabala'); await m.fill('form[action="/perfil/familia"] [name=note]', 'hijo'); await m.click('form[action="/perfil/familia"] button');
await m.fill('form[action="/perfil/familia"] [name=name]', 'Sofía Zabala'); await m.click('form[action="/perfil/familia"] button');
ok((await m.$$('form[action^="/perfil/familia/"]')).length === 2, 'núcleo familiar con 2 personas');
await m.goto(BASE + '/eventos/1');
ok((await m.$$('input[name=member_ids]')).length === 2, 'asistencia muestra a Tomás y Sofía');
// agregar persona inline desde el evento
await m.click('label:has(input[value=yes]) span');
await m.click('#addPerson'); await m.fill('[name=new_name]', 'Abuela Rosa'); await m.fill('[name=new_note]', 'mamá');
await m.click('#rsvpSubmit');
ok((await m.textContent('body')).includes('Abuela Rosa'), 'persona agregada inline queda marcada');
ok((await m.$$('input[name=member_ids]')).length === 3, 'y quedó en el núcleo (3)');
// duplicado: otro titular (admin) agrega "tomas" sin tilde -> aviso y vinculación
await admin.goto(BASE + '/perfil');
const dupResp = await (await admin.request.get(BASE + '/perfil/familia/buscar?q=tomas%20zabala')).json();
ok(dupResp.members.length === 1 && dupResp.members[0].owner === 'Laura Zabala', 'búsqueda detecta duplicado sin tilde');
// nombre sin apellido se rechaza
await admin.fill('form[action="/perfil/familia"] [name=name]', 'Tomas'); await admin.click('form[action="/perfil/familia"] button');
ok((await admin.textContent('body')).includes('nombre y apellido'), 'exige nombre y apellido');
await admin.fill('form[action="/perfil/familia"] [name=name]', 'tomas zabala'); await admin.press('form[action="/perfil/familia"] [name=name]', 'Tab');
await admin.waitForSelector('.dup-warn:not([hidden])');
ok((await admin.textContent('.dup-warn')).includes('núcleo de Laura Zabala'), 'aviso de duplicado en pantalla');
await admin.click('.dup-warn label:has(input[value]:not([value=""])) span');
await admin.click('form[action="/perfil/familia"] button');
ok((await admin.textContent('body')).includes('vinculado con la misma persona'), 'vinculado como la misma persona');
await m.goto(BASE + '/eventos/1');
await m.click('label:has(input[value=yes]) span');
await m.uncheck('input[name=member_ids][value="2"]'); await m.uncheck('input[name=member_ids][value="3"]'); await m.check('input[name=member_ids][value="1"]'); await m.fill('#guests', '1'); await m.click('#rsvpSubmit');
let body = await m.textContent('body');
ok(body.includes('Laura Zabala + Tomás Zabala +1'), 'quiénes van muestra acompañante por nombre y extra');
// admin marca a Tomas en el evento 1 -> conteo único
await admin.goto(BASE + '/eventos/1'); await admin.click('label:has(input[value=yes]) span');
await admin.check('input[name=member_ids]'); await admin.click('#rsvpSubmit');
await admin.goto(BASE + '/admin/eventos/1');
ok((await admin.textContent('body')).includes('se cuentan una sola vez') && (await admin.textContent('body')).includes('Tomás'), 'admin avisa duplicado Tomás');
// limpiar: admin vuelve a "no" para no alterar el resto del test
await admin.goto(BASE + '/eventos/1'); await admin.click('label:has(input[value=no]) span'); await admin.click('#rsvpSubmit');
await m.screenshot({ path: `${shots}/16-acompanantes.png`, fullPage: true });
await admin.goto(BASE + '/admin/eventos/1');
ok((await admin.textContent('body')).includes('Tomás'), 'admin ve nombre del acompañante');
ok((await admin.textContent('#asistencia')).includes('2'), 'total acompañantes = 2');

// --- Evento con varias fechas ---
await admin.goto(BASE + '/admin/eventos/nuevo');
await admin.fill('[name=title]', 'Ensayos del coro navideño'); await admin.fill('[name=starts_at]', '2026-12-01T19:00'); await admin.fill('[name=location]', 'Casa de Tía Marta');
await admin.click('button.btn');
ok(/\/admin\/eventos\/3$/.test(admin.url()), 'evento coro creado');
for (const [label, when] of [['Ensayo 2', '2026-12-08T19:00'], ['Ensayo 3', '2026-12-15T19:00'], ['Presentación', '2026-12-20T18:00']]) {
  await admin.fill('#dfnew [name=label], [form=dfnew][name=label]', label); await admin.fill('[form=dfnew][name=starts_at]', when);
  if (label === 'Presentación') await admin.fill('[form=dfnew][name=location]', 'Iglesia');
  await admin.click('button[form=dfnew]');
}
ok((await admin.$$('form[action^="/admin/fechas/"][action$="/editar"]')).length === 4, 'evento con 4 fechas');
await admin.screenshot({ path: `${shots}/14-admin-fechas.png`, fullPage: true });
await m.goto(BASE + '/');
ok((await m.textContent('body')).includes('4 fechas'), 'tarjeta muestra 4 fechas');
await m.goto(BASE + '/eventos/3');
ok((await m.$$('input[name=date_ids]')).length === 4, 'recuadro con 4 casillas');
await m.click('label:has(input[value=yes]) span');
const boxes = await m.$$('input[name=date_ids]'); await boxes[1].uncheck(); await boxes[2].uncheck();
await m.screenshot({ path: `${shots}/15-movil-fechas.png`, fullPage: true });
await m.click('#rsvpSubmit');
ok((await m.textContent('body')).includes('Confirmaste 2 de 4 fechas'), 'asistencia a 2 de 4 fechas');
const icsMine = await (await m.request.get(BASE + '/eventos/3/calendario.ics?mias=1')).text();
ok((icsMine.match(/BEGIN:VEVENT/g) || []).length === 2, 'ics de mis fechas tiene 2 eventos');
const icsAll = await (await m.request.get(BASE + '/eventos/3/calendario.ics')).text();
ok((icsAll.match(/BEGIN:VEVENT/g) || []).length === 4 && icsAll.includes('Presentación'), 'ics completo tiene 4 eventos');
await admin.goto(BASE + '/admin/eventos/3');
ok((await admin.$$('td:has-text("✅")')).length === 2, 'admin ve 2 fechas marcadas');
const xls3 = await admin.request.get(BASE + '/admin/eventos/3/exportar.xlsx'); ok(xls3.status() === 200, 'excel con columnas por fecha');
// evento de una sola fecha sigue igual
await m.goto(BASE + '/eventos/1'); ok((await m.$$('input[name=date_ids]')).length === 0, 'evento de una fecha no muestra casillas');

// --- Galería ---
await m.goto(BASE + '/galeria/subir?evento=1');
await m.setInputFiles('#files', ['public/img/logo.jpeg', 'test/shots/01-login.png']);
await m.fill('#caption', 'Fotos de prueba'); await m.click('#upBtn');
ok(m.url().endsWith('/galeria') && (await m.$$('.gal-item')).length === 2, '2 fotos subidas y compartidas');
await m.goto(BASE + '/galeria/subir'); await m.setInputFiles('#files', ['public/img/logo.jpeg']);
await m.click('label:has(input[value=private]) span'); await m.click('#upBtn');
ok(m.url().endsWith('/galeria/mia') && (await m.$$('.gal-item')).length === 3, 'foto privada va a Mi galería');
await m.goto(BASE + '/galeria'); ok((await m.$$('.gal-item')).length === 2, 'privada no aparece en familia');
await admin.goto(BASE + '/galeria'); ok((await admin.$$('.gal-item')).length === 2, 'admin ve 2 compartidas');
const privId = db_last_media();
let pr = await admin.request.get(BASE + '/galeria/' + privId); ok(pr.status() === 404 || (await pr.text()).includes('Solo yo'), 'privada visible solo para dueño/admin');
await m.screenshot({ path: `${shots}/13-galeria.png` });
await m.goto(BASE + '/galeria/' + privId + '?de=mia');
ok((await m.textContent('body')).includes('Solo yo'), 'detalle muestra privada');
await m.click('details summary'); await m.click('label:has(input[value=family]) span'); await m.click('details form button.btn');
ok((await m.textContent('body')).includes('Familia'), 'cambiada a familia');
await m.goto(BASE + '/galeria'); ok((await m.$$('.gal-item')).length === 3, 'ahora hay 3 compartidas');
const th = await m.request.get(BASE + '/uploads/galeria/' + (await m.getAttribute('.gal-item img', 'src')).split('/').pop());
ok(th.status() === 200 && th.headers()['content-type'].includes('image'), 'miniatura servida');

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
