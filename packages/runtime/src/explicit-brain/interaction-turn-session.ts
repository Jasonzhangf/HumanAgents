import {
  ContractError,
  canonicalJsonStringify,
  id,
  validateInteractionLatestTurn,
  validateInteractionSemanticCheckpoint,
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
  type InteractionSemanticCheckpoint,
  type InteractionTurnIdentity,
  type JournalCommitRef,
  type OrganId,
  type ProviderBinding,
  type RawAsset,
  type RawContentReadPort,
  type RequirementIntent,
  type SemanticClaim,
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
import type { InteractionParentFinalTurnOutput } from './interaction-parent-turn-raw.js';

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

/**
 * Runtime-owned receipt of one committed interaction semantic checkpoint.
 *
 * The type lives in the Runtime so the port stays adapter-independent; the Jsonl
 * implementation re-exports this name instead of declaring a second shape.
 */
export interface InteractionSemanticCheckpointCommit {
  readonly checkpoint: InteractionSemanticCheckpoint;
  readonly commit: JournalCommitRef;
}

/**
 * Narrow semantic checkpoint persistence seam. The injected Journal stays the
 * only store and lock owner; this owner holds no cache or mirror. It is separate
 * from `InteractionHelperJournalPort` so unrelated helper consumers do not have
 * to implement three checkpoint-only methods.
 */
export interface InteractionSemanticCheckpointJournalPort {
  appendSemanticCheckpoint(
    checkpoint: InteractionSemanticCheckpoint,
  ): Promise<InteractionSemanticCheckpointCommit>;
  readSemanticCheckpointExact(
    identity: InteractionTurnIdentity,
  ): Promise<InteractionSemanticCheckpointCommit | null>;
  readScopeSemanticCheckpoints(scope: {
    readonly organId: OrganId;
    readonly interactionScopeId: string;
  }): Promise<readonly InteractionSemanticCheckpointCommit[]>;
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

/**
 * The real, parsed structured requirement the interpreted outcome produced.
 * Every field is descriptive content, never a wire JSON blob or the raw prompt.
 */
export interface ExplicitTurnStructuredRequirementOutcome {
  readonly revision: number;
  readonly intent: RequirementIntent;
  readonly title: string;
  readonly objective: string;
  readonly deliverable: string;
  readonly deliveryConditions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly blockingGaps: readonly string[];
}

/** The interpreted explicit outcome the caller validated against the final output. */
export type ExplicitTurnInterpretedOutcome =
  | {
      readonly kind: 'answer' | 'status-query';
      readonly normalizedInput: string;
      readonly matchedTaskId?: string;
      readonly knownFacts: readonly string[];
      readonly answer: string;
      readonly decisionRefs: readonly string[];
    }
  | {
      readonly kind: 'clarification';
      readonly normalizedInput: string;
      readonly knownFacts: readonly string[];
      readonly question: string;
      readonly decisionRefs: readonly string[];
    }
  | {
      readonly kind: 'requirement';
      readonly normalizedInput: string;
      readonly matchedTaskId?: string;
      readonly knownFacts: readonly string[];
      readonly decisionRefs: readonly string[];
      readonly structuredProposal: ExplicitTurnStructuredRequirementOutcome;
    };

export interface ExplicitTurnHelperSessionInput {
  readonly identity: InteractionTurnIdentity;
  readonly latestTurn: InteractionLatestTurn;
  readonly journal: InteractionHelperJournalPort;
  readonly clock: ExplicitTurnHelperClock;
  readonly factory: ExplicitTurnHelperFactory;
  readonly checkpointJournal?: InteractionSemanticCheckpointJournalPort;
  readonly rawContent?: RawContentReadPort;
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

function sameHelperIdentity(left: InteractionHelperIdentity, right: InteractionHelperIdentity): boolean {
  return left.organId.scope === right.organId.scope
    && left.organId.value === right.organId.value
    && left.interactionScopeId === right.interactionScopeId
    && left.interactionId === right.interactionId
    && left.inputRevision === right.inputRevision
    && left.parentTurnId === right.parentTurnId
    && left.assignmentId === right.assignmentId
    && left.helperCallId === right.helperCallId
    && left.attempt === right.attempt;
}

function helperIdentityKey(identity: InteractionHelperIdentity): string {
  return canonicalJsonStringify([
    identity.organId.scope,
    identity.organId.value,
    identity.interactionScopeId,
    identity.interactionId,
    identity.inputRevision,
    identity.parentTurnId,
    identity.assignmentId,
    identity.helperCallId,
    identity.attempt,
  ]);
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function dedupeEvidenceRefs(values: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const value of values) {
    const key = canonicalJsonStringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** The deterministic semantic payload a close commits, excluding `committedAt`. */
interface ExplicitTurnSemanticContent {
  readonly claims: readonly SemanticClaim[];
  readonly constraints: readonly SemanticClaim[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly semanticAssetRefs: readonly EvidenceRef[];
}

function sameSemanticContent(
  identity: InteractionTurnIdentity,
  left: InteractionSemanticCheckpoint,
  right: ExplicitTurnSemanticContent,
): boolean {
  return sameTurnIdentity(identity, left)
    && canonicalJsonStringify({
      claims: left.claims,
      constraints: left.constraints,
      evidenceRefs: left.evidenceRefs,
      semanticAssetRefs: left.semanticAssetRefs,
    }) === canonicalJsonStringify({
      claims: right.claims,
      constraints: right.constraints,
      evidenceRefs: right.evidenceRefs,
      semanticAssetRefs: right.semanticAssetRefs,
    });
}

export class ExplicitTurnHelperSession {
  private readonly identity: InteractionTurnIdentity;
  private readonly journal: InteractionHelperJournalPort;
  private readonly clock: ExplicitTurnHelperClock;
  private readonly factory: ExplicitTurnHelperFactory;
  private readonly checkpointJournal: InteractionSemanticCheckpointJournalPort | undefined;
  private readonly rawContent: RawContentReadPort | undefined;
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
    this.checkpointJournal = input.checkpointJournal;
    this.rawContent = input.rawContent;
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

  /**
   * Produce the committed semantic checkpoint of this settled turn.
   *
   * The caller passes the folded final parent output plus the interpreted
   * outcome it already validated. Only durable owner-accepted helper facts and
   * real refined assets become child findings; a returned-but-unaccepted helper
   * stays an explicit partial attribution. A retry with the same turn identity
   * must reproduce the same frozen content, so a changed outcome or a late
   * acceptance under the same identity is rejected, and the first commit time is
   * preserved.
   */
  async closeTurnSemanticCheckpoint(input: {
    readonly finalParentOutput: InteractionParentFinalTurnOutput;
    readonly outcome: ExplicitTurnInterpretedOutcome;
  }): Promise<InteractionSemanticCheckpointCommit> {
    const checkpointJournal = this.checkpointJournal;
    const rawContent = this.rawContent;
    if (checkpointJournal === undefined) {
      throw new ContractError('explicit turn semantic close requires a bound semantic checkpoint journal');
    }
    if (rawContent === undefined) {
      throw new ContractError('explicit turn semantic close requires a bound raw content reader');
    }
    if (!sameTurnIdentity(this.identity, input.finalParentOutput.turnInput.fact.turn)) {
      throw new ContractError('explicit turn semantic close final parent output does not match the session turn');
    }

    const content = await buildExplicitTurnSemanticContent({
      identity: this.identity,
      finalParentOutput: input.finalParentOutput,
      outcome: input.outcome,
      helperJournal: this.journal,
      rawContent,
      entries: this.entries,
      dispatched: this.dispatched,
    });

    const existing = await checkpointJournal.readSemanticCheckpointExact(this.identity);
    if (existing !== null) {
      if (!sameSemanticContent(this.identity, existing.checkpoint, content)) {
        throw new ContractError(
          `explicit turn semantic close for ${this.identity.turnId} conflicts with the committed checkpoint`,
        );
      }
      return existing;
    }

    const checkpoint: InteractionSemanticCheckpoint = {
      kind: 'semantic-checkpoint',
      organId: this.identity.organId,
      interactionScopeId: this.identity.interactionScopeId,
      interactionId: this.identity.interactionId,
      inputRevision: this.identity.inputRevision,
      turnId: this.identity.turnId,
      committedAt: this.clock.now(),
      claims: [...content.claims],
      constraints: [...content.constraints],
      evidenceRefs: [...content.evidenceRefs],
      semanticAssetRefs: [...content.semanticAssetRefs],
    };
    validateInteractionSemanticCheckpoint(checkpoint);
    return checkpointJournal.appendSemanticCheckpoint(checkpoint);
  }
}

async function buildExplicitTurnSemanticContent(input: {
  readonly identity: InteractionTurnIdentity;
  readonly finalParentOutput: InteractionParentFinalTurnOutput;
  readonly outcome: ExplicitTurnInterpretedOutcome;
  readonly helperJournal: InteractionHelperJournalPort;
  readonly rawContent: RawContentReadPort;
  readonly entries: readonly InteractionLatestTurnEntry[];
  readonly dispatched: ReadonlyMap<string, DispatchedExplicitTurnHelper>;
}): Promise<ExplicitTurnSemanticContent> {
  const { identity, finalParentOutput, outcome } = input;
  const claims: SemanticClaim[] = [];
  const constraints: SemanticClaim[] = [];
  const evidenceRefs: EvidenceRef[] = [finalParentOutput.turnInput.fact.initialInput.ref];
  const semanticAssetRefs: EvidenceRef[] = [];

  const baseSourceRefs = dedupeStrings([
    finalParentOutput.turnInput.commit.commitId,
    finalParentOutput.requestCompleteCommit.commitId,
    ...outcome.decisionRefs,
  ]);

  claims.push({
    fact: outcome.kind === 'requirement'
      ? `goal: ${outcome.structuredProposal.objective} (title: ${outcome.structuredProposal.title}, intent: ${outcome.structuredProposal.intent})`
      : `goal: ${outcome.normalizedInput}`,
    certainty: 'confirmed',
    sourceRefs: baseSourceRefs,
  });
  for (const knownFact of outcome.knownFacts) {
    // The interpreter reported the fact, not an owner-verified world truth, so
    // the claim stays attributed and partial.
    claims.push({ fact: `known-fact: ${knownFact}`, certainty: 'partial', sourceRefs: baseSourceRefs });
  }

  const helperIdentities = new Map<string, InteractionHelperIdentity>();
  for (const dispatched of input.dispatched.values()) {
    helperIdentities.set(helperIdentityKey(dispatched.identity), dispatched.identity);
  }
  for (const entry of input.entries) {
    if (entry.kind !== 'helper-result') continue;
    helperIdentities.set(helperIdentityKey(entry.result), entry.result);
  }

  let ownerAcceptedCount = 0;
  const orderedKeys = [...helperIdentities.keys()].sort();
  for (const key of orderedKeys) {
    const helper = helperIdentities.get(key)!;
    const readback = await input.helperJournal.readExact(helper);
    if (readback.dispatchAccepted === null || readback.returned === null) {
      throw new ContractError(
        `explicit turn semantic close requires a durable dispatch and return for helper ${helper.helperCallId}`,
      );
    }
    const acceptedEntry = input.entries.find((entry): entry is Extract<
      InteractionLatestTurnEntry,
      { readonly kind: 'helper-result' }
    > => entry.kind === 'helper-result' && sameHelperIdentity(entry.result, helper));
    if (readback.ownerAccepted !== null) {
      if (acceptedEntry === undefined) {
        throw new ContractError(
          `owner-accepted helper ${helper.helperCallId} has no refined result entry in this turn`,
        );
      }
      const refinedText = decodeUtf8(await input.rawContent.read({
        scope: acceptedEntry.refinedResult.ref.scope,
        content: acceptedEntry.refinedResult,
      }));
      claims.push({
        fact: `what-done(owner-accepted): [${acceptedEntry.result.agentId}:${acceptedEntry.result.helperCallId}:${acceptedEntry.result.status}] ${refinedText}`,
        certainty: 'confirmed',
        sourceRefs: dedupeStrings([
          readback.ownerAccepted.commit.commitId,
          readback.ownerAccepted.fact.acceptanceRef,
          acceptedEntry.refinedResult.ref.locator,
          ...acceptedEntry.result.outputRefs,
        ]),
      });
      ownerAcceptedCount += 1;
      semanticAssetRefs.push(acceptedEntry.refinedResult.ref);
      evidenceRefs.push(...acceptedEntry.result.evidenceRefs, ...readback.ownerAccepted.fact.evidenceRefs);
      continue;
    }
    // Returned but not owner-accepted: keep the partial attribution and never
    // treat the child summary as accepted work or semantic content.
    claims.push({
      fact: `helper-unaccepted(returned-only): [${readback.returned.fact.result.agentId}:${readback.returned.fact.result.helperCallId}:${readback.returned.fact.result.status}] not accepted by parent owner`,
      certainty: 'partial',
      sourceRefs: dedupeStrings([
        readback.dispatchAccepted.commit.commitId,
        readback.returned.commit.commitId,
      ]),
    });
  }

  if (ownerAcceptedCount === 0) {
    claims.push({
      fact: `what-done(parent): normalized explicit input and settled parent turn (${outcome.kind})`,
      certainty: 'confirmed',
      sourceRefs: baseSourceRefs,
    });
  }

  claims.push({
    fact: outcome.kind === 'clarification'
      ? `outcome(clarification): ${outcome.question}`
      : outcome.kind === 'requirement'
        ? `outcome(requirement:${outcome.structuredProposal.intent}): ${outcome.structuredProposal.deliverable}`
        : `outcome(${outcome.kind}): ${outcome.answer}`,
    certainty: 'confirmed',
    sourceRefs: baseSourceRefs,
  });
  claims.push({
    fact: outcome.kind === 'clarification'
      ? 'next: await user clarification response'
      : outcome.kind === 'requirement'
        ? 'next: route confirmed requirement proposal to FIFO intake'
        : 'next: explicit turn complete; await next user input',
    certainty: 'confirmed',
    sourceRefs: baseSourceRefs,
  });

  if (outcome.kind === 'clarification') {
    claims.push({ fact: `unknown: ${outcome.question}`, certainty: 'unknown', sourceRefs: baseSourceRefs });
  }
  if (outcome.kind === 'requirement') {
    const proposalSourceRefs = dedupeStrings([
      ...baseSourceRefs,
      ...outcome.structuredProposal.evidenceRefs,
    ]);
    for (const gap of outcome.structuredProposal.blockingGaps) {
      claims.push({ fact: `unknown: ${gap}`, certainty: 'unknown', sourceRefs: proposalSourceRefs });
    }
    for (const condition of outcome.structuredProposal.deliveryConditions) {
      constraints.push({ fact: condition, certainty: 'confirmed', sourceRefs: proposalSourceRefs });
    }
  }

  evidenceRefs.push(...finalParentOutput.assistantContentRefs);
  return {
    claims,
    constraints,
    evidenceRefs: dedupeEvidenceRefs(evidenceRefs),
    semanticAssetRefs: dedupeEvidenceRefs(semanticAssetRefs),
  };
}
