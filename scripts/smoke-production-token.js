import { spawn } from 'child_process';
import assert from 'assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '34999',
      ADMIN_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('production fail-closed smoke test timed out'));
    }, 5000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  assert.notEqual(exitCode, 0, 'server should refuse to start in production without ADMIN_TOKEN');
  assert.match(output, /ADMIN_TOKEN is required when NODE_ENV=production/i);
  console.log('production ADMIN_TOKEN fail-closed smoke test passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
