import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const tests = [
  {
    name: 'admin-auth',
    path: path.join(projectRoot, 'scripts', 'smoke', 'smoke-admin-auth.js'),
  },
  {
    name: 'production-token',
    path: path.join(projectRoot, 'scripts', 'smoke', 'smoke-production-token.js'),
  },
  {
    name: 'loadtest2-normalization',
    path: path.join(projectRoot, 'scripts', 'smoke', 'smoke-loadtest2-normalization.js'),
  },
  {
    name: 'breakpoint-recovery',
    path: path.join(projectRoot, 'scripts', 'smoke', 'smoke-breakpoint-recovery.js'),
  },
  {
    name: 'render-worker-sizing',
    path: path.join(projectRoot, 'scripts', 'smoke', 'smoke-render-worker-sizing.js'),
  },
];

function usage() {
  console.log('Usage: node scripts/test/run-smoke.js [--no-bail] [--only <name>] [--list]');
}

function parseArgs(argv) {
  let bail = true;
  let only = null;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-bail') {
      bail = false;
      continue;
    }
    if (arg === '--only') {
      only = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--list') {
      list = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }
  return { bail, only, list };
}

function formatMs(ms) {
  return `${ms.toFixed(1)}ms`;
}

function printSummary(results) {
  console.log('\nSmoke Test Summary');
  console.table(results.map(result => ({
    test: result.name,
    status: result.status,
    duration: formatMs(result.durationMs),
  })));
}

async function runTest(test) {
  console.log(`\n=== Smoke: ${test.name} ===`);
  const started = process.hrtime.bigint();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [test.path], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const status = exitCode === 0 ? 'PASS' : 'FAIL';
  console.log(`${status} ${test.name} (${formatMs(durationMs)})`);
  return { name: test.name, status, durationMs, exitCode };
}

async function main() {
  const { bail, only, list } = parseArgs(process.argv.slice(2));

  if (list) {
    console.log('Available smoke tests:');
    for (const test of tests) console.log(`- ${test.name}`);
    return;
  }

  const selected = only ? tests.filter(test => test.name === only) : tests;
  if (only && selected.length === 0) {
    console.error(`Unknown smoke test: ${only}`);
    console.log('Available smoke tests:');
    for (const test of tests) console.log(`- ${test.name}`);
    process.exit(1);
  }

  const results = [];
  for (const test of selected) {
    const result = await runTest(test);
    results.push(result);
    if (result.exitCode !== 0 && bail) break;
  }

  printSummary(results);

  if (results.some(result => result.exitCode !== 0)) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
