import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type OperationEvent,
  type OperationIntent,
  type Scope,
  type ToolRegistration,
} from '../../../packages/contracts/src/index.js';
import {
  GatewayError,
  OperationNotificationError,
  ToolExecutionGateway,
  ToolRegistry,
  type OperationExecutorObservation,
  type OperationExecutorPort,
  type OperationJournalPort,
  type OperationPermissionPort,
  type OperationStopSettlementPort,
  type OperationStopSettlementReceipt,
  type OperationTaskBoundaryPort,
  type OperationVerifierPort,
} from '../../../packages/runtime/src/gateway/index.js';

const organ = id('organ', 'organ-g3');
const task = id('task', 'task-g3');
const otherTask = id('task', 'task-g3-other');
const cycle = id('cycle', 'cycle-g3');
const operation = id('operation', 'operation-g3');
const requestedScope: Scope = { organId: organ, taskId: task, cycleId: cycle };

function evidence(label: string, scope: Scope = requestedScope): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'gateway-test',
    locator: `records/${label}`,
    scope,
  };
}

function intent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  return {
    operationId: operation,
    taskId: task,
    cycleId: cycle,
    requestedBy: 'agent-g3',
    intentRevision: 'directive-r1',
    kind: 'inspect',
    toolName: 'file.inspect',
    inputRef: 'artifact://input-g3',
    inputDigest: 'sha256:input-g3',
    requestedScope,
    idempotencyKey: 'idempotency-g3',
    expectedOutput: {
      schemaRef: 'schema://inspect-output/v1',
      requiredEvidenceKinds: ['operation'],
    },
    ...overrides,
  };
}

function registration(overrides: Partial<ToolRegistration> = {}): ToolRegistration {
  return {
    toolName: 'file.inspect',
    contractVersion: '1.0.0',
    supportedKinds: ['inspect'],
    routeId: 'deterministic-file-route',
    routeVersion: '1.0.0',
    mode: 'gateway',
    acceptedScopes: [{ organId: organ, taskId: task }],
    inputContract: 'schema://inspect-input/v1',
    outputContract: 'schema://inspect-output/v1',
    verifier: 'verifier://inspect/v1',
    capabilities: ['file.read'],
    retryPolicy: 'retry://read-only/v1',
    owner: 'operations-adapter',
    ...overrides,
  };
}

function observation(overrides: Partial<OperationExecutorObservation> = {}): OperationExecutorObservation {
  return {
    executionEpoch: 1,
    status: 'completed',
    outputRef: 'artifact://output-g3',
    outputDigest: 'sha256:output-g3',
    evidenceRefs: [evidence('executor')],
    owner: 'operations-adapter',
    sideEffectState: 'none',
    ...overrides,
  };
}

class MutablePermissions implements OperationPermissionPort {
  revoked = false;
  scope: Scope = requestedScope;

  async readGrant() {
    return {
      scope: this.scope,
      revoked: this.revoked,
      evidenceRefs: [evidence('permission')],
    };
  }
}

class Boundary implements OperationTaskBoundaryPort {
  scope: Scope = requestedScope;

  async readBoundary() {
    return {
      scope: this.scope,
      evidenceRefs: [evidence('boundary')],
    };
  }
}

class Executor implements OperationExecutorPort {
  readonly requests: Parameters<OperationExecutorPort['execute']>[0][] = [];
  next: OperationExecutorObservation = observation();

  async execute(input: Parameters<OperationExecutorPort['execute']>[0]) {
    this.requests.push(input);
    return this.next;
  }
}

class Verifier implements OperationVerifierPort {
  readonly requests: Parameters<OperationVerifierPort['verify']>[0][] = [];
  next: Awaited<ReturnType<OperationVerifierPort['verify']>> = {
    executionEpoch: 1,
    accepted: true,
    decision: 'accepted',
    evidenceRefs: [evidence('verifier')],
  };

  async verify(input: Parameters<OperationVerifierPort['verify']>[0]) {
    this.requests.push(input);
    return this.next;
  }
}

class Journal implements OperationJournalPort {
  readonly committed: OperationEvent[] = [];
  readonly published: OperationEvent[] = [];
  failPublishOnceFor?: OperationEvent['kind'];
  failPublishError?: Error;

  async commit(event: OperationEvent): Promise<void> {
    this.committed.push(event);
  }

  async publishCommitted(event: OperationEvent): Promise<void> {
    if (this.failPublishOnceFor === event.kind) {
      this.failPublishOnceFor = undefined;
      throw this.failPublishError ?? new Error(`publish failed: ${event.kind}`);
    }
    this.published.push(event);
  }
}

class StopSettlement implements OperationStopSettlementPort {
  readonly requests: Parameters<OperationStopSettlementPort['settle']>[0][] = [];
  receipt?: OperationStopSettlementReceipt;

  async settle(input: Parameters<OperationStopSettlementPort['settle']>[0]) {
    this.requests.push(input);
    return this.receipt ?? {
      receiptId: 'stop-receipt-g3',
      operationId: input.intent.operationId,
      taskId: input.intent.taskId,
      executionEpoch: input.executionEpoch,
      owner: input.owner,
      ...(input.lease ? { leaseId: input.lease.leaseId } : {}),
      stopped: true,
      sideEffectState: 'none' as const,
      evidenceRefs: [evidence('stop-settlement')],
    };
  }
}

function setup(overrides: {
  readonly registration?: Partial<ToolRegistration>;
  readonly executor?: Executor;
  readonly verifier?: Verifier;
  readonly journal?: Journal;
  readonly stopSettlement?: StopSettlement;
} = {}) {
  const registry = new ToolRegistry();
  registry.load([registration(overrides.registration)]);
  const permissions = new MutablePermissions();
  const boundary = new Boundary();
  const executor = overrides.executor ?? new Executor();
  const verifier = overrides.verifier ?? new Verifier();
  const journal = overrides.journal ?? new Journal();
  const stopSettlement = overrides.stopSettlement ?? new StopSettlement();
  const gateway = new ToolExecutionGateway({
    registry,
    permissions,
    taskBoundaries: boundary,
    executor,
    stopSettlement,
    verifier,
    journal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });
  return { gateway, registry, permissions, boundary, executor, verifier, journal, stopSettlement };
}

test('normal inspect operation follows accepted to terminal and commits before publishing', async () => {
  const context = setup();
  const submitted = await context.gateway.submit(intent());

  assert.equal(submitted.decision, 'new');
  assert.equal(submitted.operation.status, 'accepted');
  assert.deepEqual(
    context.journal.committed.map((event) => event.kind),
    ['operation.accepted'],
  );
  assert.deepEqual(
    context.journal.published.map((event) => event.kind),
    ['operation.accepted'],
  );

  const result = await context.gateway.execute(operation);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.result?.status, 'succeeded');
  assert.equal(result.result?.outputRef, 'artifact://output-g3');
  assert.equal(context.executor.requests.length, 1);
  assert.equal(context.verifier.requests.length, 1);
  assert.deepEqual(
    context.journal.committed.map((event) => event.kind),
    [
      'operation.accepted',
      'operation.queued',
      'operation.leased',
      'operation.started',
      'operation.verification_started',
      'operation.completed',
    ],
  );
  assert.deepEqual(context.journal.committed, context.journal.published);
  assert.equal(result.route?.effectiveScope.taskId?.value, task.value);
});

test('duplicate same fingerprint replays without executor and different fingerprint conflicts', async () => {
  const context = setup();
  const first = await context.gateway.submit(intent());
  const replay = await context.gateway.submit(intent());

  assert.equal(first.decision, 'new');
  assert.equal(replay.decision, 'replay');
  assert.equal(replay.operation.operationId.value, operation.value);
  assert.equal(context.executor.requests.length, 0);
  await assert.rejects(
    () => context.gateway.submit(intent({ inputDigest: 'sha256:changed' })),
    (error: unknown) => error instanceof GatewayError && error.code === 'idempotency-conflict',
  );
});

test('post-commit publish failure keeps accepted operation and idempotency stable', async () => {
  const journal = new Journal();
  journal.failPublishOnceFor = 'operation.accepted';
  const context = setup({ journal });

  await assert.rejects(
    () => context.gateway.submit(intent()),
    (error: unknown) => {
      assert.ok(error instanceof OperationNotificationError);
      assert.equal(error.code, 'notification-failed');
      assert.equal(error.event.kind, 'operation.accepted');
      return true;
    },
  );

  const replay = await context.gateway.submit(intent());
  assert.equal(replay.decision, 'replay');
  assert.equal(replay.operation.status, 'accepted');
  assert.equal(context.journal.committed.length, 1);
  assert.equal(context.journal.published.length, 0);
  assert.equal(context.executor.requests.length, 0);
});

test('concurrent execute leases and invokes executor once', async () => {
  const executor = new Executor();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalExecute = executor.execute.bind(executor);
  executor.execute = async (input) => {
    await gate;
    return originalExecute(input);
  };
  const context = setup({ executor });
  await context.gateway.submit(intent());

  const first = context.gateway.execute(operation);
  const second = context.gateway.execute(operation);
  const resultsPromise = Promise.allSettled([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();

  const results = await resultsPromise;
  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[1]?.status, 'rejected');
  if (results[1]?.status === 'rejected') {
    assert.ok(results[1].reason instanceof GatewayError);
    assert.equal(results[1].reason.code, 'invalid-state');
  }
  assert.equal(context.executor.requests.length, 1);
  assert.equal(
    context.journal.committed.filter((event) => event.kind === 'operation.leased').length,
    1,
  );
});

test('in-flight execution can be cancelled and settled without waiting for executor completion', async () => {
  const executor = new Executor();
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const originalExecute = executor.execute.bind(executor);
  executor.execute = async (input) => {
    started();
    await releasePromise;
    return originalExecute(input);
  };
  const context = setup({ executor });
  await context.gateway.submit(intent());

  const running = context.gateway.execute(operation);
  await startedPromise;
  assert.equal((await context.gateway.requestCancel(operation)).status, 'cancel_requested');
  assert.equal((await context.gateway.settleCancellation(operation)).status, 'cancelled');
  release();
  assert.equal((await running).status, 'cancelled');
  assert.equal(context.gateway.get(operation).status, 'cancelled');
});

test('scope widening and missing route are rejected before acceptance', async () => {
  const context = setup();
  assert.throws(
    () => context.registry.resolve(intent({ requestedScope: { organId: organ, taskId: otherTask } })),
    (error: unknown) => error instanceof GatewayError && error.code === 'route-not-found',
  );
  assert.throws(
    () => context.registry.resolve(intent({ toolName: 'missing.tool' })),
    (error: unknown) => error instanceof GatewayError && error.code === 'route-not-found',
  );
  assert.equal(context.journal.committed.length, 0);
});

test('stale executor epoch becomes a durable blocked recovery state', async () => {
  const executor = new Executor();
  executor.next = observation({ executionEpoch: 99 });
  const context = setup({ executor });
  await context.gateway.submit(intent());

  const result = await context.gateway.execute(operation);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blocked?.blockedAfter, 'execution');
  assert.equal(result.blocked?.sideEffectState, 'possible');
  assert.equal(result.blocked?.retryAllowed, false);
  assert.equal(result.blocked?.nextAction.ref, 'reconcile');
  assert.equal(context.verifier.requests.length, 0);
  assert.equal(context.journal.committed.at(-1)?.kind, 'operation.blocked');
  assert.equal(context.gateway.get(operation).status, 'blocked');
});

test('stale verifier epoch becomes a durable blocked recovery state', async () => {
  const verifier = new Verifier();
  verifier.next = {
    executionEpoch: 99,
    accepted: true,
    decision: 'accepted',
    evidenceRefs: [evidence('verifier-stale')],
  };
  const context = setup({ verifier });
  await context.gateway.submit(intent());

  const result = await context.gateway.execute(operation);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blocked?.blockedAfter, 'verification');
  assert.equal(result.blocked?.sideEffectState, 'possible');
  assert.equal(context.journal.committed.at(-1)?.kind, 'operation.blocked');
  assert.equal(context.gateway.get(operation).status, 'blocked');
});

test('gateway durable identifiers are unique across runtime instances', async () => {
  const first = setup();
  const second = setup();
  await first.gateway.submit(intent());
  await second.gateway.submit(intent());
  await first.gateway.execute(operation);
  await second.gateway.execute(operation);

  assert.ok(first.journal.committed[0]?.eventId !== second.journal.committed[0]?.eventId);
  const firstQueued = first.journal.committed.find((event) => event.kind === 'operation.queued');
  const secondQueued = second.journal.committed.find((event) => event.kind === 'operation.queued');
  assert.ok(
    firstQueued?.evidenceRefs[0]?.evidenceId.value !== secondQueued?.evidenceRefs[0]?.evidenceId.value,
  );
});

test('verifier failure records owner, failure evidence, and failed result', async () => {
  const verifier = new Verifier();
  verifier.next = {
    executionEpoch: 1,
    accepted: false,
    decision: 'rejected',
    evidenceRefs: [evidence('verifier-rejected')],
    message: 'output digest does not match contract',
  };
  const context = setup({ verifier });
  await context.gateway.submit(intent());

  const result = await context.gateway.execute(operation);

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.owner, 'operations-adapter');
  assert.equal(result.failure?.phase, 'verification');
  assert.equal(result.failure?.failureClass, 'verifier');
  assert.equal(result.result?.status, 'failed');
  assert.equal(result.failure?.evidenceRefs.length, 2);
  assert.equal(context.journal.committed.at(-1)?.kind, 'operation.failed');
});

test('structured adapter failures with mismatched identity or phase fall back to synthesized failures', async () => {
  const executor = new Executor();
  executor.execute = async (input) => {
    executor.requests.push(input);
    throw {
      failure: {
        errorId: 'adapter-failure-mismatch',
        operationId: id('operation', 'foreign-operation'),
        owner: 'humanagent.operations-adapter',
        phase: 'execution',
        failureClass: 'contract',
        message: 'foreign operation failure',
        observedAt: '2026-09-20T00:00:00.000Z',
        impact: 'must not be trusted',
        protectiveAction: 'fall back to runtime failure synthesis',
        nextAction: { kind: 'recover', ref: 'deterministic-inspect' },
        evidenceRefs: [evidence('foreign-failure')],
      },
    };
  };
  const context = setup({ executor });
  await context.gateway.submit(intent());

  const result = await context.gateway.execute(operation);

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.failureClass, 'executor');
  assert.equal(result.failure?.owner, 'operations-adapter');
  assert.ok(result.failure?.errorId !== 'adapter-failure-mismatch');
  assert.ok(!/foreign operation failure/.test(result.failure?.message ?? ''));
});

test('structured verifier failures with the wrong phase fall back to synthesized failures', async () => {
  const verifier = new Verifier();
  verifier.verify = async (input) => {
    verifier.requests.push(input);
    throw {
      failure: {
        errorId: 'verifier-phase-mismatch',
        operationId: operation,
        owner: 'humanagent.operations-adapter',
        phase: 'execution',
        failureClass: 'contract',
        message: 'execution failure from verifier',
        observedAt: '2026-09-20T00:00:00.000Z',
        impact: 'must not be trusted',
        protectiveAction: 'fall back to runtime failure synthesis',
        nextAction: { kind: 'recover', ref: 'deterministic-inspect' },
        evidenceRefs: [evidence('wrong-phase-failure')],
      },
    };
  };
  const context = setup({ verifier });
  await context.gateway.submit(intent());

  const result = await context.gateway.execute(operation);

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.phase, 'verification');
  assert.equal(result.failure?.failureClass, 'verifier');
  assert.ok(result.failure?.errorId !== 'verifier-phase-mismatch');
  assert.ok(!/execution failure from verifier/.test(result.failure?.message ?? ''));
});

test('malformed structured failures fall back to synthesized failures', async () => {
  const executor = new Executor();
  executor.execute = async (input) => {
    executor.requests.push(input);
    throw {
      failure: {
        operationId: operation,
        phase: 'execution',
      },
    };
  };
  const context = setup({ executor });
  await context.gateway.submit(intent());

  const result = await context.gateway.execute(operation);

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.failureClass, 'executor');
  assert.equal(result.failure?.owner, 'operations-adapter');
  assert.ok(result.failure?.errorId.startsWith('runtime-gateway-error-'));
});

test('blocked after execution resumes verify-only without double execution', async () => {
  const executor = new Executor();
  executor.next = observation({
    status: 'blocked',
    owner: 'operations-adapter',
    nextAction: { kind: 'recover', ref: 'verify-only' },
    conditionRef: 'digest-pending',
    message: 'verification evidence is pending',
  });
  const context = setup({ executor });
  await context.gateway.submit(intent());

  const blocked = await context.gateway.execute(operation);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocked?.blockedAfter, 'execution');

  const resumed = await context.gateway.resume(operation, {
    blockedAfter: 'execution',
    sideEffectState: 'none',
    retryAllowed: false,
    evidenceRefs: [evidence('resume')],
  });

  assert.equal(resumed.status, 'succeeded');
  assert.equal(context.executor.requests.length, 1);
  assert.equal(context.verifier.requests.length, 1);
  assert.equal(context.journal.committed.some((event) => event.kind === 'operation.queued' && event.executionEpoch > 1), false);
});

test('blocked execution recovery can be cancelled while the resumed executor is running', async () => {
  const executor = new Executor();
  let resumedStarted!: () => void;
  const resumedStartedPromise = new Promise<void>((resolve) => {
    resumedStarted = resolve;
  });
  let releaseResumed!: () => void;
  const releaseResumedPromise = new Promise<void>((resolve) => {
    releaseResumed = resolve;
  });
  executor.execute = async (input) => {
    executor.requests.push(input);
    if (executor.requests.length === 1) {
      return observation({
        status: 'blocked',
        owner: 'operations-adapter',
        sideEffectState: 'none',
        nextAction: { kind: 'recover', ref: 'retry-execution' },
        message: 'execution may be retried',
      });
    }
    resumedStarted();
    await releaseResumedPromise;
    return observation({ executionEpoch: input.lease.executionEpoch });
  };
  const context = setup({ executor });
  await context.gateway.submit(intent());

  const blocked = await context.gateway.execute(operation);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocked?.blockedAfter, 'execution');

  const resumed = context.gateway.resume(operation, {
    blockedAfter: 'execution',
    sideEffectState: 'none',
    retryAllowed: true,
  });
  await resumedStartedPromise;

  const cancelPromise = context.gateway.requestCancel(operation);
  const cancel = await Promise.race([
    cancelPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
  ]);
  if (cancel === null) {
    releaseResumed();
    await resumed.catch(() => undefined);
    await cancelPromise.catch(() => undefined);
    throw new Error('requestCancel waited for the resumed executor instead of settling during execution');
  }
  assert.equal(cancel.status, 'cancel_requested');

  const settled = await context.gateway.settleCancellation(operation);
  assert.equal(settled.status, 'cancelled');
  releaseResumed();

  assert.equal((await resumed).status, 'cancelled');
  assert.equal(context.executor.requests.length, 2);
  assert.equal(context.gateway.get(operation).status, 'cancelled');
});

test('reconcile_required does not execute again and can resolve through blocked verify-only', async () => {
  const executor = new Executor();
  executor.next = observation({
    status: 'reconcile_required',
    owner: 'operations-adapter',
    sideEffectState: 'possible',
    message: 'external effect state is unknown',
  });
  const context = setup({ executor });
  await context.gateway.submit(intent());

  const reconciled = await context.gateway.execute(operation);
  assert.equal(reconciled.status, 'reconcile_required');
  assert.equal(context.executor.requests.length, 1);

  const blocked = await context.gateway.resolveReconcile(operation, {
    outcome: 'recovered',
    evidenceRefs: [evidence('reconcile-recovered')],
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocked?.blockedAfter, 'reconcile');
  assert.equal(blocked.blocked?.sideEffectState, 'possible');

  const verified = await context.gateway.resume(operation, {
    evidenceRefs: [evidence('reconcile-resume')],
  });
  assert.equal(verified.status, 'succeeded');
  assert.equal(context.executor.requests.length, 1);
  assert.equal(context.verifier.requests.length, 1);
});

test('forged cancellation settlement cannot reach cancelled', async () => {
  const context = setup();
  await context.gateway.submit(intent());
  const requested = await context.gateway.requestCancel(operation);
  assert.equal(requested.status, 'cancel_requested');

  context.stopSettlement.receipt = {
    receiptId: 'forged-stop-receipt',
    operationId: id('operation', 'other-operation'),
    taskId: task,
    executionEpoch: 1,
    owner: 'operations-adapter',
    stopped: true,
    sideEffectState: 'none',
    evidenceRefs: [evidence('forged-stop')],
  };

  await assert.rejects(
    () => context.gateway.settleCancellation(operation),
    (error: unknown) => error instanceof GatewayError && error.code === 'invalid-state',
  );
  assert.equal(context.gateway.get(operation).status, 'cancel_requested');
});

test('cancellation settlement rejects invalid lifecycle status without stop request', async () => {
  const context = setup();
  await context.gateway.submit(intent());

  await assert.rejects(
    () => context.gateway.settleCancellation(operation),
    (error: unknown) => error instanceof GatewayError && error.code === 'invalid-state',
  );

  assert.equal(context.stopSettlement.requests.length, 0);
  assert.equal(context.gateway.get(operation).status, 'accepted');
});

test('trusted stop settlement reaches cancelled and positive reconcile', async () => {
  const context = setup();
  await context.gateway.submit(intent());
  await context.gateway.requestCancel(operation);

  const settled = await context.gateway.settleCancellation(operation);
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.result?.status, 'cancelled');
  assert.equal(context.stopSettlement.requests.length, 1);
  assert.equal(context.journal.committed.at(-1)?.kind, 'operation.cancelled');

  const reconcile = setup();
  await reconcile.gateway.submit(intent());
  await reconcile.gateway.requestCancel(operation);
  reconcile.stopSettlement.receipt = {
    receiptId: 'stop-receipt-possible',
    operationId: operation,
    taskId: task,
    executionEpoch: 1,
    owner: 'operations-adapter',
    stopped: false,
    sideEffectState: 'possible',
    evidenceRefs: [evidence('stop-possible')],
  };

  const blocked = await reconcile.gateway.settleCancellation(operation);
  assert.equal(blocked.status, 'reconcile_required');
  assert.equal(blocked.reconcile?.sideEffectState, 'possible');
  assert.equal(reconcile.journal.committed.at(-1)?.kind, 'operation.reconcile_required');
});

test('pre-execution cancellation settles without fabricating a lease', async () => {
  const context = setup();
  await context.gateway.submit(intent());
  await context.gateway.requestCancel(operation);

  const settled = await context.gateway.settleCancellation(operation);

  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.lease, undefined);
  assert.equal(context.stopSettlement.requests[0]?.lease, undefined);
  assert.equal(context.stopSettlement.requests[0]?.executionEpoch, 1);
});

test('permission revocation prevents lease and records failure without execution', async () => {
  const context = setup();
  await context.gateway.submit(intent());
  context.permissions.revoked = true;

  const failed = await context.gateway.execute(operation);

  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure?.failureClass, 'permission');
  assert.equal(failed.result?.status, 'failed');
  assert.equal(context.executor.requests.length, 0);
  assert.equal(context.verifier.requests.length, 0);
  assert.equal(context.journal.committed.at(-1)?.kind, 'operation.failed');
});
