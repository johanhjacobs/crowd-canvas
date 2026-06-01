module.exports = {
  apps: [{
    name: 'crowd-canvas',
    script: 'server.js',
    cwd: '/opt/crowd-canvas',
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: 3100 }
  }]
};
