import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  id,
  STANDARD_TURN_END_TOOL_ID,
  type AcceptedRawFact,
  type AdmittedTurn,
  type Attention,
  type Checkpoint,
  type EvidenceRef,
  type RawAsset,
  type ScopeRef,
  type StandardTurnEndCommand,
  type WorkAssignment,
} from '../../packages/contracts/src/index.js';
import type { AttentionPort } from '../../packages/runtime/src/control/attention.js';
import {
  JsonlOrganJournal,
  createJsonlToolEffectLedgerJournal,
} from '../../packages/adapters/jsonl/src/index.js';
import {
  commitSubagentIncrementalCheckpoint,
  deriveToolEffectPolicy,
  evaluateAndPersistTurnRecovery,
  executeToolWithEffectLedger,
  reconcileHeldTurnEffectsForRecover,
} from '../../packages/runtime/src/checkpoints/submission.js';
import {
  RuntimeTaskCoordinator,
  type RuntimeExecutionAllocation,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeTaskAssembly,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { ServiceExecutionCheckpointStore } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { openUiRuntimeOrganJournal, UiRuntimeJournal } from '../../packages/app/src/ui-runtime/journal.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { createHash } from 'node:crypto';

function makeScope(taskIdValue = 'task-w2b-1', cycleIdValue = 'cycle-w2b-1', operationIdValue = 'op-w2b-1'): ScopeRef {
  return {
    organId: id('organ', 'brain'),
    taskId: id('task', taskIdValue),
    cycleId: id('cycle', cycleIdValue),
    operationId: id('operation', operationIdValue),
  };
}

function makeEvidenceRef(scope: ScopeRef, locator = 'recovery-state:w2b'): EvidenceRef {
  return {
    evidenceId: id('evidence', `ev-${Buffer.from(locator, 'utf8').toString('base64url').slice(0, 24)}`),
    kind: 'operation',
    source: 'w2b-test',
    locator,
    scope,
  };
}

export function makeAdmittedTurn(scope: ScopeRef, turnId = 'turn-w2b-1'): AdmittedTurn {
  return {
    turnId,
    workAssignmentRef: 'assign-w2b-1',
    taskRef: scope.taskId!,
    scopeRef: scope,
    cycleRef: scope.cycleId!,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: 1,
    runtimeBindingRef: 'runtime-w2b-1',
    permissionRevision: 'perm-1',
    admissionEvidenceRefs: ['ev-admit-1'],
    currentTurnRef: turnId,
    recoveryStateRef: 'recovery-state:w2b',
  };
}

export function makeWorkAssignment(scope: ScopeRef): WorkAssignment {
  return {
    assignmentId: 'assign-w2b-1',
    taskId: scope.taskId!,
    pipelineNodeId: 'node-w2b-1',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'Execute W2-B verification steps',
    targetRefs: [],
    expectedOutputRefs: [],
    successCriteria: ['All tool effects recorded in ledger'],
    failureCriteria: ['Unrecorded tool effect'],
    incompleteCriteria: ['Interrupted before turn closure'],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  };
}

const noopAttentionPort: AttentionPort = {
  async publish(input: Attention) {
    return { attentionId: input.attentionId, delivered: true as const };
  },
  async resolve(input: Attention) {
    return { attentionId: input.attentionId, delivered: true as const };
  },
};

function createStubTaskAssembly(): RuntimeTaskAssembly {
  return {
    orchestration: {
      planStage() {
        return { nodeId: 'stage-1', taskId: id('task', 't-1'), state: 'planned' };
      },
      async dispatch(input: {
        readonly assignment: {
          readonly taskId: ReturnType<typeof id<'task'>>;
          readonly pipelineNodeId: string;
          readonly assignmentId: string;
          readonly attempt: number;
          readonly executionEpoch: number;
          readonly inputRevision: number;
        };
      }) {
        return {
          status: 'merged' as const,
          result: {
            taskId: input.assignment.taskId,
            pipelineNodeId: input.assignment.pipelineNodeId,
            agentId: 'humanagent.provider-execution',
            assignmentId: input.assignment.assignmentId,
            attempt: input.assignment.attempt,
            executionEpoch: input.assignment.executionEpoch,
            inputRevision: input.assignment.inputRevision,
            producedArtifactRefs: [],
            status: 'succeeded' as const,
            summary: 'completed',
            outputRefs: [],
            evidenceRefs: [],
            nextAction: 'settle' as const,
          },
        };
      },
    },
  } as unknown as RuntimeTaskAssembly;
}

test('W2-B Scenario 1: pre-dispatch ledger save blocks tool execution on ledger failure and rejects mutating tool under readonly plan step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-w2b-s1-'));
  try {
    const journalPath = join(root, 'organ-journal.jsonl');
    const scope = makeScope('task-w2b-s1');
    const recoveryStateRef = makeEvidenceRef(scope, 'recovery:s1');

    assert.equal(deriveToolEffectPolicy(['inspect']), 'readonly');
    assert.equal(deriveToolEffectPolicy(['apply']), 'mutating');
    assert.equal(deriveToolEffectPolicy(['inspect', 'apply']), 'mutating');

    let toolExecuted = 0;
    const failingLedger = {
      async appendToolEffectLedgerEntry(): Promise<never> {
        throw new Error('simulated ledger disk write failure');
      },
      async readToolEffectLedgerEntries() {
        return [];
      },
      async appendTurnSegmentRecoveryFact(): Promise<never> {
        throw new Error('unused');
      },
      async readLatestTurnSegmentRecoveryFact() {
        return null;
      },
    };

    const checkpointStore = new ServiceExecutionCheckpointStore(
      journalPath,
      new JsonlOrganJournal(journalPath),
      () => new Date('2026-11-02T05:00:00.000Z'),
    );

    await assert.rejects(
      () =>
        executeToolWithEffectLedger({
          ledger: failingLedger,
          checkpointStore,
          scope,
          turnId: 'turn-w2b-s1',
          directiveRevision: 1,
          executionEpoch: 1,
          recoveryStateRef,
          toolCallId: 'call-write-1',
          toolId: 'file.write',
          supportedKinds: ['apply'],
          args: { path: 'out.txt', content: 'hello' },
          execute: async () => {
            toolExecuted += 1;
            return {
              output: '{"ok":true}',
              outputRefs: ['out.txt'],
              evidenceRefs: [recoveryStateRef],
              status: 'succeeded',
            };
          },
        }),
      /simulated ledger disk write failure/,
    );
    assert.equal(toolExecuted, 0, 'tool must not execute when pre-dispatch ledger commit fails');

    const realLedger = createJsonlToolEffectLedgerJournal({ filePath: journalPath });
    await assert.rejects(
      () =>
        executeToolWithEffectLedger({
          ledger: realLedger,
          checkpointStore,
          scope,
          turnId: 'turn-w2b-s1',
          directiveRevision: 1,
          executionEpoch: 1,
          recoveryStateRef,
          boundStepEffectPolicy: 'readonly',
          toolCallId: 'call-write-readonly-violation',
          toolId: 'file.write',
          supportedKinds: ['apply'],
          args: { path: 'forbidden.txt', content: 'nope' },
          execute: async () => {
            toolExecuted += 1;
            return {
              output: '{"ok":true}',
              outputRefs: ['forbidden.txt'],
              evidenceRefs: [recoveryStateRef],
              status: 'succeeded',
            };
          },
        }),
      /effect-policy|readonly/i,
    );
    assert.equal(toolExecuted, 0, 'mutating tool must be rejected before execution when bound step effectPolicy is readonly');
    const entriesAfterRejection = await realLedger.readToolEffectLedgerEntries({ scope, turnId: 'turn-w2b-s1' });
    assert.equal(entriesAfterRejection.length, 0, 'rejected mutating tool must not leave dispatched ledger entry');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W2-B Scenario 2 & 3: post-result ledger save, tool incremental checkpoint, idempotencyKey reuse without replay, and subagent incremental checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-w2b-s2-'));
  try {
    const journalPath = join(root, 'organ-journal.jsonl');
    const journal = new JsonlOrganJournal(journalPath);
    const ledger = createJsonlToolEffectLedgerJournal({ filePath: journalPath, journal });
    const checkpointStore = new ServiceExecutionCheckpointStore(
      journalPath,
      journal,
      () => new Date('2026-11-02T05:05:00.000Z'),
    );
    const scope = makeScope('task-w2b-s2');
    const recoveryStateRef = makeEvidenceRef(scope, 'recovery:s2');

    let writeExecutions = 0;
    const firstRun = await executeToolWithEffectLedger({
      ledger,
      checkpointStore,
      scope,
      turnId: 'turn-w2b-s2',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef,
      boundStepEffectPolicy: 'mutating',
      toolCallId: 'call-write-s2',
      toolId: 'file.write',
      supportedKinds: ['apply'],
      args: { path: 'notes.txt', content: 'committed-once' },
      execute: async () => {
        writeExecutions += 1;
        return {
          output: JSON.stringify({ written: 'notes.txt', bytes: 14 }),
          outputRefs: ['artifact:notes.txt'],
          evidenceRefs: [recoveryStateRef],
          status: 'succeeded',
        };
      },
    });

    assert.equal(writeExecutions, 1);
    assert.equal(firstRun.reusedCommittedEffect, false);
    assert.equal(firstRun.entry.state, 'effect-committed');
    assert.equal(firstRun.entry.effectPolicy, 'mutating');
    assert.equal(typeof firstRun.entry.outputArtifactRef, 'string');
    assert.equal(firstRun.checkpoint.checkpoint.checkpointKind, 'tool-incremental');
    assert.equal(firstRun.checkpoint.checkpoint.outcome, 'waiting');

    const persistedEntries = await ledger.readToolEffectLedgerEntries({ scope, turnId: 'turn-w2b-s2' });
    assert.equal(persistedEntries.length, 1);
    assert.equal(persistedEntries[0]?.entry.state, 'effect-committed');
    assert.equal(persistedEntries[0]?.entry.idempotencyKey, firstRun.entry.idempotencyKey);

    // Re-invoking with the same idempotencyKey (e.g. during cold recovery of the same turn) must reuse the committed result without re-executing the tool.
    const secondRun = await executeToolWithEffectLedger({
      ledger,
      checkpointStore,
      scope,
      turnId: 'turn-w2b-s2',
      directiveRevision: 1,
      executionEpoch: 2,
      recoveryStateRef,
      boundStepEffectPolicy: 'mutating',
      toolCallId: 'call-write-s2',
      toolId: 'file.write',
      supportedKinds: ['apply'],
      idempotencyKey: firstRun.entry.idempotencyKey,
      args: { path: 'notes.txt', content: 'committed-once' },
      execute: async () => {
        writeExecutions += 1;
        throw new Error('committed tool must not be re-executed');
      },
    });
    assert.equal(writeExecutions, 1, 'committed tool call must not be replayed');
    assert.equal(secondRun.reusedCommittedEffect, true);
    assert.equal(secondRun.result.output, firstRun.result.output);

    // Scenario 3: subagent incremental checkpoint committed before Turn closes
    const subagentCkpt = await commitSubagentIncrementalCheckpoint({
      checkpointStore,
      scope,
      turnId: 'turn-w2b-s2',
      invocationId: 'inv-subagent-1',
      subagentKind: 'execution',
      summary: 'Subagent execution completed before turn closure',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef,
      evidenceRefs: [recoveryStateRef],
    });
    assert.equal(subagentCkpt.checkpoint.checkpointKind, 'subagent-incremental');
    assert.equal(subagentCkpt.checkpoint.outcome, 'waiting');
    const recalledSubagentCkpt = await checkpointStore.readCommitted(scope, subagentCkpt.checkpoint.id);
    assert.equal(recalledSubagentCkpt?.checkpoint.id.value, subagentCkpt.checkpoint.id.value);
    assert.equal(recalledSubagentCkpt?.checkpoint.checkpointKind, 'subagent-incremental');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W2-B Scenario 4, 5, 6, 7 & 8: recovery-auto-resumed, recovery-hold-effect-unknown, explicit idempotent recover, active stop, and missing/corrupt facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-w2b-s4-'));
  try {
    const journalPath = join(root, 'organ-journal.jsonl');
    const journal = new JsonlOrganJournal(journalPath);
    const ledger = createJsonlToolEffectLedgerJournal({ filePath: journalPath, journal });
    const checkpointStore = new ServiceExecutionCheckpointStore(
      journalPath,
      journal,
      () => new Date('2026-11-02T05:10:00.000Z'),
    );

    // Scenario 4: Safe cold recovery (only readonly or effect-committed entries) -> recovery-auto-resumed
    const scopeSafe = makeScope('task-w2b-safe', 'cycle-safe', 'op-safe');
    const refSafe = makeEvidenceRef(scopeSafe, 'recovery:safe');
    await ledger.appendToolEffectLedgerEntry({
      scope: scopeSafe,
      turnId: 'turn-safe',
      toolCallId: 'call-read-1',
      toolName: 'file.read',
      effectPolicy: 'readonly',
      idempotencyKey: 'idem:turn-safe:call-read-1',
      argsDigest: 'sha256:1111',
      state: 'dispatched-effect-unknown',
    });
    await ledger.appendToolEffectLedgerEntry({
      scope: scopeSafe,
      turnId: 'turn-safe',
      toolCallId: 'call-write-committed',
      toolName: 'file.write',
      effectPolicy: 'mutating',
      idempotencyKey: 'idem:turn-safe:call-write-committed',
      argsDigest: 'sha256:2222',
      state: 'dispatched-effect-unknown',
    });
    await ledger.appendToolEffectLedgerEntry({
      scope: scopeSafe,
      turnId: 'turn-safe',
      toolCallId: 'call-write-committed',
      toolName: 'file.write',
      effectPolicy: 'mutating',
      idempotencyKey: 'idem:turn-safe:call-write-committed',
      argsDigest: 'sha256:2222',
      state: 'effect-committed',
      outputArtifactRef: 'artifact:safe-write',
    });

    const safeDecision = await evaluateAndPersistTurnRecovery({
      ledger,
      checkpointStore,
      scope: scopeSafe,
      turnId: 'turn-safe',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refSafe,
    });
    assert.equal(safeDecision.outcome, 'recovery-auto-resumed');
    assert.equal(safeDecision.checkpoint?.checkpoint.recoveryOutcome, 'recovery-auto-resumed');
    assert.equal(safeDecision.checkpoint?.checkpoint.checkpointKind, 'recovery');
    assert.equal(safeDecision.fact?.outcome, 'recovery-auto-resumed');

    // Scenario 5: Unknown mutating effect (mutating + dispatched-effect-unknown) -> recovery-hold-effect-unknown
    const scopeHold = makeScope('task-w2b-hold', 'cycle-hold', 'op-hold');
    const refHold = makeEvidenceRef(scopeHold, 'recovery:hold');
    await ledger.appendToolEffectLedgerEntry({
      scope: scopeHold,
      turnId: 'turn-hold',
      toolCallId: 'call-bash-unknown',
      toolName: 'bash',
      effectPolicy: 'mutating',
      idempotencyKey: 'idem:turn-hold:call-bash-unknown',
      argsDigest: 'sha256:3333',
      state: 'dispatched-effect-unknown',
    });

    const holdDecision = await evaluateAndPersistTurnRecovery({
      ledger,
      checkpointStore,
      scope: scopeHold,
      turnId: 'turn-hold',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refHold,
    });
    assert.equal(holdDecision.outcome, 'recovery-hold-effect-unknown');
    assert.deepEqual(holdDecision.allowedActions, ['recover', 'stop']);
    assert.equal(holdDecision.checkpoint?.checkpoint.outcome, 'blocked');
    assert.equal(holdDecision.checkpoint?.checkpoint.recoveryOutcome, 'recovery-hold-effect-unknown');
    assert.equal(holdDecision.fact?.outcome, 'recovery-hold-effect-unknown');

    // Scenario 6: Explicit recover transitions held entry to reconciled, commits recovery-auto-resumed, and is idempotent on duplicate calls
    const recoveredFirst = await reconcileHeldTurnEffectsForRecover({
      ledger,
      checkpointStore,
      scope: scopeHold,
      turnId: 'turn-hold',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refHold,
      operatorNote: 'Verified external bash side effect is clean',
    });
    assert.equal(recoveredFirst.outcome, 'recovery-auto-resumed');
    assert.equal(recoveredFirst.checkpoint?.checkpoint.recoveryOutcome, 'recovery-auto-resumed');
    const holdEntriesAfterRecover = await ledger.readToolEffectLedgerEntries({ scope: scopeHold, turnId: 'turn-hold' });
    assert.equal(holdEntriesAfterRecover.length, 1);
    assert.equal(holdEntriesAfterRecover[0]?.entry.state, 'reconciled');

    const journalBeforeDuplicateRecover = await readFile(journalPath, 'utf8');
    const recoveredDuplicate = await reconcileHeldTurnEffectsForRecover({
      ledger,
      checkpointStore,
      scope: scopeHold,
      turnId: 'turn-hold',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refHold,
      operatorNote: 'Verified external bash side effect is clean',
    });
    const journalAfterDuplicateRecover = await readFile(journalPath, 'utf8');
    assert.equal(recoveredDuplicate.outcome, 'recovery-auto-resumed');
    assert.equal(
      recoveredDuplicate.checkpoint?.checkpoint.id.value,
      recoveredFirst.checkpoint?.checkpoint.id.value,
      'duplicate recover call must be idempotent and return the same recovery checkpoint',
    );
    assert.equal(journalAfterDuplicateRecover, journalBeforeDuplicateRecover, 'duplicate recover must not append duplicate records');

    // Confirm reconciled mutating tool is NOT re-executed when the resumed turn encounters its idempotencyKey
    let bashReexecuted = 0;
    const reconciledToolReplay = await executeToolWithEffectLedger({
      ledger,
      checkpointStore,
      scope: scopeHold,
      turnId: 'turn-hold',
      directiveRevision: 1,
      executionEpoch: 2,
      recoveryStateRef: refHold,
      boundStepEffectPolicy: 'mutating',
      toolCallId: 'call-bash-unknown',
      toolId: 'bash',
      supportedKinds: ['apply'],
      idempotencyKey: 'idem:turn-hold:call-bash-unknown',
      args: { command: 'rm -rf tmp-build' },
      execute: async () => {
        bashReexecuted += 1;
        throw new Error('reconciled mutating tool must not be silently replayed');
      },
    });
    assert.equal(bashReexecuted, 0, 'reconciled mutating tool must never be re-executed');
    assert.equal(reconciledToolReplay.reusedReconciledEffect, true);

    // Scenario 7: Active operator stop commits stopped outcome and never auto-resumes
    const scopeStop = makeScope('task-w2b-stop', 'cycle-stop', 'op-stop');
    const refStop = makeEvidenceRef(scopeStop, 'recovery:stop');
    const stoppedDecision = await evaluateAndPersistTurnRecovery({
      ledger,
      checkpointStore,
      scope: scopeStop,
      turnId: 'turn-stop',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refStop,
      stopped: true,
    });
    assert.equal(stoppedDecision.outcome, 'stopped');
    assert.deepEqual(stoppedDecision.allowedActions, ['start']);

    // Scenario 8: Missing or corrupt recovery facts preserve original error/owner in blocked state and never fabricate settle or auto-resume
    const scopeCorrupt = makeScope('task-w2b-corrupt', 'cycle-corrupt', 'op-corrupt');
    const refCorrupt = makeEvidenceRef(scopeCorrupt, 'recovery:corrupt');
    const corruptLedger = {
      ...ledger,
      async readToolEffectLedgerEntries(): Promise<never> {
        throw new Error('corrupt active-turn ledger digest mismatch');
      },
    };
    const corruptDecision = await evaluateAndPersistTurnRecovery({
      ledger: corruptLedger,
      checkpointStore,
      scope: scopeCorrupt,
      turnId: 'turn-corrupt',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refCorrupt,
    });
    assert.equal(corruptDecision.outcome, 'corrupt-blocked');
    assert.deepEqual(corruptDecision.allowedActions, []);
    assert.equal(corruptDecision.error?.includes('corrupt active-turn ledger digest mismatch'), true);
    assert.equal(corruptDecision.checkpoint?.checkpoint.outcome, 'blocked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W2-B Coordinator hydrate & recoverTask E2E: recovery-hold sets allowedActions [recover, stop], recoverTask reconciles and resumes same Turn without replaying mutating tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-w2b-coord-'));
  try {
    const controlPath = join(dir, 'control.jsonl');
    const uiJournalPath = join(dir, 'ui-runtime-journal.jsonl');
    const organJournal = openUiRuntimeOrganJournal(controlPath);
    const uiJournal = new UiRuntimeJournal(uiJournalPath);
    const store = new ServiceExecutionCheckpointStore(controlPath, organJournal, () => new Date('2026-11-02T05:15:00.000Z'));
    const currentStatePort = createJsonlRuntimeTaskCurrentStateJournal({ journal: organJournal });
    const ledger = createJsonlToolEffectLedgerJournal({ filePath: controlPath, journal: organJournal });

    let resumedRuns = 0;
    const makeDriver = (_driverInput: RuntimeExecutionDriverInput): RuntimeExecutionDriver => ({
      kind: 'test-w2b-driver',
      async capabilities() {
        return { driverKind: 'test-w2b-driver', capabilities: ['execute'], version: '1' };
      },
      async start(startInput) {
        return { runtimeId: startInput.runtimeId, executionEpoch: startInput.executionEpoch };
      },
      async resume(resumeInput) {
        return { runtimeId: resumeInput.runtimeId, executionEpoch: resumeInput.executionEpoch };
      },
      async submit(submitInput) {
        resumedRuns += 1;
        return {
          taskId: submitInput.taskId,
          executionEpoch: submitInput.executionEpoch,
          assignmentId: submitInput.assignmentId,
          payload: submitInput.payload,
          outputRefs: [],
          evidenceRefs: [],
        };
      },
      async *observe() {},
      async requestStop(stopInput) {
        return { requested: true, operationId: stopInput.operationId };
      },
      async settle() {
        return { state: 'succeeded' as const, evidenceRefs: [] };
      },
      async close() {
        return {
          bindingId: 'binding-w2b',
          providerId: 'provider-w2b',
          protocol: 'responses' as const,
          state: 'closed' as const,
          evidenceRefs: [],
        };
      },
    });

    const makeCoordinator = () =>
      new RuntimeTaskCoordinator({
        organId: id('organ', 'brain'),
        checkpointStoreFor: () => store,
        publicOutputStoreFor: () => store,
        effectLedgerFor: () => ledger,
        journal: uiJournal,
        attentionPort: noopAttentionPort,
        admitExecution: async (_alloc: RuntimeExecutionAllocation) => {},
        currentStatePort,
        createTaskAssembly: () => createStubTaskAssembly(),
        createDriver: async (driverInput: RuntimeExecutionDriverInput) => makeDriver(driverInput),
      });

    const coordinator1 = makeCoordinator();
    const task = coordinator1.createTask({
      title: 'Interrupted mutating tool task',
      directive: 'Run mutating tool then recover after interruption',
    });
    const alloc = coordinator1.prepareExecution(task.taskId, {
      prompt: 'Run mutating tool then recover after interruption',
    });

    const scope: ScopeRef = {
      organId: id('organ', 'brain'),
      taskId: task.taskId,
      cycleId: alloc.scope.cycleId!,
      operationId: alloc.operationId,
    };
    const turnId = `turn:${alloc.operationId.value}`;

    // Simulate interruption while a mutating tool is in dispatched-effect-unknown state
    await ledger.appendToolEffectLedgerEntry({
      scope,
      turnId,
      toolCallId: 'call-mutating-1',
      toolName: 'file.write',
      effectPolicy: 'mutating',
      idempotencyKey: `idem:${turnId}:call-mutating-1`,
      argsDigest: 'sha256:abcd',
      state: 'dispatched-effect-unknown',
    });

    // Hydrate a new coordinator instance over the same durable journal
    const coordinator2 = makeCoordinator();
    await coordinator2.hydrate();

    const snapAfterHydrate = coordinator2.taskSnapshot(task.taskId);
    assert.equal(snapAfterHydrate.state, 'blocked');
    assert.deepEqual(snapAfterHydrate.allowedActions, ['recover', 'stop']);
    assert.equal(snapAfterHydrate.checkpoint?.recoveryOutcome, 'recovery-hold-effect-unknown');
    assert.equal(resumedRuns, 0, 'recovery-hold must not auto-resume before operator recover');

    // Operator invokes recoverTask (and duplicate recoverTask call is idempotent)
    const [recoveredSnap1, recoveredSnap2] = await Promise.all([
      coordinator2.recoverTask(task.taskId),
      coordinator2.recoverTask(task.taskId),
    ]);
    assert.equal(recoveredSnap1.taskId.value, task.taskId.value);
    assert.equal(recoveredSnap2.taskId.value, task.taskId.value);

    const deadline = Date.now() + 5000;
    while (coordinator2.taskSnapshot(task.taskId).state !== 'succeeded' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const finalSnap = coordinator2.taskSnapshot(task.taskId);
    assert.equal(finalSnap.state, 'succeeded');
    assert.equal(resumedRuns, 1, 'duplicate recoverTask must only resume execution once');
    const finalLedger = await ledger.readToolEffectLedgerEntries({ scope, turnId });
    assert.equal(finalLedger[0]?.entry.state, 'reconciled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
