import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  ContractError, assertAgentRuntimeId, assertBusinessPayload, assertCapabilities, assertCheckpointLink, assertContextBudget, assertExecutionEpoch,
  assertNotExpired, assertPermissionRevisionMatches, assertProviderBindingMatch, assertProviderEventEpoch, assertProviderExecutionIdentityMatch, assertProviderReadinessBinding,
  assertScopeAcl,
  assertSameScope, assertScope, checkProviderEventEpoch, checkScopeAcl, consumerKey, id, occurrenceIdempotencyKey, runtimeId,
  validateAgentCloseReceipt, validateAgentDispatchReceipt, validateAgentDriverReceipt, validateAgentObservationEvent, validateAgentReconcileResult,
  validateAgentRequestEnvelope, validateAgentResult, validateAgentSettleReceipt, validateAgentStopReceipt,
  validateAcpDriverBinding, validateAcpServerBinding, validateAgentMessageEnvelope, validateAgentProviderBinding, validateAgentRequestControl,
  validateCheckpointClosureRecord, validateCheckpointReentryRecord, validateControlProbeRecord, validateControlWatchdogPolicy, validateInteractionClosure,
  validateEventConsumerCursor, validateEventConsumerReceipt, validateEventHandlerCommit, validateEventRetryObligation, validateExecutionBinding,
  validateGoalRecord, validateOccurrence, validateProviderBinding, validateProviderCapabilities,
  validateCanonicalMemoryScope, validateMemoryActor, validateMemoryBinding, validateMemoryCurationResult, validateMemoryFollowUpRequest,
  validateMemoryForgettingPlan, validateMemoryForgettingRequest, validateMemoryPromotionReceipt, validateMemoryQueryRequest, validateMemoryRecallRequest,
  validateMemoryReviewReceipt, validateMemorySubmission, validateProjectSourceUpdateProposal,
  validateAuditPromptSnapshot, validateEpisodicMemorySource, validateProceduralMemoryCandidate, validateSemanticMemoryCandidate,
  validateProviderCloseResult, validateProviderError, validateProviderEvent, validateProviderReadiness, validateProviderRecoveryResult, validateProviderResumeInput,
  validateProviderSettleInput, validateProviderSettlement, validateProviderStartInput, validateProviderStartReceipt, validateProviderStopReceipt,
  validateProviderStopRequest, validateProviderSubmitInput, validateProviderSubmitResult, validateProviderToolResult, validateRequirementEnvelope,
  validateReminder, validateRuntimeBinding, validateSchedulerLease, validateScopeAcl, validateSubscription,
  validateWorkAssignment, validateWorkResult, type AgentMemoryContext, type AgentDriver, type AgentMemoryContextInjectionPort, type AgentRuntimeId,
  type AgentDriverV1, type AgentRequestEnvelope, type AcpDriverBinding, type AcpServerBinding, type AgentMessageEnvelope, type AgentProviderBinding, type BusinessPayload, type Checkpoint,
  type CheckpointClosureRecord, type CheckpointReentryRecord, type EventConsumerCursor, type EventConsumerReceipt, type EventRetryObligation,
  type ExecutionBinding, type ExecutionRuntimePort, type GoalRecord, type HarnessPluginContext, type MemoryOperationsPort, type NoveltyResult,
  type MemoryActorContext, type MemoryCurationResult, type MemoryForgettingPlan, type MemoryPromotionReceipt, type MemoryQueryRequest,
  type MemoryReviewReceipt, type MemorySubmission, type ProceduralMemoryCandidate, type ProjectSourceUpdateProposal, type SemanticMemoryCandidate,
  type InteractionClosure,
  type Occurrence, type Reminder, type RuntimeBinding, type SchedulerLease, type ScopeAcl, type Subscription,
  type ProviderBinding, type ProviderCapabilities, type ProviderCloseResult, type ProviderError, type ProviderEvent, type ProviderReadiness,
  type ProviderRecoveryResult, type ProviderResumeInput, type ProviderSettlement, type ProviderStartInput, type ProviderStartReceipt, type ProviderStopReceipt,
  type ProviderStopRequest, type ProviderSubmitInput, type ProviderSubmitResult, type ProviderToolResult, type RecurrenceResult,
  type RequirementEnvelope, type ScopeRef, type WorkAssignment, type WorkResult,
} from '@humanagent/contracts';

const memoryActor = (overrides: Partial<MemoryActorContext> = {}): MemoryActorContext => ({
  actorId: 'actor-a',
  roleId: 'memory',
  permissions: ['memory.read', 'memory.propose'],
  projectKey: 'project-a',
  ...overrides,
});

const semanticCandidate = (overrides: Partial<SemanticMemoryCandidate> = {}): SemanticMemoryCandidate => ({
  candidateId: 'semantic-a',
  namespace: 'project',
  projectKey: 'project-a',
  statement: 'checkpoint settles before journal commit',
  entities: ['checkpoint', 'journal'],
  sourceRefs: ['journal://project-a/1'],
  sourceDigests: ['sha256:source-a'],
  confidence: 'supported',
  validity: { kind: 'open' },
  review: 'required',
  ...overrides,
});

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: ScopeRef = { organId: organ, taskId: task };
const operation = id('operation', 'operation-a');
const proceduralCandidate = (overrides: Partial<ProceduralMemoryCandidate> = {}): ProceduralMemoryCandidate => ({
  candidateId: 'procedural-a',
  namespace: 'project',
  projectKey: 'project-a',
  name: 'checkpoint recovery',
  intent: 'recover a checkpoint',
  preconditions: ['journal is valid'],
  steps: ['read checkpoint', 'reconcile operation'],
  failureBoundaries: ['unknown side effect'],
  successEvidenceRefs: ['journal://project-a/2'],
  repeatability: 'recurring',
  review: 'required',
  ...overrides,
});
const memorySubmission = (overrides: Partial<MemorySubmission> = {}): MemorySubmission => ({
  submissionId: 'submission-a',
  requestId: 'request-a',
  operationId: operation,
  bindingRef: 'binding-a',
  actor: memoryActor(),
  projectKey: 'project-a',
  taskId: task,
  cycleId: id('cycle', 'cycle-a'),
  requestedKind: 'semantic',
  candidateCategory: 'project-fact',
  contentRef: 'asset://memory/candidate-a',
  contentDigest: 'sha256:candidate-a',
  evidenceRefs: ['journal://project-a/1'],
  observation: 'the checkpoint commit is durable',
  desiredScope: 'project',
  reason: 'observed at a lifecycle boundary',
  inputDigest: 'sha256:input-a',
  ...overrides,
});
const memoryQuery = (overrides: Partial<MemoryQueryRequest> = {}): MemoryQueryRequest => ({
  requestId: 'query-a',
  operationId: operation,
  bindingRef: 'binding-a',
  actor: memoryActor(),
  projectKey: 'project-a',
  namespace: 'project',
  taskId: task,
  query: 'checkpoint',
  kinds: ['semantic'],
  states: ['approved', 'active'],
  limit: 10,
  tokenBudget: 100,
  inputDigest: 'sha256:query-a',
  ...overrides,
});
const operationScope: ScopeRef = { ...scope, operationId: operation };
const checkpoint = (seq: number, previousCheckpointId: Checkpoint['previousCheckpointId']): Checkpoint => ({
  id: id('checkpoint', `cp-${seq}`), scope, cycleId: id('cycle', 'cycle-a'), seq, previousCheckpointId,
  directiveRevision: 1, executionEpoch: 1, outcome: 'waiting', summary: 'fixture',
  recoveryStateRef: { evidenceId: id('evidence', `ev-${seq}`), kind: 'operation', source: 'test', locator: `fixture-${seq}`, scope },
  evidenceRefs: [], next: { kind: 'wait', ref: 'condition-a' },
});
const assignment: WorkAssignment = {
  assignmentId: 'assignment-a', taskId: task, pipelineNodeId: 'node-a', attempt: 1, executionEpoch: 1, inputRevision: 1,
  objective: 'inspect fixture', targetRefs: ['target-a'], expectedOutputRefs: ['output-a'], expectedArtifactDigests: ['sha256:artifact-a'], acceptanceCriteriaDigest: 'sha256:a',
  successCriteria: ['output exists'], failureCriteria: ['input unavailable'], incompleteCriteria: ['needs review'], requiredCapabilities: ['inspect'], mergeGate: 'not-required',
};
const successfulResult = (overrides: Partial<WorkResult> = {}): WorkResult => ({
  ...assignment, agentId: 'agent-a', producedArtifactRefs: ['artifact-a'], producedArtifactDigests: ['sha256:artifact-a'],
  status: 'succeeded', summary: 'done', outputRefs: ['output-a'], evidenceRefs: [], nextAction: 'settle', ...overrides,
});

const runtime = runtimeId('runtime-a');
const providerEvidence = (label: string): ProviderReadiness['evidenceRefs'][number] => ({
  evidenceId: id('evidence', `ev-provider-${label}`), kind: 'execution', source: 'test-provider', locator: label, scope: operationScope,
});
const externalEvidence = (): ProviderReadiness['evidenceRefs'][number] => ({
  evidenceId: id('evidence', 'ev-external'), kind: 'external', source: 'test-provider', locator: 'external-exec', scope: operationScope,
});
const providerError = (overrides: Partial<ProviderError> = {}): ProviderError => ({
  errorId: 'provider-error-1', code: 'provider.failure', category: 'provider', phase: 'submit', message: 'provider failed',
  ownerId: 'provider-adapter', retryable: 'manual', attention: 'foreground', evidenceRefs: [providerEvidence('error')],
  nextAction: { kind: 'recover', ref: 'provider-adapter' }, ...overrides,
});
const providerBinding = (overrides: Partial<ProviderBinding> = {}): ProviderBinding => ({
  bindingId: 'binding-a', providerId: 'cc', protocol: 'responses', endpointRef: 'local-rcc-endpoint', modelRef: 'model-a',
  configDigest: 'sha256:config-a', capabilityDigest: 'sha256:capability-a', ...overrides,
});
const readiness = (overrides: Partial<ProviderReadiness> = {}): ProviderReadiness => ({
  bindingId: providerBinding().bindingId, providerId: providerBinding().providerId, protocol: providerBinding().protocol,
  state: 'ready', capabilityDigest: 'sha256:capability-a', checkedAt: '2026-09-13T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
  evidenceRefs: [providerEvidence('ready')], ...overrides,
});
const capabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  bindingId: providerBinding().bindingId, providerId: providerBinding().providerId, protocol: providerBinding().protocol,
  capabilities: ['responses'], version: '0.1.0', digest: 'sha256:capability-a', checkedAt: '2026-09-13T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z', evidenceRefs: [providerEvidence('capabilities')], ...overrides,
});
const executionIdentity = {
  runtimeId: runtime, taskId: task, operationId: operation, executionEpoch: 1,
};
const startInput = (overrides: Partial<ProviderStartInput> = {}): ProviderStartInput => ({
  ...executionIdentity, inputRefs: ['input-a'], evidenceRefs: [providerEvidence('start')], ...overrides,
});
const resumeInput = (overrides: Partial<ProviderResumeInput> = {}): ProviderResumeInput => ({
  ...startInput(), checkpointId: id('checkpoint', 'cp-provider'), checkpointExecutionEpoch: 1, ...overrides,
});
const submitInput = (overrides: Partial<ProviderSubmitInput> = {}): ProviderSubmitInput => ({
  ...executionIdentity, inputRefs: ['input-b'], evidenceRefs: [providerEvidence('submit')], payload: { question: 'continue' }, ...overrides,
});
const startReceipt = (overrides: Partial<ProviderStartReceipt> = {}): ProviderStartReceipt => ({
  ...executionIdentity, startedAt: '2026-09-13T00:00:00Z', evidenceRefs: [providerEvidence('start-receipt')],
  externalExecutionRef: externalEvidence(), ...overrides,
});
const recoveryResult = (overrides: Partial<ProviderRecoveryResult> = {}): ProviderRecoveryResult => ({
  ...executionIdentity, checkpointId: id('checkpoint', 'cp-provider'), recovered: true, staleRejected: false,
  recoveryStateRef: providerEvidence('recovery-state'), evidenceRefs: [providerEvidence('recovery')], ...overrides,
});
const submitResult = (overrides: Partial<ProviderSubmitResult> = {}): ProviderSubmitResult => ({
  ...executionIdentity, status: 'completed', outputRefs: ['output-a'], evidenceRefs: [providerEvidence('submit-result')],
  payload: { answer: 'ok' }, ...overrides,
});
const providerEvent = (overrides: Partial<ProviderEvent> = {}): ProviderEvent => ({
  ...executionIdentity, eventId: 'event-a', kind: 'model', evidenceRefs: [providerEvidence('event')], ...overrides,
});
const toolResult = (overrides: Partial<ProviderToolResult> = {}): ProviderToolResult => ({
  ...executionIdentity, toolId: 'tool-a', callId: 'call-a', status: 'succeeded', outputRefs: ['tool-output-a'],
  evidenceRefs: [providerEvidence('tool')], ...overrides,
});
const stopRequest = (overrides: Partial<ProviderStopRequest> = {}): ProviderStopRequest => ({
  ...executionIdentity, reason: 'operator stop', ownerId: 'stop-controller', evidenceRefs: [providerEvidence('stop-request')], ...overrides,
});
const stopReceipt = (overrides: Partial<ProviderStopReceipt> = {}): ProviderStopReceipt => ({
  ...executionIdentity, status: 'accepted', receivedAt: '2026-09-13T00:00:00Z', evidenceRefs: [providerEvidence('stop-receipt')], ...overrides,
});
const settlement = (overrides: Partial<ProviderSettlement> = {}): ProviderSettlement => ({
  ...executionIdentity, state: 'succeeded', evidenceRefs: [providerEvidence('settle')],
  resourceRelease: { state: 'released', evidenceRefs: [providerEvidence('resource')] },
  persistence: { state: 'committed', evidenceRefs: [providerEvidence('persistence')] }, ...overrides,
});
const closeResult = (overrides: Partial<ProviderCloseResult> = {}): ProviderCloseResult => ({
  bindingId: providerBinding().bindingId, providerId: providerBinding().providerId, protocol: providerBinding().protocol,
  state: 'closed', evidenceRefs: [providerEvidence('close')], ...overrides,
});
const providerPort: ExecutionRuntimePort = {
  kind: 'humanagent.execution-runtime-port',
  probe: async (binding) => readiness({ bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol }),
  capabilities: async (binding) => capabilities({ bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol }),
  start: async (input) => startReceipt({ runtimeId: input.runtimeId, taskId: input.taskId, operationId: input.operationId, executionEpoch: input.executionEpoch }),
  resume: async (input) => recoveryResult({ runtimeId: input.runtimeId, taskId: input.taskId, operationId: input.operationId, executionEpoch: input.executionEpoch, checkpointId: input.checkpointId }),
  submit: async (input) => submitResult({ runtimeId: input.runtimeId, taskId: input.taskId, operationId: input.operationId, executionEpoch: input.executionEpoch }),
  observe: async function* () { yield providerEvent(); },
  requestStop: async (input) => stopReceipt({ runtimeId: input.runtimeId, taskId: input.taskId, operationId: input.operationId, executionEpoch: input.executionEpoch }),
  settle: async (input) => settlement({ runtimeId: input.runtimeId, taskId: input.taskId, operationId: input.operationId, executionEpoch: input.executionEpoch }),
  close: async (binding) => closeResult({ bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol }),
};

test('positive minimum fixtures validate', () => {
  assert.doesNotThrow(() => validateWorkAssignment(assignment));
  assert.doesNotThrow(() => validateWorkResult(successfulResult(), assignment));
  assert.doesNotThrow(() => assertCheckpointLink(checkpoint(1, null), null));
});

test('rejects illegal scopes and epochs', () => {
  assert.throws(() => id('task', ''), ContractError);
  assert.throws(() => assertScope(id('cycle', 'cycle-a'), 'task'), ContractError);
  assert.throws(() => assertExecutionEpoch(0), ContractError);
  assert.throws(() => assertExecutionEpoch(-1), ContractError);
  assert.throws(() => assertNotExpired('2000-01-01T00:00:00Z'), ContractError);
});

test('rejects broken checkpoint predecessor chains', () => {
  const first = checkpoint(1, null);
  assert.throws(() => assertCheckpointLink(checkpoint(3, first.id), first), ContractError);
  assert.throws(() => assertCheckpointLink(checkpoint(2, id('checkpoint', 'missing')), first), ContractError);
  assert.throws(() => assertCheckpointLink({ ...checkpoint(1, null), executionEpoch: 0 }, null), ContractError);
  assert.throws(() => assertCheckpointLink({ ...checkpoint(1, null), executionEpoch: NaN }, null), ContractError);
  for (const seq of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertCheckpointLink({ ...checkpoint(seq, null), id: id('checkpoint', 'invalid-current') }, null), ContractError);
    assert.throws(() => assertCheckpointLink(checkpoint(2, first.id), { ...first, seq }), ContractError);
  }
});

test('rejects undeclared capabilities and over-budget context', () => {
  assert.throws(() => assertCapabilities(['inspect', 'write'], ['inspect']), ContractError);
  const context: AgentMemoryContext = { contextId: 'ctx-a', executionEpoch: 1, entries: [{ layer: 'current', summary: 'x', sourceRef: 'src', sourceDigest: 'sha256:x', scope: 'task', tokenCost: 9 }], omitted: [] };
  assert.throws(() => assertContextBudget(context, 8), ContractError);
  for (const tokenCost of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => assertContextBudget({ ...context, entries: [{ ...context.entries[0], tokenCost }] }, 10), ContractError);
  }
  for (const budget of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => assertContextBudget(context, budget), ContractError);
  }
});

test('rejects control fields in business payloads recursively', () => {
  assert.throws(() => assertBusinessPayload({ answer: 'ok', steer: true }), ContractError);
  assert.throws(() => assertBusinessPayload({ nested: { steer: true } }), ContractError);
  assert.throws(() => assertBusinessPayload({ nested: [{ executionEpoch: 1 }] }), ContractError);
  for (const field of ['retry', 'degrade', 'continuation', 'health', 'debug', 'checkpoint', 'operationId'] as const) {
    assert.throws(() => assertBusinessPayload({ [field]: true }), ContractError);
  }
  assert.doesNotThrow(() => assertBusinessPayload({ nested: { steerFaith: 'not-control' }, list: [{ checkpointAt: 'not-control' }] }));
  const cyclic = {} as Record<string, unknown>;
  cyclic.self = cyclic;
  assert.throws(() => assertBusinessPayload(cyclic as BusinessPayload), ContractError);
});

test('validates requirement payload references, revisions, FIFO sequence, and confirmation time', () => {
  const envelope: RequirementEnvelope = {
    requirementId: 'r', draftId: 'd', inputRevision: 1, intent: 'create', normalizedInput: 'new task',
    confirmedBy: 'human', confirmedAt: '2026-09-11T00:00:00Z', fifoSeq: 1, payloadRef: 'asset://requirements/r-1',
  };
  assert.doesNotThrow(() => validateRequirementEnvelope(envelope));
  for (const payloadRef of ['', '   ']) {
    assert.throws(() => validateRequirementEnvelope({ ...envelope, payloadRef }), ContractError);
  }
  for (const inputRevision of [NaN, Infinity, 1.5, 0]) {
    assert.throws(() => validateRequirementEnvelope({ ...envelope, inputRevision }), ContractError);
  }
  for (const fifoSeq of [NaN, Infinity, 1.5, 0]) {
    assert.throws(() => validateRequirementEnvelope({ ...envelope, fifoSeq }), ContractError);
  }
  for (const confirmedAt of ['', 'not-a-time']) {
    assert.throws(() => validateRequirementEnvelope({ ...envelope, confirmedAt }), ContractError);
  }
});

test('rejects invalid assignment and result input/output', () => {
  assert.throws(() => validateWorkAssignment({ ...assignment, executionEpoch: 0 }), ContractError);
  for (const attempt of [NaN, Infinity, 1.5, 0]) {
    assert.throws(() => validateWorkAssignment({ ...assignment, attempt }), ContractError);
  }
  for (const inputRevision of [NaN, Infinity, 1.5, 0]) {
    assert.throws(() => validateWorkAssignment({ ...assignment, inputRevision }), ContractError);
  }
  assert.throws(() => validateWorkResult({ ...successfulResult(), executionEpoch: 2 }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), agentId: ' ' }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), outputRefs: ['unrelated-output'] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), outputRefs: ['output-a', 'unrelated-output'] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), producedArtifactDigests: [] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), producedArtifactDigests: ['sha256:other'] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), producedArtifactRefs: [''] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult({ status: 'incomplete', outputRefs: [] }), producedArtifactRefs: ['artifact-a'], producedArtifactDigests: [] }, assignment), ContractError);
  assert.throws(() => validateWorkResult(successfulResult({ status: 'blocked', outputRefs: [], producedArtifactRefs: ['artifact-a'], producedArtifactDigests: [''] }), assignment), ContractError);
  assert.throws(() => validateWorkResult(successfulResult({ status: 'cancelled', outputRefs: [], producedArtifactRefs: ['artifact-a'], producedArtifactDigests: ['sha256:other'] }), assignment), ContractError);
  assert.doesNotThrow(() => validateWorkResult(successfulResult({ status: 'incomplete', outputRefs: [], producedArtifactRefs: ['artifact-a'], producedArtifactDigests: ['sha256:artifact-a'] }), assignment));
  assert.throws(() => validateWorkResult({ ...assignment, agentId: 'agent-a', producedArtifactRefs: [], producedArtifactDigests: [], status: 'blocked', summary: 'paused', outputRefs: [], evidenceRefs: [], nextAction: 'wait' }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...assignment, assignmentId: 'other', agentId: 'agent-a', producedArtifactRefs: [], producedArtifactDigests: [], status: 'failed', summary: 'failed', outputRefs: [], evidenceRefs: [], nextAction: 'attention', failureRef: 'failure-a' }, assignment), ContractError);
});

test('checkpoint links allow operation-bearing stops after business checkpoints and keep strict scope checks', async () => {
  const first = checkpoint(1, null);
  assert.doesNotThrow(() => assertCheckpointLink({ ...checkpoint(1, null), scope: operationScope }, null));
  assert.doesNotThrow(() => assertCheckpointLink({ ...checkpoint(2, first.id), scope: operationScope, outcome: 'stopped', next: { kind: 'stop', ref: 'stopped' } }, first));
  assert.throws(() => assertCheckpointLink({ ...checkpoint(2, first.id), scope: operationScope }, first), ContractError);
  const operationFirst = { ...checkpoint(1, null), scope: operationScope };
  assert.throws(() => assertCheckpointLink({
    ...checkpoint(2, operationFirst.id),
    scope: { ...scope, operationId: id('operation', 'operation-b') },
    outcome: 'stopped',
    next: { kind: 'stop', ref: 'stopped' },
  }, operationFirst), ContractError);
  assert.throws(() => assertSameScope(scope, operationScope), ContractError);
  for (const mismatch of [
    { ...scope, organId: id('organ', 'organ-b') },
    { ...scope, taskId: id('task', 'task-b') },
    { ...scope, cycleId: id('cycle', 'cycle-b') },
  ]) {
    assert.throws(() => assertCheckpointLink({ ...checkpoint(2, first.id), scope: mismatch }, first), ContractError);
  }
  const registered: { drivers: AgentDriver[]; memory: MemoryOperationsPort[]; context: AgentMemoryContextInjectionPort[] } = { drivers: [], memory: [], context: [] };
  const context: HarnessPluginContext = {
    registerCapability: () => undefined,
    registerAgentDriver: (driver) => registered.drivers.push(driver),
    registerMemoryOperations: (port) => registered.memory.push(port),
    registerAgentMemoryContextInjection: (port) => registered.context.push(port),
  };
  const driver = {} as AgentDriver;
  const injection = {} as AgentMemoryContextInjectionPort;
  const novelty: NoveltyResult = { classification: 'variant', matchedRefs: ['memory-a'], reason: 'same operation family' };
  const recurrence: RecurrenceResult = { classification: 'recurring', occurrences: [{ ref: 'memory-a', digest: 'sha256:memory-a' }], reason: 'seen twice' };
  const memory: MemoryOperationsPort = {
    ingest: async (input) => ({ sourceRef: input.sourceRef }),
    search: async () => [{ sourceRef: 'memory-a', summary: 'fixture' }],
    inspect: async (input) => ({ sourceRef: input.sourceRef, sourceDigest: 'sha256:memory-a', text: 'fixture' }),
    compare: async () => ({ relation: 'same' }),
    detectNovelty: async () => novelty,
    detectRecurrence: async () => recurrence,
    query: async (input) => ({ requestId: input.requestId, status: 'ready', entries: [], sourceFactRef: 'memory-query-a', omitted: [] }),
    submitCandidate: async (input) => ({ submissionId: input.submissionId, status: 'accepted', nextAction: 'wait-analysis' }),
    reviewCandidate: async (input) => input,
    promoteCandidate: async (input) => input,
    planForgetting: async (input) => input.plan,
  };
  context.registerAgentDriver(driver);
  context.registerMemoryOperations(memory);
  context.registerAgentMemoryContextInjection(injection);
  assert.deepEqual(registered, { drivers: [driver], memory: [memory], context: [injection] });
  assert.deepEqual(await memory.detectNovelty({ scope: { kind: 'task', organId: organ, taskId: task }, sourceRef: 'source-a', sourceDigest: 'sha256:source-a', candidateRef: 'candidate-a', comparisonRefs: ['memory-a'], limit: 10 }), novelty);
  assert.deepEqual(await memory.detectRecurrence({ scope: { kind: 'task', organId: organ, taskId: task }, patternRef: 'pattern-a', windowRefs: ['memory-a'], limit: 10 }), recurrence);
});

test('provider-neutral execution runtime fixtures validate and expose a typed fake port', async () => {
  const providerErrorValue = providerError();
  assert.doesNotThrow(() => assertAgentRuntimeId(runtime));
  assert.throws(() => assertAgentRuntimeId(' '), ContractError);
  assert.doesNotThrow(() => validateProviderBinding(providerBinding()));
  assert.doesNotThrow(() => validateExecutionBinding({ runtimeId: runtime, provider: providerBinding(), externalExecutionRef: externalEvidence() } satisfies ExecutionBinding));
  assert.doesNotThrow(() => validateProviderReadiness(readiness()));
  assert.doesNotThrow(() => validateProviderCapabilities(capabilities()));
  validateProviderStartInput(startInput());
  validateProviderResumeInput(resumeInput());
  validateProviderSubmitInput(submitInput());
  validateProviderSettleInput(executionIdentity);
  validateProviderStartReceipt(startReceipt());
  validateProviderRecoveryResult(recoveryResult());
  validateProviderSubmitResult(submitResult());
  validateProviderEvent(providerEvent());
  validateProviderEvent(providerEvent({ kind: 'terminal', terminalState: 'succeeded', ownerId: 'runtime', nextAction: { kind: 'continue' } }));
  validateProviderToolResult(toolResult());
  validateProviderStopRequest(stopRequest());
  validateProviderStopReceipt(stopReceipt());
  validateProviderSettlement(settlement());
  validateProviderCloseResult(closeResult());
  assert.doesNotThrow(() => validateProviderError(providerErrorValue));
  const probe = await providerPort.probe(providerBinding());
  const started = await providerPort.start(startInput());
  const recovered = await providerPort.resume(resumeInput());
  const submitted = await providerPort.submit(submitInput());
  const settled = await providerPort.settle(executionIdentity);
  const closed = await providerPort.close(providerBinding());
  assert.equal(probe.state, 'ready');
  assert.equal(started.operationId.value, operation.value);
  assert.equal(recovered.checkpointId.value, 'cp-provider');
  assert.equal(submitted.status, 'completed');
  assert.equal(settled.state, 'succeeded');
  assert.equal(closed.state, 'closed');
});

test('provider execution identity carries and matches HumanAgent organ and cycle scope', () => {
  const organ = id('organ', 'organ-provider');
  const cycle = id('cycle', 'cycle-provider');
  const identity = { ...executionIdentity, organId: organ, cycleId: cycle };
  assert.doesNotThrow(() => validateProviderStartInput({ ...startInput(), ...identity }));
  assert.doesNotThrow(() => assertProviderExecutionIdentityMatch(identity, identity));
  assert.throws(
    () => assertProviderExecutionIdentityMatch({ ...identity, organId: id('organ', 'other-organ') }, identity),
    ContractError,
  );
  assert.throws(
    () => assertProviderExecutionIdentityMatch({ ...identity, cycleId: id('cycle', 'other-cycle') }, identity),
    ContractError,
  );
});

test('rejects invalid provider binding identity and missing required binding data', () => {
  assert.throws(() => validateProviderBinding({ ...providerBinding(), bindingId: '   ' }), ContractError);
  assert.doesNotThrow(() => validateProviderBinding({ ...providerBinding(), protocol: 'openai' }));
  for (const field of ['endpointRef', 'modelRef', 'configDigest', 'capabilityDigest'] as const) {
    const invalid = { ...providerBinding() } as Partial<ProviderBinding>;
    delete invalid[field];
    assert.throws(() => validateProviderBinding(invalid as ProviderBinding), ContractError);
  }
});

test('rejects external evidence used as runtime identity and binding identity mismatch', () => {
  assert.throws(() => validateExecutionBinding({
    runtimeId: runtimeId('external-exec'),
    provider: providerBinding(),
    externalExecutionRef: externalEvidence(),
  }), ContractError);
  assert.doesNotThrow(() => assertProviderReadinessBinding(readiness(), providerBinding()));
  assert.throws(() => assertProviderReadinessBinding({ ...readiness(), protocol: 'anthropic' }, providerBinding()), ContractError);
  assert.throws(() => assertProviderReadinessBinding({ ...readiness(), capabilityDigest: 'sha256:capability-b' }, providerBinding()), ContractError);
  assert.throws(() => validateProviderReadiness({ ...readiness(), evidenceRefs: [] }), ContractError);
  assert.throws(() => validateProviderCapabilities({ ...capabilities(), evidenceRefs: [] }), ContractError);
  assert.throws(() => assertProviderBindingMatch(providerBinding(), { providerId: 'cc-sol', protocol: 'responses' }), ContractError);
  assert.throws(() => assertProviderBindingMatch(providerBinding(), { bindingId: 'binding-b', protocol: 'responses' }), ContractError);
});

test('rejects stale execution epoch events before they advance runtime', () => {
  const stale = checkProviderEventEpoch(providerEvent({ executionEpoch: 1 }), 2);
  assert.equal(stale.accepted, false);
  if (!stale.accepted) assert.equal(stale.reason, 'stale');
  assert.throws(() => assertProviderEventEpoch(providerEvent({ executionEpoch: 1 }), 2), ContractError);
  assert.throws(() => validateProviderResumeInput({ ...resumeInput(), checkpointExecutionEpoch: 2 }), ContractError);
  assert.throws(() => validateProviderResumeInput({ ...resumeInput(), checkpointExecutionEpoch: 0 }), ContractError);
  assert.throws(() => validateProviderRecoveryResult({ ...recoveryResult(), recovered: true, staleRejected: true, rejectedEpoch: 1 }), ContractError);
  assert.throws(() => validateProviderRecoveryResult({ ...recoveryResult(), staleRejected: true, rejectedEpoch: NaN }), ContractError);
  assert.throws(() => validateProviderRecoveryResult({ ...recoveryResult(), recovered: true, error: providerError() }), ContractError);
  assert.throws(() => validateProviderRecoveryResult({ ...recoveryResult(), recovered: true, rejectedEpoch: 1 }), ContractError);
  assert.throws(() => validateProviderRecoveryResult({ ...recoveryResult(), recovered: false, staleRejected: false, error: providerError() }), ContractError);
  assert.throws(() => validateProviderRecoveryResult({ ...recoveryResult(), recovered: false, staleRejected: true, rejectedEpoch: 1, error: providerError() }), ContractError);
  assert.doesNotThrow(() => validateProviderRecoveryResult(recoveryResult()));
  assert.doesNotThrow(() => validateProviderRecoveryResult({
    ...recoveryResult({ recovered: false, staleRejected: false, error: providerError() }),
    ownerId: 'provider-adapter',
    nextAction: { kind: 'recover', ref: 'provider-adapter' },
  }));
  assert.doesNotThrow(() => validateProviderRecoveryResult({
    ...recoveryResult({ recovered: false, staleRejected: true, rejectedEpoch: 1, error: providerError() }),
    ownerId: 'provider-adapter',
    nextAction: { kind: 'recover', ref: 'provider-adapter' },
  }));
  assert.deepEqual(checkProviderEventEpoch(providerEvent({ executionEpoch: 2 }), 2), { accepted: true });
  const mismatch = checkProviderEventEpoch(providerEvent({ executionEpoch: 3 }), 2);
  assert.equal(mismatch.accepted, false);
  if (!mismatch.accepted) assert.equal(mismatch.reason, 'future');
  assert.throws(() => assertProviderExecutionIdentityMatch(providerEvent({ taskId: id('task', 'task-b') }), executionIdentity), ContractError);
});

test('stop receipt alone is not a stopped settlement', () => {
  const receipt = stopReceipt();
  validateProviderStopReceipt(receipt);
  assert.equal((receipt as unknown as Record<string, unknown>).state, undefined);
  assert.equal((receipt as unknown as Record<string, unknown>).settled, undefined);
  assert.throws(() => validateProviderSettlement(receipt as unknown as ProviderSettlement), ContractError);
  assert.throws(() => validateProviderStopReceipt({ ...receipt, status: 'stopped' } as unknown as ProviderStopReceipt), ContractError);
  assert.throws(() => validateProviderStopReceipt({ ...receipt, state: 'stopped' } as unknown as ProviderStopReceipt), ContractError);
});

test('settle requires settlement evidence and resource/persistence results', () => {
  assert.throws(() => validateProviderSettlement({ ...settlement(), evidenceRefs: [] }), ContractError);
  assert.throws(() => validateProviderSettlement({ ...settlement(), resourceRelease: { state: 'released', evidenceRefs: [] } }), ContractError);
  assert.throws(() => validateProviderSettlement({ ...settlement(), persistence: { state: 'committed', evidenceRefs: [] } }), ContractError);
  assert.throws(() => validateProviderSettlement({ ...settlement(), resourceRelease: { state: 'pending', evidenceRefs: [providerEvidence('resource')] } }), ContractError);
  assert.throws(() => validateProviderSettlement({ ...settlement(), persistence: { state: 'pending', evidenceRefs: [providerEvidence('persistence')] } }), ContractError);
  assert.throws(() => validateProviderSettlement({ ...settlement({ state: 'cancelled' }), resourceRelease: { state: 'pending', evidenceRefs: [providerEvidence('cancelled-resource')] } }), ContractError);
  assert.throws(() => validateProviderSettlement({ ...settlement({ state: 'cancelled' }), persistence: { state: 'pending', evidenceRefs: [providerEvidence('cancelled-persistence')] } }), ContractError);
  assert.doesNotThrow(() => validateProviderSettlement({ ...settlement({ state: 'cancelled' }) }));
  const failed = settlement({
    state: 'failed',
    error: providerError(),
    evidenceRefs: [providerEvidence('failed-settle')],
    resourceRelease: { state: 'failed', evidenceRefs: [providerEvidence('failed-resource')], failure: providerError({ phase: 'settle', code: 'resource.failure' }) },
    persistence: { state: 'committed', evidenceRefs: [providerEvidence('failed-persistence')] },
  });
  assert.doesNotThrow(() => validateProviderSettlement(failed));
  assert.throws(() => validateProviderSettlement({ ...settlement(), state: 'failed', error: undefined }), ContractError);
});

test('settlement completion evidence is bound to the settlement execution scope', () => {
  assert.doesNotThrow(() => validateProviderSettlement({ ...settlement({ state: 'stopped' }) }));
  assert.throws(() => validateProviderSettlement({
    ...settlement({ state: 'stopped' }),
    evidenceRefs: [{ ...providerEvidence('settle-other-task'), scope: { ...operationScope, taskId: id('task', 'task-b') } }],
  }), ContractError);
  assert.throws(() => validateProviderSettlement({
    ...settlement({ state: 'stopped' }),
    resourceRelease: { state: 'released', evidenceRefs: [{ ...providerEvidence('resource-other-operation'), scope: { ...scope, operationId: id('operation', 'operation-b') } }] },
  }), ContractError);
  assert.throws(() => validateProviderSettlement({
    ...settlement({ state: 'stopped' }),
    persistence: { state: 'committed', evidenceRefs: [{ ...providerEvidence('persistence-other-task'), scope: { ...operationScope, taskId: id('task', 'task-b') } }] },
  }), ContractError);
});

test('control fields cannot enter provider business payloads', () => {
  assert.throws(() => validateProviderSubmitInput({ ...submitInput(), payload: { steer: true } }), ContractError);
  assert.throws(() => validateProviderStartInput({ ...startInput(), payload: { checkpoint: 'cp-a' } }), ContractError);
  assert.throws(() => validateProviderSubmitResult({ ...submitResult(), payload: { executionEpoch: 1 } }), ContractError);
  assert.doesNotThrow(() => validateProviderSubmitInput({ ...submitInput(), payload: { steerFaith: 'not-control' } }));
});

test('pending close requires owner and next action', () => {
  assert.doesNotThrow(() => validateProviderCloseResult({
    ...closeResult({ state: 'pending' }),
    ownerId: 'close-owner',
    nextAction: { kind: 'wait', ref: 'cleanup' },
  }));
  assert.throws(() => validateProviderCloseResult({ ...closeResult({ state: 'pending' }) }), ContractError);
  assert.throws(() => validateProviderCloseResult({ ...closeResult({ state: 'pending' }), ownerId: 'close-owner' }), ContractError);
  assert.throws(() => validateProviderCloseResult({ ...closeResult({ state: 'pending' }), nextAction: { kind: 'wait', ref: 'cleanup' } }), ContractError);
});

test('tool, error, and terminal events preserve evidence refs and owner', () => {
  assert.throws(() => validateProviderEvent(providerEvent({ kind: 'error', error: providerError(), ownerId: undefined })), ContractError);
  assert.throws(() => validateProviderEvent(providerEvent({ kind: 'terminal', terminalState: 'succeeded', evidenceRefs: [] })), ContractError);
  assert.throws(() => validateProviderEvent(providerEvent({ kind: 'tool', ownerId: 'owner', nextAction: { kind: 'continue' }, evidenceRefs: [] })), ContractError);
  assert.throws(() => validateProviderToolResult({ ...toolResult(), status: 'failed', error: undefined, ownerId: 'owner', nextAction: { kind: 'recover', ref: 'provider-adapter' } }), ContractError);
  assert.doesNotThrow(() => validateProviderEvent(providerEvent({ kind: 'tool', ownerId: 'owner', nextAction: { kind: 'continue' }, evidenceRefs: [providerEvidence('tool-event')] })));
});

test('failure and attention results cannot be represented as successful output without required refs', () => {
  assert.throws(() => validateProviderSubmitResult({ ...submitResult(), status: 'completed', outputRefs: [], error: providerError() }), ContractError);
  assert.throws(() => validateProviderSubmitResult({ ...submitResult(), status: 'failed', error: undefined }), ContractError);
  assert.doesNotThrow(() => validateProviderSubmitResult({ ...submitResult(), status: 'failed', error: providerError(), outputRefs: ['output-a'] }));
  assert.doesNotThrow(() => validateProviderToolResult({ ...toolResult({ status: 'failed', error: providerError(), outputRefs: ['tool-output-a'] }) }));
});

test('contract source stays provider-neutral without DSH/RCC/provider SDK imports or types', () => {
  const source = readFileSync(new URL('../../../../packages/contracts/src/index.ts', import.meta.url), 'utf8');
  const forbiddenPatterns = [/[\s('"]dsh/i, /[\s('"]rcc/i, /[\s('"]routecodex/i, /deepseek/i, /provider-sdk/i];
  for (const pattern of forbiddenPatterns) {
    assert.equal(pattern.test(source), false, `contract source must not contain ${pattern}`);
  }
});

const runtimeBinding = (overrides: Partial<RuntimeBinding> = {}): RuntimeBinding => ({
  runtimeId: 'runtime-a', agentInstanceId: 'agent-a', roleId: 'executor', taskId: task, assignmentId: 'assignment-a',
  executionEpoch: 1, scopeRef: 'organ-a::task-a', permissionRevision: 'permission-r1', capabilityDigest: 'sha256:capability-a',
  providerBindingId: 'binding-a', providerBindingDigest: 'sha256:provider-binding-a', bindingDigest: 'sha256:binding-a', ...overrides,
});
const providerBindingFramework = (overrides: Partial<AgentProviderBinding> = {}): AgentProviderBinding => ({
  bindingId: 'binding-a', providerId: 'cc-local', protocol: 'responses', endpointRef: 'local-config', modelRef: 'model-a',
  configDigest: 'sha256:config-a', capabilityDigest: 'sha256:capability-a', bindingDigest: 'sha256:provider-binding-a',
  owner: 'harness', ...overrides,
});
const messageEnvelope = (overrides: Partial<AgentMessageEnvelope> = {}): AgentMessageEnvelope => ({
  schemaVersion: 1, messageId: 'message-a', streamId: 'stream-a', sequence: 1, class: 'control', kind: 'stop.requested',
  publisherBindingRef: 'runtime-a', scopeRef: 'organ-a::task-a', correlation: { taskId: task }, payloadRef: 'asset://payload-a',
  sourceFactRef: 'fact://source-a', emittedAt: '2099-01-01T00:00:00Z', ...overrides,
});
const scopeAcl = (overrides: Partial<ScopeAcl> = {}): ScopeAcl => ({
  scopeRef: 'organ-a::task-a', principalRef: 'agent-a', permissionRevision: 'permission-r1', allowedCapabilities: ['stop'],
  allowedMessages: ['control'], ...overrides,
});
const consumerCursor = (overrides: Partial<EventConsumerCursor> = {}): EventConsumerCursor => ({
  consumerKey: consumerKey({ consumerOwner: 'event-owner', scopeRef: 'organ-a::task-a', contractVersion: 'v1' }),
  streamId: 'stream-a', lastHandledSequence: 0, ...overrides,
});
const consumerReceipt = (overrides: Partial<EventConsumerReceipt> = {}): EventConsumerReceipt => ({
  consumerKey: consumerCursor().consumerKey, messageId: 'message-a', streamId: 'stream-a', handledSequence: 1,
  disposition: 'applied', effectRefs: ['asset://effect-a'], ...overrides,
});
const retryObligation = (overrides: Partial<EventRetryObligation> = {}): EventRetryObligation => ({
  retryKey: 'retry-a', consumerKey: consumerCursor().consumerKey, messageId: 'message-a', streamId: 'stream-a',
  failedSequence: 1, attempt: 1, nextAttemptAt: '2099-01-01T00:00:00Z', ownerRef: 'event-owner', failureRef: 'fact://failure-a',
  state: 'pending', ...overrides,
});
const closureRecord = (overrides: Partial<CheckpointClosureRecord> = {}): CheckpointClosureRecord => ({
  checkpointId: id('checkpoint', 'checkpoint-a'), source: 'harness-control', closureReason: 'stop settled', executionEpoch: 1,
  committed: true, reentryAllowed: false, pendingOperations: [], unknownOperations: [], recoveryStateRef: providerEvidence('recovery'),
  nextAction: { kind: 'stop', ref: 'stopped' }, closedAt: '2099-01-01T00:00:00Z', ...overrides,
});
const reentryRecord = (overrides: Partial<CheckpointReentryRecord> = {}): CheckpointReentryRecord => ({
  checkpointId: id('checkpoint', 'checkpoint-a'), reentryId: 'reentry-a', executionEpoch: 2, fencedEpochs: [1],
  permissionRevision: 'permission-r2', contextViewRef: 'context://view-a', entryPhase: 'recovery', nextAction: 'continue task',
  reentryRef: 'fact://reentry-a', ...overrides,
});
const interactionClosure = (overrides: Partial<InteractionClosure> = {}): InteractionClosure => ({
  interactionScopeId: 'interaction-a', requestId: 'request-a', attemptId: 'attempt-a', disposition: 'cancelled',
  inputRefs: ['asset://interaction-input'], feedbackRefs: ['asset://interaction-feedback'],
  evidenceRefs: [providerEvidence('interaction-closure')], closureRef: 'fact://interaction-closure',
  closedAt: '2099-01-01T00:00:00Z', ...overrides,
});
const goalRecord = (overrides: Partial<GoalRecord> = {}): GoalRecord => ({
  goalId: 'goal-a', scopeRef: 'organ-a::task-a', acceptedRevision: 'sha256:goal-a', status: 'active', ...overrides,
});
const subscription = (overrides: Partial<Subscription> = {}): Subscription => ({
  subscriptionId: 'subscription-a', goalId: 'goal-a', scheduleRevision: 1, state: 'active', busyPolicy: 'idle-reminder',
  currentOccurrenceOrdinal: 0, ...overrides,
});
const occurrence = (overrides: Partial<Occurrence> = {}): Occurrence => ({
  subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 1, state: 'due', dueAt: '2099-01-01T00:00:00Z', ...overrides,
});
const reminder = (overrides: Partial<Reminder> = {}): Reminder => ({
  reminderId: 'reminder-a', subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 1,
  state: 'pending', dueAt: '2099-01-01T00:00:00Z', ...overrides,
});
const lease = (overrides: Partial<SchedulerLease> = {}): SchedulerLease => ({
  leaseId: 'lease-a', schedulerInstanceId: 'scheduler-a', generation: 1, scopeRef: 'organ-a::task-a',
  acquiredAt: '2026-09-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', state: 'active', ...overrides,
});
const serverBinding = (overrides: Partial<AcpServerBinding> = {}): AcpServerBinding => ({
  bindingRef: 'acp-server-a', principalRef: 'agent-a', scopeRef: 'organ-a::task-a', allowedSessionKinds: ['task'],
  allowedCapabilities: ['stop'], permissionRevision: 'permission-r1', bindingDigest: 'sha256:acp-server-a', ...overrides,
});
const driverBinding = (overrides: Partial<AcpDriverBinding> = {}): AcpDriverBinding => ({
  bindingRef: 'acp-driver-a', externalPeerRef: 'peer-a', taskId: task, assignmentId: 'assignment-a', executionEpoch: 1,
  delegatedCapabilities: ['stop'], delegationProofRef: 'fact://proof-a', permissionRevision: 'permission-r1', ...overrides,
});

test('framework runtime, provider, message, and ACP bindings validate positively and reject forged shapes', () => {
  assert.doesNotThrow(() => validateRuntimeBinding(runtimeBinding()));
  assert.doesNotThrow(() => validateAgentProviderBinding(providerBindingFramework()));
  assert.doesNotThrow(() => validateAgentMessageEnvelope(messageEnvelope()));
  assert.doesNotThrow(() => validateAcpServerBinding(serverBinding()));
  assert.doesNotThrow(() => validateAcpDriverBinding(driverBinding()));

  assert.throws(() => validateRuntimeBinding({ ...runtimeBinding(), executionEpoch: 0 }), ContractError);
  assert.throws(() => validateRuntimeBinding({ ...runtimeBinding(), assignmentId: '   ' }), ContractError);
  assert.throws(() => validateRuntimeBinding({ ...runtimeBinding(), interactionScopeId: 'interaction-a' }), ContractError);
  assert.throws(() => validateRuntimeBinding({ ...runtimeBinding(), taskId: undefined, assignmentId: undefined }), ContractError);
  assert.throws(() => validateAgentProviderBinding({ ...providerBindingFramework(), capabilityDigest: '' }), ContractError);
  assert.throws(() => validateAgentMessageEnvelope({ ...messageEnvelope(), class: 'nonsense' as never }), ContractError);
  assert.throws(() => validateAgentMessageEnvelope({ ...messageEnvelope(), payloadRef: '' }), ContractError);
  assert.throws(() => validateAcpServerBinding({ ...serverBinding(), allowedSessionKinds: [] }), ContractError);
  assert.throws(() => validateAcpDriverBinding({ ...driverBinding(), taskId: undefined, assignmentId: 'dangling' }), ContractError);
  assert.throws(() => validateAcpDriverBinding({ ...driverBinding(), delegationProofRef: '' }), ContractError);
});

test('agent request control and runtime binding fingerprints reject task/interaction forgery', () => {
  const request = {
    protocolVersion: 1 as const, requestId: 'request-a', attemptId: 'attempt-a',
    binding: { kind: 'task' as const, taskId: task, assignmentId: 'assignment-a', executionEpoch: 1, bindingFingerprint: 'sha256:binding-a' },
    providerBinding: providerBindingFramework(), contextViewRef: 'context://view-a', permissionRevision: 'permission-r1',
    idempotencyKey: 'idem-a', replyMode: 'terminal' as const,
  };
  assert.doesNotThrow(() => validateAgentRequestControl(request));
  assert.throws(() => validateAgentRequestControl({ ...request, binding: { kind: 'task' as const, taskId: task, executionEpoch: 1, bindingFingerprint: 'sha256:binding-a', assignmentId: '' } }), ContractError);
  assert.throws(() => validateAgentRequestControl({ ...request, binding: { kind: 'interaction' as const, interactionScopeId: 'interaction-a', bindingFingerprint: 'sha256:binding-a' }, permissionRevision: '' }), ContractError);
});

test('versioned driver contract keeps dispatch, observation, result, reconcile, settle, and close separate', async () => {
  const request: AgentRequestEnvelope = {
    version: 1,
    control: {
      protocolVersion: 1, requestId: 'request-a', attemptId: 'attempt-a',
      binding: { kind: 'task', taskId: task, assignmentId: 'assignment-a', executionEpoch: 1, bindingFingerprint: 'sha256:binding-a' },
      providerBinding: providerBindingFramework(), contextViewRef: 'context://view-a', permissionRevision: 'permission-r1',
      idempotencyKey: 'idem-a', replyMode: 'terminal',
    },
    data: { inputRefs: ['asset://input-a'], outputContractRef: 'contract://output-a', capabilitySetRef: 'capability://set-a' },
  };
  assert.doesNotThrow(() => validateAgentRequestEnvelope(request));
  assert.throws(() => validateAgentRequestEnvelope({ ...request, data: { ...request.data, inputRefs: [''] } }), ContractError);
  assert.throws(() => validateAgentRequestEnvelope({ ...request, data: { ...request.data, capabilitySetRef: ' ' } }), ContractError);
  assert.doesNotThrow(() => validateAgentDriverReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    status: 'accepted', evidenceRefs: [providerEvidence('driver-receipt')],
  }));
  assert.throws(() => validateAgentDriverReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: '', executionEpoch: 1, driverRef: 'driver-a',
    status: 'accepted', evidenceRefs: [providerEvidence('driver-receipt')],
  }), ContractError);
  assert.throws(() => validateAgentDriverReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    status: 'unknown', evidenceRefs: [providerEvidence('driver-receipt')],
  }), ContractError);
  assert.doesNotThrow(() => validateAgentDispatchReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    operationRef: 'operation-a', status: 'accepted', evidenceRefs: [providerEvidence('dispatch-receipt')],
  }));
  assert.throws(() => validateAgentDispatchReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    operationRef: '', status: 'accepted', evidenceRefs: [providerEvidence('dispatch-receipt')],
  }), ContractError);
  assert.doesNotThrow(() => validateAgentObservationEvent({
    requestId: 'request-a', attemptId: 'attempt-a', sequence: 1, cursor: 'cursor-a', kind: 'progress', evidenceRefs: ['fact://observation'],
  }));
  assert.throws(() => validateAgentObservationEvent({
    requestId: 'request-a', attemptId: 'attempt-a', sequence: 0, cursor: 'cursor-a', kind: 'progress', evidenceRefs: [],
  }), ContractError);
  assert.doesNotThrow(() => validateAgentResult({ status: 'succeeded', evidenceRefs: [providerEvidence('result')] }));
  assert.throws(() => validateAgentResult({ status: 'running' as never, evidenceRefs: [] }), ContractError);
  assert.doesNotThrow(() => validateAgentStopReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    status: 'accepted', evidenceRefs: [providerEvidence('stop-receipt')],
  }));
  assert.throws(() => validateAgentStopReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: '', executionEpoch: 1, driverRef: 'driver-a',
    status: 'accepted', evidenceRefs: [providerEvidence('stop-receipt')],
  }), ContractError);
  assert.doesNotThrow(() => validateAgentReconcileResult({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    operationRef: 'operation-a', status: 'accepted', reconciled: true, evidenceRefs: [providerEvidence('reconcile')],
  }));
  assert.throws(() => validateAgentReconcileResult({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    operationRef: '', status: 'accepted', reconciled: false, evidenceRefs: [],
  }), ContractError);
  assert.doesNotThrow(() => validateAgentSettleReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    status: 'accepted', state: 'stopped', evidenceRefs: [providerEvidence('settle')],
  }));
  assert.throws(() => validateAgentSettleReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    status: 'accepted', state: 'running' as never, evidenceRefs: [],
  }), ContractError);
  assert.doesNotThrow(() => validateAgentCloseReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    status: 'accepted', closed: true, evidenceRefs: [providerEvidence('close')],
  }));
  assert.throws(() => validateAgentCloseReceipt({
    requestId: 'request-a', attemptId: 'attempt-a', runtimeId: 'runtime-a', executionEpoch: 1, driverRef: 'driver-a',
    status: 'accepted', closed: true, evidenceRefs: [{ ...providerEvidence('close'), source: '' }],
  }), ContractError);
  const driver: AgentDriverV1 = {
    protocolVersion: 1,
    kind: 'fake',
    capabilities: async () => ({ driverKind: 'fake', capabilities: [], version: '1' }),
    start: async (input) => ({
      requestId: input.requestId, attemptId: input.attemptId, runtimeId: input.runtimeId, executionEpoch: input.executionEpoch,
      driverRef: 'driver-a', status: 'accepted', evidenceRefs: [],
    }),
    send: async (input) => ({
      requestId: input.control.requestId, attemptId: input.control.attemptId, runtimeId: 'runtime-a', executionEpoch: 1,
      driverRef: 'driver-a', operationRef: 'operation-a', status: 'accepted', evidenceRefs: [],
    }),
    observe: async function* () { yield { requestId: 'request-a', attemptId: 'attempt-a', sequence: 1, cursor: 'cursor-a', kind: 'progress', evidenceRefs: [] }; },
    readResult: async () => ({ status: 'succeeded', evidenceRefs: [] }),
    requestStop: async (input) => ({
      requestId: input.requestId, attemptId: input.attemptId, runtimeId: input.runtimeId, executionEpoch: input.executionEpoch,
      driverRef: 'driver-a', status: 'accepted', evidenceRefs: [],
    }),
    reconcile: async (input) => ({
      requestId: input.requestId, attemptId: input.attemptId, runtimeId: input.runtimeId, executionEpoch: input.executionEpoch,
      driverRef: 'driver-a', operationRef: input.operationRef, status: 'accepted', reconciled: true, evidenceRefs: [],
    }),
    settle: async (input) => ({
      requestId: input.requestId, attemptId: input.attemptId, runtimeId: input.runtimeId, executionEpoch: input.executionEpoch,
      driverRef: 'driver-a', status: 'accepted', state: 'stopped', evidenceRefs: [],
    }),
    close: async (input) => ({
      requestId: input.requestId, attemptId: input.attemptId, runtimeId: input.runtimeId, executionEpoch: input.executionEpoch,
      driverRef: 'driver-a', status: 'accepted', closed: true, evidenceRefs: [],
    }),
  };
  assert.equal(driver.protocolVersion, 1);
});

test('scope ACL and permission revision prevent cross-scope reads and revoked permissions', () => {
  assert.doesNotThrow(() => validateScopeAcl(scopeAcl()));
  const allowedSubject = {
    principalRef: 'agent-a', scopeRef: 'organ-a::task-a', permissionRevision: 'permission-r1', requestedCapability: 'stop', messageClass: 'control',
  } as const;
  assertScopeAcl(scopeAcl(), allowedSubject);
  assert.throws(() => assertScopeAcl(scopeAcl(), { ...allowedSubject, principalRef: 'agent-b' }), ContractError);
  assert.throws(() => assertScopeAcl(scopeAcl(), { ...allowedSubject, scopeRef: 'organ-a::other-task' }), ContractError);
  assert.throws(() => assertScopeAcl(scopeAcl(), { ...allowedSubject, permissionRevision: 'permission-r2' }), ContractError);
  assert.throws(() => assertScopeAcl(scopeAcl(), { ...allowedSubject, requestedCapability: 'read' }), ContractError);
  assert.throws(() => assertScopeAcl(scopeAcl(), { ...allowedSubject, messageClass: 'observation' }), ContractError);
  assert.equal(checkScopeAcl(scopeAcl(), {
    principalRef: 'agent-a', scopeRef: 'organ-a::other-task', permissionRevision: 'permission-r1',
  }).allowed, false);
  assert.equal(checkScopeAcl(scopeAcl({ permissionRevision: 'permission-r1' }), {
    principalRef: 'agent-a', scopeRef: 'organ-a::task-a', permissionRevision: 'permission-r2',
  }).allowed, false);
  assert.throws(() => assertPermissionRevisionMatches('permission-r2', 'permission-r1'), ContractError);
});

test('consumer cursors, receipts, retry obligations, and commit intents keep final ACK separate from retry', () => {
  validateEventConsumerCursor(consumerCursor());
  validateEventConsumerReceipt(consumerReceipt());
  validateEventRetryObligation(retryObligation());
  validateEventHandlerCommit({ consumerKey: retryObligation().consumerKey, messageId: retryObligation().messageId, retryObligation: retryObligation() });
  assert.throws(() => validateEventHandlerCommit({
    consumerKey: retryObligation().consumerKey, messageId: retryObligation().messageId,
    retryObligation: retryObligation({ state: 'exhausted' }),
  }), ContractError);
  assert.throws(() => validateEventHandlerCommit({
    consumerKey: retryObligation().consumerKey, messageId: retryObligation().messageId,
    retryObligation: retryObligation({ state: 'cancelled' }),
  }), ContractError);
  validateEventHandlerCommit({
    consumerKey: consumerReceipt().consumerKey, messageId: consumerReceipt().messageId, disposition: 'applied',
    completionMode: 'journal-atomic', internalEffectFacts: ['asset://effect-a'], externalOperationRefs: [],
  });
  assert.throws(() => validateEventHandlerCommit({
    consumerKey: consumerReceipt().consumerKey, messageId: consumerReceipt().messageId, disposition: 'terminal-failure' as never,
    completionMode: 'journal-atomic', internalEffectFacts: [], externalOperationRefs: [], failureRef: 'failure://forced',
  }), ContractError);
  assert.equal(consumerKey({ consumerOwner: 'event-owner', scopeRef: 'organ-a::task-a', contractVersion: 'v1' }), 'event-owner::organ-a::task-a::v1');
  assert.throws(() => validateEventConsumerReceipt({ ...consumerReceipt(), disposition: 'applied', effectRefs: [] }), ContractError);
  assert.throws(() => validateEventConsumerReceipt({ ...consumerReceipt({ disposition: 'terminal-failure' }), failureRef: undefined }), ContractError);
  assert.throws(() => validateEventHandlerCommit({
    consumerKey: consumerReceipt().consumerKey, messageId: consumerReceipt().messageId, disposition: 'applied',
    completionMode: 'journal-atomic', internalEffectFacts: [], externalOperationRefs: ['asset://external'],
  }), ContractError);
  assert.throws(() => validateEventHandlerCommit({
    consumerKey: consumerReceipt().consumerKey, messageId: consumerReceipt().messageId, disposition: 'applied',
    completionMode: 'operation-barrier', internalEffectFacts: [], externalOperationRefs: [],
  }), ContractError);
});

test('checkpoint closure and reentry keep committed facts separate from reentry permission', () => {
  validateCheckpointClosureRecord(closureRecord());
  validateCheckpointReentryRecord(reentryRecord());
  assert.throws(() => validateCheckpointClosureRecord({ ...closureRecord({ committed: false, reentryAllowed: true }) }), ContractError);
  assert.throws(() => validateCheckpointClosureRecord({ ...closureRecord({ unknownOperations: ['op://unknown'], reentryAllowed: true }) }), ContractError);
  assert.throws(() => validateCheckpointClosureRecord({ ...closureRecord({ nextAction: { kind: 'wait' } }) }), ContractError);
  assert.throws(() => validateCheckpointClosureRecord({ ...closureRecord({ nextAction: { kind: 'wait', ref: ' ' } }) }), ContractError);
  assert.throws(() => validateCheckpointClosureRecord({ ...closureRecord({ nextAction: { kind: 'unknown' as never, ref: 'unknown' } }) }), ContractError);
  assert.throws(() => validateCheckpointReentryRecord({ ...reentryRecord({ executionEpoch: 1, fencedEpochs: [1] }) }), ContractError);
});

test('interaction closure is independent from task checkpoint closure', () => {
  validateInteractionClosure(interactionClosure());
  assert.throws(() => validateInteractionClosure({ ...interactionClosure(), disposition: 'bogus' as never }), ContractError);
  assert.throws(() => validateInteractionClosure({ ...interactionClosure(), interactionScopeId: '' }), ContractError);
  assert.throws(() => validateInteractionClosure({ ...interactionClosure(), evidenceRefs: [{ ...providerEvidence('interaction-closure'), locator: '' }] }), ContractError);
});

test('watchdog, goal, schedule, occurrence, reminder, and lease invariants reject invalid state shapes', () => {
  validateControlWatchdogPolicy({
    maxSilentDurationMs: 1, maxTurnDurationMs: 2, maxTotalTurns: 3, maxTurnsBetweenProbes: 4, maxNoProgressTurns: 5, maxControlRepairAttempts: 6,
  });
  validateControlProbeRecord({
    runtimeRef: 'runtime-a', requestRef: 'request-a', turnRef: 'turn-a', probePoint: 'after-tool-result', triggeredAt: '2099-01-01T00:00:00Z', requiredSummary: true,
  });
  assert.throws(() => validateControlWatchdogPolicy({
    maxSilentDurationMs: 0, maxTurnDurationMs: 2, maxTotalTurns: 3, maxTurnsBetweenProbes: 4, maxNoProgressTurns: 5, maxControlRepairAttempts: 6,
  }), ContractError);
  validateGoalRecord(goalRecord());
  assert.throws(() => validateGoalRecord({ ...goalRecord({ status: 'completed' }) }), ContractError);
  validateSubscription(subscription());
  assert.throws(() => validateSubscription({ ...subscription({ state: 'bogus' as never }) }), ContractError);
  validateOccurrence(occurrence());
  assert.throws(() => validateOccurrence({ ...occurrence({ occurrenceOrdinal: 0 }) }), ContractError);
  validateReminder(reminder());
  assert.throws(() => validateReminder({ ...reminder({ dueAt: 'nope' }) }), ContractError);
  validateSchedulerLease(lease());
  assert.throws(() => validateSchedulerLease({ ...lease({ expiresAt: '2026-01-01T00:00:00Z' }) }), ContractError);
  assert.equal(occurrenceIdempotencyKey(occurrence()), 'subscription-a::1::1');
});

test('memory contracts keep canonical scope, provenance, review, and promotion boundaries explicit', () => {
  validateCanonicalMemoryScope({ namespace: 'project', projectKey: 'project-a', organId: organ, taskId: task });
  validateCanonicalMemoryScope({ namespace: 'global', globalId: 'global', sourceProjectKey: 'project-a', sourceOrganId: organ });
  assert.throws(() => validateCanonicalMemoryScope({ namespace: 'global', globalId: 'organ-a' } as never), ContractError);
  assert.throws(() => validateCanonicalMemoryScope({ namespace: 'project', projectKey: '', organId: organ }), ContractError);

  validateMemoryBinding({ kind: 'task', taskId: task, assignmentId: 'assignment-a', executionEpoch: 1, bindingRef: 'binding-a' });
  validateMemoryBinding({ kind: 'interaction', interactionScopeId: 'interaction-a', bindingRef: 'binding-a' });
  assert.throws(() => validateMemoryBinding({ kind: 'task', taskId: task, assignmentId: '', executionEpoch: 1, bindingRef: 'binding-a' }), ContractError);
  assert.throws(() => validateMemoryBinding({ kind: 'interaction', interactionScopeId: '', bindingRef: 'binding-a' }), ContractError);

  validateEpisodicMemorySource({
    sourceRef: 'journal://project-a/1',
    sourceDigest: 'sha256:source-a',
    projectKey: 'project-a',
    occurredAt: '2026-09-17T00:00:00Z',
    payloadRef: 'asset://payload-a',
    kind: 'checkpoint',
  });
  assert.throws(() => validateEpisodicMemorySource({
    sourceRef: 'journal://project-a/1',
    sourceDigest: 'sha256:source-a',
    projectKey: 'project-a',
    occurredAt: 'not-a-time',
    payloadRef: 'asset://payload-a',
    kind: 'checkpoint',
  }), ContractError);
});

test('memory candidates and submissions reject missing evidence and actor project drift', () => {
  validateSemanticMemoryCandidate(semanticCandidate());
  assert.throws(() => validateSemanticMemoryCandidate(semanticCandidate({ sourceRefs: ['journal://project-a/1'], sourceDigests: [] })), ContractError);
  assert.throws(() => validateSemanticMemoryCandidate(semanticCandidate({ validity: { kind: 'until' } })), ContractError);
  assert.throws(() => validateSemanticMemoryCandidate(semanticCandidate({ review: 'bogus' as never })), ContractError);

  validateProceduralMemoryCandidate(proceduralCandidate());
  assert.throws(() => validateProceduralMemoryCandidate(proceduralCandidate({ steps: [] })), ContractError);
  assert.throws(() => validateProceduralMemoryCandidate(proceduralCandidate({ successEvidenceRefs: [] })), ContractError);

  validateMemorySubmission(memorySubmission());
  assert.throws(() => validateMemorySubmission(memorySubmission({ actor: memoryActor({ projectKey: 'other-project' }) })), ContractError);
  assert.throws(() => validateMemorySubmission(memorySubmission({ evidenceRefs: [] })), ContractError);
  assert.throws(() => validateMemorySubmission(memorySubmission({ desiredScope: 'external' as never })), ContractError);
});

test('memory query, review, promotion, and forgetting enforce owner authority', () => {
  validateMemoryQueryRequest(memoryQuery());
  assert.throws(() => validateMemoryQueryRequest(memoryQuery({ namespace: 'global' })), ContractError);
  validateMemoryQueryRequest(memoryQuery({
    namespace: 'global',
    actor: memoryActor({ crossProjectGrantRef: 'grant://global-read' }),
  }));
  assert.throws(() => validateMemoryQueryRequest(memoryQuery({ states: [] })), ContractError);
  assert.throws(() => validateMemoryQueryRequest(memoryQuery({ tokenBudget: -1 })), ContractError);

  const review: MemoryReviewReceipt = {
    candidateId: 'candidate-a',
    decision: 'approve',
    actor: memoryActor({ roleId: 'review', permissions: ['memory.read', 'memory.review'] }),
    decisionReason: 'evidence is complete',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: ['journal://project-a/review'],
  };
  validateMemoryReviewReceipt(review);
  assert.throws(() => validateMemoryReviewReceipt({ ...review, decision: 'publish' as never }), ContractError);

  const promotion: MemoryPromotionReceipt = {
    candidateId: 'candidate-a',
    from: 'project',
    to: 'global',
    actor: memoryActor({ roleId: 'review', permissions: ['memory.read', 'memory.promote'] }),
    reason: 'stable across projects',
    impactScope: 'all projects',
    approvalRef: 'approval://global-promotion',
    approvalDigest: 'sha256:approval-global-promotion',
    sourceRefs: ['journal://project-a/1'],
    sourceDigests: ['sha256:source-a'],
    promotedAt: '2026-09-17T00:00:00Z',
  };
  validateMemoryPromotionReceipt(promotion);
  assert.throws(() => validateMemoryPromotionReceipt({ ...promotion, sourceDigests: [] }), ContractError);
  assert.throws(() => validateMemoryPromotionReceipt({ ...promotion, actor: memoryActor() }), ContractError);
  assert.throws(() => validateMemoryPromotionReceipt({ ...promotion, to: 'project' as never }), ContractError);

  const plan: MemoryForgettingPlan = {
    planId: 'forget-a',
    namespace: 'project',
    projectKey: 'project-a',
    actions: [{ memoryId: 'memory-old', action: 'supersede', reason: 'replaced by approved fact', replacementRef: 'memory-new', sourceRefs: ['journal://project-a/1'] }],
    protectedRefs: ['checkpoint://project-a/1'],
    createdAt: '2026-09-17T00:00:00Z',
  };
  validateMemoryForgettingPlan(plan);
  assert.throws(() => validateMemoryForgettingPlan({ ...plan, actions: [{ memoryId: 'memory-old', action: 'supersede', reason: 'missing replacement', sourceRefs: [] }] }), ContractError);
  validateMemoryForgettingRequest({
    actor: memoryActor({ roleId: 'system', permissions: ['memory.read', 'memory.forget'] }),
    plan,
  });
  assert.throws(() => validateMemoryForgettingRequest({
    actor: memoryActor({ permissions: ['memory.read'] }),
    plan,
  }), ContractError);
  assert.throws(() => validateMemoryForgettingRequest({
    actor: memoryActor({ roleId: 'system', permissions: ['memory.read', 'memory.forget'], projectKey: 'other-project' }),
    plan,
  }), ContractError);
});

test('memory curation, follow-up, audit prompt, recall policy, and source proposals are typed', () => {
  const curation: MemoryCurationResult = {
    operationId: operation,
    auditPrompt: {
      promptRef: 'project-memory-audit',
      canonicalRef: 'source://project-a/audit-prompt',
      revision: 'r1',
      digest: 'sha256:prompt-r1',
      loadedAt: '2026-09-17T00:00:00Z',
    },
    sourceRefs: ['journal://project-a/1'],
    outcome: 'candidate',
    candidateId: 'candidate-a',
    matchedMemoryIds: [],
    conflictRefs: [],
    explanation: 'candidate requires review',
    nextAction: 'review',
  };
  validateAuditPromptSnapshot(curation.auditPrompt);
  validateMemoryCurationResult(curation);
  assert.throws(() => validateMemoryCurationResult({ ...curation, candidateId: undefined }), ContractError);
  assert.throws(() => validateMemoryCurationResult({ ...curation, outcome: 'conflict', conflictRefs: [] }), ContractError);
  assert.throws(() => validateMemoryCurationResult({ ...curation, outcome: 'no-op', nextAction: 'review' }), ContractError);

  validateMemoryFollowUpRequest({
    requestId: 'follow-up-a',
    operationId: operation,
    correlationId: 'correlation-a',
    inReplyTo: 'request-a',
    bindingRef: 'binding-a',
    actor: memoryActor(),
    projectKey: 'project-a',
    namespace: 'project',
    evidenceRefs: ['journal://project-a/1'],
    evidenceDigests: ['sha256:source-a'],
    sourceRefs: ['journal://project-a/1'],
    inputDigest: 'sha256:follow-up-a',
  });
  assert.throws(() => validateMemoryFollowUpRequest({
    requestId: 'follow-up-a',
    operationId: operation,
    correlationId: 'correlation-a',
    inReplyTo: 'request-a',
    bindingRef: 'binding-a',
    actor: memoryActor(),
    projectKey: 'project-a',
    namespace: 'global',
    evidenceRefs: [],
    evidenceDigests: [],
    sourceRefs: [],
    inputDigest: 'sha256:follow-up-a',
  }), ContractError);

  validateMemoryRecallRequest({
    agentRuntimeId: 'runtime-a',
    bindingRef: 'binding-a',
    projectKey: 'project-a',
    policy: { namespaces: ['project', 'global'], layers: ['working', 'semantic'], allowCandidates: false, maxTokenBudget: 100, evidenceRequired: true },
    query: 'checkpoint',
  });
  assert.throws(() => validateMemoryRecallRequest({
    agentRuntimeId: 'runtime-a',
    bindingRef: 'binding-a',
    projectKey: 'project-a',
    policy: { namespaces: [], layers: ['working'], allowCandidates: false, maxTokenBudget: 100, evidenceRequired: true },
  }), ContractError);

  const proposal: ProjectSourceUpdateProposal = {
    target: 'project-agents',
    sourceRef: 'source://project-a/AGENTS.md',
    expectedRevision: 'r1',
    expectedDigest: 'sha256:agents-r1',
    patchRef: 'patch://project-a/r2',
    evidenceRefs: ['journal://project-a/1'],
    ownerRef: 'project-rule-owner',
  };
  validateProjectSourceUpdateProposal(proposal);
  assert.throws(() => validateProjectSourceUpdateProposal({ ...proposal, target: 'global-agents' as never }), ContractError);
});
