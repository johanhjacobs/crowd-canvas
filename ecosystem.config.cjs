// pm2 process config for Crowd Canvas.
// IMPORTANT: single instance, fork mode. The app keeps all game state in memory
// in one process — cluster mode or multiple instances would desync the mosaic.

// Secrets live OUTSIDE git in a .env file (gitignored). On the server create
//   /opt/crowd-canvas/.env  with:  ADMIN_TOKEN=<run: openssl rand -hex 32>
// Never put the token directly in this file — it is tracked by git.
const fs = require('fs');
const path = require('path');
function loadEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* no .env — ADMIN_TOKEN stays empty */ }
  return out;
}
const env = loadEnv('.env');
if (!env.ADMIN_TOKEN && !process.env.ADMIN_TOKEN) {
  console.warn('[ecosystem] no ADMIN_TOKEN in .env — admin API will be OPEN!');
}

module.exports = {
  apps: [{
    name: 'crowd-canvas',
    script: 'server.js',
    exec_mode: 'fork',   // MUST stay fork — cluster mode would desync in-memory state
    instances: 1,
    env: {
      PORT: 3100,
      HOST: '127.0.0.1',
      // Admin token — loaded from the untracked .env (or the shell env).
      // It protects all admin endpoints and the admin WebSocket.
      ADMIN_TOKEN: env.ADMIN_TOKEN || process.env.ADMIN_TOKEN || '',
      // Obfuscation slug for the admin / view / seed URLs (e.g. 'dropveters').
      // Kept in .env so the real slug isn't pinned in source.
      OBFUSCATION_SLUG: env.OBFUSCATION_SLUG || process.env.OBFUSCATION_SLUG || 'dropveters',
      // Sharp uses libuv's thread pool for all native async ops.
      // Default is 4 threads — far too low for 600 concurrent Sharp decodes/second.
      // On an AX102 (16 cores / 32 threads) 16 is a safe, well-benchmarked value.
      UV_THREADPOOL_SIZE: 8,
    },
    // AX102 has 128 GB RAM; the accumulator for 5000 tiles peaks at ~1.3 GB.
    // Set ceiling well above that so PM2 doesn't restart mid-event.
    max_memory_restart: '16G',
  }],
};
