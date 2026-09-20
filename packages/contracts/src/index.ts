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
  /** HumanAgent-owned organ identity; adapters must not mint their own. */
  readonly organId?: OrganId;
  /** HumanAgent-owned cycle identity; adapters must not mint their own. */
  readonly cycleId?: CycleId;
  /** HumanAgent-owned operation identity; adapters must not mint their own. */
  readonly operationId?: OperationId;
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
export interface AgentEvent {
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly kind: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly summary?: string;
  readonly terminalState?: ProviderTerminalState;
}
/**
 * Provider-neutral semantic lifecycle event. The standalone `run` entry and
 * `serve --mode fake` expose this projection for equivalent entry evidence.
 */
export type AgentSemanticEventKind =
  | 'execution.started'
  | 'provider.model'
  | 'provider.output'
  | 'provider.tool'
  | 'provider.error'
  | 'execution.settling'
  | 'checkpoint.committed'
  | 'execution.terminal';
export interface AgentSemanticEvent {
  readonly seq: number;
  readonly kind: AgentSemanticEventKind;
  readonly state: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly ownerId?: string;
  readonly terminalPhase?: 'provider' | 'final';
  readonly terminalState?: ProviderTerminalState;
}
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
  registerPermission(name: string): void;
  registerAgentDriver(driver: AgentDriver): void;
  registerExecutionRuntimePort(port: ExecutionRuntimePort): void;
  registerMemoryOperations(port: MemoryOperationsPort): void;
  registerAgentMemoryContextInjection(port: AgentMemoryContextInjectionPort): void;
}

export type MemoryNamespace = 'project' | 'global';
export const MEMORY_SCOPE_COMPATIBILITY_VERSION = 1 as const;
export type CanonicalMemoryScope =
  | {
      readonly namespace: 'project';
      readonly projectKey: string;
      readonly organId: OrganId;
      readonly taskId?: TaskId;
    }
  | {
      readonly namespace: 'global';
      readonly globalId: 'global';
      readonly sourceProjectKey?: string;
      readonly sourceOrganId?: OrganId;
    };
export interface MemoryScope { readonly kind: 'task' | 'organ' | 'approved-global'; readonly taskId?: TaskId; readonly organId: OrganId; }
export interface CanonicalMemoryScopeCompatibility {
  readonly compatibilityVersion: typeof MEMORY_SCOPE_COMPATIBILITY_VERSION;
  readonly scope: CanonicalMemoryScope;
}
export interface LegacyMemoryScopeCompatibility {
  readonly compatibilityVersion: typeof MEMORY_SCOPE_COMPATIBILITY_VERSION;
  readonly scope: MemoryScope;
  readonly projectKey: string;
}
export type ContextLayer = 'current' | 'task-recent' | 'related' | 'approved-long-term' | 'raw';
export interface AgentMemoryContextRequest { readonly agentRuntimeId: string; readonly roleId: string; readonly taskId: TaskId; readonly scope: CanonicalMemoryScope; readonly layers: readonly ContextLayer[]; readonly query?: string; readonly tokenBudget: number; readonly executionEpoch: number; readonly evidenceRequired: boolean; }
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
  query(input: MemoryQueryRequest): Promise<MemoryQueryResponse>;
  submitCandidate(input: MemorySubmission): Promise<MemorySubmissionReceipt>;
  reviewCandidate(input: MemoryReviewReceipt): Promise<MemoryReviewReceipt>;
  promoteCandidate(input: MemoryPromotionReceipt): Promise<MemoryPromotionReceipt>;
  planForgetting(input: MemoryForgettingRequest): Promise<MemoryForgettingPlan>;
}

export type MemoryRecordState = 'candidate' | 'approved' | 'active' | 'superseded' | 'expired' | 'archived' | 'rejected';
export type MemoryKind = 'episodic' | 'semantic' | 'procedural';

export interface EpisodicMemorySource {
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly projectKey: string;
  readonly taskId?: TaskId;
  readonly cycleId?: CycleId;
  readonly sessionRef?: string;
  readonly occurredAt: string;
  readonly kind: 'input' | 'checkpoint' | 'operation' | 'tool' | 'output' | 'error' | 'review';
  readonly payloadRef: string;
}

export interface SemanticMemoryCandidate {
  readonly candidateId: string;
  readonly namespace: MemoryNamespace;
  readonly projectKey: string;
  readonly statement: string;
  readonly entities: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly confidence: 'observed' | 'supported' | 'confirmed';
  readonly validity: { readonly kind: 'open' | 'until'; readonly until?: string };
  readonly supersedes?: readonly string[];
  readonly review: 'required' | 'approved' | 'rejected';
}

export interface ProceduralMemoryCandidate {
  readonly candidateId: string;
  readonly namespace: MemoryNamespace;
  readonly projectKey: string;
  readonly name: string;
  readonly intent: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly failureBoundaries: readonly string[];
  readonly successEvidenceRefs: readonly string[];
  readonly repeatability: 'one-off' | 'observed' | 'recurring';
  readonly review: 'required' | 'approved' | 'rejected';
}

export interface MemoryReviewReceipt {
  readonly candidateId: string;
  readonly decision: 'approve' | 'reject' | 'defer';
  readonly actor: MemoryActorContext;
  readonly decisionReason: string;
  readonly decidedAt: string;
  readonly evidenceRefs: readonly string[];
}

export interface MemoryPromotionReceipt {
  readonly candidateId: string;
  readonly from: 'project';
  readonly to: 'global';
  readonly actor: MemoryActorContext;
  readonly reason: string;
  readonly impactScope: string;
  readonly approvalRef: string;
  readonly approvalDigest: string;
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly promotedAt: string;
}

export interface MemoryForgettingPlan {
  readonly planId: string;
  readonly namespace: MemoryNamespace;
  readonly projectKey?: string;
  readonly actions: readonly {
    readonly memoryId: string;
    readonly action: 'supersede' | 'expire' | 'archive' | 'cleanup-projection';
    readonly reason: string;
    readonly replacementRef?: string;
    readonly sourceRefs: readonly string[];
  }[];
  readonly protectedRefs: readonly string[];
  readonly createdAt: string;
}

export interface MemoryForgettingRequest {
  readonly actor: MemoryActorContext;
  readonly plan: MemoryForgettingPlan;
}

export interface MemorySubmission {
  readonly submissionId: string;
  readonly requestId: string;
  readonly operationId: OperationId;
  readonly bindingRef: string;
  readonly actor: MemoryActorContext;
  readonly projectKey: string;
  readonly taskId?: TaskId;
  readonly cycleId?: CycleId;
  readonly requestedKind: MemoryKind;
  readonly candidateCategory: MemoryCandidateCategory;
  readonly contentRef: string;
  readonly contentDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly observation: string;
  readonly desiredScope: MemoryNamespace;
  readonly reason: string;
  readonly inputDigest: string;
}

export interface MemorySubmissionReceipt {
  readonly submissionId: string;
  readonly status: 'accepted' | 'duplicate' | 'queued' | 'rejected';
  readonly candidateId?: string;
  readonly operationId?: OperationId;
  readonly sourceRef?: string;
  readonly sourceFactRef?: string;
  readonly nextAction: 'none' | 'wait-analysis' | 'review-required' | 'attention';
}

export interface MemoryQueryRequest {
  readonly requestId: string;
  readonly operationId: OperationId;
  readonly bindingRef: string;
  readonly actor: MemoryActorContext;
  readonly projectKey: string;
  readonly namespace: MemoryNamespace;
  readonly taskId?: TaskId;
  readonly query: string;
  readonly kinds: readonly MemoryKind[];
  readonly states: readonly MemoryRecordState[];
  readonly limit: number;
  readonly tokenBudget: number;
  readonly inputDigest: string;
}

export interface MemoryQueryEntry {
  readonly memoryId: string;
  readonly namespace: MemoryNamespace;
  readonly kind: MemoryKind;
  readonly state: MemoryRecordState;
  readonly summary: string;
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly projectKey?: string;
  readonly sourceScopeRef: string;
  readonly relevanceReason: string;
}

export interface MemoryQueryResponse {
  readonly requestId: string;
  readonly status: 'ready' | 'waiting' | 'attention';
  readonly entries: readonly MemoryQueryEntry[];
  readonly indexVersion?: string;
  readonly sourceFactRef: string;
  readonly nextCursor?: string;
  readonly omitted: readonly { readonly reason: string; readonly ref?: string }[];
}

export interface AuditPromptSnapshot {
  readonly promptRef: string;
  readonly canonicalRef: string;
  readonly revision: string;
  readonly digest: string;
  readonly loadedAt: string;
}

export type ProjectAutoUpdateTarget = 'project-agents' | 'project-local-skill';
export type ProjectReadonlySourceTarget =
  | 'project-architecture'
  | 'project-agents'
  | 'project-local-skill';

export type MemoryCandidateCategory =
  | 'project-fact'
  | 'project-experience'
  | 'global'
  | 'user-profile'
  | 'local-skill-update';

export interface MemorySourceSnapshot {
  readonly sourceRef: string;
  readonly canonicalRef: string;
  readonly revision: string;
  readonly digest: string;
  readonly loadedAt: string;
}

export interface MemorySessionEvidence extends MemorySourceSnapshot {
  readonly projectKey: string;
  readonly taskId?: TaskId;
  readonly interactionScopeId?: string;
  readonly sessionRef: string;
  readonly content: string;
}

export interface MemoryProjectSourceSnapshot extends MemorySourceSnapshot {
  readonly projectKey: string;
  readonly target: ProjectReadonlySourceTarget;
  readonly content: string;
}

export interface MemoryAuditPromptSnapshotSource extends MemorySourceSnapshot {
  readonly promptRef: string;
  readonly content: string;
}

export interface MemorySessionEvidenceSourcePort {
  readSession(input: {
    readonly projectKey: string;
    readonly taskId?: TaskId;
    readonly interactionScopeId?: string;
    readonly sessionRef: string;
  }): Promise<MemorySessionEvidence>;
}

export interface MemoryProjectSourcePort {
  readProject(input: {
    readonly projectKey: string;
    readonly target: ProjectReadonlySourceTarget;
    readonly pathRef?: string;
  }): Promise<MemoryProjectSourceSnapshot>;
  list(input: {
    readonly projectKey: string;
  }): Promise<readonly MemoryProjectSourceSnapshot[]>;
}

export interface MemoryProjectReadRequest {
  readonly projectKey: string;
  readonly taskId?: TaskId;
  readonly affectedPathRefs: readonly string[];
}

export interface MemoryProjectSourceProvenance {
  readonly sourceRef: string;
  readonly canonicalRef: string;
  readonly revision: string;
  readonly digest: string;
  readonly loadedAt: string;
  readonly target: ProjectReadonlySourceTarget;
}

export interface MemoryProjectReadResult {
  readonly sources: readonly MemoryProjectSourceProvenance[];
}

export interface MemoryAuditPromptSourcePort {
  readPrompt(input: {
    readonly projectKey: string;
    readonly promptRef: string;
  }): Promise<MemoryAuditPromptSnapshotSource>;
}

export interface ProjectSourceUpdateProposal {
  readonly target: ProjectAutoUpdateTarget;
  readonly sourceRef: string;
  readonly expectedRevision: string;
  readonly expectedDigest: string;
  readonly patchRef: string;
  readonly patchDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly ownerRef: string;
}

export type ProjectSourcePatchKind = 'project-fact' | 'project-experience' | 'local-skill-update';

export type ProjectSourcePatchPayload =
  | { readonly type: 'memory-entry' }
  | { readonly type: 'replacement'; readonly content: string };

export interface ProjectSourcePatchArtifact {
  readonly schemaVersion: 1;
  readonly kind: ProjectSourcePatchKind;
  readonly target: ProjectAutoUpdateTarget;
  readonly payload: ProjectSourcePatchPayload;
  readonly evidenceRefs: readonly string[];
}

export interface MemoryActorContext {
  readonly actorId: string;
  readonly roleId: 'interaction' | 'orchestration' | 'review' | 'memory' | 'system';
  readonly permissions: readonly ('memory.read' | 'memory.propose' | 'memory.review' | 'memory.promote' | 'memory.forget')[];
  readonly projectKey: string;
  readonly crossProjectGrantRef?: string;
}

export interface MemoryCurationResult {
  readonly operationId: OperationId;
  readonly auditPrompt: AuditPromptSnapshot;
  readonly sourceRefs: readonly string[];
  readonly outcome: 'candidate' | 'duplicate' | 'conflict' | 'no-op' | 'attention';
  readonly candidateId?: string;
  readonly matchedMemoryIds: readonly string[];
  readonly conflictRefs: readonly string[];
  readonly explanation: string;
  readonly nextAction: 'review' | 'supersede-review' | 'retry-analysis' | 'none' | 'attention';
}

export interface MemoryFollowUpRequest {
  readonly requestId: string;
  readonly operationId: OperationId;
  readonly correlationId: string;
  readonly inReplyTo: string;
  readonly bindingRef: string;
  readonly actor: MemoryActorContext;
  readonly projectKey: string;
  readonly namespace: MemoryNamespace;
  readonly taskId?: TaskId;
  readonly interactionScopeId?: string;
  readonly evidenceRefs: readonly string[];
  readonly evidenceDigests: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly inputDigest: string;
}

export interface MemoryAgentStatePort {
  readMemoryAgentState(): Promise<unknown | undefined>;
  appendMemoryAgentState(input: {
    readonly commitId: string;
    readonly state: unknown;
  }): Promise<void>;
}

export interface MemoryContextPolicy {
  readonly namespaces: readonly MemoryNamespace[];
  readonly layers: readonly ('working' | 'episodic' | 'semantic' | 'procedural')[];
  readonly allowCandidates: boolean;
  readonly maxTokenBudget: number;
  readonly evidenceRequired: boolean;
}

export interface MemoryRecallRequest {
  readonly agentRuntimeId: string;
  readonly bindingRef: string;
  readonly projectKey: string;
  readonly policy: MemoryContextPolicy;
  readonly query?: string;
}

export interface MemoryInteractionPort {
  open(input: {
    readonly actor: MemoryActorContext;
    readonly projectKey: string;
    readonly namespace: MemoryNamespace;
    readonly taskId?: TaskId;
  }): Promise<MemoryViewHandle>;
  query(input: {
    readonly actor: MemoryActorContext;
    readonly projectKey: string;
    readonly namespace: MemoryNamespace;
    readonly query: string;
    readonly limit: number;
  }): Promise<MemoryView>;
  resolveSource(input: {
    readonly actor: MemoryActorContext;
    readonly projectKey: string;
    readonly sourceRef: string;
  }): Promise<MemorySourceResolution>;
  inspect(input: {
    readonly actor: MemoryActorContext;
    readonly sourceRef: string;
    readonly sourceDigest: string;
  }): Promise<MemoryDetailView>;
  compare(input: {
    readonly actor: MemoryActorContext;
    readonly leftRef: string;
    readonly rightRef: string;
  }): Promise<MemoryComparisonView>;
  review(input: {
    readonly actor: MemoryActorContext;
    readonly candidateId: string;
    readonly decision: 'approve' | 'reject' | 'defer';
    readonly decisionReason: string;
  }): Promise<MemoryReviewReceipt>;
  promote(input: {
    readonly actor: MemoryActorContext;
    readonly candidateId: string;
    readonly from: 'project';
    readonly to: 'global';
    readonly reason: string;
    readonly impactScope: string;
    readonly approvalRef: string;
    readonly approvalDigest: string;
    readonly sourceRefs: readonly string[];
    readonly sourceDigests: readonly string[];
  }): Promise<MemoryPromotionReceipt>;
  planForgetting(input: MemoryForgettingRequest): Promise<MemoryForgettingPlan>;
}

export interface MemorySourceResolution {
  readonly sourceRef: string;
  readonly sourceDigest: string;
}

export interface MemoryViewHandle {
  readonly handleId: string;
  readonly actorId: string;
  readonly projectKey: string;
  readonly namespace: MemoryNamespace;
  readonly taskId?: TaskId;
  readonly readOnly: true;
}

export interface MemoryView {
  readonly handle: MemoryViewHandle;
  readonly entries: readonly MemoryQueryEntry[];
  readonly indexVersion?: string;
  readonly omitted: readonly { readonly reason: string; readonly ref?: string }[];
}

export interface MemoryDetailView {
  readonly handle: MemoryViewHandle;
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly content: string;
}

export interface MemoryComparisonView {
  readonly handle: MemoryViewHandle;
  readonly leftRef: string;
  readonly rightRef: string;
  readonly relation: 'same' | 'different' | 'unknown';
  readonly evidenceRefs: readonly string[];
}

export interface OrganHealthSnapshot { readonly organId: OrganId; readonly checkedAt: string; readonly expiresAt: string; readonly overall: HealthState; readonly functions: readonly { readonly functionId: string; readonly status: 'healthy' | 'degraded' | 'failed' | 'unknown'; readonly measurements: readonly { readonly name: string; readonly value: string | number; readonly unit?: string }[]; readonly evidenceRefs: readonly EvidenceRef[] }[]; }
export interface Attention { readonly attentionId: string; readonly scope: ScopeRef; readonly severity: 'info' | 'attention' | 'blocker'; readonly state: 'open' | 'recovering' | 'resolved'; readonly message: string; readonly evidenceRefs: readonly EvidenceRef[]; readonly ownerId?: string; readonly nextAction?: NextAction; readonly relatedAttentionId?: string; }
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

import { ContractError } from './errors.js';
export { ContractError } from './errors.js';
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
export function assertCheckpointIdentity(a: ScopeRef, b: ScopeRef): void {
  if (!sameScopedId(a.organId, b.organId) || !sameScopedId(a.taskId, b.taskId) || !sameScopedId(a.cycleId, b.cycleId) || !sameScopedId(a.operationId, b.operationId)) {
    throw new ContractError('checkpoint identity mismatch');
  }
}
export function assertCheckpointStopPredecessor(current: ScopeRef, previous: ScopeRef): void {
  if (!sameScopedId(current.organId, previous.organId) || !sameScopedId(current.taskId, previous.taskId) || !sameScopedId(current.cycleId, previous.cycleId)) {
    throw new ContractError('checkpoint identity mismatch');
  }
  if (previous.operationId && (!current.operationId || !sameScopedId(current.operationId, previous.operationId))) {
    throw new ContractError('checkpoint operation mismatch');
  }
}
export function assertEvidenceRef(ref: EvidenceRef): void {
  if (ref.evidenceId.scope !== 'evidence' || !ref.evidenceId.value.trim()) throw new ContractError('evidence id is required');
  if (!['execution', 'tool', 'operation', 'external'].includes(ref.kind)) throw new ContractError('evidence kind is invalid');
  if (!ref.source.trim() || !ref.locator.trim()) throw new ContractError('evidence source and locator are required');
  if (ref.digest !== undefined && (typeof ref.digest !== 'string' || !ref.digest.trim())) throw new ContractError('evidence digest must be a non-empty string');
  if (ref.scope.organId.scope !== 'organ' || !ref.scope.organId.value.trim()) throw new ContractError('evidence organ scope is required');
  if (ref.scope.taskId && (ref.scope.taskId.scope !== 'task' || !ref.scope.taskId.value.trim())) throw new ContractError('evidence task scope is invalid');
  if (ref.scope.cycleId && (ref.scope.cycleId.scope !== 'cycle' || !ref.scope.cycleId.value.trim())) throw new ContractError('evidence cycle scope is invalid');
  if (ref.scope.operationId && (ref.scope.operationId.scope !== 'operation' || !ref.scope.operationId.value.trim())) throw new ContractError('evidence operation scope is invalid');
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
  if (current.outcome === 'stopped') {
    assertCheckpointStopPredecessor(current.scope, previous.scope);
  } else {
    assertCheckpointIdentity(current.scope, previous.scope);
  }
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
  const ancestors = new WeakSet<object>();
  const visit = (value: JsonValue): void => {
    if (value === null || typeof value !== 'object') return;
    if (ancestors.has(value)) throw new ContractError('cyclic business payload');
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else {
      for (const [key, nested] of Object.entries(value)) {
        if (CONTROL_KEYS.has(key)) throw new ContractError(`control field leaked into business payload: ${key}`);
        visit(nested);
      }
    }
    ancestors.delete(value);
  };
  visit(payload);
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
  validateWorkAssignment(assignment); assertNonEmptyReference(input.agentId, 'work result agent id'); assertScope(input.taskId, 'task'); assertExecutionEpoch(input.executionEpoch);
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

export type ProviderProtocol = 'responses' | 'anthropic' | 'openai' | 'other-explicit';
export type ProviderReadinessState = 'ready' | 'degraded' | 'not-ready' | 'unknown' | 'capability-unavailable' | 'dependency-missing';
export type ProviderEventKind = 'model' | 'output' | 'tool' | 'error' | 'terminal' | 'attention' | 'transport';
export type ProviderTerminalState = 'succeeded' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'stopped' | 'unknown';
export type ProviderSettleState = ProviderTerminalState;
export type ProviderErrorPhase = 'probe' | 'start' | 'resume' | 'submit' | 'observe' | 'tool' | 'stop' | 'settle' | 'close' | 'unknown';
export type ProviderErrorCategory = 'provider' | 'protocol' | 'transport' | 'timeout' | 'capability' | 'configuration' | 'permission' | 'validation' | 'runtime' | 'unknown';
export type ProviderRetryability = 'retryable' | 'terminal' | 'manual';
export type ProviderAttentionClass = 'foreground' | 'background' | 'recovery';
export type ProviderStopReceiptStatus = 'requested' | 'accepted' | 'rejected';
export type ProviderResourceState = 'released' | 'pending' | 'failed' | 'unknown';
export type ProviderPersistenceState = 'committed' | 'pending' | 'failed' | 'blocked' | 'unknown';
export type ProviderCloseState = 'closed' | 'pending' | 'failed' | 'unknown';
export type ProviderToolStatus = 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown';
export type ProviderSubmitStatus = 'accepted' | 'completed' | 'blocked' | 'failed' | 'unknown';
export type AgentRuntimeId = string;

export interface ProviderBinding {
  readonly bindingId: string;
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly endpointRef: string;
  readonly modelRef: string;
  readonly configDigest: string;
  readonly capabilityDigest: string;
}

export interface ExecutionBinding {
  readonly runtimeId: AgentRuntimeId;
  readonly provider: ProviderBinding;
  readonly externalExecutionRef?: EvidenceRef;
}

export interface ProviderCapabilities {
  readonly bindingId: string;
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly capabilities: readonly string[];
  readonly version: string;
  readonly digest: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ProviderReadiness {
  readonly bindingId: string;
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly state: ProviderReadinessState;
  readonly capabilityDigest: string;
  readonly version?: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly failure?: ProviderError;
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
}

export interface ProviderExecutionIdentityRef {
  readonly runtimeId: AgentRuntimeId;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly organId?: OrganId;
  readonly cycleId?: CycleId;
  readonly executionEpoch: number;
}

export interface ProviderExecutionInput extends ProviderExecutionIdentityRef {
  readonly inputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly payload?: BusinessPayload;
}

export interface ProviderStartInput extends ProviderExecutionInput {}
export interface ProviderResumeInput extends ProviderExecutionInput {
  readonly checkpointId: CheckpointId;
  readonly checkpointExecutionEpoch: number;
}
export interface ProviderSubmitInput extends ProviderExecutionInput {
  readonly payload: BusinessPayload;
}
export interface ProviderObserveInput extends ProviderExecutionIdentityRef {}
export interface ProviderSettleInput extends ProviderExecutionIdentityRef {
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface ProviderStartReceipt extends ProviderExecutionIdentityRef {
  readonly startedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly externalExecutionRef?: EvidenceRef;
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
}

export interface ProviderRecoveryResult extends ProviderExecutionIdentityRef {
  readonly checkpointId: CheckpointId;
  readonly recovered: boolean;
  readonly staleRejected: boolean;
  readonly rejectedEpoch?: number;
  readonly recoveryStateRef: EvidenceRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly error?: ProviderError;
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
}

export interface ProviderSubmitResult extends ProviderExecutionIdentityRef {
  readonly status: ProviderSubmitStatus;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly payload?: BusinessPayload;
  readonly error?: ProviderError;
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
}

export interface ProviderEvent extends ProviderExecutionIdentityRef {
  readonly eventId: string;
  readonly kind: ProviderEventKind;
  readonly terminalState?: ProviderTerminalState;
  readonly outputRefs?: readonly string[];
  readonly summary?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly error?: ProviderError;
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
}

export interface ProviderToolResult extends ProviderExecutionIdentityRef {
  readonly toolId: string;
  readonly callId: string;
  readonly status: ProviderToolStatus;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly error?: ProviderError;
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
}

export interface ProviderError {
  readonly errorId: string;
  readonly code: string;
  readonly category: ProviderErrorCategory;
  readonly phase: ProviderErrorPhase;
  readonly message: string;
  readonly ownerId: string;
  readonly retryable: ProviderRetryability;
  readonly attention: ProviderAttentionClass;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly externalRef?: EvidenceRef;
  readonly nextAction: NextAction;
}

export interface ProviderStopRequest extends ProviderExecutionIdentityRef {
  readonly reason: string;
  readonly ownerId: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface ProviderStopReceipt extends ProviderExecutionIdentityRef {
  readonly status: ProviderStopReceiptStatus;
  readonly receivedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly error?: ProviderError;
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
}

export interface ProviderResourceResult {
  readonly state: ProviderResourceState;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly failure?: ProviderError;
}

export interface ProviderPersistenceResult {
  readonly state: ProviderPersistenceState;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly failure?: ProviderError;
}

export interface ProviderSettlement extends ProviderExecutionIdentityRef {
  readonly state: ProviderSettleState;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly resourceRelease: ProviderResourceResult;
  readonly persistence: ProviderPersistenceResult;
  readonly error?: ProviderError;
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
}

export interface ProviderCloseResult {
  readonly bindingId: string;
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly state: ProviderCloseState;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly error?: ProviderError;
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
}

export interface ProviderBindingMatchTarget {
  readonly bindingId?: string;
  readonly providerId?: string;
  readonly protocol?: ProviderProtocol;
}

export interface ExecutionRuntimePort {
  readonly kind: 'humanagent.execution-runtime-port';
  probe(binding: ProviderBinding): Promise<ProviderReadiness>;
  capabilities(binding: ProviderBinding): Promise<ProviderCapabilities>;
  start(input: ProviderStartInput): Promise<ProviderStartReceipt>;
  resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult>;
  submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult>;
  observe(input: ProviderObserveInput): AsyncIterable<ProviderEvent>;
  requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt>;
  settle(input: ProviderSettleInput): Promise<ProviderSettlement>;
  close(binding: ProviderBinding): Promise<ProviderCloseResult>;
}

export type ProviderEventEpochDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly rejected: true; readonly reason: 'stale' | 'future' | 'mismatch'; readonly expectedExecutionEpoch: number; readonly receivedExecutionEpoch: number };

const PROVIDER_PROTOCOLS = new Set<string>(['responses', 'anthropic', 'openai', 'other-explicit']);
const PROVIDER_READINESS_STATES = new Set<string>(['ready', 'degraded', 'not-ready', 'unknown', 'capability-unavailable', 'dependency-missing']);
const PROVIDER_EVENT_KINDS = new Set<string>(['model', 'output', 'tool', 'error', 'terminal', 'attention', 'transport']);
const PROVIDER_TERMINAL_STATES = new Set<string>(['succeeded', 'waiting', 'blocked', 'failed', 'cancelled', 'stopped', 'unknown']);
const PROVIDER_ERROR_PHASES = new Set<string>(['probe', 'start', 'resume', 'submit', 'observe', 'tool', 'stop', 'settle', 'close', 'unknown']);
const PROVIDER_ERROR_CATEGORIES = new Set<string>(['provider', 'protocol', 'transport', 'timeout', 'capability', 'configuration', 'permission', 'validation', 'runtime', 'unknown']);
const PROVIDER_RETRYABILITY = new Set<string>(['retryable', 'terminal', 'manual']);
const PROVIDER_ATTENTION_CLASSES = new Set<string>(['foreground', 'background', 'recovery']);
const PROVIDER_STOP_RECEIPT_STATES = new Set<string>(['requested', 'accepted', 'rejected']);
const PROVIDER_RESOURCE_STATES = new Set<string>(['released', 'pending', 'failed', 'unknown']);
const PROVIDER_PERSISTENCE_STATES = new Set<string>(['committed', 'pending', 'failed', 'blocked', 'unknown']);
const PROVIDER_CLOSE_STATES = new Set<string>(['closed', 'pending', 'failed', 'unknown']);
const PROVIDER_TOOL_STATES = new Set<string>(['succeeded', 'failed', 'blocked', 'cancelled', 'unknown']);
const PROVIDER_SUBMIT_STATES = new Set<string>(['accepted', 'completed', 'blocked', 'failed', 'unknown']);
const NEXT_ACTION_KINDS = new Set<string>(['continue', 'wait', 'stop', 'recover']);

export function runtimeId(value: string): AgentRuntimeId {
  assertAgentRuntimeId(value);
  return value;
}
export function assertAgentRuntimeId(value: string): asserts value is AgentRuntimeId {
  assertNonEmptyReference(value, 'agent runtime id');
}
export function assertNextAction(action: NextAction): void {
  if (!action || !NEXT_ACTION_KINDS.has(action.kind)) throw new ContractError('invalid next action');
  if (action.ref !== undefined) assertNonEmptyReference(action.ref, 'next action ref');
}
function assertRefList(refs: readonly string[], label: string): void {
  for (const ref of refs) assertNonEmptyReference(ref, label);
}
function assertProviderEvidenceRefs(refs: readonly EvidenceRef[], label: string): void {
  for (const ref of refs) assertEvidenceRef(ref);
}
function assertProviderEvidenceRefsPresent(refs: readonly EvidenceRef[], label: string): void {
  if (refs.length === 0) throw new ContractError(`${label} evidence refs are required`);
  assertProviderEvidenceRefs(refs, label);
}
function assertExternalEvidenceRef(ref: EvidenceRef, runtimeIdValue: AgentRuntimeId, label: string): void {
  assertEvidenceRef(ref);
  if (ref.kind !== 'external') throw new ContractError(`${label} must use external evidence`);
  if (ref.locator === runtimeIdValue || ref.evidenceId.value === runtimeIdValue) throw new ContractError(`${label} cannot be used as runtime identity`);
}
function assertProviderExecutionIdentity(input: ProviderExecutionIdentityRef): void {
  assertAgentRuntimeId(input.runtimeId);
  assertScope(input.taskId, 'task');
  assertScope(input.operationId, 'operation');
  if (input.organId) assertScope(input.organId, 'organ');
  if (input.cycleId) assertScope(input.cycleId, 'cycle');
  assertExecutionEpoch(input.executionEpoch);
}
function assertProviderEvidenceMatchesExecution(ref: EvidenceRef, execution: ProviderExecutionIdentityRef, label: string): void {
  if (ref.scope.taskId && !sameScopedId(ref.scope.taskId, execution.taskId)) throw new ContractError(`${label} task scope mismatch`);
  if (ref.scope.operationId && !sameScopedId(ref.scope.operationId, execution.operationId)) throw new ContractError(`${label} operation scope mismatch`);
  if (execution.organId && ref.scope.organId && !sameScopedId(ref.scope.organId, execution.organId)) throw new ContractError(`${label} organ scope mismatch`);
  if (execution.cycleId && ref.scope.cycleId && !sameScopedId(ref.scope.cycleId, execution.cycleId)) throw new ContractError(`${label} cycle scope mismatch`);
}
function assertProviderCompletionEvidenceRefs(refs: readonly EvidenceRef[], execution: ProviderExecutionIdentityRef, label: string): void {
  for (const ref of refs) assertProviderEvidenceMatchesExecution(ref, execution, label);
}
function assertOptionalProviderOwner(input: { readonly ownerId?: string; readonly nextAction?: NextAction }): void {
  if (input.ownerId !== undefined) assertNonEmptyReference(input.ownerId, 'provider ownerId');
  if (input.nextAction !== undefined) assertNextAction(input.nextAction);
}

export function validateProviderBinding(input: ProviderBinding): void {
  assertNonEmptyReference(input.bindingId, 'provider bindingId');
  assertNonEmptyReference(input.providerId, 'provider providerId');
  if (!PROVIDER_PROTOCOLS.has(input.protocol)) throw new ContractError('provider protocol is invalid');
  assertNonEmptyReference(input.endpointRef, 'provider endpointRef');
  assertNonEmptyReference(input.modelRef, 'provider modelRef');
  assertNonEmptyReference(input.configDigest, 'provider configDigest');
  assertNonEmptyReference(input.capabilityDigest, 'provider capabilityDigest');
}
export function validateExecutionBinding(input: ExecutionBinding): void {
  assertAgentRuntimeId(input.runtimeId);
  validateProviderBinding(input.provider);
  if (input.externalExecutionRef) assertExternalEvidenceRef(input.externalExecutionRef, input.runtimeId, 'external execution ref');
}
export function validateProviderCapabilities(input: ProviderCapabilities): void {
  assertNonEmptyReference(input.bindingId, 'capability bindingId');
  assertNonEmptyReference(input.providerId, 'capability providerId');
  if (!PROVIDER_PROTOCOLS.has(input.protocol)) throw new ContractError('provider protocol is invalid');
  assertRefList(input.capabilities, 'provider capabilities');
  assertNonEmptyReference(input.version, 'provider capability version');
  assertNonEmptyReference(input.digest, 'provider capability digest');
  assertValidTime(input.checkedAt, 'capability checkedAt');
  assertValidTime(input.expiresAt, 'capability expiresAt');
  assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider capability');
}
export function validateProviderReadiness(input: ProviderReadiness): void {
  assertNonEmptyReference(input.bindingId, 'readiness bindingId');
  assertNonEmptyReference(input.providerId, 'readiness providerId');
  if (!PROVIDER_PROTOCOLS.has(input.protocol)) throw new ContractError('provider protocol is invalid');
  if (!PROVIDER_READINESS_STATES.has(input.state)) throw new ContractError('provider readiness state is invalid');
  assertNonEmptyReference(input.capabilityDigest, 'readiness capabilityDigest');
  if (input.version !== undefined) assertNonEmptyReference(input.version, 'readiness version');
  assertValidTime(input.checkedAt, 'readiness checkedAt');
  assertValidTime(input.expiresAt, 'readiness expiresAt');
  assertProviderEvidenceRefs(input.evidenceRefs, 'provider readiness evidenceRefs');
  if (input.failure) validateProviderError(input.failure);
  if (input.state === 'ready') {
    assertProviderEvidenceRefsPresent(input.evidenceRefs, 'ready provider readiness');
    if (input.failure) throw new ContractError('ready provider readiness cannot carry a failure');
  } else {
    if (input.evidenceRefs.length === 0) throw new ContractError('non-ready provider readiness requires evidence refs');
    if (!input.failure || !input.ownerId || !input.nextAction) throw new ContractError('non-ready provider readiness requires failure, owner, and next action');
  }
  assertOptionalProviderOwner(input);
}
export function validateProviderError(input: ProviderError): void {
  assertNonEmptyReference(input.errorId, 'provider errorId');
  assertNonEmptyReference(input.code, 'provider error code');
  if (!PROVIDER_ERROR_CATEGORIES.has(input.category)) throw new ContractError('provider error category is invalid');
  if (!PROVIDER_ERROR_PHASES.has(input.phase)) throw new ContractError('provider error phase is invalid');
  assertNonEmptyReference(input.message, 'provider error message');
  assertNonEmptyReference(input.ownerId, 'provider error ownerId');
  if (!PROVIDER_RETRYABILITY.has(input.retryable)) throw new ContractError('provider error retryability is invalid');
  if (!PROVIDER_ATTENTION_CLASSES.has(input.attention)) throw new ContractError('provider error attention class is invalid');
  assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider error');
  if (input.externalRef) assertEvidenceRef(input.externalRef);
  assertNextAction(input.nextAction);
}
function validateProviderExecutionInput(input: ProviderExecutionInput): void {
  assertProviderExecutionIdentity(input);
  assertRefList(input.inputRefs, 'provider inputRefs');
  assertProviderEvidenceRefs(input.evidenceRefs, 'provider execution evidenceRefs');
  if (input.payload !== undefined) assertBusinessPayload(input.payload);
}
export function validateProviderStartInput(input: ProviderStartInput): void {
  validateProviderExecutionInput(input);
}
export function validateProviderResumeInput(input: ProviderResumeInput): void {
  validateProviderExecutionInput(input);
  assertScope(input.checkpointId, 'checkpoint');
  assertExecutionEpoch(input.checkpointExecutionEpoch);
  if (input.checkpointExecutionEpoch !== input.executionEpoch) throw new ContractError('provider resume checkpoint epoch is stale');
}
export function validateProviderSubmitInput(input: ProviderSubmitInput): void {
  validateProviderExecutionInput(input);
  if (!input.payload) throw new ContractError('provider submit payload is required');
  assertBusinessPayload(input.payload);
}
export function validateProviderObserveInput(input: ProviderObserveInput): void {
  assertProviderExecutionIdentity(input);
}
export function validateProviderSettleInput(input: ProviderSettleInput): void {
  assertProviderExecutionIdentity(input);
  if (input.evidenceRefs !== undefined) assertProviderEvidenceRefs(input.evidenceRefs, 'provider settle evidenceRefs');
}
export function validateProviderStartReceipt(input: ProviderStartReceipt): void {
  assertProviderExecutionIdentity(input);
  assertValidTime(input.startedAt, 'provider start startedAt');
  assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider start');
  if (input.externalExecutionRef) assertExternalEvidenceRef(input.externalExecutionRef, input.runtimeId, 'provider start external execution ref');
  assertOptionalProviderOwner(input);
}
export function validateProviderRecoveryResult(input: ProviderRecoveryResult): void {
  assertProviderExecutionIdentity(input);
  assertScope(input.checkpointId, 'checkpoint');
  if (typeof input.recovered !== 'boolean' || typeof input.staleRejected !== 'boolean') throw new ContractError('provider recovery flags must be boolean');
  if (input.staleRejected && input.recovered) throw new ContractError('stale provider recovery cannot be recovered');
  if (input.staleRejected && input.rejectedEpoch === undefined) throw new ContractError('stale provider recovery requires rejected epoch');
  if (input.rejectedEpoch !== undefined) assertPositiveSafeInteger(input.rejectedEpoch, 'provider recovery rejectedEpoch');
  if (input.recovered && input.error) throw new ContractError('successful provider recovery cannot carry an error');
  if (input.recovered && input.rejectedEpoch !== undefined) throw new ContractError('successful provider recovery cannot carry rejection details');
  if (input.staleRejected && !input.error) throw new ContractError('stale provider recovery requires error');
  if (!input.recovered && (!input.error || !input.ownerId || !input.nextAction)) throw new ContractError('unfinished provider recovery requires error, owner, and next action');
  assertEvidenceRef(input.recoveryStateRef);
  assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider recovery');
  if (input.error) validateProviderError(input.error);
  assertOptionalProviderOwner(input);
}
export function validateProviderSubmitResult(input: ProviderSubmitResult): void {
  assertProviderExecutionIdentity(input);
  if (!PROVIDER_SUBMIT_STATES.has(input.status)) throw new ContractError('provider submit status is invalid');
  assertRefList(input.outputRefs, 'provider outputRefs');
  assertProviderEvidenceRefs(input.evidenceRefs, 'provider submit evidenceRefs');
  if (input.payload !== undefined) assertBusinessPayload(input.payload);
  if (input.error) validateProviderError(input.error);
  if (input.status === 'completed') {
    assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider completed submit');
    if (input.outputRefs.length === 0) throw new ContractError('provider completed submit requires output refs');
    if (input.error) throw new ContractError('provider completed submit cannot carry an error');
  }
  if (input.status === 'accepted') {
    assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider accepted submit');
    if (input.error) throw new ContractError('provider accepted submit cannot carry an error');
  }
  if (input.status === 'blocked' || input.status === 'failed' || input.status === 'unknown') {
    if (!input.error) throw new ContractError('provider non-success submit requires error');
    if (input.evidenceRefs.length === 0) throw new ContractError('provider non-success submit requires evidence refs');
  }
  assertOptionalProviderOwner(input);
}
export function validateProviderEvent(input: ProviderEvent): void {
  assertProviderExecutionIdentity(input);
  assertNonEmptyReference(input.eventId, 'provider eventId');
  if (!PROVIDER_EVENT_KINDS.has(input.kind)) throw new ContractError('provider event kind is invalid');
  if (input.terminalState && !PROVIDER_TERMINAL_STATES.has(input.terminalState)) throw new ContractError('provider terminal state is invalid');
  if (input.terminalState && input.kind !== 'terminal') throw new ContractError('provider terminal state requires terminal event kind');
  if (input.kind === 'terminal' && !input.terminalState) throw new ContractError('provider terminal event requires terminal state');
  if (input.kind === 'terminal') assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider terminal event');
  assertProviderEvidenceRefs(input.evidenceRefs, 'provider event evidenceRefs');
  if (input.outputRefs !== undefined) assertRefList(input.outputRefs, 'provider event outputRefs');
  if (input.summary !== undefined && input.summary.trim() === '') throw new ContractError('provider event summary must be non-empty');
  if (input.error) validateProviderError(input.error);
  if (input.kind === 'error' && !input.error) throw new ContractError('provider error event requires error');
  if (input.error && input.kind !== 'error') throw new ContractError('provider error payload requires error event kind');
  if (['tool', 'error', 'terminal'].includes(input.kind) && input.evidenceRefs.length === 0) throw new ContractError('provider tool/error/terminal event requires evidence refs');
  if (['tool', 'error', 'terminal', 'attention'].includes(input.kind) && (!input.ownerId || !input.nextAction)) throw new ContractError('provider event requires owner and next action');
  assertOptionalProviderOwner(input);
}
export function checkProviderEventEpoch(event: ProviderEvent, expectedExecutionEpoch: number): ProviderEventEpochDecision {
  if (event.executionEpoch === expectedExecutionEpoch) return { accepted: true };
  const reason = event.executionEpoch < expectedExecutionEpoch ? 'stale' : 'future';
  return { accepted: false, rejected: true, reason, expectedExecutionEpoch, receivedExecutionEpoch: event.executionEpoch };
}
export function assertProviderEventEpoch(event: ProviderEvent, expectedExecutionEpoch: number): void {
  const decision = checkProviderEventEpoch(event, expectedExecutionEpoch);
  if (!decision.accepted) throw new ContractError(`provider event epoch is ${decision.reason}`);
}
export function validateProviderToolResult(input: ProviderToolResult): void {
  assertProviderExecutionIdentity(input);
  assertNonEmptyReference(input.toolId, 'provider toolId');
  assertNonEmptyReference(input.callId, 'provider tool callId');
  if (!PROVIDER_TOOL_STATES.has(input.status)) throw new ContractError('provider tool status is invalid');
  assertRefList(input.outputRefs, 'provider tool outputRefs');
  assertProviderEvidenceRefs(input.evidenceRefs, 'provider tool evidenceRefs');
  if (input.error) validateProviderError(input.error);
  if (input.status !== 'succeeded' && !input.error) throw new ContractError('provider non-success tool result requires error');
  if (input.status !== 'succeeded' && input.evidenceRefs.length === 0) throw new ContractError('provider non-success tool result requires evidence refs');
  if (input.status === 'succeeded' && input.error) throw new ContractError('provider succeeded tool result cannot carry an error');
  assertOptionalProviderOwner(input);
}
export function validateProviderStopRequest(input: ProviderStopRequest): void {
  assertProviderExecutionIdentity(input);
  assertNonEmptyReference(input.reason, 'provider stop reason');
  assertNonEmptyReference(input.ownerId, 'provider stop ownerId');
  if (input.evidenceRefs !== undefined) assertProviderEvidenceRefs(input.evidenceRefs, 'provider stop evidenceRefs');
}
export function validateProviderStopReceipt(input: ProviderStopReceipt): void {
  assertProviderExecutionIdentity(input);
  if ('state' in input || 'settled' in input) throw new ContractError('provider stop receipt cannot carry settled state');
  if (!PROVIDER_STOP_RECEIPT_STATES.has(input.status)) throw new ContractError('provider stop receipt status is invalid');
  assertValidTime(input.receivedAt, 'provider stop receivedAt');
  assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider stop receipt');
  if (input.error) validateProviderError(input.error);
  if (input.status === 'rejected' && !input.error) throw new ContractError('rejected provider stop requires error');
  if (input.error && input.status !== 'rejected') throw new ContractError('accepted provider stop cannot carry an error');
  assertOptionalProviderOwner(input);
}
function validateProviderResourceResult(input: ProviderResourceResult): void {
  if (!PROVIDER_RESOURCE_STATES.has(input.state)) throw new ContractError('provider resource state is invalid');
  assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider resource release');
  if (input.failure) validateProviderError(input.failure);
  if (input.state === 'failed' && !input.failure) throw new ContractError('provider resource failure requires error');
  if (input.failure && input.state !== 'failed') throw new ContractError('provider resource error requires failed state');
}
function validateProviderPersistenceResult(input: ProviderPersistenceResult): void {
  if (!PROVIDER_PERSISTENCE_STATES.has(input.state)) throw new ContractError('provider persistence state is invalid');
  assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider persistence');
  if (input.failure) validateProviderError(input.failure);
  if ((input.state === 'failed' || input.state === 'blocked') && !input.failure) throw new ContractError('provider persistence failure requires error');
  if (input.failure && input.state !== 'failed' && input.state !== 'blocked') throw new ContractError('provider persistence error requires failed or blocked state');
}
export function validateProviderSettlement(input: ProviderSettlement): void {
  assertProviderExecutionIdentity(input);
  if (!PROVIDER_TERMINAL_STATES.has(input.state)) throw new ContractError('provider settlement state is invalid');
  assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider settlement');
  validateProviderResourceResult(input.resourceRelease);
  validateProviderPersistenceResult(input.persistence);
  assertProviderCompletionEvidenceRefs(input.evidenceRefs, input, 'provider settlement');
  assertProviderCompletionEvidenceRefs(input.resourceRelease.evidenceRefs, input, 'provider resource release');
  assertProviderCompletionEvidenceRefs(input.persistence.evidenceRefs, input, 'provider persistence');
  if (input.error) validateProviderError(input.error);
  if ((input.state === 'failed' || input.state === 'blocked' || input.state === 'unknown') && !input.error) throw new ContractError('provider non-terminal settlement requires error');
  if (input.error && (input.state === 'succeeded' || input.state === 'stopped' || input.state === 'cancelled')) throw new ContractError('provider completed settlement cannot carry an error');
  if (input.state === 'stopped' || input.state === 'succeeded' || input.state === 'cancelled') {
    if (input.resourceRelease.state !== 'released') throw new ContractError('provider completed settlement requires released resources');
    if (input.persistence.state !== 'committed') throw new ContractError('provider completed settlement requires committed persistence');
  }
  if (input.state === 'waiting' && (!input.ownerId || !input.nextAction)) throw new ContractError('provider waiting settlement requires owner and next action');
  assertOptionalProviderOwner(input);
}
export function validateProviderCloseResult(input: ProviderCloseResult): void {
  assertNonEmptyReference(input.bindingId, 'close bindingId');
  assertNonEmptyReference(input.providerId, 'close providerId');
  if (!PROVIDER_PROTOCOLS.has(input.protocol)) throw new ContractError('provider protocol is invalid');
  if (!PROVIDER_CLOSE_STATES.has(input.state)) throw new ContractError('provider close state is invalid');
  assertProviderEvidenceRefsPresent(input.evidenceRefs, 'provider close');
  if (input.error) validateProviderError(input.error);
  if (input.state === 'failed' || input.state === 'unknown') {
    if (!input.error) throw new ContractError('provider failed close requires error');
  }
  if (input.state === 'pending' && (!input.ownerId || !input.nextAction)) throw new ContractError('provider pending close requires owner and next action');
  if (input.error && input.state === 'closed') throw new ContractError('provider closed result cannot carry an error');
  assertOptionalProviderOwner(input);
}
export function assertProviderBindingMatch(binding: ProviderBinding, expected: ProviderBindingMatchTarget): void {
  validateProviderBinding(binding);
  if (expected.bindingId !== undefined && binding.bindingId !== expected.bindingId) throw new ContractError('provider binding id mismatch');
  if (expected.providerId !== undefined && binding.providerId !== expected.providerId) throw new ContractError('provider binding provider mismatch');
  if (expected.protocol !== undefined && binding.protocol !== expected.protocol) throw new ContractError('provider binding protocol mismatch');
}
export function assertProviderReadinessBinding(readiness: ProviderReadiness, binding: ProviderBinding): void {
  validateProviderReadiness(readiness);
  assertProviderBindingMatch(binding, { bindingId: readiness.bindingId, providerId: readiness.providerId, protocol: readiness.protocol });
  if (readiness.capabilityDigest !== binding.capabilityDigest) throw new ContractError('provider readiness capability digest mismatch');
}
export function assertProviderExecutionIdentityMatch(actual: ProviderExecutionIdentityRef, expected: ProviderExecutionIdentityRef): void {
  assertProviderExecutionIdentity(actual);
  assertProviderExecutionIdentity(expected);
  const sameOptionalScope = (
    left: { readonly scope: string; readonly value: string } | undefined,
    right: { readonly scope: string; readonly value: string } | undefined,
  ): boolean => left === undefined
    ? right === undefined
    : right !== undefined && left.scope === right.scope && left.value === right.value;
  if (actual.runtimeId !== expected.runtimeId
    || actual.taskId.scope !== expected.taskId.scope
    || actual.taskId.value !== expected.taskId.value
    || actual.operationId.scope !== expected.operationId.scope
    || actual.operationId.value !== expected.operationId.value
    || !sameOptionalScope(actual.organId, expected.organId)
    || !sameOptionalScope(actual.cycleId, expected.cycleId)
    || actual.executionEpoch !== expected.executionEpoch) {
    throw new ContractError('provider execution identity mismatch');
  }
}

export * from './framework.js';
export * from './explicit-brain.js';
export * from './agent-loop.js';
