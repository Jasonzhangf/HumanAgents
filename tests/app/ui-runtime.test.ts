import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureControlLayout,
  formatPairingCommand,
  resolveRuntimePaths,
} from '../../packages/config/src/index.js';
import {
  PIPELINE_NODE_IDS,
  PIPELINE_ROWS,
  ContractError,
  id,
  operationIdempotencyKey,
  operationSemanticFingerprint,
  operationSemanticFingerprintKey,
  validateInteractionProviderSettlementReceipt,
  validateInteractionTraceEntry,
  type Attention,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionProviderSettlementReceipt,
  type InteractionTurnIdentity,
  type JournalCommitRef,
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
import {
  ProviderAdapter,
  ProviderAdapterError,
  ResponsesProviderCodec,
  V3ProviderHttpTransport,
  filesystemProviderEvidenceSink,
  type ProviderTransport,
} from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { DEFAULT_AGENT_IO_POLICY } from '../../packages/runtime/src/agent-io/types.js';
import type { RuntimeLivenessProjection } from '../../packages/ui/contracts/runtime.js';
import { type AgentTemplateManifest } from '../../packages/agent-templates/src/index.js';
import {
  AgentRuntime,
  MemoryCoordinator,
  bindAgentDriver,
  executeStopControl,
  type AttentionPort,
} from '../../packages/runtime/src/index.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';
import type { CheckpointClosurePort } from '../../packages/runtime/src/checkpoints/ports.js';
import type { TaskGrantPort } from '../../packages/runtime/src/admission/task-grant.js';
import type { ClosureRecord } from '../../packages/runtime/src/checkpoints/closure.js';
import { createHookRegistry, type AgentHookRegistry } from '../../packages/runtime/src/hooks/index.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
  producedArtifactBody,
  producedArtifactPaths,
  type RuntimeCheckpointBoundary,
  type RuntimeExecutionDriver,
  type RuntimeCheckpointBoundaryPort,
  type RuntimeTaskEvent,
  type RuntimeTaskJournalRecord,
  type RuntimeTaskSnapshot,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';
import type { RuntimeExecutionAllocation } from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { resolveStandardTurnClosingOutcome } from '../../packages/app/src/ui-runtime/execution-owner-facts.js';
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
  uiRuntimeControlJournalPath,
  type UiRuntime,
} from '../../packages/app/src/ui-runtime/index.js';
import { openUiRuntimeOrganJournal } from '../../packages/app/src/ui-runtime/journal.js';
import type { ExplicitProviderSettlementReadPort } from '../../packages/app/src/ui-runtime/service.js';
import { ServiceExecutionCheckpointStore } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { PreparedExecutionStop, PreparedExecutionStopPreparationFailure } from '../../packages/app/src/ui-runtime/prepared-execution-stop.js';
import { createExecutionAdmission, executionAdmissionInputDigest, type PreparedParentLifecycle } from '../../packages/app/src/ui-runtime/execution-admission.js';
import { readPreparedExecutionInput } from '../../packages/app/src/prepared-execution-input.js';
import { createPreparedOperationBoundary } from '../../packages/app/src/prepared-operation-boundary.js';
import type { AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import { prepareExecutionAgentProvider } from '../../packages/app/src/agent-driver-composition.js';
import { createToolExecutionGateway } from '../../packages/app/src/tool-execution-gateway.js';
import {
  AgentRuntimePoolManager,
  OrchestrationManager,
  type ExecutionAgentPort,
  type MergeCoordinatorPort,
  type ReviewAgentPort,
} from '../../packages/runtime/src/orchestration/index.js';
import {
  createUiRuntimeRequestDispatcher,
  isLoopbackAddress,
  startUiRuntimeServer,
} from '../../packages/app/src/ui-runtime/server.js';
import { AppLifecycleError } from '../../packages/app/src/errors.js';
import { createJsonlCheckpointJournal } from '../../packages/app/src/checkpoint-journal.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { projectRuntimeTaskHistory } from '../../packages/app/src/ui-runtime/turn-history.js';
import { validatePersistedToolExecutionFact } from '../../packages/app/src/ui-runtime/tool-fact-validation.js';
import { AccessControlError, AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { readProducedArtifacts, RESPONSES_FILE_READ_TOOL, RESPONSES_FILE_SEARCH_TOOL, RESPONSES_FILE_WRITE_TOOL } from '../../packages/app/src/provider-tool-execution.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { JsonlOrganJournal, JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/index.js';
import type { JournalAppendInput, JournalRecord, JournalTransactionContext } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import { SubscriptionControlPort } from '../../packages/runtime/src/subscriptions/index.js';
import {
  TASK_EXECUTION_ACTION_ID,
  TASK_EXECUTION_CAPABILITY,
} from '../../packages/app/src/ui-runtime/task-control.js';
import {
  createProviderExplicitBrainInterpreter,
  type ExplicitBrainInputInterpreter,
  type ExplicitBrainInterpretationInput,
} from '../../packages/app/src/explicit-brain-runtime.js';
import type { ExplicitInteractionSnapshot } from '../../packages/runtime/src/intake/explicit-intake.js';

// The real entry does not yet expose `workspace` on the interaction snapshot
// until the config-owned workspace resolution is wired; the intersection keeps
// the red test compiling so its assertion can fail behaviorally first.
type WorkspaceCarryingInteractionSnapshot = ExplicitInteractionSnapshot & {
  readonly workspace?: { readonly workspaceCwd: string; readonly projectKey: string };
};

const organId = id('organ', 'organ-ui-test');
const rawFetch = globalThis.fetch.bind(globalThis);
const testSessionByOrigin = new Map<string, string>();

async function testAccessControl(root: string) {
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  return { accessControl, cookie: accessControl.sessionCookie(session).split(';')[0]! };
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const origin = new URL(url).origin;
  const cookie = testSessionByOrigin.get(origin);
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('cookie', cookie);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') headers.set('origin', origin);
  return rawFetch(input, { ...init, headers });
}) as typeof fetch;
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

// The wrapper-launched runtime must record the exact access-control owner it
// started with. A grant fixture reads `readProductPrincipalOwner` from this
// same owner so the durable grant and the runtime admission agree.
const runtimeAccessControl = new WeakMap<UiRuntime, AccessControlService>();

async function startUiRuntime(
  options: Omit<Parameters<typeof startUiRuntimeOwner>[0], 'productRoot'> & { readonly productRoot?: string },
): ReturnType<typeof startUiRuntimeOwner> {
  const securityRoot = options.checkpointRoot;
  const auth = options.accessControl ? undefined : await testAccessControl(securityRoot);
  const runtime = await startUiRuntimeOwner({
    ...options,
    // The fixture stores access control under its checkpoint root, so that is
    // this wrapper's known product root. Production supplies the config root.
    productRoot: options.productRoot ?? options.checkpointRoot,
    ...(auth === undefined ? {} : { accessControl: auth.accessControl }),
    explicitBrainInterpreter: options.explicitBrainInterpreter ?? unusedExplicitBrainInterpreter,
  });
  runtimeAccessControl.set(runtime, options.accessControl ?? auth!.accessControl);
  if (auth) testSessionByOrigin.set(new URL(runtime.server.url).origin, auth.cookie);
  return runtime;
}

/**
 * Commit the real task-scoped execution grant on the same physical control
 * Organ Journal the started runtime already reads. Admission requires the
 * durable grant, so a fixture issues it after task creation and before start.
 */
async function grantRuntimeTask(
  runtime: UiRuntime,
  taskId: TaskId,
  checkpointRoot: string,
  mode: Parameters<typeof startUiRuntimeOwner>[0]['mode'],
): Promise<void> {
  const accessControl = runtimeAccessControl.get(runtime);
  if (accessControl === undefined) {
    throw new Error('ui runtime fixture has no recorded access-control owner for the task grant');
  }
  const grants = new JsonlTaskGrantJournal(
    new JsonlOrganJournal(uiRuntimeControlJournalPath(join(checkpointRoot, mode))),
  );
  await grants.grant({
    requestId: `fixture-task-execution:${taskId.value}`,
    taskId,
    owner: accessControl.readProductPrincipalOwner(),
    capability: {
      actionId: TASK_EXECUTION_ACTION_ID,
      capabilities: [TASK_EXECUTION_CAPABILITY],
      scope: { organId, taskId },
    },
    expectedRevision: 0,
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

function failingAttentionPort(): AttentionPort {
  return {
    async publish(): Promise<never> {
      throw new Error('attention journal is unavailable');
    },
    async resolve(): Promise<never> {
      throw new Error('attention journal is unavailable');
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
  // Simulates the RCC v3 terminal transport failure: observation throws while
  // the stream is already terminal, so settle returns `failed` with a pending
  // resource release and the provider session is retained.
  failObserve = false;
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
    if (this.failObserve) {
      // The real transport marks the stream done and terminal `failed` but
      // leaves the resource unreleased, then surfaces the transport error.
      throw new ProviderAdapterError({
        code: 'transport.failure',
        category: 'transport',
        phase: 'observe',
        message: 'provider transport observe failed',
        scope: session.scope,
      });
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
    this.settleStates.push(this.failObserve ? 'failed' : 'blocked');
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      state: this.failObserve ? 'failed' : 'blocked',
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
  await writeFile(manifestPath, JSON.stringify(narrowed, null, 2) + '\n', 'utf8');
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
  explicitProviderSettlementRead?: ExplicitProviderSettlementReadPort,
  taskGrantPort?: TaskGrantPort,
  principalOwner?: string,
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
    ...(explicitProviderSettlementRead ? { explicitProviderSettlementRead } : {}),
    ...(taskGrantPort === undefined ? {} : { taskGrantPort }),
    ...(principalOwner === undefined ? {} : { principalOwner }),
    runtimeComposition: { admitExecution: async () => {} },
  });
}

async function seedLargeControlJournal(filePath: string, scope: { readonly organId: typeof organId; readonly taskId: TaskId }, count: number): Promise<void> {
  const first = await new JsonlOrganJournal(filePath).append({
    kind: 'event',
    scope,
    payload: { filler: 0 },
  });
  const lines = [JSON.stringify(first)];
  let previousRecordDigest = first.recordDigest;
  for (let index = 1; index < count; index += 1) {
    const recordWithoutDigest = {
      version: 1 as const,
      seq: index + 1,
      kind: 'event' as const,
      scope,
      payload: { filler: index },
      previousRecordDigest,
    };
    const record = {
      ...recordWithoutDigest,
      recordDigest: `sha256:${createHash('sha256').update(JSON.stringify(recordWithoutDigest)).digest('hex')}`,
    };
    lines.push(JSON.stringify(record));
    previousRecordDigest = record.recordDigest;
  }
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function preparedStopAdmission(
  journal: JsonlOrganJournal,
  preparedJournal: UiRuntimeJournal,
  stopSettlement?: { settle: PreparedExecutionStop['settleParentStop'] },
) {
  return createExecutionAdmission({
    organJournal: journal,
    taskGrantPort: new JsonlTaskGrantJournal(journal),
    principalOwner: 'humanagent.prepared-stop-test',
    capabilityFor: ({ intent }) => ({
      actionId: TASK_EXECUTION_ACTION_ID,
      capabilities: [TASK_EXECUTION_CAPABILITY],
      scope: { organId: intent.requestedScope.organId, taskId: intent.taskId },
    }),
    resourceBoundary: createPreparedOperationBoundary(preparedJournal),
    resolveAdmittedInput: async (allocation) => readPreparedExecutionInput(preparedJournal, allocation),
    createGateway: (ports) => createToolExecutionGateway({
      ...ports,
      ...(stopSettlement === undefined ? {} : { stopSettlement }),
      now: () => new Date('2026-10-16T00:00:00.000Z'),
    }),
  });
}

function preparedStopAllocation(): RuntimeExecutionAllocation {
  const taskId = id('task', 'prepared-stop-task');
  const cycleId = id('cycle', 'prepared-stop-cycle');
  const operationId = id('operation', 'prepared-stop-operation');
  return {
    runtimeId: 'prepared-stop-runtime',
    taskId,
    operationId,
    executionEpoch: 1,
    assignmentId: 'prepared-stop-assignment',
    scope: { organId, taskId, cycleId, operationId },
    inputRefs: ['asset://prepared-stop/input'],
    ownerId: 'humanagent.runtime',
    directiveRevision: 1,
    inputRevision: 1,
    orchestrated: false,
  };
}

function preparedStopCheckpoint(allocation: RuntimeExecutionAllocation) {
  return {
    id: id('checkpoint', 'prepared-stop-checkpoint'),
    scope: allocation.scope,
    cycleId: allocation.scope.cycleId!,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: allocation.directiveRevision,
    executionEpoch: allocation.executionEpoch,
    outcome: 'stopped' as const,
    summary: 'prepared execution stop',
    next: { kind: 'stop' as const },
  };
}

function preparedStopComposition(
  port: ExecutionRuntimePort,
): AgentProviderComposition {
  return {
    roleId: 'execution',
    provider: {
      provider: 'rcc',
      source: 'http',
      binding: binding.bindingId,
      protocol: 'responses',
      model: binding.modelRef,
      route: 'prepared-stop-route',
      baseUrl: 'http://127.0.0.1:4599',
    },
    source: 'http',
    binding,
    port,
  };
}

// The prepared-stop producer persists durable facts through the canonical
// product fixture root, not the process temp directory.
const preparedStopFixtureRoot = join(
  homedir(),
  '.humanagent',
  'test-fixtures',
  'provider-prepared-stop-producer-20261016',
);

async function preparedStopFixture(prefix: string): Promise<string> {
  await mkdir(preparedStopFixtureRoot, { recursive: true });
  return await mkdtemp(join(preparedStopFixtureRoot, prefix));
}

test('prepared execution stop request is cold-readable and rejects changed frozen input', async () => {
  const root = await preparedStopFixture('humanagent-prepared-stop-request-');
  try {
    const journal = new JsonlOrganJournal(join(root, 'organ-journal.jsonl'));
    const preparedJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
    const allocation = preparedStopAllocation();
    preparedJournal.append({
      kind: 'operation.prepared',
      allocation,
      input: 'retain this exact prepared input',
      operationCounter: 1,
      cycleCounter: 1,
    });
    const admission = preparedStopAdmission(journal, preparedJournal);
    const checkpoint = preparedStopCheckpoint(allocation);
    const selector = {
      taskId: allocation.taskId,
      operationId: allocation.operationId,
      executionEpoch: allocation.executionEpoch,
    };

    const first = new PreparedExecutionStop({ journal, taskJournal: preparedJournal, admission });
    const requested = await first.request({ allocation, checkpoint });
    const reconstructed = new PreparedExecutionStop({ journal, taskJournal: preparedJournal, admission });
    const read = await reconstructed.read(selector);
    assert.equal(read.state, 'pending');
    if (read.state !== 'pending') throw new Error('expected a pending prepared-stop request');
    assert.equal(read.request.commitId, requested.commitId);
    assert.deepEqual(read.allocation, allocation);
    assert.deepEqual(read.checkpoint, checkpoint);
    assert.deepEqual(read.facts.map((entry) => entry.fact.kind), ['requested']);
    assert.deepEqual(
      await reconstructed.request({ allocation, checkpoint }),
      requested,
      'an identical request must reuse the durable receipt',
    );
    await assert.rejects(() => reconstructed.request({
      allocation,
      checkpoint: { ...checkpoint, summary: 'changed candidate' },
    }));
    await assert.rejects(() => reconstructed.request({
      allocation: { ...allocation, inputRefs: [...allocation.inputRefs, 'asset://prepared-stop/other'] },
      checkpoint,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepared execution stop waits for gated preparation and a real close receipt', async () => {
  const root = await preparedStopFixture('humanagent-prepared-stop-close-');
  try {
    const journal = new JsonlOrganJournal(join(root, 'organ-journal.jsonl'));
    const preparedJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
    const allocation = preparedStopAllocation();
    preparedJournal.append({
      kind: 'operation.prepared',
      allocation,
      input: 'retain this exact prepared input',
      operationCounter: 1,
      cycleCounter: 1,
    });
    const admission = preparedStopAdmission(journal, preparedJournal);
    const checkpoint = preparedStopCheckpoint(allocation);
    const selector = {
      taskId: allocation.taskId,
      operationId: allocation.operationId,
      executionEpoch: allocation.executionEpoch,
    };
    const producer = new PreparedExecutionStop({ journal, taskJournal: preparedJournal, admission });

    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const base = new FakeReplayExecutionRuntimePort({ binding });
    let closeAttempts = 0;
    const port: ExecutionRuntimePort = {
      kind: 'humanagent.execution-runtime-port',
      probe: (value) => base.probe(value),
      capabilities: (value) => base.capabilities(value),
      start: (value) => base.start(value),
      resume: (value) => base.resume(value),
      submit: (value) => base.submit(value),
      observe: (value) => base.observe(value),
      requestStop: (value) => base.requestStop(value),
      settle: (value) => base.settle(value),
      close: async (value) => {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          return {
            bindingId: value.bindingId,
            providerId: value.providerId,
            protocol: value.protocol,
            state: 'failed',
            evidenceRefs: [],
          };
        }
        return base.close(value);
      },
    };
    const preparation = producer.withPreparation(allocation, async (lease) => {
      markEntered();
      await preparationGate;
      return await producer.takeProvider(lease, preparedStopComposition(port));
    });

    await entered;
    const requested = await producer.request({ allocation, checkpoint });
    const gated = await producer.settle(selector);
    assert.equal(gated.state, 'pending');
    if (gated.state !== 'pending') throw new Error('expected settlement to wait for preparation');
    assert.equal(gated.reason, 'preparation-active');

    releasePreparation();
    const acquisition = await preparation;
    const unresolved = await producer.settle(selector);
    assert.equal(unresolved.state, 'pending');
    if (unresolved.state !== 'pending') throw new Error('expected settlement to wait for resource close');
    assert.equal(unresolved.reason, 'resource-unresolved');

    await assert.rejects(() => producer.closeProvider(acquisition));
    const afterFailedClose = await producer.settle(selector);
    assert.equal(afterFailedClose.state, 'pending');
    if (afterFailedClose.state !== 'pending') throw new Error('failed close must retain ownership');
    assert.equal(afterFailedClose.reason, 'resource-unresolved');

    const closed = await producer.closeProvider(acquisition);
    const settled = await producer.settle(selector);
    assert.equal(settled.state, 'settled');
    if (settled.state !== 'settled') throw new Error('actual close must permit settlement');
    assert.equal(settled.fact.request.commitId, requested.commitId);
    assert.ok(settled.settlement.commitId !== requested.commitId);

    const reconstructed = new PreparedExecutionStop({ journal, taskJournal: preparedJournal, admission });
    const readback = await reconstructed.read(selector);
    assert.equal(readback.state, 'settled');
    if (readback.state !== 'settled') throw new Error('settlement must survive reconstruction');
    assert.equal(readback.recoveryStateRef.locator, readback.settlement.commitId);
    assert.deepEqual(await reconstructed.closeProvider(acquisition), closed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepared execution stop recovers acquisition and left append failures without replay', async () => {
  for (const cut of ['resource-acquired', 'preparation-left'] as const) {
    const root = await preparedStopFixture(`humanagent-prepared-stop-retry-${cut}-`);
    try {
      const appendFailure = new Error(`controlled ${cut} append failure`);
      class FailingJournal extends JsonlOrganJournal {
        failed = true;
        override async transaction<T, R>(
          read: (context: JournalTransactionContext) => T | Promise<T>,
          apply: (input: T, append: (input: JournalAppendInput) => Promise<JournalRecord>) => Promise<R>,
        ): Promise<R> {
          return super.transaction(read, (input, append) => apply(input, async (next) => {
            const fact = next.payload?.fact as { kind?: string } | undefined;
            if (this.failed && fact?.kind === cut) throw appendFailure;
            return append(next);
          }));
        }
      }
      const journal = new FailingJournal(join(root, 'organ-journal.jsonl'));
      const preparedJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
      const allocation = preparedStopAllocation();
      preparedJournal.append({ kind: 'operation.prepared', allocation, input: 'retained input', operationCounter: 1, cycleCounter: 1 });
      const admission = preparedStopAdmission(journal, preparedJournal);
      const producer = new PreparedExecutionStop({ journal, taskJournal: preparedJournal, admission });
      let selected = 0;
      let probes = 0;
      let closes = 0;
      let dispatches = 0;
      let physicallyClosed = false;
      let allowClose = cut === 'preparation-left';
      const closeFailure = new Error('controlled actual close failure');
      let actualReceipt: ProviderCloseResult | undefined;
      let retainedBinding: ProviderBinding | undefined;
      let failure: PreparedExecutionStopPreparationFailure | undefined;
      await assert.rejects(() => producer.withPreparation(allocation, (lease) => prepareExecutionAgentProvider({
        roleId: 'execution', agentProviderBindings: [], legacyProvider: preparedStopComposition(new FakeReplayExecutionRuntimePort({ binding })).provider,
        createPort: (selection) => {
          selected += 1;
          retainedBinding = selection.binding;
          const base = new FakeReplayExecutionRuntimePort({ binding: selection.binding });
          base.probe = async (value) => { probes += 1; return new FakeReplayExecutionRuntimePort({ binding: value }).probe(value); };
          base.start = async () => { dispatches += 1; throw new Error('business dispatch forbidden'); };
          base.close = async (value) => {
            closes += 1;
            if (!allowClose) throw closeFailure;
            physicallyClosed = true;
            actualReceipt = await new FakeReplayExecutionRuntimePort({ binding: value }).close(value);
            return actualReceipt;
          };
          return base;
        },
      }, producer, lease)), (error: unknown) => {
        if (cut === 'resource-acquired') assert.equal(closes, 1, 'failed acquisition must retain and attempt actual resource close');
        assert.ok(error instanceof PreparedExecutionStopPreparationFailure);
        if (!(error instanceof PreparedExecutionStopPreparationFailure)) throw error;
        failure = error;
        assert.ok(error.errors.includes(appendFailure));
        return true;
      });
      assert.ok(failure);
      if (failure === undefined) throw new Error('expected retained preparation failure');
      assert.equal(probes, cut === 'resource-acquired' ? 0 : 1, 'failed acquisition must not admit');
      if (cut === 'resource-acquired') {
        assert.equal(closes, 1, 'failed acquisition must retain and attempt actual resource close');
        assert.equal(physicallyClosed, false, 'failed close retains the actual resource');
        assert.ok(failure.errors.includes(closeFailure));
      }
      const selector = { taskId: allocation.taskId, operationId: allocation.operationId, executionEpoch: allocation.executionEpoch };
      await producer.request({ allocation, checkpoint: preparedStopCheckpoint(allocation) });
      // A retained failed preparation keeps the original cleanup error and its
      // custody. Settling such an execution drives the real cleanup retry, so a
      // still-unavailable persistence must surface the typed retry failure
      // instead of a silent pending. A fresh producer with no retained
      // preparation has nothing to retry and correctly stays pending.
      await assert.rejects(() => producer.settle(selector), (error: unknown) => {
        assert.ok(error instanceof PreparedExecutionStopPreparationFailure, 'settle must surface the retained preparation retry failure');
        if (!(error instanceof PreparedExecutionStopPreparationFailure)) return false;
        assert.ok(error.errors.some((entry) => entry === closeFailure || entry === appendFailure), 'the retry must keep the original cleanup error');
        return true;
      });
      assert.equal((await new PreparedExecutionStop({ journal, taskJournal: preparedJournal, admission }).settle(selector)).state, 'pending');
      allowClose = true;
      await assert.rejects(() => producer.retryFailedPreparation(failure!.lease));
      assert.equal(physicallyClosed, true, 'retry closes retained resource even while persistence is unavailable');
      const physicalCloseCount = closes;
      journal.failed = false;
      await producer.retryFailedPreparation(failure.lease);
      assert.equal(closes, physicalCloseCount, 'persistence retry must not repeat physical close');
      assert.equal(selected, 1);
      assert.equal(dispatches, 0);
      const read = await producer.read(selector);
      assert.equal(read.state, 'pending');
      if (read.state !== 'pending') throw new Error('expected pending request');
      const acquired = read.facts.filter((entry) => entry.fact.kind === 'resource-acquired');
      const closed = read.facts.filter((entry) => entry.fact.kind === 'resource-closed');
      const left = read.facts.filter((entry) => entry.fact.kind === 'preparation-left');
      assert.equal(acquired.length, 1); assert.equal(closed.length, 1); assert.equal(left.length, 1);
      assert.equal(acquired[0]!.fact.kind, 'resource-acquired');
      if (acquired[0]!.fact.kind !== 'resource-acquired' || closed[0]!.fact.kind !== 'resource-closed' || left[0]!.fact.kind !== 'preparation-left') throw new Error('wrong facts');
      assert.deepEqual(acquired[0]!.fact.resource.binding, retainedBinding);
      assert.deepEqual(closed[0]!.fact.acquisition, acquired[0]!.ref);
      assert.deepEqual(closed[0]!.fact.receipt, actualReceipt);
      assert.equal(left[0]!.fact.outcome, 'failed');
      assert.equal((await producer.settle(selector)).state, 'settled');
      assert.equal((await new PreparedExecutionStop({ journal, taskJournal: preparedJournal, admission }).read(selector)).state, 'settled');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('prepared execution stop settles the actual admitted parent without an opened turn', async () => {
  for (const pendingChild of [false, true]) {
  const root = await preparedStopFixture('humanagent-prepared-stop-parent-');
  try {
    const journal = new JsonlOrganJournal(join(root, 'organ-journal.jsonl'));
    const preparedJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
    const allocation = preparedStopAllocation();
    preparedJournal.append({ kind: 'operation.prepared', allocation, input: 'retained input', operationCounter: 1, cycleCounter: 1 });
    let producer!: PreparedExecutionStop;
    let callbacks = 0;
    const admission = preparedStopAdmission(journal, preparedJournal, { settle: async (request) => {
      callbacks += 1;
      return producer.settleParentStop(request);
    } });
    producer = new PreparedExecutionStop({ journal, taskJournal: preparedJournal, admission });
    const registration: PreparedParentLifecycle['control']['registration'] = {
      toolName: TASK_EXECUTION_ACTION_ID, contractVersion: '1.0.0', supportedKinds: ['run'],
      routeId: 'harness-provider-controller', routeVersion: '1', mode: 'gateway', acceptedScopes: [{}],
      inputContract: 'humanagent://task-execution/input/v1', outputContract: 'humanagent://task-execution/output/v1',
      verifier: 'humanagent://task-execution/standard-end', capabilities: [TASK_EXECUTION_CAPABILITY],
      retryPolicy: 'humanagent://task-execution/retry', owner: 'humanagent.runtime',
    };
    const intent: PreparedParentLifecycle['control']['intent'] = {
      operationId: allocation.operationId, taskId: allocation.taskId, cycleId: allocation.scope.cycleId!,
      requestedBy: 'humanagent.prepared-stop-test', intentRevision: '1', kind: 'run', toolName: registration.toolName,
      inputRef: allocation.inputRefs[0]!, inputDigest: executionAdmissionInputDigest(allocation, readPreparedExecutionInput(preparedJournal, allocation)),
      requestedScope: allocation.scope, idempotencyKey: allocation.operationId.value,
      expectedOutput: { schemaRef: registration.outputContract, requiredEvidenceKinds: ['operation'] },
    };
    const route: PreparedParentLifecycle['control']['route'] = {
      operationId: allocation.operationId, routeId: registration.routeId, routeVersion: registration.routeVersion,
      mode: registration.mode, contractVersion: registration.contractVersion, effectiveScope: allocation.scope,
      selectionReason: 'real admitted no-turn consumer', selectedAt: '2026-10-16T00:00:00.000Z',
    };
    const capability = { actionId: TASK_EXECUTION_ACTION_ID, capabilities: [TASK_EXECUTION_CAPABILITY], scope: { organId, taskId: allocation.taskId } };
    await new JsonlTaskGrantJournal(journal).grant({ requestId: 'prepared-stop-grant', taskId: allocation.taskId, owner: 'humanagent.prepared-stop-test', capability, expectedRevision: 0 });
    const admitted = await admission.admitExecution({ allocation, requestRef: `execution:${allocation.operationId.value}`, capability,
      parentLifecycle: {
        event: { eventId: 'prepared-parent-admitted', schemaVersion: 1, kind: 'operation.accepted', operationId: allocation.operationId,
          taskId: allocation.taskId, executionEpoch: 1, status: 'accepted', occurredAt: route.selectedAt, evidenceRefs: [] },
        control: { intent, registration, route, status: 'accepted', executionEpoch: 1,
          namespaceKey: operationIdempotencyKey(intent), fingerprintKey: operationSemanticFingerprintKey(operationSemanticFingerprint(intent, registration)) },
      } });
    let closes = 0;
    const port = new FakeReplayExecutionRuntimePort({ binding });
    port.close = async (value) => { closes += 1; return new FakeReplayExecutionRuntimePort({ binding: value }).close(value); };
    const acquired = await producer.withPreparation(allocation, (lease) => producer.takeProvider(lease, preparedStopComposition(port)));
    await producer.closeProvider(acquired);
    await producer.request({ allocation, checkpoint: preparedStopCheckpoint(allocation) });
    const selector = { taskId: allocation.taskId, operationId: allocation.operationId, executionEpoch: allocation.executionEpoch };
    if (pendingChild) {
      const childId = id('operation', 'prepared-stop-pending-child');
      await admission.admitToolOperation({ binding: admitted.binding, registration,
        intent: { ...intent, operationId: childId, requestedScope: { ...allocation.scope, operationId: childId }, idempotencyKey: childId.value },
        providerRequestId: 'prepared-stop-child-request', toolCallId: 'prepared-stop-child-call' });
      const control = await admission.gateway.readControl({ scope: allocation.scope, agentRuntimeId: allocation.runtimeId, harnessExecutionEpoch: allocation.executionEpoch });
      assert.equal(control.state, 'unknown', 'pending child registration is not empty coverage');
      const pending = await producer.settle(selector);
      assert.equal(pending.state, 'pending');
      if (pending.state !== 'pending') throw new Error('pending child must retain parent responsibility');
      assert.equal(pending.reason, 'admission-incomplete');
      assert.equal(callbacks, 0, 'unknown control must not request cancellation');
      assert.equal((await producer.read(selector)).state, 'pending');
      continue;
    }
    const settled = await producer.settle(selector);
    assert.equal(settled.state, 'settled', 'real admitted parent with no opened turn must settle');
    if (settled.state !== 'settled') throw new Error('expected settled parent');
    assert.deepEqual(settled.allocation, allocation);
    assert.deepEqual(settled.checkpoint, preparedStopCheckpoint(allocation));
    assert.equal(callbacks, 1, 'actual Gateway callback must execute once');
    const controlInput = { scope: allocation.scope, agentRuntimeId: allocation.runtimeId, harnessExecutionEpoch: allocation.executionEpoch };
    const control = await admission.gateway.readControl(controlInput);
    assert.equal(control.state, 'complete');
    if (control.state !== 'complete') throw new Error('control unknown');
    assert.equal(control.operations.length, 1);
    assert.equal(control.operations[0]!.status, 'cancelled');
    assert.deepEqual(settled.fact.owners.parent, control.operationCommits[0], 'settlement must reference the current cancelled parent');
    assert.ok(settled.fact.cut.journalSeq >= control.operationCommits[0]!.journalSeq);
    assert.equal(closes, 1);
    const coldAdmission = preparedStopAdmission(journal, preparedJournal, { settle: async () => { throw new Error('cold read must not cancel again'); } });
    const cold = new PreparedExecutionStop({ journal, taskJournal: preparedJournal, admission: coldAdmission });
    assert.deepEqual(await cold.settle(selector), settled);
    const coldControl = await coldAdmission.gateway.readControl(controlInput);
    assert.equal(coldControl.state, 'complete');
    if (coldControl.state !== 'complete') throw new Error('cold control unknown');
    assert.equal(coldControl.operations[0]!.status, 'cancelled');
    assert.equal(callbacks, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
  }
});

// Failure basis: the original public stop reported stopped without a checkpoint.
// Impact: lost recovery responsibility. Cost: one local file-backed fixture per proof.
// Ack loss likelihood is unknown; one append wrapper checks the ambiguous durable cut.
async function runtimePreparedStopConsumer(loseAppendAcknowledgement: boolean): Promise<void> {
  const root = await preparedStopFixture('runtime-prepared-stop-');
  try {
    const checkpointPath = join(root, 'organ.jsonl');
    const journal = new JsonlOrganJournal(checkpointPath);
    const taskJournal = new UiRuntimeJournal(join(root, 'tasks.jsonl'));
    const store = new ServiceExecutionCheckpointStore(checkpointPath, journal, () => new Date());
    const originalCommitNative = store.commitNativeCheckpoint.bind(store);
    const acknowledgementError = new Error('checkpoint committed but append acknowledgement lost');
    let nativeCommits = 0;
    let firstCommittedAt: string | undefined;
    store.commitNativeCheckpoint = async (input) => {
      const relationship = await originalCommitNative(input);
      nativeCommits += 1;
      if (loseAppendAcknowledgement && nativeCommits === 1) {
        firstCommittedAt = relationship.receipt.committedAt;
        throw acknowledgementError;
      }
      if (loseAppendAcknowledgement && nativeCommits > 1) {
        assert.equal(relationship.receipt.committedAt, firstCommittedAt, 'retry reuses the first durable receipt time');
      }
      return relationship;
    };
    let producer!: PreparedExecutionStop;
    let cancellations = 0;
    const admission = preparedStopAdmission(journal, taskJournal, { settle: async (request) => {
      cancellations += 1;
      return producer.settleParentStop(request);
    } });
    producer = new PreparedExecutionStop({ journal, taskJournal, admission });
    const preparationError = new Error('original provider preparation failed after resource closure');
    let closes = 0;
    let factories = 0;
    let admissions = 0;
    const port = new FakeReplayExecutionRuntimePort({ binding });
    port.close = async (value) => { closes += 1; return new FakeReplayExecutionRuntimePort({ binding: value }).close(value); };
    let publications = 0;
    const options = {
      organId, journal: taskJournal, checkpointStoreFor: () => store, preparedExecutionStop: producer,
      attentionPort: {
        async publish(value: Attention) { return { attentionId: value.attentionId, delivered: true as const }; },
        async resolve(value: { attentionId: Attention['attentionId'] }) { return { attentionId: value.attentionId, delivered: true as const }; },
      },
      checkpointBoundary: { async publish(value: RuntimeCheckpointBoundary) {
        const exact = await store.readCommitted(value.checkpoint.scope, value.checkpoint.id);
        assert.deepEqual(exact?.checkpoint, value.checkpoint);
        assert.equal(exact?.commitRef.recordDigest, value.recordDigest);
        assert.equal(taskJournal.replay().some((entry) => entry.kind === 'operation.event'
          && entry.event.kind === 'checkpoint.committed'), false, 'callback precedes task checkpoint publication');
        publications += 1;
      } },
      admitExecution: async (allocation: RuntimeExecutionAllocation) => {
        admissions += 1;
        const registration: PreparedParentLifecycle['control']['registration'] = {
          toolName: TASK_EXECUTION_ACTION_ID, contractVersion: '1.0.0', supportedKinds: ['run'],
          routeId: 'harness-provider-controller', routeVersion: '1', mode: 'gateway', acceptedScopes: [{}],
          inputContract: 'humanagent://task-execution/input/v1', outputContract: 'humanagent://task-execution/output/v1',
          verifier: 'humanagent://task-execution/standard-end', capabilities: [TASK_EXECUTION_CAPABILITY],
          retryPolicy: 'humanagent://task-execution/retry', owner: 'humanagent.runtime',
        };
        const intent: PreparedParentLifecycle['control']['intent'] = {
          operationId: allocation.operationId, taskId: allocation.taskId, cycleId: allocation.scope.cycleId!,
          requestedBy: 'humanagent.prepared-stop-test', intentRevision: '1', kind: 'run', toolName: registration.toolName,
          inputRef: allocation.inputRefs[0]!, inputDigest: executionAdmissionInputDigest(allocation, readPreparedExecutionInput(taskJournal, allocation)),
          requestedScope: allocation.scope, idempotencyKey: allocation.operationId.value,
          expectedOutput: { schemaRef: registration.outputContract, requiredEvidenceKinds: ['operation'] },
        };
        const route: PreparedParentLifecycle['control']['route'] = {
          operationId: allocation.operationId, routeId: registration.routeId, routeVersion: registration.routeVersion,
          mode: registration.mode, contractVersion: registration.contractVersion, effectiveScope: allocation.scope,
          selectionReason: 'Runtime prepared-stop public consumer', selectedAt: '2026-10-16T00:00:00.000Z',
        };
        const capability = { actionId: TASK_EXECUTION_ACTION_ID, capabilities: [TASK_EXECUTION_CAPABILITY], scope: { organId, taskId: allocation.taskId } };
        await new JsonlTaskGrantJournal(journal).grant({ requestId: 'runtime-prepared-stop-grant', taskId: allocation.taskId,
          owner: 'humanagent.prepared-stop-test', capability, expectedRevision: 0 });
        await admission.admitExecution({ allocation, requestRef: `execution:${allocation.operationId.value}`, capability,
          parentLifecycle: {
            event: { eventId: 'runtime-prepared-parent-admitted', schemaVersion: 1, kind: 'operation.accepted', operationId: allocation.operationId,
              taskId: allocation.taskId, executionEpoch: allocation.executionEpoch, status: 'accepted', occurredAt: route.selectedAt, evidenceRefs: [] },
            control: { intent, registration, route, status: 'accepted', executionEpoch: allocation.executionEpoch,
              namespaceKey: operationIdempotencyKey(intent), fingerprintKey: operationSemanticFingerprintKey(operationSemanticFingerprint(intent, registration)) },
          } });
      },
      createDriver: async () => {
        factories += 1;
        const resource = await producer.withPreparation(allocation, (lease) => producer.takeProvider(lease, preparedStopComposition(port)));
        await producer.closeProvider(resource);
        throw preparationError;
      },
    };
    const coordinator = new RuntimeTaskCoordinator(options);
    const task = coordinator.createTask({ title: 'prepared stop public observation' });
    const allocation = coordinator.prepareExecution(task.taskId, { prompt: 'retain preparation failure responsibility' });
    await assert.rejects(() => coordinator.releaseExecution(task.taskId, allocation.operationId), (error: unknown) => error === preparationError);
    assert.equal(coordinator.taskSnapshot(task.taskId).state, 'blocked');
    const selector = { taskId: task.taskId, operationId: allocation.operationId, executionEpoch: allocation.executionEpoch };
    let frozen: Awaited<ReturnType<PreparedExecutionStop['read']>> | undefined;
    if (loseAppendAcknowledgement) {
      await assert.rejects(() => coordinator.stop(task.taskId), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        if (!(error instanceof AggregateError)) return false;
        assert.equal(error.errors[0], preparationError);
        assert.equal(error.cause, error.errors[1]);
        assert.equal((error.errors[1] as Error).name, 'CheckpointCompletionError');
        assert.equal((error.errors[1] as Error).cause, acknowledgementError);
        return true;
      });
      assert.ok(coordinator.taskSnapshot(task.taskId).state !== 'stopped');
      assert.deepEqual(coordinator.taskSnapshot(task.taskId).allowedActions, ['retry-stop']);
      assert.equal(publications, 0);
      assert.equal(taskJournal.replay().some((entry) => entry.kind === 'operation.event'
        && entry.event.kind === 'execution.terminal' && entry.event.state === 'stopped'), false);
      frozen = await producer.read(selector);
      assert.equal(frozen.state, 'settled');
      assert.equal((await coordinator.retryStop(task.taskId)).state, 'stopped');
    } else {
      assert.equal((await coordinator.stop(task.taskId)).state, 'stopped');
    }
    const snapshot = coordinator.taskSnapshot(task.taskId);
    assert.equal(snapshot.state, 'stopped');
    assert.ok(snapshot.checkpoint, 'stopped implies checkpoint');
    const exact = await store.readCommitted(allocation.scope, id('checkpoint', snapshot.checkpoint!.checkpointId));
    assert.ok(exact);
    const checkpoint = exact!.checkpoint;
    assert.deepEqual(checkpoint.scope, allocation.scope);
    assert.equal(checkpoint.executionEpoch, allocation.executionEpoch);
    assert.equal(checkpoint.id.value, snapshot.checkpoint!.checkpointId);
    const relationship = await store.readNativeCheckpoint({ checkpoint });
    assert.ok(relationship, 'stopped implies a durable native relationship');
    assert.equal(exact?.commitRef.commitId, relationship!.receipt.commitIdentity);
    assert.ok(relationship!.receipt.commitIdentity !== checkpointCommitId(checkpoint), 'native v2 identity is not the legacy v1 identity');
    assert.equal(snapshot.checkpoint!.committedAt, relationship!.receipt.committedAt);
    assert.equal(snapshot.checkpoint!.committedAtUnavailableReason, undefined);
    assert.equal(exact?.previous, null);
    assert.deepEqual((await store.listCommitted({ scope: allocation.scope, limit: 10 })).checkpoints, [exact]);
    const bytes = await readFile(checkpointPath, 'utf8');
    assert.ok(bytes.includes(checkpoint.id.value));
    const settled = await producer.read(selector);
    assert.equal(settled.state, 'settled');
    if (settled.state !== 'settled') throw new Error('settlement is required');
    assert.deepEqual(checkpoint.recoveryStateRef, settled.recoveryStateRef);
    assert.deepEqual(checkpoint.evidenceRefs, [settled.recoveryStateRef]);
    assert.deepEqual(settled.allocation, allocation);
    const { recoveryStateRef: _recovery, evidenceRefs: _evidence, ...candidate } = checkpoint;
    assert.deepEqual(settled.checkpoint, candidate);
    if (frozen) assert.deepEqual(settled, frozen, 'retry reads the original durable candidate and settlement');
    const control = await admission.gateway.readControl({ scope: allocation.scope, agentRuntimeId: allocation.runtimeId, harnessExecutionEpoch: allocation.executionEpoch });
    assert.equal(control.state, 'complete');
    if (control.state !== 'complete') throw new Error('actual control readback is required');
    assert.equal(control.operations.length, 1);
    assert.equal(control.operations[0]!.status, 'cancelled');
    assert.deepEqual(settled.fact.owners.parent, control.operationCommits[0]);
    assert.equal(settled.fact.preparations.length, 1);
    assert.equal(settled.fact.resourceClosures.length, 1);
    assert.equal(nativeCommits, loseAppendAcknowledgement ? 2 : 1, 'retry re-commits through the idempotent native identity');
    assert.equal((await journal.replay()).filter((record) => record.kind === 'checkpoint').length, 1, 'retry must not append another checkpoint');
    assert.equal(cancellations, 1);
    assert.equal(closes, 1);
    assert.equal(admissions, 1);
    assert.equal(factories, 1, 'no repeated parent, preparation, or dispatch');
    assert.equal(publications, 1);
    const rebuilt = new RuntimeTaskCoordinator({ ...options, checkpointStoreFor: () => new ServiceExecutionCheckpointStore(checkpointPath, journal, () => new Date()) });
    await rebuilt.hydrate();
    assert.deepEqual(rebuilt.taskSnapshot(task.taskId).checkpoint, snapshot.checkpoint);
    assert.deepEqual(await new FileCheckpointStore(checkpointPath).readCommitted(allocation.scope, checkpoint.id), exact);
    const records = await journal.replay();
    assert.equal(records.some((record) => record.commitId?.startsWith('active-turn:')), false, 'no invented admitted turn');
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Runtime prepared stop commits exact history with actual cancelled parent and custody', async () => {
  await runtimePreparedStopConsumer(false);
});

test('Runtime prepared stop retries committed append acknowledgement failure with original errors and identity', async () => {
  await runtimePreparedStopConsumer(true);
});

// The default App composition is the only real consumer of the frozen
// prepared-stop binder: one producer owns fresh Task custody, the Gateway
// stop-settlement callback and the public stop port. This consumer drives the
// real startUiRuntime launch instead of a hand-built coordinator, so a fresh
// Task whose selected Provider preparation fails after custody and admission
// still keeps its stop responsibility, reaches a real durable stopped
// checkpoint, cancels the actual parent and closes its resource exactly once.
test('Runtime prepared stop through the default composition settles a failed Task preparation once', async () => {
  const root = await preparedStopFixture('runtime-prepared-stop-default-');
  try {
    const checkpointRoot = join(root, 'checkpoints');
    const modeRoot = join(checkpointRoot, 'rcc');
    const controlJournalPath = uiRuntimeControlJournalPath(modeRoot);
    const preparedJournalPath = join(modeRoot, 'ui-runtime-journal.jsonl');
    const preparationError = new Error('selected Task provider preparation failed after custody');
    let selectedProbes = 0;
    let selectedCloses = 0;
    let selectedReceipt: ProviderCloseResult | undefined;
    const selectedPort = (): ExecutionRuntimePort => {
      const base = new FakeReplayExecutionRuntimePort({ binding });
      return {
        kind: 'humanagent.execution-runtime-port',
        probe: async () => { selectedProbes += 1; throw preparationError; },
        capabilities: (value) => base.capabilities(value),
        start: (value) => base.start(value),
        resume: (value) => base.resume(value),
        submit: (value) => base.submit(value),
        observe: (value) => base.observe(value),
        requestStop: (value) => base.requestStop(value),
        settle: (value) => base.settle(value),
        close: async (value) => { selectedCloses += 1; selectedReceipt = await base.close(value); return selectedReceipt; },
      };
    };
    const runtime = await startUiRuntime({
      mode: 'rcc',
      organId,
      binding,
      // The shared launch readiness uses a healthy instance; only the selected
      // Task composition fails, so the failure lands after the Task admission.
      port: new FakeReplayExecutionRuntimePort({ binding }),
      checkpointRoot,
      evidenceRoot: join(root, 'evidence'),
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      portNumber: 0,
      memory: testMemory('project-ui-prepared-stop-default'),
      runtimeComposition: {
        prepareAgentProvider: async () => {
          throw new Error('a fresh Task execution must select through the Task-scoped custody preparer');
        },
        prepareTaskAgentProvider: (selection, owner, lease) => prepareExecutionAgentProvider({
          roleId: selection.roleId,
          ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
          agentProviderBindings: [],
          legacyProvider: preparedStopComposition(buildFakeExecutionPort(binding, 1)).provider,
          createPort: () => selectedPort(),
        }, owner, lease),
      },
    });
    try {
      const task = runtime.service.createTask({ title: 'default composition failed preparation' });
      await grantRuntimeTask(runtime, task.taskId, checkpointRoot, 'rcc');
      await assert.rejects(
        () => runtime.service.startExecution(task.taskId, { prompt: 'fail the selected preparation' }),
        (error: unknown) => {
          assert.ok(error instanceof UiRuntimeApiError, 'the public start surfaces the preparation failure');
          if (!(error instanceof UiRuntimeApiError)) return false;
          assert.equal(error.message, preparationError.message);
          return true;
        },
      );
      const blocked = runtime.service.taskDashboard(task.taskId);
      assert.equal(blocked.state, 'blocked');
      assert.ok(blocked.allowedActions.includes('stop'), 'a failed fresh preparation keeps the public stop responsibility');
      assert.equal(selectedProbes, 1, 'the selected composition is admitted once and then fails');
      assert.equal(selectedCloses, 1, 'the retained failed preparation closes its own resource exactly once');
      assert.ok(selectedReceipt, 'the retained close returns the real receipt');

      const stopped = await runtime.service.stop(task.taskId);
      assert.equal(stopped.state, 'stopped');
      const dashboard = runtime.service.taskDashboard(task.taskId);
      assert.equal(dashboard.state, 'stopped');
      assert.equal(dashboard.checkpoint?.outcome, 'stopped');
      assert.ok(dashboard.checkpoint?.committedAt, 'the stopped checkpoint has a durable native commit time');
      assert.equal(selectedCloses, 1, 'settlement reuses the retained closure and never closes twice');

      const journal = new JsonlOrganJournal(controlJournalPath);
      const records = await journal.replay();
      const facts = records
        .map((record) => (record.payload as { readonly fact?: { readonly kind?: string } } | undefined)?.fact)
        .filter((fact): fact is { readonly kind: string } => fact !== undefined && typeof fact.kind === 'string');
      const ofKind = (kind: string) => facts.filter((fact) => fact.kind === kind);
      const requested = ofKind('requested')[0] as unknown as { readonly allocation: RuntimeExecutionAllocation } | undefined;
      assert.ok(requested, 'the public stop persisted one prepared-stop request');
      assert.equal(ofKind('preparation-entered').length, 1);
      assert.equal(ofKind('resource-acquired').length, 1);
      assert.equal(ofKind('resource-closed').length, 1);
      const left = ofKind('preparation-left')[0] as unknown as { readonly outcome?: string } | undefined;
      assert.equal(left?.outcome, 'failed', 'the failed preparation leaves the same cleanup owner');
      const settled = records.find((record) =>
        (record.payload as { readonly fact?: { readonly kind?: string } } | undefined)?.fact?.kind === 'settled');
      assert.equal(ofKind('settled').length, 1, 'the public stop persisted exactly one settlement');
      assert.ok(settled, 'the settled fact is durably present');

      const checkpointRecords = records.filter((record) => record.kind === 'checkpoint');
      assert.equal(checkpointRecords.length, 1);
      const committed = checkpointRecords[0]!.checkpoint as Checkpoint;
      assert.equal(committed.outcome, 'stopped');
      assert.equal(committed.recoveryStateRef.locator, settled!.commitId, 'the checkpoint points at the real settlement');

      const preparedJournal = new UiRuntimeJournal(preparedJournalPath);
      const admission = preparedStopAdmission(journal, preparedJournal);
      const control = await admission.gateway.readControl({
        scope: requested!.allocation.scope,
        agentRuntimeId: requested!.allocation.runtimeId,
        harnessExecutionEpoch: requested!.allocation.executionEpoch,
      });
      assert.equal(control.state, 'complete');
      if (control.state !== 'complete') throw new Error('actual control readback is required');
      assert.equal(control.operations.length, 1);
      assert.equal(control.operations[0]!.status, 'cancelled', 'the actual parent is cancelled');

      const store = new ServiceExecutionCheckpointStore(controlJournalPath, journal, () => new Date());
      const exact = await store.readCommitted(committed.scope, committed.id);
      assert.ok(exact, 'the stopped checkpoint is durably readable');
      assert.equal(exact!.checkpoint.id.value, dashboard.checkpoint!.checkpointId);
      assert.equal(records.some((record) => record.commitId?.startsWith('active-turn:')), false, 'no invented admitted turn');
    } finally { await runtime.server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

class CountingFakeReplayExecutionRuntimePort extends FakeReplayExecutionRuntimePort {
  startCount = 0;
  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.startCount += 1;
    return super.start(input);
  }
}

// The fake replay port intentionally omits summaries for model events. This
// wrapper restores the real provider's framework summary so the implicit
// executor projection can be tested against the same event shape.
class SemanticModelSummaryReplayPort extends FakeReplayExecutionRuntimePort {
  override async *observe(
    input: Parameters<ExecutionRuntimePort['observe']>[0],
  ): AsyncIterable<ProviderEvent> {
    for await (const event of super.observe(input)) {
      yield event.kind === 'model'
        ? { ...event, summary: 'provider requested model work' }
        : event;
    }
  }
}

// The execution port is the only boundary that sees the provider binding's own
// request identity, so it is the independent oracle for the trace projection.
// This port records the identity the driver handed it and stamps a fixed
// provider-reported occurrence time on every event, which lets a test assert the
// trace carries the values the provider reported rather than a render time.
class TurnIdentityCapturingReplayPort extends FakeReplayExecutionRuntimePort {
  readonly startIdentities: Array<{ readonly turnId?: string; readonly requestId?: string }> = [];
  readonly observeIdentities: Array<{ readonly turnId?: string; readonly requestId?: string }> = [];
  readonly providerOccurredAt = '2026-10-06T08:00:00.000Z';

  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    // The driver spreads its request identity into the port input; the declared
    // start input type does not name those fields, so read them structurally.
    const identity = input as ProviderStartInput & { readonly turnId?: string; readonly requestId?: string };
    this.startIdentities.push({ turnId: identity.turnId, requestId: identity.requestId });
    return super.start(input);
  }

  override async *observe(
    input: Parameters<ExecutionRuntimePort['observe']>[0],
  ): AsyncIterable<ProviderEvent> {
    this.observeIdentities.push({ turnId: input.turnId, requestId: input.requestId });
    for await (const event of super.observe(input)) {
      yield { ...event, occurredAt: this.providerOccurredAt };
    }
  }
}

function queuedDraftRow(list: ReturnType<UiRuntimeService['listTasks']>, draftId: string) {
  const row = list.draft.find((task) => task.taskId.value === `ui-task-implicit-${draftId}`);
  if (!row) throw new Error(`missing queued draft row for ${draftId}`);
  return row;
}

// Confirms one explicit requirement through the real service owner so FIFO
// lifecycle tests share one deterministic producer instead of duplicating the
// interaction state machine.
async function confirmExplicitRequirementFor(
  service: UiRuntimeService,
  suffix: string,
  targetTaskId?: TaskId,
): Promise<string> {
  const interactionId = await service.receiveExplicitInput({
    sourceRef: `ui:${suffix}`,
    rawInput: `confirmed requirement ${suffix}`,
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: `confirmed requirement ${suffix}`,
    matchedTasks: targetTaskId === undefined
      ? []
      : [{ taskId: targetTaskId, relation: 'current', status: 'waiting' }],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: targetTaskId === undefined ? 'create' : 'append',
    proposal: `${targetTaskId === undefined ? 'create' : 'append'} ${suffix} work`,
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${suffix}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-03T00:00:00.000Z',
    payloadRef: `asset://requirements/${suffix}`,
  });
  return interactionId;
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

class CapturingRuntimeEventJournal extends UiRuntimeJournal {
  readonly appendErrors: unknown[] = [];
  readonly operationEvents: Array<{
    readonly seq: number;
    readonly kind: string;
    readonly summary: unknown;
    readonly outputRefs?: readonly string[];
  }> = [];

  override append(record: RuntimeTaskJournalRecord): void {
    if (record.kind === 'operation.event') {
      this.operationEvents.push({
        seq: record.event.seq,
        kind: record.event.kind,
        summary: (record.event as { readonly summary?: unknown }).summary,
        ...(record.event.outputRefs === undefined ? {} : { outputRefs: record.event.outputRefs }),
      });
    }
    try {
      super.append(record);
    } catch (error) {
      this.appendErrors.push(error);
      throw error;
    }
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
    await grantRuntimeTask(runtime, task.taskId, join(root, 'checkpoints'), 'fake');
    memory.addContextEntry({
      scope: { kind: 'task', organId, taskId: task.taskId },
      sourceRef: 'journal://ui-memory/current',
      sourceDigest: 'sha256:ui-memory-current',
      text: 'deterministic memory binding evidence',
      layer: 'current',
      summary: 'deterministic memory binding evidence',
    });

    const started = await runtime.service.startExecution(task.taskId, { prompt: 'recall memory' });
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
    await grantRuntimeTask(runtime, task.taskId, join(root, 'checkpoints'), 'fake');
    const started = await runtime.service.startExecution(task.taskId, { prompt: 'recall approved long-term memory' });
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
    await grantRuntimeTask(runtime, task.taskId, join(root, 'checkpoints'), 'fake');
    const started = await runtime.service.startExecution(task.taskId, { prompt: 'recall with a narrowed grant' });
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
    runtimeComposition: { admitExecution: async () => {} },
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'project-ui-memory-stale',
      roleId: 'execution',
    },
  });
  const task = service.createTask({ title: 'stale memory epoch' });
  const first = await service.startExecution(task.taskId, { prompt: 'first epoch' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  const second = await service.startExecution(task.taskId, { prompt: 'second epoch' });
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
    await grantRuntimeTask(runtime, id('task', task.taskId.value), join(root, 'checkpoints'), 'fake');
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
    await grantRuntimeTask(runtime, id('task', task.taskId.value), join(root, 'checkpoints'), 'fake');
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

    const legacyProbe = await fetch(`${runtime.server.url}/api/health/probe`);
    assert.equal(legacyProbe.status, 405);
    assert.equal(legacyProbe.headers.get('allow'), 'POST');
    assert.equal(probeCount, 0);

    const probeResponse = await fetch(`${runtime.server.url}/api/health/probe`, { method: 'POST' });
    assert.equal(probeResponse.status, 200);
    assert.equal(probeCount, 1);

    const requests = [
      fetch(`${runtime.server.url}/api/health/probe`, { method: 'POST' }),
      fetch(`${runtime.server.url}/api/health/snapshot`),
    ];
    for (const response of await Promise.all(requests)) {
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
    const response = await fetch(`${runtime.server.url}/api/health/probe`, { method: 'POST' });
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
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  const server = await startUiRuntimeServer({
    service,
    accessControl,
    productRoot: root,
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    port: 0,
  });
  testSessionByOrigin.set(new URL(server.url).origin, accessControl.sessionCookie(session).split(';')[0]!);
  try {
    const response = await fetch(`${server.url}/api/health/probe`, { method: 'POST' });
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
  const started = await service.startExecution(task.taskId, { prompt: 'run fake replay' });

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
    'provider.model',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.output',
    'execution.terminal',
    'provider.model',
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
  assert.match(selected.toolSteps[0]?.returned ?? '', /status=unknown · call=tool: fake:\/\/tool\/1/);
  assert.equal(selected.toolSteps[0]?.name, '未标注工具');
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

test('provider tool-result output stays out of task output while remaining visible in the event stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-provider-tool-result-output-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [
      { kind: 'tool', state: 'tool', summary: 'file.read', outputRefs: ['fake://tool/1'] },
      { kind: 'tool', state: 'tool', toolPhase: 'result', summary: 'file.read succeeded', outputRefs: ['fake://tool-result/1'] },
      { kind: 'output', state: 'output', summary: 'REAL_FILE_CONTENT', outputRefs: ['fake://output/1'] },
      { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
    ],
  }));
  const task = service.createTask({ title: 'provider tool result', directive: 'keep tool completions out of task output' });
  const started = await service.startExecution(task.taskId, { prompt: 'read a file and return it' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.output, 'REAL_FILE_CONTENT');
  assert.equal(dashboard.output.includes('file.read succeeded'), false);
  assert.deepEqual(dashboard.checkpoint?.outcome, 'succeeded');

  const events = service.eventsSince(started.operationId);
  assert.equal(events.some((event) => event.kind === 'provider.tool' && event.summary === 'tool: fake://tool/1'), true);
  assert.equal(events.some((event) => event.kind === 'provider.tool-result' && event.summary === 'file.read succeeded'), true);
  assert.equal(events.some((event) => event.kind === 'provider.tool' && event.summary === 'file.read succeeded'), false);
  assert.equal(events.some((event) => event.kind === 'provider.output' && event.summary === 'REAL_FILE_CONTENT'), true);
});

test('observation pairs provider tool calls with results by callId and uses toolId as the display name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-tool-callid-pair-'));
  const port = new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [
      {
        kind: 'tool',
        state: 'tool',
        summary: 'file.search call',
        outputRefs: ['fake://tool-call/1'],
        toolCall: { callId: 'call-1', toolId: 'file.search', arguments: { path: '.', query: 'marker', queryKind: 'literal' }, continuationRef: 'responses-tool-call' },
      },
      { kind: 'terminal', state: 'tool-waiting', summary: 'provider awaits the tool result', terminalState: 'waiting', nextAction: { kind: 'continue', ref: 'responses-tool-call' } },
      { kind: 'output', state: 'output', summary: 'final answer', outputRefs: ['fake://output/1'] },
      { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
    ],
  });
  const runtimeJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    journal: runtimeJournal,
    closurePort: runtimeJournal,
    memory: testMemory('project-ui-tool-result'),
    runtimeComposition: { admitExecution: async () => {} },
    providerTools: [RESPONSES_FILE_SEARCH_TOOL],
    providerToolExecutor: {
      async execute() {
        return {
          output: JSON.stringify([]),
          outputRefs: ['fake://tool-result/1'],
          evidenceRefs: [evidence('result', { organId })],
          outputRef: 'fake://tool-result/1',
          outputDigest: 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        };
      },
    },
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
  });
  const task = service.createTask({ title: 'tool call pairing', directive: 'pair call and result' });
  await service.startExecution(task.taskId, { prompt: 'pair the tool round' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const executeNode = service.observation(task.taskId).nodes.find((node) => node.nodeId === 'pipeline.execute');
  if (!executeNode) throw new Error('expected pipeline.execute node');
  assert.equal(executeNode.toolSteps.length, 1);
  assert.equal(executeNode.toolSteps[0]?.name, 'file.search');
  assert.equal(executeNode.toolSteps[0]?.status, 'succeeded');
  assert.match(executeNode.toolSteps[0]?.returned ?? '', /outputRef=fake:\/\/tool-result\/1/);
  assert.match(executeNode.toolSteps[0]?.returned ?? '', /arguments=.*marker/);
  assert.match(executeNode.toolSteps[0]?.returned ?? '', /durationMs=/);
  assert.equal(executeNode.toolSteps[0]?.stepId, 'call-1');
});

test('task dashboard exposes full history with hasMore and no status-layer contradiction after success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-dashboard-history-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [
      ...Array.from({ length: 24 }, (_, index) => ({ kind: 'model' as const, state: 'model', summary: `model ${index + 1}` })),
      { kind: 'output', state: 'output', summary: 'history final output', outputRefs: ['fake://output/1'] },
      { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
    ],
  }));
  const task = service.createTask({ title: 'dashboard history', directive: 'show all history windows' });
  await service.startExecution(task.taskId, { prompt: 'show history' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const dashboard = service.taskDashboard(task.taskId);
  // Full typed trajectory is carried for paging; the recent-events summary stays bounded.
  assert.equal(dashboard.history.events.length, dashboard.history.total);
  assert.equal(dashboard.history.events.length > 20, true);
  assert.equal(dashboard.recentEvents.length, 20);
  assert.equal(dashboard.history.hasMore, true);
  assert.equal(dashboard.history.omitted, dashboard.history.total - 20);
  assert.equal(dashboard.history.events[0]!.seq < dashboard.recentEvents[0]!.seq, true);
  assert.match(dashboard.statusSections.business, /已完成/);
  assert.match(dashboard.statusSections.waiting, /收拢/);
  assert.equal(dashboard.statusSections.business.includes('尚未提交'), false);
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
  await service.startExecution(task.taskId, { prompt: 'observe thirteen nodes' });
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
  assert.match(executeNode.toolSteps[0]?.returned ?? '', /status=unknown · call=tool: fake:\/\/tool\/1/);
  assert.equal(executeNode.toolSteps[0]?.name, '未标注工具');
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
  const queuedList = service.listTasks();
  assert.equal(queuedList.counts.total, 1);
  const queuedRow = queuedDraftRow(queuedList, 'draft-1');
  assert.equal(queuedRow.requirementAdmission, 'queued');
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');

  const dispatched = await service.dispatchNextExplicitRequirement();
  assert.equal(dispatched.requirement.requirementId, 'requirement:draft-1:1');
  assert.equal(dispatched.taskId.value, queuedRow.taskId.value);
  assert.equal(service.taskDashboard(queuedRow.taskId).taskId.value, queuedRow.taskId.value);
  assert.equal(service.listTasks().draft.some((row) => row.taskId.value === queuedRow.taskId.value), false);
  assert.equal(service.status().implicitScheduling, undefined);
});

test('queued requirement row resolves through taskDashboard before and after dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-queued-dashboard-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:queued-dashboard',
    rawInput: 'resolve the queued row through the dashboard route',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'resolve the queued row through the dashboard route',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create queued dashboard evidence',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:queued-dashboard',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-23T02:00:00.000Z',
    payloadRef: 'asset://requirements/queued-dashboard',
  });

  const queuedRow = queuedDraftRow(service.listTasks(), 'draft-1');
  assert.equal(queuedRow.taskId.value, 'ui-task-implicit-draft-1');
  const queuedDashboard = service.taskDashboard(queuedRow.taskId);
  assert.equal(queuedDashboard.taskId.value, queuedRow.taskId.value);
  assert.equal(queuedDashboard.state, 'created');
  assert.equal(queuedDashboard.currentNode, 'implicit.classify');
  const queuedDetail = service.taskDetail(queuedRow.taskId);
  assert.equal(queuedDetail.taskId.value, queuedRow.taskId.value);
  assert.equal(queuedDetail.state, 'ready');
  assert.equal(queuedDetail.currentState, queuedRow.currentState);
  const queuedObservation = service.observation(queuedRow.taskId);
  assert.equal(queuedObservation.scope.scopeRef, `task://${queuedRow.taskId.value}/observation`);

  const dispatched = await service.dispatchNextExplicitRequirement();
  assert.equal(dispatched.requirement.requirementId, 'requirement:draft-1:1');
  const dispatchedDashboard = service.taskDashboard(dispatched.taskId);
  assert.equal(dispatchedDashboard.taskId.value, queuedRow.taskId.value);
  assert.equal(dispatchedDashboard.state === 'created', false);
  assert.equal(service.listTasks().draft.some((row) => row.taskId.value === queuedRow.taskId.value), false);
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
  assert.equal(service.listTasks().counts.total, 1);
  assert.equal(queuedDraftRow(service.listTasks(), 'draft-1').requirementAdmission, 'queued');

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
  const backlogList = service.listTasks();
  assert.equal(backlogList.counts.total, 2);
  assert.equal(queuedDraftRow(backlogList, 'draft-1').requirementAdmission, 'queued');
  assert.equal(queuedDraftRow(backlogList, 'draft-2').requirementAdmission, 'queued');
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
    assert.equal(tasks.counts.total, 2);
    assert.equal(tasks.draft.some((row) => row.taskId.value === 'ui-task-implicit-draft-1' && row.requirementAdmission === 'queued'), true);
    assert.equal(tasks.draft.some((row) => row.taskId.value === 'ui-task-implicit-draft-2' && row.requirementAdmission === 'queued'), true);
  } finally {
    await runtime.server.close();
  }
});

test('0045 3a first closing outcome preserves recovery facts and historical frozen outcomes', () => {
  const live = {
    source: 'live' as const,
    status: 'succeeded' as const,
    acceptedEnd: true,
    producerDrained: true,
    unreturnedCallRefs: [] as readonly string[],
    unresolvedOperationRefs: [] as readonly string[],
    permissionRevoked: false,
    hardBlockers: [] as readonly string[],
  };
  assert.equal(resolveStandardTurnClosingOutcome(live), 'succeeded');
  assert.equal(resolveStandardTurnClosingOutcome({
    ...live,
    unreturnedCallRefs: ['request:unreturned'],
  }), 'unknown');
  assert.equal(resolveStandardTurnClosingOutcome({
    ...live,
    unresolvedOperationRefs: ['operation:unresolved'],
  }), 'unknown');
  assert.equal(resolveStandardTurnClosingOutcome({ ...live, permissionRevoked: true }), 'blocked');
  assert.equal(resolveStandardTurnClosingOutcome({ ...live, hardBlockers: ['blocker:hard'] }), 'blocked');
  assert.equal(resolveStandardTurnClosingOutcome({ ...live, firstErrorRef: 'error:first' }), 'waiting');
  assert.equal(resolveStandardTurnClosingOutcome({ ...live, status: 'failed' }), 'failed');
  assert.equal(resolveStandardTurnClosingOutcome({ ...live, status: 'cancelled' }), 'cancelled');
  assert.equal(resolveStandardTurnClosingOutcome({ ...live, acceptedEnd: false }), 'unknown');
  assert.equal(resolveStandardTurnClosingOutcome({ ...live, producerDrained: false }), 'unknown');
  assert.equal(resolveStandardTurnClosingOutcome({
    source: 'retained',
    frozenOutcome: 'waiting',
  }), 'waiting', 'a historical frozen waiting close is never upgraded');
});

test('cross-turn preparation occupies budget and final completion wakes FIFO without charging manual grant wait', async () => {
  // Source gap: admission counts running/settling only and watches only the
  // first operation. Probability is unknown; impact is over-admission or a
  // stranded FIFO head. One local consumer/latch costs no provider requests.
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-cross-turn-'));
  let releaseSecond!: () => void;
  let secondEntered!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const secondPreparing = new Promise<void>((resolve) => { secondEntered = resolve; });
  const grants = new JsonlTaskGrantJournal(new JsonlOrganJournal(join(root, 'grants.jsonl')));
  const journal = new UiRuntimeJournal(join(root, 'runtime.jsonl'));
  // The coordinator reads the durable receipt relationship of every committed
  // native closing checkpoint. The fixture therefore commits through the same
  // native checkpoint owner the product uses, instead of a bare file store.
  // Each task cycle owns its own checkpoint journal, exactly like the product
  // layout, so every cycle's closing checkpoint is that chain's root.
  const checkpointStores = new Map<string, ServiceExecutionCheckpointStore>();
  const checkpointStore = (taskId: { value: string }, cycleId: { value: string }) => {
    const filePath = join(root, `${taskId.value}-${cycleId.value}.jsonl`);
    let store = checkpointStores.get(filePath);
    if (store === undefined) {
      store = new ServiceExecutionCheckpointStore(filePath, new JsonlOrganJournal(filePath), () => new Date());
      checkpointStores.set(filePath, store);
    }
    return store;
  };
  const factories: RuntimeExecutionAllocation[] = [];
  const phases = new Map<string, 'open' | 'aligned'>();
  const service = new UiRuntimeService({
    mode: 'fake', organId, binding,
    port: new FakeReplayExecutionRuntimePort({ binding }),
    checkpointStoreFor: checkpointStore,
    attentionPort: attentionPort(), providerState: 'ready', journal, closurePort: journal,
    memory: testMemory('project-ui-test'), maxConcurrentTasks: 1, taskGrantPort: grants,
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    runtimeComposition: { createExecutionPorts: () => ({
      admitExecution: async () => {},
      currentStatePort: createJsonlRuntimeTaskCurrentStateJournal({ journal: new JsonlOrganJournal(join(root, 'current-state.jsonl')) }),
      currentStateFacts: { async read({ taskId }) { return { state: 'known', value: {
        turn: { phase: phases.get(taskId.value) ?? 'open', ownerRef: `fixture:${taskId.value}`,
          nextAction: { kind: 'continue' }, laterErrorRefs: [], unresolvedOperationRefs: [] },
        stages: { state: 'known', stages: [] },
      } }; } },
      createDriver: async (allocation): Promise<RuntimeExecutionDriver> => {
        factories.push(allocation);
        const turn = factories.filter((entry) => entry.taskId.value === allocation.taskId.value).length;
        if (turn === 2) { secondEntered(); await secondGate; }
        const { scope, taskId, executionEpoch, runtimeId, assignmentId } = allocation;
        phases.set(taskId.value, 'open');
        const refs = [evidence(`cross-turn-${factories.length}`, scope)];
        const identity = { turnId: `turn-${executionEpoch}`, workAssignmentRef: assignmentId,
          taskRef: taskId, scopeRef: scope, cycleRef: scope.cycleId!, inputRevision: 1,
          directiveRevision: 1, executionEpoch, runtimeBindingRef: runtimeId, permissionRevision: '1' };
        const checkpoint: Checkpoint = { id: id('checkpoint', `cross-turn-${factories.length}`), scope,
          cycleId: scope.cycleId!, seq: 1, previousCheckpointId: null, directiveRevision: 1,
          executionEpoch, outcome: 'succeeded', summary: 'turn closed', recoveryStateRef: refs[0]!,
          evidenceRefs: refs, next: { kind: 'continue' } };
        const summary = { goal: { text: 'finish task', evidenceRefs: refs },
          actions: { text: 'execute turn', evidenceRefs: refs }, result: { text: 'turn done', evidenceRefs: refs },
          expectedNextStep: { text: turn === 1 ? 'continue task' : 'complete task', evidenceRefs: refs } };
        const continues = taskId.value === 'ui-task-implicit-draft-2' && turn === 1;
        const decision = continues ? 'continue' as const : 'complete' as const;
        const alignment = { identity, checkpointId: checkpoint.id, closureRef: 'closure:test',
          planRevisionId: `plan-${executionEpoch}`, planRevisionSequence: turn,
          planContentDigest: 'sha256:fixture' as const, decision, alignedAt: '2026-10-17T00:00:00.000Z' };
        return {
          kind: 'cross-turn-fixture',
          async capabilities() { return { driverKind: 'cross-turn-fixture', capabilities: [], version: '1' }; },
          async start() { return { runtimeId, executionEpoch }; },
          async resume() { return { runtimeId, executionEpoch }; },
          async submit(input) { return { ...input, outputRefs: [], evidenceRefs: refs }; },
          async *observe() { yield { taskId, executionEpoch, kind: 'terminal', terminalState: 'succeeded', evidenceRefs: refs }; },
          async requestStop(input) { return { requested: true, operationId: input.operationId }; },
          async settle() { return { state: 'succeeded', evidenceRefs: refs }; },
          async close() { return { ...binding, state: 'closed', evidenceRefs: refs }; },
          standardTurn: {
            async acceptReviews() {},
            async readCheckpoint() {
              // A closing checkpoint is only adoptable with its durable native
              // receipt relationship, so the fixture commits the exact record
              // through the same native owner the product uses.
              const relationship = await checkpointStore(taskId, scope.cycleId!).commitNativeCheckpoint({
                ownerId: 'humanagent.test-fixture',
                checkpoint,
                timeAuthority: { source: 'harness', owner: 'runtime-checkpoint-control-owner',
                  authorityRef: `fixture:${checkpoint.id.value}`,
                  sampleCommittedAt: async () => '2026-10-17T00:00:00.000Z' },
              });
              return { checkpoint, previous: null,
                commitRef: { commitId: relationship.receipt.commitIdentity,
                  journalSeq: relationship.journalSeq, recordDigest: relationship.recordDigest } };
            },
            async align() { phases.set(taskId.value, 'aligned'); return { advanced: continues, state: continues ? 'advancing' : 'terminal', reason: 'aligned', decision, alignment,
              admission: { state: 'closed', decision, alignment, closure: { identity, checkpointId: checkpoint.id,
                closureRef: 'closure:test', summary, recoveryStateRef: refs[0]!, closedAt: '2026-10-17T00:00:00.000Z' } } }; },
            async readDelivery() {
              const bytes = new TextEncoder().encode('task complete');
              const asset = { ref: refs[0]!, view: { kind: 'utf8-text' as const } };
              return { assignment: { assignmentId, taskId, pipelineNodeId: 'pipeline.execute', attempt: 1, executionEpoch,
                inputRevision: 1, objective: 'finish task', targetRefs: [], expectedOutputRefs: [],
                successCriteria: [], failureCriteria: [], incompleteCriteria: [], requiredCapabilities: [], mergeGate: 'not-required' },
                acceptedEnd: { kind: 'standard-turn-end', identity, summary, deliveryText: 'task complete', deliveryRefs: [], resolvedEvidenceRefs: [] },
                materials: [{ kind: 'delivery-text', deliveryEvidence: refs[0]!, rawArguments: asset, bodyAsset: asset,
                  bytes, digest: 'sha256:fixture', sourceEvidence: refs,
                  acceptedEndCall: { seq: 1, envelope: { execution: { runtimeId, taskId, executionEpoch }, scope,
                    request: { turnId: identity.turnId, requestId: 'request-end' }, producerSeq: 1,
                    fact: { kind: 'tool-call', contentUnitId: 'end', call: { callId: 'end', toolId: 'humanagent.turn.end', continuationRef: 'end-continuation', arguments: {} }, rawArguments: asset, complete: true } } } }],
              };
            },
          },
        };
      },
    }) },
  });
  try {
    const manualTarget = service.createTask({ title: 'manual grant wait' });
    await confirmExplicitRequirementFor(service, 'manual-grant-wait', manualTarget.taskId);
    const manual = await service.dispatchNextExplicitRequirement();
    assert.equal(manual.taskId.value, manualTarget.taskId.value);
    // A confirmed create now binds its verified execution grant, so the only
    // remaining ungranted requirement is an existing-task change. It stays a
    // queued draft against its idle target: no operation is allocated and no
    // driver is created, so it never charges the single task slot.
    assert.equal(service.listTasks().draft.some((row) => row.taskId.value === manualTarget.taskId.value
      && row.requirementAdmission === 'queued'), true,
    'the ungranted change stays a queued draft on its exact target');
    assert.equal(service.taskDetail(manual.taskId).state, 'ready');
    assert.equal(factories.length, 0, 'a confirmed requirement that never starts must not create a driver');
    for (const draft of [2, 3]) {
      const taskId = id('task', `ui-task-implicit-draft-${draft}`);
      await grants.grant({ requestId: `grant-${draft}`, taskId, owner: 'human:operator', expectedRevision: 0,
        capability: { actionId: TASK_EXECUTION_ACTION_ID, capabilities: [TASK_EXECUTION_CAPABILITY], scope: { organId, taskId } } });
    }
    service.startImplicitConsumer();
    await confirmExplicitRequirementFor(service, 'cross-turn-A');
    const a = await service.dispatchNextExplicitRequirement();
    await secondPreparing;
    assert.equal(service.taskDetail(a.taskId).state, 'waiting');
    assert.ok(a.operationId);
    const firstFinal = service.eventsSince(a.operationId!).find((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final');
    assert.ok(firstFinal, 'turn 1 remains final for its own operation');
    const bInteraction = await confirmExplicitRequirementFor(service, 'cross-turn-B');
    await waitFor(() => assert.equal(service.implicitSchedulingIssue()?.code, 'implicit-admission.waiting'));
    assert.equal((await service.inspectExplicitInteraction(bInteraction)).state, 'confirmed');
    assert.equal(factories.length, 2, 'B must not prepare while A owns the slot');
    releaseSecond();
    await waitFor(() => {
      assert.equal(service.listTasks().counts.completed, 2);
      for (const allocation of factories.slice(1)) {
        assert.ok(service.eventsSince(allocation.operationId).some((event) => event.kind === 'execution.terminal'
          && event.terminalPhase === 'final' && event.state === 'succeeded'));
      }
    });
    assert.ok(service.listTasks().completed.some((task) => task.taskId.value === a.taskId.value));
    assert.equal((await service.inspectExplicitInteraction(bInteraction)).state, 'dispatched');
    assert.ok(service.listTasks().completed.some((task) => task.taskId.value === 'ui-task-implicit-draft-3'));
    assert.equal(service.taskDetail(manual.taskId).state, 'ready');
    assert.equal(service.listTasks().draft.some((row) => row.taskId.value === manualTarget.taskId.value
      && row.requirementAdmission === 'queued'), true,
    'the ungranted change never starts while the granted creates use the slot');
  } finally {
    releaseSecond();
    await service.quiesceImplicitConsumption();
    await waitFor(() => {
      for (const allocation of factories) {
        assert.ok(service.eventsSince(allocation.operationId).some((event) =>
          event.kind === 'execution.terminal' && event.terminalPhase === 'final'),
        `fixture operation ${allocation.operationId.value} must finish before cleanup`);
      }
    });
    await rm(root, { recursive: true, force: true });
  }
});

test('confirmed requirement drains through the FIFO-owned serve consumer after exposing a queued row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-fifo-serve-consumer-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:fifo-serve-consumer',
    rawInput: 'dispatch through the FIFO-owned serve consumer',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'dispatch through the FIFO-owned serve consumer',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create FIFO serve consumer work',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:fifo-serve-consumer',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-22T00:00:00.000Z',
    payloadRef: 'asset://requirements/fifo-serve-consumer',
  });

  const queuedBeforeDrain = service.listTasks();
  assert.equal(queuedBeforeDrain.counts.total, 1);
  const queuedRow = queuedDraftRow(queuedBeforeDrain, 'draft-1');
  assert.equal(queuedRow.requirementAdmission, 'queued');
  assert.equal(queuedRow.taskId.value, 'ui-task-implicit-draft-1');
  assert.deepEqual(service.status().implicitScheduling?.draftId, 'draft-1');

  service.startImplicitConsumer();
  await waitFor(() => {
    const drained = service.listTasks();
    assert.equal(drained.draft.length, 0);
    assert.equal(drained.completed.length, 1);
    assert.equal(drained.completed[0]?.requirementAdmission, 'completed');
    assert.equal(drained.completed[0]?.requirementQueue, 'execution');
  });
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');
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

  // Draining is scheduled behind a short visibility window, so the confirming
  // response returns while the requirement is still a genuine FIFO entry.
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
  const queuedList = service.listTasks();
  assert.equal(queuedList.counts.total, 1);
  assert.equal(queuedDraftRow(queuedList, 'draft-1').requirementAdmission, 'queued');

  await waitFor(() => assert.equal(service.listTasks().counts.total, 1));
  await waitFor(() => assert.equal(service.status().implicitScheduling, undefined));
});

test('confirmed requirement is HTTP-observable as queued before the implicit consumer drains it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-queued-http-window-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: 'project-ui-queued-http-window',
    workspaceRoot: root,
    memory: testMemory('project-ui-queued-http-window'),
  });
  try {
    // Let the starter implicit-consumer wake finish before exercising confirm,
    // so the queued observations we sample below belong to the confirmation.
    await new Promise((resolve) => setTimeout(resolve, 120));

    const post = async (path: string, body: unknown): Promise<Response> => fetch(`${runtime.server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const receive = await post('/api/explicit/inputs', {
      sourceRef: 'ui:queued-http-window',
      rawInput: 'observe this requirement through HTTP while it is queued',
      channel: 'business',
    });
    assert.equal(receive.status, 201);
    const { interactionId } = await receive.json() as { readonly interactionId: string };
    await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/matching`, {});
    const match = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/match`, {
      normalizedInput: 'observe this requirement through HTTP while it is queued',
      matchedTasks: [],
      knownFacts: [],
    });
    assert.equal(match.status, 202);
    const proposal = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/proposal`, {
      proposedIntent: 'create',
      proposal: 'create the HTTP queued visibility requirement',
    });
    assert.equal(proposal.status, 202);
    const interactionResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}`);
    const interaction = await interactionResponse.json() as { readonly draft?: { readonly draftId: string } };
    assert.ok(interaction.draft);
    const confirmation = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/confirmation`, {
      draftId: interaction.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:http-queued-window',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-22T00:00:00.000Z',
      payloadRef: 'asset://requirements/http-queued-window',
    });
    assert.equal(confirmation.status, 200);
    const access = runtimeAccessControl.get(runtime);
    if (access === undefined) throw new Error('the HTTP fixture must retain its access-control owner');
    const confirmedInteraction = await runtime.service.inspectExplicitInteraction(interactionId) as {
      readonly confirmation?: { readonly confirmedBy: string };
    };
    assert.equal(confirmedInteraction.confirmation?.confirmedBy, access.readProductPrincipalOwner(),
      'the confirmation route binds the verified product principal');
    assert.equal(confirmedInteraction.confirmation?.confirmedBy === 'human:operator', false,
      'a client-supplied confirmedBy is ignored');

    const statusResponse = await fetch(`${runtime.server.url}/api/runtime/status`);
    const status = await statusResponse.json() as ReturnType<UiRuntimeService['status']>;
    assert.equal(status.implicitScheduling?.state, 'queued');
    assert.equal(status.implicitScheduling?.code, 'explicit-brain.requirement-queued');
    assert.equal(status.implicitScheduling?.draftId, 'draft-1');

    const tasksResponse = await fetch(`${runtime.server.url}/api/tasks`);
    const tasks = await tasksResponse.json() as ReturnType<UiRuntimeService['listTasks']>;
    assert.equal(tasks.counts.total, 1);
    const queuedRow = queuedDraftRow(tasks, 'draft-1');
    assert.equal(queuedRow.requirementAdmission, 'queued');

    const detailResponse = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(queuedRow.taskId.value)}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as ReturnType<UiRuntimeService['taskDetail']>;
    assert.equal(detail.taskId.value, queuedRow.taskId.value);

    await waitFor(() => assert.equal(runtime.service.status().implicitScheduling, undefined));
  } finally {
    await runtime.server.close();
  }
});

test('explicit input with a matching workspace records the resolved project and interprets with the project directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-workspace-match-'));
  const controlRoot = join(root, 'control');
  const workspaceDir = join(root, 'workspace-project');
  await mkdir(workspaceDir, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace: workspaceDir });
  await ensureControlLayout(paths);
  const interpreted: Array<ExplicitBrainInterpretationInput & { readonly workspaceCwd?: string; readonly projectKey?: string }> = [];
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: paths.projectKey,
    workspaceRoot: paths.workspaceCwd,
    runtimePaths: paths,
    explicitBrainInterpreter: {
      async interpret(input) {
        interpreted.push(input);
        return {
          kind: 'requirement',
          normalizedInput: input.rawInput,
          knownFacts: [],
          intent: 'create',
          proposal: `create:${input.rawInput}`,
          structuredProposal: {
            revision: input.inputRevision,
            intent: 'create',
            title: input.rawInput,
            objective: input.rawInput,
            deliverable: `create:${input.rawInput}`,
            deliveryConditions: [],
            evidenceRefs: [],
            blockingGaps: [],
          },
          decisionRefs: ['decision:workspace-match'],
        };
      },
    },
    memory: testMemory(paths.projectKey),
  });
  try {
    const response = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:workspace-match',
        rawInput: '在项目目录里整理状态',
        channel: 'business',
        workspace: paths.workspaceCwd,
      }),
    });
    assert.equal(response.status, 201);
    const { interactionId } = await response.json() as { readonly interactionId: string };
    const snapshot = await runtime.service.inspectExplicitInteraction(interactionId) as WorkspaceCarryingInteractionSnapshot;
    assert.deepEqual(snapshot.workspace, { workspaceCwd: paths.workspaceCwd, projectKey: paths.projectKey });
    // The interaction stays inside the serve-bound project scope.
    assert.equal(snapshot.workspace?.projectKey, paths.projectKey);
    await runtime.service.interpretExplicitInput({ interactionId });
    assert.equal(interpreted.length, 1);
    assert.equal(interpreted[0]?.workspaceCwd, paths.workspaceCwd);
    assert.equal(interpreted[0]?.projectKey, paths.projectKey);
    // The requirement is proposed inside the serve-bound runtime; execution
    // keeps using the serve-bound project rather than the input workspace.
    const proposed = await runtime.service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    assert.equal(proposed.state, 'awaiting-confirmation');
  } finally {
    await runtime.server.close();
  }
});

test('explicit input with a workspace outside the serve-bound project is a typed rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-workspace-outside-'));
  const controlRoot = join(root, 'control');
  const serveWorkspace = join(root, 'workspace-serve');
  await mkdir(serveWorkspace, { recursive: true });
  const otherWorkspace = join(root, 'workspace-other');
  await mkdir(otherWorkspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace: serveWorkspace });
  await ensureControlLayout(paths);
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: paths.projectKey,
    workspaceRoot: paths.workspaceCwd,
    runtimePaths: paths,
    memory: testMemory(paths.projectKey),
  });
  try {
    const response = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:workspace-outside',
        rawInput: '整理另一个项目的状态',
        channel: 'business',
        workspace: otherWorkspace,
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { readonly error: { readonly code: string; readonly message: string; readonly nextAction: string } };
    assert.equal(body.error.code, 'explicit-brain.workspace-outside-serve-scope');
    assert.match(body.error.message, new RegExp(otherWorkspace));
    assert.match(body.error.nextAction, /serve/);
    assert.equal(await runtime.service.inspectExplicitInteraction('interaction-does-not-exist').catch(() => undefined), undefined);
  } finally {
    await runtime.server.close();
  }
});

test('explicit input without a workspace keeps the serve-bound default without regression', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-workspace-default-'));
  const controlRoot = join(root, 'control');
  const workspaceDir = join(root, 'workspace-default');
  await mkdir(workspaceDir, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace: workspaceDir });
  await ensureControlLayout(paths);
  const interpreted: Array<ExplicitBrainInterpretationInput & { readonly workspaceCwd?: string; readonly projectKey?: string }> = [];
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: paths.projectKey,
    workspaceRoot: paths.workspaceCwd,
    runtimePaths: paths,
    explicitBrainInterpreter: {
      async interpret(input) {
        interpreted.push(input);
        return {
          kind: 'answer',
          normalizedInput: input.rawInput,
          knownFacts: [],
          answer: 'default workspace behavior stays intact',
          decisionRefs: ['decision:workspace-default'],
        };
      },
    },
    memory: testMemory(paths.projectKey),
  });
  try {
    const response = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:workspace-default',
        rawInput: '不带 workspace 的默认对话',
        channel: 'business',
      }),
    });
    assert.equal(response.status, 201);
    const { interactionId } = await response.json() as { readonly interactionId: string };
    const snapshot = await runtime.service.inspectExplicitInteraction(interactionId) as WorkspaceCarryingInteractionSnapshot;
    assert.equal(snapshot.workspace, undefined);
    await runtime.service.interpretExplicitInput({ interactionId });
    assert.equal(interpreted.length, 1);
    assert.equal(interpreted[0]?.workspaceCwd, undefined);
    assert.equal(interpreted[0]?.projectKey, undefined);
  } finally {
    await runtime.server.close();
  }
});

test('explicit input rejects a relative workspace independently of the serve cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-workspace-relative-'));
  const controlRoot = join(root, 'control');
  const workspaceDir = join(root, 'workspace-relative');
  await mkdir(workspaceDir, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace: workspaceDir });
  await ensureControlLayout(paths);
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: paths.projectKey,
    workspaceRoot: paths.workspaceCwd,
    runtimePaths: paths,
    memory: testMemory(paths.projectKey),
  });
  try {
    // A relative workspace would otherwise resolve against the serve process
    // cwd and silently record a different project depending on where serve
    // started, so it is rejected as invalid input.
    for (const workspace of ['.', '..', 'relative/project']) {
      const response = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceRef: `ui:workspace-relative:${workspace}`,
          rawInput: '相对 workspace 的输入',
          channel: 'business',
          workspace,
        }),
      });
      assert.equal(response.status, 400);
      const body = await response.json() as { readonly error: { readonly code: string; readonly nextAction: string } };
      assert.equal(body.error.code, 'workspace-selection-invalid');
      assert.equal(typeof body.error.nextAction, 'string');
    }
    assert.equal(runtime.service.listTasks().counts.total, 0);
  } finally {
    await runtime.server.close();
  }
});

test('explicit input rejects a nonexistent workspace with a typed client error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-workspace-missing-'));
  const controlRoot = join(root, 'control');
  const workspaceDir = join(root, 'workspace-missing-bound');
  await mkdir(workspaceDir, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace: workspaceDir });
  await ensureControlLayout(paths);
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
    projectKey: paths.projectKey,
    workspaceRoot: paths.workspaceCwd,
    runtimePaths: paths,
    memory: testMemory(paths.projectKey),
  });
  try {
    // A rejected input workspace must keep the config owner's code and recovery
    // instruction instead of collapsing into a generic 500.
    const response = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:workspace-missing',
        rawInput: '不存在的 workspace 目录',
        channel: 'business',
        workspace: join(root, 'does-not-exist'),
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { readonly error: { readonly code: string; readonly ownerId: string; readonly nextAction: string } };
    assert.equal(body.error.code, 'workspace-selection-invalid');
    assert.equal(body.error.ownerId, 'config-loader');
    assert.equal(typeof body.error.nextAction, 'string');
    assert.ok(body.error.nextAction !== 'inspect the runtime error and retry from a new operation');
    assert.equal(runtime.service.listTasks().counts.total, 0);
  } finally {
    await runtime.server.close();
  }
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
  const confirmedList = service.listTasks();
  assert.equal(confirmedList.counts.total, 1);
  assert.equal(queuedDraftRow(confirmedList, 'draft-1').requirementAdmission, 'queued');
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
  const dispatchedOperationId = dispatched.operationId;
  if (dispatchedOperationId === undefined) throw new Error('the dispatched requirement carries no operation identity');
  const events = service.eventsSince(dispatchedOperationId);
  assert.deepEqual(events.map((event) => event.kind), [
    'execution.started',
    'provider.model',
    'provider.model',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.output',
    'execution.terminal',
    'provider.model',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ]);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('typed existing-task-change fails closed on a missing or mismatched target and submits only the exact target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-existing-change-'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 1 });
  const grantJournal = new JsonlTaskGrantJournal(
    new JsonlOrganJournal(join(root, 'fake', 'task-grants.jsonl')),
  );
  let matchedTaskId = '';
  const service = serviceFor(root, port, 'fake', 'ready', undefined, undefined, undefined, undefined, {
    async interpret(input) {
      return {
        kind: 'requirement',
        normalizedInput: 'change this task',
        matchedTaskId,
        knownFacts: [],
        intent: 'change',
        proposal: 'change the existing task',
        structuredProposal: {
          revision: input.inputRevision,
          intent: 'change',
          title: 'change this task',
          objective: 'change this task',
          deliverable: 'change the existing task',
          deliveryConditions: [],
          evidenceRefs: [],
          blockingGaps: [],
        },
        decisionRefs: [],
      };
    },
  }, undefined, grantJournal);
  const target = service.createTask({ title: 'existing change target' });
  matchedTaskId = target.taskId.value;

  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:existing-change',
    rawInput: 'change this task',
    channel: 'business',
    requestKind: 'existing-task-change',
  });
  await service.interpretExplicitInput({ interactionId });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  assert.ok(proposed.revision);
  const draftId = proposed.draft!.draftId;
  const draftRevisionVersion = proposed.revision!.revisionVersion;
  const draftRevisionHash = proposed.revision!.revisionHash;

  const tasksBefore = service.listTasks().counts.total;
  await assert.rejects(
    () => service.confirmExplicitRequirement({
      interactionId,
      draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:existing-change-missing',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-10T00:00:00.000Z',
      payloadRef: 'asset://requirements/existing-change-missing',
      requestKind: 'existing-task-change',
      draftRevisionVersion,
      draftRevisionHash,
    }),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'explicit-brain.missing-existing-task-target'
      && error.httpStatus === 400,
  );
  await assert.rejects(
    () => service.confirmExplicitRequirement({
      interactionId,
      draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:existing-change-wrong',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-10T00:00:00.000Z',
      payloadRef: 'asset://requirements/existing-change-wrong',
      requestKind: 'existing-task-change',
      taskRef: id('task', 'not-the-selected-task'),
      draftRevisionVersion,
      draftRevisionHash,
    }),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'explicit-brain.task-target-mismatch'
      && error.httpStatus === 409,
  );
  assert.equal(service.listTasks().counts.total, tasksBefore, 'a rejected change must not enqueue a requirement');
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'awaiting-confirmation');

  // A mismatched kind on the exact revision/target/hash is rejected by the
  // runtime registration owner before any confirmation or submission mutation,
  // and the same revision stays usable with the correct kind.
  const beforeMismatch = await service.inspectExplicitInteraction(interactionId);
  await assert.rejects(
    () => service.confirmExplicitRequirement({
      interactionId,
      draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:existing-change-kind-mismatch',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-10T00:00:00.000Z',
      payloadRef: 'asset://requirements/existing-change-kind-mismatch',
      requestKind: 'new-task-create',
      draftRevisionVersion,
      draftRevisionHash,
    }),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'unauthorized-final-submit'
      && error.httpStatus === 409,
  );
  const afterMismatch = await service.inspectExplicitInteraction(interactionId);
  assert.equal(afterMismatch.state, 'awaiting-confirmation');
  assert.equal(afterMismatch.revision?.revisionHash, beforeMismatch.revision?.revisionHash);
  assert.equal(afterMismatch.confirmation, undefined);
  assert.equal(service.listTasks().counts.total, tasksBefore, 'a mismatched kind must not enqueue a requirement');
  assert.equal(port.startPayloads.length, 0, 'a mismatched kind must not dispatch');

  const receipt = await service.confirmExplicitRequirement({
    interactionId,
    draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:existing-change-exact',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-10T00:00:00.000Z',
    payloadRef: 'asset://requirements/existing-change-exact',
    idempotencyKey: 'existing-change-exact-key',
    requestKind: 'existing-task-change',
    taskRef: target.taskId,
    draftRevisionVersion,
    draftRevisionHash,
  });
  assert.equal(receipt.requirement.status, 'submitted');
  assert.equal(service.listTasks().counts.total, tasksBefore + 1, 'the exact change is queued as one visible draft row');
  const changeGrant = await grantJournal.readTaskGrant(target.taskId);
  assert.equal(changeGrant.grant, null,
    'an existing-task change never binds a new execution grant: task-scoped authority stays untouched');
  assert.equal(port.startPayloads.length, 0, 'confirmation alone must not dispatch the queued change');

  const replay = await service.confirmExplicitRequirement({
    interactionId,
    draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:existing-change-exact',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-10T00:00:00.000Z',
    payloadRef: 'asset://requirements/existing-change-exact',
    idempotencyKey: 'existing-change-exact-key',
    requestKind: 'existing-task-change',
    taskRef: target.taskId,
    draftRevisionVersion,
    draftRevisionHash,
  });
  assert.equal(replay.requirement.status, 'duplicate');
  assert.equal(service.listTasks().counts.total, tasksBefore + 1, 'replay must not append a second queued requirement');
  assert.equal(port.startPayloads.length, 0, 'replay must not dispatch the queued change');
});

test('existing-task-change on a settled task prepares one granted execution occurrence instead of only appending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-existing-change-dispatch-'));
  const grants = new JsonlTaskGrantJournal(new JsonlOrganJournal(join(root, 'grants.jsonl')));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 1 });
  let matchedTaskId = '';
  const service = serviceFor(root, port, 'fake', 'ready', undefined, undefined, undefined, undefined, {
    async interpret(input) {
      return {
        kind: 'requirement',
        normalizedInput: 'change this task',
        matchedTaskId,
        knownFacts: [],
        intent: 'change',
        proposal: 'change the existing task',
        structuredProposal: {
          revision: input.inputRevision,
          intent: 'change',
          title: 'change this task',
          objective: 'change this task',
          deliverable: 'change the existing task',
          deliveryConditions: [],
          evidenceRefs: [],
          blockingGaps: [],
        },
        decisionRefs: [],
      };
    },
  }, undefined, grants);

  try {
    const target = service.createTask({ title: 'settled change target', directive: 'seed directive' });
    matchedTaskId = target.taskId.value;

    // The target already reached a real terminal before the change.
    await service.startExecution(target.taskId, { prompt: 'seed directive' });
    await waitFor(() => assert.equal(service.taskDashboard(target.taskId).state, 'succeeded'));
    const seedEpoch = service.taskDashboard(target.taskId).executionEpoch ?? 0;
    assert.equal(seedEpoch, 1);
    const seedPayloads = port.startPayloads.length;

    // Confirm an existing-task-change against that settled task while the
    // task-scoped grant is still pending (not yet authorized).
    const interactionId = await service.receiveExplicitInput({
      sourceRef: 'ui:existing-change-dispatch',
      rawInput: 'change this task',
      channel: 'business',
      requestKind: 'existing-task-change',
    });
    await service.interpretExplicitInput({ interactionId });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    assert.ok(proposed.revision);
    const draftId = proposed.draft!.draftId;
    const draftRevisionVersion = proposed.revision!.revisionVersion;
    const draftRevisionHash = proposed.revision!.revisionHash;
    await service.confirmExplicitRequirement({
      interactionId,
      draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:existing-change-dispatch',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-10T00:00:00.000Z',
      payloadRef: 'asset://requirements/existing-change-dispatch',
      requestKind: 'existing-task-change',
      taskRef: target.taskId,
      draftRevisionVersion,
      draftRevisionHash,
    });

    // Dispatching before the grant is authorized must still prepare the change's
    // own execution occurrence and wait for the grant, not silently stop after
    // appending the input to the task mailbox.
    const dispatched = await service.dispatchNextExplicitRequirement();
    assert.equal(dispatched.taskId.value, target.taskId.value);
    assert.ok(dispatched.operationId, 'a change must mint its own prepared operation identity');
    assert.equal(service.taskDetail(target.taskId).state, 'waiting');
    assert.equal(port.startPayloads.length, seedPayloads, 'a pending grant must not release the change yet');

    // The task-scoped grant authorizes exactly that prepared change occurrence.
    await grants.grant({
      requestId: 'grant-existing-change-target',
      taskId: target.taskId,
      owner: 'human:operator',
      expectedRevision: 0,
      capability: {
        actionId: TASK_EXECUTION_ACTION_ID,
        capabilities: [TASK_EXECUTION_CAPABILITY],
        scope: { organId, taskId: target.taskId },
      },
    });
    const released = await service.releaseGrantedTaskExecution(target.taskId);
    assert.equal(released.state, 'released');
    await waitFor(() => assert.equal(service.taskDashboard(target.taskId).state, 'succeeded'));
    assert.equal(service.taskDashboard(target.taskId).executionEpoch, seedEpoch + 1);
    assert.equal(port.startPayloads.length, seedPayloads + 1, 'the grant must start exactly one new execution cycle');
    const events = service.eventsSince(dispatched.operationId!);
    assert.equal(events.some((event) => event.kind === 'execution.started'), true);
    assert.equal(events.some((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final' && event.state === 'succeeded'), true);
  } finally {
    await service.quiesceImplicitConsumption();
    await rm(root, { recursive: true, force: true });
  }
});

test('confirmed new-task create binds the verified principal execution grant and starts once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-create-grant-'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 1 });
  const grantJournal = new JsonlTaskGrantJournal(
    new JsonlOrganJournal(join(root, 'fake', 'task-grants.jsonl')),
  );
  const service = serviceFor(root, port, 'fake', 'ready', undefined, undefined, undefined, undefined,
    undefined, undefined, grantJournal, 'human:operator');
  try {
    await confirmExplicitRequirementFor(service, 'create-auto-grant');
    const dispatched = await service.dispatchNextExplicitRequirement();
    const grant = await grantJournal.readTaskGrant(dispatched.taskId);
    assert.equal(grant.grant?.state, 'granted',
      'the single explicit confirmation binds the task-scoped execution grant');
    assert.equal(grant.grant?.owner, 'human:operator',
      'the auto grant belongs to the confirmed principal, never the runtime');
    assert.equal(grant.grant?.capability.actionId, TASK_EXECUTION_ACTION_ID);
    assert.deepEqual(grant.grant?.capability.capabilities, [TASK_EXECUTION_CAPABILITY]);
    assert.equal(grant.grant?.capability.scope.taskId?.value, dispatched.taskId.value);
    await waitFor(() => assert.equal(service.taskDashboard(dispatched.taskId).state, 'succeeded'));
    assert.equal(port.startPayloads.length, 1, 'the granted create starts its execution exactly once');
  } finally {
    await service.quiesceImplicitConsumption();
    await rm(root, { recursive: true, force: true });
  }
});

test('public semantic observation preserves typed scope and reports unsupported source coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-semantic-observation-'));
  const service = serviceFor(root, new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 1 }));
  const task = service.createTask({ title: 'semantic observation scope' });
  assert.equal('publicCommitWatermark' in service.semanticObservation(task.taskId), false);
  const started = await service.startExecution(task.taskId, { prompt: 'semantic observation scope' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const semantic = service.semanticObservation(task.taskId);
  const publication = service.taskDashboard(task.taskId).publicOutput;
  const expected = publication?.commits.at(-1)?.journalSeq;
  assert.ok(expected !== undefined, 'fixture must produce a public commit');
  assert.equal(publication?.publicCommitWatermark, expected);
  assert.equal(semantic.publicCommitWatermark, expected);
  assert.equal(semantic.scope.taskId?.value, task.taskId.value);
  assert.equal(semantic.scope.operationId?.value, started.operationId.value);
  assert.equal(semantic.events.some((event) => event.type === 'operation.started'), true);
  assert.equal(semantic.events.some((event) => event.type === 'operation.completed'), true);
  assert.equal(
    semantic.pairing.some((group) => group.kind === 'operation' && group.state === 'closed' && group.scope.operationId?.value === started.operationId.value),
    true,
  );
  // The fake provider emits coverage-only model/output/settling events and a
  // tool call without callId. Canonical normalization must surface both
  // classes instead of presenting the observation as fully covered.
  assert.deepEqual(
    semantic.coverageIssues
      .map((issue) => `${issue.reason}|${issue.sourceRef.locator}`)
      .sort(),
    [
      'correlation-unavailable|fake/tool-2',
      `correlation-unavailable|runtime source ${started.operationId.value}-6`,
      `unknown-kind|runtime source ${started.operationId.value}-10`,
      `unknown-kind|runtime source ${started.operationId.value}-2`,
      `unknown-kind|runtime source ${started.operationId.value}-3`,
      `unknown-kind|runtime source ${started.operationId.value}-4`,
      `unknown-kind|runtime source ${started.operationId.value}-5`,
      `unknown-kind|runtime source ${started.operationId.value}-7`,
      `unknown-kind|runtime source ${started.operationId.value}-9`,
    ],
  );
  assert.equal(semantic.coverageIssues.every((issue) => issue.eventRef === undefined), true);
  assert.equal(semantic.coverageIssues.every((issue) => issue.scope.taskId?.value === task.taskId.value), true);
});

test('task dashboard retains current bound public output commits on read failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-public-output-read-failure-'));
  const storePath = join(root, 'public-output.jsonl');
  const store = new FileCheckpointStore(storePath);
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointStoreFor: () => store,
    attentionPort: attentionPort(),
    providerState: 'ready',
    journal,
    closurePort: journal,
    memory: testMemory('project-ui-test'),
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    runtimeComposition: { admitExecution: async () => {} },
  });
  const task = service.createTask({ title: 'retain public output on read failure' });
  await service.startExecution(task.taskId, { prompt: 'retain public output on read failure' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const before = await service.taskDashboardWithPlan(task.taskId);
  assert.equal(before.publicOutput?.state, 'committed');
  assert.ok((before.publicOutput?.commits.length ?? 0) > 0, 'fixture must produce confirmed public output');
  assert.ok(before.output.length > 0, 'fixture must project confirmed public output text');
  assert.ok(before.publicOutput?.publicCommitWatermark !== undefined, 'fixture must produce a real public watermark');

  store.readPublicOutputs = async () => {
    throw new Error('simulated public output read failure');
  };
  const after = await service.taskDashboardWithPlan(task.taskId);
  assert.equal(after.publicOutput?.state, 'unknown');
  assert.deepEqual(after.publicOutput?.commits, before.publicOutput?.commits);
  assert.equal(after.publicOutput?.publicCommitWatermark, before.publicOutput?.publicCommitWatermark);
  assert.equal(after.output, before.output);
});

test('unchanged control journal is not re-read on warm task dashboard calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-dashboard-cache-'));
  const controlPath = join(root, 'task-control.jsonl');
  const task = { taskId: id('task', 'dashboard-cache-task') };
  let service: UiRuntimeService | undefined;
  try {
    await seedLargeControlJournal(controlPath, { organId, taskId: task.taskId }, 12_000);
    const controlJournal = openUiRuntimeOrganJournal(controlPath);
    const checkpointStore = new ServiceExecutionCheckpointStore(controlPath, controlJournal, () => new Date());
    const runtimeJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
    const running = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
      checkpointStoreFor: () => checkpointStore,
      attentionPort: attentionPort(),
      providerState: 'ready',
      journal: runtimeJournal,
      closurePort: runtimeJournal,
      memory: testMemory('project-ui-test'),
      explicitBrainInterpreter: unusedExplicitBrainInterpreter,
      runtimeComposition: { admitExecution: async () => {} },
    });
    service = running;
    const created = running.createTask({ title: 'dashboard cache task' });
    await running.startExecution(created.taskId, { prompt: 'warm dashboard cache task' });
    await waitFor(() => assert.equal(running.taskDashboard(created.taskId).state, 'succeeded'));

    await running.taskDashboardWithPlan(created.taskId);

    const timings: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const startedAt = performance.now();
      const dashboard = await running.taskDashboardWithPlan(created.taskId);
      timings.push(performance.now() - startedAt);
      assert.equal(dashboard.taskId.value, created.taskId.value);
    }
    assert.ok(timings.every((ms) => ms < 20), `warm dashboard calls exceeded 20 ms: ${timings.join(', ')}`);
    console.log('dashboard cache warm timings', JSON.stringify({ timings }));
  } finally {
    await service?.quiesceImplicitConsumption();
    await rm(root, { recursive: true, force: true });
  }
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
  const blockedList = service.listTasks();
  assert.equal(blockedList.counts.total, 1);
  assert.equal(queuedDraftRow(blockedList, 'draft-1').requirementAdmission, 'queued');
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

test('orchestrated confirmed requirement dispatches implicit executor agents through the real UI runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-executor-dispatch-'));
  const port = new CountingFakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    closurePort: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    memory: testMemory('project-ui-implicit-executor-dispatch'),
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
          ownerId: 'ui-runtime-test',
          initialRuntimes: [{
            runtimeId: 'ui-runtime-test-0',
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
          evidenceRefs: [evidence('implicit-review', input.scope)],
        });
        const reviewAgent: ReviewAgentPort = {
          roleId: 'ui-runtime-test-review',
          createInstance(create) {
            return {
              incarnation: create.incarnation,
              async review(input) {
                const result = await reviewOnce(input);
                return {
                  result,
                  output: { text: `ui review ${input.reviewAssignment.assignmentId}`, artifactRef: null, artifactDigest: null },
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
                evidence(`implicit-merge-${request.workerAssignment.assignmentId}`, request.scope),
              ],
            };
          },
        };
        const orchestration = new OrchestrationManager({
          ownerId: 'ui-runtime-test',
          runtimePool,
          executionAgent: executionAgent,
          reviewAgent,
          mergeCoordinator,
          maxAttempts: maxAttempts ?? 1,
        });
        return { orchestration, runtimePool };
      },
    },
  });
  service.startImplicitConsumer();
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:implicit-executor-dispatch',
    rawInput: 'search code and write checkpoint evidence',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'search code and write checkpoint evidence',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the executor subtask task',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-executor-dispatch',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-26T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-executor-dispatch',
  });
  await waitFor(() => assert.equal(service.listTasks().counts.total, 1));
  await waitFor(() => assert.equal(service.listTasks().completed[0]?.state, 'succeeded'));
  assert.ok(port.startCount === 1, `single executor assignment, got ${port.startCount}`);
  const createdTaskId = service.listTasks().completed[0]?.taskId;
  assert.ok(createdTaskId);
  const afterCreateStarts = port.startCount;
  const appendInteraction = await service.receiveExplicitInput({
    sourceRef: 'ui:implicit-executor-append',
    rawInput: 'append checkpoint evidence to the same task',
    channel: 'business',
  });
  await service.beginExplicitMatching(appendInteraction);
  await service.recordExplicitMatch(appendInteraction, {
    normalizedInput: 'append checkpoint evidence to the same task',
    matchedTasks: [{ taskId: createdTaskId, relation: 'current', status: 'running' }],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(appendInteraction, {
    proposedIntent: 'append',
    proposal: 'append evidence to the same task',
  });
  const appendProposed = await service.inspectExplicitInteraction(appendInteraction);
  assert.ok(appendProposed.draft);
  await service.confirmExplicitRequirement({
    draftId: appendProposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:implicit-executor-append',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-26T00:00:00.000Z',
    payloadRef: 'asset://requirements/implicit-executor-append',
  });
  await waitFor(() => assert.equal(port.startCount, afterCreateStarts + 1));
  await waitFor(() => assert.equal(service.taskDashboard(createdTaskId).state, 'succeeded'));
  assert.equal(port.startCount, afterCreateStarts + 1, 'interactive append must not dispatch extra implicit executor subtasks');
  await rm(root, { recursive: true, force: true });
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
  const waitingList = service.listTasks();
  assert.equal(waitingList.counts.total, 2);
  assert.equal(queuedDraftRow(waitingList, 'draft-2').requirementAdmission, 'queued');
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
  const pendingList = service.listTasks();
  assert.equal(pendingList.counts.total, 3);
  assert.equal(queuedDraftRow(pendingList, 'draft-1').requirementAdmission, 'queued');
  assert.equal(queuedDraftRow(pendingList, 'draft-2').requirementAdmission, 'queued');

  service.startImplicitConsumer();
  // The retirement stays recorded as FIFO evidence, but the newer confirmed
  // requirement is the current head state: the status projection must not keep
  // the historical retirement blocked while later work proceeds.
  await waitFor(() => assert.equal(service.implicitSchedulingIssue()?.code, 'explicit-brain.requirement-retired'));
  assert.ok(service.status().implicitScheduling?.code !== 'explicit-brain.requirement-retired');
  await waitFor(() => assert.equal(service.listTasks().counts.total, 1));
  await waitFor(() => assert.equal(service.taskDashboard(laterTask.taskId).state, 'succeeded'));
  assert.equal((await service.inspectExplicitInteraction(laterInteraction)).state, 'dispatched');
  assert.equal(service.status().implicitScheduling, undefined);
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

test('a later confirmed requirement clears a retired FIFO head from the current scheduling status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-retired-then-new-'));
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
  await assert.rejects(
    () => service.dispatchNextExplicitRequirement(),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'explicit-brain.requirement-retired'
      && error.nextAction.includes('requirement:draft-1:1')
      && error.httpStatus === 409,
  );
  // The FIFO has not advanced past the retirement, so it is still the current
  // scheduling state.
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
  assert.equal((await service.inspectExplicitInteraction(retiredInteraction)).state, 'confirmed');

  // A newer requirement advances nextFifoSeq. The historical retirement stays
  // recorded but must no longer project as the current scheduling state; the
  // status falls through to undefined rather than the stale blocked retirement.
  const laterInteraction = await confirmAppend('later-after-retired', laterTask.taskId);
  const dispatched = await service.dispatchNextExplicitRequirement();
  assert.equal(dispatched.requirement.requirementId, 'requirement:draft-2:1');
  await waitFor(() => assert.equal(service.taskDashboard(laterTask.taskId).state, 'succeeded'));
  assert.equal((await service.inspectExplicitInteraction(laterInteraction)).state, 'dispatched');
  assert.equal(service.implicitSchedulingIssue()?.code, 'explicit-brain.requirement-retired');
  assert.equal(service.status().implicitScheduling, undefined);
  assert.equal(service.listTasks().counts.total, 1);
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
  // The later requirement advanced the FIFO, so the historical retirement is no
  // longer the current scheduling state even though its evidence is retained.
  assert.equal(service.status().implicitScheduling, undefined);
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
  await service.startExecution(occupying.taskId, { prompt: 'occupy capacity' });
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
  // The FIFO advanced past the historical retirement, so the status projection
  // must stop reporting it as the current scheduling state.
  assert.equal(service.status().implicitScheduling, undefined);
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
  await service.startExecution(task.taskId, { prompt: 'baseline input' });
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
    const blockedList = runtime.service.listTasks();
    assert.equal(blockedList.counts.total, 1);
    assert.equal(queuedDraftRow(blockedList, 'draft-1').requirementAdmission, 'queued');
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
  await service.startExecution(occupying.taskId, { prompt: 'occupy capacity' });

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
  // startExecution schedules the provider start asynchronously, so the journal
  // failure can become visible before FakeReplayExecutionRuntimePort.start has
  // pushed its payload; wait for the real provider-visible start before
  // asserting it happened exactly once.
  await waitFor(() => assert.equal(port.startPayloads.length, 1));
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
  await waitFor(() => assert.equal(port.startPayloads.length, 1));
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
  const failedBacklog = service.listTasks();
  assert.equal(failedBacklog.counts.total, 1);
  assert.equal(queuedDraftRow(failedBacklog, 'draft-2').requirementAdmission, 'queued');
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
  const fixtureRoot = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'humanagent-ui-implicit-execution-start-failure-'));
  const journal = new FailOnceProjectionJournal(join(root, 'ui-runtime-journal.jsonl'));
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 20 });
  const service = serviceFor(root, port, 'fake', 'ready', journal);
  try {
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
  } finally {
    await waitFor(() => assert.equal(service.listTasks().counts.running, 0));
    await service.quiesceImplicitConsumption();
    await rm(root, { recursive: true, force: true });
  }
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

test('runtime close quiesces pending implicit consumption before settling active executions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-close-quiescence-'));
  const checkpointRoot = join(root, 'checkpoints');
  const interactionRoot = join(root, 'interactions');
  const port = new PayloadCapturingFakeReplayPort({ binding, stepDelayMs: 5 });
  const options = {
    mode: 'fake' as const,
    organId,
    binding,
    port,
    checkpointRoot,
    interactionRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    projectKey: 'project-ui-close-quiescence',
    workspaceRoot: root,
    memory: testMemory('project-ui-close-quiescence'),
  };
  const first = await startUiRuntime(options);
  try {
    await confirmExplicitRequirementFor(first.service, 'close-quiescence');
    assert.equal(first.service.listTasks().counts.total, 1, 'confirmed requirement must be durably queued before close');
    await first.close();
    // Wait past the 100ms FIFO visibility window; the retired runtime must not
    // dispatch the requirement after close has settled it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(port.startPayloads.length, 0, 'retired runtime must not dispatch after close');
    assert.equal(first.service.listTasks().counts.running, 0);
  } finally {
    await first.close().catch(() => undefined);
  }

  // The durable requirement keeps its visible queued row after close has
  // settled the retired runtime. Grant that exact queued task before the
  // replacement runtime starts, so its FIFO dispatch can pass admission.
  const queuedTask = first.service.listTasks().draft.find((row) => row.requirementAdmission === 'queued');
  if (!queuedTask) throw new Error('confirmed requirement must remain visibly queued for the replacement grant');
  await grantRuntimeTask(first, queuedTask.taskId, join(root, 'checkpoints'), 'fake');

  const replacement = await startUiRuntime(options);
  try {
    await waitFor(() => assert.equal(port.startPayloads.length, 1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(port.startPayloads.length, 1, 'replacement runtime must dispatch the durable requirement exactly once');
    await waitFor(() => assert.equal(replacement.service.listTasks().counts.completed, 1));
    assert.equal(replacement.service.listTasks().counts.total, 1);
  } finally {
    await replacement.close();
  }
});

test('server close releases the single tracked auth expiry timer after active SSE streams close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-auth-timer-'));
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
    sessionTtlMs: 1_500,
    pairingTtlMs: 1_500,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
  // The Journal is the fixture's own resource: it must outlive the background
  // execution so a late provider append never finds the operation history gone.
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 5_000 }), 'fake', 'ready', journal);
  const server = await startUiRuntimeServer({
    service,
    accessControl,
    productRoot: root,
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    port: 0,
  });
  const streams: Array<{ controller: AbortController; closed: Promise<void> }> = [];
  let ownedTaskId: TaskId | undefined;
  let ownedStart: Awaited<ReturnType<UiRuntimeService['startExecution']>> | undefined;
  let completionVerified = false;
  let primaryError: unknown;
  // Phase 1: the original close assertions. A failure here is preserved, but the
  // execution is still allowed to complete naturally before cleanup decides.
  try {
    const task = service.createTask({ title: 'auth timer lifecycle' });
    ownedTaskId = task.taskId;
    const started = await service.startExecution(task.taskId, { prompt: 'hold three SSE streams open' });
    ownedStart = started;
    for (let index = 0; index < 3; index += 1) {
      const controller = new AbortController();
      const stream = await fetch(`${server.url}/api/executions/${encodeURIComponent(started.operationId.value)}/events`, {
        headers: { cookie },
        signal: controller.signal,
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = stream.body!.getReader();
      await reader.read();
      streams.push({ controller, closed: (async () => {
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) return;
          }
        } catch {
          // Abort closes the reader; lifecycle assertions use server.close().
        }
      })() });
    }
    const receipt = await server.close();
    assert.equal(receipt.activeSseEnded, 3, 'all active SSE streams must close with the server');
    assert.equal(receipt.authTimersCleared, 1, 'server close must release the single tracked auth expiry timer');
    for (const entry of streams) entry.controller.abort();
    await Promise.all(streams.map((entry) => entry.closed));
  } catch (error) {
    primaryError = error;
  } finally {
    for (const entry of streams) entry.controller.abort();
    await Promise.all(streams.map((entry) => entry.closed.catch(() => undefined)));
    await server.close();
  }
  // Phase 2: bounded natural completion. Server/stream close is not execution
  // cancellation and does not touch the Journal, so the same task/operation/epoch
  // must reach a successful final terminal before the fixture may release its
  // Journal root. The bound covers five 5,000ms replay steps, the observed ~25s
  // completion and scheduler slack; never replace it with a fixed sleep or quiet
  // period as completion evidence.
  try {
    if (!ownedTaskId || !ownedStart) throw new Error('the fixture must have started an owned execution');
    const taskId: TaskId = ownedTaskId;
    const { operationId, executionEpoch } = ownedStart;
    await waitFor(() => {
      const events = service.eventsSince(operationId);
      const final = events.find((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final');
      assert.ok(final, 'the matching execution must reach a final terminal before cleanup');
      assert.equal(final!.state, 'succeeded', 'the matching execution must complete successfully');
    }, 35_000);
    const events = service.eventsSince(operationId);
    // Identity and order of the whole operation stream are preserved.
    assert.deepEqual(events.map((event) => event.kind), [
      'execution.started',
      'provider.model',
      'provider.model',
      'provider.model',
      'provider.output',
      'provider.tool',
      'provider.output',
      'execution.terminal',
      'provider.model',
      'execution.settling',
      'checkpoint.committed',
      'execution.terminal',
    ]);
    assert.deepEqual(
      events.filter((event) => event.kind === 'execution.terminal').map((event) => event.terminalPhase),
      ['provider', 'final'],
    );
    assert.equal(events.every((event) => event.operationId === operationId.value), true);
    assert.equal(events.every((event) => event.executionEpoch === executionEpoch), true);
    assert.equal(events.every((event) => event.taskId.value === taskId.value), true);
    const final = events.at(-1)!;
    assert.equal(final.terminalPhase, 'final');
    assert.equal(final.state, 'succeeded');
    assert.equal(final.summary.includes('provider closed'), true);
    // Only evidence this fixture actually produced is asserted; the fake
    // provider is never described as a real RCC closure.
    assert.equal(final.evidenceRefs.some((ref) => ref.source === 'humanagent.fake-provider' && ref.locator === 'fake/settle-succeeded'), true);
    assert.equal(final.evidenceRefs.some((ref) => ref.source === 'humanagent.fake-provider' && ref.locator === 'fake/close'), true);

    const dashboard = service.taskDashboard(taskId);
    assert.equal(dashboard.state, 'succeeded');
    assert.equal(dashboard.operationId, operationId.value);
    assert.equal(dashboard.executionEpoch, executionEpoch);
    assert.equal(dashboard.checkpoint?.outcome, 'succeeded');
    assert.equal(dashboard.error, undefined);

    // The durable projection must be valid and carry the same operation start
    // and same-identity successful terminal/checkpoint sequence.
    const replay = journal.replay();
    const replayStarted = replay.filter((record) => record.kind === 'operation.started');
    assert.equal(replayStarted.length, 1);
    const startRecord = replayStarted[0] as Extract<(typeof replay)[number], { readonly kind: 'operation.started' }>;
    assert.equal(startRecord.operationId.value, operationId.value);
    assert.equal(startRecord.taskId.value, taskId.value);
    assert.equal(startRecord.executionEpoch, executionEpoch);
    const replayEvents = replay
      .filter((record) => record.kind === 'operation.event')
      .map((record) => (record as Extract<(typeof replay)[number], { readonly kind: 'operation.event' }>).event);
    assert.deepEqual(
      replayEvents.map((event) => [event.eventId, event.seq, event.kind]),
      events.map((event) => [event.eventId, event.seq, event.kind]),
    );
    assert.equal(replayEvents.every((event) => event.taskId.value === taskId.value
      && event.operationId === operationId.value
      && event.executionEpoch === executionEpoch), true);
    assert.equal(replayEvents.some((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final' && event.state === 'succeeded'), true);
    assert.equal(replayEvents.some((event) => event.kind === 'checkpoint.committed' && event.state === 'succeeded'), true);
    completionVerified = true;
  } catch (error) {
    if (primaryError === undefined) primaryError = error;
  }
  // Phase 3: cleanup. Root release is authorized only by the same execution's
  // successful final/checkpoint/closure/replay proof above.
  if (completionVerified) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error(`journal root cleanup failed for ${root}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
      if (primaryError === undefined) primaryError = cleanupError;
    }
  } else {
    // Completion could not be proven. A stop/final alone does not prove the
    // background provider iterator drained, so use only the bounded existing
    // stop/retry-stop controls and preserve the Journal root and recovery
    // identity instead of deleting a root that may still be written to.
    const owned = ownedTaskId;
    if (owned) {
      const bounded = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<'timeout'>((resolve) => {
              timer = setTimeout(() => resolve('timeout'), timeoutMs);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      try {
        if (service.taskDashboard(owned).allowedActions.includes('stop')) {
          const stopped = await bounded(service.stop(owned), 10_000);
          if (stopped === 'timeout') {
            console.error(`stop did not settle within 10000ms for ${owned.value}; journal root retained at ${root}\n`);
          } else if (stopped.state === 'settling' && service.taskDashboard(owned).allowedActions.includes('retry-stop')) {
            const retried = await bounded(service.retryStop(owned), 10_000);
            if (retried === 'timeout') {
              console.error(`retry-stop did not settle within 10000ms for ${owned.value}; journal root retained at ${root}\n`);
            }
          }
        }
      } catch (stopError) {
        console.error(`stop/retry-stop failed for ${owned.value}; journal root retained at ${root}: ${stopError instanceof Error ? stopError.message : String(stopError)}\n`);
      }
    }
    console.error(`execution completion not proven; INCOMPLETE, journal root retained at ${root}\n`);
  }
  if (primaryError !== undefined) throw primaryError;
});

test('shared control-root credential invalidation is observed by every live access-control instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-shared-credential-'));
  try {
    const credentialPath = join(root, 'security', 'web-access.json');
    const first = await AccessControlService.open({ credentialPath, create: true });
    const second = await AccessControlService.open({ credentialPath });
    const challenge = await first.issuePairingChallenge();
    const session = await first.consumePairingCode(challenge.code);

    assert.equal((await second.verifySession(first.sessionCookie(session))).state, 'valid');
    const staleGeneration = session.sessionGeneration;
    const generations = await Promise.all([
      first.logout(),
      second.logout(),
    ]);
    assert.deepEqual([...generations].sort((left, right) => left - right), [staleGeneration + 1, staleGeneration + 2]);
    assert.equal(await first.readPersistedGeneration(), staleGeneration + 2);
    assert.equal((await first.verifySession(first.sessionCookie(session))).state, 'generation-mismatch');
    assert.equal((await second.verifySession(first.sessionCookie(session))).state, 'generation-mismatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function issuePairingChallengeInChildProcess(credentialPath: string): Promise<{ readonly code: string; readonly expiresAt: number }> {
  const moduleUrl = join(process.cwd(), 'dist', 'app', 'app', 'src', 'ui-runtime', 'access-control.js');
  const script = [
    'const [moduleUrl, credentialPath] = process.argv.slice(1);',
    'const { AccessControlService } = await import(moduleUrl);',
    'const access = await AccessControlService.open({ credentialPath, create: true });',
    'const challenge = await access.issuePairingChallenge();',
    'process.stdout.write(JSON.stringify(challenge));',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, credentialPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (exitCode !== 0) throw new Error(`pairing issue child failed (${String(exitCode)}): ${stderr}`);
  return JSON.parse(stdout) as { readonly code: string; readonly expiresAt: number };
}

test('pairing recovery issues before server and consumes one durable code once across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-pairing-recovery-'));
  try {
    const credentialPath = join(root, 'security', 'web-access.json');
    // A separate process issues the challenge before any server or lease exists.
    const issued = await issuePairingChallengeInChildProcess(credentialPath);
    assert.ok(issued.code.length > 0);
    assert.ok(issued.expiresAt > Date.now());

    // Reopening the credential owner stands in for the serve process that was
    // not running when the code was issued.
    const reopened = await AccessControlService.open({ credentialPath });
    const generation = await reopened.readPersistedGeneration();
    const firstSession = await reopened.consumePairingCode(issued.code);
    assert.equal(firstSession.sessionGeneration, generation, 'pairing must not rotate the session generation');
    await assert.rejects(
      () => reopened.consumePairingCode(issued.code),
      (error: unknown) => (error as { readonly code?: string }).code === 'auth.pair.invalid',
    );

    // Two independent terminals pair without revoking each other.
    const secondChallenge = await reopened.issuePairingChallenge();
    const secondSession = await reopened.consumePairingCode(secondChallenge.code);
    assert.equal(secondSession.sessionId !== firstSession.sessionId, true);
    assert.equal(
      (await reopened.verifySession(reopened.sessionCookie(firstSession))).state,
      'valid',
      'pairing a second terminal must not revoke the first session',
    );
    assert.equal((await reopened.verifySession(reopened.sessionCookie(secondSession))).state, 'valid');
    assert.equal(await reopened.readPersistedGeneration(), generation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pairing recovery expires durable challenges and logout clears them with the new generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-pairing-ttl-'));
  try {
    const credentialPath = join(root, 'security', 'web-access.json');
    let now = Date.now();
    const accessControl = await AccessControlService.open({
      credentialPath,
      create: true,
      pairingTtlMs: 5_000,
      now: () => now,
    });
    const expired = await accessControl.issuePairingChallenge();
    now += 5_001;
    await assert.rejects(
      () => accessControl.consumePairingCode(expired.code),
      (error: unknown) => (error as { readonly code?: string }).code === 'auth.pair.expired',
    );
    await assert.rejects(
      () => accessControl.consumePairingCode(expired.code),
      (error: unknown) => (error as { readonly code?: string }).code === 'auth.pair.invalid',
    );

    const pending = await accessControl.issuePairingChallenge();
    const generation = await accessControl.readPersistedGeneration();
    assert.equal(await accessControl.logout(), generation + 1);
    await assert.rejects(
      () => accessControl.consumePairingCode(pending.code),
      (error: unknown) => (error as { readonly code?: string }).code === 'auth.pair.invalid',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pairing recovery projects the config pairing command without authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-pairing-command-'));
  // Nonstandard credential location and name: the credential path cannot
  // reveal the product root, so only the composed option can produce it.
  const productRoot = join(root, 'products', 'known');
  const credentialPath = join(root, 'credentials', 'pairing-secret.json');
  const accessControl = await AccessControlService.open({ credentialPath, create: true });
  const { listener } = createUiRuntimeRequestDispatcher({
    service: {} as UiRuntimeService,
    accessControl,
    productRoot,
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    isClosing: () => false,
  });
  const server = createServer(listener);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('pairing projection server did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const pairingCommand = formatPairingCommand({ controlRoot: productRoot });
    assert.ok(pairingCommand !== formatPairingCommand({ controlRoot: root }));
    const unpaired = await fetch(`${base}/api/auth/session`);
    assert.equal(unpaired.status, 200);
    const unpairedBody = await unpaired.json() as {
      readonly authenticated: boolean;
      readonly localAccess?: boolean;
      readonly expiresAt?: string;
      readonly pairingCommand: string;
    };
    // MVP loopback access adopts a local session without pairing, while the
    // pairing command still projects the configured product root.
    assert.equal(unpairedBody.authenticated, true);
    assert.equal(unpairedBody.localAccess, true);
    assert.equal(unpairedBody.pairingCommand, pairingCommand);
    assert.ok(typeof unpairedBody.expiresAt === 'string' && unpairedBody.expiresAt.length > 0);

    const challenge = await accessControl.issuePairingChallenge();
    const paired = await fetch(`${base}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: challenge.code }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]!;
    const authenticated = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
    const body = await authenticated.json() as {
      readonly authenticated: boolean;
      readonly expiresAt: string;
      readonly pairingCommand: string;
    };
    assert.equal(body.authenticated, true);
    assert.equal(body.pairingCommand, pairingCommand);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('credential mutation lock survives crash recovery without stealing a live owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-credential-lock-'));
  const credentialPath = join(root, 'security', 'web-access.json');
  const lockPath = `${credentialPath}.lock`;
  const accessControl = await AccessControlService.open({ credentialPath, create: true });
  try {
    const holder = spawn(process.execPath, [
      '-e',
      [
        "const fs = require('node:fs');",
        `const handle = fs.openSync(${JSON.stringify(lockPath)}, fs.constants.O_RDWR | fs.constants.O_CREAT | 0x20 | fs.constants.O_NONBLOCK, 0o600);`,
        "process.stdout.write('locked\\n');",
        "process.on('SIGTERM', () => { fs.closeSync(handle); process.exit(0); });",
        'setInterval(() => {}, 1000);',
      ].join(''),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout!.once('data', () => resolve());
    });
    await assert.rejects(
      () => accessControl.logout(),
      (error: unknown) => (error as { readonly code?: string }).code === 'auth.credentials.busy',
    );
    holder.kill('SIGTERM');
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.once('exit', () => resolve());
    });
    assert.equal(await accessControl.logout(), 2, 'released lock must allow the next generation mutation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('credential read and write failures refuse pairing and logout explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-credential-failure-'));
  try {
    const credentialPath = join(root, 'security', 'web-access.json');
    const accessControl = await AccessControlService.open({ credentialPath, create: true });
    const challenge = await accessControl.issuePairingChallenge();
    await writeFile(credentialPath, '{not-json}\n', 'utf8');

    await assert.rejects(
      () => accessControl.issuePairingChallenge(),
      (error: unknown) => (error as { readonly code?: string }).code === 'auth.credentials.unavailable',
    );
    await assert.rejects(
      () => accessControl.consumePairingCode(challenge.code),
      (error: unknown) => (error as { readonly code?: string }).code === 'auth.credentials.unavailable',
    );
    await assert.rejects(
      () => accessControl.logout(),
      (error: unknown) => (error as { readonly code?: string }).code === 'auth.credentials.unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime close settles active executions before propagating a credential watch failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-close-watch-failure-'));
  const checkpointRoot = join(root, 'checkpoints');
  let releaseExecution!: () => void;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const port = new FirstOperationGatedReplayPort(
    { binding, stepDelayMs: 100 },
    executionGate,
  );
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const watchFailure = new AccessControlError(
    'auth.credentials.unavailable',
    'web access credential is unavailable',
    'repair the control-root credential path',
    503,
  );
  let runtimeReceiverWatcherClosed: boolean | undefined;
  const failingAccessControl = Object.create(accessControl) as AccessControlService;
  failingAccessControl.closeCredentialWatch = async () => {
    runtimeReceiverWatcherClosed = await accessControl.closeCredentialWatch.call(failingAccessControl);
    assert.equal(runtimeReceiverWatcherClosed, true, 'shutdown must close the credential watcher owned by the runtime receiver');
    throw watchFailure;
  };
  const runtime = await startUiRuntimeOwner({
    mode: 'fake',
    accessControl: failingAccessControl,
    organId,
    binding,
    port,
    checkpointRoot,
    productRoot: checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    memory: testMemory('project-ui-close-watch-failure'),
  });
  runtimeAccessControl.set(runtime, failingAccessControl);
  let closeStarted = false;
  try {
    const task = runtime.service.createTask({ title: 'watch failure close' });
    await grantRuntimeTask(runtime, task.taskId, checkpointRoot, 'fake');
    await runtime.service.startExecution(task.taskId, { prompt: 'hold open until watch failure' });
    await waitFor(() => assert.equal(runtime.service.taskDashboard(task.taskId).state, 'running'));

    closeStarted = true;
    const closed = runtime.close();
    const rejection = closed.then(
      (value: unknown) => {
        throw new Error(`runtime.close() must reject with the original credential error; resolved with ${JSON.stringify(value)}`);
      },
      (error: unknown) => error,
    );
    await waitFor(() => assert.equal(runtime.service.taskDashboard(task.taskId).state, 'settling'));
    releaseExecution();
    assert.equal((await rejection as { readonly code?: string }).code, 'auth.credentials.unavailable');
    assert.equal(
      runtimeReceiverWatcherClosed,
      true,
      'injected failure must follow the actual runtime receiver closing its credential watcher',
    );
    assert.equal(
      runtime.service.taskDashboard(task.taskId).state,
      'stopped',
      'listener close failure must not bypass standard task stop and checkpoint settlement',
    );

    const checkpoint = runtime.service.taskDashboard(task.taskId).checkpoint;
    assert.equal(checkpoint?.outcome, 'stopped');
    const checkpointJournal = createJsonlCheckpointJournal({
      filePath: uiRuntimeControlJournalPath(join(checkpointRoot, 'fake')),
    });
    const { checkpoints } = await checkpointJournal.listCommitted({
      scope: { organId, taskId: task.taskId },
      limit: 1,
    });
    const stoppedCheckpoint = checkpoints[0];
    if (!stoppedCheckpoint) throw new Error('close must commit the stopped checkpoint before the original error is observable');
    if (!checkpoint) throw new Error('dashboard must project the committed stopped checkpoint');
    assert.equal(stoppedCheckpoint.checkpoint.outcome, 'stopped');
    assert.equal(stoppedCheckpoint.checkpoint.id.value, checkpoint.checkpointId);

    let retryError: unknown;
    try {
      await runtime.close();
      throw new Error('repeated runtime.close() must expose the cached credential error');
    } catch (error) {
      retryError = error;
    }
    assert.equal((retryError as { readonly code?: string }).code, 'auth.credentials.unavailable');
    assert.equal(runtime.service.listTasks().counts.running, 0);
  } finally {
    releaseExecution();
    if (!closeStarted) await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('server close awaits credential watch drain and reports closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-credential-watch-'));
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const server = await startUiRuntimeServer({
    service,
    accessControl,
    productRoot: root,
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    port: 0,
  });
  try {
    const receipt = await server.close();
    assert.equal(receipt.credentialWatchClosed, true, 'server close must release the credential watcher');
    assert.equal(receipt.authTimersCleared, 0, 'an empty stream registry must not invent an auth timer release');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
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
          structuredProposal: {
            revision: input.inputRevision,
            intent,
            title: input.rawInput.replace(/^(新建|追加|修改)/, '').trim(),
            objective: input.rawInput.replace(/^(新建|追加|修改)/, '').trim(),
            deliverable: `${intent}:${input.rawInput}`,
            deliveryConditions: [],
            evidenceRefs: [],
            blockingGaps: [],
          },
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
  const parentRoot = await mkdtemp(join(
    process.env.HUMANAGENT_TEST_ROOT ?? '/Users/fanzhang/.humanagent/test-fixtures/provider-explicit-parent-wiring-20261016',
    'ui-intake-',
  ));
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
      deliveryConditions: ['三条链路逐条列出', '每条风险附带证据引用'],
      evidenceRefs: [],
      blockingGaps: ['缺少三条链路的只读投影来源'],
    },
  });
  const rawEvidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(parentRoot, 'assets')));
  const parentJournal = new JsonlOrganJournal(join(parentRoot, 'parent.jsonl'));
  const helperJournal = new JsonlInteractionHelperJournal(parentJournal);
  const transport = new V3ProviderHttpTransport<InteractionParentProviderExecutionIdentityRef>({
    binding,
    baseUrl: 'http://recorded.test',
    source: 'http',
    evidence: rawEvidence,
    fetch: async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: (async function* () {
        const frames = [
          { type: 'response.created', response: { id: 'live-proposal' } },
          { type: 'response.output_text.done', item_id: 'proposal', text: providerOutput },
          { type: 'response.completed', response: { id: 'live-proposal' } },
        ];
        yield new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
      })(),
      text: async () => '',
    }),
  });
  class SettlementTrackingPort extends ProviderAdapter<InteractionParentProviderExecutionIdentityRef> {
    settleCalls = 0;

    override async settle(input: Parameters<ExecutionRuntimePort<InteractionParentProviderExecutionIdentityRef>['settle']>[0]): Promise<ProviderSettlement<InteractionParentProviderExecutionIdentityRef>> {
      this.settleCalls += 1;
      return super.settle(input);
    }
  }
  const port = new SettlementTrackingPort({
    binding,
    routeRef: 'recorded',
    codec: new ResponsesProviderCodec(),
    transport,
    evidence: rawEvidence,
  });
  const interpreter = createProviderExplicitBrainInterpreter({
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port,
    organId,
    interactionScopeId: 'runtime:ui-live-proposal',
    parentJournal: new JsonlInteractionParentTurnJournal(parentJournal),
    helperJournal,
    checkpointJournal: helperJournal,
    rawEvidence,
    rawContent: providerRawContentReader(rawEvidence),
    clock: { now: () => new Date().toISOString() },
    helperFactory: async () => { throw new Error('unexpected helper dispatch in no-helper intake'); },
  });
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 0 }),
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
  await rm(parentRoot, { recursive: true, force: true });
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
          structuredProposal: {
            revision: input.inputRevision,
            intent: 'create',
            title: '修改已有任务的验收范围',
            objective: '修改已有任务的验收范围',
            deliverable: '修改已有任务的验收范围',
            deliveryConditions: [],
            evidenceRefs: [],
            blockingGaps: [],
          },
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
            structuredProposal: {
              revision: input.inputRevision,
              intent: 'create',
              title: '首次解释失败后重试',
              objective: '首次解释失败后重试',
              deliverable: '首次解释失败后重试',
              deliveryConditions: [],
              evidenceRefs: [],
              blockingGaps: [],
            },
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
          structuredProposal: {
            revision: input.inputRevision,
            intent: 'create',
            title: '澄清后重试',
            objective: '澄清后重试',
            deliverable: '澄清后重试',
            deliveryConditions: [],
            evidenceRefs: [],
            blockingGaps: [],
          },
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
          structuredProposal: {
            revision: input.inputRevision,
            intent: 'create',
            title: '修改现有任务的验收范围',
            objective: '修改现有任务的验收范围',
            deliverable: '修改现有任务的验收范围',
            deliveryConditions: [],
            evidenceRefs: [],
            blockingGaps: [],
          },
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
  const auth = await testAccessControl(root);
  await assert.rejects(
    () => startUiRuntimeOwner({
      mode: 'fake',
      organId,
      binding,
      accessControl: auth.accessControl,
      productRoot: root,
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
          structuredProposal: {
            revision: input.inputRevision,
            intent: 'create',
            title: input.rawInput.toUpperCase(),
            objective: input.rawInput.toUpperCase(),
            deliverable: `create:${input.rawInput}`,
            deliveryConditions: [],
            evidenceRefs: [],
            blockingGaps: [],
          },
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
    assert.equal(confirmationResponse.status, 200, await confirmationResponse.clone().text());
    // Grant the exact confirmed requirement's queued task before the 100ms FIFO
    // visibility window drains it, so implicit admission succeeds on the same
    // task identity that the confirmation response just created.
    const queuedTask = runtime.service.listTasks().draft.find((row) => row.requirementAdmission === 'queued');
    if (!queuedTask) throw new Error('confirmed HTTP requirement must be visibly queued before the implicit grant');
    await grantRuntimeTask(runtime, queuedTask.taskId, join(root, 'checkpoints'), 'fake');
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
    const blockedList = runtime.service.listTasks();
    assert.equal(blockedList.counts.total, 1);
    assert.equal(queuedDraftRow(blockedList, 'draft-1').requirementAdmission, 'queued');
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
  await service.startExecution(task.taskId, { prompt: 'run repeated deltas' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(task.taskId).output, 'aa');
});

test('provider output summaries remain journalable when provider text is blank', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-output-artifact-ref-'));
  const artifactRef = 'humanagent.provider-adapter:response.content_part.added:part-msg-1:sha256:c45b5b';
  const emptyArtifactRef = 'humanagent.provider-adapter:response.content_part.added:part-msg-2:sha256:empty';
  const missingArtifactRef = 'humanagent.provider-adapter:response.content_part.added:part-msg-3:sha256:missing';
  try {
    const journal = new CapturingRuntimeEventJournal(join(root, 'ui-runtime-journal.jsonl'));
    class MissingOutputSummaryReplayPort extends FakeReplayExecutionRuntimePort {
      override async *observe(
        input: Parameters<ExecutionRuntimePort['observe']>[0],
      ): AsyncIterable<ProviderEvent> {
        for await (const event of super.observe(input)) {
          if (event.kind === 'output' && event.outputRefs?.includes(missingArtifactRef)) {
            const { summary: _summary, ...withoutSummary } = event;
            yield withoutSummary;
          } else {
            yield event;
          }
        }
      }
    }

    const service = serviceFor(root, new MissingOutputSummaryReplayPort({
      binding,
      stepDelayMs: 1,
      replay: [
        { kind: 'output', state: 'output', summary: ' ', outputRefs: [artifactRef] },
        { kind: 'output', state: 'output', summary: '', outputRefs: [emptyArtifactRef] },
        { kind: 'output', state: 'output', summary: 'ignored snapshot summary', outputRefs: [missingArtifactRef] },
        { kind: 'output', state: 'output', summary: 'real model reply', outputRefs: ['humanagent.provider-adapter:response.output_text.done:text-msg-1:sha256:done'] },
        { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
      ],
    }), 'fake', 'ready', journal);
    const task = service.createTask({ title: 'provider artifact ref', directive: 'keep the task output readable' });
    await service.startExecution(task.taskId, { prompt: 'read the marker and reply' });
    await waitFor(() => assert.equal(
      journal.appendErrors.length > 0 || service.taskDashboard(task.taskId).state === 'succeeded',
      true,
    ));
    if (journal.appendErrors.length > 0) {
      assert.match(String(journal.appendErrors[0]), /summary is required/);
    }
    assert.equal(journal.appendErrors.length, 0, 'UiRuntimeJournal must accept every provider output event');
    assert.equal(service.taskDashboard(task.taskId).state, 'succeeded');

    const dashboard = service.taskDashboard(task.taskId);
    assert.equal(dashboard.output, ' real model reply');
    assert.equal(dashboard.output.includes('humanagent.provider-adapter:'), false);

    const observation = service.observation(task.taskId);
    const executionNode = observation.scope.nodes.find((node) => node.nodeId === 'pipeline.execute');
    assert.equal(executionNode?.summary, ' real model reply');
    assert.equal(executionNode?.summary.includes('humanagent.provider-adapter:'), false);

    const providerScope = service.observation(
      task.taskId,
      undefined,
      `task://${task.taskId.value}/observation/pipeline.execute`,
    );
    assert.equal(
      providerScope.scope.nodes.some((node) => node.summary.includes('humanagent.provider-adapter:')),
      false,
    );
    assert.equal(
      providerScope.scope.nodes.some((node) => node.summary === '未投影'),
      true,
    );

    const artifactEvent = journal.operationEvents.find((event) => event.outputRefs?.includes(artifactRef));
    if (artifactEvent === undefined) throw new Error('journal did not receive the artifact output event');
    assert.equal(artifactEvent.kind, 'provider.output');
    assert.equal(artifactEvent.summary, '未投影');
    const emptyArtifactEvent = journal.operationEvents.find((event) => event.outputRefs?.includes(emptyArtifactRef));
    if (emptyArtifactEvent === undefined) throw new Error('journal did not receive the empty output event');
    assert.equal(emptyArtifactEvent.kind, 'provider.output');
    assert.equal(emptyArtifactEvent.summary, '未投影');
    const missingArtifactEvent = journal.operationEvents.find((event) => event.outputRefs?.includes(missingArtifactRef));
    if (missingArtifactEvent === undefined) throw new Error('journal did not receive the missing-summary output event');
    assert.equal(missingArtifactEvent.kind, 'provider.output');
    assert.equal(missingArtifactEvent.summary, '未投影');
    assert.equal(
      journal.operationEvents.some((event) => event.kind === 'provider.output' && event.summary === 'real model reply'),
      true,
    );
    assert.equal(journal.operationEvents.every((event) => typeof event.summary === 'string' && event.summary.trim().length > 0), true);
    assert.equal(
      journal.replay().filter((record) => record.kind === 'operation.event').length,
      journal.operationEvents.length,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  await service.startExecution(task.taskId, { prompt: 'run responses replay' });
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
    await service.startExecution(task.taskId, { prompt: `observe ${terminalState}` });
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
    await service.startExecution(task.taskId, { prompt: `run ${terminalState}` });

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
  await service.startExecution(task.taskId, { prompt: 'run without terminal' });

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
  await service.startExecution(task.taskId, { prompt: 'observe stale event' });
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
  const firstStarted = await first.startExecution(firstTask.taskId, { prompt: 'first process' });
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
  await second.startExecution(secondTask.taskId, { prompt: 'second process' });
  await waitFor(() => assert.equal(second.taskDashboard(secondTask.taskId).state, 'succeeded'));
  assert.equal(second.taskDashboard(secondTask.taskId).error, undefined);

  const third = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await third.hydrate();
  assert.equal(third.taskDashboard(firstTask.taskId).state, 'succeeded');
  assert.equal(third.taskDashboard(secondTask.taskId).state, 'succeeded');
  const resumed = await third.startExecution(firstTask.taskId, { prompt: 'new epoch after restart' });
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
  await grantRuntimeTask(first, task.taskId, join(root, 'checkpoints'), 'fake');
  const firstStarted = await first.service.startExecution(task.taskId, { prompt: 'first memory receipt' });
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

    const secondStarted = await second.service.startExecution(task.taskId, { prompt: 'fresh memory receipt' });
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
      admitExecution: async () => {},
      createTaskAssembly() {
        throw new Error('orchestration assembly failed before provider readiness');
      },
    },
  });
  const task = service.createTask({ title: 'orchestration startup failure' });
  await service.startExecution(task.taskId, { prompt: 'start orchestration', orchestrate: true });
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
  await first.startExecution(task.taskId, { prompt: 'fail' });
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
  const started = await first.startExecution(task.taskId, { prompt: 'leave this running' });
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

  await service.startExecution(first.taskId, { prompt: 'first' });
  await service.startExecution(second.taskId, { prompt: 'second' });
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

  await service.startExecution(stoppedTask.taskId, { prompt: 'stop this task' });
  await service.startExecution(continuingTask.taskId, { prompt: 'finish this task' });
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

  const first = await service.startExecution(task.taskId, { prompt: 'first cycle' });
  assert.equal(first.executionEpoch, 1);
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const second = await service.startExecution(task.taskId, { prompt: 'second cycle' });
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
  const started = await service.startExecution(task.taskId, { prompt: 'stop this execution' });

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

  const checkpointPath = join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`);
  const checkpointStore = new FileCheckpointStore(checkpointPath);
  const committed = await checkpointStore.readCommitted({
    organId,
    taskId: task.taskId,
    cycleId: id('cycle', 'ui-cycle-1'),
    operationId: started.operationId,
  }, id('checkpoint', dashboard.checkpoint!.checkpointId));
  if (!committed) throw new Error('expected the exact dashboard stopped checkpoint');
  const relationship = await checkpointStore.readNativeCheckpoint({ checkpoint: committed.checkpoint });
  if (!relationship) throw new Error('expected a durable native receipt for the stopped checkpoint');
  assert.equal(dashboard.checkpoint?.committedAt, relationship.receipt.committedAt);
  assert.equal(dashboard.checkpoint?.committedAtUnavailableReason, undefined);
  const journal = await readFile(checkpointPath, 'utf8');
  assert.match(journal, /"outcome":"stopped"/);
});

test('a stopped task remains stopped after restart hydration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stopped-restart-'));
  const first = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 40 }));
  const task = first.createTask({ title: 'stopped restart' });
  await first.startExecution(task.taskId, { prompt: 'stop before restart' });
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
    runtimeComposition: { admitExecution: async () => {} },
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    providerTools: [RESPONSES_FILE_READ_TOOL],
    providerToolExecutor: {
      async execute() {
        throw new Error('EISDIR: illegal operation on a directory, read');
      },
    },
  });
  const task = service.createTask({ title: 'failed tool execution' });
  const started = await service.startExecution(task.taskId, { prompt: 'read the directory' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, 'failed'));

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
    runtimeComposition: { admitExecution: async () => {} },
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
  await service.startExecution(other.taskId, { prompt: 'stay running' });
  // The other execution stays active, which is what makes the failed task's
  // close see a retained shared provider.
  await waitFor(() => assert.equal(service.taskDashboard(other.taskId).state, 'running'));

  const task = service.createTask({ title: 'retained cleanup failure' });
  await service.startExecution(task.taskId, { prompt: 'read the directory' });

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

  // Release both provider executions before removing the temp directory so no
  // 300s silence-budget timer can write to the journal after teardown. The
  // failed task still holds its session, so its pending stop is retried first;
  // then the held background execution is stopped.
  port.failStop = false;
  await service.retryStop(task.taskId);
  await service.stop(other.taskId);
  await rm(root, { recursive: true, force: true });
});

test('a terminal provider failure does not advertise a stop the provider will reject', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-terminal-failure-'));
  const port = new AbandonedToolExecutionPort();
  // The stream is already terminal when observation fails, so the session can
  // never be released: a stop is impossible and must not be advertised.
  port.failObserve = true;
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
    memory: testMemory('project-ui-terminal-failure'),
    runtimeComposition: { admitExecution: async () => {} },
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
  });
  const task = service.createTask({ title: 'terminal provider failure' });
  await service.startExecution(task.taskId, { prompt: 'fail the transport' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'blocked'), 5000);
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, 'blocked'), 5000);
  const dashboard = service.taskDashboard(task.taskId);
  // The provider session cannot be released, so the task stays blocked. It must
  // not offer retry-stop because both the runtime and RCC v3 reject stop once
  // the execution is terminal; the failure remains recoverable through its
  // owner instead of through an action that cannot succeed.
  assert.ok(dashboard.error?.cleanupError, 'the unresolved cleanup must remain attached to the task error');
  assert.deepEqual(dashboard.allowedActions, []);
  assert.equal(service.taskDashboard(task.taskId).state, 'blocked');
  await assert.rejects(
    async () => service.retryStop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.recoverable',
  );

  await rm(root, { recursive: true, force: true });
});

test('failure cleanup does not advertise a retry-stop fenced by a failed attention publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-fenced-stop-claim-'));
  const port = new AbandonedToolExecutionPort();
  // The transport rejects the stop request, and the stop attention cannot be
  // published either, so the stop claim stays fenced as active. A retry would
  // be refused by beginStop as an already-active stop control, so retry-stop
  // must not be advertised even though the runtime state is still stoppable.
  port.failStop = true;
  const service = new UiRuntimeService({
    mode: 'rcc',
    organId,
    binding,
    port,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: failingAttentionPort(),
    providerState: 'ready',
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    closurePort: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    memory: testMemory('project-ui-fenced-stop-claim'),
    runtimeComposition: { admitExecution: async () => {} },
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    providerTools: [RESPONSES_FILE_READ_TOOL],
    providerToolExecutor: {
      async execute() {
        throw new Error('EISDIR: illegal operation on a directory, read');
      },
    },
  });
  const task = service.createTask({ title: 'fenced stop claim' });
  await service.startExecution(task.taskId, { prompt: 'read the directory' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'blocked'), 5000);
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, 'blocked'), 5000);
  const dashboard = service.taskDashboard(task.taskId);
  // The stop claim is fenced as active, so retry-stop cannot succeed and must
  // not be advertised. The task stays blocked and explicitly non-recoverable
  // through the stop lifecycle rather than exposing a dead-end action.
  assert.equal(dashboard.error?.message, 'EISDIR: illegal operation on a directory, read');
  assert.ok(dashboard.error?.cleanupError, 'the unresolved cleanup must remain attached to the task error');
  assert.deepEqual(dashboard.allowedActions, []);
  await assert.rejects(
    async () => service.retryStop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.recoverable',
  );

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
  const started = await service.startExecution(task.taskId, { prompt: 'fail while stopping' });

  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.running',
  );
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, 'failed'));
  assert.deepEqual(service.taskDashboard(task.taskId).allowedActions, ['start']);
  assert.equal(service.eventsSince(started.operationId).some((event) => event.state === 'blocked'), false);
});

test('driver construction failure rejects release waiters and retains prepared recovery responsibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-driver-factory-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const constructionError = new Error('driver assembly failed');
  const coordinator = new RuntimeTaskCoordinator({
    organId,
    admitExecution: async () => {},
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal,
    createDriver: () => {
      throw constructionError;
    },
  });
  const task = coordinator.createTask({ title: 'driver factory failure' });
  const originalPrompt = 'construct driver';
  const allocation = coordinator.prepareExecution(task.taskId, { prompt: originalPrompt });
  const release = coordinator.releaseExecution(task.taskId, allocation.operationId);
  const pendingObserver = coordinator.releaseExecution(task.taskId, allocation.operationId);
  assert.equal(pendingObserver, release, 'a second release while the first is pending must reuse the same promise');

  // Bound both observers with the existing 3-second local budget: a missing
  // release rejection must fail here instead of waiting indefinitely.
  const bounded = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`release observers were not released within ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  await assert.rejects(() => bounded(release, 3000), (error: unknown) => error === constructionError);
  await assert.rejects(() => bounded(pendingObserver, 3000), (error: unknown) => error === constructionError);

  const dashboard = coordinator.taskSnapshot(task.taskId);
  assert.equal(dashboard.state, 'blocked');
  assert.equal(dashboard.error?.ownerId, 'humanagent.runtime');
  assert.equal(dashboard.error?.message, 'driver assembly failed');
  assert.deepEqual(dashboard.allowedActions, ['stop']);
  assert.equal(dashboard.operationId, allocation.operationId.value);
  assert.equal(dashboard.executionEpoch, allocation.executionEpoch);
  assert.equal(dashboard.checkpoint, undefined);
  assert.deepEqual(coordinator.eventsSince(allocation.operationId).map((event) => event.kind), ['execution.terminal']);

  assert.equal(
    coordinator.prepareExecution(task.taskId, { operationId: allocation.operationId, prompt: originalPrompt }),
    allocation,
    'an exact operation retry must reuse the retained prepared allocation',
  );
  assert.throws(
    () => coordinator.prepareExecution(task.taskId, { prompt: originalPrompt }),
    (error: unknown) => error instanceof RuntimeTaskControlError && error.code === 'task.busy',
  );

  const prepared = journal.replay().filter((record) => record.kind === 'operation.prepared');
  assert.equal(prepared.length, 1, 'a rejected re-preparation must not append a second prepared operation');

  const operationEvents = journal.replay().filter((record) => record.kind === 'operation.event');
  assert.equal(operationEvents.length, 1);
  const blockedEvent = operationEvents[0];
  if (!blockedEvent || blockedEvent.kind !== 'operation.event') throw new Error('expected one persisted operation event');
  assert.equal(blockedEvent.event.kind, 'execution.terminal');
  assert.equal(blockedEvent.event.state, 'blocked');
  assert.equal(blockedEvent.event.ownerId, 'humanagent.runtime');
  assert.equal(blockedEvent.event.operationId, allocation.operationId.value);
  assert.equal(blockedEvent.event.executionEpoch, allocation.executionEpoch);
  assert.equal(blockedEvent.error?.ownerId, 'humanagent.runtime');
  assert.equal(blockedEvent.error?.message, 'driver assembly failed');
  assert.equal(blockedEvent.zeroEffectAdmissionDenial, undefined);
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
  await first.startExecution(failedTask.taskId, { prompt: 'fail source' });
  await waitFor(() => assert.equal(first.taskDashboard(failedTask.taskId).state, 'failed'));
  const failedCheckpointFile = join(root, `task-${failedTask.taskId.value}-cycle-ui-cycle-1.jsonl`);

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await second.hydrate();
  const targetTask = second.createTask({ title: 'scope mismatch target' });
  await second.startExecution(targetTask.taskId, { prompt: 'succeed target' });
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
  assert.equal(dashboard.checkpoint?.committedAt, undefined, 'legacy checkpoint has no durable commit time');
  assert.equal(dashboard.checkpoint?.committedAtUnavailableReason, 'no durable native checkpoint receipt for this checkpoint identity');
});

test('stop during provider observation keeps the stopped projection free of late errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-observed-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 60 }));
  const task = service.createTask({ title: 'stop during observation' });
  const started = await service.startExecution(task.taskId, { prompt: 'observe before stop' });

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
  const started = await service.startExecution(task.taskId, { prompt: 'stop before first event' });

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
  const started = await service.startExecution(task.taskId, { prompt: 'replay' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const all = service.eventsSince(started.operationId);
  assert.ok(all.length > 2);
  const replay = service.eventsSince(started.operationId, all[1]!.eventId);
  assert.deepEqual(replay.map((event) => event.eventId), all.slice(2).map((event) => event.eventId));
  assert.deepEqual(service.eventsSince(started.operationId, 'unknown-event'), all);
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

  // The runtime row is a five-track shell: checkbox, title, status, time, actions.
  assert.match(row, /grid-template-columns:\s*var\(--task-columns\)/);
  assert.match(
    tasksCss,
    /--task-columns:\s*44px\s+minmax\(0,\s*1fr\)\s+84px\s+108px\s+116px;/s,
  );

  // The link spans the title, status and time tracks through subgrid, so every
  // cell stays in the shared five-track row without an implicit second row.
  assert.match(link, /display:\s*grid;/);
  assert.match(link, /grid-column:\s*2\s*\/\s*5;/);
  assert.match(link, /grid-template-columns:\s*subgrid;/);

  // The header uses the shared five-track shell and positions its first label
  // after the checkbox, so the labels stay aligned with the data cells.
  assert.equal(head.includes('grid-template-columns'), false);
  assert.match(tasksCss, /\.task-row\s*\{\s*display:\s*grid;/s);
  assert.match(tasksCss, /\.task-row--head:first-child\s+\.task-cell-label:first-child\s*\{\s*grid-column:\s*2;/s);

  // The five-track table is only safe once the viewport can actually fit the
  // fixed status/time/actions tracks plus the checkbox, gaps, panel padding and
  // page margin. Derive that budget from the stylesheet so the narrow-screen
  // branch cannot silently break the dense layout.
  const linkMin = 84 + 108 + 116 + 2 * 12;

  const checkbox = Number(rule('.task-row-check').match(/width:\s*(\d+)px/)?.[1]);
  const actions = Number(rule('.task-row-actions').match(/min-width:\s*(\d+)px/)?.[1]);
  const panelPadding = 2 * Number(rule('.panel').match(/padding:\s*0\s+(\d+)px/)?.[1]);
  const pageMargin = Number(tasksCss.match(/width:\s*min\(1160px,\s*calc\(100%\s*-\s*(\d+)px\)\)/)?.[1]);
  const rowGaps = 2 * Number(tasksCss.match(/--task-gap:\s*\d+px\s+(\d+)px/)?.[1]);
  const requiredViewport = checkbox + linkMin + actions + rowGaps + panelPadding + pageMargin;

  const wide = 560;
  assert.ok(
    wide < requiredViewport,
    `the narrow-screen branch at ${wide}px cannot fit the ${requiredViewport}px track budget`,
  );

  // The narrow branch must cover the small viewport and lay the link out as one
  // wrapped track rather than the dense subgrid.
  const wrap = tasksCss.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{[\s\S]*?\.task-row-link\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  if (!wrap) throw new Error('expected the wrap breakpoint to lay the link out as wrapped tracks');
  assert.ok(Number(wrap[1]) <= wide);
});

test('restart control endpoint accepts an owner-scoped request without becoming a task operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-restart-control-'));
  const auth = await testAccessControl(root);
  const supervisorToken = auth.accessControl.supervisorToken('lease-1', 7);
  const received: Array<{ readonly leaseId: string; readonly generation: number }> = [];
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    accessControl: auth.accessControl,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: testMemory('project-ui-restart-control'),
    identity: () => ({
      leaseId: 'lease-1',
      generation: 7,
      pid: process.pid,
      processStartToken: 'test-process-start-token',
    }),
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
      headers: {
        authorization: `Bearer ${supervisorToken}`,
        'content-type': 'application/json',
      },
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
    await grantRuntimeTask(runtime, taskId, join(root, 'checkpoints'), 'fake');
    await runtime.service.startExecution(taskId, { prompt: 'typed task detail output' });
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
    await grantRuntimeTask(runtime, id('task', executed.taskId.value), join(root, 'checkpoints'), 'fake');
    await runtime.service.startExecution(id('task', executed.taskId.value), { prompt: 'complete before delete' });
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
    await grantRuntimeTask(first, id('task', taskId), checkpointRoot, 'fake');
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

test('service task list keeps root execution facts and exact child claim identity separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-root-child-projection-'));
  const workspaceDir = join(root, 'workspace-project');
  await mkdir(workspaceDir, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: workspaceDir });
  await ensureControlLayout(paths);
  const checkpointRoot = join(root, 'checkpoints');
  const controlJournal = new JsonlOrganJournal(uiRuntimeControlJournalPath(join(checkpointRoot, 'fake')));
  const identities = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(controlJournal));
  const subscriptionPath = join(checkpointRoot, 'fake', 'subscriptions.jsonl');
  const subscriptions = new SubscriptionControlPort(
    new JsonlOrganJournal(subscriptionPath), { organId }, subscriptionPath,
  );
  const runtimeJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(
      join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`),
    ),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal: runtimeJournal,
    closurePort: runtimeJournal,
    runtimeComposition: { admitExecution: async () => {} },
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: paths.projectKey,
      roleId: 'execution',
    },
    projectKey: paths.projectKey,
    workspaceRoot: paths.workspaceCwd,
    runtimePaths: paths,
    taskIdentity: identities,
    subscriptionControl: subscriptions,
  });
  try {
    const rootTask = service.createTask({ title: 'own execution root', directive: 'complete the root run' });
    await service.startExecution(rootTask.taskId, { prompt: 'complete the root run' });
    await waitFor(() => assert.equal(service.taskDashboard(rootTask.taskId).state, 'succeeded'));
    const childTask = service.createTask({ title: 'scheduled child', directive: 'child waits for admission' });
    const rootTaskId = rootTask.taskId;
    const childTaskId = childTask.taskId;

    // Both facts commit on the same control/journal authority the service reads.
    const requirementId = 'requirement-root-child-projection';
    await identities.establish({
      scope: { organId, taskId: rootTaskId },
      source: {
        requirementId, inputRevision: 1, draftId: 'draft-root-child-projection',
        draftRevisionVersion: 1, draftRevisionHash: 'hash-root-child-projection',
        confirmationRef: 'confirm-root-child-projection',
      },
      title: 'own execution root',
    });
    await identities.establish({
      scope: { organId, taskId: childTaskId },
      source: {
        requirementId: 'requirement-root-child-projection-child', inputRevision: 1,
        draftId: 'draft-root-child-projection-child', draftRevisionVersion: 1,
        draftRevisionHash: 'hash-root-child-projection-child',
        confirmationRef: 'confirm-root-child-projection-child',
      },
      title: 'scheduled child',
    });
    const subscriptionId = `subscription:${requirementId}`;
    const dueAt = '2026-10-24T18:00:00.000Z';
    const schedule = await subscriptions.create({
      subscriptionId,
      goalId: requirementId,
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    }, {
      policyId: 'policy-root-child-projection',
      policyRevision: 1,
      timezone: 'UTC',
      canonicalInstant: dueAt,
      dstMode: 'wall',
      dstMissedPolicy: 'shift-forward',
      dstAmbiguousPolicy: 'earlier-offset',
      latePolicy: 'run-once',
      busyPolicy: 'skip',
      executionMode: 'once',
      dueAt,
    }, subscriptionId);
    await subscriptions.schedule({
      occurrence: {
        subscriptionId,
        scheduleRevision: schedule.subscription.scheduleRevision,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt,
      },
      nowAt: dueAt,
    });
    await subscriptions.claim({
      subscriptionId,
      scheduleRevision: schedule.subscription.scheduleRevision,
      occurrenceOrdinal: 1,
      dueAt,
      taskId: childTaskId,
      operationId: id('operation', 'root-child-projection-claim'),
      inputArtifactDigest: 'sha256:root-child-projection-claim',
      schedulerInstanceId: 'root-child-projection-fixture',
      leaseId: 'root-child-projection-fixture',
      generation: 1,
      executionEpoch: 1,
      nowAt: dueAt,
      leaseUntil: '2026-10-24T19:00:00.000Z',
    });

    const list = await service.listTasksWithIdentitySource();
    const row = list.completed.find((candidate) => candidate.taskId.value === rootTaskId.value);
    if (row === undefined) throw new Error('the root own execution row must stay in completed');
    assert.equal(row.state, 'succeeded');
    assert.equal(row.currentExecutionTaskId, undefined);
    assert.equal(row.executionState, undefined);
    assert.equal(row.controlTarget?.projectKey, paths.projectKey);
    assert.equal(row.controlTarget?.mode, 'fake');
    assert.equal(row.executions?.length, 1);
    assert.equal(row.executions?.[0]?.taskId.value, childTaskId.value);
    assert.equal(row.executions?.[0]?.executionLineage?.parentTaskId.value, rootTaskId.value);
    assert.equal(row.executions?.[0]?.controlTarget?.projectKey, paths.projectKey);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await grantRuntimeTask(runtime, task.taskId, join(root, 'checkpoints'), 'fake');
    const started = await runtime.service.startExecution(task.taskId, { prompt: 'stream the full lifecycle' });
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

test('checkpoint committedAt binds to the first durable receipt instead of later terminal updates', async () => {
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
  try {
    const task = service.createTask({ title: 'checkpoint timestamp' });
    const started = await service.startExecution(task.taskId, { prompt: 'timestamp' });
    await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

    const events = service.eventsSince(started.operationId);
    const checkpointEvent = events.find((event) => event.kind === 'checkpoint.committed');
    const terminalEvent = events.at(-1);
    if (!checkpointEvent || !terminalEvent) throw new Error('expected checkpoint and terminal events');
    assert.equal(checkpointEvent.kind, 'checkpoint.committed');
    assert.equal(terminalEvent.kind, 'execution.terminal');
    assert.equal(checkpointEvent.occurredAt === terminalEvent.occurredAt, false);

    const checkpoint = service.taskDashboard(task.taskId).checkpoint;
    if (!checkpoint) throw new Error('succeeded implies a checkpoint');
    const prefix = `task-${task.taskId.value}-cycle-`;
    const file = (await readdir(root)).find((name) => name.startsWith(prefix) && name.endsWith('.jsonl'));
    if (!file) throw new Error('expected the physical checkpoint file');
    const store = new FileCheckpointStore(join(root, file));
    const relationship = await store.readNativeCheckpoint({ checkpoint: {
      id: id('checkpoint', checkpoint.checkpointId),
      scope: { organId, taskId: task.taskId, cycleId: id('cycle', file.slice(prefix.length, -'.jsonl'.length)) },
    } });
    assert.ok(relationship, 'the success checkpoint has a durable native receipt');
    assert.equal(checkpoint.committedAt, relationship!.receipt.committedAt);
    assert.equal(checkpoint.committedAtUnavailableReason, undefined);
    assert.equal(checkpoint.committedAt === checkpointEvent.occurredAt, false, 'the commit time is not the checkpoint event time');
    assert.equal(checkpoint.committedAt === terminalEvent.occurredAt, false, 'the commit time is not the terminal event time');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fake and rcc modes do not hydrate each other through a shared checkpoint root', async () => {
  const fixtureRoot = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'humanagent-ui-mode-isolation-'));
  try {
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
      runtimeComposition: {
        // This start only reads the checkpoint root the fake launch wrote. The
        // read-only mode-isolation check must never reach either real preparer.
        prepareAgentProvider: async () => {
          throw new Error('read-only mode isolation must not prepare a launch provider');
        },
        prepareTaskAgentProvider: async () => {
          throw new Error('read-only mode isolation must not prepare a Task provider');
        },
      },
    });
    try {
      const tasks = await fetch(`${rcc.server.url}/api/tasks`);
      const body = await tasks.json() as { readonly counts: { readonly total: number } };
      assert.equal(body.counts.total, 0);
    } finally {
      await rcc.server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
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
    runtimeComposition: {
      prepareAgentProvider: async () => {
        throw new Error('the readiness gate must reject before provider preparation');
      },
      // A real non-fake launch requires the Task-scoped custody preparer. This
      // wires the same prepareExecutionAgentProvider seam the serve caller uses,
      // but the readiness gate must reject before either preparer runs, so the
      // selected Task port factory never prepares anything.
      prepareTaskAgentProvider: (selection, owner, lease) => prepareExecutionAgentProvider({
        roleId: selection.roleId,
        ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
        agentProviderBindings: [],
        legacyProvider: preparedStopComposition(buildFakeExecutionPort(binding, 1)).provider,
        createPort: () => {
          throw new Error('the readiness gate must reject before Task provider preparation');
        },
      }, owner, lease),
    },
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
  await service.startExecution(task.taskId, { prompt: 'fail explicitly' });

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
  await service.startExecution(task.taskId, { prompt: 'start guard' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  const stopResult = await service.stop(task.taskId);
  assert.equal(stopResult.state, 'settling');
  assert.equal(service.taskDashboard(task.taskId).state, 'settling');
  assert.deepEqual(service.taskDashboard(task.taskId).allowedActions, ['retry-stop']);
  const retryResult = await service.retryStop(task.taskId);
  assert.equal(retryResult.state, 'settling');
  await assert.rejects(
    () => service.deleteTask(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.busy',
  );
  await assert.rejects(
    () => service.startExecution(task.taskId, { prompt: 'should reject' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.busy',
  );
});

test('stop control rejects a second stop and preserves the original operation identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-race-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 100 }));
  const task = service.createTask({ title: 'stop race' });
  await service.startExecution(task.taskId, { prompt: 'stop race' });
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
  await service.startExecution(task.taskId, { prompt: 'settle stop race' });
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
  const admissionStarted = await admissionService.startExecution(admissionTask.taskId, { prompt: 'must not dispatch' });
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
  const controlStarted = await controlService.startExecution(controlTask.taskId, { prompt: 'must not succeed' });
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
  const started = await failingService.startExecution(task.taskId, { prompt: 'commit once' });
  await waitFor(() => assert.equal(failingService.taskDashboard(task.taskId).state, 'blocked'));
  const failedDashboard = failingService.taskDashboard(task.taskId);
  if (!failedDashboard.checkpoint) throw new Error('expected durable checkpoint identity');
  assert.equal(failedDashboard.checkpoint.outcome, 'succeeded');
  assert.equal(failedDashboard.error?.ownerId, 'ui-context-commit-gate');
  assert.equal(failedDashboard.error?.nextAction, 'reconcile committed checkpoint');
  const checkpointPath = join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`);
  const checkpointJournal = await readFile(checkpointPath, 'utf8');
  const checkpointRecords = checkpointJournal
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly kind?: string });
  assert.equal(checkpointRecords.filter((record) => record.kind === 'checkpoint').length, 1);
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
    runtimeComposition: { admitExecution: async () => {} },
    memory: {
      ...testMemory('project-ui-boundary-success'),
      checkpointBoundary: boundary,
    },
  });
  const task = service.createTask({ title: 'durable memory boundary' });
  await service.startExecution(task.taskId, { prompt: 'complete once' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  assert.equal(published.length, 1);
  assert.equal(published[0]?.checkpoint.outcome, 'succeeded');
  assert.equal(typeof published[0]?.recordDigest, 'string');
  assert.equal(published[0]?.recordDigest?.startsWith('sha256:'), true);
  const journal = await readFile(
    join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`),
    'utf8',
  );
  const checkpointRecords = journal
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly kind?: string; readonly recordDigest?: string })
    .filter((record) => record.kind === 'checkpoint');
  assert.equal(checkpointRecords.length, 1);
  assert.equal(published[0]?.recordDigest, checkpointRecords[0]?.recordDigest);
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
    runtimeComposition: { admitExecution: async () => {} },
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
  const started = await service.startExecution(task.taskId, { prompt: 'commit once' });
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
  assert.deepEqual(await service.deleteTask(task.taskId), { taskId: task.taskId.value, deleted: true });
  const checkpointJournal = await readFile(
    join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`),
    'utf8',
  );
  const checkpointRecords = checkpointJournal
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly kind?: string });
  assert.equal(checkpointRecords.filter((record) => record.kind === 'checkpoint').length, 1);
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
    const started = await failingService.startExecution(task.taskId, { prompt: `commit ${checkpointOutcome}` });
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
    await assert.rejects(
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
  const started = await failingService.startExecution(task.taskId, { prompt: 'commit once with close failure' });
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
  await assert.rejects(
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
  const started = await service.startExecution(task.taskId, { prompt: 'stop with post-commit hook failure' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'execution.context-commit-hook.blocked',
  );
  const failedDashboard = service.taskDashboard(task.taskId);
  if (!failedDashboard.checkpoint) throw new Error('expected durable stopped checkpoint identity');
  assert.equal(failedDashboard.state, 'blocked');
  assert.equal(failedDashboard.checkpoint.outcome, 'stopped');
  const checkpointPath = join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`);
  const checkpointStore = new FileCheckpointStore(checkpointPath);
  const committed = await checkpointStore.readCommitted({
    organId,
    taskId: task.taskId,
    cycleId: id('cycle', 'ui-cycle-1'),
    operationId: started.operationId,
  }, id('checkpoint', failedDashboard.checkpoint.checkpointId));
  if (!committed) throw new Error('expected the exact dashboard stopped checkpoint');
  const relationship = await checkpointStore.readNativeCheckpoint({ checkpoint: committed.checkpoint });
  if (!relationship) throw new Error('committed stopped checkpoint keeps its durable native receipt');
  assert.equal(failedDashboard.checkpoint.committedAt, relationship.receipt.committedAt);
  assert.equal(failedDashboard.checkpoint.committedAtUnavailableReason, undefined);
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
  assert.equal(recovered.checkpoint?.committedAt, failedDashboard.checkpoint.committedAt);
  assert.equal(recovered.error?.code, 'execution.context-commit-hook.blocked');
  assert.equal(recovered.error?.ownerId, 'ui-stop-context-commit-gate');
  assert.equal(recovered.error?.nextAction, 'reconcile stopped checkpoint');
  assert.deepEqual(recovered.allowedActions, []);
  await assert.rejects(
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
  let markFirstYielded!: () => void;
  const firstYielded = new Promise<void>((resolve) => {
    markFirstYielded = resolve;
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
      markFirstYielded();
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
  const started = await service.startExecution(task.taskId, { prompt: 'stop before late event' });
  await waitFor(() => assert.equal(service.eventsSince(started.operationId).some((event) =>
    event.kind === 'provider.model' && event.state === 'model'), true));
  await firstYielded;

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
  await assert.rejects(
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
  const started = await service.startExecution(task.taskId, { prompt: 'persist recovery before close' });
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
  await assert.rejects(
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
  const started = await service.startExecution(task.taskId, { prompt: 'composition' });
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
  const failedStart = await failingService.startExecution(failedTask.taskId, { prompt: 'must fail visibly' });
  await waitFor(() => assert.equal(failingService.taskDashboard(failedTask.taskId).state, 'failed'));
  const failedDashboard = failingService.taskDashboard(failedTask.taskId);
  assert.match(failedDashboard.statusSections.business, /失败/);
  assert.match(failedDashboard.statusSections.waiting, /已提交收拢记录/);
  assert.equal(failedDashboard.statusSections.business.includes('尚未提交'), false);
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
  await service.startExecution(task.taskId, { prompt: 'baseline input' });
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

test('implicit executor produced output excludes provider semantic model summaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-implicit-output-summary-'));
  try {
    const port = new SemanticModelSummaryReplayPort({
      binding,
      stepDelayMs: 1,
      replay: [
        { kind: 'model', state: 'model', summary: 'ignored model summary' },
        { kind: 'output', state: 'output', summary: 'hello ', outputRefs: ['fake://output/1'] },
        { kind: 'output', state: 'output', summary: 'world', outputRefs: ['fake://output/2'] },
        { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
      ],
    });
    const service = serviceFor(root, port);
    const executionAgent = (service as unknown as {
      createImplicitSubtaskExecutionAgent(): ExecutionAgentPort;
    }).createImplicitSubtaskExecutionAgent();
    const taskId = id('task', 'task-implicit-output-summary');
    const scope: ScopeRef = {
      organId,
      taskId,
      cycleId: id('cycle', 'cycle-implicit-output-summary'),
      operationId: id('operation', 'operation-implicit-output-summary'),
    };
    const result = await executionAgent.execute({
      assignment: {
        assignmentId: 'assignment-implicit-output-summary',
        taskId,
        pipelineNodeId: 'pipeline.execute',
        attempt: 1,
        executionEpoch: 1,
        inputRevision: 1,
        objective: 'summarize the model reply',
        targetRefs: ['artifact://implicit-output-summary'],
        expectedOutputRefs: ['artifact://implicit-output-summary'],
        successCriteria: ['the reply is projected'],
        failureCriteria: ['the reply is not projected'],
        incompleteCriteria: ['the reply is incomplete'],
        requiredCapabilities: ['provider.execution'],
        mergeGate: 'required',
      },
      agentId: 'agent-implicit-output-summary',
      executionEpoch: 1,
      attempt: 1,
      lease: {
        leaseId: 'lease-implicit-output-summary',
        runtimeId: 'runtime-implicit-output-summary',
        generation: 1,
        incarnation: {
          runtimeId: 'runtime-implicit-output-summary',
          generation: 1,
          agentInstanceId: 'agent-implicit-output-summary',
          roleId: 'execution',
          taskId,
          assignmentId: 'assignment-implicit-output-summary',
          executionEpoch: 1,
        },
        executionEpoch: 1,
        ownerId: 'ui-runtime-test',
        assignmentId: 'assignment-implicit-output-summary',
        capabilities: ['provider.execution'],
      },
      scope,
    });
    assert.ok('status' in result);
    const workResult = result as Extract<typeof result, { readonly status: string }>;
    assert.equal(workResult.status, 'succeeded');
    assert.equal(workResult.summary, 'implicit executor agent-implicit-output-summary succeeded: hello world');
    assert.deepEqual(workResult.producedArtifactBodies, ['hello world']);
    assert.equal(workResult.summary.includes('provider requested model work'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('produced artifact paths count only file-producing calls, in order and without repeats', () => {
  const providerEvent = (toolId: string, argumentsValue: Record<string, string>) => ({
    providerEvent: {
      runtimeId: 'runtime-produced-artifact',
      taskId: id('task', 'task-produced-artifact'),
      operationId: id('operation', 'operation-produced-artifact'),
      executionEpoch: 1,
      eventId: `event-${toolId}`,
      kind: 'tool' as const,
      evidenceRefs: [],
      toolCall: { callId: `call-${toolId}`, toolId, arguments: argumentsValue, continuationRef: 'response-1' },
    },
  });
  assert.deepEqual(
    producedArtifactPaths([
      providerEvent('file.read', { path: 'result.html' }),
      providerEvent('file.search', { query: 'pelican' }),
      providerEvent('web.search', { query: 'pelican' }),
      providerEvent('file.write', { file_path: 'result.html', content: '<html></html>' }),
      providerEvent('file.edit', { file_path: 'artifact.svg', old_string: 'a', new_string: 'b' }),
      providerEvent('file.write', { file_path: 'result.html', content: '<html>again</html>' }),
      providerEvent('file.write', { file_path: '   ' }),
      providerEvent('bash', { command: 'touch x' }),
    ]),
    ['result.html', 'artifact.svg'],
  );
  assert.deepEqual(producedArtifactPaths([]), []);
});

test('produced artifact body carries the produced files so a reviewer can check file content', () => {
  const output = 'Both files are written.';
  assert.equal(producedArtifactBody(output, []), output);
  const body = producedArtifactBody(output, [
    { path: 'result.html', content: '<html><svg></svg></html>' },
    { path: 'artifact.svg', content: '<svg animate="1"></svg>' },
  ]);
  assert.match(body, /^Both files are written\./);
  assert.match(body, /--- file: result\.html ---\n<html><svg><\/svg><\/html>/);
  assert.match(body, /--- file: artifact\.svg ---\n<svg animate="1"><\/svg>/);
});

test('orchestrated review is handed the produced file bodies, not only the executor summary', async () => {
  const fixtureRoot = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'humanagent-ui-produced-artifacts-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'artifact.svg'), '<svg id="pelican">animated</svg>', 'utf8');
  const port = new CountingFakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [
      { kind: 'model', state: 'model', summary: 'fake replay: model accepted the request' },
      { kind: 'output', state: 'output', summary: 'fake replay: draft output chunk 1', outputRefs: ['fake://output/1'] },
      {
        kind: 'tool',
        state: 'tool',
        summary: 'file.write',
        toolCall: {
          callId: 'call-write-artifact',
          toolId: 'file.write',
          arguments: { file_path: 'artifact.svg', content: '<svg id="pelican">animated</svg>' },
          continuationRef: 'response-1',
        },
      },
      { kind: 'terminal', state: 'tool-waiting', summary: 'provider awaits the tool result', terminalState: 'waiting', nextAction: { kind: 'continue', ref: 'responses-tool-call' } },
      { kind: 'output', state: 'output', summary: 'fake replay: final output chunk 2', outputRefs: ['fake://output/2'] },
      { kind: 'terminal', state: 'succeeded', summary: 'fake replay: execution succeeded', terminalState: 'succeeded' },
    ],
  });
  const subjectBodies: string[] = [];
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port,
    workspaceRoot,
    providerTools: [RESPONSES_FILE_WRITE_TOOL],
    providerToolExecutor: {
      async execute(request) {
        return {
          output: JSON.stringify({ path: request.call.arguments.file_path, operation: 'write' }),
          outputRefs: [],
          evidenceRefs: [],
        };
      },
    },
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    closurePort: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    memory: testMemory('project-ui-produced-artifacts'),
    runtimeComposition: {
      admitExecution: async () => {},
      createTaskAssembly({ task, scope, checkpointJournal, executionAgent, maxAttempts }) {
        const runtimePool = new AgentRuntimePoolManager({
          maxRuntimes: 4,
          factory: {
            async start(request) {
              return { runtimeId: request.runtimeId, generation: request.generation, capabilities: [...request.requiredCapabilities] };
            },
            async dispose() {},
          },
          ownerId: 'ui-runtime-test',
          initialRuntimes: [{
            runtimeId: 'ui-runtime-test-0',
            generation: 1,
            capabilities: ['code.search', 'file.checkpoint', 'provider.execution'],
          }],
        });
        const reviewOnce = async (input: Parameters<ReviewAgentPort['review']>[0]) => {
          for (const subject of input.reviewMaterial?.subjects ?? []) subjectBodies.push(subject.body);
          return {
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
            evidenceRefs: [evidence('produced-artifacts-review', input.scope)],
          };
        };
        const reviewAgent: ReviewAgentPort = {
          roleId: 'ui-runtime-test-review',
          createInstance(create) {
            return {
              incarnation: create.incarnation,
              async review(input) {
                const result = await reviewOnce(input);
                return {
                  result,
                  output: { text: `ui review ${input.reviewAssignment.assignmentId}`, artifactRef: null, artifactDigest: null },
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
                evidence(`produced-artifacts-merge-${request.workerAssignment.assignmentId}`, request.scope),
              ],
            };
          },
        };
        const orchestration = new OrchestrationManager({
          ownerId: 'ui-runtime-test',
          runtimePool,
          executionAgent,
          reviewAgent,
          mergeCoordinator,
          maxAttempts: maxAttempts ?? 1,
        });
        return { orchestration, runtimePool };
      },
    },
  });
  try {
    service.startImplicitConsumer();
    const interactionId = await service.receiveExplicitInput({
      sourceRef: 'ui:produced-artifacts',
      rawInput: 'produce the animated artifact',
      channel: 'business',
    });
    await service.beginExplicitMatching(interactionId);
    await service.recordExplicitMatch(interactionId, {
      normalizedInput: 'produce the animated artifact',
      matchedTasks: [],
      knownFacts: [],
    });
    await service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'create',
      proposal: 'produce the animated artifact',
    });
    const proposed = await service.inspectExplicitInteraction(interactionId);
    await service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:produced-artifacts',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-02T00:00:00.000Z',
      payloadRef: 'asset://requirements/produced-artifacts',
    });
    await waitFor(() => assert.equal(
      service.listTasks().completed[0]?.state,
      'succeeded',
      JSON.stringify(service.listTasks().counts),
    ));
    assert.ok(subjectBodies.length > 0, 'the review agent was invoked');
    // The reviewer must see the artifact itself: the executor summary alone
    // cannot be checked against acceptance criteria that describe file content.
    assert.match(subjectBodies[0]!, /--- file: artifact\.svg ---/);
    assert.match(subjectBodies[0]!, /<svg id="pelican">animated<\/svg>/);
    assert.match(subjectBodies[0]!, /fake replay: final output chunk 2/);
  } finally {
    await service.quiesceImplicitConsumption();
    await rm(root, { recursive: true, force: true });
  }
});

test('produced artifact reader returns written files and reports paths it cannot hand over', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-produced-artifacts-'));
  try {
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'artifact.svg'), '<svg>animated</svg>', 'utf8');
    const files = await readProducedArtifacts(root, [
      'nested/artifact.svg',
      'missing.html',
      '../outside.txt',
    ]);
    assert.equal(files[0]?.path, 'nested/artifact.svg');
    assert.equal(files[0]?.content, '<svg>animated</svg>');
    assert.match(String(files[1]?.content), /^\[unreadable: /);
    assert.match(String(files[2]?.content), /^\[unreadable: path escapes workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('produced artifact truncation honours its byte bound for multibyte content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-produced-artifacts-bytes-'));
  try {
    // 90k three-byte characters exceed the 256KiB per-file bound; slicing the
    // decoded string by that number would emit three times the declared bytes.
    await writeFile(join(root, 'wide.txt'), '中'.repeat(90_000), 'utf8');
    const files = await readProducedArtifacts(root, ['wide.txt']);
    const content = String(files[0]?.content);
    const marker = content.indexOf('\n[truncated at ');
    assert.ok(marker > 0, 'the per-file byte bound must be reached');
    const prefix = content.slice(0, marker);
    assert.ok(
      new TextEncoder().encode(prefix).length <= 262_144,
      `truncated prefix is ${new TextEncoder().encode(prefix).length} bytes`,
    );
    assert.equal(prefix.includes('\uFFFD'), false, 'the cut must not split a multi-byte sequence');
    assert.match(content, /\[truncated at 262144 bytes\]$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime history reports the provider-reported turn identity and event time across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-turn-identity-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const journal = new UiRuntimeJournal(journalPath);
  const port = new TurnIdentityCapturingReplayPort({ binding, stepDelayMs: 1 });
  const service = serviceFor(root, port, 'fake', 'ready', journal);
  const task = service.createTask({ title: 'turn identity projection' });
  await service.startExecution(task.taskId, { prompt: 'project the real turn identity' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  // The execution port is the only boundary that sees the provider binding's own
  // request identity, so it is the independent oracle for everything below.
  assert.ok(port.observeIdentities.length > 0, 'the provider binding must have observed the execution');
  const reported = port.observeIdentities[0]!;
  const reportedTurnId = reported.turnId;
  const reportedRequestId = reported.requestId;
  if (reportedTurnId === undefined) throw new Error('the provider binding must report a turn id');
  if (reportedRequestId === undefined) throw new Error('the provider binding must report a request id');
  assert.match(reportedTurnId, /^turn-/);
  for (const identity of port.observeIdentities) {
    assert.equal(identity.turnId, reportedTurnId, 'one execution stays inside one provider turn');
    assert.equal(identity.requestId, reportedRequestId);
  }

  const history = service.history(task.taskId, { limit: 50 });
  assert.equal(history.ok, true);
  if (!history.ok) throw new Error('history must project the runtime trace');
  assert.ok(history.page.items.length > 0, 'a succeeded execution must have a trace');
  // The provider-reported occurrence time is the real event time; a render or
  // receipt time would not be this exact value.
  const providerEntries = history.page.items.filter((entry) => entry.kind !== 'status');
  assert.ok(providerEntries.length > 0);
  for (const entry of providerEntries) {
    assert.equal(entry.turnId, reportedTurnId);
    assert.equal(entry.requestId, reportedRequestId);
    assert.equal(entry.occurredAt, port.providerOccurredAt);
  }
  // The runtime's own pre-provider event has no provider turn, and the trace
  // reports that absence explicitly instead of synthesizing an identifier.
  const started = history.page.items.find((entry) => entry.seq === 1);
  assert.equal(started?.state, 'running');
  assert.equal(started?.turnId, undefined);
  assert.equal(started?.requestId, undefined);
  // No entry may carry a synthesized identifier of the retired `<seq>.<ref>` shape.
  for (const entry of history.page.items) {
    if (entry.turnId === undefined) continue;
    assert.equal(/^\d+\./.test(entry.turnId), false, entry.turnId);
  }

  const pipeline = service.observation(task.taskId, 'pipeline.execute').selectedNode;
  assert.equal(pipeline?.turnId, reportedTurnId);

  // The real identity and event time are persisted in the runtime journal, which
  // is what makes them restart-readable rather than process-local.
  const persisted = journal.replay().filter((record) => record.kind === 'operation.event');
  assert.ok(persisted.length > 0);
  const persistedTurnIds = new Set(
    persisted.flatMap((record) => (record.kind === 'operation.event' && record.event.turnId !== undefined ? [record.event.turnId] : [])),
  );
  assert.deepEqual([...persistedTurnIds], [reportedTurnId]);
  assert.ok(
    persisted.some((record) => record.kind === 'operation.event' && record.event.providerOccurredAt === port.providerOccurredAt),
    'the provider-reported event time must be journaled',
  );

  // Restart from the same control root: the trace must read back the same real
  // turn identity and the same provider-reported event time.
  const restarted = serviceFor(root, new TurnIdentityCapturingReplayPort({ binding, stepDelayMs: 1 }), 'fake', 'ready', journal);
  await restarted.hydrate();
  const replayed = restarted.history(task.taskId, { limit: 50 });
  assert.equal(replayed.ok, true);
  if (!replayed.ok) throw new Error('history must project the replayed runtime trace');
  assert.deepEqual(
    replayed.page.items.map((entry) => [entry.seq, entry.turnId, entry.occurredAt]),
    history.page.items.map((entry) => [entry.seq, entry.turnId, entry.occurredAt]),
  );
  assert.equal(restarted.observation(task.taskId, 'pipeline.execute').selectedNode?.turnId, reportedTurnId);
  await rm(root, { recursive: true, force: true });
});

test('runtime history reports the explicit no-turn state for a task with no provider event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-turn-identity-absent-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const task = service.createTask({ title: 'no provider turn yet' });
  const history = service.history(task.taskId, { limit: 20 });
  assert.equal(history.ok, true);
  if (!history.ok) throw new Error('history must project an empty real trace');
  assert.deepEqual(history.page.items, []);
  assert.equal(history.page.hasMore, false);
  assert.equal(service.observation(task.taskId, 'pipeline.execute').selectedNode?.turnId, undefined);
  await rm(root, { recursive: true, force: true });
});

test('runtime history states real tool pairing and keeps a succeeded result verifiable', () => {
  const taskId = id('task', 'turn-identity-tool-pairing');
  const scope: ScopeRef = { organId, taskId };
  const runtimeEvent = (seq: number, over: Partial<RuntimeTaskEvent>): RuntimeTaskEvent => ({
    eventId: `event-${seq}`,
    seq,
    occurredAt: '2026-10-06T08:00:00.000Z',
    taskId,
    operationId: 'operation-turn-identity',
    executionEpoch: 1,
    kind: 'provider.tool',
    state: 'running',
    summary: `runtime event ${seq}`,
    evidenceRefs: [evidence(`tool-${seq}`, scope)],
    ...over,
  });
  // The projection reads the runtime event stream; that is the real input shape
  // the runtime coordinator journals, so this exercises the real projection.
  const snapshot = {
    events: [
      runtimeEvent(1, { kind: 'provider.tool', callId: 'call-returned', toolId: 'file.read' }),
      runtimeEvent(2, { kind: 'provider.tool-result', callId: 'call-returned', toolId: 'file.read', status: 'succeeded' }),
      runtimeEvent(3, { kind: 'provider.tool', callId: 'call-open', toolId: 'file.list' }),
    ],
  } as unknown as RuntimeTaskSnapshot;

  const history = projectRuntimeTaskHistory(snapshot, { limit: 20 });
  assert.equal(history.ok, true);
  if (!history.ok) throw new Error('history must project the runtime events');
  const returned = history.page.items.find((entry) => entry.kind === 'tool-call' && entry.tool?.callId === 'call-returned');
  const open = history.page.items.find((entry) => entry.kind === 'tool-call' && entry.tool?.callId === 'call-open');
  const result = history.page.items.find((entry) => entry.kind === 'tool-result');
  if (!returned || !open || !result) throw new Error('the projection must carry every reported tool event');

  // Pairing is a real reported fact: the call that has a result event is paired,
  // and the call with no result is explicitly not returned. A real succeeded
  // result must therefore never render as "未返回".
  assert.equal(returned.tool?.paired, true);
  assert.equal(open.tool?.paired, false);
  assert.equal(result.tool?.paired, true);

  // The succeeded result points at the returned side through its evidence ref,
  // so the projection never invents an output ref or digest for it.
  assert.equal(result.tool?.status, 'succeeded');
  assert.equal(result.tool?.outputRef, undefined);
  assert.equal(result.tool?.outputDigest, undefined);
  assert.ok(result.evidenceRefs.length > 0, 'a succeeded tool result must keep a real evidence pointer');
  // The public contract accepts this real shape: it does not throw.
  validateInteractionTraceEntry(result);

  // The same success with no pointer at all is rejected by the public contract,
  // so no surface can present it as a bare success claim.
  assert.throws(
    () => validateInteractionTraceEntry({ ...result, evidenceRefs: [] }),
    (error: unknown) => error instanceof ContractError,
  );
});

test('public tool readback fails closed for a mismatched persisted fact and preserves legacy no-fact readback', async () => {
  const taskId = id('task', 'fact-readback-task');
  const operationId = id('operation', 'fact-readback-operation');
  const event = (executionFact?: RuntimeTaskEvent['executionFact']): RuntimeTaskEvent => ({
    eventId: 'event-fact-readback',
    seq: 1,
    occurredAt: '2026-10-06T08:00:00.000Z',
    taskId,
    operationId: operationId.value,
    executionEpoch: 1,
    kind: 'provider.tool-result',
    state: 'tool',
    summary: 'file.search succeeded',
    evidenceRefs: [evidence('fact-readback', { organId, taskId })],
    requestId: 'request-fact-readback',
    callId: 'call-fact-readback',
    toolId: 'file.search',
    status: 'succeeded',
    outputRef: 'asset://provider-tool/output/fact-readback',
    outputDigest: `sha256:${'a'.repeat(64)}`,
    ...(executionFact === undefined ? {} : { executionFact }),
  });
  const records = (runtimeEvent: RuntimeTaskEvent): RuntimeTaskJournalRecord[] => [{
    kind: 'task.created',
    taskId,
    title: 'fact readback',
    directive: 'fact readback',
    directiveRevision: 1,
    createdAt: '2026-10-06T08:00:00.000Z',
    taskCounter: 1,
  }, {
    kind: 'operation.started',
    operationId,
    taskId,
    cycleId: id('cycle', 'fact-readback-cycle'),
    scope: {
      organId,
      taskId,
      cycleId: id('cycle', 'fact-readback-cycle'),
      operationId,
    },
    executionEpoch: 1,
    operationCounter: 1,
    cycleCounter: 1,
    startedAt: '2026-10-06T08:00:00.000Z',
    input: 'fact readback',
  }, {
    kind: 'operation.event',
    operationId,
    event: runtimeEvent,
  }];
  function buildReadbackService(root: string, readReport: () => Promise<unknown>): UiRuntimeService {
    return buildReadbackServiceWithJournal(root, new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')), readReport);
  }
  function buildReadbackServiceWithJournal(
    root: string,
    journal: UiRuntimeJournal,
    readReport: () => Promise<unknown>,
  ): UiRuntimeService {
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
      checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `task-${task.value}-cycle-${cycle.value}.jsonl`)),
      attentionPort: attentionPort(),
      providerState: 'ready',
      journal,
      closurePort: journal,
      memory: testMemory('project-ui-test'),
      explicitBrainInterpreter: unusedExplicitBrainInterpreter,
      toolOutputStore: {
        store: new ImmutableAssetStore(join(root, 'tool-output-assets')),
        async writeReport() {
          throw new Error('writeReport is not used by readback tests');
        },
        readReport,
        async writeArtifact() {
          throw new Error('writeArtifact is not used by readback tests');
        },
        async readArtifact() {
          throw new Error('readArtifact is not used by readback tests');
        },
      },
    });
    return service;
  }

  class PreparedReplayJournal extends UiRuntimeJournal {
    constructor(
      private readonly preparedRecords: readonly RuntimeTaskJournalRecord[],
      filePath: string,
    ) {
      super(filePath);
    }

    override replay(): readonly RuntimeTaskJournalRecord[] {
      return this.preparedRecords;
    }
  }

  async function serviceForReadback(root: string, runtimeEvent: RuntimeTaskEvent, readReport: () => Promise<unknown>): Promise<UiRuntimeService> {
    await writeFile(join(root, 'ui-runtime-journal.jsonl'), `${records(runtimeEvent).map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    const service = buildReadbackService(root, readReport);
    await service.hydrate();
    return service;
  }

  const mismatchRoot = await mkdtemp(join(tmpdir(), 'humanagent-ui-fact-readback-mismatch-'));
  try {
    let mismatchReads = 0;
    const mismatchedFact: NonNullable<RuntimeTaskEvent['executionFact']> = {
      identity: { surface: 'responses', toolId: 'file.search', bindingRef: binding.bindingId, route: 'app.file-search.local' },
      requestRef: 'request-fact-readback',
      callRef: 'call-fact-readback',
      operationRef: operationId.value,
      state: 'succeeded',
      rawEvidenceRefs: ['asset://provider-tool/output/fact-readback'],
      resultRef: 'asset://provider-tool/output/other',
      resultDigest: `sha256:${'a'.repeat(64)}`,
    };
    // Bypass real replay for this service-only boundary test. The real disk
    // replay mismatch is covered separately in event-journal and consumer tests.
    const service = buildReadbackServiceWithJournal(
      mismatchRoot,
      new PreparedReplayJournal(
        records(event(mismatchedFact)),
        join(mismatchRoot, 'ui-runtime-journal.jsonl'),
      ),
      async () => {
        mismatchReads += 1;
        throw new Error('mismatched fact must fail before reading the report');
      },
    );
    await assert.rejects(
      () => service.toolOutput(taskId, operationId, 1, 1),
      (error: unknown) => (
        error instanceof UiRuntimeApiError
        && error.code === 'tool-output.fact-integrity'
        && error.causeBody?.code === 'tool.execution-fact.integrity'
      ),
    );
    assert.equal(mismatchReads, 0);
  } finally {
    await rm(mismatchRoot, { recursive: true, force: true });
  }

  const legacyRoot = await mkdtemp(join(tmpdir(), 'humanagent-ui-fact-readback-legacy-'));
  try {
    const report = { status: 'succeeded', matches: [] };
    let legacyReads = 0;
    const service = await serviceForReadback(legacyRoot, event(undefined), async () => {
      legacyReads += 1;
      return report;
    });
    assert.deepEqual(await service.toolOutput(taskId, operationId, 1, 1), report);
    assert.equal(legacyReads, 1);
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gap B: the original failure must survive to the client.
// ---------------------------------------------------------------------------

/**
 * A real provider transport whose probe fails. The adapter itself is the real
 * producer of the reported error and of its `cause` chain: `callTransport`
 * wraps the transport failure and keeps it as the cause.
 */
function failingProbeTransport(failure: Error): ProviderTransport {
  return {
    probe: async () => {
      throw failure;
    },
    start: async () => {
      throw new Error('start must not be called by the health probe');
    },
    resume: async () => {
      throw new Error('resume must not be called by the health probe');
    },
    submit: async () => {
      throw new Error('submit must not be called by the health probe');
    },
    observe: () => {
      throw new Error('observe must not be called by the health probe');
    },
    requestStop: async () => {
      throw new Error('requestStop must not be called by the health probe');
    },
    settle: async () => {
      throw new Error('settle must not be called by the health probe');
    },
    close: async () => {
      throw new Error('close must not be called by the health probe');
    },
  };
}

test('organ health HTTP keeps the original transport failure behind the provider adapter error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-organ-health-cause-'));
  // Four real links. The adapter reports the first; the rest are the original
  // failure the human needs. Only the deepest link must stay unexposed.
  const deepest = new Error('level-4 deepest transport detail');
  const level3 = new Error('level-3 connect detail', { cause: deepest });
  const level2 = new Error('level-2 socket detail', { cause: level3 });
  const transportFailure = new Error('level-1 transport failure', { cause: level2 });
  const adapter = new ProviderAdapter({
    binding,
    routeRef: 'organ-health-cause-route',
    codec: new ResponsesProviderCodec(),
    transport: failingProbeTransport(transportFailure),
    evidence: filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets'))),
  });
  const runtimeJournal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = new UiRuntimeService({
    mode: 'rcc',
    organId,
    binding,
    port: adapter,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    journal: runtimeJournal,
    closurePort: runtimeJournal,
    memory: testMemory('project-ui-organ-health-cause'),
  });
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  const server = await startUiRuntimeServer({
    service,
    accessControl,
    productRoot: root,
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    port: 0,
  });
  testSessionByOrigin.set(new URL(server.url).origin, accessControl.sessionCookie(session).split(';')[0]!);
  try {
    const response = await fetch(`${server.url}/api/health/probe`, { method: 'POST' });
    assert.equal(response.status, 409);
    const body = await response.json() as {
      readonly error: {
        readonly code: string;
        readonly ownerId: string;
        readonly message: string;
        readonly nextAction: string;
        readonly evidenceRefs: readonly { readonly evidenceId: { readonly value: string } }[];
        readonly cause?: {
          readonly name: string;
          readonly message: string;
          readonly cause?: {
            readonly name: string;
            readonly message: string;
            readonly cause?: {
              readonly name: string;
              readonly message: string;
              readonly cause?: unknown;
            };
          };
        };
      };
    };
    // The typed contract is unchanged: the real adapter produced this failure.
    assert.equal(body.error.code, 'transport.failure');
    assert.equal(body.error.ownerId, 'humanagent.provider-adapter');
    assert.equal(body.error.message, 'level-1 transport failure');
    assert.match(body.error.nextAction, /recover:humanagent\.provider-adapter/);
    assert.equal(body.error.evidenceRefs.length, 1);

    // The original failure is retained instead of being dropped.
    const cause = body.error.cause;
    if (cause === undefined) throw new Error('the error body must keep the original failure the adapter reported');
    assert.equal(cause.name, 'Error');
    assert.equal(cause.message, 'level-1 transport failure');
    assert.equal(cause.cause?.message, 'level-2 socket detail');
    assert.equal(cause.cause?.cause?.message, 'level-3 connect detail');
    // Bounded: the fourth link is not exposed, and no stack or extra property
    // travels with the chain.
    assert.equal(cause.cause?.cause?.cause, undefined);
    assert.deepEqual(Object.keys(cause).sort(), ['cause', 'message', 'name']);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Gap A: the dashboard must state what the runtime really observed.
// ---------------------------------------------------------------------------

type DashboardView = ReturnType<UiRuntimeService['taskDashboard']>;

/** The dashboard's real liveness projection, or a failure when it is absent. */
function livenessOf(dashboard: DashboardView): RuntimeLivenessProjection {
  const liveness = (dashboard as { readonly liveness?: RuntimeLivenessProjection }).liveness;
  if (liveness === undefined) {
    throw new Error('the task dashboard must carry the liveness projection derived from real facts');
  }
  return liveness;
}

test('task dashboard states no-activity only past the declared silence budget and returns to working on real activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-liveness-dashboard-'));
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const port = new FirstOperationGatedReplayPort({ binding, stepDelayMs: 50 }, firstGate);
  let now = new Date('2026-10-06T12:00:00.000Z');
  const service = serviceFor(root, port, 'fake', 'ready', undefined, () => now);

  const task = service.createTask({ title: 'liveness target', directive: 'observe real activity' });
  await service.startExecution(task.taskId, { prompt: 'observe real activity' });
  await port.firstStarted;
  // The execution started and reported a real event, then the provider stream
  // stays silent: this is the stalled case, produced by a real gate.
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  const started = livenessOf(service.taskDashboard(task.taskId));
  assert.equal(started.state, 'working');
  assert.equal(started.silenceBudgetMs, DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs);
  // The activity instant is the newest real report, and its source names the
  // real signal that produced it. Nothing here is invented by the dashboard.
  assert.match(started.lastActivitySource ?? '', /^(provider\.request-identity|runtime\.event\.)/);
  const activityMs = Date.parse(started.lastActivityAt ?? '');
  assert.ok(Number.isFinite(activityMs), `the dashboard must report a real activity instant, got ${String(started.lastActivityAt)}`);
  assert.ok(
    (started.silentForMs ?? Number.NaN) < DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs,
    `a running execution with fresh activity must not be reported as stalled, got silentForMs=${String(started.silentForMs)}`,
  );

  // One millisecond below the declared budget the execution is still working.
  // The comparison matches the real watchdog, which fires at `>=` the budget.
  now = new Date(activityMs + DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs - 1);
  const belowBudget = livenessOf(service.taskDashboard(task.taskId));
  assert.equal(belowBudget.state, 'working');
  assert.equal(belowBudget.silentForMs, DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs - 1);

  // At the declared budget the silence is real, is measured, and is named.
  now = new Date(activityMs + DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs);
  const stalled = livenessOf(service.taskDashboard(task.taskId));
  assert.equal(stalled.state, 'no-activity');
  assert.equal(stalled.silentForMs, DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs);
  assert.equal(stalled.lastActivityAt, started.lastActivityAt);
  assert.equal(
    stalled.reason,
    `no real activity for ${DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs} ms; the declared silence budget is ${DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs} ms`,
  );

  // Real activity resumes, so the card returns to working instead of staying
  // stalled on a timer.
  releaseFirst();
  await waitFor(() => assert.equal(livenessOf(service.taskDashboard(task.taskId)).state, 'working'));
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  const settled = livenessOf(service.taskDashboard(task.taskId));
  assert.equal(settled.state, 'idle');
  assert.equal(settled.silentForMs, undefined);
});

test('task dashboard never claims working or no-activity for a task that has no real execution activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-liveness-no-activity-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:liveness-no-activity',
    rawInput: 'a requirement that is admitted but not dispatched',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'a requirement that is admitted but not dispatched',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create a queued requirement',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:liveness-no-activity',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-06T12:00:00.000Z',
    payloadRef: 'asset://requirements/liveness-no-activity',
  });

  const queued = queuedDraftRow(service.listTasks(), 'draft-1');
  const liveness = livenessOf(service.taskDashboard(queued.taskId));
  // Nothing is executing, so no activity claim is made at all.
  assert.equal(liveness.state, 'idle');
  assert.equal(liveness.lastActivityAt, undefined);
  assert.equal(liveness.silentForMs, undefined);
  assert.equal(liveness.silenceBudgetMs, DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs);
  assert.equal(liveness.state === 'working' || liveness.state === 'no-activity', false);
});

test('the runtime error body keeps the original failure instead of restating the reported message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-original-cause-'));
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
  const identity = () => ({
    leaseId: 'lease-1',
    generation: 7,
    pid: process.pid,
    processStartToken: 'test-process-start-token',
  });
  const uiRoot = join(process.cwd(), 'docs', 'ui');
  interface ErrorCauseBody {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly ownerId?: string;
  }
  interface ErrorBody {
    readonly code: string;
    readonly ownerId: string;
    readonly message: string;
    readonly nextAction: string;
    readonly cause?: ErrorCauseBody;
  }
  const serviceAt = async (name: string): Promise<UiRuntimeService> => {
    const serviceRoot = join(root, name);
    await mkdir(serviceRoot, { recursive: true });
    return serviceFor(serviceRoot, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  };

  // The serve owner reports a lifecycle failure two ways: with no original
  // failure at all, and wrapping the failure it actually hit. Both are the
  // shapes the production restart edge produces.
  const original = new Error('connect ECONNREFUSED 127.0.0.1:9');
  const restartCases: readonly { readonly name: string; readonly error: AppLifecycleError }[] = [
    {
      name: 'without an original failure',
      error: new AppLifecycleError(
        'daemon-restart.owner-not-ready',
        'serve owner has not completed startup',
        'wait for the original serve CLI to report ready and retry restart',
        'humanagent.app.serve',
      ),
    },
    {
      name: 'wrapping the real transport failure',
      error: new AppLifecycleError(
        'daemon-restart.request-failed',
        'could not reach the active serve owner: connect ECONNREFUSED 127.0.0.1:9',
        'confirm the original serve CLI is still running and retry restart there',
        'humanagent.app.serve',
        original,
      ),
    },
  ];
  const observedRestart: { readonly name: string; readonly status: number; readonly error: ErrorBody }[] = [];
  for (const [index, entry] of restartCases.entries()) {
    const server = await startUiRuntimeServer({
      service: await serviceAt(`restart-${index}`),
      accessControl,
      productRoot: root,
      uiRoot,
      port: 0,
      identity,
      restart: () => {
        throw entry.error;
      },
    });
    try {
      const response = await fetch(`${server.url}/api/runtime/restart`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessControl.supervisorToken('lease-1', 7)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ leaseId: 'lease-1', generation: 7 }),
      });
      const body = await response.json() as { readonly error: ErrorBody };
      observedRestart.push({ name: entry.name, status: response.status, error: body.error });
    } finally {
      await server.close();
    }
  }

  // The lifecycle failure is reported with its own code and message, and the
  // body must not also carry a `cause` that restates them: a cause field that
  // repeats the reported message is a field filled to look non-empty, not an
  // original failure.
  const noOriginal = observedRestart[0]!;
  assert.equal(noOriginal.status, 409);
  assert.equal(noOriginal.error.code, 'daemon-restart.owner-not-ready');
  assert.equal(
    Object.prototype.hasOwnProperty.call(noOriginal.error, 'cause'),
    false,
    `a lifecycle failure with no original failure must not report a cause: ${JSON.stringify(noOriginal.error)}`,
  );

  const wrapped = observedRestart[1]!;
  assert.equal(wrapped.status, 409);
  assert.equal(wrapped.error.code, 'daemon-restart.request-failed');
  const wrappedCause = wrapped.error.cause;
  if (wrappedCause === undefined) {
    throw new Error(`the wrapped original failure must be reported: ${JSON.stringify(wrapped.error)}`);
  }
  assert.equal(wrappedCause.name, 'Error');
  assert.equal(wrappedCause.message, 'connect ECONNREFUSED 127.0.0.1:9');
  assert.equal(wrappedCause.message === wrapped.error.message, false, `the cause must not restate the reported message: ${JSON.stringify(wrapped.error)}`);
  assert.deepEqual(Object.keys(wrappedCause).sort(), ['message', 'name']);

  // The identity port is a second real 409 producer: `cli.ts` ships exactly
  // this failure for the window before the serve owner has a lease. The route
  // is reachable only through that port, and in practice the listener accepts
  // requests after startup finishes, so this branch is defensive today. It
  // still must not invent a cause.
  const startupServer = await startUiRuntimeServer({
    service: await serviceAt('identity-not-ready'),
    accessControl,
    productRoot: root,
    uiRoot,
    port: 0,
    identity: () => {
      throw new AppLifecycleError(
        'daemon-identity.owner-not-ready',
        'serve owner has not completed startup',
        'wait for the original serve CLI to report ready and retry identity inspection',
        'humanagent.app.serve',
      );
    },
  });
  try {
    const response = await fetch(`${startupServer.url}/api/runtime/identity`, {
      headers: { authorization: `Bearer ${accessControl.supervisorToken('lease-1', 7)}` },
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { readonly error: ErrorBody };
    assert.equal(body.error.code, 'daemon-identity.owner-not-ready');
    assert.equal(
      Object.prototype.hasOwnProperty.call(body.error, 'cause'),
      false,
      `a startup lifecycle failure with no original failure must not report a cause: ${JSON.stringify(body.error)}`,
    );
  } finally {
    await startupServer.close();
  }

  // The generic branch is the one a route reaches with a failure that is not a
  // typed runtime error. It must behave the same way.
  const unexpectedCases: readonly { readonly name: string; readonly failure: Error }[] = [
    { name: 'without an original failure', failure: new Error('due-time patrol read failed') },
    {
      name: 'wrapping the real journal failure',
      failure: new Error('due-time patrol read failed', { cause: new Error('subscription journal unreadable') }),
    },
  ];
  const observedUnexpected: { readonly name: string; readonly status: number; readonly error: ErrorBody }[] = [];
  for (const [index, entry] of unexpectedCases.entries()) {
    const server = await startUiRuntimeServer({
      service: await serviceAt(`unexpected-${index}`),
      accessControl,
      productRoot: root,
      uiRoot,
      port: 0,
      schedulerStatus: async () => {
        throw entry.failure;
      },
    });
    testSessionByOrigin.set(new URL(server.url).origin, cookie);
    try {
      const response = await fetch(`${server.url}/api/runtime/scheduler`);
      const body = await response.json() as { readonly error: ErrorBody };
      observedUnexpected.push({ name: entry.name, status: response.status, error: body.error });
    } finally {
      await server.close();
    }
  }

  const unexpectedPlain = observedUnexpected[0]!;
  assert.equal(unexpectedPlain.status, 500);
  assert.equal(unexpectedPlain.error.code, 'ui-runtime.unexpected');
  assert.equal(
    Object.prototype.hasOwnProperty.call(unexpectedPlain.error, 'cause'),
    false,
    `an unexpected failure with no original failure must not report a cause: ${JSON.stringify(unexpectedPlain.error)}`,
  );

  const unexpectedWrapped = observedUnexpected[1]!;
  assert.equal(unexpectedWrapped.status, 500);
  const unexpectedCause = unexpectedWrapped.error.cause;
  if (unexpectedCause === undefined) {
    throw new Error(`the wrapped original failure must be reported: ${JSON.stringify(unexpectedWrapped.error)}`);
  }
  assert.equal(unexpectedCause.message, 'subscription journal unreadable');
  assert.equal(unexpectedCause.message === unexpectedWrapped.error.message, false, `the cause must not restate the reported message: ${JSON.stringify(unexpectedWrapped.error)}`);
});

// Failure mode: the App has no route for the already-committed settlement
// receipt. The failure probability is unknown because this is a new boundary.
// The impact is missing public recovery evidence; the cost is one existing App
// consumer using an injected read port.
test('explicit provider settlement control GET returns the exact committed receipt without changing the business interaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-provider-settlement-read-'));
  const auth = await testAccessControl(root);
  let receipt: InteractionProviderSettlementReceipt | undefined;
  let commit: JournalCommitRef | undefined;
  let observedRead: { readonly interactionId: string; readonly inputRevision: number; readonly turnId: string } | undefined;
  let readCalls = 0;
  const readPort: ExplicitProviderSettlementReadPort = {
    async read(input) {
      readCalls += 1;
      observedRead = structuredClone(input);
      if (receipt === undefined || commit === undefined) {
        throw new Error('the settlement fixture must exist before the control GET');
      }
      return { fact: structuredClone(receipt), commit: structuredClone(commit) };
    },
  };
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    undefined,
    undefined,
    unusedExplicitBrainInterpreter,
    readPort,
  );
  const server = await startUiRuntimeServer({
    service,
    accessControl: auth.accessControl,
    productRoot: root,
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    port: 0,
  });
  testSessionByOrigin.set(new URL(server.url).origin, auth.cookie);
  try {
    const inputResponse = await fetch(`${server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:provider-settlement-read',
        rawInput: 'read the original provider settlement',
        channel: 'business',
        inputRevision: 3,
      }),
    });
    assert.equal(inputResponse.status, 201);
    const { interactionId } = await inputResponse.json() as { readonly interactionId: string };
    const interactionPath = `${server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}`;
    const businessBefore = await (await fetch(interactionPath)).json() as unknown;
    const tasksBefore = service.listTasks();

    const operationId = id('operation', 'operation-ui-explicit-provider-settlement-read');
    const turn: InteractionTurnIdentity = {
      organId,
      interactionScopeId: 'interaction-scope-ui-provider-settlement-read',
      interactionId,
      inputRevision: 3,
      turnId: 'turn-ui-explicit-provider-settlement-read',
    };
    const settlementEvidence = evidence('ui-explicit-provider-settlement-read', { organId, operationId });
    const execution: InteractionParentProviderExecutionIdentityRef = {
      runtimeId: 'runtime-ui-explicit-provider-settlement-read',
      organId,
      operationId,
      executionEpoch: 2,
      interactionTurn: turn,
    };
    receipt = {
      interactionId,
      inputRevision: 3,
      request: {
        turnId: 'request-turn-ui-explicit-provider-settlement-read',
        requestId: 'request-ui-explicit-provider-settlement-read',
      },
      settlement: {
        ...execution,
        state: 'succeeded',
        evidenceRefs: [settlementEvidence],
        resourceRelease: { state: 'released', evidenceRefs: [settlementEvidence] },
        persistence: { state: 'committed', evidenceRefs: [settlementEvidence] },
      },
    };
    commit = {
      commitId: 'commit-ui-explicit-provider-settlement-read',
      journalSeq: 41,
      recordDigest: 'sha256:ui-explicit-provider-settlement-read',
    };
    validateInteractionProviderSettlementReceipt(receipt);

    const response = await fetch(
      `${interactionPath}/control/provider-settlement?inputRevision=3&turnId=${encodeURIComponent(turn.turnId)}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { fact: receipt, commit });
    assert.deepEqual(observedRead, {
      interactionId,
      inputRevision: 3,
      turnId: turn.turnId,
    });
    assert.equal(readCalls, 1);

    const businessAfter = await (await fetch(interactionPath)).json() as unknown;
    assert.deepEqual(businessAfter, businessBefore);
    assert.deepEqual(service.listTasks(), tasksBefore);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit provider settlement control GET reports unavailable without a composed read port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-provider-settlement-unavailable-'));
  const auth = await testAccessControl(root);
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
  );
  const server = await startUiRuntimeServer({
    service,
    accessControl: auth.accessControl,
    productRoot: root,
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    port: 0,
  });
  testSessionByOrigin.set(new URL(server.url).origin, auth.cookie);
  try {
    const response = await fetch(
      `${server.url}/api/explicit/interactions/interaction-without-read/control/provider-settlement?inputRevision=1&turnId=turn-without-read`,
    );
    assert.equal(response.status, 503);
    const body = await response.json() as { readonly error: { readonly code: string; readonly ownerId: string } };
    assert.equal(body.error.code, 'explicit-provider-settlement.unavailable');
    assert.equal(body.error.ownerId, 'humanagent.app');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('loopback API access adopts a local session without a pairing code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-loopback-'));
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
      backend: new DeterministicMemoryBackend(),
      projectKey: 'project-ui-loopback',
      roleId: 'execution',
    },
  });
  const origin = new URL(runtime.server.url).origin;
  try {
    // A browser on this machine has no cookie yet. Every request below uses
    // rawFetch, so nothing injects the harness session: this is the real
    // unpaired local browser that used to be sent to the pairing page.
    const sessionResponse = await rawFetch(`${origin}/api/auth/session`);
    assert.equal(sessionResponse.status, 200);
    const sessionBody = await sessionResponse.json() as {
      readonly authenticated: boolean;
      readonly localAccess?: boolean;
    };
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.localAccess, true);
    const adoptedCookie = (sessionResponse.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.ok(adoptedCookie.startsWith('HA_SESSION='), 'the adopted session is written as the browser cookie');

    const tasksResponse = await rawFetch(`${origin}/api/tasks`);
    assert.equal(tasksResponse.status, 200, 'a loopback request reads the public task list without pairing');
    const tasksBody = await tasksResponse.json() as { readonly tasks?: readonly unknown[] };
    assert.equal(tasksResponse.status, 200);
    assert.ok(tasksBody !== undefined && typeof tasksBody === 'object', 'the task list answers with a real body');

    const persisted = await rawFetch(`${origin}/api/tasks`, { headers: { cookie: adoptedCookie } });
    assert.equal(persisted.status, 200, 'the adopted cookie is a real session for the next request');
  } finally {
    await runtime.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('loopback classification accepts only the two local addresses', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.10'), false);
  assert.equal(isLoopbackAddress('192.168.1.10'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(undefined), false);
});
