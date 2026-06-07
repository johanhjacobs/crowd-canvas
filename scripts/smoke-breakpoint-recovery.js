import assert from 'assert/strict';
import { buildBreakpointStepsList, isRecoveryHealthy, pickRecoveryHostMetrics } from './breakpoint-helpers.js';

const localOnlySample = {
  apiHealthy: true,
  localGenerator: { available: true, cpuPct: 22, memUsedPct: 41 },
  appHost: { available: false, cpuPct: 99, memUsedPct: 99 },
};

assert.deepEqual(pickRecoveryHostMetrics(localOnlySample), localOnlySample.localGenerator);
assert.equal(isRecoveryHealthy({
  stateOk: true,
  apiHealthy: localOnlySample.apiHealthy,
  hostMetrics: pickRecoveryHostMetrics(localOnlySample),
  cpuThreshold: 90,
  memoryThreshold: 85,
}), true, 'healthy local-generator cooldown sample should recover');

const appHostSample = {
  apiHealthy: true,
  localGenerator: { available: true, cpuPct: 95, memUsedPct: 95 },
  appHost: { available: true, cpuPct: 18, memUsedPct: 37 },
};

assert.deepEqual(pickRecoveryHostMetrics(appHostSample), appHostSample.appHost);
assert.equal(isRecoveryHealthy({
  stateOk: true,
  apiHealthy: appHostSample.apiHealthy,
  hostMetrics: pickRecoveryHostMetrics(appHostSample),
  cpuThreshold: 90,
  memoryThreshold: 85,
}), true, 'healthy app-host cooldown sample should recover');

assert.equal(isRecoveryHealthy({
  stateOk: false,
  apiHealthy: true,
  hostMetrics: appHostSample.appHost,
  cpuThreshold: 90,
  memoryThreshold: 85,
}), false, 'bad admin state must not recover');

const steps = buildBreakpointStepsList({ start: 500, max: 5500, growth: 2, step: 1000 });
assert.deepEqual(steps, [500, 1000, 2000, 3000, 4000, 5000, 5500], 'post-threshold stepping should stay additive and include max');

console.log('breakpoint recovery smoke test passed');
