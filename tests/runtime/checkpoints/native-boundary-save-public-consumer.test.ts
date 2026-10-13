import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  id,
  type AdmittedTurn,
  type AdmittedTurnIdentity,
  type Checkpoint,
  type DurablePhaseOutcome,
  type ScopeRef,
  type WorkAssignment,
} from '../../../packages/contracts/src/index.js';
import type { JournalCommitRef } from '../../../packages/contracts/src/i2-history.js';
import type { TaskRuntimeIncarnation } from '../../../packages/contracts/src/framework.js';
import type {
  NativeSegmentSaveSourceV2,
  OriginalBusinessTurnRef,
  ResumedTurnSegmentOpened,
} from '../../../packages/contracts/src/active-turn-segments.js';
import {
  createNativeBoundarySaveController,
} from '../../../packages/runtime/src/checkpoints/boundary-save.js';
import {
  NATIVE_SAVE_PHASES,
  nativeSegmentSaveIntentDigestV2,
  nativeSegmentSaveKeyDigestV2,
  type NativeSaveIntent,
  type NativeSaveIntentV1,
  type NativeSaveKey,
  type NativeSaveKeyV1,
  type NativeSavePhase,
  type NativeSavePhaseReceipt,
  type NativeSavePorts,
  type NativeSaveProgress,
  type NativeSaveProgressPort,
  type NativeSaveProgressReadback,
  type NativeSaveStagePort,
  type NativeSegmentSaveIntentV2,
  type NativeSegmentSaveKeyV2,
} from '../../../packages/runtime/src/checkpoints/native-save-contract.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const cycle = id('cycle', 'cycle-a');
const scope: ScopeRef = { organId: organ, taskId: task, cycleId: cycle };
const COMMITTED_AT = '2026-10-12T00:00:00.000Z';
const TIME_AUTHORITY = { source: 'harness' as const, owner: 'runtime-checkpoint-control-owner' as const, authorityRef: 'time-authority-a' };

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function turnIdentity(index: 'a' | 'b'): AdmittedTurnIdentity {
  return {
    turnId: `turn-${index}`,
    workAssignmentRef: `assignment-${index}`,
    taskRef: task,
    scopeRef: scope,
    cycleRef: cycle,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: 1,
    runtimeBindingRef: `runtime-binding-${index}`,
    permissionRevision: 'permission-1',
  };
}

function checkpoint(index: 'a' | 'b'): Checkpoint {
  return {
    id: id('checkpoint', `checkpoint-${index}`),
    scope,
    cycleId: cycle,
    seq: index === 'a' ? 1 : 2,
    previousCheckpointId: index === 'a' ? null : id('checkpoint', 'checkpoint-a'),
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'succeeded',
    summary: `save-${index}`,
    recoveryStateRef: { evidenceId: id('evidence', `recovery-${index}`), kind: 'execution', source: 'native-save-test', locator: `recovery://${index}`, scope },
    evidenceRefs: [],
    next: { kind: 'continue' },
  };
}

function key(index: 'a' | 'b'): NativeSaveKeyV1 {
  const checkpointRecord = checkpoint(index);
  return { turn: turnIdentity(index), boundaryId: `boundary-${index}`, checkpoint: { id: checkpointRecord.id, scope: checkpointRecord.scope } };
}

function intent(index: 'a' | 'b', inputIntentDigest = digest(index), firstErrorRef?: string): NativeSaveIntentV1 {
  const saveKey = key(index);
  return {
    key: saveKey,
    ownerId: 'owner-a',
    recoveryResponsibilityRef: `recovery-responsibility:${saveKey.boundaryId}`,
    inputIntentDigest,
    unresolvedOperationRefs: [],
    rawTurnRefs: [`raw-turn:${saveKey.turn.turnId}`],
    ...(firstErrorRef === undefined ? {} : { firstErrorRef }),
    laterErrorRefs: [],
    recoveryAssets: { turnId: saveKey.turn.turnId, boundaryId: saveKey.boundaryId, captureRef: `capture:${saveKey.boundaryId}` },
    checkpoint: { checkpoint: checkpoint(index), timeAuthority: TIME_AUTHORITY, previousCheckpointId: null, acceptedAt: COMMITTED_AT },
    closure: { closureId: `closure:${saveKey.boundaryId}`, checkpoint: saveKey.checkpoint, source: 'agent-tool', closureSummary: `closure:${saveKey.boundaryId}`, closureEvidenceRefs: [] },
    contextView: { key: { turn: saveKey.turn, checkpoint: saveKey.checkpoint }, accepted: null as unknown as NativeSaveIntentV1['contextView']['accepted'] },
    historyPublication: { key: { turn: saveKey.turn, checkpoint: saveKey.checkpoint }, exactLookup: null as unknown as NativeSaveIntentV1['historyPublication']['exactLookup'] },
  };
}

function phaseReceipt(phase: NativeSavePhase, saveIntent: NativeSaveIntent, label: string): NativeSavePhaseReceipt {
  return {
    phase,
    commitIdentity: `${phase}:${saveIntent.key.boundaryId}:${label}`,
    journalReceiptRef: `${phase}-receipt-${saveIntent.key.boundaryId}-${label}`,
    journalSeq: NATIVE_SAVE_PHASES.indexOf(phase) + 1,
    recordDigest: digest(`${phase}:${saveIntent.key.boundaryId}:${label}`),
    committedAt: COMMITTED_AT,
    intentDigest: saveIntent.inputIntentDigest,
    timeAuthority: TIME_AUTHORITY,
  };
}

class StageStore {
  readonly records = new Map<string, NativeSavePhaseReceipt[]>();
  readonly commitCalls = new Map<NativeSavePhase, number>();
  readonly failures = new Map<NativeSavePhase, Error>();
  readonly aliasedReceipts = new Set<NativeSavePhase>();

  seed(saveIntent: NativeSaveIntent, phase: NativeSavePhase, label: string): NativeSavePhaseReceipt {
    const value = phaseReceipt(phase, saveIntent, label);
    const bucket = this.records.get(`${saveIntent.key.boundaryId}:${phase}`) ?? [];
    bucket.push(value);
    this.records.set(`${saveIntent.key.boundaryId}:${phase}`, bucket);
    return value;
  }

  fail(phase: NativeSavePhase, error: Error): void {
    this.failures.set(phase, error);
  }

  port(phase: NativeSavePhase): NativeSaveStagePort {
    return {
      commit: async (candidate) => {
        const failure = this.failures.get(phase);
        if (failure) throw failure;
        this.commitCalls.set(phase, (this.commitCalls.get(phase) ?? 0) + 1);
        const value = phaseReceipt(phase, candidate, 'commit');
        const bucket = this.records.get(`${candidate.key.boundaryId}:${phase}`) ?? [];
        bucket.push(value);
        this.records.set(`${candidate.key.boundaryId}:${phase}`, bucket);
        return value;
      },
      readExact: async (candidate) => {
        const bucket = this.records.get(`${candidate.key.boundaryId}:${phase}`) ?? [];
        return bucket.find((value) => value.intentDigest === candidate.inputIntentDigest) ?? null;
      },
    };
  }

  ports(): NativeSavePorts {
    return {
      'recovery-assets': this.port('recovery-assets'),
      checkpoint: this.port('checkpoint'),
      closure: this.port('closure'),
      'context-view': this.port('context-view'),
      'history-publication': this.port('history-publication'),
    };
  }
}

class MemoryProgressPort implements NativeSaveProgressPort {
  private latest: NativeSaveProgress | null = null;
  failWhenCommittedPhases: number | null = null;
  unknownRecoveryRef: string | null = null;

  seed(progress: NativeSaveProgress): void {
    this.latest = progress;
  }

  async begin(saveIntent: NativeSaveIntent): Promise<{ commitId: string; journalSeq: number; recordDigest: string }> {
    if (this.latest && this.latest.key.boundaryId === saveIntent.key.boundaryId) {
      return this.latest.intentCommitRef;
    }
    const reference = { commitId: `progress:${saveIntent.key.boundaryId}`, journalSeq: 1, recordDigest: digest(saveIntent.inputIntentDigest) };
    this.latest = {
      intentCommitRef: reference,
      key: saveIntent.key,
      intentDigest: saveIntent.inputIntentDigest,
      phases: [],
      ...(saveIntent.firstErrorRef === undefined ? {} : { firstErrorRef: saveIntent.firstErrorRef }),
      laterErrorRefs: saveIntent.laterErrorRefs,
      unresolvedOperationRefs: saveIntent.unresolvedOperationRefs,
    };
    return reference;
  }

  async readExact(saveKey: NativeSaveKey): Promise<NativeSaveProgressReadback> {
    if (this.unknownRecoveryRef !== null) return { state: 'unknown', recoveryRef: this.unknownRecoveryRef };
    if (!this.latest || this.latest.key.boundaryId !== saveKey.boundaryId) return { state: 'absent', verifiedThrough: null };
    return { state: 'found', progress: this.latest };
  }

  async recordProgress(progress: NativeSaveProgress): Promise<{ commitId: string; journalSeq: number; recordDigest: string }> {
    const committed = progress.phases.filter((phase) => phase.state === 'committed').length;
    if (this.failWhenCommittedPhases !== null && committed >= this.failWhenCommittedPhases) {
      throw new Error('progress journal append not acknowledged');
    }
    this.latest = progress;
    return { commitId: `progress:${progress.key.boundaryId}`, journalSeq: committed + 1, recordDigest: digest(progress.intentDigest) };
  }
}

test('S1: closure failure keeps the committed prefix, records the first error, and leaves later phases not-executed', async () => {
  const store = new StageStore();
  store.fail('closure', new Error('closure owner rejected the record'));
  const saveIntent = intent('a');
  const controller = createNativeBoundarySaveController(new MemoryProgressPort(), store.ports());

  const result = await controller.run(saveIntent);

  assert.equal(result.state, 'hold');
  if (result.state !== 'hold') return;
  assert.equal(result.reason, 'save-incomplete');
  assert.equal(result.firstErrorRef.includes('closure'), true);
  assert.deepEqual(result.durablePhases.map((phase) => [phase.phase, phase.state]), [
    ['recovery-assets', 'committed'],
    ['checkpoint', 'committed'],
    ['closure', 'failed'],
    ['context-view', 'not-executed'],
    ['history-publication', 'not-executed'],
  ]);
  assert.equal(store.records.get('boundary-a:closure'), undefined);
  assert.equal(store.records.get('boundary-a:context-view'), undefined);
  assert.equal(store.records.get('boundary-a:history-publication'), undefined);

  // A newly failed phase must not replace an original first error already carried by the intent.
  const preserveStore = new StageStore();
  preserveStore.fail('closure', new Error('closure failed after the original error'));
  const preserveIntent = intent('a', digest('a'), 'error-original');
  const preserved = await createNativeBoundarySaveController(new MemoryProgressPort(), preserveStore.ports()).run(preserveIntent);
  assert.equal(preserved.state, 'hold');
  if (preserved.state !== 'hold') return;
  assert.equal(preserved.firstErrorRef, 'error-original');
  assert.equal(preserved.progress.firstErrorRef, 'error-original');
  assert.equal(preserved.progress.laterErrorRefs.length, 1);
  assert.equal(preserved.progress.laterErrorRefs[0]!.includes('closure'), true);
});

test('S2: a lost progress acknowledgement cold-reenters through the exact owner record and never commits a second phase record', async () => {
  const store = new StageStore();
  const saveIntent = intent('a');

  const interrupted = new MemoryProgressPort();
  interrupted.failWhenCommittedPhases = 2;
  const first = await createNativeBoundarySaveController(interrupted, store.ports()).run(saveIntent);
  assert.equal(first.state, 'persistence-unconfirmed');
  if (first.state !== 'persistence-unconfirmed') return;
  assert.equal(first.unconfirmedReceipt.phase, 'checkpoint');
  assert.equal(store.records.get('boundary-a:checkpoint')?.length, 1);

  const recovered = await createNativeBoundarySaveController(new MemoryProgressPort(), store.ports()).run(saveIntent);
  assert.equal(recovered.state, 'complete');
  assert.equal(store.commitCalls.get('checkpoint'), 1);
  assert.equal(store.records.get('boundary-a:checkpoint')?.length, 1);
});

test('S3: exact A recovery ignores a later B, rejects a conflicting intent, and refuses to alias view and publication receipts', async () => {
  const store = new StageStore();
  const a = intent('a');
  const b = intent('b');
  store.seed(a, 'recovery-assets', 'original');
  const aCheckpoint = store.seed(a, 'checkpoint', 'original');
  store.seed(b, 'checkpoint', 'later');

  const controller = createNativeBoundarySaveController(new MemoryProgressPort(), store.ports());
  const recoveredA = await controller.run(a);
  assert.equal(recoveredA.state, 'complete');
  if (recoveredA.state !== 'complete') return;
  assert.equal(recoveredA.outcome.checkpointReceipt?.checkpointRef, aCheckpoint.journalReceiptRef);
  assert.equal(recoveredA.outcome.checkpointReceipt?.checkpointRef !== 'checkpoint-receipt-boundary-b-later', true);
  assert.equal(recoveredA.readiness, 'pending-owner-facts');
  assert.deepEqual(recoveredA.outcome.rawTurnRefs, a.rawTurnRefs);

  const conflicting = new MemoryProgressPort();
  const aProgress = await controller.run(a);
  assert.equal(aProgress.state, 'complete');
  if (aProgress.state !== 'complete') return;
  conflicting.seed(aProgress.progress);
  const conflictError = await rejectionOf(() => createNativeBoundarySaveController(conflicting, store.ports()).run(intent('a', digest('changed-intent'))));
  assert.equal(conflictError instanceof Error && conflictError.message.includes('intent conflict'), true);

  const aliasingStore = new StageStore();
  for (const phase of NATIVE_SAVE_PHASES) aliasingStore.seed(a, phase, 'shared');
  aliasingStore.records.set('boundary-a:history-publication', [
    { ...phaseReceipt('history-publication', a, 'shared'), journalReceiptRef: aliasingStore.records.get('boundary-a:context-view')![0]!.journalReceiptRef },
  ]);
  const aliasError = await rejectionOf(() => createNativeBoundarySaveController(new MemoryProgressPort(), aliasingStore.ports()).run(a));
  assert.equal(aliasError instanceof Error && aliasError.message.includes('alias'), true);

  // Durable progress with an original first error must survive into a completed boundary outcome.
  const completedStore = new StageStore();
  const completedIntent = intent('b', digest('b'), 'error-original');
  for (const phase of NATIVE_SAVE_PHASES) completedStore.seed(completedIntent, phase, 'original');
  const completedProgress = new MemoryProgressPort();
  completedProgress.seed({
    intentCommitRef: { commitId: 'progress:boundary-b', journalSeq: 1, recordDigest: digest(completedIntent.inputIntentDigest) },
    key: completedIntent.key,
    intentDigest: completedIntent.inputIntentDigest,
    phases: [],
    firstErrorRef: 'error-original',
    laterErrorRefs: [],
    unresolvedOperationRefs: [],
  });
  const completed = await createNativeBoundarySaveController(completedProgress, completedStore.ports()).run(completedIntent);
  assert.equal(completed.state, 'complete');
  if (completed.state !== 'complete') return;
  assert.equal(completed.outcome.firstErrorRef, 'error-original');
  assert.equal(completed.outcome.recoveryRef, completedIntent.recoveryResponsibilityRef);
  assert.equal(completedStore.commitCalls.size, 0);

  // Later errors on the same durable progress must survive alongside the original first error.
  const laterStore = new StageStore();
  const laterIntent = intent('a', digest('a'), 'error-original');
  for (const phase of NATIVE_SAVE_PHASES) laterStore.seed(laterIntent, phase, 'original');
  const laterProgress = new MemoryProgressPort();
  laterProgress.seed({
    intentCommitRef: { commitId: 'progress:boundary-a', journalSeq: 1, recordDigest: digest(laterIntent.inputIntentDigest) },
    key: laterIntent.key,
    intentDigest: laterIntent.inputIntentDigest,
    phases: [],
    firstErrorRef: 'error-original',
    laterErrorRefs: ['error-later'],
    unresolvedOperationRefs: [],
  });
  const later = await createNativeBoundarySaveController(laterProgress, laterStore.ports()).run(laterIntent);
  assert.equal(later.state, 'complete');
  if (later.state !== 'complete') return;
  assert.equal(later.outcome.firstErrorRef, 'error-original');
  assert.deepEqual(later.outcome.laterErrorRefs, ['error-later']);
  assert.equal(later.outcome.recoveryRef, laterIntent.recoveryResponsibilityRef);

  // Fresh progress built from an intent must inherit the intent's original first error.
  const unknownProgress = new MemoryProgressPort();
  unknownProgress.unknownRecoveryRef = 'recovery-unknown';
  const unknown = await createNativeBoundarySaveController(unknownProgress, new StageStore().ports()).run(intent('b', digest('b'), 'error-original'));
  assert.equal(unknown.state, 'hold');
  if (unknown.state !== 'hold') return;
  assert.equal(unknown.reason, 'progress-unknown');
  assert.equal(unknown.progress.firstErrorRef, 'error-original');
});

const segmentAdmittedTurn: AdmittedTurn = {
  turnId: 'turn-segment',
  workAssignmentRef: 'assignment-segment',
  taskRef: task,
  scopeRef: scope,
  cycleRef: cycle,
  inputRevision: 1,
  directiveRevision: 1,
  executionEpoch: 1,
  runtimeBindingRef: 'runtime-binding-segment',
  permissionRevision: 'permission-1',
  admissionEvidenceRefs: [],
  currentTurnRef: 'current-segment',
  recoveryStateRef: 'recovery-segment',
};

const segmentAssignment: WorkAssignment = {
  assignmentId: 'assignment-segment',
  taskId: task,
  pipelineNodeId: 'node-segment',
  attempt: 1,
  executionEpoch: 1,
  inputRevision: 1,
  objective: 'resume the same business turn on a new epoch',
  targetRefs: [],
  expectedOutputRefs: [],
  acceptanceCriteriaDigest: digest('segment-criteria'),
  successCriteria: ['resumed'],
  failureCriteria: ['lost'],
  incompleteCriteria: ['pending'],
  requiredCapabilities: [],
  mergeGate: 'not-required',
};

const segmentOriginalRef: OriginalBusinessTurnRef = {
  businessTurnId: 'turn-segment',
  bindingCommitRef: { commitId: 'binding-segment', journalSeq: 3, recordDigest: digest('binding-segment') },
  execution: { runtimeId: 'runtime-segment', executionEpoch: 1 },
};

function segmentCheckpoint(epoch: number): Checkpoint {
  return {
    id: id('checkpoint', `segment-checkpoint-e${epoch}`),
    scope,
    cycleId: cycle,
    seq: epoch,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: epoch,
    outcome: 'succeeded',
    summary: `segment-save-e${epoch}`,
    recoveryStateRef: { evidenceId: id('evidence', `segment-recovery-e${epoch}`), kind: 'execution', source: 'native-save-test', locator: `recovery://segment-e${epoch}`, scope },
    evidenceRefs: [],
    next: { kind: 'continue' },
  };
}

function segmentOpened(segmentId: string, epoch: number): {
  readonly opened: ResumedTurnSegmentOpened;
  readonly openedCommitRef: JournalCommitRef;
} {
  const openedCommitRef: JournalCommitRef = { commitId: `opened-${segmentId}`, journalSeq: 10 + epoch, recordDigest: digest(`opened-${segmentId}`) };
  const incarnation: TaskRuntimeIncarnation = {
    runtimeId: 'runtime-segment',
    generation: epoch,
    agentInstanceId: `agent-instance-${epoch}`,
    roleId: 'role-executor',
    taskId: task,
    assignmentId: 'assignment-segment',
    executionEpoch: epoch,
  };
  const opened: ResumedTurnSegmentOpened = {
    kind: 'segment-opened',
    segmentId,
    businessTurnRef: segmentOriginalRef,
    predecessor: { segmentId: 'turn-segment', recoveryAssetsReceiptRef: 'receipt-initial' },
    binding: {
      businessTurnRef: segmentOriginalRef,
      assignment: segmentAssignment,
      execution: { runtimeId: 'runtime-segment', executionEpoch: epoch },
      incarnation,
      scope,
    },
    authorityCommitRef: { commitId: `grant-${segmentId}`, journalSeq: 5, recordDigest: digest(`grant-${segmentId}`) },
    businessRegistrationCommitRef: { commitId: `registration-${segmentId}`, journalSeq: 6, recordDigest: digest(`registration-${segmentId}`) },
    requestRef: `request-${segmentId}`,
    inputIdentity: { requestRef: `request-${segmentId}`, digest: digest(`identity-${segmentId}`) },
  };
  return { opened, openedCommitRef };
}

function segmentSaveKey(
  segment: { readonly opened: ResumedTurnSegmentOpened; readonly openedCommitRef: JournalCommitRef },
  boundaryId: string,
  checkpointRecord: Checkpoint,
): NativeSegmentSaveKeyV2 {
  const turn = segmentAdmittedTurn;
  return {
    version: 2,
    turn: {
      turnId: turn.turnId,
      workAssignmentRef: turn.workAssignmentRef,
      taskRef: turn.taskRef,
      scopeRef: turn.scopeRef,
      cycleRef: turn.cycleRef,
      inputRevision: turn.inputRevision,
      directiveRevision: turn.directiveRevision,
      executionEpoch: turn.executionEpoch,
      runtimeBindingRef: turn.runtimeBindingRef,
      permissionRevision: turn.permissionRevision,
    },
    segment: { segmentId: segment.opened.segmentId, openedCommitRef: segment.openedCommitRef },
    boundaryId,
    checkpoint: { id: checkpointRecord.id, scope: checkpointRecord.scope },
  };
}

function segmentIntentDraft(
  segment: { readonly opened: ResumedTurnSegmentOpened; readonly openedCommitRef: JournalCommitRef },
  boundaryId: string,
  captureRef: string,
): NativeSegmentSaveIntentV2 {
  const checkpointRecord = segmentCheckpoint(segment.opened.binding.execution.executionEpoch);
  const source: NativeSegmentSaveSourceV2 = {
    originalAdmittedTurn: segmentAdmittedTurn,
    originalBusinessTurnRef: segmentOriginalRef,
    opened: segment.opened,
    openedCommitRef: segment.openedCommitRef,
  };
  const saveKey = segmentSaveKey(segment, boundaryId, checkpointRecord);
  return {
    key: saveKey,
    source,
    ownerId: 'owner-segment',
    recoveryResponsibilityRef: `recovery-responsibility:${boundaryId}`,
    inputIntentDigest: '',
    unresolvedOperationRefs: [],
    rawTurnRefs: [`raw-turn:${segment.opened.segmentId}`],
    laterErrorRefs: [],
    recoveryAssets: { source, boundaryId, captureRef },
    checkpoint: { checkpoint: checkpointRecord, timeAuthority: TIME_AUTHORITY, previousCheckpointId: null, acceptedAt: COMMITTED_AT },
    closure: { closureId: `closure:${boundaryId}`, checkpoint: saveKey.checkpoint, source: 'agent-tool', closureSummary: `closure:${boundaryId}`, closureEvidenceRefs: [] },
    contextView: {
      source,
      acceptance: { ownerId: 'owner-segment', acceptanceRef: `acceptance:${boundaryId}`, sourceEvidenceRefs: [] },
      semantics: { goal: 'goal', actions: 'actions', result: 'result', nextStep: 'next' },
      adoptedChildren: [],
      recovery: { recoveryStateRef: 'recovery-segment', recoveryResponsibilityRef: `recovery-responsibility:${boundaryId}`, unresolvedOperationRefs: [], laterErrorRefs: [] },
    },
  };
}

async function signedSegmentIntent(
  segment: { readonly opened: ResumedTurnSegmentOpened; readonly openedCommitRef: JournalCommitRef },
  boundaryId: string,
  captureRef: string,
): Promise<NativeSegmentSaveIntentV2> {
  const draft = segmentIntentDraft(segment, boundaryId, captureRef);
  return { ...draft, inputIntentDigest: await nativeSegmentSaveIntentDigestV2(draft) };
}

test('P1: two current segments on one boundary keep distinct v2 keys, and a changed intent conflicts with zero phase writes', async () => {
  const boundary = 'boundary-shared';
  const s1 = segmentOpened('segment-e2', 2);
  const s2 = segmentOpened('segment-e3', 3);

  // Hold the checkpoint constant so only the segment identity can keep the two
  // v2 keys distinct; a per-epoch checkpoint id would confound this assertion.
  const sharedCheckpoint = segmentCheckpoint(2);
  const k1 = segmentSaveKey(s1, boundary, sharedCheckpoint);
  const k2 = segmentSaveKey(s2, boundary, sharedCheckpoint);
  assert.equal(k1.boundaryId, k2.boundaryId, 'both segments share the same boundary string');
  const k1Digest = await nativeSegmentSaveKeyDigestV2(k1);
  const k2Digest = await nativeSegmentSaveKeyDigestV2(k2);
  assert.equal(k1Digest === k2Digest, false, 'the segment id and opened commit keep the two v2 keys distinct');

  const first = await signedSegmentIntent(s1, boundary, 'capture-1');
  const changed = await signedSegmentIntent(s1, boundary, 'capture-changed');
  assert.equal(first.key.segment.segmentId, changed.key.segment.segmentId);
  assert.equal(first.inputIntentDigest === changed.inputIntentDigest, false, 'a changed pre-save input changes the intent digest');

  const progress = new MemoryProgressPort();
  const completed = await createNativeBoundarySaveController(progress, new StageStore().ports()).run(first);
  assert.equal(completed.state, 'complete');

  const conflictStore = new StageStore();
  const conflict = await rejectionOf(() => createNativeBoundarySaveController(progress, conflictStore.ports()).run(changed));
  assert.equal(conflict instanceof Error && conflict.message.includes('intent conflict'), true);
  assert.equal(conflictStore.commitCalls.size, 0, 'the conflicting retry commits no phase record');
});

test('P2: a wrong source or a stale checkpoint epoch is rejected before any progress or phase write', async () => {
  const boundary = 'boundary-shared';
  const s1 = segmentOpened('segment-e2', 2);
  const s2 = segmentOpened('segment-e3', 3);
  const valid = await signedSegmentIntent(s1, boundary, 'capture-1');

  const tripwire: NativeSaveProgressPort = {
    async begin() { throw new Error('begin must not be called for an invalid segment intent'); },
    async readExact() { throw new Error('readExact must not be called for an invalid segment intent'); },
    async recordProgress() { throw new Error('recordProgress must not be called for an invalid segment intent'); },
  };

  const wrongSource = { ...valid, source: { ...valid.source, opened: s2.opened, openedCommitRef: s2.openedCommitRef } } as NativeSegmentSaveIntentV2;
  const wrongSourceError = await rejectionOf(() => createNativeBoundarySaveController(tripwire, new StageStore().ports()).run(wrongSource));
  assert.equal(wrongSourceError instanceof Error && wrongSourceError.message.includes('segment does not match the source opened record'), true);

  const staleCheckpoint: Checkpoint = { ...segmentCheckpoint(2), executionEpoch: 3 };
  const staleEpoch = { ...valid, checkpoint: { ...valid.checkpoint, checkpoint: staleCheckpoint } } as NativeSegmentSaveIntentV2;
  const staleError = await rejectionOf(() => createNativeBoundarySaveController(tripwire, new StageStore().ports()).run(staleEpoch));
  assert.equal(staleError instanceof Error && staleError.message.includes('checkpoint epoch does not match the current segment epoch'), true);
});

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}
