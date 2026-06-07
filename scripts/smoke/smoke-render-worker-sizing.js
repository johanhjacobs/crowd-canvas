import assert from 'assert/strict';
import {
  autoRenderWorkersForCpu,
  decideRenderWorkers,
  DEFAULT_RENDER_WORKERS_MAX,
  HARD_RENDER_WORKER_LIMIT,
} from '../helpers/render-worker-sizing.js';

assert.equal(autoRenderWorkersForCpu(2), 1, '2 CPUs should use 1 worker');
assert.equal(autoRenderWorkersForCpu(4), 2, '4 CPUs should use 2 workers');
assert.equal(autoRenderWorkersForCpu(8), 3, '8 CPUs should use 3 workers');
assert.equal(autoRenderWorkersForCpu(16), 6, '16 CPUs should use 6 workers with default max');

{
  const decision = decideRenderWorkers({ RENDER_WORKERS: '4' }, 16);
  assert.equal(decision.selectedWorkers, 4, 'explicit override should be used');
  assert.equal(decision.overrideUsed, true, 'override flag should be true');
}

{
  const decision = decideRenderWorkers({ RENDER_WORKERS: '20', RENDER_WORKERS_MAX: '4' }, 16);
  assert.equal(decision.maxCap, 4, 'explicit max cap should be applied');
  assert.equal(decision.selectedWorkers, 4, 'explicit override should be capped by RENDER_WORKERS_MAX');
  assert.equal(decision.overrideUsed, true, 'valid explicit override should still be marked used');
}

{
  const decision = decideRenderWorkers({ RENDER_WORKERS: '20', RENDER_WORKERS_MAX: '50' }, 16);
  assert.equal(decision.maxCap, HARD_RENDER_WORKER_LIMIT, 'max cap should be clamped to the hard limit');
  assert.equal(decision.selectedWorkers, 20, 'explicit override should be allowed when below the hard limit');
}

{
  const decision = decideRenderWorkers({ RENDER_WORKERS: '50', RENDER_WORKERS_MAX: '50' }, 16);
  assert.equal(decision.maxCap, HARD_RENDER_WORKER_LIMIT, 'oversized max cap should clamp to the hard limit');
  assert.equal(decision.selectedWorkers, HARD_RENDER_WORKER_LIMIT, 'explicit override should never exceed the hard limit');
}

{
  const decision = decideRenderWorkers({ RENDER_WORKERS: 'wat', RENDER_WORKERS_MAX: '6' }, 16);
  assert.equal(decision.selectedWorkers, 6, 'invalid override should fall back to auto sizing');
  assert.equal(decision.overrideUsed, false, 'invalid override should not be marked used');
  assert.ok(decision.warnings.some(w => w.includes('invalid RENDER_WORKERS=')), 'invalid override should warn');
}

{
  const decision = decideRenderWorkers({ RENDER_WORKERS_MAX: '4' }, 16);
  assert.equal(decision.maxCap, 4, 'max cap override should be applied');
  assert.equal(decision.selectedWorkers, 4, 'automatic result should be capped');
}

{
  const decision = decideRenderWorkers({ RENDER_WORKERS_MAX: 'wat' }, 16);
  assert.equal(decision.maxCap, DEFAULT_RENDER_WORKERS_MAX, 'invalid max cap should fall back to the default max');
  assert.equal(decision.selectedWorkers, 6, 'invalid max cap should still use automatic sizing with the default max');
  assert.ok(decision.warnings.some(w => w.includes('invalid RENDER_WORKERS_MAX=')), 'invalid max cap should warn');
}

{
  const decision = decideRenderWorkers({}, 16);
  assert.equal(decision.maxCap, DEFAULT_RENDER_WORKERS_MAX, 'default max cap should be used');
  assert.equal(decision.selectedWorkers, 6, 'default auto sizing should use cpu-2 capped by default max');
}

console.log('render worker sizing smoke test passed');
