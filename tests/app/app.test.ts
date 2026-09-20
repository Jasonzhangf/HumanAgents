import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureControlLayout, loadConfiguration, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { loadBuiltinPromptSegments } from '../../packages/agent-templates/src/index.js';
import { AppLifecycleError, assertDshSourceMatchesLock, checkpointEvidenceDigest, closeRuntime, composeAgentDriver, composeMemory, composeMemoryRuntime, composeRuntimeMemory, createJsonlCheckpointClosurePort, createJsonlCheckpointJournal, createJsonlEventJournal, createProjectSourceUpdateOwner, ensureDshSettings, entryCompositionInventory, FakeProviderAgentDriver, fakeExecutionBinding, memoryDriverFactory, openAgentOperation, openRuntime, probeExecutionRuntime, readRunManifest, resolveDshHome, resumeAgentOperation, resumeRuntime, runAgentOperation, serveCompositionComplete, serveCompositionManifestMatches, settleSessionOutcome, verifyDshPatches, type RuntimeExecutionBinding } from '../../packages/app/src/index.js';
import { id, type AgentClosure, type AgentDriver, type AgentEvent, type AgentInput, type AgentOutput, type AgentStartRequest, type EvidenceRef, type ExecutionRuntimePort, type ProviderBinding, type ProviderCloseResult, type ProviderEvent, type ProviderReadiness, type ProviderRecoveryResult, type ProviderSettlement, type ProviderStartReceipt, type ProviderStopReceipt, type ProviderSubmitResult } from '../../packages/contracts/src/index.js';
import { SessionStore } from '../../packages/app/src/session-store.js';
import { FakeAgentDriver } from '../../packages/adapters/testing/src/index.js';
import { DeterministicMemoryBackend, RootedMemoryPersistence } from '../../packages/adapters/memory/src/index.js';
import { JsonlOrganJournal, JournalCommitConflictError } from '../../packages/adapters/jsonl/src/index.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';
import { submitCheckpoint } from '../../packages/runtime/src/checkpoints/submission.js';
import { readCommittedCheckpoint } from '../../packages/app/src/checkpoint-journal.js';
import { createMemoryAnalysisRequestedEvent, memoryAnalysisRequestFromEvent } from '../../packages/runtime/src/memory/index.js';

const providerBinding: ProviderBinding = {
  bindingId: 'binding-integration',
  providerId: 'provider-integration',
  protocol: 'responses',
  endpointRef: 'endpoint-integration',
  modelRef: 'model-integration',
  configDigest: 'sha256:integration-config',
  capabilityDigest: 'sha256:integration-capability',
};

const readiness: ProviderReadiness = {
  bindingId: providerBinding.bindingId,
  providerId: providerBinding.providerId,
  protocol: providerBinding.protocol,
  state: 'ready',
  capabilityDigest: providerBinding.capabilityDigest,
  checkedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  evidenceRefs: [],
};

function executionPort(readinessResult: ProviderReadiness = readiness): ExecutionRuntimePort {
  const identity = { runtimeId: 'runtime-integration', taskId: { scope: 'task' as const, value: 'task-integration' }, operationId: { scope: 'operation' as const, value: 'operation-integration' }, executionEpoch: 1 };
  const evidenceRefs: readonly EvidenceRef[] = [];
  const port: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => readinessResult,
    capabilities: async () => ({ ...readinessResult, capabilities: ['integration'], version: 'test', digest: providerBinding.capabilityDigest }),
    start: async (): Promise<ProviderStartReceipt> => ({ ...identity, startedAt: '2026-01-01T00:00:00.000Z', evidenceRefs }),
    resume: async (): Promise<ProviderRecoveryResult> => ({ ...identity, checkpointId: { scope: 'checkpoint', value: 'checkpoint-integration' }, recovered: true, staleRejected: false, recoveryStateRef: { evidenceId: { scope: 'evidence', value: 'recovery' }, kind: 'execution', source: 'test', locator: 'recovery', scope: { organId: { scope: 'organ', value: 'organ-integration' }, taskId: identity.taskId, operationId: identity.operationId } }, evidenceRefs }),
    submit: async (): Promise<ProviderSubmitResult> => ({ ...identity, status: 'completed', outputRefs: ['output-integration'], evidenceRefs }),
    observe: async function* (): AsyncIterable<ProviderEvent> { yield { ...identity, eventId: 'event-integration', kind: 'terminal', terminalState: 'succeeded', evidenceRefs }; },
    requestStop: async (): Promise<ProviderStopReceipt> => ({ ...identity, status: 'accepted', receivedAt: '2026-01-01T00:00:00.000Z', evidenceRefs }),
    settle: async (): Promise<ProviderSettlement> => ({ ...identity, state: 'succeeded', evidenceRefs, resourceRelease: { state: 'released', evidenceRefs }, persistence: { state: 'committed', evidenceRefs } }),
    close: async (): Promise<ProviderCloseResult> => ({ bindingId: providerBinding.bindingId, providerId: providerBinding.providerId, protocol: providerBinding.protocol, state: 'closed', evidenceRefs }),
  };
  return port;
}

function runtimeBinding(port = executionPort()): RuntimeExecutionBinding {
  return { binding: { runtimeId: 'runtime-integration', provider: providerBinding }, port };
}

async function createConfiguredWorkspace(prefix: string): Promise<{ root: string; controlRoot: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  return { root, controlRoot, workspace };
}

async function writeProjectPatchArtifact(
  artifactsRoot: string,
  patchRef: string,
  target: 'project-agents' | 'project-local-skill',
  replacementContent: string,
  kind: 'project-fact' | 'project-experience' | 'local-skill-update' = target === 'project-local-skill' ? 'local-skill-update' : 'project-fact',
): Promise<string> {
  const bytes = JSON.stringify({
    schemaVersion: 1,
    kind,
    target,
    payload: { type: 'replacement', content: replacementContent },
    evidenceRefs: ['journal://project-a/evidence'],
  });
  await writeFile(join(artifactsRoot, patchRef), bytes, 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function memoryEntryContent(current: string, kind: 'project-fact' | 'project-experience' | 'local-skill-update'): string {
  const entry = `\n\n## Memory Agent ${kind}\n\n- Evidence: journal://project-a/evidence\n`;
  return current.endsWith('\n') ? `${current}${entry.slice(1)}` : `${current}${entry}`;
}

async function writeMemoryEntryPatchArtifact(
  artifactsRoot: string,
  patchRef: string,
  target: 'project-agents' | 'project-local-skill',
  kind: 'project-fact' | 'project-experience' | 'local-skill-update' = target === 'project-local-skill' ? 'local-skill-update' : 'project-fact',
): Promise<string> {
  const bytes = JSON.stringify({ schemaVersion: 1, kind, target, payload: { type: 'memory-entry' }, evidenceRefs: ['journal://project-a/evidence'] });
  await writeFile(join(artifactsRoot, patchRef), bytes, 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

test('runtime memory resolves declared local Skill and keeps undeclared source explicit', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-project-source-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await writeFile(join(workspace, 'AGENTS.md'), '# Project\n', 'utf8');
  const initialConfiguration = await loadConfiguration(paths);
  const unavailable = await composeRuntimeMemory({ paths, configuration: initialConfiguration });
  await assert.rejects(
    () => unavailable.sources.readProject({ projectKey: paths.projectKey, target: 'project-local-skill' }),
    (error: unknown) => (error as { code?: string; nextAction?: string }).code === 'memory-source-unavailable'
      && (error as { nextAction?: string }).nextAction === 'project.json#sources.localSkill',
  );
  const workspaceName = workspace.split('/').at(-1)!;
  await writeFile(join(workspace, 'SKILL.md'), '# Declared Skill\n', 'utf8');
  await writeFile(paths.projectManifest, JSON.stringify({
    schemaVersion: 1,
    projectKey: paths.projectKey,
    workspaceCwd: paths.workspaceCwd,
    sources: { localSkill: { root, name: workspaceName } },
  }), 'utf8');
  const configuration = await loadConfiguration(paths);
  const composed = await composeRuntimeMemory({ paths, configuration });
  const source = await composed.sources.readProject({ projectKey: paths.projectKey, target: 'project-local-skill' });
  assert.equal(source.content, '# Declared Skill\n');
});

test('runtime memory exposes the registered project interaction binding', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-runtime-memory-binding-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const configuration = await loadConfiguration(paths);
  const composed = await composeRuntimeMemory({ paths, configuration });
  const actor = {
    actorId: 'runtime-memory-actor',
    roleId: 'interaction' as const,
    permissions: ['memory.read', 'memory.propose'] as const,
    projectKey: paths.projectKey,
  };

  const view = await composed.interaction.query({
    actor,
    projectKey: paths.projectKey,
    namespace: 'project',
    query: 'missing',
    limit: 5,
  });
  assert.equal(view.entries.length, 0);

  const receipt = await composed.submissions.submitCandidate({
    submissionId: 'submission:runtime-memory-binding',
    requestId: 'request:runtime-memory-binding',
    operationId: id('operation', 'runtime-memory-binding'),
    bindingRef: composed.bindingRef,
    actor,
    projectKey: paths.projectKey,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef: 'content:runtime-memory-binding',
    contentDigest: 'sha256:runtime-memory-binding',
    evidenceRefs: ['source:runtime-memory-binding'],
    observation: 'default runtime memory binding submission',
    desiredScope: 'project',
    reason: 'regression coverage for composeRuntimeMemory',
    inputDigest: 'sha256:runtime-memory-binding-input',
  });
  assert.equal(receipt.status, 'accepted');
});

test('memory runtime publishes a committed checkpoint boundary and consumes it idempotently', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-runtime-boundary-');
  await writeFile(join(workspace, 'AGENTS.md'), '# Memory boundary\n', 'utf8');
  const runtime = await openRuntime({
    controlRoot,
    workspace,
    plan: 'default',
    sessionId: 'session-memory-runtime-boundary',
  });
  const { paths, configuration } = runtime;
  const mainAgentId = configuration.effective.project?.defaultAgent ?? configuration.agentRoster[0]!.agentId;
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# Memory audit\n', 'utf8');
  const compose = () => composeMemoryRuntime({
      paths,
      configuration,
      workspaceCwd: paths.workspaceCwd,
      sessionsRoot: paths.sessionsRoot,
      runNotesRoot: paths.runNotesRoot,
      auditPromptRoot,
      auditPromptRef: 'project-memory-audit',
      autoUpdate: false,
      binding: {
        bindingRef: 'memory-runtime-boundary',
        projectKey: paths.projectKey,
        executionEpoch: 1,
        scope: {
          namespace: 'project',
          projectKey: paths.projectKey,
          organId: id('organ', `agent-${mainAgentId}`),
          taskId: id('task', 'session-memory-runtime-boundary'),
        },
        taskId: id('task', 'session-memory-runtime-boundary'),
        mainAgentId,
        actor: {
          actorId: 'memory-runtime-boundary',
          roleId: 'memory',
          permissions: ['memory.read', 'memory.propose'],
          projectKey: paths.projectKey,
        },
      },
    });
  const memory = await compose();

  try {
    await new SessionStore(paths).append(
      'session-memory-runtime-boundary',
      { type: 'session.state', state: 'running' },
      runtime.lock,
    );
    const result = await runAgentOperation({
      paths,
      configuration,
      workspace,
      sessionId: 'session-memory-runtime-boundary',
      plan: 'default',
      prompt: 'publish a memory boundary',
      memoryBoundaryPublisher: memory.publisher,
    });
    const first = await memory.consume();
    assert.equal(first.committed.length, 1);
    assert.equal(first.committed[0]?.disposition, 'applied');
    const second = await memory.consume();
    assert.equal(second.committed.length, 0);

    const event = (await memory.journal.readEvents({
      streamId: `memory-boundaries:${result.taskId.value}`,
      afterSequence: 0,
      limit: 10,
    }))[0]!;
    const evidenceDigest = checkpointEvidenceDigest(result.checkpoint);
    const followUp = {
      requestId: 'follow-up-memory-runtime-boundary',
      operationId: id('operation', 'follow-up-memory-runtime-boundary'),
      correlationId: 'correlation-memory-runtime-boundary',
      inReplyTo: `memory-analysis-${createHash('sha256')
        .update(`${event.streamId.length}:${event.streamId}${event.messageId.length}:${event.messageId}`)
        .digest('hex')}`,
      bindingRef: 'memory-runtime-boundary',
      actor: {
        actorId: 'memory-runtime-boundary',
        roleId: 'memory' as const,
        permissions: ['memory.read', 'memory.propose'] as const,
        projectKey: paths.projectKey,
      },
      projectKey: paths.projectKey,
      namespace: 'project' as const,
      taskId: result.taskId,
      evidenceRefs: ['humanagent://checkpoint/' + result.checkpoint.id.value],
      evidenceDigests: [evidenceDigest],
      sourceRefs: ['humanagent://checkpoint/' + result.checkpoint.id.value],
      inputDigest: evidenceDigest,
    };
    assert.equal((await memory.composition.agent.followUp(followUp)).status, 'ready');
    const restarted = await compose();
    assert.equal((await restarted.composition.agent.followUp(followUp)).status, 'ready');
    assert.equal((await restarted.consume()).committed.length, 0);
    assert.equal((await restarted.journal.readCursor({
      streamId: `memory-boundaries:${result.taskId.value}`,
      consumerKey: 'memory-runtime-boundary',
    }))?.lastHandledSequence, 1);
    await settleSessionOutcome(runtime, result.checkpoint.outcome, result.checkpoint.id.value);
  } finally {
    try {
      await runtime.lock.release();
    } catch {
      // The successful settlement path already releases the session lock.
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('committed checkpoint memory boundary emits a typed patch only for auto update', async () => {
  const runCase = async (autoUpdate: boolean) => {
    const { root, controlRoot, workspace } = await createConfiguredWorkspace(`humanagent-app-memory-boundary-auto-${autoUpdate ? 'on' : 'off'}-`);
    await writeFile(join(workspace, 'AGENTS.md'), '# Project\n', 'utf8');
    const paths = await resolveRuntimePaths({ controlRoot, workspace });
    const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
    await mkdir(auditPromptRoot, { recursive: true });
    await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# Memory audit\n', 'utf8');
    const runtime = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId: `memory-boundary-auto-${autoUpdate ? 'on' : 'off'}` });
    const { configuration } = runtime;
    const mainAgentId = configuration.effective.project?.defaultAgent ?? configuration.agentRoster[0]!.agentId;
    const sessionId = `memory-boundary-auto-${autoUpdate ? 'on' : 'off'}`;
    const taskId = id('task', sessionId);
    const memory = await composeMemoryRuntime({
      paths,
      configuration,
      workspaceCwd: paths.workspaceCwd,
      sessionsRoot: paths.sessionsRoot,
      runNotesRoot: paths.runNotesRoot,
      auditPromptRoot,
      auditPromptRef: 'project-memory-audit',
      autoUpdate,
      binding: {
        bindingRef: `memory-boundary-auto-${autoUpdate ? 'on' : 'off'}`,
        projectKey: paths.projectKey,
        executionEpoch: 1,
        scope: {
          namespace: 'project',
          projectKey: paths.projectKey,
          organId: id('organ', `agent-${mainAgentId}`),
          taskId,
        },
        taskId,
        mainAgentId,
        actor: {
          actorId: 'memory-agent',
          roleId: 'memory',
          permissions: ['memory.read', 'memory.propose'],
          projectKey: paths.projectKey,
        },
      },
    });
    try {
      await new SessionStore(paths).append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
      const result = await runAgentOperation({
        paths,
        configuration,
        workspace,
        sessionId,
        plan: 'default',
        prompt: 'record a project memory boundary',
      });
      const committed = await readCommittedCheckpoint({
        filePath: join(paths.journalRoot, 'checkpoints.jsonl'),
        scope: result.checkpoint.scope,
        checkpointId: result.checkpoint.id,
      });
      await memory.boundaryPublisher.publish({
        checkpoint: committed.checkpoint,
        recordDigest: committed.recordDigest,
        trigger: 'completion',
      });
      const consumed = await memory.consume();
      assert.equal(consumed.committed.length, 1);
      assert.equal(consumed.committed[0]?.disposition, 'applied');
      const boundaryEvents = await memory.journal.readEvents({
        streamId: `memory-boundaries:${result.taskId.value}`,
        afterSequence: 0,
        limit: 10,
      });
      const patch = (boundaryEvents[0]?.payload as { readonly projectPatch?: { readonly patchRef: string; readonly patchDigest: string } } | undefined)?.projectPatch;
      assert.equal(patch !== undefined, autoUpdate);
      const source = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
      const artifacts = await readdir(paths.artifactsRoot);
      assert.equal(source.includes('Memory Agent project-experience'), autoUpdate);
      assert.equal(artifacts.some((name) => name.startsWith('memory-project-patch-')), autoUpdate);
      await settleSessionOutcome(runtime, result.checkpoint.outcome, result.checkpoint.id.value);
      return { source, artifacts };
    } finally {
      try {
        await runtime.lock.release();
      } catch {
        // The successful settlement path already releases the session lock.
      }
      await rm(root, { recursive: true, force: true });
    }
  };

  const proposalOnly = await runCase(false);
  assert.equal(proposalOnly.source, '# Project\n');
  assert.equal(proposalOnly.artifacts.some((name) => name.startsWith('memory-project-patch-')), false);
  const applied = await runCase(true);
  assert.match(applied.source, /Memory Agent project-experience/);
  assert.equal(applied.artifacts.filter((name) => name.startsWith('memory-project-patch-')).length, 1);
});

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (last instanceof Error) throw last;
  await assertion();
}

async function composeMemoryFixture(input: {
  readonly paths: Awaited<ReturnType<typeof resolveRuntimePaths>>;
  readonly workspace: string;
  readonly projectKey?: string;
  readonly bindingProjectKey?: string;
  readonly evidenceSource?: {
    read(input: {
      readonly projectKey: string;
      readonly scope: { readonly kind: 'task' | 'organ' | 'approved-global'; readonly organId: ReturnType<typeof id<'organ'>>; readonly taskId?: ReturnType<typeof id<'task'>> };
      readonly evidence: EvidenceRef;
    }): Promise<{ readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }>;
  };
  readonly assignmentId?: string;
  readonly agentRuntimeId?: string;
  readonly roleId?: string;
  readonly interactionScopeId?: string;
}) {
  const organId = id('organ', 'memory-composition-organ');
  const taskId = id('task', 'memory-composition-task');
  const scope = { organId: organId, taskId };
  const memoryScope = {
    namespace: 'project' as const,
    projectKey: input.bindingProjectKey ?? input.paths.projectKey,
    organId,
    taskId,
  };
  const actor = {
    actorId: 'memory-composition-actor',
    roleId: 'memory' as const,
    permissions: ['memory.read', 'memory.propose'] as const,
    projectKey: input.paths.projectKey,
  };
  const binding = {
    bindingRef: 'memory-binding:composition',
    projectKey: input.bindingProjectKey ?? input.paths.projectKey,
    executionEpoch: 1,
    scope: memoryScope,
    taskId,
    ...(input.interactionScopeId === undefined ? {} : { interactionScopeId: input.interactionScopeId }),
    mainAgentId: 'main-agent-a',
    actor,
  };
  const auditPromptRoot = join(input.paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'audit.md'), '# Memory audit\n', 'utf8');
  const composed = await composeMemory({
    paths: input.paths,
    projectKey: input.projectKey ?? input.paths.projectKey,
    workspaceCwd: input.workspace,
    sessionsRoot: input.paths.sessionsRoot,
    runNotesRoot: input.paths.runNotesRoot,
    localSkillRoot: input.workspace,
    localSkillName: 'project-memory',
    auditPromptRoot,
    auditPromptRef: 'audit',
    autoUpdate: false,
    binding,
    ...(input.assignmentId === undefined ? {} : { assignmentId: input.assignmentId }),
    ...(input.agentRuntimeId === undefined ? {} : { agentRuntimeId: input.agentRuntimeId }),
    ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
    ...(input.evidenceSource === undefined ? {} : { evidenceSource: input.evidenceSource }),
  });
  return { composed, binding, scope, taskId, organId };
}

class CrashSubmitDriver extends FakeAgentDriver {
  async submit(): Promise<never> {
    throw new Error('DSH runtime exited before settle');
  }
}

class CrashStartDriver extends FakeAgentDriver {
  async start(): Promise<never> {
    throw new Error('DSH runtime failed during start');
  }
}

class PlainAgentEventDriver extends FakeAgentDriver {
  private taskId?: AgentEvent['taskId'];

  override async start(input: AgentStartRequest) {
    this.taskId = input.taskId;
    return await super.start(input);
  }

  override async *observe(input: { readonly runtimeId: string }): AsyncIterable<AgentEvent> {
    const taskId = this.taskId!;
    const scope = { organId: id('organ', 'agent-execution-fake'), taskId };
    yield { taskId, executionEpoch: 1, kind: 'model', summary: 'DSH model event', evidenceRefs: [] };
    yield {
      taskId,
      executionEpoch: 1,
      kind: 'output',
      summary: 'DSH output event',
      evidenceRefs: [{
        evidenceId: id('evidence', `${input.runtimeId}-output`),
        kind: 'operation',
        source: 'test-dsh-shaped',
        locator: 'dsh://output',
        scope,
      }],
    };
    yield {
      taskId,
      executionEpoch: 1,
      kind: 'tool',
      summary: 'DSH tool event',
      evidenceRefs: [{
        evidenceId: id('evidence', `${input.runtimeId}-tool`),
        kind: 'tool',
        source: 'test-dsh-shaped',
        locator: 'dsh://tool',
        scope,
      }],
    };
    yield { taskId, executionEpoch: 1, kind: 'error', summary: 'DSH provider error', evidenceRefs: [] };
    yield { taskId, executionEpoch: 1, kind: 'terminal', terminalState: 'succeeded', summary: 'DSH terminal event', evidenceRefs: [] };
  }
}

class CountingCrashSubmitDriver extends CrashSubmitDriver {
  settleCalls = 0;

  override async settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure> {
    this.settleCalls += 1;
    return await super.settle(input);
  }
}

class RejectPromptDriver extends FakeAgentDriver {
  override async submit(input: AgentInput): Promise<AgentOutput> {
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: { status: 'failed' },
      outputRefs: [],
      evidenceRefs: [{
        evidenceId: id('evidence', `prompt-rejected-${input.assignmentId}`),
        kind: 'operation',
        source: 'test-reject-prompt',
        locator: `dsh://session/${input.assignmentId}/prompt-rejected`,
        scope: { organId: id('organ', 'agent-execution-fake'), taskId: input.taskId },
      }],
    };
  }
}

class PromptCaptureDriver extends FakeAgentDriver {
  lastPrompt = '';

  override async submit(input: AgentInput): Promise<AgentOutput> {
    this.lastPrompt = String(input.payload.prompt ?? '');
    return super.submit(input);
  }
}

class ObserveErrorCloseDriver extends FakeAgentDriver {
  closeCalls = 0;

  constructor(private readonly closeFails: boolean) { super(); }

  override async *observe(_input: { readonly runtimeId: string }): AsyncIterable<AgentEvent> {
    throw new Error('provider observe failed');
  }

  async close(): Promise<ProviderCloseResult> {
    this.closeCalls += 1;
    if (this.closeFails) throw new Error('provider close transport failed');
    return {
      bindingId: providerBinding.bindingId,
      providerId: providerBinding.providerId,
      protocol: providerBinding.protocol,
      state: 'closed',
      evidenceRefs: [],
    };
  }
}

class StopCloseDriver extends FakeAgentDriver {
  closeCalls = 0;

  constructor(private readonly closeFails: boolean, outcomes: Readonly<Record<string, 'succeeded' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'stopped'>>) { super(outcomes); }

  async close(): Promise<ProviderCloseResult> {
    this.closeCalls += 1;
    if (this.closeFails) throw new Error('provider stop close failed');
    return {
      bindingId: providerBinding.bindingId,
      providerId: providerBinding.providerId,
      protocol: providerBinding.protocol,
      state: 'closed',
      evidenceRefs: [],
    };
  }
}

class MemoryAnalysisDriver implements AgentDriver {
  readonly kind = 'memory-analysis-composition-test';
  readonly events: string[] = [];
  private readonly submissions = new Map<string, AgentInput>();

  async capabilities() {
    return {
      driverKind: this.kind,
      capabilities: ['analysis'],
      version: '1',
    };
  }

  async start(input: import('../../packages/contracts/src/index.js').AgentStartRequest) {
    this.events.push(`start:${input.assignmentId}`);
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async resume(): Promise<never> {
    throw new Error('unused');
  }

  async submit(input: AgentInput): Promise<AgentOutput> {
    this.events.push(`submit:${input.assignmentId}`);
    this.submissions.set(input.assignmentId, structuredClone(input));
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: { status: 'accepted' },
      outputRefs: [],
      evidenceRefs: [],
    };
  }

  async *observe(input: { readonly runtimeId: string }): AsyncIterable<AgentEvent> {
    const submission = this.submissions.get(input.runtimeId);
    if (!submission) throw new Error('unknown memory analysis runtime');
    this.events.push(`observe:${input.runtimeId}`);
    const payload = submission.payload as unknown as {
      readonly operationId: string;
      readonly prompt: unknown;
      readonly sourceRefs: readonly string[];
    };
    const curation = {
      operationId: { scope: 'operation', value: payload.operationId },
      auditPrompt: payload.prompt,
      sourceRefs: payload.sourceRefs,
      outcome: 'candidate',
      candidateId: 'composition-memory-candidate',
      matchedMemoryIds: [],
      conflictRefs: [],
      explanation: 'composition memory analysis',
      nextAction: 'review',
    };
    yield {
      taskId: submission.taskId,
      executionEpoch: submission.executionEpoch,
      kind: 'provider.output',
      evidenceRefs: [],
      summary: JSON.stringify(curation),
    };
    yield {
      taskId: submission.taskId,
      executionEpoch: submission.executionEpoch,
      kind: 'provider.terminal',
      evidenceRefs: [],
      terminalState: 'succeeded' as const,
    };
  }

  async requestStop() {
    return { requested: true, operationId: id('operation', 'memory-stop') };
  }

  async settle(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    this.events.push(`settle:${input.runtimeId}`);
    return { state: 'succeeded' as const, evidenceRefs: [] };
  }
}

test('HumanAgent operation identity is stable across driver and provider bindings', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stable-identity-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const agent = {
    agentId: 'execution-stable',
    roleId: 'execution' as const,
    templateRef: 'builtin/execution@1.0.0',
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
    memoryScopes: ['task'] as const,
    resourceClass: 'foreground',
  };
  const fake = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stable-fake',
    plan: 'default',
    prompt: 'inspect the configuration',
    agent: { ...agent, driverRef: 'fake' },
    composed: { driver: new FakeAgentDriver() },
  });
  const dsh = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stable-dsh',
    plan: 'default',
    prompt: 'inspect the configuration',
    agent: { ...agent, driverRef: 'dsh' },
    composed: { driver: new FakeAgentDriver() },
  });
  assert.deepEqual(fake.snapshot().scope.organId, dsh.snapshot().scope.organId);
  assert.equal(fake.snapshot().scope.organId.value, 'agent-execution-stable');

  const source = await readFile(join(process.cwd(), 'packages/app/src/agent-operation.ts'), 'utf8');
  assert.equal(/adapters[\\/]dsh|dshExecutionOrganId|dshOperationIdFor/.test(source), false);
});

test('agent operation assembles external builtin prompt segments before driver submission', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-prompt-assets-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const configuration = await loadConfiguration(paths);
  const prompts = await loadBuiltinPromptSegments(
    'execution',
    join(process.cwd(), 'packages', 'agent-templates', 'templates'),
  );
  const configured = { ...configuration, promptCatalog: { execution: prompts } };
  const driver = new PromptCaptureDriver();
  const operation = await openAgentOperation({
    paths,
    configuration: configured,
    workspace,
    sessionId: 'session-prompt-assets',
    plan: 'default',
    prompt: 'inspect the configuration',
    agent: {
      agentId: 'execution-prompt-assets',
      roleId: 'execution',
      templateRef: 'builtin/execution@1.0.0',
      driverRef: 'fake',
      skills: ['single-capability-worker'],
      tools: ['search'],
      permissions: ['task.read', 'workspace.read'],
      memoryScopes: ['task'],
      resourceClass: 'foreground',
    },
    composed: { driver },
  });
  await operation.start();
  await operation.submit();
  await operation.complete();
  assert.match(driver.lastPrompt, /# Execution Agent/);
  assert.match(driver.lastPrompt, /# Task input/);
  assert.match(driver.lastPrompt, /inspect the configuration/);
});

test('CLI config failures preserve structured owner and next action evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-cli-error-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await writeFile(join(controlRoot, 'config.toml'), 'misspelled = true\n', 'utf8');
  assert.throws(() => execFileSync(process.execPath, [join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'), 'doctor', '--workspace', workspace, '--control-root', controlRoot], { encoding: 'utf8', stdio: 'pipe' }), (error: any) => {
    const parsed = JSON.parse(error.stderr);
    assert.equal(parsed.error.code, 'config-invalid');
    assert.equal(parsed.error.ownerId, 'config-loader');
    assert.equal(typeof parsed.error.nextAction, 'string');
    return true;
  });
});

test('CLI accepts memory auto update configuration before composing memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-cli-memory-auto-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await appendFile(join(controlRoot, 'config.toml'), '\n[memory.update]\nauto = true\n', 'utf8');
  const output = execFileSync(process.execPath, [
    join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'),
    'doctor',
    '--workspace',
    workspace,
    '--control-root',
    controlRoot,
  ], { encoding: 'utf8', stdio: 'pipe' });
  const parsed = JSON.parse(output);
  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.projectKey, paths.projectKey);
});

test('CLI host failures remain structured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-cli-host-error-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  assert.throws(() => execFileSync(process.execPath, [join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'), 'unknown', '--workspace', workspace], { encoding: 'utf8', stdio: 'pipe' }), (error: any) => {
    const parsed = JSON.parse(error.stderr);
    assert.equal(parsed.error.code, 'host-error');
    assert.equal(parsed.error.ownerId, 'host');
    assert.equal(typeof parsed.error.nextAction, 'string');
    return true;
  });
});

test('CLI entry rejects implicit fake mode and uses one typed invalid-prompt error', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-entry-errors-');
  const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
  assert.throws(() => execFileSync(process.execPath, [
    cli,
    'run',
    '--plan',
    'default',
    '--prompt',
    '',
    '--session',
    'entry-invalid-prompt',
    '--workspace',
    workspace,
    '--control-root',
    controlRoot,
  ], { encoding: 'utf8', stdio: 'pipe' }), (error: any) => {
    const parsed = JSON.parse(error.stderr);
    assert.deepEqual(parsed.error, {
      code: 'execution.input.required',
      ownerId: 'humanagent.app',
      nextAction: 'provide a non-empty prompt',
      message: 'request field prompt is required',
    });
    return true;
  });
  assert.throws(() => execFileSync(process.execPath, [
    cli,
    'serve',
    '--workspace',
    workspace,
    '--control-root',
    controlRoot,
    '--port',
    '0',
  ], { encoding: 'utf8', stdio: 'pipe' }), (error: any) => {
    const parsed = JSON.parse(error.stderr);
    assert.equal(parsed.error.code, 'execution.mode.required');
    assert.equal(parsed.error.ownerId, 'humanagent.app');
    return true;
  });
});

test('CLI serve composes rooted memory and keeps it across process restart', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-cli-memory-root-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
  const sourceRef = 'journal://cli-memory/restart-proof';
  const sourceDigest = 'sha256:cli-memory-restart-proof';

  const serve = async (): Promise<{
    readonly process: {
      readonly stdout: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown };
      readonly once: {
        (event: 'error', listener: (error: Error) => void): unknown;
        (event: 'exit', listener: (code: number | null) => void): unknown;
      };
      readonly exitCode: number | null;
      kill(signal?: string): boolean;
    };
    readonly stderrText: () => string;
    readonly url: string;
    readonly memoryRoot: string;
  }> => {
    const child = spawn(process.execPath, [
      cli,
      'serve',
      '--workspace',
      workspace,
      '--control-root',
      controlRoot,
      '--mode',
      'fake',
      '--port',
      '0',
    ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Uint8Array) => {
      stderr += String(chunk);
    });
    const launched = await new Promise<{ readonly url: string; readonly memoryRoot: string }>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`serve startup timed out: ${output}`)), 5_000);
      child.stdout.on('data', (chunk: Uint8Array) => {
        output += String(chunk);
        try {
          const parsed = JSON.parse(output.trim()) as { readonly url?: string; readonly memoryRoot?: string };
          if (parsed.url && parsed.memoryRoot) {
            clearTimeout(timeout);
            resolve({ url: parsed.url, memoryRoot: parsed.memoryRoot });
          }
        } catch {
          // The CLI may print partial JSON while the process is starting.
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`serve exited before startup (${String(code)}): stdout=${output}; stderr=${stderr}`));
      });
    });
    return { process: child, stderrText: () => stderr, ...launched };
  };

  const stop = async (runtime: Awaited<ReturnType<typeof serve>>): Promise<void> => {
    runtime.process.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (runtime.process.exitCode !== null) {
        resolve();
        return;
      }
      runtime.process.once('exit', () => resolve());
    });
  };

  const readMemoryContext = async (
    runtime: Awaited<ReturnType<typeof serve>>,
    taskId: string,
    operationId: string,
  ): Promise<{
    readonly bindingId?: string;
    readonly executionEpoch?: number;
    readonly entries?: readonly { readonly sourceRef: string }[];
  }> => {
    let context: {
      readonly bindingId?: string;
      readonly executionEpoch?: number;
      readonly entries?: readonly { readonly sourceRef: string }[];
    } | undefined;
    await waitFor(async () => {
      const receipt = await fetch(`${runtime.url}/api/executions/${encodeURIComponent(operationId)}/memory-context`);
      if (receipt.status !== 200) {
        const task = await fetch(`${runtime.url}/api/tasks/${encodeURIComponent(taskId)}`);
        const events = await fetch(`${runtime.url}/api/executions/${encodeURIComponent(operationId)}/events`);
        throw new Error(`memory context ${receipt.status}: ${await task.text()}; events=${await events.text()}; stderr=${runtime.stderrText()}`);
      }
      context = await receipt.json() as typeof context;
    });
    assert.ok(context);
    return context as NonNullable<typeof context>;
  };

  const first = await serve();
  let taskId: string;
  try {
    const duplicate = spawn(process.execPath, [
      cli,
      'serve',
      '--workspace',
      workspace,
      '--control-root',
      controlRoot,
      '--mode',
      'fake',
      '--port',
      '0',
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let duplicateStderr = '';
    duplicate.stderr.on('data', (chunk: Uint8Array) => { duplicateStderr += String(chunk); });
    const duplicateExit = await new Promise<number | null>((resolve, reject) => {
      duplicate.once('error', reject);
      duplicate.once('exit', resolve);
    });
    assert.equal(duplicateExit, 1);
    const duplicateFailure = JSON.parse(duplicateStderr.trim()) as { readonly error?: { readonly code?: string; readonly ownerId?: string } };
    assert.equal(duplicateFailure.error?.code, 'daemon-lease-owned');
    assert.equal(duplicateFailure.error?.ownerId, 'humanagent.app.serve');

    const created = await fetch(`${first.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'rooted memory before restart' }),
    });
    assert.equal(created.status, 201);
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    taskId = task.taskId.value;
  } finally {
    await stop(first);
  }

  const rooted = await DeterministicMemoryBackend.fromPersistence(new RootedMemoryPersistence({
    project: join(paths.memoryRoot, 'project'),
    global: paths.globalMemoryRoot,
  }));
  await rooted.addContextEntry({
    scope: { kind: 'task', organId: id('organ', 'humanagent-ui'), taskId: id('task', taskId) },
    sourceRef,
    sourceDigest,
    text: 'rooted memory available after CLI restart',
    layer: 'current',
    summary: 'rooted memory available after CLI restart',
  });

  const second = await serve();
  try {
    assert.equal(second.memoryRoot, first.memoryRoot);
    const started = await fetch(`${second.url}/api/tasks/${encodeURIComponent(taskId)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'read rooted memory after restart' }),
    });
    assert.equal(started.status, 202);
    const operation = await started.json() as { readonly operationId: string; readonly executionEpoch: number };
    const context = await readMemoryContext(second, taskId, operation.operationId);
    assert.equal(context.bindingId, `memory-binding:${taskId}`);
    assert.equal(context.executionEpoch, operation.executionEpoch);
    assert.equal(context.entries?.some((entry) => entry.sourceRef === sourceRef), true);
  } finally {
    await stop(second);
  }

  const third = await serve();
  try {
    const started = await fetch(`${third.url}/api/tasks/${encodeURIComponent(taskId)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'read rooted memory after another restart' }),
    });
    assert.equal(started.status, 202);
    const operation = await started.json() as { readonly operationId: string; readonly executionEpoch: number };
    const context = await readMemoryContext(third, taskId, operation.operationId);
    assert.equal(context.bindingId, `memory-binding:${taskId}`);
    assert.equal(context.executionEpoch, operation.executionEpoch);
    assert.equal(context.entries?.some((entry) => entry.sourceRef === sourceRef), true);
  } finally {
    await stop(third);
  }
});

test('CLI serve launch reports the live Cordis plugin composition', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-cli-cordis-composition-');
  const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
  const child = spawn(process.execPath, [
    cli,
    'serve',
    '--workspace',
    workspace,
    '--control-root',
    controlRoot,
    '--mode',
    'fake',
    '--port',
    '0',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
  try {
    const launch = await new Promise<{
      readonly plugins: readonly string[];
      readonly composition: {
        readonly complete: boolean;
        readonly components: readonly { readonly component: string; readonly state: string }[];
      };
    }>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`serve startup timed out: ${output}; stderr=${stderr}`)), 5_000);
      child.stdout.on('data', (chunk: Uint8Array) => {
        output += String(chunk);
        try {
          const parsed = JSON.parse(output.trim()) as {
            readonly plugins?: readonly string[];
            readonly composition?: {
              readonly complete: boolean;
              readonly components: readonly { readonly component: string; readonly state: string }[];
            };
          };
          if (parsed.plugins && parsed.composition) {
            clearTimeout(timeout);
            resolve({ plugins: parsed.plugins, composition: parsed.composition });
          }
        } catch {
          // The CLI may print partial JSON while the process is starting.
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`serve exited before startup (${String(code)}): ${output}; stderr=${stderr}`));
      });
    });

    assert.deepEqual(launch.plugins, [
      'humanagent.harness-kernel',
      'humanagent.agent-templates',
      'humanagent.fake-provider',
      'humanagent.memory',
      'humanagent.ui',
    ]);
    assert.equal(launch.composition.complete, true);
    for (const component of ['cordis-host', 'fixed-harness-kernel', 'fake-plugin', 'template-plugin', 'memory-plugin', 'ui-plugin']) {
      assert.equal(launch.composition.components.find((candidate) => candidate.component === component)?.state, 'composed');
    }
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }
});

test('CLI serve prepares the configured builtin memory audit prompt before checkpoint boundary analysis', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-cli-memory-audit-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await writeFile(join(workspace, 'AGENTS.md'), '# Gate 25 project\n', 'utf8');
  const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
  const child = spawn(process.execPath, [
    cli,
    'serve',
    '--workspace',
    workspace,
    '--control-root',
    controlRoot,
    '--mode',
    'fake',
    '--port',
    '0',
  ], {
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'HUMANAGENT_TEMPLATE_ROOT')),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
  const launched = await new Promise<{ readonly url: string }>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`serve startup timed out: ${output}; stderr=${stderr}`)), 5_000);
    child.stdout.on('data', (chunk: Uint8Array) => {
      output += String(chunk);
      try {
        const parsed = JSON.parse(output.trim()) as { readonly url?: string };
        if (!parsed.url) return;
        clearTimeout(timeout);
        resolve({ url: parsed.url });
      } catch {
        // The CLI may print partial JSON while the process is starting.
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`serve exited before startup (${String(code)}): ${output}; stderr=${stderr}`));
    });
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  };
  try {
    const created = await fetch(`${launched.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Gate 25 memory closure', directive: 'prove builtin audit prompt preparation' }),
    });
    assert.equal(created.status, 201);
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    const started = await fetch(`${launched.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'close the memory boundary' }),
    });
    assert.equal(started.status, 202);
    const operation = await started.json() as { readonly operationId: string };
    await waitFor(async () => {
      const detail = await fetch(`${launched.url}/api/tasks/${encodeURIComponent(task.taskId.value)}`);
      const body = await detail.json() as { readonly state?: string };
      assert.equal(body.state, 'ready');
    }, 5_000);
    const journalPath = join(paths.journalRoot, 'events.jsonl');
    await waitFor(async () => {
      const journal = await readFile(journalPath, 'utf8');
      assert.match(journal, /"kind":"memory.analysis.requested"/);
      assert.match(journal, /"type":"external-operation"[^\n]*"state":"settled"/);
      assert.match(journal, /"type":"memory-agent-state"/);
      assert.match(journal, /"disposition":"applied"/);
      assert.equal(/memory-agent-prompt-unavailable/.test(journal), false);
      assert.equal(/"type":"retry"/.test(journal), false);
    }, 5_000);
    const promptPath = join(controlRoot, 'memory-audit', 'project-memory-audit.md');
    const prompt = await readFile(promptPath, 'utf8');
    const builtinPrompt = await readFile(
      join(process.cwd(), 'packages', 'agent-templates', 'templates', 'builtin', 'memory', 'audit', 'project-memory-audit.md'),
      'utf8',
    );
    assert.equal(prompt, builtinPrompt);
    const journal = await readFile(journalPath, 'utf8');
    const promptDigest = `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
    const candidateSnapshot = await readFile(join(paths.memoryRoot, 'project', 'snapshot.json'), 'utf8');
    assert.equal(candidateSnapshot.includes(promptDigest), true);
    const persistedRecords = journal.trim().split('\n').map((line) =>
      JSON.parse(line) as {
        readonly payload?: {
          readonly type?: string;
          readonly result?: {
            readonly receipt?: { readonly disposition?: string; readonly effectRefs?: readonly string[] };
            readonly cursor?: { readonly lastHandledSequence?: number };
          };
        };
      });
    const consumerCommit = persistedRecords.find((record) => record.payload?.type === 'consumer-commit');
    assert.equal(consumerCommit?.payload?.result?.receipt?.disposition, 'applied');
    assert.equal(consumerCommit?.payload?.result?.receipt?.effectRefs?.some((ref) =>
      ref.startsWith('memory-analysis-request:')), true);
    assert.equal(consumerCommit?.payload?.result?.cursor?.lastHandledSequence, 1);
    assert.equal(operation.operationId.length > 0, true);
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI serve rejects an unknown configured memory audit prompt before publishing a boundary', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-cli-memory-audit-unknown-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await writeFile(join(workspace, 'AGENTS.md'), '# Gate 25 project\n', 'utf8');
  await appendFile(join(controlRoot, 'config.toml'), '\n[memory.audit]\nprompt_ref = "unknown-memory-audit"\n', 'utf8');
  const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
  try {
    const result = await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        'serve',
        '--workspace',
        workspace,
        '--control-root',
        controlRoot,
        '--mode',
        'fake',
        '--port',
        '0',
      ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code === 0, false);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /configured memory audit prompt is not a builtin resource: unknown-memory-audit/);
    await assert.rejects(
      async () => readFile(join(paths.journalRoot, 'events.jsonl'), 'utf8'),
      (error: unknown) => (error as { readonly code?: string }).code === 'ENOENT',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('memory runtime preserves an existing configured audit prompt while keeping its digest observable', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-audit-existing-');
  await writeFile(join(workspace, 'AGENTS.md'), '# Existing audit prompt project\n', 'utf8');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  const auditPrompt = '# Existing custom audit prompt\n\nKeep this content.\n';
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), auditPrompt, 'utf8');
  const configuration = await loadConfiguration(paths);
  const runtime = await openRuntime({
    controlRoot,
    workspace,
    plan: 'default',
    sessionId: 'session-existing-memory-audit',
  });
  try {
    const mainAgentId = configuration.effective.project?.defaultAgent ?? configuration.agentRoster[0]!.agentId;
    const memory = await composeMemoryRuntime({
      paths,
      configuration,
      workspaceCwd: paths.workspaceCwd,
      sessionsRoot: paths.sessionsRoot,
      runNotesRoot: paths.runNotesRoot,
      auditPromptRoot,
      auditPromptRef: 'project-memory-audit',
      autoUpdate: false,
      binding: {
        bindingRef: 'memory-runtime-existing-audit',
        projectKey: paths.projectKey,
        executionEpoch: 1,
        scope: {
          namespace: 'project',
          projectKey: paths.projectKey,
          organId: id('organ', `agent-${mainAgentId}`),
          taskId: id('task', 'session-existing-memory-audit'),
        },
        taskId: id('task', 'session-existing-memory-audit'),
        mainAgentId,
        actor: {
          actorId: 'memory-runtime-existing-audit',
          roleId: 'memory',
          permissions: ['memory.read', 'memory.propose'],
          projectKey: paths.projectKey,
        },
      },
    });
    assert.equal(await readFile(join(auditPromptRoot, 'project-memory-audit.md'), 'utf8'), auditPrompt);
    const loadedPrompt = await memory.composition.sources.readPrompt({
      projectKey: paths.projectKey,
      promptRef: 'project-memory-audit',
    });
    assert.equal(loadedPrompt.content, auditPrompt);
  } finally {
    await runtime.lock.release();
    await rm(root, { recursive: true, force: true });
  }
});

test('memory composition binds task and runtime identity to the rooted backend', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-binding-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const { composed, binding, scope, taskId } = await composeMemoryFixture({
    paths,
    workspace,
    assignmentId: 'assignment-memory-composition',
    agentRuntimeId: 'runtime-memory-composition',
    roleId: 'execution',
  });
  const recalled = await composed.coordinator.recall({
    agentRuntimeId: 'runtime-memory-composition',
    roleId: 'execution',
    taskId,
    scope: binding.scope,
    layers: ['current'],
    tokenBudget: 10,
    executionEpoch: 1,
    evidenceRequired: true,
  });
  assert.equal(recalled.status, 'ready');
  if (recalled.status !== 'ready') throw new Error('expected memory recall');
  assert.equal(recalled.value.bindingId, binding.bindingRef);
  assert.deepEqual(scope.taskId, taskId);
});

test('entry composition reports live serve plugins and rejects an incomplete host', () => {
  const snapshot = {
    state: 'ready' as const,
    pluginIds: [
      'humanagent.harness-kernel',
      'humanagent.agent-templates',
      'humanagent.fake-provider',
      'humanagent.memory',
      'humanagent.ui',
    ],
    capabilities: {
      'harness.kernel': 'humanagent.harness-kernel',
      'agent.templates': 'humanagent.agent-templates',
      'provider.execution': 'humanagent.fake-provider',
      'memory.operations': 'humanagent.memory',
      'memory.context': 'humanagent.memory',
      'ui.projection': 'humanagent.ui',
    },
    startedPluginIds: [
      'humanagent.harness-kernel',
      'humanagent.agent-templates',
      'humanagent.fake-provider',
      'humanagent.memory',
      'humanagent.ui',
    ],
  };
  const inventory = entryCompositionInventory(snapshot, 'fake');
  assert.equal(inventory.complete, true);
  assert.equal(serveCompositionComplete(snapshot, 'fake'), true);
  assert.equal(inventory.components.some((component) => component.state === 'unavailable'), false);
  assert.equal(serveCompositionComplete({ ...snapshot, startedPluginIds: snapshot.startedPluginIds.slice(0, -1) }, 'fake'), false);
});

test('serve composition contract is independent from the constructed plugin list', () => {
  const plugin = (pluginId: string, provides: readonly string[]) => ({
    manifest: {
      kind: 'humanagent.plugin' as const,
      pluginId,
      version: '1.0.0',
      apiVersion: 1,
      entry: `builtin:${pluginId}`,
      dependencies: ['humanagent.harness-kernel'],
      provides,
      consumes: ['harness.kernel'],
      permissions: [],
      digest: `builtin:${pluginId}:v1`,
    },
  });
  const complete = [
    plugin('humanagent.fake-provider', ['provider.execution']),
    plugin('humanagent.agent-templates', ['agent.templates']),
    plugin('humanagent.memory', ['memory.operations', 'memory.context']),
    plugin('humanagent.ui', ['ui.projection']),
  ];
  assert.equal(serveCompositionManifestMatches(complete, 'fake'), true);
  assert.equal(serveCompositionManifestMatches(complete.slice(1), 'fake'), false);
  assert.equal(serveCompositionManifestMatches([
    ...complete,
    plugin('humanagent.harness-kernel', ['harness.kernel']),
  ], 'fake'), false);
});

test('memory composition uses the trusted task binding ref for explicit brain memory operations', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-task-tools-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const { composed, binding } = await composeMemoryFixture({
    paths,
    workspace,
    assignmentId: 'assignment-memory-task-tools',
    agentRuntimeId: 'runtime-memory-task-tools',
    roleId: 'memory',
  });

  const view = await composed.interaction.query({
    actor: binding.actor,
    projectKey: binding.projectKey,
    namespace: 'project',
    query: 'missing',
    limit: 5,
  });
  assert.equal(view.entries.length, 0);

  const receipt = await composed.submissions.submitCandidate({
    submissionId: 'submission:memory-task-tools',
    requestId: 'request:memory-task-tools',
    operationId: id('operation', 'memory-task-tools'),
    bindingRef: binding.bindingRef,
    actor: binding.actor,
    projectKey: binding.projectKey,
    taskId: binding.taskId,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef: 'content:memory-task-tools',
    contentDigest: 'sha256:content-memory-task-tools',
    evidenceRefs: ['source:memory-task-tools'],
    observation: 'task-bound explicit brain memory submission',
    desiredScope: 'project',
    reason: 'regression coverage for the trusted task binding ref',
    inputDigest: 'sha256:input-memory-task-tools',
  });
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.nextAction, 'wait-analysis');
});

test('memory composition registers interaction bindings for the interaction port', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-interaction-binding-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const interactionScopeId = 'interaction-memory-composition';
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'audit.md'), '# Memory audit\n', 'utf8');
  await writeFile(join(workspace, 'AGENTS.md'), '# Project rules\n', 'utf8');
  await mkdir(join(workspace, 'project-memory'), { recursive: true });
  await writeFile(join(workspace, 'project-memory', 'SKILL.md'), '# Project memory\n', 'utf8');
  const actor = {
    actorId: 'interaction-memory-composition-actor',
    roleId: 'interaction' as const,
    permissions: ['memory.read'] as const,
    projectKey: paths.projectKey,
  };
  const composed = await composeMemory({
    paths,
    projectKey: paths.projectKey,
    workspaceCwd: workspace,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    localSkillRoot: workspace,
    localSkillName: 'project-memory',
    auditPromptRoot,
    auditPromptRef: 'audit',
    autoUpdate: false,
    binding: {
      bindingRef: 'memory-binding:interaction-composition',
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey: paths.projectKey,
        organId: id('organ', 'memory-interaction-composition'),
      },
      interactionScopeId,
      mainAgentId: 'main-agent-a',
      actor,
    },
  });

  const handle = await composed.interaction.open({
    actor,
    projectKey: paths.projectKey,
    namespace: 'project',
  });
  assert.equal(handle.readOnly, true);
  const view = await composed.interaction.query({
    actor,
    projectKey: paths.projectKey,
    namespace: 'project',
    query: 'missing',
    limit: 5,
  });
  assert.equal(view.entries.length, 0);
});

test('memory composition exposes candidate submission without hiding waiting or attention outcomes', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-submission-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const interactionScopeId = 'interaction-memory-submission';
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'audit.md'), '# Memory audit\n', 'utf8');
  await writeFile(join(workspace, 'AGENTS.md'), '# Project rules\n', 'utf8');
  await mkdir(join(workspace, 'project-memory'), { recursive: true });
  await writeFile(join(workspace, 'project-memory', 'SKILL.md'), '# Project memory\n', 'utf8');
  const actor = {
    actorId: 'interaction-memory-submission-actor',
    roleId: 'interaction' as const,
    permissions: ['memory.propose'] as const,
    projectKey: paths.projectKey,
  };
  const composed = await composeMemory({
    paths,
    projectKey: paths.projectKey,
    workspaceCwd: workspace,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    localSkillRoot: workspace,
    localSkillName: 'project-memory',
    auditPromptRoot,
    auditPromptRef: 'audit',
    autoUpdate: false,
    binding: {
      bindingRef: 'memory-binding:interaction-submission',
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey: paths.projectKey,
        organId: id('organ', 'memory-interaction-submission'),
      },
      interactionScopeId,
      mainAgentId: 'main-agent-a',
      actor,
    },
  });

  const receipt = await composed.submissions.submitCandidate({
    submissionId: 'submission:memory-composition',
    requestId: 'request:memory-composition',
    operationId: id('operation', 'memory-composition'),
    bindingRef: 'memory-binding:interaction:interaction-memory-submission',
    actor,
    projectKey: paths.projectKey,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef: 'content:memory-composition',
    contentDigest: 'sha256:content-memory-composition',
    evidenceRefs: ['source:memory-composition'],
    observation: 'composition submission',
    desiredScope: 'project',
    reason: 'test',
    inputDigest: 'sha256:input-memory-composition',
  });
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.nextAction, 'wait-analysis');

  await assert.rejects(
    () => composed.submissions.submitCandidate({
      submissionId: 'submission:memory-composition-denied',
      requestId: 'request:memory-composition-denied',
      operationId: id('operation', 'memory-composition-denied'),
      bindingRef: 'memory-binding:missing',
      actor,
      projectKey: paths.projectKey,
      requestedKind: 'semantic',
      candidateCategory: 'project-fact',
      contentRef: 'content:memory-composition-denied',
      contentDigest: 'sha256:content-memory-composition-denied',
      evidenceRefs: ['source:memory-composition-denied'],
      observation: 'composition submission denied',
      desiredScope: 'project',
      reason: 'test',
      inputDigest: 'sha256:input-memory-composition-denied',
    }),
    (error: unknown) => error instanceof AppLifecycleError
      && error.code === 'memory-binding-missing',
  );
});

test('runtime memory explicit submission publishes one durable analysis request and consumes it', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-explicit-submission-');
  await writeFile(join(workspace, 'AGENTS.md'), '# Explicit submission\n', 'utf8');
  const runtime = await openRuntime({
    controlRoot,
    workspace,
    plan: 'default',
    sessionId: 'session-memory-explicit-submission',
  });
  const { paths, configuration } = runtime;
  const taskId = id('task', 'session-memory-explicit-submission');
  const evidenceText = 'explicit submission evidence';
  const evidenceDigest = `sha256:${createHash('sha256').update(evidenceText).digest('hex')}`;
  const evidence: EvidenceRef = {
    evidenceId: id('evidence', 'memory-explicit-submission-evidence'),
    kind: 'operation',
    source: 'test',
    locator: 'humanagent://checkpoint/explicit-submission',
    digest: evidenceDigest,
    scope: {
      organId: id('organ', `agent-${configuration.effective.project?.defaultAgent ?? configuration.agentRoster[0]!.agentId}`),
      taskId,
      cycleId: id('cycle', 'explicit-submission-cycle'),
      operationId: id('operation', 'explicit-submission-operation'),
    },
  };
  const driver = new MemoryAnalysisDriver();
  const evidenceReads: string[] = [];
  const memory = await composeMemoryRuntime({
    paths,
    configuration,
    workspaceCwd: paths.workspaceCwd,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    auditPromptRoot: join(paths.controlRoot, 'memory-audit'),
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    assignmentId: 'explicit-submission-assignment',
    agentRuntimeId: 'explicit-submission-runtime',
    roleId: 'interaction',
    driverFor: () => driver,
    evidenceSource: {
      read: async ({ evidence: requested }) => {
        evidenceReads.push(`${requested.locator}:${requested.scope.taskId?.value ?? 'organ'}`);
        return {
          sourceRef: requested.locator,
          sourceDigest: requested.digest!,
          text: evidenceText,
        };
      },
    },
    binding: {
      bindingRef: 'memory-binding:explicit-submission',
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey: paths.projectKey,
        organId: evidence.scope.organId,
        taskId,
      },
      taskId,
      mainAgentId: 'explicit-submission-main',
      actor: {
        actorId: 'memory-agent',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
    },
  });

  const receipt = await memory.composition.submissions.submitCandidate({
    submissionId: 'submission:explicit',
    requestId: 'request:explicit',
    operationId: id('operation', 'explicit-submission-request'),
    bindingRef: memory.composition.bindingRef,
    actor: {
      actorId: 'main-agent',
      roleId: 'interaction',
      permissions: ['memory.read', 'memory.propose'],
      projectKey: paths.projectKey,
    },
    projectKey: paths.projectKey,
    taskId,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef: evidence.locator,
    contentDigest: evidence.digest!,
    evidenceRefs: [evidence.locator],
    observation: 'explicit memory submission',
    desiredScope: 'project',
    reason: 'explicit submission must trigger analysis',
    inputDigest: `sha256:${createHash('sha256').update('explicit-submission-input').digest('hex')}`,
  });
  assert.equal(receipt.status, 'accepted');

  const analysisEvents = await memory.journal.readEvents({
    streamId: `memory-boundaries:${taskId.value}`,
    afterSequence: 0,
    limit: 10,
  });
  assert.equal(analysisEvents.length, 1);
  assert.equal(analysisEvents[0]?.kind, 'memory.analysis.requested');
  assert.equal(analysisEvents[0]?.payload?.trigger, 'explicit-submission');
  assert.deepEqual(analysisEvents[0]?.evidenceRefs, [{
    evidenceId: analysisEvents[0]?.evidenceRefs[0]?.evidenceId,
    kind: 'operation',
    source: 'humanagent.app.memory-runtime',
    locator: evidence.locator,
    digest: evidence.digest,
    scope: {
      organId: evidence.scope.organId,
      taskId,
    },
  }]);
  const consumed = await memory.consume();
  assert.equal(consumed.committed.length, 1, JSON.stringify(consumed));
  assert.equal(consumed.committed[0]?.disposition, 'applied');
  assert.deepEqual(evidenceReads, [
    `${evidence.locator}:${taskId.value}`,
    `${evidence.locator}:${taskId.value}`,
    `${evidence.locator}:${taskId.value}`,
  ]);
  assert.deepEqual(driver.events.map((event) => event.split(':')[0]), [
    'start',
    'submit',
    'observe',
    'settle',
  ]);
  await runtime.lock.release();
  await rm(root, { recursive: true, force: true });
});

test('runtime memory recovers an accepted explicit submission when analysis publication fails', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-explicit-recovery-');
  await writeFile(join(workspace, 'AGENTS.md'), '# Explicit recovery\n', 'utf8');
  const runtime = await openRuntime({
    controlRoot,
    workspace,
    plan: 'default',
    sessionId: 'session-memory-explicit-recovery',
  });
  const { paths, configuration } = runtime;
  const taskId = id('task', 'session-memory-explicit-recovery');
  const contentText = 'explicit submission recovery evidence';
  const contentDigest = `sha256:${createHash('sha256').update(contentText).digest('hex')}`;
  const contentRef = 'humanagent://checkpoint/explicit-recovery';
  const organId = id('organ', `agent-${configuration.effective.project?.defaultAgent ?? configuration.agentRoster[0]!.agentId}`);
  let reads = 0;
  const compose = () => composeMemoryRuntime({
    paths,
    configuration,
    workspaceCwd: paths.workspaceCwd,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    auditPromptRoot: join(paths.controlRoot, 'memory-audit'),
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    assignmentId: 'explicit-recovery-assignment',
    agentRuntimeId: 'explicit-recovery-runtime',
    roleId: 'interaction',
    driverFor: () => new MemoryAnalysisDriver(),
    evidenceSource: {
      read: async ({ evidence: requested }) => {
        reads += 1;
        if (reads === 2) throw new Error('injected analysis publication failure');
        return {
          sourceRef: requested.locator,
          sourceDigest: requested.digest!,
          text: contentText,
        };
      },
    },
    binding: {
      bindingRef: 'memory-binding:explicit-recovery',
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey: paths.projectKey,
        organId,
        taskId,
      },
      taskId,
      mainAgentId: 'explicit-recovery-main',
      actor: {
        actorId: 'memory-agent',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
    },
  });
  const submission = {
    submissionId: 'submission:explicit-recovery',
    requestId: 'request:explicit-recovery',
    operationId: id('operation', 'explicit-recovery-request'),
    bindingRef: 'memory-binding:explicit-recovery',
    actor: {
      actorId: 'main-agent',
      roleId: 'interaction' as const,
      permissions: ['memory.read', 'memory.propose'] as const,
      projectKey: paths.projectKey,
    },
    projectKey: paths.projectKey,
    taskId,
    requestedKind: 'semantic' as const,
    candidateCategory: 'project-fact' as const,
    contentRef,
    contentDigest,
    evidenceRefs: [contentRef],
    observation: 'explicit submission recovery',
    desiredScope: 'project' as const,
    reason: 'prove accepted submission remains recoverable',
    inputDigest: `sha256:${createHash('sha256').update('explicit-recovery-input').digest('hex')}`,
  };

  const first = await compose();
  await assert.rejects(
    () => first.composition.submissions.submitCandidate(submission),
    (error: unknown) => error instanceof AppLifecycleError
      && error.code === 'memory-explicit-submission-publication-failed'
      && error.message.includes('durable recovery record'),
  );
  const pendingRoot = join(paths.locksRoot, 'memory-explicit-submissions');
  const pendingFiles = async (): Promise<readonly string[]> => {
    const bindingRoot = join(
      pendingRoot,
      createHash('sha256').update('memory-binding:explicit-recovery').digest('hex'),
    );
    try {
      return (await readdir(bindingRoot)).filter((entry) => entry.endsWith('.json'));
    } catch (error) {
      if ((error as { readonly code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  };
  assert.equal((await pendingFiles()).length, 1);
  assert.equal((await first.journal.readEvents({
    streamId: `memory-boundaries:${taskId.value}`,
    afterSequence: 0,
    limit: 10,
  })).length, 0);

  const restarted = await compose();
  assert.equal((await restarted.journal.readEvents({
    streamId: `memory-boundaries:${taskId.value}`,
    afterSequence: 0,
    limit: 10,
  })).length, 1);
  assert.equal((await pendingFiles()).length, 0);
  assert.equal((await restarted.consume()).committed.length, 1);

  await runtime.lock.release();
  await rm(root, { recursive: true, force: true });
});

test('runtime memory rejects explicit submission evidence without a verifiable digest', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-explicit-evidence-');
  await writeFile(join(workspace, 'AGENTS.md'), '# Explicit evidence\n', 'utf8');
  const runtime = await openRuntime({
    controlRoot,
    workspace,
    plan: 'default',
    sessionId: 'session-memory-explicit-evidence',
  });
  const { paths, configuration } = runtime;
  const taskId = id('task', 'session-memory-explicit-evidence');
  const contentText = 'explicit submission content';
  const contentDigest = `sha256:${createHash('sha256').update(contentText).digest('hex')}`;
  const organId = id('organ', `agent-${configuration.effective.project?.defaultAgent ?? configuration.agentRoster[0]!.agentId}`);
  const interactionScopeId = 'interaction-memory-explicit-evidence';
  const memory = await composeMemoryRuntime({
    paths,
    configuration,
    workspaceCwd: paths.workspaceCwd,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    auditPromptRoot: join(paths.controlRoot, 'memory-audit'),
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    evidenceSource: {
      read: async ({ evidence: requested }) => ({
        sourceRef: requested.locator,
        sourceDigest: requested.digest!,
        text: contentText,
      }),
    },
    binding: {
      bindingRef: 'memory-binding:explicit-evidence',
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey: paths.projectKey,
        organId,
      },
      interactionScopeId,
      mainAgentId: 'explicit-evidence-main',
      actor: {
        actorId: 'memory-agent',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
    },
  });

  await assert.rejects(
    () => memory.composition.submissions.submitCandidate({
      submissionId: 'submission:explicit-evidence',
      requestId: 'request:explicit-evidence',
      operationId: id('operation', 'explicit-evidence-request'),
      bindingRef: memory.composition.bindingRef,
      actor: {
        actorId: 'main-agent',
        roleId: 'interaction',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
      projectKey: paths.projectKey,
      taskId,
      requestedKind: 'semantic',
      candidateCategory: 'project-fact',
      contentRef: 'humanagent://checkpoint/explicit-content',
      contentDigest,
      evidenceRefs: ['journal://unverifiable/evidence'],
      observation: 'explicit evidence submission',
      desiredScope: 'project',
      reason: 'unverifiable evidence must not be dropped',
      inputDigest: `sha256:${createHash('sha256').update('explicit-evidence-input').digest('hex')}`,
    }),
    (error: unknown) => error instanceof AppLifecycleError
      && error.code === 'memory-explicit-submission-evidence-unsupported',
  );
  const events = await memory.journal.readEvents({
    streamId: `memory-boundaries:${taskId.value}`,
    afterSequence: 0,
    limit: 10,
  });
  assert.equal(events.length, 0);
  await runtime.lock.release();
  await rm(root, { recursive: true, force: true });
});

test('memory composition rejects partial runtime bindings explicitly', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-binding-partial-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await assert.rejects(
    () => composeMemoryFixture({
      paths,
      workspace,
      assignmentId: 'assignment-memory-partial',
      agentRuntimeId: 'runtime-memory-partial',
    }),
    (error: unknown) => error instanceof AppLifecycleError
      && error.code === 'memory-binding-incomplete'
      && error.ownerId === 'humanagent.app.memory-composition',
  );
});

test('memory composition rejects mixed task and interaction bindings before registering coordinator state', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-binding-mixed-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await assert.rejects(
    () => composeMemoryFixture({
      paths,
      workspace,
      assignmentId: 'assignment-memory-mixed',
      interactionScopeId: 'interaction-memory-mixed',
    }),
    (error: unknown) => error instanceof AppLifecycleError
      && error.code === 'memory-binding-invalid'
      && error.ownerId === 'humanagent.app.memory-composition',
  );
});

test('memory composition rejects project identity mismatch before opening persistence', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-project-mismatch-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await assert.rejects(
    () => composeMemoryFixture({
      paths,
      workspace,
      projectKey: 'other-project',
    }),
    (error: unknown) => error instanceof AppLifecycleError
      && error.code === 'memory-project-mismatch'
      && error.ownerId === 'humanagent.app.memory-composition',
  );
});

test('memory composition ingests typed evidence before admitting analysis', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-admission-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const evidenceText = 'typed memory composition evidence';
  const { composed, binding, scope } = await composeMemoryFixture({
    paths,
    workspace,
    evidenceSource: {
      read: async ({ evidence }) => ({
        sourceRef: evidence.locator,
        sourceDigest: evidence.digest!,
        text: evidenceText,
      }),
    },
  });
  const evidence: EvidenceRef = {
    evidenceId: id('evidence', 'memory-composition-evidence'),
    kind: 'operation',
    source: 'test',
    locator: 'journal://memory-composition/evidence',
    digest: `sha256:${createHash('sha256').update(evidenceText).digest('hex')}`,
    scope,
  };
  const event = {
    ...createMemoryAnalysisRequestedEvent({
      messageId: 'memory-composition-message',
      streamId: 'memory-composition-stream',
      scope,
      occurredAt: '2026-09-17T00:00:00.000Z',
      summary: 'memory composition analysis',
      evidenceRefs: [evidence],
      executionEpoch: 1,
      trigger: 'completion',
      candidateCategory: 'project-fact',
    }),
    publisherId: 'memory-composition-publisher',
    sequence: 1,
    committedAt: '2026-09-17T00:00:00.000Z',
  };
  const requestOutcome = memoryAnalysisRequestFromEvent(event, binding);
  assert.equal(requestOutcome.status, 'ready');
  if (requestOutcome.status !== 'ready') throw new Error('expected memory analysis request');
  const admitted = await composed.admission.admit({ request: requestOutcome.value, event });
  assert.equal(admitted.status, 'ready', admitted.status === 'attention' ? admitted.issue.message : '');
  assert.equal(await composed.backend.inspect({ sourceRef: evidence.locator }).then((source) => source.sourceDigest), evidence.digest);
});

test('memory composition returns attention when evidence is missing or drifted', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-evidence-attention-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const { composed, binding, scope } = await composeMemoryFixture({ paths, workspace });
  const evidence: EvidenceRef = {
    evidenceId: id('evidence', 'memory-composition-missing-evidence'),
    kind: 'operation',
    source: 'test',
    locator: 'journal://memory-composition/missing-evidence',
    digest: 'sha256:memory-composition-missing-evidence',
    scope,
  };
  const event = {
    ...createMemoryAnalysisRequestedEvent({
      messageId: 'memory-composition-missing-message',
      streamId: 'memory-composition-missing-stream',
      scope,
      occurredAt: '2026-09-17T00:00:00.000Z',
      summary: 'memory composition missing evidence',
      evidenceRefs: [evidence],
      executionEpoch: 1,
      trigger: 'completion',
      candidateCategory: 'project-fact',
    }),
    publisherId: 'memory-composition-publisher',
    sequence: 1,
    committedAt: '2026-09-17T00:00:00.000Z',
  };
  const requestOutcome = memoryAnalysisRequestFromEvent(event, binding);
  assert.equal(requestOutcome.status, 'ready');
  if (requestOutcome.status !== 'ready') throw new Error('expected memory analysis request');
  const admitted = await composed.admission.admit({ request: requestOutcome.value, event });
  assert.equal(admitted.status, 'attention');
  if (admitted.status !== 'attention') throw new Error('expected attention');
  assert.equal(admitted.issue.code, 'memory-agent-source-invalid');

  const driftedEvidenceText = 'drifted memory composition evidence';
  const driftedEvidenceDigest = `sha256:${createHash('sha256').update(driftedEvidenceText).digest('hex')}`;
  const drifted = await composeMemoryFixture({
    paths,
    workspace,
    evidenceSource: {
      read: async ({ evidence }) => ({
        sourceRef: evidence.locator,
        sourceDigest: driftedEvidenceDigest,
        text: 'different evidence text',
      }),
    },
  });
  const driftedEvent = {
    ...event,
    messageId: 'memory-composition-drifted-message',
    evidenceRefs: [{
      ...event.evidenceRefs[0],
      digest: driftedEvidenceDigest,
    }],
  };
  const driftedRequest = memoryAnalysisRequestFromEvent(driftedEvent, drifted.binding);
  assert.equal(driftedRequest.status, 'ready');
  if (driftedRequest.status !== 'ready') throw new Error('expected drifted memory analysis request');
  const driftedAdmission = await drifted.composed.admission.admit({ request: driftedRequest.value, event: driftedEvent });
  assert.equal(driftedAdmission.status, 'attention');
  if (driftedAdmission.status !== 'attention') throw new Error('expected drifted evidence attention');
  assert.equal(driftedAdmission.issue.code, 'memory-agent-source-invalid');
});

test('project source updates require a typed patch reader', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-patch-reader-');
  const current = {
    projectKey: 'project-a',
    target: 'project-agents' as const,
    content: 'current',
    sourceRef: 'project://project-a/AGENTS.md',
    canonicalRef: 'project://project-a/AGENTS.md',
    revision: 'sha256:current',
    digest: `sha256:${createHash('sha256').update('current').digest('hex')}`,
    loadedAt: '2026-09-17T00:00:00.000Z',
  };
  const owner = createProjectSourceUpdateOwner({
    workspaceCwd: workspace,
    localSkillRoot: workspace,
    localSkillName: 'project-memory',
    projectKey: 'project-a',
    locksRoot: join(controlRoot, 'locks'),
  });
  await assert.rejects(
    () => owner.apply({
      current,
      auto: true,
      proposal: {
        target: 'project-agents',
        sourceRef: current.sourceRef,
        expectedRevision: current.revision,
        expectedDigest: current.digest,
        patchRef: 'typed://patch',
        patchDigest: 'sha256:patch',
        evidenceRefs: [],
        ownerRef: 'project-owner',
      },
    }),
    (error: unknown) => error instanceof AppLifecycleError && error.code === 'memory-update-unavailable',
  );
});

test('project source auto updates require a durable publisher', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-publisher-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await writeFile(join(workspace, 'AGENTS.md'), '# Project\n', 'utf8');
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# Audit\n', 'utf8');
  const configuration = await loadConfiguration(paths);
  await assert.rejects(
    () => composeMemory({
      paths,
      projectKey: paths.projectKey,
      workspaceCwd: paths.workspaceCwd,
      sessionsRoot: paths.sessionsRoot,
      runNotesRoot: paths.runNotesRoot,
      auditPromptRoot,
      auditPromptRef: 'project-memory-audit',
      autoUpdate: true,
      binding: {
        bindingRef: 'memory-binding:publisher-required',
        projectKey: paths.projectKey,
        executionEpoch: 1,
        scope: {
          namespace: 'project',
          projectKey: paths.projectKey,
          organId: id('organ', 'memory-publisher-required'),
        },
        interactionScopeId: `runtime:${paths.projectKey}`,
        mainAgentId: 'main-agent-a',
        actor: {
          actorId: 'memory-agent',
          roleId: 'memory',
          permissions: ['memory.read', 'memory.propose'],
          projectKey: paths.projectKey,
        },
      },
    }),
    (error: unknown) => error instanceof AppLifecycleError && error.code === 'memory-update-publication-unavailable',
  );
});

test('memory runtime applies immutable project patches and publishes a durable update fact', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-auto-update-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const original = '# Original project rules\n';
  const next = memoryEntryContent(original, 'project-fact');
  await writeFile(join(workspace, 'AGENTS.md'), original, 'utf8');
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# Audit\n', 'utf8');
  const patchRef = 'project-agents-next';
  const patchDigest = await writeMemoryEntryPatchArtifact(paths.artifactsRoot, patchRef, 'project-agents');
  const configuration = await loadConfiguration(paths);
  const scope = {
    namespace: 'project' as const,
    projectKey: paths.projectKey,
    organId: id('organ', 'memory-auto-update'),
  };
  const runtime = await composeMemoryRuntime({
    paths,
    configuration,
    workspaceCwd: paths.workspaceCwd,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    auditPromptRoot,
    auditPromptRef: 'project-memory-audit',
    autoUpdate: true,
    binding: {
      bindingRef: 'memory-binding:auto-update',
      projectKey: paths.projectKey,
      executionEpoch: 3,
      scope,
      interactionScopeId: `runtime:${paths.projectKey}`,
      mainAgentId: 'main-agent-a',
      actor: {
        actorId: 'memory-agent',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
    },
  });
  const current = await runtime.composition.sources.readProject({
    projectKey: paths.projectKey,
    target: 'project-agents',
  });
  const applied = await runtime.composition.agent.applyProjectUpdate({
    projectKey: paths.projectKey,
    proposal: {
      target: 'project-agents',
      sourceRef: current.sourceRef,
      expectedRevision: current.revision,
      expectedDigest: current.digest,
      patchRef,
      patchDigest,
      evidenceRefs: ['journal://project-a/evidence'],
      ownerRef: 'project-rule-owner',
    },
  });
  assert.equal(applied.status, 'ready');
  if (applied.status !== 'ready') throw new Error('expected automatic source update');
  assert.equal(applied.value.updated, true);
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), next);
  const events = await runtime.journal.readEvents({
    streamId: `memory-project-source-updates:${paths.projectKey}`,
    afterSequence: 0,
    limit: 10,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'memory.project-source.updated');
  assert.equal(events[0]?.payload?.patchDigest, patchDigest);
});

test('memory runtime recovers a committed source update when its durable fact was not published', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-auto-update-recovery-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const original = '# Original project rules\n';
  const next = '# Updated project rules\n';
  await writeFile(join(workspace, 'AGENTS.md'), original, 'utf8');
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# Audit\n', 'utf8');
  const patchRef = 'project-agents-recovery';
  const patchDigest = await writeProjectPatchArtifact(paths.artifactsRoot, patchRef, 'project-agents', next);
  const configuration = await loadConfiguration(paths);
  const legacyScope = {
    kind: 'organ' as const,
    organId: id('organ', 'memory-auto-update-recovery'),
  };
  const scope = {
    namespace: 'project' as const,
    projectKey: paths.projectKey,
    organId: legacyScope.organId,
  };
  const owner = createProjectSourceUpdateOwner({
    workspaceCwd: paths.workspaceCwd,
    projectKey: paths.projectKey,
    locksRoot: paths.locksRoot,
    patchReader: {
      read: async () => ({ content: next }),
    },
    projectSourceUpdatePublisher: {
      publish: async () => { throw new Error('journal unavailable'); },
    },
    sourceScope: legacyScope,
    executionEpoch: 1,
  });
  const current = {
    projectKey: paths.projectKey,
    target: 'project-agents' as const,
    content: original,
    sourceRef: `project://${paths.projectKey}/AGENTS.md`,
    canonicalRef: `project://${paths.projectKey}/AGENTS.md`,
    revision: `sha256:${createHash('sha256').update(original).digest('hex')}`,
    digest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
    loadedAt: '2026-09-19T00:00:00.000Z',
  };
  const proposal = {
    target: 'project-agents' as const,
    sourceRef: current.sourceRef,
    expectedRevision: current.revision,
    expectedDigest: current.digest,
    patchRef,
    patchDigest,
    evidenceRefs: ['journal://project-a/evidence'],
    ownerRef: 'project-rule-owner',
  };
  await assert.rejects(
    () => owner.apply({ current, proposal, auto: true }),
    (error: unknown) => error instanceof AppLifecycleError && error.code === 'memory-update-publication-failed',
  );
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), next);

  const runtime = await composeMemoryRuntime({
    paths,
    configuration,
    workspaceCwd: paths.workspaceCwd,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    auditPromptRoot,
    auditPromptRef: 'project-memory-audit',
    autoUpdate: true,
    binding: {
      bindingRef: 'memory-binding:auto-update-recovery',
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope,
      interactionScopeId: `runtime:${paths.projectKey}`,
      mainAgentId: 'main-agent-a',
      actor: {
        actorId: 'memory-agent',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
    },
  });
  const events = await runtime.journal.readEvents({
    streamId: `memory-project-source-updates:${paths.projectKey}`,
    afterSequence: 0,
    limit: 10,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload?.patchDigest, patchDigest);
  await assert.rejects(
    () => readFile(join(paths.locksRoot, 'memory-project-source-update.pending.json'), 'utf8'),
    (error: unknown) => (error as { readonly code?: string }).code === 'ENOENT',
  );
});

test('memory runtime rejects missing or drifted immutable project patches', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-auto-update-invalid-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const original = '# Original project rules\n';
  await writeFile(join(workspace, 'AGENTS.md'), original, 'utf8');
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# Audit\n', 'utf8');
  const configuration = await loadConfiguration(paths);
  const runtime = await composeMemoryRuntime({
    paths,
    configuration,
    workspaceCwd: paths.workspaceCwd,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    auditPromptRoot,
    auditPromptRef: 'project-memory-audit',
    autoUpdate: true,
    binding: {
      bindingRef: 'memory-binding:auto-update-invalid',
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey: paths.projectKey,
        organId: id('organ', 'memory-auto-update-invalid'),
      },
      interactionScopeId: `runtime:${paths.projectKey}`,
      mainAgentId: 'main-agent-a',
      actor: {
        actorId: 'memory-agent',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
    },
  });
  const current = await runtime.composition.sources.readProject({
    projectKey: paths.projectKey,
    target: 'project-agents',
  });
  const proposal = {
    target: 'project-agents' as const,
    sourceRef: current.sourceRef,
    expectedRevision: current.revision,
    expectedDigest: current.digest,
    patchRef: 'missing-project-patch',
    patchDigest: `sha256:${'c'.repeat(64)}`,
    evidenceRefs: ['journal://project-a/evidence'],
    ownerRef: 'project-rule-owner',
  };
  const missing = await runtime.composition.agent.applyProjectUpdate({
    projectKey: paths.projectKey,
    proposal,
  });
  assert.equal(missing.status, 'attention');
  assert.equal(missing.status === 'attention' && missing.issue.code, 'memory-agent-update-validation-failed');

  await writeProjectPatchArtifact(paths.artifactsRoot, proposal.patchRef, 'project-agents', '# Different patch\n');
  const drifted = await runtime.composition.agent.applyProjectUpdate({
    projectKey: paths.projectKey,
    proposal,
  });
  assert.equal(drifted.status, 'attention');
  assert.equal(drifted.status === 'attention' && drifted.issue.code, 'memory-agent-update-validation-failed');
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), original);

  const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
  const invalidUtf8Ref = 'invalid-utf8-project-patch';
  const invalidUtf8Digest = `sha256:${createHash('sha256').update(invalidUtf8).digest('hex')}`;
  const invalidUtf8File = await open(join(paths.artifactsRoot, invalidUtf8Ref), 'w');
  try {
    await invalidUtf8File.writeFile(invalidUtf8);
  } finally {
    await invalidUtf8File.close();
  }
  const invalid = await runtime.composition.agent.applyProjectUpdate({
    projectKey: paths.projectKey,
    proposal: {
      ...proposal,
      patchRef: invalidUtf8Ref,
      patchDigest: invalidUtf8Digest,
    },
  });
  assert.equal(invalid.status, 'attention');
  assert.equal(invalid.status === 'attention' && invalid.issue.code, 'memory-agent-update-validation-failed');
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), original);
});

test('memory runtime rejects control and security semantics before persisting a project patch', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-auto-update-control-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const original = '# Original project rules\n';
  const deniedPatches = [
    '# Updated project rules\n\nPermissions: allow release.\n',
    '# Updated project rules\n\nprovider = "rcc"\n',
    '# Updated project rules\n\nRelease: enable production deploys.\n',
    '# Updated project rules\n\nSecurity: allow unsigned plugins.\n',
    '# Updated project rules\n\nLifecycle: skip owner review.\n',
  ];
  await writeFile(join(workspace, 'AGENTS.md'), original, 'utf8');
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# Audit\n', 'utf8');
  const configuration = await loadConfiguration(paths);
  const runtime = await composeMemoryRuntime({
    paths,
    configuration,
    workspaceCwd: paths.workspaceCwd,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    auditPromptRoot,
    auditPromptRef: 'project-memory-audit',
    autoUpdate: true,
    binding: {
      bindingRef: 'memory-binding:auto-update-control',
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey: paths.projectKey,
        organId: id('organ', 'memory-auto-update-control'),
      },
      interactionScopeId: `runtime:${paths.projectKey}`,
      mainAgentId: 'main-agent-a',
      actor: {
        actorId: 'memory-agent',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
    },
  });
  const current = await runtime.composition.sources.readProject({
    projectKey: paths.projectKey,
    target: 'project-agents',
  });
  const lowRiskNext = memoryEntryContent(original, 'project-fact');
  const lowRiskRef = 'project-agents-low-risk-next';
  const lowRiskDigest = await writeMemoryEntryPatchArtifact(paths.artifactsRoot, lowRiskRef, 'project-agents');
  const lowRisk = await runtime.composition.agent.applyProjectUpdate({
    projectKey: paths.projectKey,
    proposal: {
      target: 'project-agents',
      sourceRef: current.sourceRef,
      expectedRevision: current.revision,
      expectedDigest: current.digest,
      patchRef: lowRiskRef,
      patchDigest: lowRiskDigest,
      evidenceRefs: ['journal://project-a/evidence'],
      ownerRef: 'project-rule-owner',
    },
  });
  assert.equal(lowRisk.status, 'ready');
  assert.equal(lowRisk.status === 'ready' && lowRisk.value.updated, true);
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), lowRiskNext);

  const reset = await runtime.composition.sources.readProject({
    projectKey: paths.projectKey,
    target: 'project-agents',
  });
  const ownershipNext = '# Project rules\n\nOnly the designated owner may merge to main.\n';
  const ownershipRef = 'project-agents-ownership-next';
  const ownershipDigest = await writeProjectPatchArtifact(
    paths.artifactsRoot,
    ownershipRef,
    'project-agents',
    ownershipNext,
    'project-experience',
  );
  const ownershipRejected = await runtime.composition.agent.applyProjectUpdate({
    projectKey: paths.projectKey,
    proposal: {
      target: 'project-agents',
      sourceRef: reset.sourceRef,
      expectedRevision: reset.revision,
      expectedDigest: reset.digest,
      patchRef: ownershipRef,
      patchDigest: ownershipDigest,
      evidenceRefs: ['journal://project-a/evidence'],
      ownerRef: 'project-rule-owner',
    },
  });
  assert.equal(ownershipRejected.status, 'attention');
  assert.equal(ownershipRejected.status === 'attention' && ownershipRejected.issue.code, 'memory-agent-update-validation-failed');
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), lowRiskNext);
  await assert.rejects(
    () => readFile(join(paths.locksRoot, 'memory-project-source-update.pending.json'), 'utf8'),
    (error: unknown) => (error as { readonly code?: string }).code === 'ENOENT',
  );

  for (const [index, next] of deniedPatches.entries()) {
    const patchRef = `project-agents-control-next-${index}`;
    const artifact = JSON.stringify({ schemaVersion: 1, kind: 'control', target: 'project-agents', payload: { type: 'replacement', content: next }, evidenceRefs: ['journal://project-a/evidence'] });
    const patchDigest = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
    await writeFile(join(paths.artifactsRoot, patchRef), artifact, 'utf8');
    const rejected = await runtime.composition.agent.applyProjectUpdate({
      projectKey: paths.projectKey,
      proposal: {
        target: 'project-agents',
        sourceRef: reset.sourceRef,
        expectedRevision: reset.revision,
        expectedDigest: reset.digest,
        patchRef,
        patchDigest,
        evidenceRefs: ['journal://project-a/evidence'],
        ownerRef: 'project-rule-owner',
      },
    });
    assert.equal(rejected.status, 'attention');
    assert.equal(rejected.status === 'attention' && rejected.issue.code, 'memory-agent-update-validation-failed');
    assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), lowRiskNext);
    await assert.rejects(
      () => readFile(join(paths.locksRoot, 'memory-project-source-update.pending.json'), 'utf8'),
      (error: unknown) => (error as { readonly code?: string }).code === 'ENOENT',
    );
  }
});

test('project source updates reject source identity drift before writing', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-patch-identity-');
  const current = {
    projectKey: 'project-a',
    target: 'project-agents' as const,
    content: 'current',
    sourceRef: 'project://project-a/AGENTS.md',
    canonicalRef: 'project://project-a/AGENTS.md',
    revision: 'sha256:current',
    digest: `sha256:${createHash('sha256').update('current').digest('hex')}`,
    loadedAt: '2026-09-17T00:00:00.000Z',
  };
  const owner = createProjectSourceUpdateOwner({
    workspaceCwd: workspace,
    localSkillRoot: workspace,
    localSkillName: 'project-memory',
    projectKey: 'project-a',
    locksRoot: join(controlRoot, 'locks'),
    patchReader: {
      read: async () => ({ content: 'next' }),
    },
  });
  const proposal = {
    target: 'project-agents' as const,
    sourceRef: current.sourceRef,
    expectedRevision: current.revision,
    expectedDigest: current.digest,
    patchRef: 'typed://patch',
    patchDigest: 'sha256:patch',
    evidenceRefs: [],
    ownerRef: 'project-owner',
  };
  await assert.rejects(
    () => owner.apply({
      current: { ...current, projectKey: 'other-project' },
      auto: true,
      proposal,
    }),
    (error: unknown) => error instanceof AppLifecycleError && error.code === 'memory-update-conflict',
  );
  await assert.rejects(
    () => owner.apply({
      current: { ...current, target: 'project-local-skill' },
      auto: true,
      proposal,
    }),
    (error: unknown) => error instanceof AppLifecycleError && error.code === 'memory-update-conflict',
  );
});

test('project source updates recheck source digest before commit', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-patch-race-');
  const original = 'current';
  await writeFile(join(workspace, 'AGENTS.md'), original, 'utf8');
  const current = {
    projectKey: 'project-a',
    target: 'project-agents' as const,
    content: original,
    sourceRef: 'project://project-a/AGENTS.md',
    canonicalRef: 'project://project-a/AGENTS.md',
    revision: `sha256:${createHash('sha256').update(original).digest('hex')}`,
    digest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
    loadedAt: '2026-09-17T00:00:00.000Z',
  };
  const owner = createProjectSourceUpdateOwner({
    workspaceCwd: workspace,
    localSkillRoot: workspace,
    localSkillName: 'project-memory',
    projectKey: 'project-a',
    locksRoot: join(controlRoot, 'locks'),
    patchReader: {
      read: async () => {
        await writeFile(join(workspace, 'AGENTS.md'), 'newer', 'utf8');
        return { content: 'next' };
      },
    },
    projectSourceUpdatePublisher: {
      publish: async () => undefined,
    },
    sourceScope: { organId: id('organ', 'memory-patch-conflict') },
    executionEpoch: 1,
  });
  await assert.rejects(
    () => owner.apply({
      current,
      auto: true,
      proposal: {
        target: 'project-agents',
        sourceRef: current.sourceRef,
        expectedRevision: current.revision,
        expectedDigest: current.digest,
        patchRef: 'typed://patch',
        patchDigest: 'sha256:patch',
        evidenceRefs: [],
        ownerRef: 'project-owner',
      },
    }),
    (error: unknown) => error instanceof AppLifecycleError && error.code === 'memory-update-conflict',
  );
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), 'newer');
  assert.deepEqual((await readdir(workspace)).filter((name) => name.endsWith('.tmp')), []);
});

test('project source updates reject symlinked source roots', async () => {
  const { root, workspace } = await createConfiguredWorkspace('humanagent-app-memory-patch-symlink-');
  const controlRoot = join(root, 'control');
  const actualSkillRoot = join(root, 'actual-skill-root');
  const linkedSkillRoot = join(root, 'linked-skill-root');
  await mkdir(join(actualSkillRoot, 'project-memory'), { recursive: true });
  await writeFile(join(actualSkillRoot, 'project-memory', 'SKILL.md'), 'current', 'utf8');
  await symlink(actualSkillRoot, linkedSkillRoot);
  const current = {
    projectKey: 'project-a',
    target: 'project-local-skill' as const,
    content: 'current',
    sourceRef: 'skill://project/project-a/project-memory/SKILL.md',
    canonicalRef: 'skill://project/project-a/project-memory/SKILL.md',
    revision: 'sha256:current',
    digest: `sha256:${createHash('sha256').update('current').digest('hex')}`,
    loadedAt: '2026-09-17T00:00:00.000Z',
  };
  const owner = createProjectSourceUpdateOwner({
    workspaceCwd: workspace,
    localSkillRoot: linkedSkillRoot,
    localSkillName: 'project-memory',
    projectKey: 'project-a',
    locksRoot: join(controlRoot, 'locks'),
    patchReader: {
      read: async () => ({ content: 'next' }),
    },
    projectSourceUpdatePublisher: {
      publish: async () => undefined,
    },
    sourceScope: { organId: id('organ', 'memory-patch-symlink') },
    executionEpoch: 1,
  });
  await assert.rejects(
    () => owner.apply({
      current,
      auto: true,
      proposal: {
        target: 'project-local-skill',
        sourceRef: current.sourceRef,
        expectedRevision: current.revision,
        expectedDigest: current.digest,
        patchRef: 'typed://patch',
        patchDigest: 'sha256:patch',
        evidenceRefs: [],
        ownerRef: 'project-owner',
      },
    }),
    (error: unknown) => error instanceof AppLifecycleError && error.code === 'memory-path-invalid',
  );
  assert.equal(await readFile(join(actualSkillRoot, 'project-memory', 'SKILL.md'), 'utf8'), 'current');
});

test('app composes a provider-neutral execution port and preserves adapter ownership', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-execution-');
  const port = executionPort();
  const handle = await openRuntime({
    controlRoot,
    workspace,
    plan: 'default',
    sessionId: 'session-execution',
    execution: runtimeBinding(port),
  });
  assert.equal(handle.execution?.port, port);
  assert.equal(handle.execution?.binding.provider.providerId, 'provider-integration');
  const observedReadiness = await probeExecutionRuntime(handle.execution!);
  assert.equal(observedReadiness.state, 'ready');
  const promptDriver = new PromptCaptureDriver();
  await runAgentOperation({
    paths: handle.paths,
    configuration: handle.configuration,
    workspace,
    sessionId: 'session-execution-prompt',
    plan: 'default',
    prompt: 'verify runtime prompt loading',
    composed: { driver: promptDriver },
  });
  assert.match(promptDriver.lastPrompt, /# Interaction Agent/);
  assert.match(promptDriver.lastPrompt, /verify runtime prompt loading/);
  await handle.lock.release();
  const resumed = await resumeRuntime({ controlRoot, workspace, sessionId: 'session-execution', execution: runtimeBinding(port) });
  assert.equal(resumed.execution?.port, port);
  await closeRuntime(resumed, 'checkpoint:execution');
});

test('app rejects an invalid adapter binding before acquiring a session lock', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-execution-invalid-');
  const invalidBinding = { ...runtimeBinding(), binding: { ...runtimeBinding().binding, provider: { ...providerBinding, protocol: 'invalid' as never } } };
  let caught: unknown;
  try {
    await openRuntime({ controlRoot, workspace, plan: 'default', sessionId: 'session-invalid-execution', execution: invalidBinding });
  } catch (error) {
    caught = error;
  }
  assert.equal((caught as { code?: string }).code, 'execution-binding-invalid');
  assert.equal((caught as { ownerId?: string }).ownerId, 'execution-runtime');
  assert.equal(typeof (caught as { nextAction?: string }).nextAction, 'string');
  assert.equal((caught as { cause?: unknown }).cause instanceof Error, true);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const store = new SessionStore(paths);
  await assert.rejects(() => store.open('session-invalid-execution'), /session does not exist/);
});

test('app assembly remains DSH-neutral at the source boundary', async () => {
  const source = await readFile(join(process.cwd(), 'packages/app/src/execution.ts'), 'utf8');
  assert.equal(/adapters[\\/]dsh|from ['\"]dsh['\"]|require\\(['\"]dsh['\"]\\)/i.test(source), false);
  assert.equal(/SessionId|SessionEvent/.test(source), false);
});

test('driver composition selects fake or dsh explicitly and never falls back', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-driver-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const fake = composeAgentDriver({
    agent: {
      agentId: 'execution-fake',
      roleId: 'execution',
      templateRef: 'builtin/execution@1.0.0',
      driverRef: 'fake',
      skills: ['single-capability-worker'],
      tools: ['search'],
      permissions: ['task.read', 'workspace.read'],
      memoryScopes: ['task'],
      resourceClass: 'foreground',
    },
    paths,
    runtimeId: 'runtime-fake',
    workspace,
  });
  assert.equal(fake.driver.kind, 'humanagent.fake');
  assert.equal(fake.execution, undefined);

  const dshAgent = {
    agentId: 'execution-dsh',
    roleId: 'execution' as const,
    templateRef: 'builtin/execution@1.0.0',
    driverRef: 'dsh' as const,
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
    memoryScopes: ['task'] as const,
    resourceClass: 'foreground',
  };
  assert.throws(() => composeAgentDriver({ agent: dshAgent, paths, runtimeId: 'runtime-dsh', workspace }), /execution\.dsh is not configured/);
});

test('DSH home must stay below the HumanAgent control root', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-dsh-home-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  assert.equal(resolveDshHome({ paths, configuredHome: '~/.humanagent/dsh/home' }), join(await realpath(controlRoot), 'dsh', 'home'));
  assert.equal(resolveDshHome({ paths, configuredHome: 'dsh/other' }), join(await realpath(controlRoot), 'dsh', 'other'));
  assert.throws(() => resolveDshHome({ paths, configuredHome: join(workspace, 'dsh') }), /must remain below the HumanAgent control root/);
  assert.throws(() => resolveDshHome({ paths, configuredHome: '~/outside-dsh' }), /must remain below the HumanAgent control root/);
});

test('DSH home rejects a symlink escaping the control root', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-dsh-home-link-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const outside = join(root, 'outside-dsh');
  await mkdir(outside);
  await mkdir(join(controlRoot, 'dsh'));
  await symlink(outside, join(controlRoot, 'dsh', 'link'));
  assert.throws(() => resolveDshHome({ paths, configuredHome: 'dsh/link/home' }), /must remain below the HumanAgent control root/);
});

test('DSH settings quote configured provider and model scalars', async () => {
  const { root } = await createConfiguredWorkspace('humanagent-app-dsh-settings-');
  const home = join(root, 'dsh-home');
  await ensureDshSettings(home, {
    sourceRoot: '/locked/dsh',
    home: '~/.humanagent/dsh/home',
    profile: 'sdk',
    provider: 'rcc\n    injected: true',
    model: 'gpt-5.5\n          injected: true',
  });
  const document = await readFile(join(home, 'settings.yaml'), 'utf8');
  assert.match(document, /^    "rcc\\n    injected: true":$/m);
  assert.match(document, /^        - id: "gpt-5\.5\\n          injected: true"$/m);
  assert.equal(document.includes('\n    injected: true'), false);
  assert.equal(document.includes('\n          injected: true'), false);
});

test('DSH driver rejects a sourceRoot that does not match the locked DSH commit', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-dsh-lock-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const agent = {
    agentId: 'execution-dsh',
    roleId: 'execution' as const,
    templateRef: 'builtin/execution@1.0.0',
    driverRef: 'dsh' as const,
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
    memoryScopes: ['task'] as const,
    resourceClass: 'foreground',
  };
  assert.throws(() => composeAgentDriver({
    agent,
    paths,
    dsh: {
      sourceRoot: join(workspace, 'missing-dsh-source'),
      home: '~/.humanagent/dsh/home',
      profile: 'sdk',
      provider: 'rcc',
      model: 'gpt-5.5',
    },
    runtimeId: 'runtime-dsh-lock',
    workspace,
  }), /DSH source is not the locked commit/);
});

test('DSH source lock rejects untracked source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-dsh-source-lock-'));
  execFileSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  await writeFile(join(root, 'tracked.ts'), 'export const tracked = true;\n', 'utf8');
  execFileSync('git', ['add', 'tracked.ts'], { cwd: root, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.name=HumanAgent Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: root, encoding: 'utf8' });
  const lock = {
    source: 'test-fixture',
    reference: 'refs/heads/main',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
    describe: execFileSync('git', ['describe', '--tags', '--always'], { cwd: root, encoding: 'utf8' }).trim(),
    versionTag: 'fixture',
    recordedAt: '2026-09-14T00:00:00.000Z',
  };
  assertDshSourceMatchesLock(root, lock);
  await writeFile(join(root, 'untracked.ts'), 'export const untracked = true;\n', 'utf8');
  assert.throws(() => assertDshSourceMatchesLock(root, lock), /DSH source is not the locked commit/);
});

test('DSH patches are contained, required, and content-addressed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-dsh-patches-'));
  const sourceRoot = join(root, 'source');
  const patchRef = 'apps/cli/src/approved.patch.yml';
  const patchFile = join(sourceRoot, patchRef);
  await mkdir(join(sourceRoot, 'apps/cli/src'), { recursive: true });
  await writeFile(patchFile, '- id: approved\n', 'utf8');
  const approvedDigest = `sha256:${createHash('sha256').update('- id: approved\n').digest('hex')}`;
  const approved = [{ ref: patchRef, digest: approvedDigest }];

  const verified = verifyDshPatches(sourceRoot, [patchRef], approved);
  assert.deepEqual(verified.refs, [patchRef]);
  assert.deepEqual(verified.files, [await realpath(patchFile)]);
  assert.deepEqual(verified.digests, [approvedDigest]);
  assert.throws(() => verifyDshPatches(sourceRoot, [], approved), /patch set must contain exactly/);

  await writeFile(patchFile, '- id: modified\n', 'utf8');
  assert.throws(() => verifyDshPatches(sourceRoot, [patchRef], approved), /content does not match/);

  const outsideRef = '../outside.patch.yml';
  await writeFile(join(root, 'outside.patch.yml'), '- id: outside\n', 'utf8');
  const outsideDigest = `sha256:${createHash('sha256').update('- id: outside\n').digest('hex')}`;
  assert.throws(
    () => verifyDshPatches(sourceRoot, [outsideRef], [{ ref: outsideRef, digest: outsideDigest }]),
    /outside the locked source tree/,
  );
});

test('run creates a HumanAgent task, operation, checkpoint, and run manifest', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-run-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-run',
    plan: 'default',
    prompt: 'inspect the configuration',
  });
  assert.equal(result.taskId.value, 'session-run');
  assert.equal(result.executionEpoch, 1);
  assert.equal(result.checkpoint.outcome, 'succeeded');
  assert.equal(result.receipt.observedKinds.includes('fake.operation'), true);
  assert.equal(result.checkpoint.scope.operationId?.value, result.operationId.value);
  const manifest = await readRunManifest(paths, 'session-run');
  assert.equal(manifest.taskId.value, result.taskId.value);
  assert.equal(manifest.operationId.value, result.operationId.value);
  assert.equal(manifest.driverRef, 'fake');
  const checkpointFile = join(paths.journalRoot, 'checkpoints.jsonl');
  assert.match(await readFile(checkpointFile, 'utf8'), /"outcome":"succeeded"/);
});

test('standalone fake entry shares provider replay output, events, checkpoint evidence, and close with serve fake contract', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-entry-equivalence-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const configuration = await loadConfiguration(paths);
  const sessionId = 'entry-equivalence';
  const runtime = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId });
  const runtimeId = `runtime-${sessionId}`;
  const taskId = id('task', sessionId);
  const operationId = id('operation', `runtime-${runtimeId}-epoch-1`);
  const cycleId = id('cycle', `${sessionId}-cycle-1`);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId,
    plan: 'default',
    prompt: 'same fake replay input',
    composed: {
      driver: new FakeProviderAgentDriver({
        binding: fakeExecutionBinding(),
        runtimeId,
        taskId,
        operationId,
        executionEpoch: 1,
        assignmentId: `${sessionId}-assignment`,
        scope: { organId: id('organ', 'agent-interaction-default'), taskId, cycleId, operationId },
        inputRefs: [`humanagent://session/${sessionId}/input/1`],
        stepDelayMs: 0,
      }),
    },
  });
  assert.deepEqual(result.receipt.observedKinds, [
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.output',
    'provider.terminal',
  ]);
  assert.equal(result.receipt.output.payload.output, 'fake replay: draft output chunk 1fake replay: final output chunk 2');
  assert.equal(result.receipt.providerClose?.state, 'closed');
  assert.equal(result.checkpoint.outcome, 'succeeded');
  assert.equal(result.receipt.providerClose?.evidenceRefs.some((ref) => ref.locator === 'fake/close'), true);
  assert.equal(result.receipt.observedEvents.at(-1)?.kind, 'provider.terminal');
  const inventory = entryCompositionInventory({
    state: 'ready',
    pluginIds: [
      'humanagent.harness-kernel',
      'humanagent.agent-templates',
      'humanagent.fake-provider',
      'humanagent.memory',
      'humanagent.ui',
    ],
    startedPluginIds: [
      'humanagent.harness-kernel',
      'humanagent.agent-templates',
      'humanagent.fake-provider',
      'humanagent.memory',
      'humanagent.ui',
    ],
    capabilities: {
      'harness.kernel': 'humanagent.harness-kernel',
      'agent.templates': 'humanagent.agent-templates',
      'provider.execution': 'humanagent.fake-provider',
      'memory.operations': 'humanagent.memory',
      'memory.context': 'humanagent.memory',
      'ui.projection': 'humanagent.ui',
    },
  }, 'fake');
  assert.equal(inventory.complete, true);
  assert.equal(inventory.components.some((component) => component.component === 'm3-orchestration'), false);
  await settleSessionOutcome(runtime, result.checkpoint.outcome, result.checkpoint.id.value);
});

type EntryScenario = 'success' | 'tool' | 'error' | 'cancel' | 'unknown' | 'close-failure';

interface EntrySemanticEvent {
  readonly kind: string;
  readonly state: string;
  readonly summary?: string;
  readonly terminalPhase?: string;
  readonly terminalState?: string;
  readonly evidenceRefs?: readonly { readonly locator: string }[];
}

interface EntryRunOutput {
  readonly driverRef?: string;
  readonly state?: string;
  readonly outcome?: string;
  readonly semanticEvents?: readonly EntrySemanticEvent[];
  readonly output?: { readonly output?: string };
  readonly providerClose?: { readonly state?: string };
}

interface EntryServeResult {
  readonly driverRef?: string;
  readonly events: readonly EntrySemanticEvent[];
  readonly dashboard: { readonly state: string; readonly output: string };
  readonly finalEvent?: EntrySemanticEvent;
  readonly error?: { readonly code: string; readonly ownerId: string; readonly nextAction: string; readonly message: string };
}

interface EntryScenarioResult {
  readonly run: EntryRunOutput;
  readonly runExit: number;
  readonly serve: EntryServeResult;
}

function isEntryRunOutput(output: EntryRunOutput | { readonly error: { readonly code: string; readonly message: string } }): output is EntryRunOutput {
  return 'outcome' in output;
}

async function runStandaloneEntry(input: {
  readonly cli: string;
  readonly controlRoot: string;
  readonly workspace: string;
  readonly scenario: EntryScenario;
  readonly session: string;
}): Promise<{ readonly exit: number; readonly output: EntryRunOutput | { readonly error: { readonly code: string; readonly message: string } } }> {
  const prompt = `gate18 ${input.scenario} input`;
  try {
    const stdout = execFileSync(process.execPath, [
      input.cli,
      'run',
      '--plan',
      'default',
      '--prompt',
      prompt,
      '--session',
      input.session,
      '--workspace',
      input.workspace,
      '--control-root',
      input.controlRoot,
      '--fake-scenario',
      input.scenario,
      '--fake-step-delay-ms',
      '0',
    ], { encoding: 'utf8', stdio: 'pipe' });
    return { exit: 0, output: JSON.parse(stdout) as EntryRunOutput };
  } catch (error) {
    const failure = error as { readonly status?: number; readonly stdout?: string; readonly stderr?: string };
    if (failure.status !== 1) throw error;
    const output = JSON.parse((failure.stderr ?? '').trim()) as { readonly error: { readonly code: string; readonly message: string } };
    return { exit: failure.status, output };
  }
}

async function runServeEntry(input: {
  readonly cli: string;
  readonly controlRoot: string;
  readonly workspace: string;
  readonly scenario: EntryScenario;
}): Promise<EntryServeResult> {
  const prompt = `gate18 ${input.scenario} input`;

  const serve = spawn(process.execPath, [
    input.cli,
    'serve',
    '--mode',
    'fake',
    '--protocol',
    'responses',
    '--binding',
    'fake-default',
    '--provider',
    'fake-provider',
    '--model',
    'fake.model',
    '--workspace',
    input.workspace,
    '--control-root',
    input.controlRoot,
    '--port',
    '0',
    '--fake-scenario',
    input.scenario,
    '--fake-step-delay-ms',
    '0',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let serveStderr = '';
  serve.stderr.on('data', (chunk: Uint8Array) => {
    serveStderr += String(chunk);
  });
  try {
    const launch = await new Promise<{ readonly url: string; readonly driverRef?: string }>((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`serve startup timed out: ${stdout}; ${serveStderr}`)), 5_000);
      serve.stdout.on('data', (chunk: Uint8Array) => {
        stdout += String(chunk);
        try {
          const parsed = JSON.parse(stdout.trim()) as { readonly url?: string; readonly driverRef?: string };
          if (parsed.url) {
            clearTimeout(timeout);
            resolve({ url: parsed.url, ...(parsed.driverRef === undefined ? {} : { driverRef: parsed.driverRef }) });
          }
        } catch {
          // The CLI prints one JSON object incrementally.
        }
      });
      serve.once('error', reject);
      serve.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`serve exited before startup (${String(code)}): ${stdout}; ${serveStderr}`));
      });
    });

    const created = await fetch(`${launch.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `gate18 ${input.scenario}`, directive: prompt }),
    });
    assert.equal(created.status, 201);
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    const started = await fetch(`${launch.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt }),
    });
    assert.equal(started.status, 202);
    const operation = await started.json() as { readonly operationId: string };

    const events = await readEntryEvents(`${launch.url}/api/executions/${encodeURIComponent(operation.operationId)}/events`);
    const dashboard = await (await fetch(`${launch.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/dashboard`)).json() as {
      readonly state: string;
      readonly output: string;
      readonly error?: { readonly code: string; readonly ownerId: string; readonly nextAction: string; readonly message: string };
    };
    return {
      driverRef: launch.driverRef,
      events,
      dashboard,
      finalEvent: [...events].reverse().find((event) => event.terminalPhase === 'final'),
      ...(dashboard.error === undefined ? {} : { error: dashboard.error }),
    };
  } finally {
    if (serve.exitCode === null && serve.signalCode === null) {
      const exited = new Promise<void>((resolve) => serve.once('exit', resolve));
      serve.kill('SIGTERM');
      await exited;
    }
  }
}

async function readEntryEvents(url: string): Promise<readonly EntrySemanticEvent[]> {
  const response = await fetch(url, { headers: { accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('serve event stream has no body');
  const decoder = new TextDecoder();
  const events: EntrySemanticEvent[] = [];
  let buffer = '';
  const deadline = Date.now() + 5_000;
  try {
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('serve event stream timed out')), Math.max(1, deadline - Date.now()))),
      ]);
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)) as EntrySemanticEvent);
        boundary = buffer.indexOf('\n\n');
      }
      const terminal = events.some((event) => event.terminalPhase === 'final');
      const blocked = events.some((event) => event.kind === 'provider.error' && event.state === 'blocked');
      if (terminal || blocked) return events;
    }
  } finally {
    await reader.cancel();
  }
  throw new Error('serve event stream ended before a terminal or blocked semantic event');
}

async function runEntryScenario(input: {
  readonly cli: string;
  readonly controlRoot: string;
  readonly workspace: string;
  readonly scenario: EntryScenario;
  readonly session: string;
}): Promise<EntryScenarioResult> {
  const standalone = await runStandaloneEntry(input);
  const serve = await runServeEntry(input);
  if (!isEntryRunOutput(standalone.output)) {
    throw new Error(`${input.scenario}: standalone failed before semantic events: ${standalone.output.error.message}`);
  }
  return { run: standalone.output, runExit: standalone.exit, serve };
}

function comparableEvents(events: readonly EntrySemanticEvent[] | undefined): readonly {
  readonly kind: string;
  readonly state: string;
  readonly summary: string | null;
  readonly terminalPhase: string | null;
  readonly terminalState: string | null;
  readonly evidenceRefs: readonly string[];
}[] {
  return (events ?? []).map((event) => ({
    kind: event.kind,
    state: event.state,
    summary: event.kind === 'checkpoint.committed' ? null : event.summary ?? null,
    terminalPhase: event.terminalPhase ?? null,
    terminalState: event.terminalState ?? (event.kind === 'execution.terminal' ? event.state : null),
    // Checkpoint records are owned by their entry's journal. Provider, settle,
    // and close evidence remain part of the semantic comparison.
    evidenceRefs: event.kind === 'checkpoint.committed'
      ? []
      : (event.evidenceRefs ?? []).map((ref) => ref.locator),
  }));
}

const expectedEventKinds: Readonly<Record<Exclude<EntryScenario, 'close-failure'>, readonly string[]>> = {
  success: [
    'execution.started',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.output',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ],
  tool: [
    'execution.started',
    'provider.tool',
    'provider.output',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ],
  error: [
    'execution.started',
    'provider.model',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ],
  cancel: [
    'execution.started',
    'provider.model',
    'provider.output',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ],
  unknown: [
    'execution.started',
    'provider.model',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ],
};

function assertNormalScenario(input: {
  readonly scenario: Exclude<EntryScenario, 'close-failure'>;
  readonly first: EntryScenarioResult;
  readonly second: EntryScenarioResult;
}): void {
  const { scenario, first, second } = input;
  assert.equal(first.runExit, 0, `${scenario}: run exit`);
  assert.equal(first.run.driverRef, 'fake', `${scenario}: run driverRef`);
  assert.equal(first.serve.driverRef, 'fake', `${scenario}: serve driverRef`);
  assert.deepEqual(
    comparableEvents(first.run.semanticEvents),
    comparableEvents(first.serve.events),
    `${scenario}: same-entry semantic event sequence`,
  );
  assert.deepEqual(
    comparableEvents(first.run.semanticEvents).map((event) => event.kind),
    expectedEventKinds[scenario],
    `${scenario}: standalone event order`,
  );
  assert.deepEqual(
    comparableEvents(first.serve.events).map((event) => event.kind),
    expectedEventKinds[scenario],
    `${scenario}: serve event order`,
  );
  assert.deepEqual(
    comparableEvents(second.run.semanticEvents),
    comparableEvents(first.run.semanticEvents),
    `${scenario}: standalone replay determinism`,
  );
  assert.deepEqual(
    comparableEvents(second.serve.events),
    comparableEvents(first.serve.events),
    `${scenario}: serve replay determinism`,
  );
  assert.equal(first.run.outcome, first.serve.dashboard.state, `${scenario}: checkpoint outcome`);
  assert.equal(first.run.semanticEvents?.at(-1)?.terminalState, first.run.outcome, `${scenario}: terminal state`);
  assert.equal(first.run.output?.output, first.serve.dashboard.output, `${scenario}: output`);
  assert.equal(
    first.run.providerClose?.state,
    first.serve.finalEvent?.summary?.includes('provider closed') ? 'closed' : first.serve.finalEvent?.state,
    `${scenario}: provider close`,
  );
  assert.equal(
    first.run.semanticEvents?.at(-1)?.evidenceRefs?.some((ref) => ref.locator === `fake/settle-${first.run.outcome}`),
    true,
    `${scenario}: settle evidence`,
  );
  assert.equal(
    first.run.semanticEvents?.at(-1)?.evidenceRefs?.some((ref) => ref.locator === 'fake/close'),
    true,
    `${scenario}: close evidence`,
  );
  assert.equal(first.serve.error, undefined, `${scenario}: serve must not report a terminal error`);
}

test('actual run and serve fake entries stay equivalent across the execution matrix', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-real-entry-matrix-');
  const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
  const scenarios: readonly Exclude<EntryScenario, 'close-failure'>[] = ['success', 'tool', 'error', 'cancel', 'unknown'];

  for (const scenario of scenarios) {
    const session = `entry-${scenario}`;
    const first = await runEntryScenario({
      cli,
      controlRoot: join(controlRoot, scenario, 'first'),
      workspace,
      scenario,
      session,
    });
    const second = await runEntryScenario({
      cli,
      controlRoot: join(controlRoot, scenario, 'second'),
      workspace,
      scenario,
      session,
    });
    assertNormalScenario({ scenario, first, second });
  }

  const closeFailure = await runStandaloneEntry({
    cli,
    controlRoot: join(controlRoot, 'close-failure', 'first'),
    workspace,
    scenario: 'close-failure',
    session: 'entry-close-failure',
  });
  assert.equal(closeFailure.exit, 1);
  assert.equal(
    'error' in closeFailure.output ? closeFailure.output.error.code : undefined,
    'agent-operation-recovery-required',
  );
  assert.match('error' in closeFailure.output ? closeFailure.output.error.message : '', /provider close is failed/);
  assert.match('error' in closeFailure.output ? closeFailure.output.error.message : '', /provider close failed/);
  const closeFailureServe = await runServeEntry({
    cli,
    controlRoot: join(controlRoot, 'close-failure', 'first'),
    workspace,
    scenario: 'close-failure',
  });
  assert.equal(closeFailureServe.driverRef, 'fake');
  assert.equal(closeFailureServe.dashboard.state, 'blocked');
  assert.equal(closeFailureServe.dashboard.output, 'fake replay: draft output chunk 1fake replay: final output chunk 2');
  assert.equal(closeFailureServe.error?.code, 'provider.close.failed');
  assert.equal(closeFailureServe.error?.ownerId, 'humanagent.fake-provider');
  assert.equal(closeFailureServe.error?.nextAction, 'recover:fake.close');
  assert.equal(
    closeFailureServe.events.some((event) => event.kind === 'execution.terminal' && event.state === 'succeeded' && event.terminalPhase === 'final'),
    false,
  );
  assert.equal(
    closeFailureServe.events.some((event) => event.kind === 'provider.error' && event.state === 'blocked'),
    true,
  );
});

test('real JSONL checkpoint journal deduplicates retries by stable commit identity and rejects conflicts', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-checkpoint-commit-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const filePath = join(paths.journalRoot, 'checkpoint-commit-identity.jsonl');
  const journal = createJsonlCheckpointJournal({ filePath });
  const scope = {
    organId: id('organ', 'checkpoint-commit-organ'),
    taskId: id('task', 'checkpoint-commit-task'),
    cycleId: id('cycle', 'checkpoint-commit-cycle'),
  };
  const recoveryStateRef: EvidenceRef = {
    evidenceId: id('evidence', 'checkpoint-commit-recovery'),
    kind: 'operation',
    source: 'test',
    locator: 'records/recovery',
    scope,
  };
  const checkpoint = {
    id: id('checkpoint', 'checkpoint-commit-1'),
    scope,
    cycleId: scope.cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'succeeded' as const,
    summary: 'stable checkpoint commit',
    recoveryStateRef,
    evidenceRefs: [{
      evidenceId: id('evidence', 'checkpoint-commit-evidence'),
      kind: 'operation' as const,
      source: 'test',
      locator: 'records/evidence',
      scope,
    }],
    next: { kind: 'continue' as const, ref: 'next' },
  };
  const request = {
    ownerId: 'checkpoint-owner',
    commitId: checkpointCommitId(checkpoint),
    checkpoint,
  };

  const first = await journal.append(request);
  const retry = await journal.append(request);
  assert.equal(first.seq, 1);
  assert.deepEqual(retry, first);
  assert.equal((await readFile(filePath, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await new JsonlOrganJournal(filePath).findByCommitId(request.commitId))?.seq, 1);

  await assert.rejects(
    () => journal.append({
      ...request,
      checkpoint: { ...checkpoint, summary: 'different checkpoint fact' },
    }),
    (error: unknown) => error instanceof JournalCommitConflictError,
  );
});

test('run manifest rejects tampered or cross-session identity fields', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-manifest-integrity-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-manifest-integrity',
    plan: 'default',
    prompt: 'inspect the configuration',
  });
  const manifestFile = join(paths.runNotesRoot, 'session-manifest-integrity.manifest.json');
  const original = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, any>;
  const mutations: Array<{ readonly label: string; readonly mutate: (value: Record<string, any>) => void }> = [
    { label: 'session', mutate: (value) => { value.sessionId = 'other-session'; } },
    { label: 'agent', mutate: (value) => { value.agentId = ''; } },
    { label: 'driver', mutate: (value) => { value.driverRef = 'remote'; } },
    { label: 'runtime', mutate: (value) => { value.runtimeId = ''; } },
    { label: 'task', mutate: (value) => { value.taskId.value = 'other-task'; } },
    { label: 'operation', mutate: (value) => { value.operationId.value = 'runtime-other-epoch-1'; } },
    { label: 'epoch', mutate: (value) => { value.executionEpoch = 2; } },
    { label: 'revision', mutate: (value) => { value.directiveRevision = 0; } },
    { label: 'cycle', mutate: (value) => { value.cycleId.value = 'other-cycle'; } },
    { label: 'scope organ', mutate: (value) => { value.scope.organId.value = ''; } },
    { label: 'scope task', mutate: (value) => { value.scope.taskId.value = 'other-task'; } },
  ];
  for (const mutation of mutations) {
    const tampered = structuredClone(original);
    mutation.mutate(tampered);
    await writeFile(manifestFile, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    await assert.rejects(() => readRunManifest(paths, 'session-manifest-integrity'), /run manifest/);
  }
});

test('run manifest accepts explicit HumanAgent identities without deriving them from the session', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-manifest-explicit-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const taskId = id('task', 'external-task');
  const operationId = id('operation', 'external-operation');
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-manifest-explicit',
    plan: 'default',
    prompt: 'inspect the configuration',
    runtimeId: 'runtime-explicit',
    taskId,
    operationId,
  });
  const manifest = await readRunManifest(paths, 'session-manifest-explicit');
  assert.equal(manifest.runtimeId, 'runtime-explicit');
  assert.deepEqual(manifest.taskId, taskId);
  assert.deepEqual(manifest.operationId, operationId);
  assert.equal(result.taskId.value, taskId.value);
  assert.equal(result.operationId.value, operationId.value);
});

test('resume reads the HumanAgent checkpoint and either resumes or waits explicitly', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-op-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-op',
    plan: 'default',
    prompt: 'inspect the configuration',
  });
  const manifest = await readRunManifest(paths, 'session-resume-op');
  const resumed = await resumeAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-op',
    plan: 'default',
    prompt: 'continue inspection',
    taskId: manifest.taskId,
    cycleId: manifest.cycleId,
    scope: manifest.scope,
    executionEpoch: manifest.executionEpoch,
    directiveRevision: manifest.directiveRevision,
    agentId: manifest.agentId,
    driverRef: manifest.driverRef,
  });
  assert.equal(resumed.recovered?.checkpoint.id.value, result.checkpoint.id.value);
  // A succeeded checkpoint is already terminal, so recovery reports waiting
  // instead of fabricating a new DSH session.
  assert.equal(resumed.execution, undefined);
  assert.match(resumed.waitingReason ?? '', /terminal: succeeded/);
});

test('resume rejects a session whose manifest driver no longer matches configuration', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-driver-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-driver',
    plan: 'default',
    prompt: 'inspect the configuration',
    composed: { driver: new FakeAgentDriver({ 'session-resume-driver-assignment': 'failed' }) },
  });
  const manifest = await readRunManifest(paths, 'session-resume-driver');
  await assert.rejects(
    () => resumeAgentOperation({
      paths,
      configuration,
      workspace,
      sessionId: 'session-resume-driver',
      plan: 'default',
      prompt: 'continue inspection',
      taskId: manifest.taskId,
      cycleId: manifest.cycleId,
      scope: manifest.scope,
      executionEpoch: manifest.executionEpoch,
      directiveRevision: manifest.directiveRevision,
      agentId: manifest.agentId,
      driverRef: manifest.driverRef === 'fake' ? 'dsh' : 'fake',
    }),
    /run manifest requires driver dsh/,
  );
  assert.equal(result.checkpoint.outcome, 'failed');
});

test('resume with no HumanAgent checkpoint returns a nullable recovery result', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-missing-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const resumed = await resumeAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-missing',
    plan: 'default',
    prompt: 'continue',
    taskId: id('task', 'missing-task'),
    cycleId: id('cycle', 'missing-cycle'),
    scope: { organId: id('organ', 'missing-organ'), taskId: id('task', 'missing-task'), operationId: id('operation', 'missing-operation') },
    executionEpoch: 1,
    directiveRevision: 1,
    agentId: 'execution-fake',
    driverRef: 'fake',
  });
  assert.equal(resumed.recovered, null);
  assert.match(resumed.waitingReason ?? '', /no checkpoint exists/);
});

test('app stop writes a stopped checkpoint only after real settle evidence', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stop-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const controller = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stop',
    plan: 'default',
    prompt: 'stop after submit',
    composed: { driver: new FakeAgentDriver({ 'session-stop-assignment': 'stopped' }) },
  });
  await controller.start();
  await controller.submit();
  const stopped = await controller.stop();
  if (stopped.state !== 'stopped') {
    throw new Error(`expected a stopped control result, received ${stopped.state}`);
  }
  assert.equal(stopped.checkpoint.outcome, 'stopped');
  assert.equal(stopped.closure.state, 'stopped');
  assert.equal(stopped.checkpoint.scope.operationId?.value, controller.snapshot().operationId.value);
  const manifest = await readRunManifest(paths, 'session-stop');
  assert.equal(manifest.operationId.value, controller.snapshot().operationId.value);
  const checkpointFile = join(paths.journalRoot, 'checkpoints.jsonl');
  assert.match(await readFile(checkpointFile, 'utf8'), /"outcome":"stopped"/);
  let completionError: unknown;
  try {
    await controller.complete();
  } catch (error) {
    completionError = error;
  }
  assert.match((completionError as Error | undefined)?.message ?? '', /agent operation was stopped/);
});

test('standalone app stop closes a close-capable provider exactly once', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stop-close-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const driver = new StopCloseDriver(false, { 'session-stop-close-assignment': 'stopped' });
  const controller = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stop-close',
    plan: 'default',
    prompt: 'stop with provider close',
    composed: { driver },
  });
  await controller.start();
  await controller.submit();

  const stopped = await controller.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(driver.closeCalls, 1);
  assert.equal((await controller.closeExecution())?.state, 'closed');
  assert.equal(driver.closeCalls, 1);
});

test('standalone app stop preserves explicit provider close failure after stopped checkpoint commit', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stop-close-failure-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const driver = new StopCloseDriver(true, { 'session-stop-close-failure-assignment': 'stopped' });
  const controller = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stop-close-failure',
    plan: 'default',
    prompt: 'stop with provider close failure',
    composed: { driver },
  });
  await controller.start();
  await controller.submit();

  await assert.rejects(
    () => controller.stop(),
    (error: unknown) => error instanceof AppLifecycleError
      && error.code === 'provider-close-failed'
      && error.cause instanceof Error
      && error.cause.message === 'provider stop close failed',
  );
  assert.equal(driver.closeCalls, 1);
  assert.equal(controller.snapshot().state, 'stopped');
  assert.match(await readFile(join(paths.journalRoot, 'checkpoints.jsonl'), 'utf8'), /"outcome":"stopped"/);
});

test('standalone app stop closes the provider when manifest persistence fails after stopped checkpoint commit', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stop-manifest-failure-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const driver = new StopCloseDriver(false, { 'session-stop-manifest-failure-assignment': 'stopped' });
  const controller = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stop-manifest-failure',
    plan: 'default',
    prompt: 'stop with manifest failure',
    composed: { driver },
  });
  await controller.start();
  await controller.submit();
  await rm(paths.runNotesRoot, { recursive: true, force: true });
  await writeFile(paths.runNotesRoot, 'manifest path is blocked', 'utf8');

  await assert.rejects(
    () => controller.stop(),
    (error: unknown) => (error as { code?: string }).code === 'EEXIST',
  );
  assert.equal(driver.closeCalls, 1);
  assert.equal(controller.snapshot().state, 'stopped');
  assert.match(await readFile(join(paths.journalRoot, 'checkpoints.jsonl'), 'utf8'), /"outcome":"stopped"/);
});

test('standalone app stop preserves manifest and provider close failures after stopped checkpoint commit', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stop-finalization-failure-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const driver = new StopCloseDriver(true, { 'session-stop-finalization-failure-assignment': 'stopped' });
  const controller = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stop-finalization-failure',
    plan: 'default',
    prompt: 'stop with manifest and provider close failure',
    composed: { driver },
  });
  await controller.start();
  await controller.submit();
  await rm(paths.runNotesRoot, { recursive: true, force: true });
  await writeFile(paths.runNotesRoot, 'manifest path is blocked', 'utf8');

  await assert.rejects(
    () => controller.stop(),
    (error: unknown) => error instanceof AppLifecycleError
      && error.code === 'agent-operation-stop-finalization-failed'
      && error.cause instanceof AggregateError
      && error.cause.errors.length === 2
      && /manifest=EEXIST/.test(error.message)
      && /provider close=provider close failed/.test(error.message),
  );
  assert.equal(driver.closeCalls, 1);
  assert.equal(controller.snapshot().state, 'stopped');
  assert.match(await readFile(join(paths.journalRoot, 'checkpoints.jsonl'), 'utf8'), /"outcome":"stopped"/);
});

test('app stop does not commit stopped when settle fails', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stop-settle-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const controller = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stop-failed',
    plan: 'default',
    prompt: 'fail during settle',
    composed: { driver: new FakeAgentDriver({ 'session-stop-failed-assignment': 'failed' }) },
  });
  await controller.start();
  await controller.submit();
  const result = await controller.stop();
  assert.equal(result.state, 'settling');
  const checkpointFile = join(paths.journalRoot, 'checkpoints.jsonl');
  const content = await readFile(checkpointFile, 'utf8').catch(() => '');
  assert.equal(content.includes('"outcome":"stopped"'), false);
});

test('provider execution errors still settle then retain successful close evidence', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-provider-error-close-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const configuration = await loadConfiguration(paths);
  const driver = new ObserveErrorCloseDriver(false);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-provider-error-close',
    plan: 'default',
    prompt: 'provider observe failure',
    composed: { driver },
  });
  assert.equal(driver.closeCalls, 1);
  assert.equal(result.checkpoint.outcome, 'failed');
  assert.equal(result.receipt.providerClose?.state, 'closed');
  assert.match(result.checkpoint.evidenceRefs[0]?.locator ?? '', /provider%20observe%20failed/);
});

test('provider close failure remains explicit recovery-required after preserving execution failure', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-provider-close-failure-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const configuration = await loadConfiguration(paths);
  const driver = new ObserveErrorCloseDriver(true);
  await assert.rejects(
    () => runAgentOperation({
      paths,
      configuration,
      workspace,
      sessionId: 'session-provider-close-failure',
      plan: 'default',
      prompt: 'provider observe failure',
      composed: { driver },
    }),
    (error: unknown) => error instanceof AppLifecycleError
      && error.code === 'agent-operation-recovery-required'
      && (error.cause as { readonly originalError?: unknown } | undefined)?.originalError instanceof Error
      && ((error.cause as { readonly originalError: Error }).originalError).message === 'provider observe failed'
      && (error.cause as { readonly closeFailure?: unknown } | undefined)?.closeFailure instanceof AppLifecycleError
      && ((error.cause as { readonly closeFailure: AppLifecycleError }).closeFailure).code === 'provider-close-failed',
  );
  assert.equal(driver.closeCalls, 1);
  const checkpointFile = join(paths.journalRoot, 'checkpoints.jsonl');
  assert.match(await readFile(checkpointFile, 'utf8'), /provider%20observe%20failed/);
});

test('resume from a failed checkpoint starts a new HumanAgent epoch', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-epoch-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const first = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-epoch',
    plan: 'default',
    prompt: 'fail once',
    composed: { driver: new FakeAgentDriver({ 'session-resume-epoch-assignment': 'failed' }) },
  });
  assert.equal(first.checkpoint.outcome, 'failed');
  const manifest = await readRunManifest(paths, 'session-resume-epoch');
  const recovered = await resumeAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-epoch',
    plan: 'default',
    prompt: 'continue after failure',
    taskId: manifest.taskId,
    cycleId: manifest.cycleId,
    scope: manifest.scope,
    executionEpoch: manifest.executionEpoch,
    directiveRevision: manifest.directiveRevision,
    agentId: manifest.agentId,
    driverRef: manifest.driverRef,
  });
  assert.equal(recovered.recovered?.checkpoint.id.value, first.checkpoint.id.value);
  assert.equal(recovered.execution?.executionEpoch, 2);
  assert.equal(recovered.execution?.checkpoint.outcome, 'succeeded');
  assert.equal(recovered.reentry?.state, 'committed');
  assert.equal(recovered.reentry?.record.closureKind, 'reentry');
  assert.equal(recovered.reentry?.record.checkpointId.value, first.checkpoint.id.value);
  assert.equal(recovered.reentry?.record.previousExecutionEpoch, 1);
  assert.equal(recovered.reentry?.record.newExecutionEpoch, 2);

  const closurePort = createJsonlCheckpointClosurePort({
    filePath: join(paths.journalRoot, 'checkpoints.jsonl'),
  });
  const reentry = await closurePort.read(recovered.reentry!.record.closureId);
  assert.deepEqual(reentry, recovered.reentry?.record);
});

test('resume rejects recovery when the committed closure has a hard blocker', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-blocked-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const sessionId = 'session-resume-blocked';
  const taskId = id('task', sessionId);
  const cycleId = id('cycle', `${sessionId}-cycle-1`);
  const operationId = id('operation', `runtime-runtime-${sessionId}-epoch-1`);
  const scope = {
    organId: id('organ', 'agent-interaction-default'),
    taskId,
    cycleId,
    operationId,
  };
  const journal = createJsonlCheckpointJournal({
    filePath: join(paths.journalRoot, 'checkpoints.jsonl'),
  });
  const closurePort = createJsonlCheckpointClosurePort({
    filePath: join(paths.journalRoot, 'checkpoints.jsonl'),
  });
  const recoveryStateRef: EvidenceRef = {
    evidenceId: id('evidence', `recovery-${sessionId}-1`),
    kind: 'operation',
    source: 'test',
    locator: `humanagent://session/${sessionId}/epoch/1`,
    scope,
  };
  const checkpoint = {
    id: id('checkpoint', `${sessionId}-1-1`),
    scope,
    cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'blocked' as const,
    summary: 'permission revoked',
    recoveryStateRef,
    evidenceRefs: [recoveryStateRef],
    next: { kind: 'recover' as const, ref: recoveryStateRef.locator },
  };
  await submitCheckpoint({
    source: 'harness-control',
    ownerId: 'test',
    checkpoint,
    previous: null,
    journal,
    closurePort,
    permissionRevoked: true,
  });

  await assert.rejects(
    () => resumeAgentOperation({
      paths,
      configuration,
      workspace,
      sessionId,
      plan: 'default',
      prompt: 'must not resume revoked work',
      taskId,
      cycleId,
      scope,
      executionEpoch: 1,
      directiveRevision: 1,
      agentId: 'interaction-default',
      driverRef: 'fake',
    }),
    (error: unknown) => error instanceof Error
      && error.name === 'CheckpointSubmissionError'
      && /reentry admission denied/.test(error.message),
  );
  assert.equal(await closurePort.read(`reentry:${sessionId}:1:2`), null);
});

test('resume rejects recovery for an unknown checkpoint without committing reentry', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-unknown-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const sessionId = 'session-resume-unknown';
  const taskId = id('task', sessionId);
  const cycleId = id('cycle', `${sessionId}-cycle-1`);
  const operationId = id('operation', `runtime-runtime-${sessionId}-epoch-1`);
  const scope = {
    organId: id('organ', 'agent-interaction-default'),
    taskId,
    cycleId,
    operationId,
  };
  const journal = createJsonlCheckpointJournal({
    filePath: join(paths.journalRoot, 'checkpoints.jsonl'),
  });
  const closurePort = createJsonlCheckpointClosurePort({
    filePath: join(paths.journalRoot, 'checkpoints.jsonl'),
  });
  const recoveryStateRef: EvidenceRef = {
    evidenceId: id('evidence', `recovery-${sessionId}-1`),
    kind: 'operation',
    source: 'test',
    locator: `humanagent://session/${sessionId}/epoch/1`,
    scope,
  };
  const checkpoint = {
    id: id('checkpoint', `${sessionId}-1-1`),
    scope,
    cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'unknown' as const,
    summary: 'side effect reconciliation required',
    recoveryStateRef,
    evidenceRefs: [recoveryStateRef],
    next: { kind: 'recover' as const, ref: recoveryStateRef.locator },
  };
  await submitCheckpoint({
    source: 'harness-control',
    ownerId: 'test',
    checkpoint,
    previous: null,
    journal,
    closurePort,
    unknownOperations: [operationId],
  });

  await assert.rejects(
    () => resumeAgentOperation({
      paths,
      configuration,
      workspace,
      sessionId,
      plan: 'default',
      prompt: 'must not resume unreconciled work',
      taskId,
      cycleId,
      scope,
      executionEpoch: 1,
      directiveRevision: 1,
      agentId: 'interaction-default',
      driverRef: 'fake',
    }),
    (error: unknown) => error instanceof Error
      && error.name === 'CheckpointSubmissionError'
      && /reentry admission denied/.test(error.message),
  );
  assert.equal(await closurePort.read(`reentry:${sessionId}:1:2`), null);
});

test('CLI resume closes the session with the checkpoint from the recovered execution', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-cli-resume-state-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const sessionId = 'session-cli-resume-state';
  const runtime = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId });
  await new SessionStore(paths).append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
  await runtime.lock.release();
  const first = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId,
    plan: 'default',
    prompt: 'fail once',
    composed: { driver: new FakeAgentDriver({ [`${sessionId}-assignment`]: 'failed' }) },
  });
  assert.equal(first.checkpoint.outcome, 'failed');

  const resumed = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'),
    'resume',
    '--workspace',
    workspace,
    '--control-root',
    controlRoot,
    '--session',
    sessionId,
    '--prompt',
    'continue after failure',
  ], { encoding: 'utf8', stdio: 'pipe' })) as {
    readonly state: string;
    readonly checkpointId: string;
    readonly recoveredCheckpointId: string;
    readonly resumedOutcome: string;
  };
  assert.equal(resumed.state, 'stopped');
  assert.equal(resumed.resumedOutcome, 'succeeded');
  assert.equal(resumed.recoveredCheckpointId, first.checkpoint.id.value);

  const session = await new SessionStore(paths).open(sessionId);
  assert.equal(session.state, 'stopped');
  assert.equal(session.records.at(-1)?.type, 'session.closed');
  assert.equal(session.records.at(-1)?.checkpointRef, resumed.checkpointId);
});

test('CLI resume publishes exactly one durable rewind after actual checkpoint reentry', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-cli-resume-memory-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await writeFile(join(workspace, 'AGENTS.md'), '# HumanAgent test project\n', 'utf8');
  const configuration = await loadConfiguration(paths);
  const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
  await mkdir(auditPromptRoot, { recursive: true });
  await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# Memory audit\n', 'utf8');
  const sessionId = 'session-cli-resume-memory';
  const runtime = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId });
  await new SessionStore(paths).append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
  await runtime.lock.release();
  const failed = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId,
    plan: 'default',
    prompt: 'fail before rewind',
    composed: { driver: new FakeAgentDriver({ [`${sessionId}-assignment`]: 'failed' }) },
  });
  assert.equal(failed.checkpoint.outcome, 'failed');

  const resumed = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'),
    'resume',
    '--workspace',
    workspace,
    '--control-root',
    controlRoot,
    '--session',
    sessionId,
    '--prompt',
    'continue after rewind',
    '--memory',
    'memory-cli-resume',
  ], { encoding: 'utf8', stdio: 'pipe' })) as {
    readonly state: string;
    readonly checkpointId: string;
    readonly recoveredCheckpointId: string;
    readonly resumedOutcome: string;
    readonly rewindMemoryAnalysis: number;
  };
  assert.equal(resumed.state, 'stopped');
  assert.equal(resumed.resumedOutcome, 'succeeded');
  assert.equal(resumed.recoveredCheckpointId, failed.checkpoint.id.value);
  assert.equal(resumed.rewindMemoryAnalysis, 1);

  const journal = createJsonlEventJournal({ filePath: join(paths.journalRoot, 'events.jsonl') });
  const events = await journal.readEvents({
    streamId: `memory-boundaries:${sessionId}`,
    afterSequence: 0,
    limit: 10,
  });
  assert.equal(events.length, 1);
  assert.equal((events[0]?.payload as { readonly trigger?: string } | undefined)?.trigger, 'rewind');
  assert.equal(events[0]?.evidenceRefs.length, 3);
  assert.equal(events[0]?.evidenceRefs[0]?.locator, `humanagent://checkpoint/${resumed.checkpointId}`);
  assert.equal(events[0]?.evidenceRefs[1]?.locator, `humanagent://checkpoint/${failed.checkpoint.id.value}`);
  assert.match(events[0]?.evidenceRefs[2]?.locator ?? '', /^humanagent:\/\/checkpoint-closure\/reentry:/);
  const analysisInputs = (events[0]?.payload as {
    readonly analysisInputs?: {
      readonly rewindChains?: readonly {
        readonly failedBranchRef: string;
        readonly rewindCheckpointRef: string;
        readonly recoveryCheckpointRef: string;
        readonly reentryFactRef?: string;
        readonly successfulBranchRefs: readonly string[];
        readonly successEvidenceRefs: readonly string[];
        readonly absoluteJournalRefs: readonly string[];
      }[];
    };
  } | undefined)?.analysisInputs;
  assert.equal(analysisInputs?.rewindChains?.length, 1);
  const chain = analysisInputs?.rewindChains?.[0];
  assert.equal(chain?.failedBranchRef, `humanagent://checkpoint/${failed.checkpoint.id.value}`);
  assert.equal(chain?.rewindCheckpointRef, `humanagent://checkpoint/${failed.checkpoint.id.value}`);
  assert.equal(chain?.recoveryCheckpointRef, `humanagent://checkpoint/${resumed.checkpointId}`);
  assert.equal(chain?.reentryFactRef, events[0]?.evidenceRefs[2]?.locator);
  assert.deepEqual(chain?.successfulBranchRefs, [`humanagent://checkpoint/${resumed.checkpointId}`]);
  assert.equal((chain?.successEvidenceRefs.length ?? 0) > 0, true);
  assert.deepEqual(chain?.absoluteJournalRefs, [
    `humanagent://checkpoint/${failed.checkpoint.id.value}`,
    `humanagent://checkpoint/${resumed.checkpointId}`,
    events[0]?.evidenceRefs[2]?.locator,
  ]);
  assert.equal((await journal.readCursor({
    streamId: `memory-boundaries:${sessionId}`,
    consumerKey: 'memory-cli-resume',
  }))?.lastHandledSequence, 1);
});

test('CLI memory driver factory selects the configured memory-role agent and drives start submit observe settle', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-driver-factory-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await appendFile(join(controlRoot, 'config.toml'), [
    '',
    '[[agents]]',
    'agentId = "memory-default"',
    'roleId = "memory"',
    'templateRef = "builtin/memory@1.0.0"',
    'driverRef = "fake"',
    'skills = ["history-search", "novelty-review", "recurrence-review"]',
    'tools = ["memory.search", "memory.ask", "task.history", "session.history"]',
    'permissions = ["memory.read", "memory.propose"]',
    'memoryScopes = ["task", "organ", "approved-global"]',
    'resourceClass = "background"',
    '',
  ].join('\n'), 'utf8');
  const configuration = await loadConfiguration(paths);
  const factory = memoryDriverFactory({ paths, configuration, workspace });
  assert.ok(factory, 'a configured memory-role agent must yield a driver factory');

  const driver = factory!({
    taskId: id('task', 'memory-driver-factory-task'),
    operationId: id('operation', 'memory-driver-factory-operation'),
    executionEpoch: 3,
    assignmentId: 'memory-analysis:memory-driver-factory-operation',
  });
  const events: string[] = [];
  const wrapped: typeof driver = {
    ...driver,
    start: async (request) => {
      events.push('start');
      return await driver.start(request);
    },
    submit: async (request) => {
      events.push('submit');
      return await driver.submit(request);
    },
    observe: (request) => (async function* () {
      events.push('observe');
      yield* driver.observe(request);
    })(),
    settle: async (request) => {
      events.push('settle');
      return await driver.settle(request);
    },
  };
  const taskId = id('task', 'memory-driver-factory-task');
  await wrapped.start({
    runtimeId: 'memory-analysis:memory-driver-factory-operation',
    taskId,
    executionEpoch: 3,
    assignmentId: 'memory-analysis:memory-driver-factory-operation',
    organId: id('organ', 'memory-driver-factory-organ'),
    operationId: id('operation', 'memory-driver-factory-operation'),
  });
  await wrapped.submit({
    taskId,
    executionEpoch: 3,
    assignmentId: 'memory-analysis:memory-driver-factory-operation',
    payload: { prompt: 'audit' },
  });
  for await (const _event of wrapped.observe({ runtimeId: 'memory-analysis:memory-driver-factory-operation' })) {
    // Drain the observation stream so the driver reaches its terminal event.
  }
  await wrapped.settle({ runtimeId: 'memory-analysis:memory-driver-factory-operation', executionEpoch: 3 });
  assert.deepEqual(events, ['start', 'submit', 'observe', 'settle']);
  await rm(root, { recursive: true, force: true });
});

test('memory driver factory stays absent when no memory-role agent is configured', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-driver-absent-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  assert.equal(memoryDriverFactory({ paths, configuration, workspace }), undefined);
  await rm(root, { recursive: true, force: true });
});

test('memory composition connects an injected memory driver to checkpoint analysis', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-memory-composition-driver-');
  await writeFile(join(workspace, 'AGENTS.md'), '# Composition project\n', 'utf8');
  const runtime = await openRuntime({
    controlRoot,
    workspace,
    plan: 'default',
    sessionId: 'session-memory-composition-driver',
  });
  const { paths, configuration } = runtime;
  const taskId = id('task', 'session-memory-composition-driver');
  const driver = new MemoryAnalysisDriver();
  const memory = await composeMemoryRuntime({
    paths,
    configuration,
    workspaceCwd: paths.workspaceCwd,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    auditPromptRoot: join(paths.controlRoot, 'memory-audit'),
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driverFor: ({ assignmentId }) => {
      assert.match(assignmentId, /^memory-analysis:/);
      return driver;
    },
    binding: {
      bindingRef: 'memory-binding:composition-driver',
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey: paths.projectKey,
        organId: id('organ', `agent-${configuration.effective.project?.defaultAgent ?? configuration.agentRoster[0]!.agentId}`),
        taskId,
      },
      taskId,
      mainAgentId: 'composition-driver-main',
      actor: {
        actorId: 'memory-agent',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
    },
  });
  try {
    await mkdir(join(paths.controlRoot, 'memory-audit'), { recursive: true });
    await writeFile(join(paths.controlRoot, 'memory-audit', 'project-memory-audit.md'), '# Audit\n', 'utf8');
    await new SessionStore(paths).append(
      'session-memory-composition-driver',
      { type: 'session.state', state: 'running' },
      runtime.lock,
    );
    const result = await runAgentOperation({
      paths,
      configuration,
      workspace,
      sessionId: 'session-memory-composition-driver',
      plan: 'default',
      prompt: 'complete composition analysis',
      memoryBoundaryPublisher: memory.publisher,
    });
    const consumed = await memory.consume();
    assert.equal(consumed.committed.length, 1);
    assert.equal(consumed.committed[0]?.disposition, 'applied');
    assert.deepEqual(driver.events.map((event) => event.split(':')[0]), [
      'start',
      'submit',
      'observe',
      'settle',
    ]);
    const feedback = await memory.journal.readEvents({
      streamId: `memory-feedback:${taskId.value}`,
      afterSequence: 0,
      limit: 10,
    });
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0]?.kind, 'memory.candidate.review-required');
    assert.equal(typeof feedback[0]?.payload?.analysisRef, 'string');
    assert.equal(typeof feedback[0]?.payload?.candidateId, 'string');
    assert.equal('operationId' in (feedback[0]?.payload ?? {}), false);
    assert.equal('nextAction' in (feedback[0]?.payload ?? {}), false);
    await settleSessionOutcome(runtime, result.checkpoint.outcome, result.checkpoint.id.value);
  } finally {
    try {
      await runtime.lock.release();
    } catch {
      // The successful settlement path already released the session lock.
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('session outcome settlement commits failed checkpoints without marking them recoverable', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-cli-run-failed-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const sessionId = 'session-cli-run-failed';
  const runtime = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId });
  await new SessionStore(paths).append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
  const state = await settleSessionOutcome(runtime, 'failed', 'checkpoint:failed');
  assert.equal(state, 'failed');
  await runtime.lock.release();

  const session = await new SessionStore(paths).open(sessionId);
  assert.equal(session.state, 'failed');
  assert.equal(session.records.at(-1)?.type, 'session.failed');
  assert.equal(session.records.at(-1)?.checkpointRef, 'checkpoint:failed');
});

test('runtime crash preserves original error in a failed checkpoint and resumes in a new epoch', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-crash-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const driver = new CountingCrashSubmitDriver();
  const first = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-crash-epoch',
    plan: 'default',
    prompt: 'crash during execution',
    composed: { driver },
  });
  assert.equal(first.checkpoint.outcome, 'failed');
  assert.match(first.checkpoint.evidenceRefs[0]?.locator ?? '', /DSH%20runtime%20exited/);
  assert.equal(first.semanticEvents.some((event) => event.kind === 'execution.started'), false);
  assert.equal(driver.settleCalls >= 1, true);
  const manifest = await readRunManifest(paths, 'session-crash-epoch');
  const recovered = await resumeAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-crash-epoch',
    plan: 'default',
    prompt: 'continue after crash',
    taskId: manifest.taskId,
    cycleId: manifest.cycleId,
    scope: manifest.scope,
    executionEpoch: manifest.executionEpoch,
    directiveRevision: manifest.directiveRevision,
    agentId: manifest.agentId,
    driverRef: manifest.driverRef,
  });
  assert.equal(recovered.recovered?.checkpoint.id.value, first.checkpoint.id.value);
  assert.equal(recovered.execution?.executionEpoch, 2);
  assert.equal(recovered.execution?.checkpoint.outcome, 'succeeded');
});

test('prompt rejection is committed as a failed checkpoint', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-prompt-rejected-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-prompt-rejected',
    plan: 'default',
    prompt: 'rejected by provider',
    composed: { driver: new RejectPromptDriver() },
  });
  assert.equal(result.checkpoint.outcome, 'failed');
  assert.match(result.checkpoint.evidenceRefs[0]?.locator ?? '', /prompt-rejected/);
});

test('start failure commits a failed checkpoint without fabricating execution.started', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-start-failure-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-start-failure',
    plan: 'default',
    prompt: 'fail during start',
    composed: { driver: new CrashStartDriver() },
  });
  assert.equal(result.checkpoint.outcome, 'failed');
  assert.equal(result.semanticEvents.some((event) => event.kind === 'execution.started'), false);
  assert.deepEqual(result.semanticEvents.map((event) => event.kind), [
    'provider.error',
    'checkpoint.committed',
    'execution.terminal',
  ]);
});

test('DSH-shaped plain agent events retain model output tool error and terminal semantics', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-plain-agent-events-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-plain-agent-events',
    plan: 'default',
    prompt: 'emit plain DSH-shaped events',
    composed: { driver: new PlainAgentEventDriver() },
  });
  assert.deepEqual(result.receipt.observedKinds, ['model', 'output', 'tool', 'error', 'terminal']);
  assert.deepEqual(result.semanticEvents.map((event) => event.kind), [
    'execution.started',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.error',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ]);
  assert.deepEqual(
    result.semanticEvents.slice(1, 5).map((event) => event.summary),
    ['DSH model event', 'DSH output event', 'DSH tool event', 'DSH provider error'],
  );
  assert.equal(result.semanticEvents[5]?.terminalPhase, 'provider');
  assert.equal(result.semanticEvents[5]?.state, 'succeeded');
  assert.equal(result.semanticEvents.at(-1)?.terminalPhase, 'final');
  assert.equal(result.semanticEvents.at(-1)?.terminalState, 'succeeded');
});

test('session lifecycle is persisted below control root and keeps agent cwd separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const created = await store.create({ sessionId: 'session-1', plan: 'default' });
  assert.equal(created.state, 'created');
  assert.equal(created.path.startsWith(paths.controlRoot), true);
  assert.equal(paths.agentCwd, paths.controlRoot);
  const ready = await store.append('session-1', { type: 'session.state', state: 'ready' });
  assert.equal(ready.state, 'ready');
  const closed = await store.close('session-1', 'checkpoint:1');
  assert.equal(closed.state, 'stopped');
  assert.equal((await store.open('session-1')).state, 'stopped');
});

test('session writes are lock-bound and serialized per session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-session-write-lock-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const lock = await store.acquire('session-write-lock');
  await store.create({ sessionId: 'session-write-lock', plan: 'default' }, lock);
  const [ready, running] = await Promise.all([
    store.append('session-write-lock', { type: 'session.state', state: 'ready' }, lock),
    store.append('session-write-lock', { type: 'session.state', state: 'running' }, lock),
  ]);
  assert.equal(ready.records.length, 2);
  assert.equal(running.records.length, 3);
  assert.deepEqual(running.records.map((record) => record.seq), [1, 2, 3]);
  const contender = new SessionStore(paths);
  await assert.rejects(() => contender.append('session-write-lock', { type: 'session.state', state: 'stopping' }), /already owned/);
  await lock.release();
});

test('incomplete trailing session line is visible and never treated as a committed record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-tail-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-tail', plan: 'default' });
  await appendFile(join(paths.sessionsRoot, 'session-tail.jsonl'), '{"schemaVersion":1,"sessionId":"session-tail"', 'utf8');
  const opened = await store.open('session-tail');
  assert.equal(opened.recoverableTail, true);
  assert.equal(opened.state, 'created');
  assert.equal(opened.records.length, 1);
});

test('appending after a recoverable tail truncates only the uncommitted tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-recover-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-recover', plan: 'default' });
  await appendFile(join(paths.sessionsRoot, 'session-recover.jsonl'), '{"uncommitted":', 'utf8');
  const recovered = await store.append('session-recover', { type: 'session.state', state: 'ready' });
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.recoverableTail, false);
  assert.equal(recovered.records.length, 2);
});

test('a complete final JSON record without a newline is committed and preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-no-newline-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-no-newline', plan: 'default' });
  const sessionPath = join(paths.sessionsRoot, 'session-no-newline.jsonl');
  const content = await readFile(sessionPath, 'utf8');
  await writeFile(sessionPath, content.slice(0, -1), 'utf8');
  const opened = await store.open('session-no-newline');
  assert.equal(opened.recoverableTail, false);
  assert.equal(opened.records.length, 1);
  const ready = await store.append('session-no-newline', { type: 'session.state', state: 'ready' });
  assert.equal(ready.records.length, 2);
  assert.equal((await store.open('session-no-newline')).records.length, 2);
});

test('session path never uses workspace persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-path-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  assert.equal(paths.sessionsRoot.startsWith(paths.controlRoot), true);
  assert.equal(paths.sessionsRoot.startsWith(workspace), false);
});

test('session lock is atomic and remains below control root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-lock-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const lock = await store.acquire('session-lock');
  assert.equal(lock.path.startsWith(paths.controlRoot), true);
  await assert.rejects(() => store.acquire('session-lock'), /already owned/);
  await lock.release();
  const second = await store.acquire('session-lock');
  await second.release();
});

test('session lock rejects path traversal ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-lock-id-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await assert.rejects(() => store.acquire('../escape'), /invalid session id/);
});

test('closeRuntime releases its lock after the stopped record is committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-close-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const handle = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId: 'session-close' });
  const closed = await closeRuntime(handle, 'checkpoint:close');
  assert.equal(closed.state, 'stopped');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const store = new SessionStore(paths);
  const lock = await store.acquire('session-close');
  await lock.release();
});

test('resumeRuntime reopens an existing non-terminal session without creating a second session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-resume-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const handle = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId: 'session-resume' });
  await handle.lock.release();
  const resumed = await resumeRuntime({ controlRoot, workspace, sessionId: 'session-resume' });
  assert.equal(resumed.session.state, 'ready');
  await resumed.lock.release();
});

test('session open rejects semantically invalid committed history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-corrupt-history-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-corrupt-history', plan: 'default' });
  const path = join(paths.sessionsRoot, 'session-corrupt-history.jsonl');
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...record, state: 'bogus' }) + '\n', 'utf8');
  await assert.rejects(() => store.open('session-corrupt-history'), /session record is missing required fields/);
});

test('session history must begin with a created record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-first-record-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);

  await store.create({ sessionId: 'session-first-state', plan: 'default' });
  const firstStatePath = join(paths.sessionsRoot, 'session-first-state.jsonl');
  const firstState = JSON.parse(await readFile(firstStatePath, 'utf8')) as Record<string, unknown>;
  await writeFile(firstStatePath, JSON.stringify({ ...firstState, type: 'session.state', state: 'ready' }) + '\n', 'utf8');
  await assert.rejects(() => store.open('session-first-state'), /must begin with session.created/);

  await store.create({ sessionId: 'session-first-failed', plan: 'default' });
  const firstFailedPath = join(paths.sessionsRoot, 'session-first-failed.jsonl');
  const firstFailed = JSON.parse(await readFile(firstFailedPath, 'utf8')) as Record<string, unknown>;
  await writeFile(firstFailedPath, JSON.stringify({ ...firstFailed, type: 'session.failed', state: 'failed' }) + '\n', 'utf8');
  await assert.rejects(() => store.open('session-first-failed'), /must begin with session.created/);
});

test('session append enforces lifecycle transitions and terminal record types', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-transition-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-transition', plan: 'default' });
  await assert.rejects(() => store.append('session-transition', { type: 'session.state', state: 'stopped' }), /terminal state requires/);
  await assert.rejects(() => store.append('session-transition', { type: 'session.state', state: 'running' }), /invalid session transition/);
  await assert.rejects(() => store.append('session-transition', { type: 'session.closed', state: 'ready' }), /must commit stopped/);
  await assert.rejects(() => store.append('session-transition', { type: 'session.closed', state: 'stopped' }), /cannot close session/);
  const ready = await store.append('session-transition', { type: 'session.state', state: 'ready' });
  assert.equal(ready.state, 'ready');
});

test('an old lock handle cannot remove a replacement owner lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-lock-owner-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const first = await store.acquire('session-replaced');
  await rm(first.path, { recursive: true, force: true });
  const second = await store.acquire('session-replaced');
  await assert.rejects(() => first.release(), /owned by another runtime/);
  await second.release();
});
