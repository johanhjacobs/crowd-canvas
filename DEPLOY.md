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
nano /etc/nginx/sites-available/crowd-canvas
```

Paste this (replace `YOUR_DOMAIN` throughout):

```nginx
limit_req_zone $binary_remote_addr zone=player:10m rate=50r/s;

upstream app {
    server 127.0.0.1:3100;
    keepalive 512;
}

server {
    listen 80;
    server_name YOUR_DOMAIN;
    return 301 https://$host$request_uri;
}

server {
    # backlog=65535: raise the accept queue from nginx's default 511 so a connection
    # storm (the QR reveal) doesn't overflow it. An overflow drops SYNs → TCP retransmits
    # with exponential backoff → ~20s "Connecting" for unlucky clients. Needs
    # net.core.somaxconn + tcp_max_syn_backlog raised too (see step 3) AND a full
    # `systemctl restart nginx` to take effect (reload reuses the old listen socket).
    listen 443 ssl http2 backlog=65535;
    server_name YOUR_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    gzip on;
    gzip_types text/html application/json text/css application/javascript;
    gzip_min_length 1024;

    # Serve the player page straight from disk — it never touches Node, so a
    # browser reload is instant even when the app is saturated under load.
    # (player.html has no admin token, unlike admin/view, so it's safe to serve
    # statically.) The short cache means a reload within 60s is a pure browser-
    # cache hit with zero server round-trip.
    location = / {
        root /opt/crowd-canvas/public;
        try_files /player.html =404;
        add_header Cache-Control "public, max-age=60";
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

    # Suffix-regex so the obfuscation slug (OBFUSCATION_SLUG in .env) can change
    # without editing nginx — any /<slug>-admin still gets Basic auth.
    location ~ -admin$ {
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

```bash
# Edit nginx.conf to raise worker connections
nano /etc/nginx/nginx.conf
# Set these two lines:
#   worker_processes auto;
#   worker_connections 4096;   <- inside the events {} block

ln -s /etc/nginx/sites-available/crowd-canvas /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

> **Keep `sites-enabled/crowd-canvas` a symlink, not a copy.** If it's a plain
> file, edits to `sites-available/` won't take effect (we hit exactly this — the
> enabled copy was stale and kept proxying `/` to Node). Verify with
> `ls -l /etc/nginx/sites-enabled/` (you want `crowd-canvas -> ../sites-available/crowd-canvas`).
> Note: changing a file into a symlink needs `systemctl restart nginx` — a plain
> `reload` may not pick it up. Confirm the static page is live with:
> `curl -sI https://YOUR_DOMAIN/ | grep -i cache` → should show `public, max-age=60`, **not** `no-store`.

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

## 8. Set the admin token (in `.env`, never in git)

The **admin** HTTP endpoints and the admin WebSocket are gated by a secret token. The token is
read from an **untracked `.env` file** — *not* from `ecosystem.config.cjs`, which is tracked by git
(a token committed there leaks to anyone with repo access). See `.env.example` for the template.

> **The view and player pages are public.** The big-screen view is read-only and carries **no**
> token (it never embeds it, so the public URL can't leak admin access). Only `/dropveters-admin`
> and the admin `/api/*` calls require the token — and `/dropveters-admin` is *also* behind nginx
> Basic auth (§7), so it's two factors.

Generate a token and write it to `/opt/crowd-canvas/.env` on the server:

```bash
openssl rand -hex 32
# then, on the server:
echo "ADMIN_TOKEN=PASTE_THE_GENERATED_TOKEN" > /opt/crowd-canvas/.env
chmod 600 /opt/crowd-canvas/.env
```

`ecosystem.config.cjs` reads `.env` at pm2 start and injects `ADMIN_TOKEN` into the process.
Confirm it loaded after starting/restarting:

```bash
pm2 env 0 | grep ADMIN_TOKEN     # must print your token, NOT empty
```

> **Keep this value secret and out of git.** `.env` is gitignored.  
> Empty/missing token ⇒ the admin API is **open to everyone** (the app logs a warning).  
> Rotate it: edit `.env` → `pm2 restart ecosystem.config.cjs --update-env` → `pm2 save`.

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
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # copy-paste the command it prints
```

Check it's running:
```bash
pm2 list
pm2 logs crowd-canvas --lines 20
```

---

## 10. Verify everything works

```bash
# Should return HTML — and Cache-Control: public, max-age=60 (served by nginx, NOT no-store from Node)
curl -I https://YOUR_DOMAIN/

# Accept queue must be 65535 (Send-Q column), not 511 — confirms backlog= took effect after restart
ss -lnt 'sport = :443'

# Should return JSON
curl https://YOUR_DOMAIN/api/config

# Open in browser and confirm the player page loads
# https://YOUR_DOMAIN/
```

---

## 11. Load test (Day 4 of the 5-day plan)

> **Read `HANDOFF_JAN.md` first** — it has the results and root-cause analysis from the 2026-06-06
> campaign. Key takeaways: the server is solid (7,000 clients, 0 errors, submit latency ~11 ms);
> nginx/TLS is **not** the bottleneck (~15 % CPU under load); and the connect-latency numbers from
> our small generators were largely a *generator* artifact, not the server.
>
> **Use real datacenter generators.** A single box caps near ~28k connections (ephemeral ports) and
> a home-NAT'd laptop dies far earlier (router connection table) — both inflate the handshake/error
> numbers and are not the server. For a true 20k test, use **2–3 Hetzner CX boxes** and fire them
> together with `loadtest2.js --start-at`.
>
> **`loadtest2.js`** is the preferred tester (full lifecycle: page + ref fetch + WS + submit, with
> separate ws/http/ref error buckets and handshake + first-tile latency). `loadtest-matrix.js` is the
> scripted smoke→storm→realistic sweep.

You need two cheap extra servers as load generators.  
On Hetzner: add two **CX22** instances (€0.01/hr each). Delete them after testing.

On each CX22:
```bash
apt-get install -y nodejs npm
ulimit -n 100000
# copy the tester to this machine
scp deploy@YOUR_SERVER_IP:/opt/crowd-canvas/loadtest2.js .
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
- [ ] `pm2 restart crowd-canvas` — fresh process (clears accumulated test submissions from RAM)
- [ ] Confirm `pm2 describe crowd-canvas` shows `max memory restart` = 16 G and `restarts` near 0
- [ ] Open admin panel, upload the event image, slice it (≈6000 pieces for ~5k playable tiles — see `HANDOFF_JAN.md` §4)
- [ ] Check the tile overlay looks right
- [ ] Open view screen on the projector laptop — and **don't reload it mid-event** (10–30 s rebuild)
- [ ] Confirm QR code shows and scans to the right URL
- [ ] Do one manual draw on your phone end-to-end
- [ ] **Plan a staggered reveal** (release the QR in waves, not all 20k at once) — biggest lever for the opening storm

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

---

## Re-deploy after code changes

`/opt/crowd-canvas` is a git checkout tracking `origin/main`. Deploy via git — **not** ad-hoc rsync
or manual edits (hand edits on the server once drifted from the repo and shipped a crash-looping
build; see `HANDOFF_JAN.md` §1a).

```bash
# develop → commit → push from your laptop, then on the server:
ssh deploy@YOUR_SERVER_IP 'cd /opt/crowd-canvas && git pull && npm install --omit=dev && pm2 restart crowd-canvas --update-env'
```

> Use `--update-env` so pm2 re-reads `ecosystem.config.cjs` (and the `.env` it loads — including a
> rotated `ADMIN_TOKEN`). If you changed `max_memory_restart`, a plain restart won't pick it up — do
> `pm2 delete crowd-canvas && pm2 start ecosystem.config.cjs && pm2 save`.

> **A restart is mandatory after any HTML change.** `admin.html` and `view.html` are read into memory
> **once at startup** (`buildHtml`/`fs.readFileSync` in `server.js`) — copying a new file without a
> `pm2 restart` changes nothing. And if you ever deploy by hand instead of `git pull`, **HTML files
> belong in `public/`**: `scp public/view.html deploy@host:/opt/crowd-canvas/` drops it in the *root*
> and the app keeps serving the old `public/view.html`. Fastest check that your HTML actually shipped:
> `curl -s https://YOUR_DOMAIN/dropveters-view | grep -o 'dropveters-seed.png'` (should print the name).
