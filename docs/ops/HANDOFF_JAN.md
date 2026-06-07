# Handoff — Load-test & hardening campaign (2026-06-06)

Notes for Jan after a full load-test session against production (`asml.mmsparty.nl`, Hetzner
**CCX33** = 8 vCPU / 30 GB). Target event: up to **20,000 concurrent** players (≈5k in-hall + up to
15k online), ~4,190 playable tiles, redundancy 5.

**TL;DR:** Two real showstoppers were found and fixed (both committed in `fbd7dfe`, live on
`origin/main`). The server is now solid under load. The two client-side UX fixes (§3.1 watchdog,
§3.2 waiting overlay) are also done in this commit. What remains is one **operational** decision —
stagger the QR reveal (§3.3) — plus two optional tweaks. nginx/TLS is *not* a bottleneck; no CPU
upgrade is required.

---

## 1. Bugs found & fixed (already committed — `fbd7dfe`)

### 1a. Crash loop — `ReferenceError: isHotPathBusy is not defined`
- pm2 showed **623 restarts**. Stack: `at give (server.js:…)` thrown on *every* WebSocket
  connection / `next`. A previously-deployed build had the `isHotPathBusy()` **call** in `give()`
  but not its **definition** — i.e. the server and the laptop copy had silently drifted.
- Effect: every connection storm crash-looped the process. All sockets dropped, the view/admin
  went blank during the post-restart accumulator rebuild. This was the real cause of the
  "connection issues", the slow phone login, and the mass-disconnects — all one crash loop.
- **Fix:** the committed code has `isHotPathBusy()` defined (`server.js:96–108`) and used in
  `give()`. Plus a process-level safety net so one bad event can never take the whole process down
  again:
  ```js
  // server.js:1780
  process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
  process.on('uncaughtException',  e => console.error('[uncaughtException]', e));
  ```
  > Note: `uncaughtException` here keeps the process alive in a possibly-inconsistent state. That's
  > a deliberate trade-off for a one-day ephemeral event server ("stay up degraded" >> "everyone
  > drops"). Reconsider for any long-running deployment.

### 1b. Single memory restart — pm2 `max_memory_restart`
- During a 2-generator run, pm2 restarted the process **once** at the 6 GB limit. Not a crash, not
  the heartbeat — just the artificial 6 GB ceiling. The box has **30 GB** and was only using
  ~4.6 GB; the cap was the only thing that tripped.
- Contributing factors (mostly test artifacts): the test DB was never cleared between runs so
  submissions piled to 100k+ (a real event stops at ~21k = redundancy reached, then `done`), and
  Sharp/libvips caches aggressively by default.
- **Current config:** the repo now runs with `max_memory_restart: '6G'` in
  `ecosystem.config.cjs`, and `server.js` does **not** call `sharp.cache(false)`. If memory
  behavior becomes a problem again, re-evaluate those trade-offs against the newer worker-pool and
  load-test hardening before copying the old 16G/cache-disabled guidance forward.

---

## 2. Load-test results (clean run, after fixes)

Hetzner generator → production, 7,000 clients @ 500/s, full lifecycle (HTTP page + ref fetch + WS +
submit), 300 s:

| Metric | Result |
|---|---|
| Peak live | **7000 / 7000**, `connErr=0`, `http err=0`, `ref err=0` |
| Submit latency | avg **11 ms**, p95 13 ms, p99 419 ms |
| pm2 restarts during run | **0** |
| Box CPU | 8 cores ~50–60 %, load avg ~3.4 — **not saturated** |
| **nginx CPU** | **~11–15 %** → *not* the bottleneck |
| node CPU | spread across 4 render workers (~50 % each) + main (~40 %) + libuv pool |

Current repo note: render worker count is no longer treated as a fixed constant. The server now
sizes workers from detected CPU count, leaves headroom for the main event loop, and supports
`RENDER_WORKERS=4` / `RENDER_WORKERS_MAX=6` for production tuning. `RENDER_WORKERS` pins the
requested count, `RENDER_WORKERS_MAX` acts as the safety cap for both automatic sizing and explicit
overrides, and there is also an internal absolute cap of `32` workers.

**Connect latency** (`hs=`) measured avg ~10 s / p99 ~20 s, but this is **largely a generator
artifact**: our generators were a single 4 GB Hetzner box and an iMac behind home NAT, both of
which cap out (NAT connection table / single-thread client-side TLS) and inflate the metric, which
is measured *in the generator*. nginx sitting at 15 % confirms the server isn't the limiter. A real
event spreads 20k connections across 20k independent devices — far gentler per endpoint. A real
phone on 5G during the test connected slowly-but-fine, then drew with no issues.

**Caveat:** we could never push hard enough to saturate nginx, so the absolute 20k-in-5s TLS peak
is technically unmeasured. All evidence points to plenty of headroom, but see §3.3.

---

## 3. Remaining TODO

### 3.1 Connect watchdog raised 8 s → 25 s ✅ DONE (this commit)
`public/player.html` — the watchdog used to tear the socket down and reconnect if no message
arrived within **8 s**. Measured connect under load is 10–20 s, so phones bailed *while the
connection was actually still working*, then reconnected — amplifying the storm. Now **25 s**. The
existing backoff+jitter on `onclose` is unchanged; the longer watchdog just stops premature
give-ups during a slow-but-working connect.

### 3.2 "Waiting for tile" UX ✅ DONE (this commit)
Players experience **two stacked waits**: (1) connect, then (2) a "waiting for a tile" state. The
second is the `isHotPathBusy` backpressure — when the render queue is deep, `give()` sends
`{type:'wait'}` and the client retries `next`. Previously the `'wait'` case showed **no dedicated
UI** (only the pre-game `'waiting'` did), so with `ghostMode=immediate` the player saw a half-loaded
drawing GUI. Now the `'wait'` handler shows the same centred full-screen overlay ("Almost there! /
Finding you a piece to draw…"), hidden again on the next `'tile'`. (This wait is hugely exaggerated
in the load test because clients resubmit infinitely; a real event fills up and finishes, so it's
mostly front-loaded during the opening rush.)

### 3.3 Stagger the QR reveal (operational)
Don't reveal the QR to all 20k at once. Release in waves (hall sections, then online cohorts) so the
connection arrival rate stays low. This is the single most effective lever for the opening storm and
costs nothing.

### 3.4 Optional: raise `HOT_QUEUE_SOFT_LIMIT` (server.js:96, currently 400)
The server had CPU headroom, so the backpressure threshold could go higher (fewer `wait` messages,
faster first tile). Be careful — it lets the render queue grow. Not required for a real event that
fills and finishes; only worth it if §3.2's UX still feels slow after testing.

### 3.5 Optional: CCX43 upgrade
Pure headroom, **not required**. CCX33 handled everything with margin. Consider only if you want
insurance for the untested 20k-in-5s peak.

---

## 4. Slice facts for the event image (`poster_award_draw_final_bw.png`)
- Source 3840×2160 (4K 16:9). Padded to 4096×4096; content occupies the top 4096×2304.
- `pieces=5000` → 5002 leaves = **~4,190 playable tiles** + 812 blank (white areas + the 16:9→square
  padding). To get ~5,000 *playable* tiles, slice with `pieces≈6000`.
- Per-tile ref PNG ~10 KB (≈42 MB total on disk). Accumulator RAM peak ≈ 1.3 GB — fine on 30 GB.
- seed.png/view renders at 4096×2304 (~9.4 MP). Avoid reloading the view screen mid-event
  (10–30 s rebuild).

---

## 5. How to load test (`loadtest2.js`, added this session)
Full-lifecycle tester: each virtual player does `GET /` + `GET /api/config` + WS + per-tile ref
fetch + submit. Separate error buckets (ws / http / ref) and handshake + first-tile latency.

```bash
ulimit -n 100000
node loadtest2.js wss://asml.mmsparty.nl/ws --clients 7000 --rate 500 --duration 300
```
Modes: `--mode full|ws|storm|http`. `--start-at <epoch-ms>` fires a **synchronized** storm across
multiple machines (the realistic QR-reveal test) — set the same value on each box.

**Generator caveats (important):** a single box caps near ~28k connections (ephemeral ports), and a
home-NAT'd machine dies far earlier (router connection table). Those limits inflate `hs=` /
`connErr` and are *not* the server. For a true 20k capacity test, use **2–3 datacenter boxes** with
`--start-at`, not one box or a home network. `loadtest-matrix.js` (Jan's staged runner) is the other
option for a scripted smoke→storm→realistic sweep.

Always re-slice a **test** image first (fills the mosaic with junk + clears the DB).

---

## 6. Infra hygiene — please keep this
- **`/opt/crowd-canvas` is now a git checkout and matches `origin/main` (`fbd7dfe`).** The drift in
  §1a happened because hand edits on the server diverged from the repo. Going forward:
  - develop → commit → push;
  - deploy with `cd /opt/crowd-canvas && git pull && npm install --omit=dev && pm2 restart crowd-canvas`;
  - no more ad-hoc `sed`/manual edits on the server without committing.
- **One process only.** All game state is in-memory in a single fork-mode process. No pm2 cluster,
  no multiple instances — they'd hand out duplicate tiles and desync the mosaic. Scale vertically.
- Sharp currently runs with `sharp.concurrency(2)` in the main process; CPU-heavy decode/render is
  offloaded to the worker pool (`render-worker.js`). `max_memory_restart` is currently 6 G in
  `ecosystem.config.cjs`.
- **nginx serves the player page (`location = /`) statically from `/opt/crowd-canvas/public/player.html`**,
  bypassing Node. This was added because a browser reload under heavy load took ~20s (the HTML was
  served by a saturated Node main thread); static serving makes a reload near-instant. Keep it — do
  not revert `location = /` to `proxy_pass`. `player.html` has no token so it's safe to serve raw.
  (`/ws`, `/api/*`, `/dropveters-admin`, `/dropveters-view` still proxy to Node.) Also: keep
  `sites-enabled/crowd-canvas` a **symlink** to `sites-available/` — a stale plain-file copy there
  silently kept the old config; see [DEPLOY.md](DEPLOY.md) §5.
