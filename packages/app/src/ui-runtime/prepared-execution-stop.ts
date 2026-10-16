import { createHash } from 'node:crypto';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import {
  canonicalJsonStringify,
  id,
  type Checkpoint,
  type EvidenceRef,
  type OperationId,
  type ProviderBinding,
  type ScopeRef,
  type TaskId,
} from '../../../contracts/src/index.js';
import type { JournalRecord } from '../../../adapters/jsonl/src/index.js';
import type { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import { readTaskBusinessRegistration } from '../../../adapters/jsonl/src/task-grants.js';
import { listTaskActiveTurnBindings } from '../../../adapters/jsonl/src/active-turn.js';
import type { ActiveTurnBinding } from '../../../contracts/src/active-turn-context.js';
import { activeTurnCommitId } from '../../../runtime/src/context/active-turn-journal.js';
import type {
  RuntimeExecutionAllocation,
  RuntimeTaskJournalPort,
} from '../../../runtime/src/ui-runtime/coordinator.js';
import type { AgentProviderComposition } from '../agent-driver-composition.js';
import { AppLifecycleError } from '../errors.js';
import { readPreparedExecutionInput } from '../prepared-execution-input.js';
import {
  executionAdmissionInputDigest,
  type createExecutionAdmission,
} from './execution-admission.js';

const OWNER = 'humanagent.app.prepared-execution-stop';
const PAYLOAD_KIND = 'prepared-execution-stop/v1';

export type PreparedExecutionStopCheckpointCandidate = Omit<Checkpoint, 'recoveryStateRef' | 'evidenceRefs'>;

export type PreparedExecutionStopSelector = {
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
};

export type PreparedExecutionStopFact =
  | {
      readonly kind: 'requested';
      readonly allocation: RuntimeExecutionAllocation;
      readonly inputDigest: string;
      readonly checkpoint: PreparedExecutionStopCheckpointCandidate;
    }
  | { readonly kind: 'preparation-entered'; readonly allocation: RuntimeExecutionAllocation }
  | {
      readonly kind: 'resource-acquired';
      readonly resource: {
        readonly preparation: JournalCommitRef;
        readonly binding: ProviderBinding;
      };
    }
  | {
      readonly kind: 'resource-closed';
      readonly acquisition: JournalCommitRef;
      readonly receipt: Awaited<ReturnType<AgentProviderComposition['port']['close']>>;
    }
  | {
      readonly kind: 'preparation-left';
      readonly preparation: JournalCommitRef;
      readonly outcome: 'failed' | 'prepared';
    }
  | {
      readonly kind: 'settled';
      readonly request: JournalCommitRef;
      readonly cut: { readonly journalSeq: number; readonly recordDigest: string | null };
      readonly owners: OwnerRefs;
      readonly preparations: readonly JournalCommitRef[];
      readonly resourceClosures: readonly JournalCommitRef[];
    };

export type PreparedExecutionStopReadback =
  | { readonly state: 'absent' }
  | {
      readonly state: 'pending';
      readonly request: JournalCommitRef;
      readonly facts: readonly {
        readonly ref: JournalCommitRef;
        readonly fact: PreparedExecutionStopFact;
      }[];
    }
  | {
      readonly state: 'settled';
      readonly request: JournalCommitRef;
      readonly settlement: JournalCommitRef;
      readonly fact: Extract<PreparedExecutionStopFact, { readonly kind: 'settled' }>;
      readonly recoveryStateRef: EvidenceRef;
    };

export type PreparedExecutionStopSettleResult =
  | Extract<PreparedExecutionStopReadback, { readonly state: 'settled' }>
  | {
      readonly state: 'pending';
      readonly request: JournalCommitRef;
      readonly reason:
        | 'preparation-active'
        | 'resource-unresolved'
        | 'admission-incomplete'
        | 'turn-input-incomplete'
        | 'effects-present';
      readonly evidenceRefs: readonly EvidenceRef[];
    };

/**
 * Opaque capability issued by one producer instance. A lease is meaningful
 * only while the producer still owns its live preparation join.
 */
export class PreparedExecutionStopPreparationLease {
  constructor(
    readonly allocation: RuntimeExecutionAllocation,
    readonly preparation: JournalCommitRef,
  ) {}
}

interface LeaseOwnership {
  readonly producer: PreparedExecutionStop;
  readonly executionKey: string;
}

const leaseOwnership = new WeakMap<PreparedExecutionStopPreparationLease, LeaseOwnership>();

interface FactEntry<F extends PreparedExecutionStopFact = PreparedExecutionStopFact> {
  readonly record: JournalRecord;
  readonly ref: JournalCommitRef;
  readonly fact: F;
}

interface PreparedStopBundle {
  readonly requested: FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'requested' }>>;
  readonly preparationEntered: readonly FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'preparation-entered' }>>[];
  readonly resourceAcquired: readonly FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'resource-acquired' }>>[];
  readonly resourceClosed: readonly FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'resource-closed' }>>[];
  readonly preparationLeft: readonly FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'preparation-left' }>>[];
  readonly settled: FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'settled' }>> | null;
  readonly entries: readonly FactEntry[];
}

interface OwnerRefs {
  readonly registration: JournalCommitRef | null;
  readonly coverage: JournalCommitRef | null;
  readonly parent: JournalCommitRef | null;
  readonly turnBinding: JournalCommitRef | null;
  readonly initialInput: JournalCommitRef | null;
}

interface ActivePreparation {
  readonly lease: PreparedExecutionStopPreparationLease;
}

function stopError(
  code: string,
  message: string,
  nextAction: string,
  cause?: unknown,
): AppLifecycleError {
  return new AppLifecycleError(code, message, nextAction, OWNER, cause);
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string },
  right: { readonly scope: string; readonly value: string },
): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function scopeKey(scope: ScopeRef): string {
  return [
    scope.organId.scope,
    scope.organId.value,
    scope.taskId?.scope ?? '',
    scope.taskId?.value ?? '',
    scope.cycleId?.scope ?? '',
    scope.cycleId?.value ?? '',
    scope.operationId?.scope ?? '',
    scope.operationId?.value ?? '',
  ].join('\0');
}

function executionKey(allocation: RuntimeExecutionAllocation): string {
  return `${scopeKey(allocation.scope)}\0${allocation.runtimeId}\0${allocation.executionEpoch}`;
}

function commitIdFor(allocation: RuntimeExecutionAllocation, discriminator: string): string {
  return `prepared-execution-stop:v1:${createHash('sha256')
    .update(`${executionKey(allocation)}\0${discriminator}`)
    .digest('hex')}`;
}

function commitRef(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined) {
    throw stopError(
      'prepared-execution-stop.record-uncommitted',
      'a prepared-stop record has no commit id',
      'repair the Organ Journal before retrying the prepared-stop read',
    );
  }
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

function sameRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function sameAllocation(left: RuntimeExecutionAllocation, right: RuntimeExecutionAllocation): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function factOf(record: JournalRecord): PreparedExecutionStopFact | null {
  if (record.kind !== 'event' || record.payload?.kind !== PAYLOAD_KIND) return null;
  const fact = record.payload.fact;
  if (fact === null || typeof fact !== 'object' || Array.isArray(fact)
    || typeof (fact as { readonly kind?: unknown }).kind !== 'string') {
    throw stopError(
      'prepared-execution-stop.record-corrupt',
      'a prepared-stop record has no typed fact payload',
      'preserve the Organ Journal and reconcile the corrupt prepared-stop fact',
    );
  }
  return fact as PreparedExecutionStopFact;
}

function factEntry(record: JournalRecord): FactEntry | null {
  const fact = factOf(record);
  return fact === null ? null : { record, ref: commitRef(record), fact };
}

function findRequestedBySelector(
  records: readonly JournalRecord[],
  selector: PreparedExecutionStopSelector,
): FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'requested' }>> | null {
  const matches = records
    .map(factEntry)
    .filter((entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'requested' }>> =>
      entry?.fact.kind === 'requested'
      && sameScopedId(entry.fact.allocation.taskId, selector.taskId)
      && sameScopedId(entry.fact.allocation.operationId, selector.operationId)
      && entry.fact.allocation.executionEpoch === selector.executionEpoch);
  if (matches.length > 1) {
    throw stopError(
      'prepared-execution-stop.request-conflict',
      'the Organ Journal contains more than one prepared-stop request for the same execution',
      'reconcile the duplicate request before reading or settling it',
    );
  }
  return matches[0] ?? null;
}

function findRequestedByCommit(
  records: readonly JournalRecord[],
  ref: JournalCommitRef,
): FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'requested' }>> | null {
  const record = records.find((candidate) => candidate.commitId === ref.commitId);
  if (record === undefined) return null;
  const entry = factEntry(record);
  if (entry === null || entry.fact.kind !== 'requested' || !sameRef(entry.ref, ref)) {
    throw stopError(
      'prepared-execution-stop.request-mismatch',
      'the prepared-stop request reference does not resolve to its committed request fact',
      'read the original request from the Organ Journal before continuing',
    );
  }
  return entry as FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'requested' }>>;
}

function collectBundle(
  records: readonly JournalRecord[],
  requested: FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'requested' }>>,
): PreparedStopBundle {
  const entries = records.map(factEntry).filter((entry): entry is FactEntry => entry !== null);
  const preparationEntered = entries.filter(
    (entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'preparation-entered' }>> =>
      entry.fact.kind === 'preparation-entered' && sameAllocation(entry.fact.allocation, requested.fact.allocation),
  );
  const preparationIds = new Set(preparationEntered.map((entry) => entry.ref.commitId));
  const resourceAcquired = entries.filter(
    (entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'resource-acquired' }>> =>
      entry.fact.kind === 'resource-acquired'
      && preparationIds.has(entry.fact.resource.preparation.commitId),
  );
  const acquisitionIds = new Set(resourceAcquired.map((entry) => entry.ref.commitId));
  const resourceClosed = entries.filter(
    (entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'resource-closed' }>> =>
      entry.fact.kind === 'resource-closed'
      && acquisitionIds.has(entry.fact.acquisition.commitId),
  );
  const preparationLeft = entries.filter(
    (entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'preparation-left' }>> =>
      entry.fact.kind === 'preparation-left'
      && preparationIds.has(entry.fact.preparation.commitId),
  );
  const settled = entries.filter(
    (entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'settled' }>> =>
      entry.fact.kind === 'settled' && entry.fact.request.commitId === requested.ref.commitId,
  );
  if (settled.length > 1) {
    throw stopError(
      'prepared-execution-stop.settlement-conflict',
      'the Organ Journal contains more than one settlement for the same prepared-stop request',
      'reconcile the duplicate settlement before reading it',
    );
  }
  return {
    requested,
    preparationEntered,
    resourceAcquired,
    resourceClosed,
    preparationLeft,
    settled: settled[0] ?? null,
    entries: [requested, ...preparationEntered, ...resourceAcquired, ...resourceClosed, ...preparationLeft, ...settled]
      .sort((left, right) => left.ref.journalSeq - right.ref.journalSeq),
  };
}

function evidenceFor(ref: JournalCommitRef, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `prepared-stop-${createHash('sha256').update(ref.commitId).digest('hex')}`),
    kind: 'operation',
    source: OWNER,
    locator: ref.commitId,
    digest: ref.recordDigest,
    scope,
  };
}

function pending(
  request: JournalCommitRef,
  reason: Extract<PreparedExecutionStopSettleResult, { readonly state: 'pending' }>['reason'],
  refs: readonly JournalCommitRef[],
  scope: ScopeRef,
): Extract<PreparedExecutionStopSettleResult, { readonly state: 'pending' }> {
  return { state: 'pending', request, reason, evidenceRefs: refs.map((ref) => evidenceFor(ref, scope)) };
}

function findRegistration(
  records: readonly JournalRecord[],
  allocation: RuntimeExecutionAllocation,
): JournalCommitRef | null {
  const requestRef = `execution:${allocation.operationId.value}`;
  for (const record of records) {
    if (record.kind !== 'event' || record.commitId === undefined
      || record.payload?.kind !== 'task-business-registration') continue;
    const read = readTaskBusinessRegistration({ records, commitId: record.commitId });
    if (read !== null
      && sameScopedId(read.registration.taskId, allocation.taskId)
      && read.registration.requestRef === requestRef) {
      return read.commit;
    }
  }
  return null;
}

function activeTurnMatches(
  binding: ActiveTurnBinding,
  allocation: RuntimeExecutionAllocation,
): boolean {
  return binding.execution.runtimeId === allocation.runtimeId
    && binding.execution.executionEpoch === allocation.executionEpoch
    && binding.assignment.assignmentId === allocation.assignmentId
    && canonicalJsonStringify(binding.scope) === canonicalJsonStringify(allocation.scope);
}

function runExclusive<T>(
  gates: Map<string, Promise<void>>,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = gates.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  gates.set(key, tail);
  return previous.then(async () => {
    try {
      return await action();
    } finally {
      release();
      if (gates.get(key) === tail) gates.delete(key);
    }
  });
}

export class PreparedExecutionStop {
  private readonly journal: JsonlOrganJournal;
  private readonly taskJournal: RuntimeTaskJournalPort;
  private readonly admission: ReturnType<typeof createExecutionAdmission>;
  private readonly gates = new Map<string, Promise<void>>();
  private readonly activePreparations = new Map<string, ActivePreparation>();
  private readonly liveCompositions = new Map<string, AgentProviderComposition>();

  constructor(input: {
    readonly journal: JsonlOrganJournal;
    readonly taskJournal: RuntimeTaskJournalPort;
    readonly admission: ReturnType<typeof createExecutionAdmission>;
  }) {
    this.journal = input.journal;
    this.taskJournal = input.taskJournal;
    this.admission = input.admission;
  }

  async request(input: {
    readonly allocation: RuntimeExecutionAllocation;
    readonly checkpoint: PreparedExecutionStopCheckpointCandidate;
  }): Promise<JournalCommitRef> {
    const preparedInput = readPreparedExecutionInput(this.taskJournal, input.allocation);
    const inputDigest = executionAdmissionInputDigest(input.allocation, preparedInput);
    const key = executionKey(input.allocation);
    return await runExclusive(this.gates, key, async () => {
      const commitId = commitIdFor(input.allocation, 'requested');
      return await this.journal.transaction(
        ({ records }) => {
          const existing = records
            .map(factEntry)
            .find((entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'requested' }>> =>
              entry?.fact.kind === 'requested' && entry.ref.commitId === commitId);
          if (existing !== undefined) {
            if (!sameAllocation(existing.fact.allocation, input.allocation)
              || existing.fact.inputDigest !== inputDigest
              || canonicalJsonStringify(existing.fact.checkpoint) !== canonicalJsonStringify(input.checkpoint)) {
              throw stopError(
                'prepared-execution-stop.request-conflict',
                'the prepared-stop request conflicts with the committed checkpoint or immutable input identity',
                'retry with the original checkpoint and retained allocation input',
              );
            }
            return { kind: 'existing' as const, ref: existing.ref };
          }
          const selector = {
            taskId: input.allocation.taskId,
            operationId: input.allocation.operationId,
            executionEpoch: input.allocation.executionEpoch,
          };
          const sameSelector = findRequestedBySelector(records, selector);
          if (sameSelector !== null && !sameAllocation(sameSelector.fact.allocation, input.allocation)) {
            throw stopError(
              'prepared-execution-stop.request-conflict',
              'the prepared-stop request identity already belongs to another allocation',
              'retry with the original retained allocation',
            );
          }
          return { kind: 'append' as const, commitId };
        },
        async (plan, append) => {
          if (plan.kind === 'existing') return plan.ref;
          const record = await append({
            commitId: plan.commitId,
            kind: 'event',
            scope: input.allocation.scope,
            payload: {
              kind: PAYLOAD_KIND,
              fact: {
                kind: 'requested',
                allocation: input.allocation,
                inputDigest,
                checkpoint: input.checkpoint,
              } satisfies PreparedExecutionStopFact,
            },
          });
          return commitRef(record);
        },
      );
    });
  }

  async read(selector: PreparedExecutionStopSelector): Promise<PreparedExecutionStopReadback> {
    const records = await this.journal.replay();
    const requested = findRequestedBySelector(records, selector);
    if (requested === null) return { state: 'absent' };
    const bundle = collectBundle(records, requested);
    this.assertBundle(records, bundle);
    if (bundle.settled !== null) {
      return {
        state: 'settled',
        request: bundle.settled.fact.request,
        settlement: bundle.settled.ref,
        fact: bundle.settled.fact,
        recoveryStateRef: evidenceFor(bundle.settled.ref, requested.fact.allocation.scope),
      };
    }
    return {
      state: 'pending',
      request: requested.ref,
      facts: bundle.entries.map((entry) => ({ ref: entry.ref, fact: entry.fact })),
    };
  }

  async settle(selector: PreparedExecutionStopSelector): Promise<PreparedExecutionStopSettleResult> {
    const initialRecords = await this.journal.replay();
    const requested = findRequestedBySelector(initialRecords, selector);
    if (requested === null) {
      throw stopError(
        'prepared-execution-stop.absent',
        'no durable prepared-stop request exists for the selected execution',
        'persist the prepared-stop request before settling it',
      );
    }
    const key = executionKey(requested.fact.allocation);
    return await runExclusive(this.gates, key, async () => {
      const records = await this.journal.replay();
      const currentRequested = findRequestedByCommit(records, requested.ref);
      if (currentRequested === null) {
        throw stopError(
          'prepared-execution-stop.request-missing',
          'the prepared-stop request disappeared during settlement',
          'recover the Organ Journal before retrying settlement',
        );
      }
      const bundle = collectBundle(records, currentRequested);
      this.assertBundle(records, bundle);
      if (bundle.settled !== null) {
        return {
          state: 'settled',
          request: bundle.settled.fact.request,
          settlement: bundle.settled.ref,
          fact: bundle.settled.fact,
          recoveryStateRef: evidenceFor(bundle.settled.ref, currentRequested.fact.allocation.scope),
        };
      }
      if (this.activePreparations.has(key) || bundle.preparationEntered.length !== bundle.preparationLeft.length) {
        return pending(
          currentRequested.ref,
          'preparation-active',
          bundle.preparationEntered.map((entry) => entry.ref),
          currentRequested.fact.allocation.scope,
        );
      }
      const unclosed = bundle.resourceAcquired.filter((acquired) =>
        !bundle.resourceClosed.some((closed) => closed.fact.acquisition.commitId === acquired.ref.commitId));
      if (unclosed.length > 0) {
        return pending(
          currentRequested.ref,
          'resource-unresolved',
          unclosed.map((entry) => entry.ref),
          currentRequested.fact.allocation.scope,
        );
      }
      const owners = await this.resolveOwners(currentRequested.fact.allocation, records);
      const ownerRefs = [owners.registration, owners.coverage, owners.parent, owners.turnBinding, owners.initialInput]
        .filter((ref): ref is JournalCommitRef => ref !== null);
      if (owners.registration !== null && (owners.coverage === null || owners.parent === null)) {
        return pending(currentRequested.ref, 'admission-incomplete', ownerRefs, currentRequested.fact.allocation.scope);
      }
      if (owners.coverage !== null && owners.parent === null) {
        return pending(currentRequested.ref, 'admission-incomplete', ownerRefs, currentRequested.fact.allocation.scope);
      }
      if (owners.coverage !== null && owners.parent !== null && owners.turnBinding === null) {
        return pending(currentRequested.ref, 'admission-incomplete', ownerRefs, currentRequested.fact.allocation.scope);
      }
      if (owners.turnBinding !== null && owners.initialInput === null) {
        return pending(currentRequested.ref, 'turn-input-incomplete', ownerRefs, currentRequested.fact.allocation.scope);
      }
      if (owners.turnBinding !== null && owners.initialInput !== null) {
        return pending(currentRequested.ref, 'effects-present', ownerRefs, currentRequested.fact.allocation.scope);
      }

      const last = records.at(-1);
      const cut = { journalSeq: last?.seq ?? 0, recordDigest: last?.recordDigest ?? null };
      const fact: Extract<PreparedExecutionStopFact, { readonly kind: 'settled' }> = {
        kind: 'settled',
        request: currentRequested.ref,
        cut,
        owners,
        preparations: bundle.preparationEntered.map((entry) => entry.ref),
        resourceClosures: bundle.resourceClosed.map((entry) => entry.ref),
      };
      await this.journal.transaction(
        ({ records: current }) => {
          const existingRequested = findRequestedByCommit(current, currentRequested.ref);
          if (existingRequested === null) {
            throw stopError(
              'prepared-execution-stop.request-missing',
              'the prepared-stop request disappeared before settlement append',
              'recover the Organ Journal before retrying settlement',
            );
          }
          const existingSettlement = collectBundle(current, existingRequested).settled;
          if (existingSettlement !== null) return { kind: 'existing' as const, ref: existingSettlement.ref };
          const currentLast = current.at(-1);
          if ((currentLast?.seq ?? 0) !== cut.journalSeq
            || (currentLast?.recordDigest ?? null) !== cut.recordDigest) {
            throw stopError(
              'prepared-execution-stop.retry',
              'the Organ Journal advanced while the prepared-stop settlement was being prepared',
              'retry settlement against the verified prefix',
            );
          }
          return { kind: 'append' as const, commitId: commitIdFor(currentRequested.fact.allocation, 'settled') };
        },
        async (plan, append) => {
          if (plan.kind === 'existing') return plan.ref;
          const record = await append({
            commitId: plan.commitId,
            kind: 'event',
            scope: currentRequested.fact.allocation.scope,
            payload: { kind: PAYLOAD_KIND, fact } satisfies { readonly kind: typeof PAYLOAD_KIND; readonly fact: PreparedExecutionStopFact },
          });
          return commitRef(record);
        },
      );
      const readback = await this.read(selector);
      if (readback.state !== 'settled') {
        throw stopError(
          'prepared-execution-stop.settlement-readback-missing',
          'the prepared-stop settlement was appended but cannot be read back',
          'recover the Organ Journal and read the exact settlement before publication',
        );
      }
      return readback;
    });
  }

  async withPreparation<T>(
    allocation: RuntimeExecutionAllocation,
    prepare: (lease: PreparedExecutionStopPreparationLease) => Promise<T>,
  ): Promise<T> {
    const key = executionKey(allocation);
    let lease!: PreparedExecutionStopPreparationLease;
    await runExclusive(this.gates, key, async () => {
      const requested = findRequestedBySelector(await this.journal.replay(), {
        taskId: allocation.taskId,
        operationId: allocation.operationId,
        executionEpoch: allocation.executionEpoch,
      });
      if (requested !== null) {
        throw stopError(
          'prepared-execution-stop.preparation-after-stop',
          'the durable stop request was committed before preparation entry',
          'do not advance preparation after a stop request; settle the retained allocation instead',
        );
      }
      if (this.activePreparations.has(key)) {
        throw stopError(
          'prepared-execution-stop.preparation-active',
          'a preparation join is already active for this execution',
          'join the existing preparation lifecycle before starting another',
        );
      }
      const entered = await this.journal.transaction(
        ({ records }) => {
          const existing = records
            .map(factEntry)
            .find((entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'preparation-entered' }>> =>
              entry?.fact.kind === 'preparation-entered' && sameAllocation(entry.fact.allocation, allocation));
          if (existing !== undefined) {
            throw stopError(
              'prepared-execution-stop.preparation-retained',
              'a prior preparation entry has no live join and cannot be replayed',
              'resolve the retained preparation through its actual owner before retrying',
            );
          }
          return { commitId: commitIdFor(allocation, 'preparation-entered') };
        },
        async (plan, append) => {
          const record = await append({
            commitId: plan.commitId,
            kind: 'event',
            scope: allocation.scope,
            payload: {
              kind: PAYLOAD_KIND,
              fact: { kind: 'preparation-entered', allocation } satisfies PreparedExecutionStopFact,
            },
          });
          return commitRef(record);
        },
      );
      lease = new PreparedExecutionStopPreparationLease(allocation, entered);
      leaseOwnership.set(lease, { producer: this, executionKey: key });
      this.activePreparations.set(key, { lease });
    });

    let result: T;
    try {
      result = await prepare(lease);
    } catch (error) {
      const cleanup = await this.finishPreparation(lease, 'failed');
      if (cleanup !== null) throw new AggregateError([error, cleanup], 'prepared execution preparation and retention failed');
      throw error;
    }
    const cleanup = await this.finishPreparation(lease, 'prepared');
    if (cleanup !== null) throw cleanup;
    return result;
  }

  async takeProvider(
    lease: PreparedExecutionStopPreparationLease,
    composition: AgentProviderComposition,
  ): Promise<JournalCommitRef> {
    const ownership = leaseOwnership.get(lease);
    if (ownership === undefined || ownership.producer !== this) {
      throw stopError(
        'prepared-execution-stop.lease-invalid',
        'the preparation lease was not issued by this producer',
        'use the exact lease handed to the active preparation callback',
      );
    }
    const active = this.activePreparations.get(ownership.executionKey);
    if (active === undefined || active.lease !== lease) {
      throw stopError(
        'prepared-execution-stop.lease-inactive',
        'the preparation lease is no longer joined to a live preparation',
        'retain the Provider resource only through the active preparation callback',
      );
    }
    return await runExclusive(this.gates, ownership.executionKey, async () => {
      const commitId = commitIdFor(lease.allocation, `resource-acquired:${composition.binding.bindingId}`);
      const ref = await this.journal.transaction(
        ({ records }) => {
          const existing = records
            .map(factEntry)
            .find((entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'resource-acquired' }>> =>
              entry?.fact.kind === 'resource-acquired' && entry.ref.commitId === commitId);
          if (existing !== undefined) return { kind: 'existing' as const, ref: existing.ref };
          return { kind: 'append' as const, commitId };
        },
        async (plan, append) => {
          if (plan.kind === 'existing') return plan.ref;
          const record = await append({
            commitId: plan.commitId,
            kind: 'event',
            scope: lease.allocation.scope,
            payload: {
              kind: PAYLOAD_KIND,
              fact: {
                kind: 'resource-acquired',
                resource: { preparation: lease.preparation, binding: composition.binding },
              } satisfies PreparedExecutionStopFact,
            },
          });
          return commitRef(record);
        },
      );
      this.liveCompositions.set(ref.commitId, composition);
      return ref;
    });
  }

  async closeProvider(acquisition: JournalCommitRef): Promise<JournalCommitRef> {
    const records = await this.journal.replay();
    const acquisitionRecord = records.find((record) => record.commitId === acquisition.commitId);
    if (acquisitionRecord === undefined) {
      throw stopError(
        'prepared-execution-stop.acquisition-missing',
        'the Provider acquisition reference is absent from the Organ Journal',
        'read the actual acquisition fact before closing its Provider resource',
      );
    }
    const acquisitionEntry = factEntry(acquisitionRecord);
    if (acquisitionEntry === null || acquisitionEntry.fact.kind !== 'resource-acquired'
      || !sameRef(acquisitionEntry.ref, acquisition)) {
      throw stopError(
        'prepared-execution-stop.acquisition-mismatch',
        'the Provider acquisition reference does not resolve to its exact acquisition fact',
        'read the actual acquisition fact before closing its Provider resource',
      );
    }
    const acquired = acquisitionEntry as FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'resource-acquired' }>>;
    const preparationRecord = records.find((record) => record.commitId === acquired.fact.resource.preparation.commitId);
    const preparationEntry = preparationRecord === undefined ? null : factEntry(preparationRecord);
    if (preparationEntry === null || preparationEntry.fact.kind !== 'preparation-entered'
      || !sameRef(preparationEntry.ref, acquired.fact.resource.preparation)) {
      throw stopError(
        'prepared-execution-stop.preparation-mismatch',
        'the Provider acquisition does not reference its exact preparation entry',
        'reconcile the acquisition and preparation records before closing',
      );
    }
    const prepared = preparationEntry as FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'preparation-entered' }>>;
    const key = executionKey(prepared.fact.allocation);
    return await runExclusive(this.gates, key, async () => {
      const current = await this.journal.replay();
      const existing = current
        .map(factEntry)
        .find((entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'resource-closed' }>> =>
          entry?.fact.kind === 'resource-closed' && entry.fact.acquisition.commitId === acquisition.commitId);
      if (existing !== undefined) return existing.ref;
      const composition = this.liveCompositions.get(acquisition.commitId);
      if (composition === undefined) {
        throw stopError(
          'prepared-execution-stop.close-unresolved',
          'the live Provider composition is not owned by this producer instance',
          'join the original preparation owner or retain the unresolved resource responsibility',
        );
      }
      const receipt = await composition.port.close(composition.binding);
      if (receipt.state !== 'closed') {
        throw stopError(
          'prepared-execution-stop.close-incomplete',
          `provider ${composition.binding.bindingId} close returned ${receipt.state}`,
          'complete the actual Provider close before releasing ownership',
          receipt.error,
        );
      }
      const commitId = commitIdFor(prepared.fact.allocation, `resource-closed:${acquisition.commitId}`);
      const ref = await this.journal.transaction(
        ({ records: currentRecords }) => {
          const closed = currentRecords
            .map(factEntry)
            .find((entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'resource-closed' }>> =>
              entry?.fact.kind === 'resource-closed' && entry.ref.commitId === commitId);
          if (closed !== undefined) return { kind: 'existing' as const, ref: closed.ref };
          return { kind: 'append' as const, commitId };
        },
        async (plan, append) => {
          if (plan.kind === 'existing') return plan.ref;
          const record = await append({
            commitId: plan.commitId,
            kind: 'event',
            scope: prepared.fact.allocation.scope,
            payload: {
              kind: PAYLOAD_KIND,
              fact: { kind: 'resource-closed', acquisition, receipt } satisfies PreparedExecutionStopFact,
            },
          });
          return commitRef(record);
        },
      );
      this.liveCompositions.delete(acquisition.commitId);
      return ref;
    });
  }

  private async finishPreparation(
    lease: PreparedExecutionStopPreparationLease,
    outcome: 'failed' | 'prepared',
  ): Promise<unknown | null> {
    const ownership = leaseOwnership.get(lease);
    if (ownership === undefined || ownership.producer !== this) {
      return stopError(
        'prepared-execution-stop.lease-invalid',
        'the preparation lease was not issued by this producer',
        'retain the actual preparation lease before finishing it',
      );
    }
    try {
      await runExclusive(this.gates, ownership.executionKey, async () => {
        await this.journal.transaction(
          ({ records }) => {
            const existing = records
              .map(factEntry)
              .find((entry): entry is FactEntry<Extract<PreparedExecutionStopFact, { readonly kind: 'preparation-left' }>> =>
                entry?.fact.kind === 'preparation-left'
                && entry.fact.preparation.commitId === lease.preparation.commitId);
            if (existing !== undefined) return { kind: 'existing' as const };
            return { kind: 'append' as const, commitId: commitIdFor(lease.allocation, 'preparation-left') };
          },
          async (plan, append) => {
            if (plan.kind === 'existing') return;
            await append({
              commitId: plan.commitId,
              kind: 'event',
              scope: lease.allocation.scope,
              payload: {
                kind: PAYLOAD_KIND,
                fact: { kind: 'preparation-left', preparation: lease.preparation, outcome } satisfies PreparedExecutionStopFact,
              },
            });
          },
        );
        this.activePreparations.delete(ownership.executionKey);
      });
      return null;
    } catch (error) {
      return error;
    } finally {
      leaseOwnership.delete(lease);
    }
  }

  private assertBundle(records: readonly JournalRecord[], bundle: PreparedStopBundle): void {
    for (const entry of bundle.entries) this.assertRef(records, entry.ref, entry.fact.kind);
    for (const acquired of bundle.resourceAcquired) {
      if (!bundle.preparationEntered.some((prepared) => sameRef(prepared.ref, acquired.fact.resource.preparation))) {
        throw stopError(
          'prepared-execution-stop.resource-mismatch',
          'a Provider acquisition does not reference a committed preparation entry',
          'reconcile the resource acquisition before settling',
        );
      }
    }
    for (const closed of bundle.resourceClosed) {
      if (!bundle.resourceAcquired.some((acquired) => sameRef(acquired.ref, closed.fact.acquisition))) {
        throw stopError(
          'prepared-execution-stop.close-mismatch',
          'a Provider close receipt does not reference a committed acquisition',
          'reconcile the close receipt before settling',
        );
      }
      if (closed.fact.receipt.state !== 'closed') {
        throw stopError(
          'prepared-execution-stop.close-not-closed',
          'a prepared-stop resource close fact does not contain an actual closed receipt',
          'preserve the resource ownership until the actual Provider close succeeds',
        );
      }
    }
    if (bundle.settled !== null) {
      if (!sameRef(bundle.settled.fact.request, bundle.requested.ref)) {
        throw stopError(
          'prepared-execution-stop.settlement-request-mismatch',
          'the prepared-stop settlement does not reference its exact request',
          'read the original settlement request before publishing it',
        );
      }
      for (const ref of [
        ...bundle.settled.fact.preparations,
        ...bundle.settled.fact.resourceClosures,
        ...Object.values(bundle.settled.fact.owners).filter((ref): ref is JournalCommitRef => ref !== null),
      ]) this.assertRef(records, ref, 'settlement reference');
    }
  }

  private assertRef(records: readonly JournalRecord[], ref: JournalCommitRef, label: string): void {
    const record = records.find((candidate) => candidate.commitId === ref.commitId);
    if (record === undefined || !sameRef(commitRef(record), ref)) {
      throw stopError(
        'prepared-execution-stop.reference-mismatch',
        `the ${label} reference does not resolve to its original committed record`,
        'read the original owner record before using the prepared-stop fact',
      );
    }
  }

  private async resolveOwners(
    allocation: RuntimeExecutionAllocation,
    records: readonly JournalRecord[],
  ): Promise<OwnerRefs> {
    const registration = findRegistration(records, allocation);
    let coverage: JournalCommitRef | null = null;
    let parent: JournalCommitRef | null = null;
    const control = await this.admission.gateway.readControl({
      scope: allocation.scope,
      agentRuntimeId: allocation.runtimeId,
      harnessExecutionEpoch: allocation.executionEpoch,
    });
    if (control.state === 'complete') {
      coverage = control.coverageCommitRef;
      const index = control.operations.findIndex((operation) =>
        sameScopedId(operation.intent.operationId, allocation.operationId));
      if (index >= 0) {
        const operation = control.operations[index]!;
        if (operation.binding.agentRuntimeId !== allocation.runtimeId
          || operation.binding.harnessExecutionEpoch !== allocation.executionEpoch
          || !sameScopedId(operation.binding.parentOperationId, allocation.operationId)) {
          throw stopError(
            'prepared-execution-stop.admission-mismatch',
            'the operation-control binding does not match the retained execution allocation',
            'repair the admission binding before settling the prepared execution',
          );
        }
        parent = control.operationCommits[index] ?? null;
      }
    }
    const taskScope = { organId: allocation.scope.organId, taskId: allocation.taskId };
    const activeBindings = await listTaskActiveTurnBindings({ journal: this.journal, scope: taskScope });
    const binding = activeBindings.find((entry) => activeTurnMatches(entry.binding, allocation));
    const turnBinding = binding?.commitRef ?? null;
    let initialInput: JournalCommitRef | null = null;
    if (binding !== undefined) {
      const initialInputCommitId = activeTurnCommitId(binding.binding.admittedTurn.turnId, 'initial-input');
      const record = records.find((candidate) => candidate.commitId === initialInputCommitId);
      if (record !== undefined) initialInput = commitRef(record);
    }
    return { registration, coverage, parent, turnBinding, initialInput };
  }
}

