export function pickRecoveryHostMetrics(sample) {
  if (!sample) return null;
  if (sample.appHost?.available) return sample.appHost;
  if (sample.localGenerator?.available) return sample.localGenerator;
  return null;
}

export function isRecoveryHealthy({ stateOk, apiHealthy, hostMetrics, cpuThreshold, memoryThreshold }) {
  if (!stateOk || apiHealthy === false || !hostMetrics) return false;
  const cpuOk = hostMetrics.cpuPct === null || hostMetrics.cpuPct < cpuThreshold;
  const memOk = (hostMetrics.memUsedPct ?? Infinity) < memoryThreshold;
  return cpuOk && memOk;
}

function nextNiceUnderStep(current, growth, step) {
  const target = Math.max(current + 1, Math.round(current * growth));
  const candidates = [1, 2, 2.5, 5, 10];
  let power = 10 ** Math.floor(Math.log10(Math.max(target, 1)));
  while (power <= step * 10) {
    for (const multiplier of candidates) {
      const candidate = Math.round(multiplier * power);
      if (candidate > current && candidate >= target) return Math.min(step, candidate);
    }
    power *= 10;
  }
  return Math.min(step, target);
}

export function buildBreakpointStepsList({ start, max, growth, step }) {
  const steps = [];
  let current = start;
  while (current <= max) {
    if (!steps.includes(current)) steps.push(current);
    let next;
    if (current < step) {
      next = nextNiceUnderStep(current, growth, step);
    } else {
      next = current + step;
    }
    if (next <= current) next = current + 1;
    current = next;
  }
  if (!steps.includes(max)) steps.push(max);
  return [...new Set(steps)].filter(n => n >= start && n <= max).sort((a, b) => a - b);
}
