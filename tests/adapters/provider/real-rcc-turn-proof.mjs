#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Failure likelihood is unknown. False stop/drain/resource PASS would hide an
// unfinished execution; these in-memory counterexamples cost no model request.
function assertExplicitStop(receipt) {
  assert.equal(receipt.portStop?.receipt.status, 'accepted', 'intentional port stop accepted');
  assert.equal(receipt.stop?.requested, true, 'driver stop requested');
  assert.equal(receipt.submit?.payload.status, 'accepted', 'submit accepted before stop');
  assert.equal(receipt.generationAttempts, 1, 'one generation attempt');
  const request = receipt.stopTrigger.request;
  const execution = receipt.fixture.binding.execution;
  const scope = receipt.fixture.binding.scope;
  assert.equal(receipt.stopTrigger.event.kind, 'provider.output');
  assert.ok(receipt.stopTrigger.event.summary.trim(), 'nonempty output triggers stop');
  assert.equal(receipt.stopTrigger.terminalSeen, false, 'stop before terminal');
  assert.ok(receipt.stopTrigger.lifecycle.some((event) => event.phase === 'dispatched'
    && event.requestId === request.requestId), 'dispatched before stop');
  assert.equal(new Set(receipt.lifecycle.map((event) => event.requestId)).size, 1);
  assert.equal(request.parentRequestId, undefined);
  for (const identity of [receipt.portStop.input, receipt.portStop.receipt, receipt.settlement]) {
    assert.equal(identity.requestId, request.requestId);
    assert.equal(identity.turnId, request.turnId);
    assert.equal(identity.runtimeId, execution.runtimeId);
    assert.equal(identity.executionEpoch, execution.executionEpoch);
    assert.deepEqual(identity.operationId, scope.operationId);
    assert.deepEqual(identity.taskId, scope.taskId);
  }
  assert.deepEqual(receipt.stop.operationId, scope.operationId);
  assert.ok(receipt.drain, 'producer drain exists');
  assert.deepEqual(receipt.drain.execution, execution);
  assert.equal(receipt.drain.boundaryId, receipt.drainBoundaryId);
  assert.equal(receipt.drain.requests.length, 1);
  assert.deepEqual(receipt.drain.requests[0].request, request);
  const facts = receipt.acceptedRawFacts.filter((entry) => entry.envelope.request.requestId === request.requestId);
  assert.ok(facts.length, 'cold accepted raw facts');
  assert.equal(receipt.drain.requests[0].lastProducerSeq, Math.max(...facts.map((entry) => entry.envelope.producerSeq)), 'final accepted producer sequence');
  const trigger = facts.find((entry) => entry.envelope.producerSeq === receipt.stopTrigger.producerSeq);
  assert.equal(trigger?.envelope.fact.kind, 'content', 'trigger content durably accepted before stop');
  assert.deepEqual(trigger.envelope.scope, scope);
  assert.deepEqual(trigger.envelope.execution, execution);
  assert.equal(trigger.envelope.request.requestId, receipt.stopTrigger.event.providerEvent.requestId);
  assert.equal(trigger.envelope.request.turnId, receipt.stopTrigger.event.providerEvent.turnId);
  assert.ok(receipt.stopTrigger.rawText.trim(), 'cold raw content readable');
  assert.equal(receipt.closure?.state, 'stopped');
  assert.equal(receipt.settlement?.state, 'stopped');
  assert.equal(receipt.settlement.resourceRelease.state, 'released');
  assert.equal(receipt.settlement.persistence.state, 'committed');
  assert.equal(receipt.settlement.error, undefined);
  // requests() is the durable phase history, not one current row per request.
  assert.equal(new Set(receipt.durableRequests.map((record) => record.request.requestId)).size, 1);
  assert.deepEqual(receipt.durableRequests.at(-1).request, request);
  assert.equal(receipt.durableRequests.at(-1).phase, 'cancelled');
  assert.equal(receipt.lifecycle.at(-1)?.phase, 'cancelled');
  assert.equal(receipt.close?.state, 'closed');
  assert.equal(receipt.pendingStart, false);
  assert.equal(receipt.cleanupError, undefined);
  assert.equal(receipt.cleanup, 'closed');
}

if (process.argv.includes('--assertion-self-test')) {
  const request = { turnId: 'turn', requestId: 'request' };
  const execution = { runtimeId: 'runtime', executionEpoch: 1 };
  const scope = { taskId: { value: 'task' }, operationId: { value: 'operation' } };
  const identity = { ...request, ...execution, ...scope };
  const good = {
    portStop: { input: identity, receipt: { ...identity, status: 'accepted' } },
    stop: { requested: true, operationId: scope.operationId }, submit: { payload: { status: 'accepted' } },
    generationAttempts: 1, fixture: { binding: { execution, scope } },
    stopTrigger: { request, event: { kind: 'provider.output', summary: '1', providerEvent: request }, terminalSeen: false,
      lifecycle: [{ ...identity, phase: 'dispatched' }], producerSeq: 1, rawText: '1' },
    drainBoundaryId: 'boundary', drain: { execution, boundaryId: 'boundary', requests: [{ request, lastProducerSeq: 1 }] },
    acceptedRawFacts: [{ envelope: { request, execution, scope, producerSeq: 1, fact: { kind: 'content' } } }],
    closure: { state: 'stopped' }, settlement: { ...identity, state: 'stopped', resourceRelease: { state: 'released' }, persistence: { state: 'committed' } },
    durableRequests: [{ request, phase: 'dispatching' }, { request, phase: 'dispatched' }, { request, phase: 'cancelled' }],
    lifecycle: [{ ...identity, phase: 'cancelled' }],
    close: { state: 'closed' }, pendingStart: false, cleanup: 'closed',
  };
  assertExplicitStop(good);
  const cases = [
    ['missing accepted stop', (r) => { delete r.portStop; r.closure.state = r.settlement.state = 'succeeded'; }, /intentional port stop accepted/],
    ['missing drain', (r) => { delete r.drain; }, /producer drain exists/],
    ['wrong final producer sequence', (r) => { r.drain.requests[0].lastProducerSeq = 0; }, /final accepted producer sequence/],
    ['pending resource release', (r) => { r.settlement.resourceRelease.state = 'pending'; }, /released/],
    ['nonclosed close', (r) => { r.close.state = 'pending'; }, /closed/],
  ];
  for (const [name, mutate, message] of cases) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.throws(() => assertExplicitStop(bad), message);
    console.log(`counterexample rejected: ${name}`);
  }
  console.log('PASS: same stop assertion; 3 failure groups, 5 counterexamples; 0 requests, no fixture/admission');
  process.exit(0);
}

const proofRuntimeRoot = process.env.HUMANAGENT_PROVIDER_PROOF_RUNTIME_ROOT
  ?? fileURLToPath(new URL('../../../dist/app/', import.meta.url));

const proofModuleUrl = (relativePath) =>
  pathToFileURL(resolve(proofRuntimeRoot, relativePath)).href;

const {
  validateUserConfig,
  compileAgentProviderBindings,
  resolveRuntimePaths,
} = await import(proofModuleUrl('config/src/index.js'));
const {
  selectAgentProvider,
  providerBindingFromConfig,
  createAgentProviderPort,
} = await import(proofModuleUrl('app/src/agent-driver-composition.js'));
const {
  admitAgentProvider,
} = await import(proofModuleUrl('app/src/agent-provider-admission.js'));
const {
  ProviderAgentDriver,
  filesystemProviderEvidenceSink,
} = await import(proofModuleUrl('adapters/provider/src/index.js'));
const {
  ImmutableAssetStore,
} = await import(proofModuleUrl('adapters/filesystem/src/index.js'));
const {
  id,
} = await import(proofModuleUrl('contracts/src/index.js'));

const BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_RCC_MODEL ?? 'gpt-5.5';
const PROTOCOL = process.env.HUMANAGENT_RCC_PROTOCOL ?? 'responses';
const SOURCE = process.env.HUMANAGENT_PROVIDER_SOURCE ?? 'rcc';
const ROUTE = process.env.HUMANAGENT_PROVIDER_ROUTE ?? 'default';
const CREDENTIAL_REF = process.env.HUMANAGENT_PROVIDER_CREDENTIAL_REF;
const TOOL_LOOP = process.env.HUMANAGENT_RCC_TOOL_LOOP === '1';
const CONTINUE_CURRENT_TURN = process.env.HUMANAGENT_RCC_CONTINUE_CURRENT_TURN === '1';
const NATIVE_TURN = TOOL_LOOP || CONTINUE_CURRENT_TURN;
const EXPLICIT_STOP = process.env.HUMANAGENT_RCC_EXPLICIT_STOP === '1';
// Durable Runtime/JSONL fixture is shared by native-turn modes and explicit stop.
const DURABLE = NATIVE_TURN || EXPLICIT_STOP;
assert.ok(['responses', 'openai', 'anthropic'].includes(PROTOCOL), 'unsupported RCC proof protocol');
assert.ok(['rcc', 'http'].includes(SOURCE), 'unsupported provider source');
assert.ok(CREDENTIAL_REF === undefined || SOURCE === 'http', 'credentialRef requires source = "http"');
assert.ok(CREDENTIAL_REF === undefined || CREDENTIAL_REF.startsWith('env:'), 'credentialRef must be an env reference');
assert.ok(!(TOOL_LOOP && CONTINUE_CURRENT_TURN), 'tool loop and continue-current-turn are distinct proof modes');
assert.ok(!(EXPLICIT_STOP && NATIVE_TURN), 'explicit stop is exclusive of tool loop and continue-current-turn');
const ENDPOINT = { responses: '/v1/responses', openai: '/v1/chat/completions', anthropic: '/v1/messages' }[PROTOCOL];

// Known failure: old proof bypassed default composition and deleted evidence.
// Failure probability is unknown; cost is one short generation per invocation.
// Accepted fake/replay counterexamples are reused without another fault matrix.
function echoTool() {
  return { toolId: 'echo_probe', description: 'Return the deterministic probe token for N4 protocol verification.', inputSchema: {
    type: 'object', properties: { probeId: { type: 'string' } }, required: ['probeId'], additionalProperties: false } };
}
function errorRecord(error) {
  if (!error || typeof error !== 'object') return String(error);
  return { ...error, name: error.name, message: error.message,
    ...(error.cause === undefined ? {} : { cause: errorRecord(error.cause) }) };
}
function bounded(work, milliseconds, label) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

// One canonical fixture parent below the single HumanAgent control
// root. An explicit HUMANAGENT_TEST_ROOT is honoured only when it is absolute
// and stays under <homedir>/.humanagent/test-fixtures, so this proof never
// writes into other runtime state.
function canonicalOwnedRoot(controlRoot, fallback) {
  const explicit = process.env.HUMANAGENT_TEST_ROOT;
  if (explicit === undefined) return join(controlRoot, 'test-fixtures', fallback);
  if (!explicit.startsWith(sep)) throw new Error('HUMANAGENT_TEST_ROOT must be an absolute path');
  const resolved = join(explicit);
  if (!resolved.startsWith(join(homedir(), '.humanagent', 'test-fixtures') + sep)) {
    throw new Error('HUMANAGENT_TEST_ROOT must stay under <homedir>/.humanagent/test-fixtures');
  }
  return resolved;
}

async function run() {
  const paths = await resolveRuntimePaths({ workspace: process.cwd(), controlRoot: join(homedir(), '.humanagent') });
  const ownedRoot = canonicalOwnedRoot(paths.controlRoot, TOOL_LOOP
    ? `provider-n4-protocol-proof/${PROTOCOL}`
    : CONTINUE_CURRENT_TURN ? 'provider-current-turn-proof-r1-20261013'
    : EXPLICIT_STOP ? 'provider-explicit-stop-proof-20261017'
    : 'provider-protocol-live-r1-20261013');
  await mkdir(ownedRoot, { recursive: true });
  const root = await mkdtemp(join(await realpath(ownedRoot), 'run-'));
  const artifactRoot = join(root, 'evidence');
  await mkdir(artifactRoot, { recursive: true });
  const controlDir = join(root, 'control');
  await mkdir(controlDir, { recursive: true });
  const journalPath = join(controlDir, 'active-turn-journal.jsonl');
  const receiptPath = join(root, 'proof-receipt.json');
  const runId = randomUUID();
  const taskId = id('task', `provider-consumer-${runId}`);
  const operationId = id('operation', `provider-consumer-${runId}`);
  const runtimeId = `provider-consumer-${runId}`;
  const scope = { organId: id('organ', 'provider-proof'), taskId, operationId };
  const user = validateUserConfig({
    schemaVersion: 1,
    agents: [{
      agentId: 'provider-proof', roleId: 'interaction', templateRef: 'builtin/interaction@1.0.0', driverRef: 'rcc',
      skills: ['input-normalization', 'task-matching', 'confirmation'],
      tools: ['input.receive', 'task.query', 'proposal.render'], permissions: ['task.read', 'task.propose'],
      memoryScopes: ['task', 'organ', 'approved-global'], resourceClass: 'foreground',
    }],
    provider: {
      provider: SOURCE, source: SOURCE, ...(CREDENTIAL_REF === undefined ? {} : { credentialRef: CREDENTIAL_REF }),
      binding: `proof-${PROTOCOL}-${runId}`, protocol: PROTOCOL, model: MODEL, route: ROUTE, baseUrl: BASE_URL,
    },
  });
  const composition = selectAgentProvider({
    roleId: 'interaction', agentId: 'provider-proof', agentProviderBindings: compileAgentProviderBindings(user),
    createPort: (selected) => createAgentProviderPort(selected, artifactRoot),
  });
  assert.deepEqual(composition.binding, providerBindingFromConfig(user.provider));
  const receipt = {
    schemaVersion: 2, kind: 'humanagent.provider-dependency-proof', generatedAt: new Date().toISOString(),
    protocol: PROTOCOL, source: composition.source,
    provider: composition.provider, binding: composition.binding,
    composition: 'validateUserConfig → compileAgentProviderBindings → selectAgentProvider → createAgentProviderPort → admitAgentProvider → ProviderAgentDriver',
    request: {
      endpoint: `${BASE_URL}${ENDPOINT}`, protocol: PROTOCOL, model: MODEL, source: SOURCE, route: ROUTE,
      prompt: TOOL_LOOP
        ? 'Call the echo_probe tool exactly once with the argument {"probeId":"n4-proof"}, then reply with the final word OK after you receive TOOL_OK.'
        : EXPLICIT_STOP
          ? 'Print the numbers 1 to 200, one number per line. Do not call any tool.'
          : 'Reply with the single word OK.',
    },
    generationAttempts: 0, artifactRoot, receiptPath, lifecycle: [], observed: [], assets: [],
    scopeClaim: 'Provider dependency consumer only; no Task/standard turn/native/UI/G5 claim',
  };
  const sink = filesystemProviderEvidenceSink(new ImmutableAssetStore(artifactRoot));
  const { createJsonlActiveTurnJournal } = DURABLE
    ? await import(proofModuleUrl('adapters/jsonl/src/active-turn.js')) : {};
  const { ActiveTurnContext } = DURABLE
    ? await import(proofModuleUrl('runtime/src/context/active-turn-context.js')) : {};
  const { providerRawContentReader } = DURABLE
    ? await import(proofModuleUrl('adapters/provider/src/evidence.js')) : {};
  const transientInstructions = { text: `Continuation proof ${runId}: reply with the single word CONTINUED.` };
  let turn;
  let journal;
  const rawReader = DURABLE ? providerRawContentReader(sink) : undefined;
  // This fixture binds real Runtime/JSONL producers, not a production Task admission.
  // Reconstruct before each read so the next request uses committed raw facts.
  async function latestCanonical() {
    const cold = await ActiveTurnContext.reconstruct(journal, turn.admittedTurn.turnId);
    const initial = cold.initialInput();
    assert.ok(initial, 'durable initial input');
    const units = [{ kind: 'message', role: 'user', text: new TextDecoder().decode(await rawReader.read({ scope, content: initial })) }];
    const content = new Map();
    for (const entry of cold.entries()) {
      assert.ok('envelope' in entry, 'ordinary Provider facts only');
      const { fact, request } = entry.envelope;
      if (fact.kind === 'tool-call') {
        units.push({ kind: 'tool-call', callId: fact.call.callId, toolId: fact.call.toolId, arguments: fact.call.arguments });
        continue;
      }
      if (fact.kind === 'tool-result') {
        const output = new TextDecoder().decode(await rawReader.read({ scope, content: fact.rawOutput }));
        units.push({ kind: 'tool-result', callId: fact.callId, toolId: fact.result.toolId, output, status: fact.result.status });
        continue;
      }
      if (fact.kind !== 'content' || fact.channel !== 'assistant-text') continue;
      const key = `${request.requestId}:${fact.contentUnitId}`;
      for (const replaced of fact.replacesUnitIds ?? []) content.delete(`${request.requestId}:${replaced}`);
      const text = new TextDecoder().decode(await rawReader.read({ scope, content: fact.content }));
      content.set(key, fact.update === 'full' ? text : (content.get(key) ?? '') + text);
    }
    for (const text of content.values()) units.push({ kind: 'message', role: 'assistant', text });
    return { units };
  }
  const nativeHooks = DURABLE ? {
    rawEvidence: sink,
    async registerRequest(registration) {
      if (!turn) {
        const turnId = registration.record.request.turnId;
        const cycleId = id('cycle', `provider-proof-${runId}`);
        const assignmentId = `assignment-${runId}`;
        journal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
        turn = await ActiveTurnContext.open({ journal, currentTurnRef: `fixture-current-${runId}`, binding: {
          execution: { runtimeId, executionEpoch: 1 }, scope,
          admittedTurn: { turnId, workAssignmentRef: assignmentId, taskRef: taskId, scopeRef: scope,
            cycleRef: cycleId, inputRevision: 1, directiveRevision: 1, executionEpoch: 1,
            runtimeBindingRef: runtimeId, permissionRevision: 'fixture-owned-provider-proof',
            admissionEvidenceRefs: [], currentTurnRef: `fixture-current-${runId}`, recoveryStateRef: `fixture-recovery-${runId}` },
          assignment: { assignmentId, taskId, pipelineNodeId: 'provider-proof', attempt: 1, executionEpoch: 1,
            inputRevision: 1, objective: receipt.request.prompt, targetRefs: [], expectedOutputRefs: [],
            acceptanceCriteriaDigest: `sha256:${createHash('sha256').update(receipt.request.prompt).digest('hex')}`,
            successCriteria: ['two ordinary requests in one turn'], failureCriteria: ['request failure'],
            incompleteCriteria: ['unreleased resource'], requiredCapabilities: [], mergeGate: 'not-required' },
        } });
        const ref = await sink.write({ scope, kind: 'execution', type: 'proof-initial-input', locator: runId, content: receipt.request.prompt });
        await turn.registerInitialInput({ ref, view: { kind: 'utf8-text' } });
        receipt.fixture = { kind: 'fixture-owned-runtime-producers', journalPath, binding: turn.activeBinding };
      }
      return turn.registerProviderRequest(registration);
    },
    acceptRawFact: (envelope) => turn.acceptRawFact(envelope),
    async requestContext(input) {
      assert.ok(turn.requests().some((record) => record.request.requestId === input.request.requestId && record.phase === 'dispatching'), 'registration precedes materialization');
      const canonical = await latestCanonical();
      receipt.contextReads.push({ input, canonical: structuredClone(canonical), acceptedSeq: turn.entries().at(-1)?.seq ?? 0 });
      return { canonical };
    },
  } : {};
  if (DURABLE) {
    receipt.mode = EXPLICIT_STOP ? 'explicit-stop' : TOOL_LOOP ? 'tool-loop' : 'continue-current-turn';
    receipt.contextReads = [];
    receipt.requests = [];
    receipt.transientInstructions = transientInstructions;
    receipt.executionActions = [];
  }
  const tools = TOOL_LOOP ? [echoTool()] : undefined;
  const executeTool = TOOL_LOOP ? {
    async execute(input) {
      const probeId = typeof input.call.arguments?.probeId === 'string' ? input.call.arguments.probeId : 'n4';
      const output = JSON.stringify({ probeId, status: 'TOOL_OK' });
      const ref = await sink.write({
        scope, kind: 'tool', type: 'proof-tool-output', locator: `provider/tool-result/${input.call.callId}`, content: output,
      });
      return { output, outputRefs: [], evidenceRefs: [ref], status: 'succeeded' };
    },
  } : undefined;
  let intentionalStopInFlight = false;
  const proofPort = EXPLICIT_STOP ? new Proxy(composition.port, {
    get(target, key) {
      if (key === 'requestStop') return async (input) => {
        const call = { input };
        // Cleanup stop is diagnostic only; it cannot replace intentional stop.
        if (intentionalStopInFlight) receipt.portStop = call;
        else (receipt.cleanupPortStops ??= []).push(call);
        try {
          call.receipt = await target.requestStop.call(target, input);
          return call.receipt;
        } catch (error) {
          call.error = errorRecord(error);
          throw error;
        }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) : composition.port;
  const driver = new ProviderAgentDriver({
    port: proofPort, binding: composition.binding, runtimeId, taskId, operationId, executionEpoch: 1,
    assignmentId: `assignment-${runId}`, scope, inputRefs: [], ownerId: 'humanagent.provider-proof',
    onRequestLifecycle: (event) => {
      receipt.lifecycle.push(event);
      receipt.generationAttempts = new Set(receipt.lifecycle
        .filter((entry) => entry.phase === 'dispatching').map((entry) => entry.requestId)).size;
    },
    ...nativeHooks,
    ...(TOOL_LOOP ? { tools, executeTool, maxToolRounds: 1 } : {}),
  });
  let active = false;
  let pendingStart = false;
  let expired = false;
  const save = () => writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await save();
  try {
    await bounded((async () => {
      receipt.admission = { state: 'admitting' };
      const readiness = await admitAgentProvider(composition);
      if (expired) throw new Error('admission completed after proof deadline; generation forbidden');
      receipt.admission = { state: 'admitted', readiness };
      assert.equal(readiness.bindingId, composition.binding.bindingId);
      assert.equal(readiness.protocol, composition.binding.protocol);
      assert.equal(readiness.capabilityDigest, composition.binding.capabilityDigest);
      await driver.start({ runtimeId, taskId, executionEpoch: 1 });
      if (expired) throw new Error('driver start completed after proof deadline; generation forbidden');
      pendingStart = true;
      receipt.submit = await driver.submit({ taskId, executionEpoch: 1, assignmentId: `assignment-${runId}`, payload: { prompt: receipt.request.prompt } });
      pendingStart = false;
      active = true;
      // The driver executes echo_probe and dispatches the canonical tool-call
      // plus tool-result continuation on this same open turn. The observe loop
      // returns only after the final text request completes. That automatic
      // continuation is never a second continueCurrentTurn call.
      const observed = [];
      let terminalSeen = false;
      for await (const event of driver.observe({ runtimeId })) {
        observed.push(event);
        receipt.observed.push(event);
        terminalSeen ||= event.kind === 'provider.terminal';
        if (EXPLICIT_STOP && !receipt.stopTrigger && !receipt.windowMissed && !terminalSeen
          && event.kind === 'provider.output' && event.summary?.trim()) {
          const cold = await ActiveTurnContext.reconstruct(journal, turn.admittedTurn.turnId);
          const content = cold.entries().findLast((entry) => entry.envelope.request.requestId === event.providerEvent.requestId
            && entry.envelope.fact.kind === 'content' && entry.envelope.fact.channel === 'assistant-text');
          assert.ok(content, 'output raw content already durably accepted');
          if (cold.entries().some((entry) => entry.envelope.request.requestId === event.providerEvent.requestId
            && entry.envelope.fact.kind === 'request-complete')) {
            receipt.windowMissed = 'raw terminal already accepted before output consumption';
            continue;
          }
          receipt.stopTrigger = { event, request: content.envelope.request, producerSeq: content.envelope.producerSeq,
            lifecycle: structuredClone(receipt.lifecycle), terminalSeen,
            rawText: new TextDecoder().decode(await rawReader.read({ scope, content: content.envelope.fact.content })) };
          assert.equal(receipt.submit.payload.status, 'accepted');
          assert.ok(receipt.lifecycle.some((entry) => entry.phase === 'dispatched' && entry.requestId === event.providerEvent.requestId));
          intentionalStopInFlight = true;
          try {
            receipt.stop = await driver.requestStop({ runtimeId, executionEpoch: 1, operationId });
          } finally { intentionalStopInFlight = false; }
          if (receipt.portStop.receipt.status === 'rejected') {
            if (receipt.portStop.receipt.error?.code === 'stop.after-terminal') receipt.windowMissed = 'stop.after-terminal';
            else throw receipt.portStop.receipt.error ?? new Error('intentional stop rejected');
          }
        }
      }
      if (EXPLICIT_STOP) {
        if (!receipt.stopTrigger) receipt.windowMissed ??= 'stream ended before an eligible stop window';
        receipt.drainBoundaryId = `provider-explicit-stop-${runId}`;
        receipt.drain = await driver.closeProductionAndDrain({ execution: { runtimeId, executionEpoch: 1 }, boundaryId: receipt.drainBoundaryId });
      }
      if (TOOL_LOOP) {
        receipt.requests.push({ submit: receipt.submit, observed });
        receipt.canonicalReadback = await latestCanonical();
        receipt.durableRequests = turn.requests();
        receipt.acceptedRawFacts = turn.entries();
        receipt.journalRecords = await journal.replay();
        receipt.toolOutputs = await Promise.all(receipt.acceptedRawFacts
          .filter((entry) => entry.envelope.fact.kind === 'tool-result')
          .map(async (entry) => {
            const { fact } = entry.envelope;
            const output = new TextDecoder().decode(await rawReader.read({ scope, content: fact.rawOutput }));
            return { ...fact.result, output };
          }));
      }
      if (CONTINUE_CURRENT_TURN) {
        receipt.requests.push({ submit: receipt.submit, observed: [...receipt.observed] });
        assert.ok(receipt.observed.some((event) => event.kind === 'provider.terminal' && event.terminalState === 'succeeded'), 'first ordinary success');
        assert.equal(new Set(receipt.lifecycle.map((event) => event.requestId)).size, 1, 'no automatic tool request');
        assert.equal(driver.settlement(), undefined, 'no execution settlement between requests');
        assert.equal(receipt.close, undefined, 'no close between requests');
        receipt.betweenRequests = { settlement: 'absent', close: 'not-called', requests: turn.requests() };
        assert.equal(turn.requests().at(-1)?.phase, 'settled', 'first request durably terminal');
        receipt.continuationSubmit = await driver.continueCurrentTurn({ instructions: transientInstructions });
        const observed = [];
        for await (const event of driver.observe({ runtimeId })) {
          observed.push(event);
          receipt.observed.push(event);
        }
        receipt.requests.push({ submit: receipt.continuationSubmit, observed });
        receipt.canonicalReadback = await latestCanonical();
        receipt.durableRequests = turn.requests();
        receipt.acceptedRawFacts = turn.entries();
        receipt.journalRecords = await journal.replay();
      }
      if (NATIVE_TURN) receipt.executionActions.push('settle');
      receipt.closure = await driver.settle({ runtimeId, executionEpoch: 1 });
      receipt.settlement = driver.settlement();
      if (EXPLICIT_STOP && receipt.settlement?.error) throw receipt.settlement.error;
    })(), 90_000, 'admission/generation');
  } catch (error) {
    expired = true;
    receipt.error = errorRecord(error);
    if (receipt.admission?.state === 'admitting') receipt.admission = { state: 'rejected-or-pending', error: errorRecord(error) };
  } finally {
    try {
      await bounded((async () => {
        try {
          if (active && !receipt.settlement) {
            if (!EXPLICIT_STOP || !receipt.portStop) {
              const stop = await driver.requestStop({ runtimeId, executionEpoch: 1, operationId });
              if (EXPLICIT_STOP) receipt.cleanupStop = stop;
              else receipt.stop = stop;
            }
            if (EXPLICIT_STOP) receipt.cleanupDrain = await driver.closeProductionAndDrain({
              execution: { runtimeId, executionEpoch: 1 }, boundaryId: `cleanup-${runId}`,
            });
            if (NATIVE_TURN) receipt.executionActions.push('settle');
            receipt.closure = await driver.settle({ runtimeId, executionEpoch: 1 });
            receipt.settlement = driver.settlement();
          }
        } finally {
          if (NATIVE_TURN) receipt.executionActions.push('close');
          receipt.close = await driver.close();
        }
      })(), 10_000, 'cleanup');
    } catch (error) { receipt.cleanupError = errorRecord(error); }
    receipt.pendingStart = pendingStart;
    receipt.cleanup = receipt.close?.state === 'closed' && !pendingStart && !receipt.cleanupError ? 'closed' : 'INCOMPLETE';
  }
  try {
    if (EXPLICIT_STOP && turn) {
      const cold = await ActiveTurnContext.reconstruct(journal, turn.admittedTurn.turnId);
      receipt.durableRequests = cold.requests();
      receipt.acceptedRawFacts = cold.entries();
      receipt.journalRecords = await journal.replay();
    }
    const refs = new Map();
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      if (value.evidenceId && value.locator && value.digest) refs.set(value.locator, value);
      for (const item of Object.values(value)) collect(item);
    }
    collect(receipt);
    for (const ref of refs.values()) {
      assert.ok(ref.locator.startsWith(`${artifactRoot}/`));
      assert.equal(ref.source, 'humanagent.provider-adapter');
      const bytes = await sink.read(ref);
      const text = new TextDecoder().decode(bytes);
      let content;
      try { content = JSON.parse(text); } catch { content = text; }
      receipt.assets.push({ ref, size: bytes.length, content });
    }
    const starts = receipt.assets.filter(({ content }) => content?.endpoint === ENDPOINT && content?.status !== undefined);
    if (receipt.generationAttempts && !receipt.error) {
      assert.equal(starts.length, NATIVE_TURN ? 2 : 1, 'real transport request assets');
      for (const start of starts) {
        assert.equal(start.content.protocol, PROTOCOL);
        assert.equal(start.content.model, MODEL);
        assert.equal(start.content.route, `${SOURCE}:${ROUTE}`);
        assert.ok(start.content.status >= 200 && start.content.status < 300);
      }
      const identities = [...receipt.lifecycle, ...receipt.observed.map((event) => event.providerEvent)];
      assert.equal(new Set(identities.map((event) => event.turnId)).size, 1);
      assert.equal(new Set(identities.map((event) => event.requestId)).size, NATIVE_TURN ? 2 : 1);
      if (TOOL_LOOP) {
        assert.deepEqual(receipt.executionActions, ['settle', 'close'], 'one final execution settlement and close');
        assert.equal(receipt.toolOutputs.length, 1, 'exactly one executed echo_probe call');
        assert.equal(receipt.toolOutputs[0].output.includes('TOOL_OK'), true);
        assert.equal(receipt.toolOutputs[0].status, 'succeeded');
        const [initial, continuation] = receipt.contextReads;
        assert.equal(receipt.contextReads.length, 2, 'one fresh hook for the initial request and the tool continuation');
        assert.equal(initial.input.phase, 'initial');
        assert.equal(continuation.input.phase, 'continuation');
        assert.equal(initial.input.request.parentRequestId, undefined);
        assert.equal(continuation.input.request.parentRequestId, initial.input.request.requestId);
        assert.equal(continuation.input.request.turnId, initial.input.request.turnId);
        assert.ok(continuation.acceptedSeq > initial.acceptedSeq, 'accepted tool facts are visible to the continuation');
        const toolUnit = continuation.canonical.units.find((unit) => unit.kind === 'tool-call');
        const resultUnit = continuation.canonical.units.find((unit) => unit.kind === 'tool-result');
        assert.ok(toolUnit && toolUnit.toolId === 'echo_probe');
        assert.ok(resultUnit && resultUnit.status === 'succeeded');
        assert.equal(resultUnit.callId, toolUnit.callId);
        assert.ok(JSON.stringify(continuation.input.execution).includes(runtimeId));
        const receiptAssets = starts.map(({ content }) => content).filter((content) => content.requestReceipt);
        const startAsset = receiptAssets.find((content) => content.requestReceipt.parentRequestId === undefined);
        const continuationAsset = receiptAssets.find((content) => content.requestReceipt.parentRequestId !== undefined);
        assert.ok(startAsset && continuationAsset, 'transport exposes both the start and tool-continuation request receipts');
        assert.equal(startAsset.requestReceipt.parentRequestId, undefined, 'initial request has no parent');
        assert.equal(continuationAsset.requestReceipt.parentRequestId, initial.input.request.requestId, 'tool continuation is parented to the initial request');
        assert.equal(continuationAsset.requestReceipt.turnId, initial.input.request.turnId, 'both requests stay in one turn');
        // Read the real outbound wire body recorded by the transport, not a
        // reconstructed request. Protocol shapes differ; every protocol must
        // carry the declared echo_probe tool plus the paired call and result.
        const wire = (asset) => JSON.parse(asset.requestReceipt.body);
        const startWire = wire(startAsset);
        const continuationWire = wire(continuationAsset);
        if (PROTOCOL === 'responses') {
          assert.equal(startWire.tools[0].name, 'echo_probe');
          const continuationInput = continuationWire.input;
          assert.equal(continuationInput.some((item) => item.type === 'function_call' && item.name === 'echo_probe'), true, 'Responses function_call on the wire');
          assert.equal(continuationInput.some((item) => item.type === 'function_call_output' && item.call_id === toolUnit.callId && String(item.output).includes('TOOL_OK')), true, 'Responses function_call_output on the wire');
        } else if (PROTOCOL === 'openai') {
          assert.equal(startWire.tools[0].function.name, 'echo_probe');
          const toolCall = continuationWire.messages.flatMap((message) => message.tool_calls ?? []).find((call) => call.id === toolUnit.callId);
          assert.ok(toolCall && toolCall.function.name === 'echo_probe', 'OpenAI tool_calls on the wire');
          assert.equal(continuationWire.messages.some((message) => message.role === 'tool' && message.tool_call_id === toolUnit.callId && String(message.content).includes('TOOL_OK')), true, 'OpenAI role tool message on the wire');
        } else {
          assert.equal(startWire.tools[0].name, 'echo_probe');
          const content = continuationWire.messages.flatMap((message) => message.content ?? []);
          const toolUse = content.find((block) => block.type === 'tool_use' && block.id === toolUnit.callId);
          assert.ok(toolUse && toolUse.name === 'echo_probe', 'Anthropic tool_use on the wire');
          assert.equal(content.some((block) => block.type === 'tool_result' && block.tool_use_id === toolUnit.callId && String(block.content).includes('TOOL_OK')), true, 'Anthropic tool_result on the wire');
        }
        assert.ok(identities.some((event) => event.requestId === continuation.input.request.requestId
          && event.parentRequestId === initial.input.request.requestId), 'tool continuation keeps the parent chain');
        for (const request of receipt.requests) {
          assert.ok(request.observed.some((event) => event.kind === 'provider.output' && typeof event.summary === 'string' && event.summary.trim()), 'actual per-request output');
          assert.ok(request.observed.some((event) => event.kind === 'provider.terminal' && event.terminalState === 'succeeded'), 'per-request finish');
        }
      }
      if (CONTINUE_CURRENT_TURN) {
        assert.deepEqual(receipt.executionActions, ['settle', 'close'], 'one final execution settlement and close');
        assert.equal(receipt.requests.length, 2);
        assert.equal(receipt.contextReads.length, 2, 'one fresh hook per ordinary request');
        const [first, second] = receipt.contextReads;
        assert.equal(first.input.phase, 'initial');
        assert.equal(second.input.phase, 'continuation');
        assert.equal(first.input.request.parentRequestId, undefined);
        assert.notEqual(second.input.request.requestId, first.input.request.requestId);
        assert.equal(second.input.request.parentRequestId, first.input.request.requestId);
        assert.equal(second.input.request.turnId, first.input.request.turnId);
        assert.deepEqual(second.input.execution, first.input.execution);
        assert.ok(second.acceptedSeq > first.acceptedSeq, 'latest accepted raw facts are visible');
        assert.ok(second.canonical.units.some((unit) => unit.role === 'assistant' && unit.text.trim()), 'first output in second canonical request');
        for (const request of receipt.requests) {
          assert.ok(request.observed.some((event) => event.kind === 'provider.output' && typeof event.summary === 'string' && event.summary.trim()), 'actual per-request output');
          assert.ok(request.observed.some((event) => event.kind === 'provider.terminal' && event.terminalState === 'succeeded'), 'ordinary per-request finish');
        }
        for (const hook of receipt.contextReads) assert.ok(!JSON.stringify(hook.canonical).includes(transientInstructions.text), 'instructions excluded from canonical hook');
        assert.ok(!JSON.stringify(receipt.canonicalReadback).includes(transientInstructions.text), 'instructions excluded from next readback');
        assert.ok(!JSON.stringify(receipt.journalRecords).includes(transientInstructions.text), 'instructions excluded from durable turn history');
        for (const hook of receipt.contextReads) {
          const requestId = hook.input.request.requestId;
          assert.ok(receipt.durableRequests.some((record) => record.request.requestId === requestId && record.phase === 'settled'), 'durable request terminal');
          assert.ok(receipt.acceptedRawFacts.some((entry) => entry.envelope.request.requestId === requestId && entry.envelope.fact.kind === 'request-complete' && entry.envelope.fact.terminal === 'completed'), 'accepted raw completion');
        }
        assert.ok(identities.every((event) => event.requestId === first.input.request.requestId
          ? event.parentRequestId === undefined : event.parentRequestId === first.input.request.requestId));
      } else if (!NATIVE_TURN) {
        assert.ok(identities.every((event) => event.parentRequestId === undefined));
      }
      for (const event of receipt.lifecycle) {
        assert.equal(event.runtimeId, runtimeId);
        assert.deepEqual(event.taskId, taskId);
        assert.deepEqual(event.operationId, operationId);
        assert.equal(event.executionEpoch, 1);
      }
      if (!EXPLICIT_STOP || !receipt.windowMissed) {
        assert.ok(receipt.observed.some((event) => event.kind === 'provider.output' && typeof event.summary === 'string' && event.summary.trim().length > 0), 'actual decoded text');
      }
      if (!EXPLICIT_STOP) {
        assert.ok(receipt.observed.some((event) => event.kind === 'provider.terminal' && event.terminalState === 'succeeded'), 'protocol terminal');
        assert.equal(receipt.closure?.state, 'succeeded');
        assert.equal(receipt.lifecycle.at(-1)?.phase, 'settled');
      }
      assert.equal(receipt.settlement?.resourceRelease.state, 'released');
      if (EXPLICIT_STOP && !receipt.windowMissed) assertExplicitStop(receipt);
    }
    assert.equal(receipt.close?.state, 'closed', 'close state must be the literal closed');
    assert.ok(receipt.close.evidenceRefs.some((ref) => receipt.assets.some((asset) => asset.ref.locator === ref.locator)), 'readable close evidence');
    receipt.result = receipt.error || receipt.cleanup !== 'closed' ? 'FAIL'
      : EXPLICIT_STOP && receipt.windowMissed ? 'UNVERIFIED'
      : receipt.generationAttempts === (NATIVE_TURN ? 2 : 1) ? 'PASS' : 'BLOCKED';
  } catch (error) {
    receipt.assertionError = errorRecord(error);
    receipt.result = 'FAIL';
  }
  receipt.publicResponseIdentity = receipt.assets.flatMap(({ ref, content }) => {
    const record = content?.response ?? content?.message ?? content;
    return record && typeof record === 'object' && (typeof record.model === 'string' || typeof record.id === 'string')
      ? [{ locator: ref.locator, eventType: content.type, id: record.id, model: record.model }] : [];
  }).filter((record) => record.eventType || record.id);
  receipt.actualResponseModel = receipt.publicResponseIdentity.some((record) => record.model)
    ? receipt.publicResponseIdentity.filter((record) => record.model)
    : 'UNVERIFIED: default public codec evidence does not retain a returned model';
  await save();
  console.log(JSON.stringify({ result: receipt.result, protocol: PROTOCOL, generationAttempts: receipt.generationAttempts, receiptPath, closure: receipt.closure?.state, resourceRelease: receipt.settlement?.resourceRelease.state, close: receipt.close?.state, cleanup: receipt.cleanup, error: receipt.error?.message, assertionError: receipt.assertionError?.message }));
  // Pending HTTP start has no stoppable public driver identity: keep it unknown.
  // Exit only this owned proof process after bounded actual cleanup.
  process.exit(receipt.result === 'PASS' ? 0 : 1);
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
