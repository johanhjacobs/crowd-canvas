#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

function usage() {
  console.log(`Usage:
  node loadtest-matrix.js <ws-url> [options]

Options:
  --max-clients N      Highest client count to test (default 20000)
  --rate N             Connection ramp per second for realistic stages (default 300)
  --storm-rate N       Connection ramp per second for storm stages (default 1000)
  --draw-min S         Minimum draw time in seconds (default 20)
  --draw-max S         Maximum draw time in seconds (default 40)
  --tiles N            Tiles per player, 0 = keep drawing (default 0)
  --hold false         Close connections after finishing (default true)
  --insecure           Accept self-signed TLS certs
  --image FILE         Upload this image before running the matrix
  --pieces N           Slice target piece count for auto-created sessions (default 400)
  --redundancy N       Players per piece for auto-created sessions (default 3)
  --include-solid-black Include solid black tiles when slicing
  --no-reset-each-stage Reuse the same session across all stages
  --no-stop-on-fail    Continue matrix after a failed stage
  --output FILE        Write full run output to a specific file

Example:
  node loadtest-matrix.js ws://127.0.0.1:3000/ws --max-clients 20000
`);
}

const args = process.argv.slice(2);
const targetUrl = args.find(arg => !arg.startsWith('--'));
if (!targetUrl || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(targetUrl ? 0 : 1);
}

function getOpt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const maxClients = Number(getOpt('max-clients', 20000));
const realisticRate = Number(getOpt('rate', 300));
const stormRate = Number(getOpt('storm-rate', 1000));
const drawMin = Number(getOpt('draw-min', 20));
const drawMax = Number(getOpt('draw-max', 40));
const tiles = Number(getOpt('tiles', 0));
const hold = getOpt('hold', 'true') !== 'false';
const insecure = Boolean(getOpt('insecure', false));
const imagePath = getOpt('image', '');
const pieces = Number(getOpt('pieces', 400));
const redundancy = Number(getOpt('redundancy', 3));
const includeSolidBlack = Boolean(getOpt('include-solid-black', false));
const resetEachStage = !args.includes('--no-reset-each-stage');
const stopOnFail = !args.includes('--no-stop-on-fail');
const outputFileArg = getOpt('output', '');

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const logsDir = path.join(process.cwd(), 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const outputFile = outputFileArg
  ? path.resolve(process.cwd(), String(outputFileArg))
  : path.join(logsDir, `loadtest-matrix-${stamp()}.log`);

const logStream = fs.createWriteStream(outputFile, { flags: 'a' });

function writeLog(text = '') {
  logStream.write(text);
}

function echo(text = '') {
  process.stdout.write(text);
  writeLog(text);
}

function echoLine(text = '') {
  echo(text + '\n');
}

function buildStages(limit) {
  const sizes = [200, 1000, 2000, 5000, 10000, 15000, 20000].filter(n => n <= limit);
  const stages = [];

  if (sizes.length) {
    stages.push({
      name: 'smoke',
      clients: sizes[0],
      rate: Math.min(100, realisticRate),
      duration: 60,
      drawMin: 20,
      drawMax: 40,
      tiles: 3,
      hold,
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
      hold,
    });
  }

  for (const n of sizes) {
    if (n === sizes[0]) continue;
    stages.push({
      name: `real-${n}`,
      clients: n,
      rate: realisticRate,
      duration: n >= 10000 ? 180 : 120,
      drawMin,
      drawMax,
      tiles,
      hold,
    });
  }

  return stages;
}

function httpProbe(urlString) {
  return new Promise(resolve => {
    let probeUrl;
    try {
      probeUrl = new URL(urlString.replace(/^ws/, 'http'));
    } catch {
      resolve({ ok: false, status: 'bad-url' });
      return;
    }
    probeUrl.pathname = '/api/config';
    probeUrl.search = '';
    const client = probeUrl.protocol === 'https:' ? https : http;
    const req = client.get(probeUrl, res => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode });
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', err => resolve({ ok: false, status: err.message }));
  });
}

function baseHttpUrl(urlString) {
  const u = new URL(urlString.replace(/^ws/, 'http'));
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u;
}

const apiBase = baseHttpUrl(targetUrl);

async function apiJson(pathname, init = {}) {
  const url = new URL(pathname, apiBase);
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function getAdminState() {
  return apiJson('/api/state');
}

async function createOrReuseSession() {
  const form = new FormData();
  form.set('pieces', String(pieces));
  form.set('redundancy', String(redundancy));
  form.set('includeSolidBlack', String(includeSolidBlack));

  if (imagePath) {
    const fileBuf = fs.readFileSync(path.resolve(process.cwd(), String(imagePath)));
    const blob = new Blob([fileBuf]);
    form.set('image', blob, path.basename(String(imagePath)));
  }

  return apiJson('/api/session', { method: 'POST', body: form });
}

async function restartSession() {
  return apiJson('/api/session/restart', { method: 'POST' });
}

async function prepareStageSession(stage, isFirstStage) {
  const state = await getAdminState();
  const shouldCreateFresh = isFirstStage || !resetEachStage || !state.ok || !state.body?.active;

  if (shouldCreateFresh) {
    const result = await createOrReuseSession();
    if (!result.ok) {
      throw new Error(`Could not create/reuse session before ${stage.name}: ${JSON.stringify(result.body)}`);
    }
    return { mode: 'session', details: result.body };
  }

  const restarted = await restartSession();
  if (restarted.ok) {
    return { mode: 'restart', details: restarted.body };
  }

  const created = await createOrReuseSession();
  if (!created.ok) {
    throw new Error(`Could not reset session before ${stage.name}: restart=${JSON.stringify(restarted.body)} create=${JSON.stringify(created.body)}`);
  }
  return { mode: 'session', details: created.body };
}

function parseSummary(output) {
  const summary = {
    opened: 0,
    peakLive: 0,
    closed: 0,
    errors: 0,
    sent: 0,
    accepted: 0,
    rejected: 0,
    inflight: 0,
    avg: 0,
    p95: 0,
    p99: 0,
    samples: 0,
  };

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

  const latency = output.match(/latency\s+avg=(\d+)ms\s+p95=(\d+)ms\s+p99=(\d+)ms\s+\((\d+)\s+samples\)/);
  if (latency) {
    summary.avg = Number(latency[1]);
    summary.p95 = Number(latency[2]);
    summary.p99 = Number(latency[3]);
    summary.samples = Number(latency[4]);
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
  if (summary.samples === 0 && summary.accepted === 0) return 'WARN';
  if (summary.p95 > 2000 || summary.avg > 500) return 'WARN';
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
    AvgMs: result.summary.avg,
    P95Ms: result.summary.p95,
    P99Ms: result.summary.p99,
  }));

  const headers = Object.keys(rows[0] || {
    Stage: '', Status: '', Clients: '', Rate: '', Sec: '', Opened: '', Peak: '', Err: '', Ok: '', AvgMs: '', P95Ms: '', P99Ms: '',
  });
  const numeric = new Set(['Clients', 'Rate', 'Sec', 'Opened', 'Peak', 'Err', 'Ok', 'AvgMs', 'P95Ms', 'P99Ms']);
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

function runStage(stage) {
  return new Promise(resolve => {
    const cmdArgs = [
      'loadtest.js',
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
      echo(text);
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
      resolve({ stage, exitCode: code ?? 1, summary, status });
    });
  });
}

const probe = await httpProbe(targetUrl);
if (!probe.ok) {
  const line1 = `Preflight failed: could not reach ${targetUrl.replace(/^ws/, 'http')} (${probe.status}).`;
  const line2 = 'Start the server first and upload a test image in the admin before running the matrix.';
  console.error(line1);
  console.error(line2);
  writeLog(line1 + '\n' + line2 + '\n');
  logStream.end();
  process.exit(2);
}

echoLine(`Load-test log file: ${outputFile}`);
echoLine(`Preflight OK: /api/config responded with status ${probe.status}`);
echoLine(`Session prep: ${imagePath ? `will upload ${imagePath}` : 'will reuse the previous uploaded image'}; pieces=${pieces}; redundancy=${redundancy}; resetEachStage=${resetEachStage}`);
echoLine('Reminder: automatic session prep is enabled; open the admin only if you want to watch the board.\n');

const stages = buildStages(maxClients);
const results = [];
for (let i = 0; i < stages.length; i++) {
  const stage = stages[i];
  try {
    const prep = await prepareStageSession(stage, i === 0);
    echoLine(`Prepared session for ${stage.name} via ${prep.mode}.`);
  } catch (error) {
    const msg = `\nStopping before ${stage.name}: ${error.message || error}`;
    echoLine(msg);
    results.push({
      stage,
      exitCode: 1,
      summary: { opened: 0, peakLive: 0, closed: 0, errors: 0, sent: 0, accepted: 0, rejected: 0, inflight: 0, avg: 0, p95: 0, p99: 0, samples: 0 },
      status: 'FAIL',
    });
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
echoLine(`\nSummary: ${passCount} PASS, ${warnCount} WARN, ${failCount} FAIL`);
logStream.end();
if (failCount > 0) process.exit(1);
if (warnCount > 0) process.exit(2);
