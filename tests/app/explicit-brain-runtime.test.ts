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
import { DecisionTraceJournal, DecisionTraceStore } from '../../packages/runtime/src/explicit-brain/index.js';
import { createInteractionParentTurnRawOwner, type InteractionSemanticCheckpointJournalPort } from '../../packages/runtime/src/explicit-brain/index.js';
import { id, type ProviderBinding, type ProviderCloseResult, type InteractionParentProviderExecutionIdentityRef, type AnyProviderExecutionIdentityRef, type TasklessProviderExecutionIdentityRef } from '../../packages/contracts/src/index.js';
import { ProviderAgentDriver, ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import type { AgentRole, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import { prepareAgentProvider, type AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import { startUiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { uiRuntimeControlJournalPath } from '../../packages/app/src/ui-runtime/journal.js';
import { acquireDaemonLease } from '../../packages/app/src/supervisor/index.js';
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

// Exercise the real neutral adapter/raw codec. The old Task-only fake cannot
// represent this identity or deliver raw facts; changing the fixture does not
// weaken the compiling synthetic-Task RED assertions below.
class RecordedParentPort<T extends AnyProviderExecutionIdentityRef = InteractionParentProviderExecutionIdentityRef> extends ProviderAdapter<T> {
  constructor(options: { binding: ProviderBinding; stepDelayMs: number; replay: readonly { kind: string; summary: string; state: string; terminalState?: string }[];
    respond?: (wire: any) => Promise<readonly unknown[]>; evidence?: typeof parentEvidence }) {
    const evidence = options.evidence ?? parentEvidence;
    const transport = new V3ProviderHttpTransport<T>({
      binding: options.binding, baseUrl: 'http://recorded.test', source: 'http', evidence,
      fetch: async (_url, init) => ({ status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: (async function* () {
          const frames = [
            { type: 'response.created', response: { id: 'recorded' } },
            ...(options.respond ? await options.respond(JSON.parse(init.body!)) : options.replay.filter((step) => step.kind === 'output').map((step, index) => ({
              type: 'response.output_text.done', item_id: `text-${index}`, text: step.summary,
            }))),
            { type: 'response.completed', response: { id: 'recorded' } },
          ];
          yield new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
        })(), text: async () => '' }),
    });
    super({ binding: options.binding, routeRef: 'recorded', codec: new ResponsesProviderCodec(), transport, evidence });
  }
}

function digest(args: Readonly<Record<string, unknown>>): string {
  const stable = JSON.stringify(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${createHash('sha256').update(stable).digest('hex')}`;
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
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { type: 'response.created', response: { id: `selected-${posts.length}` } },
        { type: 'response.output_text.done', item_id: 'message-final', text: JSON.stringify({
          kind: 'requirement', normalizedInput: '整理启动步骤', knownFacts: ['README exists'],
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
  assert.match(result.proposal, /可执行的启动步骤清单/);
  assert.equal(result.proposal.includes('awaiting-user-confirmation'), false);
  assert.equal(compositions.length, 1, 'selected interaction callback must run');
  assert.deepEqual(lifecycle, ['0:settled', '0:closed']);
  await interpreter.interpret({ interactionId: 'interaction-provider-second', inputRevision: 1,
    sourceRef: 'ui:second', rawInput: '第二次独立输入', clarifications: [], taskCandidates: [] });
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
  const sentPrompt = wire.instructions;
  assert.ok(sentPrompt.includes('# Control Boundaries'));
  assert.ok(sentPrompt.includes('# Explicit Brain'));
  assert.ok(sentPrompt.includes('# Explicit intake decision output'));
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
});

test('neutral parent loops over exact raw tool pairs, with returned helper separate from explicit acceptance', async () => {
  // The old path could not dispatch helpers at all. One bounded local replay
  // catches parent/child identity pollution, autoacceptance and summary parsing.
  const dependencies = parentDependencies();
  const binding: ProviderBinding = { bindingId: 'parent-loop', providerId: 'recorded', protocol: 'responses',
    modelRef: 'parent-model', endpointRef: 'http:recorded.test', configDigest: 'sha256:parent', capabilityDigest: 'sha256:parent' };
  const childBinding = { ...binding, bindingId: 'child-loop', modelRef: 'independent-child-model' };
  const refinedText = 'parent explicitly refined the partial result';
  const answer = `exact final ${'原始正文。'.repeat(120)}`;
  const finalText = JSON.stringify({ kind: 'answer', normalizedInput: 'parent-private', knownFacts: [], answer, decisionRefs: [] });
  const wires: any[] = [];
  let helperIdentity: Parameters<typeof dependencies.helperJournal.readExact>[0] | undefined;
  let childClosed = 0;
  let settlementPublished = 0;
  const parent = new RecordedParentPort({ binding, stepDelayMs: 0, replay: [], respond: async (wire) => {
    wires.push(wire);
    const results = wire.input.filter((item: any) => item.type === 'function_call_output');
    if (results.length === 0) return [
      { type: 'response.output_text.done', item_id: 'draft', text: '{"kind":"invalid-draft"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'dispatch', name: 'dispatch_helper', arguments: JSON.stringify({
        selection: { roleId: 'review', configuredAgentId: 'independent-child' },
        assignmentFields: { objective: 'bounded', targetRefs: [], expectedOutputRefs: [], expectedArtifactDigests: [],
          acceptanceCriteriaDigest: `sha256:${'a'.repeat(64)}`, successCriteria: ['complete'], failureCriteria: ['none'], incompleteCriteria: ['partial'], requiredCapabilities: [], mergeGate: 'not-required' },
        inputs: { question: 'child-only-input' }, evidenceRefs: [],
      }) } },
    ];
    if (results.length === 1) {
      const dispatched = JSON.parse(results[0].output);
      helperIdentity = dispatched.identity;
      const handoff = await dependencies.helperJournal.readExact(dispatched.identity);
      assert.ok(handoff.returned); assert.equal(handoff.ownerAccepted, null);
      assert.equal(dispatched.result.status, 'incomplete');
      return [{ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'accept', name: 'accept_helper',
        arguments: JSON.stringify({ helperCallId: dispatched.identity.helperCallId, refinedText, acceptanceRef: 'acceptance:parent-loop', evidenceRefs: [] }) } }];
    }
    assert.deepEqual(results.map((item: any) => item.call_id), ['dispatch', 'accept']);
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
    publishProviderSettlement: async ({ settlement }) => { assert.equal('taskId' in settlement, false); assert.equal(settlement.state, 'succeeded'); settlementPublished += 1; },
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
  const interpreter = createProviderExplicitBrainInterpreter({
    ...options, port,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'parent-close-retry', baseUrl: binding.endpointRef },
      binding, port }),
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
  assert.ok((await parentJournal.readTurnSnapshot(turn)).resourceClose, 'the close is durable before the checkpoint failure');

  // The same-process retry reuses the retained receipt and never re-closes.
  const retried = await interpreter.interpret(request);
  assert.equal(retried.kind, 'answer');
  assert.equal(closes, 1, 'a same-process retry must not close the owner a second time');
  const closeRecords = (await new JsonlOrganJournal(journalFile).replay())
    .filter((record) => (record.payload as { discriminant?: string } | undefined)?.discriminant === 'resource-close');
  assert.equal(closeRecords.length, 1, 'a same-process retry must not append a second close record');
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
          nextAction: 'wait', conditionRef: 'condition:seed'}, returnedAt: new Date().toISOString(), evidenceRefs: []});
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
            objective: `bounded ${configuredAgentId}`, targetRefs: [], expectedOutputRefs: [], expectedArtifactDigests: [],
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
      const dispatched = JSON.parse(accepted.output);
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
