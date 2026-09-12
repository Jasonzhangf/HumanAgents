import type { Checkpoint, EvidenceRef, NextAction } from '../../../contracts/src/index.js';
import { CheckpointCoordinatorError } from './errors.js';

export interface CheckpointWindowLimits {
  readonly workingEntries: number;
  readonly reportingEvidenceEntries: number;
}

export const DEFAULT_CHECKPOINT_WINDOW_LIMITS: CheckpointWindowLimits = {
  workingEntries: 32,
  reportingEvidenceEntries: 16,
};

export interface WorkingWindow {
  readonly recoveryStateRef: EvidenceRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly truncated: boolean;
  readonly limits: CheckpointWindowLimits;
}

export interface ReportingWindow {
  readonly summary: string;
  readonly next: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly truncated: boolean;
  readonly limits: CheckpointWindowLimits;
}

export interface CheckpointWindows {
  readonly working: WorkingWindow;
  readonly reporting: ReportingWindow;
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CheckpointCoordinatorError(`${label} must be a positive safe integer`);
  }
}

export function assembleCheckpointWindows(
  checkpoint: Checkpoint,
  overrides: Partial<CheckpointWindowLimits> = {},
): CheckpointWindows {
  const limits: CheckpointWindowLimits = {
    workingEntries: overrides.workingEntries ?? DEFAULT_CHECKPOINT_WINDOW_LIMITS.workingEntries,
    reportingEvidenceEntries:
      overrides.reportingEvidenceEntries ?? DEFAULT_CHECKPOINT_WINDOW_LIMITS.reportingEvidenceEntries,
  };
  assertPositiveLimit(limits.workingEntries, 'working window limit');
  assertPositiveLimit(limits.reportingEvidenceEntries, 'reporting window limit');

  const workingEvidenceEntries = limits.workingEntries - 1;
  const workingEvidenceRefs = checkpoint.evidenceRefs.slice(0, workingEvidenceEntries);
  const reportingEvidenceRefs = checkpoint.evidenceRefs.slice(0, limits.reportingEvidenceEntries);

  return {
    working: {
      recoveryStateRef: checkpoint.recoveryStateRef,
      evidenceRefs: workingEvidenceRefs,
      truncated: workingEvidenceRefs.length !== checkpoint.evidenceRefs.length,
      limits,
    },
    reporting: {
      summary: checkpoint.summary,
      next: checkpoint.next,
      evidenceRefs: reportingEvidenceRefs,
      truncated: reportingEvidenceRefs.length !== checkpoint.evidenceRefs.length,
      limits,
    },
  };
}
