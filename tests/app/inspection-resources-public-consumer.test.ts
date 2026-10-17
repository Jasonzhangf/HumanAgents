import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type ActiveTurnBinding,
  type EvidenceRef,
  type ScopeRef,
  type TaskIdentityScope,
  type WorkAssignment,
} from '../../packages/contracts/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { createJsonlActiveTurnJournal } from '../../packages/adapters/jsonl/src/active-turn.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { activeTurnCommitId } from '../../packages/runtime/src/context/active-turn-journal.js';
import { produceAdmittedTurn, type RuntimeBindingSnapshot } from '../../packages/runtime/src/admission/admitted-turn.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import { createNativeRecoveryAssets } from '../../packages/app/src/native-recovery-assets.js';
import { createInspectionTurnResourceReader } from '../../packages/app/src/ui-runtime/inspection-resources.js';

const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'inspection-app-turn-resources-20261017');

interface Fixture {
  readonly root: string;
  readonly journalPath: string;
  readonly assetRoot: string;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, 'inspection-resources-'));
  try {
    await fn({
      root,
      journalPath: join(root, 'organ.jsonl'),
      assetRoot: join(root, 'assets'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function evidence(scope: ScopeRef, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `inspection-resources-${label}`),
    kind: 'operation',
    source: 'inspection-resources-public-consumer',
    locator: `humanagent://inspection-resources/${label}`,
    scope,
  };
}

function turnBinding(turnId: string, taskScope: TaskIdentityScope): ActiveTurnBinding {
  const scope: ScopeRef = {
    ...taskScope,
    cycleId: id('cycle', `cycle-${turnId}`),
    operationId: id('operation', `operation-${turnId}`),
  };
  const runtime: RuntimeBindingSnapshot = {
    runtimeId: 'inspection-resources-runtime',
    executionEpoch: 1,
    ownerRef: 'inspection-resources-owner',
    permissionRevision: 'inspection-resources-permission',
  };
  const assignment: WorkAssignment = {
    assignmentId: `assignment-${turnId}`,
    taskId: taskScope.taskId,
    pipelineNodeId: 'inspection-resources-node',
    attempt: 1,
    executionEpoch: runtime.executionEpoch,
    inputRevision: 1,
    objective: `locate resources for ${turnId}`,
    targetRefs: [],
    expectedOutputRefs: [],
    acceptanceCriteriaDigest: `sha256:inspection-resources-${turnId}`,
    successCriteria: ['the exact turn resources are readable'],
    failureCriteria: ['a different turn is selected'],
    incompleteCriteria: ['the original turn is not located'],
    requiredCapabilities: ['provider.execution'],
    mergeGate: 'not-required',
  };
  return {
    admittedTurn: produceAdmittedTurn({
      runtime,
      taskId: taskScope.taskId,
      scope,
      assignment,
      directiveRevision: 1,
      turnId,
      currentTurnRef: `active-turn://${turnId}`,
      admissionEvidence: [evidence(scope, `${turnId}-admission`)],
      recoveryStateRef: evidence(scope, `${turnId}-recovery`),
    }),
    assignment,
    execution: { runtimeId: runtime.runtimeId, executionEpoch: runtime.executionEpoch },
    scope,
  };
}

async function appendInvocationTurn(input: {
  readonly journal: JsonlOrganJournal;
  readonly journalPath: string;
  readonly assetRoot: string;
  readonly binding: ActiveTurnBinding;
  readonly invocationId: string;
}): Promise<void> {
  const turnId = input.binding.admittedTurn.turnId;
  const native = createNativeRecoveryAssets({
    journalPath: input.journalPath,
    journal: input.journal,
    assetRoot: input.assetRoot,
  });
  const initialInput = await native.writeInitialInput({
    scope: input.binding.scope,
    turnId,
    rawInput: `initial input for ${turnId}`,
  });
  const active = createJsonlActiveTurnJournal({
    filePath: input.journalPath,
    journal: input.journal,
    turnId,
  });
  await active.append({
    commitId: activeTurnCommitId(turnId, 'binding-opened'),
    record: {
      kind: 'binding-opened',
      binding: input.binding,
      currentTurnRef: input.binding.admittedTurn.currentTurnRef,
    },
  });
  await active.append({
    commitId: activeTurnCommitId(turnId, 'initial-input'),
    record: { kind: 'initial-input', content: initialInput },
  });
  await active.append({
    commitId: activeTurnCommitId(turnId, `invocation:${input.invocationId}`),
    record: {
      kind: 'child-invocation',
      record: {
        invocationId: input.invocationId,
        childTurnId: `child-${input.invocationId}`,
        checkpointReceiptRef: `checkpoint-${input.invocationId}`,
        binding: { kind: 'execution', assignment: input.binding.assignment },
      },
    },
  });
}

test('public inspection reader cold reopens the original invocation turn without writes', async () => {
  await withFixture(async ({ journalPath, assetRoot }) => {
    const organId = id('organ', 'inspection-resources-organ');
    const taskId = id('task', 'inspection-resources-task');
    const foreignTaskId = id('task', 'inspection-resources-foreign-task');
    const taskScope: TaskIdentityScope = { organId, taskId };
    const foreignTaskScope: TaskIdentityScope = { organId, taskId: foreignTaskId };
    const journal = new JsonlOrganJournal(journalPath);
    const identities = new JsonlTaskIdentityJournal(journal);
    await identities.append({
      scope: taskScope,
      source: {
        requirementId: 'inspection-resources-requirement',
        inputRevision: 1,
        draftId: 'inspection-resources-draft',
        draftRevisionVersion: 1,
        draftRevisionHash: 'sha256:inspection-resources-draft',
        confirmationRef: 'inspection-resources-confirmation',
      },
    });
    await identities.append({
      scope: foreignTaskScope,
      source: {
        requirementId: 'inspection-resources-foreign-requirement',
        inputRevision: 1,
        draftId: 'inspection-resources-foreign-draft',
        draftRevisionVersion: 1,
        draftRevisionHash: 'sha256:inspection-resources-foreign-draft',
        confirmationRef: 'inspection-resources-foreign-confirmation',
      },
    });

    const originalTurn = 'inspection-original-turn';
    const newerTurn = 'inspection-newer-turn';
    const foreignTurn = 'inspection-foreign-turn';
    const conflictTurnA = 'inspection-conflict-turn-a';
    const conflictTurnB = 'inspection-conflict-turn-b';
    const originalInvocation = 'invocation:inspection-original';
    const newerInvocation = 'invocation:inspection-newer';
    const foreignInvocation = 'invocation:inspection-foreign';
    const conflictInvocation = 'invocation:inspection-conflict';

    await appendInvocationTurn({
      journal,
      journalPath,
      assetRoot,
      binding: turnBinding(originalTurn, taskScope),
      invocationId: originalInvocation,
    });
    await appendInvocationTurn({
      journal,
      journalPath,
      assetRoot,
      binding: turnBinding(newerTurn, taskScope),
      invocationId: newerInvocation,
    });
    await appendInvocationTurn({
      journal,
      journalPath,
      assetRoot,
      binding: turnBinding(foreignTurn, foreignTaskScope),
      invocationId: foreignInvocation,
    });
    await appendInvocationTurn({
      journal,
      journalPath,
      assetRoot,
      binding: turnBinding(conflictTurnA, taskScope),
      invocationId: conflictInvocation,
    });
    await appendInvocationTurn({
      journal,
      journalPath,
      assetRoot,
      binding: turnBinding(conflictTurnB, taskScope),
      invocationId: conflictInvocation,
    });

    const beforeRead = await readFile(journalPath, 'utf8');
    const coldJournal = new JsonlOrganJournal(journalPath);
    const reader = createInspectionTurnResourceReader({
      filePath: journalPath,
      journal: coldJournal,
      artifactRoot: assetRoot,
      taskIdentity: new TaskIdentityConsumer(new JsonlTaskIdentityJournal(coldJournal)),
      scope: taskScope,
    });

    const original = await reader.forInvocation(originalInvocation);
    assert.equal(original?.logicalTurnId, originalTurn,
      'the original invocation must map to its original turn, not a newer or foreign turn');
    assert.equal(original?.identity.scope.taskId.value, taskId.value);
    assert.equal(await reader.forTurn(foreignTurn), null,
      'a turn from a foreign task must not return resources');
    assert.equal(await reader.forInvocation('invocation:inspection-absent'), null);
    await assert.rejects(
      () => reader.forInvocation(conflictInvocation),
      /bound to multiple turns/,
    );
    assert.equal(await readFile(journalPath, 'utf8'), beforeRead, 'reader calls must not write the Journal');
  });
});
