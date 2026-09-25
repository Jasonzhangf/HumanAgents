import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PIPELINE_NODE_IDS,
  PIPELINE_ROWS,
  id,
  type Attention,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type MemoryActorContext,
  type MemoryScope,
  type MemorySubmission,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderSubmitResult,
  type RequirementEnvelope,
  type ScopeRef,
  type TaskId,
} from '../../packages/contracts/src/index.js';
import { ProviderAdapterError } from '../../packages/adapters/provider/src/index.js';
import {
  digestAgentTemplate,
  type AgentTemplateManifest,
} from '../../packages/agent-templates/src/index.js';
import {
  AgentRuntime,
  MemoryCoordinator,
  bindAgentDriver,
  executeStopControl,
  type AttentionPort,
} from '../../packages/runtime/src/index.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';
import type { CheckpointClosurePort } from '../../packages/runtime/src/checkpoints/ports.js';
import type { ClosureRecord } from '../../packages/runtime/src/checkpoints/closure.js';
import { createHookRegistry, type AgentHookRegistry } from '../../packages/runtime/src/hooks/index.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
  type RuntimeCheckpointBoundary,
  type RuntimeCheckpointBoundaryPort,
  type RuntimeTaskJournalRecord,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';
import {
  FileCheckpointStore,
  FakeReplayExecutionRuntimePort,
  MemoryBoundExecutionDriver,
  MemoryContextCapture,
  UiRuntimeJournal,
  UiRuntimeApiError,
  UiRuntimeService,
  buildFakeExecutionPort,
  startUiRuntime as startUiRuntimeOwner,
} from '../../packages/app/src/ui-runtime/index.js';
import { startUiRuntimeServer } from '../../packages/app/src/ui-runtime/server.js';
import { RESPONSES_FILE_READ_TOOL } from '../../packages/app/src/provider-tool-execution.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import {
  createProviderExplicitBrainInterpreter,
  type ExplicitBrainInputInterpreter,
} from '../../packages/app/src/explicit-brain-runtime.js';

const organId = id('organ', 'organ-ui-test');
const builtinTemplateRoot = join(process.cwd(), 'packages', 'agent-templates', 'templates');
const binding: ProviderBinding = {
  bindingId: 'binding-ui-test',
  providerId: 'provider-ui-test',
  protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-ui-test',
  configDigest: 'sha256:ui-test-config',
  capabilityDigest: 'sha256:ui-test-capability',
};

const unusedExplicitBrainInterpreter: ExplicitBrainInputInterpreter = {
  async interpret() {
    throw new Error('explicit brain interpretation is not configured for this test');
  },
};

function startUiRuntime(
  options: Parameters<typeof startUiRuntimeOwner>[0],
): ReturnType<typeof startUiRuntimeOwner> {
  return startUiRuntimeOwner({
    ...options,
    explicitBrainInterpreter: options.explicitBrainInterpreter ?? unusedExplicitBrainInterpreter,
  });
}

function explicitArgumentsDigest(args: Readonly<Record<string, unknown>>): string {
  const stable = JSON.stringify(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${createHash('sha256').update(stable).digest('hex')}`;
}

function appendCheckpoint(store: FileCheckpointStore, checkpoint: Checkpoint): Promise<unknown> {
  return store.append({ ownerId: 'app-test', commitId: checkpointCommitId(checkpoint), checkpoint });
}

function evidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `ui-test-${label}`),
    kind: 'operation',
    source: 'ui-runtime-test',
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

class DelayedMemoryBackend extends DeterministicMemoryBackend {
  constructor(private readonly gate: Promise<void>) {
    super();
  }

  override async recall(input: Parameters<DeterministicMemoryBackend['recall']>[0]) {
    await this.gate;
    return super.recall(input);
  }
}

class FailingMemoryBackend extends DeterministicMemoryBackend {
  override async recall(): Promise<never> {
    throw new Error('forced memory recall failure');
  }
}

// Records the provider-visible business input handed to the execution port so a
// dispatch regression cannot pass by only surfacing the text in the UI projection.
class PayloadCapturingFakeReplayPort extends FakeReplayExecutionRuntimePort {
  readonly startPayloads: unknown[] = [];

  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.startPayloads.push(structuredClone(input.payload ?? null));
    return super.start(input);
  }
}

class FirstOperationGatedReplayPort extends FakeReplayExecutionRuntimePort {
  private observed = 0;
  readonly firstStarted: Promise<void>;
  private firstStartedResolve!: () => void;

  constructor(
    options: ConstructorParameters<typeof FakeReplayExecutionRuntimePort>[0],
    private readonly gate: Promise<void>,
  ) {
    super(options);
    this.firstStarted = new Promise<void>((resolve) => {
      this.firstStartedResolve = resolve;
    });
  }

  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.observed += 1;
    if (this.observed === 1) this.firstStartedResolve();
    return super.start(input);
  }

  override async *observe(input: Parameters<ExecutionRuntimePort['observe']>[0]): AsyncIterable<ProviderEvent> {
    if (this.observed === 1) await this.gate;
    yield* super.observe(input);
  }
}

// Holds the first execution open while recording every provider-visible input,
// so a deferred append can be proven to (a) not overwrite the running input and
// (b) be consumed as the next execution's prompt.
class GatedPayloadCapturingReplayPort extends FakeReplayExecutionRuntimePort {
  readonly startPayloads: unknown[] = [];
  private observed = 0;
  readonly firstStarted: Promise<void>;
  private firstStartedResolve!: () => void;

  constructor(
    options: ConstructorParameters<typeof FakeReplayExecutionRuntimePort>[0],
    private readonly gate: Promise<void>,
  ) {
    super(options);
    this.firstStarted = new Promise<void>((resolve) => {
      this.firstStartedResolve = resolve;
    });
  }

  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.observed += 1;
    if (this.observed === 1) this.firstStartedResolve();
    this.startPayloads.push(structuredClone(input.payload ?? null));
    return super.start(input);
  }

  override async *observe(input: Parameters<ExecutionRuntimePort['observe']>[0]): AsyncIterable<ProviderEvent> {
    if (this.observed === 1) await this.gate;
    yield* super.observe(input);
  }
}

// Models the real provider adapter's session semantics for a failed tool
// execution: an ordinary settle of a fully observed `waiting` execution returns
// `blocked` and keeps the session, so `close` is rejected with
// `close.pending.executions` until a real stop settlement releases it.
class AbandonedToolExecutionPort implements ExecutionRuntimePort {
  readonly kind = 'humanagent.execution-runtime-port' as const;
  closeCalls = 0;
  settleStates: string[] = [];
  // Forces the transport to reject a stop request so failure cleanup cannot
  // reach a final settlement.
  failStop = false;
  private readonly heldTasks = new Set<string>();
  private readonly sessions = new Map<string, { readonly scope: ScopeRef; stopRequested: boolean }>();

  // Keeps one task's observation open so another task's failure cleanup runs
  // while a shared provider execution is still active.
  hold(taskIdValue: string): void {
    this.heldTasks.add(taskIdValue);
  }

  private key(input: { readonly runtimeId: string; readonly taskId: TaskId; readonly operationId: { readonly value: string }; readonly executionEpoch: number }): string {
    return `${input.runtimeId}:${input.taskId.value}:${input.operationId.value}:${input.executionEpoch}`;
  }

  private evidence(label: string, scope: ScopeRef): EvidenceRef {
    return {
      evidenceId: id('evidence', `abandoned-${label}`),
      kind: 'execution',
      source: 'humanagent.provider-adapter',
      locator: `abandoned/${label}`,
      scope,
    };
  }

  async probe(value: ProviderBinding): Promise<ProviderReadiness> {
    return {
      bindingId: value.bindingId,
      providerId: value.providerId,
      protocol: value.protocol,
      state: 'ready',
      capabilityDigest: value.capabilityDigest,
      checkedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      evidenceRefs: [],
    };
  }

  async capabilities(value: ProviderBinding): Promise<ProviderCapabilities> {
    return {
      bindingId: value.bindingId,
      providerId: value.providerId,
      protocol: value.protocol,
      capabilities: ['start', 'submit', 'observe', 'stop', 'settle', 'close'],
      version: 'test-1',
      digest: value.capabilityDigest,
      checkedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      evidenceRefs: [],
    };
  }

  async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    const scope: ScopeRef = {
      ...(input.evidenceRefs[0]?.scope ?? { organId }),
      taskId: input.taskId,
      operationId: input.operationId,
    };
    this.sessions.set(this.key(input), { scope, stopRequested: false });
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      startedAt: '2026-01-01T00:00:00.000Z',
      evidenceRefs: [this.evidence('start', scope)],
    };
  }

  async resume(): Promise<ProviderRecoveryResult> {
    throw new Error('resume is not supported');
  }

  async submit(input: Parameters<ExecutionRuntimePort['submit']>[0]): Promise<ProviderSubmitResult> {
    const session = this.sessions.get(this.key(input));
    if (!session) throw new Error('abandoned port has no active session');
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      status: 'accepted',
      outputRefs: [],
      evidenceRefs: [this.evidence('submit', session.scope)],
    };
  }

  async *observe(input: Parameters<ExecutionRuntimePort['observe']>[0]): AsyncIterable<ProviderEvent> {
    const session = this.sessions.get(this.key(input));
    if (!session) throw new Error('abandoned port has no active session');
    if (this.heldTasks.has(input.taskId.value)) {
      await new Promise<void>(() => {});
    }
    const identity = {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
    };
    yield {
      ...identity,
      eventId: 'abandoned-tool-call',
      kind: 'tool',
      summary: 'file.read',
      evidenceRefs: [this.evidence('tool-call', session.scope)],
      toolCall: { callId: 'call-eisdir', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'response-round-1' },
    };
    // A fully observed tool-waiting terminal is consumed by the agent driver's
    // tool loop, which then runs the executor and surfaces its failure.
    yield {
      ...identity,
      eventId: 'abandoned-tool-waiting',
      kind: 'terminal',
      terminalState: 'waiting',
      evidenceRefs: [this.evidence('tool-waiting', session.scope)],
      nextAction: { kind: 'continue', ref: 'responses-tool-call' },
    };
  }

  async requestStop(input: Parameters<ExecutionRuntimePort['requestStop']>[0]): Promise<ProviderStopReceipt> {
    const session = this.sessions.get(this.key(input));
    if (!session) throw new Error('abandoned port has no active session');
    if (this.failStop) throw new Error('provider transport rejected the stop request');
    session.stopRequested = true;
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      status: 'accepted',
      receivedAt: '2026-01-01T00:00:00.000Z',
      evidenceRefs: [this.evidence('stop', session.scope)],
    };
  }

  async settle(input: Parameters<ExecutionRuntimePort['settle']>[0]): Promise<ProviderSettlement> {
    const session = this.sessions.get(this.key(input));
    if (!session) throw new Error('abandoned port has no active session');
    const scope = session.scope;
    if (session.stopRequested) {
      this.sessions.delete(this.key(input));
      this.settleStates.push('stopped');
      return {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        state: 'stopped',
        evidenceRefs: [this.evidence('settle-stopped', scope)],
        resourceRelease: { state: 'released', evidenceRefs: [this.evidence('release', scope)] },
        persistence: { state: 'committed', evidenceRefs: [this.evidence('persistence', scope)] },
      };
    }
    // Ordinary settlement of a waiting execution cannot release the session.
    this.settleStates.push('blocked');
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      state: 'blocked',
      evidenceRefs: [this.evidence('settle-blocked', scope)],
      resourceRelease: { state: 'pending', evidenceRefs: [this.evidence('release-pending', scope)] },
      persistence: { state: 'pending', evidenceRefs: [this.evidence('persistence-pending', scope)] },
      error: {
        errorId: 'provider.settle.continuation-unavailable',
        code: 'capability.continuation-unavailable',
        category: 'capability',
        phase: 'settle',
        message: 'provider cannot continue a fully observed waiting execution',
        ownerId: 'humanagent.provider-adapter',
        retryable: 'manual',
        attention: 'foreground',
        evidenceRefs: [this.evidence('settle-blocked', scope)],
        nextAction: { kind: 'recover', ref: 'humanagent.provider-adapter' },
      },
      ownerId: 'humanagent.provider-adapter',
      nextAction: { kind: 'recover', ref: 'humanagent.provider-adapter' },
    };
  }

  async close(value: ProviderBinding): Promise<ProviderCloseResult> {
    this.closeCalls += 1;
    if (this.sessions.size > 0) {
      throw new ProviderAdapterError({
        code: 'close.pending.executions',
        category: 'runtime',
        phase: 'close',
        message: 'provider close rejected while active executions require settlement or recovery',
        scope: value,
      });
    }
    return {
      bindingId: value.bindingId,
      providerId: value.providerId,
      protocol: value.protocol,
      state: 'closed',
      evidenceRefs: [],
    };
  }
}

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (last instanceof Error) throw last;
  assertion();
}

async function narrowedExecutionTemplateRoot(allowedLayers: AgentTemplateManifest['memoryContextPolicy']['allowedLayers']): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-policy-'));
  execFileSync('cp', ['-R', join(builtinTemplateRoot, 'builtin'), join(root, 'builtin')]);
  const manifestPath = join(root, 'builtin', 'execution', 'v1.1.0', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AgentTemplateManifest;
  const narrowed: AgentTemplateManifest = {
    ...manifest,
    memoryContextPolicy: { ...manifest.memoryContextPolicy, allowedLayers },
  };
  await writeFile(manifestPath, JSON.stringify({ ...narrowed, digest: digestAgentTemplate(narrowed) }, null, 2) + '\n', 'utf8');
  return root;
}

function serviceFor(
  root: string,
  port: ExecutionRuntimePort,
  mode: 'fake' | 'rcc' = 'fake',
  providerState = 'ready',
  journal?: UiRuntimeJournal,
  now?: () => Date,
  hookRegistry?: AgentHookRegistry,
  closurePort?: CheckpointClosurePort,
  explicitBrainInterpreter?: ExplicitBrainInputInterpreter,
): UiRuntimeService {
  const runtimeJournal = journal ?? new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  return new UiRuntimeService({
    mode,
    organId,
    binding,
    port,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState,
    journal: runtimeJournal,
    closurePort: closurePort ?? runtimeJournal,
    memory: testMemory('project-ui-test'),
    ...(now ? { now } : {}),
    ...(hookRegistry ? { hookRegistry } : {}),
    explicitBrainInterpreter: explicitBrainInterpreter ?? unusedExplicitBrainInterpreter,
  });
}

class FailingInteractionClosurePort implements CheckpointClosurePort {
  async commit(_input: ClosureRecord): Promise<{ readonly closureId: string; readonly committed: true }> {
    throw new Error('closure store unavailable');
  }

  async read(): Promise<ClosureRecord | null> {
    return null;
  }
}

class FailOnceProjectionJournal extends UiRuntimeJournal {
  failNextExplicitState = false;
  failNextTaskCreated = false;
  failNextOperationStarted = false;
  failNextExecutionStarted = false;
  explicitStatesBeforeFailure = 0;

  override append(record: Parameters<UiRuntimeJournal['append']>[0]): void {
    if (this.failNextTaskCreated && record.kind === 'task.created') {
      this.failNextTaskCreated = false;
      throw new Error('task journal unavailable');
    }
    if (this.failNextOperationStarted && record.kind === 'operation.started') {
      this.failNextOperationStarted = false;
      throw new Error('operation journal unavailable');
    }
    if (
      this.failNextExecutionStarted
      && record.kind === 'operation.event'
      && record.event.kind === 'execution.started'
    ) {
      this.failNextExecutionStarted = false;
      throw new Error('execution event journal unavailable');
    }
    if (this.failNextExplicitState && record.kind === 'explicit-brain.state') {
      if (this.explicitStatesBeforeFailure > 0) {
        this.explicitStatesBeforeFailure -= 1;
        super.append(record);
        return;
      }
      this.failNextExplicitState = false;
      throw new Error('projection journal unavailable');
    }
    super.append(record);
  }
}

// Fails every task-creation journal write while the flag is set, so a persistent
// non-admission dispatch failure keeps a failed FIFO head while later confirmed
// requirements remain queued behind it.
class PersistentTaskCreateFailureJournal extends UiRuntimeJournal {
  failTaskCreated = false;

  override append(record: Parameters<UiRuntimeJournal['append']>[0]): void {
    if (this.failTaskCreated && record.kind === 'task.created') {
      throw new Error('task journal unavailable');
    }
    super.append(record);
  }
}

test('ui runtime binds memory to the real operation identity and exposes deterministic recall evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-binding-'));
  const memory = new DeterministicMemoryBackend();
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: memory,
      projectKey: 'project-ui-memory',
      roleId: 'execution',
    },
  });
  try {
    const task = runtime.service.createTask({ title: 'memory binding' });
    memory.addContextEntry({
      scope: { kind: 'task', organId, taskId: task.taskId },
      sourceRef: 'journal://ui-memory/current',
      sourceDigest: 'sha256:ui-memory-current',
      text: 'deterministic memory binding evidence',
      layer: 'current',
      summary: 'deterministic memory binding evidence',
    });

    const started = runtime.service.startExecution(task.taskId, { prompt: 'recall memory' });
    await waitFor(() => assert.equal(runtime.service.taskDashboard(task.taskId).state, 'succeeded'));

    const receipt = runtime.service.memoryContextReceipt(started.operationId);
    assert.equal(receipt.executionEpoch, started.executionEpoch);
    assert.equal(receipt.taskId.value, task.taskId.value);
    assert.equal(receipt.entries[0]?.sourceRef, 'journal://ui-memory/current');
    assert.equal(receipt.entries[0]?.sourceDigest, 'sha256:ui-memory-current');
  } finally {
    await runtime.server.close();
  }
});

test('ui runtime recalls approved long-term memory approved by an earlier task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-long-term-'));
  const memory = new DeterministicMemoryBackend();
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: memory,
      projectKey: 'project-ui-long-term',
      roleId: 'execution',
    },
  });
  try {
    await memory.ingest({
      scope: { kind: 'task', organId, taskId: id('task', 'earlier-task') },
      sourceRef: 'journal://ui-memory/approved-long-term',
      sourceDigest: 'sha256:ui-memory-approved-long-term',
      text: 'approved long-term project fact',
    });
    await memory.addCanonicalRecord({
      memoryId: 'memory-ui-approved-long-term',
      namespace: 'project',
      projectKey: 'project-ui-long-term',
      kind: 'semantic',
      state: 'approved',
      summary: 'approved long-term project fact',
      sourceRefs: ['journal://ui-memory/approved-long-term'],
      sourceDigests: ['sha256:ui-memory-approved-long-term'],
      taskId: id('task', 'earlier-task'),
      sourceScopeRef: 'project-ui-long-term:earlier-task',
      relevanceReason: 'approved by an earlier task in the same project',
    });

    const task = runtime.service.createTask({ title: 'later task recalls approved memory' });
    const started = runtime.service.startExecution(task.taskId, { prompt: 'recall approved long-term memory' });
    await waitFor(() => assert.equal(runtime.service.taskDashboard(task.taskId).state, 'succeeded'));

    const receipt = runtime.service.memoryContextReceipt(started.operationId);
    assert.deepEqual(receipt.layers, ['current', 'task-recent', 'related', 'approved-long-term']);
    assert.deepEqual(receipt.entries, [{
      layer: 'approved-long-term',
      sourceRef: 'memory-ui-approved-long-term',
      sourceDigest: `sha256:${createHash('sha256').update('approved long-term project fact').digest('hex')}`,
      scope: `project:project-ui-long-term:${organId.value}:${task.taskId.value}`,
      tokenCost: 4,
    }]);
    assert.equal(runtime.service.memoryContextStatus(started.operationId).httpStatus, 200);
  } finally {
    await runtime.server.close();
  }
});

test('ui runtime never requests a recall layer the loaded execution template does not grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-policy-narrow-'));
  const narrowedRoot = await narrowedExecutionTemplateRoot(['current']);
  const previousTemplateRoot = process.env.HUMANAGENT_TEMPLATE_ROOT;
  process.env.HUMANAGENT_TEMPLATE_ROOT = narrowedRoot;
  const memory = new DeterministicMemoryBackend();
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: memory,
      projectKey: 'project-ui-memory-policy-narrow',
      roleId: 'execution',
    },
  });
  try {
    await memory.ingest({
      scope: { kind: 'task', organId, taskId: id('task', 'earlier-task') },
      sourceRef: 'journal://ui-memory-policy-narrow/approved-long-term',
      sourceDigest: 'sha256:ui-memory-policy-narrow-approved-long-term',
      text: 'ungranted long-term project fact',
    });
    await memory.addCanonicalRecord({
      memoryId: 'memory-ui-policy-narrow-approved-long-term',
      namespace: 'project',
      projectKey: 'project-ui-memory-policy-narrow',
      kind: 'semantic',
      state: 'approved',
      summary: 'ungranted long-term project fact',
      sourceRefs: ['journal://ui-memory-policy-narrow/approved-long-term'],
      sourceDigests: ['sha256:ui-memory-policy-narrow-approved-long-term'],
      taskId: id('task', 'earlier-task'),
      sourceScopeRef: 'project-ui-memory-policy-narrow:earlier-task',
      relevanceReason: 'approved by an earlier task in the same project',
    });

    const task = runtime.service.createTask({ title: 'narrow template grant' });
    const started = runtime.service.startExecution(task.taskId, { prompt: 'recall with a narrowed grant' });
    await waitFor(() => assert.equal(runtime.service.taskDashboard(task.taskId).state, 'succeeded'));

    const receipt = runtime.service.memoryContextReceipt(started.operationId);
    assert.deepEqual(receipt.layers, ['current']);
    assert.equal(receipt.entries.some((entry) => entry.layer === 'approved-long-term'), false);
  } finally {
    await runtime.server.close();
    if (previousTemplateRoot === undefined) delete process.env.HUMANAGENT_TEMPLATE_ROOT;
    else process.env.HUMANAGENT_TEMPLATE_ROOT = previousTemplateRoot;
  }
});

test('ui runtime rejects stale memory epoch recall after the task advances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-stale-'));
  const runtimeJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal: runtimeJournal,
    closurePort: runtimeJournal,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'project-ui-memory-stale',
      roleId: 'execution',
    },
  });
  const task = service.createTask({ title: 'stale memory epoch' });
  const first = service.startExecution(task.taskId, { prompt: 'first epoch' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  const second = service.startExecution(task.taskId, { prompt: 'second epoch' });
  assert.equal(second.executionEpoch, first.executionEpoch + 1);
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(task.taskId).error, undefined);

  assert.throws(
    () => service.memoryContextReceipt(first.operationId),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'memory-binding-mismatch'
      && error.httpStatus === 409,
  );
  assert.throws(
    () => service.memoryContextStatus(first.operationId),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'memory-binding-mismatch'
      && error.httpStatus === 409,
  );
  assert.equal(service.memoryContextReceipt(second.operationId).executionEpoch, second.executionEpoch);
});

test('memory context HTTP route reports pending while the accepted execution is binding memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-pending-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DelayedMemoryBackend(gate),
      projectKey: 'project-ui-memory-pending',
      roleId: 'execution',
    },
  });
  try {
    const created = await fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'pending memory binding' }),
    });
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    const startedResponse = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'wait for memory binding' }),
    });
    const started = await startedResponse.json() as { readonly operationId: string };

    const pendingResponse = await fetch(`${runtime.server.url}/api/executions/${encodeURIComponent(started.operationId)}/memory-context`);
    assert.equal(pendingResponse.status, 202);
    const pending = await pendingResponse.json() as { readonly state: string; readonly operationId: string };
    assert.equal(pending.state, 'pending');
    assert.equal(pending.operationId, started.operationId);

    const unknownResponse = await fetch(`${runtime.server.url}/api/executions/unknown-operation/memory-context`);
    assert.equal(unknownResponse.status, 404);

    release();
    await waitFor(() => assert.equal(runtime.service.taskDashboard(id('task', task.taskId.value)).state, 'succeeded'));
    const receiptResponse = await fetch(`${runtime.server.url}/api/executions/${encodeURIComponent(started.operationId)}/memory-context`);
    assert.equal(receiptResponse.status, 200);
    const receipt = await receiptResponse.json() as { readonly executionEpoch: number };
    assert.equal(receipt.executionEpoch, 1);
  } finally {
    release();
    await runtime.server.close();
  }
});

test('memory context HTTP route exposes terminal memory binding failure instead of pending forever', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-failure-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new FailingMemoryBackend(),
      projectKey: 'project-ui-memory-failure',
      roleId: 'execution',
    },
  });
  try {
    const created = await fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'failed memory binding' }),
    });
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    const startedResponse = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'fail memory binding' }),
    });
    const started = await startedResponse.json() as { readonly operationId: string };
    await waitFor(() => assert.equal(runtime.service.taskDashboard(id('task', task.taskId.value)).state, 'failed'));

    const response = await fetch(`${runtime.server.url}/api/executions/${encodeURIComponent(started.operationId)}/memory-context`);
    assert.equal(response.status, 500);
    const body = await response.json() as { readonly error: { readonly code: string; readonly ownerId: string; readonly message: string } };
    assert.equal(body.error.code, 'memory-context-failed');
    assert.equal(body.error.ownerId, 'humanagent.runtime');
    assert.match(body.error.message, /memory context injection is unavailable/);
  } finally {
    await runtime.server.close();
  }
});

test('memory interaction HTTP routes expose typed summary, query, inspect, compare, and explicit review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-interaction-'));
  const projectKey = 'project-ui-memory-interaction';
  const scope: MemoryScope = { kind: 'organ', organId };
  const actor: MemoryActorContext = {
    actorId: 'memory-test-agent',
    roleId: 'memory',
    permissions: ['memory.read', 'memory.propose'],
    projectKey,
  };
  const memory = new DeterministicMemoryBackend();
  const coordinator = new MemoryCoordinator();
  let reviewCandidateId: string | undefined;
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: {
      coordinator,
      backend: memory,
      projectKey,
      roleId: 'review',
      reviewState: async () => ({
        analysis: {
          mode: 'model',
          state: 'failed',
          operationRef: 'memory-analysis:test',
          failureRef: 'memory-agent-analysis-unavailable',
        },
        autoUpdate: false,
        candidates: reviewCandidateId === undefined ? [] : [{
          candidateId: reviewCandidateId,
          state: 'candidate',
          namespace: 'project',
          projectKey,
          taskId: 'task-memory-review',
          category: 'project-fact',
          kind: 'semantic',
          summary: 'memory interaction review candidate',
          sourceRefs: ['journal://ui-memory-interaction/one'],
          sourceDigests: ['sha256:ui-memory-interaction-one'],
          evidenceRefs: ['journal://ui-memory-interaction/two'],
        }],
      }),
    },
  });
  try {
    await memory.ingest({
      scope,
      sourceRef: 'journal://ui-memory-interaction/one',
      sourceDigest: 'sha256:ui-memory-interaction-one',
      text: 'memory interaction source one',
    });
    await memory.ingest({
      scope,
      sourceRef: 'journal://ui-memory-interaction/two',
      sourceDigest: 'sha256:ui-memory-interaction-two',
      text: 'memory interaction source two',
    });
    await memory.addCanonicalRecord({
      memoryId: 'memory-ui-interaction-one',
      namespace: 'project',
      projectKey,
      kind: 'semantic',
      state: 'approved',
      summary: 'memory interaction approved record',
      sourceRefs: ['journal://ui-memory-interaction/one', 'journal://ui-memory-interaction/two'],
      sourceDigests: ['sha256:ui-memory-interaction-one', 'sha256:ui-memory-interaction-two'],
      sourceScopeRef: projectKey,
      relevanceReason: 'HTTP memory interaction test',
    });

    const summary = await fetch(`${runtime.server.url}/api/memory/summary`);
    assert.equal(summary.status, 200);
    const summaryBody = await summary.json() as {
      readonly surface: string;
      readonly summary: string;
      readonly entries: readonly unknown[];
    };
    assert.equal(summaryBody.surface, 'memory-interaction');
    assert.equal(summaryBody.summary, '未指定过滤条件');
    assert.deepEqual(summaryBody.entries, []);
    assert.deepEqual((summaryBody as unknown as { readonly analysis: unknown }).analysis, {
      mode: 'model',
      state: 'failed',
      operationRef: 'memory-analysis:test',
      failureRef: 'memory-agent-analysis-unavailable',
    });

    const query = await fetch(`${runtime.server.url}/api/memory/query?query=approved&limit=5`);
    assert.equal(query.status, 200);
    const queryBody = await query.json() as {
      readonly entries: readonly { readonly memoryId: string; readonly sourceRefs: readonly string[] }[];
      readonly indexVersion?: string;
    };
    assert.equal(queryBody.entries[0]?.memoryId, 'memory-ui-interaction-one');
    assert.deepEqual(queryBody.entries[0]?.sourceRefs, [
      'journal://ui-memory-interaction/one',
      'journal://ui-memory-interaction/two',
    ]);
    assert.equal(queryBody.indexVersion, memory.indexVersion);

    const inspect = await fetch(`${runtime.server.url}/api/memory/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'journal://ui-memory-interaction/one',
        sourceDigest: 'sha256:ui-memory-interaction-one',
      }),
    });
    assert.equal(inspect.status, 200);
    const inspectBody = await inspect.json() as { readonly content: string };
    assert.equal(inspectBody.content, 'memory interaction source one');

    const compare = await fetch(`${runtime.server.url}/api/memory/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        leftRef: 'journal://ui-memory-interaction/one',
        rightRef: 'journal://ui-memory-interaction/two',
      }),
    });
    assert.equal(compare.status, 200);
    const compareBody = await compare.json() as { readonly relation: string };
    assert.equal(compareBody.relation, 'different');

    const submission: MemorySubmission = {
      submissionId: 'submission-ui-memory-interaction',
      requestId: 'request-ui-memory-interaction',
      operationId: id('operation', 'memory-interaction-submission'),
      bindingRef: 'memory-binding:unused',
      actor: {
        ...actor,
        permissions: ['memory.read', 'memory.propose'],
      },
      projectKey,
      requestedKind: 'semantic',
      candidateCategory: 'project-fact',
      contentRef: 'journal://ui-memory-interaction/one',
      contentDigest: 'sha256:ui-memory-interaction-one',
      evidenceRefs: ['journal://ui-memory-interaction/two'],
      observation: 'memory interaction review candidate',
      desiredScope: 'project',
      reason: 'HTTP review test',
      inputDigest: 'sha256:ui-memory-interaction-submission',
    };
    const submitted = await coordinator.submitCandidate({
      ...submission,
      bindingRef: `memory-binding:interaction:runtime:${projectKey}`,
    });
    assert.equal(submitted.status, 'ready');
    const candidateId = submitted.status === 'ready' ? submitted.value.candidateId : undefined;
    if (!candidateId) throw new Error('expected memory interaction candidate');
    reviewCandidateId = candidateId;

    const reviewSummary = await fetch(`${runtime.server.url}/api/memory/summary`);
    const reviewSummaryBody = await reviewSummary.json() as {
      readonly autoUpdate: boolean;
      readonly skillCandidates: readonly {
        readonly candidateId: string;
        readonly pattern: string;
        readonly proposedRule: string;
        readonly uniqueness: string;
        readonly repeatability: string;
        readonly value: string;
        readonly state: string;
        readonly evidenceRefs: readonly unknown[];
        readonly namespace: string;
        readonly projectKey: string;
        readonly taskId?: string;
        readonly sourceRefs: readonly string[];
        readonly sourceDigests: readonly string[];
      }[];
    };
    assert.equal(reviewSummary.status, 200);
    assert.equal(reviewSummaryBody.autoUpdate, false);
    assert.deepEqual(reviewSummaryBody.skillCandidates[0], {
      candidateId,
      pattern: 'project-fact · semantic',
      proposedRule: 'memory interaction review candidate',
      uniqueness: 'pending-review',
      repeatability: 'observed',
      value: 'project',
      state: 'candidate',
      evidenceRefs: [],
      namespace: 'project',
      projectKey,
      taskId: 'task-memory-review',
      sourceRefs: ['journal://ui-memory-interaction/one'],
      sourceDigests: ['sha256:ui-memory-interaction-one'],
    });

    await assert.rejects(
      () => memory.promoteCandidate({
        candidateId,
        from: 'project',
        to: 'global',
        actor: {
          actorId: 'memory-promotion-test',
          roleId: 'review',
          permissions: ['memory.promote'],
          projectKey,
        },
        reason: 'must wait for explicit review',
        impactScope: 'all projects',
        approvalRef: 'approval://ui-memory-interaction',
        approvalDigest: 'sha256:ui-memory-interaction-approval',
        sourceRefs: [],
        sourceDigests: [],
        promotedAt: '2026-09-18T00:00:00.000Z',
      }),
      /memory promotion requires an approved candidate/,
    );

    const review = await fetch(`${runtime.server.url}/api/memory/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        candidateId,
        decision: 'approve',
        decisionReason: 'HTTP review evidence is complete',
      }),
    });
    assert.equal(review.status, 200);
    const reviewBody = await review.json() as {
      readonly candidateId: string;
      readonly decision: string;
      readonly decisionReason: string;
    };
    assert.equal(reviewBody.candidateId, candidateId);
    assert.equal(reviewBody.decision, 'approve');
    assert.equal(reviewBody.decisionReason, 'HTTP review evidence is complete');

    const promoted = await memory.query({
      requestId: 'request-ui-memory-promotion-check',
      operationId: id('operation', 'memory-interaction-promotion-check'),
      bindingRef: 'memory-binding:unused',
      actor: {
        actorId: 'memory-promotion-check',
        roleId: 'review',
        permissions: ['memory.read'],
        projectKey,
        crossProjectGrantRef: 'grant://ui-memory-interaction-global',
      },
      projectKey,
      namespace: 'global',
      query: 'memory interaction review candidate',
      kinds: ['episodic', 'semantic', 'procedural'],
      states: ['approved', 'active'],
      limit: 5,
      tokenBudget: 1000,
      inputDigest: 'sha256:ui-memory-promotion-check',
    });
    assert.deepEqual(promoted.entries, []);
  } finally {
    await runtime.server.close();
  }
});

test('memory interaction HTTP review preserves configured non-review actor permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-review-denied-'));
  const projectKey = 'project-ui-memory-review-denied';
  const scope: MemoryScope = { kind: 'organ', organId };
  const memory = new DeterministicMemoryBackend();
  const coordinator = new MemoryCoordinator();
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: {
      coordinator,
      backend: memory,
      projectKey,
      roleId: 'execution',
    },
  });
  try {
    await memory.ingest({
      scope,
      sourceRef: 'journal://ui-memory-review-denied/one',
      sourceDigest: 'sha256:ui-memory-review-denied-one',
      text: 'memory review denied source',
    });
    const submitted = await coordinator.submitCandidate({
      submissionId: 'submission-ui-memory-review-denied',
      requestId: 'request-ui-memory-review-denied',
      operationId: id('operation', 'memory-review-denied-submission'),
      bindingRef: `memory-binding:interaction:runtime:${projectKey}`,
      actor: {
        actorId: 'memory-review-denied-submitter',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey,
      },
      projectKey,
      requestedKind: 'semantic',
      candidateCategory: 'project-fact',
      contentRef: 'journal://ui-memory-review-denied/one',
      contentDigest: 'sha256:ui-memory-review-denied-one',
      evidenceRefs: ['journal://ui-memory-review-denied/one'],
      observation: 'memory review denied candidate',
      desiredScope: 'project',
      reason: 'HTTP review authorization test',
      inputDigest: 'sha256:ui-memory-review-denied-submission',
    });
    assert.equal(submitted.status, 'ready');
    const candidateId = submitted.status === 'ready' ? submitted.value.candidateId : undefined;
    if (!candidateId) throw new Error('expected memory review denied candidate');

    const review = await fetch(`${runtime.server.url}/api/memory/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        candidateId,
        decision: 'approve',
        decisionReason: 'must not bypass configured permissions',
      }),
    });
    assert.equal(review.status, 409);
    const reviewBody = await review.json() as { readonly error: { readonly code: string } };
    assert.equal(reviewBody.error.code, 'memory-capability-denied');

    const query = await fetch(`${runtime.server.url}/api/memory/query?query=${encodeURIComponent('memory review denied candidate')}`);
    assert.equal(query.status, 200);
    const queryBody = await query.json() as { readonly entries: readonly unknown[] };
    assert.deepEqual(queryBody.entries, []);
  } finally {
    await runtime.server.close();
  }
});

test('memory interaction HTTP routes reject unknown detail and an invalid memory binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-errors-'));
  const validRuntime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-memory-errors'),
  });
  try {
    const unknownDetail = await fetch(`${validRuntime.server.url}/api/memory/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'journal://ui-memory-errors/missing',
        sourceDigest: 'sha256:ui-memory-errors-missing',
      }),
    });
    assert.equal(unknownDetail.status, 404);
    const unknownDetailBody = await unknownDetail.json() as { readonly error: { readonly code: string; readonly ownerId: string } };
    assert.equal(unknownDetailBody.error.code, 'memory-source-not-found');
    assert.equal(unknownDetailBody.error.ownerId, 'memory-coordinator');
  } finally {
    await validRuntime.server.close();
  }

  const invalidRuntime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'invalid-checkpoints'),
    evidenceRoot: join(root, 'invalid-evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: {
      ...testMemory('project-ui-memory-errors'),
      bindingRef: 'memory-binding:missing-ui-memory-errors',
    },
  });
  try {
    const invalidBinding = await fetch(`${invalidRuntime.server.url}/api/memory/query?query=memory`);
    assert.equal(invalidBinding.status, 404);
    const invalidBindingBody = await invalidBinding.json() as { readonly error: { readonly code: string } };
    assert.equal(invalidBindingBody.error.code, 'memory-binding-missing');
  } finally {
    await invalidRuntime.server.close();
  }
});

test('memory interaction HTTP routes reject unconfigured global access without hiding project access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-global-denied-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-memory-global-denied'),
  });
  try {
    for (const path of [
      '/api/memory/summary?namespace=global',
      '/api/memory/query?namespace=global&query=memory',
    ]) {
      const response = await fetch(`${runtime.server.url}${path}`);
      assert.equal(response.status, 409);
      const body = await response.json() as {
        readonly error: {
          readonly code: string;
          readonly ownerId: string;
          readonly nextAction: string;
        };
      };
      assert.equal(body.error.code, 'memory-capability-denied');
      assert.equal(body.error.ownerId, 'memory-coordinator');
      assert.match(body.error.nextAction, /cross-project grant|project namespace/u);
    }

    const projectSummary = await fetch(`${runtime.server.url}/api/memory/summary`);
    assert.equal(projectSummary.status, 200);
    const projectQuery = await fetch(`${runtime.server.url}/api/memory/query?query=memory`);
    assert.equal(projectQuery.status, 200);
  } finally {
    await runtime.server.close();
  }
});

test('organ health probe and snapshot expose bounded dimensions, evidence, and independent lifecycle state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-organ-health-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  let probeCount = 0;
  const port: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async (value) => {
      probeCount += 1;
      return base.probe(value);
    },
    capabilities: (value) => base.capabilities(value),
    start: (input) => base.start(input),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port,
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-organ-health'),
  });
  try {
    const snapshotBeforeProbe = await fetch(`${runtime.server.url}/api/health/snapshot`);
    assert.equal(snapshotBeforeProbe.status, 409);
    const snapshotError = await snapshotBeforeProbe.json() as {
      readonly error: {
        readonly code: string;
        readonly ownerId: string;
        readonly nextAction: string;
      };
    };
    assert.equal(snapshotError.error.code, 'health-snapshot-missing');
    assert.equal(snapshotError.error.ownerId, 'humanagent.runtime.health');
    assert.match(snapshotError.error.nextAction, /health probe/u);
    assert.equal(probeCount, 0);

    const probeResponse = await fetch(`${runtime.server.url}/api/health/probe`);
    assert.equal(probeResponse.status, 200);
    assert.equal(probeCount, 1);

    for (const path of ['/api/health/probe', '/api/health/snapshot']) {
      const response = await fetch(`${runtime.server.url}${path}`);
      assert.equal(response.status, 200);
      const body = await response.json() as {
        readonly surface: string;
        readonly organId: { readonly value: string };
        readonly lifecycleState: string;
        readonly healthState: string;
        readonly checkedAt: string;
        readonly expiresAt: string;
        readonly stale: boolean;
        readonly dimensions: readonly {
          readonly dimension: string;
          readonly status: string;
          readonly evidenceRefs: readonly { readonly evidenceId: { readonly value: string } }[];
          readonly measurements: readonly { readonly name: string; readonly value: string | number }[];
        }[];
        readonly evidenceRefs: readonly { readonly evidenceId: { readonly value: string } }[];
      };
      assert.equal(body.surface, 'organ-health');
      assert.equal(body.organId.value, organId.value);
      assert.equal(body.lifecycleState, 'ready');
      assert.equal(body.healthState, 'healthy');
      assert.equal(body.stale, false);
      assert.match(body.checkedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.equal(body.dimensions[0]?.dimension, 'readiness');
      assert.equal(body.dimensions[0]?.status, 'healthy');
      assert.equal(body.dimensions[0]?.measurements.find((measurement) => measurement.name === 'providerState')?.value, 'ready');
      assert.ok((body.dimensions[0]?.evidenceRefs.length ?? 0) > 0);
      assert.ok(body.evidenceRefs.length > 0);
    }
    assert.equal(probeCount, 2);

    const snapshotOnly = await fetch(`${runtime.server.url}/api/health/snapshot`);
    assert.equal(snapshotOnly.status, 200);
    assert.equal(probeCount, 2);
  } finally {
    await runtime.server.close();
  }
});

test('expired organ health evidence is reported as stale unknown without changing lifecycle state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-organ-health-stale-'));
  const base = new FakeReplayExecutionRuntimePort({ binding });
  const expired: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'ready',
      capabilityDigest: binding.capabilityDigest,
      version: 'stale-health-probe',
      checkedAt: '2026-09-17T00:00:00.000Z',
      expiresAt: '2026-09-17T00:01:00.000Z',
      evidenceRefs: [evidence('expired-readiness', { organId })],
    }),
    capabilities: (value) => base.capabilities(value),
    start: (input) => base.start(input),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: expired,
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-organ-health-stale'),
  });
  try {
    const response = await fetch(`${runtime.server.url}/api/health/probe`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      readonly lifecycleState: string;
      readonly healthState: string;
      readonly stale: boolean;
      readonly dimensions: readonly { readonly status: string }[];
    };
    assert.equal(body.lifecycleState, 'ready');
    assert.equal(body.healthState, 'unknown');
    assert.equal(body.stale, true);
    assert.equal(body.dimensions[0]?.status, 'unknown');
  } finally {
    await runtime.server.close();
  }
});

test('organ health projection uses instant semantics for offset timestamps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-organ-health-offset-'));
  const base = new FakeReplayExecutionRuntimePort({ binding });
  const offsetExpiry: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'ready',
      capabilityDigest: binding.capabilityDigest,
      version: 'offset-health-probe',
      checkedAt: '2026-09-18T08:59:00.000Z',
      expiresAt: '2026-09-18T10:00:40.000+01:00',
      evidenceRefs: [evidence('offset-readiness', { organId })],
    }),
    capabilities: (value) => base.capabilities(value),
    start: (input) => base.start(input),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const service = serviceFor(
    root,
    offsetExpiry,
    'fake',
    'ready',
    undefined,
    () => new Date('2026-09-18T10:00:30.000Z'),
  );

  const health = await service.healthProbe();
  assert.equal(health.healthState, 'unknown');
  assert.equal(health.stale, true);
  assert.equal(health.dimensions[0]?.status, 'unknown');
});

test('organ health HTTP preserves provider failure ownership and recovery evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-organ-health-error-'));
  const readinessEvidence = evidence('provider-readiness-failure', { organId });
  const failing: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => {
      throw new ProviderAdapterError({
        code: 'provider.readiness.unavailable',
        category: 'provider',
        phase: 'probe',
        message: 'provider readiness probe failed',
        retryable: 'retryable',
        nextAction: { kind: 'recover', ref: 'rcc-v3.health' },
        evidenceRefs: [readinessEvidence],
      });
    },
    capabilities: async () => {
      throw new Error('capabilities must not be called by health probe');
    },
    start: async () => {
      throw new Error('start must not be called by health probe');
    },
    resume: async () => {
      throw new Error('resume must not be called by health probe');
    },
    submit: async () => {
      throw new Error('submit must not be called by health probe');
    },
    observe: () => {
      throw new Error('observe must not be called by health probe');
    },
    requestStop: async () => {
      throw new Error('requestStop must not be called by health probe');
    },
    settle: async () => {
      throw new Error('settle must not be called by health probe');
    },
    close: async () => {
      throw new Error('close must not be called by health probe');
    },
  };
  const runtimeJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'rcc',
    organId,
    binding,
    port: failing,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal: runtimeJournal,
    closurePort: runtimeJournal,
    memory: testMemory('project-ui-organ-health-error'),
  });
  const server = await startUiRuntimeServer({
    service,
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    port: 0,
  });
  try {
    const response = await fetch(`${server.url}/api/health/probe`);
    assert.equal(response.status, 409);
    const body = await response.json() as {
      readonly error: {
        readonly code: string;
        readonly ownerId: string;
        readonly nextAction: string;
        readonly evidenceRefs: readonly { readonly evidenceId: { readonly value: string } }[];
      };
    };
    assert.equal(body.error.code, 'provider.readiness.unavailable');
    assert.equal(body.error.ownerId, 'humanagent.provider-adapter');
    assert.match(body.error.nextAction, /rcc-v3\.health/);
    assert.equal(body.error.evidenceRefs[0]?.evidenceId.value, readinessEvidence.evidenceId.value);
  } finally {
    await server.close();
  }
});

test('memory-bound execution driver binds and attaches context before provider resume', async () => {
  const taskId = id('task', 'resume-memory-task');
  const operationId = id('operation', 'resume-memory-operation');
  const scope: ScopeRef = { organId, taskId, operationId };
  const coordinator = new MemoryCoordinator();
  const backend = new DeterministicMemoryBackend();
  backend.addContextEntry({
    scope: { kind: 'task', organId, taskId },
    sourceRef: 'journal://resume-memory/current',
    sourceDigest: 'sha256:resume-memory-current',
    text: 'resume must attach the current memory context',
    layer: 'current',
    summary: 'resume memory context',
  });
  let providerResumed = false;
  const providerDriver = {
    kind: 'test-provider-driver',
    async capabilities() { return { driverKind: 'test-provider-driver', capabilities: [], version: '1' }; },
    async start() { throw new Error('start must not run'); },
    async resume(input: Parameters<typeof MemoryBoundExecutionDriver.prototype.resume>[0]) {
      providerResumed = true;
      return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
    },
    async submit() { throw new Error('submit must not run'); },
    async *observe() {},
    async requestStop() { throw new Error('requestStop must not run'); },
    async settle() { throw new Error('settle must not run'); },
    async close() {
      return {
        bindingId: binding.bindingId,
        providerId: binding.providerId,
        protocol: binding.protocol,
        state: 'closed' as const,
        evidenceRefs: [],
      };
    },
  };
  const driver = new MemoryBoundExecutionDriver(
    providerDriver,
    {
      runtimeId: 'resume-memory-runtime',
      taskId,
      operationId,
      executionEpoch: 2,
      assignmentId: 'assignment-resume-memory',
      scope,
      inputRefs: ['task://resume-memory/input/1'],
      ownerId: 'humanagent.runtime',
    },
    {
      coordinator,
      backend,
      projectKey: 'project-resume-memory',
      roleId: 'execution',
    },
    new MemoryContextCapture(backend),
    () => undefined,
  );

  const handle = await driver.resume({
    runtimeId: 'resume-memory-runtime',
    taskId,
    operationId,
    executionEpoch: 2,
    assignmentId: 'assignment-resume-memory',
    checkpointId: id('checkpoint', 'resume-memory-checkpoint'),
  });

  assert.equal(providerResumed, true);
  assert.equal(handle.runtimeId, 'resume-memory-runtime');
  assert.equal(handle.executionEpoch, 2);
  const recalled = await coordinator.recall({
    agentRuntimeId: 'resume-memory-runtime',
    roleId: 'execution',
    taskId,
    scope: { namespace: 'project', projectKey: 'project-resume-memory', organId, taskId },
    layers: ['current'],
    tokenBudget: 4096,
    executionEpoch: 2,
    evidenceRequired: true,
  });
  assert.equal(recalled.status, 'ready');
  if (recalled.status === 'ready') {
    assert.equal(recalled.value.entries[0]?.sourceRef, 'journal://resume-memory/current');
  }
});

test('memory-bound execution driver rejects conflicting bindings before provider resume', async () => {
  const taskId = id('task', 'resume-memory-conflict-task');
  const operationId = id('operation', 'resume-memory-conflict-operation');
  const coordinator = new MemoryCoordinator();
  const backend = new DeterministicMemoryBackend();
  coordinator.bindTask({
    taskId,
    assignmentId: 'assignment-existing',
    executionEpoch: 1,
    projectKey: 'project-resume-memory-conflict',
    scope: { namespace: 'project', projectKey: 'project-resume-memory-conflict', organId, taskId },
    backendRef: 'memory://project-resume-memory-conflict',
    indexVersion: backend.indexVersion,
    operations: backend,
    injection: new MemoryContextCapture(backend),
    ownerId: 'humanagent.app',
  });
  let providerResumed = false;
  const providerDriver = {
    kind: 'test-provider-driver',
    async capabilities() { return { driverKind: 'test-provider-driver', capabilities: [], version: '1' }; },
    async start() { throw new Error('start must not run'); },
    async resume() {
      providerResumed = true;
      throw new Error('resume must not run');
    },
    async submit() { throw new Error('submit must not run'); },
    async *observe() {},
    async requestStop() { throw new Error('requestStop must not run'); },
    async settle() { throw new Error('settle must not run'); },
    async close() {
      return {
        bindingId: binding.bindingId,
        providerId: binding.providerId,
        protocol: binding.protocol,
        state: 'closed' as const,
        evidenceRefs: [],
      };
    },
  };
  const driver = new MemoryBoundExecutionDriver(
    providerDriver,
    {
      runtimeId: 'resume-memory-conflict-runtime',
      taskId,
      operationId,
      executionEpoch: 1,
      assignmentId: 'assignment-conflict',
      scope: { organId, taskId, operationId },
      inputRefs: ['task://resume-memory-conflict/input/1'],
      ownerId: 'humanagent.runtime',
    },
    {
      coordinator,
      backend,
      projectKey: 'project-resume-memory-conflict',
      roleId: 'execution',
    },
    new MemoryContextCapture(backend),
    () => undefined,
  );

  await assert.rejects(
    () => driver.resume({
      runtimeId: 'resume-memory-conflict-runtime',
      taskId,
      operationId,
      executionEpoch: 1,
      assignmentId: 'assignment-conflict',
      checkpointId: id('checkpoint', 'resume-memory-conflict-checkpoint'),
    }),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'memory-binding-mismatch'
      && error.httpStatus === 409,
  );
  assert.equal(providerResumed, false);
});

test('fake execution completes through Runtime projection with SSE, output, checkpoint, and read-only observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-fake-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const task = service.createTask({ title: 'fake lifecycle', directive: 'verify fake replay' });
  const started = service.startExecution(task.taskId, { prompt: 'run fake replay' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.mode, 'fake');
  assert.equal(dashboard.taskTitle, 'fake lifecycle');
  assert.match(dashboard.output, /fake replay: draft output chunk 1/);
  assert.match(dashboard.output, /fake replay: final output chunk 2/);
  assert.equal(dashboard.output.includes('fake://output/1'), false);
  assert.equal(dashboard.checkpoint?.outcome, 'succeeded');
  assert.equal(dashboard.error, undefined);
  assert.deepEqual(dashboard.allowedActions, ['start']);

  const events = service.eventsSince(started.operationId);
  assert.deepEqual(events.map((event) => event.kind), [
    'execution.started',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.output',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ]);
  assert.deepEqual(
    events.filter((event) => event.kind === 'execution.terminal').map((event) => event.terminalPhase),
    ['provider', 'final'],
  );
  assert.equal(events.at(-1)?.summary.includes('provider closed'), true);
  assert.equal(events.at(-1)?.evidenceRefs.some((ref) => ref.locator === 'fake/close'), true);
  assert.equal(events.every((event) => event.executionEpoch === 1), true);
  assert.equal(events.every((event) => event.taskId.value === task.taskId.value), true);

  const observation = service.observation(task.taskId, 'pipeline.execute');
  assert.equal(observation.surface, 'observation');
  assert.equal(observation.selectedNode?.nodeId, 'pipeline.execute');
  const checkpointNode = observation.scope.nodes.find((node) => node.nodeId === 'settle');
  if (!checkpointNode) throw new Error('expected checkpoint observation node');
  assert.equal(checkpointNode.evidenceCount > 0, true);
  const selected = observation.selectedNode;
  if (!selected) throw new Error('expected selected pipeline.execute node');
  assert.equal(selected.evidenceRefs.length > 0, true);
  // The drawer panes read the detail projection's own typed fields, so the live service path must
  // carry the real tool steps and owning agent role, not just those of the flow node.
  assert.equal(selected.toolSteps.length, 1);
  assert.equal(selected.toolSteps[0]?.returned, 'tool: fake://tool/1');
  assert.equal(selected.toolSteps[0]?.name, 'humanagent.fake-provider');
  assert.equal(selected.ownerAgentRole, 'execution');
  assert.equal(selected.roleDisplay, '执行');
  assert.equal(selected.owner.length > 0, true);
  assert.equal(selected.iteration, 1);
  const childScope = selected.childScopeRef;
  if (!childScope) throw new Error('expected pipeline.execute child scope');
  const child = service.observation(task.taskId, undefined, childScope);
  assert.equal(child.scope.scopeRef, childScope);
  assert.equal(child.scope.nodes.length > 0, true);
  assert.equal(child.scope.canReturn, true);
  assert.throws(() => service.observation(task.taskId, 'unknown-node'));
  assert.throws(
    () => service.observation(task.taskId, undefined, `task://${task.taskId.value}/observation/foreign`),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'observation.scope.not-found'
      && error.httpStatus === 404,
  );

  const journal = await readFile(join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`), 'utf8');
  assert.match(journal, /"kind":"checkpoint"/);
  assert.match(journal, /"outcome":"succeeded"/);
  assert.match(journal, /"source":"humanagent.runtime"/);
  assert.equal(journal.includes('"source":"humanagent.fake-provider"'), false);
});

test('observation projects all thirteen registry nodes in registry order with agent-frame ownership and real tool steps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-observation-thirteen-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [
      { kind: 'model', state: 'model', summary: 'model accepted the request' },
      { kind: 'tool', state: 'tool', summary: 'tool call observed', outputRefs: ['fake://tool/1'] },
      { kind: 'output', state: 'output', summary: 'final answer', outputRefs: ['fake://output/1'] },
      { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
    ],
  }));
  const task = service.createTask({ title: 'thirteen nodes', directive: 'project every registry node' });
  service.startExecution(task.taskId, { prompt: 'observe thirteen nodes' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const observation = service.observation(task.taskId);

  // Registry order is the projection's own node order; the page never keeps a second table.
  assert.deepEqual(observation.nodes.map((node) => node.nodeId), [...PIPELINE_NODE_IDS]);
  assert.equal(observation.nodes.length, 13);
  const memoryNode = observation.nodes.find((node) => node.nodeId === 'memory.agent');
  if (!memoryNode) throw new Error('expected memory observation node');
  assert.equal(memoryNode.stateDisplay, '已创建');
  assert.match(memoryNode.summary, /尚未投影/);
  assert.deepEqual(
    observation.nodes.map((node) => node.row),
    PIPELINE_NODE_IDS.map((nodeId) => PIPELINE_ROWS[nodeId]),
  );
  // Ownership comes from the merged registry, one frame per owner role.
  assert.deepEqual(
    observation.nodes.map((node) => node.ownerAgentRole),
    ['interaction', 'interaction', 'orchestration', 'orchestration', 'orchestration', 'orchestration', 'orchestration', 'orchestration', 'orchestration', 'execution', 'review', 'review', 'memory'],
  );
  assert.deepEqual(
    observation.agentFrames.map((frame) => frame.role),
    ['interaction', 'orchestration', 'execution', 'review', 'memory'],
  );
  assert.deepEqual(
    observation.agentFrames.find((frame) => frame.role === 'execution')?.nodeIds,
    ['pipeline.execute'],
  );

  // Real tool step content reaches the projection; private reasoning has no channel into it.
  const executeNode = observation.nodes.find((node) => node.nodeId === 'pipeline.execute');
  if (!executeNode) throw new Error('expected pipeline.execute node');
  assert.equal(executeNode.toolSteps.length, 1);
  assert.equal(executeNode.toolSteps[0]?.returned, 'tool: fake://tool/1');
  assert.equal(executeNode.toolSteps[0]?.name, 'humanagent.fake-provider');
  // The provider reports `tool` without a terminal status; the step stays explicitly unknown.
  assert.equal(executeNode.toolSteps[0]?.status, 'unknown');
  assert.equal(executeNode.toolSteps[0]?.stepId.length > 0, true);

  // Cross-agent handoff content is carried by the projection itself.
  assert.equal(observation.handoffs.length > 0, true);
  const toSettle = observation.handoffs.find((handoff) => handoff.toNodeId === 'settle');
  if (!toSettle) throw new Error('expected pipeline.execute -> settle handoff');
  assert.equal(toSettle.fromRole, 'execution');
  assert.equal(toSettle.toRole, 'review');
  assert.equal(toSettle.carrySummary.length > 0, true);
  assert.equal(toSettle.notCarried.length > 0, true);

  // Direct task creation has no confirmed requirement admission; classification and queues stay
  // explicitly unprojected instead of being invented from lifecycle state.
  const queues = observation.nodes.filter((node) => node.nodeId.endsWith('.queue'));
  assert.equal(queues.length, 4);
  for (const queue of queues) {
    assert.equal(queue.stateDisplay, '已创建');
    assert.equal(queue.summary.includes('尚未投影'), true);
  }
  const classify = observation.nodes.find((node) => node.nodeId === 'implicit.classify');
  assert.equal(classify?.activity.length, 0);
  assert.equal(classify?.toolSteps.length, 0);
});

test('confirmed requirement is visibly queued before implicit dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-queued-requirement-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:queued-requirement',
    rawInput: 'show this requirement as queued before dispatch',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'show this requirement as queued before dispatch',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create queued requirement evidence',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:queued-requirement',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-23T01:20:00.000Z',
    payloadRef: 'asset://requirements/queued-requirement',
  });

  assert.deepEqual(service.status().implicitScheduling, {
    state: 'queued',
    code: 'explicit-brain.requirement-queued',
    ownerId: 'humanagent.runtime',
    message: '已确认需求正在 execution 队列等待准入。',
    nextAction: 'wait for implicit admission to dispatch the queued requirement',
    requirementId: 'requirement:draft-1:1',
    draftId: 'draft-1',
    fifoSeq: 1,
  });
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');

  const dispatched = await service.dispatchNextExplicitRequirement();
  assert.equal(dispatched.requirement.requirementId, 'requirement:draft-1:1');
  assert.equal(service.status().implicitScheduling, undefined);
});

test('a confirmed requirement behind a blocked FIFO head is projected as queued', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-queued-behind-blocked-head-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  service.startImplicitConsumer();
  service.markDisconnected();

  const confirm = async (suffix: string): Promise<string> => {
    const interactionId = await service.receiveExplicitInput({
      sourceRef: `ui:${suffix}`,
      rawInput: `queued behind a blocked head ${suffix}`,
      channel: 'business',
    });
    await service.beginExplicitMatching(interactionId);
    await service.recordExplicitMatch(interactionId, {
      normalizedInput: `queued behind a blocked head ${suffix}`,
      matchedTasks: [],
      knownFacts: [],
    });
    await service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'create',
      proposal: `create the queued-behind requirement ${suffix}`,
    });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: `confirmation:${suffix}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-22T00:00:00.000Z',
      payloadRef: `asset://requirements/${suffix}`,
    });
    return interactionId;
  };

  await confirm('blocked-head');
  await waitFor(() => assert.equal(service.status().implicitScheduling?.code, 'implicit-admission.blocked'));
  assert.equal(service.implicitSchedulingIssue()?.code, 'implicit-admission.blocked');
  assert.equal(service.listTasks().counts.total, 0);

  const behind = await confirm('queued-behind');
  await waitFor(() => {
    const scheduling = service.status().implicitScheduling;
    assert.equal(scheduling?.state, 'queued', `scheduling=${JSON.stringify(scheduling)}`);
    assert.equal(scheduling?.code, 'explicit-brain.requirement-queued');
    assert.equal(scheduling?.draftId, 'draft-2');
    assert.equal(scheduling?.fifoSeq, 2);
  });
  // The blocked head stays visible through the scheduling issue even though the
  // queued backlog is what the status projection now reports.
  assert.equal(service.implicitSchedulingIssue()?.code, 'implicit-admission.blocked');
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal((await service.inspectExplicitInteraction(behind)).state, 'confirmed');
});

test('the queued backlog behind a blocked head is observable from the HTTP status surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-queued-http-surface-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    interactionRoot: join(root, 'interactions'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: 'project-ui-queued-http-surface',
    workspaceRoot: root,
    memory: testMemory('project-ui-queued-http-surface'),
  });
  try {
    runtime.service.markDisconnected();
    const confirm = async (suffix: string): Promise<void> => {
      const interactionId = await runtime.service.receiveExplicitInput({
        sourceRef: `ui:${suffix}`,
        rawInput: `http surface queued backlog ${suffix}`,
        channel: 'business',
      });
      await runtime.service.beginExplicitMatching(interactionId);
      await runtime.service.recordExplicitMatch(interactionId, {
        normalizedInput: `http surface queued backlog ${suffix}`,
        matchedTasks: [],
        knownFacts: [],
      });
      await runtime.service.proposeExplicitRequirement(interactionId, {
        proposedIntent: 'create',
        proposal: `create the http-surface requirement ${suffix}`,
      });
      const proposed = await runtime.service.inspectExplicitInteraction(interactionId);
      assert.ok(proposed.draft);
      await runtime.service.confirmExplicitRequirement({
        draftId: proposed.draft!.draftId,
        inputRevision: 1,
        confirmationRef: `confirmation:${suffix}`,
        confirmedBy: 'human:operator',
        confirmedAt: '2026-09-22T00:00:00.000Z',
        payloadRef: `asset://requirements/${suffix}`,
      });
    };

    await confirm('blocked-head');
    await waitFor(() => assert.equal(runtime.service.status().implicitScheduling?.code, 'implicit-admission.blocked'));
    await confirm('queued-behind');

    await waitFor(() => assert.equal(runtime.service.status().implicitScheduling?.state, 'queued'));
    const statusResponse = await fetch(`${runtime.server.url}/api/runtime/status`);
    const status = await statusResponse.json() as ReturnType<UiRuntimeService['status']>;
    assert.equal(status.implicitScheduling?.state, 'queued');
    assert.equal(status.implicitScheduling?.code, 'explicit-brain.requirement-queued');
    assert.equal(status.implicitScheduling?.draftId, 'draft-2');
    assert.equal(status.implicitScheduling?.fifoSeq, 2);
    assert.equal(status.implicitScheduling?.message.includes('explicit-brain.requirement-retired'), false);
    assert.equal(status.implicitScheduling?.message.includes('implicit-admission.blocked'), true);
    const tasksResponse = await fetch(`${runtime.server.url}/api/tasks`);
    const tasks = await tasksResponse.json() as ReturnType<UiRuntimeService['listTasks']>;
    assert.equal(tasks.counts.total, 0);
  } finally {
    await runtime.server.close();
  }
});

test('a confirmed requirement is observable as queued before the implicit consumer drains it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-queued-before-drain-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  service.startImplicitConsumer();

  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:queued-before-drain',
    rawInput: 'observe this requirement as queued before the consumer drains it',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'observe this requirement as queued before the consumer drains it',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the queued-before-drain requirement',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:queued-before-drain',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-22T00:00:00.000Z',
    payloadRef: 'asset://requirements/queued-before-drain',
  });

  // Draining is a macrotask boundary, so the confirming response returns while
  // the requirement is still a genuine FIFO entry.
  assert.deepEqual(service.status().implicitScheduling, {
    state: 'queued',
    code: 'explicit-brain.requirement-queued',
    ownerId: 'humanagent.runtime',
    message: '已确认需求正在 execution 队列等待准入。',
    nextAction: 'wait for implicit admission to dispatch the queued requirement',
    requirementId: 'requirement:draft-1:1',
    draftId: 'draft-1',
    fifoSeq: 1,
  });
  assert.equal(service.listTasks().counts.total, 0);

  await waitFor(() => assert.equal(service.listTasks().counts.total, 1));
  assert.equal(service.status().implicitScheduling, undefined);
});

test('observation projects implicit classification and queue admission for confirmed requirements after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-observation-admission-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }), 'fake', 'ready', journal);
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:observation-admission',
    rawInput: 'observe the admitted queue',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'observe the admitted queue',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the observation admission task',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:observation-admission',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-23T01:00:00.000Z',
    payloadRef: 'asset://requirements/observation-admission',
  });

  const dispatched = await service.dispatchNextExplicitRequirement();
  await waitFor(() => assert.equal(service.taskDashboard(dispatched.taskId).state, 'succeeded'));

  const observation = service.observation(dispatched.taskId);
  const classify = observation.nodes.find((node) => node.nodeId === 'implicit.classify');
  assert.equal(classify?.stateDisplay, '已完成');
  assert.match(classify?.summary ?? '', /execution 队列/);
  assert.equal(classify?.activity.length, 1);
  assert.equal(classify?.activity[0]?.summary, 'admission requirements are satisfied');
  const queues = observation.nodes.filter((node) => node.nodeId.endsWith('.queue'));
  assert.equal(queues.length, 4);
  const selected = queues.find((node) => node.nodeId === 'execution.queue');
  assert.equal(selected?.stateDisplay, '已准入');
  assert.match(selected?.summary ?? '', /已选择 execution 队列/);
  for (const queue of queues) {
    assert.equal(queue.summary.includes('尚未投影'), false, queue.nodeId);
  }
  const list = service.listTasks();
  const row = list.completed.find((task) => task.taskId.value === dispatched.taskId.value);
  assert.equal(row?.requirementQueue, 'execution');
  assert.equal(row?.requirementAdmission, 'completed');
  assert.match(row?.requirementAdmissionLabel ?? '', /需求completed · execution 队列/);

  const restarted = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }), 'fake', 'ready', journal);
  await restarted.hydrate();
  const restored = restarted.observation(dispatched.taskId);
  assert.equal(restored.nodes.find((node) => node.nodeId === 'implicit.classify')?.stateDisplay, '已完成');
  assert.equal(restored.nodes.find((node) => node.nodeId === 'execution.queue')?.stateDisplay, '已准入');
  assert.equal(restored.nodes.filter((node) => node.nodeId.endsWith('.queue')).every((node) => !node.summary.includes('尚未投影')), true);
});

test('explicit brain confirmation is the only path from input to FIFO execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-brain-'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 1 });
  const service = serviceFor(root, port);
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'summarize the current task evidence',
    channel: 'business',
  });

  assert.equal(service.listTasks().counts.total, 0);
  const awaiting = await service.inspectExplicitInteraction(interactionId);
  assert.equal(awaiting.state, 'received');
  assert.equal(awaiting.draft, undefined);

  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'summarize the current task evidence',
    matchedTasks: [],
    knownFacts: ['no matching task'],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create a task for the confirmed evidence request',
  });

  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.equal(proposed.state, 'awaiting-confirmation');
  assert.ok(proposed.draft);
  assert.equal(service.listTasks().counts.total, 0);

  await assert.rejects(
    () => service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:explicit-brain',
      confirmedBy: '',
      confirmedAt: '2026-09-17T00:00:00.000Z',
      payloadRef: 'asset://requirements/explicit-brain',
    }),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'ExplicitIntakeError'
      && error.httpStatus === 409,
  );
  assert.equal(service.listTasks().counts.total, 0);

  const receipt = await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:explicit-brain',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/explicit-brain',
  });
  assert.equal(receipt.requirement.requirementId, 'requirement:draft-1:1');
  assert.equal(receipt.requirement.status, 'submitted');
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');

  const dispatched = await service.dispatchNextExplicitRequirement();
  assert.equal(dispatched.requirement.fifoSeq, 1);
  assert.equal(dispatched.taskId.value.startsWith('ui-task-'), true);
  assert.equal(dispatched.executionEpoch, 1);
  await waitFor(() => assert.equal(service.taskDashboard(dispatched.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(dispatched.taskId).input, 'summarize the current task evidence');
  assert.match(service.taskDashboard(dispatched.taskId).output, /fake replay/);
  assert.deepEqual(port.startPayloads, [{ prompt: 'summarize the current task evidence' }]);
  assert.equal(JSON.stringify(port.startPayloads).includes('asset://requirements/explicit-brain'), false);
  const events = service.eventsSince(dispatched.operationId);
  assert.deepEqual(events.map((event) => event.kind), [
    'execution.started',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.output',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ]);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('confirmed requirement cannot bypass implicit admission when the provider is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-admission-'));
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'unavailable',
  );
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'admit this requirement before creating work',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'admit this requirement before creating work',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the admission-gated requirement',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-admission',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-admission',
  });

  await assert.rejects(
    () => service.dispatchNextExplicitRequirement(),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'implicit-admission.blocked'
      && error.ownerId === 'runtime-coordinator'
      && error.httpStatus === 409,
  );
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');
});

test('runtime consumes a confirmed requirement without a browser dispatch request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-background-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  service.startImplicitConsumer();
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:new-task',
    rawInput: 'continue after the browser closes',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'continue after the browser closes',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the background task',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-background',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-22T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-background',
  });

  await waitFor(() => assert.equal(service.listTasks().counts.total, 1));
  await waitFor(() => assert.equal(service.listTasks().completed[0]?.state, 'succeeded'));
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('runtime admission waits on actual running load and resumes when capacity is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-capacity-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 100 }));
  service.startImplicitConsumer();

  const confirm = async (suffix: string): Promise<string> => {
    const interactionId = await service.receiveExplicitInput({
      sourceRef: `ui:${suffix}`,
      rawInput: `background task ${suffix}`,
      channel: 'business',
    });
    await service.beginExplicitMatching(interactionId);
    await service.recordExplicitMatch(interactionId, {
      normalizedInput: `background task ${suffix}`,
      matchedTasks: [],
      knownFacts: [],
    });
    await service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'create',
      proposal: `create background task ${suffix}`,
    });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: `confirmation:${suffix}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-22T00:00:00.000Z',
      payloadRef: `asset://requirements/${suffix}`,
    });
    return interactionId;
  };

  await confirm('capacity-first');
  await waitFor(() => assert.equal(service.listTasks().counts.running, 1));
  const secondInteraction = await confirm('capacity-second');
  await waitFor(() => assert.equal(service.implicitSchedulingIssue()?.code, 'implicit-admission.waiting'));
  assert.equal(service.listTasks().counts.total, 1);
  assert.equal((await service.inspectExplicitInteraction(secondInteraction)).state, 'confirmed');

  await waitFor(() => assert.equal(service.listTasks().counts.total, 2));
  await waitFor(() => assert.equal(service.listTasks().counts.completed, 2));
  assert.equal((await service.inspectExplicitInteraction(secondInteraction)).state, 'dispatched');
  assert.equal(service.implicitSchedulingIssue(), undefined);
});

test('implicit consumer retires a confirmed append whose taskRef is absent and continues later requirements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-missing-task-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));

  const missingTaskId = id('task', 'missing-task');
  const confirmAppend = async (suffix: string, taskRef: TaskId): Promise<string> => {
    const interactionId = await service.receiveExplicitInput({
      sourceRef: `ui:${suffix}`,
      rawInput: `append to missing task ${suffix}`,
      channel: 'business',
    });
    await service.beginExplicitMatching(interactionId);
    await service.recordExplicitMatch(interactionId, {
      normalizedInput: `append to missing task ${suffix}`,
      matchedTasks: [{ taskId: taskRef, relation: 'current', status: 'running' }],
      knownFacts: [],
    });
    await service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'append',
      proposal: `append to missing task ${suffix}`,
    });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: `confirmation:${suffix}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-22T00:00:00.000Z',
      payloadRef: `asset://requirements/${suffix}`,
    });
    return interactionId;
  };

  const laterTask = service.createTask({ title: 'later task', directive: 'later task' });
  await confirmAppend('missing-task-head', missingTaskId);
  const laterInteraction = await confirmAppend('later-append', laterTask.taskId);
  assert.equal(service.listTasks().counts.total, 1);

  service.startImplicitConsumer();
  await waitFor(() => {
    const state = service.status().implicitScheduling;
    assert.equal(state?.code, 'explicit-brain.requirement-retired');
    assert.equal(state?.state, 'blocked');
    assert.equal(state?.requirementId, 'requirement:draft-1:1');
    assert.equal(service.listTasks().counts.total, 1);
  });
  await waitFor(() => assert.equal(service.taskDashboard(laterTask.taskId).state, 'succeeded'));
  assert.equal((await service.inspectExplicitInteraction(laterInteraction)).state, 'dispatched');
  assert.equal(service.status().implicitScheduling?.code, 'explicit-brain.requirement-retired');
  assert.equal(service.listTasks().counts.total, 1);
});

test('public explicit dispatch reports a retired FIFO head without inventing a task row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-retired-alone-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const missingTaskId = id('task', 'missing-task');
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:retired-alone',
    rawInput: 'append to missing task',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'append to missing task',
    matchedTasks: [{ taskId: missingTaskId, relation: 'current', status: 'running' }],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'append',
    proposal: 'append to missing task',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:retired-alone',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-23T00:00:00.000Z',
    payloadRef: 'asset://requirements/retired-alone',
  });

  await assert.rejects(
    () => service.dispatchNextExplicitRequirement(),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'explicit-brain.requirement-retired'
      && error.ownerId === 'humanagent.runtime'
      && error.message.includes(missingTaskId.value)
      && error.nextAction.includes('requirement:draft-1:1')
      && error.nextAction.includes('draft-1')
      && error.httpStatus === 409,
  );
  assert.deepEqual(service.status().implicitScheduling, {
    state: 'blocked',
    code: 'explicit-brain.requirement-retired',
    ownerId: 'humanagent.runtime',
    message: `confirmed append target is not in the local task store: ${missingTaskId.value}`,
    nextAction: 'inspect the retired requirement and resubmit against a current task',
    requirementId: 'requirement:draft-1:1',
    draftId: 'draft-1',
    fifoSeq: 1,
  });
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');
});

test('public explicit dispatch preserves retired evidence when a later requirement dispatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-retired-later-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const missingTaskId = id('task', 'missing-task');
  const laterTask = service.createTask({ title: 'later task', directive: 'later task' });
  const confirmAppend = async (suffix: string, taskRef: TaskId): Promise<string> => {
    const interactionId = await service.receiveExplicitInput({
      sourceRef: `ui:${suffix}`,
      rawInput: `append to task ${suffix}`,
      channel: 'business',
    });
    await service.beginExplicitMatching(interactionId);
    await service.recordExplicitMatch(interactionId, {
      normalizedInput: `append to task ${suffix}`,
      matchedTasks: [{ taskId: taskRef, relation: 'current', status: 'running' }],
      knownFacts: [],
    });
    await service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'append',
      proposal: `append to task ${suffix}`,
    });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: `confirmation:${suffix}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-23T00:00:00.000Z',
      payloadRef: `asset://requirements/${suffix}`,
    });
    return interactionId;
  };

  const retiredInteraction = await confirmAppend('retired-head', missingTaskId);
  const laterInteraction = await confirmAppend('later-after-retired', laterTask.taskId);

  await assert.rejects(
    () => service.dispatchNextExplicitRequirement(),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'explicit-brain.requirement-retired'
      && error.nextAction.includes('requirement:draft-1:1')
      && error.httpStatus === 409,
  );
  assert.equal((await service.inspectExplicitInteraction(retiredInteraction)).state, 'confirmed');
  assert.equal((await service.inspectExplicitInteraction(laterInteraction)).state, 'confirmed');

  const dispatched = await service.dispatchNextExplicitRequirement();
  assert.equal(dispatched.requirement.requirementId, 'requirement:draft-2:1');
  assert.equal(service.implicitSchedulingIssue()?.code, 'explicit-brain.requirement-retired');
  assert.equal(service.status().implicitScheduling?.requirementId, 'requirement:draft-1:1');
  await waitFor(() => assert.equal(service.taskDashboard(laterTask.taskId).state, 'succeeded'));
  assert.equal((await service.inspectExplicitInteraction(retiredInteraction)).state, 'confirmed');
  assert.equal((await service.inspectExplicitInteraction(laterInteraction)).state, 'dispatched');
  assert.equal(service.listTasks().counts.total, 1);
});

test('active implicit admission state takes precedence over historical retirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-retire-blocked-'));
  let releaseOccupying!: () => void;
  const occupyingGate = new Promise<void>((resolve) => {
    releaseOccupying = resolve;
  });
  const port = new FirstOperationGatedReplayPort({ binding, stepDelayMs: 1 }, occupyingGate);
  const service = serviceFor(root, port);

  const missingTaskId = id('task', 'missing-task');
  const confirmAppend = async (suffix: string, taskRef: TaskId): Promise<string> => {
    const interactionId = await service.receiveExplicitInput({
      sourceRef: `ui:${suffix}`,
      rawInput: `append to task ${suffix}`,
      channel: 'business',
    });
    await service.beginExplicitMatching(interactionId);
    await service.recordExplicitMatch(interactionId, {
      normalizedInput: `append to task ${suffix}`,
      matchedTasks: [{ taskId: taskRef, relation: 'current', status: 'running' }],
      knownFacts: [],
    });
    await service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'append',
      proposal: `append to task ${suffix}`,
    });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: `confirmation:${suffix}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-22T00:00:00.000Z',
      payloadRef: `asset://requirements/${suffix}`,
    });
    return interactionId;
  };

  const laterTask = service.createTask({ title: 'later task', directive: 'later task' });
  const occupying = service.createTask({ title: 'occupy capacity', directive: 'occupy capacity' });
  service.startExecution(occupying.taskId, { prompt: 'occupy capacity' });
  await port.firstStarted;
  await confirmAppend('missing-task-head', missingTaskId);
  await confirmAppend('later-append', laterTask.taskId);

  service.startImplicitConsumer();
  await waitFor(() => {
    const state = service.status().implicitScheduling;
    assert.equal(service.listTasks().counts.running, 1, `tasks=${service.listTasks().counts.total} implicit=${state?.code}`);
    assert.equal(state?.code, 'implicit-admission.waiting');
    assert.equal(state?.state, 'waiting');
    assert.equal(state?.requirementId, 'requirement:draft-2:1');
    assert.equal(state?.draftId, 'draft-2');
  });
  assert.equal(service.implicitSchedulingIssue()?.code, 'implicit-admission.waiting');

  releaseOccupying();
  await waitFor(() => assert.equal(service.taskDashboard(laterTask.taskId).state, 'succeeded'));
  assert.equal(service.status().implicitScheduling?.code, 'explicit-brain.requirement-retired');
});

test('confirmed append against a running task queues an input revision instead of failing with task.busy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-append-running-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const port = new GatedPayloadCapturingReplayPort({ binding, stepDelayMs: 1 }, firstGate);
  const service = serviceFor(root, port, 'fake', 'ready', journal);

  const task = service.createTask({ title: 'running append target' });
  service.startExecution(task.taskId, { prompt: 'baseline input' });
  await port.firstStarted;

  const confirmAppend = async (suffix: string, normalizedInput: string): Promise<string> => {
    const interactionId = await service.receiveExplicitInput({
      sourceRef: `ui:${suffix}`,
      rawInput: normalizedInput,
      channel: 'business',
    });
    await service.beginExplicitMatching(interactionId);
    await service.recordExplicitMatch(interactionId, {
      normalizedInput,
      matchedTasks: [{ taskId: task.taskId, relation: 'current', status: 'running' }],
      knownFacts: [],
    });
    await service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'append',
      proposal: normalizedInput,
    });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: `confirmation:${suffix}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-24T00:00:00.000Z',
      payloadRef: `asset://requirements/${suffix}`,
    });
    return interactionId;
  };

  const interactionId = await confirmAppend('append-running', 'appended instruction');
  service.startImplicitConsumer();

  // The append must not reject with task.busy; it is deferred behind the running
  // execution as a pending input revision.
  await waitFor(() => assert.equal(service.status().implicitScheduling?.state, 'waiting'));
  assert.equal(service.status().implicitScheduling?.code, 'implicit-admission.waiting');
  assert.equal(service.taskDashboard(task.taskId).state, 'running');
  assert.equal(service.taskDashboard(task.taskId).input, 'baseline input');
  assert.equal(service.taskDashboard(task.taskId).executionEpoch, 1);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');
  assert.equal(port.startPayloads.length, 1, 'no second execution while the target is running');

  releaseFirst();
  await waitFor(() => assert.equal(port.startPayloads.length, 2));
  assert.deepEqual(port.startPayloads[0], { prompt: 'baseline input' });
  assert.deepEqual(port.startPayloads[1], { prompt: 'appended instruction' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(task.taskId).executionEpoch, 2);
  assert.equal(service.taskDashboard(task.taskId).input, 'appended instruction');
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');
  assert.equal(service.listTasks().counts.total, 1);
  await waitFor(() => assert.equal(service.status().implicitScheduling, undefined));

  const revisions = journal.replay()
    .filter((record): record is Extract<ReturnType<UiRuntimeJournal['replay']>[number], { readonly kind: 'explicit-brain.state' }> => record.kind === 'explicit-brain.state')
    .at(-1)?.state.taskInputRevisions;
  assert.equal(revisions?.length, 1);
  assert.deepEqual(revisions?.[0]?.state.revisions.map((revision) => revision.inputRevision), [1]);
  assert.equal(revisions?.[0]?.consumedInputRevision, 1);
});

test('appendTaskInput records task-scoped monotonic revisions in FIFO order and never overwrites', () => {
  const root = join(tmpdir(), `humanagent-ui-append-coordinator-${process.pid}`);
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const coordinator = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `task-${task.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal,
  });
  const task = coordinator.createTask({ title: 'append mailbox' });
  const envelope = (suffix: string, normalizedInput: string, inputRevision = 1): RequirementEnvelope => ({
    requirementId: `requirement:${suffix}:1`,
    draftId: suffix,
    inputRevision,
    intent: 'append',
    taskRef: task.taskId,
    normalizedInput,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-24T00:00:00.000Z',
    fifoSeq: inputRevision,
    payloadRef: `asset://requirements/${suffix}`,
  });

  const first = coordinator.appendTaskInput(task.taskId, envelope('append-a', 'first appended input'));
  assert.equal(first.status, 'updated');
  assert.equal(first.revision, 1);
  // Re-dispatching the same confirmed requirement is idempotent: no second copy.
  assert.equal(coordinator.appendTaskInput(task.taskId, envelope('append-a', 'first appended input')).revision, 1);
  const second = coordinator.appendTaskInput(task.taskId, envelope('append-b', 'second appended input', 2));
  assert.equal(second.revision, 2);
  assert.deepEqual(
    coordinator.exportTaskInputRevisions()[0]?.state.revisions.map((revision) => revision.envelope.normalizedInput),
    ['first appended input', 'second appended input'],
  );

  // FIFO: the oldest unconsumed revision is pending; consuming it advances the
  // cursor without dropping the newer revision.
  assert.equal(coordinator.pendingTaskInput(task.taskId)?.envelope.normalizedInput, 'first appended input');
  coordinator.consumeTaskInput(task.taskId, 1);
  assert.equal(coordinator.pendingTaskInput(task.taskId)?.envelope.normalizedInput, 'second appended input');
  coordinator.consumeTaskInput(task.taskId, 2);
  assert.equal(coordinator.pendingTaskInput(task.taskId), undefined);
  // Consumption is monotonic: a stale consume never rewinds the cursor.
  coordinator.consumeTaskInput(task.taskId, 1);
  assert.equal(coordinator.pendingTaskInput(task.taskId), undefined);

  const restored = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `task-${task.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal,
  });
  restored.restoreTaskInputRevisions(coordinator.exportTaskInputRevisions());
  assert.deepEqual(
    restored.exportTaskInputRevisions()[0]?.state.revisions.map((revision) => revision.envelope.normalizedInput),
    ['first appended input', 'second appended input'],
  );
  assert.equal(restored.pendingTaskInput(task.taskId), undefined);
});

test('runtime exposes a blocked requirement through status and resumes it after reconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-reconnect-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    interactionRoot: join(root, 'interactions'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: 'project-ui-implicit-reconnect',
    workspaceRoot: root,
    memory: testMemory('project-ui-implicit-reconnect'),
  });
  try {
    runtime.service.markDisconnected();
    const interactionId = await runtime.service.receiveExplicitInput({
      sourceRef: 'ui:implicit-reconnect',
      rawInput: 'resume this requirement after reconnect',
      channel: 'business',
    });
    await runtime.service.beginExplicitMatching(interactionId);
    await runtime.service.recordExplicitMatch(interactionId, {
      normalizedInput: 'resume this requirement after reconnect',
      matchedTasks: [],
      knownFacts: [],
    });
    await runtime.service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'create',
      proposal: 'create the reconnect requirement',
    });
    const proposed = await runtime.service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await runtime.service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:implicit-reconnect',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-22T00:00:00.000Z',
      payloadRef: 'asset://requirements/implicit-reconnect',
    });

    await waitFor(() => assert.equal(runtime.service.status().implicitScheduling?.code, 'implicit-admission.blocked'));
    const statusResponse = await fetch(`${runtime.server.url}/api/runtime/status`);
    const status = await statusResponse.json() as ReturnType<UiRuntimeService['status']>;
    assert.deepEqual(status.implicitScheduling, {
      state: 'blocked',
      code: 'implicit-admission.blocked',
      ownerId: 'runtime-coordinator',
      message: 'required capability is unavailable: provider.execution',
      nextAction: 'recover:capability.provider.execution',
      requirementId: 'requirement:draft-1:1',
      draftId: 'draft-1',
      fifoSeq: 1,
    });
    assert.equal(runtime.service.listTasks().counts.total, 0);
    assert.equal((await runtime.service.inspectExplicitInteraction(interactionId)).state, 'confirmed');

    runtime.service.markConnected();
    await waitFor(() => assert.equal(runtime.service.listTasks().counts.total, 1));
    await waitFor(() => assert.equal(runtime.service.status().implicitScheduling, undefined));
    assert.equal((await runtime.service.inspectExplicitInteraction(interactionId)).state, 'dispatched');
  } finally {
    await runtime.server.close();
  }
});

test('implicit consumer attaches to an existing running task and wakes pending work at final', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-rebind-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 100 }));
  const occupying = service.createTask({ title: 'occupy capacity', directive: 'occupy capacity' });
  service.startExecution(occupying.taskId, { prompt: 'occupy capacity' });

  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:implicit-rebind',
    rawInput: 'run after existing execution finalizes',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'run after existing execution finalizes',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create work after capacity release',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-rebind',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-22T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-rebind',
  });

  service.startImplicitConsumer();
  await waitFor(() => assert.equal(service.status().implicitScheduling?.state, 'waiting'));
  await waitFor(() => assert.equal(service.listTasks().counts.total, 2));
  await waitFor(() => assert.equal(service.listTasks().completed.length, 2));
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('implicit dispatch intent survives a persistence failure and restart without duplicate provider start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-persistence-'));
  const journal = new FailOnceProjectionJournal(join(root, 'ui-runtime-journal.jsonl'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 20 });
  const service = serviceFor(
    root,
    port,
    'fake',
    'ready',
    journal,
  );
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:implicit-persistence',
    rawInput: 'retry the same requirement after projection failure',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'retry the same requirement after projection failure',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create persistence retry work',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-persistence',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-22T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-persistence',
  });

  journal.failNextExplicitState = true;
  journal.explicitStatesBeforeFailure = 1;
  service.startImplicitConsumer();
  await waitFor(() => assert.equal(service.status().implicitScheduling?.state, 'failed'));
  assert.equal(service.status().implicitScheduling?.requirementId, 'requirement:draft-1:1');
  assert.equal(service.listTasks().counts.total, 1);
  assert.equal(port.startPayloads.length, 1);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');

  const restarted = serviceFor(root, port);
  await restarted.hydrate();
  restarted.startImplicitConsumer();
  await waitFor(() => {
    const state = journal.replay()
      .filter((record): record is Extract<ReturnType<UiRuntimeJournal['replay']>[number], { readonly kind: 'explicit-brain.state' }> => record.kind === 'explicit-brain.state')
      .at(-1)?.state;
    assert.deepEqual(state?.inbox.pendingDraftIds, []);
    assert.deepEqual(state?.dispatchLedger, []);
  });
  assert.equal(port.startPayloads.length, 1);
  assert.equal(restarted.status().implicitScheduling, undefined);
  assert.equal(restarted.listTasks().counts.total, 1);
  assert.equal((await restarted.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('task creation journal failure retries without publishing a ghost task and replays after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-task-create-failure-'));
  const journal = new FailOnceProjectionJournal(join(root, 'ui-runtime-journal.jsonl'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 20 });
  const service = serviceFor(root, port, 'fake', 'ready', journal);
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:implicit-task-create-failure',
    rawInput: 'retry after the task creation journal recovers',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'retry after the task creation journal recovers',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create task journal retry work',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-task-create-failure',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-22T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-task-create-failure',
  });

  journal.failNextTaskCreated = true;
  service.startImplicitConsumer();
  await waitFor(() => assert.equal(service.status().implicitScheduling?.state, 'failed'));
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal(port.startPayloads.length, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');

  service.markConnected();
  await waitFor(() => assert.equal(port.startPayloads.length, 1));
  await waitFor(() => {
    const state = journal.replay()
      .filter((record): record is Extract<ReturnType<UiRuntimeJournal['replay']>[number], { readonly kind: 'explicit-brain.state' }> => record.kind === 'explicit-brain.state')
      .at(-1)?.state;
    assert.deepEqual(state?.inbox.pendingDraftIds, []);
    assert.deepEqual(state?.dispatchLedger, []);
  });
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');
  assert.equal(journal.replay().filter((record) => record.kind === 'task.created').length, 1);

  const restarted = serviceFor(root, port);
  await restarted.hydrate();
  await assert.rejects(
    () => restarted.dispatchNextExplicitRequirement(),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'explicit-brain.inbox.empty',
  );
  assert.equal(port.startPayloads.length, 1);
  assert.equal(restarted.listTasks().counts.total, 1);
  assert.equal((await restarted.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('a failed dispatch head stays the primary status while a later confirmed requirement is queued', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-failed-head-backlog-'));
  const journal = new PersistentTaskCreateFailureJournal(join(root, 'ui-runtime-journal.jsonl'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 20 });
  const service = serviceFor(root, port, 'fake', 'ready', journal);
  const confirm = async (suffix: string): Promise<string> => {
    const interactionId = await service.receiveExplicitInput({
      sourceRef: `ui:${suffix}`,
      rawInput: `failed head backlog ${suffix}`,
      channel: 'business',
    });
    await service.beginExplicitMatching(interactionId);
    await service.recordExplicitMatch(interactionId, {
      normalizedInput: `failed head backlog ${suffix}`,
      matchedTasks: [],
      knownFacts: [],
    });
    await service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'create',
      proposal: `create failed-head backlog ${suffix}`,
    });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: `confirmation:${suffix}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-22T00:00:00.000Z',
      payloadRef: `asset://requirements/${suffix}`,
    });
    return interactionId;
  };

  service.startImplicitConsumer();
  journal.failTaskCreated = true;
  await confirm('failed-head');
  await waitFor(() => assert.equal(service.status().implicitScheduling?.state, 'failed'));
  const head = service.status().implicitScheduling;
  assert.ok(head);
  const headCode = head!.code;
  const headMessage = head!.message;
  const headNextAction = head!.nextAction;
  assert.equal(head!.requirementId, 'requirement:draft-1:1');
  assert.equal(head!.draftId, 'draft-1');
  assert.equal(headCode, 'ui-runtime.unexpected');
  assert.equal(headMessage, 'task journal unavailable');
  assert.equal(headNextAction, 'inspect the runtime error and retry from a new operation');
  assert.equal(port.startPayloads.length, 0);

  const behind = await confirm('queued-behind-failed-head');
  await waitFor(() => {
    const scheduling = service.status().implicitScheduling;
    assert.equal(scheduling?.state, 'failed', `scheduling=${JSON.stringify(scheduling)}`);
    assert.equal(scheduling?.requirementId, 'requirement:draft-1:1');
    assert.equal(scheduling?.draftId, 'draft-1');
    assert.equal(scheduling?.code, headCode);
    assert.equal(scheduling?.message, headMessage);
    assert.equal(scheduling?.nextAction, headNextAction);
  });
  // The failed head remains the dominant truth; the queued draft-2 is not promoted
  // to the status projection and the persistence failure is not hidden.
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal(port.startPayloads.length, 0);
  assert.equal((await service.inspectExplicitInteraction(behind)).state, 'confirmed');
});

test('operation start journal failure retries from the durable dispatch intent without losing work after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-operation-start-failure-'));
  const journal = new FailOnceProjectionJournal(join(root, 'ui-runtime-journal.jsonl'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 20 });
  const service = serviceFor(root, port, 'fake', 'ready', journal);
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:implicit-operation-start-failure',
    rawInput: 'retry after the operation start journal recovers',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'retry after the operation start journal recovers',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create operation journal retry work',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-operation-start-failure',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-22T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-operation-start-failure',
  });

  journal.failNextOperationStarted = true;
  service.startImplicitConsumer();
  await waitFor(() => assert.equal(service.status().implicitScheduling?.state, 'failed'));
  assert.equal(service.listTasks().counts.total, 1);
  assert.equal(service.listTasks().counts.running, 0);
  assert.equal(port.startPayloads.length, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');

  service.markConnected();
  await waitFor(() => assert.equal(port.startPayloads.length, 1));
  await waitFor(() => {
    const state = journal.replay()
      .filter((record): record is Extract<ReturnType<UiRuntimeJournal['replay']>[number], { readonly kind: 'explicit-brain.state' }> => record.kind === 'explicit-brain.state')
      .at(-1)?.state;
    assert.deepEqual(state?.inbox.pendingDraftIds, []);
    assert.deepEqual(state?.dispatchLedger, []);
  });
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');

  const restarted = serviceFor(root, port);
  await restarted.hydrate();
  await assert.rejects(
    () => restarted.dispatchNextExplicitRequirement(),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'explicit-brain.inbox.empty',
  );
  assert.equal(port.startPayloads.length, 1);
  assert.equal(restarted.listTasks().counts.total, 1);
  assert.equal((await restarted.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('execution start event failure resumes the committed operation intent before acknowledging the requirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-execution-start-failure-'));
  const journal = new FailOnceProjectionJournal(join(root, 'ui-runtime-journal.jsonl'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 20 });
  const service = serviceFor(root, port, 'fake', 'ready', journal);
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:implicit-execution-start-failure',
    rawInput: 'resume the committed operation intent before dispatch',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'resume the committed operation intent before dispatch',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create execution event journal retry work',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-execution-start-failure',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-22T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-execution-start-failure',
  });

  journal.failNextExecutionStarted = true;
  service.startImplicitConsumer();
  await waitFor(() => assert.equal(service.status().implicitScheduling?.state, 'failed'));
  assert.equal(service.listTasks().counts.total, 1);
  assert.equal(service.listTasks().counts.running, 0);
  assert.equal(port.startPayloads.length, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');

  service.markConnected();
  await waitFor(() => assert.equal(port.startPayloads.length, 1));
  await waitFor(() => {
    const state = journal.replay()
      .filter((record): record is Extract<ReturnType<UiRuntimeJournal['replay']>[number], { readonly kind: 'explicit-brain.state' }> => record.kind === 'explicit-brain.state')
      .at(-1)?.state;
    assert.deepEqual(state?.inbox.pendingDraftIds, []);
    assert.deepEqual(state?.dispatchLedger, []);
  });
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');

  const restarted = serviceFor(root, port);
  await restarted.hydrate();
  await assert.rejects(
    () => restarted.dispatchNextExplicitRequirement(),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'explicit-brain.inbox.empty',
  );
  assert.equal(port.startPayloads.length, 1);
  assert.equal(restarted.listTasks().counts.total, 1);
  assert.equal((await restarted.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('runtime restart hydrates dispatched state without starting the requirement twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-restart-'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 20 });
  const first = serviceFor(root, port);
  first.startImplicitConsumer();
  const interactionId = await first.receiveExplicitInput({
    sourceRef: 'ui:implicit-restart',
    rawInput: 'dispatch once across restart',
    channel: 'business',
  });
  await first.beginExplicitMatching(interactionId);
  await first.recordExplicitMatch(interactionId, {
    normalizedInput: 'dispatch once across restart',
    matchedTasks: [],
    knownFacts: [],
  });
  await first.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create restart-safe task',
  });
  const proposed = await first.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await first.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-restart',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-22T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-restart',
  });
  await waitFor(() => assert.equal(port.startPayloads.length, 1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await first.inspectExplicitInteraction(interactionId)).state, 'dispatched');
  await waitFor(() => assert.equal((first.listTasks().counts.total), 1));

  const restarted = serviceFor(root, port);
  await restarted.hydrate();
  restarted.startImplicitConsumer();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(port.startPayloads.length, 1);
  assert.equal((await restarted.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('explicit brain status query never creates a task or FIFO entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-status-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'what is the current status?',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  const receipt = await service.completeExplicitStatusQuery(interactionId);

  assert.deepEqual(receipt, {
    kind: 'status-only',
    interactionId,
    owner: 'explicit-intake',
    nextAction: 'present-status',
  });
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'status-only');
});

test('explicit brain confirmation retry is idempotent after a submission failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-retry-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'retry a confirmed requirement',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'retry a confirmed requirement',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the retry requirement',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  const confirmation = {
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:retry',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/retry',
  };

  const first = await service.confirmExplicitRequirement(confirmation);
  const second = await service.confirmExplicitRequirement(confirmation);
  assert.equal(first.requirement.requirementId, second.requirement.requirementId);
  assert.equal(second.requirement.status, 'duplicate');
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');
});

test('concurrent explicit dispatch starts exactly one execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-dispatch-race-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'dispatch exactly once',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'dispatch exactly once',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the dispatch race requirement',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:dispatch-race',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/dispatch-race',
  });

  const results = await Promise.allSettled([
    service.dispatchNextExplicitRequirement(),
    service.dispatchNextExplicitRequirement(),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (!rejected) throw new Error('expected one rejected dispatch');
  assert.equal(rejected.reason instanceof UiRuntimeApiError, true);
  assert.equal((rejected.reason as UiRuntimeApiError).code, 'explicit-brain.inbox.empty');
});

test('restart restores confirmed interaction and pending explicit inbox state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-restart-'));
  const first = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await first.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'survive restart',
    channel: 'business',
  });
  await first.beginExplicitMatching(interactionId);
  await first.recordExplicitMatch(interactionId, {
    normalizedInput: 'survive restart',
    matchedTasks: [],
    knownFacts: [],
  });
  await first.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the restart requirement',
  });
  const proposed = await first.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await first.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:restart',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/restart',
  });

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await second.hydrate();
  const restored = await second.inspectExplicitInteraction(interactionId);
  assert.equal(restored.state, 'confirmed');
  assert.equal(restored.rawInput, 'survive restart');
  const duplicateConfirmation = await second.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:restart',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/restart',
  });
  assert.equal(duplicateConfirmation.requirement.status, 'duplicate');
  const dispatched = await second.dispatchNextExplicitRequirement();
  assert.equal(dispatched.requirement.requirementId, 'requirement:draft-1:1');
  assert.equal(dispatched.requirement.fifoSeq, 1);
});

test('explicit brain interprets create, query, append, change, and clarification without entering the FIFO', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-interpret-'));
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    undefined,
    undefined,
    {
      async interpret(input) {
        const matchedTaskId = input.taskCandidates[0]?.taskId;
        if (input.rawInput === '现在进行到哪一步？') return {
          kind: 'status-query',
          normalizedInput: '查询当前任务进度',
          ...(matchedTaskId === undefined ? {} : { matchedTaskId }),
          knownFacts: ['当前任务存在'],
          answer: '当前任务仍在等待执行。',
          decisionRefs: ['decision:test-query'],
        };
        if (input.rawInput === '信息不够') return {
          kind: 'clarification',
          normalizedInput: '信息不够',
          knownFacts: [],
          question: '你希望处理哪个项目？',
          decisionRefs: ['decision:test-clarification'],
        };
        const intent = input.rawInput.startsWith('追加') ? 'append'
          : input.rawInput.startsWith('修改') ? 'change'
            : 'create';
        return {
          kind: 'requirement',
          normalizedInput: input.rawInput.replace(/^(新建|追加|修改)/, '').trim(),
          ...(intent === 'create' || matchedTaskId === undefined ? {} : { matchedTaskId }),
          knownFacts: [],
          intent,
          proposal: `${intent}:${input.rawInput}`,
          decisionRefs: [`decision:test-${intent}`],
        };
      },
    },
  );
  service.createTask({ title: '已有任务', directive: '整理启动步骤' });

  for (const [rawInput, expectedIntent] of [
    ['新建补充失败恢复步骤', 'create'],
    ['追加常见启动失败', 'append'],
    ['修改验收范围', 'change'],
  ] as const) {
    const interactionId = await service.receiveExplicitInput({ sourceRef: 'ui:task', rawInput, channel: 'business' });
    const interpreted = await service.interpretExplicitInput({ interactionId });
    assert.equal(interpreted.state, 'awaiting-confirmation');
    assert.equal(interpreted.draft?.proposedIntent, expectedIntent);
    assert.ok(interpreted.draft?.normalizedInput !== rawInput);
  }

  const queryId = await service.receiveExplicitInput({ sourceRef: 'ui:task', rawInput: '现在进行到哪一步？', channel: 'business' });
  const query = await service.interpretExplicitInput({ interactionId: queryId });
  assert.equal(query.state, 'status-only');
  assert.equal(query.reply, '当前任务仍在等待执行。');

  const clarificationId = await service.receiveExplicitInput({ sourceRef: 'ui:new-task', rawInput: '信息不够', channel: 'business' });
  const clarification = await service.interpretExplicitInput({ interactionId: clarificationId });
  assert.equal(clarification.state, 'awaiting-clarification');
  assert.equal(clarification.reply, '你希望处理哪个项目？');

  await assert.rejects(
    () => service.dispatchNextExplicitRequirement(),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'explicit-brain.inbox.empty',
  );
});

test('explicit brain persists a live-shaped structured provider proposal after successful settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-live-proposal-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const providerOutput = JSON.stringify({
    interactionId: 'interaction-live-shaped',
    inputRevision: 1,
    sourceRef: 'ui:live-shaped',
    kind: 'requirement',
    matchedTaskId: null,
    selectedAction: 'draft-requirement-and-hold-for-confirmation',
    normalizedInput: '创建需求：梳理项目集成状态并等待确认。',
    summary: '输入归一为一条待确认的需求草稿。',
    knownFacts: ['没有可匹配的既有任务。'],
    evidenceRefs: ['sourceRef:ui:live-shaped'],
    needsUserInput: true,
    needsToolResult: false,
    decisionRefs: ['mission:business-requirement-becomes-draft-and-proposal'],
    proposal: {
      revision: 1,
      intent: 'create',
      title: '项目集成状态梳理',
      objective: '梳理项目当前集成状态，并等待用户确认后再进入后台执行。',
      deliverable: '三条集成链路的现状、风险和证据清单',
      owner: null,
      ownerNote: '不选择 worker、provider、runtime 或资源实例。',
      deliveryConditions: ['三条链路逐条列出', '每条风险附带证据引用'],
      evidenceRefs: [],
      blockingGaps: ['缺少三条链路的只读投影来源'],
      lifecycle: 'draft -> awaiting-user-confirmation -> requirement.submit',
      requiresUserConfirmation: true,
      confirmationPrompt: '是否确认当前草稿并提交后台执行？',
    },
  });
  class SettlementTrackingPort extends FakeReplayExecutionRuntimePort {
    settleCalls = 0;

    override async settle(input: Parameters<ExecutionRuntimePort['settle']>[0]): Promise<ProviderSettlement> {
      this.settleCalls += 1;
      return super.settle(input);
    }
  }
  const port = new SettlementTrackingPort({
    binding,
    stepDelayMs: 0,
    replay: [
      { kind: 'output', state: 'output', summary: providerOutput },
      { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
    ],
  });
  const interpreter = createProviderExplicitBrainInterpreter({
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port,
  });
  const service = serviceFor(
    root,
    port,
    'rcc',
    'ready',
    new UiRuntimeJournal(journalPath),
    undefined,
    undefined,
    undefined,
    interpreter,
  );
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:live-shaped',
    rawInput: '整理项目集成状态',
    channel: 'business',
  });

  const interpreted = await service.interpretExplicitInput({ interactionId });
  assert.equal(port.settleCalls, 1);
  assert.equal(interpreted.state, 'awaiting-confirmation');
  assert.match(interpreted.draft?.proposal ?? '', /项目集成状态梳理/);
  assert.match(interpreted.draft?.proposal ?? '', /三条集成链路的现状、风险和证据清单/);
  assert.equal(interpreted.draft?.proposal.includes('draft -> awaiting-user-confirmation'), false);

  const restored = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 0 }),
    'rcc',
    'ready',
    new UiRuntimeJournal(journalPath),
  );
  await restored.hydrate();
  const persisted = await restored.inspectExplicitInteraction(interactionId);
  assert.equal(persisted.state, 'awaiting-confirmation');
  assert.equal(persisted.draft?.proposal, interpreted.draft?.proposal);
});

test('explicit brain rejects create interpretations that also select an existing task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-create-match-conflict-'));
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    undefined,
    undefined,
    {
      async interpret(input) {
        return {
          kind: 'requirement',
          normalizedInput: '修改已有任务的验收范围',
          matchedTaskId: input.taskCandidates[0]!.taskId,
          knownFacts: ['已有任务存在'],
          intent: 'create',
          proposal: 'create:修改已有任务的验收范围',
          decisionRefs: ['decision:test-create-match-conflict'],
        };
      },
    },
  );
  service.createTask({ title: '已有任务', directive: '整理启动步骤' });
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:new-task',
    rawInput: '修改已有任务的验收范围',
    channel: 'business',
  });

  await assert.rejects(
    () => service.interpretExplicitInput({ interactionId }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'explicit-brain.task-match-conflict',
  );
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'matching');
  await assert.rejects(
    () => service.dispatchNextExplicitRequirement(),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'explicit-brain.inbox.empty',
  );
});

test('explicit brain retries matching with the same interaction after interpretation failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-interpret-retry-'));
  const attempts = new Map<string, number>();
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    undefined,
    undefined,
    {
      async interpret(input) {
        const attempt = (attempts.get(input.interactionId) ?? 0) + 1;
        attempts.set(input.interactionId, attempt);
        if (input.rawInput === '首次解释失败') {
          if (attempt === 1) throw new Error('temporary provider failure');
          return {
            kind: 'requirement',
            normalizedInput: '首次解释失败后重试',
            knownFacts: [],
            intent: 'create',
            proposal: 'create:首次解释失败后重试',
            decisionRefs: ['decision:test-interpret-retry'],
          };
        }
        if (attempt === 1) return {
          kind: 'clarification',
          normalizedInput: input.rawInput,
          knownFacts: [],
          question: '请补充范围',
          decisionRefs: ['decision:test-retry-clarification'],
        };
        if (attempt === 2) throw new Error('temporary provider failure after clarification');
        return {
          kind: 'requirement',
          normalizedInput: '澄清后重试',
          knownFacts: ['范围已补充'],
          intent: 'create',
          proposal: 'create:澄清后重试',
          decisionRefs: ['decision:test-after-clarification-retry'],
        };
      },
    },
  );

  const initialRetryId = await service.receiveExplicitInput({
    sourceRef: 'ui:new-task',
    rawInput: '首次解释失败',
    channel: 'business',
  });
  await assert.rejects(() => service.interpretExplicitInput({ interactionId: initialRetryId }), /temporary provider failure/);
  assert.equal((await service.inspectExplicitInteraction(initialRetryId)).state, 'matching');
  const initialRetry = await service.interpretExplicitInput({ interactionId: initialRetryId });
  assert.equal(initialRetry.interactionId, initialRetryId);
  assert.equal(initialRetry.state, 'awaiting-confirmation');

  const clarificationRetryId = await service.receiveExplicitInput({
    sourceRef: 'ui:new-task',
    rawInput: '先澄清再失败',
    channel: 'business',
  });
  assert.equal(
    (await service.interpretExplicitInput({ interactionId: clarificationRetryId })).state,
    'awaiting-clarification',
  );
  assert.equal(
    (await service.answerExplicitClarification({ interactionId: clarificationRetryId, answer: '只处理验收范围' })).state,
    'matching',
  );
  await assert.rejects(
    () => service.interpretExplicitInput({ interactionId: clarificationRetryId }),
    /temporary provider failure after clarification/,
  );
  assert.equal((await service.inspectExplicitInteraction(clarificationRetryId)).state, 'matching');
  const clarificationRetry = await service.interpretExplicitInput({ interactionId: clarificationRetryId });
  assert.equal(clarificationRetry.interactionId, clarificationRetryId);
  assert.equal(clarificationRetry.state, 'awaiting-confirmation');
});

test('explicit brain accepts a clarification answer over HTTP and re-enters interpretation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-clarification-http-'));
  let interpretationCount = 0;
  let observedClarificationAnswer: string | undefined;
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: 'project-ui-explicit-clarification-http',
    workspaceRoot: root,
    explicitBrainInterpreter: {
      async interpret(input) {
        interpretationCount += 1;
        if (interpretationCount === 1) return {
          kind: 'clarification',
          normalizedInput: input.rawInput,
          knownFacts: [],
          question: '需要修改哪个部分？',
          decisionRefs: ['decision:http-clarification'],
        };
        observedClarificationAnswer = (input as typeof input & {
          readonly clarifications?: readonly { readonly answer?: string }[];
        }).clarifications?.at(-1)?.answer;
        return {
          kind: 'requirement',
          normalizedInput: '修改现有任务的验收范围',
          knownFacts: ['用户补充了验收范围'],
          intent: 'create',
          proposal: 'create:修改现有任务的验收范围',
          decisionRefs: ['decision:http-after-clarification'],
        };
      },
    },
    memory: testMemory('project-ui-explicit-clarification-http'),
  });
  try {
    const receivedResponse = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceRef: 'ui:new-task', rawInput: '修改任务', channel: 'business' }),
    });
    const received = await receivedResponse.json() as { readonly interactionId: string };
    const firstResponse = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(received.interactionId)}/interpret`,
      { method: 'POST' },
    );
    assert.equal(firstResponse.status, 200);
    assert.equal((await firstResponse.json() as { readonly state: string }).state, 'awaiting-clarification');

    const clarificationResponse = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(received.interactionId)}/clarification`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: '只修改验收范围' }),
      },
    );
    assert.equal(clarificationResponse.status, 200);
    assert.equal((await clarificationResponse.json() as { readonly state: string }).state, 'matching');

    const secondResponse = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(received.interactionId)}/interpret`,
      { method: 'POST' },
    );
    assert.equal(secondResponse.status, 200);
    assert.equal((await secondResponse.json() as { readonly state: string }).state, 'awaiting-confirmation');
    assert.equal(observedClarificationAnswer, '只修改验收范围');
  } finally {
    await runtime.server.close();
  }
});

test('UI runtime assembly rejects an unconfigured production explicit brain before startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-unconfigured-'));
  await assert.rejects(
    () => startUiRuntimeOwner({
      mode: 'fake',
      organId,
      binding,
      port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
      checkpointRoot: join(root, 'checkpoints'),
      evidenceRoot: join(root, 'evidence'),
      uiRoot: join(process.cwd(), 'packages/ui/static'),
      projectKey: 'project-ui-explicit-unconfigured',
      workspaceRoot: root,
      memory: testMemory('project-ui-explicit-unconfigured'),
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'explicit-brain-prompt-unavailable'
      && 'ownerId' in error
      && error.ownerId === 'humanagent.app.ui-runtime',
  );
});

test('explicit brain HTTP routes reach typed service operations and expose typed errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-http-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: 'project-ui-explicit-http',
    workspaceRoot: root,
    explicitBrainInterpreter: {
      async interpret(input) {
        return {
          kind: 'requirement',
          normalizedInput: input.rawInput.toUpperCase(),
          knownFacts: [],
          intent: 'create',
          proposal: `create:${input.rawInput}`,
          decisionRefs: ['decision:http-interpret'],
        };
      },
    },
    memory: testMemory('project-ui-explicit-http'),
  });
  try {
    const malformedDecisionResponse = await fetch(`${runtime.server.url}/api/explicit/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        toolIntents: [{
          toolIntentId: 'intent:malformed-decision',
          toolRef: 'workspace.list',
          arguments: { scopeRef: 'scope:workspace:project-ui-explicit-http', pathRef: '.' },
          argumentsDigest: explicitArgumentsDigest({ scopeRef: 'scope:workspace:project-ui-explicit-http', pathRef: '.' }),
          reasonRefs: [],
          selectedBecause: 'test',
        }],
      }),
    });
    assert.equal(malformedDecisionResponse.status, 400);
    const malformedDecision = await malformedDecisionResponse.json() as { readonly error: { readonly code: string } };
    assert.equal(malformedDecision.error.code, 'request.invalid-field');
    const initialJournal = await readFile(join(root, 'checkpoints', 'fake', 'ui-runtime-journal.jsonl'), 'utf8').catch(() => '');
    assert.equal(initialJournal.includes('malformed-decision'), false);

    const malformedToolResponse = await fetch(`${runtime.server.url}/api/explicit/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decisionId: 'decision:malformed-tool',
        interactionId: 'interaction:malformed-tool',
        kind: 'intent',
        selectedAction: 'answer',
        summary: 'reject malformed tool input',
        evidenceRefs: [],
        toolIntents: [{
          toolIntentId: 'intent:malformed-tool',
          toolRef: 'workspace.list',
          arguments: { scopeRef: 'scope:workspace:project-ui-explicit-http', pathRef: '.' },
          argumentsDigest: explicitArgumentsDigest({ scopeRef: 'scope:workspace:project-ui-explicit-http', pathRef: '.' }),
          selectedBecause: 'test',
        }],
      }),
    });
    assert.equal(malformedToolResponse.status, 400);

    const inputResponse = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:http',
        rawInput: 'route through HTTP',
        channel: 'business',
        inputRevision: 4,
      }),
    });
    assert.equal(inputResponse.status, 201);
    const input = await inputResponse.json() as { readonly interactionId: string };

    const inspectResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}`);
    assert.equal(inspectResponse.status, 200);
    const inspected = await inspectResponse.json() as { readonly state: string; readonly draft?: { readonly inputRevision: number } };
    assert.equal(inspected.state, 'received');
    assert.equal(inspected.draft, undefined);

    const rejectedInputResponse = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:http',
        rawInput: 'reject through HTTP',
        channel: 'business',
      }),
    });
    assert.equal(rejectedInputResponse.status, 201);
    const rejectedInput = await rejectedInputResponse.json() as { readonly interactionId: string };
    const rejectionResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(rejectedInput.interactionId)}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'not in the current task scope' }),
    });
    assert.equal(rejectionResponse.status, 200);
    const closure = await rejectionResponse.json() as { readonly state: string; readonly closure: { readonly closureKind: string; readonly closureId: string } };
    assert.equal(closure.state, 'closed');
    assert.equal(closure.closure.closureKind, 'interaction');
    assert.equal(closure.closure.closureId, `interaction-closure-${rejectedInput.interactionId}`);
    const rejectedInspection = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(rejectedInput.interactionId)}`);
    assert.equal(rejectedInspection.status, 200);
    assert.equal((await rejectedInspection.json() as { readonly state: string; readonly reason?: string }).state, 'rejected');
    const journalLines = (await readFile(join(root, 'checkpoints', 'fake', 'ui-runtime-journal.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { readonly kind: string });
    assert.equal(journalLines.some((line) => line.kind === 'interaction.closure'), true);

    const staleResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}/confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: 'draft-missing',
        inputRevision: 4,
        confirmationRef: 'confirmation:http-stale',
        confirmedBy: 'human:operator',
        confirmedAt: '2026-09-17T00:00:00.000Z',
        payloadRef: 'asset://requirements/http-stale',
      }),
    });
    assert.equal(staleResponse.status, 409);
    const stale = await staleResponse.json() as { readonly error: { readonly code: string; readonly ownerId: string } };
    assert.equal(stale.error.code, 'ExplicitIntakeError');
    assert.equal(stale.error.ownerId, 'explicit-intake');

    const interpretationResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}/interpret`, { method: 'POST' });
    assert.equal(interpretationResponse.status, 200);
    const interpretation = await interpretationResponse.json() as { readonly state: string; readonly draft?: { readonly normalizedInput: string } };
    assert.equal(interpretation.state, 'awaiting-confirmation');
    assert.equal(interpretation.draft?.normalizedInput, 'ROUTE THROUGH HTTP');
    const proposedResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}`);
    const proposed = await proposedResponse.json() as { readonly draft?: { readonly draftId: string; readonly inputRevision: number } };
    assert.ok(proposed.draft);
    const confirmationResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}/confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: proposed.draft!.draftId,
        inputRevision: proposed.draft!.inputRevision,
        confirmationRef: 'confirmation:http-dispatch',
        confirmedBy: 'human:operator',
        confirmedAt: '2026-09-17T00:00:00.000Z',
        payloadRef: 'asset://requirements/http-dispatch',
      }),
    });
    assert.equal(confirmationResponse.status, 200);
    await waitFor(() => assert.equal(runtime.service.listTasks().counts.total, 1));
    await waitFor(() => assert.equal(runtime.service.listTasks().counts.completed, 1));

    // A second interaction that is still awaiting confirmation must not be
    // confirmable through a route that points at the already-confirmed
    // interaction: the draft is another interaction's, so the route must
    // reject it and leave both interactions' state untouched.
    const foreignInputResponse = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:http',
        rawInput: 'route a foreign draft through HTTP',
        channel: 'business',
      }),
    });
    assert.equal(foreignInputResponse.status, 201);
    const foreignInput = await foreignInputResponse.json() as { readonly interactionId: string };
    await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(foreignInput.interactionId)}/interpret`, { method: 'POST' });
    const foreignProposedResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(foreignInput.interactionId)}`);
    const foreignProposed = await foreignProposedResponse.json() as { readonly state: string; readonly draft?: { readonly draftId: string; readonly inputRevision: number } };
    assert.equal(foreignProposed.state, 'awaiting-confirmation');
    assert.ok(foreignProposed.draft);

    const foreignConfirmationResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}/confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: foreignProposed.draft!.draftId,
        inputRevision: foreignProposed.draft!.inputRevision,
        confirmationRef: 'confirmation:http-foreign-draft',
        confirmedBy: 'human:operator',
        confirmedAt: '2026-09-17T00:00:00.000Z',
        payloadRef: 'asset://requirements/http-foreign-draft',
      }),
    });
    assert.equal(foreignConfirmationResponse.status, 409);
    const foreignRejection = await foreignConfirmationResponse.json() as { readonly error: { readonly code: string; readonly ownerId: string; readonly nextAction?: string } };
    assert.equal(foreignRejection.error.code, 'ExplicitIntakeError');
    assert.equal(foreignRejection.error.ownerId, 'human');
    assert.equal(foreignRejection.error.nextAction, 'reconfirm-the-current-draft-revision');
    const foreignAfter = await (await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(foreignInput.interactionId)}`)).json() as { readonly state: string };
    assert.equal(foreignAfter.state, 'awaiting-confirmation');
    // The addressed interaction keeps its own confirmation: the rejected call
    // must not have re-pointed it at the foreign draft. Its state may already
    // have advanced past confirmation through implicit consumption.
    const addressedAfter = await (await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}`)).json() as { readonly confirmation?: { readonly draftId: string } };
    assert.equal(addressedAfter.confirmation?.draftId, proposed.draft!.draftId);
    assert.equal(addressedAfter.confirmation?.draftId === foreignProposed.draft!.draftId, false);

    const controlResponse = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:http',
        rawInput: 'stop the current task',
        channel: 'control',
        controlCommand: 'stop',
      }),
    });
    assert.equal(controlResponse.status, 501);
    const control = await controlResponse.json() as { readonly error: { readonly code: string; readonly ownerId: string } };
    assert.equal(control.error.code, 'explicit-brain.control.unsupported');
    assert.equal(control.error.ownerId, 'humanagent.app');
  } finally {
    await runtime.server.close();
  }
});

test('explicit brain HTTP dispatch blocks on implicit admission instead of creating a task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-http-admission-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    providerState: 'unavailable',
    memory: testMemory('project-ui-explicit-http-admission'),
  });
  try {
    const inputResponse = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:http-admission',
        rawInput: 'block at admission over HTTP',
        channel: 'business',
      }),
    });
    const input = await inputResponse.json() as { readonly interactionId: string };
    await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}/matching`, { method: 'POST' });
    await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        normalizedInput: 'block at admission over HTTP',
        matchedTasks: [],
        knownFacts: [],
      }),
    });
    await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}/proposal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proposedIntent: 'create',
        proposal: 'create the admission-gated HTTP requirement',
      }),
    });
    const inspected = await (await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}`,
    )).json() as { readonly draft?: { readonly draftId: string } };
    assert.ok(inspected.draft);
    await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}/confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: inspected.draft!.draftId,
        inputRevision: 1,
        confirmationRef: 'confirmation:http-admission',
        confirmedBy: 'human:operator',
        confirmedAt: '2026-09-17T00:00:00.000Z',
        payloadRef: 'asset://requirements/http-admission',
      }),
    });

    const dispatchResponse = await fetch(`${runtime.server.url}/api/explicit/dispatch-next`, { method: 'POST' });
    assert.equal(dispatchResponse.status, 409);
    const body = await dispatchResponse.json() as { readonly error: { readonly code: string; readonly ownerId: string } };
    assert.equal(body.error.code, 'implicit-admission.blocked');
    assert.equal(body.error.ownerId, 'runtime-coordinator');
    assert.equal(runtime.service.listTasks().counts.total, 0);
  } finally {
    await runtime.server.close();
  }
});

test('rejected interaction rolls back when closure persistence fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-rejection-closure-failure-'));
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    undefined,
    new FailingInteractionClosurePort(),
  );
  const interactionId = await service.receiveExplicitInput({ sourceRef: 'ui:failure', rawInput: 'closure failure', channel: 'business' });
  await assert.rejects(
    () => service.rejectExplicitInteraction(interactionId, 'closure unavailable'),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'interaction-closure.persistence-failed'
      && error.httpStatus === 503,
  );
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'received');

  const restarted = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await restarted.hydrate();
  assert.equal((await restarted.inspectExplicitInteraction(interactionId)).state, 'received');
});

test('rejected interaction recovers projection failure after restart without duplicating its closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-rejection-projection-failure-'));
  const journal = new FailOnceProjectionJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }), 'fake', 'ready', journal);
  const interactionId = await service.receiveExplicitInput({ sourceRef: 'ui:projection-failure', rawInput: 'projection failure', channel: 'business' });
  journal.failNextExplicitState = true;
  await assert.rejects(
    () => service.rejectExplicitInteraction(interactionId, 'projection unavailable'),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'interaction-closure.persistence-failed'
      && error.httpStatus === 503,
  );
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'received');
  assert.equal(journal.replay().filter((record) => record.kind === 'interaction.closure').length, 1);

  const restarted = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }), 'fake', 'ready', journal);
  await restarted.hydrate();
  assert.equal((await restarted.inspectExplicitInteraction(interactionId)).state, 'received');
  await restarted.rejectExplicitInteraction(interactionId, 'projection unavailable');
  assert.equal((await restarted.inspectExplicitInteraction(interactionId)).state, 'rejected');
  assert.equal(journal.replay().filter((record) => record.kind === 'interaction.closure').length, 1);
});

test('runtime output concatenates repeated provider deltas without suffix dedupe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-output-dedupe-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [
      { kind: 'output', state: 'output', summary: 'a', outputRefs: ['fake://output/1'] },
      { kind: 'output', state: 'output', summary: 'a', outputRefs: ['fake://output/2'] },
      { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
    ],
  }));
  const task = service.createTask({ title: 'repeated output deltas' });
  service.startExecution(task.taskId, { prompt: 'run repeated deltas' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(task.taskId).output, 'aa');
});

test('responses delta and completion replay projects output text exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-responses-output-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [
      { kind: 'output', state: 'output', summary: 'hello ', outputRefs: ['fake://text/item-1'] },
      { kind: 'output', state: 'output', summary: 'world', outputRefs: ['fake://text/item-1'] },
      { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
    ],
  }));
  const task = service.createTask({ title: 'responses output projection' });
  service.startExecution(task.taskId, { prompt: 'run responses replay' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(task.taskId).output, 'hello world');
});

test('observation preserves waiting and blocked terminal states instead of reporting success', async () => {
  for (const terminalState of ['waiting', 'blocked'] as const) {
    const root = await mkdtemp(join(tmpdir(), `humanagent-ui-observation-${terminalState}-`));
    const port = new FakeReplayExecutionRuntimePort({
      binding,
      stepDelayMs: 1,
      replay: [
        { kind: 'model', state: 'model', summary: 'model accepted the request' },
        { kind: 'terminal', state: terminalState, summary: `execution ${terminalState}`, terminalState },
      ],
    });
    const service = serviceFor(root, port);
    const task = service.createTask({ title: `observation ${terminalState}` });
    service.startExecution(task.taskId, { prompt: `observe ${terminalState}` });
    await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, terminalState));
    assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, terminalState);

    const child = service.observation(task.taskId, undefined, `task://${task.taskId.value}/observation/pipeline.execute`);
    const terminalNode = child.scope.nodes.find((node) => node.summary === `execution ${terminalState}`);
    assert.equal(terminalNode?.state, terminalState);
    const settleNode = service.observation(task.taskId).scope.nodes.find((node) => node.nodeId === 'settle');
    assert.equal(
      settleNode?.stateDisplay,
      terminalState === 'waiting' ? '等待中' : '受阻',
    );
  }
});

test('fake replay terminal state drives settlement instead of defaulting to success', async () => {
  for (const terminalState of ['failed', 'blocked', 'waiting'] as const) {
    const root = await mkdtemp(join(tmpdir(), `humanagent-ui-fake-terminal-${terminalState}-`));
    const port = new FakeReplayExecutionRuntimePort({
      binding,
      stepDelayMs: 1,
      replay: [
        { kind: 'model', state: 'model', summary: 'model accepted the request' },
        { kind: 'terminal', state: terminalState, summary: `execution ${terminalState}`, terminalState },
      ],
    });
    const service = serviceFor(root, port);
    const task = service.createTask({ title: `fake ${terminalState}` });
    service.startExecution(task.taskId, { prompt: `run ${terminalState}` });

    await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, terminalState));
    assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, terminalState);
  }
});

test('fake replay without a terminal event fails explicitly instead of reporting success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-fake-missing-terminal-'));
  const port = new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [{ kind: 'model', state: 'model', summary: 'model accepted the request' }],
  });
  const service = serviceFor(root, port);
  const task = service.createTask({ title: 'fake missing terminal' });
  service.startExecution(task.taskId, { prompt: 'run without terminal' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));
  assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, 'failed');
});

test('provider identity mismatch fails the execution without surfacing a foreign event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-observation-stale-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const stalePort: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: async function* observe(input) {
      yield {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch + 1,
        eventId: 'stale-output',
        kind: 'output',
        outputRefs: ['stale://output'],
        evidenceRefs: [evidence('stale-output', { organId, taskId: input.taskId, operationId: input.operationId })],
      };
      yield {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        eventId: 'terminal-output',
        kind: 'terminal',
        terminalState: 'succeeded',
        evidenceRefs: [evidence('terminal-output', { organId, taskId: input.taskId, operationId: input.operationId })],
      };
    },
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, stalePort);
  const task = service.createTask({ title: 'observation stale' });
  service.startExecution(task.taskId, { prompt: 'observe stale event' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.output, '');
  assert.equal(dashboard.error?.ownerId, 'humanagent.provider-adapter');
  const child = service.observation(task.taskId, undefined, `task://${task.taskId.value}/observation/pipeline.execute`);
  assert.equal(child.scope.nodes.some((node) => node.summary.includes('foreign-task')), false);
  assert.equal(child.scope.nodes.some((node) => node.summary.includes('another execution')), true);
});

test('operation-scoped hydration restores an operation-less business checkpoint after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-restart-'));
  const first = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const firstTask = first.createTask({ title: 'first process' });
  const firstStarted = first.startExecution(firstTask.taskId, { prompt: 'first process' });
  await waitFor(() => assert.equal(first.taskDashboard(firstTask.taskId).state, 'succeeded'));
  const firstEvents = first.eventsSince(firstStarted.operationId);

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await second.hydrate();
  const reconstructedDashboard = second.taskDashboard(firstTask.taskId);
  assert.equal(reconstructedDashboard.state, 'succeeded');
  assert.equal(reconstructedDashboard.checkpoint?.outcome, 'succeeded');
  const reconstructed = await new FileCheckpointStore(
    join(root, `task-${firstTask.taskId.value}-cycle-ui-cycle-1.jsonl`),
  ).readLatest({
    organId,
    taskId: firstTask.taskId,
    cycleId: id('cycle', 'ui-cycle-1'),
    operationId: firstStarted.operationId,
  });
  if (!reconstructed) throw new Error('expected reconstructed checkpoint');
  assert.equal(reconstructed.checkpoint.outcome, 'succeeded');
  assert.equal(reconstructed.checkpoint.scope.operationId, undefined);
  assert.deepEqual(second.eventsSince(firstStarted.operationId).map((event) => event.eventId), firstEvents.map((event) => event.eventId));

  const secondTask = second.createTask({ title: 'second process' });
  assert.equal(secondTask.taskId.value === firstTask.taskId.value, false);
  second.startExecution(secondTask.taskId, { prompt: 'second process' });
  await waitFor(() => assert.equal(second.taskDashboard(secondTask.taskId).state, 'succeeded'));
  assert.equal(second.taskDashboard(secondTask.taskId).error, undefined);

  const third = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await third.hydrate();
  assert.equal(third.taskDashboard(firstTask.taskId).state, 'succeeded');
  assert.equal(third.taskDashboard(secondTask.taskId).state, 'succeeded');
  const resumed = third.startExecution(firstTask.taskId, { prompt: 'new epoch after restart' });
  assert.equal(resumed.executionEpoch, 2);
  await waitFor(() => assert.equal(third.taskDashboard(firstTask.taskId).state, 'succeeded'));
});

test('memory context receipt is process-local across serve restart and fresh operation rebinds memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-receipt-restart-'));
  const launch = () => startUiRuntime({
    mode: 'fake' as const,
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-memory-receipt-restart'),
  });

  const first = await launch();
  const task = first.service.createTask({ title: 'memory receipt restart' });
  const firstStarted = first.service.startExecution(task.taskId, { prompt: 'first memory receipt' });
  try {
    await waitFor(() => assert.equal(first.service.taskDashboard(task.taskId).state, 'succeeded'));
    assert.equal(first.service.memoryContextReceipt(firstStarted.operationId).executionEpoch, firstStarted.executionEpoch);
  } finally {
    await first.server.close();
  }

  const second = await launch();
  try {
    assert.throws(
      () => second.service.memoryContextReceipt(firstStarted.operationId),
      (error: unknown) => error instanceof UiRuntimeApiError
        && error.code === 'memory-binding-missing'
        && error.httpStatus === 404,
    );

    const secondStarted = second.service.startExecution(task.taskId, { prompt: 'fresh memory receipt' });
    assert.equal(secondStarted.executionEpoch, firstStarted.executionEpoch + 1);
    await waitFor(() => assert.equal(second.service.taskDashboard(task.taskId).state, 'succeeded'));
    assert.equal(second.service.memoryContextReceipt(secondStarted.operationId).executionEpoch, secondStarted.executionEpoch);
  } finally {
    await second.server.close();
  }
});

test('journal replay fails explicitly instead of silently dropping corrupted projection records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-journal-corrupt-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  await writeFile(journalPath, '{"kind":"task.created","taskId":{"scope":"task","value":"broken"}}\n', 'utf8');

  const journal = new UiRuntimeJournal(journalPath);
  assert.throws(
    () => journal.replay(),
    (error: unknown) => error instanceof Error
      && error.message.includes('ui-runtime-journal.jsonl:1')
      && error.message.includes('title is required'),
  );
});

test('journal replay rejects a projection event that cross-links another operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-journal-cross-link-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const createdAt = '2026-01-01T00:00:00.000Z';
  const taskId = id('task', 'task-cross-link');
  const operationId = id('operation', 'operation-cross-link');
  const scope = {
    organId: id('organ', 'organ-cross-link'),
    taskId,
    cycleId: id('cycle', 'cycle-cross-link'),
    operationId,
  };
  await writeFile(journalPath, `${[
    JSON.stringify({
      kind: 'task.created',
      taskId,
      title: 'cross link',
      directive: 'cross link',
      directiveRevision: 1,
      createdAt,
      taskCounter: 1,
    }),
    JSON.stringify({
      kind: 'operation.started',
      operationId,
      taskId,
      cycleId: scope.cycleId,
      scope,
      executionEpoch: 1,
      operationCounter: 1,
      cycleCounter: 1,
      startedAt: createdAt,
      input: 'cross link',
    }),
    JSON.stringify({
      kind: 'operation.event',
      operationId,
      event: {
        eventId: 'event-cross-link',
        seq: 1,
        occurredAt: createdAt,
        taskId,
        operationId: 'operation-somewhere-else',
        executionEpoch: 1,
        kind: 'execution.started',
        state: 'running',
        summary: 'foreign event',
        evidenceRefs: [],
      },
    }),
  ].join('\n')}\n`, 'utf8');

  assert.throws(
    () => new RuntimeTaskCoordinator({
      organId,
      createDriver: () => {
        throw new Error('createDriver must not run while replaying a corrupt journal');
      },
      checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `task-${task.value}-cycle-${cycle.value}.jsonl`)),
      attentionPort: attentionPort(),
      journal: new UiRuntimeJournal(journalPath),
    }),
    (error: unknown) => error instanceof RuntimeTaskControlError
      && error.code === 'journal.corrupt'
      && error.message.includes('operation-cross-link'),
  );
});

test('task snapshot keeps the stored directive instead of substituting the execution input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-directive-'));
  const coordinator = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `task-${task.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
  });
  const task = coordinator.createTask({ title: 'directive title', directive: 'directive objective' });

  coordinator.updateTask(task.taskId, { title: 'renamed title' });
  assert.equal(coordinator.taskSnapshot(task.taskId).directiveRevision, 1);

  assert.equal(coordinator.taskSnapshot(task.taskId).directive, 'directive objective');
  assert.equal(coordinator.taskSnapshot(task.taskId).directiveRevision, 1);
  assert.equal(coordinator.taskSnapshot(task.taskId).input, '');

  const restarted = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (taskId, cycle) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
  });
  assert.equal(restarted.taskSnapshot(task.taskId).directive, 'directive objective');
});

test('task CRUD journal records replay and do not mutate live state when append fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-task-crud-journal-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const journal = new UiRuntimeJournal(journalPath);
  const coordinator = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `task-${task.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal,
  });
  const task = coordinator.createTask({ title: 'before edit', directive: 'before directive' });
  coordinator.updateTask(task.taskId, { title: 'after edit', directive: 'after directive' });
  const afterUpdate = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (taskId, cycle) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: new UiRuntimeJournal(journalPath),
  });
  assert.equal(afterUpdate.taskSnapshot(task.taskId).title, 'after edit');
  assert.equal(afterUpdate.taskSnapshot(task.taskId).directiveRevision, 2);
  afterUpdate.deleteTask(task.taskId);
  const afterDelete = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (taskId, cycle) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: new UiRuntimeJournal(journalPath),
  });
  assert.deepEqual(afterDelete.taskSnapshots(), []);

  let appendCount = 0;
  const failingRecords: RuntimeTaskJournalRecord[] = [];
  const failingJournal = {
    append(record: RuntimeTaskJournalRecord): void {
      appendCount += 1;
      if (appendCount > 1) throw new Error('forced journal append failure');
      failingRecords.push(record);
    },
    replay(): readonly RuntimeTaskJournalRecord[] { return failingRecords; },
  };
  const guarded = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (taskId, cycle) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: failingJournal,
  });
  const guardedTask = guarded.createTask({ title: 'stable title', directive: 'stable directive' });
  assert.throws(() => guarded.updateTask(guardedTask.taskId, { title: 'uncommitted title' }), /forced journal append failure/);
  assert.equal(guarded.taskSnapshot(guardedTask.taskId).title, 'stable title');
  assert.throws(() => guarded.deleteTask(guardedTask.taskId), /forced journal append failure/);
  assert.equal(guarded.taskSnapshots().length, 1);
  await rm(root, { recursive: true, force: true });
});

test('journal replay preserves the confirmed requirement orchestration mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-orchestration-replay-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const journal = new UiRuntimeJournal(journalPath);
  const coordinator = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `task-${task.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal,
  });
  const task = coordinator.createTask({ title: 'orchestrated task', directive: 'confirmed requirement' });
  const operationId = id('operation', 'ui-operation-orchestration-replay');
  const cycleId = id('cycle', 'ui-cycle-orchestration-replay');
  journal.append({
    kind: 'operation.started',
    operationId,
    taskId: task.taskId,
    cycleId,
    scope: { organId, taskId: task.taskId, cycleId, operationId },
    executionEpoch: 1,
    operationCounter: 1,
    cycleCounter: 1,
    startedAt: '2026-09-20T00:00:00.000Z',
    input: 'confirmed requirement',
    orchestrated: true,
  });
  journal.append({
    kind: 'operation.event',
    operationId,
    event: {
      eventId: `${operationId.value}-1`,
      seq: 1,
      occurredAt: '2026-09-20T00:00:00.001Z',
      taskId: task.taskId,
      operationId: operationId.value,
      executionEpoch: 1,
      kind: 'execution.started',
      state: 'running',
      summary: 'execution started',
      evidenceRefs: [],
    },
  });

  const restarted = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (taskId, cycle) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: new UiRuntimeJournal(journalPath),
  });
  assert.equal(restarted.taskSnapshot(task.taskId).orchestrated, true);
  await rm(root, { recursive: true, force: true });
});

test('stop does not wait forever when orchestration fails before provider readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-orchestration-startup-failure-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal,
    closurePort: journal,
    memory: testMemory('project-ui-orchestration-startup-failure'),
    runtimeComposition: {
      createTaskAssembly() {
        throw new Error('orchestration assembly failed before provider readiness');
      },
    },
  });
  const task = service.createTask({ title: 'orchestration startup failure' });
  service.startExecution(task.taskId, { prompt: 'start orchestration', orchestrate: true });
  let stopError: unknown;
  let stopSettled = false;
  void service.stop(task.taskId).catch((error: unknown) => {
    stopError = error;
  }).finally(() => {
    stopSettled = true;
  });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));
  await waitFor(() => assert.equal(stopSettled, true));
  if (!(stopError instanceof UiRuntimeApiError)) throw new Error('expected stop to fail after orchestration startup failure');
  assert.equal(stopError.code, 'task.not.running');
  await rm(root, { recursive: true, force: true });
});

test('restart restores a failed task error owner and next action from the app journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-failure-restart-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const failing: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: async () => {
      throw new ProviderAdapterError({
        code: 'provider.unavailable',
        category: 'provider',
        phase: 'start',
        message: 'provider is unavailable',
        retryable: 'retryable',
        nextAction: { kind: 'recover', ref: 'provider-owner' },
      });
    },
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const first = serviceFor(root, failing);
  const task = first.createTask({ title: 'failure restart' });
  first.startExecution(task.taskId, { prompt: 'fail' });
  await waitFor(() => assert.equal(first.taskDashboard(task.taskId).state, 'failed'));
  assert.equal(first.taskDashboard(task.taskId).error?.ownerId, 'humanagent.provider-adapter');

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await second.hydrate();
  const restored = second.taskDashboard(task.taskId);
  assert.equal(restored.state, 'failed');
  assert.equal(restored.error?.code, 'provider.unavailable');
  assert.equal(restored.error?.ownerId, 'humanagent.provider-adapter');
  assert.match(restored.error?.nextAction ?? '', /provider-owner/);
});

test('restart projects an orphaned running execution as blocked instead of pretending it still has a live handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-orphan-'));
  const base = new FakeReplayExecutionRuntimePort({ binding });
  const hanging: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: async function* observe() {
      await new Promise<void>(() => {});
    },
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const first = serviceFor(root, hanging);
  const task = first.createTask({ title: 'orphaned execution' });
  const started = first.startExecution(task.taskId, { prompt: 'leave this running' });
  assert.equal(first.taskDashboard(task.taskId).state, 'running');
  assert.equal(first.eventsSince(started.operationId).length, 1);

  const restarted = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await restarted.hydrate();
  const dashboard = restarted.taskDashboard(task.taskId);
  assert.equal(dashboard.state, 'blocked');
  assert.deepEqual(dashboard.allowedActions, []);
  const waiting = restarted.listTasks().waiting.find((row) => row.taskId.value === task.taskId.value);
  assert.ok(waiting?.currentState.match(/进程已重启或缺少终态 checkpoint/));
  assert.deepEqual(restarted.eventsSince(started.operationId).map((event) => event.kind), ['execution.started']);
});

test('one completed task does not close the shared provider while another task is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-concurrent-'));
  const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 60 });
  const service = serviceFor(root, port);
  const first = service.createTask({ title: 'first concurrent task' });
  const second = service.createTask({ title: 'second concurrent task' });

  service.startExecution(first.taskId, { prompt: 'first' });
  service.startExecution(second.taskId, { prompt: 'second' });
  await waitFor(() => assert.equal(service.taskDashboard(first.taskId).state, 'succeeded'));
  await waitFor(() => assert.equal(service.taskDashboard(second.taskId).state, 'succeeded'));

  assert.equal(service.taskDashboard(first.taskId).error, undefined);
  assert.equal(service.taskDashboard(second.taskId).error, undefined);
});

test('stopping one task does not close the shared provider while another task is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-concurrent-stop-'));
  const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 80 });
  const service = serviceFor(root, port);
  const stoppedTask = service.createTask({ title: 'stop concurrent task' });
  const continuingTask = service.createTask({ title: 'continue concurrent task' });

  service.startExecution(stoppedTask.taskId, { prompt: 'stop this task' });
  service.startExecution(continuingTask.taskId, { prompt: 'finish this task' });
  const stopped = await service.stop(stoppedTask.taskId);
  assert.equal(stopped.state, 'stopped');
  await waitFor(() => assert.equal(service.taskDashboard(continuingTask.taskId).state, 'succeeded'));

  assert.equal(service.taskDashboard(stoppedTask.taskId).error, undefined);
  assert.equal(service.taskDashboard(continuingTask.taskId).error, undefined);
});

test('second execution starts a new checkpoint cycle for the same task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-second-cycle-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const task = service.createTask({ title: 'second cycle' });

  const first = service.startExecution(task.taskId, { prompt: 'first cycle' });
  assert.equal(first.executionEpoch, 1);
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const second = service.startExecution(task.taskId, { prompt: 'second cycle' });
  assert.equal(second.executionEpoch, 2);
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.error, undefined);
  assert.equal(dashboard.checkpoint?.seq, 1);
});

test('stop goes through the formal stop operation and only reports stopped after a stopped checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 40 }));
  const task = service.createTask({ title: 'stop lifecycle' });
  const started = service.startExecution(task.taskId, { prompt: 'stop this execution' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  const result = await service.stop(task.taskId);
  assert.equal(result.state, 'stopped');

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.state, 'stopped');
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.equal(dashboard.error, undefined);
  assert.deepEqual(dashboard.allowedActions, ['start']);

  const events = service.eventsSince(started.operationId);
  const settlingIndex = events.findIndex((event) => event.kind === 'execution.settling');
  const checkpointIndex = events.findIndex((event) => event.kind === 'checkpoint.committed' && event.state === 'stopped');
  const terminalIndex = events.findIndex((event) => event.kind === 'execution.terminal' && event.state === 'stopped');
  assert.ok(settlingIndex >= 0);
  assert.ok(checkpointIndex > settlingIndex);
  assert.ok(terminalIndex > checkpointIndex);

  const journal = await readFile(join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`), 'utf8');
  assert.match(journal, /"outcome":"stopped"/);
});

test('a stopped task remains stopped after restart hydration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stopped-restart-'));
  const first = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 40 }));
  const task = first.createTask({ title: 'stopped restart' });
  first.startExecution(task.taskId, { prompt: 'stop before restart' });
  assert.equal((await first.stop(task.taskId)).state, 'stopped');

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await second.hydrate();
  const dashboard = second.taskDashboard(task.taskId);
  assert.equal(dashboard.state, 'stopped');
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.deepEqual(dashboard.allowedActions, ['start']);
});

test('a failed tool execution releases the provider session and reports the real failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-abandoned-tool-'));
  const port = new AbandonedToolExecutionPort();
  const runtimeJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'rcc',
    organId,
    binding,
    port,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    journal: runtimeJournal,
    closurePort: runtimeJournal,
    memory: testMemory('project-ui-abandoned-tool'),
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    providerTools: [RESPONSES_FILE_READ_TOOL],
    providerToolExecutor: {
      async execute() {
        throw new Error('EISDIR: illegal operation on a directory, read');
      },
    },
  });
  const task = service.createTask({ title: 'failed tool execution' });
  const started = service.startExecution(task.taskId, { prompt: 'read the directory' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));

  const dashboard = service.taskDashboard(task.taskId);
  // The real tool failure owns the task terminal state; resource cleanup must
  // not disguise it as a stop or as a provider-close failure.
  assert.equal(dashboard.error?.message, 'EISDIR: illegal operation on a directory, read');
  assert.equal(dashboard.error?.cleanupError, undefined);
  assert.deepEqual(dashboard.allowedActions, ['start']);
  assert.deepEqual(port.settleStates, ['blocked', 'stopped']);
  assert.equal(port.closeCalls, 1);

  const events = service.eventsSince(started.operationId);
  assert.equal(events.some((event) => event.state === 'blocked'), false);
  assert.equal(
    events.some((event) => event.kind === 'provider.error' && event.summary.includes('close.pending.executions')),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === 'execution.terminal' && event.state === 'failed' && event.terminalPhase === 'final'),
    true,
  );

  const checkpointJournal = await readFile(join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`), 'utf8');
  const checkpoints = checkpointJournal.trim().split('\n').map((line) => JSON.parse(line) as { readonly checkpoint: Checkpoint });
  assert.deepEqual(checkpoints.map((record) => record.checkpoint.outcome), ['stopped', 'failed']);
  assert.equal(checkpoints[1]?.checkpoint.previousCheckpointId?.value, checkpoints[0]?.checkpoint.id.value);
  // The failure checkpoint follows a stop checkpoint, so it must keep the same
  // operation identity and every evidence reference must share that scope.
  assert.equal(checkpoints[1]?.checkpoint.scope.operationId?.value, started.operationId.value);
  for (const record of checkpoints) {
    for (const evidenceRef of record.checkpoint.evidenceRefs) {
      assert.deepEqual(evidenceRef.scope, record.checkpoint.scope);
    }
    assert.deepEqual(record.checkpoint.recoveryStateRef.scope, record.checkpoint.scope);
  }
});

test('failure cleanup does not report a clean failure while the shared provider was retained for another execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-retained-cleanup-'));
  const port = new AbandonedToolExecutionPort();
  port.failStop = true;
  // Hold the unrelated execution open so closeForExecution sees an active
  // execution and returns retained=true without closing the shared provider.
  port.hold('retained-cleanup-other');
  const service = new UiRuntimeService({
    mode: 'rcc',
    organId,
    binding,
    port,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    closurePort: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    memory: testMemory('project-ui-retained-cleanup'),
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    providerTools: [RESPONSES_FILE_READ_TOOL],
    providerToolExecutor: {
      async execute() {
        throw new Error('EISDIR: illegal operation on a directory, read');
      },
    },
  });
  const other = service.createTask({ title: 'retained cleanup other' });
  port.hold(other.taskId.value);
  service.startExecution(other.taskId, { prompt: 'stay running' });
  // The other execution stays active, which is what makes the failed task's
  // close see a retained shared provider.
  await waitFor(() => assert.equal(service.taskDashboard(other.taskId).state, 'running'));

  const task = service.createTask({ title: 'retained cleanup failure' });
  service.startExecution(task.taskId, { prompt: 'read the directory' });

  // The stop could not release the abandoned provider execution and the shared
  // provider was retained, so the task must stay blocked with retry-stop
  // instead of being reported as a clean failure.
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'blocked'), 5000);
  // The blocked state is projected before the blocked checkpoint is committed,
  // so wait for the durable checkpoint before asserting or tearing down.
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, 'blocked'), 5000);
  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.error?.message, 'EISDIR: illegal operation on a directory, read');
  assert.ok(dashboard.error?.cleanupError, 'the unresolved cleanup must remain attached to the task error');
  assert.equal(dashboard.error?.cleanupError?.code, 'stop.failed');
  assert.deepEqual(dashboard.allowedActions, ['retry-stop']);
  // The retained execution is still the reason the provider was never closed.
  assert.equal(service.taskDashboard(other.taskId).state, 'running');
  assert.equal(port.closeCalls, 0);

  // The other execution stays suspended, so no further journal writes race the
  // teardown of the temp directory.
  await rm(root, { recursive: true, force: true });
});

test('stop racing a startup failure leaves a terminal failed task instead of retry-stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-startup-stop-race-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const failing: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new ProviderAdapterError({
        code: 'provider.unavailable',
        category: 'provider',
        phase: 'start',
        message: 'provider start failed before submit',
        retryable: 'retryable',
        nextAction: { kind: 'recover', ref: 'provider-owner' },
      });
    },
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, failing);
  const task = service.createTask({ title: 'startup failure during stop' });
  const started = service.startExecution(task.taskId, { prompt: 'fail while stopping' });

  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.running',
  );
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));
  assert.deepEqual(service.taskDashboard(task.taskId).allowedActions, ['start']);
  assert.equal(service.eventsSince(started.operationId).some((event) => event.state === 'blocked'), false);
});

test('driver construction failure releases startup waiters and leaves the task terminally failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-driver-factory-'));
  const coordinator = new RuntimeTaskCoordinator({
    organId,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    createDriver: () => {
      throw new Error('driver assembly failed');
    },
  });
  const task = coordinator.createTask({ title: 'driver factory failure' });
  const started = coordinator.startExecution(task.taskId, { prompt: 'construct driver' });

  await waitFor(() => assert.equal(coordinator.taskSnapshot(task.taskId).state, 'failed'));
  const dashboard = coordinator.taskSnapshot(task.taskId);
  assert.equal(dashboard.error?.ownerId, 'humanagent.runtime');
  assert.equal(dashboard.error?.message, 'driver assembly failed');
  assert.deepEqual(dashboard.allowedActions, ['start']);
  await assert.rejects(
    () => coordinator.stop(task.taskId),
    (error: unknown) => error instanceof RuntimeTaskControlError && error.code === 'task.not.running',
  );
  assert.deepEqual(coordinator.eventsSince(started.operationId).map((event) => event.kind), [
    'execution.started',
    'provider.error',
    'checkpoint.committed',
    'execution.terminal',
  ]);
  assert.equal(coordinator.taskSnapshot(task.taskId).checkpoint?.outcome, 'failed');
});

test('restart hydration rejects a checkpoint copied under another task scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-checkpoint-scope-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const failing: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: async () => {
      throw new ProviderAdapterError({
        code: 'provider.unavailable',
        category: 'provider',
        phase: 'start',
        message: 'provider is unavailable',
        nextAction: { kind: 'recover', ref: 'provider-owner' },
      });
    },
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const first = serviceFor(root, failing);
  const failedTask = first.createTask({ title: 'failed source' });
  first.startExecution(failedTask.taskId, { prompt: 'fail source' });
  await waitFor(() => assert.equal(first.taskDashboard(failedTask.taskId).state, 'failed'));
  const failedCheckpointFile = join(root, `task-${failedTask.taskId.value}-cycle-ui-cycle-1.jsonl`);

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await second.hydrate();
  const targetTask = second.createTask({ title: 'scope mismatch target' });
  second.startExecution(targetTask.taskId, { prompt: 'succeed target' });
  await waitFor(() => assert.equal(second.taskDashboard(targetTask.taskId).state, 'succeeded'));
  const targetCheckpointFile = join(root, `task-${targetTask.taskId.value}-cycle-ui-cycle-2.jsonl`);
  await writeFile(targetCheckpointFile, await readFile(failedCheckpointFile, 'utf8'), 'utf8');

  const restarted = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await restarted.hydrate();
  assert.equal(restarted.taskDashboard(targetTask.taskId).state, 'blocked');
});

test('checkpoint latest reads prefer exact operation chains and fall back to business checkpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-checkpoint-operation-scope-'));
  const store = new FileCheckpointStore(join(root, 'checkpoints.jsonl'));
  const taskId = id('task', 'shared-task');
  const cycleId = id('cycle', 'shared-cycle');
  const businessScope: ScopeRef = {
    organId,
    taskId,
    cycleId,
  };
  const scopeA: ScopeRef = {
    organId,
    taskId,
    cycleId,
    operationId: id('operation', 'operation-a'),
  };
  const scopeB: ScopeRef = {
    organId,
    taskId,
    cycleId,
    operationId: id('operation', 'operation-b'),
  };

  const checkpoint = (
    scope: ScopeRef,
    seq: number,
    previousCheckpointId: Checkpoint['previousCheckpointId'],
  ): Checkpoint => {
    const label = scope.operationId?.value ?? 'business';
    return {
      id: id('checkpoint', `${label}-${seq}`),
      scope,
      cycleId,
      seq,
      previousCheckpointId,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'succeeded',
      summary: `${label} checkpoint ${seq}`,
      recoveryStateRef: evidence(`${label}-${seq}-recovery`, scope),
      evidenceRefs: [evidence(`${label}-${seq}-completion`, scope)],
      next: { kind: 'continue', ref: 'retry-closure' },
    };
  };

  const checkpointA1 = checkpoint(scopeA, 1, null);
  const checkpointB1 = checkpoint(scopeB, 1, null);
  const checkpointA2 = checkpoint(scopeA, 2, checkpointA1.id);
  const business1 = checkpoint(businessScope, 1, null);
  const business2 = checkpoint(businessScope, 2, business1.id);
  const checkpointB2 = checkpoint(scopeB, 2, checkpointB1.id);
  await appendCheckpoint(store, checkpointA1);
  await appendCheckpoint(store, checkpointB1);
  await appendCheckpoint(store, checkpointA2);
  await appendCheckpoint(store, business1);
  await appendCheckpoint(store, business2);
  await appendCheckpoint(store, checkpointB2);

  const retryReadA = await store.readLatest(scopeA);
  assert.equal(retryReadA?.checkpoint.id.value, checkpointA2.id.value);
  assert.equal(retryReadA?.previous?.id.value, checkpointA1.id.value);

  const retryReadB = await store.readLatest(scopeB);
  assert.equal(retryReadB?.checkpoint.id.value, checkpointB2.id.value);
  assert.equal(retryReadB?.previous?.id.value, checkpointB1.id.value);

  const businessRead = await store.readLatest(businessScope);
  assert.equal(businessRead?.checkpoint.id.value, business2.id.value);
  assert.equal(businessRead?.previous?.id.value, business1.id.value);

  const missingOperationRead = await store.readLatest({
    organId,
    taskId,
    cycleId,
    operationId: id('operation', 'operation-missing'),
  });
  assert.equal(missingOperationRead?.checkpoint.id.value, business2.id.value);
  assert.equal(missingOperationRead?.previous?.id.value, business1.id.value);
});

test('hydration restores a business predecessor for an operation-scoped stopped checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-checkpoint-stopped-predecessor-'));
  const taskId = id('task', 'ui-task-checkpoint-hydrate-1');
  const cycleId = id('cycle', 'ui-cycle-1');
  const operationId = id('operation', 'ui-operation-1');
  const businessScope: ScopeRef = {
    organId,
    taskId,
    cycleId,
  };
  const operationScope: ScopeRef = {
    organId,
    taskId,
    cycleId,
    operationId,
  };
  const businessCheckpoint: Checkpoint = {
    id: id('checkpoint', 'hydrate-business-1'),
    scope: businessScope,
    cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'succeeded',
    summary: 'business checkpoint before stop',
    recoveryStateRef: evidence('hydrate-business-recovery', businessScope),
    evidenceRefs: [evidence('hydrate-business-evidence', businessScope)],
    next: { kind: 'continue', ref: 'task://hydrate/next' },
  };
  const stoppedCheckpoint: Checkpoint = {
    id: id('checkpoint', 'hydrate-stopped-1'),
    scope: operationScope,
    cycleId,
    seq: 2,
    previousCheckpointId: businessCheckpoint.id,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'stopped',
    summary: 'stopped checkpoint with business predecessor',
    recoveryStateRef: evidence('hydrate-stopped-recovery', operationScope),
    evidenceRefs: [evidence('hydrate-stopped-evidence', operationScope)],
    next: { kind: 'stop', ref: 'operator-stop' },
  };
  const checkpointFile = join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`);
  const store = new FileCheckpointStore(checkpointFile);
  await appendCheckpoint(store, businessCheckpoint);
  await appendCheckpoint(store, stoppedCheckpoint);

  const latest = await store.readLatest(operationScope);
  if (!latest) throw new Error('expected latest operation-scoped stopped checkpoint');
  assert.equal(latest.checkpoint.id.value, stoppedCheckpoint.id.value);
  assert.equal(latest.previous?.id.value, businessCheckpoint.id.value);
  assert.equal(latest.previous?.scope.operationId, undefined);

  const createdAt = '2026-01-01T00:00:00.000Z';
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  await writeFile(journalPath, `${[
    JSON.stringify({
      kind: 'task.created',
      taskId,
      title: 'hydrate stopped predecessor',
      directive: 'hydrate stopped predecessor',
      directiveRevision: 1,
      createdAt,
      taskCounter: 1,
    }),
    JSON.stringify({
      kind: 'operation.started',
      operationId,
      taskId,
      cycleId,
      scope: operationScope,
      executionEpoch: 1,
      operationCounter: 1,
      cycleCounter: 1,
      startedAt: createdAt,
      input: 'hydrate stopped predecessor',
    }),
    JSON.stringify({
      kind: 'operation.event',
      operationId,
      event: {
        eventId: `${operationId.value}-1`,
        seq: 1,
        occurredAt: createdAt,
        taskId,
        operationId: operationId.value,
        executionEpoch: 1,
        kind: 'execution.started',
        state: 'running',
        summary: 'execution started',
        evidenceRefs: [],
      },
    }),
  ].join('\n')}\n`, 'utf8');

  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    new UiRuntimeJournal(journalPath),
  );
  await service.hydrate();
  const dashboard = service.taskDashboard(taskId);
  assert.equal(dashboard.state, 'stopped');
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.equal(dashboard.checkpoint?.checkpointId, stoppedCheckpoint.id.value);
});

test('stop during provider observation keeps the stopped projection free of late errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-observed-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 60 }));
  const task = service.createTask({ title: 'stop during observation' });
  const started = service.startExecution(task.taskId, { prompt: 'observe before stop' });

  await waitFor(() => assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'provider.model'), true));
  const result = await service.stop(task.taskId);
  assert.equal(result.state, 'stopped');
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'stopped'));

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.equal(dashboard.error, undefined);
  assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'provider.error' && event.state === 'failed'), false);
});

test('stop immediately after start waits for provider readiness and settles through stop control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-startup-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 40 }));
  const task = service.createTask({ title: 'immediate stop' });
  const started = service.startExecution(task.taskId, { prompt: 'stop before first event' });

  const result = await service.stop(task.taskId);
  assert.equal(result.state, 'stopped');
  assert.equal(service.taskDashboard(task.taskId).state, 'stopped');
  assert.equal(service.taskDashboard(task.taskId).error, undefined);
  assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'checkpoint.committed' && event.state === 'stopped'), true);
});

test('SSE replay honors Last-Event-ID without returning already delivered events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-replay-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const task = service.createTask({ title: 'replay lifecycle' });
  const started = service.startExecution(task.taskId, { prompt: 'replay' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const all = service.eventsSince(started.operationId);
  assert.ok(all.length > 2);
  const replay = service.eventsSince(started.operationId, all[1]!.eventId);
  assert.deepEqual(replay.map((event) => event.eventId), all.slice(2).map((event) => event.eventId));
  assert.deepEqual(service.eventsSince(started.operationId, 'unknown-event'), all);
});

test('ui runtime server refuses to bind the unauthenticated control API outside loopback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-host-guard-'));
  await assert.rejects(async () => {
    await startUiRuntime({
      mode: 'fake',
      organId,
      binding,
      port: buildFakeExecutionPort(binding),
      checkpointRoot: join(root, 'checkpoints'),
      evidenceRoot: join(root, 'evidence'),
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      providerState: 'ready',
      host: '0.0.0.0',
      portNumber: 0,
      memory: testMemory('project-ui-host-guard'),
    });
  }, /loopback/);
});

test('ui runtime server formats IPv6 loopback URLs with brackets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-ipv6-host-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    host: '::1',
    portNumber: 0,
    memory: testMemory('project-ui-ipv6'),
  });
  try {
    assert.match(runtime.server.url, /^http:\/\/\[::1\]:\d+$/);
    const response = await fetch(`${runtime.server.url}/api/runtime/status`);
    assert.equal(response.status, 200);
  } finally {
    await runtime.server.close();
  }
});

test('task list styles keep the link contents inside the desktop task grid', async () => {
  const tasksCss = await readFile(join(process.cwd(), 'docs', 'ui', 'tasks.css'), 'utf8');

  const rule = (selector: string): string => {
    const match = tasksCss.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`, 's'));
    if (!match) throw new Error(`expected a ${selector} rule`);
    return match[0];
  };
  const row = rule('.task-row');
  const link = rule('.task-row-link');
  const head = rule('.task-row--head');

  // The runtime row is a three-track shell: checkbox, the multi-column link, actions.
  assert.match(row, /grid-template-columns:\s*var\(--task-columns\)/);
  assert.match(tasksCss, /--task-columns:\s*44px\s+minmax\(0,\s*1fr\)\s+auto;/);

  // The link spans that middle track and owns the eight data columns itself,
  // so the time cell never overflows onto an implicit second row.
  assert.match(link, /display:\s*grid;/);
  assert.match(link, /grid-column:\s*2;/);
  assert.match(
    link,
    /grid-template-columns:\s*minmax\(140px,\s*1\.5fr\)\s+minmax\(74px,\s*0\.5fr\)\s+minmax\(92px,\s*0\.85fr\)\s+minmax\(104px,\s*1fr\)\s+minmax\(132px,\s*1\.25fr\)\s+minmax\(58px,\s*0\.4fr\)\s+minmax\(104px,\s*0\.8fr\)\s+minmax\(96px,\s*0\.7fr\);/s,
  );

  // The header keeps the same nine tracks instead of inheriting the three-track shell.
  assert.match(head, /grid-template-columns:\s*44px/);
  assert.equal((head.match(/minmax\(/g) ?? []).length, 8);

  // The dense table is only safe once the viewport can actually fit the link's
  // minimum track sum plus the checkbox, actions, gaps, panel padding and page
  // margin. Derive that budget from the stylesheet so the breakpoint cannot be
  // lowered below it again (the 1081px regression this replaced).
  const trackMinima = [...(link.match(/minmax\((\d+)px/g) ?? [])].map((value) => Number(value.replace(/\D/g, '')));
  assert.equal(trackMinima.length, 8);
  const linkMin = trackMinima.reduce((total, value) => total + value, 0) + 7 * 12;

  const checkbox = Number(rule('.task-row-check').match(/width:\s*(\d+)px/)?.[1]);
  const actions = Number(rule('.task-row-actions').match(/min-width:\s*(\d+)px/)?.[1]);
  const panelPadding = 2 * Number(rule('.panel').match(/padding:\s*0\s+(\d+)px/)?.[1]);
  const pageMargin = Number(tasksCss.match(/width:\s*min\(1160px,\s*calc\(100%\s*-\s*(\d+)px\)\)/)?.[1]);
  const rowGaps = 2 * Number(tasksCss.match(/--task-gap:\s*\d+px\s+(\d+)px/)?.[1]);
  const requiredViewport = checkbox + linkMin + actions + rowGaps + panelPadding + pageMargin;

  const dense = tasksCss.match(/@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*\.task-cell--time\s*\{\s*grid-column:\s*8;/s);
  if (!dense) throw new Error('expected a dense breakpoint pinning .task-cell--time to grid-column 8');
  assert.ok(
    Number(dense[1]) >= requiredViewport,
    `dense breakpoint ${dense[1]}px is below the ${requiredViewport}px the link minimum needs`,
  );

  // The wrap branch must cover everything below the dense breakpoint and lay
  // the link out as wrapped tracks rather than the eight dense ones.
  const wrap = tasksCss.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{[\s\S]*?\.task-row-link\s*\{\s*grid-template-columns:\s*repeat\((\d+),/);
  if (!wrap) throw new Error('expected the wrap breakpoint to lay the link out as wrapped tracks');
  assert.equal(Number(wrap[1]), Number(dense[1]) - 1);
  assert.ok(Number(wrap[2]) < 8);
});

test('restart control endpoint accepts an owner-scoped request without becoming a task operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-restart-control-'));
  const received: Array<{ readonly leaseId: string; readonly generation: number }> = [];
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-restart-control'),
    restart: (input) => {
      received.push(input);
      return {
        requestId: 'restart-request-1',
        acceptedAt: '2026-09-21T00:00:00.000Z',
        ownerId: 'humanagent.app.serve',
        leaseId: input.leaseId,
        generation: input.generation,
        observerOnly: true,
      };
    },
  });
  try {
    const response = await fetch(`${runtime.server.url}/api/runtime/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: 'lease-1', generation: 7 }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      requestId: 'restart-request-1',
      acceptedAt: '2026-09-21T00:00:00.000Z',
      ownerId: 'humanagent.app.serve',
      leaseId: 'lease-1',
      generation: 7,
      observerOnly: true,
    });
    assert.deepEqual(received, [{ leaseId: 'lease-1', generation: 7 }]);
  } finally {
    await runtime.server.close();
  }
});

test('ui runtime server rejects static files that resolve outside the UI root through symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-static-root-'));
  const uiRoot = join(root, 'ui');
  await mkdir(uiRoot);
  const secret = join(root, 'secret.txt');
  await writeFile(secret, 'secret');
  await symlink(secret, join(uiRoot, 'leak.txt'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot,
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-static-root'),
  });
  try {
    const response = await fetch(`${runtime.server.url}/leak.txt`);
    assert.equal(response.status, 403);
  } finally {
    await runtime.server.close();
  }
});

test('unknown execution events return a typed JSON error without crashing the server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-sse-error-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-sse-error'),
  });
  try {
    const response = await fetch(`${runtime.server.url}/api/executions/unknown-operation/events`);
    assert.equal(response.status, 404);
    const body = await response.json() as { readonly error: { readonly code: string; readonly ownerId: string } };
    assert.equal(body.error.code, 'operation.not.found');
    assert.equal(body.error.ownerId, 'humanagent.runtime');

    const status = await fetch(`${runtime.server.url}/api/runtime/status`);
    assert.equal(status.status, 200);
  } finally {
    await runtime.server.close();
  }
});

test('runtime API rejects a mode mismatch and exposes dsh as disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-api-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-api'),
  });
  try {
    const status = await fetch(`${runtime.server.url}/api/runtime/status`);
    assert.equal(status.status, 200);
    const statusBody = await status.json() as { readonly mode: string; readonly modes: readonly { readonly mode: string; readonly state: string }[] };
    assert.equal(statusBody.mode, 'fake');
    assert.equal(statusBody.modes.find((mode) => mode.mode === 'dsh')?.state, 'disabled');

    const created = await fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'api task' }),
    });
    assert.equal(created.status, 201);
    const task = await created.json() as { readonly taskId: { readonly value: string } };

    const mismatch = await fetch(`${runtime.server.url}/api/tasks/${task.taskId.value}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'rcc', prompt: 'must not silently switch modes' }),
    });
    assert.equal(mismatch.status, 400);
    const mismatchBody = await mismatch.json() as { readonly error: { readonly code: string; readonly ownerId: string; readonly nextAction: string } };
    assert.equal(mismatchBody.error.code, 'execution.mode.mismatch');
    assert.equal(mismatchBody.error.ownerId, 'humanagent.app');
    assert.match(mismatchBody.error.nextAction, /restart/);
  } finally {
    await runtime.server.close();
  }
});

test('runtime API task detail uses the task-detail projection surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-task-detail-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-task-detail'),
  });
  try {
    const created = await fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'task detail surface' }),
    });
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    const detail = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}`);
    assert.equal(detail.status, 200);
    const taskId = id('task', task.taskId.value);
    runtime.service.startExecution(taskId, { prompt: 'typed task detail output' });
    await waitFor(() => assert.equal(runtime.service.taskDashboard(taskId).state, 'succeeded'));
    const completedDetail = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}`);
    assert.equal(completedDetail.status, 200);
    const body = await completedDetail.json() as {
      readonly surface: string;
      readonly taskId: { readonly value: string };
      readonly title: string;
      readonly output?: { readonly summary: string; readonly artifacts: readonly string[] };
    };
    assert.equal(body.surface, 'task-detail');
    assert.equal(body.taskId.value, task.taskId.value);
    assert.equal(body.title, 'task detail surface');
    assert.match(body.output?.summary ?? '', /fake replay:/);
    assert.deepEqual(body.output?.artifacts, []);
  } finally {
    await runtime.server.close();
  }
});

test('runtime task API supports update, delete, and grouped task actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-task-crud-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-task-crud'),
  });
  try {
    const created = await Promise.all([1, 2].map(() => fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'editable task', directive: 'initial directive' }),
    })));
    const tasks = await Promise.all(created.map(async (response) => await response.json() as { readonly taskId: { readonly value: string } }));
    const executedResponse = await fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'executed task', directive: 'executed directive' }),
    });
    const executed = await executedResponse.json() as { readonly taskId: { readonly value: string } };
    runtime.service.startExecution(id('task', executed.taskId.value), { prompt: 'complete before delete' });
    await waitFor(() => assert.equal(runtime.service.taskDashboard(id('task', executed.taskId.value)).state, 'succeeded'));
    const updated = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(tasks[0]!.taskId.value)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed task' }),
    });
    assert.equal(updated.status, 200);
    const detail = await updated.json() as { readonly title: string; readonly directive: string };
    assert.equal(detail.title, 'renamed task');
    assert.equal(detail.directive, 'initial directive');

    const stopped = await fetch(`${runtime.server.url}/api/tasks/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop', taskIds: [tasks[0]!.taskId.value] }),
    });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).results[0].state, 'failed');

    const deleted = await fetch(`${runtime.server.url}/api/tasks/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', taskIds: [...tasks.map((task) => task.taskId.value), executed.taskId.value] }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual((await deleted.json()).results.map((result: { readonly state: string }) => result.state), ['succeeded', 'succeeded', 'succeeded']);
    const listed = await fetch(`${runtime.server.url}/api/tasks`);
    assert.equal((await listed.json()).counts.total, 0);
    const restarted = await startUiRuntime({
      mode: 'fake',
      organId,
      binding,
      port: buildFakeExecutionPort(binding),
      checkpointRoot: join(root, 'checkpoints'),
      evidenceRoot: join(root, 'evidence'),
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      providerState: 'ready',
      portNumber: 0,
      memory: testMemory('project-ui-task-crud'),
    });
    try {
      const afterRestart = await fetch(`${restarted.server.url}/api/tasks`);
      assert.equal((await afterRestart.json()).counts.total, 0);
    } finally {
      await restarted.server.close();
    }
  } finally {
    await runtime.server.close();
  }
});

test('runtime HTTP API reconstructs task state and SSE replay after a server restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-http-restart-'));
  const checkpointRoot = join(root, 'checkpoints');
  const first = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 1),
    checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-http-restart-first'),
  });
  let taskId: string;
  let operationId: string;
  try {
    const created = await fetch(`${first.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'http restart task' }),
    });
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    taskId = task.taskId.value;
    const started = await fetch(`${first.server.url}/api/tasks/${encodeURIComponent(taskId)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'persist this' }),
    });
    const operation = await started.json() as { readonly operationId: string };
    operationId = operation.operationId;
    await waitFor(() => assert.equal(first.service.taskDashboard(id('task', taskId)).state, 'succeeded'));
  } finally {
    await first.server.close();
  }

  const second = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 1),
    checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-http-restart-second'),
  });
  try {
    const tasks = await fetch(`${second.server.url}/api/tasks`);
    const body = await tasks.json() as { readonly completed: readonly { readonly taskId: { readonly value: string }; readonly state: string }[] };
    assert.equal(body.completed.some((task) => task.taskId.value === taskId && task.state === 'succeeded'), true);

    const events = await fetch(`${second.server.url}/api/executions/${encodeURIComponent(operationId)}/events`);
    const text = await events.text();
    assert.match(text, /event: execution\.terminal/);
    assert.match(text, /event: checkpoint\.committed/);
  } finally {
    await second.server.close();
  }
});

test('HTTP SSE keeps the first connection open through settling, checkpoint, and final terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-http-sse-lifecycle-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 30),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-http-sse'),
  });
  try {
    const task = runtime.service.createTask({ title: 'http sse lifecycle' });
    const started = runtime.service.startExecution(task.taskId, { prompt: 'stream the full lifecycle' });
    const events = await fetch(`${runtime.server.url}/api/executions/${encodeURIComponent(started.operationId.value)}/events`);
    assert.equal(events.status, 200);
    const text = await events.text();
    const kinds = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(kinds.slice(-3), [
      'execution.settling',
      'checkpoint.committed',
      'execution.terminal',
    ]);
    const payloads = [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]!) as { readonly kind: string; readonly terminalPhase?: string });
    assert.equal(payloads.at(-1)?.kind, 'execution.terminal');
    assert.equal(payloads.at(-1)?.terminalPhase, 'final');
  } finally {
    await runtime.server.close();
  }
});

test('checkpoint committedAt binds to the checkpoint event instead of later terminal updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-checkpoint-time-'));
  let tick = 0;
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  );
  const task = service.createTask({ title: 'checkpoint timestamp' });
  const started = service.startExecution(task.taskId, { prompt: 'timestamp' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const events = service.eventsSince(started.operationId);
  const checkpointEvent = events.find((event) => event.kind === 'checkpoint.committed');
  const terminalEvent = events.at(-1);
  if (!checkpointEvent || !terminalEvent) throw new Error('expected checkpoint and terminal events');
  assert.equal(checkpointEvent.kind, 'checkpoint.committed');
  assert.equal(terminalEvent.kind, 'execution.terminal');
  assert.equal(checkpointEvent.occurredAt === terminalEvent.occurredAt, false);
  assert.equal(service.taskDashboard(task.taskId).checkpoint?.committedAt, checkpointEvent.occurredAt);
});

test('fake and rcc modes do not hydrate each other through a shared checkpoint root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-mode-isolation-'));
  const checkpointRoot = join(root, 'checkpoints');
  const fake = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 1),
    checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-mode-fake'),
  });
  try {
    const created = await fetch(`${fake.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'fake-only task' }),
    });
    assert.equal(created.status, 201);
  } finally {
    await fake.server.close();
  }

  const rcc = await startUiRuntime({
    mode: 'rcc',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 1),
    checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    portNumber: 0,
    memory: testMemory('project-ui-mode-rcc'),
  });
  try {
    const tasks = await fetch(`${rcc.server.url}/api/tasks`);
    const body = await tasks.json() as { readonly counts: { readonly total: number } };
    assert.equal(body.counts.total, 0);
  } finally {
    await rcc.server.close();
  }
});

test('rcc startup projects provider readiness failure instead of claiming ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-readiness-'));
  const base = new FakeReplayExecutionRuntimePort({ binding });
  const unavailable: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'dependency-missing',
      capabilityDigest: binding.capabilityDigest,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      evidenceRefs: [evidence('readiness-failure', { organId })],
      ownerId: 'humanagent.provider-adapter.rcc-v3',
      nextAction: { kind: 'recover', ref: 'rcc-v3.health' },
    }),
    capabilities: (value) => base.capabilities(value),
    start: (input) => base.start(input),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const runtime = await startUiRuntime({
    mode: 'rcc',
    organId,
    binding,
    port: unavailable,
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    portNumber: 0,
    memory: testMemory('project-ui-readiness'),
  });
  try {
    const status = await fetch(`${runtime.server.url}/api/runtime/status`);
    const body = await status.json() as {
      readonly state: string;
      readonly providerState: string;
      readonly providerError?: { readonly ownerId: string; readonly nextAction: string };
    };
    assert.equal(body.state, 'unavailable');
    assert.equal(body.providerState, 'dependency-missing');
    assert.equal(body.providerError?.ownerId, 'humanagent.provider-adapter.rcc-v3');
    assert.match(body.providerError?.nextAction ?? '', /rcc-v3\.health/);

    const created = await fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'must not start while unavailable' }),
    });
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    const start = await fetch(`${runtime.server.url}/api/tasks/${task.taskId.value}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'rcc', prompt: 'must not create an operation' }),
    });
    assert.equal(start.status, 409);
    const startBody = await start.json() as {
      readonly error: { readonly code: string; readonly ownerId: string; readonly nextAction: string };
    };
    assert.equal(startBody.error.code, 'provider.readiness.dependency-missing');
    assert.equal(startBody.error.ownerId, 'humanagent.provider-adapter.rcc-v3');
    assert.match(startBody.error.nextAction, /rcc-v3\.health/);

    const dashboard = await fetch(`${runtime.server.url}/api/tasks/${task.taskId.value}/dashboard`);
    const dashboardBody = await dashboard.json() as { readonly state: string; readonly operationId?: string };
    assert.equal(dashboardBody.state, 'created');
    assert.equal(dashboardBody.operationId, undefined);
  } finally {
    await runtime.server.close();
  }
});

test('provider failures are projected with owner, retryability, and next action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-error-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const failing: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: async () => {
      throw new ProviderAdapterError({
        code: 'provider.unavailable',
        category: 'provider',
        phase: 'start',
        message: 'provider is unavailable',
        retryable: 'retryable',
        nextAction: { kind: 'recover', ref: 'provider-owner' },
      });
    },
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, failing);
  const task = service.createTask({ title: 'failure lifecycle' });
  service.startExecution(task.taskId, { prompt: 'fail explicitly' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));
  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.error?.code, 'provider.unavailable');
  assert.equal(dashboard.error?.ownerId, 'humanagent.provider-adapter');
  assert.equal(dashboard.error?.retryable, true);
  assert.match(dashboard.error?.nextAction ?? '', /provider-owner/);
  assert.equal(service.dashboard().recentFailures[0]?.code, 'provider.unavailable');
  const journal = await readFile(join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`), 'utf8');
  assert.match(journal, /"outcome":"failed"/);
});

test('startExecution rejects a task that is not allowed to start after stop-control failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-start-guard-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 600 });
  const failingStop: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: async () => {
      throw new ProviderAdapterError({
        code: 'stop.failed',
        category: 'runtime',
        phase: 'stop',
        message: 'stop failed',
        nextAction: { kind: 'recover', ref: 'stop-owner' },
      });
    },
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, failingStop);
  const task = service.createTask({ title: 'start guard' });
  service.startExecution(task.taskId, { prompt: 'start guard' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  const stopResult = await service.stop(task.taskId);
  assert.equal(stopResult.state, 'settling');
  assert.equal(service.taskDashboard(task.taskId).state, 'settling');
  assert.deepEqual(service.taskDashboard(task.taskId).allowedActions, ['retry-stop']);
  const retryResult = await service.retryStop(task.taskId);
  assert.equal(retryResult.state, 'settling');
  assert.throws(
    () => service.deleteTask(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.busy',
  );
  assert.throws(
    () => service.startExecution(task.taskId, { prompt: 'should reject' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.busy',
  );
});

test('stop control rejects a second stop and preserves the original operation identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-race-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 100 }));
  const task = service.createTask({ title: 'stop race' });
  service.startExecution(task.taskId, { prompt: 'stop race' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  const first = await service.stop(task.taskId);
  assert.equal(first.state, 'stopped');
  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.running',
  );
});

test('ordinary settlement removes stop eligibility before awaiting provider settle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-settle-stop-race-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  let releaseSettle!: () => void;
  const settleGate = new Promise<void>((resolve) => {
    releaseSettle = resolve;
  });
  const delayedSettle: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: async (input) => {
      await settleGate;
      return base.settle(input);
    },
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, delayedSettle);
  const task = service.createTask({ title: 'settle stop race' });
  service.startExecution(task.taskId, { prompt: 'settle stop race' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'settling'));
  assert.deepEqual(service.taskDashboard(task.taskId).allowedActions, []);
  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.running',
  );
  releaseSettle();
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
});

test('UI admission and decoded-control core hooks gate the real execution entry', async () => {
  const admissionRoot = await mkdtemp(join(tmpdir(), 'humanagent-ui-admission-hook-'));
  let admissionStarts = 0;
  const admissionBase = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const admissionPort: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => admissionBase.probe(value),
    capabilities: (value) => admissionBase.capabilities(value),
    start: async (value) => {
      admissionStarts += 1;
      return admissionBase.start(value);
    },
    resume: (value) => admissionBase.resume(value),
    submit: (value) => admissionBase.submit(value),
    observe: (value) => admissionBase.observe(value),
    requestStop: (value) => admissionBase.requestStop(value),
    settle: (value) => admissionBase.settle(value),
    close: (value) => admissionBase.close(value),
  };
  const admissionHooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-admission-gate',
    version: '1',
    mode: 'core',
    stages: ['request.admitted'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['admission rejected'],
      ownerId: 'ui-admission-gate',
      nextAction: 'repair admission',
    }),
  }]);
  const admissionService = serviceFor(admissionRoot, admissionPort, 'fake', 'ready', undefined, undefined, admissionHooks);
  const admissionTask = admissionService.createTask({ title: 'admission gate' });
  const admissionStarted = admissionService.startExecution(admissionTask.taskId, { prompt: 'must not dispatch' });
  await waitFor(() => assert.equal(admissionService.taskDashboard(admissionTask.taskId).state, 'failed'));
  assert.equal(admissionStarts, 0);
  assert.equal(admissionService.taskDashboard(admissionTask.taskId).error?.ownerId, 'ui-admission-gate');
  assert.equal(admissionService.eventsSince(admissionStarted.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'succeeded'), false);

  const controlRoot = await mkdtemp(join(tmpdir(), 'humanagent-ui-control-hook-'));
  const controlHooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-control-gate',
    version: '1',
    mode: 'core',
    stages: ['control.decoded'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['decoded control rejected'],
      ownerId: 'ui-control-gate',
      nextAction: 'repair decoded control',
    }),
  }]);
  const controlService = serviceFor(
    controlRoot,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    controlHooks,
  );
  const controlTask = controlService.createTask({ title: 'control gate' });
  const controlStarted = controlService.startExecution(controlTask.taskId, { prompt: 'must not succeed' });
  await waitFor(() => assert.equal(controlService.taskDashboard(controlTask.taskId).state, 'failed'));
  assert.equal(controlService.taskDashboard(controlTask.taskId).error?.ownerId, 'ui-control-gate');
  assert.equal(controlService.eventsSince(controlStarted.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'succeeded'), false);
});

test('post-commit context hook failure preserves checkpoint identity and recovery after coordinator rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-context-commit-hook-'));
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['post-commit publication failed'],
      ownerId: 'ui-context-commit-gate',
      nextAction: 'reconcile committed checkpoint',
    }),
  }]);
  const failingService = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    hooks,
  );
  const task = failingService.createTask({ title: 'context commit recovery' });
  const started = failingService.startExecution(task.taskId, { prompt: 'commit once' });
  await waitFor(() => assert.equal(failingService.taskDashboard(task.taskId).state, 'blocked'));
  const failedDashboard = failingService.taskDashboard(task.taskId);
  if (!failedDashboard.checkpoint) throw new Error('expected durable checkpoint identity');
  assert.equal(failedDashboard.checkpoint.outcome, 'succeeded');
  assert.equal(failedDashboard.error?.ownerId, 'ui-context-commit-gate');
  assert.equal(failedDashboard.error?.nextAction, 'reconcile committed checkpoint');
  const checkpointPath = join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`);
  const checkpointJournal = await readFile(checkpointPath, 'utf8');
  assert.equal(checkpointJournal.trim().split('\n').length, 1);
  assert.match(checkpointJournal, new RegExp(`checkpoint-${task.taskId.value}-1`));

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.equal(recovered.checkpoint?.checkpointId, failedDashboard.checkpoint.checkpointId);
  assert.equal(recovered.checkpoint?.seq, failedDashboard.checkpoint.seq);
  assert.equal(recovered.error?.ownerId, 'ui-context-commit-gate');
  assert.equal(recovered.error?.nextAction, 'reconcile committed checkpoint');
  assert.equal(rebuilt.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'succeeded' && event.terminalPhase === 'final'), false);
});

test('UI checkpoint boundary publishes the committed journal digest and consumes one durable memory event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-boundary-success-'));
  const published: RuntimeCheckpointBoundary[] = [];
  const boundary: RuntimeCheckpointBoundaryPort = {
    publish: async (input) => {
      published.push(structuredClone(input));
    },
  };
  const runtimeJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal: runtimeJournal,
    closurePort: runtimeJournal,
    memory: {
      ...testMemory('project-ui-boundary-success'),
      checkpointBoundary: boundary,
    },
  });
  const task = service.createTask({ title: 'durable memory boundary' });
  service.startExecution(task.taskId, { prompt: 'complete once' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  assert.equal(published.length, 1);
  assert.equal(published[0]?.checkpoint.outcome, 'succeeded');
  assert.equal(typeof published[0]?.recordDigest, 'string');
  assert.equal(published[0]?.recordDigest?.startsWith('sha256:'), true);
  const journal = await readFile(
    join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`),
    'utf8',
  );
  const record = JSON.parse(journal.trim()) as { readonly recordDigest: string };
  assert.equal(published[0]?.recordDigest, record.recordDigest);
});

test('UI checkpoint boundary failure leaves the committed checkpoint explicitly blocked for recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-memory-boundary-failure-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal,
    closurePort: journal,
    memory: {
      ...testMemory('project-ui-boundary-failure'),
      checkpointBoundary: {
        publish: async () => {
          throw new Error('memory boundary publication failed');
        },
      },
    },
  });
  const task = service.createTask({ title: 'memory boundary recovery' });
  const started = service.startExecution(task.taskId, { prompt: 'commit once' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'blocked'));

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.checkpoint?.outcome, 'succeeded');
  assert.equal(dashboard.error?.message, 'memory boundary publication failed');
  assert.equal(dashboard.allowedActions.length, 0);
  assert.equal(
    service.eventsSince(started.operationId).some((event) =>
      event.kind === 'execution.terminal'
      && event.state === 'blocked'
      && event.terminalPhase === 'final'),
    true,
  );
  assert.deepEqual(service.deleteTask(task.taskId), { taskId: task.taskId.value, deleted: true });
  const checkpointJournal = await readFile(
    join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`),
    'utf8',
  );
  assert.equal(checkpointJournal.trim().split('\n').length, 1);
});

test('post-commit context hook failure keeps non-succeeded checkpoints blocked after coordinator rebuild', async () => {
  for (const checkpointOutcome of ['failed', 'blocked', 'waiting', 'cancelled', 'unknown'] as const) {
    const root = await mkdtemp(join(tmpdir(), `humanagent-ui-context-commit-${checkpointOutcome}-`));
    const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
      hookId: 'ui-context-commit-gate',
      version: '1',
      mode: 'core',
      stages: ['context.committed'],
      onEnter: async () => ({
        status: 'failed' as const,
        diagnostics: ['post-commit publication failed'],
        ownerId: 'ui-context-commit-gate',
        nextAction: 'reconcile committed checkpoint',
      }),
    }]);
    const failingService = serviceFor(
      root,
      new FakeReplayExecutionRuntimePort({
        binding,
        stepDelayMs: 1,
        replay: [
          { kind: 'terminal', state: checkpointOutcome, summary: `execution ${checkpointOutcome}`, terminalState: checkpointOutcome },
        ],
      }),
      'fake',
      'ready',
      undefined,
      undefined,
      hooks,
    );
    const task = failingService.createTask({ title: `context commit recovery ${checkpointOutcome}` });
    const started = failingService.startExecution(task.taskId, { prompt: `commit ${checkpointOutcome}` });
    await waitFor(() => assert.equal(failingService.taskDashboard(task.taskId).state, 'blocked'));
    const failedDashboard = failingService.taskDashboard(task.taskId);
    if (!failedDashboard.checkpoint) throw new Error(`expected durable ${checkpointOutcome} checkpoint identity`);
    assert.equal(failedDashboard.checkpoint.outcome, checkpointOutcome);
    assert.equal(failedDashboard.error?.ownerId, 'ui-context-commit-gate');
    assert.equal(failedDashboard.error?.nextAction, 'reconcile committed checkpoint');

    const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
    await rebuilt.hydrate();
    const recovered = rebuilt.taskDashboard(task.taskId);
    assert.equal(recovered.state, 'blocked');
    assert.equal(recovered.checkpoint?.checkpointId, failedDashboard.checkpoint.checkpointId);
    assert.equal(recovered.checkpoint?.seq, failedDashboard.checkpoint.seq);
    assert.equal(recovered.checkpoint?.outcome, checkpointOutcome);
    assert.equal(recovered.error?.ownerId, 'ui-context-commit-gate');
    assert.equal(recovered.error?.nextAction, 'reconcile committed checkpoint');
    assert.deepEqual(recovered.allowedActions, []);
    assert.throws(
      () => rebuilt.startExecution(task.taskId, { prompt: 'must remain blocked' }),
      (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
    );
    assert.equal(
      rebuilt.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'blocked' && event.terminalPhase === 'final'),
      true,
    );
  }
});

test('post-commit context hook failure with provider close failure preserves hook recovery after coordinator rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-context-commit-close-failure-'));
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['post-commit publication failed'],
      ownerId: 'ui-context-commit-gate',
      nextAction: 'reconcile committed checkpoint',
    }),
  }]);
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const closeFailure: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (value) => base.resume(value),
    submit: (value) => base.submit(value),
    observe: (value) => base.observe(value),
    requestStop: (value) => base.requestStop(value),
    settle: (value) => base.settle(value),
    close: async () => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'failed',
      evidenceRefs: [evidence('provider-close-failure', { organId })],
      ownerId: 'ui-provider-close-owner',
      nextAction: { kind: 'recover', ref: 'provider-close-recovery' },
    }),
  };
  const failingService = serviceFor(root, closeFailure, 'fake', 'ready', undefined, undefined, hooks);
  const task = failingService.createTask({ title: 'context commit close recovery' });
  const started = failingService.startExecution(task.taskId, { prompt: 'commit once with close failure' });
  await waitFor(() => assert.equal(failingService.taskDashboard(task.taskId).state, 'blocked'));
  const failedDashboard = failingService.taskDashboard(task.taskId);
  if (!failedDashboard.checkpoint) throw new Error('expected durable checkpoint identity');
  assert.equal(failedDashboard.checkpoint.outcome, 'succeeded');
  assert.equal(failedDashboard.error?.code, 'execution.context-commit-hook.blocked');
  assert.equal(failedDashboard.error?.ownerId, 'ui-context-commit-gate');
  assert.equal(failedDashboard.error?.nextAction, 'reconcile committed checkpoint');
  assert.equal(failedDashboard.error?.cleanupError?.code, 'provider.close.failed');
  assert.equal(failedDashboard.error?.cleanupError?.ownerId, 'ui-provider-close-owner');
  assert.equal(failedDashboard.error?.cleanupError?.evidenceRefs?.[0]?.locator, 'test://provider-close-failure');
  const failureJournal = await readFile(join(root, 'ui-runtime-journal.jsonl'), 'utf8');
  assert.match(failureJournal, /"cleanupError":\{"code":"provider\.close\.failed","ownerId":"ui-provider-close-owner"/);
  assert.match(failureJournal, /ui-test-provider-close-failure/);

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.equal(recovered.checkpoint?.checkpointId, failedDashboard.checkpoint.checkpointId);
  assert.equal(recovered.checkpoint?.seq, failedDashboard.checkpoint.seq);
  assert.equal(recovered.checkpoint?.outcome, 'succeeded');
  assert.equal(recovered.error?.code, 'execution.context-commit-hook.blocked');
  assert.equal(recovered.error?.ownerId, 'ui-context-commit-gate');
  assert.equal(recovered.error?.nextAction, 'reconcile committed checkpoint');
  assert.deepEqual(recovered.allowedActions, []);
  assert.throws(
    () => rebuilt.startExecution(task.taskId, { prompt: 'must remain blocked' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
  );
  assert.equal(
    rebuilt.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'blocked' && event.terminalPhase === 'final'),
    true,
  );
});

test('formal stop with committed stopped checkpoint and context hook failure stays blocked after coordinator rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-context-commit-'));
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-stop-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['stopped checkpoint publication failed'],
      ownerId: 'ui-stop-context-commit-gate',
      nextAction: 'reconcile stopped checkpoint',
    }),
  }]);
  const stopBase = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 40 });
  let closeCalls = 0;
  const stopDriver: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => stopBase.probe(value),
    capabilities: (value) => stopBase.capabilities(value),
    start: (value) => stopBase.start(value),
    resume: (value) => stopBase.resume(value),
    submit: (value) => stopBase.submit(value),
    observe: (value) => stopBase.observe(value),
    requestStop: (value) => stopBase.requestStop(value),
    settle: (value) => stopBase.settle(value),
    close: async (value) => {
      closeCalls += 1;
      return stopBase.close(value);
    },
  };
  const service = serviceFor(
    root,
    stopDriver,
    'fake',
    'ready',
    undefined,
    undefined,
    hooks,
  );
  const task = service.createTask({ title: 'formal stop context recovery' });
  const started = service.startExecution(task.taskId, { prompt: 'stop with post-commit hook failure' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'execution.context-commit-hook.blocked',
  );
  const failedDashboard = service.taskDashboard(task.taskId);
  if (!failedDashboard.checkpoint) throw new Error('expected durable stopped checkpoint identity');
  assert.equal(failedDashboard.state, 'blocked');
  assert.equal(failedDashboard.checkpoint.outcome, 'stopped');
  assert.equal(failedDashboard.error?.code, 'execution.context-commit-hook.blocked');
  assert.equal(failedDashboard.error?.ownerId, 'ui-stop-context-commit-gate');
  assert.equal(failedDashboard.error?.nextAction, 'reconcile stopped checkpoint');
  assert.deepEqual(failedDashboard.allowedActions, []);
  assert.equal(closeCalls, 1);

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.equal(recovered.checkpoint?.checkpointId, failedDashboard.checkpoint.checkpointId);
  assert.equal(recovered.checkpoint?.seq, failedDashboard.checkpoint.seq);
  assert.equal(recovered.checkpoint?.outcome, 'stopped');
  assert.equal(recovered.error?.code, 'execution.context-commit-hook.blocked');
  assert.equal(recovered.error?.ownerId, 'ui-stop-context-commit-gate');
  assert.equal(recovered.error?.nextAction, 'reconcile stopped checkpoint');
  assert.deepEqual(recovered.allowedActions, []);
  assert.throws(
    () => rebuilt.startExecution(task.taskId, { prompt: 'must not start' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
  );
  assert.equal(
    rebuilt.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'blocked' && event.terminalPhase === 'final'),
    true,
  );
});

test('post-commit stop recovery fences a late observation and closes the provider once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-late-observation-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-stop-late-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['stopped checkpoint publication failed'],
      ownerId: 'ui-stop-late-context-commit-gate',
      nextAction: 'reconcile stopped checkpoint',
    }),
  }]);
  let releaseLate!: () => void;
  const lateReady = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let markLateYielded!: () => void;
  const lateYielded = new Promise<void>((resolve) => {
    markLateYielded = resolve;
  });
  let releaseClose!: () => void;
  const closeReady = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let closeCalls = 0;
  const driver: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (value) => base.resume(value),
    submit: (value) => base.submit(value),
    observe: async function* (value) {
      const iterator = base.observe(value)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || !first.value) return;
      yield first.value;
      await lateReady;
      markLateYielded();
      yield {
        ...first.value,
        eventId: `${first.value.eventId}-late`,
        kind: 'output',
        summary: 'late output after stop recovery',
        outputRefs: ['fake://late-after-stop'],
      } as ProviderEvent;
    },
    requestStop: (value) => base.requestStop(value),
    settle: (value) => base.settle(value),
    close: async () => {
      closeCalls += 1;
      await closeReady;
      return base.close(binding);
    },
  };
  const service = serviceFor(root, driver, 'fake', 'ready', undefined, undefined, hooks);
  const task = service.createTask({ title: 'late observation fence' });
  const started = service.startExecution(task.taskId, { prompt: 'stop before late event' });
  await waitFor(() => assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'provider.model'), true));

  const stopping = service.stop(task.taskId);
  await waitFor(() => {
    const dashboard = service.taskDashboard(task.taskId);
    assert.equal(dashboard.state, 'blocked');
    assert.equal(dashboard.checkpoint?.outcome, 'stopped');
    assert.equal(dashboard.error?.ownerId, 'ui-stop-late-context-commit-gate');
    assert.equal(dashboard.error?.nextAction, 'reconcile stopped checkpoint');
    assert.deepEqual(dashboard.allowedActions, []);
    assert.equal(closeCalls, 1);
  });

  releaseLate();
  await lateYielded;
  assert.equal(service.eventsSince(started.operationId).some((event) => event.summary === 'late output after stop recovery'), false);

  releaseClose();
  await assert.rejects(
    () => stopping,
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'execution.context-commit-hook.blocked',
  );
  assert.equal(closeCalls, 1);
  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.equal(dashboard.error?.ownerId, 'ui-stop-late-context-commit-gate');
  assert.deepEqual(dashboard.allowedActions, []);
  assert.equal(service.eventsSince(started.operationId).filter((event) => event.kind === 'execution.terminal').length, 1);

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.equal(recovered.checkpoint?.outcome, 'stopped');
  assert.equal(recovered.checkpoint?.checkpointId, dashboard.checkpoint?.checkpointId);
  assert.equal(recovered.error?.ownerId, 'ui-stop-late-context-commit-gate');
  assert.deepEqual(recovered.allowedActions, []);
  assert.throws(
    () => rebuilt.startExecution(task.taskId, { prompt: 'must remain blocked after late event' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
  );
});

test('post-commit recovery is durable before a suspended provider close can finish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-close-suspended-recovery-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-close-suspended-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['post-commit publication failed'],
      ownerId: 'ui-close-suspended-context-commit-gate',
      nextAction: 'reconcile committed checkpoint',
    }),
  }]);
  let releaseClose!: () => void;
  const closeReady = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let markCloseFinished!: () => void;
  const closeFinished = new Promise<void>((resolve) => {
    markCloseFinished = resolve;
  });
  let closeCalls = 0;
  const driver: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (value) => base.resume(value),
    submit: (value) => base.submit(value),
    observe: (value) => base.observe(value),
    requestStop: (value) => base.requestStop(value),
    settle: (value) => base.settle(value),
    close: async () => {
      closeCalls += 1;
      await closeReady;
      const result = await base.close(binding);
      markCloseFinished();
      return result;
    },
  };
  const service = serviceFor(root, driver, 'fake', 'ready', undefined, undefined, hooks);
  const task = service.createTask({ title: 'close suspended recovery' });
  const started = service.startExecution(task.taskId, { prompt: 'persist recovery before close' });
  await waitFor(() => {
    const dashboard = service.taskDashboard(task.taskId);
    assert.equal(dashboard.state, 'blocked');
    assert.equal(dashboard.error?.ownerId, 'ui-close-suspended-context-commit-gate');
    assert.ok(dashboard.checkpoint);
    assert.equal(closeCalls, 1);
  });

  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const journalWhileCloseSuspended = await readFile(journalPath, 'utf8');
  assert.match(journalWhileCloseSuspended, /"state":"blocked"/);
  assert.match(journalWhileCloseSuspended, /ui-close-suspended-context-commit-gate/);

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.ok(recovered.checkpoint);
  assert.equal(recovered.error?.ownerId, 'ui-close-suspended-context-commit-gate');
  assert.equal(recovered.error?.nextAction, 'reconcile committed checkpoint');
  assert.deepEqual(recovered.allowedActions, []);
  assert.throws(
    () => rebuilt.startExecution(task.taskId, { prompt: 'must remain blocked while close is pending' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
  );

  releaseClose();
  await closeFinished;
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'blocked'));
  assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'succeeded' && event.terminalPhase === 'final'), false);
});

test('actual UI entry follows the provider-neutral composition and keeps hook, context, settlement, and failure evidence visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-composition-'));
  const hookEvents: string[] = [];
  const hooks = createHookRegistry(
    (event) => {
      hookEvents.push(`${event.kind}:${event.stage}:${event.hookPhase ?? 'none'}`);
    },
    () => Date.now(),
    [{
      hookId: 'ui-runtime-observation-hook',
      version: '1',
      mode: 'observation',
      stages: [
        'request.created',
        'request.before-dispatch',
        'request.dispatched',
        'attempt.started',
        'response.received',
        'response.decoded',
        'result.mapped',
        'context.committed',
        'request.settled',
      ],
    }],
  );
  const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const service = serviceFor(root, port, 'fake', 'ready', undefined, undefined, hooks);
  const task = service.createTask({ title: 'composition' });
  const started = service.startExecution(task.taskId, { prompt: 'composition' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const events = service.eventsSince(started.operationId);
  assert.equal(events.some((event) => event.evidenceRefs.some((ref) => ref.source === 'humanagent.fake-provider')), true);
  assert.equal(events.some((event) => event.kind === 'execution.settling'), true);
  assert.equal(events.some((event) => event.kind === 'checkpoint.committed'), true);
  assert.equal(events.at(-1)?.kind, 'execution.terminal');
  assert.equal(events.at(-1)?.terminalPhase, 'final');
  assert.equal(hookEvents.some((event) => event.endsWith(':request.created:enter')), true);
  assert.equal(hookEvents.some((event) => event.endsWith(':response.received:enter')), true);
  assert.equal(hookEvents.some((event) => event.endsWith(':response.decoded:exit')), true);
  assert.equal(hookEvents.some((event) => event.endsWith(':context.committed:exit')), true);
  assert.equal(hookEvents.some((event) => event.endsWith(':request.settled:exit')), true);

  const capabilities = service.executionCapabilities();
  assert.equal(capabilities.providerNeutralHarness.state, 'available');
  assert.equal(capabilities.requestResponseHooks.state, 'available');
  assert.equal(capabilities.agentIoRequestLifecycle.state, 'unavailable');
  assert.match(capabilities.agentIoRequestLifecycle.reason, /raw response chunks/);
  assert.equal(capabilities.contextCommitReentry.state, 'available');
  assert.equal(capabilities.checkpointSettlementCancellation.state, 'available');
  assert.equal(capabilities.eventBus.state, 'unavailable');
  assert.equal(capabilities.eventBus.ownerId, 'humanagent.runtime.events');

  const failureRoot = await mkdtemp(join(tmpdir(), 'humanagent-ui-composition-failure-'));
  const failingHooks = createHookRegistry(
    () => undefined,
    () => Date.now(),
    [{
      hookId: 'ui-runtime-blocking-hook',
      version: '1',
      mode: 'core',
      stages: ['request.before-dispatch'],
      onEnter: async () => ({
        status: 'failed' as const,
        diagnostics: ['request hook rejected execution'],
        ownerId: 'ui-runtime-blocking-hook',
        nextAction: 'inspect ui-runtime-blocking-hook',
      }),
    }],
  );
  const failingService = serviceFor(
    failureRoot,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    failingHooks,
  );
  const failedTask = failingService.createTask({ title: 'composition failure' });
  const failedStart = failingService.startExecution(failedTask.taskId, { prompt: 'must fail visibly' });
  await waitFor(() => assert.equal(failingService.taskDashboard(failedTask.taskId).state, 'failed'));
  const failedEvents = failingService.eventsSince(failedStart.operationId);
  assert.equal(failedEvents.some((event) => event.kind === 'provider.error' && event.ownerId === 'ui-runtime-blocking-hook'), true);
  assert.equal(failedEvents.some((event) => event.kind === 'checkpoint.committed' && event.state === 'failed'), true);
  assert.equal(failedEvents.at(-1)?.kind, 'execution.terminal');
  assert.equal(failedEvents.at(-1)?.state, 'failed');
  assert.equal(failedEvents.at(-1)?.terminalPhase, 'final');

  assert.equal(typeof AgentRuntime, 'function');
  assert.equal(typeof bindAgentDriver, 'function');
  assert.equal(typeof executeStopControl, 'function');
});

test('multiple appended inputs drain FIFO across successive executions of one task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-append-fifo-drain-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const port = new GatedPayloadCapturingReplayPort({ binding, stepDelayMs: 1 }, firstGate);
  const service = serviceFor(root, port, 'fake', 'ready', journal);
  const task = service.createTask({ title: 'fifo tmp target' });
  service.startExecution(task.taskId, { prompt: 'baseline input' });
  await port.firstStarted;
  const confirmAppend = async (suffix: string, normalizedInput: string): Promise<string> => {
    const interactionId = await service.receiveExplicitInput({ sourceRef: `ui:${suffix}`, rawInput: normalizedInput, channel: 'business' });
    await service.beginExplicitMatching(interactionId);
    await service.recordExplicitMatch(interactionId, { normalizedInput, matchedTasks: [{ taskId: task.taskId, relation: 'current', status: 'running' }], knownFacts: [] });
    await service.proposeExplicitRequirement(interactionId, { proposedIntent: 'append', proposal: normalizedInput });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    await service.confirmExplicitRequirement({ draftId: proposed.draft!.draftId, inputRevision: 1, confirmationRef: `confirmation:${suffix}`, confirmedBy: 'human:operator', confirmedAt: '2026-09-24T00:00:00.000Z', payloadRef: `asset://requirements/${suffix}` });
    return interactionId;
  };
  await confirmAppend('t1', 'first appended instruction');
  await confirmAppend('t2', 'second appended instruction');
  service.startImplicitConsumer();
  await waitFor(() => assert.equal(port.startPayloads.length, 1));
  await new Promise((r) => setTimeout(r, 80));
  releaseFirst();
  await waitFor(() => assert.equal(port.startPayloads.length, 3));
  assert.deepEqual(port.startPayloads, [
    { prompt: 'baseline input' },
    { prompt: 'first appended instruction' },
    { prompt: 'second appended instruction' },
  ]);
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(task.taskId).executionEpoch, 3);
  await waitFor(() => assert.equal(service.status().implicitScheduling, undefined));
});
