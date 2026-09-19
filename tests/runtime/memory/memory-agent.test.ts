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
      sourceDigest: input.sourceRef === 'journal://project-a/checkpoint' ? 'sha256:checkpoint' : 'sha256:source',
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
  const accepted = await agent.followUp(followUp);
  assert.equal(accepted.status, 'ready');
  if (accepted.status !== 'ready') throw new Error('expected follow-up acceptance');
  assert.equal(accepted.value.correlationId, 'correlation-a');
  const repeated = await agent.followUp(followUp);
  assert.equal(repeated.status, 'ready');
  assert.equal(repeated.status === 'ready' && repeated.value.operationId.value, 'follow-up-operation');

  const stale = await agent.followUp({ ...followUp, operationId: id('operation', 'follow-up-b'), correlationId: 'correlation-b', inReplyTo: 'follow-up-operation' });
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
