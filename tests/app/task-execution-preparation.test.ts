import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type AgentEvent, type ProviderCloseResult, type ProviderEvent, type TaskId } from '../../packages/contracts/src/index.js';
import { AppLifecycleError } from '../../packages/app/src/errors.js';
import {
  createPreparedExecutionConsumer,
} from '../../packages/app/src/task-execution-preparation.js';
import { readPreparedExecutionInput } from '../../packages/app/src/prepared-execution-input.js';
import { FileCheckpointStore, UiRuntimeJournal } from '../../packages/app/src/ui-runtime/journal.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
  type RuntimeExecutionAllocation,
  type RuntimeExecutionDriver,
  type RuntimeExecutionPreparationInput,
  type RuntimeTaskCoordinatorOptions,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';

const fixtureRoot =
  process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-cli-prepared-consumer-r1-20261013');

function buildCoordinator(
  journal: UiRuntimeJournal,
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
