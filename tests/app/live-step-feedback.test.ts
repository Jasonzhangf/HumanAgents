import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type Checkpoint,
  type EvidenceRef,
  type InteractionParentProviderExecutionIdentityRef,
  type ProviderBinding,
  type ScopeRef,
  type TaskId,
  type TasklessProviderExecutionIdentityRef,
} from '../../packages/contracts/src/index.js';
import {
  filesystemProviderEvidenceSink,
  ProviderAdapter,
  ProviderAgentDriver,
  ResponsesProviderCodec,
  V3ProviderHttpTransport,
} from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { createProviderExplicitBrainInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import {
  buildFakeExecutionPort,
  FakeReplayExecutionRuntimePort,
  FileCheckpointStore,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { createUiRuntimeRequestDispatcher } from '../../packages/app/src/ui-runtime/server.js';
import { createServiceExecutionAdmission } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { ServiceExecutionCheckpointStore } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { createPreparedOperationBoundary } from '../../packages/app/src/prepared-operation-boundary.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { TASK_EXECUTION_ACTION_ID, TASK_EXECUTION_CAPABILITY } from '../../packages/app/src/ui-runtime/task-control.js';
import {
  MemoryCoordinator,
  type AttentionPort,
} from '../../packages/runtime/src/index.js';
import type { RuntimeBindingSnapshot } from '../../packages/runtime/src/admission/admitted-turn.js';
import type {
  ExecutionAgentPort,
  MergeCoordinatorPort,
  ReviewAgentPort,
} from '../../packages/runtime/src/orchestration/index.js';
import {
  AgentRuntimePoolManager,
  OrchestrationManager,
} from '../../packages/runtime/src/orchestration/index.js';
import { FileActiveTurnJournal } from '../../packages/app/src/ui-runtime/journal.js';

const organId = id('organ', 'w2-live-step-organ');
const binding: ProviderBinding = {
  bindingId: 'w2-live-step-binding',
  providerId: 'w2-live-step-provider',
  protocol: 'responses',
  endpointRef: 'http://recorded.test',
  modelRef: 'w2-live-step-model',
  configDigest: 'sha256:w2-live-step-config',
  capabilityDigest: 'sha256:w2-live-step-capability',
};

class RecordedParentPort<T extends InteractionParentProviderExecutionIdentityRef | TasklessProviderExecutionIdentityRef = InteractionParentProviderExecutionIdentityRef> extends ProviderAdapter<T> {
  constructor(options: {
    readonly binding: ProviderBinding;
    readonly stepDelayMs: number;
    readonly replay: readonly { readonly kind: string; readonly summary: string; readonly state: string; readonly terminalState?: string }[];
    readonly respond?: (wire: any) => Promise<readonly unknown[]>;
    readonly evidence?: ReturnType<typeof filesystemProviderEvidenceSink>;
  }) {
    const evidence = options.evidence ?? filesystemProviderEvidenceSink(new ImmutableAssetStore(join(tmpdir(), `w2-live-${Math.random().toString(36).slice(2)}`)));
    const transport = new V3ProviderHttpTransport<T>({
      binding: options.binding,
      baseUrl: 'http://recorded.test',
      source: 'http',
      evidence,
      fetch: async (_url, init) => ({
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: (async function* () {
          const encoder = new TextEncoder();
          const frame = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
          const wire = JSON.parse(init.body!);
          const frames = [
            { type: 'response.created', response: { id: 'recorded' } },
            ...(options.respond ? await options.respond(wire) : options.replay.filter((step) => step.kind === 'output').map((step, index) => ({
              type: 'response.output_text.done',
              item_id: `text-${index}`,
              text: step.summary,
            }))),
            { type: 'response.completed', response: { id: 'recorded' } },
          ];
          yield encoder.encode(frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''));
        })(),
        text: async () => '',
      }),
    });
    super({ binding: options.binding, routeRef: 'recorded', codec: new ResponsesProviderCodec(), transport, evidence });
  }
}

interface ExplicitDependencies {
  readonly journal: JsonlOrganJournal;
  readonly parentJournal: JsonlInteractionParentTurnJournal;
  readonly helperJournal: JsonlInteractionHelperJournal;
  readonly rawEvidence: ReturnType<typeof filesystemProviderEvidenceSink>;
  readonly rawContent: ReturnType<typeof providerRawContentReader>;
}

async function explicitDependencies(root: string): Promise<ExplicitDependencies> {
  const journal = new JsonlOrganJournal(join(root, 'explicit-control.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const rawEvidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  return {
    journal,
    parentJournal,
    helperJournal,
    rawEvidence,
    rawContent: providerRawContentReader(rawEvidence),
  };
}

function attentionPort(): AttentionPort & { readonly published: unknown[]; readonly resolved: unknown[] } {
  const published: unknown[] = [];
  const resolved: unknown[] = [];
  return {
    published,
    resolved,
    async publish(input) {
      published.push(structuredClone(input));
      return { attentionId: input.attentionId, delivered: true };
    },
    async resolve(input) {
      resolved.push(structuredClone(input));
      return { attentionId: input.attentionId, delivered: true };
    },
  };
}

function testMemory(projectKey: string) {
  return {
    coordinator: new MemoryCoordinator(),
    backend: new DeterministicMemoryBackend(),
    projectKey,
    roleId: 'execution',
  };
}

async function waitFor(predicate: () => void | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (predicate() !== false) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (last instanceof Error) throw last;
  throw new Error('timed out waiting for live step feedback');
}

function sseFrames(text: string): readonly { readonly event: string; readonly data: string }[] {
  return text.split('\n\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const event = frame.split('\n').find((line) => line.startsWith('event: '))?.slice('event: '.length);
      const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice('data: '.length);
      if (event === undefined) throw new Error(`SSE frame has no event: ${frame}`);
      if (data === undefined) throw new Error(`SSE frame has no data: ${frame}`);
      return { event, data };
    });
}

function fakeResponse() {
  const chunks: Buffer[] = [];
  const closeListeners: Array<() => void> = [];
  const response = {
    status: 0,
    headers: undefined as Record<string, string> | undefined,
    writableEnded: false,
    setHeader(name: string, value: string) {
      this.headers = { ...(this.headers ?? {}), [name]: value };
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk: unknown) {
      chunks.push(Buffer.from(chunk as Uint8Array));
      return true;
    },
    end(chunk?: unknown, callback?: unknown) {
      const done = typeof chunk === 'function' ? chunk : typeof callback === 'function' ? callback : undefined;
      if (chunk !== undefined && typeof chunk !== 'function') chunks.push(Buffer.from(chunk as Uint8Array));
      this.writableEnded = true;
      if (done !== undefined) (done as () => void)();
    },
    once(event: string, listener: () => void) {
      if (event === 'close') closeListeners.push(listener);
    },
    emitClose() {
      for (const listener of closeListeners) listener();
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
  return response;
}

function dispatch(
  listener: (request: IncomingMessage, response: ServerResponse) => void,
  { method = 'GET', url, headers = {}, body }: {
    readonly method?: string;
    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
  },
): ReturnType<typeof fakeResponse> {
  const request = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  } as unknown as IncomingMessage;
  const response = fakeResponse();
  listener(request, response as unknown as ServerResponse);
  return response;
}

test('explicit interaction events stream dispatch, return, and acceptance in lifecycle order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-w2-explicit-'));
  try {
    const deps = await explicitDependencies(root);
    const childBinding = { ...binding, bindingId: 'w2-live-child-binding', modelRef: 'w2-live-child-model' };
    const finalAnswer = `w2 final ${'answer body '.repeat(40)}`;
    const parent = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], evidence: deps.rawEvidence, respond: async (wire) => {
      const results = wire.input.filter((item: any) => item.type === 'function_call_output');
      if (results.length === 0) {
        return [{
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            type: 'function_call',
            call_id: 'dispatch',
            name: 'dispatch_helper',
            arguments: JSON.stringify({
              selection: { roleId: 'review', configuredAgentId: 'w2-child' },
              assignmentFields: {
                objective: 'verify helper steps', targetRefs: [], expectedOutputRefs: [],
                successCriteria: ['bounded result'], failureCriteria: ['none'],
                incompleteCriteria: ['partial'], requiredCapabilities: [], mergeGate: 'not-required',
              },
              inputs: { question: 'child-only' }, evidenceRefs: [],
            }),
          },
        }];
      }
      if (results.length === 1) {
        const dispatched = JSON.parse(String(results[0].output).split('\n[HumanAgent evidence refs]')[0]!) as { readonly identity: { readonly helperCallId: string } };
        return [{
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: 'accept',
            name: 'accept_helper',
            arguments: JSON.stringify({
              helperCallId: dispatched.identity.helperCallId,
              refinedText: 'accepted child result',
              acceptanceRef: 'acceptance:w2-explicit',
              evidenceRefs: [],
            }),
          },
        }];
      }
      return [{
        type: 'response.output_text.done',
        item_id: 'final',
        text: JSON.stringify({ kind: 'answer', normalizedInput: 'w2 input', knownFacts: [], answer: finalAnswer, decisionRefs: [] }),
      }];
    } });
    const interpreter = createProviderExplicitBrainInterpreter({
      organId,
      interactionScopeId: 'runtime:w2-explicit',
      binding,
      parentJournal: deps.parentJournal,
      checkpointJournal: deps.helperJournal,
      helperJournal: deps.helperJournal,
      turnHelperJournal: deps.helperJournal,
      rawEvidence: deps.rawEvidence,
      rawContent: deps.rawContent,
      clock: { now: () => new Date().toISOString() },
      templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      port: parent,
      helperFactory: async ({ selection, assignment, execution }) => {
        assert.equal(selection.roleId, 'review');
        const child = new RecordedParentPort<TasklessProviderExecutionIdentityRef>({
          binding: childBinding, stepDelayMs: 0, replay: [], evidence: deps.rawEvidence,
          respond: async (wire) => {
            assert.ok(JSON.stringify(wire).includes('child-only'));
            return [{
              type: 'response.output_text.done',
              item_id: 'child',
              text: JSON.stringify({
                agentId: 'w2-child', producedArtifactRefs: [], producedArtifactDigests: [],
                status: 'incomplete', summary: 'child summary', outputRefs: [],
                evidenceRefs: [], nextAction: 'wait', conditionRef: 'condition:partial',
              }),
            }];
          },
        });
        return {
          binding: childBinding,
          driver: new ProviderAgentDriver<TasklessProviderExecutionIdentityRef>({
            port: child,
            binding: childBinding,
            ...execution,
            organId: assignment.organId,
            helper: assignment,
            assignmentId: assignment.assignmentId,
            scope: { organId: assignment.organId, operationId: execution.operationId },
            inputRefs: [],
          }),
          close: async () => { await child.close(childBinding); },
        };
      },
    });

    const journal = new UiRuntimeJournal(join(root, 'ui-runtime.jsonl'));
    const checkpointStoreFor = () => new FileCheckpointStore(join(root, 'checkpoint.jsonl'));
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port: buildFakeExecutionPort(binding),
      checkpointStoreFor,
      attentionPort: attentionPort(),
      providerState: 'ready',
      journal,
      closurePort: journal,
      memory: testMemory('w2-explicit'),
      explicitBrainInterpreter: interpreter,
    });
    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'credential.json'), create: true });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const { listener } = createUiRuntimeRequestDispatcher({
      service,
      accessControl,
      productRoot: root,
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      isClosing: () => false,
    });

    const created = dispatch(listener, {
      method: 'POST',
      url: '/api/explicit/inputs',
      headers: { cookie, 'content-type': 'application/json' },
      body: { channel: 'business', sourceRef: 'ui:w2-post-probe', rawInput: 'post probe' },
    });
    await waitFor(() => created.writableEnded);
    const createdBody = JSON.parse(created.text()) as { readonly interactionId: string; readonly occurredAt: string };
    assert.ok(createdBody.interactionId);
    assert.ok(!Number.isNaN(Date.parse(createdBody.occurredAt)), `occurredAt must be a real timestamp: ${createdBody.occurredAt}`);

    const interactionId = await service.receiveExplicitInput({
      sourceRef: 'ui:w2-explicit', rawInput: 'dispatch one helper', channel: 'business',
    });
    const liveSteps: string[] = [];
    const live = await service.subscribeExplicitSteps(interactionId, (step) => liveSteps.push(step.kind));

    const interpreted = await service.interpretExplicitInput({ interactionId });
    assert.equal(interpreted.state, 'answered');
    live.unsubscribe();
    assert.ok(liveSteps.includes('helper.dispatched'), `live listener missed helper.dispatched: ${liveSteps.join(',')}`);
    assert.ok(liveSteps.includes('turn.completed'), `live listener missed turn.completed: ${liveSteps.join(',')}`);

    const sse = dispatch(listener, {
      url: `/api/explicit/interactions/${encodeURIComponent(interactionId)}/events`,
      headers: { cookie },
    });
    await waitFor(() => sse.text().includes('"kind":"turn.completed"'));
    sse.emitClose();

    const frames = sseFrames(sse.text()).filter((frame) => frame.event === 'explicit.step');
    const kinds = frames.map((frame) => (JSON.parse(frame.data) as { kind: string }).kind);
    const ordered = kinds.join(',');
    const firstDispatched = ordered.indexOf('request.dispatched');
    const secondDispatched = ordered.lastIndexOf('request.dispatched');
    assert.ok(firstDispatched >= 0, `missing first request.dispatched: ${ordered}`);
    assert.ok(secondDispatched > firstDispatched, `expected two dispatched steps: ${ordered}`);
    assert.ok(ordered.includes('helper.dispatched'), `missing helper.dispatched: ${ordered}`);
    assert.ok(ordered.includes('helper.response'), `missing helper.response: ${ordered}`);
    assert.ok(ordered.includes('helper.accepted'), `missing helper.accepted: ${ordered}`);
    assert.ok(ordered.indexOf('helper.accepted') > ordered.indexOf('helper.response'), 'acceptance must follow the helper response');
    assert.ok(ordered.includes('request.dispatching'), `missing request.dispatching: ${ordered}`);
    assert.ok(ordered.includes('request.settled'), `missing request.settled: ${ordered}`);
    assert.ok(ordered.includes('response.reasoning'), `missing response.reasoning: ${ordered}`);
    assert.ok(ordered.includes('response.streaming'), `missing response.streaming: ${ordered}`);
    assert.ok(ordered.includes('turn.completed'), `missing turn.completed: ${ordered}`);
    assert.ok(ordered.indexOf('helper.dispatched') > firstDispatched, 'helper must dispatch after the first request');
    assert.ok(ordered.indexOf('helper.response') > ordered.indexOf('helper.dispatched'), 'helper response must follow dispatch');
    assert.ok(ordered.indexOf('helper.response') < secondDispatched, 'helper return must precede the second request');
    assert.ok(ordered.indexOf('turn.completed') > secondDispatched, 'turn must complete after the final request');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const fixtureControlOwner = 'w2-live-step-control';
const permissionSnapshot: RuntimeBindingSnapshot = {
  runtimeId: 'w2-live-step-runtime',
  executionEpoch: 1,
  ownerRef: 'w2-live-step-test',
  permissionRevision: 'perm-w2',
};

function fixtureExecutionAdmission(root: string) {
  const preparedJournal = new UiRuntimeJournal(join(root, 'prepared.jsonl'));
  const admission = createServiceExecutionAdmission({
    journal: new JsonlOrganJournal(join(root, 'task-control.jsonl')),
    preparedJournal,
    principalOwner: fixtureControlOwner,
    resourceBoundary: createPreparedOperationBoundary(preparedJournal),
    now: () => new Date(),
  });
  return { preparedJournal, admission };
}

function nativeCaptureOptions(root: string) {
  const sink = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'native-assets')));
  return {
    initialInputStore: {
      async store(input: { readonly binding: import('../../packages/contracts/src/index.js').ActiveTurnBinding; readonly bytes: Uint8Array }) {
        return {
          ref: await sink.write({ scope: input.binding.scope, kind: 'execution', type: 'initial-input', locator: input.binding.admittedTurn.turnId, content: new TextDecoder().decode(input.bytes) }),
          view: { kind: 'utf8-text' as const },
        };
      },
    },
    async recoveryReferencesFor(active: import('../../packages/contracts/src/index.js').ActiveTurnBinding) {
      return {
        completionLookups: [],
        recovery: { commitIdentity: `capture-${active.admittedTurn.turnId}`, rawTurnRefs: [], laterErrorRefs: [], unresolvedOperationRefs: [], stages: [], durablePhases: [], durableReceiptRefs: [], recoveryResponsibilityRef: active.admittedTurn.recoveryStateRef },
      };
    },
  };
}

function workEvidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `w2-${label}`),
    kind: 'operation',
    source: 'w2-live-step-test',
    locator: `test://${label}`,
    scope,
  };
}

class MemoryRefinedDeliveryStore {
  private readonly byDigest = new Map<string, Uint8Array>();

  async store(input: { readonly scope: ScopeRef; readonly invocationId: string; readonly bytes: Uint8Array }) {
    const digest = `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`;
    this.byDigest.set(digest, input.bytes);
    return {
      ref: {
        evidenceId: id('evidence', `delivery-${input.invocationId.replace(/[^A-Za-z0-9._-]/g, '-')}`),
        kind: 'operation' as const,
        source: 'w2-live-step-test',
        locator: `delivery://${input.invocationId}`,
        digest,
        scope: input.scope,
      },
      view: { kind: 'utf8-text' as const },
    };
  }
  async read(asset: { readonly ref: { readonly digest?: string } }): Promise<Uint8Array> {
    const bytes = asset.ref.digest === undefined ? undefined : this.byDigest.get(asset.ref.digest);
    if (bytes === undefined) throw new Error(`missing refined delivery ${asset.ref.digest ?? 'unknown'}`);
    return bytes;
  }
}

async function waitIdle(service: UiRuntimeService, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quietSince: number | undefined;
  while (Date.now() < deadline) {
    const list = service.listTasks();
    const busy = list.running.length + list.waiting.filter((row) => row.state === 'settling').length;
    if (busy === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 300) return;
    } else {
      quietSince = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for task execution to settle');
}

function runtimePool(): AgentRuntimePoolManager {
  return new AgentRuntimePoolManager({
    maxRuntimes: 4,
    factory: {
      async start(request) {
        return { runtimeId: request.runtimeId, generation: request.generation, capabilities: [...request.requiredCapabilities] };
      },
      async dispose() {},
    },
    ownerId: 'w2-live-step-test',
    initialRuntimes: [{ runtimeId: 'w2-live-step-runtime', generation: 1, capabilities: ['code.search', 'file.checkpoint', 'provider.execution'] }],
  });
}

function passingReviewAgent(): ReviewAgentPort {
  const review = async (input: Parameters<ReviewAgentPort['review']>[0]) => ({
    resultId: `review-${input.reviewAssignment.assignmentId}`,
    assignmentId: input.reviewAssignment.assignmentId,
    taskId: input.reviewAssignment.taskId,
    workerAgentId: input.reviewAssignment.workerAgentId,
    reviewKind: input.reviewAssignment.reviewKind,
    attempt: input.reviewAssignment.attempt,
    executionEpoch: input.reviewAssignment.executionEpoch,
    inputRevision: input.reviewAssignment.inputRevision,
    subjectRefs: [...input.reviewAssignment.subjectRefs],
    status: 'passed' as const,
    findings: [],
    evidenceRefs: [workEvidence('review', input.scope)],
  });
  return {
    roleId: 'w2-live-step-review',
    createInstance(create) {
      return {
        incarnation: create.incarnation,
        async review(input) {
          const result = await review(input);
          return {
            result,
            output: { text: `review ${input.reviewAssignment.assignmentId}`, artifactRef: null, artifactDigest: null },
            completedAt: new Date().toISOString(),
          };
        },
        async dispose() {},
      };
    },
    async review(input) {
      return review(input);
    },
  };
}

const mergeCoordinator: MergeCoordinatorPort = {
  async merge(request) {
    return {
      status: 'merged',
      evidenceRefs: [
        ...request.workerResult.evidenceRefs,
        ...request.reviewResults.flatMap((review) => review.evidenceRefs),
        workEvidence('merge', request.scope),
      ],
    };
  },
};

async function confirmRequirement(service: UiRuntimeService, suffix: string): Promise<void> {
  const interactionId = await service.receiveExplicitInput({
    sourceRef: `ui:${suffix}`, rawInput: `confirmed requirement ${suffix}`, channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, { normalizedInput: `confirmed ${suffix}`, matchedTasks: [], knownFacts: [] });
  await service.proposeExplicitRequirement(interactionId, { proposedIntent: 'create', proposal: `create ${suffix}` });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${suffix}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-12T00:00:00.000Z',
    payloadRef: `asset://requirements/${suffix}`,
  });
}

test('task events stream keeps live feedback when subscribed before the operation exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-w2-task-early-'));
  try {
    const journal = new UiRuntimeJournal(join(root, 'ui-runtime.jsonl'));
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
      checkpointStoreFor: (taskId: TaskId, cycleId: { value: string }) => new FileCheckpointStore(
        join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`),
      ),
      attentionPort: attentionPort(),
      providerState: 'ready',
      journal,
      closurePort: journal,
      memory: testMemory('w2-task-early'),
      explicitBrainInterpreter: { interpret: async () => { throw new Error('explicit brain is not configured for early task events'); } },
      runtimeComposition: { admitExecution: async () => {} },
    });
    const task = service.createTask({ title: 'early task events', directive: 'subscribe before the operation exists' });

    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'credential.json'), create: true });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const { listener } = createUiRuntimeRequestDispatcher({
      service,
      accessControl,
      productRoot: root,
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      isClosing: () => false,
    });

    // Subscribe while the task has no operation yet. The old task binding
    // returned an empty replay and dropped this listener, so the first
    // operation allocation lost every live step.
    const sse = dispatch(listener, { url: `/api/tasks/${encodeURIComponent(task.taskId.value)}/events`, headers: { cookie } });
    await waitFor(() => sse.status === 200);
    assert.equal(sse.text(), '');

    const started = await service.startExecution(task.taskId, { prompt: 'stream from the first step' });
    await waitFor(() => sse.writableEnded, 8000);

    const events = sseFrames(sse.text()).map((frame) => JSON.parse(frame.data) as { readonly kind: string; readonly state: string });
    assert.deepEqual(events.map((event) => event.kind), [
      'execution.started',
      'provider.model',
      'provider.model',
      'provider.model',
      'provider.output',
      'provider.tool',
      'provider.output',
      'execution.terminal',
      'provider.model',
      'execution.settling',
      'checkpoint.committed',
      'execution.terminal',
    ]);
    const states = events.filter((event) => event.kind === 'provider.model').map((event) => event.state);
    for (const expected of ['dispatching', 'dispatched', 'settled']) {
      assert.ok(states.includes(expected), `missing provider ${expected}: ${states.join(',')}`);
    }
    assert.equal(service.taskDashboard(task.taskId).operationId, started.operationId.value);
    assert.equal(service.taskDashboard(task.taskId).state, 'succeeded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task events stream stays open across an advancing final and the next operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-w2-task-cross-turn-'));
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let secondEntered!: () => void;
  const secondPreparing = new Promise<void>((resolve) => { secondEntered = resolve; });
  const checkpointStores = new Map<string, ServiceExecutionCheckpointStore>();
  const checkpointStoreFor = (taskId: TaskId, cycleId: { value: string }) => {
    const filePath = join(root, `${taskId.value}-${cycleId.value}.jsonl`);
    let store = checkpointStores.get(filePath);
    if (store === undefined) {
      store = new ServiceExecutionCheckpointStore(filePath, new JsonlOrganJournal(filePath), () => new Date());
      checkpointStores.set(filePath, store);
    }
    return store;
  };
  const phases = new Map<string, 'open' | 'aligned'>();
  const turnCounts = new Map<string, number>();
  const allocations: Array<{
    readonly operationId: { readonly value: string };
    readonly taskId: { readonly value: string };
  }> = [];
  let service: UiRuntimeService | undefined;
  let task: ReturnType<UiRuntimeService['createTask']> | undefined;
  let sse: ReturnType<typeof fakeResponse> | undefined;
  try {
    service = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port: new FakeReplayExecutionRuntimePort({ binding }),
      checkpointStoreFor,
      attentionPort: attentionPort(),
      providerState: 'ready',
      journal: new UiRuntimeJournal(join(root, 'ui-runtime.jsonl')),
      closurePort: new UiRuntimeJournal(join(root, 'closure.jsonl')),
      memory: testMemory('w2-task-cross-turn'),
      explicitBrainInterpreter: { interpret: async () => { throw new Error('explicit brain is not configured for cross-turn task events'); } },
      runtimeComposition: {
        createExecutionPorts: () => ({
          admitExecution: async () => {},
          currentStatePort: createJsonlRuntimeTaskCurrentStateJournal({
            journal: new JsonlOrganJournal(join(root, 'current-state.jsonl')),
          }),
          currentStateFacts: {
            async read({ taskId }) {
              return { state: 'known', value: {
                turn: {
                  phase: phases.get(taskId.value) ?? 'open',
                  ownerRef: `fixture:${taskId.value}`,
                  nextAction: { kind: 'continue' },
                  laterErrorRefs: [],
                  unresolvedOperationRefs: [],
                },
                stages: { state: 'known', stages: [] },
              } };
            },
          },
          createDriver: async (allocation) => {
            const turn = (turnCounts.get(allocation.taskId.value) ?? 0) + 1;
            turnCounts.set(allocation.taskId.value, turn);
            allocations.push(allocation);
            if (turn === 2) {
              secondEntered();
              await secondGate;
            }
            const { scope, taskId, executionEpoch, runtimeId, assignmentId } = allocation;
            phases.set(taskId.value, 'open');
            const refs = [workEvidence(`cross-turn-${allocations.length}`, scope)];
            const identity = {
              turnId: `turn-${executionEpoch}`,
              workAssignmentRef: assignmentId,
              taskRef: taskId,
              scopeRef: scope,
              cycleRef: scope.cycleId!,
              inputRevision: 1,
              directiveRevision: 1,
              executionEpoch,
              runtimeBindingRef: runtimeId,
              permissionRevision: '1',
            };
            const checkpoint: Checkpoint = {
              id: id('checkpoint', `cross-turn-${allocations.length}`),
              scope,
              cycleId: scope.cycleId!,
              seq: 1,
              previousCheckpointId: null,
              directiveRevision: 1,
              executionEpoch,
              outcome: 'succeeded',
              summary: 'turn closed',
              recoveryStateRef: refs[0]!,
              evidenceRefs: refs,
              next: { kind: 'continue' },
            };
            const summary = {
              goal: { text: 'finish task', evidenceRefs: refs },
              actions: { text: 'execute turn', evidenceRefs: refs },
              result: { text: 'turn done', evidenceRefs: refs },
              expectedNextStep: { text: turn === 1 ? 'continue task' : 'complete task', evidenceRefs: refs },
            };
            const continues = turn === 1;
            const decision = continues ? 'continue' as const : 'complete' as const;
            const alignment = {
              identity,
              checkpointId: checkpoint.id,
              closureRef: 'closure:test',
              planRevisionId: `plan-${executionEpoch}`,
              planRevisionSequence: turn,
              planContentDigest: 'sha256:fixture' as const,
              decision,
              alignedAt: '2026-10-17T00:00:00.000Z',
            };
            return {
              kind: 'cross-turn-fixture',
              async capabilities() {
                return { driverKind: 'cross-turn-fixture', capabilities: [], version: '1' };
              },
              async start() {
                return { runtimeId, executionEpoch };
              },
              async resume() {
                return { runtimeId, executionEpoch };
              },
              async submit(input) {
                return { ...input, outputRefs: [], evidenceRefs: refs };
              },
              async *observe() {
                yield { taskId, executionEpoch, kind: 'terminal', terminalState: 'succeeded', evidenceRefs: refs };
              },
              async requestStop(input) {
                return { requested: true, operationId: input.operationId };
              },
              async settle() {
                return { state: 'succeeded', evidenceRefs: refs };
              },
              async close() {
                return { ...binding, state: 'closed', evidenceRefs: refs };
              },
              standardTurn: {
                async acceptReviews() {},
                async readCheckpoint() {
                  const relationship = await checkpointStoreFor(taskId, scope.cycleId!).commitNativeCheckpoint({
                    ownerId: 'humanagent.test-fixture',
                    checkpoint,
                    timeAuthority: {
                      source: 'harness',
                      owner: 'runtime-checkpoint-control-owner',
                      authorityRef: `fixture:${checkpoint.id.value}`,
                      sampleCommittedAt: async () => '2026-10-17T00:00:00.000Z',
                    },
                  });
                  return {
                    checkpoint,
                    previous: null,
                    commitRef: {
                      commitId: relationship.receipt.commitIdentity,
                      journalSeq: relationship.journalSeq,
                      recordDigest: relationship.recordDigest,
                    },
                  };
                },
                async align() {
                  phases.set(taskId.value, 'aligned');
                  return {
                    advanced: continues,
                    state: continues ? 'advancing' : 'terminal',
                    reason: 'aligned',
                    decision,
                    alignment,
                    admission: {
                      state: 'closed',
                      decision,
                      alignment,
                      closure: {
                        identity,
                        checkpointId: checkpoint.id,
                        closureRef: 'closure:test',
                        summary,
                        recoveryStateRef: refs[0]!,
                        closedAt: '2026-10-17T00:00:00.000Z',
                      },
                    },
                  };
                },
                async readDelivery() {
                  const bytes = new TextEncoder().encode('task complete');
                  const asset = { ref: refs[0]!, view: { kind: 'utf8-text' as const } };
                  return {
                    assignment: {
                      assignmentId,
                      taskId,
                      pipelineNodeId: 'pipeline.execute',
                      attempt: 1,
                      executionEpoch,
                      inputRevision: 1,
                      objective: 'finish task',
                      targetRefs: [],
                      expectedOutputRefs: [],
                      successCriteria: [],
                      failureCriteria: [],
                      incompleteCriteria: [],
                      requiredCapabilities: [],
                      mergeGate: 'not-required',
                    },
                    acceptedEnd: {
                      kind: 'standard-turn-end',
                      identity,
                      summary,
                      deliveryText: 'task complete',
                      deliveryRefs: [],
                      resolvedEvidenceRefs: [],
                    },
                    materials: [{
                      kind: 'delivery-text',
                      deliveryEvidence: refs[0]!,
                      rawArguments: asset,
                      bodyAsset: asset,
                      bytes,
                      digest: 'sha256:fixture',
                      sourceEvidence: refs,
                      acceptedEndCall: {
                        seq: 1,
                        envelope: {
                          execution: { runtimeId, taskId, executionEpoch },
                          scope,
                          request: { turnId: identity.turnId, requestId: 'request-end' },
                          producerSeq: 1,
                          fact: {
                            kind: 'tool-call',
                            contentUnitId: 'end',
                            call: {
                              callId: 'end',
                              toolId: 'humanagent.turn.end',
                              continuationRef: 'end-continuation',
                              arguments: {},
                            },
                            rawArguments: asset,
                            complete: true,
                          },
                        },
                      },
                    }],
                  };
                },
              },
            };
          },
        }),
      },
    });
    task = service.createTask({ title: 'cross-turn task events', directive: 'keep one task stream across the turn change' });

    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'credential.json'), create: true });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const { listener } = createUiRuntimeRequestDispatcher({
      service,
      accessControl,
      productRoot: root,
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      isClosing: () => false,
    });

    sse = dispatch(listener, { url: `/api/tasks/${encodeURIComponent(task.taskId.value)}/events`, headers: { cookie } });
    await waitFor(() => sse!.status === 200);
    assert.equal(sse.text(), '');

    const started = await service.startExecution(task.taskId, { prompt: 'run the first turn' });
    await secondPreparing;
    const firstFinalText = (): boolean => sseFrames(sse!.text()).some((frame) => {
      const event = JSON.parse(frame.data) as {
        readonly kind: string;
        readonly state: string;
        readonly operationId: string;
        readonly terminalPhase?: string;
      };
      return event.operationId === started.operationId.value
        && event.kind === 'execution.terminal'
        && event.terminalPhase === 'final'
        && event.state === 'waiting';
    });
    await waitFor(firstFinalText);
    assert.equal(service.taskDashboard(task.taskId).state, 'waiting');
    assert.equal(sse.writableEnded, false, 'the advancing final must not close the task stream');

    releaseSecond();
    await waitFor(() => sse!.writableEnded, 8000);
    await waitFor(() => service!.taskDashboard(task!.taskId).state === 'succeeded', 8000);

    const events = sseFrames(sse.text()).map((frame) => JSON.parse(frame.data) as {
      readonly kind: string;
      readonly state: string;
      readonly operationId: string;
      readonly terminalPhase?: string;
    });
    assert.equal(new Set(events.map((event) => event.operationId)).size, 2, 'one stream must carry both operations');
    const firstFinal = events.findIndex((event) => event.operationId === started.operationId.value
      && event.kind === 'execution.terminal' && event.terminalPhase === 'final');
    const secondOperation = allocations[1]!.operationId.value;
    const firstSecondOperationEvent = events.findIndex((event) => event.operationId === secondOperation);
    assert.ok(firstFinal >= 0, 'turn 1 must report its own final terminal');
    assert.ok(firstSecondOperationEvent > firstFinal, 'turn 2 events must follow the advancing final');
    const finals = events.filter((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final');
    assert.deepEqual(finals.map((event) => event.state), ['waiting', 'succeeded']);
    assert.equal(events.at(-1)?.kind, 'execution.terminal');
    assert.equal(events.at(-1)?.terminalPhase, 'final');
  } finally {
    releaseSecond();
    if (service !== undefined && task !== undefined) {
      try {
        await waitFor(() => {
          const state = service!.taskDashboard(task!.taskId).state;
          return state === 'succeeded' || state === 'failed' || state === 'cancelled';
        }, 8000);
      } catch {
        // Preserve the primary test failure; cleanup cannot invent task completion.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('task events stream reports provider request rounds and child lifecycle steps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-w2-task-'));
  try {
    const { preparedJournal, admission } = fixtureExecutionAdmission(root);
    const activeTurnJournal = new FileActiveTurnJournal(join(root, 'active-turn.jsonl'));
    const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
    let checkpointStore: FileCheckpointStore | undefined;
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port,
      checkpointStoreFor: (taskId: TaskId, cycleId: { value: string }) => {
        checkpointStore = new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`));
        return checkpointStore;
      },
      attentionPort: attentionPort(),
      providerState: 'ready',
      journal: preparedJournal,
      closurePort: new UiRuntimeJournal(join(root, 'closure.jsonl')),
      memory: testMemory('w2-task'),
      explicitBrainInterpreter: { interpret: async () => { throw new Error('explicit brain is not configured for task events'); } },
      activeTurnJournal,
      ...nativeCaptureOptions(root),
      permissionSnapshot,
      refinedDeliveryStore: new MemoryRefinedDeliveryStore(),
      runtimeComposition: {
        admitExecution: async (allocation) => {
          await admission.grants.grant({
            taskId: allocation.taskId,
            requestId: `fixture-task-execution:${allocation.taskId.value}`,
            expectedRevision: 0,
            owner: fixtureControlOwner,
            capability: {
              actionId: TASK_EXECUTION_ACTION_ID,
              capabilities: [TASK_EXECUTION_CAPABILITY],
              scope: { organId: allocation.scope.organId, taskId: allocation.taskId },
            },
          });
          await admission.admitExecution(allocation);
        },
        createTaskAssembly({ scope, checkpointJournal, executionAgent, maxAttempts, childCallPort }) {
          const pool = runtimePool();
          const orchestration = new OrchestrationManager({
            ownerId: 'w2-live-step-test',
            runtimePool: pool,
            executionAgent: executionAgent as ExecutionAgentPort,
            reviewAgent: passingReviewAgent(),
            mergeCoordinator,
            maxAttempts: maxAttempts ?? 1,
            ...(childCallPort === undefined ? {} : { childCallPort }),
          });
          return { orchestration, runtimePool: pool };
        },
      },
    });
    await confirmRequirement(service, 'task-events');
    try {
      await service.dispatchNextExplicitRequirement();
    } catch (error) {
      throw new Error(`${(error as Error).message}\njournal=${JSON.stringify(preparedJournal.replay().map((record) => record.kind))}`);
    }
    try {
      await waitFor(() => service.listTasks().completed[0]?.state === 'succeeded', 8000);
    } catch (error) {
      const list = service.listTasks();
      const issue = service.implicitSchedulingIssue();
      throw new Error(`${(error as Error).message}\nissue=${issue === undefined ? 'none' : JSON.stringify(issue)}\nlist=${JSON.stringify(list)}`);
    }
    const taskId = service.listTasks().completed[0]!.taskId;

    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'credential.json'), create: true });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const { listener } = createUiRuntimeRequestDispatcher({
      service,
      accessControl,
      productRoot: root,
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      isClosing: () => false,
    });
    const sse = dispatch(listener, { url: `/api/tasks/${encodeURIComponent(taskId.value)}/events`, headers: { cookie } });
    await waitFor(() => sse.writableEnded, 8000);

    const events = sseFrames(sse.text()).map((frame) => JSON.parse(frame.data) as { readonly kind: string; readonly state: string; readonly turnId?: string });
    const provider = events.filter((event) => event.kind === 'provider.model');
    const states = provider.map((event) => event.state);
    const firstDispatched = states.indexOf('dispatched');
    const firstSettled = states.indexOf('settled');
    assert.ok(firstDispatched >= 0, `missing provider dispatched: ${states.join(',')}`);
    assert.ok(firstSettled > firstDispatched, `provider must settle after dispatch: ${states.join(',')}`);
    assert.ok(states.includes('dispatching'), `missing provider dispatching: ${states.join(',')}`);
    for (const childState of ['child.prepared', 'child.returned', 'child.adopted', 'review.checkpointed']) {
      assert.ok(states.includes(childState), `missing ${childState}: ${states.join(',')}`);
    }
    const dispatchTurn = provider.find((event) => event.state === 'dispatched')?.turnId;
    const settleTurn = provider.find((event) => event.state === 'settled')?.turnId;
    assert.ok(dispatchTurn, 'dispatched provider event must carry turnId');
    assert.equal(dispatchTurn, settleTurn, 'dispatched and settled steps must report the same real turn');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
