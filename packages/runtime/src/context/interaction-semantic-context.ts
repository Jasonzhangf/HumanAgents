import {
  ContractError,
  type EvidenceRef,
  type OrganId,
  type RawAsset,
  type ScopeRef,
  type SemanticClaim,
} from '../../../contracts/src/index.js';
import {
  validateInteractionLatestTurn,
  validateInteractionSemanticCheckpoint,
  validateInteractionTurnIdentity,
  type InteractionHelperResult,
  type InteractionLatestTurn,
  type InteractionLatestTurnEntry,
  type InteractionSemanticCheckpoint,
  type InteractionTurnIdentity,
} from '../../../contracts/src/interaction-helper.js';
import type { InteractionParentOpenedTurnScopeReadPort } from '../explicit-brain/interaction-parent-turn-raw.js';
import type { InteractionSemanticCheckpointJournalPort } from '../explicit-brain/interaction-turn-session.js';

/**
 * Pure explicit interaction semantic-context assembler.
 *
 * It composes the canonical input for the explicit Brain interpreter from:
 *   1. the explicit interaction scope and current turn identity;
 *   2. the caller-selected committed semantic checkpoints (history);
 *   3. the complete, ordered latest interaction turn; and
 *   4. the current input and clarifications.
 *
 * Older turns enter as committed semantic checkpoints. Each checkpoint is
 * projected field by field, so a raw/recovery/extra field on a checkpoint
 * cannot leak into the result. Only the latest turn keeps full ordered content.
 * This function holds no store, performs no persistence, executes no helper,
 * owns no lifecycle, and never selects a global "latest": the caller selects
 * the exact committed refs. Every value is copied, so the result shares no
 * writable storage with the caller or another agent.
 */
export class InteractionSemanticContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractionSemanticContextError';
  }
}

/** A current-turn clarification joined to the ordered latest turn. */
export interface InteractionCurrentClarification {
  readonly question: RawAsset;
  readonly answer?: RawAsset;
}

export interface InteractionSemanticContextInput {
  readonly identity: InteractionTurnIdentity;
  readonly semanticHistory: readonly InteractionSemanticCheckpoint[];
  readonly latestTurn: InteractionLatestTurn;
  readonly currentInput: RawAsset;
  readonly clarifications: readonly InteractionCurrentClarification[];
}

/**
 * The exact fields a committed semantic checkpoint contributes to history.
 * Derived by field, never by a whole-object spread, so raw/recovery/extra
 * fields cannot leak.
 */
export interface InteractionSemanticHistoryEntry {
  readonly kind: 'semantic-checkpoint';
  readonly organId: OrganId;
  readonly interactionScopeId: string;
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly turnId: string;
  readonly committedAt: string;
  readonly claims: readonly SemanticClaim[];
  readonly constraints: readonly SemanticClaim[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly semanticAssetRefs: readonly EvidenceRef[];
}

export interface InteractionSemanticContext {
  readonly kind: 'interaction-semantic-context';
  readonly identity: InteractionTurnIdentity;
  readonly history: readonly InteractionSemanticHistoryEntry[];
  readonly latestTurn: readonly InteractionLatestTurnEntry[];
  readonly currentInput: RawAsset;
  readonly clarifications: readonly InteractionCurrentClarification[];
}

function sameOrganId(left: OrganId, right: OrganId): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function copyOrganId(organId: OrganId): OrganId {
  return { scope: organId.scope, value: organId.value };
}

function copyScope(scope: ScopeRef): ScopeRef {
  return {
    organId: copyOrganId(scope.organId),
    ...(scope.taskId === undefined ? {} : {
      taskId: { scope: scope.taskId.scope, value: scope.taskId.value },
    }),
    ...(scope.cycleId === undefined ? {} : {
      cycleId: { scope: scope.cycleId.scope, value: scope.cycleId.value },
    }),
    ...(scope.operationId === undefined ? {} : {
      operationId: { scope: scope.operationId.scope, value: scope.operationId.value },
    }),
  };
}

function copyEvidenceRef(ref: EvidenceRef): EvidenceRef {
  return {
    evidenceId: { scope: ref.evidenceId.scope, value: ref.evidenceId.value },
    kind: ref.kind,
    source: ref.source,
    locator: ref.locator,
    ...(ref.digest === undefined ? {} : { digest: ref.digest }),
    scope: copyScope(ref.scope),
  };
}

function copyRawAsset(asset: RawAsset): RawAsset {
  return { ref: copyEvidenceRef(asset.ref), view: { ...asset.view } };
}

function copyClaim(claim: SemanticClaim): SemanticClaim {
  return { fact: claim.fact, certainty: claim.certainty, sourceRefs: [...claim.sourceRefs] };
}

function copyTurnIdentity(identity: InteractionTurnIdentity): InteractionTurnIdentity {
  return {
    organId: copyOrganId(identity.organId),
    interactionScopeId: identity.interactionScopeId,
    interactionId: identity.interactionId,
    inputRevision: identity.inputRevision,
    turnId: identity.turnId,
  };
}

function copyHelperResult(result: InteractionHelperResult): InteractionHelperResult {
  return {
    organId: copyOrganId(result.organId),
    interactionScopeId: result.interactionScopeId,
    interactionId: result.interactionId,
    inputRevision: result.inputRevision,
    parentTurnId: result.parentTurnId,
    assignmentId: result.assignmentId,
    helperCallId: result.helperCallId,
    attempt: result.attempt,
    agentId: result.agentId,
    producedArtifactRefs: [...result.producedArtifactRefs],
    ...(result.producedArtifactBodies === undefined ? {} : {
      producedArtifactBodies: [...result.producedArtifactBodies],
    }),
    status: result.status,
    summary: result.summary,
    outputRefs: [...result.outputRefs],
    evidenceRefs: result.evidenceRefs.map(copyEvidenceRef),
    nextAction: result.nextAction,
    ...(result.conditionRef === undefined ? {} : { conditionRef: result.conditionRef }),
    ...(result.failureRef === undefined ? {} : { failureRef: result.failureRef }),
  };
}

function copyEntry(entry: InteractionLatestTurnEntry): InteractionLatestTurnEntry {
  switch (entry.kind) {
    case 'user-input':
      return { kind: 'user-input', content: copyRawAsset(entry.content) };
    case 'assistant-output':
      return { kind: 'assistant-output', content: copyRawAsset(entry.content) };
    case 'clarification':
      return {
        kind: 'clarification',
        question: copyRawAsset(entry.question),
        ...(entry.answer === undefined ? {} : { answer: copyRawAsset(entry.answer) }),
      };
    case 'helper-result':
      return {
        kind: 'helper-result',
        result: copyHelperResult(entry.result),
        refinedResult: copyRawAsset(entry.refinedResult),
      };
  }
}

function copyClarification(
  clarification: InteractionCurrentClarification,
): InteractionCurrentClarification {
  return {
    question: copyRawAsset(clarification.question),
    ...(clarification.answer === undefined ? {} : { answer: copyRawAsset(clarification.answer) }),
  };
}

function projectCheckpoint(
  checkpoint: InteractionSemanticCheckpoint,
): InteractionSemanticHistoryEntry {
  return {
    kind: 'semantic-checkpoint',
    organId: copyOrganId(checkpoint.organId),
    interactionScopeId: checkpoint.interactionScopeId,
    interactionId: checkpoint.interactionId,
    inputRevision: checkpoint.inputRevision,
    turnId: checkpoint.turnId,
    committedAt: checkpoint.committedAt,
    claims: checkpoint.claims.map(copyClaim),
    constraints: checkpoint.constraints.map(copyClaim),
    evidenceRefs: checkpoint.evidenceRefs.map(copyEvidenceRef),
    semanticAssetRefs: checkpoint.semanticAssetRefs.map(copyEvidenceRef),
  };
}

function sameInteractionScope(
  identity: InteractionTurnIdentity,
  candidate: { readonly organId: OrganId; readonly interactionScopeId: string; readonly interactionId: string },
): boolean {
  return sameOrganId(identity.organId, candidate.organId)
    && identity.interactionScopeId === candidate.interactionScopeId
    && identity.interactionId === candidate.interactionId;
}

/**
 * Broader historical scope used only to accept committed history. Prior turns in
 * the same interaction scope may come from a different interaction or revision;
 * the current turn still requires the exact full identity.
 */
function sameHistoricalScope(
  identity: InteractionTurnIdentity,
  candidate: { readonly organId: OrganId; readonly interactionScopeId: string },
): boolean {
  return sameOrganId(identity.organId, candidate.organId)
    && identity.interactionScopeId === candidate.interactionScopeId;
}

function assertInput(input: InteractionSemanticContextInput): void {
  validateInteractionTurnIdentity(input.identity);

  input.semanticHistory.forEach((checkpoint, index) => {
    validateInteractionSemanticCheckpoint(checkpoint);
    if (!sameHistoricalScope(input.identity, checkpoint)) {
      throw new InteractionSemanticContextError(
        `semantic history[${index}] scope does not match the explicit interaction`,
      );
    }
    if (checkpoint.turnId === input.identity.turnId) {
      throw new InteractionSemanticContextError(
        `semantic history[${index}] is the current turn, not committed history`,
      );
    }
  });

  validateInteractionLatestTurn(input.latestTurn);
  if (!sameInteractionScope(input.identity, input.latestTurn)) {
    throw new InteractionSemanticContextError(
      'latest interaction turn scope does not match the explicit interaction',
    );
  }
  if (
    input.latestTurn.inputRevision !== input.identity.inputRevision
    || input.latestTurn.turnId !== input.identity.turnId
  ) {
    throw new InteractionSemanticContextError(
      'latest interaction turn identity does not match the explicit interaction',
    );
  }

  // Reuse the T1 latest-turn validator so RawAsset, view, and organ-scope rules
  // keep a single owner instead of a second copy here.
  validateInteractionLatestTurn({
    organId: input.identity.organId,
    interactionScopeId: input.identity.interactionScopeId,
    interactionId: input.identity.interactionId,
    inputRevision: input.identity.inputRevision,
    turnId: input.identity.turnId,
    entries: [
      { kind: 'user-input', content: input.currentInput },
      ...input.clarifications.map((clarification): InteractionLatestTurnEntry => ({
        kind: 'clarification',
        question: clarification.question,
        ...(clarification.answer === undefined ? {} : { answer: clarification.answer }),
      })),
    ],
  });
}

export function buildInteractionSemanticContext(
  input: InteractionSemanticContextInput,
): InteractionSemanticContext {
  assertInput(input);
  return {
    kind: 'interaction-semantic-context',
    identity: copyTurnIdentity(input.identity),
    history: input.semanticHistory.map(projectCheckpoint),
    latestTurn: input.latestTurn.entries.map(copyEntry),
    currentInput: copyRawAsset(input.currentInput),
    clarifications: input.clarifications.map(copyClarification),
  };
}

function sameInteractionTurnIdentity(
  left: InteractionTurnIdentity,
  right: InteractionTurnIdentity,
): boolean {
  return left.organId.scope === right.organId.scope
    && left.organId.value === right.organId.value
    && left.interactionScopeId === right.interactionScopeId
    && left.interactionId === right.interactionId
    && left.inputRevision === right.inputRevision
    && left.turnId === right.turnId;
}

/**
 * Select the committed semantic history for the next turn in one interaction
 * scope, and refuse to advance over an unclosed prior parent turn.
 *
 * A turn that opened its durable raw history without a committed semantic
 * checkpoint still owns its recovery responsibility, so history selection fails
 * explicitly instead of silently dropping it. One exception is an interrupted
 * turn that was explicitly discharged as unrecoverable: it can never produce
 * history or output, so it neither blocks the next turn nor enters history.
 * History may cross interactionId and inputRevision inside the same organ and
 * interactionScopeId; the current turn itself is excluded, so a retry of the
 * same identity does not read its own partial history back.
 */
export async function prepareScopeSemanticHistory(input: {
  readonly activeTurn: InteractionTurnIdentity;
  readonly parentJournal: Pick<
    InteractionParentOpenedTurnScopeReadPort,
    'readScopeOpenedTurns' | 'readScopeAbandonedTurns' | 'readScopeParseFailures'
  >;
  readonly checkpointJournal: Pick<
    InteractionSemanticCheckpointJournalPort,
    'readScopeSemanticCheckpoints'
  >;
}): Promise<readonly InteractionSemanticCheckpoint[]> {
  validateInteractionTurnIdentity(input.activeTurn);
  const scope = {
    organId: input.activeTurn.organId,
    interactionScopeId: input.activeTurn.interactionScopeId,
  };
  const commits = await input.checkpointJournal.readScopeSemanticCheckpoints(scope);
  const openedTurns = await input.parentJournal.readScopeOpenedTurns(scope);
  const abandonedTurns = await input.parentJournal.readScopeAbandonedTurns(scope);
  const parseFailures = await input.parentJournal.readScopeParseFailures(scope);
  const abandoned = new Set(abandonedTurns.map(({ fact }) => interactionTurnKey(fact.turn)));
  // A turn closed as unparseable is durable history-free closure too: its
  // terminal output exists but yielded no decision, so it neither blocks the
  // next turn nor feeds it a claim it never made.
  const unusable = new Set(parseFailures.map(({ fact }) => interactionTurnKey(fact.turn)));
  const committed = [...commits].sort((left, right) => left.commit.journalSeq - right.commit.journalSeq);
  const history: InteractionSemanticCheckpoint[] = [];
  for (const opened of openedTurns) {
    // The active turn and any turn opened after it are not committed history.
    if (sameInteractionTurnIdentity(opened.fact.turn, input.activeTurn)) break;
    const entry = committed.find((candidate) =>
      sameInteractionTurnIdentity(candidate.checkpoint, opened.fact.turn));
    if (entry === undefined) {
      // A discharged interrupted turn left no output and no history. It is
      // already closed by its own durable fact, so it neither blocks nor feeds
      // the next turn.
      if (abandoned.has(interactionTurnKey(opened.fact.turn))) continue;
      // A turn whose real terminal output could not be parsed into any decision
      // is closed by its own durable fact in the same way: it holds no claim, so
      // it must not block the next turn.
      if (unusable.has(interactionTurnKey(opened.fact.turn))) continue;
      throw new ContractError(
        `unclosed interaction parent turn ${opened.fact.turn.turnId} requires recovery or semantic closure before opening ${input.activeTurn.turnId}`,
      );
    }
    history.push(entry.checkpoint);
  }
  return history;
}

function interactionTurnKey(turn: InteractionTurnIdentity): string {
  return [
    turn.organId.scope,
    turn.organId.value,
    turn.interactionScopeId,
    turn.interactionId,
    turn.inputRevision,
    turn.turnId,
  ].join('\u0000');
}
