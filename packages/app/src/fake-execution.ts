import {
  ProviderAgentDriver,
  type ProviderAgentEvent,
} from '../../adapters/provider/src/index.js';
import type {
  AgentCapabilities,
  AgentClosure,
  AgentDriver,
  AgentEvent,
  AgentHandle,
  AgentInput,
  AgentOutput,
  AgentResumeRequest,
  AgentStartRequest,
  ExecutionRuntimePort,
  OperationId,
  ProviderBinding,
  ProviderCloseResult,
  ScopeRef,
  StopRequestReceipt,
  TaskId,
} from '../../contracts/src/index.js';
import { FakeReplayExecutionRuntimePort } from './ui-runtime/fake-port.js';

export interface FakeExecutionBindingOptions {
  readonly bindingId?: string;
  readonly providerId?: string;
  readonly protocol?: ProviderBinding['protocol'];
  readonly endpointRef?: string;
  readonly modelRef?: string;
  readonly configDigest?: string;
  readonly capabilityDigest?: string;
}

export function fakeExecutionBinding(options: FakeExecutionBindingOptions = {}): ProviderBinding {
  return {
    bindingId: options.bindingId ?? 'fake-default',
    providerId: options.providerId ?? 'fake-provider',
    protocol: options.protocol ?? 'responses',
    endpointRef: options.endpointRef ?? 'fake:replay',
    modelRef: options.modelRef ?? 'fake.model',
    configDigest: options.configDigest ?? 'sha256:fake-ui-config',
    capabilityDigest: options.capabilityDigest ?? 'sha256:fake-ui-capability',
  };
}

export function createFakeExecutionPort(binding: ProviderBinding, stepDelayMs?: number): ExecutionRuntimePort {
  return new FakeReplayExecutionRuntimePort({ binding, stepDelayMs });
}

export interface FakeAgentDriverOptions {
  readonly binding: ProviderBinding;
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly scope: ScopeRef;
  readonly inputRefs: readonly string[];
  readonly stepDelayMs?: number;
}

/**
 * Standalone fake execution uses the exact ProviderAgentDriver contract used
 * by the UI runtime. The wrapper only retains provider output/event evidence
 * for the standalone receipt and exposes the same close operation.
 */
export class FakeProviderAgentDriver implements AgentDriver {
  readonly kind = 'humanagent.provider-agent-driver';
  private readonly driver: ProviderAgentDriver;
  private readonly outputChunks: string[] = [];
  private readonly events: ProviderAgentEvent[] = [];

  constructor(options: FakeAgentDriverOptions) {
    this.driver = new ProviderAgentDriver({
      port: createFakeExecutionPort(options.binding, options.stepDelayMs),
      binding: options.binding,
      runtimeId: options.runtimeId,
      taskId: options.taskId,
      operationId: options.operationId,
      executionEpoch: options.executionEpoch,
      assignmentId: options.assignmentId,
      scope: options.scope,
      inputRefs: options.inputRefs,
      ownerId: 'humanagent.fake-provider',
    });
  }

  capabilities(): Promise<AgentCapabilities> { return this.driver.capabilities(); }
  start(input: AgentStartRequest): Promise<AgentHandle> { return this.driver.start(input); }
  resume(input: AgentResumeRequest): Promise<AgentHandle> { return this.driver.resume(input); }
  submit(input: AgentInput): Promise<AgentOutput> { return this.driver.submit(input); }

  async *observe(input: { readonly runtimeId: string }): AsyncIterable<AgentEvent> {
    for await (const event of this.driver.observe(input)) {
      const summary = event.summary
        ?? (event.providerEvent.kind === 'terminal'
          ? `execution ${event.providerEvent.terminalState ?? 'unknown'}`
          : event.providerEvent.error?.message
            ?? (event.providerEvent.outputRefs && event.providerEvent.outputRefs.length > 0
              ? `${event.providerEvent.kind}: ${event.providerEvent.outputRefs.join(', ')}`
              : event.providerEvent.kind));
      const normalized = { ...event, summary };
      this.events.push(normalized);
      if (event.providerEvent.kind === 'output') {
        this.outputChunks.push(summary);
      }
      yield normalized;
    }
  }

  requestStop(input: { readonly runtimeId: string; readonly executionEpoch: number; readonly operationId: OperationId }): Promise<StopRequestReceipt> {
    return this.driver.requestStop(input);
  }

  settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure> {
    return this.driver.settle(input);
  }

  close(): Promise<ProviderCloseResult> { return this.driver.close(); }

  output(): string { return this.outputChunks.join(''); }
  observedEvents(): readonly ProviderAgentEvent[] { return this.events.map((event) => structuredClone(event)); }
}
