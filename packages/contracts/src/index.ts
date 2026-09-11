export type ScopeKind = 'organ' | 'task' | 'cycle' | 'operation' | 'checkpoint' | 'evidence';

export interface ScopedId<K extends ScopeKind = ScopeKind> {
  readonly scope: K;
  readonly value: string;
}

export type OrganId = ScopedId<'organ'>;
export type TaskId = ScopedId<'task'>;
export type CycleId = ScopedId<'cycle'>;
export type OperationId = ScopedId<'operation'>;
export type CheckpointId = ScopedId<'checkpoint'>;
export type EvidenceId = ScopedId<'evidence'>;

export interface ScopeRef {
  readonly organId: OrganId;
  readonly taskId?: TaskId;
  readonly cycleId?: CycleId;
  readonly operationId?: OperationId;
}

export interface EvidenceRef {
  readonly evidenceId: EvidenceId;
  readonly kind: 'execution' | 'tool' | 'operation' | 'external';
  readonly source: string;
  readonly locator: string;
  readonly digest?: string;
  readonly scope: ScopeRef;
}

export type LifecycleState =
  | 'created' | 'admitted' | 'running' | 'settling' | 'succeeded' | 'waiting'
  | 'blocked' | 'failed' | 'cancelled' | 'stopped' | 'unknown' | 'stale';
export type HealthState = 'healthy' | 'degraded' | 'attention' | 'unhealthy' | 'unknown';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type BusinessPayload = { readonly [key: string]: JsonValue };

export interface Organ {
  readonly id: OrganId;
  readonly name: string;
  readonly state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
  readonly capabilities: readonly string[];
}

export interface Task {
  readonly id: TaskId;
  readonly organId: OrganId;
  readonly title: string;
  readonly directive: string;
  readonly directiveRevision: number;
  readonly state: LifecycleState;
  readonly memoryScope: 'task' | 'organ' | 'approved-global';
}

export interface Cycle {
  readonly id: CycleId;
  readonly scope: ScopeRef;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly state: LifecycleState;
}

export interface Operation {
  readonly id: OperationId;
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly kind: string;
  readonly state: LifecycleState;
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface NextAction {
  readonly kind: 'continue' | 'wait' | 'stop' | 'recover';
  readonly ref?: string;
}

export interface Checkpoint {
  readonly id: CheckpointId;
  readonly scope: ScopeRef;
  readonly cycleId: CycleId;
  readonly seq: number;
  readonly previousCheckpointId: CheckpointId | null;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly outcome: Exclude<LifecycleState, 'created' | 'admitted' | 'running' | 'settling' | 'stale'>;
  readonly summary: string;
  readonly recoveryStateRef: EvidenceRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly next: NextAction;
}

export type RequirementIntent = 'append' | 'change' | 'create';
export interface RequirementEnvelope {
  readonly requirementId: string;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly intent: RequirementIntent;
  readonly taskRef?: TaskId;
  readonly normalizedInput: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly fifoSeq: number;
  readonly payloadRef: string;
}

export type PipelineNodeState = LifecycleState;
export interface PipelineNode {
  readonly nodeId: string;
  readonly scope: ScopeRef;
  readonly kind: 'interaction' | 'orchestration' | 'execution' | 'review' | 'memory';
  readonly state: PipelineNodeState;
  readonly parentNodeId: string | null;
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AgentCapabilities {
  readonly driverKind: string;
  readonly capabilities: readonly string[];
  readonly version: string;
}
export interface AgentDefinition {
  readonly agentId: string;
  readonly roleId: string;
  readonly templateRef: string;
  readonly capabilityRefs: readonly string[];
  readonly inputSchemaRef: string;
  readonly outputSchemaRef: string;
}
export interface AgentStartRequest {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly assignmentId?: string;
}
export interface AgentResumeRequest extends AgentStartRequest {
  readonly checkpointId: CheckpointId;
}
export interface AgentInput {
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly payload: BusinessPayload;
}
export interface AgentOutput {
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly payload: BusinessPayload;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}
export interface AgentHandle { readonly runtimeId: string; readonly executionEpoch: number; }
export interface AgentEvent { readonly taskId: TaskId; readonly executionEpoch: number; readonly kind: string; readonly evidenceRefs: readonly EvidenceRef[]; }
export interface StopRequestReceipt { readonly requested: boolean; readonly operationId: OperationId; }
export interface AgentClosure { readonly state: 'succeeded' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'stopped' | 'unknown'; readonly evidenceRefs: readonly EvidenceRef[]; }
export interface AgentDriver {
  readonly kind: string;
  capabilities(): Promise<AgentCapabilities>;
  start(input: AgentStartRequest): Promise<AgentHandle>;
  resume(input: AgentResumeRequest): Promise<AgentHandle>;
  submit(input: AgentInput): Promise<AgentOutput>;
  observe(input: { readonly runtimeId: string }): AsyncIterable<AgentEvent>;
  requestStop(input: { readonly runtimeId: string; readonly executionEpoch: number; readonly operationId: OperationId }): Promise<StopRequestReceipt>;
  settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure>;
}

export interface HarnessPluginManifest {
  readonly kind: 'humanagent.plugin';
  readonly pluginId: string;
  readonly version: string;
  readonly apiVersion: number;
  readonly entry: string;
  readonly dependencies: readonly string[];
  readonly provides: readonly string[];
  readonly consumes: readonly string[];
  readonly permissions: readonly string[];
  readonly digest: string;
}
export interface HarnessPlugin { readonly manifest: HarnessPluginManifest; register(context: HarnessPluginContext): void; start?(): Promise<void>; dispose?(): Promise<void>; }
export interface HarnessPluginContext {
  registerCapability(name: string): void;
  registerAgentDriver(driver: AgentDriver): void;
  registerMemoryOperations(port: MemoryOperationsPort): void;
  registerAgentMemoryContextInjection(port: AgentMemoryContextInjectionPort): void;
}

export interface MemoryScope { readonly kind: 'task' | 'organ' | 'approved-global'; readonly taskId?: TaskId; readonly organId: OrganId; }
export type ContextLayer = 'current' | 'task-recent' | 'related' | 'approved-long-term' | 'raw';
export interface AgentMemoryContextRequest { readonly agentRuntimeId: string; readonly roleId: string; readonly taskId: TaskId; readonly scope: MemoryScope; readonly layers: readonly ContextLayer[]; readonly query?: string; readonly tokenBudget: number; readonly executionEpoch: number; readonly evidenceRequired: boolean; }
export interface AgentMemoryContextEntry { readonly layer: ContextLayer; readonly summary: string; readonly sourceRef: string; readonly sourceDigest: string; readonly scope: string; readonly tokenCost: number; }
export interface AgentMemoryContext { readonly contextId: string; readonly executionEpoch: number; readonly entries: readonly AgentMemoryContextEntry[]; readonly omitted: readonly { reason: string; sourceRef?: string }[]; readonly indexVersion?: string; }
export interface AgentMemoryContextInjectionPort { recall(input: AgentMemoryContextRequest): Promise<AgentMemoryContext>; attach(input: { readonly agentRuntimeId: string; readonly context: AgentMemoryContext }): Promise<{ contextId: string; attached: boolean }>; }
export interface NoveltyRequest {
  readonly scope: MemoryScope;
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly candidateRef: string;
  readonly comparisonRefs: readonly string[];
  readonly limit: number;
}
export interface NoveltyResult {
  readonly classification: 'novel' | 'variant' | 'known' | 'unknown';
  readonly matchedRefs: readonly string[];
  readonly reason: string;
}
export interface RecurrenceRequest {
  readonly scope: MemoryScope;
  readonly patternRef: string;
  readonly windowRefs: readonly string[];
  readonly limit: number;
}
export interface RecurrenceResult {
  readonly classification: 'recurring' | 'observed' | 'one-off' | 'unknown';
  readonly occurrences: readonly { readonly ref: string; readonly digest: string }[];
  readonly reason: string;
}
export interface MemoryOperationsPort {
  ingest(input: { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }): Promise<{ readonly sourceRef: string }>;
  search(input: { readonly scope: MemoryScope; readonly query: string; readonly limit: number }): Promise<readonly { readonly sourceRef: string; readonly summary: string }[]>;
  inspect(input: { readonly sourceRef: string }): Promise<{ readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }>;
  compare(input: { readonly leftRef: string; readonly rightRef: string }): Promise<{ readonly relation: 'same' | 'different' | 'unknown' }>;
  detectNovelty(input: NoveltyRequest): Promise<NoveltyResult>;
  detectRecurrence(input: RecurrenceRequest): Promise<RecurrenceResult>;
}

export interface OrganHealthSnapshot { readonly organId: OrganId; readonly checkedAt: string; readonly expiresAt: string; readonly overall: HealthState; readonly functions: readonly { readonly functionId: string; readonly status: 'healthy' | 'degraded' | 'failed' | 'unknown'; readonly measurements: readonly { readonly name: string; readonly value: string | number; readonly unit?: string }[]; readonly evidenceRefs: readonly EvidenceRef[] }[]; }
export interface Attention { readonly attentionId: string; readonly scope: ScopeRef; readonly severity: 'info' | 'attention' | 'blocker'; readonly state: 'open' | 'recovering' | 'resolved'; readonly message: string; readonly evidenceRefs: readonly EvidenceRef[]; }
export interface TaskInputRequest { readonly requestId: string; readonly taskId: TaskId; readonly schemaRef: string; readonly reason: string; readonly impact: string; readonly expiresAt?: string; }
export interface TaskInput { readonly taskId: TaskId; readonly inputRevision: number; readonly payload: BusinessPayload; readonly source: 'human' | 'notification' | 'agent'; }
export interface TaskOutput { readonly taskId: TaskId; readonly state: 'partial' | 'succeeded' | 'failed' | 'waiting'; readonly summary: string; readonly result: BusinessPayload; readonly artifactRefs: readonly string[]; readonly evidenceRefs: readonly EvidenceRef[]; }
export interface TaskInteraction { readonly taskId: TaskId; readonly input?: TaskInput; readonly inputRequest?: TaskInputRequest; readonly output?: TaskOutput; }

export interface WorkAssignment {
  readonly assignmentId: string; readonly taskId: TaskId; readonly pipelineNodeId: string; readonly attempt: number; readonly executionEpoch: number; readonly inputRevision: number;
  readonly objective: string; readonly targetRefs: readonly string[]; readonly expectedOutputRefs: readonly string[]; readonly expectedArtifactDigests?: readonly string[]; readonly acceptanceCriteriaDigest: string;
  readonly successCriteria: readonly string[]; readonly failureCriteria: readonly string[]; readonly incompleteCriteria: readonly string[]; readonly requiredCapabilities: readonly string[]; readonly mergeGate: 'required' | 'not-required';
}
export interface WorkResult {
  readonly taskId: TaskId; readonly pipelineNodeId: string; readonly agentId: string; readonly assignmentId: string; readonly attempt: number; readonly executionEpoch: number; readonly inputRevision: number;
  readonly producedArtifactRefs: readonly string[]; readonly producedArtifactDigests: readonly string[]; readonly status: 'succeeded' | 'failed' | 'incomplete' | 'blocked' | 'cancelled'; readonly summary: string;
  readonly outputRefs: readonly string[]; readonly evidenceRefs: readonly EvidenceRef[]; readonly nextAction: 'continue' | 'wait' | 'attention' | 'review' | 'settle' | 'remediate'; readonly conditionRef?: string; readonly failureRef?: string;
}

export class ContractError extends Error { constructor(message: string) { super(message); this.name = 'ContractError'; } }
const ID_SCOPES: readonly ScopeKind[] = ['organ', 'task', 'cycle', 'operation', 'checkpoint', 'evidence'];
const CONTROL_KEYS = new Set(['retry', 'degrade', 'steer', 'continuation', 'health', 'debug', 'checkpoint', 'executionEpoch', 'operationId']);

export function id<K extends ScopeKind>(scope: K, value: string): ScopedId<K> {
  if (!ID_SCOPES.includes(scope) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new ContractError(`invalid ${scope} id`);
  return { scope, value };
}
export function assertScope(actual: ScopedId, expected: ScopeKind): void { if (actual.scope !== expected) throw new ContractError(`expected ${expected} scope, got ${actual.scope}`); }
function sameScopedId<T extends ScopeKind>(a?: ScopedId<T>, b?: ScopedId<T>): boolean { return a?.scope === b?.scope && a?.value === b?.value; }
export function assertSameScope(...refs: ScopeRef[]): void {
  if (refs.length < 2) return;
  const first = refs[0];
  for (const ref of refs.slice(1)) if (!sameScopedId(first.organId, ref.organId) || !sameScopedId(first.taskId, ref.taskId) || !sameScopedId(first.cycleId, ref.cycleId) || !sameScopedId(first.operationId, ref.operationId)) throw new ContractError('scope mismatch');
}
function assertPositiveSafeInteger(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 1) throw new ContractError(`${label} must be a positive safe integer`); }
function assertNonEmptyReference(value: string, label: string): void { if (!value || !value.trim()) throw new ContractError(`${label} must be a non-empty reference`); }
function assertValidTime(value: string, label: string): void { if (!value || !Number.isFinite(Date.parse(value))) throw new ContractError(`${label} must be a valid timestamp`); }
export function assertExecutionEpoch(epoch: number): void { assertPositiveSafeInteger(epoch, 'execution epoch'); }
export function assertNotExpired(expiresAt: string, now = new Date()): void { const time = Date.parse(expiresAt); if (!Number.isFinite(time) || time <= now.getTime()) throw new ContractError('expired timestamp'); }
export function assertCheckpointLink(current: Checkpoint, previous: Checkpoint | null): void {
  assertExecutionEpoch(current.executionEpoch);
  assertPositiveSafeInteger(current.seq, 'checkpoint seq');
  if (current.previousCheckpointId === null) { if (current.seq !== 1 || previous !== null) throw new ContractError('invalid root checkpoint'); return; }
  if (!previous) throw new ContractError('broken checkpoint predecessor');
  assertPositiveSafeInteger(previous.seq, 'previous checkpoint seq');
  if (previous.id.value !== current.previousCheckpointId.value || previous.seq !== current.seq - 1) throw new ContractError('broken checkpoint predecessor');
  assertSameScope(current.scope, previous.scope);
}
export function assertCapabilities(required: readonly string[], available: readonly string[]): void { for (const capability of required) if (!available.includes(capability)) throw new ContractError(`undeclared capability: ${capability}`); }
export function assertContextBudget(context: AgentMemoryContext, budget: number): void {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new ContractError('context budget must be a non-negative safe integer');
  let total = 0;
  for (const entry of context.entries) {
    if (!Number.isSafeInteger(entry.tokenCost) || entry.tokenCost < 0) throw new ContractError('context entry token cost must be a non-negative safe integer');
    total += entry.tokenCost;
  }
  if (total > budget) throw new ContractError('context exceeds token budget');
}
export function assertBusinessPayload(payload: BusinessPayload): void {
  for (const key of Object.keys(payload)) if (CONTROL_KEYS.has(key)) throw new ContractError(`control field leaked into business payload: ${key}`);
}
export function validateRequirementEnvelope(input: RequirementEnvelope): void {
  if (!input.requirementId || !input.draftId || !input.normalizedInput || !input.confirmedBy) throw new ContractError('invalid requirement envelope');
  assertPositiveSafeInteger(input.inputRevision, 'requirement inputRevision');
  assertPositiveSafeInteger(input.fifoSeq, 'requirement fifoSeq');
  assertValidTime(input.confirmedAt, 'requirement confirmedAt');
  if (input.intent === 'append' || input.intent === 'change') { if (!input.taskRef) throw new ContractError('task reference required'); assertScope(input.taskRef, 'task'); }
  assertNonEmptyReference(input.payloadRef, 'requirement payloadRef');
}
export function validateWorkAssignment(input: WorkAssignment): void {
  assertScope(input.taskId, 'task'); assertExecutionEpoch(input.executionEpoch);
  assertPositiveSafeInteger(input.attempt, 'work attempt');
  assertPositiveSafeInteger(input.inputRevision, 'work inputRevision');
  if (!input.objective || !input.acceptanceCriteriaDigest || input.successCriteria.length === 0) throw new ContractError('invalid work assignment');
}
export function validateWorkResult(input: WorkResult, assignment: WorkAssignment): void {
  validateWorkAssignment(assignment); assertScope(input.taskId, 'task'); assertExecutionEpoch(input.executionEpoch);
  assertPositiveSafeInteger(input.attempt, 'work result attempt');
  assertPositiveSafeInteger(input.inputRevision, 'work result inputRevision');
  if (input.taskId.value !== assignment.taskId.value || input.assignmentId !== assignment.assignmentId || input.pipelineNodeId !== assignment.pipelineNodeId || input.attempt !== assignment.attempt || input.executionEpoch !== assignment.executionEpoch || input.inputRevision !== assignment.inputRevision) throw new ContractError('work result does not match assignment');
  if (!input.summary || (input.nextAction === 'wait' && !input.conditionRef) || (input.status === 'failed' && !input.failureRef)) throw new ContractError('invalid work result');
  for (const ref of input.producedArtifactRefs) if (!ref) throw new ContractError('work result artifact ref must be present');
  if (input.producedArtifactRefs.length !== input.producedArtifactDigests.length) throw new ContractError('work result artifact digests must match artifact refs');
  for (const digest of input.producedArtifactDigests) if (!digest) throw new ContractError('work result artifact digest must be present');
  if (assignment.expectedArtifactDigests) {
    const expectedDigests = new Set(assignment.expectedArtifactDigests);
    for (const digest of assignment.expectedArtifactDigests) if (!digest) throw new ContractError('work assignment expected artifact digest must be present');
    if (input.status === 'succeeded') {
      if (assignment.expectedArtifactDigests.length !== input.producedArtifactDigests.length) throw new ContractError('work result expected artifact digests must match produced artifact digests');
      for (let i = 0; i < assignment.expectedArtifactDigests.length; i++) {
        if (assignment.expectedArtifactDigests[i] !== input.producedArtifactDigests[i]) throw new ContractError('work result artifact digest does not match expected digest');
      }
    } else if (input.producedArtifactRefs.length > 0) {
      for (const digest of input.producedArtifactDigests) if (!expectedDigests.has(digest)) throw new ContractError('work result artifact digest does not match expected digest');
    }
  }
  if (input.status === 'succeeded') {
    const expected = new Set(assignment.expectedOutputRefs);
    const delivered = new Set(input.outputRefs);
    if (expected.size !== delivered.size || ![...expected].every((ref) => delivered.has(ref))) throw new ContractError('work result outputs must match expected outputs');
  }
}
