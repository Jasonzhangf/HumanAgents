import type {
  Checkpoint,
  NextAction,
  OperationId,
  ScopeRef,
} from '../../../contracts/src/index.js';
import { recallCheckpoint, type RecalledCheckpoint } from '../checkpoints/coordinator.js';
import {
  commitDeadEnd,
  commitReentry,
  submitCheckpoint,
  type CommittedDeadEnd,
  type CommittedReentry,
  type SubmitCheckpointInput,
  type SubmittedCheckpoint,
} from '../checkpoints/submission.js';
import type {
  CheckpointClosurePort,
  CheckpointJournalPort,
} from '../checkpoints/ports.js';
import type { CheckpointWindowLimits } from '../checkpoints/windows.js';
import type {
  CheckpointReentryDecision,
  CheckpointSubmissionSource,
  DeadEndRecord,
  OperationReconcileResult,
} from '../checkpoints/closure.js';

export interface BuiltInCheckpointToolContext {
  readonly ownerId: string;
  readonly source: CheckpointSubmissionSource;
  readonly journal: CheckpointJournalPort;
  readonly closurePort: CheckpointClosurePort;
}

export interface InspectCheckpointToolInput {
  readonly scope: ScopeRef;
  readonly windowLimits?: Partial<CheckpointWindowLimits>;
}

export interface InspectCheckpointToolResult {
  readonly candidates: readonly RecalledCheckpoint[];
  readonly currentCheckpointRef?: string;
}

export async function inspectCheckpointTool(
  context: BuiltInCheckpointToolContext,
  input: InspectCheckpointToolInput,
): Promise<InspectCheckpointToolResult> {
  const recalled = await recallCheckpoint(context.journal, {
    ownerId: context.ownerId,
    scope: input.scope,
    windowLimits: input.windowLimits,
  });
  if (!recalled) return { candidates: [] };
  return {
    candidates: [recalled],
    currentCheckpointRef: recalled.checkpoint.id.value,
  };
}

export interface RecallCheckpointToolInput {
  readonly scope: ScopeRef;
  readonly windowLimits?: Partial<CheckpointWindowLimits>;
}

export async function recallCheckpointTool(
  context: BuiltInCheckpointToolContext,
  input: RecallCheckpointToolInput,
): Promise<RecalledCheckpoint | null> {
  return recallCheckpoint(context.journal, {
    ownerId: context.ownerId,
    scope: input.scope,
    windowLimits: input.windowLimits,
  });
}

export interface SaveCheckpointToolInput {
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
  readonly permissionRevoked?: boolean;
  readonly hardBlockers?: readonly string[];
  readonly unknownOperations?: readonly OperationId[];
  readonly reconciledOperations?: readonly OperationReconcileResult[];
  readonly reentry?: CheckpointReentryDecision;
}

export interface SaveCheckpointToolResult {
  readonly checkpointRef: string;
  readonly outcome: 'committed' | 'waiting' | 'blocked' | 'rejected';
  readonly reentry: CheckpointReentryDecision;
  readonly unresolvedOperations: readonly OperationId[];
}

export async function saveCheckpointTool(
  context: BuiltInCheckpointToolContext,
  input: SaveCheckpointToolInput,
): Promise<SaveCheckpointToolResult> {
  const submitted = await submitCheckpoint({
    source: context.source,
    ownerId: context.ownerId,
    checkpoint: input.checkpoint,
    previous: input.previous,
    journal: context.journal,
    closurePort: context.closurePort,
    permissionRevoked: input.permissionRevoked,
    hardBlockers: input.hardBlockers,
    unknownOperations: input.unknownOperations,
    reconciledOperations: input.reconciledOperations,
    reentry: input.reentry,
  });
  return {
    checkpointRef: submitted.checkpoint.id.value,
    outcome: submitted.checkpoint.outcome === 'waiting'
      ? 'waiting'
      : submitted.checkpoint.outcome === 'blocked'
        ? 'blocked'
        : submitted.checkpoint.outcome === 'succeeded'
          ? 'committed'
          : 'rejected',
    reentry: submitted.reentry,
    unresolvedOperations: submitted.unresolvedOperations,
  };
}

export interface RecordDeadEndToolInput {
  readonly record: DeadEndRecord;
}

export async function recordDeadEndTool(
  context: BuiltInCheckpointToolContext,
  input: RecordDeadEndToolInput,
): Promise<CommittedDeadEnd> {
  return commitDeadEnd({
    ownerId: context.ownerId,
    record: input.record,
    closurePort: context.closurePort,
  });
}

export interface ReenterCheckpointToolInput {
  readonly closureId: string;
  readonly checkpoint: Checkpoint;
  readonly previousExecutionEpoch: number;
  readonly newExecutionEpoch: number;
  readonly deadEndRef?: string;
  readonly nextAction: NextAction;
}

export async function reenterCheckpointTool(
  context: BuiltInCheckpointToolContext,
  input: ReenterCheckpointToolInput,
): Promise<CommittedReentry> {
  return commitReentry({
    ownerId: context.ownerId,
    closureId: input.closureId,
    checkpointId: input.checkpoint.id,
    checkpointExecutionEpoch: input.checkpoint.executionEpoch,
    previousExecutionEpoch: input.previousExecutionEpoch,
    newExecutionEpoch: input.newExecutionEpoch,
    deadEndRef: input.deadEndRef,
    nextAction: input.nextAction,
    closurePort: context.closurePort,
  });
}

export type { SubmitCheckpointInput };
export type { SubmittedCheckpoint };
export type { CommittedDeadEnd };
export type { CommittedReentry };
