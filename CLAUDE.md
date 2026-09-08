# zabalas.online — Sitio familiar Zabala Suárez

Sitio privado para que los integrantes de la familia se registren, vean eventos, confirmen asistencia, agenden en su calendario y compren productos del evento (camisetas con talla, boletas, etc.) pagando por transferencia a Nequi con comprobante.

## Contexto y decisiones (2026-09-07)

- **Dominio:** zabalas.online, registrado en **Hostinger** (solo DNS). El hosting **no** es Hostinger.
- **Servidor:** VPS en **Contabo** (el mismo que se usa para el proyecto "revisor IA"). Despliegue con Docker Compose; entra por el Nginx del sistema (bloque propio) con certbot. Proyecto aislado: contenedor `zabalas-app`, red `zabalas-net`, datos en `/home/deploy/zabalas/data`.
- **Pagos:** Nequi no tiene API para bolsillos personales → flujo elegido: el sitio muestra número/QR de Nequi, el familiar transfiere, sube la captura y un admin confirma. Sin comisiones. Queda abierta la puerta a Wompi/PayU más adelante (estado `paid` se marcaría automático).
- **Acceso:** registro libre con **código familiar** secreto (Admin > Ajustes). El primer usuario registrado o el `ADMIN_EMAIL` del `.env` es admin.
- **Admin completo:** eventos, productos (tallas, precio, stock, fecha límite), asistencias, confirmación de pagos, usuarios, ajustes, exportar Excel por evento.
- **Eventos privados:** `events.access_code` (NULL = para toda la familia). Un evento privado no aparece en la lista; al abrirlo pide el código (`event_locked.ejs`) y, si es correcto, se registra en `event_access` y desde ahí lo ve normal. En el inicio hay un buscador "¿Te invitaron a un evento privado?". Admin lo activa en el formulario del evento (código manual o autogenerado, 6 chars sin 0/O/1/I) y lo ve en la página admin del evento con la lista de admitidos.
- **Galería:** tabla `media` (kind image|video, visibility family|private, event_id opcional). Subida múltiple (hasta 10, 200 MB c/u) con `uploadMedia`; las fotos se normalizan con **sharp** (rotación EXIF, máx. 2000px, JPEG) y se genera miniatura 480px; los videos se guardan tal cual. Archivos en `data/uploads/galeria/`, servidos por `routes/gallery.js` (los privados solo al dueño/admin; el static de `/uploads` salta esa carpeta). `/galeria` = familia (filtro por evento), `/galeria/mia` = propios, `/galeria/:id` detalle con anterior/siguiente, editar (descripción, evento, privacidad) y eliminar (dueño o admin). Nginx: `client_max_body_size 210m`.
- **Fechas múltiples:** tabla `event_dates` (label, starts_at, ends_at, location, address) y `date_rsvps` (date_id, user_id). Todo evento tiene ≥1 fecha; `events.starts_at/ends_at` = rango min/max (`syncEventRange`). El formulario del evento edita la primera fecha; las demás se gestionan en la página admin del evento (sección "Fechas del evento"). Con >1 fecha el integrante ve un recuadro con casillas y "Sí, voy" exige al menos una; el .ics acepta `?fecha=ID` o `?mias=1` (varios VEVENT). Admin: asistencia con columna por fecha; Excel igual + fila TOTAL.
- **Núcleo familiar / acompañantes:** cada integrante gestiona en `/perfil#familia` su lista (`household_members`: nombre y apellido obligatorios (`isFullName`), parentesco, `norm` = nombre normalizado sin tildes, `alias_of` = misma persona en otro núcleo). Al confirmar "Sí, voy" el recuadro "¿Quién va contigo?" aparece siempre: casillas de su núcleo + "Agregar persona" inline (se guarda en el núcleo y queda marcada) + "otros acompañantes sin nombre" (`rsvps.extra_guests`); `rsvps.guests` = marcados + extras. **Duplicados:** al escribir un nombre se consulta `/perfil/familia/buscar?q=` (JSON: coincidencias en núcleos de otros titulares y cuentas registradas) y se pregunta "¿Es la misma persona?"; si sí, se crea con `alias_of`. `uniqueCompanions(eventId)` cuenta una vez a la misma persona aunque la marquen dos titulares y lista los duplicados (aviso en admin). Nombres visibles en "Quiénes van", admin y Excel; datalist en "Para quién" de la tienda.
- **Organizar un evento (integrantes):** botón "🎪 Organizar un evento" en el inicio → `/eventos/organizar` (título, fechas, lugar, portada, toda la familia o solo invitados, y si vende algo: recaudo propio Nequi o llave **Bre-B** + titular + QR). Se crea con `organizer_id`, `status='pending'`; solo lo ven el organizador y los admins. Admin ve "Eventos por aprobar" en el dashboard y en la página del evento aprueba (publica; si es privado el código ya existe y lo ve el organizador) o rechaza con motivo. `/mis-eventos` lista los del organizador con estado, asistentes, pagos por verificar y recaudado. **Panel de organizador** = mismas rutas `/admin/eventos/:id...` protegidas por `requireManager` (admin o `organizer_id` del evento; también productos, fechas y pedidos de ese evento). El organizador no accede a `/admin`, pedidos globales, integrantes ni ajustes; en evento aprobado no cambia publicado/privado ni lo elimina. `paymentFor(ev)`: si el evento tiene `pay_number` se usa (organizador confirma sus comprobantes); si no, el Nequi general del sitio. Los eventos del admin también pueden tener recaudo propio (formulario admin).
- **Abonos parciales:** tabla `payments` (order_id, amount, receipt, receipt_ref, status review|confirmed|rejected, method transfer|cash|other, note). El estado del pedido se deriva (`refreshOrderStatus`): paid si confirmado ≥ total, review si hay abono en verificación, partial si hay algo confirmado, pending si nada. El integrante ve barra de avance, historial y formulario "Abonar" (valor hasta el saldo no verificado). Admin/organizador confirma o rechaza cada abono (puede ajustar el valor según el comprobante), registra **abonos manuales** (efectivo/transferencia/otro, con nota) o "saldo completo", cancela/reabre. Editar o cancelar el pedido solo sin abonos; eliminar solo sin abonos confirmados. Excel: columnas Total/Abonado/Saldo y hoja "Saldos" por persona. Migración: los comprobantes antiguos pasan a un abono por el total.
- **Invitaciones por WhatsApp:** tabla `invitations` (event_id, name, phone, user_id | member_id, token único, sent/opened/accepted). En `/admin/eventos/:id/invitaciones` el organizador/admin elige integrantes con cuenta, personas de cualquier núcleo familiar sin cuenta (con celular) u otras personas; cada una recibe un enlace personal `/i/:token`. El botón "Enviar por WhatsApp" abre `wa.me/57…` con el mensaje (plantilla editable por evento: {nombre} {evento} {fecha} {lugar} {enlace} {codigo}) y marca `sent_at`. Sin API de Meta (decisión: enviar desde el WhatsApp del organizador, sin costo). `/i/:token`: con sesión da acceso al evento (event_access) y marca aceptada; sin sesión muestra landing con "Crear mi cuenta" (registro sin código familiar, nombre precargado) o "Ingresar".
- **Registro independiente de miembros de un núcleo:** `household_members.linked_user_id` se llena al registrarse alguien con el mismo nombre normalizado (`linkUserToHousehold`) o vía invitación con `member_id`. Si esa persona confirma por su cuenta, `uniqueCompanions` no la cuenta como acompañante aunque su titular la marque (aviso en admin) y la casilla muestra "tiene cuenta propia".
- **Logo:** `logo.jpeg` (Zabala Suárez, negro sobre blanco) → `public/img/logo.jpeg`.

## Stack

Node 22 · Express 5 · EJS · SQLite (better-sqlite3, WAL) · sharp (miniaturas) · express-session (store en SQLite) · bcryptjs · multer (uploads) · exceljs. Sin framework frontend: CSS propio en `public/css/style.css` y JS vanilla en `public/js/app.js`. Zona horaria fija `America/Bogota`.

## Estructura

```
src/server.js        arranque, sesiones, CSRF, rutas, errores
src/db.js            esquema SQLite + ajustes por defecto + admin inicial
src/helpers.js       formato de fechas/COP, .ics, Google Calendar, etiquetas de estado
src/middleware.js    requireLogin, requireAdmin, requireManager (admin u organizador del evento), upload/uploadMedia, csrfCheck
src/routes/auth.js   login, registro (código familiar), logout, perfil
src/routes/events.js inicio, detalle de evento, asistencia (RSVP), calendario.ics
src/routes/orders.js crear/editar pedido (parseItems), ver pedidos, subir comprobante, cancelar
src/routes/gallery.js galería familiar / mía, subida (sharp), detalle, editar, eliminar, servir archivos con privacidad
src/routes/invites.js invitaciones (gestión en /admin/eventos/:id/invitaciones, enlace público /i/:token)
src/routes/admin.js  dashboard, CRUD eventos/productos, pagos, usuarios, ajustes, exportar.xlsx
src/views/           plantillas EJS (partials/ incl. store_form reutilizable, admin/, order_edit)
public/              css, js, img (logo)
data/                zabalas.db + uploads/ (persistente, NO se versiona)
test/e2e.mjs         prueba end-to-end con Playwright (flujo completo)
Dockerfile, docker-compose.yml, deploy/nginx-zabalas.online.conf, .env.example
```

## Modelo de datos

`users` (role member|admin, active) · `settings` (family_code, site_name, nequi_number, nequi_holder, nequi_qr, payment_instructions) · `events` (+ organizer_id, status pending|approved|rejected, reject_reason, pay_method nequi|breb, pay_number, pay_holder, pay_qr) · `event_dates` · `rsvps` (yes|no|maybe, guests, extra_guests) · `date_rsvps` · `household_members` · `rsvp_companions` · `products` (sizes "S,M,L", stock NULL=∞, order_deadline) · `orders` (status pending|partial|review|paid|cancelled) · `payments` (abonos) · `invitations` · `order_items` (size, qty, for_name, unit_price).

## Flujo de pago

1. Integrante arma pedido (talla, cantidad, para quién) → `orders.status = pending`.
2. Mientras esté `pending` puede **editar** el pedido (`/pedidos/:id/editar`: tallas, cantidades, quitar líneas; el stock descuenta lo del propio pedido) o cancelarlo. El evento muestra un aviso con "Pagar ahora" / "Cambiar tallas".
3. Ve número/QR (Nequi o Bre-B del evento), transfiere total o parcial, sube captura con el valor → abono `review`; pedido queda `review`.
4. Admin/organizador confirma o rechaza cada abono; con abonos confirmados < total el pedido queda `partial` y el integrante sigue abonando; al completar → `paid`. Abonos en efectivo se registran a mano.

## Correr en local

```bash
cp .env.example .env   # editar
npm install
npm run dev            # http://localhost:3000
node test/e2e.mjs      # prueba e2e (requiere playwright y servidor corriendo)
```

## Despliegue (Contabo)

Ver `DEPLOY.md`. Resumen: DNS A en Hostinger → 89.117.60.52; `git clone` en /home/deploy/zabalas; `docker compose up -d --build` (127.0.0.1:3010); bloque Nginx + certbot.

## Seguridad

- Contraseñas con bcrypt; sesiones httpOnly/sameSite; cookie `secure` en producción (detrás de Nginx con `trust proxy`).
- CSRF por token de sesión en todos los POST (en multipart se valida después de multer).
- Límite de 10 intentos de login por IP cada 15 min.
- Uploads solo imagen/PDF, máx. 8 MB; nombres aleatorios.
- Integrantes no pueden ver pedidos ajenos ni `/admin`.

## Pendientes / ideas

- Recuperar contraseña por correo (hoy: admin genera clave temporal en Integrantes).
- Notificaciones (correo o WhatsApp) al confirmar pago o al crear evento.
- Pasarela Wompi para confirmar pagos automáticamente.
- Videos: miniatura/poster (hoy se usa el primer frame vía `preload=metadata`).
- Limitar espacio en disco por integrante en la galería.

## Registro de trabajo

- 2026-09-07: v1.0 creada y probada end-to-end (registro, evento, RSVP, ics, pedido con tallas, comprobante Nequi, confirmación admin, Excel). Capturas en `test/shots/`.
- 2026-09-07: repo GitHub MADMAX201/zabalas creado (push desde el Mac). Despliegue cambiado de Caddy a Nginx del sistema + puerto local 3010 (opción A acordada con Mario).
- 2026-09-07: v1.1 — edición de pedidos pendientes (retomar pago con cambios), aviso de pedido sin pagar dentro del evento, formulario de tienda extraído a partial. Desplegado en https://zabalas.online (Nginx + certbot OK).
- 2026-09-07: v1.2 — admin puede eliminar pedidos sin pago (pendientes/rechazados/cancelados); los pagados y en verificación no se borran. El integrante solo cancela, nunca elimina.
- 2026-09-07: v1.3 — eventos privados con código de invitación; Galería de fotos/videos con privacidad (familia / solo yo), miniaturas con sharp, filtro por evento. Requiere actualizar el bloque de Nginx (client_max_body_size 210m).
- 2026-09-07: v1.4 — eventos con varias fechas (ensayos, campeonatos): casillas por fecha, conteo y nombres por fecha, calendario por fecha/mis fechas/todas, admin gestiona fechas y ve asistencia por fecha, Excel con columnas por fecha. Migración automática: los eventos existentes reciben su fecha original.
- 2026-09-07: v1.5 — núcleo familiar (nombre y apellido) en el perfil y en el propio formulario de asistencia (agregar inline); selección por nombre de quiénes van; detección de duplicados entre titulares con vinculación y conteo único; nombres visibles para todos, admin y Excel; sugerencia de nombres en 'Para quién'.
- 2026-09-07: v1.6 — 'Organizar un evento' para integrantes con aprobación del admin, recaudo propio (Nequi/Bre-B) por evento y panel de organizador (fechas, productos, asistencia, confirmar pagos, Excel). Decisión de Mario: el organizador crea sus productos y confirma sus pagos; el admin aprueba siempre y supervisa.
- 2026-09-08: v1.7 — abonos parciales con avance y abono manual (efectivo), invitaciones por WhatsApp (wa.me, enlace personal), registro independiente de personas de un núcleo vía invitación con conteo único. 88 comprobaciones e2e.
