import {
  validateAdmittedTurnIdentity,
  validatePlannerAlignmentReference,
  validateTurnClosureReference,
  validateTurnRecoveryReference,
  type AdmittedTurnIdentity,
  type CheckpointId,
  type PlannerAlignmentReference,
  type ScopeRef,
  type TurnClosureReference,
  type TurnRecoveryReference,
} from '../../contracts/src/index.js';
import { TurnClosureError } from './errors.js';

/** A turn only advances when the closure is committed and the planner alignment matches its decision. */
export type TurnDecision = 'continue' | 'complete' | 'failed';

export type TurnAdvanceAdmission =
  | { readonly state: 'closed'; readonly decision: TurnDecision; readonly closure: TurnClosureReference; readonly alignment: PlannerAlignmentReference }
  | { readonly state: 'recovering'; readonly recovery: TurnRecoveryReference };

function fail(error: unknown): never {
  if (error instanceof TurnClosureError) throw error;
  throw new TurnClosureError(error instanceof Error ? error.message : 'invalid turn closure admission');
}

function validated(action: () => void): void {
  try {
    action();
  } catch (error) {
    fail(error);
  }
}

function sameScopedId(left: { readonly scope: string; readonly value: string } | undefined, right: { readonly scope: string; readonly value: string } | undefined): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return sameScopedId(left.organId, right.organId)
    && sameScopedId(left.taskId, right.taskId)
    && sameScopedId(left.cycleId, right.cycleId)
    && sameScopedId(left.operationId, right.operationId);
}

function sameCheckpointId(left: CheckpointId, right: CheckpointId): boolean {
  return sameScopedId(left, right);
}

export function assertSameAdmittedTurn(left: AdmittedTurnIdentity, right: AdmittedTurnIdentity): void {
  validated(() => validateAdmittedTurnIdentity(left));
  validated(() => validateAdmittedTurnIdentity(right));
  if (left.turnId !== right.turnId
    || left.workAssignmentRef !== right.workAssignmentRef
    || !sameScopedId(left.taskRef, right.taskRef)
    || !sameScope(left.scopeRef, right.scopeRef)
    || !sameScopedId(left.cycleRef, right.cycleRef)
    || left.inputRevision !== right.inputRevision
    || left.directiveRevision !== right.directiveRevision
    || left.executionEpoch !== right.executionEpoch
    || left.runtimeBindingRef !== right.runtimeBindingRef
    || left.permissionRevision !== right.permissionRevision) {
    throw new TurnClosureError('admitted turn identity mismatch');
  }
}

/** Recovery keeps the same logical turn. The execution epoch may advance under the existing fencing rules. */
export function assertSameLogicalTurn(left: AdmittedTurnIdentity, right: AdmittedTurnIdentity): void {
  validated(() => validateAdmittedTurnIdentity(left));
  validated(() => validateAdmittedTurnIdentity(right));
  if (left.turnId !== right.turnId
    || left.workAssignmentRef !== right.workAssignmentRef
    || !sameScopedId(left.taskRef, right.taskRef)
    || !sameScopedId(left.cycleRef, right.cycleRef)) {
    throw new TurnClosureError('recovery must continue the same logical turn');
  }
}

export function assertTurnAlignmentBinding(closure: TurnClosureReference, alignment: PlannerAlignmentReference): void {
  validated(() => validateTurnClosureReference(closure));
  validated(() => validatePlannerAlignmentReference(alignment));
  assertSameAdmittedTurn(closure.identity, alignment.identity);
  if (!sameCheckpointId(closure.checkpointId, alignment.checkpointId)) {
    throw new TurnClosureError('planner alignment must reference the closure checkpoint');
  }
  if (closure.closureRef !== alignment.closureRef) {
    throw new TurnClosureError('planner alignment must reference the same closure commit');
  }
}

export function assertTurnDecisionAdmission(input: { readonly closure: TurnClosureReference; readonly alignment: PlannerAlignmentReference; readonly decision: TurnDecision }): void {
  if (typeof input !== 'object' || input === null) throw new TurnClosureError('turn decision admission must be an object');
  assertTurnAlignmentBinding(input.closure, input.alignment);
  if (input.decision !== input.alignment.decision) {
    throw new TurnClosureError('turn decision must match the planner alignment decision');
  }
}

export function assertTurnRecoveryAdmission(recovery: TurnRecoveryReference, expected?: AdmittedTurnIdentity): void {
  validated(() => validateTurnRecoveryReference(recovery));
  if (expected !== undefined) assertSameLogicalTurn(expected, recovery.identity);
}

export function assertTurnAdvanceAdmission(admission: TurnAdvanceAdmission): void {
  if (typeof admission !== 'object' || admission === null) throw new TurnClosureError('turn advance admission must be an object');
  if (admission.state === 'closed') {
    assertTurnDecisionAdmission(admission);
    return;
  }
  if (admission.state === 'recovering') {
    assertTurnRecoveryAdmission(admission.recovery);
    return;
  }
  throw new TurnClosureError('turn advance admission state is invalid');
}
