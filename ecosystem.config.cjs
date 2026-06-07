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
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '127.0.0.1',
      ADMIN_TOKEN: process.env.ADMIN_TOKEN,
      // Optional render-worker sizing overrides.
      // Example fixed size: RENDER_WORKERS=4
      // Example automatic cap: RENDER_WORKERS_MAX=6
      RENDER_WORKERS: process.env.RENDER_WORKERS,
      RENDER_WORKERS_MAX: process.env.RENDER_WORKERS_MAX || 6,
      // Sharp uses libuv's thread pool for all native async ops.
      // Default is 4 threads — far too low for 600 concurrent Sharp decodes/second.
      // On an AX102 (16 cores / 32 threads) 16 is a safe, well-benchmarked value.
      UV_THREADPOOL_SIZE: 16,
    },
    // AX102 has 128 GB RAM; the accumulator for 5000 tiles peaks at ~1.3 GB.
    // Set ceiling well above that so PM2 doesn't restart mid-event.
    max_memory_restart: '6G',
  }],
};
