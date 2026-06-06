# Crowd Canvas

An interactive crowd-drawing game for live events. The host uploads a black & white image; the
server slices it into tiles with a quadtree. Each guest gets a tile on their phone, draws it with a
thick brush, and submits — and the mosaic fills in live on the big screen. Built for and tested at
10,000+ simultaneous players.

## Stack

- **Runtime:** Node.js ≥ 20 (ESM)
- **Backend:** Express + `ws` (WebSockets) + `better-sqlite3` + `sharp` + `multer`
- **Frontend:** vanilla HTML/CSS/JS, three pages (player / admin / view), no framework

## Structure

```
server.js            all backend logic (HTTP + WebSocket + slicing + blending)
public/
  player.html        audience drawing screen
  admin.html         host control panel
  view.html          big-screen live mosaic
package.json
ecosystem.config.cjs pm2 process config (single instance — see below)
loadtest.js          load-test script (simulates phones)
data/                runtime data (git-ignored, auto-created)
  crowd.db           SQLite database
  original.png       last uploaded image (grayscale, preserved for re-slicing)
  base.png           squared/padded version used for tile extraction
  refs/              256×256 reference crop per active tile
  final-view.png     cached final mosaic
```

## Run locally

```bash
npm install
npm start            # node server.js, listens on 127.0.0.1:3000
```

Then open:

| Role             | URL                          |
|------------------|------------------------------|
| Player (audience)| `/`                          |
| Admin (host)     | `/dropveters-admin`          |
| View (big screen)| `/dropveters-view`           |

`PORT` and `HOST` are read from the environment (defaults `3000` / `127.0.0.1`).
When run via pm2 (`ecosystem.config.cjs`) the port is `3100`.

## How an event runs

1. Open the admin page, upload a high-contrast **black & white** image — bold shapes/line-art slice
   and draw far better than photos.
2. The server squares the image and quadtree-slices it into the requested number of tiles.
3. Guests scan the QR on the view screen, land on the player page, and are handed shuffled tiles.
4. Drawings blend into the mosaic live on the view screen.

### Key admin settings

- **Similarity threshold** — minimum shape-match score to accept a drawing (0 = off).
- **Min coverage** — fraction of the tile's ink a drawing must cover (blocks lazy tags).
- **Max stray ink** — ink allowed in large white areas (blocks hidden symbols).
- **Live pixel filter** — on the big screen, only show pixels drawn by ≥ N players. This consensus
  filter is the real defense against a lone griefer's tag; keep it at 1+.
- **Blend mode** — `blend` (gamma-curved average, default), `first`, or `random`.
- **Background / sidebar width** — big-screen appearance, tunable per projector.
- **Stop / Resume**, **Restart**, **Live delay**, **Hold/Blank**, **Auto-fill & finish** — run controls.

Validation (similarity, coverage, stray ink, blank) runs on the player's phone; the server stores
what it's sent. The live pixel filter and per-tile review/clear are the server-side moderation layer.

**Restart** wipes all submissions and reshuffles the deck without re-uploading the image.  
**Auto-fill & finish** gradually fills any undrawn tiles with their reference images over a
configurable duration (1–60 s) for a smooth animated reveal, then closes the game.

## Deploy

Single host, reverse-proxied by nginx (TLS) to the Node process on `127.0.0.1`.

```bash
scp -r server.js public package.json ecosystem.config.cjs deploy@VPS:/opt/crowd-canvas/
ssh deploy@VPS 'cd /opt/crowd-canvas && npm install --omit=dev && pm2 restart crowd-canvas --update-env'
```

> **Run exactly one process.** All game state (the tile deck, assignment pointer, and the connected
> player/view/admin sets) lives in memory in a single process. Do **not** use pm2 cluster mode or
> multiple workers — they would hand out duplicate tiles and desync the mosaic. Scale vertically.

For large events (10k–20k) you also need to raise the file-descriptor limit, tune nginx worker
connections and WebSocket timeouts, and pick a dedicated-CPU instance. See `DEPLOY.md` for the
full step-by-step runbook including sysctl tuning, TLS setup, and a load-test plan.

## Data

Everything in `data/` is generated at runtime and is git-ignored. The directory is created
automatically on first run; deleting it resets all sessions.

## Load testing

> See **`HANDOFF_JAN.md`** for the 2026-06-06 load-test results, root-cause analysis (a crash loop
> and a memory restart, both fixed), and the remaining client-side TODOs.

Three testers ship with the project:

- **`loadtest2.js`** (recommended) — full lifecycle per virtual player (page + ref fetch + WS +
  submit), separate ws/http/ref error buckets, handshake + first-tile latency, and `--start-at` for
  a synchronized multi-machine QR-reveal storm.
- **`loadtest-matrix.js`** — scripted smoke → storm → realistic sweep with a PASS/WARN/FAIL summary.
- **`loadtest.js`** — the original simple WS-only tester.

```bash
ulimit -n 100000                                   # on the test machine
node loadtest2.js wss://draw.mmsparty.nl/ws --clients 7000 --rate 500 --duration 300
```

> A single generator box caps near ~28k connections (ephemeral ports) and a home-NAT'd machine far
> earlier — both inflate the numbers and are not the server. For a true 20k test use 2–3 datacenter
> boxes fired together with `--start-at`.

First slice a **test** image on the admin (this fills the mosaic with junk — don't run it against
your live event), then watch `htop` and event-loop lag on the server. Key flags: `--clients`,
`--rate` (connections/sec — crank it to mimic the QR scan storm), `--tiles`, `--insecure` (staging
certs), `--duration`. One machine tops out near ~25–28k connections (ephemeral ports); for a full
20k+ run, split `--clients` across 2–3 machines.
