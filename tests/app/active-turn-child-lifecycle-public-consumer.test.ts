import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  canonicalJsonStringify, id,
  type ActiveTurnBinding, type ActiveTurnCaptureBody, type EvidenceRef,
  type RawAsset, type ReviewAssignment, type ReviewResult, type ScopeRef, type WorkAssignment,
} from '../../packages/contracts/src/index.js';
import { activeTurnSegmentCommitId } from '../../packages/contracts/src/active-turn-segments.js';
import { ImmutableAssetStore, evidenceReference } from '../../packages/adapters/filesystem/src/index.js';
import { JournalIntegrityError, JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { createJsonlActiveTurnJournal } from '../../packages/adapters/jsonl/src/active-turn.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { createActiveTurnSegmentJournal, createNativeRecoveryAssets } from '../../packages/app/src/native-recovery-assets.js';
import { produceAdmittedTurn } from '../../packages/runtime/src/admission/admitted-turn.js';
import { ActiveTurnContext } from '../../packages/runtime/src/context/active-turn-context.js';
import { activeTurnCommitId, type ActiveTurnJournalRecord } from '../../packages/runtime/src/context/active-turn-journal.js';
import { resumeActiveTurnSegment } from '../../packages/runtime/src/context/active-turn-segments.js';

// Observed A item139 rejects legal adoption and blocks four HP cases. This one
// local fixture covers the same Runtime boundary plus actual review/segment
// snapshots. Wrong suffix/prerequisite regression probability is unknown;
// corruption impact warrants four direct counterexamples, not a scenario matrix.
const ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'child-lifecycle-codec');

// Existing cold helpers read recovery receipts, not reconstructed child context.
// This reader loads only emitted public modules and persisted Journal/assets.
const COLD_READER = `
const { pathToFileURL } = await import('node:url');
const { join } = await import('node:path');
const [base, journalPath, assetRoot, completionJournalPath] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(join(base, name)).href);
const { createJsonlActiveTurnJournal } = await load('packages/adapters/jsonl/src/active-turn.js');
const { JsonlOrganJournal } = await load('packages/adapters/jsonl/src/index.js');
const { ImmutableAssetStore } = await load('packages/adapters/filesystem/src/index.js');
const { ActiveTurnContext } = await load('packages/runtime/src/context/active-turn-context.js');
const { materializeActiveTurn } = await load('packages/runtime/src/context/active-turn-materializer.js');
const { createActiveTurnSegmentJournal } = await load('packages/app/src/native-recovery-assets.js');
const turnId = 'lifecycle-turn';
const journal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
const context = await ActiveTurnContext.reconstruct(journal, turnId);
const capture = {
  version: 1, binding: context.activeBinding, initialInput: context.initialInput(),
  requests: context.requests(), entries: context.entries(),
  childInvocations: context.childInvocations(), checkpointPath: [], completionRefs: [],
  cut: { pauseId: 'cold-read', lastSeq: 1, producersDrained: true, frozenAt: '2026-10-13T00:00:00.000Z' },
};
const store = new ImmutableAssetStore(assetRoot);
const resolved = await materializeActiveTurn({ capture, rawContent: { read: ({ content }) => store.readEvidence(content.ref) } });
const port = createActiveTurnSegmentJournal({ journalPath, assetRoot, completionJournalPath, businessTurnId: turnId });
const segments = await port.readSegments(turnId);
const segmentRecords = await port.readSegmentRecords({ businessTurnId: turnId, segmentId: 'lifecycle-segment' });
const chain = await new JsonlOrganJournal(journalPath).verify();
process.stdout.write(JSON.stringify({
  valid: chain.valid, turnId: context.admittedTurn.turnId, binding: context.activeBinding,
  invocation: context.childInvocations()[0],
  refinedText: new TextDecoder().decode(resolved.entries[0].bytes),
  initialText: new TextDecoder().decode(resolved.initialInput.bytes),
  segment: segments[0], segmentRecords,
  commitIds: chain.records.map((record) => record.commitId),
}));
`;

test('Runtime child dispatch, adoption and post-review survive exact v1/v2 Journal and fresh cold consumers', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'lifecycle-'));
  try {
    const journalPath = join(root, 'organ.jsonl');
    const assetRoot = join(root, 'assets');
    const completionJournalPath = join(root, 'completion.jsonl');
    const turnId = 'lifecycle-turn';
    const taskId = id('task', 'lifecycle-task');
    const scope: ScopeRef = {
      organId: id('organ', 'lifecycle-organ'), taskId,
      cycleId: id('cycle', 'lifecycle-cycle'), operationId: id('operation', 'lifecycle-operation'),
    };
    const evidence = (label: string): EvidenceRef => ({
      evidenceId: id('evidence', label), kind: 'operation', source: 'child-lifecycle-consumer',
      locator: `test://lifecycle/${label}`, scope,
    });
    const assignment: WorkAssignment = {
      assignmentId: 'lifecycle-assignment', taskId, pipelineNodeId: 'lifecycle-node',
      attempt: 1, executionEpoch: 1, inputRevision: 1, objective: 'persist refined review lifecycle',
      targetRefs: ['subject:lifecycle'], expectedOutputRefs: ['output:lifecycle'],
      successCriteria: ['cold reconstruction'],
      failureCriteria: ['missing child facts'], incompleteCriteria: ['missing proof'],
      requiredCapabilities: ['provider.execution'], mergeGate: 'not-required',
    };
    const runtime = {
      runtimeId: 'lifecycle-runtime', executionEpoch: 1, ownerRef: 'lifecycle-owner',
      permissionRevision: 'lifecycle-permission',
    };
    const admittedTurn = produceAdmittedTurn({
      runtime, taskId, scope, assignment, directiveRevision: 1, turnId,
      currentTurnRef: 'active-turn://lifecycle-turn', admissionEvidence: [evidence('admission')],
      recoveryStateRef: evidence('recovery'),
    });
    const binding: ActiveTurnBinding = {
      admittedTurn, assignment, execution: { runtimeId: runtime.runtimeId, executionEpoch: 1 }, scope,
    };
    const store = new ImmutableAssetStore(assetRoot);
    const initialBytes = new TextEncoder().encode(' original input 世界 \t ');
    const refinedBytes = new TextEncoder().encode(' refined review passed 世界\n ');
    const initialInput: RawAsset = {
      ref: evidenceReference(await store.write('lifecycle-input', initialBytes), scope, 'operation', 'lifecycle-input'),
      view: { kind: 'utf8-text' },
    };
    const refinedDelivery: RawAsset = {
      ref: evidenceReference(await store.write('lifecycle-refined', refinedBytes), scope, 'operation', 'lifecycle-refined'),
      view: { kind: 'utf8-text' },
    };
    const journal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
    const context = await ActiveTurnContext.open({ journal, binding, currentTurnRef: admittedTurn.currentTurnRef });
    await context.registerInitialInput(initialInput);
    const review: ReviewAssignment = {
      assignmentId: 'lifecycle-review-assignment', taskId: taskId.value, workerAgentId: 'lifecycle-worker',
      reviewKind: 'quality', attempt: 1, executionEpoch: 1, inputRevision: 1,
      subjectRefs: ['subject:lifecycle'],
      workerCapabilities: ['provider.execution'],
      requiredCapabilities: ['review.quality'], mergeGate: 'not-required',
    };
    const result: ReviewResult = {
      resultId: 'lifecycle-review-result', assignmentId: review.assignmentId, taskId: review.taskId,
      workerAgentId: review.workerAgentId, reviewKind: review.reviewKind, attempt: review.attempt,
      executionEpoch: review.executionEpoch, inputRevision: review.inputRevision,
      subjectRefs: review.subjectRefs,
      status: 'passed', findings: [], evidenceRefs: [evidence('review')],
    };
    await context.openChildInvocation({
      invocationId: 'review-child', childTurnId: 'review-child-turn', checkpointReceiptRef: 'pre-call-checkpoint',
      binding: { kind: 'review', assignment: review },
    });
    const delivery = await context.recordChildReturn({
      kind: 'review', invocationId: 'review-child', assignment: review, result, refinedDelivery,
    });
    // Old codec's actual RED is here: Runtime emits adopted:review-child.
    await context.recordChildAdoption('review-child', delivery);
    await context.recordReviewCheckpoint('review-child', 'post-review-checkpoint');
    const records = await journal.replay();
    const snapshots = records.filter((record) => record.kind === 'child-invocation' || record.kind === 'child-delivery');
    assert.equal(snapshots.length, 4);
    const latest = context.childInvocations()[0]!;
    assert.equal(latest.adoptedResultSeq, delivery.seq);
    assert.equal(latest.postReviewCheckpointRef, 'post-review-checkpoint');
    const chain = await new JsonlOrganJournal(journalPath).verify();
    assert.equal(chain.valid, true);
    assert.deepEqual(chain.records.map((record) => record.commitId), [
      'active-turn:lifecycle-turn:binding-opened', 'active-turn:lifecycle-turn:initial-input',
      'active-turn:lifecycle-turn:invocation:review-child', 'active-turn:lifecycle-turn:delivery:review-child',
      'active-turn:lifecycle-turn:adopted:review-child', 'active-turn:lifecycle-turn:review-checkpoint:review-child',
    ]);

    // Reuse J1's real v1 predecessor + TG1 grant/held business reservation.
    const native = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
    const body: ActiveTurnCaptureBody = {
      version: 1, binding, initialInput, entries: context.entries(), requests: context.requests(),
      childInvocations: context.childInvocations(), checkpointPath: [], completionRefs: [],
      cut: { pauseId: 'lifecycle-boundary', lastSeq: delivery.seq, producersDrained: true, frozenAt: '2026-10-13T00:00:00.000Z' },
    };
    const receipt = await native.commitCapturePhase({
      turnId, boundaryId: 'lifecycle-boundary', prepared: {
        body, controlRecordCount: 4, producerDrains: [], completionLookups: [],
        recovery: {
          commitIdentity: 'recovery-hold:v1:lifecycle-turn', laterErrorRefs: [], rawTurnRefs: ['active-turn://lifecycle-turn'],
          unresolvedOperationRefs: [], stages: [], durablePhases: [], durableReceiptRefs: [],
          recoveryResponsibilityRef: 'recovery://lifecycle-turn',
        },
      },
    });
    const port = createActiveTurnSegmentJournal({ journalPath, assetRoot, completionJournalPath, businessTurnId: turnId });
    const grants = new JsonlTaskGrantJournal(new JsonlOrganJournal(journalPath));
    const capability = { actionId: 'checkpoint.save', capabilities: ['provider.execution'], scope };
    await grants.grant({ requestId: 'lifecycle-grant', taskId, owner: 'lifecycle-owner', capability, expectedRevision: 0 });
    const resumed = await resumeActiveTurnSegment({
      businessTurnId: turnId, segmentId: 'lifecycle-segment', assignment, scope,
      incarnation: {
        runtimeId: runtime.runtimeId, generation: 2, agentInstanceId: 'lifecycle-agent-2', roleId: 'role-executor',
        taskId, assignmentId: assignment.assignmentId, executionEpoch: 2,
      },
      ports: { read: port, append: port },
      admit: async (intent) => {
        const requestRef = `segment-open:${intent.businessTurnRef.businessTurnId}:${intent.segmentId}`;
        const request = {
          requestRef, taskId, owner: 'lifecycle-owner', capability,
          inputIdentity: { requestRef, digest: `sha256:${createHash('sha256').update(canonicalJsonStringify(intent)).digest('hex')}` },
        };
        const businessRegistrationCommitRef = await grants.withAuthorizedNewBusiness(request,
          async (authority, registration) => registration.registerBusiness({ ...request, grantRevision: authority.grant.revision }));
        const authorityCommitRef = (await grants.readTaskGrant(taskId)).commit;
        if (authorityCommitRef === null) throw new Error('grant commit missing');
        return { authorized: true, authorityCommitRef, businessRegistrationCommitRef, requestRef, inputIdentity: request.inputIdentity };
      },
    });
    assert.equal(resumed.status, 'resumed');
    if (resumed.status !== 'resumed') throw new Error('legal segment admission failed');
    assert.equal(resumed.segment.predecessor.recoveryAssetsReceiptRef, receipt.commitIdentity);
    const suffixes = ['invocation:review-child', 'delivery:review-child', 'adopted:review-child', 'review-checkpoint:review-child'];
    // Codec consumer of these SAME Runtime facts, not an App segment producer.
    for (let index = 0; index < snapshots.length; index += 1) {
      await port.appendSegmentRecord({ businessTurnId: turnId, segmentId: 'lifecycle-segment',
        commitId: activeTurnSegmentCommitId('lifecycle-segment', suffixes[index]!), record: snapshots[index]! });
    }
    assert.deepEqual(await port.readSegmentRecords({ businessTurnId: turnId, segmentId: 'lifecycle-segment' }), snapshots);

    const before = await readFile(journalPath, 'utf8');
    const adopted = snapshots[2]!;
    await assert.rejects(() => journal.append({ commitId: 'active-turn:lifecycle-turn:invocation:review-child', record: adopted }), (error: unknown) => error instanceof JournalIntegrityError);
    await assert.rejects(() => port.appendSegmentRecord({ businessTurnId: turnId, segmentId: 'lifecycle-segment',
      commitId: activeTurnSegmentCommitId('lifecycle-segment', 'invocation:review-child'), record: adopted }), (error: unknown) => error instanceof JournalIntegrityError);
    const { adoptedResultSeq: _adopted, ...unadopted } = latest;
    await assert.rejects(() => journal.append({ commitId: 'active-turn:lifecycle-turn:review-checkpoint:review-child',
      record: { kind: 'child-invocation', record: unadopted } }), (error: unknown) => error instanceof JournalIntegrityError);
    await assert.rejects(() => journal.append({ commitId: 'active-turn:lifecycle-turn:review-checkpoint:review-child',
      record: { kind: 'child-invocation', record: { ...latest, postReviewCheckpointRef: latest.checkpointReceiptRef } } }), (error: unknown) => error instanceof JournalIntegrityError);
    assert.equal(await readFile(journalPath, 'utf8'), before, 'all changed-boundary rejects append zero bytes');

    const cold = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', COLD_READER,
        join(process.cwd(), 'dist/tests'), journalPath, assetRoot, completionJournalPath],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(cold.code, 0, cold.stderr);
    const readback = JSON.parse(cold.stdout);
    assert.equal(readback.valid, true);
    assert.equal(readback.turnId, 'lifecycle-turn');
    assert.deepEqual(readback.binding, binding);
    assert.deepEqual(readback.invocation, latest);
    assert.equal(readback.refinedText, new TextDecoder().decode(refinedBytes));
    assert.equal(readback.initialText, new TextDecoder().decode(initialBytes));
    assert.equal(readback.segment.segmentId, 'lifecycle-segment');
    assert.equal(readback.segment.businessTurnRef.businessTurnId, 'lifecycle-turn');
    assert.deepEqual(readback.segmentRecords, snapshots);
    assert.deepEqual(readback.commitIds.slice(-4), [
      'active-turn-segment:lifecycle-segment:invocation:review-child',
      'active-turn-segment:lifecycle-segment:delivery:review-child',
      'active-turn-segment:lifecycle-segment:adopted:review-child',
      'active-turn-segment:lifecycle-segment:review-checkpoint:review-child',
    ]);
    assert.equal(await readFile(journalPath, 'utf8'), before, 'fresh reconstruction and reads append nothing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A completed review commits its post-review checkpoint before the parent
// selects. The old codec inferred the transition from post-review field
// presence, so that later selection commit would collapse onto the
// review-checkpoint identity. Wrong-transition commit probability is UNKNOWN;
// it silently corrupts a later decision write and its cold decode, so the
// counterexample is one physical Journal round trip, not a matrix.
test('JSONL codec commits the exact not-selected transition and rejects a missing or conflicting selection', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'nonselection-codec-'));
  try {
    const journalPath = join(root, 'organ.jsonl');
    const assetRoot = join(root, 'assets');
    const turnId = 'codec-turn';
    const taskId = id('task', 'codec-task');
    const scope: ScopeRef = {
      organId: id('organ', 'codec-organ'), taskId,
      cycleId: id('cycle', 'codec-cycle'), operationId: id('operation', 'codec-operation'),
    };
    const evidence = (label: string): EvidenceRef => ({
      evidenceId: id('evidence', label), kind: 'operation', source: 'child-lifecycle-consumer',
      locator: `test://codec/${label}`, scope,
    });
    const assignment: WorkAssignment = {
      assignmentId: 'codec-assignment', taskId, pipelineNodeId: 'codec-node',
      attempt: 1, executionEpoch: 1, inputRevision: 1, objective: 'retain a terminal non-selection',
      targetRefs: ['subject:codec'], expectedOutputRefs: ['output:codec'],
      successCriteria: ['exact codec identity'],
      failureCriteria: ['a mis-derived transition identity'], incompleteCriteria: ['missing cold read'],
      requiredCapabilities: ['provider.execution'], mergeGate: 'not-required',
    };
    const runtime = {
      runtimeId: 'codec-runtime', executionEpoch: 1, ownerRef: 'codec-owner',
      permissionRevision: 'codec-permission',
    };
    const admittedTurn = produceAdmittedTurn({
      runtime, taskId, scope, assignment, directiveRevision: 1, turnId,
      currentTurnRef: 'active-turn://codec-turn', admissionEvidence: [evidence('admission')],
      recoveryStateRef: evidence('recovery'),
    });
    const binding: ActiveTurnBinding = {
      admittedTurn, assignment, execution: { runtimeId: runtime.runtimeId, executionEpoch: 1 }, scope,
    };
    const store = new ImmutableAssetStore(assetRoot);
    const initialInput: RawAsset = {
      ref: evidenceReference(await store.write('codec-input', new TextEncoder().encode('codec input')), scope, 'operation', 'codec-input'),
      view: { kind: 'utf8-text' },
    };
    const refinedDelivery: RawAsset = {
      ref: evidenceReference(await store.write('codec-refined', new TextEncoder().encode('codec review passed')), scope, 'operation', 'codec-refined'),
      view: { kind: 'utf8-text' },
    };
    const journal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
    const context = await ActiveTurnContext.open({ journal, binding, currentTurnRef: admittedTurn.currentTurnRef });
    await context.registerInitialInput(initialInput);
    const review: ReviewAssignment = {
      assignmentId: 'codec-review-assignment', taskId: taskId.value, workerAgentId: 'codec-worker',
      reviewKind: 'quality', attempt: 1, executionEpoch: 1, inputRevision: 1,
      subjectRefs: ['subject:codec'],
      workerCapabilities: ['provider.execution'],
      requiredCapabilities: ['review.quality'], mergeGate: 'not-required',
    };
    const result: ReviewResult = {
      resultId: 'codec-review-result', assignmentId: review.assignmentId, taskId: review.taskId,
      workerAgentId: review.workerAgentId, reviewKind: review.reviewKind, attempt: review.attempt,
      executionEpoch: review.executionEpoch, inputRevision: review.inputRevision,
      subjectRefs: review.subjectRefs,
      status: 'passed', findings: [], evidenceRefs: [evidence('review')],
    };
    await context.openChildInvocation({
      invocationId: 'codec-review', childTurnId: 'codec-review-turn', checkpointReceiptRef: 'codec-pre',
      binding: { kind: 'review', assignment: review },
    });
    const delivery = await context.recordChildReturn({
      kind: 'review', invocationId: 'codec-review', assignment: review, result, refinedDelivery,
    });
    await context.openChildInvocation({
      invocationId: 'codec-unreturned', childTurnId: 'codec-unreturned-turn',
      checkpointReceiptRef: 'codec-unreturned-pre', binding: { kind: 'review', assignment: review },
    });
    const opening = context.childInvocations().find((record) => record.invocationId === 'codec-review')!;
    const unreturned = context.childInvocations().find((record) => record.invocationId === 'codec-unreturned')!;

    // The completed review commits its post-review checkpoint while selection
    // is still pending.
    const withCheckpoint = { ...opening, postReviewCheckpointRef: 'codec-post' };
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'review-checkpoint:codec-review'),
      record: { kind: 'child-invocation', record: withCheckpoint },
    });
    // The later terminal non-selection keeps that association under its own
    // transition identity.
    const notSelected = { ...withCheckpoint, notSelectedResultSeq: delivery.seq };
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'not-selected:codec-review'),
      record: { kind: 'child-invocation', record: notSelected },
    });

    const cold = await createJsonlActiveTurnJournal({ filePath: journalPath, turnId }).replay();
    const decisions = cold.filter(
      (record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-invocation' }> => record.kind === 'child-invocation',
    );
    assert.equal(decisions.length, 4);
    const latest = decisions[decisions.length - 1]!;
    assert.equal(latest.record.notSelectedResultSeq, delivery.seq);
    assert.equal(latest.record.adoptedResultSeq, undefined);
    assert.equal(latest.record.postReviewCheckpointRef, 'codec-post');
    const committed = await new JsonlOrganJournal(journalPath).verify();
    assert.equal(committed.valid, true);
    assert.ok(committed.records.some((record) => record.commitId === `active-turn:${turnId}:review-checkpoint:codec-review`));
    assert.ok(committed.records.some((record) => record.commitId === `active-turn:${turnId}:not-selected:codec-review`));

    // The same-key exact retry reuses the committed snapshot.
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'not-selected:codec-review'),
      record: { kind: 'child-invocation', record: notSelected },
    });
    const retried = await new JsonlOrganJournal(journalPath).verify();
    assert.equal(retried.records.filter((record) => record.commitId === `active-turn:${turnId}:not-selected:codec-review`).length, 1);
    // The exact opening retry likewise reuses its committed snapshot.
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'invocation:codec-unreturned'),
      record: { kind: 'child-invocation', record: unreturned },
    });
    assert.equal(
      (await new JsonlOrganJournal(journalPath).verify()).records.filter((record) => record.commitId === `active-turn:${turnId}:invocation:codec-unreturned`).length,
      1,
    );

    // A snapshot that both adopts and not-selects one delivery is rejected.
    await assert.rejects(
      () => journal.append({
        commitId: activeTurnCommitId(turnId, 'not-selected:codec-review'),
        record: { kind: 'child-invocation', record: { ...notSelected, adoptedResultSeq: delivery.seq } },
      }),
      (error: unknown) => error instanceof JournalIntegrityError,
    );
    // A non-selection without a durable return is rejected.
    await assert.rejects(
      () => journal.append({
        commitId: activeTurnCommitId(turnId, 'not-selected:codec-unreturned'),
        record: { kind: 'child-invocation', record: { ...unreturned, notSelectedResultSeq: 1 } },
      }),
      (error: unknown) => error instanceof JournalIntegrityError,
    );
    assert.equal(
      await new JsonlOrganJournal(journalPath).verify().then((chain) => chain.records.length),
      committed.records.length,
      'every rejected transition appends zero bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
