import { spawn } from 'child_process';
import { once } from 'events';
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = 34000 + Math.floor(Math.random() * 1000);
const ADMIN_TOKEN = 'smoke-admin-token';
const BASE_URL = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const ADMIN_WS_PROTOCOL = 'crowd-canvas-admin';
const ADMIN_WS_TOKEN_PREFIX = 'admin-token.';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crowd-canvas-smoke-'));
const VALID_PNG = await sharp({
  create: {
    width: 64,
    height: 64,
    channels: 3,
    background: '#ffffff',
  },
}).composite([
  { input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="8" y="8" width="48" height="48" fill="#000"/></svg>') },
]).png().toBuffer();
const MALFORMED_PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]).toString('base64');

function encodeAdminWsToken(token) {
  return ADMIN_WS_TOKEN_PREFIX + Buffer.from(token, 'utf8').toString('base64url');
}

async function waitForServerReady(baseUrl, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/state`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('server did not start in time');
}

async function expectHttpStatus(path, expectedStatus, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${BASE_URL}${path}`, { headers });
  assert.equal(response.status, expectedStatus, `${path} should return ${expectedStatus}`);
  return response;
}

async function expectJsonPostStatus(path, expectedStatus, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(response.status, expectedStatus, `${path} should return ${expectedStatus}`);
  return response;
}

async function createSession({ pieces = 16, redundancy = 1 } = {}) {
  const form = new FormData();
  form.append('image', new Blob([VALID_PNG], { type: 'image/png' }), 'smoke.png');
  form.append('pieces', String(pieces));
  form.append('redundancy', String(redundancy));
  const response = await fetch(`${BASE_URL}/api/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: form,
  });
  return response;
}

async function expectPlayerWsPublic() {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error('player websocket timed out')), 5000);
    ws.on('message', raw => {
      const message = JSON.parse(String(raw));
      try {
        if (message.type === 'config') return;
        assert.ok(['waiting', 'wait', 'done', 'tile'].includes(message.type), `unexpected player message: ${message.type}`);
        clearTimeout(timer);
        ws.close();
        resolve();
      } catch (error) {
        clearTimeout(timer);
        ws.close();
        reject(error);
      }
    });
    ws.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function expectAdminWsRejected(token) {
  await new Promise((resolve, reject) => {
    const protocols = token ? [ADMIN_WS_PROTOCOL, encodeAdminWsToken(token)] : [ADMIN_WS_PROTOCOL];
    const ws = new WebSocket(`${WS_URL}?role=admin`, protocols);
    const timer = setTimeout(() => reject(new Error('admin websocket rejection timed out')), 5000);
    ws.once('unexpected-response', (_, response) => {
      try {
        assert.equal(response.statusCode, 401, 'admin websocket should return 401');
        clearTimeout(timer);
        resolve();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error('admin websocket unexpectedly opened'));
    });
    ws.once('error', () => {});
  });
}

async function expectAdminWsAccepted() {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?role=admin`, [
      ADMIN_WS_PROTOCOL,
      encodeAdminWsToken(ADMIN_TOKEN),
    ]);
    const timer = setTimeout(() => reject(new Error('admin websocket accept timed out')), 5000);
    ws.on('message', raw => {
      const message = JSON.parse(String(raw));
      try {
        assert.ok(['state', 'config', 'view-sidebar-width', 'view-colors', 'view-sidebar'].includes(message.type), `unexpected admin message: ${message.type}`);
        clearTimeout(timer);
        ws.close();
        resolve();
      } catch (error) {
        clearTimeout(timer);
        ws.close();
        reject(error);
      }
    });
    ws.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function expectMalformedSubmissionRejected() {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error('malformed submission test timed out')), 5000);
    let tileId = null;
    ws.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'config') return;
      if (message.type === 'tile') {
        tileId = message.tileId;
        ws.send(JSON.stringify({ type: 'submit', tileId, png: MALFORMED_PNG_DATA_URL }));
        return;
      }
      if (message.type === 'rejected') {
        try {
          assert.equal(message.reason, 'invalid-png');
          clearTimeout(timer);
          ws.close();
          resolve();
        } catch (error) {
          clearTimeout(timer);
          ws.close();
          reject(error);
        }
      }
    });
    ws.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      HOST,
      PORT: String(PORT),
      ADMIN_TOKEN,
      DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  try {
    await waitForServerReady(BASE_URL);
    await expectHttpStatus('/api/state', 401);
    await expectHttpStatus('/api/state', 401, 'wrong-token');
    const validStateResponse = await expectHttpStatus('/api/state', 200, ADMIN_TOKEN);
    const adminState = await validStateResponse.json();
    assert.equal(typeof adminState.active, 'boolean', 'admin state should be JSON');
    await expectJsonPostStatus('/api/config', 401, null, { minCoverage: 0.5 });
    await expectJsonPostStatus('/api/config', 401, 'wrong-token', { minCoverage: 0.5 });
    await expectJsonPostStatus('/api/config', 200, ADMIN_TOKEN, { minCoverage: 0.5 });
    await expectHttpStatus('/api/export.png', 401);
    await expectHttpStatus('/api/overlay.png', 401);
    assert.equal((await createSession({ pieces: 'abc' })).status, 400, 'invalid pieces should be rejected');
    assert.equal((await createSession({ pieces: 9000 })).status, 400, 'excessive pieces should be rejected');
    assert.equal((await createSession({ pieces: 16, redundancy: 0 })).status, 400, 'invalid redundancy should be rejected');
    assert.equal((await createSession({ pieces: 16, redundancy: 11 })).status, 400, 'excessive redundancy should be rejected');
    const validSession = await createSession({ pieces: 16, redundancy: 1 });
    assert.equal(validSession.status, 200, 'valid session should be created');
    await expectPlayerWsPublic();
    await expectAdminWsRejected();
    await expectAdminWsRejected('wrong-token');
    await expectAdminWsAccepted();
    await expectMalformedSubmissionRejected();
    const postRejectState = await expectHttpStatus('/api/state', 200, ADMIN_TOKEN);
    const postRejectJson = await postRejectState.json();
    const counted = postRejectJson.tiles.reduce((sum, tile) => sum + (tile.subs || 0), 0);
    assert.equal(counted, 0, 'malformed submissions must not be counted');
    console.log('admin auth smoke test passed');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    if (stderr.trim()) process.stderr.write(stderr);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
