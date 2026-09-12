import { AdmissionError } from './errors.js';
import type {
  OrchestrationPoolDecision,
  OrchestrationRuntimeCandidate,
  OrchestrationRuntimePoolSnapshot,
} from './types.js';

const DEFAULT_OWNER_ID = 'orchestration-runtime-manager';

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AdmissionError(`${label} must be a non-negative safe integer`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new AdmissionError(`${label} is required`);
}

function hasCapabilities(runtime: OrchestrationRuntimeCandidate, requiredCapabilities: readonly string[]): boolean {
  return requiredCapabilities.every((capability) => runtime.capabilities.includes(capability));
}

function validateCandidate(runtime: OrchestrationRuntimeCandidate): void {
  assertNonEmpty(runtime.runtimeId, 'runtime id');
  assertNonNegativeSafeInteger(runtime.currentBindings, 'runtime current bindings');
  assertNonNegativeSafeInteger(runtime.maxBindings, 'runtime max bindings');
}

function nextRuntimeId(pool: OrchestrationRuntimePoolSnapshot): string {
  const used = new Set(pool.runtimes.map((runtime) => runtime.runtimeId));
  let index = 1;
  while (used.has(`orchestration-runtime-${index}`)) index += 1;
  return `orchestration-runtime-${index}`;
}

export function decideOrchestrationRuntimePool(input: {
  readonly pool: OrchestrationRuntimePoolSnapshot;
  readonly requiredCapabilities: readonly string[];
  readonly ownerId?: string;
}): OrchestrationPoolDecision {
  assertNonNegativeSafeInteger(input.pool.maxRuntimes, 'orchestration max runtime count');
  for (const runtime of input.pool.runtimes) validateCandidate(runtime);
  for (const capability of input.requiredCapabilities) assertNonEmpty(capability, 'required orchestration capability');

  const ownerId = input.ownerId ?? DEFAULT_OWNER_ID;
  assertNonEmpty(ownerId, 'orchestration pool owner');

  if (input.pool.maxRuntimes === 0) {
    return {
      action: 'blocked',
      ownerId,
      condition: 'orchestration.runtime.disabled',
      nextAction: { kind: 'recover', ref: 'orchestration.runtime.disabled' },
      reason: 'orchestration runtime pool has no capacity',
    };
  }

  const reusable = input.pool.runtimes.find(
    (runtime) =>
      runtime.state === 'idle' &&
      runtime.currentBindings < runtime.maxBindings &&
      hasCapabilities(runtime, input.requiredCapabilities),
  );
  if (reusable) {
    return {
      action: 'reuse',
      runtimeId: reusable.runtimeId,
      ownerId,
      condition: 'orchestration.runtime.idle',
      nextAction: { kind: 'continue', ref: reusable.runtimeId },
      reason: 'matching idle orchestration runtime is available',
    };
  }

  if (input.pool.runtimes.length < input.pool.maxRuntimes) {
    const runtimeId = nextRuntimeId(input.pool);
    return {
      action: 'spawn',
      runtimeId,
      ownerId,
      condition: 'orchestration.runtime.capacity',
      nextAction: { kind: 'continue', ref: runtimeId },
      reason: 'orchestration runtime capacity is available',
    };
  }

  const capabilityExists = input.pool.runtimes.some((runtime) => hasCapabilities(runtime, input.requiredCapabilities));
  if (!capabilityExists) {
    const missing = input.requiredCapabilities.find(
      (capability) => !input.pool.runtimes.some((runtime) => runtime.capabilities.includes(capability)),
    );
    const condition = missing ? `orchestration.capability.${missing}` : 'orchestration.capability';
    return {
      action: 'blocked',
      ownerId,
      condition,
      nextAction: { kind: 'recover', ref: condition },
      reason: 'no runtime can satisfy required orchestration capabilities',
    };
  }

  return {
    action: 'wait',
    ownerId,
    condition: 'orchestration.runtime.max',
    nextAction: { kind: 'wait', ref: 'orchestration.runtime.max' },
    reason: 'orchestration runtime pool is at capacity',
  };
}
