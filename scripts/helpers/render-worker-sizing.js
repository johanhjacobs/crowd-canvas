import os from 'os';

export const DEFAULT_RENDER_WORKERS_MAX = 6;
export const HARD_RENDER_WORKER_LIMIT = 32;

function parsePositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : NaN;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return NaN;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : NaN;
}

function detectCpuCount() {
  const fromParallelism = os.availableParallelism?.();
  if (Number.isInteger(fromParallelism) && fromParallelism > 0) return fromParallelism;
  const fromCpus = os.cpus()?.length;
  return Number.isInteger(fromCpus) && fromCpus > 0 ? fromCpus : 2;
}

export function autoRenderWorkersForCpu(cpuCount, maxCap = DEFAULT_RENDER_WORKERS_MAX) {
  const cap = Math.max(1, Math.min(HARD_RENDER_WORKER_LIMIT, maxCap));
  if (cpuCount <= 2) return 1;
  if (cpuCount <= 4) return Math.min(2, cap);
  if (cpuCount <= 8) return Math.min(3, cap);
  return Math.max(1, Math.min(cpuCount - 2, cap));
}

export function decideRenderWorkers(env = process.env, cpuCount = detectCpuCount()) {
  const warnings = [];

  const rawMaxCap = parsePositiveInt(env.RENDER_WORKERS_MAX);
  let maxCap = DEFAULT_RENDER_WORKERS_MAX;
  if (Number.isNaN(rawMaxCap)) {
    warnings.push(`invalid RENDER_WORKERS_MAX="${env.RENDER_WORKERS_MAX}" - using default ${DEFAULT_RENDER_WORKERS_MAX}`);
  } else if (rawMaxCap !== null) {
    maxCap = rawMaxCap;
  }
  maxCap = Math.max(1, Math.min(HARD_RENDER_WORKER_LIMIT, maxCap));

  const rawOverride = parsePositiveInt(env.RENDER_WORKERS);
  let workers;
  let overrideUsed = false;
  if (Number.isNaN(rawOverride)) {
    warnings.push(`invalid RENDER_WORKERS="${env.RENDER_WORKERS}" - falling back to automatic sizing`);
    workers = autoRenderWorkersForCpu(cpuCount, maxCap);
  } else if (rawOverride !== null) {
    workers = Math.max(1, Math.min(HARD_RENDER_WORKER_LIMIT, rawOverride));
    overrideUsed = true;
  } else {
    workers = autoRenderWorkersForCpu(cpuCount, maxCap);
  }

  return {
    detectedCpuCount: cpuCount,
    selectedWorkers: workers,
    overrideUsed,
    maxCap,
    warnings,
  };
}

export function logRenderWorkerDecision(decision, logger = console) {
  for (const warning of decision.warnings) logger.warn(`[render] ${warning}`);
  logger.log(
    `[render] cpu=${decision.detectedCpuCount} workers=${decision.selectedWorkers} override=${decision.overrideUsed ? 'env' : 'auto'} maxCap=${decision.maxCap}`
  );
}
