/// <reference path="../../adapters/node-modules.d.ts" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { id, type BusinessPayload, type InteractionTurnIdentity, type InteractionParentProviderExecutionIdentityRef,
  type RawAsset, type ProviderBinding, type ExplicitTurnEndInput, type InteractionSemanticCheckpoint } from '../../../packages/contracts/src/index.js';
import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionParentTurnJournal } from '../../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { JsonlInteractionHelperJournal } from '../../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { ImmutableAssetStore } from '../../../packages/adapters/filesystem/src/index.js';
import { filesystemProviderEvidenceSink, providerRawContentReader } from '../../../packages/adapters/provider/src/evidence.js';
import { createInteractionParentTurnRawOwner, publishInteractionProviderSettlement } from '../../../packages/runtime/src/explicit-brain/interaction-parent-turn-raw.js';
import { prepareScopeSemanticHistory } from '../../../packages/runtime/src/context/interaction-semantic-context.js';
import { ExplicitTurnHelperSession } from '../../../packages/runtime/src/explicit-brain/interaction-turn-session.js';
import { beginExplicitEndAttempt, submitExplicitTurnEnd, readExplicitEndRecovery, readExplicitEndOutcome, readExplicitTurnCheckpointIndex,
  buildExplicitTurnCheckpointIndexDirectory, expandExplicitTurnCheckpointIndex } from '../../../packages/runtime/src/explicit-brain/explicit-turn-end.js';

// Failure basis: a new durable seam can count retransmission as a second error,
// lose the failure memory on restart, or let final text bypass the end tool.
// Probability unknown; impact: wrong checkpoint and cross-turn continuation.
// Cost: local JSONL round trips, no network/server or persistent test process.
const organId = id('organ', 'c07-end');
const operationId = id('operation', 'c07-end');
const turn: InteractionTurnIdentity = { organId, interactionScopeId: 'scope', interactionId: 'interaction', inputRevision: 1, turnId: 'turn' };
const execution: InteractionParentProviderExecutionIdentityRef = { organId, operationId, interactionTurn: turn, runtimeId: 'runtime', executionEpoch: 1 };
const scope = { organId, operationId };
const binding: ProviderBinding = { bindingId: 'c07', providerId: 'c07', protocol: 'responses', endpointRef: 'endpoint://c07', modelRef: 'c07', configDigest: 'config', capabilityDigest: 'capability' };
const valid = { kind: 'simple', decision: { kind: 'answer', normalizedInput: 'question', knownFacts: [], decisionRefs: [], answer: 'answer' }, checkpointRecord: { index: { action: 'answered the question', result: 'answered' } } } as const satisfies ExplicitTurnEndInput;

async function fixture() {
  const root = join(homedir(), '.humanagent', 'test-fixtures', 'c07-end');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'round-trip-'));
  const file = join(directory, 'organ.jsonl');
  const journal = new JsonlOrganJournal(file);
  const parent = new JsonlInteractionParentTurnJournal(journal);
  const helper = new JsonlInteractionHelperJournal(journal);
  const sink = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(directory, 'assets')));
  const rawContent = providerRawContentReader(sink);
  let ordinal = 0;
  const asset = async (text: string): Promise<RawAsset> => ({ ref: await sink.write({ scope, kind: 'operation', type: 'c07', locator: `operation/c07/${++ordinal}`, content: text }), view: { kind: 'utf8-text' } });
  const initialInput = await asset('question');
  const prior: InteractionSemanticCheckpoint = { ...turn, turnId: 'prior', kind: 'semantic-checkpoint', committedAt: '2026-11-22T00:00:00Z', claims: [], constraints: [], evidenceRefs: [], semanticAssetRefs: [] };
  const executionOwner = { daemonLeaseId: 'lease', daemonGeneration: 1, processStartToken: 'process' };
  let currentExecution = execution;
  let owner = createInteractionParentTurnRawOwner({ turn, execution, executionOwner, scope, initialInput, priorCheckpoints: [prior], providerBinding: binding, journal: parent, rawContent, endProtocol: 'explicit-end-v1' });
  await owner.openTurnInput();
  let request = { turnId: 'provider-turn', requestId: 'request' };
  await owner.registerRequest({ execution, record: { request, scope, phase: 'dispatching' } });
  let producerSeq = 0;
  const call = async (callId: string, args: BusinessPayload) => {
    await owner.acceptRawFact({ execution: currentExecution, scope, request, producerSeq: ++producerSeq, fact: { kind: 'tool-call', contentUnitId: `call-${callId}`, call: { callId, toolId: 'humanagent.turn.end', arguments: args, continuationRef: callId }, rawArguments: await asset(JSON.stringify(args)), complete: true } });
  };
  const result = async (callId: string) => {
    await owner.acceptRawFact({ execution: currentExecution, scope, request, producerSeq: ++producerSeq, fact: { kind: 'tool-result', contentUnitId: `result-${callId}`, callId, continuationRef: callId,
      result: { ...currentExecution, callId, toolId: 'humanagent.turn.end', status: 'succeeded', outputRefs: [], evidenceRefs: [] }, rawOutput: await asset('receipt'), complete: true } });
  };
  const finish = async (withText = true) => {
    if (withText) await owner.acceptRawFact({ execution: currentExecution, scope, request, producerSeq: ++producerSeq, fact: { kind: 'content', contentUnitId: 'answer', channel: 'assistant-text', update: 'full', content: await asset('answer'), complete: true } });
    await owner.acceptRawFact({ execution: currentExecution, scope, request, producerSeq: ++producerSeq, fact: { kind: 'request-complete', terminal: 'completed' } });
    await owner.registerRequest({ execution: currentExecution, record: { request, scope, phase: 'settled' } });
    return owner.readFinalTurnOutput();
  };
  const close = async () => {
    const evidence = { evidenceId: id('evidence', `settle-${currentExecution.executionEpoch}`), kind: 'operation' as const, source: 'c07', locator: 'interaction://settle', scope };
    await owner.recordProviderClose({ providerBinding: binding, result: { bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol, state: 'closed', evidenceRefs: [evidence] }, closedAt: '2026-11-22T01:00:00Z' });
    await publishInteractionProviderSettlement({ journal: parent, receipt: { interactionId: turn.interactionId, inputRevision: turn.inputRevision, request, settlement: { ...currentExecution, state: 'succeeded', evidenceRefs: [evidence], resourceRelease: { state: 'released', evidenceRefs: [evidence] }, persistence: { state: 'committed', evidenceRefs: [evidence] } } } });
  };
  const resume = async (partialRef: string) => {
    currentExecution = { ...execution, executionEpoch: currentExecution.executionEpoch + 1 };
    owner = createInteractionParentTurnRawOwner({ turn, execution: currentExecution, executionOwner, scope, initialInput, priorCheckpoints: [prior], providerBinding: binding,
      journal: new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(file)), rawContent, endProtocol: 'explicit-end-v1' });
    await owner.reconcileTurnOwner({ previousOwner: executionOwner, replacementOwner: executionOwner, isCommittedReplacement: false, reconciledAt: '2026-11-22T02:00:00Z' });
    await owner.openTurnInput();
    await assert.rejects(beginExplicitEndAttempt({ journal: parent, turn, execution: currentExecution }),
      /new execution requires an explicit partial recovery reference/,
      'an existing submitted partial cannot use the unsubmitted dispatch recovery lane');
    const attempt = await beginExplicitEndAttempt({ journal: parent, turn, execution: currentExecution, resumePartialRef: partialRef });
    request = { turnId: 'provider-turn', requestId: `request-${currentExecution.executionEpoch}` };
    producerSeq = 0;
    await owner.registerRequest({ execution: currentExecution, record: { request, scope, phase: 'dispatching' } });
    const context = await owner.requestContext({ execution: currentExecution, request, phase: 'initial' });
    return { attempt, request, context };
  };
  const session = () => new ExplicitTurnHelperSession({ identity: turn, latestTurn: { ...turn, entries: [{ kind: 'user-input', content: initialInput }] }, journal: helper, checkpointJournal: helper, rawContent, endJournal: parent,
    clock: { now: () => '2026-11-22T01:00:00Z' }, factory: async () => { throw new Error('unused'); } });
  return { parent, helper, owner, file, call, result, finish, close, resume, session, initialInput, prior, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('C07 rejects final-text checkpoint without a durable accepted end', async () => {
  const f = await fixture();
  try {
    const finalParentOutput = await f.finish();
    await assert.rejects(f.session().closeTurnSemanticCheckpoint({ finalParentOutput, outcome: valid.decision }), /explicit end/);
    assert.equal(await f.helper.readSemanticCheckpointExact(turn), null);
  } finally { await f.cleanup(); }
});

test('C07 two errors then valid complex end commits capsule only after close/settle', async () => {
  const f = await fixture();
  try {
    const attempt = await beginExplicitEndAttempt({ journal: f.parent, turn, execution });
    for (const callId of ['one', 'two']) {
      await f.call(callId, {});
      assert.equal((await submitExplicitTurnEnd({ journal: f.parent, attempt, requestId: 'request', callId, arguments: {} })).kind, 'rejected');
      await f.result(callId);
    }
    const complex = { kind: 'complex', decision: { kind: 'requirement', normalizedInput: 'question', knownFacts: [], decisionRefs: [], proposal: {
      revision: 1, intent: 'create', title: 'task', objective: 'goal', deliverable: 'result', deliveryConditions: ['done'], evidenceRefs: [], blockingGaps: [],
    } }, checkpointRecord: { index: { action: 'intake the requirement', result: 'ready for execution' } }, capsule: { summary: 'understood', goal: 'goal', process: ['split'], findings: ['pending execution'], nextStep: 'handoff', detailRefs: ['asset://reference-only'] } } as const satisfies ExplicitTurnEndInput;
    await f.call('three', complex as unknown as BusinessPayload);
    const accepted = await submitExplicitTurnEnd({ journal: f.parent, attempt, requestId: 'request', callId: 'three', arguments: complex });
    if (accepted.kind !== 'accepted') throw new Error('third valid call must be accepted');
    await f.result('three');
    const finalParentOutput = await f.finish(false);
    assert.equal(finalParentOutput.assistantText, '', 'tool-only close does not invent final text or require a tail request');
    assert.deepEqual(await readExplicitEndOutcome({ journal: new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(f.file)), turn }), accepted);
    const { proposal, ...decision } = complex.decision;
    const outcome = { ...decision, structuredProposal: proposal };
    await assert.rejects(f.session().closeTurnSemanticCheckpoint({ finalParentOutput, outcome, acceptedEnd: accepted }), /settle and close/);
    assert.equal(await f.helper.readSemanticCheckpointExact(turn), null);
    await f.close();
    await assert.rejects(f.session().closeTurnSemanticCheckpoint({ finalParentOutput, outcome, acceptedEnd: { ...accepted, capsule: { ...complex.capsule, summary: 'forged' } } }), /durable accepted/);
    const committed = await f.session().closeTurnSemanticCheckpoint({ finalParentOutput, outcome, acceptedEnd: accepted });
    assert.ok(committed.checkpoint.claims.some(claim => claim.fact.includes('explicit-end-capsule:') && claim.fact.includes('pending execution')));
    assert.deepEqual(await f.session().closeTurnSemanticCheckpoint({ finalParentOutput, outcome, acceptedEnd: accepted }), committed);
    assert.equal((await f.helper.readScopeSemanticCheckpoints({ organId, interactionScopeId: turn.interactionScopeId })).length, 1);
  } finally { await f.cleanup(); }
});

test('C07 three format errors are idempotent durable partial; infrastructure and binding errors do not count', async () => {
  const f = await fixture();
  try {
    const attempt = await beginExplicitEndAttempt({ journal: f.parent, turn, execution });
    await assert.rejects(submitExplicitTurnEnd({ journal: f.parent, attempt, requestId: 'missing', callId: 'missing', arguments: {} }), /exact committed/);
    const results = [];
    for (const callId of ['a', 'b', 'c']) {
      await f.call(callId, {});
      const input = { journal: f.parent, attempt, requestId: 'request', callId, arguments: {} };
      if (callId === 'a') {
        await assert.rejects(submitExplicitTurnEnd({ ...input, journal: { ...f.parent, readTurnSnapshot: f.parent.readTurnSnapshot.bind(f.parent), transactTurn: async () => { throw new Error('disk unavailable'); } } }), /disk unavailable/);
      }
      const [first, replay] = await Promise.all([submitExplicitTurnEnd(input), submitExplicitTurnEnd(input)]);
      assert.deepEqual(first, replay);
      results.push(first);
      await f.result(callId);
    }
    assert.deepEqual(results.map(r => r.kind), ['rejected', 'rejected', 'partial']);
    const partial = results[2]!;
    assert.equal(partial.kind, 'partial');
    if (partial.kind !== 'partial') throw new Error('expected partial');
    const cold = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(f.file));
    const recovery = await readExplicitEndRecovery({ journal: cold, turn, partialRef: partial.partialRef });
    assert.deepEqual(recovery.initialInput, f.initialInput);
    assert.deepEqual(recovery.priorCheckpoints, [f.prior]);
    assert.equal(recovery.failures.length, 3);
    assert.deepEqual(await beginExplicitEndAttempt({ journal: cold, turn, execution }), attempt);
    await assert.rejects(readExplicitEndRecovery({ journal: cold, turn: { ...turn, inputRevision: 2 }, partialRef: partial.partialRef }), /not found/);
    await assert.rejects(submitExplicitTurnEnd({ journal: cold, attempt, requestId: 'request', callId: 'a', arguments: valid }), /conflicting/);
    await f.call('d', valid as unknown as BusinessPayload);
    await assert.rejects(submitExplicitTurnEnd({ journal: cold, attempt, requestId: 'request', callId: 'd', arguments: valid }), /already concluded/);
    await f.result('d');
    const finalParentOutput = await f.finish();
    await assert.rejects(f.session().closeTurnSemanticCheckpoint({ finalParentOutput, outcome: valid.decision }), /explicit end/);
    assert.equal(await f.helper.readSemanticCheckpointExact(turn), null);
    await f.close();
    const history = await prepareScopeSemanticHistory({ activeTurn: { ...turn, interactionId: 'next', turnId: 'next' }, parentJournal: cold, checkpointJournal: f.helper });
    assert.deepEqual(history, [], 'closed partial never becomes successful history');
    const resumed = await f.resume(partial.partialRef);
    assert.deepEqual(await submitExplicitTurnEnd({ journal: cold, attempt, requestId: 'request', callId: 'c', arguments: {} }), partial,
      'a delayed repeat of an already committed call returns its original receipt without affecting recovery');
    assert.equal(resumed.attempt.turn.turnId, turn.turnId);
    assert.equal(resumed.attempt.turn.inputRevision, turn.inputRevision);
    assert.ok(resumed.context.instructions?.text.includes('explicit-turn-end.input.kind'));
    assert.equal(resumed.context.canonical.units.filter(u => u.kind === 'tool-call').length, 0, 'failed raw attempt is not replayed as successful context');
    assert.deepEqual(await beginExplicitEndAttempt({ journal: cold, turn, execution: resumed.attempt.execution, resumePartialRef: partial.partialRef }), resumed.attempt);
    assert.deepEqual((await readExplicitEndRecovery({ journal: cold, turn, partialRef: partial.partialRef })).resumedAttempt, resumed.attempt);
    await f.call('retry-invalid', {});
    const reset = await submitExplicitTurnEnd({ journal: cold, attempt: resumed.attempt, requestId: resumed.request.requestId, callId: 'retry-invalid', arguments: {} });
    assert.equal(reset.kind, 'rejected');
    if (reset.kind !== 'rejected') throw new Error('expected first retry rejection');
    assert.equal(reset.failedAttempt, 1);
    await f.result('retry-invalid');
    await f.call('recovered', valid as unknown as BusinessPayload);
    const accepted = await submitExplicitTurnEnd({ journal: cold, attempt: resumed.attempt, requestId: resumed.request.requestId, callId: 'recovered', arguments: valid });
    assert.equal(accepted.kind, 'accepted', 'a recovered attempt starts with a fresh format budget');
    if (accepted.kind !== 'accepted') throw new Error('expected accepted');
    await f.result('recovered');
    const recoveredOutput = await f.finish();
    await f.close();
    const indexInput = { journal: cold, checkpoints: f.helper, turn };
    assert.deepEqual(await readExplicitTurnCheckpointIndex(indexInput), []);
    const checkpoint = await f.session().closeTurnSemanticCheckpoint({ finalParentOutput: recoveredOutput, outcome: valid.decision, acceptedEnd: accepted });
    assert.deepEqual(await f.session().closeTurnSemanticCheckpoint({ finalParentOutput: recoveredOutput, outcome: valid.decision, acceptedEnd: accepted }), checkpoint);
    const coldIndexes = await readExplicitTurnCheckpointIndex(indexInput);
    assert.equal(coldIndexes.length, 1);
    assert.deepEqual(coldIndexes.map(({ action, result, priorCheckpointRefs }) => ({ action, result, priorCheckpointRefs })),
      [{ action: 'answered the question', result: 'answered', priorCheckpointRefs: ['prior'] }]);
    assert.ok(coldIndexes[0]!.detail !== undefined);
    assert.deepEqual(await readExplicitTurnCheckpointIndex(indexInput), coldIndexes);
  } finally { await f.cleanup(); }
});

test('checkpoint index directory keeps exact ordered membership and expands recursively in bounded slices', () => {
  const leaves = Array.from({ length: 8 }, (_, index) => ({
    turnId: `turn-${index + 1}`, action: `action-${index + 1}`, result: `result-${index + 1}`,
    detail: { kind: 'answer', normalizedInput: 'question', knownFacts: [], decisionRefs: [], answer: `detail-${index + 1}` } as const,
    priorCheckpointRefs: index === 0 ? [] : [`turn-${index}`],
    committedAt: `2026-11-22T0${index + 1}:00:00Z`, evidenceRefs: [], semanticAssetRefs: [],
  }));
  const directory = buildExplicitTurnCheckpointIndexDirectory({
    leaves, groupSize: 2,
    windowLimit: 1,
    labels: ['group 1', 'group 2', 'group 3', 'group 4', 'all groups 1-2', 'all groups 3-4', 'all groups'],
  });
  assert.equal(directory.roots.length, 1);
  const root = expandExplicitTurnCheckpointIndex({ directory, nodeId: directory.roots[0]!, limit: 1 });
  assert.equal(root.node.label, 'all groups');
  assert.equal(root.nextOffset, 1);
  const groups = expandExplicitTurnCheckpointIndex({ directory, nodeId: root.node.id, limit: 10 });
  assert.deepEqual(groups.children.map(node => node.label), ['all groups 1-2', 'all groups 3-4']);
  assert.equal(groups.nextOffset, undefined);
  const leavesGroup = expandExplicitTurnCheckpointIndex({ directory, nodeId: groups.children[0]!.id, limit: 10 });
  assert.deepEqual(leavesGroup.children.map(node => node.label), ['group 1', 'group 2']);
  const firstGroup = expandExplicitTurnCheckpointIndex({ directory, nodeId: leavesGroup.children[0]!.id, limit: 10 });
  assert.deepEqual(firstGroup.children.map(node => node.label), ['action-1；result-1', 'action-2；result-2']);
  const firstLeaf = expandExplicitTurnCheckpointIndex({ directory, nodeId: firstGroup.children[0]!.id, limit: 1 });
  assert.equal(firstLeaf.node.checkpoint?.action, 'action-1');
  const secondLeaf = expandExplicitTurnCheckpointIndex({ directory, nodeId: firstGroup.children[1]!.id, limit: 1 });
  assert.equal(secondLeaf.node.checkpoint?.action, 'action-2');
  assert.equal(secondLeaf.node.checkpoint?.priorCheckpointRefs[0], 'turn-1');
  assert.deepEqual(directory.nodes.filter(node => node.kind === 'leaf').map(node => node.id), leaves.map(leaf => `checkpoint:${encodeURIComponent(leaf.turnId)}`));
  assert.throws(() => buildExplicitTurnCheckpointIndexDirectory({ leaves, groupSize: 2, windowLimit: 1, labels: ['invented'] }), /model label/);
  const odd = buildExplicitTurnCheckpointIndexDirectory({
    leaves: leaves.slice(0, 3), groupSize: 2, windowLimit: 1, labels: ['first pair', 'three leaves'],
  });
  const oddRoot = expandExplicitTurnCheckpointIndex({ directory: odd, nodeId: odd.roots[0]!, limit: 2 });
  assert.equal(oddRoot.children[1]?.checkpoint?.turnId, 'turn-3');
  assert.deepEqual(expandExplicitTurnCheckpointIndex({ directory: odd, nodeId: oddRoot.children[0]!.id, limit: 2 }).children
    .map(node => node.checkpoint?.turnId), ['turn-1', 'turn-2']);
  assert.throws(() => expandExplicitTurnCheckpointIndex({ directory, nodeId: directory.roots[0]!, offset: -1, limit: 1 }), /non-negative offset/);
});

test('cold checkpoint index rebuild uses only committed Journal facts and retains leaf evidence links', async () => {
  const f = await fixture();
  try {
    const attempt = await beginExplicitEndAttempt({ journal: f.parent, turn, execution });
    await f.call('committed', valid as unknown as BusinessPayload);
    const accepted = await submitExplicitTurnEnd({ journal: f.parent, attempt, requestId: 'request', callId: 'committed', arguments: valid });
    assert.equal(accepted.kind, 'accepted');
    if (accepted.kind !== 'accepted') throw new Error('expected accepted');
    await f.result('committed');
    const finalParentOutput = await f.finish();
    await f.close();
    const committed = await f.session().closeTurnSemanticCheckpoint({ finalParentOutput, outcome: valid.decision, acceptedEnd: accepted });
    const coldJournal = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(f.file));
    const leaves = await readExplicitTurnCheckpointIndex({ journal: coldJournal, checkpoints: f.helper, turn });
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0]?.committedAt, committed.checkpoint.committedAt);
    assert.deepEqual(leaves[0]?.evidenceRefs, committed.checkpoint.evidenceRefs);
    const directory = buildExplicitTurnCheckpointIndexDirectory({ leaves, groupSize: 2, labels: [] });
    assert.deepEqual(directory.roots, leaves.map(leaf => `checkpoint:${encodeURIComponent(leaf.turnId)}`));
    const leaf = expandExplicitTurnCheckpointIndex({ directory, nodeId: directory.roots[0]!, limit: 1 });
    assert.equal(leaf.node.checkpoint?.detail !== undefined, true);
    assert.equal(leaf.node.checkpoint?.committedAt, committed.checkpoint.committedAt);
    assert.deepEqual(await readExplicitTurnCheckpointIndex({ journal: coldJournal, checkpoints: f.helper, turn }), leaves,
      'rebuilding the read-only index leaves the durable checkpoint unchanged');
  } finally { await f.cleanup(); }
});
