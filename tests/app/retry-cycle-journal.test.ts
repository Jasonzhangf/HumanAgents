import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type EvidenceRef, type ProviderBinding, type ScopeRef } from '../../packages/contracts/src/index.js';
import { createJsonlRetryCycleJournalPort } from '../../packages/app/src/retry-cycle-journal.js';
import type { RetryCycleControlRecord } from '../../packages/runtime/src/orchestration/retry-cycle.js';

const scope: ScopeRef = { organId: id('organ', 'organ-a') };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'retry-cycle-journal-test',
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

function cycleRecord(overrides: Partial<RetryCycleControlRecord> = {}): RetryCycleControlRecord {
  return {
    assignmentId: 'assignment-a',
    initialExecutionEpoch: 1,
    retryBudget: { initialAttempt: 1, maxRetries: 10 },
    state: 'admitted',
    candidateSetSnapshot: {
      configRevision: 'rev-1',
      configDigest: 'sha256:config-1',
      orderedCandidates: [
        {
          bindingId: binding('provider-a').bindingId,
          bindingFingerprint: 'sha256:provider-a-fingerprint',
        },
      ],
    },
    attempts: [],
    exclusions: [],
    admissionSnapshots: [],
    ...overrides,
  };
}

test('retry cycle records persist and replay the latest state through the JSONL journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-retry-cycle-journal-'));
  const filePath = join(root, 'retry-cycle.jsonl');
  try {
    const first = createJsonlRetryCycleJournalPort({ filePath });
    const persisted = await first.persistCycle(cycleRecord());
    assert.deepEqual(persisted, cycleRecord());

    const second = createJsonlRetryCycleJournalPort({ filePath });
    const loaded = await second.loadCycle('retry-cycle:assignment-a:1');
    assert.deepEqual(loaded, cycleRecord());

    const running = cycleRecord({
      state: 'running',
      attempts: [{
        attempt: 1,
        executionEpoch: 1,
        bindingId: 'provider-a',
        evidenceRefs: [evidence('attempt-a')],
        settleState: 'unsettled',
      }],
      admissionSnapshots: [{
        executionEpoch: 1,
        bindingId: 'provider-a',
        bindingFingerprint: 'sha256:provider-a-fingerprint',
        permissionRevision: 'perm-a',
        capabilityDigest: 'cap-a',
        readinessRef: 'readiness-a',
        leaseRef: 'lease-a',
        checkpointRef: 'checkpoint-a',
        admissionDigest: 'sha256:admission-a',
      }],
    });
    await second.persistCycle(running);

    const retrySafe = cycleRecord({
      state: 'retry-safe',
      attempts: [{
        attempt: 1,
        executionEpoch: 1,
        bindingId: 'provider-a',
        operationRef: 'operation-retry-safe',
        failureRef: 'failure-a',
        evidenceRefs: [evidence('attempt-a'), evidence('failure-a')],
        settleState: 'retry-safe',
      }],
      exclusions: [{
        bindingId: 'provider-a',
        failedExecutionEpoch: 1,
        failureRef: 'failure-a',
        evidenceRefs: [evidence('failure-a')],
      }],
    });
    await second.persistCycle(retrySafe);

    const latest = await second.loadCycle('retry-cycle:assignment-a:1');
    assert.equal(latest?.state, 'retry-safe');
    assert.equal(latest?.attempts[0]?.settleState, 'retry-safe');
    assert.equal(latest?.exclusions[0]?.bindingId, 'provider-a');
    assert.equal(latest?.attempts[0]?.evidenceRefs[0]?.evidenceId.value, 'evidence-attempt-a');
    assert.equal(latest?.attempts[0]?.evidenceRefs[1]?.evidenceId.value, 'evidence-failure-a');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retry cycle journal is the only durable writer and keeps evidence refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-retry-cycle-journal-evidence-'));
  const filePath = join(root, 'retry-cycle.jsonl');
  try {
    const journal = createJsonlRetryCycleJournalPort({ filePath });
    const record = cycleRecord({
      attempts: [{
        attempt: 1,
        executionEpoch: 1,
        bindingId: 'provider-a',
        evidenceRefs: [evidence('attempt-a')],
        settleState: 'unsettled',
      }],
    });
    await journal.persistCycle(record);
    const loaded = await journal.loadCycle('retry-cycle:assignment-a:1');
    assert.equal(loaded?.attempts[0]?.evidenceRefs[0]?.evidenceId.value, 'evidence-attempt-a');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
