#!/usr/bin/env node
//
// Crowd Canvas load tester — simulates many phones connecting, "drawing", and submitting.
//
//   node loadtest.js wss://draw.mmsparty.nl/ws [options]
//
// Options:
//   --clients N     total virtual players to open        (default 1000)
//   --rate R        new connections opened per second     (default 200)   -> crank up to mimic the QR scan storm
//   --draw-min S    min seconds "drawing" before a submit (default 4)
//   --draw-max S    max seconds "drawing" before a submit (default 20)
//   --tiles N       tiles each player draws, 0 = until done (default 3)
//   --hold false    close connections after finishing      (default keeps them open = realistic standing load)
//   --insecure      accept a self-signed / staging TLS cert
//   --duration S    auto-stop after S seconds              (default: run until Ctrl-C)
//
// BEFORE RUNNING: on the admin page, slice a TEST image (not your live event — this fills
// the mosaic with junk). Afterwards, re-slice / wipe data/ to reset.
//
// ON THE TEST MACHINE: raise the fd limit first ->  ulimit -n 100000
// One machine tops out around ~25-28k connections to a single server (ephemeral ports);
// for a true 20k+ run, launch this on 2-3 machines with --clients split between them.

import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
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

const CLIENTS  = +opt('clients', 1000);
const RATE     = +opt('rate', 200);
const DRAW_MIN = +opt('draw-min', 4);
const DRAW_MAX = +opt('draw-max', 20);
const TILES    = +opt('tiles', 3);
const HOLD     = opt('hold', 'true') !== 'false';
const INSECURE = !!opt('insecure', false);
const DURATION = +opt('duration', 0);

const target = url + (url.includes('?') ? '&' : '?') + 'role=player';
const PNG = 'data:image/png;base64,' + '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';

let opened = 0, live = 0, closed = 0, errors = 0;
let submits = 0, accepted = 0, rejected = 0, done = 0, waiting = 0, inflight = 0;
const lat = [];
const recordLat = ms => { lat.push(ms); if (lat.length > 4000) lat.shift(); };
const pctl = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rnd = (a, b) => a + Math.random() * (b - a);

function startClient() {
  let ws;
  try { ws = new WebSocket(target, { rejectUnauthorized: !INSECURE }); }
  catch { errors++; return; }
  opened++;
  let tilesDone = 0, sentAt = 0;
  const finish = () => { if (!HOLD) ws.close(); };

  ws.on('open', () => { live++; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'tile') {
      setTimeout(() => {
        if (ws.readyState !== 1) return;
        sentAt = Date.now(); inflight++; submits++;
        ws.send(JSON.stringify({ type: 'submit', tileId: m.tileId, png: PNG }));
      }, rnd(DRAW_MIN, DRAW_MAX) * 1000);
    } else if (m.type === 'accepted') {
      accepted++; inflight = Math.max(0, inflight - 1);
      if (sentAt) recordLat(Date.now() - sentAt);
      tilesDone++;
      if (TILES === 0 || tilesDone < TILES) {
        setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'next' })); }, rnd(0.5, 3) * 1000);
      } else finish();
    } else if (m.type === 'rejected') {
      rejected++; inflight = Math.max(0, inflight - 1);
      setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'next' })); }, 500);
    } else if (m.type === 'done') {
      done++; finish();
    } else if (m.type === 'wait' || m.type === 'waiting') {
      waiting++;
      setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'next' })); }, rnd(3, 6) * 1000);
    }
  });
  ws.on('close', () => { live = Math.max(0, live - 1); closed++; });
  ws.on('error', () => { errors++; });
}

let launched = 0;
const ramp = setInterval(() => {
  const n = Math.min(RATE, CLIENTS - launched);
  for (let i = 0; i < n; i++) startClient();
  launched += n;
  if (launched >= CLIENTS) clearInterval(ramp);
}, 1000);

const t0 = Date.now();
const avg = () => (lat.reduce((a, b) => a + b, 0) / (lat.length || 1)).toFixed(0);
const report = setInterval(() => {
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(
    `t=${secs}s  live=${live}/${launched}  submits=${submits} ok=${accepted} rej=${rejected} inflight=${inflight}` +
    `  done=${done} wait=${waiting} closed=${closed} err=${errors}  lat avg=${avg()}ms p95=${pctl(lat, 0.95)}ms`
  );
}, 2000);

function shutdown() {
  clearInterval(ramp); clearInterval(report);
  console.log(`\n— summary —`);
  console.log(`opened=${opened} live=${live} accepted=${accepted} rejected=${rejected} closed=${closed} errors=${errors}`);
  console.log(`submit latency  avg=${avg()}ms  p95=${pctl(lat, 0.95)}ms  p99=${pctl(lat, 0.99)}ms  (last ${lat.length} samples)`);
  process.exit(0);
}
process.on('SIGINT', shutdown);
if (DURATION) setTimeout(shutdown, DURATION * 1000);

console.log(`Load test -> ${target}`);
console.log(`clients=${CLIENTS} rate=${RATE}/s draw=${DRAW_MIN}-${DRAW_MAX}s tiles=${TILES} hold=${HOLD} insecure=${INSECURE}`);
console.log(`Slice a TEST image on the admin first. Watch htop + event-loop lag on the server. Ctrl-C to stop.\n`);
