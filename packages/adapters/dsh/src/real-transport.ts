import { spawn } from 'node:child_process';
import type { ChildProcessLike } from 'node:child_process';
import {
  id,
  type EvidenceRef,
  type CycleId,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderError,
  type ProviderErrorPhase,
  type ProviderEvent,
  type ProviderObserveInput,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderResumeInput,
  type ProviderSettleInput,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderStopRequest,
  type ProviderSubmitInput,
  type ProviderSubmitResult,
  type OrganId,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { DshAdapterError, dshSeamError } from './errors.js';
import { dshExecutionOrganId } from './identity.js';
import type { DshTransport, DshTransportContext } from './transport.js';
import type { DshLockDescriptor, DshProfileDescriptor } from './types.js';

/**
 * Real DSH transport over the public out-of-process stdio JSON-RPC entry.
 *
 * Verified capability boundary (see `docs/architecture/dsh-entry-proof.md`):
 * DSH 0.1.5 exposes only `initialize`, `session/prompt`, and `shutdown`. There
 * is no per-session cancel and no cross-process session resume, so this
 * transport maps `requestStop`/`settle`/`close` onto one physical action: a
 * clean runtime `shutdown` that disposes the root context, settles persistence,
 * and exits. It never fabricates a session cancel receipt, and it never claims
 * to reopen a persisted DSH session.
 *
 * All DSH wire identities stay inside this module. The session locator leaves
 * only as an `EvidenceRef`, never as HumanAgent identity.
 */

const OWNER = 'humanagent.dsh-adapter.real';
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 60 * 1000;
const DEFAULT_PROBE_TTL_MS = 60 * 1000;
const DSH_KNOWN_EVENT_TYPES = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
]);

/** Capabilities this transport actually provides over the public SDK wire. */
export const DSH_REAL_CAPABILITIES: readonly string[] = [
  'dsh.session',
  'dsh.model',
  'dsh.tool',
  'dsh.continuation',
  'dsh.stop.runtime-shutdown',
  'dsh.persistence.session-log',
];

export interface DshRealTransportOptions {
  /** Fixed binding this transport serves; DSH identities never leave the adapter. */
  readonly binding: ProviderBinding;
  readonly lock: DshLockDescriptor;
  readonly profile: DshProfileDescriptor;
  /** Absolute DSH source checkout root. */
  readonly sourceRoot: string;
  /** Absolute dedicated DSH home; never the user's default home. */
  readonly home: string;
  /** Absolute workspace root recorded on the session header. */
  readonly workspace: string;
  /** Provider route key registered by the DSH profile (for example `rcc`). */
  readonly provider: string;
  /** Model id the route serves. */
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
  /** Patch overlays applied after the profile layer; the source patch is required for clean checkouts. */
  readonly patchFiles?: readonly string[];
  readonly nodePath?: string;
  readonly nodeArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly turnTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly probeTtlMs?: number;
  readonly now?: () => Date;
  /** Spawn override for tests; production uses node:child_process.spawn. */
  readonly spawnRuntime?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Record<string, string | undefined>; readonly stdio: readonly string[] },
  ) => ChildProcessLike;
}

interface JsonRpcFrame {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface PendingRequest {
  settle(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface SessionEventEnvelope {
  readonly type: string;
  readonly seq: number;
  readonly data?: Record<string, unknown>;
  readonly ignorable?: boolean;
}

interface ExecutionIdentity {
  readonly runtimeId: string;
  readonly taskId: { readonly value: string };
  readonly operationId: { readonly value: string };
  readonly organId?: OrganId;
  readonly cycleId?: CycleId;
  readonly executionEpoch: number;
}

interface RuntimeInstance {
  readonly child: ChildProcessLike;
  readonly scope: ScopeRef;
  readonly identity: ExecutionIdentity;
  readonly sessionId: string;
  nextRequestId: number;
  readonly pending: Map<number, PendingRequest>;
  readonly events: ProviderEvent[];
  readonly eventWaiters: Array<() => void>;
  lastEventSeq: number;
  stderr: string;
  exited: boolean;
  exitResult?: { code: number | null; signal: string | null };
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  stopRequested: boolean;
  terminalState?: ProviderEvent['terminalState'];
  protocolFailure?: string;
}

/**
 * Provider-root scope for transport-level probe/capability/close evidence.
 *
 * It is not a HumanAgent operation identity. Execution evidence always uses the
 * explicit `organId`/`operationId` supplied by the HumanAgent execution input.
 */
function dshProviderRootScope(binding: ProviderBinding): ScopeRef {
  return { organId: dshExecutionOrganId(binding) };
}

function scopeFor(binding: ProviderBinding, execution: Partial<ExecutionIdentity>, organId?: OrganId): ScopeRef {
  return {
    organId: organId ?? dshProviderRootScope(binding).organId,
    ...(execution.taskId ? { taskId: id('task', execution.taskId.value) } : {}),
    ...(execution.cycleId ? { cycleId: id('cycle', execution.cycleId.value) } : {}),
    ...(execution.operationId ? { operationId: id('operation', execution.operationId.value) } : {}),
  };
}

function evidence(scope: ScopeRef, kind: EvidenceRef['kind'], label: string, locator: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `dsh-${label.replace(/[^A-Za-z0-9._-]/g, '-')}`),
    kind,
    source: OWNER,
    locator,
    scope,
  };
}

function providerError(
  scope: ScopeRef,
  phase: ProviderErrorPhase,
  code: string,
  message: string,
  category: ProviderError['category'] = 'transport',
): ProviderError {
  return {
    errorId: `dsh.${phase}.${code}`,
    code,
    category,
    phase,
    message,
    ownerId: OWNER,
    retryable: category === 'transport' || category === 'timeout' ? 'retryable' : 'manual',
    attention: 'foreground',
    evidenceRefs: [evidence(scope, 'external', `${phase}-${code}`, `dsh://error/${phase}/${code}`)],
    nextAction: { kind: 'recover', ref: OWNER },
  };
}

function executionKey(identity: ExecutionIdentity): string {
  return `${identity.runtimeId}:${identity.taskId.value}:${identity.operationId.value}:${identity.executionEpoch}`;
}

function assistantText(data: Record<string, unknown> | undefined): string {
  const message = data?.message as { readonly content?: readonly unknown[] } | undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .map((block) => {
      const candidate = block as { readonly type?: string; readonly text?: string };
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

function toolResultCallId(data: Record<string, unknown> | undefined): string | undefined {
  const message = data?.message as { readonly content?: readonly unknown[] } | undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const block of blocks) {
    const candidate = block as { readonly type?: string; readonly toolCallId?: string };
    if (candidate.type === 'tool-result' && typeof candidate.toolCallId === 'string') return candidate.toolCallId;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionEventIssue(value: unknown): string | undefined {
  if (!isRecord(value)) return 'session event is not an object';
  if (typeof value.type !== 'string' || value.type.trim().length === 0) return 'session event type is missing';
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return `session event ${value.type} has an invalid sequence`;
  if (value.ignorable !== undefined && typeof value.ignorable !== 'boolean') return `session event ${value.type} has an invalid ignorable marker`;
  if (!DSH_KNOWN_EVENT_TYPES.has(value.type) && value.ignorable !== true) {
    return `session event ${value.type} is unknown and not marked ignorable`;
  }
  if (value.data !== undefined && !isRecord(value.data)) return `session event ${value.type} has invalid data`;
  const data = isRecord(value.data) ? value.data : undefined;

  switch (value.type) {
    case 'tool/call':
      if (typeof data?.callId !== 'string' || data.callId.length === 0
        || typeof data.name !== 'string' || data.name.length === 0
        || typeof data.arguments !== 'string') {
        return 'tool/call event is missing callId, name, or arguments';
      }
      break;
    case 'tool/result':
      if (toolResultCallId(data) === undefined) return 'tool/result event is missing a tool-result call id';
      break;
    case 'assistant/message': {
      const message = data?.message;
      if (!isRecord(message) || !Array.isArray(message.content)
        || message.content.some((block) => !isRecord(block) || typeof block.type !== 'string')) {
        return 'assistant/message event has invalid message content';
      }
      break;
    }
    case 'turn/end': {
      const reason = data?.reason;
      if (!isRecord(reason) || typeof reason.kind !== 'string' || reason.kind.length === 0) {
        return 'turn/end event has no reason';
      }
      if (reason.kind === 'error'
        && (!isRecord(reason.error) || typeof reason.error.message !== 'string' || reason.error.message.length === 0)) {
        return 'turn/end error event has no error message';
      }
      if (reason.kind === 'aborted' && (!isRecord(reason.reason) || typeof reason.reason.kind !== 'string')) {
        return 'turn/end aborted event has no abort reason';
      }
      break;
    }
    default:
      break;
  }
  return undefined;
}

export function createRealDshTransport(options: DshRealTransportOptions): DshTransport {
  const now = options.now ?? (() => new Date());
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const probeTtlMs = options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;
  const runtimes = new Map<string, RuntimeInstance>();
  let closed = false;

  const launchArgs = (): readonly string[] => {
    const args = [...(options.nodeArgs ?? ['--import', 'tsx/esm'])];
    args.push(`${options.sourceRoot}/apps/cli/src/bin.ts`);
    args.push('--profile', options.profile.profileName);
    for (const patch of options.patchFiles ?? []) args.push('--patch', patch);
    return args;
  };

  function requireInstance(input: ExecutionIdentity): RuntimeInstance {
    const instance = runtimes.get(executionKey(input));
    if (!instance) {
      throw new DshAdapterError('identity-mismatch', 'DSH execution is not active; start must open it first', OWNER, { kind: 'recover', ref: OWNER });
    }
    return instance;
  }

  function request(instance: RuntimeInstance, method: string, params?: Record<string, unknown>, timeoutMs = turnTimeoutMs): Promise<unknown> {
    const requestId = instance.nextRequestId++;
    const frame = params === undefined
      ? { jsonrpc: '2.0', id: requestId, method }
      : { jsonrpc: '2.0', id: requestId, method, params };
    return new Promise<unknown>((settle, reject) => {
      const timer = setTimeout(() => {
        instance.pending.delete(requestId);
        reject(new Error(`DSH ${method} timed out after ${timeoutMs}ms; stderr=${instance.stderr}`));
      }, timeoutMs);
      instance.pending.set(requestId, { settle, reject, timer });
      try {
        instance.child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        clearTimeout(timer);
        instance.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function notifyEventWaiters(instance: RuntimeInstance): void {
    while (instance.eventWaiters.length > 0) instance.eventWaiters.pop()?.();
  }

  function mapSessionEvents(instance: RuntimeInstance, envelope: SessionEventEnvelope): ProviderEvent[] {
    const base = {
      runtimeId: instance.identity.runtimeId,
      taskId: id('task', instance.identity.taskId.value),
      operationId: id('operation', instance.identity.operationId.value),
      executionEpoch: instance.identity.executionEpoch,
    };
    const eventId = `dsh-event-${instance.sessionId}-${envelope.seq}`;
    switch (envelope.type) {
      case 'tool/call': {
        const callId = typeof envelope.data?.callId === 'string' ? envelope.data.callId : `seq-${envelope.seq}`;
        return [{
          ...base,
          eventId,
          kind: 'tool',
          outputRefs: [callId],
          evidenceRefs: [evidence(instance.scope, 'tool', `tool-call-${envelope.seq}`, `dsh://session/${instance.sessionId}/tool-call/${callId}`)],
          ownerId: OWNER,
          nextAction: { kind: 'continue', ref: OWNER },
        } satisfies ProviderEvent];
      }
      case 'tool/result': {
        const callId = toolResultCallId(envelope.data) ?? `seq-${envelope.seq}`;
        return [{
          ...base,
          eventId,
          kind: 'tool',
          outputRefs: [callId],
          evidenceRefs: [evidence(instance.scope, 'tool', `tool-result-${envelope.seq}`, `dsh://session/${instance.sessionId}/tool-result/${callId}`)],
          ownerId: OWNER,
          nextAction: { kind: 'continue', ref: OWNER },
        } satisfies ProviderEvent];
      }
      case 'assistant/message': {
        if (assistantText(envelope.data).length === 0) return [];
        return [{
          ...base,
          eventId,
          kind: 'output',
          outputRefs: [`dsh-message-${instance.sessionId}-${envelope.seq}`],
          evidenceRefs: [evidence(instance.scope, 'execution', `assistant-${envelope.seq}`, `dsh://session/${instance.sessionId}/assistant/${envelope.seq}`)],
        } satisfies ProviderEvent];
      }
      case 'turn/end': {
        const reason = (envelope.data?.reason ?? {}) as { readonly kind?: string; readonly error?: { readonly message?: string } };
        const terminalState = reason.kind === 'completed'
          ? 'succeeded' as const
          : reason.kind === 'aborted' || reason.kind === 'interrupted' || reason.kind === 'cancelled'
            ? 'cancelled' as const
            : reason.kind === 'error'
              ? 'failed' as const
              : reason.kind === 'blocked'
                ? 'blocked' as const
              : 'unknown' as const;
        const error = terminalState === 'failed'
          ? providerError(instance.scope, 'observe', 'turn-failed', reason.error?.message ?? 'DSH turn failed', 'provider')
          : undefined;
        const terminalEvent: ProviderEvent = {
          ...base,
          eventId,
          kind: 'terminal',
          terminalState,
          evidenceRefs: [evidence(instance.scope, 'execution', `turn-end-${envelope.seq}`, `dsh://session/${instance.sessionId}/turn-end/${envelope.seq}`)],
          ownerId: OWNER,
          nextAction: terminalState === 'succeeded' ? { kind: 'continue', ref: OWNER } : { kind: 'recover', ref: OWNER },
        };
        if (error) {
          return [{
            ...base,
            eventId,
            kind: 'error',
            evidenceRefs: terminalEvent.evidenceRefs,
            ownerId: OWNER,
            nextAction: { kind: 'recover', ref: OWNER },
            error,
          } satisfies ProviderEvent, terminalEvent];
        }
        return [terminalEvent];
      }
      default:
        return [];
    }
  }

  function handleFrame(instance: RuntimeInstance, frame: JsonRpcFrame): void {
    if (frame.method === 'session.event') {
      // A protocol failure makes the rest of this session stream untrusted.
      // Keep the failure latched and ignore later events so a valid terminal
      // frame cannot erase evidence that framing or ordering was corrupted.
      if (instance.protocolFailure) return;
      const params = frame.params;
      if (!params || typeof params.sessionId !== 'string') {
        emitProtocolFailure(instance, 'event-session-missing', 'DSH session.event is missing its session identity');
        return;
      }
      const sessionId = params.sessionId;
      if (sessionId !== instance.sessionId) return;
      const issue = sessionEventIssue(params.event);
      if (issue) {
        emitProtocolFailure(instance, 'event-invalid', issue);
        return;
      }
      const envelope = params.event as SessionEventEnvelope;
      if (envelope.seq <= instance.lastEventSeq) {
        emitProtocolFailure(
          instance,
          'event-sequence-invalid',
          `DSH session event sequence ${envelope.seq} did not advance past ${instance.lastEventSeq}`,
        );
        return;
      }
      instance.lastEventSeq = envelope.seq;
      for (const mapped of mapSessionEvents(instance, envelope)) {
        if (mapped.kind === 'terminal' && mapped.terminalState) {
          instance.terminalState = mapped.terminalState;
        }
        instance.events.push(mapped);
      }
      notifyEventWaiters(instance);
      return;
    }
    if (frame.id === undefined) return;
    const pending = instance.pending.get(frame.id);
    if (!pending) return;
    instance.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) {
      pending.reject(new Error(`DSH JSON-RPC ${frame.id} failed: ${frame.error.message ?? 'unknown error'}`));
      return;
    }
    pending.settle(frame.result);
  }

  function emitProtocolFailure(instance: RuntimeInstance, code: string, message: string): void {
    if (instance.protocolFailure) return;
    instance.protocolFailure = message;
    const failure = providerError(instance.scope, 'observe', code, message, 'protocol');
    instance.terminalState = 'unknown';
    instance.events.push(
      {
        runtimeId: instance.identity.runtimeId,
        taskId: id('task', instance.identity.taskId.value),
        operationId: id('operation', instance.identity.operationId.value),
        executionEpoch: instance.identity.executionEpoch,
        eventId: `dsh-event-error-${instance.sessionId}-${instance.lastEventSeq}-${code}`,
        kind: 'error',
        evidenceRefs: failure.evidenceRefs,
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: OWNER },
        error: failure,
      },
      {
        runtimeId: instance.identity.runtimeId,
        taskId: id('task', instance.identity.taskId.value),
        operationId: id('operation', instance.identity.operationId.value),
        executionEpoch: instance.identity.executionEpoch,
        eventId: `dsh-event-terminal-${instance.sessionId}-${instance.lastEventSeq}-${code}`,
        kind: 'terminal',
        terminalState: 'unknown',
        evidenceRefs: failure.evidenceRefs,
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: OWNER },
      },
    );
    notifyEventWaiters(instance);
  }

  function attach(instance: RuntimeInstance): void {
    let buffer = '';
    instance.child.stdout.on('data', (chunk: { toString(encoding: string): string }) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          handleFrame(instance, JSON.parse(line) as JsonRpcFrame);
        } catch (error) {
          emitProtocolFailure(
            instance,
            'frame-invalid',
            `DSH emitted an invalid JSON-RPC frame: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
    instance.child.stderr.on('data', (chunk: { toString(encoding: string): string }) => {
      instance.stderr += chunk.toString('utf8');
    });
  }

  function openRuntime(input: ProviderStartInput): RuntimeInstance {
    const cycleId = input.evidenceRefs[0]?.scope.cycleId;
    const scope = scopeFor(options.binding, { ...input, ...(cycleId ? { cycleId } : {}) }, input.organId);
    const identity: ExecutionIdentity = {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      ...(input.organId ? { organId: input.organId } : {}),
      ...(cycleId ? { cycleId } : {}),
      executionEpoch: input.executionEpoch,
    };
    const command = options.nodePath ?? process.execPath;
    const spawner = options.spawnRuntime ?? spawn;
    const child = spawner(command, launchArgs(), {
      cwd: options.sourceRoot,
      env: {
        ...process.env,
        DSH_HOME: options.home,
        DSH_TELEMETRY_DISABLED: '1',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolveExit: (value: { code: number | null; signal: string | null }) => void = () => {};
    const exit = new Promise<{ code: number | null; signal: string | null }>((settle) => { resolveExit = settle; });
    const instance: RuntimeInstance = {
      child,
      scope,
      identity,
      sessionId: `${input.runtimeId}:${input.taskId.value}:${input.executionEpoch}`,
      nextRequestId: 1,
      pending: new Map(),
      events: [],
      eventWaiters: [],
      lastEventSeq: -1,
      stderr: '',
      exited: false,
      exit,
      stopRequested: false,
    };
    child.once('exit', (code: number | null, signal: string | null) => {
      instance.exited = true;
      instance.exitResult = { code, signal };
      for (const pending of instance.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`DSH runtime exited before its request settled: code=${String(code)} signal=${String(signal)}`));
      }
      instance.pending.clear();
      notifyEventWaiters(instance);
      resolveExit({ code, signal });
    });
    attach(instance);
    runtimes.set(executionKey(identity), instance);
    return instance;
  }

  async function initialize(instance: RuntimeInstance): Promise<void> {
    await request(instance, 'initialize', {
      cwd: options.workspace,
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    });
  }

  async function shutdown(instance: RuntimeInstance): Promise<{ code: number | null; signal: string | null }> {
    if (!instance.exited) {
      try {
        await request(instance, 'shutdown', undefined, shutdownTimeoutMs);
      } catch (error) {
        // A runtime that exited during the request still has a real exit edge;
        // any other failure must stay visible rather than be treated as settle.
        if (!instance.exited) throw error;
      }
    }
    const result = instance.exitResult ?? await instance.exit;
    if (result.code !== 0) {
      throw new DshAdapterError(
        'transport-failure',
        `DSH runtime did not exit cleanly: code=${String(result.code)} signal=${String(result.signal)}; stderr=${instance.stderr}`,
        OWNER,
        { kind: 'recover', ref: OWNER },
      );
    }
    return result;
  }

  function validity(): { checkedAt: string; expiresAt: string } {
    const checkedAt = now();
    return {
      checkedAt: checkedAt.toISOString(),
      expiresAt: new Date(checkedAt.getTime() + probeTtlMs).toISOString(),
    };
  }

  return {
    async probe(context: DshTransportContext): Promise<ProviderReadiness> {
      const times = validity();
      const probeScope = dshProviderRootScope(context.binding);
      return {
        bindingId: context.binding.bindingId,
        providerId: context.binding.providerId,
        protocol: context.binding.protocol,
        state: closed ? 'not-ready' : 'ready',
        capabilityDigest: context.binding.capabilityDigest,
        checkedAt: times.checkedAt,
        expiresAt: times.expiresAt,
        evidenceRefs: [evidence(probeScope, 'external', 'probe', `dsh://profile/${context.profile.profileName}`)],
        ...(closed
          ? {
            failure: providerError(probeScope, 'probe', 'transport-closed', 'DSH transport is closed', 'transport'),
            ownerId: OWNER,
            nextAction: { kind: 'recover' as const, ref: OWNER },
          }
          : {}),
      };
    },

    async capabilities(context: DshTransportContext): Promise<ProviderCapabilities> {
      const times = validity();
      return {
        bindingId: context.binding.bindingId,
        providerId: context.binding.providerId,
        protocol: context.binding.protocol,
        capabilities: [...DSH_REAL_CAPABILITIES],
        version: `${options.lock.describe}+sdk-stdio`,
        digest: context.binding.capabilityDigest,
        checkedAt: times.checkedAt,
        expiresAt: times.expiresAt,
        evidenceRefs: [evidence(dshProviderRootScope(context.binding), 'external', 'capabilities', `dsh://profile/${context.profile.profileName}`)],
      };
    },

    async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
      if (closed) {
        throw new DshAdapterError('transport-failure', 'DSH transport is closed; execution cannot start', OWNER, { kind: 'recover', ref: OWNER });
      }
      const instance = openRuntime(input);
      try {
        await initialize(instance);
      } catch (error) {
        instance.child.kill('SIGTERM');
        runtimes.delete(executionKey(input));
        throw dshSeamError('transport-failure', error, { phase: 'start', ownerId: OWNER, binding: options.binding, identity: input });
      }
      const sessionEvidence = evidence(instance.scope, 'external', 'session', `dsh://session/${instance.sessionId}`);
      return {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        startedAt: now().toISOString(),
        evidenceRefs: [sessionEvidence],
        externalExecutionRef: sessionEvidence,
      };
    },

    async resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult> {
      // The public DSH SDK entry cannot reopen a persisted session, so recovery
      // starts a fresh DSH session from the HumanAgent checkpoint. The DSH log
      // stays evidence; it is never treated as HumanAgent state truth.
      const recoveryStateRef = evidence(
        scopeFor(options.binding, {
          ...input,
          ...(input.evidenceRefs[0]?.scope.cycleId ? { cycleId: input.evidenceRefs[0].scope.cycleId } : {}),
        }),
        'external',
        `recovery-${input.checkpointId.value}`,
        `humanagent://checkpoint/${input.checkpointId.value}`,
      );
      return {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        checkpointId: input.checkpointId,
        recovered: false,
        staleRejected: false,
        recoveryStateRef,
        evidenceRefs: [recoveryStateRef],
        error: providerError(
          recoveryStateRef.scope,
          'resume',
          'session-resume-unavailable',
          'DSH public SDK entry cannot reopen a persisted session; HumanAgent recovers from its own checkpoint into a fresh DSH session',
          'capability',
        ),
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: OWNER },
      };
    },

    async submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> {
      const instance = requireInstance(input);
      const prompt = typeof input.payload.prompt === 'string'
        ? input.payload.prompt
        : typeof input.payload.question === 'string'
          ? input.payload.question
          : JSON.stringify(input.payload);
      try {
        const result = await request(instance, 'session/prompt', {
          sessionId: instance.sessionId,
          contentBlocks: [{ type: 'text', text: prompt }],
        }) as { readonly messageId?: string };
        const messageId = result.messageId;
        if (typeof messageId !== 'string' || messageId.trim().length === 0) {
          throw new Error('DSH session/prompt response did not include a non-empty messageId');
        }
        return {
          runtimeId: input.runtimeId,
          taskId: input.taskId,
          operationId: input.operationId,
          executionEpoch: input.executionEpoch,
          status: 'accepted',
          outputRefs: [messageId],
          evidenceRefs: [evidence(instance.scope, 'execution', `prompt-${messageId}`, `dsh://session/${instance.sessionId}/prompt/${messageId}`)],
        };
      } catch (error) {
        const failure = providerError(instance.scope, 'submit', 'prompt-rejected', error instanceof Error ? error.message : String(error));
        return {
          runtimeId: input.runtimeId,
          taskId: input.taskId,
          operationId: input.operationId,
          executionEpoch: input.executionEpoch,
          status: 'failed',
          outputRefs: [],
          evidenceRefs: failure.evidenceRefs,
          error: failure,
        };
      }
    },

    async *observe(input: ProviderObserveInput): AsyncIterable<ProviderEvent> {
      const instance = requireInstance(input);
      let cursor = 0;
      while (true) {
        while (cursor < instance.events.length) yield instance.events[cursor++];
        if (instance.exited) {
          while (cursor < instance.events.length) yield instance.events[cursor++];
          return;
        }
        await new Promise<void>((settle) => {
          const waiter = (): void => settle();
          instance.eventWaiters.push(waiter);
          setTimeout(() => {
            const index = instance.eventWaiters.indexOf(waiter);
            if (index !== -1) instance.eventWaiters.splice(index, 1);
            settle();
          }, 100);
        });
      }
    },

    async requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt> {
      const instance = requireInstance(input);
      // DSH has no per-session cancel, so the accepted stop receipt is emitted
      // only after the real runtime shutdown request has been sent and the
      // runtime has begun settling. This is explicitly NOT a stopped outcome;
      // settle reports the final state and only then becomes a stopped closure.
      instance.stopRequested = true;
      await shutdown(instance);
      return {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        status: 'accepted',
        receivedAt: now().toISOString(),
        evidenceRefs: [evidence(instance.scope, 'operation', 'stop-requested', `dsh://session/${instance.sessionId}/stop-requested`)],
      };
    },

    async settle(input: ProviderSettleInput): Promise<ProviderSettlement> {
      const instance = requireInstance(input);
      let exit: { code: number | null; signal: string | null };
      try {
        exit = await shutdown(instance);
      } catch (error) {
        const failure = providerError(instance.scope, 'settle', 'shutdown-failed', error instanceof Error ? error.message : String(error));
        return {
          runtimeId: input.runtimeId,
          taskId: input.taskId,
          operationId: input.operationId,
          executionEpoch: input.executionEpoch,
          state: 'failed',
          evidenceRefs: failure.evidenceRefs,
          resourceRelease: { state: 'failed', evidenceRefs: failure.evidenceRefs, failure },
          persistence: { state: 'failed', evidenceRefs: failure.evidenceRefs, failure },
          error: failure,
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: OWNER },
        };
      }
      const exitEvidence = evidence(instance.scope, 'external', 'runtime-exit', `dsh://runtime/${instance.sessionId}/exit/${String(exit.code)}`);
      const persistenceEvidence = evidence(instance.scope, 'execution', 'persistence-commit', `dsh://session/${instance.sessionId}/persistence`);
      const terminalState = instance.terminalState;
      const state = terminalState === undefined
        ? instance.stopRequested
          ? 'stopped'
          : 'failed'
        : terminalState === 'failed' || terminalState === 'unknown'
          ? terminalState
          : instance.stopRequested
            ? 'stopped'
            : terminalState === 'succeeded'
              ? 'succeeded'
              : 'unknown';
      const failure = state === 'failed' || state === 'unknown'
        ? providerError(
          instance.scope,
          'settle',
          'turn-failed',
          instance.protocolFailure
            ? `DSH protocol integrity failed: ${instance.protocolFailure}`
            : state === 'unknown'
            ? 'DSH turn ended without a completed state'
            : terminalState === undefined
              ? `DSH runtime exited before terminal evidence was observed; stderr=${instance.stderr}`
              : 'DSH turn ended in failure',
          'provider',
        )
        : undefined;
      return {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        state,
        evidenceRefs: [exitEvidence, persistenceEvidence],
        resourceRelease: { state: 'released', evidenceRefs: [exitEvidence] },
        persistence: { state: 'committed', evidenceRefs: [persistenceEvidence] },
        ...(failure ? { error: failure, ownerId: OWNER, nextAction: { kind: 'recover', ref: OWNER } } : {}),
      };
    },

    async close(context: DshTransportContext): Promise<ProviderCloseResult> {
      if (closed) {
        return {
          bindingId: context.binding.bindingId,
          providerId: context.binding.providerId,
          protocol: context.binding.protocol,
          state: 'closed',
          evidenceRefs: [evidence(dshProviderRootScope(context.binding), 'external', 'close-idempotent', 'dsh://runtime/closed')],
        };
      }
      for (const instance of runtimes.values()) {
        if (instance.exited) continue;
        try {
          await shutdown(instance);
        } catch (error) {
          const failure = providerError(instance.scope, 'close', 'close-failed', error instanceof Error ? error.message : String(error));
          return {
            bindingId: context.binding.bindingId,
            providerId: context.binding.providerId,
            protocol: context.binding.protocol,
            state: 'failed',
            evidenceRefs: failure.evidenceRefs,
            error: failure,
            ownerId: OWNER,
            nextAction: { kind: 'recover', ref: OWNER },
          };
        }
      }
      closed = true;
      return {
        bindingId: context.binding.bindingId,
        providerId: context.binding.providerId,
        protocol: context.binding.protocol,
        state: 'closed',
        evidenceRefs: [evidence(dshProviderRootScope(context.binding), 'external', 'close', 'dsh://runtime/closed')],
      };
    },
  };
}
