# Crowd Canvas

Upload a black-and-white image, slice it into quadtree tiles, hand each tile to phones at
random, collect the finger-drawings, and watch the mosaic assemble live. Built to drop onto
an existing nginx box without touching your other sites.

```
server.js              the whole backend (slicer + assigner + websockets + sqlite + export)
package.json
public/player.html     what each phone sees (draw + submit)
public/admin.html      your host screen (upload, QR, live mosaic, export)
deploy/nginx-draw.conf the subdomain server block
deploy/crowd-canvas.service  the systemd unit
data/                  created at runtime: crowd.db + tile reference images
```

Two URLs once it's up: `https://draw.yourdomain.com/` for players, `https://draw.yourdomain.com/admin` for you.

---

## Deploy on your Hetzner VPS (nginx, subdomain)

### 1. Node.js (you weren't sure if it's installed)

```bash
node -v          # if this prints v20+ or v22+, skip to step 2
```

If it's missing or older than 20, install the current LTS via NodeSource (does not disturb anything else):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
# build tools, only needed if the native modules can't use prebuilt binaries:
sudo apt-get install -y build-essential python3
```

### 2. Put the app on the box and install deps

```bash
sudo mkdir -p /opt/crowd-canvas
sudo chown -R www-data:www-data /opt/crowd-canvas
# copy these files into /opt/crowd-canvas (scp, git, rsync — your choice), then:
cd /opt/crowd-canvas
sudo -u www-data npm install --omit=dev
```

`sharp` and `better-sqlite3` ship prebuilt binaries for linux x64, so this is usually quick.
Quick local test before wiring the proxy:

```bash
sudo -u www-data PORT=3000 node server.js     # should print "listening on 127.0.0.1:3000"; Ctrl-C to stop
```

### 3. Run it as a service

```bash
sudo cp deploy/crowd-canvas.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crowd-canvas
sudo systemctl status crowd-canvas             # confirm it's active
```

### 4. DNS

Add an A record (and AAAA if you use IPv6) for `draw.yourdomain.com` pointing at the VPS IP.

### 5. nginx subdomain

```bash
sudo cp deploy/nginx-draw.conf /etc/nginx/sites-available/draw.yourdomain.com
# edit the file: replace draw.yourdomain.com with your real subdomain
sudo ln -s /etc/nginx/sites-available/draw.yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 6. HTTPS

```bash
sudo certbot --nginx -d draw.yourdomain.com
```

certbot edits only this new vhost to add the 443 block and the http→https redirect. Done —
open `https://draw.yourdomain.com/admin`.

---

## How it works

- The upload is fitted into a 1024×1024 white square, so every quadtree cell is a square and
  each phone's square drawing drops straight back into place.
- The slicer repeatedly splits whichever cell is the most *mixed* black/white (i.e. has the most
  detail), until it reaches roughly your requested piece count. Blank areas stay as big lazy tiles.
- Each connecting phone is given the least-drawn tile, chosen at random among ties — so the same
  tile naturally lands on several players (your "players per piece" number is the target spread).
- Submissions stream to the admin over a WebSocket and paint into the live mosaic.
- Export composites the tiles back together, picking one submission per tile **at random**, and
  returns a PNG.

Only one session is live at a time — starting a new one clears the previous tiles and drawings.

## Notes

- `/admin` has no password. Before a public event, protect it with nginx basic auth on a
  `location /admin { ... }` block, or restrict by IP.
- Submissions and tile images live under `/opt/crowd-canvas/data` — back that up if you want to
  keep a finished piece beyond the next session.
- Memory and CPU are trivial for this workload; the smallest shared-vCPU Hetzner instance is fine.
