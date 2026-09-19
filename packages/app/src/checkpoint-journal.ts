import { createHash } from 'node:crypto';
import { JsonlOrganJournal, type JournalRecord } from '../../adapters/jsonl/src/index.js';
import type {
  Checkpoint,
  EvidenceRef,
  ScopeRef,
} from '../../contracts/src/index.js';
import type {
  CheckpointAppendRequest,
  CheckpointAppendReceipt,
  CheckpointChainVerification,
  CheckpointJournalPort,
  LatestCheckpointRecord,
} from '../../runtime/src/checkpoints/ports.js';
import { AppLifecycleError } from './errors.js';

const CHECKPOINT_EVIDENCE_PREFIX = 'humanagent://checkpoint/';

export function checkpointEvidenceText(checkpoint: Checkpoint): string {
  return JSON.stringify(checkpoint);
}

export function checkpointEvidenceDigest(checkpoint: Checkpoint): string {
  return `sha256:${createHash('sha256').update(checkpointEvidenceText(checkpoint)).digest('hex')}`;
}

export function checkpointEvidenceLocator(checkpoint: Pick<Checkpoint, 'id'>): string {
  return `${CHECKPOINT_EVIDENCE_PREFIX}${checkpoint.id.value}`;
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
    && sameScope(candidate.checkpoint.scope, input.scope)
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
}): CheckpointJournalPort {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'checkpoint-journal-invalid',
      'checkpoint journal path is required',
      'provide the runtime checkpoint journal path',
      'app-checkpoint-journal',
    );
  }
  const journal = new JsonlOrganJournal(input.filePath);

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
      const verification = await journal.verify();
      if (!verification.valid) {
        return {
          valid: false,
          reason: verification.error ?? 'journal verification failed',
        };
      }
      const records = verification.records.filter((record) =>
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
      const verification = await journal.verify();
      if (!verification.valid) {
        throw new AppLifecycleError(
          'checkpoint-journal-corrupt',
          verification.error ?? 'checkpoint journal is invalid',
          'preserve the journal and repair its committed tail before recovery',
          'app-checkpoint-journal',
        );
      }
      return latestCheckpoint(verification.records, scope);
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
  };
}
