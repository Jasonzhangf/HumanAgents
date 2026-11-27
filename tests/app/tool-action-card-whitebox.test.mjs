import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run against a private strict app build; TOOL_ACTION_SOURCE records its source.
// Risk: confirmed raw JSON cards hide file changes; task identity can collide.
// Impact: misleading effects or another task's content. Cost: local files and
// one short bash per task; no browser, network listener, or external model.
const base = resolve(process.env.TOOL_ACTION_APP_BUILD ?? 'dist/app');
const load = p => import(pathToFileURL(join(base, p)).href);
const { id } = await load('contracts/src/index.js');
const { ProviderAdapter, ResponsesProviderCodec, createV3ProviderHttpTransport, filesystemProviderEvidenceSink } = await load('adapters/provider/src/index.js');
const { ImmutableAssetStore } = await load('adapters/filesystem/src/index.js');
const { JsonlOrganJournal } = await load('adapters/jsonl/src/index.js');
const toolsModule = await load('app/src/provider-tool-execution.js');
const { UiRuntimeService, UiRuntimeJournal, FileCheckpointStore } = await load('app/src/ui-runtime/index.js');
const { createPreparedOperationBoundary } = await load('app/src/prepared-operation-boundary.js');
const { createServiceExecutionAdmission } = await load('app/src/ui-runtime/execution-composition.js');
const { MemoryCoordinator } = await load('runtime/src/index.js');
const { DeterministicMemoryBackend } = await load('adapters/memory/src/index.js');
const ui = await import('../../docs/ui/tool-presentation.js');
const definitions = ['READ', 'WRITE', 'EDIT', 'SEARCH'].map(n => toolsModule[`RESPONSES_FILE_${n}_TOOL`]).concat(toolsModule.RESPONSES_BASH_TOOL);

function contract(card) {
  assert.equal(typeof card?.title, 'string');
  assert.ok(card.title.trim());
  for (const key of ['subject', 'summary']) if (card[key] !== undefined) assert.equal(typeof card[key], 'string');
  if (card.lines !== undefined) {
    assert.ok(Array.isArray(card.lines));
    assert.ok(card.lines.length <= 80, 'main face must be a bounded preview');
    for (const line of card.lines) {
      assert.ok(['text', 'add', 'remove', 'context'].includes(line.kind));
      assert.equal(typeof line.text, 'string');
    }
  }
  return card;
}
const text = card => [card.title, card.subject, card.summary, ...(card.lines ?? []).map(l => l.text)].filter(v => v !== undefined).join('\n');

test('real tools → scoped reader → action mapper, including same callId across tasks', async t => {
  await mkdir(join(homedir(), '.humanagent'), { recursive: true });
  const root = await mkdtemp(join(homedir(), '.humanagent', 'tool-action-card-whitebox-'));
  const receipt = { source: process.env.TOOL_ACTION_SOURCE ?? 'unspecified (build path only)', build: base,
    uiSource: resolve('docs/ui'), root, posts: [], executions: [], samples: [], refusals: [] };
  const journal = new UiRuntimeJournal(join(root, 'projection.jsonl'));
  const control = new JsonlOrganJournal(join(root, 'control.jsonl'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const owner = 'tool-action-card-whitebox';
  const organId = id('organ', owner);
  const admission = createServiceExecutionAdmission({ journal: control, preparedJournal: journal, principalOwner: owner,
    resourceBoundary: createPreparedOperationBoundary(journal), now: () => new Date() });
  const built = toolsModule.createResponsesFileToolExecutor({ workspaceRoot, projectKey: owner, artifactRoot: join(root, 'artifacts'), admission: {
    organJournal: control, currentTaskGrantPort: admission.permissions, principalOwner: owner,
    resourceBoundary: admission.resourceBoundary, admitToolOperation: admission.admitToolOperation, now: () => new Date(),
    bindingFor: async request => {
      const record = journal.replay().find(r => r.kind === 'operation.prepared' && r.allocation.operationId.value === request.execution.operationId.value);
      assert.ok(record, 'real prepared allocation required');
      return admission.bindingFor(record.allocation);
    },
  } });
  const binding = { bindingId: owner, providerId: 'controlled-whitebox', protocol: 'responses', endpointRef: 'endpoint://whitebox',
    modelRef: 'whitebox', configDigest: 'fixture', capabilityDigest: 'fixture' };
  const sink = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'provider-evidence')));
  let selectedCases = [], requestIndex = 0;
  const adapter = new ProviderAdapter({ binding, routeRef: owner, codec: new ResponsesProviderCodec(), evidence: sink,
    transport: createV3ProviderHttpTransport({ binding, baseUrl: 'http://127.0.0.1:1', evidence: sink, fetch: async (url, init) => {
      if (url.endsWith('/health')) return { status: 200, body: null, text: async () => '{"status":"ok","version":"whitebox"}' };
      if (url.endsWith('/v1/models')) return { status: 200, body: null, text: async () => '{"data":[{"id":"whitebox"}]}' };
      assert.ok(url.endsWith('/v1/responses'));
      const wire = JSON.parse(init.body); receipt.posts.push(wire);
      const c = selectedCases[requestIndex++];
      const response = { id: `action-response-${receipt.posts.length}` };
      const frames = [{ type: 'response.created', response }, ...(c ? [{ type: 'response.output_item.done', output_index: 0,
        item: { type: 'function_call', call_id: c.callId, name: c.toolId.replaceAll('.', '_'), arguments: JSON.stringify(c.args) } }] :
        [{ type: 'response.output_text.done', item_id: 'done', text: 'Local fixture complete.' }]), { type: 'response.completed', response }];
      return { status: 200, text: async () => '', body: (async function* () {
        for (const f of frames) yield new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`);
      })() };
    } }) });
  const service = new UiRuntimeService({ mode: 'rcc', organId, binding, port: adapter, providerState: 'ready', journal, closurePort: journal,
    checkpointStoreFor: taskId => new FileCheckpointStore(join(root, `checkpoint-${taskId.value}.jsonl`)),
    attentionPort: { async publish(v) { return { attentionId: v.attentionId, delivered: true }; }, async resolve(v) { return { attentionId: v.attentionId, delivered: true }; } },
    workspaceRoot, projectKey: owner, providerTools: definitions,
    providerToolExecutor: { execute: async request => {
      const result = await built.executor.execute(request);
      receipt.executions.push({ request: { ...request, signal: undefined }, result });
      return result;
    } }, toolOutputStore: built.toolOutputs, providerToolRoundLimit: 12,
    memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: owner, roleId: 'execution' },
    explicitBrainInterpreter: { async interpret() { throw new Error('not part of tool-card fixture'); } },
    runtimeComposition: { admitExecution: async allocation => {
      await admission.grants.grant({ requestId: `grant:${allocation.taskId.value}`, taskId: allocation.taskId, owner,
        capability: { actionId: 'task.execute', capabilities: ['provider.execution'], scope: { organId, taskId: allocation.taskId } }, expectedRevision: 0 });
      await admission.admitExecution(allocation);
    } },
  });
  try {
    for (const label of ['alpha', 'beta']) {
      const path = `${label}/空 格.txt`;
      const before = `${label} before\n<script>literal & safe</script>\n`;
      const after = `${label} after\n<script>literal & safe</script>\n`;
      const edited = after.replace('after', 'edited');
      selectedCases = [
        { callId: 'create', toolId: 'file.write', args: { file_path: path, content: before } },
        { callId: 'overwrite', toolId: 'file.write', args: { file_path: path, content: after } },
        { callId: 'edit', toolId: 'file.edit', args: { file_path: path, old_string: 'after', new_string: 'edited' } },
        { callId: 'read', toolId: 'file.read', args: { path } },
        { callId: 'hit', toolId: 'file.search', args: { path: label, query: `${label} edited`, queryKind: 'literal', contextLines: 0 } },
        { callId: 'miss', toolId: 'file.search', args: { path: label, query: 'ABSENT_NEEDLE', queryKind: 'literal' } },
        { callId: 'shell', toolId: 'bash', args: { command: `printf '${label} shell'; printf '${label} stderr' >&2`, description: 'local fixture' } },
      ];
      requestIndex = 0;
      const task = service.createTask({ title: `${label} tool card`, directive: 'Controlled local tools only' });
      const firstPost = receipt.posts.length;
      await service.startExecution(task.taskId, { prompt: 'controlled tools' });
      const deadline = Date.now() + 15000;
      while (!['succeeded', 'failed', 'blocked'].includes(service.taskDashboard(task.taskId).state)) {
        assert.ok(Date.now() < deadline, 'runtime must settle');
        await new Promise(r => setTimeout(r, 20));
      }
      const dashboard = service.taskDashboard(task.taskId);
      receipt.lastDashboard = { taskId: task.taskId, state: dashboard.state };
      assert.equal(dashboard.state, 'succeeded', journal.replay().filter(r => r.kind === 'operation.event' && r.event.kind === 'provider.error').map(r => r.event.summary).join('; '));
      const events = journal.replay().filter(r => r.kind === 'operation.event').map(r => r.event);
      for (const c of selectedCases) {
        const pair = events.filter(e => e.taskId?.value === task.taskId.value && e.callId === c.callId);
        const row = ui.toolPresentations(pair)[0];
        assert.ok(row?.call && row?.result && row.outputTarget, `missing actual readable result: ${c.callId}`);
        assert.deepEqual(row.call.arguments, c.args);
        assert.equal(row.call.toolId, c.toolId);
        const target = row.outputTarget;
        const report = await service.toolOutput(target.taskId, id('operation', target.operationId), target.executionEpoch, target.seq);
        const actual = receipt.executions.find(e => e.request.execution.taskId.value === task.taskId.value && e.request.call.callId === c.callId);
        assert.ok(actual);
        assert.deepEqual(report, JSON.parse(actual.result.output));
        const wire = receipt.posts.slice(firstPost).flatMap(p => p.input ?? []).find(v => v.type === 'function_call_output' && v.call_id === c.callId);
        assert.ok(wire, 'same actual report must reach next provider request');
        assert.deepEqual(JSON.parse(wire.output.split('\n[HumanAgent evidence refs]\n')[0]), report);
        const sample = { label, c, call: row.call, result: row.result, target, report };
        receipt.samples.push(sample);
        if (c.callId === 'create') assert.deepEqual(report, { path, operation: 'create', before: null, after: before });
        if (c.callId === 'overwrite') assert.deepEqual(report, { path, operation: 'update', before, after });
        if (c.callId === 'edit') assert.deepEqual(report, { path, before: after, after: edited });
        if (c.callId === 'read') { assert.equal(report.path, path); assert.equal(report.content, edited); }
        if (c.callId === 'hit') { assert.ok(JSON.stringify(report).includes(`${label} edited`)); assert.ok(JSON.stringify(report).includes(path)); }
        if (c.callId === 'miss') assert.equal(report.matches.length, 0);
        if (c.callId === 'shell') { assert.equal(report.stdout.text, `${label} shell`); assert.equal(report.stderr.text, `${label} stderr`); assert.equal(report.exitCode, 0); }
      }
      assert.equal(await readFile(join(workspaceRoot, path), 'utf8'), edited);
    }
    await t.test('same callId stays task scoped; wrong task/operation/epoch is refused', async () => {
      const a = receipt.samples[0], b = receipt.samples.find(s => s.label === 'beta');
      assert.equal(a.call.callId, b.call.callId);
      assert.equal(ui.toolPresentations([a.call, b.call, b.result, a.result]).length, 2);
      assert.notDeepEqual(a.report, b.report);
      for (const target of [ { ...a.target, taskId: b.target.taskId }, { ...a.target, operationId: 'wrong-operation' }, { ...a.target, executionEpoch: a.target.executionEpoch + 1 } ]) {
        await assert.rejects(() => service.toolOutput(target.taskId, id('operation', target.operationId), target.executionEpoch, target.seq), error => {
          receipt.refusals.push({ target, code: error.code, message: error.message }); return typeof error.code === 'string';
        });
      }
    });
    await t.test('file plugin interprets actual create/update/edit/read/search reports', async () => {
      const { fileSemantics } = await import('../../docs/ui/tool-file-semantics.js');
      for (const s of receipt.samples.filter(s => s.c.toolId !== 'bash')) {
        const pending = contract(fileSemantics(s.call.toolId, s.call.arguments, undefined));
        const card = contract(fileSemantics(s.call.toolId, s.call.arguments, s.report));
        s.pending = pending; s.card = card;
        assert.equal(typeof pending.summary, 'string');
        assert.notDeepEqual(pending, card, 'undefined report must mean no body yet');
        if (s.c.toolId !== 'file.search') assert.ok(text(card).includes(s.c.args.file_path ?? s.c.args.path), 'actual path must be visible');
        else assert.ok(text(card).includes(s.c.args.query), 'search subject must preserve the query');
        if (['create', 'overwrite', 'edit'].includes(s.c.callId)) {
          assert.ok(card.lines?.some(l => l.kind === 'add' && l.text.includes(s.c.callId === 'edit' ? 'edited' : s.c.callId === 'overwrite' ? 'after' : 'before')));
          if (s.c.callId !== 'create') assert.ok(card.lines.some(l => l.kind === 'remove' && l.text.includes(s.c.callId === 'edit' ? 'after' : 'before')));
        }
        if (s.c.callId === 'read') assert.ok(text(card).includes('已读取文件内容'));
        if (s.c.callId === 'hit') {
          assert.ok(text(card).includes(`${s.label} edited`));
          assert.ok(text(card).includes(`${s.label}/空 格.txt`), 'actual matched path must be visible');
        }
        if (s.c.callId === 'miss') assert.match(text(card), /无.*匹配|未.*匹配|0.*匹配|无.*命中|未.*命中|0.*命中/);
        assert.deepEqual(fileSemantics(s.call.toolId, s.call.arguments, s.report), card, 'pure deterministic mapper');
      }
      const s = receipt.samples.find(s => s.c.callId === 'read');
      const large = contract(fileSemantics('file.read', s.call.arguments, { ...s.report, content: 'preview\n'.repeat(500) }));
      assert.ok(large.lines.length < 500, 'full report belongs in collapsed details');
    });
    await t.test('shell plugin interprets actual stdout/stderr without losing command', async () => {
      const { shellSemantics } = await import('../../docs/ui/tool-shell-semantics.js');
      for (const s of receipt.samples.filter(s => s.c.toolId === 'bash')) {
        const card = contract(shellSemantics(s.call.toolId, s.call.arguments, s.report)); s.card = card;
        assert.equal(s.call.arguments.command, s.c.args.command, 'original command belongs to renderer, not inferred shell subject');
        assert.ok(text(card).includes(s.report.stdout.text));
        assert.ok(text(card).includes(s.report.stderr.text));
        assert.notDeepEqual(contract(shellSemantics('bash', s.call.arguments, undefined)), card);
      }
    });
    await t.test('actual reader drives literal DOM preview and folded full report', async () => {
      class Element {
        constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.hidden = false; this.isConnected = true; this.listeners = {}; this.value = ''; this.open = false; }
        set textContent(value) { this.value = value; this.children = []; }
        get textContent() { return this.value; }
        set innerHTML(_) { assert.fail('report must never enter an HTML parser'); }
        append(...nodes) { for (const n of nodes) { n.remove(); n.parent = this; this.children.push(n); } }
        insertBefore(node, reference) {
          node.remove();
          node.parent = this;
          this.children.splice(this.children.indexOf(reference), 0, node);
        }
        remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; }
        setAttribute() {}
        addEventListener(name, fn) { this.listeners[name] = fn; }
        showModal() { this.open = true; }
        close() { this.open = false; this.listeners.close?.(); }
        focus() {}
      }
      const find = (n, cls) => n.className === cls ? n : n.children.map(c => find(c, cls)).find(Boolean);
      const domText = n => [n.textContent, ...n.children.map(domText)].join('\n');
      const disclosure = (node, cls) => {
        const root = find(node, cls);
        return { root, trigger: find(root, 'detail-disclosure-trigger'), dialog: find(root, 'detail-disclosure-dialog'), content: find(root, 'detail-disclosure-content') };
      };
      const openDisclosure = ({ dialog, trigger }) => { assert.equal(dialog.open, false); trigger.listeners.click(); assert.equal(dialog.open, true); };
      const closeDisclosure = ({ dialog }) => { find(dialog, 'detail-disclosure-close').listeners.click(); assert.equal(dialog.open, false); };
      const previous = globalThis.document;
      globalThis.document = { createElement: tag => new Element(tag) };
      try {
        const host = new Element('main');
        let reads = 0;
        const read = async target => {
          reads++;
          return service.toolOutput(target.taskId, id('operation', target.operationId), target.executionEpoch, target.seq);
        };
        const a = receipt.samples.find(s => s.label === 'alpha' && s.c.callId === 'read');
        const b = receipt.samples.find(s => s.label === 'beta' && s.c.callId === 'read');
        ui.renderToolBody(host, [a.call, b.call], read);
        assert.equal(reads, 0);
        assert.match(domText(host), /执行工具等待结果/);
        ui.renderToolBody(host, [a.call, b.call, b.result, a.result], read);
        assert.equal(host.children.length, 2);
        for (const s of [a, b]) {
          const row = ui.toolPresentations([s.call, s.result])[0];
          const card = host.children.find(n => n.dataset.toolKey === row.key);
          assert.equal(find(card, 'tool-arguments'), undefined, 'collapsed parameters are not constructed');
          const facts = disclosure(card, 'tool-facts');
          assert.ok(facts.trigger && facts.dialog);
          assert.equal(facts.dialog.open, false);
          assert.equal(find(facts.content, 'tool-arguments'), undefined, 'collapsed parameters are not constructed');
          openDisclosure(facts);
          assert.deepEqual(JSON.parse(find(facts.content, 'tool-arguments').textContent), s.call.arguments);
          const evidence = JSON.parse(facts.content.children.at(-1).textContent);
          assert.deepEqual(evidence.taskId, s.call.taskId);
          assert.equal(evidence.operationId, s.call.operationId);
          assert.equal(evidence.executionEpoch, s.call.executionEpoch);
          assert.equal(evidence.callId, s.call.callId);
          assert.equal(evidence.outputRef, s.result.outputRef);
          const factCount = facts.content.children.length;
          closeDisclosure(facts);
          openDisclosure(facts);
          assert.equal(facts.content.children.length, factCount, 'repeated open does not duplicate parameters or evidence');
          closeDisclosure(facts);
          await find(card, 'tool-read-output').listeners.click();
          const semantic = find(card, 'tool-semantic');
          assert.ok(domText(semantic).includes(s.report.path));
          assert.ok(domText(semantic).includes('已读取文件内容'));
          assert.ok(!domText(semantic).includes(`${s.label === 'alpha' ? 'beta' : 'alpha'} edited`));
          assert.equal(find(card, 'tool-report-original'), undefined, 'read does not construct folded JSON');
          const raw = disclosure(card, 'tool-raw-report');
          assert.equal(raw.dialog.open, false);
          openDisclosure(raw);
          assert.equal(find(raw.content, 'tool-report-original').textContent, JSON.stringify(s.report, null, 2));
          assert.ok(find(raw.content, 'tool-report-original').textContent.includes('<script>literal & safe</script>'));
          closeDisclosure(raw);
          openDisclosure(raw);
          assert.equal(raw.content.children.length, 1, 'repeated open does not duplicate original report');
          s.dom = domText(card);
        }
        assert.equal(reads, 2);
        const shell = receipt.samples.find(s => s.c.callId === 'shell');
        ui.renderToolBody(host, [shell.call, shell.result], read);
        assert.equal(find(host, 'tool-command'), undefined, 'collapsed command is not constructed');
        assert.equal(find(host, 'tool-arguments'), undefined);
        assert.ok(!domText(host).includes(shell.c.args.command), 'main face excludes the original shell command');
        const facts = disclosure(host, 'tool-facts');
        openDisclosure(facts);
        assert.equal(find(facts.content, 'tool-command').textContent, shell.c.args.command);
        assert.equal(find(host, 'tool-command').parent, facts.content, 'command belongs to original details');
        assert.ok(find(facts.content, 'tool-arguments'), 'original argument fields remain available');
        assert.deepEqual(JSON.parse(find(facts.content, 'tool-arguments').textContent), shell.c.args);
        closeDisclosure(facts);
        await find(host, 'tool-read-output').listeners.click();
        assert.ok(domText(find(host, 'tool-semantic')).includes('退出码：0'));
        assert.ok(domText(find(host, 'tool-output')).includes(shell.report.stdout.text));
        assert.ok(domText(find(host, 'tool-output')).includes(shell.report.stderr.text));
        assert.doesNotMatch(domText(host), /等待结果正文|尚无结果正文|执行工具等待结果/);
        shell.dom = domText(host);
        const failed = { ...shell.result, status: 'failed', error: { code: 'shell.denied', message: '命令被拒绝', ownerId: 'executor' } };
        ui.renderToolBody(host, [shell.call, failed], read);
        assert.equal(host.children[0].children[0].className, 'tool-error', 'compact error precedes semantic preview');
        assert.equal(domText(host).split('命令被拒绝').length, 2);
        assert.doesNotMatch(domText(host), /等待结果正文|尚无结果正文|执行工具等待结果/);
        assert.equal(find(host, 'tool-read-output'), undefined);
        ui.renderToolBody(host, [shell.call, { ...shell.result, outputRef: undefined }], read);
        assert.match(domText(host), /结果正文未提供/);
        assert.doesNotMatch(domText(host), /等待结果正文|尚无结果正文|执行工具等待结果/);

        // A full file.write body is expensive. Its JSON must be constructed only
        // after an explicit details open, even when the result is already read.
        const write = receipt.samples.find(s => s.c.toolId === 'file.write');
        let serialized = 0;
        const args = { ...write.call.arguments, content: 'large input\n'.repeat(10000), toJSON() { serialized++; return { ...this, toJSON: undefined }; } };
        const report = { ...write.report, before: 'old\n'.repeat(10000), after: 'new\n'.repeat(10000), toJSON() { serialized++; return { ...this, toJSON: undefined }; } };
        ui.renderToolBody(host, [{ ...write.call, arguments: args }, write.result], async () => report);
        assert.equal(serialized, 0, 'collapsed arguments are not serialized by polling');
        await find(host, 'tool-read-output').listeners.click();
        assert.equal(serialized, 0, 'loaded preview does not serialize full before/after');
        assert.equal(find(host, 'tool-report-original'), undefined);
        assert.equal(find(host, 'tool-output').textContent, '');
        assert.match(domText(find(host, 'tool-semantic')), /修改|新建/);
        const original = disclosure(host, 'tool-raw-report');
        openDisclosure(original);
        assert.equal(serialized, 1);
        assert.equal(find(original.content, 'tool-report-original').textContent, JSON.stringify({ ...report, toJSON: undefined }, null, 2));
        closeDisclosure(original);
        openDisclosure(original);
        assert.equal(serialized, 1, 'loaded original JSON is reused');
        closeDisclosure(original);
        const parameters = disclosure(host, 'tool-facts');
        openDisclosure(parameters);
        assert.equal(serialized, 2, 'full parameters serialize only on first expansion');
        assert.deepEqual(JSON.parse(find(parameters.content, 'tool-arguments').textContent), { ...write.call.arguments, content: args.content });
        closeDisclosure(parameters);
        openDisclosure(parameters);
        assert.equal(serialized, 2, 'expanded parameters are reused');
        closeDisclosure(parameters);
        ui.disposeToolBody(host);
      } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
      }
    });
  } finally {
    receipt.events = journal.replay().filter(r => r.kind === 'operation.event').map(r => r.event);
    // Runtime state stays under ~/.humanagent and is removed only after all
    // awaited foreground effects have settled. Keep reports in the receipt.
    await rm(root, { recursive: true, force: true });
    receipt.resources = { runtimeRemoved: true, listeners: [], browsers: [], backgroundProcesses: [] };
    if (process.env.TOOL_ACTION_RECEIPT) await writeFile(process.env.TOOL_ACTION_RECEIPT, JSON.stringify(receipt, null, 2));
  }
});
