# Despliegue de zabalas.online en el VPS de Contabo

El VPS ya tiene un **Nginx del sistema** en los puertos 80/443 que reparte el tráfico por dominio entre varios proyectos. zabalas.online entra por ahí con su propio bloque, pero la app corre **aislada**: contenedor `zabalas-app`, red Docker `zabalas-net`, base de datos SQLite y comprobantes en `/home/deploy/zabalas/data`. No comparte base de datos, tablas ni procesos con ningún otro proyecto.

## 1. DNS en Hostinger

hPanel → Dominios → zabalas.online → DNS:

| Tipo | Nombre | Valor          |
|------|--------|----------------|
| A    | @      | 89.117.60.52   |
| A    | www    | 89.117.60.52   |

Elimina cualquier A/CNAME previo de `@` y `www`. Comprobar: `dig +short zabalas.online`.

## 2. Clonar y configurar (en el VPS)

```bash
cd /home/deploy
git clone https://github.com/MADMAX201/zabalas.git
cd zabalas
cp .env.example .env
nano .env   # SESSION_SECRET (openssl rand -hex 32), ADMIN_*, FAMILY_CODE, NEQUI_*
```

## 3. Arrancar el contenedor

```bash
docker compose up -d --build
docker compose logs --tail=20 app     # "Admin inicial creado" + "escuchando en ..."
curl -sI http://127.0.0.1:3010/login | head -1   # HTTP/1.1 200 OK
```

## 4. Bloque de Nginx + HTTPS

```bash
sudo cp deploy/nginx-zabalas.online.conf /etc/nginx/sites-available/zabalas.online
sudo ln -s /etc/nginx/sites-available/zabalas.online /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d zabalas.online -d www.zabalas.online
```

(Si `certbot` no está instalado: `sudo apt install certbot python3-certbot-nginx`.)

Abre https://zabalas.online → ingresa con el admin del `.env` → Admin > Ajustes (QR de Nequi, código familiar).

## 5. Actualizar

```bash
cd /home/deploy/zabalas && git pull && docker compose up -d --build
```

Los datos en `data/` sobreviven a las actualizaciones.

## 6. Copias de seguridad

```bash
mkdir -p /home/deploy/backups
tar czf /home/deploy/backups/zabalas-$(date +%F).tgz -C /home/deploy/zabalas data
```

Sugerencia de cron diario: `0 3 * * * tar czf /home/deploy/backups/zabalas-$(date +\%F).tgz -C /home/deploy/zabalas data`
