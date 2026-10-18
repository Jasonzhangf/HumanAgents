import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  checkpointCommitIdentityV2,
  checkpointIntentDigestV1,
  checkpointRefV2,
  id,
  scopeDigest,
  type AgentLoopCheckpointRef,
  type AgentModeCapabilityProfile,
  type CheckpointReceiptRelationshipV1,
  type ContextHistoryRecord,
  type I2Record,
  type JournalCommitRef,
  type ObservationBatch,
  type ObservationDelta,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import { AgentLoopRuntime, type AgentLoopActor, type AgentLoopStartRequest } from '../../../packages/runtime/src/agent-loop/runtime.js';
import { AgentLoopRuntimeError } from '../../../packages/runtime/src/agent-loop/errors.js';
import {
  InspectionTurnBoundary,
  type InspectionOccurrenceFacts,
} from '../../../packages/runtime/src/agent-loop/inspection-turn-boundary.js';
import { createInspectionRuntimeHelpers, type InspectionRuntimeHelperDependencies } from '../../../packages/runtime/src/agent-loop/inspection-runtime-helpers.js';
import { createRuntimeInspectionStopSettlementPort } from '../../../packages/runtime/src/agent-loop/inspection-stop-completion.js';
import { createPublishedTaskPlanRevision } from '../../../packages/core/src/task-plan-revision.js';
import type {
  ActiveTurnCaptureBody,
  AcceptedExecutionChildDelivery,
  ChildInvocationRecord,
  InspectionExecutionOutcome,
  PlannerAlignmentReference,
  PublishedTaskPlanRevision,
  TurnCloseSummary,
  TurnClosureReference,
} from '../../../packages/contracts/src/index.js';
import type { ActiveTurnJournalRecord } from '../../../packages/runtime/src/context/active-turn-journal.js';
import type {
  CommittedCheckpointRecord,
  ContextHistoryPort,
  ContextHistoryReadQuery,
  ContextHistoryReadResult,
} from '../../../packages/runtime/src/checkpoints/ports.js';
import { turnBoundaryRecordRefs } from '../../../packages/runtime/src/checkpoints/closure.js';

const scope: ScopeRef = {
  organId: id('organ', 'organ-agent-loop'),
  taskId: id('task', 'task-agent-loop'),
  cycleId: id('cycle', 'cycle-agent-loop'),
};

function inspectionHelperConsumer() {
  const taskScope = { organId: scope.organId, taskId: scope.taskId! };
  const time = '2026-10-17T00:00:00.000Z';
  const receipt = (commitId: string, journalSeq = 1): JournalCommitRef => ({ commitId, journalSeq, recordDigest: `record:${commitId}` });
  const source = { requirementId: 'inspection', inputRevision: 1, draftId: 'inspection', draftRevisionVersion: 1,
    draftRevisionHash: 'draft:inspection', confirmationRef: 'confirmed:inspection' };
  const plan = createPublishedTaskPlanRevision({
    scope: taskScope, revisionId: 'inspection-plan-1', sequence: 1, predecessor: null,
    snapshot: { title: 'Inspect', summary: 'Inspect two checks', completeness: { scope: 'whole-task', status: 'complete' },
      acceptanceCriteria: [{ criterionId: 'observed', description: 'Report observed checks' }],
      nodes: [{ nodeId: 'inspect', kind: 'work', title: 'Inspect', intent: 'Observe', definition: {} }], phases: [], relations: [],
      inspectionDefinition: { definition: { definitionId: 'checks', definitionVersion: '1',
        target: { targetRef: 'target', sourceRef: 'confirmed' }, checkItems: [{ checkId: 'a' }, { checkId: 'b' }] },
        checks: [{ checkId: 'a', criterion: 'Observe a', inputRefs: [] }, { checkId: 'b', criterion: 'Observe b', inputRefs: [] }] } },
    source: { ...source, evidenceRefs: [] }, reason: { kind: 'initial', basisRefs: [] },
    historyCoverage: 'prior-history-unavailable', publishedAt: time, publishedBy: 'planner', journalCommitRef: 'jsonl:inspection-plan-1',
  });
  const plans = new Map<string, PublishedTaskPlanRevision>([[plan.revisionId, plan]]);
  const assignment = { assignmentId: 'inspection-assignment', taskId: taskScope.taskId, pipelineNodeId: 'inspect',
    attempt: 1, executionEpoch: 1, inputRevision: 1, objective: 'Inspect', targetRefs: [], expectedOutputRefs: [],
    successCriteria: ['observe'], failureCriteria: [], incompleteCriteria: [],
    requiredCapabilities: [], mergeGate: 'not-required' as const };
  const admittedTurn = { turnId: 'inspection-turn', workAssignmentRef: assignment.assignmentId, taskRef: taskScope.taskId,
    scopeRef: scope, cycleRef: scope.cycleId!, inputRevision: 1, directiveRevision: 1, executionEpoch: 1,
    runtimeBindingRef: 'binding', permissionRevision: 'permission', admissionEvidenceRefs: [], currentTurnRef: 'current', recoveryStateRef: 'recovery' };
  const raw = { ref: { evidenceId: id('evidence', 'inspection-raw'), kind: 'execution' as const, source: 'consumer', locator: 'raw', scope }, view: { kind: 'utf8-text' as const } };
  let capture: ActiveTurnCaptureBody = { version: 1, binding: { admittedTurn, assignment, execution: { runtimeId: 'runtime', executionEpoch: 1 },
    scope, acceptedPlan: { revisionId: plan.revisionId, revisionCommitRef: receipt(plan.revisionId) } }, initialInput: raw,
    entries: [], childInvocations: [], requests: [], checkpointPath: [], cut: { pauseId: 'boundary', lastSeq: 0, producersDrained: true, frozenAt: time }, completionRefs: [] };
  const entries: { record: I2Record; commitRef: JournalCommitRef }[] = [];
  let stopSource: Awaited<ReturnType<InspectionRuntimeHelperDependencies['resources']['forCheckpoint']>> = null;
  let committedCheckpoint: CommittedCheckpointRecord | null = null;
  let forbiddenTail = false;
  let failForCheckpoint = false;
  let rawJournal: readonly ActiveTurnJournalRecord[] = [];
  const resources = {
    logicalTurnId: admittedTurn.turnId, identity: { scope: taskScope, taskFlow: { kind: 'inspection' as const, definitionVersion: 1 as const },
      source, journalCommitRef: 'jsonl:identity' },
    journal: { replay: async () => { if (forbiddenTail) throw new Error('stop read mutable tail'); return rawJournal; } },
    segments: { readInitialSegmentSource: async () => ({ kind: 'captured' as const, body: capture, bindingCommitRef: receipt('binding') }),
      readSegments: async () => { if (forbiddenTail) throw new Error('stop scanned segments'); return []; }, readSegmentRecords: async () => [] },
  };
  const dependencies: InspectionRuntimeHelperDependencies = {
    resources: { forTurn: async (turnId) => turnId === resources.logicalTurnId ? resources : null,
      forInvocation: async () => resources,
      forCheckpoint: async () => {
        if (failForCheckpoint) throw new Error('ordinary stop must not read a physical capture');
        return stopSource;
      } },
    journal: { commit: async (record) => { const commitRef = receipt(`i2:${entries.length}`, entries.length + 1); entries.push({ record, commitRef }); return commitRef; },
      read: async (_scope, ref) => { const entry = entries.find((entry) => entry.commitRef.commitId === ref.commitId); if (!entry) throw new Error('missing exact record'); return entry.record; },
      list: async (query) => ({ entries: entries.filter(({ record }) => query.kinds?.includes(record.kind) ?? true) }) },
    plans: { get: async (_scope, revisionId) => plans.get(revisionId) ?? null,
      getCommitRef: async (_scope, revisionId) => plans.has(revisionId) ? receipt(revisionId) : null, list: async () => [...plans.values()] },
    checkpoints: { readCommitted: async () => committedCheckpoint, readCheckpointRecoveryBinding: async () => null },
    acceptedCheck: { accept: async (input) => input.delivery }, clock: { now: () => new Date(time) },
  };
  return { dependencies, resources, entries, plan, plans, receipt, assignment, raw, time,
    capture: () => capture, setCapture: (value: ActiveTurnCaptureBody) => { capture = value; },
    setRawJournal: (value: readonly ActiveTurnJournalRecord[]) => { rawJournal = value; },
    commitCheckpoint: (checkpoint: CommittedCheckpointRecord) => { committedCheckpoint = checkpoint; },
    failForCheckpoint: () => { failForCheckpoint = true; },
    stop: (checkpoint: CommittedCheckpointRecord, value: NonNullable<typeof stopSource>) => { committedCheckpoint = checkpoint; stopSource = value; forbiddenTail = true; },
    helpers: () => createInspectionRuntimeHelpers(dependencies) };
}

test('inspection runtime helpers preserve original accepted plan, reuse definition and replay typed captured delivery', async () => {
  // Concrete source failures: current-plan drift, definition duplication and captured-only child loss.
  // Probability demonstrated by the draft reader. Impact: wrong execution/history. Cost: one local public-port consumer.
  const f = inspectionHelperConsumer();
  const helper = f.helpers();
  const [context, concurrentContext] = await Promise.all([
    helper.selectionReader.readSelectionContext('inspection-turn'),
    helper.selectionReader.readSelectionContext('inspection-turn'),
  ]);
  assert.deepEqual(concurrentContext.cycleOpenedCommitRef, context.cycleOpenedCommitRef);
  assert.deepEqual(concurrentContext.cycleOpening, context.cycleOpening);
  const openings = f.entries.filter(({ record }) => record.kind === 'business-cycle-opened');
  assert.equal(openings.length, 1);
  const opening = openings[0]!;
  const openingRecord = opening.record;
  assert.equal(openingRecord.kind, 'business-cycle-opened');
  if (openingRecord.kind !== 'business-cycle-opened') throw new Error('unreachable');
  assert.deepEqual(opening.commitRef, context.cycleOpenedCommitRef);
  assert.deepEqual(await f.dependencies.journal.read(scope, context.cycleOpenedCommitRef), openingRecord);
  assert.deepEqual(openingRecord.cycle, { id: scope.cycleId!, scope, directiveRevision: 1, executionEpoch: 1,
    state: 'admitted' });
  assert.deepEqual(openingRecord.taskFlow, f.resources.identity.taskFlow);
  assert.deepEqual(openingRecord.planRevisionCommitRef, f.receipt(f.plan.revisionId));
  assert.equal(openingRecord.previousCycleCommitRef, null);
  assert.equal(openingRecord.openedAt, f.time);
  assert.equal(openingRecord.openingReason, 'Runtime first inspection selection for admitted cycle');
  assert.equal(f.entries.filter(({ record }) => record.kind === 'inspection-definition').length, 1);
  const reconstructed = f.helpers();
  const reconstructedContext = await reconstructed.selectionReader.readSelectionContext('inspection-turn');
  assert.deepEqual(reconstructedContext.cycleOpenedCommitRef, context.cycleOpenedCommitRef);
  assert.equal(f.entries.filter(({ record }) => record.kind === 'business-cycle-opened').length, 1);
  const open = (checkId: string) => helper.occurrenceOpening.open({ context, logicalTurnId: 'inspection-turn', executionScope: scope, assignment: f.assignment, checkId });
  const [a, b] = await Promise.all([open('a'), open('b')]);
  assert.equal(a.binding.occurrence.occurrenceId, b.binding.occurrence.occurrenceId);
  assert.equal(f.entries.filter(({ record }) => record.kind === 'inspection-occurrence-opened').length, 1);
  await assert.rejects(open('unknown'), /not declared/);
  const original = f.entries.find(({ record }) => record.kind === 'inspection-definition')!;
  const later = createPublishedTaskPlanRevision({ ...f.plan, revisionId: 'inspection-plan-2', sequence: 2,
    predecessor: { revisionId: f.plan.revisionId, sequence: 1, contentDigest: f.plan.contentDigest },
    reason: { kind: 'adjustment', text: 'later turn', basisRefs: [] }, journalCommitRef: 'jsonl:inspection-plan-2' });
  f.plans.set(later.revisionId, later);
  assert.equal((await f.helpers().selectionReader.readSelectionContext('inspection-turn')).plan.revisionId, f.plan.revisionId);
  f.setCapture({ ...f.capture(), binding: { ...f.capture().binding,
    admittedTurn: { ...f.capture().binding.admittedTurn, turnId: 'inspection-turn-2' },
    acceptedPlan: { revisionId: later.revisionId, revisionCommitRef: f.receipt(later.revisionId) } } });
  f.resources.logicalTurnId = 'inspection-turn-2';
  const next = f.helpers();
  const nextContext = await next.selectionReader.readSelectionContext('inspection-turn-2');
  assert.equal(nextContext.plan.revisionId, later.revisionId);
  assert.deepEqual(nextContext.cycleOpening, openingRecord);
  assert.deepEqual(nextContext.cycleOpenedCommitRef, context.cycleOpenedCommitRef);
  assert.equal(f.entries.filter(({ record }) => record.kind === 'business-cycle-opened').length, 1);
  const { taskFlow: _taskFlow, ...identityWithoutFlow } = f.resources.identity;
  f.resources.identity = identityWithoutFlow as typeof f.resources.identity;
  const reuseWithoutFlow = await f.helpers().selectionReader.readSelectionContext('inspection-turn-2');
  assert.deepEqual(reuseWithoutFlow.cycleOpening, openingRecord);
  assert.equal(f.entries.filter(({ record }) => record.kind === 'business-cycle-opened').length, 1);
  const cold = f.helpers();
  const repeatContext = await cold.selectionReader.readSelectionContext('inspection-turn-2');
  assert.deepEqual(repeatContext.cycleOpenedCommitRef, context.cycleOpenedCommitRef);
  assert.equal(f.entries.filter(({ record }) => record.kind === 'business-cycle-opened').length, 1);
  const opened = await next.occurrenceOpening.open({ context: nextContext, logicalTurnId: 'inspection-turn-2', executionScope: scope, assignment: f.assignment, checkId: 'a' });
  assert.deepEqual(opened.binding.definitionCommitRef, original.commitRef);
  const laterOpening = f.entries.find(({ record }) => record.kind === 'inspection-occurrence-opened'
    && record.logicalTurnId === 'inspection-turn-2')!;
  assert.equal(laterOpening.record.kind === 'inspection-occurrence-opened' && laterOpening.record.planRevisionCommitRef.commitId, later.revisionId);
  assert.deepEqual(f.entries.find(({ record }) => record.kind === 'inspection-definition'), original);
  assert.equal(f.entries.filter(({ record }) => record.kind === 'inspection-definition').length, 1);
  const invocation: ChildInvocationRecord = { invocationId: 'captured-child', childTurnId: 'child', checkpointReceiptRef: 'child-checkpoint',
    binding: { kind: 'execution', assignment: f.assignment, inspection: opened } };
  const delivery: AcceptedExecutionChildDelivery = { kind: 'execution', seq: 1, invocationId: invocation.invocationId,
    assignment: f.assignment, refinedDelivery: f.raw,
    result: { taskId: f.assignment.taskId, pipelineNodeId: f.assignment.pipelineNodeId, agentId: 'child', assignmentId: f.assignment.assignmentId,
      attempt: 1, executionEpoch: 1, inputRevision: 1, producedArtifactRefs: [], status: 'succeeded',
      summary: 'observed a', outputRefs: [], evidenceRefs: [f.raw.ref], nextAction: 'settle' },
    inspectionDelivery: { checkId: 'a', resultId: 'inspection-result:captured-child', attempt: 1,
      outcome: { status: 'completed', judgment: 'a observed' }, evidenceRefs: [f.raw.ref], completedAt: f.time } };
  f.setCapture({ ...f.capture(), childInvocations: [invocation], entries: [delivery] });
  const accepted = await cold.acceptedDeliveryReader.readAcceptedDelivery('captured-child');
  assert.deepEqual(accepted, delivery);
  assert.deepEqual(await cold.acceptedDelivery.accept({ invocation, delivery: accepted! }), delivery.inspectionDelivery);
  assert.equal(await cold.acceptedDeliveryReader.readAcceptedDelivery('missing-child'), null);
  f.setCapture({ ...f.capture(), entries: [delivery, { ...delivery, result: { ...delivery.result, summary: 'conflict' } }] });
  await assert.rejects(cold.acceptedDeliveryReader.readAcceptedDelivery('captured-child'), /conflicting durable/);
  f.setCapture({ ...f.capture(), binding: { ...f.capture().binding, acceptedPlan: undefined } });
  await assert.rejects(f.helpers().selectionReader.readSelectionContext('inspection-turn-2'), /no durable accepted plan/);
});

test('inspection runtime helpers fold adoption over the exact invocation without changing delivery history', async () => {
  // Failure basis: the observed capture-first and replay carriers contain the opening and adopted forms.
  // Impact: the next turn or stop cannot read an accepted inspection delivery. Cost: one existing helper consumer.
  const f = inspectionHelperConsumer();
  const context = await f.helpers().selectionReader.readSelectionContext('inspection-turn');
  const opened = await f.helpers().occurrenceOpening.open({
    context, logicalTurnId: 'inspection-turn', executionScope: scope, assignment: f.assignment, checkId: 'a',
  });
  const invocation: ChildInvocationRecord = {
    invocationId: 'observed-child', childTurnId: 'observed-child-turn', checkpointReceiptRef: 'observed-checkpoint',
    binding: { kind: 'execution', assignment: f.assignment, inspection: opened },
  };
  const adopted = { ...invocation, adoptedResultSeq: 3 };
  const delivery: AcceptedExecutionChildDelivery = {
    kind: 'execution', seq: 3, invocationId: invocation.invocationId, assignment: f.assignment, refinedDelivery: f.raw,
    result: {
      taskId: f.assignment.taskId, pipelineNodeId: f.assignment.pipelineNodeId, agentId: 'child',
      assignmentId: f.assignment.assignmentId, attempt: 1, executionEpoch: 1, inputRevision: 1,
      producedArtifactRefs: [], status: 'succeeded', summary: 'observed a',
      outputRefs: [], evidenceRefs: [f.raw.ref], nextAction: 'settle',
    },
    inspectionDelivery: {
      checkId: 'a', resultId: `inspection-result:${invocation.invocationId}`, attempt: 1,
      outcome: { status: 'completed', judgment: 'a observed' }, evidenceRefs: [f.raw.ref], completedAt: f.time,
    },
  };
  f.setCapture({ ...f.capture(), childInvocations: [adopted], entries: [delivery] });
  const journalWriteCount = f.entries.length;
  const replay = (invocations: readonly ChildInvocationRecord[]) => [
    ...invocations.map((record): ActiveTurnJournalRecord => ({ kind: 'child-invocation', record })),
    { kind: 'child-delivery', entry: delivery } as const,
    { kind: 'child-invocation', record: adopted } as const,
  ];

  f.setRawJournal(replay([invocation]));
  assert.deepEqual(await f.helpers().acceptedDeliveryReader.readAcceptedDelivery(invocation.invocationId), delivery);

  f.setRawJournal(replay([adopted]));
  assert.deepEqual(await f.helpers().acceptedDeliveryReader.readAcceptedDelivery(invocation.invocationId), delivery);

  f.setRawJournal([
    { kind: 'child-invocation', record: invocation },
    { kind: 'child-delivery', entry: delivery },
    { kind: 'child-invocation', record: invocation },
  ]);
  assert.deepEqual(await f.helpers().acceptedDeliveryReader.readAcceptedDelivery(invocation.invocationId), delivery);

  // Failure basis: capture and active journal can encode identical JSON with different object key order.
  // Impact: the next turn or stop rejects an accepted delivery. Cost: one existing public reader consumer.
  const reorderedDelivery: AcceptedExecutionChildDelivery = {
    inspectionDelivery: {
      completedAt: delivery.inspectionDelivery!.completedAt,
      evidenceRefs: [{
        scope: { cycleId: f.raw.ref.scope.cycleId, taskId: f.raw.ref.scope.taskId, organId: f.raw.ref.scope.organId },
        locator: f.raw.ref.locator, source: f.raw.ref.source, kind: f.raw.ref.kind, evidenceId: f.raw.ref.evidenceId,
      }],
      outcome: { judgment: 'a observed', status: 'completed' },
      attempt: delivery.inspectionDelivery!.attempt, resultId: delivery.inspectionDelivery!.resultId,
      checkId: delivery.inspectionDelivery!.checkId,
    },
    result: {
      nextAction: delivery.result.nextAction, evidenceRefs: delivery.result.evidenceRefs, outputRefs: delivery.result.outputRefs,
      summary: delivery.result.summary, status: delivery.result.status,
      producedArtifactRefs: delivery.result.producedArtifactRefs, inputRevision: delivery.result.inputRevision,
      executionEpoch: delivery.result.executionEpoch, attempt: delivery.result.attempt,
      assignmentId: delivery.result.assignmentId, agentId: delivery.result.agentId,
      pipelineNodeId: delivery.result.pipelineNodeId, taskId: delivery.result.taskId,
    },
    refinedDelivery: {
      view: f.raw.view,
      ref: {
        scope: { cycleId: f.raw.ref.scope.cycleId, taskId: f.raw.ref.scope.taskId, organId: f.raw.ref.scope.organId },
        locator: f.raw.ref.locator, source: f.raw.ref.source, kind: f.raw.ref.kind, evidenceId: f.raw.ref.evidenceId,
      },
    },
    assignment: {
      mergeGate: f.assignment.mergeGate, requiredCapabilities: f.assignment.requiredCapabilities,
      incompleteCriteria: f.assignment.incompleteCriteria, failureCriteria: f.assignment.failureCriteria,
      successCriteria: f.assignment.successCriteria,
      expectedOutputRefs: f.assignment.expectedOutputRefs, targetRefs: f.assignment.targetRefs,
      objective: f.assignment.objective, inputRevision: f.assignment.inputRevision,
      executionEpoch: f.assignment.executionEpoch, attempt: f.assignment.attempt,
      pipelineNodeId: f.assignment.pipelineNodeId, taskId: f.assignment.taskId, assignmentId: f.assignment.assignmentId,
    },
    invocationId: delivery.invocationId, seq: delivery.seq, kind: delivery.kind,
  };
  f.setRawJournal([
    { kind: 'child-delivery', entry: delivery },
    { kind: 'child-delivery', entry: reorderedDelivery },
  ]);
  assert.deepEqual(await f.helpers().acceptedDeliveryReader.readAcceptedDelivery(invocation.invocationId), delivery);

  f.setRawJournal(replay([{ ...invocation, adoptedResultSeq: 4 }]));
  await assert.rejects(f.helpers().acceptedDeliveryReader.readAcceptedDelivery(invocation.invocationId),
    /conflicting durable records/);

  const changedBinding = {
    ...invocation,
    binding: { kind: 'execution' as const, assignment: { ...f.assignment, executionEpoch: 2 }, inspection: opened },
  };
  f.setRawJournal([
    { kind: 'child-invocation', record: invocation },
    { kind: 'child-invocation', record: changedBinding },
  ]);
  await assert.rejects(f.helpers().acceptedDeliveryReader.readAcceptedDelivery(invocation.invocationId),
    /conflicting durable records/);

  f.setCapture({
    ...f.capture(),
    entries: [delivery, { ...delivery, result: { ...delivery.result, summary: 'conflicting delivery' } }],
  });
  f.setRawJournal(replay([invocation]));
  await assert.rejects(f.helpers().acceptedDeliveryReader.readAcceptedDelivery(invocation.invocationId),
    /inspection child delivery has conflicting durable records/);

  f.setCapture({
    ...f.capture(),
    childInvocations: [{ ...invocation, adoptedResultSeq: 4 }],
    entries: [],
  });
  f.setRawJournal([]);
  await assert.rejects(f.helpers().acceptedDeliveryReader.readAcceptedDelivery(invocation.invocationId),
    /child selection resultSeq must reference an accepted entry/);
  assert.equal(f.entries.length, journalWriteCount);
});

test('inspection runtime helpers hold fresh selection when TaskIdentity taskFlow is absent', async () => {
  // Failure basis: optional identity flow could be defaulted or an opening could be committed before the hold.
  // Impact: fabricated task-flow guidance and partial durable state. Probability: unknown. Cost: one existing fixture.
  const f = inspectionHelperConsumer();
  const { taskFlow: _taskFlow, ...identityWithoutFlow } = f.resources.identity;
  f.resources.identity = identityWithoutFlow as typeof f.resources.identity;
  await assert.rejects(
    f.helpers().selectionReader.readSelectionContext('inspection-turn'),
    /TaskIdentity.*taskFlow/,
  );
  assert.equal(f.entries.length, 0);
});

test('inspection runtime helpers stop follows exact v2 receipt to original v1 and excludes mutable tail', async () => {
  // Draft failures are concrete: selector/receipt confusion and v2-only predecessor decoding.
  // Impact: stop loses recovery facts or includes later work. Probability demonstrated. Cost: one typed local consumer.
  const f = inspectionHelperConsumer();
  const helper = f.helpers();
  const context = await helper.selectionReader.readSelectionContext('inspection-turn');
  const inspection = await helper.occurrenceOpening.open({ context, logicalTurnId: 'inspection-turn', executionScope: scope, assignment: f.assignment, checkId: 'a' });
  const checkpoint: CommittedCheckpointRecord = { checkpoint: { id: id('checkpoint', 'stop-cut'), scope,
    cycleId: scope.cycleId!, seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 2,
    outcome: 'stopped', summary: 'stop', recoveryStateRef: f.raw.ref, evidenceRefs: [], next: { kind: 'stop' } },
    previous: null, commitRef: f.receipt('stop-checkpoint') };
  const invocation: ChildInvocationRecord = { invocationId: 'stop-child', childTurnId: 'stop-child-turn', checkpointReceiptRef: 'child-checkpoint',
    binding: { kind: 'execution', assignment: f.assignment, inspection } };
  const delivery: AcceptedExecutionChildDelivery = { kind: 'execution', seq: 1, invocationId: invocation.invocationId,
    assignment: f.assignment, refinedDelivery: f.raw,
    result: { taskId: f.assignment.taskId, pipelineNodeId: f.assignment.pipelineNodeId, agentId: 'child', assignmentId: f.assignment.assignmentId,
      attempt: 1, executionEpoch: 1, inputRevision: 1, producedArtifactRefs: [], status: 'succeeded',
      summary: 'observed a', outputRefs: [], evidenceRefs: [f.raw.ref], nextAction: 'settle' },
    inspectionDelivery: { checkId: 'a', resultId: 'inspection-result:stop-child', attempt: 1,
      outcome: { status: 'completed', judgment: 'a observed before stop' }, evidenceRefs: [f.raw.ref], completedAt: f.time } };
  const original = { ...f.capture(), childInvocations: [invocation], entries: [delivery] };
  const businessTurnRef = { businessTurnId: 'inspection-turn', bindingCommitRef: f.receipt('binding'), execution: original.binding.execution };
  const segmentBinding = { businessTurnRef, assignment: { ...f.assignment, executionEpoch: 2 },
    execution: { runtimeId: 'resumed', executionEpoch: 2 }, scope,
    incarnation: { runtimeId: 'resumed', generation: 1, agentInstanceId: 'resumed-agent', roleId: 'execution',
      taskId: f.assignment.taskId, assignmentId: f.assignment.assignmentId, executionEpoch: 2 } };
  const predecessor = { segmentId: 'original', recoveryAssetsReceiptRef: 'committed:v1' };
  const opened = { kind: 'segment-opened' as const, segmentId: 'resumed', businessTurnRef, predecessor,
    binding: segmentBinding, authorityCommitRef: f.receipt('authority'), businessRegistrationCommitRef: f.receipt('registration'),
    requestRef: 'open-resumed', inputIdentity: { requestRef: 'open-resumed', digest: 'input' } };
  const segmentSource = { originalAdmittedTurn: original.binding.admittedTurn, originalBusinessTurnRef: businessTurnRef,
    opened, openedCommitRef: f.receipt('opened') };
  const recovery = { recoveryResponsibilityRef: 'recovery', unresolvedOperationRefs: [], rawTurnRefs: [], laterErrorRefs: [],
    commitIdentity: 'save', stages: [], durablePhases: [], durableReceiptRefs: [] };
  const prepared = { body: { version: 2 as const, segmentId: 'resumed', businessTurnRef, binding: segmentBinding,
    initialInput: original.initialInput, entries: [], requests: [], childInvocations: [], cut: original.cut, predecessor },
    controlRecordCount: 0, producerDrains: [], completionLookups: [], recovery };
  const receipt = { commitIdentity: 'committed:v2', journalReceiptRef: 'journal:v2', commitFactDigest: 'fact', journalSeq: 7,
    recordDigest: 'record', businessTurnId: 'inspection-turn', segmentId: 'resumed', boundaryId: 'boundary', capture: f.raw };
  const originalRead = { receipt: { ...receipt, commitIdentity: 'committed:v1', turnId: 'inspection-turn' },
    prepared: { ...prepared, body: original } };
  const reads: string[] = [];
  let missing = false;
  const assets = { readRecoveryAssetsExact: async () => originalRead,
    readBoundaryRecoveryAssetsExact: async (ref: string) => {
      reads.push(ref);
      if (ref === 'committed:v2') return { version: 2 as const, assets: { receipt, prepared }, source: segmentSource };
      if (ref === 'committed:v1' && !missing) return { version: 1 as const, assets: originalRead };
      throw new Error('exact capture missing');
    } };
  f.stop(checkpoint, { turn: context.turn, boundaryId: 'boundary', segmentSource, recoveryAssetsReceiptRef: 'committed:v2', assets,
    segments: { readInitialOpenExact: async () => { throw new Error('unexpected initial-open'); },
      readSegmentInterruptedExact: async () => { throw new Error('unexpected interrupted'); } } });
  const facts = await f.helpers().occurrences.readOccurrencesForStop({ checkpoint });
  assert.equal(facts.length, 1);
  assert.deepEqual(reads, ['committed:v2', 'committed:v1']);
  assert.deepEqual(facts[0]!.deliveries, [{ invocation, delivery }]);
  missing = true;
  await assert.rejects(f.helpers().occurrences.readOccurrencesForStop({ checkpoint }), /exact capture missing/);
  f.stop(checkpoint, { turn: context.turn, boundaryId: 'wrong-boundary', segmentSource,
    recoveryAssetsReceiptRef: 'committed:v2', assets, segments: { readInitialOpenExact: async () => { throw new Error('unexpected'); }, readSegmentInterruptedExact: async () => { throw new Error('unexpected'); } } });
  await assert.rejects(f.helpers().occurrences.readOccurrencesForStop({ checkpoint }), /committed source/);
});

test('inspection runtime helpers stop resolves exact initial-open predecessor binding', async () => {
  // Failure basis: the exact initial-open prefix carries the original binding, but stop discarded it.
  // Impact: a legitimate cold stop is blocked without its accepted plan and check. Probability: unknown.
  // Cost: one typed local consumer reusing the existing v2 fixture and cut.
  const f = inspectionHelperConsumer();
  const helper = f.helpers();
  const context = await helper.selectionReader.readSelectionContext('inspection-turn');
  const inspection = await helper.occurrenceOpening.open({
    context,
    logicalTurnId: 'inspection-turn',
    executionScope: scope,
    assignment: f.assignment,
    checkId: 'a',
  });
  const checkpoint: CommittedCheckpointRecord = { checkpoint: { id: id('checkpoint', 'stop-initial-open'), scope,
    cycleId: scope.cycleId!, seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 2,
    outcome: 'stopped', summary: 'stop initial open', recoveryStateRef: f.raw.ref, evidenceRefs: [], next: { kind: 'stop' } },
    previous: null, commitRef: f.receipt('stop-initial-open-checkpoint') };
  const invocation: ChildInvocationRecord = { invocationId: 'initial-open-child', childTurnId: 'initial-open-child-turn',
    checkpointReceiptRef: 'child-checkpoint', binding: { kind: 'execution', assignment: f.assignment, inspection } };
  const delivery: AcceptedExecutionChildDelivery = { kind: 'execution', seq: 1, invocationId: invocation.invocationId,
    assignment: f.assignment, refinedDelivery: f.raw,
    result: { taskId: f.assignment.taskId, pipelineNodeId: f.assignment.pipelineNodeId, agentId: 'child',
      assignmentId: f.assignment.assignmentId, attempt: 1, executionEpoch: 1, inputRevision: 1,
      producedArtifactRefs: [], status: 'succeeded', summary: 'observed a',
      outputRefs: [], evidenceRefs: [f.raw.ref], nextAction: 'settle' },
    inspectionDelivery: { checkId: 'a', resultId: 'inspection-result:initial-open-child', attempt: 1,
      outcome: { status: 'completed', judgment: 'a observed before stop' }, evidenceRefs: [f.raw.ref], completedAt: f.time } };
  const original = { ...f.capture(), childInvocations: [invocation], entries: [delivery] };
  const businessTurnRef = { businessTurnId: 'inspection-turn', bindingCommitRef: f.receipt('binding'), execution: original.binding.execution };
  const segmentBinding = { businessTurnRef, assignment: { ...f.assignment, executionEpoch: 2 },
    execution: { runtimeId: 'resumed', executionEpoch: 2 }, scope,
    incarnation: { runtimeId: 'resumed', generation: 1, agentInstanceId: 'resumed-agent', roleId: 'execution',
      taskId: f.assignment.taskId, assignmentId: f.assignment.assignmentId, executionEpoch: 2 } };
  const anchor = { bindingCommitRef: f.receipt('binding'), recordsThroughCommitRef: f.receipt('initial-open-record') };
  const predecessor = { segmentId: 'inspection-turn', initialOpen: anchor };
  const opened = { kind: 'segment-opened' as const, segmentId: 'resumed', businessTurnRef, predecessor,
    binding: segmentBinding, authorityCommitRef: f.receipt('authority'), businessRegistrationCommitRef: f.receipt('registration'),
    requestRef: 'open-resumed', inputIdentity: { requestRef: 'open-resumed', digest: 'input' } };
  const segmentSource = { originalAdmittedTurn: original.binding.admittedTurn, originalBusinessTurnRef: businessTurnRef,
    opened, openedCommitRef: f.receipt('opened') };
  const recovery = { recoveryResponsibilityRef: 'recovery', unresolvedOperationRefs: [], rawTurnRefs: [], laterErrorRefs: [],
    commitIdentity: 'save', stages: [], durablePhases: [], durableReceiptRefs: [] };
  const prepared = { body: { version: 2 as const, segmentId: 'resumed', businessTurnRef, binding: segmentBinding,
    initialInput: original.initialInput, entries: [], requests: [], childInvocations: [], cut: original.cut, predecessor },
    controlRecordCount: 0, producerDrains: [], completionLookups: [], recovery };
  const receipt = { commitIdentity: 'committed:v2-initial-open', journalReceiptRef: 'journal:v2-initial-open',
    commitFactDigest: 'fact', journalSeq: 7, recordDigest: 'record', businessTurnId: 'inspection-turn',
    segmentId: 'resumed', boundaryId: 'boundary', capture: f.raw };
  const reads: string[] = [];
  let initialOpenReads = 0;
  f.stop(checkpoint, { turn: context.turn, boundaryId: 'boundary', segmentSource,
    recoveryAssetsReceiptRef: 'committed:v2-initial-open',
    assets: {
      readRecoveryAssetsExact: async () => { throw new Error('unexpected v1 recovery receipt'); },
      readBoundaryRecoveryAssetsExact: async (ref: string) => {
        reads.push(ref);
        if (ref === 'committed:v2-initial-open') return { version: 2 as const, assets: { receipt, prepared }, source: segmentSource };
        throw new Error('unexpected recovery receipt');
      },
    },
    segments: {
      readInitialOpenExact: async (input) => {
        initialOpenReads += 1;
        assert.deepEqual(input.anchor, anchor);
        return { anchor, prefix: { kind: 'live-accepted-prefix' as const, source: 'inspection-turn',
          binding: original.binding, initialInput: original.initialInput, entries: original.entries,
          requests: original.requests, childInvocations: original.childInvocations,
          watermark: { lastAcceptedSeq: 1, controlRecordCount: 0 }, obligations: [] } };
      },
      readSegmentInterruptedExact: async () => { throw new Error('unexpected interrupted'); },
    } });

  const facts = await f.helpers().occurrences.readOccurrencesForStop({ checkpoint });
  assert.equal(facts.length, 1);
  assert.deepEqual(reads, ['committed:v2-initial-open']);
  assert.equal(initialOpenReads, 1);
  assert.deepEqual(facts[0]!.opening.record.planRevisionCommitRef, f.receipt(f.plan.revisionId));
  assert.deepEqual(facts[0]!.deliveries, [{ invocation, delivery }]);
});

test('inspection runtime helpers treat a stop without an opened occurrence as not applicable', async () => {
  // Failure basis: stop applicability required a physical capture before checking the durable occurrence.
  // Impact: an ordinary prepared stop is falsely blocked. Probability: unknown. Cost: one existing fixture assertion.
  const f = inspectionHelperConsumer();
  const checkpoint: CommittedCheckpointRecord = { checkpoint: { id: id('checkpoint', 'ordinary-stop'), scope,
    cycleId: scope.cycleId!, seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 1,
    outcome: 'stopped', summary: 'ordinary stop', recoveryStateRef: f.raw.ref, evidenceRefs: [], next: { kind: 'stop' } },
    previous: null, commitRef: f.receipt('ordinary-stop-checkpoint') };
  f.commitCheckpoint(checkpoint);
  f.failForCheckpoint();

  assert.deepEqual(await f.helpers().occurrences.readOccurrencesForStop({ checkpoint }), []);
});

test('inspection stop completion helper rejects unresolved facts for a known exact turn opening', async () => {
  // Failure basis: a known exact-turn opening was conflated with no occurrence. Impact: stop recovery can report
  // not-applicable without the required durable facts. Probability: unknown. Cost: one existing helper fixture.
  const f = inspectionHelperConsumer();
  const helper = f.helpers();
  const context = await helper.selectionReader.readSelectionContext('inspection-turn');
  await helper.occurrenceOpening.open({
    context,
    logicalTurnId: 'inspection-turn',
    executionScope: scope,
    assignment: f.assignment,
    checkId: 'a',
  });
  const checkpoint: CommittedCheckpointRecord = { checkpoint: { id: id('checkpoint', 'stop-unresolved'), scope,
    cycleId: scope.cycleId!, seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 1,
    outcome: 'stopped', summary: 'stop with unresolved facts', recoveryStateRef: f.raw.ref, evidenceRefs: [], next: { kind: 'stop' } },
    previous: null, commitRef: f.receipt('stop-unresolved-checkpoint') };
  const body = { ...f.capture(), binding: { ...f.capture().binding, acceptedPlan: undefined } };
  const receipt = { commitIdentity: 'committed:unresolved', journalReceiptRef: 'journal:unresolved',
    commitFactDigest: 'fact:unresolved', journalSeq: 2, recordDigest: 'record:unresolved',
    turnId: 'inspection-turn', boundaryId: 'boundary', capture: f.raw };
  const readback = { receipt, prepared: { body, controlRecordCount: 0, producerDrains: [], completionLookups: [],
    recovery: { recoveryResponsibilityRef: 'recovery', unresolvedOperationRefs: [], rawTurnRefs: [], laterErrorRefs: [],
      commitIdentity: 'save', stages: [], durablePhases: [], durableReceiptRefs: [] } } };
  f.stop(checkpoint, { turn: context.turn, boundaryId: 'boundary', recoveryAssetsReceiptRef: 'committed:unresolved',
    assets: {
      readRecoveryAssetsExact: async () => readback,
      readBoundaryRecoveryAssetsExact: async () => ({ version: 1, assets: readback }),
    },
    segments: {
      readInitialOpenExact: async () => { throw new Error('unexpected initial-open'); },
      readSegmentInterruptedExact: async () => { throw new Error('unexpected interrupted'); },
    } });

  await assert.rejects(
    () => f.helpers().occurrences.readOccurrencesForStop({ checkpoint }),
    /unresolved required facts/,
  );
});

test('inspection stop completion helper does not resettle a historical turn opening', async () => {
  // Failure basis: a stop read could widen to another historical logical turn sharing the cycle. Impact: a later
  // stop resettles old inspection work. Probability: unknown. Cost: one existing helper fixture.
  const f = inspectionHelperConsumer();
  const first = f.helpers();
  const firstContext = await first.selectionReader.readSelectionContext('inspection-turn');
  await first.occurrenceOpening.open({
    context: firstContext,
    logicalTurnId: 'inspection-turn',
    executionScope: scope,
    assignment: f.assignment,
    checkId: 'a',
  });
  const historicalOpening = f.entries.find(({ record }) => record.kind === 'inspection-occurrence-opened')!;
  const nextTurnId = 'inspection-turn-2';
  f.setCapture({ ...f.capture(), binding: { ...f.capture().binding,
    admittedTurn: { ...f.capture().binding.admittedTurn, turnId: nextTurnId } } });
  f.resources.logicalTurnId = nextTurnId;
  const checkpoint: CommittedCheckpointRecord = { checkpoint: { id: id('checkpoint', 'stop-next-turn'), scope,
    cycleId: scope.cycleId!, seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 1,
    outcome: 'stopped', summary: 'stop next turn', recoveryStateRef: f.raw.ref, evidenceRefs: [], next: { kind: 'stop' } },
    previous: null, commitRef: f.receipt('stop-next-turn-checkpoint') };
  const context = await f.helpers().selectionReader.readSelectionContext(nextTurnId);
  const body = { ...f.capture() };
  const receipt = { commitIdentity: 'committed:next-turn', journalReceiptRef: 'journal:next-turn',
    commitFactDigest: 'fact:next-turn', journalSeq: 2, recordDigest: 'record:next-turn',
    turnId: nextTurnId, boundaryId: 'boundary', capture: f.raw };
  const readback = { receipt, prepared: { body, controlRecordCount: 0, producerDrains: [], completionLookups: [],
    recovery: { recoveryResponsibilityRef: 'recovery', unresolvedOperationRefs: [], rawTurnRefs: [], laterErrorRefs: [],
      commitIdentity: 'save', stages: [], durablePhases: [], durableReceiptRefs: [] } } };
  f.stop(checkpoint, { turn: context.turn, boundaryId: 'boundary', recoveryAssetsReceiptRef: 'committed:next-turn',
    assets: {
      readRecoveryAssetsExact: async () => readback,
      readBoundaryRecoveryAssetsExact: async () => ({ version: 1, assets: readback }),
    },
    segments: {
      readInitialOpenExact: async () => { throw new Error('unexpected initial-open'); },
      readSegmentInterruptedExact: async () => { throw new Error('unexpected interrupted'); },
    } });

  assert.deepEqual(await f.helpers().occurrences.readOccurrencesForStop({ checkpoint }), []);
  assert.equal(f.entries.find(({ record }) => record.kind === 'inspection-occurrence-opened'), historicalOpening);
  assert.equal(f.entries.some(({ record }) => record.kind === 'inspection-occurrence-settled'), false);
});

const observationProfile: AgentModeCapabilityProfile = {
  profileId: 'orchestration-observation-1',
  role: 'orchestration',
  mode: 'observation',
  observationScopes: ['task', 'evidence'],
  observationCapabilities: ['read-task', 'read-evidence'],
  orchestrationScope: 'project',
  orchestrationCapabilities: [],
};

const orchestrationProfile: AgentModeCapabilityProfile = {
  profileId: 'orchestration-orchestration-1',
  role: 'orchestration',
  mode: 'orchestration',
  observationScopes: ['task', 'evidence'],
  observationCapabilities: ['read-task', 'read-evidence'],
  orchestrationScope: 'project',
  orchestrationCapabilities: ['plan-project', 'assign-work'],
};

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function inspectionAlignment(
  closure: TurnClosureReference,
  decision: PlannerAlignmentReference['decision'],
): PlannerAlignmentReference {
  return {
    identity: closure.identity,
    checkpointId: closure.checkpointId,
    closureRef: closure.closureRef,
    planRevisionId: `plan-revision:${closure.identity.turnId}`,
    planRevisionSequence: 1,
    planContentDigest: digest(closure.identity.turnId),
    decision,
    alignedAt: closure.closedAt,
  };
}

const checkpointTimeAuthority = {
  source: 'harness',
  owner: 'runtime-checkpoint-control-owner',
  authorityRef: 'agent-loop-test-checkpoint-authority',
} as const;

type CommittedCheckpointFixture = Omit<CommittedCheckpointRecord, 'commitRef'> & {
  readonly commitRef: JournalCommitRef & { readonly recordDigest: `sha256:${string}` };
};

async function checkpointRelationship(
  committed: CommittedCheckpointFixture,
  committedAt: string,
): Promise<CheckpointReceiptRelationshipV1> {
  const identity = await checkpointCommitIdentityV2({ checkpoint: committed.checkpoint });
  const recordDigest = committed.commitRef.recordDigest;
  const scopeHash = await scopeDigest(committed.checkpoint.scope);
  return {
    checkpoint: committed.checkpoint,
    envelope: {
      version: 1,
      identity,
      committedAt,
      timeAuthority: checkpointTimeAuthority,
      intentDigest: await checkpointIntentDigestV1({
        checkpoint: committed.checkpoint,
        timeAuthority: checkpointTimeAuthority,
      }),
    },
    receipt: {
      commitIdentity: identity,
      checkpointRef: checkpointRefV2(identity),
      journalReceiptRef: `humanagent://journal-record/v1/${scopeHash}/${committed.commitRef.journalSeq}/${recordDigest.slice('sha256:'.length)}`,
      committedAt,
      timeAuthority: checkpointTimeAuthority,
    },
    checkpointSeq: committed.checkpoint.seq,
    journalSeq: committed.commitRef.journalSeq,
    recordDigest,
  };
}

function durableContext() {
  return {
    stablePrefix: [{ ref: 'stable:goal' }],
    indexRefs: [{ ref: 'index:task' }],
    dynamicHead: [{ ref: 'head:latest-turn' }],
    repairRefs: [{ responsibility: 'recover:original' }],
  };
}

/**
 * Real in-memory ContextHistoryPort. `commit` mints a physical receipt and stores the
 * record; `readContextCommit` returns the exact committed body so the runtime readback
 * check runs against genuine state instead of a stubbed value.
 */
class MemoryContextHistory implements ContextHistoryPort {
  private sequence = 0;
  private readonly committed = new Map<string, { readonly ref: JournalCommitRef; readonly record: ContextHistoryRecord }>();

  async commit(record: ContextHistoryRecord, _expected: JournalCommitRef | null): Promise<JournalCommitRef> {
    this.sequence += 1;
    const ref: JournalCommitRef = {
      commitId: `context:${record.agentRuntimeId}:${this.sequence}`,
      journalSeq: this.sequence,
      recordDigest: digest(record),
    };
    this.committed.set(ref.commitId, { ref, record });
    return ref;
  }

  async readContextCommit(_scope: ScopeRef, ref: JournalCommitRef): Promise<ContextHistoryRecord> {
    const entry = this.committed.get(ref.commitId);
    if (!entry) throw new Error('exact context commit is missing');
    return entry.record;
  }

  async readContextHistory(query: ContextHistoryReadQuery): Promise<ContextHistoryReadResult> {
    const entries = [...this.committed.values()].filter(
      (entry) => query.agentRuntimeId === undefined || entry.record.agentRuntimeId === query.agentRuntimeId,
    );
    const tail = entries.at(-1);
    return {
      views: entries.map((entry) => entry.record.contextView),
      replacements: entries.flatMap((entry) => (entry.record.replacement ? [entry.record.replacement] : [])),
      currentContextCommitRef: tail ? tail.ref : null,
    };
  }
}

function createRuntimeRequest(): AgentLoopStartRequest {
  return {
    agentRuntimeId: 'runtime-agent-loop',
    role: 'orchestration',
    mode: 'observation',
    profiles: [observationProfile, orchestrationProfile],
    budget: {
      maxModeTransitions: 2,
      maxObservationScopes: 2,
      maxContextReplacements: 4,
      maxDeferredEvents: 2,
    },
    scope,
    executionEpoch: 3,
    permissionRevision: 'permissions-1',
    observationStreamId: 'stream-agent-loop',
    durableContext: durableContext(),
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  };
}

async function createRuntime(): Promise<AgentLoopRuntime> {
  return AgentLoopRuntime.start(createRuntimeRequest(), new MemoryContextHistory());
}

function actor(runtime: AgentLoopRuntime): AgentLoopActor {
  return {
    agentRuntimeId: runtime.snapshot().modeState.agentRuntimeId,
    leaseId: runtime.snapshot().lease.leaseId,
  };
}

async function open(runtime: AgentLoopRuntime): Promise<AgentLoopActor> {
  const currentActor = actor(runtime);
  await runtime.openObservationScope({
    actor: currentActor,
    kind: 'task',
    scope,
    readableRefs: ['task:state'],
    capabilities: ['read-task'],
  });
  return currentActor;
}

function batch(runtime: AgentLoopRuntime): ObservationBatch {
  const snapshot = runtime.snapshot();
  return {
    batchId: 'batch-1',
    observationScopeId: snapshot.modeState.observationScopeId,
    executionEpoch: snapshot.modeState.executionEpoch,
    baseCheckpoint: snapshot.modeState.checkpoint,
    eventClass: 'observation',
    priority: 'normal',
    watermark: { streamId: 'stream-agent-loop', sequence: 1 },
    eventIds: ['event-1'],
    eventSequences: [1],
    correlationRefs: ['task:state'],
    idempotencyKey: 'batch-key-1',
  };
}

function delta(runtime: AgentLoopRuntime): ObservationDelta {
  const snapshot = runtime.snapshot();
  return {
    deltaId: 'delta-1',
    idempotencyKey: 'delta-key-1',
    deltaDigest: digest('delta-1'),
    observationScopeId: snapshot.modeState.observationScopeId,
    executionEpoch: snapshot.modeState.executionEpoch,
    baseCheckpoint: snapshot.modeState.checkpoint,
    watermark: { streamId: 'stream-agent-loop', sequence: 1 },
    observationRefs: ['observation:task-state'],
    eventSequences: [1],
    summaryRef: 'summary:task-state',
  };
}

test('runtime loop performs observation batch, delta replacement, and checkpoint reentry', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  const result = await runtime.applyObservationDelta(currentActor, delta(runtime), { durableContext: durableContext() });
  const snapshot = runtime.snapshot();

  assert.equal(result.checkpoint.sequence, 2);
  assert.equal(result.replacement.baseCheckpoint.checkpointId.value, 'runtime-agent-loop-1');
  assert.equal(snapshot.checkpoint.sequence, 2);
  assert.equal(snapshot.contextView.activeRefs.includes('observation:task-state'), true);
  assert.deepEqual(snapshot.appliedDeltaIds, ['delta-1']);
  assert.equal(snapshot.observationScope, undefined);
  assert.equal(snapshot.budgetUsage.observationScopes, 1);
  assert.equal(snapshot.budgetUsage.contextReplacements, 1);
  assert.equal(snapshot.checkpoint.predecessor?.checkpointId.value, 'runtime-agent-loop-1');
});

test('runtime loop transitions observation into orchestration with a new lease', async () => {
  const runtime = await createRuntime();
  const observationActor = await open(runtime);
  await runtime.mergeObservationBatch(observationActor, batch(runtime));
  await runtime.applyObservationDelta(observationActor, delta(runtime), { durableContext: durableContext() });
  const before = runtime.snapshot();
  const transition = await runtime.transitionMode({
    actor: actor(runtime),
    toMode: 'orchestration',
    reason: 'observation-complete',
    deltaIds: ['delta-1'],
    summary: 'observation is summarized for orchestration',
    contextViewRef: 'runtime-agent-loop:context:3',
    contextDigest: digest(['observation:task-state']),
    activeRefs: ['observation:task-state', 'plan:input'],
    omittedRefs: ['raw:event-1'],
    durableContext: durableContext(),
  });
  const after = runtime.snapshot();

  assert.equal(transition.fromMode, 'observation');
  assert.equal(transition.toMode, 'orchestration');
  assert.equal(after.modeState.mode, 'orchestration');
  assert.notEqual(after.lease.leaseId, before.lease.leaseId);
  assert.equal(after.lease.profileId, orchestrationProfile.profileId);
  assert.equal(after.checkpoint.sequence, 3);
  assert.equal(after.budgetUsage.modeTransitions, 1);
});

test('runtime loop fences unknown owners, stale leases, duplicates, and closed scopes', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  await assert.rejects(
    () => runtime.mergeObservationBatch({ ...currentActor, agentRuntimeId: 'other-runtime' }, batch(runtime)),
    (error: unknown) => error instanceof AgentLoopRuntimeError && error.code === 'unknown-owner',
  );
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  await assert.rejects(
    () => runtime.mergeObservationBatch(currentActor, batch(runtime)),
    /unaccounted event gap|duplicate observation batch/,
  );
  const result = await runtime.applyObservationDelta(currentActor, delta(runtime), { durableContext: durableContext() });
  assert.equal(result.checkpoint.sequence, 2);
  await assert.rejects(
    () => runtime.closeObservationScope(currentActor),
    /stale/,
  );
  await assert.rejects(
    () => runtime.closeObservationScope(actor(runtime)),
    /unknown observation scope|observation scope is closed/,
  );
  await assert.rejects(
    () => runtime.replaceContext(currentActor, {
      deltaIds: ['delta-2'],
      summary: 'stale context replacement',
      contextViewRef: 'context:stale',
      contextDigest: 'digest:stale',
      activeRefs: ['x'],
      omittedRefs: [],
      durableContext: durableContext(),
    }),
    /stale|expired|mismatch/,
  );
});

test('runtime loop enforces deferred-event and scope budgets', async () => {
  const runtime = await AgentLoopRuntime.start({
    agentRuntimeId: 'runtime-budget',
    role: 'orchestration',
    mode: 'observation',
    profiles: [observationProfile],
    budget: { maxModeTransitions: 0, maxObservationScopes: 1, maxContextReplacements: 1, maxDeferredEvents: 1 },
    scope,
    executionEpoch: 1,
    permissionRevision: 'permissions-1',
    observationStreamId: 'stream-budget',
    durableContext: durableContext(),
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  }, new MemoryContextHistory());
  const currentActor = actor(runtime);
  await runtime.openObservationScope({ actor: currentActor, kind: 'task', scope, readableRefs: [], capabilities: ['read-task'] });
  const batchInput = batch(runtime);
  const deferred = { ...batchInput, batchId: 'deferred', priority: 'deferred' as const, idempotencyKey: 'deferred-key' };
  await assert.rejects(() => runtime.mergeObservationBatch(currentActor, { ...deferred, eventIds: ['event-1', 'event-2'], eventSequences: [1, 2], watermark: { streamId: 'stream-budget', sequence: 2 } }), /budget exhausted/);
  await assert.rejects(() => runtime.openObservationScope({ actor: currentActor, kind: 'task', scope, readableRefs: [], capabilities: ['read-task'] }), /already open/);
});

test('runtime loop never reopens a closed scope identity', async () => {
  const runtime = await createRuntime();
  const firstActor = await open(runtime);
  const closedScopeId = runtime.snapshot().modeState.observationScopeId;
  await runtime.closeObservationScope(firstActor, closedScopeId);

  await runtime.openObservationScope({
    actor: actor(runtime),
    kind: 'task',
    scope,
    readableRefs: ['task:state'],
    capabilities: ['read-task'],
  });
  const reopened = runtime.snapshot();
  assert.notEqual(reopened.modeState.observationScopeId, closedScopeId);
  await assert.rejects(
    () => runtime.mergeObservationBatch(actor(runtime), {
      ...batch(runtime),
      observationScopeId: closedScopeId,
    }),
    /observation scope is closed/,
  );
});

test('runtime loop keeps observation cursors aligned after context replacement', async () => {
  const runtime = await createRuntime();
  const firstActor = await open(runtime);
  await runtime.replaceContext(firstActor, {
    deltaIds: ['manual-delta-1'],
    summary: 'compact observed context',
    contextViewRef: 'runtime-agent-loop:context:compact',
    contextDigest: digest(['task:state']),
    activeRefs: ['task:state'],
    omittedRefs: ['raw:event-0'],
    durableContext: durableContext(),
  });

  const currentActor = actor(runtime);
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  const nextDelta = { ...delta(runtime), deltaId: 'delta-after-replacement', idempotencyKey: 'delta-after-replacement-key' };
  const result = await runtime.applyObservationDelta(currentActor, nextDelta, { durableContext: durableContext() });
  assert.equal(result.replacement.baseCheckpoint.checkpointId.value, 'runtime-agent-loop-2');
  assert.equal(runtime.snapshot().checkpoint.sequence, 3);
});

test('runtime loop rejects a delta that does not consume the complete observed batch', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  const observed = batch(runtime);
  await runtime.mergeObservationBatch(currentActor, {
    ...observed,
    eventIds: ['event-1', 'event-2', 'event-3', 'event-4', 'event-5'],
    eventSequences: [1, 2, 3, 4, 5],
    watermark: { streamId: 'stream-agent-loop', sequence: 5 },
  });
  await assert.rejects(
    () => runtime.applyObservationDelta(currentActor, delta(runtime), { durableContext: durableContext() }),
    /current observed batch watermark/,
  );
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.checkpoint.sequence, 1);
  assert.equal(snapshot.checkpointHistory.length, 1);
  assert.equal(snapshot.budgetUsage.contextReplacements, 0);
});

test('runtime loop leaves no orphan checkpoint after a rejected replacement', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  const before = runtime.snapshot();
  await assert.rejects(
    () => runtime.replaceContext(currentActor, {
      deltaIds: ['invalid-replacement'],
      summary: 'invalid same context replacement',
      contextViewRef: before.contextView.contextViewRef,
      contextDigest: 'digest:invalid',
      activeRefs: ['task:state'],
      omittedRefs: [],
      durableContext: durableContext(),
    }),
    /must change the active context view/,
  );
  const after = runtime.snapshot();
  assert.equal(after.checkpoint.sequence, before.checkpoint.sequence);
  assert.equal(after.checkpointHistory.length, before.checkpointHistory.length);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
});

test('runtime loop does not commit replacement state when transition validation fails', async () => {
  const runtime = await createRuntime();
  const currentActor = actor(runtime);
  const before = runtime.snapshot();
  await assert.rejects(
    () => runtime.transitionMode({
      actor: currentActor,
      toMode: 'orchestration',
      reason: 'invalid-reason' as 'observation-complete',
      deltaIds: ['transition-delta'],
      summary: 'invalid transition',
      contextViewRef: 'runtime-agent-loop:context:invalid',
      contextDigest: 'digest:invalid',
      activeRefs: ['plan:input'],
      omittedRefs: [],
      durableContext: durableContext(),
    }),
    /agent mode transition reason is invalid/,
  );
  const after = runtime.snapshot();
  assert.equal(after.checkpoint.sequence, before.checkpoint.sequence);
  assert.equal(after.checkpointHistory.length, before.checkpointHistory.length);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
  assert.equal(after.modeState.mode, before.modeState.mode);
});

test('runtime loop validates profiles and budgets before issuing a lease', async () => {
  await assert.rejects(
    () => AgentLoopRuntime.start({
      ...createRuntimeRequest(),
      profiles: [{ ...observationProfile, observationScopes: ['task', 'task'] }],
    }, new MemoryContextHistory()),
    /observation scopes must not contain duplicates/,
  );
  await assert.rejects(
    () => AgentLoopRuntime.start({
      ...createRuntimeRequest(),
      budget: { ...createRuntimeRequest().budget, maxModeTransitions: -1 },
    }, new MemoryContextHistory()),
    /maxModeTransitions must be a non-negative safe integer/,
  );
});

test('runtime loop validates scope identity and rejects close with pending observation events', async () => {
  await assert.rejects(
    () => AgentLoopRuntime.start({
      ...createRuntimeRequest(),
      scope: {
        ...scope,
        organId: { scope: 'task', value: 'malformed-organ' },
      } as unknown as ScopeRef,
    }, new MemoryContextHistory()),
    /runtime scope organ id is invalid/,
  );

  const runtime = await createRuntime();
  const currentActor = actor(runtime);
  await assert.rejects(
    () => runtime.openObservationScope({
      actor: currentActor,
      kind: 'task',
      scope: {
        ...scope,
        taskId: { scope: 'cycle', value: 'malformed-task' },
      } as unknown as ScopeRef,
      readableRefs: [],
      capabilities: ['read-task'],
    }),
    /observation scope task id is invalid/,
  );
  await runtime.openObservationScope({
    actor: currentActor,
    kind: 'task',
    scope,
    readableRefs: ['task:state'],
    capabilities: ['read-task'],
  });
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  await assert.rejects(
    () => runtime.closeObservationScope(currentActor),
    /pending observation events/,
  );
  assert.equal(runtime.snapshot().observationScope?.observationScopeId, runtime.snapshot().modeState.observationScopeId);
});

test('runtime loop authorizes scope kind even when no capability is requested', async () => {
  const runtime = await createRuntime();
  await assert.rejects(
    () => runtime.openObservationScope({
      actor: actor(runtime),
      kind: 'memory',
      scope,
      readableRefs: [],
      capabilities: [],
    }),
    /observation scope kind is not granted/,
  );
  assert.equal(runtime.snapshot().lease.leaseId, 'runtime-agent-loop:lease:1');
});

test('runtime loop does not rotate a lease when a reopened scope request is rejected', async () => {
  const runtime = await createRuntime();
  const firstActor = await open(runtime);
  await runtime.closeObservationScope(firstActor);
  const before = runtime.snapshot();
  await assert.rejects(
    () => runtime.openObservationScope({
      actor: actor(runtime),
      kind: 'task',
      scope,
      readableRefs: ['duplicate', 'duplicate'],
      capabilities: ['read-task'],
    }),
    /observation readable refs contains duplicates/,
  );
  const after = runtime.snapshot();
  assert.equal(after.lease.leaseId, before.lease.leaseId);
  assert.equal(after.observationScope, undefined);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
});

test('runtime loop rejects a mode transition with an unconsumed observation batch', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  const before = runtime.snapshot();
  await assert.rejects(
    () => runtime.transitionMode({
      actor: currentActor,
      toMode: 'orchestration',
      reason: 'observation-complete',
      deltaIds: ['pending-transition'],
      summary: 'must consume observation first',
      contextViewRef: 'runtime-agent-loop:context:pending',
      contextDigest: 'digest:pending',
      activeRefs: ['task:state'],
      omittedRefs: [],
      durableContext: durableContext(),
    }),
    /pending observation events/,
  );
  const after = runtime.snapshot();
  assert.equal(after.modeState.mode, before.modeState.mode);
  assert.equal(after.checkpoint.sequence, before.checkpoint.sequence);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
});

test('inspection turn boundary consumer shares one occurrence opening and selects each requested check', async () => {
  // Failure basis: concurrent first selection duplicated occurrence open. Impact: duplicate side effects and ambiguous turn binding.
  // Probability: unknown. Cost: low local execution, low maintenance; reuses the existing Runtime consumer.
  const selectionContext = {
    turn: {
      turnId: 'turn-inspection-1',
      workAssignmentRef: 'assignment:inspection-1',
      taskRef: scope.taskId!,
      scopeRef: scope,
      cycleRef: scope.cycleId!,
      inputRevision: 1,
      directiveRevision: 1,
      executionEpoch: 1,
      runtimeBindingRef: 'runtime-binding:inspection-1',
      permissionRevision: 'permission:inspection-1',
    },
    plan: {
      scope: scope as typeof scope & { taskId: NonNullable<typeof scope.taskId> },
      revisionId: 'plan-revision:inspection-1',
      sequence: 1,
      contentDigest: `sha256:${'1'.repeat(64)}`,
      predecessor: null,
      snapshot: {
        title: 'Inspection consumer',
        summary: 'One check',
        completeness: { scope: 'whole-task', status: 'complete' },
        acceptanceCriteria: [{ criterionId: 'criterion-1', description: 'Accept the check.' }],
        nodes: [],
        phases: [],
        relations: [],
      },
      reason: { kind: 'initial', basisRefs: [] },
      source: {
        requirementId: 'requirement:inspection-1',
        inputRevision: 1,
        draftId: 'draft:inspection-1',
        draftRevisionVersion: 1,
        draftRevisionHash: 'draft-hash:inspection-1',
        confirmationRef: 'confirmation:inspection-1',
        evidenceRefs: [],
      },
      historyCoverage: 'complete-from-task-start',
      publishedAt: '2026-09-20T00:00:00.000Z',
      publishedBy: 'planner',
      journalCommitRef: 'journal:plan:inspection-1',
    },
    planCommitRef: { commitId: 'journal:plan:inspection-1', journalSeq: 1, recordDigest: digest('plan') },
    cycleOpening: {
      kind: 'business-cycle-opened',
      schemaVersion: 1,
      cycle: { id: scope.cycleId!, scope, directiveRevision: 1, executionEpoch: 1, state: 'admitted' },
      taskFlow: { kind: 'inspection', definitionVersion: 1 },
      planRevisionCommitRef: { commitId: 'journal:plan:inspection-1', journalSeq: 1, recordDigest: digest('plan') },
      previousCycleCommitRef: null,
      openedAt: '2026-09-20T00:00:00.000Z',
      openingReason: 'inspection consumer',
    },
    cycleOpenedCommitRef: { commitId: 'journal:cycle:inspection-1', journalSeq: 2, recordDigest: digest('cycle') },
  } as const;
  const assignment = {
    assignmentId: 'assignment:inspection-1',
    taskId: scope.taskId!,
    pipelineNodeId: 'inspection-node-1',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'Inspect one check.',
    targetRefs: ['target:inspection-1'],
    expectedOutputRefs: [],
    successCriteria: [],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  } as const;
  const opened = {
    binding: {
      occurrence: { scope: scope as typeof scope & { taskId: NonNullable<typeof scope.taskId> }, occurrenceId: 'inspection-occurrence-1' },
      executionScope: scope,
      cycleId: scope.cycleId!.value,
      executionEpoch: 1,
      definition: { definitionId: 'inspection-definition-1', definitionVersion: '1' },
      definitionCommitRef: { commitId: 'journal:definition:inspection-1', journalSeq: 3, recordDigest: digest('definition') },
      definitionDigest: `sha256:${'2'.repeat(64)}`,
      cycleOpenedCommitRef: selectionContext.cycleOpenedCommitRef,
      scheduleOccurrenceRef: null,
    },
    check: { checkId: 'check-1', criterion: 'The target is present.', inputRefs: ['target:inspection-1'] },
  } as const;
  let openedCount = 0;
  const openedOccurrences = new Set<string>();
  const boundary = new InspectionTurnBoundary({
    selectionReader: { readSelectionContext: async () => selectionContext },
    journal: {
      commit: async () => { throw new Error('selection consumer must not commit'); },
      read: async () => { throw new Error('selection consumer must not read records'); },
      list: async () => ({ entries: [] }),
    },
    occurrenceOpening: {
      open: async ({ checkId }) => {
        openedCount += 1;
        openedOccurrences.add(opened.binding.occurrence.occurrenceId);
        return {
          ...opened,
          check: { ...opened.check, checkId },
        };
      },
    },
    acceptedDeliveryReader: { readAcceptedDelivery: async () => null },
    acceptedDelivery: { accept: async () => null },
    occurrences: {
      readOccurrenceForTurn: async () => null,
      readOccurrencesForStop: async () => [],
    },
    checkpoints: {
      readCommitted: async () => null,
      readCheckpointRecoveryBinding: async () => null,
      readNativeCheckpoint: async () => null,
    },
    clock: { now: () => new Date('2026-09-20T00:00:00.000Z') },
  });

  const request = {
    logicalTurnId: 'turn-inspection-1',
    context: selectionContext,
    executionScope: scope,
    assignment,
    checkId: 'check-1',
  } as const;
  const [selected, concurrent] = await Promise.all([
    boundary.select(request),
    boundary.select(request),
  ]);
  const alternate = await boundary.select({ ...request, checkId: 'check-2' });

  assert.deepEqual(selected, opened);
  assert.deepEqual(concurrent, opened);
  assert.equal(alternate.check.checkId, 'check-2');
  assert.equal(openedCount, 2);
  assert.equal(openedOccurrences.size, 1);
});

test('inspection turn boundary consumer closes a completed inspection after the wait barrier and persists checkpoint time', async () => {
  // Failure basis: checkpoint.wait is treated as the cycle decision. Impact: a completed inspection stays open forever.
  // Probability: proven by the current boundary. Cost: low local execution; extends the existing consumer.
  const checkpointCommitRef = { commitId: 'checkpoint:inspection-time', journalSeq: 4, recordDigest: digest('checkpoint-time') };
  const settlementCommitRef = { commitId: 'settlement:inspection-time', journalSeq: 5, recordDigest: digest('settlement-time') };
  const closeCommitRef = { commitId: 'close:inspection-time', journalSeq: 6, recordDigest: digest('close-time') };
  const openingCommitRef = { commitId: 'opening:inspection-time', journalSeq: 3, recordDigest: digest('opening-time') };
  const cycleOpenedCommitRef = { commitId: 'journal:cycle:inspection-time', journalSeq: 2, recordDigest: digest('cycle-time') };
  const committedAt = '2026-09-20T00:00:00.000Z';
  const checkpoint = {
    checkpoint: {
      id: id('checkpoint', 'inspection-time'),
      scope,
      cycleId: scope.cycleId!,
      seq: 2,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'succeeded',
      summary: 'inspection time',
      recoveryStateRef: { evidenceId: id('evidence', 'inspection-time-recovery'), kind: 'operation', source: 'test', locator: 'checkpoint', scope },
      evidenceRefs: [],
      next: { kind: 'wait' },
    },
    previous: null,
    commitRef: checkpointCommitRef,
  } as const;
  const childEvidence = {
    evidenceId: id('evidence', 'inspection-time-child'),
    kind: 'operation',
    source: 'test',
    locator: 'inspection-child',
    scope: {
      organId: scope.organId,
      taskId: scope.taskId!,
      cycleId: scope.cycleId!,
      operationId: id('operation', 'inspection-time-child'),
    },
  } as const;
  const closure = {
    identity: {
      turnId: 'turn-inspection-time',
      workAssignmentRef: 'assignment:inspection-time',
      taskRef: scope.taskId!,
      scopeRef: scope,
      cycleRef: scope.cycleId!,
      inputRevision: 1,
      directiveRevision: 1,
      executionEpoch: 1,
      runtimeBindingRef: 'runtime-binding:inspection-time',
      permissionRevision: 'permission:inspection-time',
    },
    checkpointId: checkpoint.checkpoint.id,
    closureRef: 'turn-closure:inspection-time',
    summary: {
      goal: { text: 'settle inspection time', evidenceRefs: [] },
      actions: { text: 'settle after the checkpoint', evidenceRefs: [childEvidence] },
      result: { text: 'inspection settled', evidenceRefs: [] },
      expectedNextStep: { text: 'stop', evidenceRefs: [] },
      inspectionOutcome: { status: 'completed', judgment: 'inspection completed' },
    },
    recoveryStateRef: checkpoint.checkpoint.recoveryStateRef,
    closedAt: '2026-09-30T00:00:00.000Z',
  } as const;
  const summaryEvidenceContext = {
    identity: closure.identity,
    children: [{
      evidenceRef: childEvidence,
      businessRegistrationCommitRef: openingCommitRef,
      providerRequestId: 'request:inspection-time-child',
      toolCallId: 'tool:inspection-time-child',
    }],
  } as const;
  const opening = {
    kind: 'inspection-occurrence-opened',
    schemaVersion: 1,
    occurrence: { scope: scope as typeof scope & { taskId: NonNullable<typeof scope.taskId> }, occurrenceId: 'inspection-occurrence-time' },
    executionScope: scope,
    cycleId: scope.cycleId!.value,
    executionEpoch: 1,
    definition: { definitionId: 'inspection-definition-time', definitionVersion: '1' },
    definitionCommitRef: { commitId: 'journal:definition:inspection-time', journalSeq: 3, recordDigest: digest('definition-time') },
    definitionDigest: `sha256:${'3'.repeat(64)}`,
    planRevisionCommitRef: { commitId: 'journal:plan:inspection-time', journalSeq: 1, recordDigest: digest('plan-time') },
    cycleOpenedCommitRef,
    scheduleOccurrenceRef: null,
    openedAt: committedAt,
  } as const;
  const cycleOpening = {
    kind: 'business-cycle-opened',
    schemaVersion: 1,
    cycle: { id: scope.cycleId!, scope, directiveRevision: 1, executionEpoch: 1, state: 'admitted' },
    taskFlow: { kind: 'inspection', definitionVersion: 1 },
    planRevisionCommitRef: { commitId: 'journal:plan:inspection-time', journalSeq: 1, recordDigest: digest('plan-time') },
    previousCycleCommitRef: null,
    openedAt: committedAt,
    openingReason: 'inspection time',
  } as const;
  const occurrence = {
    logicalTurnId: 'turn-inspection-time',
    opening: { record: opening, commitRef: openingCommitRef },
    cycleOpening: { record: cycleOpening, commitRef: cycleOpenedCommitRef },
    deliveries: [],
    items: [],
  } as const;
  const committed: I2Record[] = [];
  const journal = {
    commit: async (record: I2Record) => {
      committed.push(record);
      if (record.kind === 'inspection-occurrence-settled') return settlementCommitRef;
      if (record.kind === 'business-cycle-closed') return closeCommitRef;
      throw new Error(`unexpected commit: ${record.kind}`);
    },
    read: async () => { throw new Error('time consumer must use list'); },
    list: async () => ({ entries: [] }),
  };
  const checkpoints = {
    readCommitted: async () => checkpoint,
    readCheckpointRecoveryBinding: async () => null,
    readNativeCheckpoint: async () => checkpointRelationship(checkpoint, committedAt),
  };
  const occurrences = {
    readOccurrenceForTurn: async () => occurrence,
    readOccurrencesForStop: async () => [],
  };
  const createBoundary = (now: string) => new InspectionTurnBoundary({
    selectionReader: { readSelectionContext: async () => { throw new Error('settlement must not select'); } },
    journal,
    occurrenceOpening: { open: async () => { throw new Error('settlement must not open'); } },
    acceptedDeliveryReader: { readAcceptedDelivery: async () => null },
    acceptedDelivery: { accept: async () => null },
    occurrences,
    checkpoints,
    clock: { now: () => new Date(now) },
  });
  const first = createBoundary('2030-01-01T00:00:00.000Z');
  const receipt = await first.settleClosure({
    logicalTurnId: 'turn-inspection-time',
    closure,
    checkpoint,
    alignment: inspectionAlignment(closure, 'complete'),
    summaryEvidenceContext,
    milestoneAlignmentCommitRefs: [],
  });

  assert.deepEqual(receipt, { settlementCommitRefs: [settlementCommitRef], cycleClosedCommitRef: closeCommitRef });
  assert.deepEqual(committed.map(({ kind }) => kind), ['inspection-occurrence-settled', 'business-cycle-closed']);
  const close = committed[1];
  const alignmentRef = turnBoundaryRecordRefs(closure.identity, closure.checkpointId).alignmentRef;
  assert.equal(close?.kind === 'business-cycle-closed' && close.next.kind, 'stop');
  assert.equal(close?.kind === 'business-cycle-closed' && close.next.ref, alignmentRef);
  assert.deepEqual(committed.map((record) => record.kind === 'inspection-occurrence-settled'
    ? record.settledAt
    : record.kind === 'business-cycle-closed' ? record.closedAt : undefined), [committedAt, committedAt]);
});

test('inspection turn boundary consumer closes failed alignment once and rejects changed milestone refs', async () => {
  // Failure basis: failed alignment left the cycle open, or replay reused a close with different relationships.
  // Impact: invalid lifecycle history. Probability: proven by the current boundary. Cost: extends the existing consumer.
  const checkpointCommitRef = { commitId: 'checkpoint:inspection-settled', journalSeq: 4, recordDigest: digest('checkpoint') };
  const settlementCommitRef = { commitId: 'settlement:inspection-1', journalSeq: 5, recordDigest: digest('settlement') };
  const closeCommitRef = { commitId: 'close:inspection-1', journalSeq: 6, recordDigest: digest('close') };
  const commits: string[] = [];
  const durableEntries: {
    readonly record: I2Record;
    readonly commitRef: JournalCommitRef;
  }[] = [];
  const checkpoint = {
    checkpoint: {
      id: id('checkpoint', 'inspection-settled'),
      scope,
      cycleId: scope.cycleId!,
      seq: 2,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'succeeded',
      summary: 'inspection settled',
      recoveryStateRef: { evidenceId: id('evidence', 'inspection-recovery'), kind: 'operation', source: 'test', locator: 'checkpoint', scope },
      evidenceRefs: [],
      next: { kind: 'stop' },
    },
    previous: null,
    commitRef: checkpointCommitRef,
  } as const;
  const closure = {
    identity: {
      turnId: 'turn-inspection-1',
      workAssignmentRef: 'assignment:inspection-1',
      taskRef: scope.taskId!,
      scopeRef: scope,
      cycleRef: scope.cycleId!,
      inputRevision: 1,
      directiveRevision: 1,
      executionEpoch: 1,
      runtimeBindingRef: 'runtime-binding:inspection-1',
      permissionRevision: 'permission:inspection-1',
    },
    checkpointId: checkpoint.checkpoint.id,
    closureRef: 'turn-closure:inspection-1',
    summary: {
      goal: { text: 'settle inspection', evidenceRefs: [] },
      actions: { text: 'accept the durable item', evidenceRefs: [] },
      result: { text: 'inspection settled', evidenceRefs: [] },
      expectedNextStep: { text: 'stop', evidenceRefs: [] },
    },
    recoveryStateRef: checkpoint.checkpoint.recoveryStateRef,
    closedAt: '2026-09-20T00:00:00.000Z',
  } as const;
  const alignment = inspectionAlignment(closure, 'failed');
  const milestone = { commitId: 'review:inspection-1', journalSeq: 7, recordDigest: digest('review-inspection-1') };
  const settlementEntry = {
    record: {
      kind: 'inspection-occurrence-settled',
      schemaVersion: 1,
      openingCommitRef: { commitId: 'opening:inspection-1', journalSeq: 3, recordDigest: digest('opening') },
      occurrence: { scope: scope as typeof scope & { taskId: NonNullable<typeof scope.taskId> }, occurrenceId: 'inspection-occurrence-1' },
      definition: { definitionId: 'inspection-definition-1', definitionVersion: '1' },
      itemResultCommitRefs: [],
      outcome: { status: 'failed', reason: 'missing' },
      checkpointCommitRef,
      settledAt: '2026-09-20T00:00:00.000Z',
    },
    commitRef: settlementCommitRef,
  } as const;
  durableEntries.push(settlementEntry);
  const boundary = new InspectionTurnBoundary({
    selectionReader: { readSelectionContext: async () => { throw new Error('settle must not read selection'); } },
    journal: {
      commit: async (record) => {
        commits.push(record.kind);
        if (record.kind === 'business-cycle-closed') {
          durableEntries.push({ record, commitRef: closeCommitRef });
          return closeCommitRef;
        }
        throw new Error('unexpected settlement commit');
      },
      read: async () => { throw new Error('settle scan must use list'); },
      list: async () => ({ entries: durableEntries }),
    },
    occurrenceOpening: { open: async () => { throw new Error('settle must not open'); } },
    acceptedDeliveryReader: { readAcceptedDelivery: async () => null },
    acceptedDelivery: { accept: async () => null },
    occurrences: {
      readOccurrenceForTurn: async () => ({
        logicalTurnId: 'turn-inspection-1',
        opening: {
          record: {
            kind: 'inspection-occurrence-opened',
            schemaVersion: 1,
            occurrence: { scope: scope as typeof scope & { taskId: NonNullable<typeof scope.taskId> }, occurrenceId: 'inspection-occurrence-1' },
            executionScope: scope,
            cycleId: scope.cycleId!.value,
            executionEpoch: 1,
            definition: { definitionId: 'inspection-definition-1', definitionVersion: '1' },
            definitionCommitRef: { commitId: 'journal:definition:inspection-1', journalSeq: 3, recordDigest: digest('definition') },
            definitionDigest: `sha256:${'2'.repeat(64)}`,
            planRevisionCommitRef: { commitId: 'journal:plan:inspection-1', journalSeq: 1, recordDigest: digest('plan') },
            cycleOpenedCommitRef: { commitId: 'journal:cycle:inspection-1', journalSeq: 2, recordDigest: digest('cycle') },
            scheduleOccurrenceRef: null,
            openedAt: '2026-09-20T00:00:00.000Z',
          },
          commitRef: { commitId: 'opening:inspection-1', journalSeq: 3, recordDigest: digest('opening') },
        },
        cycleOpening: {
          record: {
            kind: 'business-cycle-opened',
            schemaVersion: 1,
            cycle: { id: scope.cycleId!, scope, directiveRevision: 1, executionEpoch: 1, state: 'admitted' },
            taskFlow: { kind: 'inspection', definitionVersion: 1 },
            planRevisionCommitRef: { commitId: 'journal:plan:inspection-1', journalSeq: 1, recordDigest: digest('plan') },
            previousCycleCommitRef: null,
            openedAt: '2026-09-20T00:00:00.000Z',
            openingReason: 'inspection consumer',
          },
          commitRef: { commitId: 'journal:cycle:inspection-1', journalSeq: 2, recordDigest: digest('cycle') },
        },
        deliveries: [],
        items: [],
        settlement: settlementEntry,
      }),
      readOccurrencesForStop: async () => [],
    },
    checkpoints: {
      readCommitted: async () => checkpoint,
      readCheckpointRecoveryBinding: async () => null,
      readNativeCheckpoint: async () => checkpointRelationship(checkpoint, '2026-09-20T00:00:00.000Z'),
    },
    clock: { now: () => new Date('2026-09-20T00:00:00.000Z') },
  });

  const receipt = await boundary.settleClosure({
    logicalTurnId: 'turn-inspection-1',
    closure,
    checkpoint,
    alignment,
    milestoneAlignmentCommitRefs: [milestone],
  });
  const replay = await boundary.settleClosure({
    logicalTurnId: 'turn-inspection-1',
    closure,
    checkpoint,
    alignment,
    milestoneAlignmentCommitRefs: [milestone],
  });

  assert.deepEqual(receipt, { settlementCommitRefs: [settlementCommitRef], cycleClosedCommitRef: closeCommitRef });
  assert.deepEqual(replay, receipt);
  assert.deepEqual(commits, ['business-cycle-closed']);
  const close = durableEntries.find(({ record }) => record.kind === 'business-cycle-closed')?.record;
  assert.equal(close?.kind === 'business-cycle-closed' && close.outcome, 'stop');
  assert.equal(close?.kind === 'business-cycle-closed' && close.next.ref,
    turnBoundaryRecordRefs(alignment.identity, alignment.checkpointId).alignmentRef);
  await assert.rejects(() => boundary.settleClosure({
    logicalTurnId: 'turn-inspection-1',
    closure,
    checkpoint,
    alignment,
    milestoneAlignmentCommitRefs: [
      milestone,
      { commitId: 'review:inspection-1-other', journalSeq: 8, recordDigest: digest('review-inspection-1-other') },
    ],
  }), /cycle close/);
  assert.deepEqual(commits, ['business-cycle-closed']);
});

test('inspection turn boundary consumer settles declared aggregate outcome without inventing missing item results', async () => {
  // Failure basis: next action was used as the aggregate outcome. Impact: completed inspection history can be recorded
  // as blocked/unknown, and replay can silently reuse a conflicting declaration. Probability: unknown. Cost: one local
  // public-port consumer with the existing checkpoint and scope fixtures.
  const createConsumer = (suffix: string, inspectionOutcome?: InspectionExecutionOutcome) => {
    const logicalTurnId = `turn-inspection-aggregate-${suffix}`;
    const checkpointCommitRef = {
      commitId: `checkpoint:inspection-aggregate-${suffix}`,
      journalSeq: 4,
      recordDigest: digest(`checkpoint-aggregate-${suffix}`),
    };
    const openingCommitRef = {
      commitId: `opening:inspection-aggregate-${suffix}`,
      journalSeq: 3,
      recordDigest: digest(`opening-aggregate-${suffix}`),
    };
    const cycleOpenedCommitRef = {
      commitId: `journal:cycle:inspection-aggregate-${suffix}`,
      journalSeq: 2,
      recordDigest: digest(`cycle-aggregate-${suffix}`),
    };
    const settlementCommitRef = {
      commitId: `settlement:inspection-aggregate-${suffix}`,
      journalSeq: 5,
      recordDigest: digest(`settlement-aggregate-${suffix}`),
    };
    const committedAt = '2026-09-20T00:00:00.000Z';
    const next = { kind: 'continue' } as const;
    const checkpoint = {
      checkpoint: {
        id: id('checkpoint', `inspection-aggregate-${suffix}`),
        scope,
        cycleId: scope.cycleId!,
        seq: 2,
        previousCheckpointId: null,
        directiveRevision: 1,
        executionEpoch: 1,
        outcome: 'succeeded',
        summary: 'inspection aggregate settlement',
        recoveryStateRef: { evidenceId: id('evidence', `inspection-aggregate-recovery-${suffix}`),
          kind: 'operation', source: 'test', locator: 'checkpoint', scope },
        evidenceRefs: [],
        next,
      },
      previous: null,
      commitRef: checkpointCommitRef,
    } as const;
    const summary: TurnCloseSummary = {
      goal: { text: 'inspect the target', evidenceRefs: [] },
      actions: { text: 'record the declared aggregate result', evidenceRefs: [] },
      result: { text: 'the target was inspected', evidenceRefs: [] },
      expectedNextStep: { text: 'continue the shared cycle', evidenceRefs: [] },
      ...(inspectionOutcome === undefined ? {} : { inspectionOutcome }),
    };
    const closure = {
      identity: {
        turnId: logicalTurnId,
        workAssignmentRef: `assignment:inspection-aggregate-${suffix}`,
        taskRef: scope.taskId!,
        scopeRef: scope,
        cycleRef: scope.cycleId!,
        inputRevision: 1,
        directiveRevision: 1,
        executionEpoch: 1,
        runtimeBindingRef: `runtime-binding:inspection-aggregate-${suffix}`,
        permissionRevision: `permission:inspection-aggregate-${suffix}`,
      },
      checkpointId: checkpoint.checkpoint.id,
      closureRef: `turn-closure:inspection-aggregate-${suffix}`,
      summary,
      recoveryStateRef: checkpoint.checkpoint.recoveryStateRef,
      closedAt: committedAt,
    } as const;
    const occurrence = {
      logicalTurnId,
      opening: {
        record: {
          kind: 'inspection-occurrence-opened',
          schemaVersion: 1,
          occurrence: { scope: scope as typeof scope & { taskId: NonNullable<typeof scope.taskId> },
            occurrenceId: `inspection-occurrence-aggregate-${suffix}` },
          executionScope: scope,
          cycleId: scope.cycleId!.value,
          executionEpoch: 1,
          definition: { definitionId: 'inspection-definition-aggregate', definitionVersion: '1' },
          definitionCommitRef: { commitId: 'journal:definition:inspection-aggregate', journalSeq: 1,
            recordDigest: digest('definition-aggregate') },
          definitionDigest: `sha256:${'4'.repeat(64)}`,
          planRevisionCommitRef: { commitId: 'journal:plan:inspection-aggregate', journalSeq: 1,
            recordDigest: digest('plan-aggregate') },
          cycleOpenedCommitRef,
          scheduleOccurrenceRef: null,
          openedAt: committedAt,
        },
        commitRef: openingCommitRef,
      },
      cycleOpening: {
        record: {
          kind: 'business-cycle-opened',
          schemaVersion: 1,
          cycle: { id: scope.cycleId!, scope, directiveRevision: 1, executionEpoch: 1, state: 'admitted' },
          taskFlow: { kind: 'inspection', definitionVersion: 1 },
          planRevisionCommitRef: { commitId: 'journal:plan:inspection-aggregate', journalSeq: 1,
            recordDigest: digest('plan-aggregate') },
          previousCycleCommitRef: null,
          openedAt: committedAt,
          openingReason: 'inspection aggregate settlement',
        },
        commitRef: cycleOpenedCommitRef,
      },
      deliveries: [],
      items: [],
    } as const;
    const durableEntries: { readonly record: I2Record; readonly commitRef: JournalCommitRef }[] = [];
    const committed: I2Record[] = [];
    const boundary = new InspectionTurnBoundary({
      selectionReader: { readSelectionContext: async () => { throw new Error('settle must not select'); } },
      journal: {
        commit: async (record) => {
          committed.push(record);
          if (record.kind !== 'inspection-occurrence-settled') throw new Error(`unexpected commit: ${record.kind}`);
          durableEntries.push({ record, commitRef: settlementCommitRef });
          return settlementCommitRef;
        },
        read: async () => { throw new Error('settle scan must use list'); },
        list: async () => ({ entries: durableEntries }),
      },
      occurrenceOpening: { open: async () => { throw new Error('settle must not open'); } },
      acceptedDeliveryReader: { readAcceptedDelivery: async () => null },
      acceptedDelivery: { accept: async () => null },
      occurrences: {
        readOccurrenceForTurn: async () => occurrence,
        readOccurrencesForStop: async () => [],
      },
      checkpoints: {
        readCommitted: async () => checkpoint,
        readCheckpointRecoveryBinding: async () => null,
        readNativeCheckpoint: async () => checkpointRelationship(checkpoint, committedAt),
      },
      clock: { now: () => new Date('2030-01-01T00:00:00.000Z') },
    });
    return { boundary, checkpoint, closure, committed };
  };

  const declared = createConsumer('declared', { status: 'completed', judgment: 'target inspected with free-form judgment' });
  const declaredInput = {
    logicalTurnId: declared.closure.identity.turnId,
    closure: declared.closure,
    checkpoint: declared.checkpoint,
    alignment: inspectionAlignment(declared.closure, 'continue'),
    milestoneAlignmentCommitRefs: [],
  };
  const declaredReceipt = await declared.boundary.settleClosure(declaredInput);
  assert.deepEqual(declaredReceipt, { settlementCommitRefs: [{
    commitId: 'settlement:inspection-aggregate-declared', journalSeq: 5,
    recordDigest: digest('settlement-aggregate-declared'),
  }] });
  const declaredSettlement = declared.committed[0];
  assert.equal(declaredSettlement?.kind, 'inspection-occurrence-settled');
  assert.deepEqual(declaredSettlement?.kind === 'inspection-occurrence-settled' && declaredSettlement.outcome,
    { status: 'completed', judgment: 'target inspected with free-form judgment' });
  assert.deepEqual(declaredSettlement?.kind === 'inspection-occurrence-settled' && declaredSettlement.itemResultCommitRefs, []);

  const matchingReplay = await declared.boundary.settleClosure(declaredInput);
  assert.deepEqual(matchingReplay, declaredReceipt);
  assert.equal(declared.committed.length, 1);
  await assert.rejects(
    () => declared.boundary.settleClosure({
      ...declaredInput,
      closure: {
        ...declared.closure,
        summary: { ...declared.closure.summary,
          inspectionOutcome: { status: 'completed', judgment: 'conflicting replay judgment' } },
      },
      alignment: inspectionAlignment({
        ...declared.closure,
        summary: { ...declared.closure.summary,
          inspectionOutcome: { status: 'completed', judgment: 'conflicting replay judgment' } },
      }, 'continue'),
    }),
    /outcome conflicts/,
  );
  assert.equal(declared.committed.length, 1);

  const undeclared = createConsumer('undeclared');
  await undeclared.boundary.settleClosure({
    logicalTurnId: undeclared.closure.identity.turnId,
    closure: undeclared.closure,
    checkpoint: undeclared.checkpoint,
    alignment: inspectionAlignment(undeclared.closure, 'continue'),
    milestoneAlignmentCommitRefs: [],
  });
  const undeclaredSettlement = undeclared.committed[0];
  assert.equal(undeclaredSettlement?.kind === 'inspection-occurrence-settled' && undeclaredSettlement.outcome.status, 'unknown');

  const mismatchedScope = createConsumer('scope-mismatch');
  const foreignScope = { ...scope, cycleId: id('cycle', 'cycle-agent-loop-foreign') };
  const foreignIdentity = {
    ...mismatchedScope.closure.identity,
    scopeRef: foreignScope,
    cycleRef: foreignScope.cycleId!,
  };
  await assert.rejects(() => mismatchedScope.boundary.settleClosure({
    logicalTurnId: foreignIdentity.turnId,
    closure: {
      ...mismatchedScope.closure,
      identity: foreignIdentity,
      recoveryStateRef: { ...mismatchedScope.closure.recoveryStateRef, scope: foreignScope },
    },
    checkpoint: mismatchedScope.checkpoint,
    alignment: inspectionAlignment({ ...mismatchedScope.closure, identity: foreignIdentity }, 'continue'),
    milestoneAlignmentCommitRefs: [],
  }), /cycle identity/);
  assert.equal(mismatchedScope.committed.length, 0);

  const mismatchedAlignment = createConsumer('alignment-mismatch');
  await assert.rejects(() => mismatchedAlignment.boundary.settleClosure({
    logicalTurnId: mismatchedAlignment.closure.identity.turnId,
    closure: mismatchedAlignment.closure,
    checkpoint: mismatchedAlignment.checkpoint,
    alignment: {
      ...inspectionAlignment(mismatchedAlignment.closure, 'continue'),
      checkpointId: id('checkpoint', 'inspection-aggregate-other'),
    },
    milestoneAlignmentCommitRefs: [],
  }), /closure checkpoint/);
  assert.equal(mismatchedAlignment.committed.length, 0);
});

test('inspection turn boundary consumer reuses a durable item without executing the child twice', async () => {
  // Failure basis: durable item replay called accept again. Impact: repeated execution or a duplicate artifact.
  // Probability: unknown. Cost: low local execution, low maintenance; reuses the existing Runtime consumer.
  const definitionCommitRef = { commitId: 'journal:definition:inspection-1', journalSeq: 3, recordDigest: digest('definition') };
  const cycleOpenedCommitRef = { commitId: 'journal:cycle:inspection-1', journalSeq: 2, recordDigest: digest('cycle') };
  const itemCommitRef = { commitId: 'item:inspection-1', journalSeq: 7, recordDigest: digest('item') };
  const checkId = 'check-1';
  const invocationId = 'invocation:inspection-1';
  const binding = {
    occurrence: { scope: scope as typeof scope & { taskId: NonNullable<typeof scope.taskId> }, occurrenceId: 'inspection-occurrence-1' },
    executionScope: scope,
    cycleId: scope.cycleId!.value,
    executionEpoch: 1,
    definition: { definitionId: 'inspection-definition-1', definitionVersion: '1' },
    definitionCommitRef,
    definitionDigest: `sha256:${'2'.repeat(64)}`,
    cycleOpenedCommitRef,
    scheduleOccurrenceRef: null,
  } as const;
  const assignment = {
    assignmentId: 'assignment:inspection-1',
    taskId: scope.taskId!,
    pipelineNodeId: 'inspection-node-1',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'Inspect one check.',
    targetRefs: ['target:inspection-1'],
    expectedOutputRefs: [],
    successCriteria: [],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  } as const;
  const result = {
    taskId: scope.taskId!,
    pipelineNodeId: 'inspection-node-1',
    agentId: 'agent-inspection-1',
    assignmentId: assignment.assignmentId,
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    producedArtifactRefs: [],
    status: 'succeeded',
    summary: 'inspection completed',
    outputRefs: [],
    evidenceRefs: [],
    nextAction: 'continue',
  } as const;
  const delivery = {
    checkId,
    resultId: `inspection-result:${invocationId}`,
    attempt: 1,
    outcome: { status: 'completed', judgment: 'present' },
    evidenceRefs: [],
    completedAt: '2026-09-20T00:00:00.000Z',
  } as const;
  const accepted = {
    kind: 'execution',
    seq: 1,
    invocationId,
    refinedDelivery: {
      ref: { evidenceId: id('evidence', 'refined-inspection-1'), kind: 'execution', source: 'test', locator: 'refined', scope },
      view: { kind: 'utf8-text' },
    },
    assignment,
    result,
    inspectionDelivery: delivery,
  } as const;
  const invocation = {
    invocationId,
    childTurnId: 'child-turn-inspection-1',
    checkpointReceiptRef: 'checkpoint:inspection-1',
    binding: {
      kind: 'execution',
      assignment,
      inspection: {
        binding,
        check: { checkId, criterion: 'The target is present.', inputRefs: ['target:inspection-1'] },
      },
    },
  } as const;
  let acceptCalls = 0;
  let directCommits = 0;
  const boundary = new InspectionTurnBoundary({
    selectionReader: { readSelectionContext: async () => { throw new Error('delivery must not select'); } },
    journal: {
      commit: async () => { directCommits += 1; throw new Error('durable item must be reused'); },
      read: async () => { throw new Error('delivery must use list'); },
      list: async () => ({
        entries: [{
          record: { kind: 'inspection-item-result', schemaVersion: 1, binding, delivery },
          commitRef: itemCommitRef,
        }],
      }),
    },
    occurrenceOpening: { open: async () => { throw new Error('delivery must not open'); } },
    acceptedDeliveryReader: { readAcceptedDelivery: async () => accepted },
    acceptedDelivery: {
      accept: async () => {
        acceptCalls += 1;
        return delivery;
      },
    },
    occurrences: {
      readOccurrenceForTurn: async () => null,
      readOccurrencesForStop: async () => [],
    },
    checkpoints: {
      readCommitted: async () => null,
      readCheckpointRecoveryBinding: async () => null,
      readNativeCheckpoint: async () => null,
    },
    clock: { now: () => new Date('2026-09-20T00:00:00.000Z') },
  });

  const first = await boundary.acceptDelivery({ invocation, delivery: accepted });
  const replay = await boundary.acceptDelivery({ invocation, delivery: accepted });

  assert.deepEqual(first, itemCommitRef);
  assert.deepEqual(replay, itemCommitRef);
  assert.equal(acceptCalls, 0);
  assert.equal(directCommits, 0);
});

test('inspection turn boundary consumer only settles a committed stopped checkpoint', async () => {
  // Failure basis: stop settlement accepted a non-exact or non-stopped checkpoint. Impact: false stop completion.
  // Probability: unknown. Cost: low local execution, low maintenance; reuses the existing Runtime consumer.
  const stopped = {
    checkpoint: {
      id: id('checkpoint', 'inspection-stop'),
      scope,
      cycleId: scope.cycleId!,
      seq: 2,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'stopped',
      summary: 'operator stopped inspection',
      recoveryStateRef: { evidenceId: id('evidence', 'inspection-stop-recovery'), kind: 'operation', source: 'test', locator: 'checkpoint', scope },
      evidenceRefs: [],
      next: { kind: 'stop' },
    },
    previous: null,
    commitRef: { commitId: 'checkpoint:inspection-stop', journalSeq: 8, recordDigest: digest('stop') },
  } as const;
  const boundary = new InspectionTurnBoundary({
    selectionReader: { readSelectionContext: async () => { throw new Error('stop must not select'); } },
    journal: {
      commit: async () => { throw new Error('stop with no occurrence must not commit'); },
      read: async () => { throw new Error('stop must not read records'); },
      list: async () => ({ entries: [] }),
    },
    occurrenceOpening: { open: async () => { throw new Error('stop must not open'); } },
    acceptedDeliveryReader: { readAcceptedDelivery: async () => null },
    acceptedDelivery: { accept: async () => null },
    occurrences: {
      readOccurrenceForTurn: async () => null,
      readOccurrencesForStop: async () => [],
    },
    checkpoints: {
      readCommitted: async () => stopped,
      readCheckpointRecoveryBinding: async () => { throw new Error('stop helper owns receipt verification'); },
      readNativeCheckpoint: async () => checkpointRelationship(stopped, '2026-09-20T00:00:00.000Z'),
    },
    clock: { now: () => new Date('2026-09-20T00:00:00.000Z') },
  });

  const receipt = await boundary.settleStop({ checkpoint: stopped });

  assert.deepEqual(receipt, { settlementCommitRefs: [] });
  await assert.rejects(
    () => boundary.settleStop({ checkpoint: { ...stopped, checkpoint: { ...stopped.checkpoint, outcome: 'succeeded' } } }),
    /exact committed checkpoint/,
  );
});

test('inspection stop completion rejects an existing cycle close for another checkpoint', async () => {
  // Failure basis: existingClose returned without checking its checkpoint, settlement, outcome or next action.
  // Impact: a false complete receipt for unrelated durable history. Probability: unknown. Cost: one local consumer.
  const committedAt = '2026-10-17T00:00:00.000Z';
  const checkpoint = {
    checkpoint: {
      id: id('checkpoint', 'inspection-close-conflict'),
      scope,
      cycleId: scope.cycleId!,
      seq: 2,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'stopped',
      summary: 'stop inspection',
      recoveryStateRef: { evidenceId: id('evidence', 'inspection-close-recovery'), kind: 'operation', source: 'test', locator: 'checkpoint', scope },
      evidenceRefs: [],
      next: { kind: 'stop' },
    },
    previous: null,
    commitRef: { commitId: 'checkpoint:inspection-close-conflict', journalSeq: 4, recordDigest: digest('checkpoint-close-conflict') },
  } as const;
  const openingCommitRef = { commitId: 'opening:inspection-close-conflict', journalSeq: 3, recordDigest: digest('opening-close-conflict') };
  const cycleOpenedCommitRef = { commitId: 'cycle:inspection-close-conflict', journalSeq: 2, recordDigest: digest('cycle-close-conflict') };
  const settlementCommitRef = { commitId: 'settlement:inspection-close-conflict', journalSeq: 5, recordDigest: digest('settlement-close-conflict') };
  const wrongCheckpointCommitRef = { commitId: 'checkpoint:inspection-close-other', journalSeq: 6, recordDigest: digest('checkpoint-close-other') };
  const wrongSettlementCommitRef = { commitId: 'settlement:inspection-close-other', journalSeq: 7, recordDigest: digest('settlement-close-other') };
  const settlementEntry = {
    record: {
      kind: 'inspection-occurrence-settled',
      schemaVersion: 1,
      openingCommitRef,
      occurrence: { scope: scope as typeof scope & { taskId: NonNullable<typeof scope.taskId> }, occurrenceId: 'inspection-close-conflict' },
      definition: { definitionId: 'inspection-definition-close-conflict', definitionVersion: '1' },
      itemResultCommitRefs: [],
      outcome: { status: 'unknown', reason: 'stopped before inspection completed' },
      checkpointCommitRef: checkpoint.commitRef,
      settledAt: committedAt,
    },
    commitRef: settlementCommitRef,
  } as const;
  const occurrence: InspectionOccurrenceFacts = {
    logicalTurnId: 'turn-inspection-close-conflict',
    opening: {
      record: {
        kind: 'inspection-occurrence-opened',
        schemaVersion: 1,
        logicalTurnId: 'turn-inspection-close-conflict',
        occurrence: { scope: scope as typeof scope & { taskId: NonNullable<typeof scope.taskId> }, occurrenceId: 'inspection-close-conflict' },
        executionScope: scope,
        cycleId: scope.cycleId!.value,
        executionEpoch: 1,
        definition: { definitionId: 'inspection-definition-close-conflict', definitionVersion: '1' },
        definitionCommitRef: { commitId: 'definition:inspection-close-conflict', journalSeq: 1, recordDigest: digest('definition-close-conflict') },
        definitionDigest: `sha256:${'5'.repeat(64)}`,
        planRevisionCommitRef: { commitId: 'plan:inspection-close-conflict', journalSeq: 1, recordDigest: digest('plan-close-conflict') },
        cycleOpenedCommitRef,
        scheduleOccurrenceRef: null,
        openedAt: committedAt,
      },
      commitRef: openingCommitRef,
    },
    cycleOpening: {
      record: {
        kind: 'business-cycle-opened',
        schemaVersion: 1,
        cycle: { id: scope.cycleId!, scope, directiveRevision: 1, executionEpoch: 1, state: 'admitted' },
        taskFlow: { kind: 'inspection', definitionVersion: 1 },
        planRevisionCommitRef: { commitId: 'plan:inspection-close-conflict', journalSeq: 1, recordDigest: digest('plan-close-conflict') },
        previousCycleCommitRef: null,
        openedAt: committedAt,
        openingReason: 'inspection close conflict',
      },
      commitRef: cycleOpenedCommitRef,
    },
    deliveries: [],
    items: [],
    settlement: settlementEntry,
    close: {
      record: {
        kind: 'business-cycle-closed',
        schemaVersion: 1,
        openedCommitRef: cycleOpenedCommitRef,
        cycleId: scope.cycleId!,
        outcome: 'stop',
        checkpointCommitRef: wrongCheckpointCommitRef,
        milestoneAlignmentCommitRefs: [],
        inspectionSettlementCommitRef: wrongSettlementCommitRef,
        next: { kind: 'stop' },
        closedAt: committedAt,
      },
      commitRef: { commitId: 'close:inspection-close-conflict', journalSeq: 8, recordDigest: digest('close-close-conflict') },
    },
  };
  const boundary = new InspectionTurnBoundary({
    selectionReader: { readSelectionContext: async () => { throw new Error('stop must not select'); } },
    journal: {
      commit: async () => { throw new Error('conflicting close must not commit'); },
      read: async () => { throw new Error('stop must use list'); },
      list: async () => ({ entries: [settlementEntry] }),
    },
    occurrenceOpening: { open: async () => { throw new Error('stop must not open'); } },
    acceptedDeliveryReader: { readAcceptedDelivery: async () => null },
    acceptedDelivery: { accept: async () => null },
    occurrences: {
      readOccurrenceForTurn: async () => null,
      readOccurrencesForStop: async () => [occurrence],
    },
    checkpoints: {
      readCommitted: async () => checkpoint,
      readCheckpointRecoveryBinding: async () => null,
      readNativeCheckpoint: async () => checkpointRelationship(checkpoint, committedAt),
    },
    clock: { now: () => new Date(committedAt) },
  });

  await assert.rejects(() => boundary.settleStop({ checkpoint }), /cycle close/);
});

test('inspection stop completion query precedes recovery and reuses its exact settlement', async () => {
  // Failure basis: action and query disagree on durability, or a pure query writes settlement facts.
  // Impact: false completion or missed recovery. Probability: unknown. Cost: one existing consumer.
  const f = inspectionHelperConsumer();
  const helpers = f.helpers();
  const context = await helpers.selectionReader.readSelectionContext('inspection-turn');
  await helpers.occurrenceOpening.open({ context, logicalTurnId: 'inspection-turn', executionScope: scope,
    assignment: f.assignment, checkId: 'a' });
  const checkpoint: CommittedCheckpointFixture = { checkpoint: { id: id('checkpoint', 'stop-completion'), scope,
    cycleId: scope.cycleId!, seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 1,
    outcome: 'stopped', summary: 'stop inspection', recoveryStateRef: f.raw.ref, evidenceRefs: [], next: { kind: 'stop' } },
    previous: null, commitRef: { commitId: 'checkpoint:stop-completion', journalSeq: 9,
      recordDigest: digest('checkpoint-stop-completion') } };
  const receipt = { commitIdentity: 'committed:stop-completion', journalReceiptRef: 'journal:stop-completion',
    commitFactDigest: 'fact:stop-completion', journalSeq: 2, recordDigest: 'record:stop-completion',
    turnId: 'inspection-turn', boundaryId: 'boundary', capture: f.raw };
  const readback = { receipt, prepared: { body: f.capture(), controlRecordCount: 0, producerDrains: [], completionLookups: [],
    recovery: { recoveryResponsibilityRef: 'recovery', unresolvedOperationRefs: [], rawTurnRefs: [], laterErrorRefs: [],
      commitIdentity: 'save', stages: [], durablePhases: [], durableReceiptRefs: [] } } };
  let stopReads = 0;
  f.stop(checkpoint, { turn: context.turn, boundaryId: 'boundary', recoveryAssetsReceiptRef: 'committed:stop-completion',
    assets: {
      readRecoveryAssetsExact: async () => readback,
      readBoundaryRecoveryAssetsExact: async () => {
        stopReads += 1;
        return { version: 1, assets: readback };
      },
    },
    segments: {
      readInitialOpenExact: async () => { throw new Error('unexpected initial-open'); },
      readSegmentInterruptedExact: async () => { throw new Error('unexpected interrupted'); },
    } });
  let writes = 0;
  const commit = f.dependencies.journal.commit;
  f.dependencies.journal.commit = async (record) => {
    writes += 1;
    return commit(record);
  };
  const boundary = new InspectionTurnBoundary({
    selectionReader: helpers.selectionReader,
    journal: f.dependencies.journal,
    occurrenceOpening: helpers.occurrenceOpening,
    acceptedDeliveryReader: helpers.acceptedDeliveryReader,
    acceptedDelivery: helpers.acceptedDelivery,
    occurrences: helpers.occurrences,
    checkpoints: {
      readCommitted: async () => checkpoint,
      readCheckpointRecoveryBinding: async () => null,
      readNativeCheckpoint: async () => checkpointRelationship(checkpoint, f.time),
    },
    clock: { now: () => new Date(f.time) },
  });
  const port = createRuntimeInspectionStopSettlementPort({ boundary, occurrences: helpers.occurrences });

  const before = await port.readStopCompletion({ checkpoint });
  assert.equal(before.state, 'recovery-required');
  assert.equal(writes, 0);
  assert.equal(stopReads, 1);
  await assert.rejects(() => port.readStopCompletion({ checkpoint: { ...checkpoint,
    checkpoint: { ...checkpoint.checkpoint, outcome: 'succeeded', next: { kind: 'continue' } } } }),
  /requires a stopped checkpoint/);

  const action = await port.settleStop({ checkpoint });
  assert.equal(action.state, 'complete');
  const writesAfterAction = writes;
  const readsAfterAction = stopReads;
  const after = await port.readStopCompletion({ checkpoint });
  assert.equal(after.state, 'complete');
  assert.deepEqual(after, action);
  assert.equal(writes, writesAfterAction);
  assert.equal(stopReads, readsAfterAction + 1);

  f.entries.splice(f.entries.findIndex(({ record }) => record.kind === 'inspection-occurrence-settled'), 1);
  const missing = await port.readStopCompletion({ checkpoint });
  assert.equal(missing.state, 'recovery-required');
  assert.equal(writes, writesAfterAction);
});

test('inspection stop completion compares reordered full item evidence and rejects value drift', async () => {
  // Failure basis: durable items and exact capture records can encode the same binding and delivery with different
  // object key order. Impact: a fresh reader reports recovery-required or blocked for a settled stop.
  // Probability: proven by the opened stop fixture. Cost: one existing Runtime helper consumer.
  const f = inspectionHelperConsumer();
  const helpers = f.helpers();
  const context = await helpers.selectionReader.readSelectionContext('inspection-turn');
  const inspection = await helpers.occurrenceOpening.open({ context, logicalTurnId: 'inspection-turn', executionScope: scope,
    assignment: f.assignment, checkId: 'a' });
  const invocation: ChildInvocationRecord = { invocationId: 'inspection-stop-order-child',
    childTurnId: 'inspection-stop-order-child-turn', checkpointReceiptRef: 'child-checkpoint',
    binding: { kind: 'execution', assignment: f.assignment, inspection } };
  const delivery: AcceptedExecutionChildDelivery = { kind: 'execution', seq: 1, invocationId: invocation.invocationId,
    assignment: f.assignment, refinedDelivery: f.raw,
    result: { taskId: f.assignment.taskId, pipelineNodeId: f.assignment.pipelineNodeId, agentId: 'child',
      assignmentId: f.assignment.assignmentId, attempt: 1, executionEpoch: 1, inputRevision: 1,
      producedArtifactRefs: [], status: 'succeeded', summary: 'observed a',
      outputRefs: [], evidenceRefs: [f.raw.ref], nextAction: 'settle' },
    inspectionDelivery: { checkId: 'a', resultId: `inspection-result:${invocation.invocationId}`, attempt: 1,
      outcome: { status: 'completed', judgment: 'a observed before stop' }, evidenceRefs: [f.raw.ref], completedAt: f.time } };
  f.setCapture({ ...f.capture(), childInvocations: [invocation], entries: [delivery] });
  const checkpoint: CommittedCheckpointFixture = { checkpoint: { id: id('checkpoint', 'stop-completion-order'), scope,
    cycleId: scope.cycleId!, seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 1,
    outcome: 'stopped', summary: 'stop inspection', recoveryStateRef: f.raw.ref, evidenceRefs: [], next: { kind: 'stop' } },
    previous: null, commitRef: { commitId: 'checkpoint:stop-completion-order', journalSeq: 9,
      recordDigest: digest('checkpoint-stop-completion-order') } };
  const receipt = { commitIdentity: 'committed:stop-completion-order', journalReceiptRef: 'journal:stop-completion-order',
    commitFactDigest: 'fact:stop-completion-order', journalSeq: 2, recordDigest: 'record:stop-completion-order',
    turnId: 'inspection-turn', boundaryId: 'boundary', capture: f.raw };
  const readback = { receipt, prepared: { body: f.capture(), controlRecordCount: 0, producerDrains: [], completionLookups: [],
    recovery: { recoveryResponsibilityRef: 'recovery', unresolvedOperationRefs: [], rawTurnRefs: [], laterErrorRefs: [],
      commitIdentity: 'save', stages: [], durablePhases: [], durableReceiptRefs: [] } } };
  f.stop(checkpoint, { turn: context.turn, boundaryId: 'boundary', recoveryAssetsReceiptRef: 'committed:stop-completion-order',
    assets: {
      readRecoveryAssetsExact: async () => readback,
      readBoundaryRecoveryAssetsExact: async () => ({ version: 1, assets: readback }),
    },
    segments: {
      readInitialOpenExact: async () => { throw new Error('unexpected initial-open'); },
      readSegmentInterruptedExact: async () => { throw new Error('unexpected interrupted'); },
    } });
  const boundary = new InspectionTurnBoundary({
    selectionReader: helpers.selectionReader,
    journal: f.dependencies.journal,
    occurrenceOpening: helpers.occurrenceOpening,
    acceptedDeliveryReader: helpers.acceptedDeliveryReader,
    acceptedDelivery: helpers.acceptedDelivery,
    occurrences: helpers.occurrences,
    checkpoints: {
      readCommitted: async () => checkpoint,
      readCheckpointRecoveryBinding: async () => null,
      readNativeCheckpoint: async () => checkpointRelationship(checkpoint, f.time),
    },
    clock: { now: () => new Date(f.time) },
  });
  const port = createRuntimeInspectionStopSettlementPort({ boundary, occurrences: helpers.occurrences });
  const action = await port.settleStop({ checkpoint });
  assert.equal(action.state, 'complete');
  const settlement = f.entries.find(({ record }) => record.kind === 'inspection-occurrence-settled');
  const cycleClose = f.entries.find(({ record }) => record.kind === 'business-cycle-closed');
  if (!settlement || !cycleClose) throw new Error('the stop fixture has no settlement and cycle close');
  assert.deepEqual(action, { state: 'complete', settlementCommitRefs: [settlement.commitRef],
    cycleClosedCommitRef: cycleClose.commitRef });
  const writes = f.entries.length;
  const item = f.entries.find(({ record }) => record.kind === 'inspection-item-result');
  if (!item || item.record.kind !== 'inspection-item-result') throw new Error('the stop fixture has no item result');
  const reverseObjectKeys = <T extends object>(value: T): T => Object.fromEntries(
    Object.entries(value).reverse()) as T;
  const reordered = {
    ...item,
    record: {
      ...item.record,
      binding: reverseObjectKeys(item.record.binding),
      delivery: reverseObjectKeys(item.record.delivery),
    },
  };
  const itemIndex = f.entries.indexOf(item);
  f.entries[itemIndex] = reordered;

  assert.deepEqual(await port.readStopCompletion({ checkpoint }), action);
  assert.equal(f.entries.length, writes);

  f.entries[itemIndex] = {
    ...reordered,
    record: { ...reordered.record, binding: { ...reordered.record.binding, executionEpoch: 2 } },
  };
  await assert.rejects(() => port.readStopCompletion({ checkpoint }),
    /inspection item result does not match its accepted delivery/);
  f.entries[itemIndex] = {
    ...reordered,
    record: {
      ...reordered.record,
      delivery: {
        ...reordered.record.delivery,
        outcome: { status: 'completed', judgment: 'changed judgment' },
      },
    },
  };
  await assert.rejects(() => port.readStopCompletion({ checkpoint }),
    /inspection item result does not match its accepted delivery/);
  assert.equal(f.entries.length, writes);
});
