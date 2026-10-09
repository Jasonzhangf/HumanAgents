import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODE_SEARCH_CONTRACT_VERSION,
  CODE_SEARCH_SERVICE_ID,
  ContractError,
  id,
  validateAdmittedTurn,
  validateCheckpointBoundaryOutcome,
  validateCodeSearchReport,
  validateDurableCheckpointReceipt,
  validateNativeTurnBoundary,
  validateProviderEvent,
  validateProviderToolResult,
  validateSemanticClosureCandidate,
  validateStageResult,
  validateToolExecutionFact,
  validateTurnDisposition,
  validateTurnExecutionFacts,
  type AdmittedTurn,
  type AdmittedTurnIdentity,
  type Checkpoint,
  type CheckpointBoundaryOutcome,
  type CodeSearchReport,
  type DurableCheckpointReceipt,
  type DurablePhaseOutcome,
  type EvidenceRef,
  type NativeTurnBoundary,
  type RecoveryHoldFacts,
  type RecoveryHoldProjection,
  type ScopeRef,
  type SemanticClosureCandidate,
  type StageResult,
  type SuccessPathProjection,
  type ToolExecutionFact,
  type ToolIdentity,
  type ProviderEvent,
  type ProviderToolResult,
  type TurnDisposition,
  type TurnExecutionFacts,
} from '@humanagent/contracts';

const organId = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const cycleId = id('cycle', 'cycle-a');
const scopeRef: ScopeRef = { organId, taskId, cycleId };
const evidenceRef: EvidenceRef = {
  evidenceId: id('evidence', 'evidence-a'),
  kind: 'execution',
  source: 'native-contract-test',
  locator: 'turn://turn-a',
  scope: scopeRef,
};

const admittedTurn: AdmittedTurn = {
  turnId: 'turn-a',
  workAssignmentRef: 'assignment-a',
  taskRef: taskId,
  scopeRef,
  cycleRef: cycleId,
  inputRevision: 1,
  directiveRevision: 2,
  executionEpoch: 3,
  runtimeBindingRef: 'binding-a',
  permissionRevision: 'permission-r1',
  admissionEvidenceRefs: ['admission-evidence-a'],
  currentTurnRef: 'turn-state-a',
  recoveryStateRef: 'recovery-state-a',
};

const expectedTurnIdentity: AdmittedTurnIdentity = {
  turnId: admittedTurn.turnId,
  workAssignmentRef: admittedTurn.workAssignmentRef,
  taskRef: taskId,
  scopeRef,
  cycleRef: cycleId,
  inputRevision: admittedTurn.inputRevision,
  directiveRevision: admittedTurn.directiveRevision,
  executionEpoch: admittedTurn.executionEpoch,
  runtimeBindingRef: admittedTurn.runtimeBindingRef,
  permissionRevision: admittedTurn.permissionRevision,
};

const toolExecution: ToolExecutionFact = {
  identity: { surface: 'native-tools', toolId: 'file.read', bindingRef: 'tool-binding-a', route: 'direct-executor' },
  requestRef: 'request-a',
  callRef: 'call-a',
  operationRef: 'operation-a',
  state: 'succeeded',
  rawEvidenceRefs: ['raw-tool-a'],
  resultRef: 'result-a',
  resultDigest: 'sha256:result-a',
};

const providerToolIdentity: ToolIdentity = {
  surface: 'native-tools',
  toolId: 'file.read',
  bindingRef: 'tool-binding-a',
  route: 'direct-executor',
};
const providerExecutionFact: ToolExecutionFact = {
  ...toolExecution,
  resultDigest: `sha256:${'a'.repeat(64)}`,
};
const providerToolResult: ProviderToolResult = {
  runtimeId: 'runtime-a',
  taskId,
  operationId: id('operation', 'operation-a'),
  executionEpoch: admittedTurn.executionEpoch,
  toolId: 'file.read',
  callId: 'call-a',
  status: 'succeeded',
  outputRefs: ['result-a'],
  evidenceRefs: [evidenceRef],
  outputRef: 'result-a',
  outputDigest: `sha256:${'a'.repeat(64)}`,
  executionFact: providerExecutionFact,
};
const providerToolResultEvent: ProviderEvent = {
  runtimeId: providerToolResult.runtimeId,
  taskId: providerToolResult.taskId,
  operationId: providerToolResult.operationId,
  executionEpoch: providerToolResult.executionEpoch,
  eventId: 'event-a',
  kind: 'tool',
  turnId: 'turn-a',
  requestId: 'request-a',
  toolPhase: 'result',
  evidenceRefs: [evidenceRef],
  ownerId: 'runtime',
  nextAction: { kind: 'continue' },
  toolResult: providerToolResult,
};

const turnFacts: TurnExecutionFacts = {
  turnId: admittedTurn.turnId,
  dispatchState: 'returned',
  assignmentRef: admittedTurn.workAssignmentRef,
  childResultRef: 'child-result-a',
  workResultState: 'reported',
  toolFacts: [toolExecution],
  operationRefs: ['operation-a'],
  acceptanceEvidenceRefs: ['acceptance-a'],
  unresolvedOperationRefs: [],
  rawTurnRefs: ['raw-turn-a'],
};

const claim = {
  fact: 'The file exists and has the recorded digest.',
  certainty: 'confirmed' as const,
  sourceRefs: ['result-a'],
};

const semanticCandidate: SemanticClosureCandidate = {
  turnId: admittedTurn.turnId,
  checkpointSummary: 'Read file A; its digest is recorded. Next, compare it with the requested reference.',
  ruleVersion: 'tool-semantics-v1',
  claims: [claim],
  constraints: [],
  unresolvedQuestions: [],
  semanticArtifactRefs: ['semantic-a'],
  rawTurnRefs: ['raw-turn-a'],
  requestedOutcome: 'waiting',
};

const fiveCommittedPhases = (): DurablePhaseOutcome[] => [
  { phase: 'recovery-assets', state: 'committed', receiptRef: 'recovery-assets-receipt' },
  { phase: 'checkpoint', state: 'committed', receiptRef: 'checkpoint-journal-receipt' },
  { phase: 'closure', state: 'committed', receiptRef: 'closure-receipt' },
  { phase: 'context-view', state: 'committed', receiptRef: 'context-view-receipt' },
  { phase: 'history-publication', state: 'committed', receiptRef: 'history-receipt' },
];

const checkpointReceipt: DurableCheckpointReceipt = {
  commitIdentity: 'commit-a',
  checkpointRef: 'checkpoint-a',
  journalReceiptRef: 'checkpoint-journal-receipt',
  committedAt: '2026-10-08T20:30:00.123Z',
  timeAuthority: {
    source: 'harness',
    owner: 'runtime-checkpoint-control-owner',
    authorityRef: 'checkpoint-owner-authority-a',
  },
};

const successfulOutcome: CheckpointBoundaryOutcome = {
  commitIdentity: 'commit-a',
  stages: [
    { stageId: 'save', state: 'succeeded', value: { stored: true }, evidenceRefs: ['save-evidence-a'] },
  ],
  durablePhases: fiveCommittedPhases(),
  checkpointReceipt,
  closureReceiptRef: 'closure-receipt',
  contextViewReceiptRef: 'context-view-receipt',
  historyReceiptRef: 'history-receipt',
  laterErrorRefs: [],
  unresolvedOperationRefs: [],
  rawTurnRefs: ['raw-turn-a'],
};

const activeSuccess: SuccessPathProjection = {
  path: 'success',
  active: true,
  durableTurnReceiptRef: 'durable-turn-a',
  checkpointReceiptRef: checkpointReceipt.checkpointRef,
  historyReceiptRef: 'history-receipt',
};

const inactiveRecovery: RecoveryHoldProjection = {
  path: 'recovery-hold',
  active: false,
  reasonRef: 'all-durable-phases-complete',
};

const readyDisposition: TurnDisposition = {
  state: 'ready-next',
  durableTurnReceiptRef: 'durable-turn-a',
  checkpointReceiptRef: checkpointReceipt.checkpointRef,
  historyReceiptRef: 'history-receipt',
  nextActionRef: 'next-turn-admission',
};

const partialOutcome: CheckpointBoundaryOutcome = {
  commitIdentity: 'commit-partial',
  stages: [
    { stageId: 'candidate', state: 'succeeded', value: semanticCandidate, evidenceRefs: ['candidate-evidence'] },
    { stageId: 'checkpoint', state: 'failed', error: { code: 'journal-failed', message: 'Checkpoint append failed.', errorRef: 'error-checkpoint' }, recoveryRef: 'recovery-partial', evidenceRefs: ['checkpoint-attempt'] },
    { stageId: 'closure', state: 'not-executed', blockedByStage: 'checkpoint', causeRef: 'error-checkpoint', firstErrorRef: 'error-checkpoint', recoveryRef: 'recovery-partial' },
  ],
  durablePhases: [
    { phase: 'recovery-assets', state: 'committed', receiptRef: 'recovery-assets-partial' },
    { phase: 'checkpoint', state: 'failed' },
    { phase: 'closure', state: 'not-executed' },
    { phase: 'context-view', state: 'not-executed' },
    { phase: 'history-publication', state: 'not-executed' },
  ],
  firstErrorRef: 'error-checkpoint',
  laterErrorRefs: [],
  unresolvedOperationRefs: ['operation-open-a'],
  rawTurnRefs: ['raw-turn-a'],
  recoveryRef: 'recovery-partial',
};

const recoveryFacts: RecoveryHoldFacts = {
  commitIdentity: 'commit-partial',
  firstErrorRef: 'error-checkpoint',
  laterErrorRefs: [],
  rawTurnRefs: ['raw-turn-a'],
  unresolvedOperationRefs: ['operation-open-a'],
  stages: partialOutcome.stages,
  durablePhases: partialOutcome.durablePhases,
  durableReceiptRefs: ['recovery-assets-partial'],
  recoveryResponsibilityRef: 'recovery-partial',
};

const inactiveSuccess: SuccessPathProjection = {
  path: 'success',
  active: false,
  reasonRef: 'checkpoint-phase-failed',
};

const activeRecovery: RecoveryHoldProjection = {
  path: 'recovery-hold',
  active: true,
  facts: recoveryFacts,
};

const incompleteDisposition: TurnDisposition = {
  state: 'save-incomplete',
  commitIdentity: 'commit-partial',
  durablePhases: partialOutcome.durablePhases,
  recoveryRef: 'recovery-partial',
  firstErrorRef: 'error-checkpoint',
};

function expectContractError(action: () => unknown): void {
  assert.throws(action, ContractError);
}

test('public package root accepts an admitted turn, execution facts, and semantic candidate', () => {
  assert.doesNotThrow(() => validateAdmittedTurn(admittedTurn, expectedTurnIdentity));
  assert.doesNotThrow(() => validateTurnExecutionFacts(turnFacts, admittedTurn));
  assert.doesNotThrow(() => validateSemanticClosureCandidate(semanticCandidate, admittedTurn));
});

test('public package root accepts empty tool facts and known-failed or unknown tool effects', () => {
  assert.doesNotThrow(() => validateTurnExecutionFacts({ ...turnFacts, toolFacts: [] }, admittedTurn));
  assert.doesNotThrow(() => validateToolExecutionFact({ ...toolExecution, state: 'failed', errorRef: 'tool-error-a' }));
  const { resultRef: _resultRef, resultDigest: _resultDigest, ...unresolvedToolExecution } = toolExecution;
  assert.doesNotThrow(() => validateToolExecutionFact({ ...unresolvedToolExecution, state: 'unknown' }));
});

test('public provider result can carry a bound native tool fact while preserving legacy results', () => {
  const { executionFact: _executionFact, ...legacyResult } = providerToolResult;
  assert.doesNotThrow(() => validateProviderToolResult(legacyResult));
  assert.doesNotThrow(() => validateProviderToolResult(providerToolResult, providerToolIdentity, 'request-a'));
  assert.doesNotThrow(() => validateProviderEvent(providerToolResultEvent, providerToolIdentity));
  const before = structuredClone(providerToolResultEvent);
  validateProviderEvent(providerToolResultEvent, providerToolIdentity);
  assert.deepEqual(providerToolResultEvent, before);
});

test('attached provider fact rejects when trusted expected tool identity is omitted', () => {
  assert.throws(() => validateProviderToolResult(providerToolResult), ContractError);
});

test('direct attached provider result rejects when expected request reference is omitted', () => {
  assert.throws(() => validateProviderToolResult(providerToolResult, providerToolIdentity), ContractError);
});

test('attached provider event requires complete outer request identity', () => {
  assert.throws(() => validateProviderEvent({ ...providerToolResultEvent, turnId: undefined, requestId: undefined }, providerToolIdentity), ContractError);
});

test('provider attachment rejects mismatched trusted identity and request binding', () => {
  assert.throws(() => validateProviderToolResult({
    ...providerToolResult,
    executionFact: { ...providerExecutionFact, identity: { ...providerToolIdentity, bindingRef: 'other-binding' } },
  }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderToolResult({
    ...providerToolResult,
    executionFact: { ...providerExecutionFact, identity: { ...providerToolIdentity, route: 'other-route' } },
  }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderEvent({ ...providerToolResultEvent, requestId: 'request-b' }, providerToolIdentity), ContractError);
  assert.throws(() => validateProviderEvent({ ...providerToolResultEvent, requestId: undefined }, providerToolIdentity), ContractError);
  assert.throws(() => validateProviderEvent({ ...providerToolResultEvent, turnId: undefined }, providerToolIdentity), ContractError);
});

test('provider attachment rejects mismatched tool, call, operation, and result envelope fields', () => {
  assert.throws(() => validateProviderToolResult({ ...providerToolResult, toolId: 'file.write' }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderToolResult({ ...providerToolResult, callId: 'call-b' }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderToolResult({ ...providerToolResult, operationId: id('operation', 'operation-b') }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderToolResult({ ...providerToolResult, status: 'failed' }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderToolResult({ ...providerToolResult, outputRef: undefined }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderToolResult({ ...providerToolResult, outputDigest: `sha256:${'b'.repeat(64)}` }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderToolResult({ ...providerToolResult, executionFact: { ...providerExecutionFact, resultDigest: undefined } }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderToolResult({ ...providerToolResult, executionFact: { ...providerExecutionFact, resultRef: 'other-result' } }, providerToolIdentity, 'request-a'), ContractError);
  assert.throws(() => validateProviderToolResult({ ...providerToolResult, executionFact: { ...providerExecutionFact, resultDigest: 'sha256:bad' } }, providerToolIdentity, 'request-a'), ContractError);
});

test('provider event result must share parent execution identity with its child result', () => {
  assert.throws(() => validateProviderEvent({ ...providerToolResultEvent, runtimeId: 'runtime-b' }, providerToolIdentity), ContractError);
  assert.throws(() => validateProviderEvent({ ...providerToolResultEvent, taskId: id('task', 'task-b') }, providerToolIdentity), ContractError);
  assert.throws(() => validateProviderEvent({ ...providerToolResultEvent, executionEpoch: 4 }, providerToolIdentity), ContractError);
});

test('provider execution facts reject control fields', () => {
  assert.throws(() => validateProviderToolResult({
    ...providerToolResult,
    executionFact: { ...providerExecutionFact, executionEpoch: 7 } as ToolExecutionFact,
  }, providerToolIdentity, 'request-a'), ContractError);
});

test('public package root preserves each semantic certainty and its source/rule version', () => {
  for (const certainty of ['confirmed', 'partial', 'unknown', 'corrected'] as const) {
    const candidate = { ...semanticCandidate, claims: [{ ...claim, certainty }] };
    assert.doesNotThrow(() => validateSemanticClosureCandidate(candidate, admittedTurn));
  }
});

test('public package root accepts five committed phases and the matching ready success path', () => {
  const boundary = { outcome: successfulOutcome, success: activeSuccess, recovery: inactiveRecovery, disposition: readyDisposition };
  assert.doesNotThrow(() => validateCheckpointBoundaryOutcome(successfulOutcome));
  assert.doesNotThrow(() => validateNativeTurnBoundary(boundary));
  assert.doesNotThrow(() => validateTurnDisposition(readyDisposition));
});

test('public package root accepts partial persistence while preserving receipts and recovery responsibility', () => {
  const boundary = { outcome: partialOutcome, success: inactiveSuccess, recovery: activeRecovery, disposition: incompleteDisposition };
  assert.doesNotThrow(() => validateCheckpointBoundaryOutcome(partialOutcome));
  assert.doesNotThrow(() => validateNativeTurnBoundary(boundary));
  assert.deepEqual(partialOutcome.durablePhases[0], { phase: 'recovery-assets', state: 'committed', receiptRef: 'recovery-assets-partial' });
  assert.equal(partialOutcome.rawTurnRefs[0], 'raw-turn-a');
});

test('legacy Checkpoint remains valid without native time fields and receipt validation does not mutate input', () => {
  const legacyCheckpoint: Checkpoint = {
    id: id('checkpoint', 'checkpoint-legacy'),
    scope: scopeRef,
    cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 2,
    executionEpoch: 3,
    outcome: 'waiting',
    summary: 'Waiting for an external confirmation.',
    recoveryStateRef: evidenceRef,
    evidenceRefs: [evidenceRef],
    next: { kind: 'wait', ref: 'confirmation-a' },
  };
  const receipt = structuredClone(checkpointReceipt);
  const before = structuredClone(receipt);
  assert.equal('committedAt' in legacyCheckpoint, false);
  assert.doesNotThrow(() => validateDurableCheckpointReceipt(receipt, { commitIdentity: 'commit-a', checkpointRef: 'checkpoint-a' }));
  assert.deepEqual(receipt, before);
});

test('rejects mismatched task scope, cycle identity, and invalid tool identity', () => {
  expectContractError(() => validateAdmittedTurn({ ...admittedTurn, taskRef: id('task', 'other-task') }, expectedTurnIdentity));
  expectContractError(() => validateAdmittedTurn({ ...admittedTurn, cycleRef: id('cycle', 'other-cycle') }, expectedTurnIdentity));
  expectContractError(() => validateAdmittedTurn({ ...admittedTurn, scopeRef: { ...scopeRef, taskId: id('task', 'other-task') } }));
  expectContractError(() => validateTurnExecutionFacts({ ...turnFacts, toolFacts: [{ ...toolExecution, identity: { ...toolExecution.identity, route: '' } }] }, admittedTurn));
  const opaqueRef = JSON.stringify({ ...evidenceRef, scope: { ...scopeRef, taskId: id('task', 'external-scope') } });
  assert.doesNotThrow(() => validateTurnExecutionFacts({ ...turnFacts, toolFacts: [{ ...toolExecution, rawEvidenceRefs: [opaqueRef] }] }, admittedTurn));
});

test('rejects non-positive or unsafe epoch and expected epoch mismatch', () => {
  expectContractError(() => validateAdmittedTurn({ ...admittedTurn, executionEpoch: 0 }));
  expectContractError(() => validateAdmittedTurn({ ...admittedTurn, executionEpoch: Number.MAX_SAFE_INTEGER + 1 }));
  expectContractError(() => validateAdmittedTurn(admittedTurn, { ...expectedTurnIdentity, executionEpoch: 4 }));
});

test('rejects assignment, revision, permission, and binding identity mismatches', () => {
  for (const [field, value] of [
    ['workAssignmentRef', 'assignment-other'],
    ['inputRevision', 2],
    ['directiveRevision', 3],
    ['permissionRevision', 'permission-r2'],
    ['runtimeBindingRef', 'binding-other'],
  ] as const) {
    expectContractError(() => validateAdmittedTurn(admittedTurn, { ...expectedTurnIdentity, [field]: value }));
  }
});

test('rejects provider continuation fields and missing domain identity fields on admitted turns', () => {
  expectContractError(() => validateAdmittedTurn({ ...admittedTurn, providerSessionId: 'provider-session-a' }));
  expectContractError(() => validateAdmittedTurn({ ...admittedTurn, continuation: 'opaque-session-chain' }));
  const { taskRef: _taskRef, ...missingTask } = admittedTurn;
  expectContractError(() => validateAdmittedTurn(missingTask));
});

test('rejects missing or mismatched members of the four-part tool identity', () => {
  expectContractError(() => validateToolExecutionFact({ ...toolExecution, identity: { ...toolExecution.identity, surface: '' } }));
  expectContractError(() => validateToolExecutionFact({ ...toolExecution, identity: { ...toolExecution.identity, bindingRef: 'other-binding' } }, toolExecution.identity));
  expectContractError(() => validateToolExecutionFact({ ...toolExecution, identity: { surface: 'native-tools', toolId: 'file.read', bindingRef: 'tool-binding-a' } }));
});

test('rejects turn facts associated with a different turn, assignment, or dispatch state', () => {
  expectContractError(() => validateTurnExecutionFacts({ ...turnFacts, turnId: 'turn-other' }, admittedTurn));
  expectContractError(() => validateTurnExecutionFacts({ ...turnFacts, assignmentRef: 'assignment-other' }, admittedTurn));
  expectContractError(() => validateTurnExecutionFacts({ ...turnFacts, dispatchState: 'accepted-but-finished' }, admittedTurn));
});

test('rejects semantic claims without sources and candidates without rule version or summary', () => {
  expectContractError(() => validateSemanticClosureCandidate({ ...semanticCandidate, claims: [{ ...claim, sourceRefs: [] }] }, admittedTurn));
  expectContractError(() => validateSemanticClosureCandidate({ ...semanticCandidate, ruleVersion: '' }, admittedTurn));
  expectContractError(() => validateSemanticClosureCandidate({ ...semanticCandidate, checkpointSummary: '  ' }, admittedTurn));
});

test('rejects control fields on semantic closure proposals', () => {
  expectContractError(() => validateSemanticClosureCandidate({ ...semanticCandidate, committedAt: checkpointReceipt.committedAt }, admittedTurn));
  expectContractError(() => validateSemanticClosureCandidate({ ...semanticCandidate, timeAuthority: checkpointReceipt.timeAuthority }, admittedTurn));
  expectContractError(() => validateSemanticClosureCandidate({ ...semanticCandidate, permissionRevision: 'permission-r2' }, admittedTurn));
  expectContractError(() => validateSemanticClosureCandidate({ ...semanticCandidate, admission: 'approved' }, admittedTurn));
  expectContractError(() => validateSemanticClosureCandidate({ ...semanticCandidate, readyNext: true }, admittedTurn));
});

test('rejects StageResult variants with missing or cross-branch fields', () => {
  expectContractError(() => validateStageResult({ stageId: 'stage-a', state: 'succeeded', evidenceRefs: [] }));
  expectContractError(() => validateStageResult({ stageId: 'stage-a', state: 'failed', error: { code: 'e', message: 'm', errorRef: 'e' }, recoveryRef: 'r', evidenceRefs: [], value: 'forged' }));
  expectContractError(() => validateStageResult({ stageId: 'stage-a', state: 'not-executed', blockedByStage: 's', causeRef: 'c', recoveryRef: 'r', value: 'forged' }));
});

test('rejects non-UTC, impossible-date, missing-time, and invalid-clock timestamps', () => {
  for (const committedAt of ['2026-10-08T20:30:00+00:00', '2026-02-30T20:30:00Z', '2026-10-08', '2026-10-08T24:00:00Z']) {
    expectContractError(() => validateDurableCheckpointReceipt({ ...checkpointReceipt, committedAt }, { commitIdentity: 'commit-a', checkpointRef: 'checkpoint-a' }));
  }
});

test('rejects missing/empty Harness authority and non-Harness authority literals', () => {
  expectContractError(() => validateDurableCheckpointReceipt({ ...checkpointReceipt, timeAuthority: { ...checkpointReceipt.timeAuthority, authorityRef: '' } }, { commitIdentity: 'commit-a', checkpointRef: 'checkpoint-a' }));
  expectContractError(() => validateDurableCheckpointReceipt({ ...checkpointReceipt, timeAuthority: { ...checkpointReceipt.timeAuthority, source: 'model' } }, { commitIdentity: 'commit-a', checkpointRef: 'checkpoint-a' }));
  expectContractError(() => validateDurableCheckpointReceipt({ ...checkpointReceipt, timeAuthority: { ...checkpointReceipt.timeAuthority, owner: 'provider' } }, { commitIdentity: 'commit-a', checkpointRef: 'checkpoint-a' }));
});

test('rejects receipts missing identity/journal references or differing from expected identity', () => {
  expectContractError(() => validateDurableCheckpointReceipt({ ...checkpointReceipt, journalReceiptRef: '' }, { commitIdentity: 'commit-a', checkpointRef: 'checkpoint-a' }));
  expectContractError(() => validateDurableCheckpointReceipt(checkpointReceipt, { commitIdentity: 'commit-other', checkpointRef: 'checkpoint-a' }));
  expectContractError(() => validateDurableCheckpointReceipt(checkpointReceipt, { commitIdentity: 'commit-a', checkpointRef: 'checkpoint-other' }));
});

test('rejects durable phase vectors with missing, duplicate, illegal, or receiptless committed phase', () => {
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...successfulOutcome, durablePhases: fiveCommittedPhases().slice(1) }));
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...successfulOutcome, durablePhases: [...fiveCommittedPhases().slice(0, 4), fiveCommittedPhases()[3]] }));
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...successfulOutcome, durablePhases: fiveCommittedPhases().map((phase, index) => index === 0 ? { phase: 'other-phase', state: 'committed', receiptRef: 'r' } : phase) }));
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...successfulOutcome, durablePhases: fiveCommittedPhases().map((phase, index) => index === 2 ? { phase: 'closure', state: 'committed' } : phase) }));
});

test('durable phase states form a committed prefix followed only by not-executed phases', () => {
  const {
    checkpointReceipt: _checkpointReceipt,
    closureReceiptRef: _closureReceiptRef,
    historyReceiptRef: _historyReceiptRef,
    contextViewReceiptRef: _contextViewReceiptRef,
    ...successWithoutReceipts
  } = successfulOutcome;
  const committedPrefix = [
    { phase: 'recovery-assets', state: 'committed', receiptRef: 'asset-receipt' },
    { phase: 'checkpoint', state: 'committed', receiptRef: checkpointReceipt.journalReceiptRef },
    { phase: 'closure', state: 'committed', receiptRef: 'closure-receipt' },
    { phase: 'context-view', state: 'not-executed' },
    { phase: 'history-publication', state: 'not-executed' },
  ];
  assert.doesNotThrow(() => validateCheckpointBoundaryOutcome({
    ...successWithoutReceipts,
    durablePhases: committedPrefix,
    checkpointReceipt,
    closureReceiptRef: 'closure-receipt',
    recoveryRef: 'recovery-prefix',
  }));

  const failedThenCommitted = fiveCommittedPhases().map((phase, index) => index === 0
    ? { phase: 'recovery-assets', state: 'failed' }
    : phase);
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...successfulOutcome, durablePhases: failedThenCommitted, recoveryRef: 'recovery-impossible' }));

  const unknownThenCommitted = fiveCommittedPhases().map((phase, index) => index === 1
    ? { phase: 'checkpoint', state: 'unknown' }
    : phase);
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...successfulOutcome, durablePhases: unknownThenCommitted, recoveryRef: 'recovery-impossible' }));

  assert.doesNotThrow(() => validateCheckpointBoundaryOutcome(partialOutcome));

  assert.doesNotThrow(() => validateCheckpointBoundaryOutcome({
    ...successWithoutReceipts,
    durablePhases: [
      { phase: 'recovery-assets', state: 'committed', receiptRef: 'unknown-prefix-asset' },
      { phase: 'checkpoint', state: 'unknown' },
      { phase: 'closure', state: 'not-executed' },
      { phase: 'context-view', state: 'not-executed' },
      { phase: 'history-publication', state: 'not-executed' },
    ],
    recoveryRef: 'unknown-prefix-recovery',
  }));
});

test('boundary first error matches the earliest failed stage and failed phases retain error responsibility', () => {
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...partialOutcome, firstErrorRef: 'error-other' }));

  const { firstErrorRef: _originalFirstErrorRef, ...partialWithoutFirstError } = partialOutcome;
  const withoutFailedCheckpointStage = {
    ...partialWithoutFirstError,
    stages: [{ stageId: 'candidate', state: 'succeeded' as const, value: semanticCandidate, evidenceRefs: ['candidate-evidence'] }],
  };
  expectContractError(() => validateCheckpointBoundaryOutcome(withoutFailedCheckpointStage));

  const laterFailureNamedFirst = {
    ...partialOutcome,
    stages: [
      { stageId: 'checkpoint', state: 'failed' as const, error: { code: 'checkpoint-failed', message: 'Checkpoint append failed.', errorRef: 'error-checkpoint' }, recoveryRef: 'recovery-partial', evidenceRefs: ['checkpoint-attempt'] },
      { stageId: 'closure', state: 'failed' as const, error: { code: 'closure-failed', message: 'Closure failed.', errorRef: 'error-closure' }, recoveryRef: 'recovery-partial', evidenceRefs: ['closure-attempt'] },
    ],
    firstErrorRef: 'error-closure',
  };
  expectContractError(() => validateCheckpointBoundaryOutcome(laterFailureNamedFirst));
  assert.doesNotThrow(() => validateCheckpointBoundaryOutcome(partialOutcome));
});

test('rejects boundary commit identity and receipt reference conflicts', () => {
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...successfulOutcome, checkpointReceipt: { ...checkpointReceipt, commitIdentity: 'commit-other' } }));
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...successfulOutcome, historyReceiptRef: 'history-other' }));
  expectContractError(() => validateCheckpointBoundaryOutcome({ ...successfulOutcome, contextViewReceiptRef: 'view-other' }));
});

test('rejects ready-next success when receipts are incomplete or errors/unknown/effects remain', () => {
  const boundary = { outcome: successfulOutcome, success: activeSuccess, recovery: inactiveRecovery, disposition: readyDisposition };
  expectContractError(() => validateNativeTurnBoundary({ ...boundary, outcome: { ...successfulOutcome, durablePhases: fiveCommittedPhases().map((phase, index) => index === 4 ? { phase: 'history-publication', state: 'not-executed' } : phase) } }));
  expectContractError(() => validateNativeTurnBoundary({ ...boundary, outcome: { ...successfulOutcome, firstErrorRef: 'error-late' } }));
  expectContractError(() => validateNativeTurnBoundary({ ...boundary, outcome: { ...successfulOutcome, durablePhases: fiveCommittedPhases().map((phase, index) => index === 2 ? { ...phase, state: 'unknown' } : phase) } }));
  expectContractError(() => validateNativeTurnBoundary({ ...boundary, outcome: { ...successfulOutcome, unresolvedOperationRefs: ['operation-open-a'] } }));
});

test('rejects both success/recovery projections active and both inactive', () => {
  const boundary = { outcome: successfulOutcome, success: activeSuccess, recovery: inactiveRecovery, disposition: readyDisposition };
  expectContractError(() => validateNativeTurnBoundary({ ...boundary, recovery: { path: 'recovery-hold', active: true, facts: recoveryFacts } }));
  expectContractError(() => validateNativeTurnBoundary({ ...boundary, success: inactiveSuccess }));
});

test('rejects malformed active/inactive fields and projection/disposition mismatches', () => {
  expectContractError(() => validateNativeTurnBoundary({ outcome: successfulOutcome, success: { path: 'success', active: true, durableTurnReceiptRef: 'turn' }, recovery: inactiveRecovery, disposition: readyDisposition }));
  expectContractError(() => validateNativeTurnBoundary({ outcome: successfulOutcome, success: { ...inactiveSuccess, durableTurnReceiptRef: 'forbidden' }, recovery: inactiveRecovery, disposition: readyDisposition }));
  expectContractError(() => validateNativeTurnBoundary({ outcome: successfulOutcome, success: activeSuccess, recovery: inactiveRecovery, disposition: incompleteDisposition }));
});

test('rejects recovery dispositions missing required recovery, raw, operation, or stop-settlement refs', () => {
  expectContractError(() => validateTurnDisposition({ state: 'waiting-recovery', recoveryRef: '' }));
  expectContractError(() => validateTurnDisposition({ state: 'waiting-reconcile', operationRefs: [], recoveryRef: 'recovery-a' }));
  expectContractError(() => validateTurnDisposition({ state: 'waiting-correction', rawTurnRefs: [], correctionRef: 'correction-a' }));
  expectContractError(() => validateTurnDisposition({ state: 'stopped', stopOperationRef: 'operation-a', settleEvidenceRefs: [], checkpointReceiptRef: 'checkpoint-a' }));
});

test('stopped requires committed checkpoint and closure receipts with no unresolved operations', () => {
  const stoppedOutcome: CheckpointBoundaryOutcome = {
    commitIdentity: 'stop-commit',
    stages: [{ stageId: 'stop', state: 'succeeded', value: 'settled', evidenceRefs: ['stop-stage-evidence'] }],
    durablePhases: [
      { phase: 'recovery-assets', state: 'committed', receiptRef: 'stop-assets-receipt' },
      { phase: 'checkpoint', state: 'committed', receiptRef: checkpointReceipt.journalReceiptRef },
      { phase: 'closure', state: 'committed', receiptRef: 'stop-closure-receipt' },
      { phase: 'context-view', state: 'not-executed' },
      { phase: 'history-publication', state: 'not-executed' },
    ],
    checkpointReceipt: { ...checkpointReceipt, commitIdentity: 'stop-commit' },
    closureReceiptRef: 'stop-closure-receipt',
    laterErrorRefs: [],
    unresolvedOperationRefs: [],
    rawTurnRefs: ['raw-stop-turn'],
    recoveryRef: 'stop-recovery',
  };
  const stoppedBoundary = (outcome: CheckpointBoundaryOutcome): NativeTurnBoundary => ({
    outcome,
    success: { path: 'success', active: false, reasonRef: 'stop-is-recovery-path' },
    recovery: {
      path: 'recovery-hold',
      active: true,
      facts: {
        commitIdentity: outcome.commitIdentity,
        laterErrorRefs: outcome.laterErrorRefs,
        rawTurnRefs: outcome.rawTurnRefs,
        unresolvedOperationRefs: outcome.unresolvedOperationRefs,
        stages: outcome.stages,
        durablePhases: outcome.durablePhases,
        durableReceiptRefs: outcome.durablePhases.flatMap((phase) => phase.state === 'committed' ? [phase.receiptRef] : []),
        recoveryResponsibilityRef: 'stop-recovery',
      },
    },
    disposition: { state: 'stopped', stopOperationRef: 'stop-operation', settleEvidenceRefs: ['settle-evidence'], checkpointReceiptRef: checkpointReceipt.checkpointRef },
  });
  assert.doesNotThrow(() => validateNativeTurnBoundary(stoppedBoundary(stoppedOutcome)));

  const { closureReceiptRef: _closureReceiptRef, ...stoppedWithoutClosureReceipt } = stoppedOutcome;
  const closureUnfinished: CheckpointBoundaryOutcome = {
    ...stoppedWithoutClosureReceipt,
    durablePhases: stoppedOutcome.durablePhases.map((phase) => phase.phase === 'closure'
      ? { phase: 'closure', state: 'unknown' as const }
      : phase),
  };
  expectContractError(() => validateNativeTurnBoundary(stoppedBoundary(closureUnfinished)));

  const unresolvedOperation = { ...stoppedOutcome, unresolvedOperationRefs: ['operation-still-open'] };
  expectContractError(() => validateNativeTurnBoundary(stoppedBoundary(unresolvedOperation)));
});

const completeCodeSearchReport: CodeSearchReport = {
  serviceId: CODE_SEARCH_SERVICE_ID,
  contractVersion: CODE_SEARCH_CONTRACT_VERSION,
  status: 'succeeded',
  workspaceRef: 'workspace://fixture',
  path: 'src',
  query: 'needle',
  queryKind: 'literal',
  matches: [{ path: 'src/a.ts', line: 2, column: 1, text: 'needle here', contextBefore: ['before'], contextAfter: ['after'] }],
  filesDiscovered: 2,
  filesSearched: 2,
  matchesFound: 1,
  resultsTruncated: false,
  searchComplete: true,
  unresolvedPaths: [],
  summary: 'searched 2 file(s), found 1 match(es)',
};

function codeSearchReportWithoutPathTree(): CodeSearchReport {
  return { ...completeCodeSearchReport, matches: [], matchesFound: 0, summary: 'searched 2 file(s), found 0 match(es)' };
}

function partialCodeSearchReport(): CodeSearchReport {
  return {
    ...completeCodeSearchReport,
    filesDiscovered: 2,
    filesSearched: 1,
    matchesFound: 1,
    searchComplete: false,
    unresolvedPaths: ['src/broken.ts'],
    summary: 'partial search: inspected 1 file(s), found 1 match(es)',
  };
}

function truncatedCodeSearchReport(): CodeSearchReport {
  return {
    ...completeCodeSearchReport,
    matchesFound: 3,
    resultsTruncated: true,
    summary: 'searched 2 file(s), found 3 match(es)',
  };
}

function failedCodeSearchReport(): CodeSearchReport {
  return {
    ...completeCodeSearchReport,
    status: 'failed',
    matches: [],
    filesDiscovered: 0,
    filesSearched: 0,
    matchesFound: 0,
    searchComplete: false,
    path: '../outside',
    summary: 'search path must stay inside the workspace',
    failure: { code: 'invalid-request', message: 'search path must stay inside the workspace' },
  };
}

function scopeTooLargeCodeSearchReport(): CodeSearchReport {
  return {
    ...completeCodeSearchReport,
    status: 'failed',
    matches: [],
    filesDiscovered: 3,
    filesSearched: 0,
    matchesFound: 0,
    searchComplete: false,
    summary: 'search scope contains at least 3 files; maximum is 2',
    pathTree: { path: '.', kind: 'directory', fileCount: 3, children: [], truncated: false },
    failure: { code: 'scope-too-large', message: 'search scope is too large; narrow the requested path' },
  };
}

function expectCodeSearchReportError(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    assert.equal(error.message, message);
    return;
  }
  throw new Error(`expected ContractError: ${message}`);
}

test('public package root validates every successful CodeSearchReport shape without mutation', () => {
  const valid = [completeCodeSearchReport, codeSearchReportWithoutPathTree(), partialCodeSearchReport(), truncatedCodeSearchReport()];
  for (const report of valid) {
    const before = structuredClone(report);
    const unknownReport: unknown = report;
    validateCodeSearchReport(unknownReport);
    assert.deepEqual(unknownReport, before);
    const typed: CodeSearchReport = unknownReport;
    assert.equal(typed.contractVersion, CODE_SEARCH_CONTRACT_VERSION);
  }
});

test('public package root preserves empty and whitespace-only matched source lines', () => {
  for (const text of ['', '   ', '\t']) {
    const report: CodeSearchReport = {
      ...completeCodeSearchReport,
      matches: [{ ...completeCodeSearchReport.matches[0]!, text }],
    };
    const before = structuredClone(report);
    const unknownReport: unknown = report;
    validateCodeSearchReport(unknownReport);
    assert.deepEqual(unknownReport, before);
    assert.equal((unknownReport as CodeSearchReport).matches[0]?.text, text);
  }
});

test('public package root preserves a well-formed failed business search report', () => {
  const failed = failedCodeSearchReport();
  const before = structuredClone(failed);
  assert.doesNotThrow(() => validateCodeSearchReport(failed));
  assert.deepEqual(failed, before);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure?.code, 'invalid-request');
  assert.equal(failed.path, '../outside');
});

test('public package root preserves invalid-request echo strings without normalization', () => {
  const echoes = [
    { workspaceRef: '', path: 'src', query: 'needle' },
    { workspaceRef: 'workspace://fixture', path: '', query: 'needle' },
    { workspaceRef: 'workspace://fixture', path: 'src', query: '   ' },
    { workspaceRef: '  ', path: '\t', query: '' },
  ];
  for (const echo of echoes) {
    const report: CodeSearchReport = {
      ...failedCodeSearchReport(),
      ...echo,
      failure: { code: 'invalid-request', message: 'invalid code search request' },
    };
    const before = structuredClone(report);
    const unknownReport: unknown = report;
    validateCodeSearchReport(unknownReport);
    assert.deepEqual(unknownReport, before);
    assert.equal((unknownReport as CodeSearchReport).workspaceRef, echo.workspaceRef);
    assert.equal((unknownReport as CodeSearchReport).path, echo.path);
    assert.equal((unknownReport as CodeSearchReport).query, echo.query);
  }
});

test('public package root rejects empty report location strings outside the invalid-request echo branch', () => {
  expectCodeSearchReportError(
    () => validateCodeSearchReport({ ...completeCodeSearchReport, workspaceRef: '' }),
    'code search report workspaceRef must be a non-empty string',
  );
  expectCodeSearchReportError(
    () => validateCodeSearchReport({ ...failedCodeSearchReport(), path: '', failure: { code: 'read-failed', message: 'read failed' } }),
    'code search report path must be a non-empty string',
  );
});

test('public package root validates a scope-too-large report with a bounded pathTree', () => {
  const report = scopeTooLargeCodeSearchReport();
  const before = structuredClone(report);
  assert.doesNotThrow(() => validateCodeSearchReport(report));
  assert.deepEqual(report, before);
  assert.equal(report.status, 'failed');
  assert.equal(report.failure?.code, 'scope-too-large');
  assert.equal(report.pathTree?.fileCount, 3);
});

test('public CodeSearchReport validation rejects sparse match arrays before assigning the public type', () => {
  const sparseMatches = new Array(1);
  const report = { ...completeCodeSearchReport, matches: sparseMatches };
  assert.equal(sparseMatches.length, 1);
  assert.equal(Object.hasOwn(sparseMatches, 0), false);
  expectCodeSearchReportError(() => validateCodeSearchReport(report), 'code search report matches[0] must be an object');
});

test('public CodeSearchReport validation rejects absent and wrong versions', () => {
  const { contractVersion: _contractVersion, ...withoutVersion } = completeCodeSearchReport;
  expectCodeSearchReportError(() => validateCodeSearchReport(withoutVersion), 'code search report is missing contractVersion');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, contractVersion: '2.0.0' }), 'unsupported code search report contract version');
});

test('public CodeSearchReport validation rejects malformed matches and counters', () => {
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, matches: [{ ...completeCodeSearchReport.matches[0], line: 0 }] }), 'code search report matches[0].line must be at least 1');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, matches: [{ ...completeCodeSearchReport.matches[0], column: Number.MAX_SAFE_INTEGER + 1 }] }), 'code search report matches[0].column must be a safe integer');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, matches: [{ ...completeCodeSearchReport.matches[0], contextBefore: 'before' }] }), 'code search report matches[0].contextBefore must be an array');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, filesDiscovered: -1 }), 'code search report filesDiscovered must be non-negative');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, matchesFound: Number.MAX_SAFE_INTEGER + 1 }), 'code search report matchesFound must be a safe integer');
});

test('public CodeSearchReport validation rejects malformed flags, unresolved paths, and pathTree nodes', () => {
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, searchComplete: 'yes' }), 'code search report searchComplete must be a boolean');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, resultsTruncated: 0 }), 'code search report resultsTruncated must be a boolean');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, unresolvedPaths: [''] }), 'code search report unresolvedPaths entry must be a non-empty string');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...scopeTooLargeCodeSearchReport(), pathTree: { ...scopeTooLargeCodeSearchReport().pathTree, kind: 'link' } }), 'code search report pathTree.kind is invalid');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...scopeTooLargeCodeSearchReport(), pathTree: { ...scopeTooLargeCodeSearchReport().pathTree, fileCount: 0 } }), 'code search report pathTree.fileCount must be at least 1');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...scopeTooLargeCodeSearchReport(), pathTree: { ...scopeTooLargeCodeSearchReport().pathTree, children: [{ path: 'src/a.ts' }] } }), 'code search report pathTree.children entry is missing kind');
});

test('public CodeSearchReport validation rejects malformed failure shapes and contradictions', () => {
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...failedCodeSearchReport(), failure: { code: 'unknown', message: 'x' } }), 'code search report failure.code is invalid');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...failedCodeSearchReport(), failure: { code: 'read-failed', message: '' } }), 'code search report failure.message must be a non-empty string');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...failedCodeSearchReport(), failure: { code: 'read-failed', message: 'x', path: '' } }), 'code search report failure.path must be a non-empty string');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, filesSearched: 3 }), 'code search report filesSearched exceeds filesDiscovered');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, matchesFound: 0 }), 'code search report matchesFound is smaller than returned matches');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, resultsTruncated: true }), 'code search report truncation state is inconsistent');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, searchComplete: true, unresolvedPaths: ['src/broken.ts'] }), 'code search report completeness is inconsistent with unresolved paths');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...failedCodeSearchReport(), failure: undefined }), 'failed code search report requires failure');
  expectCodeSearchReportError(() => validateCodeSearchReport({ ...completeCodeSearchReport, failure: { code: 'read-failed', message: 'x' } }), 'succeeded code search report cannot carry failure');
});

test('public CodeSearchReport validation is fail-closed and leaves optional fields absent', () => {
  const minimal = codeSearchReportWithoutPathTree() as unknown as Record<string, unknown>;
  assert.doesNotThrow(() => validateCodeSearchReport(minimal));
  assert.equal(Object.hasOwn(minimal, 'pathTree'), false);
  assert.equal(Object.hasOwn(minimal, 'failure'), false);
  const before = structuredClone(minimal);
  assert.doesNotThrow(() => validateCodeSearchReport(minimal));
  assert.deepEqual(minimal, before);
  for (const value of [undefined, null, [], 'report']) {
    expectCodeSearchReportError(() => validateCodeSearchReport(value), 'code search report must be an object');
  }
  expectCodeSearchReportError(() => validateCodeSearchReport({}), 'code search report is missing serviceId');
});

function compileTimeNegativeFixtures(): void {
  // @ts-expect-error a cycle scoped id cannot stand in for the task identity
  const wrongTaskId: AdmittedTurn['taskRef'] = cycleId;
  // @ts-expect-error Provider sessions are execution evidence, not admitted-turn identity
  const providerSessionTurn: AdmittedTurn = { ...admittedTurn, providerSessionId: 'provider-session-a' };
  // @ts-expect-error native proposals cannot assign commit time
  const timedProposal: SemanticClosureCandidate = { ...semanticCandidate, committedAt: checkpointReceipt.committedAt };
  // @ts-expect-error only the Harness source is valid
  const wrongTimeSource: DurableCheckpointReceipt['timeAuthority']['source'] = 'model';
  // @ts-expect-error only the checkpoint owner may assign the time authority
  const wrongTimeOwner: DurableCheckpointReceipt['timeAuthority']['owner'] = 'provider';
  // @ts-expect-error authorityRef is required
  const missingAuthority: DurableCheckpointReceipt['timeAuthority'] = { source: 'harness', owner: 'runtime-checkpoint-control-owner' };
  // @ts-expect-error succeeded stage needs value and cannot carry error
  const mixedSucceeded: StageResult<string> = { stageId: 's', state: 'succeeded', value: 'ok', evidenceRefs: [], error: { code: 'e', message: 'm', errorRef: 'e' } };
  // @ts-expect-error failed stage needs an error and cannot carry value
  const mixedFailed: StageResult<string> = { stageId: 's', state: 'failed', recoveryRef: 'r', evidenceRefs: [], value: 'forged' };
  // @ts-expect-error inactive success projection cannot carry active-only receipt fields
  const mixedInactive: SuccessPathProjection = { path: 'success', active: false, reasonRef: 'why', historyReceiptRef: 'history' };
  // @ts-expect-error active recovery projection must carry recovery facts
  const missingRecoveryFacts: RecoveryHoldProjection = { path: 'recovery-hold', active: true };
  // @ts-expect-error ready-next must carry a durable checkpoint receipt reference
  const missingCheckpointReceipt: TurnDisposition = { state: 'ready-next', durableTurnReceiptRef: 'turn', historyReceiptRef: 'history', nextActionRef: 'next' };
  // @ts-expect-error a ready-next disposition cannot be mixed with recovery-only fields
  const mixedReadyRecovery: TurnDisposition = { ...readyDisposition, recoveryRef: 'recovery' };
  void [wrongTaskId, providerSessionTurn, timedProposal, wrongTimeSource, wrongTimeOwner, missingAuthority, mixedSucceeded, mixedFailed, mixedInactive, missingRecoveryFacts, missingCheckpointReceipt, mixedReadyRecovery];
}

void compileTimeNegativeFixtures;
