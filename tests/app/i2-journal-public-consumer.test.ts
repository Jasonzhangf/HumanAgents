import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJsonStringify, id } from '../../packages/contracts/src/index.js';
import type {
  ActiveTurnBinding,
  BusinessCycleClosedRecord,
  BusinessCycleOpenedRecord,
  DurableInspectionDefinition,
  I2Record,
  InspectionItemResultRecord,
  InspectionOccurrenceOpenedRecord,
  InspectionOccurrenceSettledRecord,
  I2JournalPort,
  JournalCommitRef,
  MilestoneReviewAlignedRecord,
  MilestoneReviewResultRecord,
  RawAsset,
  ScopeRef,
  TaskRuntimeIncarnation,
  TaskId,
  WorkAssignment,
  WorkResult,
} from '../../packages/contracts/src/index.js';
import { ensureControlLayout, listConfiguredProjects, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { computeInspectionDefinitionDigest } from '../../packages/core/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskPlanRevisionJournal } from '../../packages/adapters/jsonl/src/task-plan-revisions.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { createJsonlI2JournalPort, I2_JOURNAL_PAYLOAD_KIND } from '../../packages/app/src/i2-journal.js';
import { buildFakeExecutionPort, FakeReplayExecutionRuntimePort, UiRuntimeService } from '../../packages/app/src/ui-runtime/index.js';
import { APP_CHILD_CALL_TOOL, APP_CHILD_ADOPT_TOOL, appChildInvocationId, createAppChildProducer } from '../../packages/app/src/ui-runtime/child-producer.js';
import { createUiRuntimeRequestDispatcher } from '../../packages/app/src/ui-runtime/server.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import {
  UiRuntimeJournal,
  uiRuntimeControlJournalPath,
  uiRuntimeJournalPath,
  uiRuntimeModeRoot,
  readUiRuntimeTaskJournal,
} from '../../packages/app/src/ui-runtime/journal.js';
import { createJsonlCheckpointClosurePort } from '../../packages/app/src/checkpoint-journal.js';
import { readTaskAgentActivity } from '../../packages/app/src/ui-runtime/agent-activity-read.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import {
  AgentRuntimePoolManager, OrchestrationError, OrchestrationManager,
  resolveReviewMaterial,
  type ChildCallPort, type IndependentChildCallInput, type ExecutionAgentPort,
  type ReviewAgentPort,
} from '../../packages/runtime/src/orchestration/index.js';
import { createReviewAssignments } from '../../packages/runtime/src/review/index.js';
import { ActiveTurnContext } from '../../packages/runtime/src/context/active-turn-context.js';
import { activeTurnCommitId } from '../../packages/runtime/src/context/active-turn-journal.js';
import { ProviderAgentDriver } from '../../packages/adapters/provider/src/index.js';
const digestOf = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const assignmentGraphFactPayloadType = 'assignment-graph.fact';
import type {
  ProviderSubmitInput,
  ProviderStartInput,
  ProviderObserveInput,
  ProviderEvent,
  ProviderToolCall,
  ExecutionRuntimePort,
} from '../../packages/contracts/src/index.js';
import { createJsonlActiveTurnJournal } from '../../packages/adapters/jsonl/src/active-turn.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { filesystemProviderEvidenceSink } from '../../packages/adapters/provider/src/evidence.js';
import type { StandardTurnEndOwnerPort } from '../../packages/app/src/ui-runtime/standard-turn-control.js';

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
  readonly judgment?: string;
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
      outcome: { status: 'completed', judgment: input.judgment ?? `judgment:${input.checkId}` },
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
    subjectRefs: ['subject:1'],
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
    subjectRefs: ['subject:1'],
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

async function persistNativeMilestoneTurn(input: {
  readonly organPath: string;
  readonly taskScope: TaskScope;
  readonly scope: ScopeRef;
  readonly assignment: WorkAssignment;
  readonly result: WorkResult;
  readonly incarnation: TaskRuntimeIncarnation;
}): Promise<{
  readonly turnId: string;
  readonly invocationCommitId: string;
  readonly deliveryCommitId: string;
}> {
  const turnId = 'native-milestone-turn';
  const journal = new JsonlOrganJournal(input.organPath);
  const active = createJsonlActiveTurnJournal({ journal, turnId });
  const admittedTurn = {
    turnId, workAssignmentRef: input.assignment.assignmentId, taskRef: input.taskScope.taskId,
    scopeRef: input.scope, cycleRef: input.scope.cycleId!, inputRevision: input.assignment.inputRevision,
    directiveRevision: input.assignment.inputRevision, executionEpoch: input.assignment.executionEpoch,
    runtimeBindingRef: input.incarnation.runtimeId, permissionRevision: 'native-milestone-permission',
    admissionEvidenceRefs: [], currentTurnRef: `active-turn://${turnId}`, recoveryStateRef: 'native-milestone-recovery',
  };
  const binding: ActiveTurnBinding = {
    admittedTurn, assignment: input.assignment,
    execution: { runtimeId: input.incarnation.runtimeId, executionEpoch: input.assignment.executionEpoch },
    scope: input.scope,
  };
  const context = await ActiveTurnContext.open({
    journal: active, binding, currentTurnRef: admittedTurn.currentTurnRef,
  });
  const initialInput: RawAsset = {
    ref: { evidenceId: id('evidence', 'native-milestone-input'), kind: 'execution',
      source: 'i2-public-consumer', locator: 'native-milestone-input',
      digest: digestOf('native-milestone-input'), scope: input.scope },
    view: { kind: 'utf8-text' },
  };
  await context.registerInitialInput(initialInput);
  const invocationId = input.assignment.assignmentId;
  await context.openChildInvocation({
    invocationId, childTurnId: `${invocationId}-child`,
    checkpointReceiptRef: 'native-milestone-pre-call',
    binding: { kind: 'execution', assignment: input.assignment },
    incarnation: input.incarnation,
  });
  await context.recordChildReturn({
    kind: 'execution', invocationId, refinedDelivery: initialInput,
    assignment: input.assignment, result: input.result,
  });
  const invocationCommitId = activeTurnCommitId(turnId, `invocation:${invocationId}`);
  const deliveryCommitId = activeTurnCommitId(turnId, `delivery:${invocationId}`);
  const committed = (await journal.replay()).flatMap((record) => (
    record.commitId === undefined ? [] : [record.commitId]
  ));
  assert.ok(committed.includes(invocationCommitId));
  assert.ok(committed.includes(deliveryCommitId));
  await createJsonlCheckpointClosurePort({ filePath: input.organPath, journal }).commit({
    closureKind: 'turn-closure', closureId: `turn-closure:${turnId}`,
    identity: {
      turnId, workAssignmentRef: input.assignment.assignmentId, taskRef: input.taskScope.taskId,
      scopeRef: input.scope, cycleRef: input.scope.cycleId!,
      inputRevision: input.assignment.inputRevision, directiveRevision: input.assignment.inputRevision,
      executionEpoch: input.assignment.executionEpoch,
      runtimeBindingRef: input.incarnation.runtimeId,
      permissionRevision: admittedTurn.permissionRevision,
    },
    checkpointId: id('checkpoint', 'native-milestone-close'),
    closureRef: `turn-closure:${turnId}:1`,
    recoveryStateRef: initialInput.ref,
    summary: {
      goal: { text: input.assignment.objective, evidenceRefs: [initialInput.ref] },
      actions: { text: 'persisted the native child call', evidenceRefs: [initialInput.ref] },
      result: { text: input.result.summary, evidenceRefs: [initialInput.ref] },
      expectedNextStep: { text: 'read the actual execution graph', evidenceRefs: [initialInput.ref] },
    },
    closedAt: at(2),
  });
  return { turnId, invocationCommitId, deliveryCommitId };
}

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
    requiredCapabilities: ['execute'], mergeGate: 'not-required',
  };
  const assignment = { ...work };
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
            producedArtifactRefs: ['child-output'], producedArtifactBodies: [output],
            status: 'succeeded', summary: 'bounded output produced', outputRefs: ['child-output'],
            evidenceRefs: [ref('child-output')], nextAction: 'review' };
          return { result, criteria: { satisfied: assignment.successCriteria, failed: [], incomplete: [] } };
        },
      };
    },
  };
  // The registered parent invocation is a separate identity from the
  // subject-bound review assignment. The creator binds the former from the
  // registered call it was handed, never from `incarnation.assignmentId`.
  const seenRequestInvocations: (string | undefined)[] = [];
  const makeReviewAgent = (registeredInvocation: string): ReviewAgentPort => ({
    roleId: 'review',
    async review() { throw new Error('direct/root review callback must never run'); },
    createInstance(create) {
      seenRequestInvocations.push(create.assignment.invocationId);
      return { incarnation: create.incarnation, release, dispose,
        async review(input) {
          reviews += 1;
          const records = await journal.replay();
          assert.ok(records.some((item) => item.commitId === `fixture-checkpoint:${registeredInvocation}`));
          assert.ok(records.some((item) => item.commitId === `fixture-association:${registeredInvocation}`));
          assert.equal(input.reviewMaterial.subjects[0]!.body, await readFile(join(root, 'child-output.txt'), 'utf8'));
          const url = process.env.HUMANAGENT_SINGLE_CALL_HTTP;
          if (url) {
            assert.equal(create.assignment.invocationId, registeredInvocation,
              'review request must carry the registered parent invocation, not the review assignment');
            const response = await fetch(url, { method: 'POST', signal: input.signal,
              body: JSON.stringify({ kind: 'review', invocationId: registeredInvocation,
                reviewAssignmentId: input.reviewAssignment.assignmentId,
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
  });
  const reviewAgent: ReviewAgentPort = {
    roleId: 'review',
    async review() { throw new Error('direct/root review callback must never run'); },
    createInstance() { throw new Error('single-call fixture never dispatches a root reviewer'); },
  };
  const manager = new OrchestrationManager({ ownerId: 'single-call-manager',
    runtimePool: pool, executionAgent, reviewAgent,
    reviewJournal: createJsonlI2JournalPort({ filePath: join(root, 'organ.jsonl'), journal }) });
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
    ...await common(key), agentId: 'configured-reviewer', kind: 'review', reviewAgent: makeReviewAgent(key),
    input: { scope, workerAssignment, workerResult,
      reviewAssignment: createReviewAssignments({ workerAssignment, workerResult, reviewKinds: ['quality'],
        subjectRefs: workerAssignment.targetRefs })[0]!,
      reviewMaterial: resolveReviewMaterial({ workerAssignment, workerResult, subjects: [{ ref: 'child-output', body }] }),
    },
  });
  return { root, journal, pool, manager, execution, review, taskScope, scope,
    seenRequestInvocations: () => [...seenRequestInvocations],
    counts: () => ({ executions, reviews, releases, disposes }), fail: (value: typeof failure) => { failure = value; },
    async cleanup() { const disposed = await pool.dispose(); assert.equal(disposed.status, 'disposed'); await rm(root, { recursive: true, force: true }); },
  };
}

// Concurrent child work exceeds the single real pool slot. The missing typed
// error aborts the active parent turn instead of permitting a fresh model call.
// Cost: one bounded case using the existing manager/Journal/assets fixture.
test('capacity wait continues the active driver turn with a fresh model call after sibling release and adopts both results', async () => {
  const f = await singleCallFixture();
  try {
    const first = await f.execution('capacity-sibling');

    const root = await mkdtemp(join(await (async () => {
      const base = process.env.HUMANAGENT_SINGLE_CALL_FIXTURE_ROOT
        ?? '/Users/fanzhang/.humanagent/test-fixtures/ux-i0-single-call-20261013';
      await mkdir(base, { recursive: true });
      return base;
    })(), 'capacity-driver-'));
    try {
      const taskScope: TaskScope = { organId, taskId: id('task', 'capacity-driver-task') };
      const scope: ScopeRef = { ...taskScope, cycleId: id('cycle', 'capacity-driver-cycle') };
      const assignment: WorkAssignment = {
        ...first.assignment,
        assignmentId: 'capacity-parent',
        taskId: taskScope.taskId,
      };
      const execution = { runtimeId: 'capacity-parent-runtime', taskId: taskScope.taskId,
        operationId: id('operation', 'capacity-parent-operation'), executionEpoch: 1 };
      const evidence = { evidenceId: id('evidence', 'capacity-sibling-output'), kind: 'execution' as const,
        source: 'capacity-public-consumer', locator: 'capacity-sibling-output', scope };
      const admittedTurn = {
        turnId: 'capacity-parent-turn', workAssignmentRef: assignment.assignmentId, taskRef: taskScope.taskId,
        scopeRef: scope, cycleRef: scope.cycleId!, inputRevision: 1, directiveRevision: 1,
        executionEpoch: 1, runtimeBindingRef: 'capacity-parent-binding', permissionRevision: 'capacity-parent-permission',
        admissionEvidenceRefs: ['capacity-admission'], currentTurnRef: 'active-turn://capacity-parent-turn',
        recoveryStateRef: 'capacity-recovery',
      };
      const activeJournal = createJsonlActiveTurnJournal({ filePath: join(root, 'organ.jsonl'), turnId: admittedTurn.turnId });
      const parent = await ActiveTurnContext.open({ journal: activeJournal, currentTurnRef: admittedTurn.currentTurnRef,
        binding: { admittedTurn, assignment, execution, scope } });
      const assets = new ImmutableAssetStore(join(root, 'assets'));
      const preCalls: string[] = [];
      let childExecutions = 0;
      const childDeliveryRefs: string[] = [];
      const childDeliveries = new Map<string, typeof evidence>();
      const producer = createAppChildProducer({
        manager: f.manager,
        parent,
        parentAssignment: assignment,
        checkpoints: {
          async pre(input) {
            preCalls.push(input.call.invocationId);
            const checkpointId = id('checkpoint', `capacity-pre-${input.call.invocationId.replace(/[^A-Za-z0-9._-]/g, '-')}`);
            const commitRef = { commitId: checkpointId.value, journalSeq: 1, recordDigest: digestOf(checkpointId.value) };
            return { commitRef,
              checkpoint: { id: checkpointId, scope: input.selected.scope, cycleId: input.selected.scope.cycleId!,
                seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 1, outcome: 'waiting',
                summary: 'capacity pre-call checkpoint', recoveryStateRef: evidence, evidenceRefs: [evidence],
                next: { kind: 'wait', ref: checkpointId.value } }, previous: null };
          },
          async post(input) {
            const checkpointId = id('checkpoint', `capacity-post-${input.returned.invocationId.replace(/[^A-Za-z0-9._-]/g, '-')}`);
            const commitRef = { commitId: checkpointId.value, journalSeq: 1, recordDigest: digestOf(checkpointId.value) };
            return { commitRef,
              checkpoint: { id: checkpointId, scope: input.returned.scope, cycleId: input.returned.scope.cycleId!,
                seq: 1, previousCheckpointId: null, directiveRevision: 1, executionEpoch: 1, outcome: 'succeeded',
                summary: 'capacity post-call checkpoint', recoveryStateRef: evidence, evidenceRefs: [evidence],
                next: { kind: 'continue', ref: checkpointId.value } }, previous: null };
          },
        },
        refinedDeliveryStore: {
          async store(input) {
            const reference = await assets.write(`capacity-refined-${input.invocationId.replace(/[^A-Za-z0-9._-]/g, '-')}`, input.bytes);
            return { ref: { evidenceId: id('evidence', reference.assetId), kind: 'operation', source: 'capacity-public-consumer',
              locator: reference.locator, digest: reference.digest, scope: input.scope }, view: { kind: 'utf8-text' } };
          },
          async read(asset) {
            if (asset.ref.digest === undefined) throw new Error('capacity refined asset requires its digest');
            return assets.readByDigest(asset.ref.evidenceId.value, asset.ref.digest);
          },
        },
        bodyAssets: {
          target(input) { return `capacity-child/${input.invocationId}/${input.kind}`; },
          async write(input) {
            const assetId = `capacity-body-${input.invocationId.replace(/[^A-Za-z0-9._-]/g, '-')}-${input.kind}`;
            const reference = await assets.write(assetId, new TextEncoder().encode(input.body));
            const ref = { evidenceId: id('evidence', assetId), kind: 'execution' as const, source: 'capacity-public-consumer',
              locator: reference.locator, digest: reference.digest, scope: input.scope };
            childDeliveries.set(reference.locator, ref);
            childDeliveryRefs.splice(0, childDeliveryRefs.length, reference.locator);
            return { ref, view: { kind: 'utf8-text' } };
          },
          async read(asset) {
            if (asset.ref.digest === undefined) throw new Error('capacity body asset requires its digest');
            return assets.readByDigest(asset.ref.evidenceId.value, asset.ref.digest);
          },
        },
        bindChildRun: async ({ incarnation, scope: childScope, request }) => {
          const childAssignment = request.kind === 'execution' ? request.input.assignment : request.input.workerAssignment;
          const standardEndOwner: StandardTurnEndOwnerPort = {
            async resolveBoundTurn() { return { turnId: `capacity-child-${incarnation.agentInstanceId}`, workAssignmentRef: childAssignment.assignmentId,
              taskRef: childAssignment.taskId, scopeRef: childScope, cycleRef: childScope.cycleId!, inputRevision: childAssignment.inputRevision,
              directiveRevision: childAssignment.inputRevision, executionEpoch: childAssignment.executionEpoch,
              runtimeBindingRef: 'capacity-child-binding', permissionRevision: 'capacity-child-permission' }; },
            async resolveDelivery({ deliveryRefs }) { return deliveryRefs.map((ref) => {
              const resolved = childDeliveries.get(ref);
              if (!resolved) throw new Error(`unknown child delivery ${ref}`);
              return resolved;
            }); },
          };
          return {
            native: {
              rawEvidence: filesystemProviderEvidenceSink(assets),
              acceptRawFact: async (envelope) => ({ seq: 1, envelope }),
              registerRequest: async (registration) => registration.record,
              requestContext: async () => ({ canonical: { units: [] } }),
            },
            toolDefinitions: [],
            toolExecution: { async execute() { throw new Error('capacity child has no business tools'); } },
            standardEndOwner,
            control: { async accept() {}, async running() {}, async settle() {} },
          };
        },
        prepareAgentProvider: async (selection) => ({
          configuredAgentId: selection.configuredAgentId, roleId: selection.roleId, source: 'http' as const,
          provider: { source: 'http', provider: 'http', binding: 'capacity-child', protocol: 'responses',
            model: 'capacity-child-model', route: 'default', baseUrl: 'http://127.0.0.1:9' },
          binding: { bindingId: 'capacity-child', providerId: 'http', protocol: 'responses', endpointRef: 'http:127.0.0.1:9',
            modelRef: 'capacity-child-model', configDigest: digestOf('capacity-child-config'), capabilityDigest: digestOf('capacity-child-capability') },
          port: new FakeReplayExecutionRuntimePort({
            binding: { bindingId: 'capacity-child', providerId: 'http', protocol: 'responses', endpointRef: 'http:127.0.0.1:9',
              modelRef: 'capacity-child-model', configDigest: digestOf('capacity-child-config'), capabilityDigest: digestOf('capacity-child-capability') },
            stepDelayMs: 0,
            replay: [
              { kind: 'tool', state: 'tool', summary: 'child delivery', toolPhase: 'invoke', toolCall: {
                callId: `deliver-${++childExecutions}`, toolId: 'humanagent_child_deliver',
                arguments: { body: 'capacity child output', evidenceRefs: [] }, continuationRef: 'child-delivery' } },
              { kind: 'terminal', state: 'waiting', summary: 'delivery round', terminalState: 'waiting', nextAction: { kind: 'continue', ref: 'child-delivery' } },
              { kind: 'tool', state: 'tool', summary: 'child standard end', toolPhase: 'invoke', toolCall: {
                callId: 'child-end', toolId: 'humanagent_turn_end', arguments: {
                  summary: Object.fromEntries(['goal', 'actions', 'result', 'expectedNextStep'].map((key) => [key, { text: 'bounded child output', evidenceRefs: [] }])),
                  deliveryRefs: childDeliveryRefs,
                }, continuationRef: 'child-end' } },
              { kind: 'terminal', state: 'waiting', summary: 'child end round', terminalState: 'waiting', nextAction: { kind: 'continue', ref: 'child-end' } },
              { kind: 'terminal', state: 'succeeded', summary: 'child ended', terminalState: 'succeeded' },
            ],
          }),
        }),
        roster: [{ agentId: 'configured-worker', roleId: 'execution' }],
        admitChildOperation: async (input) => {
          const registration = await f.journal.append({ commitId: `capacity-business:${input.invocationId}`, kind: 'event', scope: input.scope,
            payload: { kind: 'single-call-fixture-business', invocationId: input.invocationId } });
          const commit = { commitId: registration.commitId!, journalSeq: registration.seq, recordDigest: registration.recordDigest };
          return { authority: {} as never, authorityCommitRef: commit, businessRegistrationCommitRef: commit,
            coverageCommitRef: commit, childAdmission: { authorityCommitRef: commit, businessRegistrationCommitRef: commit, coverageCommitRef: commit },
            intent: {} as never, registration: {} as never };
        },
      });
      const childCallArguments = { purpose: 'wait for capacity', agentId: 'configured-worker', kind: 'execution',
        instructions: 'produce bounded output', successCriteria: ['produce output'], target: 'capacity-output' };
      const outcomes: Awaited<ReturnType<typeof producer.execute>>[] = [];
      const requests: (ProviderStartInput | ProviderSubmitInput)[] = [];
      const binding = { bindingId: 'capacity-parent', providerId: 'http', protocol: 'responses' as const,
        endpointRef: 'fake://capacity-parent', modelRef: 'capacity-model',
        configDigest: digestOf('capacity-parent-config'), capabilityDigest: digestOf('capacity-parent-capabilities') };
      const returnedIds: string[] = [];
      let waitingId = '';
      class ParentModel extends FakeReplayExecutionRuntimePort {
        override async start(input: ProviderStartInput) {
          requests.push(input);
          return super.start(input);
        }
        override async submit(input: ProviderSubmitInput) {
          requests.push(input);
          return super.submit(input);
        }
        override async *observe(input: ProviderObserveInput): AsyncIterable<ProviderEvent> {
          const round = requests.length;
          const call = (callId: string, toolId: string, args: ProviderToolCall['arguments']): ProviderToolCall =>
            ({ callId, toolId, arguments: args, continuationRef: `capacity-round-${round}` });
          const calls = round === 1
            ? [call('capacity-sibling-call', 'child.call', childCallArguments), call('capacity-wait-call', 'child.call', childCallArguments)]
            : round === 2
              ? [call('adopt-sibling', 'child.adopt', { invocationId: returnedIds[0]! }), call('capacity-fresh-call', 'child.call', childCallArguments)]
              : round === 3 ? [call('adopt-fresh', 'child.adopt', { invocationId: returnedIds[1]! })] : [];
          assert.ok(round <= 4, 'no automatic retry or extra model round');
          for (const toolCall of calls) yield { ...input, eventId: `${round}:${toolCall.callId}`, kind: 'tool',
            toolPhase: 'invoke', toolCall, evidenceRefs: [evidence] };
          yield { ...input, eventId: `${round}:terminal`, kind: 'terminal', terminalState: calls.length ? 'waiting' : 'succeeded',
            ...(calls.length ? { nextAction: { kind: 'continue' as const, ref: `capacity-round-${round}` } } : {}), evidenceRefs: [evidence] };
        }
      }
      const driver = new ProviderAgentDriver({ port: new ParentModel({ binding, stepDelayMs: 0 }), binding,
        ...execution, assignmentId: assignment.assignmentId, scope, inputRefs: [], tools: [APP_CHILD_CALL_TOOL, APP_CHILD_ADOPT_TOOL],
        executeTool: { canRunConcurrently: producer.canRunConcurrently, async execute(input) {
          const result = await producer.execute(input);
          outcomes.push(result);
          const output = JSON.parse(result.output) as { state: string; invocationId: string };
          if (output.state === 'returned') returnedIds.push(output.invocationId);
          if (output.state === 'waiting') waitingId = output.invocationId;
          return result;
        } },
      });
      await driver.start({ ...execution, assignmentId: assignment.assignmentId, organId, cycleId: scope.cycleId });
      await driver.submit({ taskId: taskScope.taskId, executionEpoch: 1, assignmentId: assignment.assignmentId,
        payload: { instructions: 'call two children; adopt the sibling and make a fresh call after capacity wait' } });
      const events = [];
      let driverError: unknown;
      try { for await (const event of driver.observe({ runtimeId: execution.runtimeId })) events.push(event); }
      catch (error) { driverError = error; }
      const waitingOutput = outcomes.find((result) => (JSON.parse(result.output) as { state: string }).state === 'waiting');
      const siblingOutput = outcomes.find((result) => (JSON.parse(result.output) as { state: string }).state === 'returned');
      assert.ok(waitingOutput, JSON.stringify({ outcomes, driverError: String(driverError) }));
      assert.ok(siblingOutput, JSON.stringify({ outcomes, driverError: String(driverError) }));
      if (waitingOutput === undefined || siblingOutput === undefined) throw new Error(JSON.stringify(outcomes));
      assert.equal(waitingOutput.status, 'blocked');
      assert.ok(waitingOutput.error, 'capacity wait must preserve its typed owner error for Driver continuation');
      // The manager explicitly supplies its ownerId to pool.acquire; preserve
      // that actual typed issue owner rather than the pool's default owner.
      assert.equal(waitingOutput.error?.ownerId, 'single-call-manager');
      assert.equal(waitingOutput.error?.retryable, 'retryable');
      assert.equal(waitingOutput.error?.attention, 'background');
      assert.deepEqual(waitingOutput.error?.nextAction, { kind: 'wait', ref: 'orchestration.runtime.max' });
      assert.ok((waitingOutput.error?.evidenceRefs.length ?? 0) > 0);
      assert.equal(siblingOutput.status, 'succeeded');
      assert.equal(driverError, undefined);
      assert.equal(childExecutions, 2);
      assert.equal(requests.length, 4);
      assert.equal(new Set(requests.map((request) => request.turnId)).size, 1, 'same active Driver turn');
      assert.equal(new Set(requests.map((request) => request.requestId)).size, 4, 'fresh Provider requests');
      assert.equal(returnedIds[1], appChildInvocationId({ turnId: admittedTurn.turnId, parentExecution: execution,
        providerRequestId: requests[1]!.requestId!, toolCallId: 'capacity-fresh-call' }));
      const roundTwo = (requests[1]! as ProviderSubmitInput).toolContinuations!;
      assert.equal(roundTwo.length, 2);
      assert.deepEqual(roundTwo.map((item) => (JSON.parse(item.output) as { state: string }).state).sort(), ['returned', 'waiting']);
      assert.equal(new Set(returnedIds).size, 2);
      assert.ok(returnedIds.every((invocationId) => invocationId !== waitingId));
      assert.equal(parent.childInvocations().length, 2);
      assert.ok(parent.childInvocations().every((record) => record.adoptedResultSeq !== undefined));
      assert.equal(parent.childInvocations().some((record) => record.invocationId === waitingId), false);
      assert.equal(preCalls.includes(waitingId), false);
      assert.deepEqual(preCalls, returnedIds);
      assert.equal(events.at(-1)?.terminalState, 'succeeded');
      assert.ok(outcomes.filter((outcome) => JSON.parse(outcome.output).state === 'returned')
        .every((outcome) => JSON.parse(outcome.output).summary === 'capacity child output'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally { f.fail(undefined); await f.cleanup(); }
});

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
    const reviewAssignmentId = firstInput.input.reviewAssignment.assignmentId;
    assert.equal(first.invocationId, 'review-call:first');
    assert.equal(second.invocationId, 'review-call:second');
    assert.ok(first.incarnation.agentInstanceId !== second.incarnation.agentInstanceId);
    // Two registered invocations share one real subject-bound review assignment
    // but are two genuine reviewer incarnations bound to that assignment.
    assert.equal(first.incarnation.assignmentId, reviewAssignmentId);
    assert.equal(second.incarnation.assignmentId, reviewAssignmentId);
    assert.equal(first.delivery.reviewer.assignmentId, reviewAssignmentId);
    assert.equal(second.delivery.reviewer.assignmentId, reviewAssignmentId);
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
    assert.deepEqual(f.seenRequestInvocations(), ['review-call:first', 'review-call:second'],
      'each review request carries its own registered parent invocation, not the review assignment');
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

// A declared milestone review now commits a real I2 receipt. The registered
// parent invocation and the subject-bound review assignment stay separate
// identities, and two registered invocations produce two genuine reviewer
// incarnations with distinct receipts. The physical return fault proves the
// receipt survives and the same registered call recovers it without replay.
test('declared milestone review commits a real I2 receipt per registered invocation and never repeats a known review', async () => {
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
    const binding = { milestoneId: 'bounded-output-milestone',
      cycleId: f.scope.cycleId!, taskScope: f.taskScope, executionScope: f.scope,
      planRevisionCommitRef: planCommit! };
    const reviewInput = await f.review('milestone-review', workInput.assignment, work.result);
    const input = { ...reviewInput, milestoneReview: { ...binding, reviewerAgentId: reviewInput.agentId } };
    const reviewAssignmentId = reviewInput.input.reviewAssignment.assignmentId;

    // I2 is committed before the parent return. A refused return must keep the
    // receipt and let the same registered call recover it without another call.
    f.fail('return');
    const interrupted = await f.manager.callChild(input);
    assert.equal(interrupted.state, 'blocked');
    if (interrupted.state === 'returned') throw new Error('a refused parent return reported returned');
    f.fail(undefined);
    const first = await f.manager.callChild(input);
    assert.equal(first.state, 'returned', JSON.stringify(first));
    if (first.state !== 'returned' || first.kind !== 'review') throw new Error(JSON.stringify(first));
    const firstRef = first.reviewCommitRef;
    if (!firstRef) throw new Error('declared milestone must carry its real I2 receipt');
    assert.equal(first.invocationId, 'milestone-review');
    assert.equal(first.incarnation.assignmentId, reviewAssignmentId, 'reviewer incarnation binds the real review assignment');
    assert.equal(first.delivery.reviewer.assignmentId, reviewAssignmentId);

    const i2Port = createJsonlI2JournalPort({ filePath: join(f.root, 'organ.jsonl'), journal: f.journal });
    const committed = await i2Port.read(f.taskScope, firstRef);
    assert.equal(committed.kind, 'milestone-review-result');
    if (committed.kind !== 'milestone-review-result') throw new Error(JSON.stringify(committed));
    assert.equal(committed.reviewAssignment.assignmentId, reviewAssignmentId);
    assert.equal(committed.delivery.reviewer.assignmentId, reviewAssignmentId);
    assert.equal(committed.delivery.reviewer.agentInstanceId, first.incarnation.agentInstanceId);
    assert.equal(committed.milestoneId, 'bounded-output-milestone');
    assert.equal(committed.planRevisionCommitRef.commitId, planCommit!.commitId);

    // A second registered invocation reviews the same real subject. It must be
    // a genuine second incarnation with its own distinct durable receipt.
    const reviewInput2 = await f.review('milestone-review-2', workInput.assignment, work.result);
    const input2 = { ...reviewInput2, milestoneReview: { ...binding, reviewerAgentId: reviewInput2.agentId } };
    const second = await f.manager.callChild(input2);
    assert.equal(second.state, 'returned', JSON.stringify(second));
    if (second.state !== 'returned' || second.kind !== 'review') throw new Error(JSON.stringify(second));
    const secondRef = second.reviewCommitRef;
    if (!secondRef) throw new Error('the second registered invocation must carry its real I2 receipt');
    assert.equal(second.invocationId, 'milestone-review-2');
    assert.equal(second.incarnation.assignmentId, reviewAssignmentId);
    assert.ok(second.incarnation.agentInstanceId !== first.incarnation.agentInstanceId, 'two invocations are two real reviewer incarnations');
    assert.ok(secondRef.commitId !== firstRef.commitId, 'two invocations have distinct receipts');
    const secondRecord = await i2Port.read(f.taskScope, secondRef);
    assert.equal(secondRecord.kind, 'milestone-review-result');
    if (secondRecord.kind !== 'milestone-review-result') throw new Error(JSON.stringify(secondRecord));
    assert.equal(secondRecord.delivery.reviewer.agentInstanceId, second.incarnation.agentInstanceId);
    assert.equal(secondRecord.reviewAssignment.assignmentId, reviewAssignmentId);

    // Same-call retry of a known return never re-acquires, re-invokes, or appends.
    const before = (await f.journal.replay()).length;
    assert.deepEqual(await f.manager.callChild(input), first);
    assert.deepEqual(await f.manager.callChild(input2), second);
    assert.equal((await f.journal.replay()).length, before, 'a known-return retry must not append I2 history');
    assert.deepEqual(f.counts(), { executions: 1, reviews: 2, releases: 3, disposes: 3 });
    const receipts = (await f.journal.replay()).filter((r) => r.payload?.kind === I2_JOURNAL_PAYLOAD_KIND);
    assert.equal(receipts.length, 2, 'each registered invocation commits exactly one I2 receipt');
    assert.deepEqual(f.seenRequestInvocations(), ['milestone-review', 'milestone-review-2'],
      'each declared review request carries its own registered parent invocation');

    // The default native path records the real child call as an active-turn
    // invocation and accepted delivery in the same Organ Journal. Read the
    // actual execution graph back from a cold Journal handle and prove the
    // native child/review evidence exists with zero classic AssignmentGraph
    // facts, and that the read itself never appends.
    const native = await persistNativeMilestoneTurn({
      organPath: join(f.root, 'organ.jsonl'), taskScope: f.taskScope, scope: f.scope,
      assignment: workInput.assignment, result: work.result, incarnation: work.incarnation,
    });
    const coldJournal = new JsonlOrganJournal(join(f.root, 'organ.jsonl'));
    const beforeRead = (await coldJournal.replay()).length;
    const graphRead = await readTaskAgentActivity({
      taskId: f.taskScope.taskId, query: { taskId: f.taskScope.taskId },
      taskJournal: readUiRuntimeTaskJournal(join(f.root, 'checkpoints'), 'rcc'),
      controlJournal: coldJournal,
      i2Journal: createJsonlI2JournalPort({ filePath: join(f.root, 'organ.jsonl') }),
    });
    assert.equal(graphRead.ok, true);
    if (!graphRead.ok) throw new Error(JSON.stringify(graphRead.failure));
    const graph = graphRead.value.actualExecutionGraph;
    if (graph === undefined) throw new Error('a successful native read must carry the actual execution graph');
    assert.equal(graph.history.status, 'recorded');
    if (graph.history.status !== 'recorded') throw new Error(JSON.stringify(graph.history));
    const nodes = graph.history.groups.flatMap((group) => group.nodes);
    const kinds = nodes.map((node) => node.kind);
    assert.ok(kinds.includes('active-turn'), 'the admitted native turn must be a node');
    assert.ok(kinds.includes('child-invocation'), 'the real child invocation must be a node');
    assert.ok(kinds.includes('milestone-review'), 'the real milestone review must be a node');
    assert.equal(kinds.includes('orphan-child-delivery'), false, 'the recorded delivery joined its invocation');
    const childNode = nodes.find((node) => node.kind === 'child-invocation');
    assert.equal(childNode?.technical.assignmentId, workInput.assignment.assignmentId);
    assert.equal(childNode?.technical.invocationId, workInput.call.invocationId);
    assert.equal(childNode?.technical.containingLocationKind, 'active-turn');
    assert.equal(childNode?.technical.containingLocationBusinessTurnId, native.turnId);
    assert.equal(childNode?.summary.objective, workInput.assignment.objective);
    assert.equal(childNode?.summary.stateLabel, '已完成（历史）');
    assert.equal(childNode?.summary.resultSummary, work.result.summary);
    assert.ok(childNode?.technical.commitRefs.some((ref) => ref.commitId === native.invocationCommitId));
    assert.match(childNode?.technical.message ?? '', new RegExp(native.deliveryCommitId));
    const reviewNode = nodes.find((node) => node.kind === 'milestone-review');
    assert.ok(reviewNode?.technical.commitRefs.some((ref) => ref.commitId === firstRef.commitId));
    assert.equal(reviewNode?.summary.stateLabel, '复核通过（历史）');
    assert.equal(reviewNode?.summary.resultSummary, '未发现问题');
    assert.equal(reviewNode?.summary.objective, workInput.assignment.objective);
    const readBack = await coldJournal.replay();
    assert.equal(readBack.filter((record) => record.payload?.type === assignmentGraphFactPayloadType).length, 0,
      'the native graph read must not depend on classic AssignmentGraph facts');
    assert.deepEqual(f.manager.graph.snapshot(), { stages: [], assignments: [] },
      'the single native call path must not run classic graph dispatch');
    assert.equal(readBack.length, beforeRead, 'reading the graph must not append Journal facts');
    console.info('declared milestone receipts', JSON.stringify({ first: firstRef, second: secondRef }));
  } finally { f.fail(undefined); await f.cleanup(); }
});

// The dispatch review loop accumulates durable receipts. When a later review's
// durable commit fails, the already-committed receipt must still be returned, or
// the caller loses durable facts and closes the wrong way. The reviewer lease is
// still released. Cost: one controlled durable-step failure on an existing port.
test('dispatch keeps the already-committed milestone receipt when a later review fails its durable step', async () => {
  const base = process.env.HUMANAGENT_SINGLE_CALL_FIXTURE_ROOT
    ?? '/Users/fanzhang/.humanagent/test-fixtures/ux-i0-single-call-20261013';
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'dispatch-'));
  const journal = new JsonlOrganJournal(join(root, 'organ.jsonl'));
  const taskScope: TaskScope = { organId, taskId: id('task', 'dispatch-milestone-task') };
  const scope: ScopeRef = { ...taskScope, cycleId: id('cycle', 'dispatch-milestone-cycle') };
  const body = 'durable dispatch review body';
  const work: WorkAssignment = { assignmentId: 'dispatch-milestone-work', taskId: taskScope.taskId,
    pipelineNodeId: 'dispatch-milestone-node', attempt: 1, executionEpoch: 1, inputRevision: 1,
    objective: 'produce bounded output', targetRefs: ['child-output'], expectedOutputRefs: ['child-output'],
    successCriteria: ['produced exact output'], failureCriteria: ['failed output'], incompleteCriteria: ['missing output'],
    requiredCapabilities: ['execute'], mergeGate: 'not-required' };
  const assignment = work;
  const ref = (label: string) => ({ evidenceId: id('evidence', label), kind: 'execution' as const,
    source: 'dispatch-public-consumer', locator: label, scope });
  const result: WorkResult = { taskId: taskScope.taskId, pipelineNodeId: assignment.pipelineNodeId, agentId: 'dispatch-worker',
    assignmentId: assignment.assignmentId, attempt: 1, executionEpoch: 1, inputRevision: 1,
    producedArtifactRefs: ['child-output'], producedArtifactBodies: [body],
    status: 'succeeded', summary: 'bounded output produced', outputRefs: ['child-output'],
    evidenceRefs: [ref('worker-output')], nextAction: 'review' };
  // The dispatch execution lease is still held while the review loop runs, so
  // the durable reviewers need a second pool slot; every runtime advertises the
  // full capability set so the second review reuses the spawned slot.
  const runtimeCapabilities = ['execute', 'quality.review', 'security.review'];
  const pool = new AgentRuntimePoolManager({ maxRuntimes: 2, ownerId: 'dispatch-pool',
    initialRuntimes: [{ runtimeId: 'dispatch-runtime', capabilities: runtimeCapabilities }],
    factory: { async start(input) { return { runtimeId: input.runtimeId, generation: input.generation, capabilities: runtimeCapabilities }; },
      async dispose() {} } });
  const executionAgent: ExecutionAgentPort = { roleId: 'execution',
    async execute() { throw new Error('root execution callback must never run'); },
    createInstance(create) {
      return { incarnation: create.incarnation, async dispose() {},
        async execute() { return { result, criteria: { satisfied: assignment.successCriteria, failed: [], incomplete: [] } }; } };
    } };
  const reviewAgent: ReviewAgentPort = { roleId: 'review',
    async review() { throw new Error('root review callback must never run'); },
    createInstance(create) {
      return { incarnation: create.incarnation, async dispose() {},
        async review(input) {
          return { result: { ...input.reviewAssignment, resultId: `result:${create.incarnation.agentInstanceId}`,
            status: 'passed', findings: [], evidenceRefs: [ref('review-output')] },
            output: { text: 'independent review passed', artifactRef: null, artifactDigest: null }, completedAt: at(1) };
        } };
    } };
  const realI2 = createJsonlI2JournalPort({ filePath: join(root, 'organ.jsonl'), journal });
  let milestoneCommits = 0;
  const reviewJournal: I2JournalPort = { ...realI2,
    async commit(record) {
      if (record.kind === 'milestone-review-result') {
        milestoneCommits += 1;
        if (milestoneCommits === 2) throw new Error('second durable review commit refused');
      }
      return realI2.commit(record);
    } };
  const manager = new OrchestrationManager({ ownerId: 'dispatch-manager',
    runtimePool: pool, executionAgent, reviewAgent, reviewJournal });
  try {
    manager.planStage({ nodeId: 'dispatch-milestone-node', taskId: taskScope.taskId });
    const dispatched = await manager.dispatch({ stageNodeId: 'dispatch-milestone-node', assignment, agentId: 'dispatch-worker',
      scope, reviewKinds: ['quality', 'security'],
      reviewSubjects: [{ ref: 'child-output', body }],
      milestoneReview: { milestoneId: 'dispatch-milestone', cycleId: scope.cycleId!, taskScope,
        executionScope: scope, planRevisionCommitRef: externalRef('dispatch-plan'), reviewerAgentId: 'dispatch-reviewer' } });
    assert.equal(dispatched.status, 'blocked');
    assert.equal(dispatched.issue?.code, 'review-commit-failed');
    assert.match(dispatched.issue?.reason ?? '', /second durable review commit refused/);
    assert.equal(dispatched.reviewCommitRefs?.length, 1, 'the first committed receipt must survive the later failure');
    const firstRef = dispatched.reviewCommitRefs![0]!;
    const record = await realI2.read(taskScope, firstRef);
    assert.equal(record.kind, 'milestone-review-result');
    if (record.kind !== 'milestone-review-result') throw new Error(JSON.stringify(record));
    assert.equal(record.reviewAssignment.reviewKind, 'quality');
    assert.equal(record.delivery.reviewer.assignmentId, record.reviewAssignment.assignmentId);
    assert.equal(pool.inspect().runtimes.some((r) => r.state === 'running'), false, 'the reviewer lease must still be released');
  } finally {
    const disposed = await pool.dispose();
    assert.equal(disposed.status, 'disposed');
    await rm(root, { recursive: true, force: true });
  }
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

    // A reviewer incarnation bound to something other than the real review
    // assignment is still rejected by Core and appends nothing. The manager fix
    // removes this mismatch from the manager path; it never relaxes Core.
    const beforeWrongAssignment = (await journal.replay()).length;
    const wrongAssignmentReview = reviewResult({ taskScope, milestoneId: 'milestone-a', cycleId: 'cycle-a',
      assignmentId: 'assignment-a', resultId: 'review-result-wrong-assignment', completedAt: at(10) });
    await assert.rejects(
      () => port.commit({ ...wrongAssignmentReview,
        delivery: { ...wrongAssignmentReview.delivery,
          reviewer: { ...wrongAssignmentReview.delivery.reviewer, assignmentId: 'invocation-not-the-assignment' } } }),
      /selected reviewer incarnation assignment does not match the review assignment/,
    );
    assert.equal((await journal.replay()).length, beforeWrongAssignment, 'a wrong reviewer assignment must not append I2 history');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

interface I2HttpBody {
  readonly scope?: {
    readonly kind: 'task';
    readonly projectKey: string;
    readonly mode: 'fake' | 'rcc';
    readonly taskId: TaskId;
  };
  readonly current?: {
    readonly state: 'known' | 'unknown';
    readonly cycleId?: string | null;
    readonly reason?: string;
  };
  readonly viewed?: { readonly cycleId?: string; readonly occurrenceId?: string } | null;
  readonly entries?: readonly {
    readonly cycleId?: string;
    readonly occurrenceId?: string;
    readonly milestoneId?: string;
  }[];
  readonly entry?: {
    readonly cycleId?: string;
    readonly occurrenceId?: string;
  };
  readonly items?: readonly {
    readonly checkId: string;
    readonly change: string;
  }[];
  readonly nextCursor?: string;
  readonly error?: { readonly code?: string };
}

async function runScopedI2HttpFixture(): Promise<void> {
  const root = await mkdtemp('/private/tmp/humanagent-scoped-i2-http-');
  let server: ReturnType<typeof createServer> | undefined;
  let listening = false;
  try {
  const workspaceA = join(root, 'workspace-a');
  const workspaceB = join(root, 'workspace-b');
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  const pathsA = await resolveRuntimePaths({ workspace: workspaceA, controlRoot: join(root, 'control') });
  const pathsB = await resolveRuntimePaths({ workspace: workspaceB, controlRoot: join(root, 'control') });
  await ensureControlLayout(pathsA);
  await ensureControlLayout(pathsB);
  const taskId = id('task', 'scoped-i2-shared-task');
  const legacyTaskId = id('task', 'scoped-i2-legacy-task');
  const unidentifiedTaskId = id('task', 'scoped-i2-unidentified-task');
  const conflictTaskId = id('task', 'scoped-i2-conflict-task');
  const organA = id('organ', 'scoped-i2-organ-a');
  const organB = id('organ', 'scoped-i2-organ-b');
  const conflictOrgan = id('organ', 'scoped-i2-organ-conflict');
  const taskScopeA: TaskScope = { organId: organA, taskId };
  const taskScopeB: TaskScope = { organId: organB, taskId };
  const controlA = new JsonlOrganJournal(uiRuntimeControlJournalPath(uiRuntimeModeRoot(pathsA.checkpointsRoot, 'fake')));
  const controlB = new JsonlOrganJournal(uiRuntimeControlJournalPath(uiRuntimeModeRoot(pathsB.checkpointsRoot, 'fake')));
  const identitySource = (suffix: string) => ({
    requirementId: `scoped-i2-requirement-${suffix}`,
    inputRevision: 1,
    draftId: `scoped-i2-draft-${suffix}`,
    draftRevisionVersion: 1,
    draftRevisionHash: `sha256:scoped-i2-${suffix}`,
    confirmationRef: `scoped-i2-confirmation-${suffix}`,
  });
  await new JsonlTaskIdentityJournal(controlA).append({ scope: taskScopeA, source: identitySource('a') });
  const identitiesB = new JsonlTaskIdentityJournal(controlB);
  await identitiesB.append({ scope: taskScopeB, source: identitySource('b') });
  await identitiesB.append({
    scope: { organId: organB, taskId: conflictTaskId },
    source: identitySource('conflict-b'),
  });
  await identitiesB.append({
    scope: { organId: conflictOrgan, taskId: conflictTaskId },
    source: identitySource('conflict-other'),
  });
  const portA = createJsonlI2JournalPort({
    filePath: uiRuntimeControlJournalPath(uiRuntimeModeRoot(pathsA.checkpointsRoot, 'fake')),
    journal: controlA,
  });
  const portB = createJsonlI2JournalPort({ filePath: uiRuntimeControlJournalPath(uiRuntimeModeRoot(pathsB.checkpointsRoot, 'fake')), journal: controlB });
  await portA.commit(cycleOpened({ taskScope: taskScopeA, cycleId: 'shared-cycle', openedAt: at(1) }));
  const legacyScope: TaskScope = { organId: organA, taskId: legacyTaskId };
  const legacyDefinition = definitionRecord({
    taskScope: legacyScope, definitionId: 'legacy-definition', definitionVersion: '1',
    checkIds: ['check-1'], createdAt: at(1),
  });
  const legacyDefinitionRef = await portA.commit(legacyDefinition);
  const legacyCycleRef = await portA.commit(cycleOpened({ taskScope: legacyScope, cycleId: 'legacy-cycle', openedAt: at(2) }));
  const legacyOccurrence1Ref = await portA.commit(occurrenceOpened({
    taskScope: legacyScope, occurrenceId: 'legacy-occurrence-1', cycleId: 'legacy-cycle',
    definitionId: legacyDefinition.content.definition.definitionId,
    definitionVersion: legacyDefinition.content.definition.definitionVersion,
    definitionCommitRef: legacyDefinitionRef, definitionDigest: legacyDefinition.definitionDigest,
    cycleOpenedCommitRef: legacyCycleRef, openedAt: at(3),
  }));
  const legacyOccurrence2Ref = await portA.commit(occurrenceOpened({
    taskScope: legacyScope, occurrenceId: 'legacy-occurrence-2', cycleId: 'legacy-cycle',
    definitionId: legacyDefinition.content.definition.definitionId,
    definitionVersion: legacyDefinition.content.definition.definitionVersion,
    definitionCommitRef: legacyDefinitionRef, definitionDigest: legacyDefinition.definitionDigest,
    cycleOpenedCommitRef: legacyCycleRef, openedAt: at(4),
  }));
  const legacyResult1Ref = await portA.commit(itemResult({
    taskScope: legacyScope, occurrenceId: 'legacy-occurrence-1', cycleId: 'legacy-cycle',
    definitionId: legacyDefinition.content.definition.definitionId,
    definitionVersion: legacyDefinition.content.definition.definitionVersion,
    definitionCommitRef: legacyDefinitionRef, definitionDigest: legacyDefinition.definitionDigest,
    cycleOpenedCommitRef: legacyCycleRef, checkId: 'check-1', resultId: 'legacy-result-1', completedAt: at(5),
  }));
  const legacyResult2Ref = await portA.commit(itemResult({
    taskScope: legacyScope, occurrenceId: 'legacy-occurrence-2', cycleId: 'legacy-cycle',
    definitionId: legacyDefinition.content.definition.definitionId,
    definitionVersion: legacyDefinition.content.definition.definitionVersion,
    definitionCommitRef: legacyDefinitionRef, definitionDigest: legacyDefinition.definitionDigest,
    cycleOpenedCommitRef: legacyCycleRef, checkId: 'check-1', resultId: 'legacy-result-2', completedAt: at(6),
  }));
  await portA.commit(settled({
    taskScope: legacyScope, occurrenceId: 'legacy-occurrence-1',
    definitionId: legacyDefinition.content.definition.definitionId,
    definitionVersion: legacyDefinition.content.definition.definitionVersion,
    openingCommitRef: legacyOccurrence1Ref, itemResultCommitRefs: [legacyResult1Ref], settledAt: at(7),
  }));
  await portA.commit(settled({
    taskScope: legacyScope, occurrenceId: 'legacy-occurrence-2',
    definitionId: legacyDefinition.content.definition.definitionId,
    definitionVersion: legacyDefinition.content.definition.definitionVersion,
    openingCommitRef: legacyOccurrence2Ref, itemResultCommitRefs: [legacyResult2Ref], settledAt: at(8),
  }));
  await portA.commit(reviewResult({
    taskScope: legacyScope, milestoneId: 'legacy-milestone', cycleId: 'legacy-cycle',
    assignmentId: 'legacy-assignment', resultId: 'legacy-review-result', completedAt: at(9),
  }));
  await portA.commit(cycleOpened({ taskScope: { organId: organA, taskId: unidentifiedTaskId }, cycleId: 'unidentified-cycle', openedAt: at(10) }));
  await portA.commit(cycleOpened({ taskScope: { organId: organA, taskId: conflictTaskId }, cycleId: 'conflict-cycle', openedAt: at(11) }));

  const definitionB = definitionRecord({
    taskScope: taskScopeB, definitionId: 'definition-b', definitionVersion: '1',
    checkIds: ['check-1'], createdAt: at(1),
  });
  const definitionRefB = await portB.commit(definitionB);
  const cycleB1Ref = await portB.commit(cycleOpened({ taskScope: taskScopeB, cycleId: 'cycle-b-1', openedAt: at(2) }));
  const cycleB2Ref = await portB.commit(cycleOpened({
    taskScope: taskScopeB, cycleId: 'cycle-b-2', previousCycleCommitRef: cycleB1Ref, openedAt: at(3),
  }));
  const occurrenceB1Ref = await portB.commit(occurrenceOpened({
    taskScope: taskScopeB, occurrenceId: 'occurrence-b1', cycleId: 'cycle-b-1',
    definitionId: definitionB.content.definition.definitionId,
    definitionVersion: definitionB.content.definition.definitionVersion,
    definitionCommitRef: definitionRefB, definitionDigest: definitionB.definitionDigest,
    cycleOpenedCommitRef: cycleB1Ref, openedAt: at(4),
  }));
  const occurrenceB2Ref = await portB.commit(occurrenceOpened({
    taskScope: taskScopeB, occurrenceId: 'occurrence-b2', cycleId: 'cycle-b-2',
    definitionId: definitionB.content.definition.definitionId,
    definitionVersion: definitionB.content.definition.definitionVersion,
    definitionCommitRef: definitionRefB, definitionDigest: definitionB.definitionDigest,
    cycleOpenedCommitRef: cycleB2Ref, openedAt: at(5),
  }));
  const resultB1Ref = await portB.commit(itemResult({
    taskScope: taskScopeB, occurrenceId: 'occurrence-b1', cycleId: 'cycle-b-1',
    definitionId: definitionB.content.definition.definitionId,
    definitionVersion: definitionB.content.definition.definitionVersion,
    definitionCommitRef: definitionRefB, definitionDigest: definitionB.definitionDigest,
    cycleOpenedCommitRef: cycleB1Ref, checkId: 'check-1', resultId: 'result-b1',
    judgment: 'before', completedAt: at(6),
  }));
  const resultB2Ref = await portB.commit(itemResult({
    taskScope: taskScopeB, occurrenceId: 'occurrence-b2', cycleId: 'cycle-b-2',
    definitionId: definitionB.content.definition.definitionId,
    definitionVersion: definitionB.content.definition.definitionVersion,
    definitionCommitRef: definitionRefB, definitionDigest: definitionB.definitionDigest,
    cycleOpenedCommitRef: cycleB2Ref, checkId: 'check-1', resultId: 'result-b2',
    judgment: 'after', completedAt: at(7),
  }));
  await portB.commit(settled({
    taskScope: taskScopeB, occurrenceId: 'occurrence-b1',
    definitionId: definitionB.content.definition.definitionId,
    definitionVersion: definitionB.content.definition.definitionVersion,
    openingCommitRef: occurrenceB1Ref, itemResultCommitRefs: [resultB1Ref], settledAt: at(8),
  }));
  await portB.commit(settled({
    taskScope: taskScopeB, occurrenceId: 'occurrence-b2',
    definitionId: definitionB.content.definition.definitionId,
    definitionVersion: definitionB.content.definition.definitionVersion,
    openingCommitRef: occurrenceB2Ref, itemResultCommitRefs: [resultB2Ref], settledAt: at(9),
  }));
  await portB.commit(reviewResult({
    taskScope: taskScopeB, milestoneId: 'milestone-b', cycleId: 'cycle-b-1',
    assignmentId: 'assignment-b', resultId: 'review-result-b', completedAt: at(10),
  }));

  const accessControl = await AccessControlService.open({ credentialPath: pathsA.webAccessCredentialPath, create: true });
  const challenge = accessControl.createPairingChallenge('scoped-i2-http', 1);
  const session = await accessControl.consumePairingCode(challenge.code);
  const binding = {
    bindingId: 'scoped-i2-binding', providerId: 'scoped-i2-provider', protocol: 'responses' as const,
    endpointRef: 'fake://scoped-i2', modelRef: 'fake',
    configDigest: 'sha256:scoped-i2', capabilityDigest: 'sha256:scoped-i2',
  };
  const forbidden = (): never => { throw new Error('I2 GET must remain read-only'); };
  const uiJournal = new UiRuntimeJournal(uiRuntimeJournalPath(pathsA.checkpointsRoot, 'fake'));
  const service = new UiRuntimeService({
    mode: 'fake', organId: organA, binding, port: buildFakeExecutionPort(binding),
    journal: uiJournal, closurePort: uiJournal, checkpointStoreFor: forbidden,
    attentionPort: { publish: forbidden, resolve: forbidden }, providerState: 'ready',
    now: () => new Date('2026-10-17T00:01:00.000Z'),
    runtimeComposition: { createTaskAssembly: forbidden },
    i2History: {
      journal: portA,
      currentPosition: {
        read: async () => ({ state: 'known', cycleId: 'shared-cycle', planRevisionCommitRef: null }),
      },
    },
    projectKey: pathsA.projectKey, workspaceRoot: workspaceA, runtimePaths: pathsA,
    projectCatalog: () => listConfiguredProjects(pathsA),
    explicitBrainInterpreter: { interpret: async () => { throw new Error('I2 GET must not interpret'); } },
    memory: {
      coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(),
      projectKey: pathsA.projectKey, roleId: 'execution',
    },
  });
  const { listener } = createUiRuntimeRequestDispatcher({
    service, accessControl, uiRoot: join(process.cwd(), 'docs/ui'), isClosing: () => false,
  });
  server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => {
      listening = true;
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('scoped I2 HTTP consumer did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
  const request = async (path: string): Promise<{ readonly status: number; readonly body: I2HttpBody }> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    return { status: response.status, body: await response.json() as I2HttpBody };
  };
  const beforeA = canonicalJsonStringify(await controlA.replay());
  const beforeB = canonicalJsonStringify(await controlB.replay());
  const taskPath = `/api/tasks/${encodeURIComponent(taskId.value)}`;
  const legacyPath = `/api/tasks/${encodeURIComponent(legacyTaskId.value)}`;
  const queryA = `projectKey=${encodeURIComponent(pathsA.projectKey)}&mode=fake`;
  const queryB = `projectKey=${encodeURIComponent(pathsB.projectKey)}&mode=fake`;
  const scopeA = { kind: 'task' as const, projectKey: pathsA.projectKey, mode: 'fake' as const, taskId };
  const scopeB = { kind: 'task' as const, projectKey: pathsB.projectKey, mode: 'fake' as const, taskId };
  const scopedB = {
    cycles: await request(`${taskPath}/cycles?${queryB}&viewed=cycle-b-2`),
    cycle: await request(`${taskPath}/cycles/cycle-b-1?${queryB}`),
    reviews: await request(`${taskPath}/reviews?${queryB}`),
    occurrences: await request(`${taskPath}/inspection-occurrences?${queryB}&viewed=occurrence-b2`),
    occurrence: await request(`${taskPath}/inspection-occurrences/occurrence-b1?${queryB}`),
    comparison: await request(`${taskPath}/inspection-comparison?${queryB}&left=occurrence-b1&right=occurrence-b2`),
  };
  for (const result of Object.values(scopedB)) {
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.scope, scopeB);
    assert.equal(result.body.current?.state, 'unknown');
  }
  assert.deepEqual(scopedB.cycles.body.entries?.map((entry) => entry.cycleId), ['cycle-b-1', 'cycle-b-2']);
  assert.equal(scopedB.cycles.body.viewed?.cycleId, 'cycle-b-2');
  assert.equal(scopedB.cycle.body.entry?.cycleId, 'cycle-b-1');
  assert.equal(scopedB.reviews.body.entries?.[0]?.milestoneId, 'milestone-b');
  assert.deepEqual(scopedB.occurrences.body.entries?.map((entry) => entry.occurrenceId), ['occurrence-b1', 'occurrence-b2']);
  assert.equal(scopedB.occurrences.body.viewed?.occurrenceId, 'occurrence-b2');
  assert.equal(scopedB.occurrence.body.entry?.occurrenceId, 'occurrence-b1');
  assert.deepEqual(scopedB.comparison.body.items?.map((item) => [item.checkId, item.change]), [['check-1', 'changed']]);
  const scopedA = await request(`${taskPath}/cycles?${queryA}`);
  assert.equal(scopedA.status, 200);
  assert.deepEqual(scopedA.body.scope, scopeA);
  assert.equal(scopedA.body.current?.state, 'known');
  assert.equal(scopedA.body.current?.cycleId, 'shared-cycle');

  const unscoped = {
    cycles: await request(`${legacyPath}/cycles`),
    cycle: await request(`${legacyPath}/cycles/legacy-cycle`),
    reviews: await request(`${legacyPath}/reviews`),
    occurrences: await request(`${legacyPath}/inspection-occurrences?viewed=legacy-occurrence-2`),
    occurrence: await request(`${legacyPath}/inspection-occurrences/legacy-occurrence-1`),
    comparison: await request(`${legacyPath}/inspection-comparison?left=legacy-occurrence-1&right=legacy-occurrence-2`),
  };
  for (const result of Object.values(unscoped)) {
    assert.equal(result.status, 200);
    assert.equal(result.body.scope, undefined);
  }
  assert.equal(unscoped.cycle.body.entry?.cycleId, 'legacy-cycle');
  assert.equal(unscoped.occurrence.body.entry?.occurrenceId, 'legacy-occurrence-1');

  const partial = await request(`${taskPath}/cycles?projectKey=${encodeURIComponent(pathsB.projectKey)}`);
  assert.equal(partial.status, 400);
  assert.equal(partial.body.error?.code, 'read.scope.invalid');
  const unknownProject = await request(`${taskPath}/cycles?projectKey=not-declared&mode=fake`);
  assert.equal(unknownProject.status, 404);
  assert.equal(unknownProject.body.error?.code, 'project.unknown');
  const missingIdentity = await request(
    `/api/tasks/${encodeURIComponent(unidentifiedTaskId.value)}/cycles?${queryB}`,
  );
  assert.equal(missingIdentity.status, 409);
  assert.equal(missingIdentity.body.error?.code, 'i2-history.scope-unavailable');
  const conflictingIdentity = await request(
    `/api/tasks/${encodeURIComponent(conflictTaskId.value)}/cycles?${queryB}`,
  );
  assert.equal(conflictingIdentity.status, 409);
  assert.equal(conflictingIdentity.body.error?.code, 'i2-history.scope-mismatch');
  const firstPageB = await request(`${taskPath}/cycles?${queryB}&limit=1`);
  assert.equal(firstPageB.status, 200);
  assert.ok(firstPageB.body.nextCursor);
  const crossProjectCursor = await request(
    `${taskPath}/cycles?${queryA}&cursor=${encodeURIComponent(firstPageB.body.nextCursor!)}`,
  );
  assert.equal(crossProjectCursor.status, 400);
  assert.equal(crossProjectCursor.body.error?.code, 'i2.cursor-scope-mismatch');
  const unscopedCursor = await request(
    `${legacyPath}/cycles?cursor=${encodeURIComponent(firstPageB.body.nextCursor!)}`,
  );
  assert.equal(unscopedCursor.status, 400);
  assert.equal(unscopedCursor.body.error?.code, 'i2.cursor-scope-mismatch');
  const unknownViewed = await request(`${taskPath}/cycles?${queryA}&viewed=cycle-a-does-not-exist`);
  assert.equal(unknownViewed.status, 404);
  assert.equal(unknownViewed.body.error?.code, 'i2.cycle.viewed-unknown');

  assert.equal(canonicalJsonStringify(await controlA.replay()), beforeA);
  assert.equal(canonicalJsonStringify(await controlB.replay()), beforeB);
  } finally {
    if (server !== undefined && listening) {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('scoped I2 public HTTP isolates same TaskId history by canonical project and mode', async () => {
  await runScopedI2HttpFixture();
});
