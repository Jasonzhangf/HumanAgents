import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  assertBusinessPayload,
  canonicalJsonStringify,
  id,
  validateAuthorizedRequirement,
  validateDraftConfirmation,
  validateDraftPreviewReceipt,
  validateDraftRejectClosure,
  validateDraftRevision,
  validateDraftRevisionInput,
  validateExistingTaskChangeSubmit,
  validateExecutionPolicyDefinition,
  validateFinalSubmit,
  validateInteractionHistoryQuery,
  validateInteractionHistoryResult,
  validateInteractionTraceEntry,
  validateInteractionWorkCard,
  validateOccurrenceClaim,
  validateOccurrenceSettlementInput,
  validateOccurrenceTaskBinding,
  validateServeTaskTerminalReceipt,
  validateSubscriptionControlRequest,
  validateTaskExecutionEvidence,
  validateTaskCheckPolicy,
  validateTaskObservationProductionResult,
  validateTaskVerificationPolicy,
  validateTaskVerificationResult,
  validateVisualProducerResult,
  validateProviderEvent,
  subscriptionControlRequestFingerprint,
  type AuthorizedRequirement,
  type DraftConfirmation,
  type DraftPreviewReceipt,
  type DraftRejectClosure,
  type DraftRevision,
  type DraftRevisionInput,
  type EvidenceRef,
  type ExistingTaskChangeSubmit,
  type ExecutionPolicyDefinition,
  type FinalSubmit,
  type InteractionHistoryQuery,
  type InteractionHistoryResult,
  type InteractionTraceAuthorization,
  type InteractionTraceEntry,
  type InteractionWorkCard,
  type OccurrenceClaim,
  type OccurrenceSettlementInput,
  type OccurrenceTaskBinding,
  type ScopeRef,
  type ServeTaskTerminalReceipt,
  type SubscriptionControlRequest,
  type TaskExecutionEvidence,
  type TaskCheckPolicy,
  type TaskNativeCheckPolicy,
  type TaskVerificationPolicy,
  type TaskVerificationResult,
  type TaskObservationProductionResult,
  type TaskObservationProducedResult,
  type TaskVisualObservationReceipt,
  type VisualProducerResult,
} from '@humanagent/contracts';

const task = id('task', 'task-a');
const operation = id('operation', 'operation-a');
const scope: ScopeRef = { organId: id('organ', 'organ-a'), taskId: task, operationId: operation };
const evidence: EvidenceRef = {
  evidenceId: id('evidence', 'evidence-a'),
  kind: 'execution',
  source: 'public-consumer',
  locator: 'interaction-contracts.test.ts',
  scope,
};

const oncePolicy: ExecutionPolicyDefinition = {
  policyId: 'policy-once-a',
  policyRevision: 1,
  executionMode: 'once',
  timezone: 'America/Los_Angeles',
  canonicalInstant: '2026-11-01T17:00:00Z',
  dstMode: 'wall',
  dstMissedPolicy: 'shift-forward',
  dstAmbiguousPolicy: 'earlier-offset',
  latePolicy: 'skip',
  busyPolicy: 'skip',
  dueAt: '2026-11-01T17:00:00Z',
};

const recurringPolicy: ExecutionPolicyDefinition = {
  policyId: 'policy-recurring-a',
  policyRevision: 2,
  executionMode: 'recurring',
  timezone: 'America/Los_Angeles',
  canonicalInstant: '2026-11-01T16:00:00Z',
  dstMode: 'wall',
  dstMissedPolicy: 'shift-forward',
  dstAmbiguousPolicy: 'earlier-offset',
  latePolicy: 'run-once',
  busyPolicy: 'idle-reminder',
  startAt: '2026-11-01T16:00:00Z',
  endAt: '2027-01-01T16:00:00Z',
  maxOccurrences: 10,
  frequency: 'weekly',
  timeOfDay: '09:30',
  weekDays: [1, 3, 5],
};

const draftRevision: DraftRevision = {
  draftId: 'draft-a',
  revisionVersion: 1,
  inputRevision: 1,
  goal: 'ship the interaction contract',
  scope: 'contracts only',
  constraints: ['no runtime changes'],
  deliverables: ['typed exports', 'focused tests'],
  normalizedInput: 'ship the interaction contract',
  proposedIntent: 'create',
  proposal: 'contract-first delivery',
  matchedTasks: [],
  knownFacts: ['design review passed'],
  executionControlRef: 'policy://policy-once-a',
  decisionRefs: ['decision://draft-a'],
  state: 'draft',
  history: [],
  revisionHash: 'sha256:draft-a-r1',
  immutableOriginalRef: 'asset://draft-a/original',
};

const draftInput: DraftRevisionInput = {
  draftId: 'draft-a',
  baseRevisionVersion: 1,
  requestedRevisionHash: 'sha256:draft-a-r1',
  fields: { goal: 'ship the interaction contract' },
  instructionRef: 'instruction://draft-a/refine',
  idempotencyKey: 'draft-a-r1-refine',
};

const preview: DraftPreviewReceipt = {
  previewId: 'preview-a',
  interactionId: 'interaction-a',
  draftId: 'draft-a',
  revisionVersion: 1,
  revisionHash: 'sha256:draft-a-r1',
  createdAt: '2026-11-01T16:00:00Z',
  authorized: false,
  context: {
    requestKind: 'new-task-preview',
    interactionId: 'interaction-a',
    inputRevision: 1,
    sourceRef: 'source://public-consumer',
    channelId: 'channel-a',
    createdAt: '2026-11-01T16:00:00Z',
    authorized: false,
  },
};

const confirmation: DraftConfirmation = {
  confirmationRef: 'confirmation-a',
  confirmedBy: 'user-a',
  confirmedAt: '2026-11-01T16:01:00Z',
  payloadRef: 'asset://draft-a/confirmed',
  draftId: 'draft-a',
  draftRevisionVersion: 1,
  draftRevisionHash: 'sha256:draft-a-r1',
  interactionId: 'interaction-a',
};

const finalSubmit: FinalSubmit = {
  interactionId: 'interaction-a',
  draftId: 'draft-a',
  inputRevision: 1,
  draftRevisionVersion: 1,
  draftRevisionHash: 'sha256:draft-a-r1',
  confirmationRef: 'confirmation-a',
  idempotencyKey: 'final-submit-a',
  requestKind: 'new-task-create',
};

const authorizedRequirement: AuthorizedRequirement = {
  requirementId: 'requirement-a',
  draftId: 'draft-a',
  inputRevision: 1,
  draftRevisionVersion: 1,
  draftRevisionHash: 'sha256:draft-a-r1',
  confirmationRef: 'confirmation-a',
  fifoSeq: 1,
  payloadRef: 'asset://draft-a/authorized',
};

const rejectClosure: DraftRejectClosure = {
  rejectionId: 'rejection-a',
  reason: 'user rejected the draft',
  closedAt: '2026-11-01T16:02:00Z',
  durable: true,
  draftId: 'draft-a',
  draftRevisionVersion: 1,
  draftRevisionHash: 'sha256:draft-a-r1',
};

const existingChange: ExistingTaskChangeSubmit = {
  interactionId: 'interaction-a',
  taskId: task,
  draftId: 'draft-a',
  inputRevision: 1,
  draftRevisionVersion: 1,
  draftRevisionHash: 'sha256:draft-a-r1',
  confirmationRef: 'confirmation-a',
  idempotencyKey: 'existing-change-a',
  requestKind: 'existing-task-change',
};

const modifyRequest: SubscriptionControlRequest = {
  action: 'modify',
  subscriptionId: 'subscription-a',
  expectedPolicyRevision: 1,
  expectedScheduleRevision: 1,
  idempotencyKey: 'subscription-modify-a',
  requestedAt: '2026-11-01T16:00:00Z',
  newPolicy: recurringPolicy,
  newPolicyHash: 'sha256:recurring-policy-a',
  confirmationRef: 'confirmation://policy-a',
};

const taskExecutionEvidence: TaskExecutionEvidence = {
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
  inputArtifactDigest: 'sha256:input-artifact-a',
  stdout: 'checker output',
  exitCode: 0,
  evidenceRefs: [evidence],
};

const taskVerification: TaskVerificationResult = {
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
  attempt: 1,
  inputArtifactDigest: 'sha256:input-artifact-a',
  policyRef: 'verification-policy:policy-a:1',
  policyDigest: 'sha256:verification-policy-a',
  status: 'success',
  checks: [{
    checkId: 'structural-check',
    kind: 'process',
    status: 'succeeded',
    stdout: '{"empty":false,"has_html_root":true,"inline_svg_count":1,"animation":{"present":true}}',
    stderr: '',
    exitCode: 0,
    artifactDigests: ['sha256:input-artifact-a'],
    evidenceRefs: [evidence],
  }],
  evidenceRefs: [evidence],
};

const taskProcessCheckEvidence = {
  checkId: 'structural-check',
  kind: 'process' as const,
  status: 'succeeded' as const,
  stdout: '{"empty":false,"has_html_root":true,"inline_svg_count":1,"animation":{"present":true}}',
  stderr: '',
  exitCode: 0,
  artifactDigests: ['sha256:input-artifact-a'],
  evidenceRefs: [evidence],
};

const taskVerificationPolicy: TaskVerificationPolicy = {
  policyId: 'policy-verification-a',
  policyRevision: 1,
  requirementId: 'requirement-a',
  directiveRevision: 1,
  profileRef: 'verification-profile://default/v1',
  checks: [{
    checkId: 'native-default-task-output',
    kind: 'native',
    required: true,
    evaluator: 'default-task-output-v1',
    evaluatorDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    timeoutMs: 5_000,
    permissionRefs: ['permission://task-output/read'],
  }],
  compiledRef: 'verification-policy:policy-verification-a:1',
  compiledDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const taskVerificationSuccess: TaskVerificationResult = {
  ...taskVerification,
  checks: [taskProcessCheckEvidence],
};

const terminalReceipt: ServeTaskTerminalReceipt = {
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
  inputArtifactDigest: 'sha256:input-artifact-a',
  verification: taskVerification,
  terminalCheckpointRef: 'checkpoint://task-a/1',
  settlementReceiptRef: 'settlement://task-a/1',
};

const occurrenceBinding: OccurrenceTaskBinding = {
    occurrenceId: 'subscription-a::1::1',
  subscriptionId: 'subscription-a',
  scheduleRevision: 1,
  occurrenceOrdinal: 1,
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
  inputArtifactDigest: 'sha256:input-artifact-a',
};

const occurrenceSettlement: OccurrenceSettlementInput = {
  binding: occurrenceBinding,
  terminalReceipt,
  outcome: 'succeeded',
};

const traceAuthorization: InteractionTraceAuthorization = {
  scope,
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
  requestedCapabilities: ['file.read'],
  permissionRefs: ['permission://task-a'],
  toolOutputRef: 'asset://call-a/output',
};

const traceEntry: InteractionTraceEntry = {
  turnId: 'turn-a',
  requestId: 'request-a',
  seq: 1,
  occurredAt: '2026-11-01T16:00:00Z',
  kind: 'tool-result',
  modelRef: 'model-a',
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
  tool: {
    callId: 'call-a',
    toolId: 'file.read',
    argumentsRef: 'asset://call-a/arguments',
    argumentsDigest: 'sha256:call-a-arguments',
    status: 'succeeded',
    outputRef: 'asset://call-a/output',
    outputDigest: 'sha256:call-a-output',
    startedAt: '2026-11-01T15:59:59Z',
    durationMs: 1000,
  },
  authorization: traceAuthorization,
  dependencyEdge: { source: 'turn-a', target: 'turn-b', ref: 'call-a', reason: 'tool-result' },
  evidenceRefs: [evidence],
  state: 'running',
  allowedActions: ['stop'],
  provider: { state: 'ready', lastEventAt: '2026-11-01T15:59:59Z' },
  transport: { connected: true, lastSyncedAt: '2026-11-01T16:00:00Z', stale: false, replayed: false, cursor: 'cursor-a' },
  settlement: { providerStopped: false, checkpointCommitted: false },
  lastBusiness: { kind: 'tool-result', at: '2026-11-01T16:00:00Z', ref: 'call-a' },
};

const historyQuery: InteractionHistoryQuery = {
  cursor: 'cursor-a',
  filter: { taskId: task, operationId: operation, executionEpoch: 1, callId: 'call-a' },
  search: 'call-a',
  replay: true,
  limit: 50,
};

const historyResult: InteractionHistoryResult = {
  ok: true,
  page: { cursor: 'cursor-a', hasMore: false, items: [traceEntry], filter: historyQuery.filter, replay: true },
};

const workCard: InteractionWorkCard = {
  source: { taskId: task, operationId: operation, executionEpoch: 1, requestId: 'request-a', turnId: 'turn-a' },
  currentNode: 'provider.tool',
  ownerId: 'runtime-a',
  nextStep: 'read tool output',
  nextAction: 'continue',
  waitingOn: 'provider',
  startedAt: '2026-11-01T15:59:59Z',
  provider: { state: 'ready', lastEventAt: '2026-11-01T15:59:59Z' },
  transport: { connected: true, lastSyncedAt: '2026-11-01T16:00:00Z' },
  settlement: { providerStopped: false, checkpointCommitted: false },
  lastBusiness: { kind: 'tool-result', at: '2026-11-01T16:00:00Z', ref: 'call-a' },
};

const occurrenceClaim: OccurrenceClaim = {
  occurrenceId: 'subscription-a::1::1',
  subscriptionId: 'subscription-a',
  scheduleRevision: 1,
  occurrenceOrdinal: 1,
  claimedBy: 'scheduler-a',
  leaseId: 'lease-a',
  schedulerInstanceId: 'scheduler-a',
  generation: 1,
  executionEpoch: 1,
  acquiredAt: '2026-11-01T15:59:00Z',
  expiresAt: '2026-11-01T16:01:00Z',
};

test('public contract consumer validates the complete interaction and execution boundary', () => {
  assert.doesNotThrow(() => validateDraftRevision(draftRevision));
  assert.doesNotThrow(() => validateDraftRevisionInput(draftInput));
  assert.doesNotThrow(() => validateDraftPreviewReceipt(preview));
  assert.doesNotThrow(() => validateDraftConfirmation(confirmation));
  assert.doesNotThrow(() => validateFinalSubmit(finalSubmit));
  assert.doesNotThrow(() => validateAuthorizedRequirement(authorizedRequirement));
  assert.doesNotThrow(() => validateDraftRejectClosure(rejectClosure));
  assert.doesNotThrow(() => validateExistingTaskChangeSubmit(existingChange));
  assert.doesNotThrow(() => validateExecutionPolicyDefinition(oncePolicy));
  assert.doesNotThrow(() => validateExecutionPolicyDefinition(recurringPolicy));
  assert.doesNotThrow(() => validateSubscriptionControlRequest(modifyRequest));
  assert.doesNotThrow(() => validateOccurrenceClaim(occurrenceClaim));
  assert.doesNotThrow(() => validateTaskExecutionEvidence(taskExecutionEvidence));
  assert.doesNotThrow(() => validateTaskVerificationResult(taskVerification));
  assert.doesNotThrow(() => validateServeTaskTerminalReceipt(terminalReceipt));
  assert.doesNotThrow(() => validateOccurrenceTaskBinding(occurrenceBinding));
  assert.doesNotThrow(() => validateOccurrenceSettlementInput(occurrenceSettlement));
  assert.doesNotThrow(() => validateInteractionTraceEntry(traceEntry));
  assert.doesNotThrow(() => validateInteractionHistoryQuery(historyQuery));
  assert.doesNotThrow(() => validateInteractionHistoryResult(historyResult));
  assert.doesNotThrow(() => validateInteractionWorkCard(workCard));
});

test('public contract consumer rejects invalid policy and control shapes', () => {
  assert.throws(() => validateExecutionPolicyDefinition({ ...oncePolicy, timezone: 'Mars/Olympus' }), ContractError);
  assert.throws(() => validateExecutionPolicyDefinition({ ...oncePolicy, canonicalInstant: '2026-11-01T17:00:00-07:00' }), ContractError);
  assert.throws(() => validateExecutionPolicyDefinition({ ...oncePolicy, dueAt: '2026-02-30T17:00:00Z' }), ContractError);
  assert.throws(() => validateExecutionPolicyDefinition({ ...recurringPolicy, endAt: recurringPolicy.startAt }), ContractError);
  assert.throws(() => validateExecutionPolicyDefinition({ ...recurringPolicy, frequency: 'interval', intervalMinutes: 0, timeOfDay: undefined, weekDays: undefined }), ContractError);
  assert.throws(() => validateExecutionPolicyDefinition({ ...recurringPolicy, maxOccurrences: 0 }), ContractError);
  assert.throws(() => validateSubscriptionControlRequest({ ...modifyRequest, newPolicyHash: '' }), ContractError);
  assert.throws(() => validateSubscriptionControlRequest({
    action: 'pause',
    subscriptionId: 'subscription-a',
    expectedPolicyRevision: 1,
    idempotencyKey: 'pause-a',
    requestedAt: '2026-11-01T16:00:00Z',
    newPolicy: recurringPolicy,
  }), ContractError);
  assert.equal(
    subscriptionControlRequestFingerprint(modifyRequest)
      !== subscriptionControlRequestFingerprint({ ...modifyRequest, newPolicy: oncePolicy }),
    true,
  );
  assert.equal(canonicalJsonStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.throws(() => validateExecutionPolicyDefinition({ ...oncePolicy, verificationProfileRef: '' }), ContractError);
  assert.doesNotThrow(() => validateExecutionPolicyDefinition({ ...oncePolicy, verificationProfileRef: 'verification-profile://default/v1' }));
});

test('public contract consumer rejects incomplete revisions, tool identities, and terminal receipts', () => {
  assert.throws(() => validateDraftRevision({ ...draftRevision, revisionHash: '' }), ContractError);
  assert.throws(() => validateDraftRevisionInput({ ...draftInput, requestedRevisionHash: '' }), ContractError);
  assert.throws(() => validateDraftConfirmation({ ...confirmation, draftRevisionHash: '' }), ContractError);
  assert.throws(() => validateFinalSubmit({ ...finalSubmit, draftRevisionVersion: 0 }), ContractError);
  assert.throws(() => validateExistingTaskChangeSubmit({ ...existingChange, confirmationRef: '' }), ContractError);
  assert.throws(() => validateInteractionTraceEntry({ ...traceEntry, tool: { ...traceEntry.tool!, callId: '' } }), ContractError);
  assert.throws(() => validateTaskVerificationResult({
    ...taskVerification,
    checks: [{ ...taskProcessCheckEvidence, status: 'failed', exitCode: 1 }],
  }), ContractError);
  assert.doesNotThrow(() => validateTaskVerificationPolicy(taskVerificationPolicy));
  assert.throws(() => validateTaskVerificationPolicy({
    ...taskVerificationPolicy,
    checks: [],
  }), ContractError);
  assert.throws(() => validateTaskVerificationPolicy({
    ...taskVerificationPolicy,
    compiledDigest: 'not-a-digest',
  }), ContractError);
  const nativePolicy = taskVerificationPolicy.checks[0] as TaskNativeCheckPolicy;
  assert.throws(() => validateTaskCheckPolicy({
    ...nativePolicy,
    evaluatorDigest: 'not-a-digest',
  }), ContractError);
  assert.throws(() => validateServeTaskTerminalReceipt({
    ...terminalReceipt,
    taskId: id('task', 'task-b'),
  }), ContractError);
  assert.throws(() => validateOccurrenceSettlementInput({
    ...occurrenceSettlement,
    terminalReceipt: {
      ...terminalReceipt,
      verification: {
        ...taskVerification,
        status: 'failed',
        rejectionCode: 'checker-rejected',
        checks: [{ ...taskProcessCheckEvidence, status: 'failed', exitCode: 1 }],
      },
    },
  }), ContractError);
  assert.doesNotThrow(() => validateInteractionHistoryResult({
    ok: false,
    failure: { code: 'stale-cursor', message: 'cursor expired', retryable: true },
  }));
  assert.throws(() => validateInteractionHistoryResult({ ok: false } as never), ContractError);
});

test('public consumer rejects a tool-call without a typed descriptor', () => {
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    kind: 'tool-call',
    tool: undefined,
  }), ContractError);
});

test('public consumer rejects a tool-result without a typed descriptor', () => {
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    tool: undefined,
  }), ContractError);
});

test('public consumer rejects a succeeded tool descriptor without verifiable output evidence', () => {
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    tool: {
      ...traceEntry.tool!,
      outputRef: undefined,
      outputDigest: undefined,
    },
  }), ContractError);
});

test('public consumer rejects history pages containing invalid trace entries', () => {
  assert.throws(() => validateInteractionHistoryResult({
    ok: true,
    page: {
      hasMore: false,
      items: [{ ...traceEntry, tool: undefined }],
    },
  }), ContractError);
});

test('public consumer accepts legal tool calls and succeeded tool results', () => {
  assert.doesNotThrow(() => validateInteractionTraceEntry({
    ...traceEntry,
    kind: 'assistant',
    tool: undefined,
  }));
  assert.doesNotThrow(() => validateInteractionTraceEntry({
    ...traceEntry,
    kind: 'tool-call',
    tool: {
      callId: 'call-a',
      toolId: 'file.read',
      argumentsRef: 'asset://call-a/arguments',
      argumentsDigest: 'sha256:call-a-arguments',
      status: 'running',
    },
  }));
  assert.doesNotThrow(() => validateInteractionTraceEntry(traceEntry));
});

test('public consumer rejects authorization scope task conflicts', () => {
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    authorization: {
      ...traceAuthorization,
      scope: { ...scope, taskId: id('task', 'task-b') },
    },
  }), ContractError);
});

test('public consumer rejects authorization scope operation conflicts', () => {
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    authorization: {
      ...traceAuthorization,
      scope: { ...scope, operationId: id('operation', 'operation-b') },
    },
  }), ContractError);
});

test('public consumer rejects authorization output reference conflicts', () => {
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    authorization: {
      ...traceAuthorization,
      toolOutputRef: 'asset://call-a/other-output',
    },
  }), ContractError);
});

test('public consumer rejects missing required authorization output reference', () => {
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    authorization: {
      ...traceAuthorization,
      toolOutputRef: undefined as unknown as string,
    },
  }), ContractError);
});

test('public consumer accepts broader and matching authorization scopes', () => {
  assert.doesNotThrow(() => validateInteractionTraceEntry({
    ...traceEntry,
    authorization: {
      ...traceAuthorization,
      scope: { organId: scope.organId },
    },
  }));
  assert.doesNotThrow(() => validateInteractionTraceEntry({
    ...traceEntry,
    authorization: {
      ...traceAuthorization,
      scope,
    },
  }));
});

test('control-plane fields cannot leak into business payloads', () => {
  assert.throws(() => assertBusinessPayload({ executionMode: 'recurring' } as never), ContractError);
  assert.throws(() => assertBusinessPayload({ newPolicy: { executionMode: 'once' } } as never), ContractError);
  assert.throws(() => assertBusinessPayload({ metadata: { policyRevision: 1 } } as never), ContractError);
});

test('public consumer report is externally inspectable', () => {
  const report = {
    consumer: '@humanagent/contracts',
    checks: 5,
    terminalStatus: taskVerification.status,
    occurrenceOutcome: occurrenceSettlement.outcome,
    canonicalPolicy: canonicalJsonStringify(recurringPolicy),
    validation: 'passed',
  };
  assert.equal(report.terminalStatus, 'success');
  assert.equal(report.occurrenceOutcome, 'succeeded');
  console.log(`PUBLIC_CONSUMER_REPORT ${JSON.stringify(report)}`);
});

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const digestC = `sha256:${'c'.repeat(64)}`;
const digestD = `sha256:${'d'.repeat(64)}`;
const digestE = `sha256:${'e'.repeat(64)}`;
const digestF = `sha256:${'f'.repeat(64)}`;

function observationReceipt(): TaskVisualObservationReceipt {
  return {
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    attempt: 1,
    bindingRef: 'binding://visual',
    bindingDigest: digestA,
    primaryArtifactRef: 'artifact://visual/primary.html',
    primaryArtifactDigest: digestB,
    screenshot: { artifactRef: 'asset://visual/screenshot', artifactDigest: digestC, mediaType: 'image/png' },
    motion: {
      artifactRef: 'asset://visual/motion',
      artifactDigest: digestD,
      firstSampleRef: 'asset://visual/t1',
      firstSampleDigest: digestE,
      secondSampleRef: 'asset://visual/t2',
      secondSampleDigest: digestF,
    },
    browserRelease: { releaseRef: 'browser-release://visual', released: true, evidenceRefs: [evidence] },
    evidenceRefs: [evidence],
    producedAt: '2026-10-04T00:00:00.000Z',
  };
}

function producedObservation(): TaskObservationProducedResult {
  const receipt = observationReceipt();
  return {
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    attempt: 1,
    bindingRef: receipt.bindingRef,
    bindingDigest: receipt.bindingDigest,
    primaryArtifactRef: receipt.primaryArtifactRef,
    primaryArtifactDigest: receipt.primaryArtifactDigest,
    browserCreated: true,
    evidenceRefs: [evidence],
    browserRelease: receipt.browserRelease,
    status: 'produced',
    receipt,
  };
}

function settledVisual(): VisualProducerResult {
  return {
    checkId: 'native-aitest-visual-motion',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    attempt: 1,
    inputArtifactDigest: digestC,
    status: 'satisfied',
    assertions: [
      { assertion: 'visible-pelican-identity', verdict: 'satisfied', evidenceText: 'the rendered frame shows the pelican' },
    ],
    capturedAt: '2026-10-04T00:00:01.000Z',
    decisionRef: 'decision://visual',
    decisionDigest: digestD,
    evidenceRefs: [evidence],
    phase: 'settled',
    providerBindingId: 'provider-binding://visual',
    providerBindingDigest: digestE,
    routeRef: 'route://visual',
    requestModel: 'gpt-5.5',
    responseModel: 'MiniMax-M3',
    requestId: 'request-1',
    outputArtifactRef: 'asset://visual/output',
    outputArtifactDigest: digestF,
    settlementRef: 'settlement://visual',
    settlementDigest: digestA,
  };
}

test('public consumer accepts a produced observation only after real browser release', () => {
  assert.doesNotThrow(() => validateTaskObservationProductionResult(producedObservation()));
});

test('public consumer rejects a produced observation without a released browser', () => {
  const produced = producedObservation();
  assert.throws(() => validateTaskObservationProductionResult({
    ...produced,
    browserCreated: false,
    browserRelease: undefined,
  } as unknown as TaskObservationProductionResult), ContractError);
  assert.throws(() => validateTaskObservationProductionResult({
    ...produced,
    browserRelease: { ...produced.receipt.browserRelease, released: false as unknown as true },
  }), ContractError);
});

test('public consumer rejects a non-produced observation that carries a receipt', () => {
  const produced = producedObservation();
  assert.throws(() => validateTaskObservationProductionResult({
    ...produced,
    status: 'failed',
  } as unknown as TaskObservationProductionResult), ContractError);
});

test('public consumer requires browser release evidence for a produced observation', () => {
  const produced = producedObservation();
  assert.throws(() => validateTaskObservationProductionResult({
    ...produced,
    browserRelease: { ...produced.receipt.browserRelease, evidenceRefs: [] },
  }), ContractError);
});

test('public consumer accepts a settled visual result with a real response model', () => {
  assert.doesNotThrow(() => validateVisualProducerResult(settledVisual()));
});

test('public consumer rejects a settled visual result without an actual response model', () => {
  const settled = settledVisual();
  assert.throws(() => validateVisualProducerResult({ ...settled, responseModel: undefined } as unknown as VisualProducerResult), ContractError);
  assert.throws(() => validateVisualProducerResult({ ...settled, responseModel: '   ' } as VisualProducerResult), ContractError);
});

test('public consumer rejects a not-dispatched visual result that carries phantom provider facts', () => {
  const notDispatched: VisualProducerResult = {
    checkId: 'native-aitest-visual-motion',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    attempt: 1,
    inputArtifactDigest: digestC,
    status: 'unavailable',
    assertions: [],
    capturedAt: '2026-10-04T00:00:01.000Z',
    decisionRef: 'decision://visual-unavailable',
    decisionDigest: digestD,
    evidenceRefs: [evidence],
    phase: 'not-dispatched',
    providerBindingId: 'provider-binding://visual',
    providerBindingDigest: digestE,
    routeRef: 'route://visual',
    error: {
      code: 'capability-unavailable',
      message: 'no provider image consumer is configured',
      evidenceRefs: [evidence],
      retryable: false,
      recoveryOwner: 'humanagent.operations-adapter',
      nextAction: 'configure the provider image consumer',
    },
  };
  assert.doesNotThrow(() => validateVisualProducerResult(notDispatched));
  assert.throws(() => validateVisualProducerResult({ ...notDispatched, requestId: 'phantom-request' } as VisualProducerResult), ContractError);
  assert.throws(() => validateVisualProducerResult({ ...notDispatched, settlementRef: 'phantom-settlement' } as VisualProducerResult), ContractError);
});

test('public consumer rejects a satisfied visual result with an unresolved assertion', () => {
  const settled = settledVisual();
  assert.throws(() => validateVisualProducerResult({
    ...settled,
    assertions: [{ assertion: 'visible-pelican-identity', verdict: 'rejected', evidenceText: 'the pelican is missing' }],
  } as VisualProducerResult), ContractError);
});

test('public consumer carries an actual provider response model and rejects a blank one', () => {
  const event = {
    runtimeId: 'runtime-a',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    eventId: 'event-a',
    kind: 'model' as const,
    responseModel: 'MiniMax-M3',
    evidenceRefs: [evidence],
  };
  assert.doesNotThrow(() => validateProviderEvent(event));
  assert.doesNotThrow(() => validateProviderEvent({ ...event, responseModel: undefined }));
  assert.throws(() => validateProviderEvent({ ...event, responseModel: '   ' }), ContractError);
});
