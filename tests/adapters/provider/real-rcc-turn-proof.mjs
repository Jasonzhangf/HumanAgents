#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateUserConfig, compileAgentProviderBindings, resolveRuntimePaths } from '../../../dist/app/config/src/index.js';
import { selectAgentProvider, providerBindingFromConfig, createAgentProviderPort } from '../../../dist/app/app/src/agent-driver-composition.js';
import { admitAgentProvider } from '../../../dist/app/app/src/agent-provider-admission.js';
import { ProviderAgentDriver, filesystemProviderEvidenceSink } from '../../../dist/app/adapters/provider/src/index.js';
import { ImmutableAssetStore } from '../../../dist/app/adapters/filesystem/src/index.js';
import { id } from '../../../dist/app/contracts/src/index.js';

const BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_RCC_MODEL ?? 'gpt-5.5';
const PROTOCOL = process.env.HUMANAGENT_RCC_PROTOCOL ?? 'responses';
const CONTINUE_CURRENT_TURN = process.env.HUMANAGENT_RCC_CONTINUE_CURRENT_TURN === '1';
assert.ok(['responses', 'openai', 'anthropic'].includes(PROTOCOL), 'unsupported RCC proof protocol');
const ENDPOINT = { responses: '/v1/responses', openai: '/v1/chat/completions', anthropic: '/v1/messages' }[PROTOCOL];

// Known failure: old proof bypassed default composition and deleted evidence.
// Failure probability is unknown; cost is one short generation per invocation.
// Accepted fake/replay counterexamples are reused without another fault matrix.
function candidateIdentity() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const hash = createHash('sha256');
  for (const file of git('ls-files', '-z').split('\0').filter(Boolean).sort()) {
    hash.update(file).update('\0').update(readFileSync(file)).update('\0');
  }
  return {
    head: git('rev-parse', 'HEAD').trim(),
    sourceDigest: `sha256:${hash.digest('hex')}`,
    statusShort: git('status', '--short'),
    proofDigest: `sha256:${createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')}`,
  };
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

async function run() {
  const paths = await resolveRuntimePaths({ workspace: process.cwd(), controlRoot: join(homedir(), '.humanagent') });
  const continuationRoot = join(paths.controlRoot, 'test-fixtures', 'provider-current-turn-proof-r1-20261013');
  if (CONTINUE_CURRENT_TURN) assert.equal(process.env.HUMANAGENT_TEST_ROOT, continuationRoot, 'explicit canonical owned fixture root required');
  const ownedRoot = CONTINUE_CURRENT_TURN ? process.env.HUMANAGENT_TEST_ROOT : join(paths.controlRoot, 'test-fixtures', 'provider-protocol-live-r1-20261013');
  await mkdir(ownedRoot, { recursive: true });
  const root = await mkdtemp(join(ownedRoot, `${PROTOCOL}-`));
  const artifactRoot = join(await realpath(root), 'assets');
  await mkdir(artifactRoot);
  const receiptPath = join(root, 'receipt.json');
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
    provider: { provider: 'rcc', source: 'rcc', binding: `proof-${PROTOCOL}-${runId}`, protocol: PROTOCOL, model: MODEL, route: 'default', baseUrl: BASE_URL },
  });
  const composition = selectAgentProvider({
    roleId: 'interaction', agentId: 'provider-proof', agentProviderBindings: compileAgentProviderBindings(user),
    createPort: (selected) => createAgentProviderPort(selected, artifactRoot),
  });
  assert.deepEqual(composition.binding, providerBindingFromConfig(user.provider));
  const receipt = {
    schemaVersion: 2, kind: 'humanagent.provider-dependency-proof', generatedAt: new Date().toISOString(),
    candidate: candidateIdentity(), protocol: PROTOCOL, source: composition.source,
    provider: composition.provider, binding: composition.binding,
    composition: 'validateUserConfig → compileAgentProviderBindings → selectAgentProvider → createAgentProviderPort → admitAgentProvider → ProviderAgentDriver',
    request: { endpoint: `${BASE_URL}${ENDPOINT}`, protocol: PROTOCOL, model: MODEL, prompt: 'Reply with the single word OK.' },
    generationAttempts: 0, artifactRoot, receiptPath, lifecycle: [], observed: [], assets: [],
    rawOutboundBody: 'UNVERIFIED: public transport evidence does not expose actual outbound body',
    upstreamAttribution: 'UNVERIFIED: no correlated public RCC upstream request record',
    scopeClaim: 'Provider dependency consumer only; no Task/standard turn/native/UI/G5 claim',
  };
  const sink = filesystemProviderEvidenceSink(new ImmutableAssetStore(artifactRoot));
  const { createJsonlActiveTurnJournal } = CONTINUE_CURRENT_TURN
    ? await import('../../../dist/app/adapters/jsonl/src/active-turn.js') : {};
  const { ActiveTurnContext } = CONTINUE_CURRENT_TURN
    ? await import('../../../dist/app/runtime/src/context/active-turn-context.js') : {};
  const { providerRawContentReader } = CONTINUE_CURRENT_TURN
    ? await import('../../../dist/app/adapters/provider/src/evidence.js') : {};
  const transientInstructions = { text: `Continuation proof ${runId}: reply with the single word CONTINUED.` };
  let turn;
  let journal;
  const rawReader = CONTINUE_CURRENT_TURN ? providerRawContentReader(sink) : undefined;
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
      assert.ok(fact.kind !== 'tool-call' && fact.kind !== 'tool-result', 'ordinary no-tool proof required');
      if (fact.kind !== 'content' || fact.channel !== 'assistant-text') continue;
      const key = `${request.requestId}:${fact.contentUnitId}`;
      for (const replaced of fact.replacesUnitIds ?? []) content.delete(`${request.requestId}:${replaced}`);
      const text = new TextDecoder().decode(await rawReader.read({ scope, content: fact.content }));
      content.set(key, fact.update === 'full' ? text : (content.get(key) ?? '') + text);
    }
    for (const text of content.values()) units.push({ kind: 'message', role: 'assistant', text });
    return { units };
  }
  const nativeHooks = CONTINUE_CURRENT_TURN ? {
    rawEvidence: sink,
    async registerRequest(registration) {
      if (!turn) {
        const turnId = registration.record.request.turnId;
        const cycleId = id('cycle', `provider-proof-${runId}`);
        const assignmentId = `assignment-${runId}`;
        journal = createJsonlActiveTurnJournal({ filePath: join(root, 'journal.jsonl'), turnId });
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
        receipt.fixture = { kind: 'fixture-owned-runtime-producers', journalPath: join(root, 'journal.jsonl'), binding: turn.activeBinding };
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
  if (CONTINUE_CURRENT_TURN) {
    receipt.mode = 'continue-current-turn';
    receipt.contextReads = [];
    receipt.requests = [];
    receipt.transientInstructions = transientInstructions;
    receipt.executionActions = [];
  }
  const driver = new ProviderAgentDriver({
    port: composition.port, binding: composition.binding, runtimeId, taskId, operationId, executionEpoch: 1,
    assignmentId: `assignment-${runId}`, scope, inputRefs: [], ownerId: 'humanagent.provider-proof',
    onRequestLifecycle: (event) => receipt.lifecycle.push(event),
    ...nativeHooks,
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
      receipt.generationAttempts = 1;
      pendingStart = true;
      receipt.submit = await driver.submit({ taskId, executionEpoch: 1, assignmentId: `assignment-${runId}`, payload: { prompt: receipt.request.prompt } });
      pendingStart = false;
      active = true;
      for await (const event of driver.observe({ runtimeId })) receipt.observed.push(event);
      if (CONTINUE_CURRENT_TURN) {
        receipt.requests.push({ submit: receipt.submit, observed: [...receipt.observed] });
        assert.ok(receipt.observed.some((event) => event.kind === 'provider.terminal' && event.terminalState === 'succeeded'), 'first ordinary success');
        assert.equal(new Set(receipt.lifecycle.map((event) => event.requestId)).size, 1, 'no automatic tool request');
        assert.equal(driver.settlement(), undefined, 'no execution settlement between requests');
        assert.equal(receipt.close, undefined, 'no close between requests');
        receipt.betweenRequests = { settlement: 'absent', close: 'not-called', requests: turn.requests() };
        assert.equal(turn.requests().at(-1)?.phase, 'settled', 'first request durably terminal');
        receipt.generationAttempts = 2;
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
      if (CONTINUE_CURRENT_TURN) receipt.executionActions.push('settle');
      receipt.closure = await driver.settle({ runtimeId, executionEpoch: 1 });
      receipt.settlement = driver.settlement();
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
            receipt.stop = await driver.requestStop({ runtimeId, executionEpoch: 1, operationId });
            if (CONTINUE_CURRENT_TURN) receipt.executionActions.push('settle');
            receipt.closure = await driver.settle({ runtimeId, executionEpoch: 1 });
            receipt.settlement = driver.settlement();
          }
        } finally {
          if (CONTINUE_CURRENT_TURN) receipt.executionActions.push('close');
          receipt.close = await driver.close();
        }
      })(), 10_000, 'cleanup');
    } catch (error) { receipt.cleanupError = errorRecord(error); }
    receipt.pendingStart = pendingStart;
    receipt.cleanup = receipt.close?.state === 'closed' && !pendingStart && !receipt.cleanupError ? 'closed' : 'INCOMPLETE';
  }
  try {
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
    if (receipt.generationAttempts) {
      assert.equal(starts.length, CONTINUE_CURRENT_TURN ? 2 : 1, 'real transport request assets');
      for (const start of starts) {
        assert.equal(start.content.protocol, PROTOCOL);
        assert.equal(start.content.model, MODEL);
        assert.equal(start.content.route, 'rcc:default');
        assert.ok(start.content.status >= 200 && start.content.status < 300);
      }
      const identities = [...receipt.lifecycle, ...receipt.observed.map((event) => event.providerEvent)];
      assert.equal(new Set(identities.map((event) => event.turnId)).size, 1);
      assert.equal(new Set(identities.map((event) => event.requestId)).size, CONTINUE_CURRENT_TURN ? 2 : 1);
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
      } else {
        assert.ok(identities.every((event) => event.parentRequestId === undefined));
      }
      for (const event of receipt.lifecycle) {
        assert.equal(event.runtimeId, runtimeId);
        assert.deepEqual(event.taskId, taskId);
        assert.deepEqual(event.operationId, operationId);
        assert.equal(event.executionEpoch, 1);
      }
      assert.ok(receipt.observed.some((event) => event.kind === 'provider.output' && typeof event.summary === 'string' && event.summary.trim().length > 0), 'actual decoded text');
      assert.ok(receipt.observed.some((event) => event.kind === 'provider.terminal' && event.terminalState === 'succeeded'), 'protocol terminal');
      assert.equal(receipt.closure?.state, 'succeeded');
      assert.equal(receipt.settlement?.resourceRelease.state, 'released');
      assert.equal(receipt.lifecycle.at(-1)?.phase, 'settled');
    }
    assert.equal(receipt.close?.state, 'closed');
    assert.ok(receipt.close.evidenceRefs.some((ref) => receipt.assets.some((asset) => asset.ref.locator === ref.locator)), 'readable close evidence');
    receipt.result = receipt.error ? 'FAIL' : receipt.generationAttempts === (CONTINUE_CURRENT_TURN ? 2 : 1) ? 'PASS' : 'BLOCKED';
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
