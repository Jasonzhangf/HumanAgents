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
  type EvidenceRef,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';
import {
  checkpointClosureEvidenceLocator,
  checkpointEvidenceDigest,
  createJsonlCheckpointClosurePort,
  createJsonlCheckpointJournal,
  readCommittedCheckpoint,
} from '../../packages/app/src/checkpoint-journal.js';
import { composeMemoryRuntime, filesystemTaskEvidence } from '../../packages/app/src/index.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';

const FIXTURE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? '/Users/fanzhang/.humanagent/test-fixtures/provider-release-rc5-r1-20261015';

function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function checkpointEvidenceRef(input: {
  readonly checkpoint: Checkpoint;
  readonly evidenceId: string;
}): EvidenceRef {
  return {
    evidenceId: id('evidence', input.evidenceId),
    kind: 'operation',
    source: 'memory-path-producer-test',
    locator: `humanagent://checkpoint/${input.checkpoint.id.value}`,
    digest: checkpointEvidenceDigest(input.checkpoint),
    scope: input.checkpoint.scope,
  };
}

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
    const [selectedCommitted, failedCommitted, recoveryCommitted] = await Promise.all([
      committed(selected),
      committed(failed),
      committed(recovery),
    ]);

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

    const taskJournalPath = join(paths.checkpointsRoot, 'ui-runtime', 'fixture', 'ui-runtime-journal.jsonl');
    await mkdir(join(paths.checkpointsRoot, 'ui-runtime', 'fixture'), { recursive: true });
    const declaredDirective = 'restore the selected checkpoint path';
    const declaredInput = 'resume from the accepted plan';
    const declaredOutput = 'selected path restored';
    const runEvidence = (locator: string, evidenceId: string): EvidenceRef => ({
      evidenceId: id('evidence', evidenceId),
      kind: 'operation',
      source: 'memory-path-producer-test',
      locator,
      scope,
    });
    const acceptedPlanEvidence = runEvidence(
      'humanagent://operation/memory-path-producer/accepted-plan',
      'memory-path-accepted-plan',
    );
    const correctionEvidence = runEvidence(
      'humanagent://operation/memory-path-producer/correction',
      'memory-path-correction',
    );
    const errorEvidence = runEvidence(
      'humanagent://operation/memory-path-producer/error',
      'memory-path-error',
    );
    const records = [
      {
        kind: 'task.created',
        taskId,
        title: 'memory path producer',
        directive: declaredDirective,
        directiveRevision: 1,
        createdAt: '2026-10-15T12:00:00.000Z',
        taskCounter: 1,
      },
      {
        kind: 'operation.started',
        taskId,
        cycleId,
        operationId,
        input: declaredInput,
        executionEpoch: recoveryCommitted.checkpoint.executionEpoch,
        occurredAt: '2026-10-15T12:00:01.000Z',
      },
      {
        kind: 'operation.event',
        taskId,
        operationId,
        taskOutput: declaredOutput,
        event: {
          evidenceRefs: [acceptedPlanEvidence, correctionEvidence, errorEvidence],
        },
      },
    ];
    await writeFile(
      taskJournalPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    const taskEvidence = filesystemTaskEvidence({ journalPath: taskJournalPath });
    const declaredTask = await taskEvidence.readTask({ taskId, scope });
    const declaredTaskRef: EvidenceRef = {
      evidenceId: id('evidence', 'memory-path-declared-task'),
      kind: 'operation',
      source: 'memory-path-producer-test',
      locator: `humanagent://task/${taskId.value}`,
      digest: digest(JSON.stringify({
        directive: declaredTask.directive,
        input: declaredTask.input,
        output: declaredTask.output,
      })),
      scope,
    };
    const resolveRunEvidence = async (candidate: EvidenceRef): Promise<EvidenceRef> => {
      const resolved = await taskEvidence.readEvidence!({ evidence: candidate });
      return { ...candidate, digest: resolved.sourceDigest };
    };
    const declaredPlanRef = await resolveRunEvidence(acceptedPlanEvidence);
    const correctionRef = await resolveRunEvidence(correctionEvidence);
    const errorRef = await resolveRunEvidence(errorEvidence);
    const selectedPathRef = checkpointEvidenceRef({ checkpoint: selectedCommitted.checkpoint, evidenceId: 'actual-old' });
    const recoveryPathRef = checkpointEvidenceRef({ checkpoint: recoveryCommitted.checkpoint, evidenceId: 'actual-new' });
    const successEvidenceRef = checkpointEvidenceRef({ checkpoint: recoveryCommitted.checkpoint, evidenceId: 'success-result' });
    if (correctionRef.digest === undefined || errorRef.digest === undefined) {
      throw new Error('resolved correction and error evidence must carry a source digest');
    }

    const memory = await composeMemoryRuntime({
      paths,
      configuration,
      workspaceCwd: paths.workspaceCwd,
      sessionsRoot: paths.sessionsRoot,
      runNotesRoot: paths.runNotesRoot,
      auditPromptRoot,
      auditPromptRef: 'project-memory-audit',
      autoUpdate: false,
      taskEvidence,
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

    await memory.boundaryPublisher.publish({
      checkpoint: recoveryCommitted.checkpoint,
      recordDigest: recoveryCommitted.recordDigest,
      trigger: 'rewind',
      relatedCheckpoints: [failedCommitted.checkpoint],
      rewind: {
        failedCheckpoint: failedCommitted.checkpoint,
        failedCheckpointRecordDigest: failedCommitted.recordDigest,
        selectedCheckpoint: selectedCommitted.checkpoint,
        selectedCheckpointRecordDigest: selectedCommitted.recordDigest,
        recoveryCheckpoint: recoveryCommitted.checkpoint,
        recoveryCheckpointRecordDigest: recoveryCommitted.recordDigest,
        reentry: committedReentry,
        actualPaths: [selectedPathRef, recoveryPathRef],
        declaredPaths: [declaredTaskRef, declaredPlanRef],
        corrections: [{ evidence: correctionRef, fingerprint: 'selected-path-correction' }],
        errors: [{ evidence: errorRef, fingerprint: 'failed-path-error' }],
        successEvidence: [successEvidenceRef],
      },
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
      sourceRef: correctionRef.locator,
      sourceDigest: correctionRef.digest,
      fingerprint: 'selected-path-correction',
    }]);
    assert.deepEqual(analysisInputs.errors, [{
      sourceRef: errorRef.locator,
      sourceDigest: errorRef.digest,
      fingerprint: 'failed-path-error',
    }]);
    assert.deepEqual(analysisInputs.actualPathRefs, [selectedPathRef.locator, recoveryPathRef.locator]);
    assert.deepEqual(analysisInputs.declaredPathRefs, [declaredTaskRef.locator, declaredPlanRef.locator]);
    const chain = analysisInputs.rewindChains[0]!;
    assert.equal(chain.failedBranchRef, `humanagent://checkpoint/${failedCommitted.checkpoint.id.value}`);
    assert.equal(chain.rewindCheckpointRef, `humanagent://checkpoint/${selectedCommitted.checkpoint.id.value}`);
    assert.equal(chain.rewindCheckpointRef === chain.failedBranchRef, false);
    assert.equal(chain.recoveryCheckpointRef, `humanagent://checkpoint/${recoveryCommitted.checkpoint.id.value}`);
    assert.equal(chain.reentryFactRef, checkpointClosureEvidenceLocator(reentry.closureId));
    assert.deepEqual(chain.successfulBranchRefs, [chain.reentryFactRef!]);
    assert.deepEqual(chain.successEvidenceRefs, [successEvidenceRef.locator]);
    assert.ok(chain.absoluteJournalRefs.includes(correctionRef.locator));
    assert.ok(chain.absoluteJournalRefs.includes(errorRef.locator));
    assert.ok(chain.absoluteJournalRefs.includes(declaredTaskRef.locator));
    assert.ok(chain.absoluteJournalRefs.includes(declaredPlanRef.locator));
    const eventEvidence = new Map(event.evidenceRefs.map((evidence) => [evidence.locator, evidence.digest]));
    assert.equal(eventEvidence.get(correctionRef.locator), correctionRef.digest);
    assert.equal(eventEvidence.get(errorRef.locator), errorRef.digest);
    assert.equal(eventEvidence.get(declaredTaskRef.locator), declaredTaskRef.digest);
    assert.equal(eventEvidence.get(declaredPlanRef.locator), declaredPlanRef.digest);
    assert.equal(eventEvidence.get(selectedPathRef.locator), selectedPathRef.digest);
    assert.equal(eventEvidence.get(recoveryPathRef.locator), recoveryPathRef.digest);
    assert.equal(eventEvidence.get(successEvidenceRef.locator), successEvidenceRef.digest);

    const consumed = await memory.consume();
    assert.equal(consumed.retries.length, 0, JSON.stringify(consumed));
    assert.equal(consumed.committed.length, 1, JSON.stringify(consumed));
    assert.equal(consumed.committed[0]?.disposition, 'applied', JSON.stringify(consumed));
    const reviewState = await memory.reviewState();
    assert.equal(reviewState.autoUpdate, false);
    assert.equal(reviewState.candidates.length, 1);
    assert.equal(reviewState.candidates[0]?.state, 'candidate');
    assert.equal(reviewState.candidates[0]?.taskId, taskId.value);
    assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), '# Memory path producer\n');
    assert.equal((await readdir(paths.artifactsRoot)).some((name) => name.startsWith('memory-project-patch-')), false);
    passed = true;
  } finally {
    if (passed) await rm(root, { recursive: true, force: true });
  }
});
