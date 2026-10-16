import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import { id, type ProviderBinding, type InteractionParentProviderExecutionIdentityRef, type AnyProviderExecutionIdentityRef, type TasklessProviderExecutionIdentityRef } from '../../packages/contracts/src/index.js';
import { ProviderAgentDriver, ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import type { AgentRole, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import { prepareAgentProvider, type AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';

const parentFixtureRoot = join(process.env.HUMANAGENT_TEST_ROOT ?? '/Users/fanzhang/.humanagent/test-fixtures/provider-explicit-parent-wiring-20261016', `app-${randomUUID()}`);
const parentEvidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(parentFixtureRoot, 'assets')));
function parentDependencies() {
  const journal = new JsonlOrganJournal(join(parentFixtureRoot, `${randomUUID()}.jsonl`));
  return {
    organId: id('organ', 'explicit-test'), interactionScopeId: 'runtime:explicit-test',
    parentJournal: new JsonlInteractionParentTurnJournal(journal),
    helperJournal: new JsonlInteractionHelperJournal(journal),
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
    respond?: (wire: any) => Promise<readonly unknown[]> }) {
    const transport = new V3ProviderHttpTransport<T>({
      binding: options.binding, baseUrl: 'http://recorded.test', source: 'http', evidence: parentEvidence,
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
    super({ binding: options.binding, routeRef: 'recorded', codec: new ResponsesProviderCodec(), transport, evidence: parentEvidence });
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
  const primaryStart = options.port.start.bind(options.port);
  options.port.start = async (request) => { borrowedStarts += 1; return primaryStart(request); };
  const selectedOptions = {
    ...options,
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

  const result = await interpreter.interpret({
    interactionId: 'interaction-provider-test',
    inputRevision: 1,
    sourceRef: 'ui:new-task',
    rawInput: '帮我整理启动步骤',
    clarifications: [],
    taskCandidates: [],
  });

  assert.equal(result.kind, 'requirement');
  if (result.kind !== 'requirement') throw new Error('expected requirement interpretation');
  assert.equal(result.normalizedInput, '整理启动步骤');
  assert.equal(result.intent, 'create');
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
  const arbitraryProposal = createProviderExplicitBrainInterpreter({
    ...malformedOptions,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
      provider: entries[0].provider!, binding, port: malformedOptions.port }),
  });
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
