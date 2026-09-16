import { JsonlOrganJournal, type JournalRecord } from '../../adapters/jsonl/src/index.js';
import type {
  Checkpoint,
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
    const latest = checkpoints.at(-1)?.checkpoint;
    if (!latest) return null;
    const previous = checkpoints.at(-2)?.checkpoint ?? null;
    return { checkpoint: latest, previous };
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
      };
    },
  };
}
