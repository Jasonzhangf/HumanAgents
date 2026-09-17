import {
  decideOrchestrationRuntimePool,
  type OrchestrationRuntimeCandidate,
  type OrchestrationRuntimePoolSnapshot,
} from '../admission/index.js';
import {
  assertExecutionEpoch,
  id,
  type EvidenceRef,
  type NextAction,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { OrchestrationError, OrchestrationPortError } from './errors.js';
import type {
  OrchestrationIssue,
  OrchestrationRuntimeFactoryPort,
  RuntimePoolLease,
} from './types.js';

const DEFAULT_OWNER_ID = 'orchestration-runtime-manager';

interface RuntimeRecord {
  readonly runtimeId: string;
  readonly generation: number;
  capabilities: readonly string[];
  state: 'idle' | 'running' | 'spawning' | 'failed' | 'disposed';
  lease?: RuntimePoolLease;
  binding?: {
    readonly executionEpoch: number;
    readonly ownerId: string;
    readonly assignmentId: string;
  };
  disposePromise?: Promise<void>;
}

export interface RuntimePoolAcquireInput {
  readonly requiredCapabilities: readonly string[];
  readonly ownerId?: string;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly scope: ScopeRef;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export type RuntimePoolAcquireResult =
  | {
      readonly status: 'acquired';
      readonly lease: RuntimePoolLease;
      readonly decision: ReturnType<typeof decideOrchestrationRuntimePool>;
    }
  | {
      readonly status: 'waiting' | 'blocked';
      readonly issue: OrchestrationIssue;
    };

export type RuntimePoolReleaseResult =
  | { readonly status: 'released' }
  | { readonly status: 'blocked'; readonly issue: OrchestrationIssue };

export interface RuntimePoolDisposeResult {
  readonly status: 'disposed' | 'blocked';
  readonly alreadyDisposed: boolean;
  readonly issues: readonly OrchestrationIssue[];
}

export interface AgentRuntimePoolManagerOptions {
  readonly maxRuntimes: number;
  readonly factory: OrchestrationRuntimeFactoryPort;
  readonly ownerId?: string;
  readonly initialRuntimes?: readonly {
    readonly runtimeId: string;
    readonly generation?: number;
    readonly capabilities: readonly string[];
    readonly state?: 'idle' | 'running' | 'failed';
  }[];
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new OrchestrationError(`${label} is required`, {
    ownerId: DEFAULT_OWNER_ID,
    reason: `${label}.required`,
    nextAction: { kind: 'recover', ref: label },
    evidenceRefs: [evidence({ organId: id('organ', 'orchestration-runtime-manager') }, `${label}.required`)],
  });
}

function safeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);
  return normalized || 'runtime-pool';
}

function evidence(scope: ScopeRef, locator: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `runtime-pool-${safeId(locator)}`),
    kind: 'operation',
    source: 'orchestration-runtime-pool',
    locator,
    scope,
  };
}

function issue(
  code: string,
  ownerId: string,
  reason: string,
  nextAction: NextAction,
  evidenceRefs: readonly EvidenceRef[],
  conditionRef?: string,
): OrchestrationIssue {
  const refs = evidenceRefs.length > 0
    ? evidenceRefs
    : [evidence({ organId: id('organ', 'orchestration-runtime-manager') }, conditionRef ?? code)];
  return {
    code,
    ownerId,
    reason,
    nextAction,
    evidenceRefs: [...refs],
    ...(conditionRef ? { conditionRef } : {}),
  };
}

function issueFromError(
  error: unknown,
  input: {
    readonly code: string;
    readonly ownerId: string;
    readonly scope: ScopeRef;
    readonly conditionRef: string;
    readonly fallbackEvidenceRefs?: readonly EvidenceRef[];
  },
): OrchestrationIssue {
  if (error instanceof OrchestrationError) {
    return issue(
      input.code,
      error.ownerId,
      error.reason,
      error.nextAction,
      error.evidenceRefs.length > 0 ? error.evidenceRefs : input.fallbackEvidenceRefs ?? [evidence(input.scope, input.conditionRef)],
      error.conditionRef ?? input.conditionRef,
    );
  }
  return issue(
    input.code,
    input.ownerId,
    error instanceof Error ? error.message : String(error),
    { kind: 'recover', ref: input.conditionRef },
    input.fallbackEvidenceRefs ?? [evidence(input.scope, input.conditionRef)],
    input.conditionRef,
  );
}

function cloneLease(lease: RuntimePoolLease): RuntimePoolLease {
  return { ...lease, capabilities: [...lease.capabilities] };
}

export class AgentRuntimePoolManager {
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly ownerId: string;
  private readonly maxRuntimes: number;
  private readonly factory: OrchestrationRuntimeFactoryPort;
  private disposed = false;
  private sequence = 0;
  private generationSequence = 0;
  private disposePromise: Promise<RuntimePoolDisposeResult> | undefined;

  constructor(options: AgentRuntimePoolManagerOptions) {
    if (!Number.isSafeInteger(options.maxRuntimes) || options.maxRuntimes < 0) {
      throw new OrchestrationError('max runtimes must be a non-negative safe integer', {
        ownerId: options.ownerId ?? DEFAULT_OWNER_ID,
        reason: 'orchestration.runtime.max.invalid',
        nextAction: { kind: 'recover', ref: 'orchestration.runtime.max' },
        evidenceRefs: [evidence({ organId: id('organ', 'orchestration-runtime-manager') }, 'orchestration.runtime.max.invalid')],
      });
    }
    this.maxRuntimes = options.maxRuntimes;
    this.factory = options.factory;
    this.ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
    assertNonEmpty(this.ownerId, 'orchestration pool owner');
    for (const runtime of options.initialRuntimes ?? []) {
      const generation = runtime.generation ?? 1;
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new OrchestrationError('runtime generation must be a positive safe integer', {
          ownerId: this.ownerId,
          reason: 'orchestration.runtime.generation.invalid',
          nextAction: { kind: 'recover', ref: runtime.runtimeId },
          evidenceRefs: [evidence({ organId: id('organ', 'orchestration-runtime-manager') }, 'orchestration.runtime.generation.invalid')],
        });
      }
      this.runtimes.set(runtime.runtimeId, {
        runtimeId: runtime.runtimeId,
        generation,
        capabilities: [...runtime.capabilities],
        state: runtime.state ?? 'idle',
      });
      this.generationSequence = Math.max(this.generationSequence, generation);
    }
  }

  private snapshot(): OrchestrationRuntimePoolSnapshot {
    const runtimes: readonly OrchestrationRuntimeCandidate[] = [...this.runtimes.values()].map((runtime) => ({
      runtimeId: runtime.runtimeId,
      state: runtime.state === 'disposed' ? 'failed' : runtime.state,
      capabilities: [...runtime.capabilities],
      currentBindings: runtime.lease ? 1 : 0,
      maxBindings: 1,
    }));
    return { maxRuntimes: this.maxRuntimes, runtimes };
  }

  async acquire(input: RuntimePoolAcquireInput): Promise<RuntimePoolAcquireResult> {
    if (this.disposed) {
      return {
        status: 'blocked',
        issue: issue(
          'runtime-pool-disposed',
          this.ownerId,
          'runtime pool is disposed',
          { kind: 'recover', ref: 'orchestration.runtime.pool' },
          input.evidenceRefs ?? [evidence(input.scope, 'orchestration.runtime.pool')],
          'orchestration.runtime.pool',
        ),
      };
    }
    try {
      assertExecutionEpoch(input.executionEpoch);
      assertNonEmpty(input.assignmentId, 'assignment id');
      for (const capability of input.requiredCapabilities) assertNonEmpty(capability, 'required capability');
    } catch (error) {
      return {
        status: 'blocked',
        issue: issueFromError(error, {
          code: 'runtime-pool-input-invalid',
          ownerId: input.ownerId ?? this.ownerId,
          scope: input.scope,
          conditionRef: 'orchestration.runtime.request',
          fallbackEvidenceRefs: input.evidenceRefs,
        }),
      };
    }

    const decision = decideOrchestrationRuntimePool({
      pool: this.snapshot(),
      requiredCapabilities: input.requiredCapabilities,
      ownerId: input.ownerId ?? this.ownerId,
    });
    if (decision.action === 'wait' || decision.action === 'blocked') {
      return {
        status: decision.action === 'wait' ? 'waiting' : 'blocked',
        issue: issue(
          decision.condition,
          decision.ownerId,
          decision.reason,
          decision.nextAction,
          input.evidenceRefs ?? [evidence(input.scope, decision.condition)],
          decision.condition,
        ),
      };
    }
    if (!decision.runtimeId) {
      return {
        status: 'blocked',
        issue: issue(
          'orchestration.runtime.selection',
          decision.ownerId,
          'runtime pool decision did not select a runtime',
          { kind: 'recover', ref: decision.condition },
          input.evidenceRefs ?? [evidence(input.scope, decision.condition)],
          decision.condition,
        ),
      };
    }

    const runtime = this.runtimes.get(decision.runtimeId);
    if (decision.action === 'reuse' && runtime) {
      const lease = this.createLease(runtime, input, decision.ownerId);
      runtime.state = 'running';
      runtime.lease = lease;
      return { status: 'acquired', lease: cloneLease(lease), decision };
    }

    this.generationSequence += 1;
    const generation = this.generationSequence;
    const spawning: RuntimeRecord = {
      runtimeId: decision.runtimeId,
      generation,
      capabilities: [],
      state: 'spawning',
      binding: {
        executionEpoch: input.executionEpoch,
        ownerId: decision.ownerId,
        assignmentId: input.assignmentId,
      },
    };
    this.runtimes.set(spawning.runtimeId, spawning);
    try {
      const started = await this.factory.start({
        runtimeId: decision.runtimeId,
        generation,
        executionEpoch: input.executionEpoch,
        ownerId: decision.ownerId,
        assignmentId: input.assignmentId,
        requiredCapabilities: [...input.requiredCapabilities],
        scope: input.scope,
      });
      if (
        this.disposed
        || this.runtimes.get(spawning.runtimeId) !== spawning
        || spawning.state !== 'spawning'
      ) {
        let cleanupIssue: OrchestrationIssue | undefined;
        try {
          await this.disposeRuntime(spawning);
        } catch (cleanupError) {
          cleanupIssue = issueFromError(cleanupError, {
            code: 'runtime-startup-cleanup-failed',
            ownerId: decision.ownerId,
            scope: input.scope,
            conditionRef: `orchestration.runtime.startup.cleanup.${spawning.runtimeId}`,
            fallbackEvidenceRefs: input.evidenceRefs,
          });
        }
        const startupIssue = issue(
          'runtime-startup-invalidated',
          decision.ownerId,
          this.disposed
            ? 'runtime pool was disposed while runtime startup was pending'
            : 'runtime generation was invalidated while startup was pending',
          { kind: 'recover', ref: 'orchestration.runtime.startup' },
          input.evidenceRefs ?? [evidence(input.scope, 'orchestration.runtime.startup')],
          'orchestration.runtime.startup',
        );
        return {
          status: 'blocked',
          issue: cleanupIssue
            ? issue(
                startupIssue.code,
                startupIssue.ownerId,
                `${startupIssue.reason}; cleanup failed: ${cleanupIssue.reason}`,
                cleanupIssue.nextAction,
                [...startupIssue.evidenceRefs, ...cleanupIssue.evidenceRefs],
                cleanupIssue.conditionRef,
              )
            : startupIssue,
        };
      }
      if (started.runtimeId !== spawning.runtimeId || started.generation !== spawning.generation) {
        throw new OrchestrationPortError('runtime factory returned a mismatched runtime identity', {
          ownerId: decision.ownerId,
          reason: 'orchestration.runtime.startup.identity-mismatch',
          nextAction: { kind: 'recover', ref: 'orchestration.runtime.startup' },
          evidenceRefs: input.evidenceRefs ?? [evidence(input.scope, 'orchestration.runtime.startup')],
          conditionRef: 'orchestration.runtime.startup',
        });
      }
      const missing = input.requiredCapabilities.find((capability) => !started.capabilities.includes(capability));
      if (missing) {
        throw new OrchestrationPortError(`started runtime is missing capability: ${missing}`, {
          ownerId: decision.ownerId,
          reason: `orchestration.capability.${missing}`,
          nextAction: { kind: 'recover', ref: `orchestration.capability.${missing}` },
          evidenceRefs: input.evidenceRefs ?? [evidence(input.scope, `orchestration.capability.${missing}`)],
          conditionRef: `orchestration.capability.${missing}`,
        });
      }
      spawning.capabilities = [...started.capabilities];
      const lease = this.createLease(spawning, input, decision.ownerId);
      spawning.state = 'running';
      spawning.lease = lease;
      return { status: 'acquired', lease: cloneLease(lease), decision };
    } catch (error) {
      let cleanupIssue: OrchestrationIssue | undefined;
      try {
        await this.disposeRuntime(spawning);
        this.runtimes.delete(spawning.runtimeId);
      } catch (cleanupError) {
        cleanupIssue = issueFromError(cleanupError, {
          code: 'runtime-startup-cleanup-failed',
          ownerId: decision.ownerId,
          scope: input.scope,
          conditionRef: `orchestration.runtime.startup.cleanup.${spawning.runtimeId}`,
          fallbackEvidenceRefs: input.evidenceRefs,
        });
      }
      const startupIssue = issueFromError(error, {
        code: 'runtime-startup-failed',
        ownerId: decision.ownerId,
        scope: input.scope,
        conditionRef: 'orchestration.runtime.startup',
        fallbackEvidenceRefs: input.evidenceRefs,
      });
      return {
        status: 'blocked',
        issue: cleanupIssue
          ? issue(
              startupIssue.code,
              startupIssue.ownerId,
              `${startupIssue.reason}; cleanup failed: ${cleanupIssue.reason}`,
              cleanupIssue.nextAction,
              [...startupIssue.evidenceRefs, ...cleanupIssue.evidenceRefs],
              cleanupIssue.conditionRef,
            )
          : startupIssue,
      };
    }
  }

  private disposeRuntime(runtime: RuntimeRecord): Promise<void> {
    if (runtime.state === 'disposed') return Promise.resolve();
    if (runtime.disposePromise) return runtime.disposePromise;
    const binding = runtime.lease ?? runtime.binding;
    runtime.disposePromise = (async () => {
      await this.factory.dispose({
        runtimeId: runtime.runtimeId,
        generation: runtime.generation,
        executionEpoch: binding?.executionEpoch ?? 1,
        ownerId: binding?.ownerId ?? this.ownerId,
        ...(binding?.assignmentId ? { assignmentId: binding.assignmentId } : {}),
      });
      runtime.state = 'disposed';
      runtime.lease = undefined;
    })().catch((error) => {
      runtime.state = 'failed';
      throw error;
    });
    return runtime.disposePromise;
  }

  private createLease(
    runtime: RuntimeRecord,
    input: RuntimePoolAcquireInput,
    ownerId: string,
  ): RuntimePoolLease {
    this.sequence += 1;
    return {
      leaseId: `${runtime.runtimeId}:${runtime.generation}:${this.sequence}`,
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      executionEpoch: input.executionEpoch,
      ownerId,
      assignmentId: input.assignmentId,
      capabilities: [...runtime.capabilities],
    };
  }

  async release(lease: RuntimePoolLease, input: { readonly scope: ScopeRef }): Promise<RuntimePoolReleaseResult> {
    const runtime = this.runtimes.get(lease.runtimeId);
    const current = runtime?.lease;
    if (
      !runtime
      || runtime.state !== 'running'
      || !current
      || current.leaseId !== lease.leaseId
      || current.generation !== lease.generation
      || current.executionEpoch !== lease.executionEpoch
      || current.ownerId !== lease.ownerId
      || current.assignmentId !== lease.assignmentId
    ) {
      return {
        status: 'blocked',
        issue: issue(
          'runtime-lease-stale',
          this.ownerId,
          'runtime lease is stale or owned by another binding',
          { kind: 'recover', ref: `orchestration.runtime.lease.${lease.runtimeId}` },
          [evidence(input.scope, `orchestration.runtime.lease.${lease.runtimeId}`)],
          `orchestration.runtime.lease.${lease.runtimeId}`,
        ),
      };
    }
    runtime.lease = undefined;
    runtime.state = 'idle';
    return { status: 'released' };
  }

  async dispose(): Promise<RuntimePoolDisposeResult> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.performDispose();
    const result = await this.disposePromise;
    this.disposePromise = undefined;
    return result;
  }

  private async performDispose(): Promise<RuntimePoolDisposeResult> {
    const alreadyDisposed = this.disposed;
    this.disposed = true;
    const issues: OrchestrationIssue[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.state === 'disposed') continue;
      try {
        await this.disposeRuntime(runtime);
      } catch (error) {
        issues.push(issueFromError(error, {
          code: 'runtime-dispose-failed',
          ownerId: this.ownerId,
          scope: { organId: id('organ', 'orchestration-runtime-manager') },
          conditionRef: `orchestration.runtime.dispose.${runtime.runtimeId}`,
        }));
      }
    }
    return {
      status: issues.length === 0 ? 'disposed' : 'blocked',
      alreadyDisposed,
      issues,
    };
  }

  inspect(): {
    readonly disposed: boolean;
    readonly runtimes: readonly {
      readonly runtimeId: string;
      readonly generation: number;
      readonly state: RuntimeRecord['state'];
      readonly capabilities: readonly string[];
      readonly lease?: RuntimePoolLease;
    }[];
  } {
    return {
      disposed: this.disposed,
      runtimes: [...this.runtimes.values()].map((runtime) => ({
        runtimeId: runtime.runtimeId,
        generation: runtime.generation,
        state: runtime.state,
        capabilities: [...runtime.capabilities],
        ...(runtime.lease ? { lease: cloneLease(runtime.lease) } : {}),
      })),
    };
  }
}
