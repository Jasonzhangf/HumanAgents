import assert from 'node:assert/strict';
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
  type EvidenceRef,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';
import {
  checkpointClosureEvidenceDigest,
  checkpointClosureEvidenceLocator,
  checkpointEvidenceDigest,
  checkpointEvidenceLocator,
  createJsonlCheckpointClosurePort,
  createJsonlCheckpointJournal,
  readCommittedCheckpoint,
} from '../../packages/app/src/checkpoint-journal.js';
import { composeMemoryRuntime } from '../../packages/app/src/index.js';
import {
  createJournalCheckpointEvidencePort,
  publishRewindMemoryBoundaryFromJournal,
} from '../../packages/app/src/memory-runtime.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';

const FIXTURE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? '/Users/fanzhang/.humanagent/test-fixtures/provider-n2-c-memory-finish-20261016';

test('rewind publisher feeds the existing memory consumer committed path and correction evidence', async () => {
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
    const committed = async (current: Checkpoint) => readCommittedCheckpoint({
      filePath: checkpointFile,
      scope: current.scope,
      checkpointId: current.id,
    });
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
          roleId: 'memory',
          permissions: ['memory.read', 'memory.propose'],
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
