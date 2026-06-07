#!/usr/bin/env node
//
// Crowd Canvas load tester — simulates many phones connecting, "drawing", and submitting.
//
//   node loadtest.js wss://YOUR_DOMAIN/ws [options]
//
// Options:
//   --clients N     total virtual players to open         (default 1000)
//   --rate R        new connections opened per second      (default 200)
//   --draw-min S    min seconds "drawing" before submit    (default 20)
//   --draw-max S    max seconds "drawing" before submit    (default 40)
//   --tiles N       tiles each player draws, 0 = until done (default 0)
//   --hold false    close connections after finishing       (default keeps them open = realistic)
//   --insecure      accept a self-signed / staging TLS cert
//   --duration S    auto-stop after S seconds              (default: run until Ctrl-C)
//
// BEFORE RUNNING:
//   1. On the admin page, slice a TEST image (this will fill the mosaic with
//      junk — do not run against your live event data).
//   2. On the test machine: ulimit -n 100000
//   3. One machine tops out at ~25–28k connections (ephemeral port limit).
//      For a true 20k test, split --clients across 2 machines.
//
// REALISTIC EVENT SIMULATION:
//   node loadtest.js wss://YOUR_DOMAIN/ws --clients 10000 --rate 500 --draw-min 20 --draw-max 40
//   (run this on two machines simultaneously for 20k total)
//
// QUICK SMOKE TEST (before friends arrive):
//   node loadtest.js wss://YOUR_DOMAIN/ws --clients 200 --rate 100 --duration 120
//
// QR SCAN STORM ONLY (test the initial connection spike, no submissions):
//   node loadtest.js wss://YOUR_DOMAIN/ws --clients 20000 --rate 2000 --draw-min 300 --draw-max 400
//

import { WebSocket } from 'ws';
import sharp from 'sharp';

// ── generate a realistic 256×256 submission PNG ───────────────────────────────
// The hardcoded tiny PNG in the original loadtest was ~660 bytes.
// After the client-side resize change, real submissions are 256×256 PNGs (~20–30 KB).
// Using a realistic size gives accurate DB write pressure and Sharp throughput numbers.
async function makeSubmitPng() {
  const W = 256, H = 256;
  const buf = Buffer.alloc(W * H, 248); // near-white base

  // Simulate a rough brush scribble: a few curved strokes across the tile
  const strokes = 4 + Math.floor(Math.random() * 6);
  for (let s = 0; s < strokes; s++) {
    let x = Math.random() * W, y = Math.random() * H;
    const steps = 30 + Math.floor(Math.random() * 60);
    const dx = (Math.random() - 0.5) * 8, dy = (Math.random() - 0.5) * 8;
    const r = 8 + Math.floor(Math.random() * 10);
    for (let i = 0; i < steps; i++) {
      x = Math.max(0, Math.min(W - 1, x + dx + (Math.random() - 0.5) * 4));
      y = Math.max(0, Math.min(H - 1, y + dy + (Math.random() - 0.5) * 4));
      for (let dy2 = -r; dy2 <= r; dy2++) {
        for (let dx2 = -r; dx2 <= r; dx2++) {
          if (dx2 * dx2 + dy2 * dy2 <= r * r) {
            const px = Math.round(x + dx2), py = Math.round(y + dy2);
            if (px >= 0 && px < W && py >= 0 && py < H) buf[py * W + px] = 18;
          }
        }
      }
    }
  }

  const pngBuf = await sharp(buf, { raw: { width: W, height: H, channels: 1 } })
    .png().toBuffer();
  return 'data:image/png;base64,' + pngBuf.toString('base64');
}

// ── parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const url  = args.find(a => !a.startsWith('--'));
function opt(name, def) {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
if (!url) {
  console.error('Usage: node loadtest.js wss://host/ws [--clients N] [--rate R] [--tiles N] [--insecure] [--duration S]');
  process.exit(1);
}

const CLIENTS  = +opt('clients',  1000);
const RATE     = +opt('rate',      200);
const DRAW_MIN = +opt('draw-min',   20);   // ← updated from 4 to 20 to match real event
const DRAW_MAX = +opt('draw-max',   40);   // ← updated from 20 to 40 to match real event
const TILES    = +opt('tiles',       0);   // ← 0 = keep drawing until game ends (realistic)
const HOLD     = opt('hold', 'true') !== 'false';
const INSECURE = !!opt('insecure', false);
const DURATION = +opt('duration',    0);

// ── generate PNG then start ───────────────────────────────────────────────────
console.log('Generating realistic 256×256 submission PNG…');
const PNG = await makeSubmitPng();
console.log(`PNG size: ${(PNG.length / 1024).toFixed(1)} KB  (real submissions will be similar)`);

const target = url + (url.includes('?') ? '&' : '?') + 'role=player';
let opened = 0, live = 0, closed = 0, errors = 0;
let submits = 0, accepted = 0, rejected = 0, done = 0, waiting = 0, inflight = 0;
const assignLat = [];
const submitLat = [];
const recordLat = (arr, ms) => { arr.push(ms); if (arr.length > 4000) arr.shift(); };
const pctl = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const rnd = (a, b) => a + Math.random() * (b - a);
const avgMs = arr => (arr.reduce((a, b) => a + b, 0) / (arr.length || 1)).toFixed(0);

function startClient() {
  let ws;
  try { ws = new WebSocket(target, { rejectUnauthorized: !INSECURE }); }
  catch { errors++; return; }
  opened++;
  let tilesDone = 0, sentAt = 0, awaitingTileSince = Date.now();
  const finish = () => { if (!HOLD) ws.close(); };

  ws.on('open', () => { live++; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'tile') {
      if (awaitingTileSince) {
        recordLat(assignLat, Date.now() - awaitingTileSince);
        awaitingTileSince = 0;
      }
      // Simulate drawing time: uniform random between draw-min and draw-max seconds
      setTimeout(() => {
        if (ws.readyState !== 1) return;
        sentAt = Date.now(); inflight++; submits++;
        ws.send(JSON.stringify({ type: 'submit', tileId: m.tileId, png: PNG }));
      }, rnd(DRAW_MIN, DRAW_MAX) * 1000);

    } else if (m.type === 'accepted') {
      accepted++; inflight = Math.max(0, inflight - 1);
      if (sentAt) recordLat(submitLat, Date.now() - sentAt);
      tilesDone++;
      if (TILES === 0 || tilesDone < TILES) {
        // Short pause between tiles (realistic: player reads the next fragment)
        setTimeout(() => {
          if (ws.readyState === 1) {
            awaitingTileSince = Date.now();
            ws.send(JSON.stringify({ type: 'next' }));
          }
        }, rnd(0.5, 3) * 1000);
      } else finish();

    } else if (m.type === 'rejected') {
      rejected++; inflight = Math.max(0, inflight - 1);
      setTimeout(() => {
        if (ws.readyState === 1) {
          awaitingTileSince = Date.now();
          ws.send(JSON.stringify({ type: 'next' }));
        }
      }, 500);

    } else if (m.type === 'done') {
      done++; finish();

    } else if (m.type === 'wait' || m.type === 'waiting') {
      waiting++;
      setTimeout(() => {
        if (ws.readyState === 1) {
          awaitingTileSince = Date.now();
          ws.send(JSON.stringify({ type: 'next' }));
        }
      }, rnd(3, 6) * 1000);
    }
  });
  ws.on('close', () => { live = Math.max(0, live - 1); closed++; });
  ws.on('error', () => { errors++; });
}

// ── ramp up connections ───────────────────────────────────────────────────────
let launched = 0;
const ramp = setInterval(() => {
  const n = Math.min(RATE, CLIENTS - launched);
  for (let i = 0; i < n; i++) startClient();
  launched += n;
  if (launched >= CLIENTS) clearInterval(ramp);
}, 1000);

// ── live stats ────────────────────────────────────────────────────────────────
const t0  = Date.now();

const report = setInterval(() => {
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const subsPerSec = (submits / Math.max(1, +secs)).toFixed(1);
  console.log(
    `t=${secs}s  live=${live}/${launched}  sub/s=${subsPerSec}  ok=${accepted} inflight=${inflight}` +
    `  done=${done} wait=${waiting} err=${errors}` +
    `  assign avg=${avgMs(assignLat)}ms p95=${pctl(assignLat, 0.95)}ms` +
    `  submit avg=${avgMs(submitLat)}ms p95=${pctl(submitLat, 0.95)}ms p99=${pctl(submitLat, 0.99)}ms`
  );
}, 2000);

// ── shutdown ──────────────────────────────────────────────────────────────────
function shutdown() {
  clearInterval(ramp); clearInterval(report);
  const summary = {
    opened,
    peakLive: live,
    closed,
    errors,
    wsConnErr: errors,
    httpOpened: 0,
    httpOk: 0,
    httpErr: 0,
    refOk: 0,
    refErr: 0,
    sent: submits,
    accepted,
    rejected,
    inflight,
    waited: waiting,
    done,
    assignAvg: Number(avgMs(assignLat)),
    assignP95: pctl(assignLat, 0.95),
    assignP99: pctl(assignLat, 0.99),
    assignSamples: assignLat.length,
    submitAvg: Number(avgMs(submitLat)),
    submitP95: pctl(submitLat, 0.95),
    submitP99: pctl(submitLat, 0.99),
    submitSamples: submitLat.length,
    handshakeAvg: 0,
    handshakeP95: 0,
    handshakeP99: 0,
    firstTileAvg: 0,
    firstTileP95: 0,
    firstTileP99: 0,
  };
  console.log('\n─── final summary ───────────────────────────────────────────');
  console.log(`connections  opened=${opened}  peak-live≈${live}  closed=${closed}  errors=${errors}`);
  console.log(`submissions  sent=${submits}  accepted=${accepted}  rejected=${rejected}  inflight=${inflight}`);
  console.log(`assignment   avg=${avgMs(assignLat)}ms  p95=${pctl(assignLat, 0.95)}ms  p99=${pctl(assignLat, 0.99)}ms  (${assignLat.length} samples)`);
  console.log(`submit       avg=${avgMs(submitLat)}ms  p95=${pctl(submitLat, 0.95)}ms  p99=${pctl(submitLat, 0.99)}ms  (${submitLat.length} samples)`);
  console.log(`SUMMARY_JSON ${JSON.stringify({ tester: 'loadtest', summary })}`);
  console.log('─────────────────────────────────────────────────────────────');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (DURATION) setTimeout(shutdown, DURATION * 1000);

console.log(`\nLoad test → ${target}`);
console.log(`clients=${CLIENTS}  rate=${RATE}/s  draw=${DRAW_MIN}–${DRAW_MAX}s  tiles=${TILES||'∞'}  hold=${HOLD}\n`);
console.log('Slice a TEST image on the admin first. Ctrl-C to stop.\n');
