import {
  id,
  type AgentCapabilities,
  type AgentClosure,
  type AgentDriver,
  type AgentEvent,
  type AgentHandle,
  type AgentInput,
  type AgentOutput,
  type AgentResumeRequest,
  type AgentStartRequest,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type OperationId,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderExecutionIdentityRef,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderSubmitResult,
  type ProviderToolCall,
  type ScopeRef,
  type StopRequestReceipt,
  type TaskId,
} from '../../../contracts/src/index.js';
import { ProviderAdapterError } from './errors.js';

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
}

export interface ProviderToolExecutionResult {
  readonly output: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ProviderToolExecutionPort {
  execute(input: {
    readonly execution: ProviderExecutionIdentityRef;
    readonly scope: ScopeRef;
    readonly call: ProviderToolCall;
    readonly signal: AbortSignal;
  }): Promise<ProviderToolExecutionResult>;
}

export interface ProviderAgentEvent extends AgentEvent {
  readonly summary?: string;
  readonly providerEvent: ProviderEvent;
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

function isExpectedStopAbort(cause: unknown, controller: AbortController): boolean {
  if (!controller.signal.aborted) return false;
  if (cause === controller.signal.reason) return true;
  return cause instanceof Error && cause.name === 'AbortError';
}

export class ProviderAgentDriver implements AgentDriver {
  readonly kind = 'humanagent.provider-agent-driver';

  private handle?: AgentHandle;
  private providerStarted = false;
  private providerSettlement?: ProviderSettlement;
  private readonly evidenceRef: EvidenceRef;
  private stopping = false;
  private toolController?: AbortController;
  private toolCompletion?: Promise<void>;
  private continuationCompletion?: Promise<void>;
  private initialPayload?: AgentInput['payload'];

  constructor(private readonly options: ProviderAgentDriverOptions) {
    this.evidenceRef = operationEvidence(options.scope, options.operationId);
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
    if (input.taskId.value !== this.options.taskId.value || input.executionEpoch !== this.options.executionEpoch) {
      throw this.error('runtime.identity.mismatch', 'provider submit is not bound to the current execution', 'submit', 'runtime');
    }
    const receipt = await this.options.port.start({
      runtimeId: this.options.runtimeId,
      taskId: this.options.taskId,
      operationId: this.options.operationId,
      executionEpoch: this.options.executionEpoch,
      inputRefs: [...this.options.inputRefs],
      evidenceRefs: [this.evidenceRef],
      payload: input.payload,
      ...(this.options.tools === undefined ? {} : { tools: this.options.tools }),
    });
    this.assertProviderIdentity(receipt, 'provider start receipt', 'start');
    this.providerStarted = true;
    this.initialPayload = input.payload;
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: { mode: 'provider', status: 'accepted' },
      outputRefs: [],
      evidenceRefs: [...receipt.evidenceRefs],
    };
  }

  async *observe(input: { readonly runtimeId: string }): AsyncIterable<ProviderAgentEvent> {
    if (!this.providerStarted) throw this.error('runtime.not.submitted', 'provider execution has not been submitted', 'observe', 'runtime');
    if (input.runtimeId !== this.options.runtimeId) {
      throw this.error('runtime.identity.mismatch', 'provider observe is not bound to the current execution', 'observe', 'runtime');
    }
    let rounds = 0;
    while (true) {
      const toolCalls: ProviderToolCall[] = [];
      let terminal: ProviderEvent | undefined;
      for await (const providerEvent of this.options.port.observe({
          runtimeId: this.options.runtimeId,
          taskId: this.options.taskId,
          operationId: this.options.operationId,
          executionEpoch: this.options.executionEpoch,
      })) {
        this.assertProviderIdentity(providerEvent, 'provider event', 'observe');
        if (providerEvent.toolCall !== undefined) toolCalls.push(providerEvent.toolCall);
        if (providerEvent.terminalState !== undefined) terminal = providerEvent;
        if (providerEvent.terminalState === 'waiting' && providerEvent.nextAction?.ref === 'responses-tool-call') continue;
        yield this.agentEvent(providerEvent);
      }
      if (this.stopping) return;
      if (toolCalls.length === 0) return;
      if (terminal?.terminalState !== 'waiting' || terminal.nextAction?.ref !== 'responses-tool-call') {
        throw this.error('tool.terminal.missing', 'provider emitted a tool call without a tool-waiting terminal', 'observe', 'runtime');
      }
      if (this.options.executeTool === undefined || this.options.tools === undefined) {
        throw this.error('tool.executor.missing', 'provider requested a tool but no execution port is bound', 'observe', 'capability');
      }
      rounds += 1;
      if (rounds > (this.options.maxToolRounds ?? 8)) {
        throw this.error('tool.round-limit', 'provider tool round limit was exceeded', 'observe', 'runtime');
      }
      const toolResults: Array<{ readonly call: ProviderToolCall; readonly result: ProviderToolExecutionResult }> = [];
      for (const call of toolCalls) {
        if (this.stopping) return;
        this.toolController = new AbortController();
        const toolController = this.toolController;
        let completeTool!: () => void;
        const toolCompletion = new Promise<void>((resolve) => { completeTool = resolve; });
        this.toolCompletion = toolCompletion;
        let result: ProviderToolExecutionResult;
        try {
          result = await this.options.executeTool.execute({
            execution: identity(this.options),
            scope: this.options.scope,
            call,
            signal: toolController.signal,
          });
        } catch (cause) {
          // A stop aborts the tool signal; an executor that rejects with that
          // abort must drain as the same clean stopped closure as a normal
          // return. Real tool failures stay visible.
          if (this.stopping && isExpectedStopAbort(cause, toolController)) return;
          throw cause;
        } finally {
          this.toolController = undefined;
          completeTool();
          if (this.toolCompletion === toolCompletion) this.toolCompletion = undefined;
        }
        if (this.stopping) return;
        const toolResultEvent: ProviderEvent = {
          ...identity(this.options),
          eventId: `event-tool-result-${call.callId}-${rounds}`,
          kind: 'tool',
          outputRefs: result.outputRefs,
          summary: `${call.toolId} succeeded`,
          evidenceRefs: result.evidenceRefs,
          ownerId: this.options.ownerId ?? 'humanagent.provider-agent-driver',
          nextAction: { kind: 'continue', ref: call.continuationRef },
        };
        yield this.agentEvent(toolResultEvent);
        toolResults.push({ call, result });
      }
      if (this.stopping) return;
      let completeContinuation!: () => void;
      const continuationCompletion = new Promise<void>((resolve) => { completeContinuation = resolve; });
      this.continuationCompletion = continuationCompletion;
      let submitted: ProviderSubmitResult;
      try {
        submitted = await this.options.port.submit({
          ...identity(this.options),
          inputRefs: [...this.options.inputRefs],
          evidenceRefs: toolResults.flatMap(({ result }) => result.evidenceRefs),
          payload: this.initialPayload ?? inputPayloadMissing(),
          tools: this.options.tools,
          toolContinuations: toolResults.map(({ call, result }) => ({
            callId: call.callId,
            toolId: call.toolId,
            arguments: call.arguments,
            continuationRef: call.continuationRef,
            output: result.output,
          })),
        });
      } finally {
        completeContinuation();
        if (this.continuationCompletion === continuationCompletion) this.continuationCompletion = undefined;
      }
      this.assertProviderIdentity(submitted, 'provider tool continuation receipt', 'submit');
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
    const receipt = await this.options.port.requestStop({
      runtimeId: this.options.runtimeId,
      taskId: this.options.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      reason: 'operator requested stop',
      ownerId: this.options.ownerId ?? 'humanagent.app',
    });
    this.assertProviderIdentity(receipt, 'provider stop receipt', 'stop');
    return { requested: receipt.status !== 'rejected', operationId: receipt.operationId };
  }

  async settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure> {
    if (input.runtimeId !== this.options.runtimeId || input.executionEpoch !== this.options.executionEpoch) {
      throw this.error('runtime.identity.mismatch', 'provider settle is not bound to the current execution', 'settle', 'runtime');
    }
    if (this.toolCompletion) await this.toolCompletion;
    if (this.continuationCompletion) await this.continuationCompletion;
    const settlement = await this.options.port.settle({
      runtimeId: this.options.runtimeId,
      taskId: this.options.taskId,
      operationId: this.options.operationId,
      executionEpoch: this.options.executionEpoch,
    });
    this.assertProviderIdentity(settlement, 'provider settlement', 'settle');
    this.providerSettlement = settlement;
    return { state: settlement.state, evidenceRefs: [...settlement.evidenceRefs] };
  }

  async close(): Promise<ProviderCloseResult> {
    return this.options.port.close(this.options.binding);
  }

  settlement(): ProviderSettlement | undefined {
    return this.providerSettlement ? structuredClone(this.providerSettlement) : undefined;
  }

  private agentEvent(providerEvent: ProviderEvent): ProviderAgentEvent {
    return {
      taskId: providerEvent.taskId,
      executionEpoch: providerEvent.executionEpoch,
      kind: `provider.${providerEvent.kind}`,
      evidenceRefs: providerEvent.evidenceRefs,
      summary: providerEvent.summary,
      ...(providerEvent.terminalState === undefined ? {} : { terminalState: providerEvent.terminalState }),
      providerEvent,
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
  ): ProviderAdapterError {
    return new ProviderAdapterError({
      code,
      category,
      phase,
      message,
      scope: this.options.scope,
    });
  }
}

function inputPayloadMissing(): never {
  throw new Error('provider tool continuation is missing its original business payload');
}
