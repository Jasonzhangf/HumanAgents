/// <reference path="../../adapters/node-modules.d.ts" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  id, type BusinessPayload, type ExplicitTurnEndInput, type InteractionParentProviderExecutionIdentityRef,
  type InteractionSemanticCheckpoint, type InteractionTurnIdentity, type ProviderBinding, type RawAsset,
} from '../../../packages/contracts/src/index.js';
import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionHelperJournal } from '../../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal } from '../../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { ImmutableAssetStore } from '../../../packages/adapters/filesystem/src/index.js';
import { filesystemProviderEvidenceSink, providerRawContentReader } from '../../../packages/adapters/provider/src/evidence.js';
import { createInteractionParentTurnRawOwner, publishInteractionProviderSettlement } from '../../../packages/runtime/src/explicit-brain/interaction-parent-turn-raw.js';
import { ExplicitTurnHelperSession } from '../../../packages/runtime/src/explicit-brain/interaction-turn-session.js';
import { beginExplicitEndAttempt, expandExplicitTurnCheckpointIndex, submitExplicitTurnEnd } from '../../../packages/runtime/src/explicit-brain/explicit-turn-end.js';
import {
  buildDurableExplicitScopeCheckpointIndex,
  readDurableExplicitScopeCheckpointIndex, readExplicitScopeCheckpointLeaves,
  readExplicitTurnCheckpointLeafEvidence,
} from '../../../packages/runtime/src/explicit-brain/explicit-checkpoint-index.js';

// Failure basis: a durable index can leak detail into a label prompt, persist a
// label before all model calls succeed, or make old leaves unreadable after a
// rebuild failure. Probability unknown; impact: wrong context and lost recovery.
// Cost: local JSONL and immutable assets only, no network or persistent process.
const organId = id('organ', 'checkpoint-index');
const operationId = id('operation', 'checkpoint-index');
const journalScope = { organId, operationId };
const binding: ProviderBinding = {
  bindingId: 'checkpoint-index', providerId: 'checkpoint-index', protocol: 'responses',
  endpointRef: 'endpoint://checkpoint-index', modelRef: 'checkpoint-index',
  configDigest: 'config', capabilityDigest: 'capability',
};

async function fixture() {
  const root = join(homedir(), '.humanagent', 'test-fixtures', 'checkpoint-index');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'round-trip-'));
  const file = join(directory, 'organ.jsonl');
  const journal = new JsonlOrganJournal(file);
  const parent = new JsonlInteractionParentTurnJournal(journal);
  const helper = new JsonlInteractionHelperJournal(journal);
  const sink = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(directory, 'assets')));
  const rawContent = providerRawContentReader(sink);
  let ordinal = 0;
  const asset = async (content: string): Promise<RawAsset> => ({
    ref: await sink.write({ scope: journalScope, kind: 'operation', type: 'checkpoint-index',
      locator: `operation/checkpoint-index/${++ordinal}`, content }),
    view: { kind: 'utf8-text' },
  });

  const createLeaf = async (input: {
    readonly interactionScopeId: string;
    readonly turnId: string;
    readonly action: string;
    readonly result: string;
    readonly answer: string;
    readonly evidence: string;
  }) => {
    const turn: InteractionTurnIdentity = {
      organId, interactionScopeId: input.interactionScopeId, interactionId: 'conversation',
      inputRevision: 1, turnId: input.turnId,
    };
    const execution: InteractionParentProviderExecutionIdentityRef = {
      organId, operationId, interactionTurn: turn, runtimeId: `runtime-${input.turnId}`, executionEpoch: 1,
    };
    const initialInput = await asset(input.evidence);
    const owner = createInteractionParentTurnRawOwner({
      turn, execution, executionOwner: { daemonLeaseId: 'lease', daemonGeneration: 1, processStartToken: 'process' },
      scope: journalScope, initialInput, priorCheckpoints: [], providerBinding: binding,
      journal: parent, rawContent, endProtocol: 'explicit-end-v1',
    });
    await owner.openTurnInput();
    const request = { turnId: 'provider-turn', requestId: `request-${input.turnId}` };
    await owner.registerRequest({ execution, record: { request, scope: journalScope, phase: 'dispatching' } });
    let producerSeq = 0;
    const accept = async (fact: Parameters<typeof owner.acceptRawFact>[0]['fact']) => owner.acceptRawFact({
      execution, scope: journalScope, request, producerSeq: ++producerSeq, fact,
    });
    const endInput = {
      kind: 'simple',
      decision: { kind: 'answer', normalizedInput: input.evidence, knownFacts: [], decisionRefs: [], answer: input.answer },
      checkpointRecord: { index: { action: input.action, result: input.result } },
    } as const satisfies ExplicitTurnEndInput;
    await accept({ kind: 'tool-call', contentUnitId: 'end-call', call: {
      callId: 'end', toolId: 'humanagent.turn.end', arguments: endInput as unknown as BusinessPayload, continuationRef: 'end',
    }, rawArguments: await asset(JSON.stringify(endInput)), complete: true });
    const attempt = await beginExplicitEndAttempt({ journal: parent, turn, execution });
    const accepted = await submitExplicitTurnEnd({ journal: parent, attempt, requestId: request.requestId, callId: 'end', arguments: endInput });
    assert.equal(accepted.kind, 'accepted');
    if (accepted.kind !== 'accepted') throw new Error('expected accepted end');
    await accept({ kind: 'tool-result', contentUnitId: 'end-result', callId: 'end', continuationRef: 'end',
      result: { ...execution, callId: 'end', toolId: 'humanagent.turn.end', status: 'succeeded', outputRefs: [], evidenceRefs: [] },
      rawOutput: await asset('receipt'), complete: true });
    await accept({ kind: 'request-complete', terminal: 'completed' });
    await owner.registerRequest({ execution, record: { request, scope: journalScope, phase: 'settled' } });
    const finalParentOutput = await owner.readFinalTurnOutput();
    const evidence = {
      evidenceId: id('evidence', `settle-${input.turnId}`), kind: 'operation' as const,
      source: 'checkpoint-index-test', locator: `interaction://settle/${input.turnId}`, scope: journalScope,
    };
    await owner.recordProviderClose({ providerBinding: binding, result: {
      bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol,
      state: 'closed', evidenceRefs: [evidence],
    }, closedAt: '2026-11-22T01:00:00Z' });
    await publishInteractionProviderSettlement({ journal: parent, receipt: {
      interactionId: turn.interactionId, inputRevision: turn.inputRevision, request,
      settlement: { ...execution, state: 'succeeded', evidenceRefs: [evidence],
        resourceRelease: { state: 'released', evidenceRefs: [evidence] },
        persistence: { state: 'committed', evidenceRefs: [evidence] } },
    } });
    const committed = await new ExplicitTurnHelperSession({
      identity: turn, latestTurn: { ...turn, entries: [{ kind: 'user-input', content: initialInput }] },
      journal: helper, checkpointJournal: helper, rawContent, endJournal: parent,
      clock: { now: () => '2026-11-22T01:00:00Z' }, factory: async () => { throw new Error('unused'); },
    }).closeTurnSemanticCheckpoint({ finalParentOutput, outcome: endInput.decision, acceptedEnd: accepted });
    return { turn, committed, evidence: input.evidence, initialInput };
  };

  return { parent, helper, sink, createLeaf, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const leafSpecs = [
  { turnId: 'turn-1', action: 'checked supplier A quote', result: 'net price was 120 EUR', answer: 'supplier A first quoted net price 120 EUR', evidence: 'supplier A first quote: net price 120 EUR' },
  { turnId: 'turn-2', action: 'checked supplier B quote', result: 'net price was 110 EUR', answer: 'supplier B quoted net price 110 EUR', evidence: 'supplier B quote: net price 110 EUR' },
  { turnId: 'turn-3', action: 'compared quotes', result: 'supplier B is lower', answer: 'supplier B net price is 10 EUR lower', evidence: 'comparison: supplier B 110 EUR, supplier A 120 EUR' },
  { turnId: 'turn-4', action: 'received supplier A correction', result: 'net price is 100 EUR', answer: 'supplier A corrected net price to 100 EUR', evidence: 'supplier A correction: net price 100 EUR, currency EUR, source supplier A invoice 42' },
  { turnId: 'turn-5', action: 'selected corrected quote', result: 'supplier A is lower', answer: 'selected supplier A corrected net price 100 EUR', evidence: 'selection: supplier A corrected net price 100 EUR' },
].map(spec => ({ ...spec, interactionScopeId: 'scope-main' }));

test('durable checkpoint index labels child indexes only and expands to original evidence', async () => {
  const f = await fixture();
  try {
    const created = [];
    for (const spec of leafSpecs) created.push(await f.createLeaf(spec));
    const modelCalls: string[][] = [];
    const directory = await buildDurableExplicitScopeCheckpointIndex({
      parentJournal: f.parent, indexStore: f.helper, scope: { organId, interactionScopeId: 'scope-main' },
      groupSize: 5, windowLimit: 1,
      labelPort: { label: async ({ childIndexes }) => {
        modelCalls.push([...childIndexes]);
        return 'quotes, correction, and selected supplier terms';
      } },
    });
    assert.equal(directory.roots.length, 1);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0]?.length, 5);
    assert.ok(modelCalls[0]!.every(label => label.includes('price') || label.includes('quote') || label.includes('supplier')));
    assert.ok(!modelCalls[0]!.some(label => label.includes('invoice 42')), 'detail and source stay out of the label prompt');

    const coldDirectory = await readDurableExplicitScopeCheckpointIndex({
      parentJournal: f.parent, indexStore: f.helper, scope: { organId, interactionScopeId: 'scope-main' },
    });
    const root = expandExplicitTurnCheckpointIndex({ directory: coldDirectory, nodeId: coldDirectory.roots[0]!, limit: 5 });
    assert.equal(root.node.label, 'quotes, correction, and selected supplier terms');
    assert.deepEqual(root.children.map(node => {
      const detail = node.checkpoint?.detail;
      return detail !== undefined && 'answer' in detail ? detail.answer : undefined;
    }),
      leafSpecs.map(spec => spec.answer));
    const corrected = root.children.find(node => node.checkpoint?.turnId === 'turn-4')!.checkpoint!;
    const evidence = await readExplicitTurnCheckpointLeafEvidence({ leaf: corrected, readEvidence: f.sink.read });
    assert.ok(evidence.some(({ content }) => new TextDecoder().decode(content).includes('net price 100 EUR, currency EUR, source supplier A invoice 42')));

    const modelCallsBeforeRebuild = modelCalls.length;
    await buildDurableExplicitScopeCheckpointIndex({
      parentJournal: f.parent, indexStore: f.helper, scope: { organId, interactionScopeId: 'scope-main' },
      groupSize: 5, windowLimit: 1,
      labelPort: { label: async () => { throw new Error('saved directory must be reused'); } },
    });
    assert.equal(modelCalls.length, modelCallsBeforeRebuild);
    assert.equal((await f.helper.readScopeCheckpointIndexes({ organId, interactionScopeId: 'scope-main' })).length, 1);
  } finally { await f.cleanup(); }
});

test('failed label rebuild keeps the old directory, new leaf, and recovery checkpoints readable', async () => {
  const f = await fixture();
  try {
    for (const spec of leafSpecs) await f.createLeaf(spec);
    const scope = { organId, interactionScopeId: 'scope-main' };
    await buildDurableExplicitScopeCheckpointIndex({
      parentJournal: f.parent, indexStore: f.helper, scope, groupSize: 5, windowLimit: 1,
      labelPort: { label: async () => 'initial directory' },
    });
    const sixth = await f.createLeaf({ interactionScopeId: 'scope-main', turnId: 'turn-6',
      action: 'stored delivery file', result: 'file is available', answer: 'delivery file is available',
      evidence: 'delivery file: final.pdf' });
    const checkpointBefore = await f.helper.readSemanticCheckpointExact(sixth.turn);
    await assert.rejects(buildDurableExplicitScopeCheckpointIndex({
      parentJournal: f.parent, indexStore: f.helper, scope, groupSize: 5, windowLimit: 1,
      labelPort: { label: async () => { throw new Error('standard model unavailable'); } },
    }), /standard model unavailable/);
    const fallbackDirectory = await readDurableExplicitScopeCheckpointIndex({ parentJournal: f.parent, indexStore: f.helper, scope });
    assert.equal((await f.helper.readScopeCheckpointIndexes(scope)).length, 1);
    const leaves = await readExplicitScopeCheckpointLeaves({ parentJournal: f.parent, checkpointJournal: f.helper, scope });
    assert.equal(leaves.length, 6);
    assert.deepEqual(await f.helper.readSemanticCheckpointExact(sixth.turn), checkpointBefore);
    assert.equal(expandExplicitTurnCheckpointIndex({ directory: fallbackDirectory, nodeId: fallbackDirectory.roots[0]!, limit: 5 }).node.label,
      'initial directory');
    assert.equal(expandExplicitTurnCheckpointIndex({ directory: fallbackDirectory, nodeId: fallbackDirectory.roots[1]!, limit: 1 }).node.checkpoint?.turnId,
      sixth.turn.turnId);
    let labelCalls = 0;
    const rebuilt = await buildDurableExplicitScopeCheckpointIndex({
      parentJournal: f.parent, indexStore: f.helper, scope, groupSize: 5, windowLimit: 1,
      labelPort: { label: async () => { labelCalls++; return 'quotes and delivery'; } },
    });
    assert.equal(labelCalls, 1);
    assert.equal(rebuilt.roots.length, 1);
    assert.deepEqual((await readDurableExplicitScopeCheckpointIndex({ parentJournal: f.parent, indexStore: f.helper, scope })).roots, rebuilt.roots);
    const multiple = await buildDurableExplicitScopeCheckpointIndex({
      parentJournal: f.parent, indexStore: f.helper, scope, groupSize: 3, windowLimit: 2,
      labelPort: { label: async ({ childIndexes }) => childIndexes[0]! },
    });
    assert.equal(multiple.roots.length, 2);
    assert.deepEqual((await readDurableExplicitScopeCheckpointIndex({ parentJournal: f.parent, indexStore: f.helper, scope })).roots, multiple.roots);
  } finally { await f.cleanup(); }
});

test('partial Journal index write never invents a complete root', async () => {
  const f = await fixture();
  try {
    for (const spec of leafSpecs) await f.createLeaf(spec);
    const scope = { organId, interactionScopeId: 'scope-main' };
    await f.createLeaf({ interactionScopeId: 'scope-main', turnId: 'turn-6',
      action: 'stored delivery file', result: 'file is available', answer: 'delivery file is available',
      evidence: 'delivery file: final.pdf' });
    let writes = 0;
    const failingStore = {
      ...f.helper,
      readScopeSemanticCheckpoints: f.helper.readScopeSemanticCheckpoints.bind(f.helper),
      readSemanticCheckpointExact: f.helper.readSemanticCheckpointExact.bind(f.helper),
      readScopeCheckpointIndexes: f.helper.readScopeCheckpointIndexes.bind(f.helper),
      appendCheckpointIndex: async (ref: Parameters<typeof f.helper.appendCheckpointIndex>[0]) => {
        if (++writes === 2) throw new Error('index journal write failed');
        return f.helper.appendCheckpointIndex(ref);
      },
    };
    await assert.rejects(buildDurableExplicitScopeCheckpointIndex({
      parentJournal: f.parent, indexStore: failingStore, scope, groupSize: 3, windowLimit: 1,
      labelPort: { label: async () => 'new directory' },
    }), /index journal write failed/);
    const refs = await f.helper.readScopeCheckpointIndexes(scope);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.root, false);
    const leaves = await readExplicitScopeCheckpointLeaves({ parentJournal: f.parent, checkpointJournal: f.helper, scope });
    assert.equal(leaves.length, 6, 'all committed leaves remain directly readable');
    await assert.rejects(readDurableExplicitScopeCheckpointIndex({ parentJournal: f.parent, indexStore: f.helper, scope }),
      /no complete directory/);
  } finally { await f.cleanup(); }
});

test('checkpoint index stays isolated by interaction scope', async () => {
  const f = await fixture();
  try {
    for (const spec of leafSpecs) await f.createLeaf(spec);
    const other = await f.createLeaf({ interactionScopeId: 'scope-other', turnId: 'other-1',
      action: 'handled other topic', result: 'other evidence stored', answer: 'other topic evidence is stored',
      evidence: 'other topic evidence: unrelated fact' });
    const main = { organId, interactionScopeId: 'scope-main' };
    const directory = await buildDurableExplicitScopeCheckpointIndex({
      parentJournal: f.parent, indexStore: f.helper, scope: main, groupSize: 5, windowLimit: 1,
      labelPort: { label: async () => 'main scope only' },
    });
    const expanded = expandExplicitTurnCheckpointIndex({ directory, nodeId: directory.roots[0]!, limit: 10 });
    assert.ok(expanded.children.every(node => node.checkpoint?.turnId !== other.turn.turnId));
    assert.equal((await readExplicitScopeCheckpointLeaves({ parentJournal: f.parent, checkpointJournal: f.helper, scope: main })).length, 5);
    const otherLeaves = await readExplicitScopeCheckpointLeaves({
      parentJournal: f.parent, checkpointJournal: f.helper, scope: { organId, interactionScopeId: 'scope-other' },
    });
    assert.equal(otherLeaves.length, 1);
    assert.equal(otherLeaves[0]?.turnId, other.turn.turnId);
  } finally { await f.cleanup(); }
});
