// pm2 process config for Crowd Canvas.
// IMPORTANT: single instance, fork mode. The app keeps all game state in memory
// in one process — cluster mode or multiple instances would desync the mosaic.
module.exports = {
  apps: [{
    name: 'crowd-canvas',
    script: 'server.js',
    exec_mode: 'fork',   // MUST stay fork — cluster mode would desync in-memory state
    instances: 1,
    env: {
      PORT: 3100,
      HOST: '127.0.0.1',
      // Generate once with: openssl rand -hex 32
      // Keep this secret — it protects all admin and view endpoints.
      ADMIN_TOKEN: '92b437d9d8f65e6f494a5eae64bfa2e9cf9cc6e02114b6fb1b2d92ec2395d3fc',
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
