import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Production composition → codec → admission/executor → durable result → next
// model request → correction. Known failures: invalid bash inputs can execute or
// sever continuation; recognizable malformed JSON must remain a tool failure.
// Cost: isolated local HTTP and short marker commands, no browser/real provider.
// Evidence roots are retained, including on assertion failure.
const evidenceDir = process.env.CATALOG_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'humanagent-tool-catalog-evidence-'));
const protocol = process.env.CATALOG_PROTOCOL ?? 'responses';
const build = resolve(process.env.CATALOG_APP_BUILD ?? 'dist/app');
assert.ok(['responses', 'anthropic'].includes(protocol), 'supported fixture protocol');
const load = (p) => import(pathToFileURL(join(build, p)).href);
const { startUiRuntime, uiRuntimeControlJournalPath } = await load('app/src/ui-runtime/index.js');
const { AccessControlService } = await load('app/src/ui-runtime/access-control.js');
const { prepareAgentProvider, prepareExecutionAgentProvider, createAgentProviderPort } = await load('app/src/agent-driver-composition.js');
const { id } = await load('contracts/src/index.js');
const { JsonlOrganJournal } = await load('adapters/jsonl/src/index.js');
const { JsonlTaskGrantJournal } = await load('adapters/jsonl/src/task-grants.js');
const { MemoryCoordinator } = await load('runtime/src/index.js');
const { DeterministicMemoryBackend } = await load('adapters/memory/src/index.js');
const { FakeReplayExecutionRuntimePort } = await load('app/src/ui-runtime/fake-port.js');
const { resolveRuntimePaths, ensureControlLayout } = await load('config/src/index.js');
const { acquireDaemonLease } = await load('app/src/supervisor/index.js');
const { ResponsesProviderCodec, AnthropicProviderCodec } = await load('adapters/provider/src/index.js');

let capturedTools;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const terminal = event => event.kind === 'execution.terminal' && event.terminalPhase === 'final';
const returnedItems = wire => protocol === 'responses' ? wire.input.filter(i => i.type === 'function_call_output') :
  wire.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(i => i.type === 'tool_result') : []);
const outputText = item => typeof item.output === 'string' ? item.output : typeof item.content === 'string' ? item.content :
  item.content.map(c => c.text ?? '').join('');
const report = item => JSON.parse(outputText(item).split('\n[HumanAgent evidence refs]\n')[0]);

test('production catalog enforces tool contracts and keeps correction in one execution', { timeout: 120000 }, async (t) => {
  await mkdir(evidenceDir, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'humanagent-tool-catalog-')));
  const posts = []; const results = []; let scenario; let round = 0;
  const server = createServer((req, res) => { void (async () => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const wire = JSON.parse(Buffer.concat(chunks).toString());
    const current = scenario;
    const stage = round++;
    posts.push({ scenario: current.label, round: stage, path: req.url, wire,
      workspaceFiles: await readdir(join(root, 'workspace')) });
    const responseId = `controlled-${posts.length}`;
    // The correction is issued only after the original result reaches the next
    // request. Hold after its result so normal stop owns fixture cancellation.
    if (stage === (current.correct ? 2 : 1)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': controlled next request captured\n\n');
      current.captured.resolve();
      return;
    }
    const callId = stage === 0 ? current.label : `corrected-${current.label}`;
    const tool = stage === 0 ? current.tool ?? 'bash' : 'bash';
    const args = stage === 0 ? current.raw ?? JSON.stringify(current.args) : JSON.stringify(current.correct);
    const item = { type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', call_id: callId, name: tool, arguments: args } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = protocol === 'responses' ? [{ type: 'response.created', response: { id: responseId } }, item,
      { type: 'response.completed', response: { id: responseId } }] : [
        { type: 'message_start', message: { id: responseId, type: 'message', role: 'assistant', content: [] } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: tool, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ];
    res.end(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''));
  })().catch(e => { res.writeHead(500); res.end(String(e)); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let runtime; let lease;
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const binding = { bindingId: 'catalog', providerId: 'catalog', protocol, endpointRef: endpoint,
      modelRef: 'fixed-model', configDigest: 'fixture', capabilityDigest: 'fixture' };
    const agentProviderBindings = ['interaction', 'execution', 'planner', 'review'].map(roleId => ({ agentId: `catalog-${roleId}`, roleId, source: 'agent',
      provider: { source: 'http', provider: 'http', binding: 'catalog', protocol, model: 'fixed-model', route: 'fixture', baseUrl: endpoint } }));
    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'security/access.json'), create: true });
    const workspaceRoot = join(root, 'workspace'); await mkdir(workspaceRoot);
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: workspaceRoot });
    await ensureControlLayout(paths);
    lease = await acquireDaemonLease(paths, { ownerId: 'catalog-whitebox' });
    const common = { agentProviderBindings, evidenceRoot: join(root, 'assets') };
    runtime = await startUiRuntime({ mode: 'rcc', productRoot: root, accessControl, lease, organId: id('organ', 'catalog'), binding,
      port: new FakeReplayExecutionRuntimePort({ binding }), providerSource: 'http', checkpointRoot: join(root, 'checkpoints'),
      evidenceRoot: join(root, 'assets'), workspaceRoot, projectKey: 'catalog', uiRoot: resolve('docs/ui'), portNumber: 0,
      explicitBrainTemplateRoot: resolve(process.env.CATALOG_TEMPLATE_ROOT ?? 'packages/agent-templates/templates'),
      agentRoster: [{ agentId: 'catalog-execution', roleId: 'execution' }],
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'catalog', roleId: 'execution' },
      runtimeComposition: {
        prepareAgentProvider: selection => prepareAgentProvider({ ...common, ...selection }),
        prepareTaskAgentProvider: (selection, owner, lease) => prepareExecutionAgentProvider({ ...selection, agentProviderBindings,
          createPort: selected => createAgentProviderPort(selected, common.evidenceRoot) }, owner, lease),
      },
    });
    const matrix = [
      { label: 'valid', args: { command: 'printf yes >> valid', description: 'marker', workdir: '.', timeoutMs: 1000 }, success: true },
      { label: 'missing-command', args: { description: 'marker' } },
      { label: 'missing-description', args: { command: 'printf yes > missing-description' } },
      { label: 'wrong-command', args: { command: 7, description: 'marker' } },
      { label: 'wrong-description', args: { command: 'printf yes > wrong-description', description: 7 } },
      { label: 'wrong-workdir', args: { command: 'printf yes > wrong-workdir', description: 'marker', workdir: 7 } },
      { label: 'wrong-timeout', args: { command: 'printf yes > wrong-timeout', description: 'marker', timeoutMs: 'bad' } },
      { label: 'zero-timeout', args: { command: 'printf yes > zero-timeout', description: 'marker', timeoutMs: 0 } },
      { label: 'over-timeout', args: { command: 'printf yes > over-timeout', description: 'marker', timeoutMs: 120001 } },
      { label: 'fraction-timeout', args: { command: 'printf yes > fraction-timeout', description: 'marker', timeoutMs: 1.5 } },
      { label: 'extra-property', args: { command: 'printf yes > extra-property', description: 'marker', extra: true } },
      { label: 'empty-command', args: { command: ' ', description: 'marker' } },
      { label: 'empty-description', args: { command: 'printf yes > empty-description', description: ' ' } },
      // Reserved fixture name, not a claim that a legitimate new tool is banned.
      { label: 'unknown-tool', tool: 'whitebox_unregistered_tool', args: { command: 'printf yes > unknown-tool', description: 'marker' } },
      { label: 'malformed-json', raw: '{bad' },
      { label: 'file-alias', tool: protocol === 'responses' ? 'file_list' : 'file.list', args: { path: '.' }, success: true, readOnly: true },
    ];
    for (const sample of matrix) {
      scenario = { ...sample, captured: deferred(),
        ...(!sample.success ? { correct: { command: `printf yes >> corrected-${sample.label}`, description: 'corrected marker', workdir: '.', timeoutMs: 1000 } } : {}) }; round = 0;
      const task = runtime.service.createTask({ title: sample.label });
      const journal = new JsonlOrganJournal(uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc')));
      await new JsonlTaskGrantJournal(journal).grant({ requestId: `grant-${sample.label}`, taskId: task.taskId,
        owner: accessControl.readProductPrincipalOwner(), capability: { actionId: 'task.execute', capabilities: ['provider.execution'],
          scope: { organId: id('organ', 'catalog'), taskId: task.taskId } }, expectedRevision: 0 });
      let error; let started;
      try { started = await runtime.service.startExecution(task.taskId, { prompt: 'controlled tool catalog probe' }); } catch (e) { error = e.message; }
      // Wait for a semantic endpoint, never for a guessed request count/sleep.
      // The timeout is only a bounded failure guard; it does not signal success.
      const ended = deferred();
      const subscription = started ? runtime.service.subscribeReplay(started.operationId, undefined, event => {
        if (terminal(event)) ended.resolve();
      }) : undefined;
      if (subscription?.replay.some(terminal) || !started) ended.resolve();
      let timeout;
      try {
        await Promise.race([scenario.captured.promise, ended.promise, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`no next request or durable terminal: ${sample.label}`)), 15000);
        })]);
      } finally { clearTimeout(timeout); subscription?.unsubscribe(); }
      const dashboard = runtime.service.taskDashboard(task.taskId);
      const marker = await readFile(join(workspaceRoot, sample.label), 'utf8').catch(() => null);
      results.push({ ...sample, error, marker, dashboard,
        events: started ? runtime.service.eventsSince(started.operationId) : [], requests: posts.filter(p => p.scenario === sample.label).length });
      if (dashboard.allowedActions?.includes('stop')) await runtime.service.stop(task.taskId).catch(e => { results.at(-1).stopError = e.message; });
      // Root remains available to detached observers and for durable replay.
    }
    const raw = await readFile(uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc')), 'utf8');
    await writeFile(join(evidenceDir, 'journal.jsonl'), raw);
    await writeFile(join(evidenceDir, 'capture.json'), JSON.stringify({ posts, results }, null, 2));
    const implicit = posts.find(p => p.scenario === 'valid'); assert.ok(implicit);
    capturedTools = implicit.wire.tools;
    assert.equal(new Set(implicit.wire.tools.map(t => t.name)).size, implicit.wire.tools.length);
    const bash = implicit.wire.tools.find(t => t.name === 'bash');
    assert.deepEqual((bash.parameters ?? bash.input_schema).required, ['command', 'description']);
    assert.equal((bash.parameters ?? bash.input_schema).additionalProperties, false);
    const toolResults = [];
    const visit = obj => { if (!obj || typeof obj !== 'object') return;
      if (obj.kind === 'tool-result' && obj.result) toolResults.push(obj);
      for (const value of Object.values(obj)) visit(value);
    };
    for (const line of raw.trim().split('\n')) visit(JSON.parse(line));
    await writeFile(join(evidenceDir, 'tool-results.json'), JSON.stringify(toolResults, null, 2));
    for (const sample of results.filter(r => r.dashboard)) await t.test(sample.label, async () => {
      const { label } = sample;
      assert.equal(sample.error, undefined, 'execution starts');
      assert.equal(sample.marker, sample.success && !sample.readOnly ? 'yes' : null, 'only valid bash produces effects');
      const next = posts.find(p => p.scenario === label && p.round === 1);
      assert.ok(next, 'tool result reaches next model request, including malformed JSON');
      const paired = returnedItems(next.wire).filter(i => (i.call_id ?? i.tool_use_id) === label);
      assert.equal(paired.length, 1, 'one result paired with original callId');
      const durable = toolResults.filter(r => r.callId === label);
      assert.ok(durable.length, 'production durable tool result');
      const result = durable[0].result;
      assert.equal(result.status, sample.success ? 'succeeded' : 'failed');
      const rawOutput = await readFile(durable[0].rawOutput.ref.locator, 'utf8');
      assert.ok(outputText(paired[0]) === rawOutput || outputText(paired[0]).startsWith(`${rawOutput}\n[HumanAgent evidence refs]\n`),
        'exact durable output forwarded');
      if (!sample.success) {
        assert.ok(result.error, 'typed failure');
        if (label === 'unknown-tool') {
          assert.equal(result.error.code, 'tool.not.owned');
          assert.equal(result.error.category, 'capability');
        } else {
          assert.equal(result.error.nextAction.kind, 'continue');
          if (label !== 'malformed-json') {
            assert.equal(report(paired[0]).status, 'failed');
            assert.equal(result.error.code, 'tool.argument.invalid');
          }
        }
        // Error semantics are asserted from the durable typed result and its
        // exact forwarded output. Anthropic's optional is_error is not required
        // by this app contract; do not invent a separate wire-flag gate.
        assert.deepEqual(next.workspaceFiles, posts.find(p => p.scenario === label && p.round === 0).workspaceFiles,
          'invalid input has no workspace effect before correction');
        const after = posts.find(p => p.scenario === label && p.round === 2);
        assert.ok(after, 'corrected result reaches following request');
        const correctedId = `corrected-${label}`;
        const corrected = returnedItems(after.wire).filter(i => (i.call_id ?? i.tool_use_id) === correctedId);
        assert.equal(corrected.length, 1);
        assert.equal(report(corrected[0]).exitCode, 0);
        assert.equal(report(corrected[0]).aborted, false);
        assert.equal(report(corrected[0]).timedOut, false);
        assert.equal(await readFile(join(workspaceRoot, correctedId), 'utf8'), 'yes', 'corrected command executes once');
        const success = toolResults.find(r => r.callId === correctedId)?.result;
        assert.equal(success?.status, 'succeeded');
        for (const key of ['taskId', 'operationId', 'executionEpoch']) assert.deepEqual(success[key], result[key], `same ${key}`);
        assert.deepEqual(result.taskId, sample.dashboard.taskId);
        const calls = sample.events.filter(e => e.kind === 'provider.tool' && [label, correctedId].includes(e.callId));
        assert.equal(calls.length, 2, 'one original and one corrected call');
        for (const call of calls) for (const key of ['taskId', 'operationId', 'executionEpoch'])
          assert.equal(call[key]?.value ?? call[key], result[key]?.value ?? result[key], `call/result ${key}`);
      } else if (!sample.readOnly) assert.equal(report(paired[0]).exitCode, 0);
    });
    await t.test('unconfigured web backend is not advertised', () => {
      // startUiRuntimeOptions.webSearchProviderConfig documents: without it,
      // web.search is not wired. Do not bless the historical unconditional ad.
      assert.equal(implicit.wire.tools.some(tool => ['web_search', 'web.search'].includes(tool.name)), false);
    });
    console.log(JSON.stringify({ protocol, implicit: implicit.wire.tools.map(t => t.name),
      results: results.map(r => ({ label: r.label, marker: r.marker, requests: r.requests, error: r.dashboard?.error })),
      typedErrors: toolResults.filter(f => f.result.error).map(f => ({ callId: f.callId, error: f.result.error })) }, null, 2));
  } finally {
    let closeError;
    try { if (runtime) await runtime.close(); } catch (error) { closeError = String(error); }
    const releasedLease = lease ? await lease.release() : undefined;
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    // Persist partial evidence on fixture/timeout failure as well.
    await writeFile(join(evidenceDir, 'capture.json'), JSON.stringify({ protocol, build, root, posts, results }, null, 2));
    if (runtime) await writeFile(join(evidenceDir, 'journal.jsonl'),
      await readFile(uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc')), 'utf8'));
    const cleanup = { root, evidenceRootRetained: true, closeError,
      modelServerClosed: server.address() === null, uiUrl: runtime?.server.url,
      uiServerClosed: runtime ? await fetch(runtime.server.url).then(() => false, () => true) : true,
      leaseReleased: releasedLease !== undefined, leaseDisposedAt: releasedLease?.disposedAt };
    await writeFile(join(evidenceDir, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
    console.log(JSON.stringify({ evidenceDir, build, protocol, resources: cleanup }));
    assert.equal(closeError, undefined);
    assert.equal(cleanup.modelServerClosed && cleanup.uiServerClosed, true);
  }
});

test('captured production catalog matches definitions and round-trips every wire ID', async () => {
  const tools = capturedTools;
  assert.ok(tools, 'production capture must succeed in this run');
  const definitions = Object.values(await load('app/src/provider-tool-execution.js')).filter(v => v && typeof v === 'object' && v.toolId && v.inputSchema);
  const { ADVERTISED_STANDARD_TURN_END_TOOL } = await load('app/src/ui-runtime/standard-turn-composition.js');
  definitions.push(ADVERTISED_STANDARD_TURN_END_TOOL);
  const execution = { runtimeId: 'mapping', taskId: id('task', 'mapping'), operationId: id('operation', 'mapping'), executionEpoch: 1 };
  const scope = { organId: id('organ', 'mapping'), taskId: execution.taskId, operationId: execution.operationId };
  const evidence = { async write(i) { return { evidenceId: id('evidence', 'mapping'), kind: i.kind, source: 'mapping-fixture', locator: i.locator, scope: i.scope }; } };
  const codec = protocol === 'responses' ? new ResponsesProviderCodec() : new AnthropicProviderCodec(4096);
  const binding = { bindingId: 'mapping', providerId: 'mapping', protocol, modelRef: 'fixture' };
  const encoded = codec.encodeStart({ ...execution, payload: {}, inputRefs: [], tools: definitions }, binding, 'fixture');
  // Configured subsets may grow. Check each actual ad against its declaration,
  // schema and inverse codec mapping, not a frozen catalog length/allowlist.
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
  for (const tool of tools) {
    const declaration = encoded.tools.find(t => t.name === tool.name);
    assert.ok(declaration, `declared tool: ${tool.name}`);
    assert.deepEqual(tool, declaration, `serialized declaration: ${tool.name}`);
  }
  const mapping = [];
  for (let n = 0; n < tools.length; n++) {
    const tool = tools[n]; const definition = definitions[encoded.tools.findIndex(t => t.name === tool.name)];
    const context = { execution, scope, evidence, responsesOutputText: new Map(), responsesCurrentResponseId: new Map([['current', 'mapping-response']]),
      responsesPendingToolCalls: new Set(), responsesRequestStartEmitted: new Map(), responsesStreamRound: { count: 1 }, nextEventId: () => `mapping-${n}` };
    let events = [];
    const raw = protocol === 'responses' ? [{ type: 'response.output_item.done', output_index: n,
      item: { type: 'function_call', name: tool.name, call_id: `map-${n}`, arguments: '{}' } }] : [
        { type: 'message_start', message: { id: `mapping-${n}` } },
        { type: 'content_block_start', index: n, content_block: { type: 'tool_use', id: `map-${n}`, name: tool.name, input: {} } },
        { type: 'content_block_delta', index: n, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: n },
      ];
    for (const frame of raw) events.push(...(await codec.decodeEvent({ protocol, ...frame }, context)).events);
    const call = events.find(e => e.toolCall)?.toolCall;
    assert.equal(call?.toolId, definition.toolId, tool.name);
    mapping.push({ id: definition.toolId, wire: tool.name, decoded: call.toolId, schema: definition.inputSchema });
  }
  assert.equal(new Set(mapping.map(m => m.wire)).size, mapping.length);
  await writeFile(join(evidenceDir, 'mapping.json'), JSON.stringify(mapping, null, 2));
});
