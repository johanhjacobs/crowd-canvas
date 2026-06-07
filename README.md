# Crowd Canvas

An interactive crowd-drawing game for live events. The host uploads a black & white image; the
server slices it into tiles with a quadtree. Each guest gets a tile on their phone, draws it with a
thick brush, and submits — and the mosaic fills in live on the big screen. Built for and tested at
10,000+ simultaneous players.

## Docs

- [docs/README.md](docs/README.md) - documentation index
- [docs/ops/DEPLOY.md](docs/ops/DEPLOY.md) - production deployment runbook
- [docs/ops/HANDOFF_JAN.md](docs/ops/HANDOFF_JAN.md) - operational notes from the hardening and load-test campaign
- [docs/history/CHANGES_FROM_OLD.md](docs/history/CHANGES_FROM_OLD.md) - historical diff notes versus the older codebase

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
loadtest-matrix.js   staged load-test runner with logging + session prep
data/                runtime data (git-ignored, auto-created)
  crowd.db           SQLite database
  original.png       last uploaded image (grayscale, preserved for re-slicing)
  base.png           squared/padded version used for tile extraction
  refs/              256×256 reference crop per active tile
  final-view.png     cached final mosaic
logs/                load-test logs written by loadtest-matrix.js
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
Production examples in this repo all use `127.0.0.1:3000` behind nginx.
Render workers are sized automatically from CPU count, leaving headroom for the main event loop.
Optional production overrides:

```bash
RENDER_WORKERS=4
RENDER_WORKERS_MAX=6
```

## How an event runs

1. Open the admin page, upload a high-contrast **black & white** image — bold shapes/line-art slice
   and draw far better than photos.
   Uploads with a longest side above `8192px` are rejected before slicing.
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
ssh deploy@VPS 'export NODE_ENV=production ADMIN_TOKEN=PASTE_A_LONG_RANDOM_TOKEN_HERE && cd /opt/crowd-canvas && npm install --omit=dev && pm2 restart crowd-canvas --update-env'
```

> **Run exactly one process.** All game state (the tile deck, assignment pointer, and the connected
> player/view/admin sets) lives in memory in a single process. Do **not** use pm2 cluster mode or
> multiple workers — they would hand out duplicate tiles and desync the mosaic. Scale vertically.

> **Set `ADMIN_TOKEN` before any public deployment.** The admin page shell can be exposed, but the
> app now expects `Authorization: Bearer <ADMIN_TOKEN>` on admin/control APIs and the same token on
> the admin websocket. nginx Basic Auth is optional defense-in-depth, not the only protection.

> **Render worker sizing is CPU-dependent by default.** The server uses `os.availableParallelism()`
> first, falls back to `os.cpus().length`, and leaves CPU for the main HTTP/WebSocket loop. Use
> `RENDER_WORKERS=4` to pin an explicit count or `RENDER_WORKERS_MAX=6` to cap automatic sizing.

For large events (10k–20k) you also need to raise the file-descriptor limit, tune nginx worker
connections and WebSocket timeouts, and pick a dedicated-CPU instance. See
[`docs/ops/DEPLOY.md`](docs/ops/DEPLOY.md) for the full step-by-step runbook including sysctl
tuning, TLS setup, and a load-test plan.

## Data

Everything in `data/` is generated at runtime and is git-ignored. The directory is created
automatically on first run; deleting it resets all sessions.

## Load testing

`loadtest.js` simulates phones connecting, drawing, and submitting so you can rehearse a large
event before the night. It only needs the `ws` package (already a dependency).

```bash
ulimit -n 100000                                   # on the test machine
node loadtest.js wss://draw.mmsparty.nl/ws --clients 5000 --rate 500 --tiles 3
```

First slice a **test** image on the admin (this fills the mosaic with junk — don't run it against
your live event), then watch `htop` and event-loop lag on the server. Key flags: `--clients`,
`--rate` (connections/sec — crank it to mimic the QR scan storm), `--tiles`, `--insecure` (staging
certs), `--duration`. One machine tops out near ~25–28k connections (ephemeral ports); for a full
20k+ run, split `--clients` across 2–3 machines.

### Load-test matrix runner

For staged rehearsals up to 20k clients with a summary table at the end:

```bash
npm run loadtest:matrix -- ws://127.0.0.1:3000/ws --max-clients 20000
```

Use `--tester loadtest2` when you want the more realistic page + ref-image + websocket player simulation, or keep the default `--tester loadtest` for the lighter websocket-only generator.

This runs a smoke stage, a connection-storm stage, then realistic stages that ramp through larger
client counts and prints a compact matrix with opened connections, peak live users, errors, and
latency percentiles.

If `ADMIN_TOKEN` is set on the app, the matrix runner must use the same token for session prep and
config sweeps. Prefer an environment variable so the token does not end up in shell history:

```bash
ADMIN_TOKEN=YOUR_TOKEN npm run loadtest:matrix -- ws://127.0.0.1:3000/ws --max-clients 20000
```

There is also a `--admin-token` flag for ad hoc runs, but the environment variable is the safer
habit.

If you want breakpoint reports to include real app-host CPU/load/memory/socket/process stats instead of only local generator stats, add `--metrics-host user@your-server`.

You can also point the runner at the app base URL instead of the websocket URL:

```bash
node loadtest-matrix.js --url http://127.0.0.1:3000 --profile smoke
```

The stage builder now expands beyond `20k` when you raise `--max-clients`. For example:

- `--max-clients 20000` adds stages through `real-20000`
- `--max-clients 40000` adds `real-30000` and `real-40000`
- values above that continue in `10k` steps, with the exact limit appended if it is not already on
  the step boundary

Higher stages run longer so the system has time to settle:

- below `10k`: `120s`
- `10k` to `20k`: `180s`
- `30k+`: `240s`

If you want matrix-mode clients to close as soon as they finish instead of staying connected, use:

```bash
npm run loadtest:matrix -- ws://127.0.0.1:3000/ws --max-clients 20000 --keep-open false
```

### Automatic logging

`loadtest-matrix.js` always writes a full log file.

- Default directory: `logs/`
- Default filename: `loadtest-matrix-YYYYMMDD-HHMMSS.log`
- Custom file: `--output logs/my-run.log`

Example:

```bash
npm run loadtest:matrix -- ws://127.0.0.1:3000/ws --max-clients 20000 --output logs/my-run.log
```

### Automatic session prep

The matrix runner can also upload an image, create a session, and restart the session between
stages so later stages do not just hit `done` because the earlier ones exhausted the tile pool.

Supported flags:

- `--image FILE` — upload an image before the run
- `--pieces N` — target piece count when auto-slicing (default `400`)
- `--redundancy N` — players per piece when auto-slicing (default `3`)
- `--include-solid-black` — include solid black tiles during slicing
- `--no-reset-each-stage` — reuse one session across the whole matrix instead of restarting it

Example using a local test image:

```bash
ADMIN_TOKEN=YOUR_TOKEN npm run loadtest:matrix -- ws://127.0.0.1:3000/ws \
  --image data/JAN.png \
  --pieces 5000 \
  --redundancy 5 \
  --max-clients 20000 \
  --output logs/jan-20k-run.log
```

This is the preferred way to run meaningful multi-stage tests now. Without a fresh test session,
the run can still prove socket capacity, but it may not exercise real drawing/submission load.

### Settings sweep runner

`loadtest-matrix.js` can also run multiple config/session scenarios in sequence and print a final
comparison table. This is useful when you want to compare things like:

- `pieces`
- `redundancy`
- `blendMode`
- `blendGamma`
- `liveMinPixelVotes`
- `similarityThreshold`
- `maxStrayInk`
- `minCoverage`

Use the example file in the repo as a starting point:

```bash
cp loadtest-sweep.example.json my-sweep.json
```

Then run:

```bash
ADMIN_TOKEN=YOUR_TOKEN npm run loadtest:matrix -- ws://127.0.0.1:3000/ws \
  --max-clients 20000 \
  --sweep my-sweep.json \
  --output logs/sweep-run.log
```

Sweep file shape:

```json
{
  "baseConfig": {
    "blendMode": "blend",
    "blendGamma": 1.71,
    "liveMinPixelVotes": 0
  },
  "baseSession": {
    "image": "data/JAN.png",
    "pieces": 5000,
    "redundancy": 5
  },
  "scenarios": [
    {
      "name": "baseline",
      "config": {},
      "session": {}
    },
    {
      "name": "more-pieces",
      "config": {},
      "session": { "pieces": 8000 }
    }
  ]
}
```

### Breakpoint discovery

Breakpoint mode is opt-in only. It deliberately pushes the app until it becomes degraded or fails,
then records the last known good user count, the first known bad user count, and a recommended safe
production number with margin.

Smoke:

```bash
node loadtest-matrix.js --url http://127.0.0.1:3000 --profile smoke
```

Realistic event:

```bash
ADMIN_TOKEN=YOUR_TOKEN node loadtest-matrix.js \
  --url http://127.0.0.1:3000 \
  --profile event \
  --users 5000 \
  --ramp 120 \
  --hold 300
```

Break-point discovery:

```bash
ADMIN_TOKEN=YOUR_TOKEN node loadtest-matrix.js \
  --url http://127.0.0.1:3000 \
  --profile breakpoint \
  --breakpoint-start 500 \
  --breakpoint-max 30000 \
  --breakpoint-growth 2 \
  --breakpoint-refine true \
  --ramp 90 \
  --hold 180 \
  --cooldown 30 \
  --yes
```

Breakpoint artifacts are written under:

- `reports/breakpoint-YYYYMMDD-HHMMSS/report.md`
- `reports/breakpoint-YYYYMMDD-HHMMSS/breakpoint-summary.json`
- `reports/breakpoint-YYYYMMDD-HHMMSS/breakpoint-steps.json`
- `reports/breakpoint-YYYYMMDD-HHMMSS/breakpoint-metrics.csv`

How to read the sweep results:

- `Status` still reflects PASS/WARN/FAIL for that scenario’s matrix run
- `Ok` tells you how many submissions the largest real stage accepted
- `AssignP95`, `SubmitP95`, `SubmitP99` show assignment and submit latency for the largest real stage
- `Wait` and `Done` help show when the test became tile-limited instead of backend-limited

This is most useful for performance tuning. It does not replace human review of moderation quality
or operator usability.

### Clean source bundle

To create a source ZIP for sharing or archival without runtime/generated files:

```bash
npm run source:zip
```

That excludes `.git`, `node_modules`, `data`, `logs`, `reports`, `.indigo`, and common OS/editor
noise. It does not delete any local runtime files.

### Interpreting the output

The live status lines and final matrix include a few fields that matter most:

- `err` — connection/protocol failures
- `ok` — accepted submissions
- `inflight` — submissions sent but not yet resolved
- `wait` — count of times clients were told to wait for a tile; this is a count, not milliseconds
- `done` — clients told the session is complete
- `avg`, `p95`, `p99` — submission latency in milliseconds

Quick reading guide:

- High `opened` / `peak-live`, `err=0`, but `ok=0`:
  connection test only; gameplay was not really exercised
- Rising `wait` and `done` with low errors:
  the session is running out of available work before the server is failing
- Rising `inflight`, latency, or `err`:
  the backend is starting to fall behind

### Practical workflow

1. Start the server:

   ```bash
   npm start
   ```

2. Run a small smoke test or a full staged run with automatic session prep.

3. Review the log in `logs/` and the final matrix summary.

4. For event confidence, combine synthetic load with a smaller real-device rehearsal on the same
   network path you expect to use live.
