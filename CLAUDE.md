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
- **Logo:** `logo.jpeg` (Zabala Suárez, negro sobre blanco) → `public/img/logo.jpeg`.

## Stack

Node 22 · Express 5 · EJS · SQLite (better-sqlite3, WAL) · sharp (miniaturas) · express-session (store en SQLite) · bcryptjs · multer (uploads) · exceljs. Sin framework frontend: CSS propio en `public/css/style.css` y JS vanilla en `public/js/app.js`. Zona horaria fija `America/Bogota`.

## Estructura

```
src/server.js        arranque, sesiones, CSRF, rutas, errores
src/db.js            esquema SQLite + ajustes por defecto + admin inicial
src/helpers.js       formato de fechas/COP, .ics, Google Calendar, etiquetas de estado
src/middleware.js    requireLogin, requireAdmin, upload (multer), csrfCheck
src/routes/auth.js   login, registro (código familiar), logout, perfil
src/routes/events.js inicio, detalle de evento, asistencia (RSVP), calendario.ics
src/routes/orders.js crear/editar pedido (parseItems), ver pedidos, subir comprobante, cancelar
src/routes/gallery.js galería familiar / mía, subida (sharp), detalle, editar, eliminar, servir archivos con privacidad
src/routes/admin.js  dashboard, CRUD eventos/productos, pagos, usuarios, ajustes, exportar.xlsx
src/views/           plantillas EJS (partials/ incl. store_form reutilizable, admin/, order_edit)
public/              css, js, img (logo)
data/                zabalas.db + uploads/ (persistente, NO se versiona)
test/e2e.mjs         prueba end-to-end con Playwright (flujo completo)
Dockerfile, docker-compose.yml, deploy/nginx-zabalas.online.conf, .env.example
```

## Modelo de datos

`users` (role member|admin, active) · `settings` (family_code, site_name, nequi_number, nequi_holder, nequi_qr, payment_instructions) · `events` · `rsvps` (yes|no|maybe, guests) · `products` (sizes "S,M,L", stock NULL=∞, order_deadline) · `orders` (status pending→review→paid|rejected, cancelled; receipt, receipt_ref) · `order_items` (size, qty, for_name, unit_price).

## Flujo de pago

1. Integrante arma pedido (talla, cantidad, para quién) → `orders.status = pending`.
2. Mientras esté `pending` puede **editar** el pedido (`/pedidos/:id/editar`: tallas, cantidades, quitar líneas; el stock descuenta lo del propio pedido) o cancelarlo. El evento muestra un aviso con "Pagar ahora" / "Cambiar tallas".
3. Ve número/QR Nequi, transfiere, sube captura → `review`.
4. Admin en `/admin/pedidos?estado=review` confirma (`paid`) o rechaza (`rejected`, con nota; el integrante puede volver a subir comprobante).

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
