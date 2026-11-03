import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  id,
  STANDARD_TURN_END_TOOL_ID,
  validateAgentDebugInspection,
  validatePlanRevisionRecord,
  type AcceptedRawFact,
  type Attention,
  type Checkpoint,
  type EvidenceRef,
  type PlanRevisionRecord,
  type RawAsset,
  type ScopeRef,
  type StandardTurnEndCommand,
} from '../../packages/contracts/src/index.js';
import type { AttentionPort } from '../../packages/runtime/src/control/attention.js';
import { JsonlTaskPlanRevisionJournal } from '../../packages/adapters/jsonl/src/task-plan-revisions.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { TaskPlanRevisionConsumer } from '../../packages/runtime/src/orchestration/task-plan-revisions.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import {
  RuntimeTaskCoordinator,
  RuntimeTaskControlError,
  type RuntimeExecutionAllocation,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeTaskAssembly,
  type RuntimeTaskSnapshot,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { ServiceExecutionCheckpointStore } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { openUiRuntimeOrganJournal } from '../../packages/app/src/ui-runtime/journal.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { UiRuntimeService } from '../../packages/app/src/ui-runtime/service.js';

import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { createFakeExecutionPort } from '../../packages/app/src/fake-execution.js';
import { UiRuntimeJournal } from '../../packages/app/src/ui-runtime/journal.js';

const organId = id('organ', 'organ-w2a-test');

const noopAttentionPort: AttentionPort = {
  async publish(input: Attention) {
    return {
      attentionId: input.attentionId,
      delivered: true as const,
    };
  },
  async resolve(input: Attention) {
    return {
      attentionId: input.attentionId,
      delivered: true as const,
    };
  },
};

function createStubTaskAssembly(): RuntimeTaskAssembly {
  return {
    orchestration: {
      planStage() {
        return { nodeId: 'stage-1', taskId: id('task', 't-1'), state: 'planned' };
      },
      async dispatch(input: { readonly assignment: { readonly taskId: ReturnType<typeof id<'task'>>; readonly pipelineNodeId: string; readonly assignmentId: string; readonly attempt: number; readonly executionEpoch: number; readonly inputRevision: number } }) {
        return {
          status: 'merged' as const,
          result: {
            taskId: input.assignment.taskId,
            pipelineNodeId: input.assignment.pipelineNodeId,
            agentId: 'humanagent.provider-execution',
            assignmentId: input.assignment.assignmentId,
            attempt: input.assignment.attempt,
            executionEpoch: input.assignment.executionEpoch,
            inputRevision: input.assignment.inputRevision,
            producedArtifactRefs: [],
            status: 'succeeded' as const,
            summary: 'completed',
            outputRefs: [],
            evidenceRefs: [],
            nextAction: 'settle' as const,
          },
          reviewCommitRefs: [],
        };
      },
    } as unknown as RuntimeTaskAssembly['orchestration'],
    runtimePool: {} as unknown as RuntimeTaskAssembly['runtimePool'],
  };
}

function createNativeStandardTurnDriver(
  input: RuntimeExecutionDriverInput,
  store: ServiceExecutionCheckpointStore,
  options: {
    readonly publicText?: string;
    readonly failFirstSubmitWith503?: boolean;
    readonly onSubmit?: (prompt: string) => void;
  } = {},
): RuntimeExecutionDriver {
  let submitCount = 0;
  const scope = input.scope;
  const checkpointId = id('checkpoint', `cp-${input.operationId.value}-${input.executionEpoch}`);
  const checkpoint: Checkpoint = {
    id: checkpointId,
    scope,
    cycleId: scope.cycleId!,
    previousCheckpointId: null,
    seq: 1,
    executionEpoch: input.executionEpoch,
    directiveRevision: 1,
    outcome: 'succeeded',
    summary: 'turn closed',
    next: { kind: 'stop' },
    recoveryStateRef: {
      evidenceId: id('evidence', `rec-${input.operationId.value}`),
      kind: 'operation',
      source: 'test-driver',
      locator: `checkpoint/${checkpointId.value}`,
      scope,
    },
    evidenceRefs: [],
  };
  const deliveryText = options.publicText ?? 'W2-A canonical public output';
  const textBytes = new TextEncoder().encode(deliveryText);
  const textDigest = `sha256:${createHash('sha256').update(textBytes).digest('hex')}`;
  const textEvidence: EvidenceRef = {
    evidenceId: id('evidence', `deliv-${input.operationId.value}`),
    kind: 'tool',
    source: 'standard-turn-end',
    locator: `asset://standard-turn-end/${input.operationId.value}`,
    digest: textDigest,
    scope,
  };
  const rawAsset: RawAsset = {
    ref: textEvidence,
    view: { kind: 'utf8-text' },
  };
  const acceptedEndCall: AcceptedRawFact = {
    seq: 1,
    envelope: {
      execution: { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch },
      scope,
      request: { turnId: `turn-${input.operationId.value}`, requestId: `req-${input.operationId.value}` },
      producerSeq: 1,
      fact: {
        kind: 'tool-call',
        contentUnitId: 'end-call-unit',
        complete: true,
        call: {
          callId: 'call-end-1',
          toolId: STANDARD_TURN_END_TOOL_ID,
          arguments: {},
          continuationRef: 'cont-1',
        },
        rawArguments: rawAsset,
      },
    },
  };
  const acceptedEnd: StandardTurnEndCommand = {
    kind: 'standard-turn-end',
    identity: {
      turnId: `turn-${input.operationId.value}`,
      workAssignmentRef: input.assignmentId,
      taskRef: input.taskId,
      scopeRef: scope,
      cycleRef: scope.cycleId!,
      inputRevision: 1,
      directiveRevision: 1,
      executionEpoch: input.executionEpoch,
      runtimeBindingRef: 'binding-w2a',
      permissionRevision: 'perm-1',
    },
    outcome: 'completed',
    summary: {
      goal: 'Complete W2-A task',
      actions: ['executed bound step'],
      result: { status: 'completed', text: deliveryText },
      nextStep: 'none',
    },
    deliveryRefs: deliveryText.length > 0 ? [textEvidence.locator] : [],
    resolvedEvidenceRefs: deliveryText.length > 0 ? [textEvidence] : [],
  };

  return {
    kind: 'test-native-standard-turn-driver',
    async capabilities() {
      return { driverKind: 'test-native-standard-turn-driver', capabilities: ['execute'], version: '1' };
    },
    async start(startInput) {
      return { runtimeId: startInput.runtimeId, executionEpoch: startInput.executionEpoch };
    },
    async resume(resumeInput) {
      return { runtimeId: resumeInput.runtimeId, executionEpoch: resumeInput.executionEpoch };
    },
    async submit(submitInput) {
      submitCount += 1;
      options.onSubmit?.(String((submitInput.payload as { readonly prompt?: string })?.prompt ?? ''));
      if (options.failFirstSubmitWith503 && submitCount === 1) {
        const err = new Error('provider request failed with HTTP 503') as Error & {
          code: string;
          retryable: boolean;
          ownerId: string;
          nextAction: string;
          providerError: {
            readonly phase: 'start';
            readonly code: string;
            readonly message: string;
            readonly retryable: 'retryable';
            readonly ownerId: string;
            readonly nextAction: { readonly kind: 'retry' };
            readonly evidenceRefs: readonly [];
          };
        };
        err.code = 'http.503';
        err.retryable = true;
        err.ownerId = 'humanagent.provider';
        err.nextAction = 'retry provider request';
        err.providerError = {
          phase: 'start',
          code: 'http.503',
          message: 'provider request failed with HTTP 503',
          retryable: 'retryable',
          ownerId: 'humanagent.provider',
          nextAction: { kind: 'retry' },
          evidenceRefs: [],
        };
        throw err;
      }
      return {
        taskId: submitInput.taskId,
        executionEpoch: submitInput.executionEpoch,
        assignmentId: submitInput.assignmentId,
        payload: submitInput.payload,
        outputRefs: [],
        evidenceRefs: [],
      };
    },
    async *observe() {
      // Single clean turn completion
    },
    async requestStop(stopInput) {
      return { requested: true, operationId: stopInput.operationId };
    },
    async settle() {
      return { state: 'succeeded' as const, evidenceRefs: [] };
    },
    async close() {
      return {
        bindingId: 'binding-w2a',
        providerId: 'provider-w2a',
        protocol: 'responses' as const,
        state: 'closed' as const,
        evidenceRefs: [],
      };
    },
    standardTurn: {
      async acceptReviews() {},
      async readCheckpoint() {
        const relationship = await store.commitNativeCheckpoint({
          ownerId: 'w2a-test',
          checkpoint,
          timeAuthority: {
            source: 'harness',
            owner: 'runtime-checkpoint-control-owner',
            authorityRef: `fixture:${checkpoint.id.value}`,
            sampleCommittedAt: async () => '2026-11-02T10:00:00.000Z',
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
          state: 'terminal' as const,
          decision: 'complete' as const,
          admission: {
            commitId: `adm-${input.operationId.value}`,
            journalSeq: 2,
            recordDigest: `sha256:${'d'.repeat(64)}`,
          },
          alignment: {
            commitId: `align-${input.operationId.value}`,
            journalSeq: 3,
            recordDigest: `sha256:${'e'.repeat(64)}`,
          },
        } as unknown as Awaited<ReturnType<NonNullable<RuntimeExecutionDriver['standardTurn']>['align']>>;
      },
      async readDelivery() {
        return {
          assignment: {
            assignmentId: input.assignmentId,
            taskId: input.taskId,
            pipelineNodeId: `stage-${input.operationId.value}`,
            attempt: 1,
            executionEpoch: input.executionEpoch,
            inputRevision: 1,
            objective: 'test objective',
            targetRefs: [],
            expectedOutputRefs: [],
            successCriteria: [],
            failureCriteria: [],
            incompleteCriteria: [],
            requiredCapabilities: [],
            mergeGate: 'not-required' as const,
          },
          acceptedEnd,
          materials: deliveryText.length > 0
            ? [{
                kind: 'delivery-text' as const,
                deliveryEvidence: textEvidence,
                acceptedEndCall,
                rawArguments: rawAsset,
                bodyAsset: rawAsset,
                bytes: textBytes,
                digest: textDigest,
                sourceEvidence: [textEvidence],
              }]
            : [],
        };
      },
    },
  };
}

const knownCurrentStateFacts = {
  async read() {
    return {
      state: 'known' as const,
      value: {
        turn: {
          phase: 'open' as const,
          nextAction: { kind: 'continue' as const },
          ownerRef: 'humanagent.runtime',
          unresolvedOperationRefs: [],
          laterErrorRefs: [],
        },
        stages: { state: 'known' as const, stages: [] },
      },
    };
  },
};

test('W2-A (1): native default path sets orchestrated=true, selects non-execute explore action on read-only search, isolates step prompt from operation.input, and commits post-step PlanRevisionRecord in the same Turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w2a-native-default-'));
  try {
    const controlPath = join(dir, 'control.jsonl');
    const organJournal = openUiRuntimeOrganJournal(controlPath);
    const planConsumer = new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(organJournal));
    const store = new ServiceExecutionCheckpointStore(controlPath, organJournal, () => new Date('2026-11-02T10:00:00.000Z'));
    const currentStatePort = createJsonlRuntimeTaskCurrentStateJournal({ journal: organJournal });
    const submittedPrompts: string[] = [];

    const testBinding = {
      bindingId: 'binding-w2a',
      providerId: 'provider-w2a',
      protocol: 'responses' as const,
      endpointRef: 'http://127.0.0.1:4444/v1/responses',
      modelRef: 'gpt-5.4',
      configDigest: `sha256:${'1'.repeat(64)}`,
      capabilityDigest: `sha256:${'2'.repeat(64)}`,
      capabilities: ['execute'] as const,
    };
    const service = new UiRuntimeService({
      mode: 'rcc',
      organId,
      binding: testBinding,
      port: createFakeExecutionPort(testBinding),
      closurePort: new UiRuntimeJournal(join(dir, 'ui-runtime.jsonl')),
      memory: {
        coordinator: new MemoryCoordinator(),
        backend: new DeterministicMemoryBackend(),
        projectKey: 'w2a-test',
        roleId: 'execution',
      },
      checkpointStoreFor: () => store,
      attentionPort: noopAttentionPort,
      providerState: 'ready',
      taskIdentity: new TaskIdentityConsumer(new JsonlTaskIdentityJournal(organJournal)),
      explicitBrainInterpreter: {
        async interpret() {
          return {
            kind: 'requirement',
            intent: 'create',
            normalizedInput: 'Search workspace and summarize W2-A plan binding',
            proposal: 'Search workspace and summarize W2-A plan binding',
            knownFacts: [],
            decisionRefs: [],
            structuredProposal: {
              revision: 1,
              intent: 'create',
              title: 'W2-A native orchestrated task',
              objective: 'Search workspace and summarize W2-A plan binding',
              deliverable: 'Summary',
              deliveryConditions: ['summarize binding'],
              evidenceRefs: [],
              blockingGaps: [],
            },
          };
        },
      },
      runtimeComposition: {
        createTaskAssembly: () => createStubTaskAssembly(),
        admitExecution: async () => {},
        createExecutionPorts: () => ({
          admitExecution: async () => {},
          createDriver: async (driverInput: RuntimeExecutionDriverInput) => createNativeStandardTurnDriver(driverInput, store, {
            onSubmit: (prompt) => submittedPrompts.push(prompt),
          }),
          currentStatePort,
          currentStateFacts: knownCurrentStateFacts,
          executionPlanRevisionPort: planConsumer,
        } as unknown as ReturnType<NonNullable<NonNullable<ConstructorParameters<typeof UiRuntimeService>[0]['runtimeComposition']>['createExecutionPorts']>>),
      },
    });

    const interactionId = await service.receiveExplicitInput({
      sourceRef: 'ui:new-task-create',
      rawInput: 'Search workspace and summarize W2-A plan binding',
      channel: 'business',
      requestKind: 'new-task-create',
    });
    await service.interpretExplicitInput({ interactionId });
    const preview = await service.inspectExplicitInteraction(interactionId);
    assert.ok(preview.draft, 'new-task-create must produce a draft');
    await service.confirmExplicitRequirement({
      interactionId,
      draftId: preview.draft!.draftId,
      inputRevision: preview.draft!.inputRevision,
      confirmationRef: 'confirm:w2a-native',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-11-02T10:00:00.000Z',
      payloadRef: 'asset://w2a-native',
      requestKind: 'new-task-create',
    });
    const dispatched = await service.dispatchNextExplicitRequirement();
    const taskId = dispatched.taskId;
    const deadline = Date.now() + 5000;
    while (
      (!service.taskDashboard(taskId).history.events.some((ev) => ev.kind === 'execution.terminal')
        || service.taskDashboard(taskId).state !== 'succeeded')
      && Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 25));

    const dash = service.taskDashboard(taskId) as ReturnType<UiRuntimeService['taskDashboard']> & {
      readonly orchestrated?: boolean;
      readonly planRevision?: PlanRevisionRecord;
      readonly planRevisions?: readonly PlanRevisionRecord[];
    };
    assert.equal(dash.orchestrated, true, 'native RCC task with createTaskAssembly must default to orchestrated=true');
    assert.ok(dash.planRevision, 'committed PlanRevisionRecord must be present on task dashboard');
    assert.ok(dash.planRevisions, 'planRevisions history must be present on task dashboard');
    assert.equal(
      dash.planRevisions!.length,
      2,
      'production Turn must commit pre-step initial PlanRevisionRecord (continue) and post-step second-decision PlanRevisionRecord (complete)',
    );
    const initialRev = dash.planRevisions![0]!;
    const postStepRev = dash.planRevisions![1]!;
    assert.equal(initialRev.decision, 'continue');
    assert.equal(initialRev.steps[0]?.kind, 'explore', 'production path must dynamically select explore for read-only search rather than fixed execute');
    assert.equal(initialRev.steps[0]?.effectPolicy, 'readonly');
    assert.equal(initialRev.steps[0]?.state, 'pending');
    assert.equal(postStepRev.decision, 'complete', 'post-step second decision in the same Turn must commit decision=complete');
    assert.equal(postStepRev.steps[0]?.kind, 'explore');
    assert.equal(postStepRev.steps[0]?.state, 'completed');
    assert.ok((postStepRev.steps[0]?.outputEvidenceRefs.length ?? 0) > 0, 'completed post-step revision must carry outputEvidenceRefs');
    for (const rev of dash.planRevisions!) {
      validatePlanRevisionRecord(rev, {
        taskId: taskId.value,
        operationId: dash.operationId!,
        executionEpoch: dash.executionEpoch!,
      });
      assert.equal(rev.steps[0]?.contextIsolation.inheritsOrchestratorContext, false);
    }
    assert.equal(submittedPrompts.length, 1);
    assert.equal(
      submittedPrompts[0] !== dash.input,
      true,
      'step isolated prompt must be constructed from isolated subagent context rather than raw operation.input',
    );
    assert.match(submittedPrompts[0]!, /\[Subagent Isolated Context — ctx:/);
    assert.match(submittedPrompts[0]!, /kind=explore, role=execution, effectPolicy=readonly/);
    const replayedFromJournal = await planConsumer.replayExecutionPlanRevisions({ organId, taskId });
    assert.equal(replayedFromJournal.length, 2, 'both pre-step and post-step PlanRevisionRecords must be durably persisted in control.jsonl');
  } finally {
    await new Promise((r) => setTimeout(r, 25));
    await rm(dir, { recursive: true, force: true });
  }
});

test('W2-A (2): unbound or mismatched planStepBinding throws orchestration.unbound-plan-step with zero Provider/driver calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w2a-unbound-step-'));
  try {
    const controlPath = join(dir, 'control.jsonl');
    const organJournal = openUiRuntimeOrganJournal(controlPath);
    const store = new ServiceExecutionCheckpointStore(controlPath, organJournal, () => new Date('2026-11-02T10:00:00.000Z'));
    let driverCalls = 0;
    const coordinator = new RuntimeTaskCoordinator({
      organId,
      checkpointStoreFor: () => store,
      publicOutputStoreFor: () => store,
      attentionPort: noopAttentionPort,
      admitExecution: async () => {},
      createTaskAssembly: () => createStubTaskAssembly(),
      createDriver: async (driverInput: RuntimeExecutionDriverInput) => {
        driverCalls += 1;
        return createNativeStandardTurnDriver(driverInput, store);
      },
    });

    const task = coordinator.createTask({
      title: 'Unbound step test',
      directive: 'Must fail before driver creation when step binding mismatches',
    });
    const allocation = coordinator.prepareExecution(task.taskId, {
      prompt: 'Must fail before driver creation',
      orchestrate: true,
      planStepBinding: {
        boundPlanRevisionId: 'plan-rev:wrong-revision',
        boundPlanStepId: 'step:plan-rev:wrong-revision:0',
      },
    } as Parameters<RuntimeTaskCoordinator['prepareExecution']>[1]);

    await assert.rejects(
      () => coordinator.releaseExecution(task.taskId, allocation.operationId),
      (err: unknown) => err instanceof RuntimeTaskControlError && err.code === 'orchestration.unbound-plan-step',
    );
    assert.equal(driverCalls, 0, 'Provider driver must not be created when planStepBinding is invalid');
  } finally {
    await new Promise((r) => setTimeout(r, 25));
    await rm(dir, { recursive: true, force: true });
  }
});

test('W2-A (3 & 4): dynamic orchestrator selects explore -> plan -> execute -> complete across post-step decisions without forced review and isolates subagent context window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w2a-dynamic-select-'));
  try {
    const controlPath = join(dir, 'control.jsonl');
    const organJournal = openUiRuntimeOrganJournal(controlPath);
    const planConsumer = new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(organJournal));
    const store = new ServiceExecutionCheckpointStore(controlPath, organJournal, () => new Date('2026-11-02T10:00:00.000Z'));
    const currentStatePort = createJsonlRuntimeTaskCurrentStateJournal({ journal: organJournal });
    const submittedPrompts: string[] = [];

    const coordinator = new RuntimeTaskCoordinator({
      organId,
      checkpointStoreFor: () => store,
      publicOutputStoreFor: () => store,
      attentionPort: noopAttentionPort,
      admitExecution: async () => {},
      currentStatePort,
      currentStateFacts: knownCurrentStateFacts,
      createTaskAssembly: () => createStubTaskAssembly(),
      createDriver: async (driverInput: RuntimeExecutionDriverInput) => createNativeStandardTurnDriver(driverInput, store, {
        onSubmit: (prompt) => submittedPrompts.push(prompt),
      }),
      executionPlanRevisionPort: planConsumer,
      roleModelBindings: {
        orchestration: { provider: 'rcc-Responses', requestedModel: 'gpt-5.4', actualModel: null },
        execution: { provider: 'rcc-Responses', requestedModel: 'gpt-5.4-mini', actualModel: null },
        review: { provider: 'rcc-Anthropic', requestedModel: 'claude-sonnet-4-6', actualModel: null },
      },
    } as unknown as ConstructorParameters<typeof RuntimeTaskCoordinator>[0]);

    const task = coordinator.createTask({
      title: 'Dynamic explore-plan-execute',
      directive: 'Locate files, form a plan, and execute the change',
    });
    const allocation = coordinator.prepareExecution(task.taskId, {
      prompt: 'Locate files, form a plan, and execute the change',
      orchestrate: true,
      orchestratorPrivateContext: 'ORCHESTRATOR_SECRET_RAW_HISTORY_99182',
      dynamicStepSequence: [
        { kind: 'explore', targetAgentRole: 'execution', effectPolicy: 'readonly', objective: 'Explore workspace files' },
        { kind: 'plan', targetAgentRole: 'orchestration', effectPolicy: 'readonly', objective: 'Draft execution plan from explore findings' },
        { kind: 'execute', targetAgentRole: 'execution', effectPolicy: 'mutating', objective: 'Execute the planned workspace update' },
      ],
    } as Parameters<RuntimeTaskCoordinator['prepareExecution']>[1]);

    await coordinator.releaseExecution(task.taskId, allocation.operationId);
    const deadline = Date.now() + 5000;
    while (coordinator.taskSnapshot(task.taskId).state !== 'succeeded' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const snap = coordinator.taskSnapshot(task.taskId) as RuntimeTaskSnapshot & {
      readonly planRevisions?: readonly PlanRevisionRecord[];
    };
    assert.equal(snap.state, 'succeeded');
    assert.ok(snap.planRevisions, 'planRevisions history must be exposed on snapshot');
    assert.equal(
      snap.planRevisions!.length,
      4,
      'must commit 3 step dispatches (explore -> plan -> execute) plus 1 post-step terminal complete revision',
    );
    assert.deepEqual(
      snap.planRevisions!.map((rev) => ({ decision: rev.decision, kind: rev.steps[0]!.kind, state: rev.steps[0]!.state })),
      [
        { decision: 'continue', kind: 'explore', state: 'pending' },
        { decision: 'continue', kind: 'plan', state: 'pending' },
        { decision: 'continue', kind: 'execute', state: 'pending' },
        { decision: 'complete', kind: 'execute', state: 'completed' },
      ],
    );
    assert.deepEqual(
      snap.planRevisions!.map((rev) => rev.steps[0]!.modelBinding.requestedModel),
      ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-mini'],
    );
    for (const rev of snap.planRevisions!) {
      validatePlanRevisionRecord(rev, {
        taskId: task.taskId.value,
        operationId: allocation.operationId.value,
        executionEpoch: allocation.executionEpoch,
      });
      assert.equal(rev.steps[0]!.contextIsolation.inheritsOrchestratorContext, false);
    }
    assert.equal(submittedPrompts.length, 3, 'each step in explore -> plan -> execute must receive its own isolated dispatch');
    for (const p of submittedPrompts) {
      assert.equal(p !== snap.input, true, 'step prompt must be isolated from raw operation.input');
      assert.equal(
        p.includes('ORCHESTRATOR_SECRET_RAW_HISTORY_99182'),
        false,
        'subagent context window must never inherit orchestrator private history',
      );
    }
  } finally {
    await new Promise((r) => setTimeout(r, 25));
    await rm(dir, { recursive: true, force: true });
  }
});

test('W2-A (5 & 6): orchestrated native standardTurn has single admission/retry owner on clean 503 and enforces W1-A single public output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w2a-retry-and-output-'));
  try {
    const controlPath = join(dir, 'control.jsonl');
    const organJournal = openUiRuntimeOrganJournal(controlPath);
    const store = new ServiceExecutionCheckpointStore(controlPath, organJournal, () => new Date('2026-11-02T10:00:00.000Z'));
    const currentStatePort = createJsonlRuntimeTaskCurrentStateJournal({ journal: organJournal });
    let admitCalls = 0;
    let createDriverCalls = 0;

    const coordinator = new RuntimeTaskCoordinator({
      organId,
      checkpointStoreFor: () => store,
      publicOutputStoreFor: () => store,
      attentionPort: noopAttentionPort,
      admitExecution: async (_alloc: RuntimeExecutionAllocation) => {
        admitCalls += 1;
      },
      currentStatePort,
      currentStateFacts: knownCurrentStateFacts,
      createTaskAssembly: () => createStubTaskAssembly(),
      createDriver: async (driverInput: RuntimeExecutionDriverInput) => {
        createDriverCalls += 1;
        const isEmptyTask = driverInput.inputRefs[0]?.includes('input/2');
        return createNativeStandardTurnDriver(driverInput, store, {
          failFirstSubmitWith503: !isEmptyTask,
          publicText: isEmptyTask ? '' : 'Single canonical output after 503 retry',
        });
      },
    });

    const task1 = coordinator.createTask({
      title: 'Clean 503 retry task',
      directive: 'Recover from initial 503 with single admission',
    });
    const alloc1 = coordinator.prepareExecution(task1.taskId, {
      prompt: 'Recover from initial 503 with single admission',
      orchestrate: true,
    });
    await coordinator.releaseExecution(task1.taskId, alloc1.operationId);
    const deadline = Date.now() + 5000;
    while (coordinator.taskSnapshot(task1.taskId).state !== 'succeeded' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    const snap1 = coordinator.taskSnapshot(task1.taskId);
    assert.equal(snap1.state, 'succeeded');
    assert.equal(admitCalls, 1, 'clean 503 retry must reuse the single admission');
    assert.equal(createDriverCalls, 1, 'clean 503 retry must reuse the single native driver');
    const retryEvents = snap1.events.filter((ev) => ev.kind === 'execution.retry');
    assert.equal(retryEvents.length, 1, 'exactly one corrective retry event must be emitted');
    assert.equal(retryEvents[0]?.state, 'retrying');
    assert.equal(snap1.publicOutput?.commits[0]?.text, 'Single canonical output after 503 retry');

    // Second task: empty public output on orchestrated native turn must NOT succeed
    const task2 = coordinator.createTask({
      title: 'Empty output task',
      directive: 'Must reject empty standard-turn-end on orchestrated lane',
    });
    const alloc2 = coordinator.prepareExecution(task2.taskId, {
      prompt: 'Must reject empty standard-turn-end on orchestrated lane',
      orchestrate: true,
    });
    await coordinator.releaseExecution(task2.taskId, alloc2.operationId);
    const deadline2 = Date.now() + 5000;
    while (coordinator.taskSnapshot(task2.taskId).state === 'running' && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 50));
    const snap2 = coordinator.taskSnapshot(task2.taskId);
    assert.equal(snap2.state === 'succeeded', false, 'empty public deliverable must never be accepted as succeeded');
    assert.equal(snap2.error?.code, 'standard-turn-end.missing-public-deliverable');
  } finally {
    await new Promise((r) => setTimeout(r, 25));
    await rm(dir, { recursive: true, force: true });
  }
});

test('W2-A & W3-B (7): UiRuntimeService wires orchestratorDecisionPort and projects 5-role AgentDebugInspection including planner invalid-schema failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w2a-w3b-service-wiring-'));
  try {
    const controlPath = join(dir, 'control.jsonl');
    const organJournal = openUiRuntimeOrganJournal(controlPath);
    const planConsumer = new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(organJournal));
    const store = new ServiceExecutionCheckpointStore(controlPath, organJournal, () => new Date('2026-11-02T10:00:00.000Z'));
    const currentStatePort = createJsonlRuntimeTaskCurrentStateJournal({ journal: organJournal });

    const testBinding = {
      bindingId: 'binding-w2a',
      providerId: 'provider-w2a',
      protocol: 'responses' as const,
      endpointRef: 'http://127.0.0.1:4444/v1/responses',
      modelRef: 'gpt-5.4',
      configDigest: `sha256:${'1'.repeat(64)}`,
      capabilityDigest: `sha256:${'2'.repeat(64)}`,
      capabilities: ['execute'] as const,
    };

    const service = new UiRuntimeService({
      mode: 'rcc',
      organId,
      binding: testBinding,
      port: createFakeExecutionPort(testBinding),
      closurePort: new UiRuntimeJournal(join(dir, 'ui-runtime.jsonl')),
      memory: {
        coordinator: new MemoryCoordinator(),
        backend: new DeterministicMemoryBackend(),
        projectKey: 'w2a-test',
        roleId: 'execution',
      },
      checkpointStoreFor: () => store,
      attentionPort: noopAttentionPort,
      providerState: 'ready',
      taskIdentity: new TaskIdentityConsumer(new JsonlTaskIdentityJournal(organJournal)),
      explicitBrainInterpreter: {
        async interpret() {
          return {
            kind: 'requirement',
            intent: 'create',
            normalizedInput: 'Trigger invalid planner decision schema',
            proposal: 'Trigger invalid planner decision schema',
            knownFacts: [],
            decisionRefs: [],
            structuredProposal: {
              revision: 1,
              intent: 'create',
              title: 'Invalid planner schema test',
              objective: 'Trigger invalid planner decision schema',
              deliverable: 'Error receipt',
              deliveryConditions: ['surface invalid schema error'],
              evidenceRefs: [],
              blockingGaps: [],
            },
          };
        },
      },
      runtimeComposition: {
        createTaskAssembly: () => createStubTaskAssembly(),
        admitExecution: async () => {},
        orchestratorDecisionPort: {
          decide: (input) =>
            input.phase === 'initial'
              ? {
                  decision: 'continue',
                  step: {
                    kind: 'explore',
                    targetAgentRole: 'execution',
                    effectPolicy: 'readonly',
                    objective: 'Explore before invalid post-step decision',
                  },
                }
              : ({ decision: 'invalid-json-decision' } as unknown as ReturnType<NonNullable<NonNullable<ConstructorParameters<typeof UiRuntimeService>[0]['runtimeComposition']>['orchestratorDecisionPort']>['decide']>),
        },
        createExecutionPorts: () => ({
          admitExecution: async () => {},
          createDriver: async (driverInput: RuntimeExecutionDriverInput) => createNativeStandardTurnDriver(driverInput, store),
          currentStatePort,
          currentStateFacts: knownCurrentStateFacts,
          executionPlanRevisionPort: planConsumer,
        } as unknown as ReturnType<NonNullable<NonNullable<ConstructorParameters<typeof UiRuntimeService>[0]['runtimeComposition']>['createExecutionPorts']>>),
      },
    });

    const interactionId = await service.receiveExplicitInput({
      sourceRef: 'ui:new-task-create',
      rawInput: 'Trigger invalid planner decision schema',
      channel: 'business',
      requestKind: 'new-task-create',
    });
    await service.interpretExplicitInput({ interactionId });
    const preview = await service.inspectExplicitInteraction(interactionId);
    await service.confirmExplicitRequirement({
      interactionId,
      draftId: preview.draft!.draftId,
      inputRevision: preview.draft!.inputRevision,
      confirmationRef: 'confirm:w2a-invalid-schema',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-11-02T10:00:00.000Z',
      payloadRef: 'asset://w2a-invalid-schema',
      requestKind: 'new-task-create',
    });
    const dispatched = await service.dispatchNextExplicitRequirement();
    const taskId = dispatched.taskId;
    const deadline = Date.now() + 5000;
    while (service.taskDashboard(taskId).state === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 25));

    const obs = await service.scopedObservation(taskId, 'task.correlate-or-create');
    assert.equal(obs.agentDebugInspections.length, 5);
    for (const inspection of obs.agentDebugInspections) {
      validateAgentDebugInspection(inspection);
    }
    const orchDebug = obs.agentDebugInspections.find((item) => item.agentRole === 'orchestration');
    assert.ok(orchDebug);
    assert.equal(orchDebug!.invocationStatus, 'failed');
    assert.equal(orchDebug!.error.state, 'present');
    assert.equal(orchDebug!.error.code, 'orchestrator.decision.invalid-schema');
    assert.equal(orchDebug!.context.state, 'data-not-collected');
    assert.ok(orchDebug!.error.readonlyNextActionHint);
    assert.equal(obs.selectedNode?.debugInspection?.agentRole, 'orchestration');
  } finally {
    await new Promise((r) => setTimeout(r, 25));
    await rm(dir, { recursive: true, force: true });
  }
});
