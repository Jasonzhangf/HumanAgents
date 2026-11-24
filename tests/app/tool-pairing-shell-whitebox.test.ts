import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id, operationIdempotencyKey, operationSemanticFingerprint, operationSemanticFingerprintKey,
  type OperationIntent, type ToolRegistration, type BusinessPayload, type ProviderBinding } from '../../packages/contracts/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { createExecutionAdmission, executionAdmissionInputDigest } from '../../packages/app/src/ui-runtime/execution-admission.js';
import { createToolExecutionGateway } from '../../packages/app/src/tool-execution-gateway.js';
import { createResponsesFileToolExecutor, RESPONSES_BASH_TOOL } from '../../packages/app/src/provider-tool-execution.js';
import { ProviderAdapter, ProviderAgentDriver, ResponsesProviderCodec, createV3ProviderHttpTransport,
  filesystemProviderEvidenceSink, type V3ProviderFetch, type ProviderAgentEvent } from '../../packages/adapters/provider/src/index.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';

// Failure risk: the existing built-in test only checks one zero-exit command.
// Impact: lost output, false pairing, or false command success. Cost: local tmp
// files and short foreground processes only. Production logic is never copied.
async function fixture(root: string, label = 'a') {
  const taskId = id('task', `shell-task-${label}`);
  const operationId = id('operation', `shell-parent-${label}`);
  const scope = { organId: id('organ', 'shell-organ'), taskId, cycleId: id('cycle', `shell-cycle-${label}`), operationId };
  const execution = { runtimeId: `shell-runtime-${label}`, taskId, operationId, executionEpoch: 1 };
  const principalOwner = 'shell-whitebox-owner';
  const workspaceRoot = join(root, 'workspace');
  await mkdir(join(workspaceRoot, '空 格'), { recursive: true });
  const journal = new JsonlOrganJournal(join(root, 'journal.jsonl'));
  const grants = new JsonlTaskGrantJournal(journal);
  const allocation = { ...execution, assignmentId: `assignment-${label}`, scope, inputRefs: ['artifact://shell-input'], ownerId: principalOwner,
    directiveRevision: 1, inputRevision: 1, orchestrated: false };
  const admittedInput = { inputRevision: 1, inputRefs: allocation.inputRefs, input: { prompt: 'controlled shell whitebox' } };
  const capability = { actionId: 'task.execute', capabilities: ['provider.execution'], scope: { organId: scope.organId, taskId } };
  await grants.grant({ requestId: `grant-${label}`, taskId, owner: principalOwner, capability, expectedRevision: 0 });
  const registration: ToolRegistration = { toolName: 'provider.execution', contractVersion: '1.0.0', supportedKinds: ['run'],
    routeId: 'provider-execution', routeVersion: 'provider-execution.v1', mode: 'gateway', acceptedScopes: [{}],
    inputContract: 'schema://provider.execution.input/v1', outputContract: 'schema://provider.execution.output/v1',
    verifier: 'verifier://provider.execution/v1', capabilities: ['provider.execution'], retryPolicy: 'retry://explicit-reconciliation/v1', owner: principalOwner };
  const now = () => new Date();
  const admission = createExecutionAdmission({ organJournal: journal, taskGrantPort: grants, principalOwner,
    capabilityFor: ({ intent }) => ({ ...capability, scope: { organId: intent.requestedScope.organId, taskId: intent.taskId } }),
    resourceBoundary: { async readBoundary({ intent }) { return { scope: intent.requestedScope, evidenceRefs: [] }; } },
    resolveAdmittedInput: async () => admittedInput, createGateway: ports => createToolExecutionGateway({ ...ports, now }) });
  const intent: OperationIntent = { operationId, taskId, cycleId: scope.cycleId, requestedBy: principalOwner, intentRevision: '1', kind: 'run',
    toolName: registration.toolName, inputRef: allocation.inputRefs[0]!, inputDigest: executionAdmissionInputDigest(allocation, admittedInput),
    requestedScope: scope, idempotencyKey: operationId.value, expectedOutput: { schemaRef: registration.outputContract, requiredEvidenceKinds: ['operation'] } };
  await admission.admitExecution({ allocation, requestRef: `execution:${label}`, capability, parentLifecycle: {
    event: { eventId: `admitted-${label}`, schemaVersion: 1, kind: 'operation.accepted', operationId, taskId, executionEpoch: 1,
      status: 'accepted', occurredAt: now().toISOString(), evidenceRefs: [] },
    control: { intent, registration, route: { operationId, routeId: registration.routeId, routeVersion: registration.routeVersion,
      mode: registration.mode, contractVersion: registration.contractVersion, effectiveScope: scope, selectionReason: 'controlled whitebox', selectedAt: now().toISOString() },
      status: 'accepted', executionEpoch: 1, namespaceKey: operationIdempotencyKey(intent), fingerprintKey: operationSemanticFingerprintKey(operationSemanticFingerprint(intent, registration)) } } });
  const built = createResponsesFileToolExecutor({ workspaceRoot, projectKey: `shell-${label}`, artifactRoot: join(root, 'artifacts'), admission: {
    organJournal: journal, currentTaskGrantPort: admission.permissions, principalOwner, resourceBoundary: admission.resourceBoundary,
    bindingFor: async () => admission.bindingFor(allocation), admitToolOperation: admission.admitToolOperation, now } });
  const run = (command: string, callId: string, extra: BusinessPayload = {}, signal = new AbortController().signal) => built.executor.execute({
    execution, scope, requestId: `request-${label}`, signal, call: { callId, toolId: 'bash', continuationRef: `response-${label}`,
      arguments: { command, description: 'local harmless shell sample', ...extra } } });
  return { ...built, run, execution, scope, workspaceRoot, grants, capability, principalOwner };
}

test('shell whitebox: production bash string semantics, cwd, streams, exit, empty and capped output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ha-shell-whitebox-'));
  try {
  const f = await fixture(root);
  const command = "printf '%s\\n' '空 格' '\"引号\"' > '本地 文件.txt'\ncat '本地 文件.txt' | tr ' ' '_' ; printf '错误\\n' >&2";
  const result = await f.run(command, 'syntax', { workdir: '空 格' });
  const report = JSON.parse(result.output);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(report, { exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text: '空_格\n"引号"\n', truncated: false }, stderr: { text: '错误\n', truncated: false } });
  assert.equal(await readFile(join(f.workspaceRoot, '空 格', '本地 文件.txt'), 'utf8'), '空 格\n"引号"\n');
  const cwd = JSON.parse((await f.run('pwd', 'cwd', { workdir: '空 格' })).output);
  assert.equal(cwd.stdout.text.trim(), await realpath(join(f.workspaceRoot, '空 格')));
  const nonzero = await f.run("printf 'out'; printf 'err' >&2; exit 7", 'nonzero');
  assert.deepEqual(JSON.parse(nonzero.output), { exitCode: 7, signal: null, timedOut: false, aborted: false,
    stdout: { text: 'out', truncated: false }, stderr: { text: 'err', truncated: false } });
  // Tool operation success means command execution completed, not exitCode=0.
  console.log('NONZERO_TOOL_STATUS', nonzero.status, nonzero.output);
  const empty = JSON.parse((await f.run(':', 'empty')).output);
  assert.equal(empty.stdout.text, ''); assert.equal(empty.stderr.text, ''); assert.equal(empty.exitCode, 0);
  const exact = JSON.parse((await f.run("printf '%60000s' '' | tr ' ' x", 'long-exact')).output);
  assert.equal(exact.stdout.text, 'x'.repeat(60000)); assert.equal(exact.stdout.truncated, false);
  const capped = JSON.parse((await f.run("printf '%70000s' '' | tr ' ' x; printf END", 'long-capped')).output);
  assert.equal(capped.stdout.text, 'x'.repeat(65533) + 'END'); assert.equal(capped.stdout.truncated, true);
  console.log('SHELL_REPORT', JSON.stringify({ report, empty, exactLength: exact.stdout.text.length, cappedLength: capped.stdout.text.length, capped: capped.stdout.truncated }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shell whitebox: admission, unknown tool, wrong epoch, timeout and pre-cancel have no invented success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ha-shell-control-'));
  try {
  const f = await fixture(root);
  const base = { execution: f.execution, scope: f.scope, requestId: 'control-request', signal: new AbortController().signal,
    call: { callId: 'control-call', toolId: 'exec_command', arguments: { command: 'touch forbidden' }, continuationRef: 'control-response' } };
  await assert.rejects(() => f.executor.execute(base), /not registered/);
  await assert.rejects(() => f.executor.execute({ ...base, call: { ...base.call, toolId: 'bash', arguments: { command: ':', description: 'noop' } }, execution: { ...f.execution, executionEpoch: 2 } }), /identity|epoch|binding/i);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(() => f.run('touch cancelled', 'pre-cancel', {}, cancelled.signal), /stopped before admission/);
  await assert.rejects(() => f.run('exec sleep 2', 'timeout', { timeoutMs: 30 }), /reconcil|stop|effect/i);
  const journal = await readFile(join(root, 'journal.jsonl'), 'utf8');
  assert.match(journal, /reconcile/);
  await assert.rejects(() => readFile(join(f.workspaceRoot, 'cancelled')));
  await assert.rejects(() => readFile(join(f.workspaceRoot, 'forbidden')));
  console.log('TIMEOUT_CONTROL_RECONCILE', journal.split('\n').filter(line => line.includes('reconcile')).join('\n'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const continueAgain of [false, true]) test(`pairing whitebox: real driver codec adapter gateway bash ${continueAgain ? 'cross-response dependent call' : 'same-response batch'} returns exact outputs to next requests`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ha-shell-pairing-'));
  try {
  const f = await fixture(root);
  const binding: ProviderBinding = { bindingId: 'shell-binding', providerId: 'controlled', protocol: 'responses', endpointRef: 'controlled-local',
    modelRef: 'scripted', configDigest: 'config-test', capabilityDigest: 'capability-test' };
  const bodies: Array<{ input: Array<{ type: string; call_id?: string; output?: string; arguments?: string }> }> = [];
  const sse = (events: unknown[]) => ({ status: 200, text: async () => '', body: (async function* () {
    for (const event of events) yield new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  })() });
  const fetch: V3ProviderFetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    const n = bodies.length;
    const response = { id: `scripted-response-${n}` };
    const calls = n === 1 ? [
      { call_id: 'same-tool-a', command: "printf 'first value\\n'" },
      { call_id: 'same-tool-b', command: "printf 'error value' >&2; exit 9" },
    ] : n === 2 && continueAgain ? [{ call_id: 'dependent', command: `printf '%s' '${JSON.parse(body.input.find((x: { call_id: string; type: string }) => x.type === 'function_call_output' && x.call_id === 'same-tool-a').output.split('\n')[0]).stdout.text.trim()}'` }] : [];
    return sse([{ type: 'response.created', response }, ...calls.map((call, index) => ({ type: 'response.output_item.done', output_index: index,
      item: { type: 'function_call', call_id: call.call_id, name: 'bash', arguments: JSON.stringify({ command: call.command, description: 'scripted shell pairing' }) } })),
      { type: 'response.completed', response }]);
  };
  const sink = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'protocol')));
  const adapter = new ProviderAdapter({ binding, routeRef: 'controlled-route', codec: new ResponsesProviderCodec(), evidence: sink,
    transport: createV3ProviderHttpTransport({ binding, baseUrl: 'http://controlled.invalid', evidence: sink, fetch }) });
  const rawOutputs = new Map<string, string>();
  const driver = new ProviderAgentDriver({ port: adapter, binding, ...f.execution, assignmentId: 'pairing-assignment', scope: f.scope,
    inputRefs: ['artifact://shell-input'], tools: [RESPONSES_BASH_TOOL], executeTool: { async execute(input) {
      const result = await f.executor.execute(input); rawOutputs.set(input.call.callId, result.output); return result;
    } } });
  await driver.start(f.execution);
  await driver.submit({ taskId: f.execution.taskId, executionEpoch: 1, assignmentId: 'pairing-assignment', payload: { prompt: 'scripted tools only' } });
  const events: ProviderAgentEvent[] = [];
  try { for await (const event of driver.observe({ runtimeId: f.execution.runtimeId })) events.push(event); }
  finally {
    console.log('CAPTURED_PROTOCOL', continueAgain, JSON.stringify(bodies));
    console.log('EXECUTOR_OUTPUTS', continueAgain, JSON.stringify([...rawOutputs]));
    console.log('PAIRED_RESULTS', continueAgain, JSON.stringify(events.flatMap(e => e.providerEvent.toolResult ? [e.providerEvent.toolResult] : [])));
    await driver.closeProductionAndDrain({ execution: f.execution, boundaryId: 'whitebox-cleanup' }); await driver.settle(f.execution); await driver.close();
  }
  assert.equal(bodies.length, continueAgain ? 3 : 2);
  const results = events.flatMap(e => e.providerEvent.toolResult ? [e.providerEvent.toolResult] : []);
  assert.deepEqual(results.map(r => r.callId), continueAgain ? ['same-tool-a', 'same-tool-b', 'dependent'] : ['same-tool-a', 'same-tool-b']);
  assert.ok(results.every(r => r.status === 'succeeded'), 'succeeded means shell executed; exit codes remain in output');
  for (const event of events.filter(e => e.providerEvent.toolResult !== undefined)) {
    const call = events.find(e => e.providerEvent.toolCall?.callId === event.providerEvent.toolResult!.callId)!.providerEvent;
    assert.equal(event.providerEvent.requestId, call.requestId);
    assert.equal(event.providerEvent.turnId, call.turnId);
    assert.ok(call.requestId.length > 0); assert.ok(call.turnId.length > 0);
    assert.equal(event.providerEvent.executionEpoch, f.execution.executionEpoch);
    assert.deepEqual(event.providerEvent.taskId, f.execution.taskId);
    assert.deepEqual(event.providerEvent.operationId, f.execution.operationId);
    console.log('CALL_RESULT_BINDING', JSON.stringify({ callId: call.toolCall!.callId, requestId: call.requestId, turnId: call.turnId,
      executionEpoch: event.providerEvent.executionEpoch, taskId: event.providerEvent.taskId, operationId: event.providerEvent.operationId }));
  }
  for (const [index, expected] of (continueAgain ? [['same-tool-a', 'same-tool-b'], ['same-tool-a', 'same-tool-b', 'dependent']] : [['same-tool-a', 'same-tool-b']]).entries()) {
    const input = bodies[index + 1]!.input;
    assert.deepEqual(input.filter(x => x.type === 'function_call_output').map(x => x.call_id), expected);
    for (const callId of expected) {
      assert.equal(input.filter(x => x.type === 'function_call' && x.call_id === callId).length, 1);
      const output = input.find(x => x.type === 'function_call_output' && x.call_id === callId)!.output!;
      const raw = rawOutputs.get(callId)!;
      assert.equal(output.slice(0, raw.length), raw, 'wire preserves every raw output character before the declared evidence footer');
      assert.match(output.slice(raw.length), /^\n\[HumanAgent evidence refs\]/);
      for (const ref of results.find(r => r.callId === callId)!.evidenceRefs) {
        assert.ok(output.includes(`evidenceId=${ref.evidenceId.value}`));
        assert.ok(output.includes(`locator=${ref.locator}`));
      }
    }
  }
  assert.equal(JSON.parse(rawOutputs.get('same-tool-a')!).stdout.text, 'first value\n');
  assert.equal(JSON.parse(rawOutputs.get('same-tool-b')!).exitCode, 9);
  assert.equal(JSON.parse(rawOutputs.get('same-tool-b')!).stderr.text, 'error value');
  if (continueAgain) assert.equal(JSON.parse(rawOutputs.get('dependent')!).stdout.text, 'first value');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pairing whitebox: same call id across task parents stays isolated and replay never repeats effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ha-shell-isolation-'));
  try {
    const a = await fixture(join(root, 'a'), 'a');
    const b = await fixture(join(root, 'b'), 'b');
    const first = await a.run("printf a >> count; printf A", 'shared-id');
    const second = await b.run("printf b >> count; printf B", 'shared-id');
    assert.equal(JSON.parse(first.output).stdout.text, 'A');
    assert.equal(JSON.parse(second.output).stdout.text, 'B');
    assert.equal(await readFile(join(a.workspaceRoot, 'count'), 'utf8'), 'a');
    assert.equal(await readFile(join(b.workspaceRoot, 'count'), 'utf8'), 'b');
    await assert.rejects(() => a.run("printf a >> count; printf A", 'shared-id'), /succeeded|already|conflict|duplicate/i);
    assert.equal(await readFile(join(a.workspaceRoot, 'count'), 'utf8'), 'a');
    console.log('TASK_ISOLATION', first.output, second.output, 'duplicate rejected without second effect');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shell whitebox: abort after actual foreground start settles as reconciliation and releases the process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ha-shell-active-cancel-'));
  try {
    const f = await fixture(root);
    const controller = new AbortController();
    const running = f.run('printf READY > started; exec sleep 2', 'active-cancel', {}, controller.signal)
      .then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    try {
      let started = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { started = await readFile(join(f.workspaceRoot, 'started'), 'utf8') === 'READY'; } catch { /* wait only for the test-owned marker */ }
        if (started) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(started, true, 'abort must happen after the production bash process writes its marker');
    } finally { controller.abort(); }
    const outcome = await running;
    assert.equal(outcome.result, undefined);
    assert.match(String(outcome.error), /reconcil|stop|effect/i);
    const journal = await readFile(join(root, 'journal.jsonl'), 'utf8');
    assert.match(journal, /operation.reconcile_required/);
    console.log('ACTIVE_CANCEL', String(outcome.error), 'production child close awaited before executor rejected');
  } finally { await rm(root, { recursive: true, force: true }); }
});
