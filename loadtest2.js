#!/usr/bin/env node
//
// Crowd Canvas load tester v2 — full-lifecycle, multi-machine, storm-aware.
//
// Difference from loadtest.js: this simulates what a REAL phone does, not just a
// WebSocket. Each virtual player:
//   1. GET /                       (the player page — nginx static/proxy)
//   2. GET /api/config             (warm the API path)
//   3. opens the WebSocket          (the TLS handshake storm lives here)
//   4. on each tile: GET /refs/<id>.png  (ref image — nginx static or Node)
//   5. "draws" for draw-min..draw-max seconds, then submits a realistic PNG
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
//   --keepalive      reuse HTTP connections (default: off, = realistic cold scans)
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

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const base = argv.find(a => !a.startsWith('--'));
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
if (!base) {
  console.error('Usage: node loadtest2.js https://host [--clients N] [--rate R] [--start-at MS] [--mode full|ws|storm|http] ...');
  process.exit(1);
}
// Accept either form: a base domain (https://host) OR the old-style ws URL
// (wss://host/ws). Normalize to an https base + a wss /ws endpoint either way.
let BASE = base.replace(/\/+$/, '');
BASE = BASE.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'); // ws→http, wss→https
BASE = BASE.replace(/\/ws$/, '');                                // strip trailing /ws if given
if (!/^https?:\/\//.test(BASE)) BASE = 'https://' + BASE;        // bare host → https
const WS_URL   = BASE.replace(/^http/, 'ws') + '/ws?role=player';
const CLIENTS  = +opt('clients', 5000);
const RATE     = +opt('rate', 500);
const START_AT = +opt('start-at', 0);
const MODE     = String(opt('mode', 'full'));
const DRAW_MIN = +opt('draw-min', 20);
const DRAW_MAX = +opt('draw-max', 40);
const DURATION = +opt('duration', 0);
const INSECURE = !!opt('insecure', false);
const KEEPALIVE = !!opt('keepalive', false);

const wantHttp   = MODE === 'full' || MODE === 'http';
const wantWs     = MODE === 'full' || MODE === 'ws' || MODE === 'storm';
const wantSubmit = MODE === 'full' || MODE === 'ws';

// NOTE: each WebSocket opens its OWN TLS connection (no pooling), so the WS path
// is the real TLS-handshake-storm signal. HTTP fetches use Node's built-in fetch,
// which pools connections; treat httpErr as a correctness/availability signal, and
// read handshake latency (hs=) + connErr from the WS side for the storm picture.
if (INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

// ── metrics ───────────────────────────────────────────────────────────────────
const m = {
  httpOpened: 0, httpOk: 0, httpErr: 0,
  refOk: 0, refErr: 0,
  wsOpening: 0, wsLive: 0, wsClosed: 0, wsConnErr: 0,
  submits: 0, accepted: 0, rejected: 0, waited: 0, done: 0, inflight: 0,
};
const tNow = () => Date.now();
const handshakeLat = []; // ms from WS() to 'open'
const firstTileLat = []; // ms from 'open' to first 'tile'
const submitLat    = []; // ms from submit to accepted
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

// ── one virtual player ──────────────────────────────────────────────────────
let PNG;
async function startClient() {
  // HTTP phase: page + config (and in pure-http mode, also a ref later)
  if (wantHttp) {
    m.httpOpened++;
    const okPage = await httpGet(BASE + '/');
    const okCfg  = await httpGet(BASE + '/api/config');
    if (okPage && okCfg) m.httpOk++; else m.httpErr++;
  }
  if (!wantWs) {
    // pure http mode: also pull a representative static asset and stop
    if (MODE === 'http') (await httpGet(BASE + '/api/seed.png', { binary: true })) ? m.refOk++ : m.refErr++;
    return;
  }

  let ws;
  const tOpen = tNow();
  m.wsOpening++;
  try { ws = new WebSocket(WS_URL, { rejectUnauthorized: !INSECURE }); }
  catch { m.wsConnErr++; return; }

  let gotFirstTile = false, sentAt = 0, openedAt = 0;

  ws.on('open', () => { m.wsLive++; openedAt = tNow(); rec(handshakeLat, openedAt - tOpen); });

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'tile') {
      if (!gotFirstTile) { gotFirstTile = true; rec(firstTileLat, tNow() - openedAt); }
      // realistic: fetch the ref image for this tile
      if (wantHttp && msg.refUrl) (await httpGet(BASE + msg.refUrl, { binary: true })) ? m.refOk++ : m.refErr++;
      if (!wantSubmit) return; // storm mode: hold the tile, never submit
      setTimeout(() => {
        if (ws.readyState !== 1) return;
        sentAt = tNow(); m.inflight++; m.submits++;
        ws.send(JSON.stringify({ type: 'submit', tileId: msg.tileId, png: PNG }));
      }, rnd(DRAW_MIN, DRAW_MAX) * 1000);

    } else if (msg.type === 'accepted') {
      m.accepted++; m.inflight = Math.max(0, m.inflight - 1);
      if (sentAt) rec(submitLat, tNow() - sentAt);
      setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'next' })); }, rnd(0.5, 3) * 1000);

    } else if (msg.type === 'rejected') {
      m.rejected++; m.inflight = Math.max(0, m.inflight - 1);
      setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'next' })); }, 800);

    } else if (msg.type === 'wait' || msg.type === 'waiting') {
      m.waited++;
      setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'next' })); }, rnd(3, 6) * 1000);

    } else if (msg.type === 'done') {
      m.done++;
    }
  });
  ws.on('close', () => { m.wsLive = Math.max(0, m.wsLive - 1); m.wsClosed++; });
  ws.on('error', () => { m.wsConnErr++; });
}

// ── ramp ───────────────────────────────────────────────────────────────────
async function run() {
  console.log('Generating realistic 256×256 submission PNG…');
  PNG = await makeSubmitPng();
  console.log(`PNG size: ${(PNG.length / 1024).toFixed(1)} KB`);

  if (START_AT) {
    const wait = START_AT - Date.now();
    if (wait > 0) { console.log(`Synchronized start: waiting ${(wait / 1000).toFixed(1)}s until ${new Date(START_AT).toISOString()}…`); await new Promise(r => setTimeout(r, wait)); }
  }
  console.log(`\nLoad test v2 → ${BASE}`);
  console.log(`mode=${MODE}  clients=${CLIENTS}  rate=${RATE}/s  draw=${DRAW_MIN}-${DRAW_MAX}s  http=${wantHttp}  submit=${wantSubmit}  keepalive=${KEEPALIVE}\n`);

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
      `t=${secs}s live=${m.wsLive}/${launched} sub/s=${(m.submits / secs).toFixed(1)} ok=${m.accepted} infl=${m.inflight} ` +
      `wait=${m.waited} done=${m.done} | ERR ws=${m.wsConnErr} http=${m.httpErr} ref=${m.refErr} | ` +
      `hs=${avg(handshakeLat)}/${pctl(handshakeLat, .95)}ms tile=${avg(firstTileLat)}ms sub=${avg(submitLat)}/${pctl(submitLat, .99)}ms`
    );
  }, 2000);

  const shutdown = () => {
    clearInterval(ramp); clearInterval(report);
    console.log('\n─── final summary ─────────────────────────────────────────');
    console.log(`http      opened=${m.httpOpened} ok=${m.httpOk} err=${m.httpErr}  refImg ok=${m.refOk} err=${m.refErr}`);
    console.log(`websocket opened=${m.wsOpening} peak-live≈${m.wsLive} closed=${m.wsClosed} connErr=${m.wsConnErr}`);
    console.log(`submits   sent=${m.submits} accepted=${m.accepted} rejected=${m.rejected} waited=${m.waited} done=${m.done}`);
    console.log(`handshake avg=${avg(handshakeLat)}ms p95=${pctl(handshakeLat, .95)}ms p99=${pctl(handshakeLat, .99)}ms  (TLS+WS upgrade)`);
    console.log(`firsttile avg=${avg(firstTileLat)}ms p95=${pctl(firstTileLat, .95)}ms  (open→first tile)`);
    console.log(`submitLat avg=${avg(submitLat)}ms p95=${pctl(submitLat, .95)}ms p99=${pctl(submitLat, .99)}ms`);
    console.log('───────────────────────────────────────────────────────────');
    console.log('Interpreting: high connErr/handshake = TLS storm bottleneck (nginx CPU / somaxconn).');
    console.log('              high httpErr/refErr    = nginx static or Node HTTP path.');
    console.log('              high submitLat/p99     = render pool / event-loop saturation.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  if (DURATION) setTimeout(shutdown, DURATION * 1000);
}

run().catch(e => { console.error(e); process.exit(1); });
