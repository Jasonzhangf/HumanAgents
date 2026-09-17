import type {
  ChannelBinding,
  ConfirmedRequirementRevision,
  InteractionDecision,
  InteractionInput,
  NormalizedInteractionInput,
  RequirementIntent,
  RequirementSubmitArguments,
  TaskId,
  ToolIntent,
} from '../../../contracts/src/index.js';
import { validateChannelBinding } from '../../../contracts/src/index.js';
import type { RequirementEnvelope } from '../../../contracts/src/index.js';
import type { RequirementInbox } from '../intake/requirement-inbox.js';
import { stableIdentity } from './idempotency.js';

export class ExplicitBrainRouterError extends Error {
  readonly code:
    | 'channel-not-found'
    | 'channel-scope-mismatch'
    | 'automatic-event-policy-required'
    | 'confirmation-required'
    | 'confirmation-stale'
    | 'duplicate-submit';

  constructor(code: ExplicitBrainRouterError['code'], message: string) {
    super(message);
    this.name = 'ExplicitBrainRouterError';
    this.code = code;
  }
}

export interface AutomaticEventPolicy {
  readonly policyRef: string;
  readonly revision: number;
  readonly approved: true;
  readonly sourceBindingRef: string;
  readonly skillRef: string;
  readonly skillDigest: string;
  readonly idempotencyKey: string;
}

export interface AutomaticInteractionInput extends InteractionInput {
  readonly policy?: AutomaticEventPolicy;
}

export interface ChannelRoute {
  readonly channel: ChannelBinding;
  readonly normalized: NormalizedInteractionInput;
  readonly manual: boolean;
}

export interface RegisteredSkillRevision {
  readonly skillRef: string;
  readonly skillDigest: string;
}

interface AutomaticOccurrence {
  readonly inputIdentity: string;
  readonly normalized: NormalizedInteractionInput;
}

export interface RequirementDraftRevision {
  readonly interactionId: string;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly normalizedInput: string;
  readonly intent: RequirementIntent;
  readonly taskRef?: TaskId;
  readonly payloadRef: string;
}

export interface RequirementSubmitReceipt {
  readonly status: 'submitted' | 'duplicate';
  readonly requirementId: string;
  readonly draftId: string;
  readonly inputRevision: number;
}

export class ChannelRouter {
  private readonly channels = new Map<string, ChannelBinding>();
  private readonly automaticOccurrences = new Map<string, AutomaticOccurrence>();

  constructor(private readonly skillRevisions: readonly RegisteredSkillRevision[] = []) {}

  register(channel: ChannelBinding): void {
    validateChannelBinding(channel);
    const existing = this.channels.get(channel.channelId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(channel)) {
      throw new ExplicitBrainRouterError('channel-scope-mismatch', `channel already registered with different binding: ${channel.channelId}`);
    }
    this.channels.set(channel.channelId, { ...channel });
  }

  route(input: InteractionInput | AutomaticInteractionInput): ChannelRoute {
    const channel = this.channels.get(input.channelId);
    if (!channel) throw new ExplicitBrainRouterError('channel-not-found', `channel is not registered: ${input.channelId}`);
    const automatic = channel.kind !== 'user' && channel.kind !== 'manual-route';
    if (automatic) {
      const policy = (input as AutomaticInteractionInput).policy;
      if (!policy?.approved
        || !policy.policyRef.trim()
        || !Number.isSafeInteger(policy.revision)
        || policy.revision < 1
        || !policy.sourceBindingRef.trim()
        || !policy.skillRef.trim()
        || !policy.skillDigest.trim()
        || !policy.idempotencyKey.trim()) {
        throw new ExplicitBrainRouterError(
          'automatic-event-policy-required',
          'automatic event requires approved policy, revision, source binding, skill revision, and idempotency key',
        );
      }
      if (policy.skillRef !== channel.skillRef) {
        throw new ExplicitBrainRouterError(
          'automatic-event-policy-required',
          'automatic event policy skill does not match the registered channel skill',
        );
      }
      if (!this.skillRevisions.some((revision) => (
        revision.skillRef === policy.skillRef && revision.skillDigest === policy.skillDigest
      ))) {
        throw new ExplicitBrainRouterError(
          'automatic-event-policy-required',
          'automatic event policy skill revision is not registered',
        );
      }
      const occurrenceKey = `${channel.channelId}:${policy.idempotencyKey}`;
      const existing = this.automaticOccurrences.get(occurrenceKey);
      if (existing) {
        if (existing.inputIdentity !== stableIdentity(input)) {
          throw new ExplicitBrainRouterError(
            'duplicate-submit',
            `automatic event idempotency key was reused with different content: ${occurrenceKey}`,
          );
        }
        return { channel: { ...channel }, normalized: existing.normalized, manual: false };
      }
    }
    const normalized: NormalizedInteractionInput = {
      interactionId: input.interactionId,
      inputRevision: input.inputRevision,
      sourceRef: input.sourceRef,
      normalizedRef: `normalized:${input.interactionId}:${input.inputRevision}`,
      classification: classifyChannel(channel),
      skillRef: channel.skillRef,
      evidenceRefs: [input.sourceRef],
    };
    if (automatic) {
      const policy = (input as AutomaticInteractionInput).policy!;
      this.automaticOccurrences.set(`${channel.channelId}:${policy.idempotencyKey}`, {
        inputIdentity: stableIdentity(input),
        normalized,
      });
    }
    return { channel: { ...channel }, normalized, manual: !automatic };
  }
}

function classifyChannel(channel: ChannelBinding): NormalizedInteractionInput['classification'] {
  switch (channel.kind) {
    case 'user':
    case 'manual-route':
    case 'automatic-route':
      return 'business-requirement';
    case 'bug-event':
      return 'bug-event';
    case 'health-event':
      return 'health-event';
    case 'external-event':
      return 'external-event';
  }
}

export class ConfirmationLedger {
  private readonly drafts = new Map<string, RequirementDraftRevision>();
  private readonly confirmations = new Map<string, ConfirmedRequirementRevision>();

  registerDraft(draft: RequirementDraftRevision): void {
    const existing = this.drafts.get(draft.draftId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(draft)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft revision changed: ${draft.draftId}`);
    }
    this.drafts.set(draft.draftId, { ...draft });
  }

  confirm(input: ConfirmedRequirementRevision): void {
    const draft = this.drafts.get(input.draftId);
    if (!draft) throw new ExplicitBrainRouterError('confirmation-required', `draft is not registered: ${input.draftId}`);
    if (draft.interactionId !== input.interactionId || draft.inputRevision !== input.inputRevision) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'confirmation does not match the current draft revision');
    }
    if (!input.confirmationRef.trim() || !input.confirmedBy.trim() || !Number.isFinite(Date.parse(input.confirmedAt))) {
      throw new ExplicitBrainRouterError('confirmation-required', 'explicit confirmation identity is incomplete');
    }
    this.confirmations.set(input.draftId, { ...input });
  }

  assertSubmission(input: RequirementSubmitArguments): ConfirmedRequirementRevision {
    const draft = this.drafts.get(input.draftId);
    if (!draft || draft.interactionId !== input.interactionId || draft.inputRevision !== input.inputRevision) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'requirement submission is not for the current draft revision');
    }
    const confirmation = this.confirmations.get(input.draftId);
    if (!confirmation || confirmation.confirmationRef !== input.confirmationRef) {
      throw new ExplicitBrainRouterError('confirmation-required', 'requirement submission requires explicit confirmation of the current revision');
    }
    return confirmation;
  }

  requireDraft(input: RequirementSubmitArguments): RequirementDraftRevision {
    const draft = this.drafts.get(input.draftId);
    if (!draft || draft.interactionId !== input.interactionId || draft.inputRevision !== input.inputRevision) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'requirement submission is not for the current draft revision');
    }
    return { ...draft };
  }
}

export interface RequirementSubmitPort {
  submit(input: RequirementEnvelope): Promise<{ readonly requirementId: string }>;
}

export class RequirementSubmissionOwner {
  private readonly submitted = new Map<string, RequirementSubmitReceipt>();
  private readonly pending = new Map<string, {
    readonly envelope: RequirementEnvelope;
    appended: boolean;
  }>();
  private submissionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ledger: ConfirmationLedger,
    private readonly inbox: Pick<RequirementInbox, 'expectedNextFifoSeq' | 'markConfirmed' | 'append' | 'find'>,
    private readonly port: RequirementSubmitPort,
  ) {}

  async submit(input: RequirementSubmitArguments): Promise<RequirementSubmitReceipt> {
    let release!: () => void;
    const previous = this.submissionTail;
    this.submissionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.submitSerialized(input);
    } finally {
      release();
    }
  }

  private async submitSerialized(input: RequirementSubmitArguments): Promise<RequirementSubmitReceipt> {
    const confirmation = this.ledger.assertSubmission(input);
    const draft = this.ledger.requireDraft(input);
    const key = `${input.interactionId}:${input.draftId}:${input.inputRevision}`;
    const existing = this.submitted.get(key);
    if (existing) return { ...existing, status: 'duplicate' };
    const pending = this.pending.get(key);
    const durable = this.inbox.find(input.draftId);
    const envelope: RequirementEnvelope = pending?.envelope ?? durable ?? {
      requirementId: `requirement:${input.draftId}:${input.inputRevision}`,
      draftId: input.draftId,
      inputRevision: input.inputRevision,
      intent: draft.intent,
      taskRef: draft.taskRef,
      normalizedInput: draft.normalizedInput,
      confirmedBy: confirmation.confirmedBy,
      confirmedAt: confirmation.confirmedAt,
      fifoSeq: this.inbox.expectedNextFifoSeq,
      payloadRef: draft.payloadRef,
    };
    if (durable && JSON.stringify(durable) !== JSON.stringify(envelope)) {
      throw new ExplicitBrainRouterError(
        'duplicate-submit',
        `durable requirement submission differs from the current draft: ${input.draftId}`,
      );
    }
    const pendingState = pending ?? { envelope, appended: false };
    this.pending.set(key, pendingState);
    if (!pendingState.appended && !durable) {
      this.inbox.markConfirmed(envelope);
      await this.inbox.append(envelope);
      pendingState.appended = true;
    } else {
      pendingState.appended = true;
    }
    const downstream = await this.port.submit(envelope);
    if (downstream.requirementId !== envelope.requirementId) {
      throw new ExplicitBrainRouterError(
        'duplicate-submit',
        `requirement submission receipt mismatch: ${downstream.requirementId}`,
      );
    }
    const receipt: RequirementSubmitReceipt = {
      status: 'submitted',
      requirementId: envelope.requirementId,
      draftId: envelope.draftId,
      inputRevision: envelope.inputRevision,
    };
    this.submitted.set(key, receipt);
    this.pending.delete(key);
    return receipt;
  }
}

export interface ExplicitBrainDecisionHandler<TResult> {
  execute(intent: ToolIntent): Promise<TResult>;
}

export class ExplicitBrainExecutor<TResult> {
  constructor(private readonly handler: ExplicitBrainDecisionHandler<TResult>) {}

  async execute(decision: InteractionDecision): Promise<readonly TResult[]> {
    const results: TResult[] = [];
    for (const intent of decision.toolIntents) results.push(await this.handler.execute(intent));
    return results;
  }
}
