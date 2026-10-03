import { createHash } from 'node:crypto';
import type {
  DraftConfirmation,
  DraftPreviewReceipt,
  DraftRejectClosure,
  DraftRevision,
  DraftRevisionInput,
  InteractionRequestKind,
  RequirementIntent,
  TaskId,
} from '../../../contracts/src/index.js';
import {
  canonicalJsonStringify,
  validateDraftConfirmation,
  validateDraftPreviewReceipt,
  validateDraftRejectClosure,
} from '../../../contracts/src/index.js';
import {
  assertDraftRevisionCurrent,
  createDraftRevision,
  refineDraftRevision,
} from '../../../core/src/index.js';
import { ExplicitIntakeError } from './errors.js';

const INTERACTION_REQUEST_KINDS: ReadonlySet<InteractionRequestKind> = new Set([
  'new-task-create',
  'new-task-preview',
  'existing-task-change',
  'status-query',
  'clarification',
  'refinement',
]);

const DRAFT_REQUEST_KINDS: ReadonlySet<InteractionRequestKind> = new Set([
  'new-task-preview',
  'new-task-create',
  'existing-task-change',
  'refinement',
]);

/**
 * Durable store for the explicit-intake snapshot. The host already persists the
 * same snapshot inside its `explicit-brain.state` record (`intake:
 * exportState()`), so this port is the narrow boundary a host wires to that
 * existing journal. It stores the existing ExplicitIntakeState shape; it does
 * not define a second journal format.
 */
export interface ExplicitIntakeJournalPort {
  save(state: ExplicitIntakeState): void;
  load(): ExplicitIntakeState | undefined;
}

export type InteractionId = string;
export type ExplicitInteractionState =
  | 'received'
  | 'matching'
  | 'status-checking'
  | 'awaiting-intent'
  | 'awaiting-clarification'
  | 'awaiting-confirmation'
  | 'confirmed'
  | 'dispatched'
  | 'status-only'
  | 'rejected';

export interface ExplicitInput {
  readonly sourceRef: string;
  readonly rawInput: string;
  readonly channel: 'business' | 'control';
  readonly controlCommand?: 'steer' | 'stop' | 'revoke-permission';
  /**
   * Typed creation/query identity carried from the real entry point. A
   * `new-task-preview` must never be collapsed into a generic status query;
   * only the final `new-task-create` submit authorizes a new task.
   */
  readonly requestKind?: InteractionRequestKind;
  readonly occurredAt?: string;
}

export interface MatchedTask {
  readonly taskId: TaskId;
  readonly relation: 'current' | 'related' | 'historical';
  readonly status: string;
}

export interface MatchResult {
  readonly normalizedInput: string;
  readonly matchedTasks: readonly MatchedTask[];
  readonly knownFacts: readonly string[];
}

export interface RequirementDraft {
  readonly draftId: string;
  readonly inputRevision: number;
  readonly sourceRef: string;
  readonly normalizedInput: string;
  readonly matchedTasks: readonly MatchedTask[];
  readonly knownFacts: readonly string[];
  readonly proposedIntent: RequirementIntent;
  readonly proposal: string;
  readonly decisionRefs: readonly string[];
  readonly state: ExplicitInteractionState;
}

export interface Proposal {
  readonly proposedIntent: RequirementIntent;
  readonly proposal: string;
  readonly decisionRefs?: readonly string[];
}

export interface ExplicitInteractionSnapshot {
  readonly interactionId: InteractionId;
  readonly state: ExplicitInteractionState;
  readonly sourceRef: string;
  readonly rawInput: string;
  readonly requestKind?: InteractionRequestKind;
  readonly occurredAt?: string;
  readonly owner: 'explicit-intake' | 'human' | 'runtime-coordinator';
  readonly nextAction: string;
  readonly condition?: string;
  readonly reason?: string;
  readonly reply?: string;
  readonly clarifications?: readonly ClarificationExchange[];
  readonly draft?: RequirementDraft;
  readonly revision?: DraftRevision;
  readonly preview?: DraftPreviewReceipt;
  readonly confirmations?: readonly DraftConfirmation[];
  readonly rejections?: readonly DraftRejectClosure[];
  readonly confirmation?: ConfirmedRequirementDraft;
  readonly history: readonly ExplicitInteractionState[];
}

export interface ClarificationExchange {
  readonly question: string;
  readonly answer?: string;
}

export interface ConfirmRequirementDraft {
  readonly draftId: string;
  /**
   * The interaction this confirmation is addressed to. The HTTP route carries
   * it in the path, so an addressed confirmation must name the draft that
   * interaction currently owns. It is optional only for direct in-process
   * callers that confirm a draft they already hold.
   */
  readonly interactionId?: InteractionId;
  readonly inputRevision: number;
  readonly confirmationRef: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly payloadRef: string;
}

export interface ConfirmedRequirementDraft {
  readonly interactionId: InteractionId;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly normalizedInput: string;
  readonly intent: RequirementIntent;
  readonly taskRef?: TaskId;
  readonly payloadRef: string;
  readonly confirmationRef: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

export interface StatusQueryReceipt {
  readonly kind: 'status-only';
  readonly interactionId: InteractionId;
  readonly owner: 'explicit-intake';
  readonly nextAction: 'present-status';
}

export interface ExplicitIntakeState {
  readonly nextInteractionSeq: number;
  readonly nextDraftSeq: number;
  readonly interactions: readonly ExplicitInteractionRecordState[];
}

interface ExplicitInteractionRecordState {
  readonly interactionId: InteractionId;
  readonly inputRevision: number;
  readonly sourceRef: string;
  readonly rawInput: string;
  readonly requestKind?: InteractionRequestKind;
  readonly occurredAt?: string;
  readonly state: ExplicitInteractionState;
  readonly owner: 'explicit-intake' | 'human' | 'runtime-coordinator';
  readonly nextAction: string;
  readonly condition?: string;
  readonly reason?: string;
  readonly reply?: string;
  readonly clarifications?: readonly ClarificationExchange[];
  readonly draft?: RequirementDraft;
  readonly revision?: DraftRevision;
  readonly preview?: DraftPreviewReceipt;
  readonly confirmations?: readonly DraftConfirmation[];
  readonly rejections?: readonly DraftRejectClosure[];
  readonly revisionEdits?: readonly RevisionEditRecord[];
  readonly confirmation?: ConfirmedRequirementDraft;
  readonly history: readonly ExplicitInteractionState[];
}

interface InteractionRecord {
  readonly interactionId: InteractionId;
  readonly inputRevision: number;
  readonly sourceRef: string;
  readonly rawInput: string;
  readonly requestKind?: InteractionRequestKind;
  readonly occurredAt?: string;
  state: ExplicitInteractionState;
  owner: 'explicit-intake' | 'human' | 'runtime-coordinator';
  nextAction: string;
  condition?: string;
  reason?: string;
  reply?: string;
  clarifications?: ClarificationExchange[];
  draft?: RequirementDraft;
  revision?: DraftRevision;
  preview?: DraftPreviewReceipt;
  confirmations?: DraftConfirmation[];
  rejections?: DraftRejectClosure[];
  revisionEdits?: RevisionEditRecord[];
  confirmation?: ConfirmedRequirementDraft;
  readonly history: ExplicitInteractionState[];
}

interface RevisionEditRecord {
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly revision: DraftRevision;
}

function revisionEditRequestDigest(input: DraftRevisionInput): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(input)).digest('hex')}`;
}

/**
 * Structured intent for the typed draft boundary. The real entry point (UI/API)
 * supplies this after normalization; intake turns it into an immutable
 * {@link DraftRevision} through the core invariant module.
 */
export interface DraftIntent {
  readonly goal: string;
  readonly scope: string;
  readonly constraints?: readonly string[];
  readonly deliverables?: readonly string[];
  readonly normalizedInput: string;
  readonly proposedIntent: RequirementIntent;
  readonly proposal: string;
  readonly matchedTasks?: readonly MatchedTask[];
  readonly knownFacts?: readonly string[];
  readonly decisionRefs?: readonly string[];
  readonly executionControlRef?: string;
}

export interface ConfirmDraftRevisionInput {
  readonly interactionId: InteractionId;
  readonly draftId: string;
  readonly draftRevisionVersion: number;
  readonly draftRevisionHash: string;
  readonly confirmationRef: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly payloadRef: string;
}

export interface RejectDraftInput {
  readonly interactionId: InteractionId;
  readonly reason: string;
  readonly rejectionId?: string;
  readonly closedAt?: string;
}

export class ExplicitIntake {
  private readonly interactions = new Map<InteractionId, InteractionRecord>();
  private readonly draftInteractions = new Map<string, InteractionId>();
  private nextInteractionSeq = 1;
  private nextDraftSeq = 1;

  constructor(private readonly journal?: ExplicitIntakeJournalPort) {
    const restored = journal?.load();
    if (restored) this.restoreState(restored);
  }

  exportState(): ExplicitIntakeState {
    return {
      nextInteractionSeq: this.nextInteractionSeq,
      nextDraftSeq: this.nextDraftSeq,
      interactions: [...this.interactions.values()].map((interaction) => structuredClone(interaction)),
    };
  }

  restoreState(state: ExplicitIntakeState): void {
    this.interactions.clear();
    this.draftInteractions.clear();
    this.nextInteractionSeq = state.nextInteractionSeq;
    this.nextDraftSeq = state.nextDraftSeq;
    for (const input of state.interactions) {
      const interaction = structuredClone(input) as InteractionRecord;
      this.interactions.set(interaction.interactionId, interaction);
      if (interaction.draft) this.draftInteractions.set(interaction.draft.draftId, interaction.interactionId);
      if (interaction.revision) this.draftInteractions.set(interaction.revision.draftId, interaction.interactionId);
    }
  }

  private persist(): void {
    this.journal?.save(this.exportState());
  }

  async receive(input: ExplicitInput, inputRevision = 1): Promise<InteractionId> {
    if (input.channel !== 'business') {
      throw new ExplicitIntakeError(
        'control-channel-required',
        `${input.controlCommand ?? 'control command'} must use the control channel`,
        {
          owner: 'explicit-intake',
          nextAction: 'route-to-control-channel',
          condition: 'business-channel-only',
        },
      );
    }
    if (!input.sourceRef || !input.sourceRef.trim() || !input.rawInput || !input.rawInput.trim()) {
      throw new ExplicitIntakeError(
        'input-required',
        'explicit input requires a source and raw input',
        {
          owner: 'explicit-intake',
          nextAction: 'request-complete-input',
          condition: 'non-empty-source-and-input',
        },
      );
    }
    if (!Number.isSafeInteger(inputRevision) || inputRevision < 1) {
      throw new ExplicitIntakeError(
        'input-revision-invalid',
        'explicit input revision must be a positive safe integer',
        {
          owner: 'explicit-intake',
          nextAction: 'provide-the-current-input-revision',
          condition: 'positive-input-revision',
        },
      );
    }
    if (input.requestKind !== undefined && !INTERACTION_REQUEST_KINDS.has(input.requestKind)) {
      throw new ExplicitIntakeError(
        'invalid-request-kind',
        'explicit input requestKind must be one of the typed interaction request kinds',
        {
          owner: 'explicit-intake',
          nextAction: 'provide-a-typed-request-kind',
          condition: 'typed-request-kind',
        },
      );
    }

    const interactionId = `interaction-${this.nextInteractionSeq}`;
    this.nextInteractionSeq += 1;
    this.interactions.set(interactionId, {
      interactionId,
      inputRevision,
      sourceRef: input.sourceRef,
      rawInput: input.rawInput,
      ...(input.requestKind === undefined ? {} : { requestKind: input.requestKind }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      state: 'received',
      owner: 'explicit-intake',
      nextAction: 'start-matching',
      condition: 'matching-requested',
      history: ['received'],
    });
    this.persist();
    return interactionId;
  }

  async inspect(input: InteractionId): Promise<ExplicitInteractionSnapshot> {
    const interaction = this.requireInteraction(input);
    return {
      interactionId: interaction.interactionId,
      state: interaction.state,
      sourceRef: interaction.sourceRef,
      rawInput: interaction.rawInput,
      requestKind: interaction.requestKind,
      occurredAt: interaction.occurredAt,
      owner: interaction.owner,
      nextAction: interaction.nextAction,
      condition: interaction.condition,
      reason: interaction.reason,
      reply: interaction.reply,
      clarifications: interaction.clarifications === undefined
        ? undefined
        : structuredClone(interaction.clarifications),
      draft: interaction.draft,
      revision: interaction.revision,
      preview: interaction.preview,
      confirmations: interaction.confirmations === undefined
        ? undefined
        : structuredClone(interaction.confirmations),
      rejections: interaction.rejections === undefined
        ? undefined
        : structuredClone(interaction.rejections),
      confirmation: interaction.confirmation,
      history: [...interaction.history],
    };
  }

  inputRevision(input: InteractionId): number {
    return this.requireInteraction(input).inputRevision;
  }

  async beginMatching(input: InteractionId): Promise<void> {
    const interaction = this.requireState(input, ['received'], 'begin matching');
    this.transition(interaction, 'matching', 'explicit-intake', 'inspect-candidates', 'task-match-available');
  }

  async recordMatch(input: InteractionId, result: MatchResult): Promise<void> {
    const interaction = this.requireState(input, ['matching'], 'record match');
    if (!result.normalizedInput || !result.normalizedInput.trim()) {
      throw this.invalidState('record match', 'normalized input is required', 'request-normalized-input');
    }
    interaction.draft = {
      draftId: `draft-${this.nextDraftSeq}`,
      inputRevision: interaction.inputRevision,
      sourceRef: interaction.sourceRef,
      normalizedInput: result.normalizedInput,
      matchedTasks: [...result.matchedTasks],
      knownFacts: [...result.knownFacts],
      proposedIntent: 'create',
      proposal: '',
      decisionRefs: [],
      state: 'awaiting-intent',
    };
    this.nextDraftSeq += 1;
    this.draftInteractions.set(interaction.draft.draftId, input);
    this.transition(interaction, 'awaiting-intent', 'explicit-intake', 'ask-intent', 'user-intent-choice');
  }

  async beginStatusCheck(input: InteractionId): Promise<void> {
    const interaction = this.requireState(input, ['matching', 'awaiting-intent'], 'begin status check');
    this.transition(interaction, 'status-checking', 'explicit-intake', 'read-status', 'status-projection-available');
  }

  async completeStatusOnly(input: InteractionId, answer?: string): Promise<StatusQueryReceipt> {
    const interaction = this.requireState(input, ['status-checking'], 'complete status query');
    if (answer !== undefined) {
      if (!answer.trim()) throw this.invalidState('complete status query', 'status answer is required', 'provide-status-answer');
      interaction.reply = answer;
    }
    this.transition(interaction, 'status-only', 'explicit-intake', 'present-status');
    return {
      kind: 'status-only',
      interactionId: interaction.interactionId,
      owner: 'explicit-intake',
      nextAction: 'present-status',
    };
  }

  async requestClarification(input: InteractionId, question: string): Promise<void> {
    const interaction = this.requireState(input, ['matching'], 'request clarification');
    if (!question || !question.trim()) {
      throw this.invalidState('request clarification', 'clarification question is required', 'provide-clarification-question');
    }
    interaction.reply = question;
    interaction.clarifications = [...(interaction.clarifications ?? []), { question }];
    this.transition(interaction, 'awaiting-clarification', 'human', 'provide-clarification', 'clarification-required');
  }

  async answerClarification(input: InteractionId, answer: string): Promise<void> {
    const interaction = this.requireState(input, ['awaiting-clarification'], 'answer clarification');
    if (!answer || !answer.trim()) {
      throw this.invalidState('answer clarification', 'clarification answer is required', 'provide-clarification');
    }
    const clarifications = interaction.clarifications ?? [];
    const current = clarifications.at(-1);
    if (!current || current.answer !== undefined) {
      throw this.invalidState('answer clarification', 'clarification question is missing', 'return-to-matching');
    }
    interaction.clarifications = [
      ...clarifications.slice(0, -1),
      { question: current.question, answer },
    ];
    interaction.reply = undefined;
    this.transition(interaction, 'matching', 'explicit-intake', 'interpret-clarification', 'clarification-provided');
  }

  async propose(input: InteractionId, proposal: Proposal): Promise<void> {
    const interaction = this.requireState(input, ['awaiting-intent', 'awaiting-confirmation'], 'propose requirement');
    if (!proposal.proposal || !proposal.proposal.trim()) {
      throw this.invalidState('propose requirement', 'proposal is required', 'request-proposal');
    }
    const draft = interaction.draft;
    if (!draft) {
      throw this.invalidState('propose requirement', 'requirement draft is missing', 'return-to-matching');
    }
    interaction.draft = {
      ...draft,
      proposedIntent: proposal.proposedIntent,
      proposal: proposal.proposal,
      decisionRefs: [...(proposal.decisionRefs ?? [])],
      state: 'awaiting-confirmation',
    };
    this.transition(interaction, 'awaiting-confirmation', 'human', 'confirm-or-revise', 'explicit-user-confirmation');
  }

  async revise(input: InteractionId, proposal: Proposal): Promise<InteractionId> {
    const interaction = this.requireState(input, ['awaiting-confirmation'], 'revise requirement');
    await this.propose(interaction.interactionId, proposal);
    return interaction.interactionId;
  }

  async reject(input: InteractionId, reason: string): Promise<void> {
    const interaction = this.requireInteraction(input);
    if (interaction.state === 'confirmed' || interaction.state === 'dispatched' || interaction.state === 'status-only' || interaction.state === 'rejected') {
      throw this.invalidState('reject requirement', `cannot reject from ${interaction.state}`, 'inspect-terminal-interaction');
    }
    if (!reason || !reason.trim()) {
      throw this.invalidState('reject requirement', 'rejection reason is required', 'record-rejection-reason');
    }
    interaction.reason = reason;
    this.transition(interaction, 'rejected', 'explicit-intake', 'close-interaction', 'rejection-recorded');
  }

  async prepareConfirmation(input: ConfirmRequirementDraft): Promise<ConfirmedRequirementDraft> {
    const interactionId = this.draftInteractions.get(input.draftId);
    if (!interactionId) {
      throw new ExplicitIntakeError(
        'draft-not-found',
        'confirmed draft does not exist',
        {
          owner: 'explicit-intake',
          nextAction: 'return-to-matching',
          condition: 'existing-draft',
        },
      );
    }

    // A route that addresses one interaction while carrying another
    // interaction's draft must fail closed, not silently confirm the foreign
    // interaction and leave the addressed one untouched.
    if (input.interactionId !== undefined && input.interactionId !== interactionId) {
      throw new ExplicitIntakeError(
        'confirmation-stale',
        'confirmed draft does not belong to this interaction',
        {
          owner: 'human',
          nextAction: 'reconfirm-the-current-draft-revision',
          condition: `interaction-${interactionId}-owns-draft`,
        },
      );
    }

    const interaction = this.requireInteraction(interactionId);
    if (interaction.revision) {
      throw new ExplicitIntakeError(
        'typed-draft-final-submit-required',
        'typed draft revisions must use exact revision confirmation and final submission',
        {
          owner: 'human',
          nextAction: 'confirm-and-submit-the-exact-draft-revision',
          condition: 'typed-draft-final-submit-required',
        },
      );
    }
    const draft = interaction.draft;
    if (!draft) {
      throw this.invalidState('confirm requirement', 'requirement draft is missing', 'return-to-matching');
    }
    // The draft must still be the owning interaction's current draft: a
    // superseded draft from an earlier matching round is not confirmable even
    // when the route names the right interaction.
    if (draft.draftId !== input.draftId) {
      throw new ExplicitIntakeError(
        'confirmation-stale',
        'confirmed draft is no longer the current draft of this interaction',
        {
          owner: 'human',
          nextAction: 'reconfirm-the-current-draft-revision',
          condition: 'current-draft-of-interaction',
        },
      );
    }
    if (input.inputRevision !== draft.inputRevision) {
      throw new ExplicitIntakeError(
        'confirmation-stale',
        `confirmation revision ${input.inputRevision} does not match draft revision ${draft.inputRevision}`,
        {
          owner: 'human',
          nextAction: 'reconfirm-the-current-draft-revision',
          condition: `input-revision-${draft.inputRevision}`,
        },
      );
    }
    if (interaction.state === 'confirmed') {
      const confirmation = interaction.confirmation;
      if (confirmation
        && confirmation.confirmationRef === input.confirmationRef
        && confirmation.confirmedBy === input.confirmedBy
        && confirmation.confirmedAt === input.confirmedAt
        && confirmation.payloadRef === input.payloadRef) {
        return structuredClone(confirmation);
      }
      throw new ExplicitIntakeError(
        'confirmation-stale',
        'confirmed requirement does not match the original confirmation',
        {
          owner: 'human',
          nextAction: 'inspect-the-confirmed-requirement',
          condition: 'same-confirmation-identity',
        },
      );
    }
    if (interaction.state !== 'awaiting-confirmation') {
      throw this.invalidState('confirm requirement', `cannot confirm requirement from ${interaction.state}`, 'inspect-interaction-state');
    }
    if (!input.confirmationRef || !input.confirmationRef.trim()
      || !input.confirmedBy || !input.confirmedBy.trim()
      || !input.confirmedAt || !Number.isFinite(Date.parse(input.confirmedAt))) {
      throw new ExplicitIntakeError(
        'explicit-confirmation-required',
        'confirmationRef, confirmedBy, and confirmedAt are required',
        {
          owner: 'human',
          nextAction: 'provide-explicit-confirmation',
          condition: 'explicit-user-confirmation',
        },
      );
    }

    const confirmation: ConfirmedRequirementDraft = {
      interactionId,
      draftId: draft.draftId,
      inputRevision: input.inputRevision,
      normalizedInput: draft.normalizedInput,
      intent: draft.proposedIntent,
      taskRef: draft.matchedTasks.find((task) => task.relation === 'current')?.taskId,
      payloadRef: input.payloadRef,
      confirmationRef: input.confirmationRef,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.confirmedAt,
    };
    interaction.confirmation = confirmation;
    this.transition(interaction, 'confirmed', 'explicit-intake', 'dispatch-confirmed-requirement');
    return structuredClone(confirmation);
  }

  async markDispatched(interactionId: InteractionId): Promise<void> {
    const interaction = this.requireState(interactionId, ['confirmed'], 'mark requirement dispatched');
    this.transition(interaction, 'dispatched', 'runtime-coordinator', 'consume-inbox');
  }

  async markDraftDispatched(draftId: string): Promise<void> {
    const interactionId = this.draftInteractions.get(draftId);
    if (!interactionId) {
      throw new ExplicitIntakeError(
        'draft-not-found',
        'dispatched draft does not exist',
        {
          owner: 'explicit-intake',
          nextAction: 'inspect-interaction-state',
          condition: 'existing-draft',
        },
      );
    }
    const interaction = this.requireInteraction(interactionId);
    if (interaction.state === 'dispatched') return;
    await this.markDispatched(interactionId);
  }

  /**
   * The current immutable draft revision, or undefined when this interaction
   * has no typed draft (e.g. a plain status query).
   */
  currentDraftRevision(interactionId: InteractionId): DraftRevision | undefined {
    const revision = this.requireInteraction(interactionId).revision;
    return revision === undefined ? undefined : structuredClone(revision);
  }

  /**
   * Create the first reviewable revision of a new-task preview. This is not an
   * authorization point: the returned receipt is always `authorized: false`,
   * nothing enters the requirement inbox, and only the final
   * `new-task-create` submit may dispatch.
   */
  async createDraft(interactionId: InteractionId, intent: DraftIntent): Promise<DraftPreviewReceipt> {
    const interaction = this.requireInteraction(interactionId);
    this.requireDraftRequestKind(interaction, 'create draft');
    if (interaction.revision) {
      throw new ExplicitIntakeError(
        'draft-already-created',
        'interaction already owns a draft revision',
        {
          owner: 'explicit-intake',
          nextAction: 'refine-the-existing-draft',
          condition: 'single-draft-per-interaction',
        },
      );
    }
    if (interaction.confirmation) {
      throw new ExplicitIntakeError(
        'draft-confirmation-already-prepared',
        'cannot create a typed draft after a legacy confirmation was prepared',
        {
          owner: 'explicit-intake',
          nextAction: 'inspect-the-confirmed-requirement',
          condition: 'unconfirmed-interaction',
        },
      );
    }
    if (!intent.goal.trim() || !intent.scope.trim() || !intent.normalizedInput.trim() || !intent.proposal.trim()) {
      throw new ExplicitIntakeError(
        'draft-intent-incomplete',
        'draft intent requires goal, scope, normalizedInput, and proposal',
        {
          owner: 'explicit-intake',
          nextAction: 'provide-the-complete-normalized-intent',
          condition: 'complete-draft-intent',
        },
      );
    }
    const matchedTasks = [...(intent.matchedTasks ?? [])];
    const revision = createDraftRevision({
      draftId: `draft-${this.nextDraftSeq}`,
      inputRevision: interaction.inputRevision,
      goal: intent.goal,
      scope: intent.scope,
      constraints: intent.constraints,
      deliverables: intent.deliverables,
      normalizedInput: intent.normalizedInput,
      proposedIntent: intent.proposedIntent,
      proposal: intent.proposal,
      matchedTasks: matchedTasks.map((task) => task.taskId.value),
      knownFacts: intent.knownFacts,
      decisionRefs: intent.decisionRefs,
      executionControlRef: intent.executionControlRef,
      immutableOriginalRef: `raw-input:${interaction.interactionId}:${interaction.inputRevision}`,
    });
    const createdAt = interaction.occurredAt ?? new Date().toISOString();
    const preview: DraftPreviewReceipt = {
      previewId: `preview:${revision.draftId}:${revision.revisionVersion}`,
      interactionId: interaction.interactionId,
      draftId: revision.draftId,
      revisionVersion: revision.revisionVersion,
      revisionHash: revision.revisionHash,
      createdAt,
      authorized: false,
      context: {
        requestKind: 'new-task-preview',
        interactionId: interaction.interactionId,
        inputRevision: interaction.inputRevision,
        sourceRef: interaction.sourceRef,
        channelId: 'explicit-intake',
        createdAt,
        authorized: false,
      },
    };
    validateDraftPreviewReceipt(preview);
    this.transition(
      interaction,
      'awaiting-confirmation',
      'human',
      'edit-refine-confirm-or-reject',
      'explicit-user-confirmation',
      (candidate) => {
        this.nextDraftSeq += 1;
        candidate.revision = revision;
        candidate.revisionEdits = [];
        candidate.confirmations = [];
        candidate.rejections = [];
        candidate.draft = {
          draftId: revision.draftId,
          inputRevision: revision.inputRevision,
          sourceRef: candidate.sourceRef,
          normalizedInput: revision.normalizedInput,
          matchedTasks,
          knownFacts: [...(intent.knownFacts ?? [])],
          proposedIntent: revision.proposedIntent,
          proposal: revision.proposal,
          decisionRefs: [...(intent.decisionRefs ?? [])],
          state: 'awaiting-intent',
        };
        this.draftInteractions.set(revision.draftId, candidate.interactionId);
        candidate.preview = preview;
      },
    );
    return structuredClone(preview);
  }

  /**
   * Apply a typed edit/refinement to the current revision. A stale base
   * version/hash is rejected by the core invariant and the current revision is
   * left untouched, so the user's edit is preserved for inspection.
   */
  async refineDraft(interactionId: InteractionId, input: DraftRevisionInput): Promise<DraftRevision> {
    const interaction = this.requireInteraction(interactionId);
    const revision = interaction.revision;
    if (!revision) {
      throw new ExplicitIntakeError(
        'draft-not-found',
        'interaction has no draft revision to refine',
        {
          owner: 'explicit-intake',
          nextAction: 'create-the-draft-first',
          condition: 'existing-draft-revision',
        },
      );
    }
    if (interaction.state === 'confirmed' || interaction.state === 'dispatched' || interaction.state === 'rejected') {
      throw new ExplicitIntakeError(
        'draft-not-editable',
        `cannot refine a draft from ${interaction.state}`,
        {
          owner: 'explicit-intake',
          nextAction: 'inspect-interaction-state',
          condition: 'editable-draft',
        },
      );
    }
    const requestDigest = revisionEditRequestDigest(input);
    const replayed = (interaction.revisionEdits ?? []).find((entry) => entry.idempotencyKey === input.idempotencyKey);
    if (replayed) {
      if (replayed.requestDigest !== requestDigest) {
        throw new ExplicitIntakeError(
          'idempotency-conflict',
          'draft refinement idempotency key was reused with different content',
          {
            owner: 'explicit-intake',
            nextAction: 'use-a-new-idempotency-key',
            condition: 'same-complete-refinement-request',
          },
        );
      }
      return structuredClone(replayed.revision);
    }

    const next = refineDraftRevision(revision, input);
    this.persistMutation(() => {
      interaction.revisionEdits = [
        ...(interaction.revisionEdits ?? []),
        { idempotencyKey: input.idempotencyKey, requestDigest, revision: next },
      ];
      interaction.revision = next;
      if (interaction.draft) {
        interaction.draft = {
          ...interaction.draft,
          normalizedInput: next.normalizedInput,
          proposedIntent: next.proposedIntent,
          proposal: next.proposal,
          knownFacts: [...next.knownFacts],
        };
      }
    });
    return structuredClone(next);
  }

  /**
   * Confirm the exact current revision. The confirmation binds the revision
   * version and hash; an old confirmation can never authorize a newer edit.
   * Confirming is not dispatching — the final submit does that.
   */
  async confirmDraftRevision(input: ConfirmDraftRevisionInput): Promise<DraftConfirmation> {
    const interaction = this.requireInteraction(input.interactionId);
    const revision = interaction.revision;
    if (!revision || revision.draftId !== input.draftId) {
      throw new ExplicitIntakeError(
        'draft-not-found',
        'confirmed draft does not exist on this interaction',
        {
          owner: 'explicit-intake',
          nextAction: 'inspect-interaction-state',
          condition: 'existing-draft-revision',
        },
      );
    }
    assertDraftRevisionCurrent(revision, {
      revisionVersion: input.draftRevisionVersion,
      revisionHash: input.draftRevisionHash,
    });
    if (!input.confirmationRef.trim() || !input.confirmedBy.trim() || !Number.isFinite(Date.parse(input.confirmedAt))) {
      throw new ExplicitIntakeError(
        'explicit-confirmation-required',
        'confirmationRef, confirmedBy, and confirmedAt are required',
        {
          owner: 'human',
          nextAction: 'provide-explicit-confirmation',
          condition: 'explicit-user-confirmation',
        },
      );
    }
    const existing = (interaction.confirmations ?? []).find((entry) => entry.confirmationRef === input.confirmationRef);
    if (existing) {
      if (existing.confirmedBy === input.confirmedBy
        && existing.confirmedAt === input.confirmedAt
        && existing.payloadRef === input.payloadRef
        && existing.draftRevisionHash === revision.revisionHash) {
        return structuredClone(existing);
      }
      throw new ExplicitIntakeError(
        'confirmation-stale',
        'confirmation reference was reused with different content',
        {
          owner: 'human',
          nextAction: 'reconfirm-the-current-draft-revision',
          condition: 'same-confirmation-identity',
        },
      );
    }
    if (interaction.state === 'confirmed') {
      throw new ExplicitIntakeError(
        'confirmation-stale',
        'draft revision already has a different confirmation',
        {
          owner: 'human',
          nextAction: 'reconfirm-the-current-draft-revision',
          condition: 'same-confirmation-identity',
        },
      );
    }
    if (interaction.state === 'dispatched' || interaction.state === 'rejected') {
      throw new ExplicitIntakeError(
        'draft-not-confirmable',
        `cannot confirm a draft from ${interaction.state}`,
        {
          owner: 'explicit-intake',
          nextAction: 'inspect-interaction-state',
          condition: 'confirmable-draft',
        },
      );
    }
    const confirmation: DraftConfirmation = {
      confirmationRef: input.confirmationRef,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.confirmedAt,
      payloadRef: input.payloadRef,
      draftId: revision.draftId,
      draftRevisionVersion: revision.revisionVersion,
      draftRevisionHash: revision.revisionHash,
      interactionId: interaction.interactionId,
    };
    validateDraftConfirmation(confirmation);
    this.transition(interaction, 'confirmed', 'human', 'submit-final-create', undefined, (candidate) => {
      candidate.confirmations = [...(candidate.confirmations ?? []), confirmation];
      candidate.revision = { ...revision, state: 'confirmed' };
      candidate.confirmation = {
        interactionId: candidate.interactionId,
        draftId: revision.draftId,
        inputRevision: revision.inputRevision,
        normalizedInput: revision.normalizedInput,
        intent: revision.proposedIntent,
        taskRef: candidate.draft?.matchedTasks.find((task) => task.relation === 'current')?.taskId,
        payloadRef: input.payloadRef,
        confirmationRef: input.confirmationRef,
        confirmedBy: input.confirmedBy,
        confirmedAt: input.confirmedAt,
      };
    });
    return structuredClone(confirmation);
  }

  /**
   * Formal reject/closure. The closure is durable and the draft never enters
   * the requirement inbox; a rejected draft cannot later be confirmed.
   */
  async rejectDraft(input: RejectDraftInput): Promise<DraftRejectClosure> {
    const interaction = this.requireInteraction(input.interactionId);
    const revision = interaction.revision;
    if (!revision) {
      throw new ExplicitIntakeError(
        'draft-not-found',
        'interaction has no draft revision to reject',
        {
          owner: 'explicit-intake',
          nextAction: 'create-the-draft-first',
          condition: 'existing-draft-revision',
        },
      );
    }
    if (interaction.state === 'dispatched' || revision.state === 'submitted') {
      throw new ExplicitIntakeError(
        'draft-not-rejectable',
        'cannot reject a submitted draft',
        {
          owner: 'explicit-intake',
          nextAction: 'inspect-interaction-state',
          condition: 'unsubmitted-draft',
        },
      );
    }
    if (!input.reason.trim()) {
      throw new ExplicitIntakeError(
        'rejection-reason-required',
        'rejection reason is required',
        {
          owner: 'human',
          nextAction: 'record-rejection-reason',
          condition: 'explicit-rejection-reason',
        },
      );
    }
    const rejectionId = input.rejectionId ?? `rejection:${revision.draftId}:${revision.revisionVersion}`;
    const existing = (interaction.rejections ?? []).find((entry) => entry.rejectionId === rejectionId);
    if (existing) {
      if (existing.reason === input.reason
        && existing.draftId === revision.draftId
        && existing.draftRevisionVersion === revision.revisionVersion
        && existing.draftRevisionHash === revision.revisionHash
        && (input.closedAt === undefined || existing.closedAt === input.closedAt)) {
        return structuredClone(existing);
      }
      throw new ExplicitIntakeError(
        'rejection-conflict',
        'rejection reference was reused with different content',
        {
          owner: 'human',
          nextAction: 'inspect-the-recorded-rejection',
          condition: 'same-rejection-identity',
        },
      );
    }
    const closure: DraftRejectClosure = {
      rejectionId,
      reason: input.reason,
      closedAt: input.closedAt ?? new Date().toISOString(),
      durable: true,
      draftId: revision.draftId,
      draftRevisionVersion: revision.revisionVersion,
      draftRevisionHash: revision.revisionHash,
    };
    validateDraftRejectClosure(closure);
    if (interaction.state === 'rejected') {
      throw new ExplicitIntakeError(
        'draft-not-rejectable',
        'draft already has a different rejection closure',
        {
          owner: 'explicit-intake',
          nextAction: 'inspect-interaction-state',
          condition: 'single-rejection-closure',
        },
      );
    }
    this.transition(
      interaction,
      'rejected',
      'explicit-intake',
      'close-interaction',
      'rejection-recorded',
      (candidate) => {
        candidate.rejections = [...(candidate.rejections ?? []), closure];
        candidate.revision = { ...revision, state: 'rejected' };
        candidate.reason = input.reason;
      },
    );
    return structuredClone(closure);
  }

  /**
   * Mark the interaction's revision as submitted after the single authorized
   * dispatch. Idempotent: repeated calls keep the same terminal state.
   */
  async markRevisionSubmitted(interactionId: InteractionId): Promise<void> {
    const interaction = this.requireInteraction(interactionId);
    if (interaction.state === 'dispatched') return;
    const revision = interaction.revision;
    if (interaction.state !== 'confirmed' || !revision || revision.state !== 'confirmed') {
      throw this.invalidState(
        'mark requirement submitted',
        `cannot mark requirement submitted from ${interaction.state}`,
        'complete-the-authorized-final-submit-first',
      );
    }
    this.transition(interaction, 'dispatched', 'runtime-coordinator', 'consume-inbox', undefined, (candidate) => {
      candidate.revision = { ...revision, state: 'submitted' };
    });
  }

  private requireDraftRequestKind(interaction: InteractionRecord, action: string): void {
    const kind = interaction.requestKind;
    if (kind === undefined || !DRAFT_REQUEST_KINDS.has(kind)) {
      throw new ExplicitIntakeError(
        'typed-request-kind-required',
        `${action} requires a typed draft requestKind`,
        {
          owner: 'explicit-intake',
          nextAction: 'provide-a-draft-request-kind',
          condition: 'new-task-preview-or-create',
        },
      );
    }
  }

  private requireInteraction(input: InteractionId): InteractionRecord {
    const interaction = this.interactions.get(input);
    if (!interaction) {
      throw new ExplicitIntakeError(
        'interaction-not-found',
        'explicit interaction does not exist',
        {
          owner: 'explicit-intake',
          nextAction: 'receive-input',
          condition: 'existing-interaction',
        },
      );
    }
    return interaction;
  }

  private requireState(input: InteractionId, allowed: readonly ExplicitInteractionState[], action: string): InteractionRecord {
    const interaction = this.requireInteraction(input);
    if (!allowed.includes(interaction.state)) {
      throw this.invalidState(action, `cannot ${action} from ${interaction.state}`, 'inspect-interaction-state');
    }
    return interaction;
  }

  private invalidState(action: string, message: string, nextAction: string): ExplicitIntakeError {
    return new ExplicitIntakeError(
      'invalid-state',
      `${action}: ${message}`,
      {
        owner: 'explicit-intake',
        nextAction,
        condition: 'valid-interaction-state',
      },
    );
  }

  private transition(
    interaction: InteractionRecord,
    state: ExplicitInteractionState,
    owner: 'explicit-intake' | 'human' | 'runtime-coordinator',
    nextAction: string,
    condition?: string,
    mutateBeforeTransition?: (interaction: InteractionRecord) => void,
  ): void {
    this.persistMutation(() => {
      mutateBeforeTransition?.(interaction);
      interaction.state = state;
      interaction.owner = owner;
      interaction.nextAction = nextAction;
      interaction.condition = condition;
      interaction.history.push(state);
      if (interaction.draft) {
        interaction.draft = { ...interaction.draft, state };
      }
    });
  }

  private persistMutation(mutate: () => void): void {
    const previous = this.exportState();
    try {
      mutate();
      this.persist();
    } catch (error) {
      this.restoreState(previous);
      throw error;
    }
  }
}
