import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentIoRequestCoordinator,
  createMemoryRestartBudgetStore,
  decodeControlBlock,
  type AgentIoClock,
  type AgentIoEvent,
  type AgentIoPolicy,
  type AgentIoProviderBinding,
  type AgentIoRequestControl,
  type AgentIoRequestCoordinatorOptions,
  type AgentIoRestartBudgetStore,
} from '../../../packages/runtime/src/agent-io/index.js';
import { createHookRegistry, type AgentHookRegistry } from '../../../packages/runtime/src/hooks/index.js';

function providerBinding(): AgentIoProviderBinding {
  return {
    bindingId: 'binding-agent-io',
    providerId: 'fake',
    protocol: 'responses',
    endpointRef: 'config://fake',
    modelRef: 'model://fake',
    configDigest: 'config-digest',
    capabilityDigest: 'capability-digest',
    owner: 'agent-io-owner',
  };
}

function requestControl(override?: Partial<AgentIoRequestControl>): AgentIoRequestControl {
  return {
    protocolVersion: 1,
    requestId: 'request-agent-io',
    attemptId: 'attempt-1',
    binding: {
      kind: 'task',
      taskId: 'task-agent-io',
      assignmentId: 'assignment-agent-io',
      executionEpoch: 1,
      bindingFingerprint: 'binding-fingerprint',
      provider: providerBinding(),
    },
    contextViewRef: 'context://agent-io',
    permissionRevision: 'permission-1',
    idempotencyKey: 'idempotency-1',
    replyMode: 'stream',
    ...override,
  };
}

function requestData(): AgentIoRequestCoordinatorOptions['data'] {
  return {
    inputRefs: ['asset://input'],
    outputContractRef: 'output-contract',
    capabilitySetRef: 'capabilities://agent',
  };
}

function fakeClock(): { readonly clock: AgentIoClock; now: number } {
  const state = { now: 0 };
  return {
    clock: { now: () => state.now },
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
  };
}

type TestClock = ReturnType<typeof fakeClock>;

function coordinatorOptions(
  store: AgentIoRestartBudgetStore,
  clock: TestClock,
  policy?: Partial<AgentIoPolicy>,
  hooks?: AgentHookRegistry,
  onEvent: (event: AgentIoEvent) => void = () => undefined,
): AgentIoRequestCoordinatorOptions {
  return {
    control: requestControl(),
    data: requestData(),
    clock: clock.clock,
    budgetStore: store,
    onEvent,
    hooks,
    policy,
  };
}

function collectEvents(): { readonly events: AgentIoEvent[]; readonly onEvent: (event: AgentIoEvent) => void } {
  const events: AgentIoEvent[] = [];
  return {
    events,
    onEvent: (event) => {
      events.push(event);
    },
  };
}

const VALID_CONTROL = JSON.stringify({
  summary: 'completed the requested work',
  disposition: 'continue',
  goal: { status: 'in-progress' },
});

test('request lifecycle starts through admitted, dispatch, and attempt stages', async () => {
  const store = createMemoryRestartBudgetStore();
  const clock = fakeClock();
  const { events, onEvent } = collectEvents();
  const coordinator = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock, undefined, undefined, onEvent));

  assert.equal(coordinator.snapshot().status, 'created');
  const started = await coordinator.start();
  assert.equal(started.status, 'running');
  assert.equal(started.attempt.status, 'running');
  assert.equal(started.closed, false);
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      'request.created',
      'request.admitted',
      'request.before-dispatch',
      'request.dispatched',
      'attempt.started',
    ],
  );

});

test('streamed deltas decode into one end-turn control and persist turn budget', async () => {
  const store = createMemoryRestartBudgetStore();
  const clock = fakeClock();
  const coordinator = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock));
  await coordinator.start();

  await coordinator.acceptChunk({
    sequence: 1,
    sourceRef: 'response:1',
    kind: 'delta',
    text: '{"summary":"mostly done",',
  });
  await coordinator.acceptChunk({
    sequence: 2,
    sourceRef: 'response:1',
    kind: 'delta',
    text: '"disposition":"continue","goal":',
  });
  await coordinator.acceptChunk({
    sequence: 3,
    sourceRef: 'response:1',
    kind: 'delta',
    text: '{"status":"in-progress"}}',
  });

  const result = await coordinator.endTurn({ sourceRef: 'response:1' });
  assert.equal(result.accepted, true);
  assert.equal(result.decode?.status, 'valid');
  assert.equal(coordinator.budgetRecord().totalTurns, 1);
  assert.equal(coordinator.snapshot().totalTurns, 1);
  assert.equal(coordinator.snapshot().attempt.turnNumber, 1);
  assert.equal(coordinator.latestControlBlock()?.summary, 'mostly done');
});

test('partial control decode exposes missing fields and keeps partial raw evidence', () => {
  const decoded = decodeControlBlock({
    sourceRef: 'response:partial',
    raw: '{"summary":"working","phase":"executing","goal":{"status":',
  });
  assert.equal(decoded.status, 'partial');
  assert.equal(decoded.completeness, 'partial');
  assert.match(decoded.partialRaw ?? '', /working/);

  const minimal = decodeControlBlock({
    sourceRef: 'response:minimal',
    raw: VALID_CONTROL,
  });
  assert.equal(minimal.status, 'valid');
  assert.equal(minimal.completeness, 'partial');
  assert.ok(minimal.absentFields.includes('turnRef'));
  assert.ok(minimal.absentFields.includes('next'));
});

test('missing end-turn summary enters bounded repair and then protocol-noncompliant closure', async () => {
  const store = createMemoryRestartBudgetStore();
  const clock = fakeClock();
  const coordinator = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock, {
    maxControlRepairAttempts: 2,
    maxNoProgressTurns: 10,
  }));
  await coordinator.start();

  const first = await coordinator.endTurn({ raw: '{"phase":"continue"}', sourceRef: 'turn:1' });
  assert.equal(first.accepted, false);
  assert.equal(first.repairRequired, true);
  assert.equal(coordinator.budgetRecord().controlRepairAttempts, 1);
  assert.equal(coordinator.snapshot().closed, false);

  const second = await coordinator.repair({ raw: '{"phase":"continue"}', sourceRef: 'turn:2' });
  assert.equal(second.accepted, false);
  assert.equal(coordinator.budgetRecord().controlRepairAttempts, 2);
  assert.equal(coordinator.snapshot().closed, false);

  const third = await coordinator.repair({ raw: '{"phase":"continue"}', sourceRef: 'turn:3' });
  assert.equal(third.accepted, false);
  assert.equal(coordinator.snapshot().closed, true);
  assert.equal(coordinator.snapshot().status, 'failed');
  assert.equal(coordinator.snapshot().attempt.status, 'failed');
  assert.equal(coordinator.budgetRecord().controlRepairAttempts, 3);
});

test('provider transport EOF is not completion and closes the request as incomplete', async () => {
  const store = createMemoryRestartBudgetStore();
  const clock = fakeClock();
  const { events, onEvent } = collectEvents();
  const coordinator = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock, undefined, undefined, onEvent));
  await coordinator.start();

  const closure = await coordinator.endOfStream({ sourceRef: 'response:eof', cursor: 'cursor:eof' });
  assert.equal(closure.status, 'incomplete');
  assert.equal(coordinator.snapshot().status, 'incomplete');
  assert.equal(coordinator.snapshot().closed, true);
  assert.deepEqual(
    events.map((event) => event.kind).filter((kind) => kind === 'transport.eof' || kind === 'request.settled'),
    ['transport.eof', 'request.settled'],
  );
  await assert.rejects(
    coordinator.acceptChunk({ sequence: 1, sourceRef: 'late', kind: 'delta', text: 'late' }),
    /request is closed/,
  );
});

test('watchdog closes the request on silent duration and no-progress turns', async () => {
  const store = createMemoryRestartBudgetStore();
  const clock = fakeClock();
  const silence = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock, {
    maxSilentDurationMs: 1_000,
    maxTurnDurationMs: 60_000,
  }));
  await silence.start();
  clock.now = 1_001;
  const silentClosure = await silence.checkWatchdog();
  assert.equal(silentClosure?.status, 'incomplete');
  assert.equal(silence.snapshot().status, 'incomplete');

  const progressStore = createMemoryRestartBudgetStore();
  const progressClock = fakeClock();
  const progress = await AgentIoRequestCoordinator.create(coordinatorOptions(progressStore, progressClock, {
    maxTotalTurns: 10,
    maxNoProgressTurns: 1,
    maxSilentDurationMs: 60_000,
    maxTurnDurationMs: 60_000,
    noProgressAtMs: undefined,
  }));
  await progress.start();
  await progress.endTurn({ raw: VALID_CONTROL, sourceRef: 'turn:1' });
  const noProgressClosure = await progress.checkWatchdog();
  assert.equal(noProgressClosure?.status, 'incomplete');
  assert.equal(progress.budgetRecord().noProgressTurns, 1);
});

test('watchdog applies max turn duration even while chunks keep the stream active', async () => {
  const store = createMemoryRestartBudgetStore();
  const clock = fakeClock();
  const coordinator = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock, {
    maxSilentDurationMs: 5_000,
    maxTurnDurationMs: 1_000,
    maxTotalTurns: 10,
    maxNoProgressTurns: 10,
    noProgressAtMs: undefined,
  }));
  await coordinator.start();

  for (let sequence = 1; sequence <= 4; sequence += 1) {
    clock.now = sequence * 100;
    await coordinator.acceptChunk({
      sequence,
      sourceRef: 'response:streaming',
      kind: 'delta',
      text: `chunk-${sequence}`,
    });
  }

  clock.now = 1_000;
  const closure = await coordinator.checkWatchdog();
  assert.equal(closure?.status, 'incomplete');
  assert.equal(closure?.reason, 'max turn duration reached');
  assert.equal(coordinator.snapshot().status, 'incomplete');
  assert.equal(coordinator.snapshot().closed, true);
});

test('watchdog applies max turn duration per accepted turn, not attempt lifetime', async () => {
  const store = createMemoryRestartBudgetStore();
  const clock = fakeClock();
  const coordinator = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock, {
    maxSilentDurationMs: 60_000,
    maxTurnDurationMs: 1_000,
    maxTotalTurns: 10,
    maxNoProgressTurns: 10,
    noProgressAtMs: undefined,
  }));
  await coordinator.start();

  clock.now = 900;
  const first = await coordinator.endTurn({ raw: VALID_CONTROL, sourceRef: 'turn:1' });
  assert.equal(first.accepted, true);

  clock.now = 1_000;
  assert.equal(await coordinator.checkWatchdog(), undefined);

  clock.now = 1_800;
  const second = await coordinator.repair({ raw: VALID_CONTROL, sourceRef: 'turn:2' });
  assert.equal(second.accepted, true);

  clock.now = 2_700;
  assert.equal(await coordinator.checkWatchdog(), undefined);
  assert.equal(coordinator.budgetRecord().totalTurns, 2);
  assert.equal(coordinator.snapshot().closed, false);
});

test('restart budget persists across creates and rejects exhausted restarts', async () => {
  const store = createMemoryRestartBudgetStore();
  const clock = fakeClock();
  const first = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock, {
    restartBudget: 1,
  }));
  await first.start();
  await first.endTurn({ raw: VALID_CONTROL, sourceRef: 'turn:1' });
  assert.equal(first.budgetRecord().restartCount, 0);
  assert.equal(first.budgetRecord().totalTurns, 1);

  const second = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock, {
    restartBudget: 1,
  }));
  assert.equal(second.budgetRecord().restartCount, 1);
  assert.equal(second.budgetRecord().totalTurns, 1);

  await assert.rejects(
    AgentIoRequestCoordinator.create(coordinatorOptions(store, clock, {
      restartBudget: 1,
    })),
    /restart budget is exhausted/,
  );
});

test('control blocks cannot carry provider or binding fields and close as protocol-noncompliant', async () => {
  const topLevel = decodeControlBlock({
    sourceRef: 'response:bad-top',
    raw: '{"summary":"ok","provider":"wrong"}',
  });
  assert.equal(topLevel.status, 'malformed');
  assert.ok(topLevel.rejectedBindings?.includes('provider'));

  const nested = decodeControlBlock({
    sourceRef: 'response:bad-nested',
    raw: '{"control":{"summary":"ok","modelRef":"wrong"}}',
  });
  assert.equal(nested.status, 'malformed');
  assert.ok(nested.rejectedBindings?.includes('modelRef'));

  const store = createMemoryRestartBudgetStore();
  const clock = fakeClock();
  const coordinator = await AgentIoRequestCoordinator.create(coordinatorOptions(store, clock));
  await coordinator.start();
  const result = await coordinator.endTurn({
    sourceRef: 'response:bad-coordinator',
    raw: '{"control":{"summary":"ok","modelRef":"wrong"}}',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'control block contains forbidden binding fields: modelRef');
  assert.equal(coordinator.snapshot().closed, true);
  assert.equal(coordinator.snapshot().status, 'failed');
  assert.equal(coordinator.snapshot().attempt.status, 'failed');
});

test('core hooks block request start and observation hook failures remain visible', async () => {
  const clock = fakeClock();
  const blockedEvents = collectEvents();
  const blockedRegistry = createHookRegistry(blockedEvents.onEvent, clock.clock.now);
  blockedRegistry.add({
    hookId: 'core-gate',
    version: '1',
    mode: 'core',
    stages: ['request.created'],
    onEnter: async () => ({ status: 'waiting', diagnostics: ['need user approval'], ownerId: 'policy-owner' }),
  });
  const blockedStore = createMemoryRestartBudgetStore();
  const blocked = await AgentIoRequestCoordinator.create(coordinatorOptions(blockedStore, clock, undefined, blockedRegistry, blockedEvents.onEvent));
  await assert.rejects(blocked.start(), /core hook blocked/);
  assert.ok(blockedEvents.events.some((event) => event.kind === 'hook.completed' && event.hookId === 'core-gate'));

  const visibleEvents = collectEvents();
  const visibleRegistry = createHookRegistry(visibleEvents.onEvent, clock.clock.now);
  visibleRegistry.add({
    hookId: 'observer',
    version: '1',
    mode: 'observation',
    stages: ['request.admitted'],
    onEnter: async () => {
      throw new Error('observer failed');
    },
  });
  const visibleStore = createMemoryRestartBudgetStore();
  const visible = await AgentIoRequestCoordinator.create(coordinatorOptions(visibleStore, clock, undefined, visibleRegistry, visibleEvents.onEvent));
  const started = await visible.start();
  assert.equal(started.status, 'running');
  assert.ok(visibleEvents.events.some((event) => event.kind === 'hook.failed' && event.hookId === 'observer'));
});
