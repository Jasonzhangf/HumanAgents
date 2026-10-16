import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type JournalCommitRef,
  type OperationEvent,
  type OperationIntent,
  type Scope,
  type ScopeRef,
  type ToolRegistration,
} from '../../../packages/contracts/src/index.js';
import {
  HandOperationRuntime,
  ToolExecutionGateway,
  ToolRegistry,
  type OperationControlBinding,
  type OperationControlReadback,
  type OperationControlRecord,
  type OperationControlSelector,
  type OperationCoverageInitialization,
  type OperationExecutorPort,
  type OperationExecutorObservation,
  type OperationJournalPort,
  type OperationPermissionPort,
  type OperationTaskBoundaryPort,
  type OperationVerifierPort,
} from '../../../packages/runtime/src/index.js';

const organ = id('organ', 'hand-runtime-organ');
const task = id('task', 'hand-runtime-task');
const cycle = id('cycle', 'hand-runtime-cycle');
const operation = id('operation', 'hand-runtime-operation');
const scope: Scope = { organId: organ, taskId: task, cycleId: cycle };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `hand-runtime-${label}`),
    kind: 'tool',
    source: 'hand-runtime-test',
    locator: `hand-runtime://${label}`,
    scope: { ...scope, operationId: operation },
  };
}

function commitRef(label: string, journalSeq: number): JournalCommitRef {
  return { commitId: `commit-${label}`, journalSeq, recordDigest: `sha256:${label}` };
}

function scopeRefKey(target: ScopeRef): string {
  return [
    target.organId.value,
    target.taskId?.value ?? '',
    target.cycleId?.value ?? '',
    target.operationId?.value ?? '',
  ].join('|');
}

/**
 * Parent Harness runtime admission binding for one Hand operation. The parent
 * operation identity and admission receipt name this operation's own admission,
 * matching the real Harness binding construction.
 */
function controlBinding(overrides: Partial<OperationControlBinding> = {}): OperationControlBinding {
  return {
    scope,
    agentRuntimeId: 'hand-runtime-agent',
    harnessExecutionEpoch: 1,
    parentOperationId: operation,
    admissionCommitRef: commitRef('hand-runtime-admission', 1),
    ...overrides,
  };
}

function intent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  return {
    operationId: operation,
    taskId: task,
    cycleId: cycle,
    requestedBy: 'implicit-brain',
    intentRevision: 'intent-r1',
    kind: 'inspect',
    toolName: 'code.symbol_search',
    inputRef: 'artifact://hand/search-request',
    inputDigest: 'sha256:hand-search-request',
    requestedScope: scope,
    idempotencyKey: 'hand-runtime-request',
    expectedOutput: {
      schemaRef: 'schema://code.symbol-search.report/v1',
      requiredEvidenceKinds: ['tool'],
    },
    ...overrides,
  };
}

function registration(): ToolRegistration {
  return {
    toolName: 'code.symbol_search',
    contractVersion: '1.0.0',
    supportedKinds: ['inspect'],
    routeId: 'code-symbol-search',
    routeVersion: '1.0.0',
    mode: 'gateway',
    acceptedScopes: [{}],
    inputContract: 'schema://code.symbol-search.request/v1',
    outputContract: 'schema://code.symbol-search.report/v1',
    verifier: 'verifier://code.symbol-search/v1',
    capabilities: ['workspace.search'],
    retryPolicy: 'retry://read-only/v1',
    owner: 'operations.code-search',
  };
}

class Permissions implements OperationPermissionPort, OperationTaskBoundaryPort {
  async readGrant() {
    return { scope, revoked: false, evidenceRefs: [evidence('permission')] };
  }

  async readBoundary() {
    return { scope, evidenceRefs: [evidence('boundary')] };
  }
}

class Journal implements OperationJournalPort {
  readonly events: OperationEvent[] = [];
  readonly controls: OperationControlRecord[] = [];
  readonly controlCommits: JournalCommitRef[] = [];
  readonly coverage = new Map<string, JournalCommitRef>();
  private sequence = 0;

  private append(digest: string): JournalCommitRef {
    this.sequence += 1;
    return {
      commitId: `journal-commit-${this.sequence}`,
      journalSeq: this.sequence,
      recordDigest: `sha256:${digest}`,
    };
  }

  async commit(event: OperationEvent, control: OperationControlRecord): Promise<JournalCommitRef> {
    const ref = this.append(`control-${event.kind}`);
    this.events.push(event);
    this.controls.push(control);
    this.controlCommits.push(ref);
    return ref;
  }

  async readControl(input: OperationControlSelector): Promise<OperationControlReadback> {
    const key = scopeRefKey(input.scope);
    const coverageRef = this.coverage.get(key);
    if (coverageRef === undefined) {
      return {
        state: 'unknown',
        scope: input.scope,
        reason: 'operation control coverage was never initialized for this scope',
        missingRefs: [],
      };
    }
    const scoped = this.controls
      .map((control, index) => ({ control, commit: this.controlCommits[index] }))
      .filter(({ control }) => scopeRefKey(control.binding.scope) === key);
    return {
      state: 'complete',
      scope: input.scope,
      coverageCommitRef: coverageRef,
      currentControlCommitRef: scoped.at(-1)?.commit ?? coverageRef,
      operations: scoped.map(({ control }) => control),
      operationCommits: scoped.map(({ commit }) => commit),
    };
  }

  async initializeCoverage(input: OperationCoverageInitialization): Promise<JournalCommitRef> {
    const ref = this.append(`coverage-${input.scope.taskId?.value ?? 'scope'}`);
    this.coverage.set(scopeRefKey(input.scope), ref);
    return ref;
  }
}

class SemanticRoute implements OperationExecutorPort, OperationVerifierPort {
  calls = 0;
  internalSteps = 0;
  outcome: OperationExecutorObservation['status'] = 'completed';

  async execute(input: Parameters<OperationExecutorPort['execute']>[0]): Promise<OperationExecutorObservation> {
    this.calls += 1;
    // The virtual route owns the continuous search operation. These are not
    // Hand-visible tool decisions and must not become separate gateway calls.
    this.internalSteps = 3;
    if (this.outcome === 'blocked') {
      return {
        executionEpoch: input.lease.executionEpoch,
        status: 'blocked',
        evidenceRefs: [evidence('blocked')],
        owner: 'operations.code-search',
        sideEffectState: 'none',
        nextAction: { kind: 'recover', ref: 'code-symbol-search' },
        message: 'search route requires a narrower workspace scope',
      };
    }
    return {
      executionEpoch: input.lease.executionEpoch,
      status: 'completed',
      outputRef: 'artifact://hand/search-report',
      outputDigest: 'sha256:hand-search-report',
      evidenceRefs: [evidence('route')],
      owner: 'operations.code-search',
      sideEffectState: 'none',
    };
  }

  async verify(input: Parameters<OperationVerifierPort['verify']>[0]) {
    return {
      executionEpoch: input.observation.executionEpoch,
      accepted: this.outcome === 'completed',
      decision: this.outcome === 'completed' ? 'search-report-verified' : 'search-report-rejected',
      evidenceRefs: [evidence('verification')],
      ...(this.outcome === 'completed' ? {} : { message: 'virtual route did not complete' }),
    };
  }
}

function setup(route = new SemanticRoute()) {
  const registry = new ToolRegistry();
  registry.load([registration()]);
  const permissions = new Permissions();
  const journal = new Journal();
  const gateway = new ToolExecutionGateway({
    registry,
    permissions,
    taskBoundaries: permissions,
    executor: route,
    verifier: route,
    journal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });
  return { hand: new HandOperationRuntime(gateway), route, journal };
}

test('Hand sends one complete semantic operation to the virtual tool gateway', async () => {
  const context = setup();
  const result = await context.hand.execute({ intent: intent(), binding: controlBinding() });

  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.operation.result?.outputRef, 'artifact://hand/search-report');
  assert.equal(context.route.calls, 1);
  assert.equal(context.route.internalSteps, 3);
  assert.deepEqual(
    context.journal.events.map((event) => event.kind),
    ['operation.accepted', 'operation.queued', 'operation.leased', 'operation.started', 'operation.verification_started', 'operation.completed'],
  );
});

test('Hand returns a virtual route failure without claiming success or inventing recovery', async () => {
  const route = new SemanticRoute();
  route.outcome = 'blocked';
  const context = setup(route);
  const result = await context.hand.execute({ intent: intent({ idempotencyKey: 'hand-runtime-blocked' }), binding: controlBinding() });

  assert.equal(result.operation.status, 'blocked');
  assert.equal(result.operation.blocked?.nextAction.ref, 'code-symbol-search');
  assert.equal(result.operation.result, undefined);
  assert.equal(context.route.calls, 1);
  assert.equal(context.journal.events.at(-1)?.kind, 'operation.blocked');
});

test('terminal replay does not re-enter the semantic route', async () => {
  const context = setup();
  const first = await context.hand.execute({ intent: intent(), binding: controlBinding() });
  const second = await context.hand.execute({ intent: intent(), binding: controlBinding() });

  assert.equal(first.operation.status, 'succeeded');
  assert.equal(second.submission.decision, 'replay');
  assert.equal(second.operation.status, 'succeeded');
  assert.equal(context.route.calls, 1);
});

test('concurrent replay does not start a second gateway execution or throw', async () => {
  const context = setup();
  const [first, second] = await Promise.all([
    context.hand.execute({ intent: intent(), binding: controlBinding() }),
    context.hand.execute({ intent: intent(), binding: controlBinding() }),
  ]);

  assert.equal(first.operation.status, 'succeeded');
  assert.equal(second.submission.decision, 'replay');
  assert.equal(second.operation.status, 'succeeded');
  assert.equal(context.route.calls, 1);
});

test('blocked replay is returned to the orchestrator and is not silently retried', async () => {
  const route = new SemanticRoute();
  route.outcome = 'blocked';
  const context = setup(route);
  const first = await context.hand.execute({ intent: intent({ idempotencyKey: 'hand-runtime-blocked-replay' }), binding: controlBinding() });
  const second = await context.hand.execute({ intent: intent({ idempotencyKey: 'hand-runtime-blocked-replay' }), binding: controlBinding() });

  assert.equal(first.operation.status, 'blocked');
  assert.equal(second.submission.decision, 'replay');
  assert.equal(second.operation.status, 'blocked');
  assert.equal(context.route.calls, 1);
});
