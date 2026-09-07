# Despliegue de zabalas.online en el VPS de Contabo

## 1. DNS en Hostinger

En hPanel → Dominios → zabalas.online → DNS / Nameservers, crea (o edita) estos registros:

| Tipo | Nombre | Valor            | TTL  |
|------|--------|------------------|------|
| A    | @      | IP-DEL-VPS       | 3600 |
| A    | www    | IP-DEL-VPS       | 3600 |

Borra cualquier registro A/CNAME de `@` o `www` que apunte a Hostinger. La propagación tarda de minutos a un par de horas (`dig +short zabalas.online` para comprobar).

## 2. Puertos en el VPS

Caddy necesita **80 y 443** libres en el servidor. Si el revisor IA ya usa un Nginx/Caddy/Traefik en esos puertos, ve a la sección "Si ya hay un proxy en el VPS".

```bash
sudo ufw allow 80,443/tcp   # si usas ufw
sudo ss -tlnp | grep -E ':80 |:443 '   # ¿hay algo escuchando?
```

## 3. Subir el proyecto

Desde tu Mac (carpeta `~/Documents/XCode/zabalas`):

```bash
rsync -av --exclude node_modules --exclude data --exclude .env --exclude test \
  ~/Documents/XCode/zabalas/ usuario@IP-DEL-VPS:/opt/zabalas/
```

## 4. Configurar y arrancar

```bash
ssh usuario@IP-DEL-VPS
cd /opt/zabalas
cp .env.example .env
nano .env       # SESSION_SECRET (openssl rand -hex 32), ADMIN_EMAIL/PASSWORD, FAMILY_CODE, NEQUI_NUMBER, NEQUI_HOLDER
docker compose up -d --build
docker compose logs -f app   # debe decir "Admin inicial creado" y "escuchando en ..."
```

Abre https://zabalas.online → Ingresar con el admin del `.env` → **Admin > Ajustes** para subir el QR de Nequi y ajustar el código familiar.

## 5. Actualizar

```bash
rsync ... (mismo comando del paso 3)
ssh usuario@IP-DEL-VPS "cd /opt/zabalas && docker compose up -d --build"
```

Los datos (base SQLite y comprobantes) viven en `/opt/zabalas/data/` y sobreviven a las actualizaciones.

## 6. Copias de seguridad

```bash
# en el VPS, p. ej. en un cron diario
tar czf /root/backups/zabalas-$(date +%F).tgz -C /opt/zabalas data
```

## Si ya hay un proxy en el VPS (Nginx/Caddy/Traefik del revisor IA)

No levantes el servicio `caddy` de este compose. En `docker-compose.yml`, en `app` cambia `expose` por:

```yaml
    ports:
      - "127.0.0.1:3010:3000"
```

y en tu proxy existente agrega un virtual host para `zabalas.online` que haga `proxy_pass http://127.0.0.1:3010` (Nginx) o `reverse_proxy 127.0.0.1:3010` (Caddy), con `client_max_body_size 10m` (Nginx). Luego `docker compose up -d --build app`.

Ejemplo Nginx:

```nginx
server {
    listen 80;
    server_name zabalas.online www.zabalas.online;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
# luego: certbot --nginx -d zabalas.online -d www.zabalas.online
```
