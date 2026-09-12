import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  type AgentDriver,
  type Attention,
  type Checkpoint,
  type EvidenceRef,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import { FakeAgentDriver } from '../../../packages/adapters/testing/src/index.js';
import { CoreError } from '../../../packages/core/src/index.js';
import { AgentRuntime, bindAgentDriver } from '../../../packages/runtime/src/nodes/agent-runtime.js';
import { RuntimeError } from '../../../packages/runtime/src/nodes/errors.js';
import {
  assertBusinessPayloadWithoutControlTruth,
  assertControlCommand,
  assertNoRequirementEnvelopePayload,
  ControlError,
  type SettleStopCommand,
} from '../../../packages/runtime/src/control/control-command.js';
import {
  fenceControlEvent,
  requestAgentStop,
  settleAgentStop,
  type CheckpointCommitPort,
} from '../../../packages/runtime/src/control/steering.js';
import { publishRequiredAttention, resolveAttention } from '../../../packages/runtime/src/control/attention.js';
import { executeStopControl, publishPendingStopAttention, resolvePendingStopAttention } from '../../../packages/runtime/src/control/runtime-stop.js';
import { superviseFailure } from '../../../packages/runtime/src/control/supervision.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const cycle = id('cycle', 'cycle-a');
const scope: ScopeRef = { organId: organ, taskId: task, cycleId: cycle };

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function evidence(label: string, scopeRef: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: label,
    scope: scopeRef,
  };
}

function scopedStopEvidenceDriver(delegate: AgentDriver, stopEvidenceRef: EvidenceRef): AgentDriver {
  return {
    kind: 'test.scoped-stop',
    capabilities: () => delegate.capabilities(),
    start: (input) => delegate.start(input),
    resume: (input) => delegate.resume(input),
    submit: (input) => delegate.submit(input),
    observe: (input) => delegate.observe(input),
    requestStop: (input) => delegate.requestStop(input),
    settle: async (input) => {
      const closure = await delegate.settle(input);
      return { ...closure, evidenceRefs: [stopEvidenceRef] };
    },
  };
}

async function stoppedSession(outcome: 'stopped' | 'succeeded' = 'stopped') {
  const runtimeId = `runtime-${outcome}`;
  const assignmentId = `assignment-${outcome}`;
  const delegate = new FakeAgentDriver({ [assignmentId]: outcome });
  const runtime = new AgentRuntime(delegate, {
    runtimeId,
    taskId: task,
    assignmentId,
    executionEpoch: 4,
    ownerRef: 'control-test-agent-runtime',
  });
  await runtime.start();
  await runtime.submit({ branch: outcome });
  const evidenceRecord = delegate.replay().at(-1);
  if (!evidenceRecord) throw new Error('missing fake evidence');
  const evidenceRef = evidence(`${outcome}-session`, { ...scope, operationId: evidenceRecord.operationId });
  const driver = scopedStopEvidenceDriver(delegate, evidenceRef);
  bindAgentDriver(runtime, driver);
  return {
    delegate,
    driver,
    runtimeId,
    assignmentId,
    runtime,
    operationId: evidenceRecord.operationId,
    evidenceRefs: [evidenceRef],
  };
}

function checkpointPort(): { readonly port: CheckpointCommitPort; readonly commits: Checkpoint[] } {
  const commits: Checkpoint[] = [];
  return {
    commits,
    port: {
      async commit(checkpoint) {
        commits.push(checkpoint);
        return { checkpointId: checkpoint.id, committed: true };
      },
    },
  };
}

function attentionPort(): { readonly port: { publish(input: Attention): Promise<{ attentionId: string; delivered: true }>; resolve(input: Attention): Promise<{ attentionId: string; delivered: true }> }; readonly published: Attention[]; readonly resolved: Attention[] } {
  const published: Attention[] = [];
  const resolved: Attention[] = [];
  return {
    published,
    resolved,
    port: {
      async publish(input) {
        published.push(input);
        return { attentionId: input.attentionId, delivered: true };
      },
      async resolve(input) {
        resolved.push(input);
        return { attentionId: input.attentionId, delivered: true };
      },
    },
  };
}

test('attention acknowledgements stay bound to the original id across a mutating port', async () => {
  const open: Attention = {
    attentionId: 'attention-original',
    scope,
    severity: 'blocker',
    state: 'open',
    message: 'attention',
    evidenceRefs: [],
  };
  const resolved: Attention = { ...open, state: 'resolved' };
  const port = {
    publish: async (input: Attention) => {
      try { (input as { attentionId: string }).attentionId = 'attention-forged'; } catch {}
      return { attentionId: 'attention-forged', delivered: true as const };
    },
    resolve: async (input: Attention) => {
      try { (input as { attentionId: string }).attentionId = 'attention-forged'; } catch {}
      return { attentionId: 'attention-forged', delivered: true as const };
    },
  };

  await assert.rejects(() => publishRequiredAttention(port, open), ControlError);
  await assert.rejects(() => resolveAttention(port, resolved), ControlError);
  assert.equal(open.attentionId, 'attention-original');
  assert.equal(resolved.attentionId, 'attention-original');
});

test('steer request is control-channel bound and rejects business requirement payloads', async () => {
  const session = await stoppedSession();
  const command = {
    source: 'control' as const,
    command: 'steer.request-stop' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    organId: organ,
    taskId: task,
    executionEpoch: 4,
    currentState: 'running' as const,
    runtimeId: session.runtimeId,
  };

  const result = await requestAgentStop({
    command,
    driver: session.driver,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: session.operationId,
    ownerId: 'control-owner',
  });
  assert.equal(result.state, 'settling');
  assert.equal(result.receipt.requested, true);
  assert.deepEqual(result.nextAction, { kind: 'wait', ref: `agent-settle:${session.runtimeId}:4` });

  assert.doesNotThrow(() => assertControlCommand(command));
  assert.throws(() => assertControlCommand({ ...command, source: 'business-payload' }), ControlError);
  assert.throws(() => assertNoRequirementEnvelopePayload({ ...command, requirementId: 'requirement-1' }), ControlError);
  assert.doesNotThrow(() => assertBusinessPayloadWithoutControlTruth({ prompt: 'business input' }));
  assert.throws(() => assertBusinessPayloadWithoutControlTruth({ retry: true }), ControlError);
});

test('control command validation rejects malformed discriminated control inputs', () => {
  const request = {
    source: 'control' as const,
    command: 'steer.request-stop' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    organId: organ,
    taskId: task,
    executionEpoch: 4,
    currentState: 'running' as const,
    runtimeId: 'runtime-a',
  };
  const operationId = id('operation', 'operation-a');
  const settleScope = { organId: organ, taskId: task, cycleId: cycle, operationId };
  const settle = {
    source: 'control' as const,
    command: 'steer.settle-stop' as const,
    runtimeId: 'runtime-a',
    executionEpoch: 4,
    operationId,
    scope: settleScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null as null,
    checkpointSeq: 1,
    directiveRevision: 2,
    stopReason: 'operator-steer',
  };

  assert.doesNotThrow(() => assertControlCommand(request));
  assert.doesNotThrow(() => assertControlCommand(settle));
  assert.doesNotThrow(() => assertControlCommand({
    ...settle,
    checkpointSeq: 2,
    previousCheckpoint: {
      id: id('checkpoint', 'checkpoint-0'),
      scope: settleScope,
      cycleId: cycle,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 3,
      outcome: 'waiting',
      summary: 'awaiting stop approval',
      recoveryStateRef: evidence('previous', settleScope),
      evidenceRefs: [evidence('previous-operation', settleScope)],
      next: { kind: 'wait', ref: 'approval' },
    },
  }));

  const malformed: readonly unknown[] = [
    null,
    [],
    'control',
    { source: 'control', command: 'steer.request-stop' },
    { ...request, source: 'business-payload' },
    { ...request, command: 'steer.unknown' },
    { ...request, actorKind: 'agent' },
    { ...request, hasStopPermission: false },
    { ...request, hasStopPermission: 'true' },
    { ...request, runtimeId: '   ' },
    { ...request, organId: { scope: 'task', value: task.value } },
    { ...request, organId: { scope: 'organ', value: '' } },
    { ...request, taskId: { scope: 'task', value: 4 } },
    { ...request, executionEpoch: 0 },
    { ...request, executionEpoch: 1.5 },
    { ...request, currentState: 'not-a-state' },
    { source: 'control', command: 'steer.settle-stop' },
    { ...settle, operationId: id('task', 'task-a') },
    { ...settle, operationId: { scope: 'operation', value: '' } },
    { ...settle, scope: { ...settleScope, operationId: id('operation', 'operation-other') } },
    { ...settle, scope: { ...settleScope, taskId: undefined } },
    { ...settle, scope: { ...settleScope, cycleId: undefined } },
    { ...settle, scope: { ...settleScope, cycleId: id('cycle', 'cycle-other') } },
    { ...settle, scope: { ...settleScope, operationId: undefined } },
    { ...settle, scope: undefined },
    { ...settle, cycleId: undefined },
    { ...settle, cycleId: id('task', 'cycle-a') },
    { ...settle, runtimeId: '' },
    { ...settle, checkpointSeq: 0 },
    { ...settle, checkpointSeq: 2 },
    { ...settle, directiveRevision: -1 },
    { ...settle, directiveRevision: 0 },
    { ...settle, stopReason: '' },
    { ...settle, previousCheckpoint: {} },
  ];

  for (const value of malformed) {
    assert.throws(() => assertControlCommand(value), ControlError);
  }
});

test('steer request rejects stale epoch and driver receipt mismatch', async () => {
  const session = await stoppedSession();
  const command = {
    source: 'control' as const,
    command: 'steer.request-stop' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    organId: organ,
    taskId: task,
    executionEpoch: 4,
    currentState: 'running' as const,
    runtimeId: session.runtimeId,
  };

  await assert.rejects(
    requestAgentStop({
      command: { ...command, executionEpoch: 5 },
      driver: session.driver,
      currentOrganId: organ,
      currentTaskId: task,
      currentEpoch: 4,
      operationId: session.operationId,
      ownerId: 'control-owner',
    }),
    CoreError,
  );
  await assert.rejects(
    requestAgentStop({
      command,
      driver: session.driver,
      currentOrganId: organ,
      currentTaskId: task,
      currentEpoch: 4,
      operationId: id('operation', 'wrong-operation'),
      ownerId: 'control-owner',
    }),
    ContractError,
  );
});

test('settle commits stopped checkpoint only after actual stopped AgentClosure', async () => {
  const session = await stoppedSession();
  const operationScope: ScopeRef = { ...scope, operationId: session.operationId };
  const checkpointStore = checkpointPort();
  const command = {
    source: 'control' as const,
    command: 'steer.settle-stop' as const,
    runtimeId: session.runtimeId,
    executionEpoch: 4,
    operationId: session.operationId,
    scope: operationScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 2,
    stopReason: 'operator-steer',
  };
  const request = await requestAgentStop({
    command: { ...command, command: 'steer.request-stop', actorKind: 'human-operator', hasStopPermission: true, organId: organ, taskId: task, currentState: 'running' },
    driver: session.driver,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: session.operationId,
    ownerId: 'control-owner',
  });
  const receipt = await settleAgentStop({
    command,
    driver: session.driver,
    stopRequestCommand: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: session.runtimeId,
    },
    stopReceipt: request.receipt,
    checkpointPort: checkpointStore.port,
    recoveryStateRef: evidence('recovery', operationScope),
  });

  assert.equal(receipt.state, 'stopped');
  assert.equal(receipt.checkpoint.outcome, 'stopped');
  assert.deepEqual(receipt.nextAction, { kind: 'stop', ref: 'operator-steer' });
  assert.equal(checkpointStore.commits.length, 1);
  assert.equal(checkpointStore.commits[0]?.evidenceRefs.length, 1);

  const succeeded = await stoppedSession('succeeded');
  const succeededRequest = await requestAgentStop({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: succeeded.runtimeId,
    },
    driver: succeeded.driver,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: succeeded.operationId,
    ownerId: 'control-owner',
  });
  await assert.rejects(
    settleAgentStop({
      command: { ...command, runtimeId: succeeded.runtimeId, operationId: succeeded.operationId },
      driver: succeeded.driver,
      stopRequestCommand: {
        source: 'control',
        command: 'steer.request-stop',
        actorKind: 'human-operator',
        hasStopPermission: true,
        organId: organ,
        taskId: task,
        executionEpoch: 4,
        currentState: 'running',
        runtimeId: succeeded.runtimeId,
      },
      stopReceipt: succeededRequest.receipt,
      checkpointPort: checkpointPort().port,
      recoveryStateRef: evidence('recovery-succeeded', { ...scope, operationId: succeeded.operationId }),
    }),
    ControlError,
  );
});

test('stop scope rejects organ, task, cycle, and operation mismatches with original request before commit', async () => {
  const session = await stoppedSession();
  const operationScope: ScopeRef = { ...scope, operationId: session.operationId };
  const requestCommand = {
    source: 'control' as const,
    command: 'steer.request-stop' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    organId: organ,
    taskId: task,
    executionEpoch: 4,
    currentState: 'running' as const,
    runtimeId: session.runtimeId,
  };
  const mismatches: readonly { readonly label: string; readonly scope: ScopeRef }[] = [
    { label: 'organ', scope: { ...operationScope, organId: id('organ', 'organ-b') } },
    { label: 'task', scope: { ...operationScope, taskId: id('task', 'task-b') } },
    { label: 'cycle', scope: { ...operationScope, cycleId: id('cycle', 'cycle-b') } },
    { label: 'operation', scope: { ...operationScope, operationId: id('operation', 'operation-b') } },
  ];

  for (const mismatch of mismatches) {
    const store = checkpointPort();
    const attention = attentionPort();
    await assert.rejects(
      () => executeStopControl({
        command: requestCommand,
        driver: session.driver,
        checkpointPort: store.port,
        attentionPort: attention.port,
        currentOrganId: organ,
        currentTaskId: task,
        currentEpoch: 4,
        operationId: session.operationId,
        scope: mismatch.scope,
        cycleId: cycle,
        ownerId: 'control-owner',
        previousCheckpoint: null,
        checkpointSeq: 1,
        directiveRevision: 2,
        stopReason: 'operator-steer',
        recoveryStateRef: evidence(`recovery-${mismatch.label}`, mismatch.scope),
        runtime: session.runtime,
      }),
      ControlError,
    );
    assert.equal(store.commits.length, 0, `${mismatch.label} mismatch must not commit`);
    assert.equal(attention.published.length, 0);
  }
});

test('settle stop rejects originating request, cycle identity, and directive revision mismatches before commit', async () => {
  const session = await stoppedSession();
  const operationScope: ScopeRef = { ...scope, operationId: session.operationId };
  const stopRequestCommand = {
    source: 'control' as const,
    command: 'steer.request-stop' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    organId: organ,
    taskId: task,
    executionEpoch: 4,
    currentState: 'running' as const,
    runtimeId: session.runtimeId,
  };
  const command: SettleStopCommand = {
    source: 'control',
    command: 'steer.settle-stop',
    runtimeId: session.runtimeId,
    executionEpoch: 4,
    operationId: session.operationId,
    scope: operationScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 2,
    stopReason: 'operator-steer',
  };
  const previousCheckpoint = {
    id: id('checkpoint', 'checkpoint-previous'),
    scope: operationScope,
    cycleId: cycle,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: 3,
    outcome: 'waiting' as const,
    summary: 'awaiting stop approval',
    recoveryStateRef: evidence('previous-recovery', operationScope),
    evidenceRefs: [evidence('previous-operation', operationScope)],
    next: { kind: 'wait' as const, ref: 'approval' },
  };
  const request = await requestAgentStop({
    command: stopRequestCommand,
    driver: session.driver,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: session.operationId,
    ownerId: 'control-owner',
  });
  const invalidCommands: readonly { readonly label: string; readonly command: unknown; readonly stopRequestCommand?: typeof stopRequestCommand }[] = [
    {
      label: 'missing-scope-cycle',
      command: { ...command, scope: { ...operationScope, cycleId: undefined } },
    },
    {
      label: 'missing-command-cycle',
      command: { ...command, cycleId: undefined },
    },
    {
      label: 'previous-cycle-mismatch',
      command: { ...command, checkpointSeq: 2, previousCheckpoint: { ...previousCheckpoint, cycleId: id('cycle', 'cycle-b') } },
    },
    {
      label: 'previous-zero-revision',
      command: { ...command, checkpointSeq: 2, previousCheckpoint: { ...previousCheckpoint, directiveRevision: 0 } },
    },
    {
      label: 'scope-cycle-mismatch',
      command: { ...command, scope: { ...operationScope, cycleId: id('cycle', 'cycle-b') } },
    },
    {
      label: 'zero-directive-revision',
      command: { ...command, directiveRevision: 0 },
    },
    { label: 'origin-organ-mismatch', command, stopRequestCommand: { ...stopRequestCommand, organId: id('organ', 'organ-b') } },
    { label: 'origin-task-mismatch', command, stopRequestCommand: { ...stopRequestCommand, taskId: id('task', 'task-b') } },
  ];

  for (const invalid of invalidCommands) {
    const store = checkpointPort();
    await assert.rejects(
      () => settleAgentStop({
        command: invalid.command as SettleStopCommand,
        stopRequestCommand: invalid.stopRequestCommand ?? stopRequestCommand,
        driver: session.driver,
        stopReceipt: request.receipt,
        checkpointPort: store.port,
        recoveryStateRef: evidence(`recovery-${invalid.label}`, operationScope),
      }),
      ControlError,
    );
    assert.equal(store.commits.length, 0, `${invalid.label} must not commit`);
  }
});

test('settle stop rejects evidence outside the stopped checkpoint scope before commit', async () => {
  const session = await stoppedSession();
  const operationScope: ScopeRef = { ...scope, operationId: session.operationId };
  const stopRequestCommand = {
    source: 'control' as const,
    command: 'steer.request-stop' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    organId: organ,
    taskId: task,
    executionEpoch: 4,
    currentState: 'running' as const,
    runtimeId: session.runtimeId,
  };
  const command: SettleStopCommand = {
    source: 'control',
    command: 'steer.settle-stop',
    runtimeId: session.runtimeId,
    executionEpoch: 4,
    operationId: session.operationId,
    scope: operationScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 2,
    stopReason: 'operator-steer',
  };
  const request = await requestAgentStop({
    command: stopRequestCommand,
    driver: session.driver,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: session.operationId,
    ownerId: 'control-owner',
  });
  const mismatches: readonly { readonly label: string; readonly scope: ScopeRef }[] = [
    { label: 'organ', scope: { ...operationScope, organId: id('organ', 'organ-b') } },
    { label: 'task', scope: { ...operationScope, taskId: id('task', 'task-b') } },
    { label: 'cycle', scope: { ...operationScope, cycleId: id('cycle', 'cycle-b') } },
    { label: 'operation', scope: { ...operationScope, operationId: id('operation', 'operation-b') } },
  ];

  for (const mismatch of mismatches) {
    const store = checkpointPort();
    const driver = scopedStopEvidenceDriver(session.driver, evidence(`out-of-scope-${mismatch.label}`, mismatch.scope));
    await assert.rejects(
      () => settleAgentStop({
        command,
        stopRequestCommand,
        driver,
        stopReceipt: request.receipt,
        checkpointPort: store.port,
        recoveryStateRef: evidence('recovery', operationScope),
      }),
      ControlError,
    );
    assert.equal(store.commits.length, 0, `${mismatch.label} evidence must not commit`);
  }
});

test('stop control returns stopped or keeps settling with Attention when settle cannot close', async () => {
  const session = await stoppedSession();
  const operationScope: ScopeRef = { ...scope, operationId: session.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  const stoppedResult = await executeStopControl({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: session.runtimeId,
    },
    driver: session.driver,
    checkpointPort: store.port,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: session.operationId,
    scope: operationScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 2,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('recovery', operationScope),
    runtime: session.runtime,
  });
  assert.equal(stoppedResult.state, 'stopped');
  if (stoppedResult.state !== 'stopped') throw new Error('expected stopped result');
  assert.equal(store.commits.length, 1);
  assert.equal(attention.published.length, 0);

  const pending = await stoppedSession('succeeded');
  const pendingScope: ScopeRef = { ...scope, operationId: pending.operationId };
  const pendingStore = checkpointPort();
  const pendingAttention = attentionPort();
  let settleCalls = 0;
  const retryDriver: AgentDriver = {
    ...pending.driver,
    settle: async (input) => {
      settleCalls += 1;
      if (settleCalls === 1) return { state: 'succeeded', evidenceRefs: [] };
      return { state: 'stopped', evidenceRefs: pending.evidenceRefs };
    },
  };
  bindAgentDriver(pending.runtime, retryDriver);
  const pendingResult = await executeStopControl({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: pending.runtimeId,
    },
    driver: retryDriver,
    checkpointPort: pendingStore.port,
    attentionPort: pendingAttention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: pending.operationId,
    scope: pendingScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 2,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('recovery-pending', pendingScope),
    runtime: pending.runtime,
  });
  assert.equal(pendingResult.state, 'settling');
  if (pendingResult.state !== 'settling') throw new Error('expected settling result');
  assert.equal(pendingAttention.published.length, 1);
  assert.equal(pendingResult.attentionId, `stop-pending-${pending.operationId.value}`);
  await assert.rejects(() => pending.runtime.submit({ branch: 'after-pending-stop' }), RuntimeError);
  await assert.rejects(async () => {
    for await (const _observation of pending.runtime.observe()) {
      break;
    }
  }, RuntimeError);

  const retryResult = await executeStopControl({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: pending.runtimeId,
    },
    driver: retryDriver,
    checkpointPort: pendingStore.port,
    attentionPort: pendingAttention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: pending.operationId,
    scope: pendingScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 2,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('recovery-pending', pendingScope),
    runtime: pending.runtime,
  });
  assert.equal(retryResult.state, 'stopped');
  assert.equal(pending.runtime.snapshot().state, 'stopped');
  assert.equal(pending.runtime.snapshot().closure?.state, 'stopped');
  assert.deepEqual(pending.runtime.snapshot().closure?.evidenceRefs, pending.evidenceRefs);
  assert.equal(settleCalls, 2);
  assert.equal(pendingStore.commits.length, 1);
  assert.equal(pendingAttention.published.length, 1);
  assert.equal(pendingAttention.resolved.length, 1);
  assert.equal(pendingAttention.resolved[0]?.attentionId, `stop-pending-${pending.operationId.value}`);
});

test('stop control freezes scope and operation binding before the first async request', async () => {
  const session = await stoppedSession();
  const operationScope: ScopeRef = { ...scope, operationId: session.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  const requestStarted = deferred<void>();
  const releaseRequest = deferred<void>();
  const driver: AgentDriver = {
    ...session.driver,
    requestStop: async (input) => {
      requestStarted.resolve();
      await releaseRequest.promise;
      return session.driver.requestStop(input);
    },
  };
  bindAgentDriver(session.runtime, driver);
  const mutableInput = {
    command: {
      source: 'control' as const,
      command: 'steer.request-stop' as const,
      actorKind: 'human-operator' as const,
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running' as const,
      runtimeId: session.runtimeId,
    },
    driver,
    checkpointPort: store.port,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: session.operationId,
    scope: operationScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'freeze-binding',
    recoveryStateRef: evidence('freeze-binding-recovery', operationScope),
    runtime: session.runtime,
  };

  const pending = executeStopControl(mutableInput);
  await requestStarted.promise;
  const otherCycle = id('cycle', 'cycle-mutated');
  (mutableInput.scope as { cycleId: typeof cycle }).cycleId = otherCycle;
  (mutableInput as { cycleId: typeof cycle }).cycleId = otherCycle;
  releaseRequest.resolve();

  const result = await pending;
  assert.equal(result.state, 'stopped');
  assert.equal(store.commits[0]?.scope.cycleId?.value, cycle.value);
  assert.equal(store.commits[0]?.cycleId.value, cycle.value);
  assert.equal(session.runtime.snapshot().state, 'stopped');
});

test('unauthorized stop is rejected before claiming the runtime', async () => {
  const session = await stoppedSession();
  let requestStopCalls = 0;
  const driver: AgentDriver = {
    ...session.driver,
    requestStop: async (input) => {
      requestStopCalls += 1;
      return session.driver.requestStop(input);
    },
  };
  bindAgentDriver(session.runtime, driver);
  const store = checkpointPort();
  const attention = attentionPort();
  await assert.rejects(
    () => executeStopControl({
      command: {
        source: 'control',
        command: 'steer.request-stop',
        actorKind: 'human-operator',
        hasStopPermission: false,
        organId: organ,
        taskId: task,
        executionEpoch: 4,
        currentState: 'running',
        runtimeId: session.runtimeId,
      },
      driver,
      checkpointPort: store.port,
      attentionPort: attention.port,
      currentOrganId: organ,
      currentTaskId: task,
      currentEpoch: 4,
      operationId: session.operationId,
      scope: { ...scope, operationId: session.operationId },
      cycleId: cycle,
      ownerId: 'control-owner',
      previousCheckpoint: null,
      checkpointSeq: 1,
      directiveRevision: 1,
      stopReason: 'unauthorized-stop',
      recoveryStateRef: evidence('unauthorized-stop-recovery', { ...scope, operationId: session.operationId }),
      runtime: session.runtime,
    }),
    ControlError,
  );
  assert.equal(requestStopCalls, 0);
  assert.equal(store.commits.length, 0);
  assert.equal(attention.published.length, 0);
  const output = await session.runtime.submit({ branch: 'after-unauthorized-stop' });
  assert.equal(output.assignmentId, session.assignmentId);
  assert.equal(session.runtime.snapshot().state, 'running');
});

test('stop driver mismatch is rejected before invoking an unbound driver', async () => {
  const session = await stoppedSession();
  let requestStopCalls = 0;
  let settleCalls = 0;
  const unboundDriver: AgentDriver = {
    ...session.driver,
    requestStop: async (input) => {
      requestStopCalls += 1;
      return session.driver.requestStop(input);
    },
    settle: async (input) => {
      settleCalls += 1;
      return session.driver.settle(input);
    },
  };
  const stopScope: ScopeRef = { ...scope, operationId: session.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  await assert.rejects(
    () => executeStopControl({
      command: {
        source: 'control',
        command: 'steer.request-stop',
        actorKind: 'human-operator',
        hasStopPermission: true,
        organId: organ,
        taskId: task,
        executionEpoch: 4,
        currentState: 'running',
        runtimeId: session.runtimeId,
      },
      driver: unboundDriver,
      checkpointPort: store.port,
      attentionPort: attention.port,
      currentOrganId: organ,
      currentTaskId: task,
      currentEpoch: 4,
      operationId: session.operationId,
      scope: stopScope,
      cycleId: cycle,
      ownerId: 'control-owner',
      previousCheckpoint: null,
      checkpointSeq: 1,
      directiveRevision: 1,
      stopReason: 'unbound-driver',
      recoveryStateRef: evidence('unbound-driver-recovery', stopScope),
      runtime: session.runtime,
    }),
    RuntimeError,
  );
  assert.equal(requestStopCalls, 0);
  assert.equal(settleCalls, 0);
  assert.equal(store.commits.length, 0);
  assert.equal(attention.published.length, 0);
  const output = await session.runtime.submit({ branch: 'after-driver-mismatch' });
  assert.equal(output.assignmentId, session.assignmentId);
  assert.equal(session.runtime.snapshot().state, 'running');
});

test('stop closes waiting and blocked runtimes through the same standard operation', async () => {
  for (const outcome of ['waiting', 'blocked'] as const) {
    const runtimeId = `runtime-stop-${outcome}`;
    const assignmentId = `assignment-stop-${outcome}`;
    const delegate = new FakeAgentDriver({ [assignmentId]: outcome });
    const runtime = new AgentRuntime(delegate, {
      runtimeId,
      taskId: task,
      assignmentId,
      executionEpoch: 4,
      ownerRef: 'control-test-agent-runtime',
      waitConditionRef: outcome === 'waiting' ? `condition:${outcome}` : undefined,
      recoveryRef: outcome === 'blocked' ? `recovery:${outcome}` : undefined,
    });
    await runtime.start();
    await runtime.submit({ branch: outcome });
    const settled = await runtime.settle();
    assert.equal(settled.state, outcome);
    const evidenceRecord = delegate.replay().at(-1);
    if (!evidenceRecord) throw new Error(`missing ${outcome} evidence`);
    const operationId = evidenceRecord.operationId;
    const stopScope: ScopeRef = { ...scope, operationId };
    const stopEvidence = evidence(`${outcome}-stop`, stopScope);
    const driver: AgentDriver = {
      ...scopedStopEvidenceDriver(delegate, stopEvidence),
      settle: async () => ({ state: 'stopped', evidenceRefs: [stopEvidence] }),
    };
    bindAgentDriver(runtime, driver);
    const store = checkpointPort();
    const attention = attentionPort();
    const result = await executeStopControl({
      command: {
        source: 'control',
        command: 'steer.request-stop',
        actorKind: 'human-operator',
        hasStopPermission: true,
        organId: organ,
        taskId: task,
        executionEpoch: 4,
        currentState: outcome,
        runtimeId,
      },
      driver,
      checkpointPort: store.port,
      attentionPort: attention.port,
      currentOrganId: organ,
      currentTaskId: task,
      currentEpoch: 4,
      operationId,
      scope: stopScope,
      cycleId: cycle,
      ownerId: 'control-owner',
      previousCheckpoint: null,
      checkpointSeq: 1,
      directiveRevision: 1,
      stopReason: `stop-${outcome}`,
      recoveryStateRef: evidence(`${outcome}-recovery`, stopScope),
      runtime,
    });
    assert.equal(result.state, 'stopped');
    assert.equal(runtime.snapshot().state, 'stopped');
    assert.equal(store.commits.length, 1);
  }
});

test('stop attention resolution failure keeps the binding for resolution-only recovery', async () => {
  const pending = await stoppedSession('succeeded');
  const pendingScope: ScopeRef = { ...scope, operationId: pending.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  let resolveFailure = true;
  const port = {
    publish: attention.port.publish,
    resolve: async (input: Attention) => {
      if (resolveFailure) {
        resolveFailure = false;
        try { (input.evidenceRefs[0] as { locator: string }).locator = 'resolution-port-forged'; } catch {}
        throw new Error('attention backend unavailable');
      }
      return attention.port.resolve(input);
    },
  };
  let settleCalls = 0;
  const retryDriver: AgentDriver = {
    ...pending.driver,
    settle: async (input) => {
      settleCalls += 1;
      if (settleCalls === 1) return { state: 'succeeded', evidenceRefs: [] };
      return { state: 'stopped', evidenceRefs: pending.evidenceRefs };
    },
  };
  bindAgentDriver(pending.runtime, retryDriver);
  const command = {
    source: 'control' as const,
    command: 'steer.request-stop' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    organId: organ,
    taskId: task,
    executionEpoch: 4,
    currentState: 'running' as const,
    runtimeId: pending.runtimeId,
  };
  const first = await executeStopControl({
    command,
    driver: retryDriver,
    checkpointPort: store.port,
    attentionPort: port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: pending.operationId,
    scope: pendingScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'attention-resolution-test',
    recoveryStateRef: evidence('attention-resolution-recovery', pendingScope),
    runtime: pending.runtime,
  });
  assert.equal(first.state, 'settling');
  await assert.rejects(
    () => resolvePendingStopAttention({
      runtime: pending.runtime,
      operationId: pending.operationId,
      attentionPort: port,
      scope: pendingScope,
      ownerId: 'control-owner',
      evidenceRefs: pending.evidenceRefs,
    }),
    ControlError,
  );
  const second = await executeStopControl({
    command,
    driver: retryDriver,
    checkpointPort: store.port,
    attentionPort: port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: pending.operationId,
    scope: pendingScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'attention-resolution-test',
    recoveryStateRef: evidence('attention-resolution-recovery', pendingScope),
    runtime: pending.runtime,
  });
  assert.equal(second.state, 'stopped');
  if (second.state !== 'stopped') throw new Error('expected stopped result');
  assert.equal(second.attentionResolution?.state, 'pending');
  const exposedResolution = pending.runtime.stopAttentionResolutionAttention(pending.operationId);
  assert.ok(exposedResolution);
  const replacementEvidence = evidence('replacement-resolution-evidence', pendingScope);
  (exposedResolution.evidenceRefs as EvidenceRef[])[0] = replacementEvidence;
  await assert.rejects(
    () => resolvePendingStopAttention({
      runtime: pending.runtime,
      operationId: pending.operationId,
      attentionPort: port,
      scope: pendingScope,
      ownerId: 'control-owner',
      evidenceRefs: [replacementEvidence],
    }),
    RuntimeError,
  );
  assert.equal(pending.runtime.snapshot().state, 'stopped');
  assert.equal(pending.runtime.stopAttention(pending.operationId), `stop-pending-${pending.operationId.value}`);
  assert.equal(store.commits.length, 1);
  assert.equal(attention.published.length, 2);
  assert.equal(attention.published[1]?.ownerId, 'control-owner');
  assert.deepEqual(attention.published[1]?.nextAction, { kind: 'recover', ref: `stop-attention-resolution:${pending.operationId.value}` });
  const recovered = await resolvePendingStopAttention({
    runtime: pending.runtime,
    operationId: pending.operationId,
    attentionPort: port,
    scope: pendingScope,
    ownerId: 'control-owner',
    evidenceRefs: pending.evidenceRefs,
  });
  assert.equal(recovered.state, 'resolved');
  assert.equal(pending.runtime.stopAttention(pending.operationId), undefined);
  assert.equal(attention.resolved.length, 2);
  assert.equal(attention.resolved[1]?.attentionId, `stop-attention-resolution-${pending.operationId.value}`);
});

test('checkpoint commit retry reuses the completed stop settlement without repeating driver work', async () => {
  const session = await stoppedSession();
  const stopScope: ScopeRef = { ...scope, operationId: session.operationId };
  let requestStopCalls = 0;
  let settleCalls = 0;
  const driver: AgentDriver = {
    ...session.driver,
    requestStop: async (input) => { requestStopCalls += 1; return session.driver.requestStop(input); },
    settle: async (input) => { settleCalls += 1; return session.driver.settle(input); },
  };
  bindAgentDriver(session.runtime, driver);
  const canonicalEvidenceLocator = session.evidenceRefs[0]?.locator;
  let commitAttempts = 0;
  const checkpointPort: CheckpointCommitPort = {
    async commit(checkpoint) {
      commitAttempts += 1;
      if (commitAttempts === 1) throw new Error('journal unavailable before append');
      if (commitAttempts === 2) {
        try { (checkpoint.next as { kind: Checkpoint['next']['kind'] }).kind = 'continue'; } catch {}
        try { (checkpoint.evidenceRefs[0] as { locator: string }).locator = 'port-forged'; } catch {}
        (session.evidenceRefs[0] as { locator: string }).locator = 'mutated-during-commit';
      }
      return { checkpointId: checkpoint.id, committed: true };
    },
  };
  const attention = attentionPort();
  const input = {
    command: {
      source: 'control' as const,
      command: 'steer.request-stop' as const,
      actorKind: 'human-operator' as const,
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running' as const,
      runtimeId: session.runtimeId,
    },
    driver,
    checkpointPort,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: session.operationId,
    scope: stopScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'checkpoint-retry',
    recoveryStateRef: evidence('checkpoint-retry', stopScope),
    runtime: session.runtime,
  };
  const first = await executeStopControl(input);
  assert.equal(first.state, 'settling');
  const second = await executeStopControl(input);
  assert.equal(second.state, 'stopped');
  assert.equal(requestStopCalls, 1);
  assert.equal(settleCalls, 1);
  assert.equal(commitAttempts, 2);
  if (second.state !== 'stopped') throw new Error('expected stopped retry result');
  assert.equal(second.checkpoint.next.kind, 'stop');
  assert.equal(second.checkpoint.evidenceRefs[0]?.locator, canonicalEvidenceLocator);
  assert.equal(session.runtime.snapshot().state, 'stopped');
});

test('prepared stop settlement rejects retry scope and owner changes before commit', async () => {
  const session = await stoppedSession();
  const stopScope: ScopeRef = { ...scope, operationId: session.operationId };
  let requestStopCalls = 0;
  let settleCalls = 0;
  const driver: AgentDriver = {
    ...session.driver,
    requestStop: async (input) => { requestStopCalls += 1; return session.driver.requestStop(input); },
    settle: async (input) => { settleCalls += 1; return session.driver.settle(input); },
  };
  bindAgentDriver(session.runtime, driver);
  let commitAttempts = 0;
  const checkpointPort: CheckpointCommitPort = {
    async commit(checkpoint) {
      commitAttempts += 1;
      if (commitAttempts === 1) throw new Error('journal unavailable before append');
      return { checkpointId: checkpoint.id, committed: true };
    },
  };
  const attention = attentionPort();
  const input = {
    command: {
      source: 'control' as const,
      command: 'steer.request-stop' as const,
      actorKind: 'human-operator' as const,
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running' as const,
      runtimeId: session.runtimeId,
    },
    driver,
    checkpointPort,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: session.operationId,
    scope: stopScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'prepared-binding',
    recoveryStateRef: evidence('prepared-binding', stopScope),
    runtime: session.runtime,
  };
  const first = await executeStopControl(input);
  assert.equal(first.state, 'settling');
  (input.recoveryStateRef as { locator: string }).locator = 'mutated-after-preparation';
  await assert.rejects(() => executeStopControl(input), ControlError);
  (input.recoveryStateRef as { locator: string }).locator = 'prepared-binding';
  const otherCycle = id('cycle', 'cycle-other');
  const otherScope: ScopeRef = { ...stopScope, cycleId: otherCycle };
  await assert.rejects(
    () => executeStopControl({
      ...input,
      cycleId: otherCycle,
      scope: otherScope,
      ownerId: 'other-owner',
      recoveryStateRef: evidence('prepared-binding-other', otherScope),
    }),
    ControlError,
  );
  assert.equal(requestStopCalls, 1);
  assert.equal(settleCalls, 1);
  assert.equal(commitAttempts, 1);
  const exposed = session.runtime.pendingStopSettlement(session.operationId);
  assert.ok(exposed);
  (exposed.checkpoint as { outcome: Checkpoint['outcome'] }).outcome = 'succeeded';
  (exposed.checkpoint as { next: Checkpoint['next'] }).next = { kind: 'continue', ref: 'unsafe' };
  (exposed.closure as { state: 'cancelled' }).state = 'cancelled';
  (exposed.stopReceipt as { requested: boolean }).requested = false;
  const recovered = await executeStopControl(input);
  assert.equal(recovered.state, 'stopped');
  assert.equal(requestStopCalls, 1);
  assert.equal(settleCalls, 1);
  assert.equal(commitAttempts, 2);
});

test('non-prepared stop retry rejects an owner change before repeating stop work', async () => {
  const session = await stoppedSession('succeeded');
  const stopScope: ScopeRef = { ...scope, operationId: session.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  let settleCalls = 0;
  const driver: AgentDriver = {
    ...session.driver,
    settle: async () => {
      settleCalls += 1;
      return settleCalls === 1 ? { state: 'succeeded', evidenceRefs: [] } : { state: 'stopped', evidenceRefs: session.evidenceRefs };
    },
  };
  bindAgentDriver(session.runtime, driver);
  const input = {
    command: {
      source: 'control' as const,
      command: 'steer.request-stop' as const,
      actorKind: 'human-operator' as const,
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running' as const,
      runtimeId: session.runtimeId,
    },
    driver,
    checkpointPort: store.port,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: session.operationId,
    scope: stopScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'non-prepared-owner-binding',
    recoveryStateRef: evidence('non-prepared-owner-binding', stopScope),
    runtime: session.runtime,
  };

  const first = await executeStopControl(input);
  assert.equal(first.state, 'settling');
  await assert.rejects(() => executeStopControl({ ...input, ownerId: 'other-owner' }), RuntimeError);
  assert.equal(settleCalls, 1);
  assert.equal(store.commits.length, 0);

  const recovered = await executeStopControl(input);
  assert.equal(recovered.state, 'stopped');
  assert.equal(settleCalls, 2);
  assert.equal(store.commits.length, 1);
});

test('resolution publication failure preserves the original resolution cause', async () => {
  const pending = await stoppedSession('succeeded');
  const pendingScope: ScopeRef = { ...scope, operationId: pending.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  const originalFailure = Object.assign(new Error('attention backend unavailable'), { code: 'ATTENTION_RESOLVE_UNCERTAIN' });
  const publicationFailure = new Error('resolution publication unavailable');
  let publishCalls = 0;
  let resolveCalls = 0;
  const port = {
    publish: async (input: Attention) => {
      publishCalls += 1;
      if (publishCalls === 2) throw publicationFailure;
      return attention.port.publish(input);
    },
    resolve: async (input: Attention) => {
      resolveCalls += 1;
      if (resolveCalls === 1) throw originalFailure;
      return attention.port.resolve(input);
    },
  };
  let settleCalls = 0;
  const driver: AgentDriver = {
    ...pending.driver,
    settle: async (input) => {
      settleCalls += 1;
      if (settleCalls === 1) return { state: 'succeeded', evidenceRefs: [] };
      return { state: 'stopped', evidenceRefs: pending.evidenceRefs };
    },
  };
  bindAgentDriver(pending.runtime, driver);
  const input = {
    command: {
      source: 'control' as const,
      command: 'steer.request-stop' as const,
      actorKind: 'human-operator' as const,
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running' as const,
      runtimeId: pending.runtimeId,
    },
    driver,
    checkpointPort: store.port,
    attentionPort: port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: pending.operationId,
    scope: pendingScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'resolution-publication-cause',
    recoveryStateRef: evidence('resolution-publication-cause', pendingScope),
    runtime: pending.runtime,
  };
  const first = await executeStopControl(input);
  assert.equal(first.state, 'settling');
  const second = await executeStopControl(input);
  assert.equal(second.state, 'stopped');
  if (second.state !== 'stopped') throw new Error('expected stopped result');
  assert.equal(second.attentionResolution?.state, 'pending');
  assert.ok(second.attentionResolution?.failure instanceof ControlError);
  const failure = second.attentionResolution?.failure as ControlError;
  assert.equal(failure.cause, originalFailure);
  assert.equal(failure.publicationFailure, publicationFailure);
  await assert.rejects(
    () => resolvePendingStopAttention({
      runtime: pending.runtime,
      operationId: pending.operationId,
      attentionPort: port,
      scope: { ...pendingScope, taskId: id('task', 'other-resolution-task') },
      ownerId: 'other-owner',
      evidenceRefs: [],
    }),
    RuntimeError,
  );
  const recovered = await resolvePendingStopAttention({
    runtime: pending.runtime,
    operationId: pending.operationId,
    attentionPort: port,
    scope: pendingScope,
    ownerId: 'control-owner',
    evidenceRefs: pending.evidenceRefs,
  });
  assert.equal(recovered.state, 'resolved');
  assert.equal(pending.runtime.stopAttention(pending.operationId), undefined);
});

test('repeated original attention resolution failure reuses the published blocker', async () => {
  const pending = await stoppedSession('succeeded');
  const pendingScope: ScopeRef = { ...scope, operationId: pending.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  const originalFailure = new Error('attention resolution remains unavailable');
  const port = {
    publish: attention.port.publish,
    resolve: async () => { throw originalFailure; },
  };
  let settleCalls = 0;
  const driver: AgentDriver = {
    ...pending.driver,
    settle: async (input) => {
      settleCalls += 1;
      if (settleCalls === 1) return { state: 'succeeded', evidenceRefs: [] };
      return { state: 'stopped', evidenceRefs: pending.evidenceRefs };
    },
  };
  bindAgentDriver(pending.runtime, driver);
  const input = {
    command: {
      source: 'control' as const,
      command: 'steer.request-stop' as const,
      actorKind: 'human-operator' as const,
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running' as const,
      runtimeId: pending.runtimeId,
    },
    driver,
    checkpointPort: store.port,
    attentionPort: port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: pending.operationId,
    scope: pendingScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'repeated-resolution-failure',
    recoveryStateRef: evidence('repeated-resolution-failure', pendingScope),
    runtime: pending.runtime,
  };
  await executeStopControl(input);
  const first = await executeStopControl(input);
  assert.equal(first.state, 'stopped');
  const second = await resolvePendingStopAttention({
    runtime: pending.runtime,
    operationId: pending.operationId,
    attentionPort: port,
    scope: pendingScope,
    ownerId: 'control-owner',
    evidenceRefs: pending.evidenceRefs,
  });
  assert.equal(second.state, 'pending');
  if (second.state !== 'pending') throw new Error('expected pending resolution');
  assert.ok(second.failure instanceof ControlError);
  assert.equal((second.failure as ControlError).cause, originalFailure);
  assert.equal(pending.runtime.stopAttention(pending.operationId), `stop-pending-${pending.operationId.value}`);
});

test('publication-only retry preserves the original stop failure cause', async () => {
  const pending = await stoppedSession();
  const pendingScope: ScopeRef = { ...scope, operationId: pending.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  const originalFailure = new Error('stop settle failed');
  const secondPublicationFailure = new Error('publication backend outage again');
  let publishCalls = 0;
  const port = {
    publish: async (input: Attention) => {
      publishCalls += 1;
      if (publishCalls === 1) throw new Error('publication backend outage');
      if (publishCalls === 2) throw secondPublicationFailure;
      return attention.port.publish(input);
    },
    resolve: attention.port.resolve,
  };
  const driver: AgentDriver = {
    ...pending.driver,
    settle: async () => { throw originalFailure; },
  };
  bindAgentDriver(pending.runtime, driver);
  const first = await executeStopControl({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: pending.runtimeId,
    },
    driver,
    checkpointPort: store.port,
    attentionPort: port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: pending.operationId,
    scope: pendingScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'publication-cause',
    recoveryStateRef: evidence('publication-cause', pendingScope),
    runtime: pending.runtime,
  });
  assert.equal(first.state, 'settling');
  const retry = await publishPendingStopAttention({ runtime: pending.runtime, operationId: pending.operationId, attentionPort: port });
  assert.equal(retry.state, 'pending');
  if (retry.state !== 'pending') throw new Error('expected pending publication');
  assert.ok(retry.failure instanceof ControlError);
  assert.equal((retry.failure as ControlError).cause, originalFailure);
  assert.equal((retry.failure as ControlError).publicationFailure, secondPublicationFailure);
});

test('concurrent stop attention resolution cannot reopen a published blocker after clearing its binding', async () => {
  const pending = await stoppedSession('succeeded');
  const pendingScope: ScopeRef = { ...scope, operationId: pending.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  let releasePublication!: () => void;
  const publicationReady = new Promise<void>((resolve) => { releasePublication = resolve; });
  let publishCalls = 0;
  const port = {
    publish: async (input: Attention) => {
      publishCalls += 1;
      if (publishCalls === 2) await publicationReady;
      return attention.port.publish(input);
    },
    resolve: async () => { throw new Error('original resolution failure'); },
  };
  let settleCalls = 0;
  const driver: AgentDriver = {
    ...pending.driver,
    settle: async () => {
      settleCalls += 1;
      if (settleCalls === 1) return { state: 'succeeded', evidenceRefs: [] };
      return { state: 'stopped', evidenceRefs: pending.evidenceRefs };
    },
  };
  bindAgentDriver(pending.runtime, driver);
  const input = {
    command: {
      source: 'control' as const,
      command: 'steer.request-stop' as const,
      actorKind: 'human-operator' as const,
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running' as const,
      runtimeId: pending.runtimeId,
    },
    driver,
    checkpointPort: store.port,
    attentionPort: port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: pending.operationId,
    scope: pendingScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'resolution-race',
    recoveryStateRef: evidence('resolution-race', pendingScope),
    runtime: pending.runtime,
  };
  await executeStopControl(input);
  const completing = executeStopControl(input);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    () => resolvePendingStopAttention({
      runtime: pending.runtime,
      operationId: pending.operationId,
      attentionPort: port,
      scope: pendingScope,
      ownerId: 'control-owner',
      evidenceRefs: pending.evidenceRefs,
    }),
    RuntimeError,
  );
  releasePublication();
  const result = await completing;
  assert.equal(result.state, 'stopped');
  assert.equal(pending.runtime.stopAttention(pending.operationId), `stop-pending-${pending.operationId.value}`);
});

test('attention publication failure keeps the stop fence and exposes publication-only recovery', async () => {
  const pending = await stoppedSession('succeeded');
  const pendingScope: ScopeRef = { ...scope, operationId: pending.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  let publicationFailure = true;
  const port = {
    publish: async (input: Attention) => {
      if (publicationFailure) {
        publicationFailure = false;
        throw new Error('attention publication unavailable');
      }
      return attention.port.publish(input);
    },
    resolve: attention.port.resolve,
  };
  let settleCalls = 0;
  const retryDriver: AgentDriver = {
    ...pending.driver,
    settle: async () => {
      settleCalls += 1;
      if (settleCalls === 1) return { state: 'succeeded', evidenceRefs: [] };
      return { state: 'stopped', evidenceRefs: pending.evidenceRefs };
    },
  };
  bindAgentDriver(pending.runtime, retryDriver);
  const command = {
    source: 'control' as const,
    command: 'steer.request-stop' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    organId: organ,
    taskId: task,
    executionEpoch: 4,
    currentState: 'running' as const,
    runtimeId: pending.runtimeId,
  };
  const input = {
    command,
    driver: retryDriver,
    checkpointPort: store.port,
    attentionPort: port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: pending.operationId,
    scope: pendingScope,
    cycleId: cycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'publication-failure-test',
    recoveryStateRef: evidence('publication-failure-recovery', pendingScope),
    runtime: pending.runtime,
  };
  const first = await executeStopControl(input);
  assert.equal(first.state, 'settling');
  if (first.state !== 'settling') throw new Error('expected settling result');
  assert.ok(String(first.failure).includes('attention publication unavailable'));
  assert.equal(attention.published.length, 0);
  assert.equal(pending.runtime.pendingStopAttention(pending.operationId)?.attentionId, `stop-pending-${pending.operationId.value}`);
  assert.equal(pending.runtime.isStopRetryable(pending.operationId), false);
  await assert.rejects(() => executeStopControl(input), RuntimeError);
  assert.equal(settleCalls, 1);
  const publication = await publishPendingStopAttention({ runtime: pending.runtime, operationId: pending.operationId, attentionPort: port });
  assert.equal(publication.state, 'published');
  assert.equal(pending.runtime.isStopRetryable(pending.operationId), true);
  await assert.rejects(
    () => publishPendingStopAttention({ runtime: pending.runtime, operationId: pending.operationId, attentionPort: port }),
    ControlError,
  );
  const result = await executeStopControl(input);
  assert.equal(result.state, 'stopped');
  assert.equal(settleCalls, 2);
  assert.equal(store.commits.length, 1);
  assert.equal(attention.published.length, 1);
});

test('stop rejects a task mismatch before requesting the bound runtime', async () => {
  const session = await stoppedSession();
  let requestStopCalls = 0;
  const driver: AgentDriver = {
    ...session.driver,
    requestStop: async (input) => {
      requestStopCalls += 1;
      return session.driver.requestStop(input);
    },
  };
  bindAgentDriver(session.runtime, driver);
  const otherTask = id('task', 'task-stop-mismatch');
  const stopScope: ScopeRef = { organId: organ, taskId: otherTask, cycleId: cycle, operationId: session.operationId };
  const store = checkpointPort();
  const attention = attentionPort();
  await assert.rejects(
    () => executeStopControl({
      command: {
        source: 'control',
        command: 'steer.request-stop',
        actorKind: 'human-operator',
        hasStopPermission: true,
        organId: organ,
        taskId: otherTask,
        executionEpoch: 4,
        currentState: 'running',
        runtimeId: session.runtimeId,
      },
      driver,
      checkpointPort: store.port,
      attentionPort: attention.port,
      currentOrganId: organ,
      currentTaskId: otherTask,
      currentEpoch: 4,
      operationId: session.operationId,
      scope: stopScope,
      cycleId: cycle,
      ownerId: 'control-owner',
      previousCheckpoint: null,
      checkpointSeq: 1,
      directiveRevision: 1,
      stopReason: 'task-mismatch',
      recoveryStateRef: evidence('task-mismatch-recovery', stopScope),
      runtime: session.runtime,
    }),
    RuntimeError,
  );
  assert.equal(requestStopCalls, 0);
  assert.equal(store.commits.length, 0);
  assert.equal(attention.published.length, 0);
  const output = await session.runtime.submit({ branch: 'after-task-mismatch' });
  assert.equal(output.assignmentId, session.assignmentId);
});

test('invalid settle parameters are rejected before claiming or requesting stop', async () => {
  const invalids: readonly { readonly stopReason?: string; readonly checkpointSeq?: number }[] = [
    { stopReason: '' },
    { checkpointSeq: 0 },
  ];
  for (const invalid of invalids) {
    const session = await stoppedSession();
    let requestStopCalls = 0;
    const driver: AgentDriver = {
      ...session.driver,
      requestStop: async (input) => {
        requestStopCalls += 1;
        return session.driver.requestStop(input);
      },
    };
    bindAgentDriver(session.runtime, driver);
    const stopScope: ScopeRef = { ...scope, operationId: session.operationId };
    const store = checkpointPort();
    const attention = attentionPort();
    await assert.rejects(
      () => executeStopControl({
        command: {
          source: 'control',
          command: 'steer.request-stop',
          actorKind: 'human-operator',
          hasStopPermission: true,
          organId: organ,
          taskId: task,
          executionEpoch: 4,
          currentState: 'running',
          runtimeId: session.runtimeId,
        },
        driver,
        checkpointPort: store.port,
        attentionPort: attention.port,
        currentOrganId: organ,
        currentTaskId: task,
        currentEpoch: 4,
        operationId: session.operationId,
        scope: stopScope,
        cycleId: cycle,
        ownerId: 'control-owner',
        previousCheckpoint: null,
        checkpointSeq: invalid.checkpointSeq ?? 1,
        directiveRevision: 1,
        stopReason: invalid.stopReason ?? 'operator-steer',
        recoveryStateRef: evidence('invalid-settle-recovery', stopScope),
        runtime: session.runtime,
      }),
      ControlError,
    );
    assert.equal(requestStopCalls, 0);
    assert.equal(store.commits.length, 0);
    assert.equal(attention.published.length, 0);
    const output = await session.runtime.submit({ branch: 'after-invalid-settle' });
    assert.equal(output.assignmentId, session.assignmentId);
  }
});

test('invalid recovery state is rejected before requesting stop', async () => {
  const otherTask = id('task', 'task-invalid-recovery');
  const invalids: readonly EvidenceRef[] = [
    { ...evidence('invalid-recovery-locator', scope), locator: '' },
    evidence('invalid-recovery-scope', { ...scope, taskId: otherTask }),
    { ...evidence('invalid-recovery-digest', scope), digest: 17 as unknown as string },
  ];
  for (const recoveryStateRef of invalids) {
    const session = await stoppedSession();
    let requestStopCalls = 0;
    const driver: AgentDriver = {
      ...session.driver,
      requestStop: async (input) => {
        requestStopCalls += 1;
        return session.driver.requestStop(input);
      },
    };
    bindAgentDriver(session.runtime, driver);
    const stopScope: ScopeRef = { ...scope, operationId: session.operationId };
    const store = checkpointPort();
    const attention = attentionPort();
    await assert.rejects(
      () => executeStopControl({
        command: {
          source: 'control',
          command: 'steer.request-stop',
          actorKind: 'human-operator',
          hasStopPermission: true,
          organId: organ,
          taskId: task,
          executionEpoch: 4,
          currentState: 'running',
          runtimeId: session.runtimeId,
        },
        driver,
        checkpointPort: store.port,
        attentionPort: attention.port,
        currentOrganId: organ,
        currentTaskId: task,
        currentEpoch: 4,
        operationId: session.operationId,
        scope: stopScope,
        cycleId: cycle,
        ownerId: 'control-owner',
        previousCheckpoint: null,
        checkpointSeq: 1,
        directiveRevision: 1,
        stopReason: 'invalid-recovery',
        recoveryStateRef,
        runtime: session.runtime,
      }),
      ControlError,
    );
    assert.equal(requestStopCalls, 0);
    assert.equal(store.commits.length, 0);
    assert.equal(attention.published.length, 0);
    const output = await session.runtime.submit({ branch: 'after-invalid-recovery' });
    assert.equal(output.assignmentId, session.assignmentId);
  }
});

test('invalid stopped evidence is rejected before checkpoint commit', async () => {
  const session = await stoppedSession();
  const stopScope: ScopeRef = { ...scope, operationId: session.operationId };
  const invalidEvidence = { ...session.evidenceRefs[0], digest: 17 as unknown as string };
  const driver = scopedStopEvidenceDriver(session.driver, invalidEvidence);
  bindAgentDriver(session.runtime, driver);
  let settleCalls = 0;
  const countingDriver: AgentDriver = {
    ...driver,
    settle: async (input) => {
      settleCalls += 1;
      return driver.settle(input);
    },
  };
  bindAgentDriver(session.runtime, countingDriver);
  const store = checkpointPort();
  const attention = attentionPort();
  const result = await executeStopControl({
      command: {
        source: 'control',
        command: 'steer.request-stop',
        actorKind: 'human-operator',
        hasStopPermission: true,
        organId: organ,
        taskId: task,
        executionEpoch: 4,
        currentState: 'running',
        runtimeId: session.runtimeId,
      },
      driver: countingDriver,
      checkpointPort: store.port,
      attentionPort: attention.port,
      currentOrganId: organ,
      currentTaskId: task,
      currentEpoch: 4,
      operationId: session.operationId,
      scope: stopScope,
      cycleId: cycle,
      ownerId: 'control-owner',
      previousCheckpoint: null,
      checkpointSeq: 1,
      directiveRevision: 1,
      stopReason: 'invalid-stopped-evidence',
      recoveryStateRef: evidence('invalid-stopped-evidence-recovery', stopScope),
      runtime: session.runtime,
    });
  assert.equal(result.state, 'settling');
  assert.equal(settleCalls, 1);
  assert.equal(store.commits.length, 0);
  assert.equal(session.runtime.snapshot().state, 'running');
});

test('foreground supervision publishes Attention before returning and retry is bounded', async () => {
  const attention = attentionPort();
  const foreground = await superviseFailure({
    issueId: 'issue-1',
    scope,
    message: 'user promise affected',
    evidenceRefs: [evidence('foreground', scope)],
    layer: 'background',
    attempt: 1,
    maxAttempts: 3,
    sameCondition: true,
    affectsUserPromise: true,
    requiresUserInput: false,
    recoverable: true,
    ownerId: 'task-owner',
    escalationTarget: 'task-attention',
  }, attention.port);

  assert.equal(foreground.policy.disposition, 'attention');
  assert.equal(foreground.policy.mustPublishAttentionBeforeSettle, true);
  assert.equal(attention.published.length, 1);
  assert.equal(attention.published[0]?.attentionId, 'issue-1');
  assert.deepEqual(foreground.nextAction, { kind: 'recover', ref: 'task-attention' });

  const retry = await superviseFailure({
    issueId: 'issue-2',
    scope,
    message: 'retry with changed condition',
    evidenceRefs: [evidence('retry', scope)],
    layer: 'background',
    attempt: 1,
    maxAttempts: 3,
    sameCondition: true,
    changedConditionRef: 'dependency-ready',
    affectsUserPromise: false,
    requiresUserInput: false,
    recoverable: true,
    ownerId: 'operation-owner',
  });
  assert.equal(retry.policy.disposition, 'retry');
  assert.equal(retry.policy.retryAllowed, true);
  assert.deepEqual(retry.nextAction, { kind: 'recover', ref: 'dependency-ready' });

  const exhausted = await superviseFailure({
    issueId: 'issue-3',
    scope,
    message: 'retry exhausted',
    evidenceRefs: [evidence('exhausted', scope)],
    layer: 'background',
    attempt: 3,
    maxAttempts: 3,
    sameCondition: true,
    conditionRef: 'dependency-ready',
    affectsUserPromise: false,
    requiresUserInput: false,
    recoverable: true,
    ownerId: 'operation-owner',
  });
  assert.equal(exhausted.policy.disposition, 'wait');
  assert.equal(exhausted.policy.retryAllowed, false);
  assert.deepEqual(exhausted.nextAction, { kind: 'wait', ref: 'dependency-ready' });

  await assert.rejects(
    superviseFailure({
      issueId: 'issue-4',
      scope,
      message: 'retry without condition',
      evidenceRefs: [],
      layer: 'background',
      attempt: 1,
      maxAttempts: 3,
      sameCondition: false,
      affectsUserPromise: false,
      requiresUserInput: false,
      recoverable: true,
      ownerId: 'operation-owner',
    }),
    ControlError,
  );
});

test('late control events are rejected by the core epoch fence', () => {
  assert.doesNotThrow(() => fenceControlEvent(
    { taskId: task, executionEpoch: 4 },
    { taskId: task, executionEpoch: 4 },
  ));
  assert.throws(
    () => fenceControlEvent(
      { taskId: task, executionEpoch: 4 },
      { taskId: task, executionEpoch: 3 },
    ),
    ControlError,
  );
});
