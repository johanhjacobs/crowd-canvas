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
ecosystem.config.cjs pm2 process config (single instance — reads ADMIN_TOKEN from .env)
.env.example         template for the untracked .env (holds ADMIN_TOKEN)
loadtest2.js         recommended load tester (full lifecycle per virtual player)
loadtest-matrix.jan.js / loadtest.jan.js   Jan's staged runner + breakpoint discovery
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

The `dropveters` segment of the admin/view paths is the **obfuscation slug** — set
`OBFUSCATION_SLUG` in `.env` to change it (default `dropveters`; see *Security model*).

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

### Security model

- **Admin** (`/dropveters-admin`, all mutating `/api/*`, admin WebSocket) requires a secret
  `ADMIN_TOKEN`, read from an untracked **`.env`** file (never `ecosystem.config.cjs`, which is in
  git — see `.env.example`). In production the admin page is *also* behind nginx Basic auth.
- **View** (`/dropveters-view`, big screen) and **player** (`/`) are **public**. The view is
  read-only and embeds **no** token, so the public big-screen URL can't leak admin access.
- **Export PNGs** (`/api/export.png`, `-thumb`) are built **only at game end** — they can't be
  triggered (and CPU-hammered) during play.
- The **obfuscation slug** in the admin/view/seed paths (`/<slug>-admin`, `/<slug>-view`,
  `/api/<slug>-seed.png`) is read from **`OBFUSCATION_SLUG`** in `.env` (default `dropveters`), so
  the real slug isn't pinned in source. The server injects the seed URL into the trusted pages at
  startup. Changing the slug needs only `.env` + a restart — nginx matches the admin page with a
  slug-independent `location ~ -admin$` regex, so it needs no edit. This is security-by-obscurity —
  only the admin token + nginx Basic auth are real access control.

**Restart** wipes all submissions and reshuffles the deck without re-uploading the image.  
**Auto-fill & finish** gradually fills any undrawn tiles with their reference images over a
configurable duration (1–60 s) for a smooth animated reveal, then closes the game.

## Deploy

Single host, reverse-proxied by nginx (TLS) to the Node process on `127.0.0.1`.
`/opt/crowd-canvas` is a git checkout tracking `origin/main` — **deploy by pulling**, not ad-hoc scp
(manual file copies drift from the repo and the HTML must land in `public/`):

```bash
# commit + push from your laptop, then on the server:
ssh deploy@VPS 'cd /opt/crowd-canvas && git pull --ff-only origin main && npm install --omit=dev && pm2 restart ecosystem.config.cjs --update-env'
```

> Secrets live in an untracked **`.env`** on the server (`ADMIN_TOKEN`, `OBFUSCATION_SLUG`) — see
> `.env.example`. A restart is mandatory after any change (the HTML pages are baked into memory at
> startup). See `DEPLOY.md` for the first-time setup.

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

Testers that ship with the project:

- **`loadtest2.js`** (recommended) — full lifecycle per virtual player (page + ref fetch + WS +
  submit), `--mode full|ws|storm|http`, separate ws/http/ref error buckets, handshake + first-tile
  latency, and `--start-at` for a synchronized multi-machine QR-reveal storm.
- **`loadtest-matrix.jan.js`** — Jan's staged runner: `--profile matrix|smoke|event|breakpoint`,
  where **`breakpoint`** automatically discovers the capacity break-point. Spawns `loadtest.jan.js`
  per stage; run from the repo root.
- **`loadtest.jan.js`** / **`loadtest.js`** — single-stage WS+submit workers.

```bash
ulimit -n 100000                                   # on the test machine
node loadtest2.js wss://asml.mmsparty.nl/ws --mode storm --clients 7000 --rate 500 --duration 300
```

> See **`HANDOFF_JAN_2026-06-07.md`** for the latest results: the 16-core/32 GB server holds 6 k
> drawing players at ~20 % CPU with **2 ms** submit latency — one 4 GB generator box, not the
> server, is the limiter.

> A single generator box caps near ~28k connections (ephemeral ports) and a home-NAT'd machine far
> earlier — both inflate the numbers and are not the server. For a true 20k test use 2–3 datacenter
> boxes fired together with `--start-at`.

First slice a **test** image on the admin (this fills the mosaic with junk — don't run it against
your live event), then watch `htop` and event-loop lag on the server. Key flags: `--clients`,
`--rate` (connections/sec — crank it to mimic the QR scan storm), `--tiles`, `--insecure` (staging
certs), `--duration`. One machine tops out near ~25–28k connections (ephemeral ports); for a full
20k+ run, split `--clients` across 2–3 machines.
