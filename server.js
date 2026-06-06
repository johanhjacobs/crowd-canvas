import express from 'express';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import multer from 'multer';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes } from 'crypto';
import os from 'os';
import { Worker } from 'worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep Sharp single-threaded in the main process — render workers each get their own thread.
sharp.concurrency(1);

const RENDER_WORKERS = Math.max(1, Math.min(4, (os.availableParallelism?.() || 2) - 1));
const SUBMISSION_DB_FLUSH_MS = 80;

class RenderWorkerPool {
  constructor(size, workerPath) {
    this.nextId = 1;
    this.idle = [];
    this.queue = [];
    this.jobs = new Map();
    this.workers = [];
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerPath, { type: 'module' });
      worker.on('message', msg => this.handleMessage(worker, msg));
      worker.on('error', err => this.handleError(worker, err));
      worker.on('exit', code => {
        if (code !== 0) this.handleError(worker, new Error(`render worker exited with code ${code}`));
      });
      worker._busy = false;
      this.idle.push(worker);
      this.workers.push(worker);
    }
  }

  get pending() { return this.queue.length + this.jobs.size; }

  run(type, payload) {
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, type, payload, resolve, reject };
      this.queue.push(job);
      this.pump();
    });
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop();
      const job = this.queue.shift();
      worker._busy = true;
      worker._jobId = job.id;
      this.jobs.set(job.id, { worker, resolve: job.resolve, reject: job.reject });
      worker.postMessage({ id: job.id, type: job.type, ...job.payload });
    }
  }

  finishWorker(worker) {
    worker._busy = false;
    worker._jobId = null;
    this.idle.push(worker);
    this.pump();
  }

  handleMessage(worker, msg) {
    const job = this.jobs.get(msg.id);
    if (!job) return;
    this.jobs.delete(msg.id);
    this.finishWorker(worker);
    if (!msg.ok) { job.reject(new Error(msg.error || 'render worker failed')); return; }
    job.resolve(msg);
  }

  handleError(worker, error) {
    if (worker._jobId && this.jobs.has(worker._jobId)) {
      const job = this.jobs.get(worker._jobId);
      this.jobs.delete(worker._jobId);
      job.reject(error);
    }
    this.finishWorker(worker);
  }
}

const renderPool = new RenderWorkerPool(
  RENDER_WORKERS,
  path.join(__dirname, 'render-worker.js')
);
console.log(`[render] ${RENDER_WORKERS} render worker(s) started`);

const HOT_QUEUE_SOFT_LIMIT = 400;

// ── session-level render tracking ─────────────────────────────────────────────
let sessionEpoch = 0;
let pendingSubmissionRenders = 0;
const tileRenderChains = new Map(); // tileId → latest render promise (sequential per tile)
const autoFillTimers = new Set();

function hotPathDepth() {
  return renderPool.pending + (submissionWriteQueue?.length || 0);
}
function isHotPathBusy() {
  return hotPathDepth() >= HOT_QUEUE_SOFT_LIMIT;
}

// ── PNG helpers ───────────────────────────────────────────────────────────────
function pngInputToBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input.replace(/^data:[^;]+;base64,/, ''), 'base64');
  return Buffer.from(input);
}
function pngBufferToDataUrl(buf) {
  return 'data:image/png;base64,' + buf.toString('base64');
}

function clearAutoFillTimers() {
  for (const timer of autoFillTimers) clearTimeout(timer);
  autoFillTimers.clear();
}

function bumpSessionEpoch() {
  sessionEpoch++;
  submissionWriteQueue = [];
  pendingSubmissionRenders = 0;
  tileRenderChains.clear();
  if (submissionFlushTimer) { clearTimeout(submissionFlushTimer); submissionFlushTimer = null; }
  clearAutoFillTimers();
}

async function waitForRenderDrain() {
  while (tileRenderChains.size || pendingSubmissionRenders > 0 || renderPool.pending > 0) {
    const pending = [...tileRenderChains.values()];
    if (pending.length) await Promise.allSettled(pending);
    else await new Promise(r => setTimeout(r, 20));
  }
  await flushSubmissionWrites();
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// ── admin token ───────────────────────────────────────────────────────────────
// Set ADMIN_TOKEN in your environment (ecosystem.config.cjs or shell).
// Without it the API is unprotected — fine for local dev, not for production.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) console.warn('[security] ADMIN_TOKEN not set — admin API is open to everyone');

// Random view path — regenerated on every server restart.
// Only the admin panel shows it, so it stays secret without any password prompt.
const VIEW_PATH = '/dropveters-view';

// Pre-inject token into trusted HTML pages at startup so the browser never
// has to know the token directly — it's baked in server-side.
function buildHtml(filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  if (ADMIN_TOKEN) {
    html = html.replace('</head>', `<script>window._AT='${ADMIN_TOKEN}';</script></head>`);
  }
  return html;
}
const adminHtml = buildHtml(path.join(__dirname, 'public', 'admin.html'));
const viewHtml  = buildHtml(path.join(__dirname, 'public', 'view.html'));
const DATA = path.join(__dirname, 'data');
const REFS = path.join(DATA, 'refs');
const FINAL_VIEW = path.join(DATA, 'final-view.png');
fs.mkdirSync(REFS, { recursive: true });
let finalViewPng = null;
let finalViewThumbPng = null; // downscaled preview for the player done screen

const MIN_TILE = 16; // minimum tile size in pixels
const MIN_SIZE = 1024; // smallest base resolution (for tiny uploads)
// SIZE and ANALYZE are computed per-upload in slice() from the actual image dimensions

// next power of 2 ≥ n — ensures quadtree always halves cleanly
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

const db = new Database(path.join(DATA, 'crowd.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created INTEGER, size INTEGER, redundancy INTEGER DEFAULT 3);
  CREATE TABLE IF NOT EXISTS tiles(id TEXT PRIMARY KEY, session TEXT, x INTEGER, y INTEGER, sz INTEGER, blank INTEGER DEFAULT 0, fill INTEGER DEFAULT 255);
  CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, tile TEXT, png TEXT, created INTEGER);
  CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX IF NOT EXISTS idx_sub_tile ON submissions(tile);
`);
try { db.exec('ALTER TABLE tiles ADD COLUMN blank INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE tiles ADD COLUMN fill INTEGER DEFAULT 255'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN redundancy INTEGER DEFAULT 3'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN img_w INTEGER DEFAULT 1024'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN img_h INTEGER DEFAULT 1024'); } catch {}

// ── batched submission writes ─────────────────────────────────────────────────
const insertSubmissionStmt = db.prepare('INSERT INTO submissions(id,tile,png,created) VALUES(?,?,?,?)');
const insertSubmissionBatch = db.transaction(rows => {
  for (const row of rows) insertSubmissionStmt.run(row.id, row.tile, row.png, row.created);
});
let submissionWriteQueue = [];
let submissionFlushTimer = null;
let submissionFlushPromise = null;

function scheduleSubmissionFlush(delay = SUBMISSION_DB_FLUSH_MS) {
  if (submissionFlushTimer) return;
  submissionFlushTimer = setTimeout(() => {
    submissionFlushTimer = null;
    flushSubmissionWrites().catch(console.error);
  }, delay);
}

function queueSubmissionWrite(row) {
  submissionWriteQueue.push(row);
  scheduleSubmissionFlush();
}

async function flushSubmissionWrites() {
  if (submissionFlushTimer) { clearTimeout(submissionFlushTimer); submissionFlushTimer = null; }
  if (submissionFlushPromise) {
    await submissionFlushPromise;
    if (!submissionWriteQueue.length) return 0;
  }
  if (!submissionWriteQueue.length) return 0;
  const rows = submissionWriteQueue.splice(0, submissionWriteQueue.length);
  submissionFlushPromise = Promise.resolve().then(() => {
    insertSubmissionBatch(rows);
    return rows.length;
  }).finally(() => { submissionFlushPromise = null; });
  return submissionFlushPromise;
}

// ── config ────────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  inkColor: '#000000',
  paperColor: '#ffffff',
  canvasColor: '#f3ede1',
  blendMode: 'blend',    // 'blend' | 'random' | 'first'
  blendGamma: 1.71,
  liveMinPixelVotes: 0,   // live view only: hide pixels drawn by <= this many players
  sendColor: '#e0512f',
  admitRate: 500,             // new players admitted per second (connection queue drain rate)
  rateLimit: 10,              // minimum seconds between submissions per player (0=off)
  ghostMode: 'attempt',      // 'attempt' = show after first failed try | 'immediate' = show right away
  similarityThreshold: 0.35, // recall threshold 0=off; 0.25 works well for most images
  maxStrayInk: 1.5,          // max ink in deep-white reference areas on a 32x32 grid
  minCoverage: 0.60,         // min fraction of the reference ink the player must cover (0=off)
  viewSidebarWidth: 27,      // big-screen sidebar width as a % of screen width
  viewBgColor:   '#000000',  // free background colour for the view screen
  viewTextColor: '#ffffff',  // sidebar text / border colour
  viewTileColor:  '#000000', // colour of empty (undrawn) tiles on the view screen
  viewInkColor:   '#000000', // colour mapped to the darkest pixel in drawn tiles
  viewPaperColor: '#ffffff', // colour mapped to the lightest pixel in drawn tiles
  viewSidebarOn: false,      // whether the sidebar is visible on the big screen
  defaultPieces: 120,        // last-used slice piece count — restored in admin UI
  defaultIncludeSolidBlack: false, // last-used includeSolidBlack flag
};
let _configCache = null;
function getConfig() {
  if (_configCache) return _configCache;
  const row = db.prepare("SELECT value FROM config WHERE key='main'").get();
  _configCache = row ? { ...DEFAULT_CONFIG, ...JSON.parse(row.value) } : { ...DEFAULT_CONFIG };
  return _configCache;
}
function saveConfig(obj) {
  _configCache = null;
  db.prepare("INSERT OR REPLACE INTO config(key,value) VALUES('main',?)").run(JSON.stringify(obj));
}

function invalidateFinalView() {
  finalViewPng = null;
  finalViewThumbPng = null;
  try { fs.rmSync(FINAL_VIEW, { force: true }); } catch {}
}

// ── in-memory session state ───────────────────────────────────────────────────
let state = null;



function loadActive() {
  const s = db.prepare('SELECT * FROM sessions ORDER BY created DESC LIMIT 1').get();
  if (!s) { state = null; return; }
  const tiles = db.prepare('SELECT * FROM tiles WHERE session=?').all(s.id);
  const map = new Map(), blanks = [];
  for (const t of tiles) {
    if (t.blank) blanks.push({ x: t.x, y: t.y, sz: t.sz, fill: t.fill ?? 255 });
    else map.set(t.id, { ...t, assigned: 0 });
  }
  const blendedPngs = new Map(), livePngs = new Map(), tileVersions = new Map(), tileResetTokens = new Map();
  for (const [id] of map) {
    blendedPngs.set(id, null);
    livePngs.set(id, undefined); // undefined = not rendered yet; null = no submissions
    tileVersions.set(id, 0);
    tileResetTokens.set(id, 0);
  }

  // rebuild submission counts from DB
  const submissionCounts = new Map();
  for (const [id] of map) submissionCounts.set(id, 0);
  const rows = db.prepare('SELECT tile, COUNT(*) n FROM submissions GROUP BY tile').all();
  for (const r of rows) if (submissionCounts.has(r.tile)) submissionCounts.set(r.tile, r.n);

  const redundancy = s.redundancy || 3;
  const done = map.size > 0 && [...submissionCounts.values()].every(n => n >= redundancy);
  const imgW = s.img_w || 1024;
  const imgH = s.img_h || 1024;

  // shuffle tile ids once — round-robin through this order so the mosaic
  // lights up scattered/organic rather than top-left to bottom-right
  const tileIds = [...map.keys()];
  for (let i = tileIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tileIds[i], tileIds[j]] = [tileIds[j], tileIds[i]];
  }

  state = { id: s.id, size: s.size, redundancy, tiles: map, blanks, blendedPngs, livePngs, tileVersions, tileResetTokens,
            epoch: sessionEpoch,
            submissionCounts, done, imgW, imgH,
            tileIds,       // shuffled order — never changes
            deckPos: 0,    // round-robin pointer into tileIds
            activeCount: new Map(), // tileId → how many players currently drawing it
            autoFilledTiles: new Set(), // tiles filled by autoFillAndFinish — bypass live filter
            // Incremental blend accumulators — { count, inkSum: Float32Array(256*256) }
            // One decode per new submission instead of re-decoding all N each time.
            accumulators: new Map(),
          };
}
loadActive();
rebuildAccumulatorsFromDB().catch(console.error); // no-op if no session; matters on crash-restart

// ── slicer ────────────────────────────────────────────────────────────────────
async function slice(buffer, pieces, redundancy, includeSolidBlack = false) {
  // measure original so we can preserve the aspect ratio
  const { width: origW, height: origH } = await sharp(buffer).metadata();

  // size = next power of 2 ≥ longest edge, minimum MIN_SIZE
  // powers of 2 ensure the quadtree always halves into clean integer coordinates
  const size = Math.max(nextPow2(Math.max(origW, origH)), MIN_SIZE);
  const analyze = size / 4; // analysis buffer; keeps f=0.25 → same per-pixel accuracy at any size

  const scale = size / Math.max(origW, origH);
  const imgW = Math.min(size, Math.round(origW * scale));
  const imgH = Math.min(size, Math.round(origH * scale));

  // resize into size×size with content anchored top-left; padding area scores near-zero → blank
  const base = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .resize(size, size, { fit: 'contain', position: 'left top', background: '#ffffff' })
    .toFormat('png').toBuffer();

  const { data, info } = await sharp(base)
    .resize(analyze, analyze, { fit: 'fill' })
    .grayscale().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const f = analyze / size;

  function score(c) {
    const sx = Math.floor(c.x * f), sy = Math.floor(c.y * f);
    const ss = Math.max(1, Math.round(c.sz * f));
    let ink = 0, tot = 0;
    for (let yy = sy; yy < sy + ss && yy < analyze; yy++)
      for (let xx = sx; xx < sx + ss && xx < analyze; xx++) {
        tot++; if (data[(yy * analyze + xx) * ch] < 128) ink++;
      }
    if (!tot) return 0;
    const p = ink / tot;
    return 4 * p * (1 - p) * c.sz;
  }

  // average darkness: 0 = white, 1 = black (continuous, for fill colour)
  function avgDark(c) {
    const sx = Math.floor(c.x * f), sy = Math.floor(c.y * f);
    const ss = Math.max(1, Math.round(c.sz * f));
    let sum = 0, tot = 0;
    for (let yy = sy; yy < sy + ss && yy < analyze; yy++)
      for (let xx = sx; xx < sx + ss && xx < analyze; xx++) {
        tot++; sum += 255 - data[(yy * analyze + xx) * ch]; // 0=white, 255=black
      }
    return tot ? sum / (tot * 255) : 0;
  }

  let leaves = [{ x: 0, y: 0, sz: size }];
  const target = Math.max(1, (pieces | 0) || 64); // no upper cap — limited naturally by image size and MIN_TILE
  while (leaves.length < target) {
    let bi = -1, bs = 0;
    for (let i = 0; i < leaves.length; i++) {
      if (leaves[i].sz <= MIN_TILE) continue;
      const s = score(leaves[i]);
      if (s > bs) { bs = s; bi = i; }
    }
    if (bi < 0 || bs <= 0) break;
    const c = leaves[bi], h = c.sz / 2;
    leaves.splice(bi, 1,
      { x: c.x, y: c.y, sz: h }, { x: c.x + h, y: c.y, sz: h },
      { x: c.x, y: c.y + h, sz: h }, { x: c.x + h, y: c.y + h, sz: h });
  }

  // tag blanks: rely on the score formula — 4·p·(1-p) ≈ 0 means the tile is
  // essentially uniform. nearlyUniform threshold was removed; it incorrectly
  // filtered tiles with thin lines (e.g. 3% dark pixels = valid content).
  leaves = leaves.map(c => {
    const dark = avgDark(c);
    const isBlank = score(c) < 0.01 * c.sz && !(includeSolidBlack && dark > 0.5);
    return { ...c, blank: isBlank ? 1 : 0, fill: Math.round((1 - dark) * 255) };
  });

  // persist
  db.exec('DELETE FROM submissions; DELETE FROM tiles; DELETE FROM sessions;');
  invalidateFinalView();
  fs.rmSync(REFS, { recursive: true, force: true }); fs.mkdirSync(REFS, { recursive: true });
  // Save a normalised copy of the original for re-slicing.
  // We preserve the 16:9 (or whatever) aspect ratio and cap at 4096px on the
  // longest side — enough for any quadtree slice, and keeps the file a few MB
  // even when the source is 4K or 8K.  Raw 8K PNGs can be 100 MB+; this isn't.
  const RESLICE_MAX = 4096;
  const resliceScale = Math.min(1, RESLICE_MAX / Math.max(origW, origH));
  const resliceW = Math.max(1, Math.round(origW * resliceScale));
  const resliceH = Math.max(1, Math.round(origH * resliceScale));
  // Grayscale + max compression: B&W line art at 4K is typically 1–3 MB this way.
  const originalSave = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize(resliceW, resliceH, { fit: 'fill' })
    .png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(path.join(DATA, 'original.png'), originalSave);
  fs.writeFileSync(path.join(DATA, 'base.png'), base); // kept for overlay generation

  const id = randomUUID();
  db.prepare('INSERT INTO sessions(id,created,size,redundancy,img_w,img_h) VALUES(?,?,?,?,?,?)').run(id, Date.now(), size, (redundancy | 0) || 3, imgW, imgH);
  const insT = db.prepare('INSERT INTO tiles(id,session,x,y,sz,blank,fill) VALUES(?,?,?,?,?,?,?)');

  for (const c of leaves) {
    const tid = randomUUID();
    insT.run(tid, id, c.x, c.y, c.sz, c.blank, c.fill ?? 255);
    if (!c.blank) {
      // clamp extract to base image bounds and extend with white if tile crosses edge
      const maxX = size, maxY = size;
      const eW = Math.min(c.sz, maxX - c.x);
      const eH = Math.min(c.sz, maxY - c.y);
      let ref;
      if (eW <= 0 || eH <= 0) {
        ref = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#ffffff' } }).png().toBuffer();
      } else if (eW < c.sz || eH < c.sz) {
        ref = await sharp(base)
          .extract({ left: c.x, top: c.y, width: eW, height: eH })
          .extend({ top: 0, left: 0, right: c.sz - eW, bottom: c.sz - eH, background: '#ffffff' })
          .resize(256, 256, { fit: 'fill' }).png().toBuffer();
      } else {
        ref = await sharp(base)
          .extract({ left: c.x, top: c.y, width: c.sz, height: c.sz })
          .resize(256, 256, { fit: 'fill' }).png().toBuffer();
      }
      fs.writeFileSync(path.join(REFS, tid + '.png'), ref);
    }
  }
  loadActive();
  rebuildAccumulatorsFromDB().catch(console.error);
  seedPngCache = exportPngCache = null; // new session — old caches invalid
  const nonBlank = leaves.filter(l => !l.blank).length;
  return { id, tiles: leaves.length, active: nonBlank, blank: leaves.length - nonBlank };
}

// ── submission processing ─────────────────────────────────────────────────────
// Blank detection, deep-white stray-ink detection and the similarity score all
// run on the player's phone now (see player.html → getSimilarityScore). The
// server no longer re-checks submissions, which removes per-submission image
// decoding here and the client/server "green tick then rejected" disagreement.

async function blendTile(tileId, opts = {}) {
  const subs = db.prepare('SELECT png FROM submissions WHERE tile=? ORDER BY created').all(tileId);
  if (!subs.length) return null;
  const cfg = getConfig();
  const liveMinPixelVotes = opts.liveView ? Math.max(0, Math.min(5, cfg.liveMinPixelVotes | 0)) : 0;

  const decode = async (png64) => {
    const buf = Buffer.from(png64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    const { data, info } = await sharp(buf)
      .flatten({ background: '#ffffff' })
      .grayscale().resize(256, 256, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    return { data, ch: info.channels };
  };

  if (cfg.blendMode === 'first') {
    return Buffer.from(subs[0].png.replace(/^data:[^;]+;base64,/, ''), 'base64');
  }
  if (cfg.blendMode === 'random') {
    const s = subs[Math.floor(Math.random() * subs.length)];
    return Buffer.from(s.png.replace(/^data:[^;]+;base64,/, ''), 'base64');
  }

  // per-pixel blend with gamma curve
  const N = subs.length, W = 256, H = 256;
  const acc = new Float32Array(W * H);
  const votes = liveMinPixelVotes > 0 ? new Uint8Array(W * H) : null;
  for (const sub of subs) {
    const { data, ch } = await decode(sub.png);
    for (let i = 0; i < W * H; i++) {
      const ink = (255 - data[i * ch]) / 255;
      acc[i] += ink;
      if (votes && ink > 0.08) votes[i]++;
    }
  }
  const gamma = cfg.blendGamma || 1.71;
  const out = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) {
    if (votes && votes[i] <= liveMinPixelVotes) {
      out[i] = 255;
      continue;
    }
    const f = Math.min(1, acc[i] / N);
    const curved = 1 - Math.pow(1 - f, gamma);
    out[i] = Math.round((1 - curved) * 255);
  }
  return sharp(out, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}

// ── incremental blend accumulator ─────────────────────────────────────────────
// Problem: blendTile() re-decodes ALL N submissions every time a new one arrives.
// At 600 submissions/second with redundancy 5, that's 1500+ Sharp decodes/second
// AND 600+ synchronous SQLite reads per second — enough to saturate the event loop.
//
// Solution: keep a Float32Array inkSum per tile in RAM.
// Each new submission costs exactly ONE Sharp decode.  The rest is arithmetic.
//
// Memory ceiling: 5000 tiles × 256×256 × 4 bytes ≈ 1.3 GB — fine on 128 GB server.
// The accumulator is rebuilt from the DB on server restart (one-time async cost).

async function decodePngToInk(input) {
  const result = await renderPool.run('decode-png-to-ink', { input: pngInputToBuffer(input) });
  return new Float32Array(result.inkBuffer);
}

// Merge one new submission into the tile accumulator and return { blended, live } PNGs.
async function accumulatorAdd(tileId, pngBuf) {
  if (!state) return null;
  const ink = await decodePngToInk(pngBuf);
  let acc = state.accumulators.get(tileId);
  if (!acc) {
    acc = { count: 0, inkSum: new Float32Array(256 * 256) };
    state.accumulators.set(tileId, acc);
  }
  for (let i = 0; i < 256 * 256; i++) acc.inkSum[i] += ink[i];
  acc.count++;
  const cfg = getConfig();
  const liveMin = Math.max(0, Math.min(5, cfg.liveMinPixelVotes | 0));
  const gamma = cfg.blendGamma || 1.71;
  const inkSumCopy = acc.inkSum.slice().buffer;
  const result = await renderPool.run('render-accumulator-pair', {
    inkSumBuffer: inkSumCopy, count: acc.count, gamma, liveMin,
  });
  return { blended: Buffer.from(result.fullPng), live: Buffer.from(result.livePng) };
}

// Render a blended PNG from an accumulator — offloaded to a render worker.
async function renderAccumulator(acc, opts = {}) {
  if (!acc || acc.count === 0) return null;
  const cfg = getConfig();
  const gamma = cfg.blendGamma || 1.71;
  const liveMin = opts.liveView ? Math.max(0, Math.min(5, cfg.liveMinPixelVotes | 0)) : 0;
  const inkSumCopy = acc.inkSum.slice().buffer;
  const result = await renderPool.run('render-accumulator-pair', {
    inkSumBuffer: inkSumCopy, count: acc.count, gamma, liveMin,
  });
  return opts.liveView ? Buffer.from(result.livePng) : Buffer.from(result.fullPng);
}

// Rebuild accumulators from the DB — called once on startup / after a new session.
// Skip if session is already done — accumulators are only needed for new submissions.
async function rebuildAccumulatorsFromDB() {
  if (!state) return;
  if (state.done) {
    console.log('[accumulator] session done — skipping rebuild (blended PNGs built on demand)');
    return;
  }
  let rebuilt = 0;
  for (const [id] of state.tiles) {
    const subs = db.prepare('SELECT png FROM submissions WHERE tile=? ORDER BY created').all(id);
    if (!subs.length) continue;
    const acc = { count: 0, inkSum: new Float32Array(256 * 256) };
    for (const sub of subs) {
      const ink = await decodePngToInk(sub.png);
      for (let i = 0; i < 256 * 256; i++) acc.inkSum[i] += ink[i];
      acc.count++;
      await new Promise(r => setImmediate(r)); // yield after every submission
    }
    state.accumulators.set(id, acc);
    const blended = await renderAccumulator(acc);
    if (blended) {
      state.blendedPngs.set(id, blended);
      state.livePngs.set(id, await renderAccumulator(acc, { liveView: true }));
    }
    rebuilt++;
  }
  if (rebuilt) console.log(`[accumulator] rebuilt ${rebuilt} tiles from DB`);
}


async function liveTileUpdate(tileId, t, extra = {}) {
  const live = await getLiveTilePng(tileId);
  if (!live) return { type: 'tile-cleared', tileId, x: t.x, y: t.y, sz: t.sz, ...extra };
  const version = (state?.tileVersions.get(tileId) || 0) + 1;
  state?.tileVersions.set(tileId, version);
  return {
    type: 'tile-update',
    tileId,
    x: t.x,
    y: t.y,
    sz: t.sz,
    version,
    ...extra
  };
}

function livePixelFilterLevel() {
  return Math.max(0, Math.min(5, getConfig().liveMinPixelVotes | 0));
}

async function renderLiveTilePng(tileId, adminBlend = null) {
  if (!state || (state.submissionCounts.get(tileId) || 0) <= 0) return null;
  if (livePixelFilterLevel() === 0) {
    const blended = adminBlend || state.blendedPngs.get(tileId);
    if (blended) return blended;
  }
  return blendTile(tileId, { liveView: true });
}

async function getLiveTilePng(tileId) {
  if (!state || !state.tiles.has(tileId)) return null;
  const cached = state.livePngs.get(tileId);
  if (cached !== undefined) return cached;

  // Auto-filled tiles should always show their reference image regardless of the
  // live pixel filter (there are no real submissions to vote pixels into visibility).
  if (state.autoFilledTiles.has(tileId)) {
    const buf = state.blendedPngs.get(tileId) || null;
    state.livePngs.set(tileId, buf);
    return buf;
  }

  const live = await renderLiveTilePng(tileId);
  state.livePngs.set(tileId, live);
  return live;
}

async function rebuildLivePngs() {
  if (!state) return;
  for (const id of state.tiles.keys()) state.livePngs.set(id, undefined);
  for (const [id] of state.tiles) {
    if ((state.submissionCounts.get(id) || 0) > 0) await getLiveTilePng(id);
    await new Promise(r => setImmediate(r));
  }
}

async function buildFinalViewImage() {
  if (!state) return null;
  const { imgW: iW = 1024, imgH: iH = 1024 } = state;
  const comps = [];
  for (const b of state.blanks) {
    if (b.x >= iW || b.y >= iH) continue; // skip padding-area blanks
    const v = (b.fill ?? 255) > 127 ? 255 : 0;
    const buf = await sharp({ create: { width: b.sz, height: b.sz, channels: 3, background: { r: v, g: v, b: v } } }).png().toBuffer();
    comps.push({ input: buf, left: b.x, top: b.y });
  }
  for (const [id, t] of state.tiles) {
    if (t.x >= iW || t.y >= iH) continue; // skip padding-area tiles
    const buf = await getLiveTilePng(id);
    if (!buf) continue;
    const img = await sharp(buf).resize(t.sz, t.sz, { fit: 'fill' }).toBuffer();
    comps.push({ input: img, left: t.x, top: t.y });
  }
  const base = sharp({ create: { width: iW, height: iH, channels: 3, background: viewBgColor || '#000000' } });
  const composite = await (comps.length ? base.composite(comps).png().toBuffer() : base.png().toBuffer());
  // resize to original image dimensions
  const origPath = path.join(DATA, 'original.png');
  if (fs.existsSync(origPath)) {
    const { width: origW, height: origH } = await sharp(origPath).metadata();
    if (origW && origH && (origW !== iW || origH !== iH)) {
      return sharp(composite).resize(origW, origH, { fit: 'fill' }).png().toBuffer();
    }
  }
  return composite;
}

// Promise locks — at most one build of each image type runs at a time.
// Without this, 20k phones requesting the thumb simultaneously would each
// start their own buildExportPng(), spiking CPU and memory.
let _finalViewBuilding = null;
let _exportBuilding    = null;
let exportThumbCache   = null;

async function ensureFinalViewImage() {
  if (finalViewPng) return finalViewPng;
  if (fs.existsSync(FINAL_VIEW)) {
    finalViewPng = fs.readFileSync(FINAL_VIEW);
    return finalViewPng;
  }
  if (!_finalViewBuilding) {
    _finalViewBuilding = buildFinalViewImage()
      .then(out => {
        _finalViewBuilding = null;
        if (!out) return null;
        fs.writeFileSync(FINAL_VIEW, out);
        finalViewPng = out;
        return out;
      })
      .catch(e => { _finalViewBuilding = null; throw e; });
  }
  return _finalViewBuilding;
}

async function ensureExportPng() {
  if (exportPngCache) return exportPngCache;
  if (!_exportBuilding) {
    _exportBuilding = buildExportPng()
      .then(out => {
        _exportBuilding = null;
        exportPngCache = out;
        return out;
      })
      .catch(e => { _exportBuilding = null; throw e; });
  }
  return _exportBuilding;
}

async function ensureExportThumb() {
  if (exportThumbCache) return exportThumbCache;
  const full = await ensureExportPng();
  if (!full) return null;
  exportThumbCache = await sharp(full).resize({ width: 512, withoutEnlargement: true }).png().toBuffer();
  return exportThumbCache;
}

// small preview (≤512px) for the done screen so 20k phones don't each pull the full image
async function ensureFinalViewThumb() {
  if (finalViewThumbPng) return finalViewThumbPng;
  const full = await ensureFinalViewImage();
  if (!full) return null;
  finalViewThumbPng = await sharp(full).resize({ width: 512, withoutEnlargement: true }).png().toBuffer();
  return finalViewThumbPng;
}

let viewDelay = 0;
const pendingViewTimers = new Map(); // tileId → setTimeout handle (admin delay)

// ── admin tile-update queue ───────────────────────────────────────────────────
// At 340 submissions/second each broadcastAdmins call serialises ~50KB of PNG.
// Deduplicate by tileId and flush every 200ms so the event loop stays free.
const adminUpdateQueue = new Map(); // tileId → latest msg
let adminFlushTimer = null;

function flushAdminQueue() {
  adminFlushTimer = null;
  if (!admins.size) { adminUpdateQueue.clear(); return; }
  for (const msg of adminUpdateQueue.values()) broadcastAdmins(msg);
  adminUpdateQueue.clear();
}

function enqueueAdminTileUpdate(msg) {
  adminUpdateQueue.set(msg.tileId, msg);
  if (!adminFlushTimer) adminFlushTimer = setTimeout(flushAdminQueue, 200);
}

// ── view update queue ─────────────────────────────────────────────────────────
// At 600 submissions/second every submission would push a 20 KB PNG to the view
// screen — 12 MB/s to a browser canvas that can only render ~60 frames/second.
// Solution: deduplicate by tileId and flush at most every 50 ms (≈20 fps).
// If tile X gets 10 submissions in one 50 ms window, the view only sees 1 update.
const viewUpdateQueue = new Map(); // tileId → latest msg
let viewFlushTimer    = null;

function flushViewQueue() {
  viewFlushTimer = null;
  if (viewMode === 'paused' || viewMode === 'hold') { viewUpdateQueue.clear(); return; }
  for (const msg of viewUpdateQueue.values()) broadcastViews(msg);
  viewUpdateQueue.clear();
}

function enqueueViewUpdate(msg) {
  if (viewMode === 'paused' || viewMode === 'hold') return;
  viewUpdateQueue.set(msg.tileId, msg); // newer submission overwrites older for same tile
  if (!viewFlushTimer) viewFlushTimer = setTimeout(flushViewQueue, 200);
}

// schedule a view update: goes through the 20fps queue, with optional admin delay on top.
function scheduleViewUpdate(msg) {
  if (viewMode === 'paused' || viewMode === 'hold') return;
  const key = msg.tileId;
  if (pendingViewTimers.has(key)) clearTimeout(pendingViewTimers.get(key));
  if (!viewDelay) { enqueueViewUpdate(msg); return; }
  const timer = setTimeout(() => {
    pendingViewTimers.delete(key);
    if (viewMode !== 'paused') enqueueViewUpdate(msg);
  }, viewDelay * 1000);
  pendingViewTimers.set(key, timer);
}

// ── background reblend ────────────────────────────────────────────────────────
// For 'blend' mode: re-render from in-memory accumulators (no DB reads, very fast).
// For 'first'/'random' modes: fall back to blendTile() which reads from DB.
async function reblendAll() {
  if (!state) return;
  const cfg = getConfig();
  for (const [id, t] of state.tiles) {
    if ((state.submissionCounts.get(id) || 0) < 1) continue;
    let blended;
    if (cfg.blendMode === 'blend' && state.accumulators.has(id)) {
      blended = await renderAccumulator(state.accumulators.get(id));
    } else {
      blended = await blendTile(id);
    }
    if (!blended) continue;
    state.blendedPngs.set(id, blended);
    state.livePngs.set(id, cfg.blendMode === 'blend' && state.accumulators.has(id)
      ? await renderAccumulator(state.accumulators.get(id), { liveView: true })
      : await renderLiveTilePng(id, blended));
    const png = 'data:image/png;base64,' + blended.toString('base64');
    enqueueAdminTileUpdate({ type: 'tile-update', tileId: id, x: t.x, y: t.y, sz: t.sz, png, subs: state.submissionCounts.get(id) || 0 });
    scheduleViewUpdate(await liveTileUpdate(id, t));
    await new Promise(r => setImmediate(r));
  }
  scheduleSeedRebuild(); // blend settings changed — all tiles rerendered
}


function assignTile(hasSubmitted = false) {
  if (!state || state.done) return null;
  const { tiles, tileIds, submissionCounts, activeCount, redundancy } = state;
  const n = tileIds.length;

  // Walk the shuffled deck starting from deckPos.
  // Skip tiles that are: (a) already at submission cap,
  //                      (b) already have redundancy active drawers right now, or
  //                      (c) solid black (fill===0) for players on their first tile —
  //                          they haven't seen how the game works yet.
  for (let i = 0; i < n; i++) {
    const idx = (state.deckPos + i) % n;
    const id  = tileIds[idx];
    const t   = tiles.get(id);
    const subs   = submissionCounts.get(id) || 0;
    const active = activeCount.get(id) || 0;
    if (subs >= redundancy) continue;
    if (active >= redundancy) continue;
    if (!hasSubmitted && t.fill === 0) continue; // first-timer — skip solid black
    state.deckPos = (idx + 1) % n;
    activeCount.set(id, active + 1);
    return t;
  }

  // All preferred tiles done or occupied — fall back to any incomplete tile.
  // This also covers the edge case where only black tiles remain: a first-timer
  // gets one rather than waiting forever.
  for (let i = 0; i < n; i++) {
    const id = tileIds[(state.deckPos + i) % n];
    if ((submissionCounts.get(id) || 0) < redundancy) {
      const active = activeCount.get(id) || 0;
      activeCount.set(id, active + 1);
      return tiles.get(id);
    }
  }

  return null; // genuinely complete
}

// ── submission queue ──────────────────────────────────────────────────────────
// Sharp blending is CPU-intensive. Processing submissions inline in the WebSocket
// handler means a burst of simultaneous submissions saturates the libuv thread pool.
// Solution: queue submissions and process CONCURRENCY items in parallel — matching
// UV_THREADPOOL_SIZE so all threads stay busy without over-queuing.
// ── per-tile render pipeline ───────────────────────────────────────────────────
// Each tile has its own promise chain so renders are sequential per tile but
// parallel across tiles. Epoch + resetToken checks prevent stale renders from
// writing results after a session reset.

async function processSubmissionRender(job) {
  if (!state || state.epoch !== job.epoch || !state.tiles.has(job.tileId)) return;
  if ((state.tileResetTokens.get(job.tileId) || 0) !== job.resetToken) return;

  const cfg = getConfig();
  let blended, live;
  if (cfg.blendMode === 'blend') {
    const rendered = await accumulatorAdd(job.tileId, job.pngBuf);
    if (!rendered) return;
    blended = rendered.blended;
    live = rendered.live;
  } else {
    blended = await blendTile(job.tileId);
    if (!blended) return;
    live = await renderLiveTilePng(job.tileId, blended);
  }

  if (!state || state.epoch !== job.epoch || !state.tiles.has(job.tileId)) return;
  if ((state.tileResetTokens.get(job.tileId) || 0) !== job.resetToken) return;

  state.blendedPngs.set(job.tileId, blended);
  state.livePngs.set(job.tileId, live);
  const t = state.tiles.get(job.tileId);
  enqueueAdminTileUpdate({ type: 'tile-update', tileId: job.tileId, x: t.x, y: t.y, sz: t.sz, png: pngBufferToDataUrl(blended), subs: state.submissionCounts.get(job.tileId) || 0 });
  scheduleViewUpdate(await liveTileUpdate(job.tileId, t));
  broadcastStats();
  scheduleSeedRebuild();
}

function scheduleSubmissionRender(job) {
  pendingSubmissionRenders++;
  const prev = tileRenderChains.get(job.tileId) || Promise.resolve();
  let current;
  current = prev.catch(() => {}).then(async () => {
    try {
      await processSubmissionRender(job);
    } finally {
      pendingSubmissionRenders = Math.max(0, pendingSubmissionRenders - 1);
      if (tileRenderChains.get(job.tileId) === current) tileRenderChains.delete(job.tileId);
    }
  });
  tileRenderChains.set(job.tileId, current);
  current.catch(console.error);
}

// ── http ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/refs', express.static(REFS, { maxAge: '1h' }));
const noCache = (_, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

// ── auth middleware ───────────────────────────────────────────────────────────
// Public GET endpoints (players need these — no token required):
const PUBLIC_API = new Set(['/config', '/export.png', '/export-thumb.png', '/seed.png']);
app.use('/api', (req, res, next) => {
  if (!ADMIN_TOKEN) return next(); // no token set → dev mode, allow all
  if (req.method === 'GET' && PUBLIC_API.has(req.path)) return next();
  if (req.method === 'GET' && req.path.startsWith('/live-tile/')) return next();
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/',                 noCache, (_, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/dropveters-admin', noCache, (_, res) => res.type('html').send(adminHtml));
app.get(VIEW_PATH,           noCache, (_, res) => res.type('html').send(viewHtml));

// 150 MB covers an uncompressed 8K B&W PNG; typical line-art files are far smaller.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });
app.post('/api/session', upload.single('image'), async (req, res) => {
  try {
    let buffer;
    if (req.file) {
      buffer = req.file.buffer;
    } else {
      // No new file — re-use the original upload (not base.png, which is already
      // squared/padded and would lose the original aspect ratio on re-slice).
      const prevPath = path.join(DATA, 'original.png');
      if (!fs.existsSync(prevPath)) return res.status(400).json({ error: 'no image uploaded and no previous image found' });
      buffer = fs.readFileSync(prevPath);
    }
    const pieces = parseInt(req.body.pieces, 10) || 64;
    const redundancy = parseInt(req.body.redundancy, 10) || 3;
    const includeSolidBlack = req.body.includeSolidBlack === 'true' || req.body.includeSolidBlack === true;
    // Persist slice settings so admin UI restores them after a server restart
    saveConfig({ ...getConfig(), defaultPieces: pieces, defaultIncludeSolidBlack: includeSolidBlack });
    bumpSessionEpoch();
    const r = await slice(buffer, pieces, redundancy, includeSolidBlack);
    broadcastAdmins({ type: 'reset', ...adminState() });
    broadcastViews({ type: 'reset', ...viewInitData() });
    releaseWaitingPlayers();
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
});

// Restart the game with the same tiles — wipes all submissions, resets state,
// reshuffles the deck.  No re-upload or re-slice needed.
app.post('/api/session/restart', (_, res) => {
  if (!state) return res.status(404).json({ error: 'no active session' });
  bumpSessionEpoch();
  db.prepare('DELETE FROM submissions').run();
  for (const id of state.tiles.keys()) {
    state.submissionCounts.set(id, 0);
    state.blendedPngs.set(id, null);
    state.livePngs.set(id, null);
    state.tileVersions.set(id, 0);
    state.tileResetTokens.set(id, (state.tileResetTokens.get(id) || 0) + 1);
  }
  state.accumulators.clear();
  state.done       = false;
  state.deckPos    = 0;
  state.autoFilling = false;
  state.activeCount.clear();
  state.autoFilledTiles.clear();
  state.epoch = sessionEpoch;
  invalidateFinalView();
  // Reshuffle so the mosaic fills in a different scattered order each run
  for (let i = state.tileIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.tileIds[i], state.tileIds[j]] = [state.tileIds[j], state.tileIds[i]];
  }
  seedPngCache = exportPngCache = null; // wipe — canvas is blank after restart
  broadcastPlayers({ type: 'resume' });
  broadcastAdmins({ type: 'reset', ...adminState() });
  broadcastViews({ type: 'reset', ...viewInitData() });
  broadcastViews({ type: 'view-sync' });
  releaseWaitingPlayers();
  res.json({ ok: true, tiles: state.tiles.size });
});

app.post('/api/session/stop', async (_, res) => {
  if (!state) return res.status(404).json({ error: 'no active session' });
  try {
    await finishSession();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
});

app.post('/api/session/resume', (_, res) => {
  if (!state) return res.status(404).json({ error: 'no active session' });
  resumeSession();
  res.json({ ok: true });
});

app.post('/api/session/auto-finish', async (req, res) => {
  if (!state) return res.status(404).json({ error: 'no session' });
  if (state.done) return res.status(400).json({ error: 'already done' });
  if (state.autoFilling) return res.status(400).json({ error: 'auto-fill already running' });
  const duration = Math.max(1000, Math.min(60000, parseInt(req.body?.duration, 10) || 10000));
  const unfilled = [...state.tiles.keys()].filter(id => (state.submissionCounts.get(id) || 0) === 0).length;
  autoFillAndFinish(duration).catch(console.error);
  res.json({ ok: true, filling: unfilled, duration });
});

// /api/overlay.png — original image with tile boundaries drawn on top.
// Blank tiles: dashed grey border + light grey tint.
// Active tiles: solid accent-colour border, sized so smallest tiles are still visible.
// Served at 512×512 so borders render crisply at typical screen sizes.
app.get('/api/overlay.png', async (_, res) => {
  try {
    const basePath = path.join(DATA, 'base.png');
    if (!state || !fs.existsSync(basePath)) return res.status(404).end();
    const OV = 512;
    const imgW = state.imgW || 1024, imgH = state.imgH || 1024;
    const ovW = Math.round(OV * imgW / (state.size || 1024)), ovH = Math.round(OV * imgH / (state.size || 1024));
    const sc = OV / (state.size || 1024); // same scale for both axes
    const rects = [];
    for (const b of state.blanks) {
      if (b.x >= imgW || b.y >= imgH) continue; // skip padding-area blanks
      rects.push(`<rect x="${b.x*sc}" y="${b.y*sc}" width="${b.sz*sc}" height="${b.sz*sc}"
        fill="rgba(120,120,120,0.22)" stroke="#888" stroke-width="1.5" stroke-dasharray="5 3"/>`);
    }
    for (const t of state.tiles.values()) {
      if (t.x >= imgW || t.y >= imgH) continue; // skip padding-area tiles
      rects.push(`<rect x="${t.x*sc}" y="${t.y*sc}" width="${t.sz*sc}" height="${t.sz*sc}"
        fill="none" stroke="#e0512f" stroke-width="2"/>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ovW}" height="${ovH}" viewBox="0 0 ${ovW} ${ovH}">${rects.join('')}</svg>`;
    // scale the full 1024×1024 base to 512×512 (uniform, no distortion),
    // then crop the top-left content area — padding is on right/bottom so this is clean
    const base512 = await sharp(basePath)
      .resize(OV, OV, { fit: 'fill' })
      .extract({ left: 0, top: 0, width: ovW, height: ovH })
      .png().toBuffer();
    const out = await sharp(base512)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png().toBuffer();
    res.set('Cache-Control', 'no-store').type('png').send(out);
  } catch (e) { console.error(e); res.status(500).end(); }
});

// ── seed.png cache ────────────────────────────────────────────────────────────
// Building seed.png at full mosaic resolution (up to 4K = 3840×2160) is expensive:
// it composites every tile via Sharp, which can take 10–30 s for 5000 tiles.
// Solution: build it once asynchronously, cache in RAM, serve instantly.
// Invalidated whenever tile content changes; rebuilt after a 2 s quiet period.
let seedPngCache     = null;  // Buffer | null
let seedBuildPromise = null;  // shared promise so concurrent callers all wait for the same build
let seedRebuildTimer = null;

async function buildSeedPng() {
  if (seedBuildPromise) return seedBuildPromise;
  seedBuildPromise = _buildSeedPng().finally(() => { seedBuildPromise = null; });
  return seedBuildPromise;
}

async function _buildSeedPng() {
  try {
    if (!state) { seedPngCache = null; return; }
    const comps = [];
    for (const b of state.blanks) {
      const v = (b.fill ?? 255) > 127 ? 255 : 0;
      const buf = await sharp({
        create: { width: b.sz, height: b.sz, channels: 3, background: { r: v, g: v, b: v } }
      }).png().toBuffer();
      comps.push({ input: buf, left: b.x, top: b.y });
    }
    for (const [id, t] of state.tiles) {
      const buf = await getLiveTilePng(id);
      if (!buf) continue;
      const img = await sharp(buf).resize(t.sz, t.sz, { fit: 'fill' }).toBuffer();
      comps.push({ input: img, left: t.x, top: t.y });
      await new Promise(r => setImmediate(r)); // yield to event loop between tiles
    }
    const { imgW: iW = 1024, imgH: iH = 1024 } = state;
    // Transparent base — composited over the view's background colour in the browser
    const base = sharp({ create: { width: iW, height: iH, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } });
    seedPngCache = comps.length
      ? await base.composite(comps).png({ compressionLevel: 6 }).toBuffer()
      : await base.png().toBuffer();
    console.log(`[seed] built ${(seedPngCache.length/1024).toFixed(0)} KB  (${iW}×${iH})`);
  } catch (e) { console.error('[seed] build error', e); }
}

// Invalidate immediately (view will wait on next request), then rebuild after quiet period
function scheduleSeedRebuild(delay = 2000) {
  seedPngCache    = null;
  exportPngCache  = null; // export and seed share the same invalidation events
  exportThumbCache = null;
  if (seedRebuildTimer) clearTimeout(seedRebuildTimer);
  seedRebuildTimer = setTimeout(() => { seedRebuildTimer = null; buildSeedPng().catch(console.error); }, delay);
}

app.get('/api/seed.png', async (_, res) => {
  try {
    if (!state) return res.status(404).end();
    if (!seedPngCache) await buildSeedPng();   // first-time: wait for build
    if (seedBuildPromise && seedPngCache) {
      // build in progress but we have a previous version — serve stale immediately
    } else if (!seedPngCache) {
      return res.status(500).end();
    }
    // 5-second browser cache: players get a fresh seed on reload without hammering the server
    res.set('Cache-Control', 'public, max-age=5').type('png').send(seedPngCache);
  } catch (e) { console.error(e); res.status(500).end(); }
});

app.get('/api/live-tile/:id.png', async (req, res) => {
  try {
    const id = req.params.id;
    if (!state || !state.tiles.has(id)) return res.status(404).end();
    const buf = await getLiveTilePng(id);
    if (!buf) return res.status(404).end();
    // versioned URL (?v=N) — safe to cache; version bumps on every tile update
    res.set('Cache-Control', 'public, max-age=300').type('png').send(buf);
  } catch (e) { console.error(e); res.status(500).end(); }
});

app.get('/api/final-view.png', async (_, res) => {
  try {
    const out = await ensureFinalViewImage();
    if (!out) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=3600').type('png').send(out);
  } catch (e) { console.error(e); res.status(500).end(); }
});

app.get('/api/final-view-thumb.png', async (_, res) => {
  try {
    const out = await ensureFinalViewThumb();
    if (!out) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=3600').type('png').send(out);
  } catch (e) { console.error(e); res.status(500).end(); }
});


app.post('/api/config', (req, res) => {
  const cfg = { ...getConfig(), ...req.body };
  saveConfig(cfg);
  broadcastPlayers({ type: 'config', ...cfg });
  broadcastAdmins({ type: 'config', ...cfg });
  res.json(cfg);
  const blendChanged = req.body.blendMode !== undefined || req.body.blendGamma !== undefined;
  const liveFilterChanged = req.body.liveMinPixelVotes !== undefined;
  if (state && blendChanged) {
    reblendAll().then(() => {
      if (liveFilterChanged) broadcastViews({ type: 'view-sync' });
    }).catch(console.error);
  } else if (state && liveFilterChanged) {
    rebuildLivePngs().then(() => broadcastViews({ type: 'view-sync' })).catch(console.error);
  }
});

app.get('/api/config', (_, res) => res.json(getConfig()));
app.get('/api/has-previous-image', (_, res) => res.json({ exists: fs.existsSync(path.join(DATA, 'original.png')) }));
app.get('/api/state', (_, res) => res.json(adminState()));

// return submissions for a tile so admin can review them before clearing
app.get('/api/tile/:id/submissions', (req, res) => {
  const id = req.params.id;
  if (!state || !state.tiles.has(id)) return res.status(404).json([]);
  const rows = db.prepare('SELECT id, png FROM submissions WHERE tile=? ORDER BY created').all(id);
  res.json(rows);
});

// delete a single submission — reblends the tile with what remains
app.post('/api/submission/:id/delete', (req, res) => {
  const subId = req.params.id;
  const sub = db.prepare('SELECT tile FROM submissions WHERE id=?').get(subId);
  if (!sub || !state || !state.tiles.has(sub.tile)) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM submissions WHERE id=?').run(subId);
  const newCount = Math.max(0, (state.submissionCounts.get(sub.tile) || 0) - 1);
  state.submissionCounts.set(sub.tile, newCount);
  state.tileResetTokens.set(sub.tile, (state.tileResetTokens.get(sub.tile) || 0) + 1);
  if (state.done && newCount < (state.redundancy || 3)) {
    state.done = false;
    invalidateFinalView();
    broadcastAdmins({ type: 'incomplete' });
  }
  const t = state.tiles.get(sub.tile);
  // cancel any pending delayed view update — the bad drawing must not appear after the delay
  if (pendingViewTimers.has(sub.tile)) {
    clearTimeout(pendingViewTimers.get(sub.tile));
    pendingViewTimers.delete(sub.tile);
  }
  res.json({ ok: true, remaining: newCount });
  // Reblend async and broadcast.  Also rebuild the accumulator from the remaining
  // submissions (we can't subtract from a sum — must reconstruct from scratch).
  // Admin action → rare → DB reads here are fine.
  blendTile(sub.tile).then(async blended => {
    // Rebuild accumulator from whatever submissions remain
    const remaining = db.prepare('SELECT png FROM submissions WHERE tile=? ORDER BY created').all(sub.tile);
    if (remaining.length === 0) {
      state.accumulators.delete(sub.tile);
    } else {
      const acc = { count: 0, inkSum: new Float32Array(256 * 256) };
      for (const s of remaining) {
        const ink = await decodePngToInk(s.png);
        for (let i = 0; i < 256 * 256; i++) acc.inkSum[i] += ink[i];
        acc.count++;
      }
      state.accumulators.set(sub.tile, acc);
    }

    if (blended) {
      state.blendedPngs.set(sub.tile, blended);
      state.livePngs.set(sub.tile, await renderLiveTilePng(sub.tile, blended));
      const png = 'data:image/png;base64,' + blended.toString('base64');
      broadcastAdmins({ type: 'tile-update', tileId: sub.tile, x: t.x, y: t.y, sz: t.sz, png, subs: newCount });
      broadcastViews(await liveTileUpdate(sub.tile, t)); // admin action — always immediate
    } else {
      state.blendedPngs.set(sub.tile, null);
      state.livePngs.set(sub.tile, null);
      broadcastAdmins({ type: 'tile-cleared', tileId: sub.tile, x: t.x, y: t.y, sz: t.sz });
      broadcastViews({ type: 'tile-cleared', tileId: sub.tile, x: t.x, y: t.y, sz: t.sz }); // admin action — always immediate
    }
    scheduleSeedRebuild(500); // admin action — rebuild quickly
    broadcastStats();
  }).catch(console.error);
});
app.post('/api/tile/:id/clear', (req, res) => {
  const id = req.params.id;
  if (!state || !state.tiles.has(id)) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM submissions WHERE tile=?').run(id);
  state.submissionCounts.set(id, 0);
  state.blendedPngs.set(id, null);
  state.livePngs.set(id, null);
  state.accumulators.delete(id);
  state.tileResetTokens.set(id, (state.tileResetTokens.get(id) || 0) + 1);
  scheduleSeedRebuild(500); // admin action — rebuild quickly
  if (state.done) {
    state.done = false; // reopen the game if it had completed
    invalidateFinalView();
    broadcastAdmins({ type: 'incomplete' });
  }
  const t = state.tiles.get(id);
  // cancel any pending delayed update — cleared tile should not appear after the delay
  if (pendingViewTimers.has(id)) { clearTimeout(pendingViewTimers.get(id)); pendingViewTimers.delete(id); }
  const msg = { type: 'tile-cleared', tileId: id, x: t.x, y: t.y, sz: t.sz };
  broadcastAdmins(msg);
  broadcastViews(msg); // admin action — always immediate, regardless of hold/delay
  broadcastStats();
  res.json({ ok: true });
});
// export.png cache — white-background full mosaic, used by admin panel and download button.
// Same caching strategy as seed.png: build once, serve instantly, invalidate on tile changes.
let exportPngCache = null;

async function buildExportPng() {
  if (!state) return null;
  const { imgW: iW = 1024, imgH: iH = 1024 } = state;
  const comps = [];
  for (const b of state.blanks) {
    if (b.x >= iW || b.y >= iH) continue; // skip padding-area blanks
    const v = (b.fill ?? 255) > 127 ? 255 : 0; // fill: 255=white area, 0=black area
    if (v === 255) continue; // white blank → white base already covers it
    const solidBuf = await sharp({ create: { width: b.sz, height: b.sz, channels: 3, background: { r: v, g: v, b: v } } }).png().toBuffer();
    comps.push({ input: solidBuf, left: b.x, top: b.y });
  }
  for (const [id, t] of state.tiles) {
    if (t.x >= iW || t.y >= iH) continue; // skip padding-area tiles
    let buf = state.blendedPngs.get(id);
    if (!buf) { const r = await blendTile(id); if (r) { buf = r; state.blendedPngs.set(id, r); } }
    if (!buf) continue; // undrawn → stays white (background)
    const img = await sharp(buf).resize(t.sz, t.sz, { fit: 'fill' }).toBuffer();
    comps.push({ input: img, left: t.x, top: t.y });
    await new Promise(r => setImmediate(r));
  }
  const composite = await sharp({ create: { width: iW, height: iH, channels: 3, background: '#ffffff' } })
    .composite(comps).png({ compressionLevel: 6 }).toBuffer();
  // resize to original image dimensions so the download matches the uploaded file's shape
  const origPath = path.join(DATA, 'original.png');
  if (fs.existsSync(origPath)) {
    const { width: origW, height: origH } = await sharp(origPath).metadata();
    if (origW && origH && (origW !== iW || origH !== iH)) {
      return sharp(composite).resize(origW, origH, { fit: 'fill' }).png({ compressionLevel: 6 }).toBuffer();
    }
  }
  return composite;
}

app.get('/api/export.png', async (_, res) => {
  try {
    if (!state) return res.status(404).end();
    const buf = await ensureExportPng();
    if (!buf) return res.status(500).end();
    res.type('png').send(buf);
  } catch (e) { console.error(e); res.status(500).end(); }
});

app.get('/api/export-thumb.png', async (_, res) => {
  try {
    if (!state) return res.status(404).end();
    const buf = await ensureExportThumb();
    if (!buf) return res.status(500).end();
    res.set('Cache-Control', 'no-store').type('png').send(buf);
  } catch (e) { console.error(e); res.status(500).end(); }
});

function adminState() {
  if (!state) return { active: false, viewPath: VIEW_PATH };
  const subs = db.prepare('SELECT tile, COUNT(*) n FROM submissions GROUP BY tile').all();
  const cnt = new Map(subs.map(s => [s.tile, s.n]));
  return {
    active: true, done: state.done, size: state.size, redundancy: state.redundancy, imgW: state.imgW, imgH: state.imgH,
    waitingCount: waiting.size, viewMode, viewDelay, viewSidebarWidth, viewPath: VIEW_PATH,
    tiles: [...state.tiles.values()].map(t => ({ id: t.id, x: t.x, y: t.y, sz: t.sz, subs: cnt.get(t.id) || 0 })),
    blanks: state.blanks,
  };
}

function viewInitData() {
  const colors = { bgColor: viewBgColor, textColor: viewTextColor, tileColor: viewTileColor, inkColor: viewInkColor, paperColor: viewPaperColor };
  if (!state) return { active: false, ...colors };
  return { active: true, size: state.size, imgW: state.imgW, imgH: state.imgH,
           blanks: state.blanks, sidebar: viewSidebar,
           sidebarWidth: viewSidebarWidth, ...colors };
}

function completionStats() {
  if (!state) return { counted: 0, required: 0, coverage: 0 };
  const redundancy = state.redundancy || 3;
  const required = state.tiles.size * redundancy;
  let counted = 0;
  for (const n of state.submissionCounts.values()) counted += Math.min(n || 0, redundancy);
  return {
    counted,
    required,
    coverage: required > 0 ? Math.round(100 * counted / required) : 0
  };
}

// ── websockets ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
// 400 KB covers a 256×256 PNG submission with room to spare.
// Without this a single malformed client can allocate arbitrary RAM.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 400 * 1024 });
const admins = new Set(), views = new Set(), players = new Set();
const waiting = new Map(); // ws → give() — players held in waiting room

const bcast = (set, obj) => { const s = JSON.stringify(obj); for (const ws of set) if (ws.readyState === 1) ws.send(s); };
const broadcastAdmins  = o => bcast(admins, o);
const broadcastViews   = o => bcast(views, o);
const broadcastPlayers = o => bcast(players, o);

// open the game: release all waiting players in batches to keep event loop responsive
function releaseWaitingPlayers(batchSize = 200) {
  if (!waiting.size) return;
  const queued = [...waiting.entries()];
  let i = 0;
  const step = () => {
    let n = 0;
    while (i < queued.length && n < batchSize) {
      const [ws, give] = queued[i++];
      waiting.delete(ws);
      if (ws.readyState === 1) give();
      n++;
    }
    broadcastAdmins({ type: 'waiting-count', count: waiting.size });
    if (i < queued.length) setTimeout(step, 10);
  };
  step();
}

async function finishSession() {
  if (!state || state.done) return;
  state.done = true;
  for (const t of pendingViewTimers.values()) clearTimeout(t);
  pendingViewTimers.clear();

  // Tell everyone immediately — don't make 20k phones wait 30 s for a 4K image build.
  broadcastAdmins({ type: 'done' });
  broadcastPlayers({ type: 'done' });
  broadcastStats();

  // Drain pending renders first, then build final images.
  waitForRenderDrain()
    .then(() => ensureExportPng())
    .then(() => ensureExportThumb())
    .then(() => buildSeedPng())          // seed must be complete before view-sync
    .then(() => ensureFinalViewImage())
    .then(() => {
      broadcastViews({ type: 'view-sync' }); // view now loads the complete seed
      broadcastViews({ type: 'done' });
      broadcastAdmins({ type: 'final-ready' });
    })
    .catch(console.error);
}

// Gradually fill all undrawn tiles with their reference images over durationMs,
// then call finishSession(). Gives the big screen a smooth animated reveal.
// Tiles are processed in small batches to avoid spiking memory and the event loop.
async function autoFillAndFinish(durationMs = 10000) {
  if (!state || state.done || state.autoFilling) return;
  state.autoFilling = true;

  // Only fill tiles that have never been submitted
  const remaining = [];
  for (const [id, t] of state.tiles) {
    if ((state.submissionCounts.get(id) || 0) === 0) remaining.push({ id, t });
  }

  if (!remaining.length) {
    state.autoFilling = false;
    await finishSession();
    return;
  }

  // Shuffle for a scattered organic fill rather than top-left → bottom-right
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }

  // Process in small batches: load each ref image only when its batch fires,
  // so we never hold thousands of image buffers in memory at once.
  const BATCH = 5;                          // tiles per tick
  const totalBatches = Math.ceil(remaining.length / BATCH);
  const batchInterval = durationMs / totalBatches;

  for (let b = 0; b < totalBatches; b++) {
    const timer = setTimeout(async () => {
      autoFillTimers.delete(timer);
      if (!state) return;
      const slice = remaining.slice(b * BATCH, (b + 1) * BATCH);
      for (const { id, t } of slice) {
        let buf;
        try { buf = await fs.promises.readFile(path.join(REFS, id + '.png')); }
        catch { continue; }
        const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
        state.blendedPngs.set(id, buf);
        state.livePngs.set(id, buf);
        state.submissionCounts.set(id, 1);
        state.autoFilledTiles.add(id);
        const afVersion = (state.tileVersions.get(id) || 0) + 1;
        state.tileVersions.set(id, afVersion);
        broadcastAdmins({ type: 'tile-update', tileId: id, x: t.x, y: t.y, sz: t.sz, png: dataUrl, subs: 1 });
        enqueueViewUpdate({ type: 'tile-update', tileId: id, x: t.x, y: t.y, sz: t.sz, version: afVersion });
      }
    }, Math.round(b * batchInterval));
    autoFillTimers.add(timer);
  }

  // Officially close the game once the fill animation is done.
  // Do NOT call scheduleSeedRebuild — finishSession rebuilds seed, export, and
  // final-view in sequence, preventing concurrent Sharp spikes.
  setTimeout(async () => {
    if (state) state.autoFilling = false;
    seedPngCache = exportPngCache = exportThumbCache = null; // invalidate stale caches
    await finishSession();
  }, durationMs + 300);
}

// reopen a stopped/finished game: clear the final image and pull players back in
function resumeSession() {
  if (!state) return;
  state.done = false;
  invalidateFinalView();
  broadcastAdmins({ type: 'incomplete' });
  broadcastPlayers({ type: 'resume' }); // players hide the "done" screen and request a tile
  broadcastStats();
}

let viewMode        = 'live';
let viewSidebarWidth = getConfig().viewSidebarWidth || 27;
let viewBgColor     = getConfig().viewBgColor      || '#000000';
let viewTextColor   = getConfig().viewTextColor    || '#ffffff';
let viewTileColor   = getConfig().viewTileColor    || '#000000';
let viewInkColor    = getConfig().viewInkColor     || '#000000';
let viewPaperColor  = getConfig().viewPaperColor   || '#ffffff';
let viewSidebar     = !!getConfig().viewSidebarOn; // persisted — survives restart

// ── stats broadcast (throttled) ──────────────────────────────────────────────
let _playerCountTimer = null;
function broadcastPlayerCount() {
  if (_playerCountTimer) return;
  _playerCountTimer = setTimeout(() => {
    _playerCountTimer = null;
    broadcastAdmins({ type: 'player-count', count: players.size });
  }, 500);
}

let _statsTimer = null;
function broadcastStats() {
  if (_statsTimer) return;
  _statsTimer = setTimeout(() => {
    _statsTimer = null;
    if (!state) return;
    const { coverage } = completionStats();
    broadcastViews({ type: 'stats', players: players.size, coverage });
  }, 1200);
}

app.post('/api/view/sidebar', (req, res) => {
  viewSidebar = !!req.body.on;
  saveConfig({ ...getConfig(), viewSidebarOn: viewSidebar });
  broadcastViews({ type: 'view-sidebar', on: viewSidebar });
  broadcastAdmins({ type: 'view-sidebar', on: viewSidebar });
  res.json({ ok: true, on: viewSidebar });
});

app.post('/api/view/background', (_, res) => {
  [viewBgColor, viewTextColor] = [viewTextColor, viewBgColor];
  saveConfig({ ...getConfig(), viewBgColor, viewTextColor, viewTileColor, viewInkColor, viewPaperColor });
  invalidateFinalView(); // bg color changed — regenerate final image on next request
  const msg = { type: 'view-colors', bg: viewBgColor, text: viewTextColor, tile: viewTileColor, ink: viewInkColor, paper: viewPaperColor };
  broadcastViews(msg);
  broadcastAdmins(msg);
  res.json({ ok: true, bg: viewBgColor, text: viewTextColor, tile: viewTileColor, ink: viewInkColor, paper: viewPaperColor });
});

app.post('/api/view/sidebar-width', (req, res) => {
  viewSidebarWidth = Math.max(10, Math.min(50, parseInt(req.body.width, 10) || 27));
  saveConfig({ ...getConfig(), viewSidebarWidth }); // persist as the standing default
  broadcastViews({ type: 'view-sidebar-width', width: viewSidebarWidth });
  broadcastAdmins({ type: 'view-sidebar-width', width: viewSidebarWidth });
  res.json({ ok: true, width: viewSidebarWidth });
});

app.post('/api/view/colors', (req, res) => {
  const hex = v => /^#[0-9a-f]{6}$/i.test(v) ? v : null;
  if (hex(req.body.bg))   { viewBgColor   = req.body.bg;   }
  if (hex(req.body.text)) { viewTextColor = req.body.text; }
  if (hex(req.body.tile))  { viewTileColor  = req.body.tile;  }
  if (hex(req.body.ink))   { viewInkColor   = req.body.ink;   }
  if (hex(req.body.paper)) { viewPaperColor = req.body.paper; }
  saveConfig({ ...getConfig(), viewBgColor, viewTextColor, viewTileColor, viewInkColor, viewPaperColor });
  // Final view image bakes in the bg color — invalidate so next download uses new color
  if (hex(req.body.bg)) invalidateFinalView();
  const msg = { type: 'view-colors', bg: viewBgColor, text: viewTextColor, tile: viewTileColor, ink: viewInkColor, paper: viewPaperColor };
  broadcastViews(msg);
  broadcastAdmins(msg);
  res.json({ ok: true, bg: viewBgColor, text: viewTextColor, tile: viewTileColor, ink: viewInkColor, paper: viewPaperColor });
});

app.post('/api/view/delay', (req, res) => {  viewDelay = Math.max(0, Math.min(120, parseInt(req.body.delay, 10) || 0));
  broadcastAdmins({ type: 'view-delay', delay: viewDelay });
  res.json({ ok: true, delay: viewDelay });
});
app.post('/api/view/mode', (req, res) => {
  const prevMode = viewMode;
  viewMode = ['paused','hold'].includes(req.body.mode) ? req.body.mode : 'live';

  if (viewMode !== 'live') {
    // cancel all pending delayed updates when entering hold/blank
    // so old timers can't fire and override admin's intent
    for (const t of pendingViewTimers.values()) clearTimeout(t);
    pendingViewTimers.clear();
    // also drain the 20fps queue so nothing sneaks through after the mode change
    if (viewFlushTimer) { clearTimeout(viewFlushTimer); viewFlushTimer = null; }
    viewUpdateQueue.clear();
  }

  broadcastViews({ type: 'view-mode', mode: viewMode });
  broadcastAdmins({ type: 'view-mode', mode: viewMode });

  if (prevMode !== 'live' && viewMode === 'live') {
    // switching back to live: reseed so the view catches up with
    // everything that happened (and was cleaned up) during hold/blank
    broadcastViews({ type: 'view-sync' });
  }

  res.json({ ok: true, mode: viewMode });
});

// push current server state to view: cancel pending delays, reseed, paused→hold
app.post('/api/view/sync', (_, res) => {
  for (const t of pendingViewTimers.values()) clearTimeout(t);
  pendingViewTimers.clear();
  if (viewMode === 'paused') viewMode = 'hold'; // push removes blank screen
  broadcastViews({ type: 'view-sync' });
  broadcastAdmins({ type: 'view-mode', mode: viewMode });
  res.json({ ok: true });
});



// ── heartbeat ─────────────────────────────────────────────────────────────────
// At 20k connections, phones that go to sleep or lose signal stay in the Sets
// forever without this.  Ping every 30s; no pong = terminate immediately.
setInterval(() => {
  for (const ws of [...players, ...admins, ...views]) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

function setupAdminWS(ws, send) {
  admins.add(ws);
  send({ type: 'state', ...adminState() });
  send({ type: 'config', ...getConfig() });
  send({ type: 'view-path', path: VIEW_PATH });
  send({ type: 'view-sidebar-width', width: viewSidebarWidth });
  send({ type: 'view-colors', bg: viewBgColor, text: viewTextColor, tile: viewTileColor, ink: viewInkColor, paper: viewPaperColor });
  send({ type: 'view-sidebar', on: viewSidebar });
  ws.on('close', () => admins.delete(ws));
}

function setupViewWS(ws, send) {
  views.add(ws);
  send({ type: 'init', ...viewInitData() });
  send({ type: 'view-mode', mode: viewMode });
  send({ type: 'view-sidebar', on: viewSidebar });
  send({ type: 'view-sidebar-width', width: viewSidebarWidth });
  broadcastStats();
  ws.on('close', () => views.delete(ws));
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const role = new URL(req.url, 'http://x').searchParams.get('role');
  const send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

  if (role === 'admin' || role === 'view') {
    if (!ADMIN_TOKEN) {
      // No token configured (dev mode) — connect immediately
      role === 'admin' ? setupAdminWS(ws, send) : setupViewWS(ws, send);
      return;
    }
    // Require token as first message; close if wrong or nothing arrives within 5 s
    const t = setTimeout(() => ws.terminate(), 5000);
    ws.once('message', raw => {
      clearTimeout(t);
      let m; try { m = JSON.parse(raw); } catch { ws.terminate(); return; }
      if (m.type !== 'auth' || m.token !== ADMIN_TOKEN) { ws.terminate(); return; }
      role === 'admin' ? setupAdminWS(ws, send) : setupViewWS(ws, send);
    });
    return;
  }

  // player
  players.add(ws);
  broadcastPlayerCount();
  broadcastStats();
  send({ type: 'config', ...getConfig() });

  let currentTileId = null; // tile this player is currently holding
  let submittedCount = 0;   // successful submissions — gates solid black tiles

  function releaseCurrentTile() {
    if (currentTileId && state && state.activeCount) {
      const n = state.activeCount.get(currentTileId) || 0;
      if (n > 0) state.activeCount.set(currentTileId, n - 1);
    }
    currentTileId = null;
  }

  const give = () => {
    if (state && state.done) { send({ type: 'done' }); return; }
    if (isHotPathBusy()) { send({ type: 'wait' }); return; }
    releaseCurrentTile();
    const t = assignTile(submittedCount > 0); // only veterans get solid black tiles
    if (!t) { send({ type: 'wait' }); return; }
    currentTileId = t.id;
    ws._tileReceivedAt = Date.now();
    send({ type: 'tile', tileId: t.id, refUrl: '/refs/' + t.id + '.png', fill: t.fill ?? 255 });
  };

  // always give a tile if a session is active
  if (state && state.done) {
    send({ type: 'done' }); // game finished — no point queuing them
  } else if (state && !state.done) {
    give(); // give tile immediately; isHotPathBusy() provides backpressure if server is overloaded
  } else {
    waiting.set(ws, give);
    send({ type: 'waiting' });
    broadcastAdmins({ type: 'waiting-count', count: waiting.size });
  }

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'next') {
      // Rate-limit abandonment: if the player already holds a tile and is skipping it,
      // enforce an 8-second cooldown. Auto-next after a successful submission is fine
      // (currentTileId is already null by then because releaseCurrentTile was called).
      if (currentTileId) {
        const now = Date.now();
        if (ws._lastAbandon && now - ws._lastAbandon < 5000) return; // silently drop
        ws._lastAbandon = now;
      }
      waiting.delete(ws);
      if (state && state.done) {
        send({ type: 'done' });
      } else if (state && !state.done) {
        give();
      } else {
        waiting.set(ws, give);
        send({ type: 'waiting' });
        broadcastAdmins({ type: 'waiting-count', count: waiting.size });
      }
      return;
    }

    if (m.type === 'submit' && m.tileId && m.png && state && state.tiles.has(m.tileId)) {
      // 1) Tile ownership — player must hold the tile they're submitting for.
      if (m.tileId !== currentTileId) return;

      // 2) Rate limit: accept the submission (quality already verified) but delay next tile.
      const now = Date.now();
      const rateLimitMs = (getConfig().rateLimit || 0) * 1000;
      const elapsed = now - (ws._tileReceivedAt || 0);
      const rateLimitWait = (rateLimitMs > 0 && elapsed < rateLimitMs)
        ? Math.ceil((rateLimitMs - elapsed) / 1000)
        : 0;

      // 3) Payload size sanity.
      if (typeof m.png !== 'string' || m.png.length > 350_000) return;

      // 4) PNG magic byte check — rejects non-image payloads without a Sharp decode.
      const rawBuf = pngInputToBuffer(m.png);
      if (rawBuf.length < 4 ||
          rawBuf[0] !== 0x89 || rawBuf[1] !== 0x50 ||
          rawBuf[2] !== 0x4e || rawBuf[3] !== 0x47) return; // not a PNG

      queueSubmissionWrite({ id: randomUUID(), tile: m.tileId, png: m.png, created: Date.now() });

      const newCount = (state.submissionCounts.get(m.tileId) || 0) + 1;
      state.submissionCounts.set(m.tileId, newCount);
      submittedCount++;
      releaseCurrentTile();
      send({ type: 'accepted', rateLimitSeconds: rateLimitWait });

      scheduleSubmissionRender({
        epoch: state.epoch,
        tileId: m.tileId,
        pngBuf: rawBuf,
        resetToken: state.tileResetTokens.get(m.tileId) || 0,
      });

      if (!state.done) {
        const redundancy = state.redundancy || 3;
        const complete = [...state.submissionCounts.values()].every(n => n >= redundancy);
        if (complete) finishSession().catch(console.error);
      }
    }
  });
  ws.on('close', () => {
    releaseCurrentTile(); // free the tile so another player can pick it up
    players.delete(ws);
    broadcastPlayerCount();
    broadcastStats();
    if (waiting.delete(ws)) broadcastAdmins({ type: 'waiting-count', count: waiting.size });
  });
});

// 3rd arg = listen backlog (accept queue depth). Default is 511, which overflows
// during a connection storm and resets incoming sockets (nginx logs them as
// upstream "connection reset by peer"). Capped by net.core.somaxconn, so raise that too.
server.listen(PORT, HOST, 65535, () => console.log(`crowd-canvas on ${HOST}:${PORT}`));
