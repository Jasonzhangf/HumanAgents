import {
  ContractError,
  canonicalJsonStringify,
  validateInteractionHelperAssignment,
  validateInteractionHelperIncarnation,
  validateInteractionHelperResult,
  type AgentClosure,
  type AgentDriver,
  type AgentEvent,
  type AgentOutput,
  type AgentRuntimeId,
  type BusinessPayload,
  type EvidenceRef,
  type InteractionHelperAssignment,
  type InteractionHelperDispatchAcceptedFact,
  type InteractionHelperIdentity,
  type InteractionHelperIncarnation,
  type InteractionHelperOwnerAcceptedFact,
  type InteractionHelperResult,
  type InteractionHelperReturnedFact,
  type InteractionLatestTurnEntry,
  type JournalCommitRef,
  type OperationId,
  type ProviderBinding,
  type RawAsset,
  type TasklessProviderExecutionIdentityRef,
} from '../../../contracts/src/index.js';

/**
 * Structural Journal port. It matches the T3 JsonlInteractionHelperJournal method
 * surface without importing any adapter, keeping the Runtime adapter-independent.
 */
export interface InteractionHelperCommittedFact<TFact> {
  readonly fact: TFact;
  readonly commit: JournalCommitRef;
}

export type InteractionHelperCallCheckpointPhase = 'returned' | 'adopted';

/**
 * One durable recovery checkpoint for a single helper call. The checkpoint stays
 * descriptive: it stores the host-owned purpose and the exact fact commit refs,
 * never a copy of the helper result body.
 */
export interface InteractionHelperCallCheckpoint {
  readonly identity: InteractionHelperIdentity;
  readonly phase: InteractionHelperCallCheckpointPhase;
  readonly recordedAt: string;
  readonly description: string;
  readonly recovery: {
    readonly dispatchAcceptedCommitId: string;
    readonly returnedCommitId: string;
    readonly ownerAcceptedCommitId?: string;
  };
}

export interface InteractionHelperCallCheckpointCommit {
  readonly checkpoint: InteractionHelperCallCheckpoint;
  readonly commit: JournalCommitRef;
}

export interface InteractionHelperReturnedCommit
  extends InteractionHelperCommittedFact<InteractionHelperReturnedFact> {
  readonly checkpointCommit: InteractionHelperCallCheckpointCommit;
}

export interface InteractionHelperOwnerAcceptedCommit
  extends InteractionHelperCommittedFact<InteractionHelperOwnerAcceptedFact> {
  readonly checkpointCommit: InteractionHelperCallCheckpointCommit;
}

export interface InteractionHelperJournalReadback {
  readonly dispatchAccepted:
    InteractionHelperCommittedFact<InteractionHelperDispatchAcceptedFact> | null;
  readonly returned: InteractionHelperCommittedFact<InteractionHelperReturnedFact> | null;
  readonly ownerAccepted:
    InteractionHelperCommittedFact<InteractionHelperOwnerAcceptedFact> | null;
  readonly returnedCheckpoint: InteractionHelperCallCheckpointCommit | null;
  readonly adoptedCheckpoint: InteractionHelperCallCheckpointCommit | null;
}

export interface InteractionHelperJournalPort {
  appendDispatchAccepted(
    fact: InteractionHelperDispatchAcceptedFact,
  ): Promise<InteractionHelperCommittedFact<InteractionHelperDispatchAcceptedFact>>;
  appendReturned(
    fact: InteractionHelperReturnedFact,
    input: { readonly description: string },
  ): Promise<InteractionHelperReturnedCommit>;
  appendOwnerAccepted(
    fact: InteractionHelperOwnerAcceptedFact,
    input: { readonly description: string },
  ): Promise<InteractionHelperOwnerAcceptedCommit>;
  readCallCheckpointExact(
    identity: InteractionHelperIdentity,
    phase: InteractionHelperCallCheckpointPhase,
  ): Promise<InteractionHelperCallCheckpointCommit | null>;
  readExact(identity: InteractionHelperIdentity): Promise<InteractionHelperJournalReadback>;
}

export interface TasklessHelperExecutionBinding {
  readonly runtimeId: AgentRuntimeId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
}

export interface ExecuteTasklessInteractionHelperInput {
  readonly journal: InteractionHelperJournalPort;
  readonly driver: AgentDriver<TasklessProviderExecutionIdentityRef>;
  readonly assignment: InteractionHelperAssignment;
  readonly binding: ProviderBinding;
  readonly execution: TasklessHelperExecutionBinding;
  /** Bounded helper inputs. The parent transcript is never part of this API. */
  readonly inputs: BusinessPayload;
  readonly dispatchAcceptedAt: string;
  readonly returnedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Host-owned semantics for the returned call checkpoint. */
  readonly checkpointDescription: string;
  /**
   * Owner mapping from real driver output/closure/events to the result fields.
   * The executor still binds the 8-field identity and validates the result.
   */
  readonly conclude: (input: {
    readonly output: AgentOutput<TasklessProviderExecutionIdentityRef>;
    readonly closure: AgentClosure;
    readonly events: readonly AgentEvent<TasklessProviderExecutionIdentityRef>[];
  }) => Omit<InteractionHelperResult, keyof InteractionHelperIdentity>;
}

export interface TasklessHelperExecutionResult {
  readonly dispatchCommit: InteractionHelperCommittedFact<InteractionHelperDispatchAcceptedFact>;
  readonly returnedCommit: InteractionHelperReturnedCommit;
  readonly incarnation: InteractionHelperIncarnation;
  readonly result: InteractionHelperResult;
  readonly closure: AgentClosure;
}

function assertCheckpointDescription(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function assignmentIdentity(assignment: InteractionHelperAssignment): InteractionHelperIdentity {
  return {
    organId: assignment.organId,
    interactionScopeId: assignment.interactionScopeId,
    interactionId: assignment.interactionId,
    inputRevision: assignment.inputRevision,
    parentTurnId: assignment.parentTurnId,
    assignmentId: assignment.assignmentId,
    helperCallId: assignment.helperCallId,
    attempt: assignment.attempt,
  };
}

function tasklessIdentity(
  assignment: InteractionHelperAssignment,
  execution: TasklessHelperExecutionBinding,
): TasklessProviderExecutionIdentityRef {
  return {
    runtimeId: execution.runtimeId,
    organId: assignment.organId,
    operationId: execution.operationId,
    executionEpoch: execution.executionEpoch,
    helper: assignmentIdentity(assignment),
    taskId: undefined,
    cycleId: undefined,
  };
}

function helperRequestPayload(
  assignment: InteractionHelperAssignment,
  inputs: BusinessPayload,
): BusinessPayload {
  return {
    objective: assignment.objective,
    targetRefs: [...assignment.targetRefs],
    inputs,
  };
}

/**
 * Executes one taskless helper through an adapter-independent AgentDriver.
 * The durable dispatch fact is appended before start/submit; owner acceptance
 * is never appended here.
 */
export async function executeTasklessInteractionHelper(
  input: ExecuteTasklessInteractionHelperInput,
): Promise<TasklessHelperExecutionResult> {
  const { assignment, binding, execution } = input;
  validateInteractionHelperAssignment(assignment);
  assertCheckpointDescription(input.checkpointDescription, 'taskless helper returned checkpoint description');

  const incarnation: InteractionHelperIncarnation = {
    ...assignmentIdentity(assignment),
    runtimeId: execution.runtimeId,
    operationId: execution.operationId,
    executionEpoch: execution.executionEpoch,
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    protocol: binding.protocol,
    modelRef: binding.modelRef,
    capabilityDigest: binding.capabilityDigest,
  };
  validateInteractionHelperIncarnation(incarnation, assignment);

  const dispatchCommit = await input.journal.appendDispatchAccepted({
    kind: 'dispatch-accepted',
    assignment,
    incarnation,
    dispatchAcceptedAt: input.dispatchAcceptedAt,
    evidenceRefs: input.evidenceRefs,
  });

  const identity = tasklessIdentity(assignment, execution);
  let started = false;
  let settleAttempted = false;
  try {
    await input.driver.start({ ...identity, assignmentId: assignment.assignmentId });
    started = true;
    const output = await input.driver.submit({
      ...identity,
      assignmentId: assignment.assignmentId,
      payload: helperRequestPayload(assignment, input.inputs),
    });

    const events: AgentEvent<TasklessProviderExecutionIdentityRef>[] = [];
    for await (const event of input.driver.observe({ runtimeId: execution.runtimeId })) {
      events.push(event);
    }

    settleAttempted = true;
    const closure = await input.driver.settle({
      runtimeId: execution.runtimeId,
      executionEpoch: execution.executionEpoch,
    });

    const result: InteractionHelperResult = {
      ...assignmentIdentity(assignment),
      ...input.conclude({ output, closure, events }),
    };
    validateInteractionHelperResult(result, assignment);

    const returnedCommit = await input.journal.appendReturned(
      {
        kind: 'returned',
        result,
        returnedAt: input.returnedAt,
        evidenceRefs: input.evidenceRefs,
      },
      { description: input.checkpointDescription },
    );

    return { dispatchCommit, returnedCommit, incarnation, result, closure };
  } catch (error) {
    let failure = error;
    // A started execution owns a live provider request. If submit/observe throws
    // before the normal settle, collapse it once so no recovery obligation leaks.
    if (started && !settleAttempted) {
      try {
        await input.driver.settle({
          runtimeId: execution.runtimeId,
          executionEpoch: execution.executionEpoch,
        });
      } catch (settleError) {
        failure = new AggregateError(
          [failure, settleError],
          'taskless helper execution and settlement failed',
        );
      }
    }
    throw failure;
  }
}

export interface AcceptTasklessInteractionHelperInput {
  readonly journal: InteractionHelperJournalPort;
  readonly identity: InteractionHelperIdentity;
  readonly result: InteractionHelperResult;
  readonly refinedResult: RawAsset;
  readonly acceptedBy: string;
  readonly acceptanceRef: string;
  readonly acceptedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Host-owned semantics for the adopted call checkpoint. */
  readonly checkpointDescription: string;
}

export interface TasklessInteractionHelperAcceptance {
  readonly ownerAcceptedCommit: InteractionHelperOwnerAcceptedCommit;
  readonly latestTurnEntry: Extract<InteractionLatestTurnEntry, { readonly kind: 'helper-result' }>;
}

/**
 * Explicit owner acceptance of the durable returned conclusion. Failed and
 * incomplete conclusions can be accepted as-is; nothing here rewrites status.
 */
export async function acceptTasklessInteractionHelperResult(
  input: AcceptTasklessInteractionHelperInput,
): Promise<TasklessInteractionHelperAcceptance> {
  validateInteractionHelperResult(input.result);
  assertCheckpointDescription(input.checkpointDescription, 'taskless helper adopted checkpoint description');
  const readback = await input.journal.readExact(input.identity);
  const durableReturned = readback.returned;
  if (durableReturned === null) {
    throw new ContractError('taskless helper result has no durable returned fact to accept');
  }
  if (canonicalJsonStringify(durableReturned.fact.result) !== canonicalJsonStringify(input.result)) {
    throw new ContractError(
      'taskless helper acceptance result does not match the durable returned fact',
    );
  }

  const ownerAcceptedCommit = await input.journal.appendOwnerAccepted(
    {
      kind: 'owner-accepted',
      result: durableReturned.fact.result,
      refinedResult: input.refinedResult,
      acceptedBy: input.acceptedBy,
      acceptanceRef: input.acceptanceRef,
      acceptedAt: input.acceptedAt,
      evidenceRefs: input.evidenceRefs,
    },
    { description: input.checkpointDescription },
  );

  return {
    ownerAcceptedCommit,
    latestTurnEntry: {
      kind: 'helper-result',
      result: durableReturned.fact.result,
      refinedResult: input.refinedResult,
    },
  };
}
