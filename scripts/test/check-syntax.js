import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const excludedDirs = new Set(['node_modules', 'data', 'logs', 'reports', '.git', '.indigo']);
const rootFiles = [
  'server.js',
  'render-worker.js',
  'loadtest.js',
  'loadtest2.js',
  'loadtest-matrix.js',
];

function formatMs(ms) {
  return `${ms.toFixed(1)}ms`;
}

async function walkJsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) continue;
      found.push(...await walkJsFiles(path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

async function checkFile(filePath) {
  const relative = path.relative(projectRoot, filePath);
  console.log(`Checking ${relative}`);
  const started = process.hrtime.bigint();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', filePath], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const status = exitCode === 0 ? 'PASS' : 'FAIL';
  console.log(`${status} ${relative} (${formatMs(durationMs)})`);
  return { file: relative, status, durationMs, exitCode };
}

async function main() {
  const files = [
    ...rootFiles.map(file => path.join(projectRoot, file)),
    ...await walkJsFiles(path.join(projectRoot, 'scripts')),
  ];
  const uniqueFiles = [...new Set(files)].sort((a, b) => a.localeCompare(b));

  const results = [];
  for (const filePath of uniqueFiles) {
    results.push(await checkFile(filePath));
  }

  console.log('\nSyntax Check Summary');
  console.table(results.map(result => ({
    file: result.file,
    status: result.status,
    duration: formatMs(result.durationMs),
  })));

  if (results.some(result => result.exitCode !== 0)) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
