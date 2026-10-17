import {
  ContractError,
  assertEvidenceRef,
  assertSameScope,
  validateWorkAssignment,
  validateWorkResult,
  type JournalCommitRef,
  type ScheduleOccurrenceRef,
  type ScopeRef,
  type ScopedId,
  type WorkAssignment,
  type WorkResult,
} from '../../contracts/src/index.js';
import {
  validateDurableInspectionDefinition,
  validateInspectionExecutionBinding,
  validateInspectionExecutableCheck,
  validateInspectionItemDelivery,
  validateInspectionItemResultRecord,
  type InspectionAcceptedCheckPort,
  type I2JournalPort,
  type InspectionCheckPort,
  type InspectionExecutionBinding,
  type InspectionExecutableCheck,
  type InspectionItemDelivery,
  type InspectionItemResultRecord,
} from '../../contracts/src/i2-history.js';
import {
  digestOf,
  type ExecutionAgentPort,
  type ReviewSubjectMaterial,
} from '../../runtime/src/orchestration/index.js';

type InspectionCheckRequest = Parameters<InspectionCheckPort['run']>[0];

/**
 * One App adapter that turns an already admitted execution actor's exact
 * structured observation into the frozen `InspectionItemDelivery`.
 *
 * The injected `journal` reader is the authoritative, digest-verified exact
 * definition source. The injected `execute` call is the already admitted,
 * independently selected actor. The injected `readOutput` resolves the exact
 * produced artifact body/ref/digest. This adapter allocates nothing: it does
 * not open occurrences, commit item results, settle, recover, rerun, compare,
 * or choose a provider/actor.
 */
export function createInspectionCheckPort(input: {
  readonly journal: Pick<I2JournalPort, 'read'>;
  readonly execute: (
    request: InspectionCheckRequest,
  ) => ReturnType<ExecutionAgentPort['execute']>;
  readonly readOutput: (
    request: InspectionCheckRequest,
    result: WorkResult,
  ) => Promise<ReviewSubjectMaterial>;
}): InspectionAcceptedCheckPort {
  return {
    async run(request) {
      const { binding, check, assignment } = request;
      await validateRequest(input.journal, request);

      const execution = await input.execute(request);
      const result = 'result' in execution ? execution.result : execution;
      validateWorkResult(result, assignment);

      const material = await input.readOutput(request, result);
      const producedIndex = result.producedArtifactRefs.indexOf(material.ref);
      if (producedIndex < 0) {
        throw new ContractError('inspection output ref is not a produced artifact of the executed assignment');
      }
      if (result.producedArtifactDigests[producedIndex] !== material.digest) {
        throw new ContractError('inspection output digest does not match the produced artifact digest');
      }
      if (digestOf(material.body) !== material.digest) {
        throw new ContractError('inspection output body does not match its produced digest');
      }
      if (
        result.producedArtifactBodies !== undefined
        && result.producedArtifactBodies[producedIndex] !== material.body
      ) {
        throw new ContractError('inspection output body does not match the produced artifact body');
      }

      const record = parseInspectionItemResultRecord(material.body);
      validateInspectionItemResultRecord(record);
      if (!sameBinding(record.binding, binding)) {
        throw new ContractError('inspection item result binding does not match the requested binding');
      }
      validateDeliveryMatch(check, assignment, result, record.delivery);
      return record.delivery;
    },
    accept: createInspectionAcceptedCheckPort(input).accept,
  };
}

/**
 * Accepts an already-produced inspection delivery without executing the actor
 * or reading its output. The journal remains the authoritative definition source.
 */
export function createInspectionAcceptedCheckPort(input: {
  readonly journal: Pick<I2JournalPort, 'read'>;
}): Pick<InspectionAcceptedCheckPort, 'accept'> {
  return {
    async accept({ binding, check, assignment, result, delivery }) {
      await validateRequest(input.journal, { binding, check, assignment });
      validateWorkResult(result, assignment);
      for (const ref of result.evidenceRefs) assertEvidenceRef(ref);
      validateInspectionItemDelivery(delivery);
      validateDeliveryMatch(check, assignment, result, delivery);
      return delivery;
    },
  };
}

async function validateRequest(
  journal: Pick<I2JournalPort, 'read'>,
  request: InspectionCheckRequest,
): Promise<void> {
  const { binding, check, assignment } = request;

  validateInspectionExecutionBinding(binding);
  validateInspectionExecutableCheck(check);
  validateWorkAssignment(assignment);

  const definitionRecord = await journal.read(
    binding.occurrence.scope,
    binding.definitionCommitRef,
  );
  if (definitionRecord.kind !== 'inspection-definition') {
    throw new ContractError('inspection check requires an inspection-definition record');
  }
  const definition = definitionRecord;
  validateDurableInspectionDefinition(definition);

  assertSameScope(definition.taskScope, binding.occurrence.scope);
  if (
    definition.content.definition.definitionId !== binding.definition.definitionId
    || definition.content.definition.definitionVersion !== binding.definition.definitionVersion
  ) {
    throw new ContractError('inspection definition identity does not match the requested binding');
  }
  if (definition.definitionDigest !== binding.definitionDigest) {
    throw new ContractError('inspection definition digest does not match the requested binding');
  }

  const committedCheck = definition.content.checks.find(
    (candidate) => candidate.checkId === check.checkId,
  );
  if (committedCheck === undefined) {
    throw new ContractError('requested inspection check is not declared in the committed definition');
  }
  if (committedCheck.criterion !== check.criterion) {
    throw new ContractError('requested inspection criterion does not match the committed definition');
  }
  if (!sameStrings(committedCheck.inputRefs, check.inputRefs)) {
    throw new ContractError('requested inspection input refs do not match the committed definition');
  }

  if (assignment.taskId.value !== binding.executionScope.taskId?.value) {
    throw new ContractError('inspection assignment task does not match the execution task');
  }
  if (
    binding.executionScope.cycleId !== undefined
    && binding.executionScope.cycleId.value !== binding.cycleId
  ) {
    throw new ContractError('inspection execution scope cycle does not match the binding cycle');
  }
  if (assignment.executionEpoch !== binding.executionEpoch) {
    throw new ContractError('inspection assignment execution epoch does not match the binding');
  }
}

function validateDeliveryMatch(
  check: InspectionExecutableCheck,
  assignment: WorkAssignment,
  result: WorkResult,
  delivery: InspectionItemDelivery,
): void {
  if (delivery.checkId !== check.checkId) {
    throw new ContractError('inspection item result check id does not match the requested check');
  }
  if (delivery.attempt !== assignment.attempt) {
    throw new ContractError('inspection item result attempt does not match the requested assignment');
  }
  if (result.status !== 'succeeded' && delivery.outcome.status === 'completed') {
    throw new ContractError('inspection non-successful execution cannot produce a completed delivery');
  }
}

function parseInspectionItemResultRecord(body: string): InspectionItemResultRecord {
  try {
    return JSON.parse(body) as InspectionItemResultRecord;
  } catch {
    throw new ContractError('inspection output body is not a valid inspection item result record');
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameScopedId(left: ScopedId | undefined, right: ScopedId | undefined): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return sameScopedId(left.organId, right.organId)
    && sameScopedId(left.taskId, right.taskId)
    && sameScopedId(left.cycleId, right.cycleId)
    && sameScopedId(left.operationId, right.operationId);
}

function sameCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function sameScheduleOccurrence(
  left: ScheduleOccurrenceRef | null,
  right: ScheduleOccurrenceRef | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.subscriptionId === right.subscriptionId
    && left.scheduleRevision === right.scheduleRevision
    && left.ordinal === right.ordinal
    && left.occurrenceId === right.occurrenceId;
}

function sameBinding(
  left: InspectionExecutionBinding,
  right: InspectionExecutionBinding,
): boolean {
  return left.occurrence.occurrenceId === right.occurrence.occurrenceId
    && sameScope(left.occurrence.scope, right.occurrence.scope)
    && sameScope(left.executionScope, right.executionScope)
    && left.cycleId === right.cycleId
    && left.executionEpoch === right.executionEpoch
    && left.definition.definitionId === right.definition.definitionId
    && left.definition.definitionVersion === right.definition.definitionVersion
    && sameCommitRef(left.definitionCommitRef, right.definitionCommitRef)
    && left.definitionDigest === right.definitionDigest
    && sameCommitRef(left.cycleOpenedCommitRef, right.cycleOpenedCommitRef)
    && sameScheduleOccurrence(left.scheduleOccurrenceRef, right.scheduleOccurrenceRef);
}
