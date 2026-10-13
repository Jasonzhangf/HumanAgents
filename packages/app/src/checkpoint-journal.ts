import { createHash } from 'node:crypto';
import { JsonlOrganJournal, type JournalRecord } from '../../adapters/jsonl/src/index.js';
import { ImmutableAssetStore } from '../../adapters/filesystem/src/index.js';
import type {
  CanonicalUtcInstant,
  CheckpointCommitIdentityV2,
  CheckpointCommitEnvelopeV1,
  CheckpointReceiptRelationshipV1,
  CheckpointTimeAuthority,
  CheckpointTimeAuthorityMetadata,
  Checkpoint,
  EvidenceRef,
  RawContentReadPort,
  ScopeRef,
} from '../../contracts/src/index.js';
import {
  canonicalJsonStringify,
  checkpointCommitIdentityV2,
  checkpointIntentDigestV1,
  checkpointRefV2,
  scopeDigest,
  validateCheckpointCommitEnvelopeV1,
  validateCheckpointReceiptRelationship,
} from '../../contracts/src/index.js';
import type {
  CheckpointAppendRequest,
  CheckpointAppendReceipt,
  CheckpointChainVerification,
  CheckpointClosurePort,
  CheckpointReentryAdmissionPort,
  LatestCheckpointRecord,
  NativeCheckpointCommitRequest,
  NativeCheckpointJournalPort,
  SemanticContextViewCommitRequest,
  SemanticHistoryPersistencePort,
  SemanticHistoryPublicationCommitRequest,
} from '../../runtime/src/checkpoints/ports.js';
import {
  assertDeadEndRecord,
  assertInteractionClosure,
  assertReentryRecord,
  sameCheckpointClosureRecord,
  sameReentryRecord,
  type ClosureRecord,
} from '../../runtime/src/checkpoints/closure.js';
import type { ActiveTurnJournalPort } from '../../runtime/src/context/active-turn-journal.js';
import {
  buildSemanticContextViewBodyV1,
  buildSemanticHistoryPublicationBodyV1,
  contextViewIdentityV1,
  contextViewIntentDigestV1,
  encodeSemanticAssetBodyV1,
  historyPublicationIdentityV1,
  historyPublicationIntentDigestV1,
  projectAdmittedTurnIdentityV1,
  projectCommittedSemanticCheckpointV1,
  semanticAssetDigestV1,
  semanticAssetIdV1,
  validateSemanticContextViewBodyV1,
  validateSemanticHistoryExactLookupV1,
  validateSemanticHistoryPublicationBodyV1,
  type AdoptedChildSourceV1,
  type CommittedSemanticCheckpointV1,
  type FourPartSemanticViewV1,
  type SemanticAssetDescriptorV1,
  type SemanticContextViewBodyV1,
  type SemanticHistoryDigestV1,
  type SemanticHistoryExactLookupV1,
  type SemanticHistoryPublicationBodyV1,
  type SemanticPhase,
  type SemanticPhaseReceiptV1,
} from '../../runtime/src/context/semantic-history.js';
import { materializeAdoptedChildSource } from '../../runtime/src/context/semantic-history-adoption.js';
import { scopeContains } from '../../runtime/src/events/index.js';
import { AppLifecycleError } from './errors.js';

const CHECKPOINT_EVIDENCE_PREFIX = 'humanagent://checkpoint/';
const CHECKPOINT_CLOSURE_PAYLOAD_KIND = 'checkpoint-closure';

export function checkpointEvidenceText(checkpoint: Checkpoint): string {
  return JSON.stringify(checkpoint);
}

export function checkpointEvidenceDigest(checkpoint: Checkpoint): string {
  return `sha256:${createHash('sha256').update(checkpointEvidenceText(checkpoint)).digest('hex')}`;
}

export function checkpointEvidenceLocator(checkpoint: Pick<Checkpoint, 'id'>): string {
  return `${CHECKPOINT_EVIDENCE_PREFIX}${checkpoint.id.value}`;
}

export function checkpointClosureEvidenceLocator(closureId: string): string {
  return `humanagent://checkpoint-closure/${closureId}`;
}

export function checkpointClosureEvidenceText(closure: ClosureRecord): string {
  return JSON.stringify(closure);
}

export function checkpointClosureEvidenceDigest(closure: ClosureRecord): string {
  return `sha256:${createHash('sha256').update(checkpointClosureEvidenceText(closure)).digest('hex')}`;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

export async function readCommittedCheckpoint(input: {
  readonly filePath: string;
  readonly scope: ScopeRef;
  readonly checkpointId: Checkpoint['id'];
}): Promise<{ readonly checkpoint: Checkpoint; readonly recordDigest: string }> {
  const journal = new JsonlOrganJournal(input.filePath);
  const verification = await journal.verify();
  if (!verification.valid) {
    throw new AppLifecycleError(
      'checkpoint-journal-corrupt',
      verification.error ?? 'checkpoint journal is invalid',
      'preserve the checkpoint journal and repair its committed history before publishing a memory boundary',
      'app-checkpoint-journal',
    );
  }
  const record = verification.records.find((candidate) =>
    candidate.kind === 'checkpoint'
    && candidate.checkpoint !== undefined
    && candidate.checkpoint.id.value === input.checkpointId.value
    && sameScope(candidate.checkpoint.scope, input.scope));
  if (!record?.checkpoint) {
    throw new AppLifecycleError(
      'checkpoint-evidence-missing',
      `checkpoint is not committed: ${input.checkpointId.value}`,
      'commit the checkpoint before publishing a memory boundary',
      'app-checkpoint-journal',
    );
  }
  return { checkpoint: record.checkpoint, recordDigest: record.recordDigest };
}

export async function readCheckpointEvidence(input: {
  readonly filePath: string;
  readonly scope: ScopeRef;
  readonly evidence: EvidenceRef;
}): Promise<{ readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }> {
  const journal = new JsonlOrganJournal(input.filePath);
  const verification = await journal.verify();
  if (!verification.valid) {
    throw new AppLifecycleError(
      'checkpoint-journal-corrupt',
      verification.error ?? 'checkpoint journal is invalid',
      'preserve the checkpoint journal and repair its committed history before reading evidence',
      'app-checkpoint-journal',
    );
  }
  const record = verification.records.find((candidate) =>
    candidate.kind === 'checkpoint'
    && candidate.checkpoint !== undefined
    && scopeContains(input.scope, candidate.checkpoint.scope)
    && checkpointEvidenceLocator(candidate.checkpoint) === input.evidence.locator);
  if (!record?.checkpoint) {
    throw new AppLifecycleError(
      'checkpoint-evidence-missing',
      `checkpoint evidence is unavailable: ${input.evidence.locator}`,
      'refresh the checkpoint event from the authoritative journal',
      'app-checkpoint-journal',
    );
  }
  return {
    sourceRef: checkpointEvidenceLocator(record.checkpoint),
    sourceDigest: checkpointEvidenceDigest(record.checkpoint),
    text: checkpointEvidenceText(record.checkpoint),
  };
}

/**
 * Adapts the authoritative append-only Organ Journal to the checkpoint
 * coordinator port. This is the only app-side checkpoint persistence path;
 * SessionStore records only reference checkpoint ids and never become a
 * second source of task state.
 */
export function createJsonlCheckpointJournal(input: {
  readonly filePath: string;
}): NativeCheckpointJournalPort {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'checkpoint-journal-invalid',
      'checkpoint journal path is required',
      'provide the runtime checkpoint journal path',
      'app-checkpoint-journal',
    );
  }
  const journal = new JsonlOrganJournal(input.filePath);

  async function verifyJournal(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new AppLifecycleError(
        'checkpoint-journal-corrupt',
        verification.error ?? 'checkpoint journal is invalid',
        'preserve the checkpoint journal and repair its committed history before committing or reading a checkpoint',
        'app-checkpoint-journal',
      );
    }
    return verification.records;
  }

  function nativeRecord(records: readonly JournalRecord[], commitIdentity: string): JournalRecord | undefined {
    return records.find((record) => record.commitId === commitIdentity);
  }

  function sameCheckpointIdentity(
    record: JournalRecord,
    checkpoint: Pick<Checkpoint, 'id' | 'scope'>,
  ): boolean {
    return record.kind === 'checkpoint'
      && record.checkpoint !== undefined
      && record.checkpoint.id.scope === checkpoint.id.scope
      && record.checkpoint.id.value === checkpoint.id.value
      && sameScope(record.checkpoint.scope, checkpoint.scope);
  }

  async function committedNativeRelationship(
    record: JournalRecord,
    expectedIdentity: CheckpointCommitIdentityV2,
  ): Promise<CheckpointReceiptRelationshipV1> {
    const checkpoint = record.checkpoint;
    const envelope = record.nativeCheckpointEnvelope;
    if (!checkpoint || !envelope) {
      throw new AppLifecycleError(
        'checkpoint-native-envelope-missing',
        `checkpoint record is not a native checkpoint-v2 commit: ${expectedIdentity}`,
        'preserve the committed record; do not upgrade legacy checkpoint evidence in place',
        'app-checkpoint-journal',
      );
    }
    await validateCheckpointCommitEnvelopeV1(envelope, { checkpoint, identity: expectedIdentity });
    const relationship: CheckpointReceiptRelationshipV1 = {
      checkpoint,
      envelope,
      receipt: {
        commitIdentity: expectedIdentity,
        checkpointRef: checkpointRefV2(expectedIdentity),
        journalReceiptRef: `humanagent://journal-record/v1/${await scopeDigest(checkpoint.scope)}/${record.seq}/${record.recordDigest.slice('sha256:'.length)}`,
        committedAt: envelope.committedAt,
        timeAuthority: envelope.timeAuthority,
      },
      checkpointSeq: checkpoint.seq,
      journalSeq: record.seq,
      recordDigest: record.recordDigest as CheckpointReceiptRelationshipV1['recordDigest'],
    };
    await validateCheckpointReceiptRelationship(relationship);
    return relationship;
  }

  function latestCheckpoint(records: readonly JournalRecord[], scope: ScopeRef): LatestCheckpointRecord | null {
    const checkpoints = records.filter((record) =>
      record.kind === 'checkpoint'
      && record.scope.organId.value === scope.organId.value
      && record.scope.taskId?.value === scope.taskId?.value
      && record.scope.cycleId?.value === scope.cycleId?.value
      && record.scope.operationId?.value === scope.operationId?.value);
    const latest = checkpoints.at(-1);
    if (!latest?.checkpoint) return null;
    const previous = checkpoints.at(-2)?.checkpoint ?? null;
    return {
      checkpoint: latest.checkpoint,
      previous,
      recordDigest: latest.recordDigest,
    };
  }

  return {
    async verify(scope: ScopeRef): Promise<CheckpointChainVerification> {
      const records = (await verifyJournal()).filter((record) =>
        record.scope.organId.value === scope.organId.value
        && record.scope.taskId?.value === scope.taskId?.value
        && record.scope.cycleId?.value === scope.cycleId?.value
        && record.scope.operationId?.value === scope.operationId?.value);
      for (let index = 1; index < records.length; index += 1) {
        const previous = records[index - 1];
        const current = records[index];
        if (previous?.recordDigest !== current?.previousRecordDigest) {
          return { valid: false, reason: 'checkpoint predecessor link is broken' };
        }
      }
      return { valid: true };
    },

    async readLatest(scope: ScopeRef): Promise<LatestCheckpointRecord | null> {
      return latestCheckpoint(await verifyJournal(), scope);
    },

    async append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt> {
      if (!input.ownerId.trim()) {
        throw new AppLifecycleError(
          'checkpoint-owner-missing',
          'checkpoint append requires an owner',
          'provide the runtime checkpoint owner',
          'app-checkpoint-journal',
        );
      }
      const record = await journal.append({
        commitId: input.commitId,
        kind: 'checkpoint',
        scope: input.checkpoint.scope,
        checkpoint: input.checkpoint,
      });
      if (!record.checkpoint) {
        throw new AppLifecycleError(
          'checkpoint-append-mismatch',
          'journal append did not return the committed checkpoint',
          'inspect the checkpoint journal owner',
          'app-checkpoint-journal',
        );
      }
      return {
        checkpointId: record.checkpoint.id,
        seq: record.checkpoint.seq,
        recordDigest: record.recordDigest,
      };
    },

    async commitNativeCheckpoint(input: NativeCheckpointCommitRequest): Promise<CheckpointReceiptRelationshipV1> {
      if (!input.ownerId.trim()) {
        throw new AppLifecycleError(
          'checkpoint-owner-missing',
          'native checkpoint commit requires an owner',
          'provide the runtime checkpoint owner',
          'app-checkpoint-journal',
        );
      }
      const identity = await checkpointCommitIdentityV2({ checkpoint: input.checkpoint });
      const timeAuthority: CheckpointTimeAuthorityMetadata = {
        source: input.timeAuthority.source,
        owner: input.timeAuthority.owner,
        authorityRef: input.timeAuthority.authorityRef,
      };
      const intentDigest = await checkpointIntentDigestV1({
        checkpoint: input.checkpoint,
        timeAuthority,
      });

      return await journal.transaction<
        { readonly native?: JournalRecord; readonly legacy?: JournalRecord },
        CheckpointReceiptRelationshipV1
      >(
        ({ records }) => {
          const native = nativeRecord(records, identity);
          return {
            native,
            legacy: native === undefined
              ? records.find((record) => sameCheckpointIdentity(record, input.checkpoint))
              : undefined,
          };
        },
        async ({ native, legacy }, append) => {
          if (native) {
            if (native.nativeCheckpointEnvelope?.intentDigest !== intentDigest) {
              throw new AppLifecycleError(
                'checkpoint-native-conflict',
                `checkpoint identity is already committed with a different intent: ${identity}`,
                'preserve the committed native checkpoint and use the original intent or a new checkpoint identity',
                'app-checkpoint-journal',
              );
            }
            return await committedNativeRelationship(native, identity);
          }
          if (legacy) {
            throw new AppLifecycleError(
              'checkpoint-native-envelope-missing',
              `legacy checkpoint record occupies native identity: ${identity}`,
              'preserve the legacy record and choose a new checkpoint identity',
              'app-checkpoint-journal',
            );
          }

          const committedAt = await input.timeAuthority.sampleCommittedAt();
          const envelope: CheckpointCommitEnvelopeV1 = {
            version: 1,
            identity,
            committedAt,
            timeAuthority,
            intentDigest,
          };
          const appended = await append({
            commitId: identity,
            kind: 'checkpoint',
            scope: input.checkpoint.scope,
            checkpoint: input.checkpoint,
            nativeCheckpointEnvelope: envelope,
          });
          return await committedNativeRelationship(appended, identity);
        },
      );
    },

    async readNativeCheckpoint(input: {
      readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
    }): Promise<CheckpointReceiptRelationshipV1 | null> {
      const identity = await checkpointCommitIdentityV2({ checkpoint: input.checkpoint });
      const records = await verifyJournal();
      const existing = nativeRecord(records, identity);
      if (existing) return await committedNativeRelationship(existing, identity);
      if (records.some((record) => sameCheckpointIdentity(record, input.checkpoint))) {
        throw new AppLifecycleError(
          'checkpoint-native-envelope-missing',
          `checkpoint record has no native envelope: ${identity}`,
          'preserve the legacy record and do not treat it as a native checkpoint-v2 commit',
          'app-checkpoint-journal',
        );
      }
      return null;
    },
  };
}

function isClosureRecord(value: unknown): value is ClosureRecord {
  if (typeof value !== 'object' || value === null) return false;
  const closureKind = (value as { readonly closureKind?: unknown }).closureKind;
  return closureKind === undefined
    || closureKind === 'checkpoint'
    || closureKind === 'interaction'
    || closureKind === 'reentry';
}

function identityOfClosure(closure: ClosureRecord): string {
  return 'closureId' in closure ? closure.closureId : closure.deadEndRef;
}

function closureJournalCommitId(identity: string): string {
  // Closure identities remain canonical evidence refs; the journal commit key
  // is a bounded idempotency key and may need to represent longer identities.
  return `journal-closure:${createHash('sha256').update(identity).digest('hex')}`;
}

function assertClosureRecord(closure: ClosureRecord): void {
  try {
    if (!('closureKind' in closure)) {
      assertDeadEndRecord(closure);
      return;
    }
    if (closure.closureKind === 'checkpoint') {
      if (!closure.closureId.trim()) throw new Error('checkpoint closure id is required');
      if (closure.compatibilityVersion !== 1 && closure.compatibilityVersion !== 2) {
        throw new Error('checkpoint closure compatibility version is unsupported');
      }
      return;
    }
    if (closure.closureKind === 'interaction') {
      assertInteractionClosure(closure);
      return;
    }
    assertReentryRecord(closure);
  } catch (error) {
    throw new AppLifecycleError(
      'checkpoint-closure-corrupt',
      error instanceof Error ? error.message : 'checkpoint closure is invalid',
      'preserve the checkpoint journal and repair the closure record before recovery',
      'app-checkpoint-journal',
    );
  }
}

function closureFromRecord(record: JournalRecord): ClosureRecord | null {
  const payload = record.payload;
  if (payload?.['kind'] !== CHECKPOINT_CLOSURE_PAYLOAD_KIND) return null;
  const closure = payload['closure'];
  if (!isClosureRecord(closure)) {
    throw new AppLifecycleError(
      'checkpoint-closure-corrupt',
      `checkpoint closure record ${record.seq} is malformed`,
      'preserve the checkpoint journal and repair the closure record before recovery',
      'app-checkpoint-journal',
    );
  }
  assertClosureRecord(closure);
  return closure;
}

function closureMatches(left: ClosureRecord, right: ClosureRecord): boolean {
  if (!('closureKind' in left) || !('closureKind' in right)) {
    return !('closureKind' in left)
      && !('closureKind' in right)
      && left.deadEndRef === right.deadEndRef
      && left.scope.organId.value === right.scope.organId.value
      && left.scope.taskId?.value === right.scope.taskId?.value
      && left.scope.cycleId?.value === right.scope.cycleId?.value
      && left.scope.operationId?.value === right.scope.operationId?.value
      && left.failedPathRefs.length === right.failedPathRefs.length
      && left.failedPathRefs.every((ref, index) => ref === right.failedPathRefs[index])
      && left.conclusion === right.conclusion
      && left.invalidatedAssumptions.length === right.invalidatedAssumptions.length
      && left.invalidatedAssumptions.every((assumption, index) => assumption === right.invalidatedAssumptions[index])
      && left.evidenceRefs.length === right.evidenceRefs.length
      && left.evidenceRefs.every((ref, index) => JSON.stringify(ref) === JSON.stringify(right.evidenceRefs[index]))
      && JSON.stringify(left.suggestedAlternatives) === JSON.stringify(right.suggestedAlternatives);
  }
  if (left.closureKind !== right.closureKind) return false;
  if (left.closureKind === 'checkpoint' && right.closureKind === 'checkpoint') {
    return sameCheckpointClosureRecord(left, right);
  }
  if (left.closureKind === 'reentry' && right.closureKind === 'reentry') {
    return sameReentryRecord(left, right);
  }
  if (left.closureKind === 'interaction' && right.closureKind === 'interaction') {
    return left.closureId === right.closureId
      && left.scope.organId.value === right.scope.organId.value
      && left.scope.taskId?.value === right.scope.taskId?.value
      && left.scope.cycleId?.value === right.scope.cycleId?.value
      && left.scope.operationId?.value === right.scope.operationId?.value
      && left.reason === right.reason
      && JSON.stringify(left.evidenceRefs) === JSON.stringify(right.evidenceRefs)
      && JSON.stringify(left.next) === JSON.stringify(right.next);
  }
  return false;
}

function checkpointScope(records: readonly JournalRecord[], checkpointId: Checkpoint['id']): ScopeRef | null {
  const record = [...records].reverse().find((candidate) =>
    candidate.kind === 'checkpoint'
    && candidate.checkpoint?.id.scope === checkpointId.scope
    && candidate.checkpoint.id.value === checkpointId.value);
  return record?.checkpoint?.scope ?? null;
}

export function createJsonlCheckpointClosurePort(input: {
  readonly filePath: string;
}): CheckpointClosurePort {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'checkpoint-closure-invalid',
      'checkpoint closure journal path is required',
      'provide the runtime checkpoint journal path',
      'app-checkpoint-journal',
    );
  }
  const journal = new JsonlOrganJournal(input.filePath);

  async function records(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new AppLifecycleError(
        'checkpoint-journal-corrupt',
        verification.error ?? 'checkpoint journal is invalid',
        'preserve the checkpoint journal and repair its committed history before reading closures',
        'app-checkpoint-journal',
      );
    }
    return verification.records;
  }

  return {
    async commit(closure: ClosureRecord): Promise<{ readonly closureId: string; readonly committed: true }> {
      const identity = identityOfClosure(closure);
      const existing = await this.read(identity);
      if (existing) {
        if (!closureMatches(existing, closure)) {
          throw new AppLifecycleError(
            'checkpoint-closure-conflict',
            `checkpoint closure id is already committed with different content: ${identity}`,
            'reconcile the existing closure before retrying',
            'app-checkpoint-journal',
          );
        }
        return { closureId: identity, committed: true };
      }
      const allRecords = await records();
      const scope = 'scope' in closure
        ? closure.scope
        : checkpointScope(allRecords, closure.checkpointId);
      if (!scope) {
        throw new AppLifecycleError(
          'checkpoint-closure-scope-missing',
          `closure ${identity} does not carry a journal scope`,
          'commit the referenced checkpoint before committing its closure',
          'app-checkpoint-journal',
        );
      }
      await journal.append({
        commitId: closureJournalCommitId(identity),
        kind: 'event',
        scope,
        payload: { kind: CHECKPOINT_CLOSURE_PAYLOAD_KIND, closure },
      });
      return { closureId: identity, committed: true };
    },
    async read(closureId: string): Promise<ClosureRecord | null> {
      const allRecords = await records();
      for (const record of [...allRecords].reverse()) {
        const closure = closureFromRecord(record);
        if (closure && identityOfClosure(closure) === closureId) return structuredClone(closure);
      }
      return null;
    },
  };
}

export function createCheckpointReentryAdmissionPort(input: {
  readonly admitRecovery?: (request: {
    readonly checkpoint: Checkpoint;
    readonly previousExecutionEpoch: number;
    readonly newExecutionEpoch: number;
  }) => Promise<boolean> | boolean;
} = {}): CheckpointReentryAdmissionPort {
  return {
    async admit(request) {
      if (!request.closure.reentry.allowed && input.admitRecovery === undefined) {
        return {
          allowed: false,
          reason: request.closure.reentry.reason,
          ...(request.closure.reentry.blockedBy ? { blockedBy: request.closure.reentry.blockedBy } : {}),
        };
      }
      if (input.admitRecovery !== undefined) {
        const allowed = await input.admitRecovery({
          checkpoint: request.checkpoint,
          previousExecutionEpoch: request.previousExecutionEpoch,
          newExecutionEpoch: request.newExecutionEpoch,
        });
        if (!allowed) {
          return {
            allowed: false,
            reason: 'recovery admission denied',
            blockedBy: ['recovery-admission'],
          };
        }
      }
      return { allowed: true, reason: 'recovery admission approved' };
    },
  };
}

const SEMANTIC_HISTORY_CONTEXT_VIEW_KIND = 'native-semantic-context-view';
const SEMANTIC_HISTORY_PUBLICATION_KIND = 'native-semantic-history-publication';

interface ParsedJournalReceipt {
  readonly scopeDigest: string;
  readonly seq: number;
  readonly digestHex: string;
}

function parseJournalReceipt(receiptRef: string): ParsedJournalReceipt {
  const match = /^humanagent:\/\/journal-record\/v1\/([0-9a-f]{64})\/(\d+)\/([0-9a-f]{64})$/.exec(receiptRef);
  const seq = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(seq) || seq < 1) {
    throw new AppLifecycleError(
      'semantic-history-receipt-invalid',
      `semantic history receipt is not an actual journal receipt: ${receiptRef}`,
      'use the receipt returned by the durable commit',
      'app-checkpoint-journal',
    );
  }
  return { scopeDigest: match[1]!, seq, digestHex: match[3]! };
}

function assertSemanticRecordDigest(value: string): SemanticHistoryDigestV1 {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new AppLifecycleError(
      'semantic-history-record-digest-invalid',
      `semantic history journal record digest is invalid: ${value}`,
      'preserve the committed journal and repair its integrity before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  return value as SemanticHistoryDigestV1;
}

function exactJournalRecord(
  records: readonly JournalRecord[],
  seq: number,
  digestHex: string,
): JournalRecord | undefined {
  return records.find((record) => record.seq === seq && record.recordDigest === `sha256:${digestHex}`);
}

function sameSemanticPhaseReceipt(left: SemanticPhaseReceiptV1, right: SemanticPhaseReceiptV1): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function decodeSemanticAssetBody(bytes: Uint8Array): FourPartSemanticViewV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (error) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      `semantic asset is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
      'preserve the committed semantic asset and repair its bytes before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      'semantic asset body must be an object',
      'repair the committed semantic asset before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  const body = parsed as Record<string, unknown>;
  if (body['version'] !== 1) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      'semantic asset version must be 1',
      'repair the committed semantic asset before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  const semantics = body['semantics'];
  if (typeof semantics !== 'object' || semantics === null || Array.isArray(semantics)) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      'semantic asset semantics must be an object',
      'repair the committed semantic asset before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  const four = semantics as Record<string, unknown>;
  const fields = ['goal', 'actions', 'result', 'nextStep'] as const;
  if (Object.keys(four).length !== fields.length || fields.some((field) => !Object.hasOwn(four, field))) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      'semantic asset must carry exactly goal, actions, result and nextStep',
      'repair the committed semantic asset before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  for (const field of fields) {
    const value = four[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new AppLifecycleError(
        'semantic-history-asset-invalid',
        `semantic asset ${field} must be a non-empty string`,
        'repair the committed semantic asset before reading semantic history',
        'app-checkpoint-journal',
      );
    }
  }
  return {
    goal: four['goal'] as string,
    actions: four['actions'] as string,
    result: four['result'] as string,
    nextStep: four['nextStep'] as string,
  };
}

/**
 * App persistence owner for the two semantic-history phases. It binds the
 * authoritative Organ Journal, the immutable semantic asset store, the native
 * checkpoint-v2 reader and the declared parent active-turn replay source. It
 * reconstructs every phase receipt from the actual committed record and never
 * derives publication from the latest checkpoint or from an asset that exists
 * without a durable adoption.
 */
export function createJsonlSemanticHistoryJournal(input: {
  readonly filePath: string;
  readonly artifactsRoot: string;
  readonly activeTurnJournal: ActiveTurnJournalPort;
  readonly rawContent: RawContentReadPort;
  readonly timeAuthority: CheckpointTimeAuthority;
}): SemanticHistoryPersistencePort {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'semantic-history-journal-invalid',
      'semantic history journal path is required',
      'provide the runtime checkpoint journal path',
      'app-checkpoint-journal',
    );
  }
  if (!input.artifactsRoot.trim()) {
    throw new AppLifecycleError(
      'semantic-history-assets-invalid',
      'semantic history asset root is required',
      'provide the canonical immutable asset root',
      'app-checkpoint-journal',
    );
  }
  const journal = new JsonlOrganJournal(input.filePath);
  const assets = new ImmutableAssetStore(input.artifactsRoot);
  const checkpoints = createJsonlCheckpointJournal({ filePath: input.filePath });
  const timeAuthority: CheckpointTimeAuthorityMetadata = {
    source: input.timeAuthority.source,
    owner: input.timeAuthority.owner,
    authorityRef: input.timeAuthority.authorityRef,
  };

  async function verifiedRecords(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new AppLifecycleError(
        'semantic-history-journal-corrupt',
        verification.error ?? 'semantic history journal is invalid',
        'preserve the checkpoint journal and repair its committed history before publishing or reading semantic history',
        'app-checkpoint-journal',
      );
    }
    return verification.records;
  }

  function identityCollision(commitId: string, record: JournalRecord): never {
    throw new AppLifecycleError(
      'semantic-history-identity-collision',
      `semantic history identity ${commitId} is occupied by a non-matching journal record at seq ${record.seq}`,
      'preserve the committed record and use the original intent or a new checkpoint identity',
      'app-checkpoint-journal',
    );
  }

  async function phaseReceipt(receiptInput: {
    readonly record: JournalRecord;
    readonly phase: SemanticPhase;
    readonly identity: string;
    readonly committedAt: CanonicalUtcInstant;
    readonly authority: CheckpointTimeAuthorityMetadata;
    readonly scope: ScopeRef;
  }): Promise<SemanticPhaseReceiptV1> {
    const recordDigest = assertSemanticRecordDigest(receiptInput.record.recordDigest);
    const scopeHash = await scopeDigest(receiptInput.scope);
    return {
      phase: receiptInput.phase,
      commitIdentity: receiptInput.identity,
      journalReceiptRef: `humanagent://journal-record/v1/${scopeHash}/${receiptInput.record.seq}/${recordDigest.slice('sha256:'.length)}`,
      journalSeq: receiptInput.record.seq,
      recordDigest,
      committedAt: receiptInput.committedAt,
      timeAuthority: {
        source: receiptInput.authority.source,
        owner: receiptInput.authority.owner,
        authorityRef: receiptInput.authority.authorityRef,
      },
    };
  }

  async function contextViewBody(record: JournalRecord): Promise<SemanticContextViewBodyV1> {
    if (record.kind !== 'event' || record.payload?.['kind'] !== SEMANTIC_HISTORY_CONTEXT_VIEW_KIND) {
      throw new AppLifecycleError(
        'semantic-history-record-kind-mismatch',
        `journal record ${record.seq} is not a native semantic context-view event`,
        'preserve the committed journal and resolve the identity collision before reading semantic history',
        'app-checkpoint-journal',
      );
    }
    await validateSemanticContextViewBodyV1(record.payload);
    const body = record.payload as unknown as SemanticContextViewBodyV1;
    if (record.commitId !== body.identity) {
      throw new AppLifecycleError(
        'semantic-history-record-identity-mismatch',
        `context-view record ${record.seq} commit identity does not match its body identity`,
        'preserve the committed journal and repair the context-view record before reading semantic history',
        'app-checkpoint-journal',
      );
    }
    return body;
  }

  async function publicationBody(record: JournalRecord): Promise<SemanticHistoryPublicationBodyV1> {
    if (record.kind !== 'event' || record.payload?.['kind'] !== SEMANTIC_HISTORY_PUBLICATION_KIND) {
      throw new AppLifecycleError(
        'semantic-history-record-kind-mismatch',
        `journal record ${record.seq} is not a native semantic history-publication event`,
        'preserve the committed journal and resolve the identity collision before reading semantic history',
        'app-checkpoint-journal',
      );
    }
    await validateSemanticHistoryPublicationBodyV1(record.payload);
    const body = record.payload as unknown as SemanticHistoryPublicationBodyV1;
    if (record.commitId !== body.identity) {
      throw new AppLifecycleError(
        'semantic-history-record-identity-mismatch',
        `history-publication record ${record.seq} commit identity does not match its body identity`,
        'preserve the committed journal and repair the publication record before reading semantic history',
        'app-checkpoint-journal',
      );
    }
    return body;
  }

  return {
    async commitContextView(request: SemanticContextViewCommitRequest): Promise<SemanticPhaseReceiptV1> {
      if (!request.ownerId.trim()) {
        throw new AppLifecycleError(
          'semantic-history-owner-missing',
          'semantic context-view commit requires an owner',
          'provide the runtime semantic-history owner',
          'app-checkpoint-journal',
        );
      }
      const accepted = request.accepted;
      const turn = projectAdmittedTurnIdentityV1(accepted.admittedTurn);
      const scope = accepted.checkpoint.checkpoint.scope;
      const identity = await contextViewIdentityV1({ turn, checkpoint: accepted.checkpoint.checkpoint });

      const bytes = encodeSemanticAssetBodyV1(accepted.semantics);
      const digest = await semanticAssetDigestV1(accepted.semantics);
      const reference = await assets.write(semanticAssetIdV1(digest), bytes);
      if (reference.digest !== digest || reference.size !== bytes.length) {
        throw new AppLifecycleError(
          'semantic-history-asset-mismatch',
          'immutable semantic asset does not match its projected bytes',
          'repair the immutable asset store before publishing semantic history',
          'app-checkpoint-journal',
        );
      }
      const descriptor: SemanticAssetDescriptorV1 = {
        assetId: reference.assetId,
        digest: reference.digest as SemanticHistoryDigestV1,
        locator: reference.locator,
        size: reference.size,
      };
      const expectedIntent = await contextViewIntentDigestV1({
        turn,
        checkpoint: accepted.checkpoint,
        acceptance: accepted.acceptance,
        semanticAsset: descriptor,
        adoptedChildren: accepted.adoptedChildren,
        evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
        recovery: accepted.recovery,
      });

      return await journal.transaction<{ readonly existing?: JournalRecord }, SemanticPhaseReceiptV1>(
        ({ records }) => ({ existing: records.find((record) => record.commitId === identity) }),
        async ({ existing }, append) => {
          if (existing) {
            const persisted = await contextViewBody(existing);
            if (persisted.identity !== identity) identityCollision(identity, existing);
            if (persisted.intentDigest !== expectedIntent) {
              throw new AppLifecycleError(
                'semantic-history-intent-conflict',
                `context-view identity is already committed with a different intent: ${identity}`,
                'preserve the committed view and use the original intent or a new checkpoint identity',
                'app-checkpoint-journal',
              );
            }
            return await phaseReceipt({
              record: existing,
              phase: 'context-view',
              identity,
              committedAt: persisted.committedAt,
              authority: persisted.timeAuthority,
              scope,
            });
          }
          const committedAt = await input.timeAuthority.sampleCommittedAt();
          const body = await buildSemanticContextViewBodyV1({
            accepted,
            semanticAsset: descriptor,
            committedAt,
            timeAuthority,
          });
          const appended = await append({ commitId: identity, kind: 'event', scope, payload: body as unknown as Record<string, unknown> });
          return await phaseReceipt({
            record: appended,
            phase: 'context-view',
            identity,
            committedAt: body.committedAt,
            authority: body.timeAuthority,
            scope,
          });
        },
      );
    },

    async commitHistoryPublication(request: SemanticHistoryPublicationCommitRequest): Promise<SemanticPhaseReceiptV1> {
      if (!request.ownerId.trim()) {
        throw new AppLifecycleError(
          'semantic-history-owner-missing',
          'semantic history-publication commit requires an owner',
          'provide the runtime semantic-history owner',
          'app-checkpoint-journal',
        );
      }
      const scope = request.checkpoint.checkpoint.scope;
      const identity = await historyPublicationIdentityV1({
        turn: request.turn,
        checkpoint: request.checkpoint.checkpoint,
      });
      const expectedIntent = await historyPublicationIntentDigestV1({
        turn: request.turn,
        checkpoint: request.checkpoint,
        contextView: request.contextView,
      });
      const viewReceipt = parseJournalReceipt(request.contextView.receipt.journalReceiptRef);
      const scopeHash = await scopeDigest(scope);
      if (viewReceipt.scopeDigest !== scopeHash) {
        throw new AppLifecycleError(
          'semantic-history-phase-scope-mismatch',
          'context-view receipt scope does not match the publication checkpoint scope',
          'read the actual context-view receipt for this checkpoint before publishing',
          'app-checkpoint-journal',
        );
      }

      return await journal.transaction<
        { readonly existing?: JournalRecord; readonly view?: JournalRecord },
        SemanticPhaseReceiptV1
      >(
        ({ records }) => ({
          existing: records.find((record) => record.commitId === identity),
          view: exactJournalRecord(records, viewReceipt.seq, viewReceipt.digestHex),
        }),
        async ({ existing, view }, append) => {
          if (!view) {
            throw new AppLifecycleError(
              'semantic-history-context-view-missing',
              `context-view receipt is not committed: ${request.contextView.receipt.journalReceiptRef}`,
              'commit the exact context view before publishing semantic history',
              'app-checkpoint-journal',
            );
          }
          if (!sameScope(view.scope, scope)) {
            throw new AppLifecycleError(
              'semantic-history-phase-scope-mismatch',
              'context-view record scope does not match the publication checkpoint scope',
              'read the actual context-view receipt for this checkpoint before publishing',
              'app-checkpoint-journal',
            );
          }
          const viewBody = await contextViewBody(view);
          if (viewBody.identity !== request.contextView.identity) {
            throw new AppLifecycleError(
              'semantic-history-phase-identity-mismatch',
              'context-view receipt does not carry the referenced view identity',
              'read the actual context-view receipt before publishing',
              'app-checkpoint-journal',
            );
          }
          const actualViewReceipt = await phaseReceipt({
            record: view,
            phase: 'context-view',
            identity: viewBody.identity,
            committedAt: viewBody.committedAt,
            authority: viewBody.timeAuthority,
            scope: viewBody.checkpoint.checkpoint.scope,
          });
          if (!sameSemanticPhaseReceipt(actualViewReceipt, request.contextView.receipt)) {
            throw new AppLifecycleError(
              'semantic-history-phase-receipt-mismatch',
              'context-view receipt does not match the committed context-view record',
              'read the actual context-view receipt before publishing',
              'app-checkpoint-journal',
            );
          }
          if (existing) {
            const persisted = await publicationBody(existing);
            if (persisted.identity !== identity) identityCollision(identity, existing);
            if (persisted.intentDigest !== expectedIntent) {
              throw new AppLifecycleError(
                'semantic-history-intent-conflict',
                `history-publication identity is already committed with a different intent: ${identity}`,
                'preserve the committed publication and use the original intent or a new checkpoint identity',
                'app-checkpoint-journal',
              );
            }
            return await phaseReceipt({
              record: existing,
              phase: 'history-publication',
              identity,
              committedAt: persisted.committedAt,
              authority: persisted.timeAuthority,
              scope,
            });
          }
          const committedAt = await input.timeAuthority.sampleCommittedAt();
          const body = await buildSemanticHistoryPublicationBodyV1({
            turn: request.turn,
            checkpoint: request.checkpoint,
            contextView: request.contextView,
            committedAt,
            timeAuthority,
          });
          const appended = await append({ commitId: identity, kind: 'event', scope, payload: body as unknown as Record<string, unknown> });
          return await phaseReceipt({
            record: appended,
            phase: 'history-publication',
            identity,
            committedAt: body.committedAt,
            authority: body.timeAuthority,
            scope,
          });
        },
      );
    },

    async readContextView(request: {
      readonly scope: ScopeRef;
      readonly contextViewReceiptRef: string;
    }): Promise<SemanticContextViewBodyV1 | null> {
      const parsed = parseJournalReceipt(request.contextViewReceiptRef);
      if (parsed.scopeDigest !== await scopeDigest(request.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'context-view receipt scope does not match the requested scope',
          'request the exact context view by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      const records = await verifiedRecords();
      const record = exactJournalRecord(records, parsed.seq, parsed.digestHex);
      if (!record) return null;
      if (!sameScope(record.scope, request.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'context-view record scope does not match the requested scope',
          'request the exact context view by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      return await contextViewBody(record);
    },

    async readCommittedSemanticCheckpoint(
      lookup: SemanticHistoryExactLookupV1,
    ): Promise<CommittedSemanticCheckpointV1 | null> {
      validateSemanticHistoryExactLookupV1(lookup);
      const records = await verifiedRecords();
      const parsed = parseJournalReceipt(lookup.publicationReceiptRef);
      if (parsed.scopeDigest !== await scopeDigest(lookup.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'publication receipt scope does not match the requested scope',
          'request the exact publication by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      const publicationRecord = exactJournalRecord(records, parsed.seq, parsed.digestHex);
      if (!publicationRecord) return null;
      if (!sameScope(publicationRecord.scope, lookup.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'publication record scope does not match the requested scope',
          'request the exact publication by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      const publication = await publicationBody(publicationRecord);
      const expectedPublicationIdentity = await historyPublicationIdentityV1({
        turn: publication.turn,
        checkpoint: publication.checkpoint.checkpoint,
      });
      if (publication.identity !== expectedPublicationIdentity) {
        throw new AppLifecycleError(
          'semantic-history-body-identity-mismatch',
          'publication identity does not match its turn and checkpoint',
          'preserve the committed journal and repair the publication record before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      if (publication.checkpoint.checkpoint.id.scope !== lookup.checkpoint.id.scope
        || publication.checkpoint.checkpoint.id.value !== lookup.checkpoint.id.value
        || !sameScope(publication.checkpoint.checkpoint.scope, lookup.checkpoint.scope)) {
        throw new AppLifecycleError(
          'semantic-history-lookup-checkpoint-mismatch',
          'publication does not reference the requested checkpoint',
          'request the exact publication for this checkpoint',
          'app-checkpoint-journal',
        );
      }

      const viewParsed = parseJournalReceipt(publication.contextView.receipt.journalReceiptRef);
      const viewRecord = exactJournalRecord(records, viewParsed.seq, viewParsed.digestHex);
      if (!viewRecord) {
        throw new AppLifecycleError(
          'semantic-history-context-view-missing',
          `publication references an uncommitted context view: ${publication.contextView.receipt.journalReceiptRef}`,
          'preserve the committed journal and repair the missing context-view record before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      if (!sameScope(viewRecord.scope, lookup.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'context-view record scope does not match the requested scope',
          'request the exact publication by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      const view = await contextViewBody(viewRecord);
      if (view.identity !== publication.contextView.identity) {
        throw new AppLifecycleError(
          'semantic-history-phase-identity-mismatch',
          'publication context-view identity does not match the committed context view',
          'preserve the committed journal and repair the publication record before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      const actualViewReceipt = await phaseReceipt({
        record: viewRecord,
        phase: 'context-view',
        identity: view.identity,
        committedAt: view.committedAt,
        authority: view.timeAuthority,
        scope: view.checkpoint.checkpoint.scope,
      });
      if (!sameSemanticPhaseReceipt(actualViewReceipt, publication.contextView.receipt)) {
        throw new AppLifecycleError(
          'semantic-history-phase-receipt-mismatch',
          'publication context-view receipt does not match the committed context view',
          'preserve the committed journal and repair the publication record before reading semantic history',
          'app-checkpoint-journal',
        );
      }

      const checkpointRelationship = await checkpoints.readNativeCheckpoint({
        checkpoint: view.checkpoint.checkpoint,
      });
      if (!checkpointRelationship) {
        throw new AppLifecycleError(
          'semantic-history-checkpoint-missing',
          `semantic view references an uncommitted native checkpoint: ${view.checkpoint.checkpoint.id.value}`,
          'preserve the committed journal and repair the checkpoint record before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      if (canonicalJsonStringify(checkpointRelationship) !== canonicalJsonStringify(view.checkpoint)) {
        throw new AppLifecycleError(
          'semantic-history-checkpoint-mismatch',
          'semantic view checkpoint binding does not match the committed native checkpoint',
          'preserve the committed journal and repair the checkpoint binding before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      if (canonicalJsonStringify(publication.checkpoint) !== canonicalJsonStringify(checkpointRelationship)
        || canonicalJsonStringify(publication.turn) !== canonicalJsonStringify(view.turn)) {
        throw new AppLifecycleError(
          'semantic-history-publication-binding-mismatch',
          'publication does not bind the committed context view turn and checkpoint',
          'preserve the committed journal and repair the publication record before reading semantic history',
          'app-checkpoint-journal',
        );
      }

      const semantics = decodeSemanticAssetBody(await assets.read(view.semanticAsset));
      const adoptedChildren: AdoptedChildSourceV1[] = [];
      const activeTurnRecords = await input.activeTurnJournal.replay();
      for (const source of view.adoptedChildren) {
        const materialized = await materializeAdoptedChildSource({
          source,
          records: activeTurnRecords,
          rawContent: input.rawContent,
        });
        const expectedDigest = materialized.source.refinedDelivery.ref.digest;
        if (expectedDigest !== undefined) {
          const actualDigest = `sha256:${createHash('sha256').update(materialized.bytes).digest('hex')}`;
          if (actualDigest !== expectedDigest) {
            throw new AppLifecycleError(
              'semantic-history-adoption-asset-mismatch',
              `adopted refinement bytes do not match their descriptor: ${materialized.source.invocationId}`,
              'repair the refined delivery asset before reading semantic history',
              'app-checkpoint-journal',
            );
          }
        }
        adoptedChildren.push(materialized.source);
      }

      return await projectCommittedSemanticCheckpointV1({
        turn: view.turn,
        checkpoint: checkpointRelationship,
        contextView: actualViewReceipt,
        historyPublication: await phaseReceipt({
          record: publicationRecord,
          phase: 'history-publication',
          identity: publication.identity,
          committedAt: publication.committedAt,
          authority: publication.timeAuthority,
          scope: lookup.scope,
        }),
        semantics,
        evidenceRefs: view.evidenceRefs,
        adoptedChildren,
        recovery: view.recovery,
      });
    },
  };
}
