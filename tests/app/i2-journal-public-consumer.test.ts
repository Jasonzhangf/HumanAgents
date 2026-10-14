import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJsonStringify, id } from '../../packages/contracts/src/index.js';
import type {
  BusinessCycleClosedRecord,
  BusinessCycleOpenedRecord,
  DurableInspectionDefinition,
  I2Record,
  InspectionItemResultRecord,
  InspectionOccurrenceOpenedRecord,
  InspectionOccurrenceSettledRecord,
  JournalCommitRef,
  MilestoneReviewAlignedRecord,
  MilestoneReviewResultRecord,
  ScopeRef,
  TaskId,
  WorkAssignment,
  WorkResult,
} from '../../packages/contracts/src/index.js';
import { computeInspectionDefinitionDigest } from '../../packages/core/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskPlanRevisionJournal } from '../../packages/adapters/jsonl/src/task-plan-revisions.js';
import { createJsonlI2JournalPort, I2_JOURNAL_PAYLOAD_KIND } from '../../packages/app/src/i2-journal.js';
import {
  AgentRuntimePoolManager, OrchestrationManager, OrchestrationError,
  acceptanceCriteriaContent, digestOf, resolveReviewMaterial,
  type ChildCallPort, type IndependentChildCallInput, type ExecutionAgentPort,
  type ReviewAgentPort,
} from '../../packages/runtime/src/orchestration/index.js';
import { createReviewAssignments } from '../../packages/runtime/src/review/index.js';

// Probability UNKNOWN; the physical I2JournalPort adapter had no public consumer.
// A wrong binding or a fabricated receipt can publish false history or accept a
// foreign task fact. One bounded local fixture (same Organ Journal, cold decode)
// is cheap and reuses the frozen Core relation invariants.

const fixtureRoot = process.env.HUMANAGENT_I2_FIXTURE_ROOT
  ?? '/Users/fanzhang/.humanagent/test-fixtures/ux-review-call-identity-20261013';
const organId = id('organ', 'i2-journal-organ');

type TaskScope = ScopeRef & { readonly taskId: TaskId };

const ALL_KINDS: readonly I2Record['kind'][] = [
  'inspection-definition',
  'business-cycle-opened',
  'inspection-occurrence-opened',
  'inspection-item-result',
  'inspection-occurrence-settled',
  'milestone-review-result',
  'milestone-review-aligned',
  'business-cycle-closed',
];

function externalRef(seed: string): JournalCommitRef {
  return { commitId: `external:${seed}`, journalSeq: 1, recordDigest: `sha256:${'0'.repeat(64)}` };
}

function definitionRecord(input: {
  readonly taskScope: TaskScope;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly checkIds: readonly string[];
  readonly createdAt: string;
}): DurableInspectionDefinition {
  const definition = {
    definitionId: input.definitionId,
    definitionVersion: input.definitionVersion,
    target: { targetRef: `target:${input.definitionId}`, sourceRef: `source:${input.definitionId}` },
    checkItems: input.checkIds.map((checkId) => ({ checkId })),
  };
  const checks = input.checkIds.map((checkId) => ({
    checkId,
    criterion: `criterion:${checkId}`,
    inputRefs: [`input:${checkId}`],
  }));
  const content = { definition, checks };
  return {
    kind: 'inspection-definition',
    schemaVersion: 1,
    taskScope: input.taskScope,
    content,
    definitionDigest: computeInspectionDefinitionDigest(content),
    planRevisionCommitRef: externalRef(`${input.definitionId}-plan`),
    createdAt: input.createdAt,
  };
}

function cycleOpened(input: {
  readonly taskScope: TaskScope;
  readonly cycleId: string;
  readonly previousCycleCommitRef?: JournalCommitRef | null;
  readonly openedAt: string;
}): BusinessCycleOpenedRecord {
  return {
    kind: 'business-cycle-opened',
    schemaVersion: 1,
    cycle: { id: id('cycle', input.cycleId), scope: input.taskScope, directiveRevision: 1, executionEpoch: 1, state: 'running' },
    taskFlow: { kind: 'inspection', definitionVersion: 1 },
    planRevisionCommitRef: externalRef(`${input.cycleId}-plan`),
    previousCycleCommitRef: input.previousCycleCommitRef ?? null,
    openedAt: input.openedAt,
    openingReason: 'authorized start',
  };
}

function occurrenceOpened(input: {
  readonly taskScope: TaskScope;
  readonly occurrenceId: string;
  readonly cycleId: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionCommitRef: JournalCommitRef;
  readonly definitionDigest: string;
  readonly cycleOpenedCommitRef: JournalCommitRef;
  readonly openedAt: string;
}): InspectionOccurrenceOpenedRecord {
  return {
    kind: 'inspection-occurrence-opened',
    schemaVersion: 1,
    occurrence: { scope: input.taskScope, occurrenceId: input.occurrenceId },
    executionScope: input.taskScope,
    cycleId: input.cycleId,
    executionEpoch: 1,
    definition: { definitionId: input.definitionId, definitionVersion: input.definitionVersion },
    definitionCommitRef: input.definitionCommitRef,
    definitionDigest: input.definitionDigest,
    planRevisionCommitRef: externalRef(`${input.occurrenceId}-plan`),
    cycleOpenedCommitRef: input.cycleOpenedCommitRef,
    scheduleOccurrenceRef: null,
    openedAt: input.openedAt,
  };
}

function itemResult(input: {
  readonly taskScope: TaskScope;
  readonly occurrenceId: string;
  readonly cycleId: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionCommitRef: JournalCommitRef;
  readonly definitionDigest: string;
  readonly cycleOpenedCommitRef: JournalCommitRef;
  readonly checkId: string;
  readonly resultId: string;
  readonly completedAt: string;
}): InspectionItemResultRecord {
  return {
    kind: 'inspection-item-result',
    schemaVersion: 1,
    binding: {
      occurrence: { scope: input.taskScope, occurrenceId: input.occurrenceId },
      executionScope: input.taskScope,
      cycleId: input.cycleId,
      executionEpoch: 1,
      definition: { definitionId: input.definitionId, definitionVersion: input.definitionVersion },
      definitionCommitRef: input.definitionCommitRef,
      definitionDigest: input.definitionDigest,
      cycleOpenedCommitRef: input.cycleOpenedCommitRef,
      scheduleOccurrenceRef: null,
    },
    delivery: {
      checkId: input.checkId,
      resultId: input.resultId,
      attempt: 1,
      outcome: { status: 'completed', judgment: `judgment:${input.checkId}` },
      evidenceRefs: [],
      completedAt: input.completedAt,
    },
  };
}

function settled(input: {
  readonly taskScope: TaskScope;
  readonly occurrenceId: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly openingCommitRef: JournalCommitRef;
  readonly itemResultCommitRefs: readonly JournalCommitRef[];
  readonly settledAt: string;
}): InspectionOccurrenceSettledRecord {
  return {
    kind: 'inspection-occurrence-settled',
    schemaVersion: 1,
    openingCommitRef: input.openingCommitRef,
    occurrence: { scope: input.taskScope, occurrenceId: input.occurrenceId },
    definition: { definitionId: input.definitionId, definitionVersion: input.definitionVersion },
    itemResultCommitRefs: input.itemResultCommitRefs,
    outcome: { status: 'completed', judgment: 'settled' },
    checkpointCommitRef: externalRef(`${input.occurrenceId}-checkpoint`),
    settledAt: input.settledAt,
  };
}

function reviewResult(input: {
  readonly taskScope: TaskScope;
  readonly milestoneId: string;
  readonly cycleId: string;
  readonly assignmentId: string;
  readonly resultId: string;
  readonly completedAt: string;
}): MilestoneReviewResultRecord {
  const taskIdValue = input.taskScope.taskId.value;
  const reviewer = {
    runtimeId: 'reviewer-runtime',
    generation: 1,
    agentInstanceId: 'reviewer-instance',
    roleId: 'review',
    taskId: input.taskScope.taskId,
    assignmentId: input.assignmentId,
    executionEpoch: 1,
  };
  const reviewAssignment = {
    assignmentId: input.assignmentId,
    taskId: taskIdValue,
    workerAgentId: 'worker-1',
    reviewKind: 'quality' as const,
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    acceptanceCriteriaDigest: 'digest:criteria',
    subjectRefs: ['subject:1'],
    subjectDigests: [`sha256:${'1'.repeat(64)}`],
    workerCapabilities: ['coding'],
    requiredCapabilities: ['coding'],
    mergeGate: 'not-required' as const,
  };
  const result = {
    resultId: input.resultId,
    assignmentId: input.assignmentId,
    taskId: taskIdValue,
    workerAgentId: 'worker-1',
    reviewKind: 'quality' as const,
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    acceptanceCriteriaDigest: 'digest:criteria',
    subjectRefs: ['subject:1'],
    subjectDigests: [`sha256:${'1'.repeat(64)}`],
    status: 'passed' as const,
    findings: [],
    evidenceRefs: [],
  };
  return {
    kind: 'milestone-review-result',
    schemaVersion: 1,
    milestoneId: input.milestoneId,
    cycleId: id('cycle', input.cycleId),
    taskScope: input.taskScope,
    executionScope: input.taskScope,
    planRevisionCommitRef: externalRef(`${input.milestoneId}-plan`),
    reviewAssignment,
    delivery: {
      result,
      reviewer,
      output: { text: 'review passed', artifactRef: null, artifactDigest: null },
      completedAt: input.completedAt,
    },
    completedAt: input.completedAt,
  };
}

function aligned(input: {
  readonly milestoneId: string;
  readonly cycleId: string;
  readonly reviewCommitRef: JournalCommitRef;
}): MilestoneReviewAlignedRecord {
  return {
    kind: 'milestone-review-aligned',
    schemaVersion: 1,
    reviewCommitRef: input.reviewCommitRef,
    milestoneId: input.milestoneId,
    cycleId: id('cycle', input.cycleId),
    checkpointCommitRef: externalRef(`${input.milestoneId}-checkpoint`),
    turnClosureRef: 'turn-closure:1',
    contextCommitRef: externalRef(`${input.milestoneId}-context`),
    alignmentRef: 'alignment:1',
    alignedPlanRevisionCommitRef: externalRef(`${input.milestoneId}-aligned-plan`),
  };
}

function cycleClosed(input: {
  readonly cycleId: string;
  readonly openedCommitRef: JournalCommitRef;
  readonly milestoneAlignmentCommitRefs: readonly JournalCommitRef[];
  readonly inspectionSettlementCommitRef?: JournalCommitRef;
  readonly closedAt: string;
}): BusinessCycleClosedRecord {
  return {
    kind: 'business-cycle-closed',
    schemaVersion: 1,
    openedCommitRef: input.openedCommitRef,
    cycleId: id('cycle', input.cycleId),
    outcome: 'continue',
    checkpointCommitRef: externalRef(`${input.cycleId}-closure-checkpoint`),
    milestoneAlignmentCommitRefs: input.milestoneAlignmentCommitRefs,
    ...(input.inspectionSettlementCommitRef === undefined
      ? {}
      : { inspectionSettlementCommitRef: input.inspectionSettlementCommitRef }),
    next: { kind: 'continue' },
    closedAt: input.closedAt,
  };
}

interface Fixture {
  readonly root: string;
  readonly organPath: string;
  readonly journal: JsonlOrganJournal;
}

async function openFixture(prefix: string): Promise<Fixture> {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, prefix));
  const organPath = join(root, 'organ.jsonl');
  return { root, organPath, journal: new JsonlOrganJournal(organPath) };
}

const at = (n: number): string => new Date(Date.UTC(2026, 9, 13, 0, 0, n)).toISOString();

// callChild failure probability UNKNOWN; API absence is source-confirmed.
// Impact: repeated review reruns work, loses call identity, or adopts without
// parent choice. Cost: one existing public consumer, physical local fixture,
// and optional controlled loopback HTTP boundary; no production Task claim.
async function singleCallFixture() {
  // Sandbox adaptation: the frozen reference hardcodes a home fixture root.
  // Only the base directory is overridable; every assertion is unchanged.
  const base = process.env.HUMANAGENT_SINGLE_CALL_FIXTURE_ROOT
    ?? '/Users/fanzhang/.humanagent/test-fixtures/ux-i0-single-call-20261013';
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'manager-'));
  const journal = new JsonlOrganJournal(join(root, 'organ.jsonl'));
  const taskScope: TaskScope = { organId, taskId: id('task', 'single-call-task') };
  const scope: ScopeRef = { ...taskScope, cycleId: id('cycle', 'single-call-cycle') };
  const body = 'genuine bounded child output';
  const work: WorkAssignment = {
    assignmentId: 'single-call-work', taskId: taskScope.taskId, pipelineNodeId: 'single-call-node',
    attempt: 1, executionEpoch: 1, inputRevision: 1, objective: 'produce bounded child output',
    targetRefs: ['child-output'], expectedOutputRefs: ['child-output'],
    successCriteria: ['produced exact output'], failureCriteria: ['failed output'], incompleteCriteria: ['missing output'],
    acceptanceCriteriaDigest: '', requiredCapabilities: ['execute'], mergeGate: 'not-required',
  };
  const assignment = { ...work, acceptanceCriteriaDigest: digestOf(acceptanceCriteriaContent(work)) };
  let executions = 0;
  let reviews = 0;
  let releases = 0;
  let disposes = 0;
  let failure: 'checkpoint' | 'association' | 'return' | 'invoke' | 'identity' | 'release' | undefined;
  const pool = new AgentRuntimePoolManager({ maxRuntimes: 1, ownerId: 'single-call-pool',
    initialRuntimes: [{ runtimeId: 'single-call-runtime', capabilities: ['execute', 'quality.review'] }],
    factory: {
      async start(input) { return { runtimeId: input.runtimeId, generation: input.generation, capabilities: input.requiredCapabilities }; },
      async dispose() {},
    },
  });
  const ref = (label: string) => ({ evidenceId: id('evidence', label), kind: 'execution' as const,
    source: 'single-call-public-consumer', locator: label, scope });
  const port: ChildCallPort = {
    async prepare(input) {
      assert.ok(input.lease, 'both kinds prepare with a genuine acquired lease');
      assert.equal(input.lease!.incarnation.taskId.value, taskScope.taskId.value);
      if (failure === 'checkpoint') throw new Error('physical checkpoint append refused');
      const checkpoint = await journal.append({ commitId: `fixture-checkpoint:${input.invocationId}`,
        kind: 'event', scope, payload: { kind: 'single-call-fixture-checkpoint', invocationId: input.invocationId } });
      assert.ok((await journal.replay()).some((item) => item.commitId === checkpoint.commitId));
      if (failure === 'association') throw new Error('physical invocation association refused');
      await journal.append({ commitId: `fixture-association:${input.invocationId}`, kind: 'event', scope,
        payload: { kind: 'single-call-fixture-association', invocationId: input.invocationId, checkpoint: checkpoint.commitId } });
      return { invocationId: input.invocationId, checkpointReceiptRef: checkpoint.commitId! };
    },
    async recordReturn(input) {
      if (failure === 'return') throw new Error('physical refined return append refused');
      await journal.append({ commitId: `fixture-return:${input.invocationId}`, kind: 'event', scope,
        payload: { kind: 'single-call-fixture-return', invocationId: input.invocationId, result: input.result } });
    },
    async recordAdoption() { throw new Error('return-only API must not adopt'); },
    async recordReviewCheckpoint() { throw new Error('return-only API must not claim an adopted-review checkpoint'); },
  };
  const release = async () => { releases += 1; if (failure === 'release' || failure === 'invoke') throw new Error('child lease settle failed'); };
  const dispose = async () => { disposes += 1; };
  const executionAgent: ExecutionAgentPort = {
    roleId: 'execution',
    async execute() { throw new Error('root/direct execution callback must never run'); },
    createInstance(create) {
      return { incarnation: create.incarnation, release, dispose,
        async execute(input) {
          executions += 1;
          const records = await journal.replay();
          const invocationId = create.assignment.assignmentId;
          assert.ok(records.some((item) => item.commitId === `fixture-checkpoint:${invocationId}`));
          assert.ok(records.some((item) => item.commitId === `fixture-association:${invocationId}`));
          assert.deepEqual(input.lease.incarnation, create.incarnation);
          if (failure === 'invoke') throw new OrchestrationError('controlled child outcome unknown', {
            ownerId: 'actual-child-owner', reason: 'controlled child outcome unknown',
            nextAction: { kind: 'recover', ref: 'retain-child-duty' }, evidenceRefs: [ref('unknown-child')],
          });
          const url = process.env.HUMANAGENT_SINGLE_CALL_HTTP;
          const output = url ? await (await fetch(url, { method: 'POST', signal: input.signal,
            body: JSON.stringify({ kind: 'execution', invocationId, incarnation: create.incarnation,
              journalPath: join(root, 'organ.jsonl'), instructions: create.assignment.objective }) })).text() : body;
          await writeFile(join(root, 'child-output.txt'), output, 'utf8');
          const result: WorkResult = { taskId: taskScope.taskId, pipelineNodeId: assignment.pipelineNodeId,
            agentId: failure === 'identity' ? 'foreign-agent' : input.agentId,
            assignmentId: create.assignment.assignmentId, attempt: 1, executionEpoch: 1, inputRevision: 1,
            producedArtifactRefs: ['child-output'], producedArtifactDigests: [digestOf(output)], producedArtifactBodies: [output],
            status: 'succeeded', summary: 'bounded output produced', outputRefs: ['child-output'],
            evidenceRefs: [ref('child-output')], nextAction: 'review' };
          return { result, criteria: { satisfied: assignment.successCriteria, failed: [], incomplete: [] } };
        },
      };
    },
  };
  const reviewAgent: ReviewAgentPort = {
    roleId: 'review',
    async review() { throw new Error('direct/root review callback must never run'); },
    createInstance(create) {
      return { incarnation: create.incarnation, release, dispose,
        async review(input) {
          reviews += 1;
          const records = await journal.replay();
          assert.ok(records.some((item) => item.commitId === `fixture-checkpoint:${create.incarnation.assignmentId}`));
          assert.ok(records.some((item) => item.commitId === `fixture-association:${create.incarnation.assignmentId}`));
          assert.equal(input.reviewMaterial.subjects[0]!.body, await readFile(join(root, 'child-output.txt'), 'utf8'));
          const url = process.env.HUMANAGENT_SINGLE_CALL_HTTP;
          if (url) {
            const response = await fetch(url, { method: 'POST', signal: input.signal,
              body: JSON.stringify({ kind: 'review', invocationId: create.incarnation.assignmentId,
                incarnation: create.incarnation, journalPath: join(root, 'organ.jsonl'), material: input.reviewMaterial }) });
            assert.equal(response.ok, true);
            await response.text();
          }
          return {
            result: { ...input.reviewAssignment, resultId: `result:${create.incarnation.agentInstanceId}`,
              status: 'passed', findings: [], evidenceRefs: [ref('review-output')] },
            output: { text: 'independent review passed', artifactRef: null, artifactDigest: null }, completedAt: at(1),
          };
        },
      };
    },
  };
  const manager = new OrchestrationManager({ ownerId: 'single-call-manager', runtimePool: pool,
    executionAgent, reviewAgent, reviewJournal: createJsonlI2JournalPort({ filePath: join(root, 'organ.jsonl'), journal }) });
  async function common(invocationId: string) {
    const registration = await journal.append({ commitId: `fixture-business:${invocationId}`, kind: 'event', scope,
      payload: { kind: 'single-call-fixture-business', invocationId } });
    return { agentId: 'configured-worker', scope, childCallPort: port, signal: new AbortController().signal,
      call: { invocationId, parentExecution: { runtimeId: 'actual-parent-fixture', taskId: taskScope.taskId,
        operationId: id('operation', 'parent-fixture-operation'), executionEpoch: 1 },
        providerRequestId: `request:${invocationId}`, toolCallId: `tool:${invocationId}`,
        businessRegistrationCommitRef: { commitId: registration.commitId!, journalSeq: registration.seq, recordDigest: registration.recordDigest } },
    };
  }
  const execution = async (key: string): Promise<IndependentChildCallInput & { kind: 'execution' }> => ({
    ...await common(key), kind: 'execution', assignment: { ...assignment, assignmentId: key }, executionAgent,
  });
  const review = async (key: string, workerAssignment: WorkAssignment, workerResult: WorkResult): Promise<IndependentChildCallInput & { kind: 'review' }> => ({
    ...await common(key), agentId: 'configured-reviewer', kind: 'review', reviewAgent,
    input: { scope, workerAssignment, workerResult,
      reviewAssignment: createReviewAssignments({ workerAssignment, workerResult, reviewKinds: ['quality'],
        subjectRefs: workerAssignment.targetRefs, subjectDigests: workerResult.producedArtifactDigests })[0]!,
      reviewMaterial: resolveReviewMaterial({ workerAssignment, workerResult, subjects: [{ ref: 'child-output', body }] }),
    },
  });
  return { root, journal, pool, manager, execution, review, taskScope, scope,
    counts: () => ({ executions, reviews, releases, disposes }), fail: (value: typeof failure) => { failure = value; },
    async cleanup() { const disposed = await pool.dispose(); assert.equal(disposed.status, 'disposed'); await rm(root, { recursive: true, force: true }); },
  };
}

test('single call public API returns genuine work and standalone repeated reviews without rerunning work or adopting', async () => {
  const f = await singleCallFixture();
  try {
    const input = await f.execution('work-call');
    const [work, retry] = await Promise.all([f.manager.callChild(input), f.manager.callChild(input)]);
    assert.deepEqual(work, retry);
    assert.equal(work.state, 'returned');
    if (work.state !== 'returned' || work.kind !== 'execution') throw new Error(JSON.stringify(work));
    assert.equal(work.incarnation.roleId, 'execution');
    assert.equal(await readFile(join(f.root, 'child-output.txt'), 'utf8'), 'genuine bounded child output');
    const firstInput = await f.review('review-call:first', input.assignment, work.result);
    const first = await f.manager.callChild(firstInput);
    const secondInput = await f.review('review-call:second', input.assignment, work.result);
    f.fail('return');
    assert.equal((await f.manager.callChild(secondInput)).state, 'blocked');
    f.fail(undefined);
    const second = await f.manager.callChild(secondInput);
    assert.equal(first.state, 'returned');
    assert.equal(second.state, 'returned', JSON.stringify(second));
    if (first.state !== 'returned' || first.kind !== 'review' || second.state !== 'returned' || second.kind !== 'review') {
      throw new Error(JSON.stringify({ first, second }));
    }
    assert.equal(first.incarnation.assignmentId, 'review-call:first');
    assert.equal(second.incarnation.assignmentId, 'review-call:second');
    assert.ok(first.incarnation.agentInstanceId !== second.incarnation.agentInstanceId);
    assert.equal(first.delivery.result.assignmentId, second.delivery.result.assignmentId, 'real review assignment stays stable');
    assert.equal(first.reviewCommitRef, undefined, 'ordinary review must not invent I2');
    assert.equal(second.reviewCommitRef, undefined);
    assert.deepEqual(await f.manager.callChild(secondInput), second);
    assert.deepEqual(await f.manager.callChild(firstInput), first);
    const conflict = await f.manager.callChild({ ...firstInput, agentId: 'different-reviewer' });
    assert.equal(conflict.state, 'blocked');
    const invalid = await f.manager.callChild({ ...secondInput, call: { ...secondInput.call, invocationId: 'invalid-material' },
      input: { ...secondInput.input, reviewMaterial: { ...secondInput.input.reviewMaterial, acceptanceCriteria: 'drifted' } } });
    assert.equal(invalid.state, 'blocked');
    assert.deepEqual(f.counts(), { executions: 1, reviews: 2, releases: 3, disposes: 3 });
    assert.deepEqual(f.manager.graph.snapshot(), { stages: [], assignments: [] }, 'single calls do not run dispatch');
    const records = await f.journal.replay();
    assert.equal(records.filter((r) => r.payload?.kind === 'single-call-fixture-return').length, 3);
    console.info('single call receipts', JSON.stringify({ counts: f.counts(), calls: records.map((r) => r.commitId) }));
  } finally { f.fail(undefined); await f.cleanup(); }
});

// UNKNOWN likelihood; failed physical append and lost return acknowledgement
// can produce duplicate external effects or calls with no recovery anchor.
// Wrong-agent and failed/incomplete return handling can also falsely accept a
// result or launch unsolicited retries. Cost: fault the existing fixture port
// and handle delivery, then exact-read the same Journal; no additional suite.
test('single call pre-call physical failures prevent invocation and known-return retry never repeats the child', async () => {
  const f = await singleCallFixture();
  try {
    const input = await f.execution('retry-work');
    f.fail('checkpoint');
    assert.equal((await f.manager.callChild(input)).state, 'blocked');
    assert.equal(f.counts().executions, 0);
    f.fail('association');
    assert.equal((await f.manager.callChild(input)).state, 'blocked');
    assert.equal(f.counts().executions, 0);
    assert.equal((await f.journal.replay()).filter((r) => r.commitId === 'fixture-checkpoint:retry-work').length, 1);
    f.fail('return');
    assert.equal((await f.manager.callChild(input)).state, 'blocked');
    assert.equal(f.counts().executions, 1);
    f.fail(undefined);
    assert.equal((await f.manager.callChild(input)).state, 'returned');
    assert.deepEqual(f.counts(), { executions: 1, reviews: 0, releases: 3, disposes: 3 });
    const invalidInput = await f.execution('wrong-agent-work');
    f.fail('identity');
    const invalid = await f.manager.callChild(invalidInput);
    assert.equal(invalid.state, 'blocked');
    assert.deepEqual(await f.manager.callChild(invalidInput), invalid, 'invalid external return must not permit another call');
    assert.equal(f.counts().executions, 2);
    assert.equal((await f.journal.replay()).some((r) => r.commitId === 'fixture-return:wrong-agent-work'), false);
    f.fail(undefined);
    for (const status of ['failed', 'incomplete'] as const) {
      const failureInput = await f.execution(`${status}-work`);
      const original = failureInput.executionAgent;
      const selected: ExecutionAgentPort = { ...original,
        createInstance(create) {
          const handle = original.createInstance(create);
          return { ...handle, async execute(input) {
            const raw = await handle.execute(input);
            const delivery = 'result' in raw ? raw : { result: raw };
            return { result: { ...delivery.result, status, failureRef: 'fixture:failed-work' },
              criteria: { satisfied: [], failed: status === 'failed' ? ['failed output'] : [],
                incomplete: status === 'incomplete' ? ['missing output'] : [] } };
          } };
        },
      };
      const call = { ...failureInput, executionAgent: selected };
      const returned = await f.manager.callChild(call);
      assert.equal(returned.state, 'returned');
      if (returned.state === 'returned' && returned.kind === 'execution') assert.equal(returned.result.status, status);
      assert.deepEqual(await f.manager.callChild(call), returned, 'failed/incomplete return never launches an automatic retry');
    }
    assert.equal(f.counts().executions, 4);
  } finally { f.fail(undefined); await f.cleanup(); }
});

// UNKNOWN likelihood; invocation and release can both fail. Losing the first
// owner/error would hide unknown outcome and permit unsafe replay. Cost: one
// public fixture call and same-ID retry, with real pool release/dispose hooks.
test('single call retains unknown invocation and preserves primary error plus acquired lease release failure', async () => {
  const f = await singleCallFixture();
  try {
    const input = await f.execution('unknown-work');
    f.fail('invoke');
    const outcome = await f.manager.callChild(input);
    assert.equal(outcome.state, 'blocked');
    if (outcome.state === 'returned') throw new Error('unknown outcome reported returned');
    assert.equal(outcome.issue.ownerId, 'actual-child-owner');
    assert.equal(outcome.issue.reason, 'controlled child outcome unknown');
    assert.deepEqual(outcome.issue.nextAction, { kind: 'recover', ref: 'retain-child-duty' });
    assert.equal(outcome.releaseIssue?.reason, 'child lease settle failed');
    f.fail(undefined);
    assert.deepEqual(await f.manager.callChild(input), outcome);
    assert.deepEqual(f.counts(), { executions: 1, reviews: 0, releases: 1, disposes: 1 });
    assert.equal(f.pool.inspect().runtimes.some((r) => r.state === 'running'), false);
  } finally { f.fail(undefined); await f.cleanup(); }
});

// CONFIRMED contract mismatch, occurrence probability UNKNOWN. The accepted
// invocation-bound reviewer conflicts with I2's assignment equality. Impact:
// declared milestone cannot commit. Cost: one physical published plan and one
// acquired review in this consumer. Keep the original error; no owner bypass.
test('single call exposes existing I2 incarnation assignment conflict and does not repeat the known review', async () => {
  const f = await singleCallFixture();
  try {
    const workInput = await f.execution('milestone-work');
    const work = await f.manager.callChild(workInput);
    if (work.state !== 'returned' || work.kind !== 'execution') throw new Error(JSON.stringify(work));
    const plans = new JsonlTaskPlanRevisionJournal(f.journal);
    const plan = await plans.append({ scope: f.taskScope, revisionId: 'single-call-plan', sequence: 1, predecessor: null,
      snapshot: { title: 'Bounded output review', summary: 'Review the actual child output',
        completeness: { scope: 'whole-task', status: 'complete' },
        acceptanceCriteria: [{ criterionId: 'bounded-output', description: 'Produced output passes review' }],
        nodes: [{ nodeId: 'single-call-node', kind: 'work', title: 'Bounded output', intent: 'Produce and review', definition: {} }],
        phases: [], relations: [] }, reason: { kind: 'initial', basisRefs: [] },
      source: { requirementId: 'single-call-requirement', inputRevision: 1, draftId: 'single-call-draft',
        draftRevisionVersion: 1, draftRevisionHash: digestOf('single-call-draft'), confirmationRef: 'fixture:confirmed',
        evidenceRefs: work.result.evidenceRefs },
      historyCoverage: 'complete-from-task-start', publishedAt: at(0), publishedBy: 'single-call-fixture-owner' });
    const planCommit = await plans.getCommitRef(f.taskScope, plan.revisionId);
    assert.ok(planCommit);
    const reviewInput = await f.review('milestone-review', workInput.assignment, work.result);
    const input = { ...reviewInput, milestoneReview: { milestoneId: 'bounded-output-milestone',
      cycleId: f.scope.cycleId!, taskScope: f.taskScope, executionScope: f.scope,
      planRevisionCommitRef: planCommit!, reviewerAgentId: reviewInput.agentId } };
    const outcome = await f.manager.callChild(input);
    assert.equal(outcome.state, 'blocked');
    if (outcome.state === 'returned') throw new Error('conflicting I2 identity was accepted');
    assert.equal(outcome.issue.reason, 'selected reviewer incarnation assignment does not match the review assignment');
    assert.deepEqual(await f.manager.callChild(input), outcome);
    assert.deepEqual(f.counts(), { executions: 1, reviews: 1, releases: 2, disposes: 2 });
    assert.equal((await f.journal.replay()).some((r) => r.payload?.kind === I2_JOURNAL_PAYLOAD_KIND), false);
    console.info('I2 compatibility remains INCOMPLETE', JSON.stringify(outcome));
  } finally { await f.cleanup(); }
});

test('actual I2 journal port commits, cold-reads and lists typed definition/occurrence/cycle/review relations from the same Organ Journal', async () => {
  const fixture = await openFixture('happy-');
  try {
    const { organPath, journal } = fixture;
    const port = createJsonlI2JournalPort({ filePath: organPath, journal });
    const coldPort = createJsonlI2JournalPort({ filePath: organPath });
    const taskScope: TaskScope = { organId, taskId: id('task', 'i2-journal-task-a') };

    const definition = definitionRecord({
      taskScope,
      definitionId: 'inspection-a',
      definitionVersion: '1',
      checkIds: ['item-1', 'item-2'],
      createdAt: at(1),
    });
    const definitionRef = await port.commit(definition);
    assert.deepEqual(await coldPort.read(taskScope, definitionRef), definition, 'cold reconstruction must return the exact committed definition');

    // The committed record is a typed control record in the Organ Journal event carrier.
    const storedDefinition = (await journal.replay()).find((record) => record.commitId === definitionRef.commitId);
    assert.equal(storedDefinition?.payload?.['kind'], I2_JOURNAL_PAYLOAD_KIND, 'I2 authority must be a typed Journal record');

    const opened = cycleOpened({ taskScope, cycleId: 'cycle-a', openedAt: at(2) });
    const openedRef = await port.commit(opened);

    const occurrence = occurrenceOpened({
      taskScope,
      occurrenceId: 'occurrence-a',
      cycleId: 'cycle-a',
      definitionId: 'inspection-a',
      definitionVersion: '1',
      definitionCommitRef: definitionRef,
      definitionDigest: definition.definitionDigest,
      cycleOpenedCommitRef: openedRef,
      openedAt: at(3),
    });
    const occurrenceRef = await port.commit(occurrence);

    const itemOne = itemResult({
      taskScope,
      occurrenceId: 'occurrence-a',
      cycleId: 'cycle-a',
      definitionId: 'inspection-a',
      definitionVersion: '1',
      definitionCommitRef: definitionRef,
      definitionDigest: definition.definitionDigest,
      cycleOpenedCommitRef: openedRef,
      checkId: 'item-1',
      resultId: 'result-1',
      completedAt: at(4),
    });
    const itemOneRef = await port.commit(itemOne);
    const itemTwo = itemResult({
      taskScope,
      occurrenceId: 'occurrence-a',
      cycleId: 'cycle-a',
      definitionId: 'inspection-a',
      definitionVersion: '1',
      definitionCommitRef: definitionRef,
      definitionDigest: definition.definitionDigest,
      cycleOpenedCommitRef: openedRef,
      checkId: 'item-2',
      resultId: 'result-2',
      completedAt: at(5),
    });
    const itemTwoRef = await port.commit(itemTwo);

    const settlement = settled({
      taskScope,
      occurrenceId: 'occurrence-a',
      definitionId: 'inspection-a',
      definitionVersion: '1',
      openingCommitRef: occurrenceRef,
      itemResultCommitRefs: [itemOneRef, itemTwoRef],
      settledAt: at(6),
    });
    const settlementRef = await port.commit(settlement);

    const review = reviewResult({
      taskScope,
      milestoneId: 'milestone-a',
      cycleId: 'cycle-a',
      assignmentId: 'assignment-a',
      resultId: 'review-result-a',
      completedAt: at(7),
    });
    // Seed one old physical key through the real Journal append API. The key
    // change must neither rewrite its receipt nor append its identical retry.
    const oldReviewIdentity = {
      kind: review.kind, scope: taskScope, milestoneId: review.milestoneId, cycleId: review.cycleId.value,
    };
    const storedReview = await journal.append({
      commitId: `i2-history:${createHash('sha256').update(canonicalJsonStringify(oldReviewIdentity)).digest('hex')}`,
      kind: 'event', scope: taskScope, payload: { kind: I2_JOURNAL_PAYLOAD_KIND, record: review },
    });
    const reviewRef: JournalCommitRef = {
      commitId: storedReview.commitId!, journalSeq: storedReview.seq, recordDigest: storedReview.recordDigest,
    };

    const alignment = aligned({ milestoneId: 'milestone-a', cycleId: 'cycle-a', reviewCommitRef: reviewRef });
    const alignmentRef = await port.commit(alignment);

    const closure = cycleClosed({
      cycleId: 'cycle-a',
      openedCommitRef: openedRef,
      milestoneAlignmentCommitRefs: [alignmentRef],
      inspectionSettlementCommitRef: settlementRef,
      closedAt: at(8),
    });
    const closureRef = await port.commit(closure);

    // Cold reconstruction returns each committed body exactly.
    assert.deepEqual(await coldPort.read(taskScope, occurrenceRef), occurrence);
    assert.deepEqual(await coldPort.read(taskScope, settlementRef), settlement);
    assert.deepEqual(await coldPort.read(taskScope, reviewRef), review);
    assert.deepEqual(await coldPort.read(taskScope, alignmentRef), alignment);
    assert.deepEqual(await coldPort.read(taskScope, closureRef), closure);

    // Mixed-kind history preserves actual Journal position order.
    const history = await port.list({ taskScope, kinds: ALL_KINDS, limit: 50 });
    assert.deepEqual(
      history.entries.map((entry) => entry.record.kind),
      [
        'inspection-definition',
        'business-cycle-opened',
        'inspection-occurrence-opened',
        'inspection-item-result',
        'inspection-item-result',
        'inspection-occurrence-settled',
        'milestone-review-result',
        'milestone-review-aligned',
        'business-cycle-closed',
      ],
      'list must preserve committed order',
    );
    assert.equal(history.nextCursor, undefined);

    // Independent AND filters.
    const items = await port.list({ taskScope, kinds: ['inspection-item-result'], limit: 50 });
    assert.equal(items.entries.length, 2, 'kind filter must select exactly the item results');
    const inCycle = await port.list({ taskScope, kinds: ALL_KINDS, cycleId: 'cycle-a', limit: 50 });
    assert.deepEqual(
      inCycle.entries.map((entry) => entry.record.kind),
      [
        'business-cycle-opened',
        'inspection-occurrence-opened',
        'inspection-item-result',
        'inspection-item-result',
        'milestone-review-result',
        'milestone-review-aligned',
        'business-cycle-closed',
      ],
    );
    const byDefinition = await port.list({
      taskScope,
      kinds: ALL_KINDS,
      definitionId: 'inspection-a',
      definitionVersion: '1',
      limit: 50,
    });
    assert.deepEqual(
      byDefinition.entries.map((entry) => entry.record.kind),
      [
        'inspection-definition',
        'inspection-occurrence-opened',
        'inspection-item-result',
        'inspection-item-result',
        'inspection-occurrence-settled',
      ],
    );

    // Pagination binds a Journal position to the exact filter identity.
    const firstPage = await port.list({ taskScope, kinds: ALL_KINDS, limit: 4 });
    assert.equal(firstPage.entries.length, 4);
    assert.ok(firstPage.nextCursor !== undefined, 'a partial page must return a cursor');
    const secondPage = await port.list({ taskScope, kinds: ALL_KINDS, cursor: firstPage.nextCursor, limit: 50 });
    assert.deepEqual(
      [...firstPage.entries, ...secondPage.entries].map((entry) => entry.commitRef.commitId),
      history.entries.map((entry) => entry.commitRef.commitId),
      'paginated pages must reconstruct the full ordered history',
    );
    await assert.rejects(
      () => port.list({ taskScope, kinds: ['business-cycle-opened'], cursor: firstPage.nextCursor, limit: 50 }),
      /does not match the requested filter/,
    );

    // S3 physical RED confirms distinct calls collided. Old-receipt retry risk
    // is UNKNOWN; lost attribution or duplicate history is material. Reuse this
    // fixture to check the bounded key change without another suite or matrix.
    const secondReview = reviewResult({
      taskScope, milestoneId: review.milestoneId, cycleId: review.cycleId.value,
      assignmentId: 'assignment-b', resultId: 'review-result-b', completedAt: at(9),
    });
    const secondReviewRef = await port.commit(secondReview);
    assert.ok(secondReviewRef.commitId !== reviewRef.commitId, 'distinct calls for one milestone must have distinct keys');
    assert.deepEqual(await coldPort.read(taskScope, secondReviewRef), secondReview);

    // Idempotent retry returns the exact original receipt without appending.
    const before = (await journal.replay()).length;
    assert.deepEqual(await coldPort.commit(review), reviewRef, 'an old physical call must retain its exact receipt');
    assert.deepEqual(await coldPort.commit(secondReview), secondReviewRef, 'a new physical call must retain its exact receipt');
    await assert.rejects(() => coldPort.commit({
      ...review, delivery: { ...review.delivery, result: { ...review.delivery.result, resultId: 'changed-result' } },
    }), /I2 identity is already committed with different content/);
    await assert.rejects(() => coldPort.commit({
      ...secondReview, delivery: { ...secondReview.delivery, output: { ...secondReview.delivery.output, text: 'changed output' } },
    }), /I2 identity is already committed with different content/);
    assert.deepEqual(await coldPort.read(taskScope, reviewRef), review, 'the old receipt must remain exactly readable');
    const retried = await port.commit(definition);
    assert.deepEqual(retried, definitionRef, 'an identical retry must return the original receipt');
    assert.equal((await journal.replay()).length, before, 'an identical retry must not append');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual I2 journal port rejects a foreign-task reference, an unresolved or tampered receipt and a conflicting re-commit', async () => {
  const fixture = await openFixture('reject-');
  try {
    const { organPath, journal } = fixture;
    const port = createJsonlI2JournalPort({ filePath: organPath, journal });
    const taskScope: TaskScope = { organId, taskId: id('task', 'i2-journal-task-a') };
    const foreignScope: TaskScope = { organId, taskId: id('task', 'i2-journal-task-b') };

    const definition = definitionRecord({
      taskScope,
      definitionId: 'inspection-a',
      definitionVersion: '1',
      checkIds: ['item-1'],
      createdAt: at(1),
    });
    const definitionRef = await port.commit(definition);
    const foreignDefinition = definitionRecord({
      taskScope: foreignScope,
      definitionId: 'inspection-b',
      definitionVersion: '1',
      checkIds: ['item-1'],
      createdAt: at(1),
    });
    const foreignDefinitionRef = await port.commit(foreignDefinition);
    const opened = cycleOpened({ taskScope, cycleId: 'cycle-a', openedAt: at(2) });
    const openedRef = await port.commit(opened);

    // A reference to a definition committed under another task is a wrong binding.
    await assert.rejects(
      () => port.commit(occurrenceOpened({
        taskScope,
        occurrenceId: 'occurrence-a',
        cycleId: 'cycle-a',
        definitionId: 'inspection-b',
        definitionVersion: '1',
        definitionCommitRef: foreignDefinitionRef,
        definitionDigest: foreignDefinition.definitionDigest,
        cycleOpenedCommitRef: openedRef,
        openedAt: at(3),
      })),
      /outside the record task scope/,
    );

    // An unresolved mandatory reference stays explicit.
    await assert.rejects(
      () => port.commit(occurrenceOpened({
        taskScope,
        occurrenceId: 'occurrence-a',
        cycleId: 'cycle-a',
        definitionId: 'inspection-a',
        definitionVersion: '1',
        definitionCommitRef: { commitId: `i2-history:${'a'.repeat(64)}`, journalSeq: 1, recordDigest: `sha256:${'b'.repeat(64)}` },
        definitionDigest: definition.definitionDigest,
        cycleOpenedCommitRef: openedRef,
        openedAt: at(3),
      })),
      /reference is not committed/,
    );

    // A reference whose receipt does not match the committed record is rejected.
    await assert.rejects(
      () => port.commit(occurrenceOpened({
        taskScope,
        occurrenceId: 'occurrence-a',
        cycleId: 'cycle-a',
        definitionId: 'inspection-a',
        definitionVersion: '1',
        definitionCommitRef: { ...definitionRef, journalSeq: definitionRef.journalSeq + 5 },
        definitionDigest: definition.definitionDigest,
        cycleOpenedCommitRef: openedRef,
        openedAt: at(3),
      })),
      /reference receipt does not match/,
    );

    // A tampered read receipt and a cross-task read are rejected.
    await assert.rejects(
      () => port.read(taskScope, { ...definitionRef, journalSeq: definitionRef.journalSeq + 5 }),
      /does not match its receipt/,
    );
    await assert.rejects(
      () => port.read(foreignScope, definitionRef),
      /outside the requested task scope/,
    );
    const foreignHistory = await port.list({ taskScope: foreignScope, kinds: ALL_KINDS, limit: 50 });
    assert.deepEqual(
      foreignHistory.entries.map((entry) => entry.commitRef.commitId),
      [foreignDefinitionRef.commitId],
      'a task-scoped list must not leak another task I2 history',
    );

    // An altered fact under the same identity conflicts explicitly.
    await assert.rejects(
      () => port.commit(definitionRecord({
        taskScope,
        definitionId: 'inspection-a',
        definitionVersion: '1',
        checkIds: ['item-1', 'item-2'],
        createdAt: at(9),
      })),
      /already binds different immutable content/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
