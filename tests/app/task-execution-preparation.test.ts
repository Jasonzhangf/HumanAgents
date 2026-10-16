import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type AgentEvent, type ProviderCloseResult, type ProviderEvent, type TaskId } from '../../packages/contracts/src/index.js';
import { AppLifecycleError } from '../../packages/app/src/errors.js';
import { TaskGrantDeniedError } from '../../packages/runtime/src/admission/task-grant.js';
import {
  createPreparedExecutionConsumer,
} from '../../packages/app/src/task-execution-preparation.js';
import { readPreparedExecutionInput } from '../../packages/app/src/prepared-execution-input.js';
import { FileCheckpointStore, UiRuntimeJournal } from '../../packages/app/src/ui-runtime/journal.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
  projectDurableTaskInventory,
  type RuntimeTaskJournalRecord,
  type RuntimeTaskJournalPort,
  type RuntimeTaskSnapshot,
  type RuntimeExecutionAllocation,
  type RuntimeExecutionDriver,
  type RuntimeExecutionPreparationInput,
  type RuntimeTaskCoordinatorOptions,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';

const fixtureRoot =
  process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-denial-cold-recovery-20261015');

function buildCoordinator(
  journal: RuntimeTaskJournalPort,
  checkpointPath: string,
  callbacks: Pick<RuntimeTaskCoordinatorOptions, 'createDriver' | 'admitExecution'>,
): RuntimeTaskCoordinator {
  return new RuntimeTaskCoordinator({
    organId: id('organ', 'prepared-consumer-r1'),
    taskIdPrefix: 'prepared-consumer',
    journal,
    ...callbacks,
    checkpointStoreFor: () => new FileCheckpointStore(checkpointPath),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
  });
}

/** Real successful driver: one provider output, then a succeeded settle and close. */
class SuccessfulDriver implements RuntimeExecutionDriver {
  readonly kind = 'prepared-consumer.successful-driver';
  starts = 0;
  submits = 0;
  closes = 0;

  constructor(readonly input: RuntimeExecutionPreparationInput) {}

  async capabilities() {
    return { driverKind: this.kind, capabilities: ['execute'], version: '1' };
  }

  async start(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    this.starts += 1;
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async resume(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async submit(input: Parameters<RuntimeExecutionDriver['submit']>[0]) {
    this.submits += 1;
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: input.payload,
      outputRefs: [],
      evidenceRefs: [],
    };
  }

  async *observe(): AsyncIterable<AgentEvent> {
    const { runtimeId, taskId, operationId, executionEpoch } = this.input;
    const event: AgentEvent & { readonly providerEvent: ProviderEvent } = {
      taskId,
      executionEpoch,
      kind: 'provider.output',
      evidenceRefs: [],
      providerEvent: {
        runtimeId,
        taskId,
        operationId,
        executionEpoch,
        eventId: `prepared-output-${operationId.value}`,
        kind: 'output',
        summary: 'prepared provider output',
        evidenceRefs: [],
        ownerId: 'test.provider',
        nextAction: { kind: 'continue', ref: 'prepared-output' },
      },
    };
    yield event;
  }

  async requestStop(input: Parameters<RuntimeExecutionDriver['requestStop']>[0]) {
    return { requested: true, operationId: input.operationId };
  }

  async settle() {
    return { state: 'succeeded' as const, evidenceRefs: [] };
  }

  async close(): Promise<ProviderCloseResult> {
    this.closes += 1;
    return {
      bindingId: 'prepared-consumer-binding',
      providerId: 'prepared-consumer-provider',
      protocol: 'responses',
      state: 'closed',
      evidenceRefs: [],
    };
  }
}

async function waitForState(coordinator: RuntimeTaskCoordinator, taskId: TaskId, state: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (coordinator.taskSnapshot(taskId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`task did not reach ${state}; state=${coordinator.taskSnapshot(taskId).state}`);
}

// Probability UNKNOWN; r3 left the allocation -> prepared-input -> release binding unproven.
// A wrong identity or a double admission/factory invocation would execute an unintended
// Provider turn, so one bounded real public consumer is cheap insurance. The full
// stop-during-held-factory behavior already has R1 coverage and is not repeated here.
test('prepared consumer prepares, reads, and releases the actual allocation once', async () => {
  const root = await mkdtemp(join(fixtureRoot, 'r1-'));
  const journalPath = join(root, 'prepared.jsonl');
  const checkpointPath = join(root, 'checkpoint.jsonl');
  try {
    const journal = new UiRuntimeJournal(journalPath);
    let admissionCalls = 0;
    let factoryCalls = 0;
    let admitted: RuntimeExecutionAllocation | undefined;
    let prepared: RuntimeExecutionPreparationInput | undefined;
    let driver: SuccessfulDriver | undefined;
    const coordinator = buildCoordinator(journal, checkpointPath, {
      async admitExecution(allocation) {
        admissionCalls += 1;
        admitted = allocation;
      },
      async createDriver(preparation) {
        factoryCalls += 1;
        prepared = preparation;
        driver = new SuccessfulDriver(preparation);
        return driver;
      },
    });
    const consumer = createPreparedExecutionConsumer({ coordinator, preparedJournal: journal });
    const taskA = coordinator.createTask({ title: 'prepared task A', directive: 'directive A' });
    const taskB = coordinator.createTask({ title: 'prepared task B', directive: 'directive B' });

    const canonicalInput = 'canonical multiline input\n第二行输入';
    const handle = consumer.prepareRun(taskA.taskId, {
      prompt: `  ${canonicalInput}\n  `,
      operationId: id('operation', 'prepared-consumer-operation'),
    });

    // Exact retained identity and immutable input come from the actual owner reader.
    assert.equal(handle.allocation.taskId.value, taskA.taskId.value);
    assert.equal(handle.allocation.operationId.value, 'prepared-consumer-operation');
    assert.equal(handle.input.input.prompt, canonicalInput);
    assert.equal(handle.input.inputRevision, handle.allocation.inputRevision);
    assert.deepEqual(handle.input.inputRefs, handle.allocation.inputRefs);
    assert.equal(Object.isFrozen(handle.input.input), true);
    assert.equal(Object.isFrozen(handle.allocation), true);

    // Prepare performs no admission and constructs no driver.
    assert.equal(admissionCalls, 0);
    assert.equal(factoryCalls, 0);

    // A wrong task selector is rejected by the actual coordinator before any effect.
    assert.throws(
      () => consumer.prepareRun(taskB.taskId, { prompt: canonicalInput, operationId: handle.allocation.operationId }),
      (error: unknown) => error instanceof RuntimeTaskControlError && error.code === 'operation.identity.conflict',
    );

    // A mismatched allocation is rejected by the actual owner reader before any effect.
    assert.throws(
      () => readPreparedExecutionInput(journal, { ...handle.allocation, inputRevision: handle.allocation.inputRevision + 1 }),
      (error: unknown) => error instanceof AppLifecycleError && error.code === 'execution-composition.owner-source-missing',
    );
    assert.equal(admissionCalls, 0);
    assert.equal(factoryCalls, 0);

    // Release is the coordinator's own public method: admission once, factory once, real success.
    const released = await handle.release();
    assert.equal(released.state, 'released');
    assert.equal(admissionCalls, 1);
    assert.equal(factoryCalls, 1);
    assert.equal(admitted?.taskId.value, taskA.taskId.value);
    assert.equal(admitted?.operationId.value, handle.allocation.operationId.value);
    assert.equal(prepared?.taskId.value, taskA.taskId.value);
    assert.equal(prepared?.operationId.value, handle.allocation.operationId.value);
    await waitForState(coordinator, taskA.taskId, 'succeeded');
    assert.equal(driver?.starts, 1, 'the released driver starts exactly once');
    assert.equal(driver?.submits, 1, 'the released driver submits exactly once');
    assert.equal(driver?.closes, 1, 'the released driver closes exactly once');
  } finally {
    // This unique child is the only fixture resource this consumer owns.
    await rm(root, { recursive: true });
  }
});

/**
 * The real UI runtime journal with one injectable append failure, delegating
 * every other call. It captures only what was actually handed to the real
 * append, so the assertions read the real durable envelope shape.
 */
class DenialRecordingJournal implements RuntimeTaskJournalPort {
  readonly appended: RuntimeTaskJournalRecord[] = [];
  injectFailure?: unknown;

  constructor(private readonly inner: UiRuntimeJournal) {}

  append(record: RuntimeTaskJournalRecord): void {
    if (this.injectFailure !== undefined && record.kind === 'operation.event' && record.zeroEffectAdmissionDenial === true) {
      const failure = this.injectFailure;
      this.injectFailure = undefined;
      throw failure;
    }
    this.inner.append(record);
    this.appended.push(record);
  }

  replay(): readonly RuntimeTaskJournalRecord[] {
    return this.inner.replay();
  }
}

function denialCoordinator(
  journal: RuntimeTaskJournalPort,
  checkpointPath: string,
  callbacks: Pick<RuntimeTaskCoordinatorOptions, 'admitExecution' | 'createDriver'>,
): RuntimeTaskCoordinator {
  return new RuntimeTaskCoordinator({
    organId: id('organ', 'denial-cold-recovery'),
    taskIdPrefix: 'denial-cold',
    journal,
    checkpointStoreFor: () => new FileCheckpointStore(checkpointPath),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
    ...callbacks,
  });
}

/** Bounded settle: a hung release must fail the scenario, not silently pass. */
async function settleRelease(pending: Promise<unknown>): Promise<unknown> {
  let outcome: { readonly rejected: boolean; readonly error?: unknown } | undefined;
  await Promise.race([
    pending.then(
      () => { outcome ??= { rejected: false }; },
      (error: unknown) => { outcome ??= { rejected: true, error }; },
    ),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (outcome === undefined) throw new Error('the release promise never settled');
  if (!outcome.rejected) throw new Error('the release promise resolved instead of rejecting');
  return outcome.error;
}

async function durableEntries(
  journalPath: string,
  checkpointPath: string,
  taskIds: readonly string[],
): Promise<readonly { readonly snapshot: RuntimeTaskSnapshot; readonly durableState: string }[]> {
  const inventory = await projectDurableTaskInventory({
    records: new UiRuntimeJournal(journalPath).replay(),
    checkpointFor: () => new FileCheckpointStore(checkpointPath),
  });
  assert.deepEqual(inventory.failures, []);
  return taskIds.map((taskId) => {
    const entry = inventory.entries.find((candidate) => candidate.snapshot.taskId.value === taskId);
    assert.ok(entry, `durable inventory is missing task ${taskId}`);
    return { snapshot: entry!.snapshot, durableState: entry!.durableState };
  });
}

test('a zero-effect admission denial records its own control fact and keeps the task startable after cold recovery', async () => {
  const root = await mkdtemp(join(fixtureRoot, 'denial-cold-recovery-r1-'));
  const journalPath = join(root, 'prepared.jsonl');
  const checkpointPath = join(root, 'checkpoint.jsonl');
  try {
    const journal = new UiRuntimeJournal(journalPath);
    const recording = new DenialRecordingJournal(journal);
    const denialError = new TaskGrantDeniedError('missing-grant');
    const postAdmissionError = new AppLifecycleError('execution-admission-input-conflict', 'admitted input conflict',
      'inspect the admitted input before release', 'humanagent.app.execution-admission');
    let denialAdmissionCalls = 0;
    let postAdmissionAdmissionCalls = 0;
    let admittedOperations = 0;
    const coordinator = denialCoordinator(recording, checkpointPath, {
      async admitExecution(allocation) {
        if (allocation.operationId.value === 'denied-operation') {
          denialAdmissionCalls += 1;
          throw denialError;
        }
        admittedOperations += 1;
        // The admission already registered this operation's business duty. A
        // later factory failure is therefore a recovery obligation, not a
        // zero-effect refusal.
        if (allocation.operationId.value === 'post-admission-operation') {
          postAdmissionAdmissionCalls += 1;
        }
      },
      async createDriver(preparation): Promise<RuntimeExecutionDriver> {
        // Only the retried denied operation may build a driver; every earlier
        // failure must stop before the factory.
        if (preparation.operationId.value === 'post-admission-operation') {
          throw postAdmissionError;
        }
        throw new Error(`unexpected driver construction for ${preparation.operationId.value}`);
      },
    });
    const consumer = createPreparedExecutionConsumer({ coordinator, preparedJournal: recording });
    const deniedTask = coordinator.createTask({ title: 'denied task', directive: 'directive denied' });
    const postAdmissionTask = coordinator.createTask({ title: 'post admission task', directive: 'directive post admission' });
    const untouchedTask = coordinator.createTask({ title: 'untouched task', directive: 'directive untouched' });

    const deniedHandle = consumer.prepareRun(deniedTask.taskId, {
      prompt: 'denied prompt',
      operationId: id('operation', 'denied-operation'),
    });
    assert.equal(await settleRelease(deniedHandle.release()), denialError);
    assert.equal(denialAdmissionCalls, 1);

    // The typed refusal lives inside the admission edge, so the release rejects
    // with the original denial and the prepared slot is released.
    assert.equal(coordinator.taskSnapshot(deniedTask.taskId).state, 'blocked');
    assert.deepEqual(coordinator.taskSnapshot(deniedTask.taskId).allowedActions, ['start']);
    assert.equal(coordinator.taskSnapshot(deniedTask.taskId).checkpoint, undefined);
    assert.equal(coordinator.taskSnapshot(deniedTask.taskId).output, '');
    assert.equal(recording.injectFailure, undefined);

    // A failure raised after the admission already registered the turn is a
    // different control fact: the original error still rejects the release, but
    // the prepared allocation and its stop action must survive.
    const postHandle = consumer.prepareRun(postAdmissionTask.taskId, {
      prompt: 'post admission prompt',
      operationId: id('operation', 'post-admission-operation'),
    });
    assert.equal(await settleRelease(postHandle.release()), postAdmissionError);
    assert.equal(postAdmissionAdmissionCalls, 1);
    assert.equal(coordinator.taskSnapshot(postAdmissionTask.taskId).state, 'blocked');
    assert.deepEqual(coordinator.taskSnapshot(postAdmissionTask.taskId).allowedActions, ['stop']);

    // One durable envelope carries the typed control field, and only the
    // denial carries it: the post-admission failure writes no such envelope.
    const marked = recording.appended.filter(
      (record): record is Extract<RuntimeTaskJournalRecord, { readonly kind: 'operation.event' }> =>
        record.kind === 'operation.event' && record.zeroEffectAdmissionDenial === true,
    );
    assert.equal(marked.length, 1);
    const markedEnvelope = marked[0]!;
    assert.equal(markedEnvelope.operationId.value, 'denied-operation');
    assert.equal(markedEnvelope.event.kind, 'execution.terminal');
    assert.equal(markedEnvelope.event.state, 'blocked');
    assert.equal(markedEnvelope.event.terminalPhase, 'final');
    assert.equal(markedEnvelope.event.error, undefined);

    // A cold coordinator reads the same prepared Journal and hydrates. Its
    // retried denied operation runs the real success path, so the released
    // driver proves the cold task is genuinely startable again.
    const retriedDrivers = new Map<string, SuccessfulDriver>();
    const cold = denialCoordinator(recording, checkpointPath, {
      async admitExecution() {},
      async createDriver(preparation): Promise<RuntimeExecutionDriver> {
        const driver = new SuccessfulDriver(preparation);
        retriedDrivers.set(preparation.operationId.value, driver);
        return driver;
      },
    });
    await cold.hydrate();
    const coldDenied = cold.taskSnapshot(deniedTask.taskId);
    assert.equal(coldDenied.state, 'blocked');
    assert.deepEqual(coldDenied.allowedActions, ['start']);
    assert.equal(coldDenied.checkpoint, undefined);
    assert.equal(coldDenied.operationId, deniedHandle.allocation.operationId.value);
    assert.equal(coldDenied.executionEpoch, deniedHandle.allocation.executionEpoch);
    assert.equal(cold.taskSnapshot(postAdmissionTask.taskId).state, 'blocked');
    assert.deepEqual(cold.taskSnapshot(postAdmissionTask.taskId).allowedActions, []);
    assert.equal(cold.taskSnapshot(untouchedTask.taskId).state, 'created');
    assert.deepEqual(cold.taskSnapshot(untouchedTask.taskId).allowedActions, ['start']);

    // The durably projected inventory agrees: no checkpoint is invented for the
    // denial, the post-admission duty stays recoverable, the untouched task
    // keeps its created state.
    const [deniedDurable, postDurable, untouchedDurable] = await durableEntries(journalPath, checkpointPath, [
      deniedTask.taskId.value,
      postAdmissionTask.taskId.value,
      untouchedTask.taskId.value,
    ]);
    assert.equal(deniedDurable?.durableState, 'admission-denied');
    assert.equal(deniedDurable?.snapshot.state, 'blocked');
    assert.deepEqual(deniedDurable?.snapshot.allowedActions, ['start']);
    assert.equal(deniedDurable?.snapshot.checkpoint, undefined);
    assert.equal(postDurable?.durableState, 'recovery-required');
    assert.equal(postDurable?.snapshot.state, 'unknown');
    assert.deepEqual(postDurable?.snapshot.allowedActions, []);
    assert.equal(untouchedDurable?.durableState, 'unstarted');
    assert.equal(untouchedDurable?.snapshot.state, 'created');
    assert.deepEqual(untouchedDurable?.snapshot.allowedActions, ['start']);

    // The cold denied task prepares again through the same original consumer.
    const retried = createPreparedExecutionConsumer({ coordinator: cold, preparedJournal: recording })
      .prepareRun(deniedTask.taskId, {
        prompt: 'denied prompt retry',
        operationId: id('operation', 'denied-operation-retry'),
      });
    assert.ok(retried.allocation.operationId.value !== deniedHandle.allocation.operationId.value, 'cold start mints a new operation');
    assert.ok(retried.allocation.executionEpoch !== deniedHandle.allocation.executionEpoch, 'cold start advances the epoch');
    assert.equal(retried.allocation.executionEpoch, deniedHandle.allocation.executionEpoch + 1);
    assert.equal(cold.taskSnapshot(deniedTask.taskId).operationId, retried.allocation.operationId.value);
    const retriedRelease = await retried.release();
    assert.equal(retriedRelease.state, 'released');
    await waitForState(cold, deniedTask.taskId, 'succeeded');
    assert.equal(retriedDrivers.get(retried.allocation.operationId.value)?.starts, 1);

    // A synchronous append failure on the marked denial must reject the release
    // with both original errors and must not release the prepared slot. This is
    // the single fault injection: only the marked append fails before disk.
    const failingPath = join(root, 'failing.jsonl');
    const failingRecording = new DenialRecordingJournal(new UiRuntimeJournal(failingPath));
    const persistenceError = new Error('injected denial persistence failure');
    failingRecording.injectFailure = persistenceError;
    const failingCheckpointPath = join(root, 'failing-checkpoint.jsonl');
    const failing = denialCoordinator(failingRecording, failingCheckpointPath, {
      async admitExecution() { throw denialError; },
      async createDriver(): Promise<RuntimeExecutionDriver> {
        throw new Error('the injected denial must never construct a driver');
      },
    });
    const failingTask = failing.createTask({ title: 'failing task', directive: 'directive failing' });
    const failingRelease = await settleRelease(
      createPreparedExecutionConsumer({ coordinator: failing, preparedJournal: failingRecording })
        .prepareRun(failingTask.taskId, { prompt: 'failing prompt' })
        .release(),
    );
    if (!(failingRelease instanceof AggregateError)) {
      throw new Error('a failed denial append must reject with an AggregateError');
    }
    assert.equal(failingRelease.errors.length, 2);
    assert.equal(failingRelease.errors[0], denialError);
    assert.equal(failingRelease.errors[1], persistenceError);
    assert.ok(!failing.taskSnapshot(failingTask.taskId).allowedActions.includes('start'),
      'a denial that failed to persist never releases the prepared slot');

    const failingCold = denialCoordinator(new UiRuntimeJournal(failingPath), failingCheckpointPath, {
      async admitExecution() { throw new Error('cold failing admission must not run'); },
      async createDriver(): Promise<RuntimeExecutionDriver> {
        throw new Error('cold failing driver must not run');
      },
    });
    await failingCold.hydrate();
    assert.deepEqual(failingCold.taskSnapshot(failingTask.taskId).allowedActions, [],
      'an unpersisted denial still requires recovery');
  } finally {
    // This unique child is the only fixture resource this consumer owns.
    await rm(root, { recursive: true });
  }
});
