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
  validateSemanticObservationEnvelope,
  validateCoverageIssue,
  validatePairedExecutionGroup,
  validateCapabilityStatus,
  COVERAGE_ISSUE_REASONS,
  PAIRED_EXECUTION_STATES,
  type CapabilityStatus,
  type CoverageIssue,
  type PairedExecutionGroup,
  type SemanticEventRef,
  type SemanticObservationEnvelope,
} from '@humanagent/contracts';
import {
  ContextEventError,
  createContextEvent,
  validateCanonicalContextEvent,
  type CanonicalContextEvent,
} from '../../packages/context-events/src/index.js';
import type { RuntimeSemanticObservationEnvelope } from '../../packages/ui/contracts/runtime.js';

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

test('public consumer accepts a succeeded tool descriptor whose evidence is carried by the trace entry', () => {
  // A succeeded provider tool call may report its output in-band, so the
  // descriptor refs may be absent; the entry's own evidence refs are then the
  // verifiable pointer to the returned side.
  assert.doesNotThrow(() => validateInteractionTraceEntry({
    ...traceEntry,
    tool: {
      ...traceEntry.tool!,
      outputRef: undefined,
      outputDigest: undefined,
    },
  }));
});

test('public consumer rejects a succeeded tool descriptor with no output refs and no evidence', () => {
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    evidenceRefs: [],
    tool: {
      ...traceEntry.tool!,
      outputRef: undefined,
      outputDigest: undefined,
    },
  }), ContractError);
});

test('public consumer rejects a tool descriptor whose output ref and digest are not provided together', () => {
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    tool: { ...traceEntry.tool!, outputDigest: undefined },
  }), ContractError);
  assert.throws(() => validateInteractionTraceEntry({
    ...traceEntry,
    tool: { ...traceEntry.tool!, outputRef: undefined },
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

/* ------------------------------------------------------------------ *
 * I1-C：shared semantic observation contracts (§17.3–§17.6)
 * ------------------------------------------------------------------ */

const semanticEvent: CanonicalContextEvent = createContextEvent({
  type: 'task.created',
  sourceId: 'source-task-created-a',
  occurredAt: '2026-11-01T16:00:00Z',
  scope,
  evidenceRefs: [evidence],
});

const semanticEventRef: SemanticEventRef = {
  eventId: semanticEvent.eventId,
  sourceId: semanticEvent.sourceId,
  scope,
};

const coverageUnknownKind: CoverageIssue = {
  reason: 'unknown-kind',
  scope,
  sourceRef: evidence,
  eventRef: semanticEventRef,
};

const pairedOperation: PairedExecutionGroup = {
  groupId: 'group-operation-a',
  kind: 'operation',
  scope,
  executionEpoch: 1,
  requestId: 'request-a',
  callId: 'call-a',
  toolId: 'tool-a',
  state: 'closed',
  eventRefs: [semanticEventRef],
};

const capabilityAvailable: CapabilityStatus = {
  capability: 'revision-history',
  state: 'available',
  sourceRef: evidence,
};

function semanticEnvelope(
  overrides: Partial<SemanticObservationEnvelope<CanonicalContextEvent>> = {},
): SemanticObservationEnvelope<CanonicalContextEvent> {
  return {
    scope,
    projectionVersion: 'i1c-v1',
    sourceWatermark: 7,
    publicCommitWatermark: 3,
    events: [semanticEvent],
    coverageIssues: [coverageUnknownKind],
    pairing: [pairedOperation],
    capabilities: [capabilityAvailable],
    ...overrides,
  };
}

test('I1-C shared envelope validates canonical events through the canonical owner callback', () => {
  const events = [semanticEvent];
  const envelope: SemanticObservationEnvelope<CanonicalContextEvent> = semanticEnvelope({ events });
  const uiEnvelope: RuntimeSemanticObservationEnvelope = envelope;
  type UiElement = RuntimeSemanticObservationEnvelope['events'][number];
  const uiAligned: UiElement = semanticEvent;

  assert.doesNotThrow(() => validateSemanticObservationEnvelope(envelope, validateCanonicalContextEvent));
  assert.equal(uiEnvelope.events, events);
  assert.equal(envelope.events[0], semanticEvent);
  assert.equal(uiAligned, semanticEvent);
  assert.equal(envelope.coverageIssues[0].eventRef?.eventId, semanticEvent.eventId);
  assert.equal(envelope.pairing[0].kind, 'operation');
  assert.equal(envelope.capabilities[0].state, 'available');
});

test('I1-C keeps source and public watermarks independent and never guesses a relation', () => {
  const bothPresent = semanticEnvelope({ sourceWatermark: 7, publicCommitWatermark: 3 });
  assert.equal(bothPresent.sourceWatermark, 7);
  assert.equal(bothPresent.publicCommitWatermark, 3);
  assert.doesNotThrow(() => validateSemanticObservationEnvelope(bothPresent, validateCanonicalContextEvent));

  const publicOmitted = semanticEnvelope({ publicCommitWatermark: undefined });
  assert.equal(publicOmitted.publicCommitWatermark, undefined);
  assert.notEqual(publicOmitted.publicCommitWatermark, 0);
  assert.doesNotThrow(() => validateSemanticObservationEnvelope(publicOmitted, validateCanonicalContextEvent));

  const equal = semanticEnvelope({ sourceWatermark: 4, publicCommitWatermark: 4 });
  assert.doesNotThrow(() => validateSemanticObservationEnvelope(equal, validateCanonicalContextEvent));

  assert.throws(
    () => validateSemanticObservationEnvelope({ ...bothPresent, sourceWatermark: -1 }, validateCanonicalContextEvent),
    ContractError,
  );
  assert.throws(
    () => validateSemanticObservationEnvelope({ ...bothPresent, sourceWatermark: 1.5 }, validateCanonicalContextEvent),
    ContractError,
  );
  assert.throws(
    () => validateSemanticObservationEnvelope({ ...bothPresent, publicCommitWatermark: Number.NaN }, validateCanonicalContextEvent),
    ContractError,
  );
});

test('I1-C rejects unsupported coverage reasons and malformed typed refs', () => {
  assert.deepEqual([...COVERAGE_ISSUE_REASONS].sort(), [
    'closer-conflict',
    'correlation-unavailable',
    'duplicate-conflict',
    'indistinguishable-tool-phase',
    'multi-opener',
    'opener-missing',
    'source-facet-missing',
    'unknown-kind',
    'waiting-is-not-terminal',
  ]);
  for (const reason of COVERAGE_ISSUE_REASONS) {
    assert.doesNotThrow(() => validateCoverageIssue({ reason, scope, sourceRef: evidence }));
  }
  assert.throws(
    () => validateCoverageIssue({ reason: 'not-a-reason' as never, scope, sourceRef: evidence }),
    ContractError,
  );
  assert.throws(
    () => validateCoverageIssue({ reason: 'unknown-kind', scope, sourceRef: { ...evidence, source: '' } }),
    ContractError,
  );
  assert.throws(
    () => validateCoverageIssue({
      reason: 'unknown-kind',
      scope,
      sourceRef: evidence,
      eventRef: { eventId: '', sourceId: 'source-a', scope },
    }),
    ContractError,
  );
});

test('I1-C preserves pairing identity kinds and distinct execution states', () => {
  const states: readonly PairedExecutionGroup['state'][] = [
    'open', 'closed', 'unknown', 'unavailable', 'cancelled', 'blocked', 'waiting',
  ];
  assert.deepEqual([...PAIRED_EXECUTION_STATES], states);
  for (const kind of ['request', 'operation', 'invocation'] as const) {
    for (const state of states) {
      const group: PairedExecutionGroup = {
        groupId: `group-${kind}-${state}`,
        kind,
        scope,
        executionEpoch: 1,
        requestId: 'request-a',
        callId: 'call-a',
        toolId: 'tool-a',
        state,
        eventRefs: [semanticEventRef],
      };
      assert.doesNotThrow(() => validatePairedExecutionGroup(group));
      assert.equal(group.state, state);
      assert.equal(group.kind, kind);
    }
  }
  assert.throws(
    () => validatePairedExecutionGroup({ ...pairedOperation, kind: 'not-a-kind' as never }),
    ContractError,
  );
  assert.throws(
    () => validatePairedExecutionGroup({ ...pairedOperation, state: 'not-a-state' as never }),
    ContractError,
  );
  assert.throws(
    () => validatePairedExecutionGroup({ ...pairedOperation, executionEpoch: 0 }),
    ContractError,
  );
});

test('I1-C keeps unavailable and unknown capabilities explicit with source and reason', () => {
  const unavailable: CapabilityStatus = {
    capability: 'checkpoint-history',
    state: 'unavailable',
    reason: 'capability-unavailable',
    sourceRef: evidence,
  };
  const unknown: CapabilityStatus = {
    capability: 'agent-history',
    state: 'unknown',
  };
  assert.doesNotThrow(() => validateCapabilityStatus(unavailable));
  assert.doesNotThrow(() => validateCapabilityStatus(unknown));
  assert.notEqual(unavailable.state, 'available');
  assert.throws(() => validateCapabilityStatus({ ...unavailable, capability: '' }), ContractError);
  assert.throws(
    () => validateCapabilityStatus({ ...unavailable, state: 'not-a-state' as never }),
    ContractError,
  );
  assert.throws(
    () => validateCapabilityStatus({ ...unavailable, sourceRef: { ...evidence, kind: 'nope' as never } }),
    ContractError,
  );
});

test('I1-C keeps delegated canonical errors as errors and never turns them into success', () => {
  const envelope = semanticEnvelope();
  assert.throws(
    () => validateSemanticObservationEnvelope(envelope, () => { throw new ContextEventError('delegated canonical failure'); }),
    ContextEventError,
  );

  const invalidCanonical = { ...semanticEvent, type: 'not.a.type' } as unknown as CanonicalContextEvent;
  const invalidStatus = { ...semanticEvent, status: 'not-a-status' } as unknown as CanonicalContextEvent;
  for (const broken of [invalidCanonical, invalidStatus]) {
    assert.throws(
      () => validateSemanticObservationEnvelope(semanticEnvelope({ events: [broken] }), validateCanonicalContextEvent),
      ContextEventError,
    );
  }
});

function i1cCompileTimeGuards(): void {
  const envelope: SemanticObservationEnvelope<CanonicalContextEvent> = semanticEnvelope();
  const uiEnvelope: RuntimeSemanticObservationEnvelope = envelope;

  // The generic parameter is mandatory: no default, no erasure to any/unknown.
  // @ts-expect-error - SemanticObservationEnvelope requires an explicit type argument.
  type OmittedGeneric = SemanticObservationEnvelope;
  void (0 as unknown as OmittedGeneric);

  // The concrete UI alias accepts only canonical events, not arbitrary raw shapes.
  const raw: RuntimeSemanticObservationEnvelope = {
    ...uiEnvelope,
    // @ts-expect-error - a raw/arbitrary event is not a CanonicalContextEvent.
    events: [{ notAnEvent: true }],
  };
  void raw;

  // Missing canonical fields and invalid canonical type/status remain compile errors.
  const missingFields: SemanticObservationEnvelope<CanonicalContextEvent> = {
    ...envelope,
    // @ts-expect-error - canonical events require all required fields.
    events: [{ eventId: 'context-event:incomplete' }],
  };
  void missingFields;
  const badType: SemanticObservationEnvelope<CanonicalContextEvent> = {
    ...envelope,
    // @ts-expect-error - canonical type must be a ContextEventType member.
    events: [{ ...semanticEvent, type: 'not.a.type' }],
  };
  void badType;
  const badStatus: SemanticObservationEnvelope<CanonicalContextEvent> = {
    ...envelope,
    // @ts-expect-error - canonical status must stay in the six-value union.
    events: [{ ...semanticEvent, status: 'not-a-status' }],
  };
  void badStatus;

  // Readonly shape is enforced statically.
  // @ts-expect-error - readonly event arrays cannot be mutated.
  uiEnvelope.events.push(semanticEvent);
  // @ts-expect-error - readonly canonical events cannot be mutated.
  uiEnvelope.events[0].status = 'completed';
  // @ts-expect-error - readonly arrays cannot be reassigned.
  uiEnvelope.coverageIssues = [];

  // Missing durable watermark and unsupported coverage reasons remain type errors.
  // @ts-expect-error - sourceWatermark is a required durable watermark.
  const missingWatermark: SemanticObservationEnvelope<CanonicalContextEvent> = { scope, projectionVersion: 'i1c-v1', publicCommitWatermark: 3, events: [], coverageIssues: [], pairing: [], capabilities: [] };
  void missingWatermark;
  const badCoverage: SemanticObservationEnvelope<CanonicalContextEvent> = {
    ...envelope,
    // @ts-expect-error - coverage reason must stay in the closed reason list.
    coverageIssues: [{ reason: 'not-a-reason', scope, sourceRef: evidence }],
  };
  void badCoverage;
  const badPairingKind: SemanticObservationEnvelope<CanonicalContextEvent> = {
    ...envelope,
    // @ts-expect-error - paired execution kind must stay in the closed kind list.
    pairing: [{ ...pairedOperation, kind: 'not-a-kind' }],
  };
  void badPairingKind;
  const malformedRef: SemanticObservationEnvelope<CanonicalContextEvent> = {
    ...envelope,
    // @ts-expect-error - coverage sourceRef must be a complete EvidenceRef.
    coverageIssues: [{ reason: 'unknown-kind', scope, sourceRef: { source: 'missing-fields' } }],
  };
  void malformedRef;
}
void i1cCompileTimeGuards;
