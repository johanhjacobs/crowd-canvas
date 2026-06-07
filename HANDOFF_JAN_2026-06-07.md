# Handoff — Security hardening & capacity re-test (2026-06-07)

Follow-up to `HANDOFF_JAN.md` (2026-06-06 load-test campaign). Same target: production
`asml.mmsparty.nl`, now on a **16-core / 32 GB** AMD box, event up to ~20 k concurrent.

**TL;DR:** Closed a real admin-takeover hole (the public big-screen page was serving the admin
token), moved the token out of git into `.env`, made expensive endpoints un-hammerable, and
re-tested capacity. The server is *very* comfortable: 6 k players actively drawing = ~20 % CPU,
**2 ms** submit latency. All the "limits" we hit were the **generator** box, never the server.
Open items at the bottom.

---

## 1. Security changes (live on `asml.mmsparty.nl`)

### 1a. The view page leaked the admin token — FIXED
- `/dropveters-view` (the big screen, a public URL) had the admin token baked into its HTML
  (`window._AT='…'`). Anyone who opened it could *view-source*, grab the token, and drive every
  admin endpoint (`/api/session/stop`, `/restart`, `/config`, tile clears…) from anywhere — the
  nginx Basic auth on `/dropveters-admin` was fully bypassable this way.
- **Fix:** the view is now a **public, read-only** WebSocket role — `setupViewWS` registers no
  message handler, so a view client can only *receive*. It needs no token, so the page no longer
  embeds one (`server.js`: `if (role === 'view') setupViewWS(...)`; `viewHtml` is now served raw,
  not via `buildHtml`). Verify: `curl -s …/dropveters-view | grep _AT` returns nothing.

### 1b. Admin token moved OUT of git into `.env` — FIXED
- The token was hardcoded in `ecosystem.config.cjs` (tracked by git → in history, and exposed if the
  repo is public).
- **Fix:** `ecosystem.config.cjs` now reads an untracked **`.env`** (`ADMIN_TOKEN=…`, `chmod 600`),
  parsed at pm2 start. `server.js` is unchanged (still `process.env.ADMIN_TOKEN`). Template in
  `.env.example`. Token was **rotated**; the old one is dead. Confirm load: `pm2 env 0 | grep ADMIN_TOKEN`.

### 1c. Export PNGs build only at game end — FIXED
- `/api/export.png` + `-thumb` are expensive (composite of all tiles, ~10–30 s for a 4K mosaic) and
  were rebuildable on demand during play → a public CPU-hammer vector.
- **Fix:** both now return 404 until `state.done`; only `finishSession()` builds them at the end. The
  admin's mid-game preview was repointed to the live seed (one line), so it still works.

### 1d. Seed image obfuscated — FIXED
- The live seed (`/api/seed.png`) must stay reachable during play (the big screen loads it), so it
  can't be gated. Renamed to **`/api/dropveters-seed.png`**; the obvious name now 404s. Referenced
  only by the view + admin pages.

### Threat model (what an outsider watching via Teams could still do)
- **#1 was 1a** — now closed (+ rotate + repo private).
- **Content defacement:** validation runs on the *phone*; the server stores what it's sent, so a
  scripted client can submit arbitrary PNGs. Defenses: the live **pixel-consensus filter** (keep
  ≥ 2–3) + random tile assignment + an admin watching with tile-clear/blank. (Server-side validation
  is the real fix but not built — deliberately out of scope before the event.)
- **Per-IP rate limiting is the wrong tool here:** the venue WiFi NATs all phones to one IP, so a
  per-IP cap would block real players. Mitigate hammering with nginx **micro-caching**
  (`proxy_cache_lock`), not per-IP limits.

---

## 2. Capacity re-test (16-core / 32 GB box)

| Test | Result |
|---|---|
| 5 000 storm @ 500/s | 5000/5000 live, **0 errors**, stable |
| 10 000 storm @ 500/s | capped ~6.3 k → raising `ulimit -n` on the generator lifted it to **9.6 k** |
| **6 000 full @ 300/s** (draw + submit) | http/ref/ws errors **0**; submit latency avg **2 ms**, p99 23 ms; 23 887 submissions all accepted |
| Server during the full run | ~20–30 % CPU across cores, **7 GB / 30 GB** RAM, render threads not pinned |

**The server was never the bottleneck.** The 10 k "failure" was the 4 GB generator box hitting its
own file-descriptor limit (~8192 default `ulimit -n`); with `ulimit -n 100000` it went to 9.6 k and
the only strain (rising handshake latency) was the *generator* doing client-side TLS, not the server
(nginx sat at ~3 %). The render pipeline — the thing we worried about — is a non-issue at this scale
(2 ms submit latency).

**Still unmeasured:** the true 15–20 k TLS scan-storm. One 4 GB box can't generate it; use **2–3
boxes with `loadtest2.js --start-at`**. The server's nginx is tuned for it (`somaxconn 65535`,
`worker_connections 65536`).

---

## 3. Load testers (added/updated this session)
- `loadtest2.js` — recommended (`--mode full|ws|storm|http`, `--start-at`). `storm` = connect-only,
  **non-destructive** (no submissions) → safe to run against a prepared game.
- `loadtest-matrix.jan.js` — your staged runner, now with `--profile breakpoint` (auto break-point
  discovery). Spawns `loadtest.jan.js` per stage; **run from the repo root**. NB: it sends admin auth
  as `Authorization: Bearer`, while this server expects `x-admin-token` — fine as long as you load-test
  with `ADMIN_TOKEN` unset (all admin APIs open); otherwise it can't prep sessions.
- A `--mode full` run submits real drawings → **Restart** the game in the admin afterwards to clear them.

---

## 4. Deploy gotchas learned (the painful bit)
- **HTML files belong in `public/`.** `scp public/view.html deploy@host:/opt/crowd-canvas/` lands it
  in the *root*; the app keeps serving the old `public/view.html`. Cost us a long debug.
- **`admin.html`/`view.html` are read into memory once at startup** → a `pm2 restart` is mandatory
  after any HTML change; copying the file alone does nothing.
- Fast "did my HTML ship?" check: `curl -s …/dropveters-view | grep -o 'dropveters-seed.png'`.
- Prefer `git pull` deploys (updates `public/` correctly) over ad-hoc scp.

---

## 5. Open items
- [x] Rotate `ADMIN_TOKEN` (done, now in `.env`)
- [x] Make the GitHub repo private
- [ ] **Commit** the source changes (currently uncommitted in the working tree: `server.js`,
  `public/view.html`, `public/admin.html`, `ecosystem.config.cjs`, `.gitignore`, `.env.example`).
- [ ] `pm2 save` so the `.env`-loaded process survives a reboot.
- [ ] (Optional) server-side submission validation, and nginx micro-cache on `/api/dropveters-seed.png`.
- [ ] (Optional, for a true 20 k test) 2–3 generator boxes with `--start-at`.
