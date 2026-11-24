import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Production assembly only. No reimplementation of builder/driver/operation.
// Probability: confirmed cached-template and absent-tool seams in main.
// Impact: stale role and unavailable Skill guidance in actual model requests.
// Cost: local HTTP fixture, private template/assets, no external model.
const base = resolve(process.env.CONTEXT_APP_BUILD ?? 'dist/app');
const load = (path) => import(pathToFileURL(join(base, path)).href);
const { createProviderExplicitBrainInterpreter } = await load('app/src/explicit-brain-runtime.js');
const { prepareAgentProvider } = await load('app/src/agent-driver-composition.js');
const { id } = await load('contracts/src/index.js');
const { filesystemProviderEvidenceSink } = await load('adapters/provider/src/index.js');
const { providerRawContentReader } = await load('adapters/provider/src/evidence.js');
const { ImmutableAssetStore } = await load('adapters/filesystem/src/index.js');
const { JsonlOrganJournal } = await load('adapters/jsonl/src/index.js');
const { JsonlInteractionHelperJournal } = await load('adapters/jsonl/src/interaction-helper-journal.js');
const { JsonlInteractionParentTurnJournal } = await load('adapters/jsonl/src/interaction-parent-turn-journal.js');

const decision = { kind: 'answer', normalizedInput: 'fixture-input', knownFacts: [], decisionRefs: [], answer: 'EXACT_FIXTURE_RESULT' };
const end = { kind: 'simple', decision, checkpointRecord: { index: { action: 'Answer fixture input', result: 'EXACT_FIXTURE_RESULT' } } };

test('context production wire: history, role reload and Skill counterexamples', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-context-wire-'));
  const posts = [];
  const requestsByMode = new Map([['answer', 0], ['select', 0], ['unknown', 0]]);
  let mode = 'answer';
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (wire.tools === undefined) {
        const responseId = `fixture-drain-${posts.length + 1}`;
        posts.push({ mode, wire });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([
          { type: 'response.created', response: { id: responseId } },
          { type: 'response.output_text.done', item_id: `${responseId}-text`, text: 'drained' },
          { type: 'response.completed', response: { id: responseId } },
        ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
        return;
      }
      const requestIndex = requestsByMode.get(mode) ?? 0;
      requestsByMode.set(mode, requestIndex + 1);
      posts.push({ mode, wire });
      const hasCallResult = (callId) => wire.input?.some((item) => item.type === 'function_call_output' && item.call_id === callId);
      let item;
      if (mode === 'answer' && requestIndex === 0) item = { call_id: 'context-end-1', name: 'humanagent_turn_end', arguments: JSON.stringify(end) };
      else if (mode === 'select' && requestIndex === 0) item = { call_id: 'context-select-1', name: 'interaction_select_skills', arguments: JSON.stringify({ skillIds: ['agent-communication', 'agent-addressing'] }) };
      else if (mode === 'select' && requestIndex === 1 && hasCallResult('context-select-1')) item = { call_id: 'context-end-2', name: 'humanagent_turn_end', arguments: JSON.stringify(end) };
      else if (mode === 'unknown' && requestIndex === 0) item = { call_id: 'context-unknown-1', name: 'interaction_unregistered_fixture', arguments: JSON.stringify({ probe: true }) };
      else if (mode === 'unknown' && requestIndex === 1 && hasCallResult('context-unknown-1')) item = { call_id: 'context-end-3', name: 'humanagent_turn_end', arguments: JSON.stringify(end) };
      if (item === undefined) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `unexpected extra ${mode} request ${requestIndex}` } }));
        return;
      }
      const responseId = `fixture-${posts.length}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { type: 'response.created', response: { id: responseId } },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', ...item } },
        { type: 'response.completed', response: { id: responseId } },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    })().catch((error) => { response.writeHead(500); response.end(String(error)); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const templateRoot = join(root, 'templates');
    await cp(resolve('packages/agent-templates/templates'), templateRoot, { recursive: true });
    const rolePath = join(templateRoot, 'builtin/interaction/profiles/explicit-brain/identity.md');
    const originalRole = await readFile(rolePath, 'utf8');
    await writeFile(rolePath, `${originalRole}\nCONTEXT_ROLE_V1\n`);
    const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
    const journal = new JsonlOrganJournal(join(root, 'organ.jsonl'));
    const helperJournal = new JsonlInteractionHelperJournal(journal);
    const parentJournal = new JsonlInteractionParentTurnJournal(journal);
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const binding = { bindingId: 'context-binding', providerId: 'context-provider', protocol: 'responses',
      endpointRef: endpoint, modelRef: 'controlled-fixture', configDigest: 'fixture-config', capabilityDigest: 'fixture-capability' };
    const interpreter = createProviderExplicitBrainInterpreter({
      organId: id('organ', 'context-wire'), interactionScopeId: 'context-wire-scope',
      binding, templateRoot, parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
      rawEvidence: evidence, rawContent: providerRawContentReader(evidence), clock: { now: () => new Date().toISOString() },
      helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
      prepareAgentProvider: (selection) => prepareAgentProvider({ ...selection,
        evidenceRoot: join(root, 'assets'), agentProviderBindings: [{ agentId: 'context-agent', roleId: 'interaction', source: 'agent',
          provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
            model: binding.modelRef, route: 'context-fixture', baseUrl: endpoint } }],
      }),
    });
    const input = (name) => ({ interactionId: name, inputRevision: 1, sourceRef: 'fixture:context',
      rawInput: `RAW_${name}`, clarifications: [], taskCandidates: [] });
    const firstInput = input('first');
    const firstResult = await interpreter.interpret(firstInput);
    assert.equal(firstResult.kind, 'answer');
    const first = structuredClone(posts[0].wire);
    await writeFile(rolePath, `${originalRole}\nCONTEXT_ROLE_V2\n`);
    requestsByMode.set('answer', 0);
    const secondRequestStart = posts.length;
    const secondResult = await interpreter.interpret(input('second'));
    assert.equal(secondResult.kind, 'answer');
    const second = posts[secondRequestStart].wire;
    await t.test('committed prior checkpoint is an assistant message, current input remains user', () => {
      assert.ok(first.instructions.includes('CONTEXT_ROLE_V1'));
      const history = second.input.filter((item) => item.role === 'assistant').map((item) => JSON.parse(item.content[0].text));
      assert.equal(history.length, 1);
      assert.equal(history[0].kind, 'semantic-checkpoint');
      assert.equal(history[0].interactionId, 'first');
      assert.deepEqual(Object.keys(history[0]).sort(), ['claims','committedAt','constraints','inputRevision','interactionId','kind','turnId']);
      assert.ok(history[0].claims.some((claim) => claim.fact.includes(decision.answer)));
      const current = second.input.filter((item) => item.role === 'user');
      assert.equal(current.length, 1);
      assert.equal(JSON.parse(current[0].content[0].text).rawInput, 'RAW_second');
      assert.equal(second.input.some((item) => item.type === 'function_call' || item.type === 'function_call_output'), false);
    });
    await t.test('next new turn loads revised role using the same production interpreter', () => {
      assert.equal(second.instructions.includes('CONTEXT_ROLE_V2'), true, 'new turn must load revised role V2');
      assert.equal(second.instructions.includes('CONTEXT_ROLE_V1'), false, 'new turn must drop old role V1');
    });
    await t.test('initial serialized tools advertises executable Skill selector schema', () => {
      const selector = first.tools?.find((tool) => tool.name === 'interaction_select_skills');
      assert.ok(selector, 'main request is missing interaction_select_skills schema');
      assert.deepEqual(selector.parameters.properties.skillIds.items.enum,
        ['task-intake', 'task-follow-through', 'project-management', 'agent-addressing', 'agent-communication']);
    });
    mode = 'select';
    const selectedResult = await interpreter.interpret(input('select'));
    assert.equal(selectedResult.kind, 'answer');
    const selectedPosts = posts.filter((entry) => entry.mode === 'select');
    mode = 'unknown';
    const unknownResult = await interpreter.interpret(input('unknown'));
    assert.equal(unknownResult.kind, 'answer');
    const unknownPosts = posts.filter((entry) => entry.mode === 'unknown');
    console.log(JSON.stringify({ build: base, roleV1: second.instructions.includes('CONTEXT_ROLE_V1'),
      roleV2: second.instructions.includes('CONTEXT_ROLE_V2'), initialTools: first.tools ?? null,
      selectedRequests: selectedPosts.length, unknownRequests: unknownPosts.length }));
    await t.test('Skill selection returns its exact call result in the continuation', () => {
      const continuation = selectedPosts.find(({ wire }) => wire.input?.some((item) => item.type === 'function_call_output' && item.call_id === 'context-select-1'));
      assert.ok(continuation, 'missing matched tool-result request');
      const calls = continuation.wire.input.filter((item) => item.type === 'function_call' && item.call_id === 'context-select-1');
      const results = continuation.wire.input.filter((item) => item.type === 'function_call_output' && item.call_id === 'context-select-1');
      assert.equal(calls.length, 1); assert.equal(results.length, 1);
      assert.equal(calls[0].name, 'interaction_select_skills');
      assert.deepEqual(JSON.parse(results[0].output), { selectedSkillIds: ['agent-communication', 'agent-addressing'] });
      assert.ok(continuation.wire.input.findIndex((item) => item === calls[0]) < continuation.wire.input.findIndex((item) => item === results[0]));
    });
    await t.test('selected Skills expand in actual next model request', () => {
      const continuation = selectedPosts.find(({ wire }) => wire.input?.some((item) => item.type === 'function_call_output' && item.call_id === 'context-select-1'));
      assert.ok(continuation);
      assert.ok(continuation.wire.instructions.includes('# Selected Skill: agent-communication'));
      assert.ok(continuation.wire.instructions.includes('# Selected Skill: agent-addressing'));
      assert.equal(continuation.wire.instructions.includes('# Selected Skill: project-management'), false);
    });
    await t.test('unknown tool has a paired rejection and the turn then ends through C07', () => {
      assert.equal(unknownPosts.length, 3, 'unknown tool, paired correction/end, and bounded drain only');
      const [initial, continuation, drain] = unknownPosts.map(({ wire }) => wire);
      assert.ok(!initial.tools.some((tool) => tool.name === 'interaction_unregistered_fixture'));
      const pair = continuation.input.filter((item) => item.call_id === 'context-unknown-1');
      assert.deepEqual(pair.map((item) => item.type), ['function_call', 'function_call_output']);
      assert.equal(pair[0].name, 'interaction_unregistered_fixture');
      assert.match(pair[1].output, /not available in this Harness/);
      assert.deepEqual(drain.input.filter((item) => item.call_id === 'context-end-3').map((item) => item.type),
        ['function_call', 'function_call_output']);
      assert.equal(drain.tools, undefined);
    });
  } finally {
    if (process.env.CONTEXT_CAPTURE_DIR) {
      await mkdir(process.env.CONTEXT_CAPTURE_DIR, { recursive: true });
      await writeFile(join(process.env.CONTEXT_CAPTURE_DIR, 'main-context-wire.json'), JSON.stringify(posts, null, 2));
    }
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    console.log('CLEANUP: controlled HTTP server closed; private template/journal/assets removed');
  }
});

test('historical candidate capture: selected rule content and tool pairing (not current candidate execution)', async () => {
  const capture = '/Volumes/extension/playground/humanagent/mvp-delivery-audit-20261122/Skill规则引用请求证据-20261122.html';
  const html = await readFile(capture, 'utf8');
  const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const wires = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((match) => JSON.parse(decode(match[1])));
  const [initial, selected, drain, nextInitial, nextSelected] = wires;
  assert.deepEqual(initial.tools.map((tool) => tool.name), ['interaction_select_skills', 'humanagent_turn_end']);
  const schema = initial.tools.find((tool) => tool.name === 'interaction_select_skills');
  assert.deepEqual(schema.parameters.properties.skillIds.items.enum,
    ['task-intake', 'project-management', 'agent-addressing', 'agent-communication']);
  assert.equal(initial.instructions.includes('# Selected Skill:'), false);
  assert.equal(initial.instructions.includes('# Skill rule reference:'), false);
  assert.ok(selected.instructions.includes('# Selected Skill: agent-communication'));
  assert.ok(selected.instructions.includes('# Skill rule reference: rules/message-timing.md'));
  assert.ok(selected.instructions.includes('TIMING_RULE_V1'));
  assert.equal(selected.instructions.includes('# Selected Skill: agent-addressing'), false);
  assert.equal(nextInitial.instructions.includes('# Skill rule reference:'), false);
  assert.ok(nextSelected.instructions.includes('TIMING_RULE_V2'));
  assert.equal(nextSelected.instructions.includes('TIMING_RULE_V1'), false);
  const assertPair = (wire) => {
    const calls = wire.input.filter((item) => item.type === 'function_call' && item.name === 'interaction_select_skills');
    assert.equal(calls.length, 1);
    const results = wire.input.filter((item) => item.type === 'function_call_output' && item.call_id === calls[0].call_id);
    assert.equal(results.length, 1, 'selected Skill result must match exact call_id');
    assert.equal(wire.input.some((item) => item.role === 'user' && JSON.stringify(item).includes('TIMING_RULE_V1')), false);
    return results[0].output;
  };
  const output = assertPair(selected);
  const invalid = structuredClone(selected);
  invalid.input.find((item) => item.type === 'function_call_output').call_id = 'wrong-call';
  assert.throws(() => assertPair(invalid), /selected Skill result must match exact call_id/);
  assert.ok(drain.input.some((item) => item.type === 'function_call_output' && item.call_id === 'turn-end'));
  const multiHtml = await readFile('/Volumes/extension/playground/humanagent/mvp-delivery-audit-20261122/Skill按需加载请求证据-20261122.html', 'utf8');
  const multiWires = [...multiHtml.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((match) => JSON.parse(decode(match[1])));
  const multi = multiWires[3];
  assert.deepEqual([...multi.instructions.matchAll(/# Selected Skill: ([^\n]+)/g)].map((match) => match[1]),
    ['task-intake', 'project-management', 'agent-addressing', 'agent-communication']);
  assertPair(multi);
  assert.deepEqual(JSON.parse(multi.input.find((item) => item.type === 'function_call').arguments).skillIds,
    ['task-intake', 'project-management', 'agent-addressing', 'agent-communication']);
  console.log(JSON.stringify({ historicalCandidateCapture: capture, selectedToolOutput: output,
    ruleV1: true, nextNewTurnRuleV2: true, wrongCallIdRejected: true, multiSkillCapture: true }));
});
