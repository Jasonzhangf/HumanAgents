import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

// Observed failure: accepted C07 + real settlement on the supported port-only
// entry fails the unconditional physical-close gate. Impact: no answer or
// checkpoint; an illegal fix could close another owner's provider. Cost: local
// HTTP/SSE and JSONL, isolated per case and removed in finally.
async function scenario(options: { owned?: boolean; closeFails?: boolean; missingEnd?: boolean;
  missingSettlement?: boolean; stoppedSettlement?: boolean; pendingRequest?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-borrowed-provider-'));
  let closes = 0;
  let starts = 0;
  let drains = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.end('{}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const wire = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    starts++;
    const draining = wire.tools === undefined;
    if (draining) drains++;
    if (options.missingEnd && starts > 1) {
      response.writeHead(400); response.end('explicit test: no accepted end'); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = [
      { type: 'response.created', response: { id: `request-${starts}` } },
      ...(draining || options.missingEnd
        ? [{ type: 'response.output_text.done', item_id: 'text', text: 'ordinary terminal text' }]
        : [{ type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call', id: 'end-item', call_id: 'end-call', name: 'humanagent_turn_end',
          arguments: JSON.stringify({ kind: 'simple', decision: { kind: 'answer', normalizedInput: 'hello',
            knownFacts: [], decisionRefs: [], answer: 'hello' },
          checkpointRecord: { index: { action: '回答问题', result: '已回答' } } }),
        } }]),
      { type: 'response.completed', response: { id: `request-${starts}` } },
    ];
    response.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing isolated listener address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const binding: ProviderBinding = { bindingId: 'borrow-lifecycle', providerId: 'controlled', protocol: 'responses',
    endpointRef: baseUrl, modelRef: 'controlled', configDigest: 'test:config', capabilityDigest: 'test:capability' };
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const journal = new JsonlOrganJournal(join(root, 'organ.jsonl'));
  const parent = new JsonlInteractionParentTurnJournal(journal);
  const helper = new JsonlInteractionHelperJournal(journal);
  const organId = id('organ', 'borrow-lifecycle');
  const scope = { organId, interactionScopeId: 'borrow-lifecycle' };
  const port = new ProviderAdapter<InteractionParentProviderExecutionIdentityRef>({ binding, routeRef: 'controlled',
    codec: new ResponsesProviderCodec(), evidence,
    transport: new V3ProviderHttpTransport({ binding, baseUrl, source: 'http', evidence }),
  });
  const close = port.close.bind(port);
  port.close = async input => { closes++; if (options.closeFails) throw new Error('controlled owned close rejection'); return close(input); };
  const readSnapshot = parent.readTurnSnapshot.bind(parent);
  parent.readTurnSnapshot = async turn => {
    const snapshot = await readSnapshot(turn);
    // Read-boundary counterexamples: durable end and real completion alone
    // must not substitute for settlement or drained requests at checkpoint.
    if (snapshot.providerSettlements.length === 0) return snapshot;
    return { ...snapshot,
      ...(options.missingSettlement ? { providerSettlements: [] } : {}),
      ...(options.stoppedSettlement ? { providerSettlements: snapshot.providerSettlements.map(entry => ({ ...entry,
        fact: { ...entry.fact, settlement: { ...entry.fact.settlement, state: 'stopped' as const } } })) } : {}),
      ...(options.pendingRequest ? { requests: snapshot.requests.map(entry => ({ ...entry,
        fact: { ...entry.fact, phase: 'dispatched' as const } })) } : {}),
    };
  };
  try {
    const interpreter = createProviderExplicitBrainInterpreter({ ...scope, binding, port,
      parentJournal: parent, checkpointJournal: helper, helperJournal: helper, turnHelperJournal: helper,
      rawEvidence: evidence, rawContent: providerRawContentReader(evidence),
      clock: { now: () => new Date().toISOString() }, helperFactory: async () => { throw new Error('no helpers'); },
      templateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      ...(options.owned ? { prepareAgentProvider: async () => ({ roleId: 'interaction' as const,
        source: 'http' as const, binding, port, provider: { source: 'http' as const, provider: 'http' as const,
          binding: binding.bindingId, protocol: 'responses' as const, model: binding.modelRef, route: 'controlled', baseUrl } }) } : {}),
    });
    const run = () => interpreter.interpret({ interactionId: 'borrow-interaction', inputRevision: 1,
      sourceRef: 'test:borrow', rawInput: 'hello', clarifications: [], taskCandidates: [] });
    const failure = options.closeFails || options.missingEnd || options.missingSettlement || options.stoppedSettlement || options.pendingRequest;
    if (failure) await assert.rejects(run, options.closeFails ? /controlled owned close rejection/
      : options.missingEnd ? /no accepted end|400/ : options.pendingRequest ? /drain|settled|dispatched/ : /settle/);
    else assert.equal((await run()).kind, 'answer');
    const turns = await parent.readScopeOpenedTurns(scope);
    assert.equal(turns.length, 1);
    const turn = turns[0]!.fact.turn;
    const checkpoint = await helper.readSemanticCheckpointExact(turn);
    assert.equal(checkpoint !== null, !failure);
    assert.equal(closes, options.owned ? 1 : 0);
    if (options.missingEnd) {
      // The failed continuation cannot create semantic success. Do not make
      // the independently observed epoch-failure decoder defect an invariant.
      return;
    }
    const snapshot = await readSnapshot(turn);
    assert.equal(snapshot.resourceClose !== null, !!options.owned && !options.closeFails);
    if (!failure) {
      assert.equal(drains, 1);
      assert.equal(snapshot.providerSettlements.at(-1)?.fact.settlement.state, 'succeeded');
      assert.equal(snapshot.providerSettlements.at(-1)?.fact.settlement.resourceRelease.state, 'released');
      const latest = new Map(snapshot.requests.map(entry => [entry.fact.request.requestId, entry.fact.phase]));
      assert.ok([...latest.values()].every(phase => phase === 'settled'));
      assert.ok(snapshot.endControls?.some(entry => entry.fact.kind === 'submission' && entry.fact.result.kind === 'accepted'));
    }
    if (!options.owned) {
      // An independent execution on the same adapter proves it remains usable;
      // zero close calls alone would not establish compatibility.
      const second = createProviderExplicitBrainInterpreter({ ...scope, interactionScopeId: 'second-borrow', binding, port,
        parentJournal: parent, checkpointJournal: helper, helperJournal: helper, turnHelperJournal: helper,
        rawEvidence: evidence, rawContent: providerRawContentReader(evidence), clock: { now: () => new Date().toISOString() },
        helperFactory: async () => { throw new Error('no helpers'); }, templateRoot: join(process.cwd(), 'packages/agent-templates/templates') });
      if (!failure) assert.equal((await second.interpret({ interactionId: 'second', inputRevision: 1,
        sourceRef: 'test:borrow', rawInput: 'hello', clarifications: [], taskCandidates: [] })).kind, 'answer');
      assert.equal(closes, 0);
    }
  } finally {
    await close(binding);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    assert.equal(server.address(), null);
    console.log(`released borrowed lifecycle listener and fixture ${root}`);
  }
}

test('borrowed provider accepts a real ended settled turn without closing the shared provider', () => scenario());
test('owned provider accepts a real ended settled turn only after physical close', () => scenario({ owned: true }));
test('owned close rejection cannot produce a checkpoint or a close fact', () => scenario({ owned: true, closeFails: true }));
test('borrowed provider ordinary terminal text cannot replace an accepted end', () => scenario({ missingEnd: true }));
test('borrowed provider missing settlement cannot produce a checkpoint', () => scenario({ missingSettlement: true }));
test('borrowed provider stopped settlement cannot produce a successful checkpoint', () => scenario({ stoppedSettlement: true }));
test('borrowed provider pending request cannot produce a checkpoint', () => scenario({ pendingRequest: true }));
