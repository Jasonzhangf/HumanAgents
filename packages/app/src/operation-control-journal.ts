import { createHash } from 'node:crypto';
import {
  operationIdempotencyKey,
  operationSemanticFingerprint,
  operationSemanticFingerprintKey,
  type OperationEvent,
  type OperationIntent,
  type ScopeRef,
} from '../../contracts/src/index.js';
import type { JournalCommitRef } from '../../contracts/src/i2-history.js';
import type {
  OperationChildAdmission,
  OperationChildAdmissionLookup,
  OperationChildAdmissionReadback,
  OperationControlRecord,
  OperationControlReadback,
  OperationControlSelector,
  OperationCoverageInitialization,
  OperationJournalPort,
  OperationPendingChild,
} from '../../runtime/src/gateway/ports.js';
import type { OperationControlBinding } from '../../runtime/src/gateway/ports.js';
import type { TaskGrantBusinessRegistration } from '../../runtime/src/admission/task-grant.js';
import { readTaskBusinessRegistration } from '../../adapters/jsonl/src/task-grants.js';
import { decodeActiveTurnRecords } from '../../adapters/jsonl/src/active-turn.js';
import type { JournalRecord, JsonlOrganJournal } from '../../adapters/jsonl/src/index.js';
import { AppLifecycleError } from './errors.js';
import { segmentOpenedFromRecord } from './checkpoint-journal.js';
import type { ResumedTurnSegmentOpened } from '../../contracts/src/active-turn-segments.js';

/**
 * Physical operation-control adapter over the existing Organ Journal.
 *
 * This is the sole new-production operation-control authority. It adds exactly
 * two typed `kind:'event'` payloads to the same `JsonlOrganJournal` that already
 * stores checkpoints and closures:
 *
 * - `operation-control-coverage/v1` - the admission-bound coverage start fact.
 * - `operation-control-envelope/v1` - one authoritative lifecycle event plus its
 *   exact successor control state.
 *
 * The old raw `operation-journal.jsonl` append is not revived. A scope without a
 * coverage fact reads as `unknown`; only an actual coverage receipt makes an
 * empty (or populated) read `complete`. The Gateway keeps the lifecycle
 * meaning; this adapter validates storage identity, fingerprints, ordering and
 * coverage, and never classifies a status from text or revives a lease.
 */

const OWNER = 'humanagent.app.operation-control-journal';
const COVERAGE_PAYLOAD_KIND = 'operation-control-coverage/v1';
const ENVELOPE_PAYLOAD_KIND = 'operation-control-envelope/v1';

interface CoveragePayload {
  readonly kind: typeof COVERAGE_PAYLOAD_KIND;
  readonly schemaVersion: 1;
  readonly scope: ScopeRef;
  readonly agentRuntimeId?: string;
  readonly harnessExecutionEpoch?: number;
  readonly admissionCommitRef: JournalCommitRef;
}

interface EnvelopePayload {
  readonly kind: typeof ENVELOPE_PAYLOAD_KIND;
  readonly schemaVersion: 1;
  readonly event: OperationEvent;
  readonly control: OperationControlRecord;
}

function corrupt(message: string): never {
  throw new AppLifecycleError(
    'operation-control-record-corrupt',
    message,
    'preserve the operation control journal and reconcile the conflicting record before retrying',
    OWNER,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sameScopedId(left: { readonly scope: string; readonly value: string }, right: { readonly scope: string; readonly value: string }): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function matchesSelectorScope(recordScope: ScopeRef, selectorScope: ScopeRef): boolean {
  if (!sameScopedId(recordScope.organId, selectorScope.organId)) return false;
  if (selectorScope.taskId !== undefined) {
    if (recordScope.taskId === undefined || !sameScopedId(recordScope.taskId, selectorScope.taskId)) return false;
  }
  if (recordScope.taskId !== undefined && selectorScope.taskId !== undefined && !sameScopedId(recordScope.taskId, selectorScope.taskId)) {
    return false;
  }
  if (selectorScope.cycleId !== undefined) {
    if (recordScope.cycleId === undefined || !sameScopedId(recordScope.cycleId, selectorScope.cycleId)) return false;
  }
  if (selectorScope.operationId !== undefined) {
    if (recordScope.operationId === undefined || !sameScopedId(recordScope.operationId, selectorScope.operationId)) return false;
  }
  return true;
}

/**
 * Physical namespace selector. An operation-control namespace is the exact
 * (agentRuntimeId, harnessExecutionEpoch) pair on top of the declared scope. A
 * selector that declares a field matches only records carrying the same value,
 * so a record that omits the field can never prove a successor namespace.
 */
function matchesSelectedNamespace(
  agentRuntimeId: string | undefined,
  harnessExecutionEpoch: number | undefined,
  selector: OperationControlSelector,
): boolean {
  if (selector.agentRuntimeId !== undefined && agentRuntimeId !== selector.agentRuntimeId) return false;
  if (selector.harnessExecutionEpoch !== undefined && harnessExecutionEpoch !== selector.harnessExecutionEpoch) return false;
  return true;
}

/** Exact physical namespace equality between a coverage fact and a binding. */
function sameCoverageNamespace(
  payload: CoveragePayload,
  agentRuntimeId: string | undefined,
  harnessExecutionEpoch: number | undefined,
): boolean {
  return payload.agentRuntimeId === agentRuntimeId && payload.harnessExecutionEpoch === harnessExecutionEpoch;
}

function coverageNamespaceKey(payload: CoveragePayload): string {
  return `${payload.agentRuntimeId ?? 'none'}|${payload.harnessExecutionEpoch ?? 'none'}`;
}

function assertCommitRef(value: unknown, label: string): asserts value is JournalCommitRef {
  if (!isObject(value)) corrupt(`${label} must be a journal commit ref`);
  if (!nonEmptyString(value.commitId)) corrupt(`${label} is missing a commitId`);
  if (!positiveInteger(value.journalSeq)) corrupt(`${label} is missing a journalSeq`);
  if (!nonEmptyString(value.recordDigest)) corrupt(`${label} is missing a recordDigest`);
}

function sameCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId && left.journalSeq === right.journalSeq && left.recordDigest === right.recordDigest;
}

const GRANT_PAYLOAD_KIND = 'task-grant';
const BUSINESS_REGISTRATION_PAYLOAD_KIND = 'task-business-registration';

/** Exact scope identity, including organ/task/cycle/operation. */
function matchesExactScope(left: ScopeRef, right: ScopeRef): boolean {
  return sameScopedId(left.organId, right.organId)
    && (left.taskId?.value ?? null) === (right.taskId?.value ?? null)
    && (left.taskId?.scope ?? null) === (right.taskId?.scope ?? null)
    && (left.cycleId?.value ?? null) === (right.cycleId?.value ?? null)
    && (left.cycleId?.scope ?? null) === (right.cycleId?.scope ?? null)
    && (left.operationId?.value ?? null) === (right.operationId?.value ?? null)
    && (left.operationId?.scope ?? null) === (right.operationId?.scope ?? null);
}

function isGrantRecord(record: JournalRecord): boolean {
  return record.kind === 'event' && isObject(record.payload) && record.payload.kind === GRANT_PAYLOAD_KIND;
}

function readBusinessRegistrationRecord(
  records: readonly JournalRecord[],
  record: JournalRecord,
): TaskGrantBusinessRegistration | null {
  if (record.kind !== 'event'
    || !isObject(record.payload)
    || record.payload.kind !== BUSINESS_REGISTRATION_PAYLOAD_KIND) {
    return null;
  }
  if (!nonEmptyString(record.commitId)) corrupt('task business registration record is not committed');
  const read = readTaskBusinessRegistration({ records, commitId: record.commitId });
  if (read === null) corrupt('task business registration record could not be decoded');
  return read.registration;
}

/**
 * Shared physical child-admission relationship check. It joins the exact TG1
 * authority commit, the child business registration with its typed provenance,
 * the admitted parent-namespace coverage and the current parent control. Both
 * the read-only lookup and the control-commit transaction use this one check;
 * neither trusts a caller-supplied receipt without a physical read.
 */
function verifyChildRelationship(
  records: readonly JournalRecord[],
  binding: OperationControlBinding,
  intent: OperationIntent,
  admission: OperationChildAdmission,
): OperationChildAdmissionReadback {
  const authority = records.find((record) => isGrantRecord(record) && record.commitId === admission.authorityCommitRef.commitId);
  if (authority === undefined || !sameCommitRef(journalCommitRef(authority), admission.authorityCommitRef)) {
    return {
      state: 'unknown',
      reason: 'child admission authority commit was not found in the journal',
      missingRefs: [admission.authorityCommitRef.commitId],
    };
  }
  const registrationRead = readTaskBusinessRegistration({ records, commitId: admission.businessRegistrationCommitRef.commitId });
  if (registrationRead === null || !sameCommitRef(registrationRead.commit, admission.businessRegistrationCommitRef)) {
    return {
      state: 'unknown',
      reason: 'child business registration commit was not found in the journal',
      missingRefs: [admission.businessRegistrationCommitRef.commitId],
    };
  }
  const registration = registrationRead.registration;
  const provenance = registration.operationProvenance;
  if (provenance === undefined || provenance.kind !== 'provider-tool') {
    return {
      state: 'unknown',
      reason: 'child business registration carries no typed provider-tool provenance',
      missingRefs: [admission.businessRegistrationCommitRef.commitId],
    };
  }
  if (!sameScopedId(registration.taskId, intent.taskId)
    || registration.inputIdentity.requestRef !== intent.inputRef
    || registration.inputIdentity.digest !== intent.inputDigest
    || provenance.providerRequestId.trim().length === 0
    || provenance.toolCallId.trim().length === 0
    || !matchesExactScope(provenance.parentNamespace, binding.scope)
    || !sameScopedId(provenance.parentOperationId, binding.parentOperationId)
    || !sameCommitRef(provenance.parentAdmissionCommitRef, binding.admissionCommitRef)
    || provenance.agentRuntimeId !== binding.agentRuntimeId
    || provenance.harnessExecutionEpoch !== binding.harnessExecutionEpoch
    || !sameScopedId(provenance.operationId, intent.operationId)
    || !matchesExactScope(provenance.effectScope, intent.requestedScope)
    || !sameCommitRef(provenance.authorityCommitRef, admission.authorityCommitRef)
    || !sameCommitRef(provenance.coverageCommitRef, admission.coverageCommitRef)) {
    return {
      state: 'unknown',
      reason: 'child business registration provenance does not match the admitted parent and child identity',
      missingRefs: [admission.businessRegistrationCommitRef.commitId],
    };
  }
  const coverage = records.find((record) => {
    const payload = readCoveragePayload(record);
    return payload !== null
      && matchesExactScope(payload.scope, binding.scope)
      && sameCommitRef(payload.admissionCommitRef, binding.admissionCommitRef)
      && payload.agentRuntimeId === binding.agentRuntimeId
      && payload.harnessExecutionEpoch === binding.harnessExecutionEpoch;
  });
  if (coverage === undefined || !sameCommitRef(journalCommitRef(coverage), admission.coverageCommitRef)) {
    return {
      state: 'unknown',
      reason: 'child admission coverage commit does not match the durable parent-namespace coverage fact',
      missingRefs: [admission.coverageCommitRef.commitId],
    };
  }
  const parentChain = records
    .map((record) => ({ record, envelope: readEnvelopePayload(record) }))
    .filter((entry): entry is { record: JournalRecord; envelope: EnvelopePayload } => entry.envelope !== null)
    .filter((entry) => sameScopedId(entry.envelope.control.intent.operationId, binding.parentOperationId))
    .filter((entry) => matchesExactScope(entry.envelope.control.binding.scope, binding.scope))
    .filter((entry) => entry.envelope.control.binding.agentRuntimeId === binding.agentRuntimeId
      && entry.envelope.control.binding.harnessExecutionEpoch === binding.harnessExecutionEpoch
      && sameScopedId(entry.envelope.control.binding.parentOperationId, binding.parentOperationId)
      && sameCommitRef(entry.envelope.control.binding.admissionCommitRef, binding.admissionCommitRef))
    .sort((left, right) => left.record.seq - right.record.seq);
  const parent = parentChain.at(-1);
  const registeredParent = parentChain.find((entry) => sameCommitRef(journalCommitRef(entry.record), provenance.parentControlCommitRef));
  const parentBusiness = readTaskBusinessRegistration({ records, commitId: binding.admissionCommitRef.commitId });
  if (parent === undefined || registeredParent === undefined
    || registeredParent.record.seq >= registrationRead.commit.journalSeq
    || parentBusiness === null || !sameCommitRef(parentBusiness.commit, binding.admissionCommitRef)
    || !sameScopedId(parentBusiness.registration.taskId, intent.taskId)) {
    return {
      state: 'unknown',
      reason: 'durable parent control for the child admission was not found',
      missingRefs: [binding.admissionCommitRef.commitId],
    };
  }
  const openedEntry = records
    .filter((record) => record.seq < registeredParent.record.seq)
    .map((record) => ({ record, opened: segmentOpenedFromRecord(record) }))
    .find((entry): entry is { record: JournalRecord; opened: ResumedTurnSegmentOpened } =>
      entry.opened !== null && sameCommitRef(entry.opened.businessRegistrationCommitRef, binding.admissionCommitRef));
  if (openedEntry === undefined) {
    if (parentBusiness.registration.inputIdentity.requestRef !== parent.envelope.control.intent.inputRef
      || parentBusiness.registration.inputIdentity.digest !== parent.envelope.control.intent.inputDigest) {
      return {
        state: 'unknown',
        reason: 'direct parent business registration does not match its immutable operation intent',
        missingRefs: [binding.admissionCommitRef.commitId],
      };
    }
  } else {
    const { record: openedRecord, opened } = openedEntry;
    const originalTurn = decodeActiveTurnRecords(records, opened.businessTurnRef.businessTurnId)
      .find((entry) => entry.kind === 'binding-opened');
    if (!matchesExactScope(opened.binding.scope, binding.scope)
      || opened.binding.execution.runtimeId !== binding.agentRuntimeId
      || opened.binding.execution.executionEpoch !== binding.harnessExecutionEpoch
      || opened.requestRef !== parentBusiness.registration.requestRef
      || opened.inputIdentity.requestRef !== parentBusiness.registration.inputIdentity.requestRef
      || opened.inputIdentity.digest !== parentBusiness.registration.inputIdentity.digest
      || originalTurn === undefined
      || !sameCommitRef(opened.businessTurnRef.bindingCommitRef, journalCommitRef(records.find((record) =>
        record.commitId === opened.businessTurnRef.bindingCommitRef.commitId) ?? openedRecord))
      || !matchesExactScope(originalTurn.binding.scope, binding.scope)
      || originalTurn.binding.execution.runtimeId !== opened.businessTurnRef.execution.runtimeId
      || originalTurn.binding.execution.executionEpoch !== opened.businessTurnRef.execution.executionEpoch) {
      return {
        state: 'unknown',
        reason: 'committed segment does not join its exact original business turn and physical handle',
        missingRefs: [openedRecord.commitId ?? `journal-seq-${openedRecord.seq}`],
      };
    }
    const ancestorParent = records
      .filter((record) => record.seq < openedRecord.seq)
      .map((record) => ({ record, envelope: readEnvelopePayload(record) }))
      .filter((entry): entry is { record: JournalRecord; envelope: EnvelopePayload } => entry.envelope !== null)
      .filter((entry) => sameScopedId(entry.envelope.control.intent.operationId, binding.parentOperationId)
        && matchesExactScope(entry.envelope.control.binding.scope, binding.scope)
        && entry.envelope.control.binding.agentRuntimeId === opened.businessTurnRef.execution.runtimeId
        && entry.envelope.control.binding.harnessExecutionEpoch === opened.businessTurnRef.execution.executionEpoch
        && sameScopedId(entry.envelope.control.binding.parentOperationId, binding.parentOperationId))
      .sort((left, right) => left.record.seq - right.record.seq)
      .at(-1);
    const ancestorBusiness = ancestorParent === undefined ? null
      : readTaskBusinessRegistration({ records, commitId: ancestorParent.envelope.control.binding.admissionCommitRef.commitId });
    if (ancestorParent === undefined || ancestorBusiness === null
      || !sameCommitRef(ancestorBusiness.commit, ancestorParent.envelope.control.binding.admissionCommitRef)
      || !sameScopedId(ancestorBusiness.registration.taskId, intent.taskId)
      || ancestorBusiness.registration.inputIdentity.requestRef !== ancestorParent.envelope.control.intent.inputRef
      || ancestorBusiness.registration.inputIdentity.digest !== ancestorParent.envelope.control.intent.inputDigest
      || ancestorParent.envelope.control.intent.inputRef !== parent.envelope.control.intent.inputRef
      || ancestorParent.envelope.control.intent.inputDigest !== parent.envelope.control.intent.inputDigest
      || ancestorParent.envelope.control.namespaceKey !== parent.envelope.control.namespaceKey
      || ancestorParent.envelope.control.fingerprintKey !== parent.envelope.control.fingerprintKey) {
      return {
        state: 'unknown',
        reason: 'committed segment ancestry does not join the original parent control and business registration',
        missingRefs: [openedRecord.commitId ?? `journal-seq-${openedRecord.seq}`],
      };
    }
  }
  return {
    state: 'verified',
    registration,
    registrationCommitRef: registrationRead.commit,
    parentControl: parent.envelope.control,
    parentControlCommitRef: journalCommitRef(parent.record),
    coverageCommitRef: journalCommitRef(coverage),
  };
}

function recomputeFingerprintKeys(control: OperationControlRecord): { readonly namespaceKey: string; readonly fingerprintKey: string } {
  try {
    return {
      namespaceKey: operationIdempotencyKey(control.intent),
      fingerprintKey: operationSemanticFingerprintKey(operationSemanticFingerprint(control.intent, control.registration)),
    };
  } catch (cause) {
    throw new AppLifecycleError(
      'operation-control-record-corrupt',
      'operation control record intent and registration are inconsistent',
      'preserve the operation control journal and reconcile the conflicting record before retrying',
      OWNER,
      cause,
    );
  }
}

function assertEnvelopeConsistent(payload: EnvelopePayload): void {
  const { event, control } = payload;
  if (!isObject(event) || !isObject(control)) corrupt('operation control envelope must carry an event and a control record');
  const intent = control.intent;
  const binding = control.binding;
  if (!isObject(intent) || !isObject(binding)) corrupt('operation control record must carry an intent and a binding');
  if (event.operationId === undefined || intent.operationId === undefined
    || !sameScopedId(event.operationId, intent.operationId)) {
    corrupt('operation control event and intent name different operations');
  }
  if (event.taskId === undefined || intent.taskId === undefined || !sameScopedId(event.taskId, intent.taskId)) {
    corrupt('operation control event and intent name different tasks');
  }
  if (event.status !== control.status) corrupt('operation control event status does not match its successor state');
  if (event.executionEpoch !== control.executionEpoch) corrupt('operation control event epoch does not match its successor state');
  if (!isObject(binding.scope) || binding.scope.taskId === undefined) corrupt('operation control binding must carry a task scope');
  if (!sameScopedId(binding.scope.organId, intent.requestedScope.organId)) corrupt('operation control binding scope does not match its intent');
  if (intent.requestedScope.taskId !== undefined && !sameScopedId(binding.scope.taskId, intent.requestedScope.taskId)) {
    corrupt('operation control binding task does not match its intent');
  }
  if (!nonEmptyString(binding.agentRuntimeId)) corrupt('operation control binding must carry an agent runtime identity');
  if (!positiveInteger(binding.harnessExecutionEpoch)) corrupt('operation control binding must carry a positive Harness execution epoch');
  const keys = recomputeFingerprintKeys(control);
  if (control.namespaceKey !== keys.namespaceKey) corrupt('operation control namespace key does not match its intent');
  if (control.fingerprintKey !== keys.fingerprintKey) corrupt('operation control fingerprint key does not match its intent and registration');
}

function readCoveragePayload(record: JournalRecord): CoveragePayload | null {
  const payload = record.payload;
  if (!isObject(payload) || payload.kind !== COVERAGE_PAYLOAD_KIND) return null;
  if (payload.schemaVersion !== 1) corrupt('operation control coverage payload schemaVersion must be 1');
  if (!isObject(payload.scope)) corrupt('operation control coverage payload must carry a scope');
  assertCommitRef(payload.admissionCommitRef, 'operation control coverage admission commit ref');
  if (payload.agentRuntimeId !== undefined && !nonEmptyString(payload.agentRuntimeId)) {
    corrupt('operation control coverage agentRuntimeId must be a non-empty string');
  }
  if (payload.harnessExecutionEpoch !== undefined && !positiveInteger(payload.harnessExecutionEpoch)) {
    corrupt('operation control coverage harnessExecutionEpoch must be a positive integer');
  }
  return payload as unknown as CoveragePayload;
}

function readEnvelopePayload(record: JournalRecord): EnvelopePayload | null {
  const payload = record.payload;
  if (!isObject(payload) || payload.kind !== ENVELOPE_PAYLOAD_KIND) return null;
  if (payload.schemaVersion !== 1) corrupt('operation control envelope payload schemaVersion must be 1');
  const envelope = payload as unknown as EnvelopePayload;
  assertEnvelopeConsistent(envelope);
  return envelope;
}

function isLegacyOperationRecord(record: JournalRecord): boolean {
  if (record.kind !== 'event') return false;
  const payload = record.payload;
  if (!isObject(payload)) return false;
  if (payload.kind === COVERAGE_PAYLOAD_KIND || payload.kind === ENVELOPE_PAYLOAD_KIND) return false;
  // These carriers belong to the completion codec, which validates their facts and receipts.
  if (payload.kind === 'operation-effect-intent' || payload.kind === 'operation-completion') return false;
  if (payload.type === 'event' && isObject(payload.event)) return true;
  return typeof payload.kind === 'string' && payload.kind.startsWith('operation');
}

function journalCommitRef(record: JournalRecord): JournalCommitRef {
  return {
    commitId: record.commitId ?? `journal-seq-${record.seq}`,
    journalSeq: record.seq,
    recordDigest: record.recordDigest,
  };
}

function hexDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function coverageCommitId(input: OperationCoverageInitialization): string {
  return `operation-control-coverage:${hexDigest([
    input.scope.organId.scope,
    input.scope.organId.value,
    input.scope.taskId?.value ?? null,
    input.agentRuntimeId ?? null,
    input.harnessExecutionEpoch ?? null,
    input.admissionCommitRef.commitId,
    input.admissionCommitRef.journalSeq,
    input.admissionCommitRef.recordDigest,
  ])}`;
}

/**
 * Envelope commit identity binds the exact physical namespace. A Provider
 * lifecycle event id may be reused across incarnations, so the same event id in
 * a different runtime/epoch must not collide with the original record.
 */
function envelopeCommitId(event: OperationEvent, binding: OperationControlBinding): string {
  return `operation-control-envelope:${hexDigest([
    binding.scope.organId.scope,
    binding.scope.organId.value,
    binding.scope.taskId?.scope ?? null,
    binding.scope.taskId?.value ?? null,
    binding.agentRuntimeId,
    binding.harnessExecutionEpoch,
    event.operationId.scope,
    event.operationId.value,
    event.eventId,
  ])}`;
}

function coverageRecords(records: readonly JournalRecord[], scope: ScopeRef): readonly { readonly record: JournalRecord; readonly payload: CoveragePayload }[] {
  const matches: { record: JournalRecord; payload: CoveragePayload }[] = [];
  for (const record of records) {
    const payload = readCoveragePayload(record);
    if (payload && matchesSelectorScope(payload.scope, scope)) matches.push({ record, payload });
  }
  return matches;
}

export function createJsonlOperationControlJournal(input: {
  readonly journal: JsonlOrganJournal;
}): OperationJournalPort {
  const journal = input.journal;

  async function verifiedRecords(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new AppLifecycleError(
        'operation-control-journal-corrupt',
        verification.error ?? 'operation control journal is invalid',
        'preserve the operation control journal and repair its committed history before reading control state',
        OWNER,
      );
    }
    return verification.records;
  }

  return {
    async initializeCoverage(coverage: OperationCoverageInitialization): Promise<JournalCommitRef> {
      if (coverage.scope.taskId === undefined) {
        throw new AppLifecycleError(
          'operation-control-coverage-invalid',
          'operation control coverage requires an organ and task scope',
          'initialize coverage at the actual new-task admission boundary',
          OWNER,
        );
      }
      assertCommitRef(coverage.admissionCommitRef, 'operation control coverage admission commit ref');
      const commitId = coverageCommitId(coverage);
      const appended = await journal.transaction<{ readonly existing: JournalRecord | null }, JournalRecord>(
        ({ records }) => {
          // A coverage fact is keyed by the exact physical namespace
          // (runtime + Harness epoch), never by task scope alone. The same
          // namespace with the same admission receipt is idempotent; the same
          // namespace with a different receipt is a conflict; a different
          // physical namespace appends its own independent coverage.
          const sameNamespace = coverageRecords(records, coverage.scope)
            .filter((entry) => sameCoverageNamespace(entry.payload, coverage.agentRuntimeId, coverage.harnessExecutionEpoch));
          if (sameNamespace.length > 0) {
            if (sameNamespace.some((entry) => !sameCommitRef(entry.payload.admissionCommitRef, coverage.admissionCommitRef))) {
              throw new AppLifecycleError(
                'operation-control-coverage-conflict',
                `operation control coverage already exists for ${coverage.scope.taskId?.value}`,
                'reconcile the existing coverage fact before initializing another',
                OWNER,
              );
            }
            return { existing: sameNamespace[0]!.record };
          }
          return { existing: null };
        },
        async ({ existing }, append) => existing ?? append({
          commitId,
          kind: 'event',
          scope: coverage.scope,
          payload: {
            kind: COVERAGE_PAYLOAD_KIND,
            schemaVersion: 1,
            scope: coverage.scope,
            ...(coverage.agentRuntimeId !== undefined ? { agentRuntimeId: coverage.agentRuntimeId } : {}),
            ...(coverage.harnessExecutionEpoch !== undefined ? { harnessExecutionEpoch: coverage.harnessExecutionEpoch } : {}),
            admissionCommitRef: coverage.admissionCommitRef,
          },
        }),
      );
      return journalCommitRef(appended);
    },

    async commit(event: OperationEvent, control: OperationControlRecord): Promise<JournalCommitRef> {
      if (!isObject(event) || !isObject(control) || !isObject(control.binding)) {
        throw new AppLifecycleError(
          'operation-control-commit-invalid',
          'operation control commit requires an operation event and its successor control record',
          'fix the Gateway control commit input',
          OWNER,
        );
      }
      const payload: EnvelopePayload = {
        kind: ENVELOPE_PAYLOAD_KIND,
        schemaVersion: 1,
        event,
        control,
      };
      assertEnvelopeConsistent(payload);
      const binding = control.binding;
      const scope = binding.scope;
      const commitId = envelopeCommitId(event, binding);
      const appended = await journal.transaction<
        { readonly existing: JournalRecord | null; readonly payload: EnvelopePayload | null },
        JournalRecord
      >(
        ({ records }) => {
          const coverage = coverageRecords(records, scope)
            .find((entry) => sameCoverageNamespace(entry.payload, binding.agentRuntimeId, binding.harnessExecutionEpoch));
          if (coverage === undefined) {
            throw new AppLifecycleError(
              'operation-control-coverage-missing',
              `operation ${event.operationId.value} cannot commit control before its task coverage is initialized`,
              'initialize durable coverage at the actual new-task admission boundary before admitting operations',
              OWNER,
            );
          }
          if (!sameCommitRef(coverage.payload.admissionCommitRef, binding.admissionCommitRef)) {
            throw new AppLifecycleError(
              'operation-control-binding-conflict',
              `operation ${event.operationId.value} admission does not match its physical namespace coverage`,
              'reconcile the runtime/admission binding with the admitted coverage before retrying',
              OWNER,
            );
          }
          // Explicit child controls must physically prove their parent/child
          // relationship inside the same append transaction, before any child
          // control becomes durable.
          if (control.childAdmission !== undefined) {
            const verified = verifyChildRelationship(records, binding, control.intent, control.childAdmission);
            if (verified.state !== 'verified') {
              throw new AppLifecycleError(
                'operation-control-child-admission-unknown',
                `operation ${event.operationId.value} child admission is not physically verified: ${verified.reason}`,
                'reconcile the child business registration, parent control and coverage before committing child control',
                OWNER,
              );
            }
          }
          const chain = records
            .map((record) => ({ record, envelope: readEnvelopePayload(record) }))
            .filter((entry): entry is { record: JournalRecord; envelope: EnvelopePayload } => entry.envelope !== null)
            .filter((entry) => matchesExactScope(entry.envelope.control.binding.scope, binding.scope))
            .filter((entry) => entry.envelope.control.binding.agentRuntimeId === binding.agentRuntimeId
              && entry.envelope.control.binding.harnessExecutionEpoch === binding.harnessExecutionEpoch)
            .filter((entry) => sameScopedId(entry.envelope.control.intent.operationId, event.operationId))
            .sort((left, right) => left.record.seq - right.record.seq);
          const latest = chain.at(-1);
          if (latest) {
            if (!sameBindingIdentity(latest.envelope.control, control)) {
              throw new AppLifecycleError(
                'operation-control-binding-conflict',
                `operation ${event.operationId.value} control binding differs from its committed chain`,
                'reconcile the conflicting operation identity before retrying',
                OWNER,
              );
            }
            if (latest.envelope.event.eventId === event.eventId) {
              // Exact replay in the same physical namespace returns the
              // original receipt and never rewrites the ledger or borrows
              // another namespace's record.
              if (latest.envelope.control.status !== control.status
                || latest.envelope.control.executionEpoch !== control.executionEpoch) {
                throw new AppLifecycleError(
                  'operation-control-replay-conflict',
                  `operation ${event.operationId.value} replay reuses event ${event.eventId} with different content`,
                  'commit a new event identity for a different successor state',
                  OWNER,
                );
              }
              return { existing: latest.record, payload: null };
            }
            if (control.executionEpoch < latest.envelope.control.executionEpoch) {
              throw new AppLifecycleError(
                'operation-control-stale-transition',
                `operation ${event.operationId.value} control transition regresses execution epoch`,
                'read the current operation control head before committing a stale successor',
                OWNER,
              );
            }
          }
          return { existing: null, payload };
        },
        async (plan, append) => plan.existing ?? append({
          commitId,
          kind: 'event',
          scope,
          payload: { ...plan.payload! },
        }),
      );
      return journalCommitRef(appended);
    },

    async readControl(selector: OperationControlSelector): Promise<OperationControlReadback> {
      return readOperationControlFromRecords(await verifiedRecords(), selector);
    },

    async readChildAdmission(input: OperationChildAdmissionLookup): Promise<OperationChildAdmissionReadback> {
      assertCommitRef(input.admission.authorityCommitRef, 'child admission authority commit ref');
      assertCommitRef(input.admission.businessRegistrationCommitRef, 'child admission business registration commit ref');
      assertCommitRef(input.admission.coverageCommitRef, 'child admission coverage commit ref');
      const records = await verifiedRecords();
      return verifyChildRelationship(records, input.binding, input.intent, input.admission);
    },
  };
}

/** Owner decoder for verified records, including reads inside a caller's lock. */
export function readOperationControlFromRecords(
  records: readonly JournalRecord[],
  selector: OperationControlSelector,
): OperationControlReadback {
      const coverages = coverageRecords(records, selector.scope)
        .filter((entry) => matchesSelectedNamespace(entry.payload.agentRuntimeId, entry.payload.harnessExecutionEpoch, selector));
      if (coverages.length === 0) {
        return {
          state: 'unknown',
          scope: selector.scope,
          reason: 'operation control coverage was never initialized for this scope',
          missingRefs: [],
        };
      }
      const distinctCoverage = new Set(coverages.map((entry) => entry.payload.admissionCommitRef.commitId));
      const namespaces = new Set(coverages.map((entry) => coverageNamespaceKey(entry.payload)));
      if (namespaces.size > 1) {
        return {
          state: 'unknown',
          scope: selector.scope,
          reason: 'scope carries more than one physical operation-control namespace; read it with an explicit agent runtime and Harness execution epoch',
          missingRefs: [],
        };
      }
      if (distinctCoverage.size > 1) corrupt('operation control namespace carries conflicting coverage facts');
      const selected = coverages[0]!;
      const coverageRef = journalCommitRef(selected.record);
      const namespace: OperationControlSelector = {
        scope: selector.scope,
        agentRuntimeId: selected.payload.agentRuntimeId,
        harnessExecutionEpoch: selected.payload.harnessExecutionEpoch,
      };

      const scopedEnvelopes: { readonly record: JournalRecord; readonly envelope: EnvelopePayload }[] = [];
      let legacy = false;
      for (const record of records) {
        const envelope = readEnvelopePayload(record);
        if (envelope) {
          if (matchesSelectorScope(envelope.control.binding.scope, selector.scope)
            && matchesSelectedNamespace(envelope.control.binding.agentRuntimeId, envelope.control.binding.harnessExecutionEpoch, namespace)) {
            scopedEnvelopes.push({ record, envelope });
          }
          continue;
        }
        if (readCoveragePayload(record)) continue;
        if (isLegacyOperationRecord(record) && matchesSelectorScope(record.scope, selector.scope)) legacy = true;
      }
      if (legacy) {
        return {
          state: 'unknown',
          scope: selector.scope,
          reason: 'scope contains legacy operation events without typed operation-control state',
          missingRefs: [],
        };
      }

      scopedEnvelopes.sort((left, right) => left.record.seq - right.record.seq);
      const latestByOperation = new Map<string, { readonly record: JournalRecord; readonly envelope: EnvelopePayload }>();
      for (const entry of scopedEnvelopes) {
        const key = `${entry.envelope.control.intent.operationId.scope}:${entry.envelope.control.intent.operationId.value}`;
        const previous = latestByOperation.get(key);
        if (previous) {
          if (!sameBindingIdentity(previous.envelope.control, entry.envelope.control)) {
            corrupt(`operation ${entry.envelope.control.intent.operationId.value} control chain changes its binding identity`);
          }
          if (entry.envelope.control.executionEpoch < previous.envelope.control.executionEpoch) {
            corrupt(`operation ${entry.envelope.control.intent.operationId.value} control chain regresses its execution epoch`);
          }
        }
        latestByOperation.set(key, entry);
      }

      const orderedOperations = [...latestByOperation.values()]
        .filter((entry) => selector.operationId === undefined
          || sameScopedId(entry.envelope.control.intent.operationId, selector.operationId))
        .sort((left, right) => left.record.seq - right.record.seq);
      const operations = orderedOperations.map((entry) => entry.envelope.control);
      const operationCommits = orderedOperations.map((entry) => journalCommitRef(entry.record));
      const currentControlCommitRef = orderedOperations.length > 0
        ? journalCommitRef(orderedOperations[orderedOperations.length - 1]!.record)
        : coverageRef;
      // Validate the entire namespace above before projecting one operation.
      // Its descendants remain namespace obligations, not gaps in its body.
      const pendingChildren = pendingChildRegistrations(records, namespace, latestByOperation)
        .filter((child) => selector.operationId === undefined || sameScopedId(child.operationId, selector.operationId));
      if (pendingChildren.length > 0) {
        return {
          state: 'unknown',
          scope: selector.scope,
          reason: 'scope has registered child operations without committed child control',
          missingRefs: pendingChildren.map((child) => child.businessRegistrationCommitRef.commitId),
          pendingChildren,
        };
      }
      return {
        state: 'complete',
        scope: selector.scope,
        coverageCommitRef: coverageRef,
        currentControlCommitRef,
        operations,
        operationCommits,
      };
}

function sameBindingIdentity(left: OperationControlRecord, right: OperationControlRecord): boolean {
  return left.namespaceKey === right.namespaceKey
    && left.fingerprintKey === right.fingerprintKey
    && sameScopedId(left.intent.operationId, right.intent.operationId)
    && left.binding.agentRuntimeId === right.binding.agentRuntimeId
    && left.binding.harnessExecutionEpoch === right.binding.harnessExecutionEpoch
    && sameScopedId(left.binding.parentOperationId, right.binding.parentOperationId)
    && sameCommitRef(left.binding.admissionCommitRef, right.binding.admissionCommitRef)
    && sameChildAdmission(left.childAdmission, right.childAdmission);
}

function sameChildAdmission(
  left: OperationChildAdmission | undefined,
  right: OperationChildAdmission | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameCommitRef(left.authorityCommitRef, right.authorityCommitRef)
    && sameCommitRef(left.businessRegistrationCommitRef, right.businessRegistrationCommitRef)
    && sameCommitRef(left.coverageCommitRef, right.coverageCommitRef);
}

/**
 * Enumerate durable child business registrations under the declared parent
 * namespace that have no committed child control yet. A parent-scoped read must
 * surface them as `unknown` instead of reporting a complete empty set, and must
 * never synthesize a lifecycle from the registration.
 */
function pendingChildRegistrations(
  records: readonly JournalRecord[],
  selector: OperationControlSelector,
  committedByOperation: ReadonlyMap<string, { readonly record: JournalRecord; readonly envelope: EnvelopePayload }>,
): readonly OperationPendingChild[] {
  const parentOperationId = selector.scope.operationId;
  if (parentOperationId === undefined) return [];
  const pending: OperationPendingChild[] = [];
  for (const record of records) {
    const registration = readBusinessRegistrationRecord(records, record);
    const provenance = registration?.operationProvenance;
    if (registration === null || provenance === undefined) continue;
    if (!matchesSelectorScope(provenance.parentNamespace, selector.scope)) continue;
    if (!sameScopedId(provenance.parentOperationId, parentOperationId)) continue;
    if (!matchesSelectedNamespace(provenance.agentRuntimeId, provenance.harnessExecutionEpoch, selector)) continue;
    const key = `${provenance.operationId.scope}:${provenance.operationId.value}`;
    const committedAdmission = committedByOperation.get(key)?.envelope.control.childAdmission;
    if (committedAdmission !== undefined
      && sameCommitRef(committedAdmission.businessRegistrationCommitRef, journalCommitRef(record))) continue;
    pending.push({
      operationId: provenance.operationId,
      businessRegistrationCommitRef: journalCommitRef(record),
    });
  }
  return pending;
}
