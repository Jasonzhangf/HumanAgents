import { canonicalJsonStringify } from '../../contracts/src/index.js';
import type { RuntimeExecutionAllocation, RuntimeTaskJournalPort } from '../../runtime/src/ui-runtime/coordinator.js';
import { AppLifecycleError } from './errors.js';

/**
 * The caller resolves the immutable input retained by the allocation owner.
 * This module is the sole owner of the prepared-input shape; the execution
 * admission composition imports and re-exports it instead of declaring a
 * second copy. It carries only the immutable input identity, never a control
 * fact, grant, principal or display projection.
 */
export interface AdmittedExecutionInput {
  readonly inputRevision: number;
  readonly inputRefs: readonly string[];
  readonly input: Readonly<Record<string, unknown>>;
}

function missing(message: string): never {
  throw new AppLifecycleError('execution-composition.owner-source-missing', message,
    'supply the exact prepared execution owner record before release', 'humanagent.app.execution-composition');
}

/** Exact typed R1 preparation read. Events, task snapshots and display output are not inputs. */
export function readPreparedExecutionInput(journal: RuntimeTaskJournalPort, allocation: RuntimeExecutionAllocation): AdmittedExecutionInput {
  const records = journal.replay().filter((record) => record.kind === 'operation.prepared'
    && record.allocation.operationId.value === allocation.operationId.value);
  if (records.length !== 1) missing('the allocated execution requires one retained prepared input');
  const prepared = records[0];
  if (!prepared || prepared.kind !== 'operation.prepared'
    || canonicalJsonStringify(prepared.allocation) !== canonicalJsonStringify(allocation)) {
    missing('retained prepared allocation does not match the release identity');
  }
  return { inputRevision: allocation.inputRevision, inputRefs: allocation.inputRefs,
    input: Object.freeze({ prompt: prepared.input }) };
}
