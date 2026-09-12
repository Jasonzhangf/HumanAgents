import type {
  RequirementEnvelope,
  RequirementIntent,
  TaskId,
} from '../../../contracts/src/index.js';
import { ExplicitIntakeError } from './errors.js';
import { RequirementInbox } from './requirement-inbox.js';

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
  readonly owner: 'explicit-intake' | 'human' | 'runtime-coordinator';
  readonly nextAction: string;
  readonly condition?: string;
  readonly reason?: string;
  readonly draft?: RequirementDraft;
  readonly history: readonly ExplicitInteractionState[];
}

export interface ConfirmRequirementDraft {
  readonly draftId: string;
  readonly requirementId: string;
  readonly inputRevision: number;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly payloadRef: string;
}

export interface StatusQueryReceipt {
  readonly kind: 'status-only';
  readonly interactionId: InteractionId;
  readonly owner: 'explicit-intake';
  readonly nextAction: 'present-status';
}

interface InteractionRecord {
  readonly interactionId: InteractionId;
  readonly sourceRef: string;
  state: ExplicitInteractionState;
  owner: 'explicit-intake' | 'human' | 'runtime-coordinator';
  nextAction: string;
  condition?: string;
  reason?: string;
  draft?: RequirementDraft;
  readonly history: ExplicitInteractionState[];
}

export class ExplicitIntake {
  private readonly interactions = new Map<InteractionId, InteractionRecord>();
  private readonly draftInteractions = new Map<string, InteractionId>();
  private nextInteractionSeq = 1;
  private nextDraftSeq = 1;

  constructor(private readonly inbox: RequirementInbox) {}

  async receive(input: ExplicitInput): Promise<InteractionId> {
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

    const interactionId = `interaction-${this.nextInteractionSeq}`;
    this.nextInteractionSeq += 1;
    this.interactions.set(interactionId, {
      interactionId,
      sourceRef: input.sourceRef,
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
      owner: interaction.owner,
      nextAction: interaction.nextAction,
      condition: interaction.condition,
      reason: interaction.reason,
      draft: interaction.draft,
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

  async confirm(input: ConfirmRequirementDraft): Promise<RequirementEnvelope> {
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

    const interaction = this.requireState(interactionId, ['awaiting-confirmation'], 'confirm requirement');
    if (!input.confirmedBy || !input.confirmedBy.trim() || !input.confirmedAt || !Number.isFinite(Date.parse(input.confirmedAt))) {
      throw new ExplicitIntakeError(
        'explicit-confirmation-required',
        'confirmedBy and confirmedAt are required',
        {
          owner: 'human',
          nextAction: 'provide-explicit-confirmation',
          condition: 'explicit-user-confirmation',
        },
      );
    }

    const draft = interaction.draft;
    if (!draft) {
      throw this.invalidState('confirm requirement', 'requirement draft is missing', 'return-to-matching');
    }

    const envelope: RequirementEnvelope = {
      requirementId: input.requirementId,
      draftId: draft.draftId,
      inputRevision: input.inputRevision,
      intent: draft.proposedIntent,
      taskRef: draft.matchedTasks.find((task) => task.relation === 'current')?.taskId,
      normalizedInput: draft.normalizedInput,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.confirmedAt,
      fifoSeq: this.inbox.expectedNextFifoSeq,
      payloadRef: input.payloadRef,
    };

    this.inbox.markConfirmed(envelope);
    await this.inbox.append(envelope);
    this.transition(interaction, 'confirmed', 'explicit-intake', 'dispatch-confirmed-requirement');
    this.transition(interaction, 'dispatched', 'runtime-coordinator', 'consume-inbox');
    return envelope;
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
