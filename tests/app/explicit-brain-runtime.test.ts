import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createExplicitBrainRuntime,
  createProviderExplicitBrainInterpreter,
} from '../../packages/app/src/explicit-brain-runtime.js';
import { DecisionTraceJournal, DecisionTraceStore } from '../../packages/runtime/src/explicit-brain/index.js';
import { FakeReplayExecutionRuntimePort } from '../../packages/app/src/ui-runtime/fake-port.js';
import type { ProviderBinding, ProviderStartInput } from '../../packages/contracts/src/index.js';

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
  const port = new class extends FakeReplayExecutionRuntimePort {
    submittedPrompt?: string;

    override async start(request: ProviderStartInput) {
      const prompt = request.payload?.prompt;
      if (typeof prompt !== 'string') throw new Error('provider start did not receive an intake prompt');
      this.submittedPrompt = prompt;
      return super.start(request);
    }
  }({
    binding,
    stepDelayMs: 0,
    replay: [
      {
        kind: 'output',
        state: 'output',
        summary: JSON.stringify({
          kind: 'requirement',
          normalizedInput: '搜索工作区并报告匹配文件路径和行，同时保持只读',
          knownFacts: ['请求需要在任务执行阶段使用文件工具'],
          proposal: {
            revision: 1,
            intent: 'create',
            title: '在工作区查找匹配内容',
            objective: '使用 file.search 和 file.read 在工作区查找指定内容',
            deliverable: '精确文件路径和匹配行',
            owner: null,
            ownerNote: '运行时在需求确认后决定执行 owner。',
            deliveryConditions: ['提供实际命中的文件路径和行号', '不得创建、修改、移动或删除文件'],
            evidenceRefs: ['interaction-provider-test#inputRevision=1'],
            blockingGaps: [],
            lifecycle: 'draft-awaiting-user-confirmation',
            requiresUserConfirmation: true,
            confirmationPrompt: '请确认 revision 1 的需求草案。',
          },
          decisionRefs: ['interaction-provider-test#sourceRef=ui:new-task'],
        }),
      },
      { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
    ],
  });
  const interpreter = createProviderExplicitBrainInterpreter({
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port,
  });

  const rawInput = 'Find the workspace file containing "needle" by using file.search and file.read, then report the exact file path and matching line. Do not create, modify, move, or delete any file.';
  const result = await interpreter.interpret({
    interactionId: 'interaction-provider-test',
    inputRevision: 1,
    sourceRef: 'ui:new-task',
    rawInput,
    clarifications: [],
    taskCandidates: [],
  });

  assert.equal(result.kind, 'requirement');
  if (result.kind !== 'requirement') throw new Error('expected requirement interpretation');
  assert.equal(result.normalizedInput, '搜索工作区并报告匹配文件路径和行，同时保持只读');
  assert.equal(result.intent, 'create');
  assert.match(result.proposal, /file\.search/);
  assert.match(result.proposal, /file\.read/);
  assert.match(result.proposal, /精确文件路径和匹配行/);
  assert.match(result.proposal, /不得创建、修改、移动或删除文件/);
  assert.equal(result.proposal.includes('awaiting-user-confirmation'), false);
  const submittedPrompt = port.submittedPrompt ?? '';
  assert.ok(submittedPrompt);
  assert.match(submittedPrompt, /A concrete request to perform work and deliver a result is a requirement/);
  assert.match(submittedPrompt, /proposal\.intent=create even if taskCandidates is empty/);
  assert.match(submittedPrompt, /Do not turn a request to perform read-only work into status-query/);
  assert.match(submittedPrompt, /Use status-query only when the user asks about the current state or progress of an existing task/);
  assert.ok(submittedPrompt.includes(JSON.stringify(rawInput)));
  assert.match(submittedPrompt, /"taskCandidates":\[\]/);

  const arbitraryProposal = createProviderExplicitBrainInterpreter({
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new FakeReplayExecutionRuntimePort({
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
  });
  await assert.rejects(
    () => arbitraryProposal.interpret({
      interactionId: 'interaction-arbitrary-proposal',
      inputRevision: 1,
      sourceRef: 'ui:new-task',
      rawInput: '帮我整理启动步骤',
      clarifications: [],
      taskCandidates: [],
    }),
    /does not match the structured proposal contract/,
  );
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
  const interpreter = createProviderExplicitBrainInterpreter({
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new FakeReplayExecutionRuntimePort({
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
              owner: null,
              ownerNote: '运行时在需求确认后决定执行 owner。',
              deliveryConditions: ['每条命令和结论均标注文件路径与行号'],
              evidenceRefs: ['ui:new-task', 'interaction-1#inputRevision=1'],
              blockingGaps: ['尚未读取 README.md 与 package.json'],
              lifecycle: 'draft-awaiting-user-confirmation',
              requiresUserConfirmation: true,
              confirmationPrompt: '请确认 revision 1 的需求草案。',
            },
            decisionRefs: ['interaction-1#sourceRef=ui:new-task'],
          }),
        },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ],
    }),
  });

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
});
