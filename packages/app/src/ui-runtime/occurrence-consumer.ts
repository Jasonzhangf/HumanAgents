// App-owned durable occurrence consumer.
//
// This is the single durable execution owner for an admitted occurrence. The
// supervisor lease authenticates the current process; the Organ Journal stores
// admission and typed terminal facts; FileCheckpointStore stores lifecycle
// checkpoints. The consumer never treats readable owner fields as authority.
import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  id,
  occurrenceExecutionAdmissionCommitId,
  occurrenceTerminalReceiptCommitId,
  validateExecutionPolicyDefinition,
  validateOccurrence,
  validateOccurrenceClaim,
  validateOccurrenceExecutionAdmissionRecord,
  validateOccurrenceTaskBinding,
  validateOccurrenceTerminalReceiptRecord,
  validateServeTaskTerminalReceipt,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionPolicyDefinition,
  type Occurrence,
  type OccurrenceExecutionAdmissionRecord,
  type OccurrenceExecutionOwner,
  type OccurrenceTaskBinding,
  type OccurrenceTerminalReceiptRecord,
  type RecoveryResponsibilityRecord,
  type ScopeRef,
  type ServeTaskTerminalReceipt,
  type TaskVerificationResult,
} from '../../../contracts/src/index.js';
import { assertCheckpointRecoveryResponsibility } from '../../../core/src/checkpoint.js';
import {
  decideOccurrenceAuthority,
  decideOccurrenceTerminalReceipt,
  executionPolicyHash,
  type OccurrenceAuthorityDecision,
} from '../../../core/src/subscription.js';
import { JsonlOrganJournal, type JournalRecord } from '../../../adapters/jsonl/src/index.js';
import { checkpointCommitId } from '../../../runtime/src/checkpoints/coordinator.js';
import type {
  OccurrenceClaimRecord,
  ServeTaskConsumerPort,
} from '../../../runtime/src/subscriptions/ports.js';
import type { SupervisorLease } from '../supervisor/index.js';
import { FileCheckpointStore } from './journal.js';

export type DurableOccurrenceConsumerFailureCode =
  | 'invalid-binding'
  | 'policy-mismatch'
  | 'claim-mismatch'
  | 'owner-live-unproven'
  | 'lease-expired'
  | 'stale-owner'
  | 'in-progress'
  | 'durable-unverified-recovery-pending'
  | 'receipt-checkpoint-mismatch'
  | 'terminal-rejected';

export class DurableOccurrenceConsumerError extends Error {
  readonly code: DurableOccurrenceConsumerFailureCode;

  constructor(code: DurableOccurrenceConsumerFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DurableOccurrenceConsumerError';
    this.code = code;
  }
}

// The business/verification owner supplies terminal facts. The consumer owns
// durable admission, single dispatch, checkpoint/receipt persistence, and
// replay. `dispatch` is called at most once per immutable binding.
export interface OccurrenceTerminalProduction {
  readonly checkpoint: Checkpoint;
  readonly verification: TaskVerificationResult;
  readonly settlementReceiptRef: string;
  readonly recoveryResponsibility?: RecoveryResponsibilityRecord;
}

export interface OccurrenceDispatchInput {
  readonly occurrence: Occurrence;
  readonly policy: ExecutionPolicyDefinition;
  readonly claim: OccurrenceClaimRecord;
  readonly binding: OccurrenceTaskBinding;
  readonly owner: OccurrenceExecutionOwner;
}

export interface OccurrenceDispatchPort {
  dispatch(input: OccurrenceDispatchInput): Promise<OccurrenceTerminalProduction>;
}

export interface DurableOccurrenceConsumerOptions {
  readonly lease: SupervisorLease;
  readonly scope: ScopeRef;
  readonly journal: JsonlOrganJournal;
  readonly checkpoints: FileCheckpointStore;
  readonly dispatch: OccurrenceDispatchPort;
  readonly now?: () => string;
}

const CONSUMER_OWNER_ID = 'humanagent.app.occurrence-consumer';

type ConsumerPhase =
  | { readonly kind: 'replay'; readonly receipt: ServeTaskTerminalReceipt }
  | { readonly kind: 'checkpoint-only' }
  | {
      readonly kind: 'authority';
      readonly admission: OccurrenceExecutionAdmissionRecord | undefined;
      readonly decision: OccurrenceAuthorityDecision;
    };

type CommitMode = 'terminal' | 'recovery';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-');
  const head = cleaned[0] ?? '';
  const candidate = /[A-Za-z0-9]/.test(head) ? cleaned : `x${cleaned}`;
  return candidate.slice(0, 128);
}

function bindingIdentity(binding: OccurrenceTaskBinding): Record<string, unknown> {
  return {
    occurrenceId: binding.occurrenceId,
    subscriptionId: binding.subscriptionId,
    scheduleRevision: binding.scheduleRevision,
    occurrenceOrdinal: binding.occurrenceOrdinal,
    taskId: { scope: binding.taskId.scope, value: binding.taskId.value },
    operationId: { scope: binding.operationId.scope, value: binding.operationId.value },
    executionEpoch: binding.executionEpoch,
    inputArtifactDigest: binding.inputArtifactDigest,
  };
}

function sameBinding(left: OccurrenceTaskBinding, right: OccurrenceTaskBinding): boolean {
  return canonicalJsonStringify(bindingIdentity(left)) === canonicalJsonStringify(bindingIdentity(right));
}

function digestOf(domain: string, value: unknown): string {
  const material = canonicalJsonStringify({ domain, value });
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

function recoveryResponsibilityRef(receiptCommitId: string): string {
  return `occurrence-recovery-responsibility/v1:${receiptCommitId}`;
}

function recoveryEvidence(binding: OccurrenceTaskBinding, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id(
      'evidence',
      safeId(`occurrence-recovery-${binding.operationId.value}-${binding.executionEpoch}`),
    ),
    kind: 'operation',
    source: 'humanagent.app.occurrence-consumer',
    locator: `humanagent://occurrence-recovery/${encodeURIComponent(binding.occurrenceId)}/${binding.executionEpoch}`,
    digest: digestOf('occurrence-recovery/v1', bindingIdentity(binding)),
    scope,
  };
}

function readAdmission(
  records: readonly JournalRecord[],
  commitId: string,
  binding: OccurrenceTaskBinding,
): OccurrenceExecutionAdmissionRecord | undefined {
  const record = records.find((candidate) => candidate.commitId === commitId);
  if (record === undefined) return undefined;
  const admission = record.payload as unknown as OccurrenceExecutionAdmissionRecord;
  try {
    validateOccurrenceExecutionAdmissionRecord(admission);
  } catch (error) {
    throw new DurableOccurrenceConsumerError('invalid-binding', `persisted admission is invalid: ${messageOf(error)}`);
  }
  if (!sameBinding(admission.binding, binding)) {
    throw new DurableOccurrenceConsumerError(
      'invalid-binding',
      'persisted admission binding does not match the authoritative binding',
    );
  }
  return admission;
}

function readReceipt(
  records: readonly JournalRecord[],
  commitId: string,
  binding: OccurrenceTaskBinding,
): OccurrenceTerminalReceiptRecord | undefined {
  const record = records.find((candidate) => candidate.commitId === commitId);
  if (record === undefined) return undefined;
  const receipt = record.payload as unknown as OccurrenceTerminalReceiptRecord;
  try {
    validateOccurrenceTerminalReceiptRecord(receipt);
  } catch (error) {
    throw new DurableOccurrenceConsumerError('terminal-rejected', `persisted terminal receipt is invalid: ${messageOf(error)}`);
  }
  if (!sameBinding(receipt.binding, binding)) {
    throw new DurableOccurrenceConsumerError(
      'invalid-binding',
      'persisted terminal receipt binding does not match the authoritative binding',
    );
  }
  return receipt;
}

function latestTerminalCheckpoint(
  records: readonly JournalRecord[],
  binding: OccurrenceTaskBinding,
): Checkpoint | undefined {
  let found: Checkpoint | undefined;
  for (const record of records) {
    const checkpoint = record.checkpoint;
    if (record.kind !== 'checkpoint' || checkpoint === undefined) continue;
    if (checkpoint.scope.taskId?.value !== binding.taskId.value) continue;
    if (checkpoint.scope.operationId?.value !== binding.operationId.value) continue;
    if (checkpoint.executionEpoch !== binding.executionEpoch) continue;
    found = checkpoint;
  }
  return found;
}

function checkpointByRef(records: readonly JournalRecord[], ref: string): Checkpoint | undefined {
  for (const record of records) {
    const checkpoint = record.checkpoint;
    if (record.kind !== 'checkpoint' || checkpoint === undefined) continue;
    if (checkpointCommitId(checkpoint) === ref) return checkpoint;
  }
  return undefined;
}

function recoveryPending(): DurableOccurrenceConsumerError {
  return new DurableOccurrenceConsumerError(
    'durable-unverified-recovery-pending',
    'terminal checkpoint is committed but the durable verification receipt is missing',
  );
}

function rejectionFor(decision: OccurrenceAuthorityDecision): DurableOccurrenceConsumerError {
  switch (decision.kind) {
    case 'binding-mismatch':
      return new DurableOccurrenceConsumerError('invalid-binding', 'requested occurrence identity does not match the authoritative claim binding');
    case 'claim-mismatch':
      return new DurableOccurrenceConsumerError('claim-mismatch', 'occurrence claim does not match the immutable binding');
    case 'lease-expired':
      return new DurableOccurrenceConsumerError('lease-expired', 'occurrence claim lease has expired');
    case 'owner-live-unproven':
      return new DurableOccurrenceConsumerError('owner-live-unproven', `current owner is not authenticated (${decision.reason})`);
    case 'stale-owner':
      return new DurableOccurrenceConsumerError('stale-owner', 'the authenticated caller is not the admitted execution owner');
    case 'current-owner':
      return new DurableOccurrenceConsumerError('in-progress', 'the admitted owner is live and the terminal receipt is not committed yet');
    case 'invalid-admission':
      return new DurableOccurrenceConsumerError('terminal-rejected', `admission record is invalid (${decision.reason})`);
    case 'recovery-allowed':
      return new DurableOccurrenceConsumerError('stale-owner', 'the current caller is a committed replacement for the admitted owner');
    case 'first-admission':
      return new DurableOccurrenceConsumerError('terminal-rejected', 'first-admission is not a rejection');
  }
}

function assertSameCheckpointScope(actual: ScopeRef, expected: ScopeRef): void {
  if (
    actual.organId.value !== expected.organId.value
    || actual.taskId?.value !== expected.taskId?.value
    || actual.cycleId?.value !== expected.cycleId?.value
    || actual.operationId?.value !== expected.operationId?.value
  ) {
    throw new DurableOccurrenceConsumerError('terminal-rejected', 'terminal checkpoint scope does not match the consumer scope');
  }
}

export class DurableOccurrenceConsumer implements ServeTaskConsumerPort {
  private readonly lease: SupervisorLease;
  private readonly scope: ScopeRef;
  private readonly journal: JsonlOrganJournal;
  private readonly checkpoints: FileCheckpointStore;
  private readonly dispatchPort: OccurrenceDispatchPort;
  private readonly now: () => string;
  private readonly inFlight = new Map<string, Promise<ServeTaskTerminalReceipt>>();

  constructor(options: DurableOccurrenceConsumerOptions) {
    if (options.scope.taskId === undefined || options.scope.cycleId === undefined || options.scope.operationId === undefined) {
      throw new DurableOccurrenceConsumerError('invalid-binding', 'consumer scope requires task, cycle, and operation identity');
    }
    this.lease = options.lease;
    this.scope = options.scope;
    this.journal = options.journal;
    this.checkpoints = options.checkpoints;
    this.dispatchPort = options.dispatch;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  static forTaskCycle(options: {
    readonly lease: SupervisorLease;
    readonly scope: ScopeRef;
    readonly journalPath: string;
    readonly dispatch: OccurrenceDispatchPort;
    readonly now?: () => string;
  }): DurableOccurrenceConsumer {
    return new DurableOccurrenceConsumer({
      lease: options.lease,
      scope: options.scope,
      journal: new JsonlOrganJournal(options.journalPath),
      checkpoints: new FileCheckpointStore(options.journalPath),
      dispatch: options.dispatch,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async executeOccurrence(input: {
    readonly occurrence: Occurrence;
    readonly policy: ExecutionPolicyDefinition;
    readonly claim: OccurrenceClaimRecord;
  }): Promise<ServeTaskTerminalReceipt> {
    const authoritativeBinding = this.authoritativeBindingFor(input.claim, input.policy);
    const requestedBinding = this.requestedBindingFor(input.occurrence, authoritativeBinding);
    const admissionCommitId = await occurrenceExecutionAdmissionCommitId(authoritativeBinding);
    const receiptCommitId = await occurrenceTerminalReceiptCommitId(authoritativeBinding);
    const flightKey = `${receiptCommitId}|${canonicalJsonStringify(bindingIdentity(requestedBinding))}`;
    const inFlight = this.inFlight.get(flightKey);
    if (inFlight !== undefined) return inFlight;

    const run = this.consume(
      requestedBinding,
      authoritativeBinding,
      admissionCommitId,
      receiptCommitId,
      input,
    );
    this.inFlight.set(flightKey, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  private authoritativeBindingFor(
    claim: OccurrenceClaimRecord,
    policy: ExecutionPolicyDefinition,
  ): OccurrenceTaskBinding {
    try {
      validateOccurrenceClaim(claim);
      validateExecutionPolicyDefinition(claim.policy);
      validateExecutionPolicyDefinition(policy);
    } catch (error) {
      throw new DurableOccurrenceConsumerError('invalid-binding', messageOf(error));
    }
    const claimPolicyHash = executionPolicyHash(claim.policy);
    if (
      claim.policyRevision !== policy.policyRevision
      || claim.policyHash !== executionPolicyHash(policy)
      || claim.policyHash !== claimPolicyHash
    ) {
      throw new DurableOccurrenceConsumerError(
        'policy-mismatch',
        'claim policy identity does not match the requested policy',
      );
    }
    const binding: OccurrenceTaskBinding = {
      occurrenceId: claim.occurrenceId,
      subscriptionId: claim.subscriptionId,
      scheduleRevision: claim.scheduleRevision,
      occurrenceOrdinal: claim.occurrenceOrdinal,
      taskId: claim.taskId,
      operationId: claim.operationId,
      executionEpoch: claim.executionEpoch,
      inputArtifactDigest: claim.inputArtifactDigest,
    };
    try {
      validateOccurrenceTaskBinding(binding);
    } catch (error) {
      throw new DurableOccurrenceConsumerError('invalid-binding', messageOf(error));
    }
    if (this.scope.operationId?.value !== binding.operationId.value || this.scope.taskId?.value !== binding.taskId.value) {
      throw new DurableOccurrenceConsumerError('invalid-binding', 'consumer scope does not match the authoritative binding');
    }
    return binding;
  }

  private requestedBindingFor(
    occurrence: Occurrence,
    authoritative: OccurrenceTaskBinding,
  ): OccurrenceTaskBinding {
    try {
      validateOccurrence(occurrence);
    } catch (error) {
      throw new DurableOccurrenceConsumerError('invalid-binding', messageOf(error));
    }
    const derivedOccurrenceId = `${occurrence.subscriptionId}::${occurrence.scheduleRevision}::${occurrence.occurrenceOrdinal}`;
    const binding: OccurrenceTaskBinding = {
      occurrenceId: occurrence.occurrenceId ?? derivedOccurrenceId,
      subscriptionId: occurrence.subscriptionId,
      scheduleRevision: occurrence.scheduleRevision,
      occurrenceOrdinal: occurrence.occurrenceOrdinal,
      taskId: authoritative.taskId,
      operationId: authoritative.operationId,
      executionEpoch: authoritative.executionEpoch,
      inputArtifactDigest: authoritative.inputArtifactDigest,
    };
    try {
      validateOccurrenceTaskBinding(binding);
    } catch (error) {
      throw new DurableOccurrenceConsumerError('invalid-binding', messageOf(error));
    }
    return binding;
  }

  private async consume(
    requestedBinding: OccurrenceTaskBinding,
    authoritativeBinding: OccurrenceTaskBinding,
    admissionCommitId: string,
    receiptCommitId: string,
    input: {
      readonly occurrence: Occurrence;
      readonly policy: ExecutionPolicyDefinition;
      readonly claim: OccurrenceClaimRecord;
    },
  ): Promise<ServeTaskTerminalReceipt> {
    const admission = await this.guardedAdmission(
      requestedBinding,
      authoritativeBinding,
      admissionCommitId,
      receiptCommitId,
      input.claim,
    );

    if (admission.kind === 'replay') return admission.receipt;
    if (admission.kind === 'checkpoint-only') throw recoveryPending();
    if (admission.decision.kind === 'recovery-allowed') {
      return this.commitRecovery(
        requestedBinding,
        authoritativeBinding,
        admissionCommitId,
        receiptCommitId,
        input.claim,
      );
    }
    if (admission.decision.kind !== 'first-admission') throw rejectionFor(admission.decision);

    // The unique dispatch authorized by the committed admission. It runs
    // outside the lease guard so a long execution cannot pin takeover.
    const production = await this.dispatchPort.dispatch({
      occurrence: input.occurrence,
      policy: input.policy,
      claim: input.claim,
      binding: requestedBinding,
      owner: admission.decision.admittedExecutionOwner,
    });

    return this.commitTerminal(
      requestedBinding,
      authoritativeBinding,
      admissionCommitId,
      receiptCommitId,
      input.claim,
      production,
      'terminal',
    );
  }

  private guardedAdmission(
    requestedBinding: OccurrenceTaskBinding,
    authoritativeBinding: OccurrenceTaskBinding,
    admissionCommitId: string,
    receiptCommitId: string,
    claim: OccurrenceClaimRecord,
  ): Promise<ConsumerPhase> {
    return this.lease.withCurrentDaemonOwner(authoritativeBinding, async (authenticatedCaller, isCommittedReplacement) =>
      this.journal.transaction<ConsumerPhase, ConsumerPhase>(
        async ({ records }) => this.readPhase(
          records,
          requestedBinding,
          authoritativeBinding,
          admissionCommitId,
          receiptCommitId,
          claim,
          authenticatedCaller,
          isCommittedReplacement,
        ),
        async (phase, append) => {
          if (phase.kind === 'authority' && phase.decision.kind === 'first-admission') {
            await append({
              commitId: admissionCommitId,
              kind: 'event',
              scope: this.scope,
              payload: phase.decision.record as unknown as Record<string, unknown>,
            });
          }
          return phase;
        },
      ));
  }

  private async readPhase(
    records: readonly JournalRecord[],
    requestedBinding: OccurrenceTaskBinding,
    authoritativeBinding: OccurrenceTaskBinding,
    admissionCommitId: string,
    receiptCommitId: string,
    claim: OccurrenceClaimRecord,
    authenticatedCaller: OccurrenceExecutionOwner,
    isCommittedReplacement: (previous: OccurrenceExecutionOwner) => Promise<boolean>,
  ): Promise<ConsumerPhase> {
    if (!sameBinding(requestedBinding, authoritativeBinding)) {
      return {
        kind: 'authority',
        admission: undefined,
        decision: decideOccurrenceAuthority({
          binding: requestedBinding,
          authoritativeBinding,
          claim,
          authenticatedCaller,
          committedReplacement: false,
          nowAt: this.now(),
        }),
      };
    }

    const receipt = readReceipt(records, receiptCommitId, authoritativeBinding);
    if (receipt !== undefined) {
      if (checkpointByRef(records, receipt.terminalCheckpointRef) === undefined) {
        throw new DurableOccurrenceConsumerError(
          'receipt-checkpoint-mismatch',
          'persisted terminal receipt does not reference a committed terminal checkpoint',
        );
      }
      return { kind: 'replay', receipt: this.receiptFrom(authoritativeBinding, receipt, receiptCommitId) };
    }
    if (latestTerminalCheckpoint(records, authoritativeBinding) !== undefined) {
      return { kind: 'checkpoint-only' };
    }

    const admission = readAdmission(records, admissionCommitId, authoritativeBinding);
    const committedReplacement = admission === undefined
      ? false
      : await isCommittedReplacement(admission.admittedExecutionOwner);
    return {
      kind: 'authority',
      admission,
      decision: decideOccurrenceAuthority({
        binding: requestedBinding,
        authoritativeBinding,
        ...(admission === undefined ? {} : { admission }),
        claim,
        authenticatedCaller,
        committedReplacement,
        nowAt: this.now(),
      }),
    };
  }

  private async commitRecovery(
    requestedBinding: OccurrenceTaskBinding,
    authoritativeBinding: OccurrenceTaskBinding,
    admissionCommitId: string,
    receiptCommitId: string,
    claim: OccurrenceClaimRecord,
  ): Promise<ServeTaskTerminalReceipt> {
    const evidence = recoveryEvidence(authoritativeBinding, this.scope);
    const latest = await this.checkpoints.readLatest(this.scope);
    const checkpoint: Checkpoint = {
      id: id(
        'checkpoint',
        safeId(`occurrence-recovery-${authoritativeBinding.operationId.value}-${authoritativeBinding.executionEpoch}`),
      ),
      scope: this.scope,
      cycleId: this.scope.cycleId as NonNullable<ScopeRef['cycleId']>,
      seq: latest === null ? 1 : latest.checkpoint.seq + 1,
      previousCheckpointId: latest === null ? null : latest.checkpoint.id,
      directiveRevision: latest === null ? 1 : latest.checkpoint.directiveRevision,
      executionEpoch: authoritativeBinding.executionEpoch,
      outcome: 'blocked',
      summary: 'occurrence execution owner was replaced before a durable terminal receipt was committed',
      recoveryStateRef: evidence,
      evidenceRefs: [evidence],
      next: { kind: 'recover', ref: evidence.locator },
    };
    const verification: TaskVerificationResult = {
      taskId: authoritativeBinding.taskId,
      operationId: authoritativeBinding.operationId,
      executionEpoch: authoritativeBinding.executionEpoch,
      attempt: 1,
      inputArtifactDigest: authoritativeBinding.inputArtifactDigest,
      policyRef: `occurrence-recovery/v1:${claim.policy.policyId}`,
      policyDigest: digestOf('occurrence-recovery-policy/v1', {
        policyId: claim.policy.policyId,
        policyRevision: claim.policyRevision,
      }),
      status: 'blocked',
      checks: [],
      evidenceRefs: [evidence],
    };
    return this.commitTerminal(
      requestedBinding,
      authoritativeBinding,
      admissionCommitId,
      receiptCommitId,
      claim,
      {
        checkpoint,
        verification,
        settlementReceiptRef: `occurrence-settlement-recovery/v1:${authoritativeBinding.operationId.value}:${authoritativeBinding.executionEpoch}`,
        recoveryResponsibility: {
          providerEffectState: 'possible',
          resourceInventory: [evidence],
          releaseProofs: [],
        },
      },
      'recovery',
    );
  }

  private async commitTerminal(
    requestedBinding: OccurrenceTaskBinding,
    authoritativeBinding: OccurrenceTaskBinding,
    admissionCommitId: string,
    receiptCommitId: string,
    claim: OccurrenceClaimRecord,
    production: OccurrenceTerminalProduction,
    mode: CommitMode,
  ): Promise<ServeTaskTerminalReceipt> {
    return this.lease.withCurrentDaemonOwner(authoritativeBinding, async (authenticatedCaller, isCommittedReplacement) => {
      const phase = await this.journal.transaction<ConsumerPhase, ConsumerPhase>(
        async ({ records }) => this.readPhase(
          records,
          requestedBinding,
          authoritativeBinding,
          admissionCommitId,
          receiptCommitId,
          claim,
          authenticatedCaller,
          isCommittedReplacement,
        ),
        async (value) => value,
      );
      return this.commitTerminalInner(
        requestedBinding,
        authoritativeBinding,
        admissionCommitId,
        receiptCommitId,
        claim,
        production,
        mode,
        phase,
      );
    });
  }

  private async commitTerminalInner(
    requestedBinding: OccurrenceTaskBinding,
    authoritativeBinding: OccurrenceTaskBinding,
    admissionCommitId: string,
    receiptCommitId: string,
    claim: OccurrenceClaimRecord,
    production: OccurrenceTerminalProduction,
    mode: CommitMode,
    phase: ConsumerPhase,
  ): Promise<ServeTaskTerminalReceipt> {
    if (phase.kind === 'replay') return phase.receipt;
    if (phase.kind === 'checkpoint-only') throw recoveryPending();
    if (mode === 'terminal' && phase.decision.kind !== 'current-owner') throw rejectionFor(phase.decision);
    if (mode === 'recovery' && phase.decision.kind !== 'recovery-allowed') throw rejectionFor(phase.decision);

    const checkpoint = production.checkpoint;
    if (checkpoint.executionEpoch !== authoritativeBinding.executionEpoch) {
      throw new DurableOccurrenceConsumerError(
        'terminal-rejected',
        'terminal checkpoint execution epoch does not match the authoritative binding',
      );
    }
    assertSameCheckpointScope(checkpoint.scope, this.scope);

    const prior = (await this.checkpoints.readLatest(this.scope))?.checkpoint ?? null;
    try {
      assertCheckpointRecoveryResponsibility({ checkpoint, previous: prior, ownerId: CONSUMER_OWNER_ID });
    } catch (error) {
      throw new DurableOccurrenceConsumerError('terminal-rejected', messageOf(error));
    }

    const terminalCheckpointRef = checkpointCommitId(checkpoint);
    const recoveryResponsibility = production.recoveryResponsibility;
    const terminalReceipt: ServeTaskTerminalReceipt = {
      taskId: authoritativeBinding.taskId,
      operationId: authoritativeBinding.operationId,
      executionEpoch: authoritativeBinding.executionEpoch,
      inputArtifactDigest: authoritativeBinding.inputArtifactDigest,
      verification: production.verification,
      terminalCheckpointRef,
      settlementReceiptRef: production.settlementReceiptRef,
      ...(recoveryResponsibility === undefined
        ? {}
        : { recoveryResponsibility: recoveryResponsibilityRef(receiptCommitId) }),
    };

    let decision: ReturnType<typeof decideOccurrenceTerminalReceipt>;
    try {
      validateServeTaskTerminalReceipt(terminalReceipt);
      decision = decideOccurrenceTerminalReceipt({
        binding: authoritativeBinding,
        terminalReceipt,
        ...(recoveryResponsibility === undefined ? {} : { recoveryResponsibility }),
      });
    } catch (error) {
      throw new DurableOccurrenceConsumerError('terminal-rejected', messageOf(error));
    }
    if (checkpoint.outcome !== decision.checkpointOutcome) {
      throw new DurableOccurrenceConsumerError(
        'terminal-rejected',
        `terminal checkpoint outcome ${checkpoint.outcome} does not match verification status ${production.verification.status}`,
      );
    }

    // Checkpoint is lifecycle truth. Commit it first, then append the typed
    // receipt. A crash between the two leaves a visible recovery-pending
    // window and never returns verified success.
    await this.checkpoints.commit(checkpoint);
    await this.journal.append({
      commitId: receiptCommitId,
      kind: 'event',
      scope: this.scope,
      payload: decision.record as unknown as Record<string, unknown>,
    });
    return this.receiptFrom(authoritativeBinding, decision.record, receiptCommitId);
  }

  private receiptFrom(
    binding: OccurrenceTaskBinding,
    record: OccurrenceTerminalReceiptRecord,
    receiptCommitId: string,
  ): ServeTaskTerminalReceipt {
    const receipt: ServeTaskTerminalReceipt = {
      taskId: binding.taskId,
      operationId: binding.operationId,
      executionEpoch: binding.executionEpoch,
      inputArtifactDigest: binding.inputArtifactDigest,
      verification: record.verification,
      terminalCheckpointRef: record.terminalCheckpointRef,
      settlementReceiptRef: record.settlementReceiptRef,
      ...(record.recoveryResponsibility === undefined
        ? {}
        : { recoveryResponsibility: recoveryResponsibilityRef(receiptCommitId) }),
    };
    validateServeTaskTerminalReceipt(receipt);
    return receipt;
  }
}
