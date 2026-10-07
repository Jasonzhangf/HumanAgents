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
  BusinessPayload,
  EvidenceRef,
  OperationId,
  ScopeRef,
  StopRequestReceipt,
  TaskId,
} from '../../contracts/src/index.js';
import { AcpAdapterError } from './errors.js';
import type { AcpStopReason } from './protocol.js';
import type { AcpRuntimeAdaptor, AcpRuntimeCloseResult, AcpRuntimeOpenResult, AcpRuntimeSubmitResult } from './runtime.js';

/**
 * Shared ACP v1 client driver.
 *
 * This is the single implementation of the ACP conversation and of the
 * `AgentDriver` mapping for every ACP runtime. The runtime adaptor supplies
 * `open` / `load` / `submit` / `cancel` / `close`; everything about session
 * bookkeeping, event ordering, stop/settle semantics and evidence mapping is
 * owned here so the three runtimes cannot diverge.
 *
 * Identity rules enforced by construction:
 * - `runtimeId`, `taskId`, `executionEpoch`, `assignmentId`, `operationId` and
 *   `organId` come only from HumanAgent and are never minted by a runtime.
 * - The runtime's `sessionId` is recorded as correlation evidence, never used
 *   as a `TaskId`, `OperationId`, `CheckpointId` or `AgentRuntimeId`.
 * - `cancel` accepted is not `stopped`: `settle` reports `stopped` only when
 *   the runtime confirms the session is closed after a cancellation.
 */

const OWNER = 'humanagent.acp-client-driver';
const DRIVER_KIND = 'humanagent.agent-driver.acp';
const ACP_CAPABILITIES = ['acp.v1', 'acp.session', 'acp.prompt', 'acp.cancel', 'acp.settle'] as const;

export interface AcpClientDriverOptions {
  readonly runtime: AcpRuntimeAdaptor;
  /** Workspace handed to the runtime as the ACP `cwd`. */
  readonly workspace: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly promptFor?: (payload: BusinessPayload) => string;
}

interface DriverInstance {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly operationId: OperationId;
  readonly scope: ScopeRef;
  readonly runtimeVersion: string;
  sessionId: string;
  stopRequested: boolean;
  closed: boolean;
  readonly outputTexts: string[];
  readonly events: AgentEvent[];
  readonly eventWaiters: Array<(done: boolean) => void>;
  lastFailure?: Error;
  lastStopReason?: AcpStopReason;
  seq: number;
}

function defaultPromptFor(payload: BusinessPayload): string {
  if (typeof payload.prompt === 'string') return payload.prompt;
  if (typeof payload.question === 'string') return payload.question;
  return JSON.stringify(payload);
}

function evidence(ownerId: string, locator: string, scope: ScopeRef, refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return [{
    evidenceId: { scope: 'evidence' as const, value: locator },
    kind: 'external' as const,
    source: ownerId,
    locator,
    scope,
  }, ...refs];
}

function nextActionFor(ownerId: string, ref: string) {
  return { kind: 'recover' as const, ref: `${ownerId}/${ref}` };
}

/** Maps an ACP stop reason onto the HumanAgent terminal state vocabulary. */
function terminalStateFor(stopReason: AcpRuntimeSubmitResult['stopReason']): 'succeeded' | 'cancelled' | 'failed' | 'blocked' | 'unknown' {
  switch (stopReason) {
    case 'end_turn': return 'succeeded';
    case 'cancelled': return 'cancelled';
    case 'max_tokens':
    case 'max_turn_requests': return 'failed';
    case 'refusal': return 'blocked';
    default: return 'unknown';
  }
}

export function createAcpClientDriver(options: AcpClientDriverOptions): AgentDriver {
  const runtime = options.runtime;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const promptFor = options.promptFor ?? runtime.promptFor ?? defaultPromptFor;
  const instances = new Map<string, DriverInstance>();

  const key = (runtimeId: string, executionEpoch: number): string => `${runtimeId}:${executionEpoch}`;

  function requireInstance(input: { readonly runtimeId: string; readonly executionEpoch: number }): DriverInstance {
    const instance = instances.get(key(input.runtimeId, input.executionEpoch));
    if (!instance) {
      throw new AcpAdapterError({
        code: 'identity-mismatch',
        message: 'ACP client driver has no active runtime for this epoch',
        ownerId: OWNER,
        nextAction: nextActionFor(OWNER, 'no-active-runtime'),
        evidenceRefs: [],
      });
    }
    return instance;
  }

  function pushEvent(instance: DriverInstance, event: AgentEvent): void {
    instance.events.push(event);
    for (const waiter of instance.eventWaiters.splice(0)) waiter(false);
  }

  function finishEvents(instance: DriverInstance): void {
    for (const waiter of instance.eventWaiters.splice(0)) waiter(true);
  }

  function openInstance(input: AgentStartRequest): DriverInstance {
    if (!input.organId || !input.operationId) {
      const missing = [...(!input.organId ? ['organId'] : []), ...(!input.operationId ? ['operationId'] : [])];
      throw new AcpAdapterError({
        code: 'identity-mismatch',
        message: `ACP client driver requires HumanAgent-owned ${missing.join(' and ')}`,
        ownerId: OWNER,
        nextAction: nextActionFor(OWNER, 'missing-humanagent-identity'),
        evidenceRefs: [],
      });
    }
    // Evidence scope is HumanAgent's, never minted here. It is built from the
    // identity the app already supplied in the start request, so the driver's
    // evidence carries the same scope the checkpoint will be committed under.
    const scope: ScopeRef = {
      organId: input.organId,
      taskId: input.taskId,
      ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
      operationId: input.operationId,
    };
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId ?? input.runtimeId,
      operationId: input.operationId,
      scope,
      sessionId: '',
      runtimeVersion: runtime.version,
      stopRequested: false,
      closed: false,
      outputTexts: [],
      events: [],
      eventWaiters: [],
      seq: 0,
    };
  }

  async function openSession(instance: DriverInstance): Promise<void> {
    const opened = await runtime.open({
      runtimeId: instance.runtimeId,
      workspace: options.workspace,
      command: options.command,
      ...(options.args === undefined ? {} : { args: options.args }),
      timeoutMs,
      sessionIdFor: (runtimeId) => `ha-${runtimeId}-${instance.executionEpoch}`,
    });
    if (!opened || typeof opened.sessionId !== 'string' || opened.sessionId.length === 0) {
      throw new AcpAdapterError({
        code: 'transport-failure',
        message: `runtime ${runtime.runtime} did not return an ACP sessionId`,
        ownerId: OWNER,
        nextAction: nextActionFor(OWNER, 'missing-session-id'),
        evidenceRefs: [],
      });
    }
    instance.sessionId = opened.sessionId;
  }

  return {
    kind: DRIVER_KIND,

    async capabilities(): Promise<AgentCapabilities> {
      return {
        driverKind: DRIVER_KIND,
        capabilities: [...ACP_CAPABILITIES, ...runtime.capabilities],
        version: runtime.version,
      };
    },

    async start(input: AgentStartRequest): Promise<AgentHandle> {
      const instance = openInstance(input);
      instances.set(key(instance.runtimeId, instance.executionEpoch), instance);
      try {
        await openSession(instance);
      } catch (error) {
        instances.delete(key(instance.runtimeId, instance.executionEpoch));
        throw error;
      }
      return { runtimeId: instance.runtimeId, executionEpoch: instance.executionEpoch };
    },

    async resume(input: AgentResumeRequest): Promise<AgentHandle> {
      const instance = openInstance(input);
      instances.set(key(instance.runtimeId, instance.executionEpoch), instance);
      try {
        const loaded = await runtime.load({
          runtimeId: instance.runtimeId,
          sessionId: `ha-${instance.runtimeId}-${instance.executionEpoch}`,
          workspace: options.workspace,
          command: options.command,
          ...(options.args === undefined ? {} : { args: options.args }),
          timeoutMs,
        });
        instance.sessionId = loaded.sessionId;
      } catch (error) {
        instances.delete(key(instance.runtimeId, instance.executionEpoch));
        throw new AcpAdapterError({
          code: 'capability-unavailable',
          message: error instanceof Error ? error.message : 'ACP runtime cannot load the requested checkpoint',
          ownerId: OWNER,
          nextAction: nextActionFor(OWNER, 'resume-not-supported'),
          evidenceRefs: [],
          cause: error,
        });
      }
      return { runtimeId: instance.runtimeId, executionEpoch: instance.executionEpoch };
    },

    async submit(input: AgentInput): Promise<AgentOutput> {
      const instance = [...instances.values()].find((candidate) =>
        candidate.taskId.value === input.taskId.value
        && candidate.executionEpoch === input.executionEpoch
        && candidate.assignmentId === input.assignmentId);
      if (!instance) {
        throw new AcpAdapterError({
          code: 'identity-mismatch',
          message: 'ACP client driver has no active runtime for this submit',
          ownerId: OWNER,
          nextAction: nextActionFor(OWNER, 'no-active-runtime'),
          evidenceRefs: [],
        });
      }
      if (instance.closed) {
        throw new AcpAdapterError({
          code: 'transport-closed',
          message: 'ACP client driver cannot submit to a closed session',
          ownerId: OWNER,
          nextAction: nextActionFor(OWNER, 'session-closed'),
          evidenceRefs: [],
        });
      }
      const prompt = promptFor(input.payload);
      const messageId = `ha-msg-${instance.runtimeId}-${instance.executionEpoch}-${instance.seq + 1}`;
      let result: AcpRuntimeSubmitResult;
      try {
        result = await runtime.submit({
          runtimeId: instance.runtimeId,
          sessionId: instance.sessionId,
          prompt,
          messageId,
          timeoutMs,
        });
      } catch (error) {
        instance.lastFailure = error instanceof Error ? error : new Error(String(error));
        throw new AcpAdapterError({
          code: 'transport-failure',
          message: error instanceof Error ? error.message : 'ACP prompt failed',
          ownerId: OWNER,
          nextAction: nextActionFor(OWNER, 'prompt-failed'),
          evidenceRefs: [],
          cause: error,
        });
      }
      instance.seq += 1;
      instance.lastStopReason = result.stopReason;
      if (result.stopReason === 'cancelled') instance.stopRequested = true;
      const text = result.outputText ?? '';
      // A completed turn must carry an answer: the turn answer is the only
      // channel that feeds downstream roles, so an empty completed turn is a
      // protocol failure. Other stop reasons are outcomes in their own right.
      if (text.length === 0 && result.stopReason === 'end_turn') {
        // Record the rejection before throwing. `settle` reads this state, so a
        // turn this driver refused must never settle as succeeded.
        const rejection = new AcpAdapterError({
          code: 'protocol-error',
          message: `ACP runtime ${runtime.runtime} returned an empty turn answer`,
          ownerId: OWNER,
          nextAction: nextActionFor(OWNER, 'empty-turn-answer'),
          evidenceRefs: [],
        });
        instance.lastFailure = rejection;
        throw rejection;
      }
      // The turn answer travels as ordered chunk summaries, which is how every
      // consumer of `observe` reads provider output. Keeping the answer out of
      // the event stream would leave downstream roles with only lifecycle text.
      if (text.length > 0) {
        instance.outputTexts.push(text);
        pushEvent(instance, {
          taskId: instance.taskId,
          executionEpoch: instance.executionEpoch,
          kind: 'output',
          summary: text,
          evidenceRefs: evidence(OWNER, `acp/${runtime.runtime}/submit/${instance.runtimeId}/${messageId}`, instance.scope, []),
        });
      }
      // `terminal` is this codebase's terminal event kind for an agent driver.
      // Consumers stop their observation loop on exactly this kind.
      pushEvent(instance, {
        taskId: instance.taskId,
        executionEpoch: instance.executionEpoch,
        kind: 'terminal',
        terminalState: terminalStateFor(result.stopReason),
        evidenceRefs: evidence(OWNER, `acp/${runtime.runtime}/submit/${instance.runtimeId}/${messageId}`, instance.scope, []),
      });
      finishEvents(instance);
      return {
        taskId: instance.taskId,
        executionEpoch: instance.executionEpoch,
        assignmentId: instance.assignmentId,
        payload: {
          prompt,
          stopReason: result.stopReason,
          ...(result.outputText === undefined ? {} : { outputText: result.outputText }),
          ...(result.userMessageId === undefined ? {} : { userMessageId: result.userMessageId }),
        },
        outputRefs: [...instance.outputTexts.map((_, index) => `${runtime.runtime}://output/${instance.runtimeId}/${index}`)],
        evidenceRefs: evidence(OWNER, `acp/${runtime.runtime}/submit/${instance.runtimeId}/${messageId}`, instance.scope, []),
      };
    },

    async *observe(input: { readonly runtimeId: string }): AsyncIterable<AgentEvent> {
      const instance = [...instances.values()].find((candidate) => candidate.runtimeId === input.runtimeId);
      if (!instance) {
        throw new AcpAdapterError({
          code: 'identity-mismatch',
          message: 'ACP client driver has no active runtime for observation',
          ownerId: OWNER,
          nextAction: nextActionFor(OWNER, 'no-active-runtime'),
          evidenceRefs: [],
        });
      }
      let cursor = 0;
      while (cursor < instance.events.length) {
        yield instance.events[cursor]!;
        cursor += 1;
      }
      for (;;) {
        const done = await new Promise<boolean>((resolve) => {
          instance.eventWaiters.push(resolve);
        });
        if (done && cursor >= instance.events.length) return;
        while (cursor < instance.events.length) {
          yield instance.events[cursor]!;
          cursor += 1;
        }
      }
    },

    async requestStop(input: {
      readonly runtimeId: string;
      readonly executionEpoch: number;
      readonly operationId: OperationId;
    }): Promise<StopRequestReceipt> {
      const instance = requireInstance(input);
      if (input.operationId.value !== instance.operationId.value) {
        throw new AcpAdapterError({
          code: 'identity-mismatch',
          message: 'ACP client driver stop operation does not match the active execution',
          ownerId: OWNER,
          nextAction: nextActionFor(OWNER, 'operation-mismatch'),
          evidenceRefs: [],
        });
      }
      const cancelled = await runtime.cancel({
        runtimeId: instance.runtimeId,
        sessionId: instance.sessionId,
        timeoutMs,
      });
      instance.stopRequested = cancelled.accepted;
      return { requested: cancelled.accepted, operationId: instance.operationId };
    },

    async settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure> {
      const instance = requireInstance(input);
      let closeResult: AcpRuntimeCloseResult | undefined;
      try {
        closeResult = await runtime.close({
          runtimeId: instance.runtimeId,
          sessionId: instance.sessionId,
          timeoutMs,
        });
      } catch (error) {
        // Close failures are visible: the closure state must stay unresolved
        // rather than being reported as stopped.
        throw new AcpAdapterError({
          code: 'transport-closed',
          message: error instanceof Error ? error.message : 'ACP runtime could not close the session',
          ownerId: OWNER,
          nextAction: nextActionFor(OWNER, 'close-failed'),
          evidenceRefs: [],
          cause: error,
        });
      }
      instance.closed = closeResult.closed;
      finishEvents(instance);
      const scope = instance.scope;
      const closeEvidence = evidence(OWNER, `acp/${runtime.runtime}/close/${instance.runtimeId}/${instance.executionEpoch}`, scope, []);
      if (closeResult.closed && instance.stopRequested) {
        return { state: 'stopped', evidenceRefs: closeEvidence };
      }
      if (closeResult.closed && instance.lastFailure !== undefined) {
        return { state: 'failed', evidenceRefs: closeEvidence };
      }
      if (closeResult.closed) {
        // The closure must agree with the terminal state the turn already
        // reported. A truncated or refused turn is not a success, and a session
        // that never ran a turn has no outcome to report: inventing `succeeded`
        // there is exactly the fabricated success this seam forbids.
        if (instance.lastStopReason === undefined) {
          return { state: 'unknown', evidenceRefs: closeEvidence };
        }
        return { state: terminalStateFor(instance.lastStopReason), evidenceRefs: closeEvidence };
      }
      return { state: 'unknown', evidenceRefs: closeEvidence };
    },
  };
}
