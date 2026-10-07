// App-owned derivation of one occurrence's durable terminal production.
//
// The single verification truth is the checkpoint the execution coordinator
// really committed for this operation. This module does not run a second
// verification subsystem: it projects that committed outcome and its committed
// evidence into the occurrence consumer's own lifecycle scope, so the consumer
// can persist a terminal receipt that is bound to the same real execution.
import { createHash } from 'node:crypto';

import {
  canonicalJsonStringify,
  id,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionPolicyDefinition,
  type OccurrenceTaskBinding,
  type ScopeRef,
  type TaskVerificationResult,
  type TaskVerificationStatus,
} from '../../../contracts/src/index.js';
import type { OccurrenceClaimRecord } from '../../../runtime/src/subscriptions/ports.js';
import { occurrenceIdentityToken } from './occurrence-identity.js';
import type { OccurrenceTerminalProduction } from './occurrence-consumer.js';

/**
 * The committed checkpoint projection the coordinator exposes for one task.
 * Only these facts are read; the terminal receipt is derived from them.
 */
export interface CommittedExecutionCheckpoint {
  readonly checkpointId: string;
  readonly seq: number;
  readonly outcome: string;
  readonly summary: string;
  readonly committedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

const TERMINAL_OUTCOMES: readonly Checkpoint['outcome'][] = [
  'succeeded',
  'waiting',
  'blocked',
  'failed',
  'cancelled',
  'stopped',
  'unknown',
];

export class OccurrenceTerminalError extends Error {
  readonly code: 'checkpoint-missing' | 'checkpoint-outcome-unknown';

  constructor(code: OccurrenceTerminalError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'OccurrenceTerminalError';
    this.code = code;
  }
}

function digestOf(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify({ domain, value })).digest('hex')}`;
}

/**
 * The committed coordinator outcome projected onto a verification status. The
 * mapping is total and one-way: `success` is only reachable from a really
 * committed `succeeded` checkpoint, and every other outcome stays a non-success
 * terminal that keeps recovery responsibility.
 */
export function verificationStatusForCommittedOutcome(outcome: string): TaskVerificationStatus {
  switch (outcome) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'stopped':
      return 'cancelled';
    case 'waiting':
    case 'blocked':
    case 'unknown':
      return 'blocked';
    default:
      throw new OccurrenceTerminalError('checkpoint-outcome-unknown', `committed checkpoint outcome is not terminal: ${outcome}`);
  }
}

/**
 * The consumer-side checkpoint outcome that `decideOccurrenceTerminalReceipt`
 * derives from the verification status. It must match exactly, so it is computed
 * here instead of being guessed from the coordinator outcome.
 */
function consumerCheckpointOutcome(status: TaskVerificationStatus): Checkpoint['outcome'] {
  if (status === 'success') return 'succeeded';
  if (status === 'failed' || status === 'rejected') return 'failed';
  if (status === 'missing' || status === 'blocked') return 'blocked';
  return 'cancelled';
}

function nextActionFor(outcome: Checkpoint['outcome'], ref: string): Checkpoint['next'] {
  if (outcome === 'succeeded') return { kind: 'continue', ref };
  if (outcome === 'cancelled' || outcome === 'stopped') return { kind: 'stop', ref };
  return { kind: 'recover', ref };
}

export function occurrenceTerminalProduction(input: {
  readonly binding: OccurrenceTaskBinding;
  readonly claim: OccurrenceClaimRecord;
  readonly policy: ExecutionPolicyDefinition;
  readonly scope: ScopeRef;
  readonly previousCheckpoint: Checkpoint | null;
  readonly committed: CommittedExecutionCheckpoint;
}): OccurrenceTerminalProduction {
  const { binding, claim, scope, previousCheckpoint, committed } = input;
  if (!TERMINAL_OUTCOMES.includes(committed.outcome as Checkpoint['outcome'])) {
    throw new OccurrenceTerminalError('checkpoint-outcome-unknown', `committed checkpoint outcome is not terminal: ${committed.outcome}`);
  }
  const status = verificationStatusForCommittedOutcome(committed.outcome);
  const outcome = consumerCheckpointOutcome(status);

  // Evidence for the occurrence lifecycle is a reference to the really committed
  // business checkpoint. The coordinator's own evidence refs live in the business
  // scope, so they are recorded by locator and digest inside this reference
  // instead of being re-scoped into an identity they were not produced under.
  const checkpointRef: EvidenceRef = {
    evidenceId: id('evidence', occurrenceIdentityToken(`occurrence-terminal-${binding.occurrenceId}-${committed.checkpointId}`)),
    kind: 'operation',
    source: 'humanagent.app.ui-runtime',
    locator: `checkpoint/${committed.checkpointId}`,
    digest: digestOf('occurrence-terminal-checkpoint/v1', {
      checkpointId: committed.checkpointId,
      seq: committed.seq,
      outcome: committed.outcome,
      committedAt: committed.committedAt,
      evidence: committed.evidenceRefs.map((ref) => ({
        evidenceId: { scope: ref.evidenceId.scope, value: ref.evidenceId.value },
        kind: ref.kind,
        source: ref.source,
        locator: ref.locator,
        digest: ref.digest ?? null,
      })),
    }),
    scope,
  };

  const verification: TaskVerificationResult = {
    taskId: binding.taskId,
    operationId: binding.operationId,
    executionEpoch: binding.executionEpoch,
    attempt: 1,
    inputArtifactDigest: binding.inputArtifactDigest,
    // The persisted claim is the policy truth this occurrence was admitted under.
    policyRef: `execution-policy/${claim.policy.policyId}@${claim.policyRevision}`,
    policyDigest: claim.policyHash,
    status,
    checks: status === 'success'
      ? [{
          checkId: `committed-checkpoint-${occurrenceIdentityToken(committed.checkpointId)}`,
          kind: 'native',
          status: 'succeeded',
          decisionRef: `checkpoint/${committed.checkpointId}`,
          decisionDigest: checkpointRef.digest as string,
          artifactDigests: [binding.inputArtifactDigest],
          evidenceRefs: [checkpointRef],
        }]
      : [],
    evidenceRefs: [checkpointRef],
  };

  const checkpoint: Checkpoint = {
    id: id('checkpoint', occurrenceIdentityToken(`occurrence-terminal-${binding.occurrenceId}-${binding.executionEpoch}`)),
    scope,
    cycleId: scope.cycleId as NonNullable<ScopeRef['cycleId']>,
    seq: previousCheckpoint === null ? 1 : previousCheckpoint.seq + 1,
    previousCheckpointId: previousCheckpoint === null ? null : previousCheckpoint.id,
    directiveRevision: previousCheckpoint === null ? 1 : previousCheckpoint.directiveRevision,
    executionEpoch: binding.executionEpoch,
    outcome,
    summary: `occurrence execution ${committed.outcome}: ${committed.summary}`,
    recoveryStateRef: checkpointRef,
    evidenceRefs: [checkpointRef],
    next: nextActionFor(outcome, checkpointRef.locator),
  };

  return {
    checkpoint,
    verification,
    settlementReceiptRef: `occurrence-settlement/v1:${binding.occurrenceId}:${binding.executionEpoch}`,
    ...(status === 'success'
      ? {}
      : {
          recoveryResponsibility: {
            providerEffectState: 'possible' as const,
            resourceInventory: [checkpointRef],
            releaseProofs: [],
          },
        }),
  };
}
