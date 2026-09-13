import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  ContractError, assertAgentRuntimeId, assertBusinessPayload, assertCapabilities, assertCheckpointLink, assertContextBudget, assertExecutionEpoch,
  assertNotExpired, assertProviderBindingMatch, assertProviderEventEpoch, assertProviderExecutionIdentityMatch, assertProviderReadinessBinding,
  assertSameScope, assertScope, checkProviderEventEpoch, id, runtimeId, validateExecutionBinding, validateProviderBinding, validateProviderCapabilities,
  validateProviderCloseResult, validateProviderError, validateProviderEvent, validateProviderReadiness, validateProviderRecoveryResult, validateProviderResumeInput,
  validateProviderSettleInput, validateProviderSettlement, validateProviderStartInput, validateProviderStartReceipt, validateProviderStopReceipt,
  validateProviderStopRequest, validateProviderSubmitInput, validateProviderSubmitResult, validateProviderToolResult, validateRequirementEnvelope,
  validateWorkAssignment, validateWorkResult, type AgentMemoryContext, type AgentDriver, type AgentMemoryContextInjectionPort, type AgentRuntimeId,
  type Checkpoint, type ExecutionBinding, type ExecutionRuntimePort, type HarnessPluginContext, type MemoryOperationsPort, type NoveltyResult,
  type ProviderBinding, type ProviderCapabilities, type ProviderCloseResult, type ProviderError, type ProviderEvent, type ProviderReadiness,
  type ProviderRecoveryResult, type ProviderResumeInput, type ProviderSettlement, type ProviderStartInput, type ProviderStartReceipt, type ProviderStopReceipt,
  type ProviderStopRequest, type ProviderSubmitInput, type ProviderSubmitResult, type ProviderToolResult, type RecurrenceResult,
  type RequirementEnvelope, type ScopeRef, type WorkAssignment, type WorkResult,
} from '@humanagent/contracts';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: ScopeRef = { organId: organ, taskId: task };
const operation = id('operation', 'operation-a');
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

test('rejects control fields in business payloads', () => {
  assert.throws(() => assertBusinessPayload({ answer: 'ok', steer: true }), ContractError);
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

test('rejects invalid provider binding identity and missing required binding data', () => {
  assert.throws(() => validateProviderBinding({ ...providerBinding(), bindingId: '   ' }), ContractError);
  assert.throws(() => validateProviderBinding({ ...providerBinding(), protocol: 'openai' } as unknown as ProviderBinding), ContractError);
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
  assert.throws(() => assertProviderReadinessBinding({ ...readiness(), protocol: 'anthropic' }, providerBinding()), ContractError);
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

test('control fields cannot enter provider business payloads', () => {
  assert.throws(() => validateProviderSubmitInput({ ...submitInput(), payload: { steer: true } }), ContractError);
  assert.throws(() => validateProviderStartInput({ ...startInput(), payload: { checkpoint: 'cp-a' } }), ContractError);
  assert.throws(() => validateProviderSubmitResult({ ...submitResult(), payload: { executionEpoch: 1 } }), ContractError);
  assert.doesNotThrow(() => validateProviderSubmitInput({ ...submitInput(), payload: { steerFaith: 'not-control' } }));
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
