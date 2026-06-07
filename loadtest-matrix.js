#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import readline from 'readline/promises';
import { monitorEventLoopDelay } from 'perf_hooks';
import { buildBreakpointStepsList, isRecoveryHealthy, pickRecoveryHostMetrics } from './scripts/helpers/breakpoint-helpers.js';

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
  --tester NAME         loadtest | loadtest2 (default loadtest)
  --metrics-host SSH    Optional SSH target for real app-host sampling
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
    if (httpUrl.pathname === '/ws') httpUrl.pathname = '/';
    httpUrl.search = '';
    httpUrl.hash = '';
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
const tester = String(getOpt('tester', 'loadtest'));
const metricsHost = String(getOpt('metrics-host', ''));
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
const metricsPort = Number(apiBase.port || (apiBase.protocol === 'https:' ? 443 : 80));

if (!['loadtest', 'loadtest2'].includes(tester)) {
  throw new Error(`Unsupported tester "${tester}". Use --tester loadtest or --tester loadtest2.`);
}

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
    tester,
    opened: 0,
    peakLive: 0,
    closed: 0,
    errors: 0,
    wsConnErr: 0,
    httpOpened: 0,
    httpOk: 0,
    httpErr: 0,
    refOk: 0,
    refErr: 0,
    sent: 0,
    accepted: 0,
    rejected: 0,
    inflight: 0,
    handshakeAvg: 0,
    handshakeP95: 0,
    handshakeP99: 0,
    handshakeSamples: 0,
    firstTileAvg: 0,
    firstTileP95: 0,
    firstTileP99: 0,
    firstTileSamples: 0,
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
  const summaryJsonLine = output.split('\n').reverse().find(line => line.startsWith('SUMMARY_JSON '));
  if (summaryJsonLine) {
    try {
      const parsed = JSON.parse(summaryJsonLine.slice('SUMMARY_JSON '.length));
      Object.assign(summary, parsed.summary || {});
      if (parsed.tester) summary.tester = parsed.tester;
    } catch {}
  }
  const connections = output.match(/connections\s+opened=(\d+)\s+peak-live≈(\d+)\s+closed=(\d+)\s+errors=(\d+)/);
  if (connections) {
    summary.opened = Number(connections[1]);
    summary.peakLive = Number(connections[2]);
    summary.closed = Number(connections[3]);
    summary.errors = Number(connections[4]);
    if (!summary.wsConnErr) summary.wsConnErr = summary.errors;
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
  const httpSummary = output.match(/http\s+opened=(\d+)\s+ok=(\d+)\s+err=(\d+)\s+refImg ok=(\d+)\s+err=(\d+)/);
  if (httpSummary) {
    summary.httpOpened = Number(httpSummary[1]);
    summary.httpOk = Number(httpSummary[2]);
    summary.httpErr = Number(httpSummary[3]);
    summary.refOk = Number(httpSummary[4]);
    summary.refErr = Number(httpSummary[5]);
  }
  const websocketSummary = output.match(/websocket\s+opened=(\d+)\s+peak-live≈(\d+)\s+closed=(\d+)\s+connErr=(\d+)/);
  if (websocketSummary) {
    summary.opened = Number(websocketSummary[1]);
    summary.peakLive = Number(websocketSummary[2]);
    summary.closed = Number(websocketSummary[3]);
    summary.wsConnErr = Number(websocketSummary[4]);
    summary.errors = Number(websocketSummary[4]);
  }
  const handshake = output.match(/handshake\s+avg=(\d+)ms\s+p95=(\d+)ms\s+p99=(\d+)ms/);
  if (handshake) {
    summary.handshakeAvg = Number(handshake[1]);
    summary.handshakeP95 = Number(handshake[2]);
    summary.handshakeP99 = Number(handshake[3]);
  }
  const firstTile = output.match(/firsttile\s+avg=(\d+)ms\s+p95=(\d+)ms\s+p99=(\d+)ms/);
  if (firstTile) {
    summary.firstTileAvg = Number(firstTile[1]);
    summary.firstTileP95 = Number(firstTile[2]);
    summary.firstTileP99 = Number(firstTile[3]);
  }

  for (const line of output.split('\n')) {
    const m = line.match(/t=(\d+)s\s+live=(\d+)\/(\d+)\s+sub\/s=([0-9.]+)\s+ok=(\d+)\s+inflight=(\d+)\s+done=(\d+)\s+wait=(\d+)\s+err=(\d+)\s+assign avg=(\d+)ms p95=(\d+)ms\s+submit avg=(\d+)ms p95=(\d+)ms p99=(\d+)ms/);
    const v2 = line.match(/t=(\d+)s\s+live=(\d+)\/(\d+)\s+sub\/s=([0-9.]+)\s+ok=(\d+)\s+inflight=(\d+)\s+done=(\d+)\s+wait=(\d+)\s+wsErr=(\d+)\s+httpErr=(\d+)\s+refErr=(\d+)\s+hs avg=(\d+)ms p95=(\d+)ms p99=(\d+)ms\s+tile avg=(\d+)ms p95=(\d+)ms p99=(\d+)ms\s+submit avg=(\d+)ms p95=(\d+)ms p99=(\d+)ms/);
    if (!m && !v2) continue;
    const entry = m ? {
      t: Number(m[1]),
      live: Number(m[2]),
      launched: Number(m[3]),
      subPerSec: Number(m[4]),
      ok: Number(m[5]),
      inflight: Number(m[6]),
      done: Number(m[7]),
      wait: Number(m[8]),
      err: Number(m[9]),
      httpErr: 0,
      refErr: 0,
      wsErr: Number(m[9]),
      handshakeP95: 0,
      handshakeP99: 0,
      firstTileP95: Number(m[11]),
      firstTileP99: 0,
      assignAvg: Number(m[10]),
      assignP95: Number(m[11]),
      submitAvg: Number(m[12]),
      submitP95: Number(m[13]),
      submitP99: Number(m[14]),
    } : {
      t: Number(v2[1]),
      live: Number(v2[2]),
      launched: Number(v2[3]),
      subPerSec: Number(v2[4]),
      ok: Number(v2[5]),
      inflight: Number(v2[6]),
      done: Number(v2[7]),
      wait: Number(v2[8]),
      err: Number(v2[9]) + Number(v2[10]) + Number(v2[11]),
      httpErr: Number(v2[10]),
      refErr: Number(v2[11]),
      wsErr: Number(v2[9]),
      handshakeP95: Number(v2[13]),
      handshakeP99: Number(v2[14]),
      firstTileP95: Number(v2[16]),
      firstTileP99: Number(v2[17]),
      assignAvg: Number(v2[15]),
      assignP95: Number(v2[16]),
      submitAvg: Number(v2[18]),
      submitP95: Number(v2[19]),
      submitP99: Number(v2[20]),
    };
    summary.timeline.push(entry);
    summary.maxDone = Math.max(summary.maxDone, entry.done);
    summary.maxWait = Math.max(summary.maxWait, entry.wait);
    summary.maxInflightObserved = Math.max(summary.maxInflightObserved, entry.inflight);
  }

  return summary;
}

function stageStatus(stage, summary, exitCode) {
  const totalErrors = summary.errors + summary.httpErr + summary.refErr + Math.max(0, summary.wsConnErr - summary.errors);
  if (exitCode !== 0) return 'FAIL';
  if (summary.opened === 0) return 'FAIL';
  if (summary.peakLive === 0 && summary.wsConnErr >= summary.opened) return 'FAIL';
  if (stage.name.startsWith('storm')) {
    return totalErrors === 0 ? 'PASS' : 'WARN';
  }
  if (summary.submitSamples === 0 && summary.accepted === 0) return 'WARN';
  if (summary.submitP95 > 2000 || summary.submitAvg > 500) return 'WARN';
  if (totalErrors > 0) return 'WARN';
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
    Tester: result.summary.tester || tester,
    Status: result.status,
    Clients: result.stage.clients,
    Rate: result.stage.rate,
    Sec: result.stage.duration,
    Opened: result.summary.opened,
    Peak: result.summary.peakLive,
    WsErr: result.summary.wsConnErr,
    HttpErr: result.summary.httpErr,
    RefErr: result.summary.refErr,
    Ok: result.summary.accepted,
    HsP95: result.summary.handshakeP95,
    HsP99: result.summary.handshakeP99,
    TileP95: result.summary.firstTileP95 || result.summary.assignP95,
    TileP99: result.summary.firstTileP99 || result.summary.assignP99,
    AssignP95: result.summary.assignP95,
    SubmitP95: result.summary.submitP95,
    SubmitP99: result.summary.submitP99,
  }));
  const headers = Object.keys(rows[0] || {
    Stage: '', Tester: '', Status: '', Clients: '', Rate: '', Sec: '', Opened: '', Peak: '', WsErr: '', HttpErr: '', RefErr: '', Ok: '', HsP95: '', HsP99: '', TileP95: '', TileP99: '', AssignP95: '', SubmitP95: '', SubmitP99: '',
  });
  const numeric = new Set(['Clients', 'Rate', 'Sec', 'Opened', 'Peak', 'WsErr', 'HttpErr', 'RefErr', 'Ok', 'HsP95', 'HsP99', 'TileP95', 'TileP99', 'AssignP95', 'SubmitP95', 'SubmitP99']);
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
    assignP95: last?.summary.firstTileP95 || last?.summary.assignP95 || 0,
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

async function captureCommand(command, args, { input = '', timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function buildHostMetricsScript({ port, workdir }) {
  return `
set -eu
PORT="${port}"
WORKDIR="${workdir}"
[ -d "$WORKDIR" ] || WORKDIR="."
cpu_total="$(awk '/^cpu / {for (i=2; i<=NF; i++) total+=$i; print total+0; exit}' /proc/stat 2>/dev/null || echo 0)"
cpu_idle="$(awk '/^cpu / {print $5+0; exit}' /proc/stat 2>/dev/null || echo 0)"
load_values="$(awk '{print $1" "$2" "$3; exit}' /proc/loadavg 2>/dev/null || echo "0 0 0")"
set -- $load_values
load1="$1"; load5="$2"; load15="$3"
mem_total_kb="$(awk '/MemTotal:/ {print $2+0; exit}' /proc/meminfo 2>/dev/null || echo 0)"
mem_avail_kb="$(awk '/MemAvailable:/ {print $2+0; exit}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$mem_total_kb" -gt 0 ]; then
  mem_used_pct="$(awk -v total="$mem_total_kb" -v avail="$mem_avail_kb" 'BEGIN { printf "%.2f", ((total-avail)/total)*100 }')"
else
  mem_used_pct="0"
fi
disk_free_pct="$(df -Pk "$WORKDIR" 2>/dev/null | awk 'END {gsub("%","",$5); printf "%.2f", 100-$5}' || echo 0)"
node_rss_kb="$(ps -eo rss=,comm=,args= 2>/dev/null | awk '/[n]ode/ && /server\\.js/ {sum+=$1} END {print sum+0}')"
nginx_rss_kb="$(ps -C nginx -o rss= --no-headers 2>/dev/null | awk '{sum+=$1} END {print sum+0}')"
node_proc_count="$(ps -eo comm=,args= 2>/dev/null | awk '/[n]ode/ && /server\\.js/ {count++} END {print count+0}')"
nginx_proc_count="$(ps -C nginx --no-headers 2>/dev/null | wc -l | tr -d ' ')"
node_cpu_pct="$(ps -eo %cpu=,comm=,args= 2>/dev/null | awk '/[n]ode/ && /server\\.js/ {sum+=$1} END {printf "%.2f", sum+0}')"
nginx_cpu_pct="$(ps -C nginx -o %cpu= --no-headers 2>/dev/null | awk '{sum+=$1} END {printf "%.2f", sum+0}')"
total_established="$(ss -Htan 2>/dev/null | awk '$1=="ESTAB" {count++} END {print count+0}')"
app_established="$(ss -Htan 2>/dev/null | awk -v p=":"PORT '$1=="ESTAB" && (index($4,p) || index($5,p)) {count++} END {print count+0}')"
web_established="$(ss -Htan 2>/dev/null | awk '$1=="ESTAB" && ($4 ~ /:80$|:443$/ || $5 ~ /:80$|:443$/) {count++} END {print count+0}')"
cat <<EOF
cpu_total=$cpu_total
cpu_idle=$cpu_idle
load1=$load1
load5=$load5
load15=$load15
mem_used_pct=$mem_used_pct
disk_free_pct=$disk_free_pct
node_rss_kb=$node_rss_kb
nginx_rss_kb=$nginx_rss_kb
node_proc_count=$node_proc_count
nginx_proc_count=$nginx_proc_count
node_cpu_pct=$node_cpu_pct
nginx_cpu_pct=$nginx_cpu_pct
total_established=$total_established
app_established=$app_established
web_established=$web_established
EOF
`;
}

function parseKeyValueOutput(stdout) {
  const parsed = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return parsed;
}

async function collectShellMetrics({ target = '', port, workdir }) {
  const script = buildHostMetricsScript({ port, workdir });
  const runner = target ? ['ssh', [target, 'sh', '-s']] : ['sh', ['-s']];
  const { stdout } = await captureCommand(runner[0], runner[1], { input: script });
  return parseKeyValueOutput(stdout);
}

class HostMonitor {
  constructor({ sampleMs = 1000, apiCheckMs = 5000 } = {}) {
    this.sampleMs = sampleMs;
    this.apiCheckMs = apiCheckMs;
    this.samples = [];
    this.timer = null;
    this.phase = 'run';
    this.prevCpu = { localGenerator: null, appHost: null };
    this.lastApiCheckAt = 0;
    this.lastApiHealthy = true;
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
  }

  computeCpuPct(scope, raw) {
    const total = Number(raw.cpu_total || 0);
    const idle = Number(raw.cpu_idle || 0);
    const prev = this.prevCpu[scope];
    this.prevCpu[scope] = { total, idle };
    if (!prev) return null;
    const totalDelta = total - prev.total;
    const idleDelta = idle - prev.idle;
    return totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
  }

  shapeHostMetrics(label, raw, cpuPct) {
    return {
      label,
      available: Object.keys(raw).length > 0,
      cpuPct,
      load1: Number(raw.load1 || 0),
      load5: Number(raw.load5 || 0),
      load15: Number(raw.load15 || 0),
      memUsedPct: Number(raw.mem_used_pct || 0),
      diskFreePct: Number(raw.disk_free_pct || 0),
      nodeRssMb: Number(raw.node_rss_kb || 0) / 1024 || 0,
      nginxRssMb: Number(raw.nginx_rss_kb || 0) / 1024 || 0,
      nodeProcCount: Number(raw.node_proc_count || 0),
      nginxProcCount: Number(raw.nginx_proc_count || 0),
      nodeCpuPct: Number(raw.node_cpu_pct || 0),
      nginxCpuPct: Number(raw.nginx_cpu_pct || 0),
      totalEstablished: Number(raw.total_established || 0),
      appEstablished: Number(raw.app_established || 0),
      webEstablished: Number(raw.web_established || 0),
    };
  }

  async sample() {
    const now = Date.now();
    const localRaw = await collectShellMetrics({ port: metricsPort, workdir: process.cwd() }).catch(() => ({}));
    const localGenerator = this.shapeHostMetrics('local-generator', localRaw, this.computeCpuPct('localGenerator', localRaw));
    let appHost = null;
    if (metricsHost) {
      const appRaw = await collectShellMetrics({ target: metricsHost, port: metricsPort, workdir: '/opt/crowd-canvas' }).catch(() => ({}));
      appHost = this.shapeHostMetrics(`app-host:${metricsHost}`, appRaw, this.computeCpuPct('appHost', appRaw));
    }

    if (now - this.lastApiCheckAt >= this.apiCheckMs) {
      this.lastApiCheckAt = now;
      try {
        const health = await getAdminState();
        this.lastApiHealthy = health.ok;
      } catch {
        this.lastApiHealthy = false;
      }
    }

    const sample = {
      ts: new Date(now).toISOString(),
      phase: this.phase,
      eventLoopP95Ms: this.loopDelay.percentile(95) / 1e6,
      apiHealthy: this.lastApiHealthy,
      localGenerator,
      appHost,
    };
    this.samples.push(sample);
    return sample;
  }

  async start(phase = 'run') {
    this.phase = phase;
    this.samples = [];
    this.prevCpu = { localGenerator: null, appHost: null };
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
  const summarizeScope = key => {
    let cpuStreak = 0;
    let longestCpuStreak = 0;
    let peakCpu = 0;
    let peakMem = 0;
    let peakRss = 0;
    let peakNginxRss = 0;
    let minDiskFree = 100;
    let peakLoad1 = 0;
    let peakLoad5 = 0;
    let peakLoad15 = 0;
    let peakNodeCpu = 0;
    let peakNginxCpu = 0;
    let peakTotalEstablished = 0;
    let peakAppEstablished = 0;
    let peakWebEstablished = 0;
    let peakNodeProcCount = 0;
    let peakNginxProcCount = 0;
    let sawAny = false;
    for (const sample of samples) {
      const scoped = sample[key];
      if (!scoped?.available) continue;
      sawAny = true;
      if (scoped.cpuPct !== null) {
        peakCpu = Math.max(peakCpu, scoped.cpuPct || 0);
        if ((scoped.cpuPct || 0) > BREAKPOINT_THRESHOLDS.cpuPct) cpuStreak += 1;
        else cpuStreak = 0;
        longestCpuStreak = Math.max(longestCpuStreak, cpuStreak);
      }
      peakMem = Math.max(peakMem, scoped.memUsedPct || 0);
      peakRss = Math.max(peakRss, scoped.nodeRssMb || 0);
      peakNginxRss = Math.max(peakNginxRss, scoped.nginxRssMb || 0);
      minDiskFree = Math.min(minDiskFree, scoped.diskFreePct ?? minDiskFree);
      peakLoad1 = Math.max(peakLoad1, scoped.load1 || 0);
      peakLoad5 = Math.max(peakLoad5, scoped.load5 || 0);
      peakLoad15 = Math.max(peakLoad15, scoped.load15 || 0);
      peakNodeCpu = Math.max(peakNodeCpu, scoped.nodeCpuPct || 0);
      peakNginxCpu = Math.max(peakNginxCpu, scoped.nginxCpuPct || 0);
      peakTotalEstablished = Math.max(peakTotalEstablished, scoped.totalEstablished || 0);
      peakAppEstablished = Math.max(peakAppEstablished, scoped.appEstablished || 0);
      peakWebEstablished = Math.max(peakWebEstablished, scoped.webEstablished || 0);
      peakNodeProcCount = Math.max(peakNodeProcCount, scoped.nodeProcCount || 0);
      peakNginxProcCount = Math.max(peakNginxProcCount, scoped.nginxProcCount || 0);
    }
    return {
      peakCpu,
      peakMem,
      peakRss,
      peakNginxRss,
      minDiskFree: minDiskFree === 100 && !sawAny ? null : minDiskFree,
      peakLoad1,
      peakLoad5,
      peakLoad15,
      peakNodeCpu,
      peakNginxCpu,
      peakTotalEstablished,
      peakAppEstablished,
      peakWebEstablished,
      peakNodeProcCount,
      peakNginxProcCount,
      cpuOverThresholdSeconds: longestCpuStreak,
      sawAny,
    };
  };

  const localGenerator = summarizeScope('localGenerator');
  const appHost = summarizeScope('appHost');
  let apiHealthyAll = true;
  let peakEventLoopP95 = 0;
  for (const sample of samples) {
    peakEventLoopP95 = Math.max(peakEventLoopP95, sample.eventLoopP95Ms || 0);
    apiHealthyAll = apiHealthyAll && sample.apiHealthy !== false;
  }
  return {
    localGenerator,
    appHost,
    effective: appHost.sawAny ? appHost : localGenerator,
    peakEventLoopP95,
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
  const errRate = stage.clients > 0
    ? (summary.wsConnErr + summary.httpErr + summary.refErr) / stage.clients
    : 0;
  const effectiveHost = hostSummary.effective;

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
  check(effectiveHost.cpuOverThresholdSeconds > BREAKPOINT_THRESHOLDS.cpuSeconds, 'cpu', `effective host CPU exceeded ${BREAKPOINT_THRESHOLDS.cpuPct}% for ${effectiveHost.cpuOverThresholdSeconds}s`);
  check(effectiveHost.peakMem > BREAKPOINT_THRESHOLDS.memoryUsedPct, 'memory', `effective host memory used ${effectiveHost.peakMem.toFixed(1)}% > ${BREAKPOINT_THRESHOLDS.memoryUsedPct}%`);
  check(Number.isFinite(BREAKPOINT_THRESHOLDS.nodeRssMaxMb) && effectiveHost.peakRss > BREAKPOINT_THRESHOLDS.nodeRssMaxMb, 'rss', `Node RSS ${effectiveHost.peakRss.toFixed(0)}MB > ${BREAKPOINT_THRESHOLDS.nodeRssMaxMb}MB`);
  check(hostSummary.peakEventLoopP95 > BREAKPOINT_THRESHOLDS.eventLoopP95Ms, 'event-loop', `event loop delay p95 ${hostSummary.peakEventLoopP95.toFixed(0)}ms > ${BREAKPOINT_THRESHOLDS.eventLoopP95Ms}ms`);
  check(effectiveHost.minDiskFree !== null && effectiveHost.minDiskFree < BREAKPOINT_THRESHOLDS.diskFreePct, 'disk', `disk free ${effectiveHost.minDiskFree.toFixed(1)}% < ${BREAKPOINT_THRESHOLDS.diskFreePct}%`);

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

function buildBreakpointSteps() {
  return buildBreakpointStepsList({
    start: breakpointStart,
    max: breakpointMax,
    growth: breakpointGrowth,
    step: breakpointStep,
  });
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
    const script = tester === 'loadtest2' ? 'loadtest2.js' : 'loadtest.js';
    const baseTarget = apiBase.toString().replace(/\/$/, '');
    const cmdArgs = tester === 'loadtest2'
      ? [
          script,
          baseTarget,
          '--clients', String(stage.clients),
          '--rate', String(stage.rate),
          '--draw-min', String(stage.drawMin),
          '--draw-max', String(stage.drawMax),
          '--duration', String(stage.duration),
          '--mode', stage.name.startsWith('storm') ? 'storm' : 'full',
        ]
      : [
          script,
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
  return isRecoveryHealthy({
    stateOk: state.ok,
    apiHealthy: recent?.apiHealthy,
    hostMetrics: pickRecoveryHostMetrics(recent),
    cpuThreshold: BREAKPOINT_THRESHOLDS.cpuPct,
    memoryThreshold: BREAKPOINT_THRESHOLDS.memoryUsedPct,
  });
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

  const tableRows = steps.map(step => `| ${step.users} | ${step.result.toUpperCase()} | ${(step.connRate * 100).toFixed(1)}% | ${(step.submitRate * 100).toFixed(1)}% | ${(step.discRate * 100).toFixed(1)}% | ${step.summary.wsConnErr} | ${step.summary.httpErr} | ${step.summary.refErr} | ${step.summary.handshakeP95}ms | ${step.summary.handshakeP99}ms | ${(step.summary.firstTileP95 || step.summary.assignP95)}ms | ${(step.summary.firstTileP99 || step.summary.assignP99)}ms | ${step.summary.submitP95}ms | ${step.summary.submitP99}ms | ${step.host.localGenerator.peakCpu.toFixed(1)}% | ${step.host.localGenerator.peakLoad1.toFixed(2)} | ${step.host.localGenerator.peakRss ? step.host.localGenerator.peakRss.toFixed(0) + 'MB' : '-'} | ${step.host.localGenerator.peakAppEstablished || 0} | ${step.host.appHost.sawAny ? step.host.appHost.peakCpu.toFixed(1) + '%' : '-'} | ${step.host.appHost.sawAny ? step.host.appHost.peakLoad1.toFixed(2) : '-'} | ${step.host.appHost.sawAny && step.host.appHost.peakRss ? step.host.appHost.peakRss.toFixed(0) + 'MB' : '-'} | ${step.host.appHost.sawAny ? step.host.appHost.peakAppEstablished : '-'} | ${step.bottleneck} |`).join('\n');
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
- Effective host metrics source: ${metricsHost ? `remote app host via SSH (${metricsHost})` : 'local generator only'}

## Tested Points

${steps.map(step => `- ${step.users} users: ${step.result.toUpperCase()}`).join('\n')}

## Bottleneck Evidence

${finalEvidence.length ? finalEvidence.map(item => `- ${item}`).join('\n') : '- No failure evidence recorded.'}

## Breakpoint Table

| users | result | conn success | submit success | disconnects | ws err | http err | ref err | hs p95 | hs p99 | tile p95 | tile p99 | submit p95 | submit p99 | generator CPU | generator load1 | generator RSS | generator app sockets | app CPU | app load1 | app RSS | app sockets | bottleneck |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
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
  const rows = ['users,result,conn_success_rate,submit_success_rate,disconnect_rate,error_rate,ws_conn_err,http_err,ref_err,handshake_p95_ms,handshake_p99_ms,first_tile_p95_ms,first_tile_p99_ms,assign_p95_ms,assign_p99_ms,submit_p95_ms,submit_p99_ms,generator_cpu_peak_pct,generator_load1_peak,generator_mem_peak_pct,generator_node_rss_peak_mb,generator_nginx_rss_peak_mb,generator_total_sockets_peak,generator_app_sockets_peak,generator_web_sockets_peak,generator_node_proc_peak,generator_nginx_proc_peak,app_host_cpu_peak_pct,app_host_load1_peak,app_host_mem_peak_pct,app_host_node_rss_peak_mb,app_host_nginx_rss_peak_mb,app_host_total_sockets_peak,app_host_app_sockets_peak,app_host_web_sockets_peak,app_host_node_proc_peak,app_host_nginx_proc_peak,event_loop_p95_ms,disk_free_min_pct,bottleneck,reason'];
  for (const step of steps) {
    rows.push([
      step.users,
      step.result,
      step.connRate.toFixed(4),
      step.submitRate.toFixed(4),
      step.discRate.toFixed(4),
      step.errRate.toFixed(4),
      step.summary.wsConnErr,
      step.summary.httpErr,
      step.summary.refErr,
      step.summary.handshakeP95,
      step.summary.handshakeP99,
      step.summary.firstTileP95 || step.summary.assignP95,
      step.summary.firstTileP99 || step.summary.assignP99,
      step.summary.assignP95,
      step.summary.assignP99,
      step.summary.submitP95,
      step.summary.submitP99,
      step.host.localGenerator.peakCpu.toFixed(2),
      step.host.localGenerator.peakLoad1.toFixed(2),
      step.host.localGenerator.peakMem.toFixed(2),
      step.host.localGenerator.peakRss?.toFixed?.(2) ?? '',
      step.host.localGenerator.peakNginxRss?.toFixed?.(2) ?? '',
      step.host.localGenerator.peakTotalEstablished,
      step.host.localGenerator.peakAppEstablished,
      step.host.localGenerator.peakWebEstablished,
      step.host.localGenerator.peakNodeProcCount,
      step.host.localGenerator.peakNginxProcCount,
      step.host.appHost.peakCpu?.toFixed?.(2) ?? '',
      step.host.appHost.peakLoad1?.toFixed?.(2) ?? '',
      step.host.appHost.peakMem?.toFixed?.(2) ?? '',
      step.host.appHost.peakRss?.toFixed?.(2) ?? '',
      step.host.appHost.peakNginxRss?.toFixed?.(2) ?? '',
      step.host.appHost.peakTotalEstablished ?? '',
      step.host.appHost.peakAppEstablished ?? '',
      step.host.appHost.peakWebEstablished ?? '',
      step.host.appHost.peakNodeProcCount ?? '',
      step.host.appHost.peakNginxProcCount ?? '',
      step.host.peakEventLoopP95.toFixed(2),
      step.host.effective.minDiskFree?.toFixed?.(2) ?? '',
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

    const cpuText = hostSummary.effective.peakCpu ? `cpu=${hostSummary.effective.peakCpu.toFixed(0)}%` : 'cpu=n/a';
    const rssText = hostSummary.effective.peakRss ? `rss=${hostSummary.effective.peakRss.toFixed(0)}MB` : 'rss=n/a';
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
echoLine(`Tester: ${tester}`);
echoLine(`Host metrics: local generator${metricsHost ? ` + app host via SSH (${metricsHost})` : ' only'}`);
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
