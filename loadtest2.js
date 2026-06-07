#!/usr/bin/env node
//
// Crowd Canvas load tester v2 — full-lifecycle, multi-machine, storm-aware.
//
// Difference from loadtest.js: this simulates what a REAL phone does, not just a
// WebSocket. Each virtual player:
//   1. GET /                       (the player page — nginx static/proxy)
//   2. opens the WebSocket          (the TLS handshake storm lives here)
//   3. on each tile: GET /refs/<id>.png  (ref image — nginx static or Node)
//   4. "draws" for draw-min..draw-max seconds, then submits a realistic PNG
//
// It reports errors in SEPARATE buckets so you can tell whether a problem is the
// TLS handshake, the HTTP layer, the WebSocket, or the submission path — instead
// of one undifferentiated "errors" number.
//
//   node loadtest2.js https://YOUR_DOMAIN [options]
//
// Options:
//   --clients N      virtual players on THIS machine          (default 5000)
//   --rate R         new players opened per second             (default 500)
//   --start-at MS    epoch-ms to begin opening connections.    (default: now)
//                    Set the SAME value on every machine to fire a synchronized
//                    QR-reveal storm. Get a clock with:  date +%s%3N
//   --mode M         full | ws | storm | http                 (default full)
//                      full  = page + ref + ws + submit (most realistic)
//                      ws    = ws + submit only (skip HTTP — isolate the WS path)
//                      storm = connect, hold open, NO submits (TLS storm test)
//                      http  = only hammer GET / and GET ref (no WS at all)
//   --draw-min S     min seconds drawing before submit         (default 20)
//   --draw-max S     max seconds drawing before submit         (default 40)
//   --duration S     auto-stop after S seconds                 (default: until Ctrl-C)
//   --insecure       accept self-signed / staging TLS cert
//
// BEFORE RUNNING (on EACH generator machine):
//   ulimit -n 100000
//   npm install ws sharp
//   One machine tops out near ~28k connections (ephemeral ports). For 20k, split
//   across 2–3 machines and use --start-at to fire them together.
//
// EXAMPLES
//   # Synchronized 20k QR-reveal storm across 2 machines, fired at the same second.
//   # Pick a time ~30s in the future, identical on both machines:
//   T=$(( ($(date +%s) + 30) * 1000 ))
//   #   machine A (iMac):     node loadtest2.js https://asml.mmsparty.nl --clients 10000 --rate 2000 --start-at $T --mode storm --duration 120
//   #   machine B (Windows):  node loadtest2.js https://asml.mmsparty.nl --clients 10000 --rate 2000 --start-at $T --mode storm --duration 120
//
//   # Full realistic event, 10k per machine:
//   node loadtest2.js https://asml.mmsparty.nl --clients 10000 --rate 400 --mode full
//
//   # Smoke test before friends arrive:
//   node loadtest2.js https://asml.mmsparty.nl --clients 200 --rate 100 --duration 90
//

import { WebSocket } from 'ws';
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

// ── args ────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);

function opt(argv, name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

export function normalizeLoadtest2Target(raw) {
  let base = String(raw).replace(/\/+$/, '');
  base = base.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  base = base.replace(/\/ws$/, '');
  if (!/^https?:\/\//.test(base)) base = 'https://' + base;
  const wsUrl = base.replace(/^http/, 'ws') + '/ws?role=player';
  return { base, wsUrl };
}

// NOTE: each WebSocket opens its OWN TLS connection (no pooling), so the WS path
// is the real TLS-handshake-storm signal. HTTP fetches use Node's built-in fetch,
// which pools connections; treat httpErr as a correctness/availability signal, and
// read handshake latency (hs=) + connErr from the WS side for the storm picture.

// ── realistic 256×256 submission PNG (matches real client output) ─────────────
async function makeSubmitPng() {
  const W = 256, H = 256;
  const buf = Buffer.alloc(W * H, 248);
  const strokes = 4 + Math.floor(Math.random() * 6);
  for (let s = 0; s < strokes; s++) {
    let x = Math.random() * W, y = Math.random() * H;
    const steps = 30 + Math.floor(Math.random() * 60);
    const dx = (Math.random() - 0.5) * 8, dy = (Math.random() - 0.5) * 8;
    const r = 8 + Math.floor(Math.random() * 10);
    for (let i = 0; i < steps; i++) {
      x = Math.max(0, Math.min(W - 1, x + dx + (Math.random() - 0.5) * 4));
      y = Math.max(0, Math.min(H - 1, y + dy + (Math.random() - 0.5) * 4));
      for (let dy2 = -r; dy2 <= r; dy2++)
        for (let dx2 = -r; dx2 <= r; dx2++)
          if (dx2 * dx2 + dy2 * dy2 <= r * r) {
            const px = Math.round(x + dx2), py = Math.round(y + dy2);
            if (px >= 0 && px < W && py >= 0 && py < H) buf[py * W + px] = 18;
          }
    }
  }
  const png = await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

const tNow = () => Date.now();
const rec = (arr, v) => { arr.push(v); if (arr.length > 8000) arr.shift(); };
const pctl = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const avg  = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(0) : 0;
const rnd  = (a, b) => a + Math.random() * (b - a);

async function httpGet(url, { binary = false } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'crowd-canvas-loadtest/2' } });
    if (binary) await res.arrayBuffer(); else await res.text();
    return res.ok;
  } catch { return false; }
}

function buildSummary(metrics, handshakeLat, firstTileLat, submitLat) {
  return {
    opened: metrics.wsOpening,
    peakLive: metrics.wsPeakLive,
    closed: metrics.wsClosed,
    errors: metrics.wsConnErr,
    wsConnErr: metrics.wsConnErr,
    httpOpened: metrics.httpOpened,
    httpOk: metrics.httpOk,
    httpErr: metrics.httpErr,
    refOk: metrics.refOk,
    refErr: metrics.refErr,
    sent: metrics.submits,
    accepted: metrics.accepted,
    rejected: metrics.rejected,
    inflight: metrics.inflight,
    waited: metrics.waited,
    done: metrics.done,
    handshakeAvg: Number(avg(handshakeLat)),
    handshakeP95: pctl(handshakeLat, 0.95),
    handshakeP99: pctl(handshakeLat, 0.99),
    firstTileAvg: Number(avg(firstTileLat)),
    firstTileP95: pctl(firstTileLat, 0.95),
    firstTileP99: pctl(firstTileLat, 0.99),
    submitAvg: Number(avg(submitLat)),
    submitP95: pctl(submitLat, 0.95),
    submitP99: pctl(submitLat, 0.99),
    handshakeSamples: handshakeLat.length,
    firstTileSamples: firstTileLat.length,
    submitSamples: submitLat.length,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const baseArg = argv.find(a => !a.startsWith('--'));
  if (!baseArg) {
    console.error('Usage: node loadtest2.js https://host [--clients N] [--rate R] [--start-at MS] [--mode full|ws|storm|http] ...');
    process.exit(1);
  }
  const { base: BASE, wsUrl: WS_URL } = normalizeLoadtest2Target(baseArg);
  const CLIENTS  = +opt(argv, 'clients', 5000);
  const RATE     = +opt(argv, 'rate', 500);
  const START_AT = +opt(argv, 'start-at', 0);
  const MODE     = String(opt(argv, 'mode', 'full'));
  const DRAW_MIN = +opt(argv, 'draw-min', 20);
  const DRAW_MAX = +opt(argv, 'draw-max', 40);
  const DURATION = +opt(argv, 'duration', 0);
  const INSECURE = !!opt(argv, 'insecure', false);
  if (INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const wantHttp   = MODE === 'full' || MODE === 'http';
  const wantWs     = MODE === 'full' || MODE === 'ws' || MODE === 'storm';
  const wantSubmit = MODE === 'full' || MODE === 'ws';
  const metrics = {
    httpOpened: 0, httpOk: 0, httpErr: 0,
    refOk: 0, refErr: 0,
    wsOpening: 0, wsLive: 0, wsPeakLive: 0, wsClosed: 0, wsConnErr: 0,
    submits: 0, accepted: 0, rejected: 0, waited: 0, done: 0, inflight: 0,
  };
  const handshakeLat = [];
  const firstTileLat = [];
  const submitLat = [];
  let PNG;

  async function startClient() {
  // HTTP phase: page + config (and in pure-http mode, also a ref later)
    if (wantHttp) {
      metrics.httpOpened++;
      const okPage = await httpGet(BASE + '/');
      if (okPage) metrics.httpOk++; else metrics.httpErr++;
    }
    if (!wantWs) {
      if (MODE === 'http') (await httpGet(BASE + '/api/seed.png', { binary: true })) ? metrics.refOk++ : metrics.refErr++;
      return;
    }

    let ws;
    const tOpen = tNow();
    metrics.wsOpening++;
    try { ws = new WebSocket(WS_URL, { rejectUnauthorized: !INSECURE }); }
    catch { metrics.wsConnErr++; return; }

    let gotFirstTile = false, sentAt = 0, openedAt = 0;

    ws.on('open', () => {
      metrics.wsLive++;
      metrics.wsPeakLive = Math.max(metrics.wsPeakLive, metrics.wsLive);
      openedAt = tNow();
      rec(handshakeLat, openedAt - tOpen);
    });

    ws.on('message', async raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'tile') {
        if (!gotFirstTile) { gotFirstTile = true; rec(firstTileLat, tNow() - openedAt); }
        if (wantHttp && msg.refUrl) (await httpGet(BASE + msg.refUrl, { binary: true })) ? metrics.refOk++ : metrics.refErr++;
        if (!wantSubmit) return;
        setTimeout(() => {
          if (ws.readyState !== 1) return;
          sentAt = tNow(); metrics.inflight++; metrics.submits++;
          ws.send(JSON.stringify({ type: 'submit', tileId: msg.tileId, png: PNG }));
        }, rnd(DRAW_MIN, DRAW_MAX) * 1000);

      } else if (msg.type === 'accepted') {
        metrics.accepted++; metrics.inflight = Math.max(0, metrics.inflight - 1);
        if (sentAt) rec(submitLat, tNow() - sentAt);
        setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'next' })); }, rnd(0.5, 3) * 1000);

      } else if (msg.type === 'rejected') {
        metrics.rejected++; metrics.inflight = Math.max(0, metrics.inflight - 1);
        setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'next' })); }, 800);

      } else if (msg.type === 'wait' || msg.type === 'waiting') {
        metrics.waited++;
        setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'next' })); }, rnd(3, 6) * 1000);

      } else if (msg.type === 'done') {
        metrics.done++;
      }
    });
    ws.on('close', () => { metrics.wsLive = Math.max(0, metrics.wsLive - 1); metrics.wsClosed++; });
    ws.on('error', () => { metrics.wsConnErr++; });
  }

  // ── ramp ───────────────────────────────────────────────────────────────────
  console.log('Generating realistic 256×256 submission PNG…');
  PNG = await makeSubmitPng();
  console.log(`PNG size: ${(PNG.length / 1024).toFixed(1)} KB`);

  if (START_AT) {
    const wait = START_AT - Date.now();
    if (wait > 0) { console.log(`Synchronized start: waiting ${(wait / 1000).toFixed(1)}s until ${new Date(START_AT).toISOString()}…`); await new Promise(r => setTimeout(r, wait)); }
  }
  console.log(`\nLoad test v2 → ${BASE}`);
  console.log(`mode=${MODE}  clients=${CLIENTS}  rate=${RATE}/s  draw=${DRAW_MIN}-${DRAW_MAX}s  http=${wantHttp}  submit=${wantSubmit}\n`);

  const t0 = tNow();
  let launched = 0;
  const ramp = setInterval(() => {
    const n = Math.min(RATE, CLIENTS - launched);
    for (let i = 0; i < n; i++) startClient();
    launched += n;
    if (launched >= CLIENTS) clearInterval(ramp);
  }, 1000);

  const report = setInterval(() => {
    const secs = Math.max(1, Math.round((tNow() - t0) / 1000));
    console.log(
      `t=${secs}s live=${metrics.wsLive}/${launched} sub/s=${(metrics.submits / secs).toFixed(1)} ok=${metrics.accepted} inflight=${metrics.inflight} ` +
      `done=${metrics.done} wait=${metrics.waited} wsErr=${metrics.wsConnErr} httpErr=${metrics.httpErr} refErr=${metrics.refErr} ` +
      `hs avg=${avg(handshakeLat)}ms p95=${pctl(handshakeLat, .95)}ms p99=${pctl(handshakeLat, .99)}ms ` +
      `tile avg=${avg(firstTileLat)}ms p95=${pctl(firstTileLat, .95)}ms p99=${pctl(firstTileLat, .99)}ms ` +
      `submit avg=${avg(submitLat)}ms p95=${pctl(submitLat, .95)}ms p99=${pctl(submitLat, .99)}ms`
    );
  }, 2000);

  const shutdown = () => {
    clearInterval(ramp); clearInterval(report);
    const summary = buildSummary(metrics, handshakeLat, firstTileLat, submitLat);
    console.log('\n─── final summary ─────────────────────────────────────────');
    console.log(`http      opened=${summary.httpOpened} ok=${summary.httpOk} err=${summary.httpErr}  refImg ok=${summary.refOk} err=${summary.refErr}`);
    console.log(`websocket opened=${summary.opened} peak-live≈${summary.peakLive} closed=${summary.closed} connErr=${summary.wsConnErr}`);
    console.log(`submits   sent=${summary.sent} accepted=${summary.accepted} rejected=${summary.rejected} waited=${summary.waited} done=${summary.done}`);
    console.log(`handshake avg=${summary.handshakeAvg}ms p95=${summary.handshakeP95}ms p99=${summary.handshakeP99}ms  (TLS+WS upgrade)`);
    console.log(`firsttile avg=${summary.firstTileAvg}ms p95=${summary.firstTileP95}ms p99=${summary.firstTileP99}ms  (open→first tile)`);
    console.log(`submitLat avg=${summary.submitAvg}ms p95=${summary.submitP95}ms p99=${summary.submitP99}ms`);
    console.log(`SUMMARY_JSON ${JSON.stringify({ tester: 'loadtest2', summary })}`);
    console.log('───────────────────────────────────────────────────────────');
    console.log('Interpreting: high connErr/handshake = TLS storm bottleneck (nginx CPU / somaxconn).');
    console.log('              high httpErr/refErr    = nginx static or Node HTTP path.');
    console.log('              high submitLat/p99     = render pool / event-loop saturation.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (DURATION) setTimeout(shutdown, DURATION * 1000);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch(e => { console.error(e); process.exit(1); });
}
