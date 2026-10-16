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
  type ResolvedSemanticTurnContext,
  type SemanticCurrentTurnUnit,
} from '../../../packages/runtime/src/context/semantic-turn-context-reader.js';

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
  acceptanceCriteriaDigest: 'sha256:refs',
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
