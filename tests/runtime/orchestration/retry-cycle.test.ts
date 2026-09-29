import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type EvidenceRef, type ProviderBinding, type ScopeRef } from '../../../packages/contracts/src/index.js';
import {
  createRetryCycleManager,
  retryCycleId,
  type RetryCycleConfigSet,
  type RetryCycleControlRecord,
  type RetryCycleJournalPort,
} from '../../../packages/runtime/src/orchestration/retry-cycle.js';

const assignmentId = 'assignment-a';
const initialExecutionEpoch = 1;
const scope: ScopeRef = {
  organId: id('organ', 'organ-a'),
  taskId: id('task', 'task-a'),
};

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'retry-cycle-test',
    locator: label,
    scope,
  };
}

function binding(bindingId: string): ProviderBinding {
  return {
    bindingId,
    providerId: `provider-${bindingId}`,
    protocol: 'responses',
    endpointRef: 'rcc-v3:127.0.0.1:4444',
    modelRef: `model-${bindingId}`,
    configDigest: `sha256:${bindingId}-config`,
    capabilityDigest: `sha256:${bindingId}-capability`,
  };
}

function config(candidateIds: readonly string[]): RetryCycleConfigSet {
  return {
    configRevision: 'rev-1',
    configDigest: 'sha256:config-1',
    candidates: candidateIds.map((bindingId) => ({
      binding: binding(bindingId),
      admission: {
        permissionRevision: 'perm-1',
        capabilityDigest: 'cap-1',
        readinessRef: `readiness-${bindingId}`,
        leaseRef: `lease-${bindingId}`,
        checkpointRef: `checkpoint-${bindingId}`,
      },
    })),
  };
}

class MemoryRetryCycleJournal implements RetryCycleJournalPort {
  readonly records = new Map<string, RetryCycleControlRecord>();
  readonly persistedKeys: string[] = [];

  async loadCycle(cycleId: string): Promise<RetryCycleControlRecord | null> {
    const record = this.records.get(cycleId);
    return record ? structuredClone(record) : null;
  }

  async persistCycle(record: RetryCycleControlRecord): Promise<RetryCycleControlRecord> {
    const cycleId = `retry-cycle:${record.assignmentId}:${record.initialExecutionEpoch}`;
    this.persistedKeys.push(cycleId);
    this.records.set(cycleId, structuredClone(record));
    return structuredClone(record);
  }
}

test('retry cycle keys are always assignmentId + initialExecutionEpoch and persist before dispatch', async () => {
  const journal = new MemoryRetryCycleJournal();
  const manager = createRetryCycleManager({ config: config(['provider-a', 'provider-b']), journal });
  const expectedKey = retryCycleId({ assignmentId, initialExecutionEpoch });
  const first = await manager.begin({ assignmentId, initialExecutionEpoch, scope });

  assert.equal(first.kind, 'dispatch');
  assert.ok(journal.persistedKeys.includes(`retry-cycle:${assignmentId}:${initialExecutionEpoch}`));
  assert.equal(journal.persistedKeys.at(-1), expectedKey);
  assert.equal(expectedKey, journal.persistedKeys.at(-1));
  if (first.kind !== 'dispatch') return;
  assert.equal(first.cycle.assignmentId, assignmentId);
  assert.equal(first.cycle.initialExecutionEpoch, initialExecutionEpoch);
  assert.equal(first.attempt, 1);
  assert.equal(first.executionEpoch, 1);
  assert.equal(first.candidate.binding.bindingId, 'provider-a');
  assert.equal(first.admissionSnapshot.bindingId, 'provider-a');
  assert.equal(first.admissionSnapshot.executionEpoch, 1);
  assert.ok(first.admissionSnapshot.admissionDigest.startsWith('sha256:'));
});

test('retry-safe provider A failure excludes provider A and dispatches provider B with a new admission snapshot', async () => {
  const journal = new MemoryRetryCycleJournal();
  const manager = createRetryCycleManager({ config: config(['provider-a', 'provider-b']), journal });
  await manager.begin({ assignmentId, initialExecutionEpoch, scope });

  const failed = await manager.recordFailure({
    assignmentId,
    initialExecutionEpoch,
    attempt: 1,
    executionEpoch: 1,
    bindingId: 'provider-a',
    failureRef: 'failure-a',
    evidenceRefs: [evidence('failure-a')],
    settleState: 'retry-safe',
  });
  assert.equal(failed.kind, 'dispatch');
  if (failed.kind !== 'dispatch') return;
  assert.equal(failed.attempt, 2);
  assert.equal(failed.executionEpoch, 2);
  assert.equal(failed.candidate.binding.bindingId, 'provider-b');
  assert.equal(failed.admissionSnapshot.bindingId, 'provider-b');
  assert.equal(failed.admissionSnapshot.executionEpoch, 2);
  assert.deepEqual(failed.cycle.exclusions.map((exclusion) => exclusion.bindingId), ['provider-a']);
  assert.equal(failed.cycle.exclusions[0]!.failedExecutionEpoch, 1);
});

test('unknown unsettled failure blocks attention and does not switch provider', async () => {
  const journal = new MemoryRetryCycleJournal();
  const manager = createRetryCycleManager({ config: config(['provider-a', 'provider-b']), journal });
  await manager.begin({ assignmentId, initialExecutionEpoch, scope });

  const result = await manager.recordFailure({
    assignmentId,
    initialExecutionEpoch,
    attempt: 1,
    executionEpoch: 1,
    bindingId: 'provider-a',
    failureRef: 'unknown-a',
    evidenceRefs: [evidence('unknown-a')],
    settleState: 'unknown',
  });
  assert.equal(result.kind, 'blocked-attention');
  assert.equal(result.cycle.state, 'blocked-attention');
  assert.equal(result.cycle.exclusions.length, 0);
  if (result.kind !== 'blocked-attention') return;
  assert.ok(result.issue.code.startsWith('retry.'));
});

test('no eligible candidate after exclusions blocks attention instead of dispatching', async () => {
  const journal = new MemoryRetryCycleJournal();
  const manager = createRetryCycleManager({ config: config(['provider-a']), journal });
  await manager.begin({ assignmentId, initialExecutionEpoch, scope });

  const result = await manager.recordFailure({
    assignmentId,
    initialExecutionEpoch,
    attempt: 1,
    executionEpoch: 1,
    bindingId: 'provider-a',
    failureRef: 'failure-a',
    evidenceRefs: [evidence('failure-a')],
    settleState: 'retry-safe',
  });
  assert.equal(result.kind, 'blocked-attention');
  assert.equal(result.cycle.state, 'blocked-attention');
  if (result.kind !== 'blocked-attention') return;
  assert.equal(result.issue.code, 'retry.no-candidate');
});

test('retry budget exhausts after settled retry-safe attempt 11', async () => {
  const providerIds = ['provider-a', ...Array.from({ length: 10 }, (_, index) => `provider-${String(index + 2).padStart(2, '0')}`)];
  const journal = new MemoryRetryCycleJournal();
  const manager = createRetryCycleManager({ config: config(providerIds), journal });
  await manager.begin({ assignmentId, initialExecutionEpoch, scope });

  for (let attempt = 1; attempt <= 11; attempt += 1) {
    const bindingId = providerIds[attempt - 1] ?? 'provider-a';
    const result = await manager.recordFailure({
      assignmentId,
      initialExecutionEpoch,
      attempt,
      executionEpoch: attempt,
      bindingId,
      failureRef: `failure-${attempt}`,
      evidenceRefs: [evidence(`failure-${attempt}`)],
      settleState: 'retry-safe',
    });
    if (attempt < 11) {
      assert.equal(result.kind, 'dispatch');
    } else {
      assert.equal(result.kind, 'exhausted');
      assert.equal(result.cycle.state, 'exhausted');
    }
  }
});

test('successful attempt persists success without excluding the winning binding', async () => {
  const journal = new MemoryRetryCycleJournal();
  const manager = createRetryCycleManager({ config: config(['provider-a']), journal });
  await manager.begin({ assignmentId, initialExecutionEpoch, scope });

  const record = await manager.recordSuccess({
    assignmentId,
    initialExecutionEpoch,
    attempt: 1,
    executionEpoch: 1,
    bindingId: 'provider-a',
    evidenceRefs: [evidence('success-a')],
  });
  assert.equal(record.attempts[0]!.settleState, 'success');
  assert.equal(record.attempts[0]!.bindingId, 'provider-a');
  assert.equal(record.exclusions.length, 0);
});
