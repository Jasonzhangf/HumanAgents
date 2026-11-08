import assert from 'node:assert/strict';
import test from 'node:test';

import {
  id,
  type AgentEvent,
  type Checkpoint,
  type EvidenceRef,
  type ProviderCloseResult,
  type TaskId,
} from '../../../packages/contracts/src/index.js';
import {
  RuntimeTaskCoordinator,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeTaskJournalPort,
  type RuntimeTaskJournalRecord,
} from '../../../packages/runtime/src/ui-runtime/coordinator.js';
import { checkpointCommitId } from '../../../packages/runtime/src/checkpoints/coordinator.js';
import type { CommittedCheckpointRecord } from '../../../packages/runtime/src/checkpoints/ports.js';

const organId = id('organ', 'post-checkpoint-recovery-organ');
const socketMessage = 'terminated (cause: SocketError [UND_ERR_SOCKET]: other side closed)';

function evidence(scope: { readonly organId: ReturnType<typeof id<'organ'>>; readonly taskId?: TaskId }, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `post-checkpoint-recovery-${label}`),
    kind: 'operation',
    source: 'post-checkpoint-recovery-test',
    locator: label,
    scope,
  };
}

class MemoryTaskJournal implements RuntimeTaskJournalPort {
  readonly records: RuntimeTaskJournalRecord[] = [];

  append(record: RuntimeTaskJournalRecord): void {
    this.records.push(structuredClone(record));
  }

  replay(): readonly RuntimeTaskJournalRecord[] {
    return structuredClone(this.records);
  }
}

/**
 * Minimal driver whose canonical turn commits its closing checkpoint and then
 * fails the mandatory Planner alignment on a transport close. Real adapter
 * code wraps that same SocketError as a ProviderAdapterError; the coordinator
 * only needs the message and the committed checkpoint to classify the failure
 * as post-commit recovery instead of losing the turn's committed result.
 */
class PostCommitAlignFailureDriver implements RuntimeExecutionDriver {
  readonly kind = 'post-checkpoint-recovery.fake-driver';

  constructor(readonly input: RuntimeExecutionDriverInput) {}

  async capabilities() {
    return { driverKind: this.kind, capabilities: ['execute'], version: '1' };
  }

  async start(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async resume(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async submit(input: Parameters<RuntimeExecutionDriver['submit']>[0]) {
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
    const { taskId, executionEpoch } = this.input;
    yield {
      taskId,
      executionEpoch,
      kind: 'terminal',
      terminalState: 'succeeded',
      evidenceRefs: [],
    };
  }

  async requestStop(input: Parameters<RuntimeExecutionDriver['requestStop']>[0]) {
    return { requested: true, operationId: input.operationId };
  }

  async settle() {
    return { state: 'succeeded' as const, evidenceRefs: [] };
  }

  async close(): Promise<ProviderCloseResult> {
    return {
      bindingId: 'post-checkpoint-recovery-binding',
      providerId: 'post-checkpoint-recovery-provider',
      protocol: 'responses',
      state: 'closed' as const,
      evidenceRefs: [],
    };
  }

  private committed: CommittedCheckpointRecord | undefined;

  readonly standardTurn = {
    acceptReviews: async () => {},
    readCheckpoint: async (): Promise<CommittedCheckpointRecord> => {
      if (this.committed) return this.committed;
      const refs = [evidence(this.input.scope, 'checkpoint')];
      const checkpoint: Checkpoint = {
        id: id('checkpoint', `post-checkpoint-recovery-${this.input.operationId.value}`),
        scope: this.input.scope,
        cycleId: this.input.scope.cycleId!,
        seq: 1,
        previousCheckpointId: null,
        directiveRevision: 1,
        executionEpoch: this.input.executionEpoch,
        outcome: 'succeeded',
        summary: 'execution result committed',
        recoveryStateRef: refs[0]!,
        evidenceRefs: refs,
        next: { kind: 'continue' },
      };
      this.committed = {
        checkpoint,
        previous: null,
        commitRef: {
          commitId: checkpointCommitId(checkpoint),
          journalSeq: 1,
          recordDigest: `sha256:${'9'.repeat(64)}`,
        },
      };
      return this.committed;
    },
    align: async (): Promise<never> => {
      throw new Error(socketMessage);
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForTerminal(runtime: RuntimeTaskCoordinator, taskId: TaskId): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = runtime.taskSnapshot(taskId).state;
    if (state === 'succeeded' || state === 'failed' || state === 'blocked') return;
    await tick();
  }
  throw new Error(`runtime did not finish; state=${runtime.taskSnapshot(taskId).state}`);
}

test('post-checkpoint Planner transport close retains the committed checkpoint as recovery', async () => {
  const journal = new MemoryTaskJournal();
  const runtime = new RuntimeTaskCoordinator({
    organId,
    taskIdPrefix: 'post-checkpoint-recovery',
    admitExecution: async () => {},
    createDriver: (input) => new PostCommitAlignFailureDriver(input),
    checkpointStoreFor: () => ({
      async verify() { return { valid: true as const }; },
      async readLatest() { return null; },
      async readCommitted() { return null; },
      async listCommitted() { return { checkpoints: [] }; },
      async readExecutionPosition() { return null; },
      async readCheckpointRecoveryBinding() { return null; },
      async append(input) { return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq }; },
      async commit(checkpoint) { return { checkpointId: checkpoint.id, committed: true as const }; },
    }),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
    currentStatePort: {
      async read() { return { state: 'unknown', reason: 'no committed state in this fixture' }; },
      async commit(input) {
        return { commitId: `commit-${input.transitionId}`, journalSeq: 1, recordDigest: `sha256:${'0'.repeat(64)}` };
      },
    },
    currentStateFacts: {
      async read() {
        return {
          state: 'known',
          value: {
            turn: {
              phase: 'open',
              ownerRef: 'post-checkpoint-recovery-fixture',
              nextAction: { kind: 'continue' },
              laterErrorRefs: [],
              unresolvedOperationRefs: [],
            },
            stages: { state: 'known', stages: [] },
          },
        };
      },
    },
    journal,
  });
  const task = runtime.createTask({
    title: 'post-checkpoint recovery',
    directive: 'keep the committed checkpoint after a Planner transport close',
  });
  const { operationId } = runtime.startExecution(task.taskId, { prompt: 'bounded work' });
  await waitForTerminal(runtime, task.taskId);

  const snapshot = runtime.taskSnapshot(task.taskId);
  assert.equal(snapshot.state, 'blocked');
  assert.equal(snapshot.currentState, 'checkpoint 已提交，等待恢复');
  assert.ok(snapshot.checkpoint, 'the committed checkpoint must remain on the task');
  assert.ok(snapshot.error?.message.includes('SocketError'), 'the exact transport cause must survive');

  const terminal = runtime.eventsSince(operationId)
    .find((event) => event.kind === 'execution.terminal');
  if (!terminal) throw new Error('a terminal event must exist');
  assert.equal(terminal.summary, 'checkpoint committed; post-commit lifecycle requires recovery');
  assert.equal(terminal.state, 'blocked');
  assert.equal(terminal.retryable, true);
});
