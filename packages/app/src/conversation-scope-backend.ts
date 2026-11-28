import type {
  ConversationScope,
  ConversationScopeDescriptor,
  LegacyConversationBinding,
} from '../../contracts/src/conversation-scope.js';
import type { ConversationScopeResponseMetadata } from '../../contracts/src/conversation-scope.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { conversationScopeKey } from '../../contracts/src/conversation-scope.js';
import { validateLegacyAlexBinding } from '../../config/src/conversation-scope.js';
import { ScopedConversationEngine } from '../../runtime/src/conversation-scope-engine.js';
import type { MainTopicProjection } from '../../ui/projection/main-topic.js';
import type { ProductMessageActor } from '../../contracts/src/product-read.js';
import type { UiRuntimeService } from './ui-runtime/service.js';
import type { RuntimeTaskEvent } from '../../runtime/src/ui-runtime/coordinator.js';

export interface ScopedConversationSession {
  readonly readMainTopic: () => Promise<MainTopicProjection>;
  readonly receiveInput: (input: {
    readonly sourceRef: string;
    readonly rawInput: string;
    readonly channel: 'business';
    readonly inputRevision?: number;
    readonly requestKind?: string;
    readonly occurredAt?: string;
    readonly actor?: ProductMessageActor;
    readonly idempotencyKey?: string;
  }) => Promise<string>;
  readonly inspectInteraction?: (interactionId: string) => Promise<unknown>;
  readonly interpretInteraction?: (interactionId: string) => Promise<unknown>;
  readonly continueInteraction?: (interactionId: string, partialRef: string) => Promise<unknown>;
  readonly answerClarification?: (interactionId: string, answer: string) => Promise<unknown>;
  readonly beginMatching?: (interactionId: string) => Promise<unknown>;
  readonly recordMatch?: (interactionId: string, result: unknown) => Promise<unknown>;
  readonly proposeRequirement?: (interactionId: string, proposal: unknown) => Promise<unknown>;
  readonly completeStatusQuery?: (interactionId: string) => Promise<unknown>;
  readonly confirmRequirement?: (
    interactionId: string,
    confirmation: Parameters<UiRuntimeService['confirmExplicitRequirement']>[0],
  ) => Promise<unknown>;
  readonly subscribeExplicitSteps?: (
    interactionId: string,
    onStep: Parameters<UiRuntimeService['subscribeExplicitSteps']>[1],
  ) => ReturnType<UiRuntimeService['subscribeExplicitSteps']>;
  readonly listTasks?: () => ReturnType<UiRuntimeService['listTasks']>;
  readonly resumeExecution?: UiRuntimeService['resumeExecution'];
  readonly recoverTask?: UiRuntimeService['recoverTask'];
  readonly stop?: UiRuntimeService['stop'];
  readonly removeMainTopicHistory?: UiRuntimeService['removeMainTopicHistory'];
  readonly operationTask?: (operationId: import('../../contracts/src/index.js').OperationId) => import('../../contracts/src/index.js').TaskId;
  readonly subscribeExecution?: (
    operationId: import('../../contracts/src/index.js').OperationId,
    lastEventId: string | undefined,
    listener: (event: import('../../runtime/src/ui-runtime/coordinator.js').RuntimeTaskEvent) => void,
  ) => ReturnType<UiRuntimeService['subscribeReplay']>;
  readonly subscribeTaskEvents?: (
    taskId: import('../../contracts/src/index.js').TaskId,
    lastEventId: string | undefined,
    listener: (event: import('../../ui/contracts/runtime.js').RuntimeSseEvent) => void,
  ) => ReturnType<UiRuntimeService['subscribeTaskEvents']>;
  readonly taskDashboardState?: (taskId: import('../../contracts/src/index.js').TaskId) => { readonly state: string };
  readonly toolOutput?: (
    taskId: import('../../contracts/src/index.js').TaskId,
    operationId: import('../../contracts/src/index.js').OperationId,
    executionEpoch: number,
    seq: number,
  ) => Promise<unknown>;
  readonly close?: () => Promise<void> | void;
}

export type ScopedConversationSessionFactory =
  (
    descriptor: ConversationScopeDescriptor,
    state: Awaited<ReturnType<ScopedConversationEngine['open']>>,
  ) => Promise<ScopedConversationSession> | ScopedConversationSession;

export type ScopedMainTopicProjection = Omit<MainTopicProjection, 'projectKey' | 'projectName' | 'workspaceCwd' | 'agentName'> & {
  readonly agentName: 'Alex' | 'Jenny';
  readonly projectKey?: string;
  readonly projectName?: string;
  readonly workspaceCwd?: string;
};

export interface ScopedInputReceipt {
  readonly interactionId: string;
  readonly occurredAt?: string;
}

export interface ScopedConversationBackendOptions {
  readonly descriptors: readonly ConversationScopeDescriptor[];
  readonly sessions?: ReadonlyMap<string, ScopedConversationSession>;
  readonly createSession?: ScopedConversationSessionFactory;
  readonly resolveProjectDescriptor?: (projectKey: string) => Promise<ConversationScopeDescriptor | undefined>;
  readonly legacyBinding?: LegacyConversationBinding;
  readonly defaultMode?: MainTopicProjection['mode'];
  /** Control-root-owned state directory. Omit only for an explicitly ephemeral fixture. */
  readonly stateRoot?: string;
}

export interface ScopedConversationResponse<T> {
  /** Public typed scope; the descriptor remains server-owned identity data. */
  readonly scope: ConversationScope;
  readonly canonicalAddress: string;
  readonly agentId: string;
  readonly role: ConversationScopeDescriptor['role'];
  readonly projectKey?: string;
  readonly workspaceCwd?: string;
  readonly legacySessionRef?: string;
  readonly preservedInteractionRefs: readonly string[];
  readonly preservedTaskRefs: readonly string[];
  readonly legacyBindingEvidenceRef?: string;
  readonly value: T;
}

export class ScopedConversationBackend {
  private readonly descriptors: Map<string, ConversationScopeDescriptor>;
  private readonly sessions: ReadonlyMap<string, ScopedConversationSession>;
  private readonly createSession?: ScopedConversationSessionFactory;
  private readonly resolveProjectDescriptor?: (projectKey: string) => Promise<ConversationScopeDescriptor | undefined>;
  private readonly descriptorResolutions = new Map<string, Promise<ConversationScopeDescriptor | undefined>>();
  private readonly sessionCache = new Map<string, ScopedConversationSession>();
  private readonly sessionCreations = new Map<string, Promise<ScopedConversationSession>>();
  private readonly sessionKeys = new WeakMap<object, string>();
  private readonly engine: ScopedConversationEngine;
  private readonly legacyBinding?: LegacyConversationBinding;
  private readonly defaultMode: MainTopicProjection['mode'];
  private readonly inputTails = new Map<string, Promise<void>>();

  constructor(options: ScopedConversationBackendOptions) {
    const descriptors = new Map<string, ConversationScopeDescriptor>();
    for (const descriptor of options.descriptors) {
      if (descriptors.has(descriptor.scopeKey)) throw new ScopedConversationBackendError('scope.ambiguous', `conversation scope is registered more than once: ${descriptor.scopeKey}`);
      descriptors.set(descriptor.scopeKey, descriptor);
    }
    this.descriptors = descriptors;
    if (options.sessions !== undefined && options.createSession !== undefined) {
      throw new ScopedConversationBackendError('scope.ambiguous', 'register sessions or a session factory, not both');
    }
    this.sessions = options.sessions ?? new Map();
    this.createSession = options.createSession;
    this.resolveProjectDescriptor = options.resolveProjectDescriptor;
    const seenSessions = new Set<object>();
    for (const [scopeKey, session] of this.sessions) {
      if (seenSessions.has(session)) throw new ScopedConversationBackendError('scope.session-shared', 'one session is bound to more than one conversation scope: ' + scopeKey);
      seenSessions.add(session);
      this.sessionCache.set(scopeKey, session);
      this.sessionKeys.set(session, scopeKey);
    }
    this.legacyBinding = options.legacyBinding === undefined ? undefined : validateLegacyAlexBinding(options.legacyBinding);
    this.defaultMode = options.defaultMode ?? 'rcc';
    this.engine = new ScopedConversationEngine({
      store: options.stateRoot === undefined ? new InMemoryScopedConversationStore() : new FileScopedConversationStore(options.stateRoot),
      resolve: (scope) => {
        const descriptor = this.descriptors.get(conversationScopeKey(scope));
        if (descriptor === undefined) throw new ScopedConversationBackendError('scope.unknown', `conversation scope is not registered: ${conversationScopeKey(scope)}`);
        return descriptor;
      },
      ...(options.legacyBinding === undefined ? {} : { legacyBinding: options.legacyBinding }),
    });
  }

  async ensureProjectDescriptor(projectKey: string): Promise<ConversationScopeDescriptor | undefined> {
    const scopeKey = conversationScopeKey({ kind: 'project', projectKey });
    const existing = this.descriptors.get(scopeKey);
    if (existing !== undefined) return existing;
    if (this.resolveProjectDescriptor === undefined) return undefined;
    let pending = this.descriptorResolutions.get(scopeKey);
    if (pending === undefined) {
      pending = this.resolveProjectDescriptor(projectKey).then((resolved) => {
        if (resolved !== undefined && resolved.scopeKey === scopeKey && !this.descriptors.has(scopeKey)) {
          this.descriptors.set(scopeKey, resolved);
        }
        return this.descriptors.get(scopeKey) ?? resolved;
      }).finally(() => {
        if (this.descriptorResolutions.get(scopeKey) === pending) {
          this.descriptorResolutions.delete(scopeKey);
        }
      });
      this.descriptorResolutions.set(scopeKey, pending);
    }
    return pending;
  }

  private async session(scope: ConversationScope): Promise<{ readonly descriptor: ConversationScopeDescriptor; readonly session: ScopedConversationSession; readonly state: Awaited<ReturnType<ScopedConversationEngine['open']>> }> {
    if (scope.kind === 'project') {
      await this.ensureProjectDescriptor(scope.projectKey);
    }
    const state = await this.engine.open(scope);
    const descriptor = state.scope;
    let session = this.sessionCache.get(descriptor.scopeKey);
    if (session === undefined && this.createSession !== undefined) {
      let creation = this.sessionCreations.get(descriptor.scopeKey);
      if (creation === undefined) {
        creation = Promise.resolve(this.createSession(descriptor, state));
        this.sessionCreations.set(descriptor.scopeKey, creation);
        void creation.finally(() => {
          if (this.sessionCreations.get(descriptor.scopeKey) === creation) this.sessionCreations.delete(descriptor.scopeKey);
        }).catch(() => undefined);
      }
      session = await creation;
      if (session === undefined) throw new ScopedConversationBackendError('scope.engine-unavailable', 'conversation factory returned no engine for ' + descriptor.canonicalAddress);
      const previousScope = this.sessionKeys.get(session);
      if (previousScope !== undefined && previousScope !== descriptor.scopeKey) throw new ScopedConversationBackendError('scope.session-shared', 'conversation factory reused one session for ' + previousScope + ' and ' + descriptor.scopeKey);
      this.sessionCache.set(descriptor.scopeKey, session);
      this.sessionKeys.set(session, descriptor.scopeKey);
    }
    if (session === undefined) throw new ScopedConversationBackendError('scope.engine-unavailable', `conversation engine is not registered for ${descriptor.canonicalAddress}`);
    return { descriptor, session, state };
  }

  private assertInteractionOwned(state: Awaited<ReturnType<ScopedConversationEngine['open']>>, interactionId: string): void {
    if (!state.interactionIds.includes(interactionId) && !state.preservedInteractionRefs.includes(interactionId)) {
      throw new ScopedConversationBackendError('scope.interaction-not-found', 'interaction is not recorded in the selected conversation scope: ' + interactionId);
    }
  }

  async readState(scope: ConversationScope): Promise<Awaited<ReturnType<ScopedConversationEngine['open']>>> {
    if (scope.kind === 'project') {
      await this.ensureProjectDescriptor(scope.projectKey);
    }
    return this.engine.read(scope);
  }

  async requireInteractionOwnership(scope: ConversationScope, interactionId: string): Promise<void> {
    const { state } = await this.session(scope);
    this.assertInteractionOwned(state, interactionId);
  }

  async listTasks(scope: ConversationScope): Promise<unknown> {
    const { session } = await this.session(scope);
    if (session.listTasks === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'task discovery is not available for this scope');
    return session.listTasks();
  }

  async requireOperationOwnership(scope: ConversationScope, operationId: import('../../contracts/src/index.js').OperationId): Promise<void> {
    const { session } = await this.session(scope);
    if (session.operationTask === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'execution events are not available for this scope');
    const taskId = session.operationTask(operationId);
    if (!(await this.sessionTaskIds(session)).has(taskId.value)) {
      throw new ScopedConversationBackendError('scope.operation-not-found', 'operation is not recorded in the selected conversation scope: ' + operationId.value);
    }
  }

  async requireTaskOwnership(scope: ConversationScope, taskId: import('../../contracts/src/index.js').TaskId): Promise<void> {
    const { session } = await this.session(scope);
    if (!(await this.sessionTaskIds(session)).has(taskId.value)) {
      throw new ScopedConversationBackendError('scope.task-not-found', 'task is not recorded in the selected conversation scope: ' + taskId.value);
    }
  }

  async resumeExecution(
    scope: ConversationScope,
    taskId: Parameters<UiRuntimeService['resumeExecution']>[0],
    input: Parameters<UiRuntimeService['resumeExecution']>[1],
  ): ReturnType<UiRuntimeService['resumeExecution']> {
    const { session } = await this.session(scope);
    await this.requireTaskOwnership(scope, taskId);
    let operationTask: string | undefined;
    try {
      operationTask = session.operationTask?.(input.operationId).value;
    } catch {
      // A missing operation in this session cannot select any other scope.
    }
    if (operationTask !== taskId.value) {
      throw new ScopedConversationBackendError('scope.operation-not-found', 'operation is not owned by the selected task');
    }
    if (session.resumeExecution === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'execution resume is not available for this scope');
    return session.resumeExecution(taskId, input);
  }

  async recoverTask(
    scope: ConversationScope,
    taskId: Parameters<UiRuntimeService['recoverTask']>[0],
    options: Parameters<UiRuntimeService['recoverTask']>[1],
  ): ReturnType<UiRuntimeService['recoverTask']> {
    const { session } = await this.session(scope);
    await this.requireTaskOwnership(scope, taskId);
    if (session.recoverTask === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'task recovery is not available for this scope');
    return session.recoverTask(taskId, options);
  }

  async stopTask(
    scope: ConversationScope,
    taskId: Parameters<UiRuntimeService['stop']>[0],
  ): ReturnType<UiRuntimeService['stop']> {
    const { session } = await this.session(scope);
    await this.requireTaskOwnership(scope, taskId);
    if (session.stop === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'task stop is not available for this scope');
    return session.stop(taskId);
  }

  async removeMainTopicHistory(
    scope: ConversationScope,
    input: Parameters<UiRuntimeService['removeMainTopicHistory']>[0],
  ): Promise<ScopedConversationResponse<{ readonly removedRoundKeys: readonly string[]; readonly projection: ScopedMainTopicProjection }>> {
    const descriptor = this.descriptors.get(conversationScopeKey(scope));
    if (descriptor === undefined) throw new ScopedConversationBackendError('scope.unknown', `conversation scope is not registered: ${conversationScopeKey(scope)}`);
    const { session, state } = await this.session(scope);
    if (session.removeMainTopicHistory === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'conversation history removal is not available for this scope');
    const result = await session.removeMainTopicHistory(input);
    const legacy = this.legacyMetadata(scope, state);
    return {
      ...descriptorFields(descriptor),
      value: {
        removedRoundKeys: result.removedRoundKeys,
        projection: scopeMainTopic(result.projection, descriptor),
      },
      ...legacy,
    };
  }

  async subscribeExecution(
    scope: ConversationScope,
    operationId: import('../../contracts/src/index.js').OperationId,
    lastEventId: string | undefined,
    listener: (event: import('../../runtime/src/ui-runtime/coordinator.js').RuntimeTaskEvent) => void,
  ): Promise<ReturnType<UiRuntimeService['subscribeReplay']>> {
    const { session } = await this.session(scope);
    if (session.subscribeExecution === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'execution events are not available for this scope');
    await this.requireOperationOwnership(scope, operationId);
    return session.subscribeExecution(operationId, lastEventId, listener);
  }

  async taskEventSource(
    scope: ConversationScope,
    taskId: import('../../contracts/src/index.js').TaskId,
  ): Promise<{
    readonly subscribeTaskEvents: NonNullable<ScopedConversationSession['subscribeTaskEvents']>;
    readonly taskDashboard: NonNullable<ScopedConversationSession['taskDashboardState']>;
  }> {
    const { session } = await this.session(scope);
    await this.requireTaskOwnership(scope, taskId);
    if (session.subscribeTaskEvents === undefined || session.taskDashboardState === undefined) {
      throw new ScopedConversationBackendError('scope.operation-unavailable', 'task events are not available for this scope');
    }
    return {
      subscribeTaskEvents: session.subscribeTaskEvents,
      taskDashboard: session.taskDashboardState,
    };
  }

  async toolOutput(
    scope: ConversationScope,
    taskId: import('../../contracts/src/index.js').TaskId,
    operationId: import('../../contracts/src/index.js').OperationId,
    executionEpoch: number,
    seq: number,
  ): Promise<unknown> {
    const { session } = await this.session(scope);
    if (session.toolOutput === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'tool output is not available for this scope');
    if (!(await this.sessionTaskIds(session)).has(taskId.value)) {
      throw new ScopedConversationBackendError('scope.task-not-found', 'task is not recorded in the selected conversation scope: ' + taskId.value);
    }
    let operationTask = '';
    try {
      operationTask = session.operationTask?.(operationId).value ?? '';
    } catch {
      operationTask = '';
    }
    if (operationTask !== taskId.value) {
      throw new ScopedConversationBackendError('scope.operation-not-found', 'operation is not owned by the selected task');
    }
    return session.toolOutput(taskId, operationId, executionEpoch, seq);
  }

  private async sessionTaskIds(session: ScopedConversationSession): Promise<ReadonlySet<string>> {
    if (session.listTasks === undefined) return new Set();
    const list = session.listTasks();
    const ids = new Set<string>();
    for (const group of [list.running, list.waiting, list.completed, list.stopped, list.draft, list.failed]) {
      for (const row of group) {
        ids.add(row.taskId.value);
        for (const execution of (row as { readonly executions?: readonly { readonly taskId: { readonly value: string } }[] }).executions ?? []) {
          ids.add(execution.taskId.value);
        }
      }
    }
    return ids;
  }

  async readMainTopic(scope: ConversationScope): Promise<ScopedConversationResponse<ScopedMainTopicProjection>> {
    const descriptor = scope.kind === 'project'
      ? await this.ensureProjectDescriptor(scope.projectKey)
      : this.descriptors.get(conversationScopeKey(scope));
    if (descriptor === undefined) throw new ScopedConversationBackendError('scope.unknown', `conversation scope is not registered: ${conversationScopeKey(scope)}`);
    const state = await this.engine.read(scope);
    const legacy = this.legacyMetadata(scope, state);
    const cached = this.sessionCache.get(descriptor.scopeKey);
    if (cached === undefined && state.interactionIds.length === 0 && state.preservedInteractionRefs.length === 0) {
      return { ...descriptorFields(descriptor), value: emptyScopedMainTopic(descriptor, this.defaultMode), ...legacy };
    }
    const { session } = await this.session(scope);
    const projection = await session.readMainTopic();
    const value = scopeMainTopic(projection, descriptor);
    return { ...descriptorFields(descriptor), value, ...legacy };
  }

  /**
   * Legacy carrier metadata is a configured display fact. A read exposes it
   * without creating a session or writing scope state; only a real open or
   * submit persists the binding. This keeps a GET on the legacy Alex carrier
   * observable and side-effect free.
   */
  private legacyMetadata(
    scope: ConversationScope,
    state: Awaited<ReturnType<ScopedConversationEngine['open']>>,
  ): Pick<ConversationScopeResponseMetadata, 'preservedInteractionRefs' | 'preservedTaskRefs' | 'legacySessionRef' | 'legacyBindingEvidenceRef'> {
    if (state.legacySessionRef !== undefined) return legacyFields(state, this.legacyBinding);
    const binding = this.legacyBinding;
    if (binding !== undefined && conversationScopeKey(binding.scope) === conversationScopeKey(scope)) {
      return {
        legacySessionRef: binding.legacySessionRef,
        preservedInteractionRefs: [...binding.preservedInteractionRefs],
        preservedTaskRefs: [...binding.preservedTaskRefs],
        legacyBindingEvidenceRef: binding.sourceEvidenceRef,
      };
    }
    return { preservedInteractionRefs: [...state.preservedInteractionRefs], preservedTaskRefs: [...state.preservedTaskRefs] };
  }

  async receiveInput(scope: ConversationScope, input: Parameters<ScopedConversationSession['receiveInput']>[0]): Promise<ScopedConversationResponse<ScopedInputReceipt>> {
    return this.serializedInput(scope, async () => {
      const descriptor = scope.kind === 'project'
        ? await this.ensureProjectDescriptor(scope.projectKey)
        : this.descriptors.get(conversationScopeKey(scope));
      if (descriptor === undefined) throw new ScopedConversationBackendError('scope.unknown', `conversation scope is not registered: ${conversationScopeKey(scope)}`);
      const state = await this.engine.read(scope);
      const digest = createHash('sha256').update(JSON.stringify({
        sourceRef: input.sourceRef,
        rawInput: input.rawInput,
        channel: input.channel,
        inputRevision: input.inputRevision ?? 1,
        requestKind: input.requestKind ?? null,
        actor: input.actor ?? null,
      })).digest('hex');
      if (input.idempotencyKey !== undefined) {
        const prior = state.inputReceipts?.find((receipt) => receipt.idempotencyKey === input.idempotencyKey);
        if (prior !== undefined) {
          if (prior.requestDigest !== digest) throw new ScopedConversationBackendError('scope.idempotency-conflict', 'idempotency key was reused with different input');
          const replaySession = (await this.session(scope)).session;
          const occurredAt = replaySession.inspectInteraction === undefined
            ? input.occurredAt
            : await replaySession.inspectInteraction(prior.interactionId)
              .then((value) => (value as { readonly occurredAt?: unknown }).occurredAt)
              .then((value) => typeof value === 'string' ? value : input.occurredAt)
              .catch(() => input.occurredAt);
          return { ...descriptorFields(descriptor), value: { interactionId: prior.interactionId, ...(occurredAt === undefined ? {} : { occurredAt }) }, ...legacyFields(state, this.legacyBinding) };
        }
      }
      const { session } = await this.session(scope);
      const interactionId = await session.receiveInput(input);
      const next = input.idempotencyKey === undefined
        ? await this.engine.appendInteraction(scope, interactionId)
        : await this.engine.recordInput(scope, { idempotencyKey: input.idempotencyKey, requestDigest: digest, interactionId });
      const occurredAt = session.inspectInteraction === undefined
        ? input.occurredAt
        : await session.inspectInteraction(interactionId)
          .then((value) => (value as { readonly occurredAt?: unknown }).occurredAt)
          .then((value) => typeof value === 'string' ? value : input.occurredAt)
          .catch(() => input.occurredAt);
      return { ...descriptorFields(descriptor), value: { interactionId, ...(occurredAt === undefined ? {} : { occurredAt }) }, ...legacyFields(next, this.legacyBinding) };
    });
  }

  private async serializedInput<T>(scope: ConversationScope, operation: () => Promise<T>): Promise<T> {
    const key = conversationScopeKey(scope);
    const previous = this.inputTails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.inputTails.set(key, tail);
    void tail.then(() => { if (this.inputTails.get(key) === tail) this.inputTails.delete(key); });
    return result;
  }

  async inspectInteraction(scope: ConversationScope, interactionId: string): Promise<ScopedConversationResponse<unknown>> {
    const { descriptor, session, state } = await this.session(scope);
    this.assertInteractionOwned(state, interactionId);
    if (session.inspectInteraction === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'interaction inspection is not available for this scope');
    return { ...descriptorFields(descriptor), value: await session.inspectInteraction(interactionId), ...legacyFields(state, this.legacyBinding) };
  }

  async interpretInteraction(scope: ConversationScope, interactionId: string): Promise<ScopedConversationResponse<unknown>> {
    const { descriptor, session, state } = await this.session(scope);
    this.assertInteractionOwned(state, interactionId);
    if (session.interpretInteraction === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'interaction interpretation is not available for this scope');
    return { ...descriptorFields(descriptor), value: await session.interpretInteraction(interactionId), ...legacyFields(state, this.legacyBinding) };
  }

  async continueInteraction(scope: ConversationScope, interactionId: string, partialRef: string): Promise<ScopedConversationResponse<unknown>> {
    const { descriptor, session, state } = await this.session(scope);
    this.assertInteractionOwned(state, interactionId);
    if (session.continueInteraction === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'interaction continuation is not available for this scope');
    return { ...descriptorFields(descriptor), value: await session.continueInteraction(interactionId, partialRef), ...legacyFields(state, this.legacyBinding) };
  }

  async answerClarification(scope: ConversationScope, interactionId: string, answer: string): Promise<ScopedConversationResponse<unknown>> {
    const { descriptor, session, state } = await this.session(scope);
    this.assertInteractionOwned(state, interactionId);
    if (session.answerClarification === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'clarification is not available for this scope');
    return { ...descriptorFields(descriptor), value: await session.answerClarification(interactionId, answer), ...legacyFields(state, this.legacyBinding) };
  }

  async confirmRequirement(
    scope: ConversationScope,
    interactionId: string,
    confirmation: Parameters<UiRuntimeService['confirmExplicitRequirement']>[0],
  ): Promise<ScopedConversationResponse<unknown>> {
    const { descriptor, session, state } = await this.session(scope);
    this.assertInteractionOwned(state, interactionId);
    if (session.confirmRequirement === undefined) throw new ScopedConversationBackendError('scope.operation-unavailable', 'requirement confirmation is not available for this scope');
    return { ...descriptorFields(descriptor), value: await session.confirmRequirement(interactionId, confirmation), ...legacyFields(state, this.legacyBinding) };
  }

  async subscribeInteractionSteps(
    scope: ConversationScope,
    interactionId: string,
    onStep: Parameters<UiRuntimeService['subscribeExplicitSteps']>[1],
  ): ReturnType<UiRuntimeService['subscribeExplicitSteps']> {
    return this.session(scope).then(async ({ session, state }) => {
      this.assertInteractionOwned(state, interactionId);
      if (session.subscribeExplicitSteps === undefined) {
        throw new ScopedConversationBackendError('scope.operation-unavailable', 'interaction progress is not available for this scope');
      }
      return session.subscribeExplicitSteps(interactionId, onStep);
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessionCreations.values()]);
    const sessions = [...new Set(this.sessionCache.values())];
    await Promise.all(sessions.map(async (session) => { await session.close?.(); }));
  }
}

export class ScopedConversationBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScopedConversationBackendError';
    this.code = code;
  }
}

function descriptorFields(descriptor: ConversationScopeDescriptor): Pick<ConversationScopeResponseMetadata, 'scope' | 'canonicalAddress' | 'agentId' | 'role' | 'projectKey' | 'workspaceCwd'> {
  return {
    scope: descriptor.scope,
    canonicalAddress: descriptor.canonicalAddress,
    agentId: descriptor.agentId,
    role: descriptor.role,
    ...(descriptor.projectKey === undefined ? {} : { projectKey: descriptor.projectKey }),
    ...(descriptor.workspaceCwd === undefined ? {} : { workspaceCwd: descriptor.workspaceCwd }),
  };
}

function legacyFields(state: Awaited<ReturnType<ScopedConversationEngine['open']>>, binding: LegacyConversationBinding | undefined): Pick<ConversationScopeResponseMetadata, 'preservedInteractionRefs' | 'preservedTaskRefs' | 'legacySessionRef' | 'legacyBindingEvidenceRef'> {
  if (state.legacySessionRef === undefined || binding === undefined) {
    return { preservedInteractionRefs: [...state.preservedInteractionRefs], preservedTaskRefs: [...state.preservedTaskRefs] };
  }
  return {
    legacySessionRef: state.legacySessionRef,
    preservedInteractionRefs: [...state.preservedInteractionRefs],
    preservedTaskRefs: [...state.preservedTaskRefs],
    legacyBindingEvidenceRef: state.legacyBindingEvidenceRef,
  };
}

function scopeMainTopic(projection: MainTopicProjection, descriptor: ConversationScopeDescriptor): ScopedMainTopicProjection {
  if (descriptor.role !== 'ceo') {
    return {
      ...projection,
      agentName: 'Jenny',
      ...(descriptor.projectKey === undefined ? {} : { projectKey: descriptor.projectKey }),
      ...(descriptor.workspaceCwd === undefined ? {} : { workspaceCwd: descriptor.workspaceCwd }),
    };
  }
  const { projectKey, projectName, workspaceCwd, agentName, ...alex } = projection;
  void projectKey;
  void projectName;
  void workspaceCwd;
  void agentName;
  return { ...alex, agentName: 'Alex' };
}

function emptyScopedMainTopic(
  descriptor: ConversationScopeDescriptor,
  mode: MainTopicProjection['mode'] = 'rcc',
): ScopedMainTopicProjection {
  const agentName = descriptor.role === 'ceo' ? 'Alex' : 'Jenny';
  const projectName = descriptor.role === 'ceo'
    ? undefined
    : descriptor.workspaceCwd?.split('/').filter(Boolean).at(-1) || descriptor.projectKey;
  return {
    surface: 'main-topic',
    agentName,
    mode,
    interactions: [],
    tasks: [],
    turns: [],
    usage: { calls: [] },
    ...(projectName === undefined ? {} : { projectName }),
    ...(descriptor.projectKey === undefined ? {} : { projectKey: descriptor.projectKey }),
    ...(descriptor.workspaceCwd === undefined ? {} : { workspaceCwd: descriptor.workspaceCwd }),
  } as unknown as ScopedMainTopicProjection;
}

class InMemoryScopedConversationStore {
  private readonly states = new Map<string, Awaited<ReturnType<ScopedConversationEngine['open']>>>();

  async read(scopeKey: string): Promise<Awaited<ReturnType<ScopedConversationEngine['open']>> | undefined> {
    const state = this.states.get(scopeKey);
    return state === undefined ? undefined : structuredClone(state);
  }

  async write(state: Awaited<ReturnType<ScopedConversationEngine['open']>>): Promise<void> {
    this.states.set(state.scope.scopeKey, structuredClone(state));
  }
}

class FileScopedConversationStore {
  constructor(private readonly root: string) {}

  async read(scopeKey: string): Promise<Awaited<ReturnType<ScopedConversationEngine['open']>> | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.file(scopeKey), 'utf8')) as Awaited<ReturnType<ScopedConversationEngine['open']>>;
      if (parsed.scope.scopeKey !== scopeKey) throw new Error(`scoped conversation state key mismatch: ${parsed.scope.scopeKey}`);
      return structuredClone(parsed);
    } catch (error) {
      if ((error as { readonly code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async write(state: Awaited<ReturnType<ScopedConversationEngine['open']>>): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const destination = this.file(state.scope.scopeKey);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8');
    await rename(temporary, destination);
  }

  private file(scopeKey: string): string {
    const safe = scopeKey.replace(/[^A-Za-z0-9._-]/gu, '_');
    return join(this.root, `${safe}.json`);
  }
}

export function scopedSessionFromUiRuntime(service: UiRuntimeService): ScopedConversationSession {
  return {
    readMainTopic: () => service.readMainTopic(),
    removeMainTopicHistory: (input) => service.removeMainTopicHistory(input),
    receiveInput: (input) => service.receiveExplicitInput({
      sourceRef: input.sourceRef,
      rawInput: input.rawInput,
      channel: input.channel,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.requestKind === undefined ? {} : { requestKind: input.requestKind as never }),
    }, input.inputRevision ?? 1),
    inspectInteraction: (interactionId) => service.inspectExplicitInteraction(interactionId),
    interpretInteraction: (interactionId) => service.interpretExplicitInput({ interactionId }),
    continueInteraction: (interactionId, partialRef) => service.continueExplicitPartial({ interactionId, partialRef }),
    answerClarification: (interactionId, answer) => service.answerExplicitClarification({ interactionId, answer }),
    confirmRequirement: (interactionId, confirmation) => service.confirmExplicitRequirement({ ...confirmation, interactionId }),
    subscribeExplicitSteps: (interactionId, onStep) => service.subscribeExplicitSteps(interactionId, onStep),
    listTasks: () => service.listTasks(),
    resumeExecution: (taskId, input) => service.resumeExecution(taskId, input),
    recoverTask: (taskId, options) => service.recoverTask(taskId, options),
    stop: (taskId) => service.stop(taskId),
    operationTask: (operationId) => service.operationTask(operationId),
    subscribeExecution: (operationId, lastEventId, listener) => service.subscribeReplay(operationId, lastEventId, listener),
    subscribeTaskEvents: (taskId, lastEventId, listener) => service.subscribeTaskEvents(taskId, lastEventId, listener),
    taskDashboardState: (taskId) => service.taskDashboard(taskId),
    toolOutput: (taskId, operationId, executionEpoch, seq) => service.toolOutput(taskId, operationId, executionEpoch, seq),
  };
}
