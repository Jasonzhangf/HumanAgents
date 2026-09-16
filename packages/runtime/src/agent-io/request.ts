import type { AgentHookRegistry } from '../hooks/registry.js';
import { decodeControlBlock } from './control-block.js';
import type { AgentIoEvent, AgentHookStage } from './events.js';
import type {
  AgentControlBlock,
  AgentIoBinding,
  AgentIoBudgetRecord,
  AgentIoClock,
  AgentIoClosure,
  AgentIoError,
  AgentIoAttemptStatus,
  AgentIoPolicy,
  AgentIoRequest,
  AgentIoRequestControl,
  AgentIoRequestData,
  AgentIoRequestStatus,
  AgentIoRestartBudgetStore,
} from './types.js';
import { DEFAULT_AGENT_IO_POLICY } from './types.js';
import { emptyAgentIoBudgetRecord } from './budget.js';

export interface AgentIoProviderResponseChunk {
  readonly sequence: number;
  readonly sourceRef: string;
  readonly cursor?: string;
  readonly kind: 'delta' | 'tool-intent' | 'memory-candidate' | 'transport-end' | 'error';
  readonly text?: string;
  readonly progressRef?: string;
  readonly toolIntent?: {
    readonly toolRef: string;
    readonly inputRef?: string;
    readonly reason?: { readonly title: string };
  };
  readonly memoryCandidate?: {
    readonly ref: string;
    readonly kind?: string;
    readonly title?: string;
    readonly summary?: string;
    readonly sourceRefs?: readonly string[];
  };
  readonly error?: AgentIoError;
}

export interface EndTurnResult {
  readonly accepted: boolean;
  readonly repairRequired?: boolean;
  readonly decode?: ReturnType<typeof decodeControlBlock>;
  readonly reason?: string;
}

export interface AgentIoRequestCoordinatorOptions {
  readonly control: AgentIoRequestControl;
  readonly lockedBinding: AgentIoBinding;
  readonly data: AgentIoRequestData;
  readonly clock: AgentIoClock;
  readonly budgetStore: AgentIoRestartBudgetStore;
  readonly onEvent: (event: AgentIoEvent) => void | Promise<void>;
  readonly hooks?: AgentHookRegistry;
  readonly policy?: Partial<AgentIoPolicy>;
}

export class AgentIoRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly ownerId: string,
    readonly retryable = false,
    readonly nextAction?: string,
  ) {
    super(message);
    this.name = 'AgentIoRequestError';
  }
}

const DEFAULT_PROGRESS_POLICY = DEFAULT_AGENT_IO_POLICY;

function sameProviderBinding(left: AgentIoBinding['provider'], right: AgentIoBinding['provider']): boolean {
  return left.bindingId === right.bindingId
    && left.providerId === right.providerId
    && left.protocol === right.protocol
    && left.endpointRef === right.endpointRef
    && left.modelRef === right.modelRef
    && left.configDigest === right.configDigest
    && left.capabilityDigest === right.capabilityDigest
    && left.owner === right.owner;
}

function assertLockedBinding(control: AgentIoRequestControl, locked: AgentIoBinding): void {
  if (control.binding.kind !== locked.kind) {
    throw new AgentIoRequestError(
      'request.binding.mismatch',
      'request binding kind does not match the locked runtime binding',
      locked.provider.owner,
      false,
      'recreate the request from the current runtime binding',
    );
  }
  if (control.binding.kind === 'task' && locked.kind === 'task' && control.binding.executionEpoch !== locked.executionEpoch) {
    throw new AgentIoRequestError(
      'request.binding.stale',
      'request execution epoch does not match the locked runtime binding',
      locked.provider.owner,
      false,
      'recreate the request from the current execution epoch',
    );
  }
  const matches = control.binding.kind === 'interaction' && locked.kind === 'interaction'
    ? control.binding.interactionScopeId === locked.interactionScopeId
      && control.binding.bindingFingerprint === locked.bindingFingerprint
    : control.binding.kind === 'task' && locked.kind === 'task'
      && control.binding.taskId === locked.taskId
      && control.binding.assignmentId === locked.assignmentId
      && control.binding.executionEpoch === locked.executionEpoch
      && control.binding.bindingFingerprint === locked.bindingFingerprint;
  if (!matches || !sameProviderBinding(control.binding.provider, locked.provider)) {
    throw new AgentIoRequestError(
      'request.binding.mismatch',
      'request binding does not match the locked runtime binding',
      locked.provider.owner,
      false,
      'recreate the request from the current runtime binding',
    );
  }
}

export class AgentIoRequestCoordinator {
  readonly requestId: string;
  readonly attemptId: string;
  readonly control: AgentIoRequestControl;
  readonly data: AgentIoRequestData;

  private status: AgentIoRequestStatus = 'created';
  private closed = false;
  private closing = false;
  private closure?: AgentIoClosure;
  private budget: AgentIoBudgetRecord;
  private readonly policy: AgentIoPolicy;
  private readonly emitted: string[] = [];
  private sequence = 0;
  private lastChunkSequence = 0;
  private lastActivityAtMs: number;
  private lastProgressAtMs: number;
  private startedAtMs: number;
  private turnStartedAtMs: number;
  private currentRaw = '';
  private latestSourceRef?: string;
  private latestCursor?: string;
  private latestControl?: Readonly<Partial<AgentControlBlock>>;
  private latestDecodeStatus?: string;
  private progressObservedInTurn = false;
  private repairOrdinal = 0;

  private constructor(
    options: AgentIoRequestCoordinatorOptions,
    budget: AgentIoBudgetRecord,
    nowMs: number,
  ) {
    this.clock = options.clock;
    this.budgetStore = options.budgetStore;
    this.onEvent = options.onEvent;
    this.hooks = options.hooks;
    this.requestId = options.control.requestId;
    this.attemptId = options.control.attemptId;
    this.control = { ...options.control, binding: structuredClone(options.lockedBinding) };
    this.data = options.data;
    this.budget = budget;
    this.policy = { ...DEFAULT_PROGRESS_POLICY, ...options.policy };
    this.startedAtMs = nowMs;
    this.turnStartedAtMs = nowMs;
    this.lastActivityAtMs = nowMs;
    this.lastProgressAtMs = nowMs;
  }

  static async create(options: AgentIoRequestCoordinatorOptions): Promise<AgentIoRequestCoordinator> {
    assertLockedBinding(options.control, options.lockedBinding);
    const existing = await options.budgetStore.read(options.control.requestId);
    const policy = { ...DEFAULT_PROGRESS_POLICY, ...options.policy };
    const budget = existing
      ? { ...existing, turnsSinceProbe: existing.turnsSinceProbe ?? 0, restartCount: existing.restartCount + 1 }
      : { ...emptyAgentIoBudgetRecord(), restartCount: 0 };
    if (budget.restartCount > policy.restartBudget) {
      throw new AgentIoRequestError(
        'restart.budget.exhausted',
        'request restart budget is exhausted',
        options.control.binding.provider.owner,
      );
    }
    const coordinator = new AgentIoRequestCoordinator(options, budget, options.clock.now());
    await coordinator.persistBudget();
    return coordinator;
  }

  async start(): Promise<AgentIoRequest> {
    if (this.status !== 'created') throw this.error('request.already.started', 'request is already started');
    this.turnStartedAtMs = this.nowMs();
    await this.emitStage('request.created', 'request.created');
    await this.emitStage('request.admitted', 'request.admitted');
    await this.emitStage('request.before-dispatch', 'request.before-dispatch');
    await this.emitStage('request.dispatched', 'request.dispatched');
    this.status = 'dispatched';
    await this.emitStage('attempt.started', 'attempt.started');
    this.status = 'running';
    return this.snapshot();
  }

  async acceptChunk(chunk: AgentIoProviderResponseChunk): Promise<void> {
    this.assertOpenRunning();
    const now = this.nowMs();
    this.lastActivityAtMs = now;
    if (chunk.sequence < 1 || chunk.sequence <= this.lastChunkSequence) {
      await this.emit({
        kind: 'stream.gap',
        sourceRef: chunk.sourceRef,
        diagnostics: ['duplicate or out-of-order chunk ignored'],
        ownerId: this.control.binding.kind === 'task' ? this.control.binding.provider.owner : this.control.binding.provider.owner,
      });
      return;
    }
    if (chunk.sequence > this.lastChunkSequence + 1) {
      await this.emit({
        kind: 'stream.gap',
        sourceRef: chunk.sourceRef,
        diagnostics: [`stream gap before sequence ${chunk.sequence}`],
        ownerId: this.control.binding.provider.owner,
      });
    }
    this.lastChunkSequence = chunk.sequence;
    this.latestSourceRef = chunk.sourceRef;
    this.latestCursor = chunk.cursor;

    switch (chunk.kind) {
      case 'delta': {
        this.currentRaw += chunk.text ?? '';
        await this.emit({
          kind: 'agent.delta.received',
          sourceRef: chunk.sourceRef,
          diagnostics: [chunk.text ?? ''],
          ownerId: this.control.binding.provider.owner,
        });
        if (chunk.progressRef) {
          this.markProgress();
          await this.emit({
            kind: 'agent.output.received',
            sourceRef: chunk.sourceRef,
            payloadRef: chunk.progressRef,
            ownerId: this.control.binding.provider.owner,
          });
        }
        break;
      }
      case 'tool-intent': {
        if (!chunk.toolIntent) throw this.error('chunk.tool-intent.invalid', 'tool intent chunk requires toolIntent');
        this.markProgress();
        await this.emit({
          kind: 'tool-intent.decoded',
          sourceRef: chunk.sourceRef,
          toolIntentRef: chunk.toolIntent.inputRef,
          ownerId: this.control.binding.provider.owner,
          control: { next: { kind: 'tool', objective: chunk.toolIntent.toolRef } },
        });
        break;
      }
      case 'memory-candidate': {
        if (!chunk.memoryCandidate) throw this.error('chunk.memory-candidate.invalid', 'memory candidate chunk requires memoryCandidate');
        this.markProgress();
        await this.emit({
          kind: 'memory-candidate',
          sourceRef: chunk.sourceRef,
          memoryCandidateRef: chunk.memoryCandidate.ref,
          ownerId: this.control.binding.provider.owner,
          control: { memory: { learned: [{ kind: chunk.memoryCandidate.kind as 'fact' | 'lesson' | 'dead-end' | 'preference' | 'skill-candidate', title: chunk.memoryCandidate.title ?? chunk.memoryCandidate.ref, summary: chunk.memoryCandidate.summary ?? '', sourceRefs: chunk.memoryCandidate.sourceRefs ? [...chunk.memoryCandidate.sourceRefs] : undefined }] } },
        });
        break;
      }
      case 'error': {
        if (!chunk.error) throw this.error('chunk.error.invalid', 'error chunk requires error');
        await this.closeWith({
          status: 'failed',
          reason: chunk.error.message,
          ownerId: chunk.error.ownerId,
          evidenceRefs: [],
          nextAction: chunk.error.nextAction,
        });
        break;
      }
      case 'transport-end': {
        await this.endOfStream({ sourceRef: chunk.sourceRef, cursor: chunk.cursor });
        break;
      }
    }
  }

  async endTurn(input: {
    readonly raw?: string;
    readonly sourceRef: string;
    readonly cursor?: string;
    readonly progressRef?: string;
    readonly repairing?: boolean;
  }): Promise<EndTurnResult> {
    this.assertOpenRunning();
    if (this.status === 'repairing' && input.repairing !== true) {
      throw this.error('request.not.repairable', 'request must be repaired through the repair path');
    }
    const now = this.nowMs();
    this.lastActivityAtMs = now;
    this.turnStartedAtMs = now;
    this.latestSourceRef = input.sourceRef;
    this.latestCursor = input.cursor;
    if (input.raw) this.currentRaw += input.raw;
    if (input.progressRef) this.markProgress();

    const decode = decodeControlBlock({ sourceRef: input.sourceRef, raw: this.currentRaw });
    this.latestDecodeStatus = decode.status;
    if (decode.rejectedBindings && decode.rejectedBindings.length > 0) {
      await this.emit({
        kind: 'response.decoded',
        sourceRef: input.sourceRef,
        diagnostics: decode.diagnostics,
        ownerId: this.control.binding.provider.owner,
      });
      await this.closeWith({
        status: 'protocol-noncompliant',
        reason: `control block contains forbidden binding fields: ${decode.rejectedBindings.join(', ')}`,
        ownerId: this.control.binding.provider.owner,
        evidenceRefs: [],
        nextAction: 'settle through harness control',
      });
      return {
        accepted: false,
        reason: `control block contains forbidden binding fields: ${decode.rejectedBindings.join(', ')}`,
        decode,
      };
    }

    this.latestControl = decode.block;
    await this.emit({
      kind: 'control.decoded',
      sourceRef: input.sourceRef,
      control: decode.block,
      diagnostics: decode.diagnostics,
      ownerId: this.control.binding.provider.owner,
    });
    await this.emit({
      kind: 'response.decoded',
      sourceRef: input.sourceRef,
      control: decode.block,
      diagnostics: decode.diagnostics,
      ownerId: this.control.binding.provider.owner,
    });

    this.budget = {
      ...this.budget,
      totalTurns: this.budget.totalTurns + 1,
      turnsSinceProbe: this.budget.turnsSinceProbe + 1,
    };
    if (!this.progressObservedInTurn) {
      this.budget = { ...this.budget, noProgressTurns: this.budget.noProgressTurns + 1 };
    }
    this.progressObservedInTurn = false;
    await this.persistBudget();

    const probeRequired = this.budget.turnsSinceProbe >= Math.max(1, this.policy.maxTurnsBetweenProbes);
    if (decode.status !== 'valid' || !decode.block?.summary) {
      this.budget = { ...this.budget, controlRepairAttempts: this.budget.controlRepairAttempts + 1 };
      this.repairOrdinal += 1;
      this.status = 'repairing';
      await this.persistBudget();
      await this.emit({
        kind: 'protocol.repair',
        sourceRef: input.sourceRef,
        diagnostics: [
          probeRequired
            ? 'control probe requires summary; entering bounded repair'
            : 'end-turn summary missing; entering bounded repair',
        ],
        ownerId: this.control.binding.provider.owner,
      });
      if (this.budget.controlRepairAttempts > this.policy.maxControlRepairAttempts) {
        await this.closeWith({
          status: 'protocol-noncompliant',
          reason: probeRequired
            ? 'control probe summary missing after bounded repair attempts'
            : 'end-turn summary missing after bounded repair attempts',
          ownerId: this.control.binding.provider.owner,
          evidenceRefs: [],
          nextAction: 'save raw response and settle through harness control',
        });
      }
      return {
        accepted: false,
        repairRequired: true,
        reason: probeRequired ? 'control probe requires summary' : 'end-turn summary is required',
        decode,
      };
    }

    if (probeRequired) {
      this.budget = { ...this.budget, turnsSinceProbe: 0 };
      await this.persistBudget();
    }

    this.currentRaw = '';
    await this.closeWith({
      status: 'completed',
      reason: input.repairing ? 'end-turn repair accepted' : 'end-turn summary accepted',
      ownerId: this.control.binding.provider.owner,
      evidenceRefs: [],
    });
    return { accepted: true, decode };
  }

  async repair(input: {
    readonly raw: string;
    readonly sourceRef: string;
  }): Promise<EndTurnResult> {
    if ((this.status !== 'running' && this.status !== 'repairing') || this.closed) {
      throw this.error('request.not.repairable', 'request must be running before a repair response is accepted');
    }
    this.currentRaw = '';
    return this.endTurn({ raw: input.raw, sourceRef: input.sourceRef, repairing: true });
  }

  async endOfStream(input: {
    readonly sourceRef: string;
    readonly cursor?: string;
  }): Promise<AgentIoClosure> {
    if (this.closed) return structuredClone(this.closure ?? this.incompleteClosure());
    this.assertOpenRunning();
    this.lastActivityAtMs = this.nowMs();
    this.latestSourceRef = input.sourceRef;
    this.latestCursor = input.cursor;
    await this.emit({
      kind: 'transport.eof',
      sourceRef: input.sourceRef,
      diagnostics: ['provider stream ended; EOF is not completion'],
      ownerId: this.control.binding.provider.owner,
    });
    const closure = this.incompleteClosure();
    await this.closeWith(closure);
    return structuredClone(closure);
  }

  async checkWatchdog(): Promise<AgentIoClosure | undefined> {
    if (this.closed) return this.closure ? structuredClone(this.closure) : undefined;
    const now = this.nowMs();
    if (this.budget.totalTurns >= this.policy.maxTotalTurns) {
      return this.watchdogStop('max total turns reached');
    }
    if (this.budget.noProgressTurns >= this.policy.maxNoProgressTurns) {
      return this.watchdogStop('no-progress turn budget reached');
    }
    if (now - this.lastActivityAtMs >= this.policy.maxSilentDurationMs) {
      return this.watchdogStop('max silent duration reached');
    }
    if (now - this.turnStartedAtMs >= this.policy.maxTurnDurationMs) {
      return this.watchdogStop('max turn duration reached');
    }
    if (this.policy.noProgressAtMs !== undefined && now - this.lastProgressAtMs >= this.policy.noProgressAtMs) {
      return this.watchdogStop('no-progress duration reached');
    }
    return undefined;
  }

  snapshot(): AgentIoRequest {
    return {
      requestId: this.requestId,
      attemptId: this.attemptId,
      control: structuredClone(this.control),
      data: structuredClone(this.data),
      status: this.status,
      attempt: {
        attemptId: this.attemptId,
        status: this.attemptStatus(),
        repairOrdinal: this.repairOrdinal,
        turnNumber: this.budget.totalTurns,
        startedAtMs: this.startedAtMs,
        lastActivityAtMs: this.lastActivityAtMs,
        lastProgressAtMs: this.lastProgressAtMs,
        latestSourceRef: this.latestSourceRef,
        latestCursor: this.latestCursor,
      },
      totalTurns: this.budget.totalTurns,
      noProgressTurns: this.budget.noProgressTurns,
      controlRepairAttempts: this.budget.controlRepairAttempts,
      turnsSinceProbe: this.budget.turnsSinceProbe,
      closed: this.closed,
    };
  }

  budgetRecord(): Readonly<AgentIoBudgetRecord> {
    return structuredClone(this.budget);
  }

  latestControlBlock(): Readonly<Partial<AgentControlBlock>> | undefined {
    return this.latestControl ? structuredClone(this.latestControl) : undefined;
  }

  private async watchdogStop(reason: string): Promise<AgentIoClosure> {
    await this.emit({
      kind: 'watchdog.stopped',
      sourceRef: this.latestSourceRef,
      diagnostics: [reason],
      ownerId: this.control.binding.provider.owner,
    });
    const closure: AgentIoClosure = {
      status: 'incomplete',
      reason,
      ownerId: this.control.binding.provider.owner,
      evidenceRefs: [],
      nextAction: 'settle through harness control',
    };
    await this.closeWith(closure);
    return structuredClone(closure);
  }

  private async closeWith(closure: AgentIoClosure): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      await this.emit(
        { kind: 'request.settled', sourceRef: this.latestSourceRef, ownerId: closure.ownerId, closure },
        () => {
          this.closure = closure;
          this.status = closure.status === 'protocol-noncompliant' || closure.status === 'failed' ? 'failed' : closure.status === 'completed' ? 'settled' : closure.status === 'incomplete' ? 'incomplete' : 'unknown';
          this.closed = true;
        },
      );
    } finally {
      this.closing = false;
    }
  }

  private incompleteClosure(): AgentIoClosure {
    return {
      status: 'incomplete',
      reason: 'provider transport ended before request settled',
      ownerId: this.control.binding.provider.owner,
      evidenceRefs: [],
      nextAction: 'reconcile or create a new attempt from a checkpoint',
    };
  }

  private markProgress(): void {
    this.progressObservedInTurn = true;
    this.lastProgressAtMs = this.nowMs();
  }

  private async persistBudget(): Promise<void> {
    await this.budgetStore.write(this.requestId, this.budget);
  }

  private assertOpenRunning(): void {
    if (this.closed) throw this.error('request.closed', 'request is closed');
    if (this.status !== 'running' && this.status !== 'repairing' && this.status !== 'dispatched') {
      throw this.error('request.not.running', `request is not running: ${this.status}`);
    }
  }

  private nowMs(): number {
    return this.clock.now();
  }

  private readonly clock: AgentIoClock;
  private readonly budgetStore: AgentIoRestartBudgetStore;
  private readonly onEvent: (event: AgentIoEvent) => void | Promise<void>;
  private readonly hooks?: AgentHookRegistry;

  private async emitStage(stage: AgentHookStage, kind: AgentIoEvent['kind']): Promise<void> {
    await this.emit({ kind, stage });
  }

  private async emit(
    input: Omit<AgentIoEvent, 'eventId' | 'requestId' | 'attemptId' | 'sequence' | 'occurredAtMs' | 'stage'> & { readonly stage?: AgentHookStage; readonly kind: AgentIoEvent['kind'] },
    beforePublish?: () => void,
  ): Promise<void> {
    const event: AgentIoEvent = {
      ...input,
      eventId: `event-${this.requestId}-${input.kind}-${++this.sequence}`,
      requestId: this.requestId,
      attemptId: this.attemptId,
      sequence: this.sequence,
      occurredAtMs: this.nowMs(),
      stage: input.stage ?? this.stageForKind(input.kind),
    };
    this.emitted.push(event.eventId);
    if (input.kind.startsWith('hook.')) {
      await this.onEvent(event);
      return;
    }
    const results = await this.hooks?.runStage(event.stage, {
      requestId: this.requestId,
      attemptId: this.attemptId,
      sourceRef: this.latestSourceRef,
      correlation: this.control.idempotencyKey,
    }, 'enter');
    const enterFailure = results?.find((result) => result.blocked);
    if (enterFailure) {
      throw new AgentIoRequestError(
        'hook.blocked',
        `core hook blocked stage ${event.stage}`,
        enterFailure.result.ownerId ?? enterFailure.hookId,
        false,
        enterFailure.result.status === 'failed' || enterFailure.result.status === 'waiting'
          ? enterFailure.result.nextAction ?? `inspect hook ${enterFailure.hookId}`
          : undefined,
      );
    }
    const exitResults = await this.hooks?.runStage(event.stage, {
      requestId: this.requestId,
      attemptId: this.attemptId,
      sourceRef: this.latestSourceRef,
      correlation: this.control.idempotencyKey,
    }, 'exit');
    const exitFailure = exitResults?.find((result) => result.blocked);
    if (exitFailure) {
      throw new AgentIoRequestError(
        'hook.blocked',
        `core hook blocked stage ${event.stage} exit`,
        exitFailure.result.ownerId ?? exitFailure.hookId,
        false,
        exitFailure.result.status === 'failed' || exitFailure.result.status === 'waiting'
          ? exitFailure.result.nextAction ?? `inspect hook ${exitFailure.hookId}`
          : undefined,
      );
    }
    beforePublish?.();
    await this.onEvent(event);
  }

  private stageForKind(kind: AgentIoEvent['kind']): AgentHookStage {
    switch (kind) {
      case 'request.created': return 'request.created';
      case 'request.admitted': return 'request.admitted';
      case 'request.before-dispatch': return 'request.before-dispatch';
      case 'request.dispatched': return 'request.dispatched';
      case 'attempt.started': return 'attempt.started';
      case 'agent.delta.received': return 'response.received';
      case 'agent.output.received': return 'response.received';
      case 'response.decoded': return 'response.decoded';
      case 'control.decoded': return 'control.decoded';
      case 'tool-intent.decoded': return 'tool-intent.decoded';
      case 'memory-candidate': return 'memory-candidate.decoded';
      case 'transport.eof': return 'response.decoded';
      case 'protocol.repair': return 'response.decoded';
      case 'protocol.noncompliant': return 'response.decoded';
      case 'watchdog.stopped': return 'request.settled';
      case 'hook.started':
      case 'hook.completed':
      case 'hook.failed': return 'request.settled';
      case 'request.settled': return 'request.settled';
      case 'stream.gap': return 'response.received';
    }
    return 'request.settled';
  }

  private error(code: string, message: string): AgentIoRequestError {
    return new AgentIoRequestError(code, message, this.control?.binding.provider.owner ?? 'agent-io');
  }

  private attemptStatus(): AgentIoAttemptStatus {
    if (this.closed) {
      if (this.closure?.status === 'failed' || this.closure?.status === 'protocol-noncompliant') return 'failed';
      if (this.closure?.status === 'incomplete' || this.closure?.status === 'completed' || this.closure?.status === 'cancelled') return 'ended';
      return 'unknown';
    }
    switch (this.status) {
      case 'running': return 'running';
      case 'repairing': return 'repairing';
      case 'settled': return 'ended';
      case 'failed':
      case 'unknown': return 'unknown';
      default: return 'accepted';
    }
  }
}
