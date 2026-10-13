import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AcceptedRawFact,
  type ActiveTurnBinding,
  type AdmittedTurn,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type NativeRequestRegistration,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderStartInput,
  type ProviderSubmitInput,
  type ProviderSubmitResult,
  type RawFactEnvelope,
  type RuntimeRequestRecord,
  type ScopeRef,
  type WorkAssignment,
} from '../../../packages/contracts/src/index.js';
import type {
  MaterializedRequestInput,
  ProviderRequestContextHook,
} from '../../../packages/contracts/src/provider-request-context.js';
import {
  ProviderAdapter,
  ProviderAdapterError,
  ProviderAgentDriver,
  AnthropicProviderCodec,
  ResponsesProviderCodec,
  createV3ProviderHttpTransport,
  filesystemProviderEvidenceSink,
  type ProviderAgentEvent,
  type ProviderEvidenceSink,
  type V3ProviderFetch,
  type V3ProviderFetchResponse,
} from '../../../packages/adapters/provider/src/index.js';
import { ImmutableAssetStore } from '../../../packages/adapters/filesystem/src/index.js';
import { ActiveTurnContext } from '../../../packages/runtime/src/context/active-turn-context.js';
import type {
  ActiveTurnJournalPort,
  ActiveTurnJournalRecord,
} from '../../../packages/runtime/src/context/active-turn-journal.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';

const organ = id('organ', 'organ-cont');
const taskId = id('task', 'task-cont');
const operationId = id('operation', 'operation-cont');
const scope: ScopeRef = { organId: organ, taskId, operationId };
const evidence: EvidenceRef = {
  evidenceId: id('evidence', 'cont-scope'),
  kind: 'operation',
  source: 'provider-current-turn-continuation-test',
  locator: `operation/${operationId.value}/scope`,
  scope,
};
const binding: ProviderBinding = {
  bindingId: 'binding-cont',
  providerId: 'provider-cont',
  protocol: 'responses',
  endpointRef: 'endpoint-cont',
  modelRef: 'model-cont',
  configDigest: 'sha256:config',
  capabilityDigest: 'sha256:capability',
};
const runtimeId = 'runtime-cont';
const executionEpoch = 1;

async function fixtureRoot(prefix: string): Promise<string> {
  const base = process.env.HUMANAGENT_TEST_ROOT ?? join(Reflect.get(os, 'homedir')(), '.humanagent', 'test-fixtures');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function sseResponse(events: readonly unknown[]): V3ProviderFetchResponse {
  const encoder = new TextEncoder();
  return {
    status: 200,
    body: (async function* () {
      for (const event of events) yield encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    })(),
    text: async () => '',
  };
}

function textRoundFetch(requests: unknown[]): V3ProviderFetch {
  return async (url, init) => {
    requests.push({ url, init });
    const round = requests.length;
    return sseResponse([
      { type: 'response.created', response: { id: `resp-cont-${round}` } },
      { type: 'response.output_text.done', item_id: `msg-cont-${round}`, text: `answer ${round}` },
      { type: 'response.completed', response: { id: `resp-cont-${round}` } },
    ]);
  };
}

class MemoryActiveTurnJournal implements ActiveTurnJournalPort {
  private readonly records: ActiveTurnJournalRecord[] = [];

  async append(input: { readonly commitId: string; readonly record: ActiveTurnJournalRecord }): Promise<void> {
    this.records.push(input.record);
  }

  async replay(): Promise<readonly ActiveTurnJournalRecord[]> {
    return [...this.records];
  }
}

function continuationBinding(): ActiveTurnBinding {
  const assignment: WorkAssignment = {
    assignmentId: 'assignment-cont',
    taskId,
    pipelineNodeId: 'node-cont',
    attempt: 1,
    executionEpoch,
    inputRevision: 1,
    objective: 'continuation public fixture',
    targetRefs: [],
    expectedOutputRefs: [],
    acceptanceCriteriaDigest: 'sha256:cont',
    successCriteria: [],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  };
  const admittedTurn: AdmittedTurn = {
    turnId: 'turn-cont',
    workAssignmentRef: assignment.assignmentId,
    taskRef: taskId,
    scopeRef: scope,
    cycleRef: id('cycle', 'cycle-cont'),
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch,
    runtimeBindingRef: 'runtime-binding-cont',
    permissionRevision: 'permission-cont',
    admissionEvidenceRefs: ['evidence-admission-cont'],
    currentTurnRef: 'active-turn://cont/binding',
    recoveryStateRef: 'evidence-recovery-cont',
  };
  return {
    admittedTurn,
    assignment,
    execution: { runtimeId, executionEpoch },
    scope,
  };
}

interface ContinuationHarnessInput {
  readonly root: string;
  readonly protocol?: 'anthropic';
  readonly fetch: V3ProviderFetch;
  readonly requestContext: ProviderRequestContextHook;
  readonly tools?: ProviderStartInput['tools'];
  readonly beforeRegister?: (registration: NativeRequestRegistration) => Promise<void>;
  readonly accept?: (
    inner: (envelope: RawFactEnvelope) => Promise<AcceptedRawFact>,
  ) => (envelope: RawFactEnvelope) => Promise<AcceptedRawFact>;
}

interface ContinuationHarness {
  readonly instance: ProviderAgentDriver;
  readonly context: ActiveTurnContext;
  readonly starts: ProviderStartInput[];
  readonly submissions: ProviderSubmitInput[];
  readonly settleCalls: () => number;
}

/**
 * Real ProviderAgentDriver + real ProviderAdapter + Responses codec + RCC
 * transport over a controlled fetch. The fake fetch only replaces the network.
 * Runtime request registration and raw acceptance run through the real
 * ActiveTurnContext, so request terminals are durable facts, not callbacks.
 */
async function continuationHarness(input: ContinuationHarnessInput): Promise<ContinuationHarness> {
  const providerBinding: ProviderBinding = { ...binding, protocol: input.protocol ?? binding.protocol };
  const store = new ImmutableAssetStore(input.root);
  const sink = filesystemProviderEvidenceSink(store, 'provider-continuation-test');
  const context = await ActiveTurnContext.open({
    journal: new MemoryActiveTurnJournal(),
    binding: continuationBinding(),
    currentTurnRef: 'active-turn://cont/binding',
  });
  const starts: ProviderStartInput[] = [];
  const submissions: ProviderSubmitInput[] = [];
  const transport = createV3ProviderHttpTransport({
    binding: providerBinding,
    baseUrl: 'http://127.0.0.1:4444',
    evidence: sink,
    fetch: input.fetch,
  });
  const adapter = new ProviderAdapter({
    binding: providerBinding,
    routeRef: 'test-route',
    codec: input.protocol === 'anthropic' ? new AnthropicProviderCodec(1024) : new ResponsesProviderCodec(),
    transport,
    evidence: sink,
  });
  let settleCalls = 0;
  const port: ExecutionRuntimePort = {
    kind: adapter.kind,
    probe: (target) => adapter.probe(target),
    capabilities: (target) => adapter.capabilities(target),
    start: (startInput) => {
      starts.push(startInput);
      return adapter.start(startInput);
    },
    resume: (resumeInput) => adapter.resume(resumeInput),
    submit: (submitInput) => {
      submissions.push(submitInput);
      return adapter.submit(submitInput);
    },
    observe: (observeInput) => adapter.observe(observeInput),
    requestStop: (stopInput) => adapter.requestStop(stopInput),
    settle: (settleInput) => {
      settleCalls += 1;
      return adapter.settle(settleInput);
    },
    close: (target) => adapter.close(target),
  };
  const acceptBase = (envelope: RawFactEnvelope): Promise<AcceptedRawFact> => context.acceptRawFact(envelope);
  const acceptRawFact = input.accept === undefined ? acceptBase : input.accept(acceptBase);
  const registerRequest = async (registration: NativeRequestRegistration): Promise<RuntimeRequestRecord> => {
    if (input.beforeRegister !== undefined) await input.beforeRegister(registration);
    return context.registerRequest(registration.record);
  };
  const instance = new ProviderAgentDriver({
    port,
    binding: providerBinding,
    runtimeId,
    taskId,
    operationId,
    executionEpoch,
    assignmentId: 'assignment-cont',
    scope,
    inputRefs: ['input-1'],
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    rawEvidence: sink,
    acceptRawFact,
    registerRequest,
    requestContext: input.requestContext,
  });
  return { instance, context, starts, submissions, settleCalls: () => settleCalls };
}

test('continueCurrentTurn dispatches a second ordinary request in the same turn with fresh identity, latest context and request-scoped instructions', async () => {
  const root = await fixtureRoot('humanagent-provider-cont-');
  try {
    const requests: unknown[] = [];
    const acceptEntered = deferred<void>();
    const releaseAccept = deferred<void>();
    const hookPhases: string[] = [];
    const returned: MaterializedRequestInput[] = [];
    const requestContext: ProviderRequestContextHook = async (hookInput) => {
      hookPhases.push(hookInput.phase);
      const materialized: MaterializedRequestInput = hookInput.phase === 'initial'
        ? { canonical: { units: [{ kind: 'message', role: 'user', text: 'first question' }] } }
        : {
            canonical: {
              units: [
                { kind: 'message', role: 'user', text: 'first question' },
                { kind: 'message', role: 'assistant', text: 'answer 1' },
                { kind: 'message', role: 'user', text: 'canonical follow-up' },
              ],
            },
            instructions: { text: 'HOOK_ORIENTATION' },
          };
      returned.push(structuredClone(materialized));
      return materialized;
    };
    const tools = [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }];
    const harness = await continuationHarness({
      root,
      fetch: textRoundFetch(requests),
      requestContext,
      tools,
      accept: (inner) => async (envelope) => {
        if (envelope.fact.kind === 'content') {
          acceptEntered.resolve();
          await releaseAccept.promise;
        }
        return inner(envelope);
      },
    });
    await harness.instance.start({ runtimeId, taskId, executionEpoch });
    await harness.instance.submit({
      taskId,
      executionEpoch,
      assignmentId: 'assignment-cont',
      payload: { prompt: 'first question' },
    });

    // The first request is not fully observed yet, so the turn is not continuable.
    await assert.rejects(
      () => harness.instance.continueCurrentTurn({ instructions: { text: 'CALLER_CONTINUE' } }),
      (error) => error instanceof ProviderAdapterError && error.providerError.code === 'continuation.not.quiescent',
    );
    assert.equal(requests.length, 1, 'a not-quiescent continuation still dispatched');

    // Hold the first request's raw content acceptance; continuation must stay
    // closed until the whole request (including durable acceptance) settles.
    const iterator = harness.instance.observe({ runtimeId })[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.kind, 'provider.model');
    const pendingOutput = iterator.next();
    await acceptEntered.promise;
    await assert.rejects(
      () => harness.instance.continueCurrentTurn({ instructions: { text: 'CALLER_CONTINUE' } }),
      (error) => error instanceof ProviderAdapterError && error.providerError.code === 'continuation.not.quiescent',
    );
    assert.equal(requests.length, 1, 'a held raw acceptance still allowed a second dispatch');
    releaseAccept.resolve();
    assert.equal((await pendingOutput).value?.kind, 'provider.output');
    let step = await iterator.next();
    while (!step.done) step = await iterator.next();

    // Two concurrent continuations: exactly one is admitted.
    const settled = await Promise.allSettled([
      harness.instance.continueCurrentTurn({ instructions: { text: 'CALLER_CONTINUE' } }),
      harness.instance.continueCurrentTurn({ instructions: { text: 'CALLER_CONTINUE_2' } }),
    ]);
    assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1);
    const overlap = settled.find((entry) => entry.status === 'rejected');
    assert.ok(overlap !== undefined && overlap.status === 'rejected');
    assert.ok(overlap.reason instanceof ProviderAdapterError);
    assert.equal(overlap.reason.providerError.code, 'continuation.overlap');
    assert.equal(requests.length, 2, 'the second request was not dispatched exactly once');

    // Observe the second request fully.
    for await (const _event of harness.instance.observe({ runtimeId })) { /* fully observe request 2 */ }

    assert.deepEqual(hookPhases, ['initial', 'continuation']);
    const records = harness.context.requests();
    const dispatches = records.filter((record) => record.phase === 'dispatching');
    assert.equal(dispatches.length, 2);
    const firstRequest = dispatches[0]!;
    const secondRequest = dispatches[1]!;
    assert.equal(firstRequest.request.parentRequestId, undefined);
    assert.equal(secondRequest.request.parentRequestId, firstRequest.request.requestId);
    assert.equal(secondRequest.request.turnId, firstRequest.request.turnId);
    assert.notEqual(secondRequest.request.requestId, firstRequest.request.requestId);
    const settledIds = records.filter((record) => record.phase === 'settled').map((record) => record.request.requestId);
    assert.deepEqual(
      new Set(settledIds),
      new Set([firstRequest.request.requestId, secondRequest.request.requestId]),
      'both request terminals must be committed even without an optional lifecycle callback',
    );

    // The first request is dispatched through the Provider start entry; the
    // continuation is the only Provider submit on this execution.
    assert.equal(harness.starts.length, 1);
    assert.equal(harness.submissions.length, 1);
    assert.deepEqual(harness.starts[0]?.requestContext?.units, [
      { kind: 'message', role: 'user', text: 'first question' },
    ]);
    assert.equal(harness.starts[0]?.instructions, undefined);
    assert.deepEqual(harness.submissions[0]?.requestContext?.units, [
      { kind: 'message', role: 'user', text: 'first question' },
      { kind: 'message', role: 'assistant', text: 'answer 1' },
      { kind: 'message', role: 'user', text: 'canonical follow-up' },
    ]);
    assert.equal(harness.submissions[0]?.instructions?.text, 'HOOK_ORIENTATION\nCALLER_CONTINUE');
    assert.equal(harness.submissions[0]?.toolContinuations, undefined);
    assert.deepEqual(harness.submissions[0]?.payload, { prompt: 'first question' });
    assert.deepEqual(harness.submissions[0]?.tools, tools);
    assert.deepEqual(harness.submissions[0]?.evidenceRefs, [{
      evidenceId: id('evidence', `operation-scope-${operationId.value}`),
      kind: 'operation',
      source: 'humanagent.provider-agent-driver',
      locator: `operation/${operationId.value}/scope`,
      scope,
    }]);
    // Transient instructions never enter canonical context.
    const canonicalJson = JSON.stringify(harness.submissions[0]?.requestContext);
    assert.equal(canonicalJson.includes('CALLER_CONTINUE'), false);
    assert.equal(canonicalJson.includes('HOOK_ORIENTATION'), false);
    // The driver did not mutate the hook's returned materialization.
    assert.deepEqual(returned[1]?.canonical.units, [
      { kind: 'message', role: 'user', text: 'first question' },
      { kind: 'message', role: 'assistant', text: 'answer 1' },
      { kind: 'message', role: 'user', text: 'canonical follow-up' },
    ]);
    assert.equal(returned[1]?.instructions?.text, 'HOOK_ORIENTATION');
    // No request terminal released the Provider execution.
    assert.equal(harness.settleCalls(), 0);
    const closure = await harness.instance.settle({ runtimeId, executionEpoch });
    assert.equal(closure.state, 'succeeded');
    assert.equal(harness.settleCalls(), 1);
    await harness.instance.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('continueCurrentTurn refuses an unknown terminal and never dispatches when production closes during the awaited continuation registration', async () => {
  const root = await fixtureRoot('humanagent-provider-cont-stop-');
  try {
    const requests: unknown[] = [];
    const registrationEntered = deferred<void>();
    const releaseRegistration = deferred<void>();
    const requestContext: ProviderRequestContextHook = async (hookInput) => ({
      canonical: { units: [{ kind: 'message', role: 'user', text: hookInput.phase }] },
    });
    const unknownRequests: unknown[] = [];
    const unknown = await continuationHarness({
      root,
      protocol: 'anthropic',
      requestContext,
      fetch: async (url, init) => {
        unknownRequests.push({ url, init });
        return sseResponse([
          { type: 'message_start', message: { id: 'message-unknown', model: 'model-cont', role: 'assistant' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial answer' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'unrecognized_stop' } },
          { type: 'message_stop' },
        ]);
      },
    });
    await unknown.instance.start({ runtimeId, taskId, executionEpoch });
    await unknown.instance.submit({ taskId, executionEpoch, assignmentId: 'assignment-cont', payload: { prompt: 'first question' } });
    const unknownEvents: ProviderAgentEvent[] = [];
    for await (const event of unknown.instance.observe({ runtimeId })) unknownEvents.push(event);
    assert.equal(unknownEvents.some((event) => event.providerEvent.kind === 'error'), false, 'the counterexample must not rely on an error event');
    assert.ok(unknownEvents.some((event) => event.providerEvent.terminalState === 'unknown'));
    assert.ok(unknown.context.entries().some((entry) => 'envelope' in entry
      && entry.envelope.fact.kind === 'request-complete' && entry.envelope.fact.terminal === 'failed'),
    'the real codec failure fact must remain durably accepted');
    await assert.rejects(
      unknown.instance.continueCurrentTurn({ instructions: { text: 'MUST_NOT_DISPATCH' } }).finally(() => {
        console.log(JSON.stringify({
          counterexample: 'anthropic-unknown-terminal-without-error',
          terminals: unknownEvents.flatMap((event) => event.providerEvent.terminalState === undefined ? [] : [event.providerEvent.terminalState]),
          errors: unknownEvents.filter((event) => event.providerEvent.kind === 'error').length,
          dispatchCount: unknownRequests.length,
          requestPhases: unknown.context.requests().map((record) => record.phase),
        }));
      }),
      (error) => error instanceof ProviderAdapterError && error.providerError.code === 'continuation.not.quiescent',
    );
    assert.equal(unknownRequests.length, 1, 'an unknown terminal allowed an extra dispatch');
    assert.equal(unknown.context.requests().some((record) => record.phase === 'settled'), false, 'an unknown terminal was recorded as normal completion');
    assert.equal(unknown.settleCalls(), 0);
    await unknown.instance.settle({ runtimeId, executionEpoch });
    await unknown.instance.close();

    const harness = await continuationHarness({
      root,
      fetch: textRoundFetch(requests),
      requestContext,
      beforeRegister: async (registration) => {
        if (registration.record.phase === 'dispatching' && registration.record.parentRequestId !== undefined) {
          registrationEntered.resolve();
          await releaseRegistration.promise;
        }
      },
    });
    await harness.instance.start({ runtimeId, taskId, executionEpoch });
    await harness.instance.submit({
      taskId,
      executionEpoch,
      assignmentId: 'assignment-cont',
      payload: { prompt: 'first question' },
    });
    for await (const _event of harness.instance.observe({ runtimeId })) { /* fully observe request 1 */ }
    assert.equal(requests.length, 1);

    const pending = harness.instance.continueCurrentTurn({ instructions: { text: 'CALLER_CONTINUE' } });
    await registrationEntered.promise;
    assert.equal(requests.length, 1, 'the continuation dispatched before its registration resolved');

    let drained = false;
    const pendingDrain = harness.instance.closeProductionAndDrain({
      execution: { runtimeId, executionEpoch },
      boundaryId: 'boundary-cont',
    }).then((result) => {
      drained = true;
      return result;
    });
    await flushMicrotasks();
    assert.equal(drained, false, 'drain resolved while the continuation registration was still held');
    releaseRegistration.resolve();
    await assert.rejects(
      pending,
      (error) => error instanceof ProviderAdapterError && error.providerError.code === 'provider.production.closed',
    );
    const result = await pendingDrain;
    assert.equal(result.boundaryId, 'boundary-cont');
    assert.equal(requests.length, 1, 'a closed production still dispatched the continuation');
    assert.equal(harness.starts.length, 1, 'the first request still dispatched');
    assert.equal(harness.submissions.length, 0, 'the continuation never reached the Provider submit');

    await harness.instance.settle({ runtimeId, executionEpoch });
    await harness.instance.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
