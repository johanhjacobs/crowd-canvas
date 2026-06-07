#!/usr/bin/env node

import { spawn, execFile as execFileCb } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import readline from 'readline/promises';
import { monitorEventLoopDelay } from 'perf_hooks';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

function usage() {
  console.log(`Usage:
  node loadtest-matrix.js <ws-url> [options]
  node loadtest-matrix.js --url http://127.0.0.1:3000 [options]

Profiles:
  --profile matrix      Existing staged matrix runner (default)
  --profile smoke       Single small smoke run
  --profile event       Single realistic event run
  --profile breakpoint  Automatic break-point discovery
  --breakpoint          Shortcut for --profile breakpoint

General options:
  --url URL             Base app URL (http/https) or ws/wss endpoint
  --admin-token TOKEN   Bearer token for protected admin APIs (or use ADMIN_TOKEN env)
  --insecure            Accept self-signed TLS certs
  --output FILE         Write full run output to a specific file
  --yes                 Skip breakpoint confirmation prompt

Matrix / event options:
  --max-clients N       Highest client count to test (default 20000)
  --users N             User count for --profile smoke/event
  --rate N              Connection ramp per second for realistic stages (default 300)
  --storm-rate N        Connection ramp per second for storm stages (default 1000)
  --draw-min S          Minimum draw time in seconds (default 20)
  --draw-max S          Maximum draw time in seconds (default 40)
  --tiles N             Tiles per player, 0 = keep drawing (default 0)
  --keep-open false     Close connections after finishing in matrix mode (default true)
  --duration S          Explicit stage duration override

Session prep options:
  --image FILE
  --pieces N
  --redundancy N
  --include-solid-black
  --no-reset-each-stage
  --no-stop-on-fail
  --sweep FILE

Breakpoint options:
  --breakpoint-start N        Starting user count (default 100)
  --breakpoint-max N          Maximum user count to test (default 30000)
  --breakpoint-step N         Additive step once growth phase stabilizes (default 1000)
  --breakpoint-growth N       Multiplicative growth factor (default 2)
  --breakpoint-refine true    Refine between last-good and first-bad (default true)
  --breakpoint-refine-steps N Refinement attempts after first failure (default 3)
  --breakpoint-safe-margin F  Recommended safe fraction of lastGood (default 0.7)
  --ramp S                    Ramp duration in seconds for smoke/event/breakpoint (default 60)
  --hold S                    Hold duration in seconds for smoke/event/breakpoint (default 120)
  --cooldown S                Cooldown/recovery wait between breakpoint steps (default 30)
  --node-rss-max-mb N         Optional max Node RSS threshold for breakpoint mode

Examples:
  node loadtest-matrix.js ws://127.0.0.1:3000/ws --max-clients 20000
  ADMIN_TOKEN=xxx node loadtest-matrix.js --url http://127.0.0.1:3000 --profile breakpoint --breakpoint-max 30000 --yes
`);
}

const args = process.argv.slice(2);
function getOpt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const positionalTarget = args.find(arg => !arg.startsWith('--'));
const profile = args.includes('--breakpoint') ? 'breakpoint' : String(getOpt('profile', 'matrix'));
const rawTarget = String(getOpt('url', positionalTarget || ''));
if (!rawTarget || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(rawTarget ? 0 : 1);
}

function normalizeTargets(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    const wsUrl = new URL(parsed);
    if (!wsUrl.pathname || wsUrl.pathname === '/') wsUrl.pathname = '/ws';
    const httpUrl = new URL(wsUrl);
    httpUrl.protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
    return { wsUrl: wsUrl.toString(), apiBase: httpUrl };
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const apiBase = new URL(parsed);
    const wsUrl = new URL(parsed);
    wsUrl.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = '/ws';
    wsUrl.search = '';
    wsUrl.hash = '';
    return { wsUrl: wsUrl.toString(), apiBase };
  }
  throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
}

const { wsUrl: targetUrl, apiBase } = normalizeTargets(rawTarget);
const adminToken = String(getOpt('admin-token', process.env.ADMIN_TOKEN || ''));
const maxClients = Number(getOpt('max-clients', 20000));
const users = Number(getOpt('users', 0));
const realisticRate = Number(getOpt('rate', 300));
const stormRate = Number(getOpt('storm-rate', 1000));
const drawMin = Number(getOpt('draw-min', 20));
const drawMax = Number(getOpt('draw-max', 40));
const tiles = Number(getOpt('tiles', 0));
const keepOpenOpt = getOpt('keep-open', getOpt('hold', undefined));
const holdOpt = getOpt('hold', undefined);
const holdConnections = keepOpenOpt === undefined ? true : String(keepOpenOpt) !== 'false';
const explicitDuration = Number(getOpt('duration', 0));
const insecure = Boolean(getOpt('insecure', false));
const imagePath = getOpt('image', '');
const pieces = Number(getOpt('pieces', 400));
const redundancy = Number(getOpt('redundancy', 3));
const includeSolidBlack = Boolean(getOpt('include-solid-black', false));
const resetEachStage = !args.includes('--no-reset-each-stage');
const stopOnFail = !args.includes('--no-stop-on-fail');
const sweepFile = getOpt('sweep', '');
const outputFileArg = getOpt('output', '');
const yes = args.includes('--yes');

const breakpointStart = Number(getOpt('breakpoint-start', 100));
const breakpointMax = Number(getOpt('breakpoint-max', 30000));
const breakpointStep = Number(getOpt('breakpoint-step', 1000));
const breakpointGrowth = Number(getOpt('breakpoint-growth', 2));
const breakpointRefine = String(getOpt('breakpoint-refine', 'true')) !== 'false';
const breakpointRefineSteps = Number(getOpt('breakpoint-refine-steps', 3));
const breakpointSafeMargin = Number(getOpt('breakpoint-safe-margin', 0.7));
const rampSeconds = Number(getOpt('ramp', 60));
const holdSeconds = holdOpt === undefined || holdOpt === true || holdOpt === 'false'
  ? 120
  : Number(holdOpt);
const cooldownSeconds = Number(getOpt('cooldown', 30));
const nodeRssMaxMb = Number(getOpt('node-rss-max-mb', 0)) || Infinity;

const BREAKPOINT_THRESHOLDS = {
  connectionSuccessRate: 0.98,
  submissionSuccessRate: 0.95,
  disconnectRate: 0.02,
  errorRate: 0.01,
  assignmentP95Ms: 3000,
  submitP95Ms: 3000,
  cpuPct: 90,
  cpuSeconds: 15,
  memoryUsedPct: 85,
  nodeRssMaxMb,
  eventLoopP95Ms: 250,
  diskFreePct: 10,
};

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const runStamp = stamp();
const logsDir = path.join(process.cwd(), 'logs');
const reportsDir = path.join(process.cwd(), 'reports');
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(reportsDir, { recursive: true });
const outputFile = outputFileArg
  ? path.resolve(process.cwd(), String(outputFileArg))
  : path.join(logsDir, `loadtest-matrix-${runStamp}.log`);
const breakpointDir = path.join(reportsDir, `breakpoint-${runStamp}`);

const logStream = fs.createWriteStream(outputFile, { flags: 'a' });
function writeLog(text = '') { logStream.write(text); }
function echo(text = '') { process.stdout.write(text); writeLog(text); }
function echoLine(text = '') { echo(text + '\n'); }

function withAdminAuth(init = {}) {
  if (!adminToken) return init;
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${adminToken}`);
  return { ...init, headers };
}

function buildStages(limit) {
  const baseSizes = [200, 1000, 2000, 5000, 10000, 15000, 20000];
  const sizes = [...baseSizes];
  let nextSize = 30000;
  while (nextSize <= limit) {
    sizes.push(nextSize);
    nextSize += 10000;
  }
  if (!sizes.includes(limit)) {
    const lastSize = sizes[sizes.length - 1] ?? 0;
    if (limit > lastSize) sizes.push(limit);
  }
  const filteredSizes = sizes.filter(n => n <= limit);
  const stages = [];
  if (filteredSizes.length) {
    stages.push({
      name: 'smoke',
      clients: filteredSizes[0],
      rate: Math.min(100, realisticRate),
      duration: explicitDuration || 60,
      drawMin,
      drawMax,
      tiles: 3,
      hold: holdConnections,
    });
  }
  if (limit >= 2000) {
    stages.push({
      name: 'storm-2k',
      clients: Math.min(2000, limit),
      rate: stormRate,
      duration: 45,
      drawMin: 300,
      drawMax: 400,
      tiles: 0,
      hold: holdConnections,
    });
  }
  for (const n of filteredSizes) {
    if (n === filteredSizes[0]) continue;
    stages.push({
      name: `real-${n}`,
      clients: n,
      rate: realisticRate,
      duration: explicitDuration || (n >= 30000 ? 240 : n >= 10000 ? 180 : 120),
      drawMin,
      drawMax,
      tiles,
      hold: holdConnections,
    });
  }
  return stages;
}

function matrixSummaryDefaults() {
  return {
    opened: 0,
    peakLive: 0,
    closed: 0,
    errors: 0,
    sent: 0,
    accepted: 0,
    rejected: 0,
    inflight: 0,
    assignAvg: 0,
    assignP95: 0,
    assignP99: 0,
    assignSamples: 0,
    submitAvg: 0,
    submitP95: 0,
    submitP99: 0,
    submitSamples: 0,
    maxWait: 0,
    maxDone: 0,
    maxInflightObserved: 0,
    timeline: [],
  };
}

function parseSummary(output) {
  const summary = matrixSummaryDefaults();
  const connections = output.match(/connections\s+opened=(\d+)\s+peak-live≈(\d+)\s+closed=(\d+)\s+errors=(\d+)/);
  if (connections) {
    summary.opened = Number(connections[1]);
    summary.peakLive = Number(connections[2]);
    summary.closed = Number(connections[3]);
    summary.errors = Number(connections[4]);
  }
  const submissions = output.match(/submissions\s+sent=(\d+)\s+accepted=(\d+)\s+rejected=(\d+)\s+inflight=(\d+)/);
  if (submissions) {
    summary.sent = Number(submissions[1]);
    summary.accepted = Number(submissions[2]);
    summary.rejected = Number(submissions[3]);
    summary.inflight = Number(submissions[4]);
  }
  const assignment = output.match(/assignment\s+avg=(\d+)ms\s+p95=(\d+)ms\s+p99=(\d+)ms\s+\((\d+)\s+samples\)/);
  if (assignment) {
    summary.assignAvg = Number(assignment[1]);
    summary.assignP95 = Number(assignment[2]);
    summary.assignP99 = Number(assignment[3]);
    summary.assignSamples = Number(assignment[4]);
  }
  const submit = output.match(/submit\s+avg=(\d+)ms\s+p95=(\d+)ms\s+p99=(\d+)ms\s+\((\d+)\s+samples\)/);
  if (submit) {
    summary.submitAvg = Number(submit[1]);
    summary.submitP95 = Number(submit[2]);
    summary.submitP99 = Number(submit[3]);
    summary.submitSamples = Number(submit[4]);
  }

  for (const line of output.split('\n')) {
    const m = line.match(/t=(\d+)s\s+live=(\d+)\/(\d+)\s+sub\/s=([0-9.]+)\s+ok=(\d+)\s+inflight=(\d+)\s+done=(\d+)\s+wait=(\d+)\s+err=(\d+)\s+assign avg=(\d+)ms p95=(\d+)ms\s+submit avg=(\d+)ms p95=(\d+)ms p99=(\d+)ms/);
    if (!m) continue;
    const entry = {
      t: Number(m[1]),
      live: Number(m[2]),
      launched: Number(m[3]),
      subPerSec: Number(m[4]),
      ok: Number(m[5]),
      inflight: Number(m[6]),
      done: Number(m[7]),
      wait: Number(m[8]),
      err: Number(m[9]),
      assignAvg: Number(m[10]),
      assignP95: Number(m[11]),
      submitAvg: Number(m[12]),
      submitP95: Number(m[13]),
      submitP99: Number(m[14]),
    };
    summary.timeline.push(entry);
    summary.maxDone = Math.max(summary.maxDone, entry.done);
    summary.maxWait = Math.max(summary.maxWait, entry.wait);
    summary.maxInflightObserved = Math.max(summary.maxInflightObserved, entry.inflight);
  }

  return summary;
}

function stageStatus(stage, summary, exitCode) {
  if (exitCode !== 0) return 'FAIL';
  if (summary.opened === 0) return 'FAIL';
  if (summary.peakLive === 0 && summary.errors >= summary.opened) return 'FAIL';
  if (stage.name.startsWith('storm')) {
    return summary.errors === 0 ? 'PASS' : 'WARN';
  }
  if (summary.submitSamples === 0 && summary.accepted === 0) return 'WARN';
  if (summary.submitP95 > 2000 || summary.submitAvg > 500) return 'WARN';
  if (summary.errors > 0) return 'WARN';
  return 'PASS';
}

function formatCell(value, width, align = 'left') {
  const str = String(value);
  if (str.length >= width) return str;
  const padding = ' '.repeat(width - str.length);
  return align === 'right' ? padding + str : str + padding;
}

function printMatrix(results) {
  const rows = results.map(result => ({
    Stage: result.stage.name,
    Status: result.status,
    Clients: result.stage.clients,
    Rate: result.stage.rate,
    Sec: result.stage.duration,
    Opened: result.summary.opened,
    Peak: result.summary.peakLive,
    Err: result.summary.errors,
    Ok: result.summary.accepted,
    AssignP95: result.summary.assignP95,
    SubmitP95: result.summary.submitP95,
    SubmitP99: result.summary.submitP99,
  }));
  const headers = Object.keys(rows[0] || {
    Stage: '', Status: '', Clients: '', Rate: '', Sec: '', Opened: '', Peak: '', Err: '', Ok: '', AssignP95: '', SubmitP95: '', SubmitP99: '',
  });
  const numeric = new Set(['Clients', 'Rate', 'Sec', 'Opened', 'Peak', 'Err', 'Ok', 'AssignP95', 'SubmitP95', 'SubmitP99']);
  const widths = Object.fromEntries(headers.map(header => [
    header,
    Math.max(header.length, ...rows.map(row => String(row[header]).length)),
  ]));
  const line = headers.map(header => '-'.repeat(widths[header])).join('-+-');
  echoLine('\nLoad Test Matrix');
  echoLine(headers.map(header => formatCell(header, widths[header], numeric.has(header) ? 'right' : 'left')).join(' | '));
  echoLine(line);
  for (const row of rows) {
    echoLine(headers.map(header => formatCell(row[header], widths[header], numeric.has(header) ? 'right' : 'left')).join(' | '));
  }
}

function summarizeScenario(results) {
  const relevant = results.filter(r => r.stage.name.startsWith('real-'));
  const last = relevant.at(-1) || results.at(-1) || null;
  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  return {
    finalStage: last?.stage.name || '-',
    clients: last?.stage.clients || 0,
    status: fail > 0 ? 'FAIL' : warn > 0 ? 'WARN' : 'PASS',
    pass,
    warn,
    fail,
    accepted: last?.summary.accepted || 0,
    assignP95: last?.summary.assignP95 || 0,
    submitP95: last?.summary.submitP95 || 0,
    submitP99: last?.summary.submitP99 || 0,
    maxWait: last?.summary.maxWait || 0,
    maxDone: last?.summary.maxDone || 0,
  };
}

function printSweepSummary(scenarios) {
  const rows = scenarios.map(scenario => ({
    Scenario: scenario.name,
    Status: scenario.summary.status,
    Stage: scenario.summary.finalStage,
    Clients: scenario.summary.clients,
    Ok: scenario.summary.accepted,
    AssignP95: scenario.summary.assignP95,
    SubmitP95: scenario.summary.submitP95,
    SubmitP99: scenario.summary.submitP99,
    Wait: scenario.summary.maxWait,
    Done: scenario.summary.maxDone,
  }));
  const headers = Object.keys(rows[0] || {
    Scenario: '', Status: '', Stage: '', Clients: '', Ok: '', AssignP95: '', SubmitP95: '', SubmitP99: '', Wait: '', Done: '',
  });
  const numeric = new Set(['Clients', 'Ok', 'AssignP95', 'SubmitP95', 'SubmitP99', 'Wait', 'Done']);
  const widths = Object.fromEntries(headers.map(header => [
    header,
    Math.max(header.length, ...rows.map(row => String(row[header]).length)),
  ]));
  const line = headers.map(header => '-'.repeat(widths[header])).join('-+-');
  echoLine('\nSweep Summary');
  echoLine(headers.map(header => formatCell(header, widths[header], numeric.has(header) ? 'right' : 'left')).join(' | '));
  echoLine(line);
  for (const row of rows) {
    echoLine(headers.map(header => formatCell(row[header], widths[header], numeric.has(header) ? 'right' : 'left')).join(' | '));
  }
}

function loadSweepDefinitions(file) {
  const raw = fs.readFileSync(path.resolve(process.cwd(), String(file)), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.scenarios) || !parsed.scenarios.length) {
    throw new Error('Sweep file must contain a non-empty "scenarios" array.');
  }
  return {
    baseConfig: parsed.baseConfig || {},
    baseSession: parsed.baseSession || {},
    scenarios: parsed.scenarios.map((scenario, idx) => ({
      name: scenario.name || `scenario-${idx + 1}`,
      config: scenario.config || {},
      session: scenario.session || {},
    })),
  };
}

async function apiJson(pathname, init = {}) {
  const url = new URL(pathname, apiBase);
  const res = await fetch(url, withAdminAuth(init));
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function getAdminState() {
  return apiJson('/api/state');
}

async function applyAdminConfig(configPatch = {}) {
  if (!configPatch || !Object.keys(configPatch).length) {
    return { ok: true, status: 200, body: { skipped: true } };
  }
  return apiJson('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(configPatch),
  });
}

async function createOrReuseSession(sessionOpts = {}) {
  const nextPieces = sessionOpts.pieces ?? pieces;
  const nextRedundancy = sessionOpts.redundancy ?? redundancy;
  const nextIncludeSolidBlack = sessionOpts.includeSolidBlack ?? includeSolidBlack;
  const nextImagePath = sessionOpts.image ?? imagePath;
  const form = new FormData();
  form.set('pieces', String(nextPieces));
  form.set('redundancy', String(nextRedundancy));
  form.set('includeSolidBlack', String(nextIncludeSolidBlack));
  if (nextImagePath) {
    const fileBuf = fs.readFileSync(path.resolve(process.cwd(), String(nextImagePath)));
    const blob = new Blob([fileBuf]);
    form.set('image', blob, path.basename(String(nextImagePath)));
  }
  return apiJson('/api/session', { method: 'POST', body: form });
}

async function restartSession() {
  return apiJson('/api/session/restart', { method: 'POST' });
}

async function prepareStageSession(stage, isFirstStage, scenario = {}) {
  const scenarioSession = scenario.session || {};
  const state = await getAdminState();
  const shouldCreateFresh = isFirstStage || !resetEachStage || !state.ok || !state.body?.active;
  if (shouldCreateFresh) {
    const result = await createOrReuseSession(scenarioSession);
    if (!result.ok) {
      throw new Error(`Could not create/reuse session before ${stage.name}: ${JSON.stringify(result.body)}`);
    }
    return { mode: 'session', details: result.body };
  }
  const restarted = await restartSession();
  if (restarted.ok) return { mode: 'restart', details: restarted.body };
  const created = await createOrReuseSession(scenarioSession);
  if (!created.ok) {
    throw new Error(`Could not reset session before ${stage.name}: restart=${JSON.stringify(restarted.body)} create=${JSON.stringify(created.body)}`);
  }
  return { mode: 'session', details: created.body };
}

function httpProbe(urlString) {
  return new Promise(resolve => {
    const probeUrl = new URL('/api/config', apiBase);
    const client = probeUrl.protocol === 'https:' ? https : http;
    const req = client.get(probeUrl, {
      headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
    }, res => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode });
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', err => resolve({ ok: false, status: err.message }));
  });
}

class HostMonitor {
  constructor({ sampleMs = 1000, apiCheckMs = 5000 } = {}) {
    this.sampleMs = sampleMs;
    this.apiCheckMs = apiCheckMs;
    this.samples = [];
    this.timer = null;
    this.phase = 'run';
    this.prevCpu = null;
    this.lastApiCheckAt = 0;
    this.lastApiHealthy = true;
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
  }

  snapshotCpu() {
    const cpus = os.cpus();
    const totals = cpus.map(cpu => Object.values(cpu.times).reduce((a, b) => a + b, 0));
    const idles = cpus.map(cpu => cpu.times.idle);
    return {
      total: totals.reduce((a, b) => a + b, 0),
      idle: idles.reduce((a, b) => a + b, 0),
    };
  }

  async getServerRssMb() {
    try {
      const { stdout } = await execFile('ps', ['-eo', 'rss=,args=']);
      const lines = stdout.trim().split('\n');
      let maxRssKb = 0;
      for (const line of lines) {
        if (!line.includes('server.js')) continue;
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!match) continue;
        maxRssKb = Math.max(maxRssKb, Number(match[1]));
      }
      return maxRssKb ? maxRssKb / 1024 : null;
    } catch {
      return null;
    }
  }

  async getDiskFreePct() {
    try {
      const { stdout } = await execFile('df', ['-Pk', process.cwd()]);
      const line = stdout.trim().split('\n').at(-1) || '';
      const parts = line.trim().split(/\s+/);
      const usedPct = Number(parts[4]?.replace('%', ''));
      if (!Number.isFinite(usedPct)) return null;
      return Math.max(0, 100 - usedPct);
    } catch {
      return null;
    }
  }

  async sample() {
    const now = Date.now();
    const cpuSnap = this.snapshotCpu();
    let cpuPct = null;
    if (this.prevCpu) {
      const totalDelta = cpuSnap.total - this.prevCpu.total;
      const idleDelta = cpuSnap.idle - this.prevCpu.idle;
      cpuPct = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
    }
    this.prevCpu = cpuSnap;

    if (now - this.lastApiCheckAt >= this.apiCheckMs) {
      this.lastApiCheckAt = now;
      try {
        const health = await getAdminState();
        this.lastApiHealthy = health.ok;
      } catch {
        this.lastApiHealthy = false;
      }
    }

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const sample = {
      ts: new Date(now).toISOString(),
      phase: this.phase,
      cpuPct,
      memUsedPct: ((totalMem - freeMem) / totalMem) * 100,
      nodeRssMb: await this.getServerRssMb(),
      diskFreePct: await this.getDiskFreePct(),
      eventLoopP95Ms: this.loopDelay.percentile(95) / 1e6,
      apiHealthy: this.lastApiHealthy,
    };
    this.samples.push(sample);
    return sample;
  }

  async start(phase = 'run') {
    this.phase = phase;
    this.samples = [];
    this.prevCpu = this.snapshotCpu();
    this.lastApiCheckAt = 0;
    this.lastApiHealthy = true;
    this.loopDelay.reset();
    this.loopDelay.enable();
    await this.sample();
    this.timer = setInterval(() => {
      this.sample().catch(() => {});
    }, this.sampleMs);
  }

  setPhase(phase) {
    this.phase = phase;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.sample().catch(() => {});
    this.loopDelay.disable();
    return this.samples;
  }
}

function summarizeHostSamples(samples) {
  let cpuStreak = 0;
  let longestCpuStreak = 0;
  let apiHealthyAll = true;
  let peakCpu = 0;
  let peakMem = 0;
  let peakRss = 0;
  let minDiskFree = 100;
  let peakEventLoopP95 = 0;

  for (const sample of samples) {
    if (sample.cpuPct !== null) {
      peakCpu = Math.max(peakCpu, sample.cpuPct);
      if (sample.cpuPct > BREAKPOINT_THRESHOLDS.cpuPct) cpuStreak += 1;
      else cpuStreak = 0;
      longestCpuStreak = Math.max(longestCpuStreak, cpuStreak);
    }
    peakMem = Math.max(peakMem, sample.memUsedPct || 0);
    peakRss = Math.max(peakRss, sample.nodeRssMb || 0);
    minDiskFree = Math.min(minDiskFree, sample.diskFreePct ?? minDiskFree);
    peakEventLoopP95 = Math.max(peakEventLoopP95, sample.eventLoopP95Ms || 0);
    apiHealthyAll = apiHealthyAll && sample.apiHealthy !== false;
  }

  return {
    peakCpu,
    peakMem,
    peakRss,
    minDiskFree: minDiskFree === 100 && samples.every(s => s.diskFreePct == null) ? null : minDiskFree,
    peakEventLoopP95,
    cpuOverThresholdSeconds: longestCpuStreak,
    apiHealthyAll,
  };
}

function connectionSuccessRate(stage, summary) {
  return stage.clients > 0 ? summary.peakLive / stage.clients : 0;
}
function submissionSuccessRate(summary) {
  return summary.sent > 0 ? summary.accepted / summary.sent : 1;
}
function disconnectRate(summary) {
  return summary.opened > 0 ? summary.closed / summary.opened : 0;
}
function errorRate(summary) {
  return summary.opened > 0 ? summary.errors / summary.opened : 0;
}

function evaluateBreakpointStage(stage, summary, hostSummary, exitCode, recoveryOk) {
  const evidence = [];
  let bottleneck = null;
  let result = 'pass';
  const connRate = connectionSuccessRate(stage, summary);
  const submitRate = submissionSuccessRate(summary);
  const discRate = disconnectRate(summary);
  const errRate = errorRate(summary);

  const check = (condition, key, reason) => {
    if (!condition) return;
    result = exitCode === 0 ? 'degraded' : 'fail';
    if (!bottleneck) bottleneck = key;
    evidence.push(reason);
  };

  check(exitCode !== 0, 'app-errors', `loadtest exited with code ${exitCode}`);
  check(!recoveryOk, 'app-health', 'app did not recover during cooldown');
  check(!hostSummary.apiHealthyAll, 'app-health', 'admin API health/state check failed');
  check(connRate < BREAKPOINT_THRESHOLDS.connectionSuccessRate, 'failed-connections', `connection success rate ${(connRate * 100).toFixed(1)}% < ${(BREAKPOINT_THRESHOLDS.connectionSuccessRate * 100).toFixed(0)}%`);
  check(submitRate < BREAKPOINT_THRESHOLDS.submissionSuccessRate, 'rejected-submissions', `submission success rate ${(submitRate * 100).toFixed(1)}% < ${(BREAKPOINT_THRESHOLDS.submissionSuccessRate * 100).toFixed(0)}%`);
  check(discRate > BREAKPOINT_THRESHOLDS.disconnectRate, 'disconnects', `disconnect rate ${(discRate * 100).toFixed(1)}% > ${(BREAKPOINT_THRESHOLDS.disconnectRate * 100).toFixed(0)}%`);
  check(errRate > BREAKPOINT_THRESHOLDS.errorRate, 'app-errors', `error rate ${(errRate * 100).toFixed(1)}% > ${(BREAKPOINT_THRESHOLDS.errorRate * 100).toFixed(0)}%`);
  check(summary.assignP95 > BREAKPOINT_THRESHOLDS.assignmentP95Ms, 'latency', `p95 assignment latency ${summary.assignP95}ms > ${BREAKPOINT_THRESHOLDS.assignmentP95Ms}ms`);
  check(summary.submitP95 > BREAKPOINT_THRESHOLDS.submitP95Ms, 'latency', `p95 submit latency ${summary.submitP95}ms > ${BREAKPOINT_THRESHOLDS.submitP95Ms}ms`);
  check(hostSummary.cpuOverThresholdSeconds > BREAKPOINT_THRESHOLDS.cpuSeconds, 'cpu', `host CPU exceeded ${BREAKPOINT_THRESHOLDS.cpuPct}% for ${hostSummary.cpuOverThresholdSeconds}s`);
  check(hostSummary.peakMem > BREAKPOINT_THRESHOLDS.memoryUsedPct, 'memory', `host memory used ${hostSummary.peakMem.toFixed(1)}% > ${BREAKPOINT_THRESHOLDS.memoryUsedPct}%`);
  check(Number.isFinite(BREAKPOINT_THRESHOLDS.nodeRssMaxMb) && hostSummary.peakRss > BREAKPOINT_THRESHOLDS.nodeRssMaxMb, 'rss', `Node RSS ${hostSummary.peakRss.toFixed(0)}MB > ${BREAKPOINT_THRESHOLDS.nodeRssMaxMb}MB`);
  check(hostSummary.peakEventLoopP95 > BREAKPOINT_THRESHOLDS.eventLoopP95Ms, 'event-loop', `event loop delay p95 ${hostSummary.peakEventLoopP95.toFixed(0)}ms > ${BREAKPOINT_THRESHOLDS.eventLoopP95Ms}ms`);
  check(hostSummary.minDiskFree !== null && hostSummary.minDiskFree < BREAKPOINT_THRESHOLDS.diskFreePct, 'disk', `disk free ${hostSummary.minDiskFree.toFixed(1)}% < ${BREAKPOINT_THRESHOLDS.diskFreePct}%`);

  return {
    result,
    connRate,
    submitRate,
    discRate,
    errRate,
    bottleneck: bottleneck || '-',
    evidence: evidence.length ? evidence : ['within default thresholds'],
  };
}

function nextNiceBelowStep(current, growth, step) {
  const target = current * growth;
  const candidates = [1, 2.5, 5, 10];
  let power = 10 ** Math.floor(Math.log10(target || 1));
  while (power <= step * 10) {
    for (const multiplier of candidates) {
      const candidate = multiplier * power;
      if (candidate > current && candidate >= target) return Math.min(step, Math.round(candidate));
    }
    power *= 10;
  }
  return Math.min(step, Math.max(current + 1, Math.round(target)));
}

function buildBreakpointSteps() {
  const steps = [];
  let current = breakpointStart;
  while (current <= breakpointMax) {
    if (!steps.includes(current)) steps.push(current);
    let next;
    if (current < breakpointStep) {
      next = nextNiceBelowStep(current, breakpointGrowth, breakpointStep);
    } else {
      next = Math.max(current + breakpointStep, Math.round(current * breakpointGrowth));
    }
    if (next <= current) next = current + 1;
    current = next;
  }
  if (!steps.includes(breakpointMax)) steps.push(breakpointMax);
  return [...new Set(steps)].filter(n => n >= breakpointStart && n <= breakpointMax).sort((a, b) => a - b);
}

function buildEventStage(name, clientCount, drawMinOverride = drawMin, drawMaxOverride = drawMax, tilesOverride = tiles) {
  const rate = Math.max(1, Math.ceil(clientCount / Math.max(1, rampSeconds)));
  return {
    name,
    clients: clientCount,
    rate,
    duration: explicitDuration || (rampSeconds + holdSeconds),
    drawMin: drawMinOverride,
    drawMax: drawMaxOverride,
    tiles: tilesOverride,
    hold: true,
  };
}

async function runStage(stage, options = {}) {
  const { concise = false } = options;
  return new Promise(resolve => {
    const cmdArgs = [
      'loadtest.jan.js',
      targetUrl,
      '--clients', String(stage.clients),
      '--rate', String(stage.rate),
      '--draw-min', String(stage.drawMin),
      '--draw-max', String(stage.drawMax),
      '--tiles', String(stage.tiles),
      '--duration', String(stage.duration),
      '--hold', String(stage.hold),
    ];
    if (insecure) cmdArgs.push('--insecure');

    echoLine(`\n=== ${stage.name} ===`);
    echoLine(`node ${cmdArgs.join(' ')}`);

    const child = spawn(process.execPath, cmdArgs, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      if (!concise) echo(text);
      else writeLog(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
      writeLog(text);
    });
    child.on('close', code => {
      const summary = parseSummary(output);
      const status = stageStatus(stage, summary, code ?? 1);
      resolve({ stage, exitCode: code ?? 1, summary, status, rawOutput: output });
    });
  });
}

async function runScenario(label, scenario) {
  echoLine(`\n=== Scenario: ${label} ===`);
  if (scenario.config && Object.keys(scenario.config).length) {
    const cfgResult = await applyAdminConfig(scenario.config);
    if (!cfgResult.ok) throw new Error(`Could not apply config for ${label}: ${JSON.stringify(cfgResult.body)}`);
    echoLine(`Applied config for ${label}: ${JSON.stringify(scenario.config)}`);
  }
  const stages = buildStages(maxClients);
  const results = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    try {
      const prep = await prepareStageSession(stage, i === 0, scenario);
      echoLine(`Prepared session for ${stage.name} via ${prep.mode}.`);
    } catch (error) {
      echoLine(`\nStopping before ${stage.name}: ${error.message || error}`);
      results.push({ stage, exitCode: 1, summary: matrixSummaryDefaults(), status: 'FAIL' });
      break;
    }
    const result = await runStage(stage);
    results.push(result);
    if (stopOnFail && result.status === 'FAIL') {
      echoLine(`\nStopping after ${stage.name}: hard failure detected.`);
      break;
    }
  }
  printMatrix(results);
  const passCount = results.filter(r => r.status === 'PASS').length;
  const warnCount = results.filter(r => r.status === 'WARN').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  echoLine(`\nScenario Summary: ${passCount} PASS, ${warnCount} WARN, ${failCount} FAIL`);
  return results;
}

async function runSingleProfile(profileName) {
  const clientCount = users || (profileName === 'smoke' ? 200 : 5000);
  const stage = buildEventStage(profileName, clientCount, profileName === 'smoke' ? 5 : drawMin, profileName === 'smoke' ? 10 : drawMax, profileName === 'smoke' ? 3 : tiles);
  await prepareStageSession(stage, true, { config: {}, session: {} });
  const result = await runStage(stage);
  printMatrix([result]);
  echoLine(`\nSummary: ${result.status}`);
  return result.status === 'FAIL' ? 1 : result.status === 'WARN' ? 2 : 0;
}

async function confirmBreakpoint() {
  const warning = [
    '[breakpoint] WARNING: breakpoint mode will intentionally push the app until it degrades.',
    `[breakpoint] start=${breakpointStart} max=${breakpointMax} growth=${breakpointGrowth} step=${breakpointStep} ramp=${rampSeconds}s hold=${holdSeconds}s cooldown=${cooldownSeconds}s`,
  ];
  warning.forEach(echoLine);
  const nonInteractive = Boolean(process.env.CI) || !process.stdin.isTTY;
  if (yes) return;
  if (nonInteractive) {
    echoLine('[breakpoint] Non-interactive mode detected. Re-run with --yes to proceed.');
    logStream.end();
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Continue with breakpoint discovery? [y/N] ');
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    echoLine('[breakpoint] Aborted by user.');
    logStream.end();
    process.exit(0);
  }
}

async function cooldownAndRecover(monitor) {
  monitor.setPhase('cooldown');
  const cooldownUntil = Date.now() + cooldownSeconds * 1000;
  while (Date.now() < cooldownUntil) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const state = await getAdminState().catch(() => ({ ok: false }));
  const recent = monitor.samples.filter(sample => sample.phase === 'cooldown').at(-1);
  return Boolean(
    state.ok &&
    recent &&
    (recent.cpuPct === null || recent.cpuPct < BREAKPOINT_THRESHOLDS.cpuPct) &&
    recent.memUsedPct < BREAKPOINT_THRESHOLDS.memoryUsedPct &&
    recent.apiHealthy !== false
  );
}

function writeBreakpointArtifacts(summary, steps, metricsCsv) {
  fs.mkdirSync(breakpointDir, { recursive: true });
  const summaryPath = path.join(breakpointDir, 'breakpoint-summary.json');
  const stepsPath = path.join(breakpointDir, 'breakpoint-steps.json');
  const metricsPath = path.join(breakpointDir, 'breakpoint-metrics.csv');
  const reportPath = path.join(breakpointDir, 'report.md');

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(stepsPath, JSON.stringify(steps, null, 2));
  fs.writeFileSync(metricsPath, metricsCsv);

  const tableRows = steps.map(step => `| ${step.users} | ${step.result.toUpperCase()} | ${(step.connRate * 100).toFixed(1)}% | ${(step.submitRate * 100).toFixed(1)}% | ${(step.discRate * 100).toFixed(1)}% | ${step.summary.assignP95}ms | ${step.summary.submitP95}ms | ${step.summary.submitP99}ms | ${step.host.peakCpu.toFixed(1)}% | ${step.host.peakRss ? step.host.peakRss.toFixed(0) + 'MB' : '-'} | ${step.host.peakMem.toFixed(1)}% | ${step.bottleneck} |`).join('\n');
  const finalEvidence = Array.isArray(summary.breakpoint.evidence) ? summary.breakpoint.evidence : [];
  const report = `# Breakpoint Report

## Summary

\`\`\`json
${JSON.stringify(summary.breakpoint, null, 2)}
\`\`\`

## Recommendation

- Last known good: ${summary.breakpoint.lastGoodUsers}
- First known bad: ${summary.breakpoint.firstBadUsers}
- Recommended safe production users: ${summary.breakpoint.recommendedSafeUsers}
- Safe margin: ${summary.breakpoint.safeMargin}
- Bottleneck: ${summary.breakpoint.bottleneck}

## Bottleneck Evidence

${finalEvidence.length ? finalEvidence.map(item => `- ${item}`).join('\n') : '- No failure evidence recorded.'}

## Breakpoint Table

| users | result | conn success | submit success | disconnects | p95 assign | p95 submit | p99 submit | CPU peak | RSS peak | mem peak | bottleneck |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${tableRows}
`;
  fs.writeFileSync(reportPath, report);
  return { summaryPath, stepsPath, metricsPath, reportPath };
}

function buildMetricsCsv(steps) {
  const csvEscape = value => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = ['users,result,conn_success_rate,submit_success_rate,disconnect_rate,error_rate,assign_p95_ms,assign_p99_ms,submit_p95_ms,submit_p99_ms,cpu_peak_pct,mem_peak_pct,node_rss_peak_mb,event_loop_p95_ms,disk_free_min_pct,bottleneck,reason'];
  for (const step of steps) {
    rows.push([
      step.users,
      step.result,
      step.connRate.toFixed(4),
      step.submitRate.toFixed(4),
      step.discRate.toFixed(4),
      step.errRate.toFixed(4),
      step.summary.assignP95,
      step.summary.assignP99,
      step.summary.submitP95,
      step.summary.submitP99,
      step.host.peakCpu.toFixed(2),
      step.host.peakMem.toFixed(2),
      step.host.peakRss?.toFixed?.(2) ?? '',
      step.host.peakEventLoopP95.toFixed(2),
      step.host.minDiskFree?.toFixed?.(2) ?? '',
      csvEscape(step.bottleneck),
      csvEscape(step.reason),
    ].join(','));
  }
  return rows.join('\n') + '\n';
}

async function runBreakpointMode() {
  await confirmBreakpoint();
  const stepsToTest = buildBreakpointSteps();
  const attempts = [];
  let lastGood = null;
  let firstBad = null;

  for (const usersCount of stepsToTest) {
    echoLine(`[breakpoint] testing ${usersCount} users`);
    const stage = buildEventStage(`breakpoint-${usersCount}`, usersCount);
    try {
      await prepareStageSession(stage, attempts.length === 0, { config: {}, session: {} });
    } catch (error) {
      const failed = {
        users: usersCount,
        stage,
        result: 'fail',
        connRate: 0,
        submitRate: 0,
        discRate: 0,
        errRate: 1,
        summary: matrixSummaryDefaults(),
        host: summarizeHostSamples([]),
        bottleneck: 'app-health',
        reason: error.message || String(error),
        evidence: [error.message || String(error)],
      };
      attempts.push(failed);
      firstBad = firstBad ?? usersCount;
      break;
    }

    const monitor = new HostMonitor();
    await monitor.start('run');
    const result = await runStage(stage, { concise: true });
    const recoveryOk = await cooldownAndRecover(monitor);
    const hostSamples = await monitor.stop();
    const hostSummary = summarizeHostSamples(hostSamples);
    const evaluation = evaluateBreakpointStage(stage, result.summary, hostSummary, result.exitCode, recoveryOk);
    const stepResult = {
      users: usersCount,
      stage,
      summary: result.summary,
      host: hostSummary,
      result: evaluation.result,
      connRate: evaluation.connRate,
      submitRate: evaluation.submitRate,
      discRate: evaluation.discRate,
      errRate: evaluation.errRate,
      bottleneck: evaluation.bottleneck,
      reason: evaluation.evidence[0],
      evidence: evaluation.evidence,
      recoveryOk,
      rawOutput: result.rawOutput,
      samples: hostSamples,
    };
    attempts.push(stepResult);

    const cpuText = hostSummary.peakCpu ? `cpu=${hostSummary.peakCpu.toFixed(0)}%` : 'cpu=n/a';
    const rssText = hostSummary.peakRss ? `rss=${hostSummary.peakRss.toFixed(0)}MB` : 'rss=n/a';
    const resultLabel = stepResult.result.toUpperCase();
    echoLine(`[breakpoint] ${usersCount} users ${resultLabel} assignP95=${result.summary.assignP95}ms submitP95=${result.summary.submitP95}ms ${cpuText} ${rssText}`);

    if (stepResult.result === 'pass') {
      lastGood = usersCount;
    } else {
      firstBad = usersCount;
      break;
    }
  }

  if (breakpointRefine && lastGood !== null && firstBad !== null) {
    let low = lastGood;
    let high = firstBad;
    for (let i = 0; i < breakpointRefineSteps; i++) {
      const candidate = Math.floor((low + high) / 2);
      if (candidate <= low || candidate >= high) break;
      echoLine(`[breakpoint] refining between ${low} and ${high} -> ${candidate}`);
      const stage = buildEventStage(`breakpoint-refine-${candidate}`, candidate);
      await prepareStageSession(stage, false, { config: {}, session: {} });
      const monitor = new HostMonitor();
      await monitor.start('run');
      const result = await runStage(stage, { concise: true });
      const recoveryOk = await cooldownAndRecover(monitor);
      const hostSamples = await monitor.stop();
      const hostSummary = summarizeHostSamples(hostSamples);
      const evaluation = evaluateBreakpointStage(stage, result.summary, hostSummary, result.exitCode, recoveryOk);
      const stepResult = {
        users: candidate,
        stage,
        summary: result.summary,
        host: hostSummary,
        result: evaluation.result,
        connRate: evaluation.connRate,
        submitRate: evaluation.submitRate,
        discRate: evaluation.discRate,
        errRate: evaluation.errRate,
        bottleneck: evaluation.bottleneck,
        reason: evaluation.evidence[0],
        evidence: evaluation.evidence,
        recoveryOk,
        rawOutput: result.rawOutput,
        samples: hostSamples,
      };
      attempts.push(stepResult);
      if (stepResult.result === 'pass') low = candidate;
      else high = candidate;
    }
    lastGood = low;
    firstBad = high;
  }

  attempts.sort((a, b) => a.users - b.users);
  const lastGoodStep = attempts.filter(s => s.result === 'pass').at(-1) || null;
  const firstBadStep = attempts.find(s => s.result !== 'pass') || null;
  const recommendedSafeUsers = lastGoodStep ? Math.floor(lastGoodStep.users * breakpointSafeMargin) : 0;
  const bottleneckStep = firstBadStep || attempts.at(-1);
  const summary = {
    breakpoint: {
      maxTestedUsers: attempts.at(-1)?.users || 0,
      lastGoodUsers: lastGoodStep?.users || 0,
      firstBadUsers: firstBadStep?.users || 0,
      recommendedSafeUsers,
      safeMargin: breakpointSafeMargin,
      bottleneck: bottleneckStep?.bottleneck || '-',
      reason: bottleneckStep?.reason || 'no failure observed',
      evidence: bottleneckStep?.evidence || [],
    },
  };
  const artifactPaths = writeBreakpointArtifacts(summary, attempts, buildMetricsCsv(attempts));

  echoLine('\nBreakpoint Summary');
  echoLine(JSON.stringify(summary, null, 2));
  echoLine(`Report: ${artifactPaths.reportPath}`);
  echoLine(`Summary JSON: ${artifactPaths.summaryPath}`);
  echoLine(`Steps JSON: ${artifactPaths.stepsPath}`);
  echoLine(`Metrics CSV: ${artifactPaths.metricsPath}`);

  return firstBadStep ? 2 : 0;
}

const probe = await httpProbe(targetUrl);
if (!probe.ok) {
  const line1 = `Preflight failed: could not reach ${new URL('/api/config', apiBase).toString()} (${probe.status}).`;
  const line2 = 'Start the server first and upload a test image in the admin before running the matrix.';
  console.error(line1);
  console.error(line2);
  writeLog(line1 + '\n' + line2 + '\n');
  logStream.end();
  process.exit(2);
}

if (probe.status === 401) {
  const line1 = 'Preflight failed: /api/config returned 401 Unauthorized.';
  const line2 = adminToken
    ? 'The supplied admin token was rejected. Verify ADMIN_TOKEN / --admin-token before running the matrix.'
    : 'Set ADMIN_TOKEN in the environment or pass --admin-token so loadtest-matrix.js can access protected admin APIs.';
  console.error(line1);
  console.error(line2);
  writeLog(line1 + '\n' + line2 + '\n');
  logStream.end();
  process.exit(2);
}

echoLine(`Load-test log file: ${outputFile}`);
echoLine(`Preflight OK: /api/config responded with status ${probe.status}`);
echoLine(`Admin auth: ${adminToken ? 'enabled via bearer token' : 'not configured'}`);
echoLine(`Profile: ${profile}`);
echoLine(`Target: ${targetUrl}`);
echoLine(`Session prep: ${imagePath ? `will upload ${imagePath}` : 'will reuse the previous uploaded image'}; pieces=${pieces}; redundancy=${redundancy}; resetEachStage=${resetEachStage}`);
echoLine('Reminder: automatic session prep is enabled; open the admin only if you want to watch the board.\n');

let exitCode = 0;
if (profile === 'breakpoint') {
  exitCode = await runBreakpointMode();
} else if (profile === 'smoke' || profile === 'event') {
  exitCode = await runSingleProfile(profile);
} else if (sweepFile) {
  const sweep = loadSweepDefinitions(sweepFile);
  const scenarioResults = [];
  for (const scenario of sweep.scenarios) {
    const mergedScenario = {
      name: scenario.name,
      config: { ...sweep.baseConfig, ...scenario.config },
      session: { ...sweep.baseSession, ...scenario.session },
    };
    const results = await runScenario(mergedScenario.name, mergedScenario);
    scenarioResults.push({
      name: mergedScenario.name,
      summary: summarizeScenario(results),
      results,
    });
  }
  printSweepSummary(scenarioResults);
  const hasFail = scenarioResults.some(s => s.summary.status === 'FAIL');
  const hasWarn = scenarioResults.some(s => s.summary.status === 'WARN');
  if (hasFail) exitCode = 1;
  else if (hasWarn) exitCode = 2;
} else {
  const results = await runScenario('default', { config: {}, session: {} });
  const passCount = results.filter(r => r.status === 'PASS').length;
  const warnCount = results.filter(r => r.status === 'WARN').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  echoLine(`\nSummary: ${passCount} PASS, ${warnCount} WARN, ${failCount} FAIL`);
  if (failCount > 0) exitCode = 1;
  else if (warnCount > 0) exitCode = 2;
}

logStream.end();
process.exit(exitCode);
