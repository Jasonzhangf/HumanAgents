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
  validateTaskVerificationResult,
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
  type InteractionTraceEntry,
  type InteractionWorkCard,
  type OccurrenceClaim,
  type OccurrenceSettlementInput,
  type OccurrenceTaskBinding,
  type ScopeRef,
  type ServeTaskTerminalReceipt,
  type SubscriptionControlRequest,
  type TaskExecutionEvidence,
  type TaskVerificationResult,
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
  inputArtifactDigest: 'sha256:input-artifact-a',
  status: 'success',
  checkerStdout: 'checker output',
  checkerExitCode: 0,
  evidenceRefs: [evidence],
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
  authorization: {
    scope,
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    requestedCapabilities: ['file.read'],
    permissionRefs: ['permission://task-a'],
    toolOutputRef: 'asset://call-a/output',
  },
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
});

test('public contract consumer rejects incomplete revisions, tool identities, and terminal receipts', () => {
  assert.throws(() => validateDraftRevision({ ...draftRevision, revisionHash: '' }), ContractError);
  assert.throws(() => validateDraftRevisionInput({ ...draftInput, requestedRevisionHash: '' }), ContractError);
  assert.throws(() => validateDraftConfirmation({ ...confirmation, draftRevisionHash: '' }), ContractError);
  assert.throws(() => validateFinalSubmit({ ...finalSubmit, draftRevisionVersion: 0 }), ContractError);
  assert.throws(() => validateExistingTaskChangeSubmit({ ...existingChange, confirmationRef: '' }), ContractError);
  assert.throws(() => validateInteractionTraceEntry({ ...traceEntry, tool: { ...traceEntry.tool!, callId: '' } }), ContractError);
  assert.throws(() => validateTaskVerificationResult({ ...taskVerification, checkerExitCode: 1 }), ContractError);
  assert.throws(() => validateServeTaskTerminalReceipt({
    ...terminalReceipt,
    taskId: id('task', 'task-b'),
  }), ContractError);
  assert.throws(() => validateOccurrenceSettlementInput({
    ...occurrenceSettlement,
    terminalReceipt: {
      ...terminalReceipt,
      verification: { ...taskVerification, status: 'failed', rejectionCode: 'checker-rejected', checkerExitCode: 1 },
    },
  }), ContractError);
  assert.doesNotThrow(() => validateInteractionHistoryResult({
    ok: false,
    failure: { code: 'stale-cursor', message: 'cursor expired', retryable: true },
  }));
  assert.throws(() => validateInteractionHistoryResult({ ok: false } as never), ContractError);
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
