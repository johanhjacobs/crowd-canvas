# Crowd Canvas — Server Setup Runbook

## 1. Rent the server

Go to **hetzner.com → Cloud → Add Server**

| Setting | Value |
|---|---|
| Location | pick closest to your venue |
| OS | Ubuntu 22.04 LTS |
| Type | **CCX43** (16 vCPU, 64 GB) — recommended |
| | CCX53 (32 vCPU, 128 GB) if you want extra headroom |
| SSH key | add your laptop's public key |
| Name | crowd-canvas |

No setup fee. Billed by the hour (~€0.15/hr for CCX43).  
**Rent 5 days before the event. Delete it the day after.**

---

## 2. First login

```bash
ssh root@YOUR_SERVER_IP
```

Create a deploy user:
```bash
adduser deploy
usermod -aG sudo deploy
```

Lock down SSH:
```bash
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd
```

Copy your SSH key to the deploy user (run this on your **laptop**):
```bash
ssh-copy-id deploy@YOUR_SERVER_IP
```

Firewall:
```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

---

## 3. System limits ← do not skip this

Without this the server crashes at ~1000 connections.

```bash
cat >> /etc/sysctl.conf << 'EOF'
net.core.somaxconn           = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog  = 65535
net.ipv4.tcp_tw_reuse        = 1
net.core.rmem_max            = 16777216
net.core.wmem_max            = 16777216
EOF
sysctl -p
```

```bash
cat >> /etc/security/limits.conf << 'EOF'
deploy soft nofile 100000
deploy hard nofile 100000
root   soft nofile 100000
root   hard nofile 100000
EOF
```

```bash
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/fd-limit.conf << 'EOF'
[Manager]
DefaultLimitNOFILE=100000
EOF
systemctl daemon-reexec
```

---

## 4. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
apt-get install -y nodejs
node --version   # should print v22.x.x
```

---

## 5. Install nginx

```bash
apt-get install -y nginx
systemctl enable nginx
```

Create the config file:
```bash
vi /etc/nginx/sites-available/crowd-canvas
```

Paste this (replace `YOUR_DOMAIN` throughout):

```nginx
limit_req_zone $binary_remote_addr zone=player:10m rate=50r/s;

upstream app {
    server 127.0.0.1:3000;
    keepalive 512;
}

server {
    listen 80;
    server_name YOUR_DOMAIN;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name YOUR_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    gzip on;
    gzip_types text/html application/json text/css application/javascript;
    gzip_min_length 1024;

    location = / {
        limit_req zone=player burst=200 nodelay;
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    location /refs/ {
        alias /opt/crowd-canvas/data/refs/;
        expires 1h;
        add_header Cache-Control "public, immutable";
    }

    location /ws {
        limit_req zone=player burst=500 nodelay;
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_read_timeout  7200;
        proxy_send_timeout  7200;
    }

    location /dropveters-admin {
        # Optional defense-in-depth for the admin page itself.
        # The app still requires ADMIN_TOKEN for admin APIs and the admin websocket.
        auth_basic "Admin";
        auth_basic_user_file /etc/nginx/.htpasswd-canvas;
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    location / {
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host      $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 30M;
    }
}
```

Reverse-proxy these app paths:

- public player page: `/`
- public view page: `/dropveters-view`
- optional admin page shell: `/dropveters-admin`
- public player/view websocket: `/ws`
- public static refs: `/refs/`
- public live/final images: `/api/seed.png`, `/api/live-tile/*`, `/api/final-view.png`, `/api/final-view-thumb.png`
- admin/control APIs: `/api/session*`, `/api/config`, `/api/state`, `/api/view/*`, `/api/export.png`, `/api/overlay.png`, `/api/tile/*`, `/api/submission/*`

`ADMIN_TOKEN` protects the admin/control APIs and admin websocket in the app itself. nginx Basic Auth is optional defense-in-depth, not the primary control.

```bash
# Edit nginx.conf to raise worker connections
vi /etc/nginx/nginx.conf
# Set these two lines:
#   worker_processes auto;
#   worker_connections 4096;   <- inside the events {} block

ln -s /etc/nginx/sites-available/crowd-canvas /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

---

## 6. TLS certificate

Point your domain's DNS A record to the server IP first, then:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d YOUR_DOMAIN
```

Auto-renewal is set up automatically.

---

## 7. Admin password

```bash
apt-get install -y apache2-utils
htpasswd -c /etc/nginx/.htpasswd-canvas admin
# type a strong password
nginx -s reload
```

Write the password down. You'll need it on event day.

---

## 8. Set ADMIN_TOKEN before public exposure

`ADMIN_TOKEN` is required for any public deployment. When `NODE_ENV=production`, the app now refuses to start without it.

Generate a long random token:

```bash
openssl rand -hex 32
```

If you are running the app under **systemd**, put the token in `/etc/crowd-canvas.env`:

```bash
cat >/etc/crowd-canvas.env <<'EOF'
ADMIN_TOKEN=PASTE_A_LONG_RANDOM_TOKEN_HERE
RENDER_WORKERS=4
RENDER_WORKERS_MAX=6
EOF
chmod 600 /etc/crowd-canvas.env
```

`RENDER_WORKERS` pins the requested worker count. `RENDER_WORKERS_MAX` is the safety cap for both
automatic sizing and explicit overrides. The app also enforces an internal absolute cap of `32`
workers, even if a higher value is configured. Recommended production start:

```bash
RENDER_WORKERS=4
RENDER_WORKERS_MAX=6
```

Then reload and restart:

```bash
systemctl daemon-reload
systemctl restart crowd-canvas
```

If you are running under **pm2**, export it before starting or restarting:

```bash
export ADMIN_TOKEN=PASTE_A_LONG_RANDOM_TOKEN_HERE
export NODE_ENV=production
export RENDER_WORKERS=4
export RENDER_WORKERS_MAX=6
pm2 restart crowd-canvas --update-env
```

Do not paste the token into screenshots, shared terminal recordings, or anything that logs full request URLs.
Never send `ADMIN_TOKEN` in a query string. Use `Authorization: Bearer ...` for HTTP and the admin page's WebSocket subprotocol flow for the admin socket.

---

## 9. Deploy the app

```bash
# On the server
mkdir -p /opt/crowd-canvas
chown deploy:deploy /opt/crowd-canvas
npm install -g pm2
```

```bash
# On your laptop — upload the files
rsync -av --exclude node_modules --exclude data \
  /Users/jacobs/Downloads/crowd-canvas-main/ \
  deploy@YOUR_SERVER_IP:/opt/crowd-canvas/
```

```bash
# Back on the server
cd /opt/crowd-canvas
npm install --omit=dev
export NODE_ENV=production
export ADMIN_TOKEN=PASTE_A_LONG_RANDOM_TOKEN_HERE
export RENDER_WORKERS=4
export RENDER_WORKERS_MAX=6
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # copy-paste the command it prints
```

Check it's running:
```bash
pm2 list
pm2 logs crowd-canvas --lines 20
```

At startup the app logs the render-worker sizing decision, including detected CPU count, selected
workers, whether an env override was used, and the effective max cap.

---

## 10. Verify everything works

```bash
# Should return HTML
curl -I https://YOUR_DOMAIN/

# Should reject without the admin bearer token
curl -i https://YOUR_DOMAIN/api/config

# Should return JSON with the token
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://YOUR_DOMAIN/api/config

# Open in browser and confirm the player page loads
# https://YOUR_DOMAIN/
```

---

## 11. Load test (Day 4 of the 5-day plan)

You need two cheap extra servers as load generators.  
On Hetzner: add two **CX22** instances (€0.01/hr each). Delete them after testing.

On each CX22:
```bash
apt-get install -y nodejs npm
ulimit -n 100000
# copy loadtest.js to this machine
scp deploy@YOUR_SERVER_IP:/opt/crowd-canvas/loadtest.js .
npm install ws sharp
```

**Test 1 — connection storm** (run on both machines at the same time):
```bash
node loadtest.js wss://YOUR_DOMAIN/ws \
  --clients 10000 --rate 500 \
  --draw-min 300 --draw-max 400 \
  --duration 30
```
✅ Pass: 20000 live connections, errors near 0.

**Test 2 — full realistic event** (run on both machines at the same time):
```bash
node loadtest.js wss://YOUR_DOMAIN/ws \
  --clients 10000 --rate 300 \
  --draw-min 20 --draw-max 40
```
✅ Pass: latency avg under 500ms, p95 under 2s, no errors in `pm2 logs`.

**Test 3 — crash recovery** (while Test 2 is running):
```bash
pm2 restart crowd-canvas
```
✅ Pass: clients reconnect within 5 seconds, mosaic re-seeds correctly.

**Watch on the server during any test:**
```bash
# Terminal 1
pm2 logs crowd-canvas

# Terminal 2
watch -n 2 'echo "FD: $(ls /proc/$(pgrep -f node)/fd | wc -l)" && free -h | head -2'

# Terminal 3
watch -n 2 'ss -s | grep estab'
```

---

## 12. Event day checklist

**2 hours before doors open:**
- [ ] `pm2 restart crowd-canvas` — fresh process
- [ ] `echo "$ADMIN_TOKEN"` is not printed anywhere public, recorded, or screenshared
- [ ] Open admin panel, upload the event image, slice it
- [ ] Check the tile overlay looks right
- [ ] Open view screen on the projector laptop
- [ ] Confirm QR code shows and scans to the right URL
- [ ] Do one manual draw on your phone end-to-end

**30 minutes before:**
- [ ] `pm2 logs crowd-canvas` — confirm no errors
- [ ] Have the admin panel open on your laptop
- [ ] Have a second tab open with `pm2 logs` or SSH ready

**During the event:**
- [ ] Watch `pm2 logs` for anything unexpected
- [ ] Admin panel shows live player count and completion %
- [ ] If anything looks wrong: Stop → auto-fill → done

**After:**
- [ ] Download the final PNG from the admin panel
- [ ] `pm2 logs crowd-canvas > event-log.txt` — save the logs
- [ ] Delete the Hetzner servers

---

## URLs (fill in before the event)

| What | URL |
|---|---|
| Player (audience) | `https://YOUR_DOMAIN/` |
| Admin (you) | `https://YOUR_DOMAIN/dropveters-admin` |
| View (projector) | `https://YOUR_DOMAIN/dropveters-view` |
| Admin password | `admin` / ______________ |
| ADMIN_TOKEN | __store out-of-band, never in screenshots__ |

---

## Re-deploy after code changes

```bash
rsync -av --exclude node_modules --exclude data \
  /Users/jacobs/Downloads/crowd-canvas-main/ \
  deploy@YOUR_SERVER_IP:/opt/crowd-canvas/

ssh deploy@YOUR_SERVER_IP 'export NODE_ENV=production ADMIN_TOKEN=PASTE_A_LONG_RANDOM_TOKEN_HERE && cd /opt/crowd-canvas && npm install --omit=dev && pm2 restart crowd-canvas --update-env'
```
