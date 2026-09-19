import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type MemoryActorContext,
  type MemoryAuditPromptSnapshotSource,
  type MemoryAuditPromptSourcePort,
  type MemoryOperationsPort,
  type MemoryProjectSourcePort,
  type MemoryProjectSourceSnapshot,
  type MemoryScope,
  type MemorySessionEvidence,
  type MemorySessionEvidenceSourcePort,
  type MemorySubmission,
  type ProjectSourceUpdateProposal,
} from '../../../packages/contracts/src/index.js';
import {
  MemoryAgent,
  type MemoryProjectUpdateOwnerPort,
} from '../../../packages/runtime/src/memory/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: MemoryScope = { kind: 'task', organId: organ, taskId: task };
const actor: MemoryActorContext = {
  actorId: 'memory-agent-a',
  roleId: 'memory',
  permissions: ['memory.read', 'memory.propose'],
  projectKey: 'project-a',
};

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
} = {}): {
  readonly operations: MemoryOperationsPort;
  readonly submissions: MemorySubmission[];
  readonly ingest: string[];
} {
  const submissions: MemorySubmission[] = [];
  const ingest: string[] = [];
  const operations: MemoryOperationsPort = {
    ingest: async (input) => {
      ingest.push(input.sourceRef);
      return { sourceRef: input.sourceRef };
    },
    search: async () => [],
    inspect: async (input) => ({
      sourceRef: input.sourceRef,
      sourceDigest: input.sourceRef === 'journal://project-a/checkpoint'
        ? 'sha256:checkpoint'
        : input.sourceRef === 'journal://project-a/evidence'
          ? 'sha256:evidence'
          : input.sourceRef === 'journal://project-a/interaction-evidence'
            ? 'sha256:interaction-evidence'
          : 'sha256:source',
      text: 'source',
    }),
    compare: async () => ({ relation: 'different' }),
    detectNovelty: async (input) => {
      if (overrides.failNovelty) throw new Error('analysis backend down');
      return {
        classification: overrides.novelty ?? 'novel',
        matchedRefs: overrides.novelty === 'known' ? ['memory://known'] : [],
        reason: overrides.novelty === 'known' ? 'source digest already exists' : 'source digest is new',
      };
    },
    detectRecurrence: async () => ({ classification: 'one-off', occurrences: [], reason: 'not recurring' }),
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
  return { operations, submissions, ingest };
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
    scope: { kind: 'organ', organId: organ },
    interactionScopeId,
    mainAgentId: 'main-agent-interaction',
    executionEpoch: 2,
    ownerId: 'memory-agent',
    operations: ports.operations,
  });

  const analyzed = await agent.analyze(analysis({
    operationId: id('operation', 'interaction-analysis'),
    bindingRef: 'binding-interaction',
    scope: { kind: 'organ', organId: organ },
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

test('memory agent rejects auto update when the project source digest drifted', async () => {
  const staleProposal: ProjectSourceUpdateProposal = {
    target: 'project-agents',
    sourceRef: 'project://project-a/AGENTS.md@old',
    expectedRevision: 'sha256:old',
    expectedDigest: 'sha256:old',
    patchRef: 'patch://project-a/agents',
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
