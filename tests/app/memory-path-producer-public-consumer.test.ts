import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureControlLayout,
  loadConfiguration,
  resolveRuntimePaths,
} from '../../packages/config/src/index.js';
import {
  id,
  type Checkpoint,
  type ContextHistoryRecord,
  type EvidenceRef,
  type JournalCommitRef,
  type ScopeRef,
  type Task,
} from '../../packages/contracts/src/index.js';
import { JsonlOrganJournal, type JournalRecord } from '../../packages/adapters/jsonl/src/index.js';
import {
  checkpointClosureEvidenceDigest,
  checkpointClosureEvidenceLocator,
  checkpointEvidenceDigest,
  checkpointEvidenceLocator,
  checkpointEvidenceText,
  closureFromRecord,
  createJsonlCheckpointClosurePort,
  createJsonlCheckpointJournal,
  createJsonlContextHistoryPort,
  conditionalReentryFromRecord,
  contextCorrectionFromRecord,
  exactJournalRecord,
  readCommittedCheckpoint,
} from '../../packages/app/src/checkpoint-journal.js';
import {
  composeMemoryRuntime,
  executeConfirmedTaskCheckpointReentry,
  executeConfirmedTaskContextCorrection,
} from '../../packages/app/src/index.js';
import {
  createJournalCheckpointEvidencePort,
  publishRewindMemoryBoundaryFromJournal,
  reconcileCommittedReentryMemoryBoundaries,
  rewindGroupMessageId,
} from '../../packages/app/src/memory-runtime.js';
import { createJsonlOperationControlJournal, readOperationControlFromRecords } from '../../packages/app/src/operation-control-journal.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { readCurrentFromRecords } from '../../packages/app/src/ui-runtime/reentry-current-facts.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import { AgentLoopRuntime } from '../../packages/runtime/src/agent-loop/runtime.js';
import { prepareCheckpointClosure } from '../../packages/runtime/src/checkpoints/closure.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';
import { submitCheckpoint } from '../../packages/runtime/src/checkpoints/submission.js';
import type { ReentryCurrentFacts, ReentryCurrentRead } from '../../packages/runtime/src/checkpoints/conditional-reentry.js';
import type { OperationControlReadback } from '../../packages/runtime/src/gateway/ports.js';
import type {
  RuntimeTaskCurrentState,
  RuntimeTaskCurrentStateTransition,
} from '../../packages/runtime/src/ui-runtime/current-state.js';

const FIXTURE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? '/Users/fanzhang/.humanagent/test-fixtures/n2-memory-c3b-fixture-r7-20261017';

test('rewind publisher feeds the existing memory consumer committed path and correction evidence', async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const root = await mkdtemp(join(FIXTURE_ROOT, 'memory-path-producer-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  let passed = false;
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'AGENTS.md'), '# Memory path producer\n', 'utf8');
    const paths = await resolveRuntimePaths({ controlRoot, workspace });
    await ensureControlLayout(paths);
    const configuration = await loadConfiguration(paths);
    const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
    await mkdir(auditPromptRoot, { recursive: true });
    await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# Memory audit\n', 'utf8');

    const organId = id('organ', 'memory-path-producer-organ');
    const taskId = id('task', 'memory-path-producer-task');
    const cycleId = id('cycle', 'memory-path-producer-cycle');
    const operationId = id('operation', 'memory-path-producer-operation');
    const scope: ScopeRef = { organId, taskId, cycleId, operationId };
    const checkpointFile = join(paths.journalRoot, 'checkpoints.jsonl');
    const checkpointJournal = createJsonlCheckpointJournal({ filePath: checkpointFile });
    const closurePort = createJsonlCheckpointClosurePort({ filePath: checkpointFile });
    const checkpoint = (input: {
      readonly suffix: string;
      readonly seq: number;
      readonly previousCheckpointId: Checkpoint['previousCheckpointId'];
      readonly executionEpoch: number;
      readonly outcome: Checkpoint['outcome'];
    }): Checkpoint => {
      const recoveryStateRef: EvidenceRef = {
        evidenceId: id('evidence', `memory-path-recovery-${input.suffix}`),
        kind: 'operation',
        source: 'memory-path-producer-test',
        locator: `humanagent://session/memory-path-producer/${input.suffix}/recovery`,
        scope,
      };
      return {
        id: id('checkpoint', `memory-path-producer-${input.suffix}`),
        scope,
        cycleId,
        seq: input.seq,
        previousCheckpointId: input.previousCheckpointId,
        directiveRevision: 1,
        executionEpoch: input.executionEpoch,
        outcome: input.outcome,
        summary: `memory path producer ${input.suffix}`,
        recoveryStateRef,
        evidenceRefs: [{
          evidenceId: id('evidence', `memory-path-result-${input.suffix}`),
          kind: 'operation',
          source: 'memory-path-producer-test',
          locator: `humanagent://session/memory-path-producer/${input.suffix}/result`,
          scope,
        }],
        next: { kind: 'continue', ref: `memory-path-producer/${input.suffix}/next` },
      };
    };

    const selected = checkpoint({
      suffix: 'selected',
      seq: 1,
      previousCheckpointId: null,
      executionEpoch: 1,
      outcome: 'blocked',
    });
    const failed = checkpoint({
      suffix: 'failed',
      seq: 2,
      previousCheckpointId: selected.id,
      executionEpoch: 1,
      outcome: 'failed',
    });
    const recovery = checkpoint({
      suffix: 'recovery',
      seq: 3,
      previousCheckpointId: failed.id,
      executionEpoch: 2,
      outcome: 'succeeded',
    });
    for (const current of [selected, failed, recovery]) {
      await checkpointJournal.append({
        ownerId: 'memory-path-producer-test',
        commitId: checkpointCommitId(current),
        checkpoint: current,
      });
    }
    const committed = async (current: Checkpoint) => {
      const record = await checkpointJournal.readCommitted(current.scope, current.id);
      if (record === null) throw new Error(`C3b committed checkpoint is unavailable: ${current.id.value}`);
      return record;
    };
    const committedRef = async (current: Checkpoint) => {
      const record = await checkpointJournal.readCommitted(current.scope, current.id);
      if (record === null) throw new Error(`committed checkpoint record was not readable: ${current.id.value}`);
      return record.commitRef;
    };
    const [selectedCommitted, failedCommitted, recoveryCommitted] = await Promise.all([
      committed(selected),
      committed(failed),
      committed(recovery),
    ]);

    const selectedClosure = {
      closureKind: 'checkpoint' as const,
      compatibilityVersion: 1 as const,
      closureId: 'checkpoint-closure:memory-path-producer-selected',
      checkpointId: selectedCommitted.checkpoint.id,
      source: 'agent-tool' as const,
      outcome: selectedCommitted.checkpoint.outcome,
      summary: 'selected checkpoint closed',
      next: selectedCommitted.checkpoint.next,
      evidenceRefs: selectedCommitted.checkpoint.evidenceRefs,
      reentry: { allowed: true, reason: 'selected checkpoint path admitted' },
    };
    await closurePort.commit(selectedClosure);
    const committedSelectedClosure = await closurePort.read(selectedClosure.closureId);
    if (!committedSelectedClosure) throw new Error('committed selected closure was not readable');

    const reentry = {
      closureKind: 'reentry' as const,
      closureId: 'reentry:memory-path-producer:1:2',
      checkpointId: selectedCommitted.checkpoint.id,
      checkpointExecutionEpoch: selectedCommitted.checkpoint.executionEpoch,
      previousExecutionEpoch: selectedCommitted.checkpoint.executionEpoch,
      newExecutionEpoch: recoveryCommitted.checkpoint.executionEpoch,
      nextAction: { kind: 'continue' as const, ref: 'resume-selected-checkpoint' },
      reentry: { allowed: true, reason: 'selected checkpoint path admitted' },
    };
    await closurePort.commit(reentry);
    const committedReentry = await closurePort.read(reentry.closureId);
    if (!committedReentry) throw new Error('committed reentry closure was not readable');

    const memory = await composeMemoryRuntime({
      paths,
      configuration,
      workspaceCwd: paths.workspaceCwd,
      sessionsRoot: paths.sessionsRoot,
      runNotesRoot: paths.runNotesRoot,
      auditPromptRoot,
      auditPromptRef: 'project-memory-audit',
      autoUpdate: false,
      checkpointEvidence: createJournalCheckpointEvidencePort({ filePath: checkpointFile }),
      binding: {
        bindingRef: 'memory-binding:memory-path-producer',
        projectKey: paths.projectKey,
        executionEpoch: 2,
        scope: {
          namespace: 'project',
          projectKey: paths.projectKey,
          organId: scope.organId,
          taskId,
        },
        taskId,
        mainAgentId: 'memory-path-producer-main',
        actor: {
          actorId: 'memory-agent',
          roleId: 'memory' as const,
          permissions: ['memory.read', 'memory.propose'] as const,
          projectKey: paths.projectKey,
        },
      },
    });

    const consumed = await publishRewindMemoryBoundaryFromJournal({
      memory,
      checkpointJournalPath: checkpointFile,
      taskScope: { organId, taskId },
      failedCheckpointId: failedCommitted.checkpoint.id,
      recoveryCheckpointId: recoveryCommitted.checkpoint.id,
      failedCheckpointCommitRef: await committedRef(failed),
      recoveryCheckpointCommitRef: await committedRef(recovery),
      reentryClosureId: reentry.closureId,
    });

    const events = await memory.journal.readEvents({
      streamId: `memory-boundaries:${taskId.value}`,
      afterSequence: 0,
      limit: 10,
    });
    assert.equal(events.length, 1);
    const event = events[0]!;
    const analysisInputs = (event.payload as {
      readonly analysisInputs?: {
        readonly corrections: readonly { readonly sourceRef: string; readonly sourceDigest: string; readonly fingerprint: string }[];
        readonly errors: readonly { readonly sourceRef: string; readonly sourceDigest: string; readonly fingerprint: string }[];
        readonly rewindChains: readonly {
          readonly failedBranchRef: string;
          readonly rewindCheckpointRef: string;
          readonly recoveryCheckpointRef: string;
          readonly reentryFactRef?: string;
          readonly successfulBranchRefs: readonly string[];
          readonly successEvidenceRefs: readonly string[];
          readonly absoluteJournalRefs: readonly string[];
        }[];
        readonly actualPathRefs: readonly string[];
        readonly declaredPathRefs: readonly string[];
      };
    } | undefined)?.analysisInputs;
    if (!analysisInputs) throw new Error('rewind analysis inputs were not published');
    assert.deepEqual(analysisInputs.corrections, [{
      sourceRef: checkpointClosureEvidenceLocator(reentry.closureId),
      sourceDigest: checkpointClosureEvidenceDigest(committedReentry),
      fingerprint: reentry.closureId,
    }]);
    assert.deepEqual(analysisInputs.errors, [{
      sourceRef: checkpointEvidenceLocator(failedCommitted.checkpoint),
      sourceDigest: checkpointEvidenceDigest(failedCommitted.checkpoint),
      fingerprint: failedCommitted.checkpoint.id.value,
    }]);
    assert.deepEqual(analysisInputs.actualPathRefs, [
      checkpointEvidenceLocator(selectedCommitted.checkpoint),
      checkpointEvidenceLocator(recoveryCommitted.checkpoint),
    ]);
    assert.deepEqual(analysisInputs.declaredPathRefs, [
      checkpointClosureEvidenceLocator(selectedClosure.closureId),
    ]);
    assert.equal(
      analysisInputs.declaredPathRefs.some((ref) => analysisInputs.actualPathRefs.includes(ref)),
      false,
    );
    const chain = analysisInputs.rewindChains[0]!;
    assert.equal(chain.failedBranchRef, checkpointEvidenceLocator(failedCommitted.checkpoint));
    assert.equal(chain.rewindCheckpointRef, checkpointEvidenceLocator(selectedCommitted.checkpoint));
    assert.equal(chain.rewindCheckpointRef === chain.failedBranchRef, false);
    assert.equal(chain.recoveryCheckpointRef, checkpointEvidenceLocator(recoveryCommitted.checkpoint));
    assert.equal(chain.reentryFactRef, checkpointClosureEvidenceLocator(reentry.closureId));
    assert.deepEqual(chain.successfulBranchRefs, [chain.reentryFactRef!]);
    assert.deepEqual(chain.successEvidenceRefs, [checkpointEvidenceLocator(recoveryCommitted.checkpoint)]);
    assert.ok(chain.absoluteJournalRefs.includes(checkpointClosureEvidenceLocator(reentry.closureId)));
    assert.ok(chain.absoluteJournalRefs.includes(checkpointEvidenceLocator(failedCommitted.checkpoint)));
    assert.ok(chain.absoluteJournalRefs.includes(checkpointClosureEvidenceLocator(selectedClosure.closureId)));
    const eventEvidence = new Map(event.evidenceRefs.map((evidence) => [evidence.locator, evidence.digest]));
    assert.equal(
      eventEvidence.get(checkpointClosureEvidenceLocator(reentry.closureId)),
      checkpointClosureEvidenceDigest(committedReentry),
    );
    assert.equal(
      eventEvidence.get(checkpointEvidenceLocator(failedCommitted.checkpoint)),
      checkpointEvidenceDigest(failedCommitted.checkpoint),
    );
    assert.equal(
      eventEvidence.get(checkpointClosureEvidenceLocator(selectedClosure.closureId)),
      checkpointClosureEvidenceDigest(committedSelectedClosure),
    );
    assert.equal(
      eventEvidence.get(checkpointEvidenceLocator(selectedCommitted.checkpoint)),
      checkpointEvidenceDigest(selectedCommitted.checkpoint),
    );
    assert.equal(
      eventEvidence.get(checkpointEvidenceLocator(recoveryCommitted.checkpoint)),
      checkpointEvidenceDigest(recoveryCommitted.checkpoint),
    );

    assert.equal(consumed.retries.length, 0, JSON.stringify(consumed));
    assert.equal(consumed.committed.length, 1, JSON.stringify(consumed));
    assert.equal(consumed.committed[0]?.disposition, 'applied', JSON.stringify(consumed));
    const reviewState = await memory.reviewState();
    assert.equal(reviewState.autoUpdate, false);
    assert.equal(reviewState.candidates.length, 1);
    assert.equal(reviewState.candidates[0]?.state, 'candidate');
    assert.equal(reviewState.candidates[0]?.taskId, taskId.value);
    assert.match(reviewState.candidates[0]!.summary, /reentered at/);
    assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), '# Memory path producer\n');
    assert.equal((await readdir(paths.artifactsRoot)).some((name) => name.startsWith('memory-project-patch-')), false);

    // This input points the failed slot at the succeeded recovery checkpoint,
    // so it is a legal errorless path change and the old "missing error
    // evidence" rejection no longer applies. The remaining rejection is the
    // real conflict: the same primary recovery checkpoint already committed the
    // rewind boundary, so re-publishing it with a different body under the same
    // event identity is rejected by the event journal.
    await assert.rejects(
      async () => { await publishRewindMemoryBoundaryFromJournal({
        memory,
        checkpointJournalPath: checkpointFile,
        taskScope: { organId, taskId },
        failedCheckpointId: recoveryCommitted.checkpoint.id,
        recoveryCheckpointId: recoveryCommitted.checkpoint.id,
        reentryClosureId: reentry.closureId,
      }); },
      (error: unknown) => error instanceof Error
        && /event identity conflicts with committed history/.test(error.message),
    );

    const otherCycleId = id('cycle', 'memory-path-producer-other-cycle');
    const otherScope: ScopeRef = { organId, taskId, cycleId: otherCycleId, operationId };
    const duplicateFailed: Checkpoint = {
      ...failed,
      scope: otherScope,
      cycleId: otherCycleId,
      seq: 1,
      previousCheckpointId: null,
      summary: `${failed.summary} other cycle`,
      recoveryStateRef: { ...failed.recoveryStateRef, scope: otherScope },
      evidenceRefs: failed.evidenceRefs.map((ref) => ({ ...ref, scope: otherScope })),
    };
    await checkpointJournal.append({
      ownerId: 'memory-path-producer-test',
      commitId: checkpointCommitId(duplicateFailed),
      checkpoint: duplicateFailed,
    });
    await assert.rejects(
      async () => { await publishRewindMemoryBoundaryFromJournal({
        memory,
        checkpointJournalPath: checkpointFile,
        taskScope: { organId, taskId },
        failedCheckpointId: failedCommitted.checkpoint.id,
        recoveryCheckpointId: recoveryCommitted.checkpoint.id,
        reentryClosureId: reentry.closureId,
      }); },
      (error: unknown) => error instanceof Error && /multiple cycles/.test(error.message),
    );
    assert.equal((await memory.journal.readEvents({
      streamId: `memory-boundaries:${taskId.value}`,
      afterSequence: 0,
      limit: 10,
    })).length, 1);

    // Legal errorless path change: the departed, selected, and recovery
    // checkpoints are distinct committed records. All three succeeded and no
    // committed DeadEnd exists, so the Memory audit must keep an empty errors
    // list instead of rejecting the boundary as missing error evidence.
    const departed = checkpoint({
      suffix: 'departed',
      seq: 4,
      previousCheckpointId: recovery.id,
      executionEpoch: 1,
      outcome: 'succeeded',
    });
    const destination = checkpoint({
      suffix: 'destination',
      seq: 5,
      previousCheckpointId: departed.id,
      executionEpoch: 1,
      outcome: 'succeeded',
    });
    const recovery2 = checkpoint({
      suffix: 'errorless-recovery',
      seq: 6,
      previousCheckpointId: destination.id,
      executionEpoch: 2,
      outcome: 'succeeded',
    });
    for (const current of [departed, destination, recovery2]) {
      await checkpointJournal.append({
        ownerId: 'memory-path-producer-test',
        commitId: checkpointCommitId(current),
        checkpoint: current,
      });
    }
    const [departedCommitted, destinationCommitted, recovery2Committed] = await Promise.all([
      committed(departed),
      committed(destination),
      committed(recovery2),
    ]);

    const destinationClosure = {
      closureKind: 'checkpoint' as const,
      compatibilityVersion: 1 as const,
      closureId: 'checkpoint-closure:memory-path-producer-destination',
      checkpointId: destinationCommitted.checkpoint.id,
      source: 'agent-tool' as const,
      outcome: destinationCommitted.checkpoint.outcome,
      summary: 'errorless destination checkpoint closed',
      next: destinationCommitted.checkpoint.next,
      evidenceRefs: destinationCommitted.checkpoint.evidenceRefs,
      reentry: { allowed: true, reason: 'errorless destination path admitted' },
    };
    await closurePort.commit(destinationClosure);
    const committedDestinationClosure = await closurePort.read(destinationClosure.closureId);
    if (!committedDestinationClosure) throw new Error('committed destination closure was not readable');

    const errorlessReentry = {
      closureKind: 'reentry' as const,
      closureId: 'reentry:memory-path-producer:errorless',
      checkpointId: destinationCommitted.checkpoint.id,
      checkpointExecutionEpoch: destinationCommitted.checkpoint.executionEpoch,
      previousExecutionEpoch: destinationCommitted.checkpoint.executionEpoch,
      newExecutionEpoch: recovery2Committed.checkpoint.executionEpoch,
      nextAction: { kind: 'continue' as const, ref: 'resume-errorless-destination' },
      reentry: { allowed: true, reason: 'errorless destination path admitted' },
    };
    await closurePort.commit(errorlessReentry);
    const committedErrorlessReentry = await closurePort.read(errorlessReentry.closureId);
    if (!committedErrorlessReentry) throw new Error('committed errorless reentry closure was not readable');

    const errorlessConsumed = await publishRewindMemoryBoundaryFromJournal({
      memory,
      checkpointJournalPath: checkpointFile,
      taskScope: { organId, taskId },
      failedCheckpointId: departedCommitted.checkpoint.id,
      recoveryCheckpointId: recovery2Committed.checkpoint.id,
      failedCheckpointCommitRef: await committedRef(departed),
      recoveryCheckpointCommitRef: await committedRef(recovery2),
      reentryClosureId: errorlessReentry.closureId,
    });

    const errorlessEvents = await memory.journal.readEvents({
      streamId: `memory-boundaries:${taskId.value}`,
      afterSequence: 0,
      limit: 10,
    });
    assert.equal(errorlessEvents.length, 2);
    const errorlessEvent = errorlessEvents[1]!;
    const errorlessInputs = (errorlessEvent.payload as {
      readonly analysisInputs?: {
        readonly corrections: readonly { readonly sourceRef: string; readonly sourceDigest: string; readonly fingerprint: string }[];
        readonly errors: readonly { readonly sourceRef: string; readonly sourceDigest: string; readonly fingerprint: string }[];
        readonly rewindChains: readonly {
          readonly failedBranchRef: string;
          readonly rewindCheckpointRef: string;
          readonly recoveryCheckpointRef: string;
          readonly reentryFactRef?: string;
          readonly successfulBranchRefs: readonly string[];
          readonly successEvidenceRefs: readonly string[];
          readonly absoluteJournalRefs: readonly string[];
        }[];
        readonly actualPathRefs: readonly string[];
        readonly declaredPathRefs: readonly string[];
      };
    } | undefined)?.analysisInputs;
    if (!errorlessInputs) throw new Error('errorless rewind analysis inputs were not published');
    assert.deepEqual(errorlessInputs.errors, []);
    assert.deepEqual(errorlessInputs.corrections, [{
      sourceRef: checkpointClosureEvidenceLocator(errorlessReentry.closureId),
      sourceDigest: checkpointClosureEvidenceDigest(committedErrorlessReentry),
      fingerprint: errorlessReentry.closureId,
    }]);
    assert.deepEqual(errorlessInputs.actualPathRefs, [
      checkpointEvidenceLocator(destinationCommitted.checkpoint),
      checkpointEvidenceLocator(recovery2Committed.checkpoint),
    ]);
    assert.deepEqual(errorlessInputs.declaredPathRefs, [
      checkpointClosureEvidenceLocator(destinationClosure.closureId),
    ]);
    const errorlessChain = errorlessInputs.rewindChains[0]!;
    assert.equal(errorlessChain.failedBranchRef, checkpointEvidenceLocator(departedCommitted.checkpoint));
    assert.equal(errorlessChain.rewindCheckpointRef, checkpointEvidenceLocator(destinationCommitted.checkpoint));
    assert.equal(errorlessChain.recoveryCheckpointRef, checkpointEvidenceLocator(recovery2Committed.checkpoint));
    assert.equal(errorlessChain.reentryFactRef, checkpointClosureEvidenceLocator(errorlessReentry.closureId));
    assert.deepEqual(errorlessChain.successfulBranchRefs, [errorlessChain.reentryFactRef!]);
    assert.deepEqual(errorlessChain.successEvidenceRefs, [checkpointEvidenceLocator(recovery2Committed.checkpoint)]);
    assert.ok(errorlessChain.absoluteJournalRefs.includes(checkpointEvidenceLocator(departedCommitted.checkpoint)));
    assert.ok(errorlessChain.absoluteJournalRefs.includes(checkpointClosureEvidenceLocator(destinationClosure.closureId)));
    assert.ok(errorlessChain.absoluteJournalRefs.includes(checkpointClosureEvidenceLocator(errorlessReentry.closureId)));
    const errorlessEvidence = new Map(errorlessEvent.evidenceRefs.map((evidence) => [evidence.locator, evidence.digest]));
    assert.equal(
      errorlessEvidence.get(checkpointClosureEvidenceLocator(destinationClosure.closureId)),
      checkpointClosureEvidenceDigest(committedDestinationClosure),
    );
    assert.equal(
      errorlessEvidence.get(checkpointEvidenceLocator(departedCommitted.checkpoint)),
      checkpointEvidenceDigest(departedCommitted.checkpoint),
    );
    assert.equal(errorlessConsumed.retries.length, 0, JSON.stringify(errorlessConsumed));
    assert.equal(errorlessConsumed.committed.length, 1, JSON.stringify(errorlessConsumed));
    assert.equal(errorlessConsumed.committed[0]?.disposition, 'applied', JSON.stringify(errorlessConsumed));
    assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), '# Memory path producer\n');
    passed = true;
  } finally {
    if (passed) await rm(root, { recursive: true, force: true });
  }
});
test('C3b canonical correction rewind forward chain reaches Memory analysis from real control receipts', async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const root = await mkdtemp(join(FIXTURE_ROOT, 'c3b-real-c1-chain-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  let passed = false;
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'AGENTS.md'), '# C3b real C1 chain\n', 'utf8');
    const paths = await resolveRuntimePaths({ controlRoot, workspace });
    await ensureControlLayout(paths);
    const configuration = await loadConfiguration(paths);
    const auditPromptRoot = join(paths.controlRoot, 'memory-audit');
    await mkdir(auditPromptRoot, { recursive: true });
    await writeFile(join(auditPromptRoot, 'project-memory-audit.md'), '# C3b memory audit\n', 'utf8');

    const organId = id('organ', 'c3b-real-chain-organ');
    const taskId = id('task', 'c3b-real-chain-task');
    const cycleId = id('cycle', 'c3b-real-chain-cycle');
    const operationId = id('operation', 'c3b-real-chain-operation');
    const scope: ScopeRef = { organId, taskId, cycleId, operationId };
    const taskScope: ScopeRef = { organId, taskId };
    const runtimeId = 'c3b-real-chain-runtime';
    const ownerId = 'c3b-real-chain-owner';
    const journalPath = join(paths.journalRoot, 'c3b-real-chain.jsonl');
    const journal = new JsonlOrganJournal(journalPath);
    const checkpoints = createJsonlCheckpointJournal({ filePath: journalPath, journal });
    const closures = createJsonlCheckpointClosurePort({ filePath: journalPath, journal });
    const contexts = createJsonlContextHistoryPort({ filePath: journalPath, journal });
    const operationControl = createJsonlOperationControlJournal({ journal });
    const grants = new JsonlTaskGrantJournal(journal);
    const currentStates = createJsonlRuntimeTaskCurrentStateJournal({ journal });
    const wrongA = 'business-ref:c3b-wrong-a';
    const wrongB = 'business-ref:c3b-wrong-b';
    const correctRef = 'business-ref:c3b-correct';
    const correctionTaskScope = { organId, taskId } as const;
    const wrongRefs = [
      { taskScope: correctionTaskScope, ref: wrongA },
      { taskScope: correctionTaskScope, ref: wrongB },
    ] as const;

    const digest = (value: unknown): string =>
      `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
    const knownCurrentFacts = (read: ReentryCurrentRead): ReentryCurrentFacts => {
      if (read.state !== 'known') throw new Error(`C3b current facts are unknown: ${read.reason}`);
      return read;
    };
    const completeOperationControl = (
      read: OperationControlReadback,
    ): Extract<OperationControlReadback, { readonly state: 'complete' }> => {
      if (read.state !== 'complete') {
        throw new Error(`C3b operation control is unknown: ${read.reason}`);
      }
      return read;
    };
    const evidence = (label: string): EvidenceRef => ({
      evidenceId: id('evidence', `c3b-real-chain-${label}`),
      kind: 'execution',
      source: 'c3b-real-chain-public-consumer',
      locator: `c3b-real-chain://${label}`,
      scope,
    });
    const receiptLocator = (committed: {
      readonly commitRef: JournalCommitRef;
      readonly checkpoint: Checkpoint;
    }): string =>
      `humanagent://checkpoint-receipt/${committed.commitRef.journalSeq}/${committed.checkpoint.id.value}`;
    const checkpoint = (
      suffix: string,
      seq: number,
      previousCheckpointId: Checkpoint['previousCheckpointId'],
      executionEpoch: number,
    ): Checkpoint => ({
      id: id('checkpoint', `c3b-real-chain-${suffix}`),
      scope,
      cycleId,
      seq,
      previousCheckpointId,
      directiveRevision: 1,
      executionEpoch,
      outcome: 'succeeded',
      summary: `C3b real chain ${suffix}`,
      recoveryStateRef: evidence(`recovery-${suffix}`),
      evidenceRefs: [evidence(`result-${suffix}`)],
      next: { kind: 'continue', ref: `c3b-real-chain/${suffix}/next` },
    });
    const task = (): Task => ({
      id: taskId,
      organId,
      title: 'C3b real correction chain',
      directive: 'Exercise the public correction and reentry facades',
      directiveRevision: 1,
      state: 'running',
      memoryScope: 'task',
    });
    const currentState = (): RuntimeTaskCurrentState => ({
      task: task(),
      processing: {
        entryPhase: 'execution',
        nextAction: { kind: 'continue', ref: 'c3b-real-chain/next' },
        hardBlockers: [],
        recoveryResponsibilityRef: 'recovery:c3b-real-chain',
        laterErrorRefs: [],
        stages: [],
      },
      retainedDuties: [{
        operationRef: 'operation:c3b-real-chain-retained',
        owner: ownerId,
      }],
      sourceCommitRefs: [],
    });
    const currentStateTransition = (
      expectedStateCommitRef: JournalCommitRef | null,
    ): RuntimeTaskCurrentStateTransition => ({
      transitionId: `c3b-real-chain-current-state-${expectedStateCommitRef?.journalSeq ?? 0}`,
      taskScope,
      expectedStateCommitRef,
      state: currentState(),
    });

    const granted = await grants.grant({
      requestId: 'c3b-real-chain-grant',
      taskId,
      owner: ownerId,
      capability: {
        actionId: 'execution',
        capabilities: ['execute-task'],
        scope: taskScope,
      },
      expectedRevision: 0,
    });
    assert.equal(granted.grant?.state, 'granted');
    if (!granted.commit) throw new Error('C3b grant receipt is missing');
    const grantCommit = granted.commit;

    await operationControl.initializeCoverage({
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: 1,
      admissionCommitRef: grantCommit,
    });
    await AgentLoopRuntime.start({
      agentRuntimeId: runtimeId,
      role: 'execution',
      mode: 'observation',
      profiles: [{
        profileId: 'c3b-real-chain-profile',
        role: 'execution',
        mode: 'observation',
        observationScopes: ['task'],
        observationCapabilities: ['read-task'],
        orchestrationScope: 'local',
        orchestrationCapabilities: [],
        capabilityDigest: 'sha256:c3b-real-chain-profile',
      }],
      budget: {
        maxModeTransitions: 4,
        maxObservationScopes: 4,
        maxContextReplacements: 4,
        maxDeferredEvents: 4,
      },
      scope,
      executionEpoch: 1,
      permissionRevision: '1',
      observationStreamId: 'c3b-real-chain-stream',
      activeRefs: [wrongA, wrongB, correctRef],
      omittedRefs: [],
      durableContext: {
        stablePrefix: ['objective'],
        indexRefs: [wrongA, wrongB, correctRef],
        dynamicHead: [],
        repairRefs: [correctRef],
      },
    }, contexts);

    const initialHead = await contexts.readContextHistory({
      scope,
      agentRuntimeId: runtimeId,
      limit: 1,
    });
    if (!initialHead.currentContextCommitRef) {
      throw new Error('C3b initial context receipt is missing');
    }
    const initialContext = await contexts.readContextCommit(scope, initialHead.currentContextCommitRef);

    const prepare = async (input: {
      readonly checkpoint: Checkpoint;
      readonly contextCommitRef: JournalCommitRef;
      readonly executionEpoch: number;
      readonly closureReason: string;
    }) => {
      const control = completeOperationControl(
        readOperationControlFromRecords(await journal.replay(), {
          scope,
          agentRuntimeId: runtimeId,
          harnessExecutionEpoch: input.executionEpoch,
        }),
      );
      return prepareCheckpointClosure({
        checkpoint: input.checkpoint,
        source: 'agent-tool',
        closureReason: input.closureReason,
        contextCommitRef: input.contextCommitRef,
        contextHistory: contexts,
        operationSelector: {
          scope,
          agentRuntimeId: runtimeId,
          harnessExecutionEpoch: input.executionEpoch,
        },
        operationControl: control,
        permission: {
          permissionRevision: '1',
          grantCommitRef: grantCommit,
          revoked: false,
        },
        hardBlockers: [],
        unreturnedCallRefs: [],
        unresolvedOperationRefs: [],
        closurePort: closures,
        now: () => new Date('2026-10-17T10:00:00.000Z'),
      });
    };

    const checkpointA = checkpoint('a', 1, null, 1);
    await submitCheckpoint({
      source: 'agent-tool',
      ownerId,
      checkpoint: checkpointA,
      previous: null,
      journal: checkpoints,
      closurePort: closures,
      preparation: await prepare({
        checkpoint: checkpointA,
        contextCommitRef: initialHead.currentContextCommitRef,
        executionEpoch: 1,
        closureReason: 'C3b rewind target A',
      }),
    });
    const checkpointACommitted = await checkpoints.readCommitted(scope, checkpointA.id);
    if (!checkpointACommitted) throw new Error('C3b checkpoint A receipt is missing');

    await operationControl.initializeCoverage({
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: 2,
      admissionCommitRef: grantCommit,
    });
    const currentActiveRefs = [wrongA, wrongB, correctRef];
    const currentContextViewRef = `${runtimeId}:context:2`;
    const currentObservationScopeId = `${runtimeId}:observation:2`;
    const currentContextDigest = digest({ activeRefs: currentActiveRefs, omittedRefs: [] });
    const currentLoopBase = {
      checkpointId: id('checkpoint', 'c3b-real-chain-loop-2'),
      sequence: initialContext.loopCheckpoint.sequence + 1,
      predecessor: {
        checkpointId: initialContext.loopCheckpoint.checkpointId,
        digest: initialContext.loopCheckpoint.digest,
      },
      executionEpoch: 2,
      observationScopeId: currentObservationScopeId,
      contextViewRef: currentContextViewRef,
      eventWatermark: initialContext.loopCheckpoint.eventWatermark,
    };
    const currentLoopCheckpoint = {
      ...currentLoopBase,
      digest: digest({ ...currentLoopBase, contextDigest: currentContextDigest }),
    };
    const currentCheckpointRef = {
      checkpointId: currentLoopCheckpoint.checkpointId,
      digest: currentLoopCheckpoint.digest,
    };
    const currentDurableContext = {
      stablePrefix: ['objective'],
      indexRefs: [wrongA, wrongB, correctRef],
      dynamicHead: [],
      repairRefs: [correctRef],
    } as const;
    const currentContext: ContextHistoryRecord = {
      ...initialContext,
      contextView: {
        ...initialContext.contextView,
        contextViewRef: currentContextViewRef,
        executionEpoch: 2,
        checkpoint: currentCheckpointRef,
        contextDigest: currentContextDigest,
        activeRefs: currentActiveRefs,
        omittedRefs: [],
      },
      loopCheckpoint: currentLoopCheckpoint,
      previousContextCommitRef: initialHead.currentContextCommitRef,
      durableContext: currentDurableContext,
      durableContextDigest: digest(currentDurableContext),
      loopControl: {
        ...initialContext.loopControl,
        observationScopeId: currentObservationScopeId,
        observationScope: null,
        inboxExecutionEpoch: 2,
        inboxCheckpoint: currentCheckpointRef,
        inboxObservationScopeId: currentObservationScopeId,
        deltaExecutionEpoch: 2,
        deltaCheckpoint: currentCheckpointRef,
        deltaObservationScopeId: currentObservationScopeId,
      },
      replacement: null,
    };
    const currentContextCommitRef = await contexts.commit(
      currentContext,
      initialHead.currentContextCommitRef,
    );

    const checkpointB = checkpoint('b', 2, checkpointA.id, 2);
    await submitCheckpoint({
      source: 'agent-tool',
      ownerId,
      checkpoint: checkpointB,
      previous: checkpointA,
      journal: checkpoints,
      closurePort: closures,
      preparation: await prepare({
        checkpoint: checkpointB,
        contextCommitRef: currentContextCommitRef,
        executionEpoch: 2,
        closureReason: 'C3b correction position B',
      }),
    });
    const checkpointBCommitted = await checkpoints.readCommitted(scope, checkpointB.id);
    if (!checkpointBCommitted) throw new Error('C3b checkpoint B receipt is missing');

    const stateReceipt = await currentStates.commit(currentStateTransition(null));
    assert.ok(stateReceipt.commitId.length > 0);

    const beforeCorrection = await journal.replay();
    const atB = knownCurrentFacts(readCurrentFromRecords(beforeCorrection, taskScope));
    assert.equal(atB.position.checkpointCommitRef.commitId, checkpointBCommitted.commitRef.commitId);
    assert.equal(atB.position.executionEpoch, 2);

    const correction = await executeConfirmedTaskContextCorrection({
      filePath: journalPath,
      journal,
      taskScope,
      principalOwner: ownerId,
      commandId: 'c3b-real-chain-correction',
      wrongRefs,
      repairText: 'Remove the two confirmed wrong business refs',
      confirmationRef: 'confirmation:c3b-real-chain-correction',
      sourceCheckpointReceipt: checkpointACommitted.commitRef,
    });
    assert.equal(correction.state, 'committed');
    assert.equal(correction.record.previousExecutionEpoch, atB.position.executionEpoch);
    assert.equal(correction.record.newExecutionEpoch, atB.position.executionEpoch + 1);
    assert.equal(correction.commitRef.journalSeq < correction.coverageCommitRef.journalSeq, true);
    const afterCorrection = await journal.replay();
    assert.deepEqual(afterCorrection.slice(0, beforeCorrection.length), beforeCorrection);
    const correctionRecord = contextCorrectionFromRecord(
      exactJournalRecord(afterCorrection, correction.commitRef),
    );
    if (!correctionRecord) throw new Error('C3b correction record is not readable');
    assert.equal(correctionRecord.correctedContext.contextView.activeRefs.includes(wrongA), false);
    assert.equal(correctionRecord.correctedContext.contextView.activeRefs.includes(wrongB), false);
    assert.deepEqual(correctionRecord.correctedContext.contextView.omittedRefs, [wrongA, wrongB]);
    const correctionFacts = knownCurrentFacts(readCurrentFromRecords(afterCorrection, taskScope));
    assert.equal(correctionFacts.position.checkpointCommitRef.commitId, checkpointBCommitted.commitRef.commitId);
    assert.equal(correctionFacts.position.controlCommitRef.commitId, correction.commitRef.commitId);
    assert.equal(correctionFacts.position.executionEpoch, correction.record.newExecutionEpoch);

    const beforeRewind = await journal.replay();
    const rewind = await executeConfirmedTaskCheckpointReentry({
      filePath: journalPath,
      journal,
      taskScope,
      principalOwner: ownerId,
      commandId: 'c3b-real-chain-rewind',
      targetCheckpointCommitRef: checkpointACommitted.commitRef,
      confirmationRef: 'confirmation:c3b-real-chain-rewind',
    });
    assert.equal(rewind.state, 'committed');
    assert.equal(rewind.record.previousExecutionEpoch, correctionFacts.position.executionEpoch);
    assert.equal(rewind.record.newExecutionEpoch, correctionFacts.position.executionEpoch + 1);
    assert.equal(rewind.record.sourceCheckpointCommitRef.commitId, checkpointACommitted.commitRef.commitId);
    assert.equal(rewind.commitRef.journalSeq < rewind.coverageCommitRef.journalSeq, true);
    const afterRewind = await journal.replay();
    assert.deepEqual(afterRewind.slice(0, beforeRewind.length), beforeRewind);
    const rewindRecord = conditionalReentryFromRecord(
      exactJournalRecord(afterRewind, rewind.commitRef),
    );
    if (!rewindRecord) throw new Error('C3b rewind record is not readable');
    assert.equal(rewindRecord.restoredContext.contextView.activeRefs.includes(wrongA), false);
    assert.equal(rewindRecord.restoredContext.contextView.activeRefs.includes(wrongB), false);
    const rewindFacts = knownCurrentFacts(readCurrentFromRecords(afterRewind, taskScope));
    assert.equal(rewindFacts.position.checkpointCommitRef.commitId, checkpointACommitted.commitRef.commitId);
    assert.equal(rewindFacts.position.controlCommitRef.commitId, rewind.commitRef.commitId);
    assert.equal(rewindFacts.position.executionEpoch, rewind.record.newExecutionEpoch);

    const beforeForward = await journal.replay();
    const forward = await executeConfirmedTaskCheckpointReentry({
      filePath: journalPath,
      journal,
      taskScope,
      principalOwner: ownerId,
      commandId: 'c3b-real-chain-forward',
      targetCheckpointCommitRef: checkpointBCommitted.commitRef,
      confirmationRef: 'confirmation:c3b-real-chain-forward',
    });
    assert.equal(forward.state, 'committed');
    assert.equal(forward.record.previousExecutionEpoch, rewindFacts.position.executionEpoch);
    assert.equal(forward.record.newExecutionEpoch, rewindFacts.position.executionEpoch + 1);
    assert.equal(forward.record.sourceCheckpointCommitRef.commitId, checkpointBCommitted.commitRef.commitId);
    assert.equal(forward.commitRef.journalSeq < forward.coverageCommitRef.journalSeq, true);
    const afterForward = await journal.replay();
    assert.deepEqual(afterForward.slice(0, beforeForward.length), beforeForward);
    const forwardRecord = conditionalReentryFromRecord(
      exactJournalRecord(afterForward, forward.commitRef),
    );
    if (!forwardRecord) throw new Error('C3b forward record is not readable');
    assert.equal(forwardRecord.restoredContext.contextView.activeRefs.includes(wrongA), false);
    assert.equal(forwardRecord.restoredContext.contextView.activeRefs.includes(wrongB), false);
    const forwardFacts = knownCurrentFacts(readCurrentFromRecords(afterForward, taskScope));
    assert.equal(forwardFacts.position.checkpointCommitRef.commitId, checkpointBCommitted.commitRef.commitId);
    assert.equal(forwardFacts.position.controlCommitRef.commitId, forward.commitRef.commitId);
    assert.equal(forwardFacts.position.executionEpoch, forward.record.newExecutionEpoch);

    const recoveryEpoch = forward.record.newExecutionEpoch + 1;
    await operationControl.initializeCoverage({
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: recoveryEpoch,
      admissionCommitRef: forward.commitRef,
    });
    const recoveryContextViewRef = `${runtimeId}:context:${recoveryEpoch}`;
    const recoveryObservationScopeId = `${runtimeId}:observation:${recoveryEpoch}`;
    const recoveryContextDigest = digest({
      activeRefs: forwardFacts.context.contextView.activeRefs,
      omittedRefs: forwardFacts.context.contextView.omittedRefs,
    });
    const recoveryLoopBase = {
      checkpointId: id('checkpoint', `c3b-real-chain-loop-${recoveryEpoch}`),
      sequence: forwardFacts.context.loopCheckpoint.sequence + 1,
      predecessor: {
        checkpointId: forwardFacts.context.loopCheckpoint.checkpointId,
        digest: forwardFacts.context.loopCheckpoint.digest,
      },
      executionEpoch: recoveryEpoch,
      observationScopeId: recoveryObservationScopeId,
      contextViewRef: recoveryContextViewRef,
      eventWatermark: forwardFacts.context.loopCheckpoint.eventWatermark,
    };
    const recoveryLoopCheckpoint = {
      ...recoveryLoopBase,
      digest: digest({ ...recoveryLoopBase, contextDigest: recoveryContextDigest }),
    };
    const recoveryContextCheckpointRef = {
      checkpointId: recoveryLoopCheckpoint.checkpointId,
      digest: recoveryLoopCheckpoint.digest,
    };
    const recoveryContext: ContextHistoryRecord = {
      ...forwardFacts.context,
      contextView: {
        ...forwardFacts.context.contextView,
        contextViewRef: recoveryContextViewRef,
        executionEpoch: recoveryEpoch,
        checkpoint: recoveryContextCheckpointRef,
        contextDigest: recoveryContextDigest,
      },
      loopCheckpoint: recoveryLoopCheckpoint,
      previousContextCommitRef: forwardFacts.position.contextCommitRef,
      loopControl: {
        ...forwardFacts.context.loopControl,
        observationScopeId: recoveryObservationScopeId,
        observationScope: null,
        inboxExecutionEpoch: recoveryEpoch,
        inboxCheckpoint: recoveryContextCheckpointRef,
        inboxObservationScopeId: recoveryObservationScopeId,
        deltaExecutionEpoch: recoveryEpoch,
        deltaCheckpoint: recoveryContextCheckpointRef,
        deltaObservationScopeId: recoveryObservationScopeId,
      },
      replacement: null,
    };
    const recoveryContextCommitRef = await contexts.commit(
      recoveryContext,
      forwardFacts.position.contextCommitRef,
    );

    const recovery = checkpoint('recovery', 3, checkpointB.id, recoveryEpoch);
    await submitCheckpoint({
      source: 'agent-tool',
      ownerId,
      checkpoint: recovery,
      previous: checkpointB,
      journal: checkpoints,
      closurePort: closures,
      preparation: await prepare({
        checkpoint: recovery,
        contextCommitRef: recoveryContextCommitRef,
        executionEpoch: recoveryEpoch,
        closureReason: 'C3b first actual recovery after forward',
      }),
    });
    const recoveryCommitted = await checkpoints.readCommitted(scope, recovery.id);
    if (!recoveryCommitted) throw new Error('C3b recovery checkpoint receipt is missing');
    assert.equal(recoveryCommitted.checkpoint.executionEpoch > forward.record.newExecutionEpoch, true);

    const ordinarySuccessor = checkpoint(
      'ordinary-successor',
      4,
      recovery.id,
      recoveryCommitted.checkpoint.executionEpoch,
    );
    await submitCheckpoint({
      source: 'agent-tool',
      ownerId,
      checkpoint: ordinarySuccessor,
      previous: recovery,
      journal: checkpoints,
      closurePort: closures,
    });
    const ordinarySuccessorCommitted = await checkpoints.readCommitted(scope, ordinarySuccessor.id);
    if (!ordinarySuccessorCommitted) throw new Error('C3b ordinary successor receipt is missing');

    const memoryInput = {
      paths,
      configuration,
      workspaceCwd: paths.workspaceCwd,
      sessionsRoot: paths.sessionsRoot,
      runNotesRoot: paths.runNotesRoot,
      auditPromptRoot,
      auditPromptRef: 'project-memory-audit',
      autoUpdate: true,
      checkpointEvidence: createJournalCheckpointEvidencePort({ filePath: journalPath }),
      binding: {
        bindingRef: 'memory-binding:c3b-real-chain',
        projectKey: paths.projectKey,
        executionEpoch: recoveryCommitted.checkpoint.executionEpoch,
        scope: {
          namespace: 'project' as const,
          projectKey: paths.projectKey,
          organId,
          taskId,
        },
        interactionScopeId: `runtime:${paths.projectKey}`,
        mainAgentId: 'c3b-real-chain-memory-main',
        actor: {
          actorId: 'memory-agent',
          roleId: 'memory' as const,
          permissions: ['memory.read', 'memory.propose'] as const,
          projectKey: paths.projectKey,
        },
      },
    };
    const memory = await composeMemoryRuntime(memoryInput);
    const admissions: Array<{
      readonly status: string;
      readonly value?: {
        readonly result?: {
          readonly curation?: {
            readonly operationId: { readonly value: string };
            readonly outcome: string;
            readonly explanation: string;
            readonly sourceRefs: readonly string[];
          };
        };
      };
    }> = [];
    const admissionPort = memory.composition.admission;
    const realAdmit = admissionPort.admit.bind(admissionPort);
    (admissionPort as { admit: typeof admissionPort.admit }).admit = async (admissionInput) => {
      const outcome = await realAdmit(admissionInput);
      admissions.push(outcome);
      return outcome;
    };
    const reconciled = await reconcileCommittedReentryMemoryBoundaries({
      memory,
      checkpointJournalPath: journalPath,
      taskScope,
    });

    assert.deepEqual(reconciled.issues, [], JSON.stringify(reconciled.issues));
    assert.deepEqual(reconciled.incomplete, [], JSON.stringify(reconciled.incomplete));
    assert.equal(reconciled.groups.length, 1, JSON.stringify(reconciled));
    assert.equal(reconciled.groups[0]?.reentryClosureIds.length, 3, JSON.stringify(reconciled.groups[0]));
    assert.equal(reconciled.consumed.committed.length, 1, JSON.stringify(reconciled.consumed));
    assert.equal(admissions.length, 1, JSON.stringify(admissions.map((entry) => entry.status)));
    const admission = admissions[0]!;
    assert.equal(admission.status, 'ready', JSON.stringify(admission));
    const curation = admission.value?.result?.curation;
    if (curation === undefined) {
      throw new Error(`C3b real chain did not return a curation outcome: ${JSON.stringify(admission)}`);
    }
    assert.equal(curation.outcome === 'attention', false, JSON.stringify(curation));
    assert.ok(curation.explanation.trim().length > 0, JSON.stringify(curation));
    assert.ok(curation.sourceRefs.length > 0, JSON.stringify(curation));

    const taskStreamId = `memory-boundaries:task:${taskId.value}`;
    const events = await memory.journal.readEvents({
      streamId: taskStreamId,
      afterSequence: 0,
      limit: 10,
    });
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.match(event.messageId, /^rewind-group-[0-9a-f]{64}$/);
    assert.equal(event.executionEpoch, recoveryCommitted.checkpoint.executionEpoch);
    const receipt = await memory.journal.readReceipt({
      consumerKey: `memory-binding:${taskId.value}`,
      messageId: event.messageId,
    });
    if (!receipt) throw new Error('C3b Memory consumer receipt is missing');
    assert.equal(receipt.disposition, 'applied', JSON.stringify(receipt));

    const feedbackQuery = { streamId: `memory-feedback:${taskId.value}`, afterSequence: 0, limit: 10 };
    const feedback = await memory.journal.readEvents(feedbackQuery);
    assert.equal(feedback.length, 1, 'applied task analysis must persist its audit feedback');
    const coldJournal = createJsonlEventJournal({ filePath: join(paths.journalRoot, 'events.jsonl') });
    const coldFeedback = await coldJournal.readEvents(feedbackQuery);
    assert.deepEqual(coldFeedback, feedback);
    const audit = coldFeedback[0]!.payload as unknown as {
      analysisRef: string; sourceRefs: readonly string[]; outcome: string; explanation: string;
    };
    assert.equal(audit.analysisRef, admission.value!.result!.curation!.operationId.value);
    assert.deepEqual(audit.sourceRefs, curation.sourceRefs);
    assert.equal(audit.outcome, curation.outcome);
    assert.equal(audit.explanation, curation.explanation);
    assert.deepEqual(await coldJournal.readReceipt({
      consumerKey: receipt.consumerKey, messageId: event.messageId,
    }), receipt);
    const coldCursor = await coldJournal.readCursor({ streamId: taskStreamId, consumerKey: receipt.consumerKey });
    assert.equal(coldCursor?.lastHandledSequence, event.sequence);

    const payload = event.payload as {
      readonly projectPatch?: { readonly patchRef: string; readonly patchDigest: string };
      readonly analysisInputs?: {
        readonly corrections: readonly {
          readonly sourceRef: string;
          readonly sourceDigest: string;
          readonly fingerprint: string;
        }[];
        readonly errors: readonly {
          readonly sourceRef: string;
          readonly sourceDigest: string;
          readonly fingerprint: string;
        }[];
        readonly rewindChains: readonly {
          readonly failedBranchRef: string;
          readonly rewindCheckpointRef: string;
          readonly recoveryCheckpointRef: string;
          readonly reentryFactRef?: string;
          readonly successfulBranchRefs: readonly string[];
          readonly successEvidenceRefs: readonly string[];
          readonly absoluteJournalRefs: readonly string[];
        }[];
        readonly actualPathRefs: readonly string[];
        readonly declaredPathRefs: readonly string[];
      };
    };
    if (!payload.projectPatch) {
      throw new Error('C3b real chain did not enter the Memory project-patch analysis path');
    }
    const analysisInputs = payload.analysisInputs;
    if (!analysisInputs) {
      throw new Error('C3b Memory analysis inputs are missing after the project-patch decision');
    }
    assert.deepEqual(analysisInputs.errors, []);
    assert.deepEqual(
      analysisInputs.corrections.map((entry) => entry.fingerprint),
      [correction.record.closureId, rewind.record.closureId, forward.record.closureId],
    );
    assert.deepEqual(
      analysisInputs.rewindChains.map((chain) => ({
        failedBranchRef: chain.failedBranchRef,
        rewindCheckpointRef: chain.rewindCheckpointRef,
        recoveryCheckpointRef: chain.recoveryCheckpointRef,
        reentryFactRef: chain.reentryFactRef,
      })),
      [
        {
          failedBranchRef: receiptLocator(checkpointBCommitted),
          rewindCheckpointRef: receiptLocator(checkpointBCommitted),
          recoveryCheckpointRef: receiptLocator(recoveryCommitted),
          reentryFactRef: checkpointClosureEvidenceLocator(correction.record.closureId),
        },
        {
          failedBranchRef: receiptLocator(checkpointBCommitted),
          rewindCheckpointRef: receiptLocator(checkpointACommitted),
          recoveryCheckpointRef: receiptLocator(recoveryCommitted),
          reentryFactRef: checkpointClosureEvidenceLocator(rewind.record.closureId),
        },
        {
          failedBranchRef: receiptLocator(checkpointACommitted),
          rewindCheckpointRef: receiptLocator(checkpointBCommitted),
          recoveryCheckpointRef: receiptLocator(recoveryCommitted),
          reentryFactRef: checkpointClosureEvidenceLocator(forward.record.closureId),
        },
      ],
    );
    assert.deepEqual(analysisInputs.actualPathRefs, [
      receiptLocator(checkpointBCommitted),
      receiptLocator(checkpointACommitted),
      receiptLocator(recoveryCommitted),
    ]);
    for (const sourceRef of analysisInputs.actualPathRefs) assert.ok(audit.sourceRefs.includes(sourceRef));
    for (const chain of analysisInputs.rewindChains) {
      const reentryFactRef = chain.reentryFactRef;
      if (!reentryFactRef) throw new Error('C3b rewind chain has no transition fact');
      assert.ok(chain.successfulBranchRefs.includes(reentryFactRef));
      assert.deepEqual(chain.successEvidenceRefs, [
        receiptLocator(recoveryCommitted),
      ]);
    }
    const openedEvents = await memory.journal.readEvents({
      streamId: taskStreamId,
      afterSequence: 0,
      limit: 10,
    });
    assert.equal(openedEvents.length, 1);
    const openedOccurredAt = openedEvents[0]!.occurredAt;
    const openedReviewState = await memory.reviewState();
    const openedCandidate = openedReviewState.candidates[0];
    if (!openedCandidate) {
      throw new Error('C3b memory did not persist a candidate before reopen');
    }
    const reopenedMemory = await composeMemoryRuntime(memoryInput);

    const afterOrdinaryReconcile = await reconcileCommittedReentryMemoryBoundaries({
      memory: reopenedMemory,
      checkpointJournalPath: journalPath,
      taskScope,
    });
    assert.deepEqual(afterOrdinaryReconcile.incomplete, []);
    assert.equal(afterOrdinaryReconcile.groups.length, 1);
    assert.equal(afterOrdinaryReconcile.groups[0]?.messageId, event.messageId);
    assert.equal(afterOrdinaryReconcile.consumed.committed.length, 0);
    const reopenedEvents = await reopenedMemory.journal.readEvents({
      streamId: taskStreamId,
      afterSequence: 0,
      limit: 10,
    });
    assert.equal(reopenedEvents.length, 1);
    assert.equal(reopenedEvents[0]!.messageId, event.messageId);
    assert.equal(reopenedEvents[0]!.occurredAt, openedOccurredAt);
    const reopenedReceipt = await reopenedMemory.journal.readReceipt({
      consumerKey: `memory-binding:${taskId.value}`,
      messageId: event.messageId,
    });
    assert.deepEqual(reopenedReceipt, receipt);
    assert.deepEqual(await reopenedMemory.journal.readEvents(feedbackQuery), coldFeedback);
    assert.deepEqual(await reopenedMemory.journal.readCursor({
      streamId: taskStreamId, consumerKey: receipt.consumerKey,
    }), coldCursor);
    assert.equal(admissions.length, 1, 'reconcile must not repeat the original analysis');
    console.log('C3b cold audit receipt', JSON.stringify({
      coldJournalPath: join(paths.journalRoot, 'events.jsonl'),
      audit,
      receipt,
      cursor: coldCursor,
      repeatedConsumptionCommits: afterOrdinaryReconcile.consumed.committed.length,
      feedbackCountAfterReconcile: coldFeedback.length,
    }));
    const updatedProjectAgents = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
    assert.equal(
      updatedProjectAgents,
      '# C3b real C1 chain\n',
      'the C3b analysis only submits a candidate; it must not publish the project source',
    );
    const reopenedReviewState = await reopenedMemory.reviewState();
    assert.equal(reopenedReviewState.candidates.length, 1, JSON.stringify(reopenedReviewState));
    const reopenedCandidate = reopenedReviewState.candidates[0]!;
    assert.equal(reopenedCandidate.candidateId, openedCandidate.candidateId);
    assert.equal(reopenedCandidate.state, 'candidate', JSON.stringify(reopenedReviewState));
    assert.equal(reopenedCandidate.taskId, taskId.value, JSON.stringify(reopenedReviewState));
    assert.ok(reopenedCandidate.summary.trim().length > 0, JSON.stringify(reopenedReviewState));
    assert.equal(
      (await readdir(paths.artifactsRoot)).some((name) => name.startsWith('memory-project-patch-')),
      true,
    );
    passed = true;
  } finally {
    if (passed) await rm(root, { recursive: true, force: true });
  }
});

test('C3b rewind group identity separates one checkpoint id across committed cycles', async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const root = await mkdtemp(join(FIXTURE_ROOT, 'c3b-same-id-'));
  let passed = false;
  try {
    const organId = id('organ', 'c3b-same-id-organ');
    const taskId = id('task', 'c3b-same-id-task');
    const operationId = id('operation', 'c3b-same-id-operation');
    const cycleOne = id('cycle', 'c3b-same-id-cycle-one');
    const cycleTwo = id('cycle', 'c3b-same-id-cycle-two');
    const checkpointFile = join(root, 'same-id-checkpoints.jsonl');
    const journal = createJsonlCheckpointJournal({ filePath: checkpointFile });
    const checkpointId = id('checkpoint', 'c3b-same-id-checkpoint');
    const scopeOne: ScopeRef = { organId, taskId, cycleId: cycleOne, operationId };
    const scopeTwo: ScopeRef = { organId, taskId, cycleId: cycleTwo, operationId };
    const sameIdCheckpoint = (scope: ScopeRef, suffix: string): Checkpoint => ({
      id: checkpointId,
      scope,
      cycleId: scope.cycleId!,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'succeeded',
      summary: `C3b same id checkpoint ${suffix}`,
      recoveryStateRef: {
        evidenceId: id('evidence', `c3b-same-id-recovery-${suffix}`),
        kind: 'operation',
        source: 'c3b-same-id-test',
        locator: `c3b-same-id://${suffix}/recovery`,
        scope,
      },
      evidenceRefs: [{
        evidenceId: id('evidence', `c3b-same-id-result-${suffix}`),
        kind: 'operation',
        source: 'c3b-same-id-test',
        locator: `c3b-same-id://${suffix}/result`,
        scope,
      }],
      next: { kind: 'continue', ref: `c3b-same-id/${suffix}/next` },
    });
    const first = sameIdCheckpoint(scopeOne, 'first');
    const second = sameIdCheckpoint(scopeTwo, 'second');
    await journal.append({
      ownerId: 'c3b-same-id-test',
      commitId: checkpointCommitId(first),
      checkpoint: first,
    });
    await journal.append({
      ownerId: 'c3b-same-id-test',
      commitId: checkpointCommitId(second),
      checkpoint: second,
    });
    const records = await new JsonlOrganJournal(checkpointFile).replay();
    const firstRecord = records.find((record) =>
      record.checkpoint?.scope.cycleId?.value === cycleOne.value);
    const secondRecord = records.find((record) =>
      record.checkpoint?.scope.cycleId?.value === cycleTwo.value);
    if (!firstRecord?.checkpoint || !secondRecord?.checkpoint) {
      throw new Error('C3b same-id committed checkpoint records are missing');
    }
    assert.equal(firstRecord.checkpoint.id.value, secondRecord.checkpoint.id.value);
    assert.equal(firstRecord.seq === secondRecord.seq, false);
    const evidenceFor = (record: JournalRecord): EvidenceRef => ({
      evidenceId: id('evidence', `c3b-same-id-receipt-${record.seq}`),
      kind: 'operation',
      source: 'humanagent.app.memory-runtime',
      locator: `humanagent://checkpoint-receipt/${record.seq}/${record.checkpoint!.id.value}`,
      digest: checkpointEvidenceDigest(record.checkpoint!),
      scope: record.checkpoint!.scope,
    });
    const port = createJournalCheckpointEvidencePort({ filePath: checkpointFile });
    const firstRead = await port.readEvidence({ evidence: evidenceFor(firstRecord) });
    const secondRead = await port.readEvidence({ evidence: evidenceFor(secondRecord) });
    assert.equal(firstRead.sourceRef === secondRead.sourceRef, false);
    assert.equal(firstRead.sourceDigest === secondRead.sourceDigest, false);
    assert.equal(firstRead.text, checkpointEvidenceText(firstRecord.checkpoint));
    assert.equal(secondRead.text, checkpointEvidenceText(secondRecord.checkpoint));
    const commitRefFor = (record: JournalRecord): JournalCommitRef => ({
      commitId: record.commitId!,
      journalSeq: record.seq,
      recordDigest: record.recordDigest,
    });
    const taskScope: ScopeRef = { organId, taskId };
    const firstMessageId = rewindGroupMessageId({
      scope: taskScope,
      recoveryCheckpoint: firstRecord.checkpoint,
      recoveryCheckpointCommitRef: commitRefFor(firstRecord),
    });
    const secondMessageId = rewindGroupMessageId({
      scope: taskScope,
      recoveryCheckpoint: secondRecord.checkpoint,
      recoveryCheckpointCommitRef: commitRefFor(secondRecord),
    });
    assert.equal(firstMessageId === secondMessageId, false);
    assert.match(firstMessageId, /^rewind-group-[0-9a-f]{64}$/);
    assert.match(secondMessageId, /^rewind-group-[0-9a-f]{64}$/);
    passed = true;
  } finally {
    if (passed) await rm(root, { recursive: true, force: true });
  }
});
