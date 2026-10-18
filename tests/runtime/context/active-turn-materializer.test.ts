import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AcceptedTurnEntry,
  type ActiveTurnBinding,
  type ActiveTurnCaptureBody,
  type ActiveTurnProviderRequestIdentityRef,
  type AdmittedTurn,
  type ChildInvocationRecord,
  type EvidenceRef,
  type ProviderRawFact,
  type ProviderToolResult,
  type RawAsset,
  type RawAssetView,
  type RawContentReadPort,
  type RuntimeRequestRecord,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../../packages/contracts/src/index.js';
import { RuntimeActiveTurnError } from '../../../packages/runtime/src/context/active-turn-context.js';
import {
  materializeActiveTurn,
  type ResolvedActiveTurnEntry,
  type ResolvedAdoptedChildDelivery,
} from '../../../packages/runtime/src/context/index.js';

/**
 * D-AR focused materializer acceptance. These tests drive the materializer
 * through a controlled read port so folding, pairing, adoption and failure
 * behavior stay deterministic. The real immutable-asset + Provider reader
 * consumer lives in tests/app/active-turn-materializer-public-consumer.test.ts,
 * because the context test tsconfig does not declare the node builtins that the
 * filesystem/provider packages import.
 */

const organId = id('organ', 'organ-dar');
const taskId = id('task', 'task-dar');
const cycleId = id('cycle', 'cycle-dar');
const operationId = id('operation', 'operation-dar');
const scope: ScopeRef = { organId, taskId, cycleId, operationId };
const childScope: ScopeRef = { organId, taskId, cycleId, operationId: id('operation', 'operation-dar-child') };
const execution = { runtimeId: 'runtime-dar', executionEpoch: 3 };
const providerTurnId = 'provider-turn-dar';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const request1: ActiveTurnProviderRequestIdentityRef = { turnId: providerTurnId, requestId: 'request-dar-1' };
const request2: ActiveTurnProviderRequestIdentityRef = {
  turnId: providerTurnId,
  requestId: 'request-dar-2',
  parentRequestId: 'request-dar-1',
};

function workAssignment(assignmentId: string): WorkAssignment {
  return {
    assignmentId,
    taskId,
    pipelineNodeId: 'node-dar',
    attempt: 1,
    executionEpoch: execution.executionEpoch,
    inputRevision: 1,
    objective: 'D-AR fixture',
    targetRefs: [],
    expectedOutputRefs: ['operation://dar/child-output'],
    successCriteria: ['resolve the captured turn exactly'],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  };
}

function workResult(assignment: WorkAssignment): WorkResult {
  return {
    taskId,
    pipelineNodeId: assignment.pipelineNodeId,
    agentId: 'agent-dar-child',
    assignmentId: assignment.assignmentId,
    attempt: assignment.attempt,
    executionEpoch: assignment.executionEpoch,
    inputRevision: assignment.inputRevision,
    producedArtifactRefs: [],
    status: 'succeeded',
    summary: 'refined child delivery',
    outputRefs: [...assignment.expectedOutputRefs],
    evidenceRefs: [],
    nextAction: 'settle',
  };
}

function activeBinding(): ActiveTurnBinding {
  const assignment = workAssignment('assignment-dar');
  const admittedTurn: AdmittedTurn = {
    turnId: 'business-turn-dar',
    workAssignmentRef: assignment.assignmentId,
    taskRef: taskId,
    scopeRef: scope,
    cycleRef: cycleId,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: execution.executionEpoch,
    runtimeBindingRef: 'runtime-binding-dar',
    permissionRevision: 'permission-dar',
    admissionEvidenceRefs: ['evidence-admission-dar'],
    currentTurnRef: 'active-turn://dar/binding',
    recoveryStateRef: 'evidence-recovery-dar',
  };
  return { admittedTurn, assignment, execution, scope };
}

function asset(assetId: string, assetScope: ScopeRef, view: RawAssetView = { kind: 'utf8-text' }): RawAsset {
  const ref: EvidenceRef = {
    evidenceId: id('evidence', assetId),
    kind: 'tool',
    source: 'dar-test',
    locator: `test://${assetId}`,
    scope: assetScope,
  };
  return { ref, view };
}

interface Fixture {
  readonly capture: ActiveTurnCaptureBody;
  readonly read: RawContentReadPort;
}

function buildFixture(): Fixture {
  const registry = new Map<string, { readonly scope: ScopeRef; readonly bytes: Uint8Array }>();
  const register = (assetId: string, assetScope: ScopeRef, text: string): void => {
    registry.set(assetId, { scope: assetScope, bytes: encoder.encode(text) });
  };
  const read: RawContentReadPort = {
    async read({ scope: readScope, content }) {
      const entry = registry.get(content.ref.evidenceId.value);
      if (!entry) throw new Error(`missing raw asset ${content.ref.evidenceId.value}`);
      assert.deepEqual(readScope, entry.scope, `raw asset ${content.ref.evidenceId.value} scope`);
      return new Uint8Array(entry.bytes);
    },
  };

  register('dar-initial-input', scope, 'ORIGINAL USER INPUT');
  register('dar-a1-delta-1', scope, 'Hello ');
  register('dar-old1', scope, 'OLD ');
  register('dar-a1-full', scope, 'Hello world!');
  register('dar-r1', scope, 'think');
  register('dar-s1', scope, 'summary');
  register('dar-c1', scope, 'snapshot');
  register('dar-args-1', scope, '{"path":"a"}');
  register('dar-output-1', scope, 'RAW_FAILED_OUTPUT\n{"token":"A"}');
  register('dar-a1-r2', scope, 'CONT');
  register('dar-args-2', scope, '{"path":"b"}');
  register('dar-output-2', scope, 'RAW_R2_OUTPUT');
  register('dar-child-adopted', childScope, 'CHILD REFINED ADOPTED');
  register('dar-child-unadopted', childScope, 'CHILD REFINED UNADOPTED');

  const entries: AcceptedTurnEntry[] = [];
  const pushFact = (
    seq: number,
    request: ActiveTurnProviderRequestIdentityRef,
    producerSeq: number,
    fact: ProviderRawFact,
  ): void => {
    entries.push({ seq, envelope: { execution, scope, request, producerSeq, fact } });
  };

  pushFact(1, request1, 1, { kind: 'content', contentUnitId: 'a1', channel: 'assistant-text', update: 'delta', content: asset('dar-a1-delta-1', scope), complete: false });
  pushFact(2, request1, 2, { kind: 'content', contentUnitId: 'old1', channel: 'assistant-text', update: 'delta', content: asset('dar-old1', scope), complete: false });
  pushFact(3, request1, 3, { kind: 'content', contentUnitId: 'a1', channel: 'assistant-text', update: 'full', content: asset('dar-a1-full', scope), complete: false, replacesUnitIds: ['old1'] });
  pushFact(4, request1, 4, { kind: 'content', contentUnitId: 'r1', channel: 'reasoning-text', update: 'delta', content: asset('dar-r1', scope), complete: false });
  pushFact(5, request1, 5, { kind: 'content', contentUnitId: 's1', channel: 'reasoning-summary', update: 'delta', content: asset('dar-s1', scope), complete: false });
  pushFact(6, request1, 6, { kind: 'content', contentUnitId: 'c1', channel: 'assistant-text', update: 'full', content: asset('dar-c1', scope), complete: false });
  pushFact(7, request1, 7, { kind: 'content-complete', contentUnitId: 'c1' });
  pushFact(8, request1, 8, {
    kind: 'tool-call',
    contentUnitId: 'args-1',
    call: { callId: 'call-x', toolId: 'file.read', arguments: { path: 'a' }, continuationRef: 'cont-1' },
    rawArguments: asset('dar-args-1', scope),
    complete: true,
  });
  const failedResult: ProviderToolResult = {
    runtimeId: execution.runtimeId,
    taskId,
    operationId,
    executionEpoch: execution.executionEpoch,
    toolId: 'file.read',
    callId: 'call-x',
    status: 'failed',
    outputRefs: [],
    evidenceRefs: [],
    error: {
      errorId: 'error-dar-1',
      code: 'dar.tool.failed',
      category: 'runtime',
      phase: 'tool',
      message: 'tool failed',
      ownerId: 'owner-dar',
      retryable: 'terminal',
      attention: 'foreground',
      evidenceRefs: [],
      nextAction: { kind: 'wait' },
    },
  };
  pushFact(9, request1, 9, {
    kind: 'tool-result',
    contentUnitId: 'result-1',
    callId: 'call-x',
    continuationRef: 'cont-1',
    result: failedResult,
    rawOutput: asset('dar-output-1', scope),
    complete: true,
  });
  pushFact(10, request1, 10, { kind: 'request-complete', terminal: 'completed' });

  pushFact(11, request2, 1, { kind: 'content', contentUnitId: 'a1', channel: 'assistant-text', update: 'delta', content: asset('dar-a1-r2', scope), complete: false });
  pushFact(12, request2, 2, {
    kind: 'tool-call',
    contentUnitId: 'args-2',
    call: { callId: 'call-x', toolId: 'file.read', arguments: { path: 'b' }, continuationRef: 'cont-2' },
    rawArguments: asset('dar-args-2', scope),
    complete: true,
  });
  pushFact(13, request2, 3, {
    kind: 'tool-result',
    contentUnitId: 'result-2',
    callId: 'call-x',
    continuationRef: 'cont-2',
    result: { ...failedResult, status: 'succeeded', error: undefined },
    rawOutput: asset('dar-output-2', scope),
    complete: true,
  });
  pushFact(14, request2, 4, { kind: 'request-complete', terminal: 'completed' });

  const adoptedAssignment = workAssignment('assignment-dar-adopted');
  const unadoptedAssignment = workAssignment('assignment-dar-unadopted');
  entries.push({
    kind: 'execution',
    seq: 15,
    invocationId: 'invocation-dar-adopted',
    refinedDelivery: asset('dar-child-adopted', childScope),
    assignment: adoptedAssignment,
    result: workResult(adoptedAssignment),
  });
  entries.push({
    kind: 'execution',
    seq: 16,
    invocationId: 'invocation-dar-unadopted',
    refinedDelivery: asset('dar-child-unadopted', childScope),
    assignment: unadoptedAssignment,
    result: workResult(unadoptedAssignment),
  });

  const requests: RuntimeRequestRecord[] = [
    { request: request1, scope, phase: 'settled' },
    { request: request2, parentRequestId: request1.requestId, scope, phase: 'settled' },
  ];
  const childInvocations: ChildInvocationRecord[] = [
    {
      invocationId: 'invocation-dar-adopted',
      childTurnId: 'child-turn-dar-adopted',
      checkpointReceiptRef: 'checkpoint://dar/pre-call-adopted',
      binding: { kind: 'execution', assignment: adoptedAssignment },
      adoptedResultSeq: 15,
    },
    {
      invocationId: 'invocation-dar-unadopted',
      childTurnId: 'child-turn-dar-unadopted',
      checkpointReceiptRef: 'checkpoint://dar/pre-call-unadopted',
      binding: { kind: 'execution', assignment: unadoptedAssignment },
    },
  ];

  const capture: ActiveTurnCaptureBody = {
    version: 1,
    binding: activeBinding(),
    initialInput: asset('dar-initial-input', scope),
    entries,
    requests,
    childInvocations,
    checkpointPath: ['checkpoint://dar/pre-call'],
    cut: { pauseId: 'pause-dar', lastSeq: 16, producersDrained: true, frozenAt: '2026-10-12T00:00:00.000Z' },
    completionRefs: [{ requestId: request1.requestId, producerSeq: 10 }],
  };
  return { capture, read };
}

function unitFor(
  result: Awaited<ReturnType<typeof materializeActiveTurn>>,
  request: ActiveTurnProviderRequestIdentityRef,
  channel: string,
  contentUnitId: string,
) {
  const unit = result.contentUnits.find((candidate) => (
    candidate.request.requestId === request.requestId
    && candidate.channel === channel
    && candidate.contentUnitId === contentUnitId
  ));
  assert.ok(unit, `expected content unit ${request.requestId}/${channel}/${contentUnitId}`);
  return unit;
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof RuntimeActiveTurnError, `expected RuntimeActiveTurnError, got ${String(error)}`);
  assert.equal(error.code, code);
}

test('D-AR M1: folds exact raw bytes, replaces on full, keeps channels/requests separate and pairs tool output', async () => {
  const fixture = buildFixture();
  const result = await materializeActiveTurn({ capture: fixture.capture, rawContent: fixture.read });

  assert.equal(result.version, 1);
  assert.equal(decoder.decode(result.initialInput.bytes), 'ORIGINAL USER INPUT');
  assert.equal(result.binding.admittedTurn.turnId, 'business-turn-dar');
  assert.notEqual(result.binding.admittedTurn.turnId, providerTurnId);
  assert.deepEqual(result.checkpointPath, ['checkpoint://dar/pre-call']);
  assert.deepEqual(result.completionRefs, [{ requestId: request1.requestId, producerSeq: 10 }]);

  // full replaces the snapshot instead of appending, and a replaced unit stays
  // visible but is marked superseded so canonical projection can drop it.
  const a1 = unitFor(result, request1, 'assistant-text', 'a1');
  assert.equal(decoder.decode(a1.bytes), 'Hello world!');
  assert.equal(a1.complete, false);
  assert.deepEqual(a1.sourceSeqs, [1, 3]);
  assert.equal(a1.supersededBy, undefined);
  const old1 = unitFor(result, request1, 'assistant-text', 'old1');
  assert.equal(decoder.decode(old1.bytes), 'OLD ');
  assert.deepEqual(old1.supersededBy, { contentUnitId: 'a1', seq: 3 });

  // content-complete adds no bytes and marks the existing unit complete.
  const c1 = unitFor(result, request1, 'assistant-text', 'c1');
  assert.equal(decoder.decode(c1.bytes), 'snapshot');
  assert.equal(c1.complete, true);

  // reasoning channels stay separate.
  assert.equal(decoder.decode(unitFor(result, request1, 'reasoning-text', 'r1').bytes), 'think');
  assert.equal(decoder.decode(unitFor(result, request1, 'reasoning-summary', 's1').bytes), 'summary');

  // continuation restarts producerSeq and must not mix units.
  const r2 = unitFor(result, request2, 'assistant-text', 'a1');
  assert.equal(decoder.decode(r2.bytes), 'CONT');
  assert.notEqual(decoder.decode(r2.bytes), decoder.decode(a1.bytes));

  // exact failed tool output is retained as raw bytes.
  const toolResult = result.entries.find(
    (entry): entry is Extract<ResolvedActiveTurnEntry, { kind: 'tool-result' }> => entry.kind === 'tool-result',
  );
  assert.ok(toolResult);
  assert.equal(decoder.decode(toolResult.rawOutput), 'RAW_FAILED_OUTPUT\n{"token":"A"}');
  const toolCall = result.entries.find(
    (entry): entry is Extract<ResolvedActiveTurnEntry, { kind: 'tool-call' }> => entry.kind === 'tool-call',
  );
  assert.ok(toolCall);
  assert.equal(decoder.decode(toolCall.rawArguments), '{"path":"a"}');

  // the request-complete fact survives without closing the business turn.
  assert.equal(result.entries.filter((entry) => entry.kind === 'request-complete').length, 2);
});

test('D-AR M2: includes only the adopted refinement and keeps instances independent', async () => {
  const fixture = buildFixture();
  const parent = await materializeActiveTurn({ capture: fixture.capture, rawContent: fixture.read });
  const parentSnapshot = structuredClone(parent);

  const adopted = parent.entries.filter(
    (entry): entry is ResolvedAdoptedChildDelivery => entry.kind === 'adopted-child-delivery',
  );
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0]!.invocation.invocationId, 'invocation-dar-adopted');
  assert.equal(decoder.decode(adopted[0]!.bytes), 'CHILD REFINED ADOPTED');
  assert.equal(
    parent.entries.some((entry) => entry.kind === 'adopted-child-delivery' && entry.invocation.invocationId === 'invocation-dar-unadopted'),
    false,
  );

  // A child instance with overlapping request and unit ids must not touch the
  // earlier parent result.
  const childCapture: ActiveTurnCaptureBody = {
    ...fixture.capture,
    binding: {
      ...fixture.capture.binding,
      execution: { runtimeId: 'runtime-dar-child', executionEpoch: 9 },
      assignment: { ...fixture.capture.binding.assignment, executionEpoch: 9 },
      admittedTurn: { ...fixture.capture.binding.admittedTurn, executionEpoch: 9 },
    },
    entries: [{
      seq: 1,
      envelope: {
        execution: { runtimeId: 'runtime-dar-child', executionEpoch: 9 },
        scope,
        request: request1,
        producerSeq: 1,
        fact: { kind: 'content', contentUnitId: 'a1', channel: 'assistant-text', update: 'delta', content: asset('dar-a1-delta-1', scope), complete: false },
      },
    }],
    requests: [{ request: request1, scope, phase: 'settled' }],
    childInvocations: [],
    cut: { pauseId: 'pause-dar-child', lastSeq: 1, producersDrained: true, frozenAt: '2026-10-12T00:00:00.000Z' },
    completionRefs: [],
  };
  const child = await materializeActiveTurn({ capture: childCapture, rawContent: fixture.read });
  assert.equal(decoder.decode(unitFor(child, request1, 'assistant-text', 'a1').bytes), 'Hello ');

  assert.deepEqual(parent, parentSnapshot);

  // Mutating one result must not leak into a fresh materialization.
  (parent.contentUnits[0]!.bytes as Uint8Array)[0] = 0;
  const rematerialized = await materializeActiveTurn({ capture: fixture.capture, rawContent: fixture.read });
  assert.equal(decoder.decode(unitFor(rematerialized, request1, 'assistant-text', 'a1').bytes), 'Hello world!');
});

test('D-AR M2: fails explicitly on broken reads, identities, pairing and adoption', async () => {
  const fixture = buildFixture();

  // A missing asset must reject, never substitute a descriptor or summary.
  const missingRead: RawContentReadPort = { async read() { throw new Error('raw asset is gone'); } };
  await assert.rejects(() => materializeActiveTurn({ capture: fixture.capture, rawContent: missingRead }));

  // A provider asset declared in another scope must reject through the reader.
  const wrongScopeRead: RawContentReadPort = {
    async read({ scope: readScope }) {
      assert.deepEqual(readScope, childScope, 'provider asset scope must match its declared scope');
      return encoder.encode('Hello ');
    },
  };
  await assert.rejects(() => materializeActiveTurn({ capture: fixture.capture, rawContent: wrongScopeRead }));

  // A raw fact from another execution runtime must reject.
  const wrongExecutionCapture: ActiveTurnCaptureBody = {
    ...fixture.capture,
    entries: fixture.capture.entries.map((entry) => (
      'envelope' in entry && entry.seq === 1
        ? { ...entry, envelope: { ...entry.envelope, execution: { ...entry.envelope.execution, runtimeId: 'runtime-other' } } }
        : entry
    )),
  };
  await expectCode(
    () => materializeActiveTurn({ capture: wrongExecutionCapture, rawContent: fixture.read }),
    'active-turn.materialize.execution-mismatch',
  );

  // A raw fact whose request is not registered must reject.
  const unknownRequestCapture: ActiveTurnCaptureBody = {
    ...fixture.capture,
    entries: fixture.capture.entries.map((entry) => (
      'envelope' in entry && entry.seq === 1
        ? { ...entry, envelope: { ...entry.envelope, request: { ...entry.envelope.request, requestId: 'request-unregistered' } } }
        : entry
    )),
  };
  await expectCode(
    () => materializeActiveTurn({ capture: unknownRequestCapture, rawContent: fixture.read }),
    'active-turn.materialize.request-unknown',
  );

  // A tool result whose continuation does not match any captured call must reject.
  const unpairedCapture: ActiveTurnCaptureBody = {
    ...fixture.capture,
    entries: fixture.capture.entries.map((entry) => (
      'envelope' in entry && entry.envelope.fact.kind === 'tool-result'
        ? { ...entry, envelope: { ...entry.envelope, fact: { ...entry.envelope.fact, continuationRef: 'cont-mismatch' } } }
        : entry
    )),
  };
  await expectCode(
    () => materializeActiveTurn({ capture: unpairedCapture, rawContent: fixture.read }),
    'active-turn.materialize.tool-result-unpaired',
  );

  // A superseded unit cannot silently become canonical again through a later delta.
  const restoredCapture: ActiveTurnCaptureBody = {
    ...fixture.capture,
    entries: [
      ...fixture.capture.entries,
      {
        seq: 17,
        envelope: {
          execution,
          scope,
          request: request1,
          producerSeq: 11,
          fact: { kind: 'content', contentUnitId: 'old1', channel: 'assistant-text', update: 'delta', content: asset('dar-old1', scope), complete: false },
        },
      },
    ],
    cut: { ...fixture.capture.cut, lastSeq: 17 },
  };
  await expectCode(
    () => materializeActiveTurn({ capture: restoredCapture, rawContent: fixture.read }),
    'active-turn.materialize.content-conflict',
  );

  // An invalid adoption reference is rejected by capture validation before any
  // partial materialization can be returned.
  const invalidAdoptionCapture: ActiveTurnCaptureBody = {
    ...fixture.capture,
    childInvocations: fixture.capture.childInvocations.map((invocation) => (
      invocation.invocationId === 'invocation-dar-unadopted'
        ? { ...invocation, adoptedResultSeq: 14 }
        : invocation
    )),
  };
  await assert.rejects(() => materializeActiveTurn({ capture: invalidAdoptionCapture, rawContent: fixture.read }));
});
