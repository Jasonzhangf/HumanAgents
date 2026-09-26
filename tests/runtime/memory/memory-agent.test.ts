import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AgentDriver,
  type AgentOutput,
  type CanonicalMemoryScope,
  type MemoryActorContext,
  type MemoryAuditPromptSnapshotSource,
  type MemoryAuditPromptSourcePort,
  type MemoryOperationsPort,
  type MemoryProjectSourcePort,
  type MemoryProjectSourceSnapshot,
  type MemorySessionEvidence,
  type MemorySessionEvidenceSourcePort,
  type MemorySubmission,
  type ProjectSourceUpdateProposal,
} from '../../../packages/contracts/src/index.js';
import { assertBusinessPayload } from '../../../packages/contracts/src/index.js';
import type { EventRecord } from '../../../packages/runtime/src/events/index.js';
import {
  MemoryAgent,
  createMemoryAnalysisRequestedEvent,
  memoryAnalysisRequestFromEvent,
  type MemoryProjectUpdateOwnerPort,
} from '../../../packages/runtime/src/memory/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: CanonicalMemoryScope = {
  namespace: 'project',
  projectKey: 'project-a',
  organId: organ,
  taskId: task,
};
const actor: MemoryActorContext = {
  actorId: 'memory-agent-a',
  roleId: 'memory',
  permissions: ['memory.read', 'memory.propose'],
  projectKey: 'project-a',
};

/**
 * The provider round never sees control identity in the business payload, so a
 * curation cannot echo an operation id. The agent derives it from the admitted
 * `memory-analysis:<operationId>` assignment identity instead.
 */
function admittedOperationFromAssignment(assignmentId: string) {
  return { scope: 'operation' as const, value: assignmentId.slice('memory-analysis:'.length) };
}

const sessionEvidence: MemorySessionEvidence = {
  sourceRef: 'session://project-a/task-a/session-a@abc',
  canonicalRef: 'session://project-a/task-a/session-a',
  revision: 'sha256:session-revision',
  digest: 'sha256:session-digest',
  loadedAt: '2026-09-17T00:00:00.000Z',
  projectKey: 'project-a',
  taskId: task,
  sessionRef: 'session-a',
  content: '{"sessionId":"session-a","projectKey":"project-a"}\n',
};

function projectSource(content = '# Project\n'): MemoryProjectSourceSnapshot {
  return {
    sourceRef: 'project://project-a/AGENTS.md@abc',
    canonicalRef: 'project://project-a/AGENTS.md',
    revision: 'sha256:project-revision',
    digest: 'sha256:project-digest',
    loadedAt: '2026-09-17T00:00:00.000Z',
    projectKey: 'project-a',
    target: 'project-agents',
    content,
  };
}

function promptSource(content = '# Audit\n'): MemoryAuditPromptSnapshotSource {
  return {
    sourceRef: 'prompt://project-a/project-memory-audit@abc',
    canonicalRef: 'prompt://project-a/project-memory-audit',
    revision: 'sha256:prompt-revision',
    digest: 'sha256:prompt-digest',
    loadedAt: '2026-09-17T00:00:00.000Z',
    promptRef: 'project-memory-audit',
    content,
  };
}

function makeOperations(overrides: {
  readonly novelty?: 'novel' | 'known' | 'unknown';
  readonly candidateId?: string;
  readonly failNovelty?: boolean;
  readonly recurrence?: Awaited<ReturnType<MemoryOperationsPort['detectRecurrence']>>;
  readonly comparisons?: Readonly<Record<string, 'same' | 'different' | 'unknown'>>;
  readonly sourceDigests?: Readonly<Record<string, string>>;
} = {}): {
  readonly operations: MemoryOperationsPort;
  readonly submissions: MemorySubmission[];
  readonly ingest: string[];
  readonly recurrenceRequests: Parameters<MemoryOperationsPort['detectRecurrence']>[0][];
  readonly comparisons: { readonly leftRef: string; readonly rightRef: string }[];
} {
  const submissions: MemorySubmission[] = [];
  const ingest: string[] = [];
  const recurrenceRequests: Parameters<MemoryOperationsPort['detectRecurrence']>[0][] = [];
  const comparisons: { readonly leftRef: string; readonly rightRef: string }[] = [];
  const operations: MemoryOperationsPort = {
    ingest: async (input) => {
      ingest.push(input.sourceRef);
      return { sourceRef: input.sourceRef };
    },
    search: async () => [],
    inspect: async (input) => ({
      sourceRef: input.sourceRef,
      sourceDigest: overrides.sourceDigests?.[input.sourceRef]
        ?? (input.sourceRef === 'journal://project-a/checkpoint'
        ? 'sha256:checkpoint'
        : input.sourceRef === 'journal://project-a/evidence'
          ? 'sha256:evidence'
          : input.sourceRef === 'journal://project-a/interaction-evidence'
            ? 'sha256:interaction-evidence'
          : 'sha256:source'),
      text: 'source',
    }),
    compare: async (input) => {
      comparisons.push(input);
      return {
        relation: overrides.comparisons?.[`${input.leftRef}\u0000${input.rightRef}`] ?? 'different',
      };
    },
    detectNovelty: async (input) => {
      if (overrides.failNovelty) throw new Error('analysis backend down');
      return {
        classification: overrides.novelty ?? 'novel',
        matchedRefs: overrides.novelty === 'known' ? ['memory://known'] : [],
        reason: overrides.novelty === 'known' ? 'source digest already exists' : 'source digest is new',
      };
    },
    detectRecurrence: async (input) => {
      recurrenceRequests.push(input);
      return overrides.recurrence ?? { classification: 'one-off', occurrences: [], reason: 'not recurring' };
    },
    query: async (input) => ({
      requestId: input.requestId,
      status: 'ready',
      entries: [],
      sourceFactRef: 'memory-query:test',
      omitted: [],
    }),
    submitCandidate: async (input) => {
      submissions.push(input);
      return {
        submissionId: input.submissionId,
        status: 'accepted',
        candidateId: overrides.candidateId ?? `candidate:${input.submissionId}`,
        operationId: input.operationId,
        nextAction: 'review-required',
      };
    },
    reviewCandidate: async (input) => input,
    promoteCandidate: async (input) => input,
    planForgetting: async (input) => input.plan,
  };
  return { operations, submissions, ingest, recurrenceRequests, comparisons };
}

function bind(agent: MemoryAgent, operations: MemoryOperationsPort): MemoryAgent {
  agent.bind({
    bindingRef: 'binding-a',
    projectKey: 'project-a',
    scope,
    taskId: task,
    mainAgentId: 'main-agent-a',
    executionEpoch: 2,
    ownerId: 'memory-agent',
    operations,
  });
  return agent;
}

function providerDriver(input: {
  readonly events: string[];
  readonly outcome?: 'candidate' | 'attention';
  readonly settleState?: 'succeeded' | 'failed';
  readonly mutateOutput?: (output: AgentOutput) => AgentOutput;
}): AgentDriver {
  return {
    kind: 'memory-test',
    capabilities: async () => ({ driverKind: 'memory-test', capabilities: ['analysis'], version: '1' }),
    start: async (request) => {
      input.events.push(`start:${request.taskId.value}:${request.executionEpoch}`);
      return { runtimeId: request.runtimeId, executionEpoch: request.executionEpoch };
    },
    resume: async () => { throw new Error('unused'); },
    submit: async (request) => {
      input.events.push(`submit:${request.taskId.value}:${request.executionEpoch}`);
      const output: AgentOutput = {
        taskId: request.taskId,
        executionEpoch: request.executionEpoch,
        assignmentId: request.assignmentId,
        payload: {
          curation: {
            operationId: admittedOperationFromAssignment(request.assignmentId),
            auditPrompt: request.payload.prompt,
            sourceRefs: request.payload.sourceRefs,
            outcome: input.outcome ?? 'candidate',
            ...(input.outcome === 'attention' ? {} : { candidateId: 'provider-candidate' }),
            matchedMemoryIds: [],
            conflictRefs: [],
            explanation: 'provider analysis',
            nextAction: input.outcome === 'attention' ? 'attention' : 'review',
          },
        },
        outputRefs: ['memory://provider-output'],
        evidenceRefs: [],
      };
      return input.mutateOutput?.(output) ?? output;
    },
    async *observe() { /* unused */ },
    requestStop: async () => ({ requested: true, operationId: id('operation', 'stop') }),
    settle: async () => {
      input.events.push('settle');
      return { state: input.settleState ?? 'succeeded', evidenceRefs: [] };
    },
  };
}

function streamingProviderDriver(input: {
  readonly events: string[];
  readonly terminalState?: 'succeeded' | 'failed';
  readonly summary?: string;
  readonly capture?: (payload: Record<string, unknown>) => void;
}): AgentDriver {
  return {
    kind: 'memory-streaming-test',
    capabilities: async () => ({ driverKind: 'memory-streaming-test', capabilities: ['analysis'], version: '1' }),
    start: async (request) => {
      input.events.push(`start:${request.taskId.value}:${request.executionEpoch}`);
      return { runtimeId: request.runtimeId, executionEpoch: request.executionEpoch };
    },
    resume: async () => { throw new Error('unused'); },
    submit: async (request) => {
      input.events.push(`submit:${request.taskId.value}:${request.executionEpoch}`);
      input.capture?.(request.payload as Record<string, unknown>);
      return {
        taskId: request.taskId,
        executionEpoch: request.executionEpoch,
        assignmentId: request.assignmentId,
        payload: { mode: 'provider', status: 'accepted' },
        outputRefs: [],
        evidenceRefs: [],
      };
    },
    async *observe(request) {
      input.events.push(`observe:${request.runtimeId}`);
      const payload = input.summary ?? JSON.stringify({
        operationId: admittedOperationFromAssignment(request.runtimeId),
        auditPrompt: {
          promptRef: 'project-memory-audit',
          canonicalRef: 'prompt://project-a/project-memory-audit',
          revision: 'sha256:prompt-revision',
          digest: 'sha256:prompt-digest',
          loadedAt: '2026-09-17T00:00:00.000Z',
        },
        sourceRefs: ['journal://project-a/checkpoint'],
        outcome: 'candidate',
        candidateId: 'streaming-candidate',
        matchedMemoryIds: [],
        conflictRefs: [],
        explanation: 'streaming provider analysis',
        nextAction: 'review',
      });
      yield { taskId: task, executionEpoch: 2, kind: 'provider.output', evidenceRefs: [], summary: payload };
      yield {
        taskId: task,
        executionEpoch: 2,
        kind: 'provider.terminal',
        evidenceRefs: [],
        terminalState: input.terminalState ?? 'succeeded',
      };
    },
    requestStop: async () => ({ requested: true, operationId: id('operation', 'stop') }),
    settle: async () => {
      input.events.push('settle');
      return { state: 'succeeded', evidenceRefs: [] };
    },
  };
}

test('memory agent drives observe to a terminal event and parses streaming curation', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const driver = streamingProviderDriver({ events });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error(result.issue.message);
  assert.equal(result.value.curation.outcome, 'candidate');
  assert.equal(result.value.curation.explanation, 'streaming provider analysis');
  assert.equal(ports.submissions.length, 1);
  assert.deepEqual(events, [
    `start:${task.value}:2`,
    `submit:${task.value}:2`,
    `observe:memory-analysis:analysis-a`,
    'settle',
  ]);
});

test('memory agent admits a provider candidate without a provider-authored candidate id', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const driver = providerDriver({
    events,
    mutateOutput: (output) => {
      const curation = { ...(output.payload.curation as Record<string, unknown>) };
      delete curation.candidateId;
      return { ...output, payload: { curation } as AgentOutput['payload'] };
    },
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error(result.issue.message);
  assert.equal(result.value.curation.outcome, 'candidate');
  assert.equal(result.value.curation.candidateId, `candidate:memory-analysis:analysis-a`);
  assert.equal(ports.submissions.length, 1);
  assert.equal(ports.submissions[0]?.operationId.value, 'analysis-a');
});

test('memory agent sends the audit prompt body and inspected source text to the provider', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  let captured: Record<string, unknown> | undefined;
  const driver = streamingProviderDriver({
    events,
    capture: (payload) => { captured = payload; },
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource('# Audit\n') },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'ready');
  assert.equal((captured!.prompt as { readonly content: string }).content, '# Audit\n');
  const sources = captured!.sources as readonly { readonly sourceRef: string; readonly text: string }[];
  assert.equal(sources[0]!.sourceRef, 'journal://project-a/checkpoint');
  assert.equal(sources[0]!.text, 'source');
});

test('memory agent fails closed when streaming provider emits no terminal event', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const driver = streamingProviderDriver({ events });
  driver.observe = async function* () {
    yield { taskId: task, executionEpoch: 2, kind: 'provider.output', evidenceRefs: [], summary: '{}' };
  };
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'waiting');
  assert.ok(/without a terminal event/.test(result.status === 'waiting' ? result.issue.message : ''));
});

test('memory agent rejects a non-succeeded terminal event before parsing curation', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const driver = streamingProviderDriver({ events, terminalState: 'failed' });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'waiting');
  assert.ok(/terminal state was failed/.test(result.status === 'waiting' ? result.issue.message : ''));
  assert.equal(ports.submissions.length, 0);
});

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    operationId: id('operation', 'analysis-a'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    scope,
    taskId: task,
    sessionRef: 'session-a',
    sourceRefs: ['journal://project-a/checkpoint'],
    sourceDigests: ['sha256:checkpoint'],
    observation: 'checkpoint settle required a recovery action',
    requestedKind: 'semantic' as const,
    candidateCategory: 'project-fact' as const,
    executionEpoch: 2,
    trigger: 'blocked' as const,
    ...overrides,
  };
}

function proceduralEvidence(source: string, success = true) {
  return {
    sourceRef: source,
    sourceDigest: `sha256:${source.split('/').at(-1)}`,
    success,
    preconditionFingerprint: 'precondition:clean-worktree',
    stepFingerprint: 'step:run-focused-gate',
    failureBoundaryFingerprint: 'failure:gate-red',
  };
}

test('memory agent binds sources and emits a review-required candidate without mutating live context', async () => {
  const ports = makeOperations();
  const agent = new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
    now: () => '2026-09-17T00:00:00.000Z',
  });
  bind(agent, ports.operations);

  const result = await agent.analyze(analysis());
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('expected analysis to be ready');
  assert.equal(result.value.curation.outcome, 'candidate');
  assert.equal(result.value.curation.nextAction, 'review');
  assert.equal(result.value.liveContextMutated, false);
  assert.equal(result.value.promptSnapshot.promptRef, 'project-memory-audit');
  assert.equal(result.value.promptSnapshot.digest, 'sha256:prompt-digest');
  assert.equal(ports.submissions.length, 1);
  assert.equal(ports.submissions[0]?.desiredScope, 'project');
});

test('memory agent reports duplicate and attention without inventing a candidate', async () => {
  const duplicatePorts = makeOperations({ novelty: 'known' });
  const duplicateAgent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), duplicatePorts.operations);
  const duplicate = await duplicateAgent.analyze(analysis());
  assert.equal(duplicate.status, 'ready');
  if (duplicate.status !== 'ready') throw new Error('expected duplicate analysis');
  assert.equal(duplicate.value.curation.outcome, 'duplicate');
  assert.deepEqual(duplicate.value.curation.matchedMemoryIds, ['memory://known']);
  assert.equal(duplicatePorts.submissions.length, 0);

  const attentionAgent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), makeOperations({ novelty: 'unknown' }).operations);
  const attention = await attentionAgent.analyze(analysis());
  assert.equal(attention.status, 'ready');
  if (attention.status !== 'ready') throw new Error('expected attention curation');
  assert.equal(attention.value.curation.outcome, 'attention');
  assert.equal(attention.value.curation.nextAction, 'attention');
});

test('memory agent rejects stale follow-ups, mismatched evidence, and scope drift', async () => {
  const ports = makeOperations();
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);
  const followUp = {
    requestId: 'follow-up-a',
    operationId: id('operation', 'follow-up-operation'),
    correlationId: 'correlation-a',
    inReplyTo: 'analysis-a',
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    namespace: 'project' as const,
    taskId: task,
    evidenceRefs: ['journal://project-a/evidence'],
    evidenceDigests: ['sha256:evidence'],
    sourceRefs: ['journal://project-a/source'],
    inputDigest: 'sha256:evidence',
  };
  const analyzed = await agent.analyze(analysis());
  assert.equal(analyzed.status, 'ready');
  const staleEpoch = await agent.analyze(analysis({
    operationId: id('operation', 'analysis-stale-epoch'),
    executionEpoch: 3,
  }));
  assert.equal(staleEpoch.status, 'attention');
  assert.equal(staleEpoch.status === 'attention' && staleEpoch.issue.code, 'memory-agent-binding-mismatch');
  const accepted = await agent.followUp(followUp);
  assert.equal(accepted.status, 'ready', accepted.status === 'attention' ? accepted.issue.message : undefined);
  if (accepted.status !== 'ready') throw new Error('expected follow-up acceptance');
  assert.equal(accepted.value.correlationId, 'correlation-a');
  const repeated = await agent.followUp(followUp);
  assert.equal(repeated.status, 'ready');
  assert.equal(repeated.status === 'ready' && repeated.value.operationId.value, 'follow-up-operation');

  const stale = await agent.followUp({ ...followUp, operationId: id('operation', 'follow-up-b'), correlationId: 'correlation-b', inReplyTo: 'analysis-missing' });
  assert.equal(stale.status, 'attention');
  assert.equal(stale.status === 'attention' && stale.issue.code, 'memory-agent-follow-up-stale');

  const conflicting = await agent.followUp({ ...followUp, operationId: id('operation', 'follow-up-conflict'), inputDigest: 'sha256:conflict' });
  assert.equal(conflicting.status, 'attention');
  assert.equal(conflicting.status === 'attention' && conflicting.issue.code, 'memory-agent-follow-up-conflict');

  const mismatched = await agent.followUp({ ...followUp, operationId: id('operation', 'follow-up-c'), correlationId: 'correlation-c', evidenceDigests: ['sha256:wrong'] });
  assert.equal(mismatched.status, 'attention');
  assert.equal(mismatched.status === 'attention' && mismatched.issue.code, 'memory-agent-follow-up-conflict');

  const scoped = await agent.followUp({ ...followUp, operationId: id('operation', 'follow-up-d'), correlationId: 'correlation-d', projectKey: 'project-b' });
  assert.equal(scoped.status, 'attention');
  assert.equal(scoped.status === 'attention' && scoped.issue.code, 'memory-agent-follow-up-conflict');
});

test('memory agent re-analyzes a correlated follow-up and replays the persisted result', async () => {
  const ports = makeOperations({ candidateId: 'candidate-follow-up' });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
    now: () => '2026-09-17T00:00:00.000Z',
  }), ports.operations);
  const analyzed = await agent.analyze(analysis());
  assert.equal(analyzed.status, 'ready');
  const followUp = {
    requestId: 'follow-up-a',
    operationId: id('operation', 'follow-up-operation'),
    correlationId: 'correlation-a',
    inReplyTo: 'analysis-a',
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    namespace: 'project' as const,
    taskId: task,
    evidenceRefs: ['journal://project-a/evidence'],
    evidenceDigests: ['sha256:evidence'],
    sourceRefs: ['journal://project-a/source'],
    inputDigest: 'sha256:evidence',
  };

  const first = await agent.followUp(followUp);
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready') throw new Error('expected follow-up analysis');
  assert.equal(first.value.requestId, followUp.requestId);
  assert.equal(first.value.correlationId, followUp.correlationId);
  assert.equal(first.value.inReplyTo, followUp.inReplyTo);
  assert.equal(first.value.operationId.value, followUp.operationId.value);
  assert.equal(first.value.curation.operationId.value, followUp.operationId.value);
  assert.equal(first.value.curation.candidateId, 'candidate-follow-up');
  assert.equal(first.value.liveContextMutated, false);
  assert.equal(ports.submissions.length, 2);
  assert.equal(ports.submissions[1]?.contentRef, 'journal://project-a/evidence');
  assert.equal(ports.submissions[1]?.contentDigest, 'sha256:evidence');

  const replay = await agent.followUp(followUp);
  assert.equal(replay.status, 'ready');
  if (replay.status !== 'ready') throw new Error('expected persisted follow-up replay');
  assert.deepEqual(replay.value, first.value);
  assert.equal(ports.submissions.length, 2);
});

test('memory agent preserves an authorized global follow-up namespace in submission scope', async () => {
  const ports = makeOperations({ candidateId: 'candidate-global-follow-up' });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);
  assert.equal((await agent.analyze(analysis())).status, 'ready');

  const globalActor: MemoryActorContext = {
    ...actor,
    crossProjectGrantRef: 'grant://project-a/global-memory',
  };
  const accepted = await agent.followUp({
    requestId: 'follow-up-global',
    operationId: id('operation', 'follow-up-global-operation'),
    correlationId: 'follow-up-global-correlation',
    inReplyTo: 'analysis-a',
    bindingRef: 'binding-a',
    actor: globalActor,
    projectKey: 'project-a',
    namespace: 'global',
    taskId: task,
    evidenceRefs: ['journal://project-a/evidence'],
    evidenceDigests: ['sha256:evidence'],
    sourceRefs: ['journal://project-a/evidence'],
    inputDigest: 'sha256:evidence',
  });

  assert.equal(accepted.status, 'ready');
  assert.equal(ports.submissions.length, 2);
  assert.equal(ports.submissions[1]?.candidateCategory, 'global');
  assert.equal(ports.submissions[1]?.desiredScope, 'global');
});

test('memory agent persists follow-up results across restart and rejects drifted evidence', async () => {
  const state = {
    value: undefined as unknown,
    async readMemoryAgentState() {
      return structuredClone(this.value);
    },
    async appendMemoryAgentState(input: { readonly state: unknown }) {
      this.value = structuredClone(input.state);
    },
  };
  const ports = makeOperations({ candidateId: 'candidate-persisted-follow-up' });
  const makeAgent = () => bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
    state,
  }), ports.operations);
  const followUp = {
    requestId: 'follow-up-persisted',
    operationId: id('operation', 'follow-up-persisted-operation'),
    correlationId: 'follow-up-persisted-correlation',
    inReplyTo: 'analysis-a',
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    namespace: 'project' as const,
    taskId: task,
    evidenceRefs: ['journal://project-a/evidence'],
    evidenceDigests: ['sha256:evidence'],
    sourceRefs: ['journal://project-a/evidence'],
    inputDigest: 'sha256:evidence',
  };

  const firstAgent = makeAgent();
  assert.equal((await firstAgent.analyze(analysis())).status, 'ready');
  const first = await firstAgent.followUp(followUp);
  assert.equal(first.status, 'ready');
  assert.equal(ports.submissions.length, 2);

  const restarted = makeAgent();
  const replay = await restarted.followUp(followUp);
  assert.equal(replay.status, 'ready');
  if (replay.status !== 'ready' || first.status !== 'ready') throw new Error('expected persisted follow-up replay');
  assert.deepEqual(replay.value, first.value);
  assert.equal(ports.submissions.length, 2);

  const drift = await restarted.followUp({
    ...followUp,
    operationId: id('operation', 'follow-up-drifted-operation'),
    correlationId: 'follow-up-drifted-correlation',
    evidenceDigests: ['sha256:wrong'],
  });
  assert.equal(drift.status, 'attention');
  assert.equal(drift.status === 'attention' && drift.issue.code, 'memory-agent-follow-up-conflict');
  assert.equal(ports.submissions.length, 2);
});

test('memory agent rejects a corrupted persisted follow-up result', async () => {
  const state = {
    value: undefined as unknown,
    async readMemoryAgentState() {
      return structuredClone(this.value);
    },
    async appendMemoryAgentState(input: { readonly state: unknown }) {
      this.value = structuredClone(input.state);
    },
  };
  const ports = makeOperations({ candidateId: 'candidate-corrupt-state' });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
    state,
  }), ports.operations);
  assert.equal((await agent.analyze(analysis())).status, 'ready');
  assert.equal((await agent.followUp({
    requestId: 'follow-up-corrupt-state',
    operationId: id('operation', 'follow-up-corrupt-state-operation'),
    correlationId: 'follow-up-corrupt-state-correlation',
    inReplyTo: 'analysis-a',
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    namespace: 'project',
    taskId: task,
    evidenceRefs: ['journal://project-a/evidence'],
    evidenceDigests: ['sha256:evidence'],
    sourceRefs: ['journal://project-a/evidence'],
    inputDigest: 'sha256:evidence',
  })).status, 'ready');

  const persisted = state.value as {
    readonly followUps: readonly {
      readonly result: {
        operationId: { scope: string; value: string };
        curation: { operationId: { scope: string; value: string } };
      };
    }[];
  };
  persisted.followUps[0]!.result.operationId.value = 'different-operation';
  persisted.followUps[0]!.result.curation.operationId.value = 'different-operation';

  const restarted = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
    state,
  }), ports.operations);
  const replay = await restarted.followUp({
    requestId: 'follow-up-corrupt-state',
    operationId: id('operation', 'follow-up-corrupt-state-operation'),
    correlationId: 'follow-up-corrupt-state-correlation',
    inReplyTo: 'analysis-a',
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    namespace: 'project',
    taskId: task,
    evidenceRefs: ['journal://project-a/evidence'],
    evidenceDigests: ['sha256:evidence'],
    sourceRefs: ['journal://project-a/evidence'],
    inputDigest: 'sha256:evidence',
  });
  assert.equal(replay.status, 'attention');
  assert.equal(replay.status === 'attention' && replay.issue.code, 'memory-agent-follow-up-conflict');
});

test('memory agent accepts interaction follow-ups when analysis and binding epochs differ', async () => {
  const ports = makeOperations();
  const agent = new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  });
  const interactionScopeId = 'interaction-follow-up';
  agent.bind({
    bindingRef: 'binding-interaction',
    projectKey: 'project-a',
    scope: { namespace: 'project', projectKey: 'project-a', organId: organ },
    interactionScopeId,
    mainAgentId: 'main-agent-interaction',
    executionEpoch: 2,
    ownerId: 'memory-agent',
    operations: ports.operations,
  });

  const analyzed = await agent.analyze(analysis({
    operationId: id('operation', 'interaction-analysis'),
    bindingRef: 'binding-interaction',
    scope: { namespace: 'project', projectKey: 'project-a', organId: organ },
    taskId: undefined,
    interactionScopeId,
    sessionRef: undefined,
    executionEpoch: 3,
  }));
  assert.equal(analyzed.status, 'ready');

  const followUp = {
    requestId: 'interaction-follow-up-request',
    operationId: id('operation', 'interaction-follow-up-operation'),
    correlationId: 'interaction-follow-up-correlation',
    inReplyTo: 'interaction-analysis',
    bindingRef: 'binding-interaction',
    actor,
    projectKey: 'project-a',
    namespace: 'project' as const,
    taskId: undefined,
    interactionScopeId,
    evidenceRefs: ['journal://project-a/interaction-evidence'],
    evidenceDigests: ['sha256:interaction-evidence'],
    sourceRefs: ['journal://project-a/interaction-source'],
    inputDigest: 'sha256:interaction-evidence',
  };
  const accepted = await agent.followUp(followUp);
  assert.equal(accepted.status, 'ready');
  if (accepted.status !== 'ready') throw new Error('expected interaction follow-up acceptance');
  assert.equal(accepted.value.inReplyTo, 'interaction-analysis');
});

test('memory agent auto=false returns proposal-only; auto=true delegates a CAS update to the owner', async () => {
  const proposal: ProjectSourceUpdateProposal = {
    target: 'project-agents',
    sourceRef: projectSource().sourceRef,
    expectedRevision: projectSource().revision,
    expectedDigest: projectSource().digest,
    patchRef: 'patch://project-a/agents',
    patchDigest: 'sha256:patch-digest',
    evidenceRefs: ['journal://project-a/evidence'],
    ownerRef: 'project-rule-owner',
  };
  const calls: string[] = [];
  const owner: MemoryProjectUpdateOwnerPort = {
    apply: async ({ proposal: input }) => {
      calls.push('apply');
      return {
        target: input.target,
        sourceRef: projectSource().sourceRef,
        previousRevision: projectSource().revision,
        previousDigest: projectSource().digest,
        nextRevision: 'sha256:next-revision',
        nextDigest: 'sha256:next-digest',
        patchRef: input.patchRef,
        patchDigest: input.patchDigest,
        updated: true,
        evidenceRefs: [...input.evidenceRefs],
      };
    },
  };
  const make = (autoUpdate: boolean) => bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: owner,
  }), makeOperations().operations);

  const proposalOnly = await make(false).applyProjectUpdate({ proposal, projectKey: 'project-a' });
  assert.equal(proposalOnly.status, 'ready');
  if (proposalOnly.status !== 'ready') throw new Error('expected proposal-only result');
  assert.equal(proposalOnly.value.updated, false);
  assert.equal(calls.length, 0);

  const applied = await make(true).applyProjectUpdate({ proposal, projectKey: 'project-a' });
  assert.equal(applied.status, 'ready');
  if (applied.status !== 'ready') throw new Error('expected auto update');
  assert.equal(applied.value.updated, true);
  assert.equal(applied.value.nextDigest, 'sha256:next-digest');
  assert.deepEqual(calls, ['apply']);
});

test('memory agent analysis applies a typed project patch only when auto update is enabled', async () => {
  const calls: ProjectSourceUpdateProposal[] = [];
  const make = (autoUpdate: boolean) => bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: {
      apply: async ({ proposal, current }) => {
        calls.push(proposal);
        return {
          target: proposal.target,
          sourceRef: current.sourceRef,
          previousRevision: current.revision,
          previousDigest: current.digest,
          nextRevision: 'sha256:next-revision',
          nextDigest: 'sha256:next-digest',
          patchRef: proposal.patchRef,
          patchDigest: proposal.patchDigest,
          updated: true,
          evidenceRefs: [...proposal.evidenceRefs],
        };
      },
    },
  }), makeOperations().operations);
  const request = analysis({
    candidateCategory: 'project-experience',
    projectPatch: {
      patchRef: 'project-agents-next',
      patchDigest: `sha256:${'a'.repeat(64)}`,
    },
  });

  const proposalOnly = await make(false).analyze(request);
  assert.equal(proposalOnly.status, 'ready');
  if (proposalOnly.status !== 'ready') throw new Error('expected proposal-only analysis');
  assert.equal(proposalOnly.value.proposal?.patchRef, 'project-agents-next');
  assert.equal(proposalOnly.value.projectUpdate, undefined);
  assert.equal(calls.length, 0);

  const applied = await make(true).analyze(request);
  assert.equal(applied.status, 'ready');
  if (applied.status !== 'ready') throw new Error('expected automatic project update');
  assert.equal(applied.value.projectUpdate?.updated, true);
  assert.equal(applied.value.projectUpdate?.patchDigest, `sha256:${'a'.repeat(64)}`);
  assert.equal(calls.length, 1);
});

test('memory agent reports durable update publication failures as attention', async () => {
  const failure = Object.assign(new Error('event journal unavailable'), {
    code: 'memory-update-publication-failed',
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: true,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw failure; } },
  }), makeOperations().operations);
  const result = await agent.applyProjectUpdate({
    projectKey: 'project-a',
    proposal: {
      target: 'project-agents',
      sourceRef: projectSource().sourceRef,
      expectedRevision: projectSource().revision,
      expectedDigest: projectSource().digest,
      patchRef: 'project-agents-next',
      patchDigest: `sha256:${'b'.repeat(64)}`,
      evidenceRefs: ['journal://project-a/evidence'],
      ownerRef: 'project-rule-owner',
    },
  });
  assert.equal(result.status, 'attention');
  assert.equal(result.status === 'attention' && result.issue.code, 'memory-agent-update-publication-failed');
});

test('memory agent rejects auto update when the project source digest drifted', async () => {
  const staleProposal: ProjectSourceUpdateProposal = {
    target: 'project-agents',
    sourceRef: 'project://project-a/AGENTS.md@old',
    expectedRevision: 'sha256:old',
    expectedDigest: 'sha256:old',
    patchRef: 'patch://project-a/agents',
    patchDigest: 'sha256:patch-digest',
    evidenceRefs: ['journal://project-a/evidence'],
    ownerRef: 'project-rule-owner',
  };
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: true,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('must not apply'); } },
  }), makeOperations().operations);
  const result = await agent.applyProjectUpdate({ proposal: staleProposal, projectKey: 'project-a' });
  assert.equal(result.status, 'attention');
  assert.equal(result.status === 'attention' && result.issue.code, 'memory-agent-update-conflict');
});

test('memory agent surfaces an unavailable local Skill as attention with manifest recovery', async () => {
  const proposal: ProjectSourceUpdateProposal = {
    target: 'project-local-skill',
    sourceRef: 'skill://project/project-a/project-a/SKILL.md@old',
    expectedRevision: 'sha256:old',
    expectedDigest: 'sha256:old',
    patchRef: 'patch://project-a/skill',
    patchDigest: 'sha256:patch-digest',
    evidenceRefs: ['journal://project-a/evidence'],
    ownerRef: 'project-skill-owner',
  };
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: {
      readProject: async () => { throw { code: 'memory-source-unavailable', nextAction: 'project.json#sources.localSkill' }; },
      list: async () => [],
    },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('must not apply'); } },
  }), makeOperations().operations);
  const result = await agent.applyProjectUpdate({ proposal, projectKey: 'project-a' });
  assert.equal(result.status, 'attention');
  if (result.status !== 'attention') throw new Error('expected source attention');
  assert.equal(result.issue.code, 'memory-agent-source-unavailable');
  assert.equal(result.issue.nextAction.ref, 'project.json#sources.localSkill');
});

test('memory agent analyzes recurring corrections and errors with independent evidence refs', async () => {
  const ports = makeOperations({
    recurrence: {
      classification: 'recurring',
      occurrences: [
        { ref: 'session://project-a/task-a/correction-1', digest: 'sha256:correction-1' },
        { ref: 'session://project-a/task-a/correction-2', digest: 'sha256:correction-2' },
      ],
      reason: 'same correction repeated twice',
    },
    sourceDigests: {
      'session://project-a/task-a/correction-1': 'sha256:correction-1',
      'session://project-a/task-a/correction-2': 'sha256:correction-2',
      'journal://project-a/error-1': 'sha256:error-1',
      'journal://project-a/error-2': 'sha256:error-2',
    },
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis({
    sourceRefs: [
      'journal://project-a/checkpoint',
      'session://project-a/task-a/correction-1',
      'session://project-a/task-a/correction-2',
      'journal://project-a/error-1',
      'journal://project-a/error-2',
    ],
    sourceDigests: [
      'sha256:checkpoint',
      'sha256:correction-1',
      'sha256:correction-2',
      'sha256:error-1',
      'sha256:error-2',
    ],
    analysisInputs: {
      corrections: [
        { sourceRef: 'session://project-a/task-a/correction-1', sourceDigest: 'sha256:correction-1', fingerprint: 'do-not-guess' },
        { sourceRef: 'session://project-a/task-a/correction-2', sourceDigest: 'sha256:correction-2', fingerprint: 'do-not-guess' },
      ],
      errors: [
        { sourceRef: 'journal://project-a/error-1', sourceDigest: 'sha256:error-1', fingerprint: 'checkpoint-timeout' },
        { sourceRef: 'journal://project-a/error-2', sourceDigest: 'sha256:error-2', fingerprint: 'checkpoint-timeout' },
      ],
      rewindChains: [],
      actualPathRefs: [],
      declaredPathRefs: [],
    },
  }));

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('expected recurring analysis');
  assert.equal(result.value.curation.outcome, 'candidate');
  assert.equal(ports.recurrenceRequests.length, 2);
  assert.deepEqual(ports.recurrenceRequests.map((request) => request.patternRef), ['do-not-guess', 'checkpoint-timeout']);
  assert.equal(ports.submissions.length, 1);
  assert.deepEqual(ports.submissions[0]?.evidenceRefs, [
    'journal://project-a/checkpoint',
    'session://project-a/task-a/correction-1',
    'session://project-a/task-a/correction-2',
    'journal://project-a/error-1',
    'journal://project-a/error-2',
  ]);
});

test('memory agent requires a complete matching rewind chain before emitting a procedural candidate', async () => {
  const complete = {
    failedBranchRef: 'journal://project-a/failed-branch',
    rewindCheckpointRef: 'journal://project-a/rewind-checkpoint',
    recoveryCheckpointRef: 'journal://project-a/recovery-checkpoint',
    reentryFactRef: 'journal://project-a/reentry-fact',
    successfulBranchRefs: ['journal://project-a/success-branch'],
    successEvidenceRefs: ['journal://project-a/success-evidence'],
    absoluteJournalRefs: ['journal://project-a/journal'],
  };
  const ports = makeOperations({
    comparisons: {
      'journal://project-a/failed-branch\u0000journal://project-a/rewind-checkpoint': 'different',
      'journal://project-a/rewind-checkpoint\u0000journal://project-a/recovery-checkpoint': 'different',
      'journal://project-a/recovery-checkpoint\u0000journal://project-a/reentry-fact': 'different',
      'journal://project-a/reentry-fact\u0000journal://project-a/success-branch': 'same',
    },
    sourceDigests: {
      [complete.failedBranchRef]: 'sha256:failed-branch',
      [complete.rewindCheckpointRef]: 'sha256:rewind-checkpoint',
      [complete.recoveryCheckpointRef]: 'sha256:recovery-checkpoint',
      [complete.reentryFactRef]: 'sha256:reentry-fact',
      [complete.successfulBranchRefs[0]!]: 'sha256:success-branch',
      [complete.successEvidenceRefs[0]!]: 'sha256:success-evidence',
      [complete.absoluteJournalRefs[0]!]: 'sha256:journal',
    },
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const completeResult = await agent.analyze(analysis({
    trigger: 'rewind',
    requestedKind: 'procedural',
    candidateCategory: 'project-experience',
    sourceRefs: [
      complete.failedBranchRef,
      complete.rewindCheckpointRef,
      complete.recoveryCheckpointRef,
      complete.reentryFactRef,
      ...complete.successfulBranchRefs,
      ...complete.successEvidenceRefs,
      ...complete.absoluteJournalRefs,
    ],
    sourceDigests: [
      'sha256:failed-branch',
      'sha256:rewind-checkpoint',
      'sha256:recovery-checkpoint',
      'sha256:reentry-fact',
      'sha256:success-branch',
      'sha256:success-evidence',
      'sha256:journal',
    ],
    analysisInputs: {
      corrections: [],
      errors: [],
      rewindChains: [complete],
      actualPathRefs: [],
      declaredPathRefs: [],
    },
  }));
  if (completeResult.status !== 'ready') {
    throw new Error(`expected complete rewind analysis: ${completeResult.issue.code}: ${completeResult.issue.message}`);
  }
  assert.equal(completeResult.value.curation.outcome, 'candidate');
  assert.equal(ports.submissions.length, 1);
  assert.deepEqual(ports.submissions[0]?.evidenceRefs, [
    complete.failedBranchRef,
    complete.rewindCheckpointRef,
    complete.recoveryCheckpointRef,
    complete.reentryFactRef,
    ...complete.successfulBranchRefs,
    ...complete.successEvidenceRefs,
    ...complete.absoluteJournalRefs,
  ]);

  const incompletePorts = makeOperations({
    sourceDigests: {
      [complete.failedBranchRef]: 'sha256:failed-branch',
      [complete.rewindCheckpointRef]: 'sha256:rewind-checkpoint',
      [complete.recoveryCheckpointRef]: 'sha256:recovery-checkpoint',
    },
  });
  const incompleteAgent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), incompletePorts.operations);
  const incompleteResult = await incompleteAgent.analyze(analysis({
    trigger: 'rewind',
    requestedKind: 'procedural',
    candidateCategory: 'project-experience',
    sourceRefs: [complete.failedBranchRef, complete.rewindCheckpointRef, complete.recoveryCheckpointRef],
    sourceDigests: ['sha256:failed-branch', 'sha256:rewind-checkpoint', 'sha256:recovery-checkpoint'],
    analysisInputs: {
      corrections: [],
      errors: [],
      rewindChains: [{
        ...complete,
        reentryFactRef: undefined,
        successfulBranchRefs: [],
        successEvidenceRefs: [],
        absoluteJournalRefs: [],
      }],
      actualPathRefs: [],
      declaredPathRefs: [],
    },
  }));
  if (incompleteResult.status !== 'ready') {
    throw new Error(`expected attention curation: ${incompleteResult.issue.code}: ${incompleteResult.issue.message}`);
  }
  assert.equal(incompleteResult.value.curation.outcome, 'attention');
  assert.deepEqual(incompletePorts.comparisons, []);
  assert.equal(incompletePorts.submissions.length, 0);
});

test('memory agent fails closed when a rewind analysis has no evidence chain', async () => {
  const ports = makeOperations();
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis({
    trigger: 'rewind',
    requestedKind: 'procedural',
    candidateCategory: 'project-experience',
  }));

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('expected attention curation');
  assert.equal(result.value.curation.outcome, 'attention');
  assert.equal(result.value.curation.explanation, 'rewind evidence chain is missing');
  assert.equal(ports.submissions.length, 0);
});

test('memory agent fails closed when a parsed rewind event omits the evidence chain', async () => {
  const envelope = createMemoryAnalysisRequestedEvent({
    messageId: 'rewind-without-chain',
    streamId: 'memory-boundaries',
    scope,
    occurredAt: '2026-09-17T00:00:00.000Z',
    summary: 'rewind without a typed evidence chain',
    evidenceRefs: [{
      evidenceId: id('evidence', 'rewind-source'),
      kind: 'operation',
      source: 'test',
      locator: 'journal://project-a/checkpoint',
      digest: 'sha256:checkpoint',
      scope,
    }],
    executionEpoch: 2,
    trigger: 'rewind',
    requestedKind: 'procedural',
    candidateCategory: 'project-experience',
  });
  const record: EventRecord = {
    ...envelope,
    publisherId: 'publisher-harness',
    sequence: 1,
    committedAt: '2026-09-17T00:00:00.000Z',
  };
  const request = memoryAnalysisRequestFromEvent(record, {
    bindingRef: 'binding-a',
    projectKey: 'project-a',
    executionEpoch: 2,
    scope,
    taskId: task,
    mainAgentId: 'main-agent-a',
    actor,
  });
  assert.equal(request.status, 'ready');
  if (request.status !== 'ready') throw new Error(request.issue.message);

  const ports = makeOperations();
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(request.value);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('expected attention curation');
  assert.equal(result.value.curation.outcome, 'attention');
  assert.equal(result.value.curation.explanation, 'rewind evidence chain is missing');
  assert.equal(ports.submissions.length, 0);
});

test('memory agent compares actual and declared paths before proposing an efficiency update', async () => {
  const actualRef = 'journal://project-a/actual-path';
  const declaredRef = 'project://project-a/AGENTS.md';
  const ports = makeOperations({
    comparisons: {
      [`${actualRef}\u0000${declaredRef}`]: 'different',
    },
    sourceDigests: {
      [actualRef]: 'sha256:actual-path',
      [declaredRef]: 'sha256:declared-path',
    },
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis({
    candidateCategory: 'project-experience',
    sourceRefs: [actualRef, declaredRef],
    sourceDigests: ['sha256:actual-path', 'sha256:declared-path'],
    analysisInputs: {
      corrections: [],
      errors: [],
      rewindChains: [],
      actualPathRefs: [actualRef],
      declaredPathRefs: [declaredRef],
    },
  }));

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('expected efficiency analysis');
  assert.deepEqual(ports.comparisons, [{ leftRef: actualRef, rightRef: declaredRef }]);
  assert.equal(result.value.curation.outcome, 'candidate');
});

test('memory agent uses the framework driver in start submit settle order and binds output to the operation', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const driver = providerDriver({ events });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error(result.issue.message);
  assert.deepEqual(events, [`start:${task.value}:2`, `submit:${task.value}:2`, 'settle']);
  assert.equal(result.value.curation.outcome, 'candidate');
  assert.equal(ports.submissions.length, 1);
});

test('memory agent assembles a driver for each admitted operation', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const assignments: string[] = [];
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driverFor: (input) => {
      assignments.push(input.assignmentId);
      assert.equal(input.taskId.value, task.value);
      assert.equal(input.executionEpoch, 2);
      return providerDriver({ events });
    },
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const first = await agent.analyze(analysis());
  const second = await agent.analyze(analysis({
    operationId: id('operation', 'analysis-b'),
  }));

  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  assert.deepEqual(assignments, ['memory-analysis:analysis-a', 'memory-analysis:analysis-b']);
  assert.deepEqual(events, [
    `start:${task.value}:2`,
    `submit:${task.value}:2`,
    'settle',
    `start:${task.value}:2`,
    `submit:${task.value}:2`,
    'settle',
  ]);
});

test('memory agent rejects simultaneous static and per-operation drivers', () => {
  const ports = makeOperations();
  assert.throws(() => new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver: providerDriver({ events: [] }),
    driverFor: () => providerDriver({ events: [] }),
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), /either driver or driverFor/);
});

test('memory analysis business payload carries no control key and binds identity from the admission', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  let captured: unknown;
  const driver = providerDriver({ events });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driverFor: (input) => {
      // The control plane carries the operation identity; the payload must not.
      assert.equal(input.assignmentId, 'memory-analysis:analysis-a');
      return {
        ...driver,
        submit: async (request) => {
          captured = request.payload;
          assertBusinessPayload(request.payload as never);
          return await driver.submit(request);
        },
      };
    },
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error(result.issue.message);
  const payload = captured as Record<string, unknown>;
  assert.equal('operationId' in payload, false);
  for (const key of ['retry', 'degrade', 'steer', 'continuation', 'health', 'debug', 'checkpoint', 'executionEpoch', 'operationId']) {
    assert.equal(key in payload, false, `control key leaked into the memory analysis payload: ${key}`);
  }
  // The identity still binds: the curation was produced without echoing an
  // operation id and the result is attributed to the admitted operation.
  assert.equal(result.value.curation.operationId.value, 'analysis-a');
  assert.equal(ports.submissions.length, 1);
  assert.equal(ports.submissions[0]?.operationId.value, 'analysis-a');
});

test('memory agent rejects a provider curation for another operation', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const driver = providerDriver({
    events,
    mutateOutput: (output) => ({
      ...output,
      payload: {
        curation: {
          ...(output.payload.curation as Record<string, unknown>),
          operationId: { scope: 'operation', value: 'other-operation' },
        },
      },
    }),
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'waiting');
  assert.equal(ports.submissions.length, 0);
  assert.deepEqual(events, [`start:${task.value}:2`, `submit:${task.value}:2`, 'settle']);
});

test('memory agent rejects a provider curation with a drifted prompt snapshot', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const driver = providerDriver({
    events,
    mutateOutput: (output) => ({
      ...output,
      payload: {
        curation: {
          ...(output.payload.curation as Record<string, unknown>),
          auditPrompt: {
            ...(output.payload.curation as { auditPrompt: Record<string, unknown> }).auditPrompt,
            canonicalRef: 'prompt://project-a/other-prompt',
          },
        },
      },
    }),
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'waiting');
  assert.equal(ports.submissions.length, 0);
  assert.deepEqual(events, [`start:${task.value}:2`, `submit:${task.value}:2`, 'settle']);
});

test('memory agent does not synthesize a Task for interaction-bound provider analysis', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const driver = providerDriver({ events });
  const interactionScope = 'interaction-no-task';
  const agent = new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  });
  agent.bind({
    bindingRef: 'binding-interaction',
    projectKey: 'project-a',
    scope: { namespace: 'project', projectKey: 'project-a', organId: organ },
    interactionScopeId: interactionScope,
    mainAgentId: 'main-agent-interaction',
    executionEpoch: 2,
    ownerId: 'memory-agent',
    operations: ports.operations,
  });

  const result = await agent.analyze(analysis({
    bindingRef: 'binding-interaction',
    taskId: undefined,
    interactionScopeId: interactionScope,
    scope: { namespace: 'project', projectKey: 'project-a', organId: organ },
    sourceRefs: ['journal://project-a/interaction-evidence'],
    sourceDigests: ['sha256:interaction-evidence'],
  }));

  assert.equal(result.status, 'attention');
  assert.equal(result.status === 'attention' && result.issue.code, 'memory-agent-analysis-provider-unsupported');
  assert.equal(result.status === 'attention' && result.issue.message, 'memory analysis provider requires a task-bound request');
  assert.deepEqual(result.status === 'attention' && result.issue.nextAction, { kind: 'recover', ref: 'memory-analysis-provider' });
  assert.equal(ports.submissions.length, 0);
  assert.deepEqual(events, []);
});

test('memory agent completes interaction-bound deterministic analysis without the provider guard', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const interactionScope = 'interaction-deterministic-analysis';
  const agent = new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  });
  agent.bind({
    bindingRef: 'binding-interaction-deterministic',
    projectKey: 'project-a',
    scope: { namespace: 'project', projectKey: 'project-a', organId: organ },
    interactionScopeId: interactionScope,
    mainAgentId: 'main-agent-interaction-deterministic',
    executionEpoch: 2,
    ownerId: 'memory-agent',
    operations: ports.operations,
  });

  const result = await agent.analyze(analysis({
    bindingRef: 'binding-interaction-deterministic',
    taskId: undefined,
    interactionScopeId: interactionScope,
    scope: { namespace: 'project', projectKey: 'project-a', organId: organ },
    sourceRefs: ['journal://project-a/interaction-evidence'],
    sourceDigests: ['sha256:interaction-evidence'],
  }));

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error(result.issue.message);
  assert.equal(result.value.curation.outcome, 'candidate');
  assert.equal(ports.submissions.length, 1);
  assert.deepEqual(events, []);
});

test('memory agent keeps interaction-bound deterministic operations failures waiting on the operations branch', async () => {
  const events: string[] = [];
  const ports = makeOperations({ failNovelty: true });
  const interactionScope = 'interaction-deterministic-operations-failure';
  const agent = new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  });
  agent.bind({
    bindingRef: 'binding-interaction-operations-failure',
    projectKey: 'project-a',
    scope: { namespace: 'project', projectKey: 'project-a', organId: organ },
    interactionScopeId: interactionScope,
    mainAgentId: 'main-agent-interaction-operations-failure',
    executionEpoch: 2,
    ownerId: 'memory-agent',
    operations: ports.operations,
  });

  const result = await agent.analyze(analysis({
    bindingRef: 'binding-interaction-operations-failure',
    taskId: undefined,
    interactionScopeId: interactionScope,
    scope: { namespace: 'project', projectKey: 'project-a', organId: organ },
    sourceRefs: ['journal://project-a/interaction-evidence'],
    sourceDigests: ['sha256:interaction-evidence'],
  }));

  assert.equal(result.status, 'waiting');
  assert.equal(result.status === 'waiting' && result.issue.code, 'memory-agent-analysis-unavailable');
  assert.equal(result.status === 'waiting' && result.issue.message, 'analysis backend down');
  assert.deepEqual(result.status === 'waiting' && result.issue.nextAction, { kind: 'wait', ref: 'memory-operations-ready' });
  assert.equal(ports.submissions.length, 0);
  assert.deepEqual(events, []);
});

test('memory agent treats a non-succeeded provider settle as an explicit analysis failure', async () => {
  const events: string[] = [];
  const ports = makeOperations();
  const driver = providerDriver({ events, settleState: 'failed' });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    driver,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis());

  assert.equal(result.status, 'waiting');
  assert.ok(/settle did not succeed/.test(result.status === 'waiting' ? result.issue.message : ''));
  assert.equal(ports.submissions.length, 0);
});

test('memory agent requires repeatable successful evidence before a local Skill update candidate', async () => {
  const first = 'journal://project-a/skill-run-1';
  const second = 'journal://project-a/skill-run-2';
  const ports = makeOperations({
    sourceDigests: {
      [first]: 'sha256:skill-run-1',
      [second]: 'sha256:skill-run-2',
    },
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const insufficient = await agent.analyze(analysis({
    requestedKind: 'procedural',
    candidateCategory: 'local-skill-update',
    sourceRefs: [first],
    sourceDigests: ['sha256:skill-run-1'],
    analysisInputs: {
      corrections: [],
      errors: [],
      proceduralEvidence: [proceduralEvidence(first)],
      rewindChains: [],
      actualPathRefs: [],
      declaredPathRefs: [],
    },
  }));
  assert.equal(insufficient.status, 'ready');
  assert.equal(insufficient.status === 'ready' && insufficient.value.curation.outcome, 'attention');
  assert.equal(ports.submissions.length, 0);

  const repeatable = await agent.analyze(analysis({
    operationId: id('operation', 'analysis-skill-repeatable'),
    requestedKind: 'procedural',
    candidateCategory: 'local-skill-update',
    sourceRefs: [first, second],
    sourceDigests: ['sha256:skill-run-1', 'sha256:skill-run-2'],
    analysisInputs: {
      corrections: [],
      errors: [],
      proceduralEvidence: [proceduralEvidence(first), proceduralEvidence(second)],
      rewindChains: [],
      actualPathRefs: [],
      declaredPathRefs: [],
    },
  }));
  assert.equal(repeatable.status, 'ready');
  assert.equal(repeatable.status === 'ready' && repeatable.value.curation.outcome, 'candidate');
  assert.equal(ports.submissions.length, 1);
});

test('memory agent rejects failed or fingerprint-divergent local Skill evidence', async () => {
  const first = 'journal://project-a/skill-run-1';
  const second = 'journal://project-a/skill-run-2';
  const ports = makeOperations({
    sourceDigests: {
      [first]: 'sha256:skill-run-1',
      [second]: 'sha256:skill-run-2',
    },
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const failedEvidence = await agent.analyze(analysis({
    requestedKind: 'procedural',
    candidateCategory: 'local-skill-update',
    sourceRefs: [first, second],
    sourceDigests: ['sha256:skill-run-1', 'sha256:skill-run-2'],
    analysisInputs: {
      corrections: [],
      errors: [],
      proceduralEvidence: [proceduralEvidence(first), proceduralEvidence(second, false)],
      rewindChains: [],
      actualPathRefs: [],
      declaredPathRefs: [],
    },
  }));
  assert.equal(failedEvidence.status, 'ready');
  assert.equal(failedEvidence.status === 'ready' && failedEvidence.value.curation.outcome, 'attention');

  const divergentEvidence = await agent.analyze(analysis({
    operationId: id('operation', 'analysis-skill-divergent'),
    requestedKind: 'procedural',
    candidateCategory: 'local-skill-update',
    sourceRefs: [first, second],
    sourceDigests: ['sha256:skill-run-1', 'sha256:skill-run-2'],
    analysisInputs: {
      corrections: [],
      errors: [],
      proceduralEvidence: [
        proceduralEvidence(first),
        { ...proceduralEvidence(second), stepFingerprint: 'step:different' },
      ],
      rewindChains: [],
      actualPathRefs: [],
      declaredPathRefs: [],
    },
  }));
  assert.equal(divergentEvidence.status, 'ready');
  assert.equal(divergentEvidence.status === 'ready' && divergentEvidence.value.curation.outcome, 'attention');
  assert.equal(ports.submissions.length, 0);
});

test('memory agent rejects procedural evidence whose source digest is not admitted', async () => {
  const admitted = 'journal://project-a/skill-run-1';
  const unadmitted = 'journal://project-a/skill-run-unlisted';
  const ports = makeOperations({
    sourceDigests: {
      [admitted]: 'sha256:skill-run-1',
    },
  });
  const agent = bind(new MemoryAgent({
    projectKey: 'project-a',
    auditPromptRef: 'project-memory-audit',
    autoUpdate: false,
    sessions: { readSession: async () => sessionEvidence },
    projectSources: { readProject: async () => projectSource(), list: async () => [projectSource()] },
    auditPrompts: { readPrompt: async () => promptSource() },
    projectUpdateOwner: { apply: async () => { throw new Error('unexpected update'); } },
  }), ports.operations);

  const result = await agent.analyze(analysis({
    requestedKind: 'procedural',
    candidateCategory: 'local-skill-update',
    sourceRefs: [admitted],
    sourceDigests: ['sha256:skill-run-1'],
    analysisInputs: {
      corrections: [],
      errors: [],
      proceduralEvidence: [
        proceduralEvidence(admitted),
        proceduralEvidence(unadmitted),
      ],
      rewindChains: [],
      actualPathRefs: [],
      declaredPathRefs: [],
    },
  }));

  assert.equal(result.status, 'attention');
  assert.equal(
    result.status === 'attention' && result.issue.message,
    `memory analysis input source or digest does not match source refs: ${unadmitted}`,
  );
  assert.equal(ports.submissions.length, 0);
});
