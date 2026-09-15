import {
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
  type CheckpointId,
  type CycleId,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type OperationId,
  type OrganId,
  type ProviderBinding,
  type ProviderEvent,
  type ProviderSettlement,
  type StopRequestReceipt,
  type TaskId,
} from '../../../contracts/src/index.js';
import { DshAdapterError } from './errors.js';

/**
 * `ExecutionRuntimePort`-backed `AgentDriver`.
 *
 * `AgentRuntime` owns Task / execution epoch / assignment; DSH owns only
 * profile, session, agent, tool, and model. This adapter is the single place
 * where those two vocabularies meet. It requires HumanAgent to supply the
 * organ and operation identity and keeps every DSH / provider identity inside
 * `EvidenceRef`s that leave the adapter.
 */

const OWNER = 'humanagent.dsh-adapter.driver';
const DRIVER_KIND = 'humanagent.agent-driver.dsh';

export interface DshAgentDriverOptions {
  readonly runtime: ExecutionRuntimePort;
  readonly binding: ProviderBinding;
  /** Prompt derived from one business submit payload. */
  readonly promptFor?: (payload: BusinessPayload) => string;
}

interface DriverInstance {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly operationId: OperationId;
  readonly organId: OrganId;
  readonly cycleId?: CycleId;
}

function defaultPrompt(payload: BusinessPayload): string {
  if (typeof payload.prompt === 'string') return payload.prompt;
  if (typeof payload.question === 'string') return payload.question;
  return JSON.stringify(payload);
}

function toAgentEvent(instance: DriverInstance, event: ProviderEvent): AgentEvent {
  return {
    taskId: instance.taskId,
    executionEpoch: instance.executionEpoch,
    kind: event.kind,
    evidenceRefs: event.evidenceRefs,
  };
}

function closureState(settlement: ProviderSettlement): AgentClosure['state'] {
  switch (settlement.state) {
    case 'succeeded': return 'succeeded';
    case 'waiting': return 'waiting';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'stopped': return 'stopped';
    default: return 'unknown';
  }
}

function isFinalSettlement(settlement: ProviderSettlement): boolean {
  return (settlement.state === 'succeeded' || settlement.state === 'stopped' || settlement.state === 'cancelled')
    && settlement.resourceRelease.state === 'released'
    && settlement.persistence.state === 'committed';
}

export function createDshAgentDriver(options: DshAgentDriverOptions): AgentDriver {
  const promptFor = options.promptFor ?? defaultPrompt;
  const instances = new Map<string, DriverInstance>();

  const key = (runtimeId: string, executionEpoch: number): string => `${runtimeId}:${executionEpoch}`;

  function requireInstance(runtimeId: string, executionEpoch: number): DriverInstance {
    const instance = instances.get(key(runtimeId, executionEpoch));
    if (!instance) {
      throw new DshAdapterError('identity-mismatch', 'DSH agent driver has no active runtime for this epoch', OWNER, { kind: 'recover', ref: OWNER });
    }
    return instance;
  }

  function openInstance(input: {
    readonly runtimeId: string;
    readonly taskId: TaskId;
    readonly executionEpoch: number;
    readonly assignmentId?: string;
    readonly organId?: OrganId;
    readonly cycleId?: CycleId;
    readonly operationId?: OperationId;
  }): DriverInstance {
    if (!input.organId || !input.operationId) {
      const missing = [
        ...(input.organId ? [] : ['organId']),
        ...(input.operationId ? [] : ['operationId']),
      ];
      throw new DshAdapterError(
        'identity-mismatch',
        `DSH agent driver requires HumanAgent-owned ${missing.join(' and ')}`,
        OWNER,
        { kind: 'recover', ref: OWNER },
      );
    }
    const organId = input.organId;
    const operationId = input.operationId;
    const instance: DriverInstance = {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId ?? input.runtimeId,
      organId,
      ...(input.cycleId ? { cycleId: input.cycleId } : {}),
      operationId,
    };
    instances.set(key(input.runtimeId, input.executionEpoch), instance);
    return instance;
  }

  const startInput = (input: AgentStartRequest, instance: DriverInstance) => ({
    runtimeId: instance.runtimeId,
    taskId: instance.taskId,
    operationId: instance.operationId,
    executionEpoch: instance.executionEpoch,
    inputRefs: [instance.assignmentId],
    evidenceRefs: [{
      evidenceId: { scope: 'evidence' as const, value: `dsh-driver-start-${instance.runtimeId}-${instance.executionEpoch}` },
      kind: 'operation' as const,
      source: OWNER,
      locator: `humanagent://agent-runtime/${instance.runtimeId}/${instance.executionEpoch}`,
      scope: {
        organId: instance.organId,
        taskId: instance.taskId,
        ...(instance.cycleId ? { cycleId: instance.cycleId } : {}),
        operationId: instance.operationId,
      },
    }],
  });

  return {
    kind: DRIVER_KIND,

    async capabilities(): Promise<AgentCapabilities> {
      const capabilities = await options.runtime.capabilities(options.binding);
      return {
        driverKind: DRIVER_KIND,
        capabilities: capabilities.capabilities,
        version: capabilities.version,
      };
    },

    async start(input: AgentStartRequest): Promise<AgentHandle> {
      const instance = openInstance(input);
      await options.runtime.start(startInput(input, instance));
      return { runtimeId: instance.runtimeId, executionEpoch: instance.executionEpoch };
    },

    async resume(input: AgentResumeRequest): Promise<AgentHandle> {
      const instance = openInstance(input);
      const result = await options.runtime.resume({
        ...startInput(input, instance),
        checkpointId: input.checkpointId,
        checkpointExecutionEpoch: instance.executionEpoch,
      });
      if (!result.recovered) {
        // DSH cannot reopen a persisted session. Surfacing the original error is
        // required; HumanAgent recovery owns starting a fresh DSH session.
        instances.delete(key(instance.runtimeId, instance.executionEpoch));
        throw new DshAdapterError(
          'capability-unavailable',
          result.error?.message ?? 'DSH runtime cannot resume the requested checkpoint',
          result.ownerId ?? OWNER,
          { kind: 'recover', ref: result.nextAction?.ref ?? OWNER },
        );
      }
      return { runtimeId: instance.runtimeId, executionEpoch: instance.executionEpoch };
    },

    async submit(input: AgentInput): Promise<AgentOutput> {
      const instance = [...instances.values()].find((candidate) =>
        candidate.taskId.value === input.taskId.value
        && candidate.executionEpoch === input.executionEpoch
        && candidate.assignmentId === input.assignmentId);
      if (!instance) {
        throw new DshAdapterError('identity-mismatch', 'DSH agent driver has no active runtime for this submit', OWNER, { kind: 'recover', ref: OWNER });
      }
      const result = await options.runtime.submit({
        runtimeId: instance.runtimeId,
        taskId: instance.taskId,
        operationId: instance.operationId,
        executionEpoch: instance.executionEpoch,
        inputRefs: [instance.assignmentId],
        evidenceRefs: [],
        payload: { prompt: promptFor(input.payload) },
      });
      return {
        taskId: instance.taskId,
        executionEpoch: instance.executionEpoch,
        assignmentId: instance.assignmentId,
        payload: {
          status: result.status,
          ...(result.payload ? { provider: result.payload } : {}),
        },
        outputRefs: result.outputRefs,
        evidenceRefs: result.evidenceRefs,
      };
    },

    async *observe(input: { readonly runtimeId: string }): AsyncIterable<AgentEvent> {
      const instance = [...instances.values()].find((candidate) => candidate.runtimeId === input.runtimeId);
      if (!instance) {
        throw new DshAdapterError('identity-mismatch', 'DSH agent driver has no active runtime for observation', OWNER, { kind: 'recover', ref: OWNER });
      }
      for await (const event of options.runtime.observe({
        runtimeId: instance.runtimeId,
        taskId: instance.taskId,
        operationId: instance.operationId,
        executionEpoch: instance.executionEpoch,
      })) {
        yield toAgentEvent(instance, event);
      }
    },

    async requestStop(input: {
      readonly runtimeId: string;
      readonly executionEpoch: number;
      readonly operationId: OperationId;
    }): Promise<StopRequestReceipt> {
      const instance = requireInstance(input.runtimeId, input.executionEpoch);
      if (input.operationId.value !== instance.operationId.value) {
        throw new DshAdapterError(
          'identity-mismatch',
          'DSH agent driver stop operation does not match the active execution',
          OWNER,
          { kind: 'recover', ref: OWNER },
        );
      }
      const receipt = await options.runtime.requestStop({
        runtimeId: instance.runtimeId,
        taskId: instance.taskId,
        operationId: instance.operationId,
        executionEpoch: instance.executionEpoch,
        reason: 'humanagent stop',
        ownerId: OWNER,
      });
      if (receipt.status === 'rejected') {
        throw new DshAdapterError(
          'stop-rejected',
          receipt.error?.message ?? 'DSH stop request was rejected',
          receipt.ownerId ?? OWNER,
          { kind: 'recover', ref: receipt.nextAction?.ref ?? OWNER },
        );
      }
      return { requested: true, operationId: instance.operationId };
    },

    async settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure> {
      const instance = requireInstance(input.runtimeId, input.executionEpoch);
      const settlement = await options.runtime.settle({
        runtimeId: instance.runtimeId,
        taskId: instance.taskId,
        operationId: instance.operationId,
        executionEpoch: instance.executionEpoch,
      });
      if (isFinalSettlement(settlement)) {
        instances.delete(key(instance.runtimeId, instance.executionEpoch));
      }
      return { state: closureState(settlement), evidenceRefs: settlement.evidenceRefs };
    },
  };
}
