import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderSettlement,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderSubmitResult,
  type ScopeRef,
  type Task,
  type TaskIdentityAppendInput,
  type TaskIdentityRecord,
  type WorkAssignment,
  type WorkResult,
} from '../../packages/contracts/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import type { AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import { fakeExecutionBinding } from '../../packages/app/src/fake-execution.js';
import { createDeterministicServeOrchestrationPorts, createRccServeOrchestrationPorts } from '../../packages/app/src/serve-orchestration.js';
import { createServeRuntimeComposition } from '../../packages/app/src/serve-runtime.js';
import { FakeReplayExecutionRuntimePort, startUiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { TASK_EXECUTION_ACTION_ID, TASK_EXECUTION_CAPABILITY } from '../../packages/app/src/ui-runtime/task-control.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import type { CheckpointJournalPort } from '../../packages/runtime/src/checkpoints/ports.js';
import type { ReviewAssignment } from '../../packages/runtime/src/review/index.js';
import type { ReviewResult } from '../../packages/runtime/src/review/index.js';
import { AgentRuntimePoolManager, resolveReviewMaterial } from '../../packages/runtime/src/orchestration/index.js';
import { TaskIdentityConsumer, type TaskIdentityPort } from '../../packages/runtime/src/orchestration/task-identity.js';
import type { ExecutionAgentPort, TaskExecutionHandle } from '../../packages/runtime/src/orchestration/index.js';

/** Produced subject body used by the fixture assignments in this file. */
const serveArtifactBody = 'serve fixture artifact body';
import type {
  EventBusPorts,
  EventPublisherRegistryPort,
  TrustedEventPublisher,
} from '../../packages/runtime/src/events/index.js';

const unusedExplicitBrainInterpreter = {
  async interpret(): Promise<never> {
    throw new Error('explicit brain interpretation is not used in serve orchestration tests');
  },
};

async function accessControlFor(root: string): Promise<AccessControlService> {
  return AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
}

function taskControlPathFor(root: string): string {
  return join(root, 'checkpoints', 'fake', 'task-control.jsonl');
}

// The real admission owner rejects execution without a current TaskGrant. This
// fixture commits the real identity first and only then grants exactly the
// returned Task scope to the actual product principal owner, over the same
// physical control Organ Journal. A failed identity append writes no grant.
class GrantPreparingIdentityJournal implements TaskIdentityPort {
  constructor(
    private readonly inner: TaskIdentityPort,
    private readonly grants: JsonlTaskGrantJournal,
    private readonly principalOwner: string,
  ) {}

  async append(input: TaskIdentityAppendInput): Promise<TaskIdentityRecord> {
    const record = await this.inner.append(input);
    const existing = await this.grants.readTaskGrant(record.scope.taskId);
    if (existing.grant === null) {
      await this.grants.grant({
        requestId: `serve-fixture-grant:${record.scope.taskId.value}`,
        taskId: record.scope.taskId,
        owner: this.principalOwner,
        capability: {
          actionId: TASK_EXECUTION_ACTION_ID,
          capabilities: [TASK_EXECUTION_CAPABILITY],
          scope: { organId: record.scope.organId, taskId: record.scope.taskId },
        },
        expectedRevision: 0,
      });
    }
    return record;
  }

  replay(scope?: ScopeRef): Promise<readonly TaskIdentityRecord[]> {
    return this.inner.replay(scope);
  }
}

function identityWithFixtureGrant(principalOwner: string, taskControlPath: string): TaskIdentityConsumer {
  return new TaskIdentityConsumer(new GrantPreparingIdentityJournal(
    new JsonlTaskIdentityJournal(new JsonlOrganJournal(taskControlPath)),
    new JsonlTaskGrantJournal(new JsonlOrganJournal(taskControlPath)),
    principalOwner,
  ));
}

async function eventBusPorts(): Promise<{ readonly ports: EventBusPorts; readonly close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-serve-runtime-'));
  const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
  const publisher: TrustedEventPublisher = {
    publisherId: 'serve-test',
    kind: 'harness',
    ownerId: 'humanagent.serve.test',
    scope: { organId: id('organ', 'humanagent-ui') },
    allowedClasses: ['control', 'data', 'observation'],
    capabilities: ['event.publish.control'],
  };
  const publishers: EventPublisherRegistryPort = {
    async resolvePublisher(publisherId) {
      return publisherId === publisher.publisherId ? publisher : null;
    },
  };
  return {
    ports: {
      journal,
      publishers,
      consumers: { async resolveConsumer() { return null; } },
      externalOperations: journal,
      barrierIntents: journal,
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

async function waitForTaskState(read: () => string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(read(), expected);
}

async function waitForRuntimeTask(runtime: Awaited<ReturnType<typeof startUiRuntime>>): Promise<Task['id']> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const tasks = runtime.service.listTasks();
    const rows = [...tasks.running, ...tasks.waiting, ...tasks.completed, ...tasks.failed, ...tasks.draft];
    for (const row of rows) {
      if (row.requirementAdmission === 'queued') continue;
      try {
        runtime.service.taskDashboard(row.taskId);
        return row.taskId;
      } catch {
        // Queued rows now resolve through the dashboard; still keep looking for
        // the real coordinator task created by FIFO dispatch.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('runtime did not consume the confirmed requirement');
}

function assignment(task: Task, overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  const criteria = {
    objective: 'exercise the live serve orchestration boundary',
    successCriteria: ['worker result is accepted'],
    failureCriteria: ['worker result fails'],
    incompleteCriteria: ['worker result is incomplete'],
  };
  return {
    assignmentId: 'serve-assignment',
    taskId: task.id,
    pipelineNodeId: 'serve-stage',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: criteria.objective,
    targetRefs: ['serve-target'],
    expectedOutputRefs: ['serve-output'],
    successCriteria: [...criteria.successCriteria],
    failureCriteria: [...criteria.failureCriteria],
    incompleteCriteria: [...criteria.incompleteCriteria],
    requiredCapabilities: ['execute'],
    mergeGate: 'required',
    ...overrides,
  };
}

/** Review material for a fixture assignment, derived from its subject body. */
function materialFor(
  workerAssignment: WorkAssignment,
  workerResult: WorkResult,
  body = serveArtifactBody,
) {
  return resolveReviewMaterial({
    workerAssignment,
    workerResult,
    subjects: workerAssignment.targetRefs.map((ref) => ({ ref, body })),
  });
}

/**
 * Runs the deterministic fixture worker through the same real pool acquisition
 * the orchestration manager uses, so the worker result carries the actual
 * lease and incarnation of this fixture instead of a hand-written literal.
 */
async function runDeterministicWorker(input: {
  readonly workerPorts: ReturnType<typeof createDeterministicServeOrchestrationPorts>;
  readonly workAssignment: WorkAssignment;
  readonly task: Task;
  readonly scope: ScopeRef;
  readonly agentId: string;
}): Promise<WorkResult> {
  const worker = input.workerPorts.executionAgent!;
  const pool = new AgentRuntimePoolManager({
    maxRuntimes: 1,
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
    ownerId: 'serve-test',
  });
  try {
    const acquired = await pool.acquire({
      requiredCapabilities: input.workAssignment.requiredCapabilities,
      ownerId: 'serve-test',
      executionEpoch: input.workAssignment.executionEpoch,
      taskId: input.task.id,
      roleId: worker.roleId,
      agentId: input.agentId,
      assignment: input.workAssignment,
      creator: (create) => worker.createInstance(create),
      scope: input.scope,
    });
    if (acquired.status !== 'acquired') throw new Error(`runtime lease unavailable: ${acquired.issue.reason}`);
    try {
      const delivery = await acquired.handle.execute({
        assignment: input.workAssignment,
        agentId: input.agentId,
        executionEpoch: acquired.lease.executionEpoch,
        attempt: input.workAssignment.attempt,
        lease: acquired.lease,
        scope: input.scope,
      });
      return 'result' in delivery ? delivery.result : delivery;
    } finally {
      await pool.release(acquired.lease, { scope: input.scope });
    }
  } finally {
    await pool.dispose();
  }
}

function providerBinding(): ProviderBinding {
  return {
    bindingId: 'serve-rcc-binding',
    providerId: 'rcc',
    protocol: 'responses',
    endpointRef: 'rcc-v3:test',
    modelRef: 'test-model',
    configDigest: 'sha256:serve-rcc-config',
    capabilityDigest: 'sha256:serve-rcc-capability',
  };
}

function providerPort(input: {
  readonly state: ProviderSettlement['state'];
  readonly reviewMarker?: string;
  readonly reviewMarkers?: readonly string[];
  readonly reviewMarkerSequence?: readonly (string | undefined)[];
  readonly outputRef?: string;
  readonly chunkedReviewText?: readonly string[];
  readonly organId?: ReturnType<typeof id<'organ'>>;
  readonly submittedPrompts?: string[];
}): ExecutionRuntimePort {
  const binding = providerBinding();
  // A real provider reports the scope it was admitted under. Hardcoding a
  // foreign organ here would make the fixture produce evidence the task-scoped
  // feedback event can never contain.
  const providerOrgan = () => input.organId ?? id('organ', 'humanagent-ui');
  const evidence = (scope: ScopeRef) => ({
    evidenceId: id('evidence', `serve-rcc-${scope.operationId?.value ?? 'operation'}`),
    kind: 'operation' as const,
    source: 'test.serve-rcc-orchestration',
    locator: 'serve-rcc/provider',
    digest: 'sha256:serve-rcc-output',
    scope,
  });
  let active: { readonly runtimeId: string; readonly taskId: ReturnType<typeof id<'task'>>; readonly operationId: ReturnType<typeof id<'operation'>>; readonly executionEpoch: number; readonly scope: ScopeRef } | undefined;
  let observeCount = 0;
  const readiness: ProviderReadiness = {
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    protocol: binding.protocol,
    state: 'ready',
    capabilityDigest: binding.capabilityDigest,
    checkedAt: '2026-09-20T00:00:00.000Z',
    expiresAt: '2099-09-20T00:00:00.000Z',
    evidenceRefs: [evidence({ organId: providerOrgan() })],
  };
  return {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => readiness,
    capabilities: async (): Promise<ProviderCapabilities> => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      capabilities: ['responses'],
      version: 'test',
      digest: binding.capabilityDigest,
      checkedAt: readiness.checkedAt,
      expiresAt: readiness.expiresAt,
      evidenceRefs: readiness.evidenceRefs,
    }),
    start: async (request): Promise<ProviderStartReceipt> => {
      // The driver admits the execution with the task's full scope (organ,
      // task, cycle, operation). A real provider reports that same admitted
      // scope, so the fixture must echo it rather than rebuild a partial one.
      const admittedScope = request.evidenceRefs[0]?.scope ?? {
        organId: request.organId ?? providerOrgan(),
        taskId: request.taskId,
        operationId: request.operationId,
      };
      active = {
        runtimeId: request.runtimeId,
        taskId: request.taskId,
        operationId: request.operationId,
        executionEpoch: request.executionEpoch,
        scope: admittedScope,
      };
      const prompt = request.payload?.prompt;
      if (prompt !== undefined && typeof prompt === 'string') input.submittedPrompts?.push(prompt);
      return { ...request, startedAt: readiness.checkedAt, evidenceRefs: [evidence(active.scope)] };
    },
    resume: async (): Promise<ProviderRecoveryResult> => { throw new Error('not used'); },
    submit: async (request): Promise<ProviderSubmitResult> => ({
      ...request,
      status: 'accepted',
      outputRefs: [],
      evidenceRefs: active ? [evidence(active.scope)] : [],
    }),
    observe: async function* (): AsyncIterable<ProviderEvent> {
      if (!active) throw new Error('missing active provider execution');
      const sequenceMarker = input.reviewMarkerSequence?.[observeCount];
      observeCount += 1;
      // A reviewer reply split across SSE chunks arrives as several output
      // events; the review parser must reconstruct the whole reply from them.
      if (input.chunkedReviewText) {
        let index = 0;
        for (const chunk of input.chunkedReviewText) {
          yield {
            ...active,
            eventId: `output-chunk-${index}-${active.runtimeId}`,
            kind: 'output',
            summary: chunk,
            outputRefs: [input.outputRef ?? 'provider://output'],
            evidenceRefs: [evidence(active.scope)],
          };
          index += 1;
        }
        yield {
          ...active,
          eventId: `terminal-${active.runtimeId}`,
          kind: 'terminal',
          terminalState: input.state,
          evidenceRefs: [evidence(active.scope)],
        };
        return;
      }
      const reviewMarkers = sequenceMarker !== undefined
        ? [sequenceMarker]
        : input.reviewMarkers ?? (input.reviewMarker === undefined ? [] : [input.reviewMarker]);
      yield {
        ...active,
        eventId: `output-${active.runtimeId}`,
        kind: 'output',
        summary: reviewMarkers[0] ?? 'provider output',
        outputRefs: [input.outputRef ?? 'provider://output'],
        evidenceRefs: [evidence(active.scope)],
      };
      yield {
        ...active,
        eventId: `terminal-${active.runtimeId}`,
        kind: 'terminal',
        terminalState: input.state,
        summary: reviewMarkers[1] ?? reviewMarkers[0] ?? `provider ${input.state}`,
        evidenceRefs: [evidence(active.scope)],
      };
    },
    requestStop: async (request): Promise<ProviderStopReceipt> => ({
      ...request,
      status: 'accepted',
      receivedAt: readiness.checkedAt,
      evidenceRefs: active ? [evidence(active.scope)] : [],
    }),
    settle: async (request): Promise<ProviderSettlement> => ({
      ...request,
      state: input.state,
      evidenceRefs: active ? [evidence(active.scope)] : [],
      resourceRelease: { state: 'released', evidenceRefs: active ? [evidence(active.scope)] : [] },
      persistence: { state: 'committed', evidenceRefs: active ? [evidence(active.scope)] : [] },
    }),
    close: async (): Promise<ProviderCloseResult> => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'closed',
      evidenceRefs: readiness.evidenceRefs,
    }),
  };
}

test('serve runtime composes and closes a task-scoped M3 dispatch', async () => {
  const eventBus = await eventBusPorts();
  const composition = createServeRuntimeComposition({
    eventBusPorts: eventBus.ports,
    feedbackPorts: {
      journal: eventBus.ports.journal,
      publishers: eventBus.ports.publishers,
    },
    feedbackPublisherId: 'serve-test',
    ...createDeterministicServeOrchestrationPorts(),
  });
  const task: Task = {
    id: id('task', 'serve-composition-task'),
    organId: id('organ', 'humanagent-ui'),
    title: 'serve composition',
    directive: 'compose the live harness owners',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = {
    organId: task.organId,
    taskId: task.id,
    cycleId: id('cycle', 'serve-composition-cycle'),
  };
  const assembly = composition.createTaskAssembly({
    task,
    scope,
    checkpointJournal: {} as CheckpointJournalPort,
  });

  assembly.orchestration.planStage({ nodeId: 'serve-stage', taskId: task.id });
  const dispatched = await assembly.orchestration.dispatch({
    stageNodeId: 'serve-stage',
    assignment: assignment(task),
    agentId: 'serve-worker',
    scope,
    reviewKinds: ['quality'],
    reviewSubjects: [{ ref: 'serve-target', body: serveArtifactBody }],
  });

  assert.equal(composition.ownerId, 'humanagent.app.serve-runtime');
  assert.ok(composition.nodeRuntime.strategies.refs().length > 0);
  assert.equal(assembly.task.id.value, task.id.value);
  assert.equal(assembly.scope.taskId?.value, task.id.value);
  assert.equal(dispatched.status, 'merged');
  assert.equal(dispatched.assignment.status, 'merged');
  const feedback = await eventBus.ports.journal.readEvents({
    streamId: `task:${task.id.value}`,
    afterSequence: 0,
    limit: 20,
  });
  assert.deepEqual(feedback.map((event) => event.class), ['data', 'data', 'control']);
  assert.ok(feedback.every((event) => event.publisherId === 'serve-test'));

  await composition.dispose();
  await eventBus.close();
});

test('confirmed requirement enters task orchestration with RCC review before provider settlement', async () => {
  const eventBus = await eventBusPorts();
  const root = await mkdtemp(join(tmpdir(), 'humanagent-serve-requirement-'));
  const binding = providerBinding();
  const deterministicPorts = createDeterministicServeOrchestrationPorts();
  // The deterministic fixture execution agent returns refs and digests but no
  // produced body, which would make the review gate fail closed on an empty
  // subject. Give it a real body derived from the same target refs it reports.
  const fixtureWorker = deterministicPorts.executionAgent!;
  const fixtureBody = 'serve orchestration fixture artifact body';
  const decorateWorkerDelivery = (
    input: Parameters<ExecutionAgentPort['execute']>[0],
    delivery: Awaited<ReturnType<ExecutionAgentPort['execute']>>,
  ): WorkResult => {
    const result = 'result' in delivery ? delivery.result : delivery;
    return {
      ...result,
      // One artifact: the ref and body describe the same produced text.
      producedArtifactBodies: input.assignment.targetRefs.map(() => fixtureBody),
      // The composed provider fixture reports its own organ; the feedback
      // event scope is the task's, so evidence must be re-scoped to it.
      evidenceRefs: result.evidenceRefs.map((ref) => ({ ...ref, scope: { ...input.scope } })),
      // Evidence must sit inside the feedback event's admitted scope.
    };
  };
  const executionAgent: ExecutionAgentPort = {
    roleId: fixtureWorker.roleId,
    createInstance(create) {
      const handle = fixtureWorker.createInstance(create);
      return {
        incarnation: handle.incarnation,
        async execute(input) {
          return decorateWorkerDelivery(input, await handle.execute(input));
        },
        async dispose() {
          await handle.dispose();
        },
        ...(handle.release === undefined ? {} : {
          async release(input: Parameters<NonNullable<TaskExecutionHandle['release']>>[0]) {
            await handle.release!(input);
          },
        }),
      };
    },
    async execute(input) {
      return decorateWorkerDelivery(input, await fixtureWorker.execute(input));
    },
  };
  const rccPorts = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded', reviewMarker: 'HUMANAGENT_REVIEW: passed' }),
    binding,
    promptSegments: { review: ['review system prompt'] },
  });
  const runtimeComposition = createServeRuntimeComposition({
    eventBusPorts: eventBus.ports,
    feedbackPorts: {
      journal: eventBus.ports.journal,
      publishers: eventBus.ports.publishers,
    },
    feedbackPublisherId: 'serve-test',
    executionAgent,
    reviewAgent: rccPorts.reviewAgent,
    mergeCoordinator: rccPorts.mergeCoordinator,
  });
  const accessControl = await accessControlFor(root);
  const taskIdentity = identityWithFixtureGrant(
    accessControl.readProductPrincipalOwner(),
    taskControlPathFor(root),
  );
  const runtime = await startUiRuntime({
    mode: 'fake',
    accessControl,
    productRoot: root,
    organId: id('organ', 'humanagent-ui'),
    binding,
    port: providerPort({ state: 'succeeded', reviewMarker: 'HUMANAGENT_REVIEW: passed' }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    portNumber: 0,
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'serve-requirement-project',
    },
    taskIdentity,
    runtimeComposition,
  });
  try {
    const interactionId = await runtime.service.receiveExplicitInput({
      sourceRef: 'ui:task-detail',
      rawInput: 'run the confirmed orchestration path',
      channel: 'business',
      requestKind: 'new-task-create',
    });
    await runtime.service.beginExplicitMatching(interactionId);
    await runtime.service.recordExplicitMatch(interactionId, {
      normalizedInput: 'run the confirmed orchestration path',
      matchedTasks: [],
      knownFacts: [],
    });
    await runtime.service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'create',
      proposal: 'create a task for the orchestration path',
    });
    const proposed = await runtime.service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await runtime.service.confirmExplicitRequirement({
      interactionId,
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:serve-orchestration',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-20T00:00:00.000Z',
      payloadRef: 'asset://requirements/serve-orchestration',
      requestKind: 'new-task-create',
    });

    const taskId = await waitForRuntimeTask(runtime);
    let graph: ReturnType<ReturnType<typeof runtime.service.taskAssembly>['orchestration']['graph']['snapshot']>;
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (runtime.service.taskDashboard(taskId).state === 'succeeded') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      graph = runtime.service.taskAssembly(taskId).orchestration.graph.snapshot();
      assert.equal(runtime.service.taskDashboard(taskId).state, 'succeeded');
    } catch (error) {
      const original = error instanceof Error ? error : new Error(String(error));
      try {
        // D1: observe the first public-visible failure before the fixture
        // directory is removed. The original error and its stack are preserved;
        // every diagnostic read is isolated so a failed read never masks it.
        const diagnostics: string[] = [];
        const issue = runtime.service.implicitSchedulingIssue();
        diagnostics.push(`implicitSchedulingIssue: ${issue === undefined ? 'none' : JSON.stringify({ code: issue.code, ownerId: issue.ownerId, message: issue.message, nextAction: issue.nextAction })}`);
        const list = runtime.service.listTasks();
        const buckets = { running: list.running, waiting: list.waiting, completed: list.completed, stopped: list.stopped, draft: list.draft, failed: list.failed };
        for (const [bucket, rows] of Object.entries(buckets)) {
          for (const row of rows) diagnostics.push(`listTasks.${bucket}: taskId=${row.taskId.value} state=${row.state} requirementAdmission=${row.requirementAdmission ?? 'none'} nextStep=${row.nextStep}`);
        }
        try {
          const dashboard = runtime.service.taskDashboard(taskId);
          diagnostics.push(`taskDashboard(${taskId.value}): state=${dashboard.state} currentNode=${dashboard.currentNode} nextStep=${dashboard.nextStep} error=${dashboard.error === undefined ? 'none' : JSON.stringify(dashboard.error)}`);
        } catch (dashboardError) {
          diagnostics.push(`taskDashboard(${taskId.value}) failed: ${String(dashboardError)}`);
        }
        try {
          const observation = runtime.service.observation(taskId, undefined, `task://${taskId.value}/observation/pipeline.execute`);
          diagnostics.push(`observation(${taskId.value}): state=${observation.state} scope=${observation.scope.scopeRef}`);
          for (const node of observation.nodes) diagnostics.push(`  observation.node: nodeId=${node.nodeId} kind=${node.kindDisplay} state=${node.stateDisplay} summary=${node.summary} activity=${node.activity.map((entry) => entry.summary).join(' | ')}`);
          for (const node of observation.scope.nodes) diagnostics.push(`  observation.scopeNode: nodeId=${node.nodeId} kind=${node.kindDisplay} state=${node.stateDisplay} summary=${node.summary} evidenceCount=${node.evidenceCount}`);
        } catch (observationError) {
          diagnostics.push(`observation(${taskId.value}) failed: ${String(observationError)}`);
        }
        original.message = `${original.message}\n--- D1 first-error diagnostics ---\n${diagnostics.join('\n')}`;
      } catch (diagnosticError) {
        original.message = `${original.message}\n--- D1 diagnostics failed: ${String(diagnosticError)}`;
      }
      throw original;
    }
    assert.equal(graph.stages.length, 1);
    assert.equal(graph.assignments.length, 1);
    assert.equal(graph.assignments[0]?.status, 'merged', JSON.stringify(graph.assignments[0]));
    const feedback = await eventBus.ports.journal.readEvents({
      streamId: `task:${taskId.value}`,
      afterSequence: 0,
      limit: 20,
    });
    assert.deepEqual(feedback.map((event) => event.class), ['data', 'data', 'control']);
  } finally {
    await runtime.server.close();
    await runtimeComposition.dispose();
    await eventBus.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('confirmed requirement preserves non-success provider closures through orchestration', async () => {
  for (const terminalState of ['waiting', 'blocked', 'failed'] as const) {
    const eventBus = await eventBusPorts();
    const root = await mkdtemp(join(tmpdir(), `humanagent-serve-requirement-${terminalState}-`));
    const binding = fakeExecutionBinding({ bindingId: `serve-requirement-${terminalState}` });
    const runtimeComposition = createServeRuntimeComposition({
      eventBusPorts: eventBus.ports,
      feedbackPorts: {
        journal: eventBus.ports.journal,
        publishers: eventBus.ports.publishers,
      },
      feedbackPublisherId: 'serve-test',
      ...createDeterministicServeOrchestrationPorts(),
    });
    const runtime = await startUiRuntime({
      mode: 'fake',
      accessControl: await accessControlFor(root),
      productRoot: root,
      organId: id('organ', 'humanagent-ui'),
      binding,
      port: new FakeReplayExecutionRuntimePort({
        binding,
        stepDelayMs: 1,
        replay: [{ kind: 'terminal', state: terminalState, summary: `fake replay: execution ${terminalState}`, terminalState }],
      }),
      checkpointRoot: join(root, 'checkpoints'),
      evidenceRoot: join(root, 'evidence'),
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      portNumber: 0,
      explicitBrainInterpreter: unusedExplicitBrainInterpreter,
      memory: {
        coordinator: new MemoryCoordinator(),
        backend: new DeterministicMemoryBackend(),
        projectKey: `serve-requirement-${terminalState}`,
      },
      runtimeComposition,
    });
    try {
      const interactionId = await runtime.service.receiveExplicitInput({
        sourceRef: 'ui:task-detail',
        rawInput: `run the ${terminalState} orchestration path`,
        channel: 'business',
      });
      await runtime.service.beginExplicitMatching(interactionId);
      await runtime.service.recordExplicitMatch(interactionId, {
        normalizedInput: `run the ${terminalState} orchestration path`,
        matchedTasks: [],
        knownFacts: [],
      });
      await runtime.service.proposeExplicitRequirement(interactionId, {
        proposedIntent: 'create',
        proposal: `create a ${terminalState} orchestration task`,
      });
      const proposed = await runtime.service.inspectExplicitInteraction(interactionId);
      assert.ok(proposed.draft);
      await runtime.service.confirmExplicitRequirement({
        draftId: proposed.draft!.draftId,
        inputRevision: 1,
        confirmationRef: `confirmation:serve-orchestration-${terminalState}`,
        confirmedBy: 'human:operator',
        confirmedAt: '2026-09-20T00:00:00.000Z',
        payloadRef: `asset://requirements/serve-orchestration-${terminalState}`,
      });

      const taskId = await waitForRuntimeTask(runtime);
      await waitForTaskState(() => runtime.service.taskDashboard(taskId).state, terminalState);
      const dashboard = runtime.service.taskDashboard(taskId);
      assert.equal(dashboard.checkpoint?.outcome, terminalState);
      assert.equal(runtime.service.taskAssembly(taskId).orchestration.graph.snapshot().assignments[0]?.status, terminalState === 'blocked' ? 'blocked' : 'escalated');
    } finally {
      await runtime.server.close();
      await runtimeComposition.dispose();
      await eventBus.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('same-task execution epochs commit epoch-scoped checkpoint ids', async () => {
  const eventBus = await eventBusPorts();
  const root = await mkdtemp(join(tmpdir(), 'humanagent-serve-epoch-checkpoint-'));
  const binding = fakeExecutionBinding({ bindingId: 'serve-epoch-checkpoint' });
  const runtimeComposition = createServeRuntimeComposition({
    eventBusPorts: eventBus.ports,
    feedbackPorts: {
      journal: eventBus.ports.journal,
      publishers: eventBus.ports.publishers,
    },
    feedbackPublisherId: 'serve-test',
    ...createDeterministicServeOrchestrationPorts(),
  });
  const runtime = await startUiRuntime({
    mode: 'fake',
    accessControl: await accessControlFor(root),
    productRoot: root,
    organId: id('organ', 'humanagent-ui'),
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    portNumber: 0,
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'serve-epoch-checkpoint',
    },
    runtimeComposition,
  });
  try {
    const task = runtime.service.createTask({ title: 'epoch checkpoint identity' });
    runtime.service.startExecution(task.taskId, { prompt: 'first epoch' });
    await waitForTaskState(() => runtime.service.taskDashboard(task.taskId).state, 'succeeded');
    const firstDashboard = runtime.service.taskDashboard(task.taskId);
    const first = firstDashboard.checkpoint;
    if (!first) throw new Error('epoch 1 checkpoint missing');

    runtime.service.startExecution(task.taskId, { prompt: 'second epoch' });
    await waitForTaskState(() => runtime.service.taskDashboard(task.taskId).state, 'succeeded');
    const secondDashboard = runtime.service.taskDashboard(task.taskId);
    const second = secondDashboard.checkpoint;
    if (!second) throw new Error('epoch 2 checkpoint missing');
    assert.ok(second.checkpointId !== first.checkpointId, 'epoch 2 checkpoint reuses epoch 1 checkpoint id');
    assert.match(second.checkpointId, /^checkpoint-.+-2-1$/, `epoch 2 checkpoint id should include epoch: ${second.checkpointId}`);
    assert.equal(secondDashboard.executionEpoch, 2);
    assert.equal(second.seq, 1);
  } finally {
    await runtime.server.close();
    await runtimeComposition.dispose();
    await eventBus.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('RCC orchestration ports provide review and merge agents for the live execution owner', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-agent-task'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC agent roles',
    directive: 'exercise provider-backed agent roles',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = {
    organId: task.organId,
    taskId: task.id,
    cycleId: id('cycle', 'serve-rcc-agent-cycle'),
  };
  let borrowedCloseCount = 0;
  const borrowedPort = providerPort({ state: 'succeeded', reviewMarker: 'HUMANAGENT_REVIEW: passed', outputRef: 'serve-rcc-output' });
  const ports = createRccServeOrchestrationPorts({
    port: {
      ...borrowedPort,
      async close(binding) {
        borrowedCloseCount += 1;
        return borrowedPort.close(binding);
      },
    },
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
  });
  const workerPorts = createDeterministicServeOrchestrationPorts();
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-worker',
    pipelineNodeId: 'serve-rcc-stage',
    targetRefs: ['serve-rcc-output'],
    expectedOutputRefs: ['serve-rcc-output'],
  };
  const worker = await runDeterministicWorker({
    workerPorts,
    workAssignment,
    task,
    scope,
    agentId: 'serve-rcc-execution-agent',
  });
  assert.equal(worker.status, 'succeeded');
  assert.equal(worker.agentId, 'serve-rcc-execution-agent');
  assert.deepEqual(worker.outputRefs, ['serve-rcc-output']);

  const reviewAssignment: ReviewAssignment = {
    assignmentId: 'serve-rcc-review',
    taskId: task.id.value,
    workerAgentId: 'serve-rcc-execution-agent',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    subjectRefs: ['serve-rcc-output'],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  const review = await ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment: workAssignment,
    workerResult: worker,
    reviewMaterial: materialFor(workAssignment, worker),
    scope,
  });
  assert.equal(review.status, 'passed');
  assert.equal(review.reviewKind, 'quality');
  assert.ok(review.evidenceRefs.length > 0);
  assert.equal(borrowedCloseCount, 0);
  const merged = await ports.mergeCoordinator.merge({
    workerAssignment: workAssignment,
    workerResult: worker,
    reviewAssignments: [reviewAssignment],
    reviewResults: [review],
    ownerId: 'serve-test',
    scope,
  });
  assert.equal(merged.status, 'merged');
  assert.ok(merged.evidenceRefs.length > 0);
});

test('RCC review agent stays inconclusive when the model exhausts retries without a review marker', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-review-omission'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC review omission',
    directive: 'keep an omitted review marker visible',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-review-cycle') };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded' }),
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
  });
  const workerPorts = createDeterministicServeOrchestrationPorts();
  const workAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-omission-worker',
  };
  const worker = await runDeterministicWorker({
    workerPorts,
    workAssignment,
    task,
    scope,
    agentId: 'serve-rcc-execution-agent',
  });
  const review = await ports.reviewAgent.review({
    reviewAssignment: {
      assignmentId: 'serve-rcc-omission-review',
      taskId: task.id.value,
      workerAgentId: 'serve-rcc-execution-agent',
      reviewKind: 'quality',
      attempt: 1,
      executionEpoch: 1,
      inputRevision: 1,
      subjectRefs: ['serve-output'],
      workerCapabilities: ['provider.execution'],
      requiredCapabilities: ['quality.review'],
      mergeGate: 'required',
    },
    workerAssignment: workAssignment,
    workerResult: worker,
    reviewMaterial: materialFor(workAssignment, worker),
    scope,
  });
  assert.equal(review.status, 'inconclusive');
  assert.equal(review.findings.length, 1);
  assert.match(review.findings[0]!.expected, /bounded recover\/re-review consumer/);
});

test('RCC review agent retries a real provider reply that dropped the terminal marker', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-review-retry'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC review retry',
    directive: 'recover a markerless provider reply with a bounded real retry',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-review-retry-cycle') };
  const lifecycle: string[] = [];
  const compositions = [undefined, 'HUMANAGENT_REVIEW: passed'].map<AgentProviderComposition>((reviewMarker, index) => {
    const binding = providerBinding();
    const port = providerPort({ state: 'succeeded', reviewMarker });
    return {
      roleId: 'review',
      source: 'rcc',
      provider: { provider: 'rcc', binding: binding.bindingId, protocol: 'responses', model: binding.modelRef, route: 'test', baseUrl: 'http://127.0.0.1:4444' },
      binding,
      port: {
        ...port,
        async settle(request) {
          const settlement = await port.settle(request);
          lifecycle.push(`settle ${index + 1}`);
          return settlement;
        },
        async close(request) {
          assert.equal(request, binding);
          lifecycle.push(`close ${index + 1}`);
          return port.close(request);
        },
      } satisfies ExecutionRuntimePort,
    };
  });
  let prepared = 0;
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded' }),
    binding: providerBinding(),
    async prepareAgentProvider({ roleId }) {
      assert.equal(roleId, 'review');
      lifecycle.push(`prepare ${++prepared}`);
      const composition = compositions[prepared - 1];
      assert.ok(composition);
      return composition;
    },
    promptSegments: { review: ['review system prompt'] },
  });
  const reviewAssignment: ReviewAssignment = {
    assignmentId: 'serve-rcc-retry-review',
    taskId: task.id.value,
    workerAgentId: 'serve-rcc-execution-agent',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    subjectRefs: ['serve-output'],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  const workerAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-retry-worker',
  };
  const workerResult: WorkResult = {
    ...assignment(task),
    pipelineNodeId: 'serve-stage',
    agentId: 'serve-rcc-execution-agent',
    assignmentId: 'serve-rcc-retry-worker',
    executionEpoch: 1,
    attempt: 1,
    inputRevision: 1,
    taskId: task.id,
    producedArtifactRefs: ['serve-output'],
    status: 'succeeded',
    summary: 'worker result',
    outputRefs: ['serve-output'],
    evidenceRefs: [],
    nextAction: 'review',
  };
  const review = await ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment,
    workerResult,
    reviewMaterial: materialFor(workerAssignment, workerResult),
    scope,
  });
  assert.equal(review.status, 'passed');
  assert.equal(review.findings.length, 0);
  lifecycle.push('result');
  assert.deepEqual(lifecycle, ['prepare 1', 'settle 1', 'close 1', 'prepare 2', 'settle 2', 'close 2', 'result']);
  assert.equal(prepared, 2);

  const runError = new Error('review dispatch failed');
  const missingActiveError = new Error('provider operation has no active execution scope');
  const settleError = new Error('review settle failed');
  const closeError = new Error('review close failed');
  const failedComposition = compositions[0]!;
  let errorPrepared = 0;
  let errorClosed = 0;
  const errorLifecycle: string[] = [];
  const failingPorts = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded' }),
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
    async prepareAgentProvider() {
      errorPrepared += 1;
      return {
        ...failedComposition,
        port: {
          ...failedComposition.port,
          async start() {
            errorLifecycle.push('start');
            throw runError;
          },
          async settle(request) {
            errorLifecycle.push('settle');
            throw missingActiveError;
          },
          async close(binding) {
            assert.equal(binding, failedComposition.binding);
            errorClosed += 1;
            errorLifecycle.push('close');
            throw closeError;
          },
        },
      };
    },
  });
  await assert.rejects(() => failingPorts.reviewAgent.review({
    reviewAssignment,
    workerAssignment,
    workerResult,
    reviewMaterial: materialFor(workerAssignment, workerResult),
    scope,
  }), (error: unknown) => {
    if (!(error instanceof AggregateError)) throw error;
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], runError);
    assert.equal(error.errors[1], closeError);
    return true;
  });
  assert.equal(errorPrepared, 1);
  assert.equal(errorClosed, 1);
  assert.deepEqual(errorLifecycle, ['start', 'close']);

  const acquiredError = new Error('review observe failed after acquisition');
  let acquiredClosed = 0;
  const acquiredLifecycle: string[] = [];
  const acquiredPorts = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded' }),
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
    async prepareAgentProvider() {
      return {
        ...failedComposition,
        port: {
          ...failedComposition.port,
          async start(request) {
            acquiredLifecycle.push('start');
            return failedComposition.port.start(request);
          },
          observe: async function* () {
            acquiredLifecycle.push('observe');
            throw acquiredError;
          },
          async settle(request) {
            acquiredLifecycle.push('settle');
            return failedComposition.port.settle(request);
          },
          async close(binding) {
            assert.equal(binding, failedComposition.binding);
            acquiredClosed += 1;
            acquiredLifecycle.push('close');
            return failedComposition.port.close(binding);
          },
        },
      };
    },
  });
  await assert.rejects(() => acquiredPorts.reviewAgent.review({
    reviewAssignment,
    workerAssignment,
    workerResult,
    reviewMaterial: materialFor(workerAssignment, workerResult),
    scope,
  }), (error: unknown) => error === acquiredError);
  assert.equal(acquiredClosed, 1);
  assert.deepEqual(acquiredLifecycle, ['start', 'observe', 'settle', 'close']);

  const settleFailureError = new Error('review observe failed with acquired execution');
  let settleFailureClosed = 0;
  const settleFailureLifecycle: string[] = [];
  const settleFailurePorts = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded' }),
    binding: providerBinding(),
    promptSegments: { review: ['system prompt'] },
    async prepareAgentProvider() {
      return {
        ...failedComposition,
        port: {
          ...failedComposition.port,
          async start(request) {
            settleFailureLifecycle.push('start');
            return failedComposition.port.start(request);
          },
          observe: async function* () {
            settleFailureLifecycle.push('observe');
            throw settleFailureError;
          },
          async settle() {
            settleFailureLifecycle.push('settle');
            throw settleError;
          },
          async close() {
            settleFailureClosed += 1;
            settleFailureLifecycle.push('close');
            return failedComposition.port.close(failedComposition.binding);
          },
        },
      };
    },
  });
  await assert.rejects(() => settleFailurePorts.reviewAgent.review({
    reviewAssignment,
    workerAssignment,
    workerResult,
    reviewMaterial: materialFor(workerAssignment, workerResult),
    scope,
  }), (error: unknown) => {
    if (!(error instanceof AggregateError)) throw error;
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], settleFailureError);
    assert.equal(error.errors[1], settleError);
    assert.match(error.message, /review observe failed with acquired execution/);
    return true;
  });
  assert.equal(settleFailureClosed, 1);
  assert.deepEqual(settleFailureLifecycle, ['start', 'observe', 'settle', 'close']);
});

test('RCC review agent retries an inconclusive verdict before accepting a later pass', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'inconclusive-then-pass',
    provider: providerPort({
      state: 'succeeded',
      reviewMarkerSequence: ['HUMANAGENT_REVIEW: inconclusive', 'HUMANAGENT_REVIEW: passed'],
    }),
  });
  assert.equal(review.status, 'passed');
  assert.deepEqual(review.findings, []);
});

test('RCC review agent renders executor tool evidence into the review prompt', async () => {
  const submittedPrompts: string[] = [];
  const task: Task = {
    id: id('task', 'serve-rcc-review-executor-evidence'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC review executor evidence',
    directive: 'carry executor tool evidence into the reviewer prompt',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-review-executor-cycle') };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({
      state: 'succeeded',
      reviewMarker: 'HUMANAGENT_REVIEW: passed',
      submittedPrompts,
    }),
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
  });
  const workerPorts = createDeterministicServeOrchestrationPorts();
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-review-executor-worker',
    pipelineNodeId: 'serve-rcc-review-executor-stage',
  };
  const worker = await runDeterministicWorker({
    workerPorts,
    workAssignment,
    task,
    scope,
    agentId: 'serve-rcc-review-executor-agent',
  });
  const executorEvidence = [
    {
      summary: 'provider.tool search matched 3 files',
      evidenceRefs: [{
        evidenceId: id('evidence', 'serve-rcc-executor-tool'),
        kind: 'tool' as const,
        source: 'test.serve-rcc-orchestration',
        locator: 'serve-rcc/executor-tool',
        scope,
      }],
    },
  ];
  const workerWithEvidence = { ...worker, executorEvidence };
  const reviewAssignment: ReviewAssignment = {
    assignmentId: 'serve-rcc-review-executor-review',
    taskId: task.id.value,
    workerAgentId: 'serve-rcc-review-executor-agent',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    subjectRefs: [...workAssignment.targetRefs],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  const review = await ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment: workAssignment,
    workerResult: workerWithEvidence,
    reviewMaterial: materialFor(workAssignment, workerWithEvidence),
    scope,
  });
  assert.equal(review.status, 'passed');
  assert.equal(submittedPrompts.length, 1, 'the reviewer provider must receive the review prompt');
  const prompt = submittedPrompts[0] ?? '';
  assert.match(prompt, /provider\.tool search matched 3 files/);
  assert.match(prompt, /serve-rcc-executor-tool/);
  assert.match(prompt, /first-hand execution evidence/);
});

test('RCC review agent does not invent executor evidence when none exists', async () => {
  const submittedPrompts: string[] = [];
  const review = await reviewWithProviderText({
    taskSuffix: 'absent-executor-evidence',
    provider: providerPort({
      state: 'succeeded',
      reviewMarker: 'HUMANAGENT_REVIEW: failed',
      submittedPrompts,
    }),
  });
  assert.equal(review.status, 'failed');
  const prompt = submittedPrompts[0] ?? '';
  assert.match(prompt, /"executorEvidence":\[\]/);
});

test('RCC review agent honors an explicit failed verdict without retrying to pass', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'failed-not-retried',
    provider: providerPort({
      state: 'succeeded',
      reviewMarkerSequence: ['HUMANAGENT_REVIEW: failed', 'HUMANAGENT_REVIEW: passed'],
    }),
  });
  assert.equal(review.status, 'failed');
  assert.equal(review.findings.length, 1);
  assert.match(review.findings[0]!.problem, /HUMANAGENT_REVIEW: failed/);
});

test('RCC review agent uses the terminal verdict when review markers conflict', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-review-conflict'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC review terminal verdict',
    directive: 'keep the terminal review verdict as authoritative',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-review-conflict-cycle') };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded', reviewMarkers: ['HUMANAGENT_REVIEW: passed', 'HUMANAGENT_REVIEW: failed'] }),
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
  });
  const reviewAssignment: ReviewAssignment = {
    assignmentId: 'serve-rcc-conflict-review',
    taskId: task.id.value,
    workerAgentId: 'serve-rcc-execution-agent',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    subjectRefs: ['serve-output'],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  const workerAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-conflict-worker',
  };
  const workerResult: WorkResult = {
    ...assignment(task),
    pipelineNodeId: 'serve-stage',
    agentId: 'serve-rcc-execution-agent',
    assignmentId: 'serve-rcc-conflict-worker',
    executionEpoch: 1,
    attempt: 1,
    inputRevision: 1,
    taskId: task.id,
    producedArtifactRefs: ['serve-output'],
    status: 'succeeded',
    summary: 'worker result',
    outputRefs: ['serve-output'],
    evidenceRefs: [],
    nextAction: 'review',
  };
  const review = await ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment,
    workerResult,
    reviewMaterial: materialFor(workerAssignment, workerResult),
    scope,
  });
  assert.equal(review.status, 'failed');
  assert.equal(review.findings.length, 1);
});

test('RCC review agent uses a terminal passed verdict after an earlier failed quote', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'terminal-passed-after-quote',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: [
        'The criteria text includes HUMANAGENT_REVIEW: failed only as an example. ',
        'HUMANAGENT_REVIEW: passed',
      ],
    }),
  });
  assert.equal(review.status, 'passed');
  assert.deepEqual(review.findings, []);
});

test('RCC ports reach the runtime review and Harness merge gates with provider artifacts', async () => {
  const eventBus = await eventBusPorts();
  const task: Task = {
    id: id('task', 'serve-rcc-manager-task'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC manager integration',
    directive: 'exercise the provider-backed runtime review and merge gates',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-manager-cycle') };
  const runtimeComposition = createServeRuntimeComposition({
    eventBusPorts: eventBus.ports,
    feedbackPorts: { journal: eventBus.ports.journal, publishers: eventBus.ports.publishers },
    feedbackPublisherId: 'serve-test',
    ...createDeterministicServeOrchestrationPorts(),
    ...createRccServeOrchestrationPorts({
      port: providerPort({ state: 'succeeded', reviewMarker: 'HUMANAGENT_REVIEW: passed', outputRef: 'serve-rcc-manager-output' }),
      binding: providerBinding(),
      promptSegments: { review: ['review system prompt'] },
    }),
  });
  const assembly = runtimeComposition.createTaskAssembly({
    task,
    scope,
    checkpointJournal: {} as CheckpointJournalPort,
  });
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-manager-assignment',
    pipelineNodeId: 'serve-rcc-manager-stage',
    targetRefs: ['serve-rcc-manager-output'],
    expectedOutputRefs: ['serve-rcc-manager-output'],
  };
  try {
    assembly.orchestration.planStage({ nodeId: workAssignment.pipelineNodeId, taskId: task.id });
    const dispatched = await assembly.orchestration.dispatch({
      stageNodeId: workAssignment.pipelineNodeId,
      assignment: workAssignment,
      agentId: 'serve-rcc-execution-agent',
      scope,
      reviewKinds: ['quality'],
      reviewSubjects: [{ ref: 'serve-rcc-manager-output', body: serveArtifactBody }],
    });
    assert.equal(dispatched.status, 'merged', JSON.stringify(dispatched));
    assert.equal(dispatched.assignment.status, 'merged');
    assert.equal(dispatched.reviewResults[0]?.status, 'passed');
    assert.equal(dispatched.mergeOutcome?.status, 'merged');
  } finally {
    await runtimeComposition.dispose();
    await eventBus.close();
  }
});

async function reviewWithProviderText(input: {
  readonly taskSuffix: string;
  readonly provider: ExecutionRuntimePort;
}): Promise<ReviewResult> {
  const task: Task = {
    id: id('task', `serve-chunk-${input.taskSuffix}`),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC chunked review',
    directive: 'parse reviewer text across chunk boundaries',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = {
    organId: task.organId,
    taskId: task.id,
    cycleId: id('cycle', `serve-chunk-${input.taskSuffix}-cycle`),
  };
  const ports = createRccServeOrchestrationPorts({
    port: input.provider,
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
  });
  const workerPorts = createDeterministicServeOrchestrationPorts();
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: `serve-chunk-${input.taskSuffix}-assignment`,
    pipelineNodeId: `serve-chunk-${input.taskSuffix}-stage`,
  };
  const worker = await runDeterministicWorker({
    workerPorts,
    workAssignment,
    task,
    scope,
    agentId: `serve-chunk-${input.taskSuffix}-worker`,
  });
  const reviewAssignment: ReviewAssignment = {
    assignmentId: `serve-chunk-${input.taskSuffix}-review`,
    taskId: task.id.value,
    workerAgentId: `serve-chunk-${input.taskSuffix}-worker`,
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    subjectRefs: [...workAssignment.targetRefs],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  return ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment: workAssignment,
    workerResult: worker,
    reviewMaterial: materialFor(workAssignment, worker),
    scope,
  });
}

test('RCC review parses a verdict marker split across provider output chunks', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'split-marker',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: ['Subject reviewed: the artifact body is present. HUMANAGENT_REV', 'IEW: passed'],
    }),
  });
  assert.equal(review.status, 'passed');
  assert.deepEqual(review.findings, []);
});

test('RCC review keeps a chunked explanation and does not drop it behind a marker-only chunk', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'chunked-explanation',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: [
        'The acceptance criteria are unmet because the artifact omits the required evidence. ',
        'HUMANAGENT_REVIEW: failed',
      ],
    }),
  });
  assert.equal(review.status, 'failed');
  assert.equal(review.findings.length, 1);
  assert.match(review.findings[0]!.problem, /omits the required evidence/);
});

test('RCC review keeps a verdict marker tail that depends on an earlier chunk', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'marker-after-explanation',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: ['All acceptance criteria are satisfied. ', 'HUMANAGENT_REVIEW: passed'],
    }),
  });
  assert.equal(review.status, 'passed');
});

test('RCC review uses the terminal verdict when verdict markers conflict across chunks', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'conflicting-chunks',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: ['HUMANAGENT_REVIEW: passed', ' but on reflection HUMANAGENT_REVIEW: failed'],
    }),
  });
  assert.equal(review.status, 'failed');
  assert.equal(review.findings.length, 1);
});

test('RCC review instance delivers the actual provider text of the same review call', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-instance-delivery'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC instance delivery',
    directive: 'deliver the real reviewer text of the invoked review instance',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-instance-delivery-cycle') };
  const provider = providerPort({
    state: 'succeeded',
    chunkedReviewText: [
      'review instance actual output for this assignment. ',
      'HUMANAGENT_REVIEW: passed',
    ],
  });
  let settlements = 0;
  const ports = createRccServeOrchestrationPorts({
    port: {
      ...provider,
      async settle(request) {
        settlements += 1;
        return provider.settle(request);
      },
    },
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
  });
  const workerPorts = createDeterministicServeOrchestrationPorts();
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-instance-delivery-worker',
  };
  const worker = await runDeterministicWorker({
    workerPorts,
    workAssignment,
    task,
    scope,
    agentId: 'serve-rcc-instance-delivery-execution-agent',
  });
  const reviewAssignment: ReviewAssignment = {
    assignmentId: 'serve-rcc-instance-delivery-review',
    taskId: task.id.value,
    workerAgentId: 'serve-rcc-instance-delivery-execution-agent',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    subjectRefs: ['serve-output'],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  const reviewInput = {
    reviewAssignment,
    workerAssignment: workAssignment,
    workerResult: worker,
    reviewMaterial: materialFor(workAssignment, worker),
    scope,
  };

  const { createInstance } = ports.reviewAgent;
  if (!createInstance) throw new Error('RCC review agent has no review instance creator');
  const create = createInstance({
    incarnation: {
      runtimeId: 'serve-rcc-instance-delivery-runtime',
      generation: 1,
      agentInstanceId: 'serve-rcc-instance-delivery-instance',
      roleId: 'serve-rcc-review',
      taskId: task.id,
      assignmentId: reviewAssignment.assignmentId,
      executionEpoch: 1,
    },
    agentId: 'serve-rcc-instance-delivery-execution-agent',
    scope,
    assignment: {
      assignmentId: reviewAssignment.assignmentId,
      taskId: task.id,
      attempt: 1,
      reviewAssignment,
      workerAssignment: workAssignment,
    },
  });
  const delivered = await create.review(reviewInput);

  assert.equal(delivered.result.status, 'passed');
  assert.deepEqual(delivered.result.findings, []);
  assert.equal(
    delivered.output.text,
    'review instance actual output for this assignment. HUMANAGENT_REVIEW: passed',
  );
  assert.equal(delivered.output.artifactRef, null);
  assert.equal(delivered.output.artifactDigest, null);
  assert.ok(delivered.completedAt.length > 0);

  const legacy = await ports.reviewAgent.review(reviewInput);
  assert.equal(legacy.resultId, delivered.result.resultId);
  assert.equal(legacy.status, delivered.result.status);
  await create.dispose();
  assert.equal(
    settlements,
    2,
    'one provider invocation per review call, no shared output and no second generation',
  );
});
