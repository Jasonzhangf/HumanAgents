import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
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
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
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
