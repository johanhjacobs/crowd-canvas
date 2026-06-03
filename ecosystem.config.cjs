// pm2 process config for Crowd Canvas.
// IMPORTANT: single instance, fork mode. The app keeps all game state in memory
// in one process — cluster mode or multiple instances would desync the mosaic.
module.exports = {
  apps: [{
    name: 'crowd-canvas',
    script: 'server.js',
    exec_mode: 'fork',
    instances: 1,
    env: {
      PORT: 3100,
      HOST: '127.0.0.1',
    },
    // restart if memory runs away during a very large event
    max_memory_restart: '2G',
  }],
};
