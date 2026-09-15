import {
  id,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
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
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { UiRuntimeApiError } from './errors.js';

const FAKE_OWNER = 'humanagent.fake-provider';

interface FakeReplayStep {
  readonly kind: ProviderEvent['kind'];
  readonly state: string;
  readonly summary: string;
  readonly terminalState?: ProviderEvent['terminalState'];
  readonly outputRefs?: readonly string[];
}

const DEFAULT_REPLAY: readonly FakeReplayStep[] = [
  { kind: 'model', state: 'model', summary: 'fake replay: model accepted the request' },
  { kind: 'output', state: 'output', summary: 'fake replay: draft output chunk 1', outputRefs: ['fake://output/1'] },
  { kind: 'tool', state: 'tool', summary: 'fake replay: tool call observed', outputRefs: ['fake://tool/1'] },
  { kind: 'output', state: 'output', summary: 'fake replay: final output chunk 2', outputRefs: ['fake://output/2'] },
  { kind: 'terminal', state: 'succeeded', summary: 'fake replay: execution succeeded', terminalState: 'succeeded' },
];

interface FakeSession {
  readonly executionKey: string;
  readonly scope: ScopeRef;
  output: string;
  stopRequested: boolean;
  terminalState?: ProviderEvent['terminalState'];
}

export interface FakeReplayExecutionRuntimePortOptions {
  readonly binding: ProviderBinding;
  readonly replay?: readonly FakeReplayStep[];
  readonly stepDelayMs?: number;
  readonly now?: () => Date;
}

function executionKey(input: { readonly runtimeId: string; readonly taskId: { readonly value: string }; readonly operationId: { readonly value: string }; readonly executionEpoch: number }): string {
  return `${input.runtimeId}:${input.taskId.value}:${input.operationId.value}:${input.executionEpoch}`;
}

function scopeFor(input: ProviderStartInput): ScopeRef {
  const base = input.evidenceRefs[0]?.scope ?? { organId: id('organ', 'fake-organ') };
  return { ...base, taskId: input.taskId, operationId: input.operationId };
}

function fakeEvidence(scope: ScopeRef, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `fake-${label.replace(/[^A-Za-z0-9._-]/g, '-')}`),
    kind: 'execution',
    source: FAKE_OWNER,
    locator: `fake/${label}`,
    scope,
  };
}

// Fixed-replay ExecutionRuntimePort. It deliberately never touches RCC and marks
// every evidence reference with the fake source so results cannot be mistaken
// for a real provider execution.
export class FakeReplayExecutionRuntimePort implements ExecutionRuntimePort {
  readonly kind = 'humanagent.execution-runtime-port' as const;

  private readonly replay: readonly FakeReplayStep[];
  private readonly stepDelayMs: number;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, FakeSession>();

  constructor(private readonly options: FakeReplayExecutionRuntimePortOptions) {
    this.replay = options.replay ?? DEFAULT_REPLAY;
    this.stepDelayMs = options.stepDelayMs ?? 20;
    this.now = options.now ?? (() => new Date());
  }

  async probe(binding: ProviderBinding): Promise<ProviderReadiness> {
    const scope: ScopeRef = { organId: id('organ', 'fake-organ') };
    return {
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'ready',
      capabilityDigest: binding.capabilityDigest,
      version: 'fake-1',
      checkedAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + 5 * 60 * 1000).toISOString(),
      evidenceRefs: [fakeEvidence(scope, 'readiness')],
    };
  }

  async capabilities(binding: ProviderBinding): Promise<ProviderCapabilities> {
    const scope: ScopeRef = { organId: id('organ', 'fake-organ') };
    return {
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      capabilities: ['fake-replay', 'cancel', 'settle'],
      version: 'fake-1',
      digest: binding.capabilityDigest,
      checkedAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + 5 * 60 * 1000).toISOString(),
      evidenceRefs: [fakeEvidence(scope, 'capabilities')],
    };
  }

  async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    const key = executionKey(input);
    if (this.sessions.has(key)) throw new UiRuntimeApiError('fake.already.started', FAKE_OWNER, 'fake execution is already active', 'start a new operation');
    const scope = scopeFor(input);
    this.sessions.set(key, { executionKey: key, scope, output: '', stopRequested: false });
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      startedAt: this.now().toISOString(),
      evidenceRefs: [fakeEvidence(scope, 'start')],
    };
  }

  async resume(_input: ProviderResumeInput): Promise<ProviderRecoveryResult> {
    throw new UiRuntimeApiError('fake.resume.unsupported', FAKE_OWNER, 'fake replay cannot resume a provider stream', 'start a new execution');
  }

  async submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> {
    const session = this.requireSession(input);
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      status: 'accepted',
      outputRefs: [],
      evidenceRefs: [fakeEvidence(session.scope, 'submit')],
    };
  }

  async *observe(input: ProviderObserveInput): AsyncIterable<ProviderEvent> {
    const session = this.requireSession(input);
    let index = 0;
    for (const step of this.replay) {
      if (session.stopRequested) {
        yield this.event(input, session, index, {
          kind: 'terminal',
          state: 'stopped',
          summary: 'fake replay: execution stopped',
          terminalState: 'stopped',
        });
        return;
      }
      if (this.stepDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.stepDelayMs));
      if (step.kind === 'output') session.output = session.output ? `${session.output} ${step.summary}` : step.summary;
      const event = this.event(input, session, index, step);
      if (event.kind === 'terminal') session.terminalState = event.terminalState;
      yield event;
      index += 1;
      if (step.kind === 'terminal') return;
    }
  }

  async requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt> {
    const session = this.requireSession(input);
    session.stopRequested = true;
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      status: 'accepted',
      receivedAt: this.now().toISOString(),
      evidenceRefs: [fakeEvidence(session.scope, 'stop')],
      ownerId: FAKE_OWNER,
      nextAction: { kind: 'wait', ref: 'fake.settle' },
    };
  }

  async settle(input: ProviderSettleInput): Promise<ProviderSettlement> {
    const session = this.requireSession(input);
    const scope = session.scope;
    const state = session.stopRequested ? 'stopped' : session.terminalState;
    if (!state) {
      this.sessions.delete(session.executionKey);
      throw new UiRuntimeApiError(
        'fake.replay.terminal-missing',
        FAKE_OWNER,
        'fake replay ended without a terminal event',
        'add a terminal replay step before starting the execution',
      );
    }
    this.sessions.delete(session.executionKey);
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      state,
      evidenceRefs: [fakeEvidence(scope, `settle-${state}`)],
      resourceRelease: { state: 'released', evidenceRefs: [fakeEvidence(scope, 'release')] },
      persistence: { state: 'committed', evidenceRefs: [fakeEvidence(scope, 'persistence')] },
    };
  }

  async close(binding: ProviderBinding): Promise<ProviderCloseResult> {
    this.sessions.clear();
    return {
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'closed',
      evidenceRefs: [fakeEvidence({ organId: id('organ', 'fake-organ') }, 'close')],
    };
  }

  outputFor(input: ProviderObserveInput): string {
    return this.sessions.get(executionKey(input))?.output ?? '';
  }

  private event(input: ProviderObserveInput, session: FakeSession, index: number, step: FakeReplayStep): ProviderEvent {
    const evidenceRefs = [fakeEvidence(session.scope, `${step.kind}-${index}`)];
    const summary = step.kind === 'output' ? step.summary : undefined;
    const base = {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      eventId: `fake-${input.operationId.value}-${index}`,
      kind: step.kind,
      evidenceRefs,
      ...(summary === undefined ? {} : { summary }),
    } as const;
    if (step.kind === 'output') return { ...base, kind: 'output', outputRefs: step.outputRefs };
    if (step.kind === 'terminal') {
      return { ...base, terminalState: step.terminalState ?? 'succeeded' };
    }
    if (step.outputRefs) return { ...base, outputRefs: step.outputRefs };
    return base;
  }

  private requireSession(input: { readonly runtimeId: string; readonly taskId: { readonly value: string }; readonly operationId: { readonly value: string }; readonly executionEpoch: number }): FakeSession {
    const session = this.sessions.get(executionKey(input));
    if (!session) throw new UiRuntimeApiError('fake.missing.session', FAKE_OWNER, 'fake execution has no active session', 'start a fake execution first');
    return session;
  }
}
