import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  sameProductTargetRef,
  type BusinessCycleOpenedRecord,
  type DurableInspectionDefinition,
  type EvidenceRef,
  type ExecutionPolicyDefinition,
  type InspectionItemResultRecord,
  type InspectionOccurrenceOpenedRecord,
  type InspectionOccurrenceSettledRecord,
  type JournalCommitRef,
  type ScopeRef,
  type Subscription,
  type TaskId,
  type TaskIdentityRecord,
} from '../../packages/contracts/src/index.js';
import { computeInspectionDefinitionDigest } from '../../packages/core/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { createJsonlI2JournalPort } from '../../packages/app/src/i2-journal.js';
import {
  FileCheckpointStore,
  FakeReplayExecutionRuntimePort,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../packages/app/src/ui-runtime/index.js';
import {
  inspectionDisplayFactFromProjection,
  inspectionDisplayStateFromProjection,
} from '../../packages/app/src/ui-runtime/product-session-read.js';
import { productRelationRefKey } from '../../packages/app/src/ui-runtime/product-relations.js';
import type { RuntimeInspectionOccurrenceProjection } from '../../packages/ui/contracts/runtime.js';
import { TaskIdentityConsumer, type TaskIdentityPort } from '../../packages/runtime/src/orchestration/task-identity.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import { SubscriptionControlPort } from '../../packages/runtime/src/subscriptions/index.js';

const organId = id('organ', 's2-wiring-organ');
const projectKey = 'project-s2-wiring';
const binding = {
  bindingId: 's2-wiring-binding',
  providerId: 's2-wiring-provider',
  protocol: 'responses' as const,
  endpointRef: 'fake://s2-wiring',
  modelRef: 'fake',
  configDigest: 'sha256:s2-wiring-config',
  capabilityDigest: 'sha256:s2-wiring-capability',
};
const startedAt = '2026-10-21T10:00:00.000Z';

type TaskScope = ScopeRef & { readonly taskId: TaskId };

interface Fixture {
  readonly root: string;
  readonly service: UiRuntimeService;
  readonly identities: Map<string, TaskIdentityRecord>;
  readonly subscriptions: SubscriptionControlPort;
  readonly i2: ReturnType<typeof createJsonlI2JournalPort>;
}

function externalRef(seed: string): JournalCommitRef {
  return { commitId: `external:${seed}`, journalSeq: 1, recordDigest: `sha256:${'0'.repeat(64)}` };
}

function evidence(taskId: TaskId, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `s2-${taskId.value}-${label}`),
    kind: 'execution',
    source: 's2-consumer',
    locator: `execution://${taskId.value}/${label}`,
    scope: { organId, taskId },
  };
}

function identitySource(requirementId: string, suffix: string) {
  return {
    requirementId,
    inputRevision: 1,
    draftId: `draft-${suffix}`,
    draftRevisionVersion: 1,
    draftRevisionHash: `hash-${suffix}`,
    confirmationRef: `confirmation-${suffix}`,
  };
}

function definitionRecord(input: {
  readonly taskScope: TaskScope;
  readonly definitionId: string;
  readonly checkIds: readonly string[];
  readonly createdAt: string;
}): DurableInspectionDefinition {
  const definition = {
    definitionId: input.definitionId,
    definitionVersion: '1',
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

function cycleOpened(taskScope: TaskScope, cycleId: string, openedAt: string): BusinessCycleOpenedRecord {
  return {
    kind: 'business-cycle-opened',
    schemaVersion: 1,
    cycle: {
      id: id('cycle', cycleId),
      scope: taskScope,
      directiveRevision: 1,
      executionEpoch: 1,
      state: 'running',
    },
    taskFlow: { kind: 'inspection', definitionVersion: 1 },
    planRevisionCommitRef: externalRef(`${cycleId}-plan`),
    previousCycleCommitRef: null,
    openedAt,
    openingReason: 'authorized start',
  };
}

function occurrenceOpened(input: {
  readonly taskScope: TaskScope;
  readonly occurrenceId: string;
  readonly cycleId: string;
  readonly definitionId: string;
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
    definition: { definitionId: input.definitionId, definitionVersion: '1' },
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
  readonly definitionCommitRef: JournalCommitRef;
  readonly definitionDigest: string;
  readonly cycleOpenedCommitRef: JournalCommitRef;
  readonly checkId: string;
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
      definition: { definitionId: input.definitionId, definitionVersion: '1' },
      definitionCommitRef: input.definitionCommitRef,
      definitionDigest: input.definitionDigest,
      cycleOpenedCommitRef: input.cycleOpenedCommitRef,
      scheduleOccurrenceRef: null,
    },
    delivery: {
      checkId: input.checkId,
      resultId: `${input.occurrenceId}-${input.checkId}`,
      attempt: 1,
      outcome: { status: 'completed', judgment: `judgment:${input.checkId}` },
      evidenceRefs: [evidence(input.taskScope.taskId, input.checkId)],
      completedAt: input.completedAt,
    },
  };
}

function settled(input: {
  readonly taskScope: TaskScope;
  readonly occurrenceId: string;
  readonly definitionId: string;
  readonly openingCommitRef: JournalCommitRef;
  readonly itemResultCommitRefs: readonly JournalCommitRef[];
  readonly settledAt: string;
}): InspectionOccurrenceSettledRecord {
  return {
    kind: 'inspection-occurrence-settled',
    schemaVersion: 1,
    openingCommitRef: input.openingCommitRef,
    occurrence: { scope: input.taskScope, occurrenceId: input.occurrenceId },
    definition: { definitionId: input.definitionId, definitionVersion: '1' },
    itemResultCommitRefs: input.itemResultCommitRefs,
    outcome: { status: 'blocked', reason: 'provider stopped before the inspection could finish' },
    checkpointCommitRef: externalRef(`${input.occurrenceId}-checkpoint`),
    settledAt: input.settledAt,
  };
}

async function makeFixture(withI2: boolean): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-s2-wiring-'));
  const identities = new Map<string, TaskIdentityRecord>();
  const identityPort: TaskIdentityPort = {
    async append() {
      throw new Error('the S2 consumer does not establish task identity');
    },
    async replay() {
      return [...identities.values()];
    },
  };
  const subscriptionPath = join(root, 'subscriptions.jsonl');
  const subscriptions = new SubscriptionControlPort(
    new JsonlOrganJournal(subscriptionPath),
    { organId },
    subscriptionPath,
  );
  const organPath = join(root, 'organ.jsonl');
  const i2 = createJsonlI2JournalPort({
    filePath: organPath,
    journal: new JsonlOrganJournal(organPath),
  });
  const uiJournal = new UiRuntimeJournal(join(root, 'ui-runtime.jsonl'));
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding }),
    journal: uiJournal,
    closurePort: uiJournal,
    checkpointStoreFor: (taskId, cycleId) =>
      new FileCheckpointStore(join(root, `checkpoint-${taskId.value}-${cycleId.value}.jsonl`)),
    attentionPort: {
      async publish(input) { return { attentionId: input.attentionId, delivered: true }; },
      async resolve(input) { return { attentionId: input.attentionId, delivered: true }; },
    },
    providerState: 'ready',
    projectKey,
    now: () => new Date('2026-10-21T12:00:00.000Z'),
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey,
      roleId: 'execution',
    },
    explicitBrainInterpreter: {
      async interpret() { throw new Error('the S2 consumer does not use the explicit brain'); },
    },
    taskIdentity: new TaskIdentityConsumer(identityPort),
    subscriptionControl: subscriptions,
    ...(withI2 ? { i2History: { journal: i2 } } : {}),
  });
  return { root, service, identities, subscriptions, i2 };
}

function rememberIdentity(
  identities: Map<string, TaskIdentityRecord>,
  taskId: TaskId,
  requirementId: string,
): void {
  identities.set(taskId.value, {
    scope: { organId, taskId },
    source: identitySource(requirementId, taskId.value),
    journalCommitRef: `journal:task-identity:${taskId.value}`,
  });
}

function taskScope(taskId: TaskId): TaskScope {
  return { organId, taskId };
}

function inspectionBoard(board: Awaited<ReturnType<UiRuntimeService['productBoardIndex']>>) {
  const section = board.boards.find((candidate) => candidate.board === 'inspection');
  if (section === undefined) throw new Error('inspection board is missing');
  return section;
}

function inspectionItems(board: Awaited<ReturnType<UiRuntimeService['productBoardIndex']>>) {
  const section = inspectionBoard(board);
  return [...section.live, ...section.history, ...section.unknown];
}

async function commitInspection(input: {
  readonly i2: Fixture['i2'];
  readonly taskScope: TaskScope;
  readonly occurrenceId: string;
  readonly cycleId: string;
  readonly definitionId: string;
  readonly openedAt: string;
  readonly settled: boolean;
}): Promise<void> {
  const definition = definitionRecord({
    taskScope: input.taskScope,
    definitionId: input.definitionId,
    checkIds: ['check-1'],
    createdAt: '2026-10-21T09:59:00.000Z',
  });
  const definitionRef = await input.i2.commit(definition);
  const cycle = cycleOpened(input.taskScope, input.cycleId, '2026-10-21T09:59:30.000Z');
  const cycleRef = await input.i2.commit(cycle);
  const opening = occurrenceOpened({
    taskScope: input.taskScope,
    occurrenceId: input.occurrenceId,
    cycleId: input.cycleId,
    definitionId: input.definitionId,
    definitionCommitRef: definitionRef,
    definitionDigest: definition.definitionDigest,
    cycleOpenedCommitRef: cycleRef,
    openedAt: input.openedAt,
  });
  const openingRef = await input.i2.commit(opening);
  const result = itemResult({
    taskScope: input.taskScope,
    occurrenceId: input.occurrenceId,
    cycleId: input.cycleId,
    definitionId: input.definitionId,
    definitionCommitRef: definitionRef,
    definitionDigest: definition.definitionDigest,
    cycleOpenedCommitRef: cycleRef,
    checkId: 'check-1',
    completedAt: '2026-10-21T10:01:00.000Z',
  });
  const resultRef = await input.i2.commit(result);
  if (input.settled) {
    await input.i2.commit(settled({
      taskScope: input.taskScope,
      occurrenceId: input.occurrenceId,
      definitionId: input.definitionId,
      openingCommitRef: openingRef,
      itemResultCommitRefs: [resultRef],
      settledAt: '2026-10-21T10:02:00.000Z',
    }));
  }
}

async function seedRelationsFixture(fixture: Fixture) {
  const parent = fixture.service.createTask({ title: 'Parent report', directive: 'parent' });
  const child = fixture.service.createTask({ title: 'Child report', directive: 'child' });
  const unrelated = fixture.service.createTask({ title: 'Unrelated same title', directive: 'other' });
  rememberIdentity(fixture.identities, parent.taskId, 'requirement-parent');
  rememberIdentity(fixture.identities, child.taskId, 'requirement-child');
  rememberIdentity(fixture.identities, unrelated.taskId, 'requirement-unrelated');

  const subscription: Subscription = {
    subscriptionId: 'subscription-s2-relations',
    goalId: 'requirement-parent',
    scheduleRevision: 1,
    state: 'active',
    busyPolicy: 'skip',
    currentOccurrenceOrdinal: 0,
  };
  const policy: ExecutionPolicyDefinition = {
    policyId: 'policy-s2-relations',
    policyRevision: 1,
    timezone: 'America/Los_Angeles',
    canonicalInstant: startedAt,
    dstMode: 'wall',
    dstMissedPolicy: 'shift-forward',
    dstAmbiguousPolicy: 'earlier-offset',
    latePolicy: 'run-once',
    busyPolicy: 'skip',
    executionMode: 'scheduled',
    startAt: startedAt,
    maxOccurrences: 1,
  };
  await fixture.subscriptions.create(subscription, policy);
  const claim = await fixture.subscriptions.claim({
    subscriptionId: subscription.subscriptionId,
    scheduleRevision: 1,
    occurrenceOrdinal: 1,
    dueAt: startedAt,
    taskId: child.taskId,
    operationId: id('operation', 's2-child-operation'),
    inputArtifactDigest: 'sha256:s2-child-input',
    schedulerInstanceId: 'scheduler-s2',
    leaseId: 'lease-s2',
    generation: 1,
    executionEpoch: 1,
    nowAt: startedAt,
    leaseUntil: '2026-10-21T10:05:00.000Z',
  });

  await commitInspection({
    i2: fixture.i2,
    taskScope: taskScope(child.taskId),
    occurrenceId: claim.occurrenceId,
    cycleId: 'cycle-child',
    definitionId: 'definition-child',
    openedAt: '2026-10-21T10:00:30.000Z',
    settled: true,
  });
  await commitInspection({
    i2: fixture.i2,
    taskScope: taskScope(unrelated.taskId),
    occurrenceId: 'occurrence-unrelated',
    cycleId: 'cycle-unrelated',
    definitionId: 'definition-unrelated',
    openedAt: '2026-10-21T10:00:45.000Z',
    settled: false,
  });

  return { parent, child, unrelated, claim };
}

test('service productRelations composes evidence-backed lineage and occurrence edges', async () => {
  const fixture = await makeFixture(true);
  try {
    const { parent, child, unrelated, claim } = await seedRelationsFixture(fixture);
    const scope = {
      kind: 'task' as const,
      projectKey,
      mode: 'fake' as const,
      taskId: child.taskId,
    };
    const targetRef = (taskId: TaskId) => ({
      kind: 'interaction' as const,
      taskRef: taskId,
      scope: { kind: 'task' as const, projectKey, mode: 'fake' as const, taskId },
    });
    const parentRef = targetRef(parent.taskId);
    const childRef = targetRef(child.taskId);

    const result = await fixture.service.productRelations(scope);
    const childEdges = result.relations.filter((relation) => relation.kind === 'child-execution');
    assert.equal(childEdges.length, 1, JSON.stringify(result.gaps));
    assert.ok(sameProductTargetRef(childEdges[0]!.source, parentRef));
    assert.ok(sameProductTargetRef(childEdges[0]!.target, childRef));
    assert.ok(childEdges[0]!.evidenceRefs.some((ref) =>
      ref.locator.includes(`/subscriptions/${claim.subscriptionId}/occurrences/${claim.occurrenceId}`)));

    const occurrenceEdges = result.relations.filter((relation) => relation.kind === 'occurrence');
    assert.equal(occurrenceEdges.length, 1);
    assert.ok(sameProductTargetRef(occurrenceEdges[0]!.source, childRef));
    assert.equal(
      occurrenceEdges[0]!.target.kind === 'session'
        ? occurrenceEdges[0]!.target.sessionRef.sourceRef
        : undefined,
      claim.occurrenceId,
    );
    assert.ok(result.relations.every((relation) =>
      relation.source.taskRef?.value !== unrelated.taskId.value
      && relation.target.taskRef?.value !== unrelated.taskId.value));

    const replay = await fixture.service.productRelations(scope);
    assert.deepEqual(
      replay.relations.map((relation) => [
        productRelationRefKey(relation.source),
        productRelationRefKey(relation.target),
        relation.kind,
      ]),
      result.relations.map((relation) => [
        productRelationRefKey(relation.source),
        productRelationRefKey(relation.target),
        relation.kind,
      ]),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('inspection board uses task-scoped I2 occurrences and keeps openedAt in the display fact', async () => {
  const fixture = await makeFixture(true);
  try {
    const { child, unrelated, claim } = await seedRelationsFixture(fixture);
    const childBoard = await fixture.service.productBoardIndex({
      kind: 'task',
      projectKey,
      mode: 'fake',
      taskId: child.taskId,
    });
    const childItems = inspectionItems(childBoard);
    const childOccurrence = childItems.find((item) =>
      item.ref.kind === 'session'
      && item.ref.sessionRef.sourceKind === 'inspection-occurrence'
      && item.ref.sessionRef.sourceRef === claim.occurrenceId);
    if (childOccurrence === undefined) throw new Error('child inspection occurrence is missing');
    assert.equal(childOccurrence.title, 'definition-child');
    assert.equal(childOccurrence.displayState, 'blocked');
    assert.equal(
      childItems.some((item) =>
        item.ref.kind === 'session'
        && item.ref.sessionRef.sourceKind === 'inspection-occurrence'
        && item.ref.sessionRef.sourceRef === 'occurrence-unrelated'),
      false,
      'task-scoped inspection reads must not cross task boundaries',
    );
    assert.equal(inspectionBoard(childBoard).failures?.some((failure) =>
      failure.code.startsWith('inspection.i2-history')) ?? false, false);

    const history = await fixture.service.taskInspectionOccurrences(child.taskId, { limit: 10 });
    assert.equal(history.ok, true);
    if (!history.ok) throw new Error(history.failure.message);
    const projection = history.value.entries.find((entry) => entry.occurrenceId === claim.occurrenceId);
    if (projection === undefined) throw new Error('child occurrence projection is missing');
    const displayFact = inspectionDisplayFactFromProjection(projection, child.taskId);
    assert.equal(displayFact.openedAt, '2026-10-21T10:00:30.000Z');
    assert.equal(displayFact.displayState, 'blocked');

    const projectBoard = await fixture.service.productBoardIndex({ kind: 'project', projectKey });
    const titles = inspectionItems(projectBoard).map((item) => item.title);
    assert.ok(titles.includes('definition-child'));
    assert.ok(titles.includes('definition-unrelated'));

    const unrelatedRelations = await fixture.service.productRelations({
      kind: 'task',
      projectKey,
      mode: 'fake',
      taskId: unrelated.taskId,
    });
    assert.equal(
      unrelatedRelations.relations.some((relation) => relation.kind === 'child-execution'),
      false,
      'a task without committed lineage must not gain a parent edge',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('missing I2 history is explicit unavailable for task and project scopes', async () => {
  const fixture = await makeFixture(false);
  try {
    const task = fixture.service.createTask({ title: 'No I2 task' });
    const taskBoard = await fixture.service.productBoardIndex({
      kind: 'task',
      projectKey,
      mode: 'fake',
      taskId: task.taskId,
    });
    assert.deepEqual(inspectionItems(taskBoard), []);
    assert.ok(inspectionBoard(taskBoard).failures?.some((failure) =>
      failure.code === 'inspection.i2-history-unavailable'));

    const projectBoard = await fixture.service.productBoardIndex({ kind: 'project', projectKey });
    assert.deepEqual(inspectionItems(projectBoard), []);
    assert.ok(inspectionBoard(projectBoard).failures?.some((failure) =>
      failure.code === 'inspection.i2-history-unavailable'));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('projection display state keeps item failure and real outcome distinctions', () => {
  const base: RuntimeInspectionOccurrenceProjection = {
    occurrenceId: 'occurrence-display',
    cycleId: 'cycle-display',
    executionEpoch: 1,
    definitionId: 'definition-display',
    definitionVersion: '1',
    definitionDigest: 'sha256:display',
    definitionCommitRef: { commitId: 'definition', journalSeq: 1, recordDigest: 'sha256:definition' },
    openingCommitRef: { commitId: 'opening', journalSeq: 2, recordDigest: 'sha256:opening' },
    settlementCommitRef: null,
    openedAt: '2026-10-21T10:03:00.000Z',
    settledAt: null,
    state: 'open',
    outcome: 'pending',
    outcomeReason: null,
    scheduleOccurrenceRef: null,
    items: [{
      checkId: 'check-1',
      criterion: 'criterion',
      state: 'failed',
      outcome: 'failed',
      judgment: null,
      reason: 'failed check',
      resultRef: 'result-1',
      completedAt: '2026-10-21T10:04:00.000Z',
      evidenceRefs: [],
    }],
    evidenceRefs: [],
  };
  assert.equal(inspectionDisplayStateFromProjection(base), 'failed');
  assert.equal(inspectionDisplayStateFromProjection({
    ...base,
    items: [],
    state: 'settled',
    outcome: 'blocked',
  }), 'blocked');
  assert.equal(inspectionDisplayStateFromProjection({
    ...base,
    items: [],
    outcome: 'pending',
  }), 'open');
  assert.equal(inspectionDisplayStateFromProjection({
    ...base,
    items: [],
    state: 'settled',
    outcome: 'completed',
  }), 'completed');
  assert.equal(inspectionDisplayFactFromProjection(base, id('task', 'display-task')).openedAt, base.openedAt);
});
