import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoreError,
  SubscriptionControlError,
  assertVerifiedTerminalReceipt,
  decideOccurrenceAuthority,
  decideOccurrenceTerminalReceipt,
} from '../../packages/core/src/index.js';
import {
  id,
  occurrenceExecutionDispatchRef,
  type EvidenceRef,
  type OccurrenceClaim,
  type OccurrenceExecutionAdmissionRecord,
  type OccurrenceExecutionOwner,
  type OccurrenceTaskBinding,
  type ScopeRef,
  type ServeTaskTerminalReceipt,
  type TaskVerificationResult,
} from '../../packages/contracts/src/index.js';

const task = id('task', 'task-a');
const operation = id('operation', 'operation-a');
const scope: ScopeRef = {
  organId: id('organ', 'organ-a'),
  taskId: task,
  cycleId: id('cycle', 'cycle-a'),
  operationId: operation,
};
const inputArtifactDigest = `sha256:${'a'.repeat(64)}`;
const evidence: EvidenceRef = {
  evidenceId: id('evidence', 'evidence-a'),
  kind: 'operation',
  source: 'public-consumer',
  locator: 'occurrence-authority-public-consumer.test.ts',
  scope,
};

const binding: OccurrenceTaskBinding = {
  occurrenceId: 'subscription-a::1::1',
  subscriptionId: 'subscription-a',
  scheduleRevision: 1,
  occurrenceOrdinal: 1,
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
  inputArtifactDigest,
};

const ownerA: OccurrenceExecutionOwner = {
  daemonLeaseId: 'lease-a',
  daemonGeneration: 1,
  processStartToken: 'process-token-a',
};

const ownerB: OccurrenceExecutionOwner = {
  daemonLeaseId: 'lease-b',
  daemonGeneration: 2,
  processStartToken: 'process-token-b',
};

const claim: OccurrenceClaim = {
  occurrenceId: binding.occurrenceId,
  subscriptionId: binding.subscriptionId,
  scheduleRevision: binding.scheduleRevision,
  occurrenceOrdinal: binding.occurrenceOrdinal,
  claimedBy: 'scheduler-a',
  leaseId: 'lease-a',
  schedulerInstanceId: 'scheduler-a',
  generation: 1,
  executionEpoch: 1,
  acquiredAt: '2026-10-05T00:00:00Z',
  expiresAt: '2026-10-05T00:05:00Z',
};

const admission: OccurrenceExecutionAdmissionRecord = {
  kind: 'occurrence-execution-admission',
  version: 1,
  binding,
  dispatchRef: occurrenceExecutionDispatchRef(binding),
  admittedAt: '2026-10-05T00:00:00Z',
  admittedExecutionOwner: ownerA,
  recoveryResponsibility: {
    providerEffectState: 'possible',
    resourceInventory: [evidence],
    releaseProofs: [],
  },
};

function verification(status: TaskVerificationResult['status']): TaskVerificationResult {
  return {
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    attempt: 1,
    inputArtifactDigest,
    policyRef: 'verification-policy://default/a',
    policyDigest: `sha256:${'b'.repeat(64)}`,
    status,
    ...(status === 'rejected' ? { rejectionCode: 'checker-rejected' as const } : {}),
    checks: status === 'success'
      ? [{
          checkId: 'native-default-output',
          kind: 'native' as const,
          status: 'succeeded' as const,
          decisionRef: 'decision://success',
          decisionDigest: `sha256:${'c'.repeat(64)}`,
          artifactDigests: [],
          evidenceRefs: [evidence],
        }]
      : [],
    evidenceRefs: [evidence],
  };
}

function terminal(status: TaskVerificationResult['status']): ServeTaskTerminalReceipt {
  return {
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    inputArtifactDigest,
    verification: verification(status),
    terminalCheckpointRef: `checkpoint://task-a/${status}`,
    settlementReceiptRef: `settlement://task-a/${status}`,
  };
}

test('domain authority admits only a validated first binding with an authenticated owner', () => {
  const decision = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:00:00Z',
  });
  assert.equal(decision.kind, 'first-admission');
  assert.equal(decision.dispatchAllowed, true);
  if (decision.kind !== 'first-admission') throw new Error('expected first admission');
  assert.equal(decision.admittedExecutionOwner.daemonLeaseId, ownerA.daemonLeaseId);
  assert.equal(decision.record.binding.occurrenceId, binding.occurrenceId);
});

test('domain authority rejects binding mismatch and missing persisted owner', () => {
  const mismatch = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: {
      ...binding,
      inputArtifactDigest: `sha256:${'d'.repeat(64)}`,
    },
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:00:00Z',
  });
  assert.equal(mismatch.kind, 'binding-mismatch');
  assert.equal(mismatch.dispatchAllowed, false);

  const missingOwner = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    admission: {
      ...admission,
      admittedExecutionOwner: undefined,
    } as never,
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:00:00Z',
  });
  assert.equal(missingOwner.kind, 'invalid-admission');
  assert.equal(missingOwner.recoveryAllowed, false);
});

test('domain authority compares immutable owner A with authenticated caller B', () => {
  const current = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    admission,
    claim,
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:01:00Z',
  });
  assert.equal(current.kind, 'current-owner');
  assert.equal(current.recoveryAllowed, false);

  const unproven = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    admission,
    claim,
    authenticatedCaller: ownerB,
    committedReplacement: false,
    nowAt: '2026-10-05T00:01:00Z',
  });
  assert.equal(unproven.kind, 'stale-owner');
  assert.equal(unproven.dispatchAllowed, false);

  const expired = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    admission,
    claim,
    authenticatedCaller: ownerB,
    committedReplacement: false,
    nowAt: '2026-10-05T00:06:00Z',
  });
  assert.equal(expired.kind, 'lease-expired');
  assert.equal(expired.recoveryAllowed, false);
});

test('domain authority permits recovery only for a committed owner replacement', () => {
  const recovered = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    admission,
    claim,
    authenticatedCaller: ownerB,
    committedReplacement: true,
    nowAt: '2026-10-05T00:01:00Z',
  });
  assert.equal(recovered.kind, 'recovery-allowed');
  assert.equal(recovered.dispatchAllowed, false);
  assert.equal(recovered.recoveryAllowed, true);
  if (recovered.kind !== 'recovery-allowed') throw new Error('expected recovery');
  assert.equal(recovered.admission.binding.occurrenceId, binding.occurrenceId);
  assert.equal(recovered.admission.admittedExecutionOwner.daemonLeaseId, ownerA.daemonLeaseId);
});

test('domain terminal decisions preserve all non-success statuses and original evidence', () => {
  for (const [status, outcome] of [
    ['success', 'succeeded'],
    ['failed', 'failed'],
    ['rejected', 'rejected'],
    ['missing', 'missing'],
    ['blocked', 'blocked'],
    ['cancelled', 'cancelled'],
  ] as const) {
    const decision = decideOccurrenceTerminalReceipt({
      binding,
      terminalReceipt: terminal(status),
      recoveryResponsibility: admission.recoveryResponsibility,
    });
    assert.equal(decision.outcome, outcome);
    assert.equal(decision.record.verification.status, status);
    assert.equal(decision.resourceReleaseConfirmed, false);
  }
});

test('strict success assertion rejects non-success terminal receipts', () => {
  assert.throws(
    () => assertVerifiedTerminalReceipt({
      occurrence: {
        occurrenceId: binding.occurrenceId,
        subscriptionId: binding.subscriptionId,
        scheduleRevision: binding.scheduleRevision,
        occurrenceOrdinal: binding.occurrenceOrdinal,
        state: 'due',
        dueAt: '2026-10-05T00:00:00Z',
      },
      taskId: task,
      operationId: operation,
      executionEpoch: 1,
      inputArtifactDigest,
      terminal: terminal('failed'),
    }),
    SubscriptionControlError,
  );
});
