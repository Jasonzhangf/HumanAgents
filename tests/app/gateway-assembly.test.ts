import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ImmutableAssetStore, evidenceReference } from '../../packages/adapters/filesystem/src/index.js';
import { ActiveTurnContext } from '../../packages/runtime/src/context/active-turn-context.js';
import { FileActiveTurnJournal } from '../../packages/app/src/ui-runtime/journal.js';
import { createAppChildOperationAdmission } from '../../packages/app/src/ui-runtime/child-operation-admission.js';
import type { AppChildOperationAdmissionInput } from '../../packages/app/src/ui-runtime/child-producer.js';
import {
  createHandOperationRuntime,
  createResponsesFileToolExecutor,
  createToolExecutionGateway,
} from '../../packages/app/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import type { ProviderToolAdmissionInput } from '../../packages/app/src/provider-tool-execution.js';
import {
  createExecutionAdmission,
  executionAdmissionInputDigest,
  type AdmittedExecutionInput,
} from '../../packages/app/src/ui-runtime/execution-admission.js';
import { DeterministicInspectRoute } from '../../packages/adapters/operations/src/index.js';
import { CodeSearchRoute, type CodeSearchArtifactStore } from '../../packages/adapters/operations/src/index.js';
import {
  id,
  operationIdempotencyKey,
  operationSemanticFingerprint,
  operationSemanticFingerprintKey,
  type BusinessPayload,
  type CodeSearchReport,
  type EvidenceRef,
  type JournalCommitRef,
  type OperationEvent,
  type OperationId,
  type OperationIntent,
  type Scope,
  type ScopeRef,
  type ToolRegistration,
} from '../../packages/contracts/src/index.js';
import { type CodeSearchFileContent, type CodeSearchFileList, type CodeSearchFunctions } from '../../packages/runtime/src/hand/index.js';
import type { RuntimeExecutionAllocation } from '../../packages/runtime/src/ui-runtime/coordinator.js';
import type {
  OperationControlBinding,
  OperationControlReadback,
  OperationControlRecord,
  OperationControlSelector,
  OperationCoverageInitialization,
  OperationJournalPort,
} from '../../packages/runtime/src/gateway/index.js';

const organ = id('organ', 'app-gateway-organ');
const task = id('task', 'app-gateway-task');
const cycle = id('cycle', 'app-gateway-cycle');
const operation = id('operation', 'app-gateway-operation');
const scope: Scope = { organId: organ, taskId: task, cycleId: cycle };
const providerExecutionScope: Scope = { ...scope, operationId: operation };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `app-gateway-${label}`),
    kind: 'operation',
    source: 'app-gateway-test',
    locator: `test://${label}`,
    scope,
  };
}

function intent(): OperationIntent {
  return {
    operationId: operation,
    taskId: task,
    cycleId: cycle,
    requestedBy: 'app-gateway-test',
    intentRevision: 'revision-1',
    kind: 'inspect',
    toolName: 'deterministic.inspect',
    inputRef: 'artifact://input/app-gateway',
    inputDigest: 'sha256:app-gateway-input',
    requestedScope: scope,
    idempotencyKey: 'app-gateway-idempotency',
    expectedOutput: {
      schemaRef: 'schema://inspect-output/v1',
      requiredEvidenceKinds: ['external', 'tool'],
    },
  };
}

const admissionCommitRef: JournalCommitRef = {
  commitId: 'app-gateway-admission',
  journalSeq: 1,
  recordDigest: 'sha256:app-gateway-admission',
};

function operationControlBinding(intentValue: OperationIntent): OperationControlBinding {
  return {
    scope: intentValue.requestedScope,
    agentRuntimeId: 'runtime-app-gateway',
    harnessExecutionEpoch: 1,
    parentOperationId: intentValue.operationId,
    admissionCommitRef,
  };
}

class MemoryOperationJournal implements OperationJournalPort {
  readonly committed: OperationEvent[] = [];
  private sequence = 1;
  private readonly controls: { readonly record: OperationControlRecord; readonly ref: JournalCommitRef }[] = [];
  private coverageInitialized = false;

  async commit(event: OperationEvent, control: OperationControlRecord): Promise<JournalCommitRef> {
    const ref: JournalCommitRef = {
      commitId: `app-gateway-control:${this.sequence}`,
      journalSeq: this.sequence++,
      recordDigest: `sha256:app-gateway-control:${this.sequence}`,
    };
    this.committed.push(event);
    this.controls.push({ record: control, ref });
    return ref;
  }

  async readControl(selector: OperationControlSelector): Promise<OperationControlReadback> {
    if (!this.coverageInitialized) {
      return { state: 'unknown', scope: selector.scope, reason: 'coverage not initialized', missingRefs: [] };
    }
    const matches = this.controls.filter((entry) => (
      entry.record.binding.scope.taskId?.value === selector.scope.taskId?.value
      && entry.record.binding.agentRuntimeId === selector.agentRuntimeId
      && entry.record.binding.harnessExecutionEpoch === selector.harnessExecutionEpoch
    ));
    return {
      state: 'complete',
      scope: selector.scope,
      coverageCommitRef: admissionCommitRef,
      currentControlCommitRef: matches.at(-1)?.ref ?? admissionCommitRef,
      operations: matches.map((entry) => entry.record),
      operationCommits: matches.map((entry) => entry.ref),
    };
  }

  async initializeCoverage(_input: OperationCoverageInitialization): Promise<JournalCommitRef> {
    this.coverageInitialized = true;
    return admissionCommitRef;
  }

  async publishCommitted(_event: OperationEvent): Promise<void> {}
}

const journal = new MemoryOperationJournal();

function recordingJournal(): MemoryOperationJournal {
  return new MemoryOperationJournal();
}

async function createProviderToolAdmission(input: {
  readonly journalPath: string;
  readonly runtimeId: string;
  readonly executionEpoch: number;
  readonly parentOperationId: OperationId;
  readonly parentScope: ScopeRef;
  readonly inputRef: string;
}): Promise<ProviderToolAdmissionInput & {
  readonly childAdmission: ReturnType<typeof createExecutionAdmission>;
  readonly grants: JsonlTaskGrantJournal;
}> {
  const principalOwner = 'app-gateway-owner';
  const now = () => new Date('2026-09-20T00:00:00.000Z');
  const journal = new JsonlOrganJournal(input.journalPath);
  const grants = new JsonlTaskGrantJournal(journal);
  const allocation: RuntimeExecutionAllocation = {
    runtimeId: input.runtimeId,
    taskId: task,
    operationId: input.parentOperationId,
    executionEpoch: input.executionEpoch,
    assignmentId: `assignment-${input.parentOperationId.value}`,
    scope: input.parentScope,
    inputRefs: [input.inputRef],
    ownerId: principalOwner,
    directiveRevision: 1,
    inputRevision: 1,
    orchestrated: false,
  };
  const admittedInput: AdmittedExecutionInput = {
    inputRevision: allocation.inputRevision,
    inputRefs: allocation.inputRefs,
    input: Object.freeze({ prompt: 'app gateway provider tool fixture' }),
  };
  const inputDigest = executionAdmissionInputDigest(allocation, admittedInput);
  const capability = {
    actionId: 'task.execute',
    capabilities: ['provider.execution'],
    scope: { organId: input.parentScope.organId, taskId: task },
  };
  await grants.grant({
    requestId: `grant-${input.parentOperationId.value}`,
    taskId: task,
    owner: principalOwner,
    capability,
    expectedRevision: 0,
  });
  const registration: ToolRegistration = {
    toolName: 'provider.execution',
    contractVersion: '1.0.0',
    supportedKinds: ['run'],
    routeId: 'provider-execution',
    routeVersion: 'provider-execution.v1',
    mode: 'gateway',
    acceptedScopes: [{}],
    inputContract: 'schema://provider.execution.input/v1',
    outputContract: 'schema://provider.execution.output/v1',
    verifier: 'verifier://provider.execution/v1',
    capabilities: ['provider.execution'],
    retryPolicy: 'retry://explicit-reconciliation/v1',
    owner: principalOwner,
  };
  const admission = createExecutionAdmission({
    organJournal: journal,
    taskGrantPort: grants,
    principalOwner,
    capabilityFor: ({ intent }) => ({
      actionId: 'task.execute',
      capabilities: ['provider.execution'],
      scope: { organId: intent.requestedScope.organId, taskId: intent.taskId },
    }),
    resourceBoundary: {
      async readBoundary({ intent }) {
        return { scope: intent.requestedScope, evidenceRefs: [] };
      },
    },
    resolveAdmittedInput: async () => admittedInput,
    createGateway: (ports) => createToolExecutionGateway({ ...ports, now }),
  });
  const intent: OperationIntent = {
    operationId: input.parentOperationId,
    taskId: task,
    cycleId: cycle,
    requestedBy: principalOwner,
    intentRevision: '1',
    kind: 'run',
    toolName: registration.toolName,
    inputRef: allocation.inputRefs[0]!,
    inputDigest,
    requestedScope: input.parentScope,
    idempotencyKey: input.parentOperationId.value,
    expectedOutput: { schemaRef: registration.outputContract, requiredEvidenceKinds: ['operation'] },
  };
  const route = {
    operationId: input.parentOperationId,
    routeId: registration.routeId,
    routeVersion: registration.routeVersion,
    mode: registration.mode,
    contractVersion: registration.contractVersion,
    effectiveScope: input.parentScope,
    selectionReason: 'app gateway provider tool fixture',
    selectedAt: now().toISOString(),
  };
  await admission.admitExecution({
    allocation,
    requestRef: `execution:${input.parentOperationId.value}`,
    capability,
    parentLifecycle: {
      event: {
        eventId: `parent-admitted:${input.parentOperationId.value}`,
        schemaVersion: 1,
        kind: 'operation.accepted',
        operationId: input.parentOperationId,
        taskId: task,
        executionEpoch: 1,
        status: 'accepted',
        occurredAt: now().toISOString(),
        evidenceRefs: [],
      },
      control: {
        intent,
        registration,
        route,
        status: 'accepted',
        executionEpoch: 1,
        namespaceKey: operationIdempotencyKey(intent),
        fingerprintKey: operationSemanticFingerprintKey(operationSemanticFingerprint(intent, registration)),
      },
    },
  });
  return {
    childAdmission: admission,
    grants,
    organJournal: journal,
    currentTaskGrantPort: admission.permissions,
    principalOwner,
    resourceBoundary: admission.resourceBoundary,
    bindingFor: async () => await admission.bindingFor(allocation),
    admitToolOperation: admission.admitToolOperation,
    now,
  };
}

// Mapping failure loses child input identity or parent provenance. The existing
// durable-parent mismatch branch establishes the rejection risk. Two local
// consumers reuse the Journal/grant harness; execution and maintenance cost is low.
async function childOperationAdmissionFixture(root: string) {
  const provider = await createProviderToolAdmission({
    journalPath: join(root, 'organ.jsonl'), runtimeId: 'child-admission-parent',
    executionEpoch: 1, parentOperationId: operation, parentScope: providerExecutionScope,
    inputRef: 'artifact://input/child-admission-parent',
  });
  const binding = await provider.bindingFor({
    execution: { runtimeId: 'child-admission-parent', taskId: task, operationId: operation, executionEpoch: 1 },
    scope: providerExecutionScope, requestId: 'child-admission-request',
    call: { callId: 'child-admission-call', toolId: 'child.call', arguments: {}, continuationRef: 'child-response' },
    signal: new AbortController().signal,
  });
  const execution = { runtimeId: binding.agentRuntimeId, executionEpoch: binding.harnessExecutionEpoch };
  const turnId = 'child-admission-turn';
  const assignment = {
    assignmentId: 'child-admission-assignment', taskId: task, pipelineNodeId: 'child-admission-node',
    attempt: 1, executionEpoch: 1, inputRevision: 1, objective: 'admit accepted child call',
    targetRefs: [], expectedOutputRefs: [], acceptanceCriteriaDigest: 'child-admission-criteria',
    successCriteria: ['durable parent provenance'], failureCriteria: [], incompleteCriteria: [],
    requiredCapabilities: ['provider.execution'], mergeGate: 'not-required' as const,
  };
  const currentTurnRef = `active-turn://${turnId}`;
  const activeJournal = new FileActiveTurnJournal(join(root, 'active-turn.jsonl'));
  const parent = await ActiveTurnContext.open({
    journal: activeJournal, currentTurnRef,
    binding: {
      execution, scope: binding.scope, assignment,
      admittedTurn: {
        turnId, workAssignmentRef: assignment.assignmentId, taskRef: task, scopeRef: binding.scope,
        cycleRef: cycle, inputRevision: 1, directiveRevision: 1, executionEpoch: 1,
        runtimeBindingRef: execution.runtimeId, permissionRevision: '1',
        admissionEvidenceRefs: [binding.admissionCommitRef.commitId], currentTurnRef,
        recoveryStateRef: 'child-admission-recovery',
      },
    },
  });
  const request = { turnId, requestId: 'child-admission-request' };
  await parent.registerProviderRequest({ execution, record: { request, scope: binding.scope, phase: 'dispatching' } });
  await parent.registerProviderRequest({ execution, record: { request, scope: binding.scope, phase: 'dispatched' } });
  const arguments_ = { kind: 'execution', agent_id: 'worker', objective: 'do child work' };
  const assets = new ImmutableAssetStore(join(root, 'assets'));
  const rawArguments = {
    ref: evidenceReference(await assets.write('child-arguments', new TextEncoder().encode(JSON.stringify(arguments_))),
      binding.scope, 'tool', 'child-arguments'),
    view: { kind: 'arguments' as const },
  };
  await parent.acceptRawFact({
    execution, scope: binding.scope, request, producerSeq: 1,
    fact: {
      kind: 'tool-call', contentUnitId: 'child-call-unit', complete: true, rawArguments,
      call: { callId: 'child-admission-call', toolId: 'child.call', arguments: arguments_, continuationRef: 'child-response' },
    },
  });
  await parent.acceptRawFact({
    execution, scope: binding.scope, request, producerSeq: 2,
    fact: {
      kind: 'tool-call', contentUnitId: 'child-sibling-unit', complete: true, rawArguments,
      call: { callId: 'child-sibling-call', toolId: 'child.call', arguments: arguments_, continuationRef: 'child-response' },
    },
  });
  // Consume the durable accepted facts, rather than an in-memory parent double.
  const durableParent = await ActiveTurnContext.reconstruct(activeJournal, turnId);
  const call: AppChildOperationAdmissionInput = {
    invocationId: 'child-admission-invocation', childOperationId: id('operation', 'admitted-child'),
    kind: 'execution', selected: { agentId: 'worker', roleId: 'execution' },
    parentExecution: { ...execution, taskId: task, operationId: operation },
    scope: binding.scope, providerRequestId: request.requestId, toolCallId: 'child-admission-call',
  };
  const registration: ToolRegistration = {
    toolName: 'child.call', contractVersion: '1', supportedKinds: ['run'],
    routeId: 'test-child-producer', routeVersion: '1', mode: 'gateway', acceptedScopes: [binding.scope],
    inputContract: 'schema://test/child.call/input', outputContract: 'schema://test/child.call/output',
    verifier: 'verifier://test/child.call', capabilities: ['provider.execution'],
    retryPolicy: 'retry://explicit-reconciliation/v1', owner: 'humanagent.app.child-operation-admission',
  };
  const admit = createAppChildOperationAdmission({
    admission: provider.childAdmission, binding, parent: durableParent, registration,
  });
  return { provider, binding, call, rawArguments, admit };
}

async function childAdmissionRoot(): Promise<string> {
  const base = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'n3-child-admission-'));
}

test('child operation admission adapter registers accepted call and reads durable parent provenance', async () => {
  const root = await childAdmissionRoot();
  try {
    const { provider, binding, call, rawArguments, admit } = await childOperationAdmissionFixture(root);
    const selector = { scope: binding.scope, agentRuntimeId: binding.agentRuntimeId,
      harnessExecutionEpoch: binding.harnessExecutionEpoch };
    const beforeControl = await provider.childAdmission.gateway.readControl(selector);
    assert.equal(beforeControl.state, 'complete');
    const receipt = await admit(call);
    // A pending first child must not prevent a second real accepted sibling
    // from reading the parent body before either child has control.
    const siblingCall = { ...call, invocationId: 'child-sibling-invocation',
      childOperationId: id('operation', 'admitted-sibling'), toolCallId: 'child-sibling-call' };
    const siblingReceipt = await admit(siblingCall);
    const business = await provider.grants.readBusinessRegistration({ taskId: task,
      requestRef: ['provider-tool', call.parentExecution.runtimeId, '1', operation.value,
        call.providerRequestId, call.toolCallId].join(':'),
    });
    if (!business) throw new Error('missing durable child business registration');
    assert.deepEqual(business.commit, receipt.businessRegistrationCommitRef);
    assert.deepEqual(business.registration.inputIdentity, {
      requestRef: rawArguments.ref.locator, digest: rawArguments.ref.digest,
    });
    assert.equal(business.registration.operationProvenance?.operationId.value, call.childOperationId.value);
    assert.equal(business.registration.operationProvenance?.providerRequestId, call.providerRequestId);
    assert.equal(business.registration.operationProvenance?.toolCallId, call.toolCallId);
    console.log('child operation admission adapter admission readback', JSON.stringify({ receipt,
      parentControlBefore: beforeControl.state,
      parentControlAfter: await provider.childAdmission.gateway.readControl(selector),
      inputIdentity: business.registration.inputIdentity, provenance: business.registration.operationProvenance }));
    const readback = await provider.childAdmission.readChildToolBinding({
      call: { ...call, businessRegistrationCommitRef: receipt.businessRegistrationCommitRef }, operation: receipt,
    });
    assert.deepEqual(readback, binding);
    const siblingBusiness = await provider.grants.readBusinessRegistration({ taskId: task,
      requestRef: ['provider-tool', siblingCall.parentExecution.runtimeId, '1', operation.value,
        siblingCall.providerRequestId, siblingCall.toolCallId].join(':'),
    });
    if (!siblingBusiness) throw new Error('missing durable sibling business registration');
    assert.deepEqual(siblingBusiness.commit, siblingReceipt.businessRegistrationCommitRef);
    assert.deepEqual(siblingBusiness.registration.inputIdentity, business.registration.inputIdentity);
    assert.equal(siblingBusiness.registration.operationProvenance?.operationId.value, siblingCall.childOperationId.value);
    assert.equal(siblingBusiness.registration.operationProvenance?.toolCallId, siblingCall.toolCallId);
    assert.deepEqual(await provider.childAdmission.readChildToolBinding({
      call: { ...siblingCall, businessRegistrationCommitRef: siblingReceipt.businessRegistrationCommitRef },
      operation: siblingReceipt,
    }), binding);
    const namespace = await provider.childAdmission.gateway.readControl(selector);
    assert.equal(namespace.state, 'unknown');
    if (namespace.state !== 'unknown') throw new Error('pending children must remain unknown');
    assert.deepEqual(namespace.pendingChildren, [
      { operationId: call.childOperationId, businessRegistrationCommitRef: receipt.businessRegistrationCommitRef },
      { operationId: siblingCall.childOperationId, businessRegistrationCommitRef: siblingReceipt.businessRegistrationCommitRef },
    ]);
    assert.deepEqual(namespace.missingRefs, [receipt.businessRegistrationCommitRef.commitId,
      siblingReceipt.businessRegistrationCommitRef.commitId]);
    const exactParent = await provider.childAdmission.gateway.readControl({ ...selector, operationId: binding.parentOperationId });
    assert.deepEqual(exactParent, beforeControl);
    const pendingChild = await provider.childAdmission.gateway.readControl({ ...selector, operationId: call.childOperationId });
    assert.equal(pendingChild.state, 'unknown');
    if (pendingChild.state !== 'unknown') throw new Error('uncontrolled child must remain unknown');
    assert.deepEqual(pendingChild.pendingChildren, [namespace.pendingChildren![0]]);
    console.log('child operation admission adapter sibling proof', JSON.stringify({
      siblingReceipt, namespace, exactParent, pendingChild, bindingReadbacks: 2,
    }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('child operation admission adapter rejects parent epoch mismatch without child registration', async () => {
  const root = await childAdmissionRoot();
  try {
    const { provider, call, admit } = await childOperationAdmissionFixture(root);
    const before = await provider.organJournal.replay();
    await assert.rejects(() => admit({ ...call, parentExecution: { ...call.parentExecution, executionEpoch: 2 } }),
      /parent execution/);
    assert.deepEqual(await provider.organJournal.replay(), before);
    assert.equal(await provider.grants.readBusinessRegistration({ taskId: task,
      requestRef: ['provider-tool', call.parentExecution.runtimeId, '2', operation.value,
        call.providerRequestId, call.toolCallId].join(':'),
    }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('app assembly registers the deterministic operations route in the execution gateway', async () => {
  const gateway = createToolExecutionGateway({
    permissions: {
      async readGrant() {
        return { scope, revoked: false, evidenceRefs: [evidence('permission')] };
      },
    },
    taskBoundaries: {
      async readBoundary() {
        return { scope, evidenceRefs: [evidence('boundary')] };
      },
    },
    journal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  const submitted = await gateway.submit(intent(), operationControlBinding(intent()));
  const result = await gateway.execute(operation);

  assert.equal(submitted.operation.route?.routeId, 'deterministic-inspect');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result?.outputRef, 'artifact://operations/inspect/app-gateway-operation');
});

test('app assembly exposes code.search as one gateway operation over multiple internal function calls', async () => {
  const searchOperation = id('operation', 'app-code-search-operation');
  const searchScope: Scope = { organId: organ, taskId: task, cycleId: cycle };
  const searchIntent: OperationIntent = {
    operationId: searchOperation,
    taskId: task,
    cycleId: cycle,
    requestedBy: 'app-gateway-test',
    intentRevision: 'revision-1',
    kind: 'inspect',
    toolName: 'code.search',
    inputRef: 'artifact://input/code-search',
    inputDigest: 'sha256:code-search-input',
    requestedScope: searchScope,
    idempotencyKey: 'app-code-search-idempotency',
    expectedOutput: { schemaRef: 'schema://code.search.report/v1', requiredEvidenceKinds: ['tool'] },
  };
  const request = {
    serviceId: 'code.search' as const,
    contractVersion: '1.0.0' as const,
    workspaceRef: 'workspace://fixture',
    path: 'src',
    query: 'needle',
    queryKind: 'literal' as const,
  };
  const reports = new Map<string, CodeSearchReport>();
  class CodeSearchStore implements CodeSearchArtifactStore {
    async readRequest() { return request; }
    async writeReport(input: Parameters<CodeSearchArtifactStore['writeReport']>[0]) {
      const outputRef = `artifact://code-search/${input.operationId.value}`;
      const outputDigest = `sha256:report-${input.operationId.value}`;
      reports.set(outputRef, input.report);
      return { outputRef, outputDigest };
    }
    async readReport(input: Parameters<CodeSearchArtifactStore['readReport']>[0]) {
      const report = reports.get(input.outputRef);
      if (!report) throw new Error('missing code search report');
      return report;
    }
  }
  class Functions implements CodeSearchFunctions {
    calls = 0;
    async findFiles(): Promise<CodeSearchFileList> { this.calls += 1; return { paths: ['src/a.ts', 'src/b.ts'], complete: true, unresolvedPaths: [] }; }
    async readFile(input: { readonly workspaceRef: string; readonly path: string }): Promise<CodeSearchFileContent> { this.calls += 1; return { path: input.path, content: input.path.endsWith('a.ts') ? 'needle' : 'other' }; }
  }
  const functions = new Functions();
  const hand = createHandOperationRuntime({
    codeSearchRoute: new CodeSearchRoute({ functions, artifacts: new CodeSearchStore(), now: () => '2026-09-20T00:00:00.000Z' }),
    permissions: { async readGrant() { return { scope: searchScope, revoked: false, evidenceRefs: [evidence('code-search-permission')] }; } },
    taskBoundaries: { async readBoundary() { return { scope: searchScope, evidenceRefs: [evidence('code-search-boundary')] }; } },
    journal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  const result = await hand.execute({ intent: searchIntent, binding: operationControlBinding(searchIntent) });
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.operation.route?.routeId, 'code-search');
  assert.equal(result.operation.result?.outputRef, 'artifact://code-search/app-code-search-operation');
  assert.equal(functions.calls, 3);
});

test('Responses built-in tools execute write, edit, bash, todo, goal, and present through the provider executor', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp-provider-builtin-tools-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const admission = await createProviderToolAdmission({
    journalPath: join(root, 'operation-control.jsonl'),
    runtimeId: 'runtime-builtin-tools',
    executionEpoch: 1,
    parentOperationId: operation,
    parentScope: providerExecutionScope,
    inputRef: 'artifact://input/app-gateway',
  });
  const { executor } = createResponsesFileToolExecutor({
    workspaceRoot,
    projectKey: 'builtin-tools-project',
    artifactRoot: join(root, 'artifacts'),
    admission,
  });
  try {
    const run = async (toolId: string, arguments_: BusinessPayload, callId: string) => executor.execute({
      execution: { runtimeId: 'runtime-builtin-tools', taskId: task, operationId: operation, executionEpoch: 1 },
      scope: providerExecutionScope,
      requestId: `request-${callId}`,
      call: { callId, toolId, arguments: arguments_, continuationRef: 'response-builtin' },
      signal: new AbortController().signal,
    });

    const written = await run('file.write', {
      file_path: 'notes/hello.md',
      content: 'hello world\n',
    }, 'call-write');
    assert.equal(JSON.parse(written.output).operation, 'create');

    const edited = await run('file.edit', {
      file_path: 'notes/hello.md',
      old_string: 'world',
      new_string: 'agent',
    }, 'call-edit');
    assert.equal(JSON.parse(edited.output).after, 'hello agent\n');

    const shell = await run('bash', {
      command: 'node -p "JSON.stringify({ok:true})"',
      description: 'check node json output',
      workdir: '.',
    }, 'call-bash');
    assert.equal(JSON.parse(shell.output).exitCode, 0);
    assert.equal(JSON.parse(shell.output).stdout.text, '{"ok":true}\n');

    const todos = await run('todo_write', {
      todos: [
        { content: 'verify built-ins', status: 'in_progress' },
        { content: 'report evidence', status: 'pending' },
      ],
    }, 'call-todo');
    assert.equal(JSON.parse(todos.output).counts.inProgress, 1);

    const created = await run('create_goal', { objective: 'complete built-in provider tool coverage' }, 'call-create-goal');
    const createdGoal = JSON.parse(created.output).goal;
    assert.equal(createdGoal.phase, 'active');
    assert.equal(createdGoal.revision, 1);

    const completed = await run('update_goal', {
      goal_id: createdGoal.id,
      revision: createdGoal.revision,
      action: 'complete',
    }, 'call-update-goal');
    assert.equal(JSON.parse(completed.output).goal.phase, 'complete');

    const presented = await run('present', {
      files: [{ path: 'notes/hello.md', description: 'created built-in output' }],
    }, 'call-present');
    assert.deepEqual(JSON.parse(presented.output).files, [{
      path: 'notes/hello.md',
      description: 'created built-in output',
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app assembly exposes Hand as a thin semantic-intent boundary', async () => {
  const hand = createHandOperationRuntime({
    permissions: {
      async readGrant() {
        return { scope, revoked: false, evidenceRefs: [evidence('hand-permission')] };
      },
    },
    taskBoundaries: {
      async readBoundary() {
        return { scope, evidenceRefs: [evidence('hand-boundary')] };
      },
    },
    journal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  const result = await hand.execute({ intent: intent(), binding: operationControlBinding(intent()) });

  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.operation.route?.routeId, 'deterministic-inspect');
});

test('Responses file.read executes through Hand and returns actual bound-workspace content', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp-provider-file-tool-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'README.md'), 'REAL_README_CONTENT\n', 'utf8');
  const admission = await createProviderToolAdmission({
    journalPath: join(root, 'operation-control.jsonl'),
    runtimeId: 'runtime-file-tool',
    executionEpoch: 1,
    parentOperationId: operation,
    parentScope: providerExecutionScope,
    inputRef: 'artifact://input/app-gateway',
  });
  const { executor } = createResponsesFileToolExecutor({
    workspaceRoot,
    projectKey: 'fixture-project',
    artifactRoot: join(root, 'artifacts'),
    admission,
  });
  try {
    const result = await executor.execute({
      execution: { runtimeId: 'runtime-file-tool', taskId: task, operationId: operation, executionEpoch: 1 },
      scope: providerExecutionScope,
      requestId: 'request-call-readme',
      call: {
        callId: 'call-readme',
        toolId: 'file.read',
        arguments: { path: './README.md' },
        continuationRef: 'response-1',
      },
      signal: new AbortController().signal,
    });

    assert.deepEqual(JSON.parse(result.output), {
      workspaceRef: 'workspace:fixture-project',
      path: 'README.md',
      content: 'REAL_README_CONTENT\n',
    });
    assert.equal(result.outputRefs[0], 'asset://provider-tool/output/provider-tool-app-gateway-operation-call-readme');
    assert.equal(result.evidenceRefs.some((ref) => ref.source === 'humanagent.operations.file-read'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every provider tool report reads back from its descriptor alone, so a restarted store still serves file.read', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp-provider-tool-report-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'README.md'), 'REPORT_MARKER\n', 'utf8');
  const artifactRoot = join(root, 'artifacts');
  const admission = await createProviderToolAdmission({
    journalPath: join(root, 'operation-control.jsonl'),
    runtimeId: 'runtime-tool-report',
    executionEpoch: 1,
    parentOperationId: operation,
    parentScope: providerExecutionScope,
    inputRef: 'artifact://input/app-gateway',
  });
  const first = createResponsesFileToolExecutor({ workspaceRoot, projectKey: 'report-project', artifactRoot, admission });
  try {
    const run = (toolId: string, arguments_: BusinessPayload, callId: string) => first.executor.execute({
      execution: { runtimeId: 'runtime-tool-report', taskId: task, operationId: operation, executionEpoch: 1 },
      scope: providerExecutionScope,
      requestId: `request-${callId}`,
      call: { callId, toolId, arguments: arguments_, continuationRef: 'response-report' },
      signal: new AbortController().signal,
    });
    const read = await run('file.read', { path: 'README.md' }, 'call-report-read');
    const search = await run('file.search', { path: '.', query: 'REPORT_MARKER', queryKind: 'literal' }, 'call-report-search');
    const readRef = read.outputRef;
    const readDigest = read.outputDigest;
    const searchRef = search.outputRef;
    const searchDigest = search.outputDigest;
    if (readRef === undefined || readDigest === undefined || searchRef === undefined || searchDigest === undefined) {
      throw new Error('both provider tool results must carry an immutable report descriptor');
    }

    // A second executor over the same artifact root holds no in-process report
    // index. Both reports must resolve from their descriptor, so a restarted
    // runtime can still serve the task-scoped tool-output route for file.read
    // exactly as it does for file.search.
    const restarted = createResponsesFileToolExecutor({ workspaceRoot, projectKey: 'report-project', artifactRoot });
    const readReport = await restarted.toolOutputs.readReport({ outputRef: readRef, outputDigest: readDigest });
    assert.match(JSON.stringify(readReport), /REPORT_MARKER/);
    const searchReport = await restarted.toolOutputs.readReport({ outputRef: searchRef, outputDigest: searchDigest });
    assert.match(JSON.stringify(searchReport), /REPORT_MARKER/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Responses file.read rejects an already-aborted call before Hand admission', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp-provider-file-tool-abort-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'README.md'), 'MUST_NOT_BE_READ\n', 'utf8');
  const artifactRoot = join(root, 'artifacts');
  const { executor } = createResponsesFileToolExecutor({ workspaceRoot, projectKey: 'fixture-project', artifactRoot });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      () => executor.execute({
        execution: { runtimeId: 'runtime-file-tool', taskId: task, operationId: operation, executionEpoch: 1 },
        scope,
        call: { callId: 'call-readme-aborted', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'response-1' },
        signal: controller.signal,
      }),
      (error) => error instanceof Error && error.name === 'AbortError',
    );
    await assert.rejects(() => access(join(artifactRoot, 'operation-journal.jsonl')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app assembly rejects an adapter observation with a different operation identity', async () => {
  const foreignOperation = id('operation', 'app-gateway-foreign-operation');
  class MismatchedRoute extends DeterministicInspectRoute {
    override async execute(input: Parameters<DeterministicInspectRoute['execute']>[0]) {
      const observation = await super.execute(input);
      return { ...observation, operationId: foreignOperation };
    }
  }
  const mismatchJournal = recordingJournal();
  const gateway = createToolExecutionGateway({
    route: new MismatchedRoute(),
    permissions: {
      async readGrant() {
        return { scope, revoked: false, evidenceRefs: [evidence('permission-mismatch')] };
      },
    },
    taskBoundaries: {
      async readBoundary() {
        return { scope, evidenceRefs: [evidence('boundary-mismatch')] };
      },
    },
    journal: mismatchJournal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  const mismatchIntent = { ...intent(), idempotencyKey: 'app-gateway-mismatch-idempotency' };
  await gateway.submit(mismatchIntent, operationControlBinding(mismatchIntent));
  const result = await gateway.execute(operation);

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.failureClass, 'contract');
  assert.equal(result.failure?.owner, 'humanagent.operations-adapter');
  assert.equal(result.failure?.nextAction.ref, 'deterministic-inspect');
  assert.match(result.failure?.message ?? '', /different operation/);
  assert.equal(result.failure?.evidenceRefs.length, 1);
  assert.equal(result.failure?.evidenceRefs[0]?.source, 'humanagent.operations-adapter');
  assert.equal(result.result?.failure, result.failure);
  assert.equal(mismatchJournal.committed.at(-1)?.failure, result.failure);
});

test('app assembly rejects an adapter verification result with a different operation identity', async () => {
  const foreignOperation = id('operation', 'app-gateway-foreign-verification');
  class MismatchedVerifierRoute extends DeterministicInspectRoute {
    override async verify(input: Parameters<DeterministicInspectRoute['verify']>[0]) {
      const result = await super.verify(input);
      return { ...result, operationId: foreignOperation };
    }
  }
  const mismatchJournal = recordingJournal();
  const gateway = createToolExecutionGateway({
    route: new MismatchedVerifierRoute(),
    permissions: {
      async readGrant() {
        return { scope, revoked: false, evidenceRefs: [evidence('permission-verification-mismatch')] };
      },
    },
    taskBoundaries: {
      async readBoundary() {
        return { scope, evidenceRefs: [evidence('boundary-verification-mismatch')] };
      },
    },
    journal: mismatchJournal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  const verificationMismatchIntent = { ...intent(), idempotencyKey: 'app-gateway-verification-mismatch-idempotency' };
  await gateway.submit(verificationMismatchIntent, operationControlBinding(verificationMismatchIntent));
  const result = await gateway.execute(operation);

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.failureClass, 'contract');
  assert.equal(result.failure?.owner, 'humanagent.operations-adapter');
  assert.equal(result.failure?.nextAction.ref, 'deterministic-inspect');
  assert.match(result.failure?.message ?? '', /verification result for a different operation/);
  assert.equal(result.failure?.evidenceRefs.length, 1);
  assert.equal(result.failure?.evidenceRefs[0]?.source, 'humanagent.operations-adapter');
  assert.equal(result.result?.failure, result.failure);
  assert.equal(mismatchJournal.committed.at(-1)?.failure, result.failure);
});
