import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  sameTaskExecutionInstanceIdentity,
  validateTaskAgentActivityOwnershipRecord,
  validateTaskAgentActivitySelectionQuery,
  validateTaskExecutionInstanceIdentity,
  type TaskAgentActivityOwnershipRecord,
  type TaskAgentActivitySelectionQuery,
  type TaskExecutionInstanceIdentity,
} from '../../packages/contracts/src/index.js';

// Agent activity read projection identity (F09). The instance identity is the
// real runtime identity, never a role frame, and never a fabricated composite.
const activityTaskA = id('task', 'task-a');
const activityTaskB = id('task', 'task-b');

const nativeActivityInstance = (runtimeId: string, executionEpoch: number): TaskExecutionInstanceIdentity => ({
  kind: 'native-execution',
  execution: { runtimeId, executionEpoch },
});

const activityIncarnation = (
  overrides: Partial<{ runtimeId: string; generation: number; agentInstanceId: string; roleId: string; taskId: typeof activityTaskA; assignmentId: string; executionEpoch: number }> = {},
) => ({
  runtimeId: 'rt-1',
  generation: 1,
  agentInstanceId: 'inst-1',
  roleId: 'execution',
  taskId: activityTaskA,
  assignmentId: 'asg-1',
  executionEpoch: 1,
  ...overrides,
});

const activityRecord = (
  overrides: Partial<TaskAgentActivityOwnershipRecord> = {},
): TaskAgentActivityOwnershipRecord => ({
  taskId: activityTaskA,
  instance: nativeActivityInstance('rt-1', 1),
  assignmentId: 'asg-1',
  executionEpoch: 1,
  objective: 'run the assigned work',
  sourceKind: 'active-turn',
  currency: 'current',
  commitRefs: [],
  evidenceRefs: [],
  ...overrides,
});

test('agent activity rejects cross-task and cross-epoch identity fabrication', () => {
  // The record executionEpoch must be the same epoch as its own instance identity.
  assert.throws(
    () => validateTaskAgentActivityOwnershipRecord(activityRecord({ executionEpoch: 2 })),
    ContractError,
  );

  // An incarnation bound to another task cannot masquerade as this record's task.
  assert.throws(
    () => validateTaskAgentActivityOwnershipRecord(activityRecord({
      instance: { kind: 'incarnation', incarnation: activityIncarnation({ taskId: activityTaskB }) },
    })),
    ContractError,
  );

  // A valid record with a matching epoch is accepted and returned unchanged.
  const accepted = validateTaskAgentActivityOwnershipRecord(activityRecord({ executionEpoch: 1 }));
  assert.equal(accepted.executionEpoch, 1);
});

test('agent activity identity distinguishes the same role across instances and generations', () => {
  const base: TaskExecutionInstanceIdentity = { kind: 'incarnation', incarnation: activityIncarnation() };
  const sameAgain: TaskExecutionInstanceIdentity = { kind: 'incarnation', incarnation: activityIncarnation() };
  const otherInstance: TaskExecutionInstanceIdentity = { kind: 'incarnation', incarnation: activityIncarnation({ agentInstanceId: 'inst-2' }) };
  const otherGeneration: TaskExecutionInstanceIdentity = { kind: 'incarnation', incarnation: activityIncarnation({ generation: 2 }) };

  assert.equal(sameTaskExecutionInstanceIdentity(base, sameAgain), true);
  // Same role, different managed instance -> not equal.
  assert.equal(sameTaskExecutionInstanceIdentity(base, otherInstance), false);
  // Same role and instance, different generation -> not equal.
  assert.equal(sameTaskExecutionInstanceIdentity(base, otherGeneration), false);
  // A native execution identity never equals a managed incarnation.
  assert.equal(sameTaskExecutionInstanceIdentity(nativeActivityInstance('rt-1', 1), base), false);
});

test('agent activity keeps a missing attempt undefined and rejects an illegal attempt', () => {
  const validated = validateTaskAgentActivityOwnershipRecord(activityRecord({ sourceKind: 'native-allocation' }));
  assert.equal(validated.attempt, undefined);
  assert.equal('attempt' in validated, false);

  // A real attempt is preserved when the authoritative source carries one.
  const withAttempt = validateTaskAgentActivityOwnershipRecord(activityRecord({ attempt: 3 }));
  assert.equal(withAttempt.attempt, 3);

  // An illegal attempt is rejected instead of being silently normalised.
  assert.throws(() => validateTaskAgentActivityOwnershipRecord(activityRecord({ attempt: 0 })), ContractError);
});

test('agent activity accepts closed-turn planner-call without objective', () => {
  const plannerTask = id('task', 'ui-task-implicit-draft-2');
  const plannerInstance: TaskExecutionInstanceIdentity = {
    kind: 'incarnation',
    incarnation: {
      runtimeId: 'orchestration-runtime-1',
      generation: 1,
      agentInstanceId: 'd5b33ff4-ee6a-4b5b-bbff-bd5fe0eb0715',
      roleId: 'orchestration',
      taskId: plannerTask,
      assignmentId: 'planner:active-turn-ui-operation-1',
      executionEpoch: 1,
    },
  };
  const common = {
    taskId: plannerTask,
    instance: plannerInstance,
    assignmentId: 'planner:active-turn-ui-operation-1',
    executionEpoch: 1,
    currency: 'unknown',
    commitRefs: [],
    evidenceRefs: [],
  } as const;

  const plannerRecord = {
    ...common,
    sourceKind: 'closed-turn-planner-call',
  } as unknown as TaskAgentActivityOwnershipRecord;
  assert.doesNotThrow(() => validateTaskAgentActivityOwnershipRecord(plannerRecord));
  const validated = validateTaskAgentActivityOwnershipRecord(plannerRecord);
  assert.equal(validated, plannerRecord);
  assert.equal(validated.sourceKind, 'closed-turn-planner-call');
  assert.equal(validated.objective, undefined);
  assert.equal('objective' in validated, false);
  assert.equal('attempt' in validated, false);
  assert.equal(validated.commitRefs.length, 0);
  assert.equal(validated.evidenceRefs.length, 0);

  const plannerRecordWithObjective = {
    ...plannerRecord,
    objective: 'plan the active turn',
  } as TaskAgentActivityOwnershipRecord;
  assert.equal(
    validateTaskAgentActivityOwnershipRecord(plannerRecordWithObjective).objective,
    'plan the active turn',
  );

  const assignmentRecordWithoutObjective = {
    ...common,
    sourceKind: 'active-turn',
  } as unknown as TaskAgentActivityOwnershipRecord;
  assert.throws(
    () => validateTaskAgentActivityOwnershipRecord(assignmentRecordWithoutObjective),
    ContractError,
  );

  const plannerRecordWithEmptyObjective = {
    ...plannerRecord,
    objective: '',
  } as TaskAgentActivityOwnershipRecord;
  assert.throws(
    () => validateTaskAgentActivityOwnershipRecord(plannerRecordWithEmptyObjective),
    ContractError,
  );
});

test('agent activity selection query rejects mixed and half-formed selectors', () => {
  // No instance identity, but a narrowing field: rejected.
  assert.throws(() => validateTaskAgentActivitySelectionQuery({ taskId: activityTaskA, attempt: 1 }), ContractError);
  assert.throws(() => validateTaskAgentActivitySelectionQuery({ taskId: activityTaskA, nodeId: 'node-1' }), ContractError);

  // A native execution identity must not carry managed incarnation fields.
  assert.throws(
    () => validateTaskExecutionInstanceIdentity({
      kind: 'native-execution',
      execution: { runtimeId: 'rt-1', executionEpoch: 1 },
      incarnation: activityIncarnation(),
    } as unknown as TaskExecutionInstanceIdentity),
    ContractError,
  );

  // An incarnation identity must not carry a native execution identity.
  assert.throws(
    () => validateTaskExecutionInstanceIdentity({
      kind: 'incarnation',
      incarnation: activityIncarnation(),
      execution: { runtimeId: 'rt-1', executionEpoch: 1 },
    } as unknown as TaskExecutionInstanceIdentity),
    ContractError,
  );

  // A query assignment that conflicts with its incarnation assignment is rejected.
  assert.throws(
    () => validateTaskAgentActivitySelectionQuery({
      taskId: activityTaskA,
      instance: { kind: 'incarnation', incarnation: activityIncarnation({ assignmentId: 'asg-1' }) },
      assignmentId: 'asg-2',
    }),
    ContractError,
  );

  // Valid selectors pass through unchanged.
  const catalog = validateTaskAgentActivitySelectionQuery({ taskId: activityTaskA });
  assert.equal(catalog.taskId.value, 'task-a');
  const selected: TaskAgentActivitySelectionQuery = {
    taskId: activityTaskA,
    instance: { kind: 'incarnation', incarnation: activityIncarnation() },
    assignmentId: 'asg-1',
  };
  assert.equal(validateTaskAgentActivitySelectionQuery(selected).assignmentId, 'asg-1');
});
