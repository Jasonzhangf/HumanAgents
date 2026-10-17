import { createHash } from 'node:crypto';
import { canonicalJsonStringify, id, operationIdempotencyKey, operationSemanticFingerprint,
  operationSemanticFingerprintKey, type ToolRegistration } from '../../../contracts/src/index.js';
import { JsonlTaskGrantJournal } from '../../../adapters/jsonl/src/task-grants.js';
import type { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import type { RuntimeExecutionAllocation, RuntimeTaskJournalPort } from '../../../runtime/src/ui-runtime/coordinator.js';
import type { OperationTaskBoundaryPort } from '../../../runtime/src/gateway/ports.js';
import { createToolExecutionGateway } from '../tool-execution-gateway.js';
import { AppLifecycleError } from '../errors.js';
import { createExecutionAdmission, executionAdmissionInputDigest,
  type PreparedParentLifecycle } from './execution-admission.js';
import { readPreparedExecutionInput } from '../prepared-execution-input.js';
export { readPreparedExecutionInput } from '../prepared-execution-input.js';
import { TASK_EXECUTION_ACTION_ID, TASK_EXECUTION_CAPABILITY } from './task-control.js';
import { ImmutableAssetStore } from '../../../adapters/filesystem/src/index.js';
import { filesystemProviderEvidenceSink, providerRawContentReader } from '../../../adapters/provider/src/evidence.js';
import { createJsonlActiveTurnJournal } from '../../../adapters/jsonl/src/active-turn.js';
import { ActiveTurnContext, ActiveTurnSegmentContext } from '../../../runtime/src/context/active-turn-context.js';
import { produceAdmittedTurn, newActiveTurnId } from '../../../runtime/src/admission/admitted-turn.js';
import { AgentLoopRuntime } from '../../../runtime/src/agent-loop/runtime.js';
import { createJsonlCheckpointClosurePort, createJsonlCheckpointJournal, createJsonlContextHistoryPort,
  createJsonlSemanticHistoryJournal, readCommittedNativeSegmentSource } from '../checkpoint-journal.js';
import { createNativeRecoveryAssets } from '../native-recovery-assets.js';
import { createNativeExecution } from './native-execution.js';
import { createNativeBoundaryContinuation } from './native-boundary-continuation.js';
import { createJsonlNativeSaveProgressPort } from '../../../adapters/jsonl/src/native-save-progress.js';
import { frozenTurnCloseRef, readCheckpointClosurePreparation } from '../../../runtime/src/checkpoints/closure.js';
import { closeAgentProvider, type AgentProviderComposition } from '../agent-driver-composition.js';
import type { RuntimeExecutionDriver, RuntimeExecutionPreparationInput } from '../../../runtime/src/ui-runtime/coordinator.js';
import type { ProviderAgentDriverOptions } from '../../../adapters/provider/src/agent-driver.js';
import type { ProviderToolExecutionPort } from '../../../adapters/provider/src/agent-driver.js';
import type { EvidenceRef, ProviderToolDefinition, WorkAssignment } from '../../../contracts/src/index.js';
import type { WebSearchBackendConfig } from '../../../config/src/index.js';
import { createResponsesFileToolExecutor } from '../provider-tool-execution.js';
import { projectAdmittedTurnIdentityV1 } from '../../../runtime/src/context/semantic-history.js';
import { checkpointCommitId } from '../../../runtime/src/checkpoints/coordinator.js';
import type { NativeSaveIntent, NativeSaveIntentV1, NativeSegmentSaveIntentV2 } from '../../../runtime/src/checkpoints/native-save-contract.js';
import type { NativeSegmentSaveSourceV2, ResumedTurnSegmentOpened } from '../../../contracts/src/active-turn-segments.js';
import { activeTurnSegmentCommitId } from '../../../contracts/src/active-turn-segments.js';
import type { RuntimeColdExecutionSource } from './cold-execution-source.js';
import { readColdExecutionSource as readColdSource, type RuntimeColdExecutionSourceRequest } from './cold-execution-source.js';
import type { RuntimeColdExecutionProducer, RuntimeColdTurnPreparation } from '../../../runtime/src/ui-runtime/cold-execution-resume.js';
import type { RetryCycleJournalPort } from '../../../runtime/src/orchestration/retry-cycle.js';
import type { ResumeActiveTurnSegmentInput } from '../../../runtime/src/context/active-turn-segments.js';
import { TaskGrantDeniedError } from '../../../runtime/src/admission/task-grant.js';
import { FileCheckpointStore } from './journal.js';
import { renderTaskReorientation } from '../../../runtime/src/orchestration/task-dispatch-template.js';
import {
  createStandardTurnEndExecutor,
  StandardTurnEndError,
  type StandardTurnEndOwnerPort,
} from './standard-turn-control.js';
import { ADVERTISED_STANDARD_TURN_END_TOOL, createStandardTurnEndWireExecutor, isStandardTurnEndCall } from './standard-turn-composition.js';
import type { StandardTurnEndCommand } from '../../../contracts/src/standard-turn-end.js';
import type { RuntimeProductIdentity, VerifiedProductPrincipal } from './access-control.js';
import { createExecutionOwnerReaders } from './execution-owner-facts.js';
import { JsonlOperationCompletionJournal } from '../../../adapters/jsonl/src/operation-completion.js';
import type { RuntimeTaskCurrentStatePort, RuntimeTaskCurrentStateFactsPort } from '../../../runtime/src/ui-runtime/current-state.js';
import { JsonlTaskPlanRevisionJournal } from '../../../adapters/jsonl/src/task-plan-revisions.js';
import { TaskPlanRevisionConsumer } from '../../../runtime/src/orchestration/task-plan-revisions.js';
import { createClosedTurnPlannerCall, closedTurnPlannerDutyKey, deriveClosedTurnPlannerDuty,
  type ClosedTurnPlannerCallInput, type ClosedTurnPlannerResult } from '../../../runtime/src/orchestration/closed-turn-planner-call.js';
import type { AgentRuntimePoolManager } from '../../../runtime/src/orchestration/runtime-pool.js';
import type { TaskInstanceHandle } from '../../../runtime/src/orchestration/types.js';
import { createJsonlClosedTurnPlannerCallJournal } from './planner-call-journal.js';
import { createIndependentTurnPlanner, type IndependentTurnPlannerPort } from './turn-planner.js';
import { activeTurnCommitId } from '../../../runtime/src/context/active-turn-journal.js';
import { materializeAdoptedChildSource, type AdoptedChildSourceV1 } from '../../../runtime/src/context/semantic-history-adoption.js';
import { readCurrentTaskPlan } from '../../../runtime/src/orchestration/task-plan-revisions.js';
import type { TaskIdentityConsumer } from '../../../runtime/src/orchestration/task-identity.js';
import type { RuntimeTaskCurrentPlan } from '../../../runtime/src/ui-runtime/current-state.js';
import { createPublishedTaskPlanRevision, assertTaskPlanRevisionRetryMatches,
  validateTaskPlanRevisionTransition } from '../../../core/src/task-plan-revision.js';
import { readReviewedMilestoneBoundary } from '../../../runtime/src/agent-loop/reviewed-milestone-boundary.js';
import { distinctReviewCommitRefs, sameReviewCommitRefs, turnBoundaryRecordRefs } from '../../../runtime/src/checkpoints/closure.js';

/** Public-output and checkpoints share the same physical native Journal. */
export class ServiceExecutionCheckpointStore extends FileCheckpointStore {
  private readonly native;
  constructor(filePath: string, journal: JsonlOrganJournal, private readonly clock: () => Date) {
    super(filePath);
    this.native = createJsonlCheckpointJournal({ filePath, journal });
  }
  override async append(value: import('../../../runtime/src/checkpoints/ports.js').CheckpointAppendRequest) {
    const receipt = await this.native.commitNativeCheckpoint({ ownerId: value.ownerId, checkpoint: value.checkpoint,
      timeAuthority: { source: 'harness', owner: 'runtime-checkpoint-control-owner', authorityRef: value.commitId,
        sampleCommittedAt: async () => this.clock().toISOString() } });
    return { checkpointId: value.checkpoint.id, seq: value.checkpoint.seq, recordDigest: receipt.recordDigest };
  }
}

const parentRegistration: ToolRegistration = {
  toolName: TASK_EXECUTION_ACTION_ID, contractVersion: '1.0.0', supportedKinds: ['run'],
  routeId: 'harness-provider-controller', routeVersion: '1', mode: 'gateway', acceptedScopes: [{}],
  inputContract: 'humanagent://task-execution/input/v1', outputContract: 'humanagent://task-execution/output/v1',
  verifier: 'humanagent://task-execution/standard-end', capabilities: [TASK_EXECUTION_CAPABILITY],
  retryPolicy: 'humanagent://task-execution/retry', owner: 'humanagent.runtime',
};

function missing(message: string): never {
  throw new AppLifecycleError('execution-composition.owner-source-missing', message,
    'supply the exact prepared execution owner record before release', 'humanagent.app.execution-composition');
}

type StandardTurnLifecycle = NonNullable<RuntimeExecutionDriver['standardTurn']>;
/**
 * Exact historical boundary lifecycle. It owns no live Provider and cannot
 * generate. `finishBoundary` completes only the retained native save phases.
 */
export interface StandardTurnBoundaryLifecycle {
  readonly standardTurn: StandardTurnLifecycle;
  finishBoundary(): Promise<void>;
}

/** Shared physical owner assembly. Provider selection occurs only after the durable A2 release edge. */
export function createDefaultExecutionComposition(input: (
  | { readonly principal: VerifiedProductPrincipal; readonly runtimeIdentity?: never }
  | { readonly runtimeIdentity: RuntimeProductIdentity; readonly principal?: never }
) & {
  readonly journal: JsonlOrganJournal;
  readonly filePath: string;
  readonly artifactsRoot: string;
  readonly preparedJournal: RuntimeTaskJournalPort;
  readonly resourceBoundary: OperationTaskBoundaryPort;
  readonly prepareAgentProvider: (selection: { readonly roleId: import('../../../config/src/index.js').AgentRole;
    readonly configuredAgentId?: string }) => Promise<AgentProviderComposition>;
  readonly providerOptions: Pick<ProviderAgentDriverOptions, 'tools' | 'executeTool' | 'maxToolRounds' | 'onRequestLifecycle'>;
  /**
   * Actual admitted Provider-tool scope. When present, the composition builds
   * one admitted executor per execution and binds its real tools/executeTool
   * into the native Provider options. The scope carries the declared workspace
   * and project identity plus the P2 tool definitions; the executor itself is
   * constructed only after the durable A2 release edge, with the verified
   * principal, current grant adapter, real boundary and clock.
   */
  readonly providerToolScope?: {
    readonly workspaceRoot: string;
    readonly projectKey: string;
    readonly artifactRoot: string;
    readonly tools: readonly ProviderToolDefinition[];
    readonly webSearchProviderConfig?: WebSearchBackendConfig;
  };
  readonly now: () => Date;
  readonly currentState: RuntimeTaskCurrentStatePort;
  readonly publishCurrentTurnState: (taskId: RuntimeExecutionAllocation['taskId']) => Promise<unknown>;
  readonly closedTurnPlannerPool: (taskId: RuntimeExecutionAllocation['taskId']) => AgentRuntimePoolManager;
  readonly taskIdentity: TaskIdentityConsumer;
  readonly i2Journal: import('../../../contracts/src/index.js').I2JournalPort;
  readonly retryJournal?: RetryCycleJournalPort;
}) {
  const principalOwner = input.principal?.owner ?? input.runtimeIdentity!.owner;
  const grants = new JsonlTaskGrantJournal(input.journal);
  const context = createJsonlContextHistoryPort({ filePath: input.filePath, journal: input.journal });
  const checkpoints = createJsonlCheckpointJournal({ filePath: input.filePath, journal: input.journal });
  const nativeCheckpoints = { ...checkpoints,
    append: (value: import('../../../runtime/src/checkpoints/ports.js').CheckpointAppendRequest) =>
      new ServiceExecutionCheckpointStore(input.filePath, input.journal, input.now).append(value) };
  const closures = createJsonlCheckpointClosurePort({ filePath: input.filePath, journal: input.journal });
  const rawEvidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(input.artifactsRoot));
  const rawContent = providerRawContentReader(rawEvidence);
  const completion = new JsonlOperationCompletionJournal({ journal: input.journal });
  const plans = new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(input.journal));
  const plannerJournal = createJsonlClosedTurnPlannerCallJournal({ journal: input.journal });
  const turnFacts = new Map<string, { readonly loop: AgentLoopRuntime; readonly native: Pick<ReturnType<typeof createNativeExecution>, 'readSaveStageFacts'>;
    currentPlan?: RuntimeTaskCurrentPlan }>();
  const currentStateFacts: RuntimeTaskCurrentStateFactsPort = {
    async read({ taskId }) {
      const retained = turnFacts.get(taskId.value);
      if (!retained) return { state: 'unknown', reason: 'the actual execution loop has not been constructed' };
      const transition = retained.loop.currentTurnTransition();
      return { state: 'known', value: { turn: { ...transition,
        ownerRef: transition.turnOwnerRef!, }, stages: await retained.native.readSaveStageFacts(),
        ...(retained.currentPlan === undefined ? {} : { currentPlan: retained.currentPlan }) } };
    },
  };
  const admission = createServiceExecutionAdmission({ ...input, principalOwner });
  async function owner(taskId: RuntimeExecutionAllocation['taskId']) {
    const read = await grants.readTaskGrant(taskId);
    if (!read.grant || !read.commit) missing('verified TG1 owner is absent; no Provider factory can run');
    if (read.grant.owner !== principalOwner) missing('the current grant does not authorize the actual verified execution origin');
    return admission;
  }
  /**
   * The typed Provider tool request names its actual parent execution. Resolve
   * that retained R1 allocation through the existing prepared-journal owner
   * seam; the request never supplies the parent identity itself.
   */
  function resolveToolParentAllocation(request: Parameters<ProviderToolExecutionPort['execute']>[0]): RuntimeExecutionAllocation {
    const records = input.preparedJournal.replay().filter((record) => record.kind === 'operation.prepared'
      && record.allocation.operationId.value === request.execution.operationId.value);
    if (records.length !== 1) missing('the Provider tool request parent execution has no single retained prepared allocation');
    const prepared = records[0];
    if (!prepared || prepared.kind !== 'operation.prepared') missing('the Provider tool request parent execution is not a retained prepared allocation');
    return prepared.allocation;
  }
  async function admitExecution(allocation: RuntimeExecutionAllocation) {
    await (await owner(allocation.taskId)).admitExecution(allocation);
  }
  async function readColdExecutionSource(value: { readonly allocation: RuntimeExecutionAllocation; readonly request: RuntimeColdExecutionSourceRequest }) {
    await owner(value.allocation.taskId);
    if (!input.retryJournal) missing('the actual retry-cycle journal owner is unbound for cold source resolution');
    return readColdSource({ preparedJournal: input.preparedJournal, journalPath: input.filePath, journal: input.journal,
      artifactsRoot: input.artifactsRoot, retryJournal: input.retryJournal }, value);
  }
  const admitSegment: ResumeActiveTurnSegmentInput['admit'] = async (intent) => {
    try {
      const admitted = await owner(intent.binding.assignment.taskId);
      const requestRef = `segment-open:${intent.businessTurnRef.businessTurnId}:${intent.segmentId}`;
      const inputIdentity = { requestRef, digest: `sha256:${createHash('sha256').update(canonicalJsonStringify(intent)).digest('hex')}` };
      const request = { requestRef, taskId: intent.binding.assignment.taskId,
        owner: principalOwner, capability: { actionId: TASK_EXECUTION_ACTION_ID,
          capabilities: [TASK_EXECUTION_CAPABILITY], scope: { organId: intent.binding.scope.organId, taskId: intent.binding.assignment.taskId } },
        inputIdentity };
      return await admitted.admitNewBusiness({ request, register: async (authority, registration) => ({
        authorized: true as const, authorityCommitRef: authority.commit,
        businessRegistrationCommitRef: await registration.registerBusiness({ ...request, owner: authority.owner,
          grantRevision: authority.grant.revision }), requestRef, inputIdentity }) });
    } catch (error) {
      if (error instanceof TaskGrantDeniedError) return { authorized: false, reason: error.message };
      throw error;
    }
  };
  async function readIncarnationBinding(source: RuntimeColdExecutionSource): Promise<{
    readonly request: Parameters<typeof AgentLoopRuntime.resumeIncarnation>[0]; readonly contextHistory: typeof context;
  }> {
    const grant = await grants.readTaskGrant(source.allocation.taskId);
    if (!grant.grant || !grant.commit || grant.grant.state !== 'granted' || grant.grant.owner !== principalOwner) {
      missing('current grant cannot authorize the actual cold incarnation');
    }
    if (source.current.context.loopControl.mode !== 'observation') missing('actual execution factory does not support the retained first mode');
    const selected = await input.prepareAgentProvider({ roleId: source.allocation.role ?? 'execution',
      ...(source.allocation.configuredAgentId === undefined ? {} : { configuredAgentId: source.allocation.configuredAgentId }) });
    try {
      if (selected.roleId !== 'execution') missing('actual cold Provider selection does not bind the execution role');
      return { contextHistory: context, request: { role: 'execution', mode: 'observation',
        profiles: [{ profileId: 'task-execution-context', role: 'execution', mode: 'observation',
          observationScopes: ['task'], observationCapabilities: ['read-task'], orchestrationScope: 'local',
          orchestrationCapabilities: [], capabilityDigest: selected.binding.capabilityDigest }],
        budget: { maxModeTransitions: 4, maxObservationScopes: 4, maxContextReplacements: 4, maxDeferredEvents: 4 },
        permissionRevision: String(grant.grant.revision), observationStreamId: source.current.context.loopControl.inboxStreamId,
        now: input.now, turn: { identity: projectAdmittedTurnIdentityV1(source.initial.body.binding.admittedTurn),
          cycleId: source.allocation.scope.cycleId!, directiveRevision: source.allocation.directiveRevision,
          ownerId: source.allocation.ownerId, journal: nativeCheckpoints, closurePort: closures } } };
    } finally { await closeAgentProvider(selected); }
  }
  async function createExecutionDriver(allocation: RuntimeExecutionPreparationInput): Promise<RuntimeExecutionDriver> {
    const execution = await prepareExecution(allocation);
    if ('finishBoundary' in execution) missing('normal generation cannot resolve a boundary-only lifecycle');
    return execution;
  }
  async function createResumedExecutionDriver(value: {
    readonly source: RuntimeColdExecutionSource; readonly allocation: RuntimeExecutionAllocation;
    readonly segment: ResumedTurnSegmentOpened; readonly loop: AgentLoopRuntime;
  }): Promise<RuntimeExecutionDriver & { readonly standardTurn: StandardTurnLifecycle }> {
    if (canonicalJsonStringify(value.source.allocation) !== canonicalJsonStringify(value.allocation)) missing('cold source allocation conflicts');
    const execution = await prepareExecution({ ...value.allocation, attemptExecutionEpoch: value.segment.binding.execution.executionEpoch,
      attemptBindingId: value.segment.segmentId }, { source: value.source, loop: value.loop, segment: value.segment });
    if ('finishBoundary' in execution) missing('generation-ready preparation unexpectedly resolved a boundary lifecycle');
    if (!execution.standardTurn) missing('resumed generation driver has no standard-turn port');
    return execution as RuntimeExecutionDriver & { readonly standardTurn: StandardTurnLifecycle };
  }
  /**
   * Read-only exact reconstruction of the original durable turn. It selects the
   * current committed context and the original admitted-turn identity, so the
   * boundary classification and alignment reuse the real `AgentLoopRuntime`
   * machine without acquiring an instance or publishing a successor context.
   */
  async function coldLoop(source: RuntimeColdExecutionSource): Promise<AgentLoopRuntime> {
    const grant = await grants.readTaskGrant(source.allocation.taskId);
    if (!grant.grant || !grant.commit || grant.grant.owner !== principalOwner) {
      missing('the current grant does not authorize the original durable turn');
    }
    const mode = source.current.context.loopControl.mode;
    const selected = await input.prepareAgentProvider({ roleId: source.allocation.role ?? 'execution',
      ...(source.allocation.configuredAgentId === undefined ? {} : { configuredAgentId: source.allocation.configuredAgentId }) });
    try {
      return await AgentLoopRuntime.restore({ role: 'execution', mode,
        profiles: [{ profileId: 'task-execution-context', role: 'execution', mode,
          observationScopes: ['task'], observationCapabilities: ['read-task'], orchestrationScope: 'local',
          orchestrationCapabilities: [], capabilityDigest: selected.binding.capabilityDigest }],
        budget: { maxModeTransitions: 4, maxObservationScopes: 4, maxContextReplacements: 4, maxDeferredEvents: 4 },
        agentRuntimeId: source.current.context.agentRuntimeId, scope: source.scope,
        executionEpoch: projectAdmittedTurnIdentityV1(source.initial.body.binding.admittedTurn).executionEpoch,
        permissionRevision: String(grant.grant.revision),
        observationStreamId: source.current.context.loopControl.inboxStreamId, now: input.now,
        turn: { identity: projectAdmittedTurnIdentityV1(source.initial.body.binding.admittedTurn),
          cycleId: source.allocation.scope.cycleId!, directiveRevision: source.allocation.directiveRevision,
          ownerId: source.allocation.ownerId, journal: nativeCheckpoints, closurePort: closures } },
        context, source.scope, source.current.position.contextCommitRef);
    } finally { await closeAgentProvider(selected); }
  }
  async function recoverOriginalTurn(value: { readonly source: RuntimeColdExecutionSource }): Promise<RuntimeColdTurnPreparation> {
    const source = value.source;
    const identity = projectAdmittedTurnIdentityV1(source.initial.body.binding.admittedTurn);
    const retained = await closures.read(frozenTurnCloseRef(identity));
    const verification = await input.journal.verify();
    if (!verification.valid) missing(verification.error ?? 'exact recovery Journal verification failed');
    const position = verification.records.find((entry) => entry.commitId === source.current.position.checkpointCommitRef.commitId);
    const selected = retained && 'closureKind' in retained && retained.closureKind === 'turn-recovery'
      ? retained.checkpointId : position?.checkpoint?.id ?? null;
    const loop = await coldLoop(source);
    const recovery = await loop.recoverTurn(undefined, { checkpointId: selected });
    if (recovery.stage === 'unknown') {
      return { kind: 'unknown-held', turnId: identity.turnId, reason: 'exact original turn stage is unknown', recovery };
    }
    const frozen = loop.retainedTurnClose();
    if (recovery.stage === 'closure-absent') {
      if (frozen === null && recovery.recovery === undefined) return { kind: 'generation-ready', turnId: identity.turnId };
      if (frozen === null) return { kind: 'unknown-held', turnId: identity.turnId, reason: 'exact original frozen close candidate is absent', recovery };
    }
    if (frozen === null) {
      return { kind: 'unknown-held', turnId: identity.turnId, reason: 'exact original frozen close candidate is absent', recovery };
    }
    if (!frozen.bound || !(await readCheckpointClosurePreparation(closures, frozen.checkpoint))) {
      return { kind: 'unknown-held', turnId: identity.turnId, reason: 'exact original bound closure preparation is absent', recovery };
    }
    let segmentSource: NativeSegmentSaveSourceV2 | undefined;
    if (frozen.checkpoint.executionEpoch !== identity.executionEpoch) {
      const matching = source.segments.filter((segment) => segment.binding.execution.executionEpoch === frozen.checkpoint.executionEpoch);
      if (matching.length !== 1) return { kind: 'unknown-held', turnId: identity.turnId, reason: 'exact historical segment execution is unavailable', recovery };
      segmentSource = await readCommittedNativeSegmentSource({ journal: input.journal,
        originalAdmittedTurn: source.initial.body.binding.admittedTurn, opened: matching[0]! });
    }
    const boundaryId = segmentSource ? `segment-close:${segmentSource.opened.segmentId}` : `execution-close:${source.allocation.operationId.value}`;
    const key = { turn: identity, boundaryId, checkpoint: { id: frozen.checkpoint.id, scope: frozen.checkpoint.scope },
      ...(segmentSource === undefined ? {} : { version: 2 as const,
        segment: { segmentId: segmentSource.opened.segmentId, openedCommitRef: segmentSource.openedCommitRef } }) };
    const complete = await createJsonlNativeSaveProgressPort({ journal: input.journal }).readIntentExact!(key);
    if (complete.state !== 'found') return { kind: 'unknown-held', turnId: identity.turnId, reason: `exact immutable native intent is ${complete.state}`, recovery };
    if (canonicalJsonStringify(complete.intent.checkpoint.checkpoint) !== canonicalJsonStringify(frozen.checkpoint)) {
      return { kind: 'unknown-held', turnId: identity.turnId, reason: 'exact native intent conflicts with the frozen close candidate', recovery };
    }
    if (segmentSource && (!('source' in complete.intent) || canonicalJsonStringify(complete.intent.source) !== canonicalJsonStringify(segmentSource))) {
      return { kind: 'unknown-held', turnId: identity.turnId, reason: 'immutable native intent does not bind the exact historical physical segment', recovery };
    }
    const lifecycle = await prepareExecution({ ...source.allocation,
      attemptExecutionEpoch: frozen.checkpoint.executionEpoch, attemptBindingId: boundaryId },
      { source, loop, ...(segmentSource === undefined ? {} : { segment: segmentSource.opened }), retainedIntent: complete.intent });
    if (!('finishBoundary' in lifecycle)) missing('boundary preparation resolved a generation driver');
    const execution = { runtimeId: segmentSource?.opened.binding.execution.runtimeId ?? source.current.context.agentRuntimeId,
      executionEpoch: frozen.checkpoint.executionEpoch };
    if (recovery.stage === 'closure-absent') {
      return { kind: 'exact-pending-boundary', execution, key, standardTurn: lifecycle.standardTurn,
        finishBoundary: lifecycle.finishBoundary };
    }
    return { kind: 'committed-close-alignment',
      stage: recovery.stage === 'alignment-committed' ? 'alignment-committed' : 'closure-committed-alignment-absent',
      execution, key, standardTurn: lifecycle.standardTurn, finishBoundary: lifecycle.finishBoundary };
  }
  async function prepareExecution(allocation: RuntimeExecutionPreparationInput, resume?: {
    readonly source: RuntimeColdExecutionSource; readonly loop: AgentLoopRuntime;
    readonly segment?: ResumedTurnSegmentOpened; readonly retainedIntent?: NativeSaveIntent;
  }): Promise<RuntimeExecutionDriver | StandardTurnBoundaryLifecycle> {
    const { attemptExecutionEpoch: _attemptEpoch, attemptBindingId: _attemptBinding, ...identity } = allocation;
    const retainedIntent = resume?.retainedIntent;
    const segment = resume?.segment;
    const admitted = await owner(allocation.taskId);
    const segmentSource: NativeSegmentSaveSourceV2 | undefined = retainedIntent
      ? 'source' in retainedIntent ? retainedIntent.source : undefined : segment === undefined ? undefined
      : await readCommittedNativeSegmentSource({ journal: input.journal,
        originalAdmittedTurn: resume!.source.initial.body.binding.admittedTurn, opened: segment });
    const physical = segmentSource?.opened.binding.execution ?? { runtimeId: allocation.runtimeId, executionEpoch: allocation.attemptExecutionEpoch };
    const binding = segmentSource && !retainedIntent ? await admitted.bindCommittedSegment(identity, segmentSource, input.now().toISOString())
      : await admitted.bindingFor(allocation);
    const prepared = admitted.preparedInput(identity);
    if (resume && canonicalJsonStringify(prepared) !== canonicalJsonStringify(resume.source.preparedInput)) {
      missing('cold source input differs from the exact retained prepared input');
    }
    const grant = await grants.readTaskGrant(allocation.taskId);
    if (!grant.grant || !grant.commit || (!retainedIntent && grant.grant.state !== 'granted')) missing('current grant is unavailable before selected factory');
    // The declared authority scope is the grant's own scope, not the physical
    // closure scope (which also carries the cycle and operation).
    const declaredCapabilityScope = grant.grant.capability.scope;
    const composition = retainedIntent ? undefined : await input.prepareAgentProvider({ roleId: allocation.role ?? 'execution',
      ...(allocation.configuredAgentId === undefined ? {} : { configuredAgentId: allocation.configuredAgentId }) });
    try {
      // The admitted executor is built only after the durable A2 release edge:
      // the verified principal, current grant adapter, real boundary and clock
      // all come from the actual admission owner, never a request payload.
      const toolScope = input.providerToolScope;
      const providerToolExecutor = toolScope === undefined ? undefined : createResponsesFileToolExecutor({
        workspaceRoot: toolScope.workspaceRoot, projectKey: toolScope.projectKey, artifactRoot: toolScope.artifactRoot,
        ...(toolScope.webSearchProviderConfig === undefined ? {} : { webSearchProviderConfig: toolScope.webSearchProviderConfig }),
        admission: {
          organJournal: input.journal,
          currentTaskGrantPort: admitted.permissions,
          principalOwner,
          resourceBoundary: input.resourceBoundary,
          bindingFor: async (request) => {
            const parent = resolveToolParentAllocation(request);
            if (segment === undefined) return admitted.bindingFor(parent);
            if (canonicalJsonStringify(parent) !== canonicalJsonStringify(identity)
              || request.execution.runtimeId !== physical.runtimeId || request.execution.executionEpoch !== physical.executionEpoch
              || !(await resume!.source.segmentJournal.readSegmentRecords({ businessTurnId: segment.businessTurnRef.businessTurnId,
                segmentId: segment.segmentId })).some((entry) => entry.kind === 'request'
                  && entry.record.request.requestId === request.requestId)) missing('new tool request lacks its exact segment request registration');
            return binding;
          },
          admitToolOperation: admitted.admitToolOperation,
          now: input.now,
        },
      });
      const objective = prepared.input.prompt;
      if (typeof objective !== 'string') missing('prepared execution input has no immutable prompt');
      const assignment: WorkAssignment = resume?.source.assignment ?? { assignmentId: allocation.assignmentId, taskId: allocation.taskId,
        pipelineNodeId: 'pipeline.execute', attempt: 1, executionEpoch: allocation.attemptExecutionEpoch,
        inputRevision: allocation.inputRevision, objective, targetRefs: allocation.inputRefs, expectedOutputRefs: [],
        acceptanceCriteriaDigest: executionAdmissionInputDigest(identity, prepared),
        successCriteria: ['standard turn closure and canonical Planner alignment'],
        failureCriteria: ['execution error'], incompleteCriteria: ['standard turn or Planner alignment remains pending'],
        requiredCapabilities: grant.grant.capability.capabilities, mergeGate: 'not-required' };
      const turnId = resume?.source.initial.body.binding.admittedTurn.turnId ?? newActiveTurnId(allocation.operationId.value);
      const currentTurnRef = `active-turn://${turnId}`;
      const recoveryStateRef = admitted.evidence(allocation, binding.admissionCommitRef.commitId);
      const admittedTurn = resume?.source.initial.body.binding.admittedTurn ?? produceAdmittedTurn({ runtime: { runtimeId: allocation.runtimeId,
        executionEpoch: allocation.attemptExecutionEpoch, ownerRef: grant.grant.owner,
        permissionRevision: String(grant.grant.revision) }, taskId: allocation.taskId, scope: allocation.scope,
        assignment, directiveRevision: allocation.directiveRevision, turnId, currentTurnRef,
        admissionEvidence: [admitted.evidence(allocation, binding.admissionCommitRef.commitId)], recoveryStateRef });
      const activeTurnJournal = createJsonlActiveTurnJournal({ filePath: input.filePath, turnId });
      // A boundary-only continuation owns no live Provider and opens no new
      // active-turn/segment context; only generation installs one.
      const active = segment !== undefined
        ? await ActiveTurnSegmentContext.open({ port: resume!.source.segmentJournal, segment,
          initialInput: resume!.source.initial.body.initialInput })
        : retainedIntent !== undefined ? undefined : await ActiveTurnContext.open({ journal: activeTurnJournal, currentTurnRef,
          binding: { admittedTurn, assignment, execution: { runtimeId: allocation.runtimeId,
            executionEpoch: allocation.attemptExecutionEpoch }, scope: allocation.scope } });
      const recovery = createNativeRecoveryAssets({ journalPath: input.filePath, journal: input.journal, assetRoot: input.artifactsRoot });
      if (active instanceof ActiveTurnContext) await active.registerInitialInput(await recovery.writeInitialInput({ scope: allocation.scope, turnId, rawInput: objective }));
      const nativeAdmission = active === undefined ? undefined : active instanceof ActiveTurnContext ? { version: 1 as const, activeTurn: active }
        : { version: 2 as const, activeTurn: active, segmentJournal: resume!.source.segmentJournal, source: segmentSource! };
      const readLivePrefix = () => active === undefined ? missing('a boundary-only continuation has no live prefix')
        : active instanceof ActiveTurnContext ? active.readLivePrefix(currentTurnRef) : active.readLivePrefix();
      const loop = resume?.loop ?? await AgentLoopRuntime.start({ agentRuntimeId: allocation.runtimeId, role: 'execution', mode: 'observation',
        profiles: [{ profileId: 'task-execution-context', role: 'execution', mode: 'observation',
          observationScopes: ['task'], observationCapabilities: ['read-task'], orchestrationScope: 'local',
          orchestrationCapabilities: [], capabilityDigest: composition!.binding.capabilityDigest }],
        budget: { maxModeTransitions: 4, maxObservationScopes: 4, maxContextReplacements: 4, maxDeferredEvents: 4 },
        scope: allocation.scope, executionEpoch: allocation.attemptExecutionEpoch, permissionRevision: String(grant.grant.revision),
        observationStreamId: `execution:${allocation.operationId.value}`, now: input.now,
        turn: { identity: projectAdmittedTurnIdentityV1(admittedTurn), cycleId: allocation.scope.cycleId!, directiveRevision: allocation.directiveRevision,
          ownerId: allocation.ownerId, journal: nativeCheckpoints, closurePort: closures },
        activeRefs: allocation.inputRefs, omittedRefs: [], durableContext: {
          stablePrefix: [objective], indexRefs: allocation.inputRefs, dynamicHead: [binding.admissionCommitRef.commitId], repairRefs: [] } }, context);
      const timeAuthority = { source: 'harness' as const, owner: 'runtime-checkpoint-control-owner' as const,
        authorityRef: `execution:${allocation.operationId.value}`, sampleCommittedAt: async () => input.now().toISOString() };
      // The bound standard-turn end action. The model reaches it through the
      // actual advertised tool surface; the executor validates the semantic
      // summary/delivery against the trusted admitted turn and routes the
      // accepted command to this caller. It never completes the Task and never
      // self-drains. The caller acts on the accepted command only after the
      // real request drain.
      let acceptedEnd: StandardTurnEndCommand | undefined;
      const endOwner: StandardTurnEndOwnerPort = {
        async resolveBoundTurn({ execution }) {
          if (execution.runtimeId !== physical.runtimeId
            || execution.executionEpoch !== physical.executionEpoch
            || execution.taskId.value !== allocation.taskId.value
            || execution.operationId.value !== allocation.operationId.value) return null;
          return projectAdmittedTurnIdentityV1(admittedTurn);
        },
        ...(segment === undefined ? {} : { async resolveSegmentBinding({ requestId }: Parameters<NonNullable<StandardTurnEndOwnerPort['resolveSegmentBinding']>>[0]) {
          const record = (await resume!.source.segmentJournal.readSegmentRecords({ businessTurnId: turnId,
            segmentId: segment.segmentId })).find((entry) => entry.kind === 'request' && entry.record.request.requestId === requestId);
          return record?.kind === 'request' ? { source: segmentSource!, request: record.record } : null;
        } }),
        async resolveDelivery({ deliveryRefs }) {
          // Delivery references are the model's claims; they only count when they
          // resolve to real evidence scoped to this admitted turn. The admission
          // evidence and every accepted tool-result evidence are the actual
          // candidates; a foreign or missing reference rejects.
          const prefix = await readLivePrefix();
          const candidates: EvidenceRef[] = [admitted.evidence(allocation, binding.admissionCommitRef.commitId)];
          for (const entry of prefix.entries) {
            if (!('envelope' in entry)) continue;
            const fact = entry.envelope.fact;
            if (fact.kind !== 'tool-result') continue;
            for (const ref of fact.result.evidenceRefs) candidates.push(ref);
          }
          const byReference = new Map<string, EvidenceRef>();
          for (const ref of candidates) {
            byReference.set(ref.evidenceId.value, ref);
            byReference.set(ref.locator, ref);
          }
          const resolved: EvidenceRef[] = [];
          for (const reference of deliveryRefs) {
            const match = byReference.get(reference);
            if (!match || match.scope.taskId?.value !== allocation.scope.taskId?.value) {
              throw new StandardTurnEndError(
                'standard-turn-end.delivery-unresolved',
                `delivery reference ${reference} does not resolve to evidence scoped to this admitted turn`,
              );
            }
            resolved.push(match);
          }
          return resolved;
        },
      };
      const endExecutor = createStandardTurnEndWireExecutor(endOwner, createStandardTurnEndExecutor({
        owner: endOwner,
        route: (command) => { acceptedEnd = command; },
      }));
      const providerToolExecution = {
            tools: [...(toolScope?.tools ?? input.providerOptions.tools ?? []), ADVERTISED_STANDARD_TURN_END_TOOL],
            executeTool: {
              execute: (request: Parameters<ProviderToolExecutionPort['execute']>[0]) => {
                if (isStandardTurnEndCall(request.call.toolId)) return endExecutor.execute(request);
                const executor = providerToolExecutor?.executor ?? input.providerOptions.executeTool;
                if (!executor) missing('the advertised tool has no admitted executor');
                return executor.execute(request);
              },
            } satisfies ProviderToolExecutionPort,
          };
      const boundaryId = retainedIntent?.key.boundaryId ?? (segment ? `segment-close:${segment.segmentId}` : `execution-close:${allocation.operationId.value}`);
      let saveIntent: NativeSaveIntent | undefined = retainedIntent;
      let closingCheckpoint: import('../../../contracts/src/index.js').Checkpoint | undefined = retainedIntent?.checkpoint.checkpoint;
      let closingInput: import('../../../runtime/src/agent-loop/runtime.js').CloseTurnInput | undefined;
      let acceptedReviewRefs: readonly import('../../../contracts/src/index.js').JournalCommitRef[] = retainedIntent ? loop.retainedTurnClose()!.reviewCommitRefs : [];
      let native: ReturnType<typeof createNativeExecution> | ReturnType<typeof createNativeBoundaryContinuation>;
      const owners = retainedIntent ? undefined : createExecutionOwnerReaders({ admitted: nativeAdmission!,
        execution: { ...physical, taskId: allocation.taskId, operationId: allocation.operationId },
        boundaryId, journal: input.journal, currentState: input.currentState, grants, control: admitted.gateway,
        completion, checkpoints, fullContext: context,
        progress: { readExact: (key) => native.saveProgress.readExact(key),
          begin: (value) => native.saveProgress.begin(value),
          recordProgress: (value) => native.saveProgress.recordProgress(value) },
        saveKey: () => {
          if (!closingCheckpoint) missing('capture has no actual closing checkpoint candidate');
          return { turn: projectAdmittedTurnIdentityV1(admittedTurn), boundaryId,
            checkpoint: { scope: closingCheckpoint.scope, id: closingCheckpoint.id },
            ...(segmentSource === undefined ? {} : { version: 2 as const,
              segment: { segmentId: segmentSource.opened.segmentId, openedCommitRef: segmentSource.openedCommitRef } }) };
        }, saveIntent: () => saveIntent,
        savePorts: Object.fromEntries(['recovery-assets', 'checkpoint', 'closure', 'context-view', 'history-publication'].map((phase) => [phase, {
          readExact: (intent: import('../../../runtime/src/checkpoints/native-save-contract.js').NativeSaveIntent) => native.savePorts[phase as keyof typeof native.savePorts].readExact(intent),
          commit: (intent: import('../../../runtime/src/checkpoints/native-save-contract.js').NativeSaveIntent) => native.savePorts[phase as keyof typeof native.savePorts].commit(intent),
        }])) as import('../../../runtime/src/checkpoints/native-save-contract.js').NativeSavePorts,
      });
      const history = createJsonlSemanticHistoryJournal({ filePath: input.filePath, journal: input.journal,
        artifactsRoot: input.artifactsRoot, activeTurnJournal, rawContent, timeAuthority,
        ...(segment === undefined ? {} : { segmentJournal: resume!.source.segmentJournal }) });
      const priorCompletedTurns = await history.listCompletedTurnLookups(allocation.scope);
      native = retainedIntent ? createNativeBoundaryContinuation({ intent: retainedIntent, segmentJournal: resume!.source.segmentJournal,
        journal: input.journal, filePath: input.filePath, artifactsRoot: input.artifactsRoot, activeTurnJournal,
        rawContent, timeAuthority, completionJournal: completion }) : createNativeExecution({ admitted: nativeAdmission!,
        journal: input.journal, filePath: input.filePath, artifactsRoot: input.artifactsRoot, activeTurnJournal,
        rawEvidence, rawContent, fullContext: context, completionJournal: completion, now: input.now, rules: [],
        priorCompletedTurns, timeAuthority,
        orientation: async () => undefined,
        owners: owners!,
        provider: { ...input.providerOptions, ...providerToolExecution,
          port: composition!.port, binding: composition!.binding,
          ...physical, taskId: allocation.taskId, operationId: allocation.operationId, assignmentId: allocation.assignmentId,
          scope: allocation.scope, inputRefs: allocation.inputRefs, ownerId: allocation.ownerId },
      });
      if (retainedIntent) {
        const frozen = loop.retainedTurnClose();
        if (!frozen) missing('historical lifecycle has no restored frozen candidate');
        closingInput = { ...frozen.inputs, reviewCommitRefs: frozen.reviewCommitRefs,
          ...(frozen.bound ? { prepareCheckpointClosure: (checkpoint: import('../../../contracts/src/index.js').Checkpoint) =>
            native.prepareTurnClosure(checkpoint, boundaryId) } : {}) };
      }
      turnFacts.set(allocation.taskId.value, { loop, native });
      async function publishLifecycle(status: import('../../../contracts/src/index.js').OperationStatus,
        kind: import('../../../contracts/src/index.js').OperationEventKind, evidenceRefs: readonly import('../../../contracts/src/index.js').EvidenceRef[],
        result?: import('../../../contracts/src/index.js').OperationResult) {
        const control = await admitted.gateway.readControl({ scope: allocation.scope, agentRuntimeId: physical.runtimeId,
          harnessExecutionEpoch: physical.executionEpoch });
        if (control.state !== 'complete') missing('actual parent lifecycle control is unknown');
        const parent = control.operations.find((item) => item.intent.operationId.value === allocation.operationId.value);
        if (!parent) missing('actual parent lifecycle record is absent');
        await admitted.gateway.applyExternalLifecycle({ control: { ...parent, status,
          ...(result === undefined ? {} : { result }) }, event: {
          eventId: `provider-${kind}:${allocation.operationId.value}`, schemaVersion: 1, kind,
          operationId: allocation.operationId, taskId: allocation.taskId, executionEpoch: parent.executionEpoch,
          status, occurredAt: input.now().toISOString(), evidenceRefs } });
      }
      async function closeCanonicalTurn() {
        if (!closingInput) missing('native close has no drained frozen standard-end input');
        const close = await loop.closeTurn(closingInput);
        await input.publishCurrentTurnState(allocation.taskId);
        if (close.state !== 'closed-awaiting-planner-alignment') missing(`canonical turn closure retains recovery: ${close.firstErrorRef}`);
        if (!closingCheckpoint || canonicalJsonStringify(closingCheckpoint) !== canonicalJsonStringify(close.checkpoint)) {
          missing('canonical close returned a different or unprepared closing checkpoint');
        }
        return close;
      }
      async function saveBoundary() {
        await closeCanonicalTurn();
        if (saveIntent) {
          const saved = await native.save(saveIntent);
          if (saved.state !== 'complete') throw new AppLifecycleError('execution.native-save.pending',
            `native save is ${saved.state}: ${canonicalJsonStringify(saved)}`,
            'recover the same boundary through its recorded owner stage', allocation.ownerId);
          return;
        }
        const captured = await native.prepareCapture(boundaryId);
        if (!closingCheckpoint) missing('native save requires the frozen closing checkpoint');
        const committed = await checkpoints.readCommitted(closingCheckpoint.scope, closingCheckpoint.id);
        if (!committed) missing('native save requires the actual coordinator checkpoint');
        const checkpoint = committed.checkpoint;
        if (canonicalJsonStringify(checkpoint) !== canonicalJsonStringify(closingCheckpoint)) {
          missing('native save closing checkpoint exact readback conflicts');
        }
        const relationship = await checkpoints.readNativeCheckpoint({ checkpoint: { scope: allocation.scope, id: checkpoint.id } });
        if (!relationship) missing('native save requires the canonical native checkpoint receipt');
        const turn = projectAdmittedTurnIdentityV1(admittedTurn);
        const key = { turn, boundaryId, checkpoint: { id: checkpoint.id, scope: checkpoint.scope } };
        const semanticKey = { turn, checkpoint: key.checkpoint };
        const facts = captured.prepared.recovery;
        if (!acceptedEnd) missing('native semantic view has no accepted four-part turn end');
        const adoptedChildren: AdoptedChildSourceV1[] = [];
        const childRecords = segment ? await resume!.source.segmentJournal.readSegmentRecords({ businessTurnId: turnId,
          segmentId: segment.segmentId }) : await activeTurnJournal.replay();
        for (const entry of captured.prepared.body.entries) {
          if ('envelope' in entry) continue;
          const invocation = captured.prepared.body.childInvocations.find((item) => item.invocationId === entry.invocationId
            && item.adoptedResultSeq === entry.seq);
          if (!invocation) missing('native save child refinement has no actual adopted invocation');
          const source: AdoptedChildSourceV1 = { parentTurn: turn, invocationId: entry.invocationId,
            childTurnId: invocation.childTurnId, deliverySeq: entry.seq, kind: entry.kind,
            adoptionCommitId: segment ? activeTurnSegmentCommitId(segment.segmentId, `adopted:${entry.invocationId}`)
              : activeTurnCommitId(turn.turnId, `adopted:${entry.invocationId}`),
            deliveryCommitId: segment ? activeTurnSegmentCommitId(segment.segmentId, `delivery:${entry.invocationId}`)
              : activeTurnCommitId(turn.turnId, `delivery:${entry.invocationId}`),
            refinedDelivery: entry.refinedDelivery, preCallCheckpointRef: invocation.checkpointReceiptRef,
            ...(invocation.postReviewCheckpointRef === undefined ? {} : { postReviewCheckpointRef: invocation.postReviewCheckpointRef }) };
          if (!segment) await materializeAdoptedChildSource({ source, records: childRecords, rawContent });
          adoptedChildren.push(source);
        }
        const intent: NativeSaveIntentV1 = {
          key, ownerId: allocation.ownerId, inputIntentDigest: executionAdmissionInputDigest(identity, prepared),
          recoveryResponsibilityRef: facts.recoveryResponsibilityRef, unresolvedOperationRefs: facts.unresolvedOperationRefs,
          rawTurnRefs: facts.rawTurnRefs, laterErrorRefs: facts.laterErrorRefs,
          recoveryAssets: { turnId, boundaryId, captureRef: captured.captureRef },
          checkpoint: { checkpoint, timeAuthority: relationship.receipt.timeAuthority,
            previousCheckpointId: checkpoint.previousCheckpointId, acceptedAt: captured.prepared.body.cut.frozenAt },
          closure: { closureId: `checkpoint-closure:${checkpointCommitId(checkpoint)}`, checkpoint: key.checkpoint,
            source: 'harness-control', closureSummary: checkpoint.summary, closureEvidenceRefs: checkpoint.evidenceRefs },
          contextView: { key: semanticKey, accepted: { version: 1, admittedTurn, checkpoint: relationship,
            acceptance: { ownerId: allocation.ownerId, acceptanceRef: relationship.receipt.commitIdentity,
              sourceEvidenceRefs: checkpoint.evidenceRefs },
            semantics: { goal: acceptedEnd.summary.goal.text, actions: acceptedEnd.summary.actions.text,
              result: acceptedEnd.summary.result.text, nextStep: acceptedEnd.summary.expectedNextStep.text },
            adoptedChildren, recovery: { recoveryStateRef: admittedTurn.recoveryStateRef,
              recoveryResponsibilityRef: facts.recoveryResponsibilityRef, unresolvedOperationRefs: facts.unresolvedOperationRefs,
              laterErrorRefs: facts.laterErrorRefs } } },
          historyPublication: { key: semanticKey, exactLookup: { scope: allocation.scope, checkpoint: key.checkpoint,
            publicationReceiptRef: `history:${checkpoint.id.value}` } },
        };
        if (segmentSource) {
          const segmentIntent: NativeSegmentSaveIntentV2 = { key: { ...key, version: 2,
              segment: { segmentId: segmentSource.opened.segmentId, openedCommitRef: segmentSource.openedCommitRef } },
            source: segmentSource, ownerId: intent.ownerId, inputIntentDigest: intent.inputIntentDigest,
            recoveryResponsibilityRef: intent.recoveryResponsibilityRef, unresolvedOperationRefs: intent.unresolvedOperationRefs,
            rawTurnRefs: intent.rawTurnRefs, laterErrorRefs: intent.laterErrorRefs,
            recoveryAssets: { source: segmentSource, boundaryId, captureRef: captured.captureRef },
            checkpoint: intent.checkpoint, closure: intent.closure,
            contextView: { source: segmentSource, acceptance: intent.contextView.accepted.acceptance,
              semantics: intent.contextView.accepted.semantics,
              adoptedChildren: adoptedChildren.map((child) => ({ ...child, segmentId: segmentSource.opened.segmentId })),
              recovery: intent.contextView.accepted.recovery } };
          saveIntent = structuredClone(segmentIntent);
        } else saveIntent = structuredClone(intent);
        const saved = await native.save(saveIntent);
        if (saved.state !== 'complete') throw new AppLifecycleError('execution.native-save.pending',
          `native save is ${saved.state}: ${canonicalJsonStringify(saved)}`,
          'recover the same boundary through its recorded owner stage', allocation.ownerId);
      }
      let closed: Promise<import('../../../contracts/src/index.js').ProviderCloseResult> | undefined;
      let providerClosed: Promise<import('../../../contracts/src/index.js').ProviderCloseResult> | undefined;
      function closeOwnedProvider() {
        if (!('driver' in native)) missing('historical boundary has no owned live Provider');
        return providerClosed ??= native.driver.close();
      }
      let plannerInput: ClosedTurnPlannerCallInput | undefined;
      let revisionCall: Awaited<ReturnType<typeof configuredPlannerCall>> | undefined;
      let alignmentInFlight: Promise<import('../../../runtime/src/agent-loop/runtime.js').AdvanceTurnResult> | undefined;
      async function configuredPlannerCall(assignmentId: string) {
        const pool = input.closedTurnPlannerPool(allocation.taskId);
        const selected = await input.prepareAgentProvider({ roleId: 'orchestration' });
        if (selected.roleId !== 'orchestration' || !selected.configuredAgentId) {
          await closeAgentProvider(selected);
          missing('Planner requires the actual configured orchestration instance');
        }
        let invoked = false;
        let unusedClose: Promise<void> | undefined;
        const closeUnused = () => invoked ? Promise.resolve() : unusedClose ??= closeAgentProvider(selected);
        const handles = new Map<string, TaskInstanceHandle & { readonly planner: IndependentTurnPlannerPort }>();
        const duty = createClosedTurnPlannerCall({ ownerId: allocation.ownerId, principalOwner,
          roleId: selected.roleId, agentId: selected.configuredAgentId, assignmentId,
          requiredCapabilities: [TASK_EXECUTION_CAPABILITY], pool, taskGrant: grants, checkpoints,
          journal: plannerJournal, now: input.now,
          createInstance(create) {
            const handle = { incarnation: create.incarnation,
              planner: createIndependentTurnPlanner({ prepareAgentProvider: async () => selected, now: input.now }),
              async dispose() { handles.delete(create.incarnation.agentInstanceId); await closeUnused(); } };
            handles.set(create.incarnation.agentInstanceId, handle);
            return handle;
          } });
        function handleFor(instanceId: string) {
          const handle = handles.get(instanceId);
          if (!handle) missing('the actual leased Planner handle is absent');
          invoked = true;
          return handle.planner;
        }
        return { duty, closeUnused,
          plan: (value: Parameters<IndependentTurnPlannerPort['plan']>[0]) =>
            handleFor(value.preparedCall.incarnation.agentInstanceId).plan(value) };
      }
      async function alignClosedTurn() {
        await saveBoundary();
        if ('driver' in native) {
          const providerClose = await closeOwnedProvider();
          if (providerClose.state !== 'closed') missing('actual execution Provider must close before Planner');
        }
        if (!sameReviewCommitRefs(closingInput?.reviewCommitRefs, acceptedReviewRefs)) {
          throw new AppLifecycleError('execution.review-order.after-native-close',
            'completed dispatch reviews remain outside the already frozen native turn closure',
            'Runtime orchestration dispatch owner must accept ordered review receipts before the native close cut',
            'runtime.orchestration.dispatch');
        }
        const stage = await loop.recoverTurn();
        if (stage.stage === 'alignment-committed') {
          if (!stage.alignment) missing('committed alignment has no actual readback');
          return acceptAlignedPlan(stage.alignment);
        }
        if (stage.stage !== 'closure-committed-alignment-absent' || !stage.closure) {
          missing('closed-turn Planner requires the actual durable closure stage');
        }
        if (!plannerInput) {
          const current = await input.currentState.read({ organId: allocation.scope.organId, taskId: allocation.taskId });
          if (current.state !== 'known') missing('closed-turn Planner has no authoritative current Task');
          const taskScope = { organId: allocation.scope.organId, taskId: allocation.taskId };
          const identity = await input.taskIdentity.read(taskScope);
          if (!identity) missing('closed-turn Planner requires the actual confirmed Task identity');
          const basis = current.value.currentPlan
            ? { priorPlan: (await readCurrentTaskPlan({ plans, identity, currentPlan: current.value.currentPlan })).revision }
            : { priorPlan: null, identity } as const;
          const frozen = await native.prepareCapture(boundaryId);
          const refinedResults: import('../../../runtime/src/orchestration/task-flow-selector.js').TaskFlowRefinedResult[] = [];
          for (const entry of frozen.prepared.body.entries) {
            if ('envelope' in entry) continue;
            if (entry.kind === 'execution') refinedResults.push({ role: 'execution', assignmentId: entry.assignment.assignmentId,
              attempt: entry.assignment.attempt, status: entry.result.status === 'cancelled' ? 'incomplete' : entry.result.status,
              summary: entry.result.summary,
              outputRefs: entry.result.outputRefs, evidenceRefs: entry.result.evidenceRefs });
            else refinedResults.push({ role: 'review', assignmentId: entry.assignment.assignmentId,
              attempt: entry.assignment.attempt, status: entry.result.status === 'passed' ? 'succeeded' : 'failed',
              summary: `Review ${entry.result.status}: ${canonicalJsonStringify(entry.result.findings)}`,
              outputRefs: [entry.refinedDelivery.ref.locator], evidenceRefs: entry.result.evidenceRefs });
          }
          plannerInput = structuredClone({ task: current.value.task, closure: stage.closure, ...basis,
            refinedResults, allocation: { operationId: allocation.operationId, cycleId: allocation.scope.cycleId!,
              executionEpoch: allocation.executionEpoch },
            capabilityScope: declaredCapabilityScope,
            ...(segmentSource === undefined ? {} : { segmentSource }) });
        }
        // Resolve an already returned duty before selecting another Provider.
        // The Runtime duty itself enforces no duplicate unknown invocation.
        const dutyKey = closedTurnPlannerDutyKey(plannerInput);
        const stored = await plannerJournal.read(allocation.scope, dutyKey);
        const anchor = await checkpoints.readCommitted(allocation.scope, plannerInput.closure.checkpointId);
        if (!anchor) missing('closed-turn Planner exact checkpoint receipt is absent');
        const expectedDuty = deriveClosedTurnPlannerDuty(plannerInput, anchor.commitRef);
        if (stored && canonicalJsonStringify(stored.record.duty) !== canonicalJsonStringify(expectedDuty)) {
          missing('durable Planner duty conflicts with the frozen closed-turn inputs');
        }
        const history = await plans.list({ organId: allocation.scope.organId, taskId: allocation.taskId });
        const predecessorSequence = plannerInput.priorPlan?.sequence ?? 0;
        const unexplained = history.filter((revision) => revision.sequence > predecessorSequence
          && !(stored?.record.stage === 'returned' && revision.revisionId === stored.record.publication.revisionId));
        if (unexplained.length) missing(`unaccepted plan publication has no matching closed duty return: ${unexplained.map((revision) => revision.revisionId).join(', ')}`);
        let returned: ClosedTurnPlannerResult;
        if (stored?.record.stage === 'returned') {
          if (stored.record.kind !== 'closed-turn-planner-call') missing('closed-turn duty resolved a foreign initial Planner return');
          returned = { publication: stored.record.publication, decision: stored.record.decision };
        } else {
          if (stored?.record.stage === 'invoked') missing('submitted Planner outcome is unknown; retain the same duty without another call');
          if (stored?.record.stage === 'prepared' && !revisionCall) missing('prepared Planner lease is not revivable; reconcile the actual instance before Provider selection');
          revisionCall ??= await configuredPlannerCall(`planner:${stage.closure.identity.turnId}`);
          let outcome: Awaited<ReturnType<typeof revisionCall.duty.run>>;
          try {
            outcome = await revisionCall.duty.run(plannerInput, (preparedCall) => revisionCall!.plan({ ...plannerInput!, preparedCall }));
          } catch (error) {
            try { await revisionCall.closeUnused(); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Planner preparation and owned selection close failed'); }
            throw error;
          }
          if (outcome.state !== 'returned') {
            await revisionCall.closeUnused();
            revisionCall = undefined;
            missing(`closed-turn Planner remains ${outcome.state}: ${outcome.issue.reason}`);
          }
          returned = outcome.result;
        }
        const candidate = createPublishedTaskPlanRevision({ ...returned.publication,
          journalCommitRef: `planner-candidate:${returned.publication.revisionId}` });
        validateTaskPlanRevisionTransition(plannerInput.priorPlan, candidate);
        const existing = await plans.get(candidate.scope, candidate.revisionId);
        if (existing) assertTaskPlanRevisionRetryMatches(existing, candidate);
        const alignment = await loop.alignTurn({ consumer: plans, ...returned });
        if (alignment.state !== 'aligned') missing(`canonical Planner alignment retains recovery: ${alignment.firstErrorRef}`);
        return acceptAlignedPlan(alignment.alignment);
      }
      async function acceptAlignedPlan(alignment: import('../../../contracts/src/index.js').PlannerAlignmentReference) {
        const taskScope = { organId: allocation.scope.organId, taskId: allocation.taskId };
        const identity = await input.taskIdentity.read(taskScope);
        const receipt = await plans.getCommitRef(taskScope, alignment.planRevisionId);
        if (!identity || !receipt) missing('aligned current plan exact publication is absent');
        const exact = await readCurrentTaskPlan({ plans, identity,
          currentPlan: { revisionId: alignment.planRevisionId, revisionCommitRef: receipt } });
        if (exact.revision.contentDigest !== alignment.planContentDigest
          || exact.revision.sequence !== alignment.planRevisionSequence) missing('aligned current plan exact publication conflicts');
        const stage = await loop.recoverTurn();
        if (stage.stage !== 'alignment-committed' || !stage.closure) missing('current plan acceptance requires the exact committed turn closure and alignment');
        const current = await input.currentState.read(taskScope);
        if (current.state !== 'known') missing('aligned plan acceptance has no authoritative current Task');
        let predecessor: import('../../../contracts/src/index.js').PublishedTaskPlanRevision | null = null;
        if (exact.revision.predecessor !== null) {
          const predecessorReceipt = await plans.getCommitRef(taskScope, exact.revision.predecessor.revisionId);
          if (!predecessorReceipt) missing('aligned plan exact predecessor receipt is absent');
          predecessor = (await readCurrentTaskPlan({ plans, identity, currentPlan: {
            revisionId: exact.revision.predecessor.revisionId, revisionCommitRef: predecessorReceipt } })).revision;
        }
        validateTaskPlanRevisionTransition(predecessor, exact.revision);
        if (current.value.currentPlan) {
          const selected = await readCurrentTaskPlan({ plans, identity, currentPlan: current.value.currentPlan });
          if (selected.revision.revisionId !== exact.revision.revisionId
            && selected.revision.revisionId !== predecessor?.revisionId) missing('aligned publication cannot replace an unrelated accepted current plan');
        }
        const returnedDuty = await plannerJournal.read(allocation.scope, closedTurnPlannerDutyKey({
          task: current.value.task, closure: stage.closure, priorPlan: predecessor }));
        if (returnedDuty?.record.stage !== 'returned' || returnedDuty.record.decision !== alignment.decision) {
          missing('aligned plan has no exact durable Planner return');
        }
        assertTaskPlanRevisionRetryMatches(exact.revision, createPublishedTaskPlanRevision({
          ...returnedDuty.record.publication, journalCommitRef: exact.revision.journalCommitRef }));
        const anchor = await checkpoints.readCommitted(allocation.scope, stage.closure.checkpointId);
        if (!anchor || canonicalJsonStringify(returnedDuty.record.duty.checkpointCommitRef) !== canonicalJsonStringify(anchor.commitRef)
          || returnedDuty.record.duty.closureRef !== stage.closure.closureRef) missing('aligned durable return closing receipt conflicts');
        if (plannerInput && canonicalJsonStringify(returnedDuty.record.duty)
          !== canonicalJsonStringify(deriveClosedTurnPlannerDuty(plannerInput, anchor.commitRef))) missing('aligned durable return input binding conflicts');
        const keys = turnBoundaryRecordRefs(stage.closure.identity, stage.closure.checkpointId);
        const typedClosure = await closures.read(keys.turnClosureRef);
        if (!typedClosure || !('closureKind' in typedClosure) || typedClosure.closureKind !== 'turn-closure') {
          missing('review alignment requires the exact typed frozen turn closure');
        }
        if (!sameReviewCommitRefs(typedClosure.reviewCommitRefs, acceptedReviewRefs)) {
          missing('accepted dispatch reviews conflict with the frozen closure order');
        }
        const relationships = await readReviewedMilestoneBoundary({ identity: stage.closure.identity,
          checkpointId: stage.closure.checkpointId, reviewCommitRefs: acceptedReviewRefs,
          turnClosureRef: keys.turnClosureRef, alignmentRef: keys.alignmentRef,
          journal: input.i2Journal, checkpoints, closures, contexts: context, plans,
          nativeRecoveryAssets: native.recoveryAssetsReader });
        const related: import('../../../contracts/src/index.js').JournalCommitRef[] = [];
        for (const relationship of relationships) {
          const ref = await input.i2Journal.commit(relationship);
          const readback = await input.i2Journal.read(taskScope, ref);
          if (canonicalJsonStringify(readback) !== canonicalJsonStringify(relationship)) missing('review alignment exact relationship readback conflicts');
          related.push(ref);
        }
        if (related.length !== acceptedReviewRefs.length) missing('review alignment complete-list gate is incomplete');
        const facts = turnFacts.get(allocation.taskId.value)!;
        facts.currentPlan = exact.currentPlan;
        try {
          await input.publishCurrentTurnState(allocation.taskId);
          const accepted = await input.currentState.read(taskScope);
          if (accepted.state !== 'known' || !accepted.value.currentPlan
            || canonicalJsonStringify(accepted.value.currentPlan) !== canonicalJsonStringify(exact.currentPlan)) {
            missing('current plan conditional commit has no exact accepted readback');
          }
        } catch (error) {
          // Failed acceptance cannot become authority in a later error-state
          // publication. Recovery reads the durable alignment and retries it.
          if (current.value.currentPlan) facts.currentPlan = current.value.currentPlan;
          else delete facts.currentPlan;
          throw error;
        }
        if (!saveIntent) missing('aligned turn has no retained immutable native save intent');
        const publication = await native.savePorts['history-publication'].readExact(saveIntent);
        if (!publication) missing('next-turn context has no actual native history publication');
        const advance = loop.advanceTurn();
        return advance;
      }
      const standardTurn: NonNullable<RuntimeExecutionDriver['standardTurn']> = {
          async acceptReviews(refs) {
            const distinct = distinctReviewCommitRefs(refs);
            if (distinct.length !== refs.length) missing('dispatch accepted duplicate review receipts');
            if (closingInput && !sameReviewCommitRefs(acceptedReviewRefs, refs)) {
              acceptedReviewRefs = structuredClone(distinct);
              throw new AppLifecycleError('execution.review-order.after-native-close',
                'orchestration dispatch returned completed review receipts after execution settle/saveBoundary froze and committed the native turn closure',
                'Runtime orchestration dispatch owner must accept review receipts before the native close cut; retain completed reviews without mutating the closure',
                'runtime.orchestration.dispatch');
            }
            acceptedReviewRefs = structuredClone(distinct);
          },
          async readCheckpoint() {
            if (!closingCheckpoint) missing('standard turn has no frozen canonical closing checkpoint');
            const committed = await checkpoints.readCommitted(closingCheckpoint.scope, closingCheckpoint.id);
            if (!committed) missing('standard turn canonical closing checkpoint is not committed');
            return committed;
          },
          align() {
            if (alignmentInFlight) return alignmentInFlight;
            const pending = alignClosedTurn();
            alignmentInFlight = pending;
            const settled = () => { if (alignmentInFlight === pending) alignmentInFlight = undefined; };
            void pending.then(settled, settled);
            return pending;
          },
      };
      if (!('driver' in native)) return { standardTurn,
        async finishBoundary() {
          await saveBoundary();
          const capture = await native.prepareCapture(boundaryId);
          if (capture.captureRef !== retainedIntent!.recoveryAssets.captureRef) missing('historical capture exact readback conflicts');
        },
      };
      const liveNative = native;
      const driver: RuntimeExecutionDriver = { standardTurn,
        kind: liveNative.driver.kind, capabilities: () => liveNative.driver.capabilities(),
        start: (value) => liveNative.driver.start(value), resume: (value) => liveNative.driver.resume(value),
        async submit(value) {
          const submitted = await liveNative.driver.submit(value);
          await publishLifecycle('running', 'operation.started', submitted.evidenceRefs);
          return submitted;
        },
        async *observe(value) {
          // A transport finish is not a Task completion. While no bound standard
          // end has been accepted, the same logical turn continues with a fresh
          // causal request on the same binding; the actual retained Task dispatch
          // re-orients the model through request-scoped instructions only.
          while (true) {
            let completed = false;
            for await (const event of liveNative.driver.observe(value)) {
              if (event.terminalState !== undefined) completed = event.terminalState === 'succeeded';
              // Provider completion is transport truth. Standard-end and
              // alignment are still owed, so it is never read as terminal.
              yield event.terminalState === 'succeeded' ? { ...event, terminalState: 'waiting' as const } : event;
            }
            if (!completed) return;
            if (acceptedEnd !== undefined) return;
            await liveNative.continueCurrentTurn({ instructions: renderTaskReorientation(assignment) });
          }
        },
        requestStop: (value) => liveNative.driver.requestStop(value),
        async settle(value) {
          await liveNative.drainCurrentTurn(boundaryId);
          const settled = liveNative.driver.settlement();
          if (!settled) missing('native drain has no actual Provider settlement');
          const status = settled.state === 'succeeded' && acceptedEnd ? 'succeeded'
            : settled.state === 'stopped' || settled.state === 'cancelled' ? 'cancelled'
            : settled.state === 'failed' ? 'failed' : 'blocked';
          // This parent is the pure Provider controller, not an IO effect.
          // Its actual bound-end command and producer drain discharge that duty;
          // file effects retain their independent completion-owner receipts.
          const controllerResult = status === 'succeeded' ? {
            operationId: allocation.operationId, status: 'succeeded' as const,
            outputRef: currentTurnRef,
            outputDigest: `sha256:${createHash('sha256').update(canonicalJsonStringify(acceptedEnd)).digest('hex')}`,
            evidenceRefs: [...settled.evidenceRefs, ...acceptedEnd!.resolvedEvidenceRefs],
            verifier: { name: 'humanagent.standard-turn-controller', version: '1', decision: 'bound end accepted and actual producer drain completed' },
            completedAt: input.now().toISOString(),
          } : undefined;
          await publishLifecycle(status, status === 'succeeded' ? 'operation.completed'
            : status === 'cancelled' ? 'operation.cancelled' : status === 'failed' ? 'operation.failed' : 'operation.blocked', settled.evidenceRefs, controllerResult);
          const outcome = settled.state === 'succeeded' ? 'waiting' as const : settled.state;
          if (!allocation.scope.cycleId) missing('native checkpoint has no allocated cycle');
          if (!acceptedEnd) missing('the drained execution has no accepted standard-turn end; retain the same logical turn');
          const contextRef = loop.contextCommitRef();
          if (!contextRef) missing('canonical turn closure has no actual full-context commit');
          const facts = await owners!.readClosureFacts(contextRef);
          if (!facts) missing('canonical turn closure owner facts are unknown');
          closingInput ??= { summary: structuredClone(acceptedEnd.summary), reviewCommitRefs: acceptedReviewRefs,
            prepareCheckpointClosure: async (checkpoint) => {
              if (closingCheckpoint && canonicalJsonStringify(closingCheckpoint) !== canonicalJsonStringify(checkpoint)) {
                missing('native preparation changed the frozen closing candidate');
              }
              closingCheckpoint = structuredClone(checkpoint);
              return native.prepareTurnClosure(checkpoint, boundaryId);
            },
            outcome: facts.unresolvedOperationRefs.length > 0 ? 'unknown'
              : facts.permission.revoked || facts.hardBlockers.length > 0 ? 'blocked' : 'waiting', source: 'harness-control',
            permissionRevoked: facts.permission.revoked, hardBlockers: facts.hardBlockers,
            recovery: { contextRef: contextRef.commitId, unfinishedRef: admittedTurn.recoveryStateRef,
              unreturnedCallRefs: [...facts.unreturnedCallRefs], unresolvedOperationRefs: [...facts.unresolvedOperationRefs] } };
          await saveBoundary();
          return { state: outcome, evidenceRefs: settled.evidenceRefs };
        },
        close() {
          if (closed) return closed;
          const attempt = (async () => {
            try { await saveBoundary(); }
            catch (error) {
              try { await closeOwnedProvider(); }
              catch (cleanupError) { throw new AggregateError([error, cleanupError], 'native save and owned Provider close failed'); }
              throw error;
            }
            return closeOwnedProvider();
          })();
          closed = attempt;
          // A save persistence failure can resume its missing phases with the
          // retained intent. The actual Provider close remains a separate,
          // once-owned receipt and is never repeated by that retry.
          void attempt.then(() => {}, () => { if (closed === attempt) closed = undefined; });
          return attempt;
        },
      };
      return driver;
    } catch (error) {
      try { if (composition) await closeAgentProvider(composition); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'native preparation and owned Provider close failed'); }
      throw error;
    }
  }
  // The Runtime cold producer is the exact five-port binding; this annotation
  // keeps the App composition from drifting from `RuntimeColdExecutionProducer`.
  const coldProducer: RuntimeColdExecutionProducer = { readColdExecutionSource, admitSegment,
    readIncarnationBinding, recoverOriginalTurn, createResumedExecutionDriver };
  return { currentStateFacts, admitExecution, createExecutionDriver, ...coldProducer, grants, context, checkpoints,
    async admitNewBusiness(value: Parameters<import('./task-control.js').TaskControlAdmissionPort['admitNewBusiness']>[0]) {
      return (await owner(value.request.taskId)).admitNewBusiness(value);
    },
  };
}

/** One concrete parent lifecycle and one physical control journal for the service. */
export function createServiceExecutionAdmission(input: {
  readonly journal: JsonlOrganJournal;
  readonly preparedJournal: RuntimeTaskJournalPort;
  readonly principalOwner: string;
  readonly resourceBoundary: OperationTaskBoundaryPort;
  readonly now: () => Date;
}) {
  const grants = new JsonlTaskGrantJournal(input.journal);
  const admission = createExecutionAdmission({
    organJournal: input.journal, taskGrantPort: grants, principalOwner: input.principalOwner,
    capabilityFor: ({ intent }) => ({ actionId: TASK_EXECUTION_ACTION_ID,
      capabilities: [TASK_EXECUTION_CAPABILITY], scope: { organId: intent.requestedScope.organId, taskId: intent.taskId } }),
    resourceBoundary: input.resourceBoundary,
    resolveAdmittedInput: async (allocation) => readPreparedExecutionInput(input.preparedJournal, allocation),
    createGateway: (ports) => createToolExecutionGateway({ ...ports, now: input.now }),
  });

  async function admitExecution(allocation: RuntimeExecutionAllocation) {
    const prepared = readPreparedExecutionInput(input.preparedJournal, allocation);
    const inputDigest = executionAdmissionInputDigest(allocation, prepared);
    const inputRef = allocation.inputRefs[0];
    if (!inputRef || !allocation.scope.cycleId) missing('prepared execution has no canonical input or cycle');
    const intent: PreparedParentLifecycle['control']['intent'] = {
      operationId: allocation.operationId, taskId: allocation.taskId, cycleId: allocation.scope.cycleId,
      requestedBy: input.principalOwner, intentRevision: String(allocation.inputRevision), kind: 'run',
      toolName: parentRegistration.toolName, inputRef, inputDigest, requestedScope: allocation.scope,
      idempotencyKey: allocation.operationId.value,
      expectedOutput: { schemaRef: parentRegistration.outputContract, requiredEvidenceKinds: ['operation'] },
    };
    const route: PreparedParentLifecycle['control']['route'] = {
      operationId: allocation.operationId, routeId: parentRegistration.routeId,
      routeVersion: parentRegistration.routeVersion, mode: parentRegistration.mode,
      contractVersion: parentRegistration.contractVersion, effectiveScope: allocation.scope,
      selectionReason: 'persisted R1 parent Provider controller', selectedAt: input.now().toISOString(),
    };
    const parentLifecycle: PreparedParentLifecycle = {
      event: { eventId: `parent-admitted:${allocation.operationId.value}`, schemaVersion: 1,
        kind: 'operation.accepted', operationId: allocation.operationId, taskId: allocation.taskId,
        executionEpoch: 1, status: 'accepted', occurredAt: route.selectedAt, evidenceRefs: [] },
      control: { intent, registration: parentRegistration, route, status: 'accepted', executionEpoch: 1,
        namespaceKey: operationIdempotencyKey(intent),
        fingerprintKey: operationSemanticFingerprintKey(operationSemanticFingerprint(intent, parentRegistration)) },
    };
    return admission.admitExecution({ allocation, requestRef: `execution:${allocation.operationId.value}`,
      capability: { actionId: TASK_EXECUTION_ACTION_ID, capabilities: [TASK_EXECUTION_CAPABILITY],
        scope: { organId: allocation.scope.organId, taskId: allocation.taskId } },
      parentLifecycle });
  }

  return { ...admission, grants, admitExecution,
    preparedInput: (allocation: RuntimeExecutionAllocation) => readPreparedExecutionInput(input.preparedJournal, allocation),
    evidence(allocation: RuntimeExecutionAllocation, commitId: string) {
      return { evidenceId: id('evidence', `execution-${createHash('sha256').update(commitId).digest('hex')}`),
        kind: 'operation' as const, source: 'humanagent.execution-admission', locator: commitId, scope: allocation.scope };
    },
  };
}
