import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ScopeRef,
  type Attention,
} from '../../packages/contracts/src/index.js';
import {
  MemoryCoordinator,
  type AttentionPort,
} from '../../packages/runtime/src/index.js';
import {
  ProviderAdapterError,
  ProviderAgentDriver,
} from '../../packages/adapters/provider/src/index.js';
import {
  AgentRuntimePoolManager,
  OrchestrationManager,
  type ExecutionAgentPort,
  type MergeCoordinatorPort,
  type ReviewAgentPort,
} from '../../packages/runtime/src/orchestration/index.js';
import {
  FileCheckpointStore,
  FakeReplayExecutionRuntimePort,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../packages/app/src/ui-runtime/index.js';
import {
  RuntimeTaskControlError,
  type RuntimeExecutionAllocation,
  type RuntimeTransientRetryWaiter,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { projectMainTopic } from '../../packages/ui/projection/main-topic.js';
import type { RuntimeSseEvent } from '../../packages/ui/contracts/runtime.js';
import { ServiceExecutionCheckpointStore } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import type {
  ExplicitBrainInputInterpreter,
} from '../../packages/app/src/explicit-brain-runtime.js';

// 该测试覆盖 UI 真实执行路径上的有界纠正重试循环：
//  1. 首次可重试失败、第二次成功 → 任务 succeeded，轨迹含 retry step，
//     第二次模型请求携带上一轮失败原因；
//  2. 始终失败 → 达到上限后 blocked，retryable=false，保留首次原因；
//  3. 已提交副作用（tool 执行结果）后失败 → 不重新派发。
// 旧实现硬编码 maxAttempts=1 且失败后不重派发，三项都会失败（红）；修复后转绿。

const organId = id('organ', 'organ-corrective-retry-test');
const binding: ProviderBinding = {
  bindingId: 'binding-corrective-retry-test',
  providerId: 'provider-corrective-retry-test',
  protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-corrective-retry-test',
  configDigest: 'sha256:corrective-retry-config',
  capabilityDigest: 'sha256:corrective-retry-capability',
};

const unusedExplicitBrainInterpreter: ExplicitBrainInputInterpreter = {
  async interpret() {
    throw new Error('explicit brain interpretation is not configured for this test');
  },
};

function evidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `corrective-retry-${label}`),
    kind: 'execution',
    source: 'corrective-retry-test',
    locator: `test://${label}`,
    scope,
  };
}

function attentionPort(): AttentionPort & { readonly published: Attention[]; readonly resolved: Attention[] } {
  const published: Attention[] = [];
  const resolved: Attention[] = [];
  return {
    published,
    resolved,
    async publish(input) {
      published.push(structuredClone(input));
      return { attentionId: input.attentionId, delivered: true };
    },
    async resolve(input) {
      resolved.push(structuredClone(input));
      return { attentionId: input.attentionId, delivered: true };
    },
  };
}

function testMemory(projectKey: string) {
  return {
    coordinator: new MemoryCoordinator(),
    backend: new DeterministicMemoryBackend(),
    projectKey,
    roleId: 'execution',
  };
}

async function waitFor(assertion: () => void, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// 一次 provider attempt 的脚本：按顺序回放的 provider 事件，以及最终 settle 状态。
interface ScriptedAttempt {
  readonly steps: ReadonlyArray<{
    readonly kind: 'model' | 'output' | 'tool' | 'terminal';
    readonly summary?: string;
    readonly outputRefs?: readonly string[];
    readonly terminalState?: 'succeeded' | 'failed';
  }>;
  readonly terminalState: 'succeeded' | 'failed';
}

// 每次 provider 启动都会新建一个 driver / composition，并使用新的 runtimeId，
// 因此该端口按“第几次启动”选择脚本，模拟首次失败、第二次成功的纠正过程。
class ScriptedCorrectivePort extends FakeReplayExecutionRuntimePort {
  readonly startPayloads: unknown[] = [];
  private starts = 0;
  private readonly attemptByRuntime = new Map<string, ScriptedAttempt>();

  constructor(
    options: ConstructorParameters<typeof FakeReplayExecutionRuntimePort>[0],
    private readonly attempts: readonly ScriptedAttempt[],
  ) {
    super(options);
  }

  get startCount(): number {
    return this.starts;
  }

  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.startPayloads.push(structuredClone(input.payload ?? null));
    const attemptIndex = Math.min(this.starts, this.attempts.length - 1);
    this.starts += 1;
    this.attemptByRuntime.set(input.runtimeId, this.attempts[attemptIndex]!);
    return super.start(input);
  }

  override async *observe(
    input: Parameters<ExecutionRuntimePort['observe']>[0],
  ): AsyncIterable<ProviderEvent> {
    const script = this.attemptByRuntime.get(input.runtimeId);
    if (!script) throw new Error('scripted port: no attempt script for this runtime');
    const scope: ScopeRef = { organId, taskId: input.taskId, operationId: input.operationId };
    let index = 0;
    for (const step of script.steps) {
      const event = {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        eventId: `scripted-${input.operationId.value}-${index}`,
        kind: step.kind,
        evidenceRefs: [evidence(`step-${index}`, scope)],
        ...(step.summary === undefined ? {} : { summary: step.summary }),
        ...(step.outputRefs === undefined ? {} : { outputRefs: step.outputRefs }),
        ...(step.kind === 'terminal' ? { terminalState: step.terminalState } : {}),
      } as ProviderEvent;
      index += 1;
      yield event;
      if (step.kind === 'terminal') return;
    }
  }

  override async settle(
    input: Parameters<ExecutionRuntimePort['settle']>[0],
  ): Promise<ProviderSettlement> {
    const script = this.attemptByRuntime.get(input.runtimeId);
    const state = script?.terminalState ?? 'failed';
    const scope: ScopeRef = { organId, taskId: input.taskId, operationId: input.operationId };
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      state,
      evidenceRefs: [evidence(`settle-${state}`, scope)],
      resourceRelease: { state: 'released', evidenceRefs: [evidence('release', scope)] },
      persistence: { state: 'committed', evidenceRefs: [evidence('persistence', scope)] },
    };
  }
}

interface NativeStartFailureScript {
  readonly code: string;
  readonly message: string;
  readonly retryCode?: string;
  readonly retryMessage?: string;
  readonly failures: number;
  readonly retryable?: 'retryable';
}

class NativeStartFailurePort extends FakeReplayExecutionRuntimePort {
  readonly startPayloads: unknown[] = [];
  readonly startInputs: Array<Pick<ProviderStartInput, 'runtimeId' | 'taskId' | 'operationId' | 'executionEpoch'>> = [];
  readonly failureEvidence: EvidenceRef[] = [];
  startCount = 0;
  closeCount = 0;
  closeFailuresRemaining = 0;
  closeWait?: Promise<void>;
  isolateClose = false;
  holdSecondObserve = false;
  private secondObserveStartedResolver?: () => void;
  private secondObserveReleaseResolver?: () => void;
  readonly secondObserveStarted = new Promise<void>((resolve) => {
    this.secondObserveStartedResolver = resolve;
  });
  private readonly secondObserveRelease = new Promise<void>((resolve) => {
    this.secondObserveReleaseResolver = resolve;
  });

  constructor(
    options: ConstructorParameters<typeof FakeReplayExecutionRuntimePort>[0],
    private readonly failure: NativeStartFailureScript = {
      code: 'http.503',
      message: 'RCC v3 returned HTTP 503: injected retryable failure',
      failures: 1,
    },
  ) {
    super(options);
  }

  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.startPayloads.push(structuredClone(input.payload ?? null));
    this.startInputs.push({
      runtimeId: input.runtimeId,
      taskId: structuredClone(input.taskId),
      operationId: structuredClone(input.operationId),
      executionEpoch: input.executionEpoch,
    });
    this.startCount += 1;
    if (this.startCount <= this.failure.failures) {
      const scope: ScopeRef = { organId, taskId: input.taskId, operationId: input.operationId };
      const failureEvidence = evidence(`native-start-failure-${this.startCount}`, scope);
      this.failureEvidence.push(failureEvidence);
      const code = this.startCount === 1 ? this.failure.code : this.failure.retryCode ?? this.failure.code;
      throw new ProviderAdapterError({
        code,
        category: 'provider',
        phase: 'start',
        message: this.startCount === 1 ? this.failure.message : this.failure.retryMessage ?? this.failure.message,
        retryable: this.failure.retryable,
        evidenceRefs: [failureEvidence],
        scope: input,
      });
    }
    return super.start(input);
  }

  override async close(value: ProviderBinding) {
    this.closeCount += 1;
    await this.closeWait;
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      throw new Error('controlled provider close failure');
    }
    if (this.isolateClose) {
      return {
        bindingId: value.bindingId,
        providerId: value.providerId,
        protocol: value.protocol,
        state: 'closed' as const,
        evidenceRefs: [evidence(`isolated-close-${this.closeCount}`, { organId })],
      };
    }
    return super.close(value);
  }

  override async *observe(
    input: Parameters<ExecutionRuntimePort['observe']>[0],
  ): AsyncIterable<ProviderEvent> {
    if (this.holdSecondObserve && input.runtimeId === this.startInputs[1]?.runtimeId) {
      this.secondObserveStartedResolver?.();
      this.secondObserveStartedResolver = undefined;
      await this.secondObserveRelease;
    }
    yield* super.observe(input);
  }

  releaseSecondObserve(): void {
    this.secondObserveReleaseResolver?.();
    this.secondObserveReleaseResolver = undefined;
  }
}

class OneShotStoppedCheckpointFailureStore extends ServiceExecutionCheckpointStore {
  failNextStoppedCommit = false;

  override async commitNativeCheckpoint(
    input: Parameters<ServiceExecutionCheckpointStore['commitNativeCheckpoint']>[0],
  ): ReturnType<ServiceExecutionCheckpointStore['commitNativeCheckpoint']> {
    if (input.checkpoint.outcome === 'stopped' && this.failNextStoppedCommit) {
      this.failNextStoppedCommit = false;
      throw new Error('controlled stopped checkpoint commit failure');
    }
    return super.commitNativeCheckpoint(input);
  }
}

class OneShotStopSettlementFailureJournal extends UiRuntimeJournal {
  failNextStopSettlementAppend = false;
  failNextStoppedTerminalAppend = false;

  override append(record: Parameters<UiRuntimeJournal['append']>[0]): void {
    if (this.failNextStopSettlementAppend && record.kind === 'operation.stop-settlement') {
      this.failNextStopSettlementAppend = false;
      throw new Error('controlled stop intent journal append failure');
    }
    if (this.failNextStoppedTerminalAppend
      && record.kind === 'operation.event'
      && record.event.kind === 'execution.terminal'
      && record.event.state === 'stopped'
      && record.event.terminalPhase === 'final') {
      this.failNextStoppedTerminalAppend = false;
      throw new Error('controlled final stopped terminal append failure');
    }
    super.append(record);
  }
}

// 与现有 ui-runtime 测试一致的真实编排装配：编排层使用 forwarded maxAttempts。
function orchestratedServiceFor(root: string, port: ExecutionRuntimePort): UiRuntimeService {
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  return new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal,
    closurePort: journal,
    memory: testMemory('project-corrective-retry'),
    runtimeComposition: {
      admitExecution: async () => {},
      createTaskAssembly({ task, scope, checkpointJournal, executionAgent, maxAttempts }) {
        const runtimePool = new AgentRuntimePoolManager({
          maxRuntimes: 4,
          factory: {
            async start(request) {
              return {
                runtimeId: request.runtimeId,
                generation: request.generation,
                capabilities: [...request.requiredCapabilities],
              };
            },
            async dispose() {},
          },
          ownerId: 'corrective-retry-test',
          initialRuntimes: [{
            runtimeId: 'corrective-retry-test-0',
            generation: 1,
            capabilities: ['code.search', 'file.checkpoint', 'provider.execution'],
          }],
        });
        const reviewOnce = async (input: Parameters<ReviewAgentPort['review']>[0]) => ({
          resultId: `review-${input.reviewAssignment.assignmentId}`,
          assignmentId: input.reviewAssignment.assignmentId,
          taskId: input.reviewAssignment.taskId,
          workerAgentId: input.reviewAssignment.workerAgentId,
          reviewKind: input.reviewAssignment.reviewKind,
          attempt: input.reviewAssignment.attempt,
          executionEpoch: input.reviewAssignment.executionEpoch,
          inputRevision: input.reviewAssignment.inputRevision,
          subjectRefs: [...input.reviewAssignment.subjectRefs],
          status: 'passed' as const,
          findings: [],
          evidenceRefs: [evidence('review', input.scope)],
        });
        const reviewAgent: ReviewAgentPort = {
          roleId: 'corrective-retry-test-review',
          createInstance(create) {
            return {
              incarnation: create.incarnation,
              async review(input) {
                const result = await reviewOnce(input);
                return {
                  result,
                  output: { text: `review ${input.reviewAssignment.assignmentId}`, artifactRef: null, artifactDigest: null },
                  completedAt: new Date().toISOString(),
                };
              },
              async dispose() {},
            };
          },
          async review(input) {
            return reviewOnce(input);
          },
        };
        const mergeCoordinator: MergeCoordinatorPort = {
          async merge(request) {
            return {
              status: 'merged',
              evidenceRefs: [
                ...request.workerResult.evidenceRefs,
                ...request.reviewResults.flatMap((review) => review.evidenceRefs),
                evidence(`merge-${request.workerAssignment.assignmentId}`, request.scope),
              ],
            };
          },
        };
        const orchestration = new OrchestrationManager({
          ownerId: 'corrective-retry-test',
          runtimePool,
          executionAgent: executionAgent as ExecutionAgentPort,
          reviewAgent,
          mergeCoordinator,
          maxAttempts: maxAttempts ?? 2,
        });
        return { orchestration, runtimePool };
      },
    },
  });
}

function nonOrchestratedServiceFor(
  root: string,
  port: ExecutionRuntimePort,
  nativeLane: boolean,
  transientRetryWaiter?: RuntimeTransientRetryWaiter,
  checkpointStoreFactory?: (
    filePath: string,
    journal: JsonlOrganJournal,
  ) => ServiceExecutionCheckpointStore,
  taskJournal?: UiRuntimeJournal,
  closeRetainedTransientRetryProvider?: (
    allocation: RuntimeExecutionAllocation,
  ) => Promise<ProviderCloseResult>,
): UiRuntimeService {
  const journal = taskJournal ?? new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const currentStatePort = createJsonlRuntimeTaskCurrentStateJournal({
    journal: new JsonlOrganJournal(join(root, 'current-state.jsonl')),
  });
  const checkpointStoreFor = (taskId: { readonly value: string }, cycleId: { readonly value: string }) => {
    const filePath = join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`);
    const journal = new JsonlOrganJournal(filePath);
    return checkpointStoreFactory?.(filePath, journal)
      ?? new ServiceExecutionCheckpointStore(filePath, journal, () => new Date());
  };
  return new UiRuntimeService({
    mode: nativeLane ? 'rcc' : 'fake',
    organId,
    binding,
    port,
    checkpointStoreFor,
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal,
    closurePort: journal,
    memory: testMemory('project-corrective-retry'),
    runtimeComposition: {
      ...(transientRetryWaiter === undefined ? {} : { transientRetryWaiter }),
      createExecutionPorts: () => ({
        admitExecution: async () => {},
        ...(closeRetainedTransientRetryProvider === undefined ? {} : { closeRetainedTransientRetryProvider }),
        ...(nativeLane ? {
          currentStatePort,
          currentStateFacts: {
            async read() {
              return {
                state: 'known' as const,
                value: {
                  turn: {
                    phase: 'open' as const,
                    ownerRef: 'fixture:native-retry',
                    nextAction: { kind: 'continue' as const },
                    laterErrorRefs: [],
                    unresolvedOperationRefs: [],
                  },
                  stages: { state: 'known' as const, stages: [] },
                },
              };
            },
          },
        } : {}),
        createDriver: async (allocation) => {
          const driver = new ProviderAgentDriver({
            port,
            binding,
            runtimeId: allocation.runtimeId,
            taskId: allocation.taskId,
            operationId: allocation.operationId,
            executionEpoch: allocation.executionEpoch,
            assignmentId: allocation.assignmentId,
            scope: allocation.scope,
            inputRefs: allocation.inputRefs,
            ownerId: allocation.ownerId,
          });
          if (!nativeLane) return driver;
          const refs = [evidence(`native-standard-turn-${allocation.operationId.value}`, allocation.scope)];
          const identity = {
            turnId: `turn-${allocation.executionEpoch}`,
            workAssignmentRef: allocation.assignmentId,
            taskRef: allocation.taskId,
            scopeRef: allocation.scope,
            cycleRef: allocation.scope.cycleId!,
            inputRevision: allocation.inputRevision,
            directiveRevision: allocation.directiveRevision,
            executionEpoch: allocation.executionEpoch,
            runtimeBindingRef: allocation.runtimeId,
            permissionRevision: '1',
          };
          const checkpoint: Checkpoint = {
            id: id('checkpoint', `native-retry-${allocation.operationId.value}`),
            scope: allocation.scope,
            cycleId: allocation.scope.cycleId!,
            seq: 1,
            previousCheckpointId: null,
            directiveRevision: allocation.directiveRevision,
            executionEpoch: allocation.executionEpoch,
            outcome: 'succeeded',
            summary: 'native retry turn closed',
            recoveryStateRef: refs[0]!,
            evidenceRefs: refs,
            next: { kind: 'stop' },
          };
          const summary = {
            goal: { text: 'complete the native retry request', evidenceRefs: refs },
            actions: { text: 'execute the provider turn', evidenceRefs: refs },
            result: { text: 'native retry request completed', evidenceRefs: refs },
            expectedNextStep: { text: 'complete the task', evidenceRefs: refs },
          };
          const alignment = {
            identity,
            checkpointId: checkpoint.id,
            closureRef: 'closure:native-retry',
            planRevisionId: `plan-${allocation.executionEpoch}`,
            planRevisionSequence: 1,
            planContentDigest: 'sha256:native-retry-fixture' as const,
            decision: 'complete' as const,
            alignedAt: '2026-11-01T00:00:00.000Z',
          };
          return Object.assign(driver, {
            standardTurn: {
              async acceptReviews() {},
              async readCheckpoint() {
                const store = checkpointStoreFor(allocation.taskId, allocation.scope.cycleId!);
                const relationship = await store.commitNativeCheckpoint({
                  ownerId: 'corrective-retry-test',
                  checkpoint,
                  timeAuthority: {
                    source: 'harness',
                    owner: 'runtime-checkpoint-control-owner',
                    authorityRef: `fixture:${checkpoint.id.value}`,
                    sampleCommittedAt: async () => '2026-11-01T00:00:00.000Z',
                  },
                });
                return {
                  checkpoint,
                  previous: null,
                  commitRef: {
                    commitId: relationship.receipt.commitIdentity,
                    journalSeq: relationship.journalSeq,
                    recordDigest: relationship.recordDigest,
                  },
                };
              },
              async align() {
                return {
                  advanced: false,
                  state: 'terminal' as const,
                  reason: 'native retry turn aligned',
                  decision: 'complete' as const,
                  alignment,
                  admission: {
                    state: 'closed' as const,
                    decision: 'complete' as const,
                    alignment,
                    closure: {
                      identity,
                      checkpointId: checkpoint.id,
                      closureRef: 'closure:native-retry',
                      summary,
                      recoveryStateRef: refs[0]!,
                      closedAt: '2026-11-01T00:00:00.000Z',
                    },
                  },
                };
              },
              async readDelivery() {
                const bytes = new TextEncoder().encode('native retry request completed');
                const asset = { ref: refs[0]!, view: { kind: 'utf8-text' as const } };
                return {
                  assignment: {
                    assignmentId: allocation.assignmentId,
                    taskId: allocation.taskId,
                    pipelineNodeId: 'pipeline.execute',
                    attempt: 1,
                    executionEpoch: allocation.executionEpoch,
                    inputRevision: allocation.inputRevision,
                    objective: 'complete the native retry request',
                    targetRefs: [],
                    expectedOutputRefs: [],
                    successCriteria: [],
                    failureCriteria: [],
                    incompleteCriteria: [],
                    requiredCapabilities: [],
                    mergeGate: 'not-required' as const,
                  },
                  acceptedEnd: {
                    kind: 'standard-turn-end' as const,
                    identity,
                    outcome: 'completed' as const,
                    summary: {
                      goal: 'complete the native retry request',
                      actions: ['execute the provider turn'],
                      result: {
                        status: 'completed' as const,
                        text: 'native retry request completed',
                      },
                      nextStep: 'complete the task',
                    },
                    deliveryRefs: [],
                    resolvedEvidenceRefs: [],
                  },
                  materials: [{
                    kind: 'delivery-text' as const,
                    deliveryEvidence: refs[0]!,
                    rawArguments: asset,
                    bodyAsset: asset,
                    bytes,
                    digest: 'sha256:native-retry-fixture',
                    sourceEvidence: refs,
                    acceptedEndCall: {
                      seq: 1,
                      envelope: {
                        execution: {
                          runtimeId: allocation.runtimeId,
                          taskId: allocation.taskId,
                          executionEpoch: allocation.executionEpoch,
                        },
                        scope: allocation.scope,
                        request: { turnId: identity.turnId, requestId: 'request-native-retry-end' },
                        producerSeq: 1,
                        fact: {
                          kind: 'tool-call' as const,
                          contentUnitId: 'end',
                          call: {
                            callId: 'end',
                            toolId: 'humanagent.turn.end',
                            continuationRef: 'end-continuation',
                            arguments: {},
                          },
                          rawArguments: asset,
                          complete: true,
                        },
                      },
                    },
                  }],
                };
              },
            },
          });
        },
      }),
    },
  });
}

function nativeServiceFor(
  root: string,
  port: ExecutionRuntimePort,
  transientRetryWaiter?: RuntimeTransientRetryWaiter,
  checkpointStoreFactory?: (
    filePath: string,
    journal: JsonlOrganJournal,
  ) => ServiceExecutionCheckpointStore,
  taskJournal?: UiRuntimeJournal,
  closeRetainedTransientRetryProvider?: (
    allocation: RuntimeExecutionAllocation,
  ) => Promise<ProviderCloseResult>,
): UiRuntimeService {
  return nonOrchestratedServiceFor(
    root,
    port,
    true,
    transientRetryWaiter,
    checkpointStoreFactory,
    taskJournal,
    closeRetainedTransientRetryProvider,
  );
}

function nonNativeServiceFor(root: string, port: ExecutionRuntimePort): UiRuntimeService {
  return nonOrchestratedServiceFor(root, port, false);
}

const successSteps: ScriptedAttempt = {
  steps: [
    { kind: 'model', summary: 'model accepted the request' },
    { kind: 'output', summary: 'final answer', outputRefs: ['fake://output/1'] },
    { kind: 'terminal', terminalState: 'succeeded' },
  ],
  terminalState: 'succeeded',
};

const cleanFailureSteps: ScriptedAttempt = {
  steps: [
    { kind: 'model', summary: 'model rejected the request' },
    { kind: 'terminal', terminalState: 'failed' },
  ],
  terminalState: 'failed',
};

// A bare tool event records a real tool execution result without requesting a
// tool continuation, so it commits a side effect without a tool executor.
const sideEffectThenFailureSteps: ScriptedAttempt = {
  steps: [
    { kind: 'model', summary: 'model chose a tool' },
    { kind: 'tool', summary: 'tool executed and wrote a file' },
    { kind: 'terminal', terminalState: 'failed' },
  ],
  terminalState: 'failed',
};

test('有界纠正重试：首次可重试失败、第二次成功后任务成功并携带失败原因重派发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-success-'));
  try {
    const port = new ScriptedCorrectivePort({ binding }, [cleanFailureSteps, successSteps]);
    const service = orchestratedServiceFor(root, port);
    const task = service.createTask({ title: 'corrective retry success' });
    await service.startExecution(task.taskId, { prompt: 'write the deliverable', orchestrate: true });
    await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

    // 发生了两次 provider 尝试：首次失败 + 一次纠正。
    assert.equal(port.startCount, 2, `expected exactly one corrective re-dispatch, got ${port.startCount} provider attempts`);

    // 第二次模型请求携带上一轮失败原因，而不是原样盲重试。
    const firstPrompt = JSON.stringify(port.startPayloads[0]);
    const secondPrompt = JSON.stringify(port.startPayloads[1]);
    assert.ok(firstPrompt.includes('write the deliverable'), 'first request must carry the original prompt');
    assert.ok(secondPrompt.includes('write the deliverable'), 'second request must keep the original objective');
    assert.ok(secondPrompt.includes('纠正说明'), 'second request must carry the corrective instruction');
    assert.ok(secondPrompt.includes('第 1 次尝试执行失败'), 'second request must name the failed attempt');
    assert.ok(secondPrompt !== firstPrompt, 'second request must not blindly resend the original prompt');

    // 重试作为独立 step 投影到任务轨迹。
    const events = service.taskDashboard(task.taskId).history.events;
    const retryEvent = events.find((event) => (event.kind as string) === 'execution.retry' && event.state === 'retrying');
    assert.ok(retryEvent, 'trace must contain an execution.retry step for the corrective attempt');
    assert.ok((retryEvent!.summary ?? '').includes('第 2 次尝试'), 'retry step must name attempt 2');
    assert.ok((retryEvent!.summary ?? '').includes('重试原因'), 'retry step must state the retry reason');
    assert.ok(retryEvent!.error?.code, 'retry step must carry the exact typed error code');
    assert.ok((retryEvent!.error?.message ?? '').trim(), 'retry step must carry the actual failure reason');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：始终失败则达到上限后 blocked、retryable=false 并保留首次原因', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-exhausted-'));
  try {
    const port = new ScriptedCorrectivePort({ binding }, [cleanFailureSteps, cleanFailureSteps]);
    const service = orchestratedServiceFor(root, port);
    const task = service.createTask({ title: 'corrective retry exhausted' });
    await service.startExecution(task.taskId, { prompt: 'try and fail', orchestrate: true });
    await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'blocked'));

    // 硬上限：最多 2 次尝试（首次 + 1 次纠正），不得无限循环。
    assert.equal(port.startCount, 2, `retry loop must be bounded at 2 attempts, got ${port.startCount}`);

    const dashboard = service.taskDashboard(task.taskId);
    assert.ok(dashboard.error, 'a blocked task must surface the failure');
    assert.equal(dashboard.error!.retryable, false, 'exhausted retry must not report retryable=true');
    assert.ok((dashboard.error!.evidenceRefs ?? []).length > 0, 'exhausted retry must keep failure evidence');

    // 轨迹里应有一次重试步骤，但没有成功终止。
    const events = dashboard.history.events;
    assert.equal(events.some((event) => (event.kind as string) === 'execution.retry' && event.state === 'retrying'), true);

    // 达上限的终止轨迹必须给出尝试上限摘要，不得把它写成“已提交副作用”。
    const exhaustedEvent = events.find((event) => (event.kind as string) === 'execution.retry' && event.state === 'blocked');
    assert.ok(exhaustedEvent, '达上限应产生 blocked 终止轨迹');
    assert.ok((exhaustedEvent!.summary ?? '').includes('已达尝试上限'), '达上限摘要必须标注尝试上限');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：已提交副作用后失败则不重新派发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-side-effect-'));
  try {
    const port = new ScriptedCorrectivePort({ binding }, [sideEffectThenFailureSteps, successSteps]);
    const service = orchestratedServiceFor(root, port);
    const task = service.createTask({ title: 'corrective retry with side effect' });
    await service.startExecution(task.taskId, { prompt: 'run a tool then fail', orchestrate: true });
    await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'blocked'));

    // 首次尝试已产生 tool 执行结果（副作用），因此不得重新派发。
    assert.equal(port.startCount, 1, `no re-dispatch after a committed side effect, got ${port.startCount}`);

    const dashboard = service.taskDashboard(task.taskId);
    assert.equal(dashboard.error?.retryable, false);
    const events = dashboard.history.events;
    assert.equal(
      events.some((event) => (event.kind as string) === 'execution.retry' && event.state === 'retrying'),
      false,
      'a failed attempt with committed side effects must not produce a re-dispatch retry step',
    );
    // 必须产生显式 blocked/error 轨迹：摘要说明已提交副作用且未重派发，不得声称达到尝试上限。
    const sideEffectBlockedEvent = events.find((event) => (event.kind as string) === 'execution.retry' && event.state === 'blocked');
    assert.ok(sideEffectBlockedEvent, 'committed-side-effect failure must emit an explicit blocked error trace');
    assert.ok(
      (sideEffectBlockedEvent!.summary ?? '').includes('存在已提交副作用，未重派发'),
      'blocked summary must state that a committed side effect blocked the re-dispatch',
    );
    assert.equal(
      (sideEffectBlockedEvent!.summary ?? '').includes('已达尝试上限'),
      false,
      'blocked summary for a single-attempt side-effect failure must not claim the attempt cap was reached',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：native lane 的 HTTP 5xx start 失败后使用纠正 prompt 重派发一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-native-'));
  try {
    const port = new NativeStartFailurePort({ binding });
    const waits: Parameters<RuntimeTransientRetryWaiter>[0][] = [];
    const service = nativeServiceFor(root, port, async (input) => { waits.push(input); });
    const task = service.createTask({ title: 'native corrective retry' });
    await service.startExecution(task.taskId, { prompt: 'retry the native provider request' });
    await waitFor(() => {
      const dashboard = service.taskDashboard(task.taskId);
      assert.equal(dashboard.state, 'succeeded');
      assert.ok(dashboard.history.events.some((event) => (event.kind as string) === 'execution.terminal' && event.terminalPhase === 'final'));
    });

    assert.equal(port.startCount, 2, 'the native lane must dispatch exactly one corrective retry');
    const firstPrompt = JSON.stringify(port.startPayloads[0]);
    const secondPrompt = JSON.stringify(port.startPayloads[1]);
    assert.ok(firstPrompt.includes('retry the native provider request'));
    assert.ok(secondPrompt.includes('纠正说明'));
    assert.ok(secondPrompt.includes('第 1 次尝试执行失败'));
    assert.ok(secondPrompt.includes('HTTP 503'));
    assert.deepEqual(waits.map(({ delayMs }) => delayMs), [1_000]);
    assert.equal(port.startInputs.length, 2);
    assert.equal(port.startInputs[1]!.runtimeId, port.startInputs[0]!.runtimeId, 'the retry must reuse the admitted execution runtime');
    assert.equal(port.startInputs[1]!.operationId.value, port.startInputs[0]!.operationId.value, 'the retry must reuse the original operation');
    assert.equal(port.startInputs[1]!.executionEpoch, port.startInputs[0]!.executionEpoch, 'the retry must stay in the original execution epoch');
    assert.equal(waits[0]!.operationId.value, port.startInputs[0]!.operationId.value, 'the visible backoff must name the same operation');
    assert.equal(waits[0]!.executionEpoch, port.startInputs[0]!.executionEpoch, 'the visible backoff must name the same execution epoch');

    const events = service.taskDashboard(task.taskId).history.events;
    const retryEvent = events.find((event) => (event.kind as string) === 'execution.retry' && event.state === 'retrying');
    assert.ok(retryEvent, 'the native lane must project execution.retry/retrying');
    assert.ok((retryEvent!.summary ?? '').includes('第 2 次尝试'));
    assert.ok((retryEvent!.summary ?? '').includes('重试原因'));
    assert.equal(retryEvent!.error?.code, 'http.503');
    assert.ok((retryEvent!.error?.message ?? '').includes('HTTP 503'));
    assert.equal(retryEvent!.attemptNumber, 2);
    assert.equal(retryEvent!.maxAttempts, 11);
    assert.equal(retryEvent!.retryDelayMs, 1_000);
    assert.equal(retryEvent!.retryDeadlineAt, waits[0]!.deadlineAt);
    assert.equal(Date.parse(retryEvent!.retryDeadlineAt!) - Date.parse(retryEvent!.occurredAt), 1_000);

    const dashboard = service.taskDashboard(task.taskId);
    const projection = projectMainTopic({
      projectKey: 'corrective-retry',
      projectName: 'corrective retry',
      workspaceCwd: root,
      mode: 'fake',
      interactions: [{
        interactionId: 'corrective-retry-interaction',
        rawInput: 'retry the native provider request',
        state: 'dispatched',
        taskId: task.taskId,
      }],
      tasks: [{
        events: events.map((event) => ({
          ...event,
          eventId: `corrective-retry-${event.seq}`,
          taskId: task.taskId,
          operationId: 'corrective-retry-operation',
          executionEpoch: 1,
          kind: event.kind as RuntimeSseEvent['kind'],
        })),
        taskId: task.taskId,
        title: dashboard.taskTitle,
        state: dashboard.state,
        stateLabel: dashboard.stateLabel,
        currentNode: dashboard.currentNode,
        nextStep: dashboard.nextStep,
        output: dashboard.output,
        updatedAt: events.at(-1)?.occurredAt ?? new Date(0).toISOString(),
        error: dashboard.error,
        sourceInteractionId: 'corrective-retry-interaction',
      }],
    });
    const projectedRetry = projection.turns
      .flatMap((turn) => turn.statusFacts?.events ?? [])
      .find((event) => event.kind === 'execution.retry' && event.state === 'retrying');
    assert.equal(projectedRetry?.summary, retryEvent!.summary);
    assert.equal(projectedRetry?.error?.code, 'http.503');
    assert.ok((projectedRetry?.error?.message ?? '').includes('HTTP 503'));
    assert.equal(projectedRetry?.attemptNumber, 2);
    assert.equal(projectedRetry?.maxAttempts, 11);
    assert.equal(projectedRetry?.retryDelayMs, 1_000);
    assert.equal(projectedRetry?.retryDeadlineAt, retryEvent!.retryDeadlineAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：retryable 非 http.5xx start 错误不得进入 native 纠正循环并保留原错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-non5xx-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'transport.request.failed',
      message: 'RCC v3 transport failed before a response',
      failures: 2,
      retryable: 'retryable',
    });
    const service = nativeServiceFor(root, port);
    const task = service.createTask({ title: 'native retryable non-5xx start' });
    await service.startExecution(task.taskId, { prompt: 'retry the native provider request' });
    await waitFor(() => {
      const dashboard = service.taskDashboard(task.taskId);
      assert.equal(dashboard.state, 'blocked');
      assert.ok(dashboard.history.events.some((event) => (event.kind as string) === 'execution.terminal' && event.terminalPhase === 'final'));
    });

    assert.equal(port.startCount, 1, 'a retryable non-http.5xx start error must not be re-submitted by the native loop');
    const dashboard = service.taskDashboard(task.taskId);
    assert.equal(dashboard.error?.code, 'transport.request.failed', 'the original transport error code must be preserved');
    assert.ok((dashboard.error?.message ?? '').includes('transport failed'), 'the original transport error message must be preserved');
    assert.ok((dashboard.error?.evidenceRefs ?? []).length > 0, 'the original failure evidence must be preserved');
    const events = dashboard.history.events;
    assert.equal(
      events.some((event) => (event.kind as string) === 'execution.retry' && event.state === 'retrying'),
      false,
      'a retryable non-http.5xx start error must not emit execution.retry/retrying',
    );
    const terminal = events.find((event) => (event.kind as string) === 'execution.terminal' && event.terminalPhase === 'final');
    assert.ok(terminal, 'the original failure must close through the existing terminal path');
    assert.equal(terminal!.state, 'blocked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：native 退避期间 stop 唤醒同一执行且不发出下一次请求', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-native-stop-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.503',
      message: 'RCC v3 returned HTTP 503: wait for stop',
      failures: 1,
    });
    let enteredBackoff!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    let aborted = false;
    let waitingForStop = true;
    const service = nativeServiceFor(root, port, async (input) => {
      enteredBackoff();
      if (!waitingForStop) return;
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      });
    });
    const task = service.createTask({ title: 'native retry stopped during backoff' });
    await service.startExecution(task.taskId, { prompt: 'stop during retry backoff' });
    await backoffEntered;
    assert.equal(port.startCount, 1, 'the retry backoff must begin after the initial failed start');

    const stopped = await service.stop(task.taskId);
    waitingForStop = false;
    assert.equal(stopped.state, 'stopped', 'stop waits for the committed stopped checkpoint');
    const dashboard = service.taskDashboard(task.taskId);
    assert.equal(dashboard.state, 'stopped');
    assert.equal(dashboard.checkpoint?.outcome, 'stopped');
    assert.ok(dashboard.history.events.some((event) => event.kind === 'execution.retry' && event.state === 'cancelled'),
      'the visible retry state closes when the backoff is cancelled');
    assert.ok(dashboard.history.events.some((event) => event.kind === 'execution.terminal' && event.state === 'stopped'),
      'the stop publishes its final terminal after the checkpoint');
    assert.equal(aborted, true, 'stop must abort the active backoff wait');
    assert.equal(port.startCount, 1, 'an aborted backoff must not send a second provider request');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：退避停止的 checkpoint 写失败保留原错并可恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-stop-checkpoint-failure-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.503',
      message: 'RCC v3 returned HTTP 503: checkpoint failure stop',
      failures: 1,
    });
    let enteredBackoff!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    let store: OneShotStoppedCheckpointFailureStore | undefined;
    const service = nativeServiceFor(root, port, async (input) => {
      enteredBackoff();
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }, (filePath, journal) => {
      store = new OneShotStoppedCheckpointFailureStore(filePath, journal, () => new Date());
      store.failNextStoppedCommit = true;
      return store;
    });
    const task = service.createTask({ title: 'native retry stop checkpoint failure' });
    await service.startExecution(task.taskId, { prompt: 'stop while checkpoint storage fails' });
    await backoffEntered;
    const beforeStop = service.taskDashboard(task.taskId);

    let stopFailure: unknown;
    try {
      await service.stop(task.taskId);
    } catch (error) {
      stopFailure = error;
    }
    assert.equal((stopFailure as { readonly code?: unknown } | undefined)?.code, 'http.503',
      'a checkpoint failure must not replace the original Provider failure');
    assert.ok(store, 'the controlled checkpoint store must be composed');
    assert.equal(port.startCount, 1, 'the checkpoint failure path must not start another Provider request');

    const failed = service.taskDashboard(task.taskId);
    assert.equal(failed.state, 'blocked');
    assert.equal(failed.operationId, beforeStop.operationId, 'the failed stop must keep the original operation');
    assert.equal(failed.error?.code, 'http.503');
    assert.ok((failed.error?.evidenceRefs ?? []).some((ref) => ref.locator === port.failureEvidence[0]?.locator),
      'the failed stop must keep the first Provider failure evidence');
    assert.ok(failed.error?.cleanupError, 'the checkpoint failure must stay attached as cleanup responsibility');
    assert.deepEqual(failed.allowedActions, ['retry-stop']);
    assert.equal(failed.checkpoint, undefined, 'an uncommitted stopped checkpoint must not be claimed');
    assert.equal(failed.history.events.some((event) => event.kind === 'execution.terminal' && event.state === 'stopped'), false,
      'an uncommitted stop must not publish a stopped terminal');

    const recovered = await service.retryStop(task.taskId);
    assert.equal(recovered.state, 'stopped');
    assert.equal(recovered.operationId, beforeStop.operationId);
    const stopped = service.taskDashboard(task.taskId);
    assert.equal(stopped.checkpoint?.outcome, 'stopped');
    assert.equal(stopped.allowedActions.includes('retry-stop'), false);
    assert.equal(stopped.history.events.some((event) => event.kind === 'execution.terminal' && event.state === 'stopped'), true);
    assert.equal(port.startCount, 1, 'recovering the stop must not resend the Provider request');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：stopped checkpoint 已提交后的 close 失败保留原错并可恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-stop-close-failure-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.503',
      message: 'RCC v3 returned HTTP 503: close failure stop',
      failures: 1,
    });
    port.closeFailuresRemaining = 1;
    let enteredBackoff!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    const service = nativeServiceFor(root, port, async (input) => {
      enteredBackoff();
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const task = service.createTask({ title: 'native retry stop close failure' });
    await service.startExecution(task.taskId, { prompt: 'stop while provider close fails' });
    await backoffEntered;
    const beforeStop = service.taskDashboard(task.taskId);

    let stopFailure: unknown;
    try {
      await service.stop(task.taskId);
    } catch (error) {
      stopFailure = error;
    }
    assert.equal((stopFailure as { readonly code?: unknown } | undefined)?.code, 'http.503',
      'a post-commit close failure must not replace the original Provider failure');
    assert.equal(port.startCount, 1, 'the close failure path must not start another Provider request');
    assert.equal(port.closeCount, 1);

    const failed = service.taskDashboard(task.taskId);
    assert.equal(failed.state, 'blocked');
    assert.equal(failed.operationId, beforeStop.operationId, 'the failed close must keep the original operation');
    assert.equal(failed.checkpoint?.outcome, 'stopped');
    assert.equal(failed.error?.code, 'http.503');
    assert.ok((failed.error?.evidenceRefs ?? []).some((ref) => ref.locator === port.failureEvidence[0]?.locator),
      'the post-commit close failure must keep the first Provider failure evidence');
    assert.equal(failed.error?.cleanupError?.code, 'provider.close.failed');
    assert.deepEqual(failed.allowedActions, ['retry-stop']);
    assert.equal(failed.history.events.some((event) => event.kind === 'execution.terminal' && event.state === 'stopped'), false,
      'an unclosed stop must not publish a stopped terminal');

    const recovered = await service.retryStop(task.taskId);
    assert.equal(recovered.state, 'stopped');
    assert.equal(recovered.operationId, beforeStop.operationId);
    assert.equal(port.closeCount, 2, 'retry-stop must retry the resource close');
    const stopped = service.taskDashboard(task.taskId);
    assert.equal(stopped.history.events.filter((event) => event.kind === 'checkpoint.committed' && event.state === 'stopped').length, 1,
      'the committed stopped checkpoint must be reused without a second commit');
    assert.equal(stopped.history.events.some((event) => event.kind === 'execution.terminal' && event.state === 'stopped'), true);
    assert.equal(port.startCount, 1, 'recovering the close must not resend the Provider request');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：live stop 只关闭 A 的原 driver，B 继续执行且不调用 retained cold port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-live-close-isolation-'));
  const port = new NativeStartFailurePort({ binding, stepDelayMs: 0 }, {
    code: 'http.503',
    message: 'RCC v3 returned HTTP 503: live close isolation',
    failures: 1,
  });
  port.isolateClose = true;
  port.holdSecondObserve = true;
  let service: UiRuntimeService | undefined;
  let bOperationId: Parameters<UiRuntimeService['eventsSince']>[0] | undefined;
  try {
    let enteredBackoff!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    const retainedCloseAllocations: RuntimeExecutionAllocation[] = [];
    service = nativeServiceFor(root, port, async (input) => {
      enteredBackoff();
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }, undefined, undefined, async (allocation) => {
      retainedCloseAllocations.push(structuredClone(allocation));
      return {
        bindingId: binding.bindingId,
        providerId: binding.providerId,
        protocol: binding.protocol,
        state: 'closed',
        evidenceRefs: [evidence('unexpected-retained-close', allocation.scope)],
      };
    });
    const a = service.createTask({ title: 'A waiting in retry backoff' });
    await service.startExecution(a.taskId, { prompt: 'stop A while B is active' });
    await backoffEntered;
    const b = service.createTask({ title: 'B remains active' });
    bOperationId = (await service.startExecution(b.taskId, { prompt: 'finish B after A stops' })).operationId;
    await port.secondObserveStarted;
    assert.equal(service.taskDashboard(b.taskId).state, 'running');

    const stoppedA = await service.stop(a.taskId);
    assert.equal(stoppedA.state, 'stopped');
    assert.equal(port.closeCount, 1, 'A must close through its original live driver');
    assert.equal(retainedCloseAllocations.length, 0, 'a live driver must not fall through to the cold retained port');
    assert.equal(service.taskDashboard(b.taskId).state, 'running', 'closing A must leave B active');
    assert.equal(service.taskDashboard(b.taskId).history.events.some((event) =>
      event.kind === 'execution.terminal' && event.state === 'stopped'), false);
    assert.equal(service.taskDashboard(a.taskId).history.events.filter((event) =>
      event.kind === 'execution.terminal' && event.state === 'stopped').length, 1);

    await service.quiesceImplicitConsumption();
    port.releaseSecondObserve();
    await waitFor(() => {
      const terminal = service!.eventsSince(bOperationId!)
        .find((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final');
      assert.equal(terminal?.state, 'succeeded');
    });
    assert.equal(port.closeCount, 2, 'B must retain its own close path after A finishes');
  } finally {
    await service?.quiesceImplicitConsumption();
    port.releaseSecondObserve();
    if (service !== undefined && bOperationId !== undefined) {
      await waitFor(() => assert.ok(service!.eventsSince(bOperationId!)
        .some((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final')));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：并发 retry-stop 共享同一停止收拢，不重复 checkpoint、close 或终态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-concurrent-retry-stop-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.503',
      message: 'RCC v3 returned HTTP 503: concurrent retry stop',
      failures: 1,
    });
    port.closeFailuresRemaining = 1;
    let enteredBackoff!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    const service = nativeServiceFor(root, port, async (input) => {
      enteredBackoff();
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const task = service.createTask({ title: 'concurrent retry stop ownership' });
    await service.startExecution(task.taskId, { prompt: 'stop once while two retry requests overlap' });
    await backoffEntered;
    const beforeStop = service.taskDashboard(task.taskId);
    await assert.rejects(() => service.stop(task.taskId));
    assert.equal(port.closeCount, 1);

    let releaseClose!: () => void;
    port.closeWait = new Promise<void>((resolve) => { releaseClose = resolve; });
    const first = service.retryStop(task.taskId);
    const second = service.retryStop(task.taskId);
    await waitFor(() => assert.ok(port.closeCount >= 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseClose();
    const [left, right] = await Promise.all([first, second]);

    assert.deepEqual(left, { state: 'stopped', operationId: beforeStop.operationId });
    assert.deepEqual(right, left, 'both concurrent retry-stop callers reuse the stopped result');
    assert.equal(port.closeCount, 2, 'one failed close plus exactly one shared recovery close');
    assert.equal(port.startCount, 1, 'stop recovery must not resend the Provider request');
    const stopped = service.taskDashboard(task.taskId);
    assert.equal(stopped.checkpoint?.outcome, 'stopped');
    assert.equal(stopped.history.events.filter((event) => event.kind === 'checkpoint.committed' && event.state === 'stopped').length, 1,
      'concurrent retry-stop callers must share the committed stopped checkpoint');
    assert.equal(stopped.history.events.filter((event) => event.kind === 'execution.terminal' && event.state === 'stopped').length, 1,
      'concurrent retry-stop callers must share one final stopped terminal');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：最终停止事件追加失败后同实例和冷读都只发布一次终态', async () => {
  const roots: string[] = [];
  try {
    for (const coldRead of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), `humanagent-corrective-retry-terminal-failure-${coldRead ? 'cold' : 'same'}-`));
      roots.push(root);
      const port = new NativeStartFailurePort({ binding }, {
        code: 'http.503',
        message: 'RCC v3 returned HTTP 503: terminal append failure',
        failures: 1,
      });
      let enteredBackoff!: () => void;
      const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
      const journal = new OneShotStopSettlementFailureJournal(join(root, 'ui-runtime-journal.jsonl'));
      const service = nativeServiceFor(root, port, async (input) => {
        enteredBackoff();
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }, undefined, journal);
      const task = service.createTask({ title: `terminal append failure ${coldRead ? 'cold' : 'same'}` });
      await service.startExecution(task.taskId, { prompt: 'retain the final stopped event obligation' });
      await backoffEntered;
      const beforeStop = service.taskDashboard(task.taskId);
      journal.failNextStoppedTerminalAppend = true;
      await assert.rejects(() => service.stop(task.taskId));

      assert.equal(port.closeCount, 1, 'the provider close must happen before the failed final event append');
      assert.equal(port.startCount, 1, 'terminal append recovery must not send another Provider request');
      const failed = service.taskDashboard(task.taskId);
      assert.equal(failed.state, 'blocked');
      assert.deepEqual(failed.allowedActions, ['retry-stop']);
      assert.equal(failed.history.events.some((event) => event.kind === 'execution.terminal' && event.state === 'stopped'), false);

      if (!coldRead) {
        const stopped = await service.retryStop(task.taskId);
        assert.deepEqual(stopped, { state: 'stopped', operationId: beforeStop.operationId });
        assert.equal(port.closeCount, 1, 'same-instance terminal retry must reuse the persisted close');
      } else {
        let retainedCloseCount = 0;
        const cold = nativeServiceFor(root, port, undefined, undefined, undefined, async (allocation) => {
          assert.equal(allocation.operationId.value, beforeStop.operationId);
          assert.equal(allocation.executionEpoch, beforeStop.executionEpoch);
          retainedCloseCount += 1;
          return port.close(binding);
        });
        await cold.hydrate();
        const recovered = cold.taskDashboard(task.taskId);
        assert.deepEqual(recovered.allowedActions, ['retry-stop']);
        const stopped = await cold.retryStop(task.taskId);
        assert.deepEqual(stopped, { state: 'stopped', operationId: beforeStop.operationId });
        assert.equal(retainedCloseCount, 0, 'terminal publication after cold read must not call the close port');
        assert.equal(port.closeCount, 1, 'cold terminal retry must reuse the persisted close');
      }

      const final = (coldRead
        ? nativeServiceFor(root, port)
        : service).taskDashboard(task.taskId);
      assert.equal(final.history.events.filter((event) => event.kind === 'execution.terminal' && event.state === 'stopped').length, 1,
        'terminal append recovery must publish exactly one stopped event');
    }
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test('有界纠正重试：pending stop 写失败不提前取消退避或伪造 stopping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-stop-intent-failure-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.503',
      message: 'RCC v3 returned HTTP 503: stop intent failure',
      failures: 1,
    });
    let enteredBackoff!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    let aborted = false;
    const journal = new OneShotStopSettlementFailureJournal(join(root, 'ui-runtime-journal.jsonl'));
    const service = nativeServiceFor(root, port, async (input) => {
      enteredBackoff();
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      });
    }, undefined, journal);
    const task = service.createTask({ title: 'stop intent append failure' });
    await service.startExecution(task.taskId, { prompt: 'keep the backoff live when stop intent cannot persist' });
    await backoffEntered;
    const beforeStop = service.taskDashboard(task.taskId);

    journal.failNextStopSettlementAppend = true;
    await assert.rejects(() => service.stop(task.taskId), /controlled stop intent journal append failure/);
    assert.equal(aborted, false, 'a failed typed stop intent must not cancel the active backoff');
    const afterFailure = service.taskDashboard(task.taskId);
    assert.equal(afterFailure.state, beforeStop.state, 'a failed typed stop intent must not fabricate stopping');
    assert.deepEqual(afterFailure.allowedActions, beforeStop.allowedActions);
    assert.equal(afterFailure.history.events.some((event) => event.kind === 'execution.retry' && event.state === 'cancelled'), false);
    assert.equal(port.startCount, 1, 'the retry backoff must stay on the original failed request');

    const stopped = await service.stop(task.taskId);
    assert.equal(stopped.state, 'stopped');
    assert.equal(aborted, true, 'a later typed stop intent can still cancel the same backoff');
    assert.equal(port.startCount, 1, 'recovering the stop intent failure must not resend the Provider request');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：冷读恢复未提交 stopped checkpoint，并保留可执行 retry-stop 义务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-cold-uncommitted-stop-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.503',
      message: 'RCC v3 returned HTTP 503: cold uncommitted stop',
      failures: 1,
    });
    let enteredBackoff!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    const original = nativeServiceFor(root, port, async (input) => {
      enteredBackoff();
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }, (filePath, journal) => {
      const store = new OneShotStoppedCheckpointFailureStore(filePath, journal, () => new Date());
      store.failNextStoppedCommit = true;
      return store;
    });
    const task = original.createTask({ title: 'cold uncommitted retry stop' });
    await original.startExecution(task.taskId, { prompt: 'persist an uncommitted stop obligation' });
    await backoffEntered;
    const beforeStop = original.taskDashboard(task.taskId);
    await assert.rejects(() => original.stop(task.taskId));

    const retainedCloseAllocations: RuntimeExecutionAllocation[] = [];
    const cold = nativeServiceFor(root, port, undefined, undefined, undefined, async (allocation) => {
      retainedCloseAllocations.push(structuredClone(allocation));
      return port.close(binding);
    });
    await cold.hydrate();
    const recovered = cold.taskDashboard(task.taskId);
    assert.equal(recovered.state, 'blocked');
    assert.equal(recovered.operationId, beforeStop.operationId);
    assert.equal(recovered.checkpoint, undefined, 'an uncommitted stop must not be claimed as stopped');
    assert.equal(recovered.error?.code, 'http.503', 'cold recovery preserves the first Provider error');
    assert.equal(recovered.error?.cleanupError?.code, 'runtime.execution.failure',
      'the checkpoint failure remains attached as cleanup responsibility');
    assert.deepEqual(recovered.allowedActions, ['retry-stop']);
    assert.equal(port.startCount, 1, 'cold hydrate must not send another Provider request');

    const stopped = await cold.retryStop(task.taskId);
    assert.deepEqual(stopped, { state: 'stopped', operationId: beforeStop.operationId });
    assert.equal(retainedCloseAllocations.length, 1,
      'cold retry-stop must use the retained provider close port');
    assert.equal(retainedCloseAllocations[0]!.operationId.value, beforeStop.operationId);
    assert.equal(retainedCloseAllocations[0]!.executionEpoch, beforeStop.executionEpoch);
    assert.equal(port.closeCount, 1, 'cold checkpoint recovery must close the original binding exactly once');
    const final = cold.taskDashboard(task.taskId);
    assert.equal(final.checkpoint?.outcome, 'stopped');
    assert.equal(final.history.events.filter((event) => event.kind === 'checkpoint.committed' && event.state === 'stopped').length, 1);
    assert.equal(final.history.events.filter((event) => event.kind === 'execution.terminal' && event.state === 'stopped').length, 1);
    assert.equal(port.startCount, 1, 'cold retry-stop must not resend the Provider request');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：冷读恢复已提交 stopped checkpoint，并保留 close 义务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-cold-committed-stop-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.503',
      message: 'RCC v3 returned HTTP 503: cold committed stop',
      failures: 1,
    });
    port.closeFailuresRemaining = 1;
    let enteredBackoff!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    const original = nativeServiceFor(root, port, async (input) => {
      enteredBackoff();
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const task = original.createTask({ title: 'cold committed retry stop' });
    await original.startExecution(task.taskId, { prompt: 'persist a committed stop close obligation' });
    await backoffEntered;
    const beforeStop = original.taskDashboard(task.taskId);
    await assert.rejects(() => original.stop(task.taskId));
    assert.equal(port.closeCount, 1);

    const committedCloseAllocations: RuntimeExecutionAllocation[] = [];
    const cold = nativeServiceFor(root, port, undefined, undefined, undefined, async (allocation) => {
      committedCloseAllocations.push(structuredClone(allocation));
      return port.close(binding);
    });
    await cold.hydrate();
    const recovered = cold.taskDashboard(task.taskId);
    assert.equal(recovered.state, 'blocked');
    assert.equal(recovered.operationId, beforeStop.operationId);
    assert.equal(recovered.checkpoint?.outcome, 'stopped');
    assert.equal(recovered.error?.code, 'http.503', 'cold recovery preserves the first Provider error');
    assert.equal(recovered.error?.cleanupError?.code, 'provider.close.failed',
      'the close failure remains attached as recovery responsibility');
    assert.deepEqual(recovered.allowedActions, ['retry-stop']);
    assert.equal(port.startCount, 1, 'cold hydrate must not send another Provider request');

    const stopped = await cold.retryStop(task.taskId);
    assert.deepEqual(stopped, { state: 'stopped', operationId: beforeStop.operationId });
    assert.equal(committedCloseAllocations.length, 1,
      'cold retry-stop must use the retained provider close port');
    assert.equal(committedCloseAllocations[0]!.operationId.value, beforeStop.operationId);
    assert.equal(committedCloseAllocations[0]!.executionEpoch, beforeStop.executionEpoch);
    assert.equal(port.closeCount, 2, 'cold retry-stop retries the outstanding close exactly once');
    const final = cold.taskDashboard(task.taskId);
    assert.equal(final.history.events.filter((event) => event.kind === 'checkpoint.committed' && event.state === 'stopped').length, 1,
      'the committed stopped checkpoint is reused after cold hydrate');
    assert.equal(final.history.events.filter((event) => event.kind === 'execution.terminal' && event.state === 'stopped').length, 1);
    assert.equal(port.startCount, 1, 'cold retry-stop must not resend the Provider request');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：native 首次加十次 http.5xx start 失败后发射 blocked 终止并保留首次证据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-native-exhausted-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.500',
      message: 'RCC v3 returned HTTP 500: deterministic first failure',
      retryCode: 'http.502',
      retryMessage: 'RCC v3 returned HTTP 502: deterministic later failure',
      failures: 11,
    });
    const waits: Parameters<RuntimeTransientRetryWaiter>[0][] = [];
    const service = nativeServiceFor(root, port, async (input) => { waits.push(input); });
    const task = service.createTask({ title: 'native corrective retry exhausted' });
    await service.startExecution(task.taskId, { prompt: 'retry and keep failing' });
    await waitFor(() => {
      const dashboard = service.taskDashboard(task.taskId);
      assert.equal(dashboard.state, 'blocked');
      assert.ok(dashboard.history.events.some((event) => (event.kind as string) === 'execution.terminal' && event.terminalPhase === 'final'));
    });

    assert.equal(port.startCount, 11, 'the native lane must make the initial attempt and ten bounded retries');
    assert.deepEqual(waits.map(({ delayMs }) => delayMs), [1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000]);
    const dashboard = service.taskDashboard(task.taskId);
    assert.equal(dashboard.error?.retryable, false, 'exhausted native retry must not report retryable=true');
    assert.equal(dashboard.error?.code, 'http.500', 'the exhausted native retry must keep the original provider error code');
    assert.ok((dashboard.error?.message ?? '').includes('HTTP 500'), 'the exhausted native retry must keep the original provider error message');
    assert.ok((dashboard.error?.evidenceRefs ?? []).length > 0, 'the exhausted native retry must keep failure evidence');
    assert.ok(port.failureEvidence.length >= 1, 'the first provider failure evidence must be captured');
    const firstFailureLocator = port.failureEvidence[0]?.locator;
    assert.ok(
      (dashboard.error?.evidenceRefs ?? []).some((ref) => ref.locator === firstFailureLocator),
      'the first failure evidence must survive exhaustion',
    );

    const events = dashboard.history.events;
    const retryingEvents = events.filter((event) => (event.kind as string) === 'execution.retry' && event.state === 'retrying');
    assert.equal(retryingEvents.length, 10, 'the native lane must emit one retry event per bounded backoff');
    assert.deepEqual(
      retryingEvents.map((event) => event.attemptNumber),
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      'the native lane must expose each real retry attempt number',
    );
    assert.ok(
      (retryingEvents[0]?.evidenceRefs ?? []).some((ref) => ref.locator === firstFailureLocator),
      'the retrying event must carry the first provider failure evidence',
    );
    assert.equal(retryingEvents[0]?.error?.code, 'http.500', 'the retrying event must carry the exact typed error');
    assert.ok(
      (retryingEvents[0]?.error?.message ?? '').includes('HTTP 500'),
      'the retrying event must carry the actual provider failure reason',
    );
    const retryEvents = events.filter((event) => (event.kind as string) === 'execution.retry');
    const blockedRetry = retryEvents.find((event) => (event.kind as string) === 'execution.retry' && event.state === 'blocked');
    assert.ok(blockedRetry, 'exhaustion must emit exactly one execution.retry/blocked event');
    assert.ok((blockedRetry!.summary ?? '').includes('已达尝试上限（11 次）'), 'the blocked summary must state the attempt cap');
    assert.equal(blockedRetry!.maxAttempts, 11);
    assert.equal(blockedRetry!.error?.code, 'http.500', 'the blocked retry must retain the first provider error');
    assert.equal(port.startInputs.length, 11);
    assert.equal(
      new Set(port.startInputs.map((input) => `${input.runtimeId}:${input.operationId.value}:${input.executionEpoch}`)).size,
      1,
      'all bounded attempts must reuse one runtime, operation and execution epoch',
    );
    assert.equal(retryEvents.filter((event) => (event.kind as string) === 'execution.retry' && event.state === 'blocked').length, 1,
      'exhaustion must emit exactly one blocked retry event',
    );
    const terminal = events.find((event) => (event.kind as string) === 'execution.terminal' && event.terminalPhase === 'final');
    assert.ok(terminal, 'exhaustion must route through the existing terminal failure closure');
    assert.equal(terminal!.state, 'blocked', 'the exhausted native retry must close as execution.terminal blocked');
    assert.equal(terminal!.retryable, false, 'the exhausted terminal must not be retryable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：非 native 非编排执行不得进入纠正重试循环', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-non-native-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.503',
      message: 'RCC v3 returned HTTP 503: non-native lane must stay single-attempt',
      failures: 2,
    });
    const service = nonNativeServiceFor(root, port);
    const task = service.createTask({ title: 'non-native no retry' });
    await service.startExecution(task.taskId, { prompt: 'do not retry this lane' });
    await waitFor(() => {
      const dashboard = service.taskDashboard(task.taskId);
      assert.equal(dashboard.state, 'failed');
      assert.ok(dashboard.history.events.some((event) => (event.kind as string) === 'execution.terminal' && event.terminalPhase === 'final'));
    });

    assert.equal(port.startCount, 1, 'a non-native orchestrate:false driver must not re-submit after an HTTP 5xx start failure');
    const dashboard = service.taskDashboard(task.taskId);
    const events = dashboard.history.events;
    assert.equal(
      events.some((event) => (event.kind as string) === 'execution.retry' && event.state === 'retrying'),
      false,
      'a non-native orchestrate:false driver must not emit execution.retry/retrying',
    );
    assert.equal(
      events.some((event) => (event.kind as string) === 'execution.retry' && event.state === 'blocked'),
      false,
      'a non-native orchestrate:false driver must not emit execution.retry/blocked',
    );
    assert.equal(dashboard.error?.code, 'http.503', 'the non-native lane must preserve the original provider error');
    assert.equal(dashboard.error?.retryable, false, 'the non-native lane must not report retryable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('有界纠正重试：暂态 http.429 进入 native 退避重试，所有候选账号限额/禁用则立即失败', async () => {
  const transientRoot = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-429-transient-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.429',
      message: 'RCC v3 returned HTTP 429: temporary upstream rate limit',
      failures: 1,
    });
    const waits: Parameters<RuntimeTransientRetryWaiter>[0][] = [];
    const service = nativeServiceFor(transientRoot, port, async (input) => { waits.push(input); });
    const task = service.createTask({ title: 'native transient 429 retry' });
    await service.startExecution(task.taskId, { prompt: 'retry transient 429' });
    await waitFor(() => {
      const dashboard = service.taskDashboard(task.taskId);
      assert.equal(dashboard.state, 'succeeded');
      assert.ok(dashboard.history.events.some((event) => (event.kind as string) === 'execution.terminal' && event.terminalPhase === 'final'));
    });
    assert.equal(port.startCount, 2);
    assert.equal(waits.length, 1);
    assert.equal(service.taskDashboard(task.taskId).history.events.some((event) => (event.kind as string) === 'execution.retry' && event.error?.code === 'http.429'), true);
  } finally {
    await rm(transientRoot, { recursive: true, force: true });
  }

  const exhaustedRoot = await mkdtemp(join(tmpdir(), 'humanagent-corrective-retry-429-exhausted-'));
  try {
    const port = new NativeStartFailurePort({ binding }, {
      code: 'http.429',
      message: 'RCC v3 returned HTTP 429: {"error":{"code":429,"message":"所有候选账号对模型 gpt-5.1 均已限额或禁用"}}',
      failures: 2,
    });
    const service = nativeServiceFor(exhaustedRoot, port);
    const task = service.createTask({ title: 'native exhausted 429 no retry' });
    await service.startExecution(task.taskId, { prompt: 'do not retry exhausted 429' });
    await waitFor(() => {
      const dashboard = service.taskDashboard(task.taskId);
      assert.equal(dashboard.state, 'blocked');
      assert.ok(dashboard.history.events.some((event) => (event.kind as string) === 'execution.terminal' && event.terminalPhase === 'final'));
    });
    assert.equal(port.startCount, 1, 'exhausted all-accounts 429 must not burn 10 start retries');
    assert.equal(service.taskDashboard(task.taskId).error?.code, 'http.429');
  } finally {
    await rm(exhaustedRoot, { recursive: true, force: true });
  }
});
