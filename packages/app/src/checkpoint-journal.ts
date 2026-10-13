import { createHash } from 'node:crypto';
import { JsonlOrganJournal, type JournalRecord } from '../../adapters/jsonl/src/index.js';
import type {
  CheckpointCommitIdentityV2,
  CheckpointCommitEnvelopeV1,
  CheckpointReceiptRelationshipV1,
  CheckpointTimeAuthorityMetadata,
  Checkpoint,
  EvidenceRef,
  ScopeRef,
} from '../../contracts/src/index.js';
import {
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
} from '../../runtime/src/checkpoints/ports.js';
import {
  assertDeadEndRecord,
  assertInteractionClosure,
  assertReentryRecord,
  sameCheckpointClosureRecord,
  sameReentryRecord,
  type ClosureRecord,
} from '../../runtime/src/checkpoints/closure.js';
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
