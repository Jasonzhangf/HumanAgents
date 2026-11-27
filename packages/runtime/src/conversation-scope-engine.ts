import { conversationScopeKey } from '../../contracts/src/conversation-scope.js';
import type { ConversationScope, ConversationScopeDescriptor } from '../../contracts/src/conversation-scope.js';

export interface ScopedConversationState {
  readonly scope: ConversationScopeDescriptor;
  readonly interactionIds: readonly string[];
  readonly activeTurnId?: string;
  readonly checkpointRefs: readonly string[];
  readonly inputReceipts?: readonly ScopedConversationInputReceipt[];
  readonly legacySessionRef?: string;
  readonly preservedInteractionRefs: readonly string[];
  readonly preservedTaskRefs: readonly string[];
  readonly legacyBindingEvidenceRef?: string;
}

export interface ScopedConversationInputReceipt {
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly interactionId: string;
}

export interface ScopedConversationStore {
  read(scopeKey: string): Promise<ScopedConversationState | undefined>;
  write(state: ScopedConversationState): Promise<void>;
}

export interface ScopedConversationEngineOptions {
  readonly store: ScopedConversationStore;
  readonly resolve: (scope: ConversationScope) => Promise<ConversationScopeDescriptor> | ConversationScopeDescriptor;
  readonly legacyBinding?: {
    readonly legacySessionRef: string;
    readonly scope: ConversationScope;
    readonly preservedInteractionRefs: readonly string[];
    readonly preservedTaskRefs: readonly string[];
    readonly sourceEvidenceRef: string;
  };
}

export class ScopedConversationEngine {
  private readonly options: ScopedConversationEngineOptions;
  private readonly scopeTails = new Map<string, Promise<void>>();

  constructor(options: ScopedConversationEngineOptions) {
    this.options = options;
  }

  async open(scope: ConversationScope): Promise<ScopedConversationState> {
    return this.serialized(conversationScopeKey(scope), () => this.openUnlocked(scope));
  }

  async read(scope: ConversationScope): Promise<ScopedConversationState> {
    return this.serialized(conversationScopeKey(scope), async () => {
      const descriptor = await this.resolveDescriptor(scope);
      const existing = await this.options.store.read(descriptor.scopeKey);
      if (existing !== undefined) return this.assertStateScope(existing, descriptor, scope);
      return this.emptyState(descriptor);
    });
  }

  async recordInput(scope: ConversationScope, input: ScopedConversationInputReceipt): Promise<ScopedConversationState> {
    return this.serialized(conversationScopeKey(scope), async () => {
      const state = await this.openUnlocked(scope);
      const receipts = state.inputReceipts ?? [];
      const prior = receipts.find((receipt) => receipt.idempotencyKey === input.idempotencyKey);
      if (prior !== undefined) {
        if (prior.requestDigest !== input.requestDigest || prior.interactionId !== input.interactionId) {
          throw new Error(`idempotency key was reused with different input: ${input.idempotencyKey}`);
        }
        return state;
      }
      const next = {
        ...state,
        interactionIds: state.interactionIds.includes(input.interactionId)
          ? state.interactionIds
          : [...state.interactionIds, input.interactionId],
        inputReceipts: [...receipts, input],
      };
      await this.options.store.write(next);
      return next;
    });
  }

  private async openUnlocked(scope: ConversationScope): Promise<ScopedConversationState> {
    const descriptor = await this.resolveDescriptor(scope);
    const existing = await this.options.store.read(descriptor.scopeKey);
    if (existing !== undefined) {
      this.assertStateScope(existing, descriptor, scope);
      const binding = this.options.legacyBinding;
      if (binding === undefined || binding.scope.kind !== descriptor.scope.kind
        || (binding.scope.kind === 'project' && binding.scope.projectKey !== descriptor.projectKey)) {
        return existing;
      }
      if (existing.legacySessionRef !== undefined && existing.legacySessionRef !== binding.legacySessionRef) {
        throw new Error(`conversation state is already bound to legacy session ${existing.legacySessionRef}`);
      }
      const preservedTaskRefs = [...new Set([...existing.preservedTaskRefs, ...binding.preservedTaskRefs])];
      const preservedInteractionRefs = [...new Set([...existing.preservedInteractionRefs, ...binding.preservedInteractionRefs])];
      if (existing.legacySessionRef === binding.legacySessionRef
        && preservedTaskRefs.length === existing.preservedTaskRefs.length
        && preservedInteractionRefs.length === existing.preservedInteractionRefs.length
        && existing.legacyBindingEvidenceRef === binding.sourceEvidenceRef) return existing;
      const backfilled: ScopedConversationState = {
        ...existing,
        legacySessionRef: binding.legacySessionRef,
        preservedInteractionRefs,
        preservedTaskRefs,
        legacyBindingEvidenceRef: binding.sourceEvidenceRef,
      };
      await this.options.store.write(backfilled);
      return backfilled;
    }
    const binding = this.options.legacyBinding;
    const legacy = binding !== undefined && binding.scope.kind === descriptor.scope.kind
      && (binding.scope.kind === 'alex' || binding.scope.projectKey === descriptor.projectKey)
      ? binding
      : undefined;
    const state = this.emptyState(descriptor, legacy);
    await this.options.store.write(state);
    return state;
  }

  async appendInteraction(scope: ConversationScope, interactionId: string): Promise<ScopedConversationState> {
    if (!interactionId.trim()) throw new Error('interactionId is required');
    return this.serialized(conversationScopeKey(scope), async () => {
      const state = await this.openUnlocked(scope);
      const next = state.interactionIds.includes(interactionId)
        ? state
        : { ...state, interactionIds: [...state.interactionIds, interactionId] };
      if (next !== state) await this.options.store.write(next);
      return next;
    });
  }

  private async resolveDescriptor(scope: ConversationScope): Promise<ConversationScopeDescriptor> {
    const descriptor = await this.options.resolve(scope);
    if (descriptor.scopeKey !== conversationScopeKey(descriptor.scope)) {
      throw new Error('conversation descriptor has an invalid scope key: ' + descriptor.scopeKey);
    }
    if (conversationScopeKey(descriptor.scope) !== conversationScopeKey(scope)) {
      throw new Error('conversation descriptor resolves a different logical scope');
    }
    return descriptor;
  }

  private assertStateScope(
    state: ScopedConversationState,
    descriptor: ConversationScopeDescriptor,
    requested: ConversationScope,
  ): ScopedConversationState {
    if (state.scope.scopeKey !== descriptor.scopeKey
      || conversationScopeKey(state.scope.scope) !== conversationScopeKey(requested)) {
      throw new Error('conversation state does not belong to requested scope: ' + descriptor.scopeKey);
    }
    return state;
  }

  private emptyState(
    descriptor: ConversationScopeDescriptor,
    legacy?: ScopedConversationEngineOptions['legacyBinding'],
  ): ScopedConversationState {
    return {
      scope: descriptor,
      interactionIds: [],
      checkpointRefs: [],
      preservedInteractionRefs: legacy === undefined ? [] : [...legacy.preservedInteractionRefs],
      preservedTaskRefs: legacy === undefined ? [] : [...legacy.preservedTaskRefs],
      ...(legacy === undefined ? {} : { legacySessionRef: legacy.legacySessionRef, legacyBindingEvidenceRef: legacy.sourceEvidenceRef }),
    };
  }

  private async serialized<T>(scopeKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.scopeTails.get(scopeKey) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.scopeTails.set(scopeKey, tail);
    void tail.then(() => {
      if (this.scopeTails.get(scopeKey) === tail) this.scopeTails.delete(scopeKey);
    });
    return result;
  }
}
