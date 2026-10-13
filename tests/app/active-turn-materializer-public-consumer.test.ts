import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type RawContentReadPort,
  type RuntimeRequestRecord,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../packages/contracts/src/index.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import {
  filesystemProviderEvidenceSink,
  type ProviderEvidenceSink,
} from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { RuntimeActiveTurnError } from '../../packages/runtime/src/context/active-turn-context.js';
import {
  materializeActiveTurn,
  type ResolvedActiveTurnEntry,
  type ResolvedAdoptedChildDelivery,
} from '../../packages/runtime/src/context/index.js';

/**
 * D-AR public consumer evidence. Unlike the focused in-memory test, this drives
 * `materializeActiveTurn` through the real persistence seam: raw content is
 * written to an `ImmutableAssetStore`, the supplied capture body is saved and
 * read back as an immutable asset, and every descriptor is resolved through the
 * production `providerRawContentReader`. This test lives under `tests/app`
 * because the context test scope only declares `node:assert/strict` and
 * `node:test`; the App scope declares the `node:crypto` / `node:fs/promises` /
 * `node:path` builtins the filesystem and provider packages import.
 *
 * The project requires every durable artifact to live under `~/.humanagent`.
 * `HUMANAGENT_TEST_ROOT` only exists so a sandboxed worker can still exercise
 * the same consumer locally; the formal default is the `~/.humanagent` root.
 */
const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-d-active-raw-r1-20261013');

const organId = id('organ', 'organ-dar-consumer');
const taskId = id('task', 'task-dar-consumer');
const cycleId = id('cycle', 'cycle-dar-consumer');
const operationId = id('operation', 'operation-dar-consumer');
const scope: ScopeRef = { organId, taskId, cycleId, operationId };
const childScope: ScopeRef = { organId, taskId, cycleId, operationId: id('operation', 'operation-dar-consumer-child') };
const execution = { runtimeId: 'runtime-dar-consumer', executionEpoch: 3 };
const providerTurnId = 'provider-turn-dar-consumer';
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
    objective: 'D-AR consumer fixture',
    targetRefs: [],
    expectedOutputRefs: ['operation://dar/child-output'],
    acceptanceCriteriaDigest: 'sha256:dar',
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
    producedArtifactDigests: [],
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

async function withFixture(name: string, fn: (root: string) => Promise<void>): Promise<void> {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, `${name}-`));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Writes one exact raw view into the immutable store and returns its descriptor. */
async function writeRaw(sink: ProviderEvidenceSink, label: string, assetScope: ScopeRef, text: string): Promise<RawAsset> {
  const ref = await sink.write({
    scope: assetScope,
    kind: 'tool',
    type: label,
    locator: `dar/${label}`,
    content: text,
  });
  return { ref, view: { kind: 'utf8-text' } };
}

interface Fixture {
  readonly capture: ActiveTurnCaptureBody;
  readonly reader: RawContentReadPort;
  readonly store: ImmutableAssetStore;
  readonly storeRoot: string;
}

async function buildFixture(root: string): Promise<Fixture> {
  const storeRoot = join(root, 'assets');
  const store = new ImmutableAssetStore(storeRoot);
  const sink = filesystemProviderEvidenceSink(store, 'dar-consumer');
  const reader = providerRawContentReader(sink);

  const initialInput = await writeRaw(sink, 'dar-initial-input', scope, 'ORIGINAL USER INPUT');
  const a1Delta1 = await writeRaw(sink, 'dar-a1-delta-1', scope, 'Hello ');
  const old1 = await writeRaw(sink, 'dar-old1', scope, 'OLD ');
  const a1Full = await writeRaw(sink, 'dar-a1-full', scope, 'Hello world!');
  const r1 = await writeRaw(sink, 'dar-r1', scope, 'think');
  const s1 = await writeRaw(sink, 'dar-s1', scope, 'summary');
  const c1 = await writeRaw(sink, 'dar-c1', scope, 'snapshot');
  const args1 = await writeRaw(sink, 'dar-args-1', scope, '{"path":"a"}');
  const output1 = await writeRaw(sink, 'dar-output-1', scope, 'RAW_FAILED_OUTPUT\n{"token":"A"}');
  const a1R2 = await writeRaw(sink, 'dar-a1-r2', scope, 'CONT');
  const args2 = await writeRaw(sink, 'dar-args-2', scope, '{"path":"b"}');
  const output2 = await writeRaw(sink, 'dar-output-2', scope, 'RAW_R2_OUTPUT');
  const childAdopted = await writeRaw(sink, 'dar-child-adopted', childScope, 'CHILD REFINED ADOPTED');
  const childUnadopted = await writeRaw(sink, 'dar-child-unadopted', childScope, 'CHILD REFINED UNADOPTED');

  const entries: AcceptedTurnEntry[] = [];
  const pushFact = (
    seq: number,
    request: ActiveTurnProviderRequestIdentityRef,
    producerSeq: number,
    fact: ProviderRawFact,
  ): void => {
    entries.push({ seq, envelope: { execution, scope, request, producerSeq, fact } });
  };

  pushFact(1, request1, 1, { kind: 'content', contentUnitId: 'a1', channel: 'assistant-text', update: 'delta', content: a1Delta1, complete: false });
  pushFact(2, request1, 2, { kind: 'content', contentUnitId: 'old1', channel: 'assistant-text', update: 'delta', content: old1, complete: false });
  pushFact(3, request1, 3, { kind: 'content', contentUnitId: 'a1', channel: 'assistant-text', update: 'full', content: a1Full, complete: false, replacesUnitIds: ['old1'] });
  pushFact(4, request1, 4, { kind: 'content', contentUnitId: 'r1', channel: 'reasoning-text', update: 'delta', content: r1, complete: false });
  pushFact(5, request1, 5, { kind: 'content', contentUnitId: 's1', channel: 'reasoning-summary', update: 'delta', content: s1, complete: false });
  pushFact(6, request1, 6, { kind: 'content', contentUnitId: 'c1', channel: 'assistant-text', update: 'full', content: c1, complete: false });
  pushFact(7, request1, 7, { kind: 'content-complete', contentUnitId: 'c1' });
  pushFact(8, request1, 8, {
    kind: 'tool-call',
    contentUnitId: 'args-1',
    call: { callId: 'call-x', toolId: 'file.read', arguments: { path: 'a' }, continuationRef: 'cont-1' },
    rawArguments: args1,
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
    rawOutput: output1,
    complete: true,
  });
  pushFact(10, request1, 10, { kind: 'request-complete', terminal: 'completed' });

  pushFact(11, request2, 1, { kind: 'content', contentUnitId: 'a1', channel: 'assistant-text', update: 'delta', content: a1R2, complete: false });
  pushFact(12, request2, 2, {
    kind: 'tool-call',
    contentUnitId: 'args-2',
    call: { callId: 'call-x', toolId: 'file.read', arguments: { path: 'b' }, continuationRef: 'cont-2' },
    rawArguments: args2,
    complete: true,
  });
  pushFact(13, request2, 3, {
    kind: 'tool-result',
    contentUnitId: 'result-2',
    callId: 'call-x',
    continuationRef: 'cont-2',
    result: { ...failedResult, status: 'succeeded', error: undefined },
    rawOutput: output2,
    complete: true,
  });
  pushFact(14, request2, 4, { kind: 'request-complete', terminal: 'completed' });

  const adoptedAssignment = workAssignment('assignment-dar-adopted');
  const unadoptedAssignment = workAssignment('assignment-dar-unadopted');
  entries.push({
    kind: 'execution',
    seq: 15,
    invocationId: 'invocation-dar-adopted',
    refinedDelivery: childAdopted,
    assignment: adoptedAssignment,
    result: workResult(adoptedAssignment),
  });
  entries.push({
    kind: 'execution',
    seq: 16,
    invocationId: 'invocation-dar-unadopted',
    refinedDelivery: childUnadopted,
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
    initialInput,
    entries,
    requests,
    childInvocations,
    checkpointPath: ['checkpoint://dar/pre-call'],
    cut: { pauseId: 'pause-dar', lastSeq: 16, producersDrained: true, frozenAt: '2026-10-12T00:00:00.000Z' },
    completionRefs: [{ requestId: request1.requestId, producerSeq: 10 }],
  };
  return { capture, reader, store, storeRoot };
}

/**
 * Durably saves the supplied capture body as an immutable asset and reads the
 * exact bytes back, so the materializer consumes a body that survived a cold
 * persistence round trip rather than an in-memory literal.
 */
async function saveAndReadCapture(store: ImmutableAssetStore, assetId: string, capture: ActiveTurnCaptureBody): Promise<ActiveTurnCaptureBody> {
  const reference = await store.write(assetId, encoder.encode(JSON.stringify(capture)));
  const readBack = await store.read(reference);
  return JSON.parse(decoder.decode(readBack)) as ActiveTurnCaptureBody;
}

function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label}`);
  return value;
}

function unitFor(
  result: Awaited<ReturnType<typeof materializeActiveTurn>>,
  request: ActiveTurnProviderRequestIdentityRef,
  channel: string,
  contentUnitId: string,
) {
  return defined(
    result.contentUnits.find((candidate) => (
      candidate.request.requestId === request.requestId
      && candidate.channel === channel
      && candidate.contentUnitId === contentUnitId
    )),
    `content unit ${request.requestId}/${channel}/${contentUnitId}`,
  );
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof RuntimeActiveTurnError, `expected RuntimeActiveTurnError, got ${String(error)}`);
  assert.equal((error as RuntimeActiveTurnError).code, code);
}

test('D-AR consumer M1: durable immutable assets + providerRawContentReader resolve exact bytes, folds and pairing', async () => {
  await withFixture('m1', async (root) => {
    const fixture = await buildFixture(root);
    const supplied = await saveAndReadCapture(fixture.store, 'dar-capture-m1', fixture.capture);
    const result = await materializeActiveTurn({ capture: supplied, rawContent: fixture.reader });

    assert.equal(result.version, 1);
    assert.equal(decoder.decode(result.initialInput.bytes), 'ORIGINAL USER INPUT');
    assert.equal(result.binding.admittedTurn.turnId, 'business-turn-dar');
    assert.ok(result.binding.admittedTurn.turnId !== providerTurnId, 'business turn id must differ from the provider turn id');
    assert.deepEqual(result.checkpointPath, ['checkpoint://dar/pre-call']);
    assert.deepEqual(result.completionRefs, [{ requestId: request1.requestId, producerSeq: 10 }]);

    // full replaces the snapshot instead of appending; a replaced unit stays
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
    assert.ok(decoder.decode(r2.bytes) !== decoder.decode(a1.bytes), 'continuation content must not mix with the first request');

    // exact failed tool output and arguments are retained as raw bytes.
    const toolResult = defined(
      result.entries.find((entry): entry is Extract<ResolvedActiveTurnEntry, { kind: 'tool-result' }> => entry.kind === 'tool-result'),
      'tool-result entry',
    );
    assert.equal(decoder.decode(toolResult.rawOutput), 'RAW_FAILED_OUTPUT\n{"token":"A"}');
    const toolCall = defined(
      result.entries.find((entry): entry is Extract<ResolvedActiveTurnEntry, { kind: 'tool-call' }> => entry.kind === 'tool-call'),
      'tool-call entry',
    );
    assert.equal(decoder.decode(toolCall.rawArguments), '{"path":"a"}');

    // the request-complete fact survives without closing the business turn.
    assert.equal(result.entries.filter((entry) => entry.kind === 'request-complete').length, 2);
  });
});

test('D-AR consumer M2: durable child adoption stays isolated and broken references fail explicitly', async () => {
  await withFixture('m2', async (root) => {
    const fixture = await buildFixture(root);
    const supplied = await saveAndReadCapture(fixture.store, 'dar-capture-m2', fixture.capture);
    const parent = await materializeActiveTurn({ capture: supplied, rawContent: fixture.reader });
    const parentSnapshot = structuredClone(parent);

    // only the owner-adopted refinement enters the parent; the unadopted return
    // and both child raw transcripts stay out.
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

    // A child instance with overlapping request/unit ids must not touch the
    // earlier parent result.
    const firstEntry = supplied.entries[0]!;
    const childContent = 'envelope' in firstEntry && firstEntry.envelope.fact.kind === 'content'
      ? firstEntry.envelope.fact.content
      : fixture.capture.initialInput;
    const childCapture: ActiveTurnCaptureBody = {
      ...supplied,
      binding: {
        ...supplied.binding,
        execution: { runtimeId: 'runtime-dar-child', executionEpoch: 9 },
        assignment: { ...supplied.binding.assignment, executionEpoch: 9 },
        admittedTurn: { ...supplied.binding.admittedTurn, executionEpoch: 9 },
      },
      entries: [{
        seq: 1,
        envelope: {
          execution: { runtimeId: 'runtime-dar-child', executionEpoch: 9 },
          scope,
          request: request1,
          producerSeq: 1,
          fact: { kind: 'content', contentUnitId: 'a1', channel: 'assistant-text', update: 'delta', content: childContent, complete: false },
        },
      }],
      requests: [{ request: request1, scope, phase: 'settled' }],
      childInvocations: [],
      cut: { pauseId: 'pause-dar-child', lastSeq: 1, producersDrained: true, frozenAt: '2026-10-12T00:00:00.000Z' },
      completionRefs: [],
    };
    const childSupplied = await saveAndReadCapture(fixture.store, 'dar-capture-child', childCapture);
    const child = await materializeActiveTurn({ capture: childSupplied, rawContent: fixture.reader });
    assert.equal(decoder.decode(unitFor(child, request1, 'assistant-text', 'a1').bytes), 'Hello ');
    assert.deepEqual(parent, parentSnapshot);

    // Mutating one result must not leak into a fresh materialization.
    const a1 = unitFor(parent, request1, 'assistant-text', 'a1');
    (a1.bytes as Uint8Array)[0] = 0;
    const rematerialized = await materializeActiveTurn({ capture: supplied, rawContent: fixture.reader });
    assert.equal(decoder.decode(unitFor(rematerialized, request1, 'assistant-text', 'a1').bytes), 'Hello world!');

    // A missing asset must reject, never substitute a descriptor or summary.
    const missingRef: EvidenceRef = {
      evidenceId: id('evidence', 'dar-missing-asset'),
      kind: 'tool',
      source: 'dar-consumer',
      locator: join(fixture.storeRoot, 'dar-missing-asset'),
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      scope,
    };
    const missingCapture: ActiveTurnCaptureBody = { ...supplied, initialInput: { ref: missingRef, view: { kind: 'utf8-text' } } };
    await assert.rejects(() => materializeActiveTurn({ capture: missingCapture, rawContent: fixture.reader }));

    // A raw asset declared in another scope must reject through the real reader.
    const foreignSink = filesystemProviderEvidenceSink(fixture.store, 'dar-consumer-foreign');
    const foreignAsset = await writeRaw(foreignSink, 'dar-foreign', childScope, 'foreign');
    const wrongScopeCapture: ActiveTurnCaptureBody = { ...supplied, initialInput: foreignAsset };
    await assert.rejects(() => materializeActiveTurn({ capture: wrongScopeCapture, rawContent: fixture.reader }));

    // A raw fact from another execution runtime must reject.
    const wrongExecutionCapture: ActiveTurnCaptureBody = {
      ...supplied,
      entries: supplied.entries.map((entry) => (
        'envelope' in entry && entry.seq === 1
          ? { ...entry, envelope: { ...entry.envelope, execution: { ...entry.envelope.execution, runtimeId: 'runtime-other' } } }
          : entry
      )),
    };
    await expectCode(
      () => materializeActiveTurn({ capture: wrongExecutionCapture, rawContent: fixture.reader }),
      'active-turn.materialize.execution-mismatch',
    );

    // A raw fact whose request is not registered must reject.
    const unknownRequestCapture: ActiveTurnCaptureBody = {
      ...supplied,
      entries: supplied.entries.map((entry) => (
        'envelope' in entry && entry.seq === 1
          ? { ...entry, envelope: { ...entry.envelope, request: { ...entry.envelope.request, requestId: 'request-unregistered' } } }
          : entry
      )),
    };
    await expectCode(
      () => materializeActiveTurn({ capture: unknownRequestCapture, rawContent: fixture.reader }),
      'active-turn.materialize.request-unknown',
    );

    // A tool result whose continuation matches no captured call must reject.
    const unpairedCapture: ActiveTurnCaptureBody = {
      ...supplied,
      entries: supplied.entries.map((entry) => (
        'envelope' in entry && entry.envelope.fact.kind === 'tool-result'
          ? { ...entry, envelope: { ...entry.envelope, fact: { ...entry.envelope.fact, continuationRef: 'cont-mismatch' } } }
          : entry
      )),
    };
    await expectCode(
      () => materializeActiveTurn({ capture: unpairedCapture, rawContent: fixture.reader }),
      'active-turn.materialize.tool-result-unpaired',
    );

    // An invalid adoption reference is rejected by capture validation before any
    // partial materialization can be returned.
    const invalidAdoptionCapture: ActiveTurnCaptureBody = {
      ...supplied,
      childInvocations: supplied.childInvocations.map((invocation) => (
        invocation.invocationId === 'invocation-dar-unadopted'
          ? { ...invocation, adoptedResultSeq: 14 }
          : invocation
      )),
    };
    await assert.rejects(() => materializeActiveTurn({ capture: invalidAdoptionCapture, rawContent: fixture.reader }));
  });
});
