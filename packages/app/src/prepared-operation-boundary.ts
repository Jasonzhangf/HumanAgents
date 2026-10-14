import type { OperationTaskBoundaryPort } from '../../runtime/src/gateway/ports.js';
import type { RuntimeTaskJournalPort } from '../../runtime/src/ui-runtime/coordinator.js';

export function createPreparedOperationBoundary(journal: RuntimeTaskJournalPort): OperationTaskBoundaryPort {
  return {
    async readBoundary({ intent }) {
      // Resource identity is the durable R1 allocation, never Provider arguments.
      // A child tool intent names its own operation, so resolve the actual typed
      // parent execution through the retained prepared allocation sharing the
      // intent's organ/task/cycle namespace. The parent keeps its exact operation
      // scope; a child effect receives the minimal task-cycle boundary that covers
      // the parent and its child operations without dropping the child scope.
      const records = journal.replay();
      const exact = records.find((record) => record.kind === 'operation.prepared'
        && record.allocation.operationId.value === intent.operationId.value);
      if (exact && exact.kind === 'operation.prepared') return { scope: exact.allocation.scope, evidenceRefs: [] };
      const parent = records.find((record) => record.kind === 'operation.prepared'
        && record.allocation.scope.organId.value === intent.requestedScope.organId.value
        && record.allocation.scope.taskId?.value === intent.requestedScope.taskId?.value
        && record.allocation.scope.cycleId?.value === intent.requestedScope.cycleId?.value);
      if (!parent || parent.kind !== 'operation.prepared') return null;
      const scope = parent.allocation.scope;
      return { scope: { organId: scope.organId, taskId: scope.taskId, cycleId: scope.cycleId }, evidenceRefs: [] };
    },
  };
}
