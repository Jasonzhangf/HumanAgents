import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createExplicitBrainRuntime,
  createProviderExplicitBrainInterpreter,
} from '../../packages/app/src/explicit-brain-runtime.js';
import {
  publishInteractionProviderSettlement,
  readInteractionProviderSettlement,
} from '../../packages/runtime/src/explicit-brain/index.js';
import { DecisionTraceJournal, DecisionTraceStore } from '../../packages/runtime/src/explicit-brain/index.js';
import {
  createInteractionParentTurnRawOwner,
  type InteractionSemanticCheckpointJournalPort,
  type InteractionParentTurnRawJournalPort,
  type InteractionParentOpenedTurnScopeReadPort,
  type InteractionParentTurnSnapshot,
  type InteractionParentTurnAppend,
} from '../../packages/runtime/src/explicit-brain/index.js';
import { id, validateProviderSettlement, type ProviderBinding, type ProviderCloseResult, type InteractionParentProviderExecutionIdentityRef, type InteractionProviderSettlementReceipt, type AnyProviderExecutionIdentityRef, type TasklessProviderExecutionIdentityRef, type InteractionTurnIdentity, type OrganId, type OccurrenceExecutionOwner, type JournalCommitRef } from '../../packages/contracts/src/index.js';
import { ProviderAgentDriver, ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import type { AgentRole, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import { prepareAgentProvider, prepareExecutionAgentProvider, createAgentProviderPort, type AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import { createRccServeOrchestrationPorts } from '../../packages/app/src/serve-orchestration.js';
import { createServeRuntimeComposition } from '../../packages/app/src/serve-runtime.js';
import { FakeReplayExecutionRuntimePort } from '../../packages/app/src/ui-runtime/fake-port.js';
import { FileCheckpointStore, UiRuntimeApiError, UiRuntimeJournal, UiRuntimeService, startUiRuntime, type UiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import type { UiRuntimeGrantExecutionReceipt } from '../../packages/app/src/ui-runtime/service.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { uiRuntimeControlJournalPath } from '../../packages/app/src/ui-runtime/journal.js';
import { acquireDaemonLease, readDaemonLease, type SupervisorLease } from '../../packages/app/src/supervisor/index.js';
import { ensureControlLayout, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';

const parentFixtureRoot = join(process.env.HUMANAGENT_TEST_ROOT ?? '/Users/fanzhang/.humanagent/test-fixtures/provider-parent-close-fact-20261016', `app-${randomUUID()}`);
const parentEvidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(parentFixtureRoot, 'assets')));
function parentDependencies() {
  const journal = new JsonlOrganJournal(join(parentFixtureRoot, `${randomUUID()}.jsonl`));
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  return {
    organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test',
    journal,
    parentJournal: new JsonlInteractionParentTurnJournal(journal),
    helperJournal,
    checkpointJournal: helperJournal,
    rawEvidence: parentEvidence, rawContent: providerRawContentReader(parentEvidence),
    clock: { now: () => new Date().toISOString() },
    helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
  };
}

/**
 * Seed the exact durable shape a crashed Provider stream leaves behind: one
 * committed turn input with provider binding and execution owner, one request
 * that accepted only incomplete reasoning-summary content, and no resource
 * close, provider settlement, assistant text, request completion or semantic
 * checkpoint. This is a genuine interrupted epoch, not a recoverable turn.
 */
async function seedInterruptedParentTurn(input: {
  readonly parentJournal: JsonlInteractionParentTurnJournal;
  readonly evidence: typeof parentEvidence;
  readonly rawContent: ReturnType<typeof providerRawContentReader>;
  readonly binding: ProviderBinding;
  readonly scope: { readonly organId: OrganId; readonly interactionScopeId: string };
  readonly interactionId: string;
  readonly turnId: string;
  readonly initialInputText: string;
  readonly executionOwner?: OccurrenceExecutionOwner;
  readonly withProviderBinding?: boolean;
  readonly unpairedToolCall?: boolean;
  readonly pairedToolCall?: boolean;
  readonly requestPhase?: 'dispatching' | 'waiting' | 'cancelled';
}): Promise<{
  readonly turn: InteractionTurnIdentity;
  readonly request: { readonly turnId: string; readonly requestId: string };
}> {
  const operationScope = { organId: input.scope.organId, operationId: id('operation', `op-${input.turnId}`) };
  const turn: InteractionTurnIdentity = {
    organId: input.scope.organId,
    interactionScopeId: input.scope.interactionScopeId,
    interactionId: input.interactionId,
    inputRevision: 1,
    turnId: input.turnId,
  };
  const execution = { runtimeId: input.turnId, ...operationScope, executionEpoch: 1, interactionTurn: turn };
  const initialInput = {
    ref: await input.evidence.write({
      scope: operationScope, kind: 'execution', type: 'initial-input',
      locator: turn.turnId, content: input.initialInputText,
    }),
    view: { kind: 'utf8-text' as const },
  };
  if (input.withProviderBinding === false) {
    // A legacy turn input committed before the binding was durable. Only the
    // turn input exists, so the durable read has to hold instead of recovering.
    await input.parentJournal.transactTurn(turn, () => ({
      append: {
        kind: 'turn-input',
        fact: { turn, execution, scope: operationScope, initialInput, priorCheckpoints: [] },
      },
      result: undefined,
    }));
    return { turn, request: { turnId: turn.turnId, requestId: `${input.turnId}-request` } };
  }
  const owner = createInteractionParentTurnRawOwner({
    turn, execution, scope: operationScope, initialInput, providerBinding: input.binding,
    ...(input.executionOwner === undefined ? {} : { executionOwner: input.executionOwner }),
    journal: input.parentJournal, rawContent: input.rawContent,
  });
  await owner.openTurnInput();
  const request = { turnId: turn.turnId, requestId: `${input.turnId}-request` };
  await owner.registerRequest({ execution, record: { request, scope: operationScope, phase: 'dispatching' } });
  await owner.registerRequest({ execution, record: { request, scope: operationScope, phase: input.requestPhase ?? 'waiting' } });
  const reasoning = {
    ref: await input.evidence.write({
      scope: operationScope, kind: 'execution', type: 'reasoning', locator: `${input.turnId}-reasoning`,
      content: 'partial reasoning that never reached a final answer',
    }),
    view: { kind: 'utf8-text' as const },
  };
  await owner.acceptRawFact({
    execution, scope: operationScope, request, producerSeq: 1,
    fact: { kind: 'content', channel: 'reasoning-summary', update: 'full', contentUnitId: 'reasoning-1', content: reasoning, complete: false },
  });
  if (input.unpairedToolCall) {
    await owner.acceptRawFact({
      execution, scope: operationScope, request, producerSeq: 2,
      fact: {
        kind: 'tool-call', contentUnitId: 'call-1',
        call: { callId: 'call-1', toolId: 'dispatch_helper', arguments: {}, continuationRef: 'continuation-1' },
        rawArguments: { ref: await input.evidence.write({
          scope: operationScope, kind: 'execution', type: 'tool-arguments', locator: 'call-1', content: '{}',
        }), view: { kind: 'utf8-text' as const } },
        complete: true,
      },
    });
  }
  if (input.pairedToolCall) {
    // A fully paired file-modifying tool call: the result is durably recorded,
    // so the old pairing rule considered the side effect recorded and unknown
    // only when a call lacked its result. This shape must still hold.
    await owner.acceptRawFact({
      execution, scope: operationScope, request, producerSeq: 2,
      fact: {
        kind: 'tool-call', contentUnitId: 'call-1',
        call: { callId: 'call-1', toolId: 'write_file', arguments: { path: 'side-effect.txt' }, continuationRef: 'continuation-1' },
        rawArguments: { ref: await input.evidence.write({
          scope: operationScope, kind: 'execution', type: 'tool-arguments', locator: 'call-1', content: '{"path":"side-effect.txt"}',
        }), view: { kind: 'utf8-text' as const } },
        complete: true,
      },
    });
    await owner.acceptRawFact({
      execution, scope: operationScope, request, producerSeq: 3,
      fact: {
        kind: 'tool-result', contentUnitId: 'result-1', callId: 'call-1', continuationRef: 'continuation-1',
        result: {
          ...execution, toolId: 'write_file', callId: 'call-1', status: 'succeeded',
          outputRefs: [], evidenceRefs: [],
        },
        rawOutput: { ref: await input.evidence.write({
          scope: operationScope, kind: 'execution', type: 'tool-output', locator: 'call-1-output', content: '{"written":true}',
        }), view: { kind: 'utf8-text' as const } },
        complete: true,
      },
    });
  }
  return { turn, request };
}

/**
 * Acquire a real supervisor lease whose takeover record proves the previous
 * owner was terminated. A short-lived child process holds the previous
 * generation and exits without releasing it, so the parent takeover sees a dead
 * pid and records a real `already-dead` termination receipt. This is the durable
 * evidence the Runtime is allowed to read before it discharges a crashed turn.
 */
async function acquireCrashedOwnerLease(root: string): Promise<{
  readonly owner: OccurrenceExecutionOwner;
  readonly leaseId: string;
  readonly generation: number;
}> {
  const moduleUrl = (path: string) => new URL(`../../packages/${path}`, import.meta.url).href;
  const script = `
    import { acquireDaemonLease } from ${JSON.stringify(moduleUrl('app/src/supervisor/index.js'))};
    import { ensureControlLayout, resolveRuntimePaths } from ${JSON.stringify(moduleUrl('config/src/index.js'))};
    import { join } from 'node:path';
    const paths = await resolveRuntimePaths({controlRoot: join(${JSON.stringify(root)}, 'control'), workspace: process.cwd()});
    await ensureControlLayout(paths);
    const lease = await acquireDaemonLease(paths);
    const owner = await lease.withCurrentLeaseOwner(async (authenticated) => authenticated);
    console.log(JSON.stringify({pid: process.pid, owner, leaseId: lease.record.leaseId, generation: lease.record.generation}));
    process.exit(0); // deliberate crash boundary: the old owner never releases
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exit, 0, stderr);
  const receipt = JSON.parse(stdout.trim());
  return {owner: receipt.owner, leaseId: receipt.leaseId, generation: receipt.generation};
}

/**
 * Acquire a real lease generation inside a short-lived child process that
 * exits without releasing, so the owner carries its own process start token.
 * A later owner in this process is then a committed replacement of it, exactly
 * like a real daemon that dies and is taken over by a different process.
 */
async function acquireCrashedTakeoverOwnerLease(root: string, reason: string): Promise<{
  readonly owner: OccurrenceExecutionOwner;
  readonly leaseId: string;
  readonly generation: number;
}> {
  const moduleUrl = (path: string) => new URL(`../../packages/${path}`, import.meta.url).href;
  const script = `
    import { acquireDaemonLease } from ${JSON.stringify(moduleUrl('app/src/supervisor/index.js'))};
    import { ensureControlLayout, resolveRuntimePaths } from ${JSON.stringify(moduleUrl('config/src/index.js'))};
    import { join } from 'node:path';
    const paths = await resolveRuntimePaths({controlRoot: join(${JSON.stringify(root)}, 'control'), workspace: process.cwd()});
    await ensureControlLayout(paths);
    const lease = await acquireDaemonLease(paths, {takeover: {
      reason: ${JSON.stringify(reason)}, allowed: () => true,
      stop: {gracefulTimeoutMs: 2000, pollIntervalMs: 20},
    }});
    const owner = await lease.withCurrentLeaseOwner(async (authenticated) => authenticated);
    console.log(JSON.stringify({pid: process.pid, owner, leaseId: lease.record.leaseId, generation: lease.record.generation}));
    process.exit(0); // deliberate crash boundary: the old owner never releases
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exit, 0, stderr);
  const receipt = JSON.parse(stdout.trim());
  return {owner: receipt.owner, leaseId: receipt.leaseId, generation: receipt.generation};
}

async function acquireTerminatedOwnerLease(root: string): Promise<{
  readonly lease: Awaited<ReturnType<typeof acquireDaemonLease>>;
  readonly previousOwner: OccurrenceExecutionOwner;
}> {
  const receipt = await acquireCrashedOwnerLease(root);
  const paths = await resolveRuntimePaths({controlRoot: join(root, 'control'), workspace: process.cwd()});
  const lease = await acquireDaemonLease(paths, {takeover: {
    reason: 'discharge proof test dead owner takeover', allowed: () => true,
    stop: {gracefulTimeoutMs: 2_000, pollIntervalMs: 20},
  }});
  assert.equal(lease.record.generation, 2);
  assert.equal(lease.record.takeover?.previousLeaseId, receipt.leaseId);
  assert.equal(lease.record.takeover?.previousGeneration, receipt.generation);
  assert.equal(lease.record.takeover?.termination, 'already-dead',
    'the takeover must carry a durable termination receipt, not just a shape');
  return {lease, previousOwner: receipt.owner};
}

// Exercise the real neutral adapter/raw codec. The old Task-only fake cannot
// represent this identity or deliver raw facts; changing the fixture does not
// weaken the compiling synthetic-Task RED assertions below.
class RecordedParentPort<T extends AnyProviderExecutionIdentityRef = InteractionParentProviderExecutionIdentityRef> extends ProviderAdapter<T> {
  constructor(options: { binding: ProviderBinding; stepDelayMs: number; replay: readonly { kind: string; summary: string; state: string; terminalState?: string }[];
    respond?: (wire: any) => Promise<readonly unknown[]>;
    /**
     * Frame-by-frame variant used by the concurrency consumer: it lets one
     * request stream a partial answer and stay open while a second input is
     * handled, which a single buffered array cannot express.
     */
    stream?: (wire: any) => AsyncIterable<unknown>; evidence?: typeof parentEvidence }) {
    const evidence = options.evidence ?? parentEvidence;
    const transport = new V3ProviderHttpTransport<T>({
      binding: options.binding, baseUrl: 'http://recorded.test', source: 'http', evidence,
      fetch: async (_url, init) => ({ status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: (async function* () {
          const encoder = new TextEncoder();
          const frame = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
          const wire = JSON.parse(init.body!);
          if (options.stream) {
            yield frame({ type: 'response.created', response: { id: 'recorded' } });
            for await (const next of options.stream(wire)) yield frame(next);
            yield frame({ type: 'response.completed', response: { id: 'recorded' } });
            return;
          }
          const frames = [
            { type: 'response.created', response: { id: 'recorded' } },
            ...(options.respond ? await options.respond(wire) : options.replay.filter((step) => step.kind === 'output').map((step, index) => ({
              type: 'response.output_text.done', item_id: `text-${index}`, text: step.summary,
            }))),
            { type: 'response.completed', response: { id: 'recorded' } },
          ];
          yield encoder.encode(frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''));
        })(), text: async () => '' }),
    });
    super({ binding: options.binding, routeRef: 'recorded', codec: new ResponsesProviderCodec(), transport, evidence });
  }
}
/**
 * A real JSONL parent journal whose Nth durable raw acceptance is rejected.
 *
 * The rejection happens inside the very transaction the owner staged its plan
 * in, so nothing is appended and the durable turn keeps exactly the accepted
 * prefix a busy journal leaves behind. Every other read and write is the real
 * journal, so the test observes the production shape instead of a mock.
 */
class RejectedAcceptanceJournal implements InteractionParentTurnRawJournalPort, InteractionParentOpenedTurnScopeReadPort {
  private accepted = 0;
  constructor(
    private readonly inner: JsonlInteractionParentTurnJournal,
    private readonly rejectAt: number,
  ) {}

  transactTurn<TResult>(
    turn: InteractionTurnIdentity,
    plan: (snapshot: InteractionParentTurnSnapshot) => {
      readonly append?: InteractionParentTurnAppend;
      readonly result: TResult;
    },
  ): Promise<{ readonly committed?: JournalCommitRef; readonly result: TResult }> {
    return this.inner.transactTurn<TResult>(turn, (snapshot) => {
      const planned = plan(snapshot);
      if (planned.append !== undefined && planned.append.kind === 'accepted-fact') {
        this.accepted += 1;
        if (this.accepted === this.rejectAt) {
          throw new Error('durable raw acceptance is temporarily unavailable');
        }
      }
      return planned;
    });
  }

  readTurnSnapshot(turn: InteractionTurnIdentity): Promise<InteractionParentTurnSnapshot> {
    return this.inner.readTurnSnapshot(turn);
  }

  readScopeOpenedTurns(scope: { readonly organId: OrganId; readonly interactionScopeId: string }) {
    return this.inner.readScopeOpenedTurns(scope);
  }

  readScopeAbandonedTurns(scope: { readonly organId: OrganId; readonly interactionScopeId: string }) {
    return this.inner.readScopeAbandonedTurns(scope);
  }

  readScopeParseFailures(scope: { readonly organId: OrganId; readonly interactionScopeId: string }) {
    return this.inner.readScopeParseFailures(scope);
  }

  readScopeExecutionFailures(scope: { readonly organId: OrganId; readonly interactionScopeId: string }) {
    return this.inner.readScopeExecutionFailures(scope);
  }
}
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import type { TaskGrantControlReceipt } from '../../packages/app/src/ui-runtime/task-control.js';
import type { PersistedFinalSubmitReceipt } from '../../packages/runtime/src/explicit-brain/router.js';
import { JsonlTaskPlanRevisionJournal } from '../../packages/adapters/jsonl/src/task-plan-revisions.js';
import {
  TaskPlanRevisionConsumer,
  readCurrentTaskPlan,
} from '../../packages/runtime/src/orchestration/task-plan-revisions.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';

for (const source of ['rcc', 'http'] as const) {
test(`default App composition admits the retained Task only after real HTTP grant and releases native Provider (${source})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-default-native-consumer-'));
  let runtime: UiRuntime | undefined;
  let posts = 0;
  let onPost: (() => void) | undefined;
  const posted = new Promise<void>((resolve) => { onPost = resolve; });
  const provider = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"ok","data":[{"id":"controlled-native"}]}'); return; }
    posts += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'controlled-native-request' } })}\n\n`);
    // A real open HTTP stream lets the original revoke/stop owner settle it.
    onPost?.();
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('missing controlled Provider address');
    const entries: EffectiveAgentProviderBinding[] = [{ agentId: 'controlled-execution', roleId: 'execution', source: 'agent',
      provider: { source, provider: 'rcc', binding: 'controlled-native', protocol: 'responses',
        model: 'controlled-native', route: 'controlled-native', baseUrl: `http://127.0.0.1:${address.port}` } }];
    let selections = 0;
    const select = async <TIdentity extends AnyProviderExecutionIdentityRef = import('../../packages/contracts/src/index.js').ProviderExecutionIdentityRef>(selection: { readonly roleId: AgentRole; readonly configuredAgentId?: string }) => {
      selections += 1;
      return prepareAgentProvider<TIdentity>({ ...selection, agentProviderBindings: entries, evidenceRoot: join(root, 'assets') });
    };
    const launch = await select({ roleId: 'execution' });
    const readiness = await launch.port.probe(launch.binding);
    if (source === 'http') {
      assert.equal(readiness.state, 'unknown');
      assert.equal(readiness.nextAction?.kind, 'continue');
      assert.equal(readiness.nextAction?.ref, 'http.start');
    }
    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'security', 'web-access.json'), create: true });
    runtime = await startUiRuntime({ mode: 'rcc', accessControl, organId: id('organ', 'default-native-consumer'),
      binding: launch.binding, port: launch.port, providerSource: launch.source, checkpointRoot: root, productRoot: root,
      evidenceRoot: join(root, 'assets'), uiRoot: join(process.cwd(), 'docs', 'ui'), portNumber: 0,
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'default-native', roleId: 'execution' },
      explicitBrainInterpreter: { async interpret() { return { kind: 'requirement', intent: 'create',
        normalizedInput: 'hold this controlled native task', proposal: 'hold this controlled native task', knownFacts: [], decisionRefs: [],
        structuredProposal: { revision: 1, intent: 'create', title: 'Controlled native task', objective: 'hold this controlled native task',
          deliverable: 'controlled task result', deliveryConditions: ['retain the controlled task'], evidenceRefs: [], blockingGaps: [] } }; } },
      runtimeComposition: {
        prepareAgentProvider: select,
        prepareTaskAgentProvider: (selection, owner, lease) => {
          selections += 1;
          return prepareExecutionAgentProvider({ roleId: selection.roleId,
            ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
            agentProviderBindings: entries,
            createPort: (selected) => createAgentProviderPort(selected, join(root, 'assets')) }, owner, lease);
        },
      },
    });
    await runtime.service.quiesceImplicitConsumption();
    const interactionId = await runtime.service.receiveExplicitInput({ sourceRef: 'ui:new-task-create', rawInput: 'hold this controlled native task',
      channel: 'business', requestKind: 'new-task-preview' });
    await runtime.service.interpretExplicitInput({ interactionId });
    const preview = await runtime.service.inspectExplicitInteraction(interactionId);
    const confirmed = await runtime.service.confirmExplicitRequirement({ interactionId, draftId: preview.draft!.draftId,
      inputRevision: preview.draft!.inputRevision, confirmationRef: 'confirmation:default-native', confirmedBy: 'human:operator',
      confirmedAt: '2026-10-17T00:00:00.000Z', payloadRef: 'asset://default-native', requestKind: 'new-task-create' });
    const dispatched = await runtime.service.dispatchNextExplicitRequirement();
     assert.ok(dispatched.operationId, 'ungranted dispatch must retain a prepared operation');
     const operationId = dispatched.operationId;
     if (operationId === undefined) throw new Error('ungranted dispatch has no prepared operation');
     await assert.rejects(() => runtime!.service.releaseExecution(dispatched.taskId, operationId), /verified TG1 owner is absent/);
    assert.equal(runtime.service.status().providerState, readiness.state);
    assert.equal(posts, 0, 'typed confirmation and TaskIdentity are not execution authority');
    assert.equal(selections, 1, 'no target execution Provider may be selected before grant');
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const controlPath = `${runtime.server.url}/api/tasks/${dispatched.taskId.value}/control`;
    const initial = await fetch(`${controlPath}/grant`, { headers: { cookie } });
    const read = await initial.json() as TaskGrantControlReceipt;
    assert.equal(initial.status, 200, 'default startup must inject the actual grant controller');
    const grantResponse = await fetch(`${controlPath}/grant`, { method: 'POST', headers: { cookie, origin: runtime.server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'controlled-native-grant', expectedRevision: read.readback.grant?.revision ?? 0 }) });
    const grant = await grantResponse.json() as TaskGrantControlReceipt & { readonly execution?: UiRuntimeGrantExecutionReceipt };
    assert.equal(grantResponse.status, 200);
    assert.equal(grant.readback.grant?.state, 'granted');
    // The public POST grant already runs taskControl.grant then the existing
    // release path and returns both as {...receipt, execution}. Consume that
    // release instead of issuing a second releaseExecution for the same
    // operation. A blocked or non-released execution means the grant did not
    // reach the existing release path; keep the typed receipt and fail here.
    const execution = grant.execution;
    if (execution === undefined) throw new Error('the public grant receipt must carry the release execution');
    assert.equal(execution.state, 'released',
      `grant execution must release the prepared allocation, got ${execution.state}${execution.apiError === undefined ? '' : ` (${execution.apiError.code}: ${execution.apiError.message}; next: ${execution.apiError.nextAction})`}`);
    const selector = execution.selector;
    if (selector === undefined) throw new Error('release must report the selector it released');
    assert.equal(selector.taskId.value, dispatched.taskId.value);
    assert.equal(selector.operationId, operationId.value);
    assert.equal(selector.executionEpoch, dispatched.executionEpoch);
    const current = execution.current;
    if (current === undefined) throw new Error('release must report the current execution view');
    assert.equal(current.taskId.value, dispatched.taskId.value);
    assert.equal(current.operationId, operationId.value);
    assert.equal(current.executionEpoch, dispatched.executionEpoch);
    const released = execution;
    await Promise.race([posted, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('native Provider POST not reached')), 5000); timer.unref?.(); })]);
    assert.equal(posts, 1);
    assert.equal(selections, 2, 'same prepared allocation must select the native Provider exactly once after grant');
    const revokeResponse = await fetch(`${controlPath}/revoke`, { method: 'POST', headers: { cookie, origin: runtime.server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'controlled-native-revoke', expectedRevision: grant.readback.grant!.revision }) });
    const revoked = await revokeResponse.json() as TaskGrantControlReceipt;
    assert.equal(revokeResponse.status, 200);
    assert.equal(revoked.readback.grant?.state, 'revoked');
    assert.ok(revoked.stop, 'revoke must delegate to the standard stop owner');
    const runtimeOwner = accessControl.readRuntimeProductIdentity().owner;
    await accessControl.logout();
    assert.ok((await accessControl.verifyProductPrincipal(cookie)).state !== 'valid');
    assert.equal(accessControl.readRuntimeProductIdentity().owner, runtimeOwner);
    assert.equal(runtime.service.taskDetail(dispatched.taskId).taskId.value, dispatched.taskId.value);
    assert.equal(posts, 1, 'revoke may not start new Provider business');
    assert.equal(runtime.service.status().providerState, readiness.state);
    console.log(JSON.stringify({ source, readiness, confirmed, dispatched, released, posts, selections, revoke: revoked.stop }));
  } finally {
    try { await runtime?.close(); } finally {
      provider.closeIdleConnections?.();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});
}

// Probability unknown: no two-Task App consumer covered scheduling/context bleed.
// Impact: serialization or false completion; cost: one bounded local HTTP consumer.
test('two top-level native tasks share one App and overlap real execution requests with independent Planners', async () => {
  const projectKey = `two-top-level-native-${randomUUID()}`;
  const fixtureBase = join(process.env.HOME ?? '/Users/fanzhang', '.humanagent', 'test-fixtures');
  await mkdir(fixtureBase, { recursive: true });
  const root = await mkdtemp(join(fixtureBase, 'provider-two-top-tasks-'));
  const taskSpecs = [
    {
      rawInput: `TOP-LEVEL-TASK-A-${randomUUID()}`,
      title: 'Top level task A',
      objective: 'Deliver the exact top-level A result',
      deliveryText: `TOP-LEVEL-DELIVERY-A-${randomUUID()}`,
    },
    {
      rawInput: `TOP-LEVEL-TASK-B-${randomUUID()}`,
      title: 'Top level task B',
      objective: 'Deliver the exact top-level B result',
      deliveryText: `TOP-LEVEL-DELIVERY-B-${randomUUID()}`,
    },
    {
      rawInput: `TOP-LEVEL-TASK-C-${randomUUID()}`,
      title: 'Top level task C',
      objective: 'Deliver the exact top-level C result',
      deliveryText: `TOP-LEVEL-DELIVERY-C-${randomUUID()}`,
    },
  ] as const;
  type TaskSpec = typeof taskSpecs[number];
  type Dispatched = Awaited<ReturnType<UiRuntime['service']['dispatchNextExplicitRequirement']>>;
  type ConfirmedRequirement = Awaited<ReturnType<UiRuntime['service']['confirmExplicitRequirement']>>;
  type ReleasedExecution = NonNullable<UiRuntimeGrantExecutionReceipt['current']>;
  type ReleasedExecutionAtBarrier = ReleasedExecution & {
    readonly operationId: string;
    readonly executionEpoch: number;
  };
  type PreparedEntry = {
    readonly spec: TaskSpec;
    readonly dispatch: Dispatched;
    grantRevision?: number;
    releasedExecution?: ReleasedExecutionAtBarrier;
  };
  const initialTaskSpecs = taskSpecs.slice(0, 2);
  const capacityTaskSpec = taskSpecs[2]!;
  const prepared: PreparedEntry[] = [];
  const thirdCapacityObservation: Record<string, unknown> = {};
  const executionInitials: Array<{ readonly body: string; readonly spec: TaskSpec }> = [];
  const plannerRequests: Array<{ readonly body: string; readonly spec: TaskSpec; readonly payload: Record<string, unknown> }> = [];
  let activeExecutionInitials = 0;
  let maxActiveExecutionInitials = 0;
  let resolveCapacityExecution!: () => void;
  const capacityExecutionReached = new Promise<void>((resolve) => { resolveCapacityExecution = resolve; });
  let overlapSettled = false;
  let resolveOverlap!: () => void;
  let rejectOverlap!: (error: Error) => void;
  const overlapReached = new Promise<void>((resolve, reject) => {
    resolveOverlap = resolve;
    rejectOverlap = reject;
  });
  const heldSpecs = new Set<TaskSpec>(initialTaskSpecs);
  const executionGateResolvers = new Map<TaskSpec, () => void>();
  const executionGates = new Map<TaskSpec, Promise<void>>();
  let overlapTimer: ReturnType<typeof setTimeout> | undefined;
  const overlapTimeout = () => {
    if (overlapSettled) return;
    overlapSettled = true;
    rejectOverlap(new Error('two top-level native Tasks did not overlap their initial execution requests'));
  };
  const executionGate = (spec: TaskSpec): Promise<void> => {
    const existing = executionGates.get(spec);
    if (existing !== undefined) return existing;
    let resolve!: () => void;
    const gate = new Promise<void>((settle) => { resolve = settle; });
    executionGateResolvers.set(spec, resolve);
    executionGates.set(spec, gate);
    return gate;
  };
  const releaseExecutionGate = (spec: TaskSpec) => {
    const resolve = executionGateResolvers.get(spec);
    if (resolve === undefined) return;
    executionGateResolvers.delete(spec);
    heldSpecs.delete(spec);
    resolve();
  };
  const releaseAllExecutionGates = () => {
    if (overlapTimer !== undefined) clearTimeout(overlapTimer);
    for (const spec of [...heldSpecs]) releaseExecutionGate(spec);
  };
  const requestTasks = new Set<Promise<void>>();

  const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`missing ${label}`);
    return value as Record<string, unknown>;
  };
  const requireText = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`missing ${label}`);
    return value;
  };
  const requireNumber = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`missing ${label}`);
    return value;
  };
  const evidenceLocators = (value: unknown): readonly string[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((ref) => {
      const locator = (ref as { readonly locator?: unknown } | null)?.locator;
      return typeof locator === 'string' && locator.length > 0 ? [locator] : [];
    });
  };
  const closureSection = (value: unknown, label: string): { readonly text: string; readonly locators: readonly string[] } => {
    const section = requireRecord(value, `Planner closure ${label}`);
    return { text: requireText(section.text, `Planner closure ${label} text`),
      locators: evidenceLocators(section.evidenceRefs) };
  };
  const plannerPayload = (body: string): Record<string, unknown> | undefined => {
    let wire: unknown;
    try {
      wire = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (typeof wire !== 'object' || wire === null || Array.isArray(wire)) return undefined;
    const input = (wire as Record<string, unknown>).input;
    if (!Array.isArray(input)) return undefined;
    for (const item of input) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const message = item as Record<string, unknown>;
      if (message.type !== 'message' || message.role !== 'user' || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (typeof part !== 'object' || part === null || Array.isArray(part)) continue;
        const content = part as Record<string, unknown>;
        if (content.type !== 'input_text' || typeof content.text !== 'string') continue;
        let candidate: unknown;
        try {
          candidate = JSON.parse(content.text);
        } catch {
          continue;
        }
        if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
          && (candidate as Record<string, unknown>).role === 'planner') return candidate as Record<string, unknown>;
      }
    }
    return undefined;
  };
  const hasTurnEndSurface = (body: string): boolean => {
    try {
      const wire = requireRecord(JSON.parse(body), 'Responses wire');
      return Array.isArray(wire.tools) && wire.tools.some((tool) =>
        typeof tool === 'object' && tool !== null && (tool as Record<string, unknown>).name === 'humanagent_turn_end');
    } catch {
      return false;
    }
  };
  const hasFunctionOutput = (body: string): boolean => {
    try {
      const wire = requireRecord(JSON.parse(body), 'Responses wire');
      return Array.isArray(wire.input) && wire.input.some((item) =>
        typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'function_call_output');
    } catch {
      return false;
    }
  };
  const specFor = (body: string): TaskSpec => {
    const own = taskSpecs.filter((spec) => body.includes(spec.rawInput));
    if (own.length !== 1) throw new Error(`expected one Task sentinel in wire, found ${own.length}`);
    return own[0]!;
  };
  const frames = (items: readonly unknown[]) => items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
  const plannerFrames = (payload: Record<string, unknown>, body: string): readonly unknown[] => {
    const task = requireRecord(payload.task, 'Planner task');
    const closure = requireRecord(payload.closure, 'Planner closure');
    const summary = requireRecord(closure.summary, 'Planner closure summary');
    const title = requireText(task.title, 'Planner task title');
    const directive = requireText(task.directive, 'Planner task directive');
    const confirmedSource = requireRecord(payload.confirmedSource, 'Planner confirmed source');
    const goal = closureSection(summary.goal, 'goal');
    const actions = closureSection(summary.actions, 'actions');
    const result = closureSection(summary.result, 'result');
    const expectedNextStep = closureSection(summary.expectedNextStep, 'expectedNextStep');
    const source = {
      requirementId: requireText(confirmedSource.requirementId, 'Planner confirmed requirement ID'),
      inputRevision: requireNumber(confirmedSource.inputRevision, 'Planner confirmed input revision'),
      draftId: requireText(confirmedSource.draftId, 'Planner confirmed draft ID'),
      draftRevisionVersion: requireNumber(confirmedSource.draftRevisionVersion, 'Planner confirmed draft revision version'),
      draftRevisionHash: requireText(confirmedSource.draftRevisionHash, 'Planner confirmed draft revision hash'),
      confirmationRef: requireText(confirmedSource.confirmationRef, 'Planner confirmed confirmation reference'),
      evidenceLocators: evidenceLocators(confirmedSource.evidenceRefs),
    };
    const refinedResults = (Array.isArray(payload.refinedResults) ? payload.refinedResults : []).map((entry) => {
      const refined = requireRecord(entry, 'Planner refined result');
      return {
        role: requireText(refined.role, 'Planner refined result role'),
        assignmentId: requireText(refined.assignmentId, 'Planner refined result assignment ID'),
        status: requireText(refined.status, 'Planner refined result status'),
        evidenceLocators: evidenceLocators(refined.evidenceRefs),
      };
    });
    const responseId = `planner-${specFor(body).title.replaceAll(' ', '-')}`;
    return [
      { type: 'response.created', response: { id: responseId } },
      { type: 'response.output_text.done', item_id: `${responseId}-text`, text: JSON.stringify({
        decision: 'complete',
        snapshot: {
          title,
          summary: `Whole-task plan for "${title}": the directive is "${directive}". The closed turn records the goal "${goal.text}", the actions "${actions.text}", the result "${result.text}", and the expected next step "${expectedNextStep.text}".`,
          completeness: { scope: 'whole-task', status: 'complete' },
          acceptanceCriteria: [{
            criterionId: 'original-directive-satisfied',
            description: `Satisfy the original directive "${directive}" and preserve the confirmed effect cited by the closed turn.`,
          }],
          nodes: [{
            nodeId: 'whole-task',
            kind: 'task',
            title,
            intent: directive,
            definition: {
              directive,
              goal: goal.text,
              actions: actions.text,
              result: result.text,
              expectedNextStep: expectedNextStep.text,
              confirmedSource: source,
              refinedResults,
              evidenceLocators: [...new Set([
                ...goal.locators, ...actions.locators, ...result.locators, ...expectedNextStep.locators,
                ...source.evidenceLocators, ...refinedResults.flatMap((refined) => refined.evidenceLocators),
              ])],
            },
          }],
          phases: [],
          relations: [],
        },
        reasonText: 'The whole-task plan aligns with this Task original directive and closed turn.',
      }) },
      { type: 'response.completed', response: { id: responseId } },
    ];
  };
  const handleProviderRequest = async (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => {
    const path = request.url ?? '';
    if (request.method === 'GET' && (path === '/health' || path === '/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(path === '/health'
        ? { status: 'ok', version: 'two-top-native' }
        : { data: taskSpecs.map((spec, index) => ({ id: index === 0 ? 'controlled-execution' : 'controlled-orchestration' })) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const planner = plannerPayload(body);
    const functionOutput = hasFunctionOutput(body);
    const turnEndSurface = hasTurnEndSurface(body);
    if (planner !== undefined) {
      const spec = specFor(body);
      plannerRequests.push({ body, spec, payload: planner });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frames(plannerFrames(planner, body)));
      return;
    }
    if (functionOutput) {
      const spec = specFor(body);
      const responseId = `drain-${spec.title.replaceAll(' ', '-')}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frames([
        { type: 'response.created', response: { id: responseId } },
        { type: 'response.output_text.done', item_id: `${responseId}-text`, text: `drained ${spec.deliveryText}` },
        { type: 'response.completed', response: { id: responseId } },
      ]));
      return;
    }
    if (!turnEndSurface) throw new Error('controlled Provider received an unknown Responses request');
    const spec = specFor(body);
    executionInitials.push({ body, spec });
    if (spec === capacityTaskSpec) resolveCapacityExecution();
    activeExecutionInitials += 1;
    maxActiveExecutionInitials = Math.max(maxActiveExecutionInitials, activeExecutionInitials);
    if (!overlapSettled && initialTaskSpecs.every((held) => executionInitials.some((request) => request.spec === held))) {
      overlapSettled = true;
      if (overlapTimer !== undefined) clearTimeout(overlapTimer);
      resolveOverlap();
    }
    try {
      if (heldSpecs.has(spec)) await executionGate(spec);
    } finally {
      activeExecutionInitials -= 1;
    }
    const section = (text: string) => ({ text, evidenceRefs: [] });
    const responseId = `execution-${spec.title.replaceAll(' ', '-')}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames([
      { type: 'response.created', response: { id: responseId } },
      { type: 'response.output_item.done', output_index: 0, item: {
        type: 'function_call',
        call_id: `turn-end-${spec.title.replaceAll(' ', '-')}`,
        name: 'humanagent_turn_end',
        arguments: JSON.stringify({
          summary: {
            goal: section(spec.objective),
            actions: section(`Execute ${spec.rawInput}`),
            result: section(spec.deliveryText),
            expectedNextStep: section('Close this Task'),
          },
          deliveryText: spec.deliveryText,
          deliveryRefs: [],
        }),
      } },
      { type: 'response.completed', response: { id: responseId } },
    ]));
  };
  const provider = createServer((request, response) => {
    let task!: Promise<void>;
    task = handleProviderRequest(request, response)
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!response.writableEnded) {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(errorMessage);
        }
      })
      .finally(() => { requestTasks.delete(task); });
    requestTasks.add(task);
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));

  let runtime: UiRuntime | undefined;
  let orchestration: ReturnType<typeof createServeRuntimeComposition> | undefined;
  let accessControl: AccessControlService | undefined;
  let cookie: string | undefined;
  let passed = false;
  try {
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('missing controlled Provider address');
    const entries: EffectiveAgentProviderBinding[] = [
      { agentId: 'controlled-execution', roleId: 'execution', source: 'agent',
        provider: { source: 'rcc', provider: 'rcc', binding: 'two-top-execution', protocol: 'responses',
          model: 'controlled-execution', route: 'controlled-execution', baseUrl: `http://127.0.0.1:${address.port}` } },
      { agentId: 'controlled-orchestration', roleId: 'orchestration', source: 'agent',
        provider: { source: 'rcc', provider: 'rcc', binding: 'two-top-orchestration', protocol: 'responses',
          model: 'controlled-orchestration', route: 'controlled-orchestration', baseUrl: `http://127.0.0.1:${address.port}` } },
    ];
    const select = async <TIdentity extends AnyProviderExecutionIdentityRef = import('../../packages/contracts/src/index.js').ProviderExecutionIdentityRef>(
      selection: { readonly roleId: AgentRole; readonly configuredAgentId?: string },
    ) => prepareAgentProvider<TIdentity>({ ...selection, agentProviderBindings: entries, evidenceRoot: join(root, 'assets') });
    const launch = await select({ roleId: 'execution' });
    const eventJournal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const publishers = { async resolvePublisher() { return null; } };
    orchestration = createServeRuntimeComposition({
      maxRuntimes: 2,
      eventBusPorts: { journal: eventJournal, publishers, consumers: { async resolveConsumer() { return null; } },
        externalOperations: eventJournal, barrierIntents: eventJournal },
      feedbackPorts: { journal: eventJournal, publishers }, feedbackPublisherId: 'two-top-native-orchestration',
      ...createRccServeOrchestrationPorts({ port: launch.port, binding: launch.binding, prepareAgentProvider: select,
        promptSegments: { review: [] } }),
    });
    accessControl = await AccessControlService.open({ credentialPath: join(root, 'security', 'web-access.json'), create: true });
    runtime = await startUiRuntime({ mode: 'rcc', accessControl, organId: id('organ', 'two-top-native'),
      binding: launch.binding, port: launch.port, providerSource: launch.source, checkpointRoot: root, productRoot: root,
      evidenceRoot: join(root, 'assets'), uiRoot: join(process.cwd(), 'docs', 'ui'), portNumber: 0,
      maxConcurrentTasks: 2,
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey, roleId: 'execution' },
      explicitBrainInterpreter: {
        async interpret(input: { readonly rawInput?: string }) {
          const spec = taskSpecs.find((candidate) => candidate.rawInput === input.rawInput);
          if (spec === undefined) throw new Error('unknown explicit input');
          return { kind: 'requirement', intent: 'create',
            normalizedInput: [spec.rawInput, `Objective: ${spec.objective}`,
              `Deliverable: ${spec.deliveryText}`, 'Delivery condition: deliver the exact sentinel'].join('\n'),
            proposal: spec.deliveryText, knownFacts: [], decisionRefs: [],
            structuredProposal: { revision: 1, intent: 'create', title: spec.title, objective: spec.objective,
              deliverable: spec.deliveryText, deliveryConditions: ['deliver the exact sentinel'],
              evidenceRefs: [], blockingGaps: [] } };
        },
      },
      runtimeComposition: {
        prepareAgentProvider: select,
        createTaskAssembly: orchestration.createTaskAssembly,
        prepareTaskAgentProvider: (selection, owner, lease) => prepareExecutionAgentProvider({ roleId: selection.roleId,
          ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
          agentProviderBindings: entries,
          createPort: (selected) => createAgentProviderPort(selected, join(root, 'assets')) }, owner, lease),
      },
    });
    await runtime.service.quiesceImplicitConsumption();

    const submitTopLevelTask = async (
      spec: TaskSpec,
      suffix: string = spec.title,
    ): Promise<{ readonly receipt: ConfirmedRequirement; readonly interactionId: string }> => {
      const interactionId = await runtime!.service.receiveExplicitInput({ sourceRef: `ui:${suffix}`, rawInput: spec.rawInput,
        channel: 'business', requestKind: 'new-task-preview' });
      await runtime!.service.interpretExplicitInput({ interactionId });
      const preview = await runtime!.service.inspectExplicitInteraction(interactionId);
      if (preview.draft === undefined) throw new Error(`missing explicit draft for ${spec.title}`);
      const receipt = await runtime!.service.confirmExplicitRequirement({ interactionId, draftId: preview.draft.draftId,
        inputRevision: preview.draft.inputRevision, confirmationRef: `confirmation:${suffix}`,
        confirmedBy: 'human:operator', confirmedAt: '2026-10-17T00:00:00.000Z',
        payloadRef: `asset://${suffix.replaceAll(' ', '-')}`, requestKind: 'new-task-create' });
      return { receipt, interactionId };
    };
    const submitAndDispatch = async (spec: TaskSpec): Promise<Dispatched> => {
      await submitTopLevelTask(spec);
      return await runtime!.service.dispatchNextExplicitRequirement();
    };
    for (const spec of initialTaskSpecs) {
      const dispatch = await submitAndDispatch(spec);
      if (dispatch.operationId === undefined) throw new Error(`missing prepared operation for ${spec.title}`);
      prepared.push({ spec, dispatch });
    }

    assert.equal(prepared.length, 2);
    assert.equal(prepared[0]!.dispatch.taskId.value === prepared[1]!.dispatch.taskId.value, false);
    assert.equal(prepared[0]!.dispatch.operationId!.value === prepared[1]!.dispatch.operationId!.value, false);
    assert.equal(executionInitials.length, 0, 'no execution request may start before grant');

    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    cookie = accessControl.sessionCookie(session).split(';')[0]!;
    if (runtime === undefined || cookie === undefined) throw new Error('two-task HTTP grant owner is unavailable');
    const grantedRuntime: UiRuntime = runtime;
    const grantedCookie: string = cookie;
    overlapTimer = setTimeout(overlapTimeout, 4000);
    overlapTimer.unref?.();
    // Observe the rejection immediately, including while HTTP grant release awaits.
    void overlapReached.catch(() => {});
    const grantPreparedTask = async (entry: PreparedEntry, requestId: string) => {
      const operationId = entry.dispatch.operationId;
      if (operationId === undefined) throw new Error('prepared operation disappeared');
      const controlPath = `${grantedRuntime.server.url}/api/tasks/${entry.dispatch.taskId.value}/control`;
      const initial = await fetch(`${controlPath}/grant`, { headers: { cookie: grantedCookie } });
      assert.equal(initial.status, 200);
      const read = await initial.json() as TaskGrantControlReceipt;
      const grantResponse = await fetch(`${controlPath}/grant`, { method: 'POST',
        headers: { cookie: grantedCookie, origin: grantedRuntime.server.url, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, expectedRevision: read.readback.grant?.revision ?? 0 }) });
      const grant = await grantResponse.json() as TaskGrantControlReceipt & {
        readonly execution: UiRuntimeGrantExecutionReceipt;
      };
      assert.equal(grantResponse.status, 200);
      assert.equal(grant.readback.grant?.state, 'granted');
      entry.grantRevision = grant.readback.grant?.revision;
      const released: ReleasedExecution | undefined = grant.execution.current;
      if (released !== undefined) {
        assert.equal(released.taskId.value, entry.dispatch.taskId.value);
        if (released.operationId !== undefined && released.executionEpoch !== undefined) {
          entry.releasedExecution = { ...released, operationId: released.operationId,
            executionEpoch: released.executionEpoch };
        }
      }
      return grant;
    };
    await Promise.all(prepared.map(async (entry, index) => {
      const grant = await grantPreparedTask(entry, `two-top-grant-${index}`);
      assert.equal(grant.execution.state, 'released');
      const released = entry.releasedExecution;
      if (released === undefined) throw new Error('released grant execution has no operation and execution epoch');
      assert.equal(released.operationId, entry.dispatch.operationId!.value);
      assert.equal(released.state, 'running');
    }));
    await overlapReached;
    assert.equal(maxActiveExecutionInitials, 2, 'both initial execution HTTP requests must be active together');
    assert.equal(executionInitials.length, 2);
    const taskJournalAtBarrier = new UiRuntimeJournal(
      join(root, 'rcc', 'ui-runtime-journal.jsonl'),
    ).replay();
    if (runtime === undefined) throw new Error('missing runtime at overlap barrier');
    const barrierRuntime: UiRuntime = runtime;
    const preparedAllocations = prepared.map((entry) => {
      const operationId = entry.dispatch.operationId;
      if (operationId === undefined) throw new Error('prepared operation disappeared at barrier');
      const released = entry.releasedExecution;
      if (released === undefined) throw new Error('released execution disappeared at barrier');
      const matches = taskJournalAtBarrier.filter((record) =>
        record.kind === 'operation.prepared'
        && record.allocation.taskId.value === released.taskId.value
        && record.allocation.operationId.value === released.operationId
        && record.allocation.executionEpoch === released.executionEpoch);
      assert.equal(matches.length, 1,
        `${entry.spec.title} must have exactly one prepared allocation at its Task, operation and epoch`);
      const match = matches[0];
      if (match?.kind !== 'operation.prepared') throw new Error(`missing typed prepared allocation for ${entry.spec.title}`);
      const allocation = match.allocation;
      assert.equal(allocation.taskId.value, released.taskId.value);
      assert.equal(allocation.operationId.value, operationId.value);
      assert.equal(allocation.executionEpoch, released.executionEpoch);
      assert.equal(allocation.scope.taskId?.value, released.taskId.value);
      assert.equal(allocation.scope.operationId?.value, operationId.value);
      assert.equal(allocation.assignmentId, `assignment-${operationId.value}`);
      assert.ok(allocation.runtimeId.length > 0, `${entry.spec.title} must have a nonempty runtime ID`);
      const dashboard = barrierRuntime.service.taskDashboard(released.taskId);
      assert.equal(dashboard.state, 'running', `${entry.spec.title} must be running at the overlap barrier`);
      assert.equal(dashboard.operationId, operationId.value);
      assert.equal(dashboard.executionEpoch, allocation.executionEpoch);
      return allocation;
    });
    assert.equal(preparedAllocations.length, 2);
    const barrierRuntimeIds = preparedAllocations.map(({ runtimeId }) => runtimeId);
    assert.equal(new Set(barrierRuntimeIds).size, 2,
      'the two Tasks must use distinct actual runtime instances at the barrier');

    const waitForTask = async (
      spec: TaskSpec,
      taskId: Dispatched['taskId'],
      operationId: NonNullable<Dispatched['operationId']>,
    ) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const detail = runtime!.service.taskDetail(taskId);
        const finalSucceeded = runtime!.service.eventsSince(operationId).some((event) =>
          event.kind === 'execution.terminal'
          && event.terminalPhase === 'final'
          && event.state === 'succeeded');
        if (detail.output?.state === 'succeeded'
          && detail.output.summary === spec.deliveryText
          && finalSucceeded) {
          return detail;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Task ${spec.title} did not reach its exact delivered terminal output and operation final success`);
    };

    const { receipt: thirdConfirmation, interactionId: thirdInteractionId } =
      await submitTopLevelTask(capacityTaskSpec, 'capacity-third');
    let thirdDispatch: Dispatched | undefined;
    let thirdWaitingReceipt: UiRuntimeApiError | undefined;
    try {
      thirdDispatch = await runtime.service.dispatchNextExplicitRequirement();
    } catch (error) {
      if (!(error instanceof UiRuntimeApiError)) throw error;
      thirdWaitingReceipt = error;
    }
    assert.equal(executionInitials.some((request) => request.spec === capacityTaskSpec), false,
      'grant or admission must not count as third execution');
    assert.equal(executionInitials.length, 2);
    assert.equal(activeExecutionInitials, 2);
    thirdCapacityObservation.beforeRelease = thirdWaitingReceipt === undefined ? {
      kind: 'dispatched', taskId: thirdDispatch!.taskId.value,
      operationId: thirdDispatch!.operationId?.value, executionEpoch: thirdDispatch!.executionEpoch,
    } : {
      kind: 'waiting-error', code: thirdWaitingReceipt.code, ownerId: thirdWaitingReceipt.ownerId,
      nextAction: thirdWaitingReceipt.nextAction,
    };

    let capacityEntry: PreparedEntry | undefined;
    if (thirdDispatch === undefined) {
      if (thirdWaitingReceipt === undefined) throw new Error('third dispatch produced neither receipt nor error');
      assert.equal(thirdWaitingReceipt.code, 'implicit-admission.waiting');
      assert.equal(thirdWaitingReceipt.ownerId, 'runtime-coordinator');
      assert.equal(thirdWaitingReceipt.nextAction, 'wait:queue.execution.concurrency');
      assert.equal((await runtime.service.inspectExplicitInteraction(thirdInteractionId)).state, 'confirmed');

      releaseExecutionGate(initialTaskSpecs[0]!);
      await waitForTask(initialTaskSpecs[0]!, prepared[0]!.dispatch.taskId, prepared[0]!.dispatch.operationId!);
      assert.equal(runtime.service.taskDashboard(prepared[1]!.dispatch.taskId).state, 'running',
        'the second Task must remain held while only the first capacity slot is released');
      const retried = await runtime.service.dispatchNextExplicitRequirement();
      assert.equal(retried.requirement.draftId, thirdConfirmation.requirement.draftId);
      assert.equal(retried.taskId.value === prepared[0]!.dispatch.taskId.value, false);
      assert.equal(retried.taskId.value === prepared[1]!.dispatch.taskId.value, false);
      if (retried.operationId === undefined) throw new Error('freed capacity did not prepare the third task');
      capacityEntry = { spec: capacityTaskSpec, dispatch: retried };
      prepared.push(capacityEntry);
      const grant = await grantPreparedTask(capacityEntry, 'two-top-capacity-grant');
      assert.equal(grant.execution.state, 'released');
      assert.equal(grant.execution.current?.state, 'running');
      await Promise.race([capacityExecutionReached, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(
          'third Task did not start after the same public action and one capacity release'
        )), 5000);
        timer.unref?.();
      })]);
      thirdCapacityObservation.afterRelease = {
        kind: 'started', taskId: retried.taskId.value, operationId: retried.operationId.value,
        executionEpoch: grant.execution.current?.executionEpoch,
        grantExecutionState: grant.execution.state,
      };
    } else {
      if (thirdDispatch.operationId === undefined) {
        throw new Error('third dispatch returned a Task without its prepared operation');
      }
      capacityEntry = { spec: capacityTaskSpec, dispatch: thirdDispatch };
      prepared.push(capacityEntry);
      const grant = await grantPreparedTask(capacityEntry, 'two-top-capacity-grant');
      const started = grant.execution.state === 'released'
        || (grant.execution.state === 'current' && grant.execution.current?.state === 'running');
      thirdCapacityObservation.afterGrant = {
        taskId: thirdDispatch.taskId.value, operationId: thirdDispatch.operationId?.value,
        executionEpoch: thirdDispatch.executionEpoch, grantExecutionState: grant.execution.state,
        grantExecutionCurrentState: grant.execution.current?.state,
        grantApiError: grant.execution.apiError,
      };
      assert.equal(started, false, 'third Task must not run while two Tasks occupy capacity 2');
      assert.equal(executionInitials.some((request) => request.spec === capacityTaskSpec), false);
      releaseExecutionGate(initialTaskSpecs[0]!);
      await waitForTask(initialTaskSpecs[0]!, prepared[0]!.dispatch.taskId, prepared[0]!.dispatch.operationId!);
      assert.equal(runtime.service.taskDashboard(prepared[1]!.dispatch.taskId).state, 'running',
        'the second Task must remain held while only the first capacity slot is released');
      if (!started) {
        const retriedGrant = await grantPreparedTask(capacityEntry, 'two-top-capacity-grant-retry');
        assert.equal(retriedGrant.execution.state, 'released');
      }
      await Promise.race([capacityExecutionReached, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(
          'third Task did not start after the same public action and one capacity release'
        )), 5000);
        timer.unref?.();
      })]);
      thirdCapacityObservation.afterRelease = { kind: 'started', taskId: thirdDispatch.taskId.value,
        operationId: thirdDispatch.operationId?.value, executionEpoch: thirdDispatch.executionEpoch };
    }

    releaseAllExecutionGates();
    const details = await Promise.all(prepared.map((entry) =>
      waitForTask(entry.spec, entry.dispatch.taskId, entry.dispatch.operationId!)));
    assert.equal(details[0]!.output?.summary, taskSpecs[0].deliveryText);
    assert.equal(details[1]!.output?.summary, taskSpecs[1].deliveryText);
    assert.equal(details[2]!.output?.summary, capacityTaskSpec.deliveryText);
    assert.equal(details[0]!.taskId.value === details[1]!.taskId.value, false);

    const checkpointIds: string[] = [];
    const taskControlJournal = new JsonlOrganJournal(
      uiRuntimeControlJournalPath(join(root, 'rcc')),
    );
    const identities = await new JsonlTaskIdentityJournal(taskControlJournal).replay();
    const plans = new TaskPlanRevisionConsumer(
      new JsonlTaskPlanRevisionJournal(taskControlJournal),
    );
    const currentStates = createJsonlRuntimeTaskCurrentStateJournal({
      journal: taskControlJournal,
    });
    for (const entry of prepared) {
      const others = taskSpecs.filter((spec) => spec !== entry.spec);
      const operationId = entry.dispatch.operationId!;
      const replay = runtime.service.eventsSince(operationId);
      assert.ok(replay.some((event) => event.state === 'succeeded' && event.terminalPhase === 'final'),
        `operation ${operationId.value} must reach final success`);
      assert.ok(replay.every((event) => event.taskId.value === entry.dispatch.taskId.value));
      const ownExecution = executionInitials.find((request) => request.spec === entry.spec);
      if (ownExecution === undefined) throw new Error(`missing execution request for ${entry.spec.title}`);
      assert.ok(ownExecution.body.includes(entry.spec.rawInput));
      assert.ok(ownExecution.body.includes(entry.spec.deliveryText));
      for (const other of others) {
        assert.equal(ownExecution.body.includes(other.rawInput), false);
        assert.equal(ownExecution.body.includes(other.deliveryText), false);
      }
      const ownPlanner = plannerRequests.find((request) => request.spec === entry.spec);
      if (ownPlanner === undefined) throw new Error(`missing role-backed Planner request for ${entry.spec.title}`);
      assert.ok(ownPlanner.body.includes(entry.spec.rawInput));
      assert.ok(ownPlanner.body.includes(entry.spec.deliveryText));
      for (const other of others) {
        assert.equal(ownPlanner.body.includes(other.rawInput), false);
        assert.equal(ownPlanner.body.includes(other.deliveryText), false);
      }

      const dashboard = runtime.service.taskDashboard(entry.dispatch.taskId);
      assert.equal(dashboard.taskId.value, entry.dispatch.taskId.value);

      const matches = identities.filter(
        (identity) => identity.scope.taskId.value === entry.dispatch.taskId.value,
      );
      assert.equal(matches.length, 1, 'Task must have one committed identity');
      const identity = matches[0]!;

      assert.equal(identity.scope.organId.value, 'two-top-native');
      assert.equal(identity.scope.taskId.value, entry.dispatch.taskId.value);

      const revisions = await plans.list(identity.scope);
      const accepted = await currentStates.read(identity.scope);
      if (accepted.state === 'unknown') {
        throw new Error(`unknown Runtime current state: ${accepted.reason}`);
      }
      const currentPlan = accepted.value.currentPlan;
      if (currentPlan === undefined) {
        throw new Error(`missing Runtime-accepted plan for ${entry.spec.title}`);
      }

      const selected = await readCurrentTaskPlan({
        plans,
        identity,
        currentPlan,
      });
      const plan = revisions.find(
        (revision) => revision.revisionId === selected.revision.revisionId,
      );
      if (plan === undefined) throw new Error(`missing current Planner revision for ${entry.spec.title}`);
      const planText = JSON.stringify(plan.snapshot);
      assert.ok(planText.includes(entry.spec.deliveryText));
      for (const other of others) {
        assert.equal(planText.includes(other.deliveryText), false);
      }
      const checkpoint = dashboard.checkpoint;
      if (checkpoint === undefined) throw new Error(`missing checkpoint for ${entry.spec.title}`);
      checkpointIds.push(checkpoint.checkpointId);
      assert.equal(requireText(requireRecord(requireRecord(ownPlanner.payload.closure, 'Planner closure').checkpointId,
        'Planner checkpoint ID').value,
        'Planner checkpoint'), checkpoint.checkpointId);
      const plannerTaskId = requireRecord(requireRecord(ownPlanner.payload.task, 'Planner task').taskId, 'Planner task ID');
      assert.equal(plannerTaskId.value, entry.dispatch.taskId.value);
    }
    assert.equal(new Set(checkpointIds).size, prepared.length);

    console.log(JSON.stringify({
      taskIds: prepared.map((entry) => entry.dispatch.taskId.value),
      operationIds: prepared.map((entry) => entry.dispatch.operationId!.value),
      executionInitials: executionInitials.length,
      maxActiveExecutionInitials,
      plannerRequests: plannerRequests.length,
      deliveryTexts: prepared.map((entry) => entry.spec.deliveryText),
      runtimeIds: barrierRuntimeIds,
      thirdCapacity: thirdCapacityObservation,
    }));
    passed = true;
  } finally {
    releaseAllExecutionGates();
    if (runtime !== undefined && accessControl !== undefined && cookie !== undefined) {
      for (const [index, entry] of prepared.entries()) {
        if (passed || entry.grantRevision === undefined) continue;
        try {
          const controlPath = `${runtime.server.url}/api/tasks/${entry.dispatch.taskId.value}/control`;
          await fetch(`${controlPath}/revoke`, { method: 'POST',
            headers: { cookie, origin: runtime.server.url, 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: `two-top-cleanup-revoke-${index}`, expectedRevision: entry.grantRevision }) });
        } catch {
          // Preserve the primary test failure; runtime close still owns settlement.
        }
      }
    }
    try {
      let runtimeCloseFailure: unknown;
      let orchestrationDisposeFailure: unknown;
      try {
        await runtime?.close();
      } catch (error) {
        runtimeCloseFailure = error;
      }
      try {
        await orchestration?.dispose();
      } catch (error) {
        orchestrationDisposeFailure = error;
      }
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await Promise.allSettled([...requestTasks]);
      if (runtimeCloseFailure !== undefined) throw runtimeCloseFailure;
      if (orchestrationDisposeFailure !== undefined) throw orchestrationDisposeFailure;
    } finally {
      provider.closeIdleConnections?.();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      if (passed) await rm(root, { recursive: true, force: true });
      else console.log(JSON.stringify({ retainedFixture: root, runtimeReturned: runtime !== undefined,
        preparedTaskIds: prepared.map((entry) => entry.dispatch.taskId.value),
        executionInitials: executionInitials.length, plannerRequests: plannerRequests.length }));
    }
  }
});

test('typed final FIFO establishes exact TaskIdentity before execution and preserves write-failure retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-final-source-'));
  try {
    const organId = id('organ', 'typed-source-consumer');
    const binding: ProviderBinding = { bindingId: 'source-consumer', providerId: 'source-consumer',
      protocol: 'responses', endpointRef: 'fixture:source', modelRef: 'fixture:source',
      configDigest: 'fixture:source', capabilityDigest: 'fixture:source' };
    const journal = new UiRuntimeJournal(join(root, 'runtime.jsonl'));
    const identityJournal = new JsonlTaskIdentityJournal(new JsonlOrganJournal(join(root, 'control.jsonl')));
    let failAppend = true;
    const taskIdentity = new TaskIdentityConsumer({
      replay: (scope) => identityJournal.replay(scope),
      append: (input) => failAppend ? Promise.reject(new Error('controlled identity append failed')) : identityJournal.append(input),
    });
    let admissions = 0;
    let factories = 0;
    const serviceOptions: ConstructorParameters<typeof UiRuntimeService>[0] = {
      mode: 'fake', organId, binding, port: new FakeReplayExecutionRuntimePort({ binding }),
      providerState: 'ready', journal, closurePort: journal, taskIdentity,
      checkpointStoreFor: () => new FileCheckpointStore(join(root, 'checkpoint.jsonl')),
      attentionPort: {
        async publish(input) { return { attentionId: input.attentionId, delivered: true }; },
        async resolve(input) { return { attentionId: input.attentionId, delivered: true }; },
      },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'typed-source', roleId: 'execution' },
      explicitBrainInterpreter: { async interpret() { return { kind: 'requirement', intent: 'create',
        normalizedInput: 'deliver the controlled task', proposal: 'deliver the controlled task', knownFacts: [], decisionRefs: [],
        structuredProposal: { revision: 1, intent: 'create', title: 'Controlled source task', objective: 'deliver the controlled task',
          deliverable: 'controlled task result', deliveryConditions: ['deliver the controlled task'], evidenceRefs: [], blockingGaps: [] } }; } },
      runtimeComposition: { createExecutionPorts: () => ({
        admitExecution: async () => { admissions += 1; throw new Error('controlled missing grant'); },
        createDriver: async () => { factories += 1; throw new Error('unexpected execution factory'); },
      }) },
    };
    const service = new UiRuntimeService(serviceOptions);
    const interactionId = await service.receiveExplicitInput({ sourceRef: 'ui:new-task-create',
      rawInput: 'deliver the controlled task', channel: 'business', requestKind: 'new-task-preview' });
    await service.interpretExplicitInput({ interactionId });
    const preview = await service.inspectExplicitInteraction(interactionId);
    assert.ok(preview.draft);
    assert.ok(preview.revision);
    const confirmation: Parameters<UiRuntimeService['confirmExplicitRequirement']>[0] = { interactionId, draftId: preview.draft!.draftId,
      inputRevision: preview.draft!.inputRevision, confirmationRef: 'confirmation:source-consumer',
      confirmedBy: 'human:operator', confirmedAt: '2026-10-17T00:00:00.000Z',
      payloadRef: 'asset://source-consumer', requestKind: 'new-task-create' };
    const receipt = await service.confirmExplicitRequirement(confirmation);
    const alias = await service.confirmExplicitRequirement({ ...confirmation, idempotencyKey: 'source-consumer-alias' });
    assert.equal(alias.requirement.requirementId, receipt.requirement.requirementId);
    await assert.rejects(() => service.dispatchNextExplicitRequirement(), /controlled identity append failed/);
    assert.equal(admissions, 0, 'failed identity append must precede all execution preparation');
    assert.equal(factories, 0);
    assert.equal(service.listTasks().counts.total, 1);
    const taskId = service.listTasks().draft[0]!.taskId;
    assert.equal(await taskIdentity.read({ organId, taskId }), undefined);
    const persisted = journal.replay().filter((record) => record.kind === 'explicit-brain.state').at(-1)!;
    if (persisted.kind !== 'explicit-brain.state') throw new Error('missing actual explicit state');
    const state = persisted.state as typeof persisted.state & { readonly finalSubmissions: readonly PersistedFinalSubmitReceipt[] };
    for (const mismatch of ['fifoSeq', 'payloadRef', 'missing'] as const) {
      const mismatchedState = {
        ...state,
        finalSubmissions: mismatch === 'missing' ? [] : state.finalSubmissions.map((entry) => ({ ...entry,
          requirement: { ...entry.requirement,
            ...(mismatch === 'fifoSeq' ? { fifoSeq: entry.requirement.fifoSeq + 1 } : { payloadRef: 'asset://wrong-source' }),
          },
        })),
      };
      journal.append({ kind: 'explicit-brain.state', state: mismatchedState });
      const cold = new UiRuntimeService(serviceOptions);
      await cold.hydrate();
      await assert.rejects(() => cold.dispatchNextExplicitRequirement(), /no exact typed final-submit source/);
      assert.equal(admissions, 0, 'source mismatch must not prepare/release or acknowledge the pending requirement');
      assert.equal(factories, 0);
      await cold.quiesceImplicitConsumption();
      journal.append(persisted);
    }
    const conflictingIdentity = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(new JsonlOrganJournal(join(root, 'conflict-control.jsonl'))));
    await conflictingIdentity.establish({ scope: { organId, taskId }, source: {
      requirementId: receipt.requirement.requirementId, draftId: receipt.requirement.draftId,
      inputRevision: receipt.requirement.inputRevision, draftRevisionVersion: preview.revision!.revisionVersion,
      draftRevisionHash: preview.revision!.revisionHash, confirmationRef: 'confirmation:another-source',
    } });
    const conflict = new UiRuntimeService({ ...serviceOptions, taskIdentity: conflictingIdentity });
    await conflict.hydrate();
    await assert.rejects(() => conflict.dispatchNextExplicitRequirement(), /conflict|different|immutable/i);
    assert.equal(admissions, 0);
    assert.equal(factories, 0);
    await conflict.quiesceImplicitConsumption();
    journal.append(persisted);
    failAppend = false;
     await assert.rejects(() => service.dispatchNextExplicitRequirement(), /controlled missing grant/);
     assert.equal(service.taskDetail(taskId).taskId.value, taskId.value, 'retry must retain the actual Task');
     assert.equal(service.listTasks().counts.total, 1, 'retry must not create another Task');
    const identity = await taskIdentity.read({ organId, taskId });
    assert.deepEqual(identity?.source, {
      requirementId: receipt.requirement.requirementId, draftId: receipt.requirement.draftId,
      inputRevision: receipt.requirement.inputRevision, draftRevisionVersion: preview.revision!.revisionVersion,
      draftRevisionHash: preview.revision!.revisionHash, confirmationRef: 'confirmation:source-consumer',
    });
    assert.equal(factories, 0, 'missing grant must not reach the target execution factory');
    assert.equal(admissions, 1, 'same coordinator must reach the injected execution admission');
    console.log(JSON.stringify({ receipt, taskId, source: identity?.source, factories, admissions }));
    await service.quiesceImplicitConsumption();
  } finally { await rm(root, { recursive: true, force: true }); }
});

function digest(args: Readonly<Record<string, unknown>>): string {
  const stable = JSON.stringify(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${createHash('sha256').update(stable).digest('hex')}`;
}

function requirePresent<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${label}`);
  return value;
}

async function runWorkspaceSearch(root: string, query: string, limit: number, scopeRef = 'scope:workspace:project-a') {
  const runtime = createExplicitBrainRuntime({
    workspaceRoot: await realpath(root),
    projectKey: 'project-a',
    traces: new DecisionTraceStore(),
  });
  const args = { scopeRef, query, limit };
  const [result] = await runtime.execute({
    decisionId: `decision:search-${query}-${limit}`,
    interactionId: `interaction:search-${query}-${limit}`,
    kind: 'intent',
    selectedAction: 'answer',
    summary: 'search the bound workspace',
    evidenceRefs: [],
    toolIntents: [{
      toolIntentId: `intent:search-${query}-${limit}`,
      toolRef: 'file.search',
      arguments: args,
      argumentsDigest: digest(args),
      reasonRefs: [],
      selectedBecause: 'workspace evidence is required',
    }],
  });
  return result as { readonly query: string; readonly matches: readonly { readonly path: string; readonly lines: readonly number[] }[]; readonly complete: boolean };
}

test('application explicit brain runtime reports whether file.search exhausted discovered candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-search-'));
  try {
    await writeFile(join(root, 'a-hit.txt'), 'needle\n', 'utf8');
    await writeFile(join(root, 'b-unscanned.txt'), 'other\n', 'utf8');
    const limited = await runWorkspaceSearch(root, 'needle', 1);
    assert.deepEqual(limited.matches, [{ path: 'a-hit.txt', lines: [1] }]);
    assert.equal(limited.complete, false);

    const fullScan = await runWorkspaceSearch(root, 'absent', 2);
    assert.deepEqual(fullScan.matches, []);
    assert.equal(fullScan.complete, true);

    await writeFile(join(root, 'c-last-hit.txt'), 'last-hit\n', 'utf8');
    const lastCandidate = await runWorkspaceSearch(root, 'last-hit', 1);
    assert.deepEqual(lastCandidate.matches, [{ path: 'c-last-hit.txt', lines: [1] }]);
    assert.equal(lastCandidate.complete, true);

    await assert.rejects(
      () => runWorkspaceSearch(root, 'needle', 1, 'scope:workspace:other-project'),
      /workspace scope is not registered/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application explicit brain runtime does not call an incomplete discovery complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-search-incomplete-'));
  try {
    await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(root, `${index.toString().padStart(3, '0')}.txt`), 'absent\n', 'utf8')));
    const result = await runWorkspaceSearch(root, 'needle', 1);
    assert.deepEqual(result.matches, []);
    assert.equal(result.complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application explicit brain runtime preserves file.search read failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-search-read-failure-'));
  const unreadableFile = join(root, 'unreadable.txt');
  try {
    await writeFile(unreadableFile, 'needle\n', 'utf8');
    await chmod(unreadableFile, 0o000);
    await assert.rejects(() => runWorkspaceSearch(root, 'needle', 1), /read-failed|permission denied|EACCES/i);
  } finally {
    await chmod(unreadableFile, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('application explicit brain runtime dispatches a read-only workspace tool through its real owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'README.md'), 'checkpoint owner\n', 'utf8');
  const workspaceRoot = await realpath(root);
  const runtime = createExplicitBrainRuntime({
    workspaceRoot,
    projectKey: 'project-a',
    traces: new DecisionTraceStore(),
  });
  const args = { scopeRef: 'scope:workspace:project-a', pathRef: 'src/README.md' };
  const [result] = await runtime.execute({
    decisionId: 'decision:app-runtime',
    interactionId: 'interaction:app-runtime',
    kind: 'intent',
    selectedAction: 'answer',
    summary: 'read the workspace evidence',
    evidenceRefs: [],
    toolIntents: [{
      toolIntentId: 'intent:file-read',
      toolRef: 'file.read',
      arguments: args,
      argumentsDigest: digest(args),
      reasonRefs: [],
      selectedBecause: 'workspace evidence is required',
    }],
  });
  assert.deepEqual(result, { path: 'src/README.md', content: 'checkpoint owner\n' });
});

test('application explicit brain runtime rejects a workspace scope outside its binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-scope-'));
  const runtime = createExplicitBrainRuntime({ workspaceRoot: await realpath(root), projectKey: 'project-a', traces: new DecisionTraceStore() });
  const args = { scopeRef: 'scope:workspace:other-project', pathRef: 'README.md' };
  await assert.rejects(
    () => runtime.execute({
      decisionId: 'decision:app-runtime-scope',
      interactionId: 'interaction:app-runtime-scope',
      kind: 'intent',
      selectedAction: 'answer',
      summary: 'read outside the workspace binding',
      evidenceRefs: [],
      toolIntents: [{
        toolIntentId: 'intent:file-read-scope',
        toolRef: 'file.read',
        arguments: args,
        argumentsDigest: digest(args),
        reasonRefs: [],
        selectedBecause: 'test',
      }],
    }),
    /workspace scope is not registered/,
  );
});

test('application explicit brain runtime lists a path within its registered workspace scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-list-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'README.md'), 'workspace list\n', 'utf8');
  const runtime = createExplicitBrainRuntime({
    workspaceRoot: await realpath(root),
    projectKey: 'project-a',
    traces: new DecisionTraceStore(),
  });
  const args = { scopeRef: 'scope:workspace:project-a', pathRef: 'src' };
  const [result] = await runtime.execute({
    decisionId: 'decision:app-runtime-list',
    interactionId: 'interaction:app-runtime-list',
    kind: 'intent',
    selectedAction: 'answer',
    summary: 'list workspace evidence',
    evidenceRefs: [],
    toolIntents: [{
      toolIntentId: 'intent:workspace-list',
      toolRef: 'workspace.list',
      arguments: args,
      argumentsDigest: digest(args),
      reasonRefs: [],
      selectedBecause: 'workspace evidence is required',
    }],
  });
  assert.deepEqual(
    {
      paths: (result as { readonly paths: readonly string[] }).paths,
      complete: (result as { readonly complete: boolean }).complete,
    },
    { paths: ['src/README.md'], complete: true },
  );
});

test('application explicit brain runtime requires registered agent identity and preserves decision traces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-agent-'));
  const persisted: import('../../packages/contracts/src/index.js').DecisionTraceRecord[] = [];
  const traces = new DecisionTraceJournal({
    load: () => persisted,
    persist: (record) => persisted.push(record),
  });
  const queried: Array<{ readonly agentRef: string; readonly scopeRef: string }> = [];
  const runtime = createExplicitBrainRuntime({
    workspaceRoot: await realpath(root),
    projectKey: 'project-a',
    traces,
    agentTargets: [{
      agentRef: 'agent:orchestration-a',
      scopeRef: 'scope:task-a',
      queryable: true,
      messageClasses: ['control'],
    }],
    queryAgent: async (input) => {
      queried.push(input);
      return { state: 'idle' };
    },
    sendAgentMessage: async (input) => ({ delivered: input.recipientRef }),
  });
  const args = { agentRef: 'agent:orchestration-a', scopeRef: 'scope:task-a' };
  const [result] = await runtime.execute({
    decisionId: 'decision:agent-query',
    interactionId: 'interaction:agent-query',
    kind: 'intent',
    selectedAction: 'answer',
    summary: 'query the registered orchestrator',
    evidenceRefs: [],
    toolIntents: [{
      toolIntentId: 'intent:agent-query',
      toolRef: 'agent.query',
      arguments: args,
      argumentsDigest: digest(args),
      reasonRefs: [],
      selectedBecause: 'the registered orchestrator owns task state',
    }],
  });
  assert.deepEqual(result, { state: 'idle' });
  assert.deepEqual(queried, [{ agentRef: 'agent:orchestration-a', scopeRef: 'scope:task-a' }]);
  assert.equal(persisted.length, 1);
  await assert.rejects(
    () => runtime.ports.agent.message({
      binding: runtime.binding,
      recipientRef: 'agent:unknown',
      messageRef: 'message:unknown',
      messageClass: 'control',
    }),
    /agent target is not registered/,
  );

  const recreated = new DecisionTraceJournal({ load: () => persisted, persist: (record) => persisted.push(record) });
  assert.equal(recreated.query({ interactionRef: 'interaction:agent-query' }).length, 1);
  await assert.rejects(
    () => runtime.execute({
      decisionId: 'decision:unknown-agent',
      interactionId: 'interaction:unknown-agent',
      kind: 'intent',
      selectedAction: 'answer',
      summary: 'query an unregistered agent',
      evidenceRefs: [],
      toolIntents: [{
        toolIntentId: 'intent:unknown-agent',
        toolRef: 'agent.query',
        arguments: { agentRef: 'agent:unknown' },
        argumentsDigest: digest({ agentRef: 'agent:unknown' }),
        reasonRefs: [],
        selectedBecause: 'test',
      }],
    }),
    /agent target is not registered/,
  );
});

test('provider explicit brain interpreter loads the interaction template and validates typed intake output', async () => {
  const binding: ProviderBinding = {
    bindingId: 'binding-explicit-interpret',
    providerId: 'provider-explicit-interpret',
    protocol: 'responses',
    endpointRef: 'fake://explicit-interpret',
    modelRef: 'model-explicit-interpret',
    configDigest: 'sha256:explicit-interpret-config',
    capabilityDigest: 'sha256:explicit-interpret-capability',
  };
  const options = {
    ...parentDependencies(),
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new RecordedParentPort({
      binding,
      stepDelayMs: 0,
      replay: [
        {
          kind: 'output',
          state: 'output',
          summary: JSON.stringify({
            kind: 'requirement',
            normalizedInput: '整理启动步骤',
            knownFacts: ['README exists'],
            proposal: {
              revision: 1,
              intent: 'create',
              title: '整理启动步骤',
              objective: '整理项目启动步骤',
              deliverable: '可执行的启动步骤清单',
              deliveryConditions: ['启动步骤完整并有证据'],
              evidenceRefs: ['README'],
              blockingGaps: [],
            },
            decisionRefs: ['decision:provider-test'],
          }),
        },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ],
    }),
  };

  // Confirmed shared-pair gap; probability unknown, wrong source/model has high
  // impact. Extend this consumer with one local selected wire, not a matrix.
  const posts: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.method === 'POST') posts.push(Buffer.concat(chunks).toString('utf8'));
      const requestNumber = posts.length;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { type: 'response.created', response: { id: `selected-${posts.length}` } },
        { type: 'response.output_text.done', item_id: 'message-final', text: JSON.stringify({
          kind: 'requirement', normalizedInput: '整理启动步骤', knownFacts: ['README exists'],
          ...(requestNumber === 1 ? { taskFlowKind: 'one-shot' } : {}),
          proposal: {
            revision: 1, intent: 'create', title: '整理启动步骤', objective: '整理项目启动步骤',
            deliverable: '可执行的启动步骤清单',
            deliveryConditions: ['启动步骤完整并有证据'], evidenceRefs: ['README'], blockingGaps: [],
          }, decisionRefs: ['decision:provider-test'],
        }) },
        { type: 'response.completed', response: { id: `selected-${posts.length}` } },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    })().catch((error: unknown) => { response.writeHead(500); response.end(String(error)); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing socket address');
  await mkdir(parentFixtureRoot, { recursive: true });
  const root = await mkdtemp(join(parentFixtureRoot, 'interaction-selected-'));
  const entries: EffectiveAgentProviderBinding[] = [{
    agentId: 'configured-interaction', roleId: 'interaction', source: 'agent',
    provider: { source: 'http', provider: 'http', binding: 'selected-interaction', protocol: 'responses',
      model: 'selected.interaction.model', route: 'selected-route', baseUrl: `http://127.0.0.1:${address.port}` },
  }];
  const compositions: AgentProviderComposition<InteractionParentProviderExecutionIdentityRef>[] = [];
  const lifecycle: string[] = [];
  const starts: Parameters<AgentProviderComposition<InteractionParentProviderExecutionIdentityRef>['port']['start']>[0][] = [];
  const observations: Parameters<AgentProviderComposition<InteractionParentProviderExecutionIdentityRef>['port']['observe']>[0][] = [];
  let borrowedStarts = 0;
  const appendError = new Error('semantic checkpoint append rejected');
  let rejectCheckpoint = true;
  const primaryStart = options.port.start.bind(options.port);
  options.port.start = async (request) => { borrowedStarts += 1; return primaryStart(request); };
  const selectedOptions = {
    ...options,
    checkpointJournal: {
      readSemanticCheckpointExact: (turn: Parameters<typeof options.checkpointJournal.readSemanticCheckpointExact>[0]) => options.checkpointJournal.readSemanticCheckpointExact(turn),
      readScopeSemanticCheckpoints: (scope: Parameters<typeof options.checkpointJournal.readScopeSemanticCheckpoints>[0]) => options.checkpointJournal.readScopeSemanticCheckpoints(scope),
      appendSemanticCheckpoint: async (checkpoint: Parameters<typeof options.checkpointJournal.appendSemanticCheckpoint>[0]) => {
        assert.ok(lifecycle.includes(`${compositions.length - 1}:closed`), 'physical parent close must precede semantic append');
        if (rejectCheckpoint) { rejectCheckpoint = false; throw appendError; }
        return options.checkpointJournal.appendSemanticCheckpoint(checkpoint);
      },
    },
    prepareAgentProvider: async (selection: { readonly roleId: AgentRole; readonly configuredAgentId?: string }) => {
      assert.deepEqual(selection, { roleId: 'interaction' });
      const own = await prepareAgentProvider<InteractionParentProviderExecutionIdentityRef>({ ...selection, agentProviderBindings: entries, evidenceRoot: join(parentFixtureRoot, 'assets') });
      assert.equal(own.configuredAgentId, 'configured-interaction');
      assert.equal(own.source, 'http');
      assert.equal(own.binding.modelRef, 'selected.interaction.model');
      const index = compositions.length;
      compositions.push(own);
      const start = own.port.start.bind(own.port);
      const settle = own.port.settle.bind(own.port);
      const close = own.port.close.bind(own.port);
      const observe = own.port.observe.bind(own.port);
      own.port.start = async (request) => { starts.push(request); return start(request); };
      own.port.observe = (request) => { observations.push(request); return observe(request); };
      own.port.settle = async (request) => {
        assert.equal(request.runtimeId, starts[index].runtimeId);
        const receipt = await settle(request); lifecycle.push(`${index}:settled`); return receipt;
      };
      own.port.close = async (binding) => {
        assert.equal(binding, own.binding);
        const receipt = await close(binding); lifecycle.push(`${index}:closed`); return receipt;
      };
      return own;
    },
  };
  const interpreter = createProviderExplicitBrainInterpreter(selectedOptions);

  try {

  const firstInput = {
    interactionId: 'interaction-provider-test',
    inputRevision: 1,
    sourceRef: 'ui:new-task',
    rawInput: '帮我整理启动步骤',
    clarifications: [],
    taskCandidates: [],
  };
  // Confirmed missing closure wiring; impact is duplicated generation and lost
  // recovery responsibility. Cost: one rejected append and a no-generation retry.
  await assert.rejects(() => interpreter.interpret(firstInput), (error: unknown) => error === appendError);
  const pending = (await options.parentJournal.readScopeOpenedTurns(options))[0].fact;
  const durable = await options.parentJournal.readTurnSnapshot(pending.turn);
  assert.ok(durable.turnInput); assert.ok(durable.requests.length > 0); assert.ok(durable.acceptedFacts.length > 0);
  assert.equal(await options.checkpointJournal.readSemanticCheckpointExact(pending.turn), null);
  await assert.rejects(() => interpreter.interpret({ ...firstInput, rawInput: 'different next input' }),
    (error: unknown) => error instanceof Error && error.message.includes(pending.turn.turnId) && error.message.includes('exact prior input'));
  assert.equal(compositions.length, 1); assert.equal(starts.length, 1); assert.equal(posts.length, 1);
  const result = await interpreter.interpret(firstInput);
  assert.equal(compositions.length, 1); assert.equal(starts.length, 1); assert.equal(posts.length, 1);
  const committed = await options.checkpointJournal.readSemanticCheckpointExact(pending.turn);
  assert.ok(committed);
  if (committed === null) throw new Error('missing semantic commit');
  const semantic = committed.checkpoint.claims.map((claim) => claim.fact).join('\n');
  assert.ok(semantic.includes('整理项目启动步骤')); assert.ok(semantic.includes('可执行的启动步骤清单'));
  assert.ok(committed.checkpoint.constraints.some((claim) => claim.fact.includes('启动步骤完整并有证据')));

  assert.equal(result.kind, 'requirement');
  if (result.kind !== 'requirement') throw new Error('expected requirement interpretation');
  assert.equal(result.normalizedInput, '整理启动步骤');
  assert.equal(result.intent, 'create');
  // Missing structured output loses the semantic producer's validated fields.
  // Impact: raw JSON history or no closure. Cost: extend this real consumer.
  assert.ok('structuredProposal' in result);
  assert.deepEqual(Reflect.get(result, 'structuredProposal'), {
    revision: 1, intent: 'create', title: '整理启动步骤', objective: '整理项目启动步骤',
    deliverable: '可执行的启动步骤清单', deliveryConditions: ['启动步骤完整并有证据'],
    evidenceRefs: ['README'], blockingGaps: [],
  });
  // Missing model task-flow parsing drops the only semantic classification
  // input. Impact: service must keep a human selector or invent a default.
  // Cost: one existing recorded requirement response has no extra harness.
  assert.deepEqual(Reflect.get(result, 'taskFlow'), { kind: 'one-shot', definitionVersion: 1 });
  assert.match(result.proposal, /可执行的启动步骤清单/);
  assert.equal(result.proposal.includes('awaiting-user-confirmation'), false);
  assert.equal(compositions.length, 1, 'selected interaction callback must run');
  assert.deepEqual(lifecycle, ['0:settled', '0:closed']);
  const secondResult = await interpreter.interpret({ interactionId: 'interaction-provider-second', inputRevision: 1,
    sourceRef: 'ui:second', rawInput: '第二次独立输入', clarifications: [], taskCandidates: [] });
  // Historical model output has no kind and must remain honestly unclassified.
  assert.equal(Reflect.get(secondResult, 'taskFlow'), undefined);
  assert.equal(compositions.length, 2);
  assert.ok(compositions[0].port !== compositions[1].port);
  assert.ok(starts[0].runtimeId !== starts[1].runtimeId);
  // Existing wire creates a synthetic Task for a parent interaction. This
  // counterexample costs two local requests and detects identity contamination.
  assert.equal('taskId' in starts[0], false, 'interaction parent must not fabricate a Task');
  assert.equal('helper' in starts[0], false, 'interaction parent must not use helper identity');
  assert.ok(observations[0].requestId !== undefined);
  assert.ok(observations[1].requestId !== undefined);
  assert.ok(observations[0].requestId !== observations[1].requestId);
  assert.ok(observations[0].turnId !== observations[1].turnId);
  assert.deepEqual(starts.map((start) => start.inputRefs), [
    ['humanagent://interaction/interaction-provider-test/revision/1'],
    ['humanagent://interaction/interaction-provider-second/revision/1'],
  ]);
  assert.equal(borrowedStarts, 0);
  assert.equal(posts.length, 2);
  for (const body of posts) assert.equal(JSON.parse(body).model, 'selected.interaction.model');
  // The bounded intake wire carries the verified identity and control-boundary
  // segments plus one flat intake contract, and none of the full-role segments
  // that require a nested decision envelope, selected actions, or typed tool
  // intents. These assertions are RED under the previous full-segment assembly.
  const wire = JSON.parse(posts[0]) as {
    readonly instructions: string;
  };
  const secondWire = JSON.parse(posts[1]) as {
    readonly input: readonly {
      readonly type: string;
      readonly role?: string;
      readonly content?: readonly { readonly type: string; readonly text: string }[];
    }[];
  };
  const priorCheckpoint = JSON.parse(secondWire.input[0]?.content?.[0]?.text ?? '') as {
    readonly kind: string;
    readonly interactionId: string;
    readonly inputRevision: number;
    readonly turnId: string;
    readonly committedAt: string;
    readonly claims: readonly { readonly fact: string }[];
    readonly constraints: readonly { readonly fact: string }[];
  };
  assert.equal(secondWire.input[0]?.type, 'message');
  assert.equal(secondWire.input[0]?.role, 'assistant');
  assert.equal(priorCheckpoint.kind, committed.checkpoint.kind);
  assert.equal(priorCheckpoint.interactionId, 'interaction-provider-test');
  assert.equal(priorCheckpoint.inputRevision, 1);
  assert.equal(priorCheckpoint.turnId, committed.checkpoint.turnId);
  assert.equal(priorCheckpoint.committedAt, committed.checkpoint.committedAt);
  assert.deepEqual(priorCheckpoint.claims, committed.checkpoint.claims);
  assert.deepEqual(priorCheckpoint.constraints, committed.checkpoint.constraints);
  assert.ok(priorCheckpoint.claims.some((claim) => claim.fact.startsWith('goal: ')));
  assert.ok(priorCheckpoint.claims.some((claim) => claim.fact.startsWith('what-done(parent): ')));
  assert.ok(priorCheckpoint.claims.some((claim) => claim.fact.startsWith('outcome(requirement:create): ')));
  assert.ok(priorCheckpoint.claims.some((claim) => claim.fact.startsWith('next: ')));
  const sentPrompt = wire.instructions;
  assert.ok(sentPrompt.includes('# Control Boundaries'));
  assert.ok(sentPrompt.includes('# Explicit Brain'));
  assert.ok(sentPrompt.includes('# Explicit intake decision output'));
  assert.ok(sentPrompt.includes('taskFlowKind'));
  assert.ok(sentPrompt.includes('Omit taskFlowKind only when the task shape is genuinely ambiguous'));
  assert.ok(sentPrompt.includes('semantic task shape only'));
  assert.equal(sentPrompt.includes('executionMode'), false);
  assert.equal(sentPrompt.includes('schedule'), false);
  for (const field of ['blockingGaps', 'deliverable', 'deliveryConditions', 'evidenceRefs', 'intent', 'objective', 'revision', 'title']) {
    assert.ok(sentPrompt.includes(`"${field}"`), `intake proposal contract must include ${field}`);
  }
  for (const absent of ['structured decision', 'selected action', 'needsUserInput', 'needsToolResult',
    'typed Tool Intents', 'Call `requirement.submit` only after', 'requiresUserConfirmation',
    'confirmationPrompt', 'awaiting-user-confirmation']) {
    assert.equal(sentPrompt.includes(absent), false, `intake prompt must not carry conflicting instruction: ${absent}`);
  }
  assert.ok(posts[0].includes('帮我整理启动步骤'));
  assert.ok(posts[1].includes('第二次独立输入'));
  assert.ok(posts[1].includes('ui:second'));
  assert.equal(posts[1].includes('帮我整理启动步骤'), false);
  assert.deepEqual(lifecycle, ['0:settled', '0:closed', '1:settled', '1:closed']);
  // A failed durable initial-input commit must prevent the external start.
  // Existing missing durability is the failure basis; impact is an orphaned
  // parent request. Cost: one rejected commit and no network request.
  const inputCommitError = new Error('initial input commit rejected');
  const commitBlocked = createProviderExplicitBrainInterpreter({ ...selectedOptions,
    parentJournal: {
      ...selectedOptions.parentJournal,
      transactTurn: async () => { throw inputCommitError; },
      readTurnSnapshot: (turn) => selectedOptions.parentJournal.readTurnSnapshot(turn),
      readScopeOpenedTurns: (scope) => selectedOptions.parentJournal.readScopeOpenedTurns(scope),
      readScopeAbandonedTurns: (scope) => selectedOptions.parentJournal.readScopeAbandonedTurns(scope),
      readScopeParseFailures: (scope) => selectedOptions.parentJournal.readScopeParseFailures(scope),
      readScopeExecutionFailures: (scope) => selectedOptions.parentJournal.readScopeExecutionFailures(scope),
    },
  });
  await assert.rejects(() => commitBlocked.interpret({ interactionId: 'blocked-input', inputRevision: 1,
    sourceRef: 'ui:blocked', rawInput: 'must not start', clarifications: [], taskCandidates: [] }),
  (error: unknown) => error === inputCommitError);
  assert.equal(starts.length, 2);
  assert.equal(posts.length, 2);
  assert.deepEqual(lifecycle, ['0:settled', '0:closed', '1:settled', '1:closed', '2:closed']);
  } finally {
    server.closeIdleConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(server.address(), null);
    await rm(root, { recursive: true, force: true });
    await assert.rejects(() => realpath(root), /ENOENT/);
  }

  const malformedOptions = {
    ...parentDependencies(),
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new RecordedParentPort({
      binding,
      stepDelayMs: 0,
      replay: [
        {
          kind: 'output',
          state: 'output',
          summary: JSON.stringify({
            kind: 'requirement',
            normalizedInput: '整理启动步骤',
            knownFacts: [],
            proposal: { objective: '未经过 typed contract 的任意对象' },
            decisionRefs: [],
          }),
        },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ],
    }),
  };
  const malformedLifecycle: string[] = [];
  const malformedSettle = malformedOptions.port.settle.bind(malformedOptions.port);
  const malformedClose = malformedOptions.port.close.bind(malformedOptions.port);
  malformedOptions.port.settle = async (request) => {
    malformedLifecycle.push('settle');
    return malformedSettle(request);
  };
  malformedOptions.port.close = async (binding) => {
    assert.equal(binding, malformedOptions.binding);
    malformedLifecycle.push('close');
    return malformedClose(binding);
  };
  const freshMalformedInterpreter = () => createProviderExplicitBrainInterpreter({
    ...malformedOptions, ...parentDependencies(),
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
      provider: entries[0].provider!, binding, port: malformedOptions.port }),
  });
  let arbitraryProposal = freshMalformedInterpreter();
  const malformedInput = {
    interactionId: 'interaction-arbitrary-proposal', inputRevision: 1, sourceRef: 'ui:new-task',
    rawInput: '帮我整理启动步骤', clarifications: [], taskCandidates: [],
  };
  await assert.rejects(
    () => arbitraryProposal.interpret(malformedInput),
    /does not match the structured proposal contract/,
  );
  assert.deepEqual(malformedLifecycle, ['settle', 'close']);

  // Driver.submit reaches start, not port.submit. An unaccepted request has
  // no invented settlement; original request and cleanup errors stay intact.
  const originalStart = malformedOptions.port.start.bind(malformedOptions.port);
  const startError = new Error('actual start rejection');
  const closeError = new Error('owned close rejection');
  malformedLifecycle.length = 0;
  malformedOptions.port.start = async () => { malformedLifecycle.push('start'); throw startError; };
  malformedOptions.port.close = async () => { malformedLifecycle.push('close'); throw closeError; };
  arbitraryProposal = freshMalformedInterpreter();
  await assert.rejects(() => arbitraryProposal.interpret(malformedInput), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    assert.equal(error.errors[0], startError);
    assert.equal(error.errors[1], closeError);
    return true;
  });
  assert.deepEqual(malformedLifecycle, ['start', 'close']);

  // Fail observation after accepted start, with a real terminal fake session
  // available to settle. One required settle precedes the owned close.
  malformedOptions.port.start = originalStart;
  const originalObserve = malformedOptions.port.observe.bind(malformedOptions.port);
  const observationError = new Error('observation rejection');
  malformedOptions.port.observe = async function* (request) {
    for await (const event of originalObserve(request)) {
      if (event.terminalState !== undefined) throw observationError;
      yield event;
    }
  };
  malformedOptions.port.close = async (binding) => {
    malformedLifecycle.push('close'); return malformedClose(binding);
  };
  malformedLifecycle.length = 0;
  arbitraryProposal = freshMalformedInterpreter();
  await assert.rejects(() => arbitraryProposal.interpret(malformedInput), (error: unknown) => error === observationError);
  assert.deepEqual(malformedLifecycle, ['settle', 'close']);

  const settleError = new Error('settlement rejection');
  malformedOptions.port.settle = async (request) => {
    malformedLifecycle.push('settle'); await malformedSettle(request); throw settleError;
  };
  malformedOptions.port.close = async (binding) => {
    malformedLifecycle.push('close'); await malformedClose(binding); throw closeError;
  };
  malformedLifecycle.length = 0;
  arbitraryProposal = freshMalformedInterpreter();
  await assert.rejects(() => arbitraryProposal.interpret(malformedInput), (error: unknown) => {
    if (!(error instanceof AggregateError)) throw error;
    const executionError: unknown = error.errors[0];
    if (!(executionError instanceof AggregateError)) throw executionError;
    assert.equal(executionError.errors[0], observationError);
    assert.equal(executionError.errors[1], settleError);
    assert.equal(error.errors[1], closeError);
    return true;
  });
  assert.deepEqual(malformedLifecycle, ['settle', 'close']);

  // A normal settle rejection is not retried by error cleanup.
  malformedOptions.port.observe = originalObserve;
  malformedLifecycle.length = 0;
  arbitraryProposal = freshMalformedInterpreter();
  await assert.rejects(() => arbitraryProposal.interpret(malformedInput), (error: unknown) => {
    if (!(error instanceof AggregateError)) throw error;
    assert.equal(error.errors[0], settleError);
    assert.equal(error.errors[1], closeError);
    return true;
  });
  assert.deepEqual(malformedLifecycle, ['settle', 'close']);

  // An unknown supplied kind must fail instead of becoming absent or defaulted.
  // Cost: one bounded recorded response; impact: false execution classification.
  const invalidTaskFlowOptions = {
    ...parentDependencies(),
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new RecordedParentPort({
      binding,
      stepDelayMs: 0,
      replay: [
        {
          kind: 'output',
          state: 'output',
          summary: JSON.stringify({
            kind: 'requirement',
            normalizedInput: '检查发布状态',
            knownFacts: [],
            taskFlowKind: 'unknown',
            proposal: {
              revision: 1,
              intent: 'create',
              title: '检查发布状态',
              objective: '检查发布状态',
              deliverable: '发布状态结果',
              deliveryConditions: [],
              evidenceRefs: [],
              blockingGaps: [],
            },
            decisionRefs: [],
          }),
        },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ],
    }),
  };
  await assert.rejects(
    () => createProviderExplicitBrainInterpreter(invalidTaskFlowOptions).interpret({
      interactionId: 'interaction-invalid-task-flow',
      inputRevision: 1,
      sourceRef: 'ui:new-task',
      rawInput: '检查发布状态',
      clarifications: [],
      taskCandidates: [],
    }),
    /taskFlowKind.*one-shot.*inspection.*long-running/,
  );
});

// Failure basis: an interpreter built without supervisor lease authority used to
// discharge any turn whose records merely looked abandoned. The record shape
// cannot prove that the previous execution owner stopped writing, so that path
// froze a possibly live request from another owner and rejected its legal
// appends. Impact: a lost delivered answer with no crash and no evidence.
// Cost: one durable seed and no Provider round. Probability: any embedded
// composition that omits the lease resolver on a scope with an unclosed turn.
// The legitimate crash path keeps its own real termination receipt consumer.
test('provider explicit brain interpreter holds an interrupted turn with no authenticated lifecycle authority', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-interrupted-turn', providerId: 'provider-interrupted-turn', protocol: 'responses',
    endpointRef: 'recorded://interrupted-turn', modelRef: 'model-interrupted-turn',
    configDigest: 'sha256:interrupted-turn-config', capabilityDigest: 'sha256:interrupted-turn-capability',
  };
  const scope = { organId: deps.organId, interactionScopeId: deps.interactionScopeId };
  const crashedInput = JSON.stringify({
    interactionId: 'interaction-crashed', inputRevision: 1, sourceRef: 'ui:crashed',
    rawInput: '请求在崩溃前没有完成的输入', clarifications: [], taskCandidates: [],
  });
  const seeded = await seedInterruptedParentTurn({
    parentJournal: deps.parentJournal, evidence: deps.rawEvidence, rawContent: deps.rawContent,
    binding, scope, interactionId: 'interaction-crashed', turnId: 'explicit-interpret-crashed-1',
    initialInputText: crashedInput,
    executionOwner: { daemonLeaseId: 'lease-crashed', daemonGeneration: 1, processStartToken: 'process-crashed' },
  });
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [
    { kind: 'output', state: 'output', summary: JSON.stringify({
      kind: 'requirement', normalizedInput: '整理新的启动步骤', knownFacts: [],
      proposal: {
        revision: 1, intent: 'create', title: '整理新的启动步骤', objective: '整理新的启动步骤',
        deliverable: '新的启动步骤清单', deliveryConditions: [], evidenceRefs: [], blockingGaps: [],
      },
      decisionRefs: [],
    }) },
    { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
  ] });
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), port,
  });
  const nextRequest = {
    interactionId: 'interaction-next-task', inputRevision: 1, sourceRef: 'ui:new-task',
    rawInput: '整理新的启动步骤', clarifications: [], taskCandidates: [],
  };
  await assert.rejects(
    () => interpreter.interpret(nextRequest),
    (error: unknown) => error instanceof Error
      && error.message.includes('exact prior input')
      && /no authenticated supervisor lease authority/.test(error.message),
  );
  // Nothing was frozen: the unproven turn keeps its recovery responsibility and
  // the refused input never reaches the Provider or opens a fresh turn.
  assert.deepEqual(await deps.parentJournal.readScopeAbandonedTurns(scope), [],
    'a turn shape alone never justifies an abandonment');
  const openedAfter = await deps.parentJournal.readScopeOpenedTurns(scope);
  assert.equal(openedAfter.length, 1, 'a held scope does not open a fresh turn');
  assert.deepEqual(openedAfter[0]!.fact.turn, seeded.turn);
  const heldSnapshot = await deps.parentJournal.readTurnSnapshot(seeded.turn);
  assert.equal(heldSnapshot.abandonment, null, 'the held turn is not abandoned');
  assert.equal(await deps.helperJournal.readSemanticCheckpointExact(seeded.turn), null);
});

// Failure basis: a live Provider stream whose turn is still owned by the current
// active lease used to be discharged by the concurrent-new-input guard, because
// the guard only asked whether a lease existed, never whether the turn's
// execution owner was still alive. Impact: the running request is frozen mid
// stream, its next raw append is rejected after the committed abandonment, and
// the delivered answer is lost even though nothing crashed. Cost: one real
// daemon lease, one durable seed and one recorded Provider request. Probability:
// any scope whose user types again while the previous answer streams.
test('provider explicit brain interpreter refuses to discharge a turn owned by the live lease owner', async () => {
  const root = join(parentFixtureRoot, `live-owner-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-live-owner', providerId: 'provider-live-owner', protocol: 'responses',
    endpointRef: 'recorded://live-owner', modelRef: 'model-live-owner',
    configDigest: 'sha256:live-owner-config', capabilityDigest: 'sha256:live-owner-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:live-owner' };
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    await ensureControlLayout(paths);
    lease = await acquireDaemonLease(paths);
    assert.equal(lease.record.takeover, undefined, 'a live lease has no termination receipt to prove');
    const ownerIdentity = await lease.withCurrentLeaseOwner(async (owner) => owner);
    const liveInput = JSON.stringify({
      interactionId: 'interaction-live-stream', inputRevision: 1, sourceRef: 'ui:live-stream',
      rawInput: '正在进行中的请求', clarifications: [], taskCandidates: [],
    });
    const seeded = await seedInterruptedParentTurn({
      parentJournal, evidence, rawContent, binding, scope,
      interactionId: 'interaction-live-stream', turnId: 'explicit-interpret-live-stream',
      initialInputText: liveInput, executionOwner: ownerIdentity,
    });
    const interpreter = createProviderExplicitBrainInterpreter({
      organId: scope.organId, interactionScopeId: scope.interactionScopeId,
      parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
      rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
      helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
      binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      lease, port: new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [
        { kind: 'output', state: 'output', summary: JSON.stringify({
          kind: 'requirement', normalizedInput: '同时到来的新输入', knownFacts: [],
          proposal: { revision: 1, intent: 'create', title: '同时到来的新输入', objective: '同时到来的新输入',
            deliverable: '结果', deliveryConditions: [], evidenceRefs: [], blockingGaps: [] },
          decisionRefs: [],
        }) },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ] }),
    });
    await assert.rejects(
      () => interpreter.interpret({
        interactionId: 'interaction-live-next', inputRevision: 1, sourceRef: 'ui:live-next',
        rawInput: '同时到来的新输入', clarifications: [], taskCandidates: [],
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes('exact prior input')
        && /still the current active lease owner/.test(error.message),
    );
    // The live turn is untouched: no abandonment, one opened turn, no fresh turn.
    const abandoned = await parentJournal.readScopeAbandonedTurns(scope);
    assert.deepEqual(abandoned, [], 'a live owner is never discharged');
    const opened = await parentJournal.readScopeOpenedTurns(scope);
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0]!.fact.turn, seeded.turn);
    const snapshot = await parentJournal.readTurnSnapshot(seeded.turn);
    assert.equal(snapshot.abandonment, null);

    // A: the original request can still legally finish on the same journal. If
    // the turn had been discharged, this append would be rejected as
    // post-abandonment raw history.
    const execution = { runtimeId: seeded.turn.turnId, organId: scope.organId,
      operationId: id('operation', `op-${seeded.turn.turnId}`), executionEpoch: 1, interactionTurn: seeded.turn };
    const owner = createInteractionParentTurnRawOwner({
      turn: seeded.turn, execution, scope: { organId: scope.organId, operationId: id('operation', `op-${seeded.turn.turnId}`) },
      initialInput: { ref: await evidence.write({
        scope: { organId: scope.organId, operationId: id('operation', `op-${seeded.turn.turnId}`) },
        kind: 'execution', type: 'initial-input', locator: seeded.turn.turnId, content: liveInput,
      }), view: { kind: 'utf8-text' as const } },
      providerBinding: binding, executionOwner: ownerIdentity, journal: parentJournal, rawContent,
    });
    const answerText = JSON.stringify({ kind: 'answer', normalizedInput: '正在进行中的请求', knownFacts: [], answer: '实时请求仍然可以合法结束', decisionRefs: [] });
    const answerScope = { organId: scope.organId, operationId: id('operation', `op-${seeded.turn.turnId}`) };
    await owner.acceptRawFact({
      execution, scope: answerScope, request: seeded.request, producerSeq: 2,
      fact: { kind: 'content', channel: 'assistant-text', update: 'full', contentUnitId: 'live-text',
        content: { ref: await evidence.write({ scope: answerScope, kind: 'execution', type: 'live-text', locator: 'live-text', content: answerText }), view: { kind: 'utf8-text' as const } },
        complete: true },
    });
    await owner.acceptRawFact({
      execution, scope: answerScope, request: seeded.request, producerSeq: 3,
      fact: { kind: 'request-complete', terminal: 'completed' },
    });
    await owner.registerRequest({ execution, record: { request: seeded.request, scope: answerScope, phase: 'settled' } });
    const finalSnapshot = await parentJournal.readTurnSnapshot(seeded.turn);
    assert.equal(finalSnapshot.abandonment, null, 'the live request keeps its full history');
    assert.ok(finalSnapshot.acceptedFacts.some(({ fact }) => fact.envelope.fact.kind === 'request-complete'));
    assert.equal(finalSnapshot.acceptedFacts.some(({ fact }) =>
      fact.envelope.fact.kind === 'content' && fact.envelope.fact.channel === 'assistant-text'), true);
    assert.equal((await parentJournal.readScopeAbandonedTurns(scope)).length, 0);

    // B: a turn whose owner differs from the live owner but has no durable
    // termination receipt is equally unprovable. The live lease here carries no
    // takeover record at all, so the decision must hold instead of guessing.
    const unknownScope = { organId: scope.organId, interactionScopeId: 'runtime:live-unknown-owner' };
    const unknownInput = JSON.stringify({
      interactionId: 'interaction-live-unknown', inputRevision: 1, sourceRef: 'ui:live-unknown',
      rawInput: '未知旧 owner 的纯推理中断', clarifications: [], taskCandidates: [],
    });
    const unknownOwner = { daemonLeaseId: 'lease-never-proven', daemonGeneration: 7, processStartToken: 'process-never-proven' };
    await seedInterruptedParentTurn({
      parentJournal, evidence, rawContent, binding, scope: unknownScope,
      interactionId: 'interaction-live-unknown', turnId: 'explicit-interpret-live-unknown',
      initialInputText: unknownInput, executionOwner: unknownOwner,
    });
    await assert.rejects(
      () => createProviderExplicitBrainInterpreter({
        organId: scope.organId, interactionScopeId: unknownScope.interactionScopeId,
        parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
        rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
        helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
        binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
        lease, port: new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [] }),
      }).interpret({
        interactionId: 'interaction-live-unknown-next', inputRevision: 1, sourceRef: 'ui:live-unknown-next',
        rawInput: '未知旧 owner 的新输入', clarifications: [], taskCandidates: [],
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes('exact prior input')
        && /has no durable termination receipt/.test(error.message),
    );
    assert.deepEqual(await parentJournal.readScopeAbandonedTurns(unknownScope), [],
      'an unprovable owner keeps recovery responsibility');
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: a blob that cannot be parsed must never be guessed into a
// recoverable or a new input. Impact: a corrupted asset could silently be
// treated as a fresh submit and lose the original turn. Cost: one seeded turn
// with a broken asset.
test('provider explicit brain interpreter reports an unreadable committed input asset', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-unreadable-asset', providerId: 'provider-unreadable-asset', protocol: 'responses',
    endpointRef: 'recorded://unreadable-asset', modelRef: 'model-unreadable-asset',
    configDigest: 'sha256:unreadable-asset-config', capabilityDigest: 'sha256:unreadable-asset-capability',
  };
  const scope = { organId: deps.organId, interactionScopeId: 'runtime:unreadable-asset' };
  await seedInterruptedParentTurn({
    parentJournal: deps.parentJournal, evidence: deps.rawEvidence, rawContent: deps.rawContent,
    binding, scope, interactionId: 'interaction-unreadable-asset', turnId: 'explicit-interpret-unreadable-asset',
    initialInputText: '{"interactionId": "interaction-unreadable-asset", "inputRevision": 1, "rawInput": "broken',
    executionOwner: { daemonLeaseId: 'lease-unreadable', daemonGeneration: 1, processStartToken: 'process-unreadable' },
  });
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, organId: scope.organId, interactionScopeId: scope.interactionScopeId,
    binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new RecordedParentPort({ binding, stepDelayMs: 0, replay: [] }),
  });
  await assert.rejects(
    () => interpreter.interpret({
      interactionId: 'interaction-unreadable-asset', inputRevision: 1, sourceRef: 'ui:unreadable-asset',
      rawInput: 'retry', clarifications: [], taskCandidates: [],
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes('unreadable committed input asset'),
  );
  assert.deepEqual(await deps.parentJournal.readScopeAbandonedTurns(scope), [],
    'a corrupt asset is never discharged or guessed');
  assert.equal(await deps.parentJournal.readScopeOpenedTurns(scope).then((turns) => turns.length), 1,
    'a corrupt asset never opens a fresh turn');
});

// Failure basis: a decodable asset that cannot be read as an input object is
// not evidence that the user's business input changed. With a real terminated
// owner and no unknown tool/helper side effect the old code fell through to the
// different-input boundary, discharged the submitted turn and opened a fresh
// one. Impact: recovery responsibility is silently ended and a new Provider
// request runs in place of the submitted input. Cost: three seeded shapes on
// one real takeover lease.
test('provider explicit brain rejects an invalid committed input asset shape without discharging the turn', async () => {
  const root = join(parentFixtureRoot, `invalid-asset-shape-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-invalid-asset', providerId: 'provider-invalid-asset', protocol: 'responses',
    endpointRef: 'recorded://invalid-asset', modelRef: 'model-invalid-asset',
    configDigest: 'sha256:invalid-asset-config', capabilityDigest: 'sha256:invalid-asset-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const acquired = await acquireTerminatedOwnerLease(root);
    lease = acquired.lease;
    const businessInput = {
      interactionId: 'interaction-invalid-asset', inputRevision: 1, sourceRef: 'ui:invalid-asset',
      rawInput: '请检查发布会当前状态', clarifications: [],
    };
    const shapes = [
      { label: 'null-root', initialInputText: 'null' },
      { label: 'array-root', initialInputText: '[]' },
      { label: 'non-array-candidates', initialInputText: JSON.stringify({ ...businessInput, taskCandidates: 'broken' }) },
    ] as const;
    const observations: {
      readonly shape: (typeof shapes)[number];
      readonly outcome: { readonly resolved: unknown } | { readonly rejected: unknown };
      readonly abandoned: readonly unknown[];
      readonly opened: readonly { readonly fact: { readonly turn: { readonly turnId: string } } }[];
      readonly wires: readonly unknown[];
    }[] = [];
    for (const shape of shapes) {
      const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: `runtime:invalid-asset-${shape.label}` };
      const turnId = `explicit-interpret-invalid-asset-${shape.label}`;
      await seedInterruptedParentTurn({
        parentJournal, evidence, rawContent, binding, scope,
        interactionId: businessInput.interactionId, turnId,
        initialInputText: shape.initialInputText, executionOwner: acquired.previousOwner,
      });
      const wires: any[] = [];
      const port = new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [], respond: async (wire) => {
        wires.push(wire);
        return [{ type: 'response.output_text.done', item_id: 'final', text: JSON.stringify({
          kind: 'answer', normalizedInput: businessInput.rawInput, knownFacts: [],
          answer: '不应到达 Provider', decisionRefs: [],
        }) }];
      } });
      const interpreter = createProviderExplicitBrainInterpreter({
        organId: scope.organId, interactionScopeId: scope.interactionScopeId,
        parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
        rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
        helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
        binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), lease,
        port,
      });
      const retry = { ...businessInput, taskCandidates: [] };
      const outcome = await interpreter.interpret(retry).then(
        (value) => ({ resolved: value as unknown }),
        (error: unknown) => ({ rejected: error }),
      );
      const abandoned = await parentJournal.readScopeAbandonedTurns(scope);
      const opened = await parentJournal.readScopeOpenedTurns(scope);
      observations.push({ shape, outcome, abandoned, opened, wires });
    }
    const notRejected = observations
      .filter((observed) => !('rejected' in observed.outcome
        && observed.outcome.rejected instanceof Error
        && observed.outcome.rejected.message.includes('invalid committed input asset')))
      .map((observed) => `${observed.shape.label}: abandoned=${observed.abandoned.length} opened=${observed.opened.length} providerCalls=${observed.wires.length}`);
    assert.deepEqual(notRejected, [], `every invalid asset shape must raise an explicit error; observed ${notRejected.join('; ')}`);
    for (const observed of observations) {
      const label = observed.shape.label;
      assert.deepEqual(observed.abandoned, [], `${label}: an invalid asset never discharges the submitted turn`);
      assert.equal(observed.opened.length, 1, `${label}: an invalid asset never opens a fresh turn`);
      assert.equal(observed.opened[0]!.fact.turn.turnId, `explicit-interpret-invalid-asset-${label}`,
        `${label}: the submitted turn is retained`);
      assert.equal(observed.wires.length, 0, `${label}: an invalid asset never starts a Provider request`);
    }
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: production only reaches the interpreter through the public
// HTTP interpret route, which rebuilds the task list from the live coordinator.
// A unit-only fix could recover the request while the route still refuses the
// retry or reports a settlement that does not belong to the submitted turn.
// Impact: the user cannot recover the submitted input in the running product.
// Cost: one real child crash, one real takeover, one real UI runtime with the
// real Provider adapter, codec and transport against a controlled upstream.
test('provider explicit brain recovers a drifted original input on the public HTTP entry', async () => {
  const root = join(parentFixtureRoot, `cold-input-http-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-cold-input-http', providerId: 'provider-cold-input-http', protocol: 'responses',
    endpointRef: 'http://recorded.test', modelRef: 'model-cold-input-http',
    configDigest: 'sha256:cold-input-http-config', capabilityDigest: 'sha256:cold-input-http-capability',
  };
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };
  const committedCandidates = [
    { taskId: 'scheduled-task-b258bd97ecc762223c7a', title: '仍在的任务', status: 'running', currentInput: '继续执行仍在的任务' },
    { taskId: 'scheduled-task-gone-away', title: '已消失的任务', status: 'created', currentInput: '继续执行已消失的任务' },
  ];
  let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    // Generation 1 commits the submitted turn and dies. The takeover is the
    // only lifecycle authority the retry gets.
    const acquired = await acquireTerminatedOwnerLease(root);
    lease = acquired.lease;
    const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
    const rawContent = providerRawContentReader(evidence);
    const wires: any[] = [];
    const decisions: string[] = [];
    const port = new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [], respond: async (wire) => {
      wires.push(wire);
      const text = decisions.shift();
      if (text === undefined) throw new Error('unexpected Provider request');
      return [{ type: 'response.output_text.done', item_id: 'final', text }];
    } });
    const composition = { roleId: 'interaction' as const, source: 'http' as const,
      provider: { source: 'http' as const, provider: 'http' as const, binding: binding.bindingId, protocol: 'responses' as const,
        model: binding.modelRef, route: 'recorded', baseUrl: binding.endpointRef }, binding, port };
    const accessControl = await AccessControlService.open({
      credentialPath: join(root, 'security', 'web-access.json'), create: true,
    });
    // The seatbelt sandbox this consumer runs in refuses fs.watch with EMFILE,
    // so the credential-directory watcher cannot register here. Credential
    // hot-reload is unrelated to the recovery path under test; everything else
    // on this instance (pairing, sessions, HTTP listener) stays real.
    (accessControl as unknown as {
      startCredentialWatch: AccessControlService['startCredentialWatch'];
    }).startCredentialWatch = () => () => Promise.resolve(false);
    runtime = await startUiRuntime({
      mode: 'rcc', organId: scope.organId, binding, port: port as any,
      productRoot: root, checkpointRoot: join(root, 'checkpoints'), evidenceRoot: join(root, 'assets'),
      uiRoot: join(process.cwd(), 'docs', 'ui'), portNumber: 0, lease, accessControl,
      explicitBrainTemplateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'cold-input-http' },
      runtimeComposition: {
        prepareAgentProvider: async () => composition as any,
        prepareTaskAgentProvider: async () => { throw new Error('intake must not prepare a Task'); },
      },
    });
    const session = await accessControl.consumePairingCode((await accessControl.issuePairingChallenge()).code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const origin = runtime.server.url;
    const post = async (path: string, body: unknown): Promise<Response> => fetch(`${origin}${path}`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const get = async (path: string): Promise<Response> => fetch(`${origin}${path}`, { headers: { cookie, origin } });
    const receive = async (sourceRef: string, rawInput: string): Promise<{ interactionId: string; sourceRef: string; rawInput: string }> => {
      const response = await post('/api/explicit/inputs', { channel: 'business', sourceRef, rawInput });
      const text = await response.text();
      assert.equal(response.status, 201, text);
      const created = JSON.parse(text) as { readonly interactionId: string };
      const snapshot = await runtime!.service.inspectExplicitInteraction(created.interactionId);
      return { interactionId: created.interactionId, sourceRef: snapshot.sourceRef, rawInput: snapshot.rawInput };
    };
    const journalFile = uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc'));
    const parentJournal = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile));
    const helperJournal = new JsonlInteractionHelperJournal(new JsonlOrganJournal(journalFile));
    const submitTurn = async (input: { interactionId: string; sourceRef: string; rawInput: string }, turnId: string) => {
      // The committed asset is the original submission: it carries the task
      // snapshot that the live coordinator no longer has.
      const committedText = JSON.stringify({
        interactionId: input.interactionId, inputRevision: 1, sourceRef: input.sourceRef,
        rawInput: input.rawInput, clarifications: [], taskCandidates: committedCandidates,
      });
      const seeded = await seedInterruptedParentTurn({
        parentJournal, evidence, rawContent, binding, scope,
        interactionId: input.interactionId, turnId, initialInputText: committedText,
        executionOwner: acquired.previousOwner,
      });
      return { seeded, committedText };
    };

    // 1. The retry of the submitted interaction restores the committed input.
    const first = await receive('ui:cold-input-http', '请检查发布会当前状态');
    const firstTurn = await submitTurn(first, 'explicit-interpret-cold-input-http');
    decisions.push(JSON.stringify({
      kind: 'answer', normalizedInput: first.rawInput, knownFacts: [],
      answer: '发布会状态取自原始提交的候选快照', decisionRefs: [],
    }));
    const interpreted = await post(`/api/explicit/interactions/${encodeURIComponent(first.interactionId)}/interpret`, {});
    const interpretedText = await interpreted.text();
    assert.equal(interpreted.status, 200, interpretedText);
    const answered = JSON.parse(interpretedText) as { readonly state: string; readonly reply: string };
    assert.equal(answered.state, 'answered');
    assert.equal(answered.reply, '发布会状态取自原始提交的候选快照');
    // The submitted turn, its business execution and one new epoch are the ones
    // that finished; no discharge happened.
    assert.deepEqual(await parentJournal.readScopeAbandonedTurns(scope), [],
      'the public retry must not discharge the submitted turn');
    const opened = await parentJournal.readScopeOpenedTurns(scope);
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0]!.fact.turn, firstTurn.seeded.turn);
    const snapshot = await parentJournal.readTurnSnapshot(firstTurn.seeded.turn);
    assert.equal(snapshot.ownerReconciliations.length, 1);
    assert.equal(snapshot.ownerReconciliations[0]!.fact.effectiveExecutionEpoch, 2);
    assert.equal(snapshot.ownerReconciliations[0]!.fact.replacementOwner.daemonGeneration, lease.record.generation);
    assert.equal(snapshot.resourceClose?.fact.execution.executionEpoch, 2);
    assert.deepEqual(snapshot.turnInput?.fact.execution, {
      runtimeId: firstTurn.seeded.turn.turnId, organId: scope.organId,
      operationId: id('operation', `op-${firstTurn.seeded.turn.turnId}`),
      executionEpoch: 1, interactionTurn: firstTurn.seeded.turn,
    });
    // The recovered answer carries the original typed settlement of this turn.
    const settlementResponse = await get(
      `/api/explicit/interactions/${encodeURIComponent(first.interactionId)}/control/provider-settlement`
      + `?inputRevision=1&turnId=${encodeURIComponent(firstTurn.seeded.turn.turnId)}`,
    );
    const settlementText = await settlementResponse.text();
    assert.equal(settlementResponse.status, 200, settlementText);
    const receipt = (JSON.parse(settlementText) as { readonly fact: InteractionProviderSettlementReceipt }).fact;
    validateProviderSettlement(receipt.settlement);
    assert.equal(receipt.interactionId, first.interactionId);
    assert.equal(receipt.inputRevision, 1);
    assert.equal(receipt.settlement.state, 'succeeded');
    // The Provider read the committed snapshot, not the reduced live one.
    assert.equal(wires.length, 1);
    const firstUserText = wires[0].input
      .filter((item: any) => item.type === 'message' && item.role === 'user')
      .map((item: any) => item.content.map((unit: any) => unit.text).join(''))
      .join('');
    assert.equal(firstUserText, firstTurn.committedText);

    // 2. A later new input is still served on the same runtime.
    const second = await receive('ui:cold-input-http-next', '下一个独立问题');
    decisions.push(JSON.stringify({
      kind: 'answer', normalizedInput: second.rawInput, knownFacts: [], answer: '后续输入正常处理', decisionRefs: [],
    }));
    const nextInterpreted = await post(`/api/explicit/interactions/${encodeURIComponent(second.interactionId)}/interpret`, {});
    const nextText = await nextInterpreted.text();
    assert.equal(nextInterpreted.status, 200, nextText);
    assert.equal((JSON.parse(nextText) as { readonly state: string }).state, 'answered');

    // 3. An answer that selects a task the live coordinator no longer has is
    // refused by the service, and the closed parent turn does not block the
    // next input. No task is created or granted.
    const third = await receive('ui:cold-input-http-vanished', '请更新已消失任务的计划');
    const thirdTurn = await submitTurn(third, 'explicit-interpret-cold-input-http-vanished');
    decisions.push(JSON.stringify({
      kind: 'requirement', normalizedInput: third.rawInput, knownFacts: [],
      matchedTaskId: 'scheduled-task-gone-away',
      proposal: {
        revision: 1, intent: 'change', title: '更新已消失任务的计划', objective: '更新已消失任务的计划',
        deliverable: '更新后的计划', deliveryConditions: [], evidenceRefs: [], blockingGaps: [],
      },
      decisionRefs: [],
    }));
    const rejected = await post(`/api/explicit/interactions/${encodeURIComponent(third.interactionId)}/interpret`, {});
    const rejectedText = await rejected.text();
    assert.equal(rejected.status, 409, rejectedText);
    assert.equal((JSON.parse(rejectedText) as { readonly error: { readonly code: string } }).error.code,
      'explicit-brain.task-match-invalid');
    assert.equal(runtime.service.listTasks().counts.total, 0, 'a vanished task never becomes a task change');
    // The recovered parent turn still closed, so the scope accepts new input.
    assert.ok(await helperJournal.readSemanticCheckpointExact(thirdTurn.seeded.turn));
    assert.deepEqual(await parentJournal.readScopeAbandonedTurns(scope), []);
    const fourth = await receive('ui:cold-input-http-after-reject', '拒绝后的新输入');
    decisions.push(JSON.stringify({
      kind: 'answer', normalizedInput: fourth.rawInput, knownFacts: [], answer: '拒绝后仍可继续', decisionRefs: [],
    }));
    const fourthInterpreted = await post(`/api/explicit/interactions/${encodeURIComponent(fourth.interactionId)}/interpret`, {});
    const fourthText = await fourthInterpreted.text();
    assert.equal(fourthInterpreted.status, 200, fourthText);
    assert.equal((JSON.parse(fourthText) as { readonly state: string }).state, 'answered');
    assert.equal(runtime.service.listTasks().counts.total, 0);
    console.log(JSON.stringify({
      event: 'cold-input-http-receipt', recoveredTurn: firstTurn.seeded.turn.turnId,
      epoch: snapshot.resourceClose?.fact.execution.executionEpoch,
      settlement: { interactionId: receipt.interactionId, inputRevision: receipt.inputRevision, state: receipt.settlement.state },
      providerSawCommittedCandidates: JSON.parse(firstUserText).taskCandidates.length,
      vanishedTaskRejected: 409, tasksAfter: runtime.service.listTasks().counts.total,
    }));
  } finally {
    await runtime?.close();
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: the previous consumer seeded a pending record and completed it
// by hand, so it never proved that a second interpret really overlaps a live
// first one. Impact: a guard that only works on hand-written shapes could still
// freeze a genuinely streaming answer. Cost: one real daemon lease, one
// controlled Provider stream held open, and two public interpret calls.
// Probability: any scope whose user types again while the first answer streams.
test('provider explicit brain interpreter keeps a streaming turn when a second input overlaps it', async () => {
  const root = join(parentFixtureRoot, `live-overlap-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-live-overlap', providerId: 'provider-live-overlap', protocol: 'responses',
    endpointRef: 'recorded://live-overlap', modelRef: 'model-live-overlap',
    configDigest: 'sha256:live-overlap-config', capabilityDigest: 'sha256:live-overlap-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:live-overlap' };
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstDeltaFlushed!: () => void;
  const firstDelta = new Promise<void>((resolve) => { firstDeltaFlushed = resolve; });
  let providerRequests = 0;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    await ensureControlLayout(paths);
    lease = await acquireDaemonLease(paths);
    const decision = (normalizedInput: string, title: string) => JSON.stringify({
      kind: 'requirement', normalizedInput, knownFacts: [],
      proposal: {
        revision: 1, intent: 'create', title, objective: title,
        deliverable: `${title}的结果`, deliveryConditions: [], evidenceRefs: [], blockingGaps: [],
      },
      decisionRefs: [],
    });
    const firstAnswer = decision('正在输出的第一个请求', '第一个请求');
    const port = new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [],
      stream: async function* () {
        providerRequests += 1;
        if (providerRequests > 1) {
          // The refused input must never get this far; keeping an answer here
          // makes an accidental second dispatch observable instead of silent.
          yield { type: 'response.output_text.done', item_id: 'text-refused', text: decision('同时到达的第二个输入', '第二个输入') };
          return;
        }
        yield { type: 'response.output_text.delta', item_id: 'text-live', delta: '{"kind":"requirement",' };
        firstDeltaFlushed();
        await firstMayFinish;
        yield { type: 'response.output_text.done', item_id: 'text-live', text: firstAnswer };
      } });
    const interpreter = createProviderExplicitBrainInterpreter({
      organId: scope.organId, interactionScopeId: scope.interactionScopeId,
      parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
      rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
      helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
      binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      lease, port,
    });

    // The first interpret is a real call that stays open mid-answer.
    const live = interpreter.interpret({
      interactionId: 'interaction-overlap-first', inputRevision: 1, sourceRef: 'ui:overlap-first',
      rawInput: '正在输出的第一个请求', clarifications: [], taskCandidates: [],
    });
    await firstDelta;
    const openedWhileLive = await parentJournal.readScopeOpenedTurns(scope);
    assert.equal(openedWhileLive.length, 1, 'the streaming call owns one opened turn');
    const liveTurn = openedWhileLive[0]!.fact.turn;
    const liveSnapshot = await parentJournal.readTurnSnapshot(liveTurn);
    assert.equal(liveSnapshot.abandonment, null);
    assert.ok(liveSnapshot.acceptedFacts.some(({ fact }) =>
      fact.envelope.fact.kind === 'content' && fact.envelope.fact.channel === 'assistant-text'),
    'the live turn already carries partial Provider output');
    assert.equal(liveSnapshot.acceptedFacts.some(({ fact }) =>
      fact.envelope.fact.kind === 'request-complete'), false, 'the live request has no terminal fact yet');

    // A second, different input arrives while the first is still streaming. It
    // must be refused without abandoning the live turn.
    await assert.rejects(
      () => interpreter.interpret({
        interactionId: 'interaction-overlap-second', inputRevision: 1, sourceRef: 'ui:overlap-second',
        rawInput: '同时到达的第二个输入', clarifications: [], taskCandidates: [],
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes('exact prior input')
        && /still the current active lease owner/.test(error.message),
    );
    assert.deepEqual(await parentJournal.readScopeAbandonedTurns(scope), [],
      'an overlapping input never freezes the streaming turn');
    assert.equal(providerRequests, 1, 'the refused input never dispatches a Provider request');
    assert.equal((await parentJournal.readScopeOpenedTurns(scope)).length, 1,
      'the refused input never opens a second turn');

    // Release the first request: it must finish normally with its own durable end.
    releaseFirst();
    const served = await live;
    assert.equal(served.kind, 'requirement');
    const finalSnapshot = await parentJournal.readTurnSnapshot(liveTurn);
    assert.equal(finalSnapshot.abandonment, null);
    assert.ok(finalSnapshot.acceptedFacts.some(({ fact }) =>
      fact.envelope.fact.kind === 'request-complete' && fact.envelope.fact.terminal === 'completed'),
    'the released request keeps its real terminal fact');
    assert.ok(await helperJournal.readSemanticCheckpointExact(liveTurn),
      'the released request commits its own semantic checkpoint');
    assert.deepEqual(await parentJournal.readScopeAbandonedTurns(scope), [],
      'a normally finished turn is never abandoned');
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});
test('provider explicit brain interpreter keeps the intake usable after an interpret failure whose provider close also fails', async () => {
  // Failure basis: one interpret batch whose Provider stream broke with the
  // journal briefly rejecting the next durable raw fact. The owner process
  // settled, closed and threw, but the old catch lane threw the close error
  // immediately, so no durable terminal fact was ever written for the epoch it
  // had just opened. The turn stayed "pending" forever and every later input in
  // the scope was refused because the live lease cannot prove its own stream is
  // dead: the whole explicit intake froze until a daemon restart. Impact: a
  // single transient failure bricks intake. Cost: one real lease, one failing
  // recorded Provider stream and one healthy replay on the existing JSONL
  // consumer. Probability: any transient raw-acceptance or socket failure on
  // the intake stream.
  const root = join(parentFixtureRoot, `intake-failure-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-intake-failure', providerId: 'provider-intake-failure', protocol: 'responses',
    endpointRef: 'fake://intake-failure', modelRef: 'model-intake-failure',
    configDigest: 'sha256:intake-failure-config', capabilityDigest: 'sha256:intake-failure-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:intake-failure' };
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    await ensureControlLayout(paths);
    lease = await acquireDaemonLease(paths);
    const ownerIdentity = await lease.withCurrentLeaseOwner(async (owner) => owner);
    // The first interpret serves a stream whose second durable raw acceptance
    // is rejected: the first reasoning unit is durable, the next one is not.
    // That is the exact shape interaction-122 left in the production journal:
    // a rejected raw fact, a settle that failed before the request could be
    // marked failed, and a close that came back pending because the Provider
    // worker never released its execution.
    const parentWithRejection = new RejectedAcceptanceJournal(parentJournal, 2);
    let prepared = 0;
    const failingPort = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], evidence, respond: async () => [
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs-intake', delta: 'part one' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs-intake', delta: 'part two' },
    ] });
    const failingComposition: AgentProviderComposition<InteractionParentProviderExecutionIdentityRef> = {
      roleId: 'interaction' as const, source: 'http' as const,
      provider: { source: 'http' as const, provider: 'http' as const, binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'intake-failure', baseUrl: binding.endpointRef },
      binding, port: failingPort,
    };
    const healthyPort = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], evidence, respond: async () => [
      { type: 'response.output_text.done', item_id: 'final', text: JSON.stringify({
        kind: 'answer', normalizedInput: '4 加 4 等于几？', knownFacts: [], answer: '8', decisionRefs: [],
      }) },
    ] });
    const healthyComposition: AgentProviderComposition<InteractionParentProviderExecutionIdentityRef> = {
      roleId: 'interaction' as const, source: 'http' as const,
      provider: { source: 'http' as const, provider: 'http' as const, binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'intake-failure-ok', baseUrl: binding.endpointRef },
      binding, port: healthyPort,
    };
    const interpreter = createProviderExplicitBrainInterpreter({
      organId: scope.organId, interactionScopeId: scope.interactionScopeId,
      parentJournal: parentWithRejection, checkpointJournal: helperJournal, helperJournal,
      turnHelperJournal: helperJournal, rawEvidence: evidence, rawContent,
      clock: { now: () => new Date().toISOString() },
      helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
      binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      lease,
      prepareAgentProvider: async () => {
        prepared += 1;
        return prepared === 1 ? failingComposition : healthyComposition;
      },
    });
    // The committed record kind is new in this change, so the durable read is
    // probed instead of assumed: against the pre-fix build the record cannot
    // exist at all, which is exactly the red state this test reports.
    const readExecutionFailures = async (): Promise<number> => {
      const reader = parentJournal as unknown as {
        readonly readScopeExecutionFailures?: (input: typeof scope) => Promise<readonly unknown[]>;
      };
      if (reader.readScopeExecutionFailures === undefined) return 0;
      return (await reader.readScopeExecutionFailures(scope)).length;
    };
    const failedRequest = {
      interactionId: 'interaction-intake-failure', inputRevision: 1, sourceRef: 'ui:intake-failure',
      rawInput: '4 加 4 等于几？', clarifications: [], taskCandidates: [],
    };
    // The first interpret fails honestly, and the primary causal error is
    // exposed instead of being masked by the close failure.
    await assert.rejects(
      () => interpreter.interpret(failedRequest),
      (error: unknown) => error instanceof AggregateError
        && error.message.includes('provider raw fact was rejected by durable acceptance'),
    );
    assert.equal(await readExecutionFailures(), 1,
      'the failed epoch is durably closed by its own fact');
    // Without the fix this next input is refused with "the committed execution
    // owner is still the current active lease owner; a live Provider stream is
    // not an interrupted crash": the turn stayed pending forever.
    const nextRequest = {
      interactionId: 'interaction-after-intake-failure', inputRevision: 1, sourceRef: 'ui:after-intake-failure',
      rawInput: '4 加 4 等于几？', clarifications: [], taskCandidates: [],
    };
    const second = await interpreter.interpret(nextRequest);
    assert.equal(second.kind, 'answer');
    if (second.kind !== 'answer') throw new Error('expected an answer');
    assert.equal(second.answer, '8');
    assert.equal(prepared, 2, 'the second interpret drives its own fresh provider');
    assert.equal(await readExecutionFailures(), 1, 'the closure is written exactly once');
    assert.ok((await parentJournal.readScopeOpenedTurns(scope)).length >= 2);
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});


// Failure basis: a tool-call, a tool-result or a dispatched helper proves the
// turn reached the side-effect stage. The old rule treated a recorded tool
// result as proof that no business side effect happened, so a turn that wrote a
// file (or dispatched a helper that already returned) could be discharged and
// its effect became unobservable. Impact: silent duplicate or lost writes after
// a crash. Cost: one real terminated-owner takeover receipt, one paired tool
// turn and one completed helper turn. Probability: any interrupted turn that
// used a tool before its Provider stream broke.
test('provider explicit brain interpreter holds an interrupted turn that dispatched a tool or helper', async () => {
  const root = join(parentFixtureRoot, `side-effect-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-side-effect', providerId: 'provider-side-effect', protocol: 'responses',
    endpointRef: 'recorded://side-effect', modelRef: 'model-side-effect',
    configDigest: 'sha256:side-effect-config', capabilityDigest: 'sha256:side-effect-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    // A real takeover receipt proves the previous owner is dead, so the refusal
    // below is provably caused by the side-effect shape and not by owner
    // authentication.
    const acquired = await acquireTerminatedOwnerLease(root);
    lease = acquired.lease;
    const crashedOwner = acquired.previousOwner;
    const toolScope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:side-effect-tool' };
    const toolInput = JSON.stringify({
      interactionId: 'interaction-side-effect-tool', inputRevision: 1, sourceRef: 'ui:side-effect-tool',
      rawInput: '写文件后崩溃', clarifications: [], taskCandidates: [],
    });
    await seedInterruptedParentTurn({
      parentJournal, evidence, rawContent, binding, scope: toolScope,
      interactionId: 'interaction-side-effect-tool', turnId: 'explicit-interpret-side-effect-tool',
      initialInputText: toolInput, executionOwner: crashedOwner, pairedToolCall: true,
    });
    const interpreterOptions = {
      parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
      rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
      helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
      binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      lease, port: new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [
        { kind: 'output', state: 'output', summary: JSON.stringify({
          kind: 'requirement', normalizedInput: '写文件后的新输入', knownFacts: [],
          proposal: { revision: 1, intent: 'create', title: '写文件后的新输入', objective: '写文件后的新输入',
            deliverable: '结果', deliveryConditions: [], evidenceRefs: [], blockingGaps: [] },
          decisionRefs: [],
        }) },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ] }),
    };
    await assert.rejects(
      () => createProviderExplicitBrainInterpreter({ ...interpreterOptions,
        organId: toolScope.organId, interactionScopeId: toolScope.interactionScopeId })
        .interpret({ interactionId: 'interaction-side-effect-next', inputRevision: 1, sourceRef: 'ui:side-effect-next',
          rawInput: '写文件后的新输入', clarifications: [], taskCandidates: [] }),
      (error: unknown) => error instanceof Error
        && error.message.includes('exact prior input')
        && /tool call call-1/.test(error.message),
    );
    assert.deepEqual(await parentJournal.readScopeAbandonedTurns(toolScope), [],
      'a recorded tool result does not prove the absence of a business side effect');
    const toolSnapshot = await parentJournal.readTurnSnapshot(
      (await parentJournal.readScopeOpenedTurns(toolScope))[0]!.fact.turn);
    assert.equal(toolSnapshot.abandonment, null);
    assert.equal(toolSnapshot.acceptedFacts.filter(({ fact }) =>
      fact.envelope.fact.kind === 'tool-result').length, 1);

    // B: a helper that already returned is still a dispatched side effect. A
    // returned helper is not owner acceptance and never proves no effect.
    const helperScope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:side-effect-helper' };
    const helperInput = JSON.stringify({
      interactionId: 'interaction-side-effect-helper', inputRevision: 1, sourceRef: 'ui:side-effect-helper',
      rawInput: '派发 helper 后崩溃', clarifications: [], taskCandidates: [],
    });
    const seededHelper = await seedInterruptedParentTurn({
      parentJournal, evidence, rawContent, binding, scope: helperScope,
      interactionId: 'interaction-side-effect-helper', turnId: 'explicit-interpret-side-effect-helper',
      initialInputText: helperInput, executionOwner: crashedOwner,
    });
    const helperIdentity = { organId: seededHelper.turn.organId,
      interactionScopeId: seededHelper.turn.interactionScopeId, interactionId: seededHelper.turn.interactionId,
      inputRevision: 1, parentTurnId: seededHelper.turn.turnId,
      assignmentId: 'helper-assignment-side-effect', helperCallId: 'helper-side-effect-call', attempt: 1 };
    const assignment = { ...helperIdentity, objective: 'seeded returned helper', targetRefs: [],
      expectedOutputRefs: [], expectedArtifactDigests: [], acceptanceCriteriaDigest: `sha256:${'a'.repeat(64)}`,
      successCriteria: ['complete'], failureCriteria: ['none'], incompleteCriteria: ['partial'],
      requiredCapabilities: [], mergeGate: 'not-required' as const };
    await helperJournal.appendDispatchAccepted({ kind: 'dispatch-accepted', assignment,
      dispatchAcceptedAt: new Date().toISOString(), evidenceRefs: [] });
    await helperJournal.appendReturned({ kind: 'returned',
      result: { ...helperIdentity, agentId: 'seeded-helper', producedArtifactRefs: [], producedArtifactBodies: [],
        status: 'incomplete', summary: 'seeded returned helper', outputRefs: [], evidenceRefs: [],
        nextAction: 'wait', conditionRef: 'condition:side-effect' },
      returnedAt: new Date().toISOString(), evidenceRefs: [] },
    { description: 'dispatch seeded returned helper for objective "seeded returned helper"; success criteria: complete' });
    await assert.rejects(
      () => createProviderExplicitBrainInterpreter({ ...interpreterOptions,
        organId: helperScope.organId, interactionScopeId: helperScope.interactionScopeId })
        .interpret({ interactionId: 'interaction-side-effect-helper-next', inputRevision: 1, sourceRef: 'ui:side-effect-helper-next',
          rawInput: 'helper 后的新输入', clarifications: [], taskCandidates: [] }),
      (error: unknown) => error instanceof Error
        && error.message.includes('exact prior input')
        && /helper helper-side-effect-call/.test(error.message),
    );
    assert.deepEqual(await parentJournal.readScopeAbandonedTurns(helperScope), [],
      'a dispatched helper is a side effect even after it returned');
    const helperSnapshot = await parentJournal.readTurnSnapshot(seededHelper.turn);
    assert.equal(helperSnapshot.abandonment, null);

    // C: a pure reasoning interruption is still dischargeable when the takeover
    // receipt proves the owner is dead. The tightening must not brick the
    // legitimate crash path the fix exists for.
    const reasoningScope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:side-effect-reasoning' };
    const reasoningInput = JSON.stringify({
      interactionId: 'interaction-side-effect-reasoning', inputRevision: 1, sourceRef: 'ui:side-effect-reasoning',
      rawInput: '纯推理崩溃', clarifications: [], taskCandidates: [],
    });
    const seededReasoning = await seedInterruptedParentTurn({
      parentJournal, evidence, rawContent, binding, scope: reasoningScope,
      interactionId: 'interaction-side-effect-reasoning', turnId: 'explicit-interpret-side-effect-reasoning',
      initialInputText: reasoningInput, executionOwner: crashedOwner,
    });
    const reasoningInterpreter = createProviderExplicitBrainInterpreter({ ...interpreterOptions,
      organId: reasoningScope.organId, interactionScopeId: reasoningScope.interactionScopeId,
      port: new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [
        { kind: 'output', state: 'output', summary: JSON.stringify({
          kind: 'requirement', normalizedInput: '崩溃后仍可服务', knownFacts: [],
          proposal: { revision: 1, intent: 'create', title: '崩溃后仍可服务', objective: '崩溃后仍可服务',
            deliverable: '结果', deliveryConditions: [], evidenceRefs: [], blockingGaps: [] },
          decisionRefs: [],
        }) },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ] }) });
    const served = await reasoningInterpreter.interpret({
      interactionId: 'interaction-side-effect-reasoning-next', inputRevision: 1,
      sourceRef: 'ui:side-effect-reasoning-next', rawInput: '崩溃后仍可服务',
      clarifications: [], taskCandidates: [],
    });
    assert.equal(served.kind, 'requirement');
    const reasoningAbandoned = await parentJournal.readScopeAbandonedTurns(reasoningScope);
    assert.equal(reasoningAbandoned.length, 1);
    assert.deepEqual(reasoningAbandoned[0]!.fact.turn, seededReasoning.turn);
    assert.equal(reasoningAbandoned[0]!.fact.reason, 'provider-interrupted-without-terminal-output');
    const reasoningSnapshot = await parentJournal.readTurnSnapshot(seededReasoning.turn);
    assert.equal(reasoningSnapshot.resourceClose, null, 'the discharge still never fabricates a close');
    assert.deepEqual(reasoningSnapshot.providerSettlements, []);
    assert.deepEqual(reasoningSnapshot.ownerReconciliations, []);
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: the daemon lease keeps exactly one takeover record, so the
// termination receipt of a committed owner survives only until the next
// generation is written. A turn owned by generation N therefore becomes
// undischargeable as soon as the daemon reaches generation N+2: every new input
// to that scope is refused with "has no durable termination receipt" although
// the committed owner is provably gone and the live owner is generations newer.
// Impact: one crash plus one later daemon start permanently locks explicit
// intake for the whole interaction scope, and every further start rewrites the
// receipt again. Cost: three real lease generations, two real crash takeovers
// and one seeded interrupted turn.
// Failure basis: a turn that already reconciled into a continued epoch (mode
// continue) leaves the abandonment lane permanently held while the continued
// epoch itself can die before any terminal output. The committed replacement
// owner is provably terminated, so the turn can never resume, yet every new
// input is refused with "requires its exact prior input". Impact: one crash
// after a reconciliation locks explicit intake for the whole scope. Cost: four
// real lease generations, three real crash/dispose receipts and one seeded
// reconciled turn.
test('provider explicit brain interpreter closes the dead continued epoch of a reconciled turn', async () => {
  const root = join(parentFixtureRoot, `reconciled-dead-epoch-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-reconciled-dead-epoch', providerId: 'provider-reconciled-dead-epoch', protocol: 'responses',
    endpointRef: 'recorded://reconciled-dead-epoch', modelRef: 'model-reconciled-dead-epoch',
    configDigest: 'sha256:reconciled-dead-epoch-config', capabilityDigest: 'sha256:reconciled-dead-epoch-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:reconciled-dead-epoch' };
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  let earlyLease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    // Generation 1 owns the turn input and dies. Generation 2 takes over,
    // records the receipt that proves generation 1 stopped, and becomes the
    // reconciled replacement owner.
    const firstCrash = await acquireCrashedOwnerLease(root);
    assert.equal(firstCrash.generation, 1);
    earlyLease = await acquireDaemonLease(paths, { takeover: {
      reason: 'reconciled dead epoch test first takeover', allowed: () => true,
      stop: { gracefulTimeoutMs: 2_000, pollIntervalMs: 20 },
    } });
    assert.equal(earlyLease.record.generation, 2);
    const replacementOwner = await earlyLease.withCurrentLeaseOwner(async (authenticated) => authenticated);

    // Seed the reconciled shape directly: turn input owned by generation 1,
    // one continue reconciliation to generation 2 (epoch 2), and only a
    // reasoning delta in the continued epoch. No terminal output, no tool
    // effect, no close, no settlement.
    const turn: InteractionTurnIdentity = {
      organId: scope.organId, interactionScopeId: scope.interactionScopeId,
      interactionId: 'interaction-reconciled-dead-epoch', inputRevision: 1, turnId: 'explicit-interpret-reconciled-dead-epoch',
    };
    const operationScope = { organId: scope.organId, operationId: id('operation', 'op-reconciled-dead-epoch') };
    const execution = { runtimeId: turn.turnId, ...operationScope, executionEpoch: 1, interactionTurn: turn };
    const initialInput = {
      ref: await evidence.write({ scope: operationScope, kind: 'execution', type: 'initial-input', locator: turn.turnId,
        content: JSON.stringify({ interactionId: 'interaction-reconciled-dead-epoch', inputRevision: 1,
          sourceRef: 'ui:reconciled-dead-epoch', rawInput: '已 reconcile 又崩溃的旧输入', clarifications: [], taskCandidates: [] }) }),
      view: { kind: 'utf8-text' as const },
    };
    const seedOwner = createInteractionParentTurnRawOwner({
      turn, execution, scope: operationScope, initialInput, providerBinding: binding, executionOwner: firstCrash.owner,
      journal: parentJournal, rawContent,
    });
    await seedOwner.openTurnInput();
    const reqOne = { turnId: turn.turnId, requestId: 'reconciled-dead-request-1' };
    await seedOwner.registerRequest({ execution, record: { request: reqOne, scope: operationScope, phase: 'dispatching' } });
    await seedOwner.registerRequest({ execution, record: { request: reqOne, scope: operationScope, phase: 'dispatched' } });
    const reasoningOne = {
      ref: await evidence.write({ scope: operationScope, kind: 'execution', type: 'reasoning', locator: 'reconciled-dead-reasoning-1',
        content: 'partial reasoning in the first epoch' }),
      view: { kind: 'utf8-text' as const },
    };
    await seedOwner.acceptRawFact({ execution, scope: operationScope, request: reqOne, producerSeq: 1,
      fact: { kind: 'content', channel: 'reasoning-summary', update: 'full', contentUnitId: 'reconciled-dead-reasoning-1',
        content: reasoningOne, complete: false } });
    const continuedOwner = createInteractionParentTurnRawOwner({
      turn, execution: { ...execution, executionEpoch: 2 }, scope: operationScope, initialInput, providerBinding: binding,
      executionOwner: replacementOwner, journal: parentJournal, rawContent,
    });
    const reconciled = await continuedOwner.reconcileTurnOwner({
      previousOwner: firstCrash.owner, replacementOwner, isCommittedReplacement: true,
      reconciledAt: new Date().toISOString(),
    });
    assert.equal(reconciled.fact.mode, 'continue');
    assert.equal(reconciled.fact.effectiveExecutionEpoch, 2);
    await continuedOwner.openTurnInput();
    const executionTwo = { ...execution, executionEpoch: 2 };
    const reqTwo = { turnId: turn.turnId, requestId: 'reconciled-dead-request-2' };
    await continuedOwner.registerRequest({ execution: executionTwo, record: { request: reqTwo, scope: operationScope, phase: 'dispatching' } });
    await continuedOwner.registerRequest({ execution: executionTwo, record: { request: reqTwo, scope: operationScope, phase: 'dispatched' } });
    const reasoningTwo = {
      ref: await evidence.write({ scope: operationScope, kind: 'execution', type: 'reasoning', locator: 'reconciled-dead-reasoning-2',
        content: 'partial reasoning in the continued epoch' }),
      view: { kind: 'utf8-text' as const },
    };
    await continuedOwner.acceptRawFact({ execution: executionTwo, scope: operationScope, request: reqTwo, producerSeq: 1,
      fact: { kind: 'content', channel: 'reasoning-summary', update: 'full', contentUnitId: 'reconciled-dead-reasoning-2',
        content: reasoningTwo, complete: false } });

    // The replacement owner (generation 2) is provably gone: it disposes
    // gracefully, generation 3 crashes, generation 4 takes over and records the
    // receipt that proves generation 3 stopped. Generation 2's graceful
    // disposal receipt is written on the next durable lease write.
    await earlyLease.release();
    earlyLease = undefined;
    const thirdCrash = await acquireCrashedOwnerLease(root);
    assert.equal(thirdCrash.generation, 3);
    lease = await acquireDaemonLease(paths, { takeover: {
      reason: 'reconciled dead epoch test final takeover', allowed: () => true,
      stop: { gracefulTimeoutMs: 2_000, pollIntervalMs: 20 },
    } });
    assert.equal(lease.record.generation, 4);

    const interpreterOptions = {
      parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
      rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
      helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
      binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    };
    const served = await createProviderExplicitBrainInterpreter({ ...interpreterOptions,
      organId: scope.organId, interactionScopeId: scope.interactionScopeId, lease,
      port: new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [
        { kind: 'output', state: 'output', summary: JSON.stringify({
          kind: 'requirement', normalizedInput: 'reconcile 之后的新输入', knownFacts: [],
          proposal: { revision: 1, intent: 'create', title: 'reconcile 之后的新输入', objective: 'reconcile 之后的新输入',
            deliverable: '结果', deliveryConditions: [], evidenceRefs: [], blockingGaps: [] },
          decisionRefs: [],
        }) },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ] }) }).interpret({
        interactionId: 'interaction-reconciled-dead-epoch-next', inputRevision: 1,
        sourceRef: 'ui:reconciled-dead-epoch-next', rawInput: 'reconcile 之后的新输入',
        clarifications: [], taskCandidates: [],
      });
    assert.equal(served.kind, 'requirement');
    const failures = await parentJournal.readScopeExecutionFailures(scope);
    assert.equal(failures.length, 1, 'the dead continued epoch is closed exactly once');
    assert.equal(failures[0]!.fact.execution.executionEpoch, 2, 'the closure records the epoch that died');
    assert.deepEqual(failures[0]!.fact.turn, turn);
    const snapshot = await parentJournal.readTurnSnapshot(turn);
    assert.equal(snapshot.resourceClose, null, 'the closure never fabricates a close');
    assert.deepEqual(snapshot.providerSettlements, [], 'the closure never fabricates a settlement');
    assert.equal(snapshot.abandonment, null, 'the reconciled turn is closed as a failed epoch, not abandoned');
    assert.deepEqual(snapshot.ownerReconciliations.map((entry) => entry.fact.effectiveExecutionEpoch), [2],
      'the committed reconciliation is never rewritten');
    assert.deepEqual(
      (await readDaemonLease(paths) as { terminations?: readonly { previousGeneration: number }[] } | undefined)
        ?.terminations?.map((entry) => entry.previousGeneration),
      [1, 2, 3],
      'the replacement owner termination receipt stays durable',
    );
  } finally {
    await earlyLease?.release();
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: the discharge of an interrupted turn read its parent snapshot
// and fixed the replacement owner before it entered the lease guard. A
// discharge that waited there could authenticate the dead owner of epoch 2 and
// then close whatever newer epoch a concurrent exact-input recovery had just
// opened, recording a live epoch 3 as an execution failure. Impact: a real
// Provider stream is terminated and its answer lost. Cost: four real lease
// generations, one seeded reconciled epoch and one gated discharge. Probability:
// a new input and the exact-input recovery arriving in that order on one scope.
test('provider explicit brain interpreter never closes the epoch a concurrent recovery just opened', async () => {
  const root = join(parentFixtureRoot, `guard-epoch-race-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-guard-epoch-race', providerId: 'provider-guard-epoch-race', protocol: 'responses',
    endpointRef: 'recorded://guard-epoch-race', modelRef: 'model-guard-epoch-race',
    configDigest: 'sha256:guard-epoch-race-config', capabilityDigest: 'sha256:guard-epoch-race-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:guard-epoch-race' };
  const clock = { now: () => new Date().toISOString() };
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    // Generation 1 owns the turn input and dies. Generation 2 takes over in its
    // own process, becomes the reconciled replacement owner of epoch 2, and
    // then dies too: an owner from another process start is what makes the
    // live generation a genuine committed replacement during recovery.
    const firstCrash = await acquireCrashedOwnerLease(root);
    assert.equal(firstCrash.generation, 1);
    const secondCrash = await acquireCrashedTakeoverOwnerLease(root, 'guard epoch race epoch two owner');
    assert.equal(secondCrash.generation, 2);
    const secondOwner = secondCrash.owner;

    const originalRequest = {
      interactionId: 'interaction-guard-epoch-race', inputRevision: 1,
      sourceRef: 'ui:guard-epoch-race', rawInput: '需要恢复的原始输入',
      clarifications: [], taskCandidates: [],
    };
    const turn: InteractionTurnIdentity = {
      organId: scope.organId, interactionScopeId: scope.interactionScopeId,
      interactionId: originalRequest.interactionId, inputRevision: 1, turnId: 'explicit-interpret-guard-epoch-race',
    };
    const operationScope = { organId: scope.organId, operationId: id('operation', 'op-guard-epoch-race') };
    const execution = { runtimeId: turn.turnId, ...operationScope, executionEpoch: 1, interactionTurn: turn };
    const initialInput = {
      ref: await evidence.write({
        scope: operationScope, kind: 'execution', type: 'initial-input', locator: turn.turnId,
        content: JSON.stringify(originalRequest),
      }),
      view: { kind: 'utf8-text' as const },
    };
    const seedOwner = createInteractionParentTurnRawOwner({
      turn, execution, scope: operationScope, initialInput, providerBinding: binding,
      executionOwner: firstCrash.owner, journal: parentJournal, rawContent,
    });
    await seedOwner.openTurnInput();
    const reqOne = { turnId: turn.turnId, requestId: 'guard-epoch-race-request-1' };
    await seedOwner.registerRequest({ execution, record: { request: reqOne, scope: operationScope, phase: 'dispatching' } });
    await seedOwner.registerRequest({ execution, record: { request: reqOne, scope: operationScope, phase: 'dispatched' } });
    await seedOwner.acceptRawFact({ execution, scope: operationScope, request: reqOne, producerSeq: 1,
      fact: { kind: 'content', channel: 'reasoning-summary', update: 'full',
        contentUnitId: 'guard-epoch-race-reasoning-1',
        content: { ref: await evidence.write({ scope: operationScope, kind: 'execution', type: 'reasoning',
          locator: 'guard-epoch-race-reasoning-1', content: 'partial reasoning in the first epoch' }),
        view: { kind: 'utf8-text' as const } }, complete: false } });

    const continuedOwner = createInteractionParentTurnRawOwner({
      turn, execution: { ...execution, executionEpoch: 2 }, scope: operationScope, initialInput,
      providerBinding: binding, executionOwner: secondOwner, journal: parentJournal, rawContent,
    });
    const reconciled = await continuedOwner.reconcileTurnOwner({
      previousOwner: firstCrash.owner, replacementOwner: secondOwner,
      isCommittedReplacement: true, reconciledAt: clock.now(),
    });
    assert.equal(reconciled.fact.mode, 'continue');
    assert.equal(reconciled.fact.effectiveExecutionEpoch, 2);
    await continuedOwner.openTurnInput();
    const executionTwo = { ...execution, executionEpoch: 2 };
    const reqTwo = { turnId: turn.turnId, requestId: 'guard-epoch-race-request-2' };
    await continuedOwner.registerRequest({ execution: executionTwo, record: { request: reqTwo, scope: operationScope, phase: 'dispatching' } });
    await continuedOwner.registerRequest({ execution: executionTwo, record: { request: reqTwo, scope: operationScope, phase: 'dispatched' } });
    await continuedOwner.acceptRawFact({ execution: executionTwo, scope: operationScope, request: reqTwo, producerSeq: 1,
      fact: { kind: 'content', channel: 'reasoning-summary', update: 'full',
        contentUnitId: 'guard-epoch-race-reasoning-2',
        content: { ref: await evidence.write({ scope: operationScope, kind: 'execution', type: 'reasoning',
          locator: 'guard-epoch-race-reasoning-2', content: 'partial reasoning in the continued epoch' }),
        view: { kind: 'utf8-text' as const } }, complete: false } });

    // Generation 2 is provably gone and generation 3 is the live owner, so the
    // exact-input recovery can legally open epoch 3 under generation 3.
    lease = await acquireDaemonLease(paths, { takeover: {
      reason: 'guard epoch race final takeover', allowed: () => true,
      stop: { gracefulTimeoutMs: 2_000, pollIntervalMs: 20 },
    } });
    assert.equal(lease.record.generation, 3);
    assert.equal(lease.record.takeover?.previousGeneration, 2);
    assert.equal(lease.record.takeover?.termination, 'already-dead');
    const liveLease = lease;

    // The discharge request is paused just before it would enter the real lease
    // guard; the exact-input recovery then wins the guard and opens epoch 3.
    let releaseDischarge!: () => void;
    const dischargeGate = new Promise<void>((resolve) => { releaseDischarge = resolve; });
    let dischargeReachedGuard!: () => void;
    const dischargeAtGuard = new Promise<void>((resolve) => { dischargeReachedGuard = resolve; });
    let gated = false;
    const gatedGuard: SupervisorLease['withCurrentLeaseOwner'] = async (operation) => {
      if (!gated) {
        gated = true;
        dischargeReachedGuard();
        await dischargeGate;
      }
      return liveLease.withCurrentLeaseOwner(operation);
    };
    const gatedLease: SupervisorLease = Object.assign(
      Object.create(liveLease) as SupervisorLease,
      { withCurrentLeaseOwner: gatedGuard },
    );

    const decision = JSON.stringify({
      kind: 'requirement', normalizedInput: '竞态期间到达的新输入', knownFacts: [],
      proposal: { revision: 1, intent: 'create', title: '竞态期间到达的新输入', objective: '竞态期间到达的新输入',
        deliverable: '结果', deliveryConditions: [], evidenceRefs: [], blockingGaps: [] },
      decisionRefs: [],
    });
    const dischargeInterpreter = createProviderExplicitBrainInterpreter({
      organId: scope.organId, interactionScopeId: scope.interactionScopeId,
      parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
      rawEvidence: evidence, rawContent, clock,
      helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
      binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      lease: gatedLease,
      port: new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [
        { kind: 'output', state: 'output', summary: decision },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ] }),
    });
    const dischargeOutcome = dischargeInterpreter.interpret({
      ...originalRequest, interactionId: 'interaction-guard-epoch-race-next',
      sourceRef: 'ui:guard-epoch-race-next', rawInput: '竞态期间到达的新输入',
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await Promise.race([dischargeAtGuard, dischargeOutcome.then((outcome) => {
      throw new Error(`discharge finished before the guard: ${String((outcome as { error?: unknown }).error)}`);
    })]);

    // The exact prior input legally reconciles epoch 2 to the live owner and
    // stays open mid-answer, exactly like a real recovery request.
    let recoveryStarted!: () => void;
    const recoveryStartedPromise = new Promise<void>((resolve) => { recoveryStarted = resolve; });
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const recoveryPort = new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [],
      stream: async function* () {
        yield { type: 'response.output_text.delta', item_id: 'recovered-text', delta: '{"kind":' };
        recoveryStarted();
        await recoveryGate;
        yield { type: 'response.output_text.done', item_id: 'recovered-text', text: JSON.stringify({
          kind: 'answer', normalizedInput: originalRequest.rawInput, knownFacts: [],
          answer: '恢复后的答案', decisionRefs: [],
        }) };
      } });
    const recoveryInterpreter = createProviderExplicitBrainInterpreter({
      organId: scope.organId, interactionScopeId: scope.interactionScopeId,
      parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
      rawEvidence: evidence, rawContent, clock,
      helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
      binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      lease: liveLease,
      prepareAgentProvider: async () => ({
        roleId: 'interaction', source: 'http', binding, port: recoveryPort,
        provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
          model: binding.modelRef, route: 'guard-epoch-race-recovery', baseUrl: binding.endpointRef },
      }),
    });
    const recoveryOutcome = recoveryInterpreter.interpret(originalRequest).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await recoveryStartedPromise;
    const openedWhileRecovering = await parentJournal.readTurnSnapshot(turn);
    assert.deepEqual(openedWhileRecovering.ownerReconciliations.map((entry) => entry.fact.effectiveExecutionEpoch),
      [2, 3], 'the concurrent recovery opened epoch 3 before the discharge proceeds');

    // A now enters the lease guard. It must re-read the fresh epoch and refuse,
    // never close the epoch the recovery just opened.
    releaseDischarge();
    const dischargeResult = await dischargeOutcome;
    assert.equal(dischargeResult.ok, false,
      'the late discharge must refuse instead of closing the live recovered epoch');
    if (dischargeResult.ok) return;
    const dischargeError = dischargeResult.error;
    if (!(dischargeError instanceof Error)) {
      throw new Error('the discharge refusal must carry an Error');
    }
    assert.match(dischargeError.message, /exact prior input/);
    assert.match(dischargeError.message, /still the current active lease owner/);

    const afterRefusal = await parentJournal.readTurnSnapshot(turn);
    assert.equal(afterRefusal.executionFailure, null, 'the live recovered epoch is never closed as failed');
    assert.equal(afterRefusal.abandonment, null, 'the reconciled turn is never abandoned');
    assert.deepEqual(afterRefusal.providerSettlements, [], 'the refusal fabricates no settlement');
    assert.equal(afterRefusal.resourceClose, null, 'the refusal fabricates no resource close');
    assert.deepEqual(afterRefusal.ownerReconciliations.map((entry) => entry.fact.effectiveExecutionEpoch), [2, 3]);
    assert.deepEqual(await parentJournal.readScopeExecutionFailures(scope), [],
      'no epoch 3 execution failure is ever recorded for the active request');
    assert.deepEqual(await parentJournal.readScopeAbandonedTurns(scope), [],
      'no epoch 3 abandonment is ever recorded for the active request');

    // The recovered epoch still owns its raw history and finishes normally.
    releaseRecovery();
    const recoveryResult = await recoveryOutcome;
    assert.equal(recoveryResult.ok, true, 'the recovered epoch can still append its facts and finish');
    if (!recoveryResult.ok) return;
    assert.equal(recoveryResult.value.kind, 'answer');
    if (recoveryResult.value.kind !== 'answer') return;
    assert.equal(recoveryResult.value.answer, '恢复后的答案');
    const finalSnapshot = await parentJournal.readTurnSnapshot(turn);
    assert.equal(finalSnapshot.executionFailure, null);
    assert.deepEqual(finalSnapshot.ownerReconciliations.map((entry) => entry.fact.effectiveExecutionEpoch), [2, 3]);
    assert.ok(finalSnapshot.acceptedFacts.some((entry) =>
      entry.fact.envelope.execution.executionEpoch === 3 && entry.fact.envelope.fact.kind === 'request-complete'),
    'the recovered epoch keeps its own terminal fact');
    assert.ok(await helperJournal.readSemanticCheckpointExact(turn));
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

test('provider explicit brain interpreter discharges a turn whose committed owner is two generations behind', async () => {
  const root = join(parentFixtureRoot, `stranded-generation-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-stranded-generation', providerId: 'provider-stranded-generation', protocol: 'responses',
    endpointRef: 'recorded://stranded-generation', modelRef: 'model-stranded-generation',
    configDigest: 'sha256:stranded-generation-config', capabilityDigest: 'sha256:stranded-generation-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:stranded-generation' };
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    // Generation 1 owns the turn and dies. Generation 2 takes over and records
    // the receipt that proves generation 1 stopped.
    const firstCrash = await acquireCrashedOwnerLease(root);
    assert.equal(firstCrash.generation, 1);
    const gen2 = await acquireDaemonLease(paths, { takeover: {
      reason: 'stranded generation test first takeover', allowed: () => true,
      stop: { gracefulTimeoutMs: 2_000, pollIntervalMs: 20 },
    } });
    assert.equal(gen2.record.generation, 2);
    assert.equal(gen2.record.takeover?.previousGeneration, 1);
    assert.equal(gen2.record.takeover?.termination, 'already-dead');
    await gen2.release();
    // Generations 3 and 4 replay the same shape one step later: the surviving
    // takeover record now describes generation 3 only, exactly like production
    // where generation 17 was overwritten by generations 18..23.
    const secondCrash = await acquireCrashedOwnerLease(root);
    assert.equal(secondCrash.generation, 3);
    lease = await acquireDaemonLease(paths, { takeover: {
      reason: 'stranded generation test second takeover', allowed: () => true,
      stop: { gracefulTimeoutMs: 2_000, pollIntervalMs: 20 },
    } });
    assert.equal(lease.record.generation, 4);
    assert.equal(lease.record.takeover?.previousGeneration, 3);
    assert.equal(lease.record.takeover?.termination, 'already-dead');

    const strandedInput = JSON.stringify({
      interactionId: 'interaction-stranded-generation', inputRevision: 1, sourceRef: 'ui:stranded-generation',
      rawInput: '两代之前崩溃的纯推理', clarifications: [], taskCandidates: [],
    });
    const seeded = await seedInterruptedParentTurn({
      parentJournal, evidence, rawContent, binding, scope,
      interactionId: 'interaction-stranded-generation', turnId: 'explicit-interpret-stranded-generation',
      initialInputText: strandedInput, executionOwner: firstCrash.owner,
    });
    const interpreterOptions = {
      parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
      rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
      helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
      binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    };
    const served = await createProviderExplicitBrainInterpreter({ ...interpreterOptions,
      organId: scope.organId, interactionScopeId: scope.interactionScopeId, lease,
      port: new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [
        { kind: 'output', state: 'output', summary: JSON.stringify({
          kind: 'requirement', normalizedInput: '两代之后的新输入', knownFacts: [],
          proposal: { revision: 1, intent: 'create', title: '两代之后的新输入', objective: '两代之后的新输入',
            deliverable: '结果', deliveryConditions: [], evidenceRefs: [], blockingGaps: [] },
          decisionRefs: [],
        }) },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ] }) }).interpret({
        interactionId: 'interaction-stranded-generation-next', inputRevision: 1,
        sourceRef: 'ui:stranded-generation-next', rawInput: '两代之后的新输入',
        clarifications: [], taskCandidates: [],
      });
    assert.equal(served.kind, 'requirement');
    const abandoned = await parentJournal.readScopeAbandonedTurns(scope);
    assert.equal(abandoned.length, 1, 'the stranded turn is discharged exactly once');
    assert.deepEqual(abandoned[0]!.fact.turn, seeded.turn);
    assert.equal(abandoned[0]!.fact.reason, 'provider-interrupted-without-terminal-output');
    const snapshot = await parentJournal.readTurnSnapshot(seeded.turn);
    assert.equal(snapshot.resourceClose, null, 'the discharge never fabricates a close');
    // The proof is durable, not the incident: the lease keeps every termination
    // receipt it ever wrote, so the next generation still answers for it.
    assert.deepEqual(
      (await readDaemonLease(paths) as { terminations?: readonly { previousGeneration: number }[] } | undefined)
        ?.terminations?.map((entry) => entry.previousGeneration),
      [1, 2, 3],
      'each takeover receipt stays in the durable lease history',
    );

    // A committed owner that is genuinely outside the retained history keeps an
    // explicit, diagnosable refusal: the same generation number under a lease
    // id this daemon never terminated is not proof.
    const evictedScope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:stranded-generation-evicted' };
    await seedInterruptedParentTurn({
      parentJournal, evidence, rawContent, binding, scope: evictedScope,
      interactionId: 'interaction-stranded-evicted', turnId: 'explicit-interpret-stranded-evicted',
      initialInputText: JSON.stringify({
        interactionId: 'interaction-stranded-evicted', inputRevision: 1, sourceRef: 'ui:stranded-evicted',
        rawInput: '窗口之外的旧 owner', clarifications: [], taskCandidates: [],
      }),
      executionOwner: { daemonLeaseId: 'lease-outside-retained-window', daemonGeneration: 1, processStartToken: 'node:outside-window' },
    });
    await assert.rejects(
      () => createProviderExplicitBrainInterpreter({ ...interpreterOptions,
        organId: evictedScope.organId, interactionScopeId: evictedScope.interactionScopeId, lease,
        port: new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [] }) }).interpret({
          interactionId: 'interaction-stranded-evicted-next', inputRevision: 1,
          sourceRef: 'ui:stranded-evicted-next', rawInput: '窗口之外的新输入',
          clarifications: [], taskCandidates: [],
        }),
      (error: unknown) => error instanceof Error
        && /has no durable termination receipt/.test(error.message)
        && /committed generation 1/.test(error.message)
        && /current generation 4/.test(error.message)
        && /retained takeover receipts cover generations/.test(error.message),
    );
    assert.deepEqual(await parentJournal.readScopeAbandonedTurns(evictedScope), [],
      'an unprovable owner keeps recovery responsibility');
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: the exact-input retry of an already closed parent turn used to
// be the only recovery path. A fix that discharges every pending turn would
// silently drop real terminal output. Impact: a duplicated Provider generation
// and a lost delivered answer. Cost: one seeded closed turn and one cold read.
test('provider explicit brain interpreter keeps exact-input cold recovery for a closed parent turn', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-exact-recovery', providerId: 'provider-exact-recovery', protocol: 'responses',
    endpointRef: 'recorded://exact-recovery', modelRef: 'model-exact-recovery',
    configDigest: 'sha256:exact-recovery-config', capabilityDigest: 'sha256:exact-recovery-capability',
  };
  const scope = { organId: deps.organId, interactionScopeId: deps.interactionScopeId };
  const exactRequest = {
    interactionId: 'interaction-exact-recovery', inputRevision: 1, sourceRef: 'ui:exact-recovery',
    rawInput: '只回答 4', clarifications: [], taskCandidates: [],
  };
  const operationScope = { organId: scope.organId, operationId: id('operation', 'op-exact-recovery') };
  const turn: InteractionTurnIdentity = {
    organId: scope.organId, interactionScopeId: scope.interactionScopeId,
    interactionId: exactRequest.interactionId, inputRevision: 1, turnId: 'explicit-interpret-exact-recovery',
  };
  const execution = { runtimeId: turn.turnId, ...operationScope, executionEpoch: 1, interactionTurn: turn };
  const initialInput = {
    ref: await deps.rawEvidence.write({
      scope: operationScope, kind: 'execution', type: 'initial-input',
      locator: turn.turnId, content: JSON.stringify(exactRequest),
    }),
    view: { kind: 'utf8-text' as const },
  };
  const owner = createInteractionParentTurnRawOwner({
    turn, execution, scope: operationScope, initialInput, providerBinding: binding,
    executionOwner: { daemonLeaseId: 'lease-exact-recovery', daemonGeneration: 1, processStartToken: 'process-exact-recovery' },
    journal: deps.parentJournal, rawContent: deps.rawContent,
  });
  await owner.openTurnInput();
  const request = { turnId: turn.turnId, requestId: 'exact-recovery-request' };
  await owner.registerRequest({ execution, record: { request, scope: operationScope, phase: 'dispatching' } });
  await owner.registerRequest({ execution, record: { request, scope: operationScope, phase: 'dispatched' } });
  const answerText = JSON.stringify({
    kind: 'answer', normalizedInput: exactRequest.rawInput, knownFacts: [], answer: '4', decisionRefs: [],
  });
  await owner.acceptRawFact({
    execution, scope: operationScope, request, producerSeq: 1,
    fact: {
      kind: 'content', channel: 'assistant-text', update: 'full', contentUnitId: 'answer',
      content: { ref: await deps.rawEvidence.write({
        scope: operationScope, kind: 'execution', type: 'answer', locator: 'answer', content: answerText,
      }), view: { kind: 'utf8-text' as const } },
      complete: true,
    },
  });
  await owner.acceptRawFact({
    execution, scope: operationScope, request, producerSeq: 2,
    fact: { kind: 'request-complete', terminal: 'completed' },
  });
  await owner.registerRequest({ execution, record: { request, scope: operationScope, phase: 'settled' } });
  await owner.recordProviderClose({
    providerBinding: binding,
    result: {
      bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol,
      state: 'closed',
      evidenceRefs: [await deps.rawEvidence.write({
        scope: operationScope, kind: 'execution', type: 'close', locator: 'close', content: 'closed',
      })],
    },
    closedAt: new Date().toISOString(),
  });
  assert.equal((await deps.parentJournal.readTurnSnapshot(turn)).abandonment, null);
  let providerStarts = 0;
  const deadPort = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [] });
  deadPort.start = async () => { providerStarts += 1; throw new Error('unexpected provider start'); };
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), port: deadPort,
  });
  // A closed turn with real terminal output is recoverable, not dischargeable.
  await assert.rejects(
    () => interpreter.interpret({ ...exactRequest, rawInput: 'different input' }),
    (error: unknown) => error instanceof Error
      && error.message.includes('exact prior input')
      && error.message.includes('resource close is already committed'),
  );
  assert.deepEqual(await deps.parentJournal.readScopeAbandonedTurns(scope), []);
  // The exact prior input keeps the existing cold terminal-output recovery.
  const recovered = await interpreter.interpret(exactRequest);
  assert.equal(recovered.kind, 'answer');
  if (recovered.kind !== 'answer') throw new Error('expected recovered answer');
  assert.equal(recovered.answer, '4');
  assert.ok(await deps.helperJournal.readSemanticCheckpointExact(turn));
  assert.equal(providerStarts, 0, 'cold terminal recovery never starts a Provider');
  const recoveredSnapshot = await deps.parentJournal.readTurnSnapshot(turn);
  assert.equal(recoveredSnapshot.abandonment, null);
  assert.equal(recoveredSnapshot.resourceClose?.fact.result.state, 'closed');
});

// Failure basis: an unknown tool side effect must never be discharged. The
// interrupted turn committed a tool call without its result, so its physical
// effect is unknown and different input must keep the explicit boundary.
// Impact: silently dropping a dispatched side effect. Cost: one seeded call.
test('provider explicit brain interpreter refuses to discharge an interrupted turn with an unpaired tool call', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-unpaired-tool', providerId: 'provider-unpaired-tool', protocol: 'responses',
    endpointRef: 'recorded://unpaired-tool', modelRef: 'model-unpaired-tool',
    configDigest: 'sha256:unpaired-tool-config', capabilityDigest: 'sha256:unpaired-tool-capability',
  };
  const scope = { organId: deps.organId, interactionScopeId: deps.interactionScopeId };
  const seeded = await seedInterruptedParentTurn({
    parentJournal: deps.parentJournal, evidence: deps.rawEvidence, rawContent: deps.rawContent,
    binding, scope, interactionId: 'interaction-unpaired-tool', turnId: 'explicit-interpret-unpaired-tool',
    initialInputText: JSON.stringify({ interactionId: 'interaction-unpaired-tool', inputRevision: 1, rawInput: 'old' }),
    executionOwner: { daemonLeaseId: 'lease-unpaired', daemonGeneration: 1, processStartToken: 'process-unpaired' },
    unpairedToolCall: true,
  });
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new RecordedParentPort({ binding, stepDelayMs: 0, replay: [] }),
  });
  await assert.rejects(
    () => interpreter.interpret({
      interactionId: 'interaction-after-unpaired', inputRevision: 1, sourceRef: 'ui:after-unpaired',
      rawInput: 'new input after unpaired tool call', clarifications: [], taskCandidates: [],
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes('exact prior input')
      && error.message.includes('tool call call-1 has no committed result'),
  );
  assert.deepEqual(await deps.parentJournal.readScopeAbandonedTurns(scope), []);
  assert.equal(await deps.parentJournal.readTurnSnapshot(seeded.turn).then((snapshot) => snapshot.abandonment), null);
});

// Failure basis: a turn without the committed provider binding or the
// authenticated execution owner cannot prove it has no recoverable remote
// state, so it must never be discharged. Impact: discarding a potentially
// recoverable turn. Cost: two legacy-shaped seeds.
test('provider explicit brain interpreter refuses to discharge a turn without binding or execution owner', async () => {
  const binding: ProviderBinding = {
    bindingId: 'binding-legacy-interrupted', providerId: 'provider-legacy-interrupted', protocol: 'responses',
    endpointRef: 'recorded://legacy-interrupted', modelRef: 'model-legacy-interrupted',
    configDigest: 'sha256:legacy-interrupted-config', capabilityDigest: 'sha256:legacy-interrupted-capability',
  };
  const seedWithoutBinding = async () => {
    const deps = parentDependencies();
    const scope = { organId: deps.organId, interactionScopeId: deps.interactionScopeId };
    await seedInterruptedParentTurn({
      parentJournal: deps.parentJournal, evidence: deps.rawEvidence, rawContent: deps.rawContent,
      binding, scope, interactionId: 'interaction-no-binding', turnId: 'explicit-interpret-no-binding',
      initialInputText: JSON.stringify({ interactionId: 'interaction-no-binding', inputRevision: 1, rawInput: 'old' }),
      withProviderBinding: false,
    });
    return { deps, scope };
  };
  const seedWithoutOwner = async () => {
    const deps = parentDependencies();
    const scope = { organId: deps.organId, interactionScopeId: deps.interactionScopeId };
    await seedInterruptedParentTurn({
      parentJournal: deps.parentJournal, evidence: deps.rawEvidence, rawContent: deps.rawContent,
      binding, scope, interactionId: 'interaction-no-owner', turnId: 'explicit-interpret-no-owner',
      initialInputText: JSON.stringify({ interactionId: 'interaction-no-owner', inputRevision: 1, rawInput: 'old' }),
    });
    return { deps, scope };
  };
  for (const [seed, expected] of [
    [seedWithoutBinding, 'the original committed provider binding is missing'],
    [seedWithoutOwner, 'the authenticated execution owner is missing'],
  ] as const) {
    const { deps, scope } = await seed();
    const interpreter = createProviderExplicitBrainInterpreter({
      ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
      helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
      templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      port: new RecordedParentPort({ binding, stepDelayMs: 0, replay: [] }),
    });
    await assert.rejects(
      () => interpreter.interpret({
        interactionId: 'interaction-after-legacy', inputRevision: 1, sourceRef: 'ui:after-legacy',
        rawInput: 'new input after legacy turn', clarifications: [], taskCandidates: [],
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes('exact prior input')
        && error.message.includes(expected),
    );
    assert.deepEqual(await deps.parentJournal.readScopeAbandonedTurns(scope), []);
  }
});

// Failure basis: a cancelled request is a terminal lifecycle state with known
// unknown side effects, not an interrupted stream. Impact: discharging a turn
// whose cancellation semantics still own recovery. Cost: one seeded phase.
test('provider explicit brain interpreter refuses to discharge a cancelled request', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-cancelled-turn', providerId: 'provider-cancelled-turn', protocol: 'responses',
    endpointRef: 'recorded://cancelled-turn', modelRef: 'model-cancelled-turn',
    configDigest: 'sha256:cancelled-turn-config', capabilityDigest: 'sha256:cancelled-turn-capability',
  };
  const scope = { organId: deps.organId, interactionScopeId: deps.interactionScopeId };
  await seedInterruptedParentTurn({
    parentJournal: deps.parentJournal, evidence: deps.rawEvidence, rawContent: deps.rawContent,
    binding, scope, interactionId: 'interaction-cancelled-turn', turnId: 'explicit-interpret-cancelled-turn',
    initialInputText: JSON.stringify({ interactionId: 'interaction-cancelled-turn', inputRevision: 1, rawInput: 'old' }),
    executionOwner: { daemonLeaseId: 'lease-cancelled', daemonGeneration: 1, processStartToken: 'process-cancelled' },
    requestPhase: 'cancelled',
  });
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new RecordedParentPort({ binding, stepDelayMs: 0, replay: [] }),
  });
  await assert.rejects(
    () => interpreter.interpret({
      interactionId: 'interaction-after-cancelled', inputRevision: 1, sourceRef: 'ui:after-cancelled',
      rawInput: 'new input after cancelled turn', clarifications: [], taskCandidates: [],
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes('exact prior input')
      && error.message.includes('is cancelled, not interrupted'),
  );
  assert.deepEqual(await deps.parentJournal.readScopeAbandonedTurns(scope), []);
});

test('neutral parent loops over exact raw tool pairs, with returned helper separate from explicit acceptance', async () => {
  // The old path could not dispatch helpers at all. One bounded local replay
  // catches parent/child identity pollution, autoacceptance and summary parsing.
  const dependencies = parentDependencies();
  const binding: ProviderBinding = { bindingId: 'parent-loop', providerId: 'recorded', protocol: 'responses',
    modelRef: 'parent-model', endpointRef: 'http:recorded.test', configDigest: 'sha256:parent', capabilityDigest: 'sha256:parent' };
  const childBinding = { ...binding, bindingId: 'child-loop', modelRef: 'independent-child-model' };
  const refinedText = 'parent explicitly refined the partial result';
  const dispatchObjective = 'verify exact helper checkpoint semantics';
  const dispatchSuccessCriteria = ['report every required checkpoint field'];
  const answer = `exact final ${'原始正文。'.repeat(120)}`;
  const finalText = JSON.stringify({ kind: 'answer', normalizedInput: 'parent-private', knownFacts: [], answer, decisionRefs: [] });
  const wires: any[] = [];
  let helperIdentity: Parameters<typeof dependencies.helperJournal.readExact>[0] | undefined;
  let dispatchAcceptedCommitId: string | undefined;
  let returnedCommitId: string | undefined;
  let returnedCheckpointCommitId: string | undefined;
  let dispatchStageSnapshot: Awaited<ReturnType<typeof dependencies.parentJournal.readTurnSnapshot>> | undefined;
  let childClosed = 0;
  let settlementPublished = 0;
  const parent = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], respond: async (wire) => {
    wires.push(wire);
    const results = wire.input.filter((item: any) => item.type === 'function_call_output');
    if (results.length === 0) return [
      { type: 'response.output_text.done', item_id: 'draft', text: '{"kind":"invalid-draft"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'dispatch', name: 'dispatch_helper', arguments: JSON.stringify({
        selection: { roleId: 'review', configuredAgentId: 'independent-child' },
        assignmentFields: { objective: dispatchObjective, targetRefs: [], expectedOutputRefs: [], expectedArtifactDigests: [],
          acceptanceCriteriaDigest: `sha256:${'a'.repeat(64)}`, successCriteria: dispatchSuccessCriteria, failureCriteria: ['none'], incompleteCriteria: ['partial'], requiredCapabilities: [], mergeGate: 'not-required' },
        inputs: { question: 'child-only-input' }, evidenceRefs: [],
      }) } },
    ];
    if (results.length === 1) {
      const dispatched = JSON.parse(results[0].output);
      helperIdentity = dispatched.identity;
      const handoff = await dependencies.helperJournal.readExact(dispatched.identity);
      const returned = requirePresent(handoff.returned, 'returned helper fact');
      assert.equal(handoff.ownerAccepted, null);
      assert.equal(handoff.adoptedCheckpoint, null);
      const returnedCheckpoint = requirePresent(handoff.returnedCheckpoint, 'returned helper checkpoint');
      assert.equal(returnedCheckpoint.checkpoint.phase, 'returned');
      assert.equal(returnedCheckpoint.checkpoint.recordedAt, returned.fact.returnedAt);
      assert.equal(returnedCheckpoint.checkpoint.recovery.dispatchAcceptedCommitId, dispatched.dispatchAcceptedCommitId);
      assert.equal(returnedCheckpoint.checkpoint.recovery.returnedCommitId, dispatched.returnedCommitId);
      assert.equal(returnedCheckpoint.checkpoint.recovery.ownerAcceptedCommitId, undefined);
      assert.equal(returnedCheckpoint.commit.commitId, dispatched.returnedCheckpointCommitId);
      const returnedDescription = returnedCheckpoint.checkpoint.description;
      assert.ok(returnedDescription.includes(dispatchObjective));
      for (const criterion of dispatchSuccessCriteria) {
        assert.ok(returnedDescription.includes(criterion));
      }
      assert.ok(returnedDescription.includes('owner acceptance is pending'));
      assert.ok(returnedDescription.includes('incomplete'));
      assert.ok(returnedDescription.includes('unrefined child summary'));
      assert.ok(returnedDescription.includes('wait'));
      assert.ok(returnedDescription.includes('condition:partial'));
      dispatchAcceptedCommitId = dispatched.dispatchAcceptedCommitId;
      returnedCommitId = dispatched.returnedCommitId;
      returnedCheckpointCommitId = dispatched.returnedCheckpointCommitId;
      const activeTurn = starts[0]!.interactionTurn;
      const stageSnapshot = await dependencies.parentJournal.readTurnSnapshot(activeTurn);
      dispatchStageSnapshot = stageSnapshot;
      assert.ok(stageSnapshot.acceptedFacts.length > 0);
      assert.equal(await dependencies.checkpointJournal.readSemanticCheckpointExact(activeTurn), null,
        'returned call checkpoint must not close the active turn');
      assert.equal(dispatched.result.status, 'incomplete');
      return [{ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'accept', name: 'accept_helper',
        arguments: JSON.stringify({ helperCallId: dispatched.identity.helperCallId, refinedText, acceptanceRef: 'acceptance:parent-loop', evidenceRefs: [] }) } }];
    }
    assert.deepEqual(results.map((item: any) => item.call_id), ['dispatch', 'accept']);
    const identity = requirePresent(helperIdentity, 'helper identity');
    const acceptedHandoff = await dependencies.helperJournal.readExact(identity);
    const ownerAccepted = requirePresent(acceptedHandoff.ownerAccepted, 'owner-accepted helper fact');
    assert.equal(ownerAccepted.fact.acceptanceRef, 'acceptance:parent-loop');
    assert.equal(ownerAccepted.fact.result.status, 'incomplete');
    const adoptedCheckpoint = requirePresent(acceptedHandoff.adoptedCheckpoint, 'adopted helper checkpoint');
    assert.equal(adoptedCheckpoint.checkpoint.phase, 'adopted');
    assert.equal(adoptedCheckpoint.checkpoint.description, refinedText);
    assert.equal(adoptedCheckpoint.checkpoint.recordedAt, ownerAccepted.fact.acceptedAt);
    assert.equal(adoptedCheckpoint.checkpoint.recovery.dispatchAcceptedCommitId, dispatchAcceptedCommitId);
    assert.equal(adoptedCheckpoint.checkpoint.recovery.returnedCommitId, returnedCommitId);
    assert.equal(adoptedCheckpoint.checkpoint.recovery.ownerAcceptedCommitId, ownerAccepted.commit.commitId);
    assert.equal(acceptedHandoff.returnedCheckpoint?.commit.commitId, returnedCheckpointCommitId);
    const activeTurn = starts[0]!.interactionTurn;
    const acceptedStageSnapshot = await dependencies.parentJournal.readTurnSnapshot(activeTurn);
    const stageSnapshot = requirePresent(dispatchStageSnapshot, 'dispatch stage snapshot');
    assert.deepEqual(acceptedStageSnapshot.acceptedFacts.slice(0, stageSnapshot.acceptedFacts.length), stageSnapshot.acceptedFacts);
    assert.ok(acceptedStageSnapshot.acceptedFacts.length > stageSnapshot.acceptedFacts.length);
    assert.equal(await dependencies.checkpointJournal.readSemanticCheckpointExact(activeTurn), null,
      'owner acceptance must not close the active turn');
    const acceptance = JSON.parse(results[1].output);
    const refined = acceptance.latestTurnEntry.refinedResult;
    assert.equal(new TextDecoder().decode(await dependencies.rawContent.read({ scope: refined.ref.scope, content: refined })), refinedText);
    assert.equal(acceptance.latestTurnEntry.result.status, 'incomplete');
    return [
      { type: 'response.output_text.delta', item_id: 'final', delta: '{"partial":"discard"}' },
      { type: 'response.output_text.done', item_id: 'final', text: finalText },
    ];
  } });
  const starts: Parameters<typeof parent.start>[0][] = [];
  const start = parent.start.bind(parent);
  parent.start = async (input) => {
    const snapshot = await dependencies.parentJournal.readTurnSnapshot(input.interactionTurn);
    assert.ok(snapshot.turnInput, 'input must commit before Provider start');
    assert.equal(snapshot.requests[0].fact.phase, 'dispatching');
    starts.push(input); return start(input);
  };
  const interpreter = createProviderExplicitBrainInterpreter({ ...dependencies, port: parent, binding,
    templateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
    helperFactory: async ({ selection, assignment, execution }) => {
      assert.deepEqual(selection, { roleId: 'review', configuredAgentId: 'independent-child' });
      const child = new RecordedParentPort<TasklessProviderExecutionIdentityRef>({ binding: childBinding, stepDelayMs: 0, replay: [], respond: async (wire) => {
        assert.equal(wire.model, childBinding.modelRef);
        assert.ok(JSON.stringify(wire).includes('child-only-input'));
        assert.equal(JSON.stringify(wire).includes('parent-private'), false);
        return [{ type: 'response.output_text.done', item_id: 'child', text: JSON.stringify({ agentId: 'independent-child', producedArtifactRefs: [], producedArtifactDigests: [],
          status: 'incomplete', summary: 'unrefined child summary', outputRefs: [], evidenceRefs: [], nextAction: 'wait', conditionRef: 'condition:partial' }) }];
      } });
      const childStart = child.start.bind(child);
      child.start = async (input) => { assert.equal('taskId' in input, false); assert.equal('interactionTurn' in input, false); assert.equal(input.helper.helperCallId, assignment.helperCallId); return childStart(input); };
      return { binding: childBinding, driver: new ProviderAgentDriver<TasklessProviderExecutionIdentityRef>({ port: child, binding: childBinding,
        ...execution, organId: assignment.organId, helper: assignment, assignmentId: assignment.assignmentId,
        scope: { organId: assignment.organId, operationId: execution.operationId }, inputRefs: [] }),
      close: async () => { const receipt = await child.close(childBinding); assert.equal(receipt.state, 'closed'); childClosed += 1; } };
    },
    publishProviderSettlement: async (receipt) => {
      const physicalRequest = Reflect.get(receipt, 'request') as
        | { readonly turnId?: unknown; readonly requestId?: unknown }
        | undefined;
      assert.equal(typeof physicalRequest?.turnId, 'string');
      assert.equal(typeof physicalRequest?.requestId, 'string');
      assert.ok(physicalRequest?.turnId !== receipt.settlement.interactionTurn.turnId);
      assert.equal('taskId' in receipt.settlement, false);
      assert.equal(receipt.settlement.state, 'succeeded');
      settlementPublished += 1;
    },
  });
  try {
    const result = await interpreter.interpret({ interactionId: 'loop', inputRevision: 1, sourceRef: 'test:loop', rawInput: 'parent-private', clarifications: [], taskCandidates: [] });
    assert.equal(result.kind, 'answer');
    if (result.kind !== 'answer') throw new Error('expected parent answer');
    assert.equal(result.answer, answer);
    assert.equal(starts.length, 1); assert.equal('taskId' in starts[0], false); assert.equal('helper' in starts[0], false);
    assert.equal(childClosed, 1); assert.equal(settlementPublished, 1); assert.equal(wires.length, 3);
    assert.ok(helperIdentity);
    assert.ok((await dependencies.helperJournal.readExact(helperIdentity!)).ownerAccepted);
    const finalCheckpoint = await dependencies.checkpointJournal.readSemanticCheckpointExact(starts[0]!.interactionTurn);
    assert.ok(finalCheckpoint, 'the normal final close must still commit the semantic checkpoint');
    const snapshot = await dependencies.parentJournal.readTurnSnapshot(starts[0].interactionTurn);
    for (const { fact } of snapshot.acceptedFacts) {
      if (fact.envelope.fact.kind !== 'tool-result') continue;
      const tool = fact.envelope.fact;
      const expected = wires[2].input.find((item: any) => item.type === 'function_call_output' && item.call_id === tool.callId);
      assert.equal(new TextDecoder().decode(await dependencies.rawContent.read({ scope: fact.envelope.scope, content: tool.rawOutput })), expected.output);
    }
  } finally {
    const receipt = await parent.close(binding); assert.equal(receipt.state, 'closed');
  }
});

// Failure basis: the helper tool entry asserted EvidenceRef and roleId inside
// tool execution, outside the model-correctable tool result shape. One invalid
// model argument therefore threw a bare ContractError/TypeError: the interpret
// call failed with a 500 and the turn kept a tool call without a committed
// result. Impact: a single malformed helper argument bricks the interaction.
// Cost: one recorded parent run with three rejected rounds and one valid retry.
test('provider explicit brain returns invalid helper tool arguments to the model and completes after a valid retry', async () => {
  const dependencies = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-helper-args', providerId: 'provider-helper-args', protocol: 'responses',
    endpointRef: 'recorded://helper-args', modelRef: 'model-helper-args',
    configDigest: 'sha256:helper-args-config', capabilityDigest: 'sha256:helper-args-capability',
  };
  const childBinding = { ...binding, bindingId: 'child-helper-args', modelRef: 'model-child-helper-args' };
  const finalAnswer = `validated helper ${'answer body '.repeat(80)}`;
  const finalText = JSON.stringify({ kind: 'answer', normalizedInput: 'helper argument validation', knownFacts: [], answer: finalAnswer, decisionRefs: [] });
  const assignmentFields = {
    objective: 'verify helper argument validation', targetRefs: [], expectedOutputRefs: [],
    successCriteria: ['return one bounded result'], failureCriteria: ['none'], incompleteCriteria: ['partial'],
    requiredCapabilities: [], mergeGate: 'not-required',
  };
  const invalidCalls = ['invalid-evidence-id', 'missing-evidence-id', 'invalid-role'];
  const dispatchCall = (callId: string, value: Readonly<Record<string, unknown>>) => ({
    type: 'response.output_item.done', output_index: 1,
    item: { type: 'function_call', call_id: callId, name: 'dispatch_helper', arguments: JSON.stringify(value) },
  });
  const wires: any[] = [];
  const toolOutputs = new Map<string, any>();
  const parent = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], respond: async (wire) => {
    wires.push(wire);
    const results = wire.input.filter((item: any) => item.type === 'function_call_output');
    for (const result of results) {
      // The wire carries the accepted evidence footer after the JSON output;
      // parse the tool result payload itself, not the footer decoration.
      if (!toolOutputs.has(result.call_id)) toolOutputs.set(result.call_id, JSON.parse(String(result.output).split('\n[HumanAgent evidence refs]')[0]!));
    }
    if (results.length === 0) {
      return [dispatchCall('invalid-evidence-id', {
        selection: { roleId: 'review', configuredAgentId: 'independent-child' }, assignmentFields,
        inputs: { question: 'child-only-input' },
        evidenceRefs: [{
          evidenceId: { scope: 'evidence', value: '' }, kind: 'tool', source: 'parent',
          locator: 'parent://invalid-evidence-id', scope: { organId: { scope: 'organ', value: 'explicit-test' } },
        }],
      })];
    }
    if (results.length === 1) {
      return [dispatchCall('missing-evidence-id', {
        selection: { roleId: 'review', configuredAgentId: 'independent-child' }, assignmentFields,
        inputs: { question: 'child-only-input' },
        evidenceRefs: [{
          kind: 'tool', source: 'parent', locator: 'parent://missing-evidence-id',
          scope: { organId: { scope: 'organ', value: 'explicit-test' } },
        }],
      })];
    }
    if (results.length === 2) {
      return [dispatchCall('invalid-role', {
        selection: { roleId: 'reviewer' }, assignmentFields,
        inputs: { question: 'child-only-input' }, evidenceRefs: [],
      })];
    }
    if (results.length === 3) {
      return [dispatchCall('valid-dispatch', {
        selection: { roleId: 'review', configuredAgentId: 'independent-child' }, assignmentFields,
        inputs: { question: 'child-only-input' }, evidenceRefs: [],
      })];
    }
    if (results.length === 4) {
      const dispatched = toolOutputs.get('valid-dispatch');
      assert.ok(dispatched?.identity?.helperCallId, 'the valid dispatch must return a helper identity');
      return [{ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'accept-valid', name: 'accept_helper',
        arguments: JSON.stringify({ helperCallId: dispatched.identity.helperCallId, refinedText: 'validated helper result', acceptanceRef: 'acceptance:helper-args', evidenceRefs: [] }) } }];
    }
    assert.equal(results.length, 5);
    return [{ type: 'response.output_text.done', item_id: 'final', text: finalText }];
  } });
  const starts: Parameters<typeof parent.start>[0][] = [];
  const start = parent.start.bind(parent);
  parent.start = async (input) => { starts.push(input); return start(input); };
  const interpreter = createProviderExplicitBrainInterpreter({ ...dependencies, port: parent, binding,
    templateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
    helperFactory: async ({ selection, assignment, execution }) => {
      assert.deepEqual(selection, { roleId: 'review', configuredAgentId: 'independent-child' });
      const child = new RecordedParentPort<TasklessProviderExecutionIdentityRef>({ binding: childBinding, stepDelayMs: 0, replay: [], respond: async () => [{
        type: 'response.output_text.done', item_id: 'child',
        text: JSON.stringify({ agentId: 'independent-child', producedArtifactRefs: [], producedArtifactDigests: [],
          status: 'succeeded', summary: 'validated child summary', outputRefs: [], evidenceRefs: [], nextAction: 'wait', conditionRef: 'condition:validated' }),
      }] });
      return { binding: childBinding, driver: new ProviderAgentDriver<TasklessProviderExecutionIdentityRef>({ port: child, binding: childBinding,
        ...execution, organId: assignment.organId, helper: assignment, assignmentId: assignment.assignmentId,
        scope: { organId: assignment.organId, operationId: execution.operationId }, inputRefs: [] }),
      close: async () => { const receipt = await child.close(childBinding); assert.equal(receipt.state, 'closed'); } };
    },
  });
  try {
    const result = await interpreter.interpret({
      interactionId: 'helper-args', inputRevision: 1, sourceRef: 'test:helper-args',
      rawInput: 'helper argument validation', clarifications: [], taskCandidates: [],
    });
    assert.equal(result.kind, 'answer');
    if (result.kind !== 'answer') throw new Error('expected the retried turn to answer');
    assert.equal(result.answer, finalAnswer);
    for (const callId of invalidCalls) {
      const output = toolOutputs.get(callId);
      assert.equal(output.status, 'failed', `${callId} must return a failed tool result`);
      assert.equal(output.code, 'tool.argument.invalid');
      assert.equal(output.recoverable, true);
    }
    assert.ok(String(toolOutputs.get('invalid-evidence-id').message).includes('evidenceId'));
    assert.ok(String(toolOutputs.get('missing-evidence-id').message).includes('evidenceId'));
    assert.ok(String(toolOutputs.get('invalid-role').message).includes('roleId'));
    const turn = starts[0]!.interactionTurn;
    const snapshot = await dependencies.parentJournal.readTurnSnapshot(turn);
    const facts = snapshot.acceptedFacts.map(({ fact }) => fact.envelope.fact);
    const resultCallIds = facts.flatMap((fact) => fact.kind === 'tool-result' ? [fact.callId] : []);
    for (const callId of [...invalidCalls, 'valid-dispatch', 'accept-valid']) {
      assert.ok(resultCallIds.includes(callId), `${callId} must have a committed tool result so the turn stays paired`);
    }
    for (const fact of facts) {
      if (fact.kind !== 'tool-result' || !invalidCalls.includes(fact.callId)) continue;
      assert.equal(fact.result.status, 'failed');
      assert.equal(fact.result.error?.category, 'validation');
      assert.equal(fact.result.error?.retryable, 'retryable');
      assert.equal(fact.result.error?.nextAction.kind, 'continue');
    }
    assert.ok(await dependencies.checkpointJournal.readSemanticCheckpointExact(turn), 'the completed turn must still commit its semantic checkpoint');
    assert.equal(wires.length, 6);
  } finally {
    const receipt = await parent.close(binding); assert.equal(receipt.state, 'closed');
  }
});

// Failure basis: the tool entry only checked objective and each successCriteria
// entry, so an empty successCriteria or a missing mergeGate still passed the
// tool entry and failed inside the helper assignment contract only after the
// factory had already acquired a provider. That bare ContractError left the
// tool call unpaired and wedged the turn. Impact: one malformed assignment
// argument strands the interaction. Cost: one recorded parent run with two
// rejected rounds and one valid retry.
test('provider explicit brain rejects incomplete helper assignment fields before the helper factory', async () => {
  const dependencies = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-assignment-fields', providerId: 'provider-assignment-fields', protocol: 'responses',
    endpointRef: 'recorded://assignment-fields', modelRef: 'model-assignment-fields',
    configDigest: 'sha256:assignment-fields-config', capabilityDigest: 'sha256:assignment-fields-capability',
  };
  const childBinding = { ...binding, bindingId: 'child-assignment-fields', modelRef: 'model-child-assignment-fields' };
  const finalAnswer = `assignment fields ${'answer body '.repeat(80)}`;
  const finalText = JSON.stringify({ kind: 'answer', normalizedInput: 'helper assignment fields', knownFacts: [], answer: finalAnswer, decisionRefs: [] });
  const assignmentFields = {
    objective: 'verify helper assignment fields', targetRefs: [], expectedOutputRefs: [],
    successCriteria: ['return one bounded result'], failureCriteria: ['none'], incompleteCriteria: ['partial'],
    requiredCapabilities: [], mergeGate: 'not-required',
  };
  const invalidCalls = ['empty-success-criteria', 'missing-merge-gate'];
  const dispatchCall = (callId: string, value: Readonly<Record<string, unknown>>) => ({
    type: 'response.output_item.done', output_index: 1,
    item: { type: 'function_call', call_id: callId, name: 'dispatch_helper', arguments: JSON.stringify(value) },
  });
  const wires: any[] = [];
  const toolOutputs = new Map<string, any>();
  let factoryCalls = 0;
  const parent = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], respond: async (wire) => {
    wires.push(wire);
    const results = wire.input.filter((item: any) => item.type === 'function_call_output');
    for (const result of results) {
      if (!toolOutputs.has(result.call_id)) toolOutputs.set(result.call_id, JSON.parse(String(result.output).split('\n[HumanAgent evidence refs]')[0]!));
    }
    if (results.length === 0) {
      return [dispatchCall('empty-success-criteria', {
        selection: { roleId: 'review', configuredAgentId: 'independent-child' },
        assignmentFields: { ...assignmentFields, successCriteria: [] },
        inputs: { question: 'child-only-input' }, evidenceRefs: [],
      })];
    }
    if (results.length === 1) {
      assert.equal(factoryCalls, 0, 'an empty successCriteria must fail before the helper factory is acquired');
      const withoutMergeGate: Record<string, unknown> = { ...assignmentFields };
      delete withoutMergeGate.mergeGate;
      return [dispatchCall('missing-merge-gate', {
        selection: { roleId: 'review', configuredAgentId: 'independent-child' },
        assignmentFields: withoutMergeGate,
        inputs: { question: 'child-only-input' }, evidenceRefs: [],
      })];
    }
    if (results.length === 2) {
      assert.equal(factoryCalls, 0, 'a missing mergeGate must fail before the helper factory is acquired');
      return [dispatchCall('valid-dispatch', {
        selection: { roleId: 'review', configuredAgentId: 'independent-child' }, assignmentFields,
        inputs: { question: 'child-only-input' }, evidenceRefs: [],
      })];
    }
    if (results.length === 3) {
      const dispatched = toolOutputs.get('valid-dispatch');
      assert.ok(dispatched?.identity?.helperCallId, 'the valid dispatch must return a helper identity');
      return [{ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'accept-valid', name: 'accept_helper',
        arguments: JSON.stringify({ helperCallId: dispatched.identity.helperCallId, refinedText: 'validated assignment fields', acceptanceRef: 'acceptance:assignment-fields', evidenceRefs: [] }) } }];
    }
    assert.equal(results.length, 4);
    return [{ type: 'response.output_text.done', item_id: 'final', text: finalText }];
  } });
  const starts: Parameters<typeof parent.start>[0][] = [];
  const start = parent.start.bind(parent);
  parent.start = async (input) => { starts.push(input); return start(input); };
  const interpreter = createProviderExplicitBrainInterpreter({ ...dependencies, port: parent, binding,
    templateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
    helperFactory: async ({ selection, assignment, execution }) => {
      factoryCalls += 1;
      assert.deepEqual(selection, { roleId: 'review', configuredAgentId: 'independent-child' });
      const child = new RecordedParentPort<TasklessProviderExecutionIdentityRef>({ binding: childBinding, stepDelayMs: 0, replay: [], respond: async () => [{
        type: 'response.output_text.done', item_id: 'child',
        text: JSON.stringify({ agentId: 'independent-child', producedArtifactRefs: [], producedArtifactDigests: [],
          status: 'succeeded', summary: 'validated child summary', outputRefs: [], evidenceRefs: [], nextAction: 'wait', conditionRef: 'condition:validated' }),
      }] });
      return { binding: childBinding, driver: new ProviderAgentDriver<TasklessProviderExecutionIdentityRef>({ port: child, binding: childBinding,
        ...execution, organId: assignment.organId, helper: assignment, assignmentId: assignment.assignmentId,
        scope: { organId: assignment.organId, operationId: execution.operationId }, inputRefs: [] }),
      close: async () => { const receipt = await child.close(childBinding); assert.equal(receipt.state, 'closed'); } };
    },
  });
  try {
    const result = await interpreter.interpret({
      interactionId: 'assignment-fields', inputRevision: 1, sourceRef: 'test:assignment-fields',
      rawInput: 'helper assignment fields', clarifications: [], taskCandidates: [],
    });
    assert.equal(result.kind, 'answer');
    if (result.kind !== 'answer') throw new Error('expected the retried turn to answer');
    assert.equal(result.answer, finalAnswer);
    assert.equal(factoryCalls, 1, 'only the valid dispatch may acquire a helper factory');
    for (const callId of invalidCalls) {
      const output = toolOutputs.get(callId);
      assert.equal(output.status, 'failed', `${callId} must return a failed tool result`);
      assert.equal(output.code, 'tool.argument.invalid');
      assert.equal(output.recoverable, true);
    }
    assert.ok(String(toolOutputs.get('empty-success-criteria').message).includes('successCriteria'));
    assert.ok(String(toolOutputs.get('missing-merge-gate').message).includes('mergeGate'));
    const turn = starts[0]!.interactionTurn;
    const snapshot = await dependencies.parentJournal.readTurnSnapshot(turn);
    const facts = snapshot.acceptedFacts.map(({ fact }) => fact.envelope.fact);
    const resultCallIds = facts.flatMap((fact) => fact.kind === 'tool-result' ? [fact.callId] : []);
    for (const callId of [...invalidCalls, 'valid-dispatch', 'accept-valid']) {
      assert.ok(resultCallIds.includes(callId), `${callId} must have a committed tool result so the turn stays paired`);
    }
    for (const fact of facts) {
      if (fact.kind !== 'tool-result' || !invalidCalls.includes(fact.callId)) continue;
      assert.equal(fact.result.status, 'failed');
      assert.equal(fact.result.error?.category, 'validation');
      assert.equal(fact.result.error?.retryable, 'retryable');
      assert.equal(fact.result.error?.nextAction.kind, 'continue');
    }
    assert.ok(await dependencies.checkpointJournal.readSemanticCheckpointExact(turn), 'the completed turn must still commit its semantic checkpoint');
    assert.equal(wires.length, 5);
  } finally {
    const receipt = await parent.close(binding); assert.equal(receipt.state, 'closed');
  }
});

test('provider explicit brain interpreter accepts the live requirement contract with intent owned by proposal', async () => {
  const binding: ProviderBinding = {
    bindingId: 'binding-explicit-live-requirement',
    providerId: 'provider-explicit-live-requirement',
    protocol: 'responses',
    endpointRef: 'fake://explicit-live-requirement',
    modelRef: 'model-explicit-live-requirement',
    configDigest: 'sha256:explicit-live-requirement-config',
    capabilityDigest: 'sha256:explicit-live-requirement-capability',
  };
  const options = {
    ...parentDependencies(),
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new RecordedParentPort({
      binding,
      stepDelayMs: 0,
      replay: [
        {
          kind: 'output',
          state: 'output',
          summary: JSON.stringify({
            kind: 'requirement',
            normalizedInput: '只读整理项目启动检查清单并提出待审核的项目记忆候选',
            knownFacts: ['输入来自 ui:new-task', '交付命令必须来自实际文件'],
            proposal: {
              revision: 1,
              intent: 'create',
              title: 'HumanAgent 项目中文启动检查清单',
              objective: '读取项目文档并整理有来源的启动检查清单',
              deliverable: '一份可查看的中文 Markdown 启动检查清单',
              deliveryConditions: ['每条命令和结论均标注文件路径与行号'],
              evidenceRefs: ['ui:new-task', 'interaction-1#inputRevision=1'],
              blockingGaps: ['尚未读取 README.md 与 package.json'],
            },
            decisionRefs: ['interaction-1#sourceRef=ui:new-task'],
          }),
        },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ],
    }),
  };
  let borrowedCloses = 0;
  const close = options.port.close.bind(options.port);
  options.port.close = async (binding) => { borrowedCloses += 1; return close(binding); };
  const interpreter = createProviderExplicitBrainInterpreter(options);

  const result = await interpreter.interpret({
    interactionId: 'interaction-1',
    inputRevision: 1,
    sourceRef: 'ui:new-task',
    rawInput: '整理项目启动检查清单',
    clarifications: [],
    taskCandidates: [],
  });

  assert.equal(result.kind, 'requirement');
  if (result.kind !== 'requirement') throw new Error('expected requirement interpretation');
  assert.equal(result.intent, 'create');
  assert.match(result.proposal, /HumanAgent 项目中文启动检查清单/);
  assert.equal(borrowedCloses, 0);

  // Successful-path close rejects directly and gets exactly one attempt.
  const closeError = new Error('successful interpretation close rejection');
  let ownCloses = 0;
  options.port.close = async (binding) => { ownCloses += 1; await close(binding); throw closeError; };
  const ownedInterpreter = createProviderExplicitBrainInterpreter({ ...options,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http', binding, port: options.port,
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'existing-fixture', baseUrl: binding.endpointRef } }),
  });
  await assert.rejects(() => ownedInterpreter.interpret({ interactionId: 'interaction-close', inputRevision: 1,
    sourceRef: 'ui:new-task', rawInput: '整理项目启动检查清单', clarifications: [], taskCandidates: [] }),
  (error: unknown) => error === closeError);
  assert.equal(ownCloses, 1);
});

test('provider explicit brain interpreter persists the original owner close receipt and reuses it on an exact retry', async () => {
  // Failure basis: the App discards the real close receipt, so a physical close
  // is not durable and a retry could close the same owner twice. Impact: lost
  // recovery evidence and a duplicated physical close. Cost: one extra owned
  // close on the existing real JSONL consumer, no new fixture framework.
  await mkdir(parentFixtureRoot, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-parent-close', providerId: 'provider-parent-close', protocol: 'responses',
    endpointRef: 'fake://parent-close', modelRef: 'model-parent-close',
    configDigest: 'sha256:parent-close-config', capabilityDigest: 'sha256:parent-close-capability',
  };
  const fixedNow = '2026-10-16T00:00:00.000Z';
  const journalFile = join(parentFixtureRoot, `parent-close-${randomUUID()}.jsonl`);
  const journal = new JsonlOrganJournal(journalFile);
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };
  const base = parentDependencies();
  const options = {
    ...base, binding, parentJournal, helperJournal, checkpointJournal: helperJournal,
    clock: { now: () => fixedNow },
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
  };
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [
    { kind: 'output', state: 'output', summary: JSON.stringify({ kind: 'answer', normalizedInput: 'echo', knownFacts: [], answer: 'original-answer', decisionRefs: [] }) },
    { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
  ] });
  const receipts: ProviderCloseResult[] = [];
  const close = port.close.bind(port);
  port.close = async (bind) => { const receipt = await close(bind); receipts.push(receipt); return receipt; };
  const interpreter = createProviderExplicitBrainInterpreter({
    ...options, port,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'parent-close-fixture', baseUrl: binding.endpointRef },
      binding, port }),
  });

  const result = await interpreter.interpret({
    interactionId: 'parent-close-1', inputRevision: 1, sourceRef: 'ui:new-task',
    rawInput: 'answer this', clarifications: [], taskCandidates: [],
  });
  assert.equal(result.kind, 'answer');
  assert.equal(receipts.length, 1, 'the owned provider is closed exactly once');

  const opened = await parentJournal.readScopeOpenedTurns(scope);
  assert.equal(opened.length, 1);
  const committedInput = opened[0]!.fact;
  assert.deepEqual(committedInput.providerBinding, binding, 'the new turn freezes the actual binding');
  const snapshot = await parentJournal.readTurnSnapshot(committedInput.turn);
  assert.ok(snapshot.resourceClose, 'the real owner close must be durably recorded');
  if (snapshot.resourceClose === null) throw new Error('missing resource close');
  // The receipt is read back from the Journal, so it is a durable value copy:
  // compare it by value, never by object reference identity.
  assert.deepEqual(snapshot.resourceClose.fact.result, receipts[0], 'the exact original receipt must be persisted');
  assert.deepEqual(snapshot.resourceClose.fact.providerBinding, binding);
  assert.deepEqual(snapshot.resourceClose.fact.turn, committedInput.turn);
  assert.equal(snapshot.resourceClose.fact.closedAt, fixedNow);

  // Durable replay through a fresh journal instance and a fresh owner: an exact
  // retry returns the first closedAt and commit and appends no second record.
  const replayedParentJournal = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile));
  const turnInputFact = snapshot.turnInput!.fact;
  const reopened = createInteractionParentTurnRawOwner({
    turn: turnInputFact.turn, execution: turnInputFact.execution, scope: turnInputFact.scope,
    initialInput: turnInputFact.initialInput, providerBinding: binding,
    priorCheckpoints: turnInputFact.priorCheckpoints,
    journal: replayedParentJournal, rawContent: base.rawContent,
  });
  const retried = await reopened.recordProviderClose({
    providerBinding: binding, result: receipts[0]!, closedAt: '2099-01-01T00:00:00.000Z',
  });
  assert.equal(retried.fact.closedAt, fixedNow, 'an exact retry preserves the first closedAt');
  assert.deepEqual(retried.commit, snapshot.resourceClose.commit);
  const closeRecords = (await new JsonlOrganJournal(journalFile).replay())
    .filter((record) => (record.payload as { discriminant?: string } | undefined)?.discriminant === 'resource-close');
  assert.equal(closeRecords.length, 1, 'a retry must not append a second close record');
});

test('provider explicit brain interpreter keeps resource close independent of semantic success and leaves a borrowed provider open', async () => {
  // Failure basis: the error path records no close and a borrowed provider is
  // never closed, so a real physical close on an error is lost while a borrowed
  // owner must stay open. Impact: missing close evidence or an illegal close of
  // someone else's owner. Cost: three owned runs on the real JSONL consumer.
  await mkdir(parentFixtureRoot, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-parent-close-2', providerId: 'provider-parent-close-2', protocol: 'responses',
    endpointRef: 'fake://parent-close-2', modelRef: 'model-parent-close-2',
    configDigest: 'sha256:parent-close-2-config', capabilityDigest: 'sha256:parent-close-2-capability',
  };
  const templateRoot = join(process.cwd(), 'packages', 'agent-templates', 'templates');
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };
  const ownedProvider = {
    source: 'http' as const, provider: 'http' as const, binding: binding.bindingId, protocol: 'responses' as const,
    model: binding.modelRef, route: 'parent-close-fixture-2', baseUrl: binding.endpointRef,
  };
  const answerReplay = [
    { kind: 'output', state: 'output', summary: JSON.stringify({ kind: 'answer', normalizedInput: 'echo', knownFacts: [], answer: 'ok', decisionRefs: [] }) },
    { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
  ];

  // (a) A real close during a failed interpretation still commits the close.
  const failJournal = new JsonlOrganJournal(join(parentFixtureRoot, `parent-close-fail-${randomUUID()}.jsonl`));
  const failParent = new JsonlInteractionParentTurnJournal(failJournal);
  const failHelper = new JsonlInteractionHelperJournal(failJournal);
  const failPort = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [
    { kind: 'output', state: 'output', summary: 'this is not a json decision' },
    { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
  ] });
  const failReceipts: ProviderCloseResult[] = [];
  const failClose = failPort.close.bind(failPort);
  failPort.close = async (bind) => { const receipt = await failClose(bind); failReceipts.push(receipt); return receipt; };
  const failInterpreter = createProviderExplicitBrainInterpreter({
    ...parentDependencies(), binding, parentJournal: failParent, helperJournal: failHelper,
    checkpointJournal: failHelper, clock: { now: () => '2026-10-16T00:00:00.000Z' }, templateRoot, port: failPort,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http', provider: ownedProvider, binding, port: failPort }),
  });
  await assert.rejects(
    () => failInterpreter.interpret({ interactionId: 'parent-close-fail', inputRevision: 1, sourceRef: 'ui:new-task', rawInput: 'answer this', clarifications: [], taskCandidates: [] }),
    /invalid JSON/,
  );
  assert.equal(failReceipts.length, 1);
  const failTurn = (await failParent.readScopeOpenedTurns(scope))[0]!.fact.turn;
  const failSnapshot = await failParent.readTurnSnapshot(failTurn);
  assert.ok(failSnapshot.resourceClose, 'a real close must be recorded without a successful semantic output');
  assert.deepEqual(
    failSnapshot.resourceClose!.fact.result,
    failReceipts[0],
    'the persisted close must equal the real receipt by value',
  );
  assert.equal(await failHelper.readSemanticCheckpointExact(failTurn), null, 'a failed interpretation commits no checkpoint');

  // (b) A borrowed provider is never closed and manufactures no close fact.
  const borrowJournal = new JsonlOrganJournal(join(parentFixtureRoot, `parent-close-borrow-${randomUUID()}.jsonl`));
  const borrowParent = new JsonlInteractionParentTurnJournal(borrowJournal);
  const borrowHelper = new JsonlInteractionHelperJournal(borrowJournal);
  const borrowPort = new RecordedParentPort({ binding, stepDelayMs: 0, replay: answerReplay });
  let borrowedCloses = 0;
  const borrowClose = borrowPort.close.bind(borrowPort);
  borrowPort.close = async (bind) => { borrowedCloses += 1; return borrowClose(bind); };
  const borrowInterpreter = createProviderExplicitBrainInterpreter({
    ...parentDependencies(), binding, parentJournal: borrowParent, helperJournal: borrowHelper,
    checkpointJournal: borrowHelper, clock: { now: () => '2026-10-16T00:00:00.000Z' }, templateRoot, port: borrowPort,
  });
  const borrowResult = await borrowInterpreter.interpret({
    interactionId: 'parent-close-borrow', inputRevision: 1, sourceRef: 'ui:new-task', rawInput: 'answer this', clarifications: [], taskCandidates: [],
  });
  assert.equal(borrowResult.kind, 'answer');
  assert.equal(borrowedCloses, 0, 'a borrowed provider must not be closed');
  const borrowTurn = (await borrowParent.readScopeOpenedTurns(scope))[0]!.fact;
  assert.deepEqual(borrowTurn.providerBinding, binding, 'a borrowed turn still freezes its actual binding');
  assert.equal((await borrowParent.readTurnSnapshot(borrowTurn.turn)).resourceClose, null, 'a borrowed turn records no close fact');

  // (c) A failed close keeps the original error and records no success.
  const rejectJournal = new JsonlOrganJournal(join(parentFixtureRoot, `parent-close-reject-${randomUUID()}.jsonl`));
  const rejectParent = new JsonlInteractionParentTurnJournal(rejectJournal);
  const rejectHelper = new JsonlInteractionHelperJournal(rejectJournal);
  const rejectPort = new RecordedParentPort({ binding, stepDelayMs: 0, replay: answerReplay });
  const rejectError = new Error('owned close rejection');
  rejectPort.close = async () => { throw rejectError; };
  const rejectInterpreter = createProviderExplicitBrainInterpreter({
    ...parentDependencies(), binding, parentJournal: rejectParent, helperJournal: rejectHelper,
    checkpointJournal: rejectHelper, clock: { now: () => '2026-10-16T00:00:00.000Z' }, templateRoot, port: rejectPort,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http', provider: ownedProvider, binding, port: rejectPort }),
  });
  await assert.rejects(
    () => rejectInterpreter.interpret({ interactionId: 'parent-close-reject', inputRevision: 1, sourceRef: 'ui:new-task', rawInput: 'answer this', clarifications: [], taskCandidates: [] }),
    (error: unknown) => error === rejectError,
  );
  const rejectTurn = (await rejectParent.readScopeOpenedTurns(scope))[0]!.fact.turn;
  assert.equal((await rejectParent.readTurnSnapshot(rejectTurn)).resourceClose, null, 'a failed close records no close fact');
  assert.equal(await rejectHelper.readSemanticCheckpointExact(rejectTurn), null);
});

// Real recorded RCC intake output (business output only) from the
// provider-candidate-live-entry-r2 scene. The model nested the decision under a
// `decision` object and left no top-level `kind`. The strict intake parser must
// keep rejecting it with no `decision.kind` fallback.
const RECORDED_NESTED_DECISION_OUTPUT = `{
  "interactionId": "interaction-1",
  "inputRevision": 1,
  "sourceRef": "ui:entry",
  "rawInput": "请完成一次 HumanAgent UX 文档交接任务：在当前工作区创建 ux-handoff.md，然后读回核对。文件用中文写给实际使用者，内容包括：1. 简单问答由显式大脑直接回答，复杂需求整理为任务；2. 默认只显示当前层必要的语义信息，技术细节按需展开；3. 桌面使用侧面板，手机使用底部抽屉，主动配置入口位于四角；4. 浏览旧 checkpoint 只改变查看位置，不改变当前执行位置。最后在回复中给出文件路径、内容摘要和实际核对结果。不要修改其他文件。",
  "normalizedInput": "用户要求在当前工作区创建 ux-handoff.md，文件用中文写给实际使用者，内容包含四条明确的 UX 约定：直接回答与任务化、分层语义展示、响应式面板与配置入口、checkpoint 浏览语义；创建后读回核对，并回复文件路径、内容摘要和核对结果；不得修改其他文件。",
  "knownFacts": [
    "请求来自 UI 入口，期望交付 ux-handoff.md 文件及核对结果",
    "当前 taskCandidates 为空，没有可匹配的既有任务",
    "需求明确限定不修改其他文件",
    "文件语言为中文，内容包含四条指定约定"
  ],
  "decisionRefs": [
    "sourceRef:ui:entry"
  ],
  "decision": {
    "kind": "requirement",
    "selectedAction": "propose create（待用户确认后通过 requirement.submit 提交）",
    "summary": "将创建 ux-handoff.md 并读回核对的需求整理为创建型任务提案，等待用户确认后提交执行",
    "evidenceRefs": [
      "sourceRef:ui:entry"
    ],
    "needsUserInput": true,
    "needsToolResult": false
  },
  "clarifications": [],
  "taskCandidates": [],
  "proposal": {
    "revision": 1,
    "intent": "create",
    "title": "创建 HumanAgent UX 交接文档 ux-handoff.md",
    "objective": "在当前工作区创建 ux-handoff.md，用中文写给实际使用者，写入指定的四条 UX 约定，并读回核对，最后返回文件路径、内容摘要和核对结果。",
    "deliverable": "ux-handoff.md 文件、内容摘要、实际读回核对结果；不修改其他文件。",
    "owner": null,
    "ownerNote": "需求已明确文件路径、语言、内容要点和交付形式，确认后即可按此提案执行。",
    "deliveryConditions": [
      "仅创建/写入 ux-handoff.md，不修改其他文件",
      "文件内容为中文且包含用户指定的四条约定",
      "完成读回核对，并在回复中给出文件路径、内容摘要和核对结果"
    ],
    "evidenceRefs": [
      "sourceRef:ui:entry"
    ],
    "blockingGaps": [
      "taskCandidates 为空，尚无已匹配的既有任务，需用户确认后新建任务"
    ],
    "lifecycle": "proposal -> user confirmation -> requirement.submit -> implicit-brain FIFO",
    "requiresUserConfirmation": true,
    "confirmationPrompt": "确认将以下需求提交为任务：在当前工作区创建 ux-handoff.md（中文写给实际使用者，含四条 UX 约定），并读回核对后返回文件路径、内容摘要和核对结果；不修改其他文件。"
  }
}`;

test('provider explicit brain interpreter strictly rejects a recorded nested-decision intake output', async () => {
  const binding: ProviderBinding = {
    bindingId: 'binding-explicit-recorded-nested',
    providerId: 'provider-explicit-recorded-nested',
    protocol: 'responses',
    endpointRef: 'fake://explicit-recorded-nested',
    modelRef: 'model-explicit-recorded-nested',
    configDigest: 'sha256:explicit-recorded-nested-config',
    capabilityDigest: 'sha256:explicit-recorded-nested-capability',
  };
  const options = {
    ...parentDependencies(),
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new RecordedParentPort({
      binding,
      stepDelayMs: 0,
      replay: [
        { kind: 'output', state: 'output', summary: RECORDED_NESTED_DECISION_OUTPUT },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ],
    }),
  };
  const lifecycle: string[] = [];
  const settle = options.port.settle.bind(options.port);
  const close = options.port.close.bind(options.port);
  options.port.settle = async (request) => { lifecycle.push('settle'); return settle(request); };
  options.port.close = async (bind) => { lifecycle.push('close'); return close(bind); };
  const interpreter = createProviderExplicitBrainInterpreter({
    ...options,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'recorded-nested-fixture', baseUrl: binding.endpointRef },
      binding, port: options.port }),
  });
  try {
  await assert.rejects(
    () => interpreter.interpret({
      interactionId: 'interaction-recorded-nested', inputRevision: 1, sourceRef: 'ui:entry',
      rawInput: '请完成一次 HumanAgent UX 文档交接任务', clarifications: [], taskCandidates: [],
    }),
    /interaction agent decision does not match the explicit intake contract/,
  );
  assert.deepEqual(lifecycle, ['settle', 'close']);
  } finally {
    await rm(parentFixtureRoot, { recursive: true, force: true });
    await assert.rejects(() => realpath(parentFixtureRoot), /ENOENT/);
  }
});

test('provider explicit brain interpreter reuses the retained close on a same-process retry without a second physical close', async () => {
  // Failure basis: a Journal acknowledgement loss after a real close must not
  // make a same-process retry close the original owner a second time. Impact: a
  // duplicated physical close of an owner that is already closed. Cost: one
  // injected checkpoint append fault and one retry on the real JSONL consumer.
  // Probability is unknown because this receipt and retry boundary is new.
  await mkdir(parentFixtureRoot, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-parent-close-retry', providerId: 'provider-parent-close-retry', protocol: 'responses',
    endpointRef: 'fake://parent-close-retry', modelRef: 'model-parent-close-retry',
    configDigest: 'sha256:parent-close-retry-config', capabilityDigest: 'sha256:parent-close-retry-capability',
  };
  const journalFile = join(parentFixtureRoot, `parent-close-retry-${randomUUID()}.jsonl`);
  const journal = new JsonlOrganJournal(journalFile);
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  // A one-shot checkpoint append fault models a lost acknowledgement after the
  // physical close has already happened and its fact has committed.
  let appendAttempts = 0;
  const flakyCheckpointJournal: InteractionSemanticCheckpointJournalPort = {
    appendSemanticCheckpoint: async (checkpoint) => {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error('semantic checkpoint ack lost');
      return helperJournal.appendSemanticCheckpoint(checkpoint);
    },
    readSemanticCheckpointExact: (identity) => helperJournal.readSemanticCheckpointExact(identity),
    readScopeSemanticCheckpoints: (scopeKey) => helperJournal.readScopeSemanticCheckpoints(scopeKey),
  };
  const options = {
    ...parentDependencies(), binding, parentJournal, helperJournal, checkpointJournal: flakyCheckpointJournal,
    clock: { now: () => '2026-10-16T00:00:00.000Z' },
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
  };
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [
    { kind: 'output', state: 'output', summary: JSON.stringify({ kind: 'answer', normalizedInput: 'echo', knownFacts: [], answer: 'retry-answer', decisionRefs: [] }) },
    { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
  ] });
  let closes = 0;
  const close = port.close.bind(port);
  port.close = async (bind) => { closes += 1; return close(bind); };
  const publications: Array<Awaited<ReturnType<typeof publishInteractionProviderSettlement>>> = [];
  const interpreter = createProviderExplicitBrainInterpreter({
    ...options, port,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'parent-close-retry', baseUrl: binding.endpointRef },
      binding, port }),
    publishProviderSettlement: async (receipt) => {
      const committed = await publishInteractionProviderSettlement({
        journal: parentJournal,
        receipt,
      });
      publications.push(committed);
    },
  });
  const request = {
    interactionId: 'parent-close-retry', inputRevision: 1, sourceRef: 'ui:new-task',
    rawInput: 'answer this', clarifications: [], taskCandidates: [],
  };
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };

  await assert.rejects(() => interpreter.interpret(request), /semantic checkpoint ack lost/);
  assert.equal(closes, 1, 'the first attempt closes the original owner once');
  const opened = await parentJournal.readScopeOpenedTurns(scope);
  assert.equal(opened.length, 1);
  const turn = opened[0]!.fact.turn;
  const firstSnapshot = await parentJournal.readTurnSnapshot(turn);
  assert.ok(firstSnapshot.resourceClose, 'the close is durable before the checkpoint failure');
  assert.equal(firstSnapshot.providerSettlements.length, 1, 'the receipt commits before the checkpoint failure');
  assert.equal(publications.length, 1);

  // The same-process retry reuses the retained receipt and never re-closes.
  const retried = await interpreter.interpret(request);
  assert.equal(retried.kind, 'answer');
  assert.equal(closes, 1, 'a same-process retry must not close the owner a second time');
  assert.equal(publications.length, 2, 'the retained retry republishes the same receipt');
  assert.deepEqual(publications[1]!.commit, publications[0]!.commit,
    'the retained retry returns the original receipt commit');
  const retriedSnapshot = await parentJournal.readTurnSnapshot(turn);
  assert.equal(retriedSnapshot.providerSettlements.length, 1);
  assert.deepEqual(retriedSnapshot.providerSettlements[0], publications[0]);
  const closeRecords = (await new JsonlOrganJournal(journalFile).replay())
    .filter((record) => (record.payload as { discriminant?: string } | undefined)?.discriminant === 'resource-close');
  assert.equal(closeRecords.length, 1, 'a same-process retry must not append a second close record');
});

// Failure basis: the durable receipt can fail before the answer completes, and
// the turn can then recover from cold storage. Impact: a false answer without
// its settlement control record. Cost: one fresh answer and one cold retry on
// the existing interpreter and Journal fixture.
// Probability is unknown because this failure boundary is new.
test('provider explicit brain interpreter preserves a settlement publication failure and does not complete the answer', async () => {
  const journalFile = join(parentFixtureRoot, `parent-settlement-failure-${randomUUID()}.jsonl`);
  const journal = new JsonlOrganJournal(journalFile);
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };
  const binding: ProviderBinding = {
    bindingId: 'binding-parent-settlement-failure', providerId: 'provider-parent-settlement-failure', protocol: 'responses',
    endpointRef: 'fake://parent-settlement-failure', modelRef: 'model-parent-settlement-failure',
    configDigest: 'sha256:parent-settlement-failure-config', capabilityDigest: 'sha256:parent-settlement-failure-capability',
  };
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [
    { kind: 'output', state: 'output', summary: JSON.stringify({ kind: 'answer', normalizedInput: 'answer this', knownFacts: [], answer: 'not completed', decisionRefs: [] }) },
    { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
  ] });
  let starts = 0;
  const start = port.start.bind(port);
  port.start = async (input) => { starts += 1; return start(input); };
  let closes = 0;
  const close = port.close.bind(port);
  port.close = async (bind) => { closes += 1; return close(bind); };
  const publicationError = new Error('settlement publication rejected');
  let publicationCalls = 0;
  const interpreter = createProviderExplicitBrainInterpreter({
    ...parentDependencies(), binding, parentJournal, helperJournal, checkpointJournal: helperJournal,
    turnHelperJournal: helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), port,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'parent-settlement-failure', baseUrl: binding.endpointRef },
      binding, port }),
    publishProviderSettlement: async () => {
      publicationCalls += 1;
      throw publicationError;
    },
  });
  const request = {
    interactionId: 'parent-settlement-failure', inputRevision: 1, sourceRef: 'ui:new-task',
    rawInput: 'answer this', clarifications: [], taskCandidates: [],
  };

  await assert.rejects(() => interpreter.interpret(request), (error: unknown) => error === publicationError);
  const opened = await parentJournal.readScopeOpenedTurns(scope);
  assert.equal(opened.length, 1);
  const turn = opened[0]!.fact.turn;
  const failed = await parentJournal.readTurnSnapshot(turn);
  assert.equal(publicationCalls, 1);
  assert.equal(starts, 1);
  assert.equal(closes, 1);
  assert.ok(failed.resourceClose, 'the original physical close owner still records its close');
  assert.deepEqual(failed.providerSettlements, []);
  assert.equal(await helperJournal.readSemanticCheckpointExact(turn), null,
    'publication failure must not close the semantic answer');

  await assert.rejects(() => interpreter.interpret(request), /provider settlement is missing for the current terminal request/);
  assert.equal(publicationCalls, 1, 'the retained/cold recovery must not retry the failed callback');
  assert.equal(starts, 1, 'the recovery must not replay the Provider request');
  assert.equal(closes, 1, 'the recovery must not close the original owner again');
  assert.deepEqual(await parentJournal.readTurnSnapshot(turn), failed,
    'the failed recovery must not append or rewrite the original turn');
});

// Failure basis: the App callback loses the physical terminal request and cold
// terminal recovery can complete without the exact persisted settlement. Impact:
// the formal publisher cannot associate the retained settlement, or an
// incomplete recovery reports success without its required receipt. Cost: one
// fresh answer, one same-process retry, and one cold fixture read on the
// existing real interpreter and Journal consumer.
// Probability is unknown because this App integration boundary is new.
test('provider explicit brain interpreter publishes the receipt with the actual terminal request and requires it on cold recovery', async () => {
  const journalFile = join(parentFixtureRoot, `parent-settlement-${randomUUID()}.jsonl`);
  const journal = new JsonlOrganJournal(journalFile);
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };
  const binding: ProviderBinding = {
    bindingId: 'binding-parent-settlement', providerId: 'provider-parent-settlement', protocol: 'responses',
    endpointRef: 'fake://parent-settlement', modelRef: 'model-parent-settlement',
    configDigest: 'sha256:parent-settlement-config', capabilityDigest: 'sha256:parent-settlement-capability',
  };
  // A redundant non-requirement guard can lose an otherwise valid answer when
  // the model leaves an irrelevant taskFlowKind on it. Cost: one fixture field.
  const answerText = JSON.stringify({ kind: 'answer', normalizedInput: 'answer this', knownFacts: [],
    taskFlowKind: 'one-shot', answer: 'settlement-answer', decisionRefs: [] });
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [
    { kind: 'output', state: 'output', summary: answerText },
    { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
  ] });
  const published: InteractionProviderSettlementReceipt[] = [];
  const dependencies = parentDependencies();
  const interpreter = createProviderExplicitBrainInterpreter({
    ...dependencies, binding, parentJournal, helperJournal, checkpointJournal: helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), port,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'parent-settlement', baseUrl: binding.endpointRef },
      binding, port }),
    publishProviderSettlement: async (receipt) => {
      published.push(receipt);
      await publishInteractionProviderSettlement({ journal: parentJournal, receipt });
    },
  });
  const request = {
    interactionId: 'parent-settlement', inputRevision: 1, sourceRef: 'ui:new-task',
    rawInput: 'answer this', clarifications: [], taskCandidates: [],
  };
  try {
    const result = await interpreter.interpret(request);
    assert.equal(result.kind, 'answer');
    if (result.kind !== 'answer') throw new Error('expected settlement answer');
    assert.equal(result.answer, 'settlement-answer');
    assert.equal(Reflect.get(result, 'taskFlow'), undefined);
    const opened = await parentJournal.readScopeOpenedTurns(scope);
    assert.equal(opened.length, 1);
    const turn = opened[0]!.fact.turn;
    const snapshot = await parentJournal.readTurnSnapshot(turn);
    const terminalRequest = snapshot.requests.at(-1)!.fact.request;
    assert.equal(published.length, 1);
    assert.equal(published[0]!.interactionId, request.interactionId);
    assert.equal(published[0]!.inputRevision, request.inputRevision);
    assert.deepEqual(published[0]!.request, terminalRequest);
    assert.ok(published[0]!.request.turnId !== turn.turnId);
    assert.equal(published[0]!.settlement.state, 'succeeded');
    assert.equal('taskId' in published[0]!.settlement, false);
    const committed = await readInteractionProviderSettlement({ journal: parentJournal, turn });
    assert.deepEqual(committed.fact, published[0]);
  } finally {
    const receipt = await port.close(binding); assert.equal(receipt.state, 'closed');
  }

  // A configured callback makes the receipt mandatory for incomplete recovery.
  // A cold reader without the configured callback still reads legacy history.
  const settlementJournalFile = join(parentFixtureRoot, `parent-settlement-missing-${randomUUID()}.jsonl`);
  const settlementJournal = new JsonlOrganJournal(settlementJournalFile);
  const settlementParent = new JsonlInteractionParentTurnJournal(settlementJournal);
  const settlementHelper = new JsonlInteractionHelperJournal(settlementJournal);
  const coldOptions = {
    ...dependencies, binding, parentJournal: settlementParent,
    checkpointJournal: settlementHelper, helperJournal: settlementHelper, turnHelperJournal: settlementHelper,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new RecordedParentPort({ binding, stepDelayMs: 0, replay: [
      { kind: 'output', state: 'output', summary: answerText },
      { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
    ] }),
    helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
  };
  const missingInterpretRequest = {
    interactionId: 'missing-settlement', inputRevision: 1, sourceRef: 'ui:new-task',
    rawInput: 'answer this', clarifications: [], taskCandidates: [],
  };
  const missingTurn = {
    organId: scope.organId, interactionScopeId: scope.interactionScopeId,
    interactionId: missingInterpretRequest.interactionId, inputRevision: 1, turnId: 'missing-settlement-turn',
  };
  const missingScope = { organId: scope.organId, operationId: id('operation', 'operation-missing-settlement') };
  const missingExecution = {
    runtimeId: 'runtime-missing-settlement', organId: scope.organId,
    operationId: missingScope.operationId, executionEpoch: 1, interactionTurn: missingTurn,
  };
  const settlementOwner = createInteractionParentTurnRawOwner({
    turn: missingTurn, execution: missingExecution, scope: missingScope,
    initialInput: {
      ref: await dependencies.rawEvidence.write({ scope: missingScope, kind: 'execution', type: 'initial-input',
        locator: 'missing-settlement-turn', content: JSON.stringify(missingInterpretRequest) }),
      view: { kind: 'utf8-text' },
    },
    providerBinding: binding, journal: settlementParent, rawContent: dependencies.rawContent,
  });
  const missingRequest = { turnId: 'provider-missing-settlement', requestId: 'request-missing-settlement' };
  await settlementOwner.openTurnInput();
  await settlementOwner.registerRequest({ execution: { runtimeId: 'runtime-missing-settlement', executionEpoch: 1 },
    record: { request: missingRequest, scope: missingScope, phase: 'dispatching' } });
  await settlementOwner.acceptRawFact({ execution: { runtimeId: 'runtime-missing-settlement', executionEpoch: 1 },
    scope: missingScope, request: missingRequest, producerSeq: 1, fact: { kind: 'content', contentUnitId: 'text',
      channel: 'assistant-text', update: 'full',
      content: { ref: await dependencies.rawEvidence.write({ scope: missingScope, kind: 'execution', type: 'assistant-text', locator: 'text', content: answerText }), view: { kind: 'utf8-text' as const } },
      complete: true } });
  await settlementOwner.acceptRawFact({ execution: { runtimeId: 'runtime-missing-settlement', executionEpoch: 1 },
    scope: missingScope, request: missingRequest, producerSeq: 2, fact: { kind: 'request-complete', terminal: 'completed' } });
  await settlementOwner.registerRequest({ execution: { runtimeId: 'runtime-missing-settlement', executionEpoch: 1 },
    record: { request: missingRequest, scope: missingScope, phase: 'settled' } });
  await settlementOwner.recordProviderClose({ providerBinding: binding,
    result: { bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol, state: 'closed',
      evidenceRefs: [{ evidenceId: id('evidence', 'missing-settlement-close'), kind: 'operation', source: 'test', locator: 'missing-settlement-close', scope: missingScope }] },
    closedAt: '2026-10-18T00:00:00.000Z' });
  await assert.rejects(() => readInteractionProviderSettlement({ journal: settlementParent, turn: missingTurn }),
    /missing for the current terminal request/);
  await assert.rejects(() => createProviderExplicitBrainInterpreter({
    ...coldOptions,
    publishProviderSettlement: async () => undefined,
  }).interpret(missingInterpretRequest),
  /provider settlement is missing for the current terminal request/);
  const legacy = await createProviderExplicitBrainInterpreter({
    ...coldOptions,
  }).interpret(missingInterpretRequest);
  assert.equal(legacy.kind, 'answer');
});

// Failure basis: default DI currently omits the lease, and the cold App reader
// requires a physical close before it can reconcile. Impact: wedged intake or
// repeated helper effects. Cost: one child seed process, one real UI consumer,
// and terminal/hold/cleanup calls on the same isolated durable fixture.
test('provider explicit brain interpreter fresh OS default DI recovers preclose without helper replay', async () => {
  const root = join(parentFixtureRoot, `preclose-os-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-preclose', providerId: 'provider-preclose', protocol: 'responses',
    endpointRef: 'http://recorded.test', modelRef: 'model-preclose',
    configDigest: 'sha256:preclose-config', capabilityDigest: 'sha256:preclose-capability',
  };
  const moduleUrl = (path: string) => new URL(`../../packages/${path}`, import.meta.url).href;
  // Old requests are deliberately SEEDED via public Runtime/JSONL APIs. They
  // are not represented as real old upstream generations. Lease/PID, explicit
  // intake persistence, takeover and the new Provider execution are real.
  const script = `
    import { startUiRuntime } from ${JSON.stringify(moduleUrl('app/src/ui-runtime/index.js'))};
    import { AccessControlService } from ${JSON.stringify(moduleUrl('app/src/ui-runtime/access-control.js'))};
    import { uiRuntimeControlJournalPath } from ${JSON.stringify(moduleUrl('app/src/ui-runtime/journal.js'))};
    import { acquireDaemonLease } from ${JSON.stringify(moduleUrl('app/src/supervisor/index.js'))};
    import { ensureControlLayout, resolveRuntimePaths } from ${JSON.stringify(moduleUrl('config/src/index.js'))};
    import { MemoryCoordinator } from ${JSON.stringify(moduleUrl('runtime/src/memory/index.js'))};
    import { DeterministicMemoryBackend } from ${JSON.stringify(moduleUrl('adapters/memory/src/index.js'))};
    import { createInteractionParentTurnRawOwner } from ${JSON.stringify(moduleUrl('runtime/src/explicit-brain/index.js'))};
    import { JsonlOrganJournal } from ${JSON.stringify(moduleUrl('adapters/jsonl/src/index.js'))};
    import { JsonlInteractionParentTurnJournal } from ${JSON.stringify(moduleUrl('adapters/jsonl/src/interaction-parent-turn-journal.js'))};
    import { JsonlInteractionHelperJournal } from ${JSON.stringify(moduleUrl('adapters/jsonl/src/interaction-helper-journal.js'))};
    import { ImmutableAssetStore } from ${JSON.stringify(moduleUrl('adapters/filesystem/src/index.js'))};
    import { ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } from ${JSON.stringify(moduleUrl('adapters/provider/src/index.js'))};
    import { providerRawContentReader } from ${JSON.stringify(moduleUrl('adapters/provider/src/evidence.js'))};
    import { id } from ${JSON.stringify(moduleUrl('contracts/src/index.js'))};
    import { join } from 'node:path';
    const root = ${JSON.stringify(root)}, binding = ${JSON.stringify(binding)};
    const paths = await resolveRuntimePaths({controlRoot: join(root, 'control'), workspace: process.cwd()});
    await ensureControlLayout(paths);
    const lease = await acquireDaemonLease(paths);
    const parentEvidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
    ${RecordedParentPort.toString()}
    const port = new RecordedParentPort({binding, stepDelayMs: 0, replay: [], evidence: parentEvidence});
    const runtime = await startUiRuntime({
      mode: 'rcc', organId: id('organ', 'explicit-test'), binding, port,
      productRoot: root,
      checkpointRoot: join(root, 'checkpoints'), evidenceRoot: join(root, 'assets'),
      uiRoot: join(process.cwd(), 'docs/ui'), portNumber: 0, lease,
      accessControl: await AccessControlService.open({credentialPath: join(root, 'security/web-access.json'), create: true}),
      explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      memory: {coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'preclose'},
      runtimeComposition: {
        prepareAgentProvider: async () => { throw new Error('seed must not prepare Provider'); },
        prepareTaskAgentProvider: async () => { throw new Error('seed must not prepare Task'); },
      },
    });
    const interactionId = await runtime.service.receiveExplicitInput({sourceRef: 'ui:preclose', rawInput: 'recover the exact input', channel: 'business'});
    const persisted = await runtime.service.inspectExplicitInteraction(interactionId);
    const request = {interactionId, inputRevision: 1, sourceRef: persisted.sourceRef, rawInput: persisted.rawInput, clarifications: [], taskCandidates: []};
    const journal = new JsonlOrganJournal(uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc')));
    const parent = new JsonlInteractionParentTurnJournal(journal), helpers = new JsonlInteractionHelperJournal(journal);
    const rawContent = providerRawContentReader(parentEvidence);
    const asset = async (scope, type, content) => ({ref: await parentEvidence.write({scope, kind: 'execution', type, locator: type, content}), view: {kind: 'utf8-text'}});
    const ownerIdentity = await lease.withCurrentLeaseOwner(async owner => owner);
    const seeded = {};
    for (const mode of ['continue', 'terminal', 'legacy', 'unreturned']) {
      const turn = {organId: id('organ','explicit-test'), interactionScopeId: mode === 'continue' ? 'runtime:explicit-test' : 'runtime:' + mode,
        interactionId: mode === 'continue' ? interactionId : mode, inputRevision: 1, turnId: 'seed-' + mode};
      const turnRequest = {...request, interactionId: turn.interactionId};
      const scope = {organId: turn.organId, operationId: id('operation','op-' + mode)};
      const execution = {runtimeId: 'runtime-' + mode, ...scope, executionEpoch: 1, interactionTurn: turn};
      const initialInput = await asset(scope, 'input-' + mode, JSON.stringify(turnRequest));
      const owner = createInteractionParentTurnRawOwner({turn, execution, scope, initialInput, providerBinding: binding,
        ...(mode === 'legacy' ? {} : {executionOwner: ownerIdentity}), journal: parent, rawContent});
      await owner.openTurnInput();
      if (mode === 'continue' || mode === 'unreturned') {
        const identity = {organId: turn.organId, interactionScopeId: turn.interactionScopeId, interactionId: turn.interactionId,
          inputRevision: 1, parentTurnId: turn.turnId, assignmentId: 'helper-assignment-' + mode, helperCallId: 'helper-' + mode, attempt: 1};
        const assignment = {...identity, objective: 'seed returned helper', targetRefs: [], expectedOutputRefs: [], expectedArtifactDigests: [],
          acceptanceCriteriaDigest: 'sha256:' + 'a'.repeat(64), successCriteria: ['complete'], failureCriteria: ['none'],
          incompleteCriteria: ['partial'], requiredCapabilities: [], mergeGate: 'not-required'};
        await helpers.appendDispatchAccepted({kind: 'dispatch-accepted', assignment, dispatchAcceptedAt: new Date().toISOString(), evidenceRefs: []});
        if (mode === 'continue') await helpers.appendReturned({kind: 'returned', result: {...identity, agentId: 'seed-helper',
          producedArtifactRefs: [], producedArtifactDigests: [], status: 'incomplete', summary: 'seeded returned helper', outputRefs: [], evidenceRefs: [],
          nextAction: 'wait', conditionRef: 'condition:seed'}, returnedAt: new Date().toISOString(), evidenceRefs: []},
        { description: 'dispatch seeded returned helper for objective "seed returned helper"; success criteria: complete' });
      }
      if (mode === 'continue' || mode === 'terminal') {
        const req = {turnId: 'provider-' + mode, requestId: 'req-1-' + mode};
        await owner.registerRequest({execution, record: {request: req, scope, phase: 'dispatching'}});
        if (mode === 'continue') {
          await owner.acceptRawFact({execution, scope, request: req, producerSeq: 1, fact: {kind: 'tool-call', contentUnitId: 'call',
            call: {callId: 'old-call', toolId: 'dispatch_helper', arguments: {seed: true}, continuationRef: 'old-continuation'},
            rawArguments: await asset(scope, 'args', '{"seed":true}'), complete: true}});
          await owner.acceptRawFact({execution, scope, request: req, producerSeq: 2, fact: {kind: 'tool-result', contentUnitId: 'result',
            callId: 'old-call', continuationRef: 'old-continuation', result: {...execution, toolId: 'dispatch_helper', callId: 'old-call',
              status: 'succeeded', outputRefs: [], evidenceRefs: []}, rawOutput: await asset(scope,'output','SEEDED_RETURNED_HELPER'), complete: true}});
        } else {
          const text = JSON.stringify({kind: 'answer', normalizedInput: turnRequest.rawInput, knownFacts: [], answer: 'terminal recovered', decisionRefs: []});
          await owner.acceptRawFact({execution, scope, request: req, producerSeq: 1, fact: {kind: 'content', channel: 'assistant-text', update: 'full', contentUnitId: 'text',
            content: await asset(scope, 'terminal-text', text), complete: true}});
        }
        await owner.acceptRawFact({execution, scope, request: req, producerSeq: 3, fact: {kind: 'request-complete', terminal: 'completed'}});
        await owner.registerRequest({execution, record: {request: req, scope, phase: 'settled'}});
        if (mode === 'continue') {
          const next = {turnId: req.turnId, requestId: 'req-2', parentRequestId: req.requestId};
          await owner.registerRequest({execution, record: {request: next, parentRequestId: req.requestId, scope, phase: 'dispatching'}});
          await owner.registerRequest({execution, record: {request: next, parentRequestId: req.requestId, scope, phase: 'waiting'}});
        }
      }
      seeded[mode] = {turn, request: turnRequest};
    }
    console.log(JSON.stringify({pid: process.pid, ownerIdentity, seeded}));
    process.exit(0); // deliberate crash boundary: no runtime.close or lease.release
  `;
  let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exit, 0, stderr);
    const receipt = JSON.parse(stdout.trim());
    assert.equal(receipt.pid, child.pid);
    assert.ok(receipt.pid !== process.pid);
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    lease = await acquireDaemonLease(paths, { takeover: { reason: 'preclose test dead child takeover', allowed: () => true } });
    assert.equal(lease.record.generation, 2);
    console.log(JSON.stringify({ event: 'fresh-os-takeover', oldPid: child.pid, newPid: process.pid,
      oldOwner: receipt.ownerIdentity, newGeneration: lease.record.generation, seededOldRequests: true }));
    const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
    const journal = new JsonlOrganJournal(uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc')));
    const parent = new JsonlInteractionParentTurnJournal(journal);
    const helpers = new JsonlInteractionHelperJournal(journal);
    const rawContent = providerRawContentReader(evidence);
    let prepares = 0, providerRequests = 0, physicalCloses = 0, helperPrepares = 0;
    const parentPort = new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [], respond: async (wire) => {
      providerRequests += 1;
      assert.ok(wire.input.some((item: any) => item.type === 'function_call' && item.call_id === 'old-call'));
      assert.ok(wire.input.some((item: any) => item.type === 'function_call_output' && item.output === 'SEEDED_RETURNED_HELPER'));
      // Re-entering the real lease proves no Provider work holds its guard.
      await lease!.withCurrentLeaseOwner(async () => undefined);
      return [{ type: 'response.output_text.done', item_id: 'final', text: JSON.stringify({
        kind: 'answer', normalizedInput: 'recover the exact input', knownFacts: [], answer: 'continued after OS takeover', decisionRefs: [],
      }) }];
    } });
    const originalClose = parentPort.close.bind(parentPort);
    parentPort.close = async (selectedBinding) => { physicalCloses += 1; return originalClose(selectedBinding); };
    const composition = { roleId: 'interaction' as const, source: 'http' as const,
      provider: { source: 'http' as const, provider: 'http' as const, binding: binding.bindingId, protocol: 'responses' as const,
        model: binding.modelRef, route: 'recorded', baseUrl: binding.endpointRef }, binding, port: parentPort };
    const interpreterOptions = {
      organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test',
      parentJournal: parent, checkpointJournal: helpers, helperJournal: helpers, turnHelperJournal: helpers,
      rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() }, binding,
      templateRoot: join(process.cwd(), 'packages/agent-templates/templates'), lease,
      helperFactory: async () => { helperPrepares += 1; throw new Error('old helper must not replay'); },
      prepareAgentProvider: async () => { prepares += 1; return composition; },
    };
    for (const mode of ['legacy', 'unreturned'] as const) {
      const interpreter = createProviderExplicitBrainInterpreter({ ...interpreterOptions, interactionScopeId: `runtime:${mode}` });
      await assert.rejects(() => interpreter.interpret(receipt.seeded[mode].request), mode === 'legacy'
        ? /cannot recover without an attested execution owner/ : /holds on unreturned helper/);
    }
    const terminal = createProviderExplicitBrainInterpreter({ ...interpreterOptions, interactionScopeId: 'runtime:terminal' });
    assert.equal((await terminal.interpret(receipt.seeded.terminal.request)).kind, 'answer');
    const terminalSnapshot = await parent.readTurnSnapshot(receipt.seeded.terminal.turn);
    assert.equal(terminalSnapshot.resourceClose, null);
    assert.equal(terminalSnapshot.ownerReconciliations[0]?.fact.remoteProviderState, 'unknown');
    assert.equal(terminalSnapshot.ownerReconciliations[0]?.fact.mode, 'terminal-output');
    assert.ok(await helpers.readSemanticCheckpointExact(receipt.seeded.terminal.turn));
    assert.equal(prepares, 0);
    assert.equal(providerRequests, 0);
    assert.equal(helperPrepares, 0);

    const pendingRequest = receipt.seeded.continue.request;
    const freshScope = 'runtime:fresh-missing-lease';
    await assert.rejects(() => createProviderExplicitBrainInterpreter({ ...interpreterOptions,
      interactionScopeId: freshScope, lease: () => undefined }).interpret({ ...pendingRequest, interactionId: 'fresh-missing-lease' }),
    /turn requires active supervisor lease authority/);
    assert.equal((await parent.readScopeOpenedTurns({ organId: interpreterOptions.organId, interactionScopeId: freshScope })).length, 0);
    assert.equal(prepares, 0, 'missing configured lease must hold before preparation or turn creation');
    await assert.rejects(() => createProviderExplicitBrainInterpreter({ ...interpreterOptions, lease: () => undefined })
      .interpret(pendingRequest), /requires active supervisor lease authority/);
    await assert.rejects(() => createProviderExplicitBrainInterpreter({ ...interpreterOptions, prepareAgentProvider: undefined,
      port: parentPort }).interpret(pendingRequest), /requires an owned provider preparer/);
    // A committed same-replacement reconciliation can be reused after a local
    // failure. A mismatched full binding closes the new owned composition once.
    let mismatchedCloses = 0;
    const wrongBinding = { ...binding, configDigest: 'sha256:wrong' };
    const wrongPort = new RecordedParentPort({ binding: wrongBinding, evidence, stepDelayMs: 0, replay: [] });
    const wrongClose = wrongPort.close.bind(wrongPort);
    wrongPort.close = async (selectedBinding) => { mismatchedCloses += 1; return wrongClose(selectedBinding); };
    await assert.rejects(() => createProviderExplicitBrainInterpreter({ ...interpreterOptions,
      prepareAgentProvider: async () => ({ ...composition, binding: wrongBinding, port: wrongPort }),
    }).interpret(pendingRequest), /requires the original full provider binding/);
    assert.equal(mismatchedCloses, 1);
    assert.equal(providerRequests, 0);

    runtime = await startUiRuntime({
      mode: 'rcc', organId: id('organ', 'explicit-test'), binding, port: parentPort as any,
      productRoot: root,
      checkpointRoot: join(root, 'checkpoints'), evidenceRoot: join(root, 'assets'),
      uiRoot: join(process.cwd(), 'docs/ui'), portNumber: 0, lease,
      accessControl: await AccessControlService.open({ credentialPath: join(root, 'security/web-access.json'), create: false }),
      explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      explicitBrainHelperProviderPreparer: async () => { helperPrepares += 1; throw new Error('old helper must not replay'); },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'preclose' },
      runtimeComposition: {
        prepareAgentProvider: async () => { prepares += 1; return composition as any; },
        prepareTaskAgentProvider: async () => { throw new Error('simple answer must not prepare Task'); },
      },
    });
    const persisted = await runtime.service.inspectExplicitInteraction(pendingRequest.interactionId);
    assert.equal(persisted.rawInput, pendingRequest.rawInput);
    assert.equal(persisted.sourceRef, pendingRequest.sourceRef);
    let result;
    try {
      result = await runtime.service.interpretExplicitInput({ interactionId: pendingRequest.interactionId });
    } catch (error) {
      const failed = await parent.readTurnSnapshot(receipt.seeded.continue.turn);
      console.log(JSON.stringify({ event: 'fresh-os-preclose-failure', error: String(error),
        requests: failed.requests.map(({ fact }) => ({ request: fact.request, phase: fact.phase })),
        reconciliations: failed.ownerReconciliations.map(({ fact }) => fact), resourceClose: failed.resourceClose?.fact,
        semanticCheckpoint: await helpers.readSemanticCheckpointExact(receipt.seeded.continue.turn),
        prepares, providerRequests, physicalCloses, helperPrepares }));
      throw error;
    }
    assert.ok(JSON.stringify(result).includes('continued after OS takeover'));
    const snapshot = await parent.readTurnSnapshot(receipt.seeded.continue.turn);
    assert.equal(snapshot.turnInput?.fact.turn.turnId, 'seed-continue');
    assert.equal(snapshot.turnInput?.fact.execution.operationId.value, 'op-continue');
    assert.deepEqual(snapshot.turnInput?.fact.providerBinding, binding);
    assert.deepEqual(snapshot.turnInput?.fact.executionOwner, receipt.ownerIdentity);
    assert.equal(snapshot.ownerReconciliations.length, 1);
    assert.equal(snapshot.ownerReconciliations[0]?.fact.effectiveExecutionEpoch, 2);
    assert.equal(snapshot.resourceClose?.fact.execution.executionEpoch, 2);
    assert.equal(snapshot.resourceClose?.fact.result.state, 'closed');
    // The epoch-2 Provider request must anchor to the settled parent leaf, so
    // the abandoned req-2 no longer leaves two settled terminal requests.
    const epochTwoRequest = snapshot.requests
      .map((entry) => entry.fact.request)
      .filter((request) => request.requestId !== 'req-1-continue' && request.requestId !== 'req-2')
      .at(-1);
    assert.equal(epochTwoRequest?.turnId, 'provider-continue');
    assert.equal(epochTwoRequest?.parentRequestId, 'req-1-continue');
    assert.equal(prepares, 1);
    assert.equal(providerRequests, 1);
    assert.equal(physicalCloses, 1);
    assert.equal(helperPrepares, 0);
    const checkpoint = await helpers.readSemanticCheckpointExact(receipt.seeded.continue.turn);
    assert.ok(checkpoint);
    if (checkpoint === null) throw new Error('missing preclose semantic checkpoint');
    assert.ok(checkpoint.checkpoint.claims.some((claim) => claim.fact.includes('returned-only')));
    console.log(JSON.stringify({ event: 'fresh-os-preclose-receipt', oldPid: child.pid, newPid: process.pid,
      oldGeneration: receipt.ownerIdentity.daemonGeneration, newGeneration: lease.record.generation,
      turnId: snapshot.turnInput?.fact.turn.turnId, operationId: snapshot.turnInput?.fact.execution.operationId.value,
      executionEpoch: snapshot.resourceClose?.fact.execution.executionEpoch, prepares, providerRequests, physicalCloses, helperPrepares,
      seededOldRequests: true, semanticCheckpoint: checkpoint.commit.commitId }));
  } finally {
    await runtime?.close();
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: a closed failed epoch that already committed raw facts has
// unknown side effects, so it must stay held instead of resuming. Impact:
// replaying partial provider output or tool side effects. Cost: one
// no-generation cold read on a seeded durable turn with a dead executor port.
test('provider explicit brain interpreter holds a closed failed epoch with accepted facts', async () => {
  const root = join(parentFixtureRoot, `partial-failed-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-partial-failed', providerId: 'provider-partial-failed', protocol: 'responses',
    endpointRef: 'http://recorded.test', modelRef: 'model-partial-failed',
    configDigest: 'sha256:partial-failed-config', capabilityDigest: 'sha256:partial-failed-capability',
  };
  const rawInput = '2 + 2 等于几？请只回答数字。';
  const request = { interactionId: 'partial-failed', inputRevision: 1, sourceRef: 'ui:partial-failed', rawInput, clarifications: [], taskCandidates: [] };
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const parent = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(join(root, 'parent-partial-failed.jsonl')));
  const helpers = new JsonlInteractionHelperJournal(new JsonlOrganJournal(join(root, 'parent-partial-failed.jsonl')));
  const externalCalls: string[] = [];
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    await ensureControlLayout(paths);
    lease = await acquireDaemonLease(paths);
    const ownerIdentity = await lease.withCurrentLeaseOwner(async (owner) => owner);
    const turn = { ...scope, interactionId: request.interactionId, inputRevision: 1, turnId: 'seed-partial-failed' };
    const operationScope = { organId: scope.organId, operationId: id('operation', 'op-partial-failed') };
    const execution = { runtimeId: 'runtime-partial-failed', ...operationScope, executionEpoch: 1, interactionTurn: turn };
    const initialInput = {
      ref: await evidence.write({ scope: operationScope, kind: 'execution', type: 'initial-input', locator: turn.turnId, content: JSON.stringify(request) }),
      view: { kind: 'utf8-text' as const },
    };
    const owner = createInteractionParentTurnRawOwner({ turn, execution, scope: operationScope, initialInput, providerBinding: binding,
      executionOwner: ownerIdentity, journal: parent, rawContent: providerRawContentReader(evidence) });
    await owner.openTurnInput();
    const req = { turnId: 'provider-partial-failed', requestId: 'req-1-partial-failed' };
    await owner.registerRequest({ execution, record: { request: req, scope: operationScope, phase: 'dispatching' } });
    await owner.registerRequest({ execution, record: { request: req, scope: operationScope, phase: 'dispatched' } });
    await owner.acceptRawFact({ execution, scope: operationScope, request: req, producerSeq: 1, fact: { kind: 'content', channel: 'assistant-text', update: 'full', contentUnitId: 'text',
      content: { ref: await evidence.write({ scope: operationScope, kind: 'execution', type: 'partial-text', locator: 'partial-text', content: 'partial' }), view: { kind: 'utf8-text' as const } }, complete: true } });
    await owner.registerRequest({ execution, record: { request: req, scope: operationScope, phase: 'failed' } });
    const closeEvidence = await evidence.write({ scope: operationScope, kind: 'execution', type: 'seed-close', locator: 'seed-close', content: 'seed-closed' });
    await owner.recordProviderClose({ providerBinding: binding, result: { bindingId: binding.bindingId, providerId: binding.providerId,
      protocol: binding.protocol, state: 'closed', evidenceRefs: [closeEvidence] }, closedAt: new Date().toISOString() });
    const deadPort = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], evidence });
    deadPort.start = async () => { externalCalls.push('start'); throw new Error('unexpected provider start'); };
    deadPort.observe = (() => { externalCalls.push('observe'); throw new Error('unexpected provider observe'); }) as typeof deadPort.observe;
    deadPort.settle = async () => { externalCalls.push('settle'); throw new Error('unexpected provider settle'); };
    const interpreter = createProviderExplicitBrainInterpreter({
      organId: scope.organId, interactionScopeId: scope.interactionScopeId,
      parentJournal: parent, checkpointJournal: helpers, helperJournal: helpers, turnHelperJournal: helpers,
      rawEvidence: evidence, rawContent: providerRawContentReader(evidence), clock: { now: () => new Date().toISOString() },
      binding, templateRoot: join(process.cwd(), 'packages/agent-templates/templates'), port: deadPort,
      helperFactory: async () => { externalCalls.push('helperFactory'); throw new Error('unexpected helper dispatch'); },
      prepareAgentProvider: async () => { externalCalls.push('prepareAgentProvider'); throw new Error('unexpected provider preparation'); },
    });
    await assert.rejects(() => interpreter.interpret(request), /requires every non-ignored request to be settled/);
    assert.deepEqual(externalCalls, [], 'a held partial failure must not acquire an executor');
    assert.equal((await parent.readTurnSnapshot(turn)).resourceClose?.fact.execution.executionEpoch, 1);
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: the A0 recovery runs under a new daemon generation after the
// original owner exits, so the failed-closed epoch must also resume under a
// distinct committed replacement owner. Impact: a recovery that only accepts a
// same-owner retry cannot reopen the turn after a real restart. Cost: one
// child seed process, one real UI consumer run, and one takeover on the same
// isolated durable fixture.
test('provider explicit brain interpreter resumes a failed closed epoch under a replacement owner', async () => {
  const root = join(parentFixtureRoot, `failed-closed-cold-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-failed-closed-cold', providerId: 'provider-failed-closed-cold', protocol: 'responses',
    endpointRef: 'http://recorded.test', modelRef: 'model-failed-closed-cold',
    configDigest: 'sha256:failed-closed-cold-config', capabilityDigest: 'sha256:failed-closed-cold-capability',
  };
  const rawInput = '2 + 2 等于几？请只回答数字。';
  const answerText = JSON.stringify({ kind: 'answer', normalizedInput: rawInput, knownFacts: [], answer: '4', decisionRefs: [] });
  const moduleUrl = (path: string) => new URL(`../../packages/${path}`, import.meta.url).href;
  // The seed writes the A0 failed-closed epoch through the public Runtime/JSONL
  // owners under generation 1, then exits without releasing the lease.
  const script = `
    import { startUiRuntime } from ${JSON.stringify(moduleUrl('app/src/ui-runtime/index.js'))};
    import { AccessControlService } from ${JSON.stringify(moduleUrl('app/src/ui-runtime/access-control.js'))};
    import { uiRuntimeControlJournalPath } from ${JSON.stringify(moduleUrl('app/src/ui-runtime/journal.js'))};
    import { acquireDaemonLease } from ${JSON.stringify(moduleUrl('app/src/supervisor/index.js'))};
    import { ensureControlLayout, resolveRuntimePaths } from ${JSON.stringify(moduleUrl('config/src/index.js'))};
    import { MemoryCoordinator } from ${JSON.stringify(moduleUrl('runtime/src/memory/index.js'))};
    import { DeterministicMemoryBackend } from ${JSON.stringify(moduleUrl('adapters/memory/src/index.js'))};
    import { createInteractionParentTurnRawOwner } from ${JSON.stringify(moduleUrl('runtime/src/explicit-brain/index.js'))};
    import { JsonlOrganJournal } from ${JSON.stringify(moduleUrl('adapters/jsonl/src/index.js'))};
    import { JsonlInteractionParentTurnJournal } from ${JSON.stringify(moduleUrl('adapters/jsonl/src/interaction-parent-turn-journal.js'))};
    import { ImmutableAssetStore } from ${JSON.stringify(moduleUrl('adapters/filesystem/src/index.js'))};
    import { ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } from ${JSON.stringify(moduleUrl('adapters/provider/src/index.js'))};
    import { providerRawContentReader } from ${JSON.stringify(moduleUrl('adapters/provider/src/evidence.js'))};
    import { id } from ${JSON.stringify(moduleUrl('contracts/src/index.js'))};
    import { join } from 'node:path';
    const root = ${JSON.stringify(root)}, binding = ${JSON.stringify(binding)};
    const paths = await resolveRuntimePaths({controlRoot: join(root, 'control'), workspace: process.cwd()});
    await ensureControlLayout(paths);
    const lease = await acquireDaemonLease(paths);
    const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
    ${RecordedParentPort.toString()}
    const runtime = await startUiRuntime({
      mode: 'rcc', organId: id('organ', 'explicit-test'), binding,
      port: new RecordedParentPort({binding, stepDelayMs: 0, replay: [], evidence}),
      productRoot: root,
      checkpointRoot: join(root, 'checkpoints'), evidenceRoot: join(root, 'assets'),
      uiRoot: join(process.cwd(), 'docs/ui'), portNumber: 0, lease,
      accessControl: await AccessControlService.open({credentialPath: join(root, 'security/web-access.json'), create: true}),
      explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      memory: {coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'failed-closed-cold'},
      runtimeComposition: {
        prepareAgentProvider: async () => { throw new Error('seed must not prepare Provider'); },
        prepareTaskAgentProvider: async () => { throw new Error('seed must not prepare Task'); },
      },
    });
    const interactionId = await runtime.service.receiveExplicitInput({sourceRef: 'ui:failed-closed-cold', rawInput: ${JSON.stringify(rawInput)}, channel: 'business'});
    const persisted = await runtime.service.inspectExplicitInteraction(interactionId);
    const request = {interactionId, inputRevision: 1, sourceRef: persisted.sourceRef, rawInput: persisted.rawInput, clarifications: [], taskCandidates: []};
    const journal = new JsonlOrganJournal(uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc')));
    const parent = new JsonlInteractionParentTurnJournal(journal);
    const rawContent = providerRawContentReader(evidence);
    const ownerIdentity = await lease.withCurrentLeaseOwner(async owner => owner);
    const turn = {organId: id('organ','explicit-test'), interactionScopeId: 'runtime:explicit-test', interactionId, inputRevision: 1, turnId: 'seed-failed-closed'};
    const scope = {organId: turn.organId, operationId: id('operation','op-seed-failed-closed')};
    const execution = {runtimeId: 'runtime-seed-failed-closed', ...scope, executionEpoch: 1, interactionTurn: turn};
    const initialInput = {ref: await evidence.write({scope, kind: 'execution', type: 'initial-input', locator: turn.turnId, content: JSON.stringify(request)}), view: {kind: 'utf8-text'}};
    const owner = createInteractionParentTurnRawOwner({turn, execution, scope, initialInput, providerBinding: binding, executionOwner: ownerIdentity, journal: parent, rawContent});
    await owner.openTurnInput();
    const req = {turnId: 'provider-seed-failed-closed', requestId: 'req-1-seed-failed-closed'};
    await owner.registerRequest({execution, record: {request: req, scope, phase: 'dispatching'}});
    await owner.registerRequest({execution, record: {request: req, scope, phase: 'dispatched'}});
    await owner.registerRequest({execution, record: {request: req, scope, phase: 'failed'}});
    const closeEvidence = await evidence.write({scope, kind: 'execution', type: 'seed-close', locator: 'seed-close', content: 'seed-closed'});
    await owner.recordProviderClose({providerBinding: binding, result: {bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol, state: 'closed', evidenceRefs: [closeEvidence]}, closedAt: new Date().toISOString()});
    console.log(JSON.stringify({pid: process.pid, ownerIdentity, interactionId}));
    process.exit(0); // deliberate crash boundary: no runtime.close or lease.release
  `;
  let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exit, 0, stderr);
    const receipt = JSON.parse(stdout.trim());
    assert.equal(receipt.pid, child.pid);
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    lease = await acquireDaemonLease(paths, { takeover: { reason: 'failed-closed cold test takeover', allowed: () => true } });
    assert.equal(lease.record.generation, 2);
    const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
    let providerRequests = 0;
    const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], evidence, respond: async () => {
      providerRequests += 1;
      return [{ type: 'response.output_text.done', item_id: 'final', text: answerText }];
    } });
    runtime = await startUiRuntime({
      mode: 'rcc', organId: id('organ', 'explicit-test'), binding, port: port as any,
      productRoot: root,
      checkpointRoot: join(root, 'checkpoints'), evidenceRoot: join(root, 'assets'),
      uiRoot: join(process.cwd(), 'docs/ui'), portNumber: 0, lease,
      accessControl: await AccessControlService.open({ credentialPath: join(root, 'security/web-access.json'), create: false }),
      explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'failed-closed-cold' },
      runtimeComposition: {
        prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
          provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
            model: binding.modelRef, route: 'recorded', baseUrl: binding.endpointRef },
          binding, port } as any),
        prepareTaskAgentProvider: async () => { throw new Error('a simple answer must not prepare a Task'); },
      },
    });
    const journalFile = uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc'));
    const parent = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile));
    const helpers = new JsonlInteractionHelperJournal(new JsonlOrganJournal(journalFile));
    const beforeReplay = await new JsonlOrganJournal(journalFile).replay();

    const answered = await runtime.service.interpretExplicitInput({ interactionId: receipt.interactionId });
    assert.equal(answered.state, 'answered');
    assert.equal(answered.reply, '4');
    assert.equal(providerRequests, 1);
    const opened = await parent.readScopeOpenedTurns({ organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' });
    assert.equal(opened.length, 1);
    const turn = opened[0]!.fact.turn;
    assert.equal(turn.turnId, 'seed-failed-closed');
    const resumed = await parent.readTurnSnapshot(turn);
    assert.equal(resumed.ownerReconciliations.length, 1);
    const reconciliation = resumed.ownerReconciliations[0]!.fact;
    assert.equal(reconciliation.previousOwner.daemonGeneration, 1);
    assert.equal(reconciliation.replacementOwner.daemonGeneration, 2);
    assert.ok(JSON.stringify(reconciliation.previousOwner) !== JSON.stringify(reconciliation.replacementOwner),
      'the replacement owner must differ from the original owner');
    assert.equal(reconciliation.mode, 'continue');
    assert.equal(reconciliation.effectiveExecutionEpoch, 2);
    assert.equal(resumed.resourceClose?.fact.execution.executionEpoch, 2);
    assert.ok(await helpers.readSemanticCheckpointExact(turn));
    const afterReplay = await new JsonlOrganJournal(journalFile).replay();
    assert.ok(afterReplay.length > beforeReplay.length);
    assert.deepEqual(afterReplay.slice(0, beforeReplay.length), beforeReplay);
  } finally {
    await runtime?.close();
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

test('provider explicit brain interpreter recovers a physically closed parent turn from a fresh consumer', async () => {
  // Failure basis: the retained-only gate rejects a turn with a committed close
  // and complete durable helper collection after the producer interpreter is
  // gone. Impact: a physically closed turn cannot form its semantic checkpoint
  // from a fresh consumer. Cost: one controlled fresh-consumer run on the real
  // JSONL consumer with one semantic append fault.
  const recoveryRoot = join(parentFixtureRoot, `cold-recovery-${randomUUID()}`);
  await mkdir(recoveryRoot, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-parent-cold-recovery', providerId: 'provider-parent-cold-recovery', protocol: 'responses',
    endpointRef: 'fake://parent-cold-recovery', modelRef: 'model-parent-cold-recovery',
    configDigest: 'sha256:parent-cold-recovery-config', capabilityDigest: 'sha256:parent-cold-recovery-capability',
  };
  const journalFile = join(recoveryRoot, 'parent-cold-recovery.jsonl');
  const producerOrgan = new JsonlOrganJournal(journalFile);
  const producerParent = new JsonlInteractionParentTurnJournal(producerOrgan);
  const producerHelper = new JsonlInteractionHelperJournal(producerOrgan);
  const producerEvidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(recoveryRoot, 'assets')));
  let appendAttempts = 0;
  const flakyCheckpointJournal: InteractionSemanticCheckpointJournalPort = {
    appendSemanticCheckpoint: async (checkpoint) => {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error('semantic checkpoint ack lost after close');
      return producerHelper.appendSemanticCheckpoint(checkpoint);
    },
    readSemanticCheckpointExact: (identity) => producerHelper.readSemanticCheckpointExact(identity),
    readScopeSemanticCheckpoints: (scopeKey) => producerHelper.readScopeSemanticCheckpoints(scopeKey),
  };
  const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };
  const request = {
    interactionId: 'parent-cold-recovery', inputRevision: 1, sourceRef: 'ui:new-task',
    rawInput: 'recover this closed turn', clarifications: [], taskCandidates: [],
  };
  const acceptedChildAgentId = 'helper-accepted';
  const unacceptedChildAgentId = 'helper-unaccepted';
  const refinedText = 'accepted refined cold recovery result';
  let acceptedHelperIdentity: Parameters<typeof producerHelper.readExact>[0] | undefined;
  let unacceptedHelperIdentity: Parameters<typeof producerHelper.readExact>[0] | undefined;
  const finalAnswer = `recovered ${'answer body '.repeat(80)}`;
  const finalText = JSON.stringify({
    kind: 'answer', normalizedInput: 'recover this closed turn', knownFacts: [], answer: finalAnswer, decisionRefs: [],
  });
  const parentPort = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], evidence: producerEvidence, respond: async (wire) => {
    const results = wire.input.filter((item: any) => item.type === 'function_call_output');
    if (results.length === 0) {
      const dispatch = (callId: string, configuredAgentId: string) => ({
        type: 'response.output_item.done',
        output_index: callId === 'dispatch-accepted' ? 0 : 1,
        item: { type: 'function_call', call_id: callId, name: 'dispatch_helper', arguments: JSON.stringify({
          selection: { roleId: 'review', configuredAgentId },
          assignmentFields: {
            objective: 'bounded helper result', targetRefs: [], expectedOutputRefs: [], expectedArtifactDigests: [],
            acceptanceCriteriaDigest: `sha256:${'a'.repeat(64)}`, successCriteria: ['complete'], failureCriteria: ['none'],
            incompleteCriteria: ['partial'], requiredCapabilities: [], mergeGate: 'not-required',
          },
          inputs: { slot: configuredAgentId }, evidenceRefs: [],
        }) },
      });
      return [dispatch('dispatch-accepted', acceptedChildAgentId), dispatch('dispatch-unaccepted', unacceptedChildAgentId)];
    }
    if (results.length === 2) {
      const accepted = results.find((result: any) => result.call_id === 'dispatch-accepted');
      assert.ok(accepted, 'the accepted helper dispatch must return');
      const unaccepted = results.find((result: any) => result.call_id === 'dispatch-unaccepted');
      assert.ok(unaccepted, 'the returned-only helper dispatch must return');
      const dispatched = JSON.parse(accepted.output);
      const returnedOnly = JSON.parse(unaccepted.output);
      acceptedHelperIdentity = dispatched.identity;
      unacceptedHelperIdentity = returnedOnly.identity;
      const acceptedIdentity = requirePresent(acceptedHelperIdentity, 'accepted helper identity');
      const unacceptedIdentity = requirePresent(unacceptedHelperIdentity, 'unaccepted helper identity');
      const acceptedReadback = await producerHelper.readExact(acceptedIdentity);
      const acceptedReturnedCheckpoint = requirePresent(acceptedReadback.returnedCheckpoint, 'accepted returned checkpoint');
      assert.ok(acceptedReadback.returned);
      assert.equal(acceptedReadback.adoptedCheckpoint, null);
      assert.equal(acceptedReadback.ownerAccepted, null);
      const acceptedReturnedDescription = acceptedReturnedCheckpoint.checkpoint.description;
      assert.ok(acceptedReturnedDescription.includes('bounded helper result'));
      assert.ok(acceptedReturnedDescription.includes('owner acceptance is pending'));
      assert.ok(acceptedReturnedDescription.includes('succeeded'));
      assert.ok(acceptedReturnedDescription.includes(`${acceptedChildAgentId} summary`));
      assert.ok(acceptedReturnedDescription.includes('wait'));
      assert.ok(acceptedReturnedDescription.includes(`condition:${acceptedChildAgentId}`));
      const unacceptedReadback = await producerHelper.readExact(unacceptedIdentity);
      assert.ok(unacceptedReadback.returned);
      const unacceptedReturnedCheckpoint = requirePresent(
        unacceptedReadback.returnedCheckpoint,
        'unaccepted returned checkpoint',
      );
      assert.equal(unacceptedReadback.adoptedCheckpoint, null);
      assert.equal(unacceptedReadback.ownerAccepted, null);
      const unacceptedReturnedDescription = unacceptedReturnedCheckpoint.checkpoint.description;
      assert.ok(unacceptedReturnedDescription.includes('bounded helper result'));
      assert.ok(unacceptedReturnedDescription.includes('owner acceptance is pending'));
      assert.ok(unacceptedReturnedDescription.includes('incomplete'));
      assert.ok(unacceptedReturnedDescription.includes(`${unacceptedChildAgentId} summary`));
      assert.ok(unacceptedReturnedDescription.includes('wait'));
      assert.ok(unacceptedReturnedDescription.includes(`condition:${unacceptedChildAgentId}`));
      assert.ok(unacceptedReturnedDescription !== acceptedReturnedDescription);
      return [{
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', call_id: 'accept-accepted', name: 'accept_helper', arguments: JSON.stringify({
          helperCallId: dispatched.identity.helperCallId,
          refinedText,
          acceptanceRef: 'acceptance:cold-recovery',
          evidenceRefs: [],
        }) },
      }];
    }
    if (results.length === 3) {
      const acceptedIdentity = requirePresent(acceptedHelperIdentity, 'accepted helper identity');
      const acceptedReadback = await producerHelper.readExact(acceptedIdentity);
      const ownerAccepted = requirePresent(acceptedReadback.ownerAccepted, 'owner-accepted helper fact');
      assert.equal(ownerAccepted.fact.acceptanceRef, 'acceptance:cold-recovery');
      assert.equal(ownerAccepted.fact.result.status, 'succeeded');
      const adoptedCheckpoint = requirePresent(acceptedReadback.adoptedCheckpoint, 'adopted helper checkpoint');
      assert.equal(adoptedCheckpoint.checkpoint.description, refinedText);
      assert.equal(adoptedCheckpoint.checkpoint.recovery.ownerAcceptedCommitId, ownerAccepted.commit.commitId);
      return [{ type: 'response.output_text.done', item_id: 'final', text: finalText }];
    }
    throw new Error(`unexpected parent response round with ${results.length} tool results`);
  } });
  const producerInterpreter = createProviderExplicitBrainInterpreter({
    organId: scope.organId,
    interactionScopeId: scope.interactionScopeId,
    parentJournal: producerParent,
    checkpointJournal: flakyCheckpointJournal,
    helperJournal: producerHelper,
    rawEvidence: producerEvidence,
    rawContent: providerRawContentReader(producerEvidence),
    helperFactory: async ({ selection, assignment, execution }) => {
      const configuredAgentId = selection.configuredAgentId;
      assert.ok(configuredAgentId === acceptedChildAgentId || configuredAgentId === unacceptedChildAgentId);
      const childBinding = { ...binding, bindingId: `child-${configuredAgentId}`, modelRef: `model-${configuredAgentId}` };
      const childPort = new RecordedParentPort<TasklessProviderExecutionIdentityRef>({ binding: childBinding, stepDelayMs: 0, replay: [], evidence: producerEvidence, respond: async () => [{
        type: 'response.output_text.done',
        item_id: 'child',
        text: JSON.stringify({
          agentId: configuredAgentId,
          producedArtifactRefs: [],
          producedArtifactDigests: [],
          status: configuredAgentId === acceptedChildAgentId ? 'succeeded' : 'incomplete',
          summary: `${configuredAgentId} summary`,
          outputRefs: [],
          evidenceRefs: [],
          nextAction: 'wait',
          conditionRef: `condition:${configuredAgentId}`,
        }),
      }] });
      return {
        binding: childBinding,
        driver: new ProviderAgentDriver<TasklessProviderExecutionIdentityRef>({
          port: childPort,
          binding: childBinding,
          ...execution,
          organId: assignment.organId,
          helper: assignment,
          assignmentId: assignment.assignmentId,
          scope: { organId: assignment.organId, operationId: execution.operationId },
          inputRefs: [],
        }),
        close: async () => { await childPort.close(childBinding); },
      };
    },
    clock: { now: () => '2026-10-16T00:00:00.000Z' },
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: parentPort,
    prepareAgentProvider: async () => ({
      roleId: 'interaction',
      source: 'http',
      provider: {
        source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'parent-cold-recovery', baseUrl: binding.endpointRef,
      },
      binding,
      port: parentPort,
    }),
  });

  try {
    await assert.rejects(
      () => producerInterpreter.interpret(request),
      /semantic checkpoint ack lost after close/,
    );
    const opened = await producerParent.readScopeOpenedTurns(scope);
    assert.equal(opened.length, 1);
    const turn = opened[0]!.fact.turn;
    const beforeSnapshot = await producerParent.readTurnSnapshot(turn);
    assert.ok(beforeSnapshot.turnInput, 'the original turn input must be durable');
    assert.ok(beforeSnapshot.requests.length > 0, 'the original parent request must be durable');
    assert.ok(beforeSnapshot.acceptedFacts.length > 0, 'the original raw facts must be durable');
    assert.ok(beforeSnapshot.resourceClose, 'the original physical close must be durable');
    assert.equal(await producerHelper.readSemanticCheckpointExact(turn), null, 'the fault leaves no semantic checkpoint');
    const beforeReplay = await new JsonlOrganJournal(journalFile).replay();

    // Drop every producer interpreter/session reference above. The consumer
    // below reads only the same physical journal and asset store.
    const readerOrgan = new JsonlOrganJournal(journalFile);
    const readerParent = new JsonlInteractionParentTurnJournal(readerOrgan);
    const readerHelper = new JsonlInteractionHelperJournal(readerOrgan);
    const readerEvidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(recoveryRoot, 'assets')));
    const acceptedIdentity = requirePresent(acceptedHelperIdentity, 'accepted helper identity');
    const unacceptedIdentity = requirePresent(unacceptedHelperIdentity, 'unaccepted helper identity');
    const coldAcceptedReadback = await readerHelper.readExact(acceptedIdentity);
    const coldAcceptedCheckpoint = requirePresent(coldAcceptedReadback.adoptedCheckpoint, 'cold adopted checkpoint');
    const coldAcceptedReturned = requirePresent(
      coldAcceptedReadback.returnedCheckpoint,
      'cold accepted returned checkpoint',
    );
    assert.ok(coldAcceptedReturned.checkpoint.description.includes('succeeded'));
    assert.ok(coldAcceptedReturned.checkpoint.description.includes(`${acceptedChildAgentId} summary`));
    assert.ok(coldAcceptedReturned.checkpoint.description.includes(`condition:${acceptedChildAgentId}`));
    assert.equal(coldAcceptedCheckpoint.checkpoint.description, refinedText);
    assert.equal(coldAcceptedReadback.ownerAccepted?.fact.acceptanceRef, 'acceptance:cold-recovery');
    assert.equal(coldAcceptedReadback.ownerAccepted?.fact.result.status, 'succeeded');
    const coldUnacceptedReadback = await readerHelper.readExact(unacceptedIdentity);
    const coldUnacceptedReturned = requirePresent(
      coldUnacceptedReadback.returnedCheckpoint,
      'cold unaccepted returned checkpoint',
    );
    assert.ok(coldUnacceptedReturned.checkpoint.description.includes('incomplete'));
    assert.ok(coldUnacceptedReturned.checkpoint.description.includes(`${unacceptedChildAgentId} summary`));
    assert.ok(coldUnacceptedReturned.checkpoint.description.includes(`condition:${unacceptedChildAgentId}`));
    assert.equal(coldUnacceptedReadback.adoptedCheckpoint, null);
    assert.equal(coldUnacceptedReadback.ownerAccepted, null);
    const externalCalls: string[] = [];
    const deadPort = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], evidence: readerEvidence });
    deadPort.start = async () => { externalCalls.push('start'); throw new Error('unexpected provider start'); };
    deadPort.observe = (() => { externalCalls.push('observe'); throw new Error('unexpected provider observe'); }) as typeof deadPort.observe;
    deadPort.settle = async () => { externalCalls.push('settle'); throw new Error('unexpected provider settle'); };
    deadPort.close = async () => { externalCalls.push('close'); throw new Error('unexpected provider close'); };
    const consumerOptions = {
      organId: scope.organId,
      interactionScopeId: scope.interactionScopeId,
      parentJournal: readerParent,
      checkpointJournal: readerHelper,
      helperJournal: readerHelper,
      rawEvidence: readerEvidence,
      rawContent: providerRawContentReader(readerEvidence),
      helperFactory: async () => { externalCalls.push('helperFactory'); throw new Error('unexpected helper dispatch'); },
      clock: { now: () => '2026-10-16T00:00:01.000Z' },
      binding,
      templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      port: deadPort,
      prepareAgentProvider: async () => { externalCalls.push('prepareAgentProvider'); throw new Error('unexpected provider preparation'); },
    };
    // Failure basis: a missing new read port could be mistaken for an empty
    // helper collection. Impact: false completion without durable helper
    // evidence. Cost: one no-generation cold call on the same fixture.
    const missingPortInterpreter = createProviderExplicitBrainInterpreter(consumerOptions);
    await assert.rejects(
      () => missingPortInterpreter.interpret(request),
      /requires the durable helper turn read port for cold recovery/,
    );
    assert.equal(await readerHelper.readSemanticCheckpointExact(turn), null);
    assert.deepEqual(externalCalls, []);

    const consumerInterpreter = createProviderExplicitBrainInterpreter({
      ...consumerOptions,
      turnHelperJournal: readerHelper,
    });
    const result = await consumerInterpreter.interpret(request);
    assert.equal(result.kind, 'answer');
    if (result.kind !== 'answer') throw new Error('expected recovered answer');
    assert.equal(result.answer, finalAnswer);
    assert.deepEqual(externalCalls, [], 'cold recovery must not replay external work');

    const afterSnapshot = await readerParent.readTurnSnapshot(turn);
    assert.deepEqual(afterSnapshot, beforeSnapshot, 'recovery must not change the original turn facts');
    const afterReplay = await new JsonlOrganJournal(journalFile).replay();
    assert.equal(afterReplay.length, beforeReplay.length + 1, 'recovery must add only the semantic checkpoint record');
    assert.deepEqual(afterReplay.slice(0, beforeReplay.length), beforeReplay);

    const committed = await readerHelper.readSemanticCheckpointExact(turn);
    assert.ok(committed, 'cold recovery must commit the semantic checkpoint');
    if (committed === null) throw new Error('missing cold recovery semantic checkpoint');
    const semantic = committed.checkpoint.claims.map((claim) => claim.fact).join('\n');
    assert.ok(semantic.includes(refinedText), 'accepted helper refinement must reach the checkpoint');
    assert.ok(semantic.includes(unacceptedChildAgentId), 'returned-unaccepted helper must remain attributed');
    assert.ok(semantic.includes('returned-only'), 'returned-unaccepted helper must remain partial');
    assert.equal(
      committed.checkpoint.claims.some((claim) => claim.fact.includes(unacceptedChildAgentId) && claim.certainty === 'confirmed'),
      false,
      'returned-unaccepted helper must not become owner-accepted work',
    );
  } finally {
    await rm(recoveryRoot, { recursive: true, force: true });
  }
});

// Failure basis: live A0 interaction-2 committed a Provider observe transport
// failure and a real epoch-1 resource close with zero accepted facts. The cold
// reader treated that committed close as terminal output and threw
// `found 0`, so the same durable turn could never resume. Impact: the
// interaction wedges in `matching` after any transport observe failure that
// closes its epoch, or a broader fix would replay partial side effects. Cost:
// one real UI consumer run with one failing Provider observation and one retry
// on the same JSONL fixture.
test('provider explicit brain interpreter resumes a failed closed epoch on the same identity', async () => {
  const root = join(parentFixtureRoot, `failed-closed-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-failed-closed', providerId: 'provider-failed-closed', protocol: 'responses',
    endpointRef: 'http://recorded.test', modelRef: 'model-failed-closed',
    configDigest: 'sha256:failed-closed-config', capabilityDigest: 'sha256:failed-closed-capability',
  };
  const rawInput = '2 + 2 等于几？请只回答数字。';
  const answerText = JSON.stringify({ kind: 'answer', normalizedInput: rawInput, knownFacts: [], answer: '4', decisionRefs: [] });
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  let providerRequests = 0;
  // The first physical epoch terminates mid-stream, exactly like the live A0
  // `transport.failure` observe error. The retry settles on the same port.
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], evidence, respond: async () => {
    providerRequests += 1;
    if (providerRequests === 1) throw new TypeError('terminated');
    return [{ type: 'response.output_text.done', item_id: 'final', text: answerText }];
  } });
  let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    await ensureControlLayout(paths);
    lease = await acquireDaemonLease(paths);
    runtime = await startUiRuntime({
      mode: 'rcc', organId: id('organ', 'explicit-test'), binding, port: port as any,
      productRoot: root,
      checkpointRoot: join(root, 'checkpoints'), evidenceRoot: join(root, 'assets'),
      uiRoot: join(process.cwd(), 'docs/ui'), portNumber: 0, lease,
      accessControl: await AccessControlService.open({ credentialPath: join(root, 'security/web-access.json'), create: true }),
      explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'failed-closed' },
      runtimeComposition: {
        prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
          provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
            model: binding.modelRef, route: 'recorded', baseUrl: binding.endpointRef },
          binding, port } as any),
        prepareTaskAgentProvider: async () => { throw new Error('a simple answer must not prepare a Task'); },
      },
    });
    const interactionId = await runtime.service.receiveExplicitInput({ sourceRef: 'ui:failed-closed', rawInput, channel: 'business' });
    const journalFile = uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc'));
    const parent = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile));
    const helpers = new JsonlInteractionHelperJournal(new JsonlOrganJournal(journalFile));
    const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };
    const tasksBefore = runtime.service.listTasks().counts.total;

    // First attempt: the Provider stream terminates during observe. The App
    // records the request failure and the real epoch-1 close, then rejects.
    await assert.rejects(() => runtime!.service.interpretExplicitInput({ interactionId }), /terminated/);
    const opened = await parent.readScopeOpenedTurns(scope);
    assert.equal(opened.length, 1);
    const turn = opened[0]!.fact.turn;
    assert.equal(turn.interactionId, interactionId);
    assert.equal(turn.inputRevision, 1);
    const failed = await parent.readTurnSnapshot(turn);
    assert.equal(failed.turnInput?.fact.execution.executionEpoch, 1);
    assert.deepEqual(failed.requests.map(({ fact }) => fact.phase), ['dispatching', 'dispatched', 'failed']);
    assert.equal(failed.acceptedFacts.length, 0, 'the transport failure accepts no raw fact');
    assert.equal(failed.resourceClose?.fact.execution.executionEpoch, 1);
    assert.equal(failed.resourceClose?.fact.result.state, 'closed');
    assert.equal(await helpers.readSemanticCheckpointExact(turn), null);
    assert.equal((await runtime.service.inspectExplicitInteraction(interactionId)).state, 'matching');
    assert.equal(providerRequests, 1);
    const beforeReplay = await new JsonlOrganJournal(journalFile).replay();

    // Second attempt: the same interaction/revision resumes the same durable
    // turn in a new physical epoch instead of reading the close as success.
    const answered = await runtime.service.interpretExplicitInput({ interactionId });
    assert.equal(answered.state, 'answered');
    assert.equal(answered.reply, '4');
    assert.deepEqual(answered.history, ['received', 'matching', 'answered']);
    assert.equal(providerRequests, 2);
    const resumed = await parent.readTurnSnapshot(turn);
    assert.equal(resumed.turnInput?.fact.execution.executionEpoch, 1, 'the business identity keeps its original epoch');
    assert.equal(resumed.ownerReconciliations.length, 1);
    const reconciliation = resumed.ownerReconciliations[0]!.fact;
    assert.deepEqual(reconciliation.previousOwner, reconciliation.replacementOwner,
      'the same live daemon lease resumes its own failed closed epoch');
    assert.equal(reconciliation.mode, 'continue');
    assert.equal(reconciliation.effectiveExecutionEpoch, 2);
    assert.deepEqual(reconciliation.unsettledRequestIds, [failed.requests[0]!.fact.request.requestId]);
    assert.equal(resumed.resourceClose?.fact.execution.executionEpoch, 2);
    const epochTwoRequestId = resumed.requests
      .map(({ fact }) => fact.request.requestId)
      .find((requestId) => requestId !== failed.requests[0]!.fact.request.requestId);
    assert.ok(epochTwoRequestId !== undefined, 'the retry must register a new request');
    assert.equal(resumed.requests.filter(({ fact }) => fact.request.requestId === epochTwoRequestId).at(-1)?.fact.phase, 'settled');
    assert.ok(resumed.acceptedFacts.some(({ fact }) =>
      fact.envelope.request.requestId === epochTwoRequestId && fact.envelope.fact.kind === 'request-complete'));
    assert.ok(await helpers.readSemanticCheckpointExact(turn));
    // Only appended facts; the original epoch-1 records stay byte-identical.
    const afterReplay = await new JsonlOrganJournal(journalFile).replay();
    assert.ok(afterReplay.length > beforeReplay.length);
    assert.deepEqual(afterReplay.slice(0, beforeReplay.length), beforeReplay);
    assert.equal(runtime.service.listTasks().counts.total, tasksBefore, 'a simple answer must not create a Task or FIFO entry');
  } finally {
    await runtime?.close();
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: real A0 interaction-115 / explicit-interpret-160f91f5-b333-482a-9567-45c84b41cbd9
// committed one settled terminal request whose response carried TWO complete
// assistant-text items (an answer item and a requirement item). The raw fold is
// faithful and concatenates both, so JSON.parse fails at position 200. The
// interpreter then rethrew after recording the provider close and committed no
// semantic closure at all, so `readPendingTurn` kept reporting the turn forever
// and every later input died on "unclosed interaction parent turn ... requires
// recovery or semantic closure". Impact: one unparseable terminal output bricks
// the whole interaction scope permanently. Cost: one seeded closed turn with the
// exact two-item shape and two follow-up interprets.
test('provider explicit brain interpreter closes an unparseable cold terminal output instead of bricking the scope', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-parse-failure', providerId: 'provider-parse-failure', protocol: 'responses',
    endpointRef: 'recorded://parse-failure', modelRef: 'model-parse-failure',
    configDigest: 'sha256:parse-failure-config', capabilityDigest: 'sha256:parse-failure-capability',
  };
  const scope = { organId: deps.organId, interactionScopeId: deps.interactionScopeId };
  const request = {
    interactionId: 'interaction-parse-failure', inputRevision: 1, sourceRef: 'ui:parse-failure',
    rawInput: '4 加 4 等于几？', clarifications: [], taskCandidates: [],
  };
  const operationScope = { organId: scope.organId, operationId: id('operation', 'op-parse-failure') };
  const turn: InteractionTurnIdentity = {
    organId: scope.organId, interactionScopeId: scope.interactionScopeId,
    interactionId: request.interactionId, inputRevision: 1, turnId: 'explicit-interpret-parse-failure',
  };
  const execution = { runtimeId: turn.turnId, ...operationScope, executionEpoch: 1, interactionTurn: turn };
  const initialInput = {
    ref: await deps.rawEvidence.write({
      scope: operationScope, kind: 'execution', type: 'initial-input',
      locator: turn.turnId, content: JSON.stringify(request),
    }),
    view: { kind: 'utf8-text' as const },
  };
  const owner = createInteractionParentTurnRawOwner({
    turn, execution, scope: operationScope, initialInput, providerBinding: binding,
    executionOwner: { daemonLeaseId: 'lease-parse-failure', daemonGeneration: 1, processStartToken: 'process-parse-failure' },
    journal: deps.parentJournal, rawContent: deps.rawContent,
  });
  await owner.openTurnInput();
  const terminalRequest = { turnId: turn.turnId, requestId: 'request-parse-failure' };
  await owner.registerRequest({ execution, record: { request: terminalRequest, scope: operationScope, phase: 'dispatching' } });
  await owner.registerRequest({ execution, record: { request: terminalRequest, scope: operationScope, phase: 'dispatched' } });
  // Two complete assistant-text items in the same response, exactly like the
  // production batch: a short answer decision and a long requirement decision.
  const answerItem = JSON.stringify({
    kind: 'answer', normalizedInput: request.rawInput, knownFacts: [], answer: '8', decisionRefs: [],
  });
  const requirementItem = JSON.stringify({
    kind: 'requirement', normalizedInput: request.rawInput, knownFacts: [],
    decisionRefs: [], intent: 'create', proposal: { revision: 1, intent: 'create', title: '标题', objective: '目标' },
  });
  for (const [index, text] of [answerItem, requirementItem].entries()) {
    await owner.acceptRawFact({
      execution, scope: operationScope, request: terminalRequest, producerSeq: index + 1,
      fact: {
        kind: 'content', channel: 'assistant-text', update: 'full', contentUnitId: `item-${index}`,
        content: { ref: await deps.rawEvidence.write({
          scope: operationScope, kind: 'execution', type: `item-${index}`, locator: `item-${index}`, content: text,
        }), view: { kind: 'utf8-text' as const } },
        complete: true,
      },
    });
  }
  await owner.acceptRawFact({
    execution, scope: operationScope, request: terminalRequest, producerSeq: 3,
    fact: { kind: 'request-complete', terminal: 'completed' },
  });
  await owner.registerRequest({ execution, record: { request: terminalRequest, scope: operationScope, phase: 'settled' } });
  await owner.recordProviderClose({
    providerBinding: binding,
    result: {
      bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol,
      state: 'closed',
      evidenceRefs: [await deps.rawEvidence.write({
        scope: operationScope, kind: 'execution', type: 'close', locator: 'close', content: 'closed',
      })],
    },
    closedAt: new Date().toISOString(),
  });
  // The seeded turn is the exact production shape: real close, real terminal
  // output, no decision.
  const seeded = await deps.parentJournal.readTurnSnapshot(turn);
  assert.equal(seeded.resourceClose?.fact.result.state, 'closed');
  assert.equal(seeded.abandonment, null);
  assert.equal(seeded.parseFailure, null);

  let providerStarts = 0;
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], respond: async () => {
    providerStarts += 1;
    return [{ type: 'response.output_text.done', item_id: 'final', text: JSON.stringify({
      kind: 'answer', normalizedInput: '4 加 4 等于几？', knownFacts: [], answer: '8', decisionRefs: [],
    }) }];
  } });
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), port,
  });

  // RED: the interpreter must fail honestly on the unusable output...
  await assert.rejects(
    () => interpreter.interpret(request),
    (error: unknown) => error instanceof Error
      && error.message.includes('interaction agent returned invalid JSON'),
  );
  // ...and the turn must be durably closed, not left pending. Abandonment is the
  // wrong fact here: a real terminal output exists.
  const closed = await deps.parentJournal.readTurnSnapshot(turn);
  assert.equal(closed.abandonment, null, 'a turn with real terminal output is never abandoned');
  assert.equal(closed.parseFailure?.fact.terminalRequestId, terminalRequest.requestId);
  assert.equal(closed.parseFailure?.fact.executionEpoch, 1);
  assert.deepEqual(await deps.parentJournal.readScopeAbandonedTurns(scope), []);
  assert.equal((await deps.parentJournal.readScopeParseFailures(scope)).length, 1);
  assert.equal(await deps.helperJournal.readSemanticCheckpointExact(turn), null,
    'an unusable output makes no semantic claim');

  // GREEN requirement: the exact retry reuses the committed fact, writes no
  // duplicate and does not brick the scope. It re-interprets on a fresh turn.
  const retried = await interpreter.interpret(request);
  assert.equal(retried.kind, 'answer');
  if (retried.kind !== 'answer') throw new Error('expected an answer');
  assert.equal(retried.answer, '8');
  assert.equal((await deps.parentJournal.readScopeParseFailures(scope)).length, 1,
    'the closure is written once and reused');

  // A new input in the same scope is usable after the failed turn and the retry.
  const next = await interpreter.interpret({
    interactionId: 'interaction-after-parse-failure', inputRevision: 1, sourceRef: 'ui:parse-failure-next',
    rawInput: '4 加 4 等于几？', clarifications: [], taskCandidates: [],
  });
  assert.equal(next.kind, 'answer');
  assert.equal(providerStarts, 2, 'only the two recoverable turns started a Provider');
});

// Failure basis: the same production shape, but the two complete assistant-text
// items arrive inside one live Provider response instead of being re-read from a
// closed turn. The catch path already records the real close, then rethrows with
// no durable closure, so the whole scope stays bricked. Impact: every later
// input on the interaction fails with the unclosed-turn error. Cost: one real UI
// consumer run with a two-item Provider response and two follow-up inputs.
test('provider explicit brain interpreter closes an unparseable live epoch and keeps the scope usable', async () => {
  const root = join(parentFixtureRoot, `parse-failure-live-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-parse-live', providerId: 'provider-parse-live', protocol: 'responses',
    endpointRef: 'http://recorded.test', modelRef: 'model-parse-live',
    configDigest: 'sha256:parse-live-config', capabilityDigest: 'sha256:parse-live-capability',
  };
  const rawInput = '4 加 4 等于几？';
  const answerText = JSON.stringify({ kind: 'answer', normalizedInput: rawInput, knownFacts: [], answer: '8', decisionRefs: [] });
  // The exact production batch: two complete assistant-text items, same request.
  const requirementText = JSON.stringify({
    kind: 'requirement', normalizedInput: rawInput, knownFacts: [], decisionRefs: [],
    intent: 'create', proposal: { revision: 1, intent: 'create', title: '标题', objective: '目标' },
  });
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  let providerRequests = 0;
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], evidence, respond: async () => {
    providerRequests += 1;
    if (providerRequests === 1) return [
      { type: 'response.output_text.done', item_id: 'item_0f6ad37e', text: answerText },
      { type: 'response.output_text.done', item_id: 'item_212eb4', text: requirementText },
    ];
    return [{ type: 'response.output_text.done', item_id: 'final', text: answerText }];
  } });
  let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    await ensureControlLayout(paths);
    lease = await acquireDaemonLease(paths);
    runtime = await startUiRuntime({
      mode: 'rcc', organId: id('organ', 'explicit-test'), binding, port: port as any,
      productRoot: root,
      checkpointRoot: join(root, 'checkpoints'), evidenceRoot: join(root, 'assets'),
      uiRoot: join(process.cwd(), 'docs/ui'), portNumber: 0, lease,
      accessControl: await AccessControlService.open({ credentialPath: join(root, 'security/web-access.json'), create: true }),
      explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'parse-live' },
      runtimeComposition: {
        prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
          provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
            model: binding.modelRef, route: 'recorded', baseUrl: binding.endpointRef },
          binding, port } as any),
        prepareTaskAgentProvider: async () => { throw new Error('a simple answer must not prepare a Task'); },
      },
    });
    const interactionId = await runtime.service.receiveExplicitInput({ sourceRef: 'ui:parse-live', rawInput, channel: 'business' });
    const journalFile = uiRuntimeControlJournalPath(join(root, 'checkpoints/rcc'));
    const parent = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile));
    const helpers = new JsonlInteractionHelperJournal(new JsonlOrganJournal(journalFile));
    const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test' };

    // RED: the two-item terminal output cannot be parsed into a decision.
    await assert.rejects(
      () => runtime!.service.interpretExplicitInput({ interactionId }),
      (error: unknown) => error instanceof Error
        && error.message.includes('interaction agent returned invalid JSON'),
    );
    const opened = await parent.readScopeOpenedTurns(scope);
    assert.equal(opened.length, 1);
    const turn = opened[0]!.fact.turn;
    const closed = await parent.readTurnSnapshot(turn);
    // The real close is recorded, and the turn is closed by its own honest fact.
    assert.equal(closed.resourceClose?.fact.result.state, 'closed');
    assert.equal(closed.abandonment, null);
    assert.equal(closed.parseFailure?.fact.terminalRequestId,
      closed.requests.at(-1)!.fact.request.requestId);
    assert.equal(await helpers.readSemanticCheckpointExact(turn), null);
    assert.equal((await parent.readScopeParseFailures(scope)).length, 1);

    // GREEN requirement: the same interaction retries without any brick.
    const answered = await runtime.service.interpretExplicitInput({ interactionId });
    assert.equal(answered.state, 'answered');
    assert.equal(answered.reply, '8');
    assert.equal(providerRequests, 2);
    assert.equal((await parent.readScopeParseFailures(scope)).length, 1);

    // A brand new input on the same scope is interpreted normally afterwards.
    const otherId = await runtime.service.receiveExplicitInput({ sourceRef: 'ui:parse-live-next', rawInput, channel: 'business' });
    const other = await runtime.service.interpretExplicitInput({ interactionId: otherId });
    assert.equal(other.state, 'answered');
    assert.equal(other.reply, '8');
    assert.equal(providerRequests, 3);
    // The durable turn that failed stays closed: one fact, no second write.
    const stillClosed = await parent.readTurnSnapshot(turn);
    assert.equal(stillClosed.parseFailure !== null, true);
    assert.equal((await parent.readScopeParseFailures(scope)).length, 1);
  } finally {
    await runtime?.close();
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: real production interaction-118 / explicit-interpret-eb888d16
// committed one settled terminal request whose response carried TWO complete
// assistant-text items: the real answer decision and a second, model-invented
// requirement that restated the request instructions. The raw fold is faithful
// and concatenates both items, so JSON.parse failed with "Unexpected
// non-whitespace character after JSON at position 200", which names neither the
// cause nor the items. Impact: the same simple input failed about 40% of the
// time and nothing said why. Cost: one seeded terminal turn with the exact
// two-item shape. This test pins the deterministic semantics: two complete
// decisions are never concatenated, never silently truncated and never reduced
// to one of the two by a guess.
test('provider explicit brain interpreter names two complete decisions instead of concatenating them', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-two-decisions', providerId: 'provider-two-decisions', protocol: 'responses',
    endpointRef: 'recorded://two-decisions', modelRef: 'model-two-decisions',
    configDigest: 'sha256:two-decisions-config', capabilityDigest: 'sha256:two-decisions-capability',
  };
  const scope = { organId: deps.organId, interactionScopeId: deps.interactionScopeId };
  const rawInput = '7 加 7 等于几？';
  const request = {
    interactionId: 'interaction-two-decisions', inputRevision: 1, sourceRef: 'ui:two-decisions',
    rawInput, clarifications: [], taskCandidates: [],
  };
  const operationScope = { organId: scope.organId, operationId: id('operation', 'op-two-decisions') };
  const turn: InteractionTurnIdentity = {
    organId: scope.organId, interactionScopeId: scope.interactionScopeId,
    interactionId: request.interactionId, inputRevision: 1, turnId: 'explicit-interpret-two-decisions',
  };
  const execution = { runtimeId: turn.turnId, ...operationScope, executionEpoch: 1, interactionTurn: turn };
  const initialInput = {
    ref: await deps.rawEvidence.write({
      scope: operationScope, kind: 'execution', type: 'initial-input',
      locator: turn.turnId, content: JSON.stringify(request),
    }),
    view: { kind: 'utf8-text' as const },
  };
  const owner = createInteractionParentTurnRawOwner({
    turn, execution, scope: operationScope, initialInput, providerBinding: binding,
    executionOwner: { daemonLeaseId: 'lease-two-decisions', daemonGeneration: 1, processStartToken: 'process-two-decisions' },
    journal: deps.parentJournal, rawContent: deps.rawContent,
  });
  await owner.openTurnInput();
  const terminalRequest = { turnId: turn.turnId, requestId: 'request-two-decisions' };
  await owner.registerRequest({ execution, record: { request: terminalRequest, scope: operationScope, phase: 'dispatching' } });
  await owner.registerRequest({ execution, record: { request: terminalRequest, scope: operationScope, phase: 'dispatched' } });
  // The production batch item by item, both complete and both legal decisions.
  const answerItem = JSON.stringify({
    kind: 'answer', normalizedInput: rawInput, knownFacts: [], answer: '7 加 7 等于 14。', decisionRefs: [],
  });
  const requirementItem = JSON.stringify({
    kind: 'requirement',
    normalizedInput: '继续执行尚未完成的任务；需要工具时直接调用工具；如果任务已完成，请给出完成总结。',
    knownFacts: [], decisionRefs: ['ui-task-implicit-draft-125'],
    intent: 'create', proposal: { revision: 1, intent: 'create', title: '继续执行尚未完成的任务', objective: '继续执行尚未完成的任务' },
  });
  for (const [index, text] of [answerItem, requirementItem].entries()) {
    await owner.acceptRawFact({
      execution, scope: operationScope, request: terminalRequest, producerSeq: index + 1,
      fact: {
        kind: 'content', channel: 'assistant-text', update: 'full', contentUnitId: `item-${index}`,
        content: { ref: await deps.rawEvidence.write({
          scope: operationScope, kind: 'execution', type: `item-${index}`, locator: `item-${index}`, content: text,
        }), view: { kind: 'utf8-text' as const } },
        complete: true,
      },
    });
  }
  await owner.acceptRawFact({
    execution, scope: operationScope, request: terminalRequest, producerSeq: 3,
    fact: { kind: 'request-complete', terminal: 'completed' },
  });
  await owner.registerRequest({ execution, record: { request: terminalRequest, scope: operationScope, phase: 'settled' } });
  // The exact production shape: a real close, a real terminal output, no decision.
  await owner.recordProviderClose({
    providerBinding: binding,
    result: {
      bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol,
      state: 'closed',
      evidenceRefs: [await deps.rawEvidence.write({
        scope: operationScope, kind: 'execution', type: 'close', locator: 'close', content: 'closed',
      })],
    },
    closedAt: new Date().toISOString(),
  });
  let providerStarts = 0;
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], respond: async () => {
    providerStarts += 1;
    return [{ type: 'response.output_text.done', item_id: 'final', text: answerItem }];
  } });
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), port,
  });

  // RED on the base: the same JSON position error the production entry raised,
  // produced by concatenating two well-formed decisions into one string.
  // GREEN: the terminal output is described by what it really held.
  await assert.rejects(
    () => interpreter.interpret(request),
    (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      const message = error.message;
      assert.ok(message.includes('interaction agent returned invalid JSON'));
      assert.equal(message.includes('Unexpected non-whitespace character'), false,
        'the failure must name the cause, not a JSON parse offset');
      assert.ok(message.includes('2 top-level JSON decision objects'),
        `the failure must count the decisions it refused to merge: ${message}`);
      assert.equal(message.includes('7 加 7 等于 14。'), false, 'no decision text is guessed into the error');
      return true;
    },
  );
  // No decision was invented and none of the two was taken: the honest closure
  // is the only durable fact, so the scope is never bricked.
  assert.equal(await deps.helperJournal.readSemanticCheckpointExact(turn), null,
    'an ambiguous terminal output commits no semantic claim');
  const closed = await deps.parentJournal.readTurnSnapshot(turn);
  assert.equal(closed.parseFailure?.fact.terminalRequestId, terminalRequest.requestId);
  assert.equal(providerStarts, 0, 'the seeded terminal output is read, not re-requested');
  const retried = await interpreter.interpret(request);
  assert.equal(retried.kind, 'answer');
  if (retried.kind !== 'answer') throw new Error('expected an answer');
  assert.equal(retried.answer, '7 加 7 等于 14。');
  assert.equal(providerStarts, 1);
});

// Failure basis: the interpret wire opened with the task-execution framing
// ("You are executing one turn of a HumanAgent task." ... "When the requirement
// is satisfied, reply with your final answer as plain text and call no further
// tool"), because the codec prepends that text to every request that declares
// tools. Production interaction-118 answered that framing with a second,
// invented requirement item ("继续执行尚未完成的任务；需要工具时直接调用工具；如果任务已完成，
// 请给出完成总结。"), which is the preamble restated as a decision. Impact: the
// request asks for two incompatible outputs and the model sometimes delivers
// both. Cost: one ordinary answer request.
test('provider explicit brain asks for one intake decision, not one turn of task execution', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-intake-framing', providerId: 'provider-intake-framing', protocol: 'responses',
    endpointRef: 'recorded://intake-framing', modelRef: 'model-intake-framing',
    configDigest: 'sha256:intake-framing-config', capabilityDigest: 'sha256:intake-framing-capability',
  };
  const sentPrompts: string[] = [];
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], respond: async (wire: { readonly instructions?: string; readonly tools?: readonly { readonly name?: string }[] }) => {
    sentPrompts.push(wire.instructions ?? '');
    return [{ type: 'response.output_text.done', item_id: 'final', text: JSON.stringify({
      kind: 'answer', normalizedInput: '7 加 7 等于几？', knownFacts: [], answer: '7 加 7 等于 14。', decisionRefs: [],
    }) }];
  } });
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), port,
  });
  const answered = await interpreter.interpret({
    interactionId: 'interaction-intake-framing', inputRevision: 1, sourceRef: 'ui:intake-framing',
    rawInput: '7 加 7 等于几？', clarifications: [], taskCandidates: [],
  });
  assert.equal(answered.kind, 'answer');
  assert.equal(sentPrompts.length, 1);
  const sentPrompt = sentPrompts[0]!;
  // RED on the base: both execution sentences were present in this exact request.
  assert.equal(sentPrompt.includes('You are executing one turn of a HumanAgent task'), false,
    'one intake decision is not one turn of task execution');
  assert.equal(sentPrompt.includes('reply with your final answer as plain text'), false,
    'a decision turn never ends with a plain-text final answer');
  // GREEN: the request still owns its tool surface, stated as what it really is.
  assert.ok(sentPrompt.includes('one intake decision, not one turn of task execution'));
  assert.ok(sentPrompt.includes('Only these function tools can be called: dispatch_helper, accept_helper'));
  assert.ok(sentPrompt.includes('never restate the request instructions as a requirement'));
  assert.ok(sentPrompt.includes('# Explicit intake decision output'));
});

// Failure basis: production gen27 interaction-137 ("5 加 5 等于多少？" with
// thirteen task candidates, most of them blocked/created/stopped/waiting). One
// Responses batch came back with two complete message items: a correct answer
// item and a second, invented requirement item ("继续执行尚未完成的任务；执行过程中
// 需要工具时直接调用工具；若所有任务均已完成，则给出完成总结。"). That text appears
// nowhere in the request, so the model derived it from the candidate list. The
// intake wire never said which of the two it wanted, and the user got a 500
// instead of the answer. Impact: an ordinary arithmetic question fails on a
// batch the request itself left under-specified. Cost: one ordinary answer
// request whose recorded output is that exact two-item batch.
test('provider explicit brain asks the intake decision to stay one object about the committed input', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-intake-scope', providerId: 'provider-intake-scope', protocol: 'responses',
    endpointRef: 'recorded://intake-scope', modelRef: 'model-intake-scope',
    configDigest: 'sha256:intake-scope-config', capabilityDigest: 'sha256:intake-scope-capability',
  };
  const sentPrompts: string[] = [];
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], respond: async (wire: { readonly instructions?: string }) => {
    sentPrompts.push(wire.instructions ?? '');
    return [{ type: 'response.output_text.done', item_id: 'final', text: JSON.stringify({
      kind: 'answer', normalizedInput: '5 加 5 等于多少？', knownFacts: [], answer: '5 加 5 等于 10。', decisionRefs: [],
    }) }];
  } });
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), port,
  });
  await interpreter.interpret({
    interactionId: 'interaction-intake-scope', inputRevision: 1, sourceRef: 'ui:intake-scope',
    rawInput: '5 加 5 等于多少？', clarifications: [],
    taskCandidates: [
      { taskId: 'ui-task-scope-1', title: 'ux-verify-task', status: 'created', currentInput: '列出当前任务并总结' },
      { taskId: 'ui-task-scope-2', title: 'ux-delivery-material-check', status: 'blocked', currentInput: '说明标准交付的含义' },
      { taskId: 'ui-task-scope-3', title: '回答 1 加 1 等于几', status: 'stopped', currentInput: '回答 1 加 1 等于几' },
    ],
  } as Parameters<typeof interpreter.interpret>[0]);
  assert.equal(sentPrompts.length, 1);
  const sentPrompt = sentPrompts[0]!;
  // RED on the base: the wire said "Return one final JSON object only" and
  // nothing about the candidate statuses, so a second decision was in contract.
  assert.ok(sentPrompt.includes('is the only request in this turn'),
    'taskCandidates are context, so the committed input must be named as the only request');
  assert.ok(sentPrompt.includes('never a user request'),
    'an unfinished candidate status must never read as a request for new work');
  assert.ok(sentPrompt.includes('one assistant message'),
    'one decision object must also be one message item, or a batch may hold two');
});

// Failure basis: real isolated-provider run roundfix12 interaction-9 (input
// "10 加 10 等于几？" with eleven task candidates). The model echoed the request
// envelope it was handed and then stated the answer, all inside ONE assistant
// text item: `{"interactionId":...}{"kind":"answer",...}`. The envelope echo
// carries no decision kind, so counting top-level objects rejected a response
// that held exactly one decision. Impact: an ordinary arithmetic question fails
// with a fabricated "2 top-level JSON decision objects" diagnostic. Cost: one
// ordinary answer request whose recorded output is that exact two-object text.
test('provider explicit brain reads the unique decision when the output echoes its input envelope', async () => {
  const deps = parentDependencies();
  const binding: ProviderBinding = {
    bindingId: 'binding-envelope-echo', providerId: 'provider-envelope-echo', protocol: 'responses',
    endpointRef: 'recorded://envelope-echo', modelRef: 'model-envelope-echo',
    configDigest: 'sha256:envelope-echo-config', capabilityDigest: 'sha256:envelope-echo-capability',
  };
  const request = {
    interactionId: 'interaction-envelope-echo', inputRevision: 1, sourceRef: 'ui:envelope-echo',
    rawInput: '10 加 10 等于几？', clarifications: [],
    taskCandidates: [{ taskId: 'ui-task-echo-1', title: '历史任务 1', status: 'created', currentInput: '继续执行历史任务 1' }],
  };
  const decision = JSON.stringify({
    kind: 'answer', normalizedInput: '10 加 10 等于几？', knownFacts: [], answer: '10 加 10 等于 20。', decisionRefs: [],
  });
  const port = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], respond: async () => [
    { type: 'response.output_text.done', item_id: 'final', text: `${JSON.stringify(request)}\n${decision}` },
  ] });
  const interpreter = createProviderExplicitBrainInterpreter({
    ...deps, binding, parentJournal: deps.parentJournal, checkpointJournal: deps.helperJournal,
    helperJournal: deps.helperJournal, turnHelperJournal: deps.helperJournal,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), port,
  });
  const answered = await interpreter.interpret(request);
  assert.equal(answered.kind, 'answer');
  if (answered.kind !== 'answer') throw new Error('expected an answer');
  assert.equal(answered.answer, '10 加 10 等于 20。');
  // The echo is the input, not a second decision, so nothing was rejected and
  // nothing was invented: the scope holds no parse failure.
  const scope = { organId: deps.organId, interactionScopeId: deps.interactionScopeId };
  assert.deepEqual(await deps.parentJournal.readScopeParseFailures(scope), []);
});

// Failure basis: the pending-input selection compared the committed input and
// the retry byte for byte, so a live task snapshot that drifted between the
// original submission and the retry made the same interaction/revision look
// like different input. Impact: the only legal recovery of the submitted turn
// is refused (or the turn is discharged and its original context lost) while
// the user retries the same input. Cost: one real terminated-owner takeover
// receipt, one seeded interrupted turn and one recorded Provider request.
// Probability: any retry whose task list changed after the original submit,
// which is every longer-lived interaction.
test('provider explicit brain interpreter restores the committed input when only live task candidates drifted', async () => {
  const root = join(parentFixtureRoot, `candidate-drift-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-candidate-drift', providerId: 'provider-candidate-drift', protocol: 'responses',
    endpointRef: 'recorded://candidate-drift', modelRef: 'model-candidate-drift',
    configDigest: 'sha256:candidate-drift-config', capabilityDigest: 'sha256:candidate-drift-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    // Generation 1 owns the turn and dies; the takeover proves it stopped, so a
    // refusal here can only come from the input boundary, never from ownership.
    const acquired = await acquireTerminatedOwnerLease(root);
    lease = acquired.lease;
    const committedCandidates = [
      { taskId: 'scheduled-task-still-there', title: '仍在的任务', status: 'running', currentInput: '继续执行仍在的任务' },
      { taskId: 'scheduled-task-gone-away', title: '已消失的任务', status: 'created', currentInput: '继续执行已消失的任务' },
    ];
    const businessInput = {
      interactionId: 'interaction-candidate-drift', inputRevision: 1, sourceRef: 'ui:candidate-drift',
      rawInput: '请检查发布会当前状态', clarifications: [],
    };
    const committedText = JSON.stringify({ ...businessInput, taskCandidates: committedCandidates });
    // Two owner realities must recover the same submitted input: a takeover
    // whose termination receipt is retained, and the production shape where the
    // old generation's receipt was evicted. Recovery needs a committed lease
    // replacement, never the abandonment receipt that only discharge requires.
    const owners = [
      { label: 'retained receipt', owners: acquired.previousOwner },
      { label: 'lost receipt', owners: { daemonLeaseId: 'lease-candidate-drift-lost', daemonGeneration: 1, processStartToken: 'process-candidate-drift-lost' } },
    ];
    for (const owner of owners) {
      const turnId = `explicit-interpret-candidate-drift-${owner.label.replaceAll(' ', '-')}`;
      const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: `runtime:candidate-drift-${owner.label.replaceAll(' ', '-')}` };
      const seeded = await seedInterruptedParentTurn({
        parentJournal, evidence, rawContent, binding, scope,
        interactionId: businessInput.interactionId, turnId,
        initialInputText: committedText, executionOwner: owner.owners,
      });
      const wires: any[] = [];
      const port = new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [], respond: async (wire) => {
        wires.push(wire);
        return [{ type: 'response.output_text.done', item_id: 'final', text: JSON.stringify({
          kind: 'answer', normalizedInput: businessInput.rawInput, knownFacts: [],
          answer: '发布会当前状态取自原始提交的候选快照', decisionRefs: [],
        }) }];
      } });
      const composition = { roleId: 'interaction' as const, source: 'http' as const,
        provider: { source: 'http' as const, provider: 'http' as const, binding: binding.bindingId, protocol: 'responses' as const,
          model: binding.modelRef, route: 'recorded', baseUrl: binding.endpointRef }, binding, port };
      const interpreter = createProviderExplicitBrainInterpreter({
        organId: scope.organId, interactionScopeId: scope.interactionScopeId,
        parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
        rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
        helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
        binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), lease,
        prepareAgentProvider: async () => composition,
        port,
      });
      // The retry carries the live snapshot: one candidate disappeared since
      // the original submission. Every user business input is unchanged.
      const drifted = { ...businessInput, taskCandidates: [committedCandidates[0]!] };
      const result = await interpreter.interpret(drifted);
      assert.equal(result.kind, 'answer', owner.label);
      if (result.kind !== 'answer') throw new Error('expected a recovered answer');
      assert.equal(result.answer, '发布会当前状态取自原始提交的候选快照');
      // The submitted turn is recovered, not discharged: one turn, one continue
      // reconciliation, epoch 2 and no abandonment fact.
      assert.deepEqual(await parentJournal.readScopeAbandonedTurns(scope), [],
        `${owner.label}: a same-input retry must never discharge the submitted turn`);
      const opened = await parentJournal.readScopeOpenedTurns(scope);
      assert.equal(opened.length, 1, `${owner.label}: recovery continues the submitted turn instead of opening a second one`);
      assert.deepEqual(opened[0]!.fact.turn, seeded.turn);
      assert.equal(opened[0]!.fact.turn.turnId, turnId);
      const snapshot = await parentJournal.readTurnSnapshot(opened[0]!.fact.turn);
      assert.equal(snapshot.ownerReconciliations.length, 1);
      const reconciliation = snapshot.ownerReconciliations[0]!.fact;
      assert.equal(reconciliation.mode, 'continue');
      assert.equal(reconciliation.effectiveExecutionEpoch, 2);
      assert.deepEqual(reconciliation.previousOwner, owner.owners);
      assert.equal(reconciliation.replacementOwner.daemonGeneration, lease.record.generation);
      // The original business execution is the one that continues.
      assert.equal(snapshot.turnInput?.fact.execution.operationId.value, `op-${turnId}`);
      assert.equal(snapshot.turnInput?.fact.execution.runtimeId, turnId);
      assert.equal(snapshot.resourceClose?.fact.execution.executionEpoch, 2);
      // The Provider must read the committed candidate snapshot. A fix that only
      // relaxes the comparison and runs the retry as new input would hand the
      // reduced live snapshot to the model instead.
      assert.equal(wires.length, 1, owner.label);
      const userText = wires[0].input
        .filter((item: any) => item.type === 'message' && item.role === 'user')
        .map((item: any) => item.content.map((unit: any) => unit.text).join(''))
        .join('');
      assert.equal(userText, committedText, `${owner.label}: the Provider sees the exact committed request`);
      assert.match(userText, /scheduled-task-gone-away/);
      assert.equal(JSON.parse(userText).taskCandidates.length, 2);
      assert.ok(await helperJournal.readSemanticCheckpointExact(opened[0]!.fact.turn));
    }
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: the recovery above must stay scoped to one committed input.
// A wider rule that restored the committed request whenever the task candidates
// drift would silently replace a genuinely new user input with older text.
// Impact: the user's new requirement is answered as the previous one. Cost: one
// seeded turn per mutated field on the same terminated-owner lease.
test('provider explicit brain keeps the different-input boundary when the business input changed', async () => {
  const root = join(parentFixtureRoot, `candidate-drift-guard-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binding: ProviderBinding = {
    bindingId: 'binding-candidate-guard', providerId: 'provider-candidate-guard', protocol: 'responses',
    endpointRef: 'recorded://candidate-guard', modelRef: 'model-candidate-guard',
    configDigest: 'sha256:candidate-guard-config', capabilityDigest: 'sha256:candidate-guard-capability',
  };
  const journal = new JsonlOrganJournal(join(root, 'parent.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const rawContent = providerRawContentReader(evidence);
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const acquired = await acquireTerminatedOwnerLease(root);
    lease = acquired.lease;
    const committedCandidates = [
      { taskId: 'scheduled-task-guard-live', title: '仍在的任务', status: 'running', currentInput: '继续执行仍在的任务' },
      { taskId: 'scheduled-task-guard-gone', title: '已消失的任务', status: 'created', currentInput: '继续执行已消失的任务' },
    ];
    const businessInput = {
      interactionId: 'interaction-candidate-guard', inputRevision: 1, sourceRef: 'ui:candidate-guard',
      rawInput: '请检查发布会当前状态', clarifications: [{ question: '什么时候？', answer: '明天' }],
    };
    const mutations = [
      { name: 'raw-input', request: { ...businessInput, rawInput: '请检查另一件事' } },
      { name: 'clarification', request: { ...businessInput, clarifications: [{ question: '什么时候？', answer: '后天' }] } },
      { name: 'workspace', request: { ...businessInput, workspaceCwd: '/tmp/other-workspace', projectKey: 'other' } },
      { name: 'interaction', request: { ...businessInput, interactionId: 'interaction-candidate-guard-other' } },
      { name: 'revision', request: { ...businessInput, inputRevision: 2 } },
    ] as const;
    for (const mutation of mutations) {
      const scope = { organId: id('organ', 'explicit-test'), interactionScopeId: `runtime:candidate-guard-${mutation.name}` };
      const seeded = await seedInterruptedParentTurn({
        parentJournal, evidence, rawContent, binding, scope,
        interactionId: businessInput.interactionId, turnId: `explicit-interpret-candidate-guard-${mutation.name}`,
        initialInputText: JSON.stringify({ ...businessInput, taskCandidates: committedCandidates }),
        executionOwner: acquired.previousOwner,
      });
      const wires: any[] = [];
      const port = new RecordedParentPort({ binding, evidence, stepDelayMs: 0, replay: [], respond: async (wire) => {
        wires.push(wire);
        return [{ type: 'response.output_text.done', item_id: 'final', text: JSON.stringify({
          kind: 'answer', normalizedInput: String(mutation.request.rawInput), knownFacts: [],
          answer: '新的输入按新输入处理', decisionRefs: [],
        }) }];
      } });
      const interpreter = createProviderExplicitBrainInterpreter({
        organId: scope.organId, interactionScopeId: scope.interactionScopeId,
        parentJournal, checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
        rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
        helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
        binding, templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'), lease,
        port,
      });
      const retry = { ...mutation.request, taskCandidates: [committedCandidates[0]!] };
      const served = await interpreter.interpret(retry);
      assert.equal(served.kind, 'answer', mutation.name);
      // The submitted turn keeps its original input and is not recovered: the
      // existing different-input boundary owns this retry.
      const abandoned = await parentJournal.readScopeAbandonedTurns(scope);
      assert.equal(abandoned.length, 1, `${mutation.name}: the submitted turn is discharged, not recovered`);
      assert.deepEqual(abandoned[0]!.fact.turn, seeded.turn);
      const opened = await parentJournal.readScopeOpenedTurns(scope);
      assert.equal(opened.length, 2, `${mutation.name}: the new input opens its own turn`);
      assert.ok(opened[1]!.fact.turn.turnId !== seeded.turn.turnId, `${mutation.name}: the new turn is distinct`);
      assert.equal((await parentJournal.readTurnSnapshot(seeded.turn)).ownerReconciliations.length, 0,
        `${mutation.name}: a changed business input never reconciles the submitted turn`);
      assert.equal(wires.length, 1, mutation.name);
      const userText = wires[0].input
        .filter((item: any) => item.type === 'message' && item.role === 'user')
        .map((item: any) => item.content.map((unit: any) => unit.text).join(''))
        .join('');
      assert.equal(userText, JSON.stringify(retry), `${mutation.name}: the Provider sees the new input`);
      assert.ok(!/scheduled-task-guard-gone/.test(userText), `${mutation.name}: the original snapshot is not replayed`);
    }
  } finally {
    await lease?.release();
    await rm(root, { recursive: true, force: true });
  }
});
