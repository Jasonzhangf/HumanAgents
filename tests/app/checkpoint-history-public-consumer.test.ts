import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type AdmittedTurn, type WorkAssignment, type PreparedRecoveryCapture,
  type Checkpoint, type ContextHistoryRecord, type EvidenceRef,
  type CheckpointReceiptRelationshipV1, type JournalCommitRef,
  type ScopeRef, type TaskIdentityScope } from '../../packages/contracts/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { createJsonlActiveTurnJournal } from '../../packages/adapters/jsonl/src/active-turn.js';
import { JsonlOperationCompletionJournal } from '../../packages/adapters/jsonl/src/operation-completion.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { ActiveTurnContext } from '../../packages/runtime/src/context/active-turn-context.js';
import { contextViewIdentityV1, projectAdmittedTurnIdentityV1 } from '../../packages/runtime/src/context/semantic-history.js';
import { commitSemanticContextViewV1, commitSemanticHistoryPublicationV1 } from '../../packages/runtime/src/checkpoints/semantic-history.js';
import { buildConditionalReentry } from '../../packages/runtime/src/checkpoints/conditional-reentry.js';
import { admitTaskGrantBusiness } from '../../packages/runtime/src/admission/task-grant.js';
import { durableContextDigest, produceContextHistory } from '../../packages/runtime/src/checkpoints/coordinator.js';
import { prepareCheckpointClosure, type DeadEndRecord } from '../../packages/runtime/src/checkpoints/closure.js';
import { commitDeadEnd, submitCheckpoint } from '../../packages/runtime/src/checkpoints/submission.js';
import { createJsonlCheckpointJournal, createJsonlCheckpointClosurePort, createJsonlSemanticHistoryJournal,
  createJsonlSemanticHistoryReader, createJsonlContextHistoryPort, commitConditionalTransitionRecord } from '../../packages/app/src/checkpoint-journal.js';
import type { OperationControlSelector } from '../../packages/runtime/src/gateway/ports.js';
import { createJsonlOperationControlJournal } from '../../packages/app/src/operation-control-journal.js';
import { createNativeRecoveryAssets } from '../../packages/app/src/native-recovery-assets.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { readColdCurrentFromJournal, readCurrentFromRecords } from '../../packages/app/src/ui-runtime/reentry-current-facts.js';
import { createCheckpointHistoryReader } from '../../packages/app/src/ui-runtime/checkpoint-history.js';

// Failure modes/cost are recorded in the accepted plan §6 and r4 note before this test.
// Real public writers produce every persistence receipt. No model or operation is started.
const fixtureRoot = join(homedir(), '.humanagent', 'test-fixtures', 'ux-checkpoint-history-c1-r3');
const organId = id('organ', 'checkpoint-history-organ');
const taskId = id('task', 'checkpoint-history-task');
const taskScope: TaskIdentityScope = { organId, taskId };
const cycleId = id('cycle', 'checkpoint-history-cycle');
const scope: ScopeRef = { ...taskScope, cycleId };
const runtimeId = 'checkpoint-history-runtime';
const epoch = 4;
const at = '2026-10-15T02:00:00.000Z';
const owner = 'checkpoint-history-consumer';

function evidence(label: string, actualScope = scope): EvidenceRef {
  return { evidenceId: id('evidence', label), kind: 'operation', source: owner,
    locator: `humanagent://checkpoint-history/${label}`, scope: actualScope };
}

function contextRecord(): ContextHistoryRecord {
  const ref = { checkpointId: id('checkpoint', 'context-loop'), digest: 'loop-digest' };
  const watermark = { streamId: 'history-stream', sequence: 0 };
  const observationScopeId = 'history-observation';
  const durableContext = { stablePrefix: ['instructions'], indexRefs: ['index'],
    dynamicHead: ['accepted reasoning'], repairRefs: [] };
  return { kind: 'context-history', schemaVersion: 1, scope, agentRuntimeId: runtimeId,
    contextView: { contextViewRef: 'context-original', executionEpoch: epoch, checkpoint: ref,
      contextDigest: 'context-refs', activeRefs: ['accepted-prefix'], omittedRefs: ['older-view'] },
    loopCheckpoint: { ...ref, sequence: 1, predecessor: null, executionEpoch: epoch,
      eventWatermark: watermark, observationScopeId, contextViewRef: 'context-original' },
    replacement: null, previousContextCommitRef: null, durableContext,
    durableContextDigest: durableContextDigest(durableContext),
    loopControl: { mode: 'observation', transitionSeq: 1, observationScopeId, observationScope: null,
      inboxStreamId: watermark.streamId, inboxExecutionEpoch: epoch, inboxCheckpoint: ref,
      inboxObservationScopeId: observationScopeId, inboxWatermark: 0, handledEventIds: [],
      handledBatchKeys: [], deltaExecutionEpoch: epoch, deltaCheckpoint: ref,
      deltaObservationScopeId: observationScopeId, deltaWatermark: watermark,
      appliedDeltaIds: [], appliedDeltaKeys: [], closedObservationScopeIds: [],
      budgetUsage: { modeTransitions: 1, observationScopes: 1, contextReplacements: 0, deferredEvents: 0 } } };
}

function checkpoint(seq: number, previous: Checkpoint | null): Checkpoint {
  return { id: id('checkpoint', `checkpoint-history-${seq}`), scope, cycleId, seq,
    previousCheckpointId: previous?.id ?? null, directiveRevision: 1, executionEpoch: epoch,
    outcome: 'waiting', summary: `checkpoint ${seq}`, recoveryStateRef: evidence(`recovery-${seq}`),
    evidenceRefs: [evidence(`settled-${seq}`)], next: { kind: 'wait', ref: 'history-owner' } };
}

async function fixture(associations = false) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'consumer-'));
  const filePath = join(root, 'organ.jsonl');
  const journal = new JsonlOrganJournal(filePath);
  const grants = new JsonlTaskGrantJournal(journal);
  const control = createJsonlOperationControlJournal({ journal });
  const history = createJsonlContextHistoryPort({ filePath, journal });
  const checkpoints = createJsonlCheckpointJournal({ filePath, journal });
  const closures = createJsonlCheckpointClosurePort({ filePath, journal });
  const capability = { actionId: 'checkpoint.save', capabilities: ['provider.execution'], scope: taskScope };
  await grants.grant({ requestId: 'history-grant', taskId, owner, capability, expectedRevision: 0 });
  const request = { requestRef: 'history-business', taskId, owner, capability,
    inputIdentity: { requestRef: 'history-business', digest: 'history-fixture-intent' } };
  const admitted = await admitTaskGrantBusiness({ port: grants, request, principalOwner: owner,
    register: async (authority, registration) => ({ authority, registrationCommitRef:
      await registration.registerBusiness({ ...request, grantRevision: authority.grant.revision }) }) });
  const selector = { scope, agentRuntimeId: runtimeId, harnessExecutionEpoch: epoch };
  await control.initializeCoverage({ ...selector, admissionCommitRef: admitted.registrationCommitRef });
  const context = contextRecord();
  const contextCommit = await produceContextHistory(history, { record: context, expectedCurrentContextCommitRef: null });
  const turn: AdmittedTurn = { turnId: 'history-turn', workAssignmentRef: 'history-assignment',
    taskRef: taskId, scopeRef: scope, cycleRef: cycleId, inputRevision: 1, directiveRevision: 1,
    executionEpoch: epoch, runtimeBindingRef: runtimeId, permissionRevision: admitted.authority.permissionRevision,
    admissionEvidenceRefs: [admitted.registrationCommitRef.commitId], currentTurnRef: 'active-turn://history-turn',
    recoveryStateRef: 'history-recovery' };
  const assignment: WorkAssignment = { assignmentId: turn.workAssignmentRef, taskId,
    pipelineNodeId: 'history-node', attempt: 1, executionEpoch: epoch, inputRevision: 1,
    objective: 'read checkpoint history', targetRefs: [], expectedOutputRefs: [],
    successCriteria: ['exact read'],
    failureCriteria: [], incompleteCriteria: [], requiredCapabilities: [], mergeGate: 'not-required' };
  const activeTurnJournal = createJsonlActiveTurnJournal({ filePath, turnId: turn.turnId });
  const artifactsRoot = join(root, 'artifacts');
  const nativeAssets = createNativeRecoveryAssets({ journalPath: filePath, journal, assetRoot: artifactsRoot,
    completionJournal: new JsonlOperationCompletionJournal({ journal }) });
  let captureReceipt;
  if (associations) {
    const active = await ActiveTurnContext.open({ journal: activeTurnJournal,
      binding: { admittedTurn: turn, assignment, execution: { runtimeId, executionEpoch: epoch }, scope },
      currentTurnRef: turn.currentTurnRef });
    const initialInput = await nativeAssets.writeInitialInput({ scope, turnId: turn.turnId, rawInput: 'read history' });
    await active.registerInitialInput(initialInput);
    const body = await active.prepareCapture({ pauseId: 'history-boundary', frozenAt: at,
      initialInput, checkpointPath: [], completionRefs: [] });
    const prepared: PreparedRecoveryCapture = { body, controlRecordCount: active.controlRecordCount(),
      producerDrains: [], completionLookups: [], recovery: { commitIdentity: 'history-hold', laterErrorRefs: [],
        rawTurnRefs: [turn.currentTurnRef], unresolvedOperationRefs: [], stages: [], durablePhases: [],
        durableReceiptRefs: [], recoveryResponsibilityRef: 'history-owner' } };
    captureReceipt = await nativeAssets.commitCapturePhase({ turnId: turn.turnId,
      boundaryId: body.cut.pauseId, prepared });
  }
  const a = checkpoint(1, null);
  const timeAuthority = { source: 'harness' as const, owner: 'runtime-checkpoint-control-owner' as const, authorityRef: 'history-clock',
    sampleCommittedAt: async () => at };
  const nativeA = await checkpoints.commitNativeCheckpoint({ ownerId: owner, checkpoint: a, timeAuthority });
  const preparation = await prepareCheckpointClosure({ checkpoint: a, source: 'harness-control',
    closureReason: 'empty operation boundary', contextCommitRef: contextCommit.commitRef, contextHistory: history,
    operationSelector: selector, operationControl: await control.readControl(selector),
    permission: { permissionRevision: admitted.authority.permissionRevision,
      grantCommitRef: admitted.authority.commit, revoked: false },
    hardBlockers: [], unreturnedCallRefs: [], unresolvedOperationRefs: [], closurePort: closures,
    now: () => new Date(at) });
  await submitCheckpoint({ ownerId: owner, source: 'harness-control', checkpoint: a, previous: null,
    journal: checkpoints, closurePort: closures, preparation,
    ...(captureReceipt === undefined ? {} : { turnRecoveryRef: captureReceipt.commitIdentity }) });
  const recordA = await checkpoints.readCommitted(scope, a.id);
  if (recordA === null) throw new Error('A exact readback missing');
  const bindingA = await checkpoints.readCheckpointRecoveryBinding(taskScope, recordA.commitRef);
  const positionA = await checkpoints.readExecutionPosition(taskScope);
  if (bindingA === null || positionA === null) throw new Error('A bound position missing');
  const b = checkpoint(2, a);
  await checkpoints.commitNativeCheckpoint({ ownerId: owner, checkpoint: b, timeAuthority });
  const recordB = await checkpoints.readCommitted(scope, b.id);
  if (recordB === null) throw new Error('B exact readback missing');
  // Reconstruct ports to consume persisted facts, with no shared in-memory writer state.
  const readerCheckpoints = createJsonlCheckpointJournal({ filePath });
  const reader = createCheckpointHistoryReader({ checkpoints: readerCheckpoints,
    contexts: createJsonlContextHistoryPort({ filePath }), native: readerCheckpoints });
  const input = { scope: { kind: 'task' as const, projectKey: 'history-consumer', mode: 'fake' as const, taskId }, taskScope,
    list: { cursor: String(recordA.commitRef.journalSeq), limit: 1 } };
  return { root, filePath, journal, reader, readerCheckpoints, checkpoints, closures, grants, control,
    history, admitted, context, contextCommit, a, b, nativeA, recordA, recordB, bindingA, positionA, input,
    turn, activeTurnJournal, artifactsRoot, nativeAssets, captureReceipt, timeAuthority, preparation };
}

test('public Journal consumer resolves cycle A independently of history page and keeps bound current', async () => {
  const f = await fixture();
  const bytes = await readFile(f.filePath, 'utf8');
  const files = await fileSnapshot(f.root);
  const position = await f.readerCheckpoints.readExecutionPosition(taskScope);
  const viewed = await f.reader.read({ ...f.input, viewed: { checkpointId: f.a.id } });
  if (!viewed.ok) throw new Error(`${viewed.failure.code}: ${viewed.failure.message}`);
  assert.deepEqual(viewed.value.viewed?.identity.commitRef, f.recordA.commitRef);
  assert.equal(viewed.value.current.state, 'known');
  if (viewed.value.current.state !== 'known') throw new Error('current is unknown');
  assert.deepEqual(viewed.value.current.position.checkpointCommitRef, f.recordA.commitRef);
  assert.deepEqual(viewed.value.current.identity.commitRef, f.recordA.commitRef);
  assert.deepEqual(viewed.value.current.position.contextCommitRef, f.contextCommit.commitRef);
  assert.equal(viewed.value.current.context.state, 'known');
  assert.deepEqual(viewed.value.checkpoints.map((item) => item.commitRef), [f.recordB.commitRef]);
  const receiptOnly = await f.reader.read({ ...f.input, list: { limit: 1, executionEpoch: 999 },
    viewed: { commitRef: f.recordA.commitRef } });
  if (!receiptOnly.ok) throw new Error(receiptOnly.failure.message);
  assert.deepEqual(receiptOnly.value.viewed?.identity.commitRef, f.recordA.commitRef);
  assert.deepEqual(receiptOnly.value.checkpoints, []);
  const following = await f.reader.read(f.input);
  if (!following.ok) throw new Error(following.failure.message);
  assert.deepEqual(following.value.viewed?.identity.commitRef, f.recordA.commitRef);
  assert.deepEqual(following.value.viewed?.context, viewed.value.viewed?.context);
  assert.equal(following.value.viewed?.context.state, 'known');
  if (following.value.viewed?.context.state !== 'known') throw new Error('historical Context unavailable');
  assert.equal(following.value.viewed.context.durableContextDigest, f.context.durableContextDigest);
  assert.deepEqual(following.value.viewed.context.activeRefs, f.context.contextView.activeRefs);
  assert.equal(following.value.viewed.identity.committedAt, f.nativeA.envelope.committedAt);
  assert.equal(following.value.viewed.semantic.state, 'unavailable');
  assert.equal(following.value.viewed.capture.state, 'unavailable');
  assert.equal(await readFile(f.filePath, 'utf8'), bytes);
  assert.deepEqual(await f.readerCheckpoints.readExecutionPosition(taskScope), position);
  assert.deepEqual(await fileSnapshot(f.root), files);
});

test('public owners supply semantic/capture references and a distinct effective epoch without changing viewed history', async () => {
  const f = await fixture(true);
  const store = new ImmutableAssetStore(f.artifactsRoot);
  const rawContent = { read: async ({ content }: Parameters<Parameters<typeof createJsonlSemanticHistoryJournal>[0]['rawContent']['read']>[0]) => store.readEvidence(content.ref) };
  const semanticWriter = createJsonlSemanticHistoryJournal({ filePath: f.filePath, artifactsRoot: f.artifactsRoot,
    activeTurnJournal: f.activeTurnJournal, rawContent, timeAuthority: f.timeAuthority });
  const semantics = { goal: 'keep exact history', actions: 'read committed records', result: 'A stays current', nextStep: 'inspect A' };
  const view = await commitSemanticContextViewV1({ port: semanticWriter, accepted: { version: 1,
    admittedTurn: f.turn, checkpoint: f.nativeA, acceptance: { ownerId: owner,
      acceptanceRef: 'history-semantic-accepted', sourceEvidenceRefs: [evidence('semantic-accepted')] },
    semantics, adoptedChildren: [], recovery: { recoveryStateRef: f.turn.recoveryStateRef,
      recoveryResponsibilityRef: 'history-owner', unresolvedOperationRefs: [], laterErrorRefs: [] } } });
  const turn = projectAdmittedTurnIdentityV1(f.turn);
  const publication = await commitSemanticHistoryPublicationV1({ port: semanticWriter, ownerId: owner, turn,
    checkpoint: f.nativeA, contextView: { identity: await contextViewIdentityV1({ turn, checkpoint: f.a }), receipt: view } });
  const semantic = createJsonlSemanticHistoryReader({ filePath: f.filePath, artifactsRoot: f.artifactsRoot,
    activeTurnJournalFor: (turnId) => createJsonlActiveTurnJournal({ filePath: f.filePath, turnId }), rawContent });
  assert.deepEqual(await semantic.listCompletedTurnLookups(taskScope), []);
  assert.equal((await semantic.listCompletedTurnLookups(scope)).length, 1);
  if (f.captureReceipt === undefined) throw new Error('capture receipt missing');
  const capture = await f.nativeAssets.readRecoveryAssetsExact(f.captureReceipt.commitIdentity);
  const reader = createCheckpointHistoryReader({ checkpoints: f.readerCheckpoints,
    contexts: createJsonlContextHistoryPort({ filePath: f.filePath }), native: f.readerCheckpoints,
    semantic, capture: f.nativeAssets });
  const bytes = await readFile(f.filePath, 'utf8');
  const files = await fileSnapshot(f.root);
  const result = await reader.read(f.input);
  if (!result.ok) throw new Error(result.failure.message);
  const detail = result.value.viewed;
  if (detail === null || detail.semantic.state !== 'known' || detail.capture.state !== 'known') {
    throw new Error(`associated detail unavailable: ${JSON.stringify(detail)}`);
  }
  assert.deepEqual(detail.semantic.semantics, semantics);
  assert.equal(detail.semantic.savedAt, f.nativeA.envelope.committedAt);
  assert.deepEqual(detail.semantic.save.checkpoint, { commitIdentity: f.nativeA.receipt.commitIdentity,
    checkpointRef: f.nativeA.receipt.checkpointRef, journalReceiptRef: f.nativeA.receipt.journalReceiptRef,
    journalSeq: f.nativeA.journalSeq, recordDigest: f.nativeA.recordDigest,
    committedAt: f.nativeA.envelope.committedAt, timeAuthority: f.nativeA.envelope.timeAuthority });
  assert.deepEqual(detail.semantic.save.contextView, view);
  assert.deepEqual(detail.semantic.save.historyPublication, publication);
  assert.deepEqual(detail.capture.capture, capture.receipt.capture);
  assert.equal(detail.capture.controlRecordCount, capture.prepared.controlRecordCount);
  assert.equal(detail.capture.turnRecoveryRef, f.captureReceipt.commitIdentity);
  const noCapture = createCheckpointHistoryReader({ checkpoints: f.readerCheckpoints,
    contexts: f.history, semantic });
  const unavailable = await noCapture.read(f.input);
  if (!unavailable.ok) throw new Error(unavailable.failure.message);
  assert.equal(unavailable.value.viewed?.capture.state, 'unavailable');
  const noVersion = await f.reader.read(f.input);
  if (!noVersion.ok) throw new Error(noVersion.failure.message);
  assert.equal(noVersion.value.viewed?.capture.state, 'unavailable');
  if (noVersion.value.viewed?.capture.state !== 'unavailable') throw new Error('capture version was invented');
  assert.match(noVersion.value.viewed.capture.reason, /version is unavailable/);
  assert.deepEqual(noVersion.value.viewed.recoveryBinding, detail.recoveryBinding);
  assert.equal(await readFile(f.filePath, 'utf8'), bytes);
  assert.deepEqual(await fileSnapshot(f.root), files);
  assert.deepEqual(await f.readerCheckpoints.readExecutionPosition(taskScope), f.positionA);

  await createJsonlRuntimeTaskCurrentStateJournal({ journal: f.journal }).commit({
    transitionId: 'history-current-state', taskScope, expectedStateCommitRef: null,
    state: { task: { id: taskId, organId, title: 'history fixture', directive: 'read history',
      directiveRevision: 1, state: 'running', memoryScope: 'task' },
      processing: { entryPhase: 'executing', nextAction: f.a.next, hardBlockers: [],
        recoveryResponsibilityRef: 'history-owner', laterErrorRefs: [], stages: [] },
      retainedDuties: [], sourceCommitRefs: [] } });
  const current = readCurrentFromRecords(await f.journal.replay(), taskScope);
  if (current.state !== 'known') throw new Error(current.reason);
  // The same committed checkpoint fixture, read through the cold-current entry,
  // must delegate to the unchanged reader and wrap it as the checkpoint-bound
  // branch. It must never fall through to an initial open turn.
  const cold = await readColdCurrentFromJournal(f.journal, {
    allocation: { runtimeId: f.turn.runtimeBindingRef, taskId, operationId: id('operation', 'checkpoint-history-operation'),
      executionEpoch: epoch, assignmentId: f.turn.workAssignmentRef, scope, inputRefs: [], ownerId: owner,
      directiveRevision: 1, inputRevision: 1, orchestrated: false },
    businessTurnId: f.turn.turnId,
  }, owner);
  assert.equal(cold.state, 'known');
  if (cold.state !== 'known') throw new Error(`cold current unknown: ${cold.reason}`);
  assert.equal(cold.kind, 'checkpoint-bound');
  if (cold.kind !== 'checkpoint-bound') throw new Error(`cold current selected ${cold.kind}`);
  assert.deepEqual(cold.current, current);
  const control = await f.control.readControl({ scope: taskScope });
  if (control.state !== 'complete') throw new Error(control.reason);
  const relation = buildConditionalReentry({ command: { commandId: 'history-reentry', taskScope,
    targetCheckpointCommitRef: f.recordA.commitRef, expectedCurrentControlCommitRef: current.position.controlCommitRef,
    expectedExecutionEpoch: current.position.executionEpoch, expectedOperationControlCommitRef: control.currentControlCommitRef,
    expectedGrantCommitRef: f.admitted.authority.commit, permissionRevision: f.admitted.authority.permissionRevision,
    confirmationRef: 'history-fixture-confirmed-command', principalOwner: owner }, targetScope: scope,
    targetContext: f.context, targetClosure: f.bindingA.coreClosure, sourceContextCommitRef: f.contextCommit.commitRef,
    sourceClosureRef: f.preparation.checkpointClosureId, current, maxExecutionEpoch: epoch });
  await f.closures.commit(relation);
  const reentryBytes = await readFile(f.filePath, 'utf8');
  const reentryFiles = await fileSnapshot(f.root);
  const position = await f.readerCheckpoints.readExecutionPosition(taskScope);
  const after = await reader.read(f.input);
  if (!after.ok || after.value.current.state !== 'known') throw new Error('reentered current unavailable');
  assert.deepEqual(after.value.current.identity.commitRef, f.recordA.commitRef);
  assert.equal(after.value.current.identity.originalExecutionEpoch, epoch);
  assert.equal(after.value.current.position.effectiveExecutionEpoch, epoch + 1);
  assert.deepEqual(after.value.current.position.checkpointCommitRef, f.recordA.commitRef);
  if (after.value.current.context.state !== 'known') throw new Error('effective Context unavailable');
  assert.equal(after.value.current.context.executionEpoch, epoch + 1);
  assert.equal(after.value.current.context.contextViewRef, relation.restoredContext.contextView.contextViewRef);
  assert.deepEqual(after.value.viewed?.context, detail.context);
  assert.deepEqual(after.value.viewed?.identity, detail.identity);
  assert.equal(await readFile(f.filePath, 'utf8'), reentryBytes);
  assert.deepEqual(await fileSnapshot(f.root), reentryFiles);
  assert.deepEqual(await f.readerCheckpoints.readExecutionPosition(taskScope), position);
});

test('public checkpoint identities reject unknown and mismatched receipts and disambiguate equal IDs across cycles', async () => {
  const f = await fixture();
  const otherCycle = id('cycle', 'history-other-cycle');
  const otherScope = { ...taskScope, cycleId: otherCycle };
  const duplicate: Checkpoint = { ...f.a, scope: otherScope, cycleId: otherCycle,
    recoveryStateRef: evidence('other-recovery', otherScope), evidenceRefs: [evidence('other-settled', otherScope)] };
  await f.checkpoints.commitNativeCheckpoint({ ownerId: owner, checkpoint: duplicate, timeAuthority: f.timeAuthority });
  const other = await f.checkpoints.readCommitted(otherScope, duplicate.id);
  if (other === null) throw new Error('duplicate scope checkpoint missing');
  const before = await readFile(f.filePath, 'utf8');
  const files = await fileSnapshot(f.root);
  const position = await f.readerCheckpoints.readExecutionPosition(taskScope);
  const ambiguous = await f.reader.read({ ...f.input, viewed: { checkpointId: f.a.id } });
  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok) throw new Error('ambiguous ID accepted');
  assert.equal(ambiguous.failure.code, 'checkpoint-history.viewed-ambiguous');
  const selected = await f.reader.read({ ...f.input, viewed: { checkpointId: f.a.id, commitRef: other.commitRef } });
  if (!selected.ok || selected.value.current.state !== 'known') throw new Error('exact duplicate selection failed');
  assert.deepEqual(selected.value.viewed?.identity.commitRef, other.commitRef);
  assert.deepEqual(selected.value.current.identity.commitRef, f.recordA.commitRef);
  const unknown = await f.reader.read({ ...f.input, viewed: { checkpointId: id('checkpoint', 'uncommitted') } });
  if (unknown.ok) throw new Error('uncommitted target accepted');
  assert.equal(unknown.failure.code, 'checkpoint-history.viewed-unknown');
  const wrongDigest = await f.reader.read({ ...f.input, viewed: { commitRef: { ...f.recordA.commitRef,
    recordDigest: `sha256:${'0'.repeat(64)}` } } });
  if (wrongDigest.ok) throw new Error('wrong digest accepted');
  assert.equal(wrongDigest.failure.code, 'checkpoint-history.viewed-receipt-mismatch');
  const wrongSeq = await f.reader.read({ ...f.input, viewed: { commitRef: { ...f.recordA.commitRef,
    journalSeq: f.recordA.commitRef.journalSeq + 1 } } });
  if (wrongSeq.ok) throw new Error('wrong physical sequence accepted');
  assert.equal(wrongSeq.failure.code, 'checkpoint-history.viewed-receipt-mismatch');
  const wrongId = await f.reader.read({ ...f.input, viewed: { checkpointId: f.b.id, commitRef: f.recordA.commitRef } });
  if (wrongId.ok) throw new Error('ID/receipt mismatch accepted');
  assert.equal(wrongId.failure.code, 'checkpoint-history.viewed-receipt-mismatch');
  const partial = await f.reader.read({ ...f.input, viewed: {} });
  if (partial.ok) throw new Error('partial target accepted');
  assert.equal(partial.failure.code, 'checkpoint-history.viewed-partial');
  const foreignTask = id('task', 'history-foreign-task');
  const foreignInput = { ...f.input, scope: { ...f.input.scope, taskId: foreignTask },
    taskScope: { organId, taskId: foreignTask } };
  const foreign = await f.reader.read({ ...foreignInput, viewed: { commitRef: f.recordA.commitRef } });
  if (foreign.ok) throw new Error('foreign receipt accepted');
  assert.equal(foreign.failure.code, 'checkpoint-history.viewed-receipt-mismatch');
  const unknownCurrent = await f.reader.read(foreignInput);
  if (!unknownCurrent.ok) throw new Error(unknownCurrent.failure.message);
  assert.equal(unknownCurrent.value.current.state, 'unknown');
  assert.equal(unknownCurrent.value.viewed, null);
  assert.deepEqual(unknownCurrent.value.checkpoints, []);
  assert.equal(await readFile(f.filePath, 'utf8'), before);
  assert.deepEqual(await fileSnapshot(f.root), files);
  assert.deepEqual(await f.readerCheckpoints.readExecutionPosition(taskScope), position);
});

test('active reasoning lineage follows bound closures across rewind and forward while UI history stays complete', async () => {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'lineage-'));
  const filePath = join(root, 'organ.jsonl');
  const journal = new JsonlOrganJournal(filePath);
  const grants = new JsonlTaskGrantJournal(journal);
  const control = createJsonlOperationControlJournal({ journal });
  const history = createJsonlContextHistoryPort({ filePath, journal });
  const checkpoints = createJsonlCheckpointJournal({ filePath, journal });
  const closures = createJsonlCheckpointClosurePort({ filePath, journal });
  const currentStates = createJsonlRuntimeTaskCurrentStateJournal({ journal });
  const capability = { actionId: 'checkpoint.save', capabilities: ['provider.execution'], scope: taskScope };
  await grants.grant({ requestId: 'lineage-grant', taskId, owner, capability, expectedRevision: 0 });
  const request = { requestRef: 'lineage-business', taskId, owner, capability,
    inputIdentity: { requestRef: 'lineage-business', digest: 'lineage-fixture-intent' } };
  const admitted = await admitTaskGrantBusiness({ port: grants, request, principalOwner: owner,
    register: async (authority, registration) => ({ authority, registrationCommitRef:
      await registration.registerBusiness({ ...request, grantRevision: authority.grant.revision }) }) });
  const selectorAt = (harnessExecutionEpoch: number): OperationControlSelector =>
    ({ scope, agentRuntimeId: runtimeId, harnessExecutionEpoch });
  await control.initializeCoverage({ ...selectorAt(epoch), admissionCommitRef: admitted.registrationCommitRef });
  const context = contextRecord();
  const contextCommit = await produceContextHistory(history, { record: context, expectedCurrentContextCommitRef: null });
  const turnAt = (executionEpoch: number): AdmittedTurn => ({ turnId: 'history-turn',
    workAssignmentRef: 'history-assignment', taskRef: taskId, scopeRef: scope, cycleRef: cycleId,
    inputRevision: 1, directiveRevision: 1, executionEpoch, runtimeBindingRef: runtimeId,
    permissionRevision: admitted.authority.permissionRevision,
    admissionEvidenceRefs: [admitted.registrationCommitRef.commitId], currentTurnRef: 'active-turn://history-turn',
    recoveryStateRef: 'history-recovery' });
  const activeTurnJournal = createJsonlActiveTurnJournal({ filePath, turnId: 'history-turn' });
  const artifactsRoot = join(root, 'artifacts');
  const store = new ImmutableAssetStore(artifactsRoot);
  const timeAuthority = { source: 'harness' as const, owner: 'runtime-checkpoint-control-owner' as const,
    authorityRef: 'lineage-clock', sampleCommittedAt: async () => at };
  const semantic = createJsonlSemanticHistoryJournal({ filePath, artifactsRoot, activeTurnJournal,
    rawContent: { read: async ({ content }) => store.readEvidence(content.ref) }, timeAuthority });
  const checkpointAt = (seq: number, previous: Checkpoint | null, executionEpoch: number): Checkpoint => ({
    id: id('checkpoint', `checkpoint-history-${seq}`), scope, cycleId, seq,
    previousCheckpointId: previous?.id ?? null, directiveRevision: 1, executionEpoch,
    outcome: 'waiting', summary: `checkpoint ${seq}`, recoveryStateRef: evidence(`recovery-${seq}`),
    evidenceRefs: [evidence(`settled-${seq}`)], next: { kind: 'wait', ref: 'history-owner' } });
  // Every bound closure uses the real public preparation and submission writers.
  async function bind(checkpoint: Checkpoint, previous: Checkpoint | null,
    contextCommitRef: JournalCommitRef, harnessExecutionEpoch: number) {
    const native = await checkpoints.commitNativeCheckpoint({ ownerId: owner, checkpoint, timeAuthority });
    const preparation = await prepareCheckpointClosure({ checkpoint, source: 'harness-control',
      closureReason: 'lineage bound checkpoint', contextCommitRef, contextHistory: history,
      operationSelector: selectorAt(harnessExecutionEpoch),
      operationControl: await control.readControl(selectorAt(harnessExecutionEpoch)),
      permission: { permissionRevision: admitted.authority.permissionRevision,
        grantCommitRef: admitted.authority.commit, revoked: false },
      hardBlockers: [], unreturnedCallRefs: [], unresolvedOperationRefs: [], closurePort: closures,
      now: () => new Date(at) });
    await submitCheckpoint({ ownerId: owner, source: 'harness-control', checkpoint, previous,
      journal: checkpoints, closurePort: closures, preparation });
    const record = await checkpoints.readCommitted(scope, checkpoint.id);
    if (record === null) throw new Error(`bound checkpoint ${checkpoint.id.value} readback missing`);
    const binding = await checkpoints.readCheckpointRecoveryBinding(taskScope, record.commitRef);
    if (binding === null) throw new Error(`bound checkpoint ${checkpoint.id.value} binding missing`);
    return { native, record, binding, preparation };
  }
  async function publish(label: string, checkpoint: Checkpoint,
    relationship: CheckpointReceiptRelationshipV1, executionEpoch: number) {
    const admittedTurn = turnAt(executionEpoch);
    const turn = projectAdmittedTurnIdentityV1(admittedTurn);
    const view = await commitSemanticContextViewV1({ port: semantic, accepted: { version: 1,
      admittedTurn, checkpoint: relationship, acceptance: { ownerId: owner,
        acceptanceRef: `lineage-acceptance-${label}`, sourceEvidenceRefs: [evidence(`lineage-acceptance-${label}`)] },
      semantics: { goal: `goal ${label}`, actions: `actions ${label}`, result: `result ${label}`,
        nextStep: `next ${label}` }, adoptedChildren: [],
      recovery: { recoveryStateRef: admittedTurn.recoveryStateRef, recoveryResponsibilityRef: 'history-owner',
        unresolvedOperationRefs: [], laterErrorRefs: [] } } });
    const publication = await commitSemanticHistoryPublicationV1({ port: semantic, ownerId: owner, turn,
      checkpoint: relationship,
      contextView: { identity: await contextViewIdentityV1({ turn, checkpoint }), receipt: view } });
    return { view, publication };
  }
  const c1 = checkpointAt(1, null, epoch);
  const bound1 = await bind(c1, null, contextCommit.commitRef, epoch);
  const p1 = await publish('p1', c1, bound1.native, epoch);
  // Supported native writers key checkpoint identity by id and scope and compare
  // the full intent digest, so a second payload under the same id/scope is rejected
  // before it can produce an impersonating semantic publication. The selector-level
  // counterexample is therefore UNVERIFIED; this assertion records the producer guard.
  const conflictingCheckpoint: Checkpoint = { ...c1, summary: `${c1.summary} conflicting` };
  await assert.rejects(
    () => checkpoints.commitNativeCheckpoint({ ownerId: owner, checkpoint: conflictingCheckpoint, timeAuthority }),
    (error: unknown) => (error as { readonly code?: string }).code === 'checkpoint-native-conflict',
  );
  const c2 = checkpointAt(2, c1, epoch);
  const bound2 = await bind(c2, c1, contextCommit.commitRef, epoch);
  const p2 = await publish('p2', c2, bound2.native, epoch);
  const deadEnd: DeadEndRecord = { deadEndRef: 'dead-end:displaced-branch', scope,
    failedPathRefs: ['business-ref:dead-path'], conclusion: 'the displaced branch failed',
    invalidatedAssumptions: ['assumption-x'], evidenceRefs: [evidence('dead-end-displaced')] };
  await commitDeadEnd({ ownerId: owner, record: deadEnd, closurePort: closures });
  const omittedDeadEnd: DeadEndRecord = { deadEndRef: 'older-view', scope,
    failedPathRefs: ['business-ref:omitted-path'], conclusion: 'the omitted path failed',
    invalidatedAssumptions: ['assumption-y'], evidenceRefs: [evidence('omitted-dead-end')] };
  await commitDeadEnd({ ownerId: owner, record: omittedDeadEnd, closurePort: closures });
  await currentStates.commit({ transitionId: 'lineage-current-state', taskScope,
    expectedStateCommitRef: null, state: { task: { id: taskId, organId, title: 'lineage fixture',
      directive: 'read lineage', directiveRevision: 1, state: 'running', memoryScope: 'task' },
      processing: { entryPhase: 'executing', nextAction: c2.next, hardBlockers: [],
        recoveryResponsibilityRef: 'history-owner', laterErrorRefs: [], stages: [] },
      retainedDuties: [], sourceCommitRefs: [] } });
  // Chronological ledger before any rewind: C1 -> C2 with P1, P2 published.
  assert.deepEqual((await semantic.listCompletedTurnLookups(scope)).map((entry) => entry.checkpoint.id.value),
    [c1.id.value, c2.id.value]);
  const forwardLineage = await semantic.selectActiveReasoningLineage(scope);
  assert.deepEqual(forwardLineage.priorCompletedTurns.map((entry) => entry.checkpoint.id.value),
    [c1.id.value, c2.id.value]);
  // Rewind to C1 and bind a new C3 whose chronological predecessor is still C2.
  const beforeRewind = readCurrentFromRecords(await journal.replay(), taskScope);
  if (beforeRewind.state !== 'known') throw new Error(beforeRewind.reason);
  const controlBefore = await control.readControl(selectorAt(beforeRewind.position.executionEpoch));
  if (controlBefore.state !== 'complete') throw new Error(controlBefore.reason);
  const rewind = buildConditionalReentry({ command: { commandId: 'lineage-rewind-to-c1', taskScope,
    targetCheckpointCommitRef: bound1.record.commitRef,
    expectedCurrentControlCommitRef: beforeRewind.position.controlCommitRef,
    expectedExecutionEpoch: beforeRewind.position.executionEpoch,
    expectedOperationControlCommitRef: controlBefore.currentControlCommitRef,
    expectedGrantCommitRef: admitted.authority.commit, permissionRevision: admitted.authority.permissionRevision,
    confirmationRef: 'lineage-rewind-confirmed', principalOwner: owner }, targetScope: scope,
    targetContext: context, targetClosure: bound1.binding.coreClosure,
    sourceContextCommitRef: contextCommit.commitRef, sourceClosureRef: bound1.preparation.closureId,
    current: beforeRewind, maxExecutionEpoch: epoch });
  const rewindRef = await commitConditionalTransitionRecord({ journal, record: rewind,
    expectedCurrentControlCommitRef: beforeRewind.position.controlCommitRef });
  const rewoundEpoch = rewind.newExecutionEpoch;
  await control.initializeCoverage({ ...selectorAt(rewoundEpoch), admissionCommitRef: rewindRef });
  const c3 = checkpointAt(3, c2, rewoundEpoch);
  const bound3 = await bind(c3, c2, rewindRef, rewoundEpoch);
  const p3 = await publish('p3', c3, bound3.native, rewoundEpoch);
  assert.deepEqual(bound3.record.checkpoint.previousCheckpointId, c2.id);
  // UI history inspection still sees every committed publication in Journal order.
  assert.deepEqual((await semantic.listCompletedTurnLookups(scope)).map((entry) => entry.checkpoint.id.value),
    [c1.id.value, c2.id.value, c3.id.value]);
  const rewoundLineage = await semantic.selectActiveReasoningLineage(scope);
  assert.deepEqual(rewoundLineage.priorCompletedTurns.map((entry) => entry.checkpoint.id.value),
    [c1.id.value, c3.id.value]);
  assert.deepEqual(rewoundLineage.priorCompletedTurns.map((entry) => entry.publicationReceiptRef),
    [p1.publication.journalReceiptRef, p3.publication.journalReceiptRef]);
  assert.deepEqual(rewoundLineage.activeExecutionPosition?.checkpointCommitRef, bound3.record.commitRef);
  assert.deepEqual(rewoundLineage.activeContextRecord?.contextView.activeRefs,
    rewind.restoredContext.contextView.activeRefs);
  // A verified dead end whose evidence the active wrong refs did not exclude stays a conclusion;
  // the explicitly omitted deadEndRef does not come back.
  assert.deepEqual(rewoundLineage.verifiedDeadEnds.map((entry) => entry.deadEndRef), [deadEnd.deadEndRef]);
  // Forward reentry to C2 restores the displaced branch and drops P3.
  const beforeForward = readCurrentFromRecords(await journal.replay(), taskScope);
  if (beforeForward.state !== 'known') throw new Error(beforeForward.reason);
  const controlForward = await control.readControl(selectorAt(beforeForward.position.executionEpoch));
  if (controlForward.state !== 'complete') throw new Error(controlForward.reason);
  const forward = buildConditionalReentry({ command: { commandId: 'lineage-forward-to-c2', taskScope,
    targetCheckpointCommitRef: bound2.record.commitRef,
    expectedCurrentControlCommitRef: beforeForward.position.controlCommitRef,
    expectedExecutionEpoch: beforeForward.position.executionEpoch,
    expectedOperationControlCommitRef: controlForward.currentControlCommitRef,
    expectedGrantCommitRef: admitted.authority.commit, permissionRevision: admitted.authority.permissionRevision,
    confirmationRef: 'lineage-forward-confirmed', principalOwner: owner }, targetScope: scope,
    targetContext: context, targetClosure: bound2.binding.coreClosure,
    sourceContextCommitRef: rewindRef, sourceClosureRef: bound3.preparation.closureId,
    current: beforeForward, maxExecutionEpoch: rewoundEpoch });
  await commitConditionalTransitionRecord({ journal, record: forward,
    expectedCurrentControlCommitRef: beforeForward.position.controlCommitRef });
  const forwardLineage2 = await semantic.selectActiveReasoningLineage(scope);
  assert.deepEqual(forwardLineage2.priorCompletedTurns.map((entry) => entry.checkpoint.id.value),
    [c1.id.value, c2.id.value]);
  assert.deepEqual((await semantic.listCompletedTurnLookups(scope)).map((entry) => entry.checkpoint.id.value),
    [c1.id.value, c2.id.value, c3.id.value]);
  assert.deepEqual(forwardLineage2.activeExecutionPosition?.checkpointCommitRef, bound2.record.commitRef);

  // A publication with the same checkpoint id but a different cycle and payload
  // cannot satisfy the active bound payload. The real native publication writer
  // accepts the other-cycle checkpoint because its scope and turn differ; the
  // selector must reject it by canonical payload instead of joining on id alone.
  const otherCycle = id('cycle', 'history-other-cycle');
  const otherScope: ScopeRef = { ...taskScope, cycleId: otherCycle };
  const duplicate: Checkpoint = { ...c1, scope: otherScope, cycleId: otherCycle,
    recoveryStateRef: evidence('other-recovery', otherScope),
    evidenceRefs: [evidence('other-settled', otherScope)] };
  const duplicateNative = await checkpoints.commitNativeCheckpoint({ ownerId: owner,
    checkpoint: duplicate, timeAuthority });
  const otherAdmittedTurn: AdmittedTurn = { ...turnAt(epoch), scopeRef: otherScope, cycleRef: otherCycle };
  const otherTurn = projectAdmittedTurnIdentityV1(otherAdmittedTurn);
  const otherView = await commitSemanticContextViewV1({ port: semantic, accepted: { version: 1,
    admittedTurn: otherAdmittedTurn, checkpoint: duplicateNative, acceptance: { ownerId: owner,
      acceptanceRef: 'lineage-acceptance-other-cycle',
      sourceEvidenceRefs: [evidence('lineage-acceptance-other-cycle', otherScope)] },
    semantics: { goal: 'goal other', actions: 'actions other', result: 'result other',
      nextStep: 'next other' }, adoptedChildren: [],
    recovery: { recoveryStateRef: otherAdmittedTurn.recoveryStateRef,
      recoveryResponsibilityRef: 'history-owner', unresolvedOperationRefs: [], laterErrorRefs: [] } } });
  await commitSemanticHistoryPublicationV1({ port: semantic, ownerId: owner, turn: otherTurn,
    checkpoint: duplicateNative,
    contextView: { identity: await contextViewIdentityV1({ turn: otherTurn, checkpoint: duplicate }),
      receipt: otherView } });
  await assert.rejects(
    () => semantic.selectActiveReasoningLineage(otherScope),
    (error: unknown) => (error as { readonly code?: string }).code
      === 'checkpoint-active-reasoning-lineage-binding-mismatch',
  );
});

async function fileSnapshot(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    try {
      await readFile(path, 'utf8');
      paths.push(path);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EISDIR') throw error;
      paths.push(...await fileSnapshot(path));
    }
  }
  return paths;
}
