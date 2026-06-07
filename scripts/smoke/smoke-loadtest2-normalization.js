import assert from 'assert/strict';
import { normalizeLoadtest2Target } from '../../loadtest2.js';

function check(raw, expectedBase, expectedWs) {
  const actual = normalizeLoadtest2Target(raw);
  assert.deepEqual(actual, { base: expectedBase, wsUrl: expectedWs });
}

check('https://example.com', 'https://example.com', 'wss://example.com/ws?role=player');
check('https://example.com/', 'https://example.com', 'wss://example.com/ws?role=player');
check('wss://example.com/ws', 'https://example.com', 'wss://example.com/ws?role=player');
check('ws://127.0.0.1:3000/ws', 'http://127.0.0.1:3000', 'ws://127.0.0.1:3000/ws?role=player');
check('127.0.0.1:3000', 'https://127.0.0.1:3000', 'wss://127.0.0.1:3000/ws?role=player');

console.log('loadtest2 URL normalization smoke test passed');
