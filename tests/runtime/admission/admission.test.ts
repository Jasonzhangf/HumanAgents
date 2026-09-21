import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError, id, type RequirementEnvelope, type TaskId } from '../../../packages/contracts/src/index.js';
import {
  AdmissionError,
  RequirementAdmissionError,
  admitRequirement,
  appendTaskRevision,
  checkAdmission,
  classifyRequirement,
  decideOrchestrationRuntimePool,
  type AdmissionCheckInput,
  type RequirementAdmissionInput,
} from '../../../packages/runtime/src/admission/index.js';

const task: TaskId = id('task', 'task-a');

function envelope(overrides: Partial<RequirementEnvelope> = {}): RequirementEnvelope {
  return {
    requirementId: 'requirement-a',
    draftId: 'draft-a',
    inputRevision: 1,
    intent: 'create',
    normalizedInput: 'collect weekly report evidence',
    confirmedBy: 'human',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    fifoSeq: 1,
    payloadRef: 'asset://requirements/requirement-a',
    ...overrides,
  };
}

function admissionCheck(overrides: Partial<AdmissionCheckInput> = {}): AdmissionCheckInput {
  return {
    queue: { kind: 'execution', concurrencyLimit: 2, maxBacklog: 5 },
    queueLoad: { running: 0, queued: 0 },
    requiredCapabilities: ['report.collect'],
    availableCapabilities: ['report.collect'],
    health: 'healthy',
    requiredInputRefs: ['asset://requirements/requirement-a'],
    providedInputRefs: ['asset://requirements/requirement-a'],
    checkpoint: { recoverable: true },
    ownerId: 'runtime-coordinator',
    ...overrides,
  };
}

function requirementAdmission(overrides: Partial<RequirementAdmissionInput> = {}): RequirementAdmissionInput {
  return {
    envelope: envelope(),
    queue: { kind: 'execution', concurrencyLimit: 2, maxBacklog: 5 },
    registeredQueues: ['interactive', 'execution', 'research', 'maintenance'],
    queueLoad: { running: 0, queued: 0 },
    requiredCapabilities: ['provider.execution'],
    availableCapabilities: ['provider.execution'],
    health: 'healthy',
    requiredInputRefs: ['asset://requirements/requirement-a'],
    providedInputRefs: ['asset://requirements/requirement-a'],
    checkpoint: { recoverable: true },
    ownerId: 'runtime-coordinator',
    ...overrides,
  };
}

function captureAdmissionError(run: () => unknown): RequirementAdmissionError {
  try {
    run();
  } catch (error) {
    if (error instanceof RequirementAdmissionError) return error;
    throw error;
  }
  throw new Error('expected requirement admission to fail');
}

test('classifies confirmed envelopes into explicitly registered queues only', () => {
  const decision = classifyRequirement({
    envelope: envelope(),
    queue: 'research',
    registeredQueues: ['interactive', 'execution', 'research', 'maintenance'],
  });
  assert.equal(decision.queue, 'research');

  assert.throws(
    () => classifyRequirement({ envelope: envelope(), queue: 'execution', registeredQueues: ['research'] }),
    AdmissionError,
  );
  assert.throws(
    () => classifyRequirement({ envelope: envelope(), queue: 'control' as never, registeredQueues: ['interactive', 'execution', 'research', 'maintenance'] }),
    AdmissionError,
  );
});

test('admits only when capability, health, input, checkpoint and quota pass', () => {
  assert.deepEqual(checkAdmission(admissionCheck()), {
    status: 'admitted',
    queue: 'execution',
    ownerId: 'runtime-coordinator',
    condition: 'admitted',
    nextAction: { kind: 'continue', ref: 'orchestration.bind' },
    reason: 'admission requirements are satisfied',
  });

  assert.deepEqual(
    checkAdmission(admissionCheck({ requiredInputRefs: ['asset://requirements/a', 'asset://requirements/b'], providedInputRefs: ['asset://requirements/a'] })),
    {
      status: 'waiting',
      queue: 'execution',
      ownerId: 'runtime-coordinator',
      condition: 'input.asset://requirements/b',
      nextAction: { kind: 'wait', ref: 'input.asset://requirements/b' },
      reason: 'required input is incomplete: asset://requirements/b',
    },
  );

  assert.deepEqual(
    checkAdmission(admissionCheck({ queue: { kind: 'execution', concurrencyLimit: 1, maxBacklog: 2 }, queueLoad: { running: 1, queued: 0 } })),
    {
      status: 'waiting',
      queue: 'execution',
      ownerId: 'runtime-coordinator',
      condition: 'queue.execution.concurrency',
      nextAction: { kind: 'wait', ref: 'queue.execution.concurrency' },
      reason: 'queue concurrency quota is exhausted',
    },
  );

  assert.deepEqual(
    checkAdmission(admissionCheck({ health: 'unhealthy' })),
    {
      status: 'blocked',
      queue: 'execution',
      ownerId: 'runtime-coordinator',
      condition: 'health.healthy',
      nextAction: { kind: 'recover', ref: 'health.healthy' },
      reason: 'organ health is unhealthy',
    },
  );

  assert.deepEqual(
    checkAdmission(admissionCheck({ requiredCapabilities: ['report.write'], availableCapabilities: ['report.collect'] })),
    {
      status: 'blocked',
      queue: 'execution',
      ownerId: 'runtime-coordinator',
      condition: 'capability.report.write',
      nextAction: { kind: 'recover', ref: 'capability.report.write' },
      reason: 'required capability is unavailable: report.write',
    },
  );

  assert.deepEqual(
    checkAdmission(admissionCheck({ checkpoint: { recoverable: false, conditionRef: 'checkpoint.queue' } })),
    {
      status: 'blocked',
      queue: 'execution',
      ownerId: 'runtime-coordinator',
      condition: 'checkpoint.queue',
      nextAction: { kind: 'recover', ref: 'checkpoint.queue' },
      reason: 'checkpoint is not recoverable',
    },
  );
});

test('rejects control fields leaking through business payloads', () => {
  assert.throws(
    () => checkAdmission(admissionCheck({ businessPayload: { answer: 'ok', steer: true } })),
    ContractError,
  );
});

test('confirmed requirements yield no admission receipt until classification and admission pass', () => {
  const admitted = admitRequirement(requirementAdmission());
  assert.equal(admitted.classified.queue, 'execution');
  assert.equal(admitted.decision.status, 'admitted');
  assert.equal(admitted.decision.ownerId, 'runtime-coordinator');

  const blocked = captureAdmissionError(() => admitRequirement(requirementAdmission({
    availableCapabilities: [],
    health: 'unhealthy',
  })));
  assert.equal(blocked.decision.status, 'blocked');
  assert.equal(blocked.decision.condition, 'capability.provider.execution');
  assert.equal(blocked.decision.ownerId, 'runtime-coordinator');

  const waiting = captureAdmissionError(() => admitRequirement(requirementAdmission({ health: 'attention' })));
  assert.equal(waiting.decision.status, 'waiting');
  assert.equal(waiting.decision.condition, 'health.attention');

  assert.throws(
    () => admitRequirement(requirementAdmission({
      queue: { kind: 'execution', concurrencyLimit: 2, maxBacklog: 5 },
      registeredQueues: ['research'],
    })),
    AdmissionError,
  );
});

test('task updates append revisions and do not overwrite older payload state', () => {
  const first = envelope({ requirementId: 'requirement-a', draftId: 'draft-a', inputRevision: 1, intent: 'append', taskRef: task, normalizedInput: 'baseline input' });
  const firstDecision = appendTaskRevision({ envelope: first });
  assert.equal(firstDecision.status, 'updated');
  assert.deepEqual(firstDecision.task.revisions, [{
    inputRevision: 1,
    taskId: task,
    envelope: first,
  }]);

  const second = envelope({ requirementId: 'requirement-a', draftId: 'draft-b', inputRevision: 2, intent: 'change', taskRef: task, normalizedInput: 'changed input' });
  const secondDecision = appendTaskRevision({ task: firstDecision.task, envelope: second });
  assert.equal(secondDecision.status, 'updated');
  assert.equal(secondDecision.task.revisions.length, 2);
  assert.equal(secondDecision.task.revisions[0].envelope.normalizedInput, 'baseline input');
  assert.equal(secondDecision.task.revisions[1].envelope.normalizedInput, 'changed input');

  const stale = appendTaskRevision({ task: secondDecision.task, envelope: first });
  assert.equal(stale.status, 'blocked');
  assert.equal(stale.ownerId, 'runtime-coordinator');
  assert.equal(stale.condition, 'task.inputRevision.after.2');
  assert.deepEqual(stale.nextAction, { kind: 'recover', ref: 'task.inputRevision.after.2' });
});

test('pure orchestration pool reuses, spawns, waits or blocks without fallback', () => {
  const reusable = decideOrchestrationRuntimePool({
    pool: {
      maxRuntimes: 2,
      runtimes: [
        { runtimeId: 'idle-a', state: 'idle', capabilities: ['plan'], currentBindings: 0, maxBindings: 1 },
        { runtimeId: 'running-a', state: 'running', capabilities: ['plan'], currentBindings: 1, maxBindings: 1 },
      ],
    },
    requiredCapabilities: ['plan'],
  });
  assert.equal(reusable.action, 'reuse');
  assert.equal(reusable.runtimeId, 'idle-a');

  const spawn = decideOrchestrationRuntimePool({
    pool: {
      maxRuntimes: 2,
      runtimes: [{ runtimeId: 'running-a', state: 'running', capabilities: ['plan'], currentBindings: 1, maxBindings: 1 }],
    },
    requiredCapabilities: ['plan'],
  });
  assert.equal(spawn.action, 'spawn');
  assert.equal(spawn.runtimeId, 'orchestration-runtime-1');

  const wait = decideOrchestrationRuntimePool({
    pool: {
      maxRuntimes: 1,
      runtimes: [{ runtimeId: 'running-a', state: 'running', capabilities: ['plan'], currentBindings: 1, maxBindings: 1 }],
    },
    requiredCapabilities: ['plan'],
  });
  assert.equal(wait.action, 'wait');
  assert.equal(wait.condition, 'orchestration.runtime.max');

  const blocked = decideOrchestrationRuntimePool({
    pool: {
      maxRuntimes: 1,
      runtimes: [{ runtimeId: 'idle-a', state: 'idle', capabilities: ['review'], currentBindings: 0, maxBindings: 1 }],
    },
    requiredCapabilities: ['plan'],
  });
  assert.equal(blocked.action, 'blocked');
  assert.equal(blocked.condition, 'orchestration.capability.plan');

  const disabled = decideOrchestrationRuntimePool({
    pool: { maxRuntimes: 0, runtimes: [] },
    requiredCapabilities: ['plan'],
  });
  assert.equal(disabled.action, 'blocked');
  assert.equal(disabled.condition, 'orchestration.runtime.disabled');
});
