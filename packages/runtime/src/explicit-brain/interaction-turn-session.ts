import {
  ContractError,
  id,
  validateInteractionLatestTurn,
  validateInteractionTurnIdentity,
  type AgentClosure,
  type AgentDriver,
  type AgentEvent,
  type AgentOutput,
  type BusinessPayload,
  type EvidenceRef,
  type InteractionHelperAssignment,
  type InteractionHelperAssignmentFields,
  type InteractionHelperIdentity,
  type InteractionHelperResult,
  type InteractionLatestTurn,
  type InteractionLatestTurnEntry,
  type InteractionTurnIdentity,
  type ProviderBinding,
  type RawAsset,
  type TasklessProviderExecutionIdentityRef,
} from '../../../contracts/src/index.js';
import {
  acceptTasklessInteractionHelperResult,
  executeTasklessInteractionHelper,
  type InteractionHelperJournalPort,
  type TasklessHelperExecutionBinding,
  type TasklessHelperExecutionResult,
  type TasklessInteractionHelperAcceptance,
} from './taskless-helper-executor.js';

/**
 * Runtime-owned per-turn helper session.
 *
 * The session binds one real `InteractionTurnIdentity` and its initial
 * `InteractionLatestTurn`. For each dynamic dispatch it allocates a fresh
 * helper/assignment/attempt identity plus independent runtime/operation/epoch,
 * runs the helper through the existing `executeTasklessInteractionHelper`, and
 * keeps the durable returned conclusion separate from owner acceptance. Only an
 * explicit `acceptHelper` call appends the real latest-turn entry.
 *
 * Ownership boundaries held here:
 *   - the session never derives a business status from transport/closure state;
 *     the caller passes the real mapping through `conclude`, so `succeeded`,
 *     `incomplete`, `failed`, `blocked` and `cancelled` are all preserved;
 *   - the session never invents time or assets: `acceptHelper` takes the caller's
 *     real `RawAsset` and every timestamp comes from the injected host clock;
 *   - the session never selects a fixed role order; each dispatch carries its own
 *     selection, and `returned` is never auto-accepted.
 *
 * It depends only on the typed `InteractionHelperJournalPort` and the contracts,
 * never on an adapter or the App.
 */

/** Injected host clock. A model never assigns helper time. */
export interface ExplicitTurnHelperClock {
  now(): string;
}

/** The bounded, dynamic role selection for one helper dispatch. */
export interface ExplicitTurnHelperSelection {
  readonly roleId: string;
  readonly configuredAgentId?: string;
}

export interface ExplicitTurnHelperFactoryInput {
  readonly selection: ExplicitTurnHelperSelection;
  readonly assignment: InteractionHelperAssignment;
  readonly execution: TasklessHelperExecutionBinding;
}

/**
 * The real driver/binding for one helper, plus the close callback for the
 * provider resource the factory actually owns.
 */
export interface ExplicitTurnHelperFactoryResult {
  readonly binding: ProviderBinding;
  readonly driver: AgentDriver<TasklessProviderExecutionIdentityRef>;
  readonly close?: () => Promise<void>;
}

export type ExplicitTurnHelperFactory = (
  input: ExplicitTurnHelperFactoryInput,
) => Promise<ExplicitTurnHelperFactoryResult>;

export interface DispatchExplicitTurnHelperInput {
  readonly selection: ExplicitTurnHelperSelection;
  readonly assignmentFields: InteractionHelperAssignmentFields;
  /** Bounded helper inputs. The parent transcript is never part of this API. */
  readonly inputs: BusinessPayload;
  readonly evidenceRefs: readonly EvidenceRef[];
  /**
   * Owner mapping from the real driver output/closure/events to the business
   * result fields. The session does not synthesize this mapping and never reads
   * the transport closure state as a business status.
   */
  readonly conclude: (input: {
    readonly output: AgentOutput<TasklessProviderExecutionIdentityRef>;
    readonly closure: AgentClosure;
    readonly events: readonly AgentEvent<TasklessProviderExecutionIdentityRef>[];
  }) => Omit<InteractionHelperResult, keyof InteractionHelperIdentity>;
}

/** The durable dispatch/return facts of one helper call, kept for this turn. */
export interface DispatchedExplicitTurnHelper {
  readonly identity: InteractionHelperIdentity;
  readonly execution: TasklessHelperExecutionBinding;
  readonly result: InteractionHelperResult;
  readonly closure: AgentClosure;
  readonly dispatchAcceptedCommitId: string;
  readonly returnedCommitId: string;
}

export interface AcceptExplicitTurnHelperInput {
  readonly helperCallId: string;
  /** The caller's real refined asset. The session never fabricates a ref. */
  readonly refinedResult: RawAsset;
  readonly acceptedBy: string;
  readonly acceptanceRef: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ExplicitTurnHelperSessionInput {
  readonly identity: InteractionTurnIdentity;
  readonly latestTurn: InteractionLatestTurn;
  readonly journal: InteractionHelperJournalPort;
  readonly clock: ExplicitTurnHelperClock;
  readonly factory: ExplicitTurnHelperFactory;
}

function helperIdentityOf(assignment: InteractionHelperAssignment): InteractionHelperIdentity {
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

function sameTurnIdentity(left: InteractionTurnIdentity, right: InteractionTurnIdentity): boolean {
  return left.organId.scope === right.organId.scope
    && left.organId.value === right.organId.value
    && left.interactionScopeId === right.interactionScopeId
    && left.interactionId === right.interactionId
    && left.inputRevision === right.inputRevision
    && left.turnId === right.turnId;
}

export class ExplicitTurnHelperSession {
  private readonly identity: InteractionTurnIdentity;
  private readonly journal: InteractionHelperJournalPort;
  private readonly clock: ExplicitTurnHelperClock;
  private readonly factory: ExplicitTurnHelperFactory;
  private readonly entries: InteractionLatestTurnEntry[];
  private readonly dispatched = new Map<string, DispatchedExplicitTurnHelper>();
  private sequence = 0;

  constructor(input: ExplicitTurnHelperSessionInput) {
    validateInteractionTurnIdentity(input.identity);
    validateInteractionLatestTurn(input.latestTurn);
    if (!sameTurnIdentity(input.identity, input.latestTurn)) {
      throw new ContractError('explicit turn helper session latest turn does not match the session identity');
    }
    this.identity = { ...input.identity };
    this.journal = input.journal;
    this.clock = input.clock;
    this.factory = input.factory;
    this.entries = [...input.latestTurn.entries];
  }

  /** The ordered latest turn: the initial entries plus every accepted helper result. */
  latestTurn(): InteractionLatestTurn {
    return { ...this.identity, entries: [...this.entries] };
  }

  /**
   * Dispatch one dynamic taskless helper. The durable dispatch fact is written
   * before start/submit; the returned conclusion is cached for this turn and is
   * never accepted here. The owned provider is closed exactly once.
   */
  async dispatchHelper(
    input: DispatchExplicitTurnHelperInput,
  ): Promise<DispatchedExplicitTurnHelper> {
    const ordinal = this.sequence + 1;
    this.sequence = ordinal;
    const slug = `${this.identity.turnId}-helper-${ordinal}`;
    const assignment: InteractionHelperAssignment = {
      organId: this.identity.organId,
      interactionScopeId: this.identity.interactionScopeId,
      interactionId: this.identity.interactionId,
      inputRevision: this.identity.inputRevision,
      parentTurnId: this.identity.turnId,
      assignmentId: `${slug}-assignment`,
      helperCallId: `${slug}-call`,
      attempt: 1,
      ...input.assignmentFields,
    };
    const execution: TasklessHelperExecutionBinding = {
      runtimeId: `${slug}-runtime`,
      operationId: id('operation', slug),
      executionEpoch: 1,
    };
    const owned = await this.factory({
      selection: input.selection,
      assignment,
      execution,
    });

    let executed: TasklessHelperExecutionResult | undefined;
    let dispatchError: unknown;
    // The dispatch fact is stamped now, but the return fact must be stamped when
    // the executor appends it (after start/submit/observe/settle). Sample the host
    // clock lazily through a getter so `returnedAt` is the real return time rather
    // than a value pre-evaluated here before the helper runs.
    const clock = this.clock;
    try {
      executed = await executeTasklessInteractionHelper({
        journal: this.journal,
        driver: owned.driver,
        assignment,
        binding: owned.binding,
        execution,
        inputs: input.inputs,
        dispatchAcceptedAt: clock.now(),
        get returnedAt(): string {
          return clock.now();
        },
        evidenceRefs: input.evidenceRefs,
        conclude: input.conclude,
      });
    } catch (error) {
      dispatchError = error;
    }

    // The executor already settles a started driver once; the session only
    // releases the provider resource the factory actually owns.
    let closeError: unknown;
    if (owned.close !== undefined) {
      try {
        await owned.close();
      } catch (error) {
        closeError = error;
      }
    }

    if (dispatchError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [dispatchError, closeError],
        'explicit turn helper dispatch and owned provider close failed',
      );
    }
    if (dispatchError !== undefined) throw dispatchError;
    if (closeError !== undefined) throw closeError;

    const result = executed!;
    const dispatched: DispatchedExplicitTurnHelper = {
      identity: helperIdentityOf(assignment),
      execution,
      result: result.result,
      closure: result.closure,
      dispatchAcceptedCommitId: result.dispatchCommit.commit.commitId,
      returnedCommitId: result.returnedCommit.commit.commitId,
    };
    this.dispatched.set(assignment.helperCallId, dispatched);
    return dispatched;
  }

  /**
   * Explicitly accept a returned helper conclusion and append its real
   * latest-turn entry. Any legal status may be accepted as-is.
   */
  async acceptHelper(
    input: AcceptExplicitTurnHelperInput,
  ): Promise<TasklessInteractionHelperAcceptance> {
    const dispatched = this.dispatched.get(input.helperCallId);
    if (dispatched === undefined) {
      throw new ContractError(
        `explicit turn helper ${input.helperCallId} was not dispatched in this turn`,
      );
    }
    const acceptance = await acceptTasklessInteractionHelperResult({
      journal: this.journal,
      identity: dispatched.identity,
      result: dispatched.result,
      refinedResult: input.refinedResult,
      acceptedBy: input.acceptedBy,
      acceptanceRef: input.acceptanceRef,
      acceptedAt: this.clock.now(),
      evidenceRefs: input.evidenceRefs,
    });
    this.entries.push(acceptance.latestTurnEntry);
    return acceptance;
  }
}
