import {
  id,
  validateProviderToolResult,
  validateProviderRequestLifecycleEvent,
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
  type ProviderSettlement,
  type ProviderStartInput,
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

function createToolBarrier(): ToolBarrier {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export interface ProviderAgentDriverOptions {
  readonly port: ExecutionRuntimePort;
  readonly binding: ProviderBinding;
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly scope: ScopeRef;
  readonly inputRefs: readonly string[];
  readonly ownerId?: string;
  readonly tools?: ProviderStartInput['tools'];
  readonly executeTool?: ProviderToolExecutionPort;
  readonly maxToolRounds?: number;
  readonly onRequestLifecycle?: (event: ProviderRequestLifecycleEvent) => void;
  /**
   * Native raw path. `rawEvidence` saves the exact executor output and
   * `acceptRawFact` durably accepts each request-local raw fact. Both must be
   * bound together; older callers omit both and keep the event-only path.
   */
  readonly rawEvidence?: ProviderEvidenceSink;
  readonly acceptRawFact?: (envelope: RawFactEnvelope) => Promise<AcceptedRawFact>;
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
  readonly requestContext?: ProviderRequestContextHook;
  readonly now?: () => Date;
}

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

export interface ProviderToolExecutionPort {
  execute(input: {
    readonly execution: ProviderExecutionIdentityRef;
    readonly scope: ScopeRef;
    readonly requestId?: string;
    readonly call: ProviderToolCall;
    readonly signal: AbortSignal;
  }): Promise<ProviderToolExecutionResult>;
}

export interface ProviderAgentEvent extends AgentEvent {
  readonly summary?: string;
  readonly providerEvent: ProviderRequestScopedEvent;
}

export interface ProviderRequestScopedEvent extends ProviderEvent {
  readonly turnId: string;
  readonly requestId: string;
  readonly occurredAt: string;
}

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

function sameExecution(
  expected: ProviderAgentDriverOptions,
  actual: ProviderExecutionIdentityRef,
): boolean {
  return expected.runtimeId === actual.runtimeId
    && expected.taskId.value === actual.taskId.value
    && expected.operationId.value === actual.operationId.value
    && expected.executionEpoch === actual.executionEpoch;
}

function identity(options: ProviderAgentDriverOptions): ProviderExecutionIdentityRef {
  return {
    runtimeId: options.runtimeId,
    taskId: options.taskId,
    operationId: options.operationId,
    executionEpoch: options.executionEpoch,
  };
}

function isProviderError(value: unknown): value is ProviderError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProviderError>;
  return typeof candidate.errorId === 'string'
    && typeof candidate.code === 'string'
    && typeof candidate.message === 'string'
    && Array.isArray(candidate.evidenceRefs);
}

/**
 * A tool-waiting terminal is a real typed executable call (at least one decoded
 * `toolCall`) plus a `waiting` terminal whose next action continues. It is not
 * tied to one protocol's continuation ref, so Responses, Chat and Anthropic all
 * qualify without inferring control from `outputRefs` or payload text.
 */
function isToolWaiting(event: ProviderEvent | undefined, toolCalls: readonly ProviderToolCall[]): boolean {
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

export class ProviderAgentDriver implements AgentDriver {
  readonly kind = 'humanagent.provider-agent-driver';

  private handle?: AgentHandle;
  private providerStarted = false;
  private providerSettlement?: ProviderSettlement;
  private readonly evidenceRef: EvidenceRef;
  private stopping = false;
  private toolController?: AbortController;
  private toolBarrier?: ToolBarrier;
  private continuationCompletion?: Promise<void>;
  private initialPayload?: AgentInput['payload'];
  private turnId?: string;
  private activeRequest?: RequestAttempt;
  private readonly requests: RequestAttempt[] = [];
  private readonly inflight = new Set<Promise<unknown>>();
  private observeIterator?: AsyncIterator<ProviderEvent>;
  private productionClosed = false;
  private producerFailure?: unknown;
  private executionSettled = false;
  private continuationInFlight = false;
  private readonly now: () => Date;

  constructor(private readonly options: ProviderAgentDriverOptions) {
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
    this.evidenceRef = operationEvidence(options.scope, options.operationId);
    this.now = options.now ?? (() => new Date());
  }

  async capabilities(): Promise<AgentCapabilities> {
    const capabilities = await this.options.port.capabilities(this.options.binding);
    return {
      driverKind: this.kind,
      capabilities: capabilities.capabilities,
      version: capabilities.version,
    };
  }

  async start(input: AgentStartRequest): Promise<AgentHandle> {
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

  async submit(input: AgentInput): Promise<AgentOutput> {
    if (!this.handle) throw this.error('runtime.not.started', 'provider agent driver has not started', 'submit');
    if (this.providerStarted) throw this.error('runtime.already.submitted', 'provider execution was already submitted', 'submit');
    if (this.productionClosed) {
      throw this.error('provider.production.closed', 'provider production was closed; no new request can be dispatched', 'submit', 'runtime');
    }
    if (input.taskId.value !== this.options.taskId.value || input.executionEpoch !== this.options.executionEpoch) {
      throw this.error('runtime.identity.mismatch', 'provider submit is not bound to the current execution', 'submit', 'runtime');
    }
    const request = this.nextRequest();
    await this.commitRequestPhase(request, 'dispatching');
    this.publishLifecycle(request, 'dispatching');
    let receipt: ProviderStartReceipt;
    try {
      const context = await this.materializeRequestContext(request, 'initial');
      receipt = await this.track(this.options.port.start({
        ...identity(this.options),
        ...this.currentRequestIdentity(),
        inputRefs: [...this.options.inputRefs],
        evidenceRefs: [this.evidenceRef],
        payload: input.payload,
        ...this.requestContextFields(context),
        ...(this.options.tools === undefined ? {} : { tools: this.options.tools }),
      }));
      this.assertProviderIdentity(receipt, 'provider start receipt', 'start');
    } catch (cause) {
      if (!this.stopping) await this.publishFailed(request, cause, 'start');
      throw cause;
    }
    this.providerStarted = true;
    this.initialPayload = input.payload;
    await this.commitRequestPhase(request, 'dispatched');
    this.publishLifecycle(request, 'dispatched', [], receipt.evidenceRefs);
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: { mode: 'provider', status: 'accepted' },
      outputRefs: [],
      evidenceRefs: [...receipt.evidenceRefs],
    };
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
  }): Promise<ProviderSubmitResult> {
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
    const work = (async (): Promise<ProviderSubmitResult> => {
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
      const submitted = await this.options.port.submit({
        ...identity(this.options),
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

  async *observe(input: { readonly runtimeId: string }): AsyncIterable<ProviderAgentEvent> {
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
      let terminal: ProviderEvent | undefined;
      const request = this.activeRequest;
      const onRawFacts = this.rawFactReceiver(request);
      const observeInput: ProviderObserveInputWithRawFacts = {
        ...identity(this.options),
        ...this.currentRequestIdentity(),
        ...(onRawFacts === undefined ? {} : { onRawFacts }),
      };
      const providerIterator = this.options.port.observe(observeInput)[Symbol.asyncIterator]();
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
        throw this.error('tool.round-limit', 'provider tool round limit was exceeded', 'observe', 'runtime');
      }
      for (const call of toolCalls) {
        if (this.stopping) return;
        // The declared tool list IS this Harness's tool surface. A backend
        // harness tool the model reached for anyway (for example a shell or
        // exec_command) must come back as a typed observation the model can
        // correct, not as a fatal error that strands the execution.
        if (!(this.options.tools ?? []).some((tool) => tool.toolId === call.toolId)) {
          const unowned = this.unownedToolResult(call);
          yield* this.toolResultEvents(request, call, this.toolResult(request, call, unowned, 'failed'), `${call.toolId} unavailable`);
          toolHistory.push({ call, result: unowned });
          continue;
        }
        this.toolController = new AbortController();
        const toolController = this.toolController;
        const toolBarrier = createToolBarrier();
        this.toolBarrier = toolBarrier;
        const releaseBarrier = (): void => {
          this.toolController = undefined;
          toolBarrier.release();
          if (this.toolBarrier === toolBarrier) this.toolBarrier = undefined;
        };
        let result: ProviderToolExecutionResult;
        try {
          result = await this.track(this.options.executeTool.execute({
            execution: identity(this.options),
            scope: this.options.scope,
            ...(this.activeRequest === undefined ? {} : { requestId: this.activeRequest.requestId }),
            call,
            signal: toolController.signal,
          }));
        } catch (cause) {
          // A stop aborts the tool signal. Whether the executor rejected with
          // that abort or with its own failure, the outcome is evidence: it must
          // emit a typed result bound to the same callId instead of only
          // returning or throwing, so a cancelled tool never disappears from
          // the journal. No output was returned, so no raw asset is fabricated.
          // The barrier is released before any yield: a consumer that stops
          // resuming must never hold the barrier and deadlock settle()/drain.
          if (this.stopping) {
            releaseBarrier();
            yield* this.toolFailedEvents(request, call, cause, 'cancelled');
            return;
          }
          // Record the real executor failure before releasing the barrier and
          // yielding, so a later settle()/drain surfaces it instead of reading
          // the stopped producer as a normal result.
          this.recordProducerFailure(cause);
          releaseBarrier();
          yield* this.toolFailedEvents(request, call, cause, 'failed');
          throw cause;
        }
        const status: ProviderToolStatus = result.error !== undefined
          ? result.status === 'cancelled' ? 'cancelled' : 'failed'
          : result.status === 'cancelled'
            ? 'cancelled'
            : result.status ?? 'succeeded';
        const toolResult: ProviderToolResult = this.toolResult(request, call, result, status);
        // Save and durably accept the exact output before any projection, early
        // stop return or continuation: a late result must still reach the
        // Runtime, and a failing acceptance must not read as a normal stop.
        try {
          await this.track(this.persistToolResult(request, call, result, toolResult));
        } catch (cause) {
          this.recordProducerFailure(cause);
          throw cause;
        } finally {
          releaseBarrier();
        }
        if (this.stopping) return;
        if (status !== 'succeeded') {
          yield* this.toolResultEvents(request, call, toolResult, `${call.toolId} ${status}`);
          throw this.toolResultFailure(toolResult);
        }
        yield* this.toolResultEvents(request, call, toolResult, `${call.toolId} succeeded`);
        toolHistory.push({ call, result });
      }
      if (this.stopping) return;
      let completeContinuation!: () => void;
      const continuationCompletion = new Promise<void>((resolve) => { completeContinuation = resolve; });
      this.continuationCompletion = continuationCompletion;
      let submitted: ProviderSubmitResult;
      const continuation = this.nextRequest();
      await this.commitRequestPhase(continuation, 'dispatching');
      this.publishLifecycle(continuation, 'dispatching');
      try {
        const context = await this.materializeRequestContext(continuation, 'continuation');
        submitted = await this.track(this.options.port.submit({
          ...identity(this.options),
          ...this.continuationRequestIdentity(continuation),
          inputRefs: [...this.options.inputRefs],
          evidenceRefs: toolHistory.flatMap(({ result }) => result.evidenceRefs),
          payload: this.initialPayload ?? inputPayloadMissing(),
          tools: this.options.tools,
          ...(context === undefined
            ? {
                toolContinuations: toolHistory.map(({ call, result }) => ({
                  callId: call.callId,
                  toolId: call.toolId,
                  arguments: call.arguments,
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
        throw this.error('tool.continuation.rejected', submitted.error?.message ?? 'provider rejected the tool continuation', 'submit', 'runtime');
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
    this.toolController?.abort(new DOMException('operator requested stop', 'AbortError'));
    let receipt: ProviderStopReceipt;
    try {
      receipt = await this.options.port.requestStop({
        ...identity(this.options),
        ...this.currentRequestIdentity(),
        operationId: input.operationId,
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
    if (this.producerFailure !== undefined) throw this.producerFailure;
    let settlement: ProviderSettlement;
    try {
      settlement = await this.options.port.settle({
        ...identity(this.options),
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
    return this.options.port.close(this.options.binding);
  }

  settlement(): ProviderSettlement | undefined {
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
    if (this.producerFailure !== undefined) throw this.producerFailure;
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
      execution: identity(this.options),
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

  /**
   * Closes the provider observe iterator explicitly instead of relying on the
   * implicit `for await` teardown. Awaited so the driver waits for the current
   * decode/raw-ack work before reporting a drain; a close failure is recorded
   * so an incomplete teardown surfaces instead of reading as a clean drain.
   */
  private async closeProviderIterator(iterator: AsyncIterator<ProviderEvent>): Promise<void> {
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

  private agentEvent(providerEvent: ProviderEvent, request: RequestAttempt | undefined): ProviderAgentEvent {
    const scoped = this.scopeProviderEvent(providerEvent, request);
    return {
      taskId: providerEvent.taskId,
      executionEpoch: providerEvent.executionEpoch,
      kind: providerEvent.kind === 'tool' && providerEvent.toolPhase === 'result'
        ? 'provider.tool-result'
        : `provider.${providerEvent.kind}`,
      evidenceRefs: providerEvent.evidenceRefs,
      summary: providerEvent.summary,
      ...(providerEvent.terminalState === undefined ? {} : { terminalState: providerEvent.terminalState }),
      providerEvent: scoped,
    };
  }

  private scopeProviderEvent(providerEvent: ProviderEvent, request: RequestAttempt | undefined): ProviderRequestScopedEvent {
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
    } as ProviderRequestScopedEvent;
  }

  private rawFactReceiver(request: RequestAttempt | undefined): ProviderRawFactReceiver | undefined {
    if (this.options.acceptRawFact === undefined) return undefined;
    return async (rawFacts) => {
      for (const fact of rawFacts) {
        await this.acceptRawFact(request, fact);
      }
    };
  }

  private async acceptRawFact(request: RequestAttempt | undefined, fact: ProviderRawFact): Promise<void> {
    const accept = this.options.acceptRawFact;
    if (accept === undefined) return;
    if (request === undefined) {
      throw this.error('runtime.request.missing', 'provider raw fact arrived outside a request scope', 'observe', 'runtime');
    }
    const envelope: RawFactEnvelope = {
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
    let accepted: AcceptedRawFact;
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
    toolResult: ProviderToolResult,
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
    const fact: ProviderRawFact = {
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
    const parentRequestId = this.activeRequest?.requestId;
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
    const event: ProviderRequestLifecycleEvent = {
      ...identity(this.options),
      ...request,
      phase,
      occurredAt: this.now().toISOString(),
      evidenceRefs: evidenceRefs.length === 0 ? [{ ...this.evidenceRef }] : evidenceRefs,
      ...(externalResponseId === undefined ? {} : { externalResponseId }),
      ...(error === undefined ? {} : { error }),
    };
    validateProviderRequestLifecycleEvent(event);
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

  private async publishObservedLifecycle(event: ProviderEvent): Promise<void> {
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
    result: ProviderToolResult,
    summary: string,
  ): Iterable<ProviderAgentEvent> {
    return [this.agentEvent({
      ...identity(this.options),
      eventId: `event-tool-result-${call.callId}`,
      kind: 'tool',
      toolPhase: 'result',
      outputRefs: result.outputRefs,
      summary,
      evidenceRefs: result.evidenceRefs,
      ownerId: this.options.ownerId ?? 'humanagent.provider-agent-driver',
      nextAction: { kind: 'continue', ref: call.continuationRef },
      toolResult: result,
    }, request)];
  }

  private toolFailedEvents(
    request: RequestAttempt,
    call: ProviderToolCall,
    cause: unknown,
    status: 'failed' | 'cancelled',
  ): Iterable<ProviderAgentEvent> {
    return this.toolResultEvents(request, call, this.toolFailureResult(call, cause, status), `${call.toolId} ${status}`);
  }

  private toolResult(request: RequestAttempt, call: ProviderToolCall, result: ProviderToolExecutionResult, status: ProviderToolStatus): ProviderToolResult {
    const error = result.error ?? (status === 'succeeded'
      ? undefined
      : this.error('tool.result.failed', `${call.toolId} executor reported ${status} without an error`, 'observe').providerError);
    const toolResult: ProviderToolResult = {
      ...identity(this.options),
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
   * A failed tool result is fatal for the execution, and its provider error is
   * the real failure cause. Rethrow it as a ProviderAdapterError: the downstream
   * projections read `providerError`, so throwing the bare ProviderError object
   * would degrade the task terminal to String(plainObject) and lose the code,
   * category, retryability and next action of the actual failure.
   */
  private toolResultFailure(toolResult: ProviderToolResult): ProviderAdapterError {
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

  private toolFailureResult(call: ProviderToolCall, cause: unknown, status: 'failed' | 'cancelled'): ProviderToolResult {
    const error = cause instanceof ProviderAdapterError
      ? cause.providerError
      : this.error('tool.result.failure', cause instanceof Error ? cause.message : 'provider tool execution failed', 'observe').providerError;
    return {
      ...identity(this.options),
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

  private assertIdentity(input: AgentStartRequest): void {
    if (this.options.runtimeId !== input.runtimeId
      || this.options.taskId.value !== input.taskId.value
      || this.options.executionEpoch !== input.executionEpoch) {
      throw this.error('runtime.identity.mismatch', 'provider agent driver received another execution identity', 'start', 'runtime');
    }
  }

  private assertProviderIdentity(
    input: ProviderExecutionIdentityRef,
    label: string,
    phase: 'start' | 'submit' | 'observe' | 'stop' | 'settle',
  ): void {
    if (!sameExecution(this.options, input)) {
      throw this.error('runtime.identity.mismatch', `${label} belongs to another execution`, phase, 'runtime');
    }
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
