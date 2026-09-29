import { createHash } from 'node:crypto';
import type { EvidenceRef, NextAction, ProviderBinding, ScopeRef } from '../../../contracts/src/index.js';
import { OrchestrationError } from './errors.js';

/**
 * Retry-10 provider avoidance control records.
 *
 * These types are runtime control facts. They are not business payload,
 * metadata, or logs, and they must be persisted through a Journal Owner
 * before the affected dispatch.
 */

export interface RetryBindingExclusion {
  readonly bindingId: string;
  readonly failedExecutionEpoch: number;
  readonly failureRef: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface CandidateBindingSnapshot {
  readonly bindingId: string;
  readonly bindingFingerprint: string;
}

export interface CandidateSetSnapshot {
  readonly configRevision: string;
  readonly configDigest: string;
  readonly orderedCandidates: readonly CandidateBindingSnapshot[];
}

export type RetryCycleState =
  | 'admitted'
  | 'running'
  | 'settling'
  | 'retry-safe'
  | 'exhausted'
  | 'blocked-attention';

export interface RetryCycleAttempt {
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly bindingId: string;
  readonly operationRef?: string;
  readonly failureRef?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly settleState: 'unsettled' | 'retry-safe' | 'unknown' | 'cancelled' | 'success';
}

export interface EpochAdmissionSnapshot {
  readonly executionEpoch: number;
  readonly bindingId: string;
  readonly bindingFingerprint: string;
  readonly permissionRevision: string;
  readonly capabilityDigest: string;
  readonly readinessRef: string;
  readonly leaseRef: string;
  readonly checkpointRef: string;
  readonly admissionDigest: string;
}

export interface RetryCycleControlRecord {
  readonly assignmentId: string;
  readonly initialExecutionEpoch: number;
  readonly retryBudget: {
    readonly initialAttempt: 1;
    readonly maxRetries: 10;
  };
  readonly state: RetryCycleState;
  readonly candidateSetSnapshot: CandidateSetSnapshot;
  readonly attempts: readonly RetryCycleAttempt[];
  readonly exclusions: readonly RetryBindingExclusion[];
  readonly admissionSnapshots: readonly EpochAdmissionSnapshot[];
}

export interface RetryAdmissionSupplied {
  readonly permissionRevision: string;
  readonly capabilityDigest: string;
  readonly readinessRef: string;
  readonly leaseRef: string;
  readonly checkpointRef: string;
}

export interface RetryCycleJournalPort {
  loadCycle(cycleId: string): Promise<RetryCycleControlRecord | null>;
  persistCycle(record: RetryCycleControlRecord): Promise<RetryCycleControlRecord>;
}

export interface RetryCycleCandidateProvider {
  readonly binding: ProviderBinding;
  readonly admission: RetryAdmissionSupplied;
}

export interface RetryCycleConfigSet {
  readonly configRevision: string;
  readonly configDigest: string;
  readonly candidates: readonly RetryCycleCandidateProvider[];
}

export interface DispatchInputForCycle {
  readonly assignmentId: string;
  readonly initialExecutionEpoch: number;
  readonly scope: ScopeRef;
}

export type RetryDispatchDecision =
  | {
      readonly kind: 'dispatch';
      readonly executionEpoch: number;
      readonly attempt: number;
      readonly candidate: RetryCycleCandidateProvider;
      readonly admissionSnapshot: EpochAdmissionSnapshot;
      readonly cycle: RetryCycleControlRecord;
    }
  | {
      readonly kind: 'blocked-attention';
      readonly cycle: RetryCycleControlRecord;
      readonly issue: RetryCycleIssue;
    }
  | {
      readonly kind: 'exhausted';
      readonly cycle: RetryCycleControlRecord;
      readonly issue: RetryCycleIssue;
    };

export interface RetryCycleIssue {
  readonly code: string;
  readonly ownerId: 'humanagent.runtime';
  readonly reason: string;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RetryCycleFailureInput {
  readonly assignmentId: string;
  readonly initialExecutionEpoch: number;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly bindingId: string;
  readonly operationRef?: string;
  readonly failureRef: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Operation Owner settlement/reconciliation result. */
  readonly settleState: Exclude<RetryCycleAttempt['settleState'], 'success'>;
}

export interface RetryCycleManager {
  begin(input: DispatchInputForCycle): Promise<RetryDispatchDecision>;
  recordFailure(input: RetryCycleFailureInput): Promise<RetryDispatchDecision>;
  recordSuccess(input: {
    readonly assignmentId: string;
    readonly initialExecutionEpoch: number;
    readonly attempt: number;
    readonly executionEpoch: number;
    readonly bindingId: string;
    readonly evidenceRefs: readonly EvidenceRef[];
  }): Promise<RetryCycleControlRecord>;
}

export function retryCycleId(input: {
  readonly assignmentId: string;
  readonly initialExecutionEpoch: number;
}): string {
  return `retry-cycle:${input.assignmentId}:${input.initialExecutionEpoch}`;
}

function candidateFingerprint(binding: ProviderBinding): string {
  return `sha256:${createHash('sha256')
    .update([
      'bindingId', binding.bindingId,
      'providerId', binding.providerId,
      'protocol', binding.protocol,
      'endpointRef', binding.endpointRef,
      'modelRef', binding.modelRef,
      'configDigest', binding.configDigest,
      'capabilityDigest', binding.capabilityDigest,
    ].join('\n'))
    .digest('hex')}`;
}

export function candidateSetSnapshot(input: RetryCycleConfigSet): CandidateSetSnapshot {
  return {
    configRevision: input.configRevision,
    configDigest: input.configDigest,
    orderedCandidates: input.candidates.map((candidate) => ({
      bindingId: candidate.binding.bindingId,
      bindingFingerprint: candidateFingerprint(candidate.binding),
    })),
  };
}

function assertEvidenceRefs(refs: readonly EvidenceRef[]): void {
  if (!Array.isArray(refs)) throw new OrchestrationError('evidence refs must be an array', {
    ownerId: 'humanagent.runtime',
    reason: 'retry.evidence.invalid',
    nextAction: { kind: 'recover', ref: 'retry.evidence' },
    evidenceRefs: [],
  });
}

function issue(
  code: string,
  reason: string,
  nextAction: NextAction,
  evidenceRefs: readonly EvidenceRef[],
): RetryCycleIssue {
  return { code, ownerId: 'humanagent.runtime', reason, nextAction, evidenceRefs: [...evidenceRefs] };
}

function cloneRecord(record: RetryCycleControlRecord): RetryCycleControlRecord {
  return structuredClone(record);
}

export function createRetryCycleManager(options: {
  readonly config: RetryCycleConfigSet;
  readonly journal: RetryCycleJournalPort;
}): RetryCycleManager {
  const snapshot = candidateSetSnapshot(options.config);
  const snapshots = new Map<string, CandidateBindingSnapshot>(
    snapshot.orderedCandidates.map((candidate) => [candidate.bindingId, candidate]),
  );
  if (snapshot.orderedCandidates.length === 0) {
    throw new OrchestrationError('retry cycle requires at least one explicit candidate binding', {
      ownerId: 'humanagent.runtime',
      reason: 'retry.candidates.empty',
      nextAction: { kind: 'recover', ref: 'retry.candidates' },
      evidenceRefs: [],
    });
  }
  const candidateByBindingId = new Map<string, RetryCycleCandidateProvider>(
    options.config.candidates.map((candidate) => [candidate.binding.bindingId, candidate]),
  );

  async function hydrate(cycleId: string): Promise<RetryCycleControlRecord | null> {
    const loaded = await options.journal.loadCycle(cycleId);
    if (!loaded) return null;
    if (loaded.candidateSetSnapshot.configDigest !== snapshot.configDigest
      || loaded.candidateSetSnapshot.configRevision !== snapshot.configRevision
      || loaded.candidateSetSnapshot.orderedCandidates.some((candidate) => {
        const current = snapshots.get(candidate.bindingId);
        return !current || current.bindingFingerprint !== candidate.bindingFingerprint;
      })) {
      throw new OrchestrationError('retry cycle candidate snapshot conflicts with persisted immutable snapshot', {
        ownerId: 'humanagent.runtime',
        reason: 'retry.candidate.mismatch',
        nextAction: { kind: 'recover', ref: `retry.cycle.${cycleId}` },
        evidenceRefs: [],
      });
    }
    return loaded;
  }

  async function persist(cycleId: string, record: RetryCycleControlRecord): Promise<RetryCycleControlRecord> {
    const persisted = await options.journal.persistCycle(cloneRecord(record));
    if (persisted.assignmentId !== record.assignmentId
      || persisted.initialExecutionEpoch !== record.initialExecutionEpoch
      || persisted.state !== record.state) {
      throw new OrchestrationError('retry cycle journal returned a different control record', {
        ownerId: 'humanagent.runtime',
        reason: 'retry.journal.mismatch',
        nextAction: { kind: 'recover', ref: `retry.cycle.${cycleId}` },
        evidenceRefs: [],
      });
    }
    return persisted;
  }

  function admissionDigest(snapshotItem: Omit<EpochAdmissionSnapshot, 'admissionDigest'>): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(snapshotItem)).digest('hex')}`;
  }

  async function selectCandidate(record: RetryCycleControlRecord, nextAttempt: number, cycleId: string): Promise<RetryDispatchDecision> {
    const nextEpoch = record.initialExecutionEpoch + (nextAttempt - 1);
    const excluded = new Set<string>(record.exclusions.map((exclusion) => exclusion.bindingId));
    const nextSnapshot = record.candidateSetSnapshot.orderedCandidates.find(
      (candidate) => !excluded.has(candidate.bindingId),
    );
    if (!nextSnapshot) {
      const reason = nextAttempt > 11
        ? 'retry budget exhausted after settled retry-safe attempt 11'
        : 'no eligible persisted snapshot candidate remains';
      const cycle = cloneRecord({ ...record, state: nextAttempt > 11 ? 'exhausted' : 'blocked-attention' });
      const retryIssue = issue(
        nextAttempt > 11 ? 'retry.exhausted' : 'retry.no-candidate',
        reason,
        { kind: 'recover', ref: `retry.attention.${record.assignmentId}` },
        [],
      );
      await persist(cycleId, cycle);
      return nextAttempt > 11
        ? { kind: 'exhausted', cycle, issue: retryIssue }
        : { kind: 'blocked-attention', cycle, issue: retryIssue };
    }
    const candidate = candidateByBindingId.get(nextSnapshot.bindingId);
    if (!candidate) {
      const cycle = cloneRecord({ ...record, state: 'blocked-attention' });
      await persist(cycleId, cycle);
      return {
        kind: 'blocked-attention',
        cycle,
        issue: issue(
          'retry.candidate.unavailable',
          `persisted candidate ${nextSnapshot.bindingId} has no matching live admission input`,
          { kind: 'recover', ref: `retry.candidate.${nextSnapshot.bindingId}` },
          [],
        ),
      };
    }
    const admissionWithoutDigest: Omit<EpochAdmissionSnapshot, 'admissionDigest'> = {
      executionEpoch: nextEpoch,
      bindingId: nextSnapshot.bindingId,
      bindingFingerprint: nextSnapshot.bindingFingerprint,
      permissionRevision: candidate.admission.permissionRevision,
      capabilityDigest: candidate.admission.capabilityDigest,
      readinessRef: candidate.admission.readinessRef,
      leaseRef: candidate.admission.leaseRef,
      checkpointRef: candidate.admission.checkpointRef,
    };
    const admission: EpochAdmissionSnapshot = {
      ...admissionWithoutDigest,
      admissionDigest: admissionDigest(admissionWithoutDigest),
    };
    const attempt = nextAttempt;
    const attempts = [...record.attempts];
    if (!attempts.some((candidateAttempt) => candidateAttempt.attempt === attempt)) {
      attempts.push({
        attempt,
        executionEpoch: nextEpoch,
        bindingId: nextSnapshot.bindingId,
        evidenceRefs: [],
        settleState: 'unsettled',
      });
    }
    const admissionSnapshots = [...record.admissionSnapshots];
    if (!admissionSnapshots.some((snap) => snap.executionEpoch === nextEpoch)) {
      admissionSnapshots.push(admission);
    }
    const dispatchCycle: RetryCycleControlRecord = { ...record, state: 'running', attempts, admissionSnapshots };
    await persist(cycleId, dispatchCycle);
    return {
      kind: 'dispatch',
      cycle: dispatchCycle,
      executionEpoch: nextEpoch,
      attempt,
      candidate,
      admissionSnapshot: admission,
    };
  }

  async function begin(input: DispatchInputForCycle): Promise<RetryDispatchDecision> {
    const cycleId = retryCycleId(input);
    const existing = await hydrate(cycleId);
    if (existing) {
      if (existing.attempts.length === 0) throw new OrchestrationError('persisted retry cycle has no initial attempt', {
        ownerId: 'humanagent.runtime',
        reason: 'retry.cycle.incomplete',
        nextAction: { kind: 'recover', ref: `retry.cycle.${cycleId}` },
        evidenceRefs: [],
      });
      const last = existing.attempts.at(-1)!;
      if (last.settleState === 'unsettled') {
        const cycle = cloneRecord({ ...existing, state: 'blocked-attention' });
        await persist(cycleId, cycle);
        return {
          kind: 'blocked-attention',
          cycle,
          issue: issue(
            'retry.unsettled',
            `attempt ${last.attempt} has an unsettled operation; Operation Owner must reconcile before another dispatch`,
            { kind: 'recover', ref: `operation.${input.assignmentId}.${last.executionEpoch}` },
            last.evidenceRefs,
          ),
        };
      }
      if (existing.state === 'exhausted') {
        return {
          kind: 'exhausted',
          cycle: existing,
          issue: issue(
            'retry.exhausted',
            'retry cycle is already exhausted',
            { kind: 'recover', ref: `retry.attention.${existing.assignmentId}` },
            existing.attempts.flatMap((attempt) => attempt.evidenceRefs),
          ),
        };
      }
      const nextAttempt = existing.attempts.length + 1;
      if (nextAttempt > 11) {
        const cycle = cloneRecord({ ...existing, state: 'exhausted' });
        await persist(cycleId, cycle);
        return {
          kind: 'exhausted',
          cycle,
          issue: issue(
            'retry.exhausted',
            'retry budget exhausted after settled retry-safe attempt 11',
            { kind: 'recover', ref: `retry.attention.${existing.assignmentId}` },
            existing.attempts.flatMap((attempt) => attempt.evidenceRefs),
          ),
        };
      }
      return selectCandidate(existing, nextAttempt, cycleId);
    }

    const initial: RetryCycleControlRecord = {
      assignmentId: input.assignmentId,
      initialExecutionEpoch: input.initialExecutionEpoch,
      retryBudget: { initialAttempt: 1 as const, maxRetries: 10 as const },
      state: 'admitted',
      candidateSetSnapshot: snapshot,
      attempts: [],
      exclusions: [],
      admissionSnapshots: [],
    };
    await persist(cycleId, initial);
    return selectCandidate(initial, 1, cycleId);
  }

  async function recordFailure(input: RetryCycleFailureInput): Promise<RetryDispatchDecision> {
    const cycleId = retryCycleId({ assignmentId: input.assignmentId, initialExecutionEpoch: input.initialExecutionEpoch });
    const loaded = await hydrate(cycleId);
    if (!loaded) throw new OrchestrationError('retry cycle is missing for failed attempt', {
      ownerId: 'humanagent.runtime',
      reason: 'retry.cycle.missing',
      nextAction: { kind: 'recover', ref: `retry.cycle.${cycleId}` },
      evidenceRefs: [],
    });
    const attempt = loaded.attempts.find((candidate) => candidate.attempt === input.attempt);
    if (!attempt) throw new OrchestrationError('failed retry attempt is not on the persisted cycle', {
      ownerId: 'humanagent.runtime',
      reason: 'retry.attempt.missing',
      nextAction: { kind: 'recover', ref: `retry.attempt.${input.attempt}` },
      evidenceRefs: [],
    });
    const updatedAttempts = loaded.attempts.map((candidate) =>
      candidate.attempt === input.attempt ? {
        ...candidate,
        operationRef: input.operationRef ?? candidate.operationRef,
        failureRef: input.failureRef,
        evidenceRefs: [...new Set([...candidate.evidenceRefs, ...input.evidenceRefs])],
        settleState: input.settleState,
      } : candidate);
    if (input.settleState === 'unknown' || input.settleState === 'unsettled' || input.settleState === 'cancelled') {
      const cycle = cloneRecord({ ...loaded, attempts: updatedAttempts, state: 'blocked-attention' });
      await persist(cycleId, cycle);
      return {
        kind: 'blocked-attention',
        cycle,
        issue: issue(
          `retry.${input.settleState}`,
          `attempt ${input.attempt} is ${input.settleState}; visible recovery is required instead of provider switch`,
          { kind: 'recover', ref: `operation.${input.assignmentId}.${input.executionEpoch}` },
          input.evidenceRefs,
        ),
      };
    }
    const exclusion: RetryBindingExclusion = {
      bindingId: input.bindingId,
      failedExecutionEpoch: input.executionEpoch,
      failureRef: input.failureRef,
      evidenceRefs: [...input.evidenceRefs],
    };
    const exclusions = loaded.exclusions.some((candidate) => candidate.bindingId === exclusion.bindingId)
      ? loaded.exclusions
      : [...loaded.exclusions, exclusion];
    const retrySafe = cloneRecord({
      ...loaded,
      attempts: updatedAttempts,
      exclusions,
      state: 'retry-safe',
    });
    await persist(cycleId, retrySafe);
    const nextAttempt = input.attempt + 1;
    if (nextAttempt > 11) {
      const cycle = cloneRecord({ ...retrySafe, state: 'exhausted' });
      await persist(cycleId, cycle);
      return {
        kind: 'exhausted',
        cycle,
        issue: issue(
          'retry.exhausted',
          'retry budget exhausted after settled retry-safe attempt 11',
          { kind: 'recover', ref: `retry.attention.${retrySafe.assignmentId}` },
          input.evidenceRefs,
        ),
      };
    }
    return selectCandidate(retrySafe, nextAttempt, cycleId);
  }

  async function recordSuccess(input: {
    readonly assignmentId: string;
    readonly initialExecutionEpoch: number;
    readonly attempt: number;
    readonly executionEpoch: number;
    readonly bindingId: string;
    readonly evidenceRefs: readonly EvidenceRef[];
  }): Promise<RetryCycleControlRecord> {
    assertEvidenceRefs(input.evidenceRefs);
    const cycleId = retryCycleId({ assignmentId: input.assignmentId, initialExecutionEpoch: input.initialExecutionEpoch });
    const loaded = await hydrate(cycleId);
    if (!loaded) throw new OrchestrationError('retry cycle is missing for successful attempt', {
      ownerId: 'humanagent.runtime',
      reason: 'retry.cycle.missing',
      nextAction: { kind: 'recover', ref: `retry.cycle.${cycleId}` },
      evidenceRefs: [],
    });
    const updatedAttempts = loaded.attempts.map((candidate) =>
      candidate.attempt === input.attempt
        ? { ...candidate, bindingId: input.bindingId, evidenceRefs: [...input.evidenceRefs], settleState: 'success' as const }
        : candidate);
    const cycle = cloneRecord({ ...loaded, attempts: updatedAttempts, state: loaded.state === 'admitted' ? 'running' : loaded.state });
    return persist(cycleId, cycle);
  }

  return {
    begin,
    recordFailure,
    recordSuccess,
  };
}

export function retryCycleIssueToOrchestrationIssue(issue: RetryCycleIssue, scope: ScopeRef): {
  readonly code: string;
  readonly ownerId: string;
  readonly reason: string;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly conditionRef?: string;
} {
  return {
    code: issue.code,
    ownerId: issue.ownerId,
    reason: issue.reason,
    nextAction: issue.nextAction,
    evidenceRefs: issue.evidenceRefs.length > 0
      ? issue.evidenceRefs
      : [{ evidenceId: { scope: 'evidence', value: `retry-${issue.code}` }, kind: 'operation', source: 'retry-cycle', locator: issue.code, scope }],
    conditionRef: issue.code,
  };
}
