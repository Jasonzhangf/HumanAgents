// Run after: pnpm exec tsc -p tests/app/tsconfig.json
// This is an explicit test entry. It does not start or restart any service.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { id } from '../../dist/tests/packages/contracts/src/index.js';
import { createProviderExplicitBrainInterpreter } from '../../dist/tests/packages/app/src/explicit-brain-runtime.js';
import { ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } from '../../dist/tests/packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../dist/tests/packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../dist/tests/packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../dist/tests/packages/adapters/jsonl/src/index.js';
import { JsonlInteractionParentTurnJournal } from '../../dist/tests/packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { JsonlInteractionHelperJournal } from '../../dist/tests/packages/adapters/jsonl/src/interaction-helper-journal.js';

const baseUrl = process.env.HUMANAGENT_C07_RCC_URL ?? 'http://127.0.0.1:4444';
const model = process.env.HUMANAGENT_C07_RCC_MODEL ?? 'gpt-5.5';
const health = await (await fetch(`${baseUrl}/health`)).json();
assert.equal(health.status, 'ok');
assert.ok(health.server_id?.startsWith('routecodex'));
const parent = join(homedir(), '.humanagent', 'test-fixtures');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'c07-rcc-explicit-end-'));
const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
const journal = new JsonlOrganJournal(join(root, 'organ.jsonl'));
const parentJournal = new JsonlInteractionParentTurnJournal(journal);
const helperJournal = new JsonlInteractionHelperJournal(journal);
const organId = id('organ', 'c07-rcc-explicit-end');
const interactionScopeId = 'c07-rcc-explicit-end';
const binding = { bindingId: 'c07-rcc', providerId: 'rcc', protocol: 'responses', endpointRef: baseUrl,
  modelRef: model, configDigest: 'live:rcc-test', capabilityDigest: 'live:rcc-test' };
const ports = [];
const interpreter = createProviderExplicitBrainInterpreter({
  organId, interactionScopeId, binding, parentJournal, helperJournal, checkpointJournal: helperJournal,
  turnHelperJournal: helperJournal, rawEvidence: evidence, rawContent: providerRawContentReader(evidence),
  templateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
  helperFactory: async () => { throw new Error('explicit brain must not execute business tasks'); },
  clock: { now: () => new Date().toISOString() },
  prepareAgentProvider: async () => {
    const port = new ProviderAdapter({ binding, routeRef: model, codec: new ResponsesProviderCodec(), evidence,
      transport: new V3ProviderHttpTransport({ binding, baseUrl, source: 'rcc', evidence }) });
    ports.push(port);
    return { roleId: 'interaction', source: 'rcc', binding, port,
      provider: { source: 'rcc', provider: 'rcc', binding: binding.bindingId, protocol: 'responses',
        model, route: model, baseUrl } };
  },
});
const receipt = { root, baseUrl, model, cases: [] };
try {
  for (const [name, rawInput, expected] of [
    ['simple', '你好，请简短介绍你的职责。', 'answer'],
    ['complex', '请创建一个任务：在项目中整理一份 README 改进报告，交付 Markdown 文件。现在只整理并投递需求，不执行报告任务。', 'requirement'],
  ]) {
    const result = await interpreter.interpret({ interactionId: `c07-rcc-${name}`, inputRevision: 1,
      sourceRef: `test:c07-rcc-${name}`, rawInput, clarifications: [], taskCandidates: [] });
    const turns = await parentJournal.readScopeOpenedTurns({ organId, interactionScopeId });
    const turn = turns.find(entry => entry.fact.turn.interactionId === `c07-rcc-${name}`).fact.turn;
    const snapshot = await parentJournal.readTurnSnapshot(turn);
    const checkpoint = await helperJournal.readSemanticCheckpointExact(turn);
    const end = snapshot.endControls.filter(entry => entry.fact.kind === 'submission').at(-1)?.fact;
    receipt.cases.push({ name, result, turn, end: end?.result, checkpoint: checkpoint?.checkpoint,
      settlement: snapshot.providerSettlements.at(-1)?.fact, close: snapshot.resourceClose?.fact.result });
    assert.equal(result.kind, expected);
    assert.equal(end?.result.kind, 'accepted');
    assert.ok(checkpoint);
    assert.equal(snapshot.resourceClose?.fact.result.state, 'closed');
    console.log(JSON.stringify({ name, result: result.kind, accepted: end.result.kind, checkpoint: true, closed: true }));
  }
} catch (error) {
  receipt.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  const cleanup = await Promise.allSettled(ports.map(port => port.close(binding)));
  receipt.cleanup = cleanup.map(result => result.status === 'fulfilled'
    ? { state: result.value.state } : { error: result.reason.message });
  if (cleanup.some(result => result.status === 'rejected')) {
    process.exitCode = 1;
    console.error('Provider close failed; see receipt cleanup.');
  }
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`receipt: ${join(root, 'receipt.json')}`);
}
