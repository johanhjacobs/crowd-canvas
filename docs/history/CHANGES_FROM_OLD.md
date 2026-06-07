# Changes Compared To `../old/crowd-canvas-main`

This summary focuses on source-code and documentation changes only. It intentionally ignores
runtime/generated content such as `data/`, `logs/`, `node_modules/`, and `.indigo/`.

## Files Added

- `loadtest-matrix.js`
- `render-worker.js`

## Files Changed

- `package.json`
- `README.md`
- `server.js`
- `public/view.html`

## Summary

The current workspace differs from `../old/crowd-canvas-main` in four main ways:

1. A new staged load-test runner was added.
2. The server now uses worker threads for render/decode work.
3. Submission persistence was changed to use batched SQLite writes.
4. The view now fetches live tile PNGs by versioned URL instead of receiving inline PNG payloads.

## Detailed Source Changes

### `package.json`

Added one npm script:

- `"loadtest:matrix": "node loadtest-matrix.js"`

### `loadtest-matrix.js` (new)

New staged load-test runner with:

- smoke, storm, and realistic ramp stages
- automatic preflight against `/api/config`
- automatic log-file creation in `logs/`
- optional `--output FILE`
- automatic session/image prep through the app API
- optional session restart between stages
- final PASS/WARN/FAIL matrix summary

Key flags:

- `--max-clients`
- `--rate`
- `--storm-rate`
- `--image`
- `--pieces`
- `--redundancy`
- `--include-solid-black`
- `--no-reset-each-stage`
- `--no-stop-on-fail`
- `--output`

### `README.md`

Extended the load-testing documentation to cover:

- `loadtest-matrix.js` in the project structure
- automatic logging to `logs/`
- automatic session prep
- example commands using local files such as `data/JAN.png`
- interpretation of `err`, `ok`, `inflight`, `wait`, `done`, `avg`, `p95`, `p99`
- a practical local test workflow

### `server.js`

The server changed materially compared to `old`.

#### 1. Worker-thread render pipeline

Added:

- `import os from 'os'`
- `import { Worker } from 'worker_threads'`
- render worker count calculation:
  - `RENDER_WORKERS`
- `RenderWorkerPool`
- worker-backed helpers for:
  - PNG decode to ink mask
  - accumulator rendering to blended/live PNGs

#### 2. Batched submission writes

Added batched SQLite submission persistence:

- prepared insert statement for `submissions`
- transactional batch insert
- in-memory submission write queue
- flush timer and flush promise

Helpers added:

- `scheduleSubmissionFlush()`
- `queueSubmissionWrite()`
- `flushSubmissionWrites()`

#### 3. Hot-path / backpressure tracking

Added:

- `SUBMISSION_DB_FLUSH_MS`
- `HOT_QUEUE_SOFT_LIMIT`
- `hotPathDepth()`
- `isHotPathBusy()`

These support queue-depth awareness on the submission/render path.

#### 4. Session/reset/render bookkeeping

Added:

- `sessionEpoch`
- `pendingSubmissionRenders`
- `tileRenderChains`
- `autoFillTimers`
- `clearAutoFillTimers()`
- `bumpSessionEpoch()`
- `waitForRenderDrain()`

The in-memory session state now also tracks:

- `tileVersions`
- `tileResetTokens`
- `epoch`

### `render-worker.js` (new)

New worker-thread module responsible for CPU-heavy image work.

Current worker tasks:

- `decode-png-to-ink`
- `render-accumulator-pair`

Implementation details:

- uses `sharp`
- forces `sharp.concurrency(1)` inside the worker
- returns ArrayBuffers back to the main thread

### `public/view.html`

Changed how live tile updates are rendered on the view screen.

Old behavior:

- websocket `tile-update` delivered inline PNG data
- `paintTile()` received `png`

New behavior:

- websocket `tile-update` delivers a tile `version`
- `paintTile()` now loads:
  - `/api/live-tile/<tile-id>.png?v=<version>`

This moves the actual tile image fetch to normal HTTP and makes websocket updates lighter.

## Not Included In This Summary

The following differ between the directories but are runtime/output changes rather than source
changes:

- `data/`
- `logs/`
- `node_modules/`
- `.indigo/`
- `.DS_Store`

Those include generated PNGs, SQLite database files, WAL/SHM files, load-test logs, and local
editor/agent state.
