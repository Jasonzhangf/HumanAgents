import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AcceptedTurnEntry,
  type ActiveTurnBinding,
  type ActiveTurnProviderRequestIdentityRef,
  type AdmittedTurn,
  type EvidenceRef,
  type ProviderRawFact,
  type ProviderToolResult,
  type RawAsset,
  type RawAssetView,
  type RawContentReadPort,
  type RuntimeRequestRecord,
  type ScopeRef,
  type WorkAssignment,
} from '../../../packages/contracts/src/index.js';
import {
  readSemanticTurnContext,
  readResumedSegmentSemanticTurnContext,
  type ResolvedSemanticTurnContext,
  type SemanticCurrentTurnUnit,
  type SemanticReasoningLineageFilterV1,
  SemanticTurnContextReaderError,
} from '../../../packages/runtime/src/context/semantic-turn-context-reader.js';
import type { DeadEndRecord } from '../../../packages/runtime/src/checkpoints/closure.js';
import {
  originalBusinessTurnRefFromBinding,
  type ActiveTurnInitialOpenAnchor,
  type ResumedTurnSegmentOpened,
} from '../../../packages/contracts/src/active-turn-segments.js';
import type { JournalCommitRef } from '../../../packages/contracts/src/i2-history.js';
import type { TaskRuntimeIncarnation } from '../../../packages/contracts/src/framework.js';
import type {
  CommittedSemanticCheckpoint,
  SemanticHistoryExactLookupV1,
} from '../../../packages/runtime/src/context/semantic-history.js';
import type {
  ActiveTurnLivePrefix,
  ActiveTurnProductionObligationRef,
  ActiveTurnSegmentLivePrefix,
} from '../../../packages/runtime/src/context/active-turn-live-prefix.js';

/**
 * Real public consumer for `readSemanticTurnContext`. It drives the v1 reader
 * through a committed live prefix and asserts that an accepted tool-result's
 * evidence refs survive onto the current-turn unit while the raw output bytes
 * stay exact. The fixture is self-contained; it shares no harness with the
 * lower-level materializer tests.
 */

const organId = id('organ', 'organ-refs');
const taskId = id('task', 'task-refs');
const cycleId = id('cycle', 'cycle-refs');
const operationId = id('operation', 'operation-refs');
const scope: ScopeRef = { organId, taskId, cycleId, operationId };
const execution = { runtimeId: 'runtime-refs', executionEpoch: 2 };
const providerTurnId = 'provider-turn-refs';
const request: ActiveTurnProviderRequestIdentityRef = { turnId: providerTurnId, requestId: 'request-refs-1' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const RAW_OUTPUT_WITH_REFS = '{"kind":"file-search","hits":2}';
const RAW_OUTPUT_WITHOUT_REFS = '{"kind":"file-list","entries":0}';

// Two real accepted refs on the tool result the model must be able to cite.
const resultRefs: readonly EvidenceRef[] = [
  {
    evidenceId: id('evidence', 'file-search-evidence-a'),
    kind: 'tool',
    source: 'native-file-search',
    locator: 'file.search://a',
    digest: `sha256:${'a'.repeat(64)}`,
    scope,
  },
  {
    evidenceId: id('evidence', 'file-search-evidence-b'),
    kind: 'tool',
    source: 'native-file-search',
    locator: 'file.search://b',
    scope,
  },
];

const assignment: WorkAssignment = {
  assignmentId: 'assignment-refs',
  taskId,
  pipelineNodeId: 'node-refs',
  attempt: 1,
  executionEpoch: execution.executionEpoch,
  inputRevision: 1,
  objective: 'delivery refs reader fixture',
  targetRefs: [],
  expectedOutputRefs: ['operation://refs/output'],
  successCriteria: ['the reader keeps accepted tool-result evidence refs'],
  failureCriteria: [],
  incompleteCriteria: [],
  requiredCapabilities: [],
  mergeGate: 'not-required',
};

type ToolResultUnit = Extract<SemanticCurrentTurnUnit, { kind: 'tool-result' }>;

// The reader unit is read structurally so this test still compiles before the
// `evidenceRefs` field lands; before then the assertion fails on a real missing
// runtime value instead of a missing-type compile error.
type MaybeReaderRefs = { readonly evidenceRefs?: readonly EvidenceRef[] };

function refsOf(unit: ToolResultUnit): readonly EvidenceRef[] | undefined {
  return (unit as MaybeReaderRefs).evidenceRefs;
}

function rawOutputRefOf(unit: ToolResultUnit): EvidenceRef {
  return unit.rawOutputRef;
}

function toolResultUnit(result: ResolvedSemanticTurnContext, callId: string): ToolResultUnit {
  const units = result.context.activeTurn.flatMap((entry) => (
    entry.kind === 'message' && entry.message.kind === 'tool-result' ? [entry.message] : []
  ));
  const unit = units.find((candidate) => candidate.callId === callId);
  assert.ok(unit, `expected a tool-result unit for ${callId}`);
  return unit;
}

function asset(assetId: string, view: RawAssetView = { kind: 'utf8-text' }): RawAsset {
  return {
    ref: {
      evidenceId: id('evidence', assetId),
      kind: 'tool',
      source: 'reader-refs-fixture',
      locator: `test://${assetId}`,
      scope,
    },
    view,
  };
}

function activeBinding(): ActiveTurnBinding {
  const admittedTurn: AdmittedTurn = {
    turnId: 'business-turn-refs',
    workAssignmentRef: assignment.assignmentId,
    taskRef: taskId,
    scopeRef: scope,
    cycleRef: cycleId,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: execution.executionEpoch,
    runtimeBindingRef: 'runtime-binding-refs',
    permissionRevision: 'permission-refs',
    admissionEvidenceRefs: ['evidence-admission-refs'],
    currentTurnRef: 'active-turn://refs/binding',
    recoveryStateRef: 'evidence-recovery-refs',
  };
  return { admittedTurn, assignment, execution, scope };
}

function toolResult(callId: string, toolId: string, evidenceRefs: readonly EvidenceRef[]): ProviderToolResult {
  return {
    runtimeId: execution.runtimeId,
    taskId,
    operationId,
    executionEpoch: execution.executionEpoch,
    toolId,
    callId,
    status: 'succeeded',
    outputRefs: [`operation://refs/${callId}`],
    evidenceRefs,
  };
}

interface Fixture {
  readonly prefix: Parameters<typeof readSemanticTurnContext>[0]['live']['prefix'];
  readonly read: RawContentReadPort;
}

function buildFixture(): Fixture {
  const registry = new Map<string, Uint8Array>();
  const register = (assetId: string, text: string): void => {
    registry.set(assetId, encoder.encode(text));
  };
  const read: RawContentReadPort = {
    async read({ content }) {
      const bytes = registry.get(content.ref.evidenceId.value);
      if (!bytes) throw new Error(`missing raw asset ${content.ref.evidenceId.value}`);
      return new Uint8Array(bytes);
    },
  };

  register('refs-initial-input', 'ORIGINAL USER INPUT');
  register('refs-args-1', '{"query":"a"}');
  register('refs-output-1', RAW_OUTPUT_WITH_REFS);
  register('refs-args-2', '{"query":"b"}');
  register('refs-output-2', RAW_OUTPUT_WITHOUT_REFS);

  const entries: AcceptedTurnEntry[] = [];
  const pushFact = (seq: number, producerSeq: number, fact: ProviderRawFact): void => {
    entries.push({ seq, envelope: { execution, scope, request, producerSeq, fact } });
  };

  pushFact(1, 1, {
    kind: 'tool-call',
    contentUnitId: 'args-1',
    call: { callId: 'call-1', toolId: 'file.search', arguments: { query: 'a' }, continuationRef: 'cont-1' },
    rawArguments: asset('refs-args-1', { kind: 'arguments' }),
    complete: true,
  });
  pushFact(2, 2, {
    kind: 'tool-result',
    contentUnitId: 'result-1',
    callId: 'call-1',
    continuationRef: 'cont-1',
    result: toolResult('call-1', 'file.search', resultRefs),
    rawOutput: asset('refs-output-1'),
    complete: true,
  });
  pushFact(3, 3, {
    kind: 'tool-call',
    contentUnitId: 'args-2',
    call: { callId: 'call-2', toolId: 'file.list', arguments: { query: 'b' }, continuationRef: 'cont-2' },
    rawArguments: asset('refs-args-2', { kind: 'arguments' }),
    complete: true,
  });
  pushFact(4, 4, {
    kind: 'tool-result',
    contentUnitId: 'result-2',
    callId: 'call-2',
    continuationRef: 'cont-2',
    result: toolResult('call-2', 'file.list', []),
    rawOutput: asset('refs-output-2'),
    complete: true,
  });

  const requests: RuntimeRequestRecord[] = [{ request, scope, phase: 'settled' }];
  const prefix: Fixture['prefix'] = {
    kind: 'live-accepted-prefix',
    source: 'active-turn://refs/live',
    binding: activeBinding(),
    initialInput: asset('refs-initial-input'),
    entries,
    requests,
    childInvocations: [],
    watermark: { lastAcceptedSeq: 4, controlRecordCount: 0 },
    obligations: [],
  };
  return { prefix, read };
}

async function readFixture(fixture: Fixture): Promise<ResolvedSemanticTurnContext> {
  return readSemanticTurnContext({
    history: {
      async readCommittedSemanticCheckpoint() {
        throw new Error('the reader must not read history without an exact lookup');
      },
    },
    priorCompletedTurns: [],
    live: { prefix: fixture.prefix, rawContent: fixture.read },
    runtimeId: execution.runtimeId,
    scope,
    assignment,
  });
}

const historyCycleId = id('cycle', 'cycle-history');
const historyOperationId = id('operation', 'operation-history');
const historyScope: ScopeRef = {
  organId,
  taskId,
  cycleId: historyCycleId,
  operationId: historyOperationId,
};
const historyPublicationReceiptRef =
  `humanagent://journal-record/v1/${'1'.repeat(64)}/51/${'2'.repeat(64)}`;

function historyLookup(scopeValue: ScopeRef): SemanticHistoryExactLookupV1 {
  return {
    scope: scopeValue,
    checkpoint: {
      id: id('checkpoint', 'history-checkpoint'),
      scope: scopeValue,
    },
    publicationReceiptRef: historyPublicationReceiptRef,
  };
}

function committedHistory(
  checkpointScope: ScopeRef,
  evidenceScope: ScopeRef,
): CommittedSemanticCheckpoint {
  return {
    version: 1,
    turn: {
      turnId: 'prior-business-turn',
      workAssignmentRef: 'prior-assignment',
      taskRef: checkpointScope.taskId!,
      scopeRef: checkpointScope,
      cycleRef: checkpointScope.cycleId!,
      inputRevision: 1,
      directiveRevision: 1,
      executionEpoch: 1,
      runtimeBindingRef: 'prior-runtime-binding',
      permissionRevision: '1',
    },
    scope: checkpointScope,
    time: '2026-10-14T00:00:00.000Z',
    description: 'prior completed turn',
    semantics: {
      goal: 'retain the prior turn',
      actions: 'committed the prior result',
      result: 'the prior result is available',
      nextStep: 'continue from the current turn',
    },
    save: {
      checkpoint: {
        checkpoint: {
          id: id('checkpoint', 'history-checkpoint'),
          scope: checkpointScope,
        },
      },
    },
    evidenceRefs: [{
      evidenceId: id('evidence', 'history-evidence'),
      kind: 'tool',
      source: 'semantic-history-public-consumer',
      locator: 'test://semantic-history/evidence',
      scope: evidenceScope,
    }],
    adoptedChildren: [],
  } as unknown as CommittedSemanticCheckpoint;
}

async function readFixtureWithHistory(
  fixture: Fixture,
  committed: CommittedSemanticCheckpoint,
  lookup: SemanticHistoryExactLookupV1,
): Promise<ResolvedSemanticTurnContext> {
  return readSemanticTurnContext({
    history: {
      async readCommittedSemanticCheckpoint(requested) {
        assert.deepEqual(requested, lookup);
        return committed;
      },
    },
    priorCompletedTurns: [lookup],
    live: { prefix: fixture.prefix, rawContent: fixture.read },
    runtimeId: execution.runtimeId,
    scope,
    assignment,
  });
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the semantic context read to reject');
}

test('semantic history scope: prior execution keeps its original scope and evidence while cross-task or organ history stays refused', async () => {
  const fixture = buildFixture();
  const visible = await readFixtureWithHistory(
    fixture,
    committedHistory(historyScope, historyScope),
    historyLookup(historyScope),
  );
  assert.equal(visible.context.semanticHistory.length, 1);
  assert.equal(visible.context.semanticHistory[0]!.checkpointId.value, 'history-checkpoint');
  assert.equal(visible.context.semanticHistory[0]!.evidenceRefs[0]!.scope.operationId?.value,
    historyOperationId.value);

  const otherTaskScope: ScopeRef = {
    ...historyScope,
    taskId: id('task', 'task-other'),
  };
  const taskMessage = await rejectionMessage(readFixtureWithHistory(
    fixture,
    committedHistory(otherTaskScope, otherTaskScope),
    historyLookup(otherTaskScope),
  ));
  if (!/semantic checkpoint task scope does not match/.test(taskMessage)) {
    throw new Error(`unexpected cross-task history result: ${taskMessage}`);
  }

  const otherOrganScope: ScopeRef = {
    ...historyScope,
    organId: id('organ', 'organ-other'),
  };
  const organMessage = await rejectionMessage(readFixtureWithHistory(
    fixture,
    committedHistory(otherOrganScope, otherOrganScope),
    historyLookup(otherOrganScope),
  ));
  if (!/semantic checkpoint organ scope does not match/.test(organMessage)) {
    throw new Error(`unexpected cross-organ history result: ${organMessage}`);
  }

  const otherOperationEvidenceScope: ScopeRef = {
    ...historyScope,
    operationId: id('operation', 'operation-history-evidence-other'),
  };
  const evidenceMessage = await rejectionMessage(readFixtureWithHistory(
    fixture,
    committedHistory(historyScope, otherOperationEvidenceScope),
    historyLookup(historyScope),
  ));
  if (!/checkpoint evidence operation scope does not match/.test(evidenceMessage)) {
    throw new Error(`unexpected checkpoint evidence result: ${evidenceMessage}`);
  }
});

test('delivery refs: reader keeps accepted tool-result evidence refs and exact raw bytes', async () => {
  const fixture = buildFixture();
  const first = await readFixture(fixture);

  const withRefs = toolResultUnit(first, 'call-1');
  assert.deepEqual(refsOf(withRefs), resultRefs);
  assert.deepEqual(withRefs.rawOutput, encoder.encode(RAW_OUTPUT_WITH_REFS));
  assert.equal(decoder.decode(withRefs.rawOutput), RAW_OUTPUT_WITH_REFS);

  // A result with no accepted refs must stay empty, never fabricated.
  const withoutRefs = toolResultUnit(first, 'call-2');
  assert.deepEqual(refsOf(withoutRefs), []);
  assert.equal(decoder.decode(withoutRefs.rawOutput), RAW_OUTPUT_WITHOUT_REFS);

  // The parent-scoped raw-output citation is projected separately and never
  // replaces the accepted child effect refs or the raw bytes.
  assert.equal(rawOutputRefOf(withRefs).locator, 'test://refs-output-1');
  assert.equal(rawOutputRefOf(withRefs).evidenceId.value, 'refs-output-1');
  assert.equal(rawOutputRefOf(withRefs).scope.operationId?.value, operationId.value);
  assert.equal(rawOutputRefOf(withoutRefs).evidenceId.value, 'refs-output-2');
  assert.equal(rawOutputRefOf(withoutRefs).locator, 'test://refs-output-2');

  // The reader copies accepted refs: mutating a returned unit cannot change the
  // accepted fact or a later read of the same prefix.
  const mutable = refsOf(withRefs)!;
  (mutable[0]!.scope as { taskId?: { value: string } }).taskId!.value = 'tampered-task';
  const second = await readFixture(fixture);
  assert.deepEqual(refsOf(toolResultUnit(second, 'call-1')), resultRefs);
  assert.equal(resultRefs[0]!.scope.taskId?.value, taskId.value);
});

const openTurnId = 'business-turn-refs';
const openRuntimeId = execution.runtimeId;

function initialOpenBinding(): ActiveTurnBinding {
  const base = activeBinding();
  return {
    execution: { runtimeId: openRuntimeId, executionEpoch: 1 },
    scope,
    admittedTurn: { ...base.admittedTurn, executionEpoch: 1 },
    assignment: { ...assignment, executionEpoch: 1 },
  };
}

function initialOpenSegment(
  binding: ActiveTurnBinding,
  anchor: ActiveTurnInitialOpenAnchor,
  businessTurnRef: ReturnType<typeof originalBusinessTurnRefFromBinding>,
): ResumedTurnSegmentOpened {
  const segmentExecution = { runtimeId: openRuntimeId, executionEpoch: 2 };
  const incarnation: TaskRuntimeIncarnation = {
    runtimeId: segmentExecution.runtimeId,
    generation: segmentExecution.executionEpoch,
    agentInstanceId: 'segment-agent-refs',
    roleId: 'role-executor',
    taskId,
    assignmentId: assignment.assignmentId,
    executionEpoch: segmentExecution.executionEpoch,
  };
  assert.equal(binding.execution.executionEpoch, 1);
  return {
    kind: 'segment-opened',
    segmentId: 'segment-refs-1',
    businessTurnRef,
    predecessor: { segmentId: openTurnId, initialOpen: anchor },
    binding: {
      businessTurnRef,
      assignment: { ...assignment, executionEpoch: segmentExecution.executionEpoch },
      execution: segmentExecution,
      incarnation,
      scope,
    },
    authorityCommitRef: { commitId: 'grant-refs', journalSeq: 21, recordDigest: `sha256:${'1'.repeat(64)}` },
    businessRegistrationCommitRef: { commitId: 'registration-refs', journalSeq: 22, recordDigest: `sha256:${'2'.repeat(64)}` },
    requestRef: `segment-open:${openTurnId}:segment-refs-1`,
    inputIdentity: { requestRef: `segment-open:${openTurnId}:segment-refs-1`, digest: `sha256:${'3'.repeat(64)}` },
  };
}

test('initial-open segment chain: original input once and pending obligations preserved', async () => {
  const registry = new Map<string, Uint8Array>();
  registry.set('refs-initial-input', encoder.encode('ORIGINAL USER INPUT'));
  const read: RawContentReadPort = {
    async read({ content }) {
      const bytes = registry.get(content.ref.evidenceId.value);
      if (!bytes) throw new Error(`missing raw asset ${content.ref.evidenceId.value}`);
      return new Uint8Array(bytes);
    },
  };

  const anchor: ActiveTurnInitialOpenAnchor = {
    bindingCommitRef: { commitId: `active-turn:${openTurnId}:binding-opened`, journalSeq: 6, recordDigest: `sha256:${'a'.repeat(64)}` },
    recordsThroughCommitRef: { commitId: `active-turn:${openTurnId}:request:request-refs-1:waiting`, journalSeq: 12, recordDigest: `sha256:${'b'.repeat(64)}` },
  };
  const initialInput = asset('refs-initial-input');
  const binding = initialOpenBinding();
  const businessTurnRef = originalBusinessTurnRefFromBinding(anchor.bindingCommitRef, binding);
  const segment = initialOpenSegment(binding, anchor, businessTurnRef);

  const initialPrefix: ActiveTurnLivePrefix = {
    kind: 'live-accepted-prefix',
    source: openTurnId,
    binding,
    initialInput,
    entries: [],
    requests: [{ request, scope, phase: 'waiting' }],
    childInvocations: [],
    watermark: { lastAcceptedSeq: 0, controlRecordCount: 2 },
    obligations: [],
  };
  const livePrefix: ActiveTurnSegmentLivePrefix = {
    kind: 'segment-live-accepted-prefix',
    segment,
    binding: segment.binding,
    initialInput,
    entries: [],
    requests: [],
    childInvocations: [],
    watermark: { lastAcceptedSeq: 0, controlRecordCount: 1 },
    obligations: [],
  };

  const result = await readResumedSegmentSemanticTurnContext({
    history: {
      async readCommittedSemanticCheckpoint() {
        throw new Error('the reader must not read history without an exact lookup');
      },
    },
    priorCompletedTurns: [],
    segment: {
      chain: { businessTurnRef, initial: { kind: 'initial-open', anchor, binding, initialInput }, segments: [segment] },
      exactReads: {
        async readInitialOpenExact({ businessTurnId: requested, anchor: requestedAnchor }) {
          assert.equal(requested, openTurnId);
          assert.deepEqual(requestedAnchor, anchor);
          return { anchor, prefix: initialPrefix };
        },
        async readSegmentCaptureExact() {
          throw new Error('a single-segment chain has no earlier exact capture');
        },
        async readSegmentInterruptedExact() {
          throw new Error('a single-segment chain has no earlier interrupted segment');
        },
      },
      live: { prefix: livePrefix, rawContent: read },
    },
    runtimeId: execution.runtimeId,
    scope,
    assignment,
  });

  const initialUnits = result.context.activeTurn.filter((entry) => (
    entry.kind === 'message' && entry.message.kind === 'initial-input'
  ));
  assert.equal(initialUnits.length, 1, 'the original input is emitted exactly once');
  const only = initialUnits[0]!;
  if (only.kind === 'message' && only.message.kind === 'initial-input') {
    assert.equal(decoder.decode(only.message.bytes), 'ORIGINAL USER INPUT');
  }
  // The opened-but-unsaved original turn keeps its pending request as an
  // obligation tagged with its own business turn identity.
  assert.deepEqual(result.obligations, [
    { kind: 'request', requestId: request.requestId, phase: 'waiting', segmentId: openTurnId },
  ]);
});

// ---------------------------------------------------------------------------
// N2-S active-reasoning filter. Failure mode: after a confirmed context
// correction, a settled wrong tool pair must leave the request context while the
// original input, the good pair and the verified conclusion stay. An open duty
// must never be hidden. Failure probability is unknown; impact is a wrong result
// polluting the model request or a dropped recovery duty. Cost is this one
// existing consumer extension. Recorded in the accepted plan §4.2 and the r4 note.

const RAW_BAD = '{"kind":"file-search","hits":0}';
const RAW_GOOD = '{"kind":"file-list","entries":2}';

function lineageFixture(obligations: readonly ActiveTurnProductionObligationRef[]): Fixture {
  const registry = new Map<string, Uint8Array>();
  const register = (assetId: string, text: string): void => {
    registry.set(assetId, encoder.encode(text));
  };
  const read: RawContentReadPort = {
    async read({ content }) {
      const bytes = registry.get(content.ref.evidenceId.value);
      if (!bytes) throw new Error(`missing raw asset ${content.ref.evidenceId.value}`);
      return new Uint8Array(bytes);
    },
  };

  register('lineage-initial', 'ORIGINAL USER INPUT');
  register('lineage-args-bad', '{"query":"bad"}');
  register('lineage-output-bad', RAW_BAD);
  register('lineage-args-good', '{"query":"good"}');
  register('lineage-output-good', RAW_GOOD);

  const entries: AcceptedTurnEntry[] = [];
  const pushFact = (seq: number, producerSeq: number, fact: ProviderRawFact): void => {
    entries.push({ seq, envelope: { execution, scope, request, producerSeq, fact } });
  };
  pushFact(1, 1, {
    kind: 'tool-call',
    contentUnitId: 'args-bad',
    call: { callId: 'call-bad', toolId: 'file.search', arguments: { query: 'bad' }, continuationRef: 'cont-bad' },
    rawArguments: asset('lineage-args-bad', { kind: 'arguments' }),
    complete: true,
  });
  pushFact(2, 2, {
    kind: 'tool-result',
    contentUnitId: 'result-bad',
    callId: 'call-bad',
    continuationRef: 'cont-bad',
    result: toolResult('call-bad', 'file.search', [{
      evidenceId: id('evidence', 'lineage-evidence-bad'),
      kind: 'tool',
      source: 'lineage-fixture',
      locator: 'test://lineage-evidence-bad',
      scope,
    }]),
    rawOutput: asset('lineage-output-bad'),
    complete: true,
  });
  pushFact(3, 3, {
    kind: 'tool-call',
    contentUnitId: 'args-good',
    call: { callId: 'call-good', toolId: 'file.list', arguments: { query: 'good' }, continuationRef: 'cont-good' },
    rawArguments: asset('lineage-args-good', { kind: 'arguments' }),
    complete: true,
  });
  pushFact(4, 4, {
    kind: 'tool-result',
    contentUnitId: 'result-good',
    callId: 'call-good',
    continuationRef: 'cont-good',
    result: toolResult('call-good', 'file.list', []),
    rawOutput: asset('lineage-output-good'),
    complete: true,
  });

  const prefix: Fixture['prefix'] = {
    kind: 'live-accepted-prefix',
    source: 'active-turn://refs/lineage',
    binding: activeBinding(),
    initialInput: asset('lineage-initial'),
    entries,
    requests: [{ request, scope, phase: 'settled' }],
    childInvocations: [],
    watermark: { lastAcceptedSeq: 4, controlRecordCount: 0 },
    obligations: [...obligations],
  };
  return { prefix, read };
}

async function readLineageFixture(
  fixture: Fixture,
  reasoningLineage: SemanticReasoningLineageFilterV1,
): Promise<ResolvedSemanticTurnContext> {
  return readSemanticTurnContext({
    history: {
      async readCommittedSemanticCheckpoint() {
        throw new Error('the reader must not read history without an exact lookup');
      },
    },
    priorCompletedTurns: [],
    live: { prefix: fixture.prefix, rawContent: fixture.read },
    runtimeId: execution.runtimeId,
    scope,
    assignment,
    reasoningLineage,
  });
}

const retainedDeadEnd: DeadEndRecord = {
  deadEndRef: 'dead-end://lineage/bad-search',
  scope,
  failedPathRefs: ['cont-bad'],
  conclusion: 'the bad search path returned no usable hits',
  invalidatedAssumptions: ['file.search covers the target directory'],
  evidenceRefs: [{
    evidenceId: id('evidence', 'lineage-dead-end'),
    kind: 'tool',
    source: 'lineage-fixture',
    locator: 'test://lineage-dead-end',
    scope,
  }],
  suggestedAlternatives: ['use file.list first'],
};

function currentUnits(result: ResolvedSemanticTurnContext): readonly SemanticCurrentTurnUnit[] {
  return result.context.activeTurn.flatMap((entry) => (entry.kind === 'message' ? [entry.message] : []));
}

async function lineageFailureCode(
  fixture: Fixture,
  reasoningLineage: SemanticReasoningLineageFilterV1,
): Promise<string | null> {
  try {
    await readLineageFixture(fixture, reasoningLineage);
    return null;
  } catch (error) {
    return error instanceof SemanticTurnContextReaderError ? error.code : null;
  }
}

test('active reasoning lineage: settled wrong tool pair leaves the request while good pair, input and verified conclusion stay', async () => {
  const fixture = lineageFixture([]);
  // Control: without the lineage filter the same committed prefix still carries
  // the wrong pair. The omission below is therefore caused by the filter, not by
  // a fixture that never produced the unit.
  const unfiltered = await readFixture(fixture);
  assert.equal(currentUnits(unfiltered).some((unit) => unit.kind === 'tool-result' && unit.callId === 'call-bad'), true);

  const result = await readLineageFixture(fixture, {
    omittedRefs: ['lineage-output-bad'],
    verifiedDeadEnds: [retainedDeadEnd],
  });
  const units = currentUnits(result);

  // The confirmed wrong result and its same-call tool call both leave.
  assert.equal(units.some((unit) => unit.kind === 'tool-call' && unit.callId === 'call-bad'), false);
  assert.equal(units.some((unit) => unit.kind === 'tool-result' && unit.callId === 'call-bad'), false);

  // The good pair stays with its exact raw bytes.
  assert.equal(units.some((unit) => unit.kind === 'tool-call' && unit.callId === 'call-good'), true);
  assert.equal(decoder.decode(toolResultUnit(result, 'call-good').rawOutput), RAW_GOOD);

  // The original user input is never dropped by a reasoning filter.
  const initialBytes = units.flatMap((unit) => (unit.kind === 'initial-input' ? [unit.bytes] : []));
  assert.equal(initialBytes.length, 1);
  assert.equal(decoder.decode(initialBytes[0]!), 'ORIGINAL USER INPUT');

  // The verified conclusion stays, with its certainty and evidence.
  assert.deepEqual(result.verifiedDeadEnds, [retainedDeadEnd]);

  // An explicitly omitted dead-end ref is not replayed.
  const omittedDeadEnd = await readLineageFixture(fixture, {
    omittedRefs: ['lineage-output-bad', retainedDeadEnd.deadEndRef],
    verifiedDeadEnds: [retainedDeadEnd],
  });
  assert.equal(omittedDeadEnd.verifiedDeadEnds, undefined);

  // A conclusion whose supporting evidence is fully omitted is not replayed with
  // an empty evidence list; its certainty cannot be preserved.
  const evidenceOmitted: DeadEndRecord = {
    ...retainedDeadEnd,
    deadEndRef: 'dead-end://lineage/evidence-omitted',
    evidenceRefs: [{ ...retainedDeadEnd.evidenceRefs[0]!, evidenceId: id('evidence', 'lineage-output-bad') }],
  };
  const evidenceOmittedResult = await readLineageFixture(fixture, {
    omittedRefs: ['lineage-output-bad'],
    verifiedDeadEnds: [evidenceOmitted],
  });
  assert.equal(evidenceOmittedResult.verifiedDeadEnds, undefined);
});

test('active reasoning lineage: an open obligation matching a wrong ref is reported instead of hidden', async () => {
  const identityOpen = lineageFixture([{ kind: 'request', requestId: 'lineage-output-bad', phase: 'waiting' }]);
  assert.equal(await lineageFailureCode(identityOpen, { omittedRefs: ['lineage-output-bad'] }),
    'semantic-turn-context.reasoning-lineage.unresolved-obligation');

  const toolOpen = lineageFixture([{ kind: 'request', requestId: request.requestId, phase: 'waiting' }]);
  assert.equal(await lineageFailureCode(toolOpen, { omittedRefs: ['lineage-output-bad'] }),
    'semantic-turn-context.reasoning-lineage.unresolved-obligation');
});
