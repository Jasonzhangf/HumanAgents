import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ContextHistoryRecord, type JournalCommitRef, type ScopeRef, type WorkAssignment } from '../../../packages/contracts/src/index.js';
import { validateContextHistoryRecord } from '../../../packages/contracts/src/agent-loop.js';
import { validateResumedTurnSegmentOpened, type ResumedTurnSegmentOpened } from '../../../packages/contracts/src/active-turn-segments.js';
import { JsonlOrganJournal, type JournalRecord } from '../../../packages/adapters/jsonl/src/index.js';
import { AgentLoopRuntime, type AgentLoopStartRequest } from '../../../packages/runtime/src/agent-loop/runtime.js';
import type { ContextHistoryPort } from '../../../packages/runtime/src/checkpoints/ports.js';

const fixtureRoot = join(homedir(), '.humanagent', 'test-fixtures', 'provider-cold-incarnation-handoff-r1-20261013');
const scope: ScopeRef = { organId: id('organ', 'cold-organ'), taskId: id('task', 'cold-task'), cycleId: id('cycle', 'cold-cycle'), operationId: id('operation', 'cold-operation') };

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function receipt(row: JournalRecord): JournalCommitRef {
  if (!row.commitId) throw new Error('fixture record lacks commit identity');
  return { commitId: row.commitId, journalSeq: row.seq, recordDigest: row.recordDigest };
}

function decodeContext(row: JournalRecord): ContextHistoryRecord {
  // Decode the physical JSON boundary, then run the actual typed contract validator.
  const record: ContextHistoryRecord = JSON.parse(JSON.stringify(row.payload?.context));
  validateContextHistoryRecord(record);
  assert.deepEqual(record.scope, row.scope);
  return record;
}

/** Only Journal semantics are controlled; runtime preparation and installation are real. */
class PhysicalContextHistory implements ContextHistoryPort {
  readonly commits: { readonly runtime: string; readonly expected: JournalCommitRef | null; readonly ref: JournalCommitRef }[] = [];
  readonly reads: JournalCommitRef[] = [];
  constructor(readonly journal: JsonlOrganJournal) {}

  async commit(record: ContextHistoryRecord, expected: JournalCommitRef | null): Promise<JournalCommitRef> {
    validateContextHistoryRecord(record);
    const row = await this.journal.transaction(({ records }) => {
      const tail = records.filter((entry) => entry.payload?.kind === 'context-history'
        && entry.payload.agentRuntimeId === record.agentRuntimeId
        && JSON.stringify(entry.scope) === JSON.stringify(record.scope)).at(-1);
      assert.deepEqual(expected, tail ? receipt(tail) : null, 'target runtime CAS must use its actual head');
      assert.deepEqual(record.previousContextCommitRef, expected, 'context chain must use the same runtime head');
      return record;
    }, async (candidate, append) => append({
      kind: 'event', scope: candidate.scope,
      commitId: `context:${candidate.agentRuntimeId}:${hash(candidate).slice(7)}`,
      payload: { kind: 'context-history', agentRuntimeId: candidate.agentRuntimeId, context: candidate },
    }));
    const ref = receipt(row);
    this.commits.push({ runtime: record.agentRuntimeId, expected, ref });
    return ref;
  }

  async readContextCommit(queryScope: ScopeRef, ref: JournalCommitRef): Promise<ContextHistoryRecord> {
    const row = await this.journal.findByCommitId(ref.commitId);
    if (!row) throw new Error('exact context commit is missing');
    assert.deepEqual(receipt(row), ref);
    assert.deepEqual(row.scope, queryScope);
    this.reads.push(ref);
    return decodeContext(row);
  }

  async readContextHistory(query: Parameters<ContextHistoryPort['readContextHistory']>[0]): Promise<Awaited<ReturnType<ContextHistoryPort['readContextHistory']>>> {
    const verification = await this.journal.verify();
    assert.equal(verification.valid, true);
    const rows = verification.records.filter((row) => row.payload?.kind === 'context-history'
      && row.payload.agentRuntimeId === query.agentRuntimeId
      && JSON.stringify(row.scope) === JSON.stringify(query.scope));
    const records = rows.slice(-query.limit).map(decodeContext);
    return { views: records.map((record) => record.contextView), replacements: records.flatMap((record) => record.replacement ? [record.replacement] : []), currentContextCommitRef: rows.length ? receipt(rows[rows.length - 1]!) : null };
  }
}

function request(): AgentLoopStartRequest {
  return {
    agentRuntimeId: 'cold-old-runtime', role: 'orchestration', mode: 'observation', scope, executionEpoch: 1,
    permissionRevision: 'historical-permission', observationStreamId: 'cold-stream', now: () => new Date('2026-10-13T00:00:00.000Z'),
    profiles: [{ profileId: 'cold-observer', role: 'orchestration', mode: 'observation', observationScopes: ['task'], observationCapabilities: ['read-task'], orchestrationScope: 'project', orchestrationCapabilities: [], capabilityDigest: 'sha256:cold-profile' }],
    budget: { maxModeTransitions: 2, maxObservationScopes: 4, maxContextReplacements: 4, maxDeferredEvents: 2 },
    activeRefs: ['task:goal'], omittedRefs: ['raw:old'],
    durableContext: { stablePrefix: [{ goal: 'same business turn' }], indexRefs: [{ ref: 'index:task' }], dynamicHead: [{ fact: 'accepted tool result' }], repairRefs: [{ responsibility: 'recover:original', unresolvedOperationRefs: ['operation:pending'], firstErrorRef: 'error:first' }] },
    turn: {
      identity: { turnId: 'cold-business-turn', workAssignmentRef: 'cold-assignment', taskRef: id('task', 'cold-task'), scopeRef: scope, cycleRef: id('cycle', 'cold-cycle'), inputRevision: 1, directiveRevision: 1, executionEpoch: 1, runtimeBindingRef: 'cold-old-binding', permissionRevision: 'historical-permission' },
      cycleId: id('cycle', 'cold-cycle'), directiveRevision: 1, ownerId: 'original-turn-owner',
      journal: {
        verify: async () => { throw new Error('handoff must not run checkpoint closure'); },
        readLatest: async () => { throw new Error('handoff must not run turn recovery'); },
        append: async () => { throw new Error('handoff must not admit another business turn'); },
        readCommitted: async () => { throw new Error('unexpected checkpoint read'); },
        listCommitted: async () => { throw new Error('unexpected checkpoint list'); },
        readExecutionPosition: async () => { throw new Error('unexpected canonical fold'); },
        readCheckpointRecoveryBinding: async () => { throw new Error('unexpected recovery binding read'); },
      },
      closurePort: { commit: async () => { throw new Error('unexpected closure commit'); }, read: async () => { throw new Error('unexpected closure read'); } },
    },
  };
}

test('public incarnation handoff preserves the exact same-turn context with a fresh runtime CAS and lease', async () => {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'consumer-'));
  console.log(`incarnation fixture: ${root}`);
  const journal = new JsonlOrganJournal(join(root, 'organ.jsonl'));
  const port = new PhysicalContextHistory(journal);
  const original = request();
  const loop = await AgentLoopRuntime.start(original, port);
  const actor = () => ({ agentRuntimeId: loop.snapshot().modeState.agentRuntimeId, leaseId: loop.snapshot().lease.leaseId });
  const historicalActors = [actor()];
  await loop.openObservationScope({ actor: actor(), kind: 'task', scope, readableRefs: ['task:goal'], capabilities: ['read-task'] });
  historicalActors.push(actor());
  const beforeBatch = loop.snapshot();
  await loop.mergeObservationBatch(actor(), { batchId: 'batch-1', observationScopeId: beforeBatch.modeState.observationScopeId, executionEpoch: 1, baseCheckpoint: beforeBatch.modeState.checkpoint, eventClass: 'observation', priority: 'normal', watermark: { streamId: 'cold-stream', sequence: 1 }, eventIds: ['event-1'], eventSequences: [1], correlationRefs: ['task:goal'], idempotencyKey: 'batch-key-1' });
  historicalActors.push(actor());
  await loop.applyObservationDelta(actor(), { deltaId: 'delta-1', idempotencyKey: 'delta-key-1', deltaDigest: hash('delta-1'), observationScopeId: beforeBatch.modeState.observationScopeId, executionEpoch: 1, baseCheckpoint: beforeBatch.modeState.checkpoint, watermark: { streamId: 'cold-stream', sequence: 1 }, observationRefs: ['observation:accepted'], eventSequences: [1], summaryRef: 'summary:accepted' }, { durableContext: original.durableContext });
  historicalActors.push(actor());
  await loop.openObservationScope({ actor: actor(), kind: 'task', scope, readableRefs: ['task:goal'], capabilities: ['read-task'] });
  historicalActors.push(actor());
  const source = loop.contextHistoryRecord();
  const sourceRef = loop.contextCommitRef();
  if (!sourceRef) throw new Error('start/source publication did not commit');
  const assignment: WorkAssignment = { assignmentId: 'cold-assignment', taskId: id('task', 'cold-task'), pipelineNodeId: 'cold-node', attempt: 1, executionEpoch: 1, inputRevision: 1, objective: 'same business turn', targetRefs: ['task:goal'], expectedOutputRefs: ['task:result'], acceptanceCriteriaDigest: 'sha256:criteria', successCriteria: ['retain context'], failureCriteria: ['lost context'], incompleteCriteria: ['pending proof'], requiredCapabilities: ['provider.execution'], mergeGate: 'not-required' };
  const bindingRef = receipt(await journal.append({ kind: 'event', scope, commitId: 'original-binding', payload: { kind: 'binding-fixture', assignment, identity: original.turn!.identity } }));
  const authorityCommitRef = receipt(await journal.append({ kind: 'event', scope, commitId: 'current-grant', payload: { kind: 'grant-fixture', permissionRevision: 'current-permission' } }));
  const businessRegistrationCommitRef = receipt(await journal.append({ kind: 'event', scope, commitId: 'segment-registration', payload: { kind: 'registration-fixture', requestRef: 'cold-segment-request' } }));
  const businessTurnRef = { businessTurnId: original.turn!.identity.turnId, bindingCommitRef: bindingRef, execution: { runtimeId: original.agentRuntimeId, executionEpoch: original.executionEpoch } };
  const segment: ResumedTurnSegmentOpened = {
    kind: 'segment-opened', segmentId: 'cold-segment-2', businessTurnRef,
    predecessor: { segmentId: businessTurnRef.businessTurnId, recoveryAssetsReceiptRef: 'exact-original-recovery-receipt' },
    binding: { businessTurnRef, assignment, scope, execution: { runtimeId: original.agentRuntimeId, executionEpoch: 2 }, incarnation: { runtimeId: original.agentRuntimeId, generation: 1, agentInstanceId: 'cold-instance-2', roleId: 'humanagent.ui-runtime.provider-execution', taskId: assignment.taskId, assignmentId: assignment.assignmentId, executionEpoch: 2 } },
    authorityCommitRef, businessRegistrationCommitRef, requestRef: 'cold-segment-request', inputIdentity: { requestRef: 'cold-segment-request', digest: hash('cold-segment-intent') },
  };
  validateResumedTurnSegmentOpened(segment);
  const segmentCommitRef = receipt(await journal.append({ kind: 'event', scope, commitId: 'cold-segment-opened', payload: { kind: 'segment-opened', segment } }));
  const verifiedBefore = await journal.verify();
  const targetHeadBefore = (await port.readContextHistory({ scope, agentRuntimeId: segment.binding.incarnation.runtimeId, limit: 1 })).currentContextCommitRef;
  assert.deepEqual(targetHeadBefore, sourceRef);
  const resumed = await AgentLoopRuntime.resumeIncarnation({ ...original, permissionRevision: 'current-permission' }, port, { segment, sourceContextCommitRef: sourceRef });
  const installed = resumed.contextHistoryRecord();
  const installedRef = resumed.contextCommitRef();
  if (!installedRef) throw new Error('incarnation context was not installed');
  const readback = await port.readContextCommit(scope, installedRef);
  assert.deepEqual(installed, readback);
  assert.equal(installed.agentRuntimeId, segment.binding.incarnation.runtimeId);
  assert.equal(installed.loopCheckpoint.executionEpoch, 2);
  assert.equal(installed.contextView.executionEpoch, 2);
  assert.deepEqual(installed.loopCheckpoint.predecessor, { checkpointId: source.loopCheckpoint.checkpointId, digest: source.loopCheckpoint.digest });
  assert.equal(installed.loopCheckpoint.checkpointId.value === source.loopCheckpoint.checkpointId.value, false);
  assert.equal(installed.contextView.contextViewRef === source.contextView.contextViewRef, false);
  assert.deepEqual(installed.durableContext, source.durableContext);
  assert.deepEqual(installed.contextView.activeRefs, source.contextView.activeRefs);
  assert.deepEqual(installed.contextView.omittedRefs, source.contextView.omittedRefs);
  for (const key of ['handledEventIds', 'handledBatchKeys', 'appliedDeltaIds', 'appliedDeltaKeys', 'budgetUsage', 'inboxWatermark', 'deltaWatermark', 'closedObservationScopeIds', 'mode', 'transitionSeq'] as const) assert.deepEqual(installed.loopControl[key], source.loopControl[key]);
  assert.equal(installed.loopControl.inboxExecutionEpoch, 2);
  assert.equal(installed.loopControl.deltaExecutionEpoch, 2);
  assert.deepEqual(installed.loopControl.inboxCheckpoint, installed.contextView.checkpoint);
  assert.deepEqual(installed.loopControl.deltaCheckpoint, installed.contextView.checkpoint);
  assert.equal(installed.loopControl.observationScope?.agentRuntimeId, segment.binding.incarnation.runtimeId);
  assert.equal(installed.loopControl.observationScope?.executionEpoch, 2);
  assert.deepEqual(installed.loopControl.observationScope?.checkpoint, installed.contextView.checkpoint);
  assert.equal(installed.loopControl.inboxObservationScopeId, installed.loopCheckpoint.observationScopeId);
  assert.equal(installed.loopControl.deltaObservationScopeId, installed.loopCheckpoint.observationScopeId);
  assert.equal(installed.loopControl.observationScopeId === source.loopControl.observationScopeId, false);
  assert.deepEqual(installed.previousContextCommitRef, targetHeadBefore);
  assert.deepEqual(port.commits.at(-1)?.expected, targetHeadBefore);
  assert.deepEqual((await port.readContextHistory({ scope, agentRuntimeId: segment.binding.incarnation.runtimeId, limit: 1 })).currentContextCommitRef, installedRef);
  assert.ok(port.reads.some((ref) => ref.commitId === sourceRef.commitId));
  assert.ok(port.reads.some((ref) => ref.commitId === installedRef.commitId));
  const snapshot = resumed.snapshot();
  assert.equal(snapshot.modeState.agentRuntimeId, segment.binding.incarnation.runtimeId);
  assert.equal(snapshot.modeState.executionEpoch, 2);
  assert.equal(snapshot.lease.permissionRevision, 'current-permission');
  assert.equal(snapshot.lease.executionEpoch, 2);
  assert.equal(historicalActors.some((oldActor) => oldActor.leaseId === snapshot.lease.leaseId), false, 'fresh incarnation lease must not alias any historical actor');
  assert.equal(resumed.currentTurnTransition().turnOwnerRef, original.turn!.ownerId);
  assert.deepEqual(await port.readContextCommit(scope, sourceRef), source);
  const verifiedAfter = await journal.verify();
  assert.equal(verifiedAfter.valid, true);
  assert.deepEqual(verifiedAfter.records.slice(0, verifiedBefore.records.length), verifiedBefore.records);
  assert.deepEqual(segment.binding.assignment, assignment);
  assert.equal(segment.businessTurnRef.businessTurnId, original.turn!.identity.turnId);
  assert.equal(segment.binding.assignment.executionEpoch, 1);
  const publicationsBeforeOldActors = port.commits.length;
  for (const oldActor of historicalActors) {
    await assert.rejects(() => resumed.openObservationScope({ actor: oldActor, kind: 'task', scope, readableRefs: ['task:goal'], capabilities: ['read-task'] }), /lease/);
    assert.deepEqual(resumed.snapshot(), snapshot);
    assert.deepEqual(resumed.contextHistoryRecord(), installed);
    assert.deepEqual(resumed.contextCommitRef(), installedRef);
    assert.equal(port.commits.length, publicationsBeforeOldActors);
    assert.deepEqual((await port.readContextHistory({ scope, agentRuntimeId: segment.binding.incarnation.runtimeId, limit: 1 })).currentContextCommitRef, installedRef);
  }
  assert.deepEqual((await journal.verify()).records, verifiedAfter.records);
  await writeFile(join(root, 'receipt.json'), JSON.stringify({ sourceRef, targetHeadBefore, segmentCommitRef, installedRef, originalTurn: original.turn!.identity, segment, source, installed, lease: snapshot.lease, historicalActors, historicalActorsRejected: historicalActors.length, oldActorPublications: port.commits.length - publicationsBeforeOldActors, commits: port.commits, reads: port.reads }, null, 2));
  console.log(`incarnation receipt: ${join(root, 'receipt.json')}`);
});
