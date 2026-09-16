import type { CheckpointClosureRecord, CheckpointReentryRecord } from '../../contracts/src/index.js';
import { validateCheckpointClosureRecord, validateCheckpointReentryRecord } from '../../contracts/src/index.js';
import { CheckpointError } from './errors.js';

export function assertCheckpointClosureCommitted(input: CheckpointClosureRecord): void {
  validateCheckpointClosureRecord(input);
  if (!input.committed) throw new CheckpointError('checkpoint closure is not committed');
}

export function assertCheckpointClosureCanReenter(closure: CheckpointClosureRecord, reentry: CheckpointReentryRecord): void {
  validateCheckpointClosureRecord(closure);
  validateCheckpointReentryRecord(reentry);
  if (!closure.committed) throw new CheckpointError('cannot reenter uncommitted closure');
  if (!closure.reentryAllowed) throw new CheckpointError('checkpoint closure does not allow reentry');
  if (closure.unknownOperations.length > 0) throw new CheckpointError('unknown operations block checkpoint reentry');
  if (closure.checkpointId.scope !== reentry.checkpointId.scope || closure.checkpointId.value !== reentry.checkpointId.value) {
    throw new CheckpointError('checkpoint reentry target mismatch');
  }
  if (!reentry.fencedEpochs.includes(closure.executionEpoch)) {
    throw new CheckpointError('checkpoint reentry must fence the source epoch');
  }
}
