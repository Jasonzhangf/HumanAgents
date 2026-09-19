import {
  assertExecutionEpoch,
  type AgentDriver,
  type AgentEvent,
  type AgentOutput,
  type BusinessPayload,
  type CycleId,
  type EvidenceRef,
  type OperationId,
  type OrganId,
  type ProviderCloseResult,
  type ScopeRef,
  type TaskId,
} from '../../contracts/src/index.js';
import { AgentRuntime, type AgentRuntimeClosure, type AgentRuntimeSnapshot } from '../../runtime/src/nodes/agent-runtime.js';
import { AppLifecycleError } from './errors.js';

export interface AgentExecutionRequest {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly operationId: OperationId;
  readonly organId: OrganId;
  readonly cycleId?: CycleId;
  readonly ownerRef: string;
  readonly input: BusinessPayload;
  readonly inputRefs: readonly string[];
  readonly waitConditionRef?: string;
  readonly recoveryRef?: string;
}

export interface AgentExecutionReceipt {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly output: AgentOutput;
  readonly scope: ScopeRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly closure: AgentRuntimeClosure;
  readonly observedKinds: readonly string[];
  readonly outputRefs: readonly string[];
  readonly observedEvents: readonly AgentEvent[];
  readonly providerClose?: ProviderCloseResult;
}

export interface AgentExecutionSession {
  readonly runtime: AgentRuntime;
  readonly scope: ScopeRef;
  readonly operationId: OperationId;
  submit(payload: BusinessPayload): Promise<AgentOutput>;
  observe(): AsyncIterable<AgentEvent>;
  settle(): Promise<AgentRuntimeClosure>;
  snapshot(): AgentRuntimeSnapshot;
}

function requireInputRefs(inputRefs: readonly string[]): void {
  if (inputRefs.length === 0) {
    throw new AppLifecycleError(
      'agent-operation-input-missing',
      'agent operation requires an input reference',
      'provide the operation input reference before execution',
      'app-agent-execution',
    );
  }
}

function scopeFor(request: AgentExecutionRequest): ScopeRef {
  return {
    organId: request.organId,
    taskId: request.taskId,
    ...(request.cycleId ? { cycleId: request.cycleId } : {}),
    operationId: request.operationId,
  };
}

export function openAgentExecution(input: {
  readonly driver: AgentDriver;
  readonly request: AgentExecutionRequest;
}): AgentExecutionSession {
  assertExecutionEpoch(input.request.executionEpoch);
  requireInputRefs(input.request.inputRefs);
  const scope = scopeFor(input.request);
  const runtime = new AgentRuntime(input.driver, {
    runtimeId: input.request.runtimeId,
    taskId: input.request.taskId,
    assignmentId: input.request.assignmentId,
    organId: input.request.organId,
    ...(input.request.cycleId ? { cycleId: input.request.cycleId } : {}),
    operationId: input.request.operationId,
    executionEpoch: input.request.executionEpoch,
    ownerRef: input.request.ownerRef,
    ...(input.request.waitConditionRef === undefined ? {} : { waitConditionRef: input.request.waitConditionRef }),
    ...(input.request.recoveryRef === undefined ? {} : { recoveryRef: input.request.recoveryRef }),
  });
  return {
    runtime,
    scope,
    operationId: input.request.operationId,
    submit: (payload) => runtime.submit(payload),
    observe: async function* observe() {
      for await (const observation of runtime.observe()) {
        if (observation.accepted) yield observation.event;
      }
    },
    settle: () => runtime.settle(),
    snapshot: () => runtime.snapshot(),
  };
}

export async function executeAgentOperation(input: {
  readonly driver: AgentDriver;
  readonly request: AgentExecutionRequest;
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<AgentExecutionReceipt> {
  const execution = openAgentExecution(input);
  const handle = await execution.runtime.start();
  if (handle.runtimeId !== input.request.runtimeId || handle.executionEpoch !== input.request.executionEpoch) {
    throw new AppLifecycleError(
      'agent-handle-mismatch',
      'agent driver returned a handle for another runtime or epoch',
      'reject the adapter response and restart from the owning runtime',
      'app-agent-execution',
    );
  }
  const output = await execution.submit(input.request.input);
  const observedKinds: string[] = [];
  const outputRefs: string[] = [];
  const observedEvents: AgentEvent[] = [];
  for await (const event of execution.observe()) {
    observedKinds.push(event.kind);
    observedEvents.push(structuredClone(event));
    for (const ref of event.evidenceRefs) {
      if (ref.kind === 'tool') outputRefs.push(ref.locator);
    }
    await input.onEvent?.(event);
    if (event.kind === 'terminal') break;
  }
  const closure = await execution.settle();
  return {
    runtimeId: input.request.runtimeId,
    taskId: input.request.taskId,
    operationId: input.request.operationId,
    executionEpoch: input.request.executionEpoch,
    output,
    scope: execution.scope,
    evidenceRefs: closure.evidenceRefs.length > 0 ? closure.evidenceRefs : output.evidenceRefs,
    closure,
    observedKinds,
    outputRefs,
    observedEvents,
  };
}
