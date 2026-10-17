import {
  assertEvidenceRef,
  id,
  validateAdmittedTurn,
  validateWorkAssignment,
  type AdmittedTurn,
  type EvidenceRef,
  type ScopeRef,
  type TaskIdentityRecord,
  type TaskId,
  type TurnPlanBinding,
  type WorkAssignment,
} from '../../../contracts/src/index.js';
import {
  readCurrentTaskPlan,
  type TaskPlanRevisionConsumerPort,
} from '../orchestration/task-plan-revisions.js';
import type { RuntimeTaskCurrentPlan } from '../ui-runtime/current-state.js';
import { AdmissionError } from './errors.js';

/**
 * The Runtime-owned permission/binding snapshot captured when a business turn
 * is opened. The Runtime must supply it from real assembled inputs. A missing
 * or incomplete snapshot must stop the active-turn open instead of fabricating
 * a permission revision or a runtime binding identity.
 */
export interface RuntimeBindingSnapshot {
  readonly runtimeId: string;
  readonly executionEpoch: number;
  readonly ownerRef: string;
  readonly permissionRevision: string;
}

export interface AdmittedTurnProducerInput {
  readonly runtime: RuntimeBindingSnapshot;
  readonly taskId: TaskId;
  readonly scope: ScopeRef;
  readonly assignment: WorkAssignment;
  readonly directiveRevision: number;
  readonly turnId: string;
  readonly currentTurnRef: string;
  readonly admissionEvidence: readonly EvidenceRef[];
  readonly recoveryStateRef: EvidenceRef;
}

export interface AcceptedTurnPlanProducerInput {
  readonly plans: Pick<TaskPlanRevisionConsumerPort, 'get' | 'getCommitRef'>;
  readonly identity: TaskIdentityRecord;
  readonly currentPlan: RuntimeTaskCurrentPlan;
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdmissionError(`${label} is required to open the active turn`);
  }
}

/**
 * Single Runtime producer for an `AdmittedTurn`. It derives every identity from
 * the real assignment, scope, directive revision, execution epoch and the
 * Runtime binding snapshot. The App never constructs an `AdmittedTurn`; it only
 * supplies the real admission evidence and the assembled binding inputs.
 */
export function produceAdmittedTurn(input: AdmittedTurnProducerInput): AdmittedTurn {
  const { runtime, assignment, scope } = input;
  assertNonEmpty(runtime.runtimeId, 'runtime identity');
  assertNonEmpty(runtime.ownerRef, 'runtime owner reference');
  assertNonEmpty(runtime.permissionRevision, 'runtime permission revision');
  if (!Number.isSafeInteger(runtime.executionEpoch) || runtime.executionEpoch < 1) {
    throw new AdmissionError('runtime execution epoch must be a positive safe integer to open the active turn');
  }
  if (assignment.executionEpoch !== runtime.executionEpoch) {
    throw new AdmissionError('assignment execution epoch does not match the runtime binding snapshot');
  }
  if (!scope.cycleId) {
    throw new AdmissionError('active turn scope must carry the cycle identity');
  }
  if (!scope.taskId || scope.taskId.value !== input.taskId.value) {
    throw new AdmissionError('active turn scope does not match the admitted task');
  }
  if (assignment.taskId.value !== input.taskId.value) {
    throw new AdmissionError('assignment task does not match the admitted task');
  }
  if (!Number.isSafeInteger(input.directiveRevision) || input.directiveRevision < 1) {
    throw new AdmissionError('directive revision must be a positive safe integer to open the active turn');
  }
  assertNonEmpty(input.turnId, 'active turn identity');
  assertNonEmpty(input.currentTurnRef, 'active turn reference');
  if (input.admissionEvidence.length === 0) {
    throw new AdmissionError('active turn admission evidence is required');
  }
  for (const evidence of input.admissionEvidence) assertEvidenceRef(evidence);
  assertEvidenceRef(input.recoveryStateRef);
  validateWorkAssignment(assignment);

  const admittedTurn: AdmittedTurn = {
    turnId: input.turnId,
    workAssignmentRef: assignment.assignmentId,
    taskRef: input.taskId,
    scopeRef: scope,
    cycleRef: scope.cycleId,
    inputRevision: assignment.inputRevision,
    directiveRevision: input.directiveRevision,
    executionEpoch: runtime.executionEpoch,
    runtimeBindingRef: runtime.runtimeId,
    permissionRevision: runtime.permissionRevision,
    admissionEvidenceRefs: input.admissionEvidence.map((evidence) => evidence.evidenceId.value),
    currentTurnRef: input.currentTurnRef,
    recoveryStateRef: input.recoveryStateRef.evidenceId.value,
  };
  validateAdmittedTurn(admittedTurn);
  return admittedTurn;
}

/** Runtime-owned active-turn identity, minted once when the turn is opened. */
export function newActiveTurnId(operationId: string): string {
  return id('operation', `active-turn-${operationId}`).value;
}

/**
 * Produce the exact accepted plan reference for an active-turn binding. The
 * existing task-plan owner validates the confirmed Task identity, publication
 * and physical receipt; this function only projects that verified reference.
 */
export async function produceAcceptedTurnPlanBinding(
  input: AcceptedTurnPlanProducerInput,
): Promise<TurnPlanBinding> {
  return (await readCurrentTaskPlan(input)).currentPlan;
}
