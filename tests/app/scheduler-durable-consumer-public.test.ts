import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureControlLayout, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import {
  id,
  occurrenceExecutionAdmissionCommitId,
  occurrenceTerminalReceiptCommitId,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionPolicyDefinition,
  type Occurrence,
  type OccurrenceTaskBinding,
  type ProviderBinding,
  type ServeTaskTerminalReceipt,
} from '../../packages/contracts/src/index.js';
import { acquireDaemonLease } from '../../packages/app/src/supervisor/index.js';
import {
  DurableOccurrenceConsumer,
  DurableOccurrenceConsumerError,
} from '../../packages/app/src/ui-runtime/occurrence-consumer.js';
import {
  FakeReplayExecutionRuntimePort,
  FileCheckpointStore,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { startUiRuntimeServer } from '../../packages/app/src/ui-runtime/server.js';
import type { ExplicitBrainInputInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import { SubscriptionControlError, SubscriptionControlPort } from '../../packages/runtime/src/subscriptions/index.js';
import type { OccurrenceClaimRecord } from '../../packages/runtime/src/subscriptions/ports.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import type { AttentionPort } from '../../packages/runtime/src/control/attention.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';

const taskId = id('task', 'task-scheduler-public');
const operationId = id('operation', 'operation-scheduler-public');
const schedulerScope = {
  organId: id('organ', 'organ-scheduler-public'),
  taskId,
};
const assetScope = {
  ...schedulerScope,
  cycleId: id('cycle', 'cycle-scheduler-public'),
  operationId,
};

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `scheduler-public-${label}`),
    kind: 'operation',
    source: 'humanagent.tests.scheduler-public',
    locator: `test://scheduler-public/${label}`,
    scope: assetScope,
  };
}

function terminalReceipt(call: number): ServeTaskTerminalReceipt {
  return {
    taskId,
    operationId,
    executionEpoch: 1,
    inputArtifactDigest: 'sha256:input-scheduler-public',
    verification: {
      taskId,
      operationId,
      executionEpoch: 1,
      attempt: 1,
      inputArtifactDigest: 'sha256:input-scheduler-public',
      policyRef: 'task-verification/v1:policy-scheduler-public',
      policyDigest: 'sha256:policy-scheduler-public',
      status: 'success',
      checks: [{
        checkId: `check-scheduler-public-${call}`,
        kind: 'native',
        status: 'succeeded',
        decisionRef: `task-verification/v1:${call}`,
        decisionDigest: `sha256:${call}`,
        artifactDigests: ['sha256:input-scheduler-public'],
        evidenceRefs: [evidence(String(call))],
      }],
      evidenceRefs: [evidence(String(call))],
    },
    terminalCheckpointRef: `checkpoint:scheduler-public:${call}`,
    settlementReceiptRef: `receipt:scheduler-public:${call}`,
  };
}

function production(receipt: ServeTaskTerminalReceipt): {
  readonly checkpoint: Checkpoint;
  readonly verification: ServeTaskTerminalReceipt['verification'];
  readonly settlementReceiptRef: string;
} {
  return {
    checkpoint: {
      id: id('checkpoint', 'terminal-scheduler-public'),
      scope: assetScope,
      cycleId: assetScope.cycleId,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: receipt.executionEpoch,
      outcome: 'succeeded',
      summary: 'terminal success',
      recoveryStateRef: receipt.verification.evidenceRefs[0]!,
      evidenceRefs: receipt.verification.evidenceRefs,
      next: { kind: 'continue', ref: receipt.verification.evidenceRefs[0]!.locator },
    },
    verification: receipt.verification,
    settlementReceiptRef: receipt.settlementReceiptRef,
  };
}

function policy(): ExecutionPolicyDefinition {
  return {
    policyId: 'policy-scheduler-public',
    policyRevision: 1,
    timezone: 'UTC',
    canonicalInstant: '2026-10-05T00:00:00.000Z',
    dstMode: 'wall',
    dstMissedPolicy: 'shift-forward',
    dstAmbiguousPolicy: 'earlier-offset',
    latePolicy: 'run-once',
    busyPolicy: 'skip',
    executionMode: 'recurring',
    startAt: '2026-10-05T00:00:00.000Z',
    frequency: 'interval',
    intervalMinutes: 60,
  } as ExecutionPolicyDefinition;
}

function claimRequest() {
  return {
    subscriptionId: 'subscription-scheduler-public',
    scheduleRevision: 1,
    occurrenceOrdinal: 1,
    dueAt: '2026-10-05T00:00:00.000Z',
    taskId,
    operationId,
    inputArtifactDigest: 'sha256:input-scheduler-public',
    schedulerInstanceId: 'scheduler-public',
    leaseId: 'lease-scheduler-public',
    generation: 1,
    executionEpoch: 1,
    nowAt: '2026-10-05T00:00:00.000Z',
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}

function bindingFor(claim: OccurrenceClaimRecord): OccurrenceTaskBinding {
  return {
    occurrenceId: claim.occurrenceId,
    subscriptionId: claim.subscriptionId,
    scheduleRevision: claim.scheduleRevision,
    occurrenceOrdinal: claim.occurrenceOrdinal,
    taskId: claim.taskId,
    operationId: claim.operationId,
    executionEpoch: claim.executionEpoch,
    inputArtifactDigest: claim.inputArtifactDigest,
  };
}

test('scheduler and real durable consumer dispatch once across duplicate, concurrent, and restart calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-app-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const subscriptionFile = join(root, 'subscriptions.jsonl');
  const occurrenceJournal = join(root, 'occurrence.jsonl');
  await mkdir(workspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const lease = await acquireDaemonLease(paths, { ownerId: 'scheduler-app-public' });
  let dispatches = 0;
  const consumer = new DurableOccurrenceConsumer({
    lease,
    scope: assetScope,
    journal: new JsonlOrganJournal(occurrenceJournal),
    checkpoints: new FileCheckpointStore(occurrenceJournal),
    dispatch: {
      async dispatch() {
        dispatches += 1;
        return production(terminalReceipt(dispatches));
      },
    },
  });

  try {
    const firstPort = new SubscriptionControlPort(
      new JsonlOrganJournal(subscriptionFile),
      schedulerScope,
      subscriptionFile,
      consumer,
    );
    await firstPort.create({
      subscriptionId: 'subscription-scheduler-public',
      goalId: 'goal-scheduler-public',
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    }, policy());
    await firstPort.schedule({
      occurrence: {
        subscriptionId: 'subscription-scheduler-public',
        scheduleRevision: 1,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt: '2026-10-05T00:00:00.000Z',
      },
      nowAt: '2026-10-05T00:00:00.000Z',
    });
    const claim = await firstPort.claim(claimRequest());

    const first = await firstPort.consumeExecution(claim.occurrenceId, claim);
    const duplicate = await firstPort.consumeExecution(claim.occurrenceId, claim);
    const replayConsumer = new DurableOccurrenceConsumer({
      lease,
      scope: assetScope,
      journal: new JsonlOrganJournal(occurrenceJournal),
      checkpoints: new FileCheckpointStore(occurrenceJournal),
      dispatch: {
        async dispatch() {
          dispatches += 1;
          throw new Error('replay must not dispatch');
        },
      },
    });
    const restarted = new SubscriptionControlPort(
      new JsonlOrganJournal(subscriptionFile),
      schedulerScope,
      subscriptionFile,
      replayConsumer,
    );
    const afterRestart = await restarted.consumeExecution(claim.occurrenceId, claim);
    const [firstConcurrent, secondConcurrent] = await Promise.all([
      restarted.consumeExecution(claim.occurrenceId, claim),
      restarted.consumeExecution(claim.occurrenceId, claim),
    ]);

    assert.deepEqual(duplicate, first);
    assert.deepEqual(afterRestart, first);
    assert.deepEqual(firstConcurrent, first);
    assert.deepEqual(secondConcurrent, first);
    assert.equal(dispatches, 1);

    const records = await new JsonlOrganJournal(occurrenceJournal).replay();
    const binding = bindingFor(claim);
    const admissionCommitId = await occurrenceExecutionAdmissionCommitId(binding);
    const receiptCommitId = await occurrenceTerminalReceiptCommitId(binding);
    assert.equal(records.filter((record) => record.commitId === admissionCommitId).length, 1);
    assert.equal(records.filter((record) => record.commitId === receiptCommitId).length, 1);
    assert.equal(records.filter((record) => record.kind === 'checkpoint').length, 1);
  } finally {
    await lease.release();
    await rm(root, { recursive: true, force: true });
  }
});

const subscriptionOrganId = id('organ', 'organ-subscription-plan');

const planPolicyBase = {
  policyRevision: 1,
  timezone: 'UTC',
  canonicalInstant: '2026-10-05T00:00:00.000Z',
  dstMode: 'wall',
  dstMissedPolicy: 'shift-forward',
  dstAmbiguousPolicy: 'earlier-offset',
  latePolicy: 'run-once',
  busyPolicy: 'skip',
} as const;

const oncePlanPolicy: ExecutionPolicyDefinition = {
  ...planPolicyBase,
  policyId: 'plan-once',
  executionMode: 'once',
  dueAt: '2026-10-05T00:00:00.000Z',
};

const scheduledPlanPolicy: ExecutionPolicyDefinition = {
  ...planPolicyBase,
  policyId: 'plan-scheduled',
  timezone: 'America/Los_Angeles',
  executionMode: 'scheduled',
  startAt: '2026-10-05T01:00:00.000Z',
};

const recurringPlanPolicy: ExecutionPolicyDefinition = {
  ...planPolicyBase,
  policyId: 'plan-recurring',
  executionMode: 'recurring',
  startAt: '2026-10-05T00:00:00.000Z',
  endAt: '2026-10-05T02:30:00.000Z',
  maxOccurrences: 10,
  frequency: 'interval',
  intervalMinutes: 60,
};

function planAttentionPort(): AttentionPort {
  return {
    async publish(input) { return { attentionId: input.attentionId, delivered: true }; },
    async resolve(input) { return { attentionId: input.attentionId, delivered: true }; },
  };
}

function planProviderBinding(): ProviderBinding {
  return {
    bindingId: 'binding-plan-consumer',
    providerId: 'provider-plan-consumer',
    protocol: 'responses',
    endpointRef: 'rcc-v3:127.0.0.1:4444',
    modelRef: 'model-plan-consumer',
    configDigest: 'sha256:plan-config',
    capabilityDigest: 'sha256:plan-capability',
  };
}

function planService(
  root: string,
  subscriptionControl: SubscriptionControlPort,
  explicitBrainInterpreter?: ExplicitBrainInputInterpreter,
): UiRuntimeService {
  const binding = planProviderBinding();
  return new UiRuntimeService({
    mode: 'fake',
    organId: subscriptionOrganId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: planAttentionPort(),
    providerState: 'ready',
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    closurePort: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'project-subscription-plan',
      roleId: 'execution',
    },
    subscriptionControl,
    explicitBrainInterpreter: explicitBrainInterpreter ?? {
      async interpret() { throw new Error('explicit brain interpretation is not configured'); },
    },
  });
}

function planSubscriptionFile(root: string): string {
  return join(root, 'subscriptions.jsonl');
}

function planPort(root: string): SubscriptionControlPort {
  const file = planSubscriptionFile(root);
  return new SubscriptionControlPort(
    new JsonlOrganJournal(file),
    { organId: subscriptionOrganId },
    file,
  );
}

async function proposeNewTask(service: UiRuntimeService, suffix: string): Promise<string> {
  const interactionId = await service.receiveExplicitInput({
    sourceRef: `ui:plan-${suffix}`,
    rawInput: `schedule the ${suffix} requirement`,
    channel: 'business',
    requestKind: 'new-task-preview',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: `schedule the ${suffix} requirement`,
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: `create the ${suffix} scheduled work`,
  });
  return interactionId;
}

interface PersistedPlanState {
  readonly subscriptions: Record<string, {
    readonly subscription: {
      readonly subscriptionId: string;
      readonly goalId: string;
      readonly scheduleRevision: number;
      readonly state: string;
      readonly busyPolicy: string;
    };
    readonly policy: ExecutionPolicyDefinition;
    readonly policyHash: string;
  }>;
}

async function readPersistedPlans(file: string): Promise<PersistedPlanState['subscriptions']> {
  const records = await new JsonlOrganJournal(file).replay();
  const state = records.map((record) => record.payload?.state)
    .filter((value): value is PersistedPlanState => Boolean(value) && typeof value === 'object')
    .at(-1);
  return state?.subscriptions ?? {};
}

function planConfirmation(
  interactionId: string,
  draftId: string,
  suffix: string,
  policy?: ExecutionPolicyDefinition,
) {
  return {
    interactionId,
    draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${suffix}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-05T00:00:00.000Z',
    payloadRef: `asset://requirements/${suffix}`,
    ...(policy === undefined ? {} : { executionPolicy: policy }),
  };
}

test('production final submit persists one real subscription per execution mode and produces its occurrences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-subscription-plan-public-'));
  try {
    const cases: readonly {
      readonly suffix: string;
      readonly policy: ExecutionPolicyDefinition;
      readonly expectedDueTimes: readonly string[];
      readonly beyondSchedule: string;
    }[] = [
      {
        suffix: 'once',
        policy: oncePlanPolicy,
        expectedDueTimes: ['2026-10-05T00:00:00.000Z'],
        beyondSchedule: '2026-10-05T01:00:00.000Z',
      },
      {
        suffix: 'scheduled',
        policy: scheduledPlanPolicy,
        expectedDueTimes: ['2026-10-05T01:00:00.000Z'],
        beyondSchedule: '2026-10-05T02:00:00.000Z',
      },
      {
        suffix: 'recurring',
        policy: recurringPlanPolicy,
        expectedDueTimes: [
          '2026-10-05T00:00:00.000Z',
          '2026-10-05T01:00:00.000Z',
          '2026-10-05T02:00:00.000Z',
        ],
        beyondSchedule: '2026-10-05T03:00:00.000Z',
      },
    ];
    for (const scenario of cases) {
      // Each mode owns an isolated control root so the per-scenario identities
      // cannot collide with a sibling mode.
      const scenarioRoot = join(root, scenario.suffix);
      await mkdir(scenarioRoot, { recursive: true });
      const file = planSubscriptionFile(scenarioRoot);
      const service = planService(scenarioRoot, planPort(scenarioRoot));
      const interactionId = await proposeNewTask(service, scenario.suffix);
      const proposed = await service.inspectExplicitInteraction(interactionId);
      assert.ok(proposed.draft);
      const receipt = await service.confirmExplicitRequirement(
        planConfirmation(interactionId, proposed.draft!.draftId, scenario.suffix, scenario.policy),
      );

      const plans = await readPersistedPlans(file);
      const planEntries = Object.entries(plans)
        .filter(([key]) => key.includes(receipt.requirement.requirementId));
      assert.equal(planEntries.length, 1, `${scenario.suffix}: exactly one persisted subscription`);
      const [subscriptionId, plan] = planEntries[0]!;
      assert.equal(plan.subscription.scheduleRevision, 1, `${scenario.suffix}: schedule revision 1`);
      assert.equal(plan.subscription.state, 'active', `${scenario.suffix}: active subscription`);
      assert.equal(plan.subscription.busyPolicy, scenario.policy.busyPolicy, `${scenario.suffix}: busy policy carried`);
      assert.equal(plan.subscription.goalId, receipt.requirement.requirementId, `${scenario.suffix}: goal id is the requirement`);
      assert.deepEqual(plan.policy, scenario.policy, `${scenario.suffix}: policy is field-equal`);

      // Restart readback: a fresh port over the same control root reads the plan.
      const restartedPort = planPort(scenarioRoot);
      const restarted = await restartedPort.snapshot(subscriptionId);
      assert.deepEqual(restarted.policy, scenario.policy, `${scenario.suffix}: restart readback keeps the policy`);
      assert.equal(restarted.policy.timezone, scenario.policy.timezone, `${scenario.suffix}: timezone persisted`);

      const dueTimes = await restartedPort.dueTimes({
        policy: scenario.policy,
        nowAt: '2026-10-06T00:00:00.000Z',
        count: 20,
      });
      assert.deepEqual(dueTimes, scenario.expectedDueTimes, `${scenario.suffix}: committed due times`);

      for (const [index, dueAt] of scenario.expectedDueTimes.entries()) {
        const scheduled: Occurrence = await restartedPort.schedule({
          occurrence: {
            subscriptionId,
            scheduleRevision: 1,
            occurrenceOrdinal: index + 1,
            state: 'due',
            dueAt,
          },
          nowAt: dueAt,
        });
        assert.equal(scheduled.occurrenceOrdinal, index + 1, `${scenario.suffix}: occurrence ordinal ${index + 1}`);
        assert.equal(scheduled.dueAt, dueAt, `${scenario.suffix}: occurrence ${index + 1} due at the committed slot`);
      }

      const afterScheduling = await planPort(scenarioRoot).snapshot(subscriptionId);
      assert.equal(
        afterScheduling.occurrences.length,
        scenario.expectedDueTimes.length,
        `${scenario.suffix}: persisted occurrence count`,
      );
      await assert.rejects(
        () => restartedPort.schedule({
          occurrence: {
            subscriptionId,
            scheduleRevision: 1,
            occurrenceOrdinal: scenario.expectedDueTimes.length + 1,
            state: 'due',
            dueAt: scenario.beyondSchedule,
          },
          nowAt: scenario.beyondSchedule,
        }),
        (error: unknown) => error instanceof Error && error.message.includes('not part of the committed schedule'),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sameSubmitInterpreter(): ExplicitBrainInputInterpreter {
  return {
    async interpret(input) {
      return {
        kind: 'requirement',
        normalizedInput: input.rawInput,
        knownFacts: [],
        intent: 'create',
        proposal: `create:${input.rawInput}`,
        decisionRefs: ['decision:same-submit'],
      };
    },
  };
}

// The real new-task form sends the execution policy inside the confirmation
// submit, after interpretation has already minted a policy-less typed
// revision. This is the exact path that previously returned 409
// execution-plan.policy-immutable, so the test drives interpretation first and
// then binds the policy on the same submit.
test('same-submit execution policy binds the typed revision and persists one subscription per mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-subscription-same-submit-'));
  try {
    const cases = [
      { suffix: 'once', policy: oncePlanPolicy },
      { suffix: 'scheduled', policy: scheduledPlanPolicy },
      { suffix: 'recurring', policy: recurringPlanPolicy },
    ] as const;
    for (const scenario of cases) {
      const scenarioRoot = join(root, scenario.suffix);
      await mkdir(scenarioRoot, { recursive: true });
      const file = planSubscriptionFile(scenarioRoot);
      const service = planService(scenarioRoot, planPort(scenarioRoot), sameSubmitInterpreter());
      const interactionId = await service.receiveExplicitInput({
        sourceRef: `ui:same-submit-${scenario.suffix}`,
        rawInput: `create the ${scenario.suffix} task`,
        channel: 'business',
        requestKind: 'new-task-preview',
      });
      const interpreted = await service.interpretExplicitInput({ interactionId });
      assert.equal(interpreted.state, 'awaiting-confirmation', `${scenario.suffix}: interpretation awaits confirmation`);
      const arrivalRevision = interpreted.revision;
      assert.ok(arrivalRevision, `${scenario.suffix}: interpretation minted a typed revision`);
      assert.equal(arrivalRevision!.executionPolicy, undefined, `${scenario.suffix}: arrival revision carries no policy yet`);

      const confirmation = {
        interactionId,
        draftId: interpreted.draft!.draftId,
        inputRevision: 1,
        confirmationRef: `confirmation:same-submit:${scenario.suffix}`,
        confirmedBy: 'human:operator',
        confirmedAt: '2026-10-05T00:00:00.000Z',
        payloadRef: `asset://requirements/same-submit:${scenario.suffix}`,
        goal: interpreted.draft!.proposal,
        scope: interpreted.draft!.normalizedInput,
        executionPolicy: scenario.policy,
      };
      const first = await service.confirmExplicitRequirement(confirmation);
      assert.equal(first.requirement.status, 'submitted', `${scenario.suffix}: same-submit confirmation succeeds`);
      const afterConfirm = await service.inspectExplicitInteraction(interactionId);
      assert.equal(afterConfirm.state, 'confirmed', `${scenario.suffix}: interaction is confirmed`);
      assert.ok(afterConfirm.revision, `${scenario.suffix}: confirmed revision is readable`);
      assert.ok(
        afterConfirm.revision!.revisionVersion > arrivalRevision!.revisionVersion,
        `${scenario.suffix}: the policy binding minted a new revision version`,
      );
      assert.deepEqual(
        afterConfirm.revision!.executionPolicy,
        scenario.policy,
        `${scenario.suffix}: the submit-time policy is stored on the revision`,
      );
      assert.equal(
        afterConfirm.revision!.normalizedInput,
        arrivalRevision!.normalizedInput,
        `${scenario.suffix}: policy binding preserves the human-readable task body`,
      );

      const plans = await readPersistedPlans(file);
      const planEntries = Object.entries(plans)
        .filter(([key]) => key.includes(first.requirement.requirementId));
      assert.equal(planEntries.length, 1, `${scenario.suffix}: exactly one persisted subscription`);
      assert.deepEqual(planEntries[0]![1].policy, scenario.policy, `${scenario.suffix}: persisted policy matches`);

      const repeat = await service.confirmExplicitRequirement(confirmation);
      assert.equal(
        repeat.requirement.requirementId,
        first.requirement.requirementId,
        `${scenario.suffix}: repeated submit reuses the requirement`,
      );
      const [concurrentA, concurrentB] = await Promise.all([
        service.confirmExplicitRequirement(confirmation),
        service.confirmExplicitRequirement(confirmation),
      ]);
      assert.equal(
        concurrentA.requirement.requirementId,
        first.requirement.requirementId,
        `${scenario.suffix}: concurrent submit A reuses the requirement`,
      );
      assert.equal(
        concurrentB.requirement.requirementId,
        first.requirement.requirementId,
        `${scenario.suffix}: concurrent submit B reuses the requirement`,
      );
      const afterRepeats = await readPersistedPlans(file);
      assert.equal(
        Object.entries(afterRepeats).filter(([key]) => key.includes(first.requirement.requirementId)).length,
        1,
        `${scenario.suffix}: repeated and concurrent submits keep exactly one subscription`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('same-submit policy binding keeps stale rejection, policy immutability, and the legacy path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-subscription-same-submit-guards-'));
  try {
    const service = planService(root, planPort(root), sameSubmitInterpreter());

    // A caller that pins an older revision must still be rejected before any
    // ledger write, even though the same submit carries a policy to bind.
    const staleInteraction = await service.receiveExplicitInput({
      sourceRef: 'ui:same-submit-stale',
      rawInput: 'create the stale-pinned task',
      channel: 'business',
      requestKind: 'new-task-preview',
    });
    const staleInterpreted = await service.interpretExplicitInput({ interactionId: staleInteraction });
    const staleArrival = staleInterpreted.revision!;
    await assert.rejects(
      () => service.confirmExplicitRequirement({
        interactionId: staleInteraction,
        draftId: staleInterpreted.draft!.draftId,
        inputRevision: 1,
        confirmationRef: 'confirmation:same-submit-stale',
        confirmedBy: 'human:operator',
        confirmedAt: '2026-10-05T00:00:00.000Z',
        payloadRef: 'asset://requirements/same-submit-stale',
        draftRevisionVersion: staleArrival.revisionVersion + 5,
        draftRevisionHash: staleArrival.revisionHash,
        executionPolicy: oncePlanPolicy,
      }),
      (error: unknown) => (error as { readonly code?: string }).code === 'explicit-draft.confirmation-stale',
    );
    const staleAfter = await service.inspectExplicitInteraction(staleInteraction);
    assert.equal(staleAfter.state, 'awaiting-confirmation', 'a stale confirmation leaves the interaction unconfirmed');
    assert.equal(
      staleAfter.revision!.revisionVersion,
      staleArrival.revisionVersion,
      'a stale confirmation does not mint a new revision',
    );
    assert.equal(
      Object.keys(await readPersistedPlans(planSubscriptionFile(root))).length,
      0,
      'a stale confirmation writes no subscription',
    );

    // A revision that already carries a different policy cannot be rebound.
    const immutableInteraction = await service.receiveExplicitInput({
      sourceRef: 'ui:same-submit-immutable',
      rawInput: 'create the immutable-policy task',
      channel: 'business',
      requestKind: 'new-task-preview',
    });
    const immutableInterpreted = await service.interpretExplicitInput({ interactionId: immutableInteraction });
    await service.confirmExplicitRequirement({
      interactionId: immutableInteraction,
      draftId: immutableInterpreted.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:same-submit-immutable:once',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-05T00:00:00.000Z',
      payloadRef: 'asset://requirements/same-submit-immutable',
      goal: immutableInterpreted.draft!.proposal,
      scope: immutableInterpreted.draft!.normalizedInput,
      executionPolicy: oncePlanPolicy,
    });
    await assert.rejects(
      () => service.confirmExplicitRequirement({
        interactionId: immutableInteraction,
        draftId: immutableInterpreted.draft!.draftId,
        inputRevision: 1,
        confirmationRef: 'confirmation:same-submit-immutable:recurring',
        confirmedBy: 'human:operator',
        confirmedAt: '2026-10-05T00:00:00.000Z',
        payloadRef: 'asset://requirements/same-submit-immutable-recurring',
        executionPolicy: recurringPlanPolicy,
      }),
      (error: unknown) => (error as { readonly code?: string }).code === 'execution-plan.policy-immutable'
        && error instanceof Error
        && error.message === `draft revision already carries a different execution policy: ${immutableInterpreted.draft!.draftId}`,
    );

    // Legacy confirmation without a request kind or policy is unchanged.
    const legacyInteraction = await service.receiveExplicitInput({
      sourceRef: 'ui:same-submit-legacy',
      rawInput: 'create the legacy task',
      channel: 'business',
    });
    await service.beginExplicitMatching(legacyInteraction);
    await service.recordExplicitMatch(legacyInteraction, {
      normalizedInput: 'create the legacy task',
      matchedTasks: [],
      knownFacts: [],
    });
    await service.proposeExplicitRequirement(legacyInteraction, {
      proposedIntent: 'create',
      proposal: 'create the legacy task',
    });
    const legacy = await service.inspectExplicitInteraction(legacyInteraction);
    const legacyReceipt = await service.confirmExplicitRequirement({
      draftId: legacy.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:same-submit-legacy',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-05T00:00:00.000Z',
      payloadRef: 'asset://requirements/same-submit-legacy',
    });
    assert.equal(legacyReceipt.requirement.status, 'submitted', 'the legacy confirmation path still succeeds');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production HTTP confirmation persists a real scheduled subscription', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-subscription-plan-http-'));
  const file = planSubscriptionFile(root);
  let runtimeServer: Awaited<ReturnType<typeof startUiRuntimeServer>> | undefined;
  try {
    const accessControl = await AccessControlService.open({
      credentialPath: join(root, 'security', 'web-access.json'),
      create: true,
    });
    const challenge = accessControl.createPairingChallenge('plan-http', 1);
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    runtimeServer = await startUiRuntimeServer({
      service: planService(root, planPort(root)),
      accessControl,
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      port: 0,
    });
    const origin = new URL(runtimeServer.url).origin;
    const call = (path: string, body?: unknown): Promise<Response> => fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const created = await call('/api/explicit/inputs', {
      sourceRef: 'ui:plan-http',
      rawInput: 'schedule the http requirement',
      channel: 'business',
      requestKind: 'new-task-preview',
    });
    assert.equal(created.status, 201, 'the HTTP input route accepts a typed request kind');
    const { interactionId } = await created.json() as { readonly interactionId: string };
    const route = `/api/explicit/interactions/${encodeURIComponent(interactionId)}`;
    assert.equal((await call(`${route}/matching`, {})).status, 202);
    assert.equal((await call(`${route}/match`, {
      normalizedInput: 'schedule the http requirement',
      matchedTasks: [],
      knownFacts: [],
    })).status, 202);
    assert.equal((await call(`${route}/proposal`, {
      proposedIntent: 'create',
      proposal: 'create the scheduled http work',
    })).status, 202);
    const snapshot = await (await call(route)).json() as { readonly draft?: { readonly draftId: string } };
    assert.ok(snapshot.draft, 'the HTTP flow produced a reviewable draft');
    const confirmed = await call(`${route}/confirmation`, {
      draftId: snapshot.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:http',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-05T00:00:00.000Z',
      payloadRef: 'asset://requirements/http',
      executionPolicy: scheduledPlanPolicy,
    });
    assert.equal(confirmed.status, 200, 'the HTTP confirmation accepts an execution policy');
    const receipt = await confirmed.json() as { readonly requirement: { readonly requirementId: string } };

    const plans = await readPersistedPlans(file);
    const entries = Object.entries(plans)
      .filter(([key]) => key.includes(receipt.requirement.requirementId));
    assert.equal(entries.length, 1, 'the HTTP confirmation persisted exactly one subscription');
    assert.deepEqual(entries[0]![1].policy, scheduledPlanPolicy, 'the persisted policy matches the submitted policy');
  } finally {
    await runtimeServer?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('repeated, concurrent, and restart-replayed final submits reuse one subscription', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-subscription-plan-idempotent-'));
  const file = planSubscriptionFile(root);
  try {
    const service = planService(root, planPort(root));
    const interactionId = await proposeNewTask(service, 'idempotent');
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    const confirmation = planConfirmation(interactionId, proposed.draft!.draftId, 'idempotent', recurringPlanPolicy);

    const first = await service.confirmExplicitRequirement(confirmation);
    const second = await service.confirmExplicitRequirement(confirmation);
    assert.equal(second.requirement.requirementId, first.requirement.requirementId, 'repeated submit reuses the requirement');

    const [concurrentA, concurrentB] = await Promise.all([
      service.confirmExplicitRequirement(confirmation),
      service.confirmExplicitRequirement(confirmation),
    ]);
    assert.equal(concurrentA.requirement.requirementId, first.requirement.requirementId, 'concurrent submit A reuses the requirement');
    assert.equal(concurrentB.requirement.requirementId, first.requirement.requirementId, 'concurrent submit B reuses the requirement');

    const restarted = planService(root, planPort(root));
    await restarted.hydrate();
    const replayed = await restarted.confirmExplicitRequirement(confirmation);
    assert.equal(replayed.requirement.requirementId, first.requirement.requirementId, 'restart replay reuses the requirement');

    const plans = await readPersistedPlans(file);
    const planEntries = Object.entries(plans)
      .filter(([key]) => key.includes(first.requirement.requirementId));
    assert.equal(planEntries.length, 1, 'exactly one subscription after repeated, concurrent, and restart submits');
    assert.deepEqual(planEntries[0]![1].policy, recurringPlanPolicy, 'reused subscription keeps the compiled policy');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('subscription creation failure fails the final submit and keeps the original error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-subscription-plan-failure-'));
  try {
    class FailingPlanPort extends SubscriptionControlPort {
      override async create(): Promise<never> {
        throw new SubscriptionControlError('invalid-state', 'injected subscription create failure');
      }
    }
    const failingPort = new FailingPlanPort(
      new JsonlOrganJournal(planSubscriptionFile(root)),
      { organId: subscriptionOrganId },
      planSubscriptionFile(root),
    );
    const service = planService(root, failingPort);
    const interactionId = await proposeNewTask(service, 'failure');
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);

    await assert.rejects(
      () => service.confirmExplicitRequirement(
        planConfirmation(interactionId, proposed.draft!.draftId, 'failure', oncePlanPolicy),
      ),
      (error: unknown) => (error as { readonly code?: string }).code === 'execution-plan.invalid-state'
        && error instanceof Error
        && error.message === 'injected subscription create failure',
    );
    const plans = await readPersistedPlans(planSubscriptionFile(root));
    assert.equal(Object.keys(plans).length, 0, 'a failed create leaves no subscription behind');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('final submit without an execution policy persists no subscription', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-subscription-plan-none-'));
  const file = planSubscriptionFile(root);
  try {
    const service = planService(root, planPort(root));
    const interactionId = await proposeNewTask(service, 'no-policy');
    const proposed = await service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await service.confirmExplicitRequirement(
      planConfirmation(interactionId, proposed.draft!.draftId, 'no-policy'),
    );
    const records = await new JsonlOrganJournal(file).replay();
    assert.equal(records.length, 0, 'no policy means zero subscription side effects');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheduler replays a committed receipt after the original claim expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-expiry-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const subscriptionFile = join(root, 'subscriptions.jsonl');
  const occurrenceJournal = join(root, 'occurrence.jsonl');
  await mkdir(workspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const lease = await acquireDaemonLease(paths, { ownerId: 'scheduler-expiry-public' });
  let dispatches = 0;
  const consumer = new DurableOccurrenceConsumer({
    lease,
    scope: assetScope,
    journal: new JsonlOrganJournal(occurrenceJournal),
    checkpoints: new FileCheckpointStore(occurrenceJournal),
    dispatch: {
      async dispatch() {
        dispatches += 1;
        return production(terminalReceipt(dispatches));
      },
    },
  });

  try {
    const firstPort = new SubscriptionControlPort(
      new JsonlOrganJournal(subscriptionFile),
      schedulerScope,
      subscriptionFile,
      consumer,
    );
    await firstPort.create({
      subscriptionId: 'subscription-scheduler-public',
      goalId: 'goal-scheduler-public',
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    }, policy());
    await firstPort.schedule({
      occurrence: {
        subscriptionId: 'subscription-scheduler-public',
        scheduleRevision: 1,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt: '2026-10-05T00:00:00.000Z',
      },
      nowAt: '2026-10-05T00:00:00.000Z',
    });
    const claimAcquiredAt = new Date();
    const claimLeaseUntil = new Date(claimAcquiredAt.getTime() + 250);
    const firstDueAt = '2026-10-05T00:00:00.000Z';
    const claim = await firstPort.claim({
      ...claimRequest(),
      dueAt: firstDueAt,
      nowAt: claimAcquiredAt.toISOString(),
      leaseUntil: claimLeaseUntil.toISOString(),
    });
    const committed = await firstPort.consumeExecution(claim.occurrenceId, claim);
    assert.equal(dispatches, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const restarted = new SubscriptionControlPort(
      new JsonlOrganJournal(subscriptionFile),
      schedulerScope,
      subscriptionFile,
      consumer,
    );
    const replay = await restarted.consumeExecution(claim.occurrenceId, claim);
    assert.deepEqual(replay, committed);
    assert.equal(dispatches, 1);
  } finally {
    await lease.release();
    await rm(root, { recursive: true, force: true });
  }
});

test('scheduler rejects an expired claim before durable first admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-expiry-unadmitted-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const subscriptionFile = join(root, 'subscriptions.jsonl');
  const occurrenceJournal = join(root, 'occurrence.jsonl');
  await mkdir(workspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const lease = await acquireDaemonLease(paths, { ownerId: 'scheduler-expiry-unadmitted' });
  let dispatches = 0;
  const consumer = new DurableOccurrenceConsumer({
    lease,
    scope: assetScope,
    journal: new JsonlOrganJournal(occurrenceJournal),
    checkpoints: new FileCheckpointStore(occurrenceJournal),
    dispatch: {
      async dispatch() {
        dispatches += 1;
        return production(terminalReceipt(dispatches));
      },
    },
  });

  try {
    const port = new SubscriptionControlPort(
      new JsonlOrganJournal(subscriptionFile),
      schedulerScope,
      subscriptionFile,
      consumer,
    );
    await port.create({
      subscriptionId: 'subscription-scheduler-public',
      goalId: 'goal-scheduler-public',
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    }, policy());
    await port.schedule({
      occurrence: {
        subscriptionId: 'subscription-scheduler-public',
        scheduleRevision: 1,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt: '2026-10-05T00:00:00.000Z',
      },
      nowAt: '2026-10-05T00:00:00.000Z',
    });
    const claimAcquiredAt = new Date();
    const claim = await port.claim({
      ...claimRequest(),
      nowAt: claimAcquiredAt.toISOString(),
      leaseUntil: new Date(claimAcquiredAt.getTime() + 250).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    await assert.rejects(
      () => port.consumeExecution(claim.occurrenceId, claim),
      (error: unknown) => error instanceof DurableOccurrenceConsumerError && error.code === 'lease-expired',
    );
    assert.equal(dispatches, 0);
    const records = await new JsonlOrganJournal(occurrenceJournal).replay();
    assert.equal(
      records.filter((record) => record.payload?.kind === 'occurrence-execution-admission').length,
      0,
    );
  } finally {
    await lease.release();
    await rm(root, { recursive: true, force: true });
  }
});
