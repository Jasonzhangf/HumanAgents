import {
  ProviderAgentDriver,
  type ProviderAgentEvent,
} from '../../adapters/provider/src/index.js';
import { id } from '../../contracts/src/index.js';
import type { AgentSemanticEvent, AgentSemanticEventKind } from '../../contracts/src/index.js';
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
  Checkpoint,
  EvidenceRef,
  ExecutionRuntimePort,
  OperationId,
  ProviderBinding,
  ProviderCloseResult,
  ProviderError,
  ProviderEvent,
  ProviderSettleInput,
  ProviderSettlement,
  ProviderStartInput,
  ProviderStopReceipt,
  ProviderStopRequest,
  ProviderSubmitInput,
  ProviderSubmitResult,
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

export type FakeExecutionScenario =
  | 'success'
  | 'tool'
  | 'error'
  | 'cancel'
  | 'unknown'
  | 'close-failure';

type FakeReplay = NonNullable<ConstructorParameters<typeof FakeReplayExecutionRuntimePort>[0]['replay']>;

function semanticEventKind(providerKind: ProviderEvent['kind']): AgentSemanticEventKind {
  switch (providerKind) {
    case 'model': return 'provider.model';
    case 'output': return 'provider.output';
    case 'tool': return 'provider.tool';
    case 'error': return 'provider.error';
    case 'attention': return 'provider.error';
    case 'transport': return 'provider.error';
    case 'terminal': return 'execution.terminal';
  }
}

interface SemanticEventSource {
  readonly kind: ProviderEvent['kind'];
  readonly terminalState?: ProviderEvent['terminalState'];
  readonly outputRefs?: readonly string[];
  readonly summary?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly error?: ProviderError;
  readonly ownerId?: string;
}

function eventState(event: SemanticEventSource): string {
  if (event.terminalState) return event.terminalState;
  if (event.error) return 'failed';
  return event.kind;
}

function eventSummary(event: SemanticEventSource, kind: AgentSemanticEventKind): string {
  if (kind === 'execution.terminal') return `execution ${event.terminalState ?? 'unknown'}`;
  if (event.error) return event.error.message ?? 'provider error';
  if (event.summary) return event.summary;
  if (event.outputRefs && event.outputRefs.length > 0) return `${event.kind}: ${event.outputRefs.join(', ')}`;
  return event.kind;
}

function providerEventFrom(event: AgentEvent): ProviderEvent | undefined {
  return (event as { readonly providerEvent?: ProviderEvent }).providerEvent;
}

function semanticEventSourceFrom(event: AgentEvent): SemanticEventSource | undefined {
  const providerEvent = providerEventFrom(event);
  if (providerEvent) return providerEvent;
  switch (event.kind) {
    case 'model':
    case 'output':
    case 'tool':
    case 'error':
    case 'terminal':
    case 'attention':
    case 'transport':
      return {
        kind: event.kind,
        terminalState: event.terminalState,
        summary: event.summary,
        evidenceRefs: event.evidenceRefs,
      };
    default:
      return undefined;
  }
}

export function projectExecutionSemanticEvents(input: {
  readonly observedEvents: readonly AgentEvent[];
  readonly checkpoint: Checkpoint;
  readonly providerClose: ProviderCloseResult | undefined;
  readonly executionAdmitted: boolean;
  readonly failure?: { readonly message: string; readonly closure?: AgentClosure };
}): AgentSemanticEvent[] {
  const events: AgentSemanticEvent[] = [];
  const push = (
    kind: AgentSemanticEventKind,
    state: string,
    summary: string,
    evidenceRefs: readonly EvidenceRef[],
    options?: {
      readonly terminalPhase?: 'provider' | 'final';
      readonly terminalState?: AgentSemanticEvent['terminalState'];
      readonly ownerId?: string;
    },
  ): void => {
    events.push({
      seq: events.length + 1,
      kind,
      state,
      summary,
      evidenceRefs,
      ...(options?.terminalPhase === undefined ? {} : { terminalPhase: options.terminalPhase }),
      ...(options?.terminalState === undefined ? {} : { terminalState: options.terminalState }),
      ...(options?.ownerId === undefined ? {} : { ownerId: options.ownerId }),
    });
  };

  if (input.executionAdmitted) push('execution.started', 'running', 'execution started', []);
  let providerTerminal: SemanticEventSource | undefined;
  for (const event of input.observedEvents) {
    const source = semanticEventSourceFrom(event);
    if (!source) continue;
    const kind = semanticEventKind(source.kind);
    push(kind, eventState(source), eventSummary(source, kind), source.evidenceRefs, {
      ...(source.kind === 'terminal' ? { terminalPhase: 'provider' as const } : {}),
      ...(source.ownerId === undefined ? {} : { ownerId: source.ownerId }),
    });
    if (source.kind === 'terminal') providerTerminal = source;
  }
  if (input.failure) {
    push('provider.error', 'failed', input.failure.message, input.failure.closure?.evidenceRefs ?? []);
  } else {
    push('execution.settling', 'settling', 'execution settling', []);
  }
  push('checkpoint.committed', input.checkpoint.outcome, input.checkpoint.summary, input.checkpoint.evidenceRefs, {
    ownerId: 'humanagent.app.run-operation',
  });
  push(
    'execution.terminal',
    input.failure ? 'failed' : input.checkpoint.outcome,
    input.providerClose?.state === 'closed'
      ? `execution ${input.failure ? 'failed' : input.checkpoint.outcome}; provider closed`
      : `execution ${input.failure ? 'failed' : input.checkpoint.outcome}; provider close state ${input.providerClose?.state ?? 'unknown'}`,
    [...input.checkpoint.evidenceRefs, ...(input.providerClose?.evidenceRefs ?? [])],
    {
      terminalPhase: 'final',
      terminalState: providerTerminal?.terminalState ?? input.checkpoint.outcome,
    },
  );
  return events;
}

function scenarioSteps(scenario: FakeExecutionScenario): FakeReplay {
  const base: FakeReplay = [
    { kind: 'model', state: 'model', summary: 'fake replay: model accepted the request' },
    { kind: 'output', state: 'output', summary: 'fake replay: draft output chunk 1', outputRefs: ['fake://output/1'] },
    { kind: 'tool', state: 'tool', summary: 'fake replay: tool call observed', outputRefs: ['fake://tool/1'] },
    { kind: 'output', state: 'output', summary: 'fake replay: final output chunk 2', outputRefs: ['fake://output/2'] },
  ];
  switch (scenario) {
    case 'success':
    case 'close-failure':
      return [...base, { kind: 'terminal', state: 'succeeded', summary: 'fake replay: execution succeeded', terminalState: 'succeeded' }];
    case 'tool':
      return [
        { kind: 'tool', state: 'tool', summary: 'fake replay: tool call observed', outputRefs: ['fake://tool/1'] },
        { kind: 'output', state: 'output', summary: 'fake replay: tool result', outputRefs: ['fake://output/tool'] },
        { kind: 'terminal', state: 'succeeded', summary: 'fake replay: execution succeeded', terminalState: 'succeeded' },
      ];
    case 'error':
      return [
        { kind: 'model', state: 'model', summary: 'fake replay: model accepted the request' },
        { kind: 'terminal', state: 'failed', summary: 'fake replay: execution failed', terminalState: 'failed' },
      ];
    case 'cancel':
      return [
        { kind: 'model', state: 'model', summary: 'fake replay: model accepted the request' },
        { kind: 'output', state: 'output', summary: 'fake replay: draft before cancellation', outputRefs: ['fake://output/cancel'] },
        { kind: 'terminal', state: 'cancelled', summary: 'fake replay: execution cancelled', terminalState: 'cancelled' },
      ];
    case 'unknown':
      return [
        { kind: 'model', state: 'model', summary: 'fake replay: model accepted the request' },
        { kind: 'terminal', state: 'unknown', summary: 'fake replay: execution outcome unknown', terminalState: 'unknown' },
      ];
  }
}

function fakeOwnerEvidence(scope: ScopeRef, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `fake-entry-${label.replace(/[^A-Za-z0-9._-]/g, '-')}`),
    kind: 'execution',
    source: 'humanagent.fake-provider',
    locator: `fake/${label}`,
    scope,
  };
}

class ScenarioFakeExecutionPort implements ExecutionRuntimePort {
  readonly kind = 'humanagent.execution-runtime-port' as const;
  private readonly base: FakeReplayExecutionRuntimePort;

  constructor(
    binding: ProviderBinding,
    private readonly scenario: FakeExecutionScenario,
    stepDelayMs?: number,
  ) {
    this.base = new FakeReplayExecutionRuntimePort({
      binding,
      replay: scenarioSteps(scenario),
      stepDelayMs,
    });
  }

  probe(binding: ProviderBinding) { return this.base.probe(binding); }
  capabilities(binding: ProviderBinding) { return this.base.capabilities(binding); }
  start(input: ProviderStartInput) { return this.base.start(input); }
  resume(input: Parameters<ExecutionRuntimePort['resume']>[0]) { return this.base.resume(input); }
  submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> { return this.base.submit(input); }
  observe(input: Parameters<ExecutionRuntimePort['observe']>[0]) { return this.base.observe(input); }
  requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt> { return this.base.requestStop(input); }
  settle(input: ProviderSettleInput): Promise<ProviderSettlement> { return this.base.settle(input); }

  async close(binding: ProviderBinding): Promise<ProviderCloseResult> {
    if (this.scenario !== 'close-failure') return this.base.close(binding);
    const evidenceRef = fakeOwnerEvidence({ organId: id('organ', 'fake-organ') }, 'close-failure');
    return {
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'failed',
      evidenceRefs: [evidenceRef],
      ownerId: 'humanagent.fake-provider',
      nextAction: { kind: 'recover', ref: 'fake.close' },
      error: {
        errorId: 'fake-close-failure',
        code: 'fake.close.failed',
        category: 'provider',
        phase: 'close',
        message: 'fake replay provider close failed',
        ownerId: 'humanagent.fake-provider',
        retryable: 'terminal',
        attention: 'recovery',
        evidenceRefs: [evidenceRef],
        nextAction: { kind: 'recover', ref: 'fake.close' },
      },
    };
  }
}

export function createFakeExecutionPort(
  binding: ProviderBinding,
  stepDelayMs?: number,
  scenario: FakeExecutionScenario = 'success',
): ExecutionRuntimePort {
  return new ScenarioFakeExecutionPort(binding, scenario, stepDelayMs);
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
  readonly scenario?: FakeExecutionScenario;
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
      port: createFakeExecutionPort(options.binding, options.stepDelayMs, options.scenario),
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
