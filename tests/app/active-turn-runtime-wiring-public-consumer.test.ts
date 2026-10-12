import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type ActiveTurnBinding,
  type Attention,
  type Checkpoint,
  type EvidenceRef,
  type ProviderBinding,
  type RawAsset,
  type ScopeRef,
  type TaskId,
  type WorkAssignment,
  type WorkResult,
} from '../../packages/contracts/src/index.js';
import {
  FileCheckpointStore,
  FakeReplayExecutionRuntimePort,
  UiRuntimeJournal,
  UiRuntimeService,
  type TaskCheckpointStore,
} from '../../packages/app/src/ui-runtime/index.js';
import { FileActiveTurnJournal } from '../../packages/app/src/ui-runtime/journal.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';
import type { CheckpointAppendReceipt } from '../../packages/runtime/src/checkpoints/ports.js';
import { produceAdmittedTurn, type RuntimeBindingSnapshot } from '../../packages/runtime/src/admission/admitted-turn.js';
import { ActiveTurnContext, RuntimeActiveTurnError } from '../../packages/runtime/src/context/active-turn-context.js';
import type { ActiveTurnJournalPort, ActiveTurnJournalRecord } from '../../packages/runtime/src/context/active-turn-journal.js';
import {
  AgentRuntimePoolManager,
  OrchestrationManager,
  type ExecutionAgentPort,
  type MergeCoordinatorPort,
  type ReviewAgentPort,
} from '../../packages/runtime/src/orchestration/index.js';
import type { RefinedDeliveryStore } from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { MemoryCoordinator, type AttentionPort } from '../../packages/runtime/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import type { ExplicitBrainInputInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';

const organId = id('organ', 'organ-active-turn-test');
const binding: ProviderBinding = {
  bindingId: 'binding-active-turn-test',
  providerId: 'provider-active-turn-test',
  protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-active-turn-test',
  configDigest: 'sha256:active-turn-test-config',
  capabilityDigest: 'sha256:active-turn-test-capability',
};
const permissionSnapshot: RuntimeBindingSnapshot = {
  runtimeId: 'active-turn-runtime-0',
  executionEpoch: 1,
  ownerRef: 'active-turn-test',
  permissionRevision: 'perm-rev-1',
};

const unusedExplicitBrainInterpreter: ExplicitBrainInputInterpreter = {
  async interpret() {
    throw new Error('explicit brain interpretation is not configured for this test');
  },
};

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

function evidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `active-turn-${label}`),
    kind: 'operation',
    source: 'active-turn-test',
    locator: `test://${label}`,
    scope,
  };
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

// Confirms one explicit requirement through the real service owner so the FIFO
// consumer dispatches through the same production admission path.
async function confirmRequirement(service: UiRuntimeService, suffix: string): Promise<void> {
  const interactionId = await service.receiveExplicitInput({
    sourceRef: `ui:${suffix}`,
    rawInput: `confirmed requirement ${suffix}`,
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: `confirmed requirement ${suffix}`,
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: `create ${suffix} work`,
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${suffix}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-12T00:00:00.000Z',
    payloadRef: `asset://requirements/${suffix}`,
  });
}

// Durable store for refined child delivery assets. The bytes are only reachable
// through the descriptor the store returns; the parent never copies a raw
// child transcript.
class MemoryRefinedDeliveryStore implements RefinedDeliveryStore {
  private readonly byDigest = new Map<string, Uint8Array>();

  async store(input: { readonly scope: ScopeRef; readonly invocationId: string; readonly bytes: Uint8Array }): Promise<RawAsset> {
    const digest = `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`;
    this.byDigest.set(digest, input.bytes);
    return {
      ref: {
        evidenceId: id('evidence', `delivery-${input.invocationId.replace(/[^A-Za-z0-9._-]/g, '-')}`),
        kind: 'operation',
        source: 'active-turn-test',
        locator: `delivery://${input.invocationId}`,
        digest,
        scope: input.scope,
      },
      view: { kind: 'utf8-text' },
    };
  }

  async read(asset: RawAsset): Promise<Uint8Array> {
    const bytes = asset.ref.digest === undefined ? undefined : this.byDigest.get(asset.ref.digest);
    if (!bytes) throw new Error(`missing refined delivery ${asset.ref.evidenceId.value}`);
    return bytes;
  }
}

// Fails only the selected child-call checkpoint append, so the pre-dispatch
// recovery anchor cannot be committed while other checkpoints still succeed.
function failingChildCallCheckpointStore(
  inner: FileCheckpointStore,
  failOn: 'first' | 'second' | 'third',
): TaskCheckpointStore {
  let childCallAppends = 0;
  return {
    verify: (scope) => inner.verify(scope),
    readLatest: (scope) => inner.readLatest(scope),
    append: async (input): Promise<CheckpointAppendReceipt> => {
      const isChildCall = String(input.commitId).includes('child-call-');
      const isReviewResult = input.checkpoint.id.value.includes('review-result-');
      if (failOn === 'third' && isReviewResult) {
        throw new Error('checkpoint store unavailable');
      }
      if (failOn !== 'third' && isChildCall) {
        childCallAppends += 1;
        const shouldFail = failOn === 'first' ? childCallAppends === 1 : childCallAppends === 2;
        if (shouldFail) throw new Error('checkpoint store unavailable');
      }
      return inner.append(input);
    },
    commit: (checkpoint) => inner.commit(checkpoint),
  };
}

// Fails only the child-invocation association append, so the call checkpoint is
// committed but the invocation/checkpoint association is not.
function failingInvocationJournal(inner: FileActiveTurnJournal): ActiveTurnJournalPort {
  return {
    append: async (input) => {
      if (input.commitId.includes(':invocation:')) throw new Error('active turn journal unavailable');
      return inner.append(input);
    },
    replay: () => inner.replay(),
  };
}

function runtimePool(): AgentRuntimePoolManager {
  return new AgentRuntimePoolManager({
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
    ownerId: 'active-turn-test',
    initialRuntimes: [{
      runtimeId: 'active-turn-runtime-0',
      generation: 1,
      capabilities: ['code.search', 'file.checkpoint', 'provider.execution'],
    }],
  });
}

function passingReviewAgent(
  onReview: (input: Parameters<ReviewAgentPort['review']>[0]) => void | Promise<void>,
): ReviewAgentPort {
  return {
    async review(input) {
      await onReview(input);
      return {
        resultId: `review-${input.reviewAssignment.assignmentId}`,
        assignmentId: input.reviewAssignment.assignmentId,
        taskId: input.reviewAssignment.taskId,
        workerAgentId: input.reviewAssignment.workerAgentId,
        reviewKind: input.reviewAssignment.reviewKind,
        attempt: input.reviewAssignment.attempt,
        executionEpoch: input.reviewAssignment.executionEpoch,
        inputRevision: input.reviewAssignment.inputRevision,
        acceptanceCriteriaDigest: input.reviewAssignment.acceptanceCriteriaDigest,
        subjectRefs: [...input.reviewAssignment.subjectRefs],
        subjectDigests: [...input.reviewAssignment.subjectDigests],
        status: 'passed' as const,
        findings: [],
        evidenceRefs: [evidence('review', input.scope)],
      };
    },
  };
}

const mergeCoordinator: MergeCoordinatorPort = {
  async merge(request) {
    return {
      status: 'merged',
      evidenceRefs: [
        ...request.workerResult.evidenceRefs,
        ...request.reviewResults.flatMap((review) => review.evidenceRefs),
        evidence('merge', request.scope),
      ],
    };
  },
};

function workAssignment(taskId: TaskId, scope: ScopeRef, pipelineNodeId: string, attempt = 1, executionEpoch = 1): WorkAssignment {
  return {
    assignmentId: 'assignment-active-turn-1',
    taskId,
    pipelineNodeId,
    attempt,
    executionEpoch,
    inputRevision: 1,
    objective: 'active turn reconstruction',
    targetRefs: ['operation://active-turn-1/output'],
    expectedOutputRefs: ['operation://active-turn-1/output'],
    acceptanceCriteriaDigest: 'sha256:active-turn-criteria',
    successCriteria: ['active turn settles'],
    failureCriteria: ['active turn fails'],
    incompleteCriteria: ['active turn waits'],
    requiredCapabilities: ['provider.execution'],
    mergeGate: 'required',
  };
}

function workResult(taskId: TaskId, assignment: WorkAssignment): WorkResult {
  return {
    taskId,
    pipelineNodeId: assignment.pipelineNodeId,
    agentId: 'active-turn-child',
    assignmentId: assignment.assignmentId,
    attempt: assignment.attempt,
    executionEpoch: assignment.executionEpoch,
    inputRevision: assignment.inputRevision,
    producedArtifactRefs: [],
    producedArtifactDigests: [],
    status: 'succeeded',
    summary: 'child refined delivery',
    outputRefs: [...assignment.expectedOutputRefs],
    evidenceRefs: [evidence('child', { organId, taskId })],
    nextAction: 'continue',
  };
}

test('behavior 1: FIFO admission persists the binding and call checkpoint before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-active-turn-dispatch-'));
  const activeTurnJournal = new FileActiveTurnJournal(join(root, 'active-turn.jsonl'));
  const refinedDeliveryStore = new MemoryRefinedDeliveryStore();
  const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  let executionCalls = 0;
  let reviewCalls = 0;
  let executionDispatch: { readonly invocationId: string; readonly receiptRef: string; readonly latestCheckpointId: string } | undefined;
  let reviewDispatch: { readonly invocationId: string; readonly receiptRef: string; readonly latestCheckpointId: string } | undefined;
  let checkpointStore: FileCheckpointStore | undefined;
  try {
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port,
      checkpointStoreFor: (taskId, cycleId) => {
        checkpointStore = new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`));
        return checkpointStore;
      },
      attentionPort: attentionPort(),
      providerState: 'ready',
      journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
      closurePort: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
      memory: testMemory('project-active-turn-dispatch'),
      explicitBrainInterpreter: unusedExplicitBrainInterpreter,
      activeTurnJournal,
      permissionSnapshot,
      refinedDeliveryStore,
      runtimeComposition: {
        createTaskAssembly({ scope, checkpointJournal, executionAgent, maxAttempts, childCallPort }) {
          const pool = runtimePool();
          // Each child port call confirms its own durable recovery anchor and
          // invocation association. The receipt binds to that invocation, not to
          // a fixed role order or a turn-wide latest checkpoint.
          const recordingExecutionAgent: ExecutionAgentPort = {
            async execute(input) {
              executionCalls += 1;
              const invocationId = `invocation:${input.assignment.assignmentId}:${input.assignment.attempt}:${input.assignment.executionEpoch}`;
              const records = await activeTurnJournal.replay();
              const invocation = records.find((record) => record.kind === 'child-invocation' && record.record.invocationId === invocationId);
              if (!invocation || invocation.kind !== 'child-invocation') {
                throw new Error('execution dispatch ran without a durable invocation association');
              }
              const latest = await checkpointJournal.readLatest(scope);
              if (!latest) throw new Error('execution dispatch ran without a durable call checkpoint');
              executionDispatch = {
                invocationId,
                receiptRef: invocation.record.checkpointReceiptRef,
                latestCheckpointId: latest.checkpoint.id.value,
              };
              return executionAgent!.execute(input);
            },
          };
          const orchestration = new OrchestrationManager({
            ownerId: 'active-turn-test',
            runtimePool: pool,
            executionAgent: recordingExecutionAgent,
            reviewAgent: passingReviewAgent(async (input) => {
              reviewCalls += 1;
              const invocationId = `invocation:review:${input.reviewAssignment.assignmentId}:${input.reviewAssignment.attempt}`;
              const records = await activeTurnJournal.replay();
              const invocation = records.find((record) => record.kind === 'child-invocation' && record.record.invocationId === invocationId);
              if (!invocation || invocation.kind !== 'child-invocation') {
                throw new Error('review dispatch ran without a durable invocation association');
              }
              if (invocation.record.binding.kind !== 'review'
                || invocation.record.binding.assignment.assignmentId !== input.reviewAssignment.assignmentId
                || invocation.record.binding.assignment.taskId !== input.reviewAssignment.taskId
                || invocation.record.binding.assignment.attempt !== input.reviewAssignment.attempt
                || invocation.record.binding.assignment.executionEpoch !== input.reviewAssignment.executionEpoch
                || invocation.record.binding.assignment.inputRevision !== input.reviewAssignment.inputRevision) {
                throw new Error('the review invocation must persist its own review binding');
              }
              const latest = await checkpointJournal.readLatest(scope);
              if (!latest) throw new Error('review dispatch ran without a durable call checkpoint');
              reviewDispatch = {
                invocationId,
                receiptRef: invocation.record.checkpointReceiptRef,
                latestCheckpointId: latest.checkpoint.id.value,
              };
            }),
            mergeCoordinator,
            maxAttempts: maxAttempts ?? 1,
            ...(childCallPort === undefined ? {} : { childCallPort }),
          });
          return { orchestration, runtimePool: pool };
        },
      },
    });
    service.startImplicitConsumer();
    await confirmRequirement(service, 'active-turn-dispatch');
    await waitFor(() => assert.equal(service.listTasks().completed[0]?.state, 'succeeded'));

    assert.equal(executionCalls, 1, 'the execution port must be called exactly once');
    assert.equal(reviewCalls, 1, 'the review port must be called exactly once');
    assert.ok(executionDispatch, 'the execution port must observe its own durable recovery anchor');
    assert.equal(executionDispatch!.latestCheckpointId, executionDispatch!.receiptRef, 'the committed checkpoint must match the execution invocation receipt');
    assert.ok(reviewDispatch, 'the review port must observe its own durable recovery anchor');
    assert.equal(reviewDispatch!.latestCheckpointId, reviewDispatch!.receiptRef, 'the committed checkpoint must match the review invocation receipt');
    assert.ok(reviewDispatch!.receiptRef !== executionDispatch!.receiptRef, 'each real child call gets its own call checkpoint');

    const taskId = service.listTasks().completed[0]!.taskId;
    const capture = service.activeTurnCapture(taskId, 'pause-1');
    assert.ok(capture, 'the opened active turn must be readable from durable facts');
    assert.equal(capture!.binding.admittedTurn.workAssignmentRef, capture!.binding.assignment.assignmentId);
    assert.equal(capture!.binding.assignment.taskId.value, taskId.value);
    assert.ok(capture!.binding.scope.cycleId, 'the binding must carry the execution cycle');
    assert.equal(capture!.binding.execution.runtimeId, permissionSnapshot.runtimeId);
    assert.equal(capture!.binding.execution.executionEpoch, capture!.binding.assignment.executionEpoch);
    assert.equal(capture!.binding.admittedTurn.permissionRevision, permissionSnapshot.permissionRevision);

    const durable = await activeTurnJournal.replay();
    const opened = durable.find((record) => record.kind === 'binding-opened');
    if (!opened || opened.kind !== 'binding-opened') throw new Error('no durable binding-opened record');
    assert.equal(opened.binding.admittedTurn.turnId, capture!.binding.admittedTurn.turnId);

    // Locate each historical call checkpoint by its own invocation receipt. The
    // execution checkpoint is no longer the scope's latest after the later review
    // call, and that must not matter.
    const executionInvocation = durable
      .filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-invocation' }> => (
        record.kind === 'child-invocation' && record.record.invocationId === executionDispatch!.invocationId
      ))
      .at(-1);
    if (!executionInvocation) throw new Error('no durable execution invocation record');
    assert.equal(executionInvocation.record.checkpointReceiptRef, executionDispatch!.receiptRef, 'the execution invocation stays bound to its own call checkpoint receipt');
    const reviewInvocation = durable
      .filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-invocation' }> => (
        record.kind === 'child-invocation' && record.record.invocationId === reviewDispatch!.invocationId
      ))
      .at(-1);
    if (!reviewInvocation) throw new Error('no durable review invocation record');
    assert.equal(reviewInvocation.record.checkpointReceiptRef, reviewDispatch!.receiptRef, 'the review invocation stays bound to its own call checkpoint receipt');
    const reviewDeliveries = durable.filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-delivery' }> => (
      record.kind === 'child-delivery' && record.entry.invocationId === reviewDispatch!.invocationId
    ));
    assert.equal(reviewDeliveries.length, 1, 'the reviewer result must be durably returned before adoption');
    assert.equal(reviewDeliveries[0]!.entry.kind, 'review', 'the reviewer return must stay a ReviewResult');
    const reviewEntry = reviewDeliveries[0]!.entry;
    if (reviewEntry.kind !== 'review') throw new Error('expected a review delivery entry');
    assert.equal(reviewInvocation.record.adoptedResultSeq, reviewDeliveries[0]!.entry.seq, 'the review adoption must reference the returned delivery');
    assert.ok(reviewInvocation.record.postReviewCheckpointRef, 'the review must have its own post-review checkpoint reference');
    assert.ok(reviewInvocation.record.postReviewCheckpointRef !== reviewInvocation.record.checkpointReceiptRef, 'the post-review checkpoint must not reuse the pre-call checkpoint');
    assert.ok(checkpointStore, 'the service must assemble the checkpoint store');
    const postReviewCheckpoint = await checkpointStore!.readLatest(capture!.binding.scope);
    assert.ok(postReviewCheckpoint, 'the post-review checkpoint reference must resolve from the persistent checkpoint journal');
    assert.equal(postReviewCheckpoint!.checkpoint.id.value, reviewInvocation.record.postReviewCheckpointRef, 'the durable checkpoint journal must resolve the review result reference');
    assert.equal(postReviewCheckpoint!.checkpoint.next.ref, `review-result:${reviewEntry.result.resultId}`, 'the checkpoint exposes the persisted review-result identity');
    assert.ok(postReviewCheckpoint!.checkpoint.id.value !== reviewInvocation.record.checkpointReceiptRef, 'the result checkpoint is independent of the call checkpoint');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type BlockedDispatchFailure = 'execution-checkpoint' | 'review-checkpoint' | 'review-result-checkpoint' | 'association';

// Runs one orchestrated dispatch whose child-call checkpoint or invocation
// association append fails, and reports the real port calls and durable facts.
async function runBlockedDispatch(
  failure: BlockedDispatchFailure,
  expected: 'failed' | 'waiting',
): Promise<{
  readonly executionCalls: number;
  readonly reviewCalls: number;
  readonly durable: readonly ActiveTurnJournalRecord[];
}> {
  const root = await mkdtemp(join(tmpdir(), `humanagent-active-turn-blocked-${failure}-`));
  const rawJournal = new FileActiveTurnJournal(join(root, 'active-turn.jsonl'));
  const activeTurnJournal: ActiveTurnJournalPort = failure === 'association' ? failingInvocationJournal(rawJournal) : rawJournal;
  const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  let executionCalls = 0;
  let reviewCalls = 0;
  try {
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port,
      checkpointStoreFor: (taskId, cycleId) => {
        const inner = new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`));
    if (failure === 'association') return inner;
    return failingChildCallCheckpointStore(inner, failure === 'execution-checkpoint' ? 'first' : failure === 'review-checkpoint' ? 'second' : 'third');
      },
      attentionPort: attentionPort(),
      providerState: 'ready',
      journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
      closurePort: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
      memory: testMemory(`project-active-turn-blocked-${failure}`),
      explicitBrainInterpreter: unusedExplicitBrainInterpreter,
      activeTurnJournal,
      permissionSnapshot,
      refinedDeliveryStore: new MemoryRefinedDeliveryStore(),
      runtimeComposition: {
        createTaskAssembly({ executionAgent, maxAttempts, childCallPort }) {
          const pool = runtimePool();
          const recordingExecutionAgent: ExecutionAgentPort = {
            async execute(input) {
              executionCalls += 1;
              return executionAgent!.execute(input);
            },
          };
          const orchestration = new OrchestrationManager({
            ownerId: 'active-turn-test',
            runtimePool: pool,
            executionAgent: recordingExecutionAgent,
            reviewAgent: passingReviewAgent(() => { reviewCalls += 1; }),
            mergeCoordinator,
            maxAttempts: maxAttempts ?? 1,
            ...(childCallPort === undefined ? {} : { childCallPort }),
          });
          return { orchestration, runtimePool: pool };
        },
      },
    });
    service.startImplicitConsumer();
    await confirmRequirement(service, `active-turn-blocked-${failure}`);
    // A blocked dispatch settles into `failed` when no child ran, and into
    // `blocked` (waiting) when a legitimate child call already completed.
    await waitFor(() => {
      const tasks = service.listTasks();
      const settled = expected === 'failed' ? tasks.failed.length : tasks.waiting.length;
      assert.equal(settled, 1, `the blocked dispatch must settle into ${expected}`);
    });
    return { executionCalls, reviewCalls, durable: await rawJournal.replay() };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('behavior 1 red: a failed call checkpoint or invocation association blocks the corresponding dispatch', async () => {
  // The first child call has no recovery anchor: no child port may run.
  const executionCheckpoint = await runBlockedDispatch('execution-checkpoint', 'failed');
  assert.equal(executionCheckpoint.executionCalls, 0, 'no execution may run without a committed call checkpoint');
  assert.equal(executionCheckpoint.reviewCalls, 0, 'no review may run when the first call checkpoint failed');
  assert.ok(executionCheckpoint.durable.some((record) => record.kind === 'binding-opened'), 'the isolated recovery anchor is durable even though the checkpoint append failed');
  assert.ok(!executionCheckpoint.durable.some((record) => record.kind === 'child-invocation'));

  // The review call checkpoint fails after a legitimate execution: the review
  // port must not run and the completed execution must not be erased.
  const reviewCheckpoint = await runBlockedDispatch('review-checkpoint', 'waiting');
  assert.equal(reviewCheckpoint.executionCalls, 1, 'the first child call still runs');
  assert.equal(reviewCheckpoint.reviewCalls, 0, 'the blocked review call must not run');
  assert.ok(reviewCheckpoint.durable.some((record) => record.kind === 'child-delivery'), 'the completed execution delivery is preserved');

  // The association append fails after the checkpoint: the child port must not run.
  const association = await runBlockedDispatch('association', 'failed');
  assert.equal(association.executionCalls, 0, 'no execution may run without a durable invocation association');
  assert.equal(association.reviewCalls, 0, 'no review may run without a durable invocation association');
  assert.ok(association.durable.some((record) => record.kind === 'binding-opened'));
  assert.ok(!association.durable.some((record) => record.kind === 'child-invocation'));

  // The review result checkpoint fails after return/adoption: the returned and
  // adopted review delivery remains durable, but no alignment-usable
  // post-review checkpoint reference is exposed.
  const resultCheckpoint = await runBlockedDispatch('review-result-checkpoint', 'waiting');
  assert.equal(resultCheckpoint.executionCalls, 1, 'the execution completed before the failed review checkpoint');
  assert.equal(resultCheckpoint.reviewCalls, 1, 'the reviewer returned before the result checkpoint failed');
  const reviewDeliveries = resultCheckpoint.durable.filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-delivery' }> => (
    record.kind === 'child-delivery' && record.entry.kind === 'review'
  ));
  assert.equal(reviewDeliveries.length, 1, 'the review return remains durable');
  const reviewAdoptionRecords = resultCheckpoint.durable.filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-invocation' }> => (
    record.kind === 'child-invocation'
    && record.record.adoptedResultSeq === reviewDeliveries[0]!.entry.seq
  ));
  assert.equal(reviewAdoptionRecords.length, 1, 'the review adoption remains durable');
  assert.equal(reviewAdoptionRecords[0]!.record.postReviewCheckpointRef, undefined, 'no post-review checkpoint may be exposed when its commit failed');
});

test('behavior 2: refined child delivery is returned, then adopted, and never pollutes the parent with raw facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-active-turn-child-'));
  const activeTurnJournal = new FileActiveTurnJournal(join(root, 'active-turn.jsonl'));
  const refinedDeliveryStore = new MemoryRefinedDeliveryStore();
  const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  try {
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port,
      checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
      attentionPort: attentionPort(),
      providerState: 'ready',
      journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
      closurePort: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
      memory: testMemory('project-active-turn-child'),
      explicitBrainInterpreter: unusedExplicitBrainInterpreter,
      activeTurnJournal,
      permissionSnapshot,
      refinedDeliveryStore,
      runtimeComposition: {
        createTaskAssembly({ scope, checkpointJournal, executionAgent, maxAttempts, childCallPort }) {
          const pool = runtimePool();
          const orchestration = new OrchestrationManager({
            ownerId: 'active-turn-test',
            runtimePool: pool,
            executionAgent: executionAgent!,
            reviewAgent: passingReviewAgent(() => {}),
            mergeCoordinator,
            maxAttempts: maxAttempts ?? 1,
            ...(childCallPort === undefined ? {} : { childCallPort }),
          });
          return { orchestration, runtimePool: pool };
        },
      },
    });
    service.startImplicitConsumer();
    await confirmRequirement(service, 'active-turn-child');
    await waitFor(() => assert.equal(service.listTasks().completed[0]?.state, 'succeeded'));
    const taskId = service.listTasks().completed[0]!.taskId;

    const capture = service.activeTurnCapture(taskId, 'pause-2');
    assert.ok(capture);
    // Select the execution delivery from its persisted binding. The parent may
    // also carry the review delivery after W1-4; neither may be confused with a
    // Provider raw fact.
    const delivery = capture!.entries.find((entry) => !('envelope' in entry) && entry.kind === 'execution');
    if (!delivery || 'envelope' in delivery) {
      throw new Error('the parent must accept the refined child delivery, never a Provider raw fact');
    }
    assert.equal(delivery.result.status, 'succeeded');
    const bytes = await refinedDeliveryStore.read(delivery.refinedDelivery);
    const refined = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(refined).sort(),
      ['assignmentId', 'attempt', 'executionEpoch', 'producedArtifactBodies', 'status', 'summary'].sort(),
      'the refined delivery is a bounded projection, not the child raw transcript',
    );
    assert.ok(!JSON.stringify(refined).includes('executorEvidence'));

    const durable = await activeTurnJournal.replay();
    const invocationRecords = durable.filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-invocation' }> => (
      record.kind === 'child-invocation' && record.record.invocationId === delivery.invocationId
    ));
    assert.equal(invocationRecords.length, 2, 'invocation intent and adoption are separate durable facts');
    assert.ok(invocationRecords[0]!.record.adoptedResultSeq === undefined, 'the intent record must not claim adoption');
    assert.equal(invocationRecords[1]!.record.adoptedResultSeq, delivery.seq, 'adoption must reference the returned delivery seq');
    const deliveries = durable.filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-delivery' }> => (
      record.kind === 'child-delivery' && record.entry.invocationId === delivery.invocationId
    ));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.entry.seq, delivery.seq);

    // Identity guard: a result with the wrong assignment or epoch must not enter
    // the parent, so the dispatch association cannot be silently rebound.
    const rebuilt = await ActiveTurnContext.reconstruct(new FileActiveTurnJournal(join(root, 'active-turn.jsonl')), capture!.binding.admittedTurn.turnId);
    const assignment = capture!.binding.assignment;
    const goodResult = workResult(taskId, assignment);
    const dummyAsset: RawAsset = delivery.refinedDelivery;
    await assert.rejects(
      () => rebuilt.recordChildReturn({
        kind: 'execution',
        invocationId: delivery.invocationId,
        refinedDelivery: dummyAsset,
        assignment: { ...assignment, assignmentId: 'assignment-wrong' },
        result: { ...goodResult, assignmentId: 'assignment-wrong' },
      }),
      (error: unknown) => error instanceof RuntimeActiveTurnError && error.code === 'active-turn.child.assignment-mismatch',
    );
    await assert.rejects(
      () => rebuilt.recordChildReturn({
        kind: 'execution',
        invocationId: delivery.invocationId,
        refinedDelivery: dummyAsset,
        assignment: { ...assignment, executionEpoch: assignment.executionEpoch + 1 },
        result: { ...goodResult, executionEpoch: goodResult.executionEpoch + 1 },
      }),
      (error: unknown) => error instanceof RuntimeActiveTurnError && error.code === 'active-turn.child.epoch-mismatch',
    );
    await assert.rejects(
      () => rebuilt.recordChildReturn({
        kind: 'execution',
        invocationId: delivery.invocationId,
        refinedDelivery: dummyAsset,
        assignment: { ...assignment, pipelineNodeId: 'stage-wrong' },
        result: goodResult,
      }),
      (error: unknown) => error instanceof RuntimeActiveTurnError && error.code === 'active-turn.child.assignment-mismatch',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('behavior 3: request chain, checkpoint and child delivery survive object reconstruction without re-dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-active-turn-replay-'));
  const activeTurnPath = join(root, 'active-turn.jsonl');
  const checkpointPath = join(root, 'checkpoints.jsonl');
  const taskId = id('task', 'active-turn-replay-task');
  const scope: ScopeRef = {
    organId,
    taskId,
    cycleId: id('cycle', 'active-turn-replay-cycle'),
    operationId: id('operation', 'active-turn-replay-operation'),
  };
  const refinedDeliveryStore = new MemoryRefinedDeliveryStore();
  try {
    const journal = new FileActiveTurnJournal(activeTurnPath);
    const checkpointStore = new FileCheckpointStore(checkpointPath);
    const assignment = workAssignment(taskId, scope, 'stage-active-turn-1');
    const admittedTurn = produceAdmittedTurn({
      runtime: { ...permissionSnapshot, executionEpoch: assignment.executionEpoch },
      taskId,
      scope,
      assignment,
      directiveRevision: 1,
      turnId: 'active-turn-1',
      currentTurnRef: 'active-turn://1/binding',
      admissionEvidence: [evidence('admission', scope)],
      recoveryStateRef: evidence('recovery', scope),
    });
    const activeBinding: ActiveTurnBinding = {
      admittedTurn,
      assignment,
      execution: { runtimeId: permissionSnapshot.runtimeId, executionEpoch: assignment.executionEpoch },
      scope,
    };
    const context = await ActiveTurnContext.open({ journal, binding: activeBinding, currentTurnRef: admittedTurn.currentTurnRef });
    await context.registerRequest({ request: { turnId: 'provider-turn-1', requestId: 'request-1' }, scope, phase: 'dispatched' });
    await context.registerRequest({
      request: { turnId: 'provider-turn-1', requestId: 'request-2', parentRequestId: 'request-1' },
      parentRequestId: 'request-1',
      scope,
      phase: 'dispatched',
    });

    const checkpoint: Checkpoint = {
      id: id('checkpoint', 'child-call-1'),
      scope,
      cycleId: scope.cycleId!,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: assignment.executionEpoch,
      outcome: 'waiting',
      summary: 'child call dispatched after a durable recovery anchor',
      recoveryStateRef: evidence('child-recovery', scope),
      evidenceRefs: [evidence('child-intent', scope)],
      next: { kind: 'wait', ref: 'child-invocation:1' },
    };
    await checkpointStore.append({ ownerId: 'active-turn-test', commitId: checkpointCommitId(checkpoint), checkpoint });

    await context.openChildInvocation({
      invocationId: 'invocation-1',
      childTurnId: 'child-turn-1',
      checkpointReceiptRef: checkpoint.id.value,
      binding: { kind: 'execution', assignment },
    });
    const refinedDelivery = await refinedDeliveryStore.store({
      scope,
      invocationId: 'invocation-1',
      bytes: new TextEncoder().encode(JSON.stringify({ assignmentId: assignment.assignmentId, status: 'succeeded' })),
    });
    const delivery = await context.recordChildReturn({
      kind: 'execution',
      invocationId: 'invocation-1',
      refinedDelivery,
      assignment,
      result: workResult(taskId, assignment),
    });
    await context.recordChildAdoption('invocation-1', delivery);

    // Drop every live object; rebuild only from the persistent root.
    const rebuiltJournal = new FileActiveTurnJournal(activeTurnPath);
    const rebuiltCheckpointStore = new FileCheckpointStore(checkpointPath);
    const linesBeforeReplay = (await rebuiltJournal.replay()).length;
    const rebuilt = await ActiveTurnContext.reconstruct(rebuiltJournal, admittedTurn.turnId);
    assert.equal(rebuilt.admittedTurn.turnId, 'active-turn-1');
    assert.equal(rebuilt.admittedTurn.workAssignmentRef, assignment.assignmentId);
    assert.equal(rebuilt.activeBinding.assignment.assignmentId, assignment.assignmentId);
    assert.equal(rebuilt.activeBinding.execution.runtimeId, permissionSnapshot.runtimeId);
    assert.equal(rebuilt.activeBinding.execution.executionEpoch, assignment.executionEpoch);
    assert.equal(rebuilt.admittedTurn.permissionRevision, permissionSnapshot.permissionRevision);

    const requests = rebuilt.requests();
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.request.requestId, 'request-1');
    assert.equal(requests[1]!.request.requestId, 'request-2');
    assert.equal(requests[1]!.request.parentRequestId, 'request-1');
    assert.equal(requests[1]!.parentRequestId, 'request-1');

    const invocations = rebuilt.childInvocations();
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]!.checkpointReceiptRef, checkpoint.id.value);
    assert.equal(invocations[0]!.adoptedResultSeq, delivery.seq);

    const rebuiltDelivery = rebuilt.entries()[0]!;
    if ('envelope' in rebuiltDelivery) throw new Error('expected a child delivery entry after reconstruction');
    assert.equal(rebuiltDelivery.seq, delivery.seq);
    assert.equal(rebuiltDelivery.invocationId, 'invocation-1');
    const rebuiltBytes = await refinedDeliveryStore.read(rebuiltDelivery.refinedDelivery);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(rebuiltBytes)), { assignmentId: assignment.assignmentId, status: 'succeeded' });

    const latest = await rebuiltCheckpointStore.readLatest(scope);
    assert.ok(latest);
    assert.equal(latest!.checkpoint.id.value, checkpoint.id.value);
    // Cold read must not append a record or replay a side effect.
    assert.equal((await rebuiltJournal.replay()).length, linesBeforeReplay, 'reconstruction must not write or re-dispatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
