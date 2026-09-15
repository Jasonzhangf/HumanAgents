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

export class ProviderAgentDriver implements AgentDriver {
  readonly kind = 'humanagent.provider-agent-driver';

  private handle?: AgentHandle;
  private providerStarted = false;
  private providerSettlement?: ProviderSettlement;
  private readonly evidenceRef: EvidenceRef;

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
    });
    this.assertProviderIdentity(receipt, 'provider start receipt', 'start');
    this.providerStarted = true;
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
    for await (const providerEvent of this.options.port.observe({
      runtimeId: this.options.runtimeId,
      taskId: this.options.taskId,
      operationId: this.options.operationId,
      executionEpoch: this.options.executionEpoch,
    })) {
      this.assertProviderIdentity(providerEvent, 'provider event', 'observe');
      yield {
        taskId: providerEvent.taskId,
        executionEpoch: providerEvent.executionEpoch,
        kind: `provider.${providerEvent.kind}`,
        evidenceRefs: providerEvent.evidenceRefs,
        summary: providerEvent.summary,
        providerEvent,
      };
    }
  }

  async requestStop(input: { readonly runtimeId: string; readonly executionEpoch: number; readonly operationId: OperationId }): Promise<StopRequestReceipt> {
    if (!this.providerStarted) throw this.error('runtime.not.submitted', 'provider execution has not been submitted', 'stop', 'runtime');
    if (input.runtimeId !== this.options.runtimeId
      || input.executionEpoch !== this.options.executionEpoch
      || input.operationId.value !== this.options.operationId.value) {
      throw this.error('runtime.identity.mismatch', 'provider stop is not bound to the current execution', 'stop', 'runtime');
    }
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
    phase: 'start' | 'observe' | 'stop' | 'settle',
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
