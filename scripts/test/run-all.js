import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const steps = [
  { name: 'syntax', command: process.execPath, args: [path.join(projectRoot, 'scripts', 'test', 'check-syntax.js')] },
  { name: 'smoke', command: process.execPath, args: [path.join(projectRoot, 'scripts', 'test', 'run-smoke.js')] },
  { name: 'audit', command: 'npm', args: ['audit', '--omit=dev'] },
];

function formatMs(ms) {
  return `${ms.toFixed(1)}ms`;
}

async function runStep(step) {
  console.log(`\n=== Test Step: ${step.name} ===`);
  const started = process.hrtime.bigint();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const status = exitCode === 0 ? 'PASS' : 'FAIL';
  console.log(`${status} ${step.name} (${formatMs(durationMs)})`);
  return { name: step.name, status, durationMs, exitCode };
}

async function main() {
  const results = [];
  for (const step of steps) {
    const result = await runStep(step);
    results.push(result);
    if (result.exitCode !== 0) break;
  }

  console.log('\nFull Test Summary');
  console.table(results.map(result => ({
    step: result.name,
    status: result.status,
    duration: formatMs(result.durationMs),
  })));

  if (results.some(result => result.exitCode !== 0)) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
