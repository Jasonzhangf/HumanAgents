import {
  assertProviderExecutionIdentity,
  assertProviderExecutionIdentityMatch,
  id,
  isStandardTurnEndToolId,
  validateProviderToolResult,
  validateProviderRequestLifecycleEvent,
  type AnyProviderExecutionIdentityRef,
  type AcceptedRawFact,
  type AgentCapabilities,
  type AgentClosure,
  type AgentDriver,
  type AgentEvent,
  type AgentHandle,
  type AgentInput,
  type AgentOutput,
  type AgentResumeRequest,
  type AgentStartRequest,
  type BusinessPayload,
  type ActiveTurnProviderExecutionIdentityRef,
  type ActiveTurnProviderRequestIdentityRef,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type NativeRequestRegistration,
  type OperationId,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderError,
  type ProviderProducerDrainResult,
  type ProviderRequestLifecycleEvent,
  type ProviderExecutionIdentityRef,
  type TasklessProviderExecutionIdentityRef,
  type InteractionHelperIdentity,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionTurnIdentity,
  type OrganId,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderSubmitInput,
  type ProviderStopRequest,
  type ProviderSettleInput,
  type ProviderSubmitResult,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderToolCall,
  type ProviderToolResult,
  type ProviderToolStatus,
  type ProviderRawFact,
  type RawAsset,
  type RawFactEnvelope,
  type RuntimeRequestLifecyclePhase,
  type RuntimeRequestRecord,
  type ScopeRef,
  type StopRequestReceipt,
  type TaskId,
  type ToolExecutionFact,
  type ToolIdentity,
} from '../../../contracts/src/index.js';
import type {
  MaterializedRequestInput,
  ProviderRequestContext,
  ProviderRequestContextHook,
  ProviderRequestContextPhase,
  RequestScopedInstructions,
} from '../../../contracts/src/provider-request-context.js';
import { randomUUID } from 'node:crypto';
import type { ProviderObserveInputWithRawFacts, ProviderRawFactReceiver } from './adapter.js';
import type { ProviderEvidenceSink } from './evidence.js';
import { ProviderAdapterError } from './errors.js';

interface ToolBarrier {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

type ProviderToolExecutionOutcome =
  | { readonly call: ProviderToolCall; readonly result: ProviderToolExecutionResult }
  | { readonly call: ProviderToolCall; readonly cause: unknown };

function createToolBarrier(): ToolBarrier {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export interface ProviderAgentDriverCommonOptions<TIdentity extends AnyProviderExecutionIdentityRef> {
  readonly port: ExecutionRuntimePort<TIdentity>;
  readonly binding: ProviderBinding;
  readonly runtimeId: string;
  readonly taskId?: TaskId;
  readonly organId?: OrganId;
  readonly helper?: InteractionHelperIdentity;
  readonly interactionTurn?: InteractionTurnIdentity;
  /**
   * Optional settled local request parent for the first request of a new driver
   * instance continuing an existing turn in a new executionEpoch. Preserves
   * `turnId` and sets `parentRequestId` on the initial request without reusing
   * any remote provider response id.
   */
  readonly parentRequest?: ActiveTurnProviderRequestIdentityRef;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly scope: ScopeRef;
  readonly inputRefs: readonly string[];
  readonly ownerId?: string;
  readonly tools?: ProviderStartInput['tools'];
  readonly executeTool?: ProviderToolExecutionPort<TIdentity>;
  readonly maxToolRounds?: number;
  readonly onRequestLifecycle?: (event: ProviderRequestLifecycleEvent<TIdentity>) => void;
  /**
   * Native raw path. `rawEvidence` saves the exact executor output and
   * `acceptRawFact` durably accepts each request-local raw fact. Both must be
   * bound together; older callers omit both and keep the event-only path.
   */
  readonly rawEvidence?: ProviderEvidenceSink;
  readonly acceptRawFact?: (envelope: RawFactEnvelope<TIdentity>) => Promise<AcceptedRawFact<TIdentity>>;
  /**
   * Native causal registration. When raw acceptance is enabled this port is
   * required: the driver awaits the 'dispatching' commit before the external
   * start/submit, then commits the remaining lifecycle phases. Legacy callers
   * that bind no raw sink leave this unset and keep the event-only path.
   */
  readonly registerRequest?: (registration: NativeRequestRegistration) => Promise<RuntimeRequestRecord>;
  /**
   * Fresh typed request-context materialization. When bound, the driver awaits
   * this hook after durable registration and before the external start/submit
   * of every initial request and every tool continuation, then sends the
   * returned canonical units plus request-scoped instructions instead of the
   * payload string and the driver-local tool history. The Runtime owns the
   * materialization; the driver never invents or caches context.
   */
  readonly requestContext?: ProviderRequestContextHook<TIdentity>;
  readonly now?: () => Date;
}

export type ProviderAgentDriverOptions<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> = ProviderAgentDriverCommonOptions<TIdentity> & (
  TIdentity extends TasklessProviderExecutionIdentityRef
    ? { readonly taskId?: never; readonly organId: OrganId; readonly helper: InteractionHelperIdentity }
    : TIdentity extends InteractionParentProviderExecutionIdentityRef
      ? {
          readonly taskId?: never;
          readonly helper?: never;
          readonly organId: OrganId;
          readonly interactionTurn: InteractionTurnIdentity;
        }
      : { readonly taskId: TaskId; readonly helper?: never }
);

export interface ProviderToolExecutionResult {
  readonly output: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly status?: ProviderToolStatus;
  readonly error?: ProviderError;
  readonly outputRef?: string;
  readonly outputDigest?: string;
  /** Route reported by the executor's actual branch; the driver never infers it from toolId. */
  readonly executorRoute?: string;
}

/**
 * The tool executor is bound to the same identity generic as the driver, so a
 * legacy Task caller keeps receiving a Task identity and a taskless helper
 * caller receives the helper identity. No second executor shape is introduced.
 */
export interface ProviderToolExecutionPort<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  canRunConcurrently?(call: ProviderToolCall): boolean;
  execute(input: {
    readonly execution: TIdentity;
    readonly scope: ScopeRef;
    readonly requestId?: string;
    readonly call: ProviderToolCall;
    readonly signal: AbortSignal;
  }): Promise<ProviderToolExecutionResult>;
}

export type ProviderAgentEvent<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> = AgentEvent<TIdentity> & {
  readonly summary?: string;
  readonly providerEvent: ProviderRequestScopedEvent<TIdentity>;
};

export type ProviderRequestScopedEvent<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> = ProviderEvent<TIdentity> & {
  readonly turnId: string;
  readonly requestId: string;
  readonly occurredAt: string;
};

function operationEvidence(scope: ScopeRef, operationId: OperationId): EvidenceRef {
  return {
    evidenceId: id('evidence', `operation-scope-${operationId.value}`),
    kind: 'operation',
    source: 'humanagent.provider-agent-driver',
    locator: `operation/${operationId.value}/scope`,
    scope,
  };
}

/**
 * Combines the Runtime materializer's request-scoped orientation with the
 * caller's one-shot continuation instructions. Both enter exactly this request;
 * neither is written back to canonical context or carried to the next request.
 */
function mergeRequestScopedInstructions(
  hook: RequestScopedInstructions | undefined,
  caller: RequestScopedInstructions,
): RequestScopedInstructions {
  if (hook === undefined) return caller;
  return { text: `${hook.text}\n${caller.text}` };
}

/**
 * The single execution identity this driver runs under: a Task identity for
 * legacy callers, a taskless helper identity when the caller binds a helper,
 * or a neutral interaction-parent identity when the caller binds the real
 * interaction turn. All three flow through the same lifecycle and ports.
 */
function resolveExecutionIdentity<TIdentity extends AnyProviderExecutionIdentityRef>(
  options: ProviderAgentDriverOptions<TIdentity>,
): TIdentity {
  let candidate: AnyProviderExecutionIdentityRef;
  if (options.helper !== undefined && options.organId !== undefined) {
    candidate = {
      runtimeId: options.runtimeId,
      organId: options.organId,
      operationId: options.operationId,
      executionEpoch: options.executionEpoch,
      helper: options.helper,
    };
  } else if (options.interactionTurn !== undefined && options.organId !== undefined && options.taskId === undefined) {
    candidate = {
      runtimeId: options.runtimeId,
      organId: options.organId,
      operationId: options.operationId,
      executionEpoch: options.executionEpoch,
      interactionTurn: options.interactionTurn,
    };
  } else if (options.taskId !== undefined) {
    candidate = {
      runtimeId: options.runtimeId,
      taskId: options.taskId,
      operationId: options.operationId,
      executionEpoch: options.executionEpoch,
    };
  } else {
    throw new ProviderAdapterError({
      code: 'runtime.identity.missing',
      category: 'runtime',
      phase: 'start',
      message: 'provider agent driver requires a task identity, a helper identity, or an interaction turn identity',
      scope: options.scope,
    });
  }
  try {
    // The single construction boundary: the shared contract validator proves the
    // assembled identity before it becomes the driver's execution. A taskless
    // helper identity must carry a full helper and no task/cycle; a legacy Task
    // identity must carry a task. Nothing downstream re-checks with a bare cast.
    // An interaction-parent identity must carry the real interaction turn and
    // no task, cycle or helper.
    assertProviderExecutionIdentity(candidate);
  } catch (error) {
    throw new ProviderAdapterError({
      code: 'runtime.identity.invalid',
      category: 'runtime',
      phase: 'start',
      message: error instanceof Error ? error.message : 'provider agent driver received an invalid execution identity',
      scope: options.scope,
    });
  }
  return candidate as TIdentity;
}

function sameExecution(expected: AnyProviderExecutionIdentityRef, actual: AnyProviderExecutionIdentityRef): boolean {
  // Reuse the contract identity-match validator instead of a second comparison.
  try {
    assertProviderExecutionIdentityMatch(actual, expected);
    return true;
  } catch {
    return false;
  }
}

/**
 * Identity fields a provider-side result/event must echo. Keeping this in one
 * place means the Task and taskless shapes share the same projection.
 */
function isProviderError(value: unknown): value is ProviderError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProviderError>;
  return typeof candidate.errorId === 'string'
    && typeof candidate.code === 'string'
    && typeof candidate.message === 'string'
    && Array.isArray(candidate.evidenceRefs);
}

/** True only for the taskless helper identity (a bound `helper`, never a Task). */
function isTasklessIdentity(value: object): value is TasklessProviderExecutionIdentityRef {
  return 'helper' in value && value.helper !== undefined;
}

/**
 * A tool-waiting terminal is a real typed executable call (at least one decoded
 * `toolCall`) plus a `waiting` terminal whose next action continues. It is not
 * tied to one protocol's continuation ref, so Responses, Chat and Anthropic all
 * qualify without inferring control from `outputRefs` or payload text.
 */
function isToolWaiting<TIdentity extends AnyProviderExecutionIdentityRef>(
  event: ProviderEvent<TIdentity> | undefined,
  toolCalls: readonly ProviderToolCall[],
): boolean {
  return event !== undefined
    && event.terminalState === 'waiting'
    && toolCalls.length > 0
    && event.nextAction?.kind === 'continue';
}

interface RequestAttempt {
  readonly turnId: string;
  readonly requestId: string;
  readonly parentRequestId?: string;
  producerSeq: number;
  externalResponseId?: string;
  terminalPhase?: ProviderRequestLifecycleEvent['phase'];
}

function requestIdentityRef(request: RequestAttempt): ActiveTurnProviderRequestIdentityRef {
  return {
    turnId: request.turnId,
    requestId: request.requestId,
    ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
  };
}

/**
 * The registration ack must echo the submitted request identity, scope and
 * phase. A different phase, identity or scope means the Runtime persisted a
 * different fact than the driver asked for, so native dispatch must not trust it.
 */
function sameRegistrationAck(ack: RuntimeRequestRecord, expected: RuntimeRequestRecord): boolean {
  return ack.phase === expected.phase
    && ack.parentRequestId === expected.parentRequestId
    && ack.request.turnId === expected.request.turnId
    && ack.request.requestId === expected.request.requestId
    && ack.request.parentRequestId === expected.request.parentRequestId
    && ack.scope.organId.value === expected.scope.organId.value
    && ack.scope.taskId?.value === expected.scope.taskId?.value
    && ack.scope.operationId?.value === expected.scope.operationId?.value;
}

function requestIdentity(kind: 'turn' | 'request'): string {
  return `${kind}-${randomUUID()}`;
}

export class ProviderAgentDriver<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> implements AgentDriver<TIdentity> {
  readonly kind = 'humanagent.provider-agent-driver';

  private handle?: AgentHandle;
  private providerStarted = false;
  private providerSettlement?: ProviderSettlement<TIdentity>;
  private readonly port: ExecutionRuntimePort<TIdentity>;
  private readonly execution: TIdentity;
  private readonly evidenceRef: EvidenceRef;
  private stopping = false;
  private readonly toolControllers = new Set<AbortController>();
  private toolBarrier?: ToolBarrier;
  private continuationCompletion?: Promise<void>;
  private initialPayload?: BusinessPayload;
  private turnId?: string;
  private readonly initialParentRequest?: ActiveTurnProviderRequestIdentityRef;
  private activeRequest?: RequestAttempt;
  private readonly requests: RequestAttempt[] = [];
  private readonly inflight = new Set<Promise<unknown>>();
  private observeIterator?: AsyncIterator<ProviderEvent<TIdentity>>;
  private productionClosed = false;
  private producerFailure?: unknown;
  private unconsumedToolFailure?: unknown;
  private executionSettled = false;
  private continuationInFlight = false;
  private readonly now: () => Date;

  constructor(private readonly options: ProviderAgentDriverOptions<TIdentity>) {
    this.execution = resolveExecutionIdentity(options);
    this.port = options.port;
    if ((options.rawEvidence === undefined) !== (options.acceptRawFact === undefined)) {
      throw this.error(
        'raw.persistence.incomplete',
        'native raw persistence requires both an evidence sink and a raw-fact acceptance port',
        'start',
        'runtime',
      );
    }
    if (options.acceptRawFact !== undefined && options.registerRequest === undefined) {
      throw this.error(
        'raw.registration.incomplete',
        'native raw acceptance requires a causal request registration port',
        'start',
        'runtime',
      );
    }
    if (options.parentRequest !== undefined) {
      const parent = options.parentRequest;
      if (typeof parent.turnId !== 'string' || parent.turnId.trim() === ''
        || typeof parent.requestId !== 'string' || parent.requestId.trim() === ''
        || (parent.parentRequestId !== undefined
          && (typeof parent.parentRequestId !== 'string'
            || parent.parentRequestId.trim() === ''
            || parent.parentRequestId === parent.requestId))) {
        throw this.error(
          'runtime.identity.invalid',
          'provider agent driver received an invalid parent request identity',
          'start',
          'runtime',
        );
      }
      this.initialParentRequest = {
        turnId: parent.turnId,
        requestId: parent.requestId,
        ...(parent.parentRequestId === undefined ? {} : { parentRequestId: parent.parentRequestId }),
      };
      this.turnId = this.initialParentRequest.turnId;
    }
    this.evidenceRef = operationEvidence(options.scope, options.operationId);
    this.now = options.now ?? (() => new Date());
  }

  async capabilities(): Promise<AgentCapabilities> {
    const capabilities = await this.port.capabilities(this.options.binding);
    return {
      driverKind: this.kind,
      capabilities: capabilities.capabilities,
      version: capabilities.version,
    };
  }

  hasAcquiredExecution(): boolean {
    return this.providerStarted;
  }

  async start(input: AgentStartRequest<TIdentity>): Promise<AgentHandle> {
    this.assertIdentity(input);
    if (this.handle) throw this.error('runtime.already.started', 'provider agent driver is already started', 'start');
    this.handle = { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
    return this.handle;
  }

  async resume(_input: AgentResumeRequest): Promise<AgentHandle> {
    throw this.error(
      'resume.unsupported',
      'provider agent driver cannot resume a provider stream from a checkpoint',
      'resume',
      'capability',
    );
  }

  async submit(input: AgentInput<TIdentity>): Promise<AgentOutput<TIdentity>> {
    if (!this.handle) throw this.error('runtime.not.started', 'provider agent driver has not started', 'submit');
    if (this.providerStarted) throw this.error('runtime.already.submitted', 'provider execution was already submitted', 'submit');
    if (this.productionClosed) {
      throw this.error('provider.production.closed', 'provider production was closed; no new request can be dispatched', 'submit', 'runtime');
    }
    if (!this.sameEnvelope(input)) {
      throw this.error('runtime.identity.mismatch', 'provider submit is not bound to the current execution', 'submit', 'runtime');
    }
    const request = this.nextRequest();
    await this.commitRequestPhase(request, 'dispatching');
    this.publishLifecycle(request, 'dispatching');
    let receipt: ProviderStartReceipt<TIdentity>;
    try {
      const context = await this.materializeRequestContext(request, 'initial');
      receipt = await this.track(this.port.start({
        ...this.execution,
        ...this.currentRequestIdentity(),
        inputRefs: [...this.options.inputRefs],
        evidenceRefs: [this.evidenceRef],
        payload: input.payload,
        ...this.requestContextFields(context),
        ...(this.options.tools === undefined ? {} : { tools: this.options.tools }),
      }));
      this.providerStarted = true;
      this.assertProviderIdentity(receipt, 'provider start receipt', 'start');
    } catch (cause) {
      if (!this.stopping) await this.publishFailed(request, cause, 'start');
      throw cause;
    }
    this.initialPayload = input.payload;
    await this.commitRequestPhase(request, 'dispatched');
    this.publishLifecycle(request, 'dispatched', [], receipt.evidenceRefs);
    const output: AgentOutput<TIdentity> = {
      ...input,
      assignmentId: input.assignmentId,
      payload: { mode: 'provider', status: 'accepted' } as BusinessPayload,
      outputRefs: [],
      evidenceRefs: [...receipt.evidenceRefs],
    };
    return output;
  }

  /**
   * Continues the current business turn with a fresh Provider request on the
   * same admitted execution, turn and parent chain. The previous request must
   * be fully observed and its request-level terminal committed; the Provider
   * execution, driver and turn stay open. The caller's instructions enter this
   * request only, and the caller still owns execution settle/close.
   */
  async continueCurrentTurn(input: {
    readonly instructions: RequestScopedInstructions;
  }): Promise<ProviderSubmitResult<TIdentity>> {
    if (!this.handle) throw this.error('runtime.not.started', 'provider agent driver has not started', 'submit');
    if (!this.providerStarted) throw this.error('runtime.not.submitted', 'provider execution has not been submitted', 'submit', 'runtime');
    if (this.productionClosed) throw this.error('provider.production.closed', 'provider production was closed; no continuation can be dispatched', 'submit', 'runtime');
    if (this.stopping) throw this.error('provider.stop.requested', 'provider stop was requested; the current turn cannot continue', 'submit', 'runtime');
    if (this.executionSettled) throw this.error('provider.execution.settled', 'provider execution settlement started; the current turn cannot continue', 'submit', 'runtime');
    if (this.producerFailure !== undefined) throw this.producerFailure;
    if (this.continuationInFlight) throw this.error('continuation.overlap', 'another continuation is already dispatching', 'submit', 'runtime');
    const previous = this.activeRequest;
    if (previous === undefined || previous.terminalPhase !== 'settled') {
      throw this.error('continuation.not.quiescent', 'the current request is not fully observed and settled', 'submit', 'runtime');
    }
    if (this.options.requestContext === undefined) {
      throw this.error('request.context.missing', 'continueCurrentTurn requires a bound request-context hook', 'submit', 'capability');
    }
    // Occupy dispatch admission before the first await so two callers can never
    // register the same continuation turn concurrently.
    this.continuationInFlight = true;
    const request = this.nextRequest();
    const work = (async (): Promise<ProviderSubmitResult<TIdentity>> => {
      await this.commitRequestPhase(request, 'dispatching');
      this.publishLifecycle(request, 'dispatching');
      this.assertDispatchOpen();
      const context = await this.materializeRequestContext(request, 'continuation');
      if (context === undefined) {
        throw this.error('request.context.missing', 'continueCurrentTurn requires a bound request-context hook', 'submit', 'capability');
      }
      // A stop or drain can begin while registration or the context hook was
      // awaited; never dispatch across that boundary.
      this.assertDispatchOpen();
        const submitted = await this.port.submit({
        ...this.execution,
        ...this.continuationRequestIdentity(request),
        inputRefs: [...this.options.inputRefs],
        evidenceRefs: [this.evidenceRef],
        payload: this.initialPayload ?? inputPayloadMissing(),
        requestContext: context.canonical,
        instructions: mergeRequestScopedInstructions(context.instructions, input.instructions),
        ...(this.options.tools === undefined ? {} : { tools: this.options.tools }),
      });
      this.assertProviderIdentity(submitted, 'provider continuation receipt', 'submit');
      await this.commitRequestPhase(request, 'dispatched');
      this.publishLifecycle(request, 'dispatched', [], submitted.evidenceRefs);
      return submitted;
    })();
    try {
      return await this.track(work);
    } catch (cause) {
      if (!this.stopping) await this.publishFailed(request, cause, 'submit');
      throw cause;
    } finally {
      this.continuationInFlight = false;
    }
  }

  async *observe(input: { readonly runtimeId: string }): AsyncIterable<ProviderAgentEvent<TIdentity>> {
    if (!this.providerStarted) throw this.error('runtime.not.submitted', 'provider execution has not been submitted', 'observe', 'runtime');
    if (this.productionClosed) {
      throw this.error('provider.production.closed', 'provider production was closed; the stream cannot be re-entered', 'observe', 'runtime');
    }
    if (input.runtimeId !== this.options.runtimeId) {
      throw this.error('runtime.identity.mismatch', 'provider observe is not bound to the current execution', 'observe', 'runtime');
    }
    let rounds = 0;
    // A Responses continuation has no server-side conversation state here, so
    // the request must replay the whole tool history. Carrying only the current
    // round would hide every earlier round from the model, which makes a
    // multi-round task rewrite its own deliverables forever.
    const toolHistory: Array<{ readonly call: ProviderToolCall; readonly result: ProviderToolExecutionResult }> = [];
    while (true) {
      const toolCalls: ProviderToolCall[] = [];
      let terminal: ProviderEvent<TIdentity> | undefined;
      const request = this.activeRequest;
      const onRawFacts = this.rawFactReceiver(request);
      const observeInput: ProviderObserveInputWithRawFacts<TIdentity> = {
        ...this.execution,
        ...this.currentRequestIdentity(),
        ...(onRawFacts === undefined ? {} : { onRawFacts }),
      };
      const providerIterator = this.port.observe(observeInput)[Symbol.asyncIterator]();
      this.observeIterator = providerIterator;
      try {
        while (true) {
          const step = await providerIterator.next();
          if (step.done === true) break;
          const providerEvent = step.value;
          this.assertProviderIdentity(providerEvent, 'provider event', 'observe');
          if (providerEvent.toolCall !== undefined) toolCalls.push(providerEvent.toolCall);
          if (providerEvent.terminalState !== undefined) terminal = providerEvent;
          await this.publishObservedLifecycle(providerEvent);
          if (isToolWaiting(providerEvent, toolCalls)) continue;
          yield this.agentEvent(providerEvent, request);
        }
      } finally {
        if (this.observeIterator === providerIterator) this.observeIterator = undefined;
        await this.closeProviderIterator(providerIterator);
      }
      if (this.stopping || this.productionClosed) return;
      if (toolCalls.length === 0) {
        // Only a confirmed normal terminal makes the fully observed request
        // continuable. Preserve waiting, unknown and existing failure facts;
        // execution settle/close stays caller-owned.
        if (terminal?.terminalState === 'succeeded') await this.commitObservedCompletion(request);
        return;
      }
      if (!isToolWaiting(terminal, toolCalls)) {
        throw this.error('tool.terminal.missing', 'provider emitted a tool call without a tool-waiting terminal', 'observe', 'runtime');
      }
      if (request === undefined) {
        throw this.error('runtime.request.missing', 'provider emitted a tool call outside a request scope', 'observe', 'runtime');
      }
      if (this.options.executeTool === undefined || this.options.tools === undefined) {
        throw this.error('tool.executor.missing', 'provider requested a tool but no execution port is bound', 'observe', 'capability');
      }
      if (this.productionClosed) {
        throw this.error('provider.production.closed', 'provider production was closed; no new tool work can start', 'observe', 'runtime');
      }
      rounds += 1;
      if (this.options.maxToolRounds !== undefined && rounds > this.options.maxToolRounds) {
        const error = this.error('tool.round-limit', 'provider tool round limit was exceeded', 'observe', 'runtime');
        for (const call of toolCalls) {
          const result: ProviderToolExecutionResult = {
            output: JSON.stringify({
              status: 'failed',
              code: error.providerError.code,
              executed: false,
              toolId: call.toolId,
              callId: call.callId,
              message: error.providerError.message,
            }),
            outputRefs: [],
            evidenceRefs: error.providerError.evidenceRefs,
            status: 'failed',
            error: error.providerError,
          };
          const toolResult = this.toolResult(request, call, result, 'failed');
          try {
            await this.track(this.persistToolResult(request, call, result, toolResult));
          } catch (cause) {
            this.recordProducerFailure(cause);
            throw cause;
          }
        }
        throw error;
      }
      for (let callIndex = 0; callIndex < toolCalls.length;) {
        const call = toolCalls[callIndex]!;
        if (this.stopping) return;
        // The declared tool list IS this Harness's tool surface. A backend
        // harness tool the model reached for anyway (for example a shell or
        // exec_command) must come back as a typed observation the model can
        // correct, not as a fatal error that strands the execution.
        if (!(this.options.tools ?? []).some((tool) => tool.toolId === call.toolId)) {
          const unowned = this.unownedToolResult(call);
          const toolResult = this.toolResult(request, call, unowned, 'failed');
          try {
            await this.track(this.persistToolResult(request, call, unowned, toolResult));
          } catch (cause) {
            this.recordProducerFailure(cause);
            throw cause;
          }
          if (this.stopping) return;
          yield* this.toolResultEvents(request, call, toolResult, `${call.toolId} unavailable`);
          toolHistory.push({ call, result: unowned });
          callIndex += 1;
          continue;
        }
        const batch = [call];
        if (this.options.executeTool.canRunConcurrently?.(call) === true) {
          for (const candidate of toolCalls.slice(callIndex + 1)) {
            if (!(this.options.tools ?? []).some((tool) => tool.toolId === candidate.toolId)) break;
            if (this.options.executeTool.canRunConcurrently?.(candidate) !== true) break;
            batch.push(candidate);
          }
        }
        yield* this.executeToolBatch(request, batch, this.options.executeTool, toolHistory);
        callIndex += batch.length;
      }
      if (this.stopping) return;
      await this.commitObservedCompletion(request);
      if (this.stopping) return;
      let completeContinuation!: () => void;
      const continuationCompletion = new Promise<void>((resolve) => { completeContinuation = resolve; });
      this.continuationCompletion = continuationCompletion;
      let submitted: ProviderSubmitResult<TIdentity>;
      const continuation = this.nextRequest();
      try {
        await this.commitRequestPhase(continuation, 'dispatching');
        this.publishLifecycle(continuation, 'dispatching');
        if (this.stopping) return;
        const context = await this.materializeRequestContext(continuation, 'continuation');
        if (this.stopping) return;
        submitted = await this.track(this.port.submit({
          ...this.execution,
          ...this.continuationRequestIdentity(continuation),
          inputRefs: [...this.options.inputRefs],
          evidenceRefs: toolHistory.flatMap(({ result }) => result.evidenceRefs),
          payload: this.initialPayload ?? inputPayloadMissing(),
          ...(this.options.tools === undefined ? {} : { tools: this.options.tools }),
          ...(context === undefined
            ? {
                toolContinuations: toolHistory.map(({ call, result }) => ({
                  callId: call.callId,
                  toolId: call.toolId,
                  arguments: call.arguments,
                evidenceRefs: result.evidenceRefs,
                  continuationRef: call.continuationRef,
                  output: result.output,
                })),
              }
            : this.requestContextFields(context)),
        }));
        this.assertProviderIdentity(submitted, 'provider tool continuation receipt', 'submit');
        if (!this.stopping) {
          await this.commitRequestPhase(continuation, 'dispatched');
          this.publishLifecycle(continuation, 'dispatched', [], submitted.evidenceRefs);
        }
      } catch (cause) {
        if (!this.stopping) await this.publishFailed(continuation, cause, 'submit');
        throw cause;
      } finally {
        completeContinuation();
        if (this.continuationCompletion === continuationCompletion) this.continuationCompletion = undefined;
      }
      if (submitted.status !== 'accepted' && submitted.status !== 'completed') {
        throw this.error('tool.continuation.rejected', submitted.error?.message ?? 'provider rejected the tool continuation', 'submit', 'runtime', submitted.error);
      }
    }
  }

  async requestStop(input: { readonly runtimeId: string; readonly executionEpoch: number; readonly operationId: OperationId }): Promise<StopRequestReceipt> {
    if (!this.providerStarted) throw this.error('runtime.not.submitted', 'provider execution has not been submitted', 'stop', 'runtime');
    if (input.runtimeId !== this.options.runtimeId
      || input.executionEpoch !== this.options.executionEpoch
      || input.operationId.value !== this.options.operationId.value) {
      throw this.error('runtime.identity.mismatch', 'provider stop is not bound to the current execution', 'stop', 'runtime');
    }
    this.stopping = true;
    for (const controller of this.toolControllers) {
      controller.abort(new DOMException('operator requested stop', 'AbortError'));
    }
    let receipt: ProviderStopReceipt<TIdentity>;
    try {
      receipt = await this.port.requestStop({
        ...this.execution,
        ...this.currentRequestIdentity(),
        reason: 'operator requested stop',
        ownerId: this.options.ownerId ?? 'humanagent.app',
      });
    } catch (cause) {
      if (!this.stopping && this.activeRequest) await this.publishFailed(this.activeRequest, cause, 'stop');
      throw cause;
    }
    this.assertProviderIdentity(receipt, 'provider stop receipt', 'stop');
    return { requested: receipt.status !== 'rejected', operationId: receipt.operationId };
  }

  async settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure> {
    if (input.runtimeId !== this.options.runtimeId || input.executionEpoch !== this.options.executionEpoch) {
      throw this.error('runtime.identity.mismatch', 'provider settle is not bound to the current execution', 'settle', 'runtime');
    }
    // Once execution settlement starts the public continuation entry point is
    // closed; request-level bookkeeping never releases the execution.
    this.executionSettled = true;
    if (this.toolBarrier) await this.toolBarrier.promise;
    if (this.continuationCompletion) await this.continuationCompletion;
    // A failed exact-output save or durable acceptance must surface on settle;
    // the released barrier must never turn a producer failure into a normal
    // stopped result.
    if (this.outstandingFailure() !== undefined) throw this.outstandingFailure();
    let settlement: ProviderSettlement<TIdentity>;
    try {
      settlement = await this.port.settle({
        ...this.execution,
        ...this.currentRequestIdentity(),
      });
    } catch (cause) {
      if (!this.stopping && this.activeRequest) await this.publishFailed(this.activeRequest, cause, 'settle');
      throw cause;
    }
    this.assertProviderIdentity(settlement, 'provider settlement', 'settle');
    this.providerSettlement = settlement;
    const request = this.activeRequest;
    if (request !== undefined && request.terminalPhase === undefined) {
      if (settlement.state === 'cancelled' || settlement.state === 'stopped') {
        await this.commitRequestPhase(request, 'cancelled');
        this.publishLifecycle(request, 'cancelled', [], settlement.evidenceRefs, request.externalResponseId);
      } else if (settlement.state === 'succeeded') {
        await this.commitRequestPhase(request, 'settled');
        this.publishLifecycle(request, 'settled', [], settlement.evidenceRefs, request.externalResponseId);
      } else if (settlement.error !== undefined) {
        await this.publishFailed(request, settlement.error, 'settle');
      }
    }
    return { state: settlement.state, evidenceRefs: [...settlement.evidenceRefs] };
  }

  async close(): Promise<ProviderCloseResult> {
    return this.port.close(this.options.binding);
  }

  settlement(): ProviderSettlement<TIdentity> | undefined {
    return this.providerSettlement ? structuredClone(this.providerSettlement) : undefined;
  }

  /**
   * Synchronously closes new request/tool admission, then awaits the work that
   * already entered the driver: the external start/submit, tool executor
   * execution, exact-output write and durable raw acceptance. A recorded
   * producer failure is rethrown so a drain failure never reads as a normal
   * stopped settlement. The result binds only the request identities the driver
   * actually created and their final producer sequence.
   */
  async closeProductionAndDrain(input: {
    readonly execution: ActiveTurnProviderExecutionIdentityRef;
    readonly boundaryId: string;
  }): Promise<ProviderProducerDrainResult> {
    this.productionClosed = true;
    if (input.execution.runtimeId !== this.options.runtimeId
      || input.execution.executionEpoch !== this.options.executionEpoch) {
      throw this.error('runtime.identity.mismatch', 'provider drain is not bound to the current execution', 'settle', 'runtime');
    }
    // Close the live provider iterator first: this awaits the current
    // decode/raw-ack step and tears the stream down, so the drain result covers
    // the observing work, not only the start/tool promises.
    const iterator = this.observeIterator;
    if (iterator !== undefined) await this.closeProviderIterator(iterator);
    // Re-check after each settle: admitted work can schedule the next unit
    // (for example, a tool result write+ack after the executor resolves) after
    // the drain started. Production is closed, so the set only grows to the
    // already-admitted boundary and then stops.
    while (true) {
      const batch = [...this.inflight];
      await Promise.allSettled(batch);
      if (this.inflight.size === batch.length) break;
    }
    if (this.outstandingFailure() !== undefined) throw this.outstandingFailure();
    return {
      execution: { runtimeId: this.options.runtimeId, executionEpoch: this.options.executionEpoch },
      boundaryId: input.boundaryId,
      requests: this.requests.map((request) => ({
        request: requestIdentityRef(request),
        lastProducerSeq: request.producerSeq,
      })),
    };
  }

  /**
   * Awaits the Runtime registration of one request lifecycle phase before the
   * matching external effect. A missing port (legacy event-only caller) is a
   * no-op; a rejected registration or a phase/identity/scope-mismatched ack
   * aborts the dispatch so the driver never runs an unregistered request.
   */
  private async commitRequestPhase(request: RequestAttempt, phase: RuntimeRequestLifecyclePhase): Promise<void> {
    const register = this.options.registerRequest;
    if (register === undefined) return;
    const record: RuntimeRequestRecord = {
      request: requestIdentityRef(request),
      ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
      scope: this.options.scope,
      phase,
    };
    const registration: NativeRequestRegistration = {
      execution: { runtimeId: this.options.runtimeId, executionEpoch: this.options.executionEpoch },
      record,
    };
    let ack: RuntimeRequestRecord;
    try {
      ack = await register(registration);
    } catch (cause) {
      throw this.error(
        'request.registration.failed',
        `runtime rejected the ${phase} registration for ${request.requestId}`,
        'submit',
        'runtime',
        cause,
      );
    }
    if (!sameRegistrationAck(ack, record)) {
      throw this.error(
        'request.registration.ack-mismatch',
        `runtime registration ack does not match the submitted ${phase} request record`,
        'submit',
        'runtime',
      );
    }
  }

  /**
   * Awaits the Runtime-owned materialization of this request's typed context.
   * A hook rejection propagates to the caller and fails the request; the driver
   * never falls back to an earlier context.
   */
  private async materializeRequestContext(
    request: RequestAttempt,
    phase: ProviderRequestContextPhase,
  ): Promise<MaterializedRequestInput | undefined> {
    const hook = this.options.requestContext;
    if (hook === undefined) return undefined;
    return hook({
      execution: this.execution,
      request: requestIdentityRef(request),
      phase,
    });
  }

  private requestContextFields(context: MaterializedRequestInput | undefined): {
    readonly requestContext?: ProviderRequestContext;
    readonly instructions?: RequestScopedInstructions;
  } {
    if (context === undefined) return {};
    return {
      requestContext: context.canonical,
      ...(context.instructions === undefined ? {} : { instructions: context.instructions }),
    };
  }

  /**
   * Keeps a promise visible to `closeProductionAndDrain`. Settled promises stay
   * in the set so the drain can detect work that was scheduled while it was
   * waiting, instead of snapshotting too early.
   */
  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    return promise;
  }

  private recordProducerFailure(cause: unknown): void {
    if (this.producerFailure === undefined) this.producerFailure = cause;
  }

  private async *executeToolBatch(
    request: RequestAttempt,
    calls: readonly ProviderToolCall[],
    port: ProviderToolExecutionPort<TIdentity>,
    toolHistory: Array<{ readonly call: ProviderToolCall; readonly result: ProviderToolExecutionResult }>,
  ): AsyncGenerator<ProviderAgentEvent<TIdentity>, void, void> {
    const controllers = calls.map(() => new AbortController());
    for (const controller of controllers) this.toolControllers.add(controller);
    const toolBarrier = createToolBarrier();
    this.toolBarrier = toolBarrier;
    let released = false;
    const releaseBarrier = (): void => {
      if (released) return;
      released = true;
      for (const controller of controllers) this.toolControllers.delete(controller);
      toolBarrier.release();
      if (this.toolBarrier === toolBarrier) this.toolBarrier = undefined;
    };

    try {
      // Track execution and durable persistence as one producer so draining
      // cannot finish in the microtask gap between those phases.
      const { outcomes, toolResults, persistenceFailure } = await this.track((async () => {
        const outcomes = await Promise.allSettled(calls.map(async (call, index) => port.execute({
          execution: this.execution,
          scope: this.options.scope,
          ...(this.activeRequest === undefined ? {} : { requestId: this.activeRequest.requestId }),
          call,
          signal: controllers[index]!.signal,
        }))).then((settled) => settled.map((entry, index): ProviderToolExecutionOutcome => entry.status === 'fulfilled'
          ? { call: calls[index]!, result: entry.value }
          : { call: calls[index]!, cause: entry.reason }));

        const toolResults = new Map<string, { readonly status: ProviderToolStatus; readonly result: ProviderToolResult<TIdentity> }>();
        let persistenceFailure: unknown;
        // Persist every started call before releasing the barrier. A later failed
        // result must not erase a successful sibling's exact output.
        for (const outcome of outcomes) {
          if (!('result' in outcome)) continue;
          const status = this.toolStatus(outcome.result);
          const result = this.toolResult(request, outcome.call, outcome.result, status);
          toolResults.set(outcome.call.callId, { status, result });
          try {
            await this.persistToolResult(request, outcome.call, outcome.result, result);
          } catch (cause) {
            this.recordProducerFailure(cause);
            persistenceFailure ??= cause;
          }
        }
        return { outcomes, toolResults, persistenceFailure };
      })());

      // A suspended consumer must never hold settlement: all durable work above
      // is complete, so release before the first projection yield.
      releaseBarrier();
      if (persistenceFailure !== undefined) throw persistenceFailure;

      for (const outcome of outcomes) {
        if ('cause' in outcome) {
          if (this.stopping) {
            yield* this.toolFailedEvents(request, outcome.call, outcome.cause, 'cancelled');
            continue;
          }
          if (this.unconsumedToolFailure === undefined) this.unconsumedToolFailure = outcome.cause;
          yield* this.toolFailedEvents(request, outcome.call, outcome.cause, 'failed');
          if (this.unconsumedToolFailure === outcome.cause) this.unconsumedToolFailure = undefined;
          throw outcome.cause;
        }
        const toolResult = toolResults.get(outcome.call.callId)!;
        if (this.stopping) continue;
        if (toolResult.status !== 'succeeded') {
          yield* this.toolResultEvents(request, outcome.call, toolResult.result, `${outcome.call.toolId} ${toolResult.status}`);
          if (
            (outcome.result.status === 'failed' && isStandardTurnEndToolId(outcome.call.toolId))
            || (
              toolResult.result.status === 'blocked'
              && toolResult.result.error?.retryable === 'retryable'
              && toolResult.result.error.nextAction.kind === 'wait'
            )
            || this.modelCorrectableFailure(toolResult.result)
          ) {
            toolHistory.push({ call: outcome.call, result: outcome.result });
            continue;
          }
          throw this.toolResultFailure(toolResult.result);
        }
        yield* this.toolResultEvents(request, outcome.call, toolResult.result, `${outcome.call.toolId} succeeded`);
        toolHistory.push({ call: outcome.call, result: outcome.result });
      }
    } finally {
      releaseBarrier();
    }
  }

  /**
   * The failure a close/settle must surface before it can report success. A
   * durable producer failure (exact-output save, raw-fact acceptance, iterator
   * close) is permanent. An unconsumed tool-execution rejection is only latched
   * while observe() is suspended in the failed tool events before `throw`; once
   * that throw reaches the caller it is cleared so the port settle still runs.
   */
  private outstandingFailure(): unknown {
    return this.producerFailure ?? this.unconsumedToolFailure;
  }

  /**
   * Closes the provider observe iterator explicitly instead of relying on the
   * implicit `for await` teardown. Awaited so the driver waits for the current
   * decode/raw-ack work before reporting a drain; a close failure is recorded
   * so an incomplete teardown surfaces instead of reading as a clean drain.
   */
  private async closeProviderIterator(iterator: AsyncIterator<ProviderEvent<TIdentity>>): Promise<void> {
    if (iterator.return === undefined) return;
    try {
      await iterator.return();
    } catch (cause) {
      this.recordProducerFailure(this.error(
        'provider.observe.close.failed',
        'provider observe iterator did not close cleanly',
        'observe',
        'runtime',
        cause,
      ));
    }
  }

  private agentEvent(providerEvent: ProviderEvent<TIdentity>, request: RequestAttempt | undefined): ProviderAgentEvent<TIdentity> {
    const scoped = this.scopeProviderEvent(providerEvent, request);
    const event = {
      ...providerEvent,
      kind: providerEvent.kind === 'tool' && providerEvent.toolPhase === 'result'
        ? 'provider.tool-result'
        : `provider.${providerEvent.kind}`,
      evidenceRefs: providerEvent.evidenceRefs,
      summary: providerEvent.summary,
      ...(providerEvent.terminalState === undefined ? {} : { terminalState: providerEvent.terminalState }),
      providerEvent: scoped,
    };
    return event;
  }

  private scopeProviderEvent(providerEvent: ProviderEvent<TIdentity>, request: RequestAttempt | undefined): ProviderRequestScopedEvent<TIdentity> {
    if (request === undefined) {
      throw this.error('runtime.request.missing', 'provider event arrived outside a request scope', 'observe', 'runtime');
    }
    if (providerEvent.turnId !== undefined && providerEvent.turnId !== request.turnId) {
      throw this.error('runtime.identity.mismatch', 'provider event turn id does not match the active driver attempt', 'observe', 'runtime');
    }
    if (providerEvent.requestId !== undefined && providerEvent.requestId !== request.requestId) {
      throw this.error('runtime.identity.mismatch', 'provider event request id does not match the active request', 'observe', 'runtime');
    }
    if (providerEvent.parentRequestId !== undefined && providerEvent.parentRequestId !== request.parentRequestId) {
      throw this.error('runtime.identity.mismatch', 'provider event parent request id does not match the active request', 'observe', 'runtime');
    }
    return {
      ...providerEvent,
      turnId: request.turnId,
      requestId: request.requestId,
      ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
      occurredAt: providerEvent.occurredAt ?? this.now().toISOString(),
      ...(providerEvent.externalResponseId === undefined ? {} : { externalResponseId: providerEvent.externalResponseId }),
    };
  }

  private rawFactReceiver(request: RequestAttempt | undefined): ProviderRawFactReceiver<TIdentity> | undefined {
    if (this.options.acceptRawFact === undefined) return undefined;
    return async (rawFacts) => {
      for (const fact of rawFacts) {
        await this.acceptRawFact(request, fact);
      }
    };
  }

  private async acceptRawFact(request: RequestAttempt | undefined, fact: ProviderRawFact<TIdentity>): Promise<void> {
    const accept = this.options.acceptRawFact;
    if (accept === undefined) return;
    if (request === undefined) {
      throw this.error('runtime.request.missing', 'provider raw fact arrived outside a request scope', 'observe', 'runtime');
    }
    const envelope: RawFactEnvelope<TIdentity> = {
      execution: { runtimeId: this.options.runtimeId, executionEpoch: this.options.executionEpoch },
      scope: this.options.scope,
      request: {
        turnId: request.turnId,
        requestId: request.requestId,
        ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
      },
      producerSeq: this.nextProducerSeq(request),
      fact,
    };
    let accepted: AcceptedRawFact<TIdentity>;
    try {
      accepted = await accept(envelope);
    } catch (cause) {
      const failure = this.error('raw.fact.accept.failed', 'provider raw fact was rejected by durable acceptance', 'observe', 'runtime', cause);
      this.producerFailure = failure;
      throw failure;
    }
    if (JSON.stringify(accepted.envelope) !== JSON.stringify(envelope)) {
      const failure = this.error('raw.fact.ack.mismatch', 'durable acceptance ack does not match the submitted raw fact envelope', 'observe', 'runtime');
      this.producerFailure = failure;
      throw failure;
    }
  }

  private nextProducerSeq(request: RequestAttempt): number {
    request.producerSeq += 1;
    return request.producerSeq;
  }

  /**
   * Saves the exact executor output string as an immutable raw asset, then
   * durably accepts the tool-result raw fact bound to the frozen request, call
   * and continuation. Both steps run before any projection or continuation, so
   * a late result still reaches the Runtime and a failed save or acceptance is
   * visible instead of reading as a normal stop. A legacy caller that binds no
   * raw sink keeps the previous event-only behavior.
   */
  private async persistToolResult(
    request: RequestAttempt,
    call: ProviderToolCall,
    result: ProviderToolExecutionResult,
    toolResult: ProviderToolResult<TIdentity>,
  ): Promise<void> {
    const sink = this.options.rawEvidence;
    if (sink === undefined) return;
    let ref: EvidenceRef;
    try {
      ref = await sink.write({
        scope: this.options.scope,
        kind: 'tool',
        type: 'tool-result-output',
        locator: `provider/tool-result/${call.callId}`,
        content: result.output,
      });
    } catch (cause) {
      throw this.error(
        'raw.output.save.failed',
        `provider exact tool output could not be saved for ${call.callId}`,
        'observe',
        'runtime',
        cause,
      );
    }
    const rawOutput: RawAsset = { ref, view: { kind: 'utf8-text' } };
    const fact: ProviderRawFact<TIdentity> = {
      kind: 'tool-result',
      contentUnitId: `provider:tool-result:${call.callId}`,
      callId: call.callId,
      continuationRef: call.continuationRef,
      result: toolResult,
      rawOutput,
      complete: true,
    };
    await this.acceptRawFact(request, fact);
  }

  private nextRequest(): RequestAttempt {
    // A new driver instance continuing a reconciled turn must anchor its first
    // request to the settled parent leaf instead of becoming a second root.
    const parentRequestId = this.activeRequest?.requestId
      ?? (this.requests.length === 0 ? this.initialParentRequest?.requestId : undefined);
    const request: RequestAttempt = {
      turnId: this.turnId ?? requestIdentity('turn'),
      requestId: requestIdentity('request'),
      producerSeq: 0,
      ...(parentRequestId === undefined ? {} : { parentRequestId }),
    };
    this.turnId = request.turnId;
    this.activeRequest = request;
    this.requests.push(request);
    return request;
  }

  private continuationRequestIdentity(request: RequestAttempt): { readonly turnId: string; readonly requestId: string; readonly parentRequestId?: string } {
    return {
      turnId: request.turnId,
      requestId: request.requestId,
      ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
    };
  }

  private currentRequestIdentity(): { readonly turnId?: string; readonly requestId?: string; readonly parentRequestId?: string } {
    return this.activeRequest === undefined
      ? {}
      : {
          turnId: this.activeRequest.turnId,
          requestId: this.activeRequest.requestId,
          ...(this.activeRequest.parentRequestId === undefined ? {} : { parentRequestId: this.activeRequest.parentRequestId }),
        };
  }

  private publishLifecycle(
    request: RequestAttempt,
    phase: ProviderRequestLifecycleEvent['phase'],
    extraEvidenceRefs: readonly EvidenceRef[] = [],
    baseEvidenceRefs: readonly EvidenceRef[] = [],
    externalResponseId?: string,
    error?: ProviderError,
  ): void {
    // Internal terminal bookkeeping must not depend on the optional lifecycle
    // notification: continuation admission reads `terminalPhase` directly.
    if (phase === 'failed' || phase === 'cancelled' || phase === 'settled') request.terminalPhase = phase;
    if (this.options.onRequestLifecycle === undefined) return;
    const evidenceRefs = [...baseEvidenceRefs, ...extraEvidenceRefs];
    const responseId = externalResponseId ?? request.externalResponseId;
    const event = {
      ...this.execution,
      turnId: request.turnId,
      requestId: request.requestId,
      ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
      phase,
      occurredAt: this.now().toISOString(),
      evidenceRefs: evidenceRefs.length === 0 ? [{ ...this.evidenceRef }] : evidenceRefs,
      ...(responseId === undefined ? {} : { externalResponseId: responseId }),
      ...(error === undefined ? {} : { error }),
    };
    validateProviderRequestLifecycleEvent(event as ProviderRequestLifecycleEvent<TIdentity>);
    this.options.onRequestLifecycle(event);
  }

  private async publishFailed(
    request: RequestAttempt,
    cause: unknown,
    phase: 'start' | 'submit' | 'stop' | 'settle' | 'observe',
  ): Promise<void> {
    if (request.terminalPhase !== undefined) return;
    const error = cause instanceof ProviderAdapterError
      ? cause.providerError
      : isProviderError(cause)
        ? cause
        : this.error(
            'provider.request.failed',
            cause instanceof Error ? cause.message : 'provider request failed',
            phase,
          ).providerError;
    await this.commitRequestPhase(request, 'failed');
    this.publishLifecycle(request, 'failed', [], [], undefined, error);
  }

  /**
   * Commits the request-level terminal for a normally observed request. This
   * only closes the request lifecycle; it never calls the execution-level
   * `port.settle`, releases the provider stream or closes the driver, so the
   * same admitted turn can dispatch the next request.
   */
  private async commitObservedCompletion(request: RequestAttempt | undefined): Promise<void> {
    if (request === undefined || request.terminalPhase !== undefined) return;
    await this.commitRequestPhase(request, 'settled');
    this.publishLifecycle(request, 'settled', [], [], request.externalResponseId);
  }

  /**
   * Re-checks stop/drain/settlement admission after an awaited registration or
   * context boundary and before any external dispatch.
   */
  private assertDispatchOpen(): void {
    if (this.stopping) throw this.error('provider.stop.requested', 'provider stop was requested before dispatch', 'submit', 'runtime');
    if (this.productionClosed) throw this.error('provider.production.closed', 'provider production was closed before dispatch', 'submit', 'runtime');
    if (this.executionSettled) throw this.error('provider.execution.settled', 'provider execution settlement started before dispatch', 'submit', 'runtime');
  }

  private async publishObservedLifecycle(event: ProviderEvent<TIdentity>): Promise<void> {
    if (this.activeRequest === undefined) return;
    if (event.externalResponseId !== undefined) this.activeRequest.externalResponseId = event.externalResponseId;
    if (event.kind === 'terminal' && event.terminalState === 'waiting') {
      await this.commitRequestPhase(this.activeRequest, 'waiting');
      this.publishLifecycle(this.activeRequest, 'waiting', event.evidenceRefs);
    } else if (event.kind === 'error') {
      await this.publishFailed(this.activeRequest, event.error === undefined ? new Error('provider emitted an error event') : event.error, 'observe');
    }
  }

  private toolResultEvents(
    request: RequestAttempt,
    call: ProviderToolCall,
    result: ProviderToolResult<TIdentity>,
    summary: string,
  ): Iterable<ProviderAgentEvent<TIdentity>> {
    const event: ProviderEvent<TIdentity> = {
      ...this.execution,
      eventId: `event-tool-result-${call.callId}`,
      kind: 'tool',
      toolPhase: 'result',
      outputRefs: result.outputRefs,
      summary,
      evidenceRefs: result.evidenceRefs,
      ownerId: this.options.ownerId ?? 'humanagent.provider-agent-driver',
      nextAction: { kind: 'continue', ref: call.continuationRef },
      toolResult: result,
    };
    return [this.agentEvent(event, request)];
  }

  private toolFailedEvents(
    request: RequestAttempt,
    call: ProviderToolCall,
    cause: unknown,
    status: 'failed' | 'cancelled',
  ): Iterable<ProviderAgentEvent<TIdentity>> {
    return this.toolResultEvents(request, call, this.toolFailureResult(call, cause, status), `${call.toolId} ${status}`);
  }

  private toolStatus(result: ProviderToolExecutionResult): ProviderToolStatus {
    if (result.status !== undefined && result.status !== 'succeeded') return result.status;
    if (result.error !== undefined) return 'failed';
    return 'succeeded';
  }

  private toolResult(request: RequestAttempt, call: ProviderToolCall, result: ProviderToolExecutionResult, status: ProviderToolStatus): ProviderToolResult<TIdentity> {
    const error = result.error ?? (status === 'succeeded'
      ? undefined
      : this.error('tool.result.failed', `${call.toolId} executor reported ${status} without an error`, 'observe').providerError);
    const toolResult: ProviderToolResult<TIdentity> = {
      ...this.execution,
      toolId: call.toolId,
      callId: call.callId,
      status,
      outputRefs: result.outputRefs,
      evidenceRefs: result.evidenceRefs,
      ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }),
      ...(result.outputDigest === undefined ? {} : { outputDigest: result.outputDigest }),
      ...(error === undefined ? {} : { error }),
    };
    const requestRef = request.requestId;
    const outputRef = result.outputRef;
    const outputDigest = result.outputDigest;
    const executorRoute = result.executorRoute;
    if (status !== 'succeeded'
      || this.options.binding.protocol !== 'responses'
      || typeof executorRoute !== 'string'
      || executorRoute.trim() === ''
      || typeof outputRef !== 'string'
      || outputRef.trim() === ''
      || typeof outputDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(outputDigest)) {
      return toolResult;
    }

    const expectedToolIdentity: ToolIdentity = {
      surface: 'responses',
      toolId: call.toolId,
      bindingRef: this.options.binding.bindingId,
      route: executorRoute,
    };
    const executionFact: ToolExecutionFact = {
      identity: expectedToolIdentity,
      requestRef,
      callRef: call.callId,
      operationRef: this.options.operationId.value,
      state: 'succeeded',
      rawEvidenceRefs: [outputRef],
      resultRef: outputRef,
      resultDigest: outputDigest,
    };
    const attachedResult = { ...toolResult, executionFact };
    validateProviderToolResult(attachedResult, expectedToolIdentity, requestRef);
    return attachedResult;
  }

  /**
   * Whether a non-succeeded tool result is a model-correctable argument mistake
   * rather than a runtime fault. The executor returns these as a typed
   * `validation` failure with a `continue` next action: the rejected call never
   * ran, so the only owner that can repair it is the model. Such results route
   * back through the tool history exactly like a refused turn-end. Every other
   * failed/cancelled/blocked/unknown result stays fatal via `toolResultFailure`.
   */
  private modelCorrectableFailure(result: ProviderToolResult<TIdentity>): boolean {
    const error = result.error;
    return error?.category === 'validation'
      && error.retryable === 'retryable'
      && error.nextAction.kind === 'continue';
  }

  /**
   * A failed tool result is fatal for the execution, and its provider error is
   * the real failure cause. Rethrow it as a ProviderAdapterError: the downstream
   * projections read `providerError`, so throwing the bare ProviderError object
   * would degrade the task terminal to String(plainObject) and lose the code,
   * category, retryability and next action of the actual failure. The only
   * non-fatal failed results are a refused standard turn-end and a
   * model-correctable `validation` argument mistake (see `modelCorrectableFailure`).
   */
  private toolResultFailure(toolResult: ProviderToolResult<TIdentity>): ProviderAdapterError {
    const failure = toolResult.error;
    if (failure === undefined) {
      return this.error('tool.result.failed', 'provider tool executor returned a failed result', 'observe', 'runtime');
    }
    return new ProviderAdapterError({
      code: failure.code,
      category: failure.category,
      phase: failure.phase,
      message: failure.message,
      scope: this.options.scope,
      retryable: failure.retryable,
      attention: failure.attention,
      nextAction: failure.nextAction,
      evidenceRefs: failure.evidenceRefs,
    });
  }

  private toolFailureResult(call: ProviderToolCall, cause: unknown, status: 'failed' | 'cancelled'): ProviderToolResult<TIdentity> {
    const error = cause instanceof ProviderAdapterError
      ? cause.providerError
      : this.error('tool.result.failure', cause instanceof Error ? cause.message : 'provider tool execution failed', 'observe').providerError;
    return {
      ...this.execution,
      toolId: call.toolId,
      callId: call.callId,
      status,
      outputRefs: [],
      evidenceRefs: error.evidenceRefs,
      error,
    };
  }

  private unownedToolResult(call: ProviderToolCall): ProviderToolExecutionResult {
    const available = (this.options.tools ?? []).map((tool) => tool.toolId).join(', ');
    const message = `${call.toolId} is not available in this Harness; only these function tools can be called: ${available}`;
    return {
      output: message,
      outputRefs: [],
      evidenceRefs: [],
      status: 'failed',
      error: this.error('tool.not.owned', message, 'observe', 'capability').providerError,
    };
  }

  private assertIdentity(input: AgentStartRequest<TIdentity>): void {
    if (isTasklessIdentity(input) || this.isInteractionParentIdentity(input)) {
      if (!sameExecution(this.execution, input)) {
        throw this.error('runtime.identity.mismatch', 'provider agent driver received another execution identity', 'start', 'runtime');
      }
      return;
    }
    const expected: Partial<ProviderExecutionIdentityRef> = this.execution;
    if (input.runtimeId !== expected.runtimeId
      || input.taskId === undefined || expected.taskId === undefined
      || input.taskId.value !== expected.taskId.value
      || input.executionEpoch !== expected.executionEpoch) {
      throw this.error('runtime.identity.mismatch', 'provider agent driver received another execution identity', 'start', 'runtime');
    }
  }

  private sameEnvelope(input: AgentInput<TIdentity>): boolean {
    if (isTasklessIdentity(input) || this.isInteractionParentIdentity(input)) {
      return sameExecution(this.execution, input);
    }
    const expected: Partial<ProviderExecutionIdentityRef> = this.execution;
    return input.executionEpoch === expected.executionEpoch
      && input.taskId !== undefined
      && expected.taskId !== undefined
      && input.taskId.value === expected.taskId.value;
  }

  private assertProviderIdentity(
    input: AnyProviderExecutionIdentityRef,
    label: string,
    phase: 'start' | 'submit' | 'observe' | 'stop' | 'settle',
  ): void {
    if (!sameExecution(this.execution, input)) {
      throw this.error('runtime.identity.mismatch', `${label} belongs to another execution`, phase, 'runtime');
    }
  }

  private isInteractionParentIdentity(input: object): input is InteractionParentProviderExecutionIdentityRef {
    return 'interactionTurn' in input && input.interactionTurn !== undefined;
  }

  private error(
    code: string,
    message: string,
    phase: 'start' | 'resume' | 'submit' | 'observe' | 'stop' | 'settle',
    category: 'runtime' | 'capability' = 'runtime',
    cause?: unknown,
  ): ProviderAdapterError {
    return new ProviderAdapterError({
      code,
      category,
      phase,
      message,
      scope: this.options.scope,
      cause,
    });
  }
}

function inputPayloadMissing(): never {
  throw new Error('provider tool continuation is missing its original business payload');
}
