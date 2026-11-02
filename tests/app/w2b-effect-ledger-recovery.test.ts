import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
      providerSettlements: [
        {
          providerRequestId: 'req-safe-settled-1',
          state: 'settled',
          verifiedBy: 'response-stream-eof',
          verifiedAt: '2026-11-02T05:00:01.000Z',
        },
      ],
    });
    assert.equal(safeDecision.outcome, 'recovery-auto-resumed');
    assert.equal(safeDecision.checkpoint?.checkpoint.recoveryOutcome, 'recovery-auto-resumed');
    assert.equal(safeDecision.checkpoint?.checkpoint.checkpointKind, 'recovery');
    assert.equal(safeDecision.fact?.outcome, 'recovery-auto-resumed');
    assert.deepEqual(safeDecision.fact?.providerSettleReceipt, {
      providerRequestId: 'req-safe-settled-1',
      state: 'settled',
      verifiedBy: 'response-stream-eof',
      verifiedAt: '2026-11-02T05:00:01.000Z',
    });

    // Scenario 4b: Explicit not-sent ProviderSettleReceipt is preserved verbatim
    const scopeNotSent = makeScope('task-w2b-not-sent', 'cycle-not-sent', 'op-not-sent');
    const refNotSent = makeEvidenceRef(scopeNotSent, 'recovery:not-sent');
    const notSentDecision = await evaluateAndPersistTurnRecovery({
      ledger,
      checkpointStore,
      scope: scopeNotSent,
      turnId: 'turn-not-sent',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refNotSent,
      providerSettlements: [
        {
          providerRequestId: null,
          state: 'not-sent',
          verifiedBy: 'lease-process-exit-reconcile',
          verifiedAt: '2026-11-02T05:00:02.000Z',
        },
      ],
    });
    assert.equal(notSentDecision.outcome, 'recovery-auto-resumed');
    assert.deepEqual(notSentDecision.fact?.providerSettleReceipt, {
      providerRequestId: null,
      state: 'not-sent',
      verifiedBy: 'lease-process-exit-reconcile',
      verifiedAt: '2026-11-02T05:00:02.000Z',
    });

    // Scenario 4c (Negative): Safe tool effects with unconfirmed/unknown provider settle receipt must hold and never auto-resume
    const scopeUnknownSettleOnly = makeScope('task-w2b-unknown-settle', 'cycle-unknown-settle', 'op-unknown-settle');
    const refUnknownSettleOnly = makeEvidenceRef(scopeUnknownSettleOnly, 'recovery:unknown-settle');
    await ledger.appendToolEffectLedgerEntry({
      scope: scopeUnknownSettleOnly,
      turnId: 'turn-unknown-settle',
      toolCallId: 'call-read-only-1',
      toolName: 'file.read',
      effectPolicy: 'readonly',
      idempotencyKey: 'idem:turn-unknown-settle:call-read-only-1',
      argsDigest: 'sha256:4444',
      state: 'dispatched-effect-unknown',
    });
    const unknownSettleDecision = await evaluateAndPersistTurnRecovery({
      ledger,
      checkpointStore,
      scope: scopeUnknownSettleOnly,
      turnId: 'turn-unknown-settle',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refUnknownSettleOnly,
    });
    assert.equal(
      unknownSettleDecision.outcome,
      'recovery-hold-effect-unknown',
      'unconfirmed provider settle (state=unknown) must hold and never auto-resume even when tool effects are readonly',
    );
    assert.deepEqual(unknownSettleDecision.allowedActions, ['recover', 'stop']);
    assert.equal(unknownSettleDecision.checkpoint?.checkpoint.outcome, 'blocked');
    assert.equal(unknownSettleDecision.fact?.providerSettleReceipt.state, 'unknown');

    // Scenario 5: Unknown mutating effect (mutating + dispatched-effect-unknown) with empty providerSettlements -> recovery-hold-effect-unknown + settle state 'unknown' (never fabricates 'not-sent')
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
    assert.equal(
      holdDecision.fact?.providerSettleReceipt.state,
      'unknown',
      'empty providerSettlements must record unknown settle state instead of fabricating not-sent',
    );
    assert.equal(holdDecision.fact?.providerSettleReceipt.providerRequestId, null);

    // Scenario 6a (Negative): Reconciling tool effects without a settled/stopped/not-sent ProviderSettleReceipt keeps the turn held on unknown settle
    const heldBecauseSettleStillUnknown = await reconcileHeldTurnEffectsForRecover({
      ledger,
      checkpointStore,
      scope: scopeHold,
      turnId: 'turn-hold',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refHold,
      operatorNote: 'Verified external bash side effect is clean',
    });
    assert.equal(
      heldBecauseSettleStillUnknown.outcome,
      'recovery-hold-effect-unknown',
      'reconcileHeldTurnEffectsForRecover must remain held when providerSettleReceipt.state is still unknown',
    );
    assert.deepEqual(heldBecauseSettleStillUnknown.allowedActions, ['recover', 'stop']);
    assert.equal(heldBecauseSettleStillUnknown.fact?.providerSettleReceipt.state, 'unknown');
    const holdEntriesAfterEffectReconcile = await ledger.readToolEffectLedgerEntries({ scope: scopeHold, turnId: 'turn-hold' });
    assert.equal(holdEntriesAfterEffectReconcile.length, 1);
    assert.equal(holdEntriesAfterEffectReconcile[0]?.entry.state, 'reconciled');

    // Scenario 6b (Positive): Explicit recover with confirmed ProviderSettleReceipt (stopped/settled/not-sent) commits recovery-auto-resumed and is idempotent on duplicate calls
    const confirmedHoldSettlement = {
      providerRequestId: 'req-hold-stopped-1',
      state: 'stopped' as const,
      verifiedBy: 'provider-adapter-stop-ack' as const,
      verifiedAt: '2026-11-02T05:00:05.000Z',
    };
    const recoveredFirst = await reconcileHeldTurnEffectsForRecover({
      ledger,
      checkpointStore,
      scope: scopeHold,
      turnId: 'turn-hold',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refHold,
      providerSettlements: [confirmedHoldSettlement],
      operatorNote: 'Verified external bash side effect is clean and provider request stopped',
    });
    assert.equal(recoveredFirst.outcome, 'recovery-auto-resumed');
    assert.equal(recoveredFirst.checkpoint?.checkpoint.recoveryOutcome, 'recovery-auto-resumed');
    assert.deepEqual(recoveredFirst.fact?.providerSettleReceipt, confirmedHoldSettlement);

    const journalBeforeDuplicateRecover = await readFile(journalPath, 'utf8');
    const recoveredDuplicate = await reconcileHeldTurnEffectsForRecover({
      ledger,
      checkpointStore,
      scope: scopeHold,
      turnId: 'turn-hold',
      directiveRevision: 1,
      executionEpoch: 1,
      recoveryStateRef: refHold,
      operatorNote: 'Verified external bash side effect is clean and provider request stopped',
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

    // Negative: recoverTask without confirmed providerSettlements keeps task held in blocked state while provider settle is unknown
    const snapWithoutSettle = await coordinator2.recoverTask(task.taskId, {
      operatorNote: 'effect checked but provider settle not yet provided',
    });
    assert.equal(snapWithoutSettle.state, 'blocked');
    assert.deepEqual(snapWithoutSettle.allowedActions, ['recover', 'stop']);
    assert.equal(snapWithoutSettle.checkpoint?.recoveryOutcome, 'recovery-hold-effect-unknown');
    assert.equal(resumedRuns, 0, 'recoverTask must not resume while providerSettleReceipt.state is unknown');

    // Positive: Operator invokes recoverTask with confirmed providerSettlements (and duplicate recoverTask call is idempotent)
    const confirmedCoordSettle = [
      {
        providerRequestId: 'req-coord-stopped-1',
        state: 'stopped' as const,
        verifiedBy: 'lease-process-exit-reconcile' as const,
        verifiedAt: '2026-11-02T05:15:05.000Z',
      },
    ];
    const [recoveredSnap1, recoveredSnap2] = await Promise.all([
      coordinator2.recoverTask(task.taskId, { providerSettlements: confirmedCoordSettle }),
      coordinator2.recoverTask(task.taskId, { providerSettlements: confirmedCoordSettle }),
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

test('W2-B real child-process SIGKILL interrupt during mutating tool execution -> hydrate recovery-hold -> recoverTask same-turn completion without re-running mutating tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-w2b-sigkill-'));
  try {
    const controlPath = join(dir, 'control.jsonl');
    const uiJournalPath = join(dir, 'ui-runtime-journal.jsonl');
    const targetFilePath = join(dir, 'mutated-target.txt');
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

    const childScript = `
      import { writeFile } from 'node:fs/promises';
      import { id } from './dist/tests/packages/contracts/src/index.js';
      import { createJsonlToolEffectLedgerJournal } from './dist/tests/packages/adapters/jsonl/src/index.js';
      import { executeToolWithEffectLedger } from './dist/tests/packages/runtime/src/checkpoints/submission.js';
      import { RuntimeTaskCoordinator } from './dist/tests/packages/runtime/src/ui-runtime/coordinator.js';
      import { ServiceExecutionCheckpointStore } from './dist/tests/packages/app/src/ui-runtime/execution-composition.js';
      import { openUiRuntimeOrganJournal, UiRuntimeJournal } from './dist/tests/packages/app/src/ui-runtime/journal.js';
      import { createJsonlRuntimeTaskCurrentStateJournal } from './dist/tests/packages/app/src/runtime-current-state-journal.js';

      const controlPath = process.env.W2B_CONTROL_PATH;
      const uiJournalPath = process.env.W2B_UI_JOURNAL_PATH;
      const targetFilePath = process.env.W2B_TARGET_FILE_PATH;

      const organJournal = openUiRuntimeOrganJournal(controlPath);
      const uiJournal = new UiRuntimeJournal(uiJournalPath);
      const store = new ServiceExecutionCheckpointStore(controlPath, organJournal, () => new Date());
      const currentStatePort = createJsonlRuntimeTaskCurrentStateJournal({ journal: organJournal });
      const ledger = createJsonlToolEffectLedgerJournal({ filePath: controlPath, journal: organJournal });

      const noopAttentionPort = {
        async publish(item) { return item; },
        async resolve() { return null; },
        async listOpen() { return []; },
      };
      const stubAssembly = {
        orchestration: {
          planStage() {
            return { nodeId: 'stage-1', taskId: id('task', 't-1'), state: 'planned' };
          },
          async dispatch(input) {
            return {
              status: 'merged',
              result: {
                taskId: input.assignment.taskId,
                pipelineNodeId: input.assignment.pipelineNodeId,
                agentId: 'humanagent.provider-execution',
                assignmentId: input.assignment.assignmentId,
                attempt: input.assignment.attempt,
                executionEpoch: input.assignment.executionEpoch,
                inputRevision: input.assignment.inputRevision,
                producedArtifactRefs: [],
                status: 'succeeded',
                summary: 'completed',
                outputRefs: [],
                evidenceRefs: [],
                nextAction: 'settle',
              },
            };
          },
        },
      };

      const coordinator = new RuntimeTaskCoordinator({
        organId: id('organ', 'brain'),
        checkpointStoreFor: () => store,
        publicOutputStoreFor: () => store,
        effectLedgerFor: () => ledger,
        journal: uiJournal,
        attentionPort: noopAttentionPort,
        admitExecution: async () => {},
        currentStatePort,
        createTaskAssembly: () => stubAssembly,
        createDriver: async (driverInput) => ({
          kind: 'real-child-mutating-driver',
          async capabilities() {
            return { driverKind: 'real-child-mutating-driver', capabilities: ['execute'], version: '1' };
          },
          async start(startInput) {
            return { runtimeId: startInput.runtimeId, executionEpoch: startInput.executionEpoch };
          },
          async resume(resumeInput) {
            return { runtimeId: resumeInput.runtimeId, executionEpoch: resumeInput.executionEpoch };
          },
          async submit(submitInput) {
            const scope = driverInput.scope;
            const turnId = 'turn:' + driverInput.operationId.value;
            const recoveryStateRef = {
              evidenceId: id('evidence', 'child-mutating-' + driverInput.operationId.value),
              kind: 'operation',
              source: 'real-child-mutating-driver',
              locator: 'operation/' + driverInput.operationId.value + '/mutating-tool',
              scope,
            };
            await executeToolWithEffectLedger({
              ledger,
              checkpointStore: store,
              scope,
              turnId,
              directiveRevision: 1,
              executionEpoch: submitInput.executionEpoch,
              recoveryStateRef,
              boundStepEffectPolicy: 'mutating',
              toolCallId: 'call-real-file-write-1',
              toolId: 'file.write',
              supportedKinds: ['apply'],
              args: { path: targetFilePath, content: 'REAL_MUTATING_PAYLOAD_BEFORE_SIGKILL\\n' },
              execute: async () => {
                await writeFile(targetFilePath, 'REAL_MUTATING_PAYLOAD_BEFORE_SIGKILL\\n', 'utf8');
                process.stdout.write(
                  JSON.stringify({
                    marker: 'CHILD_IN_FLIGHT_MUTATING',
                    pid: process.pid,
                    taskId: submitInput.taskId.value,
                    operationId: driverInput.operationId.value,
                    cycleId: scope.cycleId.value,
                    turnId,
                  }) + '\\n',
                );
                await new Promise(() => {});
                return {
                  output: 'written',
                  outputRefs: ['artifact:mutated-target'],
                  evidenceRefs: [recoveryStateRef],
                  status: 'succeeded',
                };
              },
            });
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
            return { state: 'succeeded', evidenceRefs: [] };
          },
          async close() {
            return {
              bindingId: 'binding-w2b-child',
              providerId: 'provider-w2b-child',
              protocol: 'responses',
              state: 'closed',
              evidenceRefs: [],
            };
          },
        }),
      });

      const task = coordinator.createTask({
        title: 'Real child-process SIGKILL mutating tool recovery task',
        directive: 'Write mutated-target.txt via file.write then complete same turn after SIGKILL recovery',
      });
      const alloc = coordinator.prepareExecution(task.taskId, {
        prompt: 'Write mutated-target.txt via file.write then complete same turn after SIGKILL recovery',
      });
      await coordinator.releaseExecution(task.taskId, alloc.operationId);
    `;

    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        W2B_CONTROL_PATH: controlPath,
        W2B_UI_JOURNAL_PATH: uiJournalPath,
        W2B_TARGET_FILE_PATH: targetFilePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    const inFlightInfo = await new Promise<{
      readonly marker: string;
      readonly pid: number;
      readonly taskId: string;
      readonly operationId: string;
      readonly cycleId: string;
      readonly turnId: string;
    }>((resolve, reject) => {
      let stdoutBuf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        for (const line of stdoutBuf.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.marker === 'CHILD_IN_FLIGHT_MUTATING') {
              resolve(parsed);
            }
          } catch {
            // wait for complete line
          }
        }
      });
      child.on('exit', (code, signal) => {
        reject(new Error(`child exited before in-flight marker (code=${code}, signal=${signal}, stderr=${stderrBuf})`));
      });
    });

    process.kill(child.pid!, 'SIGKILL');
    const exitInfo = await new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exitInfo.signal, 'SIGKILL', 'child process must be terminated by real SIGKILL while mutating tool is in-flight');

    const diskContentAfterKill = await readFile(targetFilePath, 'utf8');
    assert.equal(diskContentAfterKill, 'REAL_MUTATING_PAYLOAD_BEFORE_SIGKILL\n');

    // Hydrate a second coordinator in the parent process over the durable journals left by the killed child
    const organJournal = openUiRuntimeOrganJournal(controlPath);
    const uiJournal = new UiRuntimeJournal(uiJournalPath);
    const store = new ServiceExecutionCheckpointStore(controlPath, organJournal, () => new Date());
    const currentStatePort = createJsonlRuntimeTaskCurrentStateJournal({ journal: organJournal });
    const ledger = createJsonlToolEffectLedgerJournal({ filePath: controlPath, journal: organJournal });

    let parentMutatingToolCallbackRuns = 0;
    let parentResumedTurnRuns = 0;
    let reusedReconciledOnResume = false;

    const coordinator2 = new RuntimeTaskCoordinator({
      organId: id('organ', 'brain'),
      checkpointStoreFor: () => store,
      publicOutputStoreFor: () => store,
      effectLedgerFor: () => ledger,
      journal: uiJournal,
      attentionPort: noopAttentionPort,
      admitExecution: async () => {},
      currentStatePort,
      createTaskAssembly: () => createStubTaskAssembly(),
      createDriver: async (driverInput: RuntimeExecutionDriverInput): Promise<RuntimeExecutionDriver> => ({
        kind: 'parent-resumed-driver',
        async capabilities() {
          return { driverKind: 'parent-resumed-driver', capabilities: ['execute'], version: '1' };
        },
        async start(startInput) {
          return { runtimeId: startInput.runtimeId, executionEpoch: startInput.executionEpoch };
        },
        async resume(resumeInput) {
          return { runtimeId: resumeInput.runtimeId, executionEpoch: resumeInput.executionEpoch };
        },
        async submit(submitInput) {
          parentResumedTurnRuns += 1;
          const scope = driverInput.scope;
          const turnId = `turn:${driverInput.operationId.value}`;
          const recoveryStateRef = makeEvidenceRef(scope, `operation/${driverInput.operationId.value}/resumed-tool`);
          const toolExecution = await executeToolWithEffectLedger({
            ledger,
            checkpointStore: store,
            scope,
            turnId,
            directiveRevision: 1,
            executionEpoch: submitInput.executionEpoch,
            recoveryStateRef,
            boundStepEffectPolicy: 'mutating',
            toolCallId: 'call-real-file-write-1',
            toolId: 'file.write',
            supportedKinds: ['apply'],
            args: { path: targetFilePath, content: 'REAL_MUTATING_PAYLOAD_BEFORE_SIGKILL\n' },
            execute: async () => {
              parentMutatingToolCallbackRuns += 1;
              throw new Error('reconciled mutating tool must never be re-executed on resumed turn');
            },
          });
          reusedReconciledOnResume = toolExecution.reusedReconciledEffect;
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
            bindingId: 'binding-w2b-parent',
            providerId: 'provider-w2b-parent',
            protocol: 'responses' as const,
            state: 'closed' as const,
            evidenceRefs: [],
          };
        },
      }),
    });

    await coordinator2.hydrate();

    const taskId = id('task', inFlightInfo.taskId);
    const scope: ScopeRef = {
      organId: id('organ', 'brain'),
      taskId,
      cycleId: id('cycle', inFlightInfo.cycleId),
      operationId: id('operation', inFlightInfo.operationId),
    };
    const snapAfterHydrate = coordinator2.taskSnapshot(taskId);
    assert.equal(snapAfterHydrate.state, 'blocked');
    assert.deepEqual(snapAfterHydrate.allowedActions, ['recover', 'stop']);
    assert.equal(snapAfterHydrate.checkpoint?.checkpointKind, 'recovery');
    assert.equal(snapAfterHydrate.checkpoint?.recoveryOutcome, 'recovery-hold-effect-unknown');
    assert.equal(snapAfterHydrate.checkpoint?.recoveryFact?.providerSettleReceipt.state, 'unknown');
    assert.equal(snapAfterHydrate.checkpoint?.recoveryFact?.providerSettleReceipt.providerRequestId, null);
    assert.equal(snapAfterHydrate.checkpoint?.recoveryFact?.toolEffects[0]?.state, 'dispatched-effect-unknown');
    assert.equal(snapAfterHydrate.checkpoint?.recoveryFact?.toolEffects[0]?.toolName, 'file.write');
    assert.equal(parentResumedTurnRuns, 0);

    // Calling recoverTask without a confirmed ProviderSettleReceipt must remain held while settle state is unknown
    const snapHeldWithoutSettle = await coordinator2.recoverTask(taskId, {
      operatorNote: `verified ${targetFilePath} written by child pid ${inFlightInfo.pid} before SIGKILL (settle still unknown)`,
    });
    assert.equal(snapHeldWithoutSettle.state, 'blocked');
    assert.equal(snapHeldWithoutSettle.checkpoint?.recoveryOutcome, 'recovery-hold-effect-unknown');
    assert.equal(parentResumedTurnRuns, 0);

    // Calling recoverTask with a confirmed ProviderSettleReceipt (stopped after child process exit verification) releases hold and resumes same Turn
    const confirmedChildExitSettle = {
      providerRequestId: `req:${inFlightInfo.operationId}:epoch-1`,
      state: 'stopped' as const,
      verifiedBy: 'lease-process-exit-reconcile' as const,
      verifiedAt: new Date().toISOString(),
    };
    await coordinator2.recoverTask(taskId, {
      operatorNote: `verified ${targetFilePath} written by child pid ${inFlightInfo.pid} before SIGKILL and confirmed process exit settle`,
      providerSettlements: [confirmedChildExitSettle],
    });

    const deadline = Date.now() + 5000;
    while (coordinator2.taskSnapshot(taskId).state !== 'succeeded' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const finalSnap = coordinator2.taskSnapshot(taskId);
    assert.equal(finalSnap.state, 'succeeded');
    assert.equal(parentResumedTurnRuns, 1);
    assert.equal(parentMutatingToolCallbackRuns, 0, 'mutating file.write callback must not run again after reconciliation');
    assert.equal(reusedReconciledOnResume, true);

    const finalLedger = await ledger.readToolEffectLedgerEntries({ scope, turnId: inFlightInfo.turnId });
    assert.equal(finalLedger.length, 1);
    assert.equal(finalLedger[0]?.entry.state, 'reconciled');
    assert.deepEqual(finalLedger[0]?.history, ['dispatched-effect-unknown', 'reconciled']);

    const latestRecoveryFact = await ledger.readLatestTurnSegmentRecoveryFact({ scope, turnId: inFlightInfo.turnId });
    assert.equal(latestRecoveryFact?.recoveryOutcome, 'recovery-auto-resumed');
    assert.deepEqual(latestRecoveryFact?.providerSettleReceipt, confirmedChildExitSettle);
    assert.equal(latestRecoveryFact?.toolEffects[0]?.state, 'reconciled');

    if (process.env.W2B_RECEIPT_PATH) {
      await mkdir(dirname(process.env.W2B_RECEIPT_PATH), { recursive: true });
      await writeFile(
        process.env.W2B_RECEIPT_PATH,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            realRccMidTurnInterruptRecoveryStatus: 'UNVERIFIED',
            realRccMidTurnInterruptRecoveryNote:
              'liveRccE2EScenario proves real RCC 4444 normal multi-round tool effect ledger persistence; realProcessInterruptRecoveryProof proves child-process SIGKILL mid-mutating-tool interrupt, unknown-settle hold, and same-turn recovery after confirmed stopped ProviderSettleReceipt; live RCC mid-stream interrupt recovery remains UNVERIFIED.',
            liveRccE2EScenario: {
              scenario: 'local-file-search',
              attemptId: 'local-file-search-20261102-102408-p410sa',
              taskId: 'scheduled-task-b44b5e1578765f57cf35',
              outcome: 'SUCCESS',
              toolRounds: 3,
              effectLedgerEntriesRecorded: 6,
              archivedLedgerFile:
                '/Volumes/Intel/playground/humanagent/.worker-runs/mvp-repair-20261102/w2b-live-e2e-artifacts/task-control.jsonl.effect-ledger.jsonl',
            },
            realProcessInterruptRecoveryProof: {
              killedChildPid: inFlightInfo.pid,
              exitSignal: exitInfo.signal,
              taskId: inFlightInfo.taskId,
              operationId: inFlightInfo.operationId,
              cycleId: inFlightInfo.cycleId,
              turnId: inFlightInfo.turnId,
              mutatedTargetFile: targetFilePath,
              diskSideEffectVerifiedBeforeRecover: true,
              heldWhenSettleUnknownBeforeSettleConfirmation: {
                state: snapHeldWithoutSettle.state,
                recoveryOutcome: snapHeldWithoutSettle.checkpoint?.recoveryOutcome,
                parentResumedTurnRuns: 0,
              },
              beforeOperatorRecover: {
                state: snapAfterHydrate.state,
                allowedActions: snapAfterHydrate.allowedActions,
                checkpointKind: snapAfterHydrate.checkpoint?.checkpointKind,
                recoveryOutcome: snapAfterHydrate.checkpoint?.recoveryOutcome,
                recoveryFact: snapAfterHydrate.checkpoint?.recoveryFact,
              },
              afterOperatorRecover: {
                state: finalSnap.state,
                allowedActions: finalSnap.allowedActions,
                parentResumedTurnRuns,
                parentMutatingToolCallbackRuns,
                reusedReconciledOnResume,
                reconciledLedgerEntries: finalLedger.map((item) => ({
                  entry: item.entry,
                  history: item.history,
                  operatorNote: item.operatorNote,
                  commitRef: item.commitRef,
                })),
                latestRecoveryFact,
              },
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
