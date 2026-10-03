import type {
  AuthorizedRequirement,
  ChannelBinding,
  ConfirmedRequirementRevision,
  DraftConfirmation,
  DraftRejectClosure,
  ExistingTaskChangeSubmit,
  ExecutionPolicyDefinition,
  FinalSubmit,
  InteractionDecision,
  InteractionInput,
  InteractionRequestKind,
  NormalizedInteractionInput,
  RequirementIntent,
  RequirementSubmitArguments,
  TaskId,
  ToolIntent,
} from '../../../contracts/src/index.js';
import {
  canonicalJsonStringify,
  validateAuthorizedRequirement,
  validateChannelBinding,
  validateDraftConfirmation,
  validateExistingTaskChangeSubmit,
  validateExecutionPolicyDefinition,
  validateFinalSubmit,
} from '../../../contracts/src/index.js';
import { createHash } from 'node:crypto';
import type { RequirementEnvelope } from '../../../contracts/src/index.js';
import type { ExplicitIntake, RejectDraftInput } from '../intake/explicit-intake.js';
import type { RequirementInbox } from '../intake/requirement-inbox.js';
import { stableIdentity } from './idempotency.js';

export class ExplicitBrainRouterError extends Error {
  readonly code:
    | 'channel-not-found'
    | 'channel-scope-mismatch'
    | 'automatic-event-policy-required'
    | 'confirmation-required'
    | 'confirmation-stale'
    | 'unauthorized-final-submit'
    | 'duplicate-submit'
    | 'rejection-blocked';

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
  /**
   * Exact draft revision binding. Optional for the pre-typed callers that do
   * not yet carry a revision; when present the ledger enforces it, and once a
   * revision is registered the ledger requires it on every later confirmation.
   */
  readonly draftRevisionVersion?: number;
  readonly draftRevisionHash?: string;
  readonly executionControlRef?: string;
}

/**
 * The confirmation ledger's typed entry point: the exact revision that the
 * user confirmed, plus the compiled execution control ref (a reference, never
 * the policy payload).
 */
export interface RegisteredDraftRevision {
  readonly interactionId: string;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly draftRevisionVersion: number;
  readonly draftRevisionHash: string;
  readonly normalizedInput: string;
  readonly intent: RequirementIntent;
  readonly taskRef?: TaskId;
  readonly payloadRef: string;
  readonly executionControlRef?: string;
  /**
   * The authorization the revision is allowed to receive. A revision created
   * for `existing-task-change` can never be dispatched as a new task and vice
   * versa.
   */
  readonly requestKind?: InteractionRequestKind;
}

export interface RequirementSubmitReceipt {
  readonly status: 'submitted' | 'duplicate';
  readonly requirementId: string;
  readonly draftId: string;
  readonly inputRevision: number;
}

export interface ConfirmationLedgerState {
  readonly drafts: readonly RequirementDraftRevision[];
  readonly confirmations: readonly ConfirmedRequirementRevision[];
  readonly revisions?: readonly RegisteredDraftRevision[];
  readonly revisionConfirmations?: readonly DraftConfirmation[];
  readonly closedDraftIds?: readonly string[];
  readonly finalSubmitBindings?: readonly FinalSubmitBinding[];
}

export interface PersistedSubmittedReceipt extends RequirementSubmitReceipt {
  readonly interactionId: string;
}

export interface FinalSubmitReceipt {
  readonly status: 'submitted' | 'duplicate';
  readonly requirement: AuthorizedRequirement;
}

export interface PersistedFinalSubmitReceipt {
  readonly idempotencyKey: string;
  readonly revisionKey: string;
  readonly requestDigest: string;
  readonly requestIdentity: string;
  readonly requirement: AuthorizedRequirement;
}

export interface FinalSubmitBinding {
  readonly idempotencyKey: string;
  readonly revisionKey: string;
  readonly requestDigest: string;
  readonly requestIdentity: string;
}

function finalSubmitIdentity(input: FinalSubmit | ExistingTaskChangeSubmit): string {
  return input.requestKind === 'existing-task-change'
    ? `${input.requestKind}:${input.taskId.scope}:${input.taskId.value}`
    : input.requestKind;
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
  private readonly revisions = new Map<string, RegisteredDraftRevision>();
  private readonly revisionConfirmations = new Map<string, DraftConfirmation>();
  private readonly closedDrafts = new Set<string>();
  private readonly finalSubmitBindings = new Map<string, FinalSubmitBinding>();

  registerDraft(draft: RequirementDraftRevision): void {
    if (this.closedDrafts.has(draft.draftId)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft is closed: ${draft.draftId}`);
    }
    const existing = this.drafts.get(draft.draftId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(draft)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft revision changed: ${draft.draftId}`);
    }
    // Once a typed revision is registered, the legacy draft view may not
    // diverge from it: a confirmation must be bound to the exact revision.
    const revision = this.revisions.get(draft.draftId);
    if (revision) {
      if (draft.draftRevisionVersion !== revision.draftRevisionVersion || draft.draftRevisionHash !== revision.draftRevisionHash) {
        throw new ExplicitBrainRouterError('confirmation-stale', `draft confirmation is not bound to the current revision: ${draft.draftId}`);
      }
    }
    this.drafts.set(draft.draftId, { ...draft });
  }

  confirm(input: ConfirmedRequirementRevision): void {
    if (this.closedDrafts.has(input.draftId)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft is closed: ${input.draftId}`);
    }
    const draft = this.drafts.get(input.draftId);
    if (!draft) throw new ExplicitBrainRouterError('confirmation-required', `draft is not registered: ${input.draftId}`);
    if (draft.interactionId !== input.interactionId || draft.inputRevision !== input.inputRevision) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'confirmation does not match the current draft revision');
    }
    if (!input.confirmationRef.trim() || !input.confirmedBy.trim() || !Number.isFinite(Date.parse(input.confirmedAt))) {
      throw new ExplicitBrainRouterError('confirmation-required', 'explicit confirmation identity is incomplete');
    }
    // Fail closed once a revision is registered: the confirmation must name
    // the same revision version/hash that the ledger holds.
    const revision = this.revisions.get(input.draftId);
    if (revision) {
      const bound = this.revisionConfirmations.get(input.draftId);
      if (!bound
        || bound.confirmationRef !== input.confirmationRef
        || bound.draftRevisionVersion !== revision.draftRevisionVersion
        || bound.draftRevisionHash !== revision.draftRevisionHash) {
        throw new ExplicitBrainRouterError('confirmation-stale', 'confirmation is not bound to the current draft revision');
      }
    }
    this.confirmations.set(input.draftId, { ...input });
  }

  registerRevision(input: RegisteredDraftRevision): void {
    if (this.closedDrafts.has(input.draftId)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft is closed: ${input.draftId}`);
    }
    if (!Number.isSafeInteger(input.draftRevisionVersion) || input.draftRevisionVersion < 1) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'draft revision version must be a positive integer');
    }
    if (!input.draftRevisionHash.trim()) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'draft revision hash is required');
    }
    const existing = this.revisions.get(input.draftId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(input)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft revision changed: ${input.draftId}`);
    }
    this.revisions.set(input.draftId, { ...input });
  }

  /**
   * Register the exact confirmation produced by the intake for a revision.
   * The confirmation must match the registered revision version and hash; a
   * mismatch is a typed stale rejection, never a silent overwrite.
   */
  confirmRevision(input: DraftConfirmation): void {
    validateDraftConfirmation(input);
    if (this.closedDrafts.has(input.draftId)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft is closed: ${input.draftId}`);
    }
    const revision = this.revisions.get(input.draftId);
    if (!revision) {
      throw new ExplicitBrainRouterError('confirmation-required', `draft revision is not registered: ${input.draftId}`);
    }
    if (revision.interactionId !== input.interactionId
      || revision.draftRevisionVersion !== input.draftRevisionVersion
      || revision.draftRevisionHash !== input.draftRevisionHash) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'confirmation does not match the registered draft revision');
    }
    if (revision.payloadRef !== input.payloadRef) {
      throw new ExplicitBrainRouterError(
        'confirmation-stale',
        'confirmation payload does not match the registered draft revision',
      );
    }
    const existing = this.revisionConfirmations.get(input.draftId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(input)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft confirmation changed: ${input.draftId}`);
    }
    this.revisionConfirmations.set(input.draftId, { ...input });
    // Mirror the legacy confirmation view so the shared submission owner sees
    // the same confirmed revision.
    this.drafts.set(input.draftId, {
      interactionId: revision.interactionId,
      draftId: revision.draftId,
      inputRevision: revision.inputRevision,
      normalizedInput: revision.normalizedInput,
      intent: revision.intent,
      taskRef: revision.taskRef,
      payloadRef: revision.payloadRef,
      draftRevisionVersion: revision.draftRevisionVersion,
      draftRevisionHash: revision.draftRevisionHash,
      ...(revision.executionControlRef === undefined ? {} : { executionControlRef: revision.executionControlRef }),
    });
    this.confirmations.set(input.draftId, {
      interactionId: input.interactionId,
      draftId: input.draftId,
      inputRevision: revision.inputRevision,
      confirmationRef: input.confirmationRef,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.confirmedAt,
    });
  }

  currentRevision(draftId: string): RegisteredDraftRevision | undefined {
    const revision = this.revisions.get(draftId);
    return revision ? { ...revision } : undefined;
  }

  revisionConfirmation(draftId: string): DraftConfirmation | undefined {
    const confirmation = this.revisionConfirmations.get(draftId);
    return confirmation ? { ...confirmation } : undefined;
  }

  finalSubmitBinding(idempotencyKey: string): FinalSubmitBinding | undefined {
    const binding = this.finalSubmitBindings.get(idempotencyKey);
    return binding ? { ...binding } : undefined;
  }

  finalSubmitBindingForRevision(revisionKey: string): FinalSubmitBinding | undefined {
    for (const binding of this.finalSubmitBindings.values()) {
      if (binding.revisionKey === revisionKey) return { ...binding };
    }
    return undefined;
  }

  hasFinalSubmitBinding(draftId: string): boolean {
    for (const binding of this.finalSubmitBindings.values()) {
      if (binding.revisionKey.startsWith(`${draftId}:`)) return true;
    }
    return false;
  }

  reserveFinalSubmit(binding: FinalSubmitBinding, allowRevisionReuse = false): void {
    const existingByKey = this.finalSubmitBindings.get(binding.idempotencyKey);
    if (existingByKey) {
      if (JSON.stringify(existingByKey) !== JSON.stringify(binding)) {
        throw new ExplicitBrainRouterError(
          'duplicate-submit',
          `idempotency key was reused with different content: ${binding.idempotencyKey}`,
        );
      }
      return;
    }
    const existingByRevision = [...this.finalSubmitBindings.values()]
      .find((candidate) => candidate.revisionKey === binding.revisionKey);
    if (existingByRevision) {
      if (!allowRevisionReuse || existingByRevision.idempotencyKey === binding.idempotencyKey) {
        if (JSON.stringify(existingByRevision) !== JSON.stringify(binding)) {
          throw new ExplicitBrainRouterError(
            'duplicate-submit',
            `draft revision was already submitted with a different request identity: ${binding.revisionKey}`,
          );
        }
        return;
      }
    }
    this.finalSubmitBindings.set(binding.idempotencyKey, { ...binding });
  }

  /**
   * Validate a final submit against the exact registered revision and its
   * confirmation. A new-task-create and an existing-task-change are separate
   * authorizations: a revision registered for one can never be submitted as
   * the other. Any stale hash, missing confirmation or wrong request kind is a
   * typed rejection.
   */
  assertFinalSubmit(
    input: FinalSubmit | ExistingTaskChangeSubmit,
  ): { readonly revision: RegisteredDraftRevision; readonly confirmation: DraftConfirmation } {
    if (this.closedDrafts.has(input.draftId)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft is closed: ${input.draftId}`);
    }
    if (input.requestKind === 'new-task-create') validateFinalSubmit(input);
    else validateExistingTaskChangeSubmit(input);
    const revision = this.revisions.get(input.draftId);
    if (!revision) {
      throw new ExplicitBrainRouterError('confirmation-required', `draft revision is not registered: ${input.draftId}`);
    }
    if (revision.requestKind !== undefined && revision.requestKind !== input.requestKind) {
      throw new ExplicitBrainRouterError(
        'unauthorized-final-submit',
        `draft revision is bound to ${revision.requestKind}, not ${input.requestKind}`,
      );
    }
    const intentMatches = input.requestKind === 'new-task-create'
      ? revision.intent === 'create'
      : revision.intent === 'append' || revision.intent === 'change';
    if (!intentMatches) {
      throw new ExplicitBrainRouterError(
        'unauthorized-final-submit',
        `final submit ${input.requestKind} cannot authorize revision intent ${revision.intent}`,
      );
    }
    if (revision.interactionId !== input.interactionId) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'final submit addresses a different interaction');
    }
    if (revision.inputRevision !== input.inputRevision) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'final submit addresses a different input revision');
    }
    if (revision.draftRevisionVersion !== input.draftRevisionVersion || revision.draftRevisionHash !== input.draftRevisionHash) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'final submit is not bound to the current draft revision');
    }
    const confirmation = this.revisionConfirmations.get(input.draftId);
    if (!confirmation || confirmation.confirmationRef !== input.confirmationRef) {
      throw new ExplicitBrainRouterError('confirmation-required', 'final submit requires explicit confirmation of the current revision');
    }
    if (confirmation.draftRevisionVersion !== revision.draftRevisionVersion || confirmation.draftRevisionHash !== revision.draftRevisionHash) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'confirmation is not bound to the current draft revision');
    }
    if (confirmation.payloadRef !== revision.payloadRef) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'confirmation payload is not bound to the current draft revision');
    }
    if (input.requestKind === 'existing-task-change'
      && (revision.taskRef === undefined
        || revision.taskRef.scope !== input.taskId.scope
        || revision.taskRef.value !== input.taskId.value)) {
      throw new ExplicitBrainRouterError(
        'unauthorized-final-submit',
        'final submit target does not match the confirmed draft revision',
      );
    }
    return { revision: { ...revision }, confirmation: { ...confirmation } };
  }

  closeRevision(draftId: string): void {
    this.closedDrafts.add(draftId);
    this.drafts.delete(draftId);
    this.confirmations.delete(draftId);
    this.revisions.delete(draftId);
    this.revisionConfirmations.delete(draftId);
  }

  confirmation(draftId: string): ConfirmedRequirementRevision | undefined {
    const confirmation = this.confirmations.get(draftId);
    return confirmation ? { ...confirmation } : undefined;
  }

  exportState(): ConfirmationLedgerState {
    return {
      drafts: [...this.drafts.values()].map((draft) => structuredClone(draft)),
      confirmations: [...this.confirmations.values()].map((confirmation) => structuredClone(confirmation)),
      revisions: [...this.revisions.values()].map((revision) => structuredClone(revision)),
      revisionConfirmations: [...this.revisionConfirmations.values()].map((confirmation) => structuredClone(confirmation)),
      closedDraftIds: [...this.closedDrafts],
      finalSubmitBindings: [...this.finalSubmitBindings.values()].map((binding) => structuredClone(binding)),
    };
  }

  restoreState(state: ConfirmationLedgerState): void {
    this.drafts.clear();
    this.confirmations.clear();
    this.revisions.clear();
    this.revisionConfirmations.clear();
    this.closedDrafts.clear();
    this.finalSubmitBindings.clear();
    for (const draft of state.drafts) this.drafts.set(draft.draftId, structuredClone(draft));
    for (const confirmation of state.confirmations) {
      this.confirmations.set(confirmation.draftId, structuredClone(confirmation));
    }
    for (const revision of state.revisions ?? []) this.revisions.set(revision.draftId, structuredClone(revision));
    for (const confirmation of state.revisionConfirmations ?? []) {
      this.revisionConfirmations.set(confirmation.draftId, structuredClone(confirmation));
    }
    for (const draftId of state.closedDraftIds ?? []) this.closedDrafts.add(draftId);
    for (const binding of state.finalSubmitBindings ?? []) {
      this.reserveFinalSubmit(binding, true);
    }
  }

  assertSubmission(input: RequirementSubmitArguments): ConfirmedRequirementRevision {
    if (this.closedDrafts.has(input.draftId)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft is closed: ${input.draftId}`);
    }
    if (this.revisions.has(input.draftId)) {
      throw new ExplicitBrainRouterError(
        'unauthorized-final-submit',
        'typed draft revisions must use submitFinal with an exact request kind',
      );
    }
    const draft = this.drafts.get(input.draftId);
    if (!draft || draft.interactionId !== input.interactionId || draft.inputRevision !== input.inputRevision) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'requirement submission is not for the current draft revision');
    }
    const revision = this.revisions.get(input.draftId);
    if (revision && draft.draftRevisionHash !== revision.draftRevisionHash) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'requirement submission is not for the current draft revision');
    }
    const confirmation = this.confirmations.get(input.draftId);
    if (!confirmation || confirmation.confirmationRef !== input.confirmationRef) {
      throw new ExplicitBrainRouterError('confirmation-required', 'requirement submission requires explicit confirmation of the current revision');
    }
    return confirmation;
  }

  requireDraft(input: RequirementSubmitArguments): RequirementDraftRevision {
    if (this.closedDrafts.has(input.draftId)) {
      throw new ExplicitBrainRouterError('confirmation-stale', `draft is closed: ${input.draftId}`);
    }
    const draft = this.drafts.get(input.draftId);
    if (!draft || draft.interactionId !== input.interactionId || draft.inputRevision !== input.inputRevision) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'requirement submission is not for the current draft revision');
    }
    const revision = this.revisions.get(input.draftId);
    if (revision && draft.draftRevisionHash !== revision.draftRevisionHash) {
      throw new ExplicitBrainRouterError('confirmation-stale', 'requirement submission is not for the current draft revision');
    }
    return { ...draft };
  }
}

/**
 * Close both the draft session and its confirmation ledger entry. This is the
 * public rejection boundary: after it returns, the exact revision cannot be
 * submitted even if a confirmation was issued before the rejection.
 */
export async function rejectDraftRevision(
  intake: ExplicitIntake,
  owner: RequirementSubmissionOwner,
  input: RejectDraftInput,
): Promise<DraftRejectClosure> {
  return owner.rejectDraftRevision(intake, input);
}

export interface RequirementSubmitPort {
  submit(input: RequirementEnvelope): Promise<{ readonly requirementId: string }>;
}

export class RequirementSubmissionOwner {
  private readonly submitted = new Map<string, PersistedSubmittedReceipt>();
  private readonly finalSubmissions = new Map<string, AuthorizedRequirement>();
  private readonly finalSubmissionIdentities = new Map<string, string>();
  private readonly finalIdempotency = new Map<string, { readonly requestDigest: string; readonly revisionKey: string }>();
  private readonly finalPending = new Map<string, {
    readonly envelope: RequirementEnvelope;
    persistenceAcknowledged: boolean;
    persistenceError?: unknown;
  }>();
  private readonly pending = new Map<string, {
    readonly envelope: RequirementEnvelope;
    appended: boolean;
  }>();
  private submissionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ledger: ConfirmationLedger,
    private readonly inbox: Pick<RequirementInbox, 'expectedNextFifoSeq' | 'markConfirmed' | 'append' | 'find'>,
    private readonly port: RequirementSubmitPort,
    private readonly onEnvelopeAppended?: (envelope: RequirementEnvelope) => void,
    private readonly onSubmitted?: (receipt: PersistedSubmittedReceipt) => void,
  ) {}

  submittedReceipts(): readonly PersistedSubmittedReceipt[] {
    return [...this.submitted.values()].map((receipt) => structuredClone(receipt));
  }

  restoreSubmittedReceipts(receipts: readonly PersistedSubmittedReceipt[]): void {
    this.submitted.clear();
    for (const receipt of receipts) {
      const key = `${receipt.interactionId}:${receipt.draftId}:${receipt.inputRevision}`;
      this.submitted.set(key, structuredClone(receipt));
    }
  }

  finalReceipts(): readonly PersistedFinalSubmitReceipt[] {
    return [...this.finalIdempotency.entries()].map(([idempotencyKey, entry]) => ({
      idempotencyKey,
      revisionKey: entry.revisionKey,
      requestDigest: entry.requestDigest,
      requestIdentity: this.finalSubmissionIdentities.get(entry.revisionKey)!,
      requirement: structuredClone(this.finalSubmissions.get(entry.revisionKey)!),
    }));
  }

  restoreFinalReceipts(receipts: readonly PersistedFinalSubmitReceipt[]): void {
    this.finalSubmissions.clear();
    this.finalSubmissionIdentities.clear();
    this.finalIdempotency.clear();
    for (const receipt of receipts) {
      const requirement = structuredClone(receipt.requirement);
      this.ledger.reserveFinalSubmit({
        idempotencyKey: receipt.idempotencyKey,
        revisionKey: receipt.revisionKey,
        requestDigest: receipt.requestDigest,
        requestIdentity: receipt.requestIdentity,
      }, true);
      this.finalSubmissions.set(receipt.revisionKey, requirement);
      this.finalSubmissionIdentities.set(receipt.revisionKey, receipt.requestIdentity);
      this.finalIdempotency.set(receipt.idempotencyKey, {
        requestDigest: receipt.requestDigest,
        revisionKey: receipt.revisionKey,
      });
    }
  }

  async rejectDraftRevision(intake: ExplicitIntake, input: RejectDraftInput): Promise<DraftRejectClosure> {
    return this.serialize(async () => {
      const revision = intake.currentDraftRevision(input.interactionId);
      if (revision && this.hasOwnedSubmission(revision.draftId)) {
        throw new ExplicitBrainRouterError(
          'rejection-blocked',
          `draft rejection cannot close after requirement submission entered the inbox or dispatch: ${revision.draftId}`,
        );
      }
      const closure = await intake.rejectDraft(input);
      this.ledger.closeRevision(closure.draftId);
      return closure;
    });
  }

  /**
   * The single authorization point for a new task. Repeated submission of the
   * same revision returns the existing receipt and appends the requirement to
   * the inbox exactly once; a reused idempotency key with different content is
   * a typed conflict, never a silent second dispatch.
   */
  async submitFinal(input: FinalSubmit | ExistingTaskChangeSubmit): Promise<FinalSubmitReceipt> {
    return this.serialize(() => this.submitFinalSerialized(input));
  }

  private async submitFinalSerialized(input: FinalSubmit | ExistingTaskChangeSubmit): Promise<FinalSubmitReceipt> {
    const { revision, confirmation } = this.ledger.assertFinalSubmit(input);
    const revisionKey = `${revision.draftId}:${revision.draftRevisionVersion}:${revision.draftRevisionHash}`;
    const requestIdentity = finalSubmitIdentity(input);
    const requestDigest = canonicalJsonStringify({
      interactionId: input.interactionId,
      draftId: input.draftId,
      inputRevision: input.inputRevision,
      draftRevisionVersion: input.draftRevisionVersion,
      draftRevisionHash: input.draftRevisionHash,
      confirmationRef: input.confirmationRef,
      requestKind: input.requestKind,
      ...(input.requestKind === 'existing-task-change' ? { taskId: input.taskId } : {}),
    });
    const binding: FinalSubmitBinding = {
      idempotencyKey: input.idempotencyKey,
      revisionKey,
      requestDigest,
      requestIdentity,
    };
    const completedByKey = this.finalIdempotency.get(input.idempotencyKey);
    if (completedByKey) {
      if (completedByKey.requestDigest !== requestDigest) {
        throw new ExplicitBrainRouterError('duplicate-submit', `idempotency key was reused with different content: ${input.idempotencyKey}`);
      }
      const completed = this.finalSubmissions.get(completedByKey.revisionKey);
      if (!completed) {
        throw new ExplicitBrainRouterError(
          'duplicate-submit',
          `final submission binding is incomplete: ${input.idempotencyKey}`,
        );
      }
      return { status: 'duplicate', requirement: structuredClone(completed) };
    }

    const bindingByKey = this.ledger.finalSubmitBinding(input.idempotencyKey);
    const bindingByRevision = this.ledger.finalSubmitBindingForRevision(revisionKey);
    if (bindingByKey) {
      if (bindingByKey.revisionKey !== revisionKey
        || bindingByKey.requestDigest !== requestDigest
        || bindingByKey.requestIdentity !== requestIdentity) {
        throw new ExplicitBrainRouterError(
          'duplicate-submit',
          `idempotency key was reused with different content: ${input.idempotencyKey}`,
        );
      }
    } else if (bindingByRevision) {
      if (bindingByRevision.requestDigest !== requestDigest
        || bindingByRevision.requestIdentity !== requestIdentity) {
        throw new ExplicitBrainRouterError(
          'duplicate-submit',
          `draft revision was already submitted with a different request identity: ${revision.draftId}`,
        );
      }
      const completed = this.finalSubmissions.get(revisionKey);
      if (completed) {
        this.ledger.reserveFinalSubmit(binding, true);
        this.finalIdempotency.set(input.idempotencyKey, { requestDigest, revisionKey });
        return { status: 'duplicate', requirement: structuredClone(completed) };
      }
      throw new ExplicitBrainRouterError(
        'duplicate-submit',
        `final submission is already pending for draft revision: ${revision.draftId}`,
      );
    } else {
      this.ledger.reserveFinalSubmit(binding);
    }

    // Reuse the durable append identity before allocating a new FIFO. If the
    // append succeeded but dispatch was uncertain, the retry must reach the
    // downstream idempotency boundary with the original requirement identity.
    const pending = this.finalPending.get(revisionKey);
    const durable = this.inbox.find(revision.draftId);
    const envelope: RequirementEnvelope = pending?.envelope ?? durable ?? {
      requirementId: `requirement:${revision.draftId}:${revision.draftRevisionVersion}`,
      draftId: revision.draftId,
      inputRevision: revision.inputRevision,
      intent: revision.intent,
      ...(revision.taskRef === undefined ? {} : { taskRef: revision.taskRef }),
      normalizedInput: revision.normalizedInput,
      confirmedBy: confirmation.confirmedBy,
      confirmedAt: confirmation.confirmedAt,
      fifoSeq: this.inbox.expectedNextFifoSeq,
      payloadRef: revision.payloadRef,
    };
    if (durable && JSON.stringify(durable) !== JSON.stringify(envelope)) {
      throw new ExplicitBrainRouterError('duplicate-submit', `durable requirement submission differs from the current revision: ${revision.draftId}`);
    }
    const pendingState = pending ?? {
      envelope: structuredClone(envelope),
      persistenceAcknowledged: durable !== undefined && (bindingByKey !== undefined || bindingByRevision !== undefined),
    };
    this.finalPending.set(revisionKey, pendingState);
    if (!durable) {
      this.inbox.markConfirmed(envelope);
      await this.inbox.append(envelope);
    }
    this.acknowledgeFinalEnvelope(pendingState);
    const downstream = await this.port.submit(envelope);
    if (downstream.requirementId !== envelope.requirementId) {
      throw new ExplicitBrainRouterError('duplicate-submit', `requirement submission receipt mismatch: ${downstream.requirementId}`);
    }
    const requirement: AuthorizedRequirement = {
      requirementId: envelope.requirementId,
      draftId: envelope.draftId,
      inputRevision: envelope.inputRevision,
      draftRevisionVersion: revision.draftRevisionVersion,
      draftRevisionHash: revision.draftRevisionHash,
      confirmationRef: confirmation.confirmationRef,
      fifoSeq: envelope.fifoSeq,
      payloadRef: envelope.payloadRef,
    };
    const persistedReceipt: PersistedSubmittedReceipt = {
      interactionId: input.interactionId,
      status: 'submitted',
      requirementId: envelope.requirementId,
      draftId: envelope.draftId,
      inputRevision: envelope.inputRevision,
    };
    this.finalSubmissions.set(revisionKey, requirement);
    this.finalSubmissionIdentities.set(revisionKey, requestIdentity);
    this.finalIdempotency.set(input.idempotencyKey, { requestDigest, revisionKey });
    try {
      this.onSubmitted?.(structuredClone(persistedReceipt));
    } catch (error) {
      this.finalSubmissions.delete(revisionKey);
      this.finalSubmissionIdentities.delete(revisionKey);
      this.finalIdempotency.delete(input.idempotencyKey);
      throw error;
    }
    return { status: 'submitted', requirement: structuredClone(requirement) };
  }

  private acknowledgeFinalEnvelope(pending: {
    readonly envelope: RequirementEnvelope;
    persistenceAcknowledged: boolean;
    persistenceError?: unknown;
  }): void {
    if (pending.persistenceAcknowledged) return;
    if (!this.onEnvelopeAppended) {
      pending.persistenceAcknowledged = true;
      return;
    }
    try {
      this.onEnvelopeAppended(structuredClone(pending.envelope));
      pending.persistenceAcknowledged = true;
      delete pending.persistenceError;
    } catch (error) {
      pending.persistenceError ??= error;
      throw pending.persistenceError;
    }
  }

  async submit(input: RequirementSubmitArguments): Promise<RequirementSubmitReceipt> {
    return this.serialize(() => this.submitSerialized(input));
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.submissionTail;
    this.submissionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private hasOwnedSubmission(draftId: string): boolean {
    if (this.inbox.find(draftId)) return true;
    for (const pending of this.pending.values()) {
      if (pending.envelope.draftId === draftId) return true;
    }
    for (const receipt of this.submitted.values()) {
      if (receipt.draftId === draftId) return true;
    }
    for (const revisionKey of this.finalSubmissions.keys()) {
      if (revisionKey.startsWith(`${draftId}:`)) return true;
    }
    for (const entry of this.finalIdempotency.values()) {
      if (entry.revisionKey.startsWith(`${draftId}:`)) return true;
    }
    if (this.ledger.hasFinalSubmitBinding(draftId)) return true;
    return false;
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
      this.onEnvelopeAppended?.(structuredClone(envelope));
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
    const persistedReceipt: PersistedSubmittedReceipt = {
      interactionId: input.interactionId,
      ...receipt,
    };
    this.submitted.set(key, persistedReceipt);
    this.pending.delete(key);
    this.onSubmitted?.(structuredClone(persistedReceipt));
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

export interface CompiledExecutionPolicy {
  /**
   * A reference to the separately persisted execution policy. Only this ref
   * ever crosses into the requirement payload; the policy definition itself is
   * stored by the scheduler owner, never copied into the business envelope.
   */
  readonly executionControlRef: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly policyHash: string;
  readonly definition: ExecutionPolicyDefinition;
}

function policyContentHash(definition: ExecutionPolicyDefinition): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(definition)).digest('hex')}`;
}

/**
 * Compiles a shared execution policy for an authorized requirement. This node
 * only compiles and returns the typed policy plus its control ref; it does not
 * schedule, persist, or execute anything (the scheduler owner does that).
 */
export class ExecutionPolicyCompiler {
  compile(authorized: AuthorizedRequirement, definition: ExecutionPolicyDefinition): CompiledExecutionPolicy {
    validateAuthorizedRequirement(authorized);
    validateExecutionPolicyDefinition(definition);
    return {
      executionControlRef: `execution-policy:${definition.policyId}:${definition.policyRevision}`,
      policyId: definition.policyId,
      policyRevision: definition.policyRevision,
      policyHash: policyContentHash(definition),
      definition: structuredClone(definition),
    };
  }
}
