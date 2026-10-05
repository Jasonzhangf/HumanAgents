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

test('domain authority admits an unexpired matching claim and preserves no-claim first admission', () => {
  const active = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    claim,
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:04:00Z',
  });
  assert.equal(active.kind, 'first-admission');
  assert.equal(active.mutation, 'admitted');
  assert.equal(active.dispatchAllowed, true);
  assert.equal(active.recoveryAllowed, false);
  if (active.kind !== 'first-admission') throw new Error('expected first admission');
  assert.equal(active.record.admittedAt, '2026-10-05T00:04:00Z');

  const withoutClaim = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:00:00Z',
  });
  assert.equal(withoutClaim.kind, 'first-admission');
  assert.equal(withoutClaim.mutation, 'admitted');
  assert.equal(withoutClaim.dispatchAllowed, true);
});

test('domain authority rejects matching claims at and after expiry before first admission mutation', () => {
  for (const nowAt of ['2026-10-05T00:05:00Z', '2026-10-05T00:06:00Z']) {
    const expired = decideOccurrenceAuthority({
      binding,
      authoritativeBinding: binding,
      claim,
      authenticatedCaller: ownerA,
      committedReplacement: false,
      nowAt,
    });
    assert.equal(expired.kind, 'lease-expired');
    assert.equal(expired.mutation, 'none');
    assert.equal(expired.dispatchAllowed, false);
    assert.equal(expired.recoveryAllowed, false);
    assert.equal('record' in expired, false);
  }

  const expired = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    claim,
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:06:00Z',
  });
  assert.equal(expired.kind, 'lease-expired');
  assert.equal(expired.mutation, 'none');
  assert.equal(expired.dispatchAllowed, false);
  assert.equal(expired.recoveryAllowed, false);
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
  const currentWithoutClaim = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    admission,
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:06:00Z',
  });
  assert.equal(currentWithoutClaim.kind, 'current-owner');
  assert.equal(currentWithoutClaim.mutation, 'mutation-allowed');

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

test('domain authority rejects an expired provided claim for the current owner', () => {
  const expiredCurrent = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    admission,
    claim,
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:06:00Z',
  });
  assert.equal(expiredCurrent.kind, 'lease-expired');
  assert.equal(expiredCurrent.mutation, 'none');
  assert.equal(expiredCurrent.dispatchAllowed, false);
  assert.equal(expiredCurrent.recoveryAllowed, false);
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

test('domain authority permits committed replacement recovery after the original claim expires', () => {
  const recovered = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    admission,
    claim,
    authenticatedCaller: ownerB,
    committedReplacement: true,
    nowAt: '2026-10-05T00:06:00Z',
  });
  assert.equal(recovered.kind, 'recovery-allowed');
  assert.equal(recovered.mutation, 'blocked-recovery-only');
  assert.equal(recovered.dispatchAllowed, false);
  assert.equal(recovered.recoveryAllowed, true);
  if (recovered.kind !== 'recovery-allowed') throw new Error('expected recovery');
  assert.equal(recovered.authenticatedOwner.daemonLeaseId, ownerB.daemonLeaseId);
  assert.equal(recovered.admission.binding.occurrenceId, binding.occurrenceId);
  assert.equal(recovered.admission.binding.executionEpoch, binding.executionEpoch);
  assert.equal(recovered.admission.admittedExecutionOwner.daemonLeaseId, ownerA.daemonLeaseId);
  assert.equal(recovered.admission.admittedExecutionOwner.daemonGeneration, ownerA.daemonGeneration);
  assert.equal(recovered.admission.admittedExecutionOwner.processStartToken, ownerA.processStartToken);
});

test('domain authority rejects a supplied claim that does not bind the occurrence identity', () => {
  const mismatchedClaims: readonly OccurrenceClaim[] = [
    { ...claim, occurrenceId: 'subscription-b::1::1', subscriptionId: 'subscription-b' },
    { ...claim, occurrenceId: 'subscription-a::2::1', scheduleRevision: 2 },
    { ...claim, occurrenceId: 'subscription-a::1::2', occurrenceOrdinal: 2 },
    { ...claim, executionEpoch: 2 },
  ];

  for (const mismatchedClaim of mismatchedClaims) {
    const current = decideOccurrenceAuthority({
      binding,
      authoritativeBinding: binding,
      admission,
      claim: mismatchedClaim,
      authenticatedCaller: ownerA,
      committedReplacement: false,
      nowAt: '2026-10-05T00:01:00Z',
    });
    assert.equal(current.kind, 'claim-mismatch');
    assert.equal(current.mutation, 'none');
    assert.equal(current.dispatchAllowed, false);
    assert.equal(current.recoveryAllowed, false);

    const recovery = decideOccurrenceAuthority({
      binding,
      authoritativeBinding: binding,
      admission,
      claim: mismatchedClaim,
      authenticatedCaller: ownerB,
      committedReplacement: true,
      nowAt: '2026-10-05T00:01:00Z',
    });
    assert.equal(recovery.kind, 'claim-mismatch');
    assert.equal(recovery.mutation, 'none');
    assert.equal(recovery.dispatchAllowed, false);
    assert.equal(recovery.recoveryAllowed, false);
  }
});

test('domain authority rejects a mismatched supplied claim during first admission', () => {
  const mismatchedClaim: OccurrenceClaim = {
    ...claim,
    occurrenceId: 'other::1::1',
    subscriptionId: 'other',
  };
  const decision = decideOccurrenceAuthority({
    binding,
    authoritativeBinding: binding,
    claim: mismatchedClaim,
    authenticatedCaller: ownerA,
    committedReplacement: false,
    nowAt: '2026-10-05T00:01:00Z',
  });
  assert.equal(decision.kind, 'claim-mismatch');
  assert.equal(decision.mutation, 'none');
  assert.equal(decision.dispatchAllowed, false);
  assert.equal(decision.recoveryAllowed, false);
});

test('successful verification keeps resource recovery responsibility until confirmed release', () => {
  const cases = [
    ['possible', admission.recoveryResponsibility, true, false],
    ['confirmed-present', {
      providerEffectState: 'confirmed-present' as const,
      resourceInventory: [evidence],
      releaseProofs: [],
    }, true, false],
    ['confirmed-released', {
      providerEffectState: 'confirmed-released' as const,
      resourceInventory: [evidence],
      releaseProofs: [evidence],
    }, false, true],
  ] as const;

  for (const [state, recoveryResponsibility, recoveryRequired, resourceReleaseConfirmed] of cases) {
    const receipt = terminal('success');
    const decision = decideOccurrenceTerminalReceipt({
      binding,
      terminalReceipt: receipt,
      recoveryResponsibility,
    });
    assert.equal(state, recoveryResponsibility.providerEffectState);
    assert.equal(decision.outcome, 'succeeded');
    assert.equal(decision.checkpointOutcome, 'succeeded');
    assert.equal(decision.terminalReceipt, receipt);
    assert.equal(decision.record.terminalOutcome, 'succeeded');
    assert.equal(decision.record.terminalCheckpointRef, receipt.terminalCheckpointRef);
    assert.equal(decision.record.settlementReceiptRef, receipt.settlementReceiptRef);
    assert.deepEqual(decision.record.verification, receipt.verification);
    assert.deepEqual(decision.record.recoveryResponsibility, recoveryResponsibility);
    assert.equal(decision.recoveryRequired, recoveryRequired);
    assert.equal(decision.resourceReleaseConfirmed, resourceReleaseConfirmed);
  }
});

test('terminal decisions preserve all verification outcomes and non-success resource states', () => {
  for (const [status, outcome, checkpointOutcome] of [
    ['success', 'succeeded', 'succeeded'],
    ['failed', 'failed', 'failed'],
    ['rejected', 'rejected', 'failed'],
    ['missing', 'missing', 'blocked'],
    ['blocked', 'blocked', 'blocked'],
    ['cancelled', 'cancelled', 'cancelled'],
  ] as const) {
    for (const [providerEffectState, recoveryRequired] of [
      ['possible', true],
      ['confirmed-present', true],
      ['confirmed-released', false],
    ] as const) {
      const recoveryResponsibility = {
        providerEffectState,
        resourceInventory: [evidence],
        releaseProofs: providerEffectState === 'confirmed-released' ? [evidence] : [],
      };
      const receipt = terminal(status);
      const decision = decideOccurrenceTerminalReceipt({
        binding,
        terminalReceipt: receipt,
        recoveryResponsibility,
      });
      assert.equal(decision.outcome, outcome);
      assert.equal(decision.checkpointOutcome, checkpointOutcome);
      assert.equal(decision.record.verification.status, status);
      assert.deepEqual(decision.record.verification, receipt.verification);
      assert.deepEqual(decision.record.recoveryResponsibility, recoveryResponsibility);
      assert.equal(decision.recoveryRequired, recoveryRequired);
      assert.equal(decision.resourceReleaseConfirmed, providerEffectState === 'confirmed-released');
    }
  }
});

test('optional recovery responsibility preserves existing absence behavior', () => {
  const successful = decideOccurrenceTerminalReceipt({
    binding,
    terminalReceipt: terminal('success'),
  });
  assert.equal(successful.outcome, 'succeeded');
  assert.equal(successful.recoveryRequired, false);
  assert.equal(successful.resourceReleaseConfirmed, false);
  assert.equal('recoveryResponsibility' in successful.record, false);

  const failed = decideOccurrenceTerminalReceipt({
    binding,
    terminalReceipt: terminal('failed'),
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.recoveryRequired, true);
  assert.equal(failed.resourceReleaseConfirmed, false);
  assert.equal('recoveryResponsibility' in failed.record, false);
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
