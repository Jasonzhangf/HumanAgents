import type {
  RequirementIntent,
  TaskId,
} from '../../../contracts/src/index.js';
import { ExplicitIntakeError } from './errors.js';

export type InteractionId = string;
export type ExplicitInteractionState =
  | 'received'
  | 'matching'
  | 'status-checking'
  | 'awaiting-intent'
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
  readonly owner: 'explicit-intake' | 'human' | 'runtime-coordinator';
  readonly nextAction: string;
  readonly condition?: string;
  readonly reason?: string;
  readonly draft?: RequirementDraft;
  readonly confirmation?: ConfirmedRequirementDraft;
  readonly history: readonly ExplicitInteractionState[];
}

export interface ConfirmRequirementDraft {
  readonly draftId: string;
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
  readonly state: ExplicitInteractionState;
  readonly owner: 'explicit-intake' | 'human' | 'runtime-coordinator';
  readonly nextAction: string;
  readonly condition?: string;
  readonly reason?: string;
  readonly draft?: RequirementDraft;
  readonly confirmation?: ConfirmedRequirementDraft;
  readonly history: readonly ExplicitInteractionState[];
}

interface InteractionRecord {
  readonly interactionId: InteractionId;
  readonly inputRevision: number;
  readonly sourceRef: string;
  readonly rawInput: string;
  state: ExplicitInteractionState;
  owner: 'explicit-intake' | 'human' | 'runtime-coordinator';
  nextAction: string;
  condition?: string;
  reason?: string;
  draft?: RequirementDraft;
  confirmation?: ConfirmedRequirementDraft;
  readonly history: ExplicitInteractionState[];
}

export class ExplicitIntake {
  private readonly interactions = new Map<InteractionId, InteractionRecord>();
  private readonly draftInteractions = new Map<string, InteractionId>();
  private nextInteractionSeq = 1;
  private nextDraftSeq = 1;

  constructor() {}

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
    }
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

    const interactionId = `interaction-${this.nextInteractionSeq}`;
    this.nextInteractionSeq += 1;
    this.interactions.set(interactionId, {
      interactionId,
      inputRevision,
      sourceRef: input.sourceRef,
      rawInput: input.rawInput,
      state: 'received',
      owner: 'explicit-intake',
      nextAction: 'start-matching',
      condition: 'matching-requested',
      history: ['received'],
    });
    return interactionId;
  }

  async inspect(input: InteractionId): Promise<ExplicitInteractionSnapshot> {
    const interaction = this.requireInteraction(input);
    return {
      interactionId: interaction.interactionId,
      state: interaction.state,
      sourceRef: interaction.sourceRef,
      rawInput: interaction.rawInput,
      owner: interaction.owner,
      nextAction: interaction.nextAction,
      condition: interaction.condition,
      reason: interaction.reason,
      draft: interaction.draft,
      confirmation: interaction.confirmation,
      history: [...interaction.history],
    };
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

  async completeStatusOnly(input: InteractionId): Promise<StatusQueryReceipt> {
    const interaction = this.requireState(input, ['status-checking'], 'complete status query');
    this.transition(interaction, 'status-only', 'explicit-intake', 'present-status');
    return {
      kind: 'status-only',
      interactionId: interaction.interactionId,
      owner: 'explicit-intake',
      nextAction: 'present-status',
    };
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

    const interaction = this.requireInteraction(interactionId);
    const draft = interaction.draft;
    if (!draft) {
      throw this.invalidState('confirm requirement', 'requirement draft is missing', 'return-to-matching');
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
  ): void {
    interaction.state = state;
    interaction.owner = owner;
    interaction.nextAction = nextAction;
    interaction.condition = condition;
    interaction.history.push(state);
    if (interaction.draft) {
      interaction.draft = { ...interaction.draft, state };
    }
  }
}
