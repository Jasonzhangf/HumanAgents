import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  OCCURRENCE_EXECUTION_ADMISSION_RECORD_VERSION,
  OCCURRENCE_TERMINAL_RECEIPT_RECORD_VERSION,
  id,
  occurrenceExecutionAdmissionCommitId,
  occurrenceExecutionDispatchRef,
  occurrenceTerminalReceiptCommitId,
  validateOccurrenceExecutionAdmissionRecord,
  validateOccurrenceExecutionOwner,
  validateOccurrenceTaskBinding,
  validateOccurrenceTerminalReceiptRecord,
  validateRecoveryResponsibilityRecord,
  type Checkpoint,
  type EvidenceRef,
  type OccurrenceExecutionAdmissionRecord,
  type OccurrenceTaskBinding,
  type OccurrenceTerminalReceiptRecord,
  type RecoveryResponsibilityRecord,
  type ScopeRef,
  type TaskVerificationResult,
} from '@humanagent/contracts';

const task = id('task', 'task-a');
const operation = id('operation', 'operation-a');
const evidenceId = id('evidence', 'evidence-a');
const scope: ScopeRef = {
  organId: id('organ', 'organ-a'),
  taskId: task,
  cycleId: id('cycle', 'cycle-a'),
  operationId: operation,
};
const inputArtifactDigest = `sha256:${'a'.repeat(64)}`;

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

const evidence: EvidenceRef = {
  evidenceId,
  kind: 'operation',
  source: 'public-consumer',
  locator: 'occurrence-admission-public-consumer.test.ts',
  scope,
};

const releaseEvidence: EvidenceRef = {
  ...evidence,
  evidenceId: id('evidence', 'evidence-release-a'),
  kind: 'external',
  locator: 'provider-release',
};

const recoveryResponsibility: RecoveryResponsibilityRecord = {
  providerEffectState: 'possible',
  resourceInventory: [evidence],
  releaseProofs: [releaseEvidence],
};

const verificationFailed: TaskVerificationResult = {
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
  attempt: 1,
  inputArtifactDigest,
  policyRef: 'verification-policy://default/a',
  policyDigest: `sha256:${'b'.repeat(64)}`,
  status: 'failed',
  checks: [{
    checkId: 'native-default-output',
    kind: 'native',
    status: 'failed',
    decisionRef: 'decision://failed',
    decisionDigest: `sha256:${'c'.repeat(64)}`,
    artifactDigests: [],
    evidenceRefs: [evidence],
  }],
  evidenceRefs: [evidence],
};

const admission: OccurrenceExecutionAdmissionRecord = {
  kind: 'occurrence-execution-admission',
  version: OCCURRENCE_EXECUTION_ADMISSION_RECORD_VERSION,
  binding,
  dispatchRef: occurrenceExecutionDispatchRef(binding),
  admittedAt: '2026-10-05T00:00:00Z',
  admittedExecutionOwner: {
    daemonLeaseId: 'lease-a',
    daemonGeneration: 1,
    processStartToken: 'process-token-a',
  },
  recoveryResponsibility,
};

const terminalRecord: OccurrenceTerminalReceiptRecord = {
  kind: 'occurrence-terminal-receipt',
  version: OCCURRENCE_TERMINAL_RECEIPT_RECORD_VERSION,
  binding,
  terminalCheckpointRef: 'checkpoint://task-a/1',
  terminalOutcome: 'failed' satisfies Checkpoint['outcome'],
  verification: verificationFailed,
  recoveryResponsibility,
  settlementReceiptRef: 'settlement://task-a/1',
};

test('public admission consumer accepts the immutable first-admission shape', () => {
  assert.doesNotThrow(() => validateOccurrenceExecutionOwner(admission.admittedExecutionOwner));
  assert.doesNotThrow(() => validateRecoveryResponsibilityRecord(recoveryResponsibility));
  assert.doesNotThrow(() => validateOccurrenceTaskBinding(binding));
  assert.doesNotThrow(() => validateOccurrenceExecutionAdmissionRecord(admission));
  assert.equal(admission.version, 1);
  assert.equal(admission.binding.occurrenceId, binding.occurrenceId);
});

test('public admission consumer rejects missing and wrong persisted owners', () => {
  assert.throws(
    () => validateOccurrenceExecutionAdmissionRecord({ ...admission, admittedExecutionOwner: undefined } as never),
    ContractError,
  );
  assert.throws(
    () => validateOccurrenceExecutionAdmissionRecord({
      ...admission,
      admittedExecutionOwner: {
        ...admission.admittedExecutionOwner,
        daemonGeneration: 0,
      },
    }),
    ContractError,
  );
  assert.throws(
    () => validateOccurrenceExecutionAdmissionRecord({
      ...admission,
      admittedExecutionOwner: {
        ...admission.admittedExecutionOwner,
        processStartToken: '',
      },
    }),
    ContractError,
  );
});

test('public admission consumer rejects a binding mismatch and missing recovery facts', () => {
  assert.throws(
    () => validateOccurrenceExecutionAdmissionRecord({
      ...admission,
      binding: {
        ...binding,
        operationId: id('operation', 'operation-b'),
      },
    }),
    ContractError,
  );
  assert.throws(
    () => validateRecoveryResponsibilityRecord({
      ...recoveryResponsibility,
      providerEffectState: 'confirmed-released',
      releaseProofs: [],
    }),
    ContractError,
  );
  assert.throws(
    () => validateOccurrenceTerminalReceiptRecord({
      ...terminalRecord,
      verification: {
        ...verificationFailed,
        taskId: id('task', 'task-b'),
      },
    }),
    ContractError,
  );
});

test('public receipt keys are stable across terminal facts and binding changes', async () => {
  const firstReceiptKey = await occurrenceTerminalReceiptCommitId(binding);
  const secondReceiptKey = await occurrenceTerminalReceiptCommitId({
    ...binding,
    operationId: id('operation', 'operation-b'),
  });
  const changedCheckpointFacts = await occurrenceTerminalReceiptCommitId({
    ...terminalRecord,
    terminalCheckpointRef: 'checkpoint://task-a/replayed',
  }.binding);
  const changedVerificationFacts = await occurrenceTerminalReceiptCommitId({
    ...terminalRecord,
    verification: {
      ...verificationFailed,
      status: 'success',
      checks: [{
        ...verificationFailed.checks[0],
        status: 'succeeded',
      }],
    },
  }.binding);
  const changedReleaseFacts = await occurrenceTerminalReceiptCommitId({
    ...terminalRecord,
    recoveryResponsibility: {
      providerEffectState: 'confirmed-released',
      resourceInventory: recoveryResponsibility.resourceInventory,
      releaseProofs: recoveryResponsibility.releaseProofs,
    },
  }.binding);
  const changedAdmissionFacts = await occurrenceExecutionAdmissionCommitId(binding);

  assert.match(firstReceiptKey, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(firstReceiptKey, secondReceiptKey);
  assert.equal(firstReceiptKey, changedCheckpointFacts);
  assert.equal(firstReceiptKey, changedVerificationFacts);
  assert.equal(firstReceiptKey, changedReleaseFacts);
  assert.equal(changedAdmissionFacts, await occurrenceExecutionAdmissionCommitId(binding));
});

test('public receipt consumer accepts durable terminal records for non-success outcomes', () => {
  assert.doesNotThrow(() => validateOccurrenceTerminalReceiptRecord(terminalRecord));
  assert.equal(terminalRecord.terminalOutcome, 'failed');
  assert.equal(terminalRecord.verification.status, 'failed');
  assert.equal(terminalRecord.binding.occurrenceId, binding.occurrenceId);
});
