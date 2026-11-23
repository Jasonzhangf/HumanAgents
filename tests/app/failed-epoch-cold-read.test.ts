import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type InteractionParentProviderExecutionIdentityRef, type ProviderBinding } from '../../packages/contracts/src/index.js';
import { createProviderExplicitBrainInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import { ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';

// Reuse borrowed-provider-lifecycle's observed missingEnd window. A completed
// intermediate request followed by a failed continuation must remain readable
// as failure, never as a checkpoint. Cost: local HTTP/SSE and one JSONL fixture.
test('failed no-end epoch cold reads completed intermediate requests without inventing success', async () => {
  const fixtures = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, 'failed-epoch-cold-read-20261123-'));
  const path = join(root, 'organ.jsonl');
  let starts = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.end('{}'); return; }
    for await (const _chunk of request) { /* drain the real request */ }
    if (++starts > 1) {
      response.writeHead(400); response.end('explicit test: no accepted end'); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      { type: 'response.created', response: { id: 'request-1' } },
      { type: 'response.output_text.done', item_id: 'text', text: 'ordinary terminal text' },
      { type: 'response.completed', response: { id: 'request-1' } },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing isolated listener address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const binding: ProviderBinding = { bindingId: 'borrow-lifecycle', providerId: 'controlled', protocol: 'responses',
    endpointRef: baseUrl, modelRef: 'controlled', configDigest: 'test:config', capabilityDigest: 'test:capability' };
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const journal = new JsonlOrganJournal(path);
  const parent = new JsonlInteractionParentTurnJournal(journal);
  const helper = new JsonlInteractionHelperJournal(journal);
  const scope = { organId: id('organ', 'borrow-lifecycle'), interactionScopeId: 'borrow-lifecycle' };
  const port = new ProviderAdapter<InteractionParentProviderExecutionIdentityRef>({ binding, routeRef: 'controlled',
    codec: new ResponsesProviderCodec(), evidence,
    transport: new V3ProviderHttpTransport({ binding, baseUrl, source: 'http', evidence }) });
  try {
    const interpreter = createProviderExplicitBrainInterpreter({ ...scope, binding, port,
      parentJournal: parent, checkpointJournal: helper, helperJournal: helper, turnHelperJournal: helper,
      rawEvidence: evidence, rawContent: providerRawContentReader(evidence),
      clock: { now: () => new Date().toISOString() }, helperFactory: async () => { throw new Error('no helpers'); },
      templateRoot: join(process.cwd(), 'packages/agent-templates/templates') });
    await assert.rejects(() => interpreter.interpret({ interactionId: 'borrow-interaction', inputRevision: 1,
      sourceRef: 'test:borrow', rawInput: 'hello', clarifications: [], taskCandidates: [] }), /no accepted end|400/);
    const turns = await parent.readScopeOpenedTurns(scope);
    assert.equal(turns.length, 1);
    const turn = turns[0]!.fact.turn;
    const original = await readFile(path, 'utf8');
    const cold = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(path));
    const snapshot = await cold.readTurnSnapshot(turn);
    assert.equal(snapshot.turnInput?.fact.endProtocol, 'explicit-end-v1');
    assert.ok(snapshot.executionFailure, 'the original legal failure remains visible');
    assert.equal(snapshot.resourceClose, null, 'borrowed provider has no invented close');
    assert.equal(snapshot.providerSettlements.length, 0);
    assert.ok(snapshot.acceptedFacts.some(entry => entry.fact.envelope.fact.kind === 'request-complete'));
    assert.ok(snapshot.requests.some(entry => entry.fact.phase === 'failed'));
    assert.equal(snapshot.endControls?.some(entry => entry.fact.kind === 'submission' && entry.fact.result.kind !== 'rejected'), false);
    const coldHelper = new JsonlInteractionHelperJournal(new JsonlOrganJournal(path));
    assert.equal(await coldHelper.readSemanticCheckpointExact(turn), null);
    // Decoder-only legacy counterexample. Change the read view, never durable
    // records: old unmarked turns still cannot combine terminal raw output
    // with an epoch failure. The underlying replay verifies the real Journal.
    const legacyView = new JsonlOrganJournal(path);
    const records = await legacyView.replay();
    legacyView.replay = async () => records
      .filter(record => record.payload?.discriminant !== 'explicit-end-control')
      .map(record => {
        if (record.payload?.discriminant !== 'turn-input') return record;
        const { endProtocol: _protocol, ...fact } = record.payload.fact as Record<string, unknown>;
        return { ...record, payload: { ...record.payload, fact } };
      });
    await assert.rejects(() => new JsonlInteractionParentTurnJournal(legacyView).readTurnSnapshot(turn),
      /epoch without a terminal output/);
    assert.equal(await readFile(path, 'utf8'), original, 'cold read must not rewrite original data');
    console.log('real continuation failure propagated; fresh Journal decoded failure; checkpoint absent; data unchanged');
  } finally {
    await port.close(binding);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(server.address(), null);
    await rm(root, { recursive: true });
    console.log(`released failed-epoch listener and fixture ${root}`);
  }
});
