import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id, canonicalJsonStringify, checkpointCommitIdentityV2, checkpointIntentDigestV1,
  type AdmittedTurn, type Checkpoint, type CheckpointReceiptRelationshipV1,
  type CheckpointTimeAuthorityMetadata, type WorkAssignment,
} from '../../../packages/contracts/src/index.js';
import type { JournalCommitRef } from '../../../packages/contracts/src/i2-history.js';
import type { NativeSegmentSaveSourceV2 } from '../../../packages/contracts/src/active-turn-segments.js';
import { projectAdmittedTurnIdentityV1 } from '../../../packages/runtime/src/context/semantic-history.js';
import {
  nativeSegmentSaveIntentDigestV2, type NativeSaveIntentV1, type NativeSaveKey,
  type NativeSaveProgress, type NativeSaveProgressPort, type NativeSaveProgressReadback,
  type NativeSegmentSaveIntentV2,
} from '../../../packages/runtime/src/checkpoints/native-save-contract.js';
import {
  JsonlOrganJournal, JournalCommitConflictError, type JournalRecord, type JournalVerification,
} from '../../../packages/adapters/jsonl/src/index.js';
import { createJsonlNativeSaveProgressPort } from '../../../packages/adapters/jsonl/src/native-save-progress.js';

declare module 'node:os' { function homedir(): string; }

const scope = { organId: id('organ', 'progress-organ'), taskId: id('task', 'progress-task'), cycleId: id('cycle', 'progress-cycle') };
const timeAuthority: CheckpointTimeAuthorityMetadata = {
  source: 'harness', owner: 'runtime-checkpoint-control-owner', authorityRef: 'progress-fixture-clock',
};
const committedAt = '2026-10-13T00:00:00.000Z';
const admitted: AdmittedTurn = {
  turnId: 'progress-turn', workAssignmentRef: 'progress-assignment', taskRef: scope.taskId, scopeRef: scope,
  cycleRef: scope.cycleId, inputRevision: 1, directiveRevision: 1, executionEpoch: 1,
  runtimeBindingRef: 'progress-binding', permissionRevision: '1', admissionEvidenceRefs: [],
  currentTurnRef: 'progress-current-turn', recoveryStateRef: 'progress-recovery',
};
const checkpoint: Checkpoint = {
  id: id('checkpoint', 'progress-checkpoint'), scope, cycleId: scope.cycleId,
  seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 1,
  outcome: 'succeeded', summary: 'progress checkpoint', evidenceRefs: [], next: { kind: 'continue' },
  recoveryStateRef: { evidenceId: id('evidence', 'progress-recovery'), kind: 'execution',
    source: 'progress-consumer', locator: 'progress:recovery', scope },
};
const key = { turn: projectAdmittedTurnIdentityV1(admitted), boundaryId: 'shared-boundary',
  checkpoint: { id: checkpoint.id, scope } };
const recovery = { recoveryStateRef: 'progress-recovery', recoveryResponsibilityRef: 'original-duty',
  firstErrorRef: 'error-original', laterErrorRefs: ['error-before-save'], unresolvedOperationRefs: ['operation-pending'] };
const semantics = { goal: 'goal', actions: 'actions', result: 'result', nextStep: 'next' };
const acceptance = { ownerId: 'owner-progress', acceptanceRef: 'accepted-progress', sourceEvidenceRefs: [] };

function ref(record: JournalRecord): JournalCommitRef {
  assert.ok(record.commitId);
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

function v1(relationship: CheckpointReceiptRelationshipV1): NativeSaveIntentV1 {
  const historyKey = { turn: key.turn, checkpoint: key.checkpoint };
  return {
    key, ownerId: 'owner-progress', inputIntentDigest: 'v1-caller-digest',
    recoveryResponsibilityRef: recovery.recoveryResponsibilityRef, rawTurnRefs: ['raw-progress'],
    firstErrorRef: recovery.firstErrorRef, laterErrorRefs: recovery.laterErrorRefs,
    unresolvedOperationRefs: recovery.unresolvedOperationRefs,
    recoveryAssets: { turnId: admitted.turnId, boundaryId: key.boundaryId, captureRef: 'capture-v1' },
    checkpoint: { checkpoint, timeAuthority, previousCheckpointId: null, acceptedAt: committedAt },
    closure: { closureId: 'closure-progress', checkpoint: key.checkpoint, source: 'agent-tool',
      closureSummary: 'closed progress', closureEvidenceRefs: [] },
    contextView: { key: historyKey, accepted: { version: 1, admittedTurn: admitted, checkpoint: relationship,
      acceptance, semantics, adoptedChildren: [], recovery } },
    historyPublication: { key: historyKey, exactLookup: { scope, checkpoint: key.checkpoint, publicationReceiptRef: 'publication-fixture-selector' } },
  };
}

async function v2(segmentId: string, openedCommitRef: JournalCommitRef, authority: JournalCommitRef,
  registration: JournalCommitRef, original: NativeSaveIntentV1): Promise<NativeSegmentSaveIntentV2> {
  const businessTurnRef = { businessTurnId: admitted.turnId, bindingCommitRef: registration,
    execution: { runtimeId: 'progress-runtime', executionEpoch: 1 } };
  const assignment: WorkAssignment = {
    assignmentId: admitted.workAssignmentRef, taskId: scope.taskId, pipelineNodeId: 'progress-node', attempt: 1,
    executionEpoch: 1, inputRevision: 1, objective: 'save progress', targetRefs: [], expectedOutputRefs: [],
    successCriteria: ['saved'], failureCriteria: ['lost'],
    incompleteCriteria: ['pending'], requiredCapabilities: [], mergeGate: 'not-required',
  };
  const source: NativeSegmentSaveSourceV2 = {
    originalAdmittedTurn: admitted, originalBusinessTurnRef: businessTurnRef, openedCommitRef,
    opened: { kind: 'segment-opened', segmentId, businessTurnRef,
      predecessor: { segmentId: admitted.turnId, recoveryAssetsReceiptRef: 'prior-recovery-assets' },
      binding: { businessTurnRef, assignment, execution: businessTurnRef.execution, scope,
        incarnation: { runtimeId: 'progress-runtime', generation: 1, agentInstanceId: 'progress-agent',
          roleId: 'executor', taskId: scope.taskId, assignmentId: admitted.workAssignmentRef, executionEpoch: 1 } },
      authorityCommitRef: authority, businessRegistrationCommitRef: registration,
      requestRef: `request-${segmentId}`, inputIdentity: { requestRef: `request-${segmentId}`, digest: `sha256:${'b'.repeat(64)}` },
    },
  };
  const draft: NativeSegmentSaveIntentV2 = {
    key: { ...key, version: 2, segment: { segmentId, openedCommitRef } }, source,
    ownerId: original.ownerId, inputIntentDigest: '', recoveryResponsibilityRef: original.recoveryResponsibilityRef,
    rawTurnRefs: original.rawTurnRefs, firstErrorRef: original.firstErrorRef,
    laterErrorRefs: original.laterErrorRefs, unresolvedOperationRefs: original.unresolvedOperationRefs,
    checkpoint: original.checkpoint, closure: original.closure,
    recoveryAssets: { source, boundaryId: key.boundaryId, captureRef: `capture-${segmentId}` },
    contextView: { source, acceptance, semantics, adoptedChildren: [], recovery },
  };
  return { ...draft, inputIntentDigest: await nativeSegmentSaveIntentDigestV2(draft) };
}

async function found(port: NativeSaveProgressPort, saveKey: NativeSaveKey): Promise<NativeSaveProgress> {
  const result = await port.readExact(saveKey);
  assert.equal(result.state, 'found');
  if (result.state !== 'found') throw new Error(`expected found: ${JSON.stringify(result)}`);
  return result.progress;
}

async function cold(file: string, keys: readonly NativeSaveKey[]): Promise<{
  readbacks: NativeSaveProgressReadback[]; verification: JournalVerification;
}> {
  const child = spawn(process.execPath, [new URL('./native-save-progress-cold.js', import.meta.url).pathname,
    file, JSON.stringify(keys)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject); child.on('close', resolve);
  });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test('native progress public consumer: shared Journal, exact identity, immutable intent and cold recovery', async () => {
  const root = process.env.HUMANAGENT_TEST_ROOT ?? join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'native-save-progress-'));
  const file = join(dir, 'organ.jsonl');
  try {
    const journal = new JsonlOrganJournal(file);
    const port = createJsonlNativeSaveProgressPort({ journal });
    // One fixture covers mixed-owner retention. Identity isolation and receipts
    // have high impact: a wrong key or fabricated receipt loses recovery duty.
    const foreign = await journal.append({ commitId: 'foreign-owner', kind: 'event', scope, payload: { type: 'foreign-owner', value: 'preserved' } });
    const envelope = { version: 1 as const, identity: await checkpointCommitIdentityV2({ checkpoint }),
      committedAt, timeAuthority, intentDigest: await checkpointIntentDigestV1({ checkpoint, timeAuthority }) };
    const checkpointRecord = await journal.append({ commitId: envelope.identity, kind: 'checkpoint', scope, checkpoint, nativeCheckpointEnvelope: envelope });
    const relationship: CheckpointReceiptRelationshipV1 = { checkpoint, envelope, checkpointSeq: checkpoint.seq,
      journalSeq: checkpointRecord.seq, recordDigest: `sha256:${checkpointRecord.recordDigest.replace(/^sha256:/, '')}`,
      receipt: { commitIdentity: envelope.identity, checkpointRef: checkpoint.id.value,
        journalReceiptRef: checkpointRecord.commitId!, committedAt, timeAuthority } };
    const original = v1(relationship);
    const opened1 = await journal.append({ commitId: 'segment-one-opened', kind: 'event', scope, payload: { type: 'segment-fixture', segmentId: 'segment-one' } });
    const opened2 = await journal.append({ commitId: 'segment-two-opened', kind: 'event', scope, payload: { type: 'segment-fixture', segmentId: 'segment-two' } });
    const segment1 = await v2('segment-one', ref(opened1), ref(foreign), ref(checkpointRecord), original);
    const segment2 = await v2('segment-two', ref(opened2), ref(foreign), ref(checkpointRecord), original);
    const inputs = [original, segment1, segment2];
    const begins = [];
    for (const input of inputs) begins.push(await port.begin(input));
    assert.equal(new Set(begins.map((begin) => begin.commitId)).size, 3, 'v1/version/segment discriminator');
    for (let index = 0; index < inputs.length; index++) {
      const initial = await found(port, inputs[index].key);
      assert.deepEqual(initial.key, inputs[index].key, 'full key survives');
      assert.equal(initial.intentDigest, inputs[index].inputIntentDigest, 'controller digest contract');
      assert.deepEqual(initial.intentCommitRef, begins[index], 'first actual intent receipt');
    }
    const initial = await found(port, segment1.key);
    const phaseRecord = await journal.append({ commitId: 'stage-owner-receipt', kind: 'event', scope, payload: { type: 'stage-owner-fixture' } });
    const progress: NativeSaveProgress = { ...initial,
      phases: initial.phases.map((phase) => phase.phase === 'recovery-assets'
        ? { phase: phase.phase, state: 'committed', receiptRef: phaseRecord.commitId! } : phase),
      laterErrorRefs: [...initial.laterErrorRefs, 'error-later'],
    };
    const progressRef = await port.recordProgress(progress);
    const verification = await journal.verify();
    assert.equal(verification.valid, true);
    for (const receipt of [...begins, progressRef]) {
      const record = verification.records.find((record) => record.commitId === receipt.commitId);
      assert.ok(record);
      assert.deepEqual(receipt, ref(record), 'real commitId/seq/digest triplet');
    }
    const beforeRetry = await readFile(file, 'utf8');
    assert.deepEqual(await port.begin(segment1), begins[1]);
    assert.deepEqual(await port.recordProgress(progress), progressRef);
    assert.equal(await readFile(file, 'utf8'), beforeRetry, 'idempotence appends zero bytes');
    // Changed-input acceptance was possible in the failed draft. Keep the
    // caller digest unchanged to prove the canonical input fingerprint matters.
    await assert.rejects(() => port.begin({ ...segment1, recoveryAssets: { ...segment1.recoveryAssets, captureRef: 'changed-capture' } }),
      (error: unknown) => error instanceof JournalCommitConflictError);
    await assert.rejects(() => port.begin({ ...original, closure: { ...original.closure, closureSummary: 'changed-v1-summary' } }),
      (error: unknown) => error instanceof JournalCommitConflictError);
    assert.equal(await readFile(file, 'utf8'), beforeRetry, 'conflict writes no bytes');
    const coldResult = await cold(file, inputs.map((input) => input.key));
    assert.equal(coldResult.verification.valid, true);
    assert.equal(canonicalJsonStringify(coldResult.verification.records[0]), canonicalJsonStringify(foreign), 'mixed owner retained');
    for (let index = 0; index < inputs.length; index++) {
      const readback = coldResult.readbacks[index];
      assert.equal(readback.state, 'found');
      if (readback.state !== 'found') throw new Error('cold progress absent');
      assert.deepEqual(readback.progress.intentCommitRef, begins[index]);
      assert.deepEqual(readback.progress.key, inputs[index].key);
      assert.equal(readback.progress.firstErrorRef, 'error-original', 'original first error cold retention');
      assert.deepEqual(readback.progress.unresolvedOperationRefs, ['operation-pending']);
    }
    assert.deepEqual(coldResult.readbacks[1], { state: 'found', progress });
    const intents = coldResult.verification.records.filter((record) => record.payload?.type === 'native-save-intent');
    assert.equal(intents.length, 3);
    for (const record of intents) {
      const stored = record.payload?.intent as { recoveryResponsibilityRef: string; rawTurnRefs: string[] };
      assert.equal(stored.recoveryResponsibilityRef, 'original-duty', 'intent recovery duty retained');
      assert.deepEqual(stored.rawTurnRefs, ['raw-progress']);
    }
    // Journal integrity failure must stop replay, rather than mean absent.
    const absent = await port.readExact({ ...key, boundaryId: 'unwritten' });
    assert.deepEqual(absent, { state: 'absent', verifiedThrough: ref(verification.records.at(-1)!) });
    const truncated = join(dir, 'truncated.jsonl');
    await writeFile(truncated, beforeRetry.slice(0, -8), 'utf8');
    assert.equal((await createJsonlNativeSaveProgressPort({ journal: new JsonlOrganJournal(truncated) }).readExact(key)).state, 'unknown');
    assert.equal((await createJsonlNativeSaveProgressPort({ journal: new JsonlOrganJournal(dir) }).readExact(key)).state, 'unknown');
    const undecodable = join(dir, 'undecodable.jsonl');
    const badJournal = new JsonlOrganJournal(undecodable);
    await badJournal.append({ commitId: 'bad-native-carrier', kind: 'event', scope, payload: { type: 'native-save-intent', intent: { version: 1 } } });
    assert.equal((await createJsonlNativeSaveProgressPort({ journal: badJournal }).readExact(key)).state, 'unknown');
    // Two public factories exercise the real held transaction. A lock-outside
    // check would create competing intents; no new transaction framework here.
    const concurrentIntent: NativeSaveIntentV1 = { ...original, key: { ...key, boundaryId: 'concurrent' } };
    const peerPort = createJsonlNativeSaveProgressPort({ journal: new JsonlOrganJournal(file) });
    const [one, two] = await Promise.all([port.begin(concurrentIntent), peerPort.begin(concurrentIntent)]);
    assert.deepEqual(one, two);
    const final = await journal.verify();
    assert.equal(final.records.filter((record) => record.payload?.type === 'native-save-intent').length, 4);
    assert.deepEqual(ref(final.records.at(-1)!), one);
    assert.deepEqual(await port.begin(segment1), begins[1], 'first intent still stable after later owners');
    console.log(`cold process exit=0; journal records=${final.records.length}; owned fixture cleanup=${dir}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
