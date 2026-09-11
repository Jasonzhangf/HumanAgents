import {
  ContractError,
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
  type OperationId,
  type StopRequestReceipt,
} from '../../../contracts/src/index.js';

export type FakeOutcome = 'succeeded' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'stopped';
export type FakeResult = {
  readonly outcome: FakeOutcome;
  readonly summary: string;
  readonly evidence: FakeExecutionEvidence;
};

export type FakeExecutionEvidence = {
  readonly operationId: OperationId;
  readonly sessionRef: string;
  readonly sequence: number;
  readonly outcome: FakeOutcome;
  readonly inputDigest: string;
  readonly evidenceRefs: readonly EvidenceRef[];
};

type Session = { readonly runtimeId: string; readonly taskId: AgentStartRequest['taskId']; readonly epoch: number; readonly sessionRef: string; readonly operationId: OperationId };

function digest(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export class FakeAgentDriver implements AgentDriver {
  readonly kind = 'humanagent.fake';
  private readonly outcomes: Readonly<Record<string, FakeOutcome>>;
  private readonly sessions = new Map<string, Session>();
  private readonly evidence: FakeExecutionEvidence[] = [];

  constructor(outcomes: Readonly<Record<string, FakeOutcome>> = {}) { this.outcomes = { ...outcomes }; }

  async capabilities(): Promise<AgentCapabilities> {
    return { driverKind: this.kind, version: '1', capabilities: ['deterministic', 'replay', 'cancel', 'settle'] };
  }

  async start(input: AgentStartRequest): Promise<AgentHandle> {
    if (this.sessions.has(input.runtimeId)) throw new ContractError(`runtime already started: ${input.runtimeId}`);
    const session = this.makeSession(input.runtimeId, input.taskId, input.executionEpoch);
    this.sessions.set(input.runtimeId, session);
    if (input.assignmentId) this.sessions.set(input.assignmentId, session);
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async resume(input: AgentResumeRequest): Promise<AgentHandle> {
    const session = this.sessions.get(input.runtimeId);
    if (!session || session.epoch !== input.executionEpoch) throw new ContractError('cannot resume unknown or stale fake session');
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async submit(input: AgentInput): Promise<AgentOutput> {
    const session = this.sessions.get(input.assignmentId);
    if (!session || session.epoch !== input.executionEpoch || session.taskId.value !== input.taskId.value) throw new ContractError('fake submission is not bound to session epoch');
    const result = this.execute(input);
    return {
      taskId: input.taskId, executionEpoch: input.executionEpoch, assignmentId: input.assignmentId,
      payload: { outcome: result.outcome, summary: result.summary }, outputRefs: [`fake://output/${result.evidence.sessionRef}`], evidenceRefs: result.evidence.evidenceRefs,
    };
  }

  async *observe(input: { readonly runtimeId: string }): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(input.runtimeId);
    if (!session) throw new ContractError('cannot observe unknown fake session');
    yield { taskId: session.taskId, executionEpoch: session.epoch, kind: 'fake.operation', evidenceRefs: this.evidence.filter((item) => item.sessionRef === session.sessionRef).flatMap((item) => item.evidenceRefs) };
  }

  async requestStop(input: { readonly runtimeId: string; readonly executionEpoch: number; readonly operationId: OperationId }): Promise<StopRequestReceipt> {
    const session = this.sessions.get(input.runtimeId);
    if (!session || session.epoch !== input.executionEpoch || session.operationId.value !== input.operationId.value) throw new ContractError('fake stop is not bound to session');
    return { requested: true, operationId: input.operationId };
  }

  async settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure> {
    const session = this.sessions.get(input.runtimeId);
    if (!session || session.epoch !== input.executionEpoch) throw new ContractError('cannot settle stale fake session');
    const evidence = this.evidence.filter((item) => item.sessionRef === session.sessionRef).at(-1);
    if (!evidence) throw new ContractError('fake session has no operation evidence');
    return { state: evidence.outcome, evidenceRefs: evidence.evidenceRefs };
  }

  execute(input: AgentInput): FakeResult {
    const session = this.sessions.get(input.assignmentId);
    if (!session || session.epoch !== input.executionEpoch) throw new ContractError('fake execution is not bound to session epoch');
    const outcome = this.outcomes[input.assignmentId] ?? 'succeeded';
    const evidenceRef: EvidenceRef = { evidenceId: { scope: 'evidence', value: `fake-${session.sessionRef}-${this.evidence.length + 1}` }, kind: 'execution', source: 'humanagent.fake', locator: `session/${session.sessionRef}/operation/${session.operationId.value}`, digest: digest(`${input.assignmentId}:${JSON.stringify(input.payload)}:${outcome}`), scope: { organId: { scope: 'organ', value: 'fake-organ' }, taskId: input.taskId, operationId: session.operationId } };
    const evidence: FakeExecutionEvidence = { operationId: session.operationId, sessionRef: session.sessionRef, sequence: this.evidence.length + 1, outcome, inputDigest: evidenceRef.digest!, evidenceRefs: [evidenceRef] };
    this.evidence.push(evidence);
    return { outcome, summary: `fake ${outcome}`, evidence };
  }

  replay(): readonly FakeExecutionEvidence[] { return this.evidence.map((item) => ({ ...item, evidenceRefs: [...item.evidenceRefs] })); }

  private makeSession(runtimeId: string, taskId: AgentStartRequest['taskId'], epoch: number): Session {
    const suffix = digest(`${runtimeId}:${taskId.value}:${epoch}`);
    return { runtimeId, taskId, epoch, sessionRef: `fake-session-${suffix}`, operationId: { scope: 'operation', value: `fake-operation-${suffix}` } };
  }
}
